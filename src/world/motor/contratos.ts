/**
 * Contratos del motor V23 (ARQ-motor §2), congelados en la ola 0 con la reconciliación de PLAN-V23 §1.2 y
 * AJUSTES-ORQUESTADOR aplicadas: un solo `Intento` (la materia viaja como pares [SustanciaId, cuantos]), sin
 * protocolo de cría (la pareja aporta su genoma por las columnas `genoma` y `pareja` del frente), un solo `Libro`
 * (el de la materia), `decisionGpu: 'siempre'`, canal con la GPU por memoria compartida, tick global y un modo
 * de un solo dueño con semilla que reproduce. Cambiar un contrato pasa por el integrador.
 *
 * Fases de un tick: F0 coordinador · F1 adoptar y vaciar B · F2 percibir (cualquier hilo o GPU) · F3 elegir ·
 * F4 actuar · F5 aplicar intentos · F6 publicar. Un chunk es una página 16×16 de la arena.
 */
import type { EnlaceCinta } from '../../shared/fotograma.js';
import type { ChronicleEvent, CommunityView, Gesture, GestureResult, PlaceView } from '../../shared/types.js';
import type { World, Person } from '../index.js';
import type { ArenaMateria, Libro, MateriaCheckpoint, ServicioQuimico, VistaCuerpo } from '../materia/tipos.js';

// ── Identidades ──────────────────────────────────────────────────────────────────────────────────────────

/** Fila estable de por vida de un organismo en la tabla. */
export type Slot = number;
/** gen·2³² + slot (gen < 2²¹: cabe exacta en un double). Caduca cuando la fila cambia de generación. */
export type Ref = number;
/** Hilo dueño; 0 = coordinador, que además es dueño 0. */
export type Hilo = number;
/** Ranura de una página 16×16 de la arena: cada chunk es una página. */
export type ChunkId = number;

/** Destino o referencia ausente: «a» de un intento sobre una celda, `CtxLectura.ref` de un uid que no vive. */
export const REF_NULA = -1;
export const refDe = (s: Slot, gen: number): Ref => gen * 4294967296 + s;
export const slotDe = (r: Ref): Slot => r % 4294967296;
export const genDe = (r: Ref): number => Math.floor(r / 4294967296);

/** Clase de organismo en la columna `clase` (la de las sustancias es `ClaseSustancia`). */
export const Clase = { Persona: 1, Animal: 2 } as const;
export type Clase = (typeof Clase)[keyof typeof Clase];

// ── Tabla de organismos y frente público ─────────────────────────────────────────────────────────────────

/** Columna de solo lectura: TS rechaza `c[i] = v`. Una columna de ancho w guarda c[slot·w + i]. En modo verificar,
 * el frente leído se sella con CRC32 por tick (I-F). */
export interface Col { readonly [i: number]: number; readonly length: number }

/** Alelos por slot en `genoma`: 8 loci diploides (el 8.º, escucha, lo añade E; hasta entonces van a 0). */
export const GENOMA_ANCHO = 16;
/** Fenotipo por slot en `rasgos` (media de los dos alelos de cada locus): entrada de W·rasgos. */
export const RASGOS_ANCHO = 8;
/** Posición de cada campo de `VistaCuerpo` dentro de la columna `cuerpo`. */
export const CAMPOS_CUERPO = { hambre: 0, sed: 1, energia: 2, salud: 3, masa: 4, carga: 5, T: 6 } as const satisfies Record<keyof VistaCuerpo, number>;
export const CUERPO_ANCHO = 7;

/**
 * Estado público tras el tick `tick`, inmutable durante el siguiente (doble búfer): una tabla para personas y fauna.
 * Sin columna de especie (decisión 9): mientras la fauna la necesite, M2a la registra con `columna` y F la quita.
 * Implementa: M2a (`soa/organismos.ts`). Consumen: M2b y M3 (percepción), M4a, M4b, M5, M6, N, F, B.
 */
export interface FrentePublico {
  readonly tick: number;
  readonly alta: number;                 // filas reservadas: los slots válidos son < alta
  readonly columnas: readonly string[];  // nombres por índice (las fijas y luego las registradas): así las citan las consultas
  readonly gen: Col; readonly vivo: Col; readonly clase: Col;
  readonly uid: Col;                     // identidad durable (f64), nunca reutilizada
  readonly dueno: Col;                   // hilo que tiene al organismo durante el tick siguiente
  readonly x: Col; readonly y: Col; readonly chunk: Col;
  readonly accion: Col;                  // índice en la lista de acciones de su clase
  readonly objetivo: Col;                // celda objetivo (`Terreno.celda`); −1 si no tiene
  readonly decideEn: Col;                // tick de su próxima decisión: vencido si ≤ tick
  readonly cuerpo: Col;                  // CUERPO_ANCHO f32, en el orden de CAMPOS_CUERPO
  readonly rasgos: Col;                  // RASGOS_ANCHO f32
  readonly genoma: Col;                  // GENOMA_ANCHO f32: la pareja lo aporta al concebir
  readonly pareja: Col;                  // uid de su mejor vínculo fértil (−1 si no tiene): hace de consentimiento
  col(nombre: string): Col;              // columnas registradas por los demás carriles
}

/** Frente t+1: un dueño solo toca filas con dueno == hilo, en F6. Implementa: M2a. Consumen: M4a, M4b, N, F, B. */
export interface FrenteEscritura {
  fila(slot: Slot): void;                // sella escritoPor[slot] = hilo (se comprueba en modo verificar)
  f32(nombre: string): Float32Array; f64(nombre: string): Float64Array; i32(nombre: string): Int32Array;
  u16(nombre: string): Uint16Array; u8(nombre: string): Uint8Array;
}

export type TipoColumna = 'f32' | 'f64' | 'i32' | 'u16' | 'u8';

/** Implementa: M2a (`soa/organismos.ts`). Consumen: M2b, M4a, M4b, N, F. */
export interface TablaOrganismos {
  columna(nombre: string, tipo: TipoColumna, ancho: number): void; // antes de arrancar
  lectura(): FrentePublico;
  escritura(h: Hilo): FrenteEscritura;
  alta(h: Hilo, c: Clase): Ref;          // slot libre tras 2 ticks de cuarentena; gen nueva
  baja(h: Hilo, r: Ref): void;           // gen++ y vivo = 0 en el frente t+1
}

// ── Terreno ──────────────────────────────────────────────────────────────────────────────────────────────

/** Celdas en la arena de páginas 16×16 (SAB crecible: las vistas siguen su longitud). La arena crece solo en F0.
 * Implementa: M1 (`soa/{arena,terreno}.ts`). Consumen: M2b, M3, M4a, M4b, M5, W. */
export interface Terreno {
  readonly versionPagina: Uint32Array;   // por chunk; la sube el dueño y la GPU solo sube lo que cambió
  readonly duenoChunk: Int16Array;       // vigente durante el tick; lo cambia el coordinador en F0
  readonly campos: readonly string[];    // nombres por índice: así los citan las consultas
  celda(x: number, y: number): number;   // −1 si no residente
  chunkDe(celda: number): ChunkId;
  campo(nombre: string): Col;
}
export interface TerrenoDueno extends Terreno {
  escribible(nombre: string, c: ChunkId): Float64Array | Float32Array | Int32Array | Uint8Array; // verifica dueño en modo verificar
  marcar(c: ChunkId, visible: boolean): void; // versión++ y, si visible, bit para el fotograma
}

// ── Intentos ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un actor escribe directo solo su propio estado y las celdas del chunk donde empezó el tick. Todo lo demás, otros
 * organismos del mismo chunk incluidos, es un intento al buzón de su dueño aunque lo tenga el mismo hilo: el dueño lo
 * aplica contra su estado actual en F5 (la regla depende del chunk, nunca del hilo). Lo que va en `dato` por tipo:
 * - Tomar: `DATO_TOMAR`; siempre se contesta con Concedido (con lo que hubo, quizá nada).
 * - Depositar, Dar, Concedido, Devuelto: llevan `materia`; dato[0] = Rol del lote que la recibe (null: Suelo).
 * - Golpear: `DATO_GOLPEAR`. Vincular: dato[0] = cuánto sube el vínculo del receptor hacia el emisor.
 * - Ensenar, Migrante, Gesto, Global: `bytes` (v8.serialize). Activar: dato = [cx, cy] del chunk nuevo.
 * Las respuestas llevan el nonce del intento que contestan. Toda garantía termina en ≤ 2 ticks (I-B).
 */
export const TipoIntento = {
  Tomar: 1, Depositar: 2, Dar: 3, Golpear: 4, Vincular: 5, Ensenar: 6, // sobre otro organismo o celda de otro chunk
  Concedido: 7, Devuelto: 8,                                           // respuestas que llevan garantía
  Migrante: 9, Gesto: 10, Activar: 11, Global: 12,                     // motor: migración, gesto, chunk nuevo, coordinador
} as const;
export type TipoIntento = (typeof TipoIntento)[keyof typeof TipoIntento];

/** Producen: M4b, M5, W, N, F, T1, S y E. Aplica: M5 (`motor/aplicar.ts`) en el dueño destino. */
export interface Intento {
  tipo: TipoIntento;
  de: Ref;
  a: Ref;                        // REF_NULA si el destino es una celda
  celda: number;                 // `Terreno.celda`; −1 si no aplica
  nonce: number;                 // slot(de)·2²⁰ + contador propio: repetir no duplica efectos
  materia: Float64Array | null;  // garantía ya debitada del emisor: pares [SustanciaId, cuantos]; [0, j] = j J de calor
  dato: Float64Array | null;
  bytes: Uint8Array | null;
}

/** Posiciones en `dato` de un Tomar: qué lote del destino (Rol), qué `Parte`, de qué sustancia, cuántos cuantos,
 * en qué lote propio se abonará (eco en el Concedido) y, solo con Parte.Digerible, los 3 κ del comedor. */
export const DATO_TOMAR = { rol: 0, parte: 1, esp: 2, cuantos: 3, rolDestino: 4, kappa: 5 } as const;
/** Posiciones en `dato` de un Golpear: el trabajo en J y lo que la ley de romper necesita del útil o cuerpo que golpea. */
export const DATO_GOLPEAR = { trabajo: 0, filo: 1, tenacidad: 2, esbeltez: 3, dureza: 4 } as const;

/** MPSC sobre SAB crecible. Implementa: M1 (`motor/buzon.ts`). Consumen: M4a, M4b, M5, W, N, F, S, E, T1. */
export interface Buzon {
  enviar(destino: Hilo, i: Intento): void; // Atomics.add reserva sitio; el SAB crece sin copiar
  vaciar(f: (i: Intento) => void): number; // solo el dueño, en su fase; orden barajado con su azar
}

// ── Globales ─────────────────────────────────────────────────────────────────────────────────────────────

/** Registro abierto direccionado por contenido (recetas, planos, plantillas): id = hash64 de los bytes canónicos,
 * idempotente desde cualquier hilo (CAS). Se guarda como hexadecimal de 16 cifras. Implementa: M1. Consumen: T1, T2, L, M4a. */
export interface Registro {
  insertar(canonico: Uint8Array): bigint;
  leer(id: bigint): Uint8Array | undefined;
}

/** Réplica de solo lectura por hilo; la cambia el coordinador en F0 por peticiones. Implementa: M2b (T=1), M4a. Consumen: M2b, S, T1, T2. */
export interface Globales {
  lugares: ReadonlyMap<string, PlaceView>;
  comunidades: ReadonlyMap<string, CommunityView>;
  registro: Registro;
  version: number;
}

// ── Contextos ────────────────────────────────────────────────────────────────────────────────────────────

/** F2, cualquier hilo. Implementa: M2b (T=1, ola 1) y M4a (dueños, ola 2). Consumen: M2b, M2a, M3 y las leyes. */
export interface CtxLectura {
  readonly tick: number;
  readonly frente: FrentePublico;
  readonly terreno: Terreno;
  readonly ref: (uid: number) => Ref;    // REF_NULA si no vive
  readonly globales: Globales;
}

/** F1 y F3–F6, solo el dueño. Implementa: M2b (T=1) y M4a. Consumen: S, E, M4b, M5 y las leyes que no tocan materia. */
export interface CtxDueno extends CtxLectura {
  readonly hilo: Hilo;
  readonly chunks: Int32Array;           // chunks de este hilo durante el tick
  readonly personas: ReadonlyMap<Slot, Person>;
  readonly propio: TerrenoDueno;
  readonly escritura: FrenteEscritura;
  readonly buzon: Buzon;
  readonly libro: Libro;                 // el del hilo: el único `Libro` (materia/tipos.ts)
  azar(): number;                        // del hilo; sembrado de MotorConfig.semilla o de entropía real
  id(tipo: 'uid' | 'suceso' | 'comunidad' | 'estructura'): number; // único, sin orden
  suceso(e: Omit<ChronicleEvent, 'id' | 'tick'>): string;
  pedirGlobal(tipo: 'lugar' | 'comunidad', datos: Uint8Array): void; // lo aplica F0 de t+1
}

/** El contexto del dueño cuando la materia ya está en el mundo (ola 2). Implementa: M4a. Consumen: M5, W, B, N, F, T1, T2. */
export interface CtxMateria extends CtxDueno {
  readonly materia: ArenaMateria;
  readonly quimica: ServicioQuimico;
}

// ── Percepción ───────────────────────────────────────────────────────────────────────────────────────────

/** Mejor celda alcanzable: minimiza Σ w·campo + pesoDist·dist + pesoPasos·pasos en la ventana BFS r = 7.
 * `campos` son índices de `Terreno.campos`; `filtros`, tripletas [campo, mínimo, máximo] que la celda debe cumplir. */
export interface Consulta {
  campos: Int32Array; pesos: Float32Array; pesoDist: number; pesoPasos: number;
  filtros: Float32Array; alcanzable: boolean;
}
/** Organismo en `radio`: el más cercano (criterio 0) o el de mayor valor en la columna `columna` (criterio 1);
 * `filtros` son tripletas [columna, mínimo, máximo] sobre `FrentePublico.columnas`. */
export interface ConsultaOrganismo { radio: number; clase: Clase; filtros: Float32Array; criterio: 0 | 1; columna: number }
/** Lo que un actor necesita percibir para decidir. Los definen M2b (`decision/planes.ts`) y M2a (fauna); los ejecutan M2b (CPU) y M3 (GPU). */
export interface Plan { id: number; celdas: readonly Consulta[]; organismos: readonly ConsultaOrganismo[]; acciones: number }
/** Vencidos de un tick que van a un mismo percibidor (lotes de 64 slots en CPU, miles en GPU). */
export interface LotePercepcion { tick: number; slots: Int32Array; plan: Uint16Array }
/** Alineada con `slots`: N×Q celdas, pasos y valores, N×V organismos (Ref) y N×A utilidades; Q, V y A son los máximos
 * de los planes del lote y lo que sobra queda a −1. */
export interface Percepcion { celda: Int32Array; pasos: Int16Array; valor: Float32Array; organismo: Float64Array; utilidad: Float32Array }

export type Dispositivo = 'cpu' | `gpu${number}`;

/** Implementan: M2b (CPU, `decision/percepcion.ts`) y M3 (GPU, `gpu/percibir-gpu.ts`). Consumen: M2b (T=1) y M4a. */
export interface Percibidor {
  readonly dispositivo: Dispositivo;
  lanzar(l: LotePercepcion, planes: readonly Plan[]): void;
  esperar(plazoMs: number): Percepcion;  // ErrorDispositivo si vence el plazo o falla
}

/** Plazo vencido o tarjeta caída: quien lo captura recalcula ese lote en CPU en el mismo tick (la GPU nunca es autoridad).
 * Lanzan: M3 (Percibidor, CanalGpu) y G. Capturan: M2b, M4a, W. */
export class ErrorDispositivo extends Error {
  readonly dispositivo: Dispositivo;
  constructor(dispositivo: Dispositivo, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorDispositivo';
    this.dispositivo = dispositivo;
  }
}

/**
 * Canal con el servidor de una tarjeta. Los datos van por un fichero de /dev/shm abierto por ambos lados; la tubería
 * solo lleva órdenes y respuestas de pocos bytes (AJUSTES §2: por tubería, 1 M de agentes costaba 1,3 s con un kernel de 6 ms).
 * Implementa: M3 (`gpu/canal.ts`). Consumen: M3 (`percibir-gpu.ts`) y G (`materia-gpu.ts`).
 */
export interface CanalGpu {
  readonly dispositivo: number;          // índice CUDA
  readonly bytes: number;                // tamaño de la zona compartida
  crecer(bytes: number): void;
  escribir(desde: number, datos: ArrayBufferView): void;
  leer(desde: number, destino: ArrayBufferView): void;
  pedir(orden: Uint8Array, plazoMs: number): Uint8Array; // ErrorDispositivo si vence el plazo o cae el servidor
  cerrar(): void;
}

// ── Motor ────────────────────────────────────────────────────────────────────────────────────────────────

/** Un tick coherente reunido en una barrera para `Store.save`: el mundo y su materia en la misma operación (§1.2).
 * `materia` es null hasta que W conecte la materia al mundo (ola 2). El `World` lleva arrays normales, nunca un SAB. */
export interface Instantanea { world: World; materia: MateriaCheckpoint | null }

/** Implementa: M4a (`motor/coordinador.ts`; en la ola 1, M2b como fachada de `stepWorld` con T=1).
 * Consumen: el servidor (`sim-worker`, `app`) vía el integrador, M6 y PS. */
export interface Motor {
  paso(gestos: readonly Gesture[]): { tick: number; resultados: GestureResult[] };
  instantanea(): Instantanea;
  cargar(i: Instantanea, epoca: number): void; // reparte tras Store.load o una recuperación y abre la época
  enlazar(cinta: EnlaceCinta): void;     // desde entonces entrega un fotograma cada `cadencia` ticks si hay crédito
  detalle(uid: number): Promise<Person | null>; // inspector: lo serializa el dueño en el F1 siguiente
  telemetria(): TelemetriaMotor;
  cerrar(): Promise<void>;
}

/** Implementan: M4a y M7. Consumen: V1 (panel «Motor»), 0C (diagnóstico), M8 (banco). */
export interface TelemetriaMotor {
  tick: number; hz: number; diasPorMinuto: number; hilos: number; desequilibrio: number;
  faseMs: Record<'F0' | 'eco' | 'percibir' | 'actuar' | 'aplicar', number>; esperaBarreraMs: number;
  ocupacion: Float32Array;                 // por hilo, en [0, 1]
  gpuMs: number[]; gpuBytes: number[]; gpuEstado: ('ok' | 'cpu' | 'sin')[]; // por tarjeta de MotorConfig.gpu
  intentos: number; rechazados: number; migraciones: number; fotogramasSaltados: number;
}

/** Del proceso, no del mundo (sustituye a `params.motor`). La arma el servidor (integrador; M7 para 'auto').
 * Consumen: M1, M2b, M3, M4a, M8 y las pruebas. */
export interface MotorConfig {
  hilos: number | 'auto';
  gpu: readonly number[];                // tarjetas CUDA; el trabajo se reparte por rendimiento medido, nunca a medias
  decisionGpu: 'siempre';                // §1.2: si hay tarjeta, la percepción va a ella aunque no compense
  verificar: boolean;                    // sellos y CRC del frente (I-F), comprobación de dueño al escribir
  semilla: number | null;                // null: entropía real (el mundo público es irrepetible)
}

/** AJUSTES §1: con un solo dueño, sin GPU y con semilla, dos corridas dan el mismo mundo; las leyes no leen el reloj
 * de pared ni usan azar sin sembrar. Es el modo de las pruebas. */
export const reproducible = (c: MotorConfig): boolean => c.hilos === 1 && c.gpu.length === 0 && c.semilla !== null;
export const unSoloDueno = (semilla: number): MotorConfig => ({ hilos: 1, gpu: [], decisionGpu: 'siempre', verificar: true, semilla });
