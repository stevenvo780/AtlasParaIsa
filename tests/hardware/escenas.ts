import assert from 'node:assert/strict';
import type { Tile } from '../../src/shared/types.js';
import { assertWorld, createWorld, type Person, type World } from '../../src/world/index.js';
import { demographicTraits, initialDemography } from '../../src/world/demography.js';
import { activate, bindWorldContext, tileAt } from '../../src/world/spatial.js';
import { ResidentTopologyOwner } from '../../src/world/soa/topologia.js';
import { settlementOpportunity } from '../../src/world/society.js';
import { chunkKey } from '../../src/world/terrain.js';

export const HARDWARE_SEEDS = [7, 51926, 104729, 20260919] as const;
export const HARDWARE_SCENES = ['compacta', 'frontera', 'competencia', 'nacimiento-muerte',
  'dispersas', 'alcance-compuesto', 'cosecha-dos-regiones'] as const;
export type HardwareSceneName = typeof HARDWARE_SCENES[number];
export interface SceneFixture {
  world: World;
  /** A real transition must establish the scene's predicate, not merely its label. */
  afterStep: (step: number) => void;
  assertWitness: () => void;
}

const point = (x: number, y: number) => ({ x, y });
function placePerson(world: World, person: Person, x: number, y: number): void {
  Object.assign(person, { x, y, target: point(x, y), hunger: 0.2, thirst: 0.2, fatigue: 0.1,
    energy: 0.9, inventory: 0.1, action: 'rest', decisionAt: world.tick + 30,
    command: null, controlMode: 'auto', bonds: {}, communityId: null, work: 0 });
  person.demography.age = world.tick - person.bornAt;
}

/** Private valid initial snapshots. No law, continuity role, letter, RNG implementation or
 * dynamics flag changes. Unneeded mortal founders are omitted from this synthetic population;
 * S/I and the five authored example memories retain their identities and contents. */
function initialScene(seed: number, positions: readonly { x: number; y: number }[], tick = 0): World {
  const world = createWorld(seed);
  world.tick = tick;
  world.people = world.people.slice(0, positions.length);
  // Both serial and parallel fixtures are owned from construction. No exposed Tile identity
  // is replaced by a Proxy later; activate() creates owned Tiles before returning them.
  const tileOwnership = new ResidentTopologyOwner();
  world.tiles = tileOwnership.tiles([]);
  bindWorldContext(world, { tileOwnership });
  world.chunks = {}; world.retiredChunks = [];
  world.animals = []; world.structures = [];
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i]!;
    placePerson(world, world.people[i]!, position.x, position.y);
    // Exactly the real residency reach used by maintainRegions, before the first step.
    for (const dy of [-8, 0, 8]) for (const dx of [-8, 0, 8]) activate(world, position.x + dx, position.y + dy);
  }
  // Initial flora-only patches are valid conditions, not a switch disabling fauna dynamics.
  world.animals = []; world.structures = [];
  for (const tile of world.tiles) Object.assign(tile, { terrain: 'meadow', biome: 'grassland',
    moisture: 0.6, vegetation: 0.4, food: 0.2, wood: 0, stone: 0, feature: 'none',
    growth: 0.4, fertility: 0.5, cultivation: 0, traffic: 0, drinkingWater: 0,
    fauna: 0, life: 0.1 });
  for (const tile of world.tiles) delete tile.species;
  // Generated places in the same patch are retained, as are the three memory anchors.
  for (const anchor of world.places.filter(p => ['claro', 'refugio', 'huerta'].includes(p.id))) {
    const meta = world.chunks[chunkKey(anchor.x, anchor.y)];
    if (meta && !meta.places.some(p => p.id === anchor.id)) meta.places.push(anchor);
  }
  return world;
}

function fixture(world: World, witness: (step: number) => boolean): SceneFixture {
  let witnessed = false;
  assertWorld(world);
  return { world, afterStep(step) { if (!witnessed) witnessed = witness(step); },
    assertWitness() { assert.ok(witnessed, 'The scene must exercise its actual transition.'); } };
}

function eatUntilDecision(person: Person, world: World): void {
  person.action = 'eat'; person.hunger = 0.6; person.inventory = 0.1;
  person.target = point(person.x, person.y); person.decisionAt = world.tick + 30;
}

export const HARVEST_INITIAL_TOTAL = 2 ** 39;
export const HARVEST_AMOUNT = 0.0035;
/** Physical/program order is left, right, left, right, deliberately interleaved. */
export const HARVEST_POSITIONS = [point(9, 9), point(1033, 9), point(9, 11), point(1033, 11)] as const;
export function sequentialHarvestTotal(): number {
  let result = HARVEST_INITIAL_TOTAL;
  for (const _ of HARVEST_POSITIONS) result += HARVEST_AMOUNT;
  return result;
}
export function regionGroupedHarvestTotal(regionSide: 256 | 512): number {
  const subtotals = new Map<string, number>();
  for (const p of HARVEST_POSITIONS) {
    const region = `${Math.floor(p.x / regionSide)},${Math.floor(p.y / regionSide)}`;
    subtotals.set(region, (subtotals.get(region) ?? 0) + HARVEST_AMOUNT);
  }
  let result = HARVEST_INITIAL_TOTAL;
  for (const partial of subtotals.values()) result += partial;
  return result;
}

export function buildHardwareScene(seed: number, name: HardwareSceneName): SceneFixture {
  if (name === 'compacta') {
    const world = initialScene(seed, [point(9, 9), point(10, 9), point(9, 10)]);
    const tile = tileAt(world, point(9, 9))!, before = tile.moisture;
    assert.equal(new Set(world.tiles.map(t => `${Math.floor(t.x / 256)},${Math.floor(t.y / 256)}`)).size, 1);
    return fixture(world, step => step < 10 ? false : (assert.notEqual(tile.moisture, before), true));
  }
  if (name === 'frontera') {
    // Exercise both 256 and 512 boundaries in the same, unlabelled fixture.
    const positions = [point(255, 8), point(256, 8), point(511, 8), point(512, 8)];
    const world = initialScene(seed, positions);
    const wet = tileAt(world, point(255, 9))!, dry = tileAt(world, point(254, 9))!;
    Object.assign(tileAt(world, point(256, 9))!, { terrain: 'water', drinkingWater: 0.5 });
    let boundaryBodies = false;
    return fixture(world, step => {
      if (step === 1) {
        assert.deepEqual(world.people.map(p => point(p.x, p.y)), positions);
        for (const side of [256, 512]) assert.ok(positions.some(p => p.x % side === 0));
        boundaryBodies = true;
      }
      if (step < 10) return false;
      assert.ok(boundaryBodies); assert.ok(wet.moisture > dry.moisture, 'Real cross-boundary water affects ecology.');
      return true;
    });
  }
  if (name === 'competencia') {
    const world = initialScene(seed, [point(9, 13), point(10, 13), point(9, 9), point(9, 9)]);
    const actors = world.people.slice(2), source = tileAt(world, actors[0]!)!;
    source.food = 0.006;
    for (const actor of actors) eatUntilDecision(actor, world);
    return fixture(world, step => {
      if (step !== 1) return false;
      assert.equal(source.food, 0, 'Both real bodies consume one finite shared tile in program order.');
      assert.ok(Object.is(actors[0]!.inventory, 0.1 + 0.0035 * 0.25));
      assert.ok(Object.is(actors[1]!.inventory, 0.1 + (0.006 - 0.0035) * 0.25));
      assert.notEqual(actors[0]!.inventory, actors[1]!.inventory);
      return true;
    });
  }
  if (name === 'nacimiento-muerte') {
    // 3600 is a literal default reproduction boundary and admits every founder's cooldown.
    const world = initialScene(seed, [point(9, 13), point(10, 13), point(9, 9), point(10, 9), point(12, 9)], 3599);
    const [a, b, dying] = world.people.slice(2) as [Person, Person, Person];
    const site = { id: 'hardware-birth-place', name: 'Synthetic birth site', description: 'Private fixture.',
      x: 9, y: 9, gatherings: 0 };
    world.places.push(site); world.chunks[chunkKey(site.x, site.y)]!.places.push(site);
    world.communities = [{ id: 'hardware-family', name: 'Synthetic community', x: 9, y: 9,
      color: '#aabbcc', members: [a.id, b.id], culture: { ...a.culture }, formedAt: 0, cooperation: 0, disputes: 0 }];
    for (const parent of [a, b]) {
      const traits = demographicTraits(parent.genome);
      parent.bornAt = world.tick - traits.maturityAge - 100;
      parent.demography = initialDemography(world.tick - parent.bornAt);
      parent.lastBirth = 0; parent.inventory = 0.24; parent.communityId = 'hardware-family';
    }
    a.bonds[b.id] = b.bonds[a.id] = 0.9;
    dying.thirst = 1; dying.demography.health = 1e-8; dying.demography.vitality = 0.1;
    const births = world.birthCounter, deaths = world.demographyDynamics.deaths;
    return fixture(world, step => {
      if (step !== 1) return false;
      assert.equal(world.demographyDynamics.deaths, deaths + 1);
      assert.equal(world.birthCounter, births + 1);
      const death = world.events.find(e => e.kind === 'death' && e.actors.includes(dying.id));
      const birth = world.events.find(e => e.kind === 'birth' && e.tick === world.tick);
      assert.ok(death && birth); assert.equal(death.tick, birth.tick);
      assert.equal(world.people.some(p => p.id === dying.id), false);
      const child = world.people.find(p => p.bornAt === world.tick)!;
      assert.deepEqual(new Set(child.genome.parents), new Set([a.id, b.id]));
      return true;
    });
  }
  if (name === 'dispersas') {
    // Five occupied regions: even geometry512/hilos2 must compute multiple regions per queue.
    const positions = [point(9, 9), point(-503, -503), point(521, 521), point(1033, -1015), point(1545, 1033)];
    const world = initialScene(seed, positions), before = world.discoveredChunks;
    for (const side of [256, 512]) assert.equal(new Set(positions.map(p => `${Math.floor(p.x / side)},${Math.floor(p.y / side)}`)).size, 5);
    return fixture(world, step => {
      if (step !== 1) return false;
      assert.ok(world.discoveredChunks >= before + positions.length, 'Separate inhabited patches are actually discovered.');
      assert.ok(world.tiles.some(t => t.x < 0 && t.y < 0));
      assert.ok(world.tiles.some(t => t.x > 1024 && t.y > 1024));
      return true;
    });
  }
  if (name === 'alcance-compuesto') {
    const world = initialScene(seed, [point(511, 12), point(512, 12), point(511, 8), point(524, 8)]);
    const person = world.people[2]!, peer = world.people[3]!, home = point(518, 8), source = tileAt(world, point(522, 8))!;
    for (const tile of world.tiles) { tile.food = 0; tile.drinkingWater = 0; }
    source.food = 0.95; source.drinkingWater = 0.65;
    person.home = { ...home, quality: 0.8, observedAt: world.tick };
    person.sociability = 0.8; person.curiosity = 0.2; person.bonds[peer.id] = 0.95;
    person.decisionAt = 0;
    const memories = world.people.slice(0, 2);
    // S/I remain present but do not provide a shorter peer path to this home.
    for (const p of memories) p.bonds = {};
    assert.equal(Math.hypot(person.x - home.x, person.y - home.y), 7);
    assert.equal(Math.hypot(source.x - home.x, source.y - home.y), 4);
    assert.equal(Math.hypot(peer.x - home.x, peer.y - home.y), 6);
    assert.ok(source.x - person.x > 8 && peer.x - person.x > 8);
    for (const side of [256, 512]) assert.notEqual(Math.floor(person.x / side), Math.floor(home.x / side));
    const observed = settlementOpportunity(world, person);
    assert.ok(observed); assert.deepEqual(observed.target, home);
    const observedQuality = person.home!.quality;
    source.food = 0; source.drinkingWater = 0;
    assert.equal(settlementOpportunity(world, person), undefined, 'Removing only the resource beyond halo8 changes the actual home decision.');
    source.food = 0.95; source.drinkingWater = 0.65;
    person.home = { ...home, quality: observedQuality, observedAt: world.tick };
    return fixture(world, step => {
      if (step !== 1) return false;
      assert.equal(person.action, 'approach'); assert.deepEqual(person.target, home);
      assert.ok(person.home && person.home.quality > 0.4);
      return true;
    });
  }
  const world = initialScene(seed, [point(9, 13), point(10, 13), ...HARVEST_POSITIONS]);
  world.totals.foodHarvested = HARVEST_INITIAL_TOTAL;
  const actors = world.people.slice(2), sources: Tile[] = [];
  for (const actor of actors) { eatUntilDecision(actor, world); sources.push(tileAt(world, actor)!); }
  const food = sources.map(t => t.food);
  for (const side of [256, 512] as const) {
    assert.equal(new Set(actors.map(p => `${Math.floor(p.x / side)},${Math.floor(p.y / side)}`)).size, 2);
    assert.notEqual(regionGroupedHarvestTotal(side), sequentialHarvestTotal(), 'The real FP64 counter must distinguish regional accumulation.');
  }
  return fixture(world, step => {
    if (step !== 1) return false;
    for (let i = 0; i < sources.length; i++) {
      assert.ok(Object.is(sources[i]!.food, food[i]! - HARVEST_AMOUNT));
      assert.ok(Object.is(actors[i]!.inventory, 0.1 + HARVEST_AMOUNT * 0.25));
    }
    assert.ok(Object.is(world.totals.foodHarvested, sequentialHarvestTotal()));
    return true;
  });
}
