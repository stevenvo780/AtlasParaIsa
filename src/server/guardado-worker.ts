import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { ChronicleJournal } from '../world/chronicle-journal.js';
import { abrirLectorBasePesos, type DescriptorBasePesosCorte, type PublicadorBasePesos } from '../world/motor/base-pesos-corte.js';
import { materializarCorteTransferido, type AcuseCorteTransferido, type CapturaCorteTransferido, type CorteTransferido,
  type IdentidadCorteTransferido } from '../world/motor/corte-transferido.js';
import { RechazoBasePesosError, type BasePesosActiva } from '../world/motor/personas-corte.js';
import { Store, type FaseGuardado, type PruebaCabezaGuardada, type StoreOptions } from './store.js';

type OpcionesDisco = Pick<StoreOptions, 'snapshotPackedPeople' | 'snapshotCompressedPeople' | 'snapshotSplitPeopleWeights'>;

interface TiempoPersistidor {
  paredMs: number;
  cpuMs: number | null;
}

type FasesPersistidor = Partial<Record<FaseGuardado, TiempoPersistidor>>;

interface AfinidadPersistidor {
  afinidad: string | null;
  tid: number | null;
}

export interface PerfilPersistidor extends AfinidadPersistidor {
  materializar: TiempoPersistidor;
  guardar: TiempoPersistidor;
  /** Intervalos consecutivos dentro de guardar, disponibles si se solicita el desglose. */
  fases?: FasesPersistidor;
  /** Disponible cuando se habilita la prueba de la cabeza inicial. */
  cabezaInicialReutilizada?: boolean;
  /** Diagnóstico del uso de la base F64 compartida cuando `basePesosCorte` está activa. */
  personasRef?: number;
  personasFull?: number;
  bytesPesos?: number;
  basePesosPublicada?: boolean;
}

export type GuardadoConfirmado = AcuseCorteTransferido & {
  readonly cronica: ChronicleJournal;
  readonly perfilPersistidor: PerfilPersistidor;
  /** Descriptor clonable de la base F64 publicada en SAB tras confirmar el COMMIT. */
  readonly basePesos?: DescriptorBasePesosCorte;
};

/** El escritor rechazó el corte porque alguna referencia F64 ya no corresponde a la base publicada vigente. */
export class RechazoBasePesosGuardadoError extends Error {
  readonly baseRechazada = true;
  constructor(message: string) {
    super(message);
    this.name = 'RechazoBasePesosGuardadoError';
  }
}

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
  cpuPersistidor?: number;
  perfilarFases?: boolean;
  probarCabeza?: () => PruebaCabezaGuardada | undefined;
  /** Laboratorio: publica una base F64 compartida en SAB desde WGP1 tras cada COMMIT (apagada por defecto). */
  basePesosCorte?: boolean;
}

interface OpcionesHilo extends Omit<OpcionesPersistidor, 'path' | 'onProgress' | 'probarCabeza'> {
  probarCabeza: boolean;
}

type OrdenGuardar = { tipo: 'guardar'; corte: CorteTransferido; solapado: boolean; pruebaCabeza?: PruebaCabezaGuardada };
type OrdenGuardado = OrdenGuardar | { tipo: 'revocarBase' } | { tipo: 'cerrar' };
type RespuestaGuardado = { tipo: 'listo'; solicitaPruebaCabeza?: boolean }
  | { tipo: 'avance' | 'cerrado' }
  | { tipo: 'confirmado'; guardado: GuardadoConfirmado }
  | { tipo: 'rechazado'; identidad: IdentidadCorteTransferido; mensaje: string; baseRechazada?: boolean };

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
  private probarCabeza: OpcionesPersistidor['probarCabeza'];

  constructor({ path, onProgress, probarCabeza, ...options }: OpcionesPersistidor) {
    if (path === ':memory:' || !existsSync(path)) throw new Error('El persistidor necesita un archivo de mundo inicializado.');
    if (options.cpuPersistidor !== undefined && (!Number.isSafeInteger(options.cpuPersistidor) || options.cpuPersistidor < 0))
      throw new RangeError('La CPU del persistidor debe ser un entero no negativo.');
    let moduleURL = new URL('./guardado-worker.js', import.meta.url);
    const sourceLoader = new URL(import.meta.url).pathname.endsWith('.ts');
    if (sourceLoader && !existsSync(moduleURL)) moduleURL = new URL('./guardado-worker.ts', import.meta.url);
    this.probarCabeza = probarCabeza;
    this.hilo = new Worker(`
      const { workerData } = require('node:worker_threads');
      (async () => {
        if (workerData.loaderURL) (await import(workerData.loaderURL)).register();
        await import(workerData.moduleURL);
      })().catch(error => { setImmediate(() => { throw error; }); });
    `, { eval: true, execArgv: [], name: 'carta-guardado', workerData: {
      role: 'carta-guardado', moduleURL: moduleURL.href,
      loaderURL: sourceLoader ? import.meta.resolve('tsx/esm/api') : undefined,
      path, options: { ...options, probarCabeza: probarCabeza !== undefined } satisfies OpcionesHilo,
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
            if (!mensaje.solicitaPruebaCabeza) this.probarCabeza = undefined;
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
            this.tomarPendiente(mensaje.identidad).rechazar(
              mensaje.baseRechazada ? new RechazoBasePesosGuardadoError(mensaje.mensaje) : new Error(mensaje.mensaje),
            );
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
      const probarCabeza = this.probarCabeza;
      this.probarCabeza = undefined;
      let pruebaCabeza: PruebaCabezaGuardada | undefined;
      if (probarCabeza) {
        // Comprueba el descriptor aparte, antes de entregar los buffers del corte.
        try { pruebaCabeza = structuredClone(probarCabeza()); }
        catch { /* El guardado conserva su verificación completa sin la prueba. */ }
      }
      this.hilo.postMessage({ tipo: 'guardar', corte, solapado,
        ...(pruebaCabeza !== undefined && { pruebaCabeza }) } satisfies OrdenGuardado, transferibles);
      pendiente.enviado = true;
    }).catch(error => {
      if (this.pendiente !== pendiente) return;
      this.pendiente = undefined;
      pendiente.rechazar(error);
    });
    return fin;
  }

  /** Revoca la base F64 publicada en el escritor (p. ej. al cambiar de época o escribir fuera del hilo). */
  revocarBasePesos(): void {
    if (this.fallo || this.cierre || this.cierrePedido) return;
    if (this.listo) {
      this.hilo.postMessage({ tipo: 'revocarBase' } satisfies OrdenGuardado);
      return;
    }
    void this.ready.then(() => {
      if (this.fallo || this.cierre || this.cierrePedido) return;
      this.hilo.postMessage({ tipo: 'revocarBase' } satisfies OrdenGuardado);
    }).catch(() => undefined);
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
    this.probarCabeza = undefined;
    pendiente?.rechazar(this.fallo);
    void this.hilo.terminate().catch(() => undefined);
  }

  private async cerrarHilo(): Promise<void> {
    try {
      await this.ready;
      // El solicitante recibe por separado el resultado del guardado ya enviado.
      await this.pendiente?.fin.catch(() => undefined);
      this.probarCabeza = undefined;
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

function fijarAfinidad(cpu: number | undefined): AfinidadPersistidor {
  if (process.platform !== 'linux') {
    if (cpu !== undefined) throw new Error('La afinidad del persistidor requiere Linux.');
    return { tid: null, afinidad: null };
  }
  let tid: number | null = null;
  try {
    // Worker.threadId identifica el worker en Node. taskset necesita el TID de Linux.
    const enlace = readlinkSync('/proc/thread-self');
    const id = Number(/(?:^|\/)task\/([1-9]\d*)$/.exec(enlace)?.[1]);
    if (!Number.isSafeInteger(id)) throw new Error('No se pudo identificar el hilo del persistidor en /proc.');
    tid = id;
    if (cpu !== undefined) {
      const resultado = spawnSync('taskset', ['-pc', String(cpu), String(tid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (resultado.error) throw resultado.error;
      if (resultado.status !== 0)
        throw new Error(resultado.stderr?.trim() || `taskset terminó con ${resultado.signal ?? resultado.status}.`);
    }
    const estado = readFileSync('/proc/thread-self/status', 'utf8');
    const afinidad = /^Cpus_allowed_list:[ \t]*(\S+)$/m.exec(estado)?.[1] ?? null;
    if (cpu !== undefined && afinidad !== String(cpu))
      throw new Error(`La máscara efectiva del hilo es ${afinidad ?? 'desconocida'}.`);
    return { tid, afinidad };
  } catch (error) {
    if (cpu !== undefined) {
      const detalle = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo fijar el persistidor a la CPU ${cpu}. ${detalle}`, { cause: error });
    }
    return { tid, afinidad: null };
  }
}

function cpuDelHilo(inicio?: NodeJS.CpuUsage): NodeJS.CpuUsage | undefined {
  try { return process.threadCpuUsage?.(inicio); } catch { return undefined; }
}

function medirTramo<T>(ejecutar: () => T): { valor: T; tiempo: TiempoPersistidor } {
  const cpuInicio = cpuDelHilo();
  const paredInicio = performance.now();
  const valor = ejecutar();
  const paredMs = performance.now() - paredInicio;
  const gasto = cpuInicio && cpuDelHilo(cpuInicio);
  return { valor, tiempo: { paredMs, cpuMs: gasto ? (gasto.user + gasto.system) / 1000 : null } };
}

function medirFasesGuardado(fases: FasesPersistidor): (fase: FaseGuardado) => void {
  let paredAnterior = performance.now();
  let cpuAnterior = cpuDelHilo();
  return fase => {
    const pared = performance.now();
    const cpu = cpuDelHilo();
    fases[fase] = {
      paredMs: pared - paredAnterior,
      cpuMs: cpu && cpuAnterior ? (cpu.user - cpuAnterior.user + cpu.system - cpuAnterior.system) / 1000 : null,
    };
    paredAnterior = pared;
    cpuAnterior = cpu;
  };
}

interface EstadoBasePesos {
  readonly instancia: string;
  secuencia: number;
  activa?: {
    readonly publicador: PublicadorBasePesos;
    readonly activa: BasePesosActiva;
  };
}

function revocarEstadoBase(estado: EstadoBasePesos): void {
  const previa = estado.activa;
  estado.activa = undefined;
  previa?.publicador.revocar();
}

function abrirPersistidor(
  path: string,
  { cpuPersistidor, perfilarFases = false, probarCabeza, basePesosCorte = false, ...options }: OpcionesHilo,
): void {
  const puerto = parentPort!;
  const responder = (mensaje: RespuestaGuardado) => puerto.postMessage(mensaje);
  const afinidad = fijarAfinidad(cpuPersistidor);
  let ultimoAvance = -Infinity;
  const store = new Store(path, { ...options, onProgress: () => {
    const ahora = performance.now();
    if (ahora - ultimoAvance < 1000) return;
    ultimoAvance = ahora;
    responder({ tipo: 'avance' });
  } });
  const estadoBase: EstadoBasePesos = { instancia: randomUUID(), secuencia: 0 };
  let solicitaPruebaCabeza = probarCabeza && store.anclarPruebaCabeza();
  puerto.on('messageerror', error => { throw error; });
  puerto.on('message', (orden: OrdenGuardado) => {
    switch (orden.tipo) {
      case 'revocarBase':
        revocarEstadoBase(estadoBase);
        return;
      case 'cerrar':
        revocarEstadoBase(estadoBase);
        store.close();
        responder({ tipo: 'cerrado' });
        puerto.close();
        return;
      case 'guardar': {
        ultimoAvance = -Infinity;
        const primerCorteConAncla = solicitaPruebaCabeza;
        solicitaPruebaCabeza = false;
        responder(guardar(store, orden, afinidad, perfilarFases, probarCabeza, primerCorteConAncla, basePesosCorte, estadoBase));
        return;
      }
      default:
        throw new Error('Orden desconocida en el hilo de guardado.');
    }
  });
  responder({ tipo: 'listo', ...(solicitaPruebaCabeza && { solicitaPruebaCabeza }) });
}

function guardar(store: Store, { corte, solapado, pruebaCabeza }: OrdenGuardar, afinidad: AfinidadPersistidor,
  perfilarFases: boolean, probarCabeza: boolean, primerCorteConAncla: boolean,
  basePesosCorte: boolean, estadoBase: EstadoBasePesos): RespuestaGuardado {
  const identidad = identidadDe(corte);
  const confirmaciones = store.confirmacionesDeGuardado;
  try {
    if (estadoBase.activa && estadoBase.activa.activa.contexto.epoca !== corte.epoca) {
      revocarEstadoBase(estadoBase);
    }
    if (primerCorteConAncla) store.ofrecerPruebaCabeza(pruebaCabeza);
    const baseActiva = basePesosCorte ? estadoBase.activa?.activa : undefined;
    const materializado = medirTramo(() => materializarCorteTransferido(corte, store.context, solapado, baseActiva));
    const { sello, tecnologiaRemotaEquivalente, bajas, diagnosticoPersonasCorte } = materializado.valor;
    const fases: FasesPersistidor | undefined = perfilarFases ? {} : undefined;
    const guardado = medirTramo(() => {
      const cerrarFase = fases && medirFasesGuardado(fases);
      return solapado ? store.guardarCorteSolapado(sello, corte.epoca, cerrarFase)
        : store.guardarCorteSellado(sello, [], [], undefined, cerrarFase);
    });
    const { world } = guardado.valor;
    if (!world.chronicleJournal) throw new Error('El corte confirmado carece de crónica.');
    let basePesos: DescriptorBasePesosCorte | undefined;
    if (basePesosCorte && store.ultimoDigestGuardado !== undefined) {
      try {
        const siguienteSecuencia = estadoBase.secuencia + 1;
        const nuevoPublicador = store.construirBasePesosDurable(
          estadoBase.instancia, corte.epoca, siguienteSecuencia, store.ultimoDigestGuardado,
        );
        if (nuevoPublicador) {
          const descriptor = nuevoPublicador.publicarTrasAcuse({
            ...nuevoPublicador.identidad,
            confirmado: true,
          });
          const lector = abrirLectorBasePesos(descriptor);
          estadoBase.secuencia = siguienteSecuencia;
          const anterior = estadoBase.activa;
          estadoBase.activa = {
            publicador: nuevoPublicador,
            activa: {
              lector,
              contexto: {
                instancia: descriptor.instancia,
                epoca: descriptor.epoca,
                secuencia: descriptor.secuencia,
                publicacion: descriptor.publicacion,
              },
            },
          };
          anterior?.publicador.revocar();
          basePesos = descriptor;
        } else {
          revocarEstadoBase(estadoBase);
        }
      } catch {
        // El COMMIT ya es durable: un fallo al construir la base compartida no revierte el guardado.
        revocarEstadoBase(estadoBase);
      }
    }
    return { tipo: 'confirmado', guardado: {
      ...identidad, guardadoEn: Date.now(), snapshotBytes: store.lastSnapshotBytes, cronica: world.chronicleJournal,
      historia: world.history, tecnologia: world.technology, tecnologiaRemotaEquivalente, bajas,
      ...(basePesos && { basePesos }),
      perfilPersistidor: { ...afinidad, materializar: materializado.tiempo, guardar: guardado.tiempo, ...(fases && { fases }),
        ...(probarCabeza && { cabezaInicialReutilizada: primerCorteConAncla && store.reutilizoCabezaInicial }),
        ...(basePesosCorte && {
          personasRef: diagnosticoPersonasCorte?.personasRef ?? 0,
          personasFull: diagnosticoPersonasCorte?.personasFull ?? 0,
          bytesPesos: diagnosticoPersonasCorte?.bytesPesos ?? 0,
          basePesosPublicada: basePesos !== undefined,
        }) },
    } };
  } catch (error) {
    if (store.confirmacionesDeGuardado !== confirmaciones || store.db.isTransaction) throw error;
    if (primerCorteConAncla) store.ofrecerPruebaCabeza(undefined);
    const baseRechazada = error instanceof RechazoBasePesosError;
    if (baseRechazada) revocarEstadoBase(estadoBase);
    return { tipo: 'rechazado', identidad,
      mensaje: error instanceof Error ? error.message : 'No se pudo guardar el corte.',
      ...(baseRechazada && { baseRechazada: true }) };
  }
}

if (!isMainThread && workerData?.role === 'carta-guardado') abrirPersistidor(workerData.path, workerData.options);
