/**
 * V22 — Isomorphic delta wire format for DVR tape chunks (`?encoding=delta`).
 * Shared between server (`TapeReader`) and browser (`DvrPlayer`) so 90-frame zoomed-out
 * chunks ship 1 base frame + 89 compact viewport-clipped deltas (~50x smaller than 90 full views).
 */
import type { Tile, WorldView } from './types.js';

export type TapeIdentified = { id: string };
export type TapePartialUpsert = { id: string; _p: 1; _u?: string[] } & Record<string, unknown>;
export type TapePatchEntry<T extends TapeIdentified> = T | TapePartialUpsert;

export interface TapeEntityPatch<T extends TapeIdentified> {
  upserts: TapePatchEntry<T>[];
  removed: string[];
  order?: string[];
}

export interface TapeObjectPatch {
  set: Record<string, unknown>;
  unset?: string[];
}

export interface TapeTechPatch {
  itemsPatch?: TapeEntityPatch<NonNullable<WorldView['technology']>['items'][number]>;
  recipesPatch?: TapeEntityPatch<NonNullable<WorldView['technology']>['recipes'][number]>;
  knowledge?: NonNullable<WorldView['technology']>['knowledge'];
  unsetKnowledge?: true;
  dynamics?: NonNullable<WorldView['technology']>['dynamics'];
  budgets?: NonNullable<WorldView['technology']>['budgets'];
}

export type TapeChunkEncoding = 'full' | 'delta';

type TapeHeaderFields = Partial<
  Omit<WorldView, 'tiles' | 'people' | 'animals' | 'structures' | 'events'>
>;

/** One incremental frame inside a `encoding: 'delta'` chunk response, already clipped to the request viewport. */
export type TapeClientDelta = TapeHeaderFields & {
  tick: number;
  sequence: number;
  day: number;
  phase: WorldView['phase'];
  weather: WorldView['weather'];
  unset?: string[];
  tilesPatch?: Tile[];
  removedTiles?: string[];
  peoplePatch?: TapeEntityPatch<WorldView['people'][number]>;
  animalsPatch?: TapeEntityPatch<NonNullable<WorldView['animals']>[number]>;
  structuresPatch?: TapeEntityPatch<NonNullable<WorldView['structures']>[number]>;
  placesPatch?: TapeEntityPatch<WorldView['places'][number]>;
  blueprintsPatch?: TapeEntityPatch<NonNullable<WorldView['blueprints']>[number]>;
  communitiesPatch?: TapeEntityPatch<NonNullable<WorldView['communities']>[number]>;
  techPatch?: TapeTechPatch;
  statsPatch?: TapeObjectPatch;
  newEvents?: WorldView['events'];
  eventOrder?: string[];
};

/** Pure entity-list patch application (does not mutate `current`). */
export function applyTapeEntityPatch<T extends TapeIdentified>(
  current: readonly T[],
  change: TapeEntityPatch<T>,
): T[] {
  const values = new Map<string, T>();
  for (let i = 0; i < current.length; i++) {
    const item = current[i]!;
    values.set(item.id, item);
  }
  for (let i = 0; i < change.removed.length; i++) values.delete(change.removed[i]!);
  for (let i = 0; i < change.upserts.length; i++) {
    const entry = change.upserts[i]!;
    if ('_p' in entry && entry._p === 1) {
      const prev = values.get(entry.id);
      const next = (prev ? { ...prev } : { id: entry.id }) as Record<string, unknown>;
      for (const [k, val] of Object.entries(entry)) {
        if (k === '_p' || k === '_u') continue;
        next[k] = val;
      }
      const unset = entry._u;
      if (unset) for (let j = 0; j < unset.length; j++) delete next[unset[j]!];
      values.set(entry.id, next as T);
    } else {
      values.set(entry.id, entry as T);
    }
  }
  if (change.order) {
    const ordered: T[] = [];
    for (let i = 0; i < change.order.length; i++) {
      const item = values.get(change.order[i]!);
      if (item !== undefined) ordered.push(item);
    }
    return ordered;
  }
  return [...values.values()];
}

/** Pure shallow object patch application (does not mutate `prev`). */
export function applyTapeObjectPatch<T extends Record<string, unknown>>(
  prev: T,
  change: TapeObjectPatch,
): T {
  const next: Record<string, unknown> = { ...prev, ...change.set };
  const unset = change.unset;
  if (unset) for (let i = 0; i < unset.length; i++) delete next[unset[i]!];
  return next as T;
}

/** Build a coordinate → index lookup for fast O(changedTiles) tile updates across sequential deltas. */
export function indexTiles(tiles: readonly Tile[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]!;
    map.set(`${t.x},${t.y}`, i);
  }
  return map;
}

/**
 * Purely apply one `TapeClientDelta` onto `prev` (without mutating `prev`), returning the new
 * `WorldView` plus the exact list of changed tiles so client caches ingest only modified cells.
 */
export function applyClientTapeDelta(
  prev: WorldView,
  delta: TapeClientDelta,
  tileIndex?: Map<string, number>,
): { frame: WorldView; changedTiles: Tile[] } {
  const {
    peoplePatch,
    animalsPatch,
    structuresPatch,
    placesPatch,
    blueprintsPatch,
    communitiesPatch,
    techPatch,
    statsPatch,
    tilesPatch,
    removedTiles,
    newEvents,
    eventOrder,
    unset,
    ...header
  } = delta;

  const next: WorldView = { ...prev, ...header };
  delete (next as unknown as Record<string, unknown>).seed;

  if (unset) {
    const rec = next as unknown as Record<string, unknown>;
    for (let i = 0; i < unset.length; i++) delete rec[unset[i]!];
  }

  if (peoplePatch) next.people = applyTapeEntityPatch(prev.people, peoplePatch);
  if (animalsPatch) next.animals = applyTapeEntityPatch(prev.animals ?? [], animalsPatch);
  if (structuresPatch) next.structures = applyTapeEntityPatch(prev.structures ?? [], structuresPatch);
  if (placesPatch) next.places = applyTapeEntityPatch(prev.places, placesPatch);
  if (blueprintsPatch) next.blueprints = applyTapeEntityPatch(prev.blueprints ?? [], blueprintsPatch);
  if (communitiesPatch) next.communities = applyTapeEntityPatch(prev.communities ?? [], communitiesPatch);

  if (techPatch && next.technology) {
    const tech = { ...next.technology };
    if (techPatch.itemsPatch) tech.items = applyTapeEntityPatch(tech.items, techPatch.itemsPatch);
    if (techPatch.recipesPatch) tech.recipes = applyTapeEntityPatch(tech.recipes, techPatch.recipesPatch);
    if (techPatch.knowledge !== undefined) tech.knowledge = techPatch.knowledge;
    else if (techPatch.unsetKnowledge) delete tech.knowledge;
    if (techPatch.dynamics !== undefined) tech.dynamics = techPatch.dynamics;
    if (techPatch.budgets !== undefined) tech.budgets = techPatch.budgets;
    next.technology = tech;
  }

  if (statsPatch && next.stats) {
    next.stats = applyTapeObjectPatch(
      next.stats as unknown as Record<string, unknown>,
      statsPatch,
    ) as unknown as WorldView['stats'];
  }

  if (newEvents?.length || eventOrder) {
    const events = new Map(prev.events.map(e => [e.id, e]));
    if (newEvents) for (const e of newEvents) events.set(e.id, e);
    if (eventOrder) {
      const ordered: WorldView['events'] = [];
      for (const id of eventOrder) {
        const ev = events.get(id);
        if (ev) ordered.push(ev);
      }
      next.events = ordered;
    } else {
      next.events = [...events.values()];
    }
  }

  const changedTiles = tilesPatch ?? [];
  if (changedTiles.length > 0 || (removedTiles && removedTiles.length > 0)) {
    const removedSet = removedTiles?.length ? new Set(removedTiles) : null;
    if (!removedSet && tileIndex) {
      const tiles = prev.tiles.slice();
      for (let i = 0; i < changedTiles.length; i++) {
        const t = changedTiles[i]!;
        const key = `${t.x},${t.y}`;
        const idx = tileIndex.get(key);
        if (idx !== undefined) tiles[idx] = t;
        else {
          tileIndex.set(key, tiles.length);
          tiles.push(t);
        }
      }
      next.tiles = tiles;
    } else {
      const map = new Map<string, Tile>();
      for (let i = 0; i < prev.tiles.length; i++) {
        const t = prev.tiles[i]!;
        const key = `${t.x},${t.y}`;
        if (!removedSet?.has(key)) map.set(key, t);
      }
      for (let i = 0; i < changedTiles.length; i++) {
        const t = changedTiles[i]!;
        map.set(`${t.x},${t.y}`, t);
      }
      next.tiles = [...map.values()];
      if (tileIndex) {
        tileIndex.clear();
        for (let i = 0; i < next.tiles.length; i++) {
          const t = next.tiles[i]!;
          tileIndex.set(`${t.x},${t.y}`, i);
        }
      }
    }
  } else {
    next.tiles = prev.tiles;
  }

  return { frame: next, changedTiles };
}
