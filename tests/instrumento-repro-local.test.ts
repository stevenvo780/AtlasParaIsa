import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { disponibilidadCorporal, reproductiveReadiness } from '../src/world/family.js';
import { demographicTraits } from '../src/world/demography.js';
import { parseParams, paramsOf } from '../src/world/params.js';
import { InstrumentoReproLocal } from '../scripts/lab/instrumentos.js';

/**
 * Instrumento D2 (S2/S3): solo lectura. S2 cuenta evaluaciones de m_L con histograma;
 * S3 anota phi al nacer + foto de fertiles-no-concebidos por ventana. Puertas: digestos
 * identicos con/sin instrumento (ley on y off, 6x1200) y salida determinista.
 */
const PHI = 0.5;
const paramsLey = (extra = '') => parseParams(`poblacion.reproLocal=${PHI}${extra}`);

/** Corre pasos llamando los hooks y cerrando cada dia (como replica.ts). */
function correrConInstrumento(world: World, pasos: number): unknown[] {
  const inst = new InstrumentoReproLocal();
  const dias: unknown[] = [];
  for (let n = 1; n <= pasos; n++) {
    stepWorld(world);
    inst.despuesDelPaso(world);
    if (world.tick % 2400 === 0) dias.push(inst.metricasDia(world));
  }
  return dias;
}

test('Inst S2: un dia acumula evaluaciones con histograma coherente', { timeout: 300000 }, () => {
  const world = createWorld(9201, paramsLey());
  const dias = correrConInstrumento(world, 2400) as { evalM: { n: number; fracGt15: number; hist: number[] }; ventanas: unknown[] }[];
  assert.equal(dias.length, 1);
  const { n, fracGt15, hist } = dias[0]!.evalM;
  assert.equal(dias[0]!.ventanas.length, 20);
  assert.ok(n > 1000, `evaluaciones/dia: ${n}`);
  assert.equal(hist.length, 6);
  assert.equal(hist.reduce((a, b) => a + b, 0), n);
  assert.equal(fracGt15, (hist[2]! + hist[3]! + hist[4]! + hist[5]!) / n);
});

test('Inst S3: phi al nacer y fertiles-no-concebidos por ventana', { timeout: 300000 }, () => {
  const world = createWorld(9202, paramsLey());
  const place = world.places[0]!;
  for (const tile of world.tiles) tile.drinkingWater = 1;
  const cuerpo = paramsOf(world).cuerpo;
  const aptos = world.people.filter(p => p.role === 'neighbor'
    && p.demography.age >= demographicTraits(p.genome, cuerpo).maturityAge
    && p.demography.age < demographicTraits(p.genome, cuerpo).senescenceStart);
  assert.ok(aptos.length >= 4);
  const parejas = [aptos.slice(0, 2), aptos.slice(2, 4)];
  const enPareja = new Set(parejas.flat().map(p => p.id));
  parejas.forEach(([a, b], i) => {
    for (const [persona, dx] of [[a, 0], [b, 1]] as const) {
      persona!.x = place.x + dx; persona!.y = place.y + i * 2;
      persona!.target = { x: persona!.x, y: persona!.y };
      persona!.action = 'rest'; persona!.decisionAt = world.tick + 1000;
      persona!.inventory = 0.14; persona!.thirst = 0; persona!.hunger = 0.2;
      persona!.lastBirth = world.tick - 10000;
    }
    a!.bonds[b!.id] = 0.5; b!.bonds[a!.id] = 0.5;
  });
  for (const person of world.people) {
    if (person.role === 'neighbor' && !enPareja.has(person.id)) { person.inventory = 0; person.thirst = 0; }
  }
  const inst = new InstrumentoReproLocal();
  for (let n = 1; n <= 120; n++) { stepWorld(world); inst.despuesDelPaso(world); }
  const dia = inst.metricasDia(world);
  assert.equal(dia.ventanas.length, 1);
  assert.equal(dia.ventanas[0]!.ventana, 0);
  assert.equal(dia.ventanas[0]!.phiNacimientos.length, 2);
  for (const phi of dia.ventanas[0]!.phiNacimientos) assert.ok(phi === null || (typeof phi === 'number' && phi >= 0));
  const f = dia.ventanas[0]!.fertiles;
  assert.ok(f.n + f.nSinLugar >= 1, 'hay fertiles en riesgo');
  assert.equal(f.n, f.histPhi.reduce((a, b) => a + b, 0) + f.nPhiNull);
  assert.equal(f.mediana === null, f.histPhi.reduce((a, b) => a + b, 0) === 0);
});

test('Inst puerta corporal: con ley off coincide con readiness; con ley on la contiene', { timeout: 300000 }, () => {
  for (const ley of [false, true]) {
    const world = ley ? createWorld(9203, paramsLey()) : createWorld(9203);
    for (let n = 1; n <= 240; n++) {
      stepWorld(world);
      if (n % 60 === 0) {
        for (const person of world.people) {
          const cuerpo = disponibilidadCorporal(world, person);
          const lista = reproductiveReadiness(world, person);
          if (ley) assert.ok(!lista || cuerpo, 'el freno solo restringe');
          else assert.equal(lista, cuerpo);
        }
      }
    }
  }
});

test('Inst digestos identicos con/sin instrumento, ley on y off, 6x1200', { timeout: 600000 }, () => {
  for (const ley of [true, false]) {
    for (const seed of [9201, 9202, 9203, 9204, 9205, 9206]) {
      const con = ley ? createWorld(seed, paramsLey()) : createWorld(seed);
      correrConInstrumento(con, 1200);
      const sin = ley ? createWorld(seed, paramsLey()) : createWorld(seed);
      for (let n = 1; n <= 1200; n++) stepWorld(sin);
      assert.equal(digestoCanonico(con), digestoCanonico(sin), `ley ${ley ? 'on' : 'off'} semilla ${seed}`);
    }
  }
});

test('Inst salida determinista: misma semilla, mismo JSON', { timeout: 300000 }, () => {
  const correr = (): string => {
    const world = createWorld(9204, paramsLey());
    const dias = correrConInstrumento(world, 240);
    return JSON.stringify(dias);
  };
  assert.equal(correr(), correr());
});

test('Inst sobrevive a cloneWorld por paso (rama --gobernador servidor)', { timeout: 300000 }, () => {
  let world = createWorld(9205, paramsLey());
  const inst = new InstrumentoReproLocal();
  for (let n = 1; n <= 240; n++) {
    const draft = cloneWorld(world);
    stepWorld(draft);
    inst.despuesDelPaso(draft);
    world = draft;
  }
  const dia = inst.metricasDia(world);
  assert.equal(dia.ventanas.length, 2);
  assert.ok(dia.evalM.n > 100, `evaluaciones con clones: ${dia.evalM.n}`);
});

test('Inst forma del JSON diario', () => {
  const world = createWorld(9206, paramsLey());
  stepWorld(world);
  const inst = new InstrumentoReproLocal();
  inst.despuesDelPaso(world);
  const dia = JSON.parse(JSON.stringify(inst.metricasDia(world))) as Record<string, unknown>;
  assert.deepEqual(Object.keys(dia).sort(), ['evalM', 'ventanas']);
  assert.deepEqual(Object.keys(dia.evalM as object).sort(), ['fracGt15', 'hist', 'n']);
});
