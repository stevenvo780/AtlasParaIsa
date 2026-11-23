import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import type { Tile } from '../src/shared/types.js';
import { bindWorldContext, createWorld, stepWorld, worldContext, type World } from '../src/world/index.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import { lecturaResidente, regionesSinAgua } from '../src/world/agua.js';
import { distanciaMediaAgua, fraccionCeldasConComida, giniRecursosPorRegion, worldStatistics } from '../src/world/statistics.js';
import { activate } from '../src/world/spatial.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { residentFastAccess, residentTileReader, TileStore } from '../src/world/soa/terreno.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';

/**
 * V18 ola 2 (carril C): `statistics.ts` y `agua.ts` leen los arrays SoA residentes (`residentFastAccess`)
 * en vez de disparar, por tesela y campo, el accesor de `terreno.ts` (>1,1 M de llamadas en un mundo de
 * 278 016 teselas), y el BFS de `distanciaMediaAgua` recorre chunks de 16 × 16 sin `Map` de teselas.
 *
 * Cota de equivalencia (0 ULP, `Object.is`): cada métrica sobre el mundo residente (`ResidentTopologyOwner`
 * + `TileStore`) coincide bit a bit con la misma métrica sobre una copia en objetos `Tile` planos, que
 * sigue por el camino histórico (sin `fast`).
 */
after(async () => { await closeEcosystemWorkers(); });

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TERRAINS = ['water', 'soil', 'meadow', 'shelter'] as const;
const BIOMES = ['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'] as const;
const FEATURES = ['tree', 'pine', 'palm', 'cactus', 'reeds', 'berries', 'flowers', 'rock', 'clay', 'stump', 'spring', 'pool', 'none'] as const;

interface Opciones { agua?: number; mar?: number; sinComida?: number; sinAgua?: number; sinTerreno?: number }
/** Chunks completos de 256 teselas en orden fila-mayor, con huecos de agua, agua potable dispersa y campos ausentes. */
function chunksSinteticos(seed: number, chunks: readonly (readonly [number, number])[], o: Opciones = {}): Tile[] {
  const rand = rng(seed), tiles: Tile[] = [];
  const { agua = 0.04, mar = 0.3, sinComida = 0, sinAgua = 0.15, sinTerreno = 0 } = o;
  for (const [cx, cy] of chunks) {
    const oceano = rand() < mar;
    for (let s = 0; s < 256; s++) {
      const x = cx * 16 + (s & 15), y = cy * 16 + (s >> 4);
      const water = oceano ? rand() < 0.97 : rand() < 0.08;
      const tile: Tile = {
        x, y, terrain: water ? 'water' : TERRAINS[1 + Math.floor(rand() * 3)]!, moisture: rand(), vegetation: rand(),
        food: rand() < sinComida ? undefined as unknown as number : rand() < 0.3 ? 0 : rand(),
        biome: water ? 'ocean' : BIOMES[Math.floor(rand() * 5)]!, feature: FEATURES[Math.floor(rand() * FEATURES.length)]!,
        growth: rand(), cultivation: rand() < 0.1 ? 0.5 : 0, traffic: rand() < 0.1 ? 0.5 : 0,
      } as Tile;
      if (rand() < sinTerreno) { delete (tile as Partial<Tile>).terrain; delete (tile as Partial<Tile>).biome; }
      const r = rand();
      if (r < agua) tile.drinkingWater = rand() * 0.9 + 0.05;
      else if (r < agua + sinAgua) tile.drinkingWater = 0;
      else if (r < agua + sinAgua + 0.05) tile.drinkingWater = undefined;
      tiles.push(tile);
    }
  }
  return tiles;
}
/** Chunks repartidos por una rejilla ancha con huecos (mundo real disperso: islas, océano entre medias). */
function chunksDispersos(seed: number, cantidad: number, ancho: number, desdeX = 0, desdeY = 0): [number, number][] {
  const rand = rng(seed), usados = new Set<number>(), out: [number, number][] = [];
  while (out.length < cantidad) {
    // Racimos: cada chunk cae cerca de otro ya elegido (islas conectadas) o en un punto libre nuevo.
    let cx: number, cy: number;
    if (out.length > 0 && rand() < 0.85) {
      const [px, py] = out[Math.floor(rand() * out.length)]!;
      cx = px + Math.floor(rand() * 3) - 1; cy = py + Math.floor(rand() * 3) - 1;
    } else { cx = desdeX + Math.floor(rand() * ancho); cy = desdeY + Math.floor(rand() * ancho); }
    const key = cx * 100_003 + cy;
    if (usados.has(key)) continue;
    usados.add(key); out.push([cx, cy]);
  }
  return out;
}
const planas = (tiles: readonly Tile[]): Tile[] => tiles.map(t => ({ ...t }));
interface Residente { tiles: Tile[]; store: TileStore; owner: ResidentTopologyOwner }
/** Mundo residente: teselas bajo `ResidentTopologyOwner` ligadas a un `TileStore` (lo que deja `stepWorld` con `soaTerreno`). */
function residente(source: readonly Tile[]): Residente {
  const owner = new ResidentTopologyOwner(), store = new TileStore();
  const tiles = owner.tiles(source.map(t => owner.tile({ ...t })));
  store.prepareParallel(tiles);
  return { tiles, store, owner };
}
const same = (a: number, b: number, label: string): void => assert.ok(Object.is(a, b), `${label}: ${a} ≠ ${b}`);
function metricas(tiles: Tile[], tamRegion = 16): number[] {
  return [giniRecursosPorRegion(tiles), fraccionCeldasConComida(tiles), fraccionCeldasConComida(tiles, 0.5), distanciaMediaAgua(tiles), regionesSinAgua(tiles, tamRegion)];
}
const NOMBRES = ['gini', 'fraccion(0.1)', 'fraccion(0.5)', 'distanciaAgua', 'regionesSinAgua'];
function paridad(tiles: Tile[], flat: Tile[], etiqueta: string, tamRegion = 16): void {
  const a = metricas(tiles, tamRegion), b = metricas(flat, tamRegion);
  for (let i = 0; i < a.length; i++) same(a[i]!, b[i]!, `${etiqueta} ${NOMBRES[i]}`);
}

test('el mundo residente expone la vía rápida (precondición de las demás pruebas)', t => {
  const res = residente(chunksSinteticos(1, [[0, 0], [-3, 2]]));
  try {
    assert.ok(residentFastAccess(res.tiles), 'fast disponible');
    assert.ok(residentTileReader(res.tiles), 'exact disponible');
    assert.equal(residentFastAccess(planas(res.tiles)), undefined, 'plano: sin vía rápida');
  } finally { res.store.releaseParallelObjects(); }
  t.diagnostic('ok');
});

test('paridad 0 ULP: chunks dispersos, huecos oceánicos, coordenadas negativas, varias semillas y tamRegion', () => {
  for (const seed of [3, 17, 51926, 90210]) {
    const fuente = chunksSinteticos(seed, ([...chunksDispersos(seed, 60, 40, -20, -20), [-1, -1], [0, 0], [-1, 0], [0, -1]] as [number, number][])
      .filter((c, i, all) => all.findIndex(d => d[0] === c[0] && d[1] === c[1]) === i), { sinComida: seed === 17 ? 0.01 : 0 });
    const res = residente(fuente);
    try {
      const lectura = lecturaResidente(res.tiles);
      assert.ok(lectura?.completa && lectura.chunkX, 'vía de chunks + celdas exactas');
      assert.equal(lectura.chunkX.length, fuente.length / 256);
      const flat = planas(fuente);
      for (const tam of [16, 32, 8, 5, 100, 1, 16.5]) paridad(res.tiles, flat, `semilla ${seed} tam ${tam}`, tam);
    } finally { res.store.releaseParallelObjects(); }
  }
});

test('paridad 0 ULP: sin agua potable, sin tierra, sin comida y campos de terreno ausentes', () => {
  const casos: [string, Tile[]][] = [
    ['sin fuente de agua', chunksSinteticos(5, [[0, 0], [1, 0], [0, 1]], { agua: 0, sinAgua: 1 })],
    ['todo océano', chunksSinteticos(6, [[0, 0], [5, 5]], { mar: 1 }).map(t => ({ ...t, terrain: 'water' as const, drinkingWater: undefined }))],
    ['sin comida', chunksSinteticos(7, [[0, 0], [1, 1]]).map(t => ({ ...t, food: 0 }))],
    ['comida ausente', chunksSinteticos(8, [[0, 0], [2, 0]], { sinComida: 0.3 })],
    ['terreno/bioma ausentes', chunksSinteticos(9, [[0, 0], [-2, -2]], { sinTerreno: 0.4 })],
    ['una sola fuente', chunksSinteticos(10, [[0, 0], [0, 1]], { agua: 0, sinAgua: 0 }).map((t, i) => ({ ...t, drinkingWater: i === 300 ? 1 : 0 }))],
  ];
  for (const [nombre, fuente] of casos) {
    const res = residente(fuente);
    try { paridad(res.tiles, planas(fuente), nombre); } finally { res.store.releaseParallelObjects(); }
  }
});

test('paridad 0 ULP: teselas no ligadas, array fuera de chunks y coordenadas lejanas (fail-closed)', () => {
  const fuente = chunksSinteticos(11, [[0, 0], [1, 0], [0, 1], [-1, -1]]);
  // 1) Tesela suelta añadida tras ligar: fast sigue, exact no, la tesela cae a lectura por objeto.
  {
    const res = residente(fuente), extra: Tile = { x: 300, y: 300, terrain: 'meadow', food: 0.9, drinkingWater: 0.7, biome: 'forest' } as Tile;
    try {
      res.tiles.push(res.owner.tile(extra));
      assert.ok(residentFastAccess(res.tiles), 'fast sobrevive a una alta');
      assert.equal(residentTileReader(res.tiles), undefined, 'exact se revoca');
      const lectura = lecturaResidente(res.tiles);
      assert.ok(lectura && !lectura.completa && !lectura.chunkX, 'sin disposición por chunks y con una tesela sin ligar');
      paridad(res.tiles, planas(res.tiles), 'tesela suelta');
    } finally { res.store.releaseParallelObjects(); }
  }
  // 2) Chunk completo añadido tras ligar (sigue siendo disposición por chunks, pero sin ligar).
  {
    const res = residente(fuente), nuevo = chunksSinteticos(12, [[2, 2]]).map(t => res.tiles.push(res.owner.tile(t)));
    try {
      assert.equal(nuevo.length, 256);
      assert.ok(residentFastAccess(res.tiles));
      const lectura = lecturaResidente(res.tiles);
      assert.ok(lectura && !lectura.completa && lectura.chunkX, 'chunks completos pero un chunk sin ligar: celdas por tesela, BFS por chunks');
      paridad(res.tiles, planas(res.tiles), 'chunk nuevo sin ligar');
    } finally { res.store.releaseParallelObjects(); }
  }
  // 3) Coordenadas lejanas: dentro de la cota (BFS por chunks) y más allá (camino genérico por posición).
  for (const [cota, esperaChunks] of [[450_000, true], [600_000, false]] as const) {
    const lejos = chunksSinteticos(13, [[-cota, -cota], [-cota + 1, -cota], [cota, cota - 100_000], [0, 0], [-1, -1]]);
    const res = residente(lejos);
    try {
      assert.equal(lecturaResidente(res.tiles)?.chunkX !== undefined, esperaChunks, `cota ${cota}`);
      paridad(res.tiles, planas(lejos), `coordenadas lejanas ${cota}`);
    } finally { res.store.releaseParallelObjects(); }
  }
  // 4) Mutación posterior por el setter residente (la vía rápida lee el mismo SAB).
  {
    const res = residente(fuente);
    try {
      for (let i = 0; i < res.tiles.length; i += 37) { res.tiles[i]!.food = 0.5; res.tiles[i]!.drinkingWater = i % 2 ? 0.2 : 0; res.tiles[i]!.terrain = i % 3 ? 'soil' : 'water'; }
      // Tras escribir por setters el owner puede revocar la vía rápida: en ambos casos el resultado es el mismo.
      paridad(res.tiles, planas(res.tiles), 'tras mutar por setters');
    } finally { res.store.releaseParallelObjects(); }
  }
});

test('plano: NaN, undefined y 0 en drinkingWater dan el mismo resultado (camino histórico intacto)', () => {
  const base = chunksSinteticos(14, [[0, 0], [1, 0]], { agua: 0, sinAgua: 1 });
  const hay = (v: number | undefined): Tile[] => base.map((t, i) => ({ ...t, drinkingWater: i === 40 || i === 300 ? 0.4 : v }));
  const ref = metricas(hay(undefined));
  for (const v of [0, NaN, undefined]) metricas(hay(v)).forEach((x, i) => same(x, ref[i]!, `drinkingWater=${String(v)} ${NOMBRES[i]}`));
});

function mundoConChunks(seed: number, extra: readonly (readonly [number, number])[]): World {
  const world = createWorld(seed), ctx = worldContext(world);
  for (const [cx, cy] of extra) activate(world, cx * 16, cy * 16, ctx);
  return world;
}
test('worldStatistics: paridad 0 ULP residente vs plano sobre un mundo real con chunks dispersos', () => {
  const world = mundoConChunks(51926, [...chunksDispersos(77, 25, 30, -15, -15)]);
  const flat = planas(world.tiles);
  const owner = new ResidentTopologyOwner(), store = new TileStore();
  const tiles = owner.tiles(world.tiles.map(t => owner.tile({ ...t })));
  store.prepareParallel(tiles);
  try {
    const plano: World = { ...world, tiles: flat }, resid: World = { ...world, tiles };
    assert.ok(lecturaResidente(resid.tiles)?.completa, 'lectura completa por celdas exactas');
    const a = worldStatistics(resid), b = worldStatistics(plano);
    // `history`, `people` etc. son idénticos por construcción; se comparan todas las cifras bit a bit.
    const claves = Object.keys(b) as (keyof typeof b)[];
    for (const key of claves) assert.deepStrictEqual(a[key], b[key], `worldStatistics.${String(key)}`);
    for (const key of ['freshWater', 'giniRecursosPorRegion', 'fraccionCeldasConComida', 'distanciaMediaAgua', 'regionesSinAgua', 'cultivatedTiles', 'trailTiles'] as const)
      same(a[key] as number, b[key] as number, `worldStatistics.${key}`);
    assert.deepEqual(Object.keys(a.biomes), Object.keys(b.biomes), 'orden de claves de biomas');
    assert.deepEqual(Object.keys(a.features), Object.keys(b.features), 'orden de claves de rasgos');
  } finally { store.releaseParallelObjects(); }
});

test('worldStatistics tras stepWorld con motor.soaTerreno + ResidentTopologyOwner: residente vs plano 0 ULP', () => {
  const params = parseParams({ motor: { ...DEFAULT_PARAMS.motor, hilos: 2, soaTerreno: true, particionarPersonas: false } });
  for (const seed of [51926, 7]) {
    const world = createWorld(seed, params), owner = new ResidentTopologyOwner();
    world.tiles = owner.tiles(world.tiles.map(t => owner.tile(t)));
    bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
    for (const [cx, cy] of chunksDispersos(seed, 12, 16, -8, -8)) activate(world, cx * 16, cy * 16, worldContext(world));
    for (let n = 0; n < 12; n++) stepWorld(world);
    const lectura = lecturaResidente(world.tiles);
    assert.ok(lectura, `semilla ${seed}: stepWorld deja el mundo ligado al TileStore`);
    const flat = planas(world.tiles);
    paridad(world.tiles, flat, `mundo real semilla ${seed}`);
    const a = worldStatistics(world), b = worldStatistics({ ...world, tiles: flat });
    assert.deepStrictEqual(a.biomes, b.biomes); assert.deepEqual(Object.keys(a.biomes), Object.keys(b.biomes));
    assert.deepStrictEqual(a.features, b.features);
    for (const key of ['freshWater', 'giniRecursosPorRegion', 'fraccionCeldasConComida', 'distanciaMediaAgua', 'regionesSinAgua', 'cultivatedTiles', 'trailTiles'] as const)
      same(a[key], b[key], `seed ${seed} worldStatistics.${key}`);
  }
});

function mejor(repeticiones: number, run: () => void): number {
  let min = Infinity;
  for (let i = 0; i < repeticiones; i++) { const t0 = performance.now(); run(); min = Math.min(min, performance.now() - t0); }
  return min;
}
test('benchmark: 278 016 teselas (1 086 chunks dispersos) residente vs plano', (t: TestContext) => {
  const chunks = chunksDispersos(2026, 1086, 120, -60, -60);
  assert.equal(chunks.length, 1086);
  const fuente = chunksSinteticos(2026, chunks, { agua: 0.002, sinAgua: 0.2 });
  assert.equal(fuente.length, 278_016);
  const res = residente(fuente), flat = planas(fuente);
  try {
    assert.ok(residentFastAccess(res.tiles) && residentTileReader(res.tiles));
    paridad(res.tiles, flat, 'benchmark');
    const casos: [string, (tiles: Tile[]) => unknown][] = [
      ['distanciaMediaAgua', ts => distanciaMediaAgua(ts)], ['giniRecursosPorRegion', ts => giniRecursosPorRegion(ts)],
      ['fraccionCeldasConComida', ts => fraccionCeldasConComida(ts)], ['regionesSinAgua', ts => regionesSinAgua(ts)],
    ];
    let totalRes = 0, totalFlat = 0;
    for (const [nombre, fn] of casos) {
      const r = mejor(5, () => fn(res.tiles)), f = mejor(5, () => fn(flat));
      totalRes += r; totalFlat += f;
      t.diagnostic(`${nombre}: residente ${r.toFixed(1)} ms · plano ${f.toFixed(1)} ms`);
    }
    // worldStatistics: mundo mínimo con las teselas del benchmark (la memoria por (mundo, paso) se salta con un mundo nuevo cada vez).
    const world = createWorld(51926);
    const wr = mejor(3, () => worldStatistics({ ...world, tiles: res.tiles })), wf = mejor(3, () => worldStatistics({ ...world, tiles: flat }));
    t.diagnostic(`worldStatistics (4 caras + censo): residente ${wr.toFixed(1)} ms · plano ${wf.toFixed(1)} ms`);
    t.diagnostic(`suma de las 4 métricas: residente ${totalRes.toFixed(1)} ms · plano ${totalFlat.toFixed(1)} ms`);
  } finally { res.store.releaseParallelObjects(); }
});
