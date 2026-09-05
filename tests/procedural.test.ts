import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, projectWorld, assertWorld, tileAt, type World } from '../src/world/index.js';

function run(w: World, ticks: number) { for (let n = 0; n < ticks; n++) stepWorld(w); }
function ready() {
  const w = createWorld(51926), p = w.people[2]!;
  p.x = 36; p.y = 12; p.target = { x: p.x, y: p.y }; p.hunger = 0.1; p.fatigue = 0.1; p.energy = 1;
  p.materials = { wood: 6, stone: 3 }; p.work = 0; p.decisionAt = 0;
  return { w, p };
}

test('far and negative camera windows are pure, bounded, and independent of discovery and weather', () => {
  const w = createWorld(51926), control = structuredClone(w);
  const a = projectWorld(w, { x: -1200, y: 2400, width: 96, height: 64 });
  assert.equal(a.tiles.length, 6144); assert.equal(a.tiles[0]!.x, -1200); assert.equal(a.infinite, true);
  projectWorld(w, { x: 8765, y: -4321, width: 32, height: 24 });
  assert.deepEqual(w, control); run(w, 100); run(control, 100); assert.deepEqual(w, control);
  assert.throws(() => projectWorld(w, { x: 0, y: 0, width: 97, height: 64 }));
});

test('any inhabitant follows a distant order physically across the old boundary and returns to autonomy', () => {
  const { w, p } = ready();
  const result = stepWorld(w, [{ id: 'direct-move-1', kind: 'command', agentId: p.id, order: 'move', x: 58, y: 12 }])[0]!;
  assert.equal(result.accepted, true); assert.equal(p.controlMode, 'directed');
  let crossed = false;
  for (let n = 0; n < 220; n++) {
    const old = { x: p.x, y: p.y }; stepWorld(w);
    assert.ok(Math.abs(p.x - old.x) + Math.abs(p.y - old.y) <= 1);
    assert.notEqual(tileAt(w, p)!.terrain, 'water'); crossed ||= p.x >= 40;
    if (p.command === null) break;
  }
  assert.ok(crossed); assert.equal(p.x, 58); assert.equal(p.y, 12); assert.equal(p.controlMode, 'auto');
  assert.ok(w.discoveredChunks > 0); assert.ok(w.events.some(e => e.kind === 'discovery' && e.actors.includes(p.id)));
  assertWorld(w);
});

test('building needs actual work and spends exactly six wood and three stone once', () => {
  const { w, p } = ready();
  stepWorld(w, [{ id: 'build-1', kind: 'command', agentId: p.id, order: 'build', x: p.x, y: p.y }]);
  run(w, 30); assert.notEqual(tileAt(w, p)!.terrain, 'shelter'); assert.deepEqual(p.materials, { wood: 6, stone: 3 });
  run(w, 60); assert.equal(w.settlementCount, 1); assert.deepEqual(p.materials, { wood: 0, stone: 0 });
  assert.equal(tileAt(w, { x: 36, y: 12 })!.terrain, 'shelter');
  assert.equal(w.events.filter(e => e.kind === 'settlement').length, 1); assert.equal(p.activity.build, 1);
  const { w: empty, p: worker } = ready(); worker.materials = { wood: 5, stone: 3 };
  stepWorld(empty, [{ id: 'build-2', kind: 'command', agentId: worker.id, order: 'build', x: worker.x, y: worker.y }]); run(empty, 90);
  assert.equal(empty.settlementCount, 0); assert.equal(worker.activity.build, undefined);
  assert.ok(Object.values(worker.values).some(v => v < 0), 'failed work produces a negative outcome');
});

test('harvest and cultivation consume actual resources; learning ablation preserves actions and costs', () => {
  const { w, p } = ready(); p.materials = { wood: 0, stone: 0 };
  const tile = tileAt(w, p)!; tile.wood = 3;
  const control = structuredClone(w); control.adaptationEnabled = false;
  const command = { id: 'gather-1', kind: 'command' as const, agentId: p.id, order: 'gather' as const, x: p.x, y: p.y };
  stepWorld(w, [command]); stepWorld(control, [command]); run(w, 18); run(control, 18);
  assert.equal(p.materials.wood, 1); assert.equal(tile.wood, 2);
  assert.deepEqual(control.people[2]!.materials, p.materials); assert.deepEqual(control.people[2]!.skills, p.skills);
  assert.deepEqual(control.people[2]!.values, {}); assert.ok(Object.values(p.values).some(v => v > 0));
  const before = tile.food; tile.vegetation = 0.2; tile.moisture = 0.7;
  stepWorld(w, [{ id: 'farm-1', kind: 'command', agentId: p.id, order: 'farm', x: p.x, y: p.y }]); run(w, 44);
  assert.equal(p.materials.wood, 0); assert.ok((tile.cultivation ?? 0) > 0.15); assert.ok(tile.vegetation > 0.23);
  assert.ok(tile.food < before + 0.02, 'work does not instantly create a harvest');
});

test('professions are descriptive and urgent bodily needs can suspend user work', () => {
  const { w, p } = ready(), control = structuredClone(w);
  p.specialty = 'Una etiqueta arbitraria'; control.people[2]!.specialty = 'Otra etiqueta';
  stepWorld(w); stepWorld(control); assert.equal(p.action, control.people[2]!.action); assert.deepEqual(p.target, control.people[2]!.target);
  p.hunger = 0.99; p.inventory = 0.2;
  stepWorld(w, [{ id: 'urgent-1', kind: 'command', agentId: p.id, order: 'build', x: p.x, y: p.y }]);
  assert.equal(p.action, 'eat'); assert.equal(p.controlMode, 'directed');
  stepWorld(w, [{ id: 'auto-1', kind: 'command', agentId: p.id, order: 'auto', x: p.x, y: p.y }]);
  assert.equal(p.controlMode, 'auto'); assert.equal(p.command, null);
});

test('a failed task changes the next autonomous choice; its paired learning control keeps the same costs', () => {
  const { w, p } = ready();
  p.materials = { wood: 0, stone: 0 }; p.curiosity = 0.5; p.traits.industriousness = 0.2125; p.generosity = 0; p.closeness = 0;
  const tile = tileAt(w, p)!; tile.wood = 0; tile.stone = 0;
  // Keep the nearest resource unavailable until the directed trial completes.
  for (const t of w.tiles) { t.wood = 0; t.stone = 0; if (t.terrain === 'shelter') t.terrain = 'meadow'; }
  const control = structuredClone(w); control.adaptationEnabled = false;
  const command = { id: 'failed-trial', kind: 'command' as const, agentId: p.id, order: 'gather' as const, x: p.x, y: p.y };
  stepWorld(w, [command]); stepWorld(control, [command]); run(w, 17); run(control, 17);
  assert.deepEqual(p.materials, control.people[2]!.materials); assert.deepEqual(p.skills, control.people[2]!.skills);
  assert.ok((p.values['ready:gather'] ?? 0) < 0);
  for (const state of [w, control]) {
    const actor = state.people[2]!; tileAt(state, actor)!.wood = 3;
    actor.command = null; actor.controlMode = 'auto'; actor.decisionAt = 0;
  }
  stepWorld(w); stepWorld(control);
  assert.equal(p.action, 'explore'); assert.equal(control.people[2]!.action, 'gather');
});

test('reward stays attached to the pre-outcome need context, and resilience changes exertion only', () => {
  const { w, p } = ready(); p.hunger = 0.501; p.action = 'eat'; p.target = { x: p.x, y: p.y }; p.decisionAt = 100; p.intentContext = 'hungry';
  w.tick = 29; tileAt(w, p)!.food = 0.5; stepWorld(w);
  assert.ok(p.hunger < 0.5); assert.ok((p.values['hungry:eat'] ?? 0) > 0); assert.equal(p.values['ready:eat'], undefined);
  const a = ready(), b = { w: structuredClone(a.w), p: undefined as unknown as typeof a.p }; b.p = b.w.people[2]!;
  a.p.traits.resilience = 0; b.p.traits.resilience = 1;
  for (const scene of [a, b]) { stepWorld(scene.w, [{ id: 'resilient', kind: 'command', agentId: scene.p.id, order: 'move', x: 38, y: 12 }]); run(scene.w, 5); }
  assert.equal(a.p.x, b.p.x); assert.equal(a.p.y, b.p.y); assert.ok(a.p.fatigue > b.p.fatigue);
});

test('invalid active metadata is rejected and unknown synthetic provenance never crosses projection', () => {
  const w = createWorld();
  for (const change of [
    (value: World) => { (value.tiles[0] as unknown as Record<string, unknown>).biome = 'invalid'; },
    (value: World) => { (value.tiles[0] as unknown as Record<string, unknown>).elevation = 'invalid'; },
    (value: World) => { value.chunks['0,0']!.places = [null as never]; },
    (value: World) => { value.people[0]!.intentContext = 'invalid' as never; },
  ]) { const value = structuredClone(w); change(value); assert.throws(() => assertWorld(value)); }
  (tileAt(w, { x: 0, y: 0 }) as unknown as Record<string, unknown>).privateSource = 'synthetic-canary';
  (w.events[0] as unknown as Record<string, unknown>).privateSource = 'synthetic-canary';
  assert.equal(JSON.stringify(projectWorld(w)).includes('synthetic-canary'), false);
});

test('local navigation walks around a nearby river and explicitly ends an enclosed command', () => {
  const { w, p } = ready();
  for (const t of w.tiles) t.terrain = t.x === 11 && t.y >= 0 && t.y <= 20 ? 'water' : 'meadow';
  p.x = 10; p.y = 10; p.target = { x: 10, y: 10 };
  stepWorld(w, [{ id: 'river-detour', kind: 'command', agentId: p.id, order: 'move', x: 12, y: 10 }]);
  run(w, 190); assert.equal(p.command, null); assert.ok(p.visited.includes('12,10'));
  const enclosed = ready();
  for (const t of enclosed.w.tiles) if (Math.abs(t.x - enclosed.p.x) + Math.abs(t.y - enclosed.p.y) === 1) t.terrain = 'water';
  stepWorld(enclosed.w, [{ id: 'blocked-command', kind: 'command', agentId: enclosed.p.id, order: 'move', x: 38, y: 12 }]); run(enclosed.w, 5);
  assert.equal(enclosed.p.command, null); assert.equal(enclosed.p.controlMode, 'auto'); assert.match(enclosed.p.reason, /interrumpida/);
});

test('directed gathering reaches a locally perceived resource and completes work across decision boundaries', () => {
  const { w, p } = ready(); p.materials = { wood: 0, stone: 0 };
  for (const tile of w.tiles) { tile.wood = 0; tile.stone = 0; }
  const source = tileAt(w, { x: 40, y: 12 })!; source.wood = 3;
  stepWorld(w, [{ id: 'gather-distant', kind: 'command', agentId: p.id, order: 'gather', x: p.x, y: p.y }]); run(w, 60);
  assert.ok(p.materials.wood >= 1); assert.ok(source.wood < 3);
  assert.ok(p.visited.includes('40,12')); assert.ok((p.activity.gather ?? 0) >= 1);
});
