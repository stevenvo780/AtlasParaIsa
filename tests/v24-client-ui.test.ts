import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { worldShell, OBSERVER_HIDDEN_IDS, applyObserverOnly } from '../src/client/world-shell.js';
import { Notebook, type NotebookPage } from '../src/client/notebook.js';
import type { FloatingPanel } from '../src/client/panel-manager.js';
import type { StructureView } from '../src/shared/types.js';
import { Landscape } from '../src/client/landscape.js';
import { PRESET_SETTINGS } from '../src/client/graphics-settings.js';
import { MAP_LAYER_CATALOG, type MapLayerId } from '../src/client/layers-control.js';
import { renderTelemetry, telemetryKpis } from '../src/client/telemetry-hud.js';
import { createWorld, projectWorld } from '../src/world/index.js';

const source = (file: string) => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8');

test('V24 shell contains unique functional controls and removes obsolete surfaces', () => {
  const html = worldShell();
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate IDs');
  for (const id of ['intervene-toggle', 'tool-drawer', 'heat-button', 'modo-toggle', 'layer-drawer', 'layer-toggle']) assert.ok(!ids.includes(id), id);
  for (const id of ['settings-toggle', 'settings-drawer', 'settings-body', 'layers-toggle', 'layers-popover', 'tile-form', 'tile-x', 'tile-y', 'whisper-toggle', 'whisper-drawer', 'whisper-form', 'world-minimap', 'minimap-canvas', 'minimap-expand', 'mundo-deep-stats']) assert.ok(ids.includes(id), id);
  assert.doesNotMatch(html, /selection-shortcuts|>Gestos</);
  const population = html.match(/<aside id="population-drawer"[\s\S]*?<\/aside>/)![0];
  for (const id of ['focus-s', 'focus-i', 'population-search', 'population-list', 'tame-filter']) assert.match(population, new RegExp(`id="${id}"`));
  assert.ok(population.indexOf('id="focus-s"') < population.indexOf('vidas-tabs'));
  for (const label of ['Habitantes', 'Fauna', 'Comunidades', 'Obras']) assert.ok(population.includes(`>${label}</button>`));
  assert.match(html, /<nav class="world-navigation[\s\S]*?id="inspector-toggle"[\s\S]*?<\/nav>/);
  assert.match(html, /<nav class="game-actions[\s\S]*?id="letter-button"[\s\S]*?<\/nav>/);
  assert.match(html, /id="stats-content"[\s\S]*?<div id="mundo-deep-stats"><\/div>/);
  for (const tab of ['life', 'land', 'communities', 'technology', 'performance']) assert.ok(ids.includes(`stats-tab-${tab}`));
});

test('Susurros preserves agency, input limit, all intentions and observer availability', () => {
  const html = worldShell();
  assert.match(html, /Un susurro no es una orden: quien lo recibe solo lo escucha cuando está en calma y curioso, y decide a su ritmo\./);
  assert.match(html, /id="whisper-note" maxlength="120"/, 'the server keeps 120 characters; the form must not promise more');
  assert.match(html, /<div id="whisper-place" class="whisper-place">/, 'the destination is always chosen, whoever listens');
  assert.doesNotMatch(html, /id="whisper-place"[^>]*hidden/);
  for (const intent of ['travel', 'explore', 'gather', 'build', 'craft', 'tend']) assert.match(html, new RegExp(`value="${intent}"`));
  assert.deepEqual(OBSERVER_HIDDEN_IDS, ['direct-toggle', 'person-controls', 'task-palette']);
  const nodes = new Map(['whisper-toggle', 'whisper-drawer', ...OBSERVER_HIDDEN_IDS].map(id => [id, { hidden: false, textContent: '', setAttribute() {} }]));
  applyObserverOnly({ getElementById: id => nodes.get(id) ?? null }, true);
  assert.equal(nodes.get('whisper-toggle')!.hidden, false);
  assert.equal(nodes.get('whisper-drawer')!.hidden, false);
});

class FakeNode {
  hidden = true;
  attrs = new Map<string, string>();
  focused = false;
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  focus() { this.focused = true; }
}
function notebookHarness(width: number) {
  const view = Object.assign(new EventTarget(), { innerWidth: width });
  const nodes = new Map<string, FakeNode>();
  const pages: NotebookPage[] = ['population', 'inspector', 'stats', 'settings', 'whisper'];
  for (const page of pages) { nodes.set(`#${page}-drawer`, new FakeNode()); nodes.set(`#${page}-toggle`, new FakeNode()); }
  nodes.set('#observe-tool', new FakeNode());
  const classes = new Set<string>();
  const root = { ownerDocument: { defaultView: view }, querySelector: (id: string) => nodes.get(id), classList: { toggle: (id: string, enabled: boolean) => enabled ? classes.add(id) : classes.delete(id) } };
  const fronts: string[] = [];
  const panels = Object.fromEntries(pages.map(page => [page, { bringToFront: () => fronts.push(page) }])) as unknown as Record<NotebookPage, FloatingPanel>;
  const notebook = new Notebook(root as unknown as HTMLElement, panels);
  return { view, nodes, fronts, classes, notebook, visible: (page: string) => !nodes.get(`#${page}-drawer`)!.hidden };
}

test('Notebook desktop opens independent windows, toggles each, and raises every opened panel', () => {
  const h = notebookHarness(1280);
  assert.equal(h.notebook.show('population'), true);
  assert.equal(h.notebook.show('stats'), true);
  assert.equal(h.notebook.show('settings'), true);
  assert.ok(h.visible('population') && h.visible('stats') && h.visible('settings'));
  assert.equal(h.notebook.show('stats'), false);
  assert.ok(h.visible('population') && h.visible('settings') && !h.visible('stats'));
  h.notebook.show('population', true);
  assert.deepEqual(h.fronts, ['population', 'stats', 'settings', 'population']);
  assert.equal(h.nodes.get('#stats-toggle')!.attrs.get('aria-expanded'), 'false');
  assert.equal(h.nodes.get('#observe-tool')!.attrs.get('aria-pressed'), 'false');
  h.notebook.close();
  assert.ok(!h.visible('population') && !h.visible('settings'));
  assert.ok(!h.classes.has('notebook-open'));
  assert.equal(h.nodes.get('#observe-tool')!.attrs.get('aria-pressed'), 'true');
  h.notebook.destroy();
});

for (const width of [375, 760]) test(`Notebook at ${width}px keeps exactly one sheet`, () => {
  const h = notebookHarness(width);
  h.notebook.show('population'); h.notebook.show('whisper');
  assert.ok(!h.visible('population') && h.visible('whisper'));
  assert.equal(h.nodes.get('#population-toggle')!.attrs.get('aria-expanded'), 'false');
  assert.equal(h.notebook.show('whisper'), false);
  assert.ok(h.nodes.get('#whisper-toggle')!.focused);
  h.notebook.destroy();
});

test('Notebook switches to a single most recently raised window on mobile resize and releases its listener', () => {
  const h = notebookHarness(761);
  h.notebook.show('population'); h.notebook.show('stats'); h.notebook.show('population', true);
  h.view.innerWidth = 760; h.view.dispatchEvent(new Event('resize'));
  assert.ok(h.visible('population') && !h.visible('stats'));
  h.view.innerWidth = 1200; h.notebook.show('whisper'); h.notebook.destroy();
  h.view.innerWidth = 500; h.view.dispatchEvent(new Event('resize'));
  assert.ok(h.visible('population') && h.visible('whisper'), 'destroy detached resize callback');
});

test('Vivos is first and reflects real living population, with V23/V24 counters and explicit scope', () => {
  const world = projectWorld(createWorld(524));
  world.stats!.population = 4321;
  world.stats!.totals.births = 78; world.demography = { deaths: 19, causes: {}, recent: [] };
  world.stats!.pavedTiles = 23; world.stats!.polyominoStructures = 4; world.stats!.chemicalFormulas = 9;
  const before = structuredClone(world), html = renderTelemetry(world), kpis = telemetryKpis(world);
  assert.equal(kpis[0]!.label, 'Vivos'); assert.match(kpis[0]!.value, /^4[.,]321/);
  assert.match(html, /class="hud-kpi hud-kpi-primary" data-hud-nav="people"/);
  for (const text of ['Vivos', 'Nacimientos 78 / muertes 19', 'Comunidades', 'Obras', 'poliominós 4', 'calzadas 23', 'Fórmulas químicas 9']) assert.ok(html.includes(text), text);
  assert.deepEqual(world, before);
  delete world.stats;
  assert.ok(telemetryKpis(world)[0]!.value.startsWith(String(world.people.length)));
  assert.match(renderTelemetry(world), /sin censo global/);
  assert.doesNotMatch(renderTelemetry(null), /NaN|Infinity|undefined/);
});

/** Exercise actual Landscape methods; only canvas/browser boundaries are stubbed. */
function rendererHarness() {
  const canvas = { width: 0, height: 0, getBoundingClientRect: () => ({ width: 800, height: 600 }) };
  return Object.assign(Object.create(Landscape.prototype), {
    canvas, labels: { width: 0, height: 0 }, ctx: { imageSmoothingEnabled: true }, destroyed: false,
    cam: { x: -20, y: 30, zoom: 24 }, cssW: 800, cssH: 600, minZoom: 8, dpr: 1,
    modo: 'completo', graphicsSettings: { ...PRESET_SETTINGS.equilibrado }, spriteCache: new Map(), hallSlots: new Map(),
    phaseLayer: { style: { opacity: '.2' } }, rainLayer: { style: { opacity: '.4' } },
    activeLayers: new Set(), layer: 'none', capaCalor: null, sceneKey: 'old', ambientKey: 'old', staticPropsOwner: {},
  });
}
function withWindow(run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 3 } });
  try { run(); } finally { if (descriptor) Object.defineProperty(globalThis, 'window', descriptor); else Reflect.deleteProperty(globalThis, 'window'); }
}

test('graphics preferences cap backing DPR, change actual minimum zoom, invalidate art and copy settings', () => withWindow(() => {
  const r = rendererHarness(); r.spriteCache.set('old', {}); r.hallSlots.set('old', {});
  const ultra = { ...PRESET_SETTINGS.ultra };
  r.setGraphicsSettings(ultra); ultra.minZoom = 16;
  assert.equal(r.graphicsSettings.minZoom, 4); assert.equal(r.dpr, 2);
  assert.equal(r.canvas.width, 1600); assert.equal(r.canvas.height, 1200); assert.equal(r.labels.width, 1600);
  assert.equal(r.minZoom, 4); r.zoom(-100); assert.equal(r.camera().zoom, 4);
  assert.equal(r.spriteCache.size, 0); assert.equal(r.hallSlots.size, 0); assert.equal(r.sceneKey, ''); assert.equal(r.staticPropsOwner, null);
  r.setGraphicsSettings({ ...PRESET_SETTINGS.ligero, minZoom: 16 });
  assert.equal(r.camera().zoom, 16); assert.equal(r.dpr, 1); assert.equal(r.canvas.width, 800);
  for (const flag of ['shadows', 'atmosphere', 'vegetationSway', 'waterRipples', 'cutaways', 'chemicalGlint']) assert.equal(r.graphicsSettings[flag], false, flag);
  assert.equal(r.phaseLayer.style.opacity, '0'); assert.equal(r.rainLayer.style.opacity, '0');
  r.setGraphicsSettings(PRESET_SETTINGS.equilibrado); assert.equal(r.dpr, 1.5); assert.equal(r.canvas.height, 900);
}));

test('viewport bounds track camera pan and zoom, while focusTile is smooth and ignores invalid inputs', () => {
  const r = rendererHarness();
  assert.deepEqual(r.getViewportBounds(), { minX: -20 - 800 / 48, minY: 17.5, maxX: -20 + 800 / 48, maxY: 42.5 });
  r.cam = { x: 100, y: -200, zoom: 4 };
  assert.deepEqual(r.getViewportBounds(), { minX: 0, minY: -275, maxX: 200, maxY: -125 });
  r.reduceMotion = false; r.followedId = 's'; r.focusTile(-250, 310);
  assert.equal(r.followedId, null); assert.deepEqual(r.focusTo, { x: -249.5, y: 310.5 });
  assert.deepEqual(r.camera(), { x: 100, y: -200, zoom: 4 }, 'focus animates instead of jumping');
  r.focusTile(NaN, 4); assert.deepEqual(r.focusTo, { x: -249.5, y: 310.5 });
  r.reduceMotion = true; r.focusTile(-250, 310); assert.equal(r.camera().x, -249.5); assert.equal(r.camera().y, 310.5);
});

test('all nine selected layers draw together in deterministic order with translucent alpha, and clear cleanly', () => {
  const r = rendererHarness();
  r.worldSeed = 47; r.vivas = new Set(['-1,0']);
  const tile = { x: -1, y: 0, terrain: 'grass', food: .8, vegetation: .7, drinkingWater: .9, fertility: .8, wood: 8, moisture: .8, traffic: .7, paved: .7, biome: 'mountain', feature: 'rock' };
  r.tileAt = () => tile;
  const layers = new Set<MapLayerId>(MAP_LAYER_CATALOG.map(m => m.id).reverse());
  r.setActiveLayers(layers); layers.clear(); assert.equal(r.activeLayers.size, 9, 'input is copied');
  const draws: { color: string; alpha: number; x: number; y: number }[] = [];
  const ctx = { fillStyle: '', globalAlpha: 1, save() {}, restore() {}, fillRect(x: number, y: number) { draws.push({ color: this.fillStyle, alpha: this.globalAlpha, x, y }); } };
  r.drawActiveLayers(ctx, -1, -1, 0, 0);
  assert.deepEqual(draws.map(d => d.color), MAP_LAYER_CATALOG.map(m => m.color));
  for (const d of draws) { assert.ok(d.alpha > 0 && d.alpha < .4); assert.equal(d.x, -16); assert.equal(d.y, 0); }
  r.setActiveLayers(new Set()); draws.length = 0; r.drawActiveLayers(ctx, -1, -1, 0, 0); assert.equal(draws.length, 0);
  r.setOverlay('moisture'); assert.equal(r.layer, 'moisture');
  r.setHeatMode('comida'); assert.equal(r.capaDeCalor(), 'comida');
  r.setHeatMode(null); assert.equal(r.capaDeCalor(), null);
});

test('geology without a received seed and regions without activity evidence do not invent data', () => {
  const r = rendererHarness(); r.tileAt = () => ({ x: 0, y: 0 }); r.vivas = null;
  r.setActiveLayers(new Set(['geology', 'activeRegions']));
  const alphas: number[] = [];
  const g = { globalAlpha: 1, fillStyle: '', save() {}, restore() {}, fillRect() { alphas.push(this.globalAlpha); } };
  r.drawActiveLayers(g, 0, 0, 0, 0);
  assert.ok(alphas.every(value => value === 0), 'no visible tint without evidence');
});

test('V24 client owns cancellable refreshes, uses exact routes, and preserves deep stats across tab renders', () => {
  const code = source('game.ts');
  for (const route of ['/api/worldmap', '/api/directory', '/api/whispers', '/api/whisper']) assert.ok(code.includes(`'${route}'`));
  assert.match(code, /uiSession\?\.abort\(\)/); assert.match(code, /minimap\?\.destroy\(\)/);
  assert.match(code, /clearInterval\(timer\)/); assert.match(code, /cancelAnimationFrame\(uiRaf\)/);
  assert.match(code, /soundscape\.setHidden\(document.hidden\)/);
  assert.match(code, /mountMinimap\(el<HTMLCanvasElement>\('minimap-canvas'\)/);
  assert.match(code, /\.append\(deepStats/);
  assert.doesNotMatch(code, /el\('(?:tool-drawer|intervene-toggle|heat-button|modo-toggle|memory-select)'\)/);
  const css = source('game.css');
  for (const selector of ['.panel-resize-handle', '.is-floating', '.is-dragging', '.is-resizing', '.preset-pills', '.preset-pill', '.settings-check', '.layer-option', '.layers-popover', '.minimap-dock', '.whisper-card', '.vidas-si-bar', '.vidas-tabs']) assert.ok(css.includes(selector), selector);
  assert.match(css, /#stats-drawer[\s\S]*?repeat\(auto-fit/);
});

const noOpContext = (): any => new Proxy({ fillStyle: '', globalAlpha: 1 }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });

test('production scene immediately gates water, vegetation, cast shadows and selection cutaways', () => {
  const r = rendererHarness(), world = projectWorld(createWorld(525));
  const structure: StructureView = { id: 'hall', x: 0, y: 0, blueprintId: 'b', name: 'Casa', components: ['hearth'], condition: 1, food: 0, water: 0, uses: 0, builtAt: 0, builderId: null };
  const tile = { ...world.tiles[0]!, x: 0, y: 0 };
  world.places = []; world.structures = [structure];
  const calls = { water: 0, plant: 0, shadow: 0, structure: 0 };
  Object.assign(r, {
    cam: { x: .5, y: .5, zoom: 24 }, worldW: 1, worldH: 1, originX: 0, originY: 0,
    sceneRevision: 0, vivasKey: '', vivas: null, scene: { width: 16, height: 16 }, sceneCtx: noOpContext(),
    effects: {}, perf: { sceneBuilds: 0, spritesSorted: 0 }, selection: { kind: 'tile', x: 0, y: 0 }, reduceMotion: true,
    bodyGridInfo: { gx0: 0, gy0: 0, gw: 0, gh: 0, outside: [] }, bodyHead: new Int32Array(), bodyNext: new Int32Array(),
    scenePropsFor: () => ({ visibleTiles: 1, animated: [0, 1, 2].map(kind => ({ kind, tile, x: 0, y: 0 })), sprites: [], fauna: [] }),
    tileAt: () => tile, drawPlaces() {}, drawRipples() { calls.water++; }, drawPlantMovement() { calls.plant++; },
    drawCastShadow() { calls.shadow++; }, drawStructure() { calls.structure++; },
  });
  r.graphicsSettings = { ...PRESET_SETTINGS.ultra }; r.drawScene(world, [], [], 1);
  assert.equal(calls.water, 1); assert.equal(calls.plant, 1); assert.equal(calls.shadow, 1);
  assert.equal(calls.structure, 2, 'selection cutaway redraws material within its footprint');
  r.graphicsSettings = { ...PRESET_SETTINGS.ligero }; r.sceneKey = ''; Object.assign(calls, { water: 0, plant: 0, shadow: 0, structure: 0 });
  r.drawScene(world, [], [], 2);
  assert.deepEqual(calls, { water: 0, plant: 0, shadow: 0, structure: 1 });
});

test('production compositor skips atmosphere while preserving event evidence', () => {
  const r = rendererHarness(), world = projectWorld(createWorld(526));
  let ambient = 0, events = 0;
  const ctx = noOpContext();
  Object.assign(r, { ctx, labelCtx: noOpContext(), curr: world, currAt: performance.now(), interval: 500, groundBaked: true, worldW: 1,
    chunks: [], originX: 0, originY: 0, scene: { width: 16, height: 16 }, reduceMotion: true,
    atmosphere: { reset() {}, step: () => ({ shadowX: 1, shadowY: 1, shadowAlpha: .1, rain: 0 }) },
    interpolatePeople: () => [], interpolateAnimals: () => [], drawScene() {}, drawOverlaysScreen() {},
    drawAmbient() { ambient++; }, drawEventAccents() { events++; }, effects: {},
  });
  r.canvas.width = 800; r.canvas.height = 600;
  r.graphicsSettings.atmosphere = true; r.render(1000); assert.equal(ambient, 1);
  r.graphicsSettings.atmosphere = false; r.render(1100); assert.equal(ambient, 1); assert.equal(events, 1);
});

test('chemical glint preference affects actual person pixels without removing material color', () => {
  const r = rendererHarness(), world = projectWorld(createWorld(527));
  const view = { ...world.people[0]!, id: 'p', x: 1, y: 1, action: 'hunt' };
  Object.assign(r, { curr: world, reduceMotion: true, actionActive: false, effects: {}, tileAt: () => undefined,
    carriedProducts: new Map([['p', 'cutting']]), secondaryProducts: new Map(), carriedWater: new Map(), prevPeople: new Map(),
    craftVisuals: new Map([['p', { tint: '#a173c9', glint: true }]]),
  });
  const colors = (enabled: boolean) => {
    r.graphicsSettings.chemicalGlint = enabled;
    const result: string[] = [];
    const g = { fillStyle: '', fillRect() { result.push(this.fillStyle); } };
    r.drawPerson(g, { view, x: 1, y: 1, seed: 12, stride: 0, moving: false }, 0);
    return result;
  };
  assert.ok(colors(true).includes('#f4ffff'));
  const disabled = colors(false); assert.ok(!disabled.includes('#f4ffff')); assert.ok(disabled.includes('#a173c9'));
});

test('Mundo hooks the exact dashboard API, refreshes with the directory, and a failure cannot break the panel', () => {
  const code = source('game.ts');
  assert.match(code, /import \{ renderMundoDeepStats \} from '\.\/mundo-dashboard\.js'/);
  assert.ok(existsSync(new URL('../src/client/mundo-dashboard.ts', import.meta.url)), 'el módulo importado por game.ts debe existir (integrar sprint/v24-mundo-dashboard)');
  assert.match(code, /renderMundoDeepStats\(world, statsTab, directory\)/);
  assert.match(code, /try \{ deepStats\.innerHTML = world && tecnica === null \? renderMundoDeepStats/);
  assert.match(code, /\$\{directory\?\.tick \?\? -1\}/, 'the stats signature follows the directory');
  assert.match(code, /name === 'stats' && next\) \{ renderStats\(\); void refreshDirectory\(\)/);
});

test('Susurros send the chosen place for both audiences and never reuse the recipient position', () => {
  const code = source('game.ts');
  assert.match(code, /x: whisperTile\.x, y: whisperTile\.y/);
  assert.doesNotMatch(code, /isPerson \? recipient!/);
  assert.match(code, /slice\(0, 120\)/);
});

test('Vidas draws a bounded window of a global directory, and failing endpoints back off without freezing the UI', () => {
  const code = source('game.ts');
  assert.match(code, /const DIRECTORY_ROWS = 300/);
  assert.match(code, /matches\.slice\(0, DIRECTORY_ROWS\)/);
  assert.match(code, /mapRetryAt = Date\.now\(\) \+ 3000 \* 2 \*\* mapFailures/);
  assert.match(source('ui-guards.ts'), /AbortSignal\.any\(\[session, AbortSignal\.timeout\(timeoutMs\)\]\)/);
  assert.match(code, /fetchJson\(url, session\.signal, valid\)/);
  assert.match(code, /if \(!el\('population-drawer'\)\.hidden\) renderPopulation\(\);\n  renderInspector/, 'a closed Vidas panel is not rebuilt on every world');
});

test('floating windows exist only on desktop and are released on the mobile breakpoint, keeping stable list hooks', () => {
  const code = source('game.ts');
  assert.match(code, /if \(mobile\(\)\) \{ panels\[page\]\?\.destroy\(\); delete panels\[page\]; panel\.classList\.remove\('is-floating'\); \}/);
  assert.match(code, /panelQuery\.addEventListener\('change', syncPanels\)/);
  assert.match(code, /panelQuery\.removeEventListener\('change', panelSync\)/);
  assert.match(code, /data-person="\$\{esc\(row\.id\)\}"/); assert.match(code, /data-animal="\$\{esc\(row\.id\)\}"/);
  assert.doesNotMatch(source('game.css'), /\.game-drawer\.is-floating \{ position:absolute!important/, 'inline sheet overrides are gone');
});
