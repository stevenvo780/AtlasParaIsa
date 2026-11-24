import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TAPE_BASE_TICKS_PER_SEC, TAPE_SPEEDS, type TapeChunkResponse, type TapeMetaResponse, type TapeTimelinePoint } from '../src/shared/tape.js';
import { PROTOCOL_VERSION, type Viewport, type WorldView } from '../src/shared/types.js';
import { DVR_LIMITS, DvrPlayer, normalizeViewport, type DvrChunkRequest, type DvrFrameInfo, type DvrState } from '../src/client/dvr-player.js';
import { dvrEngineLabel, dvrHoverLabel, dvrTimeLabel, mountDvrBar, nearestTimelinePoint, renderDvrBar, type DvrBarHandlers, type DvrBarState } from '../src/client/dvr-bar.js';
import { applyObserverOnly, OBSERVER_HIDDEN_IDS, OBSERVER_NOTE, worldShell } from '../src/client/world-shell.js';
import { Connection } from '../src/client/connection.js';

/* ------------------------------------------------------------------ */
/* Cinta simulada                                                     */
/* ------------------------------------------------------------------ */

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const frame = (tick: number): WorldView => ({ version: PROTOCOL_VERSION, sequence: tick, tick, day: Math.floor(tick / 100), people: [], animals: [], tiles: [] }) as unknown as WorldView;

function timelinePoints(): TapeTimelinePoint[] {
  return [0, 100, 200, 300].map((tick, i) => ({ tick, day: i + 1, phase: 'day', weather: 'clear', pop: 10 + i * 5, births: 1, deaths: 0, structures: i, formulas: i * 2, paved: 0, simHz: 100 }));
}

function harness(options: { min?: number; max?: number; simHz?: number; enabled?: boolean; observerOnly?: boolean } = {}) {
  const tape = { min: options.min ?? 0, max: options.max ?? 1000, simHz: options.simHz ?? 120, enabled: options.enabled ?? true, observerOnly: options.observerOnly ?? false };
  const requests: DvrChunkRequest[] = [];
  const emitted: { tick: number; info: DvrFrameInfo }[] = [];
  const states: DvrState[] = [];
  const gates: Array<() => void> = [];
  let hold = false;
  let metaCalls = 0;
  const meta = (): TapeMetaResponse => ({ enabled: tape.enabled, observerOnly: tape.observerOnly, turbo: true, minTick: tape.min, maxTick: tape.max, latestDay: Math.floor(tape.max / 100), totalFrames: tape.max - tape.min + 1, keyframeInterval: 60, simHz: tape.simHz, keyframeTicks: [], timeline: timelinePoints() });
  const player = new DvrPlayer({
    metaPollMs: 0,
    viewportCoalesceMs: 10,
    fetchMeta: async () => { metaCalls++; return meta(); },
    fetchChunk: async request => {
      requests.push(request);
      const from = Math.max(request.fromTick, tape.min), to = Math.min(tape.max, from + request.count - 1);
      const frames: WorldView[] = [];
      for (let tick = from; tick <= to; tick++) frames.push(frame(tick));
      const response: TapeChunkResponse = { fromTick: from, toTick: to, minTick: tape.min, maxTick: tape.max, simHz: tape.simHz, hasMore: to < tape.max, frames };
      if (hold) await new Promise<void>(resolve => gates.push(resolve));
      return response;
    },
    onFrame: (view, info) => { emitted.push({ tick: view.tick, info }); },
    onStateChange: state => { states.push(state); },
  });
  return {
    tape, player, requests, emitted, states,
    get metaCalls() { return metaCalls; },
    holdResponses(value: boolean) { hold = value; },
    release() { while (gates.length) gates.shift()!(); },
    /** Reloj de rAF: `ms` de reproducción en pasos de `stepMs`, dejando resolver las peticiones entre pasos. */
    async run(ms: number, stepMs = 1000 / 60, from = 0): Promise<number> {
      let now = from; player.advance(now);
      for (let elapsed = 0; elapsed < ms - 1e-9; elapsed += stepMs) { now += stepMs; player.advance(now); await flush(); }
      return now;
    },
  };
}

/* ------------------------------------------------------------------ */
/* DvrPlayer                                                          */
/* ------------------------------------------------------------------ */

test('start: coloca el cabezal en el borde vivo con ~5 s de colchón y emite el primer fotograma al instante', async () => {
  const h = harness({ min: 0, max: 1000 });
  assert.equal(await h.player.start(), true);
  assert.equal(h.player.enabled, true);
  assert.equal(h.player.currentTick, 970); assert.equal(h.player.playTick, 970);
  assert.deepEqual(h.emitted.map(e => e.tick), [970]);
  assert.equal(h.emitted[0]!.info.reason, 'start');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0]!.fromTick, 970); assert.equal(h.requests[0]!.count, 90);
  assert.equal(h.player.bufferedAhead, 30); assert.equal(h.player.aheadOfPlayhead, 30); assert.equal(h.player.atLiveEdge, true);
  assert.equal(h.player.playing, true); assert.equal(h.player.speed, 1);
  assert.equal(h.player.simHz, 120); assert.equal(h.player.timeline.length, 4); assert.equal(h.player.latestDay, 10);
  h.player.stop();
});

test('start: con el mínimo cerca del final no baja de minTick; cinta apagada = no arranca ni pide trozos', async () => {
  const small = harness({ min: 20, max: 40 });
  await small.player.start();
  assert.equal(small.player.currentTick, 20);
  small.player.stop();
  const off = harness({ enabled: false });
  assert.equal(await off.player.start(), false);
  assert.equal(off.player.enabled, false); assert.equal(off.requests.length, 0); assert.equal(off.emitted.length, 0);
  off.player.stop();
});

test('advance a 60 fps: el cabezal fraccionario avanza TAPE_BASE_TICKS_PER_SEC × velocidad y libera los fotogramas en orden', async () => {
  for (const speed of [0.5, 1, 2, 5] as const) {
    const h = harness({ min: 0, max: 100_000 });
    await h.player.start(); await h.player.seek(1000);
    h.player.setSpeed(speed); h.emitted.length = 0;
    await h.run(1000);
    const expected = 1000 + TAPE_BASE_TICKS_PER_SEC * speed;
    assert.ok(Math.abs(h.player.playTick - expected) < 1e-6, `${speed}×: playTick ${h.player.playTick} ≠ ${expected}`);
    assert.ok(h.player.currentTick >= Math.floor(expected - 1e-6) - 0 && h.player.currentTick <= expected, `${speed}×: currentTick ${h.player.currentTick}`);
    const ticks = h.emitted.map(e => e.tick);
    assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b), 'orden creciente');
    assert.equal(new Set(ticks).size, ticks.length, 'sin repetidos');
    assert.ok(h.emitted.every(e => Math.abs(e.info.tickIntervalMs - 1000 / (TAPE_BASE_TICKS_PER_SEC * speed)) < 1e-9));
    assert.equal(h.player.tickIntervalMs, 1000 / (TAPE_BASE_TICKS_PER_SEC * speed));
    h.player.stop();
  }
});

test('advance a 25×: varios fotogramas cruzados en un rAF entregan solo el último (skipped) y el orden no retrocede', async () => {
  const h = harness({ min: 0, max: 100_000 });
  await h.player.start(); await h.player.seek(1000);
  h.player.setSpeed(25); h.emitted.length = 0; h.requests.length = 0;
  const rafs = Math.round(1000 / (1000 / 60));
  await h.run(1000);
  assert.ok(Math.abs(h.player.playTick - (1000 + 150)) < 1e-6, `playTick ${h.player.playTick}`);
  assert.ok(h.emitted.length <= rafs + 1, 'como mucho un fotograma por rAF');
  assert.ok(h.emitted.some(e => e.info.skipped > 0), 'a 25× se saltan intermedios');
  const ticks = h.emitted.map(e => e.tick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
  assert.ok(h.requests.length > 0 && h.requests.every(r => r.count === DVR_LIMITS.fastChunkCount), 'a ≥ 10× los trozos son de 120');
  assert.equal(h.player.currentTick, Math.floor(h.player.playTick));
  h.player.stop();
});

test('prefetch: pide el siguiente trozo (90) al bajar de 45 por delante, una sola petición en vuelo', async () => {
  const h = harness({ min: 0, max: 100_000 });
  await h.player.start(); await h.player.seek(100);
  assert.equal(h.player.bufferedAhead, 89); // 100 emitido + 101..189 en cola
  assert.equal(h.requests.length, 2);
  h.holdResponses(true);
  let now = 0; h.player.advance(now);
  while (h.player.bufferedAhead >= 45) { now += 100; h.player.advance(now); }
  assert.equal(h.requests.length, 3, 'una petición, no más');
  const prefetch = h.requests[2]!;
  assert.equal(prefetch.fromTick, 190); assert.equal(prefetch.count, 90);
  for (let i = 0; i < 20; i++) { now += 100; h.player.advance(now); }
  assert.equal(h.requests.length, 3, 'mientras hay una en vuelo no se pide otra');
  h.holdResponses(false); h.release(); await flush();
  assert.equal(h.player.maxLoadedTick, 279, 'el trozo 190–279 se encoló');
  assert.ok(h.player.bufferedAhead >= 90);
  const before = h.requests.length;
  h.player.advance(now + 16); await flush();
  assert.equal(h.requests.length, before, 'con colchón suficiente no se pide más');
  h.player.stop();
});

test('prefetch: nunca más allá de maxTick y el cabezal espera sin saltar ni retroceder en el borde de la cinta', async () => {
  const h = harness({ min: 0, max: 980 });
  await h.player.start(); // arranca en 950
  assert.equal(h.player.currentTick, 950);
  const now = await h.run(10_000);
  assert.equal(h.player.currentTick, 980);
  assert.ok(h.player.playTick <= 980 + 1e-9, 'el cabezal no sobrepasa lo cargado');
  assert.ok(h.requests.every(r => r.fromTick <= 980), 'no se pide más allá del final');
  const ticks = h.emitted.map(e => e.tick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
  // El motor turbo calcula más: la meta lo refleja y la reproducción continúa sin saltos.
  h.tape.max = 1100;
  await h.player.pollMeta(); await flush();
  assert.equal(h.player.maxTick, 1100); assert.equal(h.player.aheadOfPlayhead, 120); assert.equal(h.player.atLiveEdge, false);
  await h.run(1000, 1000 / 60, now);
  assert.ok(h.player.currentTick > 980 && h.player.currentTick <= 986, `currentTick ${h.player.currentTick}`);
  h.player.stop();
});

test('pollMeta: refresca maxTick, minTick, simHz, timeline y latestDay', async () => {
  const h = harness({ min: 0, max: 1000, simHz: 120 });
  await h.player.start();
  h.tape.max = 5000; h.tape.min = 200; h.tape.simHz = 333;
  await h.player.pollMeta();
  assert.equal(h.player.maxTick, 5000); assert.equal(h.player.minTick, 200); assert.equal(h.player.simHz, 333); assert.equal(h.player.latestDay, 50);
  assert.equal(h.metaCalls, 2);
  h.player.stop();
});

test('pause / togglePlaying: sin reproducir el cabezal no se mueve, pero el prefetch sigue', async () => {
  const h = harness({ min: 0, max: 100_000 });
  await h.player.start(); await h.player.seek(500);
  h.player.setPlaying(false); assert.equal(h.player.playing, false);
  const tick = h.player.currentTick, play = h.player.playTick; h.emitted.length = 0;
  await h.run(2000);
  assert.equal(h.player.currentTick, tick); assert.equal(h.player.playTick, play); assert.equal(h.emitted.length, 0);
  h.player.togglePlaying(); assert.equal(h.player.playing, true);
  await h.run(1000);
  assert.ok(h.player.currentTick > tick);
  h.player.togglePlaying(); assert.equal(h.player.playing, false);
  h.player.stop();
});

test('step(+1) usa la cola y pausa; step(-1) retrocede un fotograma grabado', async () => {
  const h = harness({ min: 0, max: 100_000 });
  await h.player.start(); await h.player.seek(300);
  assert.equal(h.player.playing, true);
  const requests = h.requests.length;
  await h.player.step(1);
  assert.equal(h.player.playing, false);
  assert.equal(h.player.currentTick, 301); assert.equal(h.player.playTick, 301);
  assert.equal(h.requests.length, requests, 'el siguiente ya estaba cargado');
  assert.equal(h.emitted.at(-1)!.info.reason, 'step');
  await h.player.step(-1);
  assert.equal(h.player.currentTick, 300);
  await h.player.step(-1);
  assert.equal(h.player.currentTick, 299);
  assert.equal(h.requests.at(-1)!.fromTick, 299);
  await h.player.step(1);
  assert.equal(h.player.currentTick, 300);
  // No sale de la cinta.
  await h.player.seek(0); await h.player.step(-1);
  assert.equal(h.player.currentTick, 0);
  h.player.stop();
});

test('step(+1) con la cola vacía en el final no inventa fotogramas', async () => {
  const h = harness({ min: 0, max: 40 });
  await h.player.start();
  await h.player.seek(40);
  await h.player.step(1);
  assert.equal(h.player.currentTick, 40);
  h.player.stop();
});

test('seek: acota a [minTick, maxTick], limpia lo cargado y emite el primer fotograma; una respuesta vieja se descarta', async () => {
  const h = harness({ min: 100, max: 1000 });
  await h.player.start();
  await h.player.seek(-50); assert.equal(h.player.currentTick, 100); assert.equal(h.player.playTick, 100);
  await h.player.seek(99_999); assert.equal(h.player.currentTick, 1000);
  await h.player.seek(400);
  assert.equal(h.player.currentTick, 400); assert.equal(h.player.playTick, 400); assert.equal(h.player.bufferedAhead, 89);
  assert.equal(h.emitted.at(-1)!.info.reason, 'seek'); assert.equal(h.emitted.at(-1)!.info.discontinuity, true);

  // Dos saltos con la primera respuesta aún en vuelo: la vieja llega después y no debe emitir ni encolar nada.
  h.holdResponses(true); h.emitted.length = 0;
  const first = h.player.seek(200);
  const second = h.player.seek(700);
  h.holdResponses(false); h.release();
  await Promise.all([first, second]);
  assert.deepEqual(h.emitted.map(e => e.tick), [700]);
  assert.equal(h.player.currentTick, 700); assert.equal(h.player.playTick, 700);
  assert.equal(h.player.bufferedAhead, 89);
  assert.equal(h.requests.at(-2)!.signal.aborted, true, 'la petición vieja se aborta');
  h.player.stop();
});

test('un prefetch en vuelo cuando llega un seek se descarta', async () => {
  const h = harness({ min: 0, max: 100_000 });
  await h.player.start(); await h.player.seek(100);
  h.holdResponses(true);
  let now = 0; h.player.advance(now);
  while (h.player.bufferedAhead >= 45) { now += 100; h.player.advance(now); }
  const stale = h.requests.at(-1)!; assert.equal(stale.fromTick, 190);
  const seeking = h.player.seek(5000);
  h.holdResponses(false); h.release(); await seeking; await flush();
  assert.equal(h.player.currentTick, 5000);
  assert.ok(h.player.bufferedAhead <= 89, 'nada del trozo viejo (190–279) en la cola');
  h.player.stop();
});

test('jumpToLiveEdge: vuelve a maxTick - 30 y reproduce', async () => {
  const h = harness({ min: 0, max: 1000 });
  await h.player.start(); await h.player.seek(100);
  h.player.setPlaying(false);
  assert.equal(h.player.atLiveEdge, false);
  await h.player.jumpToLiveEdge();
  assert.equal(h.player.currentTick, 970); assert.equal(h.player.playing, true); assert.equal(h.player.atLiveEdge, true);
  h.player.stop();
});

test('setViewport: se fusiona (~200 ms) y refresca el trozo en currentTick sin perder la posición', async () => {
  const h = harness({ min: 0, max: 100_000 });
  await h.player.start(); await h.player.seek(1000);
  await h.run(500); // cabezal fraccionario a mitad de un tick
  const tick = h.player.currentTick, play = h.player.playTick, before = h.requests.length;
  const a: Viewport = { x: 10, y: 10, width: 40, height: 30 };
  h.player.setViewport(a); h.player.setViewport({ ...a, x: 20 }); h.player.setViewport({ ...a, x: 33.4 });
  assert.equal(h.requests.length, before, 'nada hasta que vence la ventana');
  await new Promise(resolve => setTimeout(resolve, 40)); await flush();
  const refreshes = h.requests.slice(before);
  assert.equal(refreshes.length, 1, 'tres movimientos = una petición');
  assert.deepEqual(refreshes[0]!.viewport, { x: 33, y: 10, width: 40, height: 30 });
  assert.equal(refreshes[0]!.fromTick, tick);
  assert.equal(h.emitted.at(-1)!.tick, tick); assert.equal(h.emitted.at(-1)!.info.reason, 'refresh');
  assert.equal(h.player.currentTick, tick); assert.ok(h.player.playTick >= play, 'el cabezal no retrocede');
  assert.ok(h.player.bufferedAhead > 0 && h.player.maxLoadedTick > tick);
  // La misma cámara otra vez no repide.
  const count = h.requests.length;
  h.player.setViewport({ x: 33, y: 10, width: 40, height: 30 }); await h.player.flushViewport();
  assert.equal(h.requests.length, count);
  // Lo prefetchado después usa la cámara nueva.
  await h.run(8000, 100, 0); // vacía el colchón y obliga a otro trozo
  assert.ok(h.requests.at(-1)!.viewport && h.requests.at(-1)!.viewport!.x === 33);
  h.player.stop();
});

test('setViewport antes de start no repide: el primer trozo ya sale con esa cámara', async () => {
  const h = harness();
  h.player.setViewport({ x: 5, y: 6, width: 20, height: 10 });
  await h.player.start();
  assert.equal(h.requests.length, 1); assert.deepEqual(h.requests[0]!.viewport, { x: 5, y: 6, width: 20, height: 10 });
  h.player.stop();
});

test('normalizeViewport: enteros, tamaño acotado y rechazo de NaN', () => {
  assert.deepEqual(normalizeViewport({ x: 1.9, y: -2.1, width: 200, height: 0.2 }), { x: 1, y: -3, width: 96, height: 1 });
  assert.equal(normalizeViewport({ x: Number.NaN, y: 0, width: 1, height: 1 }), null);
});

test('setSpeed solo acepta velocidades del contrato y el estado publica los campos del DVR', async () => {
  const h = harness({ min: 0, max: 1000 });
  await h.player.start();
  h.player.setSpeed(7 as never); assert.equal(h.player.speed, 1);
  for (const speed of TAPE_SPEEDS) { h.player.setSpeed(speed); assert.equal(h.player.speed, speed); }
  const state = h.states.at(-1)!;
  for (const key of ['enabled', 'playing', 'speed', 'playTick', 'currentTick', 'minTick', 'maxTick', 'latestDay', 'simHz', 'timeline', 'bufferedAhead', 'aheadOfPlayhead', 'atLiveEdge', 'loading'] as const) assert.ok(key in state, key);
  assert.equal(state.speed, 25);
  h.player.stop();
});

test('un error de red no rompe la reproducción: se anota y el siguiente sondeo lo recupera', async () => {
  let fail = true;
  const player = new DvrPlayer({
    metaPollMs: 0,
    fetchMeta: async () => ({ enabled: true, observerOnly: true, turbo: true, minTick: 0, maxTick: 500, latestDay: 5, totalFrames: 501, keyframeInterval: 60, simHz: 90, keyframeTicks: [], timeline: [] }),
    fetchChunk: async request => { if (fail) throw new Error('caído'); return { fromTick: request.fromTick, toTick: request.fromTick, minTick: 0, maxTick: 500, simHz: 90, hasMore: false, frames: [frame(request.fromTick)] }; },
    onFrame: () => undefined,
  });
  assert.equal(await player.start(), true);
  assert.equal(player.observerOnly, true);
  assert.equal(player.error, 'caído'); assert.equal(player.loading, false);
  fail = false;
  await player.seek(100);
  assert.equal(player.currentTick, 100); assert.equal(player.error, null);
  player.stop();
});

/* ------------------------------------------------------------------ */
/* DvrBar                                                             */
/* ------------------------------------------------------------------ */

function barState(overrides: Partial<DvrBarState> = {}): DvrBarState {
  return { playing: true, speed: 2, currentTick: 150, minTick: 0, maxTick: 450, latestDay: 12, simHz: 119.6, timeline: timelinePoints(), aheadOfPlayhead: 300, atLiveEdge: false, ...overrides };
}

test('renderDvrBar: transporte, velocidades, sparkline, telemetría del motor y Borde vivo', () => {
  const html = renderDvrBar(barState());
  assert.match(html, /data-dvr-step="-1"/); assert.match(html, /data-dvr-step="1"/);
  assert.match(html, /data-dvr-play[^>]*aria-pressed="true"[^>]*aria-label="Pausar"[^>]*title="Espacio">⏸</);
  for (const speed of TAPE_SPEEDS) assert.match(html, new RegExp(`data-dvr-speed="${speed}" aria-pressed="${speed === 2}">${speed}×<`));
  assert.match(html, /<svg class="dvr-sparkline"[^>]*viewBox="0 0 100 24"/);
  assert.match(html, /<path class="dvr-spark-line" d="M0\.00,/); assert.match(html, /<path class="dvr-spark-area"/);
  assert.match(html, /<input type="range" class="dvr-range" data-dvr-range min="0" max="450" step="1" value="150"/);
  assert.match(html, /Día 2 · Paso 150/);
  assert.match(html, /⚡ 120 Hz · Día 12 \(\+300 adel\.\)/);
  assert.match(html, /<button type="button" class="dvr-live" data-dvr-live aria-pressed="false"[^>]*>● Borde vivo<\/button>/);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});

test('renderDvrBar: pausa muestra ▶, el borde vivo se resalta y la vista previa del punto aparece', () => {
  const paused = renderDvrBar(barState({ playing: false, atLiveEdge: true, aheadOfPlayhead: 12 }), timelinePoints()[2]!);
  assert.match(paused, /aria-label="Reproducir"[^>]*>▶</);
  assert.match(paused, /class="dvr-live is-live" data-dvr-live aria-pressed="true"/);
  assert.match(paused, /\(\+12 adel\.\)/);
  assert.match(paused, /<span class="dvr-hover" data-dvr-hover>Día 3 · Pob 20 · Obras 2 · Fórmulas 4<\/span>/);
  assert.match(renderDvrBar(barState()), /<span class="dvr-hover" data-dvr-hover><\/span>/);
});

test('renderDvrBar: nada del servidor llega sin escapar ni como no-número', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const bad = { tick: evil, day: evil, pop: evil, structures: evil, formulas: evil, births: 0, deaths: 0, phase: 'day', weather: 'clear', paved: 0, simHz: evil } as unknown as TapeTimelinePoint;
  const html = renderDvrBar(barState({ timeline: [bad, ...timelinePoints()], latestDay: evil as never, simHz: evil as never, speed: evil as never, aheadOfPlayhead: evil as never, currentTick: evil as never }), bad);
  assert.doesNotMatch(html, /<img|onerror|alert/);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
  assert.match(html, /data-dvr-speed="1" aria-pressed="true"/, 'una velocidad desconocida cae a 1×');
  // Cinta vacía o de un solo punto: sin NaN en el SVG ni en el rango.
  for (const empty of [renderDvrBar(barState({ timeline: [], minTick: 0, maxTick: 0, currentTick: 0 })), renderDvrBar(barState({ timeline: [timelinePoints()[0]!], minTick: 5, maxTick: 5, currentTick: 5 }))]) {
    assert.doesNotMatch(empty, /NaN|undefined|Infinity/); assert.match(empty, /<svg class="dvr-sparkline"/);
  }
});

test('helpers de la barra: tiempo, motor y punto más cercano', () => {
  const state = barState();
  assert.equal(dvrTimeLabel(state), 'Día 2 · Paso 150');
  assert.equal(dvrTimeLabel(state, 300), 'Día 4 · Paso 300');
  assert.equal(dvrTimeLabel({ ...state, timeline: [] }, 300), 'Día 12 · Paso 300');
  assert.equal(dvrEngineLabel(state), '⚡ 120 Hz · Día 12 (+300 adel.)');
  assert.equal(nearestTimelinePoint(state.timeline, 260)!.tick, 300);
  assert.equal(nearestTimelinePoint([], 1), null);
  assert.equal(dvrHoverLabel(null), '');
});

class FakeButton {
  constructor(private readonly attributes: Record<string, string>) {}
  hasAttribute(name: string): boolean { return name in this.attributes; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  closest(selector: string): FakeButton | null { return selector === 'button' ? this : null; }
}
class FakeContainer {
  innerHTML = '';
  listeners = new Map<string, (event: unknown) => void>();
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, listener); }
  removeEventListener(type: string): void { this.listeners.delete(type); }
  querySelector(): null { return null; }
  contains(): boolean { return true; }
  click(attributes: Record<string, string>): void { this.listeners.get('click')!({ target: new FakeButton(attributes) }); }
}

test('mountDvrBar: pinta la barra y delega cada botón en su manejador', () => {
  const container = new FakeContainer();
  const calls: unknown[] = [];
  const handlers: DvrBarHandlers = { togglePlay: () => calls.push('play'), step: d => calls.push(['step', d]), setSpeed: s => calls.push(['speed', s]), seek: t => calls.push(['seek', t]), jumpLive: () => calls.push('live') };
  const bar = mountDvrBar(container as unknown as HTMLElement, handlers);
  bar.update(barState());
  assert.match(container.innerHTML, /class="dvr-transport"/);
  container.click({ 'data-dvr-play': '' }); container.click({ 'data-dvr-live': '' });
  container.click({ 'data-dvr-step': '-1' }); container.click({ 'data-dvr-step': '1' });
  container.click({ 'data-dvr-speed': '10' }); container.click({ 'data-dvr-speed': '3' });
  assert.deepEqual(calls, ['play', 'live', ['step', -1], ['step', 1], ['speed', 10]]);
  bar.destroy();
  assert.equal(container.innerHTML, ''); assert.equal(container.listeners.size, 0);
});

/* ------------------------------------------------------------------ */
/* Modo observador puro + compatibilidad del shell                    */
/* ------------------------------------------------------------------ */

interface FakeNode { hidden?: boolean | 'until-found'; textContent: string | null; attributes: Record<string, string>; classes: Set<string>; classList: { toggle(token: string, force?: boolean): void }; setAttribute(name: string, value: string): void }
function fakeDocument(ids: readonly string[]) {
  const nodes = new Map<string, FakeNode>();
  for (const id of ids) {
    const node: FakeNode = { hidden: false, textContent: `texto original de ${id}`, attributes: {}, classes: new Set(),
      classList: { toggle: (token, force) => { if (force ?? !node.classes.has(token)) node.classes.add(token); else node.classes.delete(token); } },
      setAttribute: (name, value) => { node.attributes[name] = value; } };
    nodes.set(id, node);
  }
  return { nodes, getElementById: (id: string) => nodes.get(id) ?? null };
}

test('observerOnly: oculta la UI de dirección e intervención y reescribe las ayudas', () => {
  const ids = ['game', ...OBSERVER_HIDDEN_IDS, 'population-note', 'control-help', 'follow-toggle', 'inspector-tabs', 'dvr-bar'];
  const doc = fakeDocument(ids);
  applyObserverOnly(doc, true);
  assert.ok(doc.nodes.get('game')!.classes.has('is-observer-only'));
  for (const id of ['direct-toggle', 'person-controls', 'task-palette', 'intervene-toggle', 'tool-drawer']) { assert.equal(doc.nodes.get(id)!.hidden, true, id); assert.equal(doc.nodes.get(id)!.attributes['aria-hidden'], 'true'); }
  assert.equal(OBSERVER_NOTE, 'Observación pura: cada habitante decide por su cuenta.');
  assert.equal(doc.nodes.get('population-note')!.textContent, OBSERVER_NOTE);
  assert.equal(doc.nodes.get('control-help')!.textContent, OBSERVER_NOTE);
  for (const id of ['follow-toggle', 'inspector-tabs', 'dvr-bar']) { assert.equal(doc.nodes.get(id)!.hidden, false, `${id} sigue visible`); assert.equal(doc.nodes.get(id)!.textContent, `texto original de ${id}`); }
});

test('observerOnly = false: no toca nada salvo quitar la marca', () => {
  const doc = fakeDocument(['game', ...OBSERVER_HIDDEN_IDS, 'population-note']);
  doc.nodes.get('game')!.classes.add('is-observer-only');
  applyObserverOnly(doc, false);
  assert.equal(doc.nodes.get('game')!.classes.has('is-observer-only'), false);
  for (const id of OBSERVER_HIDDEN_IDS) assert.equal(doc.nodes.get(id)!.hidden, false);
  assert.equal(doc.nodes.get('population-note')!.textContent, 'texto original de population-note');
  applyObserverOnly({ getElementById: () => null }, true); // un shell sin esos nodos no revienta
});

test('worldShell: monta #dvr-bar oculto y conserva todo lo existente (modo vivo sin cinta)', () => {
  const html = worldShell();
  assert.match(html, /<div id="dvr-bar" class="dvr-bar hud-surface"[^>]*hidden><\/div>/);
  assert.doesNotMatch(html, /is-observer-only/);
  for (const id of OBSERVER_HIDDEN_IDS) assert.ok(html.includes(`id="${id}"`), `${id} sigue en el shell por defecto`);
  for (const label of ['Mapa', 'Vidas', 'Mundo', 'Explorar', 'Calor', 'Crónica']) assert.ok(html.includes(label), label);
  for (const id of ['focus-s', 'focus-i', 'follow-toggle', 'letter-button', 'inspector-tab-now', 'inspector-tab-kit', 'inspector-tab-story', 'world-coordinates'.replace('world-coordinates', 'camera-coordinates')]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('id="dvr-bar"') < html.indexOf('class="world-coordinates'), 'la barra va antes de las coordenadas en el DOM');
  assert.ok(html.includes('<option value="caminos">Caminos y calzadas</option>'));
});

test('game.css: barra DVR flotante y reglas de observador puro presentes', () => {
  const css = readFileSync(new URL('../src/client/game.css', import.meta.url), 'utf8');
  assert.match(css, /\.dvr-bar\{position:absolute;left:50%;bottom:92px/);
  assert.match(css, /\.dvr-bar\[hidden\]\{display:none\}/);
  assert.match(css, /\.game-shell\.is-observer-only :is\(#direct-toggle,#person-controls,#task-palette,#intervene-toggle,#tool-drawer\)\{display:none!important\}/);
  assert.match(css, /@media\(max-width:760px\)\{\s*\.dvr-bar\{left:8px;right:8px/);
});

/* ------------------------------------------------------------------ */
/* Connection: la cinta manda, el socket sigue para recetas/fichas      */
/* ------------------------------------------------------------------ */

test('Connection.setTapeMode: los estados del socket se encadenan pero no se entregan; al volver al vivo se reanudan', () => {
  const delivered: number[] = [];
  const connection = new Connection({ world: w => delivered.push(w.sequence), result: () => undefined, status: () => undefined, expired: () => undefined, error: () => undefined, pending: () => undefined });
  const accept = (world: WorldView): void => (connection as unknown as { accept(w: WorldView): void }).accept(world);
  const view = (sequence: number): WorldView => ({ ...frame(sequence), sequence, width: 1, height: 1 }) as WorldView;
  accept(view(1));
  assert.deepEqual(delivered, [1]); assert.equal(connection.isTapeMode, false);
  connection.setTapeMode(true);
  assert.equal(connection.isTapeMode, true);
  accept(view(2)); accept(view(3));
  assert.deepEqual(delivered, [1], 'en modo cinta el mundo no viene del socket');
  connection.setTapeMode(false);
  accept(view(4));
  assert.deepEqual(delivered, [1, 4]);
  // Las preguntas por socket siguen disponibles en modo cinta (sin socket abierto simplemente devuelven false, sin romper).
  connection.setTapeMode(true);
  assert.equal(connection.requestRecipe('recipe-1'), false); assert.equal(connection.requestPersona('s'), false);
  connection.stop();
});
