/**
 * Contrato de la cinta de toda la vida del mundo (cinta-sonnet §2 con PLAN-V23 §1.2 y AJUSTES): grabación en 5
 * niveles de paso fijo, épocas que marcan lo huérfano tras un reinicio o una restauración, marcadores por perfil y
 * las rutas `/api/cinta/*`. Sustituye a `shared/tape.ts` (lo borra C3); `shared/tape-delta.ts` se conserva entero.
 * El tick es global (AJUSTES §2: relojes por región descartados), así que un corte no lleva relojes por región.
 */
import type { CampoSerie } from './fotograma.js';
import type { SustanciaVista } from './materia.js';
import type { TapeClientDelta } from './tape-delta.js';
import type { ChronicleEvent, Tile, WorldView } from './types.js';

/** L0 detalle · L1 sin telemetría · L2 fauna como densidad · L3 diario · L4 cada 10 días. */
export type Nivel = 0 | 1 | 2 | 3 | 4;

/** Usan: C1a (escritor y podador), C1b (lector), C2a (reproductor), C4 (calibración). */
export const CINTA = {
  pasos: [4, 32, 300, 2400, 24000],      // ticks entre fotogramas de cada nivel (L0 sube por cadencia si la cinta se atrasa)
  fpsNormal: 6,                          // fotogramas por segundo del nivel en curso a 1×
  velocidades: [0.5, 1, 2, 5, 10, 25],   // múltiplos de 1×
  topeBytes: 50e9,
  cuotas: [0.48, 0.24, 0.12, 0.08, 0.06], // fracción de topeBytes por nivel; el 2 % restante es margen
  maxFotogramas: 120,                    // por respuesta de /api/cinta/chunk
} as const;

/** Lo que el escritor recibe: lo construye `carta-tape` desde el Fotograma (M6, ola 2) o, en la ola 1, desde
 * `projectTapeFrame` (C1a). Lo consume el escritor (C1a). */
export interface Corte {
  seq: number;                           // monótono, uno por corte (no es un tick)
  epoca: number;
  t: number;                             // tick
  vista: WorldView;                      // proyección pública, sin campos privados
  tilesCambiadas: Tile[] | 'todas';      // desde el corte anterior; 'todas' solo tras abrir o bifurcar
  hitos: Hito[];                         // sin pérdida desde el corte anterior
  catalogo: EntradaCatalogo[];           // sustancias nuevas desde el corte anterior
  hz: number;
}

/** La crónica sin pérdida y las marcas de la propia cinta. Escribe: C1a. Leen: C1b, C2a. */
export type Hito = { t: number; importancia: number } & (
  | { tipo: 'suceso'; suceso: ChronicleEvent }
  | { tipo: 'bifurcacion'; bifurcacion: Bifurcacion }
  | { tipo: 'laguna'; laguna: Laguna }
);

/** Sustancia aparecida, para que el cliente la nombre sin conocer átomos (la cinta no graba átomos). */
export interface EntradaCatalogo { t: number; sustancia: SustanciaVista }

/** Lo que el servidor manda a la cinta antes del primer corte de cada época (tras `Motor.cargar`). Escribe: el
 * servidor (integrador, PS). Consume: C1a. Con tMundo < t1 de la cinta hay bifurcación; con tMundo > t1, laguna;
 * con otro instanciaId, la cinta entera se aparta como huérfana. */
export interface Apertura { instanciaId: string; epoca: number; tMundo: number; motivo: 'reinicio' | 'restauracion' }
/** Historia que el mundo olvidó: [desde, hasta] de la época anterior quedan huérfanos y son lo primero que se poda. */
export interface Bifurcacion { epoca: number; desde: number; hasta: number; motivo: Apertura['motivo'] }
export interface Laguna { t0: number; t1: number }

export type SeriePunto = { t: number } & Record<CampoSerie, number>;

export interface CintaMeta {
  version: 3;
  estado: 'ok' | 'error';                // la cinta nunca frena al motor: si falla, lo dice aquí
  epoca: number; t0: number; t1: number; hz: number; bytes: number; topeBytes: number;
  niveles: { nivel: Nivel; paso: number; t0: number; t1: number; bytes: number; fotogramas: number }[];
  bifurcaciones: Bifurcacion[];
  lagunas: Laguna[];
  serie: SeriePunto[];                   // decimada a ≤ 400 puntos en el rango pedido
}

/** `nivel: 'auto'` = el más fino con cobertura en t; x, y, w, h recortan a la cámara en el lector. */
export interface ChunkReq { t: number; n: number; nivel?: Nivel | 'auto'; epoca?: number; x?: number; y?: number; w?: number; h?: number }
export interface ChunkResp {
  nivel: Nivel; paso: number; epoca: number; t0: number; t1: number; hayMas: boolean;
  cambioDeNivelEn?: number;              // t donde termina el nivel servido
  baseFrame?: WorldView;                 // el fotograma clave más cercano ≤ t: el primer pintado
  deltas: TapeClientDelta[];
}

/** Dónde se quedó mirando un perfil de navegador (UUID en localStorage); se guardan los 5 últimos y fijan 14 días de L0. */
export interface Marcador { perfil: string; nombre?: string; epoca: number; t: number; nivel: Nivel; velocidad: number; en: number /* ms de pared */ }

/** Rutas de la cinta, con sesión como el resto de `/api/` (alias `/api/tape/*` hasta C3). Sirve: C1b (meta, chunk) y
 * C2a (`server/cinta/marcadores.ts`). Pide: C2a (reproductor y barra). */
export interface RutasCinta {
  'GET /api/cinta/meta': { consulta: { t0?: number; t1?: number }; respuesta: CintaMeta };
  'GET /api/cinta/chunk': { consulta: ChunkReq; respuesta: ChunkResp };
  'GET /api/cinta/marcador': { consulta: { perfil: string }; respuesta: Marcador[] };
  'PUT /api/cinta/marcador': { cuerpo: Marcador; respuesta: { ok: true } };
}
