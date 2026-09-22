import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { createWorld } from '../src/world/index.js';
import { researchTechnology, technologyWorkCost } from '../src/world/technology.js';
import type { TechnologyDefinition } from '../src/shared/technology-archive.js';
import type { TechnologyProgram } from '../src/shared/technology.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-save-statements-')), path = join(directory, 'world.sqlite');
  const store = new Store(path), world = createWorld(51926);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.save(world);
  const actor = world.people[2]!;
  actor.materials.stone = 8; actor.energy = 1; actor.fatigue = 0.1;
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 4000 }],
    steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'compress', intensity: 2 }] };
  actor.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
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
const snapshot = (store: Store) => store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get();
function forgeGeneration(db: DatabaseSync, recipe: TechnologyDefinition): void {
  const body = JSON.stringify({ ...recipe, generation: recipe.generation + 1 });
  db.prepare('UPDATE technology_definitions SET body=?,digest=? WHERE id=?')
    .run(body, createHash('sha256').update(body).digest('hex'), recipe.id);
}

test('reusing SQL programs preserves snapshot bytes and a cold verified restart', t => {
  const { store, world, path } = fixture(t), before = snapshot(store);
  for (let n = 0; n < 12; n++) store.save(world);
  assert.deepEqual(snapshot(store), before, 'guardados sin cambios, incluida validación profunda, conservan bytes');
  const reopened = new Store(path, { readOnly: true });
  try { assert.deepEqual(reopened.load()!.world, world); }
  finally { reopened.close(); }
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
    .run(body, createHash('sha256').update(body).digest('hex'), recipe.id);
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
