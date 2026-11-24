/**
 * V24 — FPS del cliente al alejar la cámara (Chromium real, 1920×1080, `minZoom` REAL de los ajustes).
 *
 * Escena poblada: un mundo de 512×320 teselas ya explorado (en la caché espacial del cliente), una ventana del servidor de
 * 96×64 con cientos de personas y animales, estructuras y arbolado. Cada 10 fotogramas (≈ 6 ticks/s) llega un tick que
 * mueve cuerpos y parchea unas pocas teselas (como un delta de la cinta). Se mide, por zoom (cerca, medio y el máximo
 * alejamiento del perfil Ultra), el tiempo de CPU por fotograma (incluido el volcado del lienzo) y las órdenes de dibujo.
 * Las cotas de trabajo fallan si se regresa al coste de antes (LOD que no se activa, escena a resolución de arte completa,
 * rehorneado entero por tick, personas sin caché); las de tiempo de pared solo corren con `V24_FPS_BANCO=1`.
 *
 * También (sin navegador): el reproductor DVR no congela el cabezal ni vacía la cola al mover la cámara.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createBrowserTestServer as createServer } from './lib/vite.js';
import { PROTOCOL_VERSION, type WorldView } from '../src/shared/types.js';
import type { TapeChunkResponse, TapeClientDelta, TapeMetaResponse } from '../src/shared/tape.js';
import { DVR_LIMITS, DvrPlayer, type DvrChunkRequest, type DvrFrameInfo } from '../src/client/dvr-player.js';

const PRINT = process.env.V24_FPS_PRINT === '1';
/** Los umbrales de tiempo de pared solo valen en una máquina tranquila: `V24_FPS_BANCO=1` los activa fuera de `npm test`. */
const BANCO = process.env.V24_FPS_BANCO === '1';

interface ZoomMetrics { zoom: number; frames: number; meanMs: number; p95Ms: number; maxMs: number; opsPerFrame: number; rebakes: number; tilePatches: number; sceneW: number; sceneH: number; farLod: boolean; lod: string; visibleTiles: number; chunks: number; }
interface BenchResult { zooms: ZoomMetrics[]; layered: ZoomMetrics[]; sweep: { frames: number; meanMs: number; p95Ms: number; maxMs: number }; personBuilds: number; minZoom: number; errors: string[] }

test('Landscape: coste por fotograma acotado al alejar (1920×1080, minZoom real)', { timeout: 300_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium ausente: el renderizador no se ejercitó.'); return; }
  const server = await createServer(); await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.addInitScript('window.__name=value=>value');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__v24_fps.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0;overflow:hidden"><div style="position:relative;width:1920px;height:1080px"><canvas style="position:absolute;inset:0;width:1920px;height:1080px"></canvas></div></body>' }));
    await page.goto(new URL('__v24_fps.html', server.resolvedUrls!.local[0]).href);
    const result = await page.evaluate(async () => {
      const paths = ['/src/client/landscape.ts', '/src/client/tile-cache.ts', '/src/client/graphics-settings.ts', '/src/shared/types.ts'];
      const { Landscape } = await import(/* @vite-ignore */ paths[0]!);
      const { ClientTileCache } = await import(/* @vite-ignore */ paths[1]!);
      const { PRESET_SETTINGS } = await import(/* @vite-ignore */ paths[2]!);
      const { PROTOCOL_VERSION } = await import(/* @vite-ignore */ paths[3]!);
      (window as unknown as { requestAnimationFrame: (cb: unknown) => number }).requestAnimationFrame = () => 0; // el bucle se maneja a mano

      /* ---- Contador de órdenes de dibujo (todas las de Canvas2D que pintan) ---- */
      let ops = 0;
      const proto = CanvasRenderingContext2D.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const name of ['fillRect', 'drawImage', 'fill', 'stroke', 'strokeRect', 'clearRect', 'putImageData', 'fillText']) {
        const original = proto[name]!;
        proto[name] = function (this: unknown, ...args: unknown[]) { ops++; return original.apply(this, args); };
      }

      /* ---- Mundo explorado de 512×320 teselas ---- */
      const W = 512, H = 320;
      const rng = (n: number): number => { let x = (n * 2654435761) >>> 0; x ^= x >>> 13; x = Math.imul(x, 1274126177) >>> 0; return (x ^ (x >>> 16)) / 4294967296; };
      const noise = (x: number, y: number): number => Math.sin(x * .07) + Math.cos(y * .09) + Math.sin((x + y) * .031) * .8;
      const makeTile = (x: number, y: number, food = .2) => {
        const n = noise(x, y), r = rng(y * W + x + 7);
        const water = n < -1.35, forest = !water && (n > .6 ? r < .7 : r < .18), crop = !water && !forest && r > .93;
        return {
          x, y, terrain: water ? 'water' : 'meadow', biome: water ? 'ocean' : forest ? 'forest' : 'grassland',
          feature: forest ? (r < .1 ? 'pine' : 'tree') : !water && r > .88 ? (r > .97 ? 'reeds' : 'berries') : 'none',
          wood: forest ? 6 + Math.floor(r * 10) : 0, stone: r > .95 ? 2 : 0, growth: .4 + r * .6, vegetation: water ? 0 : .3 + r * .6,
          moisture: water ? 1 : .3 + (n + 2) * .12, food: crop ? .8 : food, fertility: .5, cultivation: crop ? .7 : 0, traffic: r > .985 ? .4 : 0,
          drinkingWater: water ? 1 : 0, elevation: (n + 2) * .2, life: .3,
        };
      };
      const all = new Map<number, ReturnType<typeof makeTile>>();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) all.set(y * W + x, makeTile(x, y));
      const cache = new ClientTileCache(4096);
      cache.ingest([...all.values()], 0);

      /* ---- Ventana del servidor (96×64) con cuerpos, estructuras y comunidades ---- */
      const CX = 256, CY = 160, SW = 96, SH = 64, OX = CX - SW / 2, OY = CY - SH / 2;
      const PEOPLE = 600, ANIMALS = 300, STRUCTURES = 40;
      const actions = ['explore', 'forage', 'farm', 'build', 'rest', 'drink', 'eat', 'gather', 'hunt', 'share', 'cooperate', 'craft'];
      const communities = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, color: ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085', '#2c3e50', '#f39c12'][i], x: OX + 10 + i * 10, y: OY + 30, members: 40, culture: { sharing: .6, stewardship: .4, openness: .55 } }));
      const people = (tick: number) => Array.from({ length: PEOPLE }, (_, i) => {
        const walking = i % 2 === 0, phase = Math.floor(tick / 1);
        return {
          id: `p${i}`, name: `P${i}`, role: i === 0 ? 'S' : i === 1 ? 'I' : 'neighbor', color: '#c4a87c',
          x: OX + 2 + Math.floor(rng(i + 900) * (SW - 4)) + (walking ? (phase % 6) * .5 : 0), y: OY + 2 + Math.floor(rng(i + 1900) * (SH - 4)),
          action: actions[i % actions.length], reason: 'x', energy: 1, hunger: i % 17 === 0 ? .9 : .2, fatigue: 0, thirst: .2, need: 'none', recentMemory: null,
          communityId: i % 3 === 0 ? null : `c${i % 8}`, lifeStage: i % 11 === 0 ? 'juvenile' : i % 13 === 0 ? 'senescent' : 'adult', health: i % 29 === 0 ? .3 : 1,
        };
      });
      const species = ['hare', 'deer', 'boar'];
      const animals = (tick: number) => Array.from({ length: ANIMALS }, (_, i) => ({
        id: `a${i}`, species: species[i % 3], x: OX + 2 + Math.floor(rng(i + 5000) * (SW - 4)) + (i % 2 ? (tick % 4) * .5 : 0), y: OY + 2 + Math.floor(rng(i + 6000) * (SH - 4)),
        action: i % 4 ? 'roam' : 'graze', reason: 'x', hunger: .2, thirst: .2, energy: 1, fatigue: 0, health: 1, generation: i % 5, parents: [],
        genes: { speed: rng(i + 1) , perception: .5, camouflage: rng(i + 2), carnivory: i % 3 === 2 ? .7 : .1, size: .5, fertility: .5, longevity: .5 }, age: 900 + i,
      }));
      const structures = Array.from({ length: STRUCTURES }, (_, i) => {
        const x = OX + 4 + (i * 7) % (SW - 8), y = OY + 4 + Math.floor(i * 7 / (SW - 8)) * 9 + (i % 3);
        const modular = i % 4 === 0;
        return { id: `s${i}`, x, y, blueprintId: 'b', name: `S${i}`, components: modular ? ['frame', 'roof', 'hearth', 'cistern'] : ['frame', 'roof'], condition: .9, water: .3, food: .2, uses: 2, builtAt: 0, builderId: null,
          ...(modular ? { cells: [{ x, y }, { x: x + 1, y }, { x, y: y + 1 }] } : {}) };
      });
      const serverTiles = (): ReturnType<typeof makeTile>[] => { const out = []; for (let y = OY; y < OY + SH; y++) for (let x = OX; x < OX + SW; x++) out.push(all.get(y * W + x)!); return out; };
      let tiles = serverTiles();
      const structuresRef = structures;
      const frameAt = (tick: number) => ({
        version: PROTOCOL_VERSION, sequence: tick, tick, day: 3, phase: 'day', weather: 'clear', width: SW, height: SH, originX: OX, originY: OY,
        tiles, people: people(tick), animals: animals(tick), structures: structuresRef, places: [], events: [], memories: [], communities,
      });
      /** Un tick de la cinta: 3 teselas parcheadas (objetos nuevos) en un arreglo nuevo, como `applyClientTapeDelta`. */
      const nextTick = (tick: number) => {
        const changed = [];
        tiles = tiles.slice();
        for (let k = 0; k < 3; k++) {
          const i = (tick * 977 + k * 331) % tiles.length, old = tiles[i]!;
          const patched = { ...old, food: (old.food + .37) % 1 };
          tiles[i] = patched; all.set(patched.y * W + patched.x, patched); changed.push(patched);
        }
        return { frame: frameAt(tick), changed };
      };

      const canvas = document.querySelector('canvas')!;
      const r: any = new Landscape(canvas, () => {}, undefined, undefined, { modo: 'completo' });
      r.setTileCache(cache);
      r.setGraphicsSettings({ ...PRESET_SETTINGS.ultra });
      r.setDvrMode(true);
      let tick = 1;
      r.update(frameAt(tick));
      const flush = (): void => { (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, 1, 1); };
      const percentile = (values: number[], p: number): number => { const s = values.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
      let clock = performance.now();
      const frameErrors: string[] = [];
      const step = (frameIndex: number): number => {
        if (frameIndex % 10 === 0) { tick++; const { frame, changed } = nextTick(tick); cache.ingest(changed, tick); r.update(frame, changed); }
        clock += 1000 / 60;
        const t0 = performance.now();
        try { r.frame(clock); flush(); } catch (error) { frameErrors.push(`zoom ${r.cam.zoom.toFixed(1)}: ${(error as Error).message.slice(0, 120)}`); }
        return performance.now() - t0;
      };
      const zoomMetrics = (zoom: number): ZoomMetrics => {
        r.cam.zoom = zoom; r.cam.x = CX; r.cam.y = CY; r.followedId = null;
        for (let i = 0; i < 30; i++) step(i); // calentamiento: ventana, horneado y cachés de esta cámara
        const times: number[] = []; const ops0 = ops;
        const bakes = () => { const c = r.getPerfCounters(); return { rebakes: c.terrainBakes + c.mapChunkBuilds + c.canopyChunkBuilds, tilePatches: c.tilePatches }; };
        const work0 = bakes();
        const FRAMES = 120;
        for (let i = 0; i < FRAMES; i++) times.push(step(i));
        const counters = r.getPerfCounters(), diag = r.getDiagnostics(), work = bakes();
        return { zoom, frames: FRAMES, meanMs: times.reduce((a, b) => a + b, 0) / FRAMES, p95Ms: percentile(times, .95), maxMs: Math.max(...times), opsPerFrame: (ops - ops0) / FRAMES,
          rebakes: work.rebakes - work0.rebakes, tilePatches: work.tilePatches - work0.tilePatches,
          sceneW: r.scene.width, sceneH: r.scene.height, farLod: counters.farLod, lod: String(counters.lod ?? (counters.farLod ? 'far' : 'near')), visibleTiles: diag.visibleTiles, chunks: r.chunks.length };
      };
      const minZoom = r.minZoom as number;
      const zooms = [32, 12, minZoom].map(zoomMetrics);
      // Barrido: alejar de 32 a minZoom en 90 fotogramas (rueda continua) con ticks llegando.
      r.cam.zoom = 32; r.cam.x = CX; r.cam.y = CY;
      for (let i = 0; i < 20; i++) step(i);
      const sweepTimes: number[] = [];
      for (let i = 0; i < 90; i++) { r.cam.zoom = 32 * Math.pow(minZoom / 32, (i + 1) / 90); sweepTimes.push(step(i)); }
      const personBuilds = (r.getPerfCounters().personSpriteBuilds ?? -1) as number;
      // Capas de datos + mapa de calor + capa clásica encendidas, lejos y en el mapa: imágenes parcheadas, no una orden por tesela.
      r.setActiveLayers(new Set(['food', 'water', 'activeRegions'])); r.setCapaCalor?.('comida'); r.setLayer?.('moisture');
      const layered = [12, minZoom].map(zoomMetrics);
      r.destroy();
      return { zooms, layered, sweep: { frames: 90, meanMs: sweepTimes.reduce((a, b) => a + b, 0) / 90, p95Ms: percentile(sweepTimes, .95), maxMs: Math.max(...sweepTimes) }, personBuilds, minZoom, errors: [...new Set(frameErrors)].slice(0, 6).concat(frameErrors.length ? [`${frameErrors.length} fotogramas con excepción`] : []) } satisfies BenchResult;
    }) as BenchResult;
    const table = result.zooms.map(z => `  zoom ${String(z.zoom).padStart(2)} px/t: media ${z.meanMs.toFixed(2)} ms · p95 ${z.p95Ms.toFixed(2)} · máx ${z.maxMs.toFixed(1)} · ${Math.round(z.opsPerFrame)} órdenes/fotograma · escena ${z.sceneW}×${z.sceneH} · nivel ${z.lod} · ${z.visibleTiles} teselas · ${z.chunks} trozos`).join('\n');
    const layeredTable = result.layered.map(z => `  con capas+calor, zoom ${String(z.zoom).padStart(2)}: media ${z.meanMs.toFixed(2)} ms · p95 ${z.p95Ms.toFixed(2)} · ${Math.round(z.opsPerFrame)} órdenes/fotograma · nivel ${z.lod}`).join('\n');
    const summary = `V24 FPS (1920×1080, minZoom ${result.minZoom}):\n${table}\n${layeredTable}\n  barrido 32→${result.minZoom}: media ${result.sweep.meanMs.toFixed(2)} ms · p95 ${result.sweep.p95Ms.toFixed(2)} · máx ${result.sweep.maxMs.toFixed(1)} · sprites de persona horneados ${result.personBuilds}`;
    if (PRINT) console.log(summary + (result.errors.length ? `\n  errores: ${result.errors.join(' | ')}` : ''));
    t.diagnostic(summary);
    assert.deepEqual(errors, [], 'sin excepciones en la página');
    assert.deepEqual(result.errors, [], 'ningún fotograma lanza (un lienzo de trozo expulsado de la caché no puede romper el bucle)');
    assert.equal(result.minZoom, 4, 'el perfil Ultra permite alejar hasta 4 px/tesela');
    const [near, mid, far] = result.zooms as [ZoomMetrics, ZoomMetrics, ZoomMetrics];
    // LOD: lejos se activa con el minZoom real (no forzado), cerca no. Al máximo alejamiento, el nivel mapa (sin suelo a 16 px/tesela).
    assert.equal(near.farLod, false); assert.equal(far.farLod, true); assert.equal(mid.farLod, true);
    assert.deepEqual(result.zooms.map(z => z.lod), ['near', 'far', 'map']);
    assert.equal(far.chunks, 0, 'en el mapa no se hornean ni vuelcan trozos de suelo a resolución completa');
    // La escena nunca se pinta a 16 px/tesela sobre todo lo visible al alejar: su tamaño se acota al de la pantalla.
    for (const z of result.zooms) assert.ok(z.sceneW * z.sceneH <= 1920 * 1080 * 1.6, `zoom ${z.zoom}: escena ${z.sceneW}×${z.sceneH} acotada a la pantalla`);
    // Trabajo de dibujo acotado: una imagen por capa y por bloque, no una orden por tesela.
    for (const z of [...result.zooms, ...result.layered]) assert.ok(z.opsPerFrame <= 6000, `zoom ${z.zoom}: ${Math.round(z.opsPerFrame)} órdenes de dibujo por fotograma`);
    // Trabajo por tick acotado: con la vista ya horneada, cada tesela parcheada rehace a lo sumo sus trozos vecinos
    // (4 en una esquina), más una sola pasada por lo visible; rehornear la ventana entera en cada tick lo supera.
    for (const z of [...result.zooms, ...result.layered]) {
      const vista = Math.max(z.chunks, Math.ceil(z.visibleTiles / (32 * 32)));
      assert.ok(z.tilePatches > 0, `zoom ${z.zoom}: llegaron ticks con teselas parcheadas`);
      assert.ok(z.rebakes <= 4 * z.tilePatches + vista, `zoom ${z.zoom}: ${z.rebakes} trozos rehorneados por ${z.tilePatches} teselas parcheadas`);
    }
    // Personas cacheadas por identidad + pose: unos pocos cientos de sprites para 600 personas en 400+ fotogramas.
    assert.ok(result.personBuilds >= 0 && result.personBuilds < 600 * 4, `sprites de persona horneados: ${result.personBuilds}`);
    if (!BANCO) { t.diagnostic('Umbrales de tiempo de pared omitidos (V24_FPS_BANCO=1 para medirlos).'); return; }
    // Coste por fotograma acotado: alejar no puede costar varias veces más que mirar de cerca.
    assert.ok(far.meanMs <= Math.max(8, near.meanMs * 2.5), `zoom ${far.zoom}: ${far.meanMs.toFixed(2)} ms/fotograma frente a ${near.meanMs.toFixed(2)} de cerca`);
    assert.ok(mid.meanMs <= Math.max(8, near.meanMs * 2.5), `zoom ${mid.zoom}: ${mid.meanMs.toFixed(2)} ms/fotograma`);
    // Alejar con la rueda (con ticks llegando) no da tirones catastróficos: antes, p95 ≈ 1 s por fotograma (escena de 8192×4864, rehorneado por tick).
    // El barrido parte ahora de una rejilla ajustada a lo cercano (al volver a acercar se recompone, ver `ensureWindow`): antes salía de la
    // rejilla gigante que dejaba la fase de zoom 4 y daba ≈ 30 ms; medido desde una rejilla nueva, base y esta versión rondan 90–250 ms de p95
    // con la torre a carga ≈ 50 (recomponer la ventana al cruzar de nivel es el coste real; reducirlo queda como trabajo aparte).
    assert.ok(result.sweep.p95Ms <= Math.max(400, near.p95Ms * 20), `barrido de zoom: p95 ${result.sweep.p95Ms.toFixed(2)} ms`);
    for (const z of result.layered) assert.ok(z.meanMs <= Math.max(8, near.meanMs * 2.5), `con capas, zoom ${z.zoom}: ${z.meanMs.toFixed(2)} ms/fotograma`);
  } finally {
    await browser.close(); await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* DvrPlayer: mover la cámara no congela la reproducción               */
/* ------------------------------------------------------------------ */

const tiny = (tick: number): WorldView => ({
  version: PROTOCOL_VERSION, sequence: tick, tick, day: 0, phase: 'day', weather: 'clear', width: 2, height: 1, originX: 0, originY: 0,
  tiles: [{ x: 0, y: 0, terrain: 'meadow', moisture: .5, vegetation: .5, food: 0 }, { x: 1, y: 0, terrain: 'meadow', moisture: .5, vegetation: .5, food: tick % 2 }],
  people: [{ id: 'p', name: 'P', role: 'neighbor', x: tick * .1, y: 0, color: '#fff' }], animals: [], structures: [], places: [], events: [], memories: [],
} as unknown as WorldView);

test('DvrPlayer: cambiar la cámara no detiene el cabezal ni vacía la cola; la petición en vuelo no se aborta', async () => {
  const requests: DvrChunkRequest[] = [];
  const emitted: { frame: WorldView; info: DvrFrameInfo }[] = [];
  const pending: (() => void)[] = [];
  const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) { while (pending.length) pending.shift()!(); await new Promise(r => setImmediate(r)); } };
  const meta = (): TapeMetaResponse => ({ enabled: true, observerOnly: true, turbo: true, minTick: 0, maxTick: 5000, latestDay: 2, totalFrames: 5001, keyframeInterval: 60, simHz: 100, keyframeTicks: [], timeline: [] });
  const player = new DvrPlayer({
    metaPollMs: 0, viewportCoalesceMs: 0,
    fetchMeta: async () => meta(),
    fetchChunk: request => {
      requests.push(request);
      const from = request.fromTick, to = from + request.count - 1;
      const deltas: TapeClientDelta[] = [];
      for (let tick = from + 1; tick <= to; tick++) deltas.push({ tick, sequence: tick, day: 0, phase: 'day', weather: 'clear', peoplePatch: { upserts: tiny(tick).people, removed: [] }, tilesPatch: [tiny(tick).tiles[1]!] });
      const chunk: TapeChunkResponse = { fromTick: from, toTick: to, minTick: 0, maxTick: 5000, simHz: 100, hasMore: true, encoding: 'delta', frames: [], baseFrame: tiny(from), deltas };
      // Las respuestas tardan (latencia de red al alejar): se resuelven a mano.
      return new Promise(resolve => pending.push(() => resolve(chunk)));
    },
    onFrame: (frame, info) => { emitted.push({ frame, info }); },
  });
  const started = player.start(); await settle(); assert.equal(await started, true);
  const seeking = player.seek(1000); await settle(); await seeking;
  let now = 0; player.advance(now);
  for (let i = 0; i < 60; i++) { now += 1000 / 60; player.advance(now); }
  const tickBefore = player.currentTick, queuedBefore = player.bufferedAhead, emittedBefore = emitted.length, requestsBefore = requests.length;
  assert.ok(tickBefore > 1000, 'el cabezal avanza');
  // Arrastre de cámara durante 40 fotogramas; cada respuesta tarda ~5 fotogramas.
  for (let i = 0; i < 40; i++) {
    if (i < 20) { player.setViewport({ x: 100 + i, y: 50, width: 96, height: 64 }); void player.flushViewport(); }
    now += 1000 / 60; player.advance(now);
    assert.ok(player.bufferedAhead > 0, `fotograma ${i}: la cola nunca se vacía durante el arrastre`);
    if (i % 5 === 4) await settle();
  }
  await settle();
  assert.ok(player.currentTick > tickBefore, `el cabezal siguió avanzando durante el arrastre (${tickBefore} → ${player.currentTick})`);
  assert.ok(player.bufferedAhead >= Math.min(queuedBefore, DVR_LIMITS.prefetchBelow) - 10, `la cola sigue llena (${queuedBefore} → ${player.bufferedAhead})`);
  assert.equal(requests.slice(requestsBefore - 1).filter(request => request.signal.aborted).length, 0, 'ninguna petición (ni la que volaba al empezar) se abortó por mover la cámara');
  const during = emitted.slice(emittedBefore);
  assert.ok(during.length > 0 && !during.some(e => e.info.discontinuity), 'mover la cámara no emite discontinuidades (no rehace el HUD ni colapsa la interpolación)');
  assert.ok(during.some(e => e.info.reason === 'refresh'), 'el tick visible se repinta con la ventana nueva');
  assert.ok(requests.length - requestsBefore <= 8, `las peticiones por cámara se fusionan mientras vuela una (${requests.length - requestsBefore} para 20 movimientos)`);
  assert.equal(requests.at(-1)!.viewport?.x, 119, 'los trozos siguientes usan la última cámara');
  for (let i = 1; i < during.length; i++) assert.ok(during[i]!.frame.tick >= during[i - 1]!.frame.tick, 'el tick mostrado nunca retrocede');
  player.stop();
});
