import type { Tile } from '../shared/types.js';
import type { Person, World } from './index.js';
import type { ResidentFastAccess } from './soa/terreno.js';

/**
 * Empaqueta una celda entera en un entero seguro. El sesgo de 2^25 cubre el intervalo
 * técnico de coordenadas (±10_000_000) con margen, y el producto cabe bajo 2^53.
 * Fuera de ese intervalo, o si alguna coordenada no es un entero seguro, devuelve
 * `undefined` para que el llamador use la clave de texto original.
 */
const CELL_KEY_BIAS = 33_554_432;
const CELL_KEY_SPAN = 67_108_864;
const SOA_SAFE_COORD = 1_073_741_800; // 2^30 - 24: x ± 4 siempre en el dominio admisible SoA

export function cellIntKey(x: number, y: number): number | undefined {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined;
  if (x < -CELL_KEY_BIAS || x >= CELL_KEY_BIAS || y < -CELL_KEY_BIAS || y >= CELL_KEY_BIAS) return undefined;
  return (y + CELL_KEY_BIAS) * CELL_KEY_SPAN + (x + CELL_KEY_BIAS);
}

export function cellKeyX(key: number): number {
  return (key % CELL_KEY_SPAN) - CELL_KEY_BIAS;
}

export function cellKeyY(key: number): number {
  return Math.floor(key / CELL_KEY_SPAN) - CELL_KEY_BIAS;
}

const PARSE_INVALID = 0x7fffffff;

/** Parsea un entero decimal canónico en `[-CELL_KEY_BIAS, CELL_KEY_BIAS)` sin asignar subcadenas:
 * acepta exactamente lo mismo que `String(Number(s)) === s && cellIntKey` (rechaza `-0`, `01`, `+3`,
 * espacios, fracciones y fuera de rango). */
function parseCanonInt(s: string, start: number, end: number): number {
  if (start >= end) return PARSE_INVALID;
  let i = start, neg = false;
  let c = s.charCodeAt(i);
  if (c === 45) {
    neg = true;
    i++;
    if (i >= end) return PARSE_INVALID;
    c = s.charCodeAt(i);
    if (c < 49 || c > 57) return PARSE_INVALID;
  } else if (c === 48) {
    return i + 1 === end ? 0 : PARSE_INVALID;
  } else if (c < 49 || c > 57) {
    return PARSE_INVALID;
  }
  if (end - i > 8) return PARSE_INVALID;
  let val = c - 48;
  for (i++; i < end; i++) {
    c = s.charCodeAt(i);
    if (c < 48 || c > 57) return PARSE_INVALID;
    val = val * 10 + (c - 48);
  }
  const signed = neg ? -val : val;
  return signed >= -CELL_KEY_BIAS && signed < CELL_KEY_BIAS ? signed : PARSE_INVALID;
}

/** `visited` se reasigna con `slice` al entrar en una celda nueva, pero un `push`/`shift`
 * en el mismo arreglo deja la longitud quieta en el tope. La caché por persona exige identidad
 * del arreglo y, además, longitud + primer + último elemento, y reutiliza el `Int32Array` de
 * coordenadas y la máscara de 81 bits (ventana 9 × 9 alrededor de `(px, py)`), con 0 reservas
 * de cadenas ni `Set<number>` de HeapNumbers. */
interface VisitedWindowCache {
  visited: string[];
  length: number;
  first: string | undefined;
  last: string | undefined;
  coords: Int32Array;
  count: number;
  px: number;
  py: number;
  m0: number;
  m1: number;
  m2: number;
}
const visitedWindows = new WeakMap<Person, VisitedWindowCache>();

function visitedWindowMask(person: Person, visited: string[], px: number, py: number): VisitedWindowCache {
  const len = visited.length, first = visited[0], last = visited[len - 1];
  let cache = visitedWindows.get(person);
  if (cache && cache.visited === visited && cache.length === len && cache.first === first && cache.last === last) {
    if (cache.px === px && cache.py === py) return cache;
    let m0 = 0, m1 = 0, m2 = 0;
    const coords = cache.coords, end = cache.count * 2;
    for (let i = 0; i < end; i += 2) {
      const dx = coords[i]! - px;
      if (dx < -4 || dx > 4) continue;
      const dy = coords[i + 1]! - py;
      if (dy < -4 || dy > 4) continue;
      const bit = (dy + 4) * 9 + (dx + 4);
      if (bit < 30) m0 |= 1 << bit;
      else if (bit < 60) m1 |= 1 << (bit - 30);
      else m2 |= 1 << (bit - 60);
    }
    cache.px = px; cache.py = py; cache.m0 = m0; cache.m1 = m1; cache.m2 = m2;
    return cache;
  }
  const needed = len * 2;
  const coords = cache && cache.coords.length >= needed ? cache.coords : new Int32Array(Math.max(384, needed));
  let count = 0, m0 = 0, m1 = 0, m2 = 0;
  for (let i = 0; i < len; i++) {
    const entry = visited[i]!;
    const comma = entry.indexOf(',');
    if (comma <= 0 || entry.indexOf(',', comma + 1) !== -1) continue;
    const vx = parseCanonInt(entry, 0, comma);
    if (vx === PARSE_INVALID) continue;
    const vy = parseCanonInt(entry, comma + 1, entry.length);
    if (vy === PARSE_INVALID) continue;
    coords[count * 2] = vx;
    coords[count * 2 + 1] = vy;
    count++;
    const dx = vx - px;
    if (dx >= -4 && dx <= 4) {
      const dy = vy - py;
      if (dy >= -4 && dy <= 4) {
        const bit = (dy + 4) * 9 + (dx + 4);
        if (bit < 30) m0 |= 1 << bit;
        else if (bit < 60) m1 |= 1 << (bit - 30);
        else m2 |= 1 << (bit - 60);
      }
    }
  }
  if (!cache) {
    cache = { visited, length: len, first, last, coords, count, px, py, m0, m1, m2 };
    visitedWindows.set(person, cache);
  } else {
    cache.visited = visited; cache.length = len; cache.first = first; cache.last = last;
    cache.coords = coords; cache.count = count; cache.px = px; cache.py = py;
    cache.m0 = m0; cache.m1 = m1; cache.m2 = m2;
  }
  return cache;
}

function encodeObs(value: number, key: string): number {
  const c = Math.max(0, Math.min(1, value));
  if (!Number.isFinite(c)) throw new RangeError(`Invalid local observation: ${key}`);
  return c * 2 - 1;
}

/** Misma observación local que el bucle de radio 4 sobre `tileAt`, sin construir
 * un `{x,y}` ni una cadena por celda. `tileIn` es el índice tomado una vez por paso. */
export function computeLocalPolicyObservation(
  world: World,
  person: Person,
  tileIn: (x: number, y: number) => Tile | undefined,
  nearbyPeople: readonly { id: string }[],
  fast?: ResidentFastAccess,
  out: Float64Array = new Float64Array(12),
  offset = 0,
): Float64Array {
  void world;
  let land = 0, foodSum = 0, waterTiles = 0, shelterTiles = 0, materialSum = 0, unvisited = 0;
  const px = person.x, py = person.y;
  const visited = person.visited;
  const intCenter = (px | 0) === px && (py | 0) === py && px >= -CELL_KEY_BIAS + 4 && px < CELL_KEY_BIAS - 4 && py >= -CELL_KEY_BIAS + 4 && py < CELL_KEY_BIAS - 4;
  let m0 = 0, m1 = 0, m2 = 0;
  if (visited.length > 0 && intCenter) {
    const win = visitedWindowMask(person, visited, px, py);
    m0 = win.m0; m1 = win.m1; m2 = win.m2;
  }
  const exact = fast?.exact;
  const WATER = fast?.TERRAIN_WATER ?? -1, SHELTER = fast?.TERRAIN_SHELTER ?? -1;
  const terrainArr = fast?.terrainArr, foodArr = fast?.foodArr, dwArr = fast?.drinkingWaterArr, woodArr = fast?.woodArr;
  // Con `exact` y centro entero admisible, el disco de radio 4 toca a lo sumo 2 × 2 páginas SoA:
  // precargar las 4 bases evita 49 lookups de RegionTable por observador.
  const usePageCache = !!exact && (px | 0) === px && (py | 0) === py && px >= -SOA_SAFE_COORD && px <= SOA_SAFE_COORD && py >= -SOA_SAFE_COORD && py <= SOA_SAFE_COORD;
  const px0 = usePageCache ? (px - 4) >> 4 : 0, px1 = usePageCache ? (px + 4) >> 4 : 0;
  const py0 = usePageCache ? (py - 4) >> 4 : 0, py1 = usePageCache ? (py + 4) >> 4 : 0;
  const b00 = usePageCache ? exact!.pageBase(px0, py0) : -1;
  const b10 = usePageCache ? (px1 !== px0 ? exact!.pageBase(px1, py0) : b00) : -1;
  const b01 = usePageCache ? (py1 !== py0 ? exact!.pageBase(px0, py1) : b00) : -1;
  const b11 = usePageCache ? (py1 !== py0 ? (px1 !== px0 ? exact!.pageBase(px1, py1) : b01) : b10) : -1;
  const stampsArr = exact?.stampsArr, versionStamp = exact?.versionStamp ?? 0;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (dx * dx + dy * dy > 16) continue;
    const x = px + dx, y = py + dy;
    let cell = -1;
    if (exact) {
      if (usePageCache) {
        const base = (y >> 4) === py0 ? ((x >> 4) === px0 ? b00 : b10) : ((x >> 4) === px0 ? b01 : b11);
        if (base < 0) continue;
        cell = base | ((y & 15) << 4) | (x & 15);
        if (stampsArr![cell] !== versionStamp || terrainArr![cell] === WATER) continue;
      } else {
        cell = exact.cellAt(x, y);
        if (cell < 0 || terrainArr![cell] === WATER) continue;
      }
    }
    const tile = tileIn(x, y);
    if (!exact) {
      if (!tile) continue;
      cell = fast ? fast.cellOf(tile) : -1;
      if (cell >= 0 ? terrainArr![cell] === WATER : tile.terrain === 'water') continue;
    }
    land++;
    if (cell >= 0) {
      const f = foodArr![cell]!, dw = dwArr![cell]!, w = woodArr![cell]!;
      foodSum += f === f ? f : 0;
      if (dw === dw && dw > 0.005) waterTiles++;
      if (terrainArr![cell] === SHELTER) shelterTiles++;
      materialSum += (w === w ? w : 0) + (tile?.stone ?? 0);
    } else {
      foodSum += tile!.food;
      if ((tile!.drinkingWater ?? 0) > 0.005) waterTiles++;
      if (tile!.terrain === 'shelter') shelterTiles++;
      materialSum += (tile!.wood ?? 0) + (tile!.stone ?? 0);
    }
    if (visited.length === 0) {
      unvisited++;
    } else if (intCenter && (exact || (tile!.x === x && tile!.y === y))) {
      const bit = (dy + 4) * 9 + (dx + 4);
      const seen = bit < 30 ? (m0 & (1 << bit)) !== 0 : bit < 60 ? (m1 & (1 << (bit - 30))) !== 0 : (m2 & (1 << (bit - 60))) !== 0;
      if (!seen) unvisited++;
    } else {
      const tx = exact ? x : tile!.x, ty = exact ? y : tile!.y;
      if (!visited.includes(`${tx},${ty}`)) unvisited++;
    }
  }
  let trustSum = 0;
  const bonds = person.bonds;
  for (let i = 0; i < nearbyPeople.length; i++) trustSum += bonds[nearbyPeople[i]!.id] ?? 0;
  const denom = Math.max(1, land);
  out[offset] = encodeObs(person.hunger, 'hunger');
  out[offset + 1] = encodeObs(person.thirst, 'thirst');
  out[offset + 2] = encodeObs(person.fatigue, 'fatigue');
  out[offset + 3] = encodeObs(person.energy, 'energy');
  out[offset + 4] = encodeObs(person.inventory / 0.25, 'inventoryFrac');
  out[offset + 5] = encodeObs(foodSum / denom, 'localFood');
  out[offset + 6] = encodeObs((waterTiles / denom) * 3, 'localWater');
  out[offset + 7] = encodeObs(nearbyPeople.length / 16, 'localCrowd');
  out[offset + 8] = encodeObs(shelterTiles / 4, 'localShelter');
  out[offset + 9] = encodeObs(materialSum / 24, 'localResources');
  out[offset + 10] = encodeObs(nearbyPeople.length > 0 ? trustSum / nearbyPeople.length : 0, 'communityTrust');
  out[offset + 11] = encodeObs(unvisited / denom, 'biomeNovelty');
  return out;
}
