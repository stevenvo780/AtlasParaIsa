import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, type World, type Person } from '../../src/world/index.js';
import type { Tile, ChronicleEvent } from '../../src/shared/types.js';
import { parseParams, setParams } from '../../src/world/params.js';
import { ResidentTopologyOwner } from '../../src/world/soa/topologia.js';
import { TileStore, residentFastAccess } from '../../src/world/soa/terreno.js';
import { tileLookup } from '../../src/world/tile-index.js';
import { computeLocalPolicyObservation } from '../../src/world/politica-obs.js';
import { inventionContext, inventionCandidates, constructionOpportunity } from '../../src/world/inventions.js';
import { cooperationOpportunity, settlementOpportunity, convivir, bond, updateCommunities } from '../../src/world/society.js';
import { conRejilla, vecinos, primerVecino, personaMovida } from '../../src/world/rejilla.js';
import { filtrarCerca, primeroCerca, algunoCerca } from '../../src/world/indice-puntos.js';
import { researchTechnology, type TechnologyProgram } from '../../src/world/technology.js';
import { proyectoInvestigacion, PROGRAMA_FILO } from '../lib/escenas.js';

// deepStrictEqual uses Object.is for numbers, preserving -0 and rejecting even
// a one-ULP difference; Float64Array buffers additionally compare actual bytes.
function bits(a: Float64Array, b: Float64Array): void {
  assert.deepEqual(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}
const laws = 'motor.hilos=1,social.ensenanzaRareza=0.5,social.vinculoConvivencia=0.01,social.hogarTrabajo=0.4,social.radioConvivencia=12,social.disolucion=1,social.derivaCultural=1';
function scene(): World {
  const w = createWorld(51926, parseParams(laws)), template = w.people[2]!;
  w.people = Array.from({ length: 12 }, (_, i) => {
    const p = structuredClone(template);
    p.id = `p${11 - i}`; p.role = 'neighbor'; p.x = -16 + i % 4; p.y = -16 + Math.floor(i / 4);
    p.target = { x: p.x, y: p.y }; p.action = 'rest'; p.lastSocial = -1000;
    p.communityId = null; p.bonds = {}; p.materials = { wood: 0, stone: 0 };
    p.technology.knownRecipes = []; p.technology.items = []; p.technology.competence = {};
    p.visited = ['-16,-16', '-12,-16', '01,2'];
    return p;
  });
  w.tiles = [];
  for (let y = -24; y <= -6; y++) for (let x = -24; x <= -6; x++) {
    const k = (x + 24) + (y + 24) * 19;
    w.tiles.push({ x, y, terrain: k % 17 === 0 ? 'water' : k % 13 === 0 ? 'shelter' : 'meadow',
      moisture: (k % 11) / 13, vegetation: 0.3, food: (k % 7) / 71,
      ...(k % 3 ? { wood: (k % 5) / 7 } : {}), stone: (k % 7) / 9,
      ...(k % 4 ? { drinkingWater: (k % 9) / 101 } : {}) });
  }
  w.structures = []; w.places = [{ ...w.places[0]!, x: -13, y: -16 }]; w.communities = [];
  const teacher = w.people[0]!;
  const weave: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'weave', intensity: 4 }, { op: 'form', intensity: 2, shape: 'sheet' }] };
  for (const program of [PROGRAMA_FILO, weave]) {
    teacher.materials = { wood: 12, stone: 8 }; teacher.energy = 1; teacher.fatigue = 0;
    teacher.technology.project = proyectoInvestigacion(structuredClone(program), w.tick);
    for (let i = 0; teacher.technology.project && i < 200; i++) { w.tick++; researchTechnology(w, teacher); }
    assert.equal(teacher.technology.project, null);
  }
  teacher.materials = { wood: 0, stone: 0 }; teacher.technology.items = [];
  w.tick = 1200;
  return w;
}
function emit(w: World) {
  return (e: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => {
    const event = { ...e, id: `event-${++w.eventCounter}`, tick: w.tick }; w.events.push(event); return event;
  };
}
function outputs(w: World) {
  return conRejilla(w, () => w.people.map(p => ({
    invention: inventionContext(w, p), candidates: inventionCandidates(w, p), construction: constructionOpportunity(w, p),
    cooperation: cooperationOpportunity(w, p), settlement: settlementOpportunity(w, p),
  })));
}

test('V18: plain / exact resident / mixed new chunks, 0 ULP outputs and mutation order', () => {
  const source = scene();
  for (const mixed of [false, true]) {
    const plain = structuredClone(source), resident = structuredClone(source);
    setParams(plain, parseParams(laws)); setParams(resident, parseParams(laws));
    const owner = new ResidentTopologyOwner(); resident.tiles = owner.tiles(resident.tiles.map(t => owner.tile(t)));
    const store = new TileStore(); store.prepareParallel(resident.tiles);
    assert.ok(residentFastAccess(resident.tiles)?.exact);
    if (mixed) {
      // New tile in a previously absent chunk, without preparing another ecology tick.
      const tile: Tile = { x: -25, y: -16, terrain: 'meadow', food: 0.013, moisture: 0.7, vegetation: 0.3, wood: 4, stone: 2 };
      plain.tiles.push({ ...tile }); resident.tiles.push(owner.tile(tile));
      assert.ok(residentFastAccess(resident.tiles)); assert.equal(residentFastAccess(resident.tiles)!.exact, undefined);
      plain.people[0]!.x = resident.people[0]!.x = -18;
      plain.people[1]!.x = resident.people[1]!.x = -23;
    }
    for (let i = 0; i < plain.people.length; i++) {
      const a = plain.people[i]!, b = resident.people[i]!;
      bits(computeLocalPolicyObservation(plain, a, tileLookup(plain.tiles), plain.people),
        computeLocalPolicyObservation(resident, b, tileLookup(resident.tiles), resident.people, residentFastAccess(resident.tiles)));
    }
    const expected = outputs(plain), actual = outputs(resident);
    assert.ok(expected.some(o => o.cooperation?.recipeId), 'local raw inputs actually allow recipe teaching');
    assert.deepEqual(actual, expected);
    for (const w of [plain, resident]) {
      convivir(w); bond(w, w.people[0]!, w.people[1]!, 0.12);
      for (const p of w.people) for (const q of w.people) if (p !== q) p.bonds[q.id] = 0.4;
      conRejilla(w, () => updateCommunities(w, emit(w)));
      // Membership/population mutate during this same tick: no cross-call census.
      w.people.splice(3, 1); w.people[1]!.technology.knownRecipes.push(...w.people[0]!.technology.knownRecipes);
      w.communities.reverse();
    }
    assert.deepEqual(outputs(resident), outputs(plain));
    assert.deepEqual(resident.people, plain.people); assert.deepEqual(resident.communities, plain.communities);
    assert.deepEqual(resident.events, plain.events);
  }
});

test('rejilla and indice-puntos preserve exact radius boundary, negatives and slot order', () => {
  const w = scene();
  w.people[0]!.x = -16; w.people[0]!.y = -16;
  w.people[1]!.x = -9; w.people[1]!.y = -16; // exactly radius 7
  w.people[2]!.x = -9 + 1e-12; w.people[2]!.y = -16;
  const center = w.people[0]!;
  const pred = (p: Person) => p !== center && Math.hypot(p.x - center.x, p.y - center.y) <= 7;
  const check = () => {
    const expected = w.people.filter(pred);
    assert.ok(expected.includes(w.people[1]!)); assert.ok(!expected.includes(w.people[2]!));
    assert.deepEqual(vecinos(w, center, 7, pred), expected);
    assert.equal(primerVecino(w, center, 7, pred), expected[0]);
    // Point indexes certify immutable coordinates. Snapshot again after movement.
    const points = w.people.slice();
    assert.deepEqual(filtrarCerca(points, center, 7, pred), expected);
    assert.equal(primeroCerca(points, center, 7, pred), expected[0]);
    assert.equal(algunoCerca(points, center, 7, pred), expected.length > 0);
  };
  check(); conRejilla(w, () => { check(); w.people[3]!.x = -20; personaMovida(w, w.people[3]!); check(); });
});

test('convivir matches original pair fold bit for bit including radius 2 and saturation', () => {
  const w = scene(), ref = structuredClone(w);
  setParams(ref, parseParams(laws));
  w.people[1]!.x = ref.people[1]!.x = -14; w.people[1]!.y = ref.people[1]!.y = -16;
  for (let i = 0; i < ref.people.length; i++) for (let j = i + 1; j < ref.people.length; j++) {
    const a = ref.people[i]!, b = ref.people[j]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) > 2) continue;
    const gain = 0.01 * (a.sociability + b.sociability) / 2;
    for (const [p, q] of [[a, b], [b, a]]) {
      const old = p!.bonds[q!.id] ?? 0.2;
      if (old < 0.5) p!.bonds[q!.id] = Math.min(0.5, old + gain);
    }
  }
  convivir(w); assert.deepEqual(w.people, ref.people);
});
