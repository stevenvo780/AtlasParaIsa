/**
 * Mundo material (carril W; ARQ-materia §2 y §5.1): el estado de las teselas en lotes de átomos y las leyes que lo hacen
 * avanzar con la librería de materia. Tiene dos anfitriones con la misma física:
 *  - el laboratorio (`levantar`, `conectar`): un conjunto fijo de teselas sobre una arena propia, repartido entre hilos;
 *  - el motor (`sobre`): la arena, la química y el libro del dueño (`CtxLeyMateria`), con páginas que se dan de alta al
 *    activarse un chunk (`materializar`, `adoptar`) y se duermen al retirarse (`dormir`) sin perder sus lotes.
 *
 * Por tesela: Suelo (κ del suelo), Agua si es un vaso (charca, manantial, humedal) y Vida (hoja, fruto y tronco en un solo
 * lote, ver vistas.ts). Por página de 16 × 16: un lote de Aire (la columna de gases; el vapor solo cabe en su capa límite)
 * y dos depósitos de agua finitos, que son lotes y por eso están en el libro: el cielo (la atmósfera libre que le toca a
 * la página, con sus gases y su vapor) y el mar (el agua libre que le toca: adonde va lo que escurre y de donde sale lo
 * que el cielo evapora y lo que mana de los manantiales). La roca es una reserva latente (cuantos de SiO₂ fuera de la
 * arena y del libro) que solo entra, como fuente declarada, cuando algo la saca.
 *
 * Un paso de página (cada K ticks, con dt = K) reparte sus operadores así (Strang): media ventana de vida (sol,
 * crecimiento y caída), la química de cada lote (`pasoLote`; la descomposición y la respiración del suelo salen de ahí),
 * el intercambio de gases suelo–aire, la filtración charca–suelo, el ciclo del agua (evaporación, mezcla con el cielo,
 * lluvia, escorrentía al mar y manantiales), la otra media ventana de vida y el termostato (radiación). El vapor que el
 * viento lleva a una página vecina va directo si la vecina es del mismo dueño y, si no, sale en vuelo (`garantizar`).
 *
 * Fuentes y sumideros declarados: la materia de un chunk nuevo (`materializar`), el sol (calor que paga la síntesis), la
 * radiación (termostato, en los dos sentidos), la ignición de un fuego, la roca que se materializa y lo que las leyes aún
 * escalares sacan o aportan (`extraer`, `beber`, `aportar`, `regar`). El agua ya no entra ni sale del mundo: lluvia,
 * evaporación y desagüe son traslados entre lotes. Todo lo demás se conserva por construcción en la arena.
 */
import { CAPACIDAD_ATOMO, ELEMENTOS, KAPPA_SUELO, KAPPA_SUELO_HH, NE, NIVEL_CATALIZADO, NU, R } from '../../shared/naturaleza.js';
import type { SustanciaId } from '../../shared/materia.js';
import type { Tile } from '../../shared/types.js';
import { PageArena, type ArenaCompartida } from '../soa/arena.js';
import type { Registro } from '../motor/contratos.js';
import { TICKS_PER_DAY } from '../mundo/tipos.js';
import { phaseAt } from '../mundo/crear.js';
import { DEFAULT_PARAMS } from '../params.js';
import {
  CRECIMIENTO_COMIDA, HAMBRE_POR_PASO, HAMBRE_POR_UNIDAD, INTERVALO_ECOLOGIA_TICKS, INTERVALO_TIEMPO_TICKS, LUZ_CREPSCULO,
  PROB_LLUVIA, RECARGA_LLUVIA, RECARGA_MANANTIAL, SED_POR_PASO, SED_POR_UNIDAD,
} from '../ecologia-constantes.js';
import { ArenaLotes, LOTES_POR_BLOQUE } from './arena.js';
import { indiceTipoEnlace, esGasA } from './quimica.js';
import { binomial, medir, pasoLote, type CtxPaso } from './paso.js';
import { fluir } from './fluir.js';
import { copiar, crearPlantilla } from './copiar.js';
import { cargarSustancias, serializarSustancias, type ServicioQuimicoImpl } from './servicio.js';
import {
  Parte, Rol, barreraEfectiva, nivelDeLote,
  type ArenaMateria, type Kappa, type Libro, type LoteRef, type Pedido, type Plantilla, type ServicioQuimico, type Sustancia,
} from './tipos.js';
import {
  unidadesVacias, unidadesVida, vistaTesela, type Escalas, type LotesTesela, type Organos, type Unidades, type VistaAire, type VistaTesela,
} from './vistas.js';

// ── Sustancias ───────────────────────────────────────────────────────────────────────────────────────────

const E = (x: string) => ELEMENTOS.indexOf(x as never);
const enlace = (a: string, b: string, k: 1 | 2 | 3 = 1): number => {
  const t = indiceTipoEnlace(E(a), E(b), k);
  if (t < 0) throw new Error(`Enlace inexistente: ${a}-${b}(${k})`);
  return t;
};
const vec = (pares: readonly [number, number][]) => Uint16Array.from(pares.flat());

/** Las sustancias de partida del mundo, por sus enlaces (los mismos vectores que la caja validada de la librería). */
export function sustanciasMundo(q: Pick<ServicioQuimico, 'internar'>) {
  const reg = (pares: readonly [number, number][]) => q.internar(vec(pares));
  return {
    H2: reg([[enlace('H', 'H'), 1]]),
    O2: reg([[enlace('O', 'O', 2), 1]]),
    N2: reg([[enlace('N', 'N', 3), 1]]),
    H2O: reg([[enlace('H', 'O'), 2]]),
    CO2: reg([[enlace('C', 'O', 2), 2]]),
    NH3: reg([[enlace('H', 'N'), 3]]),
    CH2: reg([[enlace('C', 'C'), 1], [enlace('H', 'C'), 2]]),
    madera: reg([[enlace('C', 'C'), 1], [enlace('H', 'C'), 1], [enlace('C', 'O'), 1], [enlace('H', 'O'), 1]]),
    proteina: reg([[enlace('C', 'C'), 1], [enlace('H', 'C'), 1], [enlace('C', 'N'), 1], [enlace('H', 'N'), 2]]),
    orgP: reg([[enlace('C', 'C'), 1], [enlace('H', 'C'), 1], [enlace('C', 'O'), 1], [enlace('O', 'P'), 3], [enlace('O', 'P', 2), 1]]),
    H3PO4: reg([[enlace('H', 'O'), 3], [enlace('O', 'P'), 5]]),
    SiO2: reg([[enlace('O', 'Si'), 4]]),
    CaCO3: reg([[enlace('O', 'Ca'), 2], [enlace('C', 'O'), 2], [enlace('C', 'O', 2), 1]]),
    CaHPO4: reg([[enlace('O', 'Ca'), 2], [enlace('O', 'P'), 3], [enlace('O', 'P', 2), 1], [enlace('H', 'O'), 1]]),
    Fe2O3: reg([[enlace('O', 'Fe'), 6]]),
  };
}
export type BaseMundo = ReturnType<typeof sustanciasMundo>;

// ── Constantes del mundo material ────────────────────────────────────────────────────────────────────────

const SIN: Kappa = [0, 0, 0, 0];
/** Pedido de la química (materia.cierre): Suelo y Cadáver catalizan; aire, agua, roca, tejido y fuego no. */
const K_SUELO: Kappa = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH];
const T_CUERPO = 310;

/** Clima (forzamiento declarado, como el sol): aire a 295 K a pleno sol y 288 K de noche; la lluvia es aire más frío. */
export const T_DIA = 295, T_NOCHE = 288, DT_LLUVIA = 4;

/** Geometría de la caja validada de la librería (tests/lib/caja-param.ts), por tesela. */
const AIRE_COLUMNA = { N2: 7_800_000, O2: 2_100_000, CO2: 200_000 };
const GASES_COLUMNA = Object.keys(AIRE_COLUMNA) as (keyof typeof AIRE_COLUMNA)[];
/** Capacidades (volúmenes relativos) y conductancia del intercambio de gases suelo–aire: g = 1 capacidad por tick, cien
 * veces el mínimo que pide la química para todo lote catalizado (g ≥ 0,01). */
const CAP_AIRE_TESELA = 100, CAP_SUELO = 10, G_SUELO = 1;
/** Suelo de la caja a fertilidad 1 (sus nutrientes escalan con la fertilidad de la tesela); el mundo lo agranda por
 * `ParamsMundo.suelo`. */
const SUELO_MINERAL = { SiO2: 1_000_000, CaCO3: 100_000 }, NH3_FERTIL = 60_000, H3PO4_FERTIL = 20_000;
/** P del suelo / P de la vegetación de referencia a su capacidad (en suelos reales, de 5 a 20). */
const SUELO_POR_VEGETACION = 5;

/** Fuego: la caja del laboratorio se enciende a 1.100 K (K) y arde 60 ticks (ticks); todo fuego busca tener dentro dos
 * veces el O₂ estequiométrico de lo que le queda por arder (pedido de la química: O₂ ≥ 1×). */
const T_IGNICION = 1100, TICKS_FUEGO = 60, O2_FUEGO = 2;

/** Clausius–Clapeyron con la regla de Trouton (ΔH_vap = 88 J/(mol·K)·T_eb), con la T de ebullición del modelo. */
const TROUTON = 88 / 8.314;

/** Los depósitos de una página (mar y cielo) no tienen rol propio en el contrato (se pide `Rol.Mar` y `Rol.Cielo` al
 * integrador): mientras, son lotes de rol Roca —que nadie más crea, porque la roca del mundo es latente— anclados en dos
 * celdas fijas de la página, donde `ArenaMateria.lotes` los vuelve a encontrar tras dormir o cargar. */
const ROL_DEPOSITO = Rol.Roca, CELDA_MAR = 0, CELDA_CIELO = 1;

// ── Atmósfera: capa límite, cielo, mar y viento ──────────────────────────────────────────────────────────
// El aire de una página es su columna entera de gases (la química la necesita), pero el vapor solo cabe en la capa
// límite, la parte baja que la superficie mezcla en el día: su fracción de la columna es h/H, con H = R·T/(M·g) la
// altura de escala del aire del modelo. Encima y alrededor está el resto del planeta, que cada página lleva consigo en
// dos depósitos finitos. El cielo es el aire sobre el océano que le toca (`oceanoPorTierra` columnas por tesela): se
// mezcla con la capa límite por arrastre y guarda el agua que llueve; no puede tener más vapor que el que lo satura a la
// temperatura de la altura. El mar le da agua por evaporación (Dalton) hasta saturarlo y recibe lo que escurre. Llueve
// cuando el tiempo del mundo lo dice (`Forzamiento.lluvia`) y solo lo que el cielo tiene. Unidades SI; un tick son
// 86.400 s / 2.400 = 36 s.
const SEGUNDOS_TICK = 86_400 / TICKS_PER_DAY, GRAVEDAD = 9.81, R_MOL = 1000 * R;

/** Parámetros físicos del mundo material (cada uno con su unidad y su valor real). Los intervalos entre corchetes son los
 * que barrió el laboratorio de la etapa en sombra; los que no llevan intervalo son nuevos y están sin medir. */
export const FISICA = {
  /** Altura de la capa límite (m). Real: 300 m de noche a 1–2 km de día. [100–10.000: todo el barrido pasa] */
  alturaCapaLimite: 1000,
  /** Conductancia aerodinámica del vapor sobre la superficie, C_E·U (m/s): 1,3·10⁻³ × 7,7 m/s. [0,001–0,1: todo pasa] */
  conductanciaSuperficie: 0.01,
  /** Velocidad de arrastre con que el cielo entra en la capa límite (m/s). Real: 0,5–5 cm/s. [0,001–0,1: todo pasa] */
  arrastreSeco: 0.01,
  /** Viento que mezcla el aire de páginas vecinas (teselas por tick: el mundo no fija metros por tesela). [0,01–1: todo pasa] */
  viento: 0.1,
  /** Coeficiente de extinción de la luz en el dosel (adimensional). Real: 0,3–0,8; 0,5 en gramíneas. [0,125–1] */
  extincionLuz: 0.5,
  /** Índice foliar (m² de hoja por m² de suelo) de una cobertura completa, vegetación 1. Real: 3–6. [1–8] */
  indiceFoliarCobertura: 4,
  /** Superficie de océano por superficie de tierra (adimensional). Real: 71 % / 29 %. Da el tamaño del cielo de una página. */
  oceanoPorTierra: 2.45,
  /** Cuánto más frío está el aire a la altura media del vapor que en la superficie (K). Real: 6,5 K/km × 2 km. */
  enfriamientoAltura: 13,
  /** Tiempo en que un cielo que llueve suelta su agua (s). Real: 1–3 h de residencia del agua condensada en una nube. */
  residenciaLluvia: 7200,
  /** Agua del mar por cada cuanto que satura el cielo (adimensional). Real: ~10⁵; aquí basta con que el mar sea mucho
   * mayor que el cielo y que lo que cabe en charcas y suelos (con 10 es unas 18 charcas llenas por tesela), y un valor
   * mayor acerca los asientos de una tanda de páginas nuevas al límite de los enteros exactos del libro. */
  aguaMarPorCielo: 10,
  /** Días en que una charca y su suelo igualarían su llenado por filtración. Real: de semanas a años en un vaso de fondo
   * colmatado (la etapa en sombra usaba 1 día y las charcas se vaciaban en su suelo). */
  filtracionCharca: 10,
  /** Semisaturación (Monod) de la toma de N y de P por las raíces, en fertilidad: el nutriente mineral de un suelo de esa
   * fertilidad deja la toma a la mitad. Real: del orden de la concentración de la solución de un suelo medio. */
  semisaturacionN: 0.5,
  semisaturacionP: 0.5,
  /** Fracción de la demanda de N que la fijación de N₂ puede cubrir cuando falta N mineral (adimensional). Real: 5–10 %. */
  fijacionN2: 0.05,
  /** Fracción del índice foliar medio de la página que llega a cada tesela como plántulas (lluvia de semillas,
   * adimensional): sin ella una tesela pelada no rebrota nunca. Real: 0,1–1 % de la cobertura vecina por estación. */
  dispersionSemillas: 0.01,
  /** Temperatura por debajo de la cual una brasa se apaga (K). Real: 500–700 K. */
  tBrasa: 600,
  /** Tiro: fracción de su exceso de temperatura sobre la de brasa que un fuego gasta en calentar el aire que aspira en un
   * tick (adimensional). Un fuego no aspira más aire del que puede calentar: con 1 se enfriaría hasta la brasa. */
  tiroFuego: 0.25,
};
export type Fisica = typeof FISICA;

/** Unidades base de cada órgano. La hoja es la planta de la caja validada; el fruto es semilla (lípido, proteína y
 * fósforo orgánico, sin madera); el tronco es madera. Su composición distinta es lo que permite leerlos por separado. */
const PARTES = {
  hoja: [['madera', 20], ['CH2', 2], ['proteina', 2], ['orgP', 1]],
  fruto: [['CH2', 4], ['proteina', 1], ['orgP', 1]],
  tronco: [['madera', 1]],
} as const satisfies Record<string, readonly (readonly [keyof BaseMundo, number])[]>;
export type Organo = keyof typeof PARTES;
export const ORGANOS: readonly Organo[] = ['hoja', 'fruto', 'tronco'];
const NU_ORGANO: Tasas = { hoja: 25, fruto: 6, tronco: 1 };

// ── Calibración por equivalencia de flujos (ARQ-materia §5.1) ─────────────────────────────────────────────

/** Anclas fisiológicas de las escalas: una persona come 8,4 MJ (2.000 kcal) y bebe 2,5 L al día. */
const J_PERSONA_DIA = 8.4e6, MMOL_AGUA_PERSONA_DIA = 2_500_000 / 18.015;
/** Luz de un tick (1 de día, 0 de noche, LUZ_CREPSCULO al amanecer y al anochecer) y su media en los ticks (desde, hasta]. */
export const luzDe = (tick: number): number => { const f = phaseAt(tick); return f === 'day' ? 1 : f === 'night' ? 0 : LUZ_CREPSCULO; };
export function luzMedia(desde: number, hasta: number): number {
  if (!(hasta > desde)) return luzDe(hasta);
  let s = 0;
  for (let t = desde + 1; t <= hasta; t++) s += luzDe(t);
  return s / (hasta - desde);
}
/** Luz media del día (amanecer y anochecer a LUZ_CREPSCULO, mismo reloj que phaseAt). */
export const LUZ_MEDIA = (1200 + 600 * LUZ_CREPSCULO) / TICKS_PER_DAY;

/**
 * Humedad media del suelo que da la ley escalar de hoy con su propio tiempo (ecology(): +0,012 por paso de lluvia,
 * −0,0015 − 0,001·luz por paso, entre 0 y 1; la lluvia se sortea cada 600 ticks con PROB_LLUVIA), en 2.000 días con un
 * azar fijo. Es la humedad de la tesela de referencia, no una constante elegida.
 */
export function humedadMediaEscalar(dias = 2000): number {
  let a = 0x2545f491, h = 0.5, s = 0, n = 0, lluvia = false;
  const azar = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let t = 0; t < dias * TICKS_PER_DAY; t += INTERVALO_ECOLOGIA_TICKS) {
    if (t % INTERVALO_TIEMPO_TICKS === 0) lluvia = azar() < PROB_LLUVIA;
    h = Math.min(1, Math.max(0, h + (lluvia ? 0.012 : 0) - 0.0015 - luzDe(t) * 0.001));
    if (t >= 10 * TICKS_PER_DAY) { s += h; n++; }
  }
  return s / n;
}

/** Tesela de referencia de la equivalencia: pradera a su capacidad, con la humedad media de la ley escalar y fertilidad media. */
export const REFERENCIA = { capacidad: DEFAULT_PARAMS.recursos.capacidadPastizal, humedad: humedadMediaEscalar(), fertilidad: 0.5, madera: 12 };

export interface Tasas { hoja: number; fruto: number; tronco: number }
export interface ParamsMundo {
  escalas: Escalas;
  /** Unidades base por tick a luz 1, agua y nutrientes sin límite y captura completa. */
  crecimiento: Tasas;
  /** Fracción de las unidades que cae al suelo por tick (senescencia proporcional a la biomasa). */
  caida: Tasas;
  /** Cuántas cajas de suelo tiene una tesela: las que guardan SUELO_POR_VEGETACION veces el P de su vegetación. */
  suelo: number;
  /** Conductancia charca–suelo (cuantos por tick a diferencia de llenado 1): igualan su llenado en `filtracionCharca` días. */
  gCharca: number;
  /** Conductancia mar–manantial (cuantos por tick a diferencia de nivel 1): la recarga escalar de un manantial vacío. */
  gManantial: number;
  /** Cuantos de N mineral y de P del suelo de una tesela que dejan la toma de las raíces a la mitad (Monod). */
  kmN: number;
  kmP: number;
  /** Ticks en que la superficie renueva el vapor de la capa límite (evaporación y rocío): h / (C_E·U). */
  tauVapor: number;
  /** Ticks en que el cielo renueva la capa límite (h / arrastre). */
  tauSeco: number;
  /** Ticks en que un cielo que llueve suelta su agua. */
  tauLluvia: number;
  /** Ticks en que el mar satura el cielo: (H − h) / (C_E·U), con H la altura de escala del aire. */
  tauMar: number;
  /** Ticks en que el viento cruza una página (16 teselas / VIENTO). */
  tauViento: number;
  /** Llenado del cielo (agua sobre la que lo satura) en régimen con el tiempo de `clima.ts`: con él se materializa. */
  llenadoCielo: number;
  /** Reparto de operadores del paso: 'strang' evalúa la vida en dos medias ventanas alrededor de la química y del agua;
   * 'inicio' la evalúa una vez con el estado del inicio (el reparto de la etapa en sombra, para comparar el sesgo). */
  reparto: 'strang' | 'inicio';
  fisica: Fisica;
  /** De dónde sale cada constante, para el informe. */
  porque: Record<string, string>;
}

/** Captura de luz de un dosel (Beer–Lambert): 1 − e^(−κ·LAI), con LAI = índice foliar de la cobertura × vegetación. La
 * hoja de arriba da sombra a la de abajo: es la sombra propia que frena el crecimiento al cerrarse el dosel. */
const captura = (vegetacion: number, f: Fisica) => -Math.expm1(-f.extincionLuz * f.indiceFoliarCobertura * vegetacion);

/** J que libera la oxidación completa de una unidad (C → CO₂, H → H₂O, N → N₂, P → H₃PO₄), con las energías del modelo. */
export function energiaOxidacion(q: Pick<ServicioQuimico, 'sustancia'>, S: BaseMundo, partes: readonly { id: SustanciaId; nu: number }[]): number {
  const a = new Array<number>(NE).fill(0);
  let antes = 0;
  for (const t of partes) {
    const s = q.sustancia(t.id);
    for (let e = 0; e < NE; e++) a[e]! += t.nu * s.atomos[e]!;
    antes += t.nu * s.energia;
  }
  const [h, c, n, o, p] = [a[E('H')]!, a[E('C')]!, a[E('N')]!, a[E('O')]!, a[E('P')]!];
  const agua = (h - 3 * p) / 2, o2 = (2 * c + 4 * p + agua - o) / 2;
  antes += o2 * q.sustancia(S.O2).energia;
  const despues = c * q.sustancia(S.CO2).energia + p * q.sustancia(S.H3PO4).energia + (n / 2) * q.sustancia(S.N2).energia + agua * q.sustancia(S.H2O).energia;
  return antes - despues;
}

/** Masa molar media de la columna de aire (kg/mol), para su altura de escala. */
function masaMolarAire(q: Pick<ServicioQuimico, 'sustancia'>, S: BaseMundo): number {
  let masa = 0, n = 0;
  for (const k of GASES_COLUMNA) { masa += AIRE_COLUMNA[k] * q.sustancia(S[k]).masa; n += AIRE_COLUMNA[k]; }
  return masa / n / 1000;
}

/** Freno de los nutrientes sobre el crecimiento (Liebig sobre N y P, con toma de Monod): lo que el suelo deja crecer con
 * su N mineral, lo que añade la fijación de N₂ y el P, que limita a los dos. `fN` y `fP` en [0, 1). */
export function liebig(fN: number, fP: number, fijacion: number): { suelo: number; fijado: number } {
  const suelo = Math.min(fP, fN);
  return { suelo, fijado: Math.min(fP, fN + (1 - fN) * fijacion) - suelo };
}

/**
 * Las constantes de escala y de tasa, derivadas de las leyes escalares de hoy en la tesela de referencia:
 * - alimento: 1 unidad calma HAMBRE_POR_UNIDAD de hambre; una persona gasta HAMBRE_POR_PASO por tick, así que come
 *   HAMBRE_POR_PASO·2.400/HAMBRE_POR_UNIDAD unidades al día ↔ 8,4 MJ: unidades de fruto = esa energía / J por unidad;
 * - agua: igual con la sed (2,5 L al día); humedad: la misma lluvia (en cuantos por tesela) sube la humedad 0,012 y el
 *   agua potable RECARGA_LLUVIA·(0,4 + 0,6·f) por paso de ecología, así que sus escalas están en esa razón;
 * - vegetación: la planta de la caja validada (2.000 unidades de hoja sobre su suelo) es vegetación 0,5; la captura de
 *   luz es la de Beer–Lambert con el índice foliar de la cobertura;
 * - madera: 1 unidad = 1 kg de madera (CH₂O); piedra: 1 unidad = 1 kg de SiO₂;
 * - caída del fruto y del tronco: el rebrote del mundo escalar a media capacidad (mismo día de luz, humedad y vegetación)
 *   es el del mundo material a la mitad de su equilibrio, d·equilibrio/2 por tick;
 * - caída de la hoja: la hojarasca a capacidad es la pérdida escalar de vegetación a capacidad (0,0001 por paso);
 * - crecimiento: el que deja el equilibrio en la capacidad de referencia con la luz media del día, el agua de la humedad
 *   de referencia y el freno de nutrientes de un suelo de fertilidad media. Con eso la capacidad de cada tesela deja de
 *   ser un parámetro: sale de su luz (sombra propia), de su agua y de su N y su P, que vuelven con la hojarasca;
 * - manantial: el goteo escalar de un manantial (RECARGA_MANANTIAL por paso de ecología) es lo que mana de un mar a su
 *   nivel de referencia hacia un vaso vacío;
 * - cielo: su llenado en régimen sale del balance entre lo que el mar evapora y lo que llueve con el tiempo de hoy
 *   (PROB_LLUVIA cada INTERVALO_TIEMPO_TICKS).
 */
export function calibrar(q: Pick<ServicioQuimico, 'sustancia'>, S: BaseMundo, fisica: Fisica = FISICA): ParamsMundo {
  const { alturaCapaLimite: h, conductanciaSuperficie, arrastreSeco, viento } = fisica;
  const partes = (o: Organo) => PARTES[o].map(([k, nu]) => ({ id: S[k], nu }));
  const comidaDia = HAMBRE_POR_PASO * TICKS_PER_DAY / HAMBRE_POR_UNIDAD;
  const aguaDia = SED_POR_PASO * TICKS_PER_DAY / SED_POR_UNIDAD;
  const lluviaAgua = RECARGA_LLUVIA * (0.4 + 0.6 * REFERENCIA.fertilidad), lluviaHumedad = 0.012;
  const escalas: Escalas = {
    alimento: Math.round(J_PERSONA_DIA / comidaDia / energiaOxidacion(q, S, partes('fruto'))),
    agua: Math.round(MMOL_AGUA_PERSONA_DIA / aguaDia),
    humedad: 0,
    vegetacion: 4000,
    madera: Math.round(1e6 / q.sustancia(S.madera).masa),
    piedra: Math.round(1e6 / q.sustancia(S.SiO2).masa),
  };
  escalas.humedad = Math.round(escalas.agua * lluviaAgua / lluviaHumedad);
  const { capacidad: K, humedad: m, fertilidad: f } = REFERENCIA, pasosDia = TICKS_PER_DAY / 10, pasosLuz = LUZ_MEDIA * pasosDia;
  // Rebrote escalar por día a media capacidad (ecologia.ts y ecosystem-kernel.ts, con la tesela de referencia).
  const decae = DEFAULT_PARAMS.recursos.decaimientoComida * pasosDia;
  const rebroteFruto = pasosLuz * m * K * CRECIMIENTO_COMIDA * 0.5 - decae;
  const rebroteHoja = pasosLuz * m * 0.007 * 0.5 - 0.0001 * pasosDia;
  const rebroteTronco = (1200 / 100) * 0.025 * m * f; // +0,025·luz·humedad·fertilidad cada 100 ticks de día
  // dX/dt = G·luz·agua·nutrientes·captura − d·X. A la mitad del equilibrio X* el neto es d·X*·(c(X*/2)/c(X*) − 1/2) para
  // la hoja (su producción depende de sí misma) y d·X*/2 para el fruto y el tronco.
  const cRef = captura(K, fisica), cMedia = captura(K / 2, fisica);
  const caida: Tasas = {
    hoja: 0.0001 / INTERVALO_ECOLOGIA_TICKS / K,
    fruto: rebroteFruto / (TICKS_PER_DAY * K / 2),
    tronco: rebroteTronco / (TICKS_PER_DAY * REFERENCIA.madera / 2),
  };
  const freno = liebig(f / (f + fisica.semisaturacionN), f / (f + fisica.semisaturacionP), fisica.fijacionN2);
  const nutrientes = freno.suelo + freno.fijado;
  const produce = LUZ_MEDIA * Math.min(1, m) * cRef * nutrientes;
  const crecimiento: Tasas = {
    hoja: caida.hoja * K * escalas.vegetacion / produce,
    fruto: caida.fruto * K * escalas.alimento / produce,
    tronco: caida.tronco * REFERENCIA.madera * escalas.madera / produce,
  };
  // P de una tesela de referencia a su capacidad: una unidad de orgP por unidad de hoja y por unidad de fruto.
  const pVegetacion = K * (escalas.vegetacion + escalas.alimento);
  const suelo = SUELO_POR_VEGETACION * pVegetacion / (H3PO4_FERTIL * f);
  const tRef = (T_DIA + T_NOCHE) / 2, alturaEscala = R_MOL * tRef / (masaMolarAire(q, S) * GRAVEDAD);
  const tauMar = Math.max(1, alturaEscala - h) / conductanciaSuperficie / SEGUNDOS_TICK;
  const tauLluvia = fisica.residenciaLluvia / SEGUNDOS_TICK;
  const evapora = 1 / tauMar, llueve = PROB_LLUVIA * -Math.expm1(-INTERVALO_TIEMPO_TICKS / tauLluvia) / INTERVALO_TIEMPO_TICKS;
  return {
    escalas, crecimiento, caida, suelo, fisica,
    gCharca: 1 / (fisica.filtracionCharca * TICKS_PER_DAY * (1 / escalas.agua + 1 / escalas.humedad)),
    gManantial: RECARGA_MANANTIAL / INTERVALO_ECOLOGIA_TICKS * escalas.agua,
    kmN: fisica.semisaturacionN * NH3_FERTIL * suelo,
    kmP: fisica.semisaturacionP * H3PO4_FERTIL * suelo,
    tauVapor: h / conductanciaSuperficie / SEGUNDOS_TICK,
    tauSeco: h / arrastreSeco / SEGUNDOS_TICK,
    tauLluvia, tauMar,
    tauViento: 16 / viento,
    llenadoCielo: evapora / (evapora + llueve),
    reparto: 'strang',
    porque: {
      alimento: `${comidaDia.toFixed(3)} u/día de comida ↔ 8,4 MJ; ${energiaOxidacion(q, S, partes('fruto')).toFixed(0)} J por unidad de fruto`,
      agua: `${aguaDia.toFixed(3)} u/día de agua ↔ 2,5 L`,
      humedad: `misma lluvia: +${lluviaHumedad} de humedad ↔ +${lluviaAgua.toFixed(4)} de agua potable`,
      vegetacion: 'la planta de la caja validada (2.000 unidades) es vegetación 0,5',
      madera: '1 unidad = 1 kg de CH₂O', piedra: '1 unidad = 1 kg de SiO₂',
      caida: `rebrote escalar a media capacidad por día: fruto ${rebroteFruto.toFixed(4)}, tronco ${rebroteTronco.toFixed(4)}; vegetación ${rebroteHoja.toFixed(4)} en el escalar y ${(TICKS_PER_DAY * caida.hoja * K * (cMedia / cRef - 0.5)).toFixed(4)} en el material (hojas de ${(1 / caida.hoja / TICKS_PER_DAY).toFixed(0)} días)`,
      crecimiento: `equilibrio en la referencia (K ${K}, humedad media escalar ${m.toFixed(3)}, luz media ${LUZ_MEDIA}, captura ${cRef.toFixed(3)}, freno de nutrientes ${nutrientes.toFixed(3)})`,
      gCharca: `charca y suelo igualan su llenado (agua/escala) en ${fisica.filtracionCharca} días`,
      gManantial: `un manantial vacío recibe ${RECARGA_MANANTIAL} de agua potable cada ${INTERVALO_ECOLOGIA_TICKS} ticks con el mar a su nivel de referencia`,
      nutrientes: `semisaturación a fertilidad ${fisica.semisaturacionN} (N) y ${fisica.semisaturacionP} (P); la fijación de N₂ cubre hasta el ${(100 * fisica.fijacionN2).toFixed(0)} % de la demanda`,
      tauVapor: `h ${h} m / C_E·U ${conductanciaSuperficie} m/s`,
      atmosfera: `el cielo renueva la capa límite en ${(h / arrastreSeco / SEGUNDOS_TICK).toFixed(0)} ticks (arrastre ${arrastreSeco} m/s); el mar lo satura en ${tauMar.toFixed(0)} ticks (altura de escala ${alturaEscala.toFixed(0)} m); llueve en ${tauLluvia.toFixed(0)} ticks; llenado en régimen ${(evapora / (evapora + llueve)).toFixed(3)}; viento ${viento} teselas/tick`,
      suelo: `cajas de suelo por tesela: ${SUELO_POR_VEGETACION}× el P de la vegetación de referencia (${pVegetacion.toFixed(0)}) a fertilidad ${f}`,
    },
  };
}

// ── Plantillas ───────────────────────────────────────────────────────────────────────────────────────────

/** Variante de un órgano: la misma unidad (k unidades base) con otras fuentes de N o de P; `fija` si toma su N del N₂. */
export interface Variante { p: Plantilla; k: number; fija: boolean }
export interface PlantillasMundo {
  hoja: Variante[]; fruto: Variante[]; tronco: Variante[]; dHMax: Tasas;
  /** Formas de P que las plantillas aceptan (las que cuenta el freno de nutrientes), con los ids que da Q. */
  fosfatos: SustanciaId[];
  /** Reacciones del orgP que Q aún no había resuelto al crearlas (química encolada): mientras sea > 0 faltan formas de P
   * y hay que volver a crearlas (`MundoMaterial.completarPlantillas`). */
  pendientes: number;
}

class RegistroLocal implements Registro {
  private readonly ids = new Map<string, number>();
  insertar(b: Uint8Array): number {
    const k = Buffer.from(b).toString('hex');
    let id = this.ids.get(k);
    if (id === undefined) this.ids.set(k, id = this.ids.size);
    return id;
  }
  leer(): Uint8Array | undefined { return undefined; }
  get n(): number { return this.ids.size; }
}

/** Plantillas de cada órgano (pedido de la química): N de NH₃ o de N₂ y P de H₃PO₄, CaHPO₄, HPO₃(u), O₅P₂(u) y O₅P₂ gas,
 * con los ids que da Q para el P que suelta el orgP (sola, con agua en el nivel catalizado, con O₂ en llama). `registro`
 * es el del motor (ids globales de plantilla); el laboratorio usa uno local. */
export function plantillasMundo(q: ServicioQuimico, S: BaseMundo, registro: Registro = new RegistroLocal()): PlantillasMundo {
  let pendientes = 0;
  const conP = (a: SustanciaId, b: SustanciaId, nivel: number): SustanciaId => {
    const r = q.reaccion(a, b, nivel);
    if (r === undefined) { pendientes++; return 0; }
    return r?.salidas.find((t) => q.sustancia(t.id).atomos[E('P')])?.id ?? 0;
  };
  const nitrogenos = [S.NH3, S.N2];
  const fosfatos = [...new Set([S.H3PO4, S.CaHPO4, conP(S.orgP, 0, NIVEL_CATALIZADO), conP(S.orgP, S.H2O, NIVEL_CATALIZADO), conP(S.orgP, S.O2, 10)])]
    .filter((id) => id !== 0);
  const subproductos = [S.O2, S.CaCO3, S.SiO2, S.Fe2O3];
  const crear = (o: Organo, entradas: SustanciaId[]): Variante | null => {
    const partes = PARTES[o].map(([k, nu]) => ({ id: S[k], nu }));
    const p = crearPlantilla(q, registro, {
      partes, entradas, subproductos: subproductos.filter((id) => !entradas.includes(id)),
      kappa: SIN, captura: 0, masaAdulta: 0, m0: 0, linaje: 0,
    });
    if (!p || entradas.some((id) => !p.sintesis.entradas.some((t) => t.id === id))) return null;
    // crearPlantilla ordena las partes a su manera: k sale de la misma sustancia.
    return { p, k: p.partes.find((t) => t.id === partes[0]!.id)!.nu / partes[0]!.nu, fija: entradas.includes(S.N2) };
  };
  const variantes = (o: Organo): Variante[] => {
    const out: Variante[] = [];
    for (const f of fosfatos) for (const n of nitrogenos) {
      const v = crear(o, [...new Set([S.CO2, S.H2O, n, f])]);
      if (v && !out.some((x) => x.p.id === v.p.id)) out.push(v);
    }
    return out;
  };
  const tronco = crear('tronco', [S.CO2, S.H2O]);
  const pl = { hoja: variantes('hoja'), fruto: variantes('fruto'), tronco: tronco ? [tronco] : [] };
  for (const o of ORGANOS) if (!pl[o].length) throw new Error(`Ninguna plantilla de ${o} balancea.`);
  const dHMax = (o: Organo) => Math.max(...pl[o].map((v) => Math.max(0, v.p.sintesis.dH) / v.k));
  return { ...pl, dHMax: { hoja: dHMax('hoja'), fruto: dHMax('fruto'), tronco: dHMax('tronco') }, fosfatos, pendientes };
}

export function organosDe(S: BaseMundo): Organos {
  const marcas = [S.madera, S.CH2, S.proteina] as const;
  const fila = (o: Organo) => marcas.map((id) => PARTES[o].find(([k]) => S[k] === id)?.[1] ?? 0) as unknown as [number, number, number];
  return { marcas, hoja: fila('hoja'), fruto: fila('fruto'), tronco: fila('tronco') };
}

/** Flujos brutos del último `intercambioBruto` (cuantos de `l` al otro lote y al revés), para la contabilidad del agua. */
export const bruto = { ida: 0, vuelta: 0 };

/**
 * Intercambio de `id` entre `l` y `aire` con flujos brutos en los dos sentidos (decisión del «suelo discreto» del H₂,
 * materia.cierre2): cada cuanto de un lado pasa al otro con la probabilidad de la relajación de `fluir` en dt (la misma
 * media), así que dos H₂ del aire pueden coincidir en el poro aunque el equilibrio discreto deje menos de uno de
 * diferencia. Devuelve el neto de `l` al aire y deja los dos brutos en `bruto`.
 */
export function intercambioBruto(c: CtxPaso, l: LoteRef, aire: LoteRef, id: SustanciaId, g: number, capL: number, capA: number, dt: number): number {
  const f = -Math.expm1(-g * dt * (1 / capL + 1 / capA)), pL = f * capA / (capL + capA), pA = f * capL / (capL + capA);
  const ida = bruto.ida = binomial(c.arena.cuantos(l, id), pL, c.azar), vuelta = bruto.vuelta = binomial(c.arena.cuantos(aire, id), pA, c.azar);
  const neto = ida - vuelta;
  if (neto > 0) return c.arena.moverParte(l, aire, { parte: Parte.Exacta, esp: id, cuantos: neto, kappa: null });
  if (neto < 0) return -c.arena.moverParte(aire, l, { parte: Parte.Exacta, esp: id, cuantos: -neto, kappa: null });
  return 0;
}

// ── Estado compartido ────────────────────────────────────────────────────────────────────────────────────

/**
 * Contabilidad por hilo. Energía (J): sol, radiación que entra y que sale, ignición. Vida: tejido caído al suelo
 * (cuantos). Ciclo del agua (cuantos de H₂O, traslados entre lotes): lo que el cielo da a la página (arrastre y lluvia),
 * lo que la capa límite le devuelve, lo que escurre al mar, lo que llueve, lo que el mar evapora al cielo (neto) y lo que
 * mana a los manantiales. Materia que cruza el borde del mundo, en J y en mmol de átomos: chunk nuevo, uso heredado,
 * aporte heredado y roca. EXTERIOR_J y, desde EXTERIOR_AT, los átomos por elemento son el neto con signo de esas tres
 * últimas (lo que entró menos lo que salió después de materializar): con ellas cuadra el balance de un tramo.
 */
const SOL = 0, RAD_ENTRA = 1, RAD_SALE = 2, IGNICION = 3, CAIDA = 4, CIELO_ENTRA = 5, CIELO_SALE = 6, DESAGUE = 7, EXTERIOR_J = 8,
  LLUVIA = 9, EVAPORA_MAR = 10, MANANTIAL = 11, CHUNK_J = 12, CHUNK_AT = 13, USO_J = 14, USO_AT = 15, APORTE_J = 16, APORTE_AT = 17,
  ROCA_J = 18, ROCA_AT = 19, EXTERIOR_AT = 20, CUENTAS = EXTERIOR_AT + NE;
const LIBRO = 3 * (NE + 1);

/** Nombre y unidad de cada cuenta escalar (las de `EXTERIOR_AT` van por elemento y no figuran aquí). */
export const NOMBRE_CUENTA: readonly string[] = [
  'sol (J)', 'radiación que entra (J)', 'radiación que sale (J)', 'ignición (J)', 'hojarasca (cuantos de tejido)',
  'del cielo a la página (mmol de H₂O)', 'de la capa límite al cielo (mmol de H₂O)', 'desagüe al mar (mmol de H₂O)',
  'neto con el exterior (J)', 'lluvia (mmol de H₂O)', 'evaporación del mar (mmol de H₂O)', 'manantiales (mmol de H₂O)',
  'chunk nuevo (J)', 'chunk nuevo (mmol de átomos)', 'uso heredado (J)', 'uso heredado (mmol de átomos)',
  'aporte heredado (J)', 'aporte heredado (mmol de átomos)', 'roca (J)', 'roca (mmol de átomos)',
];

type ClaveTesela = 'suelo' | 'agua' | 'vida' | 'latente' | 'celda' | 'x' | 'y' | 'manantial';
type ClavePagina = 'inicio' | 'fin' | 'aire' | 'mar' | 'cielo' | 'dueno' | 'activa' | 'azar' | 'dT' | 'vecinas' | 'transito' | 'lluvia'
  | 'desague' | 'cobertura';

export interface DescriptorMundo {
  n: number; np: number; hilos: number;
  lotes: ArenaCompartida; desborde: ArenaCompartida; paginas: ArenaCompartida;
  /** Por tesela (ordenadas por página): suelo, agua, vida, latente, celda, coordenadas y si es manantial; por página:
   * inicio y fin, aire, mar, cielo, dueño, si está activa, azar, dT, sus cuatro vecinas (x−1, x+1, y−1, y+1; −1 si no hay),
   * el vapor en vuelo hacia cada una (cuantos y calor), lo que llovió y lo que escurrió al mar en su último paso (cuantos)
   * y su cobertura foliar media. */
  sab: Record<ClaveTesela | ClavePagina | 'libros', SharedArrayBuffer>;
  sustancias: Uint8Array;
  base: BaseMundo; plantillas: PlantillasMundo; params: ParamsMundo;
}

/** Forzamiento de un paso: su duración, la luz media de la ventana (y la de su segunda mitad, si se conoce), si llueve y
 * cuánto más o menos deprisa que la media suelta el cielo su agua (estación de `clima.ts`; 1 si se omite). */
export interface Forzamiento { dt: number; luz: number; lluvia: boolean; luzFin?: number; lluviaEscala?: number }

/** Lo que el motor pone para que el mundo material corra sobre el contexto de un dueño. */
export interface AnfitrionMotor {
  arena: ArenaMateria; quimica: ServicioQuimico; libro: Libro; hilo: number;
  azar(): number;
  registro?: Registro;
  fisica?: Partial<Fisica>;
  /** Página vecina de `p` en la dirección `dir` (x−1, x+1, y−1, y+1), o −1 si no es residente. */
  vecina(p: number, dir: number): number;
  /** Entrega a la página ajena `q` una garantía de vapor ya debitada del aire de `p` (va en vuelo hasta que su dueño la abone). */
  exportar(p: number, q: number, garantia: Float64Array): void;
}

type Memorias = { lotes: PageArena; desborde: PageArena; paginas: PageArena };
type Tabla = Float64Array | Int32Array | Int16Array | Uint8Array | Uint32Array;
interface Tablas {
  suelo: Float64Array; agua: Float64Array; vida: Float64Array; latente: Float64Array; celda: Int32Array; x: Int32Array; y: Int32Array;
  manantial: Uint8Array;
  inicio: Int32Array; fin: Int32Array; aire: Float64Array; mar: Float64Array; cielo: Float64Array; dueno: Int16Array; activa: Uint8Array;
  azar: Uint32Array; dT: Float64Array; vecinas: Int32Array; transito: Float64Array; lluvia: Float64Array; desague: Float64Array;
  cobertura: Float64Array;
}
interface Nucleo {
  arena: ArenaMateria; quimica: ServicioQuimico; libro: Libro; cuentas: Float64Array; hilo: number;
  base: BaseMundo; plantillas: PlantillasMundo; params: ParamsMundo; tablas: Tablas; n: number; np: number;
  registro: Registro | null;
  laboratorio: { d: DescriptorMundo; memorias: Memorias; arena: ArenaLotes; libros: Float64Array } | null;
  motor: AnfitrionMotor | null;
}

const MAX_LOTES = 1 << 23, MAX_DESBORDE = 1 << 25, MAX_PAGINAS = 1 << 20;
const sab = (bytes: number) => new SharedArrayBuffer(Math.max(8, bytes));

/** Entero con esperanza x (⌊x⌋ más un uniforme). */
const entero = (x: number, azar: () => number) => {
  const piso = Math.floor(x);
  return piso + (azar() < x - piso ? 1 : 0);
};

/** La misma tabla con sitio para `largo` elementos (el doble de lo que tenía si hay que crecer). */
function agrandar<A extends Tabla>(a: A, largo: number, relleno = 0): A {
  if (a.length >= largo) return a;
  const b = new (a.constructor as new (n: number) => A)(Math.max(largo, 2 * a.length, 16));
  if (relleno !== 0) b.fill(relleno);
  b.set(a);
  return b;
}

const local = (t: { x: number; y: number }) => (((t.y % 16) + 16) % 16) * 16 + (((t.x % 16) + 16) % 16);
const esVaso = (t: Tile) => t.terrain !== 'water' && ((t.drinkingWater ?? 0) > 0 || t.feature === 'pool' || t.feature === 'spring' || t.biome === 'wetland');

export class MundoMaterial {
  readonly arena: ArenaMateria;
  readonly quimica: ServicioQuimico;
  readonly libro: Libro;
  readonly cuentas: Float64Array;
  readonly hilo: number;
  /** Teselas y páginas dadas de alta (con el motor, `np` es la cota de los chunks vistos y crecen las dos). */
  n: number;
  np: number;
  suelo: Float64Array;
  agua: Float64Array;
  vida: Float64Array;
  latente: Float64Array;
  celda: Int32Array;
  x: Int32Array;
  y: Int32Array;
  manantial: Uint8Array;
  inicio: Int32Array;
  fin: Int32Array;
  aire: Float64Array;
  mar: Float64Array;
  cielo: Float64Array;
  dueno: Int16Array;
  activa: Uint8Array;
  dT: Float64Array;
  vecinas: Int32Array;
  transito: Float64Array;
  lluvia: Float64Array;
  desague: Float64Array;
  cobertura: Float64Array;
  readonly S: BaseMundo;
  plantillas: PlantillasMundo;
  readonly params: ParamsMundo;
  readonly organos: Organos;
  readonly ctx: CtxPaso;
  private estadoAzar: Uint32Array;
  private readonly lab: Nucleo['laboratorio'];
  private readonly motor: AnfitrionMotor | null;
  private readonly registro: Registro | null;
  private readonly gas = new Map<number, boolean>();
  private readonly vistos = new Set<number>();
  private readonly gasesLibres: SustanciaId[];
  private readonly humos: SustanciaId[];
  private ids = new Uint32Array(64);
  private indices = new Int32Array(0);
  private semilla = 0;
  private hojas = 0;
  private fN = 0;
  private fP = 0;
  private readonly u: Unidades = unidadesVacias();
  private readonly pedido: Pedido = { parte: Parte.Exacta, esp: 0, cuantos: 0, kappa: null };
  private readonly buscado = new Float64Array(1);
  private readonly pideSuelo: Tasas = { hoja: 0, fruto: 0, tronco: 0 };
  private readonly pideFijado: Tasas = { hoja: 0, fruto: 0, tronco: 0 };
  /** Masa molar media de la columna de aire (kg/mol), para su altura de escala. */
  private readonly masaAire: number;
  /** Cuantos de agua por tesela que saturan el cielo a la temperatura media: la referencia del nivel del mar. */
  readonly cieloReferencia: number;

  private constructor(k: Nucleo) {
    this.arena = k.arena; this.quimica = k.quimica; this.libro = k.libro; this.cuentas = k.cuentas; this.hilo = k.hilo;
    this.S = k.base; this.plantillas = k.plantillas; this.params = k.params; this.n = k.n; this.np = k.np;
    this.lab = k.laboratorio; this.motor = k.motor; this.registro = k.registro;
    const t = k.tablas;
    this.suelo = t.suelo; this.agua = t.agua; this.vida = t.vida; this.latente = t.latente; this.celda = t.celda; this.x = t.x; this.y = t.y;
    this.manantial = t.manantial; this.inicio = t.inicio; this.fin = t.fin; this.aire = t.aire; this.mar = t.mar; this.cielo = t.cielo;
    this.dueno = t.dueno; this.activa = t.activa; this.estadoAzar = t.azar; this.dT = t.dT; this.vecinas = t.vecinas;
    this.transito = t.transito; this.lluvia = t.lluvia; this.desague = t.desague; this.cobertura = t.cobertura;
    this.organos = organosDe(k.base);
    this.gasesLibres = GASES_COLUMNA.map((g) => k.base[g]);
    this.humos = [k.base.CO2, k.base.H2O, k.base.N2];
    this.masaAire = masaMolarAire(k.quimica, k.base);
    const f = k.params.fisica, tAlto = (T_DIA + T_NOCHE) / 2 - f.enfriamientoAltura;
    this.cieloReferencia = f.oceanoPorTierra * GASES_COLUMNA.reduce((s, g) => s + AIRE_COLUMNA[g], 0) * this.razonVapor(tAlto);
    const self = this, externo = k.motor ? k.motor.azar.bind(k.motor) : null;
    this.ctx = {
      arena: this.arena, quimica: this.quimica,
      // Con el motor, el azar del dueño; en el laboratorio, mulberry32 con el estado de la página en curso (así el
      // resultado no depende del número de hilos).
      azar: externo ?? function azar(): number {
        let a = self.semilla = (self.semilla + 0x6d2b79f5) >>> 0;
        a = Math.imul(a ^ (a >>> 15), a | 1);
        a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
        return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
      },
    };
  }

  private static arenaLab(memorias: Memorias, hilo: number, q: ServicioQuimico, S: BaseMundo, dueno: Int16Array): ArenaLotes {
    return new ArenaLotes({
      ...memorias, hilo, quimica: q, agua: S.H2O,
      terreno: { chunkDe: (c: number) => c >> 8, duenoChunk: dueno },
      // Pedido de la química: lo digerible con [KAPPA0 ×4] a la T del cuerpo, solo exotérmicas (`barreraEfectiva`);
      // la fracción es la que se oxida en un día de tránsito.
      digerible: (s: Readonly<Sustancia>, kappa: Kappa) => {
        const r = q.reaccion(s.id, S.O2, nivelDeLote(T_CUERPO, kappa));
        if (!r || r.dH >= 0) return 0;
        const nu = r.entradas.find((t) => t.id === s.id)?.nu ?? 1;
        return (-r.dH / nu) * -Math.expm1(-NU * Math.exp(-barreraEfectiva(r, kappa) / (R * T_CUERPO)) * TICKS_PER_DAY);
      },
    });
  }

  private static tablasDe(s: DescriptorMundo['sab']): Tablas {
    return {
      suelo: new Float64Array(s.suelo), agua: new Float64Array(s.agua), vida: new Float64Array(s.vida), latente: new Float64Array(s.latente),
      celda: new Int32Array(s.celda), x: new Int32Array(s.x), y: new Int32Array(s.y), manantial: new Uint8Array(s.manantial),
      inicio: new Int32Array(s.inicio), fin: new Int32Array(s.fin), aire: new Float64Array(s.aire), mar: new Float64Array(s.mar),
      cielo: new Float64Array(s.cielo), dueno: new Int16Array(s.dueno), activa: new Uint8Array(s.activa), azar: new Uint32Array(s.azar),
      dT: new Float64Array(s.dT), vecinas: new Int32Array(s.vecinas), transito: new Float64Array(s.transito),
      lluvia: new Float64Array(s.lluvia), desague: new Float64Array(s.desague), cobertura: new Float64Array(s.cobertura),
    };
  }

  private static deLaboratorio(d: DescriptorMundo, q: ServicioQuimico, hilo: number, memorias: Memorias): MundoMaterial {
    const tablas = MundoMaterial.tablasDe(d.sab), libros = new Float64Array(d.sab.libros), base = hilo * (LIBRO + CUENTAS);
    const arena = MundoMaterial.arenaLab(memorias, hilo, q, d.base, tablas.dueno);
    return new MundoMaterial({
      arena, quimica: q, hilo, base: d.base, plantillas: d.plantillas, params: d.params, tablas, n: d.n, np: d.np, registro: null,
      libro: {
        fuentes: libros.subarray(base, base + NE + 1), sumideros: libros.subarray(base + NE + 1, base + 2 * (NE + 1)),
        enVuelo: libros.subarray(base + 2 * (NE + 1), base + LIBRO),
      },
      cuentas: libros.subarray(base + LIBRO, base + LIBRO + CUENTAS),
      laboratorio: { d, memorias, arena, libros }, motor: null,
    });
  }

  /** El mismo mundo visto desde otro hilo (un worker): su arena, su libro y su química cargada del registro. */
  static conectar(d: DescriptorMundo, hilo: number): MundoMaterial {
    const m = MundoMaterial.deLaboratorio(d, cargarSustancias(d.sustancias, { modo: 'inmediato' }), hilo, {
      lotes: PageArena.conectar(d.lotes), desborde: PageArena.conectar(d.desborde), paginas: PageArena.conectar(d.paginas),
    });
    m.indexar(0, m.n);
    return m;
  }

  /**
   * Levanta el mundo material de `tiles` (de un mundo ya creado) con la química `q`, para el laboratorio. Las teselas se
   * agrupan en páginas de 16 × 16 por sus coordenadas; la página p es del hilo p % hilos. `luz` fija la temperatura
   * inicial; `fisica` cambia parámetros físicos y `reparto` el orden de operadores (para los barridos).
   */
  static levantar(tiles: readonly Tile[], q: ServicioQuimicoImpl,
    op: { hilos?: number; semilla?: number; luz?: number; fisica?: Partial<Fisica>; reparto?: ParamsMundo['reparto'] } = {}): MundoMaterial {
    const hilos = op.hilos ?? 1, semilla = op.semilla ?? 1;
    const S = sustanciasMundo(q);
    const plantillas = plantillasMundo(q, S), params = calibrar(q, S, { ...FISICA, ...op.fisica });
    if (op.reparto) params.reparto = op.reparto;
    const clave = (t: Tile) => Math.floor(t.y / 16) * 0x10000 + Math.floor(t.x / 16);
    const orden = [...tiles].sort((a, b) => clave(a) - clave(b) || local(a) - local(b));
    const paginas = [...new Set(orden.map(clave))];
    const n = orden.length, np = paginas.length;
    const memorias: Memorias = { lotes: new PageArena(MAX_LOTES), desborde: new PageArena(MAX_DESBORDE), paginas: new PageArena(MAX_PAGINAS) };
    const d: DescriptorMundo = {
      n, np, hilos,
      lotes: undefined as never, desborde: undefined as never, paginas: undefined as never,
      sab: {
        suelo: sab(8 * n), agua: sab(8 * n), vida: sab(8 * n), latente: sab(8 * n), celda: sab(4 * n), x: sab(4 * n), y: sab(4 * n),
        manantial: sab(n),
        inicio: sab(4 * (np + 1)), fin: sab(4 * np), aire: sab(8 * np), mar: sab(8 * np), cielo: sab(8 * np), dueno: sab(2 * np),
        activa: sab(np), azar: sab(4 * np), dT: sab(8 * np), vecinas: sab(4 * 4 * np), transito: sab(8 * 2 * 4 * np),
        lluvia: sab(8 * np), desague: sab(8 * np), cobertura: sab(8 * np),
        libros: sab(8 * hilos * (LIBRO + CUENTAS)),
      },
      sustancias: new Uint8Array(0), base: S, plantillas, params,
    };
    const m = MundoMaterial.deLaboratorio(d, q, 0, memorias);
    d.lotes = memorias.lotes.compartir(); d.desborde = memorias.desborde.compartir(); d.paginas = memorias.paginas.compartir();
    memorias.paginas.prepararF0(np);
    memorias.lotes.prepararF0(3 * n + 3 * np + 256 * hilos, LOTES_POR_BLOQUE);
    memorias.desborde.prepararF0(8 * n + 16 * np);
    const pagDe = new Map(paginas.map((k, p) => [k, p]));
    for (let p = 0; p < np; p++) {
      const k = paginas[p]!;
      [k - 1, k + 1, k - 0x10000, k + 0x10000].forEach((v, dir) => { m.vecinas[4 * p + dir] = pagDe.get(v) ?? -1; });
      m.estadoAzar[p] = (Math.imul(semilla >>> 0, 0x9e3779b1) ^ Math.imul(p + 1, 0x85ebca6b)) >>> 0;
    }
    for (let i = 0, p = 0; p < np; p++) {
      let j = i;
      while (j < n && pagDe.get(clave(orden[j]!)) === p) j++;
      m.materializar(p, orden.slice(i, j), op.luz ?? 1, i);
      i = j;
    }
    m.inicio[np] = n;
    for (let p = 0; p < np; p++) m.dueno[p] = p % hilos;
    d.sustancias = serializarSustancias(q);
    return m;
  }

  /** El mundo material sobre el contexto de un dueño del motor, aún sin páginas. Las sustancias con nombre ya están en
   * la química del mundo: `internar` solo devuelve su id. */
  static sobre(a: AnfitrionMotor): MundoMaterial {
    const S = sustanciasMundo(a.quimica), registro = a.registro ?? new RegistroLocal();
    return new MundoMaterial({
      arena: a.arena, quimica: a.quimica, libro: a.libro, cuentas: new Float64Array(CUENTAS), hilo: a.hilo, base: S,
      plantillas: plantillasMundo(a.quimica, S, registro), params: calibrar(a.quimica, S, { ...FISICA, ...a.fisica }),
      tablas: {
        suelo: new Float64Array(0), agua: new Float64Array(0), vida: new Float64Array(0), latente: new Float64Array(0),
        celda: new Int32Array(0), x: new Int32Array(0), y: new Int32Array(0), manantial: new Uint8Array(0),
        inicio: new Int32Array(0), fin: new Int32Array(0), aire: new Float64Array(0), mar: new Float64Array(0),
        cielo: new Float64Array(0), dueno: new Int16Array(0), activa: new Uint8Array(0), azar: new Uint32Array(0),
        dT: new Float64Array(0), vecinas: new Int32Array(0), transito: new Float64Array(0), lluvia: new Float64Array(0),
        desague: new Float64Array(0), cobertura: new Float64Array(0),
      },
      n: 0, np: 0, registro, laboratorio: null, motor: a,
    });
  }

  /** Si a las plantillas les faltaban formas de P porque la química aún no había resuelto las reacciones del orgP, las
   * vuelve a crear (las ya registradas conservan su id). Devuelve si ya están completas. */
  completarPlantillas(): boolean {
    if (this.plantillas.pendientes > 0) this.plantillas = plantillasMundo(this.quimica, this.S, this.registro ?? undefined);
    return this.plantillas.pendientes === 0;
  }

  // ── Páginas ──

  private reservar(nTeselas: number, nPaginas: number): void {
    if (this.lab) {
      if (nTeselas > this.suelo.length || nPaginas > this.aire.length) throw new Error('El mundo del laboratorio no crece.');
      return;
    }
    this.suelo = agrandar(this.suelo, nTeselas, -1); this.agua = agrandar(this.agua, nTeselas, -1); this.vida = agrandar(this.vida, nTeselas, -1);
    this.latente = agrandar(this.latente, nTeselas); this.celda = agrandar(this.celda, nTeselas); this.x = agrandar(this.x, nTeselas);
    this.y = agrandar(this.y, nTeselas); this.manantial = agrandar(this.manantial, nTeselas);
    this.inicio = agrandar(this.inicio, nPaginas); this.fin = agrandar(this.fin, nPaginas); this.aire = agrandar(this.aire, nPaginas, -1);
    this.mar = agrandar(this.mar, nPaginas, -1); this.cielo = agrandar(this.cielo, nPaginas, -1); this.dueno = agrandar(this.dueno, nPaginas);
    this.activa = agrandar(this.activa, nPaginas); this.dT = agrandar(this.dT, nPaginas); this.lluvia = agrandar(this.lluvia, nPaginas);
    this.desague = agrandar(this.desague, nPaginas); this.cobertura = agrandar(this.cobertura, nPaginas);
  }

  /** Pone al día el índice celda → tesela de las teselas [desde, hasta). */
  private indexar(desde: number, hasta: number): void {
    this.indices = agrandar(this.indices, 256 * this.np);
    for (let i = desde; i < hasta; i++) this.indices[this.celda[i]!] = i + 1;
  }

  /** Índice de la tesela de una celda (`chunk · 256 + local`), o −1 si este mundo no la tiene. */
  indiceDe(celda: number): number { return celda >= 0 && celda < this.indices.length ? this.indices[celda]! - 1 : -1; }

  /** ¿Tiene este mundo la página p con sus lotes (activa o dormida)? */
  tiene(p: number): boolean { return p >= 0 && p < this.np && this.fin[p]! > this.inicio[p]! && this.aire[p]! >= 0; }

  /** Abre sitio para las teselas de la página p al final de las tablas y devuelve su primer índice. */
  private abrir(p: number, tiles: readonly Tile[]): number {
    const i0 = this.n;
    this.reservar(i0 + tiles.length, p + 1);
    this.n = i0 + tiles.length; this.np = Math.max(this.np, p + 1);
    for (let j = 0; j < tiles.length; j++) {
      const t = tiles[j]!;
      this.celda[i0 + j] = p * 256 + local(t); this.x[i0 + j] = t.x; this.y[i0 + j] = t.y;
    }
    this.inicio[p] = i0; this.fin[p] = this.n;
    this.indexar(i0, this.n);
    return i0;
  }

  /**
   * Da de alta la página p con los lotes de sus teselas, sacados de los escalares de `tiles` (ordenadas por celda local),
   * su aire y sus dos depósitos: es la fuente declarada «chunk nuevo». `luz` fija la temperatura inicial. Con el motor las
   * teselas van al final de las tablas; el laboratorio da el índice `en`.
   */
  materializar(p: number, tiles: readonly Tile[], luz: number, en = -1): void {
    const i0 = en >= 0 ? en : this.abrir(p, tiles), nT = tiles.length, S = this.S, e = this.params.escalas, f = this.params.fisica;
    if (en >= 0) {
      for (let j = 0; j < nT; j++) { const t = tiles[j]!; this.celda[i0 + j] = p * 256 + local(t); this.x[i0 + j] = t.x; this.y[i0 + j] = t.y; }
      this.inicio[p] = i0; this.fin[p] = i0 + nT;
      this.indexar(i0, i0 + nT);
    }
    const T = this.temperatura(p, luz), poro = CAP_SUELO / CAP_AIRE_TESELA, cajas = this.params.suelo;
    let humedad = 0;
    for (let j = 0; j < nT; j++) {
      const t = tiles[j]!, i = i0 + j, c = this.celda[i]!, fert = t.fertility ?? 0.5;
      this.suelo[i] = this.arena.nuevo(Rol.Suelo, c, 0);
      this.llenar(this.suelo[i]!, [
        [S.SiO2, Math.round(SUELO_MINERAL.SiO2 * cajas)], [S.CaCO3, Math.round(SUELO_MINERAL.CaCO3 * cajas)],
        [S.NH3, Math.round(NH3_FERTIL * fert * cajas)], [S.H3PO4, Math.round(H3PO4_FERTIL * fert * cajas)],
        [S.H2O, Math.round(t.moisture * e.humedad)],
        [S.N2, Math.round(AIRE_COLUMNA.N2 * poro)], [S.O2, Math.round(AIRE_COLUMNA.O2 * poro)], [S.CO2, Math.round(AIRE_COLUMNA.CO2 * poro)],
      ], T);
      humedad += Math.min(1, t.moisture);
      // Un vaso (charca, manantial, humedal) tiene su lote de agua aunque hoy esté seco: la lluvia y la escorrentía lo llenan.
      const potable = Math.round((t.drinkingWater ?? 0) * e.agua), vaso = esVaso(t);
      this.agua[i] = vaso ? this.arena.nuevo(Rol.Agua, c, 0) : -1;
      this.manantial[i] = vaso && t.feature === 'spring' ? 1 : 0;
      if (vaso && potable > 0) this.llenar(this.agua[i]!, [[S.H2O, potable]], T);
      this.vida[i] = this.arena.nuevo(Rol.Vida, c, 0);
      const u = { hoja: Math.round(t.vegetation * e.vegetacion), fruto: Math.round(t.food * e.alimento), tronco: Math.round((t.wood ?? 0) * e.madera) };
      const tejido = new Map<SustanciaId, number>();
      for (const o of ORGANOS) for (const [k, nu] of PARTES[o]) tejido.set(S[k], (tejido.get(S[k]) ?? 0) + u[o] * nu);
      this.llenar(this.vida[i]!, [...tejido], T);
      this.latente[i] = Math.round((t.stone ?? 0) * e.piedra);
    }
    // Aire de la página: la columna de cada tesela, con el vapor a la humedad relativa media de sus suelos. Si un vecino
    // ya le mandó vapor antes de materializarse, el lote existe y se aprovecha.
    this.aire[p] = this.buscar(p * 256, Rol.Aire) ? this.buscado[0]! : this.arena.nuevo(Rol.Aire, p * 256, 0);
    const gases = GASES_COLUMNA.reduce((s, g) => s + AIRE_COLUMNA[g], 0) * nT;
    this.llenar(this.aire[p]!, [
      ...GASES_COLUMNA.map((g) => [S[g], AIRE_COLUMNA[g] * nT] as const),
      [S.H2O, Math.round((humedad / nT) * this.vaporSaturado(gases, T))],
    ], T);
    // Cielo: el aire del océano que le toca a la página, con el agua de su régimen. Mar: su agua libre.
    const tAlto = T - f.enfriamientoAltura, gasesCielo = Math.round(f.oceanoPorTierra * gases);
    this.cielo[p] = this.arena.nuevo(ROL_DEPOSITO, p * 256 + CELDA_CIELO, 0);
    this.llenar(this.cielo[p]!, [
      ...GASES_COLUMNA.map((g) => [S[g], Math.round(f.oceanoPorTierra * AIRE_COLUMNA[g] * nT)] as const),
      [S.H2O, Math.round(this.params.llenadoCielo * gasesCielo * this.razonVapor(tAlto))],
    ], tAlto);
    this.mar[p] = this.arena.nuevo(ROL_DEPOSITO, p * 256 + CELDA_MAR, 0);
    this.llenar(this.mar[p]!, [[S.H2O, Math.round(f.aguaMarPorCielo * this.cieloReferencia * nT)]], T);
    this.activa[p] = 1;
  }

  /**
   * Da de alta la página p con los lotes que ya tiene en la arena (un chunk que durmió, o un mundo cargado): los busca
   * por celda y rol, sin crear nada. La roca latente y los manantiales se leen de `tiles`. Devuelve false, sin tocar
   * nada, si la arena no tiene el suelo de su primera tesela (la página nunca se materializó).
   */
  adoptar(p: number, tiles: readonly Tile[]): boolean {
    if (!tiles.length || !this.buscar(p * 256 + local(tiles[0]!), Rol.Suelo)) return false;
    const i0 = this.abrir(p, tiles), e = this.params.escalas;
    for (let j = 0; j < tiles.length; j++) {
      const t = tiles[j]!, i = i0 + j, c = this.celda[i]!;
      this.suelo[i] = this.exigir(c, Rol.Suelo); this.vida[i] = this.exigir(c, Rol.Vida);
      this.agua[i] = this.buscar(c, Rol.Agua) ? this.buscado[0]! : -1;
      this.manantial[i] = this.agua[i]! >= 0 && t.feature === 'spring' ? 1 : 0;
      this.latente[i] = Math.round((t.stone ?? 0) * e.piedra);
    }
    this.aire[p] = this.exigir(p * 256, Rol.Aire);
    this.mar[p] = this.exigir(p * 256 + CELDA_MAR, ROL_DEPOSITO); this.cielo[p] = this.exigir(p * 256 + CELDA_CIELO, ROL_DEPOSITO);
    this.activa[p] = 1;
    return true;
  }

  private buscar(celda: number, rol: Rol): boolean { return this.arena.lotes(celda, rol, this.buscado) > 0; }
  private exigir(celda: number, rol: Rol): LoteRef {
    if (!this.buscar(celda, rol)) throw new Error(`Mundo material: falta el lote de rol ${rol} de la celda ${celda}.`);
    return this.buscado[0]!;
  }

  /** La página deja de dar pasos; sus lotes siguen en la arena y en el libro. */
  dormir(p: number): void { if (p < this.np) this.activa[p] = 0; }

  /** Vuelve a dar pasos una página dormida que este mundo conserva. Devuelve false si no la tiene o sus lotes caducaron. */
  despertar(p: number, x: number, y: number): boolean {
    if (!this.tiene(p)) return false;
    const i0 = this.inicio[p]!;
    if (!this.arena.propio(this.suelo[i0]!) || !this.arena.propio(this.aire[p]!)) return false;
    if (Math.floor(this.x[i0]! / 16) !== Math.floor(x / 16) || Math.floor(this.y[i0]! / 16) !== Math.floor(y / 16)) return false;
    this.activa[p] = 1;
    return true;
  }

  /** Olvida la página p (sus lotes no se tocan): su ranura de chunk pasó a otro sitio del mundo o a otro dueño. */
  olvidar(p: number): void {
    if (p >= this.np) return;
    for (let i = this.inicio[p]!; i < this.fin[p]!; i++) this.indices[this.celda[i]!] = 0;
    this.activa[p] = 0; this.inicio[p] = 0; this.fin[p] = 0; this.aire[p] = -1; this.mar[p] = -1; this.cielo[p] = -1;
  }

  // ── Forzamiento y utilidades ──

  temperatura(p: number, luz: number): number { return T_NOCHE + (T_DIA - T_NOCHE) * luz + this.dT[p]!; }

  /** Fracción de la columna de aire que es capa límite a T: h / H, con H = R·T/(M·g). */
  capaLimite(T: number): number { return this.params.fisica.alturaCapaLimite * this.masaAire * GRAVEDAD / (R_MOL * T); }

  /** Cuantos de vapor por cuanto de gas seco de un aire saturado a T (Raoult–Dalton). */
  razonVapor(T: number): number {
    const tEb = this.quimica.sustancia(this.S.H2O).prop.tEbullicion;
    const x = Math.min(0.99, Math.exp(-TROUTON * (tEb / T - 1)));
    return x / (1 - x);
  }

  /** Cuantos de vapor que satura la capa límite de un aire con `gases` cuantos de otros gases, con la capa a T y el
   * vapor saturado a `tVapor`. */
  vaporSaturado(gases: number, T: number, tVapor = T): number { return this.capaLimite(T) * gases * this.razonVapor(tVapor); }

  private esGas(id: SustanciaId, T: number): boolean {
    const k = id * 8192 + Math.round(T);
    let g = this.gas.get(k);
    if (g === undefined) this.gas.set(k, g = esGasA(this.quimica.sustancia(id), T));
    return g;
  }

  /** Sustancias de `l` en el búfer de trabajo (válido hasta la siguiente llamada). */
  especies(l: LoteRef): Uint32Array {
    let n = this.arena.especies(l, this.ids);
    if (n > this.ids.length) n = this.arena.especies(l, this.ids = new Uint32Array(2 * n));
    return this.ids.subarray(0, n);
  }

  private pide(esp: SustanciaId, cuantos: number): Pedido { this.pedido.esp = esp; this.pedido.cuantos = cuantos; return this.pedido; }

  /** Vista del aire de la página p (para dibujar nubes, lluvia y ríos): su humedad relativa a T, y lo que llovió y lo que
   * escurrió al mar en su último paso, en unidades de humedad por tesela. */
  vistaAire(p: number, T: number, out: VistaAire): VistaAire {
    const a = this.aire[p]!, nT = this.fin[p]! - this.inicio[p]!, hum = this.params.escalas.humedad;
    out.humedadRelativa = this.arena.cuantos(a, this.S.H2O) / this.vaporSaturado(this.gasesSecos(a, T), T);
    out.lluvia = this.lluvia[p]! / nT / hum;
    out.desague = this.desague[p]! / nT / hum;
    return out;
  }

  lotesTesela(i: number): LotesTesela {
    return { suelo: this.suelo[i]!, agua: this.agua[i]!, vida: this.vida[i]!, latente: this.latente[i]! };
  }

  vista(i: number, out: VistaTesela): VistaTesela {
    return vistaTesela((l, id) => this.arena.cuantos(l, id), this.lotesTesela(i), this.S.H2O, this.params.escalas, this.organos, out, this.u);
  }

  unidades(i: number, out: Unidades): Unidades { return unidadesVida((l, id) => this.arena.cuantos(l, id), this.vida[i]!, this.organos, out); }

  /** Deja en `fN` y `fP` la toma de N y de P que permite el suelo `l` (Monod sobre su N mineral y sus fosfatos). */
  private nutrientes(l: LoteRef): void {
    const n = this.arena.cuantos(l, this.S.NH3);
    let p = 0;
    for (const id of this.plantillas.fosfatos) p += this.arena.cuantos(l, id);
    this.fN = n / (n + this.params.kmN); this.fP = p / (p + this.params.kmP);
  }

  /** Fertilidad de la tesela i como la leen las leyes escalares: el menor de su N mineral y su P sobre los de un suelo de
   * fertilidad 1 (la inversa de cómo se materializa). */
  fertilidad(i: number): number {
    const l = this.suelo[i]!, cajas = this.params.suelo;
    let p = 0;
    for (const id of this.plantillas.fosfatos) p += this.arena.cuantos(l, id);
    return Math.min(this.arena.cuantos(l, this.S.NH3) / (NH3_FERTIL * cajas), p / (H3PO4_FERTIL * cajas));
  }

  /** Fracción de la tesela i que cubre su dosel (lo que no deja ver el suelo). */
  cubierta(i: number): number { return captura(this.unidades(i, this.u).hoja / this.params.escalas.vegetacion, this.params.fisica); }

  paginasPropias(): number[] {
    const out: number[] = [];
    for (let p = 0; p < this.np; p++) if (this.lab ? this.dueno[p] === this.hilo : this.activa[p] === 1) out.push(p);
    return out;
  }

  private get laboratorio(): NonNullable<Nucleo['laboratorio']> {
    if (!this.lab) throw new Error('Solo el mundo del laboratorio tiene arena y memoria propias.');
    return this.lab;
  }
  /** Descriptor para conectar otros hilos (solo laboratorio). */
  get d(): DescriptorMundo { return this.laboratorio.d; }
  /** La arena con lo que no está en el contrato (barrera, saldo, muestras): solo laboratorio. */
  get arenaLab(): ArenaLotes { return this.laboratorio.arena; }

  /** Lo que el coordinador hace en F0 antes de un paso: reservas para lo que los hilos puedan crear (solo laboratorio;
   * con el motor las reserva quien administra la arena). */
  prepararPaso(): void {
    const { memorias, d } = this.laboratorio;
    memorias.lotes.prepararF0(256 * d.hilos, LOTES_POR_BLOQUE);
    memorias.desborde.prepararF0(4096 + 8 * this.n);
  }

  // ── Paso ──

  /** Un paso entero con un solo hilo: las dos fases seguidas. Con varios, cada hilo hace `pasarLocal` y, cuando todos han
   * terminado, `recibir`. */
  pasar(f: Forzamiento): void {
    if (this.d.hilos !== 1) throw new Error('Con varios hilos, pasarLocal en todos y después recibir en todos.');
    this.pasarLocal(f); this.recibir();
  }

  /** Fase local de todas las páginas de este hilo (laboratorio). */
  pasarLocal(f: Forzamiento): void {
    this.arenaLab.barrera();
    for (let p = 0; p < this.np; p++) if (this.dueno[p] === this.hilo) this.pasarPagina(p, f);
  }

  /** Segunda fase (laboratorio): cada página de este hilo abona el vapor que le mandaron sus vecinas. */
  recibir(): void {
    const H2O = this.S.H2O, tr = this.transito;
    for (let p = 0; p < this.np; p++) {
      if (this.dueno[p] !== this.hilo) continue;
      for (let dir = 0; dir < 4; dir++) {
        const q = this.vecinas[4 * p + dir]!;
        if (q < 0) continue;
        const k = 2 * (4 * q + (dir ^ 1)), n = tr[k]!, calor = tr[k + 1]!;
        if (n === 0 && calor === 0) continue;
        this.arena.abonar(this.aire[p]!, Float64Array.of(H2O, n, 0, calor), this.libro);
        tr[k] = 0; tr[k + 1] = 0;
      }
    }
  }

  private tomarAzar(p: number): void { if (!this.motor) this.semilla = this.estadoAzar[p]!; }
  private dejarAzar(p: number): void { if (!this.motor) this.estadoAzar[p] = this.semilla; }
  private partido(f: Forzamiento): boolean { return this.params.reparto === 'strang' && f.dt > 1; }

  /** Un paso de la página p. Son tres tramos para que la química de los suelos pueda ir a la tarjeta entre el primero y
   * el último: `pasarAntes`, `quimicaSuelos` (o su equivalente aplicado desde fuera) y `pasarDespues`. */
  pasarPagina(p: number, f: Forzamiento): void {
    this.pasarAntes(p, f); this.quimicaSuelos(p, f.dt); this.pasarDespues(p, f);
  }

  /** Primera media ventana de vida (o la ventana entera con el reparto 'inicio'). */
  pasarAntes(p: number, f: Forzamiento): void {
    this.tomarAzar(p);
    this.vivir(p, f.luz, this.partido(f) ? f.dt / 2 : f.dt, true);
    this.dejarAzar(p);
  }

  /** Química de los suelos de la página (descomposición y respiración), con la κ del rol. */
  quimicaSuelos(p: number, dt: number): void {
    this.tomarAzar(p);
    for (let i = this.inicio[p]!, i1 = this.fin[p]!; i < i1; i++) pasoLote(this.ctx, this.suelo[i]!, dt, K_SUELO);
    this.dejarAzar(p);
  }

  /** El resto del paso: química de charcas y aire, intercambios, ciclo del agua, segunda media ventana de vida y radiación. */
  pasarDespues(p: number, f: Forzamiento): void {
    const { dt } = f, a = this.aire[p]!, i0 = this.inicio[p]!, i1 = this.fin[p]!, c = this.ctx, partido = this.partido(f);
    const luzFin = f.luzFin ?? f.luz;
    const T = this.temperatura(p, partido ? (f.luz + luzFin) / 2 : f.luz), Taire = f.lluvia ? T - DT_LLUVIA : T;
    this.tomarAzar(p);
    for (let i = i0; i < i1; i++) if (this.agua[i]! >= 0) pasoLote(c, this.agua[i]!, dt, SIN);
    pasoLote(c, a, dt, SIN);
    const capAire = CAP_AIRE_TESELA * (i1 - i0);
    for (let i = i0; i < i1; i++) {
      this.intercambiar(this.suelo[i]!, a, G_SUELO, CAP_SUELO, capAire, dt, T);
      if (this.agua[i]! >= 0) fluir(c, this.agua[i]!, this.suelo[i]!, this.S.H2O, this.params.gCharca, this.params.escalas.agua, this.params.escalas.humedad, 0, dt);
    }
    this.vapor(p, dt, Taire);
    this.mezclarCielo(p, dt, Taire);
    this.llover(p, f, Taire);
    this.escurrir(p);
    this.manar(p, dt);
    this.enviar(p, dt);
    this.posar(p, Taire);
    if (partido) this.vivir(p, luzFin, dt / 2, false);
    for (let i = i0; i < i1; i++) {
      this.termostato(this.suelo[i]!, T); this.termostato(this.vida[i]!, T);
      if (this.agua[i]! >= 0) this.termostato(this.agua[i]!, T);
    }
    this.termostato(a, Taire);
    this.termostato(this.mar[p]!, T);
    this.termostato(this.cielo[p]!, Taire - this.params.fisica.enfriamientoAltura);
    this.dejarAzar(p);
  }

  /** Vida de la página durante dt: crecer y caer en cada tesela. Con `medir`, deja la cobertura foliar media de la página
   * (la que siembra las teselas peladas en la ventana siguiente). */
  private vivir(p: number, luz: number, dt: number, medirCobertura: boolean): void {
    const i0 = this.inicio[p]!, i1 = this.fin[p]!, a = this.aire[p]!;
    this.hojas = 0;
    for (let i = i0; i < i1; i++) { this.crecer(i, p, a, luz, dt); this.caer(i, dt); }
    if (medirCobertura && i1 > i0) this.cobertura[p] = this.hojas / (i1 - i0) / this.params.escalas.vegetacion;
  }

  /**
   * Sol y síntesis: cada órgano produce G·luz·agua·nutrientes·captura·dt unidades base, recortado a lo que haya de cada
   * entrada (`copiar`). La captura es la del dosel propio más las plántulas que llegan de la página; los nutrientes
   * frenan con la toma de Monod del N mineral y del P del suelo (Liebig), y la parte que el N del suelo no cubre solo
   * puede venir de la fijación de N₂. El tronco solo crece donde ya hay tronco. El sol entra como calor en la Vida (fuente
   * declarada) y lo que la síntesis no usa lo devuelve el termostato (radiación).
   */
  private crecer(i: number, p: number, aire: LoteRef, luz: number, dt: number): void {
    const u = this.unidades(i, this.u);
    this.hojas += u.hoja;
    if (!(luz > 0)) return;
    const e = this.params.escalas, fi = this.params.fisica, G = this.params.crecimiento;
    const dosel = u.hoja / e.vegetacion + fi.dispersionSemillas * this.cobertura[p]!;
    if (!(dosel > 0)) return;
    const vida = this.vida[i]!, suelo = this.suelo[i]!, agua = this.agua[i]!;
    const riego = this.charcaConAgua(i) ? 1 : Math.min(1, this.arena.cuantos(suelo, this.S.H2O) / e.humedad);
    this.nutrientes(suelo);
    // Liebig, como `liebig`, sin crear un objeto por tesela.
    const delSuelo0 = Math.min(this.fP, this.fN), fijable = Math.min(this.fP, this.fN + (1 - this.fN) * fi.fijacionN2) - delSuelo0;
    const base = luz * riego * captura(dosel, fi) * dt, z = this.ctx.azar;
    const conSuelo = this.pideSuelo, conFijacion = this.pideFijado;
    let sol = 0;
    for (const o of ORGANOS) {
      // El tronco no lleva N: todo lo que los nutrientes dejan crecer sale por su única plantilla.
      const sinN = o === 'tronco', crece = sinN && u.tronco === 0 ? 0 : G[o] * base;
      conSuelo[o] = entero(crece * (sinN ? delSuelo0 + fijable : delSuelo0), z);
      conFijacion[o] = sinN ? 0 : entero(crece * fijable, z);
      sol += (conSuelo[o] + conFijacion[o]) * this.plantillas.dHMax[o];
    }
    sol = Math.ceil(sol);
    if (sol <= 0) return;
    this.arena.fuente(vida, Float64Array.of(0, sol), this.libro);
    this.cuentas[SOL]! += sol;
    const fuentes = agua >= 0 ? [suelo, agua, aire] : [suelo, aire];
    for (const o of ORGANOS) {
      let delSuelo = conSuelo[o], fijado = conFijacion[o];
      for (const v of this.plantillas[o]) {
        const max = Math.floor((v.fija ? fijado : delSuelo) / v.k);
        if (max <= 0) continue;
        const hecho = v.k * copiar(this.arena, this.quimica, v.p, vida, fuentes, aire, max * Math.max(0, v.p.sintesis.dH), max);
        if (v.fija) fijado -= hecho; else delSuelo -= hecho;
      }
    }
  }

  /** Caída al suelo (hojarasca, frutos, troncos muertos): binomial de las unidades de cada órgano, por unidades enteras.
   * Es la senescencia proporcional a la biomasa, y por ella vuelven al suelo el N y el P. */
  private caer(i: number, dt: number): void {
    const u = this.unidades(i, this.u), vida = this.vida[i]!, suelo = this.suelo[i]!, d = this.params.caida;
    for (const o of ORGANOS) {
      const k = binomial(u[o], -Math.expm1(-d[o] * dt), this.ctx.azar);
      if (k > 0) { this.moverUnidades(vida, suelo, o, k); this.cuentas[CAIDA]! += k * NU_ORGANO[o]; }
    }
  }

  private moverUnidades(de: LoteRef, a: LoteRef, o: Organo, k: number): void {
    for (const [s, nu] of PARTES[o]) this.arena.moverParte(de, a, this.pide(this.S[s], k * nu));
  }

  /** Intercambio de gases suelo–aire (`intercambioBruto` por cada gas presente en cualquiera de los dos). */
  private intercambiar(l: LoteRef, aire: LoteRef, g: number, capL: number, capA: number, dt: number, T: number): void {
    const vistos = this.vistos;
    vistos.clear();
    for (const lote of [l, aire]) for (const id of this.especies(lote)) {
      if (vistos.has(id) || id === this.S.H2O || !this.esGas(id, T)) continue;
      vistos.add(id);
    }
    for (const id of vistos) intercambioBruto(this.ctx, l, aire, id, g, capL, capA, dt);
  }

  /**
   * Evaporación y condensación (Dalton): cada tesela intercambia con su columna de aire r·(a·s − v), con s y v el vapor
   * saturado y el que hay por columna, a la actividad del agua de su superficie (1 en una charca, la humedad en el suelo,
   * hasta 1) y r = 1 − e^(−dt/τ). Con el aire más frío (noche, lluvia) s baja y el vapor vuelve como rocío.
   */
  private vapor(p: number, dt: number, T: number): void {
    const a = this.aire[p]!, H2O = this.S.H2O, i0 = this.inicio[p]!, i1 = this.fin[p]!, nT = i1 - i0;
    const sCol = this.vaporSaturado(this.gasesSecos(a, T), T) / nT, vCol = this.arena.cuantos(a, H2O) / nT;
    const r = -Math.expm1(-dt / this.params.tauVapor), hum = this.params.escalas.humedad;
    for (let i = i0; i < i1; i++) {
      const abierta = this.charcaConAgua(i), sup = abierta ? this.agua[i]! : this.suelo[i]!;
      const actividad = abierta ? 1 : Math.min(1, this.arena.cuantos(sup, H2O) / hum);
      const x = r * (actividad * sCol - vCol), k = entero(Math.abs(x), this.ctx.azar);
      if (k === 0) continue;
      if (x > 0) this.arena.moverParte(sup, a, this.pide(H2O, k));
      else this.arena.moverParte(a, sup, this.pide(H2O, k));
    }
  }

  private gasesSecos(a: LoteRef, T: number): number {
    let gases = 0;
    for (const id of this.especies(a)) if (id !== this.S.H2O && this.esGas(id, T)) gases += this.arena.cuantos(a, id);
    return gases;
  }

  /**
   * El cielo y el mar de la página. El arrastre mezcla la capa límite con el cielo (flujos brutos en los dos sentidos:
   * las concentraciones se igualan): el vapor, que en el aire de la página solo ocupa la capa límite, y los gases de la
   * columna (N₂, O₂ y CO₂), de los que la capa límite es la fracción h/H; así el CO₂ que la vegetación fija vuelve del
   * aire del planeta, que es finito. Los gases que el aire libre no tiene (NH₃, H₂) no se mezclan: la librería no
   * disuelve el NH₃ en el agua del suelo, así que en el aire está el que en un suelo real estaría disuelto, y llevárselo
   * sería sacar nitrógeno de los suelos. Después el mar evapora hacia el cielo lo que le falta para saturarse a la
   * temperatura de la altura (Dalton, en los dos sentidos: un cielo sobresaturado condensa sobre el mar).
   */
  private mezclarCielo(p: number, dt: number, Taire: number): void {
    const a = this.aire[p]!, cielo = this.cielo[p]!, A = this.arena, H2O = this.S.H2O, fi = this.params.fisica;
    const capa = this.capaLimite(Taire), g = capa / this.params.tauSeco, oceano = fi.oceanoPorTierra;
    intercambioBruto(this.ctx, a, cielo, H2O, g, capa, oceano, dt);
    this.cuentas[CIELO_SALE]! += bruto.ida; this.cuentas[CIELO_ENTRA]! += bruto.vuelta;
    for (const id of this.gasesLibres) intercambioBruto(this.ctx, a, cielo, id, g, 1, oceano, dt);
    const tAlto = Taire - fi.enfriamientoAltura, satura = this.gasesSecos(cielo, tAlto) * this.razonVapor(tAlto);
    const x = -Math.expm1(-dt / this.params.tauMar) * (satura - A.cuantos(cielo, H2O)), k = entero(Math.abs(x), this.ctx.azar);
    if (k === 0) return;
    this.cuentas[EVAPORA_MAR]! += x > 0 ? A.moverParte(this.mar[p]!, cielo, this.pide(H2O, k)) : -A.moverParte(cielo, this.mar[p]!, this.pide(H2O, k));
  }

  /**
   * Lluvia. Cuando el tiempo del mundo es de lluvia el cielo suelta su agua con la constante de tiempo de la nube (la
   * estación la acelera o la frena con `lluviaEscala`): no llueve más de lo que el cielo tiene. Además, lo que el aire de
   * la página tiene por encima de la saturación condensa (rocío, o lluvia con el aire frío del chubasco). Todo cae
   * repartido por igual entre las teselas: en la charca si la hay, si no en el suelo.
   */
  private llover(p: number, f: Forzamiento, T: number): void {
    const a = this.aire[p]!, cielo = this.cielo[p]!, H2O = this.S.H2O, A = this.arena;
    let nube = 0;
    if (f.lluvia) {
      nube = binomial(A.cuantos(cielo, H2O), -Math.expm1(-f.dt * (f.lluviaEscala ?? 1) / this.params.tauLluvia), this.ctx.azar);
      if (nube > 0) nube = A.moverParte(cielo, a, this.pide(H2O, nube));
      this.cuentas[LLUVIA]! += nube; this.cuentas[CIELO_ENTRA]! += nube;
    }
    const exceso = Math.max(0, A.cuantos(a, H2O) - Math.floor(this.vaporSaturado(this.gasesSecos(a, T), T)));
    // Lo que viene de la nube cae entero aunque el aire aún no esté saturado: la gota no se queda en el camino.
    const cae = Math.max(exceso, Math.min(nube, A.cuantos(a, H2O)));
    this.lluvia[p] = cae;
    if (cae <= 0) return;
    const i0 = this.inicio[p]!, nT = this.fin[p]! - i0;
    const cada = Math.floor(cae / nT), resto = cae - cada * nT, primero = Math.floor(this.ctx.azar() * nT);
    for (let j = 0; j < nT; j++) {
      const i = i0 + j, k = cada + ((j - primero + nT) % nT < resto ? 1 : 0);
      if (k > 0) A.moverParte(a, this.agua[i]! >= 0 ? this.agua[i]! : this.suelo[i]!, this.pide(H2O, k));
    }
  }

  /**
   * Escorrentía: el agua de un suelo por encima de su capacidad de campo (humedad 1) corre a las charcas de la página que
   * no están llenas (agua potable 1 es el vaso lleno), por orden de tesela; lo que no cabe, y lo que rebosa de una charca,
   * desagua en el mar de la página.
   */
  private escurrir(p: number): void {
    const H2O = this.S.H2O, A = this.arena, e = this.params.escalas, i0 = this.inicio[p]!, i1 = this.fin[p]!, mar = this.mar[p]!;
    let j = i0, fuera = 0;
    const hueco = (i: number) => this.agua[i]! >= 0 ? e.agua - A.cuantos(this.agua[i]!, H2O) : 0;
    for (let i = i0; i < i1; i++) {
      const suelo = this.suelo[i]!;
      let sobra = A.cuantos(suelo, H2O) - e.humedad;
      while (sobra > 0 && j < i1) {
        const k = Math.min(sobra, hueco(j));
        if (k > 0) { A.moverParte(suelo, this.agua[j]!, this.pide(H2O, k)); sobra -= k; }
        if (hueco(j) <= 0) j++;
      }
      if (sobra > 0) fuera += A.moverParte(suelo, mar, this.pide(H2O, sobra));
    }
    for (let i = i0; i < i1; i++) {
      const h = this.agua[i]! >= 0 ? hueco(i) : 0;
      if (h < 0) fuera += A.moverParte(this.agua[i]!, mar, this.pide(H2O, -h));
    }
    this.desague[p] = fuera;
    this.cuentas[DESAGUE]! += fuera;
  }

  /** Manantiales: del mar mana agua hacia cada manantial en proporción a lo que su nivel (sobre el de referencia) supera
   * el llenado del vaso (Darcy). Con el mar a su nivel y el vaso vacío es la recarga escalar de un manantial. */
  private manar(p: number, dt: number): void {
    const i0 = this.inicio[p]!, i1 = this.fin[p]!, mar = this.mar[p]!, H2O = this.S.H2O, A = this.arena, e = this.params.escalas;
    const referencia = this.params.fisica.aguaMarPorCielo * this.cieloReferencia * (i1 - i0);
    let nivel = -1;
    for (let i = i0; i < i1; i++) {
      if (!this.manantial[i] || this.agua[i]! < 0) continue;
      if (nivel < 0) nivel = A.cuantos(mar, H2O) / referencia;
      const carga = nivel - A.cuantos(this.agua[i]!, H2O) / e.agua;
      if (!(carga > 0)) continue;
      const k = entero(this.params.gManantial * carga * dt, this.ctx.azar);
      if (k > 0) this.cuentas[MANANTIAL]! += A.moverParte(mar, this.agua[i]!, this.pide(H2O, k));
    }
  }

  private vecinaDe(p: number, dir: number): number { return this.motor ? this.motor.vecina(p, dir) : this.vecinas[4 * p + dir]!; }

  /** El viento lleva a cada página vecina una fracción del vapor (flujos brutos, a concentración por tesela). En el
   * laboratorio queda en vuelo hasta que la vecina la abona en `recibir`; con el motor va directo al aire de una vecina
   * propia y despierta, y a la de otro dueño en vuelo, por su buzón. */
  private enviar(p: number, dt: number): void {
    const a = this.aire[p]!, H2O = this.S.H2O, nT = this.fin[p]! - this.inicio[p]!;
    const phi = -Math.expm1(-dt / this.params.tauViento) / 8;
    let v = this.arena.cuantos(a, H2O);
    for (let dir = 0; dir < 4; dir++) {
      const q = this.vecinaDe(p, dir);
      if (q < 0) continue;
      const mia = this.motor !== null && this.tiene(q) && this.activa[q] === 1;
      const nQ = this.motor && !mia ? nT : this.fin[q]! - this.inicio[q]!;
      const k = binomial(v, phi * Math.min(nT, nQ) / nT, this.ctx.azar);
      if (k <= 0) continue;
      if (mia) { v -= this.arena.moverParte(a, this.aire[q]!, this.pide(H2O, k)); continue; }
      const g = this.arena.garantizar(a, this.pide(H2O, k), this.libro);
      let n = 0, calor = 0;
      for (let x = 0; x < g.length; x += 2) if (g[x] === H2O) n += g[x + 1]!; else if (g[x] === 0) calor += g[x + 1]!;
      if (this.motor) this.motor.exportar(p, q, g);
      else { this.transito[2 * (4 * p + dir)] = n; this.transito[2 * (4 * p + dir) + 1] = calor; }
      v -= n;
    }
  }

  private charcaConAgua(i: number): boolean { return this.agua[i]! >= 0 && this.arena.cuantos(this.agua[i]!, this.S.H2O) > 0; }

  /** Temperatura (K) de un lote propio; 0 si está vacío. */
  temperaturaLote(l: LoteRef): number {
    const at = medir(this.ctx, l).atomos;
    return at > 0 ? this.arena.calor(l) / (CAPACIDAD_ATOMO * at) : 0;
  }

  /** Lo que no es gas en el aire (salvo el vapor) se posa en el suelo de la primera tesela de la página. */
  private posar(p: number, T: number): void {
    const a = this.aire[p]!, suelo = this.suelo[this.inicio[p]!]!;
    for (const id of [...this.especies(a)]) if (id !== this.S.H2O && !this.esGas(id, T)) {
      this.arena.moverParte(a, suelo, this.pide(id, this.arena.cuantos(a, id)));
    }
  }

  /** Radiación: lleva el lote a T con calor declarado (fuente si le falta, sumidero si le sobra). */
  termostato(l: LoteRef, T: number, cuenta = -1): void {
    const d = Math.round(T * CAPACIDAD_ATOMO * medir(this.ctx, l).atomos) - this.arena.calor(l);
    if (d > 0) { this.arena.fuente(l, Float64Array.of(0, d), this.libro); this.cuentas[cuenta >= 0 ? cuenta : RAD_ENTRA]! += d; }
    else if (d < 0) { this.arena.sumidero(l, Float64Array.of(0, -d), this.libro); this.cuentas[RAD_SALE]! -= d; }
  }

  // ── Fuentes y sumideros de materia ──

  /** Asienta una fuente (`entra`) o un sumidero declarado de materia en el lote `l` y lo suma a su cuenta en J y en
   * átomos; `exterior` lo lleva además al neto con el exterior. Devuelve lo que de verdad entró o salió. */
  private declarar(l: LoteRef, pares: Float64Array, entra: boolean, cuentaJ: number, cuentaAt: number, exterior: boolean): Float64Array {
    let hecho = pares;
    if (entra) this.arena.fuente(l, pares, this.libro); else hecho = this.arena.sumidero(l, pares, this.libro);
    const signo = entra ? 1 : -1;
    let j = 0, at = 0;
    for (let k = 0; k < hecho.length; k += 2) {
      const id = hecho[k]!, n = hecho[k + 1]!;
      if (id === 0) { j += n; continue; }
      const s = this.quimica.sustancia(id);
      j += n * s.energia;
      for (let e = 0; e < NE; e++) {
        if (!s.atomos[e]) continue;
        at += n * s.atomos[e]!;
        if (exterior) this.cuentas[EXTERIOR_AT + e]! += signo * n * s.atomos[e]!;
      }
    }
    this.cuentas[cuentaJ]! += j; this.cuentas[cuentaAt]! += at;
    if (exterior) this.cuentas[EXTERIOR_J]! += signo * j;
    return hecho;
  }

  /** Pares de `cont` (los de cantidad positiva) con su calor a T. */
  private conCalor(cont: readonly (readonly [SustanciaId, number])[], T: number): Float64Array {
    const pares: number[] = [];
    let at = 0;
    for (const [id, c] of cont) {
      if (!(c > 0)) continue;
      pares.push(id, c);
      at += c * this.quimica.sustancia(id).atomos.reduce((s, v) => s + v, 0);
    }
    const calor = Math.round(T * CAPACIDAD_ATOMO * at);
    if (calor > 0) pares.push(0, calor);
    return Float64Array.from(pares);
  }

  private llenar(l: LoteRef, cont: readonly (readonly [SustanciaId, number])[], T: number): void {
    const pares = this.conCalor(cont, T);
    if (pares.length) this.declarar(l, pares, true, CHUNK_J, CHUNK_AT, false);
  }

  private unidadesDe(o: Organo, k: number): (readonly [SustanciaId, number])[] { return PARTES[o].map(([s, nu]) => [this.S[s], k * nu] as const); }

  /** Saca `k` unidades del órgano `o` de la tesela i (comer, recolectar, talar con cuerpos aún escalares) hacia el
   * sumidero declarado «uso heredado». Devuelve las sacadas. */
  extraer(i: number, o: Organo, k: number): number {
    k = Math.min(Math.floor(k), this.unidades(i, this.u)[o]);
    if (!(k > 0)) return 0;
    this.declarar(this.vida[i]!, this.conCalor(this.unidadesDe(o, k), this.temperaturaLote(this.vida[i]!)), false, USO_J, USO_AT, true);
    return k;
  }

  /** Saca `cuantos` de agua de la charca (o del suelo si no hay) de la tesela i hacia el sumidero «uso heredado» (beber). */
  beber(i: number, cuantos: number): number {
    const l = this.agua[i]! >= 0 ? this.agua[i]! : this.suelo[i]!;
    const k = Math.min(Math.floor(cuantos), this.arena.cuantos(l, this.S.H2O));
    if (!(k > 0)) return 0;
    this.declarar(l, this.conCalor([[this.S.H2O, k]], this.temperaturaLote(l)), false, USO_J, USO_AT, true);
    return k;
  }

  /** Pone `k` unidades del órgano `o` en la tesela i (sembrar con una ley aún escalar): fuente «aporte heredado», a la
   * temperatura del suelo. Devuelve las puestas. */
  aportar(i: number, o: Organo, k: number): number {
    k = Math.floor(k);
    if (!(k > 0)) return 0;
    this.declarar(this.vida[i]!, this.conCalor(this.unidadesDe(o, k), this.temperaturaLote(this.suelo[i]!)), true, APORTE_J, APORTE_AT, true);
    return k;
  }

  /** Pone `cuantos` de agua en la charca (o en el suelo si no hay) de la tesela i: fuente «aporte heredado» (regar). */
  regar(i: number, cuantos: number): number {
    const k = Math.floor(cuantos), l = this.agua[i]! >= 0 ? this.agua[i]! : this.suelo[i]!;
    if (!(k > 0)) return 0;
    this.declarar(l, this.conCalor([[this.S.H2O, k]], this.temperaturaLote(this.suelo[i]!)), true, APORTE_J, APORTE_AT, true);
    return k;
  }

  /** Materializa hasta `cuantos` de la roca latente de la tesela i en el lote `destino` (fuente declarada «roca»), a la
   * temperatura del suelo. Devuelve los materializados. */
  sacarRoca(i: number, cuantos: number, destino: LoteRef): number {
    const k = Math.min(Math.floor(cuantos), this.latente[i]!);
    if (!(k > 0)) return 0;
    this.declarar(destino, this.conCalor([[this.S.SiO2, k]], this.temperaturaLote(this.suelo[i]!)), true, ROCA_J, ROCA_AT, true);
    this.latente[i]! -= k;
    return k;
  }

  /** Roca latente que una ley aún escalar saca (k > 0) o devuelve (k < 0). No pasa por la arena: entraría por la fuente
   * «roca» y saldría en el mismo acto por «uso heredado» (o al revés), así que solo se anota en las dos cuentas. Devuelve
   * los cuantos que cambió. */
  moverLatente(i: number, k: number): number {
    const hecho = k > 0 ? Math.min(Math.floor(k), this.latente[i]!) : Math.ceil(k);
    if (hecho === 0) return 0;
    this.latente[i]! -= hecho;
    const s = this.quimica.sustancia(this.S.SiO2), at = hecho * s.atomos.reduce((x, v) => x + v, 0), j = hecho * s.energia;
    this.cuentas[ROCA_AT]! += at; this.cuentas[ROCA_J]! += j;
    if (hecho > 0) { this.cuentas[USO_AT]! += at; this.cuentas[USO_J]! += j; }
    else { this.cuentas[APORTE_AT]! -= at; this.cuentas[APORTE_J]! -= j; }
    return hecho;
  }

  /** Pisoteo: `k` unidades de hoja de la tesela i caen al suelo (nada sale del mundo). Devuelve las caídas. */
  pisar(i: number, k: number): number {
    k = Math.min(Math.floor(k), this.unidades(i, this.u).hoja);
    if (!(k > 0)) return 0;
    this.moverUnidades(this.vida[i]!, this.suelo[i]!, 'hoja', k);
    this.cuentas[CAIDA]! += k * NU_ORGANO.hoja;
    return k;
  }

  /** Abono de una ley aún escalar: sube la fertilidad de la tesela i en `fertilidad` con el N mineral y el P que tiene
   * un suelo de esa fertilidad (fuente «aporte heredado»). */
  abonar(i: number, fertilidad: number): void {
    const cajas = this.params.suelo, l = this.suelo[i]!;
    const pares = this.conCalor([[this.S.NH3, Math.round(NH3_FERTIL * fertilidad * cajas)], [this.S.H3PO4, Math.round(H3PO4_FERTIL * fertilidad * cajas)]], this.temperaturaLote(l));
    if (pares.length) this.declarar(l, pares, true, APORTE_J, APORTE_AT, true);
  }

  // ── Fuego ──

  /** O₂ que hace falta para oxidar del todo lo que hay en `l` (C → CO₂, H → H₂O, P → P₂O₅), en cuantos. */
  oxigenoQuePide(l: LoteRef): number {
    const C = E('C'), H = E('H'), O = E('O'), P = E('P');
    let o2 = 0;
    for (const id of this.especies(l)) {
      if (id === this.S.O2) continue;
      const at = this.quimica.sustancia(id).atomos;
      o2 += this.arena.cuantos(l, id) * Math.max(0, at[C]! + at[H]! / 4 - at[O]! / 2 + 1.25 * at[P]!);
    }
    return o2;
  }

  /**
   * Un tick de un fuego (su paso es de un tick, no el de la página). Aspira aire de `aire` (O₂ con el N₂ que lo acompaña,
   * a su temperatura) hasta tener O2_FUEGO veces lo que pide lo que le queda por oxidar, H₂ incluido, pero nunca más del
   * que su calor puede calentar sin acercarse a la temperatura de brasa (el tiro): un fuego recién prendido toma poco
   * aire y, según arde y se calienta, más, hasta que no le queda nada por oxidar. Luego arde (`pasoLote` sin catálisis) y
   * suelta al aire los humos (CO₂, H₂O y N₂) con su calor, que es lo que lo enfría. Devuelve si sigue ardiendo: le queda
   * algo por oxidar y no ha bajado de la temperatura de brasa.
   */
  arder(fuego: LoteRef, aire: LoteRef): boolean {
    const A = this.arena, S = this.S, fi = this.params.fisica, pide = this.oxigenoQuePide(fuego);
    if (!(pide > 0)) return false;
    const falta = Math.ceil(O2_FUEGO * pide) - A.cuantos(fuego, S.O2), o2Aire = A.cuantos(aire, S.O2);
    if (falta > 0 && o2Aire > 0) {
      const atomos = medir(this.ctx, fuego).atomos, T = A.calor(fuego) / (CAPACIDAD_ATOMO * atomos), tAire = this.temperaturaLote(aire);
      const n2PorO2 = A.cuantos(aire, S.N2) / o2Aire, mezcla = T - fi.tiroFuego * (T - fi.tBrasa);
      const atomosPorO2 = this.atomosDe(S.O2) + n2PorO2 * this.atomosDe(S.N2);
      // Balance de calor: tras aspirar x cuantos de O₂ con su N₂ a tAire, el lote queda a `mezcla` o por encima.
      const cabe = mezcla > tAire && T > mezcla ? Math.floor(atomos * (T - mezcla) / (mezcla - tAire) / atomosPorO2) : 0;
      const o2 = Math.min(falta, o2Aire, cabe);
      if (o2 > 0) {
        A.moverParte(aire, fuego, this.pide(S.O2, o2));
        const n2 = Math.round(o2 * n2PorO2);
        if (n2 > 0) A.moverParte(aire, fuego, this.pide(S.N2, n2));
      }
    }
    pasoLote(this.ctx, fuego, 1, SIN);
    for (const id of this.humos) {
      const n = A.cuantos(fuego, id);
      if (n > 0) A.moverParte(fuego, aire, this.pide(id, n));
    }
    return this.oxigenoQuePide(fuego) > 0 && this.temperaturaLote(fuego) >= fi.tBrasa;
  }

  private atomosDe(id: SustanciaId): number { return this.quimica.sustancia(id).atomos.reduce((x, v) => x + v, 0); }

  /**
   * Quema la fracción `fraccion` de cada órgano de la tesela i con el protocolo de la caja validada (laboratorio): lo
   * quemado va a un lote de fuego con dos veces el O₂ estequiométrico del aire (y su N₂), arde TICKS_FUEGO ticks cerrado
   * desde 1.100 K (la ignición es calor declarado) y luego los gases vuelven al aire y lo demás, con el calor, al suelo.
   * Devuelve las unidades quemadas. Los fuegos del mundo (`encender`) arden abiertos, con `arder`.
   */
  quemar(i: number, fraccion: number, p = this.paginaDe(i)): number {
    const u = { ...this.unidades(i, this.u) }, vida = this.vida[i]!, suelo = this.suelo[i]!, aire = this.aire[p]!;
    const fuego = this.arena.nuevo(Rol.Objeto, -1, 0);
    let quemadas = 0;
    for (const o of ORGANOS) {
      const k = Math.round(u[o] * fraccion);
      if (k > 0) { this.moverUnidades(vida, fuego, o, k); quemadas += k; }
    }
    const pedido = Math.ceil(O2_FUEGO * this.oxigenoQuePide(fuego));
    this.arena.mover({ de: aire, a: fuego, esp: this.S.O2, cuantos: pedido });
    this.arena.mover({ de: aire, a: fuego, esp: this.S.N2, cuantos: Math.round(pedido * 78 / 21) });
    this.termostato(fuego, T_IGNICION, IGNICION);
    for (let t = 0; t < TICKS_FUEGO; t++) pasoLote(this.ctx, fuego, 1, SIN);
    const T = this.temperatura(p, 1);
    this.termostato(fuego, T);
    for (const id of [...this.especies(fuego)]) {
      this.arena.mover({ de: fuego, a: this.esGas(id, T) ? aire : suelo, esp: id, cuantos: this.arena.cuantos(fuego, id) });
    }
    this.arena.moverCalor(fuego, suelo, this.arena.calor(fuego));
    this.arena.liberar(fuego);
    return quemadas;
  }

  paginaDe(i: number): number { return this.celda[i]! >> 8; }

  // ── Libro ──

  /** Suma en bigint los libros de todos los hilos (fuentes − sumideros − en vuelo) y la contabilidad, y los deja a cero
   * (laboratorio; con el motor el libro lo pliega el coordinador y las cuentas se vuelcan con `volcarCuentas`). */
  plegar(totales: { esperado: bigint[]; cuentas: bigint[] }): void {
    const { libros, d } = this.laboratorio;
    for (let h = 0; h < d.hilos; h++) {
      const b = h * (LIBRO + CUENTAS);
      for (let k = 0; k <= NE; k++) {
        totales.esperado[k]! += BigInt(libros[b + k]!) - BigInt(libros[b + NE + 1 + k]!) - BigInt(libros[b + 2 * (NE + 1) + k]!);
        libros[b + k] = 0; libros[b + NE + 1 + k] = 0; libros[b + 2 * (NE + 1) + k] = 0;
      }
      for (let k = 0; k < CUENTAS; k++) { totales.cuentas[k]! += BigInt(libros[b + LIBRO + k]!); libros[b + LIBRO + k] = 0; }
    }
  }

  /** Suma las cuentas de este mundo a `acumulado` (bigint, CUENTAS posiciones) y las deja a cero. */
  volcarCuentas(acumulado: bigint[]): void {
    for (let k = 0; k < CUENTAS; k++) {
      const v = this.cuentas[k]!;
      if (v !== 0) { acumulado[k]! += BigInt(Math.round(v)); this.cuentas[k] = 0; }
    }
  }

  /** Σ de todos los lotes vivos: átomos por elemento y energía (química + calor), en bigint (laboratorio). */
  saldo(): bigint[] { return this.arenaLab.saldo(); }

  /** Cuantos por sustancia en todo el mundo, para los ciclos (laboratorio). */
  inventario(): Map<SustanciaId, number> {
    const t = new Map<SustanciaId, number>();
    for (const x of this.arenaLab.muestras()) for (let k = 0; k < x.pares.length; k += 2) {
      const id = x.pares[k]!;
      if (id) t.set(id, (t.get(id) ?? 0) + x.pares[k + 1]!);
    }
    return t;
  }

  /** Bytes de la memoria material (lotes, desborde y páginas; laboratorio). */
  bytes(): number { const { memorias } = this.laboratorio; return memorias.lotes.bytes + memorias.desborde.bytes + memorias.paginas.bytes; }
}

export const CUENTA = {
  SOL, RAD_ENTRA, RAD_SALE, IGNICION, CAIDA, CIELO_ENTRA, CIELO_SALE, DESAGUE, EXTERIOR_J, LLUVIA, EVAPORA_MAR, MANANTIAL,
  CHUNK_J, CHUNK_AT, USO_J, USO_AT, APORTE_J, APORTE_AT, ROCA_J, ROCA_AT, EXTERIOR_AT,
} as const;
export const N_CUENTAS = CUENTAS;
export const totalesVacios = () => ({ esperado: Array<bigint>(NE + 1).fill(0n), cuentas: Array<bigint>(CUENTAS).fill(0n) });
