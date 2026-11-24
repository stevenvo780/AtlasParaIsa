import { type Point, type TileLookup, distance } from '../mundo/geometria.js';
import { type Memory, type World, type Person, TICKS_PER_DAY, RADIUS } from '../mundo/tipos.js';
import type { Action, PersonView, Tile, PlaceView } from '../../shared/types.js';
import type { ResidentFastAccess } from '../soa/terreno.js';
import type { StructureView } from '../../shared/life.js';
import { tileLookup } from '../tile-index.js';
import { filtrarCerca } from '../indice-puntos.js';
import { BROKEN_CONDITION, foodAvailable, waterAvailable, facilityRestQuality, REST_FATIGUE_RATE, REST_ENERGY_RATE } from '../inventions.js';
import { paramsOf } from '../params.js';
import { updateDemography, demographicTraits } from '../demography.js';
import { cellIntKey } from '../politica-obs.js';
import { type BodyState, hydrateBody, exertBody, type BodyRates, restBody } from '../body.js';
import { SED_POR_UNIDAD, HAMBRE_POR_PASO, SED_POR_PASO } from '../ecologia-constantes.js';
import { canHandleContainedWater, WATER_WORK_ENERGY, WATER_WORK_FATIGUE } from '../technology-water.js';
import { WATER_QUANTA_PER_UNIT, flowQuantized } from '../material-affordances.js';
import { advanceNeeds } from '../needs.js';


export interface Candidate { action: Action; target: Point; score: number; reason: string; memory?: Memory; directed?: boolean; policyDelta?: number; prePolicyScore?: number; }

/** Ley DIV (`conducta.aptitud`): qué rasgo heredable hace a alguien apto para
 * cada OFICIO. Sigue las afinidades que la elección ya usaba (explorar e investigar con
 * `curiosity`, recolectar/cultivar con `industriousness`, compartir con `care`); la caza, el
 * esfuerzo físico más caro, va con `resilience` y cooperar con `sociability`, para que cada uno de
 * los cinco rasgos tenga al menos un oficio. Comer, beber, descansar, los actos de vínculo
 * (acercarse, acompañar, retirarse) y la provisión para una crianza (`forage`, que sólo nace de
 * `familyOpportunity`) no son oficios: la ley no los toca. */
export const RASGO_DEL_OFICIO: Partial<Record<Action, keyof NonNullable<PersonView['traits']>>> = {
  explore: 'curiosity', research: 'curiosity', invent: 'curiosity',
  gather: 'industriousness', farm: 'industriousness', build: 'industriousness', repair: 'industriousness', craft: 'industriousness',
  hunt: 'resilience', share: 'care', cooperate: 'sociability',
};

/** Ventaja comparativa de `traits` en `action` (ley DIV): el rasgo del oficio menos la media de los
 * cinco rasgos de la MISMA persona. Suma cero sobre los cinco rasgos: quien es bueno en todo no
 * gana nada por serlo, sólo ordena sus oficios; 0 para lo que no es un oficio. Pura y exportada
 * para que la ley pueda probarse sin simular. */
export function ventajaComparativa(traits: NonNullable<PersonView['traits']>, action: Action): number {
  const rasgo = RASGO_DEL_OFICIO[action];
  if (!rasgo) return 0;
  return traits[rasgo] - (traits.curiosity + traits.sociability + traits.industriousness + traits.care + traits.resilience) / 5;
}


/** Celda SoA de `(x, y)`: `exact.cellAt` y, si no está, la ligadura de la tesela. `< 0` = leer el objeto. */
export function soaCell(fast: ResidentFastAccess | undefined, x: number, y: number, tile?: Tile): number {
  if (!fast) return -1;
  if (fast.exact) {
    const cell = fast.exact.cellAt(x, y);
    if (cell >= 0) return cell;
  }
  if (tile) {
    const cell = fast.cellOf(tile);
    if (cell >= 0) return cell;
  }
  return -1;
}

function readResidentNumber(arr: Float64Array, cell: number): number | undefined {
  const v = arr[cell]!;
  return v === v ? v : undefined;
}

export function tileIsDesert(tile: Tile, cell: number, fast?: ResidentFastAccess): boolean {
  return fast && cell >= 0 ? fast.biomeArr[cell] === fast.BIOME_DESERT : tile.biome === 'desert';
}

export function tileIsExposed(tile: Tile, cell: number, fast?: ResidentFastAccess): boolean {
  return fast && cell >= 0 ? fast.terrainArr[cell] !== fast.TERRAIN_SHELTER : tile.terrain !== 'shelter';
}

function shelterTerrain(tile: Tile | undefined, cell: number, fast?: ResidentFastAccess): boolean {
  if (fast && cell >= 0) return fast.terrainArr[cell] === fast.TERRAIN_SHELTER;
  return tile?.terrain === 'shelter';
}

/** Igual que el getter (`NaN` = ausente → `undefined`) y que `?? 0` cuando el original lo usa. */
export function foodStock(tile: Tile | undefined, cell: number, fast?: ResidentFastAccess): number {
  const raw = fast && cell >= 0 ? readResidentNumber(fast.foodArr, cell) : tile?.food;
  return raw ?? 0;
}


/** Exact physical roof predicate used by population damage, independent of display labels. */
const bodilyRoofs: StructureView[] = [];

export function bodilyShelter(world: World, point: Point, lookup?: TileLookup, fast?: ResidentFastAccess): number {
  if (!world.shelterBenefitEnabled) return 0;
  const tileIn = lookup ?? tileLookup(world.tiles);
  const tile = tileIn(point.x, point.y);
  if (!shelterTerrain(tile, soaCell(fast, point.x, point.y, tile), fast)) return 0;
  let best = 0;
  const roofs = filtrarCerca(world.structures, point, 0,
    s => s.x === point.x && s.y === point.y && s.condition > BROKEN_CONDITION && s.components.includes('roof'), bodilyRoofs);
  for (let i = 0; i < roofs.length; i++) best = Math.max(best, roofs[i]!.condition);
  return best;
}


/** One model day converts damage/tick into the same normalized units as health.
 * D/(health+D) is bounded even near death. The horizon and existing 3.1 need-score
 * scale are planning heuristics, not biological calibration or changes to damage.
 * Raw damage also keeps protected S/I responsive despite their survival floor. */
export function avoidedDamageScore(person: Person, before: number, after: number, delay = 0): number {
  const damage = Math.max(0, before - after) * Math.max(0, TICKS_PER_DAY - delay);
  return damage > 0 ? 3.1 * damage / (person.demography.health + damage) : 0;
}


export function bodilyDamage(world: World, person: Person, body: Pick<Person, 'hunger' | 'thirst' | 'fatigue' | 'energy'>, shelter: number): number {
  const cuerpo = paramsOf(world).cuerpo;
  const transition = updateDemography({ id: person.id, state: person.demography, traits: demographicTraits(person.genome, cuerpo),
    hunger: body.hunger, thirst: body.thirst, fatigue: body.fatigue, energy: body.energy },
    { exposure: world.weather === 'rain' ? 1 : 0, shelter, protected: person.role !== 'neighbor',
      seed: world.seed, tick: world.tick, senescence: cuerpo }, 1);
  // Senescence remains separate from avoidable bodily damage so elders still value food, water and shelter.
  return transition.damage.starvation + transition.damage.dehydration + transition.damage.exposure;
}


/** Read-only preview of the current cell's meal, including the existing reserve split.
 * This is only a decision forecast. bodyAndAction still owns every actual debit. */
export function immediateMeal(world: World, person: { x: number; y: number; inventory: number; hunger: number }, lookup?: TileLookup, fast?: ResidentFastAccess): number {
  const tileIn = lookup ?? tileLookup(world.tiles);
  const tile = tileIn(person.x, person.y);
  const harvest = Math.min(foodStock(tile, soaCell(fast, person.x, person.y, tile), fast), 0.0035);
  const saved = Math.min(harvest * 0.25, 0.25 - person.inventory);
  let consumed = harvest - saved;
  if (consumed < 0.001 && person.hunger > 0.2) consumed += Math.min(foodAvailable(world, person), 0.002);
  if (consumed < 0.001 && person.inventory + saved > 0 && person.hunger > 0.2) consumed += Math.min(person.inventory + saved, 0.002);
  return consumed;
}


/** Bounded perceived land routes. Planning cannot borrow a path through unseen cells.
 * Integer keys keep the same FIFO order (este, norte, oeste, sur) and the same distances.
 * A coordinate that is not an admissible integer falls back to the original string keys. */
export function perceivedRoutes(person: Person, tiles: Tile[]): (point: Point) => number | undefined {
  const ints = perceivedRouteInts(person, tiles);
  if (ints) return ints;
  const land = new Set(tiles.map(t => `${t.x},${t.y}`)), steps = new Map([[`${person.x},${person.y}`, 0]]), queue: Point[] = [person];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!, n = steps.get(`${p.x},${p.y}`)! + 1;
    for (const next of [{ x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 }]) {
      const key = `${next.x},${next.y}`;
      if (land.has(key) && !steps.has(key)) { steps.set(key, n); queue.push(next); }
    }
  }
  return point => steps.get(`${point.x},${point.y}`);
}


/** Colas de trabajo de la BFS percibida: sólo viven mientras se construye la rejilla (ningún
 * cierre devuelto las captura), así que se reutilizan entre decisiones; la guarda reserva un
 * arreglo nuevo si alguna vez hubiera una construcción reentrante. `steps` sí es del cierre
 * devuelto y se asigna nuevo en cada llamada, como siempre. */
export const ROUTE_CELLS = (2 * RADIUS + 1) * (2 * RADIUS + 1);

const routeQueueScratch = new Int16Array(ROUTE_CELLS), routeQueueXScratch = new Int16Array(ROUTE_CELLS), routeQueueYScratch = new Int16Array(ROUTE_CELLS);

let routeQueueInUse = false;


function perceivedRouteInts(person: Person, tiles: Tile[]): ((point: Point) => number | undefined) | undefined {
  if (cellIntKey(person.x, person.y) === undefined) return undefined;
  const side = 2 * RADIUS + 1, originX = person.x - RADIUS, originY = person.y - RADIUS;
  const steps = new Int16Array(side * side).fill(-2);
  for (const tile of tiles) {
    if (cellIntKey(tile.x, tile.y) === undefined) return undefined;
    const x = tile.x - originX, y = tile.y - originY;
    if (x < 0 || x >= side || y < 0 || y >= side) return undefined;
    steps[y * side + x] = -1;
  }
  const scratch = !routeQueueInUse;
  const queue = scratch ? routeQueueScratch : new Int16Array(steps.length);
  const queueX = scratch ? routeQueueXScratch : new Int16Array(steps.length);
  const queueY = scratch ? routeQueueYScratch : new Int16Array(steps.length);
  if (scratch) routeQueueInUse = true;
  const origin = RADIUS * side + RADIUS;
  steps[origin] = 0; queue[0] = origin; queueX[0] = RADIUS; queueY[0] = RADIUS;
  let tail = 1;
  for (let head = 0; head < tail; head++) {
    const cell = queue[head]!, x = queueX[head]!, y = queueY[head]!, n = steps[cell]! + 1;
    let next = cell + 1;
    if (x + 1 < side && steps[next] === -1) { steps[next] = n; queue[tail] = next; queueX[tail] = x + 1; queueY[tail] = y; tail++; }
    next = cell + side;
    if (y + 1 < side && steps[next] === -1) { steps[next] = n; queue[tail] = next; queueX[tail] = x; queueY[tail] = y + 1; tail++; }
    next = cell - 1;
    if (x > 0 && steps[next] === -1) { steps[next] = n; queue[tail] = next; queueX[tail] = x - 1; queueY[tail] = y; tail++; }
    next = cell - side;
    if (y > 0 && steps[next] === -1) { steps[next] = n; queue[tail] = next; queueX[tail] = x; queueY[tail] = y - 1; tail++; }
  }
  if (scratch) routeQueueInUse = false;
  return point => {
    const x = point.x - originX, y = point.y - originY;
    // El origen es un entero admisible (`cellIntKey` de la persona): un punto con desplazamiento
    // entero dentro de la ventana es un entero seguro, y cualquier otro desplazamiento —fracción,
    // `NaN` o fuera de la ventana— se rechaza aquí igual que con `Number.isSafeInteger`.
    if (x < 0 || x >= side || y < 0 || y >= side || x !== (x | 0) || y !== (y | 0)) return undefined;
    const n = steps[y * side + x]!;
    return n < 0 ? undefined : n;
  };
}


/** Predict the exact finite drinking dose without touching stocks or receipts.
 * Content was maintained before choose; handling still requires its real effort. */
export function drinkingBody(world: World, person: Person, point: Point, out?: BodyState) {
  const body = copyBody(person, out ?? { hunger: 0, thirst: 0, fatigue: 0, energy: 0 });
  const needed = Math.min(.006, body.thirst / SED_POR_UNIDAD), ambient = Math.min(waterAvailable(world, point), needed);
  hydrateBody(body, ambient);
  const item = person.technology.items.find(item => (item.contents?.water ?? 0) > 0);
  if (item && distance(person, point) === 0 && canHandleContainedWater(person, world.tick)) {
    const requested = Math.min(Math.max(0, Math.floor((needed - ambient) * WATER_QUANTA_PER_UNIT)), Math.floor(body.thirst / SED_POR_UNIDAD * WATER_QUANTA_PER_UNIT));
    const flow = flowQuantized({ sourceWater: item.contents!.water, destinationWater: 0, destinationCapacity: requested,
      requestedQuanta: requested, carryFreeQuanta: requested, elapsedTicks: 1, workAvailable: 1 });
    exertBody(body, { energy: flow.workSpent * WATER_WORK_ENERGY, fatigue: flow.workSpent * WATER_WORK_FATIGUE });
    hydrateBody(body, flow.movedQuanta / WATER_QUANTA_PER_UNIT);
  }
  return body;
}


// Internal consumers finish reading before the next call. The family forecast keeps its
// componentwise maximum in a separate object; the public API still returns an owned value.
export const needRatesScratch: BodyRates = { hunger: 0, thirst: 0, energy: 0.00007, stressEnergy: 0.00015, fatigue: 0 };

export function needRates(world: World, desert: boolean, exposed: boolean, physiology: ReturnType<typeof demographicTraits>, out: BodyRates = needRatesScratch): BodyRates {
  out.hunger = HAMBRE_POR_PASO * physiology.foodDemand;
  out.thirst = (SED_POR_PASO + (desert ? 0.0002 : 0)) * physiology.waterDemand;
  out.energy = 0.00007; out.stressEnergy = 0.00015;
  out.fatigue = 0.00009 + (world.weather === 'rain' && exposed ? 0.0001 : 0);
  return out;
}

export function bodilyNeedRates(world: World, tile: Tile, physiology: ReturnType<typeof demographicTraits>) {
  return { ...needRates(world, tile.biome === 'desert', tile.terrain !== 'shelter', physiology) };
}


export function localRestQuality(world: World, person: Person): number {
  const exposedQuality = world.weather === 'rain' ? 0.2 : 0.55;
  return world.shelterBenefitEnabled ? Math.max(facilityRestQuality(world, person), exposedQuality) : exposedQuality;
}


/** A local paid pause is useful only if its real recovery can enable handling within
 * the next decision interval. This predicts capacity, never hydration or new contents. */
export function canRecoverWaterHandling(world: World, person: Person, lookup?: TileLookup, fast?: ResidentFastAccess): boolean {
  const forecast = {
    id: person.id, x: person.x, y: person.y, hunger: person.hunger, thirst: person.thirst, fatigue: person.fatigue, energy: person.energy,
    materials: person.materials, skills: person.skills, technology: person.technology,
  };
  const quality = localRestQuality(world, person);
  const tileIn = lookup ?? tileLookup(world.tiles);
  const here = tileIn(person.x, person.y)!;
  const hereCell = soaCell(fast, person.x, person.y, here);
  const rates = needRates(world, tileIsDesert(here, hereCell, fast), tileIsExposed(here, hereCell, fast), demographicTraits(person.genome, paramsOf(world).cuerpo));
  for (let elapsed = 1; elapsed <= 30; elapsed++) {
    restBody(forecast, { fatigue: REST_FATIGUE_RATE, energy: REST_ENERGY_RATE }, quality);
    // The next choice happens after the following tick's basal needs, as in bodyAndAction.
    advanceNeeds(forecast, rates);
    if (canHandleContainedWater(forecast, world.tick + elapsed)) return true;
  }
  return false;
}


/** `world.people.find(p => p.id === id)` sin recorrer la población por cada vínculo (sprint noche-perf
 * 2026-09-22; la ley de cortejo lo hacía por vínculo, persona y decisión: O(P·B·P)). `world.people` sólo
 * cambia por `push` (nacimientos) o reasignación (muertes), así que el índice se invalida por identidad
 * y longitud, como `tileAt`; guarda la PRIMERA persona de cada id, como `find`. */
const peopleById = new WeakMap<Person[], { length: number; byId: Map<string, Person> }>();

export function personById(world: World, id: string): Person | undefined {
  let index = peopleById.get(world.people);
  if (!index || index.length !== world.people.length) {
    const byId = new Map<string, Person>();
    for (const person of world.people) if (!byId.has(person.id)) byId.set(person.id, person);
    index = { length: world.people.length, byId };
    peopleById.set(world.people, index);
  }
  return index.byId.get(id);
}


const placesById = new WeakMap<PlaceView[], { length: number; byId: Map<string, PlaceView> }>();

export function placeById(world: World, id: string): PlaceView | undefined {
  let index = placesById.get(world.places);
  if (!index || index.length !== world.places.length) {
    const byId = new Map<string, PlaceView>();
    for (const place of world.places) if (!byId.has(place.id)) byId.set(place.id, place);
    index = { length: world.places.length, byId };
    placesById.set(world.places, index);
  }
  return index.byId.get(id);
}

export function copyBody(from: BodyState, to: BodyState): BodyState {
  to.hunger = from.hunger; to.thirst = from.thirst; to.fatigue = from.fatigue; to.energy = from.energy;
  return to;
}
