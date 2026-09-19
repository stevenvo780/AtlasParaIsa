import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorld, stepWorld, TICKS_PER_DAY } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { generateChunk } from '../src/world/terrain.js';
import { ruidoCuenca, regionesSinAgua, distanciaMediaAgua } from '../src/world/agua.js';
import type { Tile } from '../src/shared/types.js';

function run(world: ReturnType<typeof createWorld>, ticks: number): void {
  for (let n = 0; n < ticks; n++) stepWorld(world);
}

// Hash del JSON del mundo semilla 4821 tras 1 día (TICKS_PER_DAY) con los params por defecto
// (agua.cuencas=1), capturado comparando bit a bit contra `ecosystem.ts`/`terrain.ts` previos a
// T035 (sin gating): el diff de los dos JSON completos fue vacío. Cualquier cambio de este hash
// significa que `cuencas=1` dejó de ser un no-op.
const HASH_MUNDO_4821_DIA1_CUENCAS1 = '0a7e2e48df1950051842fe6d5c1a7b6e2f402d56e55a76ea5661a4de04338219';

test('T035 control: agua.cuencas=1 (default) deja el mundo semilla 4821 bit a bit igual a hoy tras 1 día', () => {
  const world = createWorld(4821);
  assert.equal(world.tiles.length > 0, true);
  run(world, TICKS_PER_DAY);
  const digest = createHash('sha256').update(JSON.stringify(world)).digest('hex');
  assert.equal(digest, HASH_MUNDO_4821_DIA1_CUENCAS1);
});

test('T035 control: agua.cuencas=1 explícito coincide con los params por defecto tras 1 día', () => {
  const explicito = createWorld(4821, parseParams('agua.cuencas=1'));
  const porDefecto = createWorld(4821);
  run(explicito, TICKS_PER_DAY);
  run(porDefecto, TICKS_PER_DAY);
  assert.deepEqual(explicito, porDefecto);
});

test('T035: cuencas=1 conserva toda el agua potable de origen tesela a tesela (generateChunk)', () => {
  const seed = 4821;
  const sinGate = generateChunk(seed, 0, 0).tiles;
  const conCuencasUno = generateChunk(seed, 0, 0, 1).tiles;
  assert.deepEqual(conCuencasUno, sinGate);
});

test('T035: cuencas=0.4 deja ≥30% de regiones sin agua superficial y distancia media > 6 (mundo de 4 chunks)', () => {
  const seed = 4821;
  const chunks: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const cuencas = 0.4;

  const antes = chunks.flatMap(([cx, cy]) => generateChunk(seed, cx, cy).tiles);
  const despues = chunks.flatMap(([cx, cy]) => generateChunk(seed, cx, cy, cuencas).tiles);

  const sinAguaAntes = regionesSinAgua(antes);
  const sinAguaDespues = regionesSinAgua(despues);
  const distanciaAntes = distanciaMediaAgua(antes);
  const distanciaDespues = distanciaMediaAgua(despues);

  // El "antes" (evidencia SC-004 2026-09-19): 0% de regiones sin agua superficial y distancia ~3-4.
  assert.equal(sinAguaAntes, 0);
  assert.ok(distanciaAntes < 6, `distancia "antes" esperada < 6, fue ${distanciaAntes}`);

  // El "después" (SC-004 parte 2 y 3): ≥30% de regiones sin agua superficial y distancia media > 6.
  assert.ok(sinAguaDespues >= 0.3, `regionesSinAgua esperado ≥0,30 con cuencas=0.4, fue ${sinAguaDespues}`);
  assert.ok(distanciaDespues > 6, `distanciaMediaAgua esperada > 6 con cuencas=0.4, fue ${distanciaDespues}`);

  // La gating nunca puede DEJAR más agua potable que la original (solo puede quitar, no añadir).
  const mapaAntes = new Map(antes.map(t => [`${t.x},${t.y}`, t.drinkingWater ?? 0]));
  for (const tile of despues) {
    const original = mapaAntes.get(`${tile.x},${tile.y}`) ?? 0;
    assert.ok((tile.drinkingWater ?? 0) <= original + 1e-9, `drinkingWater no puede crecer en (${tile.x},${tile.y})`);
  }
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

test('distanciaMediaAgua: sin ninguna tesela con agua potable, la distancia es Infinity', () => {
  const tiles: Tile[] = [
    { x: 0, y: 0, terrain: 'meadow', moisture: 0.5, vegetation: 0.2, food: 0, drinkingWater: 0 },
    { x: 5, y: 5, terrain: 'meadow', moisture: 0.5, vegetation: 0.2, food: 0, drinkingWater: 0 },
  ];
  assert.equal(distanciaMediaAgua(tiles), Infinity);
});
