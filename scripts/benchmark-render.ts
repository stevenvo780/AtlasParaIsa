/** Isolated, synthetic render benchmark. Does not connect to the app or touch its database. */
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WorldView } from '../src/shared/types.js';

const label = (process.env.RENDER_LABEL ?? 'after').replace(/[^a-z0-9-]/gi, '');
const gpuMode = process.env.RENDER_GPU ?? 'default';
const animated = process.env.RENDER_SCENE === 'moving';
const animalCount = Math.max(0, Math.min(8192, Number(process.env.RENDER_ANIMALS ?? 1000) || 0));
const artifact = `artifacts/render-v4-${label}-${gpuMode}${animated ? '-moving' : ''}`;
const baselineRef = process.env.RENDER_BASELINE_REF;
const sourceCommit = execFileSync('git', ['rev-parse', '--verify', `${baselineRef ?? 'HEAD'}^{commit}`], { encoding: 'utf8' }).trim();
const baseline = baselineRef ? execFileSync('git', ['show', `${sourceCommit}:src/client/landscape.ts`], { encoding: 'utf8' }) : null;
const rendererSha256 = createHash('sha256').update(baseline ?? readFileSync('src/client/landscape.ts')).digest('hex');
const flags = gpuMode === 'hardware' ? ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'] : gpuMode === 'disabled' ? ['--disable-webgl'] : [];
const server = await createServer({ configFile: false, plugins: baseline ? [{ name: 'render-baseline', enforce: 'pre', load(id) { if (id.endsWith('/src/client/landscape.ts')) return baseline; } }] : [], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true, args: flags });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: animated ? 'no-preference' : 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript('window.__name = value => value');
  await page.route('**/__render_probe.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Render sintético aislado</title><body></body>' }));
  await page.goto(new URL('__render_probe.html', server.resolvedUrls!.local[0]).href);
  const result = await page.evaluate(async ({animated,animalCount}) => {
    document.body.innerHTML = '<canvas id="render-probe" style="position:absolute;inset:0;width:100%;height:100%"></canvas>';
    document.body.style.margin = '0';
    const path = '/src/client/landscape.ts';
    const { Landscape } = await import(/* @vite-ignore */ path);
    const counts = { fillRect: 0, drawImage: 0, groundBuilds: 0 };
    for (const key of ['fillRect', 'drawImage'] as const) {
      const original = CanvasRenderingContext2D.prototype[key];
      (CanvasRenderingContext2D.prototype[key] as (...args: unknown[]) => void) = function (this: CanvasRenderingContext2D, ...args: unknown[]) { counts[key]++; (original as (...args: unknown[]) => void).apply(this, args); };
    }
    const times: number[] = [];
    const originalRender = Landscape.prototype.render;
    Landscape.prototype.render = function (now: number) { const start = performance.now(); originalRender.call(this, now); times.push(performance.now() - start); };
    const originalBake = Landscape.prototype.bakeGround;
    if (originalBake) Landscape.prototype.bakeGround = function () { counts.groundBuilds++; return originalBake.call(this); };
    const tiles: WorldView['tiles'] = [];
    for (let y = 0; y < 56; y++) for (let x = 0; x < 88; x++) {
      const n = ((x * 31 + y * 73) % 101) / 100;
      const water = x % 19 < 3;
      tiles.push({ x, y, terrain: water ? 'water' : 'meadow', biome: water ? 'wetland' : 'forest', moisture: .7, vegetation: .85, food: .5 + n * .4, wood: 8, stone: n * 5, feature: water ? 'reeds' : n > .6 ? 'pine' : 'tree', growth: .8, cultivation: n > .9 ? .5 : 0, traffic: n > .8 ? .4 : 0 });
    }
    const people: WorldView['people'] = Array.from({ length: 20 }, (_, i) => ({ id: `probe-${i}`, name: `Habitante ${i}`, role: i === 0 ? 'S' : 'neighbor', x: 44 + (i % 7) * 2, y: 28 + Math.floor(i / 7) * 2, color: '#c89164', action: 'explore', reason: 'Escena sintética de rendimiento', energy: .8, hunger: .3, fatigue: .2, need: 'explorar', recentMemory: null }));
    const species = ['hare','deer','boar','fish','wolf','fox'] as const;
    const animals: NonNullable<WorldView['animals']> = Array.from({length:animalCount},(_,i)=>({id:`animal-probe-${i}`,species:species[i%6]!,x:24+i%40,y:16+Math.floor(i/40)%28,action:i%6===4?'hunt':i%6===0?'flee':'roam',reason:'Cuerpo sintético para medir dibujo',hunger:.4,thirst:.3,energy:.8,fatigue:.1,health:1,generation:0,parents:[],genes:{speed:.7,perception:.5,metabolism:.5,carnivory:i%6>3?.9:.1,waterEfficiency:.5,camouflage:.4},age:1000}));
    const structures: NonNullable<WorldView['structures']> = Array.from({length:12},(_,i)=>({id:`structure-${i}`,x:28+i*2,y:33,blueprintId:`blueprint-${i}`,name:'Construcción sintética',components:['frame','roof',i%2?'cistern':'granary'],condition:i%3?.9:.2,water:i%2?.5:0,food:i%2?0:.4,uses:10,builtAt:0,builderId:null}));
    const world: WorldView = { version: 4, sequence: 1, tick: 1, day: 1, phase: 'day', weather: 'clear', width: 88, height: 56, originX: 0, originY: 0, tiles, people, animals, structures, places: [], events: [], memories: [], infinite: true };
    const canvas = document.getElementById('render-probe') as HTMLCanvasElement;
    const selected: unknown[] = [];
    const landscape = new Landscape(canvas, (value: unknown) => selected.push(value));
    (window as unknown as { landscape: unknown }).landscape = landscape;
    const updateStart = performance.now(); landscape.update(world); const initialUpdateMs = performance.now() - updateStart;
    landscape.zoom(-20);
    await new Promise<void>(resolve => { let remaining = 25; function warm() { if (--remaining <= 0) resolve(); else requestAnimationFrame(warm); } requestAnimationFrame(warm); });
    times.length = 0; counts.fillRect = 0; counts.drawImage = 0; counts.groundBuilds = 0;
    const terrainBuildsBefore = landscape.getDiagnostics?.().terrainBuilds ?? 0;
    let movingWorld = world;
    const move = () => { movingWorld = {...movingWorld, tick: movingWorld.tick+1, sequence: movingWorld.sequence+1, people: movingWorld.people.map(p => ({...p,x:p.x+.3,y:p.y+.1})), animals: movingWorld.animals!.map((a,i)=>({...a,x:a.x+(i%2?1:-1)}))}; landscape.update(movingWorld); };
    if (animated) move();
    const begin = performance.now();
    await new Promise<void>(resolve => { let remaining = 100; function sample() { if (--remaining <= 0) resolve(); else { if (animated && remaining % 25 === 0) move(); requestAnimationFrame(sample); } } requestAnimationFrame(sample); });
    const elapsed = performance.now() - begin, frames = times.length;
    const measuredTimes = [...times], sorted = [...measuredTimes].sort((a, b) => a - b);
    const diagnostics = landscape.getDiagnostics?.() ?? null;
    const stableCounts = { ...counts };
    const changeStart = performance.now();
    const next = { ...world, sequence: 2, tick: 2, tiles: world.tiles.map(t => t.x === 44 && t.y === 28 ? { ...t, feature: 'stump', vegetation: .15, wood: 0 } : t) };
    landscape.update(next); const changedUpdateMs = performance.now() - changeStart;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const probe = document.createElement('canvas').getContext('webgl2');
    const info = probe?.getExtension('WEBGL_debug_renderer_info');
    const gpu = { available: !!probe, renderer: info ? probe!.getParameter(info.UNMASKED_RENDERER_WEBGL) : null };
    probe?.getExtension('WEBGL_lose_context')?.loseContext();
    return { scene: `1440x900, DPR1, 88x56 tiles, 20 people, ${animalCount} animals, 12 component structures, minimum zoom, ${animated ? 'moving agents and animated decoration' : 'reduced motion'}, 100 measured RAF frames`, frames, elapsedMs: elapsed, effectiveFps: frames / elapsed * 1000, renderMeanMs: measuredTimes.reduce((a,b) => a+b,0) / measuredTimes.length, renderP95Ms: sorted[Math.floor(sorted.length * .95)] ?? 0, fillRectPerFrame: stableCounts.fillRect / frames, drawImagePerFrame: stableCounts.drawImage / frames, initialUpdateMs, changedUpdateMs, groundBakeCallsDuringSample: stableCounts.groundBuilds, terrainRebuildsDuringSample: diagnostics ? diagnostics.terrainBuilds - terrainBuildsBefore : stableCounts.groundBuilds, diagnostics, afterChangeDiagnostics: landscape.getDiagnostics?.() ?? null, gpu };
  }, {animated,animalCount});
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: `${artifact}.png` });
  const report = { label, gpuMode, measuredAt: new Date().toISOString(), sourceCommit, rendererSha256, baselineRef: baselineRef ? sourceCommit : null, flags, ...result, errors };
  writeFileSync(`${artifact}.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); await server.close(); }
