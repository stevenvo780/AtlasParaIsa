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
  // `digest` (sha256 de los .ts de src/world) SÍ debe coincidir: es la huella del código de
  // simulación y cualquier diferencia significaría que las dos réplicas no corrieron el mismo mundo.
  assert.equal(replicaA.digest, replicaB.digest);
  // `sha` NO se compara: es `git rev-parse HEAD` en el momento de correr (replica.ts, README §sha),
  // es decir PROCEDENCIA, no una métrica del mundo. Dos spawns separados por un commit en el árbol
  // (normal durante un sprint) devuelven SHAs distintos sin que el mundo haya cambiado en nada —
  // exactamente lo que ocurrió en la corrida 28720d8 (776b22f vs 1f08d79, dos commits del sprint).
  // Se mantiene el contrato de formato, que es lo que este test puede afirmar de verdad.
  for (const sha of [replicaA.sha, replicaB.sha]) assert.match(sha as string, /^[0-9a-f]{40}$/);
  assert.deepEqual(stripTimings(replicaA.resumen as Json), stripTimings(replicaB.resumen as Json));
});

// T118-bis ("laboratorio consciente del servidor"): --gobernador servidor|no en replica.ts.
// Claves exactas de dia-NNN.json ANTES de esta tarea (congeladas a partir de la corrida de
// control, seed 51926, FAST_PARAMS): el default (sin --flag) DEBE seguir produciendo
// exactamente este conjunto — ni una clave nueva de más.
const CLAVES_DIA_SIN_GOBERNADOR = new Set([
  'tick', 'poblacion', 'nacimientos', 'muertesPorCausa', 'fundadoresVivos', 'generacionesVivas',
  'diversidadOficios', 'recetasCreadasAcumuladas', 'diversidadConducta', 'diversidadFuncional',
  'catalogoActivo', 'cooperaciones', 'gini', 'fraccionComida', 'distanciaAgua', 'regionesSinAgua',
  'ventanaActividad', 'vecinosMortales', 'fundadoresMortalesVivos', 'generacionesMortalesVivas',
  'recetasDistintasEnUso', 'recetasDistintasFabricadas', 'usosUtiles', 'beneficioUso',
  'usosDeInventorAjeno', 'usosSinAutorResuelto', 'fraccionUsoAjeno', 'usosConEnsenanzaRecordada',
  'cooperacionAcumuladaPorTipo', 'otrasCooperacionesAcumuladas', 'conflictosAcumulados',
  'p50Ms', 'p95Ms', 'rss',
]);
// Instrumentos de medida (scripts/lab/instrumentos.ts, ronda INSTR 2026-09-22): activos por defecto,
// añaden estas claves (y `foodShared` dentro de `cooperacionAcumuladaPorTipo`); con
// `--instrumentos no` el conjunto vuelve a ser EXACTAMENTE `CLAVES_DIA_SIN_GOBERNADOR`
// (tests/instrumentos-lab.test.ts).
const CLAVES_INSTRUMENTOS = ['diversidadConductaTiempo', 'diversidadConductaTiempoComponentes', 'diversidadConductaActiva', 'diversidadConductaActivaComponentes', 'diversidadConductaComponentes', 'diversidadConductaVentana', 'diversidadConductaVentanaComponentes', 'personasVentana', 'repartoTiempoPorAccion', 'repartoActividadPorAccion', 'vocacionVarianza', 'vocacionEntropiaArgmax', 'vocacionCoincidencia', 'diversidadConductaVentanaGen1', 'approachHogar', 'maderaMediaAdultos', 'piedraMediaAdultos', 'muertesMenores8Dias'] as const;
const CLAVES_DIA_POR_DEFECTO = new Set<string>([...CLAVES_DIA_SIN_GOBERNADOR, ...CLAVES_INSTRUMENTOS]);
const CLAVES_GOBERNADOR_SERVIDOR = ['reproduccionActivaFraccion', 'p95GobernadorFinal', 'cloneMsP50', 'saveMsP50', 'indiceDiversidad', 'cooperacionPorTipo', 'comunidades', 'rasgosPorGeneracion', 'varianzaGenetica'] as const;

test('--gobernador (default "no" y explícito "no") no añade ninguna clave nueva a dia-001.json', (t) => {
  const dirDefault = runReplica(t, ['--seed', '1', '--dias', '1', '--params', FAST_PARAMS]);
  const dirNo = runReplica(t, ['--seed', '1', '--dias', '1', '--params', FAST_PARAMS, '--gobernador', 'no']);

  const diaDefault = readJson(join(dirDefault, 'dia-001.json'));
  const diaNo = readJson(join(dirNo, 'dia-001.json'));
  assert.deepEqual(new Set(Object.keys(diaDefault)), CLAVES_DIA_POR_DEFECTO, 'sin --gobernador el conjunto de claves debe ser EXACTAMENTE el de antes de esta tarea (+ instrumentos)');
  assert.deepEqual(new Set(Object.keys(diaNo)), CLAVES_DIA_POR_DEFECTO, '--gobernador no debe producir el mismo conjunto de claves que el default');
  for (const clave of CLAVES_GOBERNADOR_SERVIDOR) { assert.ok(!(clave in diaDefault), `${clave} no debe existir sin --gobernador`); assert.ok(!(clave in diaNo), `${clave} no debe existir con --gobernador no`); }
  assert.deepEqual(stripTimings(diaDefault), stripTimings(diaNo), 'default y --gobernador no deben coincidir bit a bit salvo tiempos');

  const replicaDefault = readJson(join(dirDefault, 'replica.json')), replicaNo = readJson(join(dirNo, 'replica.json'));
  assert.deepEqual(stripTimings(replicaDefault.resumen as Json), stripTimings(replicaNo.resumen as Json));
  assert.equal(replicaDefault.gobernador, replicaNo.gobernador, 'el campo descriptivo "gobernador" no debe cambiar entre default y --gobernador no');
});

test('--gobernador servidor añade los campos nuevos y reproduccionActivaFraccion cae en [0,1]', (t) => {
  const dir = runReplica(t, ['--seed', '51926', '--dias', '1', '--params', FAST_PARAMS, '--gobernador', 'servidor']);
  const dia = readJson(join(dir, 'dia-001.json'));

  for (const clave of CLAVES_GOBERNADOR_SERVIDOR) assert.ok(clave in dia, `dia-001.json.${clave} debe existir con --gobernador servidor`);
  const fraccion = dia.reproduccionActivaFraccion as number;
  assert.equal(typeof fraccion, 'number');
  assert.ok(fraccion >= 0 && fraccion <= 1, `reproduccionActivaFraccion debe caer en [0,1] (fue ${fraccion})`);
  assert.equal(typeof dia.p95GobernadorFinal, 'number'); assert.ok((dia.p95GobernadorFinal as number) >= 0);
  assert.equal(typeof dia.cloneMsP50, 'number'); assert.ok((dia.cloneMsP50 as number) >= 0);
  assert.equal(typeof dia.saveMsP50, 'number'); assert.ok((dia.saveMsP50 as number) >= 0);

  const indice = dia.indiceDiversidad as Json;
  for (const key of ['conducta', 'oficios', 'total']) assert.equal(typeof indice[key], 'number', `indiceDiversidad.${key} debe ser number`);

  const cooperacion = dia.cooperacionPorTipo as Json;
  for (const key of ['cooperation', 'teaching', 'trade', 'constructionHelp', 'conflicts']) assert.equal(typeof cooperacion[key], 'number', `cooperacionPorTipo.${key} debe ser number`);

  assert.equal(typeof dia.comunidades, 'number');
  assert.ok(dia.comunidades as number >= 0);

  const rasgos = dia.rasgosPorGeneracion as Record<string, Json>;
  assert.ok(Object.keys(rasgos).length > 0, 'rasgosPorGeneracion debe tener al menos una generación viva');
  for (const generacion of Object.values(rasgos)) for (const key of ['resilience', 'learningRate', 'curiosity', 'sociability', 'care']) assert.equal(typeof generacion[key], 'number', `rasgosPorGeneracion[*].${key} debe ser number`);

  assert.equal(typeof dia.varianzaGenetica, 'number');
  assert.ok((dia.varianzaGenetica as number) >= 0);

  const replica = readJson(join(dir, 'replica.json'));
  assert.match(replica.gobernador as string, /servidor/, 'el campo "gobernador" debe describir el modo servidor');
});

test('--gobernador acepta solo "servidor"|"no"', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-lab-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', '--seed', '1', '--dias', '1', '--params', FAST_PARAMS, '--gobernador', 'invalido', '--salida', dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
