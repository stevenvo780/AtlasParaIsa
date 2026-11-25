/**
 * INTERFAZ PUENTE de los marcadores de la cinta (carril cinta; cinta-sonnet §8 «Marcadores y perfil» y `RutasCinta`).
 * El esqueleto lo fijó la preparación de la oleada: cinta rellena los cuerpos y puede añadir exportaciones, pero no
 * cambia estas firmas (las consume srv al servir `/api/cinta/marcador`).
 */
import type { Marcador } from '../../shared/cinta.js';

const sinImplementar = (que: string): never => { throw new Error(`sin implementar: ${que}`); };

/** Marcadores por perfil de navegador, junto al catálogo de la cinta de un mundo. Guarda los 5 últimos de cada perfil. */
export interface MarcadoresCinta {
  leer(perfil: string): Marcador[];
  guardar(m: Marcador): void;
  /** Ticks de L0 que los marcadores vigentes piden conservar (el podador no los borra). */
  fijados(ahoraMs: number): { epoca: number; t0: number; t1: number }[];
  cerrar(): void;
}
export function abrirMarcadores(directorioCinta: string): MarcadoresCinta { return sinImplementar('cinta: abrirMarcadores'); }
/** Valida un cuerpo de `PUT /api/cinta/marcador`; lanza con un mensaje claro si no es un `Marcador`. */
export function leerMarcador(crudo: unknown): Marcador { return sinImplementar('cinta: leerMarcador'); }
