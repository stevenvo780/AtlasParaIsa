import { randomUUID } from 'node:crypto';
import { BroadcastChannel, isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { PercibidorCpu, type VistaMundo } from '../decision/percepcion.js';
import { ErrorDispositivo, type CanalGpu, type Dispositivo, type LotePercepcion, type Percibidor, type Plan, type TelemetriaBrokerGpu } from '../motor/contratos.js';
import { CanalCompartido, DespachoGpuDescartado, enviarOrden, recibirRespuesta, type OpcionesCanalGpu } from './canal.js';
import { CostePercepcion } from './coste-percepcion.js';
import { PercibidorGpu } from './percibir-gpu.js';

const CONTROL = { listo: 0, ocupado: 1, generacion: 2, peticiones: 3, micros: 4, bytes: 5, ranuras: 6 };
const RANURA = { permiso: 0, senal: 1, validacion: 2, completadas: 3, celdas: 4 };
const CONTROL_LARGO = { epoca: 0, finActivo: 1, servicio: 2, celdas: 3 };
const MEDIDA = { lotes: 0, cpuArranque: 1, cpuOcupada: 2, cpuSinCanal: 3, errores: 4,
  subida: 5, bajada: 6, cudaMicros: 7, recorridoMicros: 8, cpuPorCoste: 9, rechazada: 10,
  preparacionMicros: 11, colaMicros: 12, cpuColaVencida: 13, ranuras: 14 };
const MEDIDA_RANURA = { completadas: 0, aceptadas: 1, celdas: 2 };
type MotivoCpu = 'cpuArranque' | 'cpuOcupada' | 'cpuSinCanal';
export type DuenosBroker = readonly (number | null)[];
const SOLO_CPU = [[]];
const ESTADO = { enCola: 0, enServidor: 1, lista: 2, fallo: 3, descartada: 4, cancelada: 5 };
const MAX_GENERACION = 0x1fffffff; // El permiso legado deja dos bits para distinguir las ranuras.
const LIMITE_MS = 50;
const PLAZO_TRANSITO_NANOS = BigInt(LIMITE_MS) * 1_000_000n;
const restante = (fin: bigint): number => Number(fin - process.hrtime.bigint()) / 1e6;
const TRAZAR = process.env.CARTA_PERCEPCION_TRAZA === '1';
const trazar = (fase: string, gpu: number, datos: object) => {
  if (TRAZAR) console.error('[percepcion-gpu]', JSON.stringify({ fase, gpu, ...datos }));
};
const celda = (ranura: number, campo: number) => CONTROL.ranuras + ranura * RANURA.celdas + campo;
const celdaMedida = (ranura: number, campo: number) => MEDIDA.ranuras + ranura * MEDIDA_RANURA.celdas + campo;
const celdaPermiso = (agrupado: boolean, ranura: number) => agrupado ? celda(ranura, RANURA.permiso) : CONTROL.ocupado;
const turno = (agrupado: boolean, generacion: number, ranura: number) => agrupado ? generacion : (generacion << 2) | (ranura + 1);
function servicioEstimado(control: BigInt64Array<SharedArrayBuffer>, generacion: number): number {
  const dato = Atomics.load(control, CONTROL_LARGO.servicio);
  return Number(dato >> 32n) === generacion ? Number(dato & 0xffffffffn) : 0;
}
function despertar(control: Int32Array<SharedArrayBuffer>, ranura: number): void {
  const senal = celda(ranura, RANURA.senal);
  Atomics.add(control, senal, 1);
  Atomics.notify(control, senal);
}
function desactivar({ control, duenosPorRanura }: PuertoBroker): void {
  Atomics.store(control, CONTROL.listo, -1);
  duenosPorRanura.forEach((_, ranura) => despertar(control, ranura));
}
function cancelar(estado: Int32Array<SharedArrayBuffer>): number {
  const anterior = Atomics.compareExchange(estado, 0, ESTADO.enCola, ESTADO.descartada);
  return anterior === ESTADO.enServidor ? Atomics.compareExchange(estado, 0, ESTADO.enServidor, ESTADO.cancelada) : anterior;
}

interface Identidad { generacion: number; epoca: number; dueno: number; tick: number; despacho: number }
interface Orden { kind: 'percibir'; subida: number; salida: number; bajada: number; tick: number; despacho: number }
interface Peticion {
  identidad: Identidad; orden: Orden; inicio: bigint; enviada: bigint; fin: bigint; datos: Uint8Array<SharedArrayBuffer>;
  estado: Int32Array<SharedArrayBuffer>; tiempo: Float64Array<SharedArrayBuffer>; tomada: BigInt64Array<SharedArrayBuffer>;
}
interface PuertoBroker {
  dispositivo: number; canal: string; control: Int32Array<SharedArrayBuffer>; readonly duenosPorRanura: DuenosBroker;
  controlLargo: BigInt64Array<SharedArrayBuffer>; agrupado: boolean;
  medida?: BigInt64Array<SharedArrayBuffer>; porCoste?: boolean;
}
export interface EpocaBrokerPercepcion extends PuertoBroker { generacion: number; epoca: number }

export function resolverDuenosPercepcionGpu(hilos: number, gpu: readonly number[], duenos?: readonly number[],
  grupos?: readonly (readonly number[])[]): DuenosBroker[] | undefined {
  const simple = gpu.length === 1 && (gpu[0] === 0 || gpu[0] === 1);
  const dual = gpu.length === 2 && gpu[0] === 0 && gpu[1] === 1;
  if ((!simple && !dual) || !Number.isSafeInteger(hilos) || hilos < 2) return undefined;
  if (grupos !== undefined) {
    if (duenos !== undefined || !Array.isArray(grupos) || grupos.length !== gpu.length) return undefined;
    const usados = new Set<number>();
    const resultado: number[][] = [];
    for (const grupo of grupos) {
      if (!Array.isArray(grupo) || grupo.length === 0) return undefined;
      const asignados: number[] = [];
      for (const dueno of grupo) {
        if (!Number.isSafeInteger(dueno) || dueno < 0 || dueno >= hilos || usados.has(dueno)) return undefined;
        usados.add(dueno);
        asignados.push(dueno);
      }
      resultado.push(asignados);
    }
    return resultado;
  }
  if (duenos === undefined) return hilos === 2 ? (simple ? [[0, 1]] : [[0, null], [null, 1]]) : undefined;
  if (duenos.length !== gpu.length || (dual && duenos[0] === duenos[1])) return undefined;
  for (const dueno of duenos) if (!Number.isSafeInteger(dueno) || dueno < 0 || dueno >= hilos) return undefined;
  return duenos.map(dueno => [dueno, null]);
}

export function admiteBrokerPercepcionGpu(hilos: number, gpu: readonly number[], duenos?: readonly number[],
  grupos?: readonly (readonly number[])[]): boolean {
  return resolverDuenosPercepcionGpu(hilos, gpu, duenos, grupos) !== undefined;
}

export class BrokerPercepcionGpu {
  readonly #puertos: PuertoBroker;
  readonly #worker: Worker;
  readonly #salida: Promise<void>;
  #cerrando = false;
  readonly listo: Promise<boolean>;

  constructor(opciones?: OpcionesCanalGpu, medir = false, dispositivo = 0, duenosPorRanura: DuenosBroker = [0, 1],
    agrupado = duenosPorRanura.length > 2) {
    const asignacion = Object.freeze([...duenosPorRanura]);
    const duenos = asignacion.filter(dueno => dueno !== null);
    if (duenos.length === 0 || new Set(duenos).size !== duenos.length ||
      duenos.some(dueno => !Number.isSafeInteger(dueno) || dueno < 0) ||
      (agrupado ? duenos.length !== asignacion.length : asignacion.length !== 2)) {
      throw new RangeError('Asignación de dueños inválida para el corredor de percepción.');
    }
    this.#puertos = { dispositivo, canal: `atlas-percepcion-duenos-${randomUUID()}`,
      duenosPorRanura: asignacion, agrupado,
      control: new Int32Array(new SharedArrayBuffer((CONTROL.ranuras + asignacion.length * RANURA.celdas) * Int32Array.BYTES_PER_ELEMENT)),
      controlLargo: new BigInt64Array(new SharedArrayBuffer(CONTROL_LARGO.celdas * BigInt64Array.BYTES_PER_ELEMENT)) };
    if (process.env.CARTA_PERCEPCION_COSTE_DUENOS === '1') this.#puertos.porCoste = true;
    if (medir || this.#puertos.porCoste) this.#puertos.medida =
      new BigInt64Array(new SharedArrayBuffer((MEDIDA.ranuras + asignacion.length * MEDIDA_RANURA.celdas) * BigInt64Array.BYTES_PER_ELEMENT));
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
      desactivar(this.#puertos);
      resolve();
    }));
    this.#worker.on('error', () => desactivar(this.#puertos));
    this.listo = Promise.race([
      new Promise<boolean>(resolve => this.#worker.once('message', resolve)),
      this.#salida.then(() => false),
    ]);
  }

  abrirEpoca(epoca: number): EpocaBrokerPercepcion {
    const { control, controlLargo, duenosPorRanura } = this.#puertos;
    const generacion = Atomics.load(control, CONTROL.generacion) + 1;
    if (generacion > MAX_GENERACION || !Number.isSafeInteger(epoca) || epoca < 0) throw new RangeError('Época de percepción GPU inválida.');
    Atomics.store(controlLargo, CONTROL_LARGO.epoca, BigInt(epoca));
    Atomics.store(control, CONTROL.generacion, generacion);
    Atomics.store(control, CONTROL.ocupado, 0);
    duenosPorRanura.forEach((_, ranura) => {
      Atomics.store(control, celda(ranura, RANURA.permiso), 0);
      despertar(control, ranura);
    });
    return { ...this.#puertos, epoca, generacion };
  }

  medidas() {
    const { control: c, duenosPorRanura } = this.#puertos;
    const generacion = Atomics.load(c, CONTROL.generacion);
    return { lista: Atomics.load(c, CONTROL.listo) === 1,
      aceptaEnEpoca: generacion > 0 && duenosPorRanura.some((_, r) => Atomics.load(c, celda(r, RANURA.validacion)) === generacion),
      bytes: Atomics.load(c, CONTROL.bytes), ms: Atomics.load(c, CONTROL.micros) / 1000,
      completadas: duenosPorRanura.map((_, r) => Atomics.load(c, celda(r, RANURA.completadas))),
      peticiones: Atomics.load(c, CONTROL.peticiones), detalle: this.#detalle() };
  }

  #detalle(): TelemetriaBrokerGpu | undefined {
    const { medida: m, duenosPorRanura, agrupado, porCoste } = this.#puertos;
    if (!m) return undefined;
    const leer = (i: number) => Number(Atomics.load(m, i));
    return { lotes: leer(MEDIDA.lotes), completadas: duenosPorRanura.map((_, r) => leer(celdaMedida(r, MEDIDA_RANURA.completadas))),
      aceptadas: duenosPorRanura.map((_, r) => leer(celdaMedida(r, MEDIDA_RANURA.aceptadas))), rechazadas: leer(MEDIDA.rechazada),
      cpuArranque: leer(MEDIDA.cpuArranque), cpuOcupada: leer(MEDIDA.cpuOcupada), cpuSinCanal: leer(MEDIDA.cpuSinCanal),
      ...(porCoste && { cpuPorCoste: leer(MEDIDA.cpuPorCoste) }),
      ...(agrupado && { colaMicros: leer(MEDIDA.colaMicros), cpuColaVencida: leer(MEDIDA.cpuColaVencida) }),
      erroresCanal: leer(MEDIDA.errores), subidaConfirmadaBytes: leer(MEDIDA.subida), bajadaConfirmadaBytes: leer(MEDIDA.bajada),
      cudaConfirmadaMicros: leer(MEDIDA.cudaMicros), recorridoConfirmadoMicros: leer(MEDIDA.recorridoMicros),
      preparacionMicros: leer(MEDIDA.preparacionMicros) };
  }

  cerrar(): Promise<void> {
    if (!this.#cerrando) {
      this.#cerrando = true;
      desactivar(this.#puertos);
      this.#worker.postMessage('cerrar');
    }
    return this.#salida;
  }
}

/** El dueño empaqueta desde su captura F2. El corredor solo ve el paquete, nunca las páginas vivas del dueño. */
class CanalPercepcionBroker implements CanalGpu {
  readonly #puerto: BroadcastChannel;
  readonly #ranura: number;
  readonly #celdaPermiso: number;
  readonly #permiso: number;
  #datos = new Uint8Array(new SharedArrayBuffer(0));
  #pendiente?: Peticion;
  #reserva?: bigint;
  #cerrado = false;

  constructor(private readonly epoca: EpocaBrokerPercepcion, private readonly dueno: number) {
    const ranura = epoca.duenosPorRanura.indexOf(dueno);
    if (ranura < 0) throw new RangeError(`El dueño ${dueno} no está asignado a este corredor de percepción.`);
    this.#ranura = ranura;
    this.#celdaPermiso = celdaPermiso(epoca.agrupado, ranura);
    this.#permiso = turno(epoca.agrupado, epoca.generacion, ranura);
    this.#puerto = new BroadcastChannel(`${epoca.canal}:${ranura}`);
    this.#puerto.unref();
  }

  get dispositivo(): number { return this.epoca.dispositivo; }
  get bytes(): number { return this.#datos.length; }
  #cabeEnGrupo(nuevo: number): boolean {
    const { agrupado, control, controlLargo, duenosPorRanura } = this.epoca;
    if (!agrupado) return true;
    const finActivo = Atomics.load(controlLargo, CONTROL_LARGO.finActivo);
    if (finActivo && restante(finActivo) <= 0) return false;
    const servicio = servicioEstimado(controlLargo, this.epoca.generacion);
    if (!servicio) return true; // Primera tanda de la época: admite hasta una por ranura.
    let reservas = nuevo;
    for (let r = 0; r < duenosPorRanura.length; r++) if (Atomics.load(control, celda(r, RANURA.permiso))) reservas++;
    return reservas * servicio < LIMITE_MS * 1000;
  }
  obstaculo(comprobarOcupacion: boolean): MotivoCpu | undefined {
    const { control, generacion } = this.epoca;
    const listo = Atomics.load(control, CONTROL.listo);
    if (this.#cerrado || listo !== 1 || Atomics.load(control, CONTROL.generacion) !== generacion) {
      return listo === 0 && !this.#cerrado ? 'cpuArranque' : 'cpuSinCanal';
    }
    if (comprobarOcupacion && (Atomics.load(control, this.#celdaPermiso) !== 0 || !this.#cabeEnGrupo(1))) return 'cpuOcupada';
  }
  anotarRuta(ruta: MotivoCpu | 'cpuPorCoste' | 'lotes'): void {
    if (this.epoca.medida) Atomics.add(this.epoca.medida, MEDIDA[ruta], 1n);
  }
  admitir(): boolean {
    const { control, generacion } = this.epoca;
    const obstaculo = this.obstaculo(false);
    if (obstaculo) { this.anotarRuta(obstaculo); return false; }
    if (Atomics.compareExchange(control, this.#celdaPermiso, 0, this.#permiso) !== 0) {
      this.anotarRuta('cpuOcupada');
      return false;
    }
    if (Atomics.load(control, CONTROL.generacion) !== generacion) {
      Atomics.compareExchange(control, this.#celdaPermiso, this.#permiso, 0);
      this.anotarRuta('cpuSinCanal');
      return false;
    }
    // Reserva como máximo una tanda por dueño; si el trabajo admitido no parece caber, el dueño va a CPU sin empaquetar.
    if (!this.#cabeEnGrupo(0)) {
      Atomics.compareExchange(control, this.#celdaPermiso, this.#permiso, 0);
      this.anotarRuta('cpuOcupada');
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
    const respuesta = new SharedArrayBuffer(24);
    // El dueño ya acabó de empaquetar. Los 50 ms cubren buzón, copias y respuesta del servidor.
    const enviada = process.hrtime.bigint(), inicio = this.#reserva;
    const peticion: Peticion = {
      identidad: { generacion, epoca, dueno: this.dueno, tick: orden.tick, despacho: orden.despacho },
      orden, inicio, enviada, fin: enviada + PLAZO_TRANSITO_NANOS, datos: this.#datos,
      estado: new Int32Array(respuesta, 0, 1), tiempo: new Float64Array(respuesta, 8, 1),
      tomada: new BigInt64Array(respuesta, 16, 1),
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
    const { control, controlLargo, agrupado, medida } = this.epoca;
    const senal = celda(this.#ranura, RANURA.senal), limite = performance.now() + plazoMs;
    for (;;) {
      const aviso = Atomics.load(control, senal), queda = Math.min(limite - performance.now(), restante(fin));
      if (queda <= 0 || Atomics.load(estado, 0) > ESTADO.enServidor || Atomics.load(control, CONTROL.listo) !== 1
        || Atomics.load(control, CONTROL.generacion) !== identidad.generacion) break;
      Atomics.wait(control, senal, aviso, queda);
    }
    const antes = cancelar(estado);
    this.#pendiente = undefined;
    if (agrupado && medida) {
      const tomada = Atomics.load(peticion.tomada, 0) || process.hrtime.bigint();
      Atomics.add(medida, MEDIDA.colaMicros, (tomada - peticion.enviada) / 1000n);
    }
    const vigente = Atomics.load(control, CONTROL.generacion) === identidad.generacion
      && Atomics.load(controlLargo, CONTROL_LARGO.epoca) === BigInt(identidad.epoca) && Atomics.load(control, CONTROL.listo) === 1;
    if (antes !== ESTADO.lista || restante(fin) <= 0 || !vigente) {
      if (TRAZAR) trazar('sin-respuesta', this.dispositivo, { ...identidad, estado: antes,
        lista: Atomics.load(control, CONTROL.listo), restanteMs: restante(fin), desdeEnvioMs: -restante(peticion.enviada) });
      if (agrupado && vigente && (antes === ESTADO.enCola || antes === ESTADO.descartada)) {
        // El broker pudo leer el paquete para la subida. No se reutiliza su memoria aunque no se haya enviado la orden.
        this.#datos = new Uint8Array(new SharedArrayBuffer(0));
        throw new DespachoGpuDescartado(this);
      }
      throw new ErrorDispositivo(`gpu${this.dispositivo}`, 'El corredor no confirmó el despacho de este dueño y generación.');
    }
    if (medida) {
      Atomics.add(medida, celdaMedida(this.#ranura, MEDIDA_RANURA.completadas), 1n);
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
    if (this.epoca.medida) Atomics.add(this.epoca.medida, error instanceof DespachoGpuDescartado ? MEDIDA.cpuColaVencida : MEDIDA.errores, 1n);
  }
  anotarValidacion(aceptada: boolean): void {
    if (this.#validarEnEpoca(aceptada) && this.epoca.medida)
      Atomics.add(this.epoca.medida, aceptada ? celdaMedida(this.#ranura, MEDIDA_RANURA.aceptadas) : MEDIDA.rechazada, 1n);
  }
  #validarEnEpoca(aceptada: boolean): boolean {
    const { control, generacion } = this.epoca;
    if (Atomics.load(control, CONTROL.generacion) !== generacion) return false;
    const posicion = celda(this.#ranura, RANURA.validacion);
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
    if (this.#reserva !== undefined) Atomics.compareExchange(this.epoca.control, this.#celdaPermiso, this.#permiso, 0);
    if (this.#pendiente) cancelar(this.#pendiente.estado);
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
  const { canal, control, controlLargo, dispositivo, duenosPorRanura, agrupado, medida } = puertos;
  const port = parentPort!;
  let gpu: CanalCompartido | undefined;
  const entradas: BroadcastChannel[] = [];
  const cerrar = () => {
    desactivar(puertos);
    for (const entrada of entradas) entrada.close();
    gpu?.cerrar();
    port.close();
  };
  try {
    gpu = new CanalCompartido(dispositivo, opciones);
    gpu.iniciar(3000);
    for (const [ranura, dueno] of duenosPorRanura.entries()) {
      if (dueno === null) continue;
      const posicion = celdaPermiso(agrupado, ranura);
      const entrada = new BroadcastChannel(`${canal}:${ranura}`);
      entradas.push(entrada);
      entrada.onmessage = ({ data }) => {
        const { identidad: id, orden, enviada, fin, estado, datos, tiempo, tomada } = data as Peticion;
        if (id.dueno !== dueno || id.tick !== orden.tick || id.despacho !== orden.despacho || !Number.isSafeInteger(id.epoca)) return;
        const permiso = turno(agrupado, id.generacion, ranura), epoca = BigInt(id.epoca);
        const pertenece = () => Atomics.load(control, CONTROL.generacion) === id.generacion
          && Atomics.load(controlLargo, CONTROL_LARGO.epoca) === epoca && Atomics.load(control, CONTROL.listo) === 1;
        const vigente = () => pertenece() && Atomics.load(control, posicion) === permiso
          && Atomics.load(estado, 0) === ESTADO.enCola && restante(fin) > 0;
        const desde = agrupado ? process.hrtime.bigint() : 0n;
        if (agrupado && medida) Atomics.store(tomada, 0, desde);
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
          medir('copiarSubidaMs');
          if (datos.length > gpu!.bytes) gpu!.crecer(datos.length);
          gpu!.escribir(0, datos.subarray(0, orden.subida));
          medir('enviarOrdenMs');
          // La carrera con el dueño se decide antes de escribir a Python. Solo después de ganar puede tocar el espejo.
          if (!vigente() || Atomics.compareExchange(estado, 0, ESTADO.enCola, ESTADO.enServidor) !== ESTADO.enCola) {
            if (TRAZAR) trazar('descartada', dispositivo, { ...id, etapa: fase, estado: Atomics.load(estado, 0), restanteMs: restante(fin), ...tiempos });
            return;
          }
          if (!pertenece() || restante(fin) <= 0 || Atomics.load(estado, 0) !== ESTADO.enServidor) {
            Atomics.compareExchange(estado, 0, ESTADO.enServidor, ESTADO.descartada);
            return;
          }
          if (agrupado) Atomics.store(controlLargo, CONTROL_LARGO.finActivo, fin);
          enviarOrden(gpu!, { ...orden, ...id });
          Atomics.add(control, CONTROL.peticiones, 1);
          medir('esperarRespuestaMs');
          const respuesta = recibirRespuesta<Identidad & { ok: boolean; ms: number }>(gpu!, Math.max(0, restante(fin)));
          medir('copiarBajadaMs');
          if (!respuesta.ok || !Number.isFinite(respuesta.ms) || respuesta.ms < 0
            || respuesta.generacion !== id.generacion || respuesta.epoca !== id.epoca || respuesta.dueno !== id.dueno
            || respuesta.tick !== id.tick || respuesta.despacho !== id.despacho) {
            throw new ErrorDispositivo(`gpu${dispositivo}`, 'El corredor recibió el eco de otro despacho.');
          }
          if (pertenece() && restante(fin) > 0 && Atomics.load(estado, 0) === ESTADO.enServidor) {
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
          if (agrupado) Atomics.store(controlLargo, CONTROL_LARGO.finActivo, 0n);
          if (TRAZAR && ms !== undefined) {
            medir('fin');
            trazar('respuesta', dispositivo, { ...id, cudaMs: ms, restanteMs: restante(fin), ...tiempos });
          }
          Atomics.compareExchange(control, posicion, permiso, 0);
          if (ms !== undefined && pertenece() && restante(fin) > 0
            && Atomics.compareExchange(estado, 0, ESTADO.enServidor, ESTADO.lista) === ESTADO.enServidor) {
            Atomics.add(control, celda(ranura, RANURA.completadas), 1);
            Atomics.store(control, CONTROL.micros, Math.round(ms * 1000));
            Atomics.store(control, CONTROL.bytes, orden.subida + orden.bajada);
            if (agrupado) {
              const servicio = Math.max(1, Number((process.hrtime.bigint() - desde) / 1000n));
              const previo = servicioEstimado(controlLargo, id.generacion);
              const media = previo ? Math.round(0.75 * previo + 0.25 * servicio) : servicio;
              Atomics.store(controlLargo, CONTROL_LARGO.servicio, (BigInt(id.generacion) << 32n) | BigInt(media));
            }
          } else {
            Atomics.compareExchange(estado, 0, ESTADO.enCola, ESTADO.descartada);
            Atomics.compareExchange(estado, 0, ESTADO.enServidor, ESTADO.fallo);
          }
          despertar(control, ranura);
        }
      };
    }
  } catch { port.postMessage(false); cerrar(); return; }
  port.on('message', cerrar);
  if (Atomics.compareExchange(control, CONTROL.listo, 0, 1) === 0) port.postMessage(true);
  else cerrar();
}

if (!isMainThread && workerData?.role === 'carta-gpu-duenos') atender(workerData, workerData.opciones);
