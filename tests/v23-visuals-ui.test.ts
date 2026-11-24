import test from 'node:test';
import { BoundedCache } from '../src/client/gpu-terrain.js';
import assert from 'node:assert/strict';
import type { AnimalView, PersonView, StructureView, WorldView } from '../src/shared/types.js';
import type { CompoundLot, ChemistrySummaryView } from '../src/shared/chemistry.js';
import { paintAnimal, type AnimalVisualTraits } from '../src/client/life-art.js';
import { paintModularHall, paintStructure } from '../src/client/structure-art.js';
import { Landscape, animalSpriteKey, animalVisualTraits, personCraftVisual } from '../src/client/landscape.js';
import { forgedToolMarkup, inheritedAndLearned, structureCard } from '../src/client/inspector-view.js';
import { compoundLotsMarkup, habituatedFauna, materialPropertiesMarkup, renderAnimalTelemetry, renderChemistryTelemetry, renderPersonTelemetry, renderTelemetry } from '../src/client/telemetry-hud.js';

// Final raster, not a list of draw calls: hidden or overwritten marks cannot pass these tests.
function pixels(paint: (g: CanvasRenderingContext2D) => void, bounds?: number): Map<string, string> {
  const out = new Map<string, string>();
  let color = '';
  const g = { beginPath() {}, ellipse() {}, fill() {}, get fillStyle() { return color; }, set fillStyle(value: string) { color = value; }, fillRect(x: number, y: number, w: number, h: number) {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      if (bounds !== undefined && (row < 0 || row >= bounds || col < 0 || col >= bounds)) continue;
      out.set(`${col},${row}`, color);
    }
  } } as unknown as CanvasRenderingContext2D;
  paint(g); return out;
}
const difference = (a: Map<string, string>, b: Map<string, string>) => [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).length;
const animal = (extra: Partial<AnimalView> = {}): AnimalView => ({ id: 'a', species: 'deer', action: 'roam', x: 0, y: 0, reason: '', health: 1, age: 1400, generation: 1, parents: [], energy: 1, hunger: 0, thirst: 0, fatigue: 0, genes: { speed: .5, perception: .5, metabolism: .5, carnivory: .2, waterEfficiency: .5, camouflage: .5 }, ...extra });
const lot = (colorHex = '#138bc7'): CompoundLot => ({ id: 'lot', formulaId: 'Fe-Si', phase: 'smelted', mass: 3, composition: { C: .1, Si: .3, Ca: .1, Fe: .3, S: .1, H: .1 }, properties: { colorHex, hardness: .8, toughness: .7, seal: .8, insulation: .6, fuelPower: .1, fertility: .3, lightness: .8 } });
const structure = (extra: Partial<StructureView> = {}): StructureView => ({ id: 's', x: 0, y: 0, blueprintId: 'b', name: 'Taller', components: ['frame', 'roof'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null, ...extra });
const person = (extra: Partial<PersonView> = {}): PersonView => ({ id: 'p', role: 'neighbor', name: 'A', action: 'craft', skills: {}, craftFocus: 'Forja del hierro', craftTint: '#a173c9', compounds: [lot()], ...extra } as PersonView);
type Item = NonNullable<WorldView['technology']>['items'][number];
const item = (extra: Partial<Item> = {}): Item => ({ id: 'tool', ownerId: 'p', x: 0, y: 0, recipeId: null, mass: 100, generation: 1, capacities: { cutting: .9 } as Item['capacities'], materialTint: '#35b987', chemFormulaId: 'Fe-Si', chemPhase: 'smelted', ...extra });
const chemistry = (): ChemistrySummaryView => ({ formulas: [{ id: 'Fe-Si', signature: 'x', name: 'Hierro silíceo', composition: lot().composition, properties: lot().properties, phase: 'smelted', temperatureTier: 2, operator: 'heat', discoveredAt: 0, discovererId: 'p', uses: 1 }], totalFormulas: 1, totalLots: 1, maxTemperatureTier: 2, byOperator: { grind: 0, wash: 0, heat: 1, bind: 0 } });
const world = (): WorldView => ({ people: [person()], tiles: [], structures: [], animals: [animal({ habituation: .8 }), animal({ id: 'b', habituation: .5 }), animal({ id: 'dead', habituation: 1, health: 0 })], places: [], events: [], memories: [], chemistry: chemistry(), stats: {}, technology: { items: [item()], recipes: [], dynamics: {} } } as unknown as WorldView);
const labels = ['Dureza', 'Tenacidad', 'Sellado', 'Aislamiento', 'Combustible', 'Fertilidad', 'Ligereza'];

for (const species of ['deer', 'boar', 'wolf'] as const) for (const trait of ['size', 'coat', 'defense', 'tame'] as const) {
  test(`${species}: ${trait} 0 → 2 changes visible pixels inside 32×32`, () => {
    const draw = (value: 0 | 2) => pixels(g => paintAnimal(g, species, 'roam', 0, { [trait]: value } as AnimalVisualTraits), 32);
    const a = draw(0), b = draw(2);
    assert.ok(difference(a, b) >= 3, `${trait} must survive final compositing`);
    assert.ok([...b.values()].includes('#231710'), 'two-pass dark outline remains visible');
    assert.deepEqual(b, draw(2), 'deterministic rendering');
  });
}

test('phenotype buckets and habituation thresholds do not key continuous noise or IDs', () => {
  assert.equal(animalVisualTraits(animal({ habituation: .449 })).tame, 0);
  assert.equal(animalVisualTraits(animal({ habituation: .45 })).tame, 1);
  assert.equal(animalVisualTraits(animal({ habituation: .749 })).tame, 1);
  assert.equal(animalVisualTraits(animal({ habituation: .75 })).tame, 2);
  const morph = { caution: .5, size: .5, coat: .5, defense: .5 };
  const base = animal({ morphology: morph, habituation: .55 });
  for (let i = 0; i < 100; i++) assert.equal(animalSpriteKey(base, 0), animalSpriteKey(animal({ id: `a${i}`, morphology: { ...morph, size: .5 + i / 1000 }, habituation: .55 + i / 1000 }), 0));
  assert.equal(animalSpriteKey(base, 1), animalSpriteKey({ ...base, action: 'hunt' }, 1));
  for (const field of ['size', 'coat', 'defense'] as const) assert.notEqual(animalSpriteKey(base, 0), animalSpriteKey({ ...base, morphology: { ...morph, [field]: .9 } }, 0));
  assert.notEqual(animalSpriteKey(base, 0), animalSpriteKey({ ...base, habituation: .9 }, 0));
});

for (const layout of ['compact', 'rectangle', 'polyomino'] as const) {
  const render = (s: StructureView) => pixels(g => layout === 'compact' ? paintStructure(g, s) : paintModularHall(g, { ...s, ...(layout === 'polyomino' ? { cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] } : { footprint: { width: 2, height: 1 } }) }, 0, false), layout === 'compact' ? 32 : undefined);
  test(`${layout}: tint, strength, glaze, T2 chimney and three real chemical colors survive compositing`, () => {
    const base = structure(), profile = { tint: '#2481ad', strength: .4, seal: .4, insulation: .5 };
    const tinted = structure({ materialProfile: profile });
    assert.ok(difference(render(base), render(tinted)) > 8);
    assert.ok(difference(render(tinted), render(structure({ materialProfile: { ...profile, tint: '#b64726' } }))) > 8);
    assert.ok(difference(render(tinted), render(structure({ materialProfile: { ...profile, strength: .8 } }))) >= 3);
    assert.ok(difference(render(tinted), render(structure({ materialProfile: { ...profile, seal: .8 } }))) >= 3);
    const hot = render(structure({ synergy: { kilnTier: 2, sharedEdges: 0, heated: false, irrigated: false, workshopBonus: 0 } }));
    assert.ok([...hot.values()].includes('#ff7a2a'));
    assert.ok(difference(render(base), hot) > 6);
    const hues = ['#138bc7', '#bd41a7', '#41bd70'];
    const stock = render(structure({ storedCompounds: hues.map(c => lot(c)) }));
    for (const color of hues) assert.ok([...stock.values()].includes(color), color);
    assert.deepEqual(render(base), render(structure({ storedCompounds: [{ ...lot(), mass: 0 }] })));
  });
}

test('person tool/pack tint precedence, strongest forged item, phase glint and legacy fallback', () => {
  const p = person();
  assert.equal(personCraftVisual(p, [item()]).tint, p.craftTint);
  assert.equal(personCraftVisual({ ...p, craftTint: undefined }, [item()]).tint, '#35b987');
  assert.equal(personCraftVisual({ ...p, craftTint: undefined }, []).tint, lot().properties.colorHex);
  const selected = personCraftVisual({ ...p, craftTint: undefined }, [item({ capacities: { cutting: .1 } as Item['capacities'], materialTint: '#aabbcc' }), item()]);
  assert.equal(selected.tint, '#35b987'); assert.equal(selected.glint, true); assert.equal(selected.lightPack, true);
  assert.equal(personCraftVisual(person({ craftTint: undefined, compounds: [{ ...lot(), properties: { ...lot().properties, lightness: .1 } }] })).lightPack, false);
  assert.equal(personCraftVisual(person({ craftTint: 'red;url(evil)', compounds: [] }), [item({ mass: 0 })]).tint, undefined);
  assert.equal(personCraftVisual(person({ compounds: [], craftTint: undefined }), [item({ chemPhase: 'fired' })]).glint, false);
  assert.equal(personCraftVisual(person({ compounds: [], craftTint: undefined }), [item({ chemPhase: 'vitrified' })]).glint, true);
});

test('person inspector: emergent profession, seven properties, exact material badge and forged provenance', () => {
  const w = world(), p = w.people[0];
  const telemetry = renderPersonTelemetry(p), kit = inheritedAndLearned(p, w, []).kit;
  assert.match(telemetry, /Oficio emergente[\s\S]*background:#a173c9[\s\S]*Forja del hierro/);
  for (const label of labels) { assert.ok(telemetry.includes(label), label); assert.ok(kit.includes(label), label); }
  assert.match(kit, /background:#35b987/); assert.match(kit, /Procedencia química: Fe-Si/); assert.match(kit, />fundido</);
  for (const [phase, text] of [['fired', 'cocido'], ['vitrified', 'vitrificado']] as const) assert.ok(forgedToolMarkup(item({ chemPhase: phase }), w).includes(`>${text}<`));
  const absent = forgedToolMarkup(item({ chemFormulaId: 'not-in-sample' }), w);
  assert.match(absent, /not-in-sample/); assert.match(absent, /fuera de esta vista/);
  assert.equal((absent.match(/<meter/g) ?? []).length, 0, 'missing formula values are unknown, never invented zeros');
  for (const label of labels) assert.ok(renderChemistryTelemetry(w.chemistry).includes(label));
  assert.ok(!renderPersonTelemetry(person({ craftFocus: undefined, craftTint: undefined })).includes('Oficio emergente'));
});

test('animal inspector: inherited morphology, learned habituation meter, tending and unknown legacy state', () => {
  const a = animal({ morphology: { caution: .2, size: .8, coat: .9, defense: .7 }, habituation: .75, tends: 12 });
  const html = renderAnimalTelemetry(a);
  for (const label of ['Morfología evolutiva', 'Cautela', 'Tamaño', 'Pelaje', 'Defensa', 'Cuidados', '12', 'Manso · aprovechable sin caza']) assert.ok(html.includes(label));
  assert.match(html, /aria-label="Habituación \/ Mansedumbre"[^>]*value="0.75"/);
  assert.match(renderAnimalTelemetry({ ...a, habituation: .45 }), /Habituándose/);
  assert.match(renderAnimalTelemetry({ ...a, habituation: .44 }), /Salvaje/);
  const legacy = renderAnimalTelemetry(animal());
  assert.match(legacy, /Sin dato/); assert.ok(!legacy.includes('Morfología evolutiva'));
  assert.ok(!renderAnimalTelemetry({ ...a, habituation: NaN }).includes('value="NaN"'));
});

test('structure inspector and HUD report only received chemical stock, forged tools and living tame animals', () => {
  const s = structure({ materialProfile: { tint: '#be7431', strength: .8, seal: .7, insulation: .6 }, synergy: { kilnTier: 2, heated: true, sharedEdges: 0, irrigated: false, workshopBonus: 0 }, storedCompounds: [lot()] });
  const html = structureCard(s, null);
  for (const label of ['Perfil material', 'background:#be7431', 'Fuerza', 'Sellado', 'Aislamiento', 'Horno T2', 'Compuestos almacenados', 'background:#138bc7']) assert.ok(html.includes(label));
  const w = world(), hud = renderTelemetry(w);
  assert.deepEqual(habituatedFauna(w.animals), { known: true, tame: 1, calming: 1 });
  assert.match(hud, /1 mans\. \/ 1 hab\./); assert.match(hud, /1 forj\./);
  assert.match(hud, /herramientas químicas forjadas en vista/); assert.match(hud, /individuos recibidos/);
  assert.ok(!renderTelemetry(null).includes('0 mans.'));
});

test('all new inspector/HUD paths escape text and reject CSS/attribute injection', () => {
  const attack = '\"><img src=x onerror=alert(1)>&\'"';
  const w = world();
  const p = person({ craftFocus: attack, craftTint: attack, compounds: [{ ...lot(), id: attack, formulaId: attack, properties: { ...lot().properties, colorHex: attack } }] });
  const a = animal({ parents: [attack], morphology: { caution: .1, size: .5, coat: .5, defense: .5 }, habituation: .7 });
  const s = structure({ materialProfile: { tint: attack, strength: .7, seal: .7, insulation: .7 }, storedCompounds: p.compounds });
  const samples = [renderPersonTelemetry(p), renderAnimalTelemetry(a), structureCard(s, null), forgedToolMarkup(item({ id: attack, materialTint: attack, chemFormulaId: attack }), w), compoundLotsMarkup(p.compounds!, attack), materialPropertiesMarkup(undefined), renderTelemetry(w)];
  for (const html of samples) { assert.ok(!html.includes('<img'), html); assert.ok(!html.includes('background:' + attack)); assert.ok(!html.includes('value="NaN"')); }
  assert.ok(samples[0].includes('&lt;img'));
  assert.ok(samples[3].includes('&quot;'));
});


/** Exercise production private render paths without a browser: only Canvas/DOM boundaries are stubbed. */
function rendererHarness() {
  return Object.assign(Object.create(Landscape.prototype), {
    curr: world(), reduceMotion: true, actionActive: false, cam: { zoom: 18 }, effects: {},
    carriedProducts: new Map([['p', 'cutting']]), secondaryProducts: new Map(), carriedWater: new Map(), prevPeople: new Map(), craftVisuals: new Map(),
    spriteBytes: 0, spriteBuilds: 0, drawCalls: 0, spriteCache: new BoundedCache(320, () => {}), animalCache: new BoundedCache(2048, () => {}),
    hallSigs: new WeakMap(), hallSlots: new Map(), perf: { hallBuilds: 0, hallBlits: 0 }, tileAt: () => undefined,
  });
}
function withCanvasBoundary(run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ width: 32, height: 32, getContext: () => ({ fillRect() {}, translate() {}, imageSmoothingEnabled: false, fillStyle: '' }) }) } });
  try { run(); } finally { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); }
}

test('production inhabitant renderer paints exact sash, pack and poised hunting tool colors plus phase glints', () => {
  const r = rendererHarness();
  const p = person({ x: 1, y: 1, action: 'hunt', compounds: [lot('#e143b2')] });
  const draw = (phase: Item['chemPhase'], lightness: number) => {
    const view = { ...p, compounds: [{ ...lot('#e143b2'), properties: { ...lot().properties, colorHex: '#e143b2', lightness } }] };
    r.craftVisuals.set('p', personCraftVisual(view, [item({ chemPhase: phase })]));
    return pixels(g => r.drawPerson(g, { view, x: 1, y: 1, seed: 12, stride: 0, moving: false }, 0));
  };
  const metal = draw('smelted', .8), fired = draw('fired', .8), heavy = draw('smelted', .1);
  assert.equal(metal.get('23,21'), '#a173c9', 'sash');
  assert.equal(metal.get('28,13'), '#a173c9', 'spear head uses active chemical tint');
  assert.equal(metal.get('29,12'), '#f4ffff', 'single crisp hunting glint');
  assert.equal(fired.get('29,12'), '#a173c9', 'fired material has no metallic glint');
  assert.ok([...metal.values()].includes('#e143b2'), 'pack retains carried compound color');
  assert.ok(difference(metal, heavy) >= 3, 'light and heavy packs have different silhouettes');
});

test('production animal cache stays bounded and exceeds 95% hits across a varied evolving herd', t => withCanvasBoundary(() => {
  const r = rendererHarness(), g = { save() {}, restore() {}, translate() {}, scale() {}, drawImage() {} };
  r.reduceMotion = false; r.actionActive = true;
  const species = ['hare', 'deer', 'boar', 'fish', 'wolf', 'fox'] as const;
  const herd = Array.from({ length: 486 }, (_, i) => animal({ id: `a-${i}`, species: species[i % 6], morphology: { caution: .5, size: [.1, .5, .9][Math.floor(i / 6) % 3], coat: [.1, .5, .9][Math.floor(i / 18) % 3], defense: [.1, .5, .9][Math.floor(i / 54) % 3] }, habituation: [.1, .5, .9][Math.floor(i / 162) % 3] }));
  for (let frame = 0; frame < 120; frame++) for (const a of herd) r.drawAnimal(g, { view: { ...a, habituation: a.habituation! + frame / 10000 }, moving: true, stride: frame * .2, x: 0, y: 0, left: false }, frame / 60);
  const requests = herd.length * 120, hitRate = 1 - r.spriteBuilds / requests;
  t.diagnostic(`${requests} draws, ${r.spriteBuilds} sprite builds, ${(hitRate * 100).toFixed(2)}% cache hits`);
  assert.ok(hitRate > .95, `cache hits ${(hitRate * 100).toFixed(2)}%`);
  assert.ok(r.animalCache.size <= 2048);
  assert.equal(r.spriteCache.size, 0, 'animal phenotypes cannot evict static trees/buildings');
}));

test('production structure caches reuse stable sprites and invalidate material, kiln and chemical stock changes', () => withCanvasBoundary(() => {
  const r = rendererHarness(), base = structure({ materialProfile: { tint: '#2481ad', strength: .4, seal: .4, insulation: .5 } });
  const a = r.structureRaster(base);
  assert.equal(r.structureRaster({ ...base }), a);
  for (const next of [structure({ ...base, materialProfile: { ...base.materialProfile!, tint: '#be7341' } }), structure({ ...base, materialProfile: { ...base.materialProfile!, strength: .8 } }), structure({ ...base, materialProfile: { ...base.materialProfile!, seal: .8 } }), structure({ ...base, storedCompounds: [lot()] }), structure({ ...base, synergy: { kilnTier: 2, heated: false, sharedEdges: 0, irrigated: false, workshopBonus: 0 } })]) assert.notEqual(r.structureRaster(next), a);
  const hall = { ...base, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, g = { drawImage() {} };
  r.drawModularHall(g, hall, 0, false); r.drawModularHall(g, { ...hall }, 1, false);
  assert.equal(r.perf.hallBuilds, 1, 'unchanged hall keeps its baked image');
  r.drawModularHall(g, { ...hall, storedCompounds: [lot()] }, 2, false);
  r.drawModularHall(g, { ...hall, materialProfile: { ...hall.materialProfile!, tint: '#be7341' } }, 3, false);
  r.drawModularHall(g, { ...hall, synergy: { kilnTier: 2, heated: false, sharedEdges: 0, irrigated: false, workshopBonus: 0 } }, 4, false);
  assert.equal(r.perf.hallBuilds, 4);
}));
