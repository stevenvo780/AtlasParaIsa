/**
 * Fotograma: lo visible del mundo tras el F6 de un tick, en binario (ARQ-motor §3.6, PLAN-V23 §1.2). Lo escriben
 * los dueños en paralelo en una ranura compartida, sin campos privados ni átomos; el hilo `carta-tape` lo convierte,
 * junto con los sucesos, en `Corte` (shared/cinta.ts) fuera del hilo de simulación. El motor nunca espera a quien
 * mira: sin crédito, salta. Todo el binario del fotograma y del enlace es little-endian (el de la torre).
 */
import type { BlueprintView, StructureView } from './life.js';
import type { SustanciaVista } from './materia.js';
import type { OrganizationSummary } from './organization.js';
import type { TechnologyView } from './technology.js';
import type { AnimalView, ChronicleEvent, CommunityView, MemoryView, PersonView, PlaceView, Tile, WorldView } from './types.js';
import type { DivineWhisper } from './worldmap.js';

export type TipoCampo = 'u8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64';
export const BYTES_CAMPO: Readonly<Record<TipoCampo, number>> = { u8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, f64: 8 };

/** Columna de una fila visible. Con `escala`, se guarda round(valor·escala) y se lee guardado/escala. */
export interface CampoVisible { nombre: string; tipo: TipoCampo; escala?: number }
/** Bytes por fila y desplazamiento de cada campo, en el orden del esquema. */
export interface Disposicion { ancho: number; desde: Readonly<Record<string, number>> }

/** Cada campo empieza en un múltiplo de su tamaño y la fila mide un múltiplo del campo mayor: con las filas desde un
 * desplazamiento múltiplo de 8, todo campo se lee con DataView o con una vista tipada del mismo tamaño. */
export function disposicion(esquema: readonly CampoVisible[]): Disposicion {
  const desde: Record<string, number> = {};
  let ancho = 0, mayor = 1;
  for (const campo of esquema) {
    const bytes = BYTES_CAMPO[campo.tipo];
    ancho = Math.ceil(ancho / bytes) * bytes;
    desde[campo.nombre] = ancho;
    ancho += bytes;
    mayor = Math.max(mayor, bytes);
  }
  return { ancho: Math.ceil(ancho / mayor) * mayor, desde };
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
  { nombre: 'escucha', tipo: 'u8', escala: 255 },
  { nombre: 'fatiga', tipo: 'f32' },
  { nombre: 'carga', tipo: 'f32' },       // kg
  { nombre: 'T', tipo: 'f32' },           // K
];

/** Celda visible: `Tile.mat` (3 sustancias y sus fracciones) y `Tile.T` (K). Mismas reglas de crecimiento que arriba. */
export const ESQUEMA_CELDA: readonly CampoVisible[] = [
  { nombre: 'mat0', tipo: 'u32' }, { nombre: 'mat1', tipo: 'u32' }, { nombre: 'mat2', tipo: 'u32' },
  { nombre: 'fr0', tipo: 'u8', escala: 255 }, { nombre: 'fr1', tipo: 'u8', escala: 255 }, { nombre: 'fr2', tipo: 'u8', escala: 255 },
  { nombre: 'T', tipo: 'f32' },
  { nombre: 'paved', tipo: 'f32' }, // calidad por dueño; NaN conserva el escalar, -1 es dato material desconocido
];

/** Serie de cada fotograma. Población, fauna y estructuras son del momento; nacimientos y muertes, acumulados desde que
 * abrió la época, para que saltar fotogramas no pierda nada; sustancias, las internadas hasta ahora. La cinta guarda una
 * fila cada `CINTA.seriePaso` ticks. Escribe: M6. Leen: C1a (tabla `serie`), C1b, C2a, V1. */
export const SERIE_CAMPOS = ['poblacion', 'nacimientos', 'muertes', 'fauna', 'estructuras', 'sustancias', 'hz'] as const;
export type CampoSerie = (typeof SERIE_CAMPOS)[number];

/** Estado visible tras el F6 del tick `tick`, leído de una ranura con `fotogramaDe`. Escribe: M6 (`motor/fotograma.ts`).
 * Lee: M6 (adaptador a `Corte`) en `carta-tape`. Los arrays son vistas de la ranura: valen hasta devolver su crédito. */
export interface Fotograma {
  tick: number;
  epoca: number;                         // la que abrió `Motor.cargar`
  completo: boolean;                     // todas las páginas y organismos (fotograma clave)
  saltados: number;                      // fotogramas que el motor no entregó desde el anterior, por falta de crédito
  n: number;
  organismos: Uint8Array;                // n filas de ESQUEMA_ORGANISMO
  paginas: Int32Array;                   // pares (px, py) de páginas 16×16 con cambio visible desde el último entregado
  celdas: Uint8Array;                    // por página, 256 celdas de ESQUEMA_CELDA en orden (y·16 + x)
  sucesos: [desde: number, hasta: number]; // bytes acumulados [desde, hasta) en el anillo de sucesos (misma unidad que sucesosEscritos/sucesosLeidos)
  serie: Float64Array;                   // SERIE_CAMPOS
  reparto: Int16Array | null;            // dueño de cada página de `paginas`; solo en fotogramas completos
}

// ── Sucesos: lo que cambia sin pérdida ───────────────────────────────────────────────────────────────────

/** Campos públicos de persona, fauna, página y mundo que no van en las columnas ni en los sucesos de texto (M6). */
export type VistaPersonaFotograma = Omit<PersonView,
  'name' | 'color' | 'reason' | 'need' | 'recentMemory' | 'specialty' | 'craftTint' | 'craftFocus' |
  'action' | 'x' | 'y' | 'energy' | 'hunger' | 'thirst' | 'health' | 'experiences' | 'trust'>;
export type VistaAnimalFotograma = Omit<AnimalView,
  'reason' | 'action' | 'x' | 'y' | 'energy' | 'hunger' | 'thirst' | 'health'>;
export type VistaPaginaFotograma = readonly Omit<Tile, 'x' | 'y' | 'mat' | 'T'>[];
export type VistaMundoFotograma = Omit<WorldView,
  'version' | 'sequence' | 'tick' | 'day' | 'phase' | 'weather' | 'tiles' | 'people' | 'animals' |
  'places' | 'events' | 'memories' | 'communities' | 'structures' | 'blueprints' | 'technology' |
  'organization' | 'whispers'>;

/** Vistas lentas que la cinta necesita para rehacer el `WorldView`: se mandan enteras al nacer o cambiar (null = baja).
 * Clima, tecnología y organización son únicos en el mundo (id ''). M6 puede añadir clases al final. */
export interface VistasLentas {
  lugar: PlaceView; comunidad: CommunityView; estructura: StructureView; plano: BlueprintView;
  recuerdo: MemoryView; tecnologia: TechnologyView; organizacion: OrganizationSummary;
  clima: WorldView['weather']; susurro: DivineWhisper;
  mundo: VistaMundoFotograma;
  cronicaVista: readonly ChronicleEvent[];
  persona: VistaPersonaFotograma;
  animal: VistaAnimalFotograma;
  pagina: VistaPaginaFotograma;
}
export type SucesoVista = { [K in keyof VistasLentas]: { tipo: K; id: string; vista: VistasLentas[K] | null } }[keyof VistasLentas];
/** Texto visible de un organismo (nombre, razón, necesidad, color, recentMemory…), solo al cambiar (null = borrado). */
export interface SucesoTexto { tipo: 'texto'; uid: number; campo: string; valor: string | null }
/** Lo que publican los dueños con `CtxDueno.publicar`. */
export type SucesoVisible = SucesoVista | SucesoTexto;
/** Registro sin pérdida: la crónica (`CtxDueno.suceso`), las sustancias que Q internó y lo visible. Lo junta el coordinador
 * en F0. Todo fotograma completo va precedido del estado lento entero (cada vista y cada texto vivos): con eso, quien
 * empieza a leer en una época nueva o tras pedir un completo rehace todo. */
export type Suceso = { tipo: 'cronica'; evento: ChronicleEvent } | { tipo: 'sustancia'; sustancia: SustanciaVista } | SucesoVisible;

// ── Enlace entre el motor y la cinta ─────────────────────────────────────────────────────────────────────

/**
 * Lo que cruza entre hilos (postMessage): solo SABs; cada lado arma sus vistas con `enlaceCinta`. Lo crea C1a con el
 * control (créditos = ranuras.length, cadencia = CINTA.pasos[0]) en la ola 1 y M6 le añade ranuras y sucesos en la 2.
 * - `control`: CONTROL_ENLACE_BYTES.
 * - `ranuras`: una por fotograma en vuelo, SAB crecible con la disposición de `regionesRanura`.
 * - `sucesos`: anillo de bytes de tamaño fijo (≤ 256 MiB: el único freno físico; no crece, porque las posiciones son
 *   módulo su longitud) con registros [u32 len LE][len bytes de v8.serialize(Suceso)],
 *   envueltos byte a byte módulo `sucesos.byteLength` (también la cabecera u32 si cae en el borde).
 */
export interface DescriptorEnlace {
  control: SharedArrayBuffer; ranuras: readonly SharedArrayBuffer[]; sucesos: SharedArrayBuffer | null;
  versiones?: SharedArrayBuffer;
}

/** Int32 [créditos, pedirCompleto, cadencia, —] y BigInt64 desde el byte 16 [entregados, sucesosEscritos, sucesosLeidos]. */
export const CONTROL_ENLACE_BYTES = 40;

/**
 * Protocolo. Motor: si `creditos[0] > 0`, resta uno y dimensiona la ranura `entregados % ranuras` con holgura; si en F6
 * un parto o activación superara `capOrganismos` o `capPaginas`, el dueño no escribe fuera de cota y el coordinador
 * aborta ese fotograma devolviendo el crédito y sumando 1 a `saltados`. Al acabar un fotograma válido,
 * `Atomics.add(entregados, 0, 1n)` y `Atomics.notify(entregados, 0)` (`entregados` es monótono entre épocas, nunca se
 * reinicia en `cargar`). Antes de publicar el fotograma escribe sus sucesos en el anillo (`sucesosEscritos`, en bytes) y
 * descarta el corte si no caben. Cinta: lee en orden la ranura `leidos % ranuras` mientras
 * `leidos < entregados`, lee antes los bytes del anillo hasta `BigInt(Fotograma.sucesos[1])`, sube `sucesosLeidos` con
 * `Atomics.store` + `Atomics.notify(sucesosLeidos, 0)` y, al soltar la ranura, `Atomics.add(creditos, 0, 1)`. Los contadores
 * BigInt64 no desbordan en la vida del mundo. `pedirCompleto[0] = 1` lo pone la cinta y lo baja el motor; `cadencia[0]`
 * son ticks entre fotogramas y la cinta lo sube si se atrasa.
 * Si el consumidor muere o el enlace queda inutilizable, el supervisor publica
 * Atomics.store(sucesosLeidos, 0, -1n) y Atomics.notify(sucesosLeidos, 0).
 * El productor comprueba -1n antes de reservar y publicar. Un enlace abandonado no se vuelve
 * a usar; el productor omite los fotogramas hasta que Motor.enlazar reciba uno nuevo.
 */
export interface EnlaceCinta {
  readonly ranuras: readonly SharedArrayBuffer[];
  readonly versiones?: Float64Array;
  readonly sucesos: Uint8Array | null;
  readonly creditos: Int32Array; readonly pedirCompleto: Int32Array; readonly cadencia: Int32Array;
  /** Palabra libre del control (bytes 12–15). Si el lote de sucesos de un fotograma no cabe en el anillo, el motor no
   * publica ni avanza `sucesosEscritos`: pone `saturado[0] = 1`, cuenta el salto y devuelve el crédito, sin esperar.
   * El supervisor (srv) la lee antes del siguiente paso, retira el enlace y abre otra época; el catálogo anota la laguna. */
  readonly saturado: Int32Array;
  readonly entregados: BigInt64Array; readonly sucesosEscritos: BigInt64Array; readonly sucesosLeidos: BigInt64Array;
}

export function enlaceCinta(d: DescriptorEnlace): EnlaceCinta {
  const i32 = (i: number) => new Int32Array(d.control, 4 * i, 1);
  const i64 = (i: number) => new BigInt64Array(d.control, 16 + 8 * i, 1);
  return {
    ranuras: d.ranuras, sucesos: d.sucesos && new Uint8Array(d.sucesos),
    versiones: d.versiones && new Float64Array(d.versiones),
    creditos: i32(0), pedirCompleto: i32(1), cadencia: i32(2), saturado: i32(3),
    entregados: i64(0), sucesosEscritos: i64(1), sucesosLeidos: i64(2),
  };
}

/** Cabecera de una ranura: Int32 en los bytes 0–31 (los dueños reservan filas y páginas con Atomics.add sobre `n` y
 * `paginas`; las capacidades las fija el coordinador en F0 al dimensionarla) y Float64 en los bytes 32–63. */
export const RANURA_I32 = { n: 0, paginas: 1, completo: 2, saltados: 3, capOrganismos: 4, capPaginas: 5 } as const;
export const RANURA_F64 = { tick: 4, epoca: 5, sucesosDesde: 6, sucesosHasta: 7 } as const;

const alinear8 = (bytes: number) => Math.ceil(bytes / 8) * 8;

/** Desplazamiento en bytes de cada región de una ranura con esas capacidades, en orden: serie, organismos, páginas,
 * celdas y reparto; `total` es lo que debe medir la ranura. */
export function regionesRanura(capOrganismos: number, capPaginas: number) {
  const serie = 64;
  const organismos = serie + 8 * SERIE_CAMPOS.length;
  const paginas = organismos + alinear8(capOrganismos * disposicion(ESQUEMA_ORGANISMO).ancho);
  const celdas = paginas + alinear8(capPaginas * 8);
  const reparto = celdas + alinear8(capPaginas * 256 * disposicion(ESQUEMA_CELDA).ancho);
  return { serie, organismos, paginas, celdas, reparto, total: reparto + alinear8(capPaginas * 2) };
}

/** Vista de lo publicado en una ranura. */
export function fotogramaDe(ranura: SharedArrayBuffer): Fotograma {
  const i32 = new Int32Array(ranura, 0, 8), f64 = new Float64Array(ranura, 0, 8);
  const n = i32[RANURA_I32.n]!, p = i32[RANURA_I32.paginas]!, completo = i32[RANURA_I32.completo] === 1;
  const r = regionesRanura(i32[RANURA_I32.capOrganismos]!, i32[RANURA_I32.capPaginas]!);
  return {
    tick: f64[RANURA_F64.tick]!, epoca: f64[RANURA_F64.epoca]!, completo, saltados: i32[RANURA_I32.saltados]!, n,
    organismos: new Uint8Array(ranura, r.organismos, n * disposicion(ESQUEMA_ORGANISMO).ancho),
    paginas: new Int32Array(ranura, r.paginas, 2 * p),
    celdas: new Uint8Array(ranura, r.celdas, p * 256 * disposicion(ESQUEMA_CELDA).ancho),
    sucesos: [f64[RANURA_F64.sucesosDesde]!, f64[RANURA_F64.sucesosHasta]!],
    serie: new Float64Array(ranura, r.serie, SERIE_CAMPOS.length),
    reparto: completo ? new Int16Array(ranura, r.reparto, p) : null,
  };
}
