import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWorld, closePolicyGpuBatchers, createWorld, stepWorld, tileAt,
} from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, parseParams } from '../src/world/params.js';
import { assertTechnology, researchTechnology } from '../src/world/technology.js';
import { containedWaterQuanta, fillContainedWater } from '../src/world/technology-water.js';
import { containerAffordance } from '../src/world/material-affordances.js';
import type { TechnologyProgram } from '../src/shared/technology.js';
import { proyectoInvestigacion } from './lib/escenas.js';

after(async () => {
  closePolicyGpuBatchers();
  await closeEcosystemWorkers();
});

test('V16 core: historical and default parity stays bit-for-bit identical when V16 laws are 0/false', () => {
  const w1 = createWorld(42, HISTORICAL_PARAMS);
  const w2 = createWorld(42, parseParams('conducta.politicaAutonomia=0,social.derivaCultural=0,social.vinculoEncuentro=0,tecnologia.efectosHerramientas=false', HISTORICAL_PARAMS));
  for (let t = 0; t < 120; t++) { stepWorld(w1); stepWorld(w2); }
  assert.equal(digestoCanonico(w1), digestoCanonico(w2));
  assert.doesNotThrow(() => assertWorld(w1));
});

test('V16 core: energy=0 subsistence deadlock is resolved for S/I and mortals when vinculoEncuentro > 0', () => {
  const runCase = (vinculo: number) => {
    const world = createWorld(7, parseParams(`social.vinculoEncuentro=${vinculo}`, DEFAULT_PARAMS));
    const i = world.people.find(p => p.role === 'I')!;
    const waterTile = world.tiles.find(t => t.terrain !== 'water' && (t.drinkingWater ?? 0) > 0.15);
    assert.ok(waterTile, 'need a drinking water tile in world');
    const startTile = world.tiles.find(t =>
      t.terrain !== 'water' && Math.hypot(t.x - waterTile.x, t.y - waterTile.y) === 1
      && (t.drinkingWater ?? 0) === 0,
    );
    assert.ok(startTile, 'need an adjacent dry land tile');
    i.x = startTile.x; i.y = startTile.y; i.target = { x: startTile.x, y: startTile.y };
    i.energy = 0; i.hunger = 1; i.thirst = 1; i.fatigue = 0.2; i.decisionAt = world.tick;
    stepWorld(world);
    const firstAction = i.action;
    const firstTarget = { ...i.target };
    for (let t = 1; t < 24; t++) stepWorld(world);
    assert.doesNotThrow(() => assertWorld(world));
    return { firstAction, firstTarget, waterTile, thirst: i.thirst };
  };
  const legacy = runCase(0);
  const fixed = runCase(1);
  assert.notEqual(legacy.firstAction, 'drink', 'control (vinculo=0) is blind to adjacent water at energy=0');
  assert.equal(fixed.firstAction, 'drink', 'V16 (vinculo=1) immediately chooses drink on adjacent water at energy=0');
  assert.deepEqual(fixed.firstTarget, { x: fixed.waterTile.x, y: fixed.waterTile.y });
  assert.ok(fixed.thirst < 0.9, `V16 (vinculo=1) walks to water and drinks (thirst=${fixed.thirst})`);
});

test('V16 core: S and I remember their shared anchor and walk back toward reunion without touching world.memories', () => {
  const world = createWorld(17, parseParams('social.vinculoEncuentro=1', DEFAULT_PARAMS));
  const memoriesBefore = JSON.stringify(world.memories);
  const s = world.people.find(p => p.role === 'S')!;
  const i = world.people.find(p => p.role === 'I')!;
  // Separate S and I by ~25 cells with full bodily comfort and high closeness.
  const farLand = world.tiles.find(t => t.terrain !== 'water' && Math.hypot(t.x - s.x, t.y - s.y) >= 18 && Math.hypot(t.x - s.x, t.y - s.y) <= 26);
  assert.ok(farLand, 'need walkable tile ~20 cells away');
  i.x = farLand.x; i.y = farLand.y; i.target = { x: farLand.x, y: farLand.y };
  for (const p of [s, i]) {
    p.hunger = 0.1; p.thirst = 0.1; p.fatigue = 0.1; p.energy = 0.95; p.socialLoad = 0; p.closeness = 0.85; p.decisionAt = world.tick;
  }
  const initialDist = Math.hypot(s.x - i.x, s.y - i.y);
  for (let t = 0; t < 360; t++) stepWorld(world);
  const finalDist = Math.hypot(s.x - i.x, s.y - i.y);
  assert.ok(s.partnerMemory && i.partnerMemory, 'both S and I must maintain local partnerMemory');
  assert.ok(finalDist < initialDist, `S and I should converge toward reunion (${initialDist.toFixed(1)} -> ${finalDist.toFixed(1)})`);
  assert.equal(JSON.stringify(world.memories), memoriesBefore, 'Steven authored world.memories must NEVER be mutated');
  assert.doesNotThrow(() => assertWorld(world));
});

test('V16 core: politicaAutonomia empowers neural policy to steer non-emergency decisions and updates Baldwin plasticity on rest', () => {
  const params = parseParams('conducta.politicaPeso=1.2,conducta.politicaAutonomia=0.7', DEFAULT_PARAMS);
  const world = createWorld(51926, params);
  let policySteeredCount = 0;
  for (let t = 0; t < 300; t++) {
    stepWorld(world);
    for (const p of world.people) {
      if (p.reason.includes('Su política neuronal aprendida inclinó esta estrategia.')) policySteeredCount++;
    }
  }
  assert.ok(policySteeredCount > 0, 'neural policy must visibly steer non-emergency decisions when politicaAutonomia > 0');
  const plasticPeople = world.people.filter(p => p.policyPlasticity && p.policyPlasticity.bias.some(b => Math.abs(b) > 0));
  assert.ok(plasticPeople.length > 0, 'Baldwin plasticity must accumulate real non-zero biases');
  assert.doesNotThrow(() => assertWorld(world));
});

test('V16 core: validation rejects corrupted partnerMemory', () => {
  const world = createWorld(7, DEFAULT_PARAMS);
  const s = world.people.find(p => p.role === 'S')!;
  s.partnerMemory = { x: 0, y: 0, tick: world.tick + 10 };
  assert.throws(() => assertWorld(world));
  s.partnerMemory = { x: 0, y: 0, tick: world.tick };
  assert.doesNotThrow(() => assertWorld(world));
  const tile = tileAt(world, s);
  assert.ok(tile);
});

test('V16 core: desperate explorer bounces off water shoreline and holds search leg at energy=0, fatigue=1', () => {
  const world = createWorld(7, parseParams('social.vinculoEncuentro=1', DEFAULT_PARAMS));
  const s = world.people.find(p => p.role === 'S')!;
  // Drain local water around S and place a water barrier straight north of S, then point S north (-PI/2).
  for (const t of world.tiles) {
    if (Math.hypot(t.x - s.x, t.y - s.y) <= 8) {
      t.drinkingWater = 0;
      t.food = 0;
      if (t.y < s.y) t.terrain = 'water';
    }
  }
  s.heading = -Math.PI / 2;
  s.energy = 0; s.fatigue = 1; s.hunger = 1; s.thirst = 1; s.inventory = 0;
  s.action = 'explore'; s.target = { x: s.x, y: s.y }; s.decisionAt = world.tick;
  const headingBefore = s.heading;
  stepWorld(world);
  assert.equal(s.action, 'explore');
  assert.notEqual(s.heading, headingBefore, 'exhausted searcher facing a shoreline must bounce heading into open land');
  const chosenTarget = { ...s.target };
  assert.ok(Math.hypot(chosenTarget.x - s.x, chosenTarget.y - s.y) >= 3, 'search leg must pick a distant waypoint');
  stepWorld(world);
  assert.deepEqual(s.target, chosenTarget, 'desperate searcher must hold its search waypoint even at energy=0, fatigue=1');
  assert.doesNotThrow(() => assertWorld(world));
});

test('V16 core: exhausted carrier drops carried water with exact conservation instead of freezing in move()', () => {
  const world = createWorld(7, parseParams('social.vinculoEncuentro=1', DEFAULT_PARAMS));
  const actor = world.people.find(p => p.role === 'I')!;
  const waterTile = world.tiles.find(t => t.terrain !== 'water' && (t.drinkingWater ?? 0) > 0.2)!;
  const dryAdj = world.tiles.find(t => t.terrain !== 'water' && Math.hypot(t.x - waterTile.x, t.y - waterTile.y) === 1 && (t.drinkingWater ?? 0) === 0)!;
  actor.x = waterTile.x; actor.y = waterTile.y;
  actor.materials.wood = 8; actor.materials.stone = 8;
  // Craft a real hollow vessel through paid technology so all ledgers & checkpoints stay valid.
  const hollow: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'stone', mass: 2000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'hollow' }, { op: 'compress', intensity: 2 }],
  };
  actor.technology.project = proyectoInvestigacion(hollow, world.tick);
  for (let n = 0; actor.technology.project && n < 250; n++) {
    world.tick++;
    for (const p of world.people) p.demography.age = world.tick - p.bornAt;
    researchTechnology(world, actor);
  }
  const vessel = actor.technology.items.find(i => containerAffordance(i).capacityQuanta > 0)!;
  assert.ok(vessel, 'need a hollow container');
  world.tick++;
  for (const p of world.people) p.demography.age = world.tick - p.bornAt;
  const filled = fillContainedWater(world, actor, vessel.id, 250);
  assert.ok(filled > 0, 'vessel must fill from local water');
  // Move actor to dry adjacent tile with energy=0, fatigue=1, hunger=1, thirst=1 so payContainedWaterCarry fails.
  actor.x = dryAdj.x; actor.y = dryAdj.y;
  actor.energy = 0; actor.fatigue = 1; actor.hunger = 1; actor.thirst = 1;
  actor.action = 'drink'; actor.target = { x: waterTile.x, y: waterTile.y };
  const lossBefore = world.technology.water!.environmentalLoss;
  const startTick = world.tick;
  while (world.tick < startTick + 12) stepWorld(world);
  assert.equal(containedWaterQuanta(actor), 0, 'exhausted actor must shed dead-weight water');
  assert.ok(world.technology.water!.environmentalLoss >= lossBefore + filled - 50, 'spilled water must be conserved in environmentalLoss');
  assert.ok(actor.x === waterTile.x && actor.y === waterTile.y, 'after shedding water weight, actor must move onto water tile');
  assert.doesNotThrow(() => assertTechnology(world));
  assert.doesNotThrow(() => assertWorld(world));
});
