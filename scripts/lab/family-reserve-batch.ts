/** Predeclared V7/V8 family-reserve audit. Independent of the reserved 30-day batch.
 * Both sides use one frozen coherence.ts + metrics.ts and retain every database.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RESERVED = join(ROOT, 'artifacts/family-reserve-v8-20260922');
const BASELINE = '3dd615ee069d9d61f51a4c74f85d33c15a4583e0';
const SEEDS = [1007, 1012, 1013] as const;
const DAYS = 13, TICKS = DAYS * 2400, WORKERS = 6, TIMEOUT_MS = 3_600_000;
const INSTRUMENT_FILES = ['scripts/lab/family-reserve.ts', 'scripts/lab/metrics.ts', 'scripts/lab/family-observation.ts'];
type Side = 'baseline' | 'candidate';
type Status = 'success' | 'error' | 'timeout' | 'spawn-error' | 'invalid-evidence' | 'interrupted' | 'not-started';
interface Source { root: string; originSha: string; rootDirty: boolean; sourceHash: string; fullHash: string; }
interface Job { id: string; side: Side; seed: number; output: string; log: string; }
export interface Batch {
  version: 1; createdAt: string; directory: string; sourceWorkspace: string;
  days: number; ticks: number; workers: number; timeoutMs: number; engine: 'world'; params: string;
  metricasVersion: 2; sources: Record<Side, Source>; instrumentRoot: string; instrumentHash: string; runnerHash: string;
  jobs: Job[]; scope: string;
}
interface Result { id: string; side: Side; seed: number; status: Status; code: number | null; signal: NodeJS.Signals | null; durationMs: number; message?: string; }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
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
function copy(root: string, destination: string, paths: string[]): void {
  for (const path of paths) {
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    copyFileSync(join(root, path), join(destination, path)); chmodSync(join(destination, path), 0o444);
  }
}
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.next`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); renameSync(temporary, path);
}
function insideReserved(path: string): void {
  const rel = relative(RESERVED, path);
  if (!rel || rel.startsWith('..') || resolve(RESERVED, rel) !== path) throw new Error('Batch directories must be children of artifacts/family-reserve-v8-20260922.');
}
function sourceMetadata(root: string, sha: string, rootDirty: boolean): Source {
  // The origin commit is provenance, not a claim that dirty candidate files equal
  // that commit. The two content hashes identify the actual frozen implementation.
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  return { root, originSha: sha, rootDirty, sourceHash: sourceHash(root), fullHash: fullHash(root) };
}

export function prepare(directory: string): Batch {
  directory = resolve(directory); insideReserved(directory);
  mkdirSync(RESERVED, { recursive: true }); mkdirSync(directory); // refuses overwrite
  try {
    const sourcesRoot = join(directory, 'sources'), baselineRoot = join(sourcesRoot, 'baseline'), candidateRoot = join(sourcesRoot, 'candidate');
    mkdirSync(baselineRoot, { recursive: true }); mkdirSync(candidateRoot);
    const archive = execFileSync('git', ['-C', ROOT, 'archive', BASELINE, 'src', 'package.json'], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', baselineRoot], { input: archive });
    for (const path of ['package.json', ...files(baselineRoot, 'src')]) chmodSync(join(baselineRoot, path), 0o444);
    const before = fullHash(ROOT), origin = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    copy(ROOT, candidateRoot, ['package.json', ...files(ROOT, 'src')]);
    if (before !== fullHash(ROOT) || before !== fullHash(candidateRoot)) throw new Error('Candidate source changed while copying; prepare a fresh batch once stable.');
    if (!/export const RULES_VERSION = 8;/.test(readFileSync(join(candidateRoot, 'src/world/index.ts'), 'utf8'))) throw new Error('Candidate must declare rules V8.');
    const rootDirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'src', 'package.json'], { encoding: 'utf8' }).trim().length > 0;
    const sources = { baseline: sourceMetadata(baselineRoot, BASELINE, false), candidate: sourceMetadata(candidateRoot, origin, rootDirty) };
    const instrumentRoot = join(directory, 'instrument'), instrumentBefore = instrumentHash(ROOT);
    copy(ROOT, instrumentRoot, ['package.json', ...INSTRUMENT_FILES]);
    symlinkSync(join(ROOT, 'node_modules'), join(instrumentRoot, 'node_modules'), 'dir');
    if (instrumentBefore !== instrumentHash(ROOT) || instrumentBefore !== instrumentHash(instrumentRoot)) throw new Error('Instrument changed while copying.');
    const runnerHash = hash(readFileSync(fileURLToPath(import.meta.url)));
    writeFileSync(join(directory, 'family-reserve-batch.ts'), readFileSync(fileURLToPath(import.meta.url)), { flag: 'wx', mode: 0o444 });
    for (const folder of ['runs', 'logs', 'results', 'tmp']) mkdirSync(join(directory, folder));
    const jobs = SEEDS.flatMap(seed => (['baseline', 'candidate'] as const).map(side => ({
      id: `${side}-${seed}`, side, seed, output: join(directory, 'runs', `${side}-${seed}`), log: join(directory, 'logs', `${side}-${seed}.log`),
    })));
    const batch: Batch = { version: 1, createdAt: new Date().toISOString(), directory, sourceWorkspace: ROOT,
      days: DAYS, ticks: TICKS, workers: WORKERS, timeoutMs: TIMEOUT_MS, engine: 'world', params: 'persistencia.cadaTicks=20',
      metricasVersion: 2, sources, instrumentRoot, instrumentHash: instrumentBefore, runnerHash, jobs,
      scope: 'Three predeclared pairs 1007/1012/1013, 13 days, V7 versus V8. 1007 is a diagnostic seed, not a holdout. Six children at nice 10, identical one-hour deadlines. stepWorld and production SQLite every 20 ticks; no governor, scheduler, clients or network. Concurrent timings are not a server performance gate.' };
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
    if (run.params?.persistencia?.cadaTicks !== 20 || !existsSync(join(job.output, 'world.sqlite'))) return 'Missing production database or incorrect persistence cadence.';
    const db = new DatabaseSync(join(job.output, 'world.sqlite'), { readOnly: true });
    try {
      const snapshot = db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as { body: string; digest: string } | undefined;
      if (!snapshot || hash(snapshot.body) !== snapshot.digest || JSON.parse(snapshot.body).tick !== batch.ticks) return 'Final SQLite checkpoint is absent, damaged or behind the horizon.';
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
  insideReserved(batch.directory);
  if (batch.version !== 1 || batch.days !== DAYS || batch.ticks !== TICKS || batch.workers < 1 || batch.workers > WORKERS || !Number.isInteger(batch.workers)
    || batch.timeoutMs !== TIMEOUT_MS || batch.engine !== 'world' || batch.params !== 'persistencia.cadaTicks=20' || batch.metricasVersion !== 2 || batch.jobs.length !== SEEDS.length * 2) throw new Error('Unsupported batch contract.');
  const expected = new Set(SEEDS.flatMap(seed => [`baseline-${seed}`, `candidate-${seed}`]));
  for (const job of batch.jobs) {
    if (!expected.delete(job.id) || job.id !== `${job.side}-${job.seed}` || job.output !== join(batch.directory, 'runs', job.id)
      || job.log !== join(batch.directory, 'logs', `${job.id}.log`) || existsSync(job.output) || existsSync(job.log)) throw new Error(`Invalid or already started job: ${job.id}`);
  }
  for (const source of Object.values(batch.sources)) if (sourceHash(source.root) !== source.sourceHash || fullHash(source.root) !== source.fullHash) throw new Error('Frozen source hash differs from preparation.');
  if (batch.sources.baseline.originSha !== BASELINE || batch.sources.candidate.fullHash !== fullHash(batch.sourceWorkspace)) throw new Error('Baseline revision differs or candidate workspace has changed; prepare a fresh batch.');
  if (instrumentHash(batch.instrumentRoot) !== batch.instrumentHash || instrumentHash(batch.sourceWorkspace) !== batch.instrumentHash) throw new Error('Instrument differs from preparation; prepare a fresh batch.');
  if (hash(readFileSync(fileURLToPath(import.meta.url))) !== batch.runnerHash) throw new Error('Batch runner differs from preparation.');
}

export function classifyOutcome(code: number | null, flags: { timedOut?: boolean; interrupted?: boolean; spawnError?: boolean; invalidEvidence?: boolean }): Status {
  return flags.timedOut ? 'timeout' : flags.interrupted ? 'interrupted' : flags.spawnError ? 'spawn-error'
    : code !== 0 ? 'error' : flags.invalidEvidence ? 'invalid-evidence' : 'success';
}

export async function run(batch: Batch): Promise<Result[]> {
  verifyPlan(batch);
  writeFileSync(join(batch.directory, 'started.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid }, null, 2), { flag: 'wx' });
  const results: Result[] = [], active = new Map<ChildProcess, () => void>();
  let cursor = 0, interrupted = false, stopReason: string | undefined;
  const stop = (reason: string) => { interrupted = true; stopReason ??= reason; for (const abort of active.values()) abort(); };
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
          if (disk.bavail * disk.bsize < 20 * 1024 ** 3) { stop('Less than 20 GiB free disk space'); break; }
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
  } finally { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); }
}

async function main() {
  const [mode, directory, ...extra] = process.argv.slice(2);
  if (extra.length || !['prepare', 'run', 'check'].includes(mode ?? '') || (mode !== 'prepare' && !directory)) throw new Error('Usage: tsx scripts/lab/family-reserve-batch.ts prepare [new-directory] | check batch-directory | run batch-directory');
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
