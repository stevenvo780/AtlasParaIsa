import type { Invariante } from './invariantes.js';

const registro = new Map<string, Invariante>();
/** Devuelve el retiro del registro para módulos descargables y pruebas aisladas. */
export function registrar(invariante: Invariante): () => void {
  if (!invariante.id || registro.has(invariante.id) || !Number.isSafeInteger(invariante.cadaTicks) || invariante.cadaTicks < 1) {
    throw new Error(`Registro de invariante inválido o duplicado: ${invariante.id}`);
  }
  const entrada = Object.freeze({ ...invariante });
  registro.set(entrada.id, entrada);
  return () => { if (registro.get(entrada.id) === entrada) registro.delete(entrada.id); };
}
export function listaInvariantes(): readonly Invariante[] { return [...registro.values()]; }
export function invariantesRegistrados(): IterableIterator<Invariante> { return registro.values(); }
