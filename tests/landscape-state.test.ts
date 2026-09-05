import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { treeForm } from '../src/client/life-art.js';
import type { Tile } from '../src/shared/types.js';

const tree: Tile = { x: -3, y: 4, terrain: 'meadow', biome: 'forest', feature: 'tree', variety: 2,
  wood: 12, growth: 1, vegetation: 1, moisture: .7, fertility: .8, food: .3 };

test('woody art requires declared stock and keeps growth, depletion and seeded variation causal', () => {
  for (const feature of ['tree', 'pine', 'palm'] as const) {
    assert.equal(treeForm({ ...tree, feature, wood: 0 }), null);
    assert.equal(treeForm({ ...tree, feature, wood: undefined }), null, 'missing stock cannot invent a tree');
  }
  assert.equal(treeForm({ ...tree, feature: undefined, wood: 0 }), null, 'vegetation alone is not a wood reserve');
  assert.equal(treeForm({ ...tree, feature: 'stump' }), null, 'depleted feature does not become a second live tree');
  const mature = treeForm(tree)!;
  assert.ok(mature.height >= 28 && mature.height <= 44, 'mature canopy spans two to three 14px human bodies');
  assert.ok(treeForm({ ...tree, wood: .5 })!.height < mature.height);
  assert.ok(treeForm({ ...tree, growth: .1 })!.height < mature.height);
  assert.equal(treeForm({ ...tree, vegetation: 0 })!.foliage, 0);
  const saved = JSON.stringify(tree);
  assert.deepEqual(treeForm(JSON.parse(saved) as Tile), mature);
  assert.equal(JSON.stringify(tree), saved);
  assert.notDeepEqual(treeForm({ ...tree, variety: 3 }), mature);
});

test('landscape state: ecological surfaces, material structures and canopy cutaways remain inspectable', { timeout: 60_000 }, async t => {
  if (!existsSync(chromium.executablePath())) {
    t.skip('Chromium absent: ecological raster, structure stock, occlusion, hit-target and cache checks not run.'); return;
  }
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 }, reducedMotion: 'reduce' });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name = value => value');
    await page.route('**/__state-art.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"><canvas style="position:absolute;inset:0;width:100%;height:100%"></canvas></body>' }));
    await page.goto(new URL('__state-art.html', server.resolvedUrls!.local[0]).href);
    const result = await page.evaluate(async () => {
      const module = '/src/client/landscape.ts', artModule = '/src/client/life-art.ts';
      const { Landscape } = await import(/* @vite-ignore */ module);
      const { paintStructure, paintTree, treeForm } = await import(/* @vite-ignore */ artModule);
      const selections: unknown[] = [], renderer = new Landscape(document.querySelector('canvas')!, (value: unknown) => selections.push(value));
      const tile = { x: 0, y: 0, terrain: 'meadow', biome: 'grassland', feature: 'none', moisture: .2, vegetation: .4,
        wood: 0, food: .1, growth: .5, fertility: .2, cultivation: 0, traffic: 0, drinkingWater: 0, variety: 1 };
      const tiles = Array.from({ length: 24 * 16 }, (_, i) => ({ ...tile, x: i % 24 - 12, y: Math.floor(i / 24) - 8 }));
      const world = { version: 5, tick: 900, sequence: 900, phase: 'day', day: 1, weather: 'clear', width: 24, height: 16,
        originX: -12, originY: -8, tiles, people: [], animals: [], structures: [], places: [], memories: [], events: [] };
      renderer.update(world); renderer.focus(0, 0);
      const raster = (width: number, height: number, paint: (g: CanvasRenderingContext2D) => void) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const g = canvas.getContext('2d')!; paint(g); return Array.from(g.getImageData(0, 0, width, height).data);
      };
      const ground = (change: object) => {
        renderer.update({ ...world, tiles: tiles.map(t => t.x === 0 && t.y === 0 ? { ...t, ...change } : t) });
        return raster(16, 16, g => { renderer.bakeTileBase(g, 0, 0); renderer.bakeFeatures(g, renderer.tileAt(0, 0)); });
      };
      const before = ground({}), dry = ground({ moisture: 0 }), wet = ground({ moisture: 1 }), poor = ground({ fertility: 0 }), rich = ground({ fertility: 1 });
      const bare = ground({ vegetation: 0 }), lush = ground({ vegetation: 1 }), farm = ground({ cultivation: 1 }), trail = ground({ traffic: 1 });
      renderer.update(world); renderer.render(0); const cacheBefore = renderer.getDiagnostics().terrainBuilds;
      renderer.update({ ...world, tick: 901, sequence: 901, tiles: tiles.map(t => t.x === 0 && t.y === 0 ? { ...t, fertility: 1 } : t) });
      renderer.render(0); const cacheAfter = renderer.getDiagnostics().terrainBuilds;
      const wooded = { ...tile, feature: 'tree', wood: 12, growth: 1, vegetation: 1, variety: 0 };
      const person = { id: 'visible-body', name: 'Persona de prueba', role: 'neighbor', color: '#d48060', x: 0, y: -1,
        action: 'rest', reason: 'Estado sintético', energy: .8, hunger: .2, fatigue: .1, need: 'descansar', recentMemory: null };
      const forest = { ...world, tick: 902, sequence: 902, people: [person], tiles: tiles.map(t => t.x === 0 && t.y === 0 ? wooded : t) };
      const preserved = JSON.stringify(forest); renderer.update(forest);
      const sprites: any[] = []; renderer.collectTrees(sprites, 0, 0, 0, 0);
      const empty: any[] = []; renderer.collectTrees(empty, 1, 0, 16, 0);
      let cutaways = 0; const originalTree = renderer.drawCachedTree.bind(renderer);
      renderer.drawCachedTree = (g: CanvasRenderingContext2D, sprite: unknown, time: number, occluded: boolean) => { if (occluded) cutaways++; return originalTree(g, sprite, time, occluded); };
      renderer.cam.zoom = 42; renderer.focus(0, 0); renderer.render(0);
      const bodyPixels = () => Array.from(renderer.sceneCtx.getImageData((person.x-world.originX)*16+1, (person.y-world.originY)*16-4, 14, 20).data) as number[];
      const visibleBody = bodyPixels();
      const screen = renderer.worldToScreen(person.x + .5, person.y + .5); renderer.pick(screen.x, screen.y);
      const bodySelection = selections.at(-1);
      const fullTree = raster(32, 48, g => paintTree(g, treeForm(wooded), 1));
      const alphaRows = Array.from({ length: 48 }, (_, y) => fullTree.slice(y * 32 * 4, (y + 1) * 32 * 4).some((v, i) => i % 4 === 3 && v > 120));
      const treeHeight = alphaRows.lastIndexOf(true) - alphaRows.indexOf(true) + 1;
      renderer.update({ ...forest, people: [] }); renderer.render(0);
      const absentBody = bodyPixels(); let bodyContrastPixels = 0;
      for (let i = 0; i < visibleBody.length; i += 4) if (visibleBody[i+3]! > 100
        && Math.abs(visibleBody[i]! - absentBody[i]!) + Math.abs(visibleBody[i+1]! - absentBody[i+1]!) + Math.abs(visibleBody[i+2]! - absentBody[i+2]!) > 150) bodyContrastPixels++;
      const sprite = sprites[0];
      const opaque = fullTree.findIndex((value, index) => index % 4 === 3 && value > 128);
      const crown = { x: (Math.round(sprite.ax) - 16 + Math.floor(opaque / 4) % 32 + .5) / 16,
        y: (Math.round(sprite.ay) - 44 + Math.floor(opaque / 4 / 32) + .5) / 16 };
      const crownScreen = renderer.worldToScreen(crown.x,crown.y); renderer.pick(crownScreen.x,crownScreen.y);
      const defaultGroundSelection = selections.at(-1);
      renderer.setPickMode('inspect'); renderer.pick(crownScreen.x,crownScreen.y);
      const crownSelection = selections.at(-1);
      const blank = { x: (Math.round(sprite.ax) - 15.5) / 16, y: (Math.round(sprite.ay) - 43.5) / 16 };
      const blankScreen = renderer.worldToScreen(blank.x,blank.y); renderer.pick(blankScreen.x,blankScreen.y);
      const blankSelection = selections.at(-1), blankCell = {kind:'tile',x:Math.floor(blank.x),y:Math.floor(blank.y)};
      renderer.setLayer('moisture'); renderer.pick(crownScreen.x,crownScreen.y);
      const overlaySelection = selections.at(-1), crownCell = {kind:'tile',x:Math.floor(crown.x),y:Math.floor(crown.y)};
      renderer.setLayer('none'); renderer.setPickMode('ground'); renderer.pick(crownScreen.x,crownScreen.y);
      const directedSelection = selections.at(-1);
      renderer.setPickMode('inspect'); renderer.update(forest); renderer.render(0);
      const base = { id: 's', x: 0, y: 0, blueprintId: 'b', name: 'Sintético', components: ['frame','roof'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null };
      const building = (s: object, surface: object = {}) => raster(32, 32, g => paintStructure(g, { ...base, ...s }, surface));
      renderer.update({ ...forest, people: [], structures: [{ ...base, x: 3 }] }); renderer.render(0);
      const roofPixel = building({}).findIndex((value, index) => index % 4 === 3 && value > 128);
      const roofScreen = renderer.worldToScreen((3 * 16 - 8 + Math.floor(roofPixel / 4) % 32 + .5) / 16,
        (-16 + Math.floor(roofPixel / 4 / 32) + .5) / 16);
      renderer.pick(roofScreen.x,roofScreen.y); const roofSelection = selections.at(-1);
      const layouts = [[], ['cistern'], ['granary'], ['garden'], ['hearth'], ['frame','roof']].map(parts => building({ components: [...base.components, ...parts] }));
      const emptyTank = building({ components: [...base.components, 'cistern'] }), fullTank = building({ components: [...base.components, 'cistern'], water: .6 });
      const damaged = building({ condition: .1 }), repaired = building({ condition: 1 });
      const timber = building({}, { materials: { wood: 9, stone: 1 } }), masonry = building({}, { materials: { wood: 1, stone: 9 } });
      const noCrops = building({ components: [...base.components, 'garden'] }), planted = building({ components: [...base.components, 'garden'] }, { ground: { ...tile, cultivation: 1 } });
      const idle = building({ components: [...base.components, 'hearth'], uses: 0 }), used = building({ components: [...base.components, 'hearth'], uses: 100 });
      const tank = { ...base, components: [...base.components, 'cistern'], water: .4 };
      renderer.curr = { ...forest, weather: 'rain' };
      renderer.prev = { ...world, structures: [{ ...tank, water: .2 }] }; renderer.actionActive = true; renderer.reduceMotion = false;
      const transfer = raster(64, 64, g => { g.translate(16, 24); renderer.drawStructure(g, tank, .2); });
      const transferLater = raster(64, 64, g => { g.translate(16, 24); renderer.drawStructure(g, tank, .5); });
      renderer.prev = { ...world, structures: [tank] };
      const idleWater = raster(64, 64, g => { g.translate(16, 24); renderer.drawStructure(g, tank, .2); });
      const idleWaterLater = raster(64, 64, g => { g.translate(16, 24); renderer.drawStructure(g, tank, .5); });
      renderer.reduceMotion = true; renderer.render(0);
      (window as unknown as { stateRenderer: unknown }).stateRenderer = renderer;
      return { grounds: [before,dry,wet,poor,rich,bare,lush,farm,trail].map(p=>p.join(',')), cacheBefore, cacheAfter, treeCount: sprites.length, emptyCount: empty.length,
        treeHeight, cutaways, bodyContrastPixels, bodySelection, crownSelection, blankSelection, blankCell, overlaySelection, crownCell, roofSelection, defaultGroundSelection, directedSelection,
        preserved: preserved === JSON.stringify(forest), layouts: layouts.map(p=>p.join(',')),
        tankDiff: emptyTank.join(',') !== fullTank.join(','), repairDiff: damaged.join(',') !== repaired.join(','), materialDiff: timber.join(',') !== masonry.join(','),
        cropDiff: noCrops.join(',') !== planted.join(','), usesDoNotBurn: idle.join(',') === used.join(','),
        flowMoves: transfer.join(',') !== transferLater.join(','), noFlowStable: idleWater.join(',') === idleWaterLater.join(','), cacheBytes: renderer.getDiagnostics().cacheBytes };
    });
    assert.equal(new Set(result.grounds).size, 9, 'moisture, fertility, living biomass, cultivation and traffic all affect the cell surface');
    assert.ok(result.cacheAfter > result.cacheBefore && result.cacheAfter - result.cacheBefore <= 4, 'fertility change invalidates only adjacent ground chunks');
    assert.equal(result.treeCount, 1, 'full woody cell does not manufacture a decorative second tree');
    assert.equal(result.emptyCount, 0);
    assert.ok(result.treeHeight >= 28 && result.treeHeight <= 44);
    assert.ok(result.cutaways > 0, 'body obscured by a taller crown gets a translucent cutaway');
    assert.ok(result.bodyContrastPixels >= 45, 'an unselected body retains a substantial high-contrast footprint against its occluding canopy');
    assert.deepEqual(result.bodySelection, { kind: 'person', id: 'visible-body' });
    assert.deepEqual(result.crownSelection, { kind: 'tile', x: 0, y: 0 }, 'a crown above the cell selects its actual root patch');
    assert.deepEqual(result.blankSelection, result.blankCell, 'transparent sprite corners keep the underlying ground target');
    assert.deepEqual(result.overlaySelection, result.crownCell, 'data overlays inspect the underlying cell instead of a canopy');
    assert.deepEqual(result.defaultGroundSelection, result.crownCell, 'default picking preserves legacy geographic targets');
    assert.deepEqual(result.directedSelection, result.crownCell, 'move/build/seed target mode cannot redirect a ground destination to a tree root');
    assert.deepEqual(result.roofSelection, { kind: 'tile', x: 3, y: 0 }, 'roof hit selects the building cell instead of the ground behind it');
    assert.equal(result.preserved, true, 'rendering does not rewrite the authoritative scene');
    assert.equal(new Set(result.layouts).size, 6, 'components and repeated frames change structure silhouettes');
    for (const key of ['tankDiff','repairDiff','materialDiff','cropDiff','usesDoNotBurn','flowMoves','noFlowStable'] as const) assert.equal(result[key], true, key);
    assert.ok(result.cacheBytes <= 10 * 1024 * 1024);
    assert.deepEqual(errors, []);
    mkdirSync('artifacts', { recursive: true });
    writeFileSync('artifacts/landscape-state-inspection.json', JSON.stringify({
      surfaceStatesDistinct: new Set(result.grounds).size, componentLayoutsDistinct: new Set(result.layouts).size,
      treeHeightArtPixels: result.treeHeight, standingHumanArtPixels: 14, treeSymbolsPerWoodyCell: result.treeCount,
      symbolsWithoutWood: result.emptyCount, canopyCutaways: result.cutaways, geographicTargetsPreserved: true,
      unselectedBodyHighContrastPixels: result.bodyContrastPixels,
      bodyPriorityPreserved: true, alphaMaskTargetsVerified: true, authoritativeStateUnchanged: result.preserved,
      observedRainFlowAnimated: result.flowMoves, staticStockDoesNotFlow: result.noFlowStable,
      cacheBytes: result.cacheBytes, errors,
    }, null, 2) + '\n');
    await page.screenshot({ path: 'artifacts/landscape-state-inspection.png' });
    await page.evaluate('window.stateRenderer.destroy()');
  } finally { await browser.close(); await server.close(); }
});
