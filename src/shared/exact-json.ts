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
/** Presupuesto del pre-escaneo (ms tras las primeras 512 visitas). Agotado, se serializa directamente
 * con el replacer: los bytes son idénticos por cualquiera de las dos vías, solo cambia quién paga el
 * recorrido extra. Medido (v18 ola 2): en árboles planos el pre-escaneo + nativo gana al replacer,
 * pero en árboles de teselas Proxy cada lectura del pre-escaneo es un trap y el replacer —que reusa
 * la única lectura del serializador— gana con claridad; un presupuesto de tiempo discrimina ambos
 * perfiles sin inspeccionar tipos, y de paso acota ciclos y DAGs compartidos antes de delegarlos en
 * el error nativo de `JSON.stringify`. */
const SCAN_BUDGET_MS = 8;
const SCAN_CHUNK = 512;
/** ¿Hace falta el replacer? Un `-0` está en el árbol, un `toJSON` podría producirlo, o el escaneo
 * agotó su presupuesto (falso positivo: cuesta tiempo, nunca cambia la salida; un falso negativo sí
 * la cambiaría). El recorrido es un SUPERCONJUNTO de lo que serializa `JSON.stringify` (`for…in`
 * visita las propias enumerables y además las heredadas), iterativo con pila explícita y con los
 * números —la inmensa mayoría de los nodos— examinados en línea (`v === 0 && 1 / v < 0` es
 * `Object.is(v, -0)`). */
function needsExactReplacer(value: unknown): boolean {
  if (typeof value === 'number') return Object.is(value, -0);
  if (typeof value !== 'object' || value === null) return false;
  const stack: object[] = [value];
  let visits = 0, started = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++visits === SCAN_CHUNK) started = performance.now();
    else if (started !== 0 && visits % SCAN_CHUNK === 0 && performance.now() - started > SCAN_BUDGET_MS) return true;
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
  if (!needsExactReplacer(value)) return JSON.stringify(value);
  return JSON.stringify(value, exactReplacer);
}
