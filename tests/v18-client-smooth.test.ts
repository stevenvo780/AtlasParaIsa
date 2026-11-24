import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtmosphereSmoother, CadenceEstimator, MotionTracker, PlaybackBuffer, daylightAt, glideEase, parseRgb, MOTION_LIMITS, CADENCE_LIMITS, PLAYBACK_LIMITS } from '../src/client/visual-state.js';
import { ClientTileCache } from '../src/client/tile-cache.js';
import type { Tile } from '../src/shared/types.js';

/** Alimenta el estimador con `count` pasos del servidor separados `gapMs` y devuelve la serie de medias. */
function feed(estimator: CadenceEstimator, state: { sequence: number; tick: number; at: number }, count: number, gapMs: number): number[] {
  const series: number[] = [];
  for (let i = 0; i < count; i++) {
    state.sequence++; state.tick++; state.at += gapMs;
    estimator.observe(state.sequence, state.tick, state.at);
    series.push(estimator.tickIntervalMs);
  }
  return series;
}

test('cadence EMA adapts smoothly from 150 ms to 1500 ms without spikes and ignores same-sequence viewport echoes', () => {
  const estimator = new CadenceEstimator();
  assert.equal(estimator.tickIntervalMs, CADENCE_LIMITS.initialMs);
  const state = { sequence: 100, tick: 1000, at: 0 };
  estimator.observe(state.sequence, state.tick, state.at);
  const fast = feed(estimator, state, 12, 150);
  assert.ok(Math.abs(fast.at(-1)! - 150) < 8, `settles near 150 ms (${fast.at(-1)})`);
  // Los ecos de cámara (misma secuencia, llegan al instante) no son pasos del servidor.
  const before = estimator.tickIntervalMs;
  for (const delay of [5, 20, 60]) assert.equal(estimator.observe(state.sequence, state.tick, state.at + delay), false);
  assert.equal(estimator.tickIntervalMs, before);
  // Un único paso lento (guardado) no mueve la media: el siguiente vuelve al ritmo normal.
  const lone = feed(estimator, state, 1, 3000);
  assert.ok(lone[0]! < 200, `a lone slow tick is rejected by the median (${lone[0]})`);
  feed(estimator, state, 3, 150);
  // Cambio sostenido a 1500 ms: sube sin saltos bruscos ni sobreimpulso.
  let previous: number = estimator.tickIntervalMs;
  const slow = feed(estimator, state, 14, 1500);
  for (const value of slow) {
    assert.ok(value >= previous - 1, 'never dips (beyond sub-ms settling) while the cadence rises');
    assert.ok(value <= 1500 + 1e-6, 'never overshoots the new cadence');
    assert.ok(value - previous <= 1500 * .6 + 1e-6, 'no single step jumps the whole way');
    previous = value;
  }
  assert.ok(Math.abs(slow.at(-1)! - 1500) < 80, `settles near 1500 ms (${slow.at(-1)})`);
  assert.ok(estimator.moveDurationMs >= MOTION_LIMITS.minMs && estimator.moveDurationMs <= MOTION_LIMITS.maxMs);
  assert.equal(estimator.moveDurationMs, MOTION_LIMITS.maxMs, '5,2 × 1500 ms is capped at 2600 ms');
});

test('cadence normalises skipped ticks, clamps, and re-bases on a backwards sequence', () => {
  const estimator = new CadenceEstimator();
  estimator.observe(1, 100, 0);
  // Observer mode: one update every 5 s that carries 20 ticks is still 250 ms per tick.
  for (let i = 1; i <= 8; i++) estimator.observe(1 + i, 100 + 20 * i, 5000 * i);
  assert.ok(Math.abs(estimator.tickIntervalMs - 250) < 5, String(estimator.tickIntervalMs));
  const settled = estimator.tickIntervalMs;
  // Pausa: nueva secuencia al mismo tick no cuenta como paso.
  assert.equal(estimator.observe(50, 260, 50_000), true);
  assert.equal(estimator.tickIntervalMs, settled);
  // Reconexión con la secuencia atrás: se vuelve a empezar sin muestrear.
  assert.equal(estimator.observe(3, 20, 60_000), true);
  assert.equal(estimator.tickIntervalMs, settled);
  assert.equal(estimator.observe(Number.NaN, 1, 1), false);
  const low = new CadenceEstimator(); low.observe(1, 1, 0); for (let i = 2; i < 12; i++) low.observe(i, i, i * 1);
  assert.ok(low.tickIntervalMs >= CADENCE_LIMITS.minMs && low.tickIntervalMs < 103, `converges to the 100 ms floor, never below (${low.tickIntervalMs})`);
  const high = new CadenceEstimator(); high.observe(1, 1, 0); for (let i = 2; i < 14; i++) high.observe(i, i, i * 60_000);
  assert.ok(high.tickIntervalMs <= CADENCE_LIMITS.maxMs && high.tickIntervalMs > 3400, `converges to the 3500 ms ceiling, never above (${high.tickIntervalMs})`);
});

const fixedCadence = (ms: number): CadenceEstimator => {
  const estimator = new CadenceEstimator(); estimator.tickIntervalMs = ms; return estimator;
};

for (const kind of ['person', 'animal'] as const) {
  test(`${kind}: glides smoothly mid-stride, retargets from where it is seen, snaps beyond 6 tiles and stops on arrival`, () => {
    const cadence = fixedCadence(500); // 5,2 × 500 = 2600 ms
    const motion = new MotionTracker(cadence);
    const id = kind === 'person' ? 'p-1' : 'a-1';
    motion.ingest([{ id, x: 10, y: 10 }], 0);
    assert.deepEqual([motion.sample(id, 0)!.x, motion.sample(id, 0)!.y], [10, 10], 'a new body is placed, not flown in');
    assert.equal(motion.sample(id, 0)!.moving, false);

    // One tile east: no jump on arrival of the update; it glides over moveDurationMs.
    motion.ingest([{ id, x: 11, y: 10 }], 1000);
    assert.equal(cadence.moveDurationMs, 2600);
    const start = motion.sample(id, 1000)!.x;
    assert.equal(start, 10, 'starts exactly where it was');
    const xs: number[] = [];
    for (let t = 1000; t <= 3600; t += 100) xs.push(motion.sample(id, t)!.x);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! >= xs[i - 1]!, 'monotonic toward the target');
    assert.ok(xs.every(x => x >= 10 && x <= 11));
    const mid = motion.sample(id, 2300)!;
    assert.ok(mid.x > 10.3 && mid.x < 10.7, `mid-stride is mid-way (${mid.x})`);
    assert.ok(mid.moving && mid.speed > .9, 'full visual speed mid-glide');
    assert.ok(motion.sample(id, 1000)!.speed > 0 && motion.sample(id, 1000)!.speed < 1, 'it never starts from a dead stop to a jerk');
    assert.ok(motion.sample(id, 2300)!.dirX > .9 && motion.sample(id, 2300)!.left === false, 'faces east');
    assert.ok(Math.abs(motion.sample(id, 2300)!.stride - mid.x + 10) < 1e-9, 'stride odometer follows the distance walked');

    // Retarget mid-glide: continues from the visible position, never snaps backward.
    const seen = motion.sample(id, 2300)!.x;
    motion.ingest([{ id, x: 11, y: 11 }], 2300);
    assert.ok(Math.abs(motion.sample(id, 2300)!.x - seen) < 1e-9, 'no teleport at the instant of retarget');
    let lastX = seen;
    for (let t = 2300; t <= 5000; t += 50) {
      const view = motion.sample(id, t)!;
      assert.ok(view.x >= lastX - 1e-9, 'x never moves backward when only y was retargeted');
      assert.ok(Math.abs(view.x - lastX) < .08, 'no jump between frames');
      lastX = view.x;
    }

    // Arrival: exact target, zero speed, not moving.
    const arrived = motion.sample(id, 9000)!;
    assert.deepEqual([arrived.x, arrived.y, arrived.speed, arrived.moving], [11, 11, 0, false]);
    const odometer = arrived.stride;
    assert.ok(odometer > 1 && odometer < 2.5, `odometer is path length, not teleport (${odometer})`);

    // Teleport guard: more than 6 tiles snaps with no cross-map flight.
    motion.ingest([{ id, x: 40, y: 11 }], 10_000);
    const snapped = motion.sample(id, 10_000)!;
    assert.deepEqual([snapped.x, snapped.y, snapped.moving, snapped.speed], [40, 11, false, 0]);
    assert.equal(snapped.stride, odometer, 'a snap walks no distance');
    // Exactly 6 tiles still glides.
    motion.ingest([{ id, x: 46, y: 11 }], 11_000);
    assert.equal(motion.sample(id, 11_000)!.x, 40);
    assert.ok(motion.sample(id, 11_500)!.x > 40 && motion.sample(id, 11_500)!.x < 46);

    // Westward walk flips facing and keeps it while standing.
    motion.ingest([{ id, x: 45, y: 11 }], 20_000);
    assert.equal(motion.sample(id, 21_000)!.left, true);
    assert.equal(motion.sample(id, 30_000)!.left, true, 'facing persists at rest');

    // A body that leaves the window is forgotten; coming back is a new placement.
    motion.ingest([], 31_000); assert.equal(motion.size, 0);
    motion.ingest([{ id, x: 100, y: 100 }], 32_000);
    assert.equal(motion.sample(id, 32_000)!.x, 100);
  });
}

test('bodies that move every server step glide at their own faster pace instead of lagging the truth', () => {
  const motion = new MotionTracker(fixedCadence(500));
  motion.ingest([{ id: 'd', x: 0, y: 0 }], 0);
  motion.ingest([{ id: 'd', x: 1, y: 0 }], 1000);
  motion.ingest([{ id: 'd', x: 2, y: 0 }], 1500); // directed: one tile per 500 ms step
  // 500 ms later (before the next update) it should already be at, or very near, x = 2 rather than crawling for 2.6 s.
  const view = motion.sample('d', 1990)!;
  assert.ok(view.x > 1.7, `keeps up with a directed body (${view.x})`);
  assert.ok(view.x <= 2);
  assert.equal(motion.sample('missing', 0), undefined);
});

test('glide curve is monotonic from 0 to 1 and never stalls at the ends', () => {
  let last = -1;
  for (let k = 0; k <= 1.0001; k += .05) { const e = glideEase(k); assert.ok(e >= last); last = e; }
  assert.equal(glideEase(0), 0); assert.equal(glideEase(1), 1); assert.equal(glideEase(5), 1); assert.equal(glideEase(-3), 0);
  assert.ok(glideEase(.05) > .025, 'starts moving immediately');
});

test('daylight and rain ease toward the received phase over ~1.5 s instead of snapping', () => {
  const smoother = new AtmosphereSmoother();
  const night = daylightAt(2000), day = daylightAt(800);
  const first = smoother.step(night, false, 0);
  assert.equal(first.color, night.color, 'the very first sample is placed, not faded in');
  assert.equal(first.alpha, night.alpha); assert.equal(first.rain, 0);

  const [dr, dg, db] = parseRgb(day.color), [nr, ng, nb] = parseRgb(night.color);
  assert.ok(dr !== nr && dg !== ng && db !== nb);
  smoother.step(day, true, 0); // same instant: nothing moves yet
  const quarter = smoother.step(day, true, 375);
  assert.ok(quarter.alpha < night.alpha && quarter.alpha > day.alpha, `alpha is mid-way (${quarter.alpha})`);
  assert.ok(quarter.r > nr && quarter.r < dr, 'tint is mid-way');
  assert.ok(quarter.rain > 0 && quarter.rain < 1, 'rain eases in');

  let previous = quarter.alpha;
  for (let t = 450; t <= 3000; t += 75) {
    const value = smoother.step(day, true, t);
    assert.ok(value.alpha <= previous + 1e-9, 'monotonic toward day');
    previous = value.alpha;
  }
  const settled = smoother.step(day, true, 3000);
  assert.ok(Math.abs(settled.alpha - day.alpha) < .01 * Math.abs(night.alpha - day.alpha) + .005);
  assert.ok(settled.rain > .99);
  const at1500 = new AtmosphereSmoother(); at1500.step(night, false, 0);
  const done = at1500.step(day, false, 1500);
  const covered = (night.alpha - done.alpha) / (night.alpha - day.alpha);
  assert.ok(covered > .93 && covered < .97, `≈95 % of the way after 1.5 s (${covered})`);
  // Clearing weather fades out.
  const dry = smoother.step(day, false, 3300);
  assert.ok(dry.rain < 1 && dry.rain > 0);
  smoother.reset();
  assert.equal(smoother.step(night, true, 5000).rain, 1, 'reset places the next sample');
});

const tile = (x: number, y: number, tag = 0): Tile => ({ x, y, terrain: 'meadow', moisture: tag, vegetation: .5, food: 0 });
/** Todas las teselas del trozo (cx, cy) de 16×16. */
const chunkTiles = (cx: number, cy: number, tag = 0): Tile[] => Array.from({ length: 256 }, (_, i) => tile(cx * 16 + (i % 16), cy * 16 + Math.floor(i / 16), tag));

test('ClientTileCache ingests by 16×16 chunk, overwrites with fresher truth and handles negative coordinates', () => {
  const cache = new ClientTileCache();
  assert.equal(cache.maxChunks, 256);
  cache.ingest([tile(0, 0, 1), tile(15, 15, 1), tile(16, 0, 1), tile(-1, -1, 1), tile(-17, 3, 1)], 10);
  assert.equal(cache.chunkCount, 4);
  assert.equal(cache.tileCount, 5);
  assert.equal(cache.peek(15, 15)!.moisture, 1);
  assert.equal(cache.peek(-1, -1)!.moisture, 1);
  assert.equal(cache.peek(5, 5), undefined);
  assert.ok(cache.has(-2, 0) && cache.has(-1, -1) && !cache.has(9, 9));
  const fresher = tile(0, 0, 2);
  cache.ingest([fresher], 11);
  assert.equal(cache.peek(0, 0), fresher, 'the latest server truth wins');
  assert.equal(cache.tileCount, 5, 'overwriting does not grow the cache');
  cache.ingest([], 12);
  assert.equal(cache.tileCount, 5);
  assert.throws(() => new ClientTileCache(0));
});

test('ClientTileCache evicts exactly the least-recently-used chunk beyond maxChunks (default 256 chunks = 65 536 tiles)', () => {
  const small = new ClientTileCache(3);
  small.ingest([tile(0, 0)], 1); small.ingest([tile(16, 0)], 1); small.ingest([tile(32, 0)], 1);
  assert.deepEqual(small.chunkOrder(), ['0:0', '1:0', '2:0']);
  small.ingest([tile(1, 1)], 2); // chunk 0:0 vuelve a ser el más reciente
  assert.deepEqual(small.chunkOrder(), ['1:0', '2:0', '0:0']);
  small.ingest([tile(48, 0)], 3); // expulsa 1:0, no 0:0
  assert.deepEqual(small.chunkOrder(), ['2:0', '0:0', '3:0']);
  assert.equal(small.has(1, 0), false);
  assert.equal(small.tileCount, 4, 'evicted tiles are no longer counted (2 + 1 + 1)');
  small.composeViewport(32, 0, 4, 4); // mirar un trozo lo protege
  small.ingest([tile(64, 0)], 4);
  assert.deepEqual(small.chunkOrder(), ['3:0', '2:0', '4:0']);
  assert.equal(small.has(0, 0), false, 'the unviewed oldest chunk went first');
  assert.equal(small.has(2, 0), true, 'the viewed chunk survived');

  const big = new ClientTileCache();
  for (let i = 0; i < 300; i++) big.ingest(chunkTiles(i, 0), i);
  assert.equal(big.chunkCount, 256);
  assert.equal(big.tileCount, 65_536);
  assert.equal(big.has(43, 0), false); assert.equal(big.has(44, 0), true); assert.equal(big.has(299, 0), true);
  assert.equal(big.chunkOrder()[0], '44:0'); assert.equal(big.chunkOrder().at(-1), '299:0');
});

test('composeViewport merges live and cached tiles instantly with accurate coverage, and clear() empties it', () => {
  const cache = new ClientTileCache();
  const visited = chunkTiles(0, 0, 1); // x 0..15, y 0..15 conocidos
  cache.ingest(visited, 5);

  // Ventana 8×8 totalmente dentro de lo visitado: cobertura 1, mismo orden de filas.
  const inside = cache.composeViewport(4, 4, 8, 8);
  assert.equal(inside.coverage, 1);
  assert.equal(inside.tiles.length, 64);
  assert.deepEqual(inside.tiles.slice(0, 3).map(t => [t.x, t.y]), [[4, 4], [5, 4], [6, 4]]);
  assert.deepEqual(inside.tiles.at(-1) && [inside.tiles.at(-1)!.x, inside.tiles.at(-1)!.y], [11, 11]);

  // Ventana 16×16 que se desplaza 8 a la derecha: mitad conocida.
  const panned = cache.composeViewport(8, 0, 16, 16);
  assert.equal(panned.coverage, .5);
  assert.equal(panned.tiles.length, 128);
  assert.ok(panned.tiles.every(t => t.x >= 8 && t.x < 16 && t.moisture === 1));

  // La verdad fresca manda sobre la caché y aporta teselas que la caché no tiene.
  const live = [tile(8, 0, 9), tile(20, 0, 9), tile(100, 100, 9)]; // la última cae fuera de la ventana
  const merged = cache.composeViewport(8, 0, 16, 16, live);
  assert.equal(merged.tiles.length, 128 + 1);
  assert.equal(merged.coverage, 129 / 256);
  assert.equal(merged.tiles[0], live[0], 'live tile replaces the cached one in place');
  assert.equal(merged.tiles.filter(t => t.moisture === 9).length, 2);

  // Territorio nunca visto: cobertura 0, nada inventado.
  const unknown = cache.composeViewport(500, 500, 10, 10);
  assert.deepEqual([unknown.tiles.length, unknown.coverage], [0, 0]);
  // Sólo teselas en vivo (primera llegada): cobertura parcial exacta.
  assert.equal(cache.composeViewport(500, 500, 10, 10, [tile(500, 500), tile(509, 509)]).coverage, .02);
  assert.deepEqual(cache.composeViewport(0, 0, 0, 5), { tiles: [], coverage: 1 });
  // Coordenadas negativas atraviesan trozos con el mismo criterio.
  cache.ingest([tile(-1, -1, 4), tile(0, -1, 4), tile(-1, 0, 4), tile(0, 0, 4)], 6);
  const across = cache.composeViewport(-1, -1, 2, 2);
  assert.deepEqual(across.tiles.map(t => [t.x, t.y]), [[-1, -1], [0, -1], [-1, 0], [0, 0]]);
  assert.equal(across.coverage, 1);

  cache.clear();
  assert.deepEqual([cache.chunkCount, cache.tileCount], [0, 0]);
  assert.equal(cache.composeViewport(0, 0, 16, 16).coverage, 0);
  assert.equal(cache.peek(0, 0), undefined);
});


/* ------------------------------------------------------------------ */
/* Capa 1.5 — colchón de reproducción                                  */
/* ------------------------------------------------------------------ */

interface TestView { people: { id: string; x: number; y: number }[]; animals: { id: string; x: number; y: number }[]; }
const viewAt = (x: number, extra: Partial<TestView> = {}): TestView => ({ people: [{ id: 'p1', x, y: 0 }], animals: [], ...extra });

/** Simula un cliente: llegadas con los huecos dados (ms) y fotogramas de animación de 16 ms; devuelve las trazas por fotograma. */
function simulate(buffer: PlaybackBuffer<TestView>, gaps: readonly number[], options: { tickMs?: number; onFrame?: (t: number, x: number | undefined) => void } = {}): { t: number; x: number | undefined; lag: number; rate: number }[] {
  const trace: { t: number; x: number | undefined; lag: number; rate: number }[] = [];
  const arrivals: number[] = []; let at = 0;
  for (const gap of gaps) { at += gap; arrivals.push(at); }
  let next = 0, sequence = 1000;
  const end = arrivals.at(-1)! + 100;
  for (let t = 0; t <= end; t += 16) {
    while (next < arrivals.length && arrivals[next]! <= t) { sequence++; buffer.push(viewAt(next), sequence, sequence, arrivals[next]!); next++; }
    buffer.advance(t, options.tickMs ?? 600);
    const body = buffer.resolve('people', 'p1', undefined);
    options.onFrame?.(t, body?.x);
    trace.push({ t, x: body?.x, lag: buffer.lagMs, rate: buffer.rate });
  }
  return trace;
}

test('playback buffer: a 2.4 s Store.save() gap is crossed A→B with monotonic motion and no motionless stall', () => {
  const buffer = new PlaybackBuffer<TestView>();
  // Entrada con colchón por construir (≈ 60 s a ritmo normal) y luego ciclos 600,600,600,2400,600 (jitter asimétrico).
  const cycle = [600, 600, 600, 2400, 600];
  const gaps = [...Array(100).fill(600), ...cycle, ...cycle, ...cycle, ...cycle];
  const trace = simulate(buffer, gaps);
  // El primer pico no estaba previsto (el anillo aún no lo había visto): tras él el colchón es adaptativo.
  const warm = trace.filter(f => f.t > 60_000 + cycle.reduce((a, b) => a + b, 0) && f.x !== undefined);
  assert.ok(warm.length > 600, 'the playhead is inside the buffer for the whole steady-state window');
  let longest = 0, still = 0;
  for (let i = 1; i < warm.length; i++) {
    assert.ok(warm[i]!.x! >= warm[i - 1]!.x! - 1e-9, `never moves backwards (t=${warm[i]!.t})`);
    if (warm[i]!.x! === warm[i - 1]!.x!) { still += 16; longest = Math.max(longest, still); } else still = 0;
  }
  assert.ok(longest <= 48, `no motionless stall in steady state (${longest} ms still)`);
  // El tramo de 2,4 s se recorre repartido: pasos por fotograma pequeños, sin saltos.
  const steps = warm.slice(1).map((f, i) => f.x! - warm[i]!.x!);
  assert.ok(Math.max(...steps) < .1, `no frame jumps a tile (${Math.max(...steps)})`);
  assert.ok(buffer.size <= PLAYBACK_LIMITS.maxFrames);
});

test('playback buffer: rate stays in [0.92, 1.08], ring is bounded, and tab sleep re-syncs cleanly', () => {
  const buffer = new PlaybackBuffer<TestView>();
  const trace = simulate(buffer, [...Array(60).fill(600), ...Array(20).fill(250), ...Array(60).fill(1200)], { tickMs: 700 });
  for (const f of trace) assert.ok(f.rate >= PLAYBACK_LIMITS.rateMin - 1e-9 && f.rate <= PLAYBACK_LIMITS.rateMax + 1e-9, `rate ${f.rate}`);
  assert.ok(buffer.size <= PLAYBACK_LIMITS.maxFrames && buffer.size === PLAYBACK_LIMITS.maxFrames);
  assert.ok(Math.abs(buffer.targetLagMs - buffer.desiredLagMs(700)) < 1);
  // La velocidad por debajo del objetivo frena (0,92×); por encima acelera (1,08×).
  const slowStart = new PlaybackBuffer<TestView>();
  slowStart.push(viewAt(0), 1, 1, 0); slowStart.push(viewAt(1), 2, 2, 100);
  slowStart.playTimeMs = 100;
  for (let t = 0; t < 2000; t += 16) slowStart.advance(t, 700);
  assert.ok(slowStart.rate < .93, `buffer below target slows down (${slowStart.rate})`);
  const fast = new PlaybackBuffer<TestView>();
  for (let i = 0; i < 10; i++) fast.push(viewAt(i), i + 1, i + 1, i * 600);
  fast.playTimeMs = 0;
  for (let t = 0; t < 2000; t += 16) fast.advance(t, 600);
  assert.ok(fast.rate > 1.07, `buffer far above target speeds up (${fast.rate})`);
  // Pestaña dormida: el reloj no salta por el hueco de dt, y un retraso > objetivo + 8 s se recoloca limpio.
  const sleepy = new PlaybackBuffer<TestView>();
  sleepy.push(viewAt(0), 1, 1, 0); sleepy.push(viewAt(1), 2, 2, 600);
  sleepy.advance(0, 700); sleepy.advance(60_000, 700);
  assert.ok(sleepy.playTimeMs <= 600 && sleepy.playTimeMs >= 0, 'a 60 s frame gap moves the clock at most 100 ms');
  sleepy.push(viewAt(2), 3, 3, 70_000);
  sleepy.advance(70_016, 700);
  assert.equal(Math.round(sleepy.playTimeMs), Math.round(70_000 - sleepy.targetLagMs), 'jumps to latest − target');
  assert.ok(sleepy.lagMs <= sleepy.targetLagMs + 1);
});

test('playback buffer: same-sequence viewport echoes replace the frame without advancing time or adding frames', () => {
  const buffer = new PlaybackBuffer<TestView>();
  buffer.push(viewAt(0), 10, 10, 0); buffer.push(viewAt(1), 11, 11, 600);
  buffer.push(viewAt(1, { animals: [{ id: 'a1', x: 3, y: 3 }] }), 11, 11, 640);
  assert.equal(buffer.size, 2);
  assert.equal(buffer.latest!.receivedAt, 600, 'echo keeps the original arrival time');
  assert.equal(buffer.latest!.view.animals.length, 1, 'echo updates the frame view');
  // Reconexión con la secuencia hacia atrás: se empieza de cero.
  buffer.push(viewAt(9), 3, 3, 900);
  assert.equal(buffer.size, 1);
});

test('playback buffer: interpolates A→B exactly, skips teleports, and blends in from MotionTracker', () => {
  const buffer = new PlaybackBuffer<TestView>();
  buffer.push({ people: [{ id: 'p1', x: 0, y: 0 }, { id: 'tp', x: 0, y: 0 }], animals: [{ id: 'a1', x: 10, y: 10 }] }, 1, 1, 0);
  buffer.push({ people: [{ id: 'p1', x: 2, y: 1 }, { id: 'tp', x: 50, y: 0 }, { id: 'new', x: 4, y: 4 }], animals: [{ id: 'a1', x: 10, y: 8 }] }, 2, 2, 1000);
  buffer.playTimeMs = 250; buffer.advance(0, 600); buffer.advance(1000, 600); // dt acotado a 100 ms
  buffer.weight = 1; buffer.playTimeMs = 250; (buffer as unknown as { locate(): void }).locate();
  const person = buffer.resolve('people', 'p1', undefined)!;
  assert.ok(Math.abs(person.x - .5) < 1e-9 && Math.abs(person.y - .25) < 1e-9, `quarter of the way (${person.x},${person.y})`);
  assert.equal(person.moving, true);
  assert.equal(buffer.resolve('people', 'tp', undefined), undefined, 'teleport beyond 6 tiles falls back to MotionTracker');
  assert.equal(buffer.resolve('people', 'new', undefined), undefined, 'a body missing from frame A falls back');
  const animal = buffer.resolve('animals', 'a1', undefined)!;
  assert.ok(Math.abs(animal.y - 9.5) < 1e-9 && animal.left === (bodyLeft('a1')), 'animals interpolate too');
  // Mezcla con el fallback mientras el peso < 1.
  buffer.weight = .5;
  const blended = buffer.resolve('people', 'p1', { x: 2, y: 0, dirX: 0, dirY: 0, speed: 0, moving: false, stride: 7, left: false, seed: 1 })!;
  assert.ok(Math.abs(blended.x - 1.25) < 1e-9 && Math.abs(blended.y - .125) < 1e-9, `half way between tracker and playback (${blended.x},${blended.y})`);
});
function bodyLeft(id: string): boolean { let h = 2166136261; for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0; return ((h & 0xffff) % 2) === 1; }

test('playback buffer: flushToLatest snaps to the newest frame and the controller refills the cushion afterwards', () => {
  const buffer = new PlaybackBuffer<TestView>();
  const trace = simulate(buffer, Array(80).fill(600));
  const lagBefore = buffer.lagMs;
  assert.ok(lagBefore > 1500, `cushion built (${lagBefore})`);
  buffer.flushToLatest();
  assert.equal(buffer.lagMs, 0);
  assert.equal(buffer.weight, 0, 'blend restarts so the tracker position fades into the buffer');
  assert.equal(buffer.resolve('people', 'p1', undefined), undefined, 'weight 0 → draws from the tracker, no pop');
  assert.ok(trace.length > 0);
  // Siguen llegando pasos: sin errores, la velocidad frena a 0,92× y el colchón crece poco a poco.
  let at = 80 * 600, sequence = 2000, previousX = -1;
  for (let step = 0; step < 40; step++) {
    sequence++; buffer.push(viewAt(100 + step), sequence, sequence, at);
    for (let k = 0; k < 37; k++) { buffer.advance(at + k * 16, 600); const body = buffer.resolve('people', 'p1', { x: 99 + step + k / 37, y: 0, dirX: 0, dirY: 0, speed: 0, moving: false, stride: 0, left: false, seed: 0 }); if (body) { assert.ok(body.x >= previousX - 1e-9, 'monotonic after the flush'); previousX = body.x; } }
    at += 600;
  }
  assert.ok(buffer.lagMs > 0 && buffer.lagMs < lagBefore, `cushion refilling gradually (${buffer.lagMs})`);
  assert.ok(buffer.rate >= PLAYBACK_LIMITS.rateMin && buffer.rate <= PLAYBACK_LIMITS.rateMax);
  assert.equal(buffer.weight, 1, 'blend completes');
});
