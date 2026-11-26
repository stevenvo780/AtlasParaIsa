import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { AnimalMorphology, AnimalSpecies } from '../src/shared/life.js';
import type { CompoundLot } from '../src/shared/chemistry.js';
import { evaluateMaterialProperties } from '../src/shared/chemistry.js';
import { escalon } from '../src/shared/interruptores.js';
import {
  assertWorld, cloneWorld, createWorld, stepWorld, type Person, type World,
} from '../src/world/index.js';
import {
  animalesVivosEnCelda, conRejillaFauna, sinRejillaFaunaParaPruebas, syncFauna, type Animal,
} from '../src/world/animals.js';
import { choose } from '../src/world/decision/personas.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { parseParams } from '../src/world/params.js';
import { conRejilla } from '../src/world/rejilla.js';
import { tileAt } from '../src/world/spatial.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { reservaJ } from '../src/world/materia/cuerpo.js';

after(async () => {
  await closeEcosystemWorkers();
});

const CENTRO = { x: 24, y: 16 };
const morph = (changes: Partial<AnimalMorphology> = {}): AnimalMorphology => ({
  caution: 0.3, size: 0.5, coat: 0.5, defense: 0.3, ...changes,
});

function crearEscena(paramOverrides: Parameters<typeof parseParams>[0] = {}): { world: World; person: Person; baseAnimal: Animal } {
  const world = createWorld(51926, parseParams(paramOverrides));
  world.weather = 'clear';
  world.adaptationEnabled = false;
  world.cooperationEnabled = false;
  world.reproductionEnabled = false;
  world.places = [];
  world.structures = [];
  world.memories = [];
  world.invitations = [];
  world.whispers = undefined;
  const person = world.people[2]!;
  const baseAnimal = structuredClone(world.animals[0]!);
  world.people = [person];
  world.animals = [];
  for (let dy = -7; dy <= 7; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      const tile = tileAt(world, { x: CENTRO.x + dx, y: CENTRO.y + dy })!;
      tile.terrain = 'meadow';
      tile.biome = 'grassland';
      tile.food = 0;
      tile.drinkingWater = 0;
      tile.wood = 0;
      tile.stone = 0;
      tile.fauna = 0;
      tile.species = undefined;
    }
  }
  Object.assign(person, {
    x: CENTRO.x,
    y: CENTRO.y,
    target: { x: CENTRO.x, y: CENTRO.y },
    action: 'explore',
    work: 0,
    decisionAt: 0,
    hunger: 0.7,
    thirst: 0.05,
    fatigue: 0,
    energy: 0.95,
    inventory: 0,
    compounds: undefined,
    huntingPreyId: undefined,
    conflictMemory: undefined,
    materials: { wood: 0, stone: 0 },
    skills: {},
    values: {},
    activity: {},
    command: null,
  });
  return { world, person, baseAnimal };
}

function crearAnimal(
  base: Animal,
  id: string,
  dx: number,
  dy: number,
  overrides: Partial<Animal> = {},
): Animal {
  const x = CENTRO.x + dx;
  const y = CENTRO.y + dy;
  return {
    ...structuredClone(base),
    id,
    species: 'deer' as AnimalSpecies,
    x,
    y,
    target: { x, y },
    health: 1,
    hunger: 0.2,
    energy: 0.8,
    fatigue: 0.1,
    habituation: 0,
    morphology: morph(),
    lastTended: undefined,
    lastHunted: undefined,
    ...overrides,
  };
}

function medirChoose(world: World, person: Person, conRejillaActiva = true): {
  calculosTrabajo: number;
  inspeccionesAnimal: number;
  celdasInspeccionadas: number;
} {
  let calculosTrabajo = 0;
  let inspeccionesAnimal = 0;
  const celdas = new Set<string>();
  const restaurar: Array<() => void> = [];

  for (const animal of world.animals) {
    const genesOrig = animal.genes;
    const healthOrig = animal.health;
    Object.defineProperty(animal, 'genes', {
      configurable: true,
      enumerable: true,
      get() {
        calculosTrabajo++;
        return genesOrig;
      },
      set(v) {
        Object.defineProperty(animal, 'genes', { configurable: true, enumerable: true, writable: true, value: v });
      },
    });
    Object.defineProperty(animal, 'health', {
      configurable: true,
      enumerable: true,
      get() {
        inspeccionesAnimal++;
        celdas.add(`${animal.x},${animal.y}`);
        return healthOrig;
      },
      set(v) {
        Object.defineProperty(animal, 'health', { configurable: true, enumerable: true, writable: true, value: v });
      },
    });
    restaurar.push(() => {
      Object.defineProperty(animal, 'genes', { configurable: true, enumerable: true, writable: true, value: genesOrig });
      Object.defineProperty(animal, 'health', { configurable: true, enumerable: true, writable: true, value: healthOrig });
    });
  }

  try {
    conRejilla(world, () => {
      if (conRejillaActiva) {
        conRejillaFauna(world, () => {
          animalesVivosEnCelda(world, person.x, person.y);
          choose(world, person);
        });
      } else {
        choose(world, person);
      }
    });
  } finally {
    for (const fn of restaurar) fn();
  }

  return { calculosTrabajo, inspeccionesAnimal, celdasInspeccionadas: celdas.size };
}

test('F3 huntForecast: tras hallar primera presa pagable evita huntWorkDuration y termina al no poder entrar herdPlan', t => {
  const { world, person, baseAnimal } = crearEscena({ quimica: { emergente: true } });
  const primera = crearAnimal(baseAnimal, 'animal-cerca-1', 1, 0);
  const lejanas: Animal[] = [];
  for (let dx = 3; dx <= 6; dx++) {
    for (const dy of [-2, -1, 0, 1, 2]) {
      lejanas.push(crearAnimal(baseAnimal, `animal-lejos-${dx}-${dy}`, dx, dy));
    }
  }
  world.animals = [primera, ...lejanas];
  syncFauna(world.tiles, world.animals);

  const medicion = medirChoose(world, person, true);
  t.diagnostic(`1 presa cercana + ${lejanas.length} lejanas (sin d<=2 restantes): calculosTrabajo=${medicion.calculosTrabajo}, celdas=${medicion.celdasInspeccionadas}`);
  assert.equal(person.action, 'hunt');
  assert.deepEqual(person.target, { x: primera.x, y: primera.y });
  assert.equal(person.huntingPreyId, primera.id);
  assert.equal(medicion.calculosTrabajo, 1, 'solo calcula huntWorkDuration una vez para la primera presa pagable');
  assert.equal(medicion.celdasInspeccionadas, 1, 'termina de inmediato al no quedar celdas a distancia <= 2');

  // Aunque haya otra presa a d = 2 (donde aún podría entrar herdPlan), NO calcula huntWorkDuration para ella
  // y termina justo después de revisar d <= 2 sin tocar las 20 celdas lejanas (d >= 3).
  const { world: w2, person: p2, baseAnimal: b2 } = crearEscena({ quimica: { emergente: true } });
  const presa1 = crearAnimal(b2, 'animal-d1', 1, 0);
  const presa2 = crearAnimal(b2, 'animal-d2', 2, 0);
  const extras = lejanas.map(a => ({ ...structuredClone(a) }));
  w2.animals = [presa1, presa2, ...extras];
  syncFauna(w2.tiles, w2.animals);
  const medicion2 = medirChoose(w2, p2, true);
  t.diagnostic(`presa d=1 + presa d=2 + ${extras.length} lejanas: calculosTrabajo=${medicion2.calculosTrabajo}, celdas=${medicion2.celdasInspeccionadas}`);
  assert.equal(p2.action, 'hunt');
  assert.equal(p2.huntingPreyId, presa1.id);
  assert.equal(medicion2.calculosTrabajo, 1, 'no calcula huntWorkDuration para d=2 ni para d>=3 si ya hay plan');
  assert.equal(medicion2.celdasInspeccionadas, 2, 'solo revisa d<=2 y corta antes de d>=3');
});

test('F3 huntForecast: con química y v23.fauna apagada conserva cuidado posterior elegible; con v23.fauna activa lo descarta', t => {
  // 1. Con química y v23.fauna apagada + elegible: presa salvaje en (1,0), animal habituado posterior en (2,0),
  //    y muchas presas lejanas en d >= 3. Conserva el cuidado (forage sobre el habituado) sin recalcular trabajo.
  const { world: wApagada, person: pApagada, baseAnimal: bApagada } = crearEscena({ quimica: { emergente: true } });
  Object.assign(pApagada, { hunger: 0.22, curiosity: 0.05 });
  pApagada.traits = { ...pApagada.traits, industriousness: 0.1 };
  const salvaje = crearAnimal(bApagada, 'animal-salvaje', 1, 0, { species: 'hare', habituation: 0 });
  const habituado = crearAnimal(bApagada, 'animal-habituado', 2, 0, {
    habituation: 0.9,
    morphology: morph({ caution: 0.05 }),
    hunger: 0.2,
    energy: 0.7,
  });
  const lejanas = [3, 4, 5, 6].map(dx => crearAnimal(bApagada, `animal-lejos-${dx}`, dx, 0));
  wApagada.animals = [salvaje, habituado, ...lejanas];
  syncFauna(wApagada.tiles, wApagada.animals);

  const mApagada = medirChoose(wApagada, pApagada, true);
  assert.equal(pApagada.action, 'forage');
  assert.deepEqual(pApagada.target, { x: habituado.x, y: habituado.y });
  assert.equal(pApagada.reason, 'Percibe un animal habituado; recoge alimento y fibra sin matarlo, pagando tiempo y biomasa.');
  assert.equal(pApagada.huntingPreyId, undefined);
  assert.equal(mApagada.calculosTrabajo, 1, 'no calcula huntWorkDuration en d=2 ni en d>=3');
  assert.equal(mApagada.celdasInspeccionadas, 2, 'inspecciona d=1 y d=2, y corta antes de d>=3');

  // 2. Con química y v23.fauna apagada pero NO elegible (hunger <= 0.15 y lleva compounds): descarta cuidado y corta en d=1.
  const { world: wInel, person: pInel, baseAnimal: bInel } = crearEscena({ quimica: { emergente: true } });
  const comp = { C: 0.5, H: 0.3, Ca: 0.2, S: 0, Si: 0, Fe: 0 };
  const lote: CompoundLot = {
    id: 'L-test', formulaId: 'bio:test', composition: comp, mass: 1, phase: 'raw',
    properties: evaluateMaterialProperties(comp, 'raw'),
  };
  pInel.hunger = 0.12;
  pInel.compounds = [lote];
  const sInel = crearAnimal(bInel, 'animal-salvaje', 1, 0, { habituation: 0 });
  const hInel = crearAnimal(bInel, 'animal-habituado', 2, 0, { habituation: 0.9, hunger: 0.2, energy: 0.7 });
  const lInel = [3, 4, 5].map(dx => crearAnimal(bInel, `animal-lejos-${dx}`, dx, 0));
  wInel.animals = [sInel, hInel, ...lInel];
  syncFauna(wInel.tiles, wInel.animals);

  const mInel = medirChoose(wInel, pInel, true);
  assert.notEqual(pInel.action, 'forage');
  assert.equal(mInel.calculosTrabajo, 1);
  assert.equal(mInel.celdasInspeccionadas, 1, 'si no es elegible para cuidado corta en d=1 sin revisar d=2');

  // 3. Con química y v23.fauna activa: aunque el animal en (2,0) sea de manada y habituado, se descarta herdPlan
  //    y huntForecast corta tras la primera presa pagable sin inspeccionar d=2 ni d>=3.
  const wModerna = createWorld(51926, parseParams({ quimica: { emergente: true }, v23: escalon('fauna') }));
  stepWorld(wModerna);
  wModerna.weather = 'clear';
  wModerna.adaptationEnabled = false;
  wModerna.cooperationEnabled = false;
  wModerna.reproductionEnabled = false;
  wModerna.places = [];
  wModerna.structures = [];
  wModerna.memories = [];
  wModerna.invitations = [];
  wModerna.whispers = undefined;
  const pMod = wModerna.people[2]!;
  wModerna.people = [pMod];
  for (let dy = -7; dy <= 7; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      const tile = tileAt(wModerna, { x: CENTRO.x + dx, y: CENTRO.y + dy })!;
      tile.terrain = 'meadow';
      tile.biome = 'grassland';
      tile.food = 0;
      tile.drinkingWater = 0;
      tile.wood = 0;
      tile.stone = 0;
      tile.fauna = 0;
      tile.species = undefined;
    }
  }
  const plantillaAnimal = wModerna.animals[0]!;
  const a1 = crearAnimal(plantillaAnimal, 'animal-mod-1', 1, 0, {
    cuerpo: structuredClone(plantillaAnimal.cuerpo),
    fauna: { ...structuredClone(plantillaAnimal.fauna!), habituacion: 0 },
    habituation: 0,
  });
  const a2 = crearAnimal(plantillaAnimal, 'animal-mod-2', 2, 0, {
    cuerpo: structuredClone(plantillaAnimal.cuerpo),
    fauna: { ...structuredClone(plantillaAnimal.fauna!), habituacion: 0.9 },
    habituation: 0.9,
    hunger: 0.2,
    energy: 0.7,
  });
  const a3 = crearAnimal(plantillaAnimal, 'animal-mod-3', 4, 0, {
    cuerpo: structuredClone(plantillaAnimal.cuerpo),
    fauna: { ...structuredClone(plantillaAnimal.fauna!), habituacion: 0 },
    habituation: 0,
  });
  wModerna.animals = [a1, a2, a3];
  syncFauna(wModerna.tiles, wModerna.animals);
  // Prepara hambre suficiente en scalar + cuerpo vacío de reserva baja/media para que pMod quiera cazar pero pueda pagar.
  Object.assign(pMod, {
    x: CENTRO.x,
    y: CENTRO.y,
    target: { x: CENTRO.x, y: CENTRO.y },
    action: 'explore',
    work: 0,
    decisionAt: 0,
    hunger: 0.7,
    thirst: 0.05,
    fatigue: 0,
    energy: 0.95,
    inventory: 0,
    compounds: undefined,
    huntingPreyId: undefined,
    command: null,
  });
  const cMod = ctxMateriaDe(wModerna);
  assert.ok(pMod.cuerpo && reservaJ(cMod, pMod.cuerpo) > 0);
  const mMod = medirChoose(wModerna, pMod, true);
  assert.equal(pMod.action, 'hunt');
  assert.deepEqual(pMod.target, { x: a1.x, y: a1.y });
  assert.equal(pMod.huntingPreyId, a1.id);
  assert.equal(mMod.calculosTrabajo, 1);
  assert.equal(mMod.celdasInspeccionadas, 1, 'con v23.fauna activa descarta cuidado y corta tras la primera presa');
});

test('F3 huntForecast: conserva empates de distancia, id, slot, trabajo acumulado y posterior habituado con disputa', () => {
  // 1. Empate de distancia en ventana: orden de filas (dy, dx): (0, -1) gana sobre (-1, 0), (1, 0), (0, 1).
  const { world: wEmpate, person: pEmpate, baseAnimal: bEmpate } = crearEscena({ quimica: { emergente: true } });
  const norte = crearAnimal(bEmpate, 'animal-z-norte', 0, -1);
  const oeste = crearAnimal(bEmpate, 'animal-a-oeste', -1, 0);
  const este = crearAnimal(bEmpate, 'animal-b-este', 1, 0);
  const sur = crearAnimal(bEmpate, 'animal-c-sur', 0, 1);
  wEmpate.animals = [sur, este, oeste, norte];
  syncFauna(wEmpate.tiles, wEmpate.animals);

  const mEmpate = medirChoose(wEmpate, pEmpate, true);
  assert.equal(pEmpate.action, 'hunt');
  assert.deepEqual(pEmpate.target, { x: norte.x, y: norte.y });
  assert.equal(pEmpate.huntingPreyId, norte.id);
  assert.equal(mEmpate.calculosTrabajo, 1);

  // 2. Empate de id entre animales en la misma celda: conserva el primero en orden de slot.
  const { world: wSlot, person: pSlot, baseAnimal: bSlot } = crearEscena({ quimica: { emergente: true } });
  const primeroSlot = crearAnimal(bSlot, 'animal-empate', 1, 0, { morphology: morph({ caution: 0.1 }) });
  const segundoSlot = crearAnimal(bSlot, 'animal-empate', 1, 0, { morphology: morph({ caution: 0.9 }) });
  const menorId = crearAnimal(bSlot, 'animal-0-menor', 1, 0);
  wSlot.animals = [primeroSlot, segundoSlot, menorId];
  syncFauna(wSlot.tiles, wSlot.animals);
  choose(wSlot, pSlot);
  assert.equal(pSlot.huntingPreyId, menorId.id);

  wSlot.animals = [primeroSlot, segundoSlot];
  syncFauna(wSlot.tiles, wSlot.animals);
  pSlot.action = 'explore'; pSlot.huntingPreyId = undefined; pSlot.work = 0; pSlot.decisionAt = 0;
  conRejillaFauna(wSlot, () => choose(wSlot, pSlot));
  assert.equal(pSlot.huntingPreyId, primeroSlot.id);

  // 3. Empate / mejora de id de herdPlan en una segunda celda d <= 2 después de hallar huntPlan.
  const { world: wHerd, person: pHerd, baseAnimal: bHerd } = crearEscena({ quimica: { emergente: true } });
  Object.assign(pHerd, { hunger: 0.22, curiosity: 0.05 });
  pHerd.traits = { ...pHerd.traits, industriousness: 0.1 };
  const presa = crearAnimal(bHerd, 'animal-p', 0, -1, { species: 'hare', habituation: 0 });
  const habMayor = crearAnimal(bHerd, 'animal-z-hab', -1, 0, { habituation: 0.9, hunger: 0.2, energy: 0.7 });
  const habMenor = crearAnimal(bHerd, 'animal-a-hab', 0, 2, { habituation: 0.9, hunger: 0.2, energy: 0.7 });
  const lejana = crearAnimal(bHerd, 'animal-lejos', 5, 0);
  wHerd.animals = [presa, habMayor, habMenor, lejana];
  syncFauna(wHerd.tiles, wHerd.animals);
  const mHerd = medirChoose(wHerd, pHerd, true);
  assert.equal(pHerd.action, 'forage');
  assert.deepEqual(pHerd.target, { x: habMenor.x, y: habMenor.y });
  assert.equal(mHerd.calculosTrabajo, 1, 'no calcula huntWorkDuration en celdas posteriores');
  assert.equal(mHerd.celdasInspeccionadas, 3, 'revisa las 3 celdas d<=2 y evita la lejana');

  // 4. Con memoria de disputa (`disputada`): una celda d <= 2 disputada queda detrás de una presa d = 4;
  //    las celdas intermedias d = 5 se saltan sin inspeccionar, y el habituado disputado en d = 1 sigue entrando.
  const { world: wDisp, person: pDisp, baseAnimal: bDisp } = crearEscena({
    quimica: { emergente: true },
    social: { memoriaDisputa: 8, disputaDestino: 0.5 },
  });
  Object.assign(pDisp, { hunger: 0.22, curiosity: 0.05 });
  pDisp.traits = { ...pDisp.traits, industriousness: 0.1 };
  const habDisputado = crearAnimal(bDisp, 'animal-hab-disp', 1, 0, { habituation: 0.9, hunger: 0.2, energy: 0.7 });
  const presaMedia = crearAnimal(bDisp, 'animal-media', 4, 0, { species: 'hare', habituation: 0 });
  const presaIntermedia = crearAnimal(bDisp, 'animal-intermedia', 5, 0, { habituation: 0 });
  const presaFinal = crearAnimal(bDisp, 'animal-final', 6, 0, { habituation: 0 });
  wDisp.animals = [habDisputado, presaMedia, presaIntermedia, presaFinal];
  syncFauna(wDisp.tiles, wDisp.animals);
  pDisp.conflictMemory = { x: habDisputado.x, y: habDisputado.y, tick: wDisp.tick };
  const mDisp = medirChoose(wDisp, pDisp, true);
  assert.equal(pDisp.action, 'forage');
  assert.deepEqual(pDisp.target, { x: habDisputado.x, y: habDisputado.y });
  assert.equal(mDisp.calculosTrabajo, 1, 'solo calcula trabajo para la primera presa pagable en d=4');
  assert.equal(mDisp.celdasInspeccionadas, 2, 'inspecciona d=4 y la d<=2 disputada; salta la intermedia d=5 y la final d=6');

  // 5. Conserva el trabajo acumulado (`person.work`) si continúa cazando la misma presa.
  const { world: wWork, person: pWork, baseAnimal: bWork } = crearEscena({ quimica: { emergente: true } });
  const objetivo = crearAnimal(bWork, 'animal-curso', 1, 0);
  wWork.animals = [objetivo];
  syncFauna(wWork.tiles, wWork.animals);
  pWork.action = 'hunt';
  pWork.target = { x: objetivo.x, y: objetivo.y };
  pWork.huntingPreyId = objetivo.id;
  pWork.work = 9;
  choose(wWork, pWork);
  assert.equal(pWork.action, 'hunt');
  assert.equal(pWork.huntingPreyId, objetivo.id);
  assert.equal(pWork.work, 9);
});

test('F3 huntForecast: primera impagable avanza a la siguiente presa pagable y detiene el trabajo ahí', t => {
  const { world, person, baseAnimal } = crearEscena({ quimica: { emergente: true } });
  // La primera presa (2,0) requiere rodear un muro de agua en 8 pasos BFS; (-3,0) está a 3 pasos BFS.
  for (const [dx, dy] of [[1, 0], [1, 1], [1, -1], [2, 1], [2, -1]] as const) {
    tileAt(world, { x: CENTRO.x + dx, y: CENTRO.y + dy })!.terrain = 'water';
  }
  const impagable = crearAnimal(baseAnimal, 'animal-impagable', 2, 0, {
    genes: { ...baseAnimal.genes, speed: 1 },
    morphology: morph({ caution: 0.95 }),
  });
  const pagable3 = crearAnimal(baseAnimal, 'animal-pagable-3', -3, 0, {
    genes: { ...baseAnimal.genes, speed: 0.1 },
    morphology: morph({ caution: 0.05 }),
  });
  const sobrantes = [-4, -5, -6].map(dx => crearAnimal(baseAnimal, `animal-sobrante-${dx}`, dx, 0));
  world.animals = [impagable, pagable3, ...sobrantes];
  syncFauna(world.tiles, world.animals);

  // Coste de pasos 8 + work(impagable) >= 8*0.0008 + 29*0.0003 = 0.0151;
  // coste de pasos 3 + work(pagable3) = 3*0.0008 + 16*0.0003 = 0.0072.
  person.energy = 0.01;
  const medicion = medirChoose(world, person, true);
  t.diagnostic(`primera impagable (8 pasos) + segunda pagable (3 pasos) + 3 lejanas: calculosTrabajo=${medicion.calculosTrabajo}, celdas=${medicion.celdasInspeccionadas}`);
  assert.equal(person.action, 'hunt');
  assert.deepEqual(person.target, { x: pagable3.x, y: pagable3.y });
  assert.equal(person.huntingPreyId, pagable3.id);
  assert.equal(medicion.calculosTrabajo, 2, 'calcula trabajo en la primera impagable y en la primera pagable, y frena ahi');
  assert.equal(medicion.celdasInspeccionadas, 2);

  // Misma distancia y mismos pasos (3): huntWorkDuration decide que la primera sea impagable y la segunda pagable.
  const { world: wDur, person: pDur, baseAnimal: bDur } = crearEscena({ quimica: { emergente: true } });
  const dura = crearAnimal(bDur, 'animal-dura', 0, -3, {
    genes: { ...bDur.genes, speed: 1 },
    morphology: morph({ caution: 0.95 }),
  });
  const facil = crearAnimal(bDur, 'animal-facil', 0, 3, {
    genes: { ...bDur.genes, speed: 0.1 },
    morphology: morph({ caution: 0.05 }),
  });
  const otras = [4, 5, 6].map(dy => crearAnimal(bDur, `animal-otra-${dy}`, 0, dy));
  wDur.animals = [dura, facil, ...otras];
  syncFauna(wDur.tiles, wDur.animals);
  pDur.energy = 0.01;
  const mDur = medirChoose(wDur, pDur, true);
  assert.equal(pDur.action, 'hunt');
  assert.deepEqual(pDur.target, { x: facil.x, y: facil.y });
  assert.equal(pDur.huntingPreyId, facil.id);
  assert.equal(pDur.decisionAt, wDur.tick + 30);
  assert.equal(pDur.reason, 'Percibe fauna; cazar cuesta trabajo, retira un animal y proporciona alimento limitado.');
  assert.equal(mDur.calculosTrabajo, 2, 'calcula huntWorkDuration para dura (impagable) y facil (pagable), evita 3 posteriores');
  assert.equal(mDur.celdasInspeccionadas, 2);

  // Caso con primera celda habituada (no cazable -> victim = undefined) y segunda salvaje pagable.
  const { world: wHab, person: pHab, baseAnimal: bHab } = crearEscena({ quimica: { emergente: true } });
  const soloHab = crearAnimal(bHab, 'animal-hab-d1', 1, 0, { habituation: 0.9, hunger: 0.8 });
  const salvaje2 = crearAnimal(bHab, 'animal-salv-d3', 3, 0, { habituation: 0 });
  const extra4 = crearAnimal(bHab, 'animal-salv-d4', 4, 0, { habituation: 0 });
  wHab.animals = [soloHab, salvaje2, extra4];
  syncFauna(wHab.tiles, wHab.animals);
  const mHab = medirChoose(wHab, pHab, true);
  assert.equal(pHab.action, 'hunt');
  assert.equal(pHab.huntingPreyId, salvaje2.id);
  assert.equal(mHab.calculosTrabajo, 1, 'no llama huntWorkDuration en celda sin victim');
  assert.equal(mHab.celdasInspeccionadas, 2, 'revisa d=1 y d=3 y evita d=4');
});

test('F3 huntForecast: conserva casos legacy, decisiones sin rejilla y paridad determinista en stepWorld', () => {
  // 1. Legacy (quimica.emergente = false): no toca huntWorkDuration ni herdPlan, corta en primera presa pagable,
  //    y da exactamente el mismo digesto con rejilla que sin rejilla.
  for (const paramsStr of ['', 'quimica.emergente=true']) {
    const a = createWorld(51926, parseParams(paramsStr));
    const b = cloneWorld(a);
    for (let tick = 0; tick < 60; tick++) {
      stepWorld(a);
      sinRejillaFaunaParaPruebas(b, () => stepWorld(b));
    }
    assertWorld(a);
    assert.equal(digestoCanonico(a), digestoCanonico(b), `paridad rejilla/lineal (${paramsStr || 'legacy'})`);
  }

  // 2. Legacy directo con choose(): incluso con un animal habituado cerca, con quimica apagada no genera cuidado y corta en d=1.
  const { world: wLeg, person: pLeg, baseAnimal: bLeg } = crearEscena({ quimica: { emergente: false } });
  const p1 = crearAnimal(bLeg, 'animal-leg-1', 1, 0, { habituation: 0.9, hunger: 0.2, energy: 0.8 });
  const p2 = crearAnimal(bLeg, 'animal-leg-2', 2, 0);
  const p3 = crearAnimal(bLeg, 'animal-leg-3', 4, 0);
  wLeg.animals = [p1, p2, p3];
  syncFauna(wLeg.tiles, wLeg.animals);
  const mLegSinRejilla = medirChoose(wLeg, pLeg, false);
  assert.equal(pLeg.action, 'hunt');
  assert.deepEqual(pLeg.target, { x: p1.x, y: p1.y });
  assert.equal(pLeg.huntingPreyId, undefined);
  assert.equal(mLegSinRejilla.calculosTrabajo, 0, 'en legacy nunca llama huntWorkDuration');
  // Sin rejilla solo evalúa health en la celda d=1 y corta antes de d=2 y d=4.
  assert.equal(mLegSinRejilla.celdasInspeccionadas, 1);
  assert.equal(mLegSinRejilla.inspeccionesAnimal, 1);

  // 3. Con v23.fauna activa en stepWorld corto: determinista entre dos corridas con semilla fija.
  const f1 = createWorld(7, parseParams({ quimica: { emergente: true }, v23: escalon('fauna') }));
  const f2 = cloneWorld(f1);
  for (let tick = 0; tick < 30; tick++) {
    stepWorld(f1);
    stepWorld(f2);
  }
  assertWorld(f1);
  assert.equal(digestoCanonico(f1), digestoCanonico(f2));
});
