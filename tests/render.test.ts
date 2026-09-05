import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { BoundedCache, classifyRenderer } from '../src/client/gpu-terrain.js';

test('render cache evicts least-recently-used rasters and releases replaced and destroyed resources once', () => {
  const released: string[] = [];
  const cache = new BoundedCache<{ id: string }>(2, item => released.push(item.id));
  cache.set('a', { id: 'a' }); cache.set('b', { id: 'b' }); cache.get('a'); cache.set('c', { id: 'c' });
  assert.equal(cache.get('b'), undefined); assert.deepEqual(released, ['b']);
  cache.set('a', { id: 'a2' }); assert.deepEqual(released, ['b', 'a']);
  cache.clear(); cache.clear(); assert.deepEqual(released, ['b', 'a', 'c', 'a2']); assert.equal(cache.size, 0);
  assert.throws(() => new BoundedCache(0, () => {}));
});

test('render diagnostics distinguish software WebGL from physical GPU and withheld renderer identity', () => {
  assert.equal(classifyRenderer('ANGLE (NVIDIA GeForce RTX 5070 Ti)'), 'hardware');
  assert.equal(classifyRenderer('ANGLE (SwiftShader Device (Subzero))'), 'software');
  assert.equal(classifyRenderer('Mesa llvmpipe (LLVM)'), 'software');
  assert.equal(classifyRenderer('WebKit WebGL'), 'unverified');
  assert.equal(classifyRenderer(''), 'unverified');
});

test('render browser: dirty chunks, negative coordinates, selection, bounded caches and WebGL context recovery', { timeout: 60_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium executable absent: browser dirty-chunk, selection, WebGL recovery and travel-memory checks were not run.'); return; }
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, reducedMotion: 'reduce' });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name = value => value');
    await page.route('**/__render_test.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"><canvas style="position:absolute;inset:0;width:100%;height:100%"></canvas></body>' }));
    await page.goto(new URL('__render_test.html', server.resolvedUrls!.local[0]).href);
    const result = await page.evaluate(async () => {
      const path = '/src/client/landscape.ts';
      const { Landscape } = await import(/* @vite-ignore */ path);
      const canvas = document.querySelector('canvas')!;
      const selected: unknown[] = [];
      const renderer = new Landscape(canvas, (s: unknown) => selected.push(s), undefined, undefined, { allowSoftwareWebGL: true });
      const tile = (x: number, y: number) => ({ x, y, terrain: 'meadow', biome: 'forest', moisture: .7, vegetation: .8, food: .5, growth: .7, feature: 'tree', wood: 4, drinkingWater: .4 });
      const tiles = Array.from({length: 32*24}, (_, i) => tile(i%32-16, Math.floor(i/32)-8));
      const world = {version: 3, sequence: 1, tick: 1, day: 1, phase: 'day', weather: 'clear', width: 32, height: 24, originX: -16, originY: -8, tiles, people: [], events: [], places: [], memories: []};
      const serialize = JSON.stringify(world);
      renderer.update(world); renderer.focus(0,0); renderer.render(0);
      const first = renderer.getDiagnostics();
      renderer.update({...world, sequence: 2, tick: 2}); renderer.render(0);
      const same = renderer.getDiagnostics();
      const changed = {...world, sequence: 3, tick: 3, tiles: tiles.map(p => p.x===0 && p.y===0 ? {...p, feature: 'stump', wood: 0, growth: .1, vegetation: .1} : p)};
      renderer.update(changed); renderer.render(0);
      const dirty = renderer.getDiagnostics();
      // A rain pool remains a visible drinking source even when the surrounding desert is dry.
      const poolPixels = (feature: 'pool' | 'none', drinkingWater: number) => {
        const art = document.createElement('canvas'); art.width = art.height = 16; const pen = art.getContext('2d')!;
        renderer.bakeFeatures(pen, { x: 0, y: 0, terrain: 'soil', biome: 'desert', moisture: .25,
          vegetation: .1, food: 0, growth: .1, feature, drinkingWater });
        return [...pen.getImageData(0, 0, 16, 16).data];
      };
      const wetPool = poolPixels('pool', .5), dryPool = poolPixels('pool', 0), drySoil = poolPixels('none', 0);
      const worldPoint = renderer.worldToScreen(.5,.5);
      canvas.dispatchEvent(new PointerEvent('pointerdown', {pointerId:1,clientX:worldPoint.x,clientY:worldPoint.y,button:0,bubbles:true}));
      canvas.dispatchEvent(new PointerEvent('pointerup', {pointerId:1,clientX:worldPoint.x,clientY:worldPoint.y,button:0,bubbles:true}));
      renderer.focus(-.5,-.5); // Fractional camera focus remains finite across negative chunks.
      const camera = renderer.camera();
      const preserved = JSON.stringify(world) === serialize;
      const gl = renderer.gpu.gl;
      const glError = gl?.getError() ?? 0;
      const lose = gl?.getExtension('WEBGL_lose_context');
      (window as unknown as { renderTest: unknown }).renderTest = { renderer, world, lose };
      if (lose) lose.loseContext();
      return {first,same,dirty,wetPool,dryPool,drySoil,selected,camera,preserved,glError,canLose:!!lose};
    });
    assert.equal(result.same.cacheBuilds, result.first.cacheBuilds, 'unchanged world does not rerasterize terrain or sprites');
    assert.ok(result.dirty.cacheBuilds > result.same.cacheBuilds, 'depletion changes ground artwork');
    assert.ok(result.dirty.cacheBuilds - result.same.cacheBuilds <= 4, 'corner edit invalidates no more than four adjacent chunks');
    assert.ok(result.wetPool.some((value, index) => index % 4 === 3 && value > 0), 'potable pool is drawn in dry terrain');
    assert.ok(result.dryPool.some((value, index) => index % 4 === 3 && value > 0), 'depleted pool leaves a visible dry bed');
    assert.notDeepEqual(result.wetPool, result.dryPool, 'depletion visibly removes the pool water');
    assert.ok(result.drySoil.every(value => value === 0), 'ordinary dry soil does not invent a water feature');
    assert.deepEqual(result.selected, [{kind:'tile',x:0,y:0}]);
    assert.equal(result.preserved, true, 'drawing never mutates authoritative snapshots');
    assert.equal(result.glError, 0, 'shader, upload and compositing produce no WebGL errors');
    assert.ok(Number.isFinite(result.camera.x) && Number.isFinite(result.camera.y));
    if (result.canLose) {
      await page.waitForFunction('window.renderTest.renderer.getDiagnostics().gpuStatus === "context-lost"');
      const fallback = await page.evaluate<{backend:string}>('window.renderTest.renderer.getDiagnostics()');
      assert.equal(fallback.backend, 'canvas2d-cached');
      assert.equal(await page.evaluate<number>('window.renderTest.renderer.render(0); window.renderTest.renderer.ctx.getImageData(0,0,1,1).data[3]'), 255, 'fallback paints the projection while WebGL is lost');
      await page.evaluate('window.renderTest.lose.restoreContext()');
      await page.waitForFunction('window.renderTest.renderer.getDiagnostics().backend === "webgl2"');
      assert.equal(await page.evaluate('window.renderTest.renderer.gpu.gl.getError()'), 0);
    } else t.diagnostic('WebGL unavailable: context-loss/recovery not exercised; cached Canvas2D path exercised.');
    const travel = await page.evaluate(() => {
      const state = (window as unknown as {renderTest: {renderer: any;world:any}}).renderTest;
      const renderer = state.renderer;
      for (let stop = 1; stop <= 16; stop++) {
        const shift = stop * 64;
        renderer.update({...state.world, tick: stop+5, sequence: stop+5, originX: state.world.originX+shift, tiles: state.world.tiles.map((tile: {x:number}) => ({...tile, x: tile.x+shift}))});
        renderer.focus(shift,0); renderer.render(0);
      }
      return renderer.getDiagnostics();
    });
    assert.ok(travel.cacheBytes <= 10*1024*1024, 'CPU raster caches stay within 10 MiB while travelling');
    assert.ok(travel.gpuTextureBytes <= 8*1024*1024, 'evicted chunks release GPU textures within 8 MiB');
    assert.ok(travel.cacheEntries <= 640);
    const cleanup = await page.evaluate(() => {
      const state = (window as unknown as {renderTest: {renderer: {destroy():void;getDiagnostics():{cacheEntries:number}}}}).renderTest;
      state.renderer.destroy(); return { count: document.querySelectorAll('[data-renderer="webgl2-terrain"], [data-landscape-layer]').length, entries: state.renderer.getDiagnostics().cacheEntries };
    });
    assert.deepEqual(cleanup, { count: 0, entries: 0 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
