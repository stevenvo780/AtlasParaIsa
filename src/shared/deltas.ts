import type { PersonView, StateDelta, Tile, WorldView } from './types.js';

export const tileKey = (t: { x: number; y: number }): string => `${t.x},${t.y}`;

/** Un número no finito y `null` se serializan igual en JSON (`null`). */
const jsonNull = (v: unknown): boolean => v === null || (typeof v === 'number' && !Number.isFinite(v));

/** Igualdad estructural con la semántica de `JSON.stringify(a) === JSON.stringify(b)` (lo que de verdad
 * viaja por el cable) pero sin serializar: `undefined` en una propiedad equivale a ausente, `-0 === 0`,
 * el orden de las claves no importa. Las referencias iguales (el 99 % de los campos) salen en la primera línea. */
export function fastEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return jsonNull(a) && jsonNull(b);
  const aArray = Array.isArray(a);
  if (aArray !== Array.isArray(b)) return false;
  if (aArray) {
    const x = a as unknown[], y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      const p = x[i], q = y[i];
      if (p === q) continue;
      // En un arreglo `undefined` viaja como `null`.
      if (!fastEqual(p === undefined ? null : p, q === undefined ? null : q)) return false;
    }
    return true;
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  let definidas = 0;
  for (const k in x) {
    const p = x[k];
    if (p === undefined) continue;
    definidas++;
    const q = y[k];
    if (q === undefined || (p !== q && !fastEqual(p, q))) return false;
  }
  for (const k in y) if (y[k] !== undefined) definidas--;
  return definidas === 0;
}

/** Propiedades opcionales de `WorldView`: las únicas que un delta puede borrar (viajan como `null`).
 * El tipo obliga a mantener esta lista al día con `WorldView`. */
const OPCIONALES = ['paused', 'pauseReason', 'originX', 'originY', 'infinite', 'discoveredChunks', 'settlementCount', 'activeChunks',
  'stats', 'performance', 'communities', 'animals', 'blueprints', 'structures', 'technology', 'organization', 'geologyKey', 'chemistry', 'instanceId', 'regionesVivas', 'demography'] as const;
type ClavesOpcionales = { [K in keyof WorldView]-?: object extends Pick<WorldView, K> ? K : never }[keyof WorldView];
const exhaustivo: Exclude<ClavesOpcionales, (typeof OPCIONALES)[number]> extends never ? true : never = true;
void exhaustivo;
const OPCIONAL: ReadonlySet<string> = new Set(OPCIONALES);

/** Delta por campo entre dos vistas YA proyectadas (tras `r3`): nunca el `Tile` entero si
 * solo cambió un campo. Un campo presente antes y ausente ahora viaja como `null`. `worldPatch`
 * lleva `sequence` y solo las propiedades de nivel superior que cambiaron. */
export function computeStateDelta(prev: WorldView, next: WorldView): StateDelta {
  const prevTiles = new Map<string, Tile>();
  for (const t of prev.tiles) prevTiles.set(tileKey(t), t);
  const nextKeys = new Set<string>();
  const tileUpserts: Array<Partial<Tile> & { x: number; y: number }> = [];
  for (const tile of next.tiles) {
    const key = tileKey(tile); nextKeys.add(key);
    const before = prevTiles.get(key);
    if (!before) { tileUpserts.push({ ...tile }); continue; }
    if (before === tile) continue;
    const a = before as unknown as Record<string, unknown>, b = tile as unknown as Record<string, unknown>;
    let up: Record<string, unknown> | null = null;
    for (const field of Object.keys(b)) {
      if (field === 'x' || field === 'y') continue;
      const value = b[field];
      if (fastEqual(a[field], value)) continue;
      (up ??= { x: tile.x, y: tile.y })[field] = value === undefined ? null : value;
    }
    for (const field of Object.keys(a)) {
      if (field === 'x' || field === 'y' || a[field] === undefined || Object.hasOwn(b, field)) continue;
      (up ??= { x: tile.x, y: tile.y })[field] = null;
    }
    if (up) tileUpserts.push(up as Partial<Tile> & { x: number; y: number });
  }
  const tileRemovals: string[] = [];
  for (const [key] of prevTiles) if (!nextKeys.has(key)) tileRemovals.push(key);
  const prevPeople = new Map<string, PersonView>();
  for (const p of prev.people) prevPeople.set(p.id, p);
  const nextPeopleIds = new Set<string>();
  const peopleUpserts: PersonView[] = [];
  for (const p of next.people) {
    nextPeopleIds.add(p.id);
    const before = prevPeople.get(p.id);
    if (!before || !fastEqual(before, p)) peopleUpserts.push(p);
  }
  const peopleRemovals: string[] = [];
  for (const p of prev.people) if (!nextPeopleIds.has(p.id)) peopleRemovals.push(p.id);
  const a = prev as unknown as Record<string, unknown>, b = next as unknown as Record<string, unknown>;
  const worldPatch: Record<string, unknown> = { sequence: next.sequence };
  for (const k of Object.keys(b)) {
    if (k === 'tiles' || k === 'people' || k === 'sequence' || b[k] === undefined) continue;
    if (!fastEqual(a[k], b[k])) worldPatch[k] = b[k];
  }
  for (const k of Object.keys(a)) {
    if (a[k] !== undefined && b[k] === undefined && OPCIONAL.has(k)) worldPatch[k] = null;
  }
  return { type: 'state-delta', baseSequence: prev.sequence, sequence: next.sequence,
    tileUpserts, tileRemovals, peopleUpserts, peopleRemovals, worldPatch: worldPatch as Partial<WorldView> };
}

export function normalizeTileUpserts(upserts: StateDelta['tileUpserts']): Array<Partial<Tile> & { x: number; y: number }> {
  if (Array.isArray(upserts)) return upserts;
  return Object.entries(upserts).map(([key, value]) => {
    const [x, y] = key.split(',').map(Number);
    return { x: Number.isFinite(value.x) ? value.x! : x, y: Number.isFinite(value.y) ? value.y! : y, ...value } as Partial<Tile> & { x: number; y: number };
  });
}

const byRow = (a: { x: number; y: number }, b: { x: number; y: number }): number => a.y - b.y || a.x - b.x;
function ordenadas(tiles: readonly Tile[]): boolean {
  for (let i = 1; i < tiles.length; i++) if (byRow(tiles[i - 1]!, tiles[i]!) > 0) return false;
  return true;
}
function fusionar(a: readonly Tile[], b: readonly Tile[]): Tile[] {
  const out: Tile[] = new Array(a.length + b.length);
  let i = 0, j = 0, n = 0;
  while (i < a.length && j < b.length) out[n++] = byRow(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!;
  while (i < a.length) out[n++] = a[i++]!;
  while (j < b.length) out[n++] = b[j++]!;
  return out;
}
function aplicarCampos(into: Record<string, unknown>, up: Record<string, unknown>): void {
  for (const field in up) {
    const value = up[field];
    if (value === null) delete into[field]; else into[field] = value;
  }
}

/** Reconstruye el `WorldView` completo; las teselas quedan en orden de barrido (y,x) de
 * `projectTerrain` y las personas conservan su orden, con las nuevas al final. Las teselas que el
 * delta no toca se comparten con `base` (no se clonan); solo las modificadas son objetos nuevos. */
export function applyStateDelta(base: WorldView, delta: StateDelta): WorldView {
  let tiles = base.tiles;
  const upserts = normalizeTileUpserts(delta.tileUpserts);
  if (delta.tileRemovals.length || upserts.length) {
    const index = new Map<string, number>();
    for (let i = 0; i < tiles.length; i++) index.set(tileKey(tiles[i]!), i);
    const out: Array<Tile | null> = tiles.slice();
    for (const key of delta.tileRemovals) { const i = index.get(key); if (i !== undefined) out[i] = null; }
    const nuevas = new Map<string, Tile>();
    for (const up of upserts) {
      const key = tileKey(up), i = index.get(key);
      if (i !== undefined) {
        // Una tesela quitada y subida en el mismo delta se rehace desde cero, como siempre.
        const merged: Record<string, unknown> = { ...(out[i] ?? {}) };
        aplicarCampos(merged, up as Record<string, unknown>);
        merged.x = up.x; merged.y = up.y;
        out[i] = merged as unknown as Tile;
      } else {
        let merged = nuevas.get(key) as unknown as Record<string, unknown> | undefined;
        if (!merged) { merged = {}; nuevas.set(key, merged as unknown as Tile); }
        aplicarCampos(merged, up as Record<string, unknown>);
        merged.x = up.x; merged.y = up.y;
      }
    }
    const vivas = delta.tileRemovals.length ? out.filter((t): t is Tile => t !== null) : out as Tile[];
    if (nuevas.size) {
      const alta = [...nuevas.values()].sort(byRow);
      tiles = ordenadas(vivas) ? fusionar(vivas, alta) : [...vivas, ...alta].sort(byRow);
    } else tiles = ordenadas(vivas) ? vivas : vivas.sort(byRow);
  }
  let people = base.people;
  if (delta.peopleRemovals.length || delta.peopleUpserts.length) {
    const map = new Map(people.map(p => [p.id, p]));
    for (const id of delta.peopleRemovals) map.delete(id);
    for (const person of delta.peopleUpserts) map.set(person.id, person);
    people = [...map.values()];
  }
  const result = { ...base, tiles, people } as unknown as Record<string, unknown>;
  for (const k in delta.worldPatch) {
    if (k === 'tiles' || k === 'people') continue;
    const value = (delta.worldPatch as Record<string, unknown>)[k];
    if (value === null && OPCIONAL.has(k)) delete result[k]; else result[k] = value;
  }
  result.sequence = delta.sequence;
  return result as unknown as WorldView;
}
