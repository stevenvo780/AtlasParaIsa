import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { assertWorld, createWorld } from '../src/world/index.js';
import { parseParams, setParams } from '../src/world/params.js';

test('el guardado admite el trabajo pagado parcialmente por un cuerpo', () => {
  const mundo = createWorld(7, parseParams({ v23: escalon('cuerpos') }));
  const persona = mundo.people[0]!;
  persona.cuerpo = { tejido: 0, reserva: 1, digestivo: 2, plantilla: 3 };
  persona.action = 'gather';
  persona.work = 2.5;
  assertWorld(mundo);

  for (const invalido of [-0.5, 600.5, Infinity, NaN]) {
    persona.work = invalido;
    assert.throws(() => assertWorld(mundo), /Estado procedural inválido/);
  }

  setParams(mundo, parseParams({ v23: escalon('guardadoCompleto') }));
  persona.work = 2.5;
  assert.throws(() => assertWorld(mundo), /Estado procedural inválido/);
  persona.work = 2;
  assertWorld(mundo);
});
