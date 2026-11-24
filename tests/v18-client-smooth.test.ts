import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtmosphereSmoother, CadenceEstimator, MotionTracker, PlaybackBuffer, daylightAt, glideEase, parseRgb, MOTION_LIMITS, CADENCE_LIMITS, PLAYBACK_LIMITS } from '../src/client/visual-state.js';
import { ClientTileCache } from '../src/client/tile-cache.js';
import type { Tile } from '../src/shared/types.js';
import type { StructureView } from '../src/shared/life.js';
import { cropSignature, cropStage, cropWorkMode, drawCropWork, paintCropField } from '../src/client/crop-art.js';
import { footprintBox, footprintLabel, isModular, paintCompactAccessories, paintConstructionSite, paintModularHall, siteFractions, stockLevel, structureExtent, structureTier, type ExtendedStructure } from '../src/client/structure-art.js';
import { structureCard } from '../src/client/inspector-view.js';

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

interface Frame { t: number; x: number | undefined; lag: number; rate: number }
/**
 * Simula un cliente completo: llegadas con los huecos dados (ms), fotogramas de animación de 16 ms, el colchón liberando
 * fotogramas y `MotionTracker` alimentado con ellos (lo mismo que hace `Landscape.frame`). `xOf(n)` da la casilla del
 * servidor en la llegada n.
 */
function simulate(buffer: PlaybackBuffer<TestView>, gaps: readonly number[], options: { tickMs?: number; xOf?: (n: number) => number } = {}): Frame[] {
  const tickMs = options.tickMs ?? 600, xOf = options.xOf ?? (n => n);
  const motion = new MotionTracker(fixedCadence(tickMs));
  const trace: Frame[] = [];
  const arrivals: number[] = []; let at = 0;
  for (const gap of gaps) { at += gap; arrivals.push(at); }
  let next = 0, sequence = 1000;
  const end = arrivals.at(-1)! + 100;
  for (let t = 0; t <= end; t += 16) {
    while (next < arrivals.length && arrivals[next]! <= t) { sequence++; buffer.push(viewAt(xOf(next)), sequence, sequence, arrivals[next]!); next++; }
    buffer.advance(t, tickMs);
    for (const frame of buffer.takeReleased()) motion.ingest(frame.view.people, buffer.visualMs);
    trace.push({ t, x: motion.sample('p1', buffer.visualMs)?.x, lag: buffer.lagMs, rate: buffer.rate });
  }
  return trace;
}

/** Quien se mueve una casilla cada 6 pasos (cada 3,6 s con pasos de 600 ms). */
const everySixth = (n: number): number => Math.floor(n / 6);

test('playback buffer → MotionTracker: a 1-tile move every 6 ticks glides over ≈ 5,2 ticks, not a 0,6 s dash and a 3 s freeze, across 2.4 s save spikes', () => {
  const buffer = new PlaybackBuffer<TestView>();
  // El primer pico nadie lo espera (se mide después); los siguientes sí. 60 s de entrada a ritmo normal (el colchón se va llenando) y luego un guardado de 2,4 s cada 100 pasos (el ±8 % repone ≈ 1,9 s por cada 24 s de calma).
  const cycle = [...Array(99).fill(600), 2400];
  const gaps = [...Array(100).fill(600), ...cycle, ...cycle, ...cycle, ...cycle];
  const trace = simulate(buffer, gaps, { xOf: everySixth });
  const warm = trace.filter(f => f.t > 70_000 + cycle.reduce((a, b) => a + b, 0) && f.x !== undefined);
  assert.ok(warm.length > 8000, 'the tracker has a track for the whole steady-state window');
  const steps = warm.slice(1).map((f, i) => f.x! - warm[i]!.x!);
  for (const step of steps) assert.ok(step >= -1e-9, 'never moves backwards');
  assert.ok(Math.max(...steps) < .012, `no dash: the biggest per-frame step is tiny (${Math.max(...steps)}); a 0,6 s dash would be ≈ .027`);
  let longest = 0, still = 0, moving = 0;
  for (const step of steps) { if (step < 1e-6) { still += 16; longest = Math.max(longest, still); } else { still = 0; moving++; } }
  assert.ok(longest <= 1300, `no 3 s freeze between tiles (${longest} ms still)`);
  assert.ok(moving * 16 / (steps.length * 16) > .6, `it walks most of the time (${(moving / steps.length).toFixed(2)})`);
  assert.ok(buffer.size <= PLAYBACK_LIMITS.maxFrames);

  // Referencia: la interpolación A→B entre fotogramas contiguos (lo que había) sí hace «carrera + parada».
  const naive: number[] = [];
  const xs = [...Array(300).keys()].map(everySixth);
  for (let t = 0; t < 299 * 600; t += 16) { const k = Math.floor(t / 600), a = t / 600 - k; naive.push(xs[k]! + (xs[k + 1]! - xs[k]!) * a); }
  let naiveStill = 0, naiveLongest = 0;
  for (let i = 1; i < naive.length; i++) { if (naive[i]! === naive[i - 1]!) { naiveStill += 16; naiveLongest = Math.max(naiveLongest, naiveStill); } else naiveStill = 0; }
  assert.ok(naiveLongest >= 2900, `the old A→B scheme froze for ${naiveLongest} ms`);
});

test('playback buffer: a body that moves every server step glides smoothly through a 2.4 s spike with no stall in steady state', () => {
  const buffer = new PlaybackBuffer<TestView>();
  const cycle = [...Array(99).fill(600), 2400];
  const trace = simulate(buffer, [...Array(100).fill(600), ...cycle, ...cycle, ...cycle, ...cycle]);
  const warm = trace.filter(f => f.t > 70_000 + cycle.reduce((a, b) => a + b, 0) && f.x !== undefined);
  assert.ok(warm.length > 8000);
  let longest = 0, still = 0;
  for (let i = 1; i < warm.length; i++) {
    assert.ok(warm[i]!.x! >= warm[i - 1]!.x! - 1e-9, `never moves backwards (t=${warm[i]!.t})`);
    if (warm[i]!.x! === warm[i - 1]!.x!) { still += 16; longest = Math.max(longest, still); } else still = 0;
  }
  assert.ok(longest <= 112, `no stall beyond the natural ≈ 80 ms rest between 1-tile steps (${longest} ms still)`);
  const steps = warm.slice(1).map((f, i) => f.x! - warm[i]!.x!);
  assert.ok(Math.max(...steps) < .1, `no frame jumps a tile (${Math.max(...steps)})`);
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
  slowStart.playTick = 2;
  for (let t = 0; t < 2000; t += 16) slowStart.advance(t, 700);
  assert.ok(slowStart.rate < .93, `buffer below target slows down (${slowStart.rate})`);
  const fast = new PlaybackBuffer<TestView>();
  for (let i = 0; i < 10; i++) fast.push(viewAt(i), i + 1, i + 1, i * 600);
  fast.playTick = 1;
  for (let t = 0; t < 2000; t += 16) fast.advance(t, 600);
  assert.ok(fast.rate > 1.07, `buffer far above target speeds up (${fast.rate})`);
  // Pestaña dormida: el reloj no salta por el hueco de dt, y un retraso > objetivo + 8 s se recoloca limpio.
  const sleepy = new PlaybackBuffer<TestView>();
  sleepy.push(viewAt(0), 1, 1, 0); sleepy.push(viewAt(1), 2, 2, 600);
  sleepy.advance(0, 700); sleepy.advance(60_000, 700);
  assert.ok(sleepy.playTick <= 2 && sleepy.playTick >= 1, 'a 60 s frame gap moves the clock at most 100 ms');
  assert.ok(sleepy.visualMs <= 108, 'and the sampling clock too');
  sleepy.push(viewAt(2), 3, 100, 70_000); // tras dormir, el servidor va 97 pasos más allá
  sleepy.advance(70_016, 700);
  assert.ok(Math.abs(sleepy.playTick - (100 - sleepy.targetLagMs / 700)) < .05, 'jumps to latest − target');
  assert.ok(Math.abs(sleepy.lagMs - sleepy.targetLagMs) < 40);
  assert.equal(sleepy.takeReleased().length, 1, 'a re-sync releases only the newest frame');
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

test('playback buffer: frames are released once, in order, only when the delayed playhead crosses them', () => {
  const buffer = new PlaybackBuffer<TestView>();
  for (let i = 0; i < 6; i++) buffer.push(viewAt(i), i + 1, i + 1, i * 600);
  buffer.advance(0, 600);
  assert.deepEqual(buffer.takeReleased().map(f => f.sequence), [1], 'the oldest frame is released first');
  assert.deepEqual(buffer.takeReleased(), [], 'nothing is released twice');
  buffer.playTick = 3; buffer.advance(16, 600); // cruza los ticks 2 y 3
  assert.deepEqual(buffer.takeReleased().map(f => f.sequence), [2, 3]);
  // Un eco de cámara de un fotograma aún sin liberar cambia la vista que se liberará.
  const echo = viewAt(99);
  buffer.push(echo, 5, 5, 700);
  buffer.playTick = 5; buffer.advance(32, 600);
  const next = buffer.takeReleased();
  assert.deepEqual(next.map(f => f.sequence), [4, 5]);
  assert.equal(next[1]!.view, echo);
});

test('playback buffer: flushToLatest releases only the newest frame, the sampling clock never jumps, and the cushion refills afterwards', () => {
  const buffer = new PlaybackBuffer<TestView>();
  const trace = simulate(buffer, Array(80).fill(600));
  const lagBefore = buffer.lagMs;
  assert.ok(lagBefore > 1500, `cushion built (${lagBefore})`);
  assert.ok(trace.length > 0);
  const visualBefore = buffer.visualMs;
  buffer.flushToLatest();
  assert.equal(buffer.lagMs, 0);
  assert.equal(buffer.visualMs, visualBefore, 'flushing moves the playhead, not the sampling clock');
  const released = buffer.takeReleased();
  assert.equal(released.length, 1, 'MotionTracker re-targets once, from where the body is seen');
  assert.equal(released[0], buffer.latest);
  // Siguen llegando pasos: sin errores, la velocidad frena a 0,92× y el colchón crece poco a poco, con el cuerpo sin retroceder.
  const motion = new MotionTracker(fixedCadence(600));
  motion.ingest(released[0]!.view.people, buffer.visualMs);
  let at = 80 * 600, sequence = 2000, previousX = motion.sample('p1', buffer.visualMs)!.x;
  for (let step = 0; step < 40; step++) {
    sequence++; buffer.push(viewAt(100 + step), sequence, sequence, at);
    for (let k = 0; k < 37; k++) {
      buffer.advance(at + k * 16, 600);
      for (const frame of buffer.takeReleased()) motion.ingest(frame.view.people, buffer.visualMs);
      const x = motion.sample('p1', buffer.visualMs)!.x;
      assert.ok(x >= previousX - 1e-9, 'monotonic after the flush'); previousX = x;
    }
    at += 600;
  }
  assert.ok(buffer.lagMs > 0 && buffer.lagMs < lagBefore, `cushion refilling gradually (${buffer.lagMs})`);
  assert.ok(buffer.rate >= PLAYBACK_LIMITS.rateMin && buffer.rate <= PLAYBACK_LIMITS.rateMax);
});

test('daylight follows the delayed stream: the shown tick is the A→B tick at the playhead, and AtmosphereSmoother eases toward it', () => {
  const buffer = new PlaybackBuffer<TestView>();
  assert.equal(buffer.shownTick(777), 777, 'no cushion yet → the latest tick');
  buffer.push(viewAt(0), 1, 1000, 0); buffer.push(viewAt(1), 2, 1010, 1000); buffer.push(viewAt(2), 3, 1020, 2000);
  buffer.playTick = 1015; (buffer as unknown as { locate(): void }).locate();
  assert.equal(buffer.shownTick(1020), 1015, 'halfway between the bracketing ticks, behind the newest');
  const smoother = new AtmosphereSmoother();
  const lagged = smoother.step(daylightAt(buffer.shownTick(1020)), false, 0);
  const newest = daylightAt(1020);
  assert.equal(lagged.color, daylightAt(1015).color);
  const later = smoother.step(daylightAt(buffer.shownTick(1020) + 1), false, 16);
  assert.ok(Math.abs(later.alpha - lagged.alpha) < .01, 'no snap toward the newest tick');
  assert.ok(newest.alpha !== undefined);
});

/* ------------------------------------------------------------------ */
/* V19 — ciclo de cultivo, labores y arquitectura modular              */
/* ------------------------------------------------------------------ */

/** Contexto 2D mínimo que registra los rectángulos pintados. */
function recorder(): { g: CanvasRenderingContext2D; rects: { x: number; y: number; w: number; h: number; color: string }[] } {
  const rects: { x: number; y: number; w: number; h: number; color: string }[] = [];
  const state = { fillStyle: '' };
  const g = { get fillStyle() { return state.fillStyle; }, set fillStyle(v: string) { state.fillStyle = v; }, fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, color: state.fillStyle }); } };
  return { g: g as unknown as CanvasRenderingContext2D, rects };
}
const crop = (extra: Partial<Tile> = {}): Tile => ({ x: 4, y: 5, terrain: 'meadow', moisture: .3, vegetation: .5, food: 0, cultivation: .6, ...extra });

test('crop stages follow real tile fields: plowed → sprouting → leafy → ripe, and uncultivated tiles have none', () => {
  assert.equal(cropStage(crop({ cultivation: 0 })), null);
  assert.equal(cropStage(crop({ cultivation: .05 })), null, 'at the threshold it is still not a field');
  assert.equal(cropStage(crop({ cultivation: undefined })), null);
  assert.equal(cropStage(crop({ food: .02, growth: .1, vegetation: .9 })), 0, 'freshly plowed: little food and low growth');
  assert.equal(cropStage(crop({ food: .02, growth: .25 })), 1, 'growth alone starts the sprouts');
  assert.equal(cropStage(crop({ food: .02, growth: undefined, vegetation: .3 })), 1, 'growth falls back to vegetation');
  assert.equal(cropStage(crop({ food: .06, growth: 0 })), 1);
  assert.equal(cropStage(crop({ food: .139, growth: 0 })), 1);
  assert.equal(cropStage(crop({ food: .14, growth: 0 })), 2);
  assert.equal(cropStage(crop({ food: .259 })), 2);
  assert.equal(cropStage(crop({ food: .26 })), 3);
  assert.equal(cropStage(crop({ food: 1 })), 3);
  // La firma del trozo solo cambia al cruzar un umbral visual (no con cada décima de alimento).
  assert.equal(cropSignature(crop({ cultivation: 0 })), 0);
  assert.equal(cropSignature(crop({ food: .27 })), cropSignature(crop({ food: .9 })), 'ripe stays ripe');
  assert.notEqual(cropSignature(crop({ food: .13, growth: 0 })), cropSignature(crop({ food: .15, growth: 0 })));
  assert.equal(cropSignature(crop({ food: .141, growth: 0 })), cropSignature(crop({ food: .2, growth: 0 })));
  assert.notEqual(cropSignature(crop({ food: 0, growth: 0, moisture: .3 })), cropSignature(crop({ food: 0, growth: 0, moisture: .6 })), 'moist sheen on fresh furrows');
  assert.equal(cropSignature(crop({ food: .5, moisture: .3 })), cropSignature(crop({ food: .5, moisture: .6 })), 'sheen only on the plowed stage');
});

test('crop fields paint each stage with its own palette inside the tile and continue furrows across neighbours', () => {
  const colors = new Map<number, Set<string>>();
  for (const stage of [0, 1, 2, 3] as const) {
    const { g, rects } = recorder();
    paintCropField(g, crop({ moisture: .6 }), stage, 16, false, false);
    assert.ok(rects.length > 6, `stage ${stage} paints`);
    for (const r of rects) assert.ok(r.x >= 4 * 16 && r.x + r.w <= 5 * 16 && r.y >= 5 * 16 - 0 && r.y + r.h <= 6 * 16, `stage ${stage} stays inside its tile (${r.x},${r.y},${r.w},${r.h})`);
    colors.set(stage, new Set(rects.map(r => r.color)));
  }
  assert.ok([...colors.get(0)!].some(c => c.startsWith('rgba(190')), 'moist plowed earth shines');
  assert.ok(colors.get(1)!.has('#9be04a'), 'sprouts are chartreuse');
  assert.ok(colors.get(2)!.has('#3f8a4e') || colors.get(2)!.has('#6f8f3a'), 'growing crops are emerald/olive');
  assert.ok(colors.get(3)!.has('#e8b83a') || colors.get(3)!.has('#c98a1e'), 'ripe crops are golden-amber');
  assert.ok(!colors.get(0)!.has('#e8b83a'));
  const alone = recorder(), joined = recorder();
  paintCropField(alone.g, crop(), 2, 16, false, false); paintCropField(joined.g, crop(), 2, 16, true, true);
  assert.ok(Math.min(...joined.rects.map(r => r.x)) < Math.min(...alone.rects.map(r => r.x)), 'neighbouring plots share furrows with no border');
});

test('agricultural work: hoe while farming on site, sickle + sheaf when foraging or eating from a field, none while walking', () => {
  const ripe = crop({ food: .5 });
  assert.equal(cropWorkMode('farm', true, false, undefined), 'till', 'plowing needs no crop yet');
  assert.equal(cropWorkMode('farm', false, false, ripe), null, 'farm but not working yet');
  assert.equal(cropWorkMode('farm', true, true, ripe), null, 'walking');
  assert.equal(cropWorkMode('forage', false, false, ripe), 'harvest');
  assert.equal(cropWorkMode('eat', false, false, ripe), 'eat');
  assert.equal(cropWorkMode('forage', true, false, crop({ cultivation: 0 })), null, 'wild forage keeps its own art');
  assert.equal(cropWorkMode('forage', true, false, undefined), null);
  assert.equal(cropWorkMode('rest', true, false, ripe), null);
  const frames = new Set<string>();
  for (let t = 0; t < 1; t += .1) {
    const { g, rects } = recorder();
    drawCropWork(g, { mode: 'till', ax: 40, baseY: 60, t, seed: 3, animate: true, workProgress: .5, ring: true });
    frames.add(JSON.stringify(rects));
    assert.ok(rects.some(r => r.color === 'rgba(217,146,46,.9)'), 'progress ring shows the filled arc');
  }
  assert.ok(frames.size >= 4, `the swing animates (${frames.size} distinct frames)`);
  const still = recorder(), still2 = recorder();
  drawCropWork(still.g, { mode: 'till', ax: 40, baseY: 60, t: 0, seed: 3, animate: false, ring: false });
  drawCropWork(still2.g, { mode: 'till', ax: 40, baseY: 60, t: .7, seed: 3, animate: false, ring: false });
  assert.deepEqual(still.rects, still2.rects, 'reduced motion = one fixed frame');
  const harvest = recorder(); drawCropWork(harvest.g, { mode: 'harvest', ax: 40, baseY: 60, t: .4, seed: 1, animate: true, ring: false });
  assert.ok(harvest.rects.some(r => r.color === '#e8b83a'), 'golden grain / sheaf');
  const eat = recorder(); drawCropWork(eat.g, { mode: 'eat', ax: 40, baseY: 60, t: .4, seed: 1, animate: true, ring: false });
  assert.ok(eat.rects.length > 8);
});

const structure = (extra: Record<string, unknown> = {}): StructureView => ({ id: 's1', x: 10, y: 20, blueprintId: 'b', name: 'Obra', components: ['frame', 'roof'], condition: .9, water: .3, food: .2, uses: 0, builtAt: 1, builderId: null, ...extra }) as StructureView;

test('structure helpers: footprint box and label, tiers, site fractions and logarithmic stock levels', () => {
  assert.deepEqual(footprintBox(structure() as ExtendedStructure), { x0: 10, y0: 20, w: 1, h: 1 });
  const hall = structure({ footprint: [{ x: 10, y: 20 }, { x: 11, y: 20 }] }) as ExtendedStructure;
  assert.deepEqual(footprintBox(hall), { x0: 10, y0: 20, w: 2, h: 1 });
  assert.equal(footprintLabel(hall), '2×1');
  assert.equal(footprintLabel(structure({ footprint: [{ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 3, y: 5 }, { x: 4, y: 5 }] }) as ExtendedStructure), '2×2');
  assert.equal(footprintLabel(structure() as ExtendedStructure), '');
  assert.equal(structureTier(structure({ components: ['frame', 'frame'] }) as ExtendedStructure), 'hut');
  assert.equal(structureTier(structure({ components: ['frame', 'frame', 'frame'] }) as ExtendedStructure), 'hall');
  assert.equal(structureTier(structure({ components: ['frame', 'frame', 'frame', 'frame', 'frame'] }) as ExtendedStructure), 'grand');
  assert.equal(structureTier(structure({ footprint: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }) as ExtendedStructure), 'grand', 'the real footprint wins over frames');
  assert.equal(isModular(hall), true); assert.equal(isModular(structure() as ExtendedStructure), false);
  assert.deepEqual(siteFractions({ requiredWood: 4, requiredStone: 0, depositedWood: 1, depositedStone: 0, requiredWork: 10, completedWork: 25 }), { wood: .25, stone: 1, work: 1 });
  assert.deepEqual([undefined, 0, -3, 1, 3, 7, 63, 1e9].map(stockLevel), [0, 0, 0, 1, 2, 3, 6, 6]);
  const extent = structureExtent(hall);
  assert.ok(extent.right - extent.left >= 32 && extent.foot === 20 * 16 + 13 && extent.top < extent.foot);
});

test('modular painters draw construction sites, halls, warehouse stock and installed hardware inside the structure extent', () => {
  const site = structure({ site: { requiredWood: 6, requiredStone: 4, depositedWood: 3, depositedStone: 1, requiredWork: 10, completedWork: 7 } }) as ExtendedStructure;
  const empty = structure({ site: { requiredWood: 6, requiredStone: 4, depositedWood: 0, depositedStone: 0, requiredWork: 10, completedWork: 0 } }) as ExtendedStructure;
  const a = recorder(), b = recorder();
  paintConstructionSite(a.g, site, site.site!, 0, false); paintConstructionSite(b.g, empty, empty.site!, 0, false);
  assert.ok(a.rects.length > b.rects.length, 'more deposited material and work draw more scaffolding, stock and roof');
  assert.ok(a.rects.some(r => r.color === '#d9922e' && r.w >= 7), 'progress bar fill is drawn');
  const base = { footprint: [{ x: 10, y: 20 }, { x: 11, y: 20 }, { x: 10, y: 19 }, { x: 11, y: 19 }], components: ['frame', 'frame', 'frame', 'frame', 'frame', 'roof', 'hearth', 'cistern', 'granary'] };
  const plain = structure(base) as ExtendedStructure;
  const rich = structure({ ...base, storedWood: 20, storedStone: 20, installed: [1, 2, 3, 4].map(i => ({ id: `i${i}`, recipeId: null, mass: 1, containment: 1, insulation: 1, cohesion: 1, binding: 1, condition: 1 })) }) as ExtendedStructure;
  const p = recorder(), r = recorder();
  paintModularHall(p.g, plain, 0, true); paintModularHall(r.g, rich, 0, true);
  assert.ok(p.rects.length > 60, 'a grand hall is a rich composition');
  assert.ok(r.rects.length > p.rects.length + 8, 'stock and installed parts add visible detail');
  assert.ok(r.rects.some(rect => rect.color === '#aeb8bf'), 'steel accents for installed parts');
  assert.ok(r.rects.some(rect => rect.color === '#6b5d41' || rect.color === '#7a5d41'), 'cordwood');
  const ext = structureExtent(rich);
  for (const rect of r.rects) assert.ok(rect.x >= ext.left - 14 && rect.x + rect.w <= ext.right + 14 && rect.y >= ext.top - 12 && rect.y + rect.h <= ext.bottom + 12, `inside extent (${rect.x},${rect.y})`);
  const hallOnly = recorder(); paintModularHall(hallOnly.g, structure({ footprint: [{ x: 10, y: 20 }, { x: 11, y: 20 }], components: ['frame', 'frame', 'frame'] }) as ExtendedStructure, 0, false);
  assert.ok(hallOnly.rects.length > 30 && hallOnly.rects.length < p.rects.length, 'a 2×1 hall is simpler than a 2×2 compound');
  const acc = recorder(); paintCompactAccessories(acc.g, structure({ storedWood: 5, storedStone: 5, installed: [{ id: 'i', recipeId: null, mass: 1, containment: 1, insulation: 1, cohesion: 1, binding: 1, condition: 1 }] }) as ExtendedStructure);
  assert.ok(acc.rects.length > 5);
  const none = recorder(); paintCompactAccessories(none.g, structure() as ExtendedStructure);
  assert.equal(none.rects.length, 0, 'nothing is drawn without stock or installed parts');
});

test('structureCard shows site progress, footprint, warehouse stock and installed parts only when the server sent them', () => {
  const plain = structureCard(structure(), null);
  for (const marker of ['data-structure-site', 'data-structure-footprint', 'data-structure-stock', 'data-structure-installed']) assert.ok(!plain.includes(marker), `no ${marker} without data`);
  const html = structureCard(structure({
    site: { requiredWood: 6, requiredStone: 4, depositedWood: 3, depositedStone: 1, requiredWork: 10, completedWork: 7 },
    footprint: [{ x: 10, y: 20 }, { x: 11, y: 20 }], storedWood: 12, storedStone: 3,
    installed: [{ id: 'i', recipeId: null, mass: 1, containment: 1, insulation: 1, cohesion: 1, binding: 1, condition: 1 }],
  }), null);
  assert.match(html, /Madera 3\/6 · Piedra 1\/4 · Obra 70%/);
  assert.match(html, /data-structure-footprint[^]*2×1/);
  assert.match(html, /Bodega: 12 madera · 3 piedra/);
  assert.match(html, /data-structure-installed[^]*<strong>1<\/strong>/);
});
