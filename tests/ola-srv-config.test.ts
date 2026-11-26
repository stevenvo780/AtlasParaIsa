import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motorConfig } from '../src/server/hardware-limits.js';

test('el motor del proceso arranca con un dueño, sin GPU y con entropía', () => {
  assert.deepEqual(motorConfig(undefined, {}, { fisicaBytes: 8 * 1024 ** 3 }), {
    hilos: 1, gpu: [], decisionGpu: 'siempre', verificar: false, semilla: null,
  });
});

test('el motor acepta auto y conserva el orden de las tarjetas solicitadas', () => {
  const config = motorConfig(0, { CARTA_MOTOR_HILOS: 'auto', CARTA_MOTOR_GPU: '2, 0, 2' });
  assert.equal(config.hilos, 'auto');
  assert.ok(config.auto && config.auto.maximo >= 1);
  assert.deepEqual(config.gpu, [2, 0]);
  assert.equal(config.semilla, 0);
  assert.equal(motorConfig(7, { CARTA_MOTOR_HILOS: '12' }).hilos, 12);
});

test('la transferencia del corte debe solicitarse al arrancar el servidor', () => {
  const configuracion = { CARTA_MOTOR_HILOS: '2', CARTA_MOTOR_GPU: '' };
  const habilitada = motorConfig(7, { ...configuracion, CARTA_CORTE_TRANSFERIBLE: '1' });
  assert.equal(habilitada.instantaneaTransferible, true);
  assert.equal(habilitada.hilos, 2);
  assert.deepEqual(habilitada.gpu, []);
  assert.equal(motorConfig(7, { ...configuracion, CARTA_CORTE_TRANSFERIBLE: '0' }).instantaneaTransferible, undefined);
});

test('el cotejo de fauna preparada se activa expresamente junto con el corte por puerto', () => {
  const config = { CARTA_MOTOR_HILOS: '8', CARTA_CORTE_TRANSFERIBLE: '1' };
  const activa = motorConfig(7, { ...config, CARTA_FAUNA_CORTE_SOMBRA: '1' });
  assert.equal(activa.instantaneaTransferible, true);
  assert.equal(activa.faunaCortePreparada, true);
  assert.equal(motorConfig(7, config).faunaCortePreparada, undefined);
  assert.equal(motorConfig(7, config).faunaCorteDirecta, undefined);
  assert.equal(motorConfig(7, { ...config, CARTA_FAUNA_CORTE_DIRECTA: '1' }).faunaCorteDirecta, true);
});

test('la emisión del fotograma por dueño debe solicitarse al arrancar el servidor', () => {
  const config = { CARTA_MOTOR_HILOS: '8', CARTA_CORTE_TRANSFERIBLE: '1' };
  const activa = motorConfig(7, { ...config, CARTA_FOTOGRAMA_DUENOS: '1' });
  assert.equal(activa.emisionFotogramaDuenos, true);
  assert.equal(activa.instantaneaTransferible, true);
  assert.equal(motorConfig(7, config).emisionFotogramaDuenos, undefined);
});

test('la preparación durable de teselas remotas se activa expresamente', () => {
  const config = { CARTA_MOTOR_HILOS: '8', CARTA_CORTE_TRANSFERIBLE: '1' };
  assert.equal(motorConfig(7, config).teselasCorteDirectas, undefined);
  assert.equal(motorConfig(7, { ...config, CARTA_TESELAS_CORTE_DIRECTAS: '1' }).teselasCorteDirectas, true);
});

test('la preparación durable de personas remotas requiere un formato binario de guardado', () => {
  const config = { CARTA_MOTOR_HILOS: '8', CARTA_CORTE_TRANSFERIBLE: '1', CARTA_PERSONAS_CORTE_DIRECTAS: '1' };
  assert.equal(motorConfig(7, config).personasCorteDirectas, undefined);
  assert.equal(motorConfig(7, { ...config, CARTA_SNAPSHOT_PACKED_PEOPLE: '1' }).personasCorteDirectas, true);
  assert.equal(motorConfig(7, { ...config, CARTA_SNAPSHOT_PERSONAS_ZSTD: '1' }).personasCorteDirectas, true);
  assert.equal(motorConfig(7, { ...config, CARTA_SNAPSHOT_PESOS_SEPARADOS: '1' }).personasCorteDirectas, true);
});

test('el motor rechaza un despacho inválido antes de arrancar', () => {
  for (const hilos of ['0', '-1', '1.5', '1e2', '9007199254740992']) {
    assert.throws(() => motorConfig(7, { CARTA_MOTOR_HILOS: hilos }), /CARTA_MOTOR_HILOS/);
  }
  for (const gpu of ['-1', '0,', '0,,1', '0.5', '9007199254740992']) {
    assert.throws(() => motorConfig(7, { CARTA_MOTOR_GPU: gpu }), /CARTA_MOTOR_GPU/);
  }
});

test('el proceso acepta los grupos explícitos y conserva el orden de las ranuras por tarjeta', () => {
  const config = motorConfig(7, { CARTA_MOTOR_HILOS: '8', CARTA_MOTOR_GPU: '0,1',
    CARTA_MOTOR_GPU_GRUPOS: ' [[0,1,2,3,4,6],[5,7]] ',
    CARTA_PERCEPCION_DUENOS: '1', CARTA_PERCEPCION_COSTE_DUENOS: '1' });
  assert.equal(config.hilos, 8);
  assert.deepEqual(config.gpu, [0, 1]);
  assert.deepEqual(config.gruposPercepcionGpu, [[0, 1, 2, 3, 4, 6], [5, 7]]);
  assert.equal(config.auto, undefined);
  assert.equal(motorConfig(7, { CARTA_MOTOR_HILOS: '8', CARTA_MOTOR_GPU: '0,1' }).gruposPercepcionGpu, undefined);
});

test('los grupos de percepción rechazan mapas que el corredor no puede abrir', () => {
  const habilitada = { CARTA_MOTOR_HILOS: '8', CARTA_MOTOR_GPU: '0,1',
    CARTA_MOTOR_GPU_GRUPOS: '[[0,1,2,3,4,6],[5,7]]',
    CARTA_PERCEPCION_DUENOS: '1', CARTA_PERCEPCION_COSTE_DUENOS: '1' };
  for (const mapa of ['[', 'null', '[[0]]', '[[0],[]]', '[[0],[0]]', '[[0],[8]]', '[["0"],[1]]']) {
    assert.throws(() => motorConfig(7, { ...habilitada, CARTA_MOTOR_GPU_GRUPOS: mapa }), /CARTA_MOTOR_GPU_GRUPOS/);
  }
  assert.throws(() => motorConfig(7, { ...habilitada, CARTA_MOTOR_HILOS: 'auto' }), /CARTA_MOTOR_HILOS explícito/);
  assert.throws(() => motorConfig(7, { ...habilitada, CARTA_MOTOR_GPU: '' }), /CARTA_MOTOR_GPU_GRUPOS/);
  assert.throws(() => motorConfig(7, { ...habilitada, CARTA_MOTOR_GPU: '0,0,1' }), /CARTA_MOTOR_GPU_GRUPOS/);
  assert.throws(() => motorConfig(7, { ...habilitada, CARTA_PERCEPCION_DUENOS: '0' }), /CARTA_PERCEPCION_DUENOS=1/);
  assert.throws(() => motorConfig(7, { ...habilitada, CARTA_PERCEPCION_COSTE_DUENOS: '0' }), /CARTA_PERCEPCION_COSTE_DUENOS=1/);
});
