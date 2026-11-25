import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWorld, createWorld } from '../src/world/index.js';
import { TOTALES_V23 } from '../src/world/totales-v23.js';

// Un mundo con cuerpos que come y bebe suma los contadores V23 a los 13 heredados; su guardado debe poder leerse.
test('totals: los contadores V23 se admiten junto a los heredados y no cuentan en su tope', () => {
  const world = createWorld(7);
  world.totals.roadsPaved = 0;
  for (const k of TOTALES_V23) world.totals[k] = 1e13; // Σ por persona y tick: puede pasar del tope heredado.
  assertWorld(world);
});

test('totals: una clave ajena de más o un contador V23 negativo siguen siendo corrupción', () => {
  const ajena = createWorld(7);
  ajena.totals.roadsPaved = 0; ajena.totals.otraClave = 1;
  assert.throws(() => assertWorld(ajena), /Estado procedural inválido/);
  const negativo = createWorld(7);
  negativo.totals[TOTALES_V23[0]] = -1;
  assert.throws(() => assertWorld(negativo), /Estado procedural inválido/);
});
