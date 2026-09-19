import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Barrido masivo del laboratorio (US1, spec.md): producto cartesiano de --param × --replicas,
// cola con concurrencia acotada, timeout por réplica y progreso legible. Cada réplica es un
// child_process de scripts/lab/replica.ts (T016); al final se invoca scripts/lab/resumen.ts
// (T018) sobre --salida. Ver specs/001-mundo-solido-masivo/tasks.md#T017.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type JobStatus = 'ok' | 'abortada' | 'error';

interface Job {
  readonly id: string;
  readonly seed: number;
  readonly dias: number;
  readonly paramsArg: string;
  readonly dir: string;
}

interface JobResult {
  readonly job: Job;
  readonly status: JobStatus;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
}

interface Options {
  readonly replicas: number;
  readonly dias: number;
  readonly seedBase: number;
  readonly concurrencia: number;
  readonly timeoutMs: number;
  readonly salida: string;
  readonly control: string | undefined;
  readonly paramValues: ReadonlyMap<string, readonly string[]>;
}

function printHelp(): void {
  console.log(
    'Uso: npm run lab -- --replicas N --dias D [--param clave=v1,v2 ...] [--seed-base S] ' +
    '[--concurrencia C] --timeout SEGUNDOS --salida DIR [--control DIR]\n' +
    'Corre el producto cartesiano de --param (repetible, una clave por flag) × --replicas réplicas ' +
    'con scripts/lab/replica.ts, en cola con --concurrencia procesos a la vez (por defecto ' +
    'availableParallelism()-2); mata y marca "abortada" la réplica que supere --timeout segundos; ' +
    'escribe <salida>/progreso.log con % y ETA, y al final invoca scripts/lab/resumen.ts sobre ' +
    '--salida (y --control, si se da).',
  );
}

function requireInt(value: string, key: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${key} requiere un entero ≥ ${minimum} (recibido "${value}")`);
  return parsed;
}

function parseArgs(argv: readonly string[]): Options | null {
  const paramValues = new Map<string, string[]>();
  let replicas: number | undefined, dias: number | undefined, seedBase: number | undefined;
  let concurrencia: number | undefined, timeoutSeconds: number | undefined, salida: string | undefined, control: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') { printHelp(); return null; }
    const separator = arg.indexOf('=');
    const key = separator < 0 ? arg : arg.slice(0, separator);
    const inline = separator < 0 ? undefined : arg.slice(separator + 1);
    const takeValue = (): string => {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new Error(`Falta valor para ${key}`);
      return value;
    };
    switch (key) {
      case '--replicas': replicas = requireInt(takeValue(), key, 1); break;
      case '--dias': dias = requireInt(takeValue(), key, 1); break;
      case '--seed-base': seedBase = requireInt(takeValue(), key, 0); break;
      case '--concurrencia': concurrencia = requireInt(takeValue(), key, 1); break;
      case '--timeout': timeoutSeconds = requireInt(takeValue(), key, 1); break;
      case '--salida': salida = takeValue(); break;
      case '--control': control = takeValue(); break;
      case '--param': {
        const raw = takeValue();
        const eq = raw.indexOf('=');
        if (eq <= 0) throw new Error(`--param requiere clave=valor1,valor2 (recibido "${raw}")`);
        const paramKey = raw.slice(0, eq);
        const values = raw.slice(eq + 1).split(',').map(value => value.trim()).filter(value => value.length > 0);
        if (!values.length) throw new Error(`--param ${paramKey} no trae valores`);
        paramValues.set(paramKey, [...(paramValues.get(paramKey) ?? []), ...values]);
        break;
      }
      default: throw new Error(`Opción desconocida: ${key}`);
    }
  }
  if (replicas === undefined) throw new Error('Falta --replicas');
  if (dias === undefined) throw new Error('Falta --dias');
  if (!salida) throw new Error('Falta --salida');
  if (timeoutSeconds === undefined) throw new Error('Falta --timeout');
  return {
    replicas, dias, paramValues,
    salida: resolve(ROOT, salida),
    control: control ? resolve(ROOT, control) : undefined,
    seedBase: seedBase ?? 1,
    concurrencia: concurrencia ?? Math.max(1, availableParallelism() - 2),
    timeoutMs: timeoutSeconds * 1000,
  };
}

function cartesianProduct(paramValues: ReadonlyMap<string, readonly string[]>): Array<Record<string, string>> {
  let combos: Array<Record<string, string>> = [{}];
  for (const [key, values] of paramValues) {
    const next: Array<Record<string, string>> = [];
    for (const combo of combos) for (const value of values) next.push({ ...combo, [key]: value });
    combos = next;
  }
  return combos;
}

function comboSlug(combo: Record<string, string>): string {
  const keys = Object.keys(combo).sort();
  if (!keys.length) return 'base';
  return keys.map(key => `${key}=${combo[key]}`).join('_').replace(/[^a-zA-Z0-9._=-]/g, '_');
}

function buildJobs(options: Options): Job[] {
  const jobs: Job[] = [];
  for (const combo of cartesianProduct(options.paramValues)) {
    const slug = comboSlug(combo);
    const paramsArg = Object.entries(combo).map(([key, value]) => `${key}=${value}`).join(',');
    for (let replica = 0; replica < options.replicas; replica++) {
      const seed = options.seedBase + replica;
      jobs.push({ id: `${slug}/seed-${seed}`, seed, dias: options.dias, paramsArg, dir: join(options.salida, slug, `seed-${seed}`) });
    }
  }
  return jobs;
}

interface SpawnOutcome { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error; }

function spawnAwait(command: string, args: readonly string[], cwd: string, stdio: StdioOptions): { child: ChildProcess; done: Promise<SpawnOutcome> } {
  const child = spawn(command, [...args], { cwd, stdio });
  const done = new Promise<SpawnOutcome>(settle => {
    let settled = false;
    child.once('error', error => { if (!settled) { settled = true; settle({ code: null, signal: null, error }); } });
    child.once('exit', (code, signal) => { if (!settled) { settled = true; settle({ code, signal }); } });
  });
  return { child, done };
}

async function runJob(job: Job, timeoutMs: number): Promise<JobResult> {
  const startedAt = Date.now();
  mkdirSync(job.dir, { recursive: true });
  const args = ['tsx', 'scripts/lab/replica.ts', '--seed', String(job.seed), '--dias', String(job.dias), '--salida', job.dir];
  if (job.paramsArg) args.push('--params', job.paramsArg);
  const logFd = openSync(join(job.dir, 'proceso.log'), 'a');
  const { child, done } = spawnAwait('npx', args, ROOT, ['ignore', logFd, logFd]);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
  }, timeoutMs);
  const outcome = await done;
  clearTimeout(timer);
  closeSync(logFd);
  const status: JobStatus = timedOut ? 'abortada' : (outcome.code === 0 ? 'ok' : 'error');
  return { job, status, code: outcome.code, signal: outcome.signal, durationMs: Date.now() - startedAt };
}

async function runQueue(jobs: readonly Job[], concurrencia: number, timeoutMs: number, logPath: string): Promise<JobResult[]> {
  const results: JobResult[] = [];
  const startedAt = Date.now();
  const total = jobs.length;
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < total) {
      const job = jobs[nextIndex++]!;
      const result = await runJob(job, timeoutMs);
      results.push(result);
      const done = results.length;
      const elapsedMs = Date.now() - startedAt;
      const etaSeconds = Math.round((elapsedMs / done) * (total - done) / 1000);
      const percent = ((done / total) * 100).toFixed(1);
      appendFileSync(
        logPath,
        `${new Date().toISOString()} ${done}/${total} (${percent}%) ETA ${etaSeconds}s ` +
        `job=${job.id} estado=${result.status} código=${result.code ?? 'null'} duración=${(result.durationMs / 1000).toFixed(1)}s\n`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrencia, total) }, worker));
  return results;
}

async function invokeResumen(salida: string, control: string | undefined, logPath: string): Promise<void> {
  const args = ['tsx', 'scripts/lab/resumen.ts', '--salida', salida];
  if (control) args.push('--control', control);
  const { done } = spawnAwait('npx', args, ROOT, 'inherit');
  const outcome = await done;
  if (outcome.error || outcome.code !== 0) {
    const motivo = outcome.error ? outcome.error.message : `código=${outcome.code ?? 'null'}`;
    appendFileSync(logPath, `${new Date().toISOString()} AVISO: resumen.ts no terminó bien (${motivo})\n`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const jobs = buildJobs(options);
  mkdirSync(options.salida, { recursive: true });
  const logPath = join(options.salida, 'progreso.log');
  writeFileSync(logPath, `${new Date().toISOString()} barrido: ${jobs.length} réplicas, concurrencia=${options.concurrencia}, timeout=${options.timeoutMs / 1000}s\n`);
  const results = await runQueue(jobs, options.concurrencia, options.timeoutMs, logPath);
  const ok = results.filter(result => result.status === 'ok').length;
  const abortadas = results.filter(result => result.status === 'abortada').length;
  const errores = results.filter(result => result.status === 'error').length;
  appendFileSync(logPath, `${new Date().toISOString()} barrido completo: ok=${ok} abortadas=${abortadas} errores=${errores}\n`);
  await invokeResumen(options.salida, options.control, logPath);
  process.exitCode = (abortadas > 0 || errores > 0) ? 1 : 0;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
