import { existsSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { ChronicleJournal } from '../world/chronicle-journal.js';
import { materializarCorteTransferido, type AcuseCorteTransferido, type CapturaCorteTransferido, type CorteTransferido,
  type IdentidadCorteTransferido } from '../world/motor/corte-transferido.js';
import { Store, type StoreOptions } from './store.js';

type OpcionesDisco = Pick<StoreOptions, 'snapshotPackedPeople' | 'snapshotCompressedPeople' | 'snapshotSplitPeopleWeights'>;

export type GuardadoConfirmado = AcuseCorteTransferido & { readonly cronica: ChronicleJournal };

/** El hilo perdió el acuse después de recibir el corte. El disco debe decidir desde dónde reanudar. */
class GuardadoIndeterminado extends Error {
  constructor(cause: Error) {
    super('El hilo de guardado no pudo confirmar el resultado del corte.', { cause });
    this.name = 'GuardadoIndeterminado';
  }
}

export interface OpcionesPersistidor extends OpcionesDisco {
  path: string;
  onProgress?: () => void;
}

type OrdenGuardado = { tipo: 'guardar'; corte: CorteTransferido; solapado: boolean } | { tipo: 'cerrar' };
type RespuestaGuardado = { tipo: 'listo' | 'avance' | 'cerrado' }
  | { tipo: 'confirmado'; guardado: GuardadoConfirmado }
  | { tipo: 'rechazado'; identidad: IdentidadCorteTransferido; mensaje: string };

function identidadDe({ solicitud, epoca, tick, eventCounter }: IdentidadCorteTransferido): IdentidadCorteTransferido {
  return { solicitud, epoca, tick, eventCounter };
}

function mismoCorte(a: IdentidadCorteTransferido, b: IdentidadCorteTransferido): boolean {
  return a.solicitud === b.solicitud && a.epoca === b.epoca && a.tick === b.tick && a.eventCounter === b.eventCounter;
}

interface Pendiente {
  identidad: IdentidadCorteTransferido;
  fin: Promise<GuardadoConfirmado>;
  resolver: (guardado: GuardadoConfirmado) => void;
  rechazar: (error: Error) => void;
  enviado: boolean;
}

export class PersistidorGuardado {
  private readonly ready: Promise<void>;
  private readonly hilo: Worker;
  private readonly salida: Promise<void>;
  private listo = false;
  private pendiente?: Pendiente;
  private fallo?: Error;
  private cierre?: Promise<void>;
  private cierrePedido = false;
  private cierreConfirmado = false;

  constructor({ path, onProgress, ...options }: OpcionesPersistidor) {
    if (path === ':memory:' || !existsSync(path)) throw new Error('El persistidor necesita un archivo de mundo inicializado.');
    let moduleURL = new URL('./guardado-worker.js', import.meta.url);
    const sourceLoader = new URL(import.meta.url).pathname.endsWith('.ts');
    if (sourceLoader && !existsSync(moduleURL)) moduleURL = new URL('./guardado-worker.ts', import.meta.url);
    this.hilo = new Worker(`
      const { workerData } = require('node:worker_threads');
      (async () => {
        if (workerData.loaderURL) (await import(workerData.loaderURL)).register();
        await import(workerData.moduleURL);
      })().catch(error => { setImmediate(() => { throw error; }); });
    `, { eval: true, execArgv: [], name: 'carta-guardado', workerData: {
      role: 'carta-guardado', moduleURL: moduleURL.href,
      loaderURL: sourceLoader ? import.meta.resolve('tsx/esm/api') : undefined,
      path, options,
    } });

    let resolverInicio!: () => void;
    let rechazarInicio!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { resolverInicio = resolve; rechazarInicio = reject; });
    void this.ready.catch(() => undefined);
    const fallar = (error: Error) => { rechazarInicio(error); this.fallar(error); };
    this.salida = new Promise(resolve => this.hilo.once('exit', codigo => {
      if (!this.cierreConfirmado || codigo !== 0) fallar(new Error(`El hilo de guardado terminó con código ${codigo}.`));
      resolve();
    }));
    this.hilo.on('error', fallar);
    this.hilo.on('messageerror', fallar);
    this.hilo.on('message', (mensaje: RespuestaGuardado) => {
      try {
        switch (mensaje.tipo) {
          case 'listo':
            if (this.listo || this.fallo) throw new Error('El hilo de guardado se anunció fuera de orden.');
            this.listo = true;
            resolverInicio();
            return;
          case 'avance':
            try { onProgress?.(); } catch { /* La telemetría no participa en el guardado. */ }
            return;
          case 'cerrado':
            if (!this.cierrePedido || this.cierreConfirmado) throw new Error('El hilo de guardado cerró fuera de orden.');
            this.cierreConfirmado = true;
            return;
          case 'confirmado':
            this.tomarPendiente(mensaje.guardado).resolver(mensaje.guardado);
            return;
          case 'rechazado':
            this.tomarPendiente(mensaje.identidad).rechazar(new Error(mensaje.mensaje));
            return;
          default:
            throw new Error('El hilo de guardado envió una respuesta desconocida.');
        }
      } catch (error) {
        fallar(error instanceof Error ? error : new Error('El hilo de guardado envió una respuesta inválida.'));
      }
    });
  }

  guardar(captura: CapturaCorteTransferido, solapado = false): Promise<GuardadoConfirmado> {
    if (this.fallo) return Promise.reject(this.fallo);
    if (this.cierre || this.pendiente) return Promise.reject(new Error('El persistidor está cerrando o ya tiene un corte.'));
    if (solapado && !captura.admiteSolape) return Promise.reject(new Error('El corte no admite solapamiento.'));
    const { corte, transferibles } = captura;
    let resolver!: Pendiente['resolver'];
    let rechazar!: Pendiente['rechazar'];
    const fin = new Promise<GuardadoConfirmado>((resolve, reject) => { resolver = resolve; rechazar = reject; });
    const pendiente = { identidad: identidadDe(corte), fin, resolver, rechazar, enviado: false };
    this.pendiente = pendiente;
    void this.ready.then(() => {
      if (this.pendiente !== pendiente) return;
      this.hilo.postMessage({ tipo: 'guardar', corte, solapado } satisfies OrdenGuardado, transferibles);
      pendiente.enviado = true;
    }).catch(error => {
      if (this.pendiente !== pendiente) return;
      this.pendiente = undefined;
      pendiente.rechazar(error);
    });
    return fin;
  }

  cerrar(): Promise<void> {
    return this.cierre ??= this.cerrarHilo();
  }

  private tomarPendiente(identidad: IdentidadCorteTransferido): Pendiente {
    const pendiente = this.pendiente;
    if (!pendiente?.enviado || !mismoCorte(identidad, pendiente.identidad))
      throw new Error('El hilo de guardado respondió por un corte distinto del solicitado.');
    this.pendiente = undefined;
    return pendiente;
  }

  private fallar(error: Error): void {
    if (this.fallo) return;
    const pendiente = this.pendiente;
    this.fallo = pendiente?.enviado ? new GuardadoIndeterminado(error) : error;
    this.pendiente = undefined;
    pendiente?.rechazar(this.fallo);
    void this.hilo.terminate().catch(() => undefined);
  }

  private async cerrarHilo(): Promise<void> {
    try {
      await this.ready;
      // El solicitante recibe por separado el resultado del guardado ya enviado.
      await this.pendiente?.fin.catch(() => undefined);
      if (this.fallo) throw this.fallo;
      this.cierrePedido = true;
      this.hilo.postMessage({ tipo: 'cerrar' } satisfies OrdenGuardado);
    } catch (error) {
      this.fallar(error instanceof Error ? error : new Error('No se pudo cerrar el hilo de guardado.'));
    }
    await this.salida;
    if (this.fallo) throw this.fallo;
  }
}

function abrirPersistidor(path: string, options: OpcionesDisco): void {
  const puerto = parentPort!;
  const responder = (mensaje: RespuestaGuardado) => puerto.postMessage(mensaje);
  let ultimoAvance = -Infinity;
  const store = new Store(path, { ...options, onProgress: () => {
    const ahora = performance.now();
    if (ahora - ultimoAvance < 1000) return;
    ultimoAvance = ahora;
    responder({ tipo: 'avance' });
  } });
  puerto.on('messageerror', error => { throw error; });
  puerto.on('message', (orden: OrdenGuardado) => {
    switch (orden.tipo) {
      case 'cerrar':
        store.close();
        responder({ tipo: 'cerrado' });
        puerto.close();
        return;
      case 'guardar':
        ultimoAvance = -Infinity;
        responder(guardar(store, orden.corte, orden.solapado));
        return;
      default:
        throw new Error('Orden desconocida en el hilo de guardado.');
    }
  });
  responder({ tipo: 'listo' });
}

function guardar(store: Store, corte: CorteTransferido, solapado: boolean): RespuestaGuardado {
  const identidad = identidadDe(corte);
  const confirmaciones = store.confirmacionesDeGuardado;
  try {
    const { sello, tecnologiaRemotaEquivalente, bajas } = materializarCorteTransferido(corte, store.context, solapado);
    const { world } = solapado ? store.guardarCorteSolapado(sello, corte.epoca) : store.guardarCorteSellado(sello, [], []);
    if (!world.chronicleJournal) throw new Error('El corte confirmado carece de crónica.');
    return { tipo: 'confirmado', guardado: {
      ...identidad, guardadoEn: Date.now(), snapshotBytes: store.lastSnapshotBytes, cronica: world.chronicleJournal,
      historia: world.history, tecnologia: world.technology, tecnologiaRemotaEquivalente, bajas,
    } };
  } catch (error) {
    if (store.confirmacionesDeGuardado !== confirmaciones || store.db.isTransaction) throw error;
    return { tipo: 'rechazado', identidad,
      mensaje: error instanceof Error ? error.message : 'No se pudo guardar el corte.' };
  }
}

if (!isMainThread && workerData?.role === 'carta-guardado') abrirPersistidor(workerData.path, workerData.options);
