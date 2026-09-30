/** Escenas naturales de laboratorio: mismo bucle que replica.ts, sin gobernador ni instrumentos. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSnapshotParams } from '../../src/server/snapshot.js';
import { Store } from '../../src/server/store.js';
import { chronicleJournalNearCapacity } from '../../src/world/chronicle-journal.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { assertWorld, createWorld, RULES_VERSION, stepWorld, TICKS_PER_DAY, type World } from '../../src/world/index.js';
import type { WorldParams } from '../../src/world/params.js';
import { technologyCatalogueNearCapacity } from '../../src/world/technology-catalogue.js';
import { technologyJournalNearCapacity } from '../../src/world/technology-journal.js';

const LAB_ROOT = '/datos/tmp-atlas-lab';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export interface GenerationOptions {
  seed: number; paramsDb: string; thresholds: number[]; output: string; maxDays: number;
}
export interface ParamsSource {
  path: string; applicationId: number; schemaVersion: number; snapshotDigest: string;
  savedAt: number; tick: number; seed: number; rulesVersion: number;
  paramsSha256: string; effectiveParamsSha256: string; params: WorldParams;
}
export interface NaturalScene {
  threshold: number; path: string; tick: number; population: number; seed: number;
  digestPostSave: string; snapshotDigest: string;
}
export interface GenerationReport {
  version: 1; status: 'done' | 'failed'; retryable: false; seed: number; params: WorldParams;
  paramsSource: ParamsSource; source: ReturnType<typeof sourceHashes>;
  mode: string; maxDays: number; thresholds: number[]; workingDb: string;
  tick: number; population: number; scenes: NaturalScene[]; missingThresholds: number[];
  startedAt: string; finishedAt: string; error?: string;
}

function withinLab(path: string, existing: boolean): string {
  const candidate = resolve(path), root = realpathSync(LAB_ROOT);
  let ancestor = candidate;
  if (!existing) while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const actual = existing ? realpathSync(candidate) : resolve(realpathSync(ancestor), relative(ancestor, candidate));
  if (actual !== root && !actual.startsWith(root + sep)) throw new Error(`Ruta fuera del laboratorio privado: ${candidate}`);
  return actual;
}

type Metadata = {
  digest: string; saved_at: number; version: number; seed: number; tick: number;
  params_encoding: string | null; params_json: string | null; limits_json: string | null;
};
const METADATA_SQL = `SELECT digest,saved_at,
  json_extract(body,CASE WHEN json_type(body,'$.world')='object' THEN '$.world.version' ELSE '$.version' END) AS version,
  json_extract(body,CASE WHEN json_type(body,'$.world')='object' THEN '$.world.seed' ELSE '$.seed' END) AS seed,
  json_extract(body,CASE WHEN json_type(body,'$.world')='object' THEN '$.world.tick' ELSE '$.tick' END) AS tick,
  json_extract(body,CASE WHEN json_type(body,'$.world')='object' THEN '$.world.paramsEncoding' ELSE '$.paramsEncoding' END) AS params_encoding,
  json_extract(body,CASE WHEN json_type(body,'$.world')='object' THEN '$.world.params' ELSE '$.params' END) AS params_json,
  json_extract(body,CASE WHEN json_type(body,'$.world')='object' THEN '$.world.limitsProfile' ELSE '$.limitsProfile' END) AS limits_json
  FROM snapshots WHERE slot=0`;

/** Extrae únicamente los parámetros y metadatos; nunca carga el mundo del laboratorio fuente. */
export function readLabParams(path: string): ParamsSource {
  const actual = withinLab(path, true);
  if (!statSync(actual).isFile()) throw new Error('La fuente de parámetros debe ser un archivo SQLite de laboratorio.');
  const db = new DatabaseSync(actual, { readOnly: true });
  try {
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number };
    const { user_version: schemaVersion } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const columns = db.prepare('SELECT name,type,pk FROM pragma_table_info(?)').all('snapshots');
    if (applicationId !== 1128354388 || ![1, 2, 3, 4, 5].includes(schemaVersion)
      || JSON.stringify(columns.map(row => [row.name, row.type, row.pk])) !== JSON.stringify([
        ['slot', 'INTEGER', 1], ['body', 'TEXT', 0], ['digest', 'TEXT', 0], ['saved_at', 'INTEGER', 0],
      ])) throw new Error('La fuente no tiene el esquema de instantáneas de Atlas.');
    const row = db.prepare(METADATA_SQL).get() as Metadata | undefined;
    if (!row || !Number.isSafeInteger(row.version) || row.version < 1 || row.version > RULES_VERSION
      || !Number.isSafeInteger(row.tick) || row.tick < 0 || !Number.isSafeInteger(row.seed)
      || !/^[a-f0-9]{64}$/.test(row.digest) || row.params_json === null)
      throw new Error('La fuente no contiene una instantánea vigente con parámetros explícitos.');
    const record: Record<string, unknown> = { params: JSON.parse(row.params_json), paramsEncoding: row.params_encoding };
    if (row.limits_json !== null) record.limitsProfile = JSON.parse(row.limits_json);
    // Igual que Store.load: una clave que aún no existía conserva su valor histórico.
    const params = readSnapshotParams(record);
    return { path: actual, applicationId, schemaVersion, snapshotDigest: row.digest, savedAt: row.saved_at,
      tick: row.tick, seed: row.seed, rulesVersion: row.version, paramsSha256: sha256(row.params_json),
      effectiveParamsSha256: sha256(JSON.stringify(params)), params };
  } finally { db.close(); }
}

function sourceHashes() {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const item of readdirSync(join(PROJECT_ROOT, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${item.name}`;
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && /\.(?:ts|mjs|js|cu)$/.test(item.name)) files[path] = sha256(readFileSync(join(PROJECT_ROOT, path)));
    }
  };
  walk('src/world');
  for (const path of ['scripts/perf/generar-escenas.ts', 'scripts/lab/replica.ts', 'src/server/store.ts',
    'src/server/snapshot.ts', 'src/server/snapshot-parts.ts', 'src/server/technology-archive.ts'])
    files[path] = sha256(readFileSync(join(PROJECT_ROOT, path)));
  return { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(),
    sha256: sha256(JSON.stringify(files)), files };
}

export function parseGenerationArgs(argv: readonly string[]): GenerationOptions {
  const values = new Map<string, string>();
  const flags = ['--seed', '--params-db', '--umbrales', '--salida', '--max-dias'];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1];
    if (!flags.includes(flag) || values.has(flag) || value === undefined || value.startsWith('--'))
      throw new Error(`Bandera desconocida, repetida o sin valor: ${flag}`);
    values.set(flag, value);
  }
  const positive = (value: string, label: string, minimum = 1): number => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < minimum) throw new Error(`${label} debe ser un entero ≥ ${minimum}.`);
    return n;
  };
  const seed = positive(values.get('--seed') ?? '8101', '--seed', 0);
  const maxDays = positive(values.get('--max-dias') ?? '60', '--max-dias');
  const thresholds = (values.get('--umbrales') ?? '700,2000').split(',').map(value => positive(value, '--umbrales'));
  const paramsDb = values.get('--params-db'), output = values.get('--salida');
  if (!paramsDb || !output) throw new Error('Uso: --seed 8101 --params-db <laboratorio.sqlite> --umbrales 700,2000 --salida <dir-propio> --max-dias 60');
  if (seed > 0xffffffff || !Number.isSafeInteger(maxDays * TICKS_PER_DAY)
    || thresholds.some((n, i) => i > 0 && n <= thresholds[i - 1]!)) throw new Error('Semilla fuera de u32, duración excesiva o umbrales sin orden creciente.');
  return { seed, paramsDb, thresholds, output, maxDays };
}

function captureScene(store: Store, world: World, threshold: number, output: string, workingDirectory: string, digestPostSave: string,
  provenance: { params: WorldParams; paramsSource: ParamsSource; source: ReturnType<typeof sourceHashes> }): NaturalScene {
  const staged = join(workingDirectory, `n${threshold}.sqlite`), path = join(output, `n${threshold}.sqlite`);
  store.db.prepare('VACUUM INTO ?').run(staged);
  const db = new DatabaseSync(staged, { readOnly: true });
  let snapshotDigest: string;
  try {
    const row = db.prepare(METADATA_SQL).get() as Metadata;
    if (row.tick !== world.tick || row.seed !== world.seed) throw new Error('La copia SQLite no coincide con el mundo confirmado.');
    snapshotDigest = row.digest;
  } finally { db.close(); }
  // El enlace exclusivo publica una copia coherente y nunca reemplaza una escena existente.
  linkSync(staged, path);
  const scene = { threshold, path, tick: world.tick, population: world.people.length, seed: world.seed, digestPostSave, snapshotDigest };
  writeFileSync(join(output, `n${threshold}.json`), JSON.stringify({ ...scene, ...provenance }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return scene;
}

/** Los callbacks de medición del perfil pertenecen al lector; este generador no instrumenta el paso. */
export function generateNaturalScenes(options: GenerationOptions, log: (message: string) => void = console.log): GenerationReport {
  // Validar también la API importable: las mismas restricciones que la CLI.
  const checked = parseGenerationArgs(['--seed', String(options.seed), '--params-db', options.paramsDb,
    '--umbrales', options.thresholds.join(','), '--salida', options.output, '--max-dias', String(options.maxDays)]);
  const paramsSource = readLabParams(checked.paramsDb);
  if (paramsSource.seed !== checked.seed) throw new Error(`La semilla pedida (${checked.seed}) no coincide con la fuente (${paramsSource.seed}).`);
  const output = withinLab(checked.output, false);
  if (output === realpathSync(LAB_ROOT) || output === dirname(paramsSource.path)) throw new Error('La salida debe ser un directorio propio, separado de la fuente.');
  for (const name of ['ejecucion.json', 'manifiesto.json', ...checked.thresholds.flatMap(n => [`n${n}.sqlite`, `n${n}.json`])])
    if (existsSync(join(output, name))) throw new Error(`La salida ya existe; no se sobrescribe: ${join(output, name)}`);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  withinLab(output, true);
  const workingDirectory = mkdtempSync(join(realpathSync(LAB_ROOT), 'atlas-perfil-escenas-'));
  const workingDb = join(workingDirectory, 'world.sqlite'), source = sourceHashes(), startedAt = new Date().toISOString();
  const params = paramsSource.params, scenes: NaturalScene[] = [];
  writeFileSync(join(output, 'ejecucion.json'), JSON.stringify({ ...checked, output, params, paramsSource, source, workingDb, startedAt }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const store = new Store(workingDb);
  let world: World | undefined, error: string | undefined;
  try {
    world = createWorld(checked.seed, params);
    store.save(world); // Obligatorio: activa catálogo y WorldContext antes del primer paso.
    log(`${startedAt} inicio seed=${checked.seed} población=${world.people.length} temporal=${workingDb}`);
    for (let tick = 1; tick <= checked.maxDays * TICKS_PER_DAY; tick++) {
      stepWorld(world);
      const regular = tick % params.persistencia.cadaTicks === 0;
      if (regular || technologyJournalNearCapacity(world.technology) || chronicleJournalNearCapacity(world)
        || technologyCatalogueNearCapacity(world.technology)) store.save(world);
      if (tick % TICKS_PER_DAY === 0) {
        if (!regular) store.save(world); // Misma frontera diaria que replica.ts.
        assertWorld(world);
      }
      if (regular) {
        log(`${new Date().toISOString()} guardado tick=${world.tick} día=${(world.tick / TICKS_PER_DAY).toFixed(3)} población=${world.people.length}`);
        const reached = checked.thresholds.filter(n => !scenes.some(scene => scene.threshold === n) && world!.people.length >= n);
        if (reached.length) {
          const digest = digestoCanonico(world);
          for (const threshold of reached) {
            const scene = captureScene(store, world, threshold, output, workingDirectory, digest, { params, paramsSource, source });
            scenes.push(scene);
            log(`${new Date().toISOString()} escena umbral=${threshold} tick=${scene.tick} población=${scene.population} digesto=${scene.digestPostSave} ruta=${scene.path}`);
          }
        }
        if (scenes.length === checked.thresholds.length) break;
      }
    }
    if (scenes.length !== checked.thresholds.length) error = `NO CUMPLIDA: no se alcanzaron todos los umbrales en ${checked.maxDays} días.`;
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  finally { store.close(); }
  const missingThresholds = checked.thresholds.filter(n => !scenes.some(scene => scene.threshold === n));
  const report: GenerationReport = { version: 1, status: error ? 'failed' : 'done', retryable: false,
    seed: checked.seed, params, paramsSource, source, mode: 'replica.ts; gobernador=no; instrumentos=no; stepWorld inplace; población natural',
    maxDays: checked.maxDays, thresholds: checked.thresholds, workingDb, tick: world?.tick ?? 0,
    population: world?.people.length ?? 0, scenes, missingThresholds, startedAt, finishedAt: new Date().toISOString(), ...(error ? { error } : {}) };
  writeFileSync(join(output, 'manifiesto.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  log(`${report.finishedAt} ${report.status} tick=${report.tick} población=${report.population} faltan=${missingThresholds.join(',') || 'ninguno'} temporal conservado=${workingDb}`);
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const report = generateNaturalScenes(parseGenerationArgs(process.argv.slice(2)));
    if (report.status !== 'done') { console.error(report.error); process.exitCode = 1; }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
