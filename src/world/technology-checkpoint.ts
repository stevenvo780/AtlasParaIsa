import type { TechnologyCheckpoint, TechnologyKnowledge, TechnologyState } from '../shared/technology.js';
import { resolveTechnologyRecipe } from './technology-catalogue.js';
import { assertContainedWater, assertWaterLedger } from './technology-water.js';
import { POPULATION_HARD_LIMIT } from '../shared/life.js';

export interface TechnologyStockActor { id: string; technology: Pick<TechnologyKnowledge, 'items' | 'residue'>; }
const materials = ['wood', 'stone', 'water'] as const;
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
const composition = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === materials.length && materials.every(material => integer((value as Record<string, unknown>)[material]));

/** Captures only technology matter, never raw inventories, decisions, or random state. */
export function captureTechnologyCheckpoint(state: TechnologyState, actors: readonly TechnologyStockActor[], tick: number,
  reason: TechnologyCheckpoint['reason']): TechnologyCheckpoint {
  return { version: 1, tick, executionCounter: state.executionCounter, reason,
    ...(state.water ? { water: { ...state.water } } : {}),
    inventories: actors.map(actor => ({ actorId: actor.id, residue: { ...actor.technology.residue },
      items: actor.technology.items.map(item => ({ id: item.id, recipeId: item.recipeId, mass: item.mass, composition: { ...item.composition }, ...(item.contents ? { contents: { ...item.contents } } : {}) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    })).sort((a, b) => a.actorId.localeCompare(b.actorId)) };
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
      if (!item || !identifier(item.id) || !/^product-[1-9]\d*$/.test(item.id) || !integer(Number(item.id.slice(8)), state.itemCounter) ||
        itemIds.has(item.id) || !(item.recipeId === null || recipeExisted(item.recipeId)) || !composition(item.composition) ||
        !integer(item.mass) || item.mass === 0 || item.mass !== materials.reduce((total, material) => total + item.composition[material], 0)) fail();
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
    if (event.id !== `process-${previous + 1}` || event.tick < previousTick) return true;
    previous++; previousTick = event.tick;
  }
  return previous !== state.executionCounter;
}

/** Called only after the whole world tick, including all estates and births.
 * The new opening is prospective: it never verifies the interval that was lost. */
export function advanceTechnologyCheckpoint(state: TechnologyState, actors: readonly TechnologyStockActor[], tick: number): void {
  const checkpoint = state.checkpoint;
  if (checkpoint === undefined) { state.checkpoint = captureTechnologyCheckpoint(state, actors, tick, 'migration'); return; }
  const current = new Set(actors.map(actor => actor.id));
  const rosterChanged = current.size !== checkpoint.inventories.length || checkpoint.inventories.some(inventory => !current.has(inventory.actorId));
  if (rosterChanged || technologyHistoryGap(state)) {
    assertTechnologyCheckpoint(state, tick); // Never normalize a malformed boundary by rotating it.
    state.checkpoint = captureTechnologyCheckpoint(state, actors, tick, rosterChanged ? 'roster-change' : 'history-gap');
  }
}
