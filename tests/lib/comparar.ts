/**
 * Comparaciones de mundos para las pruebas.
 *
 * - `sinUndefined`: copia profunda sin las claves de valor `undefined`. El motor deja `tile.species = undefined` y
 *   similares en lugar de borrar la clave (para que las teselas y las personas conserven su forma en V8), y un mundo
 *   leído de disco no trae esas claves: es el mismo mundo, así que las pruebas de persistencia lo comparan por contenido.
 * - `primeraDiferencia`: la primera diferencia entre dos valores, con tolerancia relativa para los números. Desde V23 la
 *   tarjeta compila con FMA (decisión del 24-nov: sin paridad de 0 ULP entre CPU y GPU) y un mundo que cayó a CPU a mitad
 *   de camino difiere del gemelo solo en el último dígito.
 */

import assert from 'node:assert/strict';

export function sinUndefined<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map(sinUndefined) as unknown as T;
  if (valor instanceof Map) return new Map([...valor].map(([k, v]) => [k, sinUndefined(v)])) as unknown as T;
  if (valor instanceof Set) return new Set([...valor].map(sinUndefined)) as unknown as T;
  if (valor && typeof valor === 'object' && Object.getPrototypeOf(valor) === Object.prototype) {
    const copia: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor)) if (v !== undefined) copia[clave] = sinUndefined(v);
    return copia as T;
  }
  return valor;
}

export function primeraDiferencia(a: unknown, b: unknown, tolerancia = 1e-9, ruta = '$'): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Object.is(a, b) || Math.abs(a - b) <= tolerancia * Math.max(1, Math.abs(a), Math.abs(b))) return null;
    return `${ruta}: ${a} ≠ ${b}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${ruta}: longitud o tipo`;
    for (let i = 0; i < a.length; i++) { const d = primeraDiferencia(a[i], b[i], tolerancia, `${ruta}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined);
    if (ka.length !== kb.length || ka.some(k => !kb.includes(k))) return `${ruta}: claves ${ka.join(',')} ≠ ${kb.join(',')}`;
    for (const k of ka) { const d = primeraDiferencia((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tolerancia, `${ruta}.${k}`); if (d) return d; }
    return null;
  }
  return Object.is(a, b) ? null : `${ruta}: ${String(a)} ≠ ${String(b)}`;
}

/** `assert.deepEqual` entre un mundo vivo y otro leído o reconstruido: las claves `undefined` cuentan como ausentes. */
export function igualesSinUndefined(real: unknown, esperado: unknown, mensaje?: string): void {
  assert.deepStrictEqual(sinUndefined(real), sinUndefined(esperado), mensaje);
}
