import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWorld, cloneWorld, closePersonasParallelPools, closePolicyGpuBatchers, createWorld, stepWorld, TICKS_PER_DAY, type World,
} from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';

function digestoSinMotor(world: World): string {
  const copy = cloneWorld(world);
  setParams(copy, { ...paramsOf(copy), motor: DEFAULT_PARAMS.motor });
  return digestoCanonico(copy);
}

after(async () => {
  closePolicyGpuBatchers();
  await closePersonasParallelPools();
  await closeEcosystemWorkers();
});

test('V17: long-range coastal detour routes around a concave water barrier identically in 1T and 4T parallel', () => {
  const build = (motor: string) => {
    const world = createWorld(7, parseParams(`social.vinculoEncuentro=1,${motor}`, DEFAULT_PARAMS));
    const s = world.people.find(p => p.role === 'S')!;
    const i = world.people.find(p => p.role === 'I')!;
    // Place S in open land and build a vertical water wall straight west of S (moving any colliding entities out of the wall).
    const wallX = s.x - 1;
    world.structures = world.structures.filter(st => st.x !== wallX);
    world.animals = world.animals.filter(a => a.x !== wallX);
    for (const p of world.people) if (p !== s && p.x === wallX) p.x = s.x + 2;
    for (const tile of world.tiles) {
      if (tile.x === wallX && Math.abs(tile.y - s.y) <= 26) { tile.terrain = 'water'; tile.drinkingWater = 0; }
      else if (Math.abs(tile.x - s.x) <= 28 && Math.abs(tile.y - s.y) <= 28 && tile.terrain === 'water') tile.terrain = 'meadow';
    }
    i.x = s.x - 40; i.y = s.y;
    s.partnerMemory = { x: s.x - 40, y: s.y, tick: world.tick };
    s.action = 'approach'; s.target = { x: s.x - 40, y: s.y };
    s.hunger = 0.1; s.thirst = 0.1; s.fatigue = 0.1; s.energy = 0.95; s.socialLoad = 0; s.closeness = 0.9;
    s.decisionAt = world.tick + 120;
    const startY = s.y;
    for (let t = 0; t < 48; t++) stepWorld(world);
    assert.doesNotThrow(() => assertWorld(world));
    return { world, movedAlongCoast: Math.abs(s.y - startY) };
  };
  const serial = build('motor.hilos=1,motor.particionarPersonas=false');
  const parallel = build('motor.hilos=4,motor.particionarPersonas=true');
  assert.ok(serial.movedAlongCoast >= 4, `pilgrim must detour along water wall instead of stalling (moved ${serial.movedAlongCoast})`);
  assert.equal(digestoSinMotor(parallel.world), digestoSinMotor(serial.world), 'coastal detour must be bit-identical between 1T and 4T');
});

test('V17: multi-day S/I continental separation triggers pilgrimage without touching Steven memories', () => {
  const world = createWorld(42, parseParams('social.vinculoEncuentro=1,conducta.politicaPeso=0.8,conducta.politicaAutonomia=0.65', DEFAULT_PARAMS));
  const memoriesBefore = JSON.stringify(world.memories);
  const s = world.people.find(p => p.role === 'S')!;
  const i = world.people.find(p => p.role === 'I')!;
  // Simulate 4 days apart with moderate needs (0.70 hunger/thirst) that previously blocked reunionCandidate.
  world.tick = 4 * TICKS_PER_DAY;
  for (const p of world.people) p.demography.age = world.tick - p.bornAt;
  s.lastMeeting = 0; i.lastMeeting = 0;
  s.partnerMemory = { x: i.x, y: i.y, tick: world.tick };
  s.x = i.x + 80; s.y = i.y;
  s.hunger = 0.68; s.thirst = 0.68; s.fatigue = 0.74; s.energy = 0.5; s.socialLoad = 0.4; s.closeness = 0.45;
  s.decisionAt = world.tick;
  stepWorld(world);
  assert.equal(s.action, 'approach', 'after multi-day separation, moderate needs must still allow pilgrimage home');
  assert.equal(JSON.stringify(world.memories), memoriesBefore, 'world.memories must NEVER be mutated');
  assert.doesNotThrow(() => assertWorld(world));
});

test('V17: historical parity remains bit-for-bit identical when vinculoEncuentro=0 and politicaAutonomia=0', () => {
  const a = createWorld(51926, HISTORICAL_PARAMS);
  const b = createWorld(51926, parseParams('social.vinculoEncuentro=0,conducta.politicaAutonomia=0', HISTORICAL_PARAMS));
  for (let t = 0; t < 120; t++) { stepWorld(a); stepWorld(b); }
  assert.equal(digestoCanonico(a), digestoCanonico(b));
});
