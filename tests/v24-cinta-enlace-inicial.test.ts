import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import { GrabadorCinta } from '../src/server/sim-worker.js';
import { Store } from '../src/server/store.js';
import { CINTA } from '../src/shared/cinta.js';
import { escalon } from '../src/shared/interruptores.js';
import { Dueno } from '../src/world/motor/contexto.js';
import { parseParams } from '../src/world/params.js';

test('createApp enlaza la cinta en el arranque de los dueños y la cierra si falla el primer guardado', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'v24-cinta-enlace-inicial-'));
  const hilosAnteriores = process.env.CARTA_MOTOR_HILOS;
  process.env.CARTA_MOTOR_HILOS = '2';
  t.after(() => {
    if (hilosAnteriores === undefined) delete process.env.CARTA_MOTOR_HILOS;
    else process.env.CARTA_MOTOR_HILOS = hilosAnteriores;
    rmSync(dir, { recursive: true, force: true });
  });
  const prepararEpoca = t.mock.method(Dueno.prototype, 'prepararEpoca');
  const cerrarGrabador = t.mock.method(GrabadorCinta.prototype, 'cerrar');
  const opciones = {
    seed: 7, params: parseParams({ v23: escalon('duenos') }), origin: 'http://127.0.0.1',
    manual: true, password: 'cinta-laboratorio', confirmarGuardadoVivo: true,
  };

  let arranquesSinCinta = 0;
  for (const tape of [false, true]) {
    const store = new Store(join(dir, `${tape}.sqlite`));
    try {
      prepararEpoca.mock.resetCalls();
      const app = createApp({ ...opciones, store, tape });
      try {
        assert.equal(app.telemetriaMotor?.hilos, 2);
        assert.equal(app.grabaCinta, tape);
        if (tape) {
          assert.equal(prepararEpoca.mock.callCount(), arranquesSinCinta, 'enlazar la cinta no rearma la piscina');
          let estado = await app.flushTape();
          for (let paso = 0; paso <= CINTA.pasos[0] && estado.frames === 0; paso++) {
            app.stepOnce();
            estado = await app.flushTape();
          }
          assert.equal(app.salud().recargas, 0);
          assert.ok(estado.frames > 0 && estado.latestTick > 0, `estado de la cinta: ${JSON.stringify(estado)}`);
        } else arranquesSinCinta = prepararEpoca.mock.callCount();
      } finally { await app.close(); }
    } finally { store.close(); }
  }

  const store = new Store(join(dir, 'fallo.sqlite'));
  try {
    cerrarGrabador.mock.resetCalls();
    const fallo = new Error('fallo inyectado en el primer guardado');
    t.mock.method(store, 'guardarConEntradas', () => { throw fallo; });
    assert.throws(() => createApp({ ...opciones, store, tape: true }), error => error === fallo);
    assert.equal(cerrarGrabador.mock.callCount(), 1);
    await cerrarGrabador.mock.calls[0]!.result;
  } finally { store.close(); }
});
