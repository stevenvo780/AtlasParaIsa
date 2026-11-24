import test from 'node:test';
import assert from 'node:assert/strict';
import { activeWhisperForPerson, enqueueWhisper, FULFIL_DEADLINE_TICKS, HEAR_HORIZON_TICKS, HEAR_MIN_DELAY_TICKS, MAX_ACTIVE_WHISPERS, parseWhisperRequest, STALL_CHECKS, stepWhispers, WHISPER_LIFETIME_TICKS } from '../src/world/whispers.js';
import { buildWorldDirectory, encodeChunkMinimapCells, WorldMapCache } from '../src/server/worldmap-service.js';
import type { Tile } from '../src/shared/types.js';
import type { DivineWhisper } from '../src/shared/worldmap.js';

function tile(x: number, y: number, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.5, vegetation: 0.5, food: 0.4, ...overrides };
}

test('Divine Whispers: heard after a deterministic, unpredictable but bounded delay; then fulfilled on arrival', () => {
  const req = parseWhisperRequest({ personId: 'p1', intent: 'travel', x: 30, y: 12, note: 'Mira hacia el valle' });
  assert.equal(req.personId, 'p1');
  assert.throws(() => parseWhisperRequest({ intent: 'bogus', x: 0, y: 0 }));

  const whispers: DivineWhisper[] = [];
  const w = enqueueWhisper(whispers, req, 100, 1, 'Brisa');
  assert.equal(w.status, 'latent');
  const brisa = [{ id: 'p1', name: 'Brisa', x: 0, y: 0, action: 'rest', target: { x: 0, y: 0 }, traits: { curiosity: 0.8 } }];
  // Never heard before HEAR_MIN_DELAY_TICKS: a whisper is not an order.
  for (let t = 100; t < 100 + HEAR_MIN_DELAY_TICKS; t += 10) assert.equal(stepWhispers(whispers, brisa, t, 51926).heard.length, 0);
  let heardTick: number | undefined;
  for (let t = 100 + HEAR_MIN_DELAY_TICKS; t <= 100 + HEAR_HORIZON_TICKS; t += 10) {
    if (stepWhispers(whispers, brisa, t, 51926).heard.length) { heardTick = t; break; }
  }
  assert.ok(heardTick !== undefined, 'heard within the horizon');
  assert.equal(w.status, 'heard');
  assert.equal(activeWhisperForPerson(whispers, 'p1')?.id, w.id);

  // Arriving near the destination fulfills it.
  brisa[0]!.x = 29; brisa[0]!.y = 12;
  const done = stepWhispers(whispers, brisa, heardTick! + 40, 51926);
  assert.equal(done.fulfilled.length, 1);
  assert.equal(w.status, 'fulfilled');
  assert.equal(activeWhisperForPerson(whispers, 'p1'), undefined);
});

test('Divine Whispers: every targeted whisper to a living person is heard by the horizon, at spread-out ticks', () => {
  const people = Array.from({ length: MAX_ACTIVE_WHISPERS }, (_, i) => ({ id: `p${i}`, name: `P${i}`, x: i, y: 0, traits: { curiosity: (i % 10) / 10 } }));
  const whispers: DivineWhisper[] = [];
  for (const p of people) enqueueWhisper(whispers, { personId: p.id, intent: 'explore', x: p.x + 9, y: 3 }, 0, 1, p.name);
  const heardAt = new Map<string, number>();
  for (let t = 0; t <= HEAR_HORIZON_TICKS; t += 10) {
    const live = whispers.filter(w => w.status === 'latent');
    if (!live.length) break;
    for (const { whisper } of stepWhispers(live, people, t, 7).heard) heardAt.set(whisper.id, t);
  }
  assert.equal(heardAt.size, people.length, 'cumulative probability reaches 1 within the horizon');
  const ticks = [...heardAt.values()];
  assert.ok(Math.min(...ticks) >= HEAR_MIN_DELAY_TICKS && Math.max(...ticks) <= HEAR_HORIZON_TICKS);
  assert.ok(new Set(ticks).size >= 8, `the observer cannot predict WHEN (${new Set(ticks).size} distinct ticks)`);
});

test('Divine Whispers: fade only on death, unreachable destination or a long deadline after hearing', () => {
  const at = (x: number, y: number, extra: { action?: string; target?: { x: number; y: number } } = {}) => ({ id: 'p1', name: 'Brisa', x, y, ...extra });
  // Death before hearing.
  let whispers: DivineWhisper[] = [];
  let w = enqueueWhisper(whispers, { personId: 'p1', intent: 'travel', x: 20, y: 0 }, 0, 1, 'Brisa');
  let out = stepWhispers(whispers, [], 30, 1);
  assert.equal(w.status, 'faded'); assert.equal(out.faded[0]!.reason, 'gone');
  // Destination discovered to be water.
  whispers = [];
  w = enqueueWhisper(whispers, { personId: 'p1', intent: 'travel', x: 20, y: 0 }, 0, 1, 'Brisa');
  out = stepWhispers(whispers, [at(0, 0)], 30, 1, (x, y) => x === 20 && y === 0);
  assert.equal(out.faded[0]!.reason, 'unreachable');
  // Pursued without ever getting closer: unreachable after STALL_CHECKS checks; resting does not count.
  whispers = [];
  w = enqueueWhisper(whispers, { personId: 'p1', intent: 'travel', x: 20, y: 0 }, 0, 1, 'Brisa');
  const pursuer = at(0, 0, { action: 'explore', target: { x: 20, y: 0 } });
  let tick = 0;
  while (w.status === 'latent') stepWhispers(whispers, [pursuer], tick += 10, 1);
  pursuer.action = 'rest';
  for (let i = 0; i < STALL_CHECKS + 5; i++) stepWhispers(whispers, [pursuer], tick += 10, 1);
  assert.equal(w.status, 'heard', 'resting is not being stuck');
  pursuer.action = 'explore';
  for (let i = 0; i < STALL_CHECKS && w.status === 'heard'; i++) stepWhispers(whispers, [pursuer], tick += 10, 1);
  assert.equal(w.status, 'faded');
  // Heard but never reached: fades after the deadline counted from hearing, not from creation.
  whispers = [];
  w = enqueueWhisper(whispers, { personId: 'p1', intent: 'travel', x: 20, y: 0 }, 0, 1, 'Brisa');
  tick = 0;
  while (w.status === 'latent') stepWhispers(whispers, [at(0, 0)], tick += 10, 1);
  const heardTick = w.heardTick!;
  stepWhispers(whispers, [at(0, 0)], heardTick + FULFIL_DEADLINE_TICKS - 10, 1);
  assert.equal(w.status, 'heard');
  out = stepWhispers(whispers, [at(0, 0)], heardTick + FULFIL_DEADLINE_TICKS, 1);
  assert.equal(w.status, 'faded'); assert.equal(out.faded[0]!.reason, 'deadline');
  // A regional whisper nobody passes near fades after its lifetime.
  whispers = [];
  w = enqueueWhisper(whispers, { intent: 'explore', x: 500, y: 500 }, 0, 1);
  stepWhispers(whispers, [at(0, 0)], WHISPER_LIFETIME_TICKS, 1);
  assert.equal(w.status, 'faded');
});

test('Divine Whispers: ids stay unique when the retained history drops earlier messages of the same tick', () => {
  const whispers: DivineWhisper[] = [];
  for (let i = 0; i < 40; i++) enqueueWhisper(whispers, { personId: null, intent: 'explore', x: i, y: 0, note: '' }, 500, 1);
  assert.equal(whispers.length, 32);
  assert.equal(new Set(whispers.map(w => w.id)).size, 32, 'no repeated id among the retained messages');
  assert.equal(whispers.at(-1)!.id, 'w-500-40');
  // A later tick starts again at 1; an earlier tick's messages never collide with it.
  assert.equal(enqueueWhisper(whispers, { personId: null, intent: 'explore', x: 0, y: 1, note: '' }, 510, 1).id, 'w-510-1');
});

test('WorldMapCache & encodeChunkMinimapCells: prioritizes settlements/roads/water cleanly in 16 nibbles', () => {
  const tiles: Tile[] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) tiles.push(tile(x, y, { biome: 'forest', wood: 3 }));
  // Top-left 4×4 has a shelter (code 9), top-right has a paved road (code 8), bottom-left has ocean (code 0)
  tiles[0] = tile(0, 0, { terrain: 'shelter' });
  tiles[12] = tile(12, 0, { paved: 1 });
  for (let y = 12; y < 16; y++) for (let x = 0; x < 4; x++) tiles[y * 16 + x] = tile(x, y, { terrain: 'water', biome: 'ocean' });

  const cells = encodeChunkMinimapCells(tiles, 0, 0);
  assert.equal(cells.length, 16);
  assert.equal(cells[0], '9', 'settlement takes priority in 4×4 block');
  assert.equal(cells[3], '8', 'paved road takes priority in 4×4 block');
  assert.equal(cells[12], '0', 'ocean encoded cleanly');
  assert.equal(cells[5], '4', 'forest encoded cleanly');

  const cache = new WorldMapCache();
  const s = cache.setChunk('0,0', 0, 0, tiles, true, 500);
  const map = cache.buildResponse({
    tick: 500, day: 1, discoveredChunks: 1, activeChunks: 1, chunks: [s],
    people: [{ id: 's', name: 'S', role: 'S', x: 2, y: 2 }, { id: 'i', name: 'I', role: 'I', x: 5, y: 5 }],
    animals: [{ id: 'a1', species: 'boar', x: 3, y: 3, action: 'graze', reason: '', hunger: 0.2, thirst: 0.2, energy: 0.8, fatigue: 0.1, health: 1, generation: 2, parents: [], genes: { speed: 0.5, perception: 0.5, metabolism: 0.5, carnivory: 0.1, waterEfficiency: 0.5, camouflage: 0.5 }, age: 200, habituation: 0.7 }],
  });
  assert.equal(map.chunks.length, 1);
  assert.ok(map.markers.some(m => m.kind === 'S') && map.markers.some(m => m.kind === 'I') && map.markers.some(m => m.kind === 'herd'));
});

test('buildWorldDirectory: pins S and I first, counts polyominoes and tame herds globally', () => {
  const dir = buildWorldDirectory({
    tick: 900, day: 2,
    people: [
      { id: 'p9', name: 'Zarza', role: 'neighbor', x: 100, y: -50, color: '#888', action: 'craft', reason: '', energy: 0.8, hunger: 0.2, fatigue: 0.1, need: '', recentMemory: null, craftFocus: 'Fundición', craftTint: '#7a5c44' },
      { id: 'i', name: 'I', role: 'I', x: 2, y: 2, color: '#e27', action: 'rest', reason: '', energy: 1, hunger: 0, fatigue: 0, need: '', recentMemory: null },
      { id: 's', name: 'S', role: 'S', x: 1, y: 1, color: '#d94', action: 'explore', reason: '', energy: 1, hunger: 0, fatigue: 0, need: '', recentMemory: null },
    ],
    communities: [{ id: 'c1', name: 'Alba', x: 10, y: 10, color: '#da5', members: [], memberCount: 15, culture: { sharing: 0.5, stewardship: 0.5, openness: 0.5 }, formedAt: 10, cooperation: 20, disputes: 1 }],
    structures: [{ id: 'st1', x: 10, y: 10, blueprintId: 'bp1', name: 'Taller', components: ['frame', 'roof', 'hearth'], condition: 0.9, water: 0, food: 0, uses: 5, builtAt: 10, builderId: 'p9', cells: [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 11, y: 11 }], synergy: { sharedEdges: 2, heated: true, irrigated: false, workshopBonus: 0.3, kilnTier: 2 } }],
    animals: [
      { id: 'a1', species: 'deer', x: 12, y: 12, action: 'graze', reason: '', hunger: 0.2, thirst: 0.2, energy: 0.8, fatigue: 0.1, health: 1, generation: 3, parents: [], genes: { speed: 0.5, perception: 0.5, metabolism: 0.5, carnivory: 0, waterEfficiency: 0.5, camouflage: 0.5 }, age: 200, habituation: 0.8 },
    ],
  });
  assert.deepEqual(dir.people.map(p => p.role), ['S', 'I', 'neighbor']);
  assert.equal(dir.totalPeople, 3);
  assert.equal(dir.totalPolyominoes, 1);
  assert.equal(dir.totalTameAnimals, 1);
  assert.equal(dir.structures[0]?.kilnTier, 2);
  assert.equal(dir.people[2]?.craftFocus, 'Fundición');
});
