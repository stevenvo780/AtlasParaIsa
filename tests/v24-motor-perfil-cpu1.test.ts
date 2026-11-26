import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { parseParams } from '../src/world/params.js';

test('CPU1 material registra las fases del motor y conserva el mundo del paso directo', t => {
  const semilla = 7;
  const params = parseParams({ v23: escalon('intentos') });
  const mundo = createWorld(semilla, params), directo = createWorld(semilla, params);
  const motor = crearMotor(mundo, unSoloDueno(semilla));
  t.after(() => motor.cerrar());

  for (let i = 0; i < 2; i++) {
    motor.paso([]);
    stepWorld(directo);
  }

  const { hilos, tick, faseMs, esperaBarreraMs } = motor.telemetria();
  assert.equal(hilos, 1);
  assert.equal(tick, 2);
  assert.equal(esperaBarreraMs, 0);
  for (const [fase, ms] of Object.entries(faseMs)) {
    assert.ok(Number.isFinite(ms) && ms > 0, `Falta medir ${fase}: ${ms} ms`);
  }
  assert.equal(digestoCanonico(mundo), digestoCanonico(directo));
  t.diagnostic(JSON.stringify(faseMs));
});

test('CPU1 histórico conserva la telemetría del paso sin leyes', t => {
  const semilla = 7;
  const motor = crearMotor(createWorld(semilla), unSoloDueno(semilla));
  t.after(() => motor.cerrar());
  motor.paso([]);
  const { faseMs } = motor.telemetria();
  assert.equal(faseMs.percibir, 0);
  assert.ok(faseMs.eco > 0 && faseMs.actuar > 0 && faseMs.aplicar > 0);
});
