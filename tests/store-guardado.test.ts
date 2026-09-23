import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { createWorld } from '../src/world/index.js';
import { researchTechnology } from '../src/world/technology.js';
import type { TechnologyDefinition } from '../src/shared/technology-archive.js';
import type { TechnologyProgram } from '../src/shared/technology.js';
import { filaInstantanea, sha256 } from './lib/store.js';
import { proyectoInvestigacion } from './lib/escenas.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-save-statements-')), path = join(directory, 'world.sqlite');
  const store = new Store(path), world = createWorld(51926);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.save(world);
  const actor = world.people[2]!;
  actor.materials.stone = 8; actor.energy = 1; actor.fatigue = 0.1;
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 4000 }],
    steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'compress', intensity: 2 }] };
  actor.technology.project = proyectoInvestigacion(program, world.tick);
  for (let n = 0; n < 100 && actor.technology.project; n++) {
    world.tick++; for (const person of world.people) person.demography.age = world.tick - person.bornAt;
    researchTechnology(world, actor);
  }
  assert.equal(world.technology.recipeCounter, 1);
  store.save(world);
  const recipe = store.technologyArchive.getDefinition('recipe-1')!;
  assert.ok(recipe); assert.ok(store.technologyArchive.getStats(recipe.id));
  return { store, world, path, recipe };
}
const snapshot = (store: Store) => filaInstantanea(store);
function forgeGeneration(db: DatabaseSync, recipe: TechnologyDefinition): void {
  const body = JSON.stringify({ ...recipe, generation: recipe.generation + 1 });
  db.prepare('UPDATE technology_definitions SET body=?,digest=? WHERE id=?')
    .run(body, sha256(body), recipe.id);
}

test('reusing SQL programs preserves snapshot bytes and a cold verified restart', t => {
  const { store, world, path } = fixture(t), before = snapshot(store);
  for (let n = 0; n < 12; n++) store.save(world);
  assert.deepEqual(snapshot(store), before, 'guardados sin cambios, incluida validación profunda, conservan bytes');
  const reopened = new Store(path, { readOnly: true });
  try { assert.deepEqual(reopened.load()!.world, world); }
  finally { reopened.close(); }
});

// T105: `prepareTechnology`/`flushTechnology` dejaron de reconstruir en cada guardado lo
// que ya estaba probado (store.ts: `rememberTechnology` reutiliza el `body` cacheado de una
// receta residente en vez de recalcular `JSON.stringify(definitionOf(recipe))`, y el bucle
// «en frío» de `flushTechnology` solo repite `sameStats` para una receta ya cacheada). Estas
// pruebas fijan el contrato: mismas filas escritas, misma detección de corrupción.
const dumpTechnologyTables = (store: Store): Record<string, unknown[]> => Object.fromEntries(
  ([['technology_definitions', 'length(id),id'], ['technology_stats', 'recipeId,tick'],
    ['technology_executions', 'serial'], ['technology_origin', 'id']] as const).map(([table, order]) =>
    [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));

test('T105: recetas residentes sin cambios escriben las mismas filas de tecnología guardado tras guardado', t => {
  const { store, world, recipe } = fixture(t);
  // Segunda receta: mientras se inventa, `recipe-1` queda fuera de `pending` (no cambia)
  // y pasa por el bucle «en frío» de `flushTechnology` en cada uno de estos guardados.
  const actor = world.people[3]!;
  actor.materials.wood = 8; actor.energy = 1; actor.fatigue = 0.1;
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 4000 }],
    steps: [{ op: 'form', shape: 'rod', intensity: 3 }] };
  actor.technology.project = proyectoInvestigacion(program, world.tick);
  for (let n = 0; n < 100 && actor.technology.project; n++) {
    world.tick++; for (const person of world.people) person.demography.age = world.tick - person.bornAt;
    researchTechnology(world, actor);
  }
  assert.equal(world.technology.recipeCounter, 2, 'la segunda receta se registró');
  store.save(world);
  const afterSecondRecipe = dumpTechnologyTables(store);
  const cachedBody = (store as unknown as { verifiedRecipes: Map<string, { body: string }> }).verifiedRecipes.get(recipe.id)!.body;
  // Guardados adicionales sin ningún cambio: `recipe-1` sigue sin estar en `pending`,
  // así que cada uno reutiliza el mismo `body` cacheado (misma referencia de cadena) en
  // vez de reconstruirlo, y las filas durables no se tocan.
  for (let round = 0; round < 4; round++) {
    store.save(world);
    assert.deepEqual(dumpTechnologyTables(store), afterSecondRecipe, `guardado ${round}: las filas de tecnología no cambian`);
    const nowCached = (store as unknown as { verifiedRecipes: Map<string, { body: string }> }).verifiedRecipes.get(recipe.id)!.body;
    assert.ok(Object.is(nowCached, cachedBody), `guardado ${round}: el body de recipe-1 se reutiliza, no se recalcula`);
  }
});

test('T105: un guardado con la caché de recetas vacía escribe las mismas filas que uno con la caché caliente', t => {
  const first = fixture(t), second = fixture(t);
  for (const { store, world } of [first, second]) for (let n = 0; n < 3; n++) store.save(world);
  // Fuerza en `second` el camino «en frío» (sin `verifiedRecipes`) que T105 dejó de pagar
  // en cada guardado; debe escribir exactamente lo mismo que el camino caliente de `first`.
  (second.store as unknown as { verifiedRecipes: Map<string, unknown> }).verifiedRecipes.clear();
  second.store.save(second.world);
  first.store.save(first.world);
  assert.deepEqual(dumpTechnologyTables(second.store), dumpTechnologyTables(first.store));
});

test('T105: una receta residente mutada sin registro pendiente se sigue rechazando', t => {
  const { store, world, recipe } = fixture(t);
  store.save(world);
  // Sin pasar por `updateTechnologyRecipeStats` (que además la pendría), como haría un
  // futuro error de programación: el guardado debe seguir fallando por estadísticas, no
  // solo por definición, para que el atajo de T105 no lo deje pasar en silencio.
  const live = world.technology.recipes.find(r => r.id === recipe.id)!;
  live.uses += 1;
  assert.throws(() => store.save(world), /resident definition or statistics changed without a pending record/);
});

for (const external of [false, true]) test(`warm SQL programs reject checksum-consistent corruption from ${external ? 'another connection' : 'the same connection'}`, t => {
  const { store, world, path, recipe } = fixture(t), before = snapshot(store);
  const writer = external ? new DatabaseSync(path) : store.db;
  try { forgeGeneration(writer, recipe); } finally { if (external) writer.close(); }
  assert.throws(() => store.technologyArchive.getDefinition(recipe.id), /definition generation/);
  assert.throws(() => store.save(world), /definition generation|technology/i);
  assert.deepEqual(snapshot(store), before, 'la corrupción no se confirma ni se repara con la caché');
  const reopened = new Store(path, { readOnly: true });
  try { assert.throws(() => reopened.load(), /definition generation|technology/i); }
  finally { reopened.close(); }
});

test('rollback after a warmed query discards a temporary repair and never credits it to the next save', t => {
  const { store, world, recipe } = fixture(t), before = snapshot(store);
  forgeGeneration(store.db, recipe);
  store.db.exec('BEGIN');
  const body = JSON.stringify(recipe);
  store.db.prepare('UPDATE technology_definitions SET body=?,digest=? WHERE id=?')
    .run(body, sha256(body), recipe.id);
  assert.deepEqual(store.technologyArchive.getDefinition(recipe.id), recipe);
  store.db.exec('ROLLBACK');
  store.db.exec('BEGIN');
  try { assert.throws(() => store.technologyArchive.getDefinition(recipe.id), /definition generation/); }
  finally { store.db.exec('ROLLBACK'); }
  assert.throws(() => store.save(world), /definition generation|technology/i);
  assert.deepEqual(snapshot(store), before);
});

test('repeated cold references share one resolution only within each verified save', t => {
  const { store, world, recipe } = fixture(t);
  world.technology.recipes.length = 0;
  let resolutions = 0;
  const getStats = store.technologyArchive.getStats.bind(store.technologyArchive);
  store.technologyArchive.getStats = (...args) => { resolutions++; return getStats(...args); };
  store.save(world);
  assert.equal(resolutions, 1, 'los recibos y productos repiten la misma referencia fría');
  resolutions = 0;
  store.save(world);
  assert.equal(resolutions, 1, 'el siguiente guardado vuelve a comprobar la fila durable');
  const before = snapshot(store);
  forgeGeneration(store.db, recipe);
  assert.throws(() => store.save(world), /definition generation/);
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.db.isTransaction, false, 'la validación fallida cierra su transacción');
});

test('temporary resolutions preserve historical ticks and independent mutable branches', t => {
  const { store, world, recipe } = fixture(t);
  const internal = store as unknown as { withTechnologyReads: (host: typeof world, read: () => void) => void };
  internal.withTechnologyReads(world, () => {
    const initial = store.catalogueReader.resolve(recipe.id, world.tick)!;
    const expected = structuredClone(initial);
    initial.program.inputs[0]!.mass++;
    initial.program.steps[0]!.intensity++;
    initial.parents.push('recipe-999');
    initial.capacities.cutting = 0.123;
    const second = store.catalogueReader.resolve(recipe.id, world.tick)!;
    assert.deepEqual(second, expected);
    second.program.inputs[0]!.mass++;
    assert.deepEqual(store.catalogueReader.resolve(recipe.id, world.tick), expected);
    assert.equal(store.catalogueReader.resolve(recipe.id, recipe.tick - 1), null);
    assert.throws(() => store.catalogueReader.resolve(recipe.id, String(world.tick) as unknown as number), /tick/);
  });
  assert.equal(store.db.isTransaction, false);
});

for (const external of [false, true]) test(`validation rejects a database mutation during cold resolution (${external ? 'external' : 'same connection'})`, t => {
  const { store, world, path, recipe } = fixture(t), before = snapshot(store);
  world.technology.recipes.length = 0;
  const getStats = store.technologyArchive.getStats.bind(store.technologyArchive);
  let changed = false;
  store.technologyArchive.getStats = (...args) => {
    const result = getStats(...args);
    if (!changed) {
      changed = true;
      const writer = external ? new DatabaseSync(path) : store.db;
      try { forgeGeneration(writer, recipe); } finally { if (external) writer.close(); }
    }
    return result;
  };
  assert.throws(() => store.save(world), /database changed during technology validation|definition generation/);
  assert.equal(changed, true);
  assert.equal(store.db.isTransaction, false);
  assert.deepEqual(snapshot(store), before);
  store.technologyArchive.getStats = getStats;
  if (external) assert.throws(() => store.save(world), /definition generation/);
  else {
    store.save(world);
    assert.deepEqual(store.technologyArchive.getDefinition(recipe.id), recipe, 'el rollback revierte solamente la escritura dentro de la validación');
  }
});
