import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneWorld, createWorld, stepWorld, tileAt, type Person } from '../src/world/index.js';
import { initialDemography } from '../src/world/demography.js';
import { earlierForagerExhausts, familyOpportunity, observedForagersByCell } from '../src/world/family.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { Store } from '../src/server/store.js';
import { HISTORICAL_PARAMS, parseParams } from '../src/world/params.js';

// Reglas 10, etapa 1 (2026-09-22): fixture medida con las leyes de antes; parte de `HISTORICAL_PARAMS`
// explícitos (los defaults nuevos adoptan cortejo, comunidad opcional, muestreo continuo y habituación).
/** Finite fixture, not a demographic outcome: the observed work is actually paid
 * during preparation. Only the deciding actor is released afterwards. */
function scene(options: { food?: number; ownWork?: number; otherWork?: number; inventory?: number } = {}) {
  const world = createWorld(51926, HISTORICAL_PARAMS); world.tick = 1000; world.weather = 'clear'; world.animals = [];
  for (const tile of world.tiles) { tile.food = tile.vegetation = tile.moisture = tile.fertility = tile.fauna = 0; }
  for (const person of world.people) {
    person.hunger = person.thirst = person.fatigue = .1; person.energy = .9; person.inventory = 0;
    person.action = 'rest'; person.target = { x: person.x, y: person.y }; person.decisionAt = 100000;
    person.communityId = null; person.bonds = {}; person.demography = initialDemography(world.tick - person.bornAt);
  }
  const [a, b, worker] = world.people.filter(p => p.role === 'neighbor') as [Person, Person, Person, ...Person[]];
  a.x = worker.x = 17; a.y = worker.y = 13; b.x = 19; b.y = 13;
  a.inventory = .095; b.inventory = .12; worker.inventory = options.inventory ?? 0;
  a.bonds[b.id] = b.bonds[a.id] = .5; a.communityId = b.communityId = 'fixture-family';
  for (const p of [a, b, worker]) p.target = { x: p.x, y: p.y };
  world.communities = [{ id: 'fixture-family', name: 'Fixture', x: 17, y: 13, members: [a.id, b.id],
    color: '#fff', culture: { ...a.culture }, formedAt: 0, cooperation: 0, disputes: 0 }];
  for (let x = 17; x <= 26; x++) tileAt(world, { x, y: 13 })!.terrain = 'soil';
  const source = tileAt(world, a)!, alternative = tileAt(world, { x: 18, y: 13 })!;
  source.terrain = 'shelter'; source.food = options.food ?? .012; alternative.food = .012;
  const ownWork = options.ownWork ?? 0, otherWork = options.otherWork ?? 16;
  for (let tick = 0; tick < 16; tick++) {
    if (tick === 16 - ownWork) a.action = 'forage';
    if (tick === 16 - otherWork) worker.action = 'forage';
    stepWorld(world);
  }
  assert.equal(a.work, ownWork); assert.equal(worker.work, otherWork);
  assert.ok(familyOpportunity(world, a)); a.decisionAt = world.tick;
  return { world, a, b, worker, source, alternative };
}

test('an autonomous family reserve avoids an advanced visible worker and pays for its alternative', () => {
  const { world, a, worker, source, alternative } = scene(), before = structuredClone(a);
  const idle = cloneWorld(world), idleActor = idle.people.find(p => p.id === a.id)!;
  idleActor.decisionAt = 100000;
  stepWorld(world); stepWorld(idle);
  assert.equal(a.action, 'forage'); assert.deepEqual(a.target, { x: alternative.x, y: alternative.y });
  assert.equal(worker.work, 17); assert.equal(a.command, null); assert.equal(a.controlMode, 'auto');
  for (let n = 0; n < 20; n++) { stepWorld(world); stepWorld(idle); }
  const gain = a.inventory - before.inventory;
  assert.ok(gain > .011 && gain < .012);
  assert.ok(Math.abs(gain - (tileAt(idle, alternative)!.food - alternative.food)) < 1e-12);
  assert.equal(source.food, 0); assert.equal(alternative.food, 0);
  assert.ok(a.energy < before.energy); assert.ok(a.fatigue > before.fatigue); assert.ok(a.hunger > before.hunger);
  assert.equal(world.totals.births, 0);
});

test('local observation does not predict remote work, a future task, expired intent or sufficient residual stock', () => {
  const controls: [string, (s: ReturnType<typeof scene>) => void, Parameters<typeof scene>[0]?][] = [
    ['outside perception', ({ worker }) => { worker.x = 26; }],
    ['not yet at the source', ({ worker }) => { worker.x = 18; }],
    ['different task', ({ worker }) => { worker.action = 'rest'; worker.work = 0; }],
    ['different target', ({ worker }) => { worker.target = { x: 18, y: 13 }; }],
    ['scheduled reconsideration before completion', ({ worker, world }) => { worker.decisionAt = world.tick + 1; }],
    ['urgent thirst before completion', ({ worker }) => { worker.thirst = .8999; }],
    ['source survives one whole harvest', () => {}, { food: .08 }],
    ['worker lacks space to exhaust the source', () => {}, { inventory: .245 }],
  ];
  for (const [label, change, options] of controls) {
    const s = scene(options); change(s); stepWorld(s.world);
    assert.equal(s.a.action, 'forage', label);
    assert.deepEqual(s.a.target, { x: s.source.x, y: s.source.y }, label);
  }
});

test('paid work is retained when ahead or tied, but cannot substitute a conclusively lost old site', () => {
  for (const otherWork of [8, 16]) {
    const { world, a, source } = scene({ ownWork: 16, otherWork });
    stepWorld(world);
    assert.deepEqual(a.target, { x: source.x, y: source.y }); assert.equal(a.work, 17);
    stepWorld(world); assert.ok(a.inventory > .106); assert.equal(a.work, 0);
  }
  const { world, a, alternative } = scene({ ownWork: 8, otherWork: 16 });
  stepWorld(world);
  assert.deepEqual(a.target, { x: alternative.x, y: alternative.y });
  assert.equal(a.work, 0, 'paid work from the abandoned site does not move to the alternative');
});

test('the forecast is pure and leaves equal or one-tick-ambiguous completion unclaimed', () => {
  const { world, a, worker, source } = scene(), before = digestoCanonico(world);
  const physical = { tick: world.tick, radius: 7, duration: () => 18, capacity: () => .06, continues: () => true };
  assert.equal(earlierForagerExhausts(a, source, [worker], 18, physical), true);
  assert.equal(earlierForagerExhausts(a, source, [worker], 2, physical), false, 'equal remaining work');
  assert.equal(earlierForagerExhausts(a, source, [worker], 3, physical), false, 'one tick could be an update-phase tie');
  assert.equal(earlierForagerExhausts(a, source, [worker], 4, physical), true, 'strict lead even at either update phase');
  assert.equal(digestoCanonico(world), before);
  a.action = 'forage'; a.work = worker.work;
  assert.equal(earlierForagerExhausts(a, source, [worker], 2, physical), false);
  assert.equal(earlierForagerExhausts(worker, source, [a], 2, physical), false, 'equal workers cannot mutually veto their source');
});

test('a private cell index preserves local forecast results, group order and world state', () => {
  const { world, a, worker } = scene(), before = digestoCanonico(world);
  const observers = world.people.filter(p => p !== a), groups = observedForagersByCell(observers);
  assert.deepEqual(groups.get(`${worker.x},${worker.y}`), observers.filter(p => p.action === 'forage' && p.x === worker.x && p.y === worker.y));
  const physical = { tick: world.tick, radius: 7, duration: () => 18, capacity: () => .06, continues: () => true };
  for (const source of world.tiles) assert.equal(
    earlierForagerExhausts(a, source, groups.get(`${source.x},${source.y}`) ?? [], 18, physical),
    earlierForagerExhausts(a, source, observers, 18, physical));
  assert.equal(digestoCanonico(world), before);
});

test('an explicit human order keeps the contended destination and still pays actual work', () => {
  const { world, a, source } = scene(), energy = a.energy;
  const result = stepWorld(world, [{ id: 'human-contended-harvest', kind: 'command', agentId: a.id,
    order: 'forage', x: source.x, y: source.y }]);
  assert.equal(result[0]!.accepted, true); assert.equal(a.controlMode, 'directed');
  assert.deepEqual(a.target, { x: source.x, y: source.y }); assert.equal(a.work, 1);
  assert.equal(a.inventory, .095); assert.ok(a.energy < energy);
});

test('urgent eating still consumes a local source even with an advanced visible forager', () => {
  const { world, a, source } = scene({ food: .04 }); a.hunger = .91;
  const hunger = a.hunger, stock = source.food;
  stepWorld(world);
  assert.equal(a.action, 'eat'); assert.deepEqual(a.target, { x: source.x, y: source.y });
  assert.ok(a.hunger < hunger); assert.ok(source.food < stock);
});

test('without finite food, no predicted family work manufactures a reserve', () => {
  const { world, a } = scene(); for (const tile of world.tiles) tile.food = 0;
  const inventory = a.inventory;
  for (let i = 0; i < 24; i++) stepWorld(world);
  assert.equal(a.inventory, inventory); assert.equal(world.totals.foodHarvested, 0);
});

test('seed 1007 prefix 131: autonomy collects the paid alternative without commands or resource injection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-family-contention-'));
  const store = new Store(join(directory, 'world.sqlite'));
  try {
    const world = createWorld(1007, parseParams('persistencia.cadaTicks=20', HISTORICAL_PARAMS)); store.save(world);
    for (let i = 0; i < 131; i++) { stepWorld(world); if (world.tick % 20 === 0) store.save(world); }
    const a = world.people.find(p => p.id === 'neighbor-4')!, worker = world.people.find(p => p.id === 'neighbor-2')!;
    assert.equal(a.inventory, .060948499999999926); assert.equal(worker.work, 7);
    assert.equal(familyOpportunity(world, a)?.partner.id, worker.id);
    const alternate = tileAt(world, { x: 17, y: 12 })!, stock = alternate.food, initial = structuredClone(a);
    const noFood = cloneWorld(world);
    for (const tile of noFood.tiles) { tile.food = tile.vegetation = tile.fertility = tile.moisture = 0; }
    const beforeHarvest = world.totals.foodHarvested;
    let physicallyDebited = 0;
    const advance = () => {
      const inventory = a.inventory, soil = alternate.food;
      stepWorld(world);
      if (a.inventory > inventory) {
        assert.ok(Math.abs(a.inventory - inventory - (soil - alternate.food)) < 1e-12,
          'each positive inventory change is the simultaneous debit of its actual tile');
        physicallyDebited += soil - alternate.food;
      }
    };
    advance(); assert.deepEqual(a.target, { x: 17, y: 12 });
    for (let i = 133; i <= 150; i++) advance();
    for (let i = 132; i <= 150; i++) stepWorld(noFood);
    const gain = a.inventory - initial.inventory;
    assert.ok(gain > .007 && gain < stock); assert.equal(alternate.food, 0);
    assert.ok(Math.abs(gain - physicallyDebited) < 1e-12);
    assert.ok(world.totals.foodHarvested - beforeHarvest >= gain);
    assert.ok(a.energy < initial.energy); assert.ok(a.fatigue > initial.fatigue);
    assert.equal(a.command, null); assert.equal(a.controlMode, 'auto');
    assert.equal(noFood.people.find(p => p.id === a.id)!.inventory, initial.inventory);
    assert.equal(world.totals.births, 0, 'a birth is not the acceptance criterion for this planning change');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
