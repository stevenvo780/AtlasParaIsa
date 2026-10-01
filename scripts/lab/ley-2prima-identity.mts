/** Objective 10: independent full-digest identity instrument. No evaluator is changed.
 * Run only through the externally authorized codex10 resource launcher.
 * --selftest never calls stepWorld; --run requires the literal authorization token. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { World, Person } from '../../src/world/index.js';
import type { WorldParams } from '../../src/world/params.js';

export const LAB = '/datos/tmp-atlas-lab';
export const CANDIDATE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BASELINE = `${LAB}/balance/codex10/main-source`;
export const CONTRACT = `${LAB}/balance/codex10/CONTRATO-PREVIO.md`;
export const CONTRACT_SHA = '76a58199576faa17ff830be81075ef540d0d1790f542995eb56903ca5660b242';
export const BASELINE_ARCHIVE_SHA = '2f9b1641db786ee4dedf70220a4ba926ea61a2a7d5c5f397a7482dd31e468098';
export const BASELINE_RECORD = `${LAB}/balance/codex10/BASELINE.json`;
export const BASELINE_RECORD_SHA = 'c89d36246989d5e9d85535e4588275e97b48354ed4975f78eb2a73311c3f948c';
export const ACTIONS = ['gather', 'forage', 'hunt', 'farm', 'build', 'repair', 'research', 'craft'] as const;
export type Productive = typeof ACTIONS[number];
export type LocalPerson = Person & { utilidadLocal?: Partial<Record<Productive, { q: number; intentos: number }>> };
export const IDENTITY_PROTOCOL = Object.freeze({
  version: 'ley-2prima-identity-1', seeds: [19011, 19012, 19013, 19014, 19015, 19016], steps: 1200,
  profiles: [
    { name: 'defaults', overrides: {} },
    { name: 'social-v13', overrides: { 'social.radioConvivencia': 12, 'social.disolucion': 1, 'social.maxComunidades': 64 } },
  ], arms: ['baseline-main', 'candidate-absent', 'candidate-explicit-zero'],
  compare: 'unchanged digestoCanonico at initial state and every single step; no field excluded',
  optionalExactV13: 'not requested by this instrument; the two mandatory profiles are always run',
});
export function sha(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function fileSha(path: string): string { return sha(readFileSync(path)); }
export function stableJson(value: unknown): string {
  const sorted = (x: unknown): unknown => Array.isArray(x) ? x.map(sorted)
    : x !== null && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)])) : x;
  return JSON.stringify(sorted(value));
}
export function resourceGuard() {
  const threads = readdirSync('/proc/self/task').map(tid => {
    const stat = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8');
    const status = readFileSync(`/proc/self/task/${tid}/status`, 'utf8');
    const nice = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[16]);
    const allowed = status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? '';
    const cpus = allowed.split(',').flatMap(part => {
      const [lo, hi = lo] = part.split('-').map(Number);
      return lo === undefined || hi === undefined || !Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo ? [] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    });
    return { tid: Number(tid), nice, allowed, okay: nice === 19 && cpus.length > 0 && cpus.every(cpu => cpu >= 6 && cpu <= 31) };
  });
  assert(threads.length > 0 && threads.every(t => t.okay), `Resource guard failed: ${JSON.stringify(threads)}`);
  assert.equal(process.env.TMPDIR, LAB, 'TMPDIR must be the laboratory directory');
  assert.equal(realpathSync('/proc/self/exe'), realpathSync(`${LAB}/codex10-runtime/codex10-node`), 'Copied codex10 runtime required');
  return { at: new Date().toISOString(), threads, tmpdir: process.env.TMPDIR, runtimeSha: fileSha('/proc/self/exe') };
}
export function sourceManifest(root: string) {
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${path}/${e.name}`) : [`${path}/${e.name}`]);
  const paths = ['src/world', 'src/shared', 'src/server'].flatMap(p => walk(`${root}/${p}`)).concat(`${root}/package.json`, `${root}/tsconfig.json`).sort();
  const files = paths.map(path => ({ path: relative(root, path), sha256: fileSha(path) }));
  return { root, count: files.length, files, sha256: sha(stableJson(files)) };
}
export function frozenEvidence() {
  assert.equal(fileSha(CONTRACT), CONTRACT_SHA, 'Frozen contract changed');
  assert.equal(fileSha(`${LAB}/balance/codex10/main-source.tar`), BASELINE_ARCHIVE_SHA, 'Baseline archive changed');
  assert.equal(fileSha(BASELINE_RECORD), BASELINE_RECORD_SHA, 'Frozen baseline record changed');
  const record = JSON.parse(readFileSync(BASELINE_RECORD, 'utf8')) as { source: Record<string, string>; inputs: Record<string, string> };
  for (const [path, expected] of Object.entries(record.inputs)) assert.equal(fileSha(path), expected, `Frozen input changed: ${path}`);
  const permitted = new Set(['src/world/index.ts', 'src/world/params.ts', 'src/world/utilidad-local.ts']);
  for (const [path, expected] of Object.entries(record.source)) {
    assert.equal(fileSha(`${BASELINE}/${path}`), expected, `Extracted baseline changed: ${path}`);
    if (!permitted.has(path)) assert.equal(fileSha(`${CANDIDATE}/${path}`), expected, `Protected source changed: ${path}`);
  }
  const baseline = sourceManifest(BASELINE), candidate = sourceManifest(CANDIDATE);
  const allowedNames = new Set([...Object.keys(record.source), 'package.json', 'tsconfig.json', 'src/world/utilidad-local.ts']);
  assert(candidate.files.every(file => allowedNames.has(file.path)), 'Unexpected candidate source file');
  assert(baseline.files.every(file => allowedNames.has(file.path)), 'Unexpected extracted baseline source file');
  for (const path of ['package.json', 'tsconfig.json']) assert.equal(fileSha(`${CANDIDATE}/${path}`), fileSha(`${BASELINE}/${path}`), `Protected configuration changed: ${path}`);
  const tests = readdirSync(`${CANDIDATE}/tests`).filter(name => name.includes('utilidad') || name.includes('2prima')).sort()
    .map(name => ({ name, sha256: fileSha(`${CANDIDATE}/tests/${name}`) }));
  const scenesDoc = `${LAB}/balance/codex10/ESCENAS-COSTE-PREVIO.md`;
  return { contractSha: CONTRACT_SHA, baselineArchiveSha: BASELINE_ARCHIVE_SHA, baselineRecordSha: BASELINE_RECORD_SHA,
    baseline, candidate, newTests: tests, frozenInputs: record.inputs, scenesDoc: { path: scenesDoc, sha256: fileSha(scenesDoc) },
    instruments: ['ley-2prima-identity.mts', 'ley-2prima-cost.mts'].map(name => ({ name, sha256: fileSha(`${CANDIDATE}/scripts/lab/${name}`) })) };
}
export type Graph = {
  root: string;
  world: typeof import('../../src/world/index.js');
  params: typeof import('../../src/world/params.js');
  digest: typeof import('../../src/world/digesto.js');
  inventions: typeof import('../../src/world/inventions.js');
  technology: typeof import('../../src/world/technology.js');
  animals: typeof import('../../src/world/animals.js');
  catalogue: typeof import('../../src/world/technology-catalogue.js');
  store: typeof import('../../src/server/store.js');
};
export async function graph(root: string): Promise<Graph> {
  const module = (path: string) => import(pathToFileURL(`${root}/${path}.ts`).href);
  const [world, params, digest, inventions, technology, animals, catalogue, store] = await Promise.all([
    module('src/world/index'), module('src/world/params'), module('src/world/digesto'),
    module('src/world/inventions'), module('src/world/technology'), module('src/world/animals'), module('src/world/technology-catalogue'), module('src/server/store'),
  ]);
  return { root, world, params, digest, inventions, technology, animals, catalogue, store } as Graph;
}
export function writeNew(path: string, value: unknown): void {
  const target = resolve(path);
  assert(target.startsWith(`${LAB}/balance/codex10/`) && !target.includes('/../'), 'Output must stay in own external laboratory area');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
export function verifyTrace(traces: string[][], steps: number): void {
  assert.equal(traces.length, 3, 'All three identity arms required');
  for (const trace of traces) {
    assert.equal(trace.length, steps + 1, 'Incomplete trace');
    assert(trace.every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)), 'Missing/malformed digest');
  }
  for (let tick = 0; tick <= steps; tick++) for (let arm = 1; arm < traces.length; arm++)
    assert.equal(traces[arm]![tick], traces[0]![tick], `Identity divergence at step ${tick}, arm ${arm}`);
}
export function identitySelftest() {
  const a = sha('initial'), b = sha('step');
  verifyTrace([[a, b], [a, b], [a, b]], 1);
  assert.throws(() => verifyTrace([[a, b], [a, sha('deliberate divergence')], [a, b]], 1), /divergence/);
  assert.throws(() => verifyTrace([[a, b], [a], [a, b]], 1), /Incomplete/);
  assert.throws(() => verifyTrace([[a, b], [a, ''], [a, b]], 1), /Missing/);
  assert.throws(() => verifyTrace([[a, b], [a, b]], 1), /three/);
  return { status: 'PASS', positive: 1, negative: 4, realSteps: 0, synthetic: true };
}
async function runIdentity() {
  const initialGuard = resourceGuard(), before = frozenEvidence();
  const [baseline, candidate] = await Promise.all([graph(BASELINE), graph(CANDIDATE)]);
  const cases = [];
  for (const profile of IDENTITY_PROTOCOL.profiles) for (const seed of IDENTITY_PROTOCOL.seeds) {
    const graphs = [baseline, candidate, candidate];
    const params = [baseline.params.parseParams(profile.overrides), candidate.params.parseParams(profile.overrides),
      candidate.params.parseParams({ ...profile.overrides, 'conducta.utilidadLocal': 0 })];
    const worlds = graphs.map((g, i) => g.world.createWorld(seed, params[i] as WorldParams));
    const traces = worlds.map((w, i) => [graphs[i]!.digest.digestoCanonico(w)]);
    verifyTrace(traces, 0);
    for (let step = 1; step <= IDENTITY_PROTOCOL.steps; step++) {
      for (let arm = 0; arm < graphs.length; arm++) {
        const g = graphs[arm]!, w = worlds[arm]!;
        g.world.stepWorld(w);
        assert(w.people.every(p => !Object.hasOwn(p, 'utilidadLocal')), 'Inactive law introduced personal state');
        traces[arm]!.push(g.digest.digestoCanonico(w));
      }
      assert.equal(traces[1]![step], traces[0]![step], `${profile.name} seed ${seed} step ${step}: absent differs`);
      assert.equal(traces[2]![step], traces[0]![step], `${profile.name} seed ${seed} step ${step}: zero differs`);
      if (step % 100 === 0) resourceGuard();
    }
    verifyTrace(traces, IDENTITY_PROTOCOL.steps);
    cases.push({ profile: profile.name, seed, steps: IDENTITY_PROTOCOL.steps, effectiveParams: params, traces });
  }
  const after = frozenEvidence();
  assert.deepEqual(after, before, 'Sources changed during identity run');
  return { instrument: 'ley-2prima-identity', protocol: IDENTITY_PROTOCOL, protocolSha: sha(stableJson(IDENTITY_PROTOCOL)),
    status: 'PASS', cases, casesCount: cases.length, totalRealSteps: cases.length * 3 * IDENTITY_PROTOCOL.steps,
    before, after, guards: { initial: initialGuard, final: resourceGuard() }, limits: '1200-step technical identity, not biological screening or acceptance of the active law' };
}
async function main() {
  const args = process.argv.slice(2), out = args[args.indexOf('--out') + 1];
  resourceGuard();
  let result: unknown;
  if (args.includes('--selftest')) result = { selftest: identitySelftest(), sources: frozenEvidence(), guards: { final: resourceGuard() } };
  else {
    assert(args.includes('--run') && args.includes('--authorized-identity-19011-19016x1200'), 'Real identity run not authorized');
    assert(out && args.includes('--out'), 'An exclusive output path is required');
    result = await runIdentity();
  }
  if (args.includes('--out')) { assert(out); writeNew(out, result); }
  else process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error); process.exitCode = 1; });
