import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { BoundedCache, classifyRenderer } from '../src/client/gpu-terrain.js';
import { animalPose, daylightAt, newEventAccents, VISUAL_BUDGET } from '../src/client/visual-state.js';
import type { WorldView } from '../src/shared/types.js';
import { technologyPane } from '../src/client/technology-art.js';
import type { TechnologyView } from '../src/shared/technology.js';

test('visual time presents received daylight continuously and never makes an idle animal walk', () => {
  for (const boundary of [0, 140, 300, 340, 1300, 1500, 1590, 1800, 1840, 2220, 2400]) {
    const before = daylightAt(boundary - .001), after = daylightAt(boundary + .001);
    assert.ok(Math.abs(before.alpha - after.alpha) < .001, `light continuity at ${boundary}`);
    assert.ok(Number.isFinite(after.shadowX) && Number.isFinite(after.shadowY));
  }
  assert.deepEqual(daylightAt(900), daylightAt(3300), 'same model phase repeats exactly');
  assert.ok(daylightAt(2100).alpha > daylightAt(900).alpha, 'night remains distinct from day');
  for (const action of ['roam', 'hunt', 'flee', 'rest'] as const) assert.equal(animalPose({action}, false, 4.3, false, true), 0, 'no stepping without position changes');
  assert.equal(animalPose({action:'graze'}, false, .6, false, true), 1);
  assert.equal(animalPose({action:'graze'}, false, .6, false, false), 0, 'stale or paused snapshots stop action cycles');
  assert.equal(animalPose({action:'flee'}, true, .3, true, true), 0, 'reduced motion freezes the gait');
});

test('event accents acknowledge only newly received located simulation facts and have a hard bound', () => {
  const previous = {tick:100,events:[]} as unknown as WorldView;
  const event = {id:'new-birth',tick:101,kind:'birth',source:'simulation',x:0,y:0,actors:[],text:'Synthetic birth',cause:'Synthetic server event'} as const;
  const next = {...previous,tick:101,events:[{...event,actors:[]}]} as WorldView;
  assert.deepEqual(newEventAccents(null,next,1000), [], 'initial history never replays');
  assert.equal(newEventAccents(previous,next,1000).length, 1);
  assert.deepEqual(newEventAccents(next,next,1001), [], 'same-tick camera response never replays');
  assert.deepEqual(newEventAccents(previous,{...next,paused:true},1000), []);
  assert.deepEqual(newEventAccents(next,previous,1000), [], 'recovery to an older world never replays');
  for (const events of [[{...event,actors:[],source:'sample' as const}], [{...event,actors:[],tick:100}], [{...event,actors:[],tick:102}], [{...event,actors:[],x:undefined}], [{...event,actors:[],kind:'gesture' as const}]]) {
    assert.deepEqual(newEventAccents(previous,{...next,events},1000), []);
  }
  const burst = {...next,events:Array.from({length:300},(_,i)=>({...event,actors:[],id:`event-${i}`}))};
  assert.equal(newEventAccents(previous,burst,1000).length,VISUAL_BUDGET.events);
});

test('technology notebook escapes recipe text and bounds expanded history', () => {
  const technology = {dynamics:{recipes:30,products:1,toolUses:2,generations:3,importedMass:1000,productMass:900,residueMass:100,massError:0,attempts:2,failures:0},recipes:Array.from({length:30},(_,i)=>({id:`recipe-${i}`,name:'<img src=x onerror=alert(1)>',generation:1,program:{inputs:[{source:'raw',material:'wood',mass:1000}],steps:[{op:'form',intensity:.5}]},capacities:{cutting:.5},manufactured:1,uses:2,utility:.2,parents:['<script>bad</script>']}))} as unknown as TechnologyView;
  const html = technologyPane(technology);
  assert.ok(!html.includes('<img ') && !html.includes('<script>'));
  assert.ok(html.includes('&lt;img ') && html.includes('&lt;script&gt;'));
  assert.equal((html.match(/class="person-detail technology-recipe"/g) ?? []).length,20);
  assert.ok(html.includes('Se muestran 20 procedimientos de esta vista'));
  assert.ok(!html.includes('NaN') && !html.includes('Infinity'));
  assert.match(technologyPane(),/Todavía no se recibieron/,'absent projection stays explicitly absent');
});

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
      const world = {version: 4, sequence: 1, tick: 1, day: 1, phase: 'day', weather: 'clear', width: 32, height: 24, originX: -16, originY: -8, tiles, people: [], events: [], places: [], memories: []};
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
    const life = await page.evaluate(async () => {
      const { renderer, world } = (window as unknown as {renderTest: {renderer: any;world:any}}).renderTest;
      const selected: unknown[] = []; renderer.onSelect = (value: unknown) => selected.push(value);
      const animal = { id: 'observed-deer', species: 'deer', x: -3, y: -2, action: 'flee', reason: 'Un lobo se aproxima.', hunger: .2, thirst: .3, energy: .7, fatigue: .2, health: 1, generation: 1, parents: ['deer-parent'], genes: {speed:.7,perception:.8,metabolism:.5,carnivory:.1,waterEfficiency:.6,camouflage:.3}, age: 800 };
      let legacyDraws = 0; renderer.drawFauna = () => legacyDraws++;
      const state = {...world, tick: 10, sequence: 10, animals: [animal], tiles: world.tiles.map((t: object) => ({...t, species:'deer',fauna:2}))};
      renderer.update(state); renderer.reduceMotion = false;
      const next = {...state, tick: 11, sequence: 11, animals: [{...animal,x:-2}]}; const serialized = JSON.stringify(next);
      renderer.update(next); renderer.currAt = 0; renderer.interval = 500;
      const midpoint = renderer.interpolateAnimals(250)[0]; const completed = renderer.interpolateAnimals(1000)[0];
      renderer.reduceMotion = true; renderer.focus(-2,-2); renderer.render(1000);
      const screen = renderer.worldToScreen(-1.5,-1.5); renderer.pick(screen.x,screen.y);
      const preserved = serialized === JSON.stringify(next);
      renderer.update({...next,tick:12,sequence:12,animals:[]}); renderer.render(1100);
      const removed = renderer.getDiagnostics().visibleAnimals;
      renderer.update({...next,tick:13,sequence:13,animals:[animal,...Array.from({length:6000},(_,i)=>({...animal,id:`far-${i}`,x:10000+i,y:10000}))]}); renderer.render(1200);
      const visible = renderer.getDiagnostics().visibleAnimals;
      const path = '/src/client/life-art.ts'; const {paintAnimal,paintStructure} = await import(/* @vite-ignore */ path);
      const raster = (paint: (pen: CanvasRenderingContext2D)=>void) => { const canvas = document.createElement('canvas');canvas.width=canvas.height=32; const pen=canvas.getContext('2d')!;paint(pen);return [...pen.getImageData(0,0,32,32).data].join(','); };
      const species = ['hare','deer','boar','fish','wolf','fox'].map(name => raster(pen=>paintAnimal(pen,name,'roam',0)));
      const base = {id:'s',x:0,y:0,blueprintId:'b',name:'Proyecto',components:['frame','roof'],condition:1,water:0,food:0,uses:0,builtAt:0,builderId:null};
      const structures = [base,{...base,components:['frame','roof','cistern']},{...base,components:['frame','roof','cistern'],water:.5},{...base,components:['frame','roof','granary']},{...base,components:['frame','roof','granary'],food:.5},{...base,components:['frame','roof','garden']},{...base,components:['frame','roof','hearth']},{...base,components:['frame','roof','roof']},{...base,condition:.1}].map(s=>raster(pen=>paintStructure(pen,s)));
      return { midpoint:{x:midpoint.x,y:midpoint.y,moving:midpoint.moving}, completed:{x:completed.x,y:completed.y,moving:completed.moving}, selected, preserved, removed, visible,legacyDraws,speciesDistinct:new Set(species).size,structuresDistinct:new Set(structures).size };
    });
    assert.deepEqual(life.midpoint, {x:-2.5,y:-2,moving:true}, 'animal interpolates only between received coordinates');
    assert.deepEqual(life.completed, {x:-2,y:-2,moving:false}, 'local time cannot move beyond the authoritative endpoint');
    assert.deepEqual(life.selected, [{kind:'animal',id:'observed-deer'}], 'negative-coordinate animal can be selected directly');
    assert.equal(life.preserved,true); assert.equal(life.removed,0,'a removed identity leaves no body behind');
    assert.equal(life.legacyDraws,0,'individual snapshots never also draw tile fauna, including empty arrays');
    assert.equal(life.visible,1,'6000 off-camera animals are culled');
    assert.equal(life.speciesDistinct,6,'each animal species has distinct artwork');
    assert.equal(life.structuresDistinct,9,'components, repetitions, stocks and damage all change the drawn structure');
    const atmosphere = await page.evaluate(() => {
      const {renderer,world} = (window as unknown as {renderTest:{renderer:any;world:any}}).renderTest;
      const water = {...world,tick:900,sequence:900,weather:'rain',people:[],animals:[],events:[],tiles:world.tiles.map((tile:object)=>({...tile,terrain:'water',feature:'none'}))};
      renderer.reduceMotion = true; renderer.update(water); renderer.focus(0,0); renderer.render(performance.now());
      const first = renderer.getDiagnostics();
      const pixels = () => [...renderer.labelCtx.getImageData(0,0,640,480).data].join(',');
      const frozen = pixels(); renderer.render(performance.now()+5000); const reducedStable = frozen === pixels();
      renderer.reduceMotion = false; renderer.render(performance.now()+6000); const movingRain = frozen !== pixels();
      renderer.update({...water,tick:901,sequence:901,weather:'clear'}); renderer.render(performance.now());
      const clearRain = renderer.getDiagnostics().effects.rain;
      const next = {...water,tick:902,sequence:902,weather:'clear',events:Array.from({length:200},(_,i)=>({id:`accent-${i}`,tick:902,kind:'birth',source:'simulation',x:0,y:0,actors:[],text:'Synthetic fixture',cause:'Synthetic event'}))};
      renderer.update(next); renderer.render(performance.now()); const burst = renderer.getDiagnostics();
      renderer.render(performance.now()+3000); const expired = renderer.getDiagnostics().effects.events;
      const person = {view:{id:'worker',name:'Worker',role:'neighbor',color:'#a4805b',x:0,y:0,action:'drink',thirst:.7,hunger:.5,working:false,foodReserve:0},x:0,y:0,moving:false,seed:27};
      const drawPerson = (time:number) => {const canvas=document.createElement('canvas');canvas.width=canvas.height=32;const g=canvas.getContext('2d')!;renderer.drawPerson(g,person,time);return [...g.getImageData(0,0,32,32).data].join(',');};
      renderer.actionActive=true;renderer.prevPeople.clear();const noDebit=drawPerson(0)===drawPerson(.4);
      renderer.prevPeople.set('worker',{...person.view,thirst:.8});const debitMoves=drawPerson(0)!==drawPerson(.4);
      renderer.actionActive=false;const staleStops=drawPerson(0)===drawPerson(.4);
      renderer.actionActive=true;person.view.action='build';const noWork=drawPerson(0)===drawPerson(.4);
      person.view.working=true;const workMoves=drawPerson(0)!==drawPerson(.4);
      person.view.action='forage';person.view.working=false;const noHarvest=drawPerson(0)===drawPerson(.4);
      person.view.working=true;const harvestMoves=drawPerson(0)!==drawPerson(.4);
      const emptyPouch=drawPerson(0);person.view.foodReserve=.06;const stockVisible=emptyPouch!==drawPerson(0);
      renderer.reduceMotion=true;const reducedHarvest=drawPerson(0)===drawPerson(.4);
      renderer.reduceMotion=false;
      return {first,burst,reducedStable,movingRain,clearRain,expired,noDebit,debitMoves,staleStops,noWork,workMoves,noHarvest,harvestMoves,stockVisible,reducedHarvest};
    });
    assert.ok(atmosphere.first.effects.rain > 0 && atmosphere.first.effects.rain <= VISUAL_BUDGET.rain);
    assert.ok(atmosphere.first.effects.water > 0 && atmosphere.first.effects.water <= VISUAL_BUDGET.water);
    assert.equal(atmosphere.reducedStable,true,'reduced-motion atmosphere is pixel-stable across local time');
    assert.equal(atmosphere.movingRain,true,'confirmed rain has visible motion');
    assert.equal(atmosphere.clearRain,0,'clear weather draws no falling rain');
    assert.equal(atmosphere.burst.effects.events,VISUAL_BUDGET.events,'event burst cannot exceed the visual bound');
    assert.equal(atmosphere.expired,0,'event accents expire without another snapshot');
    assert.equal(atmosphere.noDebit,true,'a drink intention without a received debit does not animate consumption');
    assert.equal(atmosphere.debitMoves,true,'a received thirst reduction animates drinking');
    assert.equal(atmosphere.staleStops,true,'disconnected consumption cannot run indefinitely');
    assert.equal(atmosphere.noWork,true,'unconfirmed work does not swing a tool');
    assert.equal(atmosphere.workMoves,true,'confirmed stationary work moves its tool');
    assert.equal(atmosphere.noHarvest,true,'an unconfirmed harvest intention cannot collect food');
    assert.equal(atmosphere.harvestMoves,true,'confirmed harvesting reaches toward the ground');
    assert.equal(atmosphere.stockVisible,true,'pouch contents depend on received food reserve');
    assert.equal(atmosphere.reducedHarvest,true,'reduced motion freezes the harvesting pose');
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
