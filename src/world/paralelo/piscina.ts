import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BARRIER_HEADER, WORKER_CELL, WORKER_STATUS, ERROR_CHARACTERS, createBarrier,
  workerCell, waitForBarrier, readWorkerError, readSupervisorError, type SharedBarrier,
} from './barrera.js';
import { partitionRegions, type StaticRegion, type StaticRegionOrder } from './particion.js';

export interface StaticWorkerPoolOptions {
  workers: number;
  moduleURL: string | URL;
  exportName: string;
}

export interface StaticWorkerJob<Params = unknown> {
  regions: readonly StaticRegion[];
  buffers: Record<string, SharedArrayBuffer>;
  params: Params;
  orden?: StaticRegionOrder;
  /** Espera física entre regiones en adversarial; por defecto 1 ms. */
  retardoMs?: number;
}

/** Natural: una llamada por cola. Inverso/adversarial: una llamada por región de la cola. */
export interface StaticWorkerHandlerJob<Params = unknown> extends StaticWorkerJob<Params> {
  workerIndex: number;
}

export interface StaticWorkerDiagnostics {
  workers: number;
  threadIds: number[];
  dispatches: number;
  /** Despachos terminados por trabajador, incluidos los que comunican un throw controlado. */
  completedJobs: number[];
  supervisorThreadId: number;
  sourceLoader: boolean;
  /** IDs de llamadas por región observadas en el último despacho; natural no las instrumenta. */
  regionOrder: (number | string)[][];
  /** Duración monotónica acumulada de esperas reales del último despacho, por trabajador. */
  adversarialDelaysMs: number[];
  /** Número de Atomics.wait realmente ejecutados entre regiones del último despacho. */
  adversarialDelayCounts: number[];
}

interface DispatchObservation {
  queues: StaticRegion[][];
  offsets: number[];
  counts: Int32Array<SharedArrayBuffer>;
  order: Int32Array<SharedArrayBuffer>;
  delays: Float64Array<SharedArrayBuffer>;
}

// Bootstrap autocontenido: también funciona desde dist/server sin copiar un .mjs auxiliar.
// El supervisor mantiene libre SU event loop mientras el coordinador espera en Atomics.wait.
// Sus eventos error/exit de los hijos se convierten en fatal + quiesced dentro del SAB.
const WORKER_BOOTSTRAP = String.raw`
const { Worker, parentPort, workerData, threadId } = require('node:worker_threads');
let H, C, S, E, control, errors;
const children = [];
let stopping = false, stopPromise, computeFatal = false;
// Guards antes de inicializar el protocolo o crear/importar hijos. No dependen del event loop del main.
function fail(error) {
  if (workerData.role === 'compute') {
    if (computeFatal) return;
    computeFatal = true;
    markFatal(workerData.workerIndex, error);
    parentPort.postMessage({ type: 'fatal', workerIndex: workerData.workerIndex });
  } else {
    void stopAll(error);
  }
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const cell = (index, field) => H.cells + index * C.cells + field;
const wake = () => { Atomics.add(control, H.wake, 1); Atomics.notify(control, H.wake); };
const messageOf = error => error instanceof Error ? (error.stack || error.message) : String(error);
function writeError(index, error) {
  const message = messageOf(error).slice(0, E - 1), start = index * E;
  for (let i = 0; i < message.length; i++) errors[start + i] = message.charCodeAt(i);
  errors[start + message.length] = 0;
  if (index < workerData.workers) Atomics.store(control, cell(index, C.errorLength), message.length);
}
function markFatal(index, error) {
  writeError(index, error);
  if (index < workerData.workers) Atomics.store(control, cell(index, C.status), S.fatal);
  Atomics.store(control, H.fatal, 1);
  wake();
}
function stopAll(error) {
  if (error) markFatal(workerData.workers, error);
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    await Promise.all(children.map(child => child.terminate()));
    // Ningún trabajador puede escribir scratch después de esta publicación.
    Atomics.store(control, H.quiesced, 1);
    Atomics.store(control, H.closed, 1);
    wake();
    parentPort.close();
  })();
  return stopPromise;
}

try {
({ header: H, cells: C, status: S, errorCharacters: E } = workerData.layout);
control = new Int32Array(workerData.control);
errors = new Uint16Array(workerData.errors);
if (workerData.role === 'compute') {
  const index = workerData.workerIndex;
  // Este SAB privado no se comparte con el mundo ni puede recibir notificaciones de otro hilo.
  const delayClock = new Int32Array(new SharedArrayBuffer(4));
  const { performance } = require('node:perf_hooks');
  let handler, busy = false;
  (async () => {
    // Sólo los imports desde el árbol TS necesitan el loader de desarrollo.
    if (workerData.loaderURL) {
      const loader = await import(workerData.loaderURL);
      loader.register();
    }
    const module = await import(workerData.moduleURL);
    handler = module[workerData.exportName];
    if (typeof handler !== 'function') throw new TypeError('El export de cálculo no es una función: ' + workerData.exportName);
    parentPort.on('message', async job => {
      if (computeFatal) return;
      if (busy || job.epoch !== Atomics.load(control, H.epoch)) {
        fail(new Error('Despacho superpuesto o época inválida.'));
        return;
      }
      busy = true;
      let outcome = S.done;
      try {
        // No se copian los buffers: los halos y la salida pertenecen a los mismos SAB.
        if (job.orden === 'natural') {
          await handler({ regions: job.regions, buffers: job.buffers, params: job.params, workerIndex: index });
        } else {
          const counts = new Int32Array(job.observation.counts);
          const order = new Int32Array(job.observation.order);
          const delays = new Float64Array(job.observation.delays);
          for (let ordinal = 0; ordinal < job.regions.length; ordinal++) {
            if (ordinal > 0 && job.orden === 'adversarial') {
              const start = performance.now();
              Atomics.wait(delayClock, 0, 0, job.retardoMs);
              delays[index] += performance.now() - start;
              Atomics.add(counts, workerData.workers + index, 1);
            }
            // Sólo se publica una observación al invocar realmente ese rango del handler.
            Atomics.store(order, job.observation.offset + ordinal, ordinal);
            Atomics.add(counts, index, 1);
            await handler({ regions: [job.regions[ordinal]], buffers: job.buffers, params: job.params, workerIndex: index });
          }
        }
      } catch (error) {
        writeError(index, error);
        outcome = S.jobError;
      }
      busy = false;
      if (computeFatal) return;
      Atomics.add(control, cell(index, C.completed), 1);
      Atomics.store(control, cell(index, C.status), outcome);
      wake();
    });
    Atomics.store(control, cell(index, C.threadId), threadId);
    Atomics.store(control, cell(index, C.status), S.ready);
    Atomics.add(control, H.ready, 1);
    wake();
  })().catch(fail);
} else {
  Atomics.store(control, H.supervisorThreadId, threadId);
  try {
    for (let index = 0; index < workerData.workers; index++) {
      const child = new Worker(workerData.bootstrap, {
        eval: true, execArgv: [], name: 'atlas-static-compute-' + index,
        workerData: { ...workerData, role: 'compute', workerIndex: index, bootstrap: undefined },
      });
      children.push(child);
      child.on('message', message => {
        if (message.type === 'fatal') fail(new Error('Fallo fatal en worker ' + index));
      });
      child.on('error', error => { markFatal(index, error); fail(error); });
      child.on('exit', code => {
        if (!stopping) {
          const error = new Error('Worker ' + index + ' salió inesperadamente (código ' + code + ').');
          markFatal(index, error);
          fail(error);
        }
      });
    }
    parentPort.on('message', message => {
      if (message.type === 'close') { void stopAll(); return; }
      if (stopping || Atomics.load(control, H.fatal)) { fail(new Error('El pool ya está abortado.')); return; }
      if (message.type !== 'run') { fail(new Error('Mensaje de control desconocido.')); return; }
      try {
        for (let index = 0; index < children.length; index++) {
          children[index].postMessage({
            epoch: message.epoch, regions: message.queues[index], buffers: message.buffers, params: message.params,
            orden: message.orden, retardoMs: message.retardoMs,
            observation: message.observation && { ...message.observation, offset: message.observation.offsets[index] },
          });
        }
      } catch (error) { fail(error); }
    });
  } catch (error) { fail(error); }
}
} catch (error) { fail(error); }
`;

/**
 * N trabajadores persistentes y un supervisor administrativo; run conserva stepWorld síncrono.
 * Los fallos JS del supervisor y error/exit de hijos se comunican por SAB tras detenerlos.
 * La muerte externa/native abrupta del supervisor no tiene garantía de despertar al main:
 * sus eventos de Worker necesitan el event loop bloqueado. No se simula quiescencia ni se
 * convierte un plazo de reloj en éxito del motor.
 */
export class StaticWorkerPool {
  readonly #workers: number;
  readonly #barrier: SharedBarrier;
  readonly #supervisor: Worker;
  readonly #exit: Promise<void>;
  readonly #sourceLoader: boolean;
  #dispatches = 0;
  #closed = false;
  #running = false;
  #supervisorFailure: Error | null = null;
  #supervisorExited = false;
  #observation: DispatchObservation | null = null;

  constructor(options: StaticWorkerPoolOptions) {
    if (!Number.isSafeInteger(options.workers) || options.workers < 1) throw new RangeError('workers debe ser un entero positivo.');
    if (!options.exportName) throw new TypeError('exportName no puede estar vacío.');
    this.#workers = options.workers;
    this.#barrier = createBarrier(options.workers);
    this.#sourceLoader = new URL(import.meta.url).pathname.endsWith('.ts');
    let moduleURL = new URL(options.moduleURL).href;
    if (this.#sourceLoader && moduleURL.startsWith('file:') && moduleURL.endsWith('.js')) {
      const sourceURL = moduleURL.slice(0, -3) + '.ts';
      if (!existsSync(fileURLToPath(moduleURL)) && existsSync(fileURLToPath(sourceURL))) moduleURL = sourceURL;
    }
    this.#supervisor = new Worker(WORKER_BOOTSTRAP, {
      eval: true, execArgv: [], name: 'atlas-static-supervisor',
      workerData: {
        role: 'supervisor', workers: this.#workers, moduleURL, exportName: options.exportName,
        loaderURL: this.#sourceLoader ? import.meta.resolve('tsx/esm/api') : undefined,
        control: this.#barrier.control.buffer, errors: this.#barrier.errors.buffer,
        layout: { header: BARRIER_HEADER, cells: WORKER_CELL, status: WORKER_STATUS, errorCharacters: ERROR_CHARACTERS },
        bootstrap: WORKER_BOOTSTRAP,
      },
    });
    // Respaldo diagnóstico cuando el main puede procesar eventos; no es el despertador de la barrera.
    this.#supervisor.on('error', error => { this.#supervisorFailure = error; });
    this.#exit = new Promise(resolve => {
      this.#supervisor.once('exit', code => {
        this.#supervisorExited = true;
        if (!Atomics.load(this.#barrier.control, BARRIER_HEADER.closed)) {
          this.#supervisorFailure ??= new Error(`Supervisor salió inesperadamente (código ${code}).`);
        }
        resolve();
      });
    });
    this.#supervisor.unref();
    waitForBarrier(this.#barrier.control, () => this.#fatalAndQuiesced()
      || Atomics.load(this.#barrier.control, BARRIER_HEADER.ready) === this.#workers);
    this.#throwIfFatal();
  }

  #fatalAndQuiesced(): boolean {
    const control = this.#barrier.control;
    return Atomics.load(control, BARRIER_HEADER.fatal) !== 0 && Atomics.load(control, BARRIER_HEADER.quiesced) !== 0;
  }

  #throwIfFatal(): void {
    if (this.#supervisorExited && this.#supervisorFailure) {
      throw new Error(`StaticWorkerPool abortado: ${this.#supervisorFailure.message}`);
    }
    if (!Atomics.load(this.#barrier.control, BARRIER_HEADER.fatal)) return;
    // Un fallo puede ocurrir entre despachos: drenar también en ese caso antes de entregar el error.
    waitForBarrier(this.#barrier.control, () => this.#fatalAndQuiesced());
    const errors = Array.from({ length: this.#workers }, (_, index) => readWorkerError(this.#barrier, index)).filter(Boolean);
    const supervisorError = readSupervisorError(this.#barrier, this.#workers);
    if (supervisorError) errors.push(supervisorError);
    throw new Error(`StaticWorkerPool abortado: ${errors.join('\n') || 'fallo fatal de worker'}`);
  }

  run<Params>(job: StaticWorkerJob<Params>): void {
    if (this.#closed) throw new Error('StaticWorkerPool cerrado.');
    if (this.#running) throw new Error('StaticWorkerPool no admite despachos superpuestos.');
    this.#throwIfFatal();
    const orden = job.orden ?? 'natural';
    const queues = partitionRegions(job.regions, this.#workers, orden);
    const retardoMs = job.retardoMs ?? 1;
    if (!Number.isFinite(retardoMs) || retardoMs < 0) {
      throw new RangeError('retardoMs debe ser finito y no negativo.');
    }
    for (const [name, buffer] of Object.entries(job.buffers)) {
      if (!(buffer instanceof SharedArrayBuffer)) throw new TypeError(`El buffer ${name} requiere SharedArrayBuffer.`);
    }
    let observation: DispatchObservation | null = null;
    if (orden !== 'natural') {
      let offset = 0;
      const offsets = queues.map(queue => { const start = offset; offset += queue.length; return start; });
      observation = {
        queues, offsets,
        counts: new Int32Array(new SharedArrayBuffer(this.#workers * 2 * 4)),
        order: new Int32Array(new SharedArrayBuffer(job.regions.length * 4)),
        delays: new Float64Array(new SharedArrayBuffer(this.#workers * 8)),
      };
    }
    this.#running = true;
    const control = this.#barrier.control;
    const epoch = (Atomics.load(control, BARRIER_HEADER.epoch) + 1) | 0;
    Atomics.store(control, BARRIER_HEADER.epoch, epoch);
    for (let index = 0; index < this.#workers; index++) {
      Atomics.store(control, workerCell(index, WORKER_CELL.errorLength), 0);
      Atomics.store(control, workerCell(index, WORKER_CELL.status), WORKER_STATUS.running);
    }
    try {
      try {
        this.#supervisor.postMessage({
          type: 'run', epoch, queues, buffers: job.buffers, params: job.params, orden, retardoMs,
          observation: observation && {
            offsets: observation.offsets, counts: observation.counts.buffer,
            order: observation.order.buffer, delays: observation.delays.buffer,
          },
        });
      } catch (error) {
        // structured-clone rechaza el mensaje entero antes de despacharlo: ningún hijo recibió trabajo.
        for (let index = 0; index < this.#workers; index++) {
          Atomics.store(control, workerCell(index, WORKER_CELL.status), WORKER_STATUS.ready);
        }
        throw error;
      }
      this.#observation = observation;
      this.#dispatches++;
      waitForBarrier(control, () => {
        if (Atomics.load(control, BARRIER_HEADER.fatal)) return this.#fatalAndQuiesced();
        for (let index = 0; index < this.#workers; index++) {
          const status = Atomics.load(control, workerCell(index, WORKER_CELL.status));
          if (status !== WORKER_STATUS.done && status !== WORKER_STATUS.jobError) return false;
        }
        return true;
      });
      this.#throwIfFatal();
      // Todos terminaron antes de comunicar un throw recuperable: no quedan escrituras tardías.
      for (let index = 0; index < this.#workers; index++) {
        if (Atomics.load(control, workerCell(index, WORKER_CELL.status)) === WORKER_STATUS.jobError) {
          throw new Error(`Worker ${index}: ${readWorkerError(this.#barrier, index)}`);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  diagnostics(): StaticWorkerDiagnostics {
    return {
      workers: this.#workers,
      threadIds: Array.from({ length: this.#workers }, (_, index) => Atomics.load(this.#barrier.control, workerCell(index, WORKER_CELL.threadId))),
      dispatches: this.#dispatches,
      completedJobs: Array.from({ length: this.#workers }, (_, index) => Atomics.load(this.#barrier.control, workerCell(index, WORKER_CELL.completed))),
      supervisorThreadId: Atomics.load(this.#barrier.control, BARRIER_HEADER.supervisorThreadId),
      sourceLoader: this.#sourceLoader,
      regionOrder: Array.from({ length: this.#workers }, (_, index) => {
        const observation = this.#observation;
        if (!observation) return [];
        const count = Atomics.load(observation.counts, index);
        return Array.from({ length: count }, (_, ordinal) => {
          const regionIndex = Atomics.load(observation.order, observation.offsets[index]! + ordinal);
          return observation.queues[index]![regionIndex]!.id;
        });
      }),
      adversarialDelaysMs: Array.from({ length: this.#workers }, (_, index) => this.#observation?.delays[index] ?? 0),
      adversarialDelayCounts: Array.from({ length: this.#workers }, (_, index) => this.#observation
        ? Atomics.load(this.#observation.counts, this.#workers + index) : 0),
    };
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      // Una Promise sola no mantiene vivo el event loop durante el cierre asíncrono.
      this.#supervisor.ref();
      if (!Atomics.load(this.#barrier.control, BARRIER_HEADER.closed)) this.#supervisor.postMessage({ type: 'close' });
    }
    return this.#exit;
  }
}
