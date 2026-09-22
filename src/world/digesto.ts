import { createHash } from 'node:crypto';
import type { World } from './index.js';
import { paramsOf } from './params.js';

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Sort records, never simulation slots or chronological/program arrays. */
function canonical(value: unknown): Canonical {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite canonical world value.');
    return value;
  }
  if (Array.isArray(value)) {
    // The live laws use find() and stable distance ties. Reordering even places
    // or tiles can change the next action; equal sets are not equal trajectories.
    return value.map(item => canonical(item));
  }
  if (typeof value !== 'object') throw new TypeError('Unsupported canonical world value.');
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => compareText(a, b)).map(([key, entry]) => [key, canonical(entry)]));
}

/** T101: full resident + pending dormant state, including effective laws and pending history.
 * External host capabilities cannot be serialized or inferred from resident state.
 * Persisted archive contents must be checked separately; a digest cannot read a host's disk.
 */
function canonicalWorld(world: World): Canonical {
  return canonical({ world, params: paramsOf(world) });
}

/** JSON.stringify collapses -0 into 0; a bit-level control must keep that sign. */
function canonicalJson(value: Canonical): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export function digestoCanonico(world: World): string {
  return createHash('sha256').update(canonicalJson(canonicalWorld(world))).digest('hex');
}

export interface CanonicalDifference { path: string; before: Canonical | undefined; after: Canonical | undefined; }
function firstDifference(a: Canonical | undefined, b: Canonical | undefined, path: string): CanonicalDifference | null {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return { path, before: a, after: b };
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = firstDifference(a[index], b[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  const left = a as Record<string, Canonical>, right = b as Record<string, Canonical>;
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compareText)) {
    const difference = firstDifference(left[key], right[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

export function diferenciaCanonica(a: World, b: World): CanonicalDifference | null {
  return firstDifference(canonicalWorld(a), canonicalWorld(b), '$');
}
