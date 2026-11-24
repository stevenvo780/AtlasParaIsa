import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { INDICE_CINTA, rutaSegmento } from '../src/server/cinta/catalogo.js';
import { decodificarBloque } from '../src/server/cinta/formato.js';
import type { MirrorUpdate, SimReply, SimRpc, SimWorkerOptions } from '../src/server/sim-worker.js';
import { enlaceCinta, type DescriptorEnlace } from '../src/shared/fotograma.js';
import { CINTA } from '../src/shared/cinta.js';
import { parseParams } from '../src/world/params.js';

type Mensaje = MirrorUpdate | SimReply | { type: 'ready' }
  | { type: 'barrera'; tick: number }
  | { type: 'fallo-inyectado'; tick: number }
  | { type: 'carga-desde-disco'; tick: number; slot: number }
  | { type: 'enlace-de-prueba'; enlace?: DescriptorEnlace }
  | { type: 'log'; level: string; value: { cinta?: string; motivo?: string } };

function iniciarSimulacion(t: TestContext, extra: Partial<SimWorkerOptions> = {}) {
  const temporal = '/tmp/atlas-v23-c1a';
  mkdirSync(temporal, { recursive: true });
  const directorio = mkdtempSync(join(temporal, 'recarga-'));
  const worldPath = join(directorio, 'world.sqlite');
  const cinta = join(directorio, 'cinta');
  const control = new Int32Array(new SharedArrayBuffer(12));
  const armarFallo = () => { Atomics.store(control, 0, 1); };
  const bloquearCinta = () => { Atomics.store(control, 1, 1); };
  const cintaBloqueada = () => Atomics.load(control, 2) === 1;
  function liberarCinta() { Atomics.store(control, 1, 0); Atomics.notify(control, 1); }
  const options: SimWorkerOptions = { worldPath, seed: 51926, turbo: true, tape: true, turboSaveIntervalMs: 0,
    params: parseParams('motor.hilos=1,motor.gpu=[],persistencia.cadaTicks=10000'), ...extra };
  const worker = new Worker(`
    const hilos = require('node:worker_threads');
    const { parentPort, workerData, Worker: WorkerReal } = hilos;
    (async () => {
      (await import(workerData.loaderURL)).register();
      hilos.Worker = class extends WorkerReal {
        constructor(codigo, opciones) {
          if (opciones?.name !== 'carta-tape') { super(codigo, opciones); return; }
          const interceptar = () => {
            const { parentPort, workerData } = require('node:worker_threads');
            const control = new Int32Array(workerData.controlPrueba);
            // Retiene al consumidor antes de atender el mensaje, una vez que el worker está listo.
            const escuchar = parentPort.on;
            parentPort.on = function (evento, callback) {
              if (evento !== 'message') return escuchar.call(this, evento, callback);
              return escuchar.call(this, evento, function (mensaje) {
                if (Atomics.load(control, 1) === 1) {
                  Atomics.store(control, 2, 1);
                  Atomics.wait(control, 1, 1);
                  Atomics.store(control, 2, 0);
                }
                return callback.call(this, mensaje);
              });
            };
          };
          super('(' + interceptar.toString() + ')();\\n' + codigo,
            { ...opciones, workerData: { ...opciones.workerData, controlPrueba: workerData.control } });
          parentPort.postMessage({ type: 'enlace-de-prueba', enlace: opciones.workerData.descriptor });
        }
      };
      require('node:module').syncBuiltinESMExports();
      const { Store } = await import(workerData.storeURL);
      const control = new Int32Array(workerData.control);
      // La barrera ocurre dentro del paso, una vez incrementado el tick y tocado el mundo vivo.
      const getContexto = Object.getOwnPropertyDescriptor(Store.prototype, 'context').get;
      Object.defineProperty(Store.prototype, 'context', { get() {
        return { ...getContexto.call(this), ecologyExecution: { onBarrier({ tick, phase }) {
          if (phase !== 'ecologia') return;
          if (Atomics.exchange(control, 0, 0) === 1) {
            parentPort.postMessage({ type: 'fallo-inyectado', tick });
            throw new Error('Fallo de prueba dentro de la barrera ecológica.');
          }
          parentPort.postMessage({ type: 'barrera', tick });
        } } };
      } });
      const cargar = Store.prototype.load;
      Store.prototype.load = function () {
        const resultado = cargar.call(this);
        if (resultado) parentPort.postMessage({ type: 'carga-desde-disco', tick: resultado.world.tick, slot: resultado.slot });
        return resultado;
      };
      await import(workerData.moduleURL);
    })().catch(error => { setImmediate(() => { throw error; }); });
  `, { eval: true, execArgv: [], workerData: { role: 'carta-sim', options, control: control.buffer,
    loaderURL: import.meta.resolve('tsx/esm/api'), storeURL: new URL('../src/server/store.ts', import.meta.url).href,
    moduleURL: new URL('../src/server/sim-worker.ts', import.meta.url).href } });
  const mensajes = on(worker, 'message', { signal: t.signal, close: ['exit'] });
  const salida = once(worker, 'exit');
  void salida.catch(() => undefined);
  t.after(async () => {
    liberarCinta();
    try { await worker.terminate(); }
    finally { rmSync(directorio, { recursive: true, force: true }); }
  });

  async function esperar<T extends Mensaje['type']>(tipo: T, aceptar: (m: Extract<Mensaje, { type: T }>) => boolean = () => true) {
    while (true) {
      const siguiente = await mensajes.next();
      assert.ok(!siguiente.done, `El worker terminó esperando ${tipo}.`);
      const [mensaje] = siguiente.value as [Mensaje];
      if (mensaje.type === tipo) {
        const m = mensaje as Extract<Mensaje, { type: T }>;
        if (aceptar(m)) return m;
      }
    }
  }
  let ultimoRPC = 0;
  async function pedir(method: string) {
    const id = ++ultimoRPC;
    worker.postMessage({ type: 'rpc', id, method, args: [] } satisfies SimRpc);
    const respuesta = await esperar('reply', mensaje => mensaje.id === id);
    assert.equal(respuesta.error, undefined, respuesta.error?.message);
    return respuesta.value;
  }
  return { cinta, armarFallo, bloquearCinta, cintaBloqueada, liberarCinta, esperar, pedir, salida };
}

test('la recarga real del guardado en carta-sim bifurca la cinta y vuelve a grabar los ticks', async t => {
  const { cinta, armarFallo, esperar, pedir, salida } = iniciarSimulacion(t);
  await esperar('ready');
  await pedir('start');
  await esperar('barrera', m => m.tick >= 20);
  const anterior = await pedir('flushTape') as { enabled: boolean; latestTick: number };
  assert.equal(anterior.enabled, true);
  assert.ok(anterior.latestTick > 0, 'la rama anterior tiene un tramo confirmado');

  armarFallo();
  const fallo = await esperar('fallo-inyectado');
  assert.ok(fallo.tick > anterior.latestTick);
  const recarga = await esperar('carga-desde-disco');
  assert.equal(recarga.slot, 0);
  assert.equal(recarga.tick, 0, 'el Store devolvió el guardado que precede al tramo confirmado');
  const espejo = await esperar('mirror', m => m.salud.recargas === 1);
  assert.ok(!espejo.failed);
  await esperar('barrera', m => m.tick >= fallo.tick + 30);
  const posterior = await pedir('flushTape') as { enabled: boolean; latestTick: number };
  assert.equal(posterior.enabled, true);
  assert.ok(posterior.latestTick >= anterior.latestTick);
  await pedir('shutdown');
  assert.deepEqual(await salida, [0]);

  const db = new DatabaseSync(join(cinta, INDICE_CINTA), { readOnly: true });
  try {
    const epocas = db.prepare('SELECT id,tMundo,visibleHasta FROM epocas ORDER BY id').all();
    assert.equal(epocas.length, 2);
    const [original, nueva] = epocas;
    assert.equal(original!.visibleHasta, recarga.tick);
    assert.equal(nueva!.tMundo, recarga.tick);
    assert.equal(nueva!.visibleHasta, null);
    const bifurcacion = db.prepare('SELECT desde,hasta,motivo FROM bifurcaciones WHERE epoca=?').get(original!.id!);
    assert.equal(bifurcacion?.desde, recarga.tick);
    assert.equal(bifurcacion?.motivo, 'reinicio');
    assert.ok(Number(bifurcacion?.hasta) >= anterior.latestTick);
    const hitos = db.prepare('SELECT cuerpo FROM hitos WHERE epoca=? ORDER BY t,tipo').all(nueva!.id!)
      .map(row => JSON.parse(String(row.cuerpo)) as import('../src/shared/cinta.js').Hito);
    assert.ok(hitos.some(h => h.tipo === 'bifurcacion' && h.bifurcacion.epoca === original!.id));
    assert.ok(hitos.some(h => h.tipo === 'suceso' && h.suceso.kind === 'pause' && h.t === recarga.tick));
    const primeroNuevo = db.prepare('SELECT nivel,MIN(t0) AS primero FROM bloques WHERE epoca=? GROUP BY nivel ORDER BY nivel').all(nueva!.id!);
    assert.deepEqual(primeroNuevo.map(row => [row.nivel, row.primero]), [0, 1, 2, 3, 4].map(nivel => [nivel, recarga.tick]));
    const horizonte = db.prepare('SELECT epoca,MAX(t1) AS ultimo FROM bloques WHERE nivel=0 GROUP BY epoca ORDER BY epoca').all();
    assert.equal(horizonte.length, 2);
    assert.ok(Number(horizonte[0]!.ultimo) >= anterior.latestTick, 'el tramo confirmado sigue legible en su época');
    assert.ok(Number(horizonte[1]!.ultimo) >= anterior.latestTick, 'la nueva época vuelve a cubrir los ticks de la anterior');
    const descartado = db.prepare('SELECT segmento,offset,bytes FROM bloques WHERE nivel=0 AND epoca=? AND t1>=? ORDER BY t1 LIMIT 1')
      .get(original!.id!, anterior.latestTick)!;
    const desde = Number(descartado.offset);
    const bloque = decodificarBloque(readFileSync(rutaSegmento(cinta, 0, Number(descartado.segmento)))
      .subarray(desde, desde + Number(descartado.bytes)));
    assert.ok(bloque.t1 >= anterior.latestTick, 'el bloque confirmado de la bifurcación aún pasa la verificación');
    const serie = db.prepare('SELECT t,nacimientos,muertes FROM serie WHERE epoca=? ORDER BY t LIMIT 1').get(nueva!.id!);
    assert.deepEqual(serie && { ...serie }, { t: recarga.tick, nacimientos: 0, muertes: 0 });
  } finally { db.close(); }
});

test('el motor da más pasos cuando carta-tape está detenido y agotó todos sus créditos', async t => {
  const { cinta, bloquearCinta, cintaBloqueada, liberarCinta, esperar, pedir, salida } = iniciarSimulacion(t);
  const { enlace } = await esperar('enlace-de-prueba');
  assert.ok(enlace, 'la simulación comparte el control de crédito con carta-tape');
  const { creditos } = enlaceCinta(enlace);
  await esperar('ready');
  await pedir('flushTape');
  assert.ok(Atomics.load(creditos, 0) > 0, 'el arranque devolvió el crédito de su primer corte');
  bloquearCinta();
  await pedir('start');
  const lleno = await esperar('barrera', () => cintaBloqueada() && Atomics.load(creditos, 0) === 0);
  const posterior = await esperar('barrera', m => m.tick >= lleno.tick + 50);
  assert.ok(cintaBloqueada(), 'el sumidero seguía detenido al avanzar el reloj');
  assert.equal(Atomics.load(creditos, 0), 0);
  assert.equal(posterior.tick - lleno.tick, 50);
  const tSerie = (Math.floor(lleno.tick / CINTA.seriePaso) + 1) * CINTA.seriePaso;
  await esperar('barrera', m => m.tick > tSerie);
  assert.equal(Atomics.load(creditos, 0), 0);
  liberarCinta();
  const confirmado = await pedir('flushTape') as { enabled: boolean; latestTick: number };
  assert.equal(confirmado.enabled, true);
  assert.ok(confirmado.latestTick > 0, 'la cinta se recupera al liberarle el consumidor');
  await pedir('shutdown');
  assert.deepEqual(await salida, [0]);
  const db = new DatabaseSync(join(cinta, INDICE_CINTA), { readOnly: true });
  try { assert.ok(db.prepare('SELECT 1 FROM serie WHERE t=?').get(tSerie), 'la serie conserva el tick sin crédito visual'); }
  finally { db.close(); }
});

test('una cinta que no devuelve crédito se da por perdida sin detener el motor', async t => {
  const { bloquearCinta, cintaBloqueada, esperar, pedir, salida } = iniciarSimulacion(t, { tapeSinCreditoMs: 1500 });
  const { enlace } = await esperar('enlace-de-prueba');
  const { creditos } = enlaceCinta(enlace!);
  await esperar('ready');
  await pedir('flushTape');
  bloquearCinta();
  await pedir('start');
  const lleno = await esperar('barrera', () => cintaBloqueada() && Atomics.load(creditos, 0) === 0);
  const aviso = await Promise.race([esperar('log', m => m.value.cinta === 'detenida'),
    setTimeout(60_000).then(() => assert.fail('La simulación no dio por perdida la cinta detenida.'))]);
  assert.match(aviso.value.motivo ?? '', /no devolvió ningún corte en 2 s/);
  const posterior = await esperar('barrera', m => m.tick >= lleno.tick + 50);
  assert.ok(posterior.tick > lleno.tick);
  await pedir('shutdown');
  assert.deepEqual(await salida, [0]);
});
