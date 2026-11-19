import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createWorld, stepWorld, TICKS_PER_DAY, type World } from '../../src/world/index.js';
import { parseParams, paramsOf } from '../../src/world/params.js';
import { policyDiversity } from '../../src/world/politica.js';
import { analyzeTechnologicalComplexity } from '../../src/world/tecnologia-complejidad.js';
import { Gobernador } from '../../src/server/governor.js';

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

const V11_PARAMS = [
  'social.radioConvivencia=12',
  'social.disolucion=1',
  'social.maxComunidades=64',
  'limites.comunidades=4096',
  'limites.teselasActivas=524288',
  'limites.chunks=2048',
  'motor.clonPorPaso=false',
  'motor.soaTerreno=true',
  'gobernador.politica=techo',
  'gobernador.presupuestoMs=100',
].join(',');

const V12_PARAMS = [
  'poblacion.natalidadVecindad=true',
  'poblacion.radioVecindadNatalidad=16',
  'social.radioConvivencia=12',
  'social.disolucion=1',
  'social.maxComunidades=0',
  'conducta.aptitud=0.35',
  'conducta.politicaPeso=0.35',
  'tecnologia.evitarNoOp=true',
  'tecnologia.dosisCuanto=50',
  'tecnologia.enfriamiento=240',
  'limites.comunidades=4096',
  'limites.teselasActivas=524288',
  'limites.chunks=2048',
  'motor.clonPorPaso=false',
  'motor.soaTerreno=true',
  'gobernador.politica=techo',
  'gobernador.presupuestoMs=100',
].join(',');

function behavioralDiversity(world: World): { pairwise: number; activeActions: number; entropy: number } {
  const actions = new Set<string>();
  const profiles: Record<string, number>[] = [];
  const globalCounts = new Map<string, number>();
  let globalSum = 0;
  for (const p of world.people) {
    let sum = 0;
    for (const [k, v] of Object.entries(p.activity)) {
      if (v > 0) { sum += v; actions.add(k); globalCounts.set(k, (globalCounts.get(k) ?? 0) + v); globalSum += v; }
    }
    if (sum >= 3) {
      const norm: Record<string, number> = {};
      for (const [k, v] of Object.entries(p.activity)) if (v > 0) norm[k] = v / sum;
      profiles.push(norm);
    }
  }
  const keys = [...actions];
  let entropy = 0;
  if (globalSum > 0) {
    for (const v of globalCounts.values()) {
      const prob = v / globalSum;
      entropy -= prob * Math.log2(prob);
    }
  }
  if (profiles.length < 2 || keys.length === 0) return { pairwise: 0, activeActions: keys.length, entropy };
  const stride = Math.max(1, Math.floor(profiles.length / 150));
  const sample = stride === 1 ? profiles : profiles.filter((_, i) => i % stride === 0);
  let distSum = 0, pairs = 0;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      let l1 = 0;
      for (const k of keys) l1 += Math.abs((sample[i]![k] ?? 0) - (sample[j]![k] ?? 0));
      distSum += l1 / 2;
      pairs++;
    }
  }
  return { pairwise: pairs > 0 ? distSum / pairs : 0, activeActions: keys.length, entropy };
}

function runSeed(arm: 'v11' | 'v12', seed: number, days: number) {
  const t0 = performance.now();
  const params = parseParams(arm === 'v12' ? V12_PARAMS : V11_PARAMS);
  const world = createWorld(seed, params);
  const gov = new Gobernador();
  let peakPeople = world.people.length;
  let peakCommunities = 0;
  let extinctDay: number | null = null;
  const trajectory: Array<Record<string, unknown>> = [];

  for (let day = 1; day <= days; day++) {
    const tDay = performance.now();
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      const ts = performance.now();
      stepWorld(world);
      const dt = performance.now() - ts;
      gov.registrar(dt);
      world.reproductionEnabled = gov.decidir(paramsOf(world).gobernador, world.reproductionEnabled, world.people.length, world.tiles.length, world.tick);
      if (world.people.length > peakPeople) peakPeople = world.people.length;
      if (world.communities.length > peakCommunities) peakCommunities = world.communities.length;
    }
    const mortals = world.people.filter(p => p.role === 'neighbor').length;
    if (mortals === 0 && extinctDay === null) extinctDay = day;
    if (day === 1 || day % 10 === 0 || day === days) {
      const bDiv = behavioralDiversity(world);
      const pDiv = arm === 'v12' ? policyDiversity(world.people.map(p => p.policy!)) : 0;
      const tech = analyzeTechnologicalComplexity(world.technology.recipes);
      const maxGen = world.people.reduce((m, p) => Math.max(m, p.genome.generation), 0);
      const gensAlive = new Set(world.people.filter(p => p.role === 'neighbor').map(p => p.genome.generation)).size;
      const snap = {
        day, mortals, people: world.people.length, communities: world.communities.length,
        births: world.birthCounter, deaths: world.demographyDynamics.deaths,
        maxGen, gensAlive,
        tiles: world.tiles.length, structures: world.structures.length,
        policyDiversity: +pDiv.toFixed(4),
        behavioralPairwise: +bDiv.pairwise.toFixed(4),
        actionEntropy: +bDiv.entropy.toFixed(4),
        activeActions: bDiv.activeActions,
        tech,
        coop: world.totals.cooperation ?? 0, teaching: world.totals.teaching ?? 0,
        trade: world.totals.trade ?? 0, conflicts: world.totals.conflicts ?? 0,
        govZona: gov.estadoGobernador, govTecho: gov.estado.techo,
        daySec: +((performance.now() - tDay) / 1000).toFixed(2),
      };
      trajectory.push(snap);
      console.log(`[${arm.toUpperCase()} s=${seed}] d=${day}/${days} pop=${snap.people} com=${snap.communities} gen=${maxGen}(${gensAlive}g) pDiv=${snap.policyDiversity} bDiv=${snap.behavioralPairwise} tech=${tech.distinctFunctionalProfiles}p/g${tech.maxGeneration}/c${tech.compositeChainCount} gov=${snap.govZona}(${snap.govTecho}) (${snap.daySec}s)`);
    }
    if (mortals === 0) break;
  }

  const finalSnap = trajectory[trajectory.length - 1]!;
  const d20 = trajectory.find(s => s.day === 20);
  const d60 = trajectory.find(s => s.day === days) ?? finalSnap;
  const survived = extinctDay === null;
  const coopTypes = [
    (world.totals.teaching ?? 0) > 0,
    (world.totals.trade ?? 0) > 0,
    (world.totals.constructionHelp ?? 0) > 0,
    (world.totals.cooperation ?? 0) > 0,
  ].filter(Boolean).length;
  const techTransmitted = world.people.some(p => p.genome.generation > 0 && p.technology.knownRecipes.length > 0);
  return {
    arm, seed, days, survived, extinctDay,
    sec: +((performance.now() - t0) / 1000).toFixed(1),
    peakPeople, peakCommunities,
    finalPeople: world.people.length,
    finalMortals: world.people.filter(p => p.role === 'neighbor').length,
    finalCommunities: world.communities.length,
    births: world.birthCounter,
    deaths: world.demographyDynamics.deaths,
    deathCauses: world.demographyDynamics.causes,
    coopTypes,
    techTransmitted,
    behavioralDelta20toFinal: d20 ? +((Number(d60.behavioralPairwise) - Number(d20.behavioralPairwise))).toFixed(4) : null,
    policyDiversityDelta20toFinal: d20 ? +((Number(d60.policyDiversity) - Number(d20.policyDiversity))).toFixed(4) : null,
    final: finalSnap,
    trajectory,
  };
}

if (!isMainThread) {
  const { arm, seed, days } = workerData as { arm: 'v11' | 'v12'; seed: number; days: number };
  parentPort!.postMessage(runSeed(arm, seed, days));
} else {
  const arm = arg('--arm', 'v12') as 'v11' | 'v12';
  const days = Number(arg('--days', '60'));
  const seeds = arg('--seeds', '51926,42,2001,2002,2003,2004,2005,2006').split(',').map(Number);
  const out = arg('--out', `/tmp/campaign-${arm}-${days}d.json`);
  const t0 = performance.now();
  const selfPath = fileURLToPath(import.meta.url);
  const workers = seeds.map(seed => new Promise<ReturnType<typeof runSeed>>((resolve, reject) => {
    const w = new Worker(selfPath, { workerData: { arm, seed, days }, execArgv: process.execArgv });
    w.on('message', resolve);
    w.on('error', reject);
    w.on('exit', code => { if (code !== 0) reject(new Error(`Worker seed ${seed} exited ${code}`)); });
  }));
  const results = await Promise.all(workers);
  const survived = results.filter(r => r.survived);
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const summary = {
    arm, days, seeds,
    totalSec: +((performance.now() - t0) / 1000).toFixed(1),
    survivedCount: survived.length,
    totalSeeds: results.length,
    medianPeakPeople: median(survived.map(r => r.peakPeople)),
    maxPeakPeople: Math.max(...results.map(r => r.peakPeople)),
    medianFinalPeople: median(survived.map(r => r.finalPeople)),
    medianPeakCommunities: median(survived.map(r => r.peakCommunities)),
    medianPolicyDiversity: +median(survived.map(r => Number(r.final.policyDiversity))).toFixed(4),
    medianBehavioralPairwise: +median(survived.map(r => Number(r.final.behavioralPairwise))).toFixed(4),
    medianTechProfiles: median(survived.map(r => (r.final.tech as { distinctFunctionalProfiles: number }).distinctFunctionalProfiles)),
    medianTechMaxGen: median(survived.map(r => (r.final.tech as { maxGeneration: number }).maxGeneration)),
    medianTechComposites: median(survived.map(r => (r.final.tech as { compositeChainCount: number }).compositeChainCount)),
    results,
  };
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log('CAMPAIGN_SUMMARY:', JSON.stringify({ ...summary, results: results.map(r => ({ seed: r.seed, survived: r.survived, peakPeople: r.peakPeople, finalPeople: r.finalPeople, peakCom: r.peakCommunities, births: r.births, deaths: r.deaths, pDiv: r.final.policyDiversity, bDiv: r.final.behavioralPairwise, tech: r.final.tech })) }, null, 2));
}
