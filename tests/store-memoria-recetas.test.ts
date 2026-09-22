/**
 * Memoria de recetas archivadas del Store (sprint noche-perf 2026-09-22, `archivedRecipeMemo`). La
 * resolución de recetas fuera de la ventana residente del mundo leía y verificaba SQLite en cada
 * consulta; ahora recuerda cada lectura mientras la base no cambie. Estas pruebas fijan lo que la
 * memoria NO puede cambiar: cada consulta devuelve una copia nueva (el mundo la muta después), una
 * escritura propia (guardado) o ajena (otra conexión) invalida lo recordado, y una lectura «a fecha
 * de» un tick anterior a la fila más reciente nunca sale de la memoria.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { createWorld, type World } from '../src/world/index.js';
import { researchTechnology, technologyWorkCost, type TechnologyProgram } from '../src/world/technology.js';
import { updateTechnologyRecipeStats } from '../src/world/technology-catalogue.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-store-memoria-recetas-')), path = join(directory, 'world.sqlite');
  const store = new Store(path), world = createWorld(51926);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.save(world);
  return { path, store, world };
}

/** Mismo experimento pagado que `technology-store-review.test.ts`: una receta real, con su trabajo. */
function paidResearch(world: World) {
  const actor = world.people[2]!;
  actor.materials = { wood: 12, stone: 8 }; actor.energy = 1; actor.fatigue = 0;
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
  actor.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  let steps = 0;
  while (actor.technology.project && steps++ < 250) advance(world);
  assert.equal(actor.technology.project, null);
  return world.technology.catalogue!.pending.at(-1)!;
}
function advance(world: World): void {
  world.tick++;
  for (const person of world.people) person.demography.age = world.tick - person.bornAt;
  const actor = world.people[2]!;
  if (actor.technology.project) researchTechnology(world, actor);
}

test('la memoria de recetas archivadas entrega copias nuevas y se invalida con escrituras propias, ajenas y lecturas del pasado', t => {
  const { path, store, world } = fixture(t);
  const recipe = paidResearch(world);
  store.save(world);
  const reader = store.catalogueReader;
  assert.equal(reader.freshCopies, true);
  const first = reader.resolve(recipe.id, world.tick)!, second = reader.resolve(recipe.id, world.tick)!;
  assert.deepEqual(second, first);
  assert.notEqual(second, first); assert.notEqual(second.program, first.program); assert.notEqual(second.program.steps[0], first.program.steps[0]);
  assert.notEqual(second.parents, first.parents); assert.notEqual(second.capacities, first.capacities);
  // Mutar lo entregado (como hace el mundo con las estadísticas) no toca lo recordado.
  const expected = structuredClone(second);
  second.uses = 999; second.program.steps[0]!.intensity = 99; second.capacities.cutting = 0;
  assert.deepEqual(reader.resolve(recipe.id, world.tick + 1), expected);

  // Escritura propia: nuevas estadísticas guardadas en un tick posterior.
  advance(world);
  updateTechnologyRecipeStats(world, recipe.id, { utility: 0.5 });
  store.save(world);
  assert.equal(reader.resolve(recipe.id, world.tick)!.utility, expected.utility + 0.5);

  // Una lectura anterior a la fila más reciente se hace entera (la definición aún no existía).
  assert.equal(reader.resolve(recipe.id, recipe.tick - 1), null);
  assert.equal(reader.resolve(recipe.id, world.tick)!.utility, expected.utility + 0.5);

  // Escritura ajena: otra conexión borra las estadísticas; la memoria no puede ocultarlo.
  const other = new DatabaseSync(path);
  try { other.prepare('DELETE FROM technology_stats WHERE recipeId=?').run(recipe.id); } finally { other.close(); }
  assert.throws(() => reader.resolve(recipe.id, world.tick), /no statistics/);
});
