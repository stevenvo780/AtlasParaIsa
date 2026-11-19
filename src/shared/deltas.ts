import type { PersonView, StateDelta, Tile, WorldView } from './types.js';

export const tileKey = (t: { x: number; y: number }): string => `${t.x},${t.y}`;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Delta por campo entre dos vistas YA proyectadas (tras `r3`): nunca el `Tile` entero si
 * solo cambió un campo. Un campo presente antes y ausente ahora viaja como `null`. */
export function computeStateDelta(prev: WorldView, next: WorldView): StateDelta {
  const prevTiles = new Map(prev.tiles.map(t => [tileKey(t), t]));
  const nextKeys = new Set<string>();
  const tileUpserts: Array<Partial<Tile> & { x: number; y: number }> = [];
  for (const tile of next.tiles) {
    const key = tileKey(tile); nextKeys.add(key);
    const before = prevTiles.get(key);
    if (!before) { tileUpserts.push({ ...tile }); continue; }
    const up: Record<string, unknown> = { x: tile.x, y: tile.y };
    let changed = false;
    for (const field of new Set([...Object.keys(before), ...Object.keys(tile)])) {
      if (field === 'x' || field === 'y') continue;
      const a = (before as unknown as Record<string, unknown>)[field];
      const b = (tile as unknown as Record<string, unknown>)[field];
      if (same(a, b)) continue;
      up[field] = b === undefined ? null : b; changed = true;
    }
    if (changed) tileUpserts.push(up as Partial<Tile> & { x: number; y: number });
  }
  const tileRemovals = prev.tiles.filter(t => !nextKeys.has(tileKey(t))).map(tileKey);
  const prevPeople = new Map(prev.people.map(p => [p.id, p]));
  const nextPeopleIds = new Set(next.people.map(p => p.id));
  const peopleUpserts: PersonView[] = next.people.filter(p => { const b = prevPeople.get(p.id); return !b || !same(b, p); });
  const peopleRemovals = prev.people.filter(p => !nextPeopleIds.has(p.id)).map(p => p.id);
  const { tiles: _t, people: _p, ...patch } = next;
  return { type: 'state-delta', baseSequence: prev.sequence, sequence: next.sequence,
    tileUpserts, tileRemovals, peopleUpserts, peopleRemovals, worldPatch: patch as Partial<WorldView> };
}

export function normalizeTileUpserts(upserts: StateDelta['tileUpserts']): Array<Partial<Tile> & { x: number; y: number }> {
  if (Array.isArray(upserts)) return upserts;
  return Object.entries(upserts).map(([key, value]) => {
    const [x, y] = key.split(',').map(Number);
    return { x: Number.isFinite(value.x) ? value.x! : x, y: Number.isFinite(value.y) ? value.y! : y, ...value } as Partial<Tile> & { x: number; y: number };
  });
}

/** Reconstruye el `WorldView` completo; las teselas quedan en orden de barrido (y,x) de
 * `projectTerrain` y las personas conservan su orden, con las nuevas al final. */
export function applyStateDelta(base: WorldView, delta: StateDelta): WorldView {
  const tiles = new Map(base.tiles.map(t => [tileKey(t), { ...t }]));
  for (const key of delta.tileRemovals) tiles.delete(key);
  for (const up of normalizeTileUpserts(delta.tileUpserts)) {
    const key = tileKey(up);
    const merged: Record<string, unknown> = { ...(tiles.get(key) ?? {}) };
    for (const [field, value] of Object.entries(up)) {
      if (value === null) delete merged[field]; else merged[field] = value;
    }
    merged.x = up.x; merged.y = up.y;
    tiles.set(key, merged as unknown as Tile);
  }
  const people = new Map(base.people.map(p => [p.id, p]));
  for (const id of delta.peopleRemovals) people.delete(id);
  for (const person of delta.peopleUpserts) people.set(person.id, person);
  const { tiles: _t, people: _p, ...patch } = delta.worldPatch as WorldView;
  return { ...base, ...patch, sequence: delta.sequence,
    tiles: [...tiles.values()].sort((a, b) => a.y - b.y || a.x - b.x), people: [...people.values()] };
}
