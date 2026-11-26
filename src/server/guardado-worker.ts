import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { ChronicleJournal } from '../world/chronicle-journal.js';
import {
  abrirLectorBasePesos, abrirLectorReconstruccionBasePesos, ESTADO_BASE_PESOS, identidadBasePesosValida,
  mismaIdentidadBasePesos, type DescriptorBasePesosCorte, type IdentidadBasePesos, type LectorBasePesosCorte,
  type PublicadorBasePesos,
} from '../world/motor/base-pesos-corte.js';
import { materializarCorteTransferido, type AcuseCorteTransferido, type CapturaCorteTransferido, type CorteTransferido,
  type IdentidadCorteTransferido } from '../world/motor/corte-transferido.js';
import { inspeccionarReferenciasCorte, reconstruirCorteRemotoFull } from '../world/motor/mensajes-corte.js';
import { RechazoBasePesosError, type BasePesosActiva } from '../world/motor/personas-corte.js';
import { Store, type FaseGuardado, type PruebaCabezaGuardada, type StoreOptions } from './store.js';

type OpcionesDisco = Pick<StoreOptions, 'snapshotPackedPeople' | 'snapshotCompressedPeople' | 'snapshotSplitPeopleWeights'>;

const MAX_TICKETS_EN_VUELO = 2;

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
  ticketAutorizado?: boolean;
  reconstruidoFullPorRevocacion?: boolean;
  ticketsRetenidos?: number;
}

export interface ResultadoAutorizacionTicket {
  readonly autorizado: boolean;
  readonly tokenAutorizacion?: string;
  readonly motivo?: string;
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

type OrdenAutorizarTicket = {
  tipo: 'autorizarTicket';
  identidad: IdentidadCorteTransferido;
  baseIdentidad: IdentidadBasePesos;
};
type OrdenAbortarTicket = {
  tipo: 'abortarTicket';
  identidad: IdentidadCorteTransferido;
  tokenAutorizacion?: string;
};
type OrdenGuardar = {
  tipo: 'guardar';
  corte: CorteTransferido;
  solapado: boolean;
  pruebaCabeza?: PruebaCabezaGuardada;
  tokenAutorizacion?: string;
};
type OrdenGuardado = OrdenAutorizarTicket | OrdenAbortarTicket | OrdenGuardar | { tipo: 'revocarBase' } | { tipo: 'cerrar' };
type RespuestaGuardado = { tipo: 'listo'; solicitaPruebaCabeza?: boolean }
  | { tipo: 'avance' | 'cerrado' }
  | { tipo: 'ticketAutorizado'; identidad: IdentidadCorteTransferido; autorizado: boolean; tokenAutorizacion?: string; motivo?: string }
  | { tipo: 'confirmado'; guardado: GuardadoConfirmado }
  | { tipo: 'rechazado'; identidad: IdentidadCorteTransferido; mensaje: string; baseRechazada?: boolean };

function identidadDe({ solicitud, epoca, tick, eventCounter }: IdentidadCorteTransferido): IdentidadCorteTransferido {
  return { solicitud, epoca, tick, eventCounter };
}

function mismoCorte(a: IdentidadCorteTransferido, b: IdentidadCorteTransferido): boolean {
  return a.solicitud === b.solicitud && a.epoca === b.epoca && a.tick === b.tick && a.eventCounter === b.eventCounter;
}

function identidadCorteValida(id: unknown): id is IdentidadCorteTransferido {
  if (!id || typeof id !== 'object' || Array.isArray(id)) return false;
  const { solicitud, epoca, tick, eventCounter } = id as Partial<IdentidadCorteTransferido>;
  return typeof solicitud === 'bigint' && solicitud >= 0n
    && typeof epoca === 'number' && Number.isSafeInteger(epoca) && epoca >= 0
    && typeof tick === 'number' && Number.isSafeInteger(tick) && tick >= 0
    && typeof eventCounter === 'number' && Number.isSafeInteger(eventCounter) && eventCounter >= 0;
}

function claveTicket({ solicitud, epoca, tick, eventCounter }: IdentidadCorteTransferido): string {
  return `${solicitud.toString()}:${epoca}:${tick}:${eventCounter}`;
}

interface Pendiente {
  identidad: IdentidadCorteTransferido;
  fin: Promise<GuardadoConfirmado>;
  resolver: (guardado: GuardadoConfirmado) => void;
  rechazar: (error: Error) => void;
  enviado: boolean;
}

interface AutorizacionPendiente {
  identidad: IdentidadCorteTransferido;
  fin: Promise<ResultadoAutorizacionTicket>;
  resolver: (resultado: ResultadoAutorizacionTicket) => void;
  rechazar: (error: Error) => void;
}

export class PersistidorGuardado {
  private readonly ready: Promise<void>;
  private readonly hilo: Worker;
  private readonly salida: Promise<void>;
  private listo = false;
  private pendiente?: Pendiente;
  private autorizacionPendiente?: AutorizacionPendiente;
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
          case 'ticketAutorizado': {
            const autorizacion = this.autorizacionPendiente;
            if (!autorizacion || !mismoCorte(mensaje.identidad, autorizacion.identidad))
              throw new Error('El hilo de guardado respondió por un ticket distinto del solicitado.');
            this.autorizacionPendiente = undefined;
            autorizacion.resolver({
              autorizado: mensaje.autorizado,
              ...(mensaje.tokenAutorizacion !== undefined && { tokenAutorizacion: mensaje.tokenAutorizacion }),
              ...(mensaje.motivo !== undefined && { motivo: mensaje.motivo }),
            });
            return;
          }
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

  /** Autoriza y retiene en el escritor el lector/prueba para un ticket antes de desprender buffers o solapar. */
  autorizarTicket(
    identidad: IdentidadCorteTransferido,
    baseIdentidad: IdentidadBasePesos,
  ): Promise<ResultadoAutorizacionTicket> {
    if (this.fallo) return Promise.reject(this.fallo);
    if (this.cierre || this.cierrePedido || this.pendiente || this.autorizacionPendiente)
      return Promise.resolve({ autorizado: false, motivo: 'persistidor_ocupado' });
    const id = identidadDe(identidad);
    const base = { ...baseIdentidad };
    let resolver!: AutorizacionPendiente['resolver'];
    let rechazar!: AutorizacionPendiente['rechazar'];
    const fin = new Promise<ResultadoAutorizacionTicket>((resolve, reject) => { resolver = resolve; rechazar = reject; });
    const pendiente: AutorizacionPendiente = { identidad: id, fin, resolver, rechazar };
    this.autorizacionPendiente = pendiente;
    const enviar = () => {
      if (this.autorizacionPendiente !== pendiente) return;
      if (this.fallo || this.cierre || this.cierrePedido) {
        this.autorizacionPendiente = undefined;
        pendiente.resolver({ autorizado: false, motivo: 'persistidor_cerrando' });
        return;
      }
      this.hilo.postMessage({ tipo: 'autorizarTicket', identidad: id, baseIdentidad: base } satisfies OrdenGuardado);
    };
    if (this.listo) enviar();
    else void this.ready.then(enviar).catch(error => {
      if (this.autorizacionPendiente !== pendiente) return;
      this.autorizacionPendiente = undefined;
      pendiente.rechazar(error);
    });
    return fin;
  }

  /** Libera un ticket previamente autorizado si el corte se abortó antes de enviarse al escritor. */
  abortarTicket(identidad: IdentidadCorteTransferido, tokenAutorizacion?: string): void {
    if (this.fallo || this.cierre || this.cierrePedido) return;
    const orden: OrdenAbortarTicket = {
      tipo: 'abortarTicket',
      identidad: identidadDe(identidad),
      ...(tokenAutorizacion !== undefined && { tokenAutorizacion }),
    };
    if (this.listo) {
      this.hilo.postMessage(orden);
      return;
    }
    void this.ready.then(() => {
      if (this.fallo || this.cierre || this.cierrePedido) return;
      this.hilo.postMessage(orden);
    }).catch(() => undefined);
  }

  guardar(captura: CapturaCorteTransferido, solapado = false, tokenAutorizacion?: string): Promise<GuardadoConfirmado> {
    const identidad = identidadDe(captura.corte);
    if (this.fallo) return Promise.reject(this.fallo);
    if (this.cierre || this.pendiente) {
      if (tokenAutorizacion !== undefined) this.abortarTicket(identidad, tokenAutorizacion);
      return Promise.reject(new Error('El persistidor está cerrando o ya tiene un corte.'));
    }
    if (solapado && !captura.admiteSolape) {
      if (tokenAutorizacion !== undefined) this.abortarTicket(identidad, tokenAutorizacion);
      return Promise.reject(new Error('El corte no admite solapamiento.'));
    }
    const { corte, transferibles } = captura;
    let resolver!: Pendiente['resolver'];
    let rechazar!: Pendiente['rechazar'];
    const fin = new Promise<GuardadoConfirmado>((resolve, reject) => { resolver = resolve; rechazar = reject; });
    const pendiente = { identidad, fin, resolver, rechazar, enviado: false };
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
        ...(pruebaCabeza !== undefined && { pruebaCabeza }),
        ...(tokenAutorizacion !== undefined && { tokenAutorizacion }) } satisfies OrdenGuardado, transferibles);
      pendiente.enviado = true;
    }).catch(error => {
      if (this.pendiente !== pendiente) return;
      this.pendiente = undefined;
      if (tokenAutorizacion !== undefined) this.abortarTicket(identidad, tokenAutorizacion);
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
    const autorizacion = this.autorizacionPendiente;
    this.fallo = pendiente?.enviado ? new GuardadoIndeterminado(error) : error;
    this.pendiente = undefined;
    this.autorizacionPendiente = undefined;
    this.probarCabeza = undefined;
    autorizacion?.rechazar(this.fallo);
    pendiente?.rechazar(this.fallo);
    void this.hilo.terminate().catch(() => undefined);
  }

  private async cerrarHilo(): Promise<void> {
    try {
      await this.ready;
      await this.autorizacionPendiente?.fin.catch(() => undefined);
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

interface BasePublicadaActiva {
  readonly publicador: PublicadorBasePesos;
  readonly descriptor: DescriptorBasePesosCorte;
  readonly activa: BasePesosActiva;
}

interface TicketAutorizado {
  readonly clave: string;
  readonly identidad: IdentidadCorteTransferido;
  readonly baseIdentidad: IdentidadBasePesos;
  readonly descriptor: DescriptorBasePesosCorte;
  readonly lector: LectorBasePesosCorte;
  readonly tokenAutorizacion: string;
  revocadaTrasAutorizar: boolean;
}

interface EstadoBasePesos {
  readonly instancia: string;
  secuencia: number;
  activa?: BasePublicadaActiva;
  readonly tickets: Map<string, TicketAutorizado>;
}

function contextoDeBase(identidad: IdentidadBasePesos): BasePesosActiva['contexto'] {
  return {
    instancia: identidad.instancia,
    epoca: identidad.epoca,
    secuencia: identidad.secuencia,
    publicacion: identidad.publicacion,
    digesto: identidad.digesto,
  };
}

function revocarPublicacion(estado: EstadoBasePesos, publicada: BasePublicadaActiva | undefined): void {
  if (!publicada) return;
  const publicacion = publicada.descriptor.publicacion;
  publicada.publicador.revocar();
  for (const ticket of estado.tickets.values()) {
    if (ticket.baseIdentidad.publicacion === publicacion) {
      ticket.revocadaTrasAutorizar = true;
    }
  }
}

function revocarEstadoBase(estado: EstadoBasePesos): void {
  const previa = estado.activa;
  estado.activa = undefined;
  revocarPublicacion(estado, previa);
}

function purgarTicketsOtraEpoca(estado: EstadoBasePesos, epocaVigente: number): void {
  for (const [clave, ticket] of estado.tickets) {
    if (ticket.identidad.epoca !== epocaVigente) estado.tickets.delete(clave);
  }
}

function autorizarTicketEnEscritor(
  estadoBase: EstadoBasePesos,
  basePesosCorte: boolean,
  orden: OrdenAutorizarTicket,
): RespuestaGuardado {
  const { identidad, baseIdentidad } = orden;
  const denegar = (motivo: string): RespuestaGuardado => ({
    tipo: 'ticketAutorizado',
    identidad: identidadCorteValida(identidad) ? identidadDe(identidad) : identidad,
    autorizado: false,
    motivo,
  });
  if (!basePesosCorte) return denegar('base_desactivada');
  if (!identidadCorteValida(identidad)) return denegar('identidad_corte_invalida');
  if (!identidadBasePesosValida(baseIdentidad)) return denegar('identidad_base_invalida');
  purgarTicketsOtraEpoca(estadoBase, identidad.epoca);
  const activa = estadoBase.activa;
  if (!activa) return denegar('sin_base');
  if (activa.publicador.estado() !== ESTADO_BASE_PESOS.PUBLICADA || !activa.activa.lector.estaPublicada()) {
    revocarEstadoBase(estadoBase);
    return denegar('base_revocada');
  }
  if (activa.descriptor.instancia !== estadoBase.instancia) return denegar('instancia_distinta');
  if (activa.descriptor.epoca !== identidad.epoca) return denegar('epoca_cambiada');
  if (!mismaIdentidadBasePesos(activa.descriptor, baseIdentidad)) return denegar('publicacion_distinta');
  const clave = claveTicket(identidad);
  if (estadoBase.tickets.has(clave)) return denegar('ticket_duplicado');
  if (estadoBase.tickets.size >= MAX_TICKETS_EN_VUELO) return denegar('limite_tickets');

  const tokenAutorizacion = randomUUID();
  const baseFija: IdentidadBasePesos = Object.freeze({
    version: activa.descriptor.version,
    publicacion: activa.descriptor.publicacion,
    instancia: activa.descriptor.instancia,
    epoca: activa.descriptor.epoca,
    secuencia: activa.descriptor.secuencia,
    digesto: activa.descriptor.digesto,
  });
  estadoBase.tickets.set(clave, {
    clave,
    identidad: identidadDe(identidad),
    baseIdentidad: baseFija,
    descriptor: activa.descriptor,
    lector: activa.activa.lector,
    tokenAutorizacion,
    revocadaTrasAutorizar: false,
  });
  return { tipo: 'ticketAutorizado', identidad: identidadDe(identidad), autorizado: true, tokenAutorizacion };
}

function abortarTicketEnEscritor(estadoBase: EstadoBasePesos, orden: OrdenAbortarTicket): void {
  if (!identidadCorteValida(orden.identidad)) return;
  const clave = claveTicket(orden.identidad);
  const ticket = estadoBase.tickets.get(clave);
  if (!ticket) return;
  if (orden.tokenAutorizacion !== undefined && ticket.tokenAutorizacion !== orden.tokenAutorizacion) return;
  estadoBase.tickets.delete(clave);
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
  const estadoBase: EstadoBasePesos = { instancia: randomUUID(), secuencia: 0, tickets: new Map() };
  let solicitaPruebaCabeza = probarCabeza && store.anclarPruebaCabeza();
  puerto.on('messageerror', error => { throw error; });
  puerto.on('message', (orden: OrdenGuardado) => {
    switch (orden.tipo) {
      case 'autorizarTicket':
        responder(autorizarTicketEnEscritor(estadoBase, basePesosCorte, orden));
        return;
      case 'abortarTicket':
        abortarTicketEnEscritor(estadoBase, orden);
        return;
      case 'revocarBase':
        revocarEstadoBase(estadoBase);
        return;
      case 'cerrar':
        estadoBase.tickets.clear();
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

function guardar(store: Store, { corte, solapado, pruebaCabeza, tokenAutorizacion }: OrdenGuardar, afinidad: AfinidadPersistidor,
  perfilarFases: boolean, probarCabeza: boolean, primerCorteConAncla: boolean,
  basePesosCorte: boolean, estadoBase: EstadoBasePesos): RespuestaGuardado {
  const identidad = identidadDe(corte);
  const clave = claveTicket(identidad);
  const confirmaciones = store.confirmacionesDeGuardado;
  let ticketAutorizadoUsado = false;
  let ticketConsumible: TicketAutorizado | undefined;
  let reconstruidoFullPorRevocacion = false;
  try {
    purgarTicketsOtraEpoca(estadoBase, corte.epoca);
    if (estadoBase.activa && estadoBase.activa.activa.contexto.epoca !== corte.epoca) {
      revocarEstadoBase(estadoBase);
    }
    if (primerCorteConAncla) store.ofrecerPruebaCabeza(pruebaCabeza);

    // Prevalidación de referencias y ticket ANTES de cualquier consumo destructivo del sobre.
    const inspeccion = inspeccionarReferenciasCorte(corte.remoto);
    if (inspeccion.inconsistente) {
      throw new RechazoBasePesosError('referencia_invalida', 'Referencias F64 malformadas o inconsistentes en el corte.');
    }

    let corteAProcesar: CorteTransferido = corte;
    let baseParaMaterializar: BasePesosActiva | undefined;

    if (inspeccion.totalRefs === 0) {
      const existente = estadoBase.tickets.get(clave);
      if (existente && (tokenAutorizacion === undefined || existente.tokenAutorizacion === tokenAutorizacion)) {
        ticketConsumible = existente;
      }
    } else {
      if (!basePesosCorte) {
        throw new RechazoBasePesosError('sin_base', 'El corte usa referencias F64 con la base compartida desactivada.');
      }
      const requiereTicket = solapado || tokenAutorizacion !== undefined;
      if (requiereTicket) {
        const ticket = estadoBase.tickets.get(clave);
        if (!ticket || typeof tokenAutorizacion !== 'string' || ticket.tokenAutorizacion !== tokenAutorizacion
          || !mismoCorte(ticket.identidad, identidad)) {
          throw new RechazoBasePesosError('identidad_ausente', 'El corte con referencias F64 carece de ticket autorizado vigente.');
        }
        ticketConsumible = ticket;
        if (ticket.baseIdentidad.instancia !== estadoBase.instancia) {
          throw new RechazoBasePesosError('instancia_distinta', 'El ticket pertenece a otra vida del escritor.');
        }
        if (ticket.baseIdentidad.epoca !== corte.epoca) {
          throw new RechazoBasePesosError('epoca_cambiada', 'El ticket corresponde a otra época.');
        }
        if (!inspeccion.identidad || !mismaIdentidadBasePesos(ticket.baseIdentidad, inspeccion.identidad)) {
          throw new RechazoBasePesosError('publicacion_distinta', 'Las referencias F64 no coinciden con la base autorizada del ticket.');
        }
        ticketAutorizadoUsado = true;
        if (ticket.revocadaTrasAutorizar) {
          // Revocación natural posterior a la autorización: verificar SHA-256 del SAB retenido y reconstruir FULL exacto.
          let lectorReconstruccion;
          try {
            lectorReconstruccion = abrirLectorReconstruccionBasePesos(ticket.descriptor, ticket.baseIdentidad);
          } catch (error) {
            if (estadoBase.activa?.descriptor.publicacion === ticket.baseIdentidad.publicacion) revocarEstadoBase(estadoBase);
            throw new RechazoBasePesosError(
              'digesto_distinto',
              error instanceof Error ? error.message : 'Integridad de la base F64 retenida comprometida.',
            );
          }
          try {
            const remotoFull = reconstruirCorteRemotoFull(corte.remoto, lectorReconstruccion);
            corteAProcesar = { ...corte, remoto: remotoFull };
          } catch (error) {
            if (error instanceof RechazoBasePesosError) throw error;
            throw new RechazoBasePesosError(
              'referencia_invalida',
              error instanceof Error ? error.message : 'No se pudo reconstruir el corte FULL desde la base autorizada.',
            );
          }
          baseParaMaterializar = undefined;
          reconstruidoFullPorRevocacion = true;
        } else {
          if (!ticket.lector.estaPublicada()) {
            if (estadoBase.activa?.descriptor.publicacion === ticket.baseIdentidad.publicacion) revocarEstadoBase(estadoBase);
            throw new RechazoBasePesosError('base_revocada', 'La base F64 fue alterada o revocada fuera de contrato.');
          }
          baseParaMaterializar = { lector: ticket.lector, contexto: contextoDeBase(ticket.baseIdentidad) };
        }
      } else {
        baseParaMaterializar = estadoBase.activa?.activa;
      }
    }

    const materializado = medirTramo(() => materializarCorteTransferido(corteAProcesar, store.context, solapado, baseParaMaterializar));
    const { sello, tecnologiaRemotaEquivalente, bajas, diagnosticoPersonasCorte } = materializado.valor;
    const fases: FasesPersistidor | undefined = perfilarFases ? {} : undefined;
    const guardado = medirTramo(() => {
      const cerrarFase = fases && medirFasesGuardado(fases);
      return solapado ? store.guardarCorteSolapado(sello, corte.epoca, cerrarFase)
        : store.guardarCorteSellado(sello, [], [], undefined, cerrarFase);
    });
    const { world } = guardado.valor;
    if (!world.chronicleJournal) throw new Error('El corte confirmado carece de crónica.');
    if (ticketConsumible) {
      estadoBase.tickets.delete(ticketConsumible.clave);
      ticketConsumible = undefined;
    }
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
            descriptor,
            activa: {
              lector,
              contexto: contextoDeBase(descriptor),
            },
          };
          revocarPublicacion(estadoBase, anterior);
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
          ticketAutorizado: ticketAutorizadoUsado,
          reconstruidoFullPorRevocacion,
          ticketsRetenidos: estadoBase.tickets.size,
        }) },
    } };
  } catch (error) {
    if (ticketConsumible) {
      estadoBase.tickets.delete(ticketConsumible.clave);
      ticketConsumible = undefined;
    }
    if (store.confirmacionesDeGuardado !== confirmaciones || store.db.isTransaction) throw error;
    if (primerCorteConAncla) store.ofrecerPruebaCabeza(undefined);
    const baseRechazada = error instanceof RechazoBasePesosError;
    if (baseRechazada && !solapado) revocarEstadoBase(estadoBase);
    return { tipo: 'rechazado', identidad,
      mensaje: error instanceof Error ? error.message : 'No se pudo guardar el corte.',
      ...(baseRechazada && { baseRechazada: true }) };
  }
}

if (!isMainThread && workerData?.role === 'carta-guardado') abrirPersistidor(workerData.path, workerData.options);
