import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld, tileAt, type Person, type World } from '../src/world/index.js';
import { localRandom } from '../src/world/genetics.js';
import { HISTORICAL_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { readSnapshotParams } from '../src/server/snapshot.js';

const keys = ['sharing', 'stewardship', 'openness'] as const;
const params = (variacion: number, adaptacion: number) =>
  parseParams(`cultura.variacion=${variacion},cultura.adaptacion=${adaptacion}`, HISTORICAL_PARAMS);

/** A real birth, with one eligible pair and the other founders outside mating range. */
function birth(variacion: number, edge?: 0 | 1): { world: World; a: Person; b: Person; child: Person } {
  const world = createWorld(51926, params(variacion, 0));
  world.tick = 599;
  for (const person of world.people) {
    person.x = 10; person.y = 20; person.target = { x: 10, y: 20 };
    person.action = 'rest'; person.decisionAt = 999;
    person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9;
    person.demography.age = world.tick - person.bornAt;
    person.bonds = {};
  }
  const a = world.people[2]!, b = world.people[3]!;
  for (const person of [a, b]) {
    person.x = 17; person.y = 13; person.target = { x: 17, y: 13 };
    person.inventory = 0.2;
    person.communityId = 'community-1';
    if (edge !== undefined) person.culture = { sharing: edge, stewardship: edge, openness: edge };
  }
  world.communityCounter = 1;
  world.communities = [{ id: 'community-1', name: 'Comunidad de prueba', x: 17, y: 13,
    color: '#aaccee', members: [a.id, b.id], culture: { ...a.culture }, formedAt: world.tick,
    cooperation: 0, disputes: 0 }];
  a.bonds[b.id] = b.bonds[a.id] = 0.7;
  const before = world.birthCounter;
  stepWorld(world);
  assert.equal(world.birthCounter, before + 1, 'la escena debe producir exactamente una cría');
  return { world, a, b, child: world.people.at(-1)! };
}

test('ε produces deterministic, bounded copy variation rather than the exact parental mean', () => {
  const first = birth(0.2), second = birth(0.2);
  assert.deepEqual(first.child.culture, second.child.culture, 'same seed and child identity');
  let differs = 0;
  for (const key of keys) {
    const mean = (first.a.culture[key] + first.b.culture[key]) / 2;
    const u = localRandom(first.world.seed, `${first.child.id}:${key}`)();
    const expected = Math.max(0, Math.min(1, mean + 0.2 * (2 * u - 1)));
    assert.equal(first.child.culture[key], expected, `${key} uses its own deterministic draw`);
    if (first.child.culture[key] !== mean) differs++;
  }
  assert.ok(differs > 0);
  let lowerClamps = 0, upperClamps = 0;
  for (const edge of [0, 1] as const) {
    const { world, child } = birth(0.2, edge);
    for (const key of keys) {
      const u = localRandom(world.seed, `${child.id}:${key}`)();
      const raw = edge + 0.2 * (2 * u - 1);
      assert.equal(child.culture[key], Math.max(0, Math.min(1, raw)), `${key} is clamped at ${edge}`);
      if (raw < 0) lowerClamps++;
      if (raw > 1) upperClamps++;
    }
  }
  assert.ok(lowerClamps > 0 && upperClamps > 0, 'fixture exercises both clamp boundaries');
});

test('α lowers stewardship after useful collection, with physical material harvested', () => {
  const world = createWorld(51926, params(0, 0.5));
  const actor = world.people[2]!;
  actor.action = 'gather'; actor.target = { x: actor.x, y: actor.y };
  actor.decisionAt = 999; actor.work = 17; actor.materials = { wood: 0, stone: 0 };
  actor.culture.stewardship = 0.5;
  const tile = tileAt(world, actor)!; tile.wood = 3;
  const before = { stock: tile.wood, material: actor.materials.wood, culture: actor.culture.stewardship };
  stepWorld(world);
  assert.ok(actor.materials.wood > before.material && tile.wood! < before.stock, 'collection actually succeeded');
  assert.ok(actor.culture.stewardship < before.culture);
});

test('α lowers sharing after an unhelpful cooperation attempt, without inventing a transfer', () => {
  const world = createWorld(51926, params(0, 0.5));
  const actor = world.people[2]!;
  actor.x = 36; actor.y = 12; actor.target = { x: 36, y: 12 };
  actor.action = 'cooperate'; actor.decisionAt = 999; actor.work = 17;
  actor.culture.sharing = 0.5;
  for (const other of world.people) if (other !== actor) {
    other.x = 10; other.y = 20; other.target = { x: 10, y: 20 };
    other.action = 'rest'; other.decisionAt = 999;
  }
  const before = { sharing: actor.culture.sharing, cooperation: world.totals.cooperation };
  stepWorld(world);
  assert.equal(world.totals.cooperation, before.cooperation, 'no useful cooperation took place');
  assert.ok(actor.culture.sharing < before.sharing);
});

test('ε=α=0 retains exact mean inheritance and existing one-sided norm learning', () => {
  const { a, b, child } = birth(0);
  for (const key of keys) assert.equal(child.culture[key], (a.culture[key] + b.culture[key]) / 2);
  const world = createWorld(51926, params(0, 0));
  const actor = world.people[2]!;
  actor.action = 'gather'; actor.target = { x: actor.x, y: actor.y };
  actor.decisionAt = 999; actor.work = 17; actor.materials = { wood: 0, stone: 0 };
  const tile = tileAt(world, actor)!; tile.wood = 3;
  const before = actor.culture.stewardship;
  stepWorld(world);
  assert.ok(actor.materials.wood > 0);
  assert.equal(actor.culture.stewardship, before, 'useful gathering had no norm effect before CULT-VAR');

  const idle = createWorld(51926, params(0, 0));
  const helper = idle.people[2]!;
  helper.x = 36; helper.y = 12; helper.target = { x: 36, y: 12 };
  helper.action = 'cooperate'; helper.decisionAt = 999; helper.work = 17;
  for (const other of idle.people) if (other !== helper) {
    other.x = 10; other.y = 20; other.target = { x: 10, y: 20 };
    other.action = 'rest'; other.decisionAt = 999;
  }
  const sharing = helper.culture.sharing;
  stepWorld(idle);
  assert.equal(helper.culture.sharing, sharing, 'failed cooperation had no norm effect before CULT-VAR');
});

test('legacy snapshot without CULT-VAR keys receives inert historical values', () => {
  const legacy = structuredClone(HISTORICAL_PARAMS) as unknown as Record<string, unknown>;
  delete legacy.cultura;
  const restored = readSnapshotParams({ version: 11, paramsEncoding: 'params-v1', params: legacy,
    limitsProfile: { version: 2, ...HISTORICAL_PARAMS.limites } });
  assert.equal(restored.cultura.variacion, 0);
  assert.equal(restored.cultura.adaptacion, 0);
  const world = createWorld(51926);
  setParams(world, restored);
  assert.deepEqual(paramsOf(world).cultura, restored.cultura);
  const copy = cloneWorld(world);
  assert.deepEqual(paramsOf(copy).cultura, restored.cultura);
});
