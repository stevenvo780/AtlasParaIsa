import type { Tile } from '../shared/types.js';
import type { Person, World } from './index.js';
import { extractLocalObservation } from './politica.js';

/**
 * Empaqueta una celda entera en un entero seguro. El sesgo de 2^25 cubre el intervalo
 * técnico de coordenadas (±10_000_000) con margen, y el producto cabe bajo 2^53.
 * Fuera de ese intervalo, o si alguna coordenada no es un entero seguro, devuelve
 * `undefined` para que el llamador use la clave de texto original.
 */
const CELL_KEY_BIAS = 33_554_432;
const CELL_KEY_SPAN = 67_108_864;

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

const clamp = (n: number, max = 1): number => Math.max(0, Math.min(max, n));

/** `visited` se reasigna con `slice` al entrar en una celda nueva, pero un `push`/`shift`
 * en el mismo arreglo deja la longitud quieta en el tope. La caché exige identidad del
 * arreglo y, además, longitud + primer + último elemento. */
interface VisitedInts { length: number; first: string | undefined; last: string | undefined; set: Set<number> }
const visitedInts = new WeakMap<string[], VisitedInts>();

function canonicalCellKey(entry: string): number | undefined {
  const comma = entry.indexOf(',');
  if (comma <= 0 || entry.indexOf(',', comma + 1) !== -1) return undefined;
  const xs = entry.slice(0, comma), ys = entry.slice(comma + 1);
  const x = Number(xs), y = Number(ys);
  if (String(x) !== xs || String(y) !== ys) return undefined;
  return cellIntKey(x, y);
}

function visitedIntegerSet(visited: string[]): Set<number> {
  const first = visited[0], last = visited[visited.length - 1];
  const hit = visitedInts.get(visited);
  if (hit && hit.length === visited.length && hit.first === first && hit.last === last) return hit.set;
  const set = new Set<number>();
  for (let i = 0; i < visited.length; i++) {
    const key = canonicalCellKey(visited[i]!);
    if (key !== undefined) set.add(key);
  }
  visitedInts.set(visited, { length: visited.length, first, last, set });
  return set;
}

/** Misma observación local que el bucle de radio 4 sobre `tileAt`, sin construir
 * un `{x,y}` ni una cadena por celda. `tileIn` es el índice tomado una vez por paso. */
export function computeLocalPolicyObservation(
  world: World,
  person: Person,
  tileIn: (x: number, y: number) => Tile | undefined,
  nearbyPeople: readonly { id: string }[],
): Float64Array {
  void world;
  let land = 0, foodSum = 0, waterTiles = 0, shelterTiles = 0, materialSum = 0, unvisited = 0;
  const visited = person.visited;
  const ints = visited.length > 0 ? visitedIntegerSet(visited) : null;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (dx * dx + dy * dy > 16) continue;
    const tile = tileIn(person.x + dx, person.y + dy);
    if (!tile || tile.terrain === 'water') continue;
    land++;
    foodSum += tile.food;
    if ((tile.drinkingWater ?? 0) > 0.005) waterTiles++;
    if (tile.terrain === 'shelter') shelterTiles++;
    materialSum += (tile.wood ?? 0) + (tile.stone ?? 0);
    const key = cellIntKey(tile.x, tile.y);
    if (key === undefined) {
      if (visited.length === 0 || !visited.includes(`${tile.x},${tile.y}`)) unvisited++;
    } else if (!ints || !ints.has(key)) unvisited++;
  }
  let trustSum = 0;
  for (const other of nearbyPeople) trustSum += person.bonds[other.id] ?? 0;
  const denom = Math.max(1, land);
  return extractLocalObservation({
    hunger: clamp(person.hunger),
    thirst: clamp(person.thirst),
    fatigue: clamp(person.fatigue),
    energy: clamp(person.energy),
    inventoryFrac: clamp(person.inventory / 0.25),
    localFood: clamp(foodSum / denom),
    localWater: clamp((waterTiles / denom) * 3),
    localCrowd: clamp(nearbyPeople.length / 16),
    localShelter: clamp(shelterTiles / 4),
    localResources: clamp(materialSum / 24),
    communityTrust: nearbyPeople.length > 0 ? clamp(trustSum / nearbyPeople.length) : 0,
    biomeNovelty: clamp(unvisited / denom),
  });
}
