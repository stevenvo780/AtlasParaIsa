import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, stepWorld, tileAt, type Person } from '../src/world/index.js';
import { familyOpportunity, reproductiveReadiness } from '../src/world/family.js';
import { escenaFamiliaSeca } from './lib/escenas.js';

// Reglas 10, etapa 1 (2026-09-22): fixture medida con las leyes de antes; parte de `HISTORICAL_PARAMS`
// explícitos (los defaults nuevos adoptan cortejo, comunidad opcional, muestreo continuo y habituación).
/** Finite dry fixture, not a naturally reached population or survival claim. */
function scene(seed: number, steps = 0) {
  const world = escenaFamiliaSeca(seed);
  const [a, b] = world.people.filter(p => p.role === 'neighbor') as [Person, Person, ...Person[]];
  a.x = 17; a.y = 13; b.x = 18; b.y = 13; a.inventory = .095; b.inventory = .12;
  a.bonds[b.id] = b.bonds[a.id] = .5; a.communityId = b.communityId = 'fixture-family';
  a.decisionAt = world.tick; a.target = { x: a.x, y: a.y }; b.target = { x: b.x, y: b.y };
  world.communities = [{ id: 'fixture-family', name: 'Fixture', x: 17, y: 13, members: [a.id, b.id],
    color: '#fff', culture: { ...a.culture }, formedAt: 0, cooperation: 0, disputes: 0 }];
  for (let x = 17; x <= 24; x++) tileAt(world, { x, y: 13 })!.terrain = 'soil';
  tileAt(world, a)!.terrain = 'shelter';
  const target = { x: a.x + steps, y: a.y }; tileAt(world, target)!.food = .012;
  return { world, a, b, target };
}

for (const seed of [51926, 51927]) {
  for (const steps of [0, 2]) test(`seed ${seed}: autonomous family provisioning pays a small harvest at ${steps} steps`, () => {
    const { world, a, target } = scene(seed, steps), initial = structuredClone(a);
    const idle = cloneWorld(world), idleActor = idle.people.find(p => p.id === a.id)!;
    idleActor.action = 'rest'; idleActor.decisionAt = 100000;
    const beforeQuery = structuredClone(world);
    assert.ok(familyOpportunity(world, a)); assert.deepEqual(world, beforeQuery);
    const length = steps ? 25 : 18;
    for (let tick = 0; tick < length; tick++) { stepWorld(world); stepWorld(idle); }
    assert.equal(a.action, 'forage'); assert.equal(a.command, null); assert.equal(a.controlMode, 'auto');
    const harvested = a.inventory - initial.inventory;
    assert.ok(harvested > .011 && harvested <= .012);
    assert.ok(Math.abs(harvested - (tileAt(idle, target)!.food - tileAt(world, target)!.food)) < 1e-12,
      'every stored unit came from the finite tile, accounting for the same decay');
    assert.equal(tileAt(world, target)!.food, 0);
    assert.ok(a.energy < initial.energy, 'storing food must not assimilate forecast energy');
    assert.ok(a.fatigue > initial.fatigue); assert.ok(a.hunger > initial.hunger);
    assert.equal(reproductiveReadiness(world, a), true); assert.ok(familyOpportunity(world, a));
    assert.equal(world.totals.births, 0);
  });

  test(`seed ${seed}: no food, absent partner, lost locality and unprofitable route reject the motive`, () => {
    const cases: [string, (value: ReturnType<typeof scene>) => void, number][] = [
      ['no food', ({ world, target }) => { tileAt(world, target)!.food = 0; }, 0],
      ['stock decays below physical continuation', ({ world, a, target }) => { a.skills.forage = 1; tileAt(world, target)!.food = .005; }, 0],
      ['no mutual trust', ({ a, b }) => { a.bonds = {}; b.bonds = {}; }, 0],
      ['partner beyond perception', ({ b }) => { b.x = 25; b.target = { x: b.x, y: b.y }; }, 0],
      ['no shared place', ({ world }) => { world.places = []; }, 0],
      ['long low-yield route', () => {}, 7],
      ['work would lose readiness', ({ a }) => { a.energy = .6005; }, 0],
    ];
    for (const [label, change, steps] of cases) {
      const value = scene(seed, steps); change(value);
      const inventory = value.a.inventory;
      stepWorld(value.world);
      assert.notEqual(value.a.action, 'forage', label); assert.equal(value.a.inventory, inventory, label);
      assert.equal(value.world.totals.births, 0, label);
    }
  });

  test(`seed ${seed}: full current energy does not erase future reserve usefulness`, () => {
    const { world, a } = scene(seed); a.energy = 1;
    stepWorld(world); assert.equal(a.action, 'forage'); assert.ok(a.energy < 1); assert.equal(a.inventory, .095);
  });
}

test('partial forage work cannot replace a newly validated family target with an unprofitable old target', () => {
  const { world, a, b, target } = scene(51926, 1);
  b.x = 24; b.target = { x: b.x, y: b.y }; // The trusted partner moved, but remains perceived.
  const old = tileAt(world, a)!; old.food = .0051;
  a.action = 'forage'; a.work = 1; a.target = { x: a.x, y: a.y };
  assert.ok(familyOpportunity(world, a));
  stepWorld(world);
  assert.equal(a.action, 'forage'); assert.deepEqual(a.target, target);
  assert.equal(a.work, 0, 'moving to a different harvest discards old paid work, without claiming it at the new site');
  assert.equal(a.inventory, .095); assert.equal(old.food, .0051);
});

test('a still viable old harvest preserves paid work and completes with only its remaining duration', () => {
  const { world, a, b, target } = scene(51926, 1);
  b.x = 24; b.target = { x: b.x, y: b.y };
  const old = { x: a.x, y: a.y }; tileAt(world, old)!.food = .012;
  a.action = 'forage'; a.work = 8; a.target = { ...old };
  stepWorld(world); assert.deepEqual(a.target, old); assert.equal(a.work, 9);
  for (let tick = 1; tick < 10; tick++) stepWorld(world);
  assert.equal(a.work, 0); assert.ok(a.inventory > .106);
  assert.equal(tileAt(world, old)!.food, 0); assert.ok(tileAt(world, target)!.food > 0);
});

test('an explicit forage order still starts a new paid task at its requested target', () => {
  const { world, a } = scene(51926);
  a.action = 'forage'; a.work = 8; a.target = { x: a.x, y: a.y };
  const target = { x: a.x + 2, y: a.y }; tileAt(world, target)!.food = .012;
  const result = stepWorld(world, [{ id: 'explicit-new-forage', kind: 'command', agentId: a.id, order: 'forage', ...target }]);
  assert.equal(result[0]!.accepted, true); assert.deepEqual(a.target, target);
  assert.equal(a.action, 'forage'); assert.equal(a.work, 0); assert.equal(a.controlMode, 'directed');
});
