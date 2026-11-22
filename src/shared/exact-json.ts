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
function needsExactReplacer(value: unknown): boolean {
  if (typeof value === 'number') return Object.is(value, -0);
  if (value === null || typeof value !== 'object') return false;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return true;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (needsExactReplacer(value[i])) return true;
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (Object.hasOwn(record, key) && needsExactReplacer(record[key])) return true;
  }
  return false;
}
export function stringifyExact(value: unknown): string {
  if (!needsExactReplacer(value)) return JSON.stringify(value);
  return JSON.stringify(value, (_key, current: unknown) => exactJsonNumber(current));
}
