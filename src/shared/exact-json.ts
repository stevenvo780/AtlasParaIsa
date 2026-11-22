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
/** Un `-0` está en el árbol (o un `toJSON` que podría producirlo). Sólo decide si hace falta el replacer,
 * y el replacer da exactamente los mismos bytes que el serializador nativo salvo en ese escalar, así que
 * un falso positivo cuesta tiempo pero nunca cambia la salida; un falso negativo sí la cambiaría. Por eso
 * el recorrido es un SUPERCONJUNTO de lo que serializa `JSON.stringify` (`for…in` visita las propias
 * enumerables y además las heredadas) y evita una llamada por escalar: los números, la inmensa mayoría de
 * los nodos, se examinan en línea (`v === 0 && 1 / v < 0` es `Object.is(v, -0)`). */
function holdsNegativeZero(value: object): boolean {
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return true;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v: unknown = value[i];
      if (typeof v === 'number') { if (v === 0 && 1 / v < 0) return true; }
      else if (typeof v === 'object' && v !== null && holdsNegativeZero(v)) return true;
    }
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    const v = record[key];
    if (typeof v === 'number') { if (v === 0 && 1 / v < 0) return true; }
    else if (typeof v === 'object' && v !== null && holdsNegativeZero(v)) return true;
  }
  return false;
}
function needsExactReplacer(value: unknown): boolean {
  if (typeof value === 'number') return Object.is(value, -0);
  return typeof value === 'object' && value !== null && holdsNegativeZero(value);
}
export function stringifyExact(value: unknown): string {
  if (!needsExactReplacer(value)) return JSON.stringify(value);
  return JSON.stringify(value, (_key, current: unknown) => exactJsonNumber(current));
}
