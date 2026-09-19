import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { createWorld, ecology, stepWorld, TICKS_PER_DAY, type World } from '../src/world/index.js';
import { parseParams, type WorldParams } from '../src/world/params.js';
import { CHUNK_SIZE, generateChunk } from '../src/world/terrain.js';
import { distanciaMediaAgua, fraccionCeldasConComida, giniRecursosPorRegion, worldStatistics } from '../src/world/statistics.js';

const tile = (x: number, y: number, food: number, changes: Partial<Tile> = {}): Tile => ({ x, y, terrain: 'meadow', moisture: 0, vegetation: 0, food, ...changes });

/** Mapa amplio y diverso (25 chunks dispersos): el mundo cargado alrededor de una persona es
 * una meseta hospitalaria y no representa la desigualdad del terreno. */
function diverseTiles(seed: number): Tile[] {
  const tiles: Tile[] = [];
  for (let cx = -40; cx <= 40; cx += 20) for (let cy = -40; cy <= 40; cy += 20) tiles.push(...generateChunk(seed, cx, cy).tiles);
  return tiles;
}

/** Diez días de la ley real `ecology` sobre ese mapa, sin habitantes que cosechen ni fauna que paste.
 * Memorizado por escenario: cada corrida son 24 000 ticks sobre 6 400 celdas y varias pruebas comparan
 * contra el mismo control. */
const tenDayRuns = new Map<string, Tile[]>();
/** Capacidades previas a la recalibración ab4d9fb: la línea base «sin capacidad de carga». */
const SIN_CAPACIDAD = 'recursos.capacidadPastizal=1,recursos.capacidadOtros=1';
function tenDays(seed: number, spec = ''): Tile[] {
  const memo = tenDayRuns.get(`${seed}|${spec}`);
  if (memo) return memo;
  const world = createWorld(seed, spec ? parseParams(spec) : undefined);
  world.tiles = diverseTiles(seed); world.people = []; world.animals = [];
  for (let tick = 0; tick < 10 * TICKS_PER_DAY; tick++) { world.tick++; ecology(world); }
  tenDayRuns.set(`${seed}|${spec}`, world.tiles);
  return world.tiles;
}

const capacityOf = (tile: Tile, params: WorldParams): number => tile.biome === 'forest' ? params.recursos.capacidadBosque
  : tile.biome === 'grassland' ? params.recursos.capacidadPastizal : params.recursos.capacidadOtros;
const landOf = (tiles: readonly Tile[]): Tile[] => tiles.filter(tile => tile.terrain !== 'water');
const meanFood = (tiles: readonly Tile[]): number => { const land = landOf(tiles); return land.reduce((sum, tile) => sum + tile.food, 0) / land.length; };

/* ---------------------------------------------------------------------------------------------
 * Control: oráculo congelado de `ecology` copiado de la BASE 1619c6bc (antes de T013), con su propio
 * generador, su propio índice de vecinos y su propia fase, para que no comparta ni una línea con la
 * ley nueva. Comparar dos corridas del código actual no refutaría nada: pasaría igual aunque el
 * comportamiento por defecto hubiera cambiado. El bloque de eventos meteorológicos se omite porque no
 * toca celdas (`addEvent` no está exportado); el sorteo del tiempo sí se reproduce, así que un cambio
 * en la probabilidad de lluvia o en el generador también rompe este control.
 * ------------------------------------------------------------------------------------------- */
const frozenClamp = (n: number, max = 1): number => Math.max(0, Math.min(max, n));
const frozenRandom = (world: World): number => { world.rng = (Math.imul(world.rng, 1664525) + 1013904223) >>> 0; return world.rng / 4294967296; };
const frozenPhase = (tick: number): string => { const t = tick % 2400; return t < 300 ? 'dawn' : t < 1500 ? 'day' : t < 1800 ? 'dusk' : 'night'; };
let frozenIndex: { tiles: readonly Tile[]; map: Map<string, Tile> } | undefined;
function frozenTileAt(world: World, x: number, y: number): Tile | undefined {
  if (!frozenIndex || frozenIndex.tiles !== world.tiles) frozenIndex = { tiles: world.tiles, map: new Map(world.tiles.map(t => [`${t.x},${t.y}`, t])) };
  return frozenIndex.map.get(`${x},${y}`);
}
function frozenEcology(world: World): void {
  if (world.tick % 600 === 0) world.weather = frozenRandom(world) < 0.4 ? 'rain' : 'clear';
  if (world.tick % 10 !== 0) return;
  const phase = frozenPhase(world.tick);
  const light = phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4;
  for (const tile of world.tiles) {
    if (tile.terrain === 'water') continue;
    const nearWater = [[tile.x - 1, tile.y], [tile.x + 1, tile.y], [tile.x, tile.y - 1], [tile.x, tile.y + 1]]
      .some(([x, y]) => frozenTileAt(world, x!, y!)?.terrain === 'water');
    tile.moisture = frozenClamp(tile.moisture + (world.weather === 'rain' ? 0.012 : 0) + (nearWater ? 0.008 : 0) - 0.0015 - light * 0.001);
    const growth = light * tile.moisture * 0.007 * (1 - tile.vegetation);
    tile.vegetation = frozenClamp(tile.vegetation + growth - (tile.moisture < 0.15 ? 0.0015 : 0.0001));
    tile.food = frozenClamp(tile.food + light * tile.moisture * tile.vegetation * 0.006 * (1 - tile.food) - 0.0001);
  }
}

test('with default parameters the new law reproduces the frozen pre-T013 ecology bit for bit', () => {
  const seed = 51926, current = createWorld(seed), frozen = createWorld(seed);
  current.tiles = diverseTiles(seed); frozen.tiles = diverseTiles(seed);
  current.people = []; frozen.people = []; current.animals = []; frozen.animals = [];
  assert.deepStrictEqual(current.tiles, frozen.tiles);
  for (let tick = 0; tick < 2 * TICKS_PER_DAY; tick++) { current.tick++; frozen.tick++; ecology(current); frozenEcology(frozen); }
  assert.deepStrictEqual(current.tiles, frozen.tiles);
  assert.equal(current.weather, frozen.weather); assert.equal(current.rng, frozen.rng);
  // Y el oráculo sabe fallar: con capacidad finita las dos leyes divergen.
  const scarce = createWorld(seed, parseParams('recursos.capacidadOtros=0.2,recursos.capacidadPastizal=0.06'));
  scarce.tiles = diverseTiles(seed); scarce.people = []; scarce.animals = [];
  for (let tick = 0; tick < 2 * TICKS_PER_DAY; tick++) { scarce.tick++; ecology(scarce); }
  assert.notDeepStrictEqual(scarce.tiles, frozen.tiles);
});

test('implicit and explicit default resource parameters preserve the complete world bit for bit after two days', () => {
  // Complementa (no sustituye) al oráculo de arriba: allí se refuta la ley de `ecology`, aquí se
  // comprueba que leer los parámetros no desvía el mundo entero, kernel y personas incluidos.
  const implicit = createWorld(51926), explicit = createWorld(51926, parseParams(''));
  for (let tick = 0; tick < 2 * TICKS_PER_DAY; tick++) { stepWorld(implicit); stepWorld(explicit); }
  assert.deepStrictEqual(implicit, explicit);
});

/* Evidencia de T013 / hallazgo C6. MEDIDO el 2026-09-19 (semilla 51926, 6 400 celdas, 10 días):
 * control (defaults)           → fracción con food>0.1 = 1,000 · Gini regional = 0,004 · comida media 0,940
 *                                (el «recursos en todos lados» que denuncia C6).
 * escasez (K otros 0,2 · pastizal 0,06) → fracción = 0,603 · Gini = 0,526 · comida media 0,339.
 * La banda del brief (fracción entre 30 % y 70 % y Gini ≥ 0,35) se afirma aquí tal cual, pero con
 * `capacidadPastizal = 0.06` en vez del 0,5 que proponía el brief: con 0,5 la banda es
 * ARITMÉTICAMENTE INALCANZABLE, y eso se fija abajo en su propia prueba.
 * Sobre el mapa diverso, no sobre el mundo cargado: en la simulación completa (stepWorld, 10 días,
 * ~14 300 celdas alrededor de 31 personas) esos mismos parámetros dan fracción 0,901 y Gini 0,247
 * frente a 0,996 y 0,131 del control, porque el vecindario del spawn es una meseta hospitalaria con
 * poco pastizal. La ley muerde igual (comida media 0,662 frente a 0,782); lo que no representa es la
 * desigualdad del terreno, y por eso la evidencia se mide sobre 25 chunks dispersos. */
test('finite biome capacities leave between 30% and 70% of the land above the food threshold with regional inequality over 0.35', () => {
  const spec = 'recursos.capacidadOtros=0.2,recursos.capacidadPastizal=0.06,recursos.decaimientoFertilidad=0.001';
  // El control «sin capacidad» debe FIJAR las capacidades viejas (=1): desde la recalibración de
  // ab4d9fb `DEFAULT_PARAMS` ya trae pastizal 0,7 / otros 0,35, así que un control por defecto
  // ya no es una línea base «sin capacidad» y abriría su propia desigualdad (Constitución I).
  const params = parseParams(spec), finite = tenDays(51926, spec), control = tenDays(51926, SIN_CAPACIDAD);
  const overCapacity = landOf(finite).filter(tile => tile.food > capacityOf(tile, params) + 1e-9 || tile.vegetation > capacityOf(tile, params) + 1e-9);
  assert.equal(overCapacity.length, 0, `${overCapacity.length} celdas superaron su capacidad de carga`);
  const fraccion = fraccionCeldasConComida(finite), gini = giniRecursosPorRegion(finite);
  assert.ok(fraccion >= 0.3 && fraccion <= 0.7, `la fracción de celdas con comida debe quedar entre 30 % y 70 %: ${fraccion}`);
  assert.ok(gini >= 0.35, `el Gini regional de la comida debe llegar a 0,35: ${gini}`);
  // El control fija el síntoma que se corrige: sin capacidad, comida en todas partes y reparto plano.
  assert.equal(fraccionCeldasConComida(control), 1, 'el control satura todas las celdas de tierra (sintoma C6)');
  assert.ok(giniRecursosPorRegion(control) < 0.05, `sin capacidad el reparto es uniforme: Gini ${giniRecursosPorRegion(control)}`);
  assert.ok(meanFood(control) > 0.9, `sin capacidad la comida satura: media ${meanFood(control)}`);
  assert.ok(meanFood(finite) < meanFood(control) * 0.75, `la capacidad debe recortar la comida media: ${meanFood(finite)} frente a ${meanFood(control)}`);
});

test('the capacities proposed in the brief cannot reach that band, and the equilibrium says why', () => {
  /* Con `capacidadOtros=0.2, capacidadPastizal=0.5` NINGUNA celda puede bajar del umbral 0,1: el
   * equilibrio de la comida es food* = K · (1 − decaimientoComida / (light · moisture · veg · 0,006)),
   * que con K = 0,2 y decaimiento 1e-4 vale ≈ 0,157 > 0,1. Además `moisture` no depende del bioma y la
   * lluvia (40 % de las ventanas) la homogeneiza hacia ~0,64, así que la única desigualdad posible es
   * la de K. MEDIDO: fracción 1,000 · Gini 0,288. Si esta prueba falla, la humedad ya depende del bioma
   * o las capacidades por defecto cambiaron: revísese entonces la banda pedida en el brief. */
  const spec = 'recursos.capacidadOtros=0.2,recursos.capacidadPastizal=0.5,recursos.decaimientoFertilidad=0.001';
  const brief = tenDays(51926, spec), params = parseParams(spec);
  assert.equal(fraccionCeldasConComida(brief), 1, 'con K ≥ 0,13 en todos los biomas ninguna celda baja de 0,1');
  const gini = giniRecursosPorRegion(brief);
  assert.ok(gini > 0.15 && gini < 0.35, `la capacidad abre desigualdad pero no llega a 0,35 sin humedad por bioma: ${gini}`);
  assert.equal(landOf(brief).filter(tile => tile.food > capacityOf(tile, params) + 1e-9).length, 0);
  assert.ok(meanFood(brief) < meanFood(tenDays(51926, SIN_CAPACIDAD)) * 0.75);
});

test('resource statistics are pure and match hand-calculated examples', () => {
  const uniform = [tile(0, 0, 1), tile(16, 0, 1)];
  const concentrated = [tile(0, 0, 1), tile(16, 0, 0), tile(32, 0, 0), tile(48, 0, 0)];
  assert.equal(giniRecursosPorRegion(uniform), 0); assert.equal(giniRecursosPorRegion(concentrated), 0.75);
  assert.equal(giniRecursosPorRegion([]), 0); assert.equal(giniRecursosPorRegion([tile(0, 0, 0), tile(16, 0, 0)]), 0);
  const food = [tile(0, 0, 0.2), tile(1, 0, 0.1), tile(2, 0, 0.10001), tile(3, 0, 1, { terrain: 'water' })];
  assert.equal(fraccionCeldasConComida(food), 2 / 3);
  const grid: Tile[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) grid.push(tile(x, y, 0, x === 0 && y === 0 ? { terrain: 'water' } : {}));
  assert.equal(distanciaMediaAgua(grid), 18 / 8);
  assert.equal(distanciaMediaAgua([tile(0, 0, 0), tile(1, 0, 0)]), -1);
  assert.equal(distanciaMediaAgua([]), -1);
  // Celdas negativas y aisladas: el empaquetado entero de coordenadas no puede colisionar ni perder islas.
  assert.equal(distanciaMediaAgua([tile(-1, -1, 0, { terrain: 'water' }), tile(-1, -2, 0), tile(500, 500, 0)]), 1);
  assert.deepStrictEqual(uniform, [tile(0, 0, 1), tile(16, 0, 1)]);
});

/* Las tres estadísticas se recorren enteras en cada proyección, y el servidor proyecta una vez por
 * cliente y por mensaje de cámara dentro del mismo tick. Se cambiaron las claves de cadena por enteros
 * y el Gini O(n²) por la forma ordenada; estas dos pruebas fijan que la optimización no cambió ningún
 * número y que la caché caduca cuando debe. */
function giniStrings(tiles: readonly Tile[]): number {
  const totals = new Map<string, number>();
  for (const t of tiles) { const region = `${Math.floor(t.x / CHUNK_SIZE)},${Math.floor(t.y / CHUNK_SIZE)}`; totals.set(region, (totals.get(region) ?? 0) + t.food); }
  const values = [...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, total]) => total), n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  if (mean === 0) return 0;
  let difference = 0;
  for (const left of values) for (const right of values) difference += Math.abs(left - right);
  return difference / (2 * n * n * mean);
}
function distanceStrings(tiles: readonly Tile[]): number {
  const byPosition = new Map(tiles.map(t => [`${t.x},${t.y}`, t])), distances = new Map<string, number>();
  const queue: [number, number][] = [];
  for (const t of tiles) if (t.terrain === 'water' || (t.drinkingWater ?? 0) > 0) { distances.set(`${t.x},${t.y}`, 0); queue.push([t.x, t.y]); }
  if (queue.length === 0) return -1;
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head]!, distance = distances.get(`${x},${y}`)!;
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
      const position = `${x + dx},${y + dy}`;
      if (!byPosition.has(position) || distances.has(position)) continue;
      distances.set(position, distance + 1); queue.push([x + dx, y + dy]);
    }
  }
  let land = 0, total = 0;
  for (const t of tiles) if (t.terrain !== 'water') { const distance = distances.get(`${t.x},${t.y}`); if (distance !== undefined) { land++; total += distance; } }
  return land === 0 ? 0 : total / land;
}

test('integer keys and the sorted Gini give the same numbers as the string-keyed originals', () => {
  const tiles = diverseTiles(51926);
  assert.equal(distanciaMediaAgua(tiles), distanceStrings(tiles));
  assert.ok(Math.abs(giniRecursosPorRegion(tiles) - giniStrings(tiles)) < 1e-12);
  const evolved = tenDays(51926, 'recursos.capacidadOtros=0.2,recursos.capacidadPastizal=0.06,recursos.decaimientoFertilidad=0.001');
  assert.equal(distanciaMediaAgua(evolved), distanceStrings(evolved));
  assert.ok(Math.abs(giniRecursosPorRegion(evolved) - giniStrings(evolved)) < 1e-12);
});

test('resource statistics are computed once per tick and expire when the tick or the loaded cells change', () => {
  const world = createWorld(51926);
  const first = worldStatistics(world), second = worldStatistics(world);
  assert.equal(second.distanciaMediaAgua, first.distanciaMediaAgua);
  assert.equal(second.giniRecursosPorRegion, first.giniRecursosPorRegion);
  // Contrato explícito de la caché: dentro del mismo tick las celdas no cambian (solo `stepWorld` las
  // toca, y `stepWorld` avanza el tick), así que un cambio a mano no se ve hasta que el tick avanza.
  world.tiles.forEach(candidate => { if (candidate.terrain !== 'water') candidate.food = 0; });
  assert.equal(worldStatistics(world).fraccionCeldasConComida, first.fraccionCeldasConComida);
  world.tick++;
  assert.equal(worldStatistics(world).fraccionCeldasConComida, 0);
  // Y también caduca si cambian las celdas cargadas sin avanzar el tick (activar o retirar chunks).
  world.tiles = [...world.tiles, tile(9000, 9000, 1)];
  assert.ok(worldStatistics(world).fraccionCeldasConComida > 0);
});
