import assert from 'node:assert/strict';
import test from 'node:test';
import { PuentePercepcion } from '../src/world/gpu/puente.js';
import type { Dispositivo, LotePercepcion, Percepcion, Plan } from '../src/world/motor/contratos.js';

function banco(primera = { preparar: 0.9, porActor: 0.003 }, segunda = { preparar: 2, porActor: 0.004 }) {
  let ahora = 0, despacho = 0;
  const planes: Plan[] = [];
  function dispositivo(id: Dispositivo, preparar: number, porActor: number, fijo = 0) {
    let lote: LotePercepcion, listo: number, cerrados = 0;
    const ultimasTransferencias = { subidos: 0, bajados: 0, ms: 0 };
    const percibidor = { dispositivo: id, ultimasTransferencias, rancia: false,
      lanzar(siguiente: LotePercepcion) {
        lote = siguiente;
        ultimasTransferencias.ms = fijo + lote.slots.length * porActor;
        ahora += preparar;
        listo = ahora + ultimasTransferencias.ms;
      },
      esperar(): Percepcion {
        ahora = Math.max(ahora, listo);
        return { q: 1, v: 0, a: 0, tick: lote.tick, despacho: lote.despacho - Number(this.rancia),
          celda: lote.slots.slice(), pasos: new Int16Array(lote.slots.length), valor: new Float32Array(lote.slots.length),
          organismo: new Float64Array(), utilidad: new Float32Array() };
      },
    };
    return { percibidor, multiprocesadores: 8, cerrar: () => { cerrados++; }, get cerrados() { return cerrados; } };
  }
  const cpu = dispositivo('cpu', 0, 0.02, 0.05);
  const gpu0 = dispositivo('gpu0', primera.preparar, primera.porActor, 0.25);
  const gpu1 = dispositivo('gpu1', segunda.preparar, segunda.porActor, 0.35);
  const puente = new PuentePercepcion(cpu.percibidor, [gpu0, gpu1], true, { porCoste: true, reloj: () => ahora });
  function lanzar(actores: number) {
    const slots = Int32Array.from({ length: actores }, (_, i) => actores - i);
    const lote = { tick: 7, despacho: ++despacho, slots, plan: new Uint16Array(actores) };
    puente.lanzar(lote, planes);
    const resultado = puente.esperar(2000);
    assert.equal(resultado.tick, lote.tick);
    assert.equal(resultado.despacho, lote.despacho);
    assert.deepEqual(resultado.celda, slots);
    return puente.ultimosLotes.map(l => l.dispositivo);
  }
  function estabilizar(actores: number) {
    for (let i = 0; i < 24; i++) lanzar(actores);
    return lanzar(actores);
  }
  return { lanzar, estabilizar, gpu0, gpu1 };
}

test('la selección residente usa el coste de pared y cambia de ruta según la carga', () => {
  const prueba = banco();
  assert.deepEqual(prueba.lanzar(32), ['cpu'], 'la referencia inicial es CPU');
  assert.deepEqual(prueba.estabilizar(32), ['cpu'], 'preparar y transferir no compensa en un lote pequeño');
  assert.deepEqual(prueba.estabilizar(256), ['gpu0'], 'preparar la segunda tarjeta alarga el despacho');
  assert.deepEqual(prueba.estabilizar(4096), ['gpu0', 'gpu1'], 'ambas acortan el despacho grande');
  assert.deepEqual(prueba.lanzar(32), ['cpu'], 'conserva la medida anterior de la banda pequeña');
  prueba.gpu1.percibidor.rancia = true;
  assert.deepEqual(prueba.lanzar(4096), ['gpu0', 'cpu'], 'recalcula solo el tramo rancio');
});

test('la selección admite la segunda tarjeta sola y recupera una respuesta de otro despacho en CPU', () => {
  const prueba = banco({ preparar: 3, porActor: 0.004 }, { preparar: 0.5, porActor: 0.003 });
  assert.deepEqual(prueba.estabilizar(256), ['gpu1']);
  prueba.gpu1.percibidor.rancia = true;
  assert.deepEqual(prueba.lanzar(256), ['cpu']);
  assert.equal(prueba.gpu1.cerrados, 1);
  assert.equal(prueba.gpu0.cerrados, 0);
  assert.deepEqual(prueba.lanzar(256), ['gpu0']);
});
