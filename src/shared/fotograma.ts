/**
 * Fotograma: lo visible del mundo tras el F6 de un tick, en binario (ARQ-motor §3.6, PLAN-V23 §1.2). Lo escriben
 * los dueños en paralelo en una ranura compartida, sin campos privados ni átomos; el hilo `carta-tape` lo convierte
 * en `Corte` (shared/cinta.ts) fuera del hilo de simulación. El motor nunca espera a quien mira: sin crédito, salta.
 */

export type TipoCampo = 'u8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64';
export const BYTES_CAMPO: Readonly<Record<TipoCampo, number>> = { u8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, f64: 8 };

/** Columna de una fila visible. Con `escala`, se guarda round(valor·escala) y se lee guardado/escala. */
export interface CampoVisible { nombre: string; tipo: TipoCampo; escala?: number }
/** Bytes por fila y desplazamiento de cada campo, en el orden del esquema. */
export interface Disposicion { ancho: number; desde: Readonly<Record<string, number>> }

export function disposicion(esquema: readonly CampoVisible[]): Disposicion {
  const desde: Record<string, number> = {};
  let ancho = 0;
  for (const campo of esquema) { desde[campo.nombre] = ancho; ancho += BYTES_CAMPO[campo.tipo]; }
  return { ancho, desde };
}

/**
 * Fila visible de un organismo. Los esquemas solo crecen por el final: M6 añade lo que el adaptador necesite para
 * dar lo mismo que `projectTapeFrame`, e I4 retira lo heredado. Escribe: M6 (dueños en F6). Lee: M6 (`server/cinta/vista.ts`).
 */
export const ESQUEMA_ORGANISMO: readonly CampoVisible[] = [
  { nombre: 'uid', tipo: 'f64' },
  { nombre: 'clase', tipo: 'u8' },
  { nombre: 'x', tipo: 'f32' }, { nombre: 'y', tipo: 'f32' },
  { nombre: 'accion', tipo: 'u8' },
  { nombre: 'hambre', tipo: 'u8', escala: 255 }, { nombre: 'sed', tipo: 'u8', escala: 255 },
  { nombre: 'energia', tipo: 'u8', escala: 255 }, { nombre: 'salud', tipo: 'u8', escala: 255 },
  { nombre: 'masa', tipo: 'f32' },        // kg
  { nombre: 'forma', tipo: 'u32' },       // `codigoForma`
  { nombre: 'principal', tipo: 'u32' },   // SustanciaId de más masa
];

/** Celda visible: `Tile.mat` (3 sustancias y sus fracciones) y `Tile.T` (K). Mismas reglas de crecimiento que arriba. */
export const ESQUEMA_CELDA: readonly CampoVisible[] = [
  { nombre: 'mat0', tipo: 'u32' }, { nombre: 'mat1', tipo: 'u32' }, { nombre: 'mat2', tipo: 'u32' },
  { nombre: 'fr0', tipo: 'u8', escala: 255 }, { nombre: 'fr1', tipo: 'u8', escala: 255 }, { nombre: 'fr2', tipo: 'u8', escala: 255 },
  { nombre: 'T', tipo: 'f32' },
];

/** Serie que no se adelgaza nunca (una fila por fotograma). Escribe: M6. Leen: C1a (tabla `serie`), C1b, C2a, V1. */
export const SERIE_CAMPOS = ['poblacion', 'nacimientos', 'muertes', 'fauna', 'estructuras', 'sustancias', 'hz'] as const;
export type CampoSerie = (typeof SERIE_CAMPOS)[number];

/** Estado visible tras el F6 del tick `tick`. Escribe: M6 (`motor/fotograma.ts`). Lee: M6 (adaptador a `Corte`) en `carta-tape`. */
export interface Fotograma {
  tick: number;
  epoca: number;                         // la que abrió `Motor.cargar`
  completo: boolean;                     // todas las páginas y organismos (fotograma clave)
  saltados: number;                      // fotogramas que el motor no entregó desde el anterior, por falta de crédito
  n: number;
  organismos: Uint8Array;                // n filas de ESQUEMA_ORGANISMO
  paginas: Int32Array;                   // pares (px, py) de páginas 16×16 con cambio visible desde el último entregado
  celdas: Uint8Array;                    // por página, 256 celdas de ESQUEMA_CELDA en orden (y·16 + x)
  sucesos: [desde: number, hasta: number]; // rango [desde, hasta) del registro de sucesos sin pérdida
  serie: Float64Array;                   // SERIE_CAMPOS
  reparto: Int16Array | null;            // dueño de cada página de `paginas`; solo en fotogramas completos
}

/**
 * SAB compartido entre el motor y el hilo de la cinta (§1.2: créditos, `pedirCompleto` y la cadencia de la cinta).
 * Lo crea C1a (cadencia, ola 1) y lo completa M6 (ranuras, ola 2). Escribe fotogramas: M6. Los consume: `carta-tape`.
 */
export interface EnlaceCinta {
  readonly ranuras: number;
  readonly creditos: Int32Array;      // [0] ranuras libres: el motor resta al escribir y la cinta suma al soltar; con 0 el motor salta
  readonly entregados: Int32Array;    // [0] fotogramas entregados (Atomics.notify): la cinta lee la ranura leídos % ranuras, en orden
  readonly pedirCompleto: Int32Array; // [0] = 1: el siguiente fotograma es completo (lo pone la cinta, lo baja el motor)
  readonly cadencia: Int32Array;      // [0] ticks entre fotogramas: CINTA.pasos[0] en reposo; la cinta lo sube si se atrasa
  ranura(i: number): Fotograma;
}
