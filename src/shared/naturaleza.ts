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
  /** J por cuanto: enlace simple consigo mismo; en los metales, la cohesión por enlace. */
  dPropia: number;
  /** J por cuanto que suma cada orden de enlace por encima de 1; 0 = no forma enlaces múltiples. */
  pi: number;
  /** mg por cuanto (g/mol). */
  masa: number;
}

/** Una fila por elemento, en el orden de `ELEMENTOS`. */
export const TABLA: readonly ConstantesElemento[] = [
  { valencia: 1, chi: 2.20, dPropia: 436, pi: 0, masa: 1.008 },    // H
  { valencia: 4, chi: 2.55, dPropia: 346, pi: 266, masa: 12.011 }, // C
  { valencia: 3, chi: 3.04, dPropia: 167, pi: 300, masa: 14.007 }, // N
  { valencia: 2, chi: 3.44, dPropia: 142, pi: 352, masa: 15.999 }, // O
  { valencia: 5, chi: 2.19, dPropia: 201, pi: 120, masa: 30.974 }, // P
  { valencia: 4, chi: 1.90, dPropia: 222, pi: 0, masa: 28.085 },   // Si
  { valencia: 2, chi: 1.00, dPropia: 178, pi: 0, masa: 40.078 },   // Ca
  { valencia: 3, chi: 1.83, dPropia: 275, pi: 0, masa: 55.845 },   // Fe
];

// ── Enlaces ──────────────────────────────────────────────────────────────────────────────────────────────

/** J por cuanto por unidad de Δχ²: término iónico de Pauling, D = (D_e + D_f)/2 + PAULING·Δχ² + (k − 1)·√(π_e·π_f). */
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
/** γ: la barrera de una reacción es γ·D del enlace más fuerte que disminuye (adimensional). */
export const GAMMA = 0.35;
/** s: J/(cuanto·K) de entropía por cuanto de molécula gaseosa en los productos; G = −Σd·b − T·s·#gas. */
export const S_GAS = 0.12;
/** ε: J por cuanto de energía libre que un reparto debe ganar a los reactivos para que haya reacción. */
export const EPSILON_G = 1;
/** κ₀: J por cuanto que la digestión de una plantilla fundadora rebaja la barrera de la familia de enlace que rompe. */
export const KAPPA0 = 60;

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

// ── Leyes de uso ─────────────────────────────────────────────────────────────────────────────────────────

/** Tenacidad que se suma a la del blanco al romper (evita dividir por 0): se desprende P·min(1, r²)/(tenacidad + EPS_TENACIDAD). */
export const EPS_TENACIDAD = 0.01;
/** g: fracción de su propia masa que una plantilla puede sintetizar por tick como mucho (copiar). */
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
