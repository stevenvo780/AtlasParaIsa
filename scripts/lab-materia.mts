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
 *  6. Caja cerrada (enmienda 1): 40 recambios de biomasa con piezas reales (arena, química, pasoLote, fluir, copiar,
 *     desprender, quemar; tests/lib/caja-cerrada.ts), sin y con fuego: agua, H₂, balance exacto y destino de N y P.
 *
 * Uso: npx tsx scripts/lab-materia.mts [--json] [--solo-banco] [--sin-caja]
 */
import { performance } from 'node:perf_hooks';
import {
  CAPACIDAD_ATOMO, E_CAT_IONICO, E_HID_IONICO, E_RES_IONICO, ELEMENTOS, KAPPA0, KAPPA_SUELO, NE, NU, R,
} from '../src/shared/naturaleza.js';
import { ClaseSustancia, TIPOS, type SustanciaId } from '../src/shared/materia.js';
import { nivelDeT, tDeNivel, type Reaccion, type Sustancia } from '../src/world/materia/tipos.js';
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

/** Tasa de Arrhenius de ARQ-materia §3.1 con la enmienda 1, k(T) = ν·exp(−max(0, ea − κ, dH)/(R·T)), en 1/tick o
 * L/(cuanto·tick) por vez de reacción: la catálisis nunca baja la barrera de una endotérmica por debajo de su dH. */
export function tasaArrhenius(
  T: number,
  r: Pick<Reaccion, 'ea' | 'catalisis' | 'dH'>,
  kappa: readonly [number, number, number] | number = 0,
): number {
  const kEff = r.catalisis === -1 ? 0 : typeof kappa === 'number' ? kappa : kappa[r.catalisis]!;
  return NU * Math.exp(-Math.max(0, r.ea - kEff, r.dH) / (R * T));
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

  // 7. Hierro: se reduce en horno (≥ 1.131 K, nivel 10) y NO en fogata (800 K); Fe₂O₂ + C → Fe₂ puro en horno alto.
  const rFeFogata = reac(S.Fe2O3, S.C, lvlFogata);
  const rFeLlamaAire = reac(S.Fe2O3, S.C, lvlLlama);
  const rFeHorno = reac(S.Fe2O3, S.C, lvlHorno);
  const rFe2Puro = reac(S.Fe2O2, S.C, lvlHornoAlto);
  const rFeOxida = reac(S.Fe2, S.O2, lvlAmb);
  const sFe = serv.sustancia(S.Fe2);
  const okFe = rFeFogata === null && rFeLlamaAire === null && rFeHorno !== null
    && rFeHorno.salidas.some(p => p.id === S.CO2) && rFeHorno.salidas.some(p => p.id === S.Fe2O)
    && rFe2Puro !== null && rFe2Puro.salidas.some(p => p.id === S.Fe2) && rFe2Puro.salidas.some(p => p.id === S.CO2)
    && rFeOxida !== null && rFeOxida.dH < -300
    && sFe.prop.dureza > sSil.prop.dureza && sFe.prop.tenacidad > sSil.prop.tenacidad;
  cordura.push({
    nombre: 'Hierro: reduce en horno (no fogata/llama abierta), oxida en frío',
    cumple: okFe,
    detalle: `Fe₂O₃+C @800K=${describirReaccion(serv, rFeFogata)}; @1250K=${describirReaccion(serv, rFeHorno)}; Fe₂O₂+C@1500K=${describirReaccion(serv, rFe2Puro)}; dureza Fe=${sFe.prop.dureza.toFixed(3)} > SiO₂=${sSil.prop.dureza.toFixed(3)}`,
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
  const rSilEstable = reac(S.SiO2, S.SiO2, lvlHornoAlto);
  const rCarEstable = reac(S.C, S.C, lvlHornoAlto);
  const okCiclo = rMetO2 !== null && rMetO2.salidas.some(p => p.id === S.CO2) && rMetO2.dH < -150
    && rProtSuelo !== null && rProtSuelo.salidas.some(p => p.id === S.NH3) && kProtSuelo > 1
    && rOrgPSuelo !== null && kOrgPSuelo > 1e-3 && kCSuelo > 1e-4 && kNH3Suelo < 1e-15
    && rSilEstable === null && rCarEstable === null;
  cordura.push({
    nombre: 'CH₄+O₂, retorno de N/P en suelo (NH₃ preservado) y roca/C estables',
    cumple: okCiclo,
    detalle: `CH₄+O₂=${describirReaccion(serv, rMetO2)}; prot=${describirReaccion(serv, rProtSuelo)}; orgP=${describirReaccion(serv, rOrgPSuelo)}; k_C+O2=${kCSuelo.toExponential(2)}, k_NH3+O2=${kNH3Suelo.toExponential(1)}`,
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

// Ejecución CLI cuando se invoca directamente.
const esCli = process.argv[1]?.endsWith('lab-materia.mts') || process.argv[1]?.endsWith('lab-materia.js');
// Sin await de nivel superior: la caja (tests/lib) importa este módulo y esperaría a que acabe de evaluarse.
if (esCli) void cli().catch((e: unknown) => { console.error(e); process.exit(1); });

async function cli(): Promise<void> {
  const comoJson = process.argv.includes('--json');
  const soloBanco = process.argv.includes('--solo-banco');
  const { cordura, violacionesI4, servicio } = soloBanco
    ? { cordura: [], violacionesI4: [], servicio: crearServicioQuimico({ modo: 'inmediato' }) }
    : ejecutarTablaCordura();
  const banco = ejecutarBancoRendimiento();
  // La caja usa la memoria de prueba de M1 (tests/lib): se importa solo aquí, al ejecutar el laboratorio.
  const cajas = soloBanco || process.argv.includes('--sin-caja') ? [] : await (async () => {
    const { cajaCerrada } = await import('../tests/lib/caja-cerrada.js');
    return [['sin fuego', cajaCerrada({ recambios: 40 })], ['fuego cada 4 recambios (30 %)', cajaCerrada({ recambios: 40, cadaFuego: 4 })]] as const;
  })();
  const resumenCaja = cajas.map(([nombre, r]) => {
    const f = r.fotos, fin = f[f.length - 1]!, h2 = (a: number, b: number) => {
      const xs = f.filter(x => x.recambio >= a && x.recambio <= b).map(x => x.h2);
      return xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    };
    const exacto = f.every(x => x.exacto), aguaMin = Math.min(...f.map(x => x.agua)) / f[0]!.agua;
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
      ok: exacto && aguaMin >= 0.97 && estable && fin.hH2 < 0.005 * fin.hTotal };
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
    if (resumenCaja.length) console.log('\n=== CAJA CERRADA (40 recambios; aire, agua, suelo KAPPA_SUELO, planta, tubo KAPPA0, quemar) ===');
    for (const c of resumenCaja) {
      console.log(`  [${c.ok ? 'OK  ' : 'FAIL'}] ${c.nombre}: ${c.recambios} recambios en ${c.ticks} ticks (${c.ms} ms); balance ${c.exacto ? 'exacto' : 'DESCUADRE'}; agua mín ${(100 * c.aguaMin).toFixed(1)} %; H₂ ${c.h2Final} (${c.h2PorcientoH.toFixed(3)} % del H, ${c.h2Estable ? 'estable' : 'CRECE'}); biomasa ${c.biomasa.join(' → ')}`);
      console.log(`         H₂ neto por proceso: ${JSON.stringify(c.flujosH2)}`);
      if (c.fuegos) console.log(`         ${c.fuegos} fuegos: N fijado quemado ${c.nQuemado}, a N₂ ${c.nN2}; P quemado → ${JSON.stringify(c.pDestino)}`);
      console.log(`         N final ${JSON.stringify(c.nFinal)}; P final ${JSON.stringify(c.pFinal)}`);
    }
  }
  await servicio.cerrar();
  if (!todoOk) process.exit(1);
}
