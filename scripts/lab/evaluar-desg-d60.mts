/**
 * Evaluador del panel DESG-D60 — seguridad consciente del caos + mecanismo P1–P3.
 * Implementa EXACTAMENTE datos-lab/desg-d60/PRERREGISTRO.md con el método
 * datos-lab/METODO-SEGURIDAD-CAOS-20261001.md §3.
 *
 * Escrito y probado con datos SINTÉTICOS antes de ver ningún dato real (sha256 en
 * bitácora datos-lab/desg-d60/BITACORA.md). Independiente del motor en P1:
 * reimplementa f(ancla,N,R) con las constantes preregistradas (oráculo externo).
 *
 * Entrada: --dir datos-lab/desg-d60/ con CTRL-/PLAC-/TRT-18101..18112, cada uno con
 * dia-001..060.json (claves vecinosMortales, desgD, muertesPorCausa...), replica.json
 * (params exactos, sha del laboratorio, clave placebo SOLO en PLAC) y material.json.
 *
 * Decisiones operativas fijadas ANTES de datos (también en bitácora):
 * - Media recortada «al 20 %»: k = max(1, round(n/10)) por cola (≈20 % total; con
 *   n=8 quita la mayor y la menor, como el ejemplo del método), acotado a (n-1)/2.
 * - Permutación exacta 6^n si n ≤ 7; si no Monte Carlo con 20000 muestras y semilla
 *   fija 0xD60C1A (determinista). p con corrección +1 en Monte Carlo; exacta sin ella.
 * - Cota inferior 95 % por inversión: inf{δ0 : p_cola-superior(δ0) ≥ 0,05} por bisección
 *   (60 iteraciones, nulos precomputados una vez). NOTA: la prosa del método («el mayor
 *   δ0 tal que ... p ≥ 0,05») diverge a +∞; se implementa la cota inferior estándar por
 *   inversión del test (frontera donde el test de cola superior deja de rechazar).
 * - Tasa exp+sed por 100 días-persona (días 30–60) en escala NATURAL (no log): daño =
 *   tasa mayor en T, test de cola derecha con α = 0,025, sin cláusula de cociente (las
 *   tasas cercanas a cero la hacen inestable). Dirección preregistrada: ↑ = daño.
 * - Extinción (mortal): desgD.mortales == 0 el día final (misma definición que en D20).
 * - P1: 0 desajustes + exposición ≥ n/2 semillas con ≥10 obras × ≥5 días (n=12 → 6;
 *   generaliza el 4/8 de D20). P2/P3: sostiene ≥ ceil(3n/4) (12→9, 8→6: reproduce
 *   ambos preregistros), inerte ≤ n/2 (12→6, 8→4), resto inconcluso. P2/P3 deciden al
 *   día 60; el día 20 es descriptivo. PLAC debe tener 0 activaciones (es un control).
 * - dp = Σ vecinosMortales (literal del método); coherencia diaria exigida con
 *   desgD.mortales (iguales en D20). Nacimientos: log(acumulado); cupo = params
 *   poblacion.nacimientosPorComprobacion × 20/día; día saturado ⟺ nac/día ≥ cupo.
 * - Métrica indefinida en una semilla (dp/nac = 0, dpVent = 0): se excluye la semilla
 *   de ESA prueba (se anota); con <6 semillas útiles la prueba es INCOMPUTABLE y no
 *   decide (la seguridad cae a INCONCLUSA, nunca a DAÑO por esta vía).
 * - Primera divergencia: primer día cuyo digesto (sha256 del JSON canónico del diario
 *   excluyendo p50Ms/p95Ms/rss a cualquier profundidad y desgD.{ley,N,R}, huella de
 *   identidad de la ley —sin esto divT sería trivialmente 1—) difiere del de CTRL.
 * - K1 (banco aparte, bench-desg-d.mts protocolo fino 30×20): cumplida ⟺ p95 < 50 ms,
 *   reactivación < 2× y mediana T/C ≤ 1,05 (6/6 semillas del banco). Se aporta con
 *   --k1=CUMPLIDA|INCUMPLIDA (por defecto PENDIENTE: la decisión lo dice).
 * - C1–C7 (criterio-terminado.mts congelado, descriptivo) NO está en este evaluador: se
 *   corre aparte sobre el panel con --dia 60 y se informa en el veredicto.
 *
 * Uso: tsx evaluar-desg-d60.mts --dir <panel> --sha <lab-sha> [--k1 ...] [--json out]
 *      tsx evaluar-desg-d60.mts --self-test
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SEMILLAS = [18101, 18102, 18103, 18104, 18105, 18106, 18107, 18108, 18109, 18110, 18111, 18112];
export const DIAS = 60;
const TICKS_DIA = 2400, Q = 3_000_000_000;
const MC_MUESTRAS = 20000, MC_SEMILLA = 0xd60c1a;
const ALFA = 0.05, ALFA_SEC = 0.025, MIN_SEMILLAS = 6;
const T0_PLACEBO = 2 * TICKS_DIA + 7;

// ── Oráculo P1 (literal de evaluar-desg-d.mts) ──
function tasas(dur: number): { aD: number; aR: number } {
  return dur >= 1.5 ? { aD: 360_000, aR: 560_000 } : { aD: 540_000, aR: 840_000 };
}
function fq(q0: number, n0: number, r0: number, N: number, R: number, dur: number): number {
  const { aD, aR } = tasas(dur);
  const dR = R - r0, dD = (N - n0) - dR;
  return Math.max(0, q0 - aD * dD - aR * dR);
}
function durabilidad(components: readonly string[]): number {
  return 1 + (components.filter(c => c === 'frame').length - 1) * 0.5;
}

// ── Estadística pura ──
/** Media recortada ≈20 % total: k = max(1, round(n/10)) por cola, acotado a (n-1)/2. */
export function mediaRecortada(xs: readonly number[]): number {
  const n = xs.length;
  if (!n) throw new Error('mediaRecortada sin datos');
  const k = Math.min(Math.max(1, Math.round(n / 10)), Math.floor((n - 1) / 2));
  const m = [...xs].sort((a, b) => a - b).slice(k, n - k);
  return m.reduce((a, b) => a + b, 0) / m.length;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PruebaPerm = { dObs: number; efecto: number; n: number; pIzq: number; pDer: number;
  nulos: number[]; metodo: 'exacta' | 'mc' };

/**
 * Aleatorización intra-semilla de 3 etiquetas sobre d = yT − (yC+yP)/2 con media
 * recortada. Exacta (6^n) si n ≤ 7; si no Monte Carlo (semilla fija, p con +1).
 */
export function pruebaPermutacion3(vals: readonly (readonly [number, number, number])[],
  mcMuestras = MC_MUESTRAS, mcSemilla = MC_SEMILLA): PruebaPerm {
  const n = vals.length;
  const dObs = mediaRecortada(vals.map(v => v[1] - (v[0] + v[2]) / 2));
  const nulos: number[] = [];
  if (n <= 7) {
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const total = 6 ** n, ds = new Array<number>(n);
    for (let c = 0; c < total; c++) {
      let q = c;
      for (let i = 0; i < n; i++) {
        const p = perms[q % 6]!, v = vals[i]!;
        q = Math.floor(q / 6);
        ds[i] = v[p[1]!]! - (v[p[0]!]! + v[p[2]!]!) / 2;
      }
      nulos.push(mediaRecortada(ds));
    }
    return { dObs, efecto: Math.exp(dObs), n,
      pIzq: nulos.filter(x => x <= dObs).length / total,
      pDer: nulos.filter(x => x >= dObs).length / total, nulos, metodo: 'exacta' };
  }
  const rng = mulberry32(mcSemilla);
  for (let m = 0; m < mcMuestras; m++) {
    const ds = vals.map(v => {
      const p = [v[0], v[1], v[2]];
      for (let i = 2; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = p[i]!; p[i] = p[j]!; p[j] = t;
      }
      return p[1]! - (p[0]! + p[2]!) / 2;
    });
    nulos.push(mediaRecortada(ds));
  }
  return { dObs, efecto: Math.exp(dObs), n,
    pIzq: (nulos.filter(x => x <= dObs).length + 1) / (mcMuestras + 1),
    pDer: (nulos.filter(x => x >= dObs).length + 1) / (mcMuestras + 1), nulos, metodo: 'mc' };
}

/** Aleatorización por signo exacta (2^n) sobre diferencias, para la validez P–C. */
export function pruebaSigno(difs: readonly number[]): { dObs: number; efecto: number; n: number; pIzq: number } {
  const n = difs.length, total = 2 ** n, nulos: number[] = [];
  for (let c = 0; c < total; c++)
    nulos.push(mediaRecortada(difs.map((x, i) => ((c >> i) & 1 ? -x : x))));
  const dObs = mediaRecortada(difs);
  return { dObs, efecto: Math.exp(dObs), n, pIzq: nulos.filter(x => x <= dObs).length / total };
}

/**
 * Cota inferior unilateral 95 % de δ por inversión: inf{δ0 : p_sup(δ0) ≥ 0,05},
 * donde p_sup usa los nulos precomputados (D′(δ0) = dObs − δ0: la media recortada
 * conmuta con el desplazamiento porque este preserva el orden). Bisección.
 */
export function cotaInferior(nulos: readonly number[], dObs: number, alfa = ALFA, mc = true): number {
  const m = nulos.length;
  const pSup = (d0: number): number => {
    const prima = dObs - d0;
    const c = nulos.filter(x => x >= prima).length;
    return mc ? (c + 1) / (m + 1) : c / m;
  };
  let lo = -10, hi = 10;
  if (!(pSup(lo) < alfa && pSup(hi) >= alfa)) throw new Error('cotaInferior sin horquilla');
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (pSup(mid) >= alfa) hi = mid; else lo = mid;
  }
  return hi;
}

/** Cola superior exacta P(Bin(n,p) ≥ k). */
export function colaBinomial(n: number, k: number, p = 1 / 3): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const comb = (N: number, K: number): number => {
    let r = 1;
    for (let i = 1; i <= K; i++) r = (r * (N - K + i)) / i;
    return r;
  };
  let s = 0;
  for (let i = k; i <= n; i++) s += comb(n, i) * p ** i * (1 - p) ** (n - i);
  return s;
}

/** Desviación robusta (MAD × 1,4826) para la biblioteca de nulas. */
export function sdRobusta(xs: readonly number[]): number {
  const m = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const mad = [...xs].map(x => Math.abs(x - m)).sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  return 1.4826 * mad;
}

// ── Digesto de diario (primera divergencia) ──
const CLAVES_RELOJ = new Set(['p50Ms', 'p95Ms', 'rss']);
function estable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(estable);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).filter(([k]) => !CLAVES_RELOJ.has(k))
      .sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, estable(x)]));
  return v;
}
export function digestDia(dia: unknown): string {
  // La huella de IDENTIDAD de la ley (desgD.ley/N/R: N/R son null con ley 0) no es
  // divergencia de trayectoria: sin excluirla, divT sería trivialmente 1.
  const copia = JSON.parse(JSON.stringify(dia)) as Record<string, Record<string, unknown> | unknown>;
  if (copia && typeof copia === 'object' && copia.desgD && typeof copia.desgD === 'object') {
    delete (copia.desgD as Record<string, unknown>).ley;
    delete (copia.desgD as Record<string, unknown>).N;
    delete (copia.desgD as Record<string, unknown>).R;
  }
  return createHash('sha256').update(JSON.stringify(estable(copia))).digest('hex');
}

// ── Lectura ──
type Dia = { tick: number; poblacion: number; nacimientos: number; vecinosMortales: number;
  muertesPorCausa: Record<string, number>;
  desgD: { ley: 0 | 1; mortales: number; obrasConstruidasDia: number; reparacionesDia: number;
    fraccionRotasProyectada: number | null } };
type Replica = { dias: Dia[]; replicaJson: { dias: number; sha: string; placebo?: { t0: number };
  params: Record<string, Record<string, unknown>> };
  material: { observador: { coverage: { endTick: number; observationGaps: unknown[] };
    structures: { id: string; components: string[]; firstObservedTick: number; activeExposureTicks: number;
      repairCount: number; repairWoodPaid: number }[] };
    desg: { activaciones: { structureId: string; tick: number; conditionAlDespertar: number;
      dormidaTicksPrevios: number; N: number; R: number;
      ancla: { q0: number; n0: number; r0: number } | null; proyectada: number | null }[] } } };

function leerReplica(dir: string, dias: number): Replica {
  const diasArr: Dia[] = [];
  for (let d = 1; d <= dias; d++)
    diasArr.push(JSON.parse(readFileSync(join(dir, `dia-${String(d).padStart(3, '0')}.json`), 'utf8')));
  return { dias: diasArr,
    replicaJson: JSON.parse(readFileSync(join(dir, 'replica.json'), 'utf8')),
    material: JSON.parse(readFileSync(join(dir, 'material.json'), 'utf8')) };
}

export type Veredicto = { estado: 'SOSTENIDA' | 'REFUTADA' | 'INCONCLUSA' | 'NO_DECIDE' | 'INCOMPUTABLE'; detalle: string };
export type Seguridad = { estado: 'DAÑO' | 'SEGURO' | 'INCONCLUSO'; detalle: string;
  primaria: Record<string, unknown>; nacimientos: Record<string, unknown>; tasa: Record<string, unknown>;
  extincion: Record<string, unknown>; validez: Record<string, unknown>; descriptivo: Record<string, unknown> };

export function evaluarPanel(cribado: string, semillas: readonly number[], dias: number, labSha: string,
  k1: 'CUMPLIDA' | 'INCUMPLIDA' | 'PENDIENTE'): { pares: unknown[]; p1: Veredicto; p2: Veredicto; p3: Veredicto;
  p2d20: Veredicto; p3d20: Veredicto; seguridad: Seguridad; decision: string } {
  const n = semillas.length;
  const umbralSostiene = Math.ceil((3 * n) / 4), umbralInerte = Math.floor(n / 2);
  type Par = { seed: number; dpC: number; dpT: number; dpP: number; nacC: number; nacT: number; nacP: number;
    satC: number; repC: number; repT: number; consC: number; consT: number; rep20C: number; rep20T: number;
    cons20C: number; cons20T: number; fracC: number | null; fracT: number | null;
    frac20C: number | null; frac20T: number | null; mueC: number; mueT: number; mueP: number;
    dpVC: number; dpVT: number; dpVP: number; extC: boolean; extT: boolean; extP: boolean;
    divT: number | null; divP: number | null; desajustesP1: number; dormidas5: number };
  const pares: Par[] = [];
  for (const seed of semillas) {
    const c = leerReplica(join(cribado, `CTRL-${seed}`), dias);
    const p = leerReplica(join(cribado, `PLAC-${seed}`), dias);
    const t = leerReplica(join(cribado, `TRT-${seed}`), dias);
    // Procedencia: params exactos del preregistro, horizonte completo, sha del laboratorio,
    // ley coherente por brazo y clave placebo SOLO en PLAC con t0 exacto.
    const conf = [[c, 0, 'CTRL', false], [p, 0, 'PLAC', true], [t, 1, 'TRT', false]] as const;
    for (const [r, desg, brazo, esPlac] of conf) {
      const prm = r.replicaJson.params;
      const espera: Record<string, unknown> = { 'social.radioConvivencia': 12, 'social.disolucion': 1,
        'social.maxComunidades': 64, 'limites.comunidades': 64, 'persistencia.cadaTicks': 300,
        'material.desgasteDormido': desg };
      for (const [k, v] of Object.entries(espera)) {
        const [s, h] = k.split('.') as [string, string];
        if (prm[s]?.[h] !== v) throw new Error(`${brazo}-${seed}: param ${k} = ${prm[s]?.[h]}, preregistro ${v}`);
      }
      if (r.replicaJson.dias !== dias || r.dias.length !== dias) throw new Error(`${brazo}-${seed}: incompleta`);
      if (r.replicaJson.sha !== labSha) throw new Error(`${brazo}-${seed}: sha ${r.replicaJson.sha} != lab ${labSha}`);
      if (r.dias.some(d => d.desgD.ley !== desg)) throw new Error(`${brazo}-${seed}: ley mezclada en días`);
      if (esPlac && r.replicaJson.placebo?.t0 !== T0_PLACEBO)
        throw new Error(`PLAC-${seed}: sin parte de patada placebo en t0=${T0_PLACEBO}`);
      if (!esPlac && r.replicaJson.placebo !== undefined)
        throw new Error(`${brazo}-${seed}: clave placebo fuera de PLAC`);
      if (r.material.observador.coverage.observationGaps.length > 0)
        throw new Error(`${brazo}-${seed}: huecos de observación (diseño incumplido)`);
    }
    if (c.material.desg.activaciones.length > 0) throw new Error(`CTRL-${seed}: activaciones DESG-D en control`);
    if (p.material.desg.activaciones.length > 0) throw new Error(`PLAC-${seed}: activaciones DESG-D en placebo`);
    const cupo = Number(c.replicaJson.params.poblacion?.nacimientosPorComprobacion) * (TICKS_DIA / 120);
    if (!Number.isFinite(cupo) || cupo <= 0) throw new Error(`CTRL-${seed}: cupo ilegible en params`);
    const met = (r: Replica) => {
      const nacDia = r.dias.map((d, i) => d.nacimientos - (i ? r.dias[i - 1]!.nacimientos : 0));
      for (const [i, d] of r.dias.entries())
        if (d.vecinosMortales !== d.desgD.mortales)
          throw new Error(`semilla ${seed}: vecinosMortales != desgD.mortales el día ${i + 1}`);
      const v0 = dias >= 30 ? dias - 30 : 0; // ventana de la vía de daño: últimos 30 días
      const mue = (d: Dia): number => (d.muertesPorCausa.exposure ?? 0) + (d.muertesPorCausa.dehydration ?? 0);
      return {
        dp: r.dias.reduce((a, d) => a + d.vecinosMortales, 0),
        dp20: r.dias.slice(0, 20).reduce((a, d) => a + d.vecinosMortales, 0),
        dpV: r.dias.slice(v0).reduce((a, d) => a + d.vecinosMortales, 0),
        nac: r.dias[dias - 1]!.nacimientos,
        sat: nacDia.filter(x => x >= cupo).length,
        rep: r.dias.reduce((a, d) => a + d.desgD.reparacionesDia, 0),
        cons: r.dias.reduce((a, d) => a + d.desgD.obrasConstruidasDia, 0),
        rep20: r.dias.slice(0, 20).reduce((a, d) => a + d.desgD.reparacionesDia, 0),
        cons20: r.dias.slice(0, 20).reduce((a, d) => a + d.desgD.obrasConstruidasDia, 0),
        frac: r.dias[dias - 1]!.desgD.fraccionRotasProyectada,
        frac20: dias >= 20 ? r.dias[19]!.desgD.fraccionRotasProyectada : null,
        mueV: dias >= 30 ? mue(r.dias[dias - 1]!) - mue(r.dias[dias - 31]!) : NaN,
        extinta: r.dias[dias - 1]!.desgD.mortales === 0,
      };
    };
    const mc = met(c), mp = met(p), mt = met(t);
    // P1 por réplica tratada (oráculo externo, igual que D20).
    const durPorId = new Map(t.material.observador.structures.map(s => [s.id, durabilidad(s.components)]));
    let desajustes = 0;
    for (const a of t.material.desg.activaciones) {
      if (a.dormidaTicksPrevios <= 0) continue;
      const dur = durPorId.get(a.structureId);
      const f = a.ancla !== null && dur !== undefined ? fq(a.ancla.q0, a.ancla.n0, a.ancla.r0, a.N, a.R, dur) / Q : NaN;
      if (!(a.conditionAlDespertar === a.proyectada && a.proyectada === f)) desajustes++;
    }
    const fin = t.material.observador.coverage.endTick;
    const dormidas5 = t.material.observador.structures
      .filter(s => (fin - s.firstObservedTick) - s.activeExposureTicks >= 5 * TICKS_DIA).length;
    // Coherencia reparaciones observador vs diario, tres brazos.
    for (const [r, m, brazo] of [[c, mc, 'CTRL'], [p, mp, 'PLAC'], [t, mt, 'TRT']] as const) {
      const repObs = r.material.observador.structures.reduce((a, s) => a + s.repairCount, 0);
      if (repObs !== m.rep) throw new Error(`${brazo}-${seed}: reparaciones observador ${repObs} != diario ${m.rep}`);
    }
    // Primera divergencia de T y P respecto de C (instrumento obligatorio, no decide).
    const digC = c.dias.map(digestDia), digT = t.dias.map(digestDia), digP = p.dias.map(digestDia);
    const div = (dd: string[]): number | null => {
      const i = dd.findIndex((h, j) => h !== digC[j]);
      return i < 0 ? null : i + 1;
    };
    pares.push({ seed, dpC: mc.dp, dpT: mt.dp, dpP: mp.dp, nacC: mc.nac, nacT: mt.nac, nacP: mp.nac,
      satC: mc.sat, repC: mc.rep, repT: mt.rep, consC: mc.cons, consT: mt.cons,
      rep20C: mc.rep20, rep20T: mt.rep20, cons20C: mc.cons20, cons20T: mt.cons20,
      fracC: mc.frac, fracT: mt.frac, frac20C: mc.frac20, frac20T: mt.frac20,
      mueC: mc.mueV, mueT: mt.mueV, mueP: mp.mueV, dpVC: mc.dpV, dpVT: mt.dpV, dpVP: mp.dpV,
      extC: mc.extinta, extT: mt.extinta, extP: mp.extinta, divT: div(digT), divP: div(digP),
      desajustesP1: desajustes, dormidas5 });
  }
  // ── Mecanismo P1–P3 ──
  const desTot = pares.reduce((a, p) => a + p.desajustesP1, 0);
  const expSuf = pares.filter(p => p.dormidas5 >= 10).length;
  const p1: Veredicto = desTot > 0 ? { estado: 'REFUTADA', detalle: `${desTot} desajustes q != f(ancla)` }
    : expSuf < Math.ceil(n / 2) ? { estado: 'INCONCLUSA', detalle: `exposición: ${expSuf}/${n} con ≥10 obras × ≥5d` }
    : { estado: 'SOSTENIDA', detalle: `0 desajustes, exposición ${expSuf}/${n}` };
  const cuentaP2 = (get: (p: Par) => { repC: number; repT: number; consC: number; consT: number }): number =>
    pares.filter(p => {
      const g = get(p);
      if (g.consC <= 0 || g.consT <= 0) return false;
      return (100 * g.repT) / g.consT > (100 * g.repC) / g.consC;
    }).length;
  const cuentaP3 = (get: (p: Par) => { fracC: number | null; fracT: number | null }): number =>
    pares.filter(p => {
      const g = get(p);
      return g.fracC !== null && g.fracT !== null && g.fracT >= g.fracC;
    }).length;
  const hazP2 = (w: number): Veredicto => w >= umbralSostiene ? { estado: 'SOSTENIDA', detalle: `${w}/${n} T>C` }
    : w <= umbralInerte ? { estado: 'REFUTADA', detalle: `ley inerte: ${w}/${n} T>C` }
    : { estado: 'INCONCLUSA', detalle: `${w}/${n}` };
  const hazP3 = (w: number): Veredicto => w >= umbralSostiene ? { estado: 'SOSTENIDA', detalle: `${w}/${n} T≥C` }
    : w <= umbralInerte ? (expSuf >= Math.ceil(n / 2)
      ? { estado: 'REFUTADA', detalle: `${w}/${n} T≥C con exposición ${expSuf}/${n}` }
      : { estado: 'INCONCLUSA', detalle: `${w}/${n} sin exposición suficiente` })
    : { estado: 'INCONCLUSA', detalle: `${w}/${n}` };
  const p2 = hazP2(cuentaP2(p => ({ repC: p.repC, repT: p.repT, consC: p.consC, consT: p.consT })));
  const p3 = hazP3(cuentaP3(p => ({ fracC: p.fracC, fracT: p.fracT })));
  const p2d20: Veredicto = dias >= 20
    ? hazP2(cuentaP2(p => ({ repC: p.rep20C, repT: p.rep20T, consC: p.cons20C, consT: p.cons20T })))
    : { estado: 'INCOMPUTABLE', detalle: `horizonte ${dias} < 20` };
  const p3d20: Veredicto = dias >= 20
    ? hazP3(cuentaP3(p => ({ fracC: p.frac20C, fracT: p.frac20T })))
    : { estado: 'INCOMPUTABLE', detalle: `horizonte ${dias} < 20` };
  // ── Seguridad (método §3) ──
  const utiles = (ok: (p: Par) => boolean): Par[] => pares.filter(ok);
  const excluidos = (ok: (p: Par) => boolean): number[] => pares.filter(p => !ok(p)).map(p => p.seed);
  // Primaria: y = log(dp 1..D); d = yT − (yC+yP)/2.
  const okDp = (p: Par): boolean => p.dpC > 0 && p.dpT > 0 && p.dpP > 0;
  const up = utiles(okDp);
  const primaria = up.length >= MIN_SEMILLAS
    ? (() => {
      const pr = pruebaPermutacion3(up.map(p => [Math.log(p.dpC), Math.log(p.dpT), Math.log(p.dpP)] as const));
      const cota = cotaInferior(pr.nulos, pr.dObs, ALFA, pr.metodo === 'mc');
      return { decide: true, ...pr, cotaLog: cota, cotaX: Math.exp(cota),
        excluidas: excluidos(okDp), nulos: undefined as unknown as number[] };
    })()
    : { decide: false, motivo: `solo ${up.length}/${n} semillas con dp>0`, pIzq: NaN, efecto: NaN };
  const danoPrimaria = primaria.decide === true && (primaria as { pIzq: number }).pIzq < ALFA
    && (primaria as { efecto: number }).efecto < 0.9;
  // Secundaria nacimientos: solo si el cupo saturó ≤ 50 % de los días en C.
  const satTotC = pares.reduce((a, p) => a + p.satC, 0);
  const cupoManda = satTotC > (n * dias) / 2;
  const okNac = (p: Par): boolean => p.nacC > 0 && p.nacT > 0 && p.nacP > 0;
  const un = utiles(okNac);
  const nacimientos = !cupoManda && un.length >= MIN_SEMILLAS
    ? (() => {
      const pr = pruebaPermutacion3(un.map(p => [Math.log(p.nacC), Math.log(p.nacT), Math.log(p.nacP)] as const));
      return { decide: true, ...pr, excluidas: excluidos(okNac), nulos: undefined as unknown as number[] };
    })()
    : { decide: false, motivo: cupoManda ? `cupo: ${satTotC}/${n * dias} días saturados en C` : `solo ${un.length}/${n} con nac>0` };
  const danoNac = nacimientos.decide === true && (nacimientos as { pIzq: number }).pIzq < ALFA_SEC
    && (nacimientos as { efecto: number }).efecto < 0.9;
  // Secundaria tasa exp+sed por 100 dp (últimos 30 días), escala natural, cola derecha.
  const okTasa = (p: Par): boolean => dias >= 30 && p.dpVC > 0 && p.dpVT > 0 && p.dpVP > 0;
  const ut = utiles(okTasa);
  const tasa = ut.length >= MIN_SEMILLAS
    ? (() => {
      const r = (m: number, dp: number): number => (100 * m) / dp;
      const pr = pruebaPermutacion3(ut.map(p => [r(p.mueC, p.dpVC), r(p.mueT, p.dpVT), r(p.mueP, p.dpVP)] as const));
      return { decide: true, ...pr, excluidas: excluidos(okTasa), nulos: undefined as unknown as number[] };
    })()
    : { decide: false, motivo: dias < 30 ? `horizonte ${dias} < 30` : `solo ${ut.length}/${n} con dpVent>0` };
  const danoTasa = tasa.decide === true && (tasa as { pDer: number }).pDer < ALFA_SEC;
  // Extinción exclusiva: entre semillas con exactamente un brazo extinto, ¿T?
  const uni = pares.filter(p => [p.extC, p.extT, p.extP].filter(Boolean).length === 1);
  const kT = uni.filter(p => p.extT).length;
  const pExt = colaBinomial(uni.length, kT);
  const danoExt = uni.length > 0 && pExt < ALFA;
  const extincion = { n: uni.length, kT, p: pExt, semillas: uni.map(p => p.seed) };
  // Validez: P frente a C (signo) + cobertura de divergencia de P.
  const difPC = up.map(p => Math.log(p.dpP) - Math.log(p.dpC));
  const sig = up.length >= MIN_SEMILLAS ? pruebaSigno(difPC) : null;
  const danoPlac = sig !== null && sig.pIzq < ALFA && sig.efecto < 0.9;
  const sinDivP = pares.filter(p => p.divP === null).map(p => p.seed);
  const invalidoDiv = sinDivP.length > n / 4;
  const validez = { decide: sig !== null, signo: sig, sdRobustaPC: sig !== null ? sdRobusta(difPC) : NaN,
    sinDivergenciaP: sinDivP, invalido: danoPlac || invalidoDiv,
    motivo: danoPlac ? 'placebo no nulo (P<C con p<0,05 y <0,9×)' : invalidoDiv ? `P no diverge en ${sinDivP.length}/${n}` : null };
  // Descriptivo: recuentos <0,8× (T/C y P/C), lectura intermedia día 20.
  const rT = (a: number, b: number): number => (b === 0 ? (a === 0 ? 1 : Infinity) : a / b);
  const dp20 = dias >= 20 ? (() => {
    const vals = pares.filter(p => p.dpC > 0 && p.dpT > 0 && p.dpP > 0)
      .map(p => [Math.log(p.dpC), Math.log(p.dpT), Math.log(p.dpP)] as const);
    if (vals.length < MIN_SEMILLAS) return null;
    const pr = pruebaPermutacion3(vals);
    return { efecto: pr.efecto, pIzq: pr.pIzq, n: vals.length };
  })() : null;
  const descriptivo = {
    dpTbajo08: pares.filter(p => rT(p.dpT, p.dpC) < 0.8).length,
    dpPbajo08: pares.filter(p => rT(p.dpP, p.dpC) < 0.8).length,
    nacTbajo08: pares.filter(p => rT(p.nacT, p.nacC) < 0.8).length,
    nacPbajo08: pares.filter(p => rT(p.nacP, p.nacC) < 0.8).length,
    dia20: dp20,
    divergencia: pares.map(p => ({ seed: p.seed, divT: p.divT, divP: p.divP })),
  };
  const danoSec = danoNac || danoTasa;
  let seguridad: Seguridad;
  if (validez.invalido) {
    seguridad = { estado: 'INCONCLUSO', detalle: `INVÁLIDO: ${validez.motivo} (no se juzga T)`,
      primaria: primaria as unknown as Record<string, unknown>,
      nacimientos: nacimientos as unknown as Record<string, unknown>,
      tasa: tasa as unknown as Record<string, unknown>, extincion: extincion as unknown as Record<string, unknown>,
      validez: validez as unknown as Record<string, unknown>, descriptivo: descriptivo as unknown as Record<string, unknown> };
  } else if (danoPrimaria || danoSec || danoExt) {
    const vias = [danoPrimaria && 'primaria', danoNac && 'nacimientos', danoTasa && 'tasa-exp+sed', danoExt && 'extinción']
      .filter(Boolean).join(',');
    seguridad = { estado: 'DAÑO', detalle: `vías: ${vias}`,
      primaria: primaria as unknown as Record<string, unknown>,
      nacimientos: nacimientos as unknown as Record<string, unknown>,
      tasa: tasa as unknown as Record<string, unknown>, extincion: extincion as unknown as Record<string, unknown>,
      validez: validez as unknown as Record<string, unknown>, descriptivo: descriptivo as unknown as Record<string, unknown> };
  } else if (primaria.decide === true && (primaria as { cotaX: number }).cotaX > 0.8) {
    seguridad = { estado: 'SEGURO', detalle: `cota inferior 95 % = ${(primaria as { cotaX: number }).cotaX.toFixed(3)}× > 0,8×`,
      primaria: primaria as unknown as Record<string, unknown>,
      nacimientos: nacimientos as unknown as Record<string, unknown>,
      tasa: tasa as unknown as Record<string, unknown>, extincion: extincion as unknown as Record<string, unknown>,
      validez: validez as unknown as Record<string, unknown>, descriptivo: descriptivo as unknown as Record<string, unknown> };
  } else {
    seguridad = { estado: 'INCONCLUSO', detalle: primaria.decide === true
      ? `cota inferior 95 % = ${(primaria as { cotaX: number }).cotaX.toFixed(3)}× ≤ 0,8×`
      : (primaria as { motivo: string }).motivo,
      primaria: primaria as unknown as Record<string, unknown>,
      nacimientos: nacimientos as unknown as Record<string, unknown>,
      tasa: tasa as unknown as Record<string, unknown>, extincion: extincion as unknown as Record<string, unknown>,
      validez: validez as unknown as Record<string, unknown>, descriptivo: descriptivo as unknown as Record<string, unknown> };
  }
  // ── Decisión ──
  const refMec = [p1, p2, p3].find(v => v.estado === 'REFUTADA');
  let decision: string;
  if (validez.invalido) decision = `INVÁLIDO (${validez.motivo})`;
  else if (seguridad.estado === 'DAÑO') decision = `REFUTADA (SEG: ${seguridad.detalle})`;
  else if (refMec) decision = `REFUTADA (${([['P1', p1], ['P2', p2], ['P3', p3]] as [string, Veredicto][]).filter(([, v]) => v.estado === 'REFUTADA').map(([k]) => k).join(',')})`;
  else if (p1.estado === 'SOSTENIDA' && p2.estado === 'SOSTENIDA' && p3.estado === 'SOSTENIDA'
    && seguridad.estado === 'SEGURO')
    decision = k1 === 'CUMPLIDA' ? 'PASA (candidata para main/V14)' : k1 === 'INCUMPLIDA'
      ? 'NO PASA (K1 incumplida)' : 'PASA salvo K1 (pendiente banco)';
  else if (seguridad.estado === 'INCONCLUSO' && [p1, p2, p3].every(v => v.estado !== 'REFUTADA'))
    decision = 'INCONCLUSO (extensión permitida una vez: adenda 18113–18118 preregistrada antes de mirar la seguridad)';
  else decision = `NO PASA (P1=${p1.estado} P2=${p2.estado} P3=${p3.estado} SEG=${seguridad.estado} K1=${k1})`;
  return { pares, p1, p2, p3, p2d20, p3d20, seguridad, decision };
}

// ── Self-test sintético (única prueba antes de datos reales) ──
function assert(c: boolean, m: string): void { if (!c) throw new Error(`self-test: ${m}`); }

type FabStruct = { id: string; first: number; active: number; rep: number; wood: number };
type FabAct = { tick: number; cond: number; dorm: number; N: number; R: number;
  ancla: { q0: number; n0: number; r0: number } | null; proy: number | null };
function fabricaReplica(dir: string, dias: number, o: { desg: 0 | 1; placebo: boolean; sha: string;
  nac: number[]; mue?: Record<string, number>; mort: number[]; rep: number[]; cons: number[];
  frac: (number | null)[]; acts?: FabAct[]; structs?: FabStruct[] }): void {
  mkdirSync(dir, { recursive: true });
  let nacA = 0;
  for (let d = 1; d <= dias; d++) {
    nacA += o.nac[d - 1]!;
    writeFileSync(join(dir, `dia-${String(d).padStart(3, '0')}.json`), JSON.stringify({ tick: d * TICKS_DIA,
      poblacion: o.mort[d - 1]! + 2, nacimientos: nacA, vecinosMortales: o.mort[d - 1],
      muertesPorCausa: d === dias ? (o.mue ?? { exposure: 0, dehydration: 0 }) : {},
      desgD: { ley: o.desg, mortales: o.mort[d - 1], obrasConstruidasDia: o.cons[d - 1],
        reparacionesDia: o.rep[d - 1], fraccionRotasProyectada: o.frac[d - 1] } }) + '\n');
  }
  writeFileSync(join(dir, 'replica.json'), JSON.stringify({ dias, sha: o.sha,
    ...(o.placebo ? { placebo: { t0: T0_PLACEBO, tick: T0_PLACEBO } } : {}),
    params: { social: { radioConvivencia: 12, disolucion: 1, maxComunidades: 64 },
      limites: { comunidades: 64 }, persistencia: { cadaTicks: 300 },
      material: { desgasteDormido: o.desg }, poblacion: { nacimientosPorComprobacion: 2 } } }) + '\n');
  writeFileSync(join(dir, 'material.json'), JSON.stringify({ observador: { coverage: { endTick: dias * TICKS_DIA, observationGaps: [] },
    structures: (o.structs ?? []).map(s => ({ id: s.id, components: ['frame', 'roof'], firstObservedTick: s.first,
      activeExposureTicks: s.active, repairCount: s.rep, repairWoodPaid: s.wood })) },
    desg: { activaciones: (o.acts ?? []).map(a => ({ structureId: 's0', tick: a.tick, conditionAlDespertar: a.cond,
      dormidaTicksPrevios: a.dorm, N: a.N, R: a.R, ancla: a.ancla, proyectada: a.proy })) } }) + '\n');
}

function selfTest(): void {
  const sha = 'lab-sha-ficticio', D = 6;
  const semillas = SEMILLAS;
  const rep = (v: number): number[] => Array(D).fill(v);
  const base = { sha, nac: rep(10), mort: rep(30), rep: rep(1), cons: rep(2), frac: rep(0.1) as (number | null)[] };
  const ancla = { q0: Q, n0: 0, r0: 0 };
  const exacta = (N: number, R: number): number => fq(Q, 0, 0, N, R, 1) / Q;
  const actoExacto: FabAct = { tick: 2400, cond: exacta(100, 40), dorm: 2400, N: 100, R: 40, ancla, proy: exacta(100, 40) };
  const mkstructs = (nSt: number, repTot: number): FabStruct[] =>
    Array.from({ length: nSt }, (_, i) => ({ id: `s${i}`, first: 0, active: 0, rep: i === 0 ? repTot : 0, wood: i === 0 ? repTot : 0 }));
  const corre = (fn: (dir: string) => void): ReturnType<typeof evaluarPanel> => {
    const dir = mkdtempSync(join(tmpdir(), 'eval60-'));
    try { fn(dir); return evaluarPanel(dir, semillas, D, sha, 'PENDIENTE'); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  // S1: media recortada (n=8 quita min+max como el método; n=12 quita 1/cola).
  assert(mediaRecortada([1, 2, 3, 4, 5, 6, 7, 8]) === 4.5, 'S1/n8');
  assert(mediaRecortada([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) === 6.5, 'S1/n12');
  // S2: caso exacto a mano (n=1): D* ∈ {1 ×2, −0,5 ×4}.
  {
    const pr = pruebaPermutacion3([[0, 1, 0]]);
    assert(pr.metodo === 'exacta' && pr.pIzq === 1 && Math.abs(pr.pDer - 1 / 3) < 1e-12, `S2 ${pr.pIzq}/${pr.pDer}`);
  }
  // S3: binomial (ejemplos del método: 3/3 y 4/5 dañan; 1/2 no).
  assert(Math.abs(colaBinomial(3, 3) - 1 / 27) < 1e-12 && colaBinomial(3, 3) < 0.05, 'S3/33');
  assert(Math.abs(colaBinomial(5, 4) - 11 / 243) < 1e-12 && colaBinomial(5, 4) < 0.05, 'S3/45');
  assert(colaBinomial(2, 1) > 0.5, 'S3/12');
  // S4: Monte Carlo determinista (misma semilla ⇒ mismo p).
  {
    const vals = semillas.map((_, i) => [0, i % 2 ? 0.01 : -0.01, 0] as const);
    const a = pruebaPermutacion3(vals), b = pruebaPermutacion3(vals);
    assert(a.metodo === 'mc' && a.pIzq === b.pIzq && a.pDer === b.pDer, 'S4/det');
  }
  // S5: digestDia ignora el reloj y el orden de claves, ve el contenido.
  assert(digestDia({ a: 1, p50Ms: 2, rss: 3 }) === digestDia({ rss: 9, a: 1, p95Ms: 0, p50Ms: 5 }), 'S5/reloj');
  assert(digestDia({ a: 1 }) !== digestDia({ a: 2 }), 'S5/contenido');
  // Panel A: ley sana (T=C, P≈C simétrico) ⇒ SEGURO + P1/P2/P3 sostenidas.
  {
    const v = corre(dir => { semillas.forEach((s, i) => {
      const mortP = [...rep(30)]; mortP[2] = i % 2 ? 31 : 29; // P difiere (diverge) simétricamente
      fabricaReplica(join(dir, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `PLAC-${s}`), D, { ...base, desg: 0, placebo: true, mort: mortP, structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, rep: rep(2),
        frac: rep(0.2), acts: [actoExacto], structs: mkstructs(12, 12) });
    }); });
    assert(v.seguridad.estado === 'SEGURO', `A/seg ${v.seguridad.estado} ${v.seguridad.detalle}`);
    assert(v.p1.estado === 'SOSTENIDA' && v.p2.estado === 'SOSTENIDA' && v.p3.estado === 'SOSTENIDA',
      `A/mec ${v.p1.estado}/${v.p2.estado}/${v.p3.estado}`);
    assert(!(v.seguridad.validez.invalido as boolean), 'A/validez');
    assert(v.decision === 'PASA salvo K1 (pendiente banco)', `A/dec ${v.decision}`);
  }
  // Panel B: daño uniforme 0,7× en dp ⇒ DAÑO por la primaria.
  {
    const v = corre(dir => { for (const s of semillas) {
      fabricaReplica(join(dir, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `PLAC-${s}`), D, { ...base, desg: 0, placebo: true, mort: [...rep(30).slice(0, 2), 31, ...rep(30).slice(3)], structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, mort: rep(21),
        acts: [actoExacto], structs: mkstructs(12, 6) });
    } });
    assert(v.seguridad.estado === 'DAÑO', `B/seg ${v.seguridad.estado}`);
    assert((v.seguridad.detalle as string).includes('primaria'), `B/via ${v.seguridad.detalle}`);
    assert(v.decision.startsWith('REFUTADA (SEG'), `B/dec ${v.decision}`);
  }
  // Panel C: placebo dañado (P a 0,5×) ⇒ INVÁLIDO.
  {
    const v = corre(dir => { for (const s of semillas) {
      fabricaReplica(join(dir, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `PLAC-${s}`), D, { ...base, desg: 0, placebo: true, mort: rep(15), structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, acts: [actoExacto], structs: mkstructs(12, 6) });
    } });
    assert(v.decision.startsWith('INVÁLIDO'), `C/dec ${v.decision}`);
  }
  // Panel D: 3/3 extinciones exclusivas de T ⇒ DAÑO por extinción.
  {
    const v = corre(dir => { semillas.forEach((s, i) => {
      fabricaReplica(join(dir, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `PLAC-${s}`), D, { ...base, desg: 0, placebo: true, mort: [...rep(30).slice(0, 2), 31, ...rep(30).slice(3)], structs: mkstructs(12, 6) });
      const mort = rep(30); if (i < 3) mort[D - 1] = 0;
      fabricaReplica(join(dir, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, mort,
        acts: [actoExacto], structs: mkstructs(12, 6) });
    }); });
    assert(v.seguridad.estado === 'DAÑO', `D/seg ${v.seguridad.estado}`);
    assert((v.seguridad.detalle as string).includes('extinción'), `D/via ${v.seguridad.detalle}`);
  }
  // Panel E: procedencia estricta (sha, placebo, ley).
  {
    const dir = mkdtempSync(join(tmpdir(), 'eval60-E-'));
    try {
      for (const s of semillas) {
        fabricaReplica(join(dir, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(1, 6) });
        fabricaReplica(join(dir, `PLAC-${s}`), D, { ...base, desg: 0, placebo: true, structs: mkstructs(1, 6) });
        fabricaReplica(join(dir, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, structs: mkstructs(1, 6) });
      }
      let fallos = 0;
      try { evaluarPanel(dir, semillas, D, 'otro-sha', 'PENDIENTE'); } catch { fallos++; }
      assert(fallos === 1, 'E/sha');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const dir2 = mkdtempSync(join(tmpdir(), 'eval60-E2-'));
    try {
      for (const s of semillas) {
        fabricaReplica(join(dir2, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(1, 6) });
        fabricaReplica(join(dir2, `PLAC-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(1, 6) });
        fabricaReplica(join(dir2, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, structs: mkstructs(1, 6) });
      }
      let fallos = 0;
      try { evaluarPanel(dir2, semillas, D, sha, 'PENDIENTE'); } catch { fallos++; }
      assert(fallos === 1, 'E/placebo-falta');
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  }
  // Panel F: primera divergencia (P día 3, T día 2).
  {
    const v = corre(dir => { for (const s of semillas) {
      fabricaReplica(join(dir, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(1, 6) });
      const mortP = rep(30); mortP[2] = 31;
      fabricaReplica(join(dir, `PLAC-${s}`), D, { ...base, desg: 0, placebo: true, mort: mortP, structs: mkstructs(1, 6) });
      const mortT = rep(30); mortT[1] = 29;
      fabricaReplica(join(dir, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, mort: mortT,
        acts: [actoExacto], structs: mkstructs(1, 6) });
    } });
    const div = v.pares as { divT: number | null; divP: number | null }[];
    assert(div.every(p => p.divT === 2 && p.divP === 3), 'F/div');
  }
  // Panel G: P2/P3 9/12 sostiene, 6/12 inerte, 7/12 inconcluso.
  for (const [wins, esp2, esp3] of [[9, 'SOSTENIDA', 'SOSTENIDA'], [6, 'REFUTADA', 'REFUTADA'], [7, 'INCONCLUSA', 'INCONCLUSA']] as const) {
    const v = corre(dir => { semillas.forEach((s, i) => {
      fabricaReplica(join(dir, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `PLAC-${s}`), D, { ...base, desg: 0, placebo: true, mort: [...rep(30).slice(0, 2), 31, ...rep(30).slice(3)], structs: mkstructs(12, 6) });
      const gana = i < wins;
      fabricaReplica(join(dir, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, rep: rep(gana ? 2 : 1),
        frac: rep(gana ? 0.2 : 0.05), acts: [actoExacto], structs: mkstructs(12, gana ? 12 : 6) });
    }); });
    assert(v.p2.estado === esp2, `G${wins}/p2 ${v.p2.estado}`);
    assert(v.p3.estado === esp3, `G${wins}/p3 ${v.p3.estado}`);
  }
  // Panel H1: cupo global ⇒ nacimientos NO_DECIDE. H2: T a 0,5× en nac ⇒ DAÑO.
  {
    const v = corre(dir => { for (const s of semillas) {
      fabricaReplica(join(dir, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, nac: rep(40), structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `PLAC-${s}`), D, { ...base, desg: 0, placebo: true, nac: rep(40),
        mort: [...rep(30).slice(0, 2), 31, ...rep(30).slice(3)], structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, nac: rep(40),
        acts: [actoExacto], structs: mkstructs(12, 6) });
    } });
    assert((v.seguridad.nacimientos.decide as boolean) === false, 'H1/cupodecide');
    assert(((v.seguridad.nacimientos as { motivo: string }).motivo as string).includes('cupo'), 'H1/motivo');
  }
  {
    const v = corre(dir => { for (const s of semillas) {
      fabricaReplica(join(dir, `CTRL-${s}`), D, { ...base, desg: 0, placebo: false, structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `PLAC-${s}`), D, { ...base, desg: 0, placebo: true,
        mort: [...rep(30).slice(0, 2), 31, ...rep(30).slice(3)], structs: mkstructs(12, 6) });
      fabricaReplica(join(dir, `TRT-${s}`), D, { ...base, desg: 1, placebo: false, nac: rep(5),
        acts: [actoExacto], structs: mkstructs(12, 6) });
    } });
    assert(v.seguridad.estado === 'DAÑO', `H2/seg ${v.seguridad.estado}`);
    assert((v.seguridad.detalle as string).includes('nacimientos'), `H2/via ${v.seguridad.detalle}`);
  }
  console.log('self-test D60: S1/S2/S3/S4/S5/A/B/C/D/E/F/G/H1/H2 PASS');
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) { selfTest(); return; }
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = arg('--dir'), sha = arg('--sha');
  if (!dir || !sha) throw new Error('Uso: evaluar-desg-d60.mts --dir <panel> --sha <lab-sha> [--k1 CUMPLIDA|INCUMPLIDA] [--json out] [--self-test]');
  const k1a = arg('--k1');
  if (k1a !== undefined && k1a !== 'CUMPLIDA' && k1a !== 'INCUMPLIDA') throw new Error('--k1 admite CUMPLIDA|INCUMPLIDA');
  const v = evaluarPanel(dir, SEMILLAS, DIAS, sha, k1a ?? 'PENDIENTE');
  for (const p of v.pares as Record<string, unknown>[]) console.log(JSON.stringify(p));
  for (const k of ['p1', 'p2', 'p3', 'p2d20', 'p3d20'] as const) console.log(`${k.toUpperCase()}: ${v[k].estado} — ${v[k].detalle}`);
  console.log(`SEGURIDAD: ${v.seguridad.estado} — ${v.seguridad.detalle}`);
  console.log(`  primaria: ${JSON.stringify(v.seguridad.primaria)}`);
  console.log(`  nacimientos: ${JSON.stringify(v.seguridad.nacimientos)}`);
  console.log(`  tasa: ${JSON.stringify(v.seguridad.tasa)}`);
  console.log(`  extincion: ${JSON.stringify(v.seguridad.extincion)}`);
  console.log(`  validez: ${JSON.stringify(v.seguridad.validez)}`);
  console.log(`  descriptivo: ${JSON.stringify(v.seguridad.descriptivo)}`);
  console.log(`DECISIÓN: ${v.decision}`);
  const out = arg('--json');
  if (out) { writeFileSync(out, JSON.stringify(v, null, 2) + '\n'); console.log(`JSON → ${out}`); }
}

if (process.argv[1]?.endsWith('evaluar-desg-d60.mts')) main();
