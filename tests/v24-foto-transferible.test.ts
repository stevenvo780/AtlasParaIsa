import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROL_ENLACE_BYTES, SERIE_CAMPOS, enlaceCinta, type CampoSerie } from '../src/shared/fotograma.js';
import { escalon } from '../src/shared/interruptores.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import type { ParteFotoDueno } from '../src/world/motor/fotograma-dueno.js';
import { CanalesCorte, enviarParteFoto } from '../src/world/motor/mensajes-corte.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams } from '../src/world/params.js';
import { crearSAB } from '../src/world/soa/arena.js';

function paquete(hilo: number, tick: number): ParteFotoDueno {
  return { hilo, tick, desbordado: false, compatFallback: false, trasFallback: false,
    bytes: 4, bajasBloques: [Uint8Array.of(0, 1)], altasBloques: [Uint8Array.of(42), Uint8Array.of(43)],
    paginasEscritas: [], estructurasAltasIds: [], estructurasBajasIds: [],
    crucesFaunaSalientes: [], paginasPendientesCruce: [], resumen: null };
}

test('el puerto mueve los bloques completos y drena duplicados y partes de otro tick', () => {
  const canales = CanalesCorte.abrir(2);
  assert.ok(canales);
  const [uno, dos] = canales.puertosRemotos;
  try {
    const parte = paquete(2, 15);
    enviarParteFoto(dos!, 3, parte);
    assert.ok([...parte.bajasBloques, ...parte.altasBloques].every(bloque => bloque.buffer.byteLength === 0));
    enviarParteFoto(uno!, 3, paquete(1, 14));
    assert.deepEqual(canales.recibirFotos(3, 15), [paquete(2, 15)]);

    enviarParteFoto(uno!, 3, paquete(1, 16));
    enviarParteFoto(uno!, 3, paquete(1, 16));
    enviarParteFoto(dos!, 2, paquete(2, 16));
    assert.deepEqual(canales.recibirFotos(3, 16), []);
    enviarParteFoto(uno!, 3, paquete(1, 17));
    assert.deepEqual(canales.recibirFotos(3, 17), [paquete(1, 17)]);
  } finally { canales.cerrar(); }
});

test('los dueños reciben la foto por puerto antes de pedir otro corte por el mismo canal', async t => {
  const recibir = t.mock.method(CanalesCorte.prototype, 'recibirFotos');
  const descriptor = { control: new SharedArrayBuffer(CONTROL_ENLACE_BYTES),
    ranuras: [crearSAB(0, 16 * 1024 * 1024)], versiones: crearSAB(0, 65536), sucesos: new SharedArrayBuffer(16 * 1024 * 1024) };
  const enlace = enlaceCinta(descriptor);
  const mundo = createWorld(17, parseParams({ v23: { ...escalon('duenos'), fotograma: true } }));
  const motor = crearMotor(mundo, { ...unSoloDueno(17), hilos: 2,
    instantaneaTransferible: true, emisionFotogramaDuenos: true });
  const serie = Object.fromEntries(SERIE_CAMPOS.map(campo => [campo, 0])) as Record<CampoSerie, number>;
  try {
    motor.enlazar(descriptor, {
      corte: () => assert.fail('Un fotograma válido y dentro de cupo se arma con las partes de los dueños.'),
      cortePorDuenos: (_c, f, _paginas, lote) => {
        assert.deepEqual(lote.partes.map(parte => [parte.hilo, parte.tick]), [[0, f.tick], [1, f.tick]]);
        return { serie, sucesos: [], bloques: lote.partes.flatMap(parte => parte.altasBloques) };
      },
      confirmar: () => {},
    });
    motor.cargar({ world: mundo, materia: null }, 3);
    motor.paso([]); // El primer paso da de alta las filas de fauna heredada.
    Atomics.store(enlace.creditos, 0, 1);
    motor.paso([]);
    assert.equal(recibir.mock.callCount(), 1);
    const partes = recibir.mock.calls[0]!.result!;
    assert.equal(partes.length, 1, 'debe llegar una parte del único dueño remoto');
    assert.ok(partes[0]!.altasBloques.length > 0);
    assert.equal(motor.trazaFotogramaDuenos?.reunionesEvitadas, 1, JSON.stringify(motor.trazaFotogramaDuenos));
    assert.equal(motor.instantanea().world.tick, 2);
  } finally { await motor.cerrar(); }
});
