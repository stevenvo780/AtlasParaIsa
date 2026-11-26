import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { AREA_CELDA, huella } from '../src/world/decision/fauna.js';
import { masaDe } from '../src/world/materia/cuerpo.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams } from '../src/world/params.js';
import { tileLookup } from '../src/world/tile-index.js';

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

test('al retirarse un chunk junto a la frontera, cada animal residente conserva su tesela', async () => {
  const semilla = 51926;
  const base = hostOpenWorldParams();
  const params = parseParams({ v23: escalon('duenos'), motor: { ...base.motor, hilos: 2, gpu: [] } }, base);
  const motor = crearMotor(createWorld(semilla, params), { ...unSoloDueno(semilla), hilos: 2 });
  try {
    for (let tick = 0; tick < 120; tick++) motor.paso([]);
    const { world } = motor.instantanea();
    assert.ok(world.retiredChunks.some(chunk => chunk.key === '2,-1'));
    const tesela = tileLookup(world.tiles);
    for (const a of world.animals) {
      assert.ok(tesela(a.x, a.y), `${a.id} quedó en una celda no residente (${a.x}, ${a.y})`);
    }
  } finally {
    await motor.cerrar();
  }
});

test('un alta sin fila no mantiene activa la fila de un animal que ya se fue', async () => {
  const semilla = 7;
  const base = hostOpenWorldParams();
  const params = parseParams({ v23: escalon('fauna'), motor: { ...base.motor, hilos: 1, gpu: [] } }, base);
  const mundo = createWorld(semilla, params);
  const motor = crearMotor(mundo, unSoloDueno(semilla));
  try {
    motor.paso([]);
    const saliente = mundo.animals[0]!;
    const entrante = { ...structuredClone(saliente), id: 'animal-entrante', uid: undefined, cuerpo: undefined, fauna: undefined };
    mundo.animals[0] = entrante;
    const ultimaDecision = saliente.lastDecision;
    motor.paso([]);
    assert.equal(saliente.lastDecision, ultimaDecision);
    assert.ok(entrante.uid && entrante.uid !== saliente.uid);
  } finally {
    await motor.cerrar();
  }
});
