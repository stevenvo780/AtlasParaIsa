import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorld, stepWorld, TICKS_PER_DAY } from '../src/world/index.js';
import { HISTORICAL_PARAMS, parseParams } from '../src/world/params.js';
import { generateChunk } from '../src/world/terrain.js';
import { stepEcosystem } from '../src/world/ecosystem.js';
import { ruidoCuenca, enCuenca, regionesSinAgua } from '../src/world/agua.js';
import { distanciaMediaAguaManhattan } from './lib/agua.js';
import type { Tile } from '../src/shared/types.js';

function run(world: ReturnType<typeof createWorld>, ticks: number): void {
  for (let n = 0; n < ticks; n++) stepWorld(world);
}

// Detector de deriva del agua: hash del estado de agua (x, y, feature y drinkingWater a 6 decimales, no
// el mundo entero) de la semilla 4821 tras 1 día con `agua.cuencas=1` explícito sobre `HISTORICAL_PARAMS`.
// Con cuencas=1 el ruido nunca cruza el umbral y el generador no filtra agua; el hash cambia igualmente
// si cambia a dónde caminan y beben los habitantes. Se actualiza solo en el commit que cambie a
// propósito una ley del agua o del movimiento, citando su evidencia (el historial está en git log y
// en docs/REVISION-*). Los controles del generador y del agua aislada de abajo no dependen de él.
const HASH_AGUA_MUNDO_4821_DIA1_CUENCAS1 = 'ad4b5dd88eba765a3df24ccb96296ddfcc740312f4f4842f51c2ba25a4c5270b';

test('T035 control: agua.cuencas=1 EXPLÍCITO (no el default global) deja el agua/feature de las teselas bit a bit igual a hoy tras 1 día', () => {
  const world = createWorld(4821, parseParams('agua.cuencas=1', HISTORICAL_PARAMS));
  assert.equal(world.tiles.length > 0, true);
  run(world, TICKS_PER_DAY);
  const aguaTeselas = world.tiles.map(t => ({ x: t.x, y: t.y, feature: t.feature ?? 'none', drinkingWater: Number((t.drinkingWater ?? 0).toFixed(6)) }));
  const digest = createHash('sha256').update(JSON.stringify(aguaTeselas)).digest('hex');
  assert.equal(digest, HASH_AGUA_MUNDO_4821_DIA1_CUENCAS1);
});

test('T035: cuencas=1 conserva toda el agua potable de origen tesela a tesela (generateChunk)', () => {
  const seed = 4821;
  const sinGate = generateChunk(seed, 0, 0).tiles;
  const conCuencasUno = generateChunk(seed, 0, 0, 1).tiles;
  assert.deepEqual(conCuencasUno, sinGate);
});

test('T035 ronda de arreglo (hallazgo crítico #2 — cableado): `agua.cuencas` del MUNDO llega al camino real createWorld→activate, no se queda pegado al default global', () => {
  const seed = 4821;
  const abierto = createWorld(seed, parseParams('agua.cuencas=1'));
  const cerrado = createWorld(seed, parseParams('agua.cuencas=0.05'));
  assert.ok(abierto.tiles.length > 0 && cerrado.tiles.length > 0);

  // Si `activate()`/`projectTerrain()` ignorasen `paramsOf(world).agua.cuencas` (como antes de esta
  // ronda), ambos mundos serían idénticos tesela a tesela pase lo que pase con el parámetro: este
  // assert por sí solo detecta ese fallo de cableado (antes de la ronda, `assert.deepEqual` entre
  // los dos mundos PASABA con cualquier valor de `agua.cuencas`, ver hallazgo "el único test que
  // toca el camino real ya no puede fallar").
  assert.notDeepEqual(cerrado.tiles.map(t => t.drinkingWater), abierto.tiles.map(t => t.drinkingWater));

  // Monotonía por el camino real: una cuenca más restrictiva nunca puede DEJAR más agua que una más
  // permisiva en la misma coordenada (el gateo solo quita, nunca añade).
  const mapaAbierto = new Map(abierto.tiles.map(t => [`${t.x},${t.y}`, t.drinkingWater ?? 0]));
  for (const tile of cerrado.tiles) {
    const original = mapaAbierto.get(`${tile.x},${tile.y}`) ?? 0;
    assert.ok((tile.drinkingWater ?? 0) <= original + 1e-9, `drinkingWater no puede crecer en (${tile.x},${tile.y}) por el camino real`);
  }

  const sinAguaAbierto = regionesSinAgua(abierto.tiles);
  const sinAguaCerrado = regionesSinAgua(cerrado.tiles);
  assert.ok(sinAguaCerrado > sinAguaAbierto, `cuencas=0.05 debería dejar más regiones secas que cuencas=1 por el camino real (abierto=${sinAguaAbierto}, cerrado=${sinAguaCerrado})`);
});

test('T035: cuencas=0.4 deja ≥30% de regiones sin agua superficial y distancia media > 6 (mundo de 4 chunks)', () => {
  const seed = 4821;
  const chunks: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const cuencas = 0.4;

  const antes = chunks.flatMap(([cx, cy]) => generateChunk(seed, cx, cy).tiles);
  const despues = chunks.flatMap(([cx, cy]) => generateChunk(seed, cx, cy, cuencas).tiles);

  const sinAguaAntes = regionesSinAgua(antes);
  const sinAguaDespues = regionesSinAgua(despues);
  const distanciaAntes = distanciaMediaAguaManhattan(antes);
  const distanciaDespues = distanciaMediaAguaManhattan(despues);

  // El "antes" (evidencia SC-004 2026-09-19): 0% de regiones sin agua superficial y distancia ~3-4.
  assert.equal(sinAguaAntes, 0);
  assert.ok(distanciaAntes >= 0 && distanciaAntes < 6, `distancia "antes" esperada en [0,6), fue ${distanciaAntes}`);

  // El "después" (SC-004 parte 2 y 3): ≥30% de regiones sin agua superficial y distancia media > 6.
  assert.ok(sinAguaDespues >= 0.3, `regionesSinAgua esperado ≥0,30 con cuencas=0.4, fue ${sinAguaDespues}`);
  assert.ok(distanciaDespues > 6, `distanciaMediaAguaManhattan esperada > 6 con cuencas=0.4, fue ${distanciaDespues}`);

  // La gating nunca puede DEJAR más agua potable que la original (solo puede quitar, no añadir).
  const mapaAntes = new Map(antes.map(t => [`${t.x},${t.y}`, t.drinkingWater ?? 0]));
  for (const tile of despues) {
    const original = mapaAntes.get(`${tile.x},${tile.y}`) ?? 0;
    assert.ok((tile.drinkingWater ?? 0) <= original + 1e-9, `drinkingWater no puede crecer en (${tile.x},${tile.y})`);
  }
});

test('T035 ronda de arreglo (hallazgo crítico #1 — durabilidad): fuera de cuenca, la lluvia NO rellena el agua potable (antes se deshacía en el siguiente tick de lluvia)', () => {
  const seed = 4821, cuencas = 0.4;
  // Busca determinísticamente una coordenada dentro y otra fuera de la cuenca para esta semilla.
  let dentro: { x: number; y: number } | undefined, fuera: { x: number; y: number } | undefined;
  for (let x = 0; x < 200 && (!dentro || !fuera); x++) {
    for (let y = 0; y < 200 && (!dentro || !fuera); y++) {
      if (enCuenca(seed, x, y, cuencas)) dentro ??= { x, y }; else fuera ??= { x, y };
    }
  }
  assert.ok(dentro && fuera, 'el fixture necesita al menos una coordenada dentro y otra fuera de la cuenca');

  const manantial = (p: { x: number; y: number }): Tile => ({
    x: p.x, y: p.y, terrain: 'meadow', biome: 'grassland', feature: 'spring', moisture: 0.5,
    vegetation: 0.2, food: 0, drinkingWater: 0,
  });
  const tileDentro = manantial(dentro!), tileFuera = manantial(fuera!);

  // 50 pasos de kernel (500 ticks) con lluvia constante, gateados con la MISMA cuenca que generó
  // las teselas — igual que hace `stepWorld` con `world.seed`/`paramsOf(world).agua.cuencas`.
  for (let tick = 10; tick <= 500; tick += 10) {
    stepEcosystem([tileDentro], tick, 'rain', 'day', false, { seed, cuencas });
    stepEcosystem([tileFuera], tick, 'rain', 'day', false, { seed, cuencas });
  }

  assert.equal(tileFuera.drinkingWater, 0, `fuera de cuenca drinkingWater debería seguir en 0 tras 50 pasos de lluvia, fue ${tileFuera.drinkingWater}`);
  assert.ok((tileDentro.drinkingWater ?? 0) > 0, `dentro de cuenca drinkingWater debería recargarse con la lluvia (comportamiento sin cambios), fue ${tileDentro.drinkingWater}`);
});

test('T035 ronda de arreglo: sin pasar seed/cuencas a stepEcosystem, la recarga por lluvia es idéntica a la de siempre (control del kernel)', () => {
  const control: Tile = { x: 5, y: 5, terrain: 'meadow', biome: 'grassland', feature: 'spring', moisture: 0.5, vegetation: 0.2, food: 0, drinkingWater: 0 };
  for (let tick = 10; tick <= 100; tick += 10) stepEcosystem([control], tick, 'rain', 'day', false);
  // 10 pasos de kernel: 0.008*(0.4+0*0.6) + 0.002 - 0.00015 por paso = 0.00505 * 10 = 0.0505.
  assert.ok(Math.abs((control.drinkingWater ?? 0) - 0.0505) < 1e-9, `esperado 0,0505, fue ${control.drinkingWater}`);
});

test('T035: el mar (ocean, elevation < 0,37) no cambia con ninguna cuencas', () => {
  const seed = 4821;
  // Chunks lejos del highland de spawn, verificados con océano garantizado (elevation < 0,37).
  const conOceano = [...generateChunk(seed, 40, 0).tiles, ...generateChunk(seed, 20, -30).tiles];
  const oceanoAntes = conOceano.filter(t => t.biome === 'ocean');
  assert.ok(oceanoAntes.length > 0, 'el fixture debería incluir teselas de océano');
  const conGate = [
    ...generateChunk(seed, 40, 0, 0.05).tiles,
    ...generateChunk(seed, 20, -30, 0.05).tiles,
  ];
  for (const tile of conGate.filter(t => t.biome === 'ocean')) assert.equal(tile.drinkingWater, 0);
});

test('T035: humedad general (moisture) no cambia con cuencas < 1 (solo se gatea drinkingWater)', () => {
  const seed = 4821;
  const sinGate = generateChunk(seed, 0, 0).tiles;
  const conGate = generateChunk(seed, 0, 0, 0.4).tiles;
  for (let i = 0; i < sinGate.length; i++) assert.equal(conGate[i]!.moisture, sinGate[i]!.moisture);
});

test('T035: determinismo — dos generaciones independientes con la misma semilla y cuencas coinciden', () => {
  const seed = 51926, cuencas = 0.4;
  const mundoA = [generateChunk(seed, 2, -3, cuencas), generateChunk(seed, 3, -3, cuencas)];
  const mundoB = [generateChunk(seed, 2, -3, cuencas), generateChunk(seed, 3, -3, cuencas)];
  assert.deepEqual(mundoA, mundoB);
  // Semillas distintas no coinciden (el ruido de cuencas depende de la semilla, no solo de x,y).
  const otraSemilla = generateChunk(seed + 1, 2, -3, cuencas);
  assert.notDeepEqual(otraSemilla, mundoA[0]);
});

test('ruidoCuenca es determinista, puro y cae en [0,1)', () => {
  const valores = [ruidoCuenca(4821, 5, -7), ruidoCuenca(4821, 5, -7), ruidoCuenca(4821, 100, 100)];
  assert.equal(valores[0], valores[1]);
  for (const v of valores) { assert.ok(v >= 0 && v < 1, `ruidoCuenca fuera de [0,1): ${v}`); }
});

test('regionesSinAgua: 0 teselas ⇒ 0; todas con agua ⇒ 0; ninguna con agua ⇒ 1', () => {
  assert.equal(regionesSinAgua([]), 0);
  const conAgua: Tile[] = [{ x: 0, y: 0, terrain: 'meadow', moisture: 0.5, vegetation: 0.2, food: 0, drinkingWater: 0.5 }];
  assert.equal(regionesSinAgua(conAgua), 0);
  const sinAgua: Tile[] = [{ x: 0, y: 0, terrain: 'meadow', moisture: 0.5, vegetation: 0.2, food: 0, drinkingWater: 0 }];
  assert.equal(regionesSinAgua(sinAgua), 1);
});

test('T035 ronda de arreglo (hallazgo importante): regionesSinAgua ignora las regiones 100% océano (no cuenta como "seca" una región sin tierra)', () => {
  const soloOceano: Tile[] = Array.from({ length: 4 }, (_, i) => ({ x: i, y: 0, terrain: 'water', moisture: 1, vegetation: 0, food: 0, biome: 'ocean', drinkingWater: 0 }));
  assert.equal(regionesSinAgua(soloOceano), 0, 'una región sin ninguna tesela de tierra no debe contar como región seca (ni como húmeda)');

  const mixta: Tile[] = [
    ...soloOceano,
    // Región distinta (tamRegion=16 ⇒ x=20 cae en la región "1,0", no en la "0,0" del océano).
    { x: 20, y: 0, terrain: 'meadow', moisture: 0.5, vegetation: 0.2, food: 0, drinkingWater: 0 },
  ];
  // La región de océano puro sigue sin contar; la única región CON TIERRA está seca ⇒ 100%.
  assert.equal(regionesSinAgua(mixta), 1);
});

test('distanciaMediaAguaManhattan: sin ninguna tesela con agua potable, el centinela es -1 (no Infinity: serializa mal en JSON)', () => {
  const tiles: Tile[] = [
    { x: 0, y: 0, terrain: 'meadow', moisture: 0.5, vegetation: 0.2, food: 0, drinkingWater: 0 },
    { x: 5, y: 5, terrain: 'meadow', moisture: 0.5, vegetation: 0.2, food: 0, drinkingWater: 0 },
  ];
  assert.equal(distanciaMediaAguaManhattan(tiles), -1);
});
