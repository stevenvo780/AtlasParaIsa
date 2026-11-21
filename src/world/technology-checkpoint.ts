import type { TechnologyCheckpoint, TechnologyKnowledge, TechnologyState } from '../shared/technology.js';
import { resolveTechnologyRecipe } from './technology-catalogue.js';
import { assertContainedWater, assertWaterLedger } from './technology-water.js';
import { POPULATION_HARD_LIMIT } from '../shared/life.js';

export interface TechnologyStockActor { id: string; technology: Pick<TechnologyKnowledge, 'items' | 'residue'>; }
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
/** `Object.keys` cuenta solo claves string propias y enumerables. Un material heredado sigue valiendo. */
function composition(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let keys = 0;
  for (const key in value) if (Object.hasOwn(value, key) && ++keys > 3) return false;
  if (keys !== 3) return false;
  const record = value as Record<string, unknown>;
  return integer(record.wood) && integer(record.stone) && integer(record.water);
}
/** Mismo orden que `localeCompare` en el alfabeto de los ids (`a-z`, dígitos, `-`). Fuera de él, la comparación del entorno. */
function idAlphabet(code: number): boolean {
  return code === 45 || (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}
function compareId(a: string, b: string): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    const left = a.charCodeAt(i), right = b.charCodeAt(i);
    if (!idAlphabet(left) || !idAlphabet(right)) return a.localeCompare(b);
    if (left !== right) return left - right;
  }
  const rest = a.length > b.length ? a : b;
  for (let i = n; i < rest.length; i++) if (!idAlphabet(rest.charCodeAt(i))) return a.localeCompare(b);
  return a.length - b.length;
}
/** `id === \`process-${serial}\`` sin construir la cadena. `process-01` y los espacios no coinciden con `process-1`. */
function sameProcessSerial(id: string, serial: number): boolean {
  if (!Number.isSafeInteger(serial) || serial < 0) return id === `process-${serial}`;
  let digits = 1;
  if (serial >= 10) { digits = 0; for (let n = serial; n > 0; n = Math.floor(n / 10)) digits++; }
  if (id.length !== 8 + digits) return false;
  if (id.charCodeAt(0) !== 112 || id.charCodeAt(1) !== 114 || id.charCodeAt(2) !== 111 || id.charCodeAt(3) !== 99
    || id.charCodeAt(4) !== 101 || id.charCodeAt(5) !== 115 || id.charCodeAt(6) !== 115 || id.charCodeAt(7) !== 45) return false;
  let value = 0;
  for (let i = 8; i < id.length; i++) {
    const digit = id.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    value = value * 10 + digit;
  }
  return value === serial;
}
/** `/^product-[1-9]\\d*$/` y `integer(Number(id.slice(8)), max)` sin regex ni copia del sufijo. */
function productSerial(id: string, max: number): boolean {
  if (id.length < 9) return false;
  if (id.charCodeAt(0) !== 112 || id.charCodeAt(1) !== 114 || id.charCodeAt(2) !== 111 || id.charCodeAt(3) !== 100
    || id.charCodeAt(4) !== 117 || id.charCodeAt(5) !== 99 || id.charCodeAt(6) !== 116 || id.charCodeAt(7) !== 45) return false;
  const first = id.charCodeAt(8);
  if (first < 49 || first > 57) return false;
  let value = first - 48;
  for (let i = 9; i < id.length; i++) {
    const digit = id.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    value = value * 10 + digit;
  }
  return integer(value, max);
}

/** Captures only technology matter, never raw inventories, decisions, or random state. */
export function captureTechnologyCheckpoint(state: TechnologyState, actors: readonly TechnologyStockActor[], tick: number,
  reason: TechnologyCheckpoint['reason']): TechnologyCheckpoint {
  return { version: 1, tick, executionCounter: state.executionCounter, reason,
    ...(state.water ? { water: { ...state.water } } : {}),
    inventories: actors.map(actor => ({ actorId: actor.id, residue: { ...actor.technology.residue },
      items: actor.technology.items.map(item => ({ id: item.id, recipeId: item.recipeId, mass: item.mass, composition: { ...item.composition }, ...(item.contents ? { contents: { ...item.contents } } : {}) }))
        .sort((a, b) => compareId(a.id, b.id)),
    })).sort((a, b) => compareId(a.actorId, b.actorId)) };
}

/** Shape/integrity of a historical opening, not a claim that subsequent flows close. */
/** Un inventario por habitante vivo: espeja el tope anticorrupción de `assertWorld` (ruling R17); antes 128, y 32 antes de T041. Ya no limita el mundo. */
const MAX_CHECKPOINT_INVENTORIES = POPULATION_HARD_LIMIT;

export function assertTechnologyCheckpoint(state: TechnologyState, tick: number): void {
  const checkpoint = state.checkpoint;
  if (checkpoint === undefined) return; // Legacy V5 is anchored explicitly by migrateWorld.
  const fail = (): never => { throw new Error('Invalid technology opening checkpoint.'); };
  if (!checkpoint || checkpoint.version !== 1 || !integer(checkpoint.tick, tick) || !integer(checkpoint.executionCounter, state.executionCounter) ||
    !['initial', 'migration', 'history-gap', 'roster-change'].includes(checkpoint.reason) ||
    !Array.isArray(checkpoint.inventories) || checkpoint.inventories.length > MAX_CHECKPOINT_INVENTORIES) fail();
  if (checkpoint.reason === 'initial' && (checkpoint.tick !== 0 || checkpoint.executionCounter !== 0)) fail();
  // A serial boundary must also be a whole-tick boundary. Otherwise a forged
  // earlier tick could hide executions included in the alleged opening stock.
  for (const event of state.history) {
    const serial = Number(event.id.slice(8));
    if (serial <= checkpoint.executionCounter ? event.tick > checkpoint.tick : event.tick <= checkpoint.tick) fail();
  }
  const actorIds = new Set<string>(), itemIds = new Set<string>();
  let contained = 0;
  // Sprint noche-perf2 2026-09-22: con ~230 habitantes cada rotación resolvía ~1 800 objetos, casi todos
  // de unas pocas decenas de recetas, y cada resolución fuera de la ventana va al archivo. Dentro de esta
  // validación nada cambia (resolver sin caché no toca el mundo), así que la respuesta por id es la misma
  // en cada objeto: se resuelve una vez por id y validación. Un id que falla sigue fallando en su primer uso.
  const existed = new Map<string, boolean>();
  const recipeExisted = (id: string): boolean => {
    let result = existed.get(id);
    if (result === undefined) {
      // Resolve the current record, then check only its immutable birth date. A checkpoint
      // is not a claim about recipe statistics at its historical opening tick.
      const recipe = resolveTechnologyRecipe({ technology: state, tick }, id, { cache: false });
      result = !!recipe && recipe.tick <= checkpoint.tick;
      existed.set(id, result);
    }
    return result;
  };
  for (const inventory of checkpoint.inventories) {
    if (!inventory || !identifier(inventory.actorId) || actorIds.has(inventory.actorId) || !composition(inventory.residue) ||
      !Array.isArray(inventory.items) || inventory.items.length > state.budgets.maxItems) fail();
    actorIds.add(inventory.actorId);
    for (const item of inventory.items) {
      if (!item) fail();
      const itemId = item.id;
      if (!identifier(itemId) || !productSerial(itemId, state.itemCounter) ||
        itemIds.has(itemId) || !(item.recipeId === null || recipeExisted(item.recipeId)) || !composition(item.composition) ||
        !integer(item.mass) || item.mass === 0 || item.mass !== item.composition.wood + item.composition.stone + item.composition.water) fail();
      itemIds.add(item.id);
      if (item.contents !== undefined) {
        if (!state.water) fail();
        assertContainedWater(item.contents, checkpoint.tick);
        contained += item.contents.water;
      }
    }
  }
  if (checkpoint.water !== undefined) {
    if (!state.water) fail();
    assertWaterLedger(checkpoint.water, contained);
  } else if (contained) fail();
}

/** Every serial after the checkpoint must still exist, in time and serial order. */
export function technologyHistoryGap(state: TechnologyState): boolean {
  const checkpoint = state.checkpoint;
  if (!checkpoint || state.historyDropped > checkpoint.executionCounter || state.historyDropped + state.history.length !== state.executionCounter) return true;
  let previous = state.historyDropped, previousTick = -1;
  for (const event of state.history) {
    if (!sameProcessSerial(event.id, previous + 1) || event.tick < previousTick) return true;
    previous++; previousTick = event.tick;
  }
  return previous !== state.executionCounter;
}

/** Compares ids by content, reading the elements in the order the legacy predicate did, so a
 * null or forged element fails with the same TypeError at the same point. Allocates nothing. */
function sameIds<T>(list: readonly T[], ids: readonly string[], key: (element: T) => string): boolean {
  if (list.length !== ids.length) return false;
  for (let n = 0; n < ids.length; n++) if (key(list[n]!) !== ids[n]) return false;
  return true;
}

// T143: último par (ids de actores, actorId de la apertura) para el que el padrón no había cambiado.
// El predicado sólo depende de esas dos secuencias, así que si ambas coinciden posición a posición el
// resultado es el mismo sin construir el Set: exacto por contenido, sobrevive a `cloneWorld` y a mundos
// intercalados (fallan y se recalcula). Sigue siendo O(P) comparaciones sin memoria nueva; bajar a O(1)
// exige una señal de altas y bajas desde el paso. La rotación (aserción + captura) es O(P) por definición.
let steady: { actors: string[]; inventories: string[] } | undefined;

/** Called only after the whole world tick, including all estates and births.
 * The new opening is prospective: it never verifies the interval that was lost. */
export function advanceTechnologyCheckpoint(state: TechnologyState, actors: readonly TechnologyStockActor[], tick: number): void {
  const checkpoint = state.checkpoint;
  if (checkpoint === undefined) { state.checkpoint = captureTechnologyCheckpoint(state, actors, tick, 'migration'); return; }
  let rosterChanged = false, unique = false;
  if (!steady || !sameIds(actors, steady.actors, actor => actor.id) || !sameIds(checkpoint.inventories, steady.inventories, inventory => inventory.actorId)) {
    const current = new Set<string>();
    for (let i = 0; i < actors.length; i++) current.add(actors[i]!.id);
    unique = current.size === actors.length;
    const inventories = checkpoint.inventories;
    rosterChanged = current.size !== inventories.length;
    if (!rosterChanged) for (let i = 0; i < inventories.length; i++) if (!current.has(inventories[i]!.actorId)) { rosterChanged = true; break; }
    if (!rosterChanged) steady = snapshotRoster(actors, inventories);
  }
  if (rosterChanged || technologyHistoryGap(state)) {
    assertTechnologyCheckpoint(state, tick); // Never normalize a malformed boundary by rotating it.
    state.checkpoint = captureTechnologyCheckpoint(state, actors, tick, rosterChanged ? 'roster-change' : 'history-gap');
    // Sin ids repetidos, la apertura recién capturada contiene exactamente el padrón: el tick siguiente no rota.
    if (rosterChanged && unique) steady = snapshotRoster(actors, state.checkpoint.inventories);
  }
}

function snapshotRoster(actors: readonly TechnologyStockActor[], inventories: readonly { actorId: string }[]): { actors: string[]; inventories: string[] } {
  const actorIds = new Array<string>(actors.length);
  for (let i = 0; i < actors.length; i++) actorIds[i] = actors[i]!.id;
  const inventoryIds = new Array<string>(inventories.length);
  for (let i = 0; i < inventories.length; i++) inventoryIds[i] = inventories[i]!.actorId;
  return { actors: actorIds, inventories: inventoryIds };
}
