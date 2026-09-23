import test from 'node:test';
import assert from 'node:assert/strict';
import { digestosControl, LEYES_CANDIDATAS } from '../scripts/lab/rendimiento.js';
import { createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { tileAt } from '../src/world/spatial.js';
import { closeKin } from '../src/world/family.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, paramsOf, parseParams } from '../src/world/params.js';
import { CLAVES_POSTERIORES, recargar } from './lib/claves-posteriores.js';

/**
 * Reencuentro, `social.reencuentro` (hipótesis H2 del diagnóstico de semillas). En las semillas de charcas
 * finitas (13, 23) el grupo arranca junto al agua y se dispersa cuando las charcas se agotan; a más de 7
 * celdas ninguna regla acerca a dos mortales salvo el cortejo, que exige que los dos estén listos para criar
 * a la vez. Los hijos maduran lejos de cualquier no pariente. La ley: quien no tiene urgencias y no ve a
 * ninguno de los suyos (vínculo mutuo ≥ 0,3) va hacia el más cercano que recuerde, a ≤ radioCortejo.
 * Default 0 = hoy.
 */

/** Digestos de `digestosControl` medidos en el árbol anterior a esta ley (5e33561, la de `agua.rebano`,
 * exportado con `git archive`), con `LEYES_CANDIDATAS` y sin las claves de `CLAVES_POSTERIORES` que ese árbol
 * ya declaraba (`social.memoriaDisputa`, `agua.rebano`). */
const BASE: Record<number, Record<'1200' | '2400', string>> = {
  13: { 1200: '7b8bf64da50fcc371abdd709424acbb70c4ef1af4094471fc679dddb511a5473',
    2400: '9349abea8634e56afa86c96404c3e54bd3a8a80d1c515e2ff1f2f3a02107c582' },
  23: { 1200: '44a2330590e7e3b4a1c365bf4130b9ca66a957253f4a91754ae1814aaa3b5795',
    2400: '2c706b0da9aad07895a18810407a46263744c3b499d59d6ad17643d0f5da22e5' },
};

test('(i) con social.reencuentro=0 el mundo es bit a bit el de antes en dos semillas de charcas', { timeout: 1_800_000 }, () => {
  assert.equal(DEFAULT_PARAMS.social.reencuentro, 0);
  assert.equal(HISTORICAL_PARAMS.social.reencuentro, 0);
  assert.ok(CLAVES_POSTERIORES.includes('social.reencuentro'));
  for (const seed of [13, 23]) {
    assert.deepEqual(digestosControl(seed, LEYES_CANDIDATAS, [1200, 2400], CLAVES_POSTERIORES), BASE[seed], `semilla ${seed}`);
  }
  // El control tiene dientes: en esos 2400 pasos hay separados sin urgencia, y la ley los mueve.
  const conLey = digestosControl(13, `${LEYES_CANDIDATAS},social.reencuentro=1`, [2400], CLAVES_POSTERIORES);
  assert.notEqual(conLey['2400'], BASE[13]!['2400'], 'con social.reencuentro=1 la semilla 13 toma otro camino');
});

const RAZON = /no ve cerca a nadie de los suyos/;
const separacion = (p: Person, q: Person) => Math.hypot(p.x - q.x, p.y - q.y);

/**
 * Escena: dos hermanos (el cortejo no los une: son parientes) con vínculo mutuo 0,6, sin urgencias, en una
 * franja de tierra a 12 celdas uno del otro. `b` descansa y no vuelve a decidir; `a` decide en el primer paso.
 * Nadie más en el mundo; cielo despejado hasta el paso 600.
 */
function escena(params: string): { world: World; a: Person; b: Person } {
  const world = createWorld(42, parseParams(params)); world.weather = 'clear';
  world.people = world.people.filter(p => p.role === 'neighbor').slice(0, 2);
  const [a, b] = world.people as [Person, Person];
  let origen: { x: number; y: number } | undefined;
  for (let y = 0; y < 40 && !origen; y++) for (let x = 0; x < 40 && !origen; x++) {
    const franja = Array.from({ length: 13 }, (_, dx) => tileAt(world, { x: x + dx, y }));
    if (franja.every(tile => tile && tile.terrain !== 'water')) origen = { x, y };
  }
  assert.ok(origen, 'la escena necesita una franja de tierra');
  a.genome.parents = ['madre', 'padre']; b.genome.parents = ['madre', 'padre'];
  a.bonds = { [b.id]: 0.6 }; b.bonds = { [a.id]: 0.6 };
  for (const [p, dx, decide] of [[a, 0, 0], [b, 12, 100_000]] as const) {
    Object.assign(p, { x: origen.x + dx, y: origen.y, target: { x: origen.x + dx, y: origen.y }, action: 'rest', decisionAt: decide,
      hunger: 0.1, thirst: 0.1, fatigue: 0.1, energy: 0.9, command: null, values: {}, activity: {} });
  }
  return { world, a, b };
}

test('(ii) un separado sin urgencia va hacia su vinculado, aunque sea pariente, y deja de hacerlo al verlo', () => {
  const hoy = escena('social.reencuentro=0');
  assert.ok(closeKin(hoy.a, hoy.b));
  stepWorld(hoy.world);
  assert.doesNotMatch(hoy.a.reason, RAZON);
  assert.ok(!(hoy.a.action === 'approach' && hoy.a.target.x === hoy.b.x && hoy.a.target.y === hoy.b.y), 'sin la ley nadie lo busca');

  const { world, a, b } = escena('social.reencuentro=2');
  stepWorld(world);
  assert.equal(a.action, 'approach');
  assert.deepEqual(a.target, { x: b.x, y: b.y });
  assert.match(a.reason, RAZON);
  const inicio = separacion(a, b);
  for (let paso = 0; paso < 300 && separacion(a, b) > 7; paso++) stepWorld(world);
  assert.ok(separacion(a, b) <= 7 && separacion(a, b) < inicio, `se acerca hasta verlo: ${separacion(a, b)}`);
  // Ya lo ve: la ley se apaga en la decisión siguiente.
  a.decisionAt = world.tick + 1;
  stepWorld(world);
  assert.ok(a.decisionAt > world.tick, 'volvió a decidir');
  assert.doesNotMatch(a.reason, RAZON, 'con uno de los suyos a la vista no hay reencuentro');
});

test('(iii) con urgencias no hay reencuentro', () => {
  const { world, a } = escena('social.reencuentro=2');
  a.thirst = 0.5;
  stepWorld(world);
  assert.doesNotMatch(a.reason, RAZON);
});

test('(iv) PARAM_RANGES acota social.reencuentro a [0, 2]', () => {
  assert.deepEqual(PARAM_RANGES['social.reencuentro'], [0, 2]);
  assert.equal(parseParams('social.reencuentro=1.5').social.reencuentro, 1.5);
  assert.throws(() => parseParams('social.reencuentro=2.01'), /fuera de rango/);
  assert.throws(() => parseParams('social.reencuentro=-0.1'), /fuera de rango/);
});

test('(v) una instantánea sin social.reencuentro carga con 0 y sigue la misma trayectoria', { timeout: 600_000 }, t => {
  const avanzado = (params: string) => {
    const world = createWorld(13, parseParams(params));
    for (let paso = 0; paso < 240; paso++) stepWorld(world);
    return world;
  };
  const cargado = recargar(t, avanzado(LEYES_CANDIDATAS), 'social.reencuentro'), referencia = recargar(t, avanzado(LEYES_CANDIDATAS));
  assert.equal(paramsOf(cargado).social.reencuentro, 0, 'la clave ausente se completa con el valor histórico');
  assert.deepEqual(paramsOf(cargado), paramsOf(referencia));
  assert.equal(digestoCanonico(cargado), digestoCanonico(referencia));
  for (let paso = 0; paso < 1200; paso++) { stepWorld(cargado); stepWorld(referencia); }
  assert.equal(digestoCanonico(cargado), digestoCanonico(referencia));
  assert.equal(paramsOf(recargar(t, createWorld(13, parseParams('social.reencuentro=0.5')))).social.reencuentro, 0.5);
});
