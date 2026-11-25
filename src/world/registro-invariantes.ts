import type { World } from './mundo/tipos.js';

export type Gravedad = 'dura' | 'blanda';
export interface RegionRef { chunkX: number; chunkY: number }
export interface Violacion {
  id: string; gravedad: Gravedad; tick: number; detalle: string;
  contexto?: Record<string, unknown>; region?: string;
  esperado?: number; observado?: number; muestra?: unknown;
}
export interface Invariante {
  id: string; carril: string; gravedad: Gravedad; cadaTicks: number;
  alcance: 'global' | 'region';
  /** Solo lectura. Sin `region` comprueba el mundo entero; con ella, solo esa región de CHUNK_SIZE². */
  comprobar(mundo: World, region?: RegionRef): Violacion[];
}

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
