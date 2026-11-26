import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import type { Animal } from '../src/world/animals.js';
import { AREA_CELDA, huella } from '../src/world/decision/fauna.js';
import { masaDe } from '../src/world/materia/cuerpo.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { duenoSi, ORDEN } from '../src/world/motor/contexto.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams } from '../src/world/params.js';
import { chunkKey } from '../src/world/terrain.js';
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

test('un alta sin fila no deja al dueño anterior actuando sobre un cuerpo cedido', async () => {
  const semilla = 51926;
  const base = hostOpenWorldParams();
  const params = parseParams({ v23: escalon('duenos'), motor: { ...base.motor, hilos: 2, gpu: [] } }, base);
  const mundo = createWorld(semilla, params);
  const saliente = mundo.animals[0];
  assert.ok(saliente);
  mundo.animals = [saliente];
  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos: 2 });
  try {
    motor.paso([]);
    const d = duenoSi(mundo)!;
    assert.ok(d.materia);
    const t = d.terrenoPercibido, origen = chunkKey(saliente.x, saliente.y);
    const chunk = t.chunkDe(t.celda(saliente.x, saliente.y));
    assert.equal(t.duenoChunk[chunk], 0);
    const habitat = tileLookup(mundo.tiles)(saliente.x, saliente.y)?.terrain;
    const tesela = mundo.tiles.find(t => t.terrain === habitat && chunkKey(t.x, t.y) !== origen);
    assert.ok(tesela);
    const entrante: Animal = { ...structuredClone(saliente), id: 'animal-entrante',
      uid: undefined, cuerpo: undefined, fauna: undefined, x: tesela.x, y: tesela.y };

    d.ordenar(0, [ORDEN.ceder, chunk, 1]);
    t.duenoSiguiente[chunk] = 1;
    motor.paso([]);
    t.asignar(chunk, 1);
    t.duenoSiguiente[chunk] = -1;
    assert.ok(!mundo.animals.includes(saliente));
    // Con un alta sin fila, el número de animales vuelve a coincidir con el de filas del tick anterior.
    mundo.animals.push(entrante);
    motor.paso([]);

    const { world } = motor.instantanea();
    const cuerpoCedido = world.animals.find(a => a.id === saliente.id)?.cuerpo;
    assert.ok(cuerpoCedido && entrante.cuerpo);
    assert.ok(d.materia.vivo(cuerpoCedido.digestivo));
    assert.equal(d.materia.propio(cuerpoCedido.digestivo), false);
    assert.ok(d.materia.propio(entrante.cuerpo.digestivo));
  } finally {
    await motor.cerrar();
  }
});
