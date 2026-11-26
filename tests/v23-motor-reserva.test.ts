import assert from 'node:assert/strict';
import test from 'node:test';
import { sembrarMundo } from '../scripts/perf/banco-motor-v23.mjs';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { escalon } from '../src/shared/interruptores.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { parseParams, setParams } from '../src/world/params.js';

test('la arena reserva todos los chunks que se activan en la misma barrera', async () => {
  const semilla = 51926, hilos = 2;
  const { world, conMotor } = await sembrarMundo(40, semilla, true, 0);
  const paginasIniciales = Object.keys(world.chunks).length;
  setParams(world, parseParams({ v23: escalon('duenos'), motor: conMotor({ hilos, gpu: [] }).motor }, hostOpenWorldParams()));
  const motor = crearMotor(world, { ...unSoloDueno(semilla), hilos });
  try {
    for (let i = 1; i <= 3; i++) assert.equal(motor.paso([]).tick, i);
    assert.ok(duenoSi(world)!.terreno.paginas > paginasIniciales + 1);
  } finally {
    await motor.cerrar();
  }
});
