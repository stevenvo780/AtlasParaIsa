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

// Object.fromEntries (the original canonicalizer) enumerates array-index keys
// numerically before other sorted keys. Preserve those exact historical bytes.
function compareKeys(a: string, b: string): number {
  const index = (key: string): boolean => {
    const n = Number(key); return Number.isInteger(n) && n >= 0 && n < 0xffffffff && String(n) === key;
  };
  const ai = index(a), bi = index(b);
  return ai && bi ? Number(a) - Number(b) : ai ? -1 : bi ? 1 : compareText(a, b);
}

function emitCanonical(value: unknown, emit: (text: string) => void): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite canonical world value.');
    emit(Object.is(value, -0) ? '-0' : JSON.stringify(value)); return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { emit(JSON.stringify(value)); return; }
  if (Array.isArray(value)) {
    emit('[');
    for (let i = 0; i < value.length; i++) {
      if (i) emit(',');
      if (i in value) emitCanonical(value[i], emit);
    }
    emit(']'); return;
  }
  if (typeof value !== 'object') throw new TypeError('Unsupported canonical world value.');
  emit('{');
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => compareKeys(a, b));
  for (let i = 0; i < entries.length; i++) {
    if (i) emit(',');
    const [key, entry] = entries[i]!; emit(JSON.stringify(key)); emit(':'); emitCanonical(entry, emit);
  }
  emit('}');
}

export function digestoCanonico(world: World): string {
  const hash = createHash('sha256');
  let pieces: string[] = [], length = 0;
  const flush = () => { if (pieces.length) hash.update(pieces.join('')); pieces = []; length = 0; };
  emitCanonical({ world, params: paramsOf(world) }, text => {
    pieces.push(text); length += text.length;
    // No full-world copy or string: a large valid world can exceed V8's string limit.
    // Flush only between complete JSON tokens so UTF-16 pairs are never split.
    if (length >= 64 * 1024) flush();
  });
  flush(); return hash.digest('hex');
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
