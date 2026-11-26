import { especieVisual } from './animals.js';
import type { Tile, WorldStats, WorldSample } from '../shared/types.js';
import type { World } from './index.js';
import { CHUNK_SIZE, MAX_COORDINATE } from './terrain.js';
import { indiceDiversidad } from './diversidad.js';
import { lecturaResidente, regionesSinAgua as regionesSinAguaDe, type LecturaResidente } from './agua.js';
import { demographicTraits } from './demography.js';
import { paramsOf } from './params.js';

export interface WorldStatsRecursos extends WorldStats { giniRecursosPorRegion: number; fraccionCeldasConComida: number; distanciaMediaAgua: number;
  /** R1 (SC-004 parte 2, T035/T036e): cableada desde `agua.ts` (misma función que usan los tests
   * de `agua.test.ts`) en vez de quedar sin consumidor. */
  regionesSinAgua: number;
  /** Paso en el que se calcularon las métricas caras (gini, comida, agua, diversidad).
   * Las demás cifras son siempre del paso actual; estas se refrescan con cadencia. */
  statsTick: number }

/** T041: las métricas de recursos recorren TODAS las teselas (y `distanciaMediaAgua` hace
 * una BFS completa). Con 12 clientes costaban ~444 ms por paso porque `projectWorld` las
 * recalculaba por cliente y por tick. Se refrescan cada 200 pasos (~20 s a 10 Hz) y entre
 * medias se reutiliza el último valor, marcado en la vista con `statsTick`. */
export const ESTADISTICAS_CARAS_CADA_TICKS = 200;
type EstadisticasCaras = { statsTick: number; giniRecursosPorRegion: number; fraccionCeldasConComida: number; distanciaMediaAgua: number; regionesSinAgua: number; diversidad: { conducta: number; oficios: number; total: number } };
/** Cachés laterales (nunca viajan en la instantánea ni entran en `assertWorld`). */
const carasPorMundo = new WeakMap<World, EstadisticasCaras>();
const vistaPorMundo = new WeakMap<World, { tick: number; value: WorldStatsRecursos }>();
/** `cloneWorld` crea un objeto nuevo cada paso: sin esto la cadencia no sobreviviría al clon. */
export function heredarEstadisticas(draft: World, source: World): void {
  const caras = carasPorMundo.get(source);
  if (caras) carasPorMundo.set(draft, caras);
}
function estadisticasCaras(world: World, lectura: LecturaResidente | undefined): EstadisticasCaras {
  const previa = carasPorMundo.get(world);
  // Un mundo que retrocede (recuperación) o que ya cumplió la cadencia recalcula.
  if (previa && world.tick >= previa.statsTick && world.tick - previa.statsTick < ESTADISTICAS_CARAS_CADA_TICKS) return previa;
  const caras: EstadisticasCaras = { statsTick: world.tick,
    giniRecursosPorRegion: giniRecursosPorRegion(world.tiles, lectura), fraccionCeldasConComida: fraccionCeldasConComida(world.tiles, 0.1, lectura),
    distanciaMediaAgua: distanciaMediaAgua(world.tiles, lectura), regionesSinAgua: regionesSinAguaDe(world.tiles, 16, lectura),
    diversidad: indiceDiversidad(world) };
  carasPorMundo.set(world, caras);
  return caras;
}

// Claves enteras, no cadenas: estas tres estadisticas recorren todas las celdas cargadas en cada
// proyeccion y el coste se paga dentro del lazo de 100 ms del servidor. Empaquetar cabe de sobra en
// un entero seguro: |coordenada| < MAX_COORDINATE y |region| < MAX_COORDINATE / CHUNK_SIZE.
const POSITION_STRIDE = 2 * MAX_COORDINATE + 1, REGION_LIMIT = Math.ceil(MAX_COORDINATE / CHUNK_SIZE), REGION_STRIDE = 2 * REGION_LIMIT + 1;
const packPosition = (x: number, y: number): number => (x + MAX_COORDINATE) * POSITION_STRIDE + (y + MAX_COORDINATE);
const packRegion = (x: number, y: number): number => (Math.floor(x / CHUNK_SIZE) + REGION_LIMIT) * REGION_STRIDE + (Math.floor(y / CHUNK_SIZE) + REGION_LIMIT);

/** Gini de la comida sumada por region (chunk de CHUNK_SIZE). Forma ordenada: O(n log n) en vez del
 * doble bucle O(n^2), identica por definicion y exacta en los ejemplos de prueba. */
export function giniRecursosPorRegion(tiles: readonly Tile[], lectura: LecturaResidente | undefined = lecturaResidente(tiles)): number {
  const totals = new Map<number, number>();
  let values: number[];
  if (lectura?.chunkX && lectura.chunkY) {
    // Disposición por chunks (CHUNK_SIZE = 16): cada chunk es una región y sus 256 teselas son contiguas, así que el
    // total de la región es la suma en el orden del arreglo (desde 0, como `running`) y la región aparece una sola vez,
    // en el mismo orden de primera visita que el `Map` histórico. Sin `Map`, sin leer x/y de cada tesela.
    const { fast, cells, chunkX } = lectura, food = fast.foodArr;
    values = new Array<number>(chunkX.length);
    for (let k = 0; k < chunkX.length; k++) {
      let running = 0;
      for (let i = k << 8, fin = i + 256; i < fin; i++) { const cell = cells[i]!; running += cell >= 0 ? food[cell]! : tiles[i]!.food; }
      values[k] = running;
    }
  } else {
    const cells = lectura?.cells, food = lectura?.fast.foodArr;
    // Las teselas llegan agrupadas por región: se acumula la racha en una variable (continuando el total ya guardado,
    // así la suma de cada región conserva el orden de teselas) y se vuelca solo al cambiar de región.
    let open = false, current = 0, running = 0;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!, region = packRegion(tile.x, tile.y);
      if (!open || region !== current) {
        if (open) totals.set(current, running);
        open = true; current = region; running = totals.get(region) ?? 0;
      }
      const cell = cells ? cells[i]! : -1;
      running += cell >= 0 ? food![cell]! : tile.food;
    }
    if (open) totals.set(current, running);
    values = [...totals.values()];
  }
  values.sort((left, right) => left - right);
  const n = values.length;
  if (n === 0) return 0;
  let sum = 0, weighted = 0;
  for (let i = 0; i < n; i++) { const value = values[i]!; sum += value; weighted += (i + 1) * value; }
  if (sum === 0) return 0;
  return 2 * weighted / (n * sum) - (n + 1) / n;
}

export function fraccionCeldasConComida(tiles: readonly Tile[], umbral = 0.1, lectura: LecturaResidente | undefined = lecturaResidente(tiles)): number {
  let land = 0, withFood = 0;
  if (lectura) {
    const { fast, cells } = lectura, terreno = fast.terrainArr, food = fast.foodArr, WATER = fast.TERRAIN_WATER;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      if (cell >= 0) { if (terreno[cell] !== WATER) { land++; if (food[cell]! > umbral) withFood++; } }
      else { const tile = tiles[i]!; if (tile.terrain !== 'water') { land++; if (tile.food > umbral) withFood++; } }
    }
  } else for (const tile of tiles) if (tile.terrain !== 'water') { land++; if (tile.food > umbral) withFood++; }
  return land === 0 ? 0 : withFood / land;
}

/** Distancia BFS media (celdas cargadas) desde tierra hasta agua POTABLE conectada (4-vecinos);
 * sin ninguna fuente devuelve -1 (Infinity no sobrevive a JSON). R1 (SC-004 parte 3, hallazgo
 * residual T041): la semilla del BFS es SOLO `drinkingWater > 0` — el mar (`terrain === 'water'`)
 * nunca es fuente aquí, porque no es agua potable (`ecosystem.ts` fija `drinkingWater = 0` para
 * toda tesela oceánica) y contarlo infla artificialmente la conectividad, invirtiendo el veredicto
 * de SC-004 en mundos costeros (ver `.superpowers/sdd/tasks/t041-residuales.md`, hallazgo R1).
 * BFS por indices enteros sobre arrays tipados: sin objetos ni claves de cadena por celda visitada. */
export function distanciaMediaAgua(tiles: readonly Tile[], lectura: LecturaResidente | undefined = lecturaResidente(tiles)): number {
  const count = tiles.length;
  const distances = new Int32Array(count).fill(-1), queue = new Int32Array(count);
  const cells = lectura?.cells, agua = lectura?.fast.drinkingWaterArr;
  let tail = 0;
  for (let i = 0; i < count; i++) {
    const cell = cells ? cells[i]! : -1;
    // Un NaN del SoA es «ausente» (`tile.drinkingWater ?? 0`): `NaN > 0` es falso, igual que `0 > 0`.
    if (cell >= 0 ? agua![cell]! > 0 : (tiles[i]!.drinkingWater ?? 0) > 0) { distances[i] = 0; queue[tail++] = i; }
  }
  if (tail === 0) return -1;
  if (lectura?.chunkX && lectura.chunkY) bfsPorChunks(distances, queue, tail, lectura.chunkX, lectura.chunkY);
  else bfsPorPosicion(tiles, distances, queue, tail);
  let land = 0, total = 0;
  if (lectura) {
    const terreno = lectura.fast.terrainArr, WATER = lectura.fast.TERRAIN_WATER;
    for (let i = 0; i < count; i++) {
      const distance = distances[i]!;
      if (distance < 0) continue;
      const cell = lectura.cells[i]!;
      if (cell >= 0 ? terreno[cell] !== WATER : tiles[i]!.terrain !== 'water') { land++; total += distance; }
    }
  } else for (let i = 0; i < count; i++) if (tiles[i]!.terrain !== 'water' && distances[i]! >= 0) { land++; total += distances[i]!; }
  return land === 0 ? 0 : total / land;
}

/** BFS histórico por posición (4-vecinos en el orden fijo N, O, E, S). */
function bfsPorPosicion(tiles: readonly Tile[], distances: Int32Array, queue: Int32Array, seeds: number): void {
  const lookup = positionLookup(tiles);
  let tail = seeds;
  // Vecinos en el orden fijo N, O, E, S: el recorrido BFS (y por tanto cada distancia) no cambia.
  for (let head = 0; head < tail; head++) {
    const origin = queue[head]!, tile = tiles[origin]!, next = distances[origin]! + 1, x = tile.x, y = tile.y;
    let neighbor = lookup(x, y - 1);
    if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
    neighbor = lookup(x - 1, y);
    if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
    neighbor = lookup(x + 1, y);
    if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
    neighbor = lookup(x, y + 1);
    if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
  }
}

const CHUNK_OFFSET = 2 ** 21, CHUNK_STRIDE = 2 ** 22;
/**
 * Mismo BFS sobre un arreglo de chunks completos de 16 × 16 (`tiles[256·k + s]`, `s = (y & 15) << 4 | (x & 15)`):
 * el vecino de una casilla interior es `origen ± 1` / `± 16` sin consultar nada, y sólo el 12,5 % que cruza el borde
 * del chunk mira una tabla de 4 vecinos por chunk precalculada (1 086 chunks en el mundo real, no 278 016 posiciones).
 * Misma relación de vecindad geométrica y mismo orden N, O, E, S que `bfsPorPosicion`; sin posiciones repetidas.
 */
function bfsPorChunks(distances: Int32Array, queue: Int32Array, seeds: number, chunkX: Int32Array, chunkY: Int32Array): void {
  const chunks = chunkX.length, index = new Map<number, number>(), around = new Int32Array(chunks * 4).fill(-1);
  const key = (cx: number, cy: number): number => (cx + CHUNK_OFFSET) * CHUNK_STRIDE + (cy + CHUNK_OFFSET);
  for (let k = 0; k < chunks; k++) index.set(key(chunkX[k]! >> 4, chunkY[k]! >> 4), k);
  for (let k = 0; k < chunks; k++) {
    const cx = chunkX[k]! >> 4, cy = chunkY[k]! >> 4;
    around[k * 4] = index.get(key(cx, cy - 1)) ?? -1;
    around[k * 4 + 1] = index.get(key(cx - 1, cy)) ?? -1;
    around[k * 4 + 2] = index.get(key(cx + 1, cy)) ?? -1;
    around[k * 4 + 3] = index.get(key(cx, cy + 1)) ?? -1;
  }
  let tail = seeds;
  for (let head = 0; head < tail; head++) {
    const origin = queue[head]!, next = distances[origin]! + 1, k = origin >> 8, s = origin & 255;
    let neighbor: number, other: number;
    if (s >= 16) neighbor = origin - 16; else { other = around[k * 4]!; neighbor = other >= 0 ? (other << 8) | (s + 240) : -1; }
    if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
    if ((s & 15) !== 0) neighbor = origin - 1; else { other = around[k * 4 + 1]!; neighbor = other >= 0 ? (other << 8) | (s + 15) : -1; }
    if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
    if ((s & 15) !== 15) neighbor = origin + 1; else { other = around[k * 4 + 2]!; neighbor = other >= 0 ? (other << 8) | (s - 15) : -1; }
    if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
    if (s < 240) neighbor = origin + 16; else { other = around[k * 4 + 3]!; neighbor = other >= 0 ? (other << 8) | (s - 240) : -1; }
    if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
  }
}

/** Máximo de celdas de la rejilla densa por tesela: por encima, las teselas están demasiado dispersas y se usa el mapa. */
const DENSE_GRID_FACTOR = 8;
/**
 * Índice de tesela por posición (`-1` si no hay). Con las teselas agrupadas en una caja compacta usa una
 * rejilla entera densa; si hay coordenadas no enteras, pegadas al borde del mundo (donde `packPosition`
 * solapa filas) o dispersas, usa el mapa de claves empaquetadas de siempre. En ambos casos, ante una posición
 * repetida gana la última tesela, como al rellenar el mapa.
 */
function positionLookup(tiles: readonly Tile[]): (x: number, y: number) => number {
  const count = tiles.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, dense = count > 0;
  for (let i = 0; i < count && dense; i++) {
    const { x, y } = tiles[i]!;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x <= -MAX_COORDINATE || x >= MAX_COORDINATE || y <= -MAX_COORDINATE || y >= MAX_COORDINATE) { dense = false; break; }
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (dense) {
    const width = maxX - minX + 1, height = maxY - minY + 1;
    if (width * height <= DENSE_GRID_FACTOR * count + 1024) {
      const grid = new Int32Array(width * height).fill(-1);
      for (let i = 0; i < count; i++) { const tile = tiles[i]!; grid[(tile.y - minY) * width + (tile.x - minX)] = i; }
      return (x, y) => {
        const dx = x - minX, dy = y - minY;
        return dx < 0 || dy < 0 || dx >= width || dy >= height ? -1 : grid[dy * width + dx]!;
      };
    }
  }
  const index = new Map<number, number>();
  for (let i = 0; i < count; i++) { const tile = tiles[i]!; index.set(packPosition(tile.x, tile.y), i); }
  return (x, y) => index.get(packPosition(x, y)) ?? -1;
}

export const TOTAL_KEYS = ['foodHarvested','woodGathered','stoneGathered','hunts','waterConsumed','cooperation','teaching','trade','conflicts','births','cultivations','constructionHelp'] as const;
/** Tope de cada suma de `count`. Lo comparte la reducción de T153 para que las dos vías no puedan divergir. */
export const TOTALS_CAP = 1e12;
/**
 * Saturación de un acumulador: `Math.min(1e12, (current ?? 0) + amount)` en cada suma.
 * Con el acumulado por debajo del tope, `Math.min` devuelve la suma ya hecha, bit a bit.
 */
export function saturateTotal(current: number | undefined, amount: number): number {
  return Math.min(TOTALS_CAP, (current ?? 0) + amount);
}
export function emptyTotals(): Record<string, number> { return Object.fromEntries(TOTAL_KEYS.map(key => [key, 0])); }
export function count(world: World, key: typeof TOTAL_KEYS[number] | 'roadsPaved', amount = 1): void {
  world.totals[key] = saturateTotal(world.totals[key], amount);
}
function sample(world: World): WorldSample {
  // Una sola pasada: cada suma conserva su orden (habitante a habitante), idéntica a un `reduce` por magnitud.
  const n = Math.max(1, world.people.length);
  let hunger = 0, energy = 0, fatigue = 0, thirst = 0;
  for (const p of world.people) { hunger += p.hunger; energy += p.energy; fatigue += p.fatigue; thirst += p.thirst; }
  return { tick: world.tick, population: world.people.length, hunger: hunger / n, energy: energy / n, fatigue: fatigue / n, thirst: thirst / n, discoveries: world.discoveredChunks, settlements: world.settlementCount, cooperation: world.totals.cooperation ?? 0, births: world.totals.births ?? 0 };
}
export function recordSample(world: World): void {
  if (world.tick % 60 !== 0) return;
  world.history.push(sample(world)); world.history = world.history.slice(-96);
}
export function worldStatistics(world: World): WorldStatsRecursos {
  // Memoria por (mundo, paso): `projectWorld` corre una vez por cliente conectado y el
  // recorrido de teselas y fauna es idéntico para todos dentro del mismo paso.
  const memoria = vistaPorMundo.get(world);
  if (memoria && memoria.tick === world.tick) return memoria.value;
  const value = computeWorldStatistics(world);
  vistaPorMundo.set(world, { tick: world.tick, value });
  return value;
}
function computeWorldStatistics(world: World): WorldStatsRecursos {
  // Una sola resolución de celdas SoA para las cuatro métricas caras y el recorrido de biomas (`undefined` sin vía rápida).
  const lectura = lecturaResidente(world.tiles);
  const caras = estadisticasCaras(world, lectura);
  const actions: Record<string, number> = {}, biomes: Record<string, number> = {}, features: Record<string, number> = {}, generations: Record<string, number> = {}, wildlife: Record<string, number> = {};
  const materials = { wood: 0, stone: 0 }; let freshWater = 0, cultivatedTiles = 0, trailTiles = 0, pavedTiles = 0;
  // T134 (FR-026): censo sobre TODA la población, no solo la de la cámara — `people` ahora se
  // recorta por viewport (`projectWorld`), así que el recuento y las etapas de vida deben salir
  // de aquí, no de contar el `people` recibido como hacía el cliente (`game.ts:419-437`).
  const cuerpo = paramsOf(world).cuerpo;
  const lifeStage = { juvenile: 0, adult: 0, senescent: 0, unknown: 0 };
  let neighbors = 0, identities = 0, protectedCount = 0;
  // Las cuatro sumas mantienen el orden original de `sample`, en esta misma pasada censal.
  let hunger = 0, energy = 0, fatigue = 0, thirst = 0;
  for (const p of world.people) {
    hunger += p.hunger; energy += p.energy; fatigue += p.fatigue; thirst += p.thirst;
    actions[p.action] = (actions[p.action] ?? 0) + 1; generations[p.genome.generation] = (generations[p.genome.generation] ?? 0) + 1; materials.wood += p.materials.wood; materials.stone += p.materials.stone;
    if (p.role === 'neighbor') {
      neighbors++;
      const traits = demographicTraits(p.genome, cuerpo);
      const age = p.demography.age;
      if (typeof age !== 'number') lifeStage.unknown++;
      else if (age < traits.maturityAge) lifeStage.juvenile++; else if (age < traits.senescenceStart) lifeStage.adult++; else lifeStage.senescent++;
    } else {
      // Server-computed, never absent: identities are always continuity-protected by role.
      identities++; protectedCount++;
    }
  }
  const population = world.people.length, n = Math.max(1, population);
  // Biomas y rasgos se cuentan por rachas (las teselas contiguas repiten valor) y se vuelcan al cambiar:
  // son enteros, así que los totales y el orden de primera aparición de las claves no cambian.
  let lastBiome: string | undefined, biomeRun = 0;
  let lastFeature: string | undefined, featureRun = 0;
  if (lectura) {
    // Vía rápida SoA (completa o parcial): bioma, rasgo, agua potable, cultivo y tránsito salen de los
    // arrays residentes (0 accesores/Proxy para celdas ligadas); solo las teselas aún sin ligar (`cell < 0`)
    // leen el objeto. Mismo orden de primera aparición de claves y misma suma de `freshWater` que el barrido base.
    const tiles = world.tiles, { fast, cells } = lectura;
    const biomeArr = fast.biomeArr, featureArr = fast.featureArr, waterArr = fast.drinkingWaterArr;
    const cultArr = fast.cultivationArr, trafficArr = fast.trafficArr;
    const biomeNames = fast.BIOME_NAMES, featureNames = fast.FEATURE_NAMES;
    let lastBiomeCode = -1, lastFeatureCode = -1;
    for (let i = 0; i < tiles.length; i++) {
      const cell = cells[i]!;
      if ((tiles[i]!.paved ?? 0) >= 0.5) pavedTiles++;
      if (cell >= 0) {
        const bcode = biomeArr[cell]!;
        if (bcode === lastBiomeCode) biomeRun++;
        else {
          const biome = bcode ? biomeNames[bcode - 1]! : 'grassland';
          if (biome !== lastBiome) {
            if (lastBiome !== undefined) biomes[lastBiome] = (biomes[lastBiome] ?? 0) + biomeRun;
            lastBiome = biome; biomeRun = 0;
          }
          biomeRun++; lastBiomeCode = bcode;
        }
        const fcode = featureArr[cell]!;
        if (fcode === lastFeatureCode) featureRun++;
        else {
          const feature = fcode ? featureNames[fcode - 1]! : 'none';
          if (feature !== lastFeature) {
            if (lastFeature !== undefined) features[lastFeature] = (features[lastFeature] ?? 0) + featureRun;
            lastFeature = feature; featureRun = 0;
          }
          featureRun++; lastFeatureCode = fcode;
        }
        const water = waterArr[cell]!;
        freshWater += water === water ? water : 0;
        if (cultArr[cell]! > 0.1) cultivatedTiles++;
        if (trafficArr[cell]! > 0.15) trailTiles++;
      } else {
        lastBiomeCode = -1; lastFeatureCode = -1;
        const tile = tiles[i]!, biome = tile.biome ?? 'grassland', feature = tile.feature ?? 'none';
        if (biome !== lastBiome) { if (lastBiome !== undefined) biomes[lastBiome] = (biomes[lastBiome] ?? 0) + biomeRun; lastBiome = biome; biomeRun = 0; }
        biomeRun++;
        if (feature !== lastFeature) { if (lastFeature !== undefined) features[lastFeature] = (features[lastFeature] ?? 0) + featureRun; lastFeature = feature; featureRun = 0; }
        featureRun++;
        freshWater += tile.drinkingWater ?? 0; if ((tile.cultivation ?? 0) > 0.1) cultivatedTiles++; if ((tile.traffic ?? 0) > 0.15) trailTiles++;
      }
    }
  } else {
    for (const tile of world.tiles) {
      if ((tile.paved ?? 0) >= 0.5) pavedTiles++;
      const biome = tile.biome ?? 'grassland', feature = tile.feature ?? 'none';
      if (biome !== lastBiome) { if (lastBiome !== undefined) biomes[lastBiome] = (biomes[lastBiome] ?? 0) + biomeRun; lastBiome = biome; biomeRun = 0; }
      biomeRun++;
      if (feature !== lastFeature) { if (lastFeature !== undefined) features[lastFeature] = (features[lastFeature] ?? 0) + featureRun; lastFeature = feature; featureRun = 0; }
      featureRun++;
      freshWater += tile.drinkingWater ?? 0; if ((tile.cultivation ?? 0) > 0.1) cultivatedTiles++; if ((tile.traffic ?? 0) > 0.15) trailTiles++;
    }
  }
  if (lastBiome !== undefined) biomes[lastBiome] = (biomes[lastBiome] ?? 0) + biomeRun;
  if (lastFeature !== undefined) features[lastFeature] = (features[lastFeature] ?? 0) + featureRun;
  for(const animal of world.animals) { const especie=especieVisual(animal.species); wildlife[especie]=(wildlife[especie]??0)+1; }
  const structures: Record<string, number> = {};
  let polyominoStructures = 0, synergyLinks = 0;
  for (const structure of world.structures) {
    freshWater += structure.water;
    for (const component of structure.components) structures[component] = (structures[component] ?? 0) + 1;
    if ((structure.cells?.length ?? ((structure.footprint?.width ?? 1) * (structure.footprint?.height ?? 1))) > 1) polyominoStructures++;
    const synergy = structure.synergy;
    synergyLinks += (synergy?.sharedEdges ?? 0) + (synergy?.heated ? 1 : 0) + (synergy?.irrigated ? 1 : 0) + ((synergy?.workshopBonus ?? 0) > 0 ? 1 : 0);
  }
  const chemistry = world.chemistry as { formulas?: unknown[] } | undefined;
  const chemicalFormulas = chemistry?.formulas?.length ?? 0;
  return { population, meanEnergy: energy / n, meanHunger: hunger / n, meanFatigue: fatigue / n, meanThirst: thirst / n, materials, actions, biomes, features, totals: { ...world.totals }, generations, history: world.history.map(s => ({ ...s })), scope: 'active-regions', wildlife, freshWater, cultivatedTiles, trailTiles, animalDynamics:{...world.animalDynamics}, structures,blueprints:world.blueprints.length,inventionDynamics:{...world.inventionDynamics}, ...caras, diversidad: { ...caras.diversidad },
    census: { neighbors, identities, protectedCount, lifeStage: { ...lifeStage } },
    ...(pavedTiles > 0 ? { pavedTiles } : {}), ...(polyominoStructures > 0 ? { polyominoStructures } : {}),
    ...(synergyLinks > 0 ? { synergyLinks } : {}), ...(chemicalFormulas > 0 ? { chemicalFormulas } : {}) };
}
