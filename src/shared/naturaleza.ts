import { DEMOGRAPHY_TICKS_PER_DAY } from './demography.js';
// ENMIENDA 1 (2026-11-24, «ciclos cerrados»; integrador Claude Opus 5.5 en sprint/v23l-materia, pedidos 3, 6 y 7 de Q
// y los de L): ninguna barrera por debajo de dH; las constantes que eligió Q viven aquí con su intervalo; FRACTURA.
// ENMIENDA 2 (2026-11-24, «ciclos cerrados, validados»; integrador Claude Opus 5.5): KAPPA_SUELO_HH (familia H–H propia),
// la catálisis solo en exotérmicas (`Reaccion` en world/materia/tipos.ts) y NIVEL_CATALIZADO (suelo frío sin HCN).
// ENMIENDA 3 (2026-11-24, «química de principios»; integrador Claude Opus 5.5): `dDosCentros` de los metales (la cohesión
// de la red no se transfiere a un enlace con otro elemento) y χ(Fe) = 1,86; la regla del átomo lineal fuera de anillos y
// la catálisis por pares (`Reaccion.paresCatalisis`) viven en world/materia/{quimica,tipos}.ts.
// ENMIENDA 3, REVISIÓN (2026-11-25): ningún valor cambia; se escribe el alcance de `dDosCentros` (metal–no metal ligero).
/**
 * Constantes de la naturaleza de V23: el ÚNICO fichero con números de física, química y biología elegidos a
 * mano. No son topes: dicen cómo se comporta la materia. Las puertas demográficas solo calibran aquí
 * (PLAN-V23 §4). Los valores son iniciales, tomados de ARQ-materia y leyes-opus o de tablas físicas; los
 * calibran la tabla de cordura de la materia (Q, P, L en la ola 1) y los paneles de las olas 2 y 3.
 *
 * Unidades: 1 cuanto = 1 mmol de unidades de fórmula, así que «J por cuanto» vale lo mismo que kJ/mol y
 * «mg por cuanto» lo mismo que g/mol. Energía en J, temperatura en K, masa de los cuerpos en kg, tiempo en
 * ticks o en días de mundo (2.400 ticks).
 *
 * Consumen: Q y P (química y cinética), L (romper y copiar), W, B y N (cuerpos y natalidad), F (fauna),
 * S (comunidades), E (escucha) y T1 (recetas).
 */

// ── Elementos ────────────────────────────────────────────────────────────────────────────────────────────

/** Los 8 elementos (sale S). Su orden es el índice de todo vector por elemento (`Libro`, `Sustancia.atomos`). */
export const ELEMENTOS = ['H', 'C', 'N', 'O', 'P', 'Si', 'Ca', 'Fe'] as const;
export type Elemento = (typeof ELEMENTOS)[number];
export const NE = ELEMENTOS.length;

export interface ConstantesElemento {
  /** Enlaces que forma: una sola valencia por elemento. */
  valencia: number;
  /** Electronegatividad de Pauling (adimensional). */
  chi: number;
  /** J por cuanto: enlace simple consigo mismo; en los metales, la cohesión por enlace (2·E_coh/valencia). */
  dPropia: number;
  /** J por cuanto: energía de enlace de dos centros, la que el elemento aporta (su mitad) a un enlace con OTRO elemento en
   * la media de Pauling (enmienda 3). En los no metales es dPropia, que ya es un enlace de dos centros (H–H, C–C del
   * etano, O–O del H₂O₂). En un metal, dPropia es la cohesión de la red repartida por enlace, y casi toda es energía de
   * banda: existe solo entre átomos de metal, como la energía de red solo entre iones (E_red), y no la hereda un enlace
   * M–X; lo que el metal sí aporta es su enlace de dos centros, el del dímero M₂ (D₀ medido). Sin esto la fórmula de Pauling
   * da a todo compuesto metal–no metal una entalpía de formación ≤ 0 (−PAULING·Δχ² por enlace): el carburo C₃Fe₄ salía
   * exotérmico (−186) y ganaba al hierro en cualquier fuego (fila 7 de la tabla de cordura), cuando el Fe₃C real es
   * endotérmico (+25 kJ/mol).
   * Alcance (validación de la enmienda 3, hallazgo 2): la regla es de principio para metal–no metal ligero (H, C, N, O).
   * También debilita los enlaces de un metal con P o Si y los de dos metales, y ahí deja compuestos inestables que el
   * mundo de hoy no forma: 2 FeP → P₂ + Fe₂ (dH −432, k 5·10⁻²/tick a 295 K sin catálisis), CaSi → Si + Ca (dH −8) y
   * Ca–Fe 133 frente a 354. Si T1 añade aleaciones, siliciuros o fosfuros, esos enlaces necesitan su propia media (de
   * dPropia o medida), no esta. La ventana que pasa la fila 7 es estrecha: dDosCentros(Fe) en [102, 119] y χ(Fe) en
   * [1,845, 1,870] (la de Pauling, 1,83, la falla). */
  dDosCentros: number;
  /** J por cuanto que suma cada orden de enlace por encima de 1; 0 = no forma enlaces múltiples. */
  pi: number;
  /** mg por cuanto (g/mol). */
  masa: number;
}

/** Una fila por elemento, en el orden de `ELEMENTOS`. Con un mundo creado, las valencias y qué π son 0 ya no cambian:
 * fijan cuántos `TIPOS` hay y sus índices, que son la clave de toda sustancia guardada. Los demás valores se calibran. */
export const TABLA: readonly ConstantesElemento[] = [
  { valencia: 1, chi: 2.20, dPropia: 436, dDosCentros: 436, pi: 0, masa: 1.008 },    // H
  { valencia: 4, chi: 2.55, dPropia: 346, dDosCentros: 346, pi: 266, masa: 12.011 }, // C
  { valencia: 3, chi: 3.04, dPropia: 167, dDosCentros: 167, pi: 300, masa: 14.007 }, // N
  { valencia: 2, chi: 3.44, dPropia: 142, dDosCentros: 142, pi: 352, masa: 15.999 }, // O
  { valencia: 5, chi: 2.19, dPropia: 201, dDosCentros: 201, pi: 15, masa: 30.974 },  // P (con k·PAULING: P=O = 546 ≈ 544 real y < 2·P–O = 644)
  { valencia: 4, chi: 1.90, dPropia: 222, dDosCentros: 222, pi: 0, masa: 28.085 },   // Si
  // Ca: cohesión 178 = E_coh real; dDosCentros = D₀(Ca₂) ≈ 0,13 eV (dímero de van der Waals). Como cada Ca de una red
  // no metálica tiene sus 2 enlaces con otros elementos, el cambio desplaza igual todo Ca–X y no mueve ninguna reacción
  // entre compuestos de Ca (calcinar, fraguar, fosfatos); solo encarece frente al Ca metálico, que no aparece. Medido: la
  // tabla de cordura pasa entera con dDosCentros(Ca) en todo [0, 178]; 13 es la D₀ física, no una calibración.
  { valencia: 2, chi: 1.00, dPropia: 178, dDosCentros: 13, pi: 0, masa: 40.078 },
  // Fe: cohesión 1,5·275 = 412,5 ≈ E_coh real (413); dDosCentros = D₀(Fe₂) ≈ 1,14 eV. χ = 1,86 (Pauling real 1,83) deja
  // Fe–O = 126 + 96,5·1,58² = 367: el carbón reduce Fe₂O₃ desde 1.133 K (102 J por O frente a 0,09·T de CO₂), en el nivel
  // 10 (horno, desde 1.131 K) y no en el 8 (fogata) ni en el 9 (llama). Fe–C = 274 < (275 + 346)/2: ningún carburo gana
  // al hierro y al carbón por separado (C₃Fe₄, +438), y Fe–H = 284 (sin hidruro). Intervalos (barrido de la tabla de
  // cordura, enmienda 3): la fila 7 pide D(Fe–O) ∈ [363, 371] (reduce entre 1.037,5 y 1.233,8 K: 12·D − 3.792 = 0,54·T) y
  // D(Fe–C) ≤ 310 (sin carburo); con dDosCentros 110, χ ∈ [1,845, 1,870]; con χ 1,86, dDosCentros ∈ [102, 119].
  { valencia: 3, chi: 1.86, dPropia: 275, dDosCentros: 110, pi: 0, masa: 55.845 },
];

// ── Enlaces ──────────────────────────────────────────────────────────────────────────────────────────────

/** J por cuanto por unidad de Δχ²: término iónico de Pauling por orden k, D = (D_e + D_f)/2 + k·PAULING·Δχ² + (k − 1)·√(π_e·π_f).
 * Con energías solo aditivas no había caliza: CaCO₃ → CaO + CO₂ tenía dH = 2·D(C–O) − D(C=O) = −63. Resuelto en la
 * enmienda 1 sin tocar PAULING: las unidades iónicas suman la energía de red E_red (`E_RES_IONICO`, `E_HID_IONICO`,
 * `Sustancia.energia`), con la que la caliza aguanta a 295 K, calcina en horno y la cal fragua. */
export const PAULING = 96.5;
/** Orden máximo de un enlace (triple). */
export const ORDEN_MAX = 3;
/** Δχ desde el que un enlace es iónico: la sustancia que lo tiene es unidad de red, nunca molécula. */
export const DCHI_IONICO = 1.7;

// ── Termodinámica y cinética ─────────────────────────────────────────────────────────────────────────────

/** J/(cuanto·K): constante de los gases (8,314 J/(mol·K)), para Arrhenius. */
export const R = 0.008314;
/** J/(K·cuanto de átomos): capacidad calorífica por átomo (Dulong–Petit); T = calor/(CAPACIDAD_ATOMO·átomos). */
export const CAPACIDAD_ATOMO = 0.025;
/** ν: factor de frecuencia de Arrhenius, en L/(cuanto·tick) entre dos sustancias y en 1/tick para una sola. */
export const NU = 1e9;
/** γ: la barrera de una reacción es γ·D del enlace más fuerte que disminuye, contados todos (también O=O y O–H),
 * adimensional (reglas completas en `Reaccion.ea`). La paga la cinética de P, no `quemar`. Con O₂ manda O=O (494,
 * ea = 173): sin κ el combustible aguanta en frío (k(295 K) ~ 10⁻²²/tick) y arde en un fuego (k(1.100 K) ~ 6/tick). */
export const GAMMA = 0.35;
/** s: J/(cuanto·K) de entropía por cuanto de molécula gaseosa en los productos (CO₂/H₂O/O₂/N₂ reales ≈ 0,19–0,21); G = −Σd·b − T·s·#gas. */
export const S_GAS = 0.18;
/** ε: J por cuanto de energía libre que un reparto debe ganar a los reactivos para que haya reacción. */
export const EPSILON_G = 1;
/** κ₀: J por cuanto que la digestión de una plantilla fundadora rebaja la barrera de cada una de sus 4 familias de enlace
 * (`Kappa`, `Reaccion.catalisis`; solo en exotérmicas). A 310 K, una ruta cuya barrera ponga C–N va a ~400/tick y una de
 * C–O a ~2/tick; si la pone C–H, O–H u O=O (carbonizar o dismutar CH₂O, oxidar) queda en ~2·10⁻⁵/tick o menos: B y Q la
 * calibran contra las rutas que dé `productos()`. Se queda en 60: antes de la enmienda 2, con 105 el tubo soltaba el 3 %
 * del H como H₂ y la caja perdía el 4 % del agua; con la enmienda 2 ya no (0,09 % y 99,1 %, 400 recambios), así que hoy
 * lo fija la digestión, no el ciclo del H. En H–H, 2 H₂ + O₂ queda en ~10⁻¹⁰ L/(cuanto·tick). Enmienda 3 (κ por par):
 * el HCN del tubo queda en 311,8 − 3·60 = 131,8 (no se digiere; lo haría desde 3·κ₀ ≳ 260, κ₀ ≳ 87). La tabla de cordura
 * pasa con κ₀ en todo [0, 120]: no la ata. */
export const KAPPA0 = 60;
/** κ del suelo (descomposición microbiana a ~295 K) en las familias C–O, C–N y C–C/C–H de los lotes Suelo y Cadaver: la
 * oxidación con O₂ va a ~10⁻³ L/(cuanto·tick) (cientos de ticks con [O₂] ≈ 5 mmol/L; con KAPPA0 quedaría en ~10⁻¹¹ y el
 * suelo no devolvería nada) y las rutas exotérmicas sin O₂ (madera → H₂O + C, proteína → NH₃ + C) a ~400/tick. Las
 * endotérmicas no se catalizan (enmienda 2): CH₂ → H₂ + C (dH +24) y madera + H₂O → 2 H₂ + CO₂ (+102) quedan en su tasa
 * sin catálisis, < 10⁻¹⁵. Con κ ≥ ea y dH ≤ 0, la tasa satura en ν. Enmienda 3: κ por par del enlace que decide la
 * familia, así que el HCN (C≡N, 3 pares) se oxida con O₂ sin barrera, 3·105 = 315 ≥ GAMMA·D(C≡N) = 311,8.
 * Intervalo en la tabla de cordura: [100, ≥ 200] (barrido de la enmienda 3). El piso lo pone el carbón del suelo con O₂,
 * k > 10⁻⁴: b < R·T·ln(10¹³) = 73,4, κ > 172,9 − 73,4 = 99,5. La salida del HCN pide k > 10⁻²: 311,8 − 3κ < 62,1, κ > 83,2,
 * y no ata. */
export const KAPPA_SUELO = 105;
/** κ del suelo en la familia H–H (bacterias del hidrógeno; las hidrogenasas del suelo son el sumidero principal del H₂
 * atmosférico real): ≥ GAMMA·D(O=O) = 172,9, así que 2 H₂ + O₂ → 2 H₂O no tiene barrera en un suelo con O₂ y el H₂ que
 * llega al suelo se oxida al paso (con KAPPA_SUELO tardaba ~120 ticks y el aire, que no cataliza, lo acumulaba en
 * proporción a su volumen: un mundo con mucho aire por poro se secaba). La misma familia lleva 3 H₂ + N₂ → 2 NH₃ (ea
 * 268,4: ~3·10⁻⁸ L/(cuanto·tick), fijación lenta). Desde la enmienda 3 (familia por par) el H₂ con CO₂ va por la familia
 * C–O con 2 pares (C=O, 351,5 por par < H–H 436): a 295 K Q no da reacción; a 259 K, 2 H₂ + CO₂ → 2 H₂O + C, pero un lote
 * catalizado no reacciona por debajo del nivel 2 (`NIVEL_CATALIZADO`).
 * Intervalo [~120, ∞): medido con la caja de la validación con aire 100 veces mayor y sin herbívoro (1.000 recambios), el
 * H₂ final es el 1,99 % del H con 105 (k(295 K) ≈ 10⁻³ L/(cuanto·tick)), 0,0588–0,0589 % con 120, 130 y 140 (con 120,
 * k ≈ 0,4) y 0,0587–0,0588 % con 160 y 175 (estable); en la caja del autor (200 recambios), 0,0006–0,0008 % con 175, 250
 * y 300. Desde 172,9 la barrera es 0 y ya no cambia nada; 175 deja ese margen. */
export const KAPPA_SUELO_HH = 175;
/** Nivel de temperatura (world/materia/tipos.ts, `nivelDeT`) mínimo con el que elige productos un lote con algún κ > 0
 * (enmienda 2, `nivelDeLote`): un suelo, un cadáver o un digestivo por debajo de 282,84 K (frontera del nivel 2)
 * reacciona con los productos del nivel 2 y a la tasa de su T real (más lenta). Por qué: el nivel 1 se calcula a 259,4 K
 * y en el modelo el NH₃ hierve a 273,6 K (el real, a 240 K), así que ahí deja de contar como gas; el mínimo de G de la
 * proteína pasa a ser H₂ + HCN (dH +39) y NH₃ + orgP → H₂ + HCN + HPO₃ (dH −86) va catalizado a ~2·10⁴ L/(cuanto·tick)
 * en el suelo, y el HCN no tiene salida por debajo de una llama (ea 311,8: k ≤ 10⁻¹⁷ aun catalizado), un sumidero
 * absorbente de C, N y H. En el nivel 2 (308,4 K) el NH₃ es gas y la proteína da NH₃ + C. Medido con la caja de la
 * validación: con el piso, el suelo a 275 K todo el tiempo y las estaciones de 200 y de 2.400 ticks a 275 K cierran a 400
 * recambios (biomasa ≥ 96.600, HCN 0; a 260 K la planta queda limitada por el CO₂, biomasa 32.727, con el carbono
 * enterrado como C, sin deriva); sin el piso, a 275 K colapsa en 9 recambios y, con plantas que fijan N₂, el HCN se lleva
 * el 8–13 % del carbono en 400 recambios y sigue subiendo; sin catálisis en frío (la otra salida), el frío permanente
 * colapsa en 8 recambios y las estaciones de 2.400 ticks en 31 (nada devuelve el P). */
export const NIVEL_CATALIZADO = 2;

// ── Propiedades por estructura ───────────────────────────────────────────────────────────────────────────

/** Coordinación media del núcleo desde la que una red es rígida (umbral de Maxwell). */
export const R_RIGIDEZ = 2.4;
/** Ancho de esa transición: dureza = (D̄/D_máx)·clamp((r − R_RIGIDEZ)/ANCHO_RIGIDEZ). */
export const ANCHO_RIGIDEZ = 1.6;
/** K por (J/cuanto): fusión de una red, T_f = FUSION_RED·(r − 1)·D̄. */
export const FUSION_RED = 2.9;
/** K por √(g/mol): término de masa de la ebullición de una molécula, T_eb = EBULLICION_MASA·√M + EBULLICION_POLAR·Σ(Δχ)². */
export const EBULLICION_MASA = 15;
/** K: término polar de la ebullición, sobre los Δχ² de sus enlaces con H. */
export const EBULLICION_POLAR = 100;
/** Fracción de volumen desde la que la fase rígida endurece el lote entero (percolación). */
export const PERCOLACION = 0.3;

// ── Química por estructura: constantes que eligió Q (enmienda 1) ─────────────────────────────────────────────
// Cada intervalo se midió (2026-11-24, 100 corridas) moviendo solo esa constante con las demás fijas: dentro, las 7 filas
// verdes de la tabla de cordura de `scripts/lab-materia.mts` siguen verdes (la 7, hierro, y la 8, C estable, están rojas
// con cualquier valor: no dependen de estas constantes), I4 sin violaciones y las dos cajas cerradas de
// tests/lib/caja-cerrada.ts (40 recambios, sin y con fuego) cumplen (balance exacto, agua ≥ 97 %, H₂ < 0,5 % del H y
// estable). «Probado» marca un extremo de la rejilla, no una frontera: ninguna fila la encontró.
/** J por cuanto y por puente M–X–Y=X: energía de red de un oxoanión resonante (CaCO₃, CaHPO₄), parte de E_red. Sin ella
 * CaCO₃ → CaO + CO₂ tiene dH = −63 y no hay caliza; con 135, +207, y calcina en el nivel 10. Intervalo: [110, 137]
 * (fuera falla la fila de la cal; con ≤ 108 la caja además pierde el 4 % del agua). */
export const E_RES_IONICO = 135;
/** J por cuanto y por puente M–X–H: energía de red de un hidróxido iónico (CaO + H₂O → Ca(OH)₂, dH = −100). Intervalo:
 * [1, 75] (con 0 o ≥ 80 la cal falla; con ≥ 80 la caja pierde el 4 % del agua). */
export const E_HID_IONICO = 50;
/** J por cuanto: rebaja de la barrera al abrir un enlace π sobre un sólido iónico sin perder ningún σ (CaO + CO₂, fraguado
 * del mortero a 295 K). Es una calibración de la cal, no un principio general. Intervalo: ≥ 67
 * (con 66 el mortero no fragua a 295 K), probado hasta 200. */
export const E_CAT_IONICO = 75;
/** Adimensional: T_f/T_eb de una molécula (regla de Beaman–Walden), agua líquida en [271, 371] K. Intervalo:
 * [0,45 probado, 0,79]: el agua se hiela a 295 K desde 295/371 = 0,795. */
export const FUSION_MOLECULA = 0.73;
/** µL por cuanto (mL/mol) de cada átomo en fase condensada, en el orden de `ELEMENTOS`: fija la densidad y, con ella, el
 * volumen y las concentraciones de lo condensado en P. Intervalo: todos ×[0,25; 4], probado entero (ninguna fila ni la
 * caja lo acotan: el volumen de la caja lo pone el gas). */
export const VOLUMEN_ATOMO: readonly number[] = [5.0, 7.0, 7.5, 7.5, 15.0, 12.0, 18.0, 8.5];
/** Adimensional: fracción de volumen que ocupa una red, EMPAQUETADO_BASE + EMPAQUETADO_POR_R·min(4, r) (las moléculas, 1).
 * Intervalos: [0,35; 0,95] y [0; 0,4], probados enteros (solo cambian densidades). */
export const EMPAQUETADO_BASE = 0.65;
export const EMPAQUETADO_POR_R = 0.15;
/** Adimensional: tenacidad de una red = TENACIDAD_RED·exp(−((r − R_RIGIDEZ)/TENACIDAD_ANCHO)²) + TENACIDAD_METAL·fracción
 * de enlaces metálicos. Intervalos: [0; 1], [0,2; 2,4] y [0; 1], probados enteros: la química no las acota (solo entran
 * en `romper`); las calibran W, F y T1 con sus paneles, como FRACTURA. */
export const TENACIDAD_RED = 0.6;
export const TENACIDAD_ANCHO = 0.8;
export const TENACIDAD_METAL = 0.4;

// ── Leyes de uso ─────────────────────────────────────────────────────────────────────────────────────────

/** Tenacidad que se suma a la del blanco al romper (evita dividir por 0): se desprende P·min(1, r²)/(tenacidad + EPS_TENACIDAD). */
export const EPS_TENACIDAD = 0.01;
/** Adimensional: J que cuesta desprender un cuanto = FRACTURA·D̄ de sus enlaces (cohesión de `romper`). Con 1 se paga
 * romper cada enlace del fragmento, unas 100–1.000 veces más de lo real (una fractura solo corta los de su superficie): la
 * calibran W, F y T1 con sus paneles (talar, cavar, tallar); ninguna fila de cordura de la materia la acota. */
export const FRACTURA = 1;
/** g: fracción máxima de su masa que una plantilla sintetiza por tick al crecer; en gestación (embrión desde 0) es
 * fracción de `Plantilla.m0`, lo que fija T_min = 1/G_SINTESIS = 1.200 ticks (0,5 días). */
export const G_SINTESIS = 1 / 1200;
/** J por kg y celda: moverse cuesta C_MOVER·(masa + carga)·distancia, pagado con `quemar` (cargar no tiene tope). */
export const C_MOVER = 50;

// ── Biología ─────────────────────────────────────────────────────────────────────────────────────────────

/** η: de la energía quemada para sintetizar tejido, fracción que queda en enlaces; el resto sale como calor. */
export const ETA = 0.5;
/** m0: masa al nacer como fracción de la masa adulta (en las plantillas fundadoras, `Plantilla.m0 = M0·masaAdulta`). */
export const M0 = 0.05;
/** Salud (tejido/plantilla) mínima para ser fértil. */
export const SALUD_FERTIL = 0.55;
/** Días seguidos con la reserva por debajo del gasto basal de un día que provocan el aborto (los átomos vuelven al digestivo). */
export const DIAS_ABORTO = 1;
/** τ, en días: un vínculo decae como v·e^(−Δt/τ). */
export const TAU_VINCULO = 2;
/** θ: vínculo mutuo mínimo para concebir y para que dos personas queden en la misma comunidad. */
export const THETA_VINCULO = 0.3;
/** Por debajo de este valor un vínculo se borra: limpieza numérica, no tope. */
export const VINCULO_MINIMO = 0.01;
/** Mortales que hacen falta para que una componente de vínculos sea comunidad: es la definición, no un tope. */
export const MORTALES_COMUNIDAD = 3;
/** Solape con una componente previa desde el que la comunidad conserva su identidad. */
export const SOLAPE_IDENTIDAD = 0.5;
/** celdas: distancia a la que dos personas conviven (la misma a la que ya se comparte comida). Carril s. */
export const RADIO_CONVIVENCIA_CELDAS = 2;
/** Días: τ_m de una receta = TAU_RECETA_BASE + TAU_RECETA_APRENDIZAJE·learningRate (heredable). */
export const TAU_RECETA_BASE = 1;
/** Días por unidad de learningRate en τ_m. */
export const TAU_RECETA_APRENDIZAJE = 4;
/** Fuerza por debajo de la cual se olvida una receta. */
export const OLVIDO_RECETA = 0.05;
/** Ticks: vida máxima L = VIDA_L0·masa^VIDA_EXPONENTE con la masa en kg (≈ las edades de hoy de liebre, ciervo y lobo). */
export const VIDA_L0 = 12500;
/** Exponente alométrico de la vida máxima. */
export const VIDA_EXPONENTE = 0.25;
/** α: habituación junto a agentes grandes sin alarma, h += ALFA_HABITUACION·(1 − cautela)·(1 − h). */
export const ALFA_HABITUACION = 0.01;
/** Probabilidad por tick de abandonar un mensaje oído: (1 − escucha)·RIESGO_ABANDONO. */
export const RIESGO_ABANDONO = 0.001;

// ── Carril b: el cuerpo de átomos (`world/materia/cuerpo.ts` las reexporta) ─────────────────────────────────

/** K: temperatura que el termostato del cuerpo defiende. */
export const T_CUERPO = 310;
/** J por kg de tejido y tick: gasto de mantenimiento. 45 son 6,5 MJ al día en 60 kg (W ancla la ingesta en 8,4 MJ al día). */
export const BASAL_J_KG_TICK = 45;
/** J por kg de tejido: energía de la reserva llena (hambre 0). Dos días de mantenimiento: con media reserva queda un día
 * de basal, el umbral de `DIAS_ABORTO`. */
export const RESERVA_OBJETIVO_J_KG = 216_000;
/** kg de agua libre por kg de tejido con sed 0 (2,4 kg en 60 kg: lo que una persona bebe en un día, el ancla de W). */
export const AGUA_OBJETIVO_KG_KG = 0.04;
/** Cuantos de un gas que la reserva guarda por kg de tejido y unidad de fracción molar en el aire (solubilidad). */
export const CAPACIDAD_GAS_KG = 14;
/** Fracción molar de O₂ del aire de referencia: con ella la reserva llena de O₂ da energía 1. */
export const FRACCION_O2_REFERENCIA = 0.21;
/** 1/tick: ventilación pulmonar, la fracción e-ésima del desequilibrio de gases que se cierra en un tick (36 s). */
export const VENTILACION = 1;
/** J/(K·tick·kg^⅔): conductancia de la piel por unidad de superficie (masa^⅔), cerrada y abierta. El termostato elige
 * entre las dos; por debajo de la mínima el cuerpo tirita (quema reserva) y por encima de la máxima suda. */
export const CONDUCTANCIA_PIEL_MIN = 6;
export const CONDUCTANCIA_PIEL_MAX = 40;
/** Fracción del gasto de mantenimiento que sale evaporando agua por la respiración y la piel (en reposo, ~0,25). */
export const FRACCION_EVAPORATIVA = 0.25;
/** J/(cuanto·K): regla de Trouton, ΔH_vap = TROUTON_J·T_eb (la misma que usa W para el vapor). */
export const TROUTON_J = 0.088;
/** Ticks: tiempo medio de tránsito del tubo digestivo (6 h de un día de 2.400 ticks). */
export const TRANSITO_TICKS = 600;
/** Capacidad osmótica del tubo sobre la de la reserva: en equilibrio el tubo retiene esa parte del agua libre. */
export const REPARTO_AGUA_TUBO = 0.05;
/** 1/tick: conductancia osmótica de la pared del tubo por unidad de su capacidad (lo bebido pasa en ~14 ticks). */
export const ABSORCION_AGUA = 0.05;
/** kg: masa adulta de la plantilla humana fundadora. */
export const MASA_ADULTA_HUMANA = 60;
/** J por cuanto: κ de la plantilla humana por familia (C–O, C–N, C–C/C–H, H–H). El porqué, en la cabecera. */
export const KAPPA_HUMANA: readonly [number, number, number, number] = [KAPPA0, 72, 110, KAPPA0];
/** Unidad del tejido humano en cuantos: 61 % de agua, 17 % de proteína, 14 % de grasa y 8 % de fósforo orgánico en masa. */
export const UNIDAD_HUMANA = { H2O: 40, proteina: 7, CH2: 12, orgP: 1 } as const;
/** Linaje de la plantilla humana (solo lo leen la proyección y el cliente). */
export const LINAJE_HUMANO = 0;

// ── Carril f: la fauna sobre átomos (cada fichero de f las reexporta) ─────────────────────────────────────

// soa/alarma.ts
/** Ticks: vida media (1/e) de la alarma de una celda. El olor de la sangre y el recuerdo de un ataque duran unas horas:
 * 240 ticks ≈ 2,4 h de mundo (2.400 ticks por día); el `lastHunted < 120` de hoy era la mitad. */
export const TAU_ALARMA = 240;
/** Celdas: alcance del aviso de una muerte violenta (olor, gritos). Cae como 1/(1 + d²) con la distancia d. */
export const RADIO_ALARMA = 6;

// decision/fauna.ts
/** m²·kg^(−2/3): huella = HUELLA_FORMA·masa^(2/3) (sección de un cuerpo de densidad ≈ agua, tumbado o de pie). */
export const HUELLA_FORMA = 1;
/** m²: superficie de una celda para la huella (10 m × 10 m). El mundo no fija metros por tesela; solo la fauna los
 * necesita, y solo como cociente huella/área. */
export const AREA_CELDA = 100;
/** celdas/(tick·kg^VELOCIDAD_EXPONENTE): velocidad de crucero v = VELOCIDAD_L0·masa^VELOCIDAD_EXPONENTE·(½ + gen). */
export const VELOCIDAD_L0 = 0.25;
/** Exponente alométrico de la velocidad máxima de carrera (≈ 0,17 en mamíferos terrestres). */
export const VELOCIDAD_EXPONENTE = 0.17;
/** celdas: radio de visión r = RADIO_VISTA_MIN + RADIO_VISTA_GEN·percepción (2–6, como hoy). */
export const RADIO_VISTA_MIN = 2;
export const RADIO_VISTA_GEN = 4;
/** Alarma por debajo de la cual una celda cuenta como tranquila para habituarse (leyes-opus §3e «alarma ≈ 0»). */
export const ALARMA_CALMA = 0.01;
/** 1/tick: olvido de la habituación sin agentes grandes cerca, h −= OLVIDO_HABITUACION·h (vida media ≈ 3 días). */
export const OLVIDO_HABITUACION = 1 / 10000;
/** Distancia genética máxima para que dos animales críen (Σ |Δgen| en [0, 1] + |Δ ln masa| + 2·|Δ acuático|): los dos
 * fundadores más parecidos (ciervo y jabalí) quedan a 0,62; dos hermanos, a menos de 0,1. */
export const DISTANCIA_CRUCE = 0.5;

// ley-fauna.ts
/** kg/(tick·kg^0,75): lo que una boca mete al tubo por tick. Un ciervo de 80 kg come ≈ 2,5 kg al día en la mitad de
 * las horas: 80^0,75·8·10⁻⁵·1.200 ≈ 2,6 kg. */
export const TASA_INGESTA = 8e-5;
/** kg/(tick·kg^0,75): lo que bebe por tick quien está junto al agua (beber va a sorbos rápidos: 2,5 × la ingesta). */
export const TASA_BEBER = 2e-4;
/** kg de contenido del tubo por kg de cuerpo con el tubo lleno (rumiantes ≈ 0,15; carnívoros ≈ 0,06). */
export const CAPACIDAD_DIGESTIVO = 0.1;
/** kg de agua por kg de cuerpo: convierte la sed (fracción de déficit) en kg que beber. */
export const AGUA_CORPORAL = 0.65;
/** J por kg del que muerde y por tick de contacto, a carnivoría 1: la potencia muscular de un ataque (≈ 3 W/kg
 * sostenidos durante los 36 s de un tick). */
export const TRABAJO_MORDISCO = 100;
/** Fracción de la masa adulta desde la que un animal es fértil (la madurez sexual de los mamíferos llega al 50–70 %). */
export const MADUREZ_MASA = 0.6;
/** Anchura (uniforme, centrada) de la mutación de un gen en [0, 1] al concebir. */
export const MUTACION_GEN = 0.03;
/** Anchura de la mutación de ln(masa adulta) al concebir: ±2,5 % de masa. */
export const MUTACION_LNMASA = 0.05;
/** Resolución de ln(masa adulta) con que se registra una plantilla (≈ 4 % de masa): dos genomas que solo difieren por
 * debajo comparten plantilla, así el registro no crece con cada cría. */
export const PASO_LNMASA = 1 / 24;
/** Resolución de la carnivoría con que se fija la κ de una plantilla (κ entera en J por cuanto). */
export const PASO_CARNIVORIA = 1 / 32;

// actuar/caza.ts
/** kg/(tick·kg^0,75) que unas manos sacan al ordeñar o esquilar: la misma escala que comer (`TASA_INGESTA` de la fauna)
 * por seis, porque se saca de un animal que no se resiste. */
export const TASA_EXTRACCION = 5e-4;

// ── Carril t1: la técnica sobre lotes (`world/materia/proceso.ts` y `world/technology.ts` las reexportan) ─────

// materia/proceso.ts
/** W: potencia de trabajo sostenido de una persona (trabajo mecánico pagado con `pagar`). */
export const POTENCIA_TRABAJO = 75;
/** s por tick (DEMOGRAPHY_TICKS_PER_DAY = TICKS_PER_DAY ticks por día). */
export const SEGUNDOS_TICK = 86400 / DEMOGRAPHY_TICKS_PER_DAY;
/** J/kg: trabajo de juntar y apretar un kg de materia en el lote que se trabaja (levantar, amasar). */
export const TRABAJO_UNIR = 100;
/** J/(K·tick): conductancia entre un fuego y el lote que se le pone al lado (h ≈ 100 W/(m²·K) de llama, A ≈ 0,05 m²). */
export const G_FUEGO = 100 * 0.05 * SEGUNDOS_TICK;
/** J/(K·tick): conductancia entre el agua y el lote sumergido (h ≈ 500 W/(m²·K), A ≈ 0,05 m²). */
export const G_AGUA = 500 * 0.05 * SEGUNDOS_TICK;
/** ticks: constante de tiempo con que un lote poroso se empapa (≈ 30 min). */
export const TAU_MOJAR = 50;
/** J: calor de ignición que pone quien enciende un fuego a mano (≈ 30 W de fricción durante un minuto). */
export const J_ENCENDER = 2000;

// technology.ts
/** kg/kg: carga a cuestas sobre la masa del cuerpo que una persona soporta (leyes-opus §3d). */
export const CARGA_MASA = 0.4;
/** L/L: volumen a cuestas sobre el del cuerpo (leyes-opus §3d). */
export const CARGA_VOLUMEN = 0.3;
/** kg/L: densidad media de un cuerpo (para su volumen). */
export const DENSIDAD_CUERPO = 1;
/** ticks: duración media de calentar o mojar en un paso propuesto al investigar (≈ 1 h). */
export const DURACION_PASO = 100;
/** Probabilidad de partir de una receta recordada al investigar, y de cruzarla con otra (búsqueda de programas de la V22). */
export const PROB_VARIAR_CONOCIDA = 0.72;
export const PROB_CRUZAR = 0.35;

// ── Carril act: el tick de las personas sobre materia (`world/actuar/*.ts` y `world/whispers.ts` las reexportan) ─

// actuar/recursos.ts
/** kg de alimento que una persona adulta traga en un tick de comer (un bocado de ≈ 10 g cada 36 s de mundo). */
export const BOCADO_KG = 0.01;
/** kg de agua que una persona adulta bebe en un tick de beber (≈ 50 mL por sorbo largo). */
export const SORBO_KG = 0.05;
/** kg de alimento que deja a cuestas una tarea completa de forrajear. */
export const FORRAJEO_KG = 0.5;
/** kg de madera o de piedra que pesa una unidad de `Person.materials`: la vista escalar de lo que lleva a cuestas. */
export const KG_POR_UNIDAD_MATERIAL = 5;
/** Exponente de escala del bocado con la masa del cuerpo (Kleiber): una cría traga menos que un adulto. */
export const EXPONENTE_BOCADO = 0.75;

// actuar/trabajo.ts
/** J de trabajo que una persona hace en un tick de tarea: su potencia sostenida (t1, `POTENCIA_TRABAJO`) por la
 * duración del tick. */
export const TRABAJO_J_TICK = POTENCIA_TRABAJO * SEGUNDOS_TICK;
/** Celdas a las que alcanza un golpe o una mano: quien caza o esquila tiene que estar junto al animal. */
export const ALCANCE_MANO = 1.5;
/** kg de carne que quien caza se lleva a cuestas del cadáver; el resto queda en la celda para quien llegue. */
export const CARNE_A_CUESTAS_KG = 2;

// whispers.ts (RADIO_AUDIBLE se queda allí: deriva de ALCANCE_VOZ)
/** Fracción de la audibilidad junto al mensaje por debajo de la cual el oído ya no la distingue del ruido (adimensional). */
export const CAIDA_AUDIBLE = 1e-3;

// ── Carril m7: reparto por tiempo de pared (`world/motor/rebalanceo.ts` las reexporta) ─────────────────────

/** Periodo del rebalanceo regular, en ticks. */
export const PERIODO_REBALANCEO_TICKS = 240;
/** Ventanas de medida consecutivas con desequilibrio por encima del umbral que fuerzan un rebalanceo antes de plazo. */
export const VENTANAS_DESEQUILIBRADAS = 3;
/** Umbral de desequilibrio (máximo de ms de pared de un hilo sobre su media; 1 = perfecto, sin unidad). */
export const UMBRAL_DESEQUILIBRIO = 1.3;
/** Fracción de T que `hilosAuto` compara contra T (sin unidad): T y ¾T. */
export const FRACCION_HILOS_MENOS = 0.75;
/** Diferencia relativa de Hz por debajo de la cual dos números de hilos cuentan como empate; gana el menor, que deja
 * más CPU a la torre (sin unidad). */
export const MARGEN_EMPATE_HZ = 0.02;
/** Peso de la última ventana en la media móvil del coste por chunk (sin unidad, en (0, 1]). */
export const PESO_EMA = 0.25;
/** Cota del retraso relativo de un hilo (asignado / pared): ni un hilo con medida absurda se queda sin chunks ni uno
 * ganador acapara todo el reparto (sin unidad; el peso va en [COTA_RETRASO, 1 / COTA_RETRASO]). */
export const COTA_RETRASO = 0.25;

// ── Carril vmapa: constantes físicas del mapa (`client/terrain-field.ts` y `client/structure-art.ts` las reexportan) ──

/** Punto de Draper (K): un sólido empieza a verse al rojo en la penumbra. */
export const PUNTO_DRAPER_K = 798;
/** Fusión del hielo (K): el agua superficial por debajo se pinta escarchada. */
export const FUSION_HIELO_K = 273.15;
/** Pendiente de un montón suelto (alto sobre radio): ángulo de reposo de ~27° de la grava y el grano. */
export const PENDIENTE_MONTON = 0.5;
