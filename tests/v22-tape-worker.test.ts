import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { LectorCinta } from '../src/server/cinta/lector.js';
import { crearEnlaceCortes, type TapeWorkerMessage, type TapeWorkerReply, type TapeWorkerRequest } from '../src/server/tape-worker.js';
import type { ChunkResp, Corte } from '../src/shared/cinta.js';
import { enlaceCinta } from '../src/shared/fotograma.js';

function corte(seq: number, epoca: number, t: number, completo: boolean): Corte {
  return { seq, epoca, t, hz: 6, tilesCambiadas: completo ? 'todas' : [], hitos: [], catalogo: [],
    vista: { tick: t, sequence: t, version: 10, day: 1, phase: 'day', weather: 'clear', width: 1, height: 1,
      tiles: [], people: [], places: [], events: [], memories: [] },
    serie: { hz: 6, poblacion: 0, nacimientos: 0, muertes: 0, fauna: 0, estructuras: 0, sustancias: 0 } };
}

test('el hilo por puerto devuelve créditos, informa el fallo de escritura y acepta otra apertura', async t => {
  const raiz = '/tmp/atlas-v23-o-cinta';
  mkdirSync(raiz, { recursive: true });
  const directorio = mkdtempSync(join(raiz, 'hilo-'));
  const descriptor = crearEnlaceCortes(), enlace = enlaceCinta(descriptor);
  const creditos = Atomics.load(enlace.creditos, 0);
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    (async () => {
      (await import(workerData.loader)).register();
      await import(workerData.modulo);
    })().catch(error => setImmediate(() => { throw error; }));
  `, { eval: true, execArgv: [], workerData: { descriptor, options: { directorio }, role: 'carta-tape',
    loader: import.meta.resolve('tsx/esm/api'), modulo: new URL('../src/server/tape-worker.ts', import.meta.url).href } });
  const lector = new LectorCinta(directorio);
  t.after(async () => {
    await worker.terminate();
    lector.close();
    rmSync(directorio, { recursive: true, force: true });
  });

  const enviar = (m: TapeWorkerRequest) => worker.postMessage(m);
  const recibir = async (): Promise<TapeWorkerMessage> => (await once(worker, 'message'))[0];
  const abrir = (epoca: number, tMundo: number) => enviar({ type: 'abrir',
    apertura: { epoca, tMundo, instanciaId: 'puerto', motivo: 'reinicio' }, hitosPrevios: [] });
  const registrar = (c: Corte) => {
    Atomics.sub(enlace.creditos, 0, 1);
    Atomics.add(enlace.entregados, 0, 1n);
    enviar({ type: 'corte', corte: c });
  };
  const reply = async (id: number): Promise<TapeWorkerReply> => {
    const mensaje = await recibir();
    assert.equal(mensaje.type, 'reply');
    assert.equal(mensaje.id, id);
    return mensaje;
  };

  abrir(0, 0);
  assert.deepEqual(await recibir(), { type: 'estado', estado: 'ok', epoca: 0 });
  registrar(corte(1, 0, 0, true));
  enviar({ type: 'flush', id: 1 });
  assert.deepEqual(await reply(1), { type: 'reply', id: 1, frames: 1, latestTick: 0 });
  assert.equal(Atomics.load(enlace.creditos, 0), creditos);

  const pista = join(directorio, 'n0'), fuera = join(directorio, 'n0-fuera');
  renameSync(pista, fuera);
  const mensajes = new Promise<TapeWorkerMessage[]>(resolve => {
    const recibidos: TapeWorkerMessage[] = [];
    const escuchar = (mensaje: TapeWorkerMessage) => {
      recibidos.push(mensaje);
      if (mensaje.type === 'reply') { worker.off('message', escuchar); resolve(recibidos); }
    };
    worker.on('message', escuchar);
  });
  registrar(corte(2, 0, 4, false));
  enviar({ type: 'flush', id: 2 });
  const [estado, respuesta] = await mensajes;
  assert.ok(estado?.type === 'estado' && estado.estado === 'error' && !estado.reiniciarEnlace);
  assert.ok(respuesta?.type === 'reply' && respuesta.id === 2 && respuesta.error === estado.motivo);
  registrar(corte(3, 0, 8, false));
  enviar({ type: 'flush', id: 3 });
  assert.equal((await reply(3)).error, estado.motivo);
  assert.equal(Atomics.load(enlace.creditos, 0), creditos);

  renameSync(fuera, pista);
  abrir(1, 40);
  assert.deepEqual(await recibir(), { type: 'estado', estado: 'ok', epoca: 1 });
  registrar(corte(4, 1, 40, true));
  const salido = once(worker, 'exit');
  enviar({ type: 'close', id: 4 });
  assert.deepEqual(await reply(4), { type: 'reply', id: 4, frames: 1, latestTick: 40 });
  assert.deepEqual(await salido, [0]);
  assert.equal(Atomics.load(enlace.creditos, 0), creditos);

  assert.deepEqual(lector.meta().lagunas, [{ t0: 0, t1: 40 }]);
  const leer = (t: number): ChunkResp => JSON.parse(lector.chunk({ t, n: 1 }));
  assert.equal(leer(0).baseFrame?.tick, 0);
  assert.equal(leer(40).baseFrame?.tick, 40);
});
