import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { motorConfig, reservaMateriaHost } from '../src/server/hardware-limits.js';
import { cloneWorld, createWorld } from '../src/world/index.js';
import { LOTES_POR_BLOQUE } from '../src/world/materia/arena.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { genDe, refDe, slotDe, unSoloDueno } from '../src/world/motor/contratos.js';
import { duenoSi, LOTES_POR_CHUNK_NUEVO } from '../src/world/motor/contexto.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { DESBORDES_POR_LOTE, RESERVA_LOTES_HISTORICA, RESERVA_LOTES_MAXIMA } from '../src/world/motor/reserva-materia.js';
import { parseParams } from '../src/world/params.js';

const GiB = 1024 ** 3;
const torre = { fisicaBytes: 125 * GiB };

test('la reserva virtual se acota por RAM, cgroup, ancho de columna y dominio de referencias', () => {
  const nodo = 16 * GiB;
  assert.equal(reservaMateriaHost(torre, 'x64', nodo), RESERVA_LOTES_MAXIMA);
  assert.equal(reservaMateriaHost({ ...torre, cgroupBytes: 8 * GiB }, 'x64', nodo), RESERVA_LOTES_HISTORICA);
  assert.equal(reservaMateriaHost(torre, 'ia32', nodo), RESERVA_LOTES_HISTORICA);
  assert.equal(reservaMateriaHost({ fisicaBytes: NaN }, 'x64', nodo), RESERVA_LOTES_HISTORICA);
  assert.equal(reservaMateriaHost(torre, 'x64', 120 * (RESERVA_LOTES_HISTORICA + LOTES_POR_BLOQUE + 1)),
    RESERVA_LOTES_HISTORICA + LOTES_POR_BLOQUE);
  const intermedia = reservaMateriaHost({ ...torre, cgroupBytes: 36 * GiB }, 'x64', nodo);
  assert.ok(intermedia > RESERVA_LOTES_HISTORICA && intermedia < RESERVA_LOTES_MAXIMA);
  assert.equal(intermedia % LOTES_POR_BLOQUE, 0);
  assert.equal(intermedia, Math.floor(36 * GiB / (8 * 228 * LOTES_POR_BLOQUE)) * LOTES_POR_BLOQUE);
  const ranura = RESERVA_LOTES_MAXIMA - 1, gen = genDe(Number.MAX_SAFE_INTEGER);
  const ref = refDe(ranura, gen);
  assert.ok(Number.isSafeInteger(ref));
  assert.equal(slotDe(ref), ranura);
  assert.equal(genDe(ref), gen);
  assert.ok(DESBORDES_POR_LOTE * RESERVA_LOTES_MAXIMA < 0xffffffff);
});

test('CPU1 conserva los bytes VMAT y abre una arena del host sin comprometer la reserva virtual', async () => {
  const params = parseParams({ v23: escalon('materia') }), semilla = 7;
  const limite = reservaMateriaHost(torre);
  const vmats: Uint8Array[] = [];
  for (const config of [unSoloDueno(semilla), motorConfig(semilla, {}, torre)]) {
    const mundo = createWorld(semilla, params);
    const motor = crearMotor(mundo, config);
    try {
      motor.paso([]);
      const dueno = duenoSi(mundo)!;
      const memoria = dueno.muestraMemoriaMateria()!;
      assert.equal(memoria.limiteLotes, config.reservaLotesMateria ?? RESERVA_LOTES_HISTORICA);
      assert.equal(memoria.limiteDesborde, memoria.limiteLotes * DESBORDES_POR_LOTE);
      assert.ok(memoria.bytesArena < 32 * 1024 ** 2, 'el fixture solo compromete la arena que necesita');
      dueno.reservarMateria(1);
      assert.ok(dueno.muestraMemoriaMateria()!.capacidadLotes >= memoria.lotesVivos
        + Math.max(LOTES_POR_CHUNK_NUEVO, memoria.lotesVivos) + LOTES_POR_CHUNK_NUEVO);
      vmats.push(codificarCheckpoint(motor.instantanea().materia!));
    } finally { await motor.cerrar(); }
  }
  assert.equal(motorConfig(semilla, {}, torre).reservaLotesMateria ?? RESERVA_LOTES_HISTORICA, limite);
  assert.deepEqual(vmats[0], vmats[1]);
});

test('un checkpoint previo se abre con la capacidad del anfitrión en CPU1 y CPU2', async () => {
  const params = parseParams({ v23: escalon('duenos') }), semilla = 7;
  const mundo = createWorld(semilla, params);
  const anterior = crearMotor(mundo, unSoloDueno(semilla));
  anterior.paso([]);
  const guardado = anterior.instantanea();
  const vmat = codificarCheckpoint(guardado.materia!);
  const saldo = duenoSi(mundo)!.balanceMateria().hallado;
  await anterior.cerrar();
  for (const hilos of ['1', '2']) {
    const copia = cloneWorld(guardado.world);
    const config = motorConfig(semilla, { CARTA_MOTOR_HILOS: hilos }, torre);
    const motor = crearMotor(copia, config);
    try {
      motor.cargar({ world: copia, materia: guardado.materia }, guardado.materia!.epoca);
      const dueno = duenoSi(copia)!;
      assert.equal(dueno.hilos, Number(hilos));
      assert.equal(dueno.muestraMemoriaMateria()!.limiteLotes, reservaMateriaHost(torre));
      assert.deepEqual(dueno.balanceMateria().hallado, saldo);
      if (hilos === '1') assert.deepEqual(codificarCheckpoint(motor.instantanea().materia!), vmat);
      motor.paso([]);
      const { hallado, esperado } = dueno.balanceMateria();
      assert.deepEqual(hallado, esperado);
    } finally { await motor.cerrar(); }
  }
});
