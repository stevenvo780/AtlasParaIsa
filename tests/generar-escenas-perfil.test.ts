import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateNaturalScenes, parseGenerationArgs, readLabParams, type GenerationReport } from '../scripts/perf/generar-escenas.js';
import { Store } from '../src/server/store.js';
import { chronicleJournalNearCapacity } from '../src/world/chronicle-journal.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { assertWorld, createWorld, stepWorld, TICKS_PER_DAY, type FaseMedicion } from '../src/world/index.js';
import { parseParams, paramsOf } from '../src/world/params.js';
import { technologyCatalogueNearCapacity } from '../src/world/technology-catalogue.js';
import { technologyJournalNearCapacity } from '../src/world/technology-journal.js';

const params = parseParams('poblacion.nacimientosPorComprobacion=20,agua.cuencas=0.4,persistencia.cadaTicks=300,persistencia.ventanaEventosTicks=0');
const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

function fixture(t: { after: (callback: () => unknown) => void }) {
  const directory = mkdtempSync('/datos/tmp-atlas-lab/atlas-test-escenas-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'params.sqlite'), store = new Store(path);
  store.save(createWorld(8101, params)); store.close();
  return { directory, path, output: join(directory, 'escenas') };
}
function cleanWorkingDb(t: { after: (callback: () => unknown) => void }, report: GenerationReport): void {
  t.after(() => rmSync(dirname(report.workingDb), { recursive: true, force: true }));
}

test('flags estrictos: umbrales naturales, semilla u32 y ninguna bandera que altere leyes', () => {
  const base = ['--params-db', '/datos/tmp-atlas-lab/lab.sqlite', '--salida', '/datos/tmp-atlas-lab/escenas'];
  assert.deepEqual(parseGenerationArgs(base), { seed: 8101, paramsDb: base[1], output: base[3], thresholds: [700, 2000], maxDays: 60 });
  assert.deepEqual(parseGenerationArgs([...base, '--umbrales', '16,20', '--max-dias', '1']).thresholds, [16, 20]);
  for (const suffix of [['--seed'], ['--seed', '4294967296'], ['--max-dias', '0'], ['--umbrales', '20,16'],
    ['--umbrales', '16,16'], ['--seed', '1e3'], ['--params', 'agua.cuencas=1'], ['--gobernador', 'servidor'], ['--salida', base[3]!]])
    assert.throws(() => parseGenerationArgs([...base, ...suffix]));
});

test('lee solo metadatos en SQLite read-only y preserva leyes históricas de una clave ausente', (t) => {
  const { path } = fixture(t), db = new DatabaseSync(path);
  const row = db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string };
  const record = JSON.parse(row.body) as { params: Record<string, Record<string, unknown>> };
  delete record.params.social!.disolucion;
  db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(JSON.stringify(record), hash(JSON.stringify(record)));
  db.close();
  const before = hash(readFileSync(path)), source = readLabParams(path);
  assert.equal(hash(readFileSync(path)), before, 'leer los params no escribe ni migra la base fuente');
  assert.equal(source.params.social.disolucion, 0);
  assert.equal(source.params.poblacion.nacimientosPorComprobacion, 20);
  assert.equal(source.params.persistencia.cadaTicks, 300);
  assert.equal(source.seed, 8101);
  assert.throws(() => readLabParams('/etc/hosts'), /fuera del laboratorio/);
});

test('primer guardado regular: copia coherente, digesto POSTsave y mundo idéntico al bucle sin instrumentos', (t) => {
  const { directory, path, output } = fixture(t), sourceBefore = hash(readFileSync(path));
  const report = generateNaturalScenes({ seed: 8101, paramsDb: path, output, thresholds: [16], maxDays: 1 }, () => {});
  cleanWorkingDb(t, report);
  assert.equal(report.status, 'done'); assert.equal(report.retryable, false);
  assert.equal(report.tick, 300, 'el guardado inicial nunca captura la escena');
  assert.equal(report.scenes.length, 1); assert.ok(report.scenes[0]!.population >= 16);
  assert.ok(existsSync(report.workingDb), 'el temporal queda conservado después del éxito');
  assert.equal(hash(readFileSync(path)), sourceBefore, 'la generación no escribe sobre la fuente');

  const referenceStore = new Store(join(directory, 'reference.sqlite'));
  const reference = createWorld(8101, readLabParams(path).params);
  referenceStore.save(reference);
  for (let tick = 1; tick <= report.tick; tick++) {
    stepWorld(reference);
    if (tick % params.persistencia.cadaTicks === 0 || technologyJournalNearCapacity(reference.technology)
      || chronicleJournalNearCapacity(reference) || technologyCatalogueNearCapacity(reference.technology)) referenceStore.save(reference);
    if (tick % TICKS_PER_DAY === 0) {
      if (tick % params.persistencia.cadaTicks !== 0) referenceStore.save(reference);
      assertWorld(reference);
    }
  }
  assert.equal(report.scenes[0]!.digestPostSave, digestoCanonico(reference));
  const snapshotStore = new Store(report.scenes[0]!.path, { readOnly: true });
  const loaded = snapshotStore.load()!.world;
  assert.equal(digestoCanonico(loaded), report.scenes[0]!.digestPostSave);
  assert.deepEqual(loaded, reference);
  assert.deepEqual(paramsOf(loaded), report.params);

  const measurement: FaseMedicion = { clock: () => performance.now(), fases: {} };
  for (let tick = 0; tick < 20; tick++) { stepWorld(loaded, [], undefined, measurement); stepWorld(reference); }
  assert.equal(digestoCanonico(loaded), digestoCanonico(reference), 'callbacks de fase no alteran el mundo cargado');
  assert.deepEqual(loaded, reference);
  snapshotStore.close(); referenceStore.close();
  const sceneManifest = JSON.parse(readFileSync(join(output, 'n16.json'), 'utf8')) as { params: unknown; source: { files: Record<string, string> }; digestPostSave: string };
  assert.deepEqual(sceneManifest.params, report.params);
  assert.equal(sceneManifest.digestPostSave, report.scenes[0]!.digestPostSave);
  assert.match(sceneManifest.source.files['scripts/lab/replica.ts']!, /^[a-f0-9]{64}$/);
  const capturedBefore = hash(readFileSync(report.scenes[0]!.path));
  assert.throws(() => generateNaturalScenes({ seed: 8101, paramsDb: path, output, thresholds: [16], maxDays: 1 }, () => {}), /no se sobrescribe/);
  assert.equal(hash(readFileSync(report.scenes[0]!.path)), capturedBefore);
});

test('un umbral no alcanzado falla honestamente y conserva el temporal y el manifiesto', (t) => {
  const { path, output } = fixture(t);
  const report = generateNaturalScenes({ seed: 8101, paramsDb: path, output, thresholds: [1000000], maxDays: 1 }, () => {});
  cleanWorkingDb(t, report);
  assert.equal(report.status, 'failed'); assert.equal(report.retryable, false);
  assert.equal(report.tick, TICKS_PER_DAY); assert.deepEqual(report.missingThresholds, [1000000]);
  assert.deepEqual(report.scenes, []); assert.match(report.error!, /NO CUMPLIDA/);
  assert.ok(existsSync(report.workingDb)); assert.ok(existsSync(join(output, 'manifiesto.json')));
  assert.equal(existsSync(join(output, 'n1000000.sqlite')), false);
});
