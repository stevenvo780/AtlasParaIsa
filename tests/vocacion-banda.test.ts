import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { initialDemography } from '../src/world/demography.js';
import { paramsOf, parseParams, setParams, DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES } from '../src/world/params.js';
import { ajustePracticaOficios, ajusteSaturacionLocal, ajusteVocacion, assertWorld, choose, cloneWorld, createWorld,
  explorationTarget, heredarVocacion, OFICIOS_DE_LINAJE, stepWorld, type Person, type World } from '../src/world/index.js';
import { CLAVES_POSTERIORES } from './lib/claves-posteriores.js';

// La definición real del brazo B (l60v3/brazos-l60v3.txt y replica.json) incluye
// social.memoriaDisputa=8 (CONFL encendida); un B sin esa clave mide conflicto legible apagado, no B.
const PARAMS_B = 'persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3,social.memoriaDisputa=8';
const DIGESTOS_5329242: Record<string, string> = {
  'default:7': '973fd1328507694db50329b07275116af8a8b0e907a0608a3c5460d2c652419e',
  'default:42': 'e7e0e8562d05d31931bd60679df60a07c873c33d9487979ebf01d8ad09dd455e',
  'default:51926': '690f0dd8bf9d680a102c01c17b91481c840dc139ff17bdc1989930b5f2b9f58d',
  'B:7': 'd02e684d13ab9b3bc5899cb4881473eb6b384c088747eb43c07f07c0997149f8',
  'B:42': 'a2323eeb23a66d4638694199865cfed9518589c122b014e0ed01ecfb7b764729',
  'B:51926': 'ec5c11f3d15b20c8bbde727f9f7c1102b876159a64d43c7bfcbdad1ad23f92f1',
};

function digestoFisico(world: World): string {
  const vigentes = paramsOf(world), formaVieja = structuredClone(vigentes) as unknown as Record<string, Record<string, unknown>>;
  for (const clave of Object.keys(CLAVES_POSTERIORES)) {
    const [section, leaf] = clave.split('.') as [string, string];
    delete formaVieja[section]![leaf];
  }
  setParams(world, formaVieja as unknown as typeof vigentes);
  try { return digestoCanonico(world); } finally { setParams(world, vigentes); }
}

test('Paso 0: defaults reproducen el digesto físico de 5329242 en tres semillas y dos juegos de params', { timeout: 600_000 }, t => {
  for (const [label, overrides] of [['default', undefined], ['B', PARAMS_B]] as const) for (const seed of [7, 42, 51926]) {
    const store = new Store(':memory:'), world = createWorld(seed, parseParams(overrides, HISTORICAL_PARAMS));
    try {
      store.save(world); for (let tick = 0; tick < 2400; tick++) stepWorld(world);
      const physical = digestoFisico(world);
      t.diagnostic(`${label} seed ${seed}: ${physical}`);
      assert.equal(physical, DIGESTOS_5329242[`${label}:${seed}`]);
      assert.notEqual(digestoCanonico(world), physical, 'la forma completa declara las cinco claves nuevas');
    } finally { store.close(); }
  }
});

function mundoParaNacimiento(seed: number, epsilon: number, inverso = false): World {
  const world = createWorld(seed, parseParams(`conducta.vocacion=${epsilon}`));
  world.tick = 599; world.communities = [];
  const [a, b] = world.people.filter(person => person.role === 'neighbor').slice(0, 2) as [Person, Person];
  for (const person of world.people) {
    person.communityId = null; person.bonds = {}; person.action = 'rest'; person.decisionAt = 999;
    person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9; person.inventory = 0;
    person.demography = initialDemography(world.tick - person.bornAt); person.target = { x: person.x, y: person.y };
  }
  for (const [index, person] of [a, b].entries()) {
    person.x = 17; person.y = 13; person.target = { x: 17, y: 13 }; person.inventory = 0.2;
    person.communityId = `vocacion-test-${index}`;
    world.communities.push({ id: person.communityId, name: person.communityId, x: 17, y: 13, color: '#aabbcc',
      members: [person.id], culture: { ...person.culture }, formedAt: 0, cooperation: 0, disputes: 0 });
  }
  a.bonds[b.id] = b.bonds[a.id] = 0.7;
  if (inverso) world.people.reverse();
  return world;
}

test('defaults, rangos y fundadores mantienen apagadas las cuatro leyes', () => {
  for (const params of [DEFAULT_PARAMS, HISTORICAL_PARAMS]) {
    assert.equal(params.conducta.vocacion, 0); assert.equal(params.conducta.practicaOficios, 0);
    assert.equal(params.conducta.saturacionLocal, 0); assert.equal(params.social.banda, 0); assert.equal(params.social.bandaMax, 6);
  }
  assert.deepEqual(PARAM_RANGES['conducta.vocacion'], [0, 0.3]);
  assert.deepEqual(PARAM_RANGES['conducta.practicaOficios'], [0, 4]);
  assert.deepEqual(PARAM_RANGES['conducta.saturacionLocal'], [0, 1]);
  assert.deepEqual(PARAM_RANGES['social.banda'], [0, 4]); assert.deepEqual(PARAM_RANGES['social.bandaMax'], [1, 64]);
  assert.throws(() => parseParams('conducta.vocacion=0.31'), /rango/i);
  assert.throws(() => parseParams('social.bandaMax=2.5'), /entero/i);
  const world = createWorld(42, parseParams('conducta.vocacion=0.1'));
  assert.ok(world.people.every(person => person.vocacion === undefined), 'los fundadores no nacen con el campo');
});

test('la vocación heredada es determinista, centrada, acotada e independiente del orden de personas', () => {
  const zero = mundoParaNacimiento(51926, 0); stepWorld(zero);
  assert.equal(zero.people.at(-1)!.vocacion, undefined, 'epsilon=0 no deja ni la copia del progenitor');

  const a = mundoParaNacimiento(51926, 0.1), b = mundoParaNacimiento(51926, 0.1), reversed = mundoParaNacimiento(51926, 0.1, true);
  stepWorld(a); stepWorld(b); stepWorld(reversed);
  const va = a.people.find(person => person.id === 'descendant-1')!.vocacion!;
  const vb = b.people.find(person => person.id === 'descendant-1')!.vocacion!;
  const vr = reversed.people.find(person => person.id === 'descendant-1')!.vocacion!;
  assert.deepEqual(va, vb); assert.deepEqual(va, vr);
  assert.deepEqual(Object.keys(va), OFICIOS_DE_LINAJE);
  assert.ok(Math.abs(Object.values(va).reduce((sum, value) => sum + value, 0)) < 1e-14);
  assert.ok(Object.values(va).every(value => value >= -0.3 && value <= 0.3));
  assert.notDeepEqual(heredarVocacion(51926, 'descendant-1', {}, 0.1), heredarVocacion(51926, 'descendant-2', {}, 0.1),
    'hermanos con identidades distintas reciben errores distintos');
});

test('assertWorld valida vocación y Store la conserva sin migración especial', () => {
  const world = createWorld(7), person = world.people[2]!;
  person.vocacion = heredarVocacion(world.seed, 'validacion', person, 0.3);
  assertWorld(world);
  const store = new Store(':memory:');
  try { store.save(world); assert.deepEqual(store.load()!.world.people[2]!.vocacion, person.vocacion); } finally { store.close(); }
  for (const corrupt of [
    { ...person.vocacion, research: 0.3000001 },
    Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`oficio-${i}`, 0])),
    { ...person.vocacion, research: Number.NaN },
  ]) {
    const bad = cloneWorld(world); bad.people[2]!.vocacion = corrupt;
    assert.throws(() => assertWorld(bad), /inválido/i);
  }
});

test('VOC, PO1 y SL1 mueven sólo oficios y en la dirección preregistrada', () => {
  const skills = Object.fromEntries(OFICIOS_DE_LINAJE.map(oficio => [oficio, oficio === 'research' ? 1 : 0]));
  assert.ok(ajustePracticaOficios(skills, 'research', 1) > 0);
  assert.ok(ajustePracticaOficios(skills, 'gather', 1) < 0);
  assert.equal(ajustePracticaOficios(skills, 'explore', 1), 0);
  assert.equal(ajusteVocacion({ vocacion: { research: 0.1, gather: -0.1 } }, 'research', 0.1), 0.1);
  assert.equal(ajusteVocacion({ vocacion: { research: 0.1 } }, 'explore', 0.1), 0);
  const vecinos = [{ action: 'research' }, { action: 'research' }, { action: 'gather' }] as Pick<Person, 'action'>[];
  assert.ok(ajusteSaturacionLocal('research', vecinos, 0.3) < ajusteSaturacionLocal('gather', vecinos, 0.3));
  assert.equal(ajusteSaturacionLocal('research', vecinos.slice(0, 1), 0.3), 0);
  assert.equal(ajusteSaturacionLocal('explore', vecinos, 0.3), 0);
});

test('B1 converge el destino hacia compañeros exploradores y no depende del orden', () => {
  const base = createWorld(42), actor = base.people[2]!, c1 = base.people[3]!, c2 = base.people[4]!;
  base.people = [actor, c1, c2]; base.cooperationEnabled = false;
  for (const person of base.people) {
    person.role = 'neighbor'; person.action = 'explore'; person.x = actor.x; person.y = actor.y;
    person.target = { x: actor.x, y: actor.y }; person.bonds = {}; person.hunger = person.thirst = person.fatigue = 0.1;
  }
  actor.heading = Math.PI / 2; c1.heading = c2.heading = 0;
  const tiles = base.tiles.filter(tile => tile.terrain !== 'water' && Math.hypot(tile.x - actor.x, tile.y - actor.y) <= 7);
  actor.visited = tiles.map(tile => `${tile.x},${tile.y}`); for (const tile of tiles) tile.traffic = 0;
  setParams(base, parseParams('social.banda=0,social.bandaMax=2'));
  const hoy = explorationTarget(base, actor, tiles);
  const con = cloneWorld(base); setParams(con, parseParams('social.banda=1,social.bandaMax=6'));
  const alineado = explorationTarget(con, con.people[0]!, tiles);
  assert.ok(alineado.x - actor.x > hoy.x - actor.x, `el rumbo no se acercó al este: hoy ${JSON.stringify(hoy)}, B1 ${JSON.stringify(alineado)}`);
  const inverso = cloneWorld(con); inverso.people.reverse();
  assert.deepEqual(explorationTarget(inverso, inverso.people.find(person => person.id === actor.id)!, tiles), alineado);
});

function mundoParaSaturacion(): { world: World; x: Person } {
  const world = createWorld(42, parseParams('conducta.saturacionLocal=0.6'));
  world.cooperationEnabled = false;
  const [x, w1, w2] = world.people.filter(person => person.role === 'neighbor').slice(0, 3) as [Person, Person, Person];
  for (const person of [x, w1, w2]) {
    person.x = 20; person.y = 20; person.target = { x: 20, y: 20 }; person.bonds = {};
    person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9;
    person.decisionAt = 0; person.materials.wood = 0; person.materials.stone = 0;
  }
  x.traits.industriousness = 1; x.curiosity = 0;
  w1.action = 'explore'; w2.action = 'explore';
  world.tiles.find(tile => tile.x === x.x && tile.y === x.y)!.wood = 8;
  return { world, x };
}

test('SL1 lee la instantánea de comienzo de fase, no world.people en vivo (verificador 2026-09-23)', () => {
  // Reproduce el defecto encontrado: `choose()` de un vecino procesado antes en el mismo tick no
  // debe cambiar el recuento de saturación de quien decide después. Con los defaults del preregistro
  // (industriousness=1, curiosity=0, una tesela con madera cerca) `x` prefiere 'gather' cuando nadie
  // más lo hace.
  const { world, x } = mundoParaSaturacion();
  choose(world, x);
  const primero = x.action;
  assert.equal(primero, 'gather', 'sin saturación, x elige recolectar (fija el resto del experimento)');
  // Un vecino "procesado antes en este mismo tick" ya habría escrito su nueva acción en el objeto
  // vivo de `world.people` (index.ts:931). Simulamos justo eso mutando la acción en vivo, SIN pasar
  // por su propio `choose()`, y repetimos la decisión de x dentro del mismo tick (mismo `world.tick`,
  // así que la instantánea ya capturada se reutiliza si la ley es correcta).
  const [, w1, w2] = world.people.filter(person => person.role === 'neighbor').slice(0, 3) as [Person, Person, Person];
  w1.action = 'gather'; w2.action = 'gather';
  x.decisionAt = 0;
  choose(world, x);
  assert.equal(x.action, primero, 'la decisión de x no cambia aunque un vecino mute su acción en vivo dentro del mismo tick');
});

test('SL1 sólo cuenta vecinos mortales (role === neighbor): S e I nunca son compañeros de saturación', () => {
  const build = (companionRole: 'S/I' | 'neighbor') => {
    const world = createWorld(42, parseParams('conducta.saturacionLocal=0.6'));
    world.cooperationEnabled = false;
    const s = world.people.find(person => person.role === 'S')!, i = world.people.find(person => person.role === 'I')!;
    const [x, w1, w2] = world.people.filter(person => person.role === 'neighbor').slice(0, 3) as [Person, Person, Person];
    const companions = companionRole === 'S/I' ? [s, i] : [w1, w2];
    for (const person of [x, ...companions]) {
      person.x = 20; person.y = 20; person.target = { x: 20, y: 20 }; person.bonds = {};
      person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9;
      person.decisionAt = 0; person.materials.wood = 0; person.materials.stone = 0; person.action = 'gather';
    }
    x.traits.industriousness = 1; x.curiosity = 0;
    world.tiles.find(tile => tile.x === x.x && tile.y === x.y)!.wood = 8;
    return { world, x };
  };
  const conSyI = build('S/I'); choose(conSyI.world, conSyI.x);
  assert.equal(conSyI.x.action, 'gather', 'con S e I ejerciendo el mismo oficio, no cuentan como saturación');
  const conVecinos = build('neighbor'); choose(conVecinos.world, conVecinos.x);
  assert.notEqual(conVecinos.x.action, 'gather', 'con dos vecinos mortales ejerciendo el mismo oficio, la saturación sí actúa');
});

test('con banda=0, cambiar bandaMax no mueve el mundo', () => {
  const a = createWorld(7, parseParams('social.banda=0,social.bandaMax=6'));
  const b = createWorld(7, parseParams('social.banda=0,social.bandaMax=17'));
  for (let i = 0; i < 180; i++) { stepWorld(a); stepWorld(b); }
  const pa = paramsOf(a), pb = paramsOf(b);
  setParams(b, { ...pb, social: { ...pb.social, bandaMax: pa.social.bandaMax } });
  assert.deepEqual(b, a, 'bandaMax sólo cambia la forma de params cuando el peso maestro vale cero');
});
