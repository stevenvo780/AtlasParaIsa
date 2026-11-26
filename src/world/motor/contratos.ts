// CONGELADOS desde el 2026-11-24 (firma de Claude Opus tras la revisión de GPT-6.1 Sol; refirmados por Claude Opus el mismo día tras la pasada adversarial de Gemini 4 Neon): cambiar cualquier contrato de V23 (este fichero, materia/tipos.ts y shared/{materia,naturaleza,cinta,fotograma}.ts) exige pasar por el integrador.
// ENMIENDA 2 del motor (2026-11-24, integración de M1, M2b, M3 y M2a; integrador Claude Opus 5.5), pedida en
// archivo/v23-orquesta/fin/{m2b.cierre2,pedidos-contratos-ola1}.md: dominio de coordenadas; columnas del cerebro en f64
// escritas en F2; W opcional en un plan con cerebro; utilidad = softSign(capa2 + sesgo) + W·rasgos (la ley vigente); eco
// de tick y despacho en lote y salida; qué vale tras esperar o tras un ErrorDispositivo; DATO_TOMAR con los 4 κ de la
// materia. Cada cambio lleva su porqué junto a él.
/**
 * Contratos del motor V23 (ARQ-motor §2), congelados en la ola 0 con la reconciliación de PLAN-V23 §1.2 y
 * AJUSTES-ORQUESTADOR aplicadas: un solo `Intento` (la materia viaja como pares [SustanciaId, cuantos]), sin
 * protocolo de cría (la pareja aporta su genoma por las columnas `genoma` y `pareja` del frente), un solo `Libro`
 * (el de la materia), `decisionGpu: 'siempre'`, canal con la GPU por memoria compartida, tick global y un modo
 * de un solo dueño con semilla que reproduce.
 *
 * Fases de un tick: F0 coordinador · F1 adoptar y vaciar la cola B · F2 percibir (cualquier hilo o GPU) · F3 elegir ·
 * F4 actuar · F5 vaciar la cola A y aplicar · F6 publicar. Un chunk es una página 16×16 de la arena.
 */
import type { DescriptorEnlace, SucesoVisible } from '../../shared/fotograma.js';
import type { ChronicleEvent, CommunityView, Gesture, GestureResult, PlaceView } from '../../shared/types.js';
import type { World, Person } from '../index.js';
import type { ArenaMateria, Libro, LoteRef, MateriaCheckpoint, ServicioQuimico, VistaCuerpo } from '../materia/tipos.js';

// ── Identidades ──────────────────────────────────────────────────────────────────────────────────────────

/** Fila estable de por vida de un organismo en la tabla. */
export type Slot = number;
/** gen·2³² + slot (gen < 2²¹: cabe exacta en un double). Caduca cuando la fila cambia de generación; una fila que
 * llega a gen 2²¹ − 1 se retira y no se vuelve a usar. */
export type Ref = number;
/** Hilo dueño; 0 = coordinador, que además es dueño 0. */
export type Hilo = number;
/** Ranura de una página 16×16 de la arena: cada chunk es una página. */
export type ChunkId = number;

/** Destino o referencia ausente: «a» o «lote» de un intento que no los usa, `CtxLectura.ref` de un uid que no vive. */
export const REF_NULA = -1;
export const refDe = (s: Slot, gen: number): Ref => gen * 4294967296 + s;
export const slotDe = (r: Ref): Slot => r % 4294967296;
export const genDe = (r: Ref): number => Math.floor(r / 4294967296);

/** Clase de organismo en la columna `clase` (la de las sustancias es `ClaseSustancia`). */
export const Clase = { Persona: 1, Animal: 2 } as const;
export type Clase = (typeof Clase)[keyof typeof Clase];

// ── Tabla de organismos y frente público ─────────────────────────────────────────────────────────────────

/** Columna de solo lectura: TS rechaza `c[i] = v`, y cumple `ArrayBufferView` para que M3 la copie en bloque al
 * canal GPU sin bucle elemento a elemento. Una columna de ancho w guarda c[slot·w + i]. En modo verificar, el frente
 * leído se sella con CRC32 por tick (I-F). */
export interface Col extends ArrayBufferView { readonly [i: number]: number; readonly length: number; readonly BYTES_PER_ELEMENT: number }

/** Alelos por slot en `genoma`: en personas, 8 loci diploides (el 8.º, escucha, lo añade E; hasta entonces van a 0);
 * en fauna (F), hasta 16 genes continuos. */
export const GENOMA_ANCHO = 16;
/** Fenotipo por slot en `rasgos` (media de los dos alelos de cada locus): entrada de W·rasgos. */
export const RASGOS_ANCHO = 8;
/** Posición de cada campo de `VistaCuerpo` dentro de la columna `cuerpo`. */
export const CAMPOS_CUERPO = { hambre: 0, sed: 1, energia: 2, salud: 3, masa: 4, carga: 5, T: 6 } as const satisfies Record<keyof VistaCuerpo, number>;
export const CUERPO_ANCHO = 7;

export type TipoColumna = 'f32' | 'f64' | 'i32' | 'u16' | 'u8';

/** Tipo y ancho congelados de las columnas fijas de `FrentePublico`, en el orden en que encabezan `FrentePublico.columnas`:
 * así M2a, M3, M4a, M6, B, N y F usan el mismo método de `FrenteEscritura` y los mismos índices en `ConsultaOrganismo`.
 * `decideEn`, `uid` y `pareja` son f64 (i32 desbordaría a 300 Hz en 82 días). */
export const COLUMNAS_FIJAS = [
  ['gen', 'i32', 1], ['vivo', 'u8', 1], ['clase', 'u8', 1], ['uid', 'f64', 1], ['dueno', 'i32', 1],
  ['x', 'f32', 1], ['y', 'f32', 1], ['chunk', 'i32', 1], ['accion', 'u8', 1], ['objetivo', 'i32', 1],
  ['decideEn', 'f64', 1], ['cuerpo', 'f32', CUERPO_ANCHO], ['rasgos', 'f32', RASGOS_ANCHO],
  ['genoma', 'f32', GENOMA_ANCHO], ['pareja', 'f64', 1],
] as const satisfies readonly (readonly [string, TipoColumna, number])[];

/**
 * Estado público tras el tick `tick`, inmutable durante el siguiente (doble búfer): una tabla para personas y fauna.
 * Sin columna de especie (decisión 9): mientras la fauna la necesite, M2a la registra con `columna` y F la quita.
 * Implementa: M2a (`soa/organismos.ts`). Consumen: M2b y M3 (percepción), M4a, M4b, M5, M6, N, F, B.
 */
export interface FrentePublico {
  readonly tick: number;
  readonly alta: number;                 // filas reservadas: los slots válidos son < alta
  readonly columnas: readonly string[];  // nombres por índice (las de COLUMNAS_FIJAS y luego las registradas): así las citan las consultas
  readonly gen: Col; readonly vivo: Col; readonly clase: Col;
  readonly uid: Col;                     // identidad durable (f64, ≥ 1), nunca reutilizada
  readonly dueno: Col;                   // hilo que tiene al organismo durante el tick siguiente (−1 si no asignado)
  /** Posición en celdas, f32. Enmienda 2: |x|, |y| < 2²⁴, para que f32 la guarde exacta mientras sea entera (hoy
   * lo es: MAX_COORDINATE = 10 000 000, terrain.ts); ampliarla exige otra columna o pasar x e y a f64. */
  readonly x: Col; readonly y: Col; readonly chunk: Col;
  readonly accion: Col;                  // índice en la lista de acciones de su clase
  readonly objetivo: Col;                // celda objetivo (`Terreno.celda`); −1 si no tiene
  readonly decideEn: Col;                // tick de su próxima decisión: vencido si ≤ tick
  readonly cuerpo: Col;                  // CUERPO_ANCHO f32, en el orden de CAMPOS_CUERPO
  readonly rasgos: Col;                  // RASGOS_ANCHO f32
  readonly genoma: Col;                  // GENOMA_ANCHO f32: la pareja lo aporta al concebir
  readonly pareja: Col;                  // consentimiento de cría: −1 = no fértil/no consiente; 0 = cualquiera compatible (fauna); uid > 0 = mejor vínculo fértil en alcance (personas). Quién concibe en una pareja mutua lo decide la ley de N
  col(nombre: string): Col;              // columnas registradas por los demás carriles
}

/** Frente t+1: un dueño solo toca filas con dueno == hilo, en F6. Implementa: M2a. Consumen: M4a, M4b, N, F, B. */
export interface FrenteEscritura {
  fila(slot: Slot): void;                // sella escritoPor[slot] = hilo (se comprueba en modo verificar)
  f32(nombre: string): Float32Array; f64(nombre: string): Float64Array; i32(nombre: string): Int32Array;
  u16(nombre: string): Uint16Array; u8(nombre: string): Uint8Array;
}

/** Implementa: M2a (`soa/organismos.ts`). Consumen: M2b, M4a, M4b, N, F. */
export interface TablaOrganismos {
  columna(nombre: string, tipo: TipoColumna, ancho: number): void; // antes de arrancar
  lectura(): FrentePublico;
  escritura(h: Hilo): FrenteEscritura;
  alta(h: Hilo, c: Clase): Ref;          // slot libre tras 2 ticks de cuarentena; gen nueva
  baja(h: Hilo, r: Ref): void;           // gen++ y vivo = 0 en el frente t+1, conservando x, y y chunk durante la cuarentena (respaldo de M5)
}

// ── Cerebro ──────────────────────────────────────────────────────────────────────────────────────────────

/** Red de política de las personas (hoy `politica.ts`, que tomará de aquí sus dimensiones): entradas → ocultas → acciones,
 * con las acciones en el orden de `POLICY_ACTIONS`. */
export const CEREBRO = { entradas: 12, ocultas: 8, acciones: 12 } as const;

/**
 * Columnas del cerebro, de tipo `TIPO_CEREBRO` y con su ancho. Las registra M2b con `TablaOrganismos.columna`; M3 las
 * sube a la tarjeta por filas sucias. La fauna no las usa (sus filas quedan a 0).
 * - `observacion`: las 12 entradas, en el orden de `LocalObservationInput` (politica.ts). La escribe el dueño en F2,
 *   antes de lanzar, para las filas con cerebro y con el estado de ese momento. Enmienda 2: antes se escribía en F6
 *   de t, y decidir con lo visto un tick atrás cambiaba la conducta respecto de `choose` (m2b.cierre2, H7).
 * - `politica`: los pesos heredados con la disposición de `PolicyGenome.weights` (W1[oculta][entrada], b1,
 *   W2[acción][oculta], b2). El dueño los escribe para todo slot cuya `gen` cambió desde su última escritura, decida
 *   o no en ese tick. Enmienda 2: «al nacer» dejaba en un slot reutilizado los pesos del muerto (m2b.cierre2, H7).
 * - `sesgo`: la plasticidad adquirida (`PolicyPlasticity.bias`), por acción. El dueño la escribe en F2 junto con
 *   `observacion`.
 */
export const COLUMNAS_CEREBRO = {
  observacion: CEREBRO.entradas,
  politica: CEREBRO.entradas * CEREBRO.ocultas + CEREBRO.ocultas + CEREBRO.ocultas * CEREBRO.acciones + CEREBRO.acciones,
  sesgo: CEREBRO.acciones,
} as const;
/** Enmienda 2: f64, el formato de la ley en CPU (`evaluatePolicySingle`); en f32 la CPU dejaba de dar lo mismo que la
 * ley. Un backend f32 convierte al subir (el error medido por M3 es 2,4·10⁻⁷) y el dueño valida su salida. */
export const TIPO_CEREBRO = 'f64' satisfies TipoColumna;

// ── Terreno ──────────────────────────────────────────────────────────────────────────────────────────────

/** Celdas en la arena de páginas 16×16 (SAB crecible: las vistas siguen su longitud). La arena crece solo en F0.
 * Disposición de celdas (como `soa/region.ts`): `celda = chunk * 256 + ((y & 15) << 4 | (x & 15))`, así que
 * `chunkDe(celda) === celda >> 8` y el índice local dentro del chunk es `celda & 255` en orden `(ly·16 + lx)`.
 * Implementa: M1 (`soa/{arena,terreno}.ts`). Consumen: M2b, M3, M4a, M4b, M5, M6, W. */
export interface Terreno {
  readonly paginas: number;              // cota de ChunkId asignados: los residentes tienen c < paginas y duenoChunk[c] ≥ 0
  /** Coordenadas px, py del chunk c (para BFS GPU y Fotograma.paginas). Enmienda 2: |px|, |py| < 2²⁵, lo que piden las
   * claves de página exactas en un double de quien las indexa por pares (m2b.cierre2, H14). */
  readonly paginaX: Int32Array;
  readonly paginaY: Int32Array;
  readonly versionPagina: Uint32Array;   // por chunk; la sube el dueño y la GPU solo sube lo que cambió
  readonly versionVisible: Uint32Array;  // por chunk; la sube marcar(c, true): M6 compara con la última entregada (saltar no pierde cambios)
  readonly duenoChunk: Int16Array;       // vigente durante el tick (−1 si libre); lo cambia el coordinador en F0
  readonly campos: readonly string[];    // nombres por índice: así los citan las consultas
  celda(x: number, y: number): number;   // −1 si no residente
  chunkDe(celda: number): ChunkId;
  campo(nombre: string): Col;            // indexado por `celda`
}
export interface TerrenoDueno extends Terreno {
  /** Subarray de las 256 celdas del chunk `c`, indexado por `celda & 255` (`ly·16 + lx`); verifica dueño en modo verificar. */
  escribible(nombre: string, c: ChunkId): Float64Array | Float32Array | Int32Array | Uint8Array;
  marcar(c: ChunkId, visible: boolean): void; // versionPagina[c]++ y, si visible, versionVisible[c]++
}

// ── Intentos ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un actor escribe directo solo su propio estado y las celdas del chunk donde empezó el tick. Todo lo demás, otros
 * organismos del mismo chunk incluidos, es un intento al buzón de su dueño aunque lo tenga el mismo hilo: el dueño lo
 * aplica contra su estado actual (la regla depende del chunk, nunca del hilo). Lo que va en `dato` por tipo:
 * - Tomar: `DATO_TOMAR`; siempre se contesta con Concedido (con lo que hubo, quizá nada).
 * - Depositar, Dar, Concedido, Devuelto: llevan `materia` y `DATO_MATERIA` (dato null: Suelo, sin forma). Devuelto
 *   devuelve al emisor `de` una garantía rechazada por un receptor vivo.
 * - Golpear: `DATO_GOLPEAR`. Vincular: dato[0] = cuánto sube el vínculo del receptor hacia el emisor; el resto de `dato`
 *   y `bytes` los define `DATO_VINCULAR` en `world/society.ts` (efecto del acto social sobre el receptor; NaN = ausente).
 *   Con aumento cero solo se registra el recuerdo.
 * - Ensenar, Migrante, Gesto, Global: `bytes` (v8.serialize). Activar: dato = [cx, cy] del chunk nuevo.
 * Enrutado con garantía: si `a` sigue vivo (`vivo === 1 && gen === genDe(a)`) pero ahora pertenece a otro dueño
 * (`frente.dueno[slotDe(a)] !== hilo`, por migración o rebalanceo), el intento se reenvía a su dueño actual (en F1 entra
 * en su cola A y se aplica en F5 del mismo tick). Solo si `a` ya no vive o `lote` caducó, la materia se deposita en el
 * Suelo de `celda` (o de la última celda de `a` en el frente), reenviada como Depositar si esa celda es ajena; un Tomar
 * sobre destino ausente se contesta con Concedido vacío.
 * Las respuestas llevan el nonce del intento que contestan; un dueño descarta el (nonce, tipo) que ya aplicó.
 * Toda garantía termina en ≤ 2 ticks (I-B).
 */
export const TipoIntento = {
  Tomar: 1, Depositar: 2, Dar: 3, Golpear: 4, Vincular: 5, Ensenar: 6, // sobre otro organismo, lote o celda de otro chunk
  Concedido: 7, Devuelto: 8,                                           // respuestas que llevan garantía
  Migrante: 9, Gesto: 10, Activar: 11, Global: 12,                     // motor: migración, gesto, chunk nuevo, coordinador
  Cruzar: 13, Admitido: 14,                                         // huella animal: petición a la celda y permiso al animal
} as const;
export type TipoIntento = (typeof TipoIntento)[keyof typeof TipoIntento];

/** Producen: M4b, M5, W, N, F, T1, S y E. Aplica: M5 (`motor/aplicar.ts`) en el dueño destino. */
export interface Intento {
  tipo: TipoIntento;
  de: Ref;
  a: Ref;                        // organismo destino; REF_NULA si el destino es un lote o una celda
  celda: number;                 // `Terreno.celda` del destino; −1 si no aplica
  lote: LoteRef;                 // lote destino (la arena verifica su generación); REF_NULA: el de rol DATO_MATERIA.rol de `a` o de `celda`
  nonce: number;                 // `CtxDueno.id('nonce')`: único en la vida del mundo; repetir no duplica efectos
  materia: Float64Array | null;  // garantía ya debitada del emisor: pares [SustanciaId, cuantos]; [0, j] = j J de calor
  dato: Float64Array | null;
  bytes: Uint8Array | null;
  /** Tick del primer envío del nonce. El buzón lo rellena si falta y lo conserva en respuestas y reenvíos (m5). */
  tickOrigen?: number;
}

/** Posiciones en `dato` de los intentos con materia: Rol del lote que la recibe cuando `lote` es REF_NULA y forma
 * (`codigoForma`, 0 = ninguna) del lote nuevo si hay que crearlo, para que un objeto no pierda su forma al cruzar. */
export const DATO_MATERIA = { rol: 0, forma: 1 } as const;
/** Posiciones en `dato` de un Tomar: qué lote del destino (Rol, si `lote` es REF_NULA), qué `Parte`, de qué sustancia,
 * cuántos cuantos, el lote propio donde se abonará (lo crea antes quien pide; vuelve como `lote` del Concedido) y,
 * solo con Parte.Digerible, los 4 κ del comedor en dato[kappa … kappa + 3], en el orden de las familias catalíticas
 * (C–O, C–N, C–C/C–H, H–H). Enmienda 2: eran 3; la enmienda 2 de la materia dio al H–H su propia familia. */
export const DATO_TOMAR = { rol: 0, parte: 1, esp: 2, cuantos: 3, loteDestino: 4, kappa: 5 } as const;
/** Posiciones en `dato` de un Golpear: el trabajo en J y lo que la ley de romper necesita del útil o cuerpo que golpea. */
export const DATO_GOLPEAR = { trabajo: 0, filo: 1, tenacidad: 2, esbeltez: 3, dureza: 4 } as const;

/** Colas de cada dueño: M (migrantes, se vacía PRIMERO en F1 antes que B); B (respuestas y gestos, en F1); A (intentos
 * del tick, en F5); C (cruces admitidos, al abrir F6); F0 (solo la del coordinador, en F0 de t+1). */
export type Cola = 'M' | 'A' | 'B' | 'C' | 'F0';

/** MPSC sobre SAB crecible. Implementa: M1 (`motor/buzon.ts`). Consumen: M4a, M4b, M5, W, N, F, S, E, T1. */
export interface Buzon {
  /** Enruta según tipo y fase (el coordinador fija la fase en cada barrera): `Migrante` va siempre a M; `Activar` y
   * `Global`, a F0 del coordinador; `Admitido`, a C; el resto, a A en F1–F4 y a B en F5–F6.
   * `enviar` copia el intento al SAB: al volver, el emisor puede reutilizar sus arrays. */
  enviar(destino: Hilo, i: Intento): void;
  /** Solo el dueño, en la fase de esa cola; orden barajado con su azar (salvo M y F0). Los arrays del intento entregado
   * son vistas del SAB: valen solo durante la llamada a `f`. */
  vaciar(cola: Cola, f: (i: Intento) => void): number;
}

// ── Globales ─────────────────────────────────────────────────────────────────────────────────────────────

/** Registro abierto direccionado por contenido (plantillas, recetas, planos): los mismos bytes canónicos dan el mismo id
 * desde cualquier hilo (CAS). Los ids son enteros ≥ 0 (< 2⁵³), nunca reutilizados: son el `Plantilla.id`, el id de receta y el
 * de plano. Lo guarda `MateriaCheckpoint.registro` y la carga lo reinserta con los mismos ids.
 * Implementa: M1. Consumen: T1, T2, L, M4a, A (punto de control). */
export interface Registro {
  insertar(canonico: Uint8Array): number;
  leer(id: number): Uint8Array | undefined;
  readonly n: number;                    // cota de los ids asignados: todos son < n
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
  /** Único, sin orden y < 2⁵³ (llegar ahí es fatal). 'nonce' arranca tras `cargar` por encima del mayor nonce de
   * `MateriaCheckpoint.enVuelo`. 'uid' arranca en ≥ 1 (0 queda reservado en `FrentePublico.pareja`). */
  id(tipo: 'uid' | 'suceso' | 'comunidad' | 'estructura' | 'nonce'): number;
  /** Da de alta una cría en este dueño, en F4–F5 (y registra `persona` si `clase === Clase.Persona`). El llamador le da
   * `id('uid')` y escribe su fila en F6, como las demás de este dueño. */
  alta(clase: Clase, persona?: Person): Ref;
  /** Da de baja un organismo propio (gen++ y vivo = 0 en el frente t+1, y lo retira de `personas` si es Persona). */
  baja(r: Ref): void;
  suceso(e: Omit<ChronicleEvent, 'id' | 'tick'>): string;
  publicar(s: SucesoVisible): void;      // textos y vistas lentas que cambiaron, para la cinta (solo al cambiar)
  /** Lo aplica F0 de t+1. S manda así las aristas ≥ θ de sus personas; F0 junta las mutuas y arma las componentes. */
  pedirGlobal(tipo: 'lugar' | 'comunidad', datos: Uint8Array): void;
}

/** El contexto del dueño cuando la materia ya está en el mundo (ola 2). Implementa: M4a. Consumen: M5, W, B, N, F, T1, T2. */
export interface CtxMateria extends CtxDueno {
  readonly materia: ArenaMateria;
  readonly quimica: ServicioQuimico;
  /** Totales del mundo ya plegados por el coordinador. */
  readonly totales: Pick<MateriaCheckpoint, 'inicial' | 'fuentes' | 'sumideros'>;
}

// ── Percepción ───────────────────────────────────────────────────────────────────────────────────────────

/** Mejor celda alcanzable: minimiza Σ w·campo + pesoDist·dist + pesoPasos·pasos en la ventana BFS r = 7.
 * `campos` son índices de `Terreno.campos`; `filtros`, tripletas [campo, mínimo, máximo] que la celda debe cumplir. */
export interface Consulta {
  campos: Int32Array; pesos: Float32Array; pesoDist: number; pesoPasos: number;
  filtros: Float32Array; alcanzable: boolean;
}
/** Organismo vivo en `radio` (excluye al propio actor): el más cercano (criterio 0) o el de mayor valor en
 * `(columna, componente)` (criterio 1). `clase`: 0 = cualquiera (amenaza/masa mixta), o `Clase`. `filtros` son
 * cuádruplas [columna, componente, mínimo, máximo] sobre `FrentePublico.columnas` (`componente = 0` en escalares). */
export interface ConsultaOrganismo {
  radio: number; clase: 0 | Clase; filtros: Float32Array; criterio: 0 | 1; columna: number; componente: number;
}
/** Lo que un actor necesita percibir para decidir. Los definen M2b (`decision/planes.ts`) y M2a (fauna); los ejecutan M2b (CPU) y M3 (GPU).
 * `transitable` son tripletas [campo, mínimo, máximo] sobre `Terreno.campos` para el BFS r = 7 (tierra para personas, agua
 * para peces; vacío = toda celda residente). Con cerebro, `acciones` = CEREBRO.acciones y `w` es la tabla W
 * (acciones × RASGOS_ANCHO, por filas) o null si el plan no tiene cabeza lineal (W·rasgos = 0); sin cerebro, 0 y null.
 * Enmienda 2: W opcional, porque la ventaja comparativa de las personas depende de la urgencia y del candidato y no
 * cabe en W·rasgos; sus planes llevan cerebro y w = null. */
export interface Plan {
  id: number; transitable: Float32Array; celdas: readonly Consulta[]; organismos: readonly ConsultaOrganismo[];
  acciones: number; w: Float32Array | null;
}
/** Vencidos de un tick que van a un mismo percibidor (lotes de 64 slots en CPU, miles en GPU).
 * `plan[i]` es el índice en `planes` (`0 ≤ plan[i] < planes.length`, con `planes[k].id === k`). `despacho` numera los
 * lanzamientos de quien lo arma, sin repetirse en su vida; un tramo de un lote repartido entre tarjetas lleva el
 * `tick` y el `despacho` del lote entero. */
export interface LotePercepcion { tick: number; despacho: number; slots: Int32Array; plan: Uint16Array }
/** Alineada con `slots`: N×q celdas, pasos y valores, N×v organismos (Ref) y N×a utilidades; q, v y a son los máximos
 * sobre `planes` (sin resultado o sobrante: celda = −1, pasos = −1, valor = Infinity, organismo = REF_NULA, utilidad = 0).
 * Con cerebro, utilidad[j] = softSign(capa2(observacion)[j] + sesgo[j]) + Σₖ w[j·RASGOS_ANCHO + k]·rasgos[k], la ley de
 * `evaluateRow` (politica.ts). Enmienda 2: el texto sumaba el sesgo fuera de la activación, y así el argmax de la red
 * cambiaba en 2 de cada 41 personas según decidiera la tarjeta o la CPU (m2b.cierre).
 * El percibidor copia `tick` y `despacho` del lote en su salida (una tarjeta, de la respuesta de su servidor); el dueño
 * rechaza con ErrorDispositivo la salida cuyo `tick` o `despacho` no sean los del lote que espera y recalcula ese lote en
 * CPU. Enmienda 2: sin ese eco, una salida rancia de otro despacho que pasara las comprobaciones se aceptaba (m2b.cierre2, H2). */
export interface Percepcion {
  readonly q: number; readonly v: number; readonly a: number;
  readonly tick: number; readonly despacho: number;
  celda: Int32Array; pasos: Int16Array; valor: Float32Array; organismo: Float64Array; utilidad: Float32Array;
}

export type Dispositivo = 'cpu' | `gpu${number}`;

/** Implementan: M2b (CPU, `decision/percepcion.ts`) y M3 (GPU, `gpu/percibir-gpu.ts`). Consumen: M2b (T=1) y M4a.
 * Cuando `esperar` devuelve, el percibidor ya no lee la vista ni escribe la salida. Si lanza ErrorDispositivo (plazo
 * vencido o fallo), el dueño da al lector por vivo: la captura siguiente se publica en búferes nuevos y los del despacho
 * fallido no se reutilizan hasta que el percibidor confirme que terminó o canceló. Enmienda 2: reutilizarlos dejaba a un
 * lector tardío ver medio tick nuevo (m2b.cierre2, H3). */
export interface Percibidor {
  readonly dispositivo: Dispositivo;
  lanzar(l: LotePercepcion, planes: readonly Plan[]): void;
  esperar(plazoMs: number): Percepcion;  // ErrorDispositivo si vence el plazo, falla o el eco no casa
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
 * `enviar` y `recibir` van separados para que F0 lance todas las tarjetas sin bloquear y B2 recoja las respuestas en
 * paralelo con F1–F2 de CPU. Las respuestas llegan en el orden de las órdenes: cada `recibir` devuelve la de la `enviar`
 * más antigua sin contestar. Ambos lanzan `ErrorDispositivo` si cae el servidor; `recibir`, también si vence el plazo.
 * Implementa: M3 (`gpu/canal.ts`). Consumen: M3 (`percibir-gpu.ts`) y G (`materia-gpu.ts`).
 */
export interface CanalGpu {
  readonly dispositivo: number;          // índice CUDA
  readonly bytes: number;                // tamaño de la zona compartida
  crecer(bytes: number): void;
  escribir(desde: number, datos: ArrayBufferView): void;
  leer(desde: number, destino: ArrayBufferView): void;
  enviar(orden: Uint8Array): void;                       // no bloquea
  recibir(plazoMs: number): Uint8Array;                  // bloquea hasta la respuesta o el plazo
  cerrar(): void;
}

// ── Motor ────────────────────────────────────────────────────────────────────────────────────────────────

/** Un tick coherente reunido en una barrera para `Store.guardar(i)` (con `v23.guardadoCompleto`): el mundo y su
 * materia en la misma transacción (§1.2); `Store.cargarInstantanea()` la devuelve con la época reservada.
 * `materia` es null hasta que W conecte la materia al mundo (ola 2). El `World` lleva arrays normales, nunca un SAB. */
export interface Instantanea { world: World; materia: MateriaCheckpoint | null }

/** Implementa: M4a (`motor/coordinador.ts`; en la ola 1, M2b como fachada de `stepWorld` con T=1).
 * Consumen: el servidor (`sim-worker`, `app`) vía el integrador, M6 y PS. */
export interface Motor {
  paso(gestos: readonly Gesture[]): { tick: number; resultados: GestureResult[] };
  /** Mundo reunido en barrera para proyectar el paso completo. */
  vista(): World;
  instantanea(): Instantanea;
  cargar(i: Instantanea, epoca: number): void; // reparte tras Store.cargarInstantanea() o una recuperación y abre la época: su primer fotograma es completo
  /** Desde entonces entrega un fotograma cada `cadencia` ticks si hay crédito (protocolo en shared/fotograma.ts). */
  enlazar(cinta: DescriptorEnlace, fuente?: import('./fotograma.js').FuenteFotograma): void;
  detalle(uid: number): Promise<Person | null>; // inspector: lo serializa el dueño en el F1 siguiente
  telemetria(): TelemetriaMotor;
  /** Preparación solicitada por el banco fuera de la ventana de medición. */
  prepararBrokerGpu?(): Promise<boolean>;
  reparto(): import('../../shared/vistas-v23.js').RepartoVisible | undefined;
  /** Muestreo de laboratorio a demanda, entre pasos, sin reunir ni copiar el mundo. */
  muestraCarga(): MuestraCargaMotor | undefined;
  cerrar(): Promise<void>;
}

export interface CargaChunk {
  chunk: ChunkId;
  px: number;
  py: number;
  dueno: Hilo;
  personas: number;
  fauna: number;
  /** Vencimientos que anuncia la columna `decideEn` para el próximo tick, sin inferir urgencias. */
  personasVencen: number;
  faunaVence: number;
}

export interface MuestraCargaMotor {
  fuente: 'frenteConfirmado';
  tick: number;
  epoca: number;
  chunks: CargaChunk[];
  ranurasVivas: number;
  fueraDeChunkActivo: number;
  conOtroDueno: number;
  claseDesconocida: number;
  /** Tiempos totales por dueño del último tick, sin EMA. Los conteos corresponden al frente al cierre de ese tick. */
  fasesPorDuenoMs: { F1: number; eco: number; F2: number; F3F4: number; F5F6: number; total: number }[] | null;
}

/** Implementan: M4a y M7. Consumen: V1 (panel «Motor»), 0C (diagnóstico), M8 (banco). */
export interface TelemetriaBrokerGpu {
  /** Lotes no vacíos, confirmaciones del canal y desvíos admitidos por el percibidor. */
  lotes: number;
  completadas: [number, number];
  cpuArranque: number;
  cpuOcupada: number;
  cpuSinCanal: number;
  erroresCanal: number;
  /** Solo bytes de despachos confirmados. El tiempo CUDA incluye las copias del servidor. */
  subidaConfirmadaBytes: number;
  bajadaConfirmadaBytes: number;
  cudaConfirmadaMicros: number;
  recorridoConfirmadoMicros: number;
}

export interface TelemetriaMotor {
  tick: number; hz: number; diasPorMinuto: number; hilos: number; desequilibrio: number;
  faseMs: Record<'F0' | 'eco' | 'percibir' | 'actuar' | 'aplicar', number>; esperaBarreraMs: number;
  ocupacion: Float32Array;                 // por hilo, en [0, 1]
  gpuMs: number[]; gpuBytes: number[]; gpuEstado: ('ok' | 'cpu' | 'sin')[]; // por tarjeta de MotorConfig.gpu
  gpuBroker?: TelemetriaBrokerGpu;
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
  medirBrokerGpu?: boolean;              // contadores acumulados opcionales del banco de percepción distribuida
  /** Con `hilos: 'auto'`: el coordinador mide los Hz con T y ¾T dueños y llama a `elegir(medidas)` (Hz por número de
   * dueños), con el máximo que fija el proceso; el reloj nunca altera las leyes. Lo suministra srv (`motorConfig`). */
  auto?: { maximo: number; elegir(medidas: ReadonlyMap<number, number>): number };
}

/** AJUSTES §1: con un solo dueño, sin GPU y con semilla, dos corridas dan el mismo mundo; las leyes no leen el reloj
 * de pared ni usan azar sin sembrar. Es el modo de las pruebas. */
export const reproducible = (c: MotorConfig): boolean => c.hilos === 1 && c.gpu.length === 0 && c.semilla !== null;
export const unSoloDueno = (semilla: number): MotorConfig => ({ hilos: 1, gpu: [], decisionGpu: 'siempre', verificar: true, semilla });
