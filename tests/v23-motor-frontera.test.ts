import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { AREA_CELDA, huella } from '../src/world/decision/fauna.js';
import { masaDe } from '../src/world/materia/cuerpo.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams } from '../src/world/params.js';

test('la fauna cruza entre dueños sin superar el área de la celda de destino', async () => {
  const semilla = 2321171583;
  const base = hostOpenWorldParams();
  const params = parseParams({ v23: escalon('duenos'), motor: { ...base.motor, hilos: 2, gpu: [] } }, base);
  const mundo = createWorld(semilla, params);
  const motor = crearMotor(mundo, { hilos: 2, gpu: [], decisionGpu: 'siempre', verificar: true, semilla });
  try {
    for (let tick = 0; tick < 120; tick++) motor.paso([]);
    const c = ctxMateriaDe(mundo);
    const { world } = motor.instantanea();
    const ocupacion = new Map<string, number>();
    for (const animal of world.animals) {
      assert.ok(animal.cuerpo);
      const celda = `${animal.x},${animal.y}`;
      const total = (ocupacion.get(celda) ?? 0) + huella(masaDe(c, animal.cuerpo));
      assert.ok(total <= AREA_CELDA * (1 + 1e-9), `${celda} ocupa ${total} m²`);
      ocupacion.set(celda, total);
    }
    const { enviados, recibidos, pendientes } = duenoSi(mundo)!.balanceIntentos();
    assert.equal(enviados, recibidos + pendientes);
    assert.ok(motor.telemetria().migraciones > 0);
  } finally {
    await motor.cerrar();
  }
});
