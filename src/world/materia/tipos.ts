/**
 * Contratos de la materia en el servidor (ARQ-materia §2 con PLAN-V23 §1.2): sustancias internadas, lotes y su
 * arena, el `Libro` único de conservación, reacciones, plantillas, cuerpos, procesos y el punto de control.
 * Lo que también ve el cliente está en `shared/materia.ts`; los números de la naturaleza, en `shared/naturaleza.ts`.
 * Entre dueños la materia viaja en un `Intento` del motor (`motor/contratos.ts`): ya no hay `IntentoMateria`.
 */
import { NE } from '../../shared/naturaleza.js';
import type { ClaseSustancia, Forma, Propiedades, SustanciaId } from '../../shared/materia.js';

// ── Química ──────────────────────────────────────────────────────────────────────────────────────────────

/** Sustancia internada. La crea Q (único escritor del registro); la leen P, L, W, B, T1 y G. */
export interface Sustancia {
  id: SustanciaId;
  clase: ClaseSustancia;
  enlaces: Uint16Array; // pares [tipo de TIPOS, cuenta] ordenados por tipo: es la clave
  atomos: Uint8Array;   // NE
  masa: number;         // mg por cuanto (g/mol)
  energia: number;      // J por cuanto: −Σd·b, entero
  prop: Propiedades;
}

/** Niveles logarítmicos de temperatura con que se memorizan las reacciones (resolución, no física). */
export const NIVELES_T = 16;
export const T_NIVEL_MIN = 200;
export const T_NIVEL_MAX = 3200;
const RAZON_NIVEL = Math.log(T_NIVEL_MAX / T_NIVEL_MIN) / NIVELES_T;

/** Nivel ℓ ∈ [0, NIVELES_T) de una temperatura en K. Lo usan Q (memo) y P (`pasoLote`). */
export const nivelDeT = (T: number): number =>
  Math.min(NIVELES_T - 1, Math.max(0, Math.floor(Math.log(T / T_NIVEL_MIN) / RAZON_NIVEL)));
/** Temperatura representativa (centro geométrico) del nivel ℓ: la T con que Q calcula los productos. */
export const tDeNivel = (nivel: number): number => T_NIVEL_MIN * Math.exp((nivel + 0.5) * RAZON_NIVEL);

/** Transformación balanceada en átomos: aplicarla `veces` consume veces·nu de cada entrada, produce veces·nu de cada
 * salida y resta veces·dH al calor del lote. Exige dH = Σ energía de las salidas − Σ de las entradas (así el libro no cambia). */
export interface Ecuacion {
  entradas: readonly { id: SustanciaId; nu: number }[];
  salidas: readonly { id: SustanciaId; nu: number }[];
  dH: number; // J por vez (un cuanto de reacción)
}

/**
 * Reparto de menor energía libre de a + b al nivel de temperatura `nivelT`, como `Ecuacion`: entradas a y b con nu 1
 * (a + a: a con nu 2; b = 0: a sola) y salidas los productos. Lo calcula Q; lo aplica P con Arrhenius:
 * x = ν·exp(−max(0, ea − κ[catalisis])/(R·T))·… (ARQ-materia §3.1). `quemar` (L) no es cinético: el cuerpo paga su trabajo
 * aplicando la reacción de la reserva con O₂ tantas veces como pide el trabajo, recortado a existencias.
 */
export interface Reaccion extends Ecuacion {
  a: SustanciaId; b: SustanciaId; nivelT: number;
  ea: number;                  // J por cuanto de reacción: barrera, GAMMA·D del enlace más fuerte que disminuye
  /** Familia del enlace catalizable más fuerte que disminuye, índice de `Plantilla.kappa` (C–O, C–N, C–C/C–H); los
   * enlaces del oxidante y del agua (O=O, O–H) y los demás no deciden la familia. −1 = no disminuye ninguno catalizable. */
  catalisis: -1 | 0 | 1 | 2;
}

/** Servicio de un solo escritor en su propio worker. Implementa: Q (`materia/{quimica,servicio}.ts`). Consumen: P, L, W, T1, G. */
export interface ServicioQuimico {
  /** En el hilo del servicio o antes de arrancar (creación del mundo); las sustancias nuevas solo salen de reacciones. */
  internar(enlaces: Uint16Array): SustanciaId;
  sustancia(id: SustanciaId): Readonly<Sustancia>;
  /** null = no reaccionan; undefined = encolada: el resultado se publica en la barrera siguiente. */
  reaccion(a: SustanciaId, b: SustanciaId, nivelT: number): Reaccion | null | undefined;
}

// ── Lotes ────────────────────────────────────────────────────────────────────────────────────────────────

/** Referencia a un lote de la arena: entero ≥ 0 (≤ 2⁵³) que A codifica con ranura y generación; caduca al liberarse la ranura. */
export type LoteRef = number;

/** Dónde está un lote: tesela (Suelo, Agua, Vida), aire por página, roca, cuerpo o lote con forma. */
export const Rol = {
  Suelo: 0, Agua: 1, Vida: 2, Aire: 3, Roca: 4,
  Tejido: 5, Reserva: 6, Digestivo: 7, Embrion: 8,
  Objeto: 9, Cadaver: 10, Pieza: 11,
} as const;
export type Rol = (typeof Rol)[keyof typeof Rol];

/** Lo que las leyes ven de un lote (vistas heredadas, §1.2: no hay adaptador escalar). Implementa: A con P. Consumen: L, W, B, T1, la proyección. */
export interface VistaLote {
  masa: number;          // kg
  T: number;             // K
  fase: 0 | 1 | 2 | 3;   // sólido, líquido, gas, mezcla
  dureza: number; tenacidad: number; sellado: number; aislamiento: number; // [0, 1]
  energia: number;       // J que libera su oxidación completa
  digerible: number;     // J digeribles con KAPPA0; con otro κ los calcula el dueño del comedor
  agua: number;          // cuantos de agua
  color: number;         // 0xRRGGBB
  forma: number;         // `codigoForma`; 0 = sin forma
  principal: SustanciaId; // la de más masa
}

/** Traslado entre dos lotes del mismo dueño (entre dueños: `Intento` con garantía). */
export interface Traslado { de: LoteRef; a: LoteRef; esp: SustanciaId; cuantos: number }

/** Qué parte de un lote se pide al tomar o se garantiza al dar (va en `Intento.dato`, ver `DATO_TOMAR`). */
export const Parte = { Exacta: 0, Digerible: 1, Agua: 2, Todo: 3 } as const;
export type Parte = (typeof Parte)[keyof typeof Parte];

/** `cuantos` de `esp` (Exacta), de lo que digiere `kappa` (Digerible), de agua (Agua) o el lote entero con su calor (Todo). */
export interface Pedido { parte: Parte; esp: SustanciaId; cuantos: number; kappa: readonly [number, number, number] | null }

/**
 * Libro único de conservación (§1.2), uno por hilo; el motor, la poda y la materia usan este mismo.
 * Cada campo es un Float64Array(NE + 1): las NE primeras posiciones son mmol de átomos por elemento y la última
 * (`ENERGIA`) J de energía química (cuantos × `Sustancia.energia`) más calor.
 * Exactitud: todo asiento, cantidad y calor de un lote es un entero seguro (|v| ≤ 2⁵³ − 1); una operación que daría
 * otra cosa es fatal (I3), nunca se redondea. Para que los asientos no crezcan sin fin, el coordinador pliega en cada F0
 * que comprueba: suma los libros de los hilos en bigint, añade fuentes − sumideros a los totales del mundo
 * (`MateriaCheckpoint`) y deja a cero los libros de los hilos, salvo el enVuelo total, que queda en el hilo 0.
 * Así comprueba Σ lotes + Σ enVuelo = inicial + fuentes − sumideros, exacto (I1, I2, I-C), con las sumas del mundo en bigint.
 * Implementa: A (`materia/libro.ts`). Consumen: M1, M4a, M5, W, B, N, 0C (invariantes).
 */
export interface Libro { readonly enVuelo: Float64Array; readonly fuentes: Float64Array; readonly sumideros: Float64Array }
export const ENERGIA = NE;
export const libroVacio = (): Libro =>
  ({ enVuelo: new Float64Array(NE + 1), fuentes: new Float64Array(NE + 1), sumideros: new Float64Array(NE + 1) });

/**
 * Arena de lotes de tamaño fijo sobre el SAB crecible de M1 (ARQ-materia §2). Solo el dueño de un lote lo modifica (el de
 * su página o el de su organismo; en modo verificar la arena lo comprueba); leer uno ajeno es una carrera tolerada
 * (ARQ-motor §3.3). Lo que entra o sale del mundo pasa por `fuente` y
 * `sumidero`; lo demás se conserva por construcción. Implementa: A (`materia/arena.ts`). Consumen: P, L, W, B, N, F, T1, T2, M5.
 */
export interface ArenaMateria {
  /** Lote vacío en `celda` (`Terreno.celda`); −1 para los de un cuerpo, que van con su organismo. */
  nuevo(rol: Rol, celda: number, forma: number): LoteRef;
  liberar(l: LoteRef): void;   // solo en barrera; la ranura vuelve con gen++
  vivo(l: LoteRef): boolean;   // false si la referencia caducó
  /** Lotes de `rol` en `celda` (Suelo, Agua y Vida: uno por tesela; Aire: el de su página). Los escribe en `destino` y
   * devuelve cuántos hay; si son más que destino.length, solo escribe los que caben. */
  lotes(celda: number, rol: Rol, destino: Float64Array): number;
  /** Sustancias presentes (las 8 ranuras y el desborde), como `lotes`. */
  especies(l: LoteRef, ids: Uint32Array): number;
  cuantos(l: LoteRef, id: SustanciaId): number;
  calor(l: LoteRef): number;   // J
  vista(l: LoteRef): VistaLote;
  formar(l: LoteRef, forma: number): void; // `codigoForma` nuevo (romper con patrón, unir)
  mover(t: Traslado): number;  // recorta a existencias y devuelve lo movido
  moverCalor(de: LoteRef, a: LoteRef, j: number): number;
  /** Aplica `e` hasta `veces` veces, recortado a existencias y a calor ≥ 0; devuelve las que aplicó. Reacciones (P),
   * síntesis de plantillas (L) y `quemar`. */
  aplicar(l: LoteRef, e: Ecuacion, veces: number): number;
  /** Saca de `l` lo pedido (recortado a existencias) como garantía para un `Intento`: pares [SustanciaId, cuantos] y
   * [0, j] con su parte del calor. Lo suma a `libro.enVuelo`. Puede volver vacío. */
  garantizar(l: LoteRef, p: Pedido, libro: Libro): Float64Array;
  /** Abona en `l` una garantía recibida y la resta de `libro.enVuelo`. */
  abonar(l: LoteRef, garantia: Float64Array, libro: Libro): void;
  /** Entrada declarada (sol, roca que se materializa, chunk nuevo, S/I), en pares como la garantía: `libro.fuentes`. */
  fuente(l: LoteRef, pares: Float64Array, libro: Libro): void;
  /** Salida declarada (radiación, el sumidero de comer de la ola 2), recortada a existencias: `libro.sumideros`.
   * Devuelve lo que salió. */
  sumidero(l: LoteRef, pares: Float64Array, libro: Libro): Float64Array;
}

// ── Plantillas y cuerpos ─────────────────────────────────────────────────────────────────────────────────

/** Lo que se copia al crecer: 6 linajes animales y 1 plantilla vegetal por bioma al fundar (§1.2); después, genes continuos.
 * Implementa: L. Consumen: W (vegetación), B, N, F. */
export interface Plantilla {
  id: number;         // `Registro.insertar` de sus bytes canónicos
  /** Una unidad de plantilla: cuantos enteros de cada sustancia del tejido. Su masa es Σ nu·masa (mg); `sintesis` la
   * produce entera (sus salidas son estas partes más los subproductos, como O₂ y H₂O). */
  partes: readonly { id: SustanciaId; nu: number }[];
  sintesis: Ecuacion;
  kappa: readonly [number, number, number]; // J por cuanto de rebaja de barrera: C–O, C–N, C–C/C–H
  captura: number;    // fracción de la luz que fija (plantas)
  masaAdulta: number; // kg
  m0: number;         // kg al nacer
  linaje: number;     // linaje fundador: solo lo leen la proyección y el cliente (decisión 9)
}

/** Gestación con un solo escritor, el dueño de la gestante. La pareja solo aporta su genoma, leído del frente (§1.2). */
export interface Gestacion {
  embrion: LoteRef;
  otro: number;           // uid de la pareja (frente público)
  genoma: number[];       // GENOMA_ANCHO alelos de la cría, sorteados al concebir de los dos genomas
  inicio: number;         // tick
  bajoBasalDesde: number; // tick desde el que la reserva no paga el basal; −1 si la paga
}

/** Cuerpo de átomos de una persona o un animal (`Person.cuerpo`, `Animal.cuerpo`). Contrato contra el que N, F, T1 y T2
 * se escriben en paralelo con B. Implementa: B (`materia/cuerpo.ts`). Consumen: N, F, T1, T2, M4b, V3. */
export interface Cuerpo { tejido: LoteRef; reserva: LoteRef; digestivo: LoteRef; plantilla: number; gestacion?: Gestacion }

/** Lo que `choose` y los demás leen de un cuerpo; el dueño lo publica en la columna `cuerpo` del frente (`CAMPOS_CUERPO`).
 * Implementa: B. Consumen: M2b (`needRates`), N, F, E, V3. */
export interface VistaCuerpo {
  hambre: number; sed: number; energia: number; salud: number; // [0, 1]
  masa: number;  // kg
  carga: number; // kg a cuestas
  T: number;     // K
}

// ── Procesos técnicos ────────────────────────────────────────────────────────────────────────────────────

/** Un paso de un proceso. Romper talla el lote hasta `forma` con el trabajo de quien lo hace; unir le añade `masa` kg de
 * un lote propio o del suelo de la celda cuyo `principal` es `insumo` y cuya forma es `forma` (0 = cualquiera), y espera
 * si no lo hay; calentar (junto a un fuego) y mojar (en agua) duran hasta `T` K o `ticks` ticks, lo primero que llegue. */
export type Paso =
  | { op: 'romper'; forma: Forma }
  | { op: 'unir'; insumo: SustanciaId; forma: number; masa: number }
  | { op: 'calentar' | 'mojar'; hasta: { T?: number; ticks?: number } };
export type Operacion = Paso['op'];
/** Proceso que ocurre en el mundo paso a paso; si se interrumpe, el lote intermedio queda en el sitio.
 * Implementa: T1 (`materia/proceso.ts`). Consumen: T2, V3. */
export interface ProcesoMaterial { lote: LoteRef; pasos: readonly Paso[]; i: number; desde: number; x: number; y: number }

// ── Punto de control ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Materia guardada en la misma operación que el `World` (cada 2.400 ticks, §1.2), fuera del JSON: binario y con el
 * sello de la época. Al cargar se exige el sello en todas las páginas y Σ lotes + Σ garantías de `enVuelo` =
 * inicial + fuentes − sumideros, por posición del libro.
 * Implementa: A (`materia/checkpoint.ts`). Consumen: PS (`Store`), M4a (`instantanea`, `cargar`).
 */
export interface MateriaCheckpoint {
  epoca: number; tick: number;
  sustancias: Uint8Array; // registro de Q (solo crece)
  registro: Uint8Array;   // el `Registro` del motor (plantillas, recetas, planos) con sus ids
  paginas: Uint8Array;    // lotes por página
  enVuelo: Uint8Array;    // intentos con garantía aún en los buzones
  /** Totales del mundo ya plegados (NE + 1 cada uno), en bigint: la suma del mundo puede pasar de 2⁵³. */
  inicial: readonly bigint[]; fuentes: readonly bigint[]; sumideros: readonly bigint[];
}
