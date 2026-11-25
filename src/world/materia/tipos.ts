// ENMIENDA 1 (2026-11-24, «ciclos cerrados»; integrador Claude Opus 5.5 en sprint/v23l-materia, pedidos 1–4, 6 y 7 de
// Q y los de L): coeficientes enteros que elige Q, H–H catalizable, ninguna barrera por debajo de dH, energía de red y
// reglas de ea escritas, fronteras exactas de nivelDeT y precisiones de `aplicar`.
// ENMIENDA 2 (2026-11-24, «ciclos cerrados, validados»; integrador Claude Opus 5.5 tras la validación independiente de
// los ciclos, archivo/v23-orquesta/fin/): H–H con familia catalítica propia (3) y `Kappa` de 4 familias; la catálisis
// solo rebaja barreras de reacciones exotérmicas (dH ≤ 0); un lote catalizado elige productos al menos en el nivel 2
// (`nivelDeLote`); `copiar` mueve el calor con la materia.
// ENMIENDA 3 (2026-11-24, «química de principios»; integrador Claude Opus 5.5 tras cerrar las filas 7 y 8 de la tabla de
// cordura y el sumidero de HCN): la catálisis va por pares de electrones (`Reaccion.paresCatalisis`, `barreraEfectiva`).
// ENMIENDA 3, REVISIÓN (2026-11-25; integrador Claude Opus 5.5 tras la validación de Fable y la revisión de GPT-6.2 Sol
// sobre 18470f9..703c6ef): `paresCatalisis` es el mayor número de pares que abre un enlace de la familia elegida; el
// empate de (p, q) se decide en el orden canónico de los reactivos; P (y `quemar`) solo corre un canal con ΔG < −ε a la T
// y fases reales del lote (`favorableA`), y lo que nace en un paso reacciona en ese mismo paso (`PASES_ENCADENADOS`).
/**
 * Contratos de la materia en el servidor (ARQ-materia §2 con PLAN-V23 §1.2): sustancias internadas, lotes y su
 * arena, el `Libro` único de conservación, reacciones, plantillas, cuerpos, procesos y el punto de control.
 * Lo que también ve el cliente está en `shared/materia.ts`; los números de la naturaleza, en `shared/naturaleza.ts`.
 * Entre dueños la materia viaja en un `Intento` del motor (`motor/contratos.ts`): ya no hay `IntentoMateria`.
 */
import { NE, NIVEL_CATALIZADO } from '../../shared/naturaleza.js';
import type { ClaseSustancia, Forma, Propiedades, SustanciaId } from '../../shared/materia.js';

// ── Química ──────────────────────────────────────────────────────────────────────────────────────────────

/** Sustancia internada. La crea Q (único escritor del registro); la leen P, L, W, B, T1 y G. */
export interface Sustancia {
  id: SustanciaId;
  clase: ClaseSustancia;
  enlaces: Uint16Array; // pares [tipo de TIPOS, cuenta] ordenados por tipo: es la clave
  atomos: Uint8Array;   // NE
  masa: number;         // mg por cuanto (g/mol)
  /** J por cuanto, entero: −Σd·b − E_red(b). E_red ≥ 0 solo en unidades con enlace iónico (`quimica.energiaRed`:
   * E_RES_IONICO por puente resonante M–X–Y=X y E_HID_IONICO por hidróxido M–X–H, homogénea de grado 1). */
  energia: number;
  prop: Propiedades;
}

/** Niveles logarítmicos de temperatura con que se memorizan las reacciones (resolución, no física). */
export const NIVELES_T = 16;
export const T_NIVEL_MIN = 200;
export const T_NIVEL_MAX = 3200;
const RAZON_NIVEL = Math.log(T_NIVEL_MAX / T_NIVEL_MIN) / NIVELES_T;

/** Frontera inferior del nivel ℓ en K, T_ℓ = T_NIVEL_MIN·(T_NIVEL_MAX/T_NIVEL_MIN)^(ℓ/NIVELES_T) = 200·2^(ℓ/4), tal como la
 * da la coma flotante (ℓ = 4: 400 K; ℓ = 10: 1.131,37 K). Es la referencia exacta de `nivelDeT`. */
export const tFronteraNivel = (nivel: number): number => T_NIVEL_MIN * (T_NIVEL_MAX / T_NIVEL_MIN) ** (nivel / NIVELES_T);
const FRONTERAS = Float64Array.from({ length: NIVELES_T + 1 }, (_, l) => tFronteraNivel(l));

/**
 * Nivel ℓ ∈ [0, NIVELES_T) de una temperatura en K: el ℓ con T_ℓ ≤ T < T_ℓ₊₁ (`tFronteraNivel`), así que cada frontera
 * exacta pertenece al nivel de arriba (1.131,37 K es el 10, no el 9); por debajo de 200 K (y con T = 0 o NaN), 0; desde
 * T_15, 15. 295 K (suelo) y 310 K (cuerpo) caen los dos en el nivel 2, [282,8; 336,4) K: tienen los mismos productos y
 * solo cambia la tasa, que usa la T del lote. Lo usan Q (memo), P (`pasoLote`) y L (`quemar`).
 */
export const nivelDeT = (T: number): number => {
  let n = Math.floor(Math.log(T / T_NIVEL_MIN) / RAZON_NIVEL);
  if (!(n >= 0)) return 0;
  if (n >= NIVELES_T - 1) return T >= FRONTERAS[NIVELES_T - 1]! ? NIVELES_T - 1 : NIVELES_T - 2;
  // El logaritmo puede quedar a un ulp de la frontera: se corrige contra la tabla.
  if (T < FRONTERAS[n]!) n--;
  else if (T >= FRONTERAS[n + 1]!) n++;
  return Math.max(0, n);
};
/** Temperatura representativa (centro geométrico) del nivel ℓ: la T con que Q calcula los productos. */
export const tDeNivel = (nivel: number): number => T_NIVEL_MIN * Math.exp((nivel + 0.5) * RAZON_NIVEL);

/** Transformación balanceada en átomos: aplicarla `veces` consume veces·nu de cada entrada, produce veces·nu de cada
 * salida y resta veces·dH al calor del lote. Exige dH = Σ energía de las salidas − Σ de las entradas (así el libro no cambia). */
export interface Ecuacion {
  entradas: readonly { id: SustanciaId; nu: number }[];
  salidas: readonly { id: SustanciaId; nu: number }[];
  dH: number; // J por vez (un cuanto de reacción)
}

/** Familias catalíticas: índices de `Kappa` y valores de `Reaccion.catalisis` ≥ 0 (0 = C–O, 1 = C–N, 2 = C–C/C–H,
 * 3 = H–H; enmienda 2). */
export const FAMILIAS_CATALITICAS = 4;
export type FamiliaCatalitica = -1 | 0 | 1 | 2 | 3;
/** J por cuanto de rebaja de barrera por familia catalítica, en el orden de `Reaccion.catalisis`: C–O, C–N, C–C/C–H y
 * H–H. Lo lleva el lote que cataliza: el dueño se lo pasa a `pasoLote` según su rol (W: Suelo y Cadaver con
 * [KAPPA_SUELO ×3, KAPPA_SUELO_HH]; aire, agua, roca, objetos y tejido sin catálisis, [0, 0, 0, 0]; B: el digestivo con
 * `Plantilla.kappa`), y viaja en `Pedido.kappa` (el comedor que digiere). Con algún κ > 0 el lote elige productos al menos
 * en el nivel NIVEL_CATALIZADO (`nivelDeLote`), aunque esté más frío. */
export type Kappa = readonly [number, number, number, number];

/**
 * Reparto de menor energía libre de a + b al nivel de temperatura `nivelT`, como `Ecuacion`: entradas a y b con los
 * coeficientes enteros p, q ≥ 1 que elige Q (los de mayor −ΔG por átomo sin reactivo sobrante, con p·|a| + q·|b| ≤
 * `ATOMOS_POR_REACCION` = 16 átomos; a igualdad, los de menos átomos y luego el menor coeficiente del reactivo de menor
 * clave de enlaces, así que no depende del orden de a y b ni del de internado (revisión de la enmienda 3, hallazgo 3; antes
 * el menor p); a + a: a con nu p ≥ 2; b = 0: a sola con nu 1) y salidas los productos del mínimo global de G = E − T·S_GAS·#gas sobre esos átomos. ΔG es frente a los
 * reactivos tal cual; para ser reacción, el mínimo debe ganar en más de EPSILON_G a todo reparto de p·a + q·b en dos
 * grupos que reaccionen por separado (sin espectadores ni uniones de reacciones menores). Así 2 H₂ + O₂ → 2 H₂O.
 * Lo calcula Q; lo aplica P con Arrhenius, x = ν·exp(−b/(R·T))·… con la barrera efectiva (`barreraEfectiva`)
 *   b = max(0, ea − κ[catalisis]·paresCatalisis)  si dH ≤ 0 y catalisis ≥ 0,
 *   b = ea (≥ dH)                                 si dH > 0 o catalisis = −1,
 * es decir, la catálisis solo rebaja barreras de reacciones exotérmicas (enmienda 2; en la 1 era max(0, ea − κ, dH)) y
 * rebaja κ por cada par de electrones que abre del enlace que la decide (enmienda 3; en los simples, κ como antes).
 * Por qué: en V23 una endotérmica a ~295 K solo es espontánea por T·S_GAS del gas que suelta (≈ 53 J por molécula), y
 * catalizada era una fuente sin retorno: CH₂ → H₂ + C y 2 madera → 2 H₂ + C + CO₂ en el suelo, proteína → H₂ + HCN en
 * frío (validación de los ciclos, hallazgos 1, 3 y 11). La vida cataliza lo que le rinde calor; lo endotérmico solo
 * ocurre por el calor del lote (horno, llama). Veces por tick k·n_a·n_b/V (a + b), k·n_a²/V (a + a) y k·n_a (sola)
 * sean cuales sean los nu, y cada vez gasta nu de cada entrada. Q decide productos y ΔG a la T de su nivel; P solo corre
 * la fila si también gana energía libre a la T y con las fases reales del lote (`favorableA` de quimica.ts: con el piso
 * de `nivelDeLote`, un suelo a 270 K usaba la fila del nivel 2 y hacía 3 H₂ + N₂ → 2 NH₃ con ΔG real +49,4 J). `quemar` (L) no es cinético: el cuerpo paga su trabajo
 * aplicando la reacción de la reserva con O₂ tantas veces como pide el trabajo, recortado a existencias.
 */
export interface Reaccion extends Ecuacion {
  a: SustanciaId; b: SustanciaId; nivelT: number;
  /** J por cuanto de reacción (una vez): barrera. GAMMA·D del enlace más fuerte que disminuye; de un enlace múltiple que
   * solo baja de orden, su parte π, D_k − D_k′, menos E_CAT_IONICO si hay un sólido iónico entre las entradas y no se
   * pierde ningún σ. Si el vector de enlaces se conserva: 0 en una asociación (un solo producto) y GAMMA·D del enlace más
   * débil de las entradas si alguna se parte. Nunca menor que dH. */
  ea: number;
  /** Familia del enlace catalizable que disminuye con el par de electrones más débil (D/k), índice de `Kappa` (0 = C–O,
   * 1 = C–N, 2 = C–C/C–H, 3 = H–H); los enlaces del oxidante y del agua (O=O, O–H) y los demás no deciden la familia.
   * −1 = ninguno catalizable. Sustituye al «más fuerte» de ARQ-materia §3.1, con el que C–C y C–H tapaban a C–O
   * (azúcares, celulosa) y a C–N (proteínas); exige D(C–N) < D(C–O) < D(C–C) < D(C–H) < D(H–H), que fija
   * tests/v23-contratos.test.ts, así que H–H solo decide cuando no baja ningún otro catalizable: 2 H₂ + O₂ → 2 H₂O,
   * 3 H₂ + N₂ → 2 NH₃. Con familia propia el suelo oxida el H₂ que llega sin acelerar con ello la carbonización ni la
   * respiración del resto (enmienda 2; en la 1 compartía la familia 2 con C–C/C–H). Enmienda 3: se compara por par (D/k,
   * la medida con que Q ordena los enlaces de cada elemento), no por enlace, así que entre simples nada cambia; un
   * múltiple decide si su par es el más débil: C≡N (297 por par) frente a H–C (403) en el HCN, C=O (351,5) frente a
   * H–H (436) en 4 H₂ + CO₂. */
  catalisis: FamiliaCatalitica;
  /** Pares de electrones que abre el catalizador, cada uno con la rebaja κ de su familia (`barreraEfectiva`): el mayor,
   * entre los enlaces de la familia `catalisis` que disminuyen, de k (si se corta) o k − k′ (si baja a orden k′); 0 si
   * catalisis = −1 (enmienda 3; hasta su revisión, los del enlace de par más débil, y la cianamida {H–N:2, C–N, C≡N}
   * contaba el 1 de su C–N simple y no salía del suelo, k = 2,4·10⁻²⁸, mientras su isómero carbodiimida iba a 10⁹). Por qué: un catalizador abre un enlace
   * múltiple par a par (adición a cada π, como las nitrilasas y la hidratasa del cianuro con el C≡N), así que la rebaja
   * de un triple es la de tres simples. Sin esto el HCN que deja un fuego pobre en O₂ no tenía salida por debajo de una
   * llama (ea = GAMMA·D(C≡N) = 311,8 y κ = 105: k(295 K) ≈ 2·10⁻²⁸, el 47 % del C acumulado como HCN); con 3·KAPPA_SUELO
   * = 315 ≥ 311,8 el suelo con O₂ lo oxida sin barrera (3 O₂ + 3 HCN → NH₃ + 3 CO₂ + N₂). En enlaces simples es 1 y nada
   * cambia; KAPPA0 = 60 deja el HCN del tubo en 311,8 − 180. */
  paresCatalisis: 0 | 1 | 2 | 3;
}

/** Barrera efectiva (J por cuanto de reacción) de `r` en un lote con catálisis `kappa`, la de `Reaccion`: la catálisis
 * solo rebaja exotérmicas, κ por cada par que abre. La usan P (`pasoLote`, CPU y GPU), el laboratorio y quien estime
 * tasas (W, B, G). */
export const barreraEfectiva = (r: Pick<Reaccion, 'ea' | 'dH' | 'catalisis' | 'paresCatalisis'>, kappa: Kappa): number =>
  r.dH > 0 || r.catalisis === -1 ? Math.max(r.ea, r.dH) : Math.max(0, r.ea - kappa[r.catalisis] * r.paresCatalisis);

/** Nivel con el que reacciona un lote a T K con la catálisis `kappa` (enmienda 2): `nivelDeT(T)`, pero nunca por debajo
 * de NIVEL_CATALIZADO (= 2, 282,84 K) si algún κ > 0; la tasa sigue usando la T real. Por qué y con qué medidas, en
 * naturaleza.ts. Lo aplica P (`pasoLote`; G lo replica): W, B y F solo pasan el κ de su rol. */
export const nivelDeLote = (T: number, kappa: Kappa): number => {
  const n = nivelDeT(T);
  return n < NIVEL_CATALIZADO && (kappa[0] > 0 || kappa[1] > 0 || kappa[2] > 0 || kappa[3] > 0) ? NIVEL_CATALIZADO : n;
};

/** Servicio de un solo escritor en su propio worker. Implementa: Q (`materia/{quimica,servicio}.ts`). Consumen: P, L, W, T1, G. */
export interface ServicioQuimico {
  /** En el hilo del servicio o antes de arrancar (creación del mundo); las sustancias nuevas solo salen de reacciones. */
  internar(enlaces: Uint16Array): SustanciaId;
  sustancia(id: SustanciaId): Readonly<Sustancia>;
  /** Simétrica en (a, b) si b > 0 (b = 0 = unaria). null = no reaccionan; undefined = encolada para la barrera siguiente. */
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
  /** w: depósitos finitos de cada página (mar y cielo), uno por página como el aire. */
  Mar: 12, Cielo: 13,
} as const;
export type Rol = (typeof Rol)[keyof typeof Rol];

/** Lo que las leyes ven de un lote (vistas heredadas, §1.2: no hay adaptador escalar). Implementa: A con P. Consumen: L, W, B, T1, la proyección. */
export interface VistaLote {
  masa: number;          // kg
  T: number;             // K
  fase: 0 | 1 | 2 | 3;   // sólido, líquido, gas, mezcla
  dureza: number; tenacidad: number; sellado: number; aislamiento: number; // [0, 1]
  energia: number;       // J que libera su oxidación completa
  digerible: number;     // J digeribles con [KAPPA0 ×4] (solo exotérmicas: `barreraEfectiva`); con otro κ, el dueño del comedor
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

/** `cuantos` de `esp` (Exacta), de lo que digiere `kappa` (Digerible), de agua (Agua) o el lote entero con su calor (Todo).
 * Todas las partes llevan su parte del calor (la de sus átomos), así que lo movido sale a la T del lote. */
export interface Pedido { parte: Parte; esp: SustanciaId; cuantos: number; kappa: Kappa | null }

/**
 * Libro único de conservación (§1.2), uno por hilo; el motor, la poda y la materia usan este mismo.
 * Cada campo es un Float64Array(NE + 1): las NE primeras posiciones son mmol de átomos por elemento y la última
 * (`ENERGIA`) J de energía química (cuantos × `Sustancia.energia`) más calor.
 * Exactitud: todo asiento, cantidad y calor de un lote es un entero seguro (|v| ≤ 2⁵³ − 1); una operación que daría
 * otra cosa es fatal (I3), nunca se redondea. Para que los asientos no crezcan sin fin ni se acerquen a 2⁵³ al abrir
 * chunks, el coordinador pliega en cada F0: suma los libros de los hilos en bigint, añade fuentes − sumideros a los
 * totales del mundo (`MateriaCheckpoint`) y deja a cero los libros de los hilos, salvo el enVuelo total, que queda en
 * el hilo 0. Así comprueba Σ lotes + Σ enVuelo = inicial + fuentes − sumideros, exacto (I1, I2, I-C), en bigint.
 * Implementa: A (`materia/libro.ts`). Consumen: M1, M4a, M5, W, B, N, 0C (invariantes).
 */
export interface Libro { readonly enVuelo: Float64Array; readonly fuentes: Float64Array; readonly sumideros: Float64Array }
export const ENERGIA = NE;
export const libroVacio = (): Libro =>
  ({ enVuelo: new Float64Array(NE + 1), fuentes: new Float64Array(NE + 1), sumideros: new Float64Array(NE + 1) });

/**
 * Arena de lotes de tamaño fijo sobre el SAB crecible de M1 (ARQ-materia §2), vista por hilo dueño. Solo el dueño de un
 * lote lo modifica (el de su página o el de su organismo; en modo verificar la arena lo comprueba); leer uno ajeno es una
 * carrera tolerada (ARQ-motor §3.3). Lo que entra o sale del mundo pasa por `fuente` y `sumidero`; lo demás se conserva
 * por construcción. Implementa: A (`materia/arena.ts`). Consumen: P, L, W, B, N, F, T1, T2, M4a, M5.
 */
export interface ArenaMateria {
  /** Lote vacío en `celda` (`Terreno.celda`); −1 para los de un cuerpo u objeto llevado, que van con su organismo. */
  nuevo(rol: Rol, celda: number, forma: number): LoteRef;
  /** Libera un lote vacío (sin cuantos ni calor: liberar materia es fatal, I1) en F1, F4 o F5: deja de estar vivo al
   * momento y la ranura solo se reutiliza en barrera con gen++. */
  liberar(l: LoteRef): void;
  vivo(l: LoteRef): boolean;   // false si la referencia caducó
  propio(l: LoteRef): boolean; // vivo(l) y pertenece a este hilo dueño (para validar `Intento.lote` en M5)
  /** En F1, al adoptar un `Migrante`: pasa la propiedad de un lote ligado a organismo (`celda === −1`) a este hilo. */
  adoptar(l: LoteRef): void;
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
  /** Traslado local con la misma selección que `garantizar` (Exacta, Digerible, Agua o Todo, con su parte del calor):
   * evita duplicar la regla de `Parte` entre el mismo dueño y entre dueños. Devuelve los cuantos movidos (Σ de sus sustancias). */
  moverParte(de: LoteRef, a: LoteRef, p: Pedido): number;
  moverCalor(de: LoteRef, a: LoteRef, j: number): number;
  /** Aplica `e` hasta `veces` veces, recortado a existencias y a calor ≥ 0; devuelve las que aplicó. Reacciones (P),
   * síntesis de plantillas (L) y `quemar`. `veces` es un entero seguro ≥ 0: Infinity, NaN, negativos o fracciones son
   * fatales (I3). Los términos con el mismo id se agrupan por lado; el recorte usa las existencias de cada entrada entre
   * su nu total y las entradas se restan antes de sumar las salidas, así que un id que está en los dos lados se compensa
   * sin picos intermedios: solo es fatal (I3) un resultado final que pase de 2⁵³ − 1. */
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
  /** Σ de los lotes vivos de este hilo dueño (`propio`) por posición del libro (NE elementos y energía: química más calor),
   * en bigint. Cuenta todos los suyos, estén donde estén: teselas, aire, mar y cielo, objetos y piezas de cualquier celda,
   * y los ligados a un organismo (`celda === −1`) aunque el organismo duerma archivado con su chunk. Es el «hallado» de la
   * conservación por dueño (w). */
  saldoPropio(): bigint[];
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
  kappa: Kappa;       // J por cuanto de rebaja de barrera del digestivo: C–O, C–N, C–C/C–H, H–H (fundadoras: KAPPA0 ×4)
  captura: number;    // fracción de la luz que fija (plantas)
  masaAdulta: number; // kg
  m0: number;         // kg al nacer
  linaje: number;     // linaje fundador: solo lo leen la proyección y el cliente (decisión 9)
}

/** Gestación con un solo escritor, el dueño de la gestante. La pareja solo aporta su genoma (y pesos de política en
 * personas), leídos del frente al concebir (§1.2), así que sobrevivir al parto no depende de que la pareja siga viva. */
export interface Gestacion {
  embrion: LoteRef;
  otro: number;           // uid de la pareja (frente público)
  genoma: number[];       // alelos, generación y mutaciones (personas) o genes continuos (fauna), sorteados al concebir
  politica?: number[];    // pesos heredados de CEREBRO (`COLUMNAS_CEREBRO.politica`), sorteados al concebir; ausente en fauna
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
