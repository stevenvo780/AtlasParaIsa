import { execFileSync, spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseParams } from '../../src/world/params.js';

// Barrido masivo del laboratorio (US1, spec.md): producto cartesiano de --param × --replicas,
// cola con concurrencia acotada, timeout por réplica y progreso legible. Cada réplica es un
// child_process de scripts/lab/replica.ts (T016); al final se invoca scripts/lab/resumen.ts
// (T018) sobre --salida. Ver specs/001-mundo-solido-masivo/tasks.md#T017.
//
// Ronda de arreglo (revisión T017): --timeout y --salida ya no son obligatorios (--salida
// desconocido usa un directorio con sello ISO bajo artifacts/lab, --timeout usa
// DEFAULT_TIMEOUT_SECONDS) para no chocar con quickstart.md L12/13 y T031; --param acepta tanto
// `--param a=1,2 --param b=3,4` (repetible) como `--param a=1,2 b=3,4` (grupos sueltos tras un
// solo --param, forma de T031); el timeout mata el GRUPO de procesos completo (spawn detached +
// `process.kill(-pid, señal)`), no solo `npx`, para no dejar nietos huérfanos vivos; una réplica
// abortada/errada que no llegó a escribir su propio `replica.json` (T016) recibe un marcador
// mínimo pero válido para T018 (mismos `params` normalizados vía `parseParams`, para caer en el
// grupo correcto); `resumen.ts` (T018) se invoca con `--entrada` (no `--salida`, que es para OTRA
// cosa en su CLI) y su fallo en producir resumen.json/md se refleja en el código de salida del
// barrido, no solo en un aviso de texto. `CARTA_REPLICA_SCRIPT`/`CARTA_RESUMEN_SCRIPT` (env,
// opcionales) permiten inyectar stubs en tests sin tocar los ficheros reales de T016/T018.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULT_TIMEOUT_SECONDS = 600; // 10 min/réplica: el brief de T017 no daba default (a
// diferencia de --concurrencia); obligatorio chocaba con los 3 únicos usos documentados
// (quickstart.md L12/13, T031) — hallazgo de revisión T017.

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
    '[--concurrencia C] [--timeout SEGUNDOS] [--salida DIR] [--control DIR]\n' +
    'Corre el producto cartesiano de --param (repetible, o varios "clave=v1,v2" sueltos tras un ' +
    'solo --param, como en T031) × --replicas réplicas con scripts/lab/replica.ts, en cola con ' +
    '--concurrencia procesos a la vez (por defecto availableParallelism()-2); mata el GRUPO de ' +
    `procesos completo y marca "abortada" la réplica que supere --timeout segundos (por defecto ` +
    `${DEFAULT_TIMEOUT_SECONDS}s); si se omite --salida usa artifacts/lab/<sello ISO>; escribe ` +
    '<salida>/progreso.log con % y ETA, y al final invoca scripts/lab/resumen.ts --entrada ' +
    '<salida> (y --control, si se da). Variables opcionales para pruebas: CARTA_REPLICA_SCRIPT, ' +
    'CARTA_RESUMEN_SCRIPT.',
  );
}

function requireInt(value: string, key: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${key} requiere un entero ≥ ${minimum} (recibido "${value}")`);
  return parsed;
}

/** `new Date().toISOString()` sin caracteres inválidos en nombres de directorio (`:`, `.`). */
function sello(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
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
        let raw = takeValue();
        // T031 (tasks.md) escribe varios grupos "clave=v1,v2" sueltos tras un solo --param (no
        // repetido); aceptamos ambas formas: seguimos consumiendo tokens que parezcan
        // clave=valor y no empiecen por "--" — hallazgo de revisión T017.
        for (;;) {
          const eq = raw.indexOf('=');
          if (eq <= 0) throw new Error(`--param requiere clave=valor1,valor2 (recibido "${raw}")`);
          const paramKey = raw.slice(0, eq);
          const values = raw.slice(eq + 1).split(',').map(value => value.trim()).filter(value => value.length > 0);
          if (!values.length) throw new Error(`--param ${paramKey} no trae valores`);
          paramValues.set(paramKey, [...(paramValues.get(paramKey) ?? []), ...values]);
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('--') || next.indexOf('=') <= 0) break;
          raw = next; i++;
        }
        break;
      }
      default: throw new Error(`Opción desconocida: ${key}`);
    }
  }
  if (replicas === undefined) throw new Error('Falta --replicas');
  if (dias === undefined) throw new Error('Falta --dias');
  return {
    replicas, dias, paramValues,
    salida: resolve(ROOT, salida ?? join('artifacts', 'lab', sello())),
    control: control ? resolve(ROOT, control) : undefined,
    seedBase: seedBase ?? 1,
    concurrencia: concurrencia ?? Math.max(1, availableParallelism() - 2),
    timeoutMs: (timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
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

function spawnAwait(
  command: string, args: readonly string[], cwd: string, stdio: StdioOptions, detached = false,
): { child: ChildProcess; done: Promise<SpawnOutcome> } {
  const child = spawn(command, [...args], { cwd, stdio, detached });
  const done = new Promise<SpawnOutcome>(settle => {
    let settled = false;
    child.once('error', error => { if (!settled) { settled = true; settle({ code: null, signal: null, error }); } });
    child.once('exit', (code, signal) => { if (!settled) { settled = true; settle({ code, signal }); } });
  });
  return { child, done };
}

/** Manda `señal` a TODO el grupo de procesos del hijo (no solo a `npx`): `child` se spawnea con
 * `detached: true`, así que es líder de su propio grupo y `-pid` alcanza a todos sus
 * descendientes (npx → tsx → node y lo que estos a su vez lancen), aunque `npx`/`tsx` reenvíen
 * mal la señal o algún nieto la ignore (p. ej. un cierre limpio de Store con
 * `process.on('SIGTERM')`). Antes solo se mataba a `npx`, dejando nietos huérfanos vivos
 * reparentados a PID 1 — hallazgo de revisión T017. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try { process.kill(-pid, signal); }
  catch { try { child.kill(signal); } catch { /* ya terminado */ } }
}

let repoShaCache: string | undefined;
function repoSha(): string {
  if (repoShaCache === undefined) {
    try { repoShaCache = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); }
    catch { repoShaCache = 'desconocido'; }
  }
  return repoShaCache;
}

let worldDigestCache: string | undefined;
/** sha256 de los ficheros `.ts` de `src/world`, igual algoritmo que `replica.ts` (T016), para que
 * el marcador de una réplica abortada sea comparable/ignorable de la misma forma que uno real. */
function worldSourceDigest(): string {
  if (worldDigestCache === undefined) {
    const dir = join(ROOT, 'src', 'world'), hash = createHash('sha256');
    for (const name of readdirSync(dir).filter(f => f.endsWith('.ts')).sort()) hash.update(name).update('\0').update(readFileSync(join(dir, name)));
    worldDigestCache = hash.digest('hex');
  }
  return worldDigestCache;
}

/** Si la réplica murió (timeout o error) antes de escribir su propio `replica.json` (T016), T018
 * la ignoraría en silencio (resumen.ts descubre réplicas buscando ese fichero) y las medianas
 * saldrían sesgadas sin avisar — hallazgo de revisión T017. Escribe un marcador mínimo pero
 * válido para `leerReplica` (resumen.ts exige seed/sha/digest), con los MISMOS `params`
 * normalizados que habría escrito replica.ts (mismo `parseParams` de src/world/params.ts) para
 * que la réplica caiga en el grupo de parámetros correcto en vez de en uno propio espurio. */
function writeAbortedMarker(job: Job, result: JobResult): void {
  const path = join(job.dir, 'replica.json');
  if (existsSync(path)) return; // replica.ts alcanzó a escribir el suyo antes de morir: no se pisa.
  let params: unknown;
  try { params = parseParams(job.paramsArg || undefined); }
  catch (error) { params = { _paramsCrudos: job.paramsArg, _errorParseParams: (error as Error).message }; }
  const marker = {
    seed: job.seed, params, sha: repoSha(), digest: worldSourceDigest(), dias: job.dias, abortada: true,
    barrido: { estado: result.status, codigo: result.code, senal: result.signal, duracionMs: result.durationMs },
  };
  writeFileSync(path, JSON.stringify(marker, null, 2) + '\n');
}

async function runJob(job: Job, timeoutMs: number): Promise<JobResult> {
  const startedAt = Date.now();
  mkdirSync(job.dir, { recursive: true });
  const replicaScript = process.env.CARTA_REPLICA_SCRIPT || 'scripts/lab/replica.ts';
  const args = ['tsx', replicaScript, '--seed', String(job.seed), '--dias', String(job.dias), '--salida', job.dir];
  if (job.paramsArg) args.push('--params', job.paramsArg);
  const logFd = openSync(join(job.dir, 'proceso.log'), 'a');
  const { child, done } = spawnAwait('npx', args, ROOT, ['ignore', logFd, logFd], true);
  let timedOut = false;
  let killGrace: Promise<void> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child, 'SIGTERM');
    // El líder puede terminar antes que sus descendientes. La gracia pertenece
    // al grupo completo y debe acabar antes de liberar este puesto en la cola.
    killGrace = new Promise(resolve => setTimeout(() => { killGroup(child, 'SIGKILL'); resolve(); }, 2000));
  }, timeoutMs);
  const outcome = await done;
  clearTimeout(timer);
  if (killGrace) await killGrace;
  closeSync(logFd);
  const status: JobStatus = timedOut ? 'abortada' : (outcome.code === 0 ? 'ok' : 'error');
  const result: JobResult = { job, status, code: outcome.code, signal: outcome.signal, durationMs: Date.now() - startedAt };
  if (status !== 'ok') writeAbortedMarker(job, result);
  return result;
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

/** Invoca scripts/lab/resumen.ts (T018) sobre el directorio del barrido y devuelve si de verdad
 * produjo resumen.json/resumen.md. T018 toma el directorio de entrada con `--entrada` (su
 * `--salida` es dónde ESCRIBIR el resumen, no de dónde leer) — antes esta llamada usaba
 * `--salida` para las dos cosas y `resumen.ts` fallaba con "Falta --entrada" en cuanto se
 * integraba con la implementación real; el fallo solo dejaba un aviso de texto que no afectaba
 * al código de salida, así que un barrido entero podía "tener éxito" sin dejar resumen.md/json
 * (hallazgo de revisión T017). Ahora se comprueba la EXISTENCIA de los ficheros de salida (no
 * solo el código de proceso, que T018 también usa para señalar semáforos 🔴/rotura de
 * determinismo con resumen.json/md ya escritos: eso no es "resumen no generado"). */
async function invokeResumen(salida: string, control: string | undefined, logPath: string): Promise<boolean> {
  const resumenScript = process.env.CARTA_RESUMEN_SCRIPT || 'scripts/lab/resumen.ts';
  const args = ['tsx', resumenScript, '--entrada', salida, '--salida', salida];
  if (control) args.push('--control', control);
  const { done } = spawnAwait('npx', args, ROOT, 'inherit');
  const outcome = await done;
  const generado = existsSync(join(salida, 'resumen.json')) && existsSync(join(salida, 'resumen.md'));
  if (!generado) {
    const motivo = outcome.error ? outcome.error.message : `código=${outcome.code ?? 'null'}`;
    appendFileSync(
      logPath,
      `${new Date().toISOString()} AVISO GRAVE: no se generó resumen.json/resumen.md en ${salida} ` +
      `(resumen.ts: ${motivo}). Este barrido NO tiene evidencia agregada (constitución II); no lo ` +
      'des por terminado sin revisar manualmente.\n',
    );
  } else if (outcome.code !== 0) {
    appendFileSync(
      logPath,
      `${new Date().toISOString()} AVISO: resumen.ts terminó con código=${outcome.code} (probable ` +
      `semáforo 🔴 o rotura de determinismo, ya con resumen.json/md escritos); revisa ${salida}/resumen.md.\n`,
    );
  }
  return generado;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const jobs = buildJobs(options);
  mkdirSync(options.salida, { recursive: true });
  const logPath = join(options.salida, 'progreso.log');
  writeFileSync(logPath, `${new Date().toISOString()} barrido: ${jobs.length} réplicas, concurrencia=${options.concurrencia}, timeout=${options.timeoutMs / 1000}s, salida=${options.salida}\n`);
  const results = await runQueue(jobs, options.concurrencia, options.timeoutMs, logPath);
  const ok = results.filter(result => result.status === 'ok').length;
  const abortadas = results.filter(result => result.status === 'abortada').length;
  const errores = results.filter(result => result.status === 'error').length;
  appendFileSync(logPath, `${new Date().toISOString()} barrido completo: ok=${ok} abortadas=${abortadas} errores=${errores}\n`);
  const resumenGenerado = await invokeResumen(options.salida, options.control, logPath);
  process.exitCode = (abortadas > 0 || errores > 0 || !resumenGenerado) ? 1 : 0;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
