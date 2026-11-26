import { randomUUID } from 'node:crypto';
import { BroadcastChannel, isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { PercibidorCpu, type VistaMundo } from '../decision/percepcion.js';
import { ErrorDispositivo, type CanalGpu, type Dispositivo, type LotePercepcion, type Percibidor, type Plan, type TelemetriaBrokerGpu } from '../motor/contratos.js';
import { CanalCompartido, enviarOrden, recibirRespuesta, type OpcionesCanalGpu } from './canal.js';
import { CostePercepcion } from './coste-percepcion.js';
import { PercibidorGpu } from './percibir-gpu.js';

const CONTROL = { listo: 0, ocupado: 1, generacion: 2, peticiones: 3, dueno0: 4, dueno1: 5, micros: 6, bytes: 7,
  senal0: 8, validacion0: 10, celdas: 12 };
const MEDIDA = { lotes: 0, dueno0: 1, dueno1: 2, cpuArranque: 3, cpuOcupada: 4, cpuSinCanal: 5, errores: 6,
  subida: 7, bajada: 8, cudaMicros: 9, recorridoMicros: 10, cpuPorCoste: 11, aceptada0: 12, aceptada1: 13, rechazada: 14,
  preparacionMicros: 15, celdas: 16 };
type MotivoCpu = 'cpuArranque' | 'cpuOcupada' | 'cpuSinCanal';
const SOLO_CPU = [[]];
const ESTADO = { esperando: 0, lista: 1, fallo: 2, cancelada: 3 };
const LIMITE_MS = 50;
const PLAZO_TRANSITO_NANOS = BigInt(LIMITE_MS) * 1_000_000n;
const restante = (fin: bigint): number => Number(fin - process.hrtime.bigint()) / 1e6;
const TRAZAR = process.env.CARTA_PERCEPCION_TRAZA === '1';
const trazar = (fase: string, gpu: number, datos: object) => {
  if (TRAZAR) console.error('[percepcion-gpu]', JSON.stringify({ fase, gpu, ...datos }));
};
const turno = (generacion: number, dueno: number): number => (generacion << 2) | (dueno + 1);
function despertar(control: Int32Array<SharedArrayBuffer>, dueno: number): void {
  const senal = CONTROL.senal0 + dueno;
  Atomics.add(control, senal, 1);
  Atomics.notify(control, senal);
}
function desactivar(control: Int32Array<SharedArrayBuffer>): void {
  Atomics.store(control, CONTROL.listo, -1);
  despertar(control, 0);
  despertar(control, 1);
}

interface Identidad { generacion: number; epoca: number; dueno: number; tick: number; despacho: number }
interface Orden { kind: 'percibir'; subida: number; salida: number; bajada: number; tick: number; despacho: number }
interface Peticion {
  identidad: Identidad; orden: Orden; inicio: bigint; enviada: bigint; fin: bigint; datos: Uint8Array<SharedArrayBuffer>;
  estado: Int32Array<SharedArrayBuffer>; tiempo: Float64Array<SharedArrayBuffer>;
}
interface PuertoBroker { dispositivo: number; canal: string; control: Int32Array<SharedArrayBuffer>; medida?: BigInt64Array<SharedArrayBuffer>; porCoste?: boolean }
export interface EpocaBrokerPercepcion extends PuertoBroker { generacion: number; epoca: number }

export function admiteBrokerPercepcionGpu(hilos: number, gpu: readonly number[]): boolean {
  return hilos === 2 && (gpu.length === 1 && (gpu[0] === 0 || gpu[0] === 1) ||
    gpu.length === 2 && gpu[0] === 0 && gpu[1] === 1);
}

export class BrokerPercepcionGpu {
  readonly #puertos: PuertoBroker;
  readonly #worker: Worker;
  readonly #salida: Promise<void>;
  #cerrando = false;
  readonly listo: Promise<boolean>;

  constructor(opciones?: OpcionesCanalGpu, medir = false, dispositivo = 0) {
    this.#puertos = { dispositivo, canal: `atlas-percepcion-duenos-${randomUUID()}`,
      control: new Int32Array(new SharedArrayBuffer(CONTROL.celdas * Int32Array.BYTES_PER_ELEMENT)) };
    if (process.env.CARTA_PERCEPCION_COSTE_DUENOS === '1') this.#puertos.porCoste = true;
    if (medir || this.#puertos.porCoste) this.#puertos.medida = new BigInt64Array(new SharedArrayBuffer(MEDIDA.celdas * BigInt64Array.BYTES_PER_ELEMENT));
    this.#worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      (async () => {
        if (workerData.loaderURL) (await import(workerData.loaderURL)).register();
        await import(workerData.moduleURL);
      })().catch(error => { setImmediate(() => { throw error; }); });
    `, { eval: true, execArgv: [], name: `carta-gpu${dispositivo}-duenos`, workerData: {
      role: 'carta-gpu-duenos', moduleURL: import.meta.url,
      loaderURL: import.meta.url.endsWith('.ts') ? import.meta.resolve('tsx/esm/api') : undefined,
      ...this.#puertos, opciones,
    } });
    this.#salida = new Promise(resolve => this.#worker.once('exit', () => {
      desactivar(this.#puertos.control);
      resolve();
    }));
    this.#worker.on('error', () => desactivar(this.#puertos.control));
    this.listo = Promise.race([
      new Promise<boolean>(resolve => this.#worker.once('message', resolve)),
      this.#salida.then(() => false),
    ]);
  }

  abrirEpoca(epoca: number): EpocaBrokerPercepcion {
    const { control } = this.#puertos;
    const generacion = Atomics.add(control, CONTROL.generacion, 1) + 1;
    Atomics.store(control, CONTROL.ocupado, 0);
    despertar(control, 0);
    despertar(control, 1);
    return { ...this.#puertos, epoca, generacion };
  }

  medidas() {
    const c = this.#puertos.control;
    const generacion = Atomics.load(c, CONTROL.generacion);
    return { lista: Atomics.load(c, CONTROL.listo) === 1,
      aceptaEnEpoca: generacion > 0 && (Atomics.load(c, CONTROL.validacion0) === generacion ||
        Atomics.load(c, CONTROL.validacion0 + 1) === generacion),
      bytes: Atomics.load(c, CONTROL.bytes), ms: Atomics.load(c, CONTROL.micros) / 1000,
      completadas: [Atomics.load(c, CONTROL.dueno0), Atomics.load(c, CONTROL.dueno1)],
      peticiones: Atomics.load(c, CONTROL.peticiones), detalle: this.#detalle() };
  }

  #detalle(): TelemetriaBrokerGpu | undefined {
    const m = this.#puertos.medida;
    if (!m) return undefined;
    const leer = (i: number) => Number(Atomics.load(m, i));
    return { lotes: leer(MEDIDA.lotes), completadas: [leer(MEDIDA.dueno0), leer(MEDIDA.dueno1)],
      aceptadas: [leer(MEDIDA.aceptada0), leer(MEDIDA.aceptada1)], rechazadas: leer(MEDIDA.rechazada),
      cpuArranque: leer(MEDIDA.cpuArranque), cpuOcupada: leer(MEDIDA.cpuOcupada), cpuSinCanal: leer(MEDIDA.cpuSinCanal),
      ...(this.#puertos.porCoste && { cpuPorCoste: leer(MEDIDA.cpuPorCoste) }),
      erroresCanal: leer(MEDIDA.errores), subidaConfirmadaBytes: leer(MEDIDA.subida), bajadaConfirmadaBytes: leer(MEDIDA.bajada),
      cudaConfirmadaMicros: leer(MEDIDA.cudaMicros), recorridoConfirmadoMicros: leer(MEDIDA.recorridoMicros),
      preparacionMicros: leer(MEDIDA.preparacionMicros) };
  }

  cerrar(): Promise<void> {
    if (!this.#cerrando) {
      this.#cerrando = true;
      desactivar(this.#puertos.control);
      this.#worker.postMessage('cerrar');
    }
    return this.#salida;
  }
}

/** El dueño empaqueta desde su captura F2. El corredor solo ve el paquete, nunca las páginas vivas del dueño. */
class CanalPercepcionBroker implements CanalGpu {
  readonly #puerto: BroadcastChannel;
  #datos = new Uint8Array(new SharedArrayBuffer(0));
  #pendiente?: Peticion;
  #reserva?: bigint;
  #cerrado = false;

  constructor(private readonly epoca: EpocaBrokerPercepcion, private readonly dueno: number) {
    this.#puerto = new BroadcastChannel(`${epoca.canal}:${dueno}`);
    this.#puerto.unref();
  }

  get dispositivo(): number { return this.epoca.dispositivo; }
  get bytes(): number { return this.#datos.length; }
  obstaculo(comprobarOcupacion: boolean): MotivoCpu | undefined {
    const { control, generacion } = this.epoca;
    const listo = Atomics.load(control, CONTROL.listo);
    if (this.#cerrado || listo !== 1 || Atomics.load(control, CONTROL.generacion) !== generacion) {
      return listo === 0 && !this.#cerrado ? 'cpuArranque' : 'cpuSinCanal';
    }
    if (comprobarOcupacion && Atomics.load(control, CONTROL.ocupado) !== 0) return 'cpuOcupada';
  }
  anotarRuta(ruta: MotivoCpu | 'cpuPorCoste' | 'lotes'): void {
    if (this.epoca.medida) Atomics.add(this.epoca.medida, MEDIDA[ruta], 1n);
  }
  admitir(): boolean {
    const { control, generacion } = this.epoca;
    const obstaculo = this.obstaculo(false);
    if (obstaculo) { this.anotarRuta(obstaculo); return false; }
    if (Atomics.compareExchange(control, CONTROL.ocupado, 0, turno(generacion, this.dueno)) !== 0) {
      this.anotarRuta('cpuOcupada');
      return false;
    }
    if (Atomics.load(control, CONTROL.generacion) !== generacion) {
      Atomics.compareExchange(control, CONTROL.ocupado, turno(generacion, this.dueno), 0);
      this.anotarRuta('cpuSinCanal');
      return false;
    }
    this.#reserva = process.hrtime.bigint();
    return true;
  }

  crecer(bytes: number): void {
    if (bytes > this.bytes) this.#datos = new Uint8Array(new SharedArrayBuffer(bytes));
  }
  escribir(desde: number, datos: ArrayBufferView): void {
    this.#datos.set(new Uint8Array(datos.buffer, datos.byteOffset, datos.byteLength), desde);
  }
  leer(desde: number, destino: ArrayBufferView): void {
    new Uint8Array(destino.buffer, destino.byteOffset, destino.byteLength).set(this.#datos.subarray(desde, desde + destino.byteLength));
  }
  enviar(datos: Uint8Array): void {
    if (this.#reserva === undefined || this.#pendiente) throw new Error('El dueño no reservó el canal de percepción.');
    const orden = JSON.parse(Buffer.from(datos).toString()) as Orden;
    const { epoca, generacion } = this.epoca;
    const respuesta = new SharedArrayBuffer(16);
    // El dueño ya acabó de empaquetar. Los 50 ms cubren buzón, copias y respuesta del servidor.
    const enviada = process.hrtime.bigint(), inicio = this.#reserva;
    const peticion: Peticion = {
      identidad: { generacion, epoca, dueno: this.dueno, tick: orden.tick, despacho: orden.despacho },
      orden, inicio, enviada, fin: enviada + PLAZO_TRANSITO_NANOS, datos: this.#datos,
      estado: new Int32Array(respuesta, 0, 1), tiempo: new Float64Array(respuesta, 8, 1),
    };
    this.#puerto.postMessage(peticion);
    this.#pendiente = peticion;
    this.#reserva = undefined;
    if (this.epoca.medida) Atomics.add(this.epoca.medida, MEDIDA.preparacionMicros, (enviada - inicio) / 1000n);
    if (TRAZAR) trazar('enviada', this.dispositivo, { ...peticion.identidad, subida: orden.subida, bajada: orden.bajada,
      preparacionMs: Number(enviada - inicio) / 1e6 });
  }
  recibir(plazoMs: number): Uint8Array {
    if (Number.isNaN(plazoMs) || plazoMs < 0) throw new RangeError('Plazo del corredor GPU inválido.');
    const peticion = this.#pendiente;
    if (!peticion) throw new Error('El dueño no tiene un despacho pendiente.');
    const { estado, fin, tiempo, identidad } = peticion;
    const { control } = this.epoca;
    const senal = CONTROL.senal0 + this.dueno, limite = performance.now() + plazoMs;
    for (;;) {
      const aviso = Atomics.load(control, senal), queda = Math.min(limite - performance.now(), restante(fin));
      if (queda <= 0 || Atomics.load(estado, 0) !== ESTADO.esperando || Atomics.load(control, CONTROL.listo) !== 1
        || Atomics.load(control, CONTROL.generacion) !== identidad.generacion) break;
      Atomics.wait(control, senal, aviso, queda);
    }
    // Si vence el plazo, el corredor aún podría escribir sus bytes. El dueño pierde este búfer para siempre.
    const antes = Atomics.compareExchange(estado, 0, ESTADO.esperando, ESTADO.cancelada);
    this.#pendiente = undefined;
    if (antes !== ESTADO.lista || Atomics.load(control, CONTROL.generacion) !== identidad.generacion
      || Atomics.load(control, CONTROL.listo) !== 1) {
      if (TRAZAR) trazar('sin-respuesta', this.dispositivo, { ...identidad, estado: antes,
        lista: Atomics.load(control, CONTROL.listo), restanteMs: restante(fin), desdeEnvioMs: -restante(peticion.enviada) });
      throw new ErrorDispositivo(`gpu${this.dispositivo}`, 'El corredor no confirmó el despacho de este dueño y generación.');
    }
    const medida = this.epoca.medida;
    if (medida) {
      Atomics.add(medida, MEDIDA.dueno0 + this.dueno, 1n);
      Atomics.add(medida, MEDIDA.subida, BigInt(peticion.orden.subida));
      Atomics.add(medida, MEDIDA.bajada, BigInt(peticion.orden.bajada));
      Atomics.add(medida, MEDIDA.cudaMicros, BigInt(Math.round(tiempo[0]! * 1000)));
      Atomics.add(medida, MEDIDA.recorridoMicros, (process.hrtime.bigint() - peticion.inicio) / 1000n);
    }
    return Buffer.from(JSON.stringify({ ok: true, ...identidad, ms: tiempo[0] }));
  }
  anotarError(error: unknown): void {
    if (!(error instanceof ErrorDispositivo)) return;
    this.#validarEnEpoca(false);
    if (this.epoca.medida) Atomics.add(this.epoca.medida, MEDIDA.errores, 1n);
  }
  anotarValidacion(aceptada: boolean): void {
    if (this.#validarEnEpoca(aceptada) && this.epoca.medida)
      Atomics.add(this.epoca.medida, aceptada ? MEDIDA.aceptada0 + this.dueno : MEDIDA.rechazada, 1n);
  }
  #validarEnEpoca(aceptada: boolean): boolean {
    const { control, generacion } = this.epoca;
    if (Atomics.load(control, CONTROL.generacion) !== generacion) return false;
    const posicion = CONTROL.validacion0 + this.dueno;
    // El signo representa la última validación. Un cliente que cierra tarde no pisa otra generación.
    let anterior = Atomics.load(control, posicion);
    while (Math.abs(anterior) <= generacion) {
      const leida = Atomics.compareExchange(control, posicion, anterior, aceptada ? generacion : -generacion);
      if (leida === anterior) return true;
      anterior = leida;
    }
    return false;
  }
  cerrar(): void {
    if (this.#cerrado) return;
    this.#cerrado = true;
    if (this.#reserva !== undefined) Atomics.compareExchange(this.epoca.control, CONTROL.ocupado, turno(this.epoca.generacion, this.dueno), 0);
    if (this.#pendiente) Atomics.compareExchange(this.#pendiente.estado, 0, ESTADO.esperando, ESTADO.cancelada);
    this.#pendiente = undefined;
    this.#puerto.close();
    this.#datos = new Uint8Array(new SharedArrayBuffer(0));
  }
}

export class PercibidorBroker implements Percibidor {
  readonly dispositivo: Dispositivo;
  readonly #canal: CanalPercepcionBroker;
  readonly #gpu: PercibidorGpu;
  readonly #cpu: PercibidorCpu;
  readonly #coste?: CostePercepcion;
  readonly #rutas: number[][];
  #medicion?: { inicio: number; eleccion: ReturnType<CostePercepcion['elegir']> };
  #usaGpu = false;
  #recibioGpu = false;

  constructor(private readonly vista: VistaMundo, epoca: EpocaBrokerPercepcion, dueno: number,
    private readonly reloj = () => performance.now()) {
    this.#canal = new CanalPercepcionBroker(epoca, dueno);
    this.#gpu = new PercibidorGpu(this.#canal, vista.frente, vista.terreno, true);
    this.dispositivo = this.#gpu.dispositivo;
    this.#rutas = [[], [epoca.dispositivo]];
    this.#cpu = new PercibidorCpu(vista);
    if (epoca.porCoste) this.#coste = new CostePercepcion();
  }

  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    this.#medicion = undefined;
    this.#usaGpu = false;
    this.#recibioGpu = false;
    if (lote.slots.length > 0) {
      this.#canal.anotarRuta('lotes');
      if (this.#coste) {
        const obstaculo = this.#canal.obstaculo(true);
        const eleccion = this.#coste.elegir(planes, lote.slots.length, obstaculo ? SOLO_CPU : this.#rutas);
        const inicio = this.reloj();
        const proponeGpu = eleccion.tarjetas.length > 0;
        if (proponeGpu) this.#usaGpu = this.#canal.admitir();
        else this.#canal.anotarRuta(obstaculo ?? 'cpuPorCoste');
        if (proponeGpu === this.#usaGpu) this.#medicion = { inicio, eleccion };
        else eleccion.posponer(); // Perdió la reserva: el trabajo que sigue en CPU no mide la GPU.
      } else this.#usaGpu = this.#canal.admitir();
    }
    if (!this.#usaGpu) { this.#cpu.lanzar(lote, planes); return; }
    try {
      this.#gpu.fuentes(this.vista.frente, this.vista.terreno);
      this.#gpu.lanzar(lote, planes);
    } catch (error) { this.#canal.anotarError(error); this.#canal.cerrar(); throw error; }
  }
  esperar(plazoMs: number) {
    if (!this.#usaGpu) return this.#cpu.esperar();
    try {
      const salida = this.#gpu.esperar(plazoMs);
      this.#recibioGpu = true;
      return salida;
    }
    catch (error) { this.#canal.anotarError(error); throw error; }
  }
  confirmar(aceptada: boolean): void {
    if (this.#recibioGpu) this.#canal.anotarValidacion(aceptada);
    this.#recibioGpu = false;
    const medicion = this.#medicion;
    this.#medicion = undefined;
    if (!medicion) return;
    if (aceptada) medicion.eleccion.observar(this.reloj() - medicion.inicio);
    else if (this.#usaGpu) medicion.eleccion.posponer();
  }
  cerrar(): void {
    this.#medicion = undefined;
    this.#canal.cerrar();
  }
}

function atender(puertos: PuertoBroker, opciones?: OpcionesCanalGpu): void {
  const { canal, control, dispositivo } = puertos;
  const port = parentPort!;
  let gpu: CanalCompartido | undefined;
  const entradas: BroadcastChannel[] = [];
  const cerrar = () => {
    desactivar(control);
    for (const entrada of entradas) entrada.close();
    gpu?.cerrar();
    port.close();
  };
  try {
    gpu = new CanalCompartido(dispositivo, opciones);
    gpu.iniciar(3000);
    for (const dueno of [0, 1]) {
      const entrada = new BroadcastChannel(`${canal}:${dueno}`);
      entradas.push(entrada);
      entrada.onmessage = ({ data }) => {
        const { identidad: id, orden, enviada, fin, estado, datos, tiempo } = data as Peticion;
        const permiso = turno(id.generacion, dueno);
        const pertenece = () => id.dueno === dueno && Atomics.load(control, CONTROL.generacion) === id.generacion
          && Atomics.load(control, CONTROL.listo) === 1;
        const vigente = () => pertenece() && Atomics.load(control, CONTROL.ocupado) === permiso
          && Atomics.load(estado, 0) === ESTADO.esperando && restante(fin) > 0;
        let fase = 'admisión';
        const tiempos: Record<string, number> | undefined = TRAZAR ? { colaMs: -restante(enviada) } : undefined;
        let marca = TRAZAR ? performance.now() : 0;
        const medir = (siguiente: string) => {
          if (tiempos) {
            const ahora = performance.now();
            tiempos[fase] = ahora - marca;
            marca = ahora;
          }
          fase = siguiente;
        };
        let ms: number | undefined;
        try {
          if (!vigente()) {
            if (TRAZAR) trazar('descartada', dispositivo, { ...id, etapa: fase, estado: Atomics.load(estado, 0), restanteMs: restante(fin), ...tiempos });
            return;
          }
          Atomics.add(control, CONTROL.peticiones, 1);
          medir('copiarSubidaMs');
          if (datos.length > gpu!.bytes) gpu!.crecer(datos.length);
          gpu!.escribir(0, datos.subarray(0, orden.subida));
          medir('enviarOrdenMs');
          if (!vigente()) {
            if (TRAZAR) trazar('descartada', dispositivo, { ...id, etapa: fase, estado: Atomics.load(estado, 0), restanteMs: restante(fin), ...tiempos });
            return;
          }
          enviarOrden(gpu!, { ...orden, ...id });
          medir('esperarRespuestaMs');
          const respuesta = recibirRespuesta<Identidad & { ok: boolean; ms: number }>(gpu!, Math.max(0, restante(fin)));
          medir('copiarBajadaMs');
          if (!respuesta.ok || !Number.isFinite(respuesta.ms) || respuesta.ms < 0
            || respuesta.generacion !== id.generacion || respuesta.epoca !== id.epoca || respuesta.dueno !== id.dueno
            || respuesta.tick !== id.tick || respuesta.despacho !== id.despacho) {
            throw new ErrorDispositivo(`gpu${dispositivo}`, 'El corredor recibió el eco de otro despacho.');
          }
          if (pertenece() && restante(fin) > 0 && Atomics.load(estado, 0) === ESTADO.esperando) {
            gpu!.leer(orden.salida, datos.subarray(orden.salida, orden.salida + orden.bajada));
            tiempo[0] = respuesta.ms;
            ms = respuesta.ms;
          }
        } catch (error) {
          if (TRAZAR) trazar('fallo-corredor', dispositivo, { ...id, etapa: fase, restanteMs: restante(fin), ...tiempos,
            razon: error instanceof Error && error.message.startsWith('Venció el plazo') ? 'plazo' :
              error instanceof Error && error.message.includes('eco de otro despacho') ? 'identidad' : 'canal' });
          cerrar();
        } finally {
          if (TRAZAR && ms !== undefined) {
            medir('fin');
            trazar('respuesta', dispositivo, { ...id, cudaMs: ms, restanteMs: restante(fin), ...tiempos });
          }
          Atomics.compareExchange(control, CONTROL.ocupado, permiso, 0);
          if (ms !== undefined && pertenece() && restante(fin) > 0
            && Atomics.compareExchange(estado, 0, ESTADO.esperando, ESTADO.lista) === ESTADO.esperando) {
            Atomics.add(control, CONTROL.dueno0 + dueno, 1);
            Atomics.store(control, CONTROL.micros, Math.round(ms * 1000));
            Atomics.store(control, CONTROL.bytes, orden.subida + orden.bajada);
          } else Atomics.compareExchange(estado, 0, ESTADO.esperando, ESTADO.fallo);
          despertar(control, dueno);
        }
      };
    }
  } catch { port.postMessage(false); cerrar(); return; }
  port.on('message', cerrar);
  if (Atomics.compareExchange(control, CONTROL.listo, 0, 1) === 0) port.postMessage(true);
  else cerrar();
}

if (!isMainThread && workerData?.role === 'carta-gpu-duenos') atender(workerData, workerData.opciones);
