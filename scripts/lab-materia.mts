/**
 * Laboratorio de materia y química V23 (carril Q; ARQ-materia §5 E0 / I6 y PLAN-V23 ola 1).
 *
 * Ejecuta y verifica:
 *  1. Tabla de cordura completa (I6): agua líquida, fuego y estabilidad en frío, pirólisis a carbón,
 *     calor por masa madera < carbón < grasa < metano, cocción de arcilla a cerámica dura, cal que calcina
 *     en horno y fragua a ambiente, hierro reducido en horno y no en fogata, retorno de N y P al suelo.
 *  2. Reacciones de control: CH₄ + O₂, CaCO₃ a temperatura alta, pirólisis de madera.
 *  3. Matices de refirma (0b.refirma.md): orden catalítico D(C–N) < D(C–O) < D(C–C) < D(C–H), digestión a 310 K
 *     con KAPPA0, descomposición del suelo a 295 K con KAPPA_SUELO, margen llama en aire (1.095 K) vs horno (1.131 K).
 *  4. Invariante I4 sobre el registro y el memo completos.
 *  5. Banco de rendimiento de `productos()` hasta 16 átomos en frío y con memoria caliente (puerta: p99 < 50 ms).
 *  6. Caja cerrada (enmiendas 1 y 2): 40 recambios de biomasa con piezas reales (arena, química, pasoLote, fluir,
 *     copiar, desprender, quemar; tests/lib/caja-cerrada.ts): sin fuego, con fuego (plantas que aceptan N₂ y P₂O₅ gas),
 *     con 100 veces más aire por poro y sin herbívoro, y con el suelo a 275 K: agua, H₂, biomasa, balance exacto y
 *     destino de N y P.
 *
 *  7. A demanda (`--cajas[=<regex>]`, enmienda 3): la batería de 74 cajas paramétricas de la validación de los ciclos
 *     (tests/lib/caja-param.ts) con sus umbrales y la expectativa de cada una, en procesos hijos.
 *
 * Uso: npx tsx scripts/lab-materia.mts [--json] [--solo-banco] [--sin-caja]
 *      npx tsx scripts/lab-materia.mts --cajas[=<regex>] [--paralelo N] [--salida fichero.json]
 */
import { performance } from 'node:perf_hooks';
import {
  CAPACIDAD_ATOMO, E_CAT_IONICO, E_HID_IONICO, E_RES_IONICO, ELEMENTOS, KAPPA0, KAPPA_SUELO, NE, NU, R,
} from '../src/shared/naturaleza.js';
import { ClaseSustancia, TIPOS, type SustanciaId } from '../src/shared/materia.js';
import { barreraEfectiva, nivelDeT, tDeNivel, type Kappa, type Reaccion, type Sustancia } from '../src/world/materia/tipos.js';
import {
  ContextoSolver, esGasA, indiceTipoEnlace, productos,
} from '../src/world/materia/quimica.js';
import { crearServicioQuimico, verificarI4, type ServicioQuimicoImpl } from '../src/world/materia/servicio.js';

function enlace(a: string, b: string, k: 1 | 2 | 3 = 1): number {
  const e = ELEMENTOS.indexOf(a as never);
  const f = ELEMENTOS.indexOf(b as never);
  const ti = indiceTipoEnlace(e, f, k);
  if (ti < 0) throw new Error(`Enlace inexistente: ${a}-${b}(${k})`);
  return ti;
}

function vec(pares: readonly [number, number][]): Uint16Array {
  const out = new Uint16Array(pares.length * 2);
  for (let i = 0; i < pares.length; i++) {
    out[2 * i] = pares[i]![0];
    out[2 * i + 1] = pares[i]![1];
  }
  return out;
}

/** Tasa de Arrhenius de ARQ-materia §3.1 con las enmiendas 1 y 2, k(T) = ν·exp(−b/(R·T)) con b = `barreraEfectiva`
 * (max(0, ea − κ) en una exotérmica, ea en una endotérmica: la catálisis solo rebaja lo que suelta calor), en 1/tick o
 * L/(cuanto·tick) por vez de reacción. Un κ numérico vale para las 4 familias. */
export function tasaArrhenius(
  T: number,
  r: Pick<Reaccion, 'ea' | 'catalisis' | 'dH' | 'paresCatalisis'>,
  kappa: Kappa | number = 0,
): number {
  const b = barreraEfectiva(r, typeof kappa === 'number' ? [kappa, kappa, kappa, kappa] : kappa);
  return b === 0 ? NU : NU * Math.exp(-b / (R * T));
}

function formula(s: Readonly<Sustancia>): string {
  let out = '';
  for (let e = 0; e < NE; e++) {
    const n = s.atomos[e]!;
    if (n > 0) out += ELEMENTOS[e]! + (n > 1 ? String(n) : '');
  }
  return out;
}

function describirEnlaces(enlaces: Uint16Array): string {
  const partes: string[] = [];
  for (let i = 0; i < enlaces.length; i += 2) {
    const t = TIPOS[enlaces[i]!]!;
    const sym = t.k === 1 ? '–' : t.k === 2 ? '=' : '≡';
    partes.push(`${ELEMENTOS[t.e]}${sym}${ELEMENTOS[t.f]}:${enlaces[i + 1]}`);
  }
  return `{${partes.join(', ')}}`;
}

function describirReaccion(serv: ServicioQuimicoImpl, r: Reaccion | null): string {
  if (!r) return 'sin reacción';
  const lado = (items: readonly { id: SustanciaId; nu: number }[]) =>
    items.map(x => `${x.nu > 1 ? `${x.nu} ` : ''}${formula(serv.sustancia(x.id))}`).join(' + ');
  return `${lado(r.entradas)} → ${lado(r.salidas)} (dH=${r.dH}, ea=${r.ea.toFixed(1)}, cat=${r.catalisis})`;
}

export interface ResultadoCordura {
  nombre: string;
  cumple: boolean;
  detalle: string;
}

export interface ResumenBanco {
  muestras: number;
  maxAtomos: number;
  frioMs: { p50: number; p95: number; p99: number; max: number; media: number };
  calienteMs: { p50: number; p95: number; p99: number; max: number; media: number };
  cumpleP99Frio: boolean;
  cumpleP99Caliente: boolean;
}

function percentil(ordenado: readonly number[], p: number): number {
  if (ordenado.length === 0) return 0;
  const idx = Math.min(ordenado.length - 1, Math.max(0, Math.ceil((p / 100) * ordenado.length) - 1));
  return ordenado[idx]!;
}

function resumirTiempos(valores: readonly number[]) {
  const ord = [...valores].sort((a, b) => a - b);
  const media = ord.reduce((s, x) => s + x, 0) / Math.max(1, ord.length);
  return { p50: percentil(ord, 50), p95: percentil(ord, 95), p99: percentil(ord, 99), max: ord[ord.length - 1] ?? 0, media };
}

/** Construye un conjunto representativo de sustancias del mundo (≤ 8 átomos) para cordura y banco. */
export function registrarSustanciasBase(serv: ServicioQuimicoImpl) {
  const reg = (pares: readonly [number, number][]) => serv.internar(vec(pares));
  return {
    H2: reg([[enlace('H', 'H'), 1]]),
    O2: reg([[enlace('O', 'O', 2), 1]]),
    N2: reg([[enlace('N', 'N', 3), 1]]),
    H2O: reg([[enlace('H', 'O'), 2]]),
    CO2: reg([[enlace('C', 'O', 2), 2]]),
    NH3: reg([[enlace('H', 'N'), 3]]),
    CH4: reg([[enlace('H', 'C'), 4]]),
    C2H6: reg([[enlace('C', 'C'), 1], [enlace('H', 'C'), 6]]),
    C: reg([[enlace('C', 'C'), 2]]),
    CH2: reg([[enlace('C', 'C'), 1], [enlace('H', 'C'), 2]]),
    madera: reg([[enlace('C', 'C'), 1], [enlace('H', 'C'), 1], [enlace('C', 'O'), 1], [enlace('H', 'O'), 1]]),
    glicosido: reg([[enlace('C', 'O'), 2], [enlace('H', 'C'), 2]]),
    metanol: reg([[enlace('H', 'C'), 3], [enlace('C', 'O'), 1], [enlace('H', 'O'), 1]]),
    formamida: reg([[enlace('C', 'O', 2), 1], [enlace('C', 'N'), 1], [enlace('H', 'C'), 1], [enlace('H', 'N'), 2]]),
    proteina: reg([[enlace('C', 'C'), 1], [enlace('H', 'C'), 1], [enlace('C', 'N'), 1], [enlace('H', 'N'), 2]]),
    urea: reg([[enlace('C', 'O', 2), 1], [enlace('C', 'N'), 2], [enlace('H', 'N'), 4]]),
    acetico: reg([[enlace('C', 'C'), 1], [enlace('C', 'O', 2), 1], [enlace('C', 'O'), 1], [enlace('H', 'C'), 3], [enlace('H', 'O'), 1]]),
    orgP: reg([[enlace('C', 'C'), 1], [enlace('H', 'C'), 1], [enlace('C', 'O'), 1], [enlace('O', 'P'), 3], [enlace('O', 'P', 2), 1]]),
    H3PO4: reg([[enlace('H', 'O'), 3], [enlace('O', 'P'), 5]]),
    SiO2: reg([[enlace('O', 'Si'), 4]]),
    arcilla: reg([[enlace('O', 'Si'), 4], [enlace('H', 'O'), 2]]),
    CaO: reg([[enlace('O', 'Ca'), 2]]),
    CaOH2: reg([[enlace('O', 'Ca'), 2], [enlace('H', 'O'), 2]]),
    CaCO3: reg([[enlace('O', 'Ca'), 2], [enlace('C', 'O'), 2], [enlace('C', 'O', 2), 1]]),
    CaHPO4: reg([[enlace('O', 'Ca'), 2], [enlace('O', 'P'), 3], [enlace('O', 'P', 2), 1], [enlace('H', 'O'), 1]]),
    Fe2O3: reg([[enlace('O', 'Fe'), 6]]),
    Fe2O2: reg([[enlace('O', 'Fe'), 4], [enlace('Fe', 'Fe'), 1]]),
    Fe2O: reg([[enlace('O', 'Fe'), 2], [enlace('Fe', 'Fe'), 2]]),
    Fe2: reg([[enlace('Fe', 'Fe'), 3]]),
  };
}

export function ejecutarTablaCordura(): {
  cordura: ResultadoCordura[];
  violacionesI4: ReturnType<typeof verificarI4>;
  servicio: ServicioQuimicoImpl;
} {
  const serv = crearServicioQuimico({ modo: 'inmediato' });
  const S = registrarSustanciasBase(serv);
  const cordura: ResultadoCordura[] = [];
  const reac = (a: SustanciaId, b: SustanciaId, l: number): Reaccion | null => serv.reaccion(a, b, l) ?? null;

  const lvlAmb = nivelDeT(295);
  const lvlCuerpo = nivelDeT(310);
  const lvlFogata = nivelDeT(800);
  const lvlLlama = nivelDeT(1095);
  const lvlHorno = nivelDeT(1250);
  const lvlHornoAlto = nivelDeT(1500);

  // 1. Agua líquida a 295 K y CO₂ gas a toda T.
  const agua = serv.sustancia(S.H2O);
  const co2 = serv.sustancia(S.CO2);
  const rCo2 = reac(S.CO2, S.CO2, 0);
  const okAgua = agua.clase === ClaseSustancia.Molecula
    && agua.prop.tFusion < 295 && agua.prop.tEbullicion > 295
    && co2.clase === ClaseSustancia.Molecula && esGasA(co2, 218) && rCo2 === null;
  cordura.push({
    nombre: 'Agua líquida y CO₂ gas estable',
    cumple: okAgua,
    detalle: `H₂O Tf=${agua.prop.tFusion.toFixed(0)}K Teb=${agua.prop.tEbullicion.toFixed(0)}K; CO₂ Teb=${co2.prop.tEbullicion.toFixed(0)}K, 2·CO₂@218K=${describirReaccion(serv, rCo2)}`,
  });

  // 2. Madera arde solo por encima del umbral y sostiene su llama en aire (> 1.000 K).
  const rMadO2Amb = reac(S.madera, S.O2, lvlAmb);
  const rMadO2Llama = reac(S.madera, S.O2, lvlLlama);
  const kFrio = rMadO2Amb ? tasaArrhenius(295, rMadO2Amb, 0) : 0;
  const tLlamaMadera = rMadO2Llama ? 295 + (-rMadO2Llama.dH) / (14 * CAPACIDAD_ATOMO) : 0;
  const kLlama = rMadO2Llama ? tasaArrhenius(tLlamaMadera, rMadO2Llama, 0) : 0;
  const rAire = reac(S.N2, S.O2, lvlLlama);
  const okFuego = rMadO2Amb !== null && rMadO2Amb.dH < -200
    && kFrio < 1e-18 && tLlamaMadera > 1000 && kLlama > 1 && rAire === null;
  cordura.push({
    nombre: 'Madera arde solo sobre umbral y aire estable',
    cumple: okFuego,
    detalle: `${describirReaccion(serv, rMadO2Llama)}; k(295K)=${kFrio.toExponential(1)}, T_llama=${tLlamaMadera.toFixed(0)}K, k(llama)=${kLlama.toFixed(2)}/tick; N₂+O₂=${describirReaccion(serv, rAire)}`,
  });

  // 3. Pirólisis de madera → carbón + agua.
  const rPir = reac(S.madera, 0, lvlFogata);
  const tieneCarbon = rPir !== null && rPir.salidas.some(p => p.id === S.C);
  const tieneAgua = rPir !== null && rPir.salidas.some(p => p.id === S.H2O);
  const kPirFrio = rPir ? tasaArrhenius(295, rPir, 0) : 0;
  const kPirCaliente = rPir ? tasaArrhenius(800, rPir, 0) : 0;
  cordura.push({
    nombre: 'Pirólisis de madera → carbón + H₂O',
    cumple: tieneCarbon && tieneAgua && kPirFrio < 1e-12 && kPirCaliente > 1e-1,
    detalle: `${describirReaccion(serv, rPir)}; k(295K)=${kPirFrio.toExponential(1)}, k(800K)=${kPirCaliente.toFixed(2)}/tick`,
  });

  // 4. Calor por masa: madera < carbón < grasa < metano (Hess exacto).
  const qPorKg = (id: SustanciaId) => {
    const s = serv.sustancia(id);
    return s.prop.qOxidacion / s.masa; // J/mmol / (mg/mmol) = MJ/kg
  };
  const qMad = qPorKg(S.madera), qCar = qPorKg(S.C), qGra = qPorKg(S.CH2), qMet = qPorKg(S.CH4);
  cordura.push({
    nombre: 'Calor por masa: madera < carbón < grasa < metano',
    cumple: qMad > 0 && qMad < qCar && qCar < qGra && qGra < qMet,
    detalle: `madera=${qMad.toFixed(2)} < carbón=${qCar.toFixed(2)} < grasa=${qGra.toFixed(2)} < metano=${qMet.toFixed(2)} MJ/kg`,
  });

  // 5. Arcilla (H₂SiO₃) blanda a 295 K, endurece al cocer en horno (→ SiO₂ + H₂O), no cuece en agua hirviendo.
  const sArc = serv.sustancia(S.arcilla);
  const sSil = serv.sustancia(S.SiO2);
  const rArcAmb = reac(S.arcilla, 0, lvlAmb);
  const rArcHorno = reac(S.arcilla, 0, lvlLlama);
  const kArcHervor = rArcHorno ? tasaArrhenius(380, rArcHorno, 0) : 0;
  const kArcHorno = rArcHorno ? tasaArrhenius(900, rArcHorno, 0) : 0;
  const okArc = rArcAmb === null && rArcHorno !== null
    && rArcHorno.salidas.some(p => p.id === S.SiO2) && rArcHorno.salidas.some(p => p.id === S.H2O)
    && sArc.prop.dureza < sSil.prop.dureza && kArcHervor < 1e-8 && kArcHorno > 0.5;
  cordura.push({
    nombre: 'Arcilla blanda endurece al cocer (cerámica)',
    cumple: okArc,
    detalle: `dureza ${sArc.prop.dureza.toFixed(3)}→${sSil.prop.dureza.toFixed(3)}; @295K=${describirReaccion(serv, rArcAmb)}; @horno=${describirReaccion(serv, rArcHorno)}; k(380K)=${kArcHervor.toExponential(1)}, k(900K)=${kArcHorno.toFixed(2)}`,
  });

  // 6. Cal: calcina en horno (no en fogata), se apaga con H₂O y fragua a ambiente (CaO+CO₂ y Ca(OH)₂+CO₂ → CaCO₃).
  const rCalFogata = reac(S.CaCO3, 0, lvlFogata);
  const rCalHorno = reac(S.CaCO3, 0, lvlHorno);
  const rApaga = reac(S.CaO, S.H2O, lvlAmb);
  const rFraguaDir = reac(S.CaO, S.CO2, lvlAmb);
  const rFraguaMor = reac(S.CaOH2, S.CO2, lvlAmb);
  const kFragua = rFraguaMor ? tasaArrhenius(295, rFraguaMor, 0) : 0;
  const kCalcHorno = rCalHorno ? tasaArrhenius(1234, rCalHorno, 0) : 0;
  const okCal = rCalFogata === null && rCalHorno !== null
    && rCalHorno.salidas.some(p => p.id === S.CaO) && rCalHorno.salidas.some(p => p.id === S.CO2)
    && rApaga !== null && rApaga.salidas.some(p => p.id === S.CaOH2)
    && rFraguaDir !== null && rFraguaDir.salidas.some(p => p.id === S.CaCO3)
    && rFraguaMor !== null && rFraguaMor.salidas.some(p => p.id === S.CaCO3) && rFraguaMor.salidas.some(p => p.id === S.H2O)
    && kFragua > 1e-3 && kCalcHorno > 1;
  cordura.push({
    nombre: 'Cal: calcina en horno (no fogata) y fragua a 295 K',
    cumple: okCal,
    detalle: `@800K=${describirReaccion(serv, rCalFogata)}; @1250K=${describirReaccion(serv, rCalHorno)}; mortero@295K=${describirReaccion(serv, rFraguaMor)} (k=${kFragua.toExponential(2)}/tick)`,
  });

  // 7. Hierro: Fe₂O₃ + C no se reduce en fogata (800 K, nivel 8) ni en llama abierta (1.095 K, nivel 9); en horno (1.250 K,
  // nivel 10) da CO₂ y un metal (la mitad o más de sus enlaces Fe–Fe: hierro, o hierro con algo de carbono) más duro y
  // tenaz que la sílice; Fe₂O₂ + C → Fe₂ + CO₂ en horno alto; ningún óxido de hierro ni el hierro con carbón dan carburo
  // (producto con enlaces Fe–C de su Fe sin Fe–Fe) en los niveles 8–11 (enmienda 3: antes ganaba C₃Fe₄ ya en la fogata);
  // el hierro se oxida en frío.
  const rFeFogata = reac(S.Fe2O3, S.C, lvlFogata);
  const rFeLlamaAire = reac(S.Fe2O3, S.C, lvlLlama);
  const rFeHorno = reac(S.Fe2O3, S.C, lvlHorno);
  const rFe2Puro = reac(S.Fe2O2, S.C, lvlHornoAlto);
  const rFeOxida = reac(S.Fe2, S.O2, lvlAmb);
  const sFe = serv.sustancia(S.Fe2);
  const tFeFe = enlace('Fe', 'Fe'), tFeC = enlace('C', 'Fe');
  const cuenta = (s: Readonly<Sustancia>, t: number) => { for (let i = 0; i < s.enlaces.length; i += 2) if (s.enlaces[i] === t) return s.enlaces[i + 1]!; return 0; };
  const totalEnlaces = (s: Readonly<Sustancia>) => { let n = 0; for (let i = 1; i < s.enlaces.length; i += 2) n += s.enlaces[i]!; return n; };
  const iFe = ELEMENTOS.indexOf('Fe' as never);
  const metal = (r: Reaccion | null) => r?.salidas.map(p => serv.sustancia(p.id)).find(s => s.atomos[iFe]! > 0 && 2 * cuenta(s, tFeFe) >= totalEnlaces(s));
  const mHorno = metal(rFeHorno);
  const carburos: string[] = [];
  for (const ox of [S.Fe2O3, S.Fe2O2, S.Fe2O, S.Fe2]) for (let l = lvlFogata; l <= lvlHornoAlto; l++) {
    const r = reac(ox, S.C, l);
    if (r?.salidas.some(p => cuenta(serv.sustancia(p.id), tFeC) > 0)) carburos.push(`${formula(serv.sustancia(ox))}+C@${l}: ${describirReaccion(serv, r)}`);
  }
  const okFe = rFeFogata === null && rFeLlamaAire === null && rFeHorno !== null
    && rFeHorno.salidas.some(p => p.id === S.CO2) && mHorno !== undefined
    && mHorno.prop.dureza > sSil.prop.dureza && mHorno.prop.tenacidad > sSil.prop.tenacidad
    && rFe2Puro !== null && rFe2Puro.salidas.some(p => p.id === S.Fe2) && rFe2Puro.salidas.some(p => p.id === S.CO2)
    && carburos.length === 0
    && rFeOxida !== null && rFeOxida.dH < -300
    && sFe.prop.dureza > sSil.prop.dureza && sFe.prop.tenacidad > sSil.prop.tenacidad;
  cordura.push({
    nombre: 'Hierro: reduce en horno a metal (no fogata/llama abierta, sin carburo), oxida en frío',
    cumple: okFe,
    detalle: `Fe₂O₃+C @800K=${describirReaccion(serv, rFeFogata)}; @1095K=${describirReaccion(serv, rFeLlamaAire)}; @1250K=${describirReaccion(serv, rFeHorno)}; Fe₂O₂+C@1500K=${describirReaccion(serv, rFe2Puro)}; carburos en niveles ${lvlFogata}–${lvlHornoAlto}: ${carburos.length ? carburos.join(' | ') : 'ninguno'}; metal del horno ${mHorno ? `${formula(mHorno)} dureza ${mHorno.prop.dureza.toFixed(3)}, tenacidad ${mHorno.prop.tenacidad.toFixed(2)}` : 'ninguno'} > SiO₂ ${sSil.prop.dureza.toFixed(3)}, ${sSil.prop.tenacidad.toFixed(2)}; Fe₂+O₂@295K dH=${rFeOxida?.dH}`,
  });

  // 8. Control CH₄ + O₂ + retorno de N y P al suelo + estabilidad de roca y carbón (sin jaulas K5/K2,4).
  const rMetO2 = reac(S.CH4, S.O2, lvlLlama);
  const rProtSuelo = reac(S.proteina, 0, lvlAmb);
  const rOrgPSuelo = reac(S.orgP, 0, lvlAmb);
  const rCSuelo = reac(S.C, S.O2, lvlAmb);
  const rNH3Aire = reac(S.NH3, S.O2, lvlAmb);
  const kNH3Suelo = rNH3Aire ? tasaArrhenius(295, rNH3Aire, KAPPA_SUELO) : 0;
  const kCSuelo = rCSuelo ? tasaArrhenius(295, rCSuelo, KAPPA_SUELO) : 0;
  const kProtSuelo = rProtSuelo ? tasaArrhenius(295, rProtSuelo, KAPPA_SUELO) : 0;
  const kOrgPSuelo = rOrgPSuelo ? tasaArrhenius(295, rOrgPSuelo, KAPPA_SUELO) : 0;
  // Roca y carbón estables en horno y por encima (niveles 10–15, hasta ~2.900 K; el grafito sublima a ~3.900 K): ni
  // SiO₂ ni el carbón se vuelven gas (sin la regla del átomo lineal, C₃{C=C:3} sublimaba en el nivel 11, enmienda 3).
  const inestables: string[] = [];
  for (let l = lvlHorno; l <= 15; l++) for (const x of [S.SiO2, S.C]) {
    const r = reac(x, x, l);
    if (r) inestables.push(`${formula(serv.sustancia(x))}@${l}: ${describirReaccion(serv, r)}`);
  }
  // Salida del HCN (enmienda 3): el HCN que deja un fuego pobre en O₂ se oxida en el suelo con O₂ (catálisis C≡N por
  // pares: 3·KAPPA_SUELO ≥ GAMMA·D(C≡N)); antes, k(295 K) ≈ 2·10⁻²⁸.
  const sHCN = serv.internar(vec([[enlace('H', 'C'), 1], [enlace('C', 'N', 3), 1]]));
  const rHCNSuelo = reac(sHCN, S.O2, lvlAmb);
  const kHCNSuelo = rHCNSuelo ? tasaArrhenius(295, rHCNSuelo, KAPPA_SUELO) : 0;
  const okCiclo = rMetO2 !== null && rMetO2.salidas.some(p => p.id === S.CO2) && rMetO2.dH < -150
    && rProtSuelo !== null && rProtSuelo.salidas.some(p => p.id === S.NH3) && kProtSuelo > 1
    && rOrgPSuelo !== null && kOrgPSuelo > 1e-3 && kCSuelo > 1e-4 && kNH3Suelo < 1e-15
    && rHCNSuelo !== null && rHCNSuelo.salidas.some(p => p.id === S.CO2) && kHCNSuelo > 1e-2
    && inestables.length === 0;
  cordura.push({
    nombre: 'CH₄+O₂, retorno de N/P en suelo (NH₃ preservado, HCN oxidado) y roca/C estables',
    cumple: okCiclo,
    detalle: `CH₄+O₂=${describirReaccion(serv, rMetO2)}; prot=${describirReaccion(serv, rProtSuelo)}; orgP=${describirReaccion(serv, rOrgPSuelo)}; k_C+O2=${kCSuelo.toExponential(2)}, k_NH3+O2=${kNH3Suelo.toExponential(1)}; HCN+O₂@295K=${describirReaccion(serv, rHCNSuelo)} (k=${kHCNSuelo.toExponential(2)}); SiO₂ y C en niveles ${lvlHorno}–15: ${inestables.length ? inestables.join(' | ') : 'estables'}`,
  });

  // 9. Auditoría de matices de digestión a 310 K (KAPPA0) y jerarquía catalítica.
  const rGlic = reac(S.glicosido, 0, lvlCuerpo);
  const rForm = reac(S.formamida, 0, lvlCuerpo);
  const rMadDig = reac(S.madera, 0, lvlCuerpo);
  const kMadDig = rMadDig ? tasaArrhenius(310, rMadDig, KAPPA0) : 0;
  const kGlicDig = rGlic ? tasaArrhenius(310, rGlic, KAPPA0) : 0;
  const kFormDig = rForm ? tasaArrhenius(310, rForm, KAPPA0) : 0;
  const dCN = TIPOS[enlace('C', 'N')]!.d, dCO = TIPOS[enlace('C', 'O')]!.d;
  const dCC = TIPOS[enlace('C', 'C')]!.d, dCH = TIPOS[enlace('H', 'C')]!.d;
  cordura.push({
    nombre: 'Jerarquía catalítica C–N < C–O < C–C < C–H y digestión a 310 K',
    cumple: dCN < dCO && dCO < dCC && dCC < dCH && rMadDig?.catalisis === 0 && rProtSuelo?.catalisis === 1,
    detalle: `D=[${dCN},${dCO},${dCC},${dCH}]; cat(madera)=${rMadDig?.catalisis}, k_madera=${kMadDig.toExponential(2)}, k_glic=${kGlicDig.toExponential(2)}, formamida=${describirReaccion(serv, rForm)} (k=${kFormDig.toExponential(2)})`,
  });

  const violacionesI4 = verificarI4(serv, 0);
  return { cordura, violacionesI4, servicio: serv };
}

/**
 * Banco de rendimiento de `productos()` hasta 16 átomos en frío (caché de solver limpia en cada pareja)
 * y con memoria caliente (lectura del memo de `ServicioQuimico`).
 */
export function ejecutarBancoRendimiento(): ResumenBanco {
  const serv = crearServicioQuimico({ modo: 'inmediato' });
  const S = registrarSustanciasBase(serv);
  const ids = Object.values(S);

  // Construir ≥ 120 parejas representativas que cubren de 2 a 16 átomos y hasta 6 elementos simultáneos.
  const parejas: { a: SustanciaId; b: SustanciaId; nivelT: number; atomos: number }[] = [];
  const niveles = [nivelDeT(295), nivelDeT(800), nivelDeT(1250)];
  let maxAtomos = 0;

  for (let i = 0; i < ids.length; i++) {
    const a = ids[i]!;
    const nA = serv.sustancia(a).atomos.reduce((s, x) => s + x, 0);
    parejas.push({ a, b: 0, nivelT: niveles[i % niveles.length]!, atomos: nA });
    for (let j = i; j < ids.length; j += 3) {
      const b = ids[j]!;
      const nB = serv.sustancia(b).atomos.reduce((s, x) => s + x, 0);
      const tot = nA + nB;
      if (tot > maxAtomos) maxAtomos = tot;
      parejas.push({ a, b, nivelT: niveles[(i + j) % niveles.length]!, atomos: tot });
    }
  }

  // Incluir explícitamente parejas de 15–16 átomos (límite superior del contrato).
  for (const [a, b] of [
    [S.H3PO4, S.H3PO4],
    [S.acetico, S.H3PO4],
    [S.urea, S.H3PO4],
    [S.acetico, S.urea],
    [S.H3PO4, S.CaHPO4],
    [S.urea, S.CaHPO4],
    [S.C2H6, S.H3PO4],
    [S.C2H6, S.acetico],
    [S.C2H6, S.urea],
  ] as const) {
    const tot = serv.sustancia(a).atomos.reduce((s, x) => s + x, 0)
      + serv.sustancia(b).atomos.reduce((s, x) => s + x, 0);
    if (tot > maxAtomos) maxAtomos = tot;
    parejas.push({ a, b, nivelT: nivelDeT(295), atomos: tot });
  }

  // Calentamiento breve del JIT de V8 antes de cronometrar.
  const ctxWarmup = new ContextoSolver();
  for (let i = 0; i < 8; i++) {
    const p = parejas[i]!;
    productos(serv.sustancia(p.a), p.b ? serv.sustancia(p.b) : null, p.nivelT, ctxWarmup);
  }

  // Medición en FRÍO: cada pareja corre con un `ContextoSolver` completamente vacío (sin reutilizar caché).
  const tiemposFrio: number[] = [];
  for (const p of parejas) {
    const ctxFrio = new ContextoSolver();
    const sA = serv.sustancia(p.a);
    const sB = p.b ? serv.sustancia(p.b) : null;
    const t0 = performance.now();
    productos(sA, sB, p.nivelT, ctxFrio);
    tiemposFrio.push(performance.now() - t0);
  }

  // Poblar el memo de `ServicioQuimico` y medir lectura en CALIENTE.
  for (const p of parejas) serv.reaccion(p.a, p.b, p.nivelT);
  const tiemposCaliente: number[] = [];
  for (const p of parejas) {
    const t0 = performance.now();
    serv.reaccion(p.a, p.b, p.nivelT);
    tiemposCaliente.push(performance.now() - t0);
  }

  const frioMs = resumirTiempos(tiemposFrio);
  const calienteMs = resumirTiempos(tiemposCaliente);
  return {
    muestras: parejas.length,
    maxAtomos,
    frioMs,
    calienteMs,
    cumpleP99Frio: frioMs.p99 < 50,
    cumpleP99Caliente: calienteMs.p99 < 1,
  };
}

// ── Batería de cajas paramétricas (validación de los ciclos de Fable, 74 cajas; enmienda 3) ─────────────────────
//
// Cada caja es una geometría de tests/lib/caja-param.ts y una expectativa: «cierra» (ningún fallo frente a UMBRALES_CAJA:
// balance exacto, agua no perdida ≥ 97 % (el H que no pasó a H₂ ni a una sustancia que nadie espera), H₂ < 0,5 % del H y
// sin subir, HCN < 1 % del C y sin subir, biomasa del último décimo ≥ 50 % del máximo, ningún sumidero nuevo creciente
// con ≥ 2 % de C, N o P), «falla» (control: un límite conocido que no es de la materia —plantillas que no aceptan lo que
// queda, geometría que entierra— debe aparecer con el fallo que se espera, para que la batería distinga), «abierto»
// (defecto conocido y anterior a la enmienda 3, con su aritmética en el motivo: debe seguir fallando así, y si deja de
// fallar la batería lo marca para que se revise) o «informa» (contrafactual de la validación: solo se mide).

type Espera = { espera: 'cierra' } | { espera: 'falla' | 'abierto'; por: RegExp; motivo: string } | { espera: 'informa'; motivo: string };
type OpcionesMedida = { exigeH2Estable?: boolean; h2Pulso?: boolean };
type CajaBateria = [nombre: string, cfg: Record<string, unknown>, espera?: Espera, op?: OpcionesMedida];

const SUELO = { H2O: 300_000, NH3: 30_000, H3PO4: 10_000, CaCO3: 100_000, SiO2: 1_000_000, N2: 78_000, O2: 21_000, CO2: 2_000 };
const SUELO_SINCAL = { H2O: 300_000, NH3: 30_000, H3PO4: 10_000, SiO2: 1_000_000, N2: 78_000, O2: 21_000, CO2: 2_000 };
/** Plantillas que aceptan N₂ y los fosfatos condensados y gaseosos (hallazgo 2 de la validación). */
const N2P = { nitrogenos: ['NH3', 'N2'], fosfatos: ['H3PO4', 'CaHPO4', 'HPO3u', 'P2O5u', 'P2O5g'] };
const AIRE100 = { capAire: 10_000, aire: { N2: 780_000_000, O2: 210_000_000, CO2: 20_000_000 } };
const AIRE10 = { capAire: 1000, aire: { N2: 78_000_000, O2: 21_000_000, CO2: 2_000_000 } };
const GLIC = [['glicosido', 20], ['CH2', 2], ['proteina', 2], ['orgP', 1]];
const GRASA = [['madera', 10], ['CH2', 10], ['proteina', 2], ['orgP', 1]];

const CTRL_N: Espera = { espera: 'falla', por: /N fijado/, motivo: 'hallazgo 2: las plantillas solo toman NH₃ y los fosfatos del suelo; el fuego pasa el N fijado a N₂ (pedido a W, B y T1, no ley de la materia)' };
const CTRL_P: Espera = { espera: 'falla', por: /P accesible/, motivo: 'hallazgo 2: la plantilla solo toma H₃PO₄ (estricta2, también CaHPO₄); el suelo pasa el P a fosfatos de Ca y a O₅P₂ condensado, que no acepta' };
const contra = (motivo: string): Espera => ({ espera: 'informa', motivo: `contrafactual de la validación: ${motivo}` });
const SOLO_EXO = contra('solo exotérmicas catalizadas, que desde la enmienda 2 es la ley: repite su caja');
const REBAJA_HH = contra('κ H–H rebajado en 68');
const SIN_CAT_FRIO = contra('sin catálisis en la estación fría');
/** Fuego pobre en O₂: hace H₂ de verdad (gas de síntesis) en un pulso que el suelo oxida; el techo se mira al final. */
const PULSO: OpcionesMedida = { h2Pulso: true };
/** Glicósido en suelo denso (enmienda 3, pendiente): ver ARQ-materia §3.1. */
const GLIC_DENSO: Espera = { espera: 'abierto', por: /^H₂ \d/, motivo: 'el glicósido (–CH₂–O–, poliacetal) fermenta en el suelo, 2 glic → 2 H₂ + C + CO₂ (dH −78; en el POM real, −39,5 kJ: también exotérmica). Es bimolecular (k·n²/V): con poros ÷100 va a 261 veces/tick frente a 13,4 con poros normales, ~522 H₂/tick. El suelo oxida casi todo su H₂ en cada tick (2 H₂ + O₂ sin barrera: 515 de 525, vida ≈ 1 tick; ningún κ lo acelera), pero en sus poros solo está 1/(1 + V_aire/V_suelo) del gas: la meseta es ≈ 522 × 1,02 × 1.001 ≈ 533.000 H₂ (medido 525.730, 15,4 % del H); con poros normales, 28,5 × 1,05 × 11 ≈ 330 (medido 316, 0,009 %). Es geometría y paso de integración (el H₂ sale al aire antes de que el suelo lo vea), no una constante de la química; igual en la enmienda 2' };

export const BATERIA_CAJAS: CajaBateria[] = [
  ['base-1000', { recambios: 1000, fotoCada: 2 }],
  ['fuego-400', { recambios: 400, cadaFuego: 4 }, CTRL_N],
  ['estricta-400', { recambios: 400, fosfatos: ['H3PO4'] }, CTRL_P],
  ['estricta-fuego-400', { recambios: 400, fosfatos: ['H3PO4'], cadaFuego: 4 }, CTRL_P],
  ['auto-fuego-400', { recambios: 400, fosfatos: ['H3PO4'], auto: true, cadaFuego: 4 }],
  ['conN2P-fuego-400', { ...N2P, recambios: 400, cadaFuego: 4 }],
  ['seca-400', { suelo: { ...SUELO, H2O: 100_000 }, recambios: 400, agua: { H2O: 100_000 } }],
  ['muyseca-400', { suelo: { ...SUELO, H2O: 60_000 }, recambios: 400, agua: {} }],
  ['muyseca-fuego-400', { ...N2P, suelo: { ...SUELO, H2O: 60_000 }, recambios: 400, cadaFuego: 4, agua: {} }],
  ['humeda-200', { recambios: 200, agua: { H2O: 30_000_000 } }],
  ['singrasa-400', { recambios: 400, partes: [['madera', 20], ['proteina', 2], ['orgP', 1]] }],
  ['grasa-400', { partes: GRASA, recambios: 400 }],
  ['glicosido-400', { partes: GLIC, recambios: 400 }],
  ['calhierro-400', { suelo: { ...SUELO, CaO: 20_000, CaOH2: 20_000, Fe2O3: 50_000, Fe2: 5000, Fe2O2: 5000, arcilla: 100_000 }, recambios: 400 }],
  ['calhierro-fuego-400', { ...N2P, suelo: { ...SUELO, CaO: 20_000, CaOH2: 20_000, Fe2O3: 50_000, Fe2: 5000, Fe2O2: 5000, arcilla: 100_000 }, recambios: 400, cadaFuego: 4 }],
  ['sincal-400', { suelo: SUELO_SINCAL, recambios: 400 }],
  ['t310-400', { recambios: 400, tAmb: 310 }],
  ['t275-400', { recambios: 400, tAmb: 275 }],
  ['sinherb-400', { recambios: 400, fTubo: 0 }],
  ['mezclado-400', { recambios: 400, fTubo: 0, mezclado: true }],
  ['auditoria-400', { suelo: { SiO2: 1_000_000, arcilla: 100_000, CaCO3: 50_000, CaHPO4: 5000, Fe2O3: 20_000, NH3: 20_000 }, recambios: 400, fTubo: 0, mezclado: true, aire: { N2: 800_000, O2: 200_000, CO2: 400 }, agua: { H2O: 1_000_000 } }, { espera: 'abierto', por: /biomasa mín/, motivo: 'aire con 400 cuantos de CO₂ (0,04 %): la hojarasca pasa por carbón en el suelo (madera → H₂O + C, rápida) y el carbón vuelve a CO₂ despacio (C + O₂, la fila 8 pide k > 10⁻⁴); en estado estacionario el carbón retiene el 24 % del C, el CaCO₃ inicial otro 55 %, y la planta, sin CO₂ libre, baja al 39 %. Igual en la enmienda 2' }],
  ['aire1000-400', { ...AIRE10, recambios: 400 }],
  ['aire10000-400', { ...AIRE100, recambios: 400 }],
  ['fango-400', { recambios: 400, fango: { f: 0.5, g: 0.001, cap: 10, contenido: { H2O: 300_000, SiO2: 1_000_000, N2: 78_000 } } }],
  ['fangosellado-400', { recambios: 400, fango: { f: 0.5, g: 0, cap: 10, contenido: { H2O: 300_000, SiO2: 1_000_000, N2: 78_000 } } }, { espera: 'falla', por: /biomasa mín/, motivo: 'geometría: fango sellado (g = 0), lo que se entierra no vuelve; con g = 0,001 (fango-400) cierra' }],
  ['tubo105-400', { recambios: 400, kTubo: 105 }, contra('κ del tubo 105, el de antes de la enmienda 2')],
  ['fuego1-400', { ...N2P, recambios: 400, cadaFuego: 1 }],
  ['fuegopobre-400', { ...N2P, recambios: 400, cadaFuego: 2, o2Fuego: 0.5 }, { espera: 'cierra' }, PULSO],
  ['semilla2-200', { recambios: 200, semilla: 2 }],
  ['semilla3-200', { recambios: 200, semilla: 3 }],
  ['semilla4-200', { recambios: 200, semilla: 4 }],
  ['semilla5-200', { recambios: 200, semilla: 5 }],
  ['aire10000-3000', { ...AIRE100, recambios: 3000, fotoCada: 10 }],
  ['aire10000-sinherb-1000', { ...AIRE100, recambios: 1000, fotoCada: 2, fTubo: 0 }],
  ['aire10000-sinherb-HH-1000', { ...AIRE100, recambios: 1000, fotoCada: 2, fTubo: 0, rebajaHH: 68 }, REBAJA_HH],
  ['denso-sinherb-600', { recambios: 600, fTubo: 0, capSuelo: 0.1 }],
  ['denso-sinherb-seca-600', { suelo: SUELO, recambios: 600, fTubo: 0, capSuelo: 0.1, agua: {} }],
  ['denso-sinherb-glic-600', { partes: GLIC, recambios: 600, fTubo: 0, capSuelo: 0.1 }, GLIC_DENSO],
  ['denso-sinherb-glic-HH-600', { partes: GLIC, recambios: 600, fTubo: 0, capSuelo: 0.1, rebajaHH: 68 }, REBAJA_HH],
  ['sinherb-glic-400', { partes: GLIC, recambios: 400, fTubo: 0 }],
  ['sinherb-grasa-400', { partes: GRASA, recambios: 400, fTubo: 0 }],
  ['grasaseca-400', { partes: GRASA, suelo: { ...SUELO, H2O: 60_000 }, recambios: 400, agua: {} }],
  ['estricta2-400', { recambios: 400, fosfatos: ['H3PO4', 'CaHPO4'] }, CTRL_P],
  ['estricta-sincal-400', { suelo: SUELO_SINCAL, recambios: 400, fosfatos: ['H3PO4'] }, CTRL_P],
  ['t275-N2-400', { recambios: 400, tAmb: 275, nitrogenos: ['NH3', 'N2'] }],
  ['t275-N2HCN-400', { recambios: 400, tAmb: 275, nitrogenos: ['NH3', 'N2', 'HCN'] }],
  ['estacional-400', { recambios: 400, periodo: 2400, tFrio: 275 }],
  ['estacional-N2-400', { recambios: 400, periodo: 2400, tFrio: 275, nitrogenos: ['NH3', 'N2'] }],
  ['fuegopobre-HCN-400', { recambios: 400, cadaFuego: 2, o2Fuego: 0.5, nitrogenos: ['NH3', 'N2', 'HCN'], fosfatos: ['H3PO4', 'CaHPO4', 'HPO3u', 'P2O5u', 'P2O5g'] }, { espera: 'cierra' }, PULSO],
  ['calhierro-fuego-auto-800', { suelo: { ...SUELO, CaO: 20_000, CaOH2: 20_000, Fe2O3: 50_000, Fe2: 5000, Fe2O2: 5000, arcilla: 100_000 }, recambios: 800, fotoCada: 2, cadaFuego: 4, auto: true, nitrogenos: ['NH3', 'N2'], fosfatos: ['H3PO4', 'CaHPO4'] }],
  ['fuego-sinherb-400', { ...N2P, recambios: 400, fTubo: 0, cadaFuego: 4 }],
  ['t310-sinherb-400', { recambios: 400, fTubo: 0, tAmb: 310 }],
  ['exo-denso-sinherb-600', { recambios: 600, fTubo: 0, capSuelo: 0.1, soloExo: true }, SOLO_EXO],
  ['exo-denso-sinherb-glic-600', { partes: GLIC, recambios: 600, fTubo: 0, capSuelo: 0.1, soloExo: true }, SOLO_EXO],
  ['exo-aire10000-sinherb-1000', { ...AIRE100, recambios: 1000, fotoCada: 2, fTubo: 0, soloExo: true }, SOLO_EXO],
  ['exo-base-400', { recambios: 400, soloExo: true }, SOLO_EXO],
  ['exo-sinherb-grasa-400', { partes: GRASA, recambios: 400, fTubo: 0, soloExo: true }, SOLO_EXO],
  ['exo-fuego-sinherb-400', { ...N2P, recambios: 400, fTubo: 0, soloExo: true, cadaFuego: 4 }, SOLO_EXO],
  ['exo-t275-N2-400', { recambios: 400, tAmb: 275, soloExo: true, nitrogenos: ['NH3', 'N2'] }, SOLO_EXO],
  ['exoHH-aire10000-sinherb-1000', { ...AIRE100, recambios: 1000, fotoCada: 2, fTubo: 0, soloExo: true, rebajaHH: 68 }, REBAJA_HH],
  ['estacional-sincat-400', { recambios: 400, periodo: 2400, tFrio: 275, sinCatFrio: true }, SIN_CAT_FRIO],
  ['estacional-sincat-fuego-400', { ...N2P, recambios: 400, periodo: 2400, tFrio: 275, sinCatFrio: true, cadaFuego: 4 }, SIN_CAT_FRIO],
  ['t283-400', { recambios: 400, tAmb: 283 }],
  ['t282-400', { recambios: 400, tAmb: 282.5 }],
  ['est200-400', { recambios: 400, periodo: 200, tFrio: 275 }],
  ['est200-sincat-400', { recambios: 400, periodo: 200, tFrio: 275, sinCatFrio: true }, SIN_CAT_FRIO],
  ['est200-N2-400', { recambios: 400, periodo: 200, tFrio: 275, nitrogenos: ['NH3', 'N2'] }],
  ['est200-sincat-N2-fuego-400', { ...N2P, recambios: 400, periodo: 200, tFrio: 275, sinCatFrio: true, cadaFuego: 4 }, SIN_CAT_FRIO],
  ['est200b-sincat-400', { recambios: 400, periodo: 200, tFrio: 275, sinCatFrio: true }, SIN_CAT_FRIO],
  ['est200b-sincat-N2-fuego-400', { ...N2P, recambios: 400, periodo: 200, tFrio: 275, sinCatFrio: true, cadaFuego: 4 }, SIN_CAT_FRIO],
  // Reproducción de la validación con la configuración por defecto (40 y 400 recambios, con fuego y sin herbívoro).
  ['repro40', { recambios: 40 }],
  ['repro40f', { recambios: 40, cadaFuego: 4 }, { espera: 'falla', por: /N fijado/, motivo: 'la configuración por defecto con fuego cada 4 recambios: el hallazgo 2 ya a los 40 recambios (N fijado a N₂, P a O₅P₂)' }],
  ['VAR-base-400', { recambios: 400 }],
  ['VAR-sinherb-400', { recambios: 400, fTubo: 0 }],
];

/** Una caja en este proceso: imprime «CAJA <json>» con su medida y el reparto final de C, N y P (las 6 mayores). */
async function unaCaja(cfgJson: string): Promise<void> {
  const { cajaParam, medirCaja } = await import('../tests/lib/caja-param.js');
  const { exigeH2Estable = true, h2Pulso = false, ...cfg } = JSON.parse(cfgJson) as Record<string, unknown> & OpcionesMedida;
  const r = await cajaParam(cfg);
  const medida = medirCaja(r, { exigeH2Estable, h2Pulso });
  const fin = r.fotos[r.fotos.length - 1]!;
  const reparto: Record<string, string> = {};
  for (const [e, s] of [[1, 'C'], [2, 'N'], [4, 'P'], [0, 'H']] as const) {
    const xs = Object.entries(fin.tot).map(([k, v]) => [k, v * (r.atomos[k]?.[e] ?? 0)] as const).filter(([, v]) => v > 0);
    const tot = xs.reduce((a, [, v]) => a + v, 0);
    reparto[s] = xs.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(100 * v / tot).toFixed(1)}%`).join(', ');
  }
  const fuegos = r.fuegos.length ? { n: r.fuegos.length, tMax: Math.round(Math.max(...r.fuegos.map(g => g.tMax))) } : null;
  console.log(`CAJA ${JSON.stringify({ medida, reparto, fuegos, plantillas: r.plantillas.map(p => p.hechas) })}`);
}

/** La batería en procesos hijos (`--paralelo N`, 8 por defecto), filtrada por `--cajas=<regex>`. */
async function bateria(filtro: RegExp, paralelo: number, salida: string | undefined): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  const guion = fileURLToPath(import.meta.url);
  // Las largas primero, para que la pared sea la de la más larga y no la suma de las últimas.
  const cola = BATERIA_CAJAS.filter(([n]) => filtro.test(n)).sort((a, b) => Number(b[1].recambios ?? 40) - Number(a[1].recambios ?? 40));
  const resultados: { nombre: string; espera: Espera; ok: boolean; datos?: { medida: import('../tests/lib/caja-param.js').MedidaCaja; reparto: Record<string, string>; fuegos: unknown }; error?: string }[] = [];
  const inicio = performance.now();
  console.log(`\n=== BATERÍA DE CAJAS (${cola.length} de ${BATERIA_CAJAS.length}, ${paralelo} en paralelo) ===`);
  const correr = ([nombre, cfg, espera = { espera: 'cierra' }, op = {}]: CajaBateria) => new Promise<void>((resolver) => {
    const hijo = spawn(tsx, [guion, '--una-caja', JSON.stringify({ nombre, ...cfg, ...op })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    hijo.stdout.on('data', (d: Buffer) => { out += d; });
    hijo.stderr.on('data', (d: Buffer) => { err += d; });
    hijo.on('close', (codigo) => {
      const linea = out.split('\n').find(l => l.startsWith('CAJA '));
      if (!linea) {
        resultados.push({ nombre, espera, ok: false, error: `salida ${codigo}: ${err.trim().split('\n').slice(-3).join(' | ')}` });
      } else {
        const datos = JSON.parse(linea.slice(5)) as NonNullable<(typeof resultados)[number]['datos']>;
        const fallos = datos.medida.fallos;
        const ok = espera.espera === 'cierra' ? fallos.length === 0
          : espera.espera === 'informa' ? true : fallos.some(f => espera.por.test(f));
        resultados.push({ nombre, espera, ok, datos });
      }
      const r = resultados[resultados.length - 1]!, m = r.datos?.medida;
      const etiqueta = !r.ok ? 'MAL ' : ({ cierra: 'OK  ', falla: 'CTRL', abierto: 'ABTO', informa: 'INFO' } as const)[r.espera.espera];
      console.log(m
        ? `  [${etiqueta}] ${nombre}: ${m.estado}, ${m.recambios} recambios, ${m.ticks} ticks, ${(m.ms / 1000).toFixed(0)} s; agua mín ${(100 * m.aguaMin).toFixed(1)} % (bruta ${(100 * m.aguaMinBruta).toFixed(1)}); H₂ ${(100 * m.h2Final).toFixed(4)} % (máx ${(100 * m.h2Max).toFixed(4)}${m.h2Sube ? ', sube' : ''}); HCN ${(100 * m.hcnFinal).toFixed(2)} % del C (máx ${(100 * m.hcnMax).toFixed(2)}${m.hcnSube ? ', sube' : ''}); N fijado ×${m.nFijado.toFixed(3)}; P accesible ${(100 * m.pAccesible).toFixed(1)} %; biomasa ${m.biomasa.join(' → ')} (mín ${(100 * m.biomasaMin).toFixed(0)} %)${m.fallos.length ? `; fallos: ${m.fallos.join('; ')}` : ''}${r.espera.espera !== 'cierra' ? ` [${r.espera.espera}: ${r.espera.motivo}]` : ''}`
        : `  [MAL ] ${nombre}: ${r.error}`);
      resolver();
    });
  });
  const pendientes = [...cola];
  await Promise.all(Array.from({ length: Math.min(paralelo, pendientes.length) }, async () => {
    for (let x = pendientes.shift(); x; x = pendientes.shift()) await correr(x);
  }));
  const mal = resultados.filter(r => !r.ok);
  const recambios = resultados.reduce((s, r) => s + (r.datos?.medida.recambios ?? 0), 0);
  const ticks = resultados.reduce((s, r) => s + (r.datos?.medida.ticks ?? 0), 0);
  const cuenta = (e: Espera['espera']) => resultados.filter(r => r.ok && r.espera.espera === e).length;
  console.log(`  ${resultados.length - mal.length} de ${resultados.length} como se esperaba: ${cuenta('cierra')} cierran, ${cuenta('falla')} controles, ${cuenta('abierto')} defectos abiertos, ${cuenta('informa')} contrafactuales (${recambios} recambios, ${ticks} ticks, ${((performance.now() - inicio) / 1000).toFixed(0)} s de pared)${mal.length ? `; MAL: ${mal.map(r => r.nombre).join(', ')}` : ''}`);
  for (const r of resultados) if (r.ok && 'motivo' in r.espera && r.espera.espera === 'abierto') console.log(`  abierto ${r.nombre}: ${r.espera.motivo}`);
  if (salida) writeFileSync(salida, JSON.stringify(resultados.map(r => ({ ...r, espera: { ...r.espera, por: 'por' in r.espera ? String(r.espera.por) : undefined } })), null, 1));
  return mal.length === 0;
}

// Ejecución CLI cuando se invoca directamente.
const esCli = process.argv[1]?.endsWith('lab-materia.mts') || process.argv[1]?.endsWith('lab-materia.js');
// Sin await de nivel superior: la caja (tests/lib) importa este módulo y esperaría a que acabe de evaluarse.
if (esCli) void cli().catch((e: unknown) => { console.error(e); process.exit(1); });

async function cli(): Promise<void> {
  const arg = (nombre: string) => { const i = process.argv.findIndex(a => a === nombre || a.startsWith(`${nombre}=`)); if (i < 0) return undefined; const a = process.argv[i]!; return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (process.argv[i + 1] ?? ''); };
  const unaCfg = arg('--una-caja');
  if (unaCfg !== undefined) { await unaCaja(unaCfg); return; }
  const filtroCajas = process.argv.some(a => a === '--cajas' || a.startsWith('--cajas=')) ? new RegExp(process.argv.find(a => a.startsWith('--cajas='))?.slice(8) || '.') : null;
  if (filtroCajas) {
    const ok = await bateria(filtroCajas, Number(arg('--paralelo') ?? 8) || 8, arg('--salida'));
    if (!ok) process.exit(1);
    return;
  }
  const comoJson = process.argv.includes('--json');
  const soloBanco = process.argv.includes('--solo-banco');
  const { cordura, violacionesI4, servicio } = soloBanco
    ? { cordura: [], violacionesI4: [], servicio: crearServicioQuimico({ modo: 'inmediato' }) }
    : ejecutarTablaCordura();
  const banco = ejecutarBancoRendimiento();
  // La caja usa la memoria de prueba de M1 (tests/lib): se importa solo aquí, al ejecutar el laboratorio.
  const cajas = soloBanco || process.argv.includes('--sin-caja') ? [] : await (async () => {
    const { cajaCerrada } = await import('../tests/lib/caja-cerrada.js');
    const aire = { N2: 780_000_000, O2: 210_000_000, CO2: 20_000_000 };
    // Con 100 veces más aire por poro el H₂ tarda más de 40 recambios en llegar a su meseta (~0,06 % del H a 1.000): ahí
    // no se exige que esté estable, solo que no pase del 0,2 % del H (antes de la enmienda 2 llegaba al 2,6 % en 10).
    return [
      ['sin fuego', cajaCerrada({ recambios: 40 }), true],
      ['fuego cada 4 recambios (30 %), plantas con N₂ y P₂O₅ gas', cajaCerrada({ recambios: 40, cadaFuego: 4, nitrogenos: ['NH3', 'N2'], fosfatoGas: true }), true],
      ['aire ×100 por poro, sin herbívoro', cajaCerrada({ recambios: 40, aire, capAire: 10_000, fTubo: 0 }), false],
      ['suelo a 275 K', cajaCerrada({ recambios: 40, tAmbiente: 275 }), true],
    ] as const;
  })();
  const resumenCaja = cajas.map(([nombre, r, exigeEstable]) => {
    const f = r.fotos, fin = f[f.length - 1]!, h2 = (a: number, b: number) => {
      const xs = f.filter(x => x.recambio >= a && x.recambio <= b).map(x => x.h2);
      return xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    };
    const exacto = f.every(x => x.exacto), aguaMin = Math.min(...f.map(x => x.agua)) / f[0]!.agua;
    const biomasaMin = Math.min(...f.filter(x => x.recambio >= 31).map(x => x.biomasa)) / Math.max(...f.map(x => x.biomasa));
    const estable = h2(31, 40) <= 1.15 * h2(21, 30);
    let nQuemado = 0, nN2 = 0;
    const pDestino: Record<string, number> = {};
    for (const g of r.fuegos) {
      const suma = (x: Record<string, number>) => Object.values(x).reduce((s, v) => s + v, 0);
      const nAire = suma(g.nDespues) - suma(g.nAntes);
      nQuemado += suma(g.nAntes) - (g.nAntes.N2 ?? 0);
      nN2 += (g.nDespues.N2 ?? 0) - nAire - (g.nAntes.N2 ?? 0);
      for (const [k, v] of Object.entries(g.pDespues)) pDestino[k] = (pDestino[k] ?? 0) + v;
    }
    return { nombre, recambios: fin.recambio, ticks: r.ticks, ms: Math.round(r.ms), exacto, aguaMin, h2Final: fin.h2,
      h2PorcientoH: 100 * fin.hH2 / fin.hTotal, h2Estable: estable, fuegos: r.fuegos.length, nQuemado, nN2, pDestino,
      nFinal: fin.n, pFinal: fin.p, biomasa: [f.find(x => x.recambio === 0)!.biomasa, fin.biomasa], flujosH2: Object.fromEntries(Object.entries(r.flujos).map(([k, v]) => [k, v.H2])),
      biomasaMin, ok: exacto && aguaMin >= 0.97 && (exigeEstable ? estable : f.every(x => x.hH2 < 0.002 * x.hTotal))
        && fin.hH2 < 0.005 * fin.hTotal && biomasaMin >= 0.5 };
  });

  const todoOk = cordura.every(c => c.cumple) && violacionesI4.length === 0 && banco.cumpleP99Frio && banco.cumpleP99Caliente
    && resumenCaja.every(c => c.ok);

  if (comoJson) {
    console.log(JSON.stringify({
      ok: todoOk,
      constantesRed: { E_RES_IONICO, E_HID_IONICO, E_CAT_IONICO },
      cordura,
      violacionesI4: violacionesI4.length,
      sustanciasInternadas: servicio.totalSustancias(),
      filasMemo: servicio.totalMemo(),
      banco,
      cajaCerrada: resumenCaja,
    }, null, 2));
  } else {
    console.log(`=== LABORATORIO DE MATERIA V23 (E_RES=${E_RES_IONICO}, E_HID=${E_HID_IONICO}, E_CAT=${E_CAT_IONICO}) ===`);
    if (!soloBanco) {
      for (const c of cordura) {
        console.log(`  [${c.cumple ? 'OK  ' : 'FAIL'}] ${c.nombre}\n         ${c.detalle}`);
      }
      console.log(`\n  I4: ${violacionesI4.length} violaciones (${servicio.totalSustancias()} sustancias, ${servicio.totalMemo()} filas de memo)`);
      if (violacionesI4.length > 0) console.log(violacionesI4.slice(0, 5));
      console.log('\n  Sustancias base:');
      for (let id = 1; id <= Math.min(12, servicio.totalSustancias()); id++) {
        const s = servicio.sustancia(id);
        console.log(`    #${String(s.id).padStart(2)} ${formula(s).padEnd(8)} ${s.clase === ClaseSustancia.Molecula ? 'MOL' : 'UNI'} E=${String(s.energia).padStart(6)} r=${s.prop.r.toFixed(2)} Tf=${s.prop.tFusion.toFixed(0).padStart(4)}K Teb=${s.prop.tEbullicion.toFixed(0).padStart(4)}K dur=${s.prop.dureza.toFixed(3)} ten=${s.prop.tenacidad.toFixed(2)} dens=${s.prop.densidad.toFixed(2)} ${describirEnlaces(s.enlaces)}`);
      }
    }
    console.log(`\n=== BANCO DE RENDIMIENTO (${banco.muestras} parejas, hasta ${banco.maxAtomos} átomos) ===`);
    console.log(`  FRÍO     : p50=${banco.frioMs.p50.toFixed(2)} ms | p95=${banco.frioMs.p95.toFixed(2)} ms | p99=${banco.frioMs.p99.toFixed(2)} ms | max=${banco.frioMs.max.toFixed(2)} ms [${banco.cumpleP99Frio ? 'OK < 50ms' : 'FAIL'}]`);
    console.log(`  CALIENTE : p50=${(banco.calienteMs.p50 * 1000).toFixed(1)} µs | p95=${(banco.calienteMs.p95 * 1000).toFixed(1)} µs | p99=${(banco.calienteMs.p99 * 1000).toFixed(1)} µs | max=${(banco.calienteMs.max * 1000).toFixed(1)} µs [${banco.cumpleP99Caliente ? 'OK' : 'FAIL'}]`);
    console.log(`  Nivel 10 (horno) = ${tDeNivel(10).toFixed(1)} K; Nivel 9 (llama aire) = ${tDeNivel(9).toFixed(1)} K`);
    if (resumenCaja.length) console.log('\n=== CAJA CERRADA (40 recambios; aire, agua, suelo [KAPPA_SUELO ×3, KAPPA_SUELO_HH], planta, tubo KAPPA0, quemar) ===');
    for (const c of resumenCaja) {
      console.log(`  [${c.ok ? 'OK  ' : 'FAIL'}] ${c.nombre}: ${c.recambios} recambios en ${c.ticks} ticks (${c.ms} ms); balance ${c.exacto ? 'exacto' : 'DESCUADRE'}; agua mín ${(100 * c.aguaMin).toFixed(1)} %; H₂ ${c.h2Final} (${c.h2PorcientoH.toFixed(3)} % del H, ${c.h2Estable ? 'estable' : 'aún sube'}); biomasa ${c.biomasa.join(' → ')} (mín. de los recambios 31–40: ${(100 * c.biomasaMin).toFixed(0)} % del máximo)`);
      console.log(`         H₂ neto por proceso: ${JSON.stringify(c.flujosH2)}`);
      if (c.fuegos) console.log(`         ${c.fuegos} fuegos: N fijado quemado ${c.nQuemado}, a N₂ ${c.nN2}; P quemado → ${JSON.stringify(c.pDestino)}`);
      console.log(`         N final ${JSON.stringify(c.nFinal)}; P final ${JSON.stringify(c.pFinal)}`);
    }
  }
  await servicio.cerrar();
  if (!todoOk) process.exit(1);
}
