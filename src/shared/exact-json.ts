// JSON's number grammar includes -0 and JSON.parse preserves its IEEE sign bit.
// The native stringifier alone emits +0. Keep the same JSON shape and ordinary
// bytes, replacing only that scalar with its exact JSON token.
// rawJSON ships in the minimum Node engine (22.22). Resolve it lazily: importing
// world modules for client constants must not require a browser JSON extension.
let negativeZero: unknown;
export function exactJsonNumber(value: unknown): unknown {
  if (typeof value !== 'number' || !Object.is(value, -0)) return value;
  if (negativeZero === undefined) {
    const rawJSON = (JSON as JSON & { rawJSON?: (text: string) => unknown }).rawJSON;
    if (typeof rawJSON !== 'function') throw new Error('Exact persistence requires JSON.rawJSON support (Node >=22.22).');
    negativeZero = rawJSON('-0');
  }
  return negativeZero;
}
/** Replacer de una sola pasada: solo el `-0` paga la llamada a `exactJsonNumber`. */
function exactReplacer(_key: string, current: unknown): unknown {
  return typeof current === 'number' && current === 0 && 1 / current < 0 ? exactJsonNumber(current) : current;
}
/** Enough for V18 metadata (~30 MB), while bounding speculative work on opaque
 * graphs. Exhaustion only selects the exact replacer; it never changes bytes. */
const SCAN_BUDGET_MS = 500;
const SCAN_CHUNK = 512;
// No static Node import: this shared module is also imported by the client.
// Proxies can return different values from their data descriptors and get trap.
const isProxy = typeof process === 'undefined' ? undefined : process.getBuiltinModule?.('node:util').types.isProxy;
const lookupGetter: (this: object, key: PropertyKey) => unknown =
  Object.getOwnPropertyDescriptor(Object.prototype, '__lookupGetter__')!.value;
/** Inspect accessors, never evaluate getters/toJSON speculatively: they
 * may mutate already scanned values or produce -0 on their next invocation.
 * Unusual prototypes, accessors and functions select the generic writer. Shared
 * data objects need inspecting only once; JSON.stringify owns cycle errors. */
function needsExactReplacer(value: unknown): boolean {
  if (typeof value === 'number') return Object.is(value, -0);
  if (typeof value === 'function' || typeof value === 'bigint') return true;
  if (typeof value !== 'object' || value === null) return false;
  if (!isProxy) return true;
  const stack: object[] = [value];
  // Only records with object children can form a cycle. Do not register the
  // hundreds of thousands of scalar-only metadata records/arrays in the Set.
  const seen = new Set<object>();
  const started = performance.now();
  let visits = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (isProxy(current)) return true;
    const array = Array.isArray(current), prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return true;
    if ('toJSON' in current) return true;
    let hasChildren = false;
    if (array) {
      const values = current as unknown[];
      for (let i = 0; i < values.length; i++) {
        if (++visits % SCAN_CHUNK === 0 && performance.now() - started > SCAN_BUDGET_MS) return true;
        // No descriptor allocation per scalar; also checks inherited array holes.
        if (lookupGetter.call(current, i) !== undefined) return true;
        const v = values[i];
        if (typeof v === 'number') { if (v === 0 && 1 / v < 0) return true; }
        else if (typeof v === 'object' && v !== null) {
          if (!hasChildren) {
            if (seen.has(current)) break;
            seen.add(current); hasChildren = true;
          }
          stack.push(v);
        }
        else if (typeof v === 'function' || typeof v === 'bigint') return true;
      }
    } else {
      const record = current as Record<string, unknown>;
      // Use V8's enumeration cache rather than allocating Object.keys for every
      // tiny record. Inherited enumerables are a safe superset of JSON's keys.
      for (const key in record) {
        if (++visits % SCAN_CHUNK === 0 && performance.now() - started > SCAN_BUDGET_MS) return true;
        if (lookupGetter.call(current, key) !== undefined) return true;
        const v = record[key];
        if (typeof v === 'number') { if (v === 0 && 1 / v < 0) return true; }
        else if (typeof v === 'object' && v !== null) {
          if (!hasChildren) {
            if (seen.has(current)) break;
            seen.add(current); hasChildren = true;
          }
          stack.push(v);
        }
        else if (typeof v === 'function' || typeof v === 'bigint') return true;
      }
    }
  }
  return false;
}
/** Preserve the original observable pre-scan for opaque values. In particular,
 * getters (including toJSON getters) historically run during this scan as well
 * as during JSON.stringify. The safe probe above must not change those reads,
 * their errors, or the values a stateful getter subsequently returns. */
function legacyNeedsExactReplacer(value: unknown): boolean {
  if (typeof value === 'number') return Object.is(value, -0);
  if (typeof value !== 'object' || value === null) return false;
  const stack: object[] = [value];
  let visits = 0, started = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++visits === SCAN_CHUNK) started = performance.now();
    else if (started !== 0 && visits % SCAN_CHUNK === 0 && performance.now() - started > 8) return true;
    if (typeof (current as { toJSON?: unknown }).toJSON === 'function') return true;
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        const v: unknown = current[i];
        if (typeof v === 'number') { if (v === 0 && 1 / v < 0) return true; }
        else if (typeof v === 'object' && v !== null) stack.push(v);
      }
    } else {
      const record = current as Record<string, unknown>;
      for (const key in record) {
        const v = record[key];
        if (typeof v === 'number') { if (v === 0 && 1 / v < 0) return true; }
        else if (typeof v === 'object' && v !== null) stack.push(v);
      }
    }
  }
  return false;
}
export function stringifyExact(value: unknown): string {
  if (!needsExactReplacer(value) || !legacyNeedsExactReplacer(value)) return JSON.stringify(value);
  return JSON.stringify(value, exactReplacer);
}
