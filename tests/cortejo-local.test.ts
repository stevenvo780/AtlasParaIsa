import test from 'node:test';
import assert from 'node:assert/strict';
import { digestosControl, LEYES_CANDIDATAS } from '../scripts/lab/rendimiento.js';
import { assertWorld, createWorld, stepWorld, type Person, type Sighting, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { demographicTraits } from '../src/world/demography.js';
import { tileAt } from '../src/world/spatial.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, paramsOf, parseParams } from '../src/world/params.js';
import { CLAVES_POSTERIORES, recargar } from './lib/claves-posteriores.js';

/**
 * Cortejo y reencuentro locales, `poblacion.cortejoLocal` (constitución III: leyes locales de cuerpo, necesidad,
 * material y memoria). Sin la ley, el cortejo de reglas 10 y el reencuentro H2 eligen al vinculado más cercano hasta
 * `radioCortejo` (128) y van a su posición ACTUAL aunque esté fuera de la vista (RADIUS = 7), y descartan a los
 * muertos leyendo el mundo. Con la ley cada cual recuerda dónde vio por última vez a cada vinculado mutuo y va a ese
 * lugar; si lo tiene a la vista sin encontrarlo allí, deja de buscarlo hasta volver a verlo.
 */

const B = `${LEYES_CANDIDATAS},social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3,social.memoriaDisputa=8`;
const BRAZOS: Record<string, string> = { 'reglas 10': LEYES_CANDIDATAS, 'brazo B': B, 'brazo B + H2': `${B},social.reencuentro=1` };

/** `digestoCanonico` a 2400 pasos de `digestosControl` medido en el árbol anterior a esta ley (ace0bb1, exportado con
 * `git archive`), con la forma de params de ese árbol: aquí se quita sólo `poblacion.cortejoLocal`. El brazo B es el
 * de la ronda 5 del laboratorio (reglas 10 + conflicto legible); con H2 pasa además por el reencuentro. */
const BASE: Record<number, Record<string, string>> = {
  13: { 'reglas 10': '0f469de2b6508ef309c5608f97dac350b364d4cffe578c48a1ae604032ec18a7',
    'brazo B': '5ce18bac2d8e01233c7edd5154c641fc190b1d15b5bba09f9a9473dce36614ad',
    'brazo B + H2': '1ddb389cdbb4adb60ab5ad9b3cad49da930ff83d855806b3cf3f3ac1239addc2' },
  1054: { 'reglas 10': 'a9eda077bde7db931b830d2b55fc00ba0ee92233c3aec6327d595c7375d37e74',
    'brazo B': 'c0ebe2c3089473a933a2fd1d16ea6ff67de83f1bd1cb43ff0fd9d2369bbea4e6',
    'brazo B + H2': '2c7caf1586937d8aa3c47ba8bd1cbdb1a6e9f7e6277f0f292844f095895b5958' },
};

test('(i) con poblacion.cortejoLocal=false el mundo es bit a bit el de antes, con reglas 10 y el brazo B', { timeout: 1_800_000 }, () => {
  assert.equal(DEFAULT_PARAMS.poblacion.cortejoLocal, false);
  assert.equal(HISTORICAL_PARAMS.poblacion.cortejoLocal, false);
  assert.ok(CLAVES_POSTERIORES.includes('poblacion.cortejoLocal'));
  for (const seed of [13, 1054]) for (const [brazo, params] of Object.entries(BRAZOS)) {
    const digesto = digestosControl(seed, params, [2400], ['poblacion.cortejoLocal'])['2400'];
    assert.equal(digesto, BASE[seed]![brazo], `${brazo}, semilla ${seed}`);
  }
  // El control tiene dientes: con la ley la semilla 13 toma otro camino (sin contar la clave en el hash).
  const conLey = digestosControl(13, `${LEYES_CANDIDATAS},poblacion.cortejoLocal=true`, [2400], ['poblacion.cortejoLocal']);
  assert.notEqual(conLey['2400'], BASE[13]!['reglas 10']);
});

const CORTEJO = /va a donde lo vio por última vez/;
const REENCUENTRO = /Vuelve a donde vio por última vez/;
const distancia = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
const apuntaA = (p: Person, lugar: { x: number; y: number }) => p.action === 'approach' && p.target.x === lugar.x && p.target.y === lugar.y;

/**
 * Escena: dos adultos fértiles con vínculo mutuo 0,6, sin urgencias, en una franja de tierra de 25 celdas. `a` (en la
 * celda 6) decide en el primer paso y ve a `b`, que descansa en la celda 12 (el lugar P) y no vuelve a decidir. Nadie
 * más en el mundo; cielo despejado hasta el paso 600.
 */
function escena(params: string, parientes = false) {
  const world = createWorld(42, parseParams(params)); world.weather = 'clear';
  world.people = world.people.filter(p => p.role === 'neighbor').slice(0, 2);
  const [a, b] = world.people as [Person, Person];
  let origen: { x: number; y: number } | undefined;
  for (let y = 0; y < 40 && !origen; y++) for (let x = 0; x < 40 && !origen; x++) {
    const franja = Array.from({ length: 25 }, (_, dx) => tileAt(world, { x: x + dx, y }));
    if (franja.every(tile => tile && tile.terrain !== 'water')) origen = { x, y };
  }
  assert.ok(origen, 'la escena necesita una franja de tierra');
  if (parientes) { a.genome.parents = ['madre', 'padre']; b.genome.parents = ['madre', 'padre']; }
  a.bonds = { [b.id]: 0.6 }; b.bonds = { [a.id]: 0.6 };
  for (const [p, dx, decide] of [[a, 6, 0], [b, 12, 100_000]] as const) {
    const edad = demographicTraits(p.genome, paramsOf(world).cuerpo).maturityAge + 100;
    Object.assign(p, { x: origen.x + dx, y: origen.y, target: { x: origen.x + dx, y: origen.y }, action: 'rest', decisionAt: decide,
      hunger: 0.1, thirst: 0.1, fatigue: 0.1, energy: 0.9, command: null, values: {}, activity: {}, lastBirth: -100_000, bornAt: -edad });
    p.demography = { ...p.demography, age: edad, health: 1, vitality: 1 };
  }
  const en = (dx: number) => ({ x: origen.x + dx, y: origen.y });
  return { world, a, b, P: en(12), en };
}

/** Tras el primer paso (a ya vio a b en P), b se va a `lejos` y a vuelve a la celda 0, a 12 del lugar: ninguno ve al
 * otro ni a P. `a` decide en el paso siguiente. */
function separar(world: World, a: Person, b: Person, lejos: { x: number; y: number } | null, en: (dx: number) => { x: number; y: number }) {
  if (lejos) Object.assign(b, { x: lejos.x, y: lejos.y, target: { ...lejos } });
  else world.people = world.people.filter(p => p !== b);
  Object.assign(a, { ...en(0), target: en(0), action: 'rest', decisionAt: world.tick + 1 });
  stepWorld(world);
}

test('(ii) el cortejante va al lugar recordado aunque su pareja se haya ido, no la persigue y deja de buscarla allí', () => {
  // Sin la ley, el cortejo sabe dónde está b aunque no la vea: va a su posición de ahora.
  const hoy = escena('poblacion.cortejoLocal=false');
  stepWorld(hoy.world);
  assert.equal(hoy.a.sightings, undefined, 'sin la ley nadie anota avistamientos');
  separar(hoy.world, hoy.a, hoy.b, hoy.en(24), hoy.en);
  assert.ok(apuntaA(hoy.a, hoy.en(24)), 'sin la ley el cortejo lee la posición actual');

  const { world, a, b, P, en } = escena('poblacion.cortejoLocal=true');
  stepWorld(world);
  const visto: Sighting = { x: P.x, y: P.y, tick: world.tick, fertile: true, kin: false, bond: 0.6, missed: false };
  assert.deepEqual(a.sightings, { [b.id]: visto }, 'anota dónde, cuándo y qué vio');
  const Q = en(24);
  separar(world, a, b, Q, en);
  assert.ok(apuntaA(a, P), `va al lugar recordado, no a donde está: ${JSON.stringify(a.target)}`);
  assert.match(a.reason, CORTEJO);
  assert.deepEqual(a.sightings![b.id], visto, 'sin verla, el recuerdo no cambia');
  for (let paso = 0; paso < 300 && !a.sightings![b.id]!.missed; paso++) {
    stepWorld(world);
    assert.ok(distancia(a, b) > 7, 'b nunca entra en su vista');
    assert.ok(!(a.target.x === Q.x && a.target.y === Q.y), 'nunca apunta a donde está b');
  }
  assert.equal(a.sightings![b.id]!.missed, true, 'con el lugar a la vista y sin b, queda buscada sin éxito');
  assert.ok(distancia(a, P) <= 7);
  a.decisionAt = world.tick + 1;
  stepWorld(world);
  assert.ok(!apuntaA(a, P) && !apuntaA(a, Q), 'no vuelve a buscarla hasta volver a verla');
  assert.doesNotMatch(a.reason, CORTEJO);
  // Volver a verla renueva el recuerdo con el lugar nuevo.
  Object.assign(b, { ...en(Math.round(a.x - en(0).x) + 5) });
  a.decisionAt = world.tick + 1;
  stepWorld(world);
  assert.deepEqual({ ...a.sightings![b.id]!, tick: 0 }, { ...visto, x: b.x, y: b.y, tick: 0 });
});

test('(iii) la elección no lee dónde está ni si vive quien no se ve', () => {
  const destinos = [24, 18, null].map(lejos => {
    const { world, a, b, en } = escena('poblacion.cortejoLocal=true');
    stepWorld(world);
    separar(world, a, b, lejos === null ? null : en(lejos), en);
    return { action: a.action, target: { ...a.target }, P: en(12) };
  });
  for (const destino of destinos) assert.deepEqual(destino, { action: 'approach', target: destinos[0]!.P, P: destinos[0]!.P });
});

test('(iv) la edad fértil que exige el cortejo es la que vio, no la de ahora', () => {
  const vida = (p: Person, world: World) => demographicTraits(p.genome, paramsOf(world).cuerpo);
  const edad = (p: Person, age: number) => { p.demography = { ...p.demography, age }; p.bornAt = -age; };
  // Vista adulta y fértil; ahora, sin que nadie la vea, ya envejeció: el cortejo local la sigue buscando donde la vio.
  for (const local of [false, true]) {
    const { world, a, b, P, en } = escena(`poblacion.cortejoLocal=${local}`);
    stepWorld(world);
    edad(b, vida(b, world).senescenceStart + 10);
    separar(world, a, b, en(24), en);
    assert.equal(apuntaA(a, P), local, local ? 'recuerda que era fértil' : 'sin la ley lee que ya no lo es');
    assert.ok(!apuntaA(a, en(24)));
  }
  // Vista todavía joven; ahora, sin que nadie la vea, ya es adulta: el cortejo local no lo sabe.
  for (const local of [false, true]) {
    const { world, a, b, P, en } = escena(`poblacion.cortejoLocal=${local}`);
    edad(b, vida(b, world).maturityAge - 100);
    stepWorld(world);
    if (local) assert.equal(a.sightings![b.id]!.fertile, false);
    edad(b, vida(b, world).maturityAge + 100);
    separar(world, a, b, en(24), en);
    assert.equal(apuntaA(a, en(24)), !local, local ? 'no corteja a quien vio joven' : 'sin la ley lee que ya es adulta');
    assert.ok(!apuntaA(a, P));
  }
});

test('(v) el reencuentro local va adonde vio a los suyos, sin mirar parentesco; el cortejo no corteja parientes', () => {
  const hoy = escena('poblacion.cortejoLocal=false,social.reencuentro=2', true);
  stepWorld(hoy.world);
  separar(hoy.world, hoy.a, hoy.b, hoy.en(24), hoy.en);
  assert.ok(apuntaA(hoy.a, hoy.en(24)), 'sin la ley el reencuentro lee la posición actual');

  const { world, a, b, P, en } = escena('poblacion.cortejoLocal=true,social.reencuentro=2', true);
  stepWorld(world);
  assert.equal(a.sightings![b.id]!.kin, true);
  assert.doesNotMatch(a.reason, REENCUENTRO, 'con uno de los suyos a la vista no hay reencuentro');
  separar(world, a, b, en(24), en);
  assert.ok(apuntaA(a, P));
  assert.match(a.reason, REENCUENTRO);

  const soloCortejo = escena('poblacion.cortejoLocal=true', true);
  stepWorld(soloCortejo.world);
  separar(soloCortejo.world, soloCortejo.a, soloCortejo.b, soloCortejo.en(24), soloCortejo.en);
  assert.ok(!apuntaA(soloCortejo.a, soloCortejo.P), 'el parentesco visto excluye el cortejo');
});

test('(vi) al morir un vinculado su avistamiento se borra con el vínculo', () => {
  const { world, a, b } = escena('poblacion.cortejoLocal=true');
  stepWorld(world);
  assert.ok(a.sightings?.[b.id]);
  Object.assign(b, { hunger: 1, thirst: 1 }); b.demography = { ...b.demography, health: 1e-6 };
  stepWorld(world);
  assert.ok(!world.people.includes(b), 'b murió');
  assert.equal(a.bonds[b.id], undefined);
  assert.equal(a.sightings?.[b.id], undefined);
});

/** Seed 13 con reglas 10 a 600 pasos: fundadores con vínculos mutuos que se ven y se separan. */
function avanzado(params: string): World {
  const world = createWorld(13, parseParams(params));
  for (let paso = 0; paso < 600; paso++) stepWorld(world);
  return world;
}
const memorias = (world: World) => Object.fromEntries(world.people.filter(p => p.sightings).map(p => [p.id, p.sightings]));

test('(vii) la memoria sólo existe con la ley, se guarda y se recarga igual', { timeout: 600_000 }, t => {
  assert.deepEqual(memorias(avanzado('')), {}, 'sin la ley nadie recuerda avistamientos');
  const world = avanzado('poblacion.cortejoLocal=true'), antes = memorias(world);
  assert.ok(Object.keys(antes).length > 0, 'con la ley hay avistamientos');
  for (const person of world.people) for (const id of Object.keys(person.sightings ?? {})) assert.ok(Object.hasOwn(person.bonds, id));
  assertWorld(world);
  const cargado = recargar(t, world), referencia = recargar(t, avanzado('poblacion.cortejoLocal=true'));
  assert.equal(paramsOf(cargado).poblacion.cortejoLocal, true);
  assert.deepEqual(memorias(cargado), antes);
  assert.equal(digestoCanonico(cargado), digestoCanonico(referencia));
  for (let paso = 0; paso < 600; paso++) { stepWorld(cargado); stepWorld(referencia); }
  assert.equal(digestoCanonico(cargado), digestoCanonico(referencia));
  assertWorld(cargado);
  // Una instantánea que no nombra la clave carga con el valor histórico.
  assert.equal(paramsOf(recargar(t, createWorld(13), 'poblacion.cortejoLocal')).poblacion.cortejoLocal, false);
});

test('(viii) assertWorld acota la memoria de avistamientos', { timeout: 600_000 }, () => {
  const world = avanzado('poblacion.cortejoLocal=true');
  const person = world.people.find(p => Object.keys(p.sightings ?? {}).length > 0)!;
  const [id] = Object.keys(person.sightings!) as [string];
  const entrada = () => person.sightings![id] as unknown as Record<string, unknown>;
  const casos: [string, () => void][] = [
    ['un avistamiento sin vínculo', () => { person.sightings!.nadie = { ...person.sightings![id]! }; }],
    ['un campo de más', () => { entrada().extra = 1; }],
    ['un campo de menos', () => { delete entrada().missed; }],
    ['un paso futuro', () => { entrada().tick = world.tick + 1; }],
    ['missed no booleano', () => { entrada().missed = 1; }],
    ['fertile no booleano', () => { entrada().fertile = 'sí'; }],
    ['vínculo fuera de [0, 1]', () => { entrada().bond = 1.5; }],
    ['coordenada no entera', () => { entrada().x = 0.5; }],
    ['memoria que no es un objeto', () => { (person as unknown as Record<string, unknown>).sightings = []; }],
  ];
  for (const [caso, estropear] of casos) {
    const copia = structuredClone(person.sightings);
    estropear();
    assert.throws(() => assertWorld(world), caso);
    person.sightings = copia;
  }
  assert.doesNotThrow(() => assertWorld(world));
});
