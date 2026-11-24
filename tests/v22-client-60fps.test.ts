/**
 * V22 Frente 3 — cliente a 60 fps con zoom lejano.
 *
 *  1. `DvrPlayer` consume trozos `encoding: 'delta'` de forma PEREZOSA (no expande los 90 deltas al llegar el trozo),
 *     entrega exactamente los mismos `WorldView` que un trozo `full`, y expone `info.changedTiles`.
 *  2. `Landscape` (navegador real, Chromium): `structuredTiles` y los props estáticos no se rehacen por fotograma, el LOD
 *     lejano (< 14 px/tesela) usa la capa estática y se salta `behind()`, `behind()` cercano usa la rejilla espacial con la
 *     misma semántica de recortes, los salones modulares se cachean y el modo DVR puentea el colchón V18.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createBrowserTestServer as createServer } from './lib/vite.js';
import { applyClientTapeDelta, indexTiles, type TapeChunkResponse, type TapeClientDelta, type TapeMetaResponse } from '../src/shared/tape.js';
import { PROTOCOL_VERSION, type Tile, type WorldView } from '../src/shared/types.js';
import { DVR_LIMITS, DvrPlayer, type DvrChunkRequest, type DvrFrameInfo } from '../src/client/dvr-player.js';

/* ------------------------------------------------------------------ */
/* Cinta sintética: fotogramas completos y sus deltas                  */
/* ------------------------------------------------------------------ */

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const TILE_COUNT = 400;

/** Mundo determinista por tick: 8 personas se mueven cada tick; solo `food` de la tesela `tick % 40` cambia. */
function fullFrame(tick: number): WorldView {
  const tiles: Tile[] = Array.from({ length: TILE_COUNT }, (_, i) => ({ x: i % 20, y: Math.floor(i / 20), terrain: 'meadow', food: i === tick % 40 ? 1 : 0, moisture: .5, vegetation: .5 } as unknown as Tile));
  // Un tick lleva la huella de todos los anteriores: la tesela que cambió en t-1 vuelve a su valor base en t.
  return {
    version: PROTOCOL_VERSION, sequence: tick, tick, day: Math.floor(tick / 100), phase: tick % 200 < 100 ? 'day' : 'night', weather: 'clear',
    width: 20, height: 20, originX: 0, originY: 0, tiles,
    people: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, role: 'neighbor', x: i + tick * .1, y: i, color: '#fff' })),
    animals: [], structures: [{ id: 's1', x: 3, y: 3, name: 'hall', components: ['frame'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null, tickMarker: Math.floor(tick / 30) }],
    places: [], events: [], memories: [],
  } as unknown as WorldView;
}

/** Delta de `tick` respecto a `tick-1` calculado a mano (no con `applyClientTapeDelta`: así la paridad es independiente). */
function deltaOf(tick: number): TapeClientDelta {
  const prev = fullFrame(tick - 1), next = fullFrame(tick);
  const tilesPatch = next.tiles.filter((t, i) => JSON.stringify(t) !== JSON.stringify(prev.tiles[i]));
  const structureChanged = JSON.stringify(prev.structures) !== JSON.stringify(next.structures);
  return {
    tick, sequence: next.sequence, day: next.day, phase: next.phase, weather: next.weather,
    peoplePatch: { upserts: next.people, removed: [] },
    ...(tilesPatch.length ? { tilesPatch } : {}),
    ...(structureChanged ? { structuresPatch: { upserts: next.structures!, removed: [] } } : {}),
  };
}

interface TapeOptions { min?: number; max?: number; delta: boolean }

function harness(options: TapeOptions) {
  const tape = { min: options.min ?? 0, max: options.max ?? 1000 };
  const requests: DvrChunkRequest[] = [];
  const emitted: { frame: WorldView; info: DvrFrameInfo }[] = [];
  const meta = (): TapeMetaResponse => ({ enabled: true, observerOnly: false, turbo: true, minTick: tape.min, maxTick: tape.max, latestDay: 10, totalFrames: tape.max - tape.min + 1, keyframeInterval: 60, simHz: 100, keyframeTicks: [], timeline: [] });
  const player = new DvrPlayer({
    metaPollMs: 0, viewportCoalesceMs: 10,
    fetchMeta: async () => meta(),
    fetchChunk: async request => {
      requests.push(request);
      const from = Math.max(request.fromTick, tape.min), to = Math.min(tape.max, from + request.count - 1);
      const base = { fromTick: from, toTick: to, minTick: tape.min, maxTick: tape.max, simHz: 100, hasMore: to < tape.max };
      if (options.delta) {
        const deltas: TapeClientDelta[] = [];
        for (let tick = from + 1; tick <= to; tick++) deltas.push(deltaOf(tick));
        return { ...base, encoding: 'delta', frames: [], baseFrame: fullFrame(from), deltas } satisfies TapeChunkResponse;
      }
      const frames: WorldView[] = [];
      for (let tick = from; tick <= to; tick++) frames.push(fullFrame(tick));
      return { ...base, frames } satisfies TapeChunkResponse;
    },
    onFrame: (frame, info) => { emitted.push({ frame, info }); },
  });
  return { player, requests, emitted, tape };
}

/** Avanza el reloj a 60 fps durante `ms` y devuelve el reloj final. */
function run(player: DvrPlayer, from: number, ms: number): number {
  let now = from;
  for (const end = from + ms; now < end; now += 1000 / 60) player.advance(now);
  return now;
}

test('contrato: el trozo delta reconstruye exactamente los fotogramas completos (referencia independiente)', () => {
  let frame = fullFrame(10);
  const index = indexTiles(frame.tiles);
  for (let tick = 11; tick <= 60; tick++) {
    const result = applyClientTapeDelta(frame, deltaOf(tick), index);
    frame = result.frame;
    assert.deepEqual(frame, fullFrame(tick), `tick ${tick}`);
    assert.ok(result.changedTiles.length <= 2, 'solo cambian las teselas tocadas');
  }
});

test('DvrPlayer delta: llegar el trozo NO expande los deltas; se expanden al cruzarlos con advance()', async () => {
  const h = harness({ delta: true, max: 1000 });
  assert.equal(await h.player.start(), true);
  await h.player.seek(100); // el borde vivo solo tiene ~30 fotogramas por delante: se prueba un trozo entero de 90
  assert.equal(h.requests.at(-1)!.count, DVR_LIMITS.chunkCount);
  assert.equal(h.emitted.length, 2, 'solo el fotograma base de cada salto se entrega al llegar el trozo');
  assert.equal(h.player.decodedDeltas, 0, 'cero deltas expandidos tras recibir 90 fotogramas');
  assert.equal(h.player.bufferedAhead, DVR_LIMITS.chunkCount - 1, 'los 89 deltas esperan sin expandir en la cola');
  const first = h.emitted[1]!;
  assert.equal(first.info.discontinuity, true);
  assert.equal(first.info.changedTiles, undefined, 'la base es un fotograma completo: se ingiere frame.tiles');

  h.player.advance(0);
  let now = run(h.player, 16, 500); // ≈ 500 ms a 1× → unos pocos ticks
  const crossed = h.emitted.length - 2;
  assert.ok(crossed > 0 && crossed < 30);
  assert.equal(h.player.decodedDeltas, crossed, 'se expande exactamente un delta por fotograma cruzado');
  assert.ok(h.player.bufferedAhead > DVR_LIMITS.chunkCount - 1 - 40, 'el resto sigue sin expandir');
  now = run(h.player, now, 100);
  assert.equal(h.player.decodedDeltas, h.emitted.length - 2);
});

test('DvrPlayer delta: paridad exacta con trozos full (1×, 25×, prefetch entre trozos, step, seek, cámara, borde vivo)', async () => {
  const a = harness({ delta: true }), b = harness({ delta: false });
  await Promise.all([a.player.start(), b.player.start()]);
  const same = (label: string): void => {
    assert.equal(a.emitted.length, b.emitted.length, `${label}: mismos fotogramas emitidos`);
    for (let i = 0; i < a.emitted.length; i++) {
      assert.deepEqual(a.emitted[i]!.frame, b.emitted[i]!.frame, `${label} #${i}`);
      assert.equal(a.emitted[i]!.info.skipped, b.emitted[i]!.info.skipped, `${label} #${i} skipped`);
      assert.equal(a.emitted[i]!.info.discontinuity, b.emitted[i]!.info.discontinuity);
      assert.equal(a.emitted[i]!.info.reason, b.emitted[i]!.info.reason);
    }
    for (const key of ['bufferedAhead', 'maxLoadedTick', 'currentTick', 'playTick', 'aheadOfPlayhead', 'atLiveEdge'] as const) assert.equal(a.player[key], b.player[key], `${label}: ${key}`);
  };
  const both = async (fn: (p: DvrPlayer) => unknown): Promise<void> => { await Promise.all([fn(a.player), fn(b.player)]); await flush(); await flush(); };
  await both(p => p.seek(100)); same('seek inicial');

  let now = 0;
  await both(p => p.advance(now));
  for (let i = 0; i < 200; i++) { now += 1000 / 60; await both(p => p.advance(now)); } // cruza el límite del primer trozo (prefetch)
  same('1×');
  assert.ok(a.requests.length >= 2 && b.requests.length === a.requests.length, 'el prefetch pidió el trozo siguiente en ambos');
  await both(p => p.setSpeed(25));
  for (let i = 0; i < 90; i++) { now += 1000 / 60; await both(p => p.advance(now)); }
  same('25×');
  assert.ok(a.emitted.some(e => e.info.skipped > 0), 'a 25× se cruzan varios fotogramas por rAF');
  await both(p => p.setSpeed(1));
  await both(p => p.step(-1)); same('step(-1)');
  await both(p => p.step(1)); same('step(+1)');
  await both(p => p.step(1)); same('step(+1) ×2');
  await both(p => p.seek(500)); same('seek');
  await both(p => p.setPlaying(true));
  for (let i = 0; i < 30; i++) { now += 1000 / 60; await both(p => p.advance(now)); }
  same('tras seek');
  await both(p => { p.setViewport({ x: 4, y: 4, width: 20, height: 20 }); return p.flushViewport(); });
  same('setViewport');
  assert.deepEqual(a.requests.at(-1)!.viewport, b.requests.at(-1)!.viewport);
  await both(p => p.jumpToLiveEdge()); same('jumpToLiveEdge');
  assert.equal(a.player.currentTick, a.tape.max - DVR_LIMITS.liveMargin);
});

test('DvrPlayer delta: info.changedTiles trae solo las teselas modificadas y se acumula al saltar fotogramas', async () => {
  const h = harness({ delta: true });
  await h.player.start(); await h.player.seek(100);
  h.player.advance(0);
  run(h.player, 16, 700);
  const played = h.emitted.slice(2);
  assert.ok(played.length > 3);
  for (const { frame, info } of played) {
    assert.ok(info.changedTiles, 'los fotogramas de delta llevan changedTiles');
    assert.ok(info.changedTiles!.length <= 2 && info.changedTiles!.length < frame.tiles.length / 100, `solo ${info.changedTiles!.length} de ${frame.tiles.length} teselas`);
    for (const tile of info.changedTiles!) assert.ok(frame.tiles.includes(tile), 'cada tesela cambiada es la del fotograma entregado');
  }
  // Un tick que no cambia la estructura conserva la misma referencia de `tiles`/`structures` (barato para el cliente).
  assert.ok(played.some((e, i) => i > 0 && e.frame.structures === played[i - 1]!.frame.structures));

  // A 25× el cabezal cruza varios ticks por rAF: las teselas de los intermedios no se pierden.
  h.player.setSpeed(25);
  const before = h.emitted.length;
  run(h.player, 2000, 200);
  const fast = h.emitted.slice(before).filter(e => e.info.skipped > 0);
  assert.ok(fast.length > 0);
  for (const { info } of fast) assert.ok(info.changedTiles!.length >= 1 && info.changedTiles!.length <= 2 * (info.skipped + 1));
  const ingestedFromDeltas = new Set<string>();
  const cache = new Map<string, Tile>(h.emitted[1]!.frame.tiles.map(t => [`${t.x},${t.y}`, t]));
  for (const { frame, info } of h.emitted.slice(2)) {
    for (const t of info.changedTiles ?? frame.tiles) { cache.set(`${t.x},${t.y}`, t); ingestedFromDeltas.add(`${t.x},${t.y}`); }
    for (const t of frame.tiles) assert.deepEqual(cache.get(`${t.x},${t.y}`), t, 'ingerir solo changedTiles deja la caché idéntica a la vista completa');
  }
});

test('DvrPlayer delta: una base de trozo (prefetch) vuelve a ser fotograma completo y un delta corrupto no rompe el reproductor', async () => {
  const h = harness({ delta: true });
  await h.player.start(); await h.player.seek(100);
  h.player.advance(0);
  let clock = 16; // 6 ticks/s a 1×: 90 ticks = 15 s; se cede el turno cada segundo para que lleguen los trozos pedidos
  for (let second = 0; second < 20; second++) { clock = run(h.player, clock, 1000); await flush(); await flush(); }
  const bases = h.emitted.filter(e => e.info.changedTiles === undefined && !e.info.discontinuity);
  assert.ok(h.requests.length >= 2, 'se pidió el segundo trozo');
  assert.ok(bases.length >= 1, 'la base del segundo trozo llega sin changedTiles (se ingiere completa)');
  for (const base of bases) assert.deepEqual(base.frame, fullFrame(base.frame.tick));

  const broken = new DvrPlayer({
    metaPollMs: 0, fetchMeta: async () => ({ enabled: true, observerOnly: false, turbo: true, minTick: 0, maxTick: 100, latestDay: 1, totalFrames: 101, keyframeInterval: 60, simHz: 100, keyframeTicks: [], timeline: [] }),
    fetchChunk: async request => ({ fromTick: request.fromTick, toTick: request.fromTick + 2, minTick: 0, maxTick: 100, simHz: 100, hasMore: true, encoding: 'delta', frames: [],
      baseFrame: fullFrame(request.fromTick), deltas: [deltaOf(request.fromTick + 1), { ...deltaOf(request.fromTick + 2), peoplePatch: { upserts: null, removed: [] } as never }] }),
    onFrame: () => {},
  });
  await broken.start(); broken.advance(0);
  assert.doesNotThrow(() => run(broken, 16, 400));
  assert.ok(broken.error, 'el fallo de decodificación queda en `error`, sin excepciones sueltas');
});

test('game.ts pide trozos delta, ingiere solo changedTiles y activa/desactiva setDvrMode', () => {
  const game = readFileSync(new URL('../src/client/game.ts', import.meta.url), 'utf8');
  assert.match(game, /encoding: 'delta'/, 'la petición /api/tape/chunk lleva encoding=delta');
  assert.match(game, /info\.changedTiles \?\? frame\.tiles/);
  assert.match(game, /landscape\?\.setDvrMode\(true\)/);
  assert.ok((game.match(/landscape\?\.setDvrMode\(false\)/g) ?? []).length >= 2, 'se apaga al parar la cinta y al volver al WebSocket');
  assert.match(game, /tileCache\.ingest\(tiles, frame\.tick\)/);
});

/* ------------------------------------------------------------------ */
/* Landscape en un navegador real                                      */
/* ------------------------------------------------------------------ */

test('Landscape 60 fps: caches estáticas, LOD lejano, rejilla espacial de behind(), salones cacheados y modo DVR', { timeout: 180_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium ausente: el renderizador no se ejercitó.'); return; }
  const server = await createServer(); await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await page.addInitScript('window.__name=value=>value');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__v22_60fps.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"><canvas style="width:1536px;height:1024px"></canvas></body>' }));
    await page.goto(new URL('__v22_60fps.html', server.resolvedUrls!.local[0]).href);
    const result = await page.evaluate(async () => {
      const landscapePath = '/src/client/landscape.ts', artPath = '/src/client/structure-art.ts', typesPath = '/src/shared/types.ts';
      const { Landscape } = await import(/* @vite-ignore */ landscapePath);
      const { paintModularHall, structureExtent, footprintCells } = await import(/* @vite-ignore */ artPath);
      const { PROTOCOL_VERSION } = await import(/* @vite-ignore */ typesPath);
      (window as unknown as { requestAnimationFrame: (cb: unknown) => number }).requestAnimationFrame = () => 0; // el bucle se maneja a mano
      const W = 96, H = 64, PEOPLE = 300;
      const rng = (n: number): number => { let x = (n * 2654435761) >>> 0; x ^= x >>> 13; x = Math.imul(x, 1274126177) >>> 0; return (x ^ (x >>> 16)) / 4294967296; };
      const tiles = Array.from({ length: W * H }, (_, i) => {
        const x = i % W, y = Math.floor(i / W), forest = rng(i + 1) < .38;
        return { x, y, terrain: 'meadow', biome: forest ? 'forest' : 'grassland', feature: forest ? 'tree' : 'none', wood: forest ? 12 : 0, growth: 1, vegetation: forest ? 1 : .5, moisture: .5, food: .1, life: 0, drinkingWater: 0 };
      });
      const person = (i: number, shift: number) => ({ id: `p${i}`, name: `P${i}`, role: 'neighbor', x: 4 + rng(i + 900) * (W - 8) + shift, y: 4 + rng(i + 1900) * (H - 8), color: '#c4a87c', action: 'wander', reason: 'x', energy: 1, hunger: 0, fatigue: 0, need: 'none', recentMemory: null });
      const hall = (id: string, x: number, y: number, cells: { x: number; y: number }[] | undefined, components: string[], extra = {}) => ({ id, x, y, blueprintId: 'b', name: id, components, condition: .9, water: .4, food: .3, uses: 3, builtAt: 0, builderId: null, ...(cells ? { cells } : { footprint: { width: 2, height: 1 } }), ...extra });
      const structures = [
        hall('hall-L', 20, 20, [{ x: 20, y: 20 }, { x: 20, y: 21 }, { x: 21, y: 21 }], ['frame', 'roof', 'hearth', 'cistern'], { storedWood: 5, storedStone: 3 }),
        hall('hall-T', 50, 40, [{ x: 50, y: 40 }, { x: 51, y: 40 }, { x: 52, y: 40 }, { x: 51, y: 41 }], ['frame', 'roof', 'granary', 'hearth']),
        hall('hall-2x1', 70, 12, undefined, ['frame', 'roof', 'hearth', 'cistern']),
      ];
      const world = (tick: number, shift: number, structuresRef = structures, tilesRef = tiles) => ({
        version: PROTOCOL_VERSION, sequence: tick, tick, day: 1, phase: 'day', weather: 'clear', width: W, height: H, originX: 0, originY: 0,
        tiles: tilesRef, people: Array.from({ length: PEOPLE }, (_, i) => person(i, shift)), animals: [], structures: structuresRef, places: [], events: [], memories: [],
      });
      const mount = (reduce: boolean) => {
        const canvas = document.querySelector('canvas')!;
        const r: any = new Landscape(canvas, () => {});
        r.resize(); r.minZoom = 2; r.reduceMotion = reduce;
        return r;
      };
      const setCam = (r: any, zoom: number) => { r.cam.zoom = zoom; r.cam.x = W / 2; r.cam.y = H / 2; r.sceneKey = ''; };
      const out: Record<string, unknown> = {};

      /* ---- A. structuredTiles una vez por cambio de estructuras, no por fotograma ---- */
      {
        const r = mount(false); r.setDvrMode(true);
        r.update(world(1, 0)); setCam(r, 8);
        const builds0 = r.getPerfCounters().structuredTileBuilds;
        for (let i = 0; i < 40; i++) { r.update(world(2 + i, i * .05)); r.frame(1000 + i * 16); }
        const builds1 = r.getPerfCounters().structuredTileBuilds;
        r.update(world(99, 0, structures.slice())); // otra referencia de estructuras
        const builds2 = r.getPerfCounters().structuredTileBuilds;
        out.structured = { builds0, builds1, builds2, cells: r.structuredTiles.size, expectedCells: 3 + 4 + 2 };
        r.destroy();
      }

      /* ---- B. LOD lejano con la gente moviéndose: capa estática + sin behind() ---- */
      {
        const r = mount(false); r.setDvrMode(true);
        r.update(world(1, 0)); setCam(r, 8);
        r.update(world(2, 1));
        const c0 = r.getPerfCounters();
        let moving = 0;
        for (let i = 0; i < 40; i++) { r.frame(performance.now()); if (r.sceneKey) moving++; }
        const c1 = r.getPerfCounters();
        out.far = {
          farLod: c1.farLod, dvrMode: c1.dvrMode, sceneBuilds: c1.sceneBuilds - c0.sceneBuilds,
          propsBuilds: c1.scenePropsBuilds - c0.scenePropsBuilds, canopyBuilds: c1.canopyBuilds - c0.canopyBuilds, canopyBlits: c1.canopyBlits - c0.canopyBlits,
          behindQueries: c1.behindQueries - c0.behindQueries, behindTests: c1.behindCandidateTests - c0.behindCandidateTests, behindSkipped: c1.behindSkipped - c0.behindSkipped,
          trees: r.sceneProps.props.filter((s: { kind: number }) => s.kind === 0).length, sorted: c1.spritesSorted - c0.spritesSorted, drawCalls: r.drawCalls, playback: r.playback.size, motion: r.peopleMotion.size, moving,
        };
        r.destroy();
      }

      /* ---- C. LOD cercano: behind() con rejilla espacial = misma semántica que el bucle O(árboles × gente) ---- */
      {
        const r = mount(true); // movimiento reducido: los cuerpos están exactamente en p.x, p.y
        const w = world(1, 0);
        r.update(w); setCam(r, 24);
        r.frame(1000);
        const c = r.getPerfCounters();
        const diag = r.getDiagnostics();
        // Bucle original, sobre los mismos sprites y cuerpos.
        const covered = new Set<string>();
        const bodies = w.people;
        const behindNaive = (ay: number, ax: number, height: number, width: number): void => {
          for (const body of bodies) {
            const x = body.x * 16 + 8, foot = body.y * 16 + 12;
            if (foot < ay && Math.abs(x - ax) < width / 2 + 4 && foot + 2 > ay - height && foot - 14 < ay - 8) covered.add(body.id);
          }
        };
        const x0 = Math.max(0, Math.floor(r.cam.x - r.cssW / r.cam.zoom / 2) - 1), x1 = Math.min(W - 1, Math.ceil(r.cam.x + r.cssW / r.cam.zoom / 2) + 1);
        const y0 = Math.max(0, Math.floor(r.cam.y - r.cssH / r.cam.zoom / 2) - 3), y1 = Math.min(H - 1, Math.ceil(r.cam.y + r.cssH / r.cam.zoom / 2) + 3);
        let trees = 0;
        for (const s of r.sceneProps.sprites) if (s.kind === 0) { trees++; behindNaive(s.ay, s.ax, s.tree.height, s.tree.width); }
        for (const st of w.structures) {
          const ext = structureExtent(st), cells = footprintCells(st);
          const bx0 = Math.min(...cells.map((q: { x: number }) => q.x)), bx1 = Math.max(...cells.map((q: { x: number }) => q.x)), by0 = Math.min(...cells.map((q: { y: number }) => q.y)), by1 = Math.max(...cells.map((q: { y: number }) => q.y));
          if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
          behindNaive(ext.foot, (bx0 + (bx1 - bx0 + 1) / 2) * 16, Math.max(28, ext.foot - ext.top), Math.max(30, ext.right - ext.left));
        }
        out.near = { farLod: c.farLod, queries: c.behindQueries, tests: c.behindCandidateTests, naiveTests: c.behindQueries * PEOPLE, cutaways: diag.bodyCutaways, expectedCutaways: covered.size, trees, skipped: c.behindSkipped };
        r.destroy();
      }

      /* ---- D. Pixel a pixel: capa estática lejana == dibujo Y-ordenado cercano (sin gente, sin vaivenes) ---- */
      {
        const r = mount(true);
        const w = { ...world(1, 0), people: [] as unknown[], structures: [] as unknown[] };
        r.update(w);
        setCam(r, 15); r.frame(1000);
        const near = r.scene.getContext('2d').getImageData(0, 0, r.scene.width, r.scene.height).data.slice();
        const nearCounters = r.getPerfCounters();
        setCam(r, 13); r.frame(1001);
        const far = r.scene.getContext('2d').getImageData(0, 0, r.scene.width, r.scene.height).data;
        let diff = 0, drawn = 0;
        for (let i = 0; i < near.length; i += 4) { if (near[i + 3]) drawn++; if (near[i] !== far[i] || near[i + 1] !== far[i + 1] || near[i + 2] !== far[i + 2] || near[i + 3] !== far[i + 3]) diff++; }
        out.parity = { diff, drawn, farLod: r.getPerfCounters().farLod, nearFar: nearCounters.farLod, blits: r.getPerfCounters().canopyBlits };
        r.destroy();
      }

      /* ---- E. Salones modulares: un drawImage cacheado, idéntico al pintado directo ---- */
      {
        const r = mount(false); r.setDvrMode(true);
        r.update(world(1, 0)); setCam(r, 24); r.update(world(2, 1));
        const h0 = r.getPerfCounters();
        for (let i = 0; i < 30; i++) r.frame(performance.now());
        const h1 = r.getPerfCounters();
        const compare = (st: any, animate: boolean, t: number) => {
          const ext = structureExtent(st), left = ext.left - 20, top = ext.top - 40, width = ext.right - ext.left + 40, height = ext.bottom - ext.top + 60;
          const direct = document.createElement('canvas'), cached = document.createElement('canvas');
          direct.width = cached.width = width; direct.height = cached.height = height;
          const dg = direct.getContext('2d')!, cg = cached.getContext('2d')!;
          dg.translate(-left, -top); cg.translate(-left, -top);
          const pose = animate ? Math.floor(t * 12) : -1;
          paintModularHall(dg, st, pose >= 0 ? pose / 12 : 0, animate);
          r.drawModularHall(cg, st, t, animate);
          const a = dg.getImageData(0, 0, width, height).data, b = cg.getImageData(0, 0, width, height).data;
          let bad = 0, painted = 0;
          for (let i = 0; i < a.length; i += 4) {
            if (a[i + 3]) painted++;
            if (Math.abs(a[i]! - b[i]!) > 2 || Math.abs(a[i + 1]! - b[i + 1]!) > 2 || Math.abs(a[i + 2]! - b[i + 2]!) > 2 || Math.abs(a[i + 3]! - b[i + 3]!) > 2) bad++;
          }
          return { bad, painted };
        };
        r.cam.zoom = 24;
        const parity = structures.map(st => ({ id: st.id, still: compare(st, false, 0), animated: compare(st, true, 1.234), animated2: compare(st, true, 7.77) }));
        // Una estructura que cambia (agua) invalida su caché; sin cambios no se repinta.
        r.drawModularHall(r.sceneCtx, structures[0], 0, false); // deja el hueco en la pose estática
        const before = r.getPerfCounters().hallBuilds;
        r.drawModularHall(r.sceneCtx, structures[0], 0, false); r.drawModularHall(r.sceneCtx, structures[0], 0, false);
        const same = r.getPerfCounters().hallBuilds - before;
        r.drawModularHall(r.sceneCtx, { ...structures[0], water: .9 }, 0, false);
        const changed = r.getPerfCounters().hallBuilds - before - same;
        out.halls = { frames: 30, builds: h1.hallBuilds - h0.hallBuilds, blits: h1.hallBlits - h0.hallBlits, parity, same, changed, slots: r.hallSlots.size };
        r.destroy();
      }

      /* ---- F. Modo DVR: sin colchón V18, con interpolación A→B; sin DVR el colchón funciona como antes ---- */
      {
        const r = mount(false); r.setDvrMode(true);
        r.update(world(1, 0)); r.update(world(2, 1));
        const sizeDvr = r.playback.size;
        const id = 'p3', now = performance.now();
        const a = world(1, 0).people[3]!.x, b = world(2, 1).people[3]!.x;
        const mid = r.peopleMotion.sample(id, now + 120);
        const dvr = { sizeDvr, tracked: r.peopleMotion.size, a, b, mid: mid?.x ?? null, moving: mid?.moving ?? null };
        r.setDvrMode(false);
        r.update(world(3, 2)); r.update(world(4, 3));
        const live = { size: r.playback.size, tracked: r.peopleMotion.size, dvrMode: r.getPerfCounters().dvrMode };
        r.destroy();
        out.dvr = { ...dvr, live };
      }
      return out;
    });
    assert.deepEqual(errors, [], 'sin excepciones en la página');
    const r = result as Record<string, any>;

    // A
    assert.equal(r.structured.builds0, 1, 'structuredTiles se calcula una vez con la primera vista');
    assert.equal(r.structured.builds1, 1, '40 ticks + 40 fotogramas con las mismas estructuras: ninguna reconstrucción');
    assert.equal(r.structured.builds2, 2, 'otra lista de estructuras = una sola reconstrucción');
    assert.equal(r.structured.cells, r.structured.expectedCells);

    // B
    assert.equal(r.far.farLod, true); assert.equal(r.far.dvrMode, true);
    assert.ok(r.far.sceneBuilds >= 30, `la escena se rehace cada fotograma con gente en movimiento (${r.far.sceneBuilds})`);
    assert.ok(r.far.trees > 1000, `muchos árboles visibles (${r.far.trees})`);
    assert.equal(r.far.propsBuilds, 1, 'sprites/ventana: UNA construcción en el primer fotograma y ninguna más (misma rejilla)');
    assert.equal(r.far.canopyBuilds, 1, 'la capa de copas se pinta una vez');
    assert.ok(r.far.canopyBlits >= 30, 'y se vuelca con un drawImage por fotograma');
    assert.equal(r.far.behindQueries, 0, 'sin behind() de cuerpos en zoom lejano');
    assert.equal(r.far.behindTests, 0);
    assert.ok(r.far.sorted < r.far.trees / 4 * 40, `solo se ordena lo vivo (${r.far.sorted} sprites en 40 fotogramas, no ${r.far.trees * 40})`);
    assert.equal(r.far.playback, 0, 'DVR: el colchón V18 no recibe fotogramas');
    assert.equal(r.far.motion, 300, 'MotionTracker sigue interpolando a toda la gente');

    // C
    assert.equal(r.near.farLod, false);
    assert.ok(r.near.queries > 500, `muchos árboles y salones consultan behind() (${r.near.queries})`);
    assert.ok(r.near.tests * 8 < r.near.naiveTests, `la rejilla espacial prueba ${r.near.tests} candidatos en vez de ${r.near.naiveTests}`);
    assert.ok(r.near.expectedCutaways > 20, `la escena de prueba tiene recortes reales (${r.near.expectedCutaways})`);
    assert.equal(r.near.cutaways, r.near.expectedCutaways, 'mismos cuerpos recortados que el bucle O(N×M) original');

    // D
    assert.ok(r.parity.drawn > 100_000, 'la escena de paridad tiene arbolado');
    assert.equal(r.parity.nearFar, false); assert.equal(r.parity.farLod, true); assert.ok(r.parity.blits >= 1);
    assert.equal(r.parity.diff, 0, 'la capa estática lejana es pixel a pixel el dibujo Y-ordenado cercano sin cuerpos');

    // E
    assert.ok(r.halls.blits >= 30 * 3, `los 3 salones se vuelcan cada fotograma (${r.halls.blits})`);
    assert.ok(r.halls.builds * 4 <= r.halls.blits, `y se hornean 4× menos de lo que se vuelcan (${r.halls.builds} para ${r.halls.blits} volcados)`);
    for (const p of r.halls.parity) for (const kind of ['still', 'animated', 'animated2'] as const) {
      assert.ok(p[kind].painted > 400, `${p.id} ${kind} pinta algo`);
      assert.ok(p[kind].bad <= p[kind].painted * .002, `${p.id} ${kind}: ${p[kind].bad} píxeles distintos del pintado directo`);
    }
    assert.equal(r.halls.same, 0, 'misma estructura = sin rehornear'); assert.equal(r.halls.changed, 1, 'estructura cambiada = un rehorneado');
    assert.ok(r.halls.slots <= 192);

    // F
    assert.equal(r.dvr.sizeDvr, 0); assert.equal(r.dvr.tracked, 300);
    assert.ok(r.dvr.mid > r.dvr.a && r.dvr.mid < r.dvr.b, `A→B se interpola (${r.dvr.a} < ${r.dvr.mid} < ${r.dvr.b})`); assert.equal(r.dvr.moving, true);
    assert.equal(r.dvr.live.dvrMode, false); assert.ok(r.dvr.live.size >= 2, 'sin DVR el colchón V18 vuelve a llenarse');
  } finally {
    await browser.close(); await server.close();
  }
});
