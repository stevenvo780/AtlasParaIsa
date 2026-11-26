import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonView, StructureView, Tile, WorldStats, WorldView } from '../src/shared/types.js';
import { geologyAt, type ChemistrySummaryView, type CompoundLot, type ElementVector } from '../src/shared/chemistry.js';
import { MAP_LAYER_CATALOG } from '../src/client/layers-control.js';
import { hexToRgba, paintGeologyVeins, paintRoadTile, roadKind, roadLinks, veinsAt } from '../src/client/road-geology-art.js';
import {
  footprintBox, footprintCells, footprintLabel, isModular, mixHex, paintCompactAccessories, paintModularHall, paintPolyominoStructure, polyominoShape,
  structureExtent, structurePalette, structureTier, type ExtendedStructure,
} from '../src/client/structure-art.js';
import { structureCard } from '../src/client/inspector-view.js';
import {
  elementBadges, elementBar, renderChemistryTelemetry, renderLandTelemetry, renderPersonTelemetry, renderRoadsAndChemistryRollup, renderTelemetry,
  renderTileTelemetry, roadEffortRelief, roadState, telemetryKpis,
} from '../src/client/telemetry-hud.js';
import { capasDeCalor, dibujarCalor, leyendaEnRango, rangoRecibido, valorCrudo, type VistaCalor } from '../src/client/calor.js';
import { worldShell } from '../src/client/world-shell.js';

/* ------------------------------------------------------------------ */
/* Utilidades                                                           */
/* ------------------------------------------------------------------ */

interface Rect { x: number; y: number; w: number; h: number; color: string }
function recorder(): { g: CanvasRenderingContext2D; rects: Rect[] } {
  const rects: Rect[] = [];
  const state = { fillStyle: '' };
  const g = { get fillStyle() { return state.fillStyle; }, set fillStyle(v: string) { state.fillStyle = v; }, fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, color: state.fillStyle }); } };
  return { g: g as unknown as CanvasRenderingContext2D, rects };
}
/** Raster final (el último rectángulo manda) para preguntar por un píxel concreto. */
function raster(rects: readonly Rect[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) map.set(`${x},${y}`, r.color);
  return map;
}
const colors = (rects: readonly Rect[]): Set<string> => new Set(rects.map(r => r.color));
const signature = (rects: readonly Rect[]): string => rects.map(r => `${r.x},${r.y},${r.w},${r.h},${r.color}`).join('|');

const tile = (extra: Partial<Tile> = {}): Tile => ({ x: 4, y: 5, terrain: 'meadow', moisture: .4, vegetation: .3, food: 0, ...extra });
const ART = 16;

function structure(extra: Partial<ExtendedStructure> = {}): ExtendedStructure {
  return { id: 's1', x: 10, y: 20, blueprintId: 'b', name: 'Taller', components: ['frame', 'roof'], condition: .9, water: 0, food: 0, uses: 3, builtAt: 0, builderId: null, ...extra } as ExtendedStructure;
}
const cellsOf = (...pairs: [number, number][]) => pairs.map(([x, y]) => ({ x, y }));
const L3 = cellsOf([10, 20], [10, 21], [11, 21]);
const T4 = cellsOf([10, 20], [11, 20], [12, 20], [11, 21]);
const U5 = cellsOf([10, 20], [12, 20], [10, 21], [11, 21], [12, 21]);
const R32 = cellsOf([10, 20], [11, 20], [12, 20], [10, 21], [11, 21], [12, 21]);
const R22 = cellsOf([10, 20], [11, 20], [10, 21], [11, 21]);

/* ------------------------------------------------------------------ */
/* 1. Caminos                                                           */
/* ------------------------------------------------------------------ */

test('roadKind: senda desde tráfico 0,25, calzada desde empedrado 0,5 (manda sobre la senda); el agua nunca es camino', () => {
  assert.equal(roadKind(tile({ traffic: .24 })), null);
  assert.equal(roadKind(tile({ traffic: .25 })), 'dirt');
  assert.equal(roadKind(tile({ traffic: .9, paved: .49 })), 'dirt');
  assert.equal(roadKind(tile({ traffic: 0, paved: .5 })), 'paved');
  assert.equal(roadKind(tile({ traffic: 1, paved: 1, terrain: 'water' })), null);
  assert.equal(roadKind(undefined), null);
  assert.deepEqual(roadLinks({ n: tile({ traffic: .3 }), e: tile({ paved: .6 }), s: tile({ traffic: .1 }), w: undefined }), { n: true, e: true, s: false, w: false });
});

test('paintRoadTile: la senda de tierra pinta cinta de tierra, roderas y guijarros, sin adoquines', () => {
  const lonely = recorder();
  assert.equal(paintRoadTile(lonely.g, tile({ traffic: .6 }), {}), 'dirt');
  assert.ok(lonely.rects.length > 10, 'una senda no es un punto');
  const used = colors(lonely.rects);
  assert.ok([...used].some(c => c.startsWith('rgba(179,148,103') || c.startsWith('rgba(201,174,130')), 'tierra apisonada');
  assert.ok([...used].some(c => c.startsWith('rgba(141,113,73')), 'borde de la cinta');
  assert.ok(used.has('#dccaa0') || [...used].some(c => c.startsWith('rgba(122,98,64')), 'guijarros o roderas');
  assert.ok(![...used].some(c => ['#b9b2a0', '#625c4e', '#6f6a5c'].includes(c)), 'sin adoquín ni bordillo');
  const below = recorder();
  assert.equal(paintRoadTile(below.g, tile({ traffic: .2 }), {}), null);
  assert.equal(below.rects.length, 0);
});

test('paintRoadTile: los brazos de la senda siguen a los vecinos N/E/S/O que sean camino (senda o calzada)', () => {
  const ox = 4 * ART, oy = 5 * ART, here = tile({ traffic: .7 });
  const isolated = raster((() => { const r = recorder(); paintRoadTile(r.g, here, {}); return r.rects; })());
  const north = raster((() => { const r = recorder(); paintRoadTile(r.g, here, { n: tile({ traffic: .3 }) }); return r.rects; })());
  const eastPaved = raster((() => { const r = recorder(); paintRoadTile(r.g, here, { e: tile({ paved: .8 }) }); return r.rects; })());
  const grass = raster((() => { const r = recorder(); paintRoadTile(r.g, here, { n: tile({ traffic: .05 }), e: tile({ terrain: 'water', traffic: 1 }) }); return r.rects; })());
  assert.ok(!isolated.has(`${ox + 7},${oy}`), 'sin vecino la senda no llega al borde norte');
  assert.ok(north.has(`${ox + 7},${oy}`) && north.has(`${ox + 8},${oy}`), 'con vecino norte la cinta sale por el borde superior');
  assert.ok(!north.has(`${ox + 7},${oy + 15}`), 'y no por el sur');
  assert.ok(eastPaved.has(`${ox + 15},${oy + 7}`), 'una calzada vecina también conecta');
  assert.ok(!grass.has(`${ox + 7},${oy}`) && !grass.has(`${ox + 15},${oy + 7}`), 'hierba o agua vecina no conectan');
});

test('paintRoadTile: la calzada empedrada pinta adoquines alternos, juntas oscuras y bordillo, conectada con sus vecinos', () => {
  const r = recorder();
  assert.equal(paintRoadTile(r.g, tile({ paved: .8, traffic: .2 }), { n: tile({ paved: .9 }), s: tile({ traffic: .5 }) }), 'paved');
  const used = colors(r.rects);
  for (const c of ['#b9b2a0', '#625c4e']) assert.ok(used.has(c), `adoquín/junta ${c}`);
  assert.ok(used.has('#6f6a5c') || used.has('#948d7b'), 'bordillo de piedra');
  const px = raster(r.rects), ox = 4 * ART, oy = 5 * ART;
  assert.ok(px.has(`${ox + 7},${oy}`) && px.has(`${ox + 7},${oy + 15}`), 'la calzada continúa al norte y al sur');
  assert.ok(!px.has(`${ox},${oy + 7}`) && !px.has(`${ox + 15},${oy + 7}`), 'pero no al este ni al oeste: ahí hay bordillo y hierba');
  assert.equal(px.get(`${ox + 3},${oy + 8}`) === '#6f6a5c' || px.get(`${ox + 3},${oy + 8}`) === '#948d7b', true, 'bordillo a lo largo del lado cerrado');
  // Mismo mundo, mismas juntas: el patrón se ancla a coordenadas de mundo y es determinista.
  const again = recorder(); paintRoadTile(again.g, tile({ paved: .8, traffic: .2 }), { n: tile({ paved: .9 }), s: tile({ traffic: .5 }) });
  assert.equal(signature(again.rects), signature(r.rects));
  const dirt = recorder(); paintRoadTile(dirt.g, tile({ traffic: .8 }), { n: tile({ paved: .9 }) });
  assert.notEqual(signature(dirt.rects), signature(r.rects), 'senda y calzada se distinguen a simple vista');
});

/* ------------------------------------------------------------------ */
/* 2. Geología                                                          */
/* ------------------------------------------------------------------ */

test('paintGeologyVeins: hierro, cal y sal salen de geologyAt y se pintan con su paleta', () => {
  const seed = 7;
  const iron = tile({ x: 3, y: 4, biome: 'mountain', feature: 'rock' }), lime = tile({ x: 3, y: 4, biome: 'wetland', feature: 'clay' }), salt = tile({ x: 3, y: 4, biome: 'desert', feature: 'spring' });
  assert.ok(geologyAt(seed, 3, 4, 'mountain', 'rock').Fe >= .24);
  const a = recorder(); assert.deepEqual(paintGeologyVeins(a.g, iron, seed), ['Fe']);
  assert.ok([...colors(a.rects)].some(c => c.startsWith('rgba(156,78,46')), 'óxido #9c4e2e');
  assert.ok(colors(a.rects).has('#d68c45'), 'mota ocre #d68c45');
  const b = recorder(); assert.deepEqual(paintGeologyVeins(b.g, lime, seed), ['Ca']);
  assert.ok([...colors(b.rects)].some(c => c.startsWith('rgba(228,223,208')) && [...colors(b.rects)].some(c => c.startsWith('rgba(203,194,174')), 'tiza #e4dfd0 / #cbc2ae');
  const c = recorder(); assert.deepEqual(paintGeologyVeins(c.g, salt, seed), ['S']);
  assert.ok(colors(c.rects).has('#fff8dc') && [...colors(c.rects)].some(k => k.startsWith('rgba(232,230,184')), 'cristales de sal #fff8dc / #e8e6b8');
  const again = recorder(); paintGeologyVeins(again.g, iron, seed);
  assert.equal(signature(again.rects), signature(a.rects), 'determinista por casilla y semilla');
  for (const r of [...a.rects, ...b.rects, ...c.rects]) assert.ok(r.x >= 3 * ART - 1 && r.x + r.w <= 4 * ART + 1 && r.y >= 4 * ART - 1 && r.y + r.h <= 5 * ART + 1, 'las motas quedan en su casilla');
});

test('paintGeologyVeins: sin semilla, en agua o en refugio no pinta nada; una pradera sin veta tampoco', () => {
  for (const [t, seed] of [[tile({ biome: 'mountain', feature: 'rock' }), undefined], [tile({ biome: 'mountain', feature: 'rock', terrain: 'water' }), 7], [tile({ biome: 'mountain', feature: 'rock', terrain: 'shelter' }), 7]] as const) {
    const r = recorder(); assert.deepEqual(paintGeologyVeins(r.g, t, seed), []); assert.equal(r.rects.length, 0);
  }
  assert.deepEqual(veinsAt(tile({ x: 3, y: 4, biome: 'grassland' }), 7), []);
  // Distintas semillas mueven las vetas fuertes (las de estratos), no las de bioma: dos semillas bastan para ver una diferencia.
  const pixels = (seed: number) => { const r = recorder(); paintGeologyVeins(r.g, tile({ x: 3, y: 4, biome: 'mountain', feature: 'rock' }), seed); return r.rects.length; };
  assert.ok(pixels(7) > 0 && pixels(99) > 0);
});

/* ------------------------------------------------------------------ */
/* 3. Poliominós                                                        */
/* ------------------------------------------------------------------ */

test('la planta se lee de `cells` primero: caja, casillas, etiqueta y modularidad', () => {
  const ell = structure({ cells: L3, footprint: { width: 1, height: 1 } as never });
  assert.deepEqual(footprintBox(ell), { x0: 10, y0: 20, w: 2, h: 2 });
  assert.equal(footprintCells(ell).length, 3);
  assert.equal(footprintLabel(ell), 'L · 3c');
  assert.equal(footprintLabel(structure({ cells: T4 })), 'T · 4c');
  assert.equal(footprintLabel(structure({ cells: U5 })), 'U · 5c');
  assert.equal(footprintLabel(structure({ cells: R32 })), '3×2');
  assert.equal(footprintLabel(structure({ cells: R22 })), '2×2');
  assert.equal(footprintLabel(structure({ cells: cellsOf([10, 20], [11, 20]) })), '2×1');
  assert.equal(footprintLabel(structure({ cells: cellsOf([10, 20], [11, 20], [12, 20]) })), '3×1');
  assert.equal(footprintLabel(structure({ cells: cellsOf([10, 20]) })), '1×1');
  assert.equal(polyominoShape(cellsOf([0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [3, 1])), null, 'una forma desconocida no se inventa');
  assert.equal(footprintLabel(structure({ cells: cellsOf([0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [3, 1]).map(c => ({ x: c.x + 10, y: c.y + 20 })) })), 'Irregular · 6c');
  assert.equal(polyominoShape(cellsOf([5, 5], [6, 5], [5, 6], [4, 6])), 'S', 'rotaciones y reflejos reconocidos');
  assert.equal(isModular(ell), true);
  assert.equal(isModular(structure({ cells: cellsOf([10, 20]) })), false);
  assert.equal(isModular(structure({ cells: L3, site: { requiredWood: 1, requiredStone: 1, depositedWood: 0, depositedStone: 0, requiredWork: 1, completedWork: 0 } })), false);
  // Sin `cells` manda `footprint`, y sin ninguno la casilla ancla (comportamiento V19 intacto).
  assert.deepEqual(footprintBox(structure({ footprint: { width: 2, height: 1 } })), { x0: 10, y0: 20, w: 2, h: 1 });
  assert.equal(footprintLabel(structure()), '');
  assert.equal(structureTier(structure({ cells: L3 })), 'hall', 'tres casillas = salón aunque su caja sea de 4');
  assert.equal(structureTier(structure({ cells: T4 })), 'grand');
});

test('paintPolyominoStructure: L, T y 3×2 se ven distintos y quedan dentro de su extensión', () => {
  const sigs = new Map<string, string>(), counts = new Map<string, number>();
  for (const [name, cells] of [['L', L3], ['T', T4], ['3x2', R32], ['U', U5], ['2x2', R22]] as const) {
    const s = structure({ cells, components: ['frame', 'frame', 'roof'] }), r = recorder();
    paintModularHall(r.g, s, 0, false); // el salón delega en el pintor de poliominós cuando hay `cells`
    const direct = recorder(); paintPolyominoStructure(direct.g, s, 0, false);
    assert.equal(signature(r.rects), signature(direct.rects), `${name}: paintModularHall delega`);
    sigs.set(name, signature(r.rects)); counts.set(name, r.rects.length);
    const ext = structureExtent(s);
    for (const rect of r.rects) assert.ok(rect.x >= ext.left - 14 && rect.x + rect.w <= ext.right + 14 && rect.y >= ext.top - 14 && rect.y + rect.h <= ext.bottom + 12, `${name} dentro de la extensión (${rect.x},${rect.y})`);
  }
  assert.equal(new Set(sigs.values()).size, sigs.size, 'cada planta dibuja un edificio distinto');
  assert.ok(counts.get('3x2')! > counts.get('L')!, 'más casillas, más edificio');
});

test('paintPolyominoStructure: los bordes internos se funden y solo los exteriores llevan alero, poste y cimiento', () => {
  const r = recorder(); paintPolyominoStructure(r.g, structure({ cells: R22 }), 0, false);
  const px = raster(r.rects), timber = '#5a4330';
  const roofRow = 20 * ART - 14 + 6; // fila de tejado de la fila norte
  assert.notEqual(px.get(`${11 * ART - 1},${roofRow}`), timber, 'sin costura de madera entre casillas vecinas');
  assert.notEqual(px.get(`${11 * ART},${roofRow}`), timber);
  assert.equal(px.get(`${10 * ART - 1},${roofRow}`), timber, 'alero/poste en el borde oeste exterior');
  assert.equal(px.get(`${12 * ART},${roofRow}`), timber, 'y en el este exterior');
  assert.equal(px.get(`${10 * ART},${20 * ART - 14}`), timber, 'borde norte exterior');
  // Solo la fila sur tiene frente (muro + cimiento): la fila norte queda cubierta por su tejado continuo.
  const southGround = 21 * ART + 13, northGround = 20 * ART + 13;
  assert.equal(px.get(`${10 * ART + 3},${southGround - 2}`) !== undefined, true, 'cimiento al sur');
  const stone = '#c4bdaa';
  assert.notEqual(px.get(`${10 * ART + 3},${northGround - 1}`), stone, 'sin cimiento en el borde interior');
  // L: la casilla que falta (11,20) deja el hueco: ahí no hay tejado.
  const l = recorder(); paintPolyominoStructure(l.g, structure({ cells: L3 }), 0, false);
  const lp = raster(l.rects);
  assert.equal(lp.has(`${11 * ART + 8},${20 * ART - 14 + 6}`), false, 'hueco de la L');
  assert.equal(lp.has(`${10 * ART + 8},${20 * ART - 14 + 6}`), true);
});

test('perfil material: el tinte mezcla muros y tejado (arcilla, caliza, hierro) y sin perfil no cambia nada', () => {
  const plain = structure({ cells: R22 }), clay = structure({ cells: R22, materialProfile: { strength: .5, insulation: .6, seal: .4, tint: '#c2603a' } });
  const lime = structure({ cells: R22, materialProfile: { strength: .5, insulation: .6, seal: .4, tint: '#e4dfd0' } });
  const p = structurePalette(plain), c = structurePalette(clay), l = structurePalette(lime);
  assert.equal(c.wall, mixHex('#c4a87c', '#c2603a', .55));
  assert.notEqual(c.wall, p.wall); assert.notEqual(c.roof, p.roof); assert.notEqual(c.wall, l.wall);
  assert.equal(structurePalette(structure({ cells: R22, materialProfile: { strength: 1, insulation: 1, seal: 1, tint: 'no-es-color' } })).wall, p.wall, 'un tinte inválido se ignora');
  const rp = recorder(), rc = recorder(), rl = recorder();
  paintPolyominoStructure(rp.g, plain, 0, false); paintPolyominoStructure(rc.g, clay, 0, false); paintPolyominoStructure(rl.g, lime, 0, false);
  assert.ok(colors(rc.rects).has(c.wall) && colors(rc.rects).has(c.roof), 'la obra de arcilla usa su paleta');
  assert.ok(!colors(rp.rects).has(c.wall));
  assert.notEqual(signature(rc.rects), signature(rl.rects), 'pueblo de arcilla ≠ pueblo de caliza');
  // El salón rectangular V19 (sin `cells`) también se tiñe.
  const hall = recorder(); paintModularHall(hall.g, structure({ footprint: [{ x: 10, y: 20 }, { x: 11, y: 20 }], materialProfile: { strength: .5, insulation: .6, seal: .4, tint: '#c2603a' } }), 0, false);
  assert.ok(colors(hall.rects).has(c.wall));
  assert.equal(mixHex('#000000', '#ffffff', .5), '#808080');
  assert.equal(mixHex('#123', '#ffffff', 1), '#ffffff');
});

test('sinergias: horno T2 con brasa y humo, banco y yunque, muros compartidos, riego y compuestos', () => {
  const base = { cells: T4 } as const;
  const none = recorder(); paintPolyominoStructure(none.g, structure(base), 1, true);
  const cold = colors(none.rects);
  for (const c of ['#ff7a2a', '#d9b987', '#3fa9c9', '#59656d']) assert.ok(!cold.has(c), `sin sinergia no hay ${c}`);
  assert.ok(![...cold].some(c => c.startsWith('rgba(232,228,218')), 'ni humo');

  const kiln = recorder(); paintPolyominoStructure(kiln.g, structure({ ...base, synergy: { sharedEdges: 0, heated: true, irrigated: false, workshopBonus: 0, kilnTier: 2 } }), 1, true);
  assert.ok(colors(kiln.rects).has('#ff7a2a') && colors(kiln.rects).has('#ffd27a'), 'brasa del horno T2');
  assert.ok([...colors(kiln.rects)].some(c => c.startsWith('rgba(232,228,218')), 'humo ascendente');
  const kilnT = recorder(); paintPolyominoStructure(kilnT.g, structure({ ...base, synergy: { sharedEdges: 0, heated: true, irrigated: false, workshopBonus: 0, kilnTier: 2 } }), 2.3, true);
  assert.notEqual(signature(kilnT.rects), signature(kiln.rects), 'el humo se anima con el tiempo');
  const still = recorder(), still2 = recorder(); const ks = structure({ ...base, synergy: { sharedEdges: 0, heated: false, irrigated: false, workshopBonus: 0, kilnTier: 2 } });
  paintPolyominoStructure(still.g, ks, 0, false); paintPolyominoStructure(still2.g, ks, 9, false);
  assert.equal(signature(still.rects), signature(still2.rects), 'con movimiento reducido el dibujo no cambia');
  const t1 = recorder(); paintPolyominoStructure(t1.g, structure({ ...base, synergy: { sharedEdges: 0, heated: false, irrigated: false, workshopBonus: 0, kilnTier: 1 } }), 0, false);
  assert.ok(!colors(t1.rects).has('#ff7a2a'), 'un horno T1 sin calor no brilla como el T2');

  const shop = recorder(); paintPolyominoStructure(shop.g, structure({ ...base, synergy: { sharedEdges: 0, heated: false, irrigated: false, workshopBonus: .2 } }), 0, false);
  assert.ok(colors(shop.rects).has('#59656d') && colors(shop.rects).has('#8a6a46'), 'yunque de acero oscuro y banco');

  const shared = recorder(); paintPolyominoStructure(shared.g, structure({ ...base, synergy: { sharedEdges: 2, heated: false, irrigated: false, workshopBonus: 0 } }), 0, false);
  const pillars = shared.rects.filter(r => r.color === '#d9b987');
  assert.ok(pillars.length >= 2, 'contrafuertes de piedra cálida en las esquinas + arco');

  const wet = recorder(); paintPolyominoStructure(wet.g, structure({ ...base, synergy: { sharedEdges: 0, heated: false, irrigated: true, workshopBonus: 0 } }), 0, false);
  assert.ok(colors(wet.rects).has('#3fa9c9') && colors(wet.rects).has('#bfeaf5'), 'canal de riego con destello');
  const wetFrames = new Set([0, 1, 2, 3].map(t => { const r = recorder(); paintPolyominoStructure(r.g, structure({ ...base, synergy: { sharedEdges: 0, heated: false, irrigated: true, workshopBonus: 0 } }), t, true); return signature(r.rects); }));
  assert.ok(wetFrames.size > 1, 'el destello corre');
});

test('compuestos almacenados: ánforas (cocidos) y cajas (crudos) con el color de cada lote', () => {
  const lot = (id: string, phase: CompoundLot['phase'], colorHex: string, mass = 2): CompoundLot => ({ id, formulaId: `f-${id}`, composition: { C: .2, Si: .3, Ca: .2, Fe: .1, S: .1, H: .1 }, phase, mass,
    properties: { hardness: .4, toughness: .3, seal: .5, insulation: .2, fuelPower: .1, colorHex } });
  const none = recorder(); paintPolyominoStructure(none.g, structure({ cells: R32 }), 0, false);
  const r = recorder(); paintPolyominoStructure(r.g, structure({ cells: R32, storedCompounds: [lot('a', 'fired', '#8a3b2c', 5), lot('b', 'raw', '#3b6e8a', 3), lot('c', 'ground', 'rojo', 1)] }), 0, false);
  assert.ok(colors(r.rects).has('#8a3b2c') && colors(r.rects).has('#3b6e8a'), 'cada lote se pinta con su colorHex');
  assert.ok(!colors(none.rects).has('#8a3b2c'));
  assert.ok(r.rects.length > none.rects.length + 6);
  const empty = recorder(); paintPolyominoStructure(empty.g, structure({ cells: R32, storedCompounds: [lot('z', 'raw', '#8a3b2c', 0)] }), 0, false);
  assert.ok(!colors(empty.rects).has('#8a3b2c'), 'un lote sin masa no se dibuja');
  // Una choza de 1×1 también enseña sus sinergias y su bodega junto al sprite.
  const hut = recorder(); paintCompactAccessories(hut.g, structure({ cells: cellsOf([10, 20]), storedCompounds: [lot('a', 'fired', '#8a3b2c')], synergy: { sharedEdges: 1, heated: true, irrigated: true, workshopBonus: .1, kilnTier: 2 }, materialProfile: { strength: .5, insulation: .5, seal: .5, tint: '#c2603a' } }));
  for (const c of ['#8a3b2c', '#ff7a2a', '#d9b987', '#3fa9c9', '#59656d']) assert.ok(colors(hut.rects).has(c), `choza con ${c}`);
  assert.ok([...colors(hut.rects)].some(c => c.startsWith('rgba(194,96,58')), 'velo de tinte sobre el muro');
  const plainHut = recorder(); paintCompactAccessories(plainHut.g, structure());
  assert.equal(plainHut.rects.length, 0, 'sin datos V20 la choza compacta no cambia');
});

test('un salón rectangular V19 sin `cells` también enseña su sinergia V20', () => {
  const r = recorder(); paintModularHall(r.g, structure({ footprint: [{ x: 10, y: 20 }, { x: 11, y: 20 }], synergy: { sharedEdges: 1, heated: true, irrigated: false, workshopBonus: .3, kilnTier: 2 } }), 0, false);
  assert.ok(colors(r.rects).has('#ff7a2a') && colors(r.rects).has('#59656d') && colors(r.rects).has('#d9b987'));
});

/* ------------------------------------------------------------------ */
/* 4. Inspector, telemetría y capa de calor                              */
/* ------------------------------------------------------------------ */

const lot = (id: string, phase: CompoundLot['phase'], colorHex: string, mass = 1.5): CompoundLot => ({ id, formulaId: `Fe-Si ${id}`, composition: { C: .1, Si: .3, Ca: .2, Fe: .3, S: .05, H: .05 }, phase, mass,
  properties: { hardness: .62, toughness: .4, seal: .35, insulation: .2, fuelPower: .05, colorHex } });
const rich = (): StructureView => ({ id: 'w1', x: 10, y: 20, blueprintId: 'b', name: 'Taller', components: ['frame', 'cistern'], condition: .9, water: .2, food: 0, uses: 3, builtAt: 0, builderId: null,
  cells: L3, synergy: { sharedEdges: 2, heated: true, irrigated: true, workshopBonus: .15, kilnTier: 2 }, materialProfile: { strength: .62, insulation: .4, seal: .3, tint: '#c2603a' },
  storedCompounds: [lot('a', 'fired', '#8a3b2c', 2.5), lot('b', 'smelted', '#3b6e8a'), lot('c', 'vitrified', '#2f8a7a'), lot('d', 'raw', '#a29484'), lot('e', 'ground', '#9a8a70'), lot('f', 'washed', '#7a8a9a')] });

test('structureCard muestra planta poliominó, sinergias, perfil material y compuestos', () => {
  const html = structureCard(rich(), null);
  assert.match(html, /data-structure-footprint[^>]*><span>Planta<\/span><strong>L · 3c <small>3 casillas<\/small>/);
  assert.match(html, /data-structure-synergy/);
  for (const text of ['+2 muros compartidos', 'Secado / calor local', 'Horno T2', 'Riego de cisterna', 'Taller -15% tiempo']) assert.ok(html.includes(text), text);
  assert.match(html, /data-structure-material[\s\S]*background:#c2603a[\s\S]*Fuerza <strong>62%<\/strong>[\s\S]*Aislamiento <strong>40%<\/strong>[\s\S]*Sellado <strong>30%<\/strong>/);
  assert.match(html, /data-structure-compounds/);
  for (const phase of ['cocido', 'fundido', 'vítreo', 'crudo', 'molido', 'lavado']) assert.ok(html.includes(`>${phase}<`), `fase ${phase}`);
  assert.ok(html.includes('background:#8a3b2c') && html.includes('2,5 u.') || html.includes('2.5 u.'), 'swatch y masa del lote');
  const tier1 = structureCard({ ...rich(), synergy: { sharedEdges: 1, heated: false, irrigated: false, workshopBonus: 0, kilnTier: 1 } }, null);
  assert.ok(tier1.includes('Horno T1') && tier1.includes('1 muro compartido') && !tier1.includes('Riego') && !tier1.includes('Taller -'));
  const legacy = structureCard({ id: 's', x: 0, y: 0, blueprintId: 'b', name: 'Granero', components: ['granary'], condition: .8, water: 2, food: 7, uses: 4, builtAt: 0, builderId: null }, null);
  for (const hook of ['data-structure-synergy', 'data-structure-material', 'data-structure-compounds', 'structure-v20']) assert.ok(!legacy.includes(hook), `sin V20 no hay ${hook}`);
  const evil = structureCard({ ...rich(), materialProfile: { strength: 1, insulation: 1, seal: 1, tint: '"><script>x</script>' } }, null);
  assert.ok(!evil.includes('<script>'), 'el tinte llega escapado y validado');
});

const statsFixture = (extra: Partial<WorldStats> = {}): WorldStats => ({ population: 10, meanEnergy: .7, meanHunger: .2, meanFatigue: .3, meanThirst: .1, materials: { wood: 1, stone: 1 }, actions: {}, biomes: {}, features: {}, totals: {},
  generations: {}, history: [], scope: 'active-regions', wildlife: {}, freshWater: 1, cultivatedTiles: 4, trailTiles: 2, blueprints: 3, ...extra });
const chemistry = (): ChemistrySummaryView => ({
  totalFormulas: 14, totalLots: 9, maxTemperatureTier: 2, byOperator: { grind: 5, wash: 3, heat: 4, bind: 2 },
  formulas: [{ id: 'f1', signature: 'sig', name: 'Ladrillo cocido', composition: { C: .02, Si: .4, Ca: .1, Fe: .3, S: .03, H: .15 }, phase: 'fired', temperatureTier: 2, operator: 'heat', discoveredAt: 321, discovererId: 'p', uses: 7,
    properties: { hardness: .62, toughness: .41, seal: .33, insulation: .2, fuelPower: .05, colorHex: '#b5532e' } }] });
const worldFixture = (extra: Partial<WorldView> = {}): WorldView => ({ version: 10, sequence: 0, tick: 250, day: 1, phase: 'day', weather: 'clear', width: 3, height: 1, geologyKey: 7,
  tiles: [tile({ x: 3, y: 4, biome: 'mountain', feature: 'rock', traffic: .5, paved: .8 }), tile({ x: 4, y: 4, traffic: .3 }), tile({ x: 5, y: 4 })],
  people: [], animals: [], structures: [rich()], places: [], memories: [], events: [], stats: statsFixture({ pavedTiles: 12, polyominoStructures: 3, synergyLinks: 5, chemicalFormulas: 14 }), chemistry: chemistry(), ...extra } as unknown as WorldView);

test('renderChemistryTelemetry: resumen, operadores y tarjetas de fórmulas con barra de 6 elementos', () => {
  const html = renderChemistryTelemetry(chemistry());
  assert.match(html, /data-chemistry/);
  for (const text of ['Fórmulas', '>14<', 'Lotes activos', '>9<', 'T2 · horno', 'Operador · moler', '>5<', 'Operador · lavar', 'Operador · calentar', 'Operador · unir']) assert.ok(html.includes(text), text);
  assert.match(html, /data-formula="f1"[\s\S]*background:#b5532e[\s\S]*Ladrillo cocido[\s\S]*>cocido<[\s\S]*>T2<[\s\S]*>calentar</);
  assert.equal((html.match(/data-element="(C|Si|Ca|Fe|S|H)" style="flex/g) ?? []).length, 6, 'seis tramos');
  for (const label of ['Dureza', 'Tenacidad', 'Sellado', 'Aislamiento', 'Combustible']) assert.ok(html.includes(`aria-label="${label}"`), label);
  assert.ok(html.includes('Se muestran 1 de 14 fórmulas'));
  assert.equal(renderChemistryTelemetry(undefined), '');
  assert.ok(renderChemistryTelemetry({ ...chemistry(), formulas: [], totalFormulas: 0 }).includes('Todavía nadie ha descubierto una fórmula'));
  const bar = elementBar({ C: 0, Si: 0, Ca: 0, Fe: 0, S: 0, H: 0 } satisfies ElementVector);
  assert.ok(bar.includes('element-bar'), 'una composición vacía no rompe');
});

test('renderTileTelemetry: camino, alivio de esfuerzo y geología local desde la semilla del mundo', () => {
  const rock = tile({ x: 3, y: 4, biome: 'mountain', feature: 'rock' });
  const none = renderTileTelemetry(rock, 7);
  assert.match(none, /data-tile-road="none"[\s\S]*Sin sendero[\s\S]*0%/);
  assert.match(none, /data-tile-geology/);
  for (const e of ['C', 'Si', 'Ca', 'Fe', 'S', 'H']) assert.ok(none.includes(`data-element="${e}"`), e);
  assert.match(none, /is-vein" data-element="Fe"/, 'el hierro aflora como veta');
  assert.equal(renderTileTelemetry(rock).includes('data-tile-geology'), false, 'sin semilla no se inventa geología');
  assert.equal(renderTileTelemetry(tile({ terrain: 'water' }), 7).includes('data-tile-geology'), false);
  const trail = renderTileTelemetry(tile({ traffic: .4 }), 7), paved = renderTileTelemetry(tile({ traffic: .4, paved: .9 }), 7);
  assert.match(trail, /data-tile-road="trail"[\s\S]*Sendero pisado/);
  assert.match(paved, /data-tile-road="paved"[\s\S]*Calzada empedrada/);
  assert.equal(roadState(tile({ traffic: .9, terrain: 'water' })), 'none');
  assert.ok(Math.abs(roadEffortRelief({ traffic: .4 }) - .18) < 1e-9);
  assert.ok(Math.abs(roadEffortRelief({ traffic: 1, paved: 1 }) - .55) < 1e-9, 'el alivio nunca pasa del 55 %');
  assert.match(paved, /Alivio de esfuerzo<strong>\d+%/);
  assert.equal(elementBadges(geologyAt(7, 3, 4, 'mountain', 'rock')).match(/<span class="element-badge/g)!.length, 6);
});

test('renderTileTelemetry: informa el empedrado incipiente sin dibujar una calzada', () => {
  for (const [real, index] of [[0.0000991224, '0,0000991'], [0.0001257473, '0,000126'], [0.4999, '0,4999']] as const) {
    const camino = tile({ traffic: 0.823, paved: Math.fround(real) });
    const html = renderTileTelemetry(camino);
    assert.match(html, /data-tile-road="trail"/);
    assert.ok(html.includes(`Empedrado incipiente · índice 0–1<strong>${index}</strong>`));
    assert.equal(roadKind(camino), 'dirt');
  }
  assert.ok(renderTileTelemetry(tile()).includes('índice 0–1<strong>No informado</strong>'));
  assert.ok(renderTileTelemetry(tile({ paved: 0 })).includes('índice 0–1<strong>0</strong>'));
  assert.match(renderTileTelemetry(tile({ paved: 0.5 })), /data-tile-road="paved".*Calzada empedrada/);
  assert.equal(roadKind(tile({ paved: 0.5 })), 'paved');
});

test('Ahora de la persona muestra los compuestos que lleva', () => {
  const person = { id: 'p', name: 'P', role: 'neighbor', x: 0, y: 0, color: '#abc', action: 'build', reason: '', energy: .6, hunger: .2, fatigue: .1, need: 'Agua', recentMemory: null,
    compounds: [lot('x', 'fired', '#8a3b2c', 1.25)] } as unknown as PersonView;
  const html = renderPersonTelemetry(person);
  assert.match(html, /data-person-compounds[\s\S]*background:#8a3b2c[\s\S]*>cocido<[\s\S]*1,25 u\.[\s\S]*dureza 62%[\s\S]*sellado 35%[\s\S]*combustible 5%/);
  assert.ok(!renderPersonTelemetry({ ...person, compounds: undefined }).includes('data-person-compounds'));
  assert.ok(!renderPersonTelemetry({ ...person, compounds: [] }).includes('data-person-compounds'));
});

test('Mundo › Paisaje suma calzadas, poliominós, sinergias y compuestos de las bodegas de esta vista', () => {
  const world = worldFixture();
  const rollup = renderRoadsAndChemistryRollup(world);
  for (const text of ['Calzadas empedradas', '>12<', 'Edificios poliominó', '>3<', 'Enlaces de sinergia', '>5<', 'Fórmulas descubiertas', '>14<', 'Compuestos en bodegas de esta vista', '6 lotes']) assert.ok(rollup.includes(text), text);
  assert.ok(renderLandTelemetry(world).includes('Compuestos en bodegas de esta vista'), 'forma parte de la pestaña Paisaje');
  const sparse = renderRoadsAndChemistryRollup(worldFixture({ stats: statsFixture(), chemistry: undefined, structures: [] }));
  assert.ok(sparse.includes('—'), 'lo que el servidor no proyecta se muestra como —, no como cero');
});

test('KPIs del HUD: Paisaje y Oficios enseñan calzadas y fórmulas solo si hay y las detallan en el tooltip', () => {
  const world = worldFixture(), kpis = telemetryKpis(world), land = kpis.find(k => k.nav === 'land')!, tech = kpis.find(k => k.nav === 'technology')!;
  assert.ok(land.value.includes('12 calz.') && land.detail.includes('12 calzadas empedradas') && land.detail.includes('3 edificios poliominó'));
  assert.ok(tech.value.includes('14 fórm.') && tech.detail.includes('14 fórmulas químicas emergentes'));
  const quiet = telemetryKpis(worldFixture({ stats: statsFixture({ pavedTiles: 0, chemicalFormulas: 0 }) }));
  assert.ok(!quiet.find(k => k.nav === 'land')!.value.includes('calz.') && !quiet.find(k => k.nav === 'technology')!.value.includes('fórm.'), 'en cero no abulta la barra');
  assert.ok(renderTelemetry(world).includes('12 calz.'));
});

test('capa de calor «caminos»: tráfico y empedrado dibujan la red de caminos y aparece en el selector', () => {
  assert.ok(capasDeCalor.includes('caminos'));
  assert.equal(valorCrudo(tile({ traffic: .5, paved: .2 }), 'caminos'), Math.min(1, .5 * .7 + .2 * .5));
  assert.equal(valorCrudo(tile({ traffic: 1, paved: 1 }), 'caminos'), 1, 'acotada a 1');
  assert.equal(valorCrudo(tile(), 'caminos'), 0);
  assert.ok(MAP_LAYER_CATALOG.some(layer => layer.id === 'roads' && layer.label === 'Caminos y calzadas'));
  const tiles = [tile({ x: 0, y: 0 }), tile({ x: 1, y: 0, traffic: .6 }), tile({ x: 2, y: 0, paved: 1 })];
  const llamadas: { color: string }[] = [], state = { fillStyle: '' };
  const ctx = { get fillStyle() { return state.fillStyle; }, set fillStyle(v: string) { state.fillStyle = v; }, fillRect() { llamadas.push({ color: state.fillStyle }); } } as unknown as CanvasRenderingContext2D;
  const vista: VistaCalor = { x0: 0, y0: 0, tileSize: 16, scale: 1 };
  dibujarCalor(ctx, tiles, 'caminos', vista, .55, rangoRecibido(tiles, 'caminos'));
  assert.equal(llamadas.length, 3);
  assert.equal(new Set(llamadas.map(l => l.color)).size, 3, 'sin camino, senda y calzada se distinguen');
  const leyenda = leyendaEnRango('caminos', rangoRecibido(tiles, 'caminos'));
  assert.equal(leyenda.titulo, 'Caminos y calzadas'); assert.equal(leyenda.paradas.length, 5); assert.ok(leyenda.paradas.at(-1)!.etiqueta.includes('%'));
  assert.equal(hexToRgba('#102030', .5), 'rgba(16,32,48,0.5)');
});
