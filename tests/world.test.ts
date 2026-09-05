import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, createWorld, tileAt, MAX_EVENTS, MAX_EXPERIENCES, projectWorld, stepWorld, TICKS_PER_DAY, type World } from '../src/world/index.js';

function run(world: World, ticks: number): void { for (let n = 0; n < ticks; n++) stepWorld(world); }

function scene(): World {
  const world = createWorld(4821);
  world.memories = [];
  world.events = [];
  world.people.forEach((p, index) => {
    p.x = index < 2 ? 17 + index : 35 + index % 3;
    p.y = index < 2 ? 13 : 2 + Math.floor(index / 3);
    p.target = { x: p.x, y: p.y };
    p.hunger = 0.1; p.energy = 1; p.fatigue = 0.05; p.closeness = 0;
    p.socialLoad = 0; p.inventory = 0.2; p.decisionAt = 0;
    p.curiosity = 0.5; p.sociability = 0.5; p.generosity = 0; p.traits.industriousness = 0;
    p.values = {}; p.materials = { wood: 0, stone: 0 };
    p.command = null; p.controlMode = 'auto';
  });
  return world;
}

test('same seed, inputs, order and persisted PRNG reproduce the full state', () => {
  const a = createWorld(19), b = createWorld(19);
  const inputs = [{ id: 'one', kind: 'plant' as const, x: 17, y: 13 }];
  assert.deepEqual(stepWorld(a, inputs), stepWorld(b, inputs));
  run(a, 1000); run(b, 1000);
  assert.deepEqual(a, b);
  const restored = JSON.parse(JSON.stringify(a)) as World;
  assertWorld(restored);
  run(restored, 600); run(a, 600);
  assert.deepEqual(a, restored);
  assert.notDeepEqual(createWorld(19).tiles, createWorld(20).tiles);
});

test('water and light cause growth; a dry or dark matched cell cannot produce that growth', () => {
  const wet = scene(); wet.tick = 300;
  const tile = tileAt(wet, { x: 20, y: 14 })!;
  tile.moisture = 0.8; tile.food = 0.2; tile.vegetation = 0.4;
  const dry = structuredClone(wet), dark = structuredClone(wet);
  tileAt(dry, { x: 20, y: 14 })!.moisture = 0;
  dark.tick = 1800;
  run(wet, 10); run(dry, 10); run(dark, 10);
  assert.ok(tile.food > tileAt(dry, { x: 20, y: 14 })!.food);
  assert.ok(tile.food > tileAt(dark, { x: 20, y: 14 })!.food);
  assert.ok(tile.vegetation > tileAt(dry, { x: 20, y: 14 })!.vegetation);
});

test('local food removal changes a hungry person route, and eating consumes the local stock', () => {
  const fed = scene();
  for (const tile of fed.tiles) tile.food = 0;
  const s = fed.people[0]!; s.hunger = 0.8; s.inventory = 0;
  tileAt(fed, s)!.food = 0.5;
  const empty = structuredClone(fed);
  tileAt(empty, s)!.food = 0;
  stepWorld(fed); stepWorld(empty);
  assert.equal(s.action, 'eat');
  assert.notEqual(empty.people[0]!.action, 'eat');
  assert.ok(s.hunger < empty.people[0]!.hunger);
  assert.ok(tileAt(fed, s)!.food < 0.5);
  const rerouted = structuredClone(empty);
  rerouted.people[0]!.decisionAt = 0;
  tileAt(rerouted, { x: s.x + 2, y: s.y })!.food = 0.5;
  stepWorld(rerouted);
  assert.equal(rerouted.people[0]!.target.x, s.x + 2);
});

test('fatigue and a locally available refuge change the chosen action and route', () => {
  const rested = scene(), tired = structuredClone(rested);
  tired.people[0]!.fatigue = 0.8;
  stepWorld(rested); stepWorld(tired);
  assert.equal(rested.people[0]!.action, 'explore');
  assert.equal(tired.people[0]!.action, 'rest');
  const exposed = structuredClone(tired);
  for (const tile of exposed.tiles) if (tile.terrain === 'shelter') tile.terrain = 'meadow';
  tired.people[0]!.x = 20; exposed.people[0]!.x = 20;
  tired.people[0]!.decisionAt = 0; exposed.people[0]!.decisionAt = 0;
  stepWorld(tired); stepWorld(exposed);
  assert.notDeepEqual(tired.people[0]!.target, exposed.people[0]!.target);
});

test('a consenting shared pause changes both bodies; distance alone causes no special penalty', () => {
  const near = scene();
  for (const p of near.people.slice(0, 2)) { p.action = 'accompany'; p.decisionAt = 100; p.energy = 0.7; p.fatigue = 0.3; }
  const far = structuredClone(near);
  far.people[1]!.x = 28; far.people[1]!.target.x = 28;
  stepWorld(near); stepWorld(far);
  for (let index = 0; index < 2; index++) {
    assert.ok(near.people[index]!.fatigue < far.people[index]!.fatigue);
    assert.ok(near.people[index]!.energy > far.people[index]!.energy);
    assert.equal(near.people[index]!.hunger, far.people[index]!.hunger);
  }
  assert.equal(far.people[0]!.closeness, 0.0001);
  assert.equal(far.events.some(e => e.kind === 'meeting'), false);
  const space = structuredClone(near);
  space.people[0]!.socialLoad = 0.85; space.people[0]!.decisionAt = 0;
  stepWorld(space);
  assert.equal(space.people[0]!.action, 'retreat');
});

test('relevant synthetic memory causes accompaniment; absent and irrelevant controls agree', () => {
  const base = scene(); base.people[1]!.fatigue = 0.65;
  const relevant = structuredClone(base), irrelevant = structuredClone(base);
  relevant.memories = [createWorld().memories[0]!];
  irrelevant.memories = [createWorld().memories[4]!];
  stepWorld(base); stepWorld(relevant); stepWorld(irrelevant);
  assert.equal(base.people[0]!.action, 'explore');
  assert.equal(irrelevant.people[0]!.action, base.people[0]!.action);
  assert.equal(relevant.people[0]!.action, 'accompany');
  assert.deepEqual(irrelevant.people[0]!.target, base.people[0]!.target);
  assert.match(relevant.people[0]!.reason, /material de prueba/);
  assert.ok(relevant.events.some(e => e.kind === 'memory' && e.source === 'sample'));
  run(base, 1200); run(relevant, 1200); run(irrelevant, 1200);
  assert.equal(base.rng, relevant.rng, 'behavioral treatment must not change the weather PRNG stream');
  assert.equal(base.weather, relevant.weather);
  assert.equal(base.rng, irrelevant.rng);
});

test('one person exploring does not receive contact effects from the other approaching', () => {
  const near = scene();
  near.people[0]!.action = 'accompany'; near.people[1]!.action = 'explore';
  for (const p of near.people.slice(0, 2)) { p.decisionAt = 100; p.energy = 0.7; p.fatigue = 0.3; }
  const separate = structuredClone(near);
  separate.people[1]!.x = 28; separate.people[1]!.target.x = 28;
  stepWorld(near); stepWorld(separate);
  for (let index = 0; index < 2; index++) {
    assert.equal(near.people[index]!.energy, separate.people[index]!.energy);
    assert.equal(near.people[index]!.fatigue, separate.people[index]!.fatigue);
    assert.equal(near.people[index]!.socialLoad, separate.people[index]!.socialLoad);
  }
  assert.equal(near.events.some(e => e.kind === 'meeting'), false);
});

test('S and I have provisional differing preferences without random movement overriding intent', () => {
  const world = scene(); const [s, i] = world.people;
  s!.sociability = 0.8; i!.sociability = 0.3;
  s!.curiosity = 0.2; i!.curiosity = 0.8;
  s!.closeness = 0.55; i!.closeness = 0.55;
  stepWorld(world);
  assert.equal(s!.action, 'approach'); assert.equal(i!.action, 'explore');
  const target = structuredClone(i!.target);
  run(world, 10);
  assert.deepEqual(i!.target, target);
  assert.equal(i!.action, 'explore');
});

function cultureScene(): World {
  const world = scene();
  for (const tile of world.tiles) tile.food = 0;
  const donor = world.people[2]!, observer = world.people[3]!, recipient = world.people[4]!;
  for (const [p, x, y] of [[donor, 25, 8], [observer, 26, 9], [recipient, 25, 9]] as const) {
    p.x = x; p.y = y; p.target = { x, y }; p.fatigue = 0;
  }
  donor.generosity = 0.98; donor.hunger = 0.05; donor.inventory = 0.25;
  observer.generosity = 0; observer.curiosity = 0; observer.hunger = 0.05;
  observer.action = 'rest'; observer.decisionAt = 65; observer.inventory = 0.25;
  recipient.hunger = 0.98; recipient.inventory = 0; recipient.fatigue = 0.95;
  return world;
}

test('observed repeated sharing transmits a custom, with demonstrator and causal source; ablation removes transmission', () => {
  const learning = cultureScene(), control = structuredClone(learning);
  control.learningEnabled = false;
  run(learning, 65); run(control, 65);
  const observer = learning.people[3]!, controlObserver = control.people[3]!;
  assert.ok(learning.events.filter(e => e.kind === 'care' && e.actors[0] === learning.people[2]!.id).length >= 2);
  assert.equal(observer.habits[0]!.demonstrator, learning.people[2]!.id);
  assert.ok(observer.habits[0]!.observations >= 2);
  assert.ok(observer.habits[0]!.repetitions >= 1);
  assert.ok(learning.events.some(e => e.kind === 'learning' && e.actors.includes(observer.id)));
  assert.ok(learning.events.some(e => e.kind === 'care' && e.actors[0] === observer.id && /Imitación/.test(e.cause)));
  assert.equal(controlObserver.habits.length, 0);
  assert.equal(control.events.some(e => e.kind === 'learning'), false);
  assert.equal(control.events.some(e => e.kind === 'care' && e.actors[0] === controlObserver.id), false);
  assert.ok(control.events.some(e => e.kind === 'care'), 'the same sharing action remains available without learning');
});

test('autonomous population learns and repeats useful care across matched seeds; no learning in the ablation', () => {
  for (const seed of [20260905, 51926, 1]) {
    const natural = createWorld(seed), control = structuredClone(natural);
    control.learningEnabled = false;
    const naturalEvents=new Map(), controlEvents=new Map();
    for(let tick=0;tick<1200;tick++){stepWorld(natural);stepWorld(control);for(const event of natural.events)naturalEvents.set(event.id,event);for(const event of control.events)controlEvents.set(event.id,event);}
    assert.ok(natural.people.some(p => p.habits.some(h => h.repetitions > 0)), `seed ${seed} must contain learned repetition`);
    assert.ok(natural.people.filter(p => p.role !== 'neighbor').some(p => p.habits.some(h => h.observations >= 2)), `seed ${seed} society must affect the couple`);
    assert.ok([...naturalEvents.values()].some(e => e.kind === 'learning'));
    assert.ok([...naturalEvents.values()].some(e => e.kind === 'care' && /Imitación/.test(e.cause)));
    assert.ok([...controlEvents.values()].some(e => e.kind === 'care'), 'control retains spontaneous sharing');
    assert.ok(control.people.every(p => p.habits.length === 0));
    assert.equal([...controlEvents.values()].some(e => e.kind === 'learning'), false);
    assert.equal(natural.weather, control.weather, 'ecological random draws remain paired');
    assert.equal(natural.rng, control.rng);
  }
});

test('two actual observations retain provenance after their chronicle events are pruned', () => {
  const world = cultureScene(); run(world, 65);
  const habit = world.people[3]!.habits[0]!;
  const evidence = structuredClone(habit.evidence);
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every(e => e.food === 0.025 && e.recipient === world.people[4]!.id));
  for (let index = 0; index < MAX_EVENTS + 1; index++) {
    run(world, 30);
    const actor = world.people[2]!;
    assert.equal(stepWorld(world, [{ id: `prune-${index}`, kind: 'invite', x: actor.x, y: actor.y }])[0]!.accepted, true);
  }
  assert.equal(world.events.some(e => e.id === evidence[0]!.eventId), false);
  assert.deepEqual(habit.evidence, evidence);
  assertWorld(world);
});

test('hungry bodies cannot recover activity energy without food by resting indefinitely', () => {
  const world = scene();
  for (const tile of world.tiles) tile.food = 0;
  const s = world.people[0]!;
  s.hunger = 1; s.inventory = 0; s.energy = 0.2; s.fatigue = 0.9;
  const before = s.energy;
  run(world, 100);
  assert.equal(s.action, 'rest');
  assert.ok(s.energy < before);
  assert.equal(s.hunger, 1);
});

test('gestures validate land, context and cooldown; invitations never teleport and hunger can ignore them', () => {
  const world = scene();
  const water = tileAt(world, { x: 16, y: 12 })!; water.terrain = 'water';
  const invalid = stepWorld(world, [{ id: 'outside', kind: 'plant', x: -10_000_001, y: 3 }, { id: 'water', kind: 'plant', x: water.x, y: water.y }]);
  assert.deepEqual(invalid.map(r => r.accepted), [false, false]);
  const before = tileAt(world, { x: 17, y: 13 })!.vegetation;
  const planted = stepWorld(world, [{ id: 'plant', kind: 'plant', x: 17, y: 13 }, { id: 'fast', kind: 'invite', x: 17, y: 13 }]);
  assert.equal(planted[0]!.accepted, true); assert.equal(planted[1]!.accepted, false);
  assert.equal(tileAt(world, { x: 17, y: 13 })!.vegetation, Math.min(1, before + 0.12));
  run(world, 30);
  const s = world.people[0]!; s.hunger = 0.9; s.decisionAt = 0;
  const position = { x: s.x, y: s.y };
  const invitation = stepWorld(world, [{ id: 'invite', kind: 'invite', x: 21, y: 14 }]);
  assert.equal(invitation[0]!.accepted, true);
  assert.equal(s.action, 'eat');
  assert.ok(Math.abs(s.x - position.x) + Math.abs(s.y - position.y) <= 1);
  assert.equal(stepWorld(world, [{ id: 'wrong-memory', kind: 'remember', x: 17, y: 13, memoryId: 'missing' }])[0]!.accepted, false);
});

test('six day/night cycles retain bounded bodies, terrain, history and valid land positions', () => {
  const world = createWorld(23);
  run(world, TICKS_PER_DAY * 6);
  assertWorld(world);
  assert.ok(world.events.length <= MAX_EVENTS);
  assert.ok(world.people.every(p => p.experiences.length <= MAX_EXPERIENCES && p.habits.length <= 3));
  assert.ok(world.people.every(p => tileAt(world, p)!.terrain !== 'water'));
  const view = projectWorld(world);
  assert.equal(view.sequence, world.tick);
  assert.equal('rng' in view, false);
  assert.equal('inventory' in view.people[0]!, false);
  assert.ok(view.memories.every(m => m.source === 'sample'));
});

test('state validation rejects corruption and incompatible versions instead of resetting', () => {
  const original = createWorld(); assertWorld(original);
  for (const mutate of [
    (w: World) => { w.version = 99; },
    (w: World) => { w.people[0]!.energy = Number.NaN; },
    (w: World) => { w.tiles.pop(); },
    (w: World) => { w.people[0]!.habits.push({ placeId: 'claro', observations: -1, strength: 1, demonstrator: 'bad', sourceEvent: 'bad', repetitions: 0, evidence: [] }); },
  ]) { const changed = structuredClone(original); mutate(changed); assert.throws(() => assertWorld(changed), /inválido/); }
  assert.throws(() => assertWorld(null), /inválido/);
});
