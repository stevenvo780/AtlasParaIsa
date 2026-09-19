import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAUSES = ['starvation', 'dehydration', 'exposure', 'senescence'] as const;
// Una cadencia de guardado grande mantiene la réplica de 1 día dentro del presupuesto del test
// sin dejar de ejercitar el mecanismo "store.save cada persistencia.cadaTicks" (P3).
const FAST_PARAMS = 'persistencia.cadaTicks=300';

function runReplica(t: TestContext, args: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-lab-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', ...args, '--salida', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return dir;
}
type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
/** Compara todo salvo los campos que "Salida determinista salvo tiempos" exime explícitamente. */
const stripTimings = (o: Json): Json => { const { p50Ms: _p50, p95Ms: _p95, rss: _rss, rssMaximo: _rssMax, ...rest } = o; return rest; };

test('réplica de 1 día produce dia-001.json y replica.json con las claves esperadas', (t) => {
  const dir = runReplica(t, ['--seed', '51926', '--dias', '1', '--params', FAST_PARAMS]);

  const dia = readJson(join(dir, 'dia-001.json'));
  assert.equal(dia.tick, 2400);
  for (const key of ['poblacion', 'nacimientos', 'fundadoresVivos', 'generacionesVivas', 'diversidadOficios', 'recetasDistintasEnUso', 'diversidadFuncional', 'cooperaciones', 'p50Ms', 'p95Ms', 'rss'])
    assert.equal(typeof dia[key], 'number', `dia-001.json.${key} debe ser number`);
  const muertes = dia.muertesPorCausa as Json;
  for (const cause of CAUSES) assert.equal(typeof muertes[cause], 'number', `muertesPorCausa.${cause} debe ser number`);
  for (const key of ['gini', 'fraccionComida', 'distanciaAgua']) assert.ok(dia[key] === null || typeof dia[key] === 'number', `${key} debe ser number o null (T013 aún no existe en este árbol)`);
  // P3 (requisito central de T016, refutable): esta réplica SIEMPRE adjunta un Store, así
  // que `catalogoActivo` (== catalogueEnabled(world.technology)) debe ser true. Si alguien
  // borra `new Store(...)`/`store.save(world)` de replica.ts, `enableTechnologyCatalogue`
  // nunca corre y este assert falla — a diferencia de `recetasDistintasEnUso > 0`, que
  // (medido con seed 51926, mismos params, sin Store) da el mismo valor >0 igual.
  assert.equal(dia.catalogoActivo, true, 'con Store el catálogo de producción debe estar activo (P3)');
  // P3: con Store adjunto la catalogación de producción rige y el mundo fabrica tecnología medible.
  assert.ok((dia.recetasDistintasEnUso as number) > 0, 'con Store el mundo debe fabricar tecnología en 1 día');
  assert.ok((dia.diversidadFuncional as number) > 0, 'con Store debe haber al menos una función tecnológica distinta descubierta');

  const replica = readJson(join(dir, 'replica.json'));
  assert.equal(replica.seed, 51926);
  assert.equal(replica.dias, 1);
  assert.match(replica.sha as string, /^[0-9a-f]{40}$/);
  assert.match(replica.digest as string, /^[0-9a-f]{64}$/);
  assert.equal(((replica.params as Json).persistencia as Json).cadaTicks, 300);
  const resumen = replica.resumen as Json;
  for (const key of ['poblacionInicial', 'poblacionFinal', 'nacimientosTotal', 'fundadoresVivosFinal', 'generacionesVivasFinal', 'p50Ms', 'p95Ms', 'rssMaximo'])
    assert.equal(typeof resumen[key], 'number', `replica.json.resumen.${key} debe ser number`);
});

test('dos réplicas con la misma semilla y params dan métricas idénticas salvo tiempos', (t) => {
  const args = ['--seed', '20260905', '--dias', '1', '--params', FAST_PARAMS];
  const dirA = runReplica(t, args), dirB = runReplica(t, args);

  assert.deepEqual(stripTimings(readJson(join(dirA, 'dia-001.json'))), stripTimings(readJson(join(dirB, 'dia-001.json'))));
  const replicaA = readJson(join(dirA, 'replica.json')), replicaB = readJson(join(dirB, 'replica.json'));
  assert.equal(replicaA.digest, replicaB.digest);
  assert.equal(replicaA.sha, replicaB.sha);
  assert.deepEqual(stripTimings(replicaA.resumen as Json), stripTimings(replicaB.resumen as Json));
});
