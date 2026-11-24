import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { threadId, Worker } from 'node:worker_threads';
import {
  BARRIER_HEADER, WORKER_CELL, ERROR_CHARACTERS, PLAZO_BARRERA_MS, createBarrier,
  workerCell, waitForBarrier, readWorkerError, readSupervisorError, type SharedBarrier,
} from './barrera.js';
import { partitionRegions, type StaticRegion, type StaticRegionOrder } from './particion.js';

interface ModuloCalculo {
  moduleURL: string | URL;
  exportName: string;
}

type EjecutarFase = (fase: number) => void;

export interface OpcionesPiscina<Datos> extends ModuloCalculo {
  /** Cuenta al coordinador (dueño 0) entre los hilos de cálculo. */
  hilos: number;
  datos: Datos;
  /** El export indicado en moduleURL tiene esta misma firma. Cada hilo conserva su función entre fases. */
  crear(hilo: number, datos: Datos): EjecutarFase;
}

export interface DiagnosticoPiscina {
  hilos: number;
  threadIds: number[];
  fases: number;
  tiempoActivoMs: number[];
  tiempoTotalMs: number;
  esperaBarreraMs: number;
  fatal: boolean;
}

export class ErrorFatalMotor extends Error {
  constructor(motivo: unknown) {
    const mensaje = motivo instanceof Error ? motivo.message : String(motivo);
    // recuperarPaso identifica una piscina caída por este prefijo.
    super(`StaticWorkerPool abortado: ${mensaje}`, { cause: motivo });
    this.name = 'ErrorFatalMotor';
  }
}

export interface StaticWorkerPoolOptions extends ModuloCalculo {
  workers: number;
}

export interface StaticWorkerJob<Params = unknown> {
  regions: readonly StaticRegion[];
  buffers: Record<string, SharedArrayBuffer>;
  params: Params;
  /** Campos de los llamadores anteriores a V23 que se retiran con M2 y M3. */
  orden?: StaticRegionOrder;
  retardoMs?: number;
}

export interface StaticWorkerHandlerJob<Params = unknown> extends StaticWorkerJob<Params> {
  workerIndex: number;
}

export interface StaticWorkerDiagnostics {
  workers: number;
  threadIds: number[];
  dispatches: number;
  completedJobs: number[];
  supervisorThreadId: number;
  sourceLoader: boolean;
  regionOrder: (number | string)[][];
  adversarialDelaysMs: number[];
  adversarialDelayCounts: number[];
  ocupacionWorkers: number;
  tiempoActivoWorkersMs: number[];
  tiempoParaleloMs: number;
  tiempoBarreraMs: number;
}

/** T151: aceleración teórica de Amdahl para una fracción serial en [0,1]. */
export function aceleracionAmdahlTeorica(fraccionSerial: number, hilos: number): number {
  if (!Number.isFinite(fraccionSerial) || fraccionSerial < 0 || fraccionSerial > 1) throw new RangeError('fraccionSerial debe estar en [0,1].');
  if (!Number.isSafeInteger(hilos) || hilos < 1) throw new RangeError('hilos debe ser un entero positivo.');
  if (hilos === 1 || fraccionSerial === 1) return 1;
  if (fraccionSerial === 0) return hilos;
  return 1 / (fraccionSerial + (1 - fraccionSerial) / hilos);
}

export function calcularOcupacionWorkers(tiemposActivosMs: readonly number[], wallMs: number): number {
  if (!Number.isFinite(wallMs) || wallMs <= 0 || tiemposActivosMs.length === 0) return 0;
  let suma = 0;
  for (const ms of tiemposActivosMs) suma += Number.isFinite(ms) && ms > 0 ? ms : 0;
  return Math.max(0, Math.min(1, suma / (tiemposActivosMs.length * wallMs)));
}

export function calcularFraccionSerialReal(tiempoSerialMs: number, tiempoParaleloMs: number, hilos: number, dispositivosGpu = 0): number {
  if (!Number.isFinite(tiempoSerialMs) || !Number.isFinite(tiempoParaleloMs)) throw new RangeError('Los tiempos de la fracción serial deben ser finitos.');
  if (hilos <= 1 && dispositivosGpu <= 0) return 1;
  const serial = Math.max(0, tiempoSerialMs), paralelo = Math.max(0, tiempoParaleloMs), total = serial + paralelo;
  if (total <= 0 || paralelo <= 0) return 1;
  return Math.max(0, Math.min(1, serial / total));
}

// El supervisor puede procesar error/exit aunque el coordinador esté bloqueado en Atomics.wait.
const WORKER_BOOTSTRAP = String.raw`
const { Worker, parentPort, workerData, threadId } = require('node:worker_threads');
const { header: H, cells: C, errorCharacters: E } = workerData.layout;
const control = new Int32Array(workerData.control), errors = new Uint16Array(workerData.errors);
const cell = (index, field) => H.cells + index * C.cells + field;
const wake = () => { Atomics.add(control, H.wake, 1); Atomics.notify(control, H.wake, 1); };
function writeError(index, error) {
  const text = (error instanceof Error ? error.stack || error.message : String(error)) || 'Error sin mensaje';
  const message = text.slice(0, E - 1), start = index * E;
  for (let i = 0; i < message.length; i++) errors[start + i] = message.charCodeAt(i);
  errors[start + message.length] = 0;
  if (index < workerData.workers) Atomics.store(control, cell(index, C.errorLength), message.length);
}
function fatal(index, error) {
  writeError(index, error);
  Atomics.store(control, H.fatal, 1);
  wake();
}
if (workerData.index === undefined) {
  const children = [];
  let stopping = false;
  function stop(error) {
    if (stopping) return;
    stopping = true;
    if (error) fatal(workerData.workers, error);
    void Promise.all(children.map(child => child.terminate())).then(() => {
      Atomics.store(control, H.quiesced, 1);
      wake();
      parentPort.close();
    });
  }
  process.on('uncaughtException', stop);
  process.on('unhandledRejection', stop);
  Atomics.store(control, H.supervisorThreadId, threadId);
  try {
    for (let index = 0; index < workerData.workers; index++) {
      const child = new Worker(workerData.bootstrap, {
        eval: true, execArgv: [], name: 'atlas-compute-' + index,
        workerData: { ...workerData, index, bootstrap: undefined },
      });
      children.push(child);
      child.on('message', () => stop());
      child.on('error', stop);
      child.on('exit', code => stop(new Error('Worker ' + index + ' salió inesperadamente (código ' + code + ').')));
    }
    parentPort.on('message', message => {
      if (message === 'close') { stop(); return; }
      if (stopping) return;
      try {
        for (let index = 0; index < children.length; index++) {
          children[index].postMessage({ regions: message.queues[index], buffers: message.buffers, params: message.params });
        }
      } catch (error) { stop(error); }
    });
  } catch (error) { stop(error); }
} else {
  const index = workerData.index;
  let failed = false;
  function fail(error) {
    if (failed) return;
    failed = true;
    fatal(index, error);
    parentPort.postMessage('fatal');
  }
  function finish(start) {
    Atomics.store(control, cell(index, C.activoUs), Math.round((performance.now() - start) * 1000));
    Atomics.add(control, cell(index, C.completed), 1);
    Atomics.sub(control, H.pending, 1);
    wake();
  }
  function ready() {
    Atomics.store(control, cell(index, C.threadId), threadId);
    Atomics.add(control, H.ready, 1);
    wake();
  }
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  (async () => {
    if (workerData.loaderURL) (await import(workerData.loaderURL)).register();
    const handler = (await import(workerData.moduleURL))[workerData.exportName];
    if (typeof handler !== 'function') throw new TypeError('El export de cálculo no es una función: ' + workerData.exportName);
    if (!workerData.compartida) {
      parentPort.on('message', async job => {
        if (failed) return;
        const start = performance.now();
        try { await handler({ ...job, workerIndex: index }); }
        catch (error) { writeError(index, error); }
        if (!failed) finish(start);
      });
      ready();
      return;
    }
    const ejecutar = handler(index + 1, workerData.compartida.datos);
    if (typeof ejecutar !== 'function') throw new TypeError('La fábrica de cálculo debe devolver una función.');
    let epoca = 0;
    ready();
    while (!Atomics.load(control, H.fatal)) {
      const nueva = Atomics.load(control, H.epoch);
      if (nueva === epoca) {
        Atomics.wait(control, H.epoch, epoca);
        continue;
      }
      epoca = nueva;
      const start = performance.now();
      const resultado = ejecutar(Atomics.load(control, H.phase));
      if (resultado?.then) throw new TypeError('La fase de cálculo debe ser síncrona.');
      finish(start);
    }
  })().catch(fail);
}
`;

interface DespachoAnterior {
  queues: StaticRegion[][];
  buffers: Record<string, SharedArrayBuffer>;
  params: unknown;
}

class HilosPersistentes {
  readonly #barrier: SharedBarrier;
  readonly #supervisor: Worker;
  readonly #exit: Promise<void>;
  readonly sourceLoader = new URL(import.meta.url).pathname.endsWith('.ts');
  #cerrada = false;
  #ejecutando = false;
  #fallo: ErrorFatalMotor | undefined;
  #errorSupervisor: Error | undefined;
  readonly workers: number;
  despachos = 0;
  tiempoTotalMs = 0;
  esperaBarreraMs = 0;
  tiempoLocalMs = 0;

  constructor(opciones: StaticWorkerPoolOptions, compartida?: { datos: unknown }) {
    if (!Number.isSafeInteger(opciones.workers) || opciones.workers < 1) throw new RangeError('workers debe ser un entero positivo.');
    if (!opciones.exportName) throw new TypeError('exportName no puede estar vacío.');
    this.workers = opciones.workers;
    this.#barrier = createBarrier(this.workers);
    let moduleURL = new URL(opciones.moduleURL).href;
    if (this.sourceLoader && moduleURL.startsWith('file:') && moduleURL.endsWith('.js')) {
      const sourceURL = moduleURL.slice(0, -3) + '.ts';
      if (!existsSync(fileURLToPath(moduleURL)) && existsSync(fileURLToPath(sourceURL))) moduleURL = sourceURL;
    }
    const { control, errors } = this.#barrier;
    this.#supervisor = new Worker(WORKER_BOOTSTRAP, {
      eval: true, execArgv: [], name: 'atlas-supervisor',
      workerData: {
        workers: this.workers, moduleURL, exportName: opciones.exportName, compartida,
        loaderURL: this.sourceLoader ? import.meta.resolve('tsx/esm/api') : undefined,
        control: control.buffer, errors: errors.buffer,
        layout: { header: BARRIER_HEADER, cells: WORKER_CELL, errorCharacters: ERROR_CHARACTERS },
        bootstrap: WORKER_BOOTSTRAP,
      },
    });
    this.#supervisor.on('error', error => { this.#errorSupervisor = error; });
    this.#exit = new Promise(resolve => {
      this.#supervisor.once('exit', code => {
        if (!Atomics.load(control, BARRIER_HEADER.quiesced)) {
          this.#errorSupervisor ??= new Error(`Supervisor salió inesperadamente (código ${code}).`);
        }
        resolve();
      });
    });
    this.#supervisor.unref();
    this.#esperar(() => Atomics.load(control, BARRIER_HEADER.ready) === this.workers);
  }

  get fatal(): boolean {
    return this.#fallo !== undefined || this.#errorSupervisor !== undefined
      || Atomics.load(this.#barrier.control, BARRIER_HEADER.fatal) !== 0;
  }

  #abortar(causa?: unknown): never {
    if (!this.#fallo) {
      const { control } = this.#barrier;
      Atomics.store(control, BARRIER_HEADER.fatal, 1);
      void this.cerrar();
      // Si también cayó el supervisor, el servidor debe salir aunque no pueda confirmar el cierre.
      waitForBarrier(control, () => Atomics.load(control, BARRIER_HEADER.quiesced) !== 0, 1000);
      const errores = Array.from({ length: this.workers }, (_, index) => readWorkerError(this.#barrier, index)).filter(Boolean);
      const supervisor = readSupervisorError(this.#barrier, this.workers);
      if (supervisor) errores.push(supervisor);
      this.#fallo = new ErrorFatalMotor(causa ?? this.#errorSupervisor ?? (errores.join('\n') || 'fallo fatal de worker'));
    }
    throw this.#fallo;
  }

  #esperar(terminado: () => boolean): void {
    if (!waitForBarrier(this.#barrier.control, () => this.fatal || this.#cerrada || terminado())) {
      this.#abortar(new Error(`Barrera vencida tras ${PLAZO_BARRERA_MS / 1000} s sin avance.`));
    }
    if (this.fatal || this.#cerrada) this.#abortar();
  }

  ejecutar(despacho: DespachoAnterior | number, local?: EjecutarFase): void {
    if (this.fatal) this.#abortar();
    if (this.#cerrada) throw new Error('Piscina cerrada.');
    if (this.#ejecutando) throw new Error('La piscina no admite fases superpuestas.');
    this.#ejecutando = true;
    const { control } = this.#barrier;
    const inicio = performance.now();
    Atomics.store(control, BARRIER_HEADER.pending, this.workers);
    try {
      if (typeof despacho === 'number') {
        Atomics.store(control, BARRIER_HEADER.phase, despacho);
        Atomics.add(control, BARRIER_HEADER.epoch, 1);
        Atomics.notify(control, BARRIER_HEADER.epoch);
        this.despachos++;
        try { local!(despacho); }
        catch (error) { this.#abortar(error); }
        this.tiempoLocalMs = performance.now() - inicio;
      } else {
        for (let i = 0; i < this.workers; i++) Atomics.store(control, workerCell(i, WORKER_CELL.errorLength), 0);
        this.#supervisor.postMessage(despacho);
        this.despachos++;
      }
      const inicioEspera = performance.now();
      this.#esperar(() => Atomics.load(control, BARRIER_HEADER.pending) === 0);
      this.esperaBarreraMs = Math.max(0, performance.now() - inicioEspera);
      this.tiempoTotalMs = Math.max(0, performance.now() - inicio);
      if (typeof despacho !== 'number') {
        for (let index = 0; index < this.workers; index++) {
          const error = readWorkerError(this.#barrier, index);
          if (error) throw new Error(`Worker ${index}: ${error}`);
        }
      }
    } finally {
      this.#ejecutando = false;
    }
  }

  leerHilos(campo: number): number[] {
    return Array.from({ length: this.workers }, (_, index) => Atomics.load(this.#barrier.control, workerCell(index, campo)));
  }

  get supervisorThreadId(): number { return Atomics.load(this.#barrier.control, BARRIER_HEADER.supervisorThreadId); }

  cerrar(): Promise<void> {
    if (!this.#cerrada) {
      this.#cerrada = true;
      this.#supervisor.ref();
      this.#supervisor.postMessage('close');
    }
    return this.#exit;
  }
}

function ejecutarSincrono(ejecutar: EjecutarFase, fase: number): void {
  const resultado: unknown = ejecutar(fase);
  if (resultado && typeof (resultado as PromiseLike<unknown>).then === 'function') {
    throw new TypeError('La fase de cálculo debe ser síncrona.');
  }
}

/** Una misma piscina para todas las fases. Los datos del despacho viajan por SAB. */
export class Piscina<Datos = unknown> {
  readonly #equipo: HilosPersistentes | null;
  readonly #local: EjecutarFase;
  readonly #hilos: number;
  #cerrada = false;
  #ejecutando = false;
  #fallo: ErrorFatalMotor | undefined;
  #fases = 0;
  #tiempoLocalMs = 0;

  constructor(opciones: OpcionesPiscina<Datos>) {
    const { hilos, crear, datos } = opciones;
    if (!Number.isSafeInteger(hilos) || hilos < 1) throw new RangeError('hilos debe ser un entero positivo.');
    this.#hilos = hilos;
    try {
      const ejecutar = crear(0, datos);
      if (typeof ejecutar !== 'function') throw new TypeError('La fábrica de cálculo debe devolver una función.');
      this.#local = fase => ejecutarSincrono(ejecutar, fase);
      this.#equipo = hilos === 1 ? null : new HilosPersistentes({ ...opciones, workers: hilos - 1 }, { datos });
    } catch (error) {
      throw error instanceof ErrorFatalMotor ? error : new ErrorFatalMotor(error);
    }
  }

  ejecutar(fase: number): void {
    if (this.#fallo) throw this.#fallo;
    if (this.#cerrada) throw new Error('Piscina cerrada.');
    if (this.#ejecutando) throw new Error('La piscina no admite fases superpuestas.');
    if (!Number.isInteger(fase) || fase !== (fase | 0)) throw new RangeError('La fase debe ser un entero de 32 bits.');
    this.#ejecutando = true;
    this.#fases++;
    try {
      if (this.#equipo) {
        this.#equipo.ejecutar(fase, this.#local);
      } else {
        const inicio = performance.now();
        this.#local(fase);
        this.#tiempoLocalMs = performance.now() - inicio;
      }
    } catch (error) {
      this.#fallo = error instanceof ErrorFatalMotor ? error : new ErrorFatalMotor(error);
      throw this.#fallo;
    } finally {
      this.#ejecutando = false;
    }
  }

  diagnostico(): DiagnosticoPiscina {
    const equipo = this.#equipo;
    return {
      hilos: this.#hilos,
      fases: this.#fases,
      threadIds: equipo ? [threadId, ...equipo.leerHilos(WORKER_CELL.threadId)] : [threadId],
      tiempoActivoMs: equipo
        ? [equipo.tiempoLocalMs, ...equipo.leerHilos(WORKER_CELL.activoUs).map(us => us / 1000)] : [this.#tiempoLocalMs],
      tiempoTotalMs: equipo?.tiempoTotalMs ?? this.#tiempoLocalMs,
      esperaBarreraMs: equipo?.esperaBarreraMs ?? 0,
      fatal: this.#fallo !== undefined || (equipo?.fatal ?? false),
    };
  }

  cerrar(): Promise<void> {
    if (this.#ejecutando) throw new Error('La piscina todavía está ejecutando una fase.');
    this.#cerrada = true;
    return this.#equipo?.cerrar() ?? Promise.resolve();
  }
}

/** Adaptación de los núcleos anteriores mientras M2 y M3 los conectan a Piscina. */
export class StaticWorkerPool {
  readonly #equipo: HilosPersistentes;

  constructor(options: StaticWorkerPoolOptions) {
    this.#equipo = new HilosPersistentes(options);
  }

  run<Params>(job: StaticWorkerJob<Params>): void {
    for (const [name, buffer] of Object.entries(job.buffers)) {
      if (!(buffer instanceof SharedArrayBuffer)) throw new TypeError(`El buffer ${name} requiere SharedArrayBuffer.`);
    }
    const queues = partitionRegions(job.regions, this.#equipo.workers);
    this.#equipo.ejecutar({ queues, buffers: job.buffers, params: job.params });
  }

  diagnostics(): StaticWorkerDiagnostics {
    const equipo = this.#equipo;
    const tiempoActivoWorkersMs = equipo.leerHilos(WORKER_CELL.activoUs).map(us => us / 1000);
    return {
      workers: equipo.workers,
      threadIds: equipo.leerHilos(WORKER_CELL.threadId),
      dispatches: equipo.despachos,
      completedJobs: equipo.leerHilos(WORKER_CELL.completed),
      supervisorThreadId: equipo.supervisorThreadId,
      sourceLoader: equipo.sourceLoader,
      regionOrder: [],
      adversarialDelaysMs: [],
      adversarialDelayCounts: [],
      ocupacionWorkers: calcularOcupacionWorkers(tiempoActivoWorkersMs, equipo.tiempoTotalMs),
      tiempoActivoWorkersMs,
      tiempoParaleloMs: equipo.tiempoTotalMs,
      tiempoBarreraMs: Math.max(0, equipo.tiempoTotalMs - Math.max(0, ...tiempoActivoWorkersMs)),
    };
  }

  close(): Promise<void> { return this.#equipo.cerrar(); }
}
