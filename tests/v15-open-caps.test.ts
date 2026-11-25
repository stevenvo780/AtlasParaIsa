import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlueprintView } from '../src/shared/life.js';
import type { ChronicleEvent, Tile } from '../src/shared/types.js';
import { assertWorld, cloneWorld, createWorld, projectWorld, stepWorld, tileAt, type World } from '../src/world/index.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { GPUParitySession, type ParityBackend } from '../src/world/gpu/autoprueba.js';
import { activate } from '../src/world/spatial.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import {
  blueprintCap, blueprintCost, completeConstruction, constructionOpportunity,
  inventionOpportunity, MAX_BLUEPRINTS, MAX_STRUCTURES, structureCap,
} from '../src/world/inventions.js';
import {
  MAX_ACTIVE_ANIMALS, MAX_ANIMAL_DECISIONS_PER_TICK, mascaraFauna, materializeAnimals, stepAnimals, syncFauna,
  type AnimalWorld,
} from '../src/world/animals.js';
import {
  DEFAULT_PARAMS, limitsOf, OPEN_WORLD_MAX_BLUEPRINTS, openWorldCaps, paramsOf, parseParams, setParams,
} from '../src/world/params.js';
import { deploymentParams } from '../src/server/deployment-params.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

const OPEN_PARAMS = parseParams(
  'poblacion.natalidadVecindad=true,social.maxComunidades=0,limites.chunks=65536,limites.teselasActivas=16777216,limites.comunidades=16777216,limites.fauna=100663296',
);

function emitFor(world: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => {
    const result = recordChronicleEvent(world, event);
    world.events.push(result);
    return result;
  };
}

function seedStructures(world: World, count: number, reserve?: { x: number; y: number }): void {
  const base = world.blueprints.find(b => b.id === 'blueprint-base')!;
  const occupied = new Set(world.structures.map(s => `${s.x},${s.y}`));
  for (const tile of world.tiles) {
    if (world.structures.length >= count) break;
    if (tile.terrain === 'water' || tile.terrain === 'shelter') continue;
    if (reserve && Math.hypot(tile.x - reserve.x, tile.y - reserve.y) <= 8) continue;
    const key = `${tile.x},${tile.y}`;
    if (occupied.has(key)) continue;
    tile.terrain = 'shelter';
    world.structureCounter++;
    world.structures.push({
      id: `structure-${world.structureCounter}`,
      x: tile.x,
      y: tile.y,
      blueprintId: base.id,
      name: base.name,
      components: [...base.components],
      condition: 1,
      water: 0,
      food: 0,
      uses: 0,
      builtAt: world.tick,
      builderId: null,
    });
    occupied.add(key);
  }
  assert.equal(world.structures.length, count);
}

test('openWorldCaps distinguishes legacy/default worlds from open-world V15', () => {
  const legacyWorld = createWorld(20261121, DEFAULT_PARAMS);
  const openWorld = createWorld(20261121, OPEN_PARAMS);
  assert.equal(openWorldCaps(legacyWorld), false);
  assert.equal(structureCap(legacyWorld), MAX_STRUCTURES);
  assert.equal(blueprintCap(legacyWorld), MAX_BLUEPRINTS);

  assert.equal(openWorldCaps(openWorld), true);
  assert.equal(structureCap(openWorld), limitsOf(openWorld).teselasActivas);
  assert.equal(blueprintCap(openWorld), OPEN_WORLD_MAX_BLUEPRINTS);
});

test('structures: default world caps at 512 while open-world V15 builds and validates > 512', () => {
  for (const [isOpen, params] of [[false, DEFAULT_PARAMS], [true, OPEN_PARAMS]] as const) {
    const world = createWorld(7001, params);
    for (let cx = 3; cx <= 6; cx++) activate(world, cx * 16, 0);
    const person = world.people[2]!;
    // Pick a site in the frontier chunk with zero shelters within radius 8 and >= 6 from all places.
    const site = world.tiles.find(t =>
      t.x >= 80 && (t.terrain === 'meadow' || t.terrain === 'soil')
      && world.places.every(p => Math.hypot(p.x - t.x, p.y - t.y) >= 6)
      && world.structures.every(s => Math.hypot(s.x - t.x, s.y - t.y) > 8),
    );
    assert.ok(site, 'need a clear frontier land site');
    seedStructures(world, MAX_STRUCTURES, site);

    person.x = site.x;
    person.y = site.y;
    person.target = { x: site.x, y: site.y };
    person.fatigue = 0.7;
    person.materials = { wood: 12, stone: 8 };
    person.blueprintId = 'blueprint-base';
    person.work = 90;

    const opportunity = constructionOpportunity(world, person);
    const built = completeConstruction(world, person, tileAt(world, site)!, emitFor(world));
    if (!isOpen) {
      assert.equal(opportunity, undefined);
      assert.equal(built, null);
      assert.equal(world.structures.length, MAX_STRUCTURES);
    } else {
      assert.ok(opportunity, 'open-world must propose construction beyond 512');
      assert.ok(built, 'open-world must complete the 513th structure');
      assert.equal(world.structures.length, MAX_STRUCTURES + 1);
      assert.doesNotThrow(() => assertWorld(world));
    }
  }
});

test('places: default world rejects > 2048 places while open-world V15 admits and validates > 2048', () => {
  const fillPlaces = (world: World, target: number) => {
    for (let i = world.places.length; i < target; i++) {
      world.places.push({
        id: `place-extra-${i}`,
        name: `Lugar ${i}`,
        x: i % 40,
        y: Math.floor(i / 40) % 28,
        description: 'Asentamiento emergente.',
        gatherings: 0,
      });
    }
  };

  const legacyWorld = createWorld(7002, DEFAULT_PARAMS);
  fillPlaces(legacyWorld, 2049);
  assert.throws(() => assertWorld(legacyWorld), /Estado del mundo inválido/);

  const openWorld = createWorld(7002, OPEN_PARAMS);
  fillPlaces(openWorld, 2055);
  assert.doesNotThrow(() => assertWorld(openWorld));
});

test('blueprints: default world caps at 64 (and generation <= 64) while open-world V15 raises both to 4096', async () => {
  const { assertBlueprint } = await import('../src/world/validation.js');
  const bpGen65: BlueprintView = {
    id: 'blueprint-65',
    name: 'Plano 65',
    components: ['frame', 'roof', 'granary'],
    generation: 65,
    parents: ['blueprint-64'],
    inventorId: 'neighbor-1',
    tick: 1200,
    uses: 0,
    usefulness: 0,
    cost: blueprintCost(['frame', 'roof', 'granary']),
  };

  // Legacy assertBlueprint rejects generation > 64; open-world maxGeneration (4096) admits it.
  assert.throws(() => assertBlueprint(bpGen65, 1200), /Estado de vida o estructuras inválido/);
  assert.doesNotThrow(() => assertBlueprint(bpGen65, 1200, OPEN_WORLD_MAX_BLUEPRINTS));

  // Verify inventionOpportunity cap gating directly at 64 entries.
  const padBlueprints = (world: World, target: number) => {
    while (world.blueprints.length < target) {
      world.blueprintCounter++;
      world.blueprints.push({ ...bpGen65, id: `blueprint-${world.blueprintCounter}`, generation: 1, parents: ['blueprint-base'] });
    }
  };
  const legacyAt64 = createWorld(7003, DEFAULT_PARAMS);
  legacyAt64.tick = 1200;
  padBlueprints(legacyAt64, MAX_BLUEPRINTS);
  const pLegacy = legacyAt64.people[2]!;
  pLegacy.materials = { wood: 12, stone: 8 };
  pLegacy.skills = { build: 0.9 };
  pLegacy.lastInvention = undefined;
  assert.equal(inventionOpportunity(legacyAt64, pLegacy), undefined);
  assert.equal(blueprintCap(legacyAt64), MAX_BLUEPRINTS);

  const openAt64 = createWorld(7003, OPEN_PARAMS);
  openAt64.tick = 1200;
  assert.equal(blueprintCap(openAt64), OPEN_WORLD_MAX_BLUEPRINTS);
  assert.ok(openAt64.blueprints.length < blueprintCap(openAt64));
  const pOpen = openAt64.people[2]!;
  pOpen.materials = { wood: 12, stone: 8 };
  pOpen.skills = { build: 0.9 };
  pOpen.lastInvention = undefined;
  // Open world still proposes invention when legacy world is gated at 64.
  assert.ok(inventionOpportunity(openAt64, pOpen) !== undefined);
});

test('fauna: default world windows at 8192/1024 while open-world V15 runs all due decisions', () => {
  const count = MAX_ACTIVE_ANIMALS + 400; // 8592 > 8192
  const makeHerd = (params = DEFAULT_PARAMS): AnimalWorld => {
    const tiles: Tile[] = Array.from({ length: count }, (_, x) => ({
      x, y: 0, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.8, growth: 0.8,
      food: 0.4, fauna: 1, species: 'hare', drinkingWater: 0.8, fertility: 0.6,
    }));
    const animals = materializeAnimals(42, tiles, 0);
    // Mark first 1400 animals as due for decision (> MAX_ANIMAL_DECISIONS_PER_TICK = 1024)
    for (let i = 0; i < animals.length; i++) animals[i]!.lastDecision = i < 1400 ? 0 : 100;
    syncFauna(tiles, animals);
    const w: AnimalWorld = {
      seed: 42, tick: 100, tiles, animals, animalCounter: 0, reproductionEnabled: false,
      animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 },
    };
    setParams(w, params);
    return w;
  };

  const legacy = makeHerd(DEFAULT_PARAMS);
  const legacyMask = mascaraFauna(legacy);
  assert.equal(legacyMask.seleccion.length, MAX_ACTIVE_ANIMALS);
  stepAnimals(legacy, undefined, legacyMask);
  const legacyDecided = legacy.animals.filter(a => a.lastDecision === 100).length - (count - 1400);
  assert.equal(legacyDecided, MAX_ANIMAL_DECISIONS_PER_TICK);

  const open = makeHerd(OPEN_PARAMS);
  const openMask = mascaraFauna(open);
  assert.equal(openMask.seleccion.length, count);
  stepAnimals(open, undefined, openMask);
  const openDecided = open.animals.filter(a => a.lastDecision === 100).length - (count - 1400);
  assert.equal(openDecided, 1400);
});

test('in-place V15 production upgrade: old 5092-chunk snapshot reloads, lifts limites.* via CARTA_PARAMS, saves and cold-reloads cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-v15-upgrade-'));
  const dbPath = join(dir, 'world.sqlite');
  try {
    const oldV15Params = parseParams(
      'poblacion.natalidadVecindad=true,social.maxComunidades=0,conducta.politicaPeso=0.25,'
      + 'limites.chunks=5092,limites.teselasActivas=1303552,limites.comunidades=1303552,limites.fauna=7821312',
    );
    const initial = createWorld(20261121, oldV15Params);
    seedStructures(initial, MAX_STRUCTURES);
    assertWorld(initial);

    const store1 = new Store(dbPath);
    try {
      store1.save(initial);
    } finally {
      store1.close();
    }

    // Simulate production restart (`main.ts`): Store.load() → deploymentParams() with upgraded CARTA_PARAMS
    const store2 = new Store(dbPath);
    try {
      const snap = store2.load();
      assert.ok(snap);
      const loaded = snap.world;
      assert.equal(limitsOf(loaded).chunks, 5092);
      assert.equal(openWorldCaps(loaded), true);

      const upgraded = deploymentParams(
        paramsOf(loaded),
        'limites.chunks=65536,limites.teselasActivas=16777216,limites.comunidades=16777216,limites.fauna=100663296',
      );
      setParams(loaded, upgraded);
      assert.equal(limitsOf(loaded).chunks, 65536);
      assert.equal(limitsOf(loaded).teselasActivas, 16777216);
      assert.equal(structureCap(loaded), 16777216);

      stepWorld(loaded);
      assertWorld(loaded);
      store2.save(loaded);
    } finally {
      store2.close();
    }

    // Cold reload verifies upgraded limitsProfile + params persisted cleanly in SQLite
    const store3 = new Store(dbPath);
    try {
      const snap = store3.load();
      assert.ok(snap);
      const reloaded = snap.world;
      assert.equal(limitsOf(reloaded).chunks, 65536);
      assert.equal(limitsOf(reloaded).teselasActivas, 16777216);
      assert.equal(limitsOf(reloaded).comunidades, 16777216);
      assert.equal(limitsOf(reloaded).fauna, 100663296);
      assert.equal(openWorldCaps(reloaded), true);
      assert.doesNotThrow(() => assertWorld(cloneWorld(reloaded)));
    } finally {
      store3.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projectWorld clips technology.items to viewport while dynamics.products keeps global count', () => {
  const world = createWorld(7004, OPEN_PARAMS);
  const inside = world.people[0]!;
  const outside = world.people[2]!;
  inside.x = 10; inside.y = 10;
  outside.x = 200; outside.y = 200;
  const fakeItem = (id: string) => ({
    id, recipeId: null, mass: 500, initialMass: 500, generation: 0,
    composition: { wood: 500, stone: 0, water: 0 },
    properties: {
      hardness: 0.2, toughness: 0.2, porosity: 0.1, flexibility: 0.1,
      edge: 0.1, containment: 0.1, insulation: 0.1, leverage: 0.1,
      cohesion: 0.2, temperature: 0.2, alignment: 0.2, firing: 0,
    },
    madeAt: 0, parentItems: [] as string[],
  });
  inside.technology.items.push(fakeItem('item-in'));
  outside.technology.items.push(fakeItem('item-out'));

  const view = projectWorld(world, { x: 0, y: 0, width: 40, height: 28 });
  assert.deepEqual(view.technology!.items.map(i => i.id), ['item-in']);
  assert.equal(view.technology!.dynamics.products, 2);
});

test('stringifyExact fast path preserves exact bytes with and without -0 and custom toJSON', () => {
  const plain = { a: 1, b: [0, 2.5, 'x'], c: { d: true, e: null } };
  assert.equal(stringifyExact(plain), JSON.stringify(plain));

  const negZero = { a: 1, nested: [0, -0, { z: -0 }] };
  assert.equal(stringifyExact(negZero), '{"a":1,"nested":[0,-0,{"z":-0}]}');

  const withToJson = { x: { toJSON: () => ({ v: -0 }) } };
  assert.equal(stringifyExact(withToJson), '{"x":{"v":-0}}');
});

test('GPUParitySession respects custom budgetMs so loaded restarts do not disable healthy GPUs', async () => {
  const session = new GPUParitySession();
  const slowBackend: ParityBackend = {
    initialization: { devices: [{ index: 0, architecture: 'compute_120', driver: 13040, compileOptions: ['--fmad=false'] }], fmad: false },
    setup: async () => {},
    step: async () => { await new Promise(r => setTimeout(r, 80)); return { data: new Float64Array(0) }; },
    close: async () => {},
  };
  const expired = await session.initialize(0, { nvrtc: 'fake', budgetMs: 30, createBackend: async () => slowBackend });
  assert.equal(expired.enabled, false);
  assert.match(expired.reason ?? '', /30 ms/);
});

test('createApp({ manual: true }) stays idle until start() so startup GPU self-test is never starved by stepWorld', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-v15-boot-'));
  const store = new Store(join(dir, 'world.sqlite'));
  const app = createApp({ store, manual: true, tickMs: 20, origin: 'http://127.0.0.1:0', password: 'test-password-123' });
  try {
    const initialTick = app.world.tick;
    await new Promise(r => setTimeout(r, 80));
    assert.equal(app.world.tick, initialTick, 'must not advance ticks before start()');
    app.start();
    await new Promise(r => setTimeout(r, 120));
    assert.ok(app.world.tick > initialTick, 'must advance ticks after start()');
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

