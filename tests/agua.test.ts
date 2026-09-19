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

// Hash del JSON del mundo semilla 4821 tras 1 día (TICKS_PER_DAY) con los params PREVIOS a la
// calibración de ab4d9fb (agua.cuencas=1 y el resto de defaults viejos), capturado comparando bit
// a bit contra `ecosystem.ts`/`terrain.ts` previos a T035 (sin gating): el diff de los dos JSON
// completos fue vacío. Cualquier cambio de este hash significa que `cuencas=1` dejó de ser un no-op.
// Constitución I: un control «bit a bit igual a hoy» fija los params explícitamente y NO depende de
// `DEFAULT_PARAMS`, que hoy trae los valores calibrados (riesgo 0,04 / pendiente 10 / maxima 40 /
// nacimientos 2 / varianza 0,15 / pastizal 0,7 / otros 0,35 / fertilidad 0,001 / cuencas 0,4).
const PARAMS_PREVIOS_A_LA_CALIBRACION = [
  'cuerpo.riesgoSenescenciaDiario=0.02', 'cuerpo.riesgoSenescenciaPendiente=6',
  'genes.varianzaFundadores=0', 'poblacion.maxima=32', 'poblacion.nacimientosPorComprobacion=1',
  'recursos.capacidadPastizal=1', 'recursos.capacidadOtros=1', 'recursos.decaimientoFertilidad=0',
  'agua.cuencas=1',
].join(',');
const HASH_MUNDO_4821_DIA1_CUENCAS1 = '0a7e2e48df1950051842fe6d5c1a7b6e2f402d56e55a76ea5661a4de04338219';

test('T035 control: agua.cuencas=1 deja el mundo semilla 4821 bit a bit igual a hoy tras 1 día', () => {
  const world = createWorld(4821, parseParams(PARAMS_PREVIOS_A_LA_CALIBRACION));
  assert.equal(world.tiles.length > 0, true);
  run(world, TICKS_PER_DAY);
  const digest = createHash('sha256').update(JSON.stringify(world)).digest('hex');
  assert.equal(digest, HASH_MUNDO_4821_DIA1_CUENCAS1);
});

test('T035: los params del mundo (no DEFAULT_PARAMS) rigen la generación: cuencas=1 deja más agua que el default 0,4', () => {
  // Guarda de regresión: `activate`/`viewWorld` (spatial.ts) y la migración (index.ts) llamaban a
  // `generateChunk`/`initializeEcosystem` SIN pasar `agua.cuencas`, así que todo mundo se generaba
  // con el default pase lo que pase en sus params. Con la propagación arreglada, cuencas=1 y el
  // default 0,4 producen mundos distintos y el de cuencas=1 nunca tiene menos agua potable.
  const conTodaElAgua = createWorld(4821, parseParams('agua.cuencas=1'));
  const porDefecto = createWorld(4821);
  const potable = (mundo: ReturnType<typeof createWorld>): number =>
    mundo.tiles.reduce((total, tile) => total + ((tile.drinkingWater ?? 0) > 0 ? 1 : 0), 0);
  assert.ok(potable(conTodaElAgua) > potable(porDefecto),
    `cuencas=1 debe conservar más teselas con agua potable que el default: ${potable(conTodaElAgua)} vs ${potable(porDefecto)}`);
  const aguaPorDefecto = new Map(porDefecto.tiles.map(t => [`${t.x},${t.y}`, t.drinkingWater ?? 0]));
  for (const tile of conTodaElAgua.tiles)
    assert.ok((tile.drinkingWater ?? 0) >= (aguaPorDefecto.get(`${tile.x},${tile.y}`) ?? 0) - 1e-9,
      `la gating solo puede quitar agua, nunca añadirla (${tile.x},${tile.y})`);
});

test('T035: cuencas=1 conserva toda el agua potable de origen tesela a tesela (generateChunk)', () => {
  const seed = 4821;
  // «Origen» = el agua que la tesela recibiría sin gating. Con cuencas=1 el umbral es inalcanzable
  // (`ruidoCuenca` ∈ [0,1)), así que NINGUNA tesela con rasgo potable puede quedar seca, y cualquier
  // cuencas < 1 solo puede ser un subconjunto de esa agua.
  const conCuencasUno = generateChunk(seed, 0, 0, 1).tiles;
  const POTABLES = new Set(['spring', 'pool', 'wetland']);
  const conRasgoPotable = conCuencasUno.filter(t => t.biome !== 'ocean' && (t.terrain === 'water' || POTABLES.has(String(t.feature))));
  assert.ok(conRasgoPotable.length > 0, 'el fixture debería incluir teselas con agua de origen');
  for (const tile of conRasgoPotable)
    assert.ok((tile.drinkingWater ?? 0) > 0, `cuencas=1 no puede secar la tesela de origen (${tile.x},${tile.y}) [${tile.feature ?? tile.terrain}]`);
  const gateado = generateChunk(seed, 0, 0, 0.4).tiles;
  const aguaConUno = new Map(conCuencasUno.map(t => [`${t.x},${t.y}`, t.drinkingWater ?? 0]));
  for (const tile of gateado)
    assert.ok((tile.drinkingWater ?? 0) <= (aguaConUno.get(`${tile.x},${tile.y}`) ?? 0) + 1e-9,
      `cuencas<1 no puede tener más agua que cuencas=1 en (${tile.x},${tile.y})`);
  // El resto de campos (relieve, bioma, humedad, vegetación…) no depende de la cuenca.
  const sinAgua = (t: (typeof gateado)[number]): unknown => { const { drinkingWater: _d, ...rest } = t; return rest; };
  assert.deepEqual(gateado.map(sinAgua), conCuencasUno.map(sinAgua));
});

test('T035: cuencas=0.4 deja ≥30% de regiones sin agua superficial y distancia media > 6 (mundo de 4 chunks)', () => {
  const seed = 4821;
  const chunks: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const cuencas = 0.4;

  // El «antes» es el mundo SIN gating: cuencas=1 explícito (no el default, que hoy ya es 0,4).
  const antes = chunks.flatMap(([cx, cy]) => generateChunk(seed, cx, cy, 1).tiles);
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
  const sinGate = generateChunk(seed, 0, 0, 1).tiles;
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
