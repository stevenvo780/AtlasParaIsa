/**
 * Auditoría de emergencia v15/v16: un proceso por semilla, Store real y resumen agregado.
 * Uso: node --import tsx scripts/lab/auditoria-emergencia.ts [--seeds 7,42,404,51926] [--dias 20] [--preset v16] [--params "a.b=1"]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/server/store.js';
import { hostOpenWorldParams } from '../../src/server/hardware-limits.js';
import { createWorld, stepWorld, TICKS_PER_DAY, type World } from '../../src/world/index.js';
import { parseParams, type WorldParams } from '../../src/world/params.js';
import { policyDiversity, type PolicyGenome } from '../../src/world/politica.js';
import { CAPABILITIES, materialCapacities } from '../../src/world/technology.js';
import { technologyCatalogueTotals } from '../../src/world/technology-catalogue.js';
import { analyzeTechnologyStateComplexity } from '../../src/world/tecnologia-complejidad.js';

const MOTOR = 'motor.hilos=1,motor.particionarPersonas=false,motor.soaTerreno=true,motor.gpu=[]';
const V15 = 'poblacion.natalidadVecindad=true,poblacion.radioVecindadNatalidad=16,social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=0,conducta.aptitud=0.35,conducta.politicaPeso=0.35,tecnologia.evitarNoOp=true,tecnologia.dosisCuanto=50,tecnologia.enfriamiento=240';
const SAMPLE = 600;
const AXES = ['sharing', 'stewardship', 'openness'] as const;

interface Axes { sharing: number; stewardship: number; openness: number }
interface Causes { starvation: number; dehydration: number; exposure: number; senescence: number }
interface Tools { cutting: number; storage: number; insulation: number; cultivation: number; binding: number; abrasion: number }
interface SeedReport {
  seed: number; days: number; popFinal: number; popPeak: number; mortalPop: number; extinct: boolean;
  births: number; deaths: number; deathCauses: Causes; maxGen: number; meanEnergy: number; meanHunger: number; meanThirst: number;
  structures: number; blueprints: number; discoveredChunks: number; activeTiles: number;
  communities: number; maxCommunitySize: number; unaffiliatedFrac: number; cultureStdev: Axes; cultureMean: Axes;
  recipesTotal: number; hotRecipes: number; hotZeroUseFrac: number; functionalDiversity: number; complexityScore: number;
  toolUses: number; observedUtility: number; techMaxGen: number; toolsByCapability: Tools;
  policyDiversity: number; baldwinL2Mean: number; policySteeredReasons: number; cooperation: number; conflicts: number; teaching: number;
  siFinalDist: number | null; siMeanDist: number | null; siMeetings: number; siZombieSamples: number; memoriesUntouched: boolean;
  msPerTickMean: number; msPerTickTail: number;
}

const n4 = (x: number) => Math.round(x * 1e4) / 1e4;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Falta el valor de ${flag}.`);
  return value;
}
function buildParams(preset: 'v15' | 'v16', extra?: string): WorldParams {
  const base = preset === 'v16' ? hostOpenWorldParams() : parseParams(V15);
  const tuned = parseParams(MOTOR, base);
  return extra === undefined ? tuned : parseParams(extra, tuned);
}
function pair(world: World): { s: World['people'][number] | undefined; i: World['people'][number] | undefined } {
  return { s: world.people.find(p => p.role === 'S'), i: world.people.find(p => p.role === 'I') };
}
function zombie(p: World['people'][number] | undefined): boolean {
  return !!p && p.energy === 0 && ((p.thirst ?? 0) > 0.9 || p.hunger > 0.9);
}
function cultureOf(people: World['people']): { mean: Axes; stdev: Axes } {
  const mean: Axes = { sharing: 0, stewardship: 0, openness: 0 };
  const stdev: Axes = { sharing: 0, stewardship: 0, openness: 0 };
  const n = people.length;
  if (!n) return { mean, stdev };
  for (const p of people) for (const k of AXES) mean[k] += p.culture[k];
  for (const k of AXES) mean[k] /= n;
  for (const p of people) for (const k of AXES) stdev[k] += (p.culture[k] - mean[k]) ** 2;
  for (const k of AXES) { stdev[k] = n4(Math.sqrt(stdev[k] / n)); mean[k] = n4(mean[k]); }
  return { mean, stdev };
}
function summarize(world: World, seed: number, days: number, popPeak: number, dists: number[], zombies: number, meetings: number, windows: number[]): SeedReport {
  const people = world.people;
  let mortal = 0, unaff = 0, energy = 0, hunger = 0, thirst = 0, maxGen = 0, steered = 0, l2 = 0, l2n = 0;
  const tools: Tools = { cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 };
  const genomes: PolicyGenome[] = [];
  for (const p of people) {
    if (p.role === 'neighbor') mortal++;
    if (!p.communityId) unaff++;
    energy += p.energy; hunger += p.hunger; thirst += p.thirst; if (p.genome.generation > maxGen) maxGen = p.genome.generation;
    if (p.reason.includes('política neuronal')) steered++;
    if (p.policy) genomes.push(p.policy);
    const bias = p.policyPlasticity?.bias;
    if (bias) { let s = 0; for (const x of bias) s += x * x; l2 += Math.sqrt(s); l2n++; }
    for (const item of p.technology.items) {
      const caps = materialCapacities(item);
      let best: keyof Tools = 'cutting';
      for (const cap of CAPABILITIES) if (caps[cap] > caps[best]) best = cap;
      tools[best]++;
    }
  }
  const n = people.length;
  const hot = world.technology.recipes;
  const cat = technologyCatalogueTotals(world);
  const culture = cultureOf(people);
  let maxCommunity = 0;
  for (const c of world.communities) if (c.members.length > maxCommunity) maxCommunity = c.members.length;
  const causes = world.demographyDynamics.causes;
  return {
    seed, days, popFinal: n, popPeak, mortalPop: mortal, extinct: mortal === 0,
    births: world.totals.births ?? 0, deaths: world.demographyDynamics.deaths,
    deathCauses: { starvation: causes.starvation, dehydration: causes.dehydration, exposure: causes.exposure, senescence: causes.senescence },
    maxGen, meanEnergy: n ? n4(energy / n) : 0, meanHunger: n ? n4(hunger / n) : 0, meanThirst: n ? n4(thirst / n) : 0,
    structures: world.structures.length, blueprints: world.blueprints.length, discoveredChunks: world.discoveredChunks, activeTiles: world.tiles.length,
    communities: world.communities.length, maxCommunitySize: maxCommunity, unaffiliatedFrac: n ? n4(unaff / n) : 0,
    cultureStdev: culture.stdev, cultureMean: culture.mean,
    recipesTotal: world.technology.recipeCounter, hotRecipes: hot.length,
    hotZeroUseFrac: hot.length ? n4(hot.filter(r => r.uses === 0).length / hot.length) : 0,
    functionalDiversity: cat.functionalDiversity, complexityScore: analyzeTechnologyStateComplexity(world.technology).complexityScore,
    toolUses: world.technology.ledger.toolUses, observedUtility: n4(cat.utility), techMaxGen: cat.maxGeneration, toolsByCapability: tools,
    policyDiversity: n4(policyDiversity(genomes)), baldwinL2Mean: l2n ? n4(l2 / l2n) : 0, policySteeredReasons: steered,
    cooperation: world.totals.cooperation ?? 0, conflicts: world.totals.conflicts ?? 0, teaching: world.totals.teaching ?? 0,
    siFinalDist: dists.length ? n4(dists[dists.length - 1]!) : null, siMeanDist: dists.length ? n4(avg(dists)) : null,
    siMeetings: meetings, siZombieSamples: zombies, memoriesUntouched: world.memories.length === 5,
    msPerTickMean: windows.length ? n4(avg(windows)) : 0, msPerTickTail: windows.length ? n4(windows[windows.length - 1]!) : 0,
  };
}
function runSeed(seed: number, days: number, params: WorldParams): SeedReport {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit-'));
  const store = new Store(join(dir, 'world.sqlite'));
  try {
    const world = createWorld(seed, params);
    store.save(world);
    const ticks = days * TICKS_PER_DAY;
    const guide = pair(world).s;
    let lastMeeting = guide?.lastMeeting ?? -1, meetings = 0, popPeak = world.people.length, zombies = 0, windowMs = 0;
    const dists: number[] = [], windows: number[] = [];
    for (let t = 1; t <= ticks; t++) {
      const t0 = performance.now();
      stepWorld(world);
      windowMs += performance.now() - t0;
      if (world.people.length > popPeak) popPeak = world.people.length;
      if (guide && guide.lastMeeting !== lastMeeting) { if (guide.lastMeeting > lastMeeting) meetings++; lastMeeting = guide.lastMeeting; }
      if (t % SAMPLE !== 0) continue;
      const { s, i } = pair(world);
      if (s && i) dists.push(Math.hypot(s.x - i.x, s.y - i.y));
      if (zombie(s) || zombie(i)) zombies++;
      windows.push(windowMs / SAMPLE); windowMs = 0;
      store.save(world);
      if (t % TICKS_PER_DAY === 0) console.error(`seed ${seed} día ${t / TICKS_PER_DAY}/${days} pop ${world.people.length} pico ${popPeak} ms/tick ${n4(windows[windows.length - 1]!)}`);
    }
    return summarize(world, seed, days, popPeak, dists, zombies, meetings, windows);
  } finally {
    try { store.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
function forkSeed(seed: number, days: number, preset: 'v15' | 'v16', extra: string | undefined): Promise<SeedReport> {
  const args = ['--import', 'tsx', fileURLToPath(import.meta.url), '--worker', String(seed), '--dias', String(days), '--preset', preset];
  if (extra !== undefined) args.push('--params', extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      const line = out.trim().split('\n').reverse().find(row => row.startsWith('{'));
      if (code !== 0 || !line) { reject(new Error(`Semilla ${seed} salió con código ${code ?? 'null'} sin JSON.`)); return; }
      resolve(JSON.parse(line) as SeedReport);
    });
  });
}
function flatten(value: unknown, prefix: string, out: Record<string, number | boolean | null>): void {
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out[prefix] = value as number | boolean | null;
}
function publish(preset: string, days: number, rows: SeedReport[]): void {
  const flats = rows.map(r => { const o: Record<string, number | boolean | null> = {}; flatten(r, '', o); return o; });
  const keys = Object.keys(flats[0] ?? {}).filter(k => k !== 'seed');
  const aggregate: Record<string, { mean: number | null; median: number | null }> = {};
  for (const key of keys) {
    const nums = flats.map(f => f[key]).map(v => typeof v === 'boolean' ? (v ? 1 : 0) : v).filter((v): v is number => typeof v === 'number');
    aggregate[key] = nums.length ? { mean: n4(avg(nums)), median: n4(median(nums)) } : { mean: null, median: null };
  }
  const head = ['métrica', ...rows.map(r => String(r.seed)), 'media', 'mediana'];
  const cell = (v: number | boolean | null | undefined) => v === null || v === undefined ? '—' : String(v);
  const line = (cells: (string | number | boolean | null | undefined)[]) => `| ${cells.map(c => cell(c as number | boolean | null)).join(' | ')} |`;
  console.log(`# Auditoría de emergencia · ${preset} · ${days} día(s) · ${rows.length} semilla(s)\n`);
  console.log(line(head));
  console.log(`| ${head.map(() => '---').join(' | ')} |`);
  for (const key of keys) console.log(line([key, ...flats.map(f => f[key]), aggregate[key]!.mean, aggregate[key]!.median]));
  console.log(`\n${JSON.stringify({ preset, days, seeds: rows, aggregate })}`);
}
async function main(): Promise<void> {
  const days = Number(arg('--dias') ?? '20');
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('--dias debe ser un entero ≥ 1.');
  const preset = arg('--preset') ?? 'v16';
  if (preset !== 'v15' && preset !== 'v16') throw new Error('--preset debe ser v15 o v16.');
  const extra = arg('--params');
  const worker = arg('--worker');
  if (worker !== undefined) {
    const seed = Number(worker);
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('--worker espera una semilla entera ≥ 0.');
    process.stdout.write(`${JSON.stringify(runSeed(seed, days, buildParams(preset, extra)))}\n`);
    return;
  }
  const raw = arg('--seeds') ?? '7,42,404,51926';
  const seeds = raw.split(',').map(s => Number(s.trim()));
  if (!seeds.length || seeds.some(s => !Number.isSafeInteger(s) || s < 0)) throw new Error(`Semillas inválidas: ${raw}`);
  publish(preset, days, await Promise.all(seeds.map(seed => forkSeed(seed, days, preset, extra))));
}
main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
