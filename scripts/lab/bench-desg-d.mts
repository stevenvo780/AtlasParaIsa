/**
 * Banco K1 del cribado DESG-D (tabla (e)): coste paso a paso tratamiento vs control
 * en la MISMA escena + constancia de la reactivación.
 *
 * Escena: semilla 18322 con params de tratamiento hasta el tick 5826 (32 hab, 14
 * obras; calibrado 01-10). Por lote: clon fresco de la escena congelada + setParams
 * del brazo (el clon ley-0 sobre mundo anclado es válido para tiempos: el stepper
 * ignora anclas con ley 0) y 100 pasos cronometrados; 6 lotes alternados C/T/T/C.
 * Reactivación: retirar + reanclar N/R a +D días y cronometrar maintainRegions de
 * vuelta (200 iteraciones por D; la puesta al día es aritmética fija ⇒ O(1)).
 *
 * Uso: tsx bench-desg-d.mts [--json out] [--mini]
 */
import { writeFileSync } from 'node:fs';
import { cloneWorld, createWorld, stepWorld, type World } from '../../src/world/index.js';
import { maintainRegions } from '../../src/world/spatial.js';
import { DEFAULT_PARAMS, parseParams, setParams } from '../../src/world/params.js';

const PARAMS_T = 'social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64,limites.comunidades=64,persistencia.cadaTicks=300,material.desgasteDormido=1';
const PARAMS_C = 'social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64,limites.comunidades=64,persistencia.cadaTicks=300,material.desgasteDormido=0';
const SEED = 18322, TICK_ESCENA = 5826, PASOS_LOTE = 100, LOTES = 6;

function mediana(xs: number[]): number {
  const o = [...xs].sort((a, b) => a - b);
  return o.length % 2 ? o[(o.length - 1) / 2]! : (o[o.length / 2 - 1]! + o[o.length / 2]!) / 2;
}
function p95(xs: number[]): number {
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.floor(0.95 * o.length)) ?? 0]!;
}

function escenaBase(): World {
  const w = createWorld(SEED, parseParams(PARAMS_T, DEFAULT_PARAMS));
  for (let t = 1; t <= TICK_ESCENA; t++) stepWorld(w);
  if (w.people.length < 32) throw new Error(`escena K1 sin 32 hab (tiene ${w.people.length})`);
  return w;
}

function bancoPasos(mini: boolean): { tiemposC: number[]; tiemposT: number[] } {
  const base = escenaBase();
  const leyC = parseParams(PARAMS_C, DEFAULT_PARAMS), leyT = parseParams(PARAMS_T, DEFAULT_PARAMS);
  const tiemposC: number[] = [], tiemposT: number[] = [];
  const lotes = mini ? 2 : LOTES, pasos = mini ? 10 : PASOS_LOTE;
  for (let lote = 0; lote < lotes; lote++) {
    const orden = lote % 2 === 0 ? [false, true] : [true, false]; // alternado anti-deriva
    for (const trat of orden) {
      const w = cloneWorld(base);
      setParams(w, trat ? leyT : leyC);
      const bolsa = trat ? tiemposT : tiemposC;
      for (let k = 0; k < pasos; k++) {
        const t0 = performance.now();
        stepWorld(w);
        bolsa.push(performance.now() - t0);
      }
    }
  }
  return { tiemposC, tiemposT };
}

function bancoReactivacion(mini: boolean): Record<number, number> {
  const base = escenaBase();
  const w = cloneWorld(base);
  const s = w.structures[0]!;
  const casa = w.people.map(p => ({ p, x: p.x, y: p.y }));
  const N0 = w.revisionesObra!, R0 = w.revisionesLluvia!;
  const out: Record<number, number> = {};
  const iters = mini ? 5 : 200;
  for (const dias of [1, 10, 100, 1000]) {
    const tiempos: number[] = [];
    for (let i = 0; i < iters; i++) {
      for (const p of w.people) { p.x = 1000; p.y = 1000; p.target = { x: 1000, y: 1000 }; }
      maintainRegions(w);
      if (w.structures.some(o => o.id === s.id)) throw new Error('la obra no se retiró');
      w.revisionesObra = N0 + 240 * dias; w.revisionesLluvia = R0 + 96 * dias;
      for (const { p } of casa) { p.x = s.x; p.y = s.y; p.target = { x: s.x, y: s.y }; }
      const t0 = performance.now();
      maintainRegions(w);
      tiempos.push(performance.now() - t0);
      if (!w.structures.some(o => o.id === s.id)) throw new Error('la obra no se reactivó');
    }
    out[dias] = mediana(tiempos);
    for (const { p, x, y } of casa) { p.x = x; p.y = y; p.target = { x, y }; }
  }
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const mini = argv.includes('--mini');
  const { tiemposC, tiemposT } = bancoPasos(mini);
  const medC = mediana(tiemposC), medT = mediana(tiemposT);
  const p95C = p95(tiemposC), p95T = p95(tiemposT);
  const rMed = medT / medC, rP95 = p95T / p95C;
  const react = bancoReactivacion(mini);
  const vals = Object.values(react);
  const cociente = Math.max(...vals) / Math.min(...vals);
  const k1 = !mini && rMed <= 1.05 && rP95 <= 1.10 && p95T < 50 && cociente < 2 ? 'SOSTENIDA' : mini ? 'MINI' : 'REFUTADA';
  const informe = { pasos: { nC: tiemposC.length, nT: tiemposT.length, medC, medT, p95C, p95T, rMed, rP95 },
    reactivacionMs: react, cocienteReact: cociente, k1 };
  console.log(`pasos: med C=${medC.toFixed(3)}ms T=${medT.toFixed(3)}ms (×${rMed.toFixed(3)} ≤1,05); p95 C=${p95C.toFixed(3)} T=${p95T.toFixed(3)} (×${rP95.toFixed(3)} ≤1,10; T<50ms)`);
  console.log(`reactivación 1/10/100/1000d ms: ${[1, 10, 100, 1000].map(d => react[d]!.toFixed(3)).join('/')} (cociente ${cociente.toFixed(2)} <2)`);
  console.log(`K1: ${k1}`);
  const i = argv.indexOf('--json');
  if (i >= 0 && argv[i + 1]) writeFileSync(argv[i + 1]!, JSON.stringify(informe, null, 2) + '\n');
}

if (process.argv[1]?.endsWith('bench-desg-d.mts')) main();
