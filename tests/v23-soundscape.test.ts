import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile, WorldView } from '../src/shared/types.js';
import { analyzeSoundscape, SpatialSoundscape } from '../src/client/soundscape.js';

function makeTile(x: number, y: number, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.5, vegetation: 0.6, food: 0.5, ...overrides };
}

function makeWorld(overrides: Partial<WorldView> = {}): WorldView {
  return {
    version: 10, sequence: 1, tick: 120, day: 1, phase: 'day', weather: 'clear',
    originX: 0, originY: 0, width: 20, height: 20,
    tiles: [], people: [], places: [], events: [], memories: [],
    animals: [], structures: [],
    ...overrides,
  };
}

function mockAudioContext() {
  let oscCount = 0;
  let closed = false;
  let suspended = false;
  const param = () => ({
    value: 0,
    setValueAtTime(v: number) { this.value = v; },
    setTargetAtTime(v: number) { this.value = v; },
    linearRampToValueAtTime(v: number) { this.value = v; },
    exponentialRampToValueAtTime(v: number) { this.value = v; },
  });
  const node = () => ({ connect() {}, disconnect() {} });
  const ctx = {
    currentTime: 1,
    sampleRate: 24000,
    destination: node(),
    async resume() { suspended = false; },
    async suspend() { suspended = true; },
    async close() { closed = true; },
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: 'lowpass', frequency: param(), Q: param() }),
    createStereoPanner: () => ({ ...node(), pan: param() }),
    createBuffer: (_ch: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => ({ ...node(), buffer: null, loop: false, start() {}, stop() {} }),
    createOscillator: () => { oscCount++; return { ...node(), type: 'sine', frequency: param(), start() {}, stop() {} }; },
  };
  return { ctx: ctx as unknown as AudioContext, stats: () => ({ oscCount, closed, suspended }) };
}

test('analyzeSoundscape: responds to water, forest/altitude wind, rain, night, and hearths/kilns', () => {
  const shoreTiles = Array.from({ length: 25 }, (_, i) => makeTile(i % 5, Math.floor(i / 5), { terrain: 'water', biome: 'ocean' }));
  const forestTiles = Array.from({ length: 25 }, (_, i) => makeTile(i % 5, Math.floor(i / 5), { biome: 'forest', wood: 4 }));

  const shore = analyzeSoundscape(makeWorld({ tiles: shoreTiles }), { x: 0, y: 0, width: 5, height: 5, zoom: 28 });
  const forestNear = analyzeSoundscape(makeWorld({ tiles: forestTiles }), { x: 0, y: 0, width: 5, height: 5, zoom: 28 });
  const forestFar = analyzeSoundscape(makeWorld({ tiles: forestTiles }), { x: 0, y: 0, width: 5, height: 5, zoom: 8 });
  assert.ok(shore.water > 0.6 && forestNear.water === 0, 'shore camera hears strong water');
  assert.ok(forestFar.wind > forestNear.wind, 'zoomed-out camera hears stronger altitude wind');

  const stormyNight = analyzeSoundscape(makeWorld({
    phase: 'night', weather: 'rain', tiles: forestTiles,
    structures: [{
      id: 's1', x: 2, y: 2, blueprintId: 'bp1', name: 'Horno', components: ['frame', 'roof', 'hearth'],
      condition: 1, water: 0, food: 0, uses: 5, builtAt: 1, builderId: 'p1',
      synergy: { sharedEdges: 1, heated: true, irrigated: false, workshopBonus: 0.2, kilnTier: 2 },
    }],
  }), { x: 0, y: 0, width: 5, height: 5, zoom: 30 });
  assert.ok(stormyNight.rain > 0.8 && stormyNight.night === 1 && stormyNight.hearth > 0.4);
});

test('analyzeSoundscape: stereo panning places left/right/center entities accurately and attenuates distance', () => {
  const world = makeWorld({
    people: [
      { id: 'left', name: 'L', role: 'neighbor', x: 1, y: 10, color: '#aaa', action: 'build', reason: '', energy: 1, hunger: 0, fatigue: 0, need: '', recentMemory: null },
      { id: 'right', name: 'R', role: 'neighbor', x: 19, y: 10, color: '#aaa', action: 'craft', reason: '', energy: 1, hunger: 0, fatigue: 0, need: '', recentMemory: null },
      { id: 'center', name: 'C', role: 'neighbor', x: 10, y: 10, color: '#aaa', action: 'drink', reason: '', energy: 1, hunger: 0, fatigue: 0, need: '', recentMemory: null },
    ],
  });
  const scene = analyzeSoundscape(world, { x: 0, y: 0, width: 20, height: 20, zoom: 28 });
  const wood = scene.events.find(e => e.kind === 'wood_stone');
  const forge = scene.events.find(e => e.kind === 'forge');
  const drink = scene.events.find(e => e.kind === 'farm_water');
  assert.ok(wood && wood.pan < -0.5, `left builder pans left (${wood?.pan})`);
  assert.ok(forge && forge.pan > 0.5, `right crafter pans right (${forge?.pan})`);
  assert.ok(drink && Math.abs(drink.pan) < 0.15, `center actor pans near center (${drink?.pan})`);
  assert.ok(scene.events.every(e => e.pan >= -0.85 && e.pan <= 0.85 && e.gain >= 0 && e.gain <= 1));
});

test('SpatialSoundscape: lifecycle, throttling, mute/hidden suspension, and defensive fallbacks', async () => {
  const mock = mockAudioContext();
  const sound = new SpatialSoundscape({ createContext: () => mock.ctx, volume: 0.8 });
  assert.equal(sound.active, false);
  assert.equal(await sound.start(), true);
  assert.equal(sound.active, true);

  const world = makeWorld({
    people: [{ id: 'p1', name: 'S', role: 'S', x: 10, y: 10, color: '#fff', action: 'build', reason: '', energy: 1, hunger: 0, fatigue: 0, need: '', recentMemory: null }],
  });
  // Rapid updates within 200 ms are throttled; foley is rate-limited to >= 700 ms
  for (let i = 0; i < 10; i++) sound.update(world, { x: 0, y: 0, width: 20, height: 20, zoom: 26 }, 1000 + i * 20);
  const oscAfterBurst = mock.stats().oscCount;
  assert.equal(oscAfterBurst, 2, '1 continuous night osc + at most 1 foley osc during rapid burst');

  sound.update(world, { x: 0, y: 0, width: 20, height: 20, zoom: 26 }, 2000);
  assert.equal(mock.stats().oscCount, 3, 'foley triggers again after 700 ms cooldown');

  sound.setMuted(true);
  assert.equal(mock.stats().suspended, true);
  sound.update(world, { x: 0, y: 0, width: 20, height: 20, zoom: 26 }, 5000);
  assert.equal(mock.stats().oscCount, 3, 'no foley while muted');

  sound.setMuted(false);
  sound.setHidden(true);
  assert.equal(mock.stats().suspended, true);
  sound.stop();
  sound.stop(); // idempotent
  assert.equal(sound.active, false);
  assert.equal(mock.stats().closed, true);

  // Defensive NaN camera / empty world
  const safe = analyzeSoundscape(makeWorld(), { x: NaN, y: NaN, width: -5, height: 0, zoom: NaN });
  assert.ok(Number.isFinite(safe.wind) && Number.isFinite(safe.water));
});
