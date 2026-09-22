/** Private V7/V9 diagnostic of observed default seed 51926; not a holdout or a replay of the public server.
 * Both engine sources and the unchanged family instrument are extracted from fixed Git commits.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statfsSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
// A frozen launcher remains executable without trusting the caller's cwd or HEAD.
const ROOT = existsSync(join(MODULE_DIRECTORY, 'batch.json'))
  ? JSON.parse(readFileSync(join(MODULE_DIRECTORY, 'batch.json'), 'utf8')).sourceWorkspace as string
  : resolve(MODULE_DIRECTORY, '../..');
const RESERVED = join(ROOT, 'artifacts/default-seed-v7-v9-20260922');
const BASELINE = '3dd615ee069d9d61f51a4c74f85d33c15a4583e0';
const CANDIDATE = 'cf04ac402d25179c9fa878292390e3c2aff0255e';
const SOURCE_HASHES = {
  baseline: { sourceHash: '783b2dc78b0361a51e390c2e015429a984c50f8b1b6ce73bbd941d7e4d30778d', fullHash: '776ae07aa9a037e4d656f5abfc57d5cf770792d1102698e23ef68a4f9eadb4c7' },
  candidate: { sourceHash: 'cd11a32b26ffbce2e28c6b0e9bf97196180a1219aefb0e0577b007d669603125', fullHash: '9addd8f10de65b86b579800bf31b9f2f10a39788aa9251527817de32bd9e704d' },
} as const;
const PARAMS_HASH = '272ec788ba8dbb4fdb7e813c201b4bca83298497f960097a0eecba1f512b0b6a';
const PARAMS_CAPTURE = join(ROOT, 'docs/evidencia-2026-09-22/default-seed-public-params.json');
const GIB = 1024 ** 3, MIN_FREE_BYTES = 20 * GIB, MAX_ARTIFACT_BYTES = 64 * GIB;
const SEEDS = [51926] as const;
const DAYS = 25, TICKS = DAYS * 2400, WORKERS = 2, TIMEOUT_MS = 7_200_000;
const INSTRUMENT_FILES = ['scripts/lab/family-reserve.ts', 'scripts/lab/metrics.ts', 'scripts/lab/family-observation.ts'];
type Side = 'baseline' | 'candidate';
type Status = 'success' | 'error' | 'timeout' | 'spawn-error' | 'invalid-evidence' | 'interrupted' | 'not-started';
interface Source { root: string; originSha: string; rootDirty: boolean; sourceHash: string; fullHash: string; }
interface Job { id: string; side: Side; seed: number; output: string; log: string; }
export interface Batch {
  version: 2; createdAt: string; directory: string; sourceWorkspace: string;
  days: number; ticks: number; workers: number; timeoutMs: number; engine: 'world'; params: string;
  paramsCaptureHash: string; effectiveParams: unknown; limits: { minFreeBytes: number; maxArtifactBytes: number; checkEveryMs: number };
  metricasVersion: 2; sources: Record<Side, Source>; instrumentRoot: string; instrumentHash: string; runnerHash: string; pilotHash: string;
  jobs: Job[]; scope: string;
}
interface Result { id: string; side: Side; seed: number; status: Status; code: number | null; signal: NodeJS.Signals | null; durationMs: number; message?: string; }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const capture = () => { const bytes = readFileSync(PARAMS_CAPTURE); if (hash(bytes) !== PARAMS_HASH) throw new Error('Public parameter capture hash mismatch.'); const value = JSON.parse(bytes.toString()); if (value.seed !== 51926 || value.version !== 7 || value.tick !== 53700 || value.acceptedInputRows !== 0) throw new Error('Wrong observed-world identity.'); return value; };
function validateParams(sourceRoot: string, params: unknown): void {
  const text = execFileSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, '--input-type=module', '-e', "const {parseParams}=await import(process.argv[1]); process.stdout.write(JSON.stringify(parseParams(process.argv[2])));", pathToFileURL(join(sourceRoot,'src/world/params.ts')).href, JSON.stringify(params)], {encoding:'utf8'});
  if (!isDeepStrictEqual(JSON.parse(text), params)) throw new Error('A source did not adopt every captured parameter exactly.');
}
export function artifactBytes(root: string): number {
  return readdirSync(root, {withFileTypes:true}).reduce((sum, entry) => sum + (entry.isDirectory() ? artifactBytes(join(root,entry.name)) : entry.isFile() ? (statSync(join(root,entry.name), {throwIfNoEntry:false})?.size ?? 0) : 0), 0);
}
function resourceState(directory: string) { const disk=statfsSync(directory); return {freeBytes:disk.bavail*disk.bsize,artifactBytes:artifactBytes(directory)}; }
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function files(root: string, prefix: string): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return files(root, path);
    if (!entry.isFile()) throw new Error(`Source contains an unsupported link or special file: ${path}`);
    return [path];
  });
}
function hashFiles(root: string, paths: string[]): string {
  const digest = createHash('sha256');
  for (const path of paths) digest.update(path).update('\0').update(readFileSync(join(root, path)));
  return digest.digest('hex');
}
function fullHash(root: string): string { return hashFiles(root, ['package.json', ...files(root, 'src')]); }
// Byte-for-byte contract with coherence.ts sourceDigest(), including its ordering.
function sourceHash(root: string): string {
  return hashFiles(root, ['src/world', 'src/server', 'src/shared'].flatMap(folder =>
    readdirSync(join(root, folder)).filter(file => file.endsWith('.ts')).sort().map(file => `${folder}/${file}`)));
}
function instrumentHash(root: string): string {
  const digest = createHash('sha256');
  for (const path of INSTRUMENT_FILES) digest.update(readFileSync(join(root, path)));
  return digest.digest('hex');
}
function extract(sha: string, destination: string, paths: string[]): void {
  mkdirSync(destination, { recursive: true });
  const archive = execFileSync('git', ['-C', ROOT, 'archive', sha, ...paths], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', destination], { input: archive });
}
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.next`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); renameSync(temporary, path);
}
function insideReserved(path: string): void {
  const rel = relative(RESERVED, path);
  if (!rel || rel.startsWith('..') || resolve(RESERVED, rel) !== path) throw new Error('Batch directories must be children of artifacts/default-seed-v7-v9-20260922.');
}
function sourceMetadata(root: string, sha: string, rootDirty: boolean): Source {
  // Both sources come from git archive; these hashes also pin their extracted bytes.
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  return { root, originSha: sha, rootDirty, sourceHash: sourceHash(root), fullHash: fullHash(root) };
}

export function prepare(directory: string): Batch {
  directory = resolve(directory); insideReserved(directory);
  mkdirSync(RESERVED, { recursive: true }); mkdirSync(directory); // refuses overwrite
  try {
    const sourcesRoot = join(directory, 'sources'), baselineRoot = join(sourcesRoot, 'baseline'), candidateRoot = join(sourcesRoot, 'candidate');
    extract(BASELINE, baselineRoot, ['src', 'package.json']);
    extract(CANDIDATE, candidateRoot, ['src', 'package.json']);
    for (const source of [baselineRoot, candidateRoot])
      for (const path of ['package.json', ...files(source, 'src')]) chmodSync(join(source, path), 0o444);
    const captured = capture(); validateParams(baselineRoot, captured.params); validateParams(candidateRoot, captured.params);
    for (const [source, version] of [[baselineRoot, 7], [candidateRoot, 9]] as const)
      if (!readFileSync(join(source, 'src/world/index.ts'), 'utf8').includes(`export const RULES_VERSION = ${version};`)) throw new Error('Wrong frozen rules version.');
    copyFileSync(PARAMS_CAPTURE, join(directory, 'public-params.json')); chmodSync(join(directory, 'public-params.json'), 0o444);
    const sources = { baseline: sourceMetadata(baselineRoot, BASELINE, false), candidate: sourceMetadata(candidateRoot, CANDIDATE, false) };
    const instrumentRoot = join(directory, 'instrument');
    extract(CANDIDATE, instrumentRoot, ['package.json', ...INSTRUMENT_FILES]);
    for (const path of ['package.json', ...INSTRUMENT_FILES]) chmodSync(join(instrumentRoot, path), 0o444);
    symlinkSync(join(ROOT, 'node_modules'), join(instrumentRoot, 'node_modules'), 'dir');
    const instrumentBefore = instrumentHash(instrumentRoot);
    if (instrumentBefore !== '12053834befc95ebedc4bf1bf4c4308ff49c040c21d233f585aa02d3f894f542') throw new Error('The predeclared family instrument changed.');
    const runnerHash = hash(readFileSync(fileURLToPath(import.meta.url)));
    const pilotBody = readFileSync(join(ROOT, 'scripts/lab/default-seed-pilot.ts')), pilotHash = hash(pilotBody);
    writeFileSync(join(directory, 'default-seed-pilot.ts'), pilotBody, {flag:'wx',mode:0o444});
    writeFileSync(join(directory, 'default-seed-batch.ts'), readFileSync(fileURLToPath(import.meta.url)), { flag: 'wx', mode: 0o444 });
    for (const folder of ['runs', 'logs', 'results', 'tmp']) mkdirSync(join(directory, folder));
    const jobs = SEEDS.flatMap(seed => (['baseline', 'candidate'] as const).map(side => ({
      id: `${side}-${seed}`, side, seed, output: join(directory, 'runs', `${side}-${seed}`), log: join(directory, 'logs', `${side}-${seed}.log`),
    })));
    const batch: Batch = { version: 2, createdAt: new Date().toISOString(), directory, sourceWorkspace: ROOT,
      days: DAYS, ticks: TICKS, workers: WORKERS, timeoutMs: TIMEOUT_MS, engine: 'world', params: JSON.stringify(captured.params), paramsCaptureHash: PARAMS_HASH, effectiveParams: captured.params, limits: {minFreeBytes:MIN_FREE_BYTES,maxArtifactBytes:MAX_ARTIFACT_BYTES,checkEveryMs:5000},
      metricasVersion: 2, sources, instrumentRoot, instrumentHash: instrumentBefore, runnerHash, pilotHash, jobs,
      scope: 'Observed diagnostic seed51926, V7 versus V9, 25days. New worlds without gestures or governor, not a replay or performance equivalence of the public server. Every captured parameter is adopted; SQLite every100ticks, event window24000, budget50 persisted but no governor. Two children nice -n10, two-hour symmetric deadlines. Previously observed seed, not a holdout; timeouts and resource stops remain censored.' };
    writeFileSync(join(directory, 'batch.json'), JSON.stringify(batch, null, 2) + '\n', { flag: 'wx' });
    atomicJson(join(directory, 'progress.json'), { state: 'prepared', simulationsStarted: 0, jobs: jobs.length });
    return batch;
  } catch (error) {
    writeFileSync(join(directory, 'preparation-failure.json'), JSON.stringify({ at: new Date().toISOString(), message: String(error) }, null, 2), { flag: 'wx' });
    throw error;
  }
}

export function verifyEvidence(batch: Batch, job: Job): string | undefined {
  try {
    const run = json(join(job.output, 'run.json')), source = batch.sources[job.side];
    if (run.complete !== true || run.finalTick !== batch.ticks || run.days !== batch.days || run.seed !== job.seed || run.engine !== 'world') return 'Run completion, horizon or identity disagrees with the plan.';
    if (run.metricasVersion !== 2 || run.source !== source.sourceHash || run.instrumentHash !== batch.instrumentHash || run.sha !== source.originSha) return 'Source, instrument or metric version mismatch.';
    if (!isDeepStrictEqual(run.params, batch.effectiveParams) || !existsSync(join(job.output, 'world.sqlite'))) return 'Missing production database or incorrect persistence cadence.';
    const db = new DatabaseSync(join(job.output, 'world.sqlite'), { readOnly: true });
    try {
      const snapshot = db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as { body: string; digest: string } | undefined;
      if (!snapshot || hash(snapshot.body) !== snapshot.digest) return 'Final SQLite checkpoint is absent or damaged.';
      const world = JSON.parse(snapshot.body);
      if (world.seed !== job.seed || world.version !== (job.side === 'baseline' ? 7 : 9)) return 'Final SQLite checkpoint identity disagrees with the fixed seed or rules.';
      if (world.tick !== batch.ticks || !isDeepStrictEqual(world.params, batch.effectiveParams)) return 'Final SQLite checkpoint is behind the horizon or has different laws.';
    } finally { db.close(); }
    for (let day = 1; day <= batch.days; day++) {
      const record = json(join(job.output, `day-${String(day).padStart(3, '0')}.json`));
      if (record.day !== day || record.tick !== day * 2400 || record.activity?.ventanaActividad?.desdeTickExclusivo !== (day - 1) * 2400
        || record.activity?.ventanaActividad?.hastaTickInclusivo !== day * 2400) return `Day ${day} is missing its exact durable activity interval.`;
    }
    if (existsSync(join(job.output, 'failure.json'))) return 'A failure marker accompanies nominal success.';
    if (sourceHash(source.root) !== source.sourceHash || fullHash(source.root) !== source.fullHash || instrumentHash(batch.instrumentRoot) !== batch.instrumentHash) return 'Frozen source or instrument changed during execution.';
  } catch (error) { return `Evidence unreadable: ${String(error)}`; }
  return undefined;
}
export function verifyPlan(batch: Batch): void {
  if (batch.instrumentHash !== '12053834befc95ebedc4bf1bf4c4308ff49c040c21d233f585aa02d3f894f542') throw new Error('The instrument is not the predeclared V8 instrument.');
  insideReserved(batch.directory);
  if (batch.version !== 2 || batch.days !== DAYS || batch.ticks !== TICKS || batch.workers !== WORKERS
    || batch.timeoutMs !== TIMEOUT_MS || batch.engine !== 'world' || batch.params !== JSON.stringify(capture().params) || !isDeepStrictEqual(batch.effectiveParams,capture().params) || batch.paramsCaptureHash !== PARAMS_HASH || hash(readFileSync(join(batch.directory,'public-params.json'))) !== PARAMS_HASH || !isDeepStrictEqual(batch.limits,{minFreeBytes:MIN_FREE_BYTES,maxArtifactBytes:MAX_ARTIFACT_BYTES,checkEveryMs:5000}) || batch.metricasVersion !== 2 || batch.jobs.length !== SEEDS.length * 2) throw new Error('Unsupported batch contract.');
  const expected = new Set(SEEDS.flatMap(seed => [`baseline-${seed}`, `candidate-${seed}`]));
  for (const job of batch.jobs) {
    if (!expected.delete(job.id) || job.id !== `${job.side}-${job.seed}` || job.output !== join(batch.directory, 'runs', job.id)
      || job.log !== join(batch.directory, 'logs', `${job.id}.log`) || existsSync(job.output) || existsSync(job.log)) throw new Error(`Invalid or already started job: ${job.id}`);
  }
  for (const side of ['baseline', 'candidate'] as const) if (batch.sources[side].sourceHash !== SOURCE_HASHES[side].sourceHash || batch.sources[side].fullHash !== SOURCE_HASHES[side].fullHash) throw new Error('Source hashes do not identify the predeclared commits.');
  for (const source of Object.values(batch.sources)) if (sourceHash(source.root) !== source.sourceHash || fullHash(source.root) !== source.fullHash) throw new Error('Frozen source hash differs from preparation.');
  if (batch.sources.baseline.originSha !== BASELINE || batch.sources.candidate.originSha !== CANDIDATE || batch.sources.candidate.rootDirty || batch.sources.baseline.rootDirty || batch.sourceWorkspace !== ROOT) throw new Error('Frozen revision or source workspace differs from the contract.');
  for (const source of Object.values(batch.sources)) validateParams(source.root,batch.effectiveParams);
  if (instrumentHash(batch.instrumentRoot) !== batch.instrumentHash) throw new Error('Instrument differs from preparation; prepare a fresh batch.');
  if (hash(readFileSync(fileURLToPath(import.meta.url))) !== batch.runnerHash
    || hash(readFileSync(join(batch.directory, 'default-seed-batch.ts'))) !== batch.runnerHash
    || hash(readFileSync(join(batch.directory, 'default-seed-pilot.ts'))) !== batch.pilotHash) throw new Error('Frozen batch runner or pilot differs from preparation.');
}

export function classifyOutcome(code: number | null, flags: { timedOut?: boolean; interrupted?: boolean; spawnError?: boolean; invalidEvidence?: boolean }): Status {
  return flags.timedOut ? 'timeout' : flags.interrupted ? 'interrupted' : flags.spawnError ? 'spawn-error'
    : code !== 0 ? 'error' : flags.invalidEvidence ? 'invalid-evidence' : 'success';
}

export async function run(batch: Batch): Promise<Result[]> {
  verifyPlan(batch);
  const pilot = json(join(batch.directory,'pilot.json'));
  if (pilot.passed !== true || pilot.pilotHash !== batch.pilotHash || pilot.batchHash !== hash(readFileSync(join(batch.directory,'batch.json')))) throw new Error('Exact paired pilot has not passed for this manifest.');
  writeFileSync(join(batch.directory, 'started.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid }, null, 2), { flag: 'wx' });
  const results: Result[] = [], active = new Map<ChildProcess, () => void>();
  let cursor = 0, interrupted = false, stopReason: string | undefined;
  const stop = (reason: string) => { interrupted = true; stopReason ??= reason; for (const abort of active.values()) abort(); };
  const guard = () => { try { const state=resourceState(batch.directory); if (state.freeBytes < MIN_FREE_BYTES || state.artifactBytes >= MAX_ARTIFACT_BYTES) { atomicJson(join(batch.directory,'resource-stop.json'),{at:new Date().toISOString(),...state}); stop('Disk resource budget reached (20GiB free / 64GiB artifacts).'); } } catch(error) { stop('Resource guard failed: '+String(error)); } };
  guard(); const watchdog=setInterval(guard,batch.limits.checkEveryMs); watchdog.unref();
  const onInterrupt = () => stop('SIGINT received'), onTerminate = () => stop('SIGTERM received');
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  const progress = () => atomicJson(join(batch.directory, 'progress.json'), { state: interrupted ? 'interrupting' : 'running',
    completed: results.length, running: active.size, queued: batch.jobs.length - cursor,
    counts: Object.fromEntries([...new Set(results.map(result => result.status))].map(status => [status, results.filter(result => result.status === status).length])) });
  async function launch(job: Job): Promise<Result> {
    const started = performance.now(), fd = openSync(job.log, 'wx');
    let child: ChildProcess;
    try {
      child = spawn('nice', ['-n', '10', process.execPath, '--import', pathToFileURL(join(batch.sourceWorkspace, 'node_modules/tsx/dist/loader.mjs')).href, join(batch.instrumentRoot, 'scripts/lab/family-reserve.ts'),
        '--root', batch.sources[job.side].root, '--revision', batch.sources[job.side].originSha, '--seed', String(job.seed), '--days', String(batch.days), '--engine', 'world', '--params', batch.params, '--output', job.output],
      { cwd: batch.sources[job.side].root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, CARTA_DATA_DIR: job.output, TMPDIR: join(batch.directory, 'tmp') } });
    } catch (error) {
      closeSync(fd); return { ...job, status: 'spawn-error', code: null, signal: null, durationMs: performance.now() - started, message: String(error) };
    }
    closeSync(fd);
    return await new Promise(resolveResult => {
      let timedOut = false, aborted = false, spawnError: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
      const terminate = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 5000); };
      active.set(child, () => { aborted = true; terminate(); });
      const timer = setTimeout(() => { timedOut = true; terminate(); }, batch.timeoutMs);
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => {
        clearTimeout(timer); active.delete(child);
        // A wrapper can exit before its group. Keep escalation after termination.
        if (!timedOut && !aborted) clearTimeout(killTimer);
        const evidenceError = code === 0 && !timedOut && !aborted && !spawnError ? verifyEvidence(batch, job) : undefined;
        const status = classifyOutcome(code, { timedOut, interrupted: aborted, spawnError: !!spawnError, invalidEvidence: !!evidenceError });
        resolveResult({ id: job.id, side: job.side, seed: job.seed, status, code, signal, durationMs: performance.now() - started,
          ...(spawnError || evidenceError || aborted ? { message: String(spawnError ?? evidenceError ?? stopReason) } : {}) });
      });
      try { progress(); } catch (error) { stop(`Cannot record progress: ${String(error)}`); }
    });
  }
  try {
    await Promise.all(Array.from({ length: batch.workers }, async () => {
      while (!interrupted && cursor < batch.jobs.length) {
        let job: Job | undefined;
        try {
          // Leave disk headroom for the live server; never delete another run to make space.
          const disk = statfsSync(batch.directory);
          if (disk.bavail * disk.bsize < MIN_FREE_BYTES || artifactBytes(batch.directory) >= MAX_ARTIFACT_BYTES) { stop('Disk resource budget reached before launch'); break; }
          job = batch.jobs[cursor++]!;
          const result = await launch(job);
          results.push(result); writeFileSync(join(batch.directory, 'results', `${job.id}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
          progress(); console.log(JSON.stringify({ completed: results.length, total: batch.jobs.length, id: job.id, status: result.status, durationMs: result.durationMs }));
        } catch (error) {
          if (job && !results.some(result => result.id === job!.id)) results.push({ id: job.id, side: job.side, seed: job.seed, status: 'error', code: null, signal: null, durationMs: 0, message: `Runner failure: ${String(error)}` });
          stop(`Runner failure: ${String(error)}`);
        }
      }
    }));
    for (const job of batch.jobs.slice(cursor)) {
      const result: Result = { id: job.id, side: job.side, seed: job.seed, status: 'not-started', code: null, signal: null, durationMs: 0, message: stopReason ?? 'Batch interrupted before launch.' };
      results.push(result); writeFileSync(join(batch.directory, 'results', `${job.id}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    }
    const allSucceeded = results.length === batch.jobs.length && results.every(result => result.status === 'success');
    atomicJson(join(batch.directory, 'summary.json'), { finishedAt: new Date().toISOString(), allSucceeded, interrupted, stopReason, results });
    atomicJson(join(batch.directory, 'progress.json'), { state: allSucceeded ? 'succeeded' : interrupted ? 'interrupted' : 'failed', completed: results.length, allSucceeded, stopReason });
    return results;
  } finally { clearInterval(watchdog); process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); }
}

async function main() {
  const [mode, directory, ...extra] = process.argv.slice(2);
  if (extra.length || !['prepare', 'run', 'check'].includes(mode ?? '') || (mode !== 'prepare' && !directory)) throw new Error('Usage: tsx scripts/lab/default-seed-batch.ts prepare [new-directory] | check batch-directory | run batch-directory');
  if (mode === 'prepare') {
    const batch = prepare(directory ?? join(RESERVED, `batch-${stamp()}`));
    console.log(JSON.stringify({ state: 'prepared', directory: batch.directory, simulationsStarted: 0, jobs: batch.jobs.length, ticks: TICKS * SEEDS.length * 2, workers: WORKERS, timeoutSeconds: TIMEOUT_MS / 1000 }));
  } else {
    const batch = json(join(resolve(directory!), 'batch.json')) as Batch;
    if (batch.directory !== resolve(directory!)) throw new Error('Batch manifest does not belong to this directory.');
    if (mode === 'check') { verifyPlan(batch); console.log(JSON.stringify({ state: 'ready', simulationsStarted: 0, directory: batch.directory })); }
    else { const results = await run(batch); if (results.some(result => result.status !== 'success')) process.exitCode = 1; }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
