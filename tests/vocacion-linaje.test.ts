import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { initialDemography } from '../src/world/demography.js';
import { digestoSin } from '../scripts/lab/rendimiento.js';
import { diversidadPerfilesJS, InstrumentosConducta } from '../scripts/lab/instrumentos.js';
import { assertWorld, cloneWorld, createWorld, heredarVocacion, OFICIOS_DE_LINAJE, stepWorld, type Person, type World } from '../src/world/index.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, paramsOf, parseParams, setParams } from '../src/world/params.js';

// Claves posteriores a 2ee2658 en la rama de la campaña (H-A y H-B); todas a su valor inactivo.
const CLAVES = ['conducta.vocacion', 'conducta.vocacionTope', 'social.hogarTrabajo'] as const;
// Medidos con `git archive 2ee2658` en /tmp, Store SQLite guardado antes del primer paso y
// con la cadencia de DEFAULT_PARAMS (1 tick); `digestoCanonico` tras exactamente 1200 pasos.
const REFERENCIAS = {
  42: 'f856a6a9802be00ccd914d7ade2a9f7e1c40e56c88299cb532fa67b5df28875c',
  2001: '95f1b28351f2984046210c83dc0bb477ce70c4b9e5dd12d1c9198d1e5a6dc9c9',
} as const;

test('H-A apagada conserva el mundo de reglas 11 tras 1200 pasos', { timeout: 600_000 }, t => {
  assert.equal(DEFAULT_PARAMS.conducta.vocacion, 0);
  assert.equal(HISTORICAL_PARAMS.conducta.vocacion, 0);
  assert.equal(DEFAULT_PARAMS.conducta.vocacionTope, 0.9);
  assert.equal(HISTORICAL_PARAMS.conducta.vocacionTope, 0.9);
  assert.deepEqual(PARAM_RANGES['conducta.vocacion'], [0, 1]);
  assert.deepEqual(PARAM_RANGES['conducta.vocacionTope'], [0, 2]);
  for (const seed of [42, 2001] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'c8-voc-identidad-'));
    const store = new Store(join(dir, 'world.sqlite'));
    try {
      const world = createWorld(seed); store.save(world);
      for (let paso = 0; paso < 1200; paso++) {
        stepWorld(world);
        if (world.tick % paramsOf(world).persistencia.cadaTicks === 0) store.save(world);
      }
      assert.equal(digestoSin(world, CLAVES), REFERENCIAS[seed]);
      assert.ok(world.people.every(person => person.vocacion === undefined));
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

function mundoParaNacimiento(invertido = false): World {
  const world = createWorld(51926, parseParams('conducta.vocacion=0.4,conducta.vocacionTope=0.9'));
  world.tick = 599; world.communities = [];
  const [a, b] = world.people.filter(person => person.role === 'neighbor').slice(0, 2) as [Person, Person];
  for (const person of world.people) {
    person.communityId = null; person.bonds = {}; person.action = 'rest'; person.decisionAt = 999;
    person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9; person.inventory = 0;
    person.demography = initialDemography(world.tick - person.bornAt); person.target = { x: person.x, y: person.y };
  }
  for (const [n, person] of [a, b].entries()) {
    person.x = person.y = 13; person.target = { x: 13, y: 13 }; person.inventory = 0.2;
    person.communityId = `vocacion-test-${n}`;
    world.communities.push({ id: person.communityId, name: person.communityId, x: 13, y: 13, color: '#aabbcc',
      members: [person.id], culture: { ...person.culture }, formedAt: 0, cooperation: 0, disputes: 0 });
  }
  a.bonds[b.id] = b.bonds[a.id] = 0.7;
  a.vocacion = Object.fromEntries(OFICIOS_DE_LINAJE.map(oficio => [oficio, oficio === 'gather' ? 0.8 : -0.8 / 9]));
  b.vocacion = Object.fromEntries(OFICIOS_DE_LINAJE.map(oficio => [oficio, oficio === 'research' ? 0.8 : -0.8 / 9]));
  // Cambia el recorrido de las demás personas sin cambiar cuál de los dos padres es `a`.
  if (invertido) world.people.splice(4, world.people.length - 4, ...world.people.slice(4).reverse());
  return world;
}

test('herencia local centrada, acotada, uniparental y estable ante otro orden de personas', () => {
  const mundo = mundoParaNacimiento(), inverso = mundoParaNacimiento(true);
  assert.ok(mundo.people.filter(p => p.role === 'neighbor' && !['neighbor-1', 'neighbor-2'].includes(p.id)).every(p => p.vocacion === undefined));
  assert.equal(mundo.people.find(p => p.role === 'S')!.vocacion, undefined);
  assert.equal(mundo.people.find(p => p.role === 'I')!.vocacion, undefined);
  stepWorld(mundo); stepWorld(inverso);
  const cria = mundo.people.find(p => p.id === 'descendant-1');
  const criaInversa = inverso.people.find(p => p.id === 'descendant-1');
  assert.ok(cria && criaInversa, 'la pareja de control tuvo una cría');
  assert.deepEqual(cria.vocacion, criaInversa.vocacion);
  const progenitorA = mundo.people.find(p => p.id === cria.genome.parents[0])!;
  assert.deepEqual(cria.vocacion, heredarVocacion(mundo.seed, cria.id, progenitorA, 0.4, 0.9));
  assert.deepEqual(Object.keys(cria.vocacion!), OFICIOS_DE_LINAJE);
  assert.ok(Math.abs(Object.values(cria.vocacion!).reduce((suma, valor) => suma + valor, 0)) < 1e-12);
  assert.ok(Object.values(cria.vocacion!).every(valor => valor >= -0.9 && valor <= 0.9));
  assert.notDeepEqual(heredarVocacion(42, 'uno', {}, 1, 0.9), heredarVocacion(42, 'dos', {}, 1, 0.9));
  assert.deepEqual(heredarVocacion(42, 'uno', {}, 1, 0), Object.fromEntries(OFICIOS_DE_LINAJE.map(oficio => [oficio, 0])));
});

test('vocación sólo favorece oficios en contexto listo', () => {
  let eleccionesSin = 0, eleccionesCon = 0, cambios = 0;
  for (const seed of [7, 42, 2001, 51926]) {
    const base = createWorld(seed), con = cloneWorld(base);
    setParams(con, parseParams('conducta.vocacion=1,conducta.vocacionTope=2'));
    const actor = base.people[2]!, actorCon = con.people[2]!;
    for (const world of [base, con]) {
      world.reproductionEnabled = false;
      for (const p of world.people) p.decisionAt = p.id === actor.id ? 0 : 999;
    }
    for (const p of [actor, actorCon]) { p.hunger = p.thirst = p.fatigue = 0.1; p.energy = 0.9; }
    actorCon.vocacion = Object.fromEntries(OFICIOS_DE_LINAJE.map(oficio => [oficio, oficio === 'gather' ? 2 : -2 / 9]));
    stepWorld(base); stepWorld(con);
    if (actor.action === 'gather') eleccionesSin++;
    if (actorCon.action === 'gather') eleccionesCon++;
    if (actor.action !== actorCon.action) cambios++;
  }
  assert.ok(eleccionesCon > eleccionesSin && cambios > 0, `gather: con ${eleccionesCon}, sin ${eleccionesSin}`);
  for (const necesidad of ['hunger', 'thirst', 'fatigue'] as const) {
    const base = createWorld(42), con = cloneWorld(base);
    setParams(con, parseParams('conducta.vocacion=1,conducta.vocacionTope=2'));
    const a = base.people[2]!, b = con.people[2]!;
    for (const world of [base, con]) { world.reproductionEnabled = false; for (const p of world.people) p.decisionAt = p.id === a.id ? 0 : 999; }
    for (const p of [a, b]) { p.hunger = p.thirst = p.fatigue = 0.1; p[necesidad] = 0.85; p.energy = 0.9; }
    b.vocacion = Object.fromEntries(OFICIOS_DE_LINAJE.map(oficio => [oficio, oficio === 'gather' ? 2 : -2 / 9]));
    stepWorld(base); stepWorld(con);
    assert.equal(b.action, a.action, `fuera de ready (${necesidad})`);
    assert.equal(b.action, { hunger: 'eat', thirst: 'drink', fatigue: 'rest' }[necesidad], `la necesidad ${necesidad} conserva su acto corporal`);
  }
});

test('instantánea con vocación fuera del tope se rechaza; sin campo carga', () => {
  const world = createWorld(7, parseParams('conducta.vocacion=0.5,conducta.vocacionTope=0.9'));
  const store = new Store(':memory:');
  try {
    store.save(world);
    assert.ok(store.load()!.world.people.every(person => person.vocacion === undefined));
    world.people[2]!.vocacion = { gather: 0.91 };
    assert.throws(() => assertWorld(world), /inválido/i);
    world.people[2]!.vocacion = { gather: 0.9 };
    assertWorld(world);
    store.save(world);
    assert.deepEqual(store.load()!.world.people[2]!.vocacion, { gather: 0.9 });
  } finally { store.close(); }
});

test('instrumentos H-A son métricas de sólo lectura y nulas sin portadores', () => {
  const sinLey = createWorld(42), apagada = createWorld(42, parseParams('conducta.vocacion=0,conducta.vocacionTope=0.9'));
  const observadorSinLey = new InstrumentosConducta(sinLey), observadorApagada = new InstrumentosConducta(apagada);
  for (let i = 0; i < 120; i++) {
    observadorSinLey.antesDelPaso(sinLey); stepWorld(sinLey); observadorSinLey.despuesDelPaso(sinLey);
    observadorApagada.antesDelPaso(apagada); stepWorld(apagada); observadorApagada.despuesDelPaso(apagada);
  }
  assert.deepEqual(observadorSinLey.metricasDia(sinLey), observadorApagada.metricasDia(apagada), 'las demás series tampoco cambian con ε=0');
  for (const epsilon of [0, 0.5]) {
    const world = createWorld(42, parseParams(`conducta.vocacion=${epsilon},conducta.vocacionTope=0.9`));
    const inst = new InstrumentosConducta(world);
    for (let i = 0; i < 600; i++) { inst.antesDelPaso(world); stepWorld(world); inst.despuesDelPaso(world); }
    const antes = JSON.stringify(world), m = inst.metricasDia(world);
    assert.equal(JSON.stringify(world), antes);
    for (const clave of ['vocacionVarianza', 'vocacionEntropiaArgmax', 'vocacionCoincidencia'] as const)
      assert.ok(m[clave] === null || Number.isFinite(m[clave]) && m[clave]! >= 0, clave);
    for (const clave of ['vocacionEntropiaArgmax', 'vocacionCoincidencia'] as const)
      assert.ok(m[clave] === null || m[clave]! <= 1, clave);
    if (epsilon === 0) {
      assert.equal(m.vocacionVarianza, null); assert.equal(m.vocacionEntropiaArgmax, null); assert.equal(m.vocacionCoincidencia, null);
    }
    for (const clave of ['diversidadConductaVentanaGen1', 'approachHogar', 'maderaMediaAdultos', 'piedraMediaAdultos'] as const)
      assert.ok(m[clave] === null || Number.isFinite(m[clave]), clave);
    assert.ok(Number.isSafeInteger(m.muertesMenores8Dias) && m.muertesMenores8Dias >= 0);
  }
});

test('la réplica corta escribe los ocho instrumentos H-A con dominios válidos', { timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'c8-voc-replica-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', '--seed', '42', '--dias', '1',
      '--params', 'persistencia.cadaTicks=300,conducta.vocacion=0.8,conducta.vocacionTope=0.9', '--salida', dir], { encoding: 'utf8', timeout: 600_000 });
    assert.equal(result.status, 0, result.stderr);
    const dia = JSON.parse(readFileSync(join(dir, 'dia-001.json'), 'utf8')) as Record<string, unknown>;
    for (const clave of ['vocacionVarianza', 'vocacionEntropiaArgmax', 'vocacionCoincidencia', 'diversidadConductaVentanaGen1',
      'approachHogar', 'maderaMediaAdultos', 'piedraMediaAdultos'] as const) {
      const valor = dia[clave];
      assert.ok(valor === null || typeof valor === 'number' && Number.isFinite(valor) && valor >= 0, clave);
    }
    for (const clave of ['vocacionEntropiaArgmax', 'vocacionCoincidencia', 'diversidadConductaVentanaGen1', 'approachHogar'] as const)
      assert.ok(dia[clave] === null || (dia[clave] as number) <= 1, clave);
    assert.ok(Number.isSafeInteger(dia.muertesMenores8Dias) && (dia.muertesMenores8Dias as number) >= 0);
    const cambios = dia.cambiosHogar as { adopta: number; pierde: number };
    assert.ok(Number.isSafeInteger(cambios.adopta) && cambios.adopta >= 0);
    assert.ok(Number.isSafeInteger(cambios.pierde) && cambios.pierde >= 0);
    assert.ok(dia.diversidadPerfilesJS === null || typeof dia.diversidadPerfilesJS === 'number'
      && dia.diversidadPerfilesJS >= 0 && dia.diversidadPerfilesJS <= 1);
    assert.ok(Number.isSafeInteger(dia.linajesVivos) && (dia.linajesVivos as number) >= 0
      && (dia.linajesVivos as number) <= (dia.vecinosMortales as number));
    assert.ok(dia.linajesHerfindahl === null || typeof dia.linajesHerfindahl === 'number'
      && dia.linajesHerfindahl >= 0 && dia.linajesHerfindahl <= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('JS usa proporciones activas y la raíz de la divergencia en base 2', () => {
  assert.equal(diversidadPerfilesJS([{ rest: 100, explore: 1, gather: 1 }, { explore: 10, gather: 10 }]), 0);
  assert.equal(diversidadPerfilesJS([{ rest: 4 }, { explore: 1 }]), null);
  assert.equal(diversidadPerfilesJS([{ explore: 1 }, { gather: 1 }]), 1);
  const distancia = diversidadPerfilesJS([{ explore: 3, gather: 1 }, { explore: 1, gather: 3 }]);
  assert.ok(distancia !== null && distancia > 0 && distancia < 1);
});

test('un solo linaje da Herfindahl 1; cambiosHogar cuenta adopción, traslado y pérdida', () => {
  const world = createWorld(42);
  const fundador = world.people.find(person => person.role === 'neighbor')!;
  world.people = world.people.filter(person => person.role !== 'neighbor' || person.id === fundador.id);
  const inst = new InstrumentosConducta(world);
  inst.antesDelPaso(world); inst.despuesDelPaso(world);
  assert.equal(inst.metricasDia(world).linajesHerfindahl, 1);
  fundador.home = { x: 10, y: 20, quality: 0.8, observedAt: world.tick };
  inst.antesDelPaso(world); inst.despuesDelPaso(world);
  fundador.home.x = 11;
  inst.antesDelPaso(world); inst.despuesDelPaso(world);
  delete fundador.home;
  inst.antesDelPaso(world); inst.despuesDelPaso(world);
  assert.deepEqual(inst.metricasDia(world).cambiosHogar, { adopta: 2, pierde: 1 });
});

test('el linaje de una cría sigue al primer progenitor de genome.parents', () => {
  const world = createWorld(42);
  const [a, b] = world.people.filter(person => person.role === 'neighbor') as [Person, Person];
  world.people = world.people.filter(person => person.role !== 'neighbor' || person === a || person === b);
  const inst = new InstrumentosConducta(world);
  const cria = structuredClone(a);
  cria.id = 'descendant-prueba';
  cria.genome.parents = [a.id, b.id];
  cria.genome.generation = 1;
  cria.bornAt = world.tick;
  delete cria.home;
  world.people.push(cria);
  inst.antesDelPaso(world); inst.despuesDelPaso(world);
  const medidas = inst.metricasDia(world);
  assert.equal(medidas.linajesVivos, 2);
  assert.ok(Math.abs(medidas.linajesHerfindahl! - 5 / 9) < 1e-12);
});
