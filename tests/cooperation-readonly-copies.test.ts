import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { cloneWorld, type World } from '../src/world/index.js';
import { bindTechnologyCatalogue, resolveTechnologyRecipe, updateTechnologyRecipeStats, withArchiveReadBatch,
  withReadOnlyRecipeSession, withRecipeSession, type TechnologyCatalogueReader } from '../src/world/technology-catalogue.js';
import { cooperate, cooperationOpportunity, type Opportunity } from '../src/world/society.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { worldContext } from '../src/world/spatial.js';
import { maintainTechnologyMemory, researchTechnology, shareTechnology, type TechnologyProgram } from '../src/world/technology.js';
import type { TechnologyRecipe } from '../src/shared/technology.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { aula, PROGRAMA_FILO, proyectoInvestigacion } from './lib/escenas.js';

function advance(world: World): void {
  world.tick++;
  for (const person of world.people) person.demography.age = world.tick - person.bornAt;
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-cooperation-readonly-')), path = join(directory, 'world.sqlite');
  const store = new Store(path), stores = [store];
  t.after(() => { for (const connection of stores) connection.close(); rmSync(directory, { recursive: true, force: true }); });
  const { world, maestro, aprendiz } = aula({ cuerpo: { energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1 } });
  store.save(world);
  const programs: TechnologyProgram[] = [PROGRAMA_FILO,
    { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'weave', intensity: 4 }, { op: 'form', intensity: 2, shape: 'sheet' }] },
    { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'rod' }] },
  ];
  for (const [i, program] of programs.entries()) {
    maestro.materials = { wood: 12, stone: 8 }; maestro.energy = 1; maestro.fatigue = 0;
    maestro.technology.project = proyectoInvestigacion(structuredClone(program), world.tick);
    let succeeded = false;
    while (maestro.technology.project) { advance(world); succeeded = researchTechnology(world, maestro); }
    assert.equal(succeeded, true);
    if (i === 0) assert.equal(shareTechnology(world, maestro, aprendiz, undefined, 'recipe-1'), true);
  }
  world.technology.budgets.maxRecipes = 2; world.technology.catalogue!.memoryCapacity = 2;
  for (const person of world.people) maintainTechnologyMemory(world, person);
  resolveTechnologyRecipe(world, 'recipe-2'); resolveTechnologyRecipe(world, 'recipe-3');
  store.save(world);
  const freshStore = (target = path) => { const connection = new Store(target); stores.push(connection); return connection; };
  return { directory, path, store, world, freshStore };
}
function independent(a: TechnologyRecipe, b: TechnologyRecipe): void {
  assert.deepEqual(a, b); assert.notEqual(a, b); assert.notEqual(a.program, b.program);
  assert.notEqual(a.program.inputs, b.program.inputs); assert.notEqual(a.program.steps, b.program.steps);
  assert.notEqual(a.program.inputs[0], b.program.inputs[0]); assert.notEqual(a.program.steps[0], b.program.steps[0]);
  assert.notEqual(a.parents, b.parents); assert.notEqual(a.capacities, b.capacities);
}

test('la vista reutiliza sólo sus copias separadas y el lector público sigue entregando objetos independientes', t => {
  const { store, world } = fixture(t), reader = store.catalogueReader, at = world.tick;
  let escaped: TechnologyCatalogueReader | undefined;
  reader.withReadOnlyCopies!(at, view => {
    escaped = view;
    const first = view.resolve('recipe-1', at)!;
    assert.equal(view.resolve('recipe-1', at), first);
    const publicFirst = reader.resolve('recipe-1', at)!, publicSecond = reader.resolve('recipe-1', at)!;
    independent(publicFirst, publicSecond); independent(publicFirst, first);
    const bySignature = reader.findBySignature(first.signature, at)!;
    independent(bySignature, first); independent(bySignature, publicFirst);
    const expected = structuredClone(first);
    first.uses = 999; first.program.inputs[0]!.mass = 999; first.program.steps[0]!.intensity = 999;
    first.parents.push('test-only'); first.capacities.cutting = 0;
    assert.deepEqual(reader.resolve('recipe-1', at), expected, 'la memoria privada y el archivo no comparten las ramas mutadas');
    const nested = reader.withReadOnlyCopies!(at, inner => inner.resolve('recipe-1', at)!);
    assert.deepEqual(nested, expected); assert.notEqual(nested, first);
  });
  const after = escaped!.resolve('recipe-1', at)!, afterAgain = escaped!.resolve('recipe-1', at)!;
  independent(after, afterAgain); assert.notEqual(after.uses, 999);
  const next = reader.withReadOnlyCopies!(at, view => view.resolve('recipe-1', at)!);
  independent(next, after); assert.notEqual(next, escaped!.resolve('recipe-1', at));
});

test('salir con excepción cierra la vista y restaura reader, contexto, pendientes y toques LRU', t => {
  const { store, world } = fixture(t), original = store.catalogueReader, context = worldContext(world);
  const pending = world.technology.catalogue!.pending;
  let escaped: TechnologyCatalogueReader | undefined;
  const capture: TechnologyCatalogueReader = { ...original, withReadOnlyCopies(atTick, read) {
    return original.withReadOnlyCopies!(atTick, view => { escaped = view; return read(view); });
  } };
  bindTechnologyCatalogue(world.technology, capture);
  assert.throws(() => withReadOnlyRecipeSession(world, () => {
    resolveTechnologyRecipe(world, 'recipe-1'); resolveTechnologyRecipe(world, 'recipe-3'); resolveTechnologyRecipe(world, 'recipe-2');
    throw new Error('scope sentinel');
  }), /scope sentinel/);
  assert.equal(worldContext(world), context); assert.equal(world.technology.catalogue!.pending, pending);
  assert.deepEqual(world.technology.recipes.map(recipe => recipe.id), ['recipe-3', 'recipe-2']);
  independent(escaped!.resolve('recipe-1', world.tick)!, escaped!.resolve('recipe-1', world.tick)!);
  const a = resolveTechnologyRecipe(world, 'recipe-1', { cache: false })!, b = resolveTechnologyRecipe(world, 'recipe-1', { cache: false })!;
  independent(a, b);
});

test('guardas de época, horizonte, null y estadísticas faltantes siguen visibles dentro de la vista', t => {
  const { path, store, world } = fixture(t), reader = store.catalogueReader;
  const initial = reader.resolve('recipe-1', world.tick)!;
  const other = new DatabaseSync(path); t.after(() => other.close());
  reader.withReadOnlyCopies!(world.tick, view => {
    const first = view.resolve('recipe-1', world.tick)!;
    assert.equal(view.resolve('recipe-1', initial.tick - 1), null);
    assert.equal(view.resolve('recipe-999', world.tick), null);
    assert.deepEqual(view.resolve('recipe-1', world.tick), first);
    assert.notEqual(view.resolve('recipe-1', world.tick), first, 'la lectura del pasado reemplazó la identidad raw');
    other.prepare('DELETE FROM technology_stats WHERE recipeId=?').run('recipe-1');
    assert.throws(() => view.resolve('recipe-1', world.tick), /no statistics/);
  });
  assert.throws(() => reader.resolve('recipe-1', world.tick), /no statistics/);
});

test('un guardado propio y cambios del horizonte reemplazan raw aunque el id sea el mismo', t => {
  const { store, world } = fixture(t), reader = store.catalogueReader, oldTick = world.tick;
  reader.withReadOnlyCopies!(oldTick, view => {
    const before = view.resolve('recipe-1', oldTick)!;
    advance(world); updateTechnologyRecipeStats(world, 'recipe-1', { utility: 0.5 }); store.save(world);
    const historical = view.resolve('recipe-1', oldTick)!;
    assert.deepEqual(historical, before); assert.notEqual(historical, before);
    assert.notEqual(view.resolve('recipe-1', oldTick), historical, 'antes del horizonte se relee el archivo, sin reusar por id');
    assert.equal(view.resolve('recipe-1', world.tick)!.utility, before.utility + 0.5);
  });
  reader.withReadOnlyCopies!(world.tick, view => {
    const first = view.resolve('recipe-1', world.tick)!;
    assert.equal(view.resolve('recipe-1', world.tick), first); assert.equal(first.utility, 0.5);
  });
});

test('un reinicio de la memoria de archivo no reutiliza la copia de una versión raw anterior', t => {
  const { store, world } = fixture(t), reader = store.catalogueReader;
  reader.withReadOnlyCopies!(world.tick, view => {
    const first = view.resolve('recipe-1', world.tick)!;
    Reflect.set(store, 'archivedRecipes', null);
    const refreshed = view.resolve('recipe-1', world.tick)!;
    independent(refreshed, first);
    assert.equal(view.resolve('recipe-1', world.tick), refreshed);
  });
});

test('la copia local conserva el lote habitual y una escritura externa se detecta al salir', t => {
  const { path, store, world } = fixture(t), reader = store.catalogueReader, tick = world.tick;
  const expected = reader.resolve('recipe-1', tick)!, other = new DatabaseSync(path); t.after(() => other.close());
  reader.readBatch!(tick, () => reader.withReadOnlyCopies!(tick, view => {
    const before = view.resolve('recipe-1', tick)!;
    other.prepare('DELETE FROM technology_stats WHERE recipeId=?').run('recipe-1');
    assert.equal(view.resolve('recipe-1', tick), before); assert.deepEqual(before, expected);
    reader.readBatch!(tick, () => assert.equal(view.resolve('recipe-1', tick), before));
    independent(reader.resolve('recipe-1', tick)!, reader.resolve('recipe-1', tick)!);
  }));
  assert.throws(() => reader.resolve('recipe-1', tick), /no statistics/);
  assert.throws(() => reader.readBatch!(tick + 1, () => reader.withReadOnlyCopies!(tick + 1, view => view.resolve('recipe-1', tick))), /no statistics/);
});

test('ticks no válidos, transacciones y memoria de validación usan el lector general', t => {
  const { store, world } = fixture(t), reader = store.catalogueReader;
  for (const tick of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, -1]) reader.withReadOnlyCopies!(tick, view => assert.equal(view, reader));
  store.db.exec('BEGIN');
  try { reader.withReadOnlyCopies!(world.tick, view => { assert.equal(view, reader); independent(view.resolve('recipe-1', world.tick)!, view.resolve('recipe-1', world.tick)!); }); }
  finally { store.db.exec('ROLLBACK'); }
  // La memoria interna de validación no se presta a una decisión social.
  const previous = Reflect.get(store, 'technologyReads');
  Reflect.set(store, 'technologyReads', { limit: 2, recipes: new Map() });
  try { reader.withReadOnlyCopies!(world.tick, view => { assert.equal(view, reader); independent(view.resolve('recipe-1', world.tick)!, view.resolve('recipe-1', world.tick)!); }); }
  finally { Reflect.set(store, 'technologyReads', previous); }
});

test('wrappers y callbacks de sesión genéricos conservan llamadas, copias y mutaciones de estadísticas', t => {
  const { store, world } = fixture(t), reader = store.catalogueReader, calls: string[] = [];
  const wrapped: TechnologyCatalogueReader = { ...reader, resolve(id, tick) { calls.push(`${id}@${tick}`); return reader.resolve(id, tick); } };
  bindTechnologyCatalogue(world.technology, wrapped);
  const a = withReadOnlyRecipeSession(world, () => resolveTechnologyRecipe(world, 'recipe-1', { cache: false })!);
  const b = withReadOnlyRecipeSession(world, () => resolveTechnologyRecipe(world, 'recipe-1', { cache: false })!);
  independent(a, b); assert.deepEqual(calls, [`recipe-1@${world.tick}`, `recipe-1@${world.tick}`]);
  wrapped.withReadOnlyCopies!(world.tick, view => assert.equal(view, wrapped));
  const originalResolve = reader.resolve;
  t.mock.method(reader, 'resolve', (id: string, tick: number) => { calls.push(`own:${id}@${tick}`); return originalResolve(id, tick); });
  reader.withReadOnlyCopies!(world.tick, view => { assert.equal(view, reader); independent(view.resolve('recipe-1', world.tick)!, view.resolve('recipe-1', world.tick)!); });
  bindTechnologyCatalogue(world.technology, reader);
  withRecipeSession(world, () => {
    const old = resolveTechnologyRecipe(world, 'recipe-1')!;
    const before = { uses: old.uses, utility: old.utility };
    updateTechnologyRecipeStats(world, 'recipe-1', { uses: 1, utility: 0.25 });
    const changed = resolveTechnologyRecipe(world, 'recipe-1')!;
    assert.equal(changed.uses, before.uses + 1); assert.equal(changed.utility, before.utility + 0.25);
  });
  assert.equal(reader.resolve('recipe-1', world.tick)!.uses, 0, 'una mutación del mundo no altera el raw archivado antes de guardar');
});

test('una vista activa o escapada respeta un decorador posterior del lector público', t => {
  const { store, world } = fixture(t), reader = store.catalogueReader, calls: string[] = [];
  let escaped: TechnologyCatalogueReader | undefined;
  reader.withReadOnlyCopies!(world.tick, view => {
    escaped = view;
    const first = view.resolve('recipe-1', world.tick)!, resolve = reader.resolve;
    t.mock.method(reader, 'resolve', (id: string, tick: number) => { calls.push(id); return resolve(id, tick); });
    independent(view.resolve('recipe-1', world.tick)!, first);
    independent(view.resolve('recipe-1', world.tick)!, view.resolve('recipe-1', world.tick)!);
  });
  independent(escaped!.resolve('recipe-1', world.tick)!, escaped!.resolve('recipe-1', world.tick)!);
  assert.deepEqual(calls, Array(5).fill('recipe-1'));
});

function countArchive(t: TestContext, store: Store) {
  const counts = { epoch: 0, horizon: 0, definitions: 0, stats: 0 };
  for (const [method, counter] of [['readEpoch', 'epoch'], ['latestTick', 'horizon'], ['getDefinition', 'definitions'], ['getStats', 'stats']] as const) {
    const original = store.technologyArchive[method].bind(store.technologyArchive);
    t.mock.method(store.technologyArchive, method, (...args: unknown[]) => { counts[counter]++; return Reflect.apply(original, undefined, args); });
  }
  return counts;
}
test('el alcance ahorra copias por identidad raw sin reducir llamadas o verificaciones del archivo', t => {
  const { world, freshStore } = fixture(t), plain = freshStore(), scoped = freshStore();
  const before = countArchive(t, plain), after = countArchive(t, scoped), ids = ['recipe-1', 'recipe-2', 'recipe-1', 'recipe-3', 'recipe-2', 'recipe-1'];
  const general = plain.catalogueReader.readBatch!(world.tick, () => ids.map(id => plain.catalogueReader.resolve(id, world.tick)!));
  const optimized = scoped.catalogueReader.readBatch!(world.tick, () => scoped.catalogueReader.withReadOnlyCopies!(world.tick, view => ids.map(id => view.resolve(id, world.tick)!)));
  assert.deepEqual(optimized, general); assert.deepEqual(after, before);
  // getStats verifica de nuevo la definición: tres misses llaman getDefinition seis veces.
  assert.deepEqual(after, { epoch: 1, horizon: 1, definitions: 6, stats: 3 });
  assert.equal(new Set(general).size, 6); assert.equal(new Set(optimized).size, 3);
  assert.equal(optimized[0], optimized[2]); assert.equal(optimized[2], optimized[5]);
  t.diagnostic(`reads=${JSON.stringify(after)}; returned copies: general=6 scoped=3 (3 private raw copies in either path)`);
});

function metadata(opportunity: Opportunity | undefined) {
  if (!opportunity) return undefined;
  const { person, ...detail } = opportunity; return { ...detail, personId: person.id };
}
function emitter(world: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => {
    const complete = recordChronicleEvent(world, event); world.events.push(complete); return complete;
  };
}
function countingReader(reader: TechnologyCatalogueReader, trace: string[], scoped: boolean): TechnologyCatalogueReader {
  const log = (id: string, tick: number) => trace.push(`${id}@${tick}`);
  return { ...reader, resolve(id, tick) { log(id, tick); return reader.resolve(id, tick); },
    withReadOnlyCopies: scoped ? function(atTick, read) {
      return reader.withReadOnlyCopies!(atTick, view => read({ ...view, resolve(id, tick) { log(id, tick); return view.resolve(id, tick); } }));
    } : undefined,
  };
}
function durable(store: Store) {
  return Object.fromEntries(['technology_definitions', 'technology_stats', 'technology_executions', 'events', 'metadata'].map(table =>
    [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]).concat([
      ['snapshots', store.db.prepare('SELECT slot,body,digest FROM snapshots ORDER BY slot').all()],
    ]));
}
test('expulsión/reentrada, oportunidad y cooperación conservan trazas, LRU, digesto y estado durable', t => {
  const { directory, path, store, world, freshStore } = fixture(t);
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const controlPath = join(directory, 'control.sqlite'); copyFileSync(path, controlPath);
  const control = freshStore(controlPath), optimized = freshStore();
  const A = cloneWorld(world), B = cloneWorld(world), baselineTrace: string[] = [], scopedTrace: string[] = [];
  const ordinary = countingReader(control.catalogueReader, baselineTrace, false), scoped = countingReader(optimized.catalogueReader, scopedTrace, true);
  bindTechnologyCatalogue(A.technology, ordinary); bindTechnologyCatalogue(B.technology, scoped);
  const beforeContextA = worldContext(A), beforeContextB = worldContext(B);
  const sequence = ['recipe-1', 'recipe-2', 'recipe-3', 'recipe-1', 'recipe-2', 'recipe-3'];
  const general = withArchiveReadBatch(A, () => withRecipeSession(A, () => sequence.map(id => structuredClone(resolveTechnologyRecipe(A, id)))));
  const copies = withArchiveReadBatch(B, () => withReadOnlyRecipeSession(B, () => sequence.map(id => structuredClone(resolveTechnologyRecipe(B, id)))));
  assert.deepEqual(copies, general); assert.deepEqual(scopedTrace, baselineTrace);
  assert.deepEqual(B.technology.recipes, A.technology.recipes); assert.equal(digestoCanonico(B), digestoCanonico(A));
  const opportunity = cooperationOpportunity(B, B.people[2]!);
  assert.ok(opportunity);
  assert.deepEqual(metadata(opportunity), metadata(cooperationOpportunity(A, A.people[2]!)));
  assert.deepEqual(scopedTrace, baselineTrace); assert.equal(digestoCanonico(B), digestoCanonico(A));
  const didCooperate = cooperate(B, B.people[2]!, emitter(B));
  assert.equal(didCooperate, true); assert.equal(didCooperate, cooperate(A, A.people[2]!, emitter(A)));
  assert.deepEqual(scopedTrace, baselineTrace); assert.equal(digestoCanonico(B), digestoCanonico(A));
  assert.equal(worldContext(A), beforeContextA); assert.equal(worldContext(B), beforeContextB);
  optimized.save(B); control.save(A);
  assert.equal(digestoCanonico(B), digestoCanonico(A)); assert.deepEqual(durable(optimized), durable(control));
  assert.equal(digestoCanonico(optimized.load()!.world), digestoCanonico(control.load()!.world));
});
