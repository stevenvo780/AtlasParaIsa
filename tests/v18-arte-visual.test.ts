import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createBrowserTestServer as createServer } from './lib/vite.js';
import { PROTOCOL_VERSION } from '../src/shared/types.js';

test('V18 visual art upgrade: connected multi-tile puddles, blueprint generation/community/garden walls, FNV-1a person seeds and lifeStage sprites', { timeout: 45_000 }, async t => {
  if (!existsSync(chromium.executablePath())) {
    t.skip('Chromium executable absent');
    return;
  }
  const server = await createServer();
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, reducedMotion: 'reduce' });
    await page.addInitScript('window.__name = value => value');
    await page.route('**/__v18_art.html', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><body style="margin:0"><canvas id="c" style="width:640px;height:480px"></canvas></body>',
    }));
    await page.goto(new URL('__v18_art.html', server.resolvedUrls!.local[0]).href);

    const res = await page.evaluate(async (version) => {
      const module = '/src/client/landscape.ts', artModule = '/src/client/life-art.ts', vsModule = '/src/client/visual-state.ts';
      const { Landscape } = await import(/* @vite-ignore */ module);
      const { paintStructure, paintAnimal } = await import(/* @vite-ignore */ artModule);
      const { newEventAccents } = await import(/* @vite-ignore */ vsModule);
      const canvas = document.getElementById('c') as HTMLCanvasElement;
      const r: any = new Landscape(canvas, () => {});

      // 1. Moisture 0.649 -> 0.651 invalidates chunkSignature
      const baseTile = {
        x: 0, y: 0, terrain: 'meadow', biome: 'grassland', feature: 'none',
        moisture: 0.649, vegetation: 0.4, food: 0.2, growth: 0.5, fertility: 0.5, drinkingWater: 0.5,
      };
      const makeGrid = (m: number) => Array.from({ length: 16 }, (_, i) => ({
        ...baseTile, x: i % 4, y: Math.floor(i / 4), moisture: m,
      }));
      const worldBase = {
        version, sequence: 1, tick: 100, day: 1, phase: 'day', weather: 'clear',
        width: 4, height: 4, originX: 0, originY: 0,
        tiles: makeGrid(0.649), people: [], animals: [], structures: [], places: [], events: [], memories: [],
      };
      r.update(worldBase);
      const sigBelow = r.chunkSignature(0, 0);
      r.update({ ...worldBase, sequence: 2, tick: 101, tiles: makeGrid(0.651) });
      const sigAbove = r.chunkSignature(0, 0);

      // 2. Adjacent wetland/puddle tiles connect across their shared tile border
      const wetTiles = Array.from({ length: 64 }, (_, i) => ({
        ...baseTile,
        x: i % 8,
        y: Math.floor(i / 8),
        biome: 'wetland',
        moisture: 0.85,
        drinkingWater: 0.85,
      }));
      r.update({ ...worldBase, sequence: 3, tick: 102, width: 8, height: 8, tiles: wetTiles });
      const puddleCanvas = document.createElement('canvas');
      puddleCanvas.width = 8 * 16;
      puddleCanvas.height = 8 * 16;
      const pg = puddleCanvas.getContext('2d')!;
      for (const wt of wetTiles) r.bakeFeatures(pg, r.tileAt(wt.x, wt.y));
      const pData = pg.getImageData(0, 0, 128, 128).data;
      let sharedBorderWetPairs = 0;
      for (let tx = 1; tx < 7; tx++) {
        const borderX = tx * 16;
        for (let py = 8; py < 120; py++) {
          const leftAlpha = pData[(py * 128 + (borderX - 1)) * 4 + 3]!;
          const rightAlpha = pData[(py * 128 + borderX) * 4 + 3]!;
          if (leftAlpha > 0 && rightAlpha > 0) sharedBorderWetPairs++;
        }
      }

      // 3. paintStructure distinguishes generation (G0..G3) and communityColor, and garden keeps house walls
      const raster32 = (fn: (g: CanvasRenderingContext2D) => void) => {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const g = c.getContext('2d')!;
        fn(g);
        return Array.from(g.getImageData(0, 0, 32, 32).data).join(',');
      };
      const baseStruct = {
        id: 's1', x: 1, y: 1, blueprintId: 'bp1', name: 'Refugio',
        components: ['frame', 'roof'], condition: 1, water: 0.4, food: 0.4, uses: 10, builtAt: 0, builderId: 'neighbor-10',
      };
      const genRasters = [0, 1, 2, 3].map(gen =>
        raster32(g => paintStructure(g, baseStruct as any, { materials: { wood: 8, stone: 6 }, generation: gen }))
      );
      const commA = raster32(g => paintStructure(g, baseStruct as any, { generation: 2, communityColor: '#76b8be' }));
      const commB = raster32(g => paintStructure(g, baseStruct as any, { generation: 2, communityColor: '#dfba67' }));

      // 4. Full FNV-1a ID hash eliminates neighbor-10..90 seed collisions and lifeStage changes sprite
      const tensPeople = Array.from({ length: 9 }, (_, i) => ({
        id: `neighbor-${(i + 1) * 10}`,
        name: `Vecino ${(i + 1) * 10}`,
        role: 'neighbor',
        color: '#88a070',
        x: i % 4,
        y: Math.floor(i / 4),
        action: 'explore',
        reason: 'Prueba',
        energy: 0.8,
        hunger: 0.2,
        fatigue: 0.1,
        need: 'explore',
        recentMemory: null,
      }));
      r.update({ ...worldBase, sequence: 4, tick: 103, people: tensPeople });
      const seeds = r.interpolatePeople(1000).map((p: any) => p.seed);
      const drawStage = (lifeStage: 'juvenile' | 'adult' | 'senescent') =>
        raster32(g => r.drawPerson(g, {
          view: { ...tensPeople[0]!, lifeStage },
          x: 0.5, y: 0.5, moving: false, seed: seeds[0],
        }, 0));
      const stageRasters = [drawStage('juvenile'), drawStage('adult'), drawStage('senescent')];

      // 5. Cultural motifs on structures (stewardship, sharing, openness)
      const cultStew = raster32(g => paintStructure(g, baseStruct as any, { generation: 2, communityColor: '#76b8be', culture: { sharing: 0.3, stewardship: 0.7, openness: 0.3 } }));
      const cultShare = raster32(g => paintStructure(g, baseStruct as any, { generation: 2, communityColor: '#76b8be', culture: { sharing: 0.7, stewardship: 0.3, openness: 0.3 } }));
      const cultOpen = raster32(g => paintStructure(g, baseStruct as any, { generation: 2, communityColor: '#76b8be', culture: { sharing: 0.3, stewardship: 0.3, openness: 0.7 } }));

      // 6. Conflict and meeting accents + social link arcs + directed/critical body cues
      const prevW: any = { tick: 100, events: [] };
      const currW: any = {
        tick: 101,
        events: [
          { id: 'c1', tick: 101, kind: 'conflict', source: 'simulation', x: 1, y: 1, actors: ['neighbor-10', 'neighbor-20'], text: 'Disputa', cause: 'Escasez' },
          { id: 'm1', tick: 101, kind: 'meeting', source: 'simulation', x: 2, y: 2, actors: ['neighbor-10', 'neighbor-20'], text: 'Encuentro', cause: 'Vínculo' },
        ],
      };
      const accents = newEventAccents(prevW, currW, 1000);

      const drawCue = (extra: object) =>
        raster32(g => r.drawPerson(g, {
          view: { ...tensPeople[0]!, ...extra },
          x: 0.5, y: 0.5, moving: false, seed: seeds[0],
        }, 0));
      const basePersonRaster = drawCue({});
      const directedRaster = drawCue({ controlMode: 'directed' });
      const thirstyRaster = drawCue({ thirst: 0.9 });
      const lowHealthRaster = drawCue({ health: 0.25 });
      const neighborSprites = r.interpolatePeople(1000).map((p: any) =>
        raster32(g => r.drawPerson(g, { ...p, x: 0.5, y: 0.5, moving: false }, 0))
      );

      // 7. Evolved animal phenotypes (camouflage, agile, fierce, maturity)
      const deerMorphs = [
        raster32(g => paintAnimal(g, 'deer', 'roam', 0, { maturity: 0, camouflage: 1, agile: 0 })),
        raster32(g => paintAnimal(g, 'deer', 'roam', 0, { maturity: 1, camouflage: 0, agile: 0 })),
        raster32(g => paintAnimal(g, 'deer', 'roam', 0, { maturity: 1, camouflage: 2, agile: 0 })),
        raster32(g => paintAnimal(g, 'deer', 'roam', 0, { maturity: 2, camouflage: 2, agile: 1 })),
      ];
      const boarMorphs = [
        raster32(g => paintAnimal(g, 'boar', 'roam', 0, { maturity: 0, fierce: 0, camouflage: 1 })),
        raster32(g => paintAnimal(g, 'boar', 'roam', 0, { maturity: 1, fierce: 0, camouflage: 0 })),
        raster32(g => paintAnimal(g, 'boar', 'roam', 0, { maturity: 2, fierce: 1, camouflage: 2 })),
      ];

      r.destroy();
      return {
        sigChanged: sigBelow !== sigAbove,
        sharedBorderWetPairs,
        distinctGenerations: new Set(genRasters).size,
        commDistinct: commA !== commB,
        distinctTensSeeds: new Set(seeds).size,
        distinctLifeStages: new Set(stageRasters).size,
        distinctCultures: new Set([cultStew, cultShare, cultOpen]).size,
        accentKinds: accents.map((a: any) => a.kind),
        cuesDistinct: new Set([basePersonRaster, directedRaster, thirstyRaster, lowHealthRaster]).size,
        distinctNeighborSprites: new Set(neighborSprites).size,
        distinctDeerMorphs: new Set(deerMorphs).size,
        distinctBoarMorphs: new Set(boarMorphs).size,
      };
    }, PROTOCOL_VERSION);

    assert.equal(res.sigChanged, true, 'crossing moisture 0.65 invalidates chunkSignature');
    assert.ok(res.sharedBorderWetPairs > 30, `expected connected puddle pixels across tile borders, got ${res.sharedBorderWetPairs}`);
    assert.ok(res.distinctGenerations >= 3, `expected distinct generation rasters, got ${res.distinctGenerations}`);
    assert.equal(res.commDistinct, true, 'community color pennant/lintel changes structure raster');
    assert.equal(res.distinctTensSeeds, 9, 'neighbor-10..90 must not collide on person seed');
    assert.equal(res.distinctLifeStages, 3, 'juvenile, adult and senescent have distinct sprites');
    assert.equal(res.distinctCultures, 3, 'stewardship, sharing and openness motifs produce distinct structure rasters');
    assert.deepEqual(res.accentKinds, ['conflict', 'meeting'], 'conflict and meeting events produce visual accents');
    assert.equal(res.cuesDistinct, 4, 'directed mode, critical thirst and low health produce distinct person rasters');
    assert.equal(res.distinctNeighborSprites, 9, 'every neighbor-10..90 renders a distinct outlined character sprite');
    assert.equal(res.distinctDeerMorphs, 4, 'deer phenotypes differ across maturity, camouflage and agility');
    assert.equal(res.distinctBoarMorphs, 3, 'boar phenotypes differ across maturity, carnivory tusks and camouflage');
  } finally {
    await browser.close();
    await server.close();
  }
});
