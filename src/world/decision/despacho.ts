/**
 * Quién percibe el lote de F2 en este proceso: la piscina de M1 (todos los hilos del motor reclaman tandas de filas
 * del lote) y las tarjetas de M3 (el puente reparte el lote entre ellas; el tramo de una tarjeta que cae o vence se
 * recalcula en la piscina en el mismo tick). El camino residente trae las ventanas de cada tarjeta. El camino clásico
 * las calcula en la piscina mientras las tarjetas perciben.
 *
 * Los percibidores son del proceso, no del mundo: un mundo clonado, cargado o de otra prueba percibe con los mismos
 * hilos y las mismas tarjetas, que reciben su vista en `fuentes`. Importar este módulo registra la elección en
 * `percepcion.ts` según `motor.hilos` y `motor.gpu`; sin importarlo, cada mundo percibe en el hilo que lo simula.
 *
 * A los hilos de la piscina la vista (los SAB del frente y del terreno), los planes y los búferes del lote y de la
 * salida les llegan por un BroadcastChannel solo cuando cambian (los SAB crecen en su sitio casi siempre); el número de
 * versión va en el SAB de control y un hilo lee los mensajes pendientes con `receiveMessageOnPort` al empezar la fase.
 */
import { BroadcastChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { LotePercepcion, Percibidor, Plan } from '../motor/contratos.js';
import { Piscina } from '../paralelo/piscina.js';
import { crearPuentePercepcion, gpuNvrtcAvailable, type LoteGpuMedido } from '../gpu/puente.js';
import { tieneVentanas } from '../gpu/percibir-gpu.js';
import type { WorldParams } from '../params.js';
import {
  conVentanas, percibirLote, registrarPercibidores, reservarPercepcion, sellar, ventanasLote, VistaMundo,
  type DescriptorVista, type PercepcionCpu, type PercibidorCompartido,
} from './percepcion.js';

/** Fases de la piscina: el lote entero, o solo sus ventanas. */
const FASE = { percibir: 1, ventanas: 2 } as const;
/** Celdas del SAB de control (Int32). */
const CONTROL = { siguiente: 0, n: 1, tanda: 2, version: 3, ranura: 4, activos: 5, celdas: 6 } as const;
/** Filas por tanda (ARQ-motor §3.1, F2). */
export const TANDA_PERCEPCION = 64;
/** Lo que espera un hilo a que le llegue una vista nueva antes de darse por roto. */
const PLAZO_MENSAJE_MS = 10_000;

/** Un lote y su salida, sobre SAB. La ranura 0 es la del lote entero; la 1, la de las ventanas del camino GPU. */
interface Ranura { slots: Int32Array; plan: Uint16Array; salida: PercepcionCpu }
interface Estado { vista: VistaMundo; planes: readonly Plan[]; ranuras: (Ranura | undefined)[] }
interface Mensaje { version: number; descriptor: DescriptorVista; planes: readonly Plan[]; ranuras: (Ranura | undefined)[] }
interface DatosHilos { control: SharedArrayBuffer; filas: SharedArrayBuffer; canal: string }

/** El hilo 0 es el que simula: lee el estado directamente, sin clonarlo. */
const locales = new Map<string, Estado>();
const pausa = new Int32Array(new SharedArrayBuffer(4));

function trabajar(e: Estado, fase: number, control: Int32Array, filas: Float64Array, hilo: number): void {
  const { slots, plan, salida } = e.ranuras[Atomics.load(control, CONTROL.ranura)]!;
  const n = Atomics.load(control, CONTROL.n), tanda = Atomics.load(control, CONTROL.tanda);
  const lote: LotePercepcion = { tick: salida.tick, despacho: salida.despacho, slots, plan };
  let hechas = 0;
  for (let desde; (desde = Atomics.add(control, CONTROL.siguiente, tanda)) < n;) {
    const hasta = Math.min(n, desde + tanda);
    if (fase === FASE.percibir) percibirLote(e.vista, lote, e.planes, salida, desde, hasta);
    else ventanasLote(e.vista, lote, e.planes, salida, desde, hasta);
    hechas += hasta - desde;
  }
  // Cada hilo escribe solo su celda; el coordinador la lee tras la barrera.
  filas[hilo] = filas[hilo]! + hechas;
}

/** Fábrica de cada hilo de la piscina (`OpcionesPiscina.crear`). */
export function crearHiloPercepcion(hilo: number, datos: DatosHilos): (fase: number) => void {
  const control = new Int32Array(datos.control), filas = new Float64Array(datos.filas);
  if (hilo === 0) return fase => trabajar(locales.get(datos.canal)!, fase, control, filas, 0);
  const canal = new BroadcastChannel(datos.canal);
  canal.unref();
  let estado: Estado | undefined, version = 0;
  return fase => {
    const objetivo = Atomics.load(control, CONTROL.version);
    for (const limite = Date.now() + PLAZO_MENSAJE_MS; version < objetivo;) {
      // Node acepta un BroadcastChannel aquí (worker_threads.receiveMessageOnPort); sus tipos solo declaran MessagePort.
      const recibido = receiveMessageOnPort(canal as unknown as MessagePort);
      if (recibido) {
        const m = recibido.message as Mensaje;
        estado = { vista: VistaMundo.desde(m.descriptor), planes: m.planes, ranuras: m.ranuras };
        version = m.version;
      } else if (Date.now() > limite) throw new Error(`El hilo ${hilo} no recibió la vista ${objetivo} de la percepción.`);
      else Atomics.wait(pausa, 0, 0, 1);
    }
    if (hilo < Atomics.load(control, CONTROL.activos)) trabajar(estado!, fase, control, filas, hilo);
  };
}

/** Los SAB que definen una vista: si ninguno cambió, los hilos pueden seguir con la que tienen. */
function buffersDe(d: DescriptorVista): SharedArrayBuffer[] {
  return [d.frente.estado, ...d.frente.columnas.flatMap(c => c.lados), d.terreno.topologia.buffer,
    d.terreno.arena.control, d.terreno.arena.enlaces, ...d.terreno.arena.columnas.map(c => c.memoria)];
}

/** Tiempos de la piscina acumulados desde la última lectura de `medidas`: fases (y cuántas despertaron a la piscina),
 * filas, pared de las fases, espera del que simula en la barrera tras sus tandas, tiempo activo sumado de los hilos,
 * pared × hilos activos (para la ocupación) y vistas nuevas enviadas a los hilos. */
export interface MedidaPiscina {
  fases: number; enPiscina: number; filas: number; paredMs: number; esperaMs: number; activoMs: number; hiloMs: number; mensajes: number;
}
const medidaVacia = (): MedidaPiscina => ({ fases: 0, enPiscina: 0, filas: 0, paredMs: 0, esperaMs: 0, activoMs: 0, hiloMs: 0, mensajes: 0 });

let canales = 0;

/** La percepción del lote en la piscina de M1, con `hilos` hilos contando el que simula. */
export class PercibidorPiscina implements PercibidorCompartido {
  readonly dispositivo = 'cpu' as const;
  /** Filas que percibió cada hilo (0 = el que simula), sumadas desde que se creó. */
  readonly filas: Float64Array;
  tanda = TANDA_PERCEPCION;
  readonly #piscina: Piscina<DatosHilos>;
  readonly #control: Int32Array;
  readonly #canal: BroadcastChannel;
  readonly #nombre: string;
  readonly #ranuras: (Ranura | undefined)[] = [undefined, undefined];
  #vista: VistaMundo | undefined;
  #buffers: SharedArrayBuffer[] = [];
  #planes: readonly Plan[] | undefined;
  #version = 0;
  #cambio = true;
  #activos: number;
  #medida = medidaVacia();

  constructor(readonly hilos: number) {
    this.#nombre = `atlas-percepcion-${process.pid}-${++canales}`;
    const control = new SharedArrayBuffer(CONTROL.celdas * 4), filas = new SharedArrayBuffer(8 * hilos);
    this.#control = new Int32Array(control);
    this.filas = new Float64Array(filas);
    this.#activos = hilos;
    this.#canal = new BroadcastChannel(this.#nombre);
    this.#canal.unref();
    this.#piscina = new Piscina<DatosHilos>({
      hilos, datos: { control, filas, canal: this.#nombre }, crear: crearHiloPercepcion,
      moduleURL: new URL(import.meta.url), exportName: crearHiloPercepcion.name,
    });
  }

  /** Hilos que reclaman tandas desde el próximo despacho (1…`hilos`); los demás despiertan y vuelven a esperar. */
  get activos(): number { return this.#activos; }
  set activos(n: number) { this.#activos = Math.max(1, Math.min(this.hilos, Math.floor(n))); }

  /** Lo medido desde la última lectura (y lo pone a cero). */
  medidas(): MedidaPiscina { const m = this.#medida; this.#medida = medidaVacia(); return m; }

  fuentes(vista: VistaMundo): void {
    if (vista !== this.#vista) { this.#vista = vista; this.#cambio = true; }
  }

  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void { this.#despachar(FASE.percibir, 0, lote, planes); }
  esperar(): PercepcionCpu { return this.#ranuras[0]!.salida; }

  /** Solo las ventanas del lote, en la ranura 1 (la 0 sigue libre para recalcular el tramo de una tarjeta). */
  ventanas(lote: LotePercepcion, planes: readonly Plan[]): PercepcionCpu {
    this.#despachar(FASE.ventanas, 1, lote, planes);
    return this.#ranuras[1]!.salida;
  }

  cerrar(): Promise<void> { this.#canal.close(); return this.#piscina.cerrar(); }

  #despachar(fase: number, r: 0 | 1, lote: LotePercepcion, planes: readonly Plan[]): void {
    const vista = this.#vista;
    if (!vista) throw new Error('La piscina de percepción no tiene vista: falta fuentes(vista).');
    const n = lote.slots.length, previa = this.#ranuras[r];
    const salida = reservarPercepcion(n, planes, previa?.salida, true);
    let ranura = previa;
    if (!ranura || salida !== ranura.salida || ranura.slots.length < n) {
      const cap = Math.max(n, 2 * (previa?.slots.length ?? 0), 64);
      ranura = previa && previa.slots.length >= n ? { ...previa, salida }
        : { slots: new Int32Array(new SharedArrayBuffer(4 * cap)), plan: new Uint16Array(new SharedArrayBuffer(2 * cap)), salida };
      this.#ranuras[r] = ranura;
      this.#cambio = true;
    }
    ranura.slots.set(lote.slots);
    ranura.plan.set(lote.plan);
    sellar(salida, lote);
    const descriptor = vista.descriptor(), buffers = buffersDe(descriptor);
    if (this.#cambio || planes !== this.#planes || buffers.length !== this.#buffers.length || buffers.some((b, i) => b !== this.#buffers[i])) {
      const version = ++this.#version;
      locales.set(this.#nombre, { vista, planes, ranuras: this.#ranuras });
      if (this.hilos > 1) this.#canal.postMessage({ version, descriptor, planes, ranuras: this.#ranuras } satisfies Mensaje);
      Atomics.store(this.#control, CONTROL.version, version);
      this.#buffers = buffers; this.#planes = planes; this.#cambio = false;
      this.#medida.mensajes++;
    }
    const c = this.#control;
    Atomics.store(c, CONTROL.n, n);
    Atomics.store(c, CONTROL.tanda, this.tanda);
    Atomics.store(c, CONTROL.ranura, r);
    Atomics.store(c, CONTROL.activos, this.#activos);
    Atomics.store(c, CONTROL.siguiente, 0);
    // Una sola tanda no compensa despertar a los demás hilos.
    if (n <= this.tanda || this.#activos === 1) {
      const inicio = performance.now();
      trabajar(locales.get(this.#nombre)!, fase, c, this.filas, 0);
      const ms = performance.now() - inicio, m = this.#medida;
      m.fases++; m.filas += n; m.paredMs += ms; m.activoMs += ms; m.hiloMs += ms;
      return;
    }
    this.#piscina.ejecutar(fase);
    const d = this.#piscina.diagnostico(), m = this.#medida;
    m.fases++; m.enPiscina++; m.filas += n; m.paredMs += d.tiempoTotalMs; m.esperaMs += d.esperaBarreraMs;
    m.activoMs += d.tiempoActivoMs.reduce((a, b) => a + b, 0); m.hiloMs += d.tiempoTotalMs * this.#activos;
  }
}

/** Con un solo hilo: el mismo trabajo en el que simula, sobre la vista que se le dé. */
class PercibidorLocal implements PercibidorCompartido {
  readonly dispositivo = 'cpu' as const;
  #vista: VistaMundo | undefined;
  #salida: PercepcionCpu | undefined;
  #ventanas: PercepcionCpu | undefined;
  fuentes(vista: VistaMundo): void { this.#vista = vista; }
  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    this.#salida = reservarPercepcion(lote.slots.length, planes, this.#salida);
    percibirLote(this.#vista!, lote, planes, this.#salida);
    sellar(this.#salida, lote);
  }
  esperar(): PercepcionCpu { return this.#salida!; }
  ventanas(lote: LotePercepcion, planes: readonly Plan[]): PercepcionCpu {
    this.#ventanas = reservarPercepcion(lote.slots.length, planes, this.#ventanas);
    ventanasLote(this.#vista!, lote, planes, this.#ventanas);
    return this.#ventanas;
  }
}

type CpuDelProceso = PercibidorPiscina | PercibidorLocal;

/**
 * Las tarjetas de `motor.gpu` con el CPU del proceso detrás: el puente de M3 les reparte el lote por su ritmo medido;
 * el camino residente reúne las ventanas junto con las propuestas. Si una tarjeta cae, vence o devuelve otra cosa,
 * su tramo se percibe en el CPU en el mismo tick y la tarjeta se apaga para el resto del proceso.
 */
export class PercibidorTarjetas implements PercibidorCompartido {
  readonly dispositivo;
  /** Lotes de cada tarjeta y del CPU en el último despacho, y cuántos tramos fueron al CPU desde que se creó. */
  ultimosLotes: readonly LoteGpuMedido[] = [];
  tramosEnCpu = 0;
  #puente: ReturnType<typeof crearPuentePercepcion> | undefined;
  #lote: LotePercepcion | undefined;
  #planes: readonly Plan[] | undefined;
  #vista: VistaMundo | undefined;
  #salida: PercepcionCpu | undefined;
  #vacio = false;

  constructor(readonly gpu: readonly number[], readonly cpu: CpuDelProceso, readonly ventanasGpu = false, readonly porCoste = false) {
    this.dispositivo = `gpu${gpu[0] ?? 0}` as const;
  }

  /** Tarjetas que siguen activas y sus servidores CUDA. */
  get tarjetas(): number { return this.#puente?.tarjetas ?? 0; }
  pids(): { dispositivo: number; pid: number }[] { return this.#puente?.pids() ?? []; }

  fuentes(vista: VistaMundo): void {
    this.cpu.fuentes(vista);
    this.#vista = vista;
    // Las tarjetas arrancan con el primer mundo (contexto CUDA y NVRTC, fuera del plazo del tick).
    this.#puente ??= crearPuentePercepcion(this.gpu, vista.frente, vista.terreno, this.cpu, false, this.ventanasGpu, this.porCoste);
    this.#puente.fuentes(vista.frente, vista.terreno);
  }

  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    this.#lote = lote; this.#planes = planes;
    // Un lote vacío (nadie decide en este tick) no va a las tarjetas.
    this.#vacio = lote.slots.length === 0;
    if (this.#vacio) this.cpu.lanzar(lote, planes);
    else this.#puente!.puente.lanzar(lote, planes);
  }

  esperar(plazoMs: number): PercepcionCpu {
    if (this.#vacio) return this.cpu.esperar();
    const lote = this.#lote!, planes = this.#planes!;
    const ventanas = this.ventanasGpu ? undefined : this.cpu.ventanas(lote, planes);
    const p = this.#puente!.puente.esperar(plazoMs);
    this.ultimosLotes = this.#puente!.puente.ultimosLotes;
    this.tramosEnCpu += this.ultimosLotes.filter(l => l.dispositivo === 'cpu' && l.actores > 0).length;
    if (this.ventanasGpu && tieneVentanas(p)) return p;
    return this.#salida = conVentanas(this.#vista!, lote, planes, p, this.#salida, ventanas);
  }

  cerrar(): void { this.#puente?.puente.cerrar(); }
}

const piscinas = new Map<number, PercibidorPiscina>();
const tarjetas = new Map<string, PercibidorTarjetas>();
const local = new PercibidorLocal();

/** El CPU del proceso para `hilos` hilos: una piscina por número de hilos, creada al primer uso. */
export function cpuDelProceso(hilos: number): CpuDelProceso {
  if (hilos <= 1) return local;
  let p = piscinas.get(hilos);
  if (!p) { p = new PercibidorPiscina(hilos); piscinas.set(hilos, p); }
  return p;
}

/** El percibidor del proceso para `motor`: tarjetas si las hay y hay NVRTC, si no la piscina, si no el hilo que simula. */
export function percibidorDelProceso(motor: WorldParams['motor']): Percibidor | PercibidorCompartido | undefined {
  if (motor.gpu.length > 0 && gpuNvrtcAvailable()) {
    const porCoste = process.env.CARTA_PERCEPCION_COSTE === '1';
    const ventanasGpu = porCoste || process.env.CARTA_PERCEPCION_RESIDENTE === '1';
    const clave = `${motor.gpu.join(',')}/${motor.hilos}/${ventanasGpu}/${porCoste}`;
    let t = tarjetas.get(clave);
    if (!t) { t = new PercibidorTarjetas(motor.gpu, cpuDelProceso(motor.hilos), ventanasGpu, porCoste); tarjetas.set(clave, t); }
    return t;
  }
  return motor.hilos > 1 ? cpuDelProceso(motor.hilos) : undefined;
}

/** Cierra las piscinas y apaga las tarjetas del proceso (al salir, o entre pruebas). */
export async function cerrarPercibidores(): Promise<void> {
  for (const t of tarjetas.values()) t.cerrar();
  tarjetas.clear();
  await Promise.all([...piscinas.values()].map(p => p.cerrar()));
  piscinas.clear();
}

registrarPercibidores(percibidorDelProceso);
