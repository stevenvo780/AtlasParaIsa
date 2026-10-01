import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, createWorld, type Person, type World } from '../src/world/index.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { aplicarPlacebo, mortalMenorId, nextDown, nextUp, PLACEBO_TICK, placeboDireccion } from '../scripts/lab/placebo.js';

const vista = new DataView(new ArrayBuffer(8));
const bits = (x: number): bigint => (vista.setFloat64(0, x), vista.getBigUint64(0));

test('placebo: t0 = 4807 y evita ticks de chunks/tiempo/persistencia', () => {
  assert.equal(PLACEBO_TICK, 4807);
  assert.notEqual(PLACEBO_TICK % 10, 0);
  assert.notEqual(PLACEBO_TICK % 600, 0);
});

test('placebo: paridad par-arriba / impar-abajo', () => {
  assert.equal(placeboDireccion(18102), 'up');
  assert.equal(placeboDireccion(18101), 'down');
});

test('placebo: nextUp/nextDown mueven exactamente 1 ulp', () => {
  assert.equal(nextUp(1), 1 + 2 ** -52);
  assert.equal(nextDown(1), 1 - 2 ** -53);
  assert.equal(nextUp(0.5) - 0.5, 2 ** -53);
  for (const x of [0.1, 0.3, 0.78, 0.999, 1e-6]) {
    assert.equal(bits(nextUp(x)) - bits(x), 1n);
    assert.equal(bits(x) - bits(nextDown(x)), 1n);
    assert.equal(nextDown(nextUp(x)), x);
    assert.equal(nextUp(nextDown(x)), x);
  }
});

test('placebo: el valor pateado sobrevive a la serialización JSON sin redondeo', () => {
  // Personas y teselas se archivan como JSON (stringifyExact/JSON.stringify);
  // el round-trip debe devolver el mismo double bit a bit.
  for (const x of [0.1, 0.3, 0.78, 0.999, 1e-6, 5e-324]) {
    for (const v of [nextUp(x), nextDown(x)]) assert.ok(Object.is(JSON.parse(JSON.stringify(v)), v));
  }
});

function mundoFalso(personas: Partial<Person>[]): World {
  return { people: personas } as unknown as World;
}

test('placebo: patea al mortal de menor id y solo a él', () => {
  const mundo = mundoFalso([
    { id: 'b', role: 'neighbor', thirst: 0.5, energy: 0.5, hunger: 0.5, fatigue: 0.5 },
    { id: 'a', role: 'neighbor', thirst: 0.3, energy: 0.5, hunger: 0.5, fatigue: 0.5 },
    { id: '0', role: 'S', thirst: 0.1, energy: 0.1, hunger: 0.1, fatigue: 0.1 },
  ]);
  const parte = aplicarPlacebo(mundo, 18102, PLACEBO_TICK); // par: up
  assert.equal(parte.personaId, 'a');
  assert.equal(parte.variable, 'thirst');
  assert.equal(parte.direccion, 'up');
  assert.equal(parte.antes, 0.3);
  assert.equal(parte.despues, nextUp(0.3));
  const personas = mundo.people as unknown as Person[];
  assert.equal(personas[1]!.thirst, nextUp(0.3));
  assert.equal(personas[0]!.thirst, 0.5); // el otro mortal intacto
  assert.equal(personas[2]!.thirst, 0.1); // S intacta
});

test('placebo: en el borde exacto recurre a la siguiente variable con la misma dirección', () => {
  const mundo = mundoFalso([{ id: 'a', role: 'neighbor', thirst: 0, energy: 0.5, hunger: 0.5, fatigue: 0.5 }]);
  const parte = aplicarPlacebo(mundo, 18101, PLACEBO_TICK); // impar: down; nextDown(0) < 0
  assert.equal(parte.variable, 'energy');
  assert.equal(parte.direccion, 'down');
  assert.equal(parte.despues, nextDown(0.5));
});

test('placebo: falla en voz alta sin mortales, fuera de t0 o sin variable viable', () => {
  assert.throws(() => aplicarPlacebo(mundoFalso([{ id: 's', role: 'S' }]), 18102, PLACEBO_TICK), /sin mortal/);
  assert.throws(() => aplicarPlacebo(mundoFalso([{ id: 'a', role: 'neighbor', thirst: 0.5 }]), 18102, 4800), /solo se aplica/);
  assert.throws(() => aplicarPlacebo(
    mundoFalso([{ id: 'a', role: 'neighbor', thirst: 0, energy: 0, hunger: 0, fatigue: 0 }]), 18101, PLACEBO_TICK), /imposible/);
  assert.throws(() => mortalMenorId(mundoFalso([])), /sin mortal/);
});

test('placebo: sobre un mundo real el mundo sigue válido y el digesto cambia solo por la patada', () => {
  const mundo = createWorld(18101, DEFAULT_PARAMS);
  const antes = digestoCanonico(mundo);
  const parte = aplicarPlacebo(mundo, 18101, PLACEBO_TICK);
  assertWorld(mundo);
  assert.notEqual(digestoCanonico(mundo), antes);
  assert.equal(parte.direccion, 'down');
  assert.equal(bits(parte.antes) - bits(parte.despues), 1n);
});
