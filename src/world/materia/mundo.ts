/**
 * Mundo material en sombra (carril W, etapa 1; ARQ-materia §2 y §5.1). Levanta, de las teselas de un mundo ya creado,
 * su estado en lotes de átomos y lo hace avanzar con las leyes de la librería de materia, sin que ninguna ley del mundo
 * escalar lo lea todavía.
 *
 * Por tesela: Suelo (κ del suelo), Agua si tiene agua potable, y Vida (hoja, fruto y tronco en un solo lote, ver
 * vistas.ts). Por página de 16 × 16: un lote de Aire. La roca es una reserva latente (cuantos de SiO₂ fuera de la arena y
 * del libro) que solo entra, como fuente declarada, cuando algo la rompe. Las cantidades iniciales se eligen para que
 * las vistas reproduzcan los escalares de la tesela.
 *
 * Un paso material (cada N ticks, con dt = N) hace, página a página y sin tocar otras páginas: sol y crecimiento
 * (`copiar` desde suelo, charca y aire), caída de hojas, frutos y troncos al suelo, química de cada lote (`pasoLote`;
 * la descomposición y la respiración del suelo salen de ahí), intercambio de gases suelo–aire, filtración charca–suelo,
 * evaporación y condensación del agua, y el termostato (radiación) hacia la temperatura del aire. Las páginas no se
 * hablan entre sí, así que un hilo por grupo de páginas basta para repartirlo; el azar va por página, de modo que el
 * resultado no depende del número de hilos (salvo las sustancias nuevas que descubra cada química local).
 *
 * Fuentes y sumideros declarados: la materia inicial (`levantar`), el sol (calor que paga la síntesis), la radiación
 * (termostato, en los dos sentidos), la ignición de un fuego y lo que se extrae (`extraer`, el sumidero de comer y beber
 * de la etapa siguiente). Todo lo demás se conserva por construcción en la arena.
 */
import { CAPACIDAD_ATOMO, ELEMENTOS, KAPPA0, KAPPA_SUELO, KAPPA_SUELO_HH, NE, NIVEL_CATALIZADO, NU, R } from '../../shared/naturaleza.js';
import type { SustanciaId } from '../../shared/materia.js';
import type { Tile } from '../../shared/types.js';
import { PageArena, type ArenaCompartida } from '../soa/arena.js';
import type { Registro } from '../motor/contratos.js';
import { TICKS_PER_DAY } from '../mundo/tipos.js';
import { DEFAULT_PARAMS } from '../params.js';
import {
  CRECIMIENTO_COMIDA, EVAPORACION_LUZ, EVAPORACION_OSCURIDAD, HAMBRE_POR_PASO, HAMBRE_POR_UNIDAD, LUZ_CREPSCULO,
  RECARGA_LLUVIA, SED_POR_PASO, SED_POR_UNIDAD,
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
/** Fracción del aire de una tesela que intercambia vapor con su superficie en el día (la capa baja que se renueva en
 * `tauVapor`; el resto de la columna es la reserva de gases del aire, no de agua). Con la columna entera el aire saturado
 * guarda 1,7 veces el agua de una charca por tesela y, sin lluvia con origen, el agua de las charcas acaba toda en el aire
 * en un día (medido: 0 % de retención en 3.000 ticks; 45–60 % con 0,03–0,1). */
const CAPA_VAPOR = 0.1;

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

/** Tesela de referencia de la equivalencia: pradera a su capacidad, humedad y fertilidad medias. */
export const REFERENCIA = { capacidad: DEFAULT_PARAMS.recursos.capacidadPastizal, humedad: 0.5, fertilidad: 0.5, madera: 12 };

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
  /** Ticks en que la capa de aire sobre una tesela se renueva (evaporación y condensación). */
  tauVapor: number;
  /** De dónde sale cada constante, para el informe. */
  porque: Record<string, string>;
}

const captura = (vegetacion: number) => -Math.expm1(-vegetacion);

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
 *   luz es 1 − e^(−vegetación) (Beer–Lambert con índice foliar = vegetación);
 * - madera: 1 unidad = 1 kg de madera (CH₂O); piedra: 1 unidad = 1 kg de SiO₂;
 * - caída: el rebrote del mundo escalar a media capacidad (mismo día de luz, humedad y vegetación) es el de la sombra a
 *   la mitad de su equilibrio, d·equilibrio/2 por tick; crecimiento: el que deja el equilibrio en la capacidad de
 *   referencia con la luz media del día y el agua de la humedad de referencia.
 */
export function calibrar(q: Pick<ServicioQuimico, 'sustancia'>, S: BaseMundo): ParamsMundo {
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
  const cRef = captura(K), cMedia = captura(K / 2);
  const caida: Tasas = {
    hoja: rebroteHoja / (TICKS_PER_DAY * K * (cMedia / cRef - 0.5)),
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
    escalas, crecimiento, caida, suelo,
    gCharca: 1 / (TICKS_PER_DAY * (1 / escalas.agua + 1 / escalas.humedad)),
    tauVapor: TICKS_PER_DAY,
    porque: {
      alimento: `${comidaDia.toFixed(3)} u/día de comida ↔ 8,4 MJ; ${energiaOxidacion(q, S, partes('fruto')).toFixed(0)} J por unidad de fruto`,
      agua: `${aguaDia.toFixed(3)} u/día de agua ↔ 2,5 L`,
      humedad: `misma lluvia: +${lluviaHumedad} de humedad ↔ +${lluviaAgua.toFixed(4)} de agua potable`,
      vegetacion: 'la planta de la caja validada (2.000 unidades) es vegetación 0,5',
      madera: '1 unidad = 1 kg de CH₂O', piedra: '1 unidad = 1 kg de SiO₂',
      caida: `rebrote escalar a media capacidad por día: fruto ${rebroteFruto.toFixed(4)}, hoja ${rebroteHoja.toFixed(4)}, tronco ${rebroteTronco.toFixed(4)}`,
      crecimiento: `equilibrio en la referencia (K ${K}, humedad ${m}, luz media ${LUZ_MEDIA}, captura ${cRef.toFixed(3)})`,
      gCharca: 'charca y suelo igualan su llenado (agua/escala) en un día',
      tauVapor: 'la capa de aire de una tesela se renueva en un día',
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

/** Contabilidad por hilo: sol, radiación que entra y que sale, ignición (J) y tejido caído al suelo (cuantos). */
const SOL = 0, RAD_ENTRA = 1, RAD_SALE = 2, IGNICION = 3, CAIDA = 4, CUENTAS = 5;
const LIBRO = 3 * (NE + 1);

export interface DescriptorMundo {
  n: number; np: number; hilos: number;
  lotes: ArenaCompartida; desborde: ArenaCompartida; paginas: ArenaCompartida;
  /** Por tesela (ordenadas por página): suelo, agua, vida, latente, celda; por página: inicio, aire, dueño, azar, dT. */
  sab: Record<'suelo' | 'agua' | 'vida' | 'latente' | 'celda' | 'x' | 'y' | 'inicio' | 'aire' | 'dueno' | 'azar' | 'dT' | 'libros', SharedArrayBuffer>;
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
   * de 16 × 16 por sus coordenadas; la página p es del hilo p % hilos. `luz` fija la temperatura inicial.
   */
  static levantar(tiles: readonly Tile[], q: ServicioQuimicoImpl, op: { hilos?: number; semilla?: number; luz?: number } = {}): MundoMaterial {
    const hilos = op.hilos ?? 1, semilla = op.semilla ?? 1;
    const S = sustanciasMundo(q);
    const plantillas = plantillasMundo(q, S), params = calibrar(q, S);
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
        const potable = Math.round((t.drinkingWater ?? 0) * e.agua);
        m.agua[i] = potable > 0 ? m.arena.nuevo(Rol.Agua, c, 0) : -1;
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

  /** Cuantos de vapor que satura la capa de intercambio de un aire con `gases` cuantos de otros gases a T (Raoult–Dalton). */
  vaporSaturado(gases: number, T: number): number {
    const tEb = this.quimica.sustancia(this.S.H2O).prop.tEbullicion;
    const x = Math.min(0.99, Math.exp(-TROUTON * (tEb / T - 1)));
    return CAPA_VAPOR * gases * x / (1 - x);
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

  /** Un paso de todas las páginas de este hilo. */
  pasar(f: Forzamiento): void {
    this.arena.barrera();
    for (let p = 0; p < this.np; p++) if (this.dueno[p] === this.hilo) this.pasarPagina(p, f);
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
    const base = f.luz * Math.min(1, agua >= 0 ? 1 : humedad) * captura(u.hoja / e.vegetacion) * f.dt;
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
    let gases = 0;
    for (const id of this.especies(a)) if (id !== H2O && this.esGas(id, T)) gases += this.arena.cuantos(a, id);
    const sCol = this.vaporSaturado(gases, T) / nT, vCol = this.arena.cuantos(a, H2O) / nT;
    const r = -Math.expm1(-dt / this.params.tauVapor), hum = this.params.escalas.humedad;
    for (let i = i0; i < i1; i++) {
      const sup = this.agua[i]! >= 0 ? this.agua[i]! : this.suelo[i]!;
      const actividad = this.agua[i]! >= 0 ? 1 : Math.min(1, this.arena.cuantos(sup, H2O) / hum);
      const x = r * (actividad * sCol - vCol), k = entero(Math.abs(x), this.ctx.azar);
      if (k === 0) continue;
      if (x > 0) this.arena.moverParte(sup, a, { parte: Parte.Exacta, esp: H2O, cuantos: k, kappa: null });
      else this.arena.moverParte(a, sup, { parte: Parte.Exacta, esp: H2O, cuantos: k, kappa: null });
    }
  }

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
    const T = this.arena.calor(this.vida[i]!) / (CAPACIDAD_ATOMO * medir(this.ctx, this.vida[i]!).atomos);
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
    const T = this.arena.calor(l) / (CAPACIDAD_ATOMO * medir(this.ctx, l).atomos);
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

  /** Suma en bigint los libros de todos los hilos (fuentes − sumideros) y la contabilidad de energía, y los deja a cero. */
  plegar(totales: { esperado: bigint[]; cuentas: bigint[] }): void {
    for (let h = 0; h < this.d.hilos; h++) {
      const b = h * (LIBRO + CUENTAS);
      for (let k = 0; k <= NE; k++) {
        totales.esperado[k]! += BigInt(this.libros[b + k]!) - BigInt(this.libros[b + NE + 1 + k]!);
        this.libros[b + k] = 0; this.libros[b + NE + 1 + k] = 0;
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

export const CUENTA = { SOL, RAD_ENTRA, RAD_SALE, IGNICION, CAIDA } as const;
export const totalesVacios = () => ({ esperado: Array<bigint>(NE + 1).fill(0n), cuentas: Array<bigint>(CUENTAS).fill(0n) });
