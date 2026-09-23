import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, createWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { validationFixture } from '../scripts/lib/validation-fixture.js';
import { researchTechnology, technologyWorkCost, type TechnologyProgram } from '../src/world/technology.js';

/** A real, paid research yields a fully valid recipe (program, signature, generation,
 * ancestry) that only `assertWorld`'s author-identity check can still reject. */
function paidResearch(world: World) {
  const actor = world.people[2]!;
  actor.materials = { wood: 12, stone: 8 }; actor.energy = 1; actor.fatigue = 0;
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
  actor.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  let succeeded = false, steps = 0;
  while (actor.technology.project && steps++ < 250) {
    world.tick++;
    for (const person of world.people) person.demography.age = world.tick - person.bornAt;
    succeeded = researchTechnology(world, actor);
  }
  assert.equal(succeeded, true);
  assertWorld(world);
  const recipe = world.technology.catalogue?.pending.at(-1) ?? world.technology.recipes.at(-1)!;
  assert.equal(recipe.inventorId, actor.id);
  return recipe;
}

/** Batches several calls per timed sample (a lone GC pause then costs 1/callsPerBatch
 * of the sample instead of the whole thing) and keeps the fastest batch (scheduler
 * jitter only adds time, never subtracts it) as the cleanest estimate of the
 * algorithmic cost a quadratic term would still show up in. */
function fastestAssertWorldMs(population: number, warmup = 5, batches = 8, callsPerBatch = 5): number {
  const world = validationFixture(population, 64);
  for (let i = 0; i < warmup; i++) assertWorld(world);
  let fastestBatchMs = Infinity;
  for (let b = 0; b < batches; b++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < callsPerBatch; i++) assertWorld(world);
    fastestBatchMs = Math.min(fastestBatchMs, Number(process.hrtime.bigint() - start) / 1e6);
  }
  return fastestBatchMs / callsPerBatch;
}

/** Las medidas de tiempo dependen de la carga del host: solo corren con CARTA_TEST_ESCALA=1. */
const escala = process.env.CARTA_TEST_ESCALA === '1';
const soloEscala = { skip: escala ? false : 'medida de tiempo del host: exige CARTA_TEST_ESCALA=1' };

test('assertWorld is a check, not a rule: 2000 people with 64 bonds each keep the digest', () => {
  const world = validationFixture(2000, 64), before = digestoCanonico(world);
  assertWorld(world);
  assert.equal(digestoCanonico(world), before, 'assertWorld is a check, not a rule: the digest must not move');
});

test('assertWorld validates 2000 people with 64 bonds each in under 1s (was O(P^2 * B))', soloEscala, () => {
  const world = validationFixture(2000, 64);
  const start = process.hrtime.bigint();
  assertWorld(world);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1000, `assertWorld(2000 personas, 64 vínculos) tardó ${ms.toFixed(1)} ms`);
});

test('assertWorld cost grows linearly (not quadratically) with population at a fixed bond count', soloEscala, () => {
  // Cuatro puntos que se doblan: de 250 a 2000 un coste lineal multiplica por ≤ 8 y uno cuadrático
  // por ~64. El umbral es su media geométrica. Un ajuste lineal con R² no sirve: un coste
  // puramente cuadrático sobre tres puntos da R² > 0,95.
  const points = [250, 500, 1000, 2000].map(population => ({ population, ms: fastestAssertWorldMs(population) }));
  const ratio = points.at(-1)!.ms / points[0]!.ms;
  assert.ok(ratio < Math.sqrt(8 * 64), `ms(2000)/ms(250) = ${ratio.toFixed(1)} sobre ${JSON.stringify(points)}`);
});

test('an orphan bond still fails assertWorld with the same message', () => {
  const world = validationFixture(200);
  assertWorld(world); // valid baseline first
  world.people[0]!.bonds['absent-person'] = 0.5;
  assert.throws(() => assertWorld(world), /Estado procedural inválido\./);
});

test('a duplicated person id still fails assertWorld', () => {
  const world = validationFixture(200);
  assertWorld(world);
  world.people.at(-1)!.id = world.people[0]!.id;
  assert.throws(() => assertWorld(world), /Estado del mundo inválido/);
});

test('a recipe whose author does not exist still fails assertWorld with the same message', () => {
  const world = createWorld(51926);
  const recipe = paidResearch(world);
  recipe.inventorId = 'no-such-person';
  assert.throws(() => assertWorld(world), /Estado procedural inválido\./);
});
