/**
 * Evaluador del cribado DESG-D — implementa EXACTAMENTE la tabla (e) de
 * `datos-lab/critica-ciclo-material-20261001.md` + `desg-d-cribado/PRERREGISTRO.md`.
 *
 * Escrito y probado con datos SINTÉTICOS antes de ver ningún dato real (sha256 en
 * bitácora). Independiente del motor: reimplementa f(ancla,N,R) con las constantes
 * preregistradas (no importa `src/`), así P1 es un oráculo externo.
 *
 * Entrada: --dir datos-lab/desg-d-cribado/ con CTRL-1800X y TRT-1800X (X=1..8), cada
 * uno con dia-001..020.json (clave desgD), replica.json y material.json.
 * Definiciones operativas (fijadas antes de datos, también en bitácora):
 * - Día saturado (cupo): nacimientosDia >= 40 (máximo teórico 2/ventana × 20).
 *   S1 cede a S2 si > 80/160 días saturados en CADA brazo (global, no por par).
 * - Extinción (mortal): desgD.mortales == 0 al día 20. Exclusiva = solo tratamiento.
 * - P2 indefinido si construidas==0 en un brazo del par (no-win, se anota).
 * - P3 indefinido si fracción null en un brazo (no-win, se anota).
 * - S1 ratio con C==0: T==0 → 1, T>0 → +inf. S2 igual para días-persona y tasas.
 *
 * Uso: tsx evaluar-desg-d.mts --dir <cribado> --sha <lab-sha> [--json salida]
 *      tsx evaluar-desg-d.mts --self-test
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SEMILLAS = [18001, 18002, 18003, 18004, 18005, 18006, 18007, 18008];
const DIAS = 20, TICKS_DIA = 2400, Q = 3_000_000_000;

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

type Dia = { tick: number; poblacion: number; nacimientos: number; muertesPorCausa: Record<string, number>;
  cambiosHogar?: { adopta: number; pierde: number }; censoComunidades?: { n: number };
  desgD: { ley: 0 | 1; N: number | null; R: number | null; mortales: number; maderaCorporal: number;
    obrasConstruidasDia: number; reparacionesDia: number; maderaReparacionDia: number;
    obrasTotales: number; obrasDormidas: number; rotasProyectadas: number; fraccionRotasProyectada: number | null } };
type EstructuraObs = { id: string; components: string[]; firstObservedTick: number; activeExposureTicks: number;
  repairCount: number; repairWoodPaid: number };
type Replica = { dias: Dia[]; replicaJson: { dias: number; sha: string; params: Record<string, Record<string, unknown>> };
  material: { observador: { coverage: { endTick: number; observationGaps: unknown[] }; structures: EstructuraObs[] };
    desg: { activaciones: { structureId: string; tick: number; conditionAlDespertar: number; dormidaTicksPrevios: number;
      N: number; R: number; ancla: { q0: number; n0: number; r0: number } | null; proyectada: number | null }[] } } };

function leerReplica(dir: string): Replica {
  const dias: Dia[] = [];
  for (let d = 1; d <= DIAS; d++) dias.push(JSON.parse(readFileSync(join(dir, `dia-${String(d).padStart(3, '0')}.json`), 'utf8')));
  return { dias,
    replicaJson: JSON.parse(readFileSync(join(dir, 'replica.json'), 'utf8')),
    material: JSON.parse(readFileSync(join(dir, 'material.json'), 'utf8')) };
}

function ratioOT(a: number, b: number): number { return b === 0 ? (a === 0 ? 1 : Infinity) : a / b; }

export type Veredicto = { estado: 'SOSTENIDA' | 'REFUTADA' | 'INCONCLUSA' | 'NO_DECIDE'; detalle: string };

export function evaluar(cribado: string, labSha: string): { pares: unknown[]; p1: Veredicto; p2: Veredicto; p3: Veredicto;
  s1: Veredicto; s2: Veredicto; seguridad: Veredicto; x: unknown[]; decision: string } {
  const pares: Record<string, unknown>[] = [];
  const x: unknown[] = [];
  let satC = 0, satT = 0;
  for (const seed of SEMILLAS) {
    const c = leerReplica(join(cribado, `CTRL-${seed}`));
    const t = leerReplica(join(cribado, `TRT-${seed}`));
    // Procedencia (G0-proxy): params exactos del preregistro, 20 días, sha del laboratorio.
    for (const [r, desg, brazo] of [[c, 0, 'CTRL'], [t, 1, 'TRT']] as const) {
      const p = r.replicaJson.params;
      const espera: Record<string, unknown> = { 'social.radioConvivencia': 12, 'social.disolucion': 1, 'social.maxComunidades': 64,
        'limites.comunidades': 64, 'persistencia.cadaTicks': 300, 'material.desgasteDormido': desg };
      for (const [k, v] of Object.entries(espera)) {
        const [s, h] = k.split('.') as [string, string];
        if (p[s]?.[h] !== v) throw new Error(`${brazo}-${seed}: param ${k} = ${p[s]?.[h]}, preregistro ${v}`);
      }
      if (r.replicaJson.dias !== 20 || r.dias.length !== 20) throw new Error(`${brazo}-${seed}: incompleta`);
      if (r.replicaJson.sha !== labSha) throw new Error(`${brazo}-${seed}: sha ${r.replicaJson.sha} != lab ${labSha}`);
      if (r.dias.some(d => d.desgD.ley !== desg)) throw new Error(`${brazo}-${seed}: ley mezclada en días`);
    }
    if (t.material.observador.coverage.observationGaps.length > 0) throw new Error(`TRT-${seed}: huecos de observación (cargas a mitad: diseño incumplido)`);
    if (c.material.desg.activaciones.length > 0) throw new Error(`CTRL-${seed}: activaciones DESG-D en control`);
    // Métricas por réplica.
    const met = (r: Replica) => {
      const nacDia = r.dias.map((d, i) => d.nacimientos - (i ? r.dias[i - 1]!.nacimientos : 0));
      return {
        nac: r.dias[DIAS - 1]!.nacimientos,
        sat: nacDia.filter(n => n >= 40).length,
        rep: r.dias.reduce((a, d) => a + d.desgD.reparacionesDia, 0),
        cons: r.dias.reduce((a, d) => a + d.desgD.obrasConstruidasDia, 0),
        frac20: r.dias[DIAS - 1]!.desgD.fraccionRotasProyectada,
        dp: r.dias.reduce((a, d) => a + d.desgD.mortales, 0),
        mueES: (r.dias[DIAS - 1]!.muertesPorCausa.exposure ?? 0) + (r.dias[DIAS - 1]!.muertesPorCausa.dehydration ?? 0),
        extinta: r.dias[DIAS - 1]!.desgD.mortales === 0,
        cambios: r.dias.reduce((a, d) => a + (d.cambiosHogar?.adopta ?? 0) + (d.cambiosHogar?.pierde ?? 0), 0),
        comun20: r.dias[DIAS - 1]!.censoComunidades?.n ?? null,
        madCorp20: r.dias[DIAS - 1]!.desgD.maderaCorporal,
      };
    };
    const mc = met(c), mt = met(t);
    satC += mc.sat; satT += mt.sat;
    // P1 por réplica tratada: exactitud (durabilidad real de cada obra) + exposición.
    const durPorId = new Map(t.material.observador.structures.map(s => [s.id, durabilidad(s.components)]));
    let desajustes = 0;
    for (const a of t.material.desg.activaciones) {
      if (a.dormidaTicksPrevios <= 0) continue; // materialización fresca, no reactivación
      const dur = durPorId.get(a.structureId);
      const f = a.ancla !== null && dur !== undefined ? fq(a.ancla.q0, a.ancla.n0, a.ancla.r0, a.N, a.R, dur) / Q : NaN;
      if (!(a.conditionAlDespertar === a.proyectada && a.proyectada === f)) desajustes++;
    }
    const fin = t.material.observador.coverage.endTick;
    const dormidas5 = t.material.observador.structures.filter(s => (fin - s.firstObservedTick) - s.activeExposureTicks >= 5 * TICKS_DIA).length;
    const obraDias = t.material.observador.structures.reduce((a, s) => a + ((fin - s.firstObservedTick) - s.activeExposureTicks) / TICKS_DIA, 0);
    // Coherencia reparaciones observador vs diario, ambos brazos (misma fuente: repair()).
    for (const [r, m, brazo] of [[c, mc, 'CTRL'], [t, mt, 'TRT']] as const) {
      const repObs = r.material.observador.structures.reduce((a, s) => a + s.repairCount, 0);
      if (repObs !== m.rep) throw new Error(`${brazo}-${seed}: reparaciones observador ${repObs} != diario ${m.rep}`);
    }
    pares.push({ seed, nacC: mc.nac, nacT: mt.nac, desajustesP1: desajustes, dormidas5, obraDias: Math.round(obraDias * 100) / 100,
      repC: mc.rep, repT: mt.rep, consC: mc.cons, consT: mt.cons, fracC: mc.frac20, fracT: mt.frac20,
      dpC: mc.dp, dpT: mt.dp, mueC: mc.mueES, mueT: mt.mueES, extC: mc.extinta, extT: mt.extinta, satC: mc.sat, satT: mt.sat });
    for (const [brazo, m] of [['CTRL', mc], ['TRT', mt]] as const)
      x.push({ replica: `${brazo}-${seed}`, cambiosHogar: m.cambios, comunidades20: m.comun20, construidas: m.cons, maderaCorporal20: Math.round(m.madCorp20 * 1000) / 1000 });
  }
  const P = pares as ({ seed: number; nacC: number; nacT: number; desajustesP1: number; dormidas5: number;
    repC: number; repT: number; consC: number; consT: number; fracC: number | null; fracT: number | null;
    dpC: number; dpT: number; mueC: number; mueT: number; extC: boolean; extT: boolean }[]);
  // P1: 1 desajuste ⇒ refutada; <4/8 con ≥10 obras × ≥5d ⇒ inconclusa.
  const desTot = P.reduce((a, p) => a + p.desajustesP1, 0);
  const expSuf = P.filter(p => p.dormidas5 >= 10).length;
  const p1: Veredicto = desTot > 0 ? { estado: 'REFUTADA', detalle: `${desTot} desajustes q != f(ancla)` }
    : expSuf < 4 ? { estado: 'INCONCLUSA', detalle: `exposición: ${expSuf}/8 con ≥10 obras × ≥5d` }
    : { estado: 'SOSTENIDA', detalle: `0 desajustes, exposición ${expSuf}/8` };
  // P2: reparaciones por 100 construidas, T>C en ≥6/8 sostiene, ≤4/8 inerte, 5 inconclusa.
  const tasa = (rep: number, cons: number): number | null => cons > 0 ? (100 * rep) / cons : null;
  const w2 = P.filter(p => { const a = tasa(p.repT, p.consT), b = tasa(p.repC, p.consC); return a !== null && b !== null && a > b; }).length;
  const indef2 = P.filter(p => p.consT === 0 || p.consC === 0).map(p => p.seed);
  const p2: Veredicto = w2 >= 6 ? { estado: 'SOSTENIDA', detalle: `${w2}/8 T>C` }
    : w2 <= 4 ? { estado: 'REFUTADA', detalle: `ley inerte: ${w2}/8 T>C${indef2.length ? ` (indef ${indef2})` : ''}` }
    : { estado: 'INCONCLUSA', detalle: '5/8' };
  // P3: fracción rota T≥C en ≥6/8; ≤4/8 con exposición suficiente ⇒ refutada.
  const w3 = P.filter(p => p.fracT !== null && p.fracC !== null && p.fracT >= p.fracC).length;
  const p3: Veredicto = w3 >= 6 ? { estado: 'SOSTENIDA', detalle: `${w3}/8 T≥C` }
    : w3 <= 4 ? (expSuf >= 4 ? { estado: 'REFUTADA', detalle: `${w3}/8 T≥C con exposición ${expSuf}/8` }
      : { estado: 'INCONCLUSA', detalle: `${w3}/8 sin exposición suficiente` })
    : { estado: 'INCONCLUSA', detalle: '5/8' };
  // S1: nac ≥0,9× en ≥6/8 sostiene; ≥2/8 <0,8 o extinción exclusiva ⇒ refuta; cupo global ⇒ no decide.
  const cede = satC > 80 && satT > 80;
  const ratios1 = P.map(p => ratioOT(p.nacT, p.nacC));
  const malos1 = ratios1.filter(r => r < 0.8).length, buenos1 = ratios1.filter(r => r >= 0.9).length;
  const extExc = P.filter(p => p.extT && !p.extC).map(p => p.seed);
  const s1: Veredicto = cede ? { estado: 'NO_DECIDE', detalle: `cupo ${satC}/160C ${satT}/160T: manda S2` }
    : extExc.length > 0 ? { estado: 'REFUTADA', detalle: `extinción exclusiva ${extExc}` }
    : malos1 >= 2 ? { estado: 'REFUTADA', detalle: `${malos1}/8 <0,8` }
    : buenos1 >= 6 ? { estado: 'SOSTENIDA', detalle: `${buenos1}/8 ≥0,9×` }
    : { estado: 'INCONCLUSA', detalle: `${buenos1}/8 ≥0,9×, ${malos1}/8 <0,8` };
  // S2: días-persona ≥0,9× en ≥6/8; refuta si ≥2/8 <0,8 o muertes exp+sed >1,25× en ≥6/8.
  const ratios2 = P.map(p => ratioOT(p.dpT, p.dpC));
  const malos2 = ratios2.filter(r => r < 0.8).length, buenos2 = ratios2.filter(r => r >= 0.9).length;
  const tasaM = (m: number, dp: number): number => dp > 0 ? (100 * m) / dp : (m > 0 ? Infinity : 0);
  const caros = P.filter(p => ratioOT(tasaM(p.mueT, p.dpT), tasaM(p.mueC, p.dpC)) > 1.25).length;
  const s2: Veredicto = malos2 >= 2 ? { estado: 'REFUTADA', detalle: `${malos2}/8 días-persona <0,8` }
    : caros >= 6 ? { estado: 'REFUTADA', detalle: `${caros}/8 muertes exp+sed >1,25×` }
    : buenos2 >= 6 ? { estado: 'SOSTENIDA', detalle: `${buenos2}/8 ≥0,9×` }
    : { estado: 'INCONCLUSA', detalle: `${buenos2}/8 ≥0,9×` };
  // Seguridad + decisión (K1 la aporta el banco, fuera de este evaluador).
  const seguridad: Veredicto = s1.estado === 'REFUTADA' || s2.estado === 'REFUTADA'
    ? { estado: 'REFUTADA', detalle: `S1=${s1.estado} S2=${s2.estado}` }
    : s2.estado === 'SOSTENIDA' && (s1.estado === 'SOSTENIDA' || s1.estado === 'NO_DECIDE')
    ? { estado: 'SOSTENIDA', detalle: `S1=${s1.estado} S2=${s2.estado}` }
    : { estado: 'INCONCLUSA', detalle: `S1=${s1.estado} S2=${s2.estado}` };
  const refutada = [p1, p2, p3, seguridad].find(v => v.estado === 'REFUTADA');
  const decision = refutada ? `REFUTADA (${[p1, p2, p3, seguridad].map((v, i) => v.estado === 'REFUTADA' ? ['P1', 'P2', 'P3', 'SEG'][i] : null).filter(Boolean).join(',')})`
    : [p1, p2, p3, seguridad].every(v => v.estado === 'SOSTENIDA') ? 'APOYO (pendiente K1)'
    : `INCONCLUSA (P1=${p1.estado} P2=${p2.estado} P3=${p3.estado} SEG=${seguridad.estado}; pendiente K1)`;
  return { pares, p1, p2, p3, s1, s2, seguridad, x, decision };
}

// ── Self-test sintético (única prueba antes de datos reales) ──
function assert(c: boolean, m: string): void { if (!c) throw new Error(`self-test: ${m}`); }

type FabStruct = { id: string; first: number; active: number; rep: number; wood: number; comp?: string[] };
type FabAct = { tick: number; cond: number; dorm: number; N: number; R: number; ancla: { q0: number; n0: number; r0: number } | null; proy: number | null };
function fabricaReplica(dir: string, o: { desg: 0 | 1; sha: string; nac: number[]; mue?: Record<string, number>;
  mort: number[]; rep: number[]; cons: number[]; frac: (number | null)[]; cambios?: number; comun?: number;
  mad?: number; acts?: FabAct[]; structs?: FabStruct[] }): void {
  mkdirSync(dir, { recursive: true });
  let nacA = 0;
  for (let d = 1; d <= DIAS; d++) {
    nacA += o.nac[d - 1]!;
    writeFileSync(join(dir, `dia-${String(d).padStart(3, '0')}.json`), JSON.stringify({ tick: d * TICKS_DIA, poblacion: 50,
      nacimientos: nacA, muertesPorCausa: d === DIAS ? (o.mue ?? { exposure: 0, dehydration: 0 }) : {},
      cambiosHogar: { adopta: o.cambios ?? 0, pierde: 0 }, censoComunidades: { n: o.comun ?? 3 },
      desgD: { ley: o.desg, N: o.desg ? 100 : null, R: o.desg ? 40 : null, mortales: o.mort[d - 1],
        maderaCorporal: o.mad ?? 5, obrasConstruidasDia: o.cons[d - 1], reparacionesDia: o.rep[d - 1],
        maderaReparacionDia: o.rep[d - 1], obrasTotales: 10, obrasDormidas: 3, rotasProyectadas: 1,
        fraccionRotasProyectada: o.frac[d - 1] } }) + '\n');
  }
  writeFileSync(join(dir, 'replica.json'), JSON.stringify({ dias: 20, sha: o.sha, params: { social: { radioConvivencia: 12, disolucion: 1, maxComunidades: 64 },
    limites: { comunidades: 64 }, persistencia: { cadaTicks: 300 }, material: { desgasteDormido: o.desg } } }) + '\n');
  writeFileSync(join(dir, 'material.json'), JSON.stringify({ observador: { coverage: { endTick: DIAS * TICKS_DIA, observationGaps: [] },
    structures: (o.structs ?? []).map(s => ({ id: s.id, components: s.comp ?? ['frame', 'roof'], firstObservedTick: s.first,
      activeExposureTicks: s.active, repairCount: s.rep, repairWoodPaid: s.wood })) },
    desg: { activaciones: (o.acts ?? []).map(a => ({ structureId: 's0', tick: a.tick, conditionAlDespertar: a.cond,
      dormidaTicksPrevios: a.dorm, N: a.N, R: a.R, ancla: a.ancla, proyectada: a.proy })) } }) + '\n');
}

function selfTest(): void {
  const sha = 'lab-sha-ficticio';
  const rep20 = (v: number): number[] => Array(20).fill(v);
  const base = { sha, nac: rep20(10), mort: rep20(30), rep: rep20(1), cons: rep20(2), frac: rep20(0.1) as (number | null)[] };
  const ancla = { q0: Q, n0: 0, r0: 0 };
  const exacta = (N: number, R: number): number => fq(Q, 0, 0, N, R, 1) / Q;
  /** Estructuras con `repTot` reparaciones en la primera (coherencia observador=diario). */
  const mkstructs = (n: number, dormTicks: number, repTot: number): FabStruct[] =>
    Array.from({ length: n }, (_, i) => ({ id: `s${i}`, first: 0, active: DIAS * TICKS_DIA - dormTicks, rep: i === 0 ? repTot : 0, wood: i === 0 ? repTot : 0 }));
  const corre = (fn: (dir: string) => void): ReturnType<typeof evaluar> => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'));
    try { fn(dir); return evaluar(dir, sha); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  // Caso A: todo sostenido.
  {
    const v = corre(dir => { for (const s of SEMILLAS) {
      fabricaReplica(join(dir, `CTRL-${s}`), { ...base, desg: 0, structs: mkstructs(12, 13000, 20) });
      fabricaReplica(join(dir, `TRT-${s}`), { ...base, desg: 1, rep: rep20(2),
        acts: [{ tick: 2400, cond: exacta(100, 40), dorm: 2400, N: 100, R: 40, ancla, proy: exacta(100, 40) }],
        structs: mkstructs(12, 13000, 40) });
    } });
    assert(v.p1.estado === 'SOSTENIDA', `A/p1 ${v.p1.estado}`);
    assert(v.p2.estado === 'SOSTENIDA', `A/p2 ${v.p2.estado} (T=100 vs C=50)`);
    assert(v.p3.estado === 'SOSTENIDA', `A/p3 ${v.p3.estado} (0,1≥0,1 en 8/8)`);
    assert(v.s1.estado === 'SOSTENIDA', `A/s1 ${v.s1.estado}`);
    assert(v.s2.estado === 'SOSTENIDA', `A/s2 ${v.s2.estado}`);
    assert(v.decision.startsWith('APOYO'), `A/dec ${v.decision}`);
  }
  // Caso B: P1 refutada por 1 desajuste.
  {
    const v = corre(dir => { SEMILLAS.forEach((s, i) => {
      fabricaReplica(join(dir, `CTRL-${s}`), { ...base, desg: 0, structs: mkstructs(12, 13000, 20) });
      fabricaReplica(join(dir, `TRT-${s}`), { ...base, desg: 1,
        acts: [{ tick: 2400, cond: i === 0 ? 0.5 : exacta(100, 40), dorm: 2400, N: 100, R: 40, ancla, proy: exacta(100, 40) }],
        structs: mkstructs(12, 13000, 20) });
    }); });
    assert(v.p1.estado === 'REFUTADA', `B/p1 ${v.p1.estado}`);
    assert(v.decision.startsWith('REFUTADA'), `B/dec ${v.decision}`);
  }
  // Caso C: P1 inconclusa por exposición (0/8).
  {
    const v = corre(dir => { for (const s of SEMILLAS) {
      fabricaReplica(join(dir, `CTRL-${s}`), { ...base, desg: 0, structs: mkstructs(12, 13000, 20) });
      fabricaReplica(join(dir, `TRT-${s}`), { ...base, desg: 1, structs: mkstructs(12, 100, 20) });
    } });
    assert(v.p1.estado === 'INCONCLUSA', `C/p1 ${v.p1.estado}`);
  }
  // Caso D: P2 inerte (0 wins) + P3 refutada con exposición.
  {
    const v = corre(dir => { for (const s of SEMILLAS) {
      fabricaReplica(join(dir, `CTRL-${s}`), { ...base, desg: 0, frac: rep20(0.2), structs: mkstructs(12, 13000, 20) });
      fabricaReplica(join(dir, `TRT-${s}`), { ...base, desg: 1, frac: rep20(0.1), structs: mkstructs(12, 13000, 20) });
    } });
    assert(v.p2.estado === 'REFUTADA', `D/p2 ${v.p2.estado}`);
    assert(v.p3.estado === 'REFUTADA', `D/p3 ${v.p3.estado} (0/8 con exposición)`);
  }
  // Caso E: S1 refuta por 2/8 <0,8; S2 refuta por muertes >1,25× en 6/8.
  {
    const v = corre(dir => { SEMILLAS.forEach((s, i) => {
      fabricaReplica(join(dir, `CTRL-${s}`), { ...base, desg: 0, mue: { exposure: 10, dehydration: 0 }, structs: mkstructs(12, 13000, 20) });
      fabricaReplica(join(dir, `TRT-${s}`), { ...base, desg: 1, nac: rep20(i < 2 ? 5 : 10),
        mue: { exposure: i < 6 ? 20 : 10, dehydration: 0 }, structs: mkstructs(12, 13000, 20) });
    }); });
    assert(v.s1.estado === 'REFUTADA', `E/s1 ${v.s1.estado} (2/8 a 0,5×)`);
    assert(v.s2.estado === 'REFUTADA', `E/s2 ${v.s2.estado} (6/8 a 2×)`);
    assert(v.seguridad.estado === 'REFUTADA', 'E/seg');
  }
  // Caso F: S1 cede por cupo global → manda S2 (sana).
  {
    const v = corre(dir => { for (const s of SEMILLAS) {
      fabricaReplica(join(dir, `CTRL-${s}`), { ...base, desg: 0, nac: rep20(40), structs: mkstructs(12, 13000, 20) });
      fabricaReplica(join(dir, `TRT-${s}`), { ...base, desg: 1, nac: rep20(40), structs: mkstructs(12, 13000, 20) });
    } });
    assert(v.s1.estado === 'NO_DECIDE', `F/s1 ${v.s1.estado}`);
    assert(v.seguridad.estado === 'SOSTENIDA', `F/seg ${v.seguridad.estado} (S2 sana manda)`);
  }
  // Caso G: extinción exclusiva refuta S1.
  {
    const v = corre(dir => { SEMILLAS.forEach((s, i) => {
      fabricaReplica(join(dir, `CTRL-${s}`), { ...base, desg: 0, structs: mkstructs(12, 13000, 20) });
      const mort = rep20(30); if (i === 0) mort[19] = 0;
      fabricaReplica(join(dir, `TRT-${s}`), { ...base, desg: 1, mort, structs: mkstructs(12, 13000, 20) });
    }); });
    assert(v.s1.estado === 'REFUTADA', `G/s1 ${v.s1.estado}`);
  }
  // Caso H: procedencia estricta.
  {
    const dir = mkdtempSync(join(tmpdir(), 'eval-H-'));
    try {
      for (const s of SEMILLAS) {
        fabricaReplica(join(dir, `CTRL-${s}`), { ...base, desg: 0, structs: mkstructs(1, 0, 20) });
        fabricaReplica(join(dir, `TRT-${s}`), { ...base, desg: 1, structs: mkstructs(1, 0, 20) });
      }
      let fallo = 0;
      try { evaluar(dir, 'otro-sha'); } catch { fallo++; }
      assert(fallo === 1, 'H/sha');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  // Caso I: P2/P3 5/8 → inconclusas.
  {
    const v = corre(dir => { SEMILLAS.forEach((s, i) => {
      fabricaReplica(join(dir, `CTRL-${s}`), { ...base, desg: 0, structs: mkstructs(12, 13000, 20) });
      fabricaReplica(join(dir, `TRT-${s}`), { ...base, desg: 1, rep: rep20(i < 5 ? 2 : 1), frac: rep20(i < 5 ? 0.2 : 0.05),
        structs: mkstructs(12, 13000, i < 5 ? 40 : 20) });
    }); });
    assert(v.p2.estado === 'INCONCLUSA', `I/p2 ${v.p2.estado}`);
    assert(v.p3.estado === 'INCONCLUSA', `I/p3 ${v.p3.estado}`);
  }
  console.log('self-test: A/B/C/D/E/F/G/H/I PASS');
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) { selfTest(); return; }
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = arg('--dir'), sha = arg('--sha');
  if (!dir || !sha) throw new Error('Uso: evaluar-desg-d.mts --dir <cribado> --sha <lab-sha> [--json out] [--self-test]');
  const v = evaluar(dir, sha);
  for (const p of v.pares as Record<string, unknown>[]) console.log(JSON.stringify(p));
  for (const k of ['p1', 'p2', 'p3', 's1', 's2', 'seguridad'] as const) console.log(`${k.toUpperCase()}: ${v[k].estado} — ${v[k].detalle}`);
  console.log(`DECISIÓN: ${v.decision}`);
  const out = arg('--json');
  if (out) { writeFileSync(out, JSON.stringify(v, null, 2) + '\n'); console.log(`JSON → ${out}`); }
}

if (process.argv[1]?.endsWith('evaluar-desg-d.mts')) main();
