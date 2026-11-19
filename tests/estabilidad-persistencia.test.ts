/**
 * Pruebas de la Fase A del plan de estabilidad (docs/PLAN-ESTABILIDAD-2026-11-18.md):
 * - A1: compactación incremental de `technology_stats` + índice `technology_stats_tick` + `ensurePerformanceIndexes()`
 * - A2: eliminación de `USE TEMP B-TREE FOR ORDER BY` en `technology_definitions`, eliminación de
 *       re-decodificaciones O(N²) en `scanDefinitions`/`summarizeDefinitions`, barrido único en `load()`,
 *       memoización de `loadLegacy()` y supervivencia segura de `archivedRecipeMemo` entre guardados
 * - A3: poda escalada de ejecuciones (>4096 cuando `pending.length * 2` lo supera), rotación de `slot 2`
 *       resistente a reinicios y `PRAGMA auto_vacuum = INCREMENTAL` + `incremental_vacuum(256)`
 * - A4: endurecimiento de `scripts/respaldo.sh` (`SQLITE_TMPDIR`, `RESPALDO_METODO=backup|vacuum`)
 *       y límites de la unidad `scripts/systemd/torre/atlas-respaldo-publico.service`
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { DEEP_CHECKPOINT_EVERY_SAVES, Store, TECHNOLOGY_PRUNE_ROWS_PER_SAVE, TECHNOLOGY_RETENTION_MIN_TICKS } from '../src/server/store.js';
import { TechnologyArchive } from '../src/server/technology-archive.js';
import type { TechnologyDefinition, TechnologyStats } from '../src/shared/technology-archive.js';
import type { TechnologyProgram } from '../src/shared/technology.js';
import { assertWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { parseParams, setParams } from '../src/world/params.js';
import { programSignature, recordTechnologyBenefit, researchTechnology, useTool } from '../src/world/technology.js';
import { directorioTemporal, laboratorio, sha256 } from './lib/store.js';
import { proyectoInvestigacion } from './lib/escenas.js';

const count = (db: DatabaseSync, sql: string, ...params: (string | number)[]) =>
  Number((db.prepare(sql).get(...params) as { n: number }).n);

function fixtureTick(world: World, atTick: number): void {
  world.tick = atTick;
  for (const person of world.people) person.demography.age = atTick - person.bornAt;
}

function edgeProgram(index: number, parentId?: string): TechnologyProgram {
  return {
    inputs: [parentId
      ? { source: 'product', recipeId: parentId, mass: 2000 }
      : { source: 'raw', material: 'stone', mass: 4000 }],
    steps: [
      { op: 'form', intensity: 4, shape: 'edge' },
      { op: 'compress', intensity: 1 + (index % 4) },
      ...(index >= 4 ? [{ op: 'cool' as const, intensity: 1 + (Math.floor(index / 4) % 4) }] : []),
    ],
  };
}

function inventTool(world: World, index: number, parentId?: string, actorIndex = 2): string {
  const person = world.people[actorIndex]!;
  person.materials.stone = 12; person.materials.wood = 12; person.energy = 1; person.fatigue = 0;
  const program = edgeProgram(index, parentId);
  person.technology.project = proyectoInvestigacion(program, world.tick, parentId ? [parentId] : []);
  for (let n = 0; n < 250 && person.technology.project; n++) {
    fixtureTick(world, world.tick + 1);
    researchTechnology(world, person);
  }
  assert.equal(person.technology.project, null);
  return world.technology.recipes.at(-1)!.id;
}

function useCutting(world: World, times: number, actorIndex = 2, toolIndexRef = { next: 10 }): number {
  const person = world.people[actorIndex]!;
  let used = 0;
  for (let n = 0; n < times; n++) {
    let receipt = useTool(world, person, 'cutting', 0.01);
    if (!receipt) {
      // Si la herramienta se desgastó por uso real, fabricar otra pagando materiales y trabajo.
      inventTool(world, toolIndexRef.next++, undefined, actorIndex);
      receipt = useTool(world, person, 'cutting', 0.01);
    }
    assert.ok(receipt);
    recordTechnologyBenefit(world, person, receipt, 0.2);
    used++;
  }
  return used;
}

function syntheticDefinition(id: number, atTick: number, parent?: TechnologyDefinition): TechnologyDefinition {
  const program: TechnologyProgram = {
    inputs: [parent ? { source: 'product', recipeId: parent.id, mass: 1000 } : { source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: id % 4 + 1, shape: 'edge' },
      { op: 'cool', intensity: (id >> 2) % 4 + 1 }, { op: 'compress', intensity: (id >> 4) % 4 + 1 }],
  };
  return {
    lawsVersion: 1, id: `recipe-${id}`, name: `Recipe ${id}`, program, signature: programSignature(program),
    parents: parent ? [parent.id] : [], generation: parent ? parent.generation + 1 : 1,
    inventorId: 'inventor-1', tick: atTick, x: 0, y: 0, novelty: id === 1 ? 'both' : 'program',
    capacities: { cutting: 0.2, storage: 0, insulation: 0, cultivation: 0.1, binding: 0, abrasion: 0.2 },
  };
}

function syntheticStats(n: number): TechnologyStats {
  return { uses: n, utility: n / 4, manufactured: n };
}

test('A1: compactación incremental de technology_stats reduce filas, preserva slots [0,1,2], ventana=0 conserva todo y digestoCanonico es idéntico', t => {
  const compacted = laboratorio(t, 'atlas-a1-compact-');
  const control = laboratorio(t, 'atlas-a1-control-');

  const wCompact = createWorld(51926);
  setParams(wCompact, parseParams('persistencia.ventanaEventosTicks=2400'));
  const wControl = createWorld(51926);
  setParams(wControl, parseParams('persistencia.ventanaEventosTicks=0'));

  compacted.store.save(wCompact);
  control.store.save(wControl);

  const r1Compact = inventTool(wCompact, 0, undefined, 2);
  const r1Control = inventTool(wControl, 0, undefined, 2);
  assert.equal(r1Compact, r1Control);
  compacted.store.save(wCompact);
  control.store.save(wControl);

  const r2Compact = inventTool(wCompact, 1, undefined, 3);
  const r2Control = inventTool(wControl, 1, undefined, 3);
  assert.equal(r2Compact, r2Control);
  compacted.store.save(wCompact);
  control.store.save(wControl);

  // Acumular 10 versiones históricas de estadísticas por receta repartidas en 10 000 ticks.
  let slot2World: World | null = null;
  for (let step = 1; step <= 10; step++) {
    fixtureTick(wCompact, wCompact.tick + 1000);
    fixtureTick(wControl, wControl.tick + 1000);
    useCutting(wCompact, 5, 2);
    useCutting(wControl, 5, 2);
    useCutting(wCompact, 5, 3);
    useCutting(wControl, 5, 3);
    compacted.store.save(wCompact);
    control.store.save(wControl);
    if (step === 5) {
      // Simular respaldo profundo en slot 2 al paso 5.
      compacted.store.db.exec('INSERT OR REPLACE INTO snapshots SELECT 2,body,digest,saved_at FROM snapshots WHERE slot=0');
      slot2World = structuredClone(wCompact);
      setParams(slot2World, parseParams('persistencia.ventanaEventosTicks=2400'));
    }
  }

  const controlRows = count(control.store.db, 'SELECT COUNT(*) AS n FROM technology_stats');
  const compactedRows = count(compacted.store.db, 'SELECT COUNT(*) AS n FROM technology_stats');
  assert.ok(controlRows >= 20, `esperaba historial completo con ventana=0, vi ${controlRows}`);
  assert.ok(compactedRows < controlRows, `compactación debe reducir filas: ${compactedRows} < ${controlRows}`);
  // Cada receta conserva al menos su última fila <= cutoffTick y las posteriores.
  for (const id of [r1Compact, r2Compact]) {
    const perRecipe = count(compacted.store.db, 'SELECT COUNT(*) AS n FROM technology_stats WHERE recipeId=?', id);
    assert.ok(perRecipe >= 1, `${id} nunca pierde su última fila`);
  }

  // Verificar load() en conexión activa y en conexión readOnly fresca.
  const loadedCompact = compacted.store.load()!;
  const loadedControl = control.store.load()!;
  assert.equal(loadedCompact.slot, 0);
  assert.deepEqual(loadedCompact.world, wCompact);
  assert.deepEqual(loadedControl.world, wControl);
  // Comparar digestoCanonico con mismos params (estado del mundo idéntico bit a bit).
  const digestExpected = digestoCanonico(wCompact);
  assert.equal(digestoCanonico(loadedCompact.world), digestExpected);
  const wControlSameParams = structuredClone(loadedControl.world);
  setParams(wControlSameParams, parseParams('persistencia.ventanaEventosTicks=2400'));
  assert.equal(digestoCanonico(wControlSameParams), digestExpected, 'compactar stats no altera el estado ni el digesto canónico');

  const ro = new Store(compacted.path, { readOnly: true });
  try {
    const roLoaded = ro.load()!;
    assert.equal(digestoCanonico(roLoaded.world), digestExpected);
  } finally { ro.close(); }

  // Verificar previous() sobre slot 1 y slot 2 tras la compactación.
  for (const slot of [1, 2] as const) {
    const dest = join(compacted.directory, `prev-slot-${slot}.sqlite`);
    assert.equal(compacted.store.previous(dest, slot), slot);
    const recovered = new Store(dest, { readOnly: true });
    try {
      const recLoaded = recovered.load()!;
      assert.equal(recLoaded.slot, 0);
      assertWorld(recLoaded.world, recLoaded.world.version, recovered.context);
      if (slot === 2) {
        assert.equal(recLoaded.world.tick, slot2World!.tick);
        assert.equal(digestoCanonico(recLoaded.world), digestoCanonico(slot2World!));
      } else {
        assert.equal(recLoaded.world.tick, wCompact.tick - 1000);
      }
    } finally { recovered.close(); }
  }
});

test('A1: compactStats respeta maxRows, nunca borra la última fila <= beforeTick y falla cerrada ante corrupción', t => {
  const dir = directorioTemporal(t, 'atlas-a1-archive-');
  const db = new DatabaseSync(join(dir, 'archive.sqlite'));
  t.after(() => db.close());
  const archive = new TechnologyArchive(db);
  db.exec('BEGIN'); archive.installSchema(); db.exec('COMMIT');

  const defs = [1, 2, 3].map(n => syntheticDefinition(n, n));
  db.exec('BEGIN');
  archive.beginHostTransaction();
  for (const d of defs) {
    archive.putDefinition(d);
    for (const at of [10, 20, 30, 40, 50]) archive.putStats(d.id, at, syntheticStats(at / 10));
  }
  db.exec('COMMIT');
  archive.acknowledgeHostCommit();
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM technology_stats'), 15);

  // Compactar <= 40 con tope de 2 filas por llamada: debe borrar exactamente 9 filas (10, 20, 30 para 3 recetas).
  let totalDeleted = 0, calls = 0;
  while (calls < 10) {
    db.exec('BEGIN');
    archive.beginHostTransaction();
    const deleted = archive.compactStats(40, 2);
    db.exec('COMMIT');
    archive.acknowledgeHostCommit();
    assert.ok(deleted <= 2, `respetó maxRows=2, borró ${deleted}`);
    if (deleted === 0) break;
    totalDeleted += deleted;
    calls++;
  }
  assert.equal(totalDeleted, 9);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM technology_stats'), 6);
  for (const d of defs) {
    assert.deepEqual(archive.getStats(d.id, 40), { recipeId: d.id, tick: 40, ...syntheticStats(4) });
    assert.deepEqual(archive.getStats(d.id, 50), { recipeId: d.id, tick: 50, ...syntheticStats(5) });
  }

  // Compactar <= 50 deja exactamente 1 fila por receta y una nueva llamada devuelve 0 sin borrarla.
  db.exec('BEGIN'); archive.beginHostTransaction();
  assert.equal(archive.compactStats(50, 100), 3);
  assert.equal(archive.compactStats(50, 100), 0);
  db.exec('COMMIT'); archive.acknowledgeHostCommit();
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM technology_stats'), 3);
  assert.equal(archive.summarizeDefinitions(50).uses, 15);

  // Corrupción 1: checksum roto en fila vieja debe fallar cerrada antes de borrar nada.
  db.exec('BEGIN'); archive.beginHostTransaction();
  archive.putStats('recipe-1', 60, syntheticStats(6));
  db.exec('COMMIT'); archive.acknowledgeHostCommit();
  db.prepare("UPDATE technology_stats SET body=replace(body,'5','99') WHERE recipeId='recipe-1' AND tick=50").run();
  db.exec('BEGIN');
  assert.throws(() => archive.compactStats(60, 10), /checksum/);
  db.exec('ROLLBACK');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM technology_stats WHERE recipeId=?', 'recipe-1'), 2);

  // Corrupción 2: regresión de monotonicidad con digesto recalculado debe fallar cerrada sin borrar.
  const badBody = JSON.stringify({ recipeId: 'recipe-1', tick: 50, uses: 99, utility: 99, manufactured: 99 });
  db.prepare("UPDATE technology_stats SET body=?,digest=? WHERE recipeId='recipe-1' AND tick=50").run(badBody, sha256(badBody));
  db.exec('BEGIN');
  assert.throws(() => archive.compactStats(60, 10), /regression/);
  db.exec('ROLLBACK');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM technology_stats WHERE recipeId=?', 'recipe-1'), 2);
});

test('A1: ensurePerformanceIndexes añade índices faltantes en escritura y NUNCA modifica una BD readOnly', t => {
  const { path, store } = laboratorio(t, 'atlas-a1-indexes-');
  const world = createWorld(51926);
  store.save(world);
  inventTool(world, 0);
  store.save(world);
  store.close();

  // Simular una base existente V5 creada antes de Fase A (sin los dos índices nuevos).
  const raw = new DatabaseSync(path);
  try {
    raw.exec('DROP INDEX technology_definitions_order; DROP INDEX technology_stats_tick; PRAGMA wal_checkpoint(TRUNCATE);');
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM main.sqlite_schema WHERE type='index' AND name IN ('technology_definitions_order','technology_stats_tick')"), 0);
  } finally { raw.close(); }

  // Abrir en modo readOnly: debe cargar intacta y NO tocar ningún byte ni crear índices.
  const beforeBytes = readFileSync(path);
  const ro = new Store(path, { readOnly: true });
  try {
    assert.equal(ro.load()!.world.technology.recipeCounter, 1);
    assert.equal(count(ro.db, "SELECT COUNT(*) AS n FROM main.sqlite_schema WHERE type='index' AND name IN ('technology_definitions_order','technology_stats_tick')"), 0);
  } finally { ro.close(); }
  assert.equal(Buffer.compare(readFileSync(path), beforeBytes), 0, 'readOnly jamás modifica la BD');

  // Abrir en modo escritura: crea ambos índices de forma segura y carga limpiamente.
  const rw = new Store(path);
  try {
    assert.equal(count(rw.db, "SELECT COUNT(*) AS n FROM main.sqlite_schema WHERE type='index' AND name IN ('technology_definitions_order','technology_stats_tick')"), 2);
    assert.equal(rw.load()!.world.technology.recipeCounter, 1);
  } finally { rw.close(); }
});

test('A2: EXPLAIN QUERY PLAN confirma 0 TEMP B-TREE en technology_definitions y carga rápida de 550 recetas con autor fallecido memoizado', t => {
  const { path, store } = laboratorio(t, 'atlas-a2-perf-');
  const world = createWorld(51926);
  world.reproductionEnabled = false;
  store.save(world);

  // Inventar 1 receta real y luego hacer morir a su inventor y evictarlo del caché residente `world.legacy`.
  const inventor = world.people[2]!;
  const firstId = inventTool(world, 0);
  store.save(world);
  const firstDef = store.technologyArchive.getDefinition(firstId)!;

  for (const p of world.people) { p.action = 'approach'; p.target = { x: p.x, y: p.y }; p.decisionAt = world.tick + 10000; }
  inventor.thirst = 1; inventor.hunger = 0.5; inventor.demography.health = Number.MIN_VALUE;
  stepWorld(world, [], store.context);
  assert.equal(world.people.some(p => p.id === inventor.id), false, 'el inventor falleció');
  store.save(world);
  const deceased = store.loadLegacy(inventor.id)!;
  assert.ok(deceased);
  world.legacy = world.legacy.filter(r => r.id !== inventor.id);
  store.save(world);

  // Insertar 550 definiciones en cadena de padres + 1650 estadísticas en un archivo separado para medir
  // EXPLAIN QUERY PLAN y velocidad real de carga completa (sin mutar la física del mundo).
  const benchDir = directorioTemporal(t, 'atlas-a2-bench-');
  const benchPath = join(benchDir, 'bench.sqlite');
  const benchStore = new Store(benchPath);
  t.after(() => benchStore.close());
  const benchWorld = createWorld(51926);
  benchStore.save(benchWorld);
  // Archivar un autor fallecido sintético válido a través del flujo de legacy de una copia de prueba.
  const living = benchWorld.people[2]!;
  for (const p of benchWorld.people) { p.action = 'approach'; p.target = { x: p.x, y: p.y }; p.decisionAt = benchWorld.tick + 10000; }
  living.thirst = 1; living.hunger = 0.5; living.demography.health = Number.MIN_VALUE;
  stepWorld(benchWorld, [], benchStore.context);
  const deadTick = benchWorld.tick;
  benchStore.save(benchWorld);
  benchWorld.legacy = benchWorld.legacy.filter(r => r.id !== living.id);
  benchStore.save(benchWorld);

  // Poblar 550 definiciones con padres encadenados del autor fallecido + 3 stats por receta (1650 stats).
  const RECIPES = 550;
  benchStore.db.exec('BEGIN IMMEDIATE');
  benchStore.technologyArchive.beginHostTransaction();
  let prevDef: TechnologyDefinition | undefined;
  let totalUses = 0, totalManufactured = 0, totalUtility = 0;
  for (let i = 1; i <= RECIPES; i++) {
    const def: TechnologyDefinition = {
      ...syntheticDefinition(i, deadTick, prevDef),
      inventorId: living.id,
      tick: deadTick,
    };
    benchStore.technologyArchive.putDefinition(def);
    benchStore.technologyArchive.putStats(def.id, deadTick, { uses: 1, manufactured: 1, utility: 0.25 });
    benchStore.technologyArchive.putStats(def.id, deadTick + 1, { uses: 2, manufactured: 1, utility: 0.5 });
    benchStore.technologyArchive.putStats(def.id, deadTick + 2, { uses: 3, manufactured: 2, utility: 0.75 });
    totalUses += 3; totalManufactured += 2; totalUtility += 0.75;
    prevDef = def;
  }
  benchStore.db.exec('COMMIT');
  benchStore.technologyArchive.acknowledgeHostCommit();

  // Verificar EXPLAIN QUERY PLAN antes y después de ANALYZE: 0 TEMP B-TREE.
  for (const analyze of [false, true]) {
    if (analyze) benchStore.db.exec('ANALYZE');
    const defPlan = (benchStore.db.prepare(
      'EXPLAIN QUERY PLAN SELECT id,tick,signature,body,digest FROM technology_definitions WHERE +tick<=? ORDER BY length(id),id'
    ).all(deadTick + 2) as { detail: string }[]).map(r => r.detail).join(' | ');
    assert.match(defPlan, /USING INDEX technology_definitions_order/, `ANALYZE=${analyze}: ${defPlan}`);
    assert.doesNotMatch(defPlan, /TEMP B-TREE/, `ANALYZE=${analyze}: no debe usar TEMP B-TREE: ${defPlan}`);

    const statsPlan = (benchStore.db.prepare(
      'EXPLAIN QUERY PLAN SELECT MIN(tick) AS tick FROM technology_stats WHERE tick>?'
    ).all(deadTick + 2) as { detail: string }[]).map(r => r.detail).join(' | ');
    assert.match(statsPlan, /USING COVERING INDEX technology_stats_tick/, `ANALYZE=${analyze}: ${statsPlan}`);
  }

  // Verificar que summarizeDefinitions con 550 recetas + 1650 stats decodifica cada definición UNA sola vez.
  const archiveInternal = benchStore.technologyArchive as unknown as {
    definition(row: unknown): TechnologyDefinition;
    scanDefinitions(...a: unknown[]): unknown;
  };
  const origDef = archiveInternal.definition;
  let defDecodes = 0;
  archiveInternal.definition = function (row) { defDecodes++; return origDef.call(this, row); };
  benchStore.technologyArchive.invalidateVerification();
  const t0 = performance.now();
  let summary;
  try {
    summary = benchStore.technologyArchive.summarizeDefinitions(deadTick + 2);
  } finally { archiveInternal.definition = origDef; }
  const elapsedMs = performance.now() - t0;
  assert.equal(summary.recipes, RECIPES);
  assert.equal(summary.maxGeneration, RECIPES);
  assert.equal(summary.uses, totalUses);
  assert.equal(summary.manufactured, totalManufactured);
  assert.ok(Math.abs(summary.utility - totalUtility) < 1e-9);
  assert.equal(defDecodes, RECIPES, `esperaba exactamente ${RECIPES} decodificaciones (0 re-decodificaciones de padres ni stats), obtuvo ${defDecodes}`);
  assert.ok(elapsedMs < 2000, `summarizeDefinitions(550 recetas, 1650 stats) tardó ${elapsedMs.toFixed(1)} ms`);

  // Verificar en Store.load(): 1 solo scanDefinitions y memoización de loadLegacy para autor fallecido.
  const storeInternal = store as unknown as { readLegacyRecord(...a: unknown[]): unknown };
  const archiveProto = TechnologyArchive.prototype as unknown as { scanDefinitions(...a: unknown[]): unknown };
  const origReadLegacy = storeInternal.readLegacyRecord;
  const origScan = archiveProto.scanDefinitions;
  let legacyCalls = 0, scanCalls = 0;
  storeInternal.readLegacyRecord = function (...a) { legacyCalls++; return origReadLegacy.apply(this, a); };
  archiveProto.scanDefinitions = function (...a) { scanCalls++; return origScan.apply(this, a); };
  try {
    store.technologyArchive.invalidateVerification();
    const loaded = store.load()!;
    assert.equal(loaded.world.technology.recipeCounter, 1);
    assert.equal(scanCalls, 1, 'Store.load() debe barrer technology_definitions una sola vez');
    assert.ok(legacyCalls <= world.people.length + 2, `legacy memoizado: ${legacyCalls} llamadas`);
  } finally {
    storeInternal.readLegacyRecord = origReadLegacy;
    archiveProto.scanDefinitions = origScan;
  }

  // Verificar que archivedRecipeMemo sobrevive a un save() limpio para recetas no modificadas e invalida modificadas.
  const reader = store.catalogueReader;
  const cachedBefore = reader.resolve(firstDef.id, world.tick)!;
  assert.equal(cachedBefore.id, firstDef.id);
  const origGetDef = store.technologyArchive.getDefinition.bind(store.technologyArchive);
  let defLookups = 0;
  store.technologyArchive.getDefinition = (...a) => { defLookups++; return origGetDef(...a); };
  try {
    fixtureTick(world, world.tick + 1);
    store.save(world);
    defLookups = 0;
    const afterSave = reader.resolve(firstDef.id, world.tick)!;
    assert.equal(afterSave.id, firstDef.id);
    assert.equal(defLookups, 0, 'receta fría sin cambios sobrevive en archivedRecipeMemo tras save() limpio');
  } finally {
    store.technologyArchive.getDefinition = origGetDef;
  }
});

test('A3: poda escalada supera 4096 recibos en un guardado cuando pending.length*2 es mayor', t => {
  const { store } = laboratorio(t, 'atlas-a3-prune-');
  const world = createWorld(51926);
  setParams(world, parseParams('persistencia.ventanaEventosTicks=2400'));
  store.save(world);
  inventTool(world, 0);
  store.save(world);

  // Generar 5200 recibos antiguos en varios ticks pequeños (sin superar ventana todavía).
  const toolIndex = { next: 1 };
  for (let batch = 0; batch < 26; batch++) {
    fixtureTick(world, world.tick + 10);
    useCutting(world, 200, 2, toolIndex);
    store.save(world);
  }
  const beforePruneCount = count(store.db, 'SELECT COUNT(*) AS n FROM technology_executions');
  assert.ok(beforePruneCount > 5200);

  // Avanzar más allá de la ventana y acumular >= 2600 recibos pendientes (cap escalado >= 5200 > 4096).
  fixtureTick(world, world.tick + TECHNOLOGY_RETENTION_MIN_TICKS + 1000);
  useCutting(world, 2600, 2, toolIndex);
  assert.ok(world.technology.journal!.pending.length >= 2600);
  store.save(world);

  const row = store.db.prepare("SELECT value FROM metadata WHERE key='technology-pruned-v1'").get() as { value: string } | undefined;
  assert.ok(row, 'debe haberse escrito la frontera de poda');
  const pruned = JSON.parse(row!.value) as { through: number; count: number };
  assert.ok(pruned.through > TECHNOLOGY_PRUNE_ROWS_PER_SAVE,
    `la poda escalada debe superar ${TECHNOLOGY_PRUNE_ROWS_PER_SAVE} recibos en un guardado; podó ${pruned.through}`);
  assert.deepEqual(store.load()!.world, world);
});

test('A3: rotación de slot 2 es resistente a reinicios del proceso', t => {
  const dir = directorioTemporal(t, 'atlas-a3-slot2-');
  const path = join(dir, 'world.sqlite');
  const world = createWorld(51926);

  // Proceso 1: 60 guardados y cierre.
  const first = new Store(path);
  try {
    for (let n = 1; n <= 60; n++) { fixtureTick(world, n); first.save(world); }
    assert.equal(first.db.prepare('SELECT body FROM snapshots WHERE slot=2').get(), undefined);
  } finally { first.close(); }

  // Proceso 2 (tras reinicio): 39 guardados más (total 99) aún sin slot 2; el 40º (total 100) rota slot 2.
  const second = new Store(path);
  try {
    const resumed = second.load()!.world;
    for (let n = 61; n < DEEP_CHECKPOINT_EVERY_SAVES; n++) { fixtureTick(resumed, n); second.save(resumed); }
    assert.equal(second.db.prepare('SELECT body FROM snapshots WHERE slot=2').get(), undefined, 'aún no toca en el guardado 99');
    fixtureTick(resumed, DEEP_CHECKPOINT_EVERY_SAVES);
    second.save(resumed);
    const slot2 = second.db.prepare('SELECT body FROM snapshots WHERE slot=2').get() as { body: string } | undefined;
    assert.ok(slot2, 'el guardado 100 acumulado tras reinicio debe rotar slot 2');
    assert.equal(JSON.parse(slot2!.body).tick, DEEP_CHECKPOINT_EVERY_SAVES - 1);

    const dest = join(dir, 'recovered-slot2.sqlite');
    assert.equal(second.previous(dest, 2), 2);
    const recovered = new Store(dest, { readOnly: true });
    try { assert.equal(recovered.load()!.world.tick, DEEP_CHECKPOINT_EVERY_SAVES - 1); }
    finally { recovered.close(); }
  } finally { second.close(); }
});

test('A3: auto_vacuum=INCREMENTAL en bases nuevas reclama páginas y bytes en disco tras poda/compactación', t => {
  const { path, store } = laboratorio(t, 'atlas-a3-vacuum-');
  assert.equal(Number((store.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum), 2);
  assert.equal(Number((store.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size), 8192);

  const world = createWorld(51926);
  setParams(world, parseParams('persistencia.ventanaEventosTicks=2400'));
  store.save(world);
  inventTool(world, 0);
  store.save(world);

  // Llenar la base con miles de recibos y versiones de estadísticas para crecer cientos de páginas.
  const toolIndex = { next: 1 };
  for (let batch = 0; batch < 15; batch++) {
    fixtureTick(world, world.tick + 10);
    useCutting(world, 250, 2, toolIndex);
    store.save(world);
  }
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pagesBefore = Number((store.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
  const bytesBefore = statSync(path).size;

  // Avanzar más allá de la ventana y guardar varias veces para podar, compactar y ejecutar incremental_vacuum(256).
  for (let n = 0; n < 4; n++) {
    fixtureTick(world, world.tick + TECHNOLOGY_RETENTION_MIN_TICKS + 1000);
    store.save(world);
  }
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pagesAfter = Number((store.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
  const bytesAfter = statSync(path).size;

  assert.ok(pagesAfter < pagesBefore, `auto_vacuum=INCREMENTAL debe reducir page_count: ${pagesBefore} → ${pagesAfter}`);
  assert.ok(bytesAfter < bytesBefore, `auto_vacuum=INCREMENTAL debe reducir bytes en disco: ${bytesBefore} → ${bytesAfter}`);
  assert.deepEqual(store.load()!.world, world);
});

test('A4: respaldo.sh soporta backup/vacuum y SQLITE_TMPDIR, rechaza método inválido, y la unidad systemd declara cuotas', t => {
  const dir = directorioTemporal(t, 'atlas-a4-respaldo-');
  const dbPath = join(dir, 'world.sqlite');
  const store = new Store(dbPath);
  const world = createWorld(70410);
  store.save(world);
  store.close();

  const script = resolve('scripts/respaldo.sh');

  // Rechaza RESPALDO_METODO inválido sin crear copias.
  const bad = spawnSync('bash', [script], {
    env: { ...process.env, DB: dbPath, DEST: join(dir, 'bad'), RESPALDO_METODO: 'invalido', RESPALDO_TIMEOUT_SEGUNDOS: '10' },
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /RESPALDO_METODO/);
  assert.equal(existsSync(join(dir, 'bad')), false);

  // Ambos métodos producen copias válidas y aceptan SQLITE_TMPDIR externo (aun si no existía).
  for (const method of ['backup', 'vacuum'] as const) {
    const dest = join(dir, `dest-${method}`);
    const customTmp = join(dir, `sqlite-tmp-${method}`);
    const res = spawnSync('bash', [script], {
      env: { ...process.env, DB: dbPath, DEST: dest, SQLITE_TMPDIR: customTmp, RESPALDO_METODO: method, RESPALDO_TIMEOUT_SEGUNDOS: '15' },
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(res.status, 0, `${method}: ${res.stderr}`);
    assert.equal(existsSync(customTmp), true, `${method}: crea SQLITE_TMPDIR si no existía`);
    const files = readdirSync(dest).filter(f => f.endsWith('.sqlite.gz'));
    assert.equal(files.length, 1);
    const decoded = join(dir, `decoded-${method}.sqlite`);
    writeFileSync(decoded, gunzipSync(readFileSync(join(dest, files[0]!))));
    const copy = new Store(decoded, { readOnly: true });
    try {
      const loaded = copy.load()!;
      assert.equal(loaded.world.tick, world.tick);
      assert.equal(digestoCanonico(loaded.world), digestoCanonico(world));
    } finally { copy.close(); }
  }

  // Verificar la unidad systemd versionada.
  const unit = readFileSync(resolve('scripts/systemd/torre/atlas-respaldo-publico.service'), 'utf8');
  assert.match(unit, /TMPDIR=\/datos\/workspaces\/personal\/AtlasParaIsa-anexo\/publicaciones\/tmp/);
  assert.match(unit, /SQLITE_TMPDIR=\/datos\/workspaces\/personal\/AtlasParaIsa-anexo\/publicaciones\/tmp/);
  assert.match(unit, /MemoryHigh=3G/);
  assert.match(unit, /IOSchedulingClass=idle/);
  assert.match(unit, /Nice=15/);
});
