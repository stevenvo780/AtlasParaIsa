import test from 'node:test';
import assert from 'node:assert/strict';
import { activeWhisperForPerson, enqueueWhisper, parseWhisperRequest, stepWhispers } from '../src/world/whispers.js';
import { buildWorldDirectory, encodeChunkMinimapCells, WorldMapCache } from '../src/server/worldmap-service.js';
import type { Tile } from '../src/shared/types.js';
import type { DivineWhisper } from '../src/shared/worldmap.js';

function tile(x: number, y: number, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.5, vegetation: 0.5, food: 0.4, ...overrides };
}

test('Divine Whispers: delayed deterministic reception, calm-needs gate, fulfillment and fade', () => {
  const req = parseWhisperRequest({ personId: 'p1', intent: 'travel', x: 30, y: 12, note: 'Mira hacia el valle' });
  assert.equal(req.personId, 'p1');
  assert.throws(() => parseWhisperRequest({ intent: 'bogus', x: 0, y: 0 }));

  const whispers: DivineWhisper[] = [];
  const w = enqueueWhisper(whispers, req, 100, 1, 'Brisa');
  assert.equal(w.status, 'latent');

  const hungry = [{ id: 'p1', name: 'Brisa', x: 0, y: 0, hunger: 0.9, thirst: 0.2, fatigue: 0.1, energy: 0.8, traits: { curiosity: 0.9 } }];
  // Never heard instantly (< 20 ticks) or while starving
  for (let t = 101; t <= 400; t += 10) stepWhispers(whispers, hungry, t, 51926);
  assert.equal(w.status, 'latent', 'starving person does not hear divine whisper');

  // Once calm, deterministically heard on a future tick
  const calm = [{ id: 'p1', name: 'Brisa', x: 0, y: 0, hunger: 0.2, thirst: 0.1, fatigue: 0.1, energy: 0.9, traits: { curiosity: 0.8 } }];
  let heardTick: number | undefined;
  for (let t = 410; t <= 2000; t += 10) {
    const out = stepWhispers(whispers, calm, t, 51926);
    if (out.heard.length) { heardTick = t; break; }
  }
  assert.ok(heardTick !== undefined && heardTick > 400, 'calm person eventually hears the whisper asynchronously');
  assert.equal(w.status, 'heard');
  assert.equal(activeWhisperForPerson(whispers, 'p1')?.id, w.id);

  // Arriving near destination fulfills the whisper
  calm[0]!.x = 29; calm[0]!.y = 12;
  const done = stepWhispers(whispers, calm, heardTick! + 40, 51926);
  assert.equal(done.fulfilled.length, 1);
  assert.equal(w.status, 'fulfilled');
  assert.equal(activeWhisperForPerson(whispers, 'p1'), undefined);
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
