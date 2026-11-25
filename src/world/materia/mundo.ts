/**
 * Mundo material en sombra (carril W, etapa 1; ARQ-materia §2 y §5.1). Levanta, de las teselas de un mundo ya creado,
 * su estado en lotes de átomos y lo hace avanzar con las leyes de la librería de materia, sin que ninguna ley del mundo
 * escalar lo lea todavía.
 *
 * Por tesela: Suelo (κ del suelo), Agua si tiene agua potable o es un vaso (charca, manantial, humedal), y Vida (hoja, fruto y tronco en un solo lote, ver
 * vistas.ts). Por página de 16 × 16: un lote de Aire. La roca es una reserva latente (cuantos de SiO₂ fuera de la arena y
 * del libro) que solo entra, como fuente declarada, cuando algo la rompe. Las cantidades iniciales se eligen para que
 * las vistas reproduzcan los escalares de la tesela.
 *
 * Un paso material (cada N ticks, con dt = N) tiene dos fases. En la local (`pasarLocal`), cada hilo hace en sus
 * páginas: sol y crecimiento (`copiar` desde suelo, charca y aire), caída de hojas, frutos y troncos al suelo, química de
 * cada lote (`pasoLote`; la descomposición y la respiración del suelo salen de ahí), intercambio de gases suelo–aire,
 * filtración charca–suelo, el ciclo del agua (evaporación, intercambio con la atmósfera libre, lluvia y escorrentía) y el
 * termostato (radiación) hacia la temperatura del aire; el vapor que el viento lleva a una página vecina sale del aire en
 * vuelo (`garantizar`). En la segunda (`recibir`), cada página abona lo que le llegó. El azar va por página, así que el
 * resultado no depende del número de hilos (salvo las sustancias nuevas que descubra cada química local).
 *
 * Fuentes y sumideros declarados: la materia inicial (`levantar`), el sol (calor que paga la síntesis), la radiación
 * (termostato, en los dos sentidos), la ignición de un fuego, la atmósfera libre (vapor que entra y sale de la capa
 * límite), el desagüe (el agua que las charcas llenas no retienen y se va del mundo) y lo que se extrae (`extraer` y
 * `beber`, el sumidero de comer y beber de la etapa siguiente). Todo lo demás se conserva por construcción en la arena.
 */
import { CAPACIDAD_ATOMO, ELEMENTOS, KAPPA0, KAPPA_SUELO, KAPPA_SUELO_HH, NE, NIVEL_CATALIZADO, NU, R } from '../../shared/naturaleza.js';
import type { SustanciaId } from '../../shared/materia.js';
import type { Tile } from '../../shared/types.js';
import { PageArena, type ArenaCompartida } from '../soa/arena.js';
import type { Registro } from '../motor/contratos.js';
import { TICKS_PER_DAY } from '../mundo/tipos.js';
import { phaseAt } from '../mundo/crear.js';
import { DEFAULT_PARAMS } from '../params.js';
import {
  CRECIMIENTO_COMIDA, HAMBRE_POR_PASO, HAMBRE_POR_UNIDAD, INTERVALO_ECOLOGIA_TICKS, INTERVALO_TIEMPO_TICKS, LUZ_CREPSCULO,
  PROB_LLUVIA, RECARGA_LLUVIA, SED_POR_PASO, SED_POR_UNIDAD,
} from '../ecologia-constantes.js';
import { ArenaLotes, LOTES_POR_BLOQUE } from './arena.js';
import { indiceTipoEnlace, esGasA } from './quimica.js';
import { binomial, medir, pasoLote, type CtxPaso } from './paso.js';
import { fluir } from './fluir.js';
import { copiar, crearPlantilla } from './copiar.js';
import { cargarSustancias, serializarSustancias, type ServicioQuimicoImpl } from './servicio.js';
import {
  Parte, Rol, barreraEfectiva, nivelDeLote,
  type Kappa, type Libro, type LoteRef, type Plantilla, type ServicioQuimico, type Sustancia,
} from './tipos.js';
import { unidadesVacias, unidadesVida, vistaTesela, type Escalas, type LotesTesela, type Organos, type Unidades, type VistaTesela } from './vistas.js';

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
const KAPPA_COMEDOR: Kappa = [KAPPA0, KAPPA0, KAPPA0, KAPPA0];
const T_CUERPO = 310;

/** Clima (forzamiento declarado, como el sol): aire a 295 K a pleno sol y 288 K de noche; la lluvia es aire más frío. */
export const T_DIA = 295, T_NOCHE = 288, DT_LLUVIA = 4;

/** Geometría de la caja validada de la librería (tests/lib/caja-param.ts), por tesela. */
const AIRE_COLUMNA = { N2: 7_800_000, O2: 2_100_000, CO2: 200_000 };
const CAP_AIRE_TESELA = 100, CAP_SUELO = 10, G_SUELO = 1;
/** Suelo de la caja a fertilidad 1 (sus nutrientes escalan con la fertilidad de la tesela); el mundo lo agranda por
 * `ParamsMundo.suelo`. */
const SUELO_MINERAL = { SiO2: 1_000_000, CaCO3: 100_000 }, NH3_FERTIL = 60_000, H3PO4_FERTIL = 20_000;
/** P del suelo / P de la vegetación de referencia a su capacidad (en suelos reales, de 5 a 20). */
const SUELO_POR_VEGETACION = 5;

/** Fuego (como la caja): 60 ticks desde 1.100 K, con dos veces el O₂ estequiométrico (pedido de la química: O₂ ≥ 1×). */
const T_IGNICION = 1100, TICKS_FUEGO = 60, O2_FUEGO = 2;

/** Clausius–Clapeyron con la regla de Trouton (ΔH_vap = 88 J/(mol·K)·T_eb), con la T de ebullición del modelo. */
const TROUTON = 88 / 8.314;

// ── Atmósfera: capa límite, atmósfera libre y viento ─────────────────────────────────────────────────────
// El aire de una página es su columna entera de gases (la química la necesita), pero el vapor solo cabe en la capa
// límite, la parte baja que la superficie mezcla en el día: su fracción de la columna es h/H, con H = R·T/(M·g) la
// altura de escala del aire del modelo. Encima está la atmósfera libre, el depósito exterior declarado: con tiempo seco
// entra en la capa límite por arrastre lento y trae aire con el punto de rocío de la noche (el mínimo nocturno es el punto
// de rocío de la masa de aire); con lluvia la convección la renueva deprisa con aire saturado a la temperatura del día
// mientras la columna está DT_LLUVIA más fría, y el exceso llueve. Unidades SI; un tick son 86.400 s / 2.400 = 36 s.
// Entre corchetes, el intervalo barrido (un factor a cada lado, el resto fijo) en el que el laboratorio sigue pasando.
const SEGUNDOS_TICK = 86_400 / TICKS_PER_DAY, GRAVEDAD = 9.81, R_MOL = 1000 * R;

/** Parámetros físicos del mundo material (cada uno con su unidad, su valor real y, entre corchetes, el intervalo barrido). */
export const FISICA = {
  /** Altura de la capa límite (m). Real: 300 m de noche a 1–2 km de día. [ALTURA_CAPA_LIMITE] */
  alturaCapaLimite: 1000,
  /** Conductancia aerodinámica del vapor sobre la superficie, C_E·U (m/s): 1,3·10⁻³ × 7,7 m/s. [CONDUCTANCIA_SUPERFICIE] */
  conductanciaSuperficie: 0.01,
  /** Velocidad de arrastre de la atmósfera libre en la capa límite con tiempo seco (m/s). Real: 0,5–5 cm/s. [ARRASTRE_SECO] */
  arrastreSeco: 0.01,
  /** Velocidad vertical de la convección que renueva la capa límite mientras llueve (m/s). Real: 0,1–10 m/s. [CONVECCION_LLUVIA] */
  conveccionLluvia: 0.5,
  /** Viento que mezcla el aire de páginas vecinas (teselas por tick: el mundo no fija metros por tesela). [VIENTO] */
  viento: 0.1,
  /** Coeficiente de extinción de la luz en el dosel (adimensional). Real: 0,3–0,8; 0,5 en gramíneas. [EXTINCION_LUZ] */
  extincionLuz: 0.5,
  /** Índice foliar (m² de hoja por m² de suelo) de una cobertura completa, vegetación 1. Real: 3–6. [INDICE_FOLIAR] */
  indiceFoliarCobertura: 4,
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
const ORGANOS: readonly Organo[] = ['hoja', 'fruto', 'tronco'];
const NU_ORGANO: Tasas = { hoja: 25, fruto: 6, tronco: 1 };

// ── Calibración por equivalencia de flujos (ARQ-materia §5.1) ─────────────────────────────────────────────

/** Anclas fisiológicas de las escalas: una persona come 8,4 MJ (2.000 kcal) y bebe 2,5 L al día. */
const J_PERSONA_DIA = 8.4e6, MMOL_AGUA_PERSONA_DIA = 2_500_000 / 18.015;
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
    const f = phaseAt(t), luz = f === 'day' ? 1 : f === 'night' ? 0 : LUZ_CREPSCULO;
    h = Math.min(1, Math.max(0, h + (lluvia ? 0.012 : 0) - 0.0015 - luz * 0.001));
    if (t >= 10 * TICKS_PER_DAY) { s += h; n++; }
  }
  return s / n;
}

/** Tesela de referencia de la equivalencia: pradera a su capacidad, con la humedad media de la ley escalar y fertilidad media. */
export const REFERENCIA = { capacidad: DEFAULT_PARAMS.recursos.capacidadPastizal, humedad: humedadMediaEscalar(), fertilidad: 0.5, madera: 12 };

export interface Tasas { hoja: number; fruto: number; tronco: number }
export interface ParamsMundo {
  escalas: Escalas;
  /** Unidades base por tick a luz 1, agua sin límite y captura completa. */
  crecimiento: Tasas;
  /** Fracción de las unidades que cae al suelo por tick. */
  caida: Tasas;
  /** Cuántas cajas de suelo tiene una tesela: las que guardan SUELO_POR_VEGETACION veces el P de su vegetación. */
  suelo: number;
  /** Conductancia charca–suelo (en cuantos por tick a diferencia de llenado 1): igualan su llenado en un día. */
  gCharca: number;
  /** Ticks en que la superficie renueva el vapor de la capa límite (evaporación y rocío): h / (C_E·U). */
  tauVapor: number;
  /** Ticks en que la atmósfera libre renueva la capa límite con tiempo seco (h / arrastre) y con lluvia (h / convección). */
  tauSeco: number;
  tauLluvia: number;
  /** Ticks en que el viento cruza una página (16 teselas / VIENTO). */
  tauViento: number;
  fisica: Fisica;
  /** De dónde sale cada constante, para el informe. */
  porque: Record<string, string>;
}

/** Captura de luz de un dosel (Beer–Lambert): 1 − e^(−κ·LAI), con LAI = índice foliar de la cobertura × vegetación. */
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
 *   es el de la sombra a la mitad de su equilibrio, d·equilibrio/2 por tick;
 * - caída de la hoja: la hojarasca a capacidad es la pérdida escalar de vegetación a capacidad (0,0001 por paso). El
 *   rebrote escalar de la vegetación (0,4 al día a media capacidad, 17 veces su pérdida a capacidad) no tiene equivalente
 *   en un balance producción − caída: con la captura cóncava, el neto a media capacidad es como mucho la mitad de la
 *   pérdida a capacidad. Igualarlo exigiría que las hojas vivieran horas y la vegetación se doblara de día y se
 *   hundiera de noche; se iguala la pérdida y el informe da los dos rebrotes;
 * - crecimiento: el que deja el equilibrio en la capacidad de referencia con la luz media del día y el agua de la
 *   humedad de referencia.
 */
export function calibrar(q: Pick<ServicioQuimico, 'sustancia'>, S: BaseMundo, fisica: Fisica = FISICA): ParamsMundo {
  const { alturaCapaLimite: h, conductanciaSuperficie, arrastreSeco, conveccionLluvia, viento } = fisica;
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
  // Sombra: dX/dt = G·luz·agua·captura − d·X. A la mitad del equilibrio X* el neto es d·X*·(c(X*/2)/c(X*) − 1/2) para la
  // hoja (su producción depende de sí misma) y d·X*/2 para el fruto y el tronco.
  const cRef = captura(K, fisica), cMedia = captura(K / 2, fisica);
  const caida: Tasas = {
    hoja: 0.0001 / INTERVALO_ECOLOGIA_TICKS / K,
    fruto: rebroteFruto / (TICKS_PER_DAY * K / 2),
    tronco: rebroteTronco / (TICKS_PER_DAY * REFERENCIA.madera / 2),
  };
  const produce = LUZ_MEDIA * Math.min(1, m) * cRef;
  const crecimiento: Tasas = {
    hoja: caida.hoja * K * escalas.vegetacion / produce,
    fruto: caida.fruto * K * escalas.alimento / produce,
    tronco: caida.tronco * REFERENCIA.madera * escalas.madera / produce,
  };
  // P de una tesela de referencia a su capacidad: una unidad de orgP por unidad de hoja y por unidad de fruto.
  const pVegetacion = K * (escalas.vegetacion + escalas.alimento);
  const suelo = SUELO_POR_VEGETACION * pVegetacion / (H3PO4_FERTIL * f);
  return {
    escalas, crecimiento, caida, suelo, fisica,
    gCharca: 1 / (TICKS_PER_DAY * (1 / escalas.agua + 1 / escalas.humedad)),
    tauVapor: h / conductanciaSuperficie / SEGUNDOS_TICK,
    tauSeco: h / arrastreSeco / SEGUNDOS_TICK,
    tauLluvia: h / conveccionLluvia / SEGUNDOS_TICK,
    tauViento: 16 / viento,
    porque: {
      alimento: `${comidaDia.toFixed(3)} u/día de comida ↔ 8,4 MJ; ${energiaOxidacion(q, S, partes('fruto')).toFixed(0)} J por unidad de fruto`,
      agua: `${aguaDia.toFixed(3)} u/día de agua ↔ 2,5 L`,
      humedad: `misma lluvia: +${lluviaHumedad} de humedad ↔ +${lluviaAgua.toFixed(4)} de agua potable`,
      vegetacion: 'la planta de la caja validada (2.000 unidades) es vegetación 0,5',
      madera: '1 unidad = 1 kg de CH₂O', piedra: '1 unidad = 1 kg de SiO₂',
      caida: `rebrote escalar a media capacidad por día: fruto ${rebroteFruto.toFixed(4)}, tronco ${rebroteTronco.toFixed(4)}; vegetación ${rebroteHoja.toFixed(4)} en el escalar y ${(TICKS_PER_DAY * caida.hoja * K * (cMedia / cRef - 0.5)).toFixed(4)} en la sombra (hojas de ${(1 / caida.hoja / TICKS_PER_DAY).toFixed(0)} días)`,
      crecimiento: `equilibrio en la referencia (K ${K}, humedad media escalar ${m.toFixed(3)}, luz media ${LUZ_MEDIA}, captura ${cRef.toFixed(3)})`,
      gCharca: 'charca y suelo igualan su llenado (agua/escala) en un día',
      tauVapor: `h ${h} m / C_E·U ${conductanciaSuperficie} m/s`,
      atmosfera: `capa límite renovada por la atmósfera libre en ${(h / arrastreSeco / SEGUNDOS_TICK).toFixed(0)} ticks con tiempo seco (arrastre ${arrastreSeco} m/s) y ${(h / conveccionLluvia / SEGUNDOS_TICK).toFixed(0)} con lluvia (convección ${conveccionLluvia} m/s); viento ${viento} teselas/tick`,
      suelo: `cajas de suelo por tesela: ${SUELO_POR_VEGETACION}× el P de la vegetación de referencia (${pVegetacion.toFixed(0)}) a fertilidad ${f}`,
    },
  };
}

// ── Plantillas ───────────────────────────────────────────────────────────────────────────────────────────

/** Variante de un órgano: la misma unidad (k unidades base) con otras fuentes de N o de P. */
export interface Variante { p: Plantilla; k: number }
export interface PlantillasMundo { hoja: Variante[]; fruto: Variante[]; tronco: Variante[]; dHMax: Tasas }

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
 * con los ids que da Q para el P que suelta el orgP (sola, con agua en el nivel catalizado, con O₂ en llama). */
export function plantillasMundo(q: ServicioQuimico, S: BaseMundo): PlantillasMundo {
  const conP = (a: SustanciaId, b: SustanciaId, nivel: number) =>
    q.reaccion(a, b, nivel)?.salidas.find((t) => q.sustancia(t.id).atomos[E('P')])?.id ?? 0;
  const nitrogenos = [S.NH3, S.N2];
  const fosfatos = [S.H3PO4, S.CaHPO4, conP(S.orgP, 0, NIVEL_CATALIZADO), conP(S.orgP, S.H2O, NIVEL_CATALIZADO), conP(S.orgP, S.O2, 10)];
  const subproductos = [S.O2, S.CaCO3, S.SiO2, S.Fe2O3];
  const registro = new RegistroLocal();
  const crear = (o: Organo, entradas: SustanciaId[]): Variante | null => {
    const partes = PARTES[o].map(([k, nu]) => ({ id: S[k], nu }));
    const p = crearPlantilla(q, registro, {
      partes, entradas, subproductos: subproductos.filter((id) => !entradas.includes(id)),
      kappa: SIN, captura: 0, masaAdulta: 0, m0: 0, linaje: 0,
    });
    if (!p || entradas.some((id) => !p.sintesis.entradas.some((t) => t.id === id))) return null;
    // crearPlantilla ordena las partes a su manera: k sale de la misma sustancia.
    return { p, k: p.partes.find((t) => t.id === partes[0]!.id)!.nu / partes[0]!.nu };
  };
  const variantes = (o: Organo): Variante[] => {
    const out: Variante[] = [];
    for (const f of fosfatos) for (const n of nitrogenos) {
      if (!f) continue;
      const v = crear(o, [...new Set([S.CO2, S.H2O, n, f])]);
      if (v && !out.some((x) => x.p.id === v.p.id)) out.push(v);
    }
    return out;
  };
  const tronco = crear('tronco', [S.CO2, S.H2O]);
  const pl = { hoja: variantes('hoja'), fruto: variantes('fruto'), tronco: tronco ? [tronco] : [] };
  for (const o of ORGANOS) if (!pl[o].length) throw new Error(`Ninguna plantilla de ${o} balancea.`);
  const dHMax = (o: Organo) => Math.max(...pl[o].map((v) => Math.max(0, v.p.sintesis.dH) / v.k));
  return { ...pl, dHMax: { hoja: dHMax('hoja'), fruto: dHMax('fruto'), tronco: dHMax('tronco') } };
}

export function organosDe(S: BaseMundo): Organos {
  const marcas = [S.madera, S.CH2, S.proteina] as const;
  const fila = (o: Organo) => marcas.map((id) => PARTES[o].find(([k]) => S[k] === id)?.[1] ?? 0) as unknown as [number, number, number];
  return { marcas, hoja: fila('hoja'), fruto: fila('fruto'), tronco: fila('tronco') };
}

/**
 * Intercambio de `id` entre `l` y `aire` con flujos brutos en los dos sentidos (decisión del «suelo discreto» del H₂,
 * materia.cierre2): cada cuanto de un lado pasa al otro con la probabilidad de la relajación de `fluir` en dt (la misma
 * media), así que dos H₂ del aire pueden coincidir en el poro aunque el equilibrio discreto deje menos de uno de
 * diferencia. Devuelve el neto de `l` al aire.
 */
export function intercambioBruto(c: CtxPaso, l: LoteRef, aire: LoteRef, id: SustanciaId, g: number, capL: number, capA: number, dt: number): number {
  const f = -Math.expm1(-g * dt * (1 / capL + 1 / capA)), pL = f * capA / (capL + capA), pA = f * capL / (capL + capA);
  const neto = binomial(c.arena.cuantos(l, id), pL, c.azar) - binomial(c.arena.cuantos(aire, id), pA, c.azar);
  if (neto > 0) return c.arena.moverParte(l, aire, { parte: Parte.Exacta, esp: id, cuantos: neto, kappa: null });
  if (neto < 0) return -c.arena.moverParte(aire, l, { parte: Parte.Exacta, esp: id, cuantos: -neto, kappa: null });
  return 0;
}

// ── Estado compartido ────────────────────────────────────────────────────────────────────────────────────

/** Contabilidad por hilo: sol, radiación que entra y que sale, ignición (J), tejido caído al suelo (cuantos), agua que
 * entra de la atmósfera libre, que sale a ella y que se va por el desagüe (cuantos de H₂O) y la energía neta de esos
 * intercambios con el exterior (J, con signo: la del H₂O y su calor). */
const SOL = 0, RAD_ENTRA = 1, RAD_SALE = 2, IGNICION = 3, CAIDA = 4, CIELO_ENTRA = 5, CIELO_SALE = 6, DESAGUE = 7, EXTERIOR_J = 8,
  CUENTAS = 9;
const LIBRO = 3 * (NE + 1);

export interface DescriptorMundo {
  n: number; np: number; hilos: number;
  lotes: ArenaCompartida; desborde: ArenaCompartida; paginas: ArenaCompartida;
  /** Por tesela (ordenadas por página): suelo, agua, vida, latente, celda; por página: inicio, aire, dueño, azar, dT, sus
   * cuatro vecinas (x−1, x+1, y−1, y+1; −1 si no hay) y el vapor en vuelo hacia cada una (cuantos y calor). */
  sab: Record<'suelo' | 'agua' | 'vida' | 'latente' | 'celda' | 'x' | 'y' | 'inicio' | 'aire' | 'dueno' | 'azar' | 'dT' | 'vecinas'
    | 'transito' | 'libros', SharedArrayBuffer>;
  sustancias: Uint8Array;
  base: BaseMundo; plantillas: PlantillasMundo; params: ParamsMundo;
}

export interface Forzamiento { dt: number; luz: number; lluvia: boolean }

const MAX_LOTES = 1 << 23, MAX_DESBORDE = 1 << 25, MAX_PAGINAS = 1 << 20;
const sab = (bytes: number) => new SharedArrayBuffer(Math.max(8, bytes));

/** Entero con esperanza x (⌊x⌋ más un uniforme). */
const entero = (x: number, azar: () => number) => {
  const piso = Math.floor(x);
  return piso + (azar() < x - piso ? 1 : 0);
};

export class MundoMaterial {
  readonly arena: ArenaLotes;
  readonly libro: Libro;
  readonly cuentas: Float64Array;
  readonly n: number;
  readonly np: number;
  readonly suelo: Float64Array;
  readonly agua: Float64Array;
  readonly vida: Float64Array;
  readonly latente: Float64Array;
  readonly celda: Int32Array;
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly inicio: Int32Array;
  readonly aire: Float64Array;
  readonly dueno: Int16Array;
  readonly dT: Float64Array;
  readonly vecinas: Int32Array;
  readonly transito: Float64Array;
  readonly S: BaseMundo;
  readonly plantillas: PlantillasMundo;
  readonly params: ParamsMundo;
  readonly organos: Organos;
  readonly ctx: CtxPaso;
  private readonly estadoAzar: Uint32Array;
  private readonly libros: Float64Array;
  private readonly memorias: { lotes: PageArena; desborde: PageArena; paginas: PageArena };
  private readonly gas = new Map<number, boolean>();
  private readonly vistos = new Set<number>();
  private ids = new Uint32Array(64);
  private semilla = 0;
  private readonly u: Unidades = unidadesVacias();
  /** Masa molar media de la columna de aire (kg/mol), para su altura de escala. */
  private readonly masaAire: number;
  private readonly eH2O: number;

  constructor(readonly d: DescriptorMundo, readonly quimica: ServicioQuimico, readonly hilo: number,
    memorias?: { lotes: PageArena; desborde: PageArena; paginas: PageArena }) {
    this.n = d.n; this.np = d.np; this.S = d.base; this.plantillas = d.plantillas; this.params = d.params;
    this.organos = organosDe(d.base);
    this.memorias = memorias ?? {
      lotes: PageArena.conectar(d.lotes), desborde: PageArena.conectar(d.desborde), paginas: PageArena.conectar(d.paginas),
    };
    this.suelo = new Float64Array(d.sab.suelo); this.agua = new Float64Array(d.sab.agua); this.vida = new Float64Array(d.sab.vida);
    this.latente = new Float64Array(d.sab.latente); this.celda = new Int32Array(d.sab.celda);
    this.x = new Int32Array(d.sab.x); this.y = new Int32Array(d.sab.y);
    this.inicio = new Int32Array(d.sab.inicio); this.aire = new Float64Array(d.sab.aire); this.dueno = new Int16Array(d.sab.dueno);
    this.estadoAzar = new Uint32Array(d.sab.azar); this.dT = new Float64Array(d.sab.dT);
    this.libros = new Float64Array(d.sab.libros);
    this.vecinas = new Int32Array(d.sab.vecinas); this.transito = new Float64Array(d.sab.transito);
    const S0 = d.base, col = AIRE_COLUMNA.N2 + AIRE_COLUMNA.O2 + AIRE_COLUMNA.CO2;
    this.masaAire = (AIRE_COLUMNA.N2 * quimica.sustancia(S0.N2).masa + AIRE_COLUMNA.O2 * quimica.sustancia(S0.O2).masa
      + AIRE_COLUMNA.CO2 * quimica.sustancia(S0.CO2).masa) / col / 1000;
    this.eH2O = quimica.sustancia(S0.H2O).energia;
    const base = hilo * (LIBRO + CUENTAS);
    this.libro = {
      fuentes: this.libros.subarray(base, base + NE + 1), sumideros: this.libros.subarray(base + NE + 1, base + 2 * (NE + 1)),
      enVuelo: this.libros.subarray(base + 2 * (NE + 1), base + LIBRO),
    };
    this.cuentas = this.libros.subarray(base + LIBRO, base + LIBRO + CUENTAS);
    const q = quimica, O2 = d.base.O2;
    this.arena = new ArenaLotes({
      ...this.memorias, hilo, quimica: q, agua: d.base.H2O,
      terreno: { chunkDe: (c: number) => c >> 8, duenoChunk: this.dueno },
      // Pedido de la química: lo digerible con [KAPPA0 ×4] a la T del cuerpo, solo exotérmicas (`barreraEfectiva`);
      // la fracción es la que se oxida en un día de tránsito.
      digerible: (s: Readonly<Sustancia>, kappa: Kappa) => {
        const r = q.reaccion(s.id, O2, nivelDeLote(T_CUERPO, kappa));
        if (!r || r.dH >= 0) return 0;
        const nu = r.entradas.find((t) => t.id === s.id)?.nu ?? 1;
        return (-r.dH / nu) * -Math.expm1(-NU * Math.exp(-barreraEfectiva(r, kappa) / (R * T_CUERPO)) * TICKS_PER_DAY);
      },
    });
    const self = this;
    this.ctx = {
      arena: this.arena, quimica: q,
      azar(): number { // mulberry32 con el estado de la página en curso
        let a = self.semilla = (self.semilla + 0x6d2b79f5) >>> 0;
        a = Math.imul(a ^ (a >>> 15), a | 1);
        a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
        return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
      },
    };
  }

  /** El mismo mundo visto desde otro hilo (un worker): su arena, su libro y su química cargada del registro. */
  static conectar(d: DescriptorMundo, hilo: number): MundoMaterial {
    return new MundoMaterial(d, cargarSustancias(d.sustancias, { modo: 'inmediato' }), hilo);
  }

  /**
   * Levanta la sombra material de `tiles` (de un mundo ya creado) con la química `q`. Las teselas se agrupan en páginas
   * de 16 × 16 por sus coordenadas; la página p es del hilo p % hilos. `luz` fija la temperatura inicial; `fisica` cambia
   * parámetros físicos (para los barridos del laboratorio).
   */
  static levantar(tiles: readonly Tile[], q: ServicioQuimicoImpl,
    op: { hilos?: number; semilla?: number; luz?: number; fisica?: Partial<Fisica> } = {}): MundoMaterial {
    const hilos = op.hilos ?? 1, semilla = op.semilla ?? 1;
    const S = sustanciasMundo(q);
    const plantillas = plantillasMundo(q, S), params = calibrar(q, S, { ...FISICA, ...op.fisica });
    const clave = (t: Tile) => Math.floor(t.y / 16) * 0x10000 + Math.floor(t.x / 16);
    const local = (t: Tile) => (((t.y % 16) + 16) % 16) * 16 + (((t.x % 16) + 16) % 16);
    const orden = [...tiles].sort((a, b) => clave(a) - clave(b) || local(a) - local(b));
    const paginas = [...new Set(orden.map(clave))];
    const n = orden.length, np = paginas.length;
    const memorias = { lotes: new PageArena(MAX_LOTES), desborde: new PageArena(MAX_DESBORDE), paginas: new PageArena(MAX_PAGINAS) };
    const d: DescriptorMundo = {
      n, np, hilos,
      lotes: undefined as never, desborde: undefined as never, paginas: undefined as never,
      sab: {
        suelo: sab(8 * n), agua: sab(8 * n), vida: sab(8 * n), latente: sab(8 * n), celda: sab(4 * n), x: sab(4 * n), y: sab(4 * n),
        inicio: sab(4 * (np + 1)), aire: sab(8 * np), dueno: sab(2 * np), azar: sab(4 * np), dT: sab(8 * np),
        vecinas: sab(4 * 4 * np), transito: sab(8 * 2 * 4 * np),
        libros: sab(8 * hilos * (LIBRO + CUENTAS)),
      },
      sustancias: new Uint8Array(0), base: S, plantillas, params,
    };
    const m = new MundoMaterial(d, q, 0, memorias);
    d.lotes = memorias.lotes.compartir(); d.desborde = memorias.desborde.compartir(); d.paginas = memorias.paginas.compartir();
    memorias.paginas.prepararF0(np);
    memorias.lotes.prepararF0(3 * n + np + 256 * hilos, LOTES_POR_BLOQUE);
    memorias.desborde.prepararF0(8 * n);
    const pagDe = new Map(paginas.map((k, p) => [k, p]));
    for (let i = 0, p = -1; i < n; i++) {
      const t = orden[i]!, pi = pagDe.get(clave(t))!;
      while (p < pi) m.inicio[++p] = i;
      m.celda[i] = pi * 256 + local(t); m.x[i] = t.x; m.y[i] = t.y;
    }
    m.inicio[np] = n;
    for (let p = 0; p < np; p++) {
      const k = paginas[p]!;
      [k - 1, k + 1, k - 0x10000, k + 0x10000].forEach((v, dir) => { m.vecinas[4 * p + dir] = pagDe.get(v) ?? -1; });
    }
    for (let p = 0; p < np; p++) m.estadoAzar[p] = (Math.imul(semilla >>> 0, 0x9e3779b1) ^ Math.imul(p + 1, 0x85ebca6b)) >>> 0;
    const { escalas: e } = params, T0 = (p: number) => m.temperatura(p, op.luz ?? 1);
    const atomos = (id: SustanciaId) => q.sustancia(id).atomos.reduce((s, v) => s + v, 0);
    const llenar = (l: LoteRef, cont: readonly (readonly [SustanciaId, number])[], T: number) => {
      const pares: number[] = [];
      let at = 0;
      for (const [id, c] of cont) if (c > 0) { pares.push(id, c); at += c * atomos(id); }
      const calor = Math.round(T * CAPACIDAD_ATOMO * at);
      if (calor > 0) pares.push(0, calor);
      if (pares.length) m.arena.fuente(l, Float64Array.from(pares), m.libro);
    };
    const poro = CAP_SUELO / CAP_AIRE_TESELA, cajas = params.suelo;
    for (let p = 0; p < np; p++) {
      const T = T0(p), nT = m.inicio[p + 1]! - m.inicio[p]!;
      let humedad = 0;
      for (let i = m.inicio[p]!; i < m.inicio[p + 1]!; i++) {
        const t = orden[i]!, c = m.celda[i]!, fert = t.fertility ?? 0.5;
        m.suelo[i] = m.arena.nuevo(Rol.Suelo, c, 0);
        llenar(m.suelo[i]!, [
          [S.SiO2, Math.round(SUELO_MINERAL.SiO2 * cajas)], [S.CaCO3, Math.round(SUELO_MINERAL.CaCO3 * cajas)],
          [S.NH3, Math.round(NH3_FERTIL * fert * cajas)], [S.H3PO4, Math.round(H3PO4_FERTIL * fert * cajas)],
          [S.H2O, Math.round(t.moisture * e.humedad)],
          [S.N2, Math.round(AIRE_COLUMNA.N2 * poro)], [S.O2, Math.round(AIRE_COLUMNA.O2 * poro)], [S.CO2, Math.round(AIRE_COLUMNA.CO2 * poro)],
        ], T);
        humedad += Math.min(1, t.moisture);
        // Un vaso (charca, manantial, humedal) tiene su lote de agua aunque hoy esté seco: la lluvia y la escorrentía lo llenan.
        const potable = Math.round((t.drinkingWater ?? 0) * e.agua);
        const vaso = t.terrain !== 'water' && (potable > 0 || t.feature === 'pool' || t.feature === 'spring' || t.biome === 'wetland');
        m.agua[i] = vaso ? m.arena.nuevo(Rol.Agua, c, 0) : -1;
        if (potable > 0) llenar(m.agua[i]!, [[S.H2O, potable]], T);
        m.vida[i] = m.arena.nuevo(Rol.Vida, c, 0);
        const u = { hoja: Math.round(t.vegetation * e.vegetacion), fruto: Math.round(t.food * e.alimento), tronco: Math.round((t.wood ?? 0) * e.madera) };
        const tejido = new Map<SustanciaId, number>();
        for (const o of ORGANOS) for (const [k, nu] of PARTES[o]) tejido.set(S[k], (tejido.get(S[k]) ?? 0) + u[o] * nu);
        llenar(m.vida[i]!, [...tejido], T);
        m.latente[i] = Math.round((t.stone ?? 0) * e.piedra);
      }
      // Aire de la página: la columna de cada tesela, con el vapor a la humedad relativa media de sus suelos.
      m.aire[p] = m.arena.nuevo(Rol.Aire, p * 256, 0);
      const gases = (AIRE_COLUMNA.N2 + AIRE_COLUMNA.O2 + AIRE_COLUMNA.CO2) * nT;
      llenar(m.aire[p]!, [
        [S.N2, AIRE_COLUMNA.N2 * nT], [S.O2, AIRE_COLUMNA.O2 * nT], [S.CO2, AIRE_COLUMNA.CO2 * nT],
        [S.H2O, Math.round((humedad / nT) * m.vaporSaturado(gases, T))],
      ], T);
    }
    for (let p = 0; p < np; p++) m.dueno[p] = p % hilos;
    d.sustancias = serializarSustancias(q);
    return m;
  }

  // ── Forzamiento y utilidades ──

  temperatura(p: number, luz: number): number { return T_NOCHE + (T_DIA - T_NOCHE) * luz + this.dT[p]!; }

  /** Fracción de la columna de aire que es capa límite a T: h / H, con H = R·T/(M·g). */
  capaLimite(T: number): number { return this.params.fisica.alturaCapaLimite * this.masaAire * GRAVEDAD / (R_MOL * T); }

  /** Cuantos de vapor que satura la capa límite de un aire con `gases` cuantos de otros gases, con la capa a T y el
   * vapor saturado a `tVapor` (Raoult–Dalton). */
  vaporSaturado(gases: number, T: number, tVapor = T): number {
    const tEb = this.quimica.sustancia(this.S.H2O).prop.tEbullicion;
    const x = Math.min(0.99, Math.exp(-TROUTON * (tEb / tVapor - 1)));
    return this.capaLimite(T) * gases * x / (1 - x);
  }

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

  lotesTesela(i: number): LotesTesela {
    return { suelo: this.suelo[i]!, agua: this.agua[i]!, vida: this.vida[i]!, latente: this.latente[i]! };
  }

  vista(i: number, out: VistaTesela): VistaTesela {
    return vistaTesela((l, id) => this.arena.cuantos(l, id), this.lotesTesela(i), this.S.H2O, this.params.escalas, this.organos, out, this.u);
  }

  unidades(i: number, out: Unidades): Unidades { return unidadesVida((l, id) => this.arena.cuantos(l, id), this.vida[i]!, this.organos, out); }

  paginasPropias(): number[] {
    const out: number[] = [];
    for (let p = 0; p < this.np; p++) if (this.dueno[p] === this.hilo) out.push(p);
    return out;
  }

  /** Lo que el coordinador hace en F0 antes de un paso: reservas para lo que los hilos puedan crear. */
  prepararPaso(): void {
    this.memorias.lotes.prepararF0(256 * this.d.hilos, LOTES_POR_BLOQUE);
    this.memorias.desborde.prepararF0(4096 + 8 * this.n);
  }

  // ── Paso ──

  /** Un paso entero con un solo hilo: las dos fases seguidas. Con varios, cada hilo hace `pasarLocal` y, cuando todos han
   * terminado, `recibir`. */
  pasar(f: Forzamiento): void {
    if (this.d.hilos !== 1) throw new Error('Con varios hilos, pasarLocal en todos y después recibir en todos.');
    this.pasarLocal(f); this.recibir();
  }

  /** Fase local de todas las páginas de este hilo. */
  pasarLocal(f: Forzamiento): void {
    this.arena.barrera();
    for (let p = 0; p < this.np; p++) if (this.dueno[p] === this.hilo) this.pasarPagina(p, f);
  }

  /** Segunda fase: cada página de este hilo abona el vapor que le mandaron sus vecinas. */
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

  pasarPagina(p: number, f: Forzamiento): void {
    const { dt } = f, a = this.aire[p]!, i0 = this.inicio[p]!, i1 = this.inicio[p + 1]!;
    const T = this.temperatura(p, f.luz), Taire = f.lluvia ? T - DT_LLUVIA : T;
    this.semilla = this.estadoAzar[p]!;
    const c = this.ctx;
    for (let i = i0; i < i1; i++) { this.crecer(i, a, f); this.caer(i, dt); }
    for (let i = i0; i < i1; i++) {
      pasoLote(c, this.suelo[i]!, dt, K_SUELO);
      if (this.agua[i]! >= 0) pasoLote(c, this.agua[i]!, dt, SIN);
    }
    pasoLote(c, a, dt, SIN);
    const capAire = CAP_AIRE_TESELA * (i1 - i0);
    for (let i = i0; i < i1; i++) {
      this.intercambiar(this.suelo[i]!, a, G_SUELO, CAP_SUELO, capAire, dt, T);
      if (this.agua[i]! >= 0) fluir(c, this.agua[i]!, this.suelo[i]!, this.S.H2O, this.params.gCharca, this.params.escalas.agua, this.params.escalas.humedad, 0, dt);
    }
    this.vapor(p, dt, Taire);
    this.cielo(p, f, T, Taire);
    this.llover(p, Taire);
    this.escurrir(p);
    this.enviar(p, dt);
    this.posar(p, Taire);
    for (let i = i0; i < i1; i++) {
      this.termostato(this.suelo[i]!, T); this.termostato(this.vida[i]!, T);
      if (this.agua[i]! >= 0) this.termostato(this.agua[i]!, T);
    }
    this.termostato(a, Taire);
    this.estadoAzar[p] = this.semilla;
  }

  /** Sol y síntesis: cada órgano produce G·luz·agua·captura·dt unidades base, limitado por lo que haya (Liebig, `copiar`).
   * El tronco solo crece donde ya hay tronco. El sol entra como calor en la Vida (fuente declarada) y lo que la síntesis no
   * usa lo devuelve el termostato (radiación). */
  private crecer(i: number, aire: LoteRef, f: Forzamiento): void {
    if (!(f.luz > 0)) return;
    const vida = this.vida[i]!, suelo = this.suelo[i]!, agua = this.agua[i]!, e = this.params.escalas, G = this.params.crecimiento;
    const u = this.unidades(i, this.u);
    if (u.hoja === 0) return;
    const humedad = this.arena.cuantos(suelo, this.S.H2O) / e.humedad;
    const base = f.luz * Math.min(1, this.charcaConAgua(i) ? 1 : humedad) * captura(u.hoja / e.vegetacion, this.params.fisica) * f.dt;
    const z = this.ctx.azar;
    const pide: Tasas = { hoja: entero(G.hoja * base, z), fruto: entero(G.fruto * base, z), tronco: u.tronco > 0 ? entero(G.tronco * base, z) : 0 };
    let sol = 0;
    for (const o of ORGANOS) sol += pide[o] * this.plantillas.dHMax[o];
    sol = Math.ceil(sol);
    if (sol <= 0) return;
    this.arena.fuente(vida, Float64Array.of(0, sol), this.libro);
    this.cuentas[SOL]! += sol;
    const fuentes = agua >= 0 ? [suelo, agua, aire] : [suelo, aire];
    for (const o of ORGANOS) {
      let resta = pide[o];
      for (const v of this.plantillas[o]) {
        const max = Math.floor(resta / v.k);
        if (max <= 0) break;
        resta -= v.k * copiar(this.arena, this.quimica, v.p, vida, fuentes, aire, max * Math.max(0, v.p.sintesis.dH), max);
      }
    }
  }

  /** Caída al suelo (hojarasca, frutos, troncos muertos): binomial de las unidades de cada órgano, por unidades enteras. */
  private caer(i: number, dt: number): void {
    const u = this.unidades(i, this.u), vida = this.vida[i]!, suelo = this.suelo[i]!, d = this.params.caida;
    for (const o of ORGANOS) {
      const k = binomial(u[o], -Math.expm1(-d[o] * dt), this.ctx.azar);
      if (k > 0) { this.moverUnidades(vida, suelo, o, k); this.cuentas[CAIDA]! += k * NU_ORGANO[o]; }
    }
  }

  private moverUnidades(de: LoteRef, a: LoteRef, o: Organo, k: number): void {
    for (const [s, nu] of PARTES[o]) this.arena.moverParte(de, a, { parte: Parte.Exacta, esp: this.S[s], cuantos: k * nu, kappa: null });
  }

  /** Intercambio de gases suelo–aire (`intercambioBruto` por cada gas presente en cualquiera de los dos). */
  private intercambiar(l: LoteRef, aire: LoteRef, g: number, capL: number, capA: number, dt: number, T: number): void {
    const vistos = this.vistos;
    vistos.clear();
    for (const lote of [l, aire]) for (const id of this.especies(lote)) {
      if (vistos.has(id) || id === this.S.H2O || !this.esGas(id, T)) continue;
      vistos.add(id);
      intercambioBruto(this.ctx, l, aire, id, g, capL, capA, dt);
    }
  }

  /**
   * Evaporación y condensación (Dalton): cada tesela intercambia con su columna de aire r·(a·s − v), con s y v el vapor
   * saturado y el que hay por columna, a la actividad del agua de su superficie (1 en una charca, la humedad en el suelo,
   * hasta 1) y r = 1 − e^(−dt/τ). Con el aire más frío (noche, lluvia) s baja y el vapor vuelve como rocío o lluvia.
   */
  private vapor(p: number, dt: number, T: number): void {
    const a = this.aire[p]!, H2O = this.S.H2O, i0 = this.inicio[p]!, i1 = this.inicio[p + 1]!, nT = i1 - i0;
    const sCol = this.vaporSaturado(this.gasesSecos(a, T), T) / nT, vCol = this.arena.cuantos(a, H2O) / nT;
    const r = -Math.expm1(-dt / this.params.tauVapor), hum = this.params.escalas.humedad;
    for (let i = i0; i < i1; i++) {
      const abierta = this.charcaConAgua(i), sup = abierta ? this.agua[i]! : this.suelo[i]!;
      const actividad = abierta ? 1 : Math.min(1, this.arena.cuantos(sup, H2O) / hum);
      const x = r * (actividad * sCol - vCol), k = entero(Math.abs(x), this.ctx.azar);
      if (k === 0) continue;
      if (x > 0) this.arena.moverParte(sup, a, { parte: Parte.Exacta, esp: H2O, cuantos: k, kappa: null });
      else this.arena.moverParte(a, sup, { parte: Parte.Exacta, esp: H2O, cuantos: k, kappa: null });
    }
  }

  private gasesSecos(a: LoteRef, T: number): number {
    let gases = 0;
    for (const id of this.especies(a)) if (id !== this.S.H2O && this.esGas(id, T)) gases += this.arena.cuantos(a, id);
    return gases;
  }

  /** Agua que entra (k > 0) o sale (k < 0) del lote `l` hacia el exterior `cuenta`, a la T del lote, con su energía. */
  private exterior(l: LoteRef, k: number, T: number, cuenta: number): void {
    const H2O = this.S.H2O;
    if (k > 0) {
      const calor = Math.round(T * CAPACIDAD_ATOMO * 3 * k);
      this.arena.fuente(l, Float64Array.of(H2O, k, 0, calor), this.libro);
      this.cuentas[cuenta]! += k; this.cuentas[EXTERIOR_J]! += k * this.eH2O + calor;
    } else if (k < 0) {
      const sale = this.arena.sumidero(l, Float64Array.of(H2O, -k, 0, Math.round(T * CAPACIDAD_ATOMO * 3 * -k)), this.libro);
      let n = 0, j = 0;
      for (let x = 0; x < sale.length; x += 2) if (sale[x] === H2O) n += sale[x + 1]!; else if (sale[x] === 0) j += sale[x + 1]!;
      this.cuentas[cuenta]! += n; this.cuentas[EXTERIOR_J]! -= n * this.eH2O + j;
    }
  }

  /**
   * La atmósfera libre renueva la capa límite de la página con r = 1 − e^(−dt/τ): sale r·v y entra r·v_libre, el vapor del
   * aire que llega. Con tiempo seco τ es el del arrastre y ese aire trae el punto de rocío de la noche; con lluvia τ es el
   * de la convección y el aire llega saturado a la T del día (T) a una columna DT_LLUVIA más fría (Taire).
   */
  private cielo(p: number, f: Forzamiento, T: number, Taire: number): void {
    const a = this.aire[p]!, gases = this.gasesSecos(a, Taire), z = this.ctx.azar;
    const tLibre = f.lluvia ? T : Math.min(T, T_NOCHE + this.dT[p]!);
    const r = -Math.expm1(-f.dt / (f.lluvia ? this.params.tauLluvia : this.params.tauSeco));
    const neto = entero(r * this.vaporSaturado(gases, Taire, tLibre), z) - binomial(this.arena.cuantos(a, this.S.H2O), r, z);
    this.exterior(a, neto, Taire, neto > 0 ? CIELO_ENTRA : CIELO_SALE);
  }

  /** Lo que el aire de la página tiene por encima de la saturación llueve, repartido por igual entre sus teselas: en la
   * charca si la hay, si no en el suelo. */
  private llover(p: number, T: number): void {
    const a = this.aire[p]!, H2O = this.S.H2O, i0 = this.inicio[p]!, nT = this.inicio[p + 1]! - i0;
    const exceso = this.arena.cuantos(a, H2O) - Math.floor(this.vaporSaturado(this.gasesSecos(a, T), T));
    if (exceso <= 0) return;
    const cada = Math.floor(exceso / nT), resto = exceso - cada * nT, primero = Math.floor(this.ctx.azar() * nT);
    for (let j = 0; j < nT; j++) {
      const i = i0 + j, k = cada + ((j - primero + nT) % nT < resto ? 1 : 0);
      if (k > 0) this.arena.moverParte(a, this.agua[i]! >= 0 ? this.agua[i]! : this.suelo[i]!, { parte: Parte.Exacta, esp: H2O, cuantos: k, kappa: null });
    }
  }

  /**
   * Escorrentía: el agua de un suelo por encima de su capacidad de campo (humedad 1) corre a las charcas de la página que
   * no están llenas (agua potable 1 es el vaso lleno), por orden de tesela; lo que no cabe, y lo que rebosa de una charca,
   * se va por el desagüe (fuera del mundo, declarado).
   */
  private escurrir(p: number): void {
    const H2O = this.S.H2O, A = this.arena, e = this.params.escalas, i0 = this.inicio[p]!, i1 = this.inicio[p + 1]!;
    let j = i0;
    const hueco = (i: number) => this.agua[i]! >= 0 ? e.agua - A.cuantos(this.agua[i]!, H2O) : 0;
    for (let i = i0; i < i1; i++) {
      const suelo = this.suelo[i]!;
      let sobra = A.cuantos(suelo, H2O) - e.humedad;
      while (sobra > 0 && j < i1) {
        const k = Math.min(sobra, hueco(j));
        if (k > 0) { A.moverParte(suelo, this.agua[j]!, { parte: Parte.Exacta, esp: H2O, cuantos: k, kappa: null }); sobra -= k; }
        if (hueco(j) <= 0) j++;
      }
      if (sobra > 0) this.exterior(suelo, -sobra, this.temperaturaLote(suelo), DESAGUE);
    }
    for (let i = i0; i < i1; i++) if (this.agua[i]! >= 0 && hueco(i) < 0) this.exterior(this.agua[i]!, hueco(i), this.temperaturaLote(this.agua[i]!), DESAGUE);
  }

  /** El viento lleva a cada página vecina una fracción del vapor (flujos brutos, a concentración por tesela), que queda en
   * vuelo hasta que la vecina la abona en `recibir`. */
  private enviar(p: number, dt: number): void {
    const a = this.aire[p]!, H2O = this.S.H2O, nT = this.inicio[p + 1]! - this.inicio[p]!;
    const phi = -Math.expm1(-dt / this.params.tauViento) / 8;
    let v = this.arena.cuantos(a, H2O);
    for (let dir = 0; dir < 4; dir++) {
      const q = this.vecinas[4 * p + dir]!;
      if (q < 0) continue;
      const nQ = this.inicio[q + 1]! - this.inicio[q]!, k = binomial(v, phi * Math.min(nT, nQ) / nT, this.ctx.azar);
      if (k <= 0) continue;
      const g = this.arena.garantizar(a, { parte: Parte.Exacta, esp: H2O, cuantos: k, kappa: null }, this.libro);
      let n = 0, calor = 0;
      for (let x = 0; x < g.length; x += 2) if (g[x] === H2O) n += g[x + 1]!; else if (g[x] === 0) calor += g[x + 1]!;
      this.transito[2 * (4 * p + dir)] = n; this.transito[2 * (4 * p + dir) + 1] = calor;
      v -= n;
    }
  }

  private charcaConAgua(i: number): boolean { return this.agua[i]! >= 0 && this.arena.cuantos(this.agua[i]!, this.S.H2O) > 0; }

  private temperaturaLote(l: LoteRef): number { return this.arena.calor(l) / (CAPACIDAD_ATOMO * medir(this.ctx, l).atomos); }

  /** Lo que no es gas en el aire (salvo el vapor) se posa en el suelo de la primera tesela de la página. */
  private posar(p: number, T: number): void {
    const a = this.aire[p]!, suelo = this.suelo[this.inicio[p]!]!;
    for (const id of [...this.especies(a)]) if (id !== this.S.H2O && !this.esGas(id, T)) {
      this.arena.moverParte(a, suelo, { parte: Parte.Exacta, esp: id, cuantos: this.arena.cuantos(a, id), kappa: null });
    }
  }

  /** Radiación: lleva el lote a T con calor declarado (fuente si le falta, sumidero si le sobra). */
  termostato(l: LoteRef, T: number, cuenta = -1): void {
    const d = Math.round(T * CAPACIDAD_ATOMO * medir(this.ctx, l).atomos) - this.arena.calor(l);
    if (d > 0) { this.arena.fuente(l, Float64Array.of(0, d), this.libro); this.cuentas[cuenta >= 0 ? cuenta : RAD_ENTRA]! += d; }
    else if (d < 0) { this.arena.sumidero(l, Float64Array.of(0, -d), this.libro); this.cuentas[RAD_SALE]! -= d; }
  }

  // ── Actos (para el laboratorio y la etapa siguiente) ──

  /** Saca `k` unidades del órgano `o` de la tesela i (comer, recolectar) hacia el sumidero declarado. Devuelve las sacadas. */
  extraer(i: number, o: Organo, k: number): number {
    k = Math.min(k, this.unidades(i, this.u)[o]);
    if (k <= 0) return 0;
    const pares: number[] = [];
    for (const [s, nu] of PARTES[o]) pares.push(this.S[s], k * nu);
    const T = this.temperaturaLote(this.vida[i]!);
    let at = 0;
    for (const [s, nu] of PARTES[o]) at += k * nu * this.quimica.sustancia(this.S[s]).atomos.reduce((x, v) => x + v, 0);
    pares.push(0, Math.round(T * CAPACIDAD_ATOMO * at));
    this.arena.sumidero(this.vida[i]!, Float64Array.from(pares), this.libro);
    return k;
  }

  /** Saca `cuantos` de agua de la charca (o del suelo si no hay) de la tesela i hacia el sumidero declarado (beber). */
  beber(i: number, cuantos: number): number {
    const l = this.agua[i]! >= 0 ? this.agua[i]! : this.suelo[i]!;
    const k = Math.min(cuantos, this.arena.cuantos(l, this.S.H2O));
    if (k <= 0) return 0;
    const T = this.temperaturaLote(l);
    this.arena.sumidero(l, Float64Array.of(this.S.H2O, k, 0, Math.round(T * CAPACIDAD_ATOMO * 3 * k)), this.libro);
    return k;
  }

  /**
   * Quema la fracción `fraccion` de cada órgano de la tesela i (como la caja): lo quemado va a un lote de fuego con dos
   * veces el O₂ estequiométrico del aire (y su N₂), arde 60 ticks desde 1.100 K (la ignición es calor declarado) y luego
   * los gases vuelven al aire y lo demás, con el calor, al suelo. Devuelve las unidades quemadas.
   */
  quemar(i: number, fraccion: number, p = this.paginaDe(i)): number {
    const u = { ...this.unidades(i, this.u) }, vida = this.vida[i]!, suelo = this.suelo[i]!, aire = this.aire[p]!;
    const fuego = this.arena.nuevo(Rol.Objeto, -1, 0);
    let quemadas = 0;
    for (const o of ORGANOS) {
      const k = Math.round(u[o] * fraccion);
      if (k > 0) { this.moverUnidades(vida, fuego, o, k); quemadas += k; }
    }
    let o2 = 0;
    for (const id of this.especies(fuego)) {
      const at = this.quimica.sustancia(id).atomos;
      o2 += this.arena.cuantos(fuego, id) * (at[E('C')]! + at[E('H')]! / 4 - at[E('O')]! / 2 + 1.25 * at[E('P')]!);
    }
    const pedido = Math.ceil(O2_FUEGO * Math.max(0, o2));
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

  /** Suma en bigint los libros de todos los hilos (fuentes − sumideros − en vuelo) y la contabilidad, y los deja a cero. */
  plegar(totales: { esperado: bigint[]; cuentas: bigint[] }): void {
    for (let h = 0; h < this.d.hilos; h++) {
      const b = h * (LIBRO + CUENTAS);
      for (let k = 0; k <= NE; k++) {
        totales.esperado[k]! += BigInt(this.libros[b + k]!) - BigInt(this.libros[b + NE + 1 + k]!) - BigInt(this.libros[b + 2 * (NE + 1) + k]!);
        this.libros[b + k] = 0; this.libros[b + NE + 1 + k] = 0; this.libros[b + 2 * (NE + 1) + k] = 0;
      }
      for (let k = 0; k < CUENTAS; k++) { totales.cuentas[k]! += BigInt(this.libros[b + LIBRO + k]!); this.libros[b + LIBRO + k] = 0; }
    }
  }

  /** Σ de todos los lotes vivos: átomos por elemento y energía (química + calor), en bigint. */
  saldo(): bigint[] { return this.arena.saldo(); }

  /** Cuantos por sustancia en todo el mundo (para los ciclos). */
  inventario(): Map<SustanciaId, number> {
    const t = new Map<SustanciaId, number>();
    for (const x of this.arena.muestras()) for (let k = 0; k < x.pares.length; k += 2) {
      const id = x.pares[k]!;
      if (id) t.set(id, (t.get(id) ?? 0) + x.pares[k + 1]!);
    }
    return t;
  }

  /** Bytes de la memoria material (lotes, desborde y páginas). */
  bytes(): number { return this.memorias.lotes.bytes + this.memorias.desborde.bytes + this.memorias.paginas.bytes; }
}

export const CUENTA = { SOL, RAD_ENTRA, RAD_SALE, IGNICION, CAIDA, CIELO_ENTRA, CIELO_SALE, DESAGUE, EXTERIOR_J } as const;
export const totalesVacios = () => ({ esperado: Array<bigint>(NE + 1).fill(0n), cuentas: Array<bigint>(CUENTAS).fill(0n) });
