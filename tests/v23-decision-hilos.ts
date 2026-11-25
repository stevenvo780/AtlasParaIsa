/**
 * Doble mínimo de percepción en N hilos para las pruebas de M2b: reparte el lote en tandas de `tanda` slots (64, como
 * el contrato, por defecto) que los workers reclaman con `Atomics.add` (ARQ-motor §3.1, F2) y escriben en una salida
 * compartida. Cuenta cuántas filas percibió cada worker, para que una prueba pueda exigir que el reparto ocurrió. No es
 * la piscina del motor: solo comprueba que la percepción es pura y que repartirla no cambia el resultado.
 */
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import type { LotePercepcion, Percibidor, Plan } from '../src/world/motor/contratos.js';
import { VistaMundo, percibirLote, reservarPercepcion, sellar, type DescriptorVista, type PercepcionCpu } from '../src/world/decision/percepcion.js';

interface Trabajo {
  descriptor: DescriptorVista; lote: LotePercepcion; planes: readonly Plan[]; salida: PercepcionCpu;
  control: Int32Array; filas: Int32Array; indice: number; tanda: number; hilos: number;
}

export class PercibidorHilos implements Percibidor {
  readonly dispositivo = 'cpu' as const;
  /** Filas que percibió cada worker, sumadas en todos los despachos. */
  readonly filasPorHilo: number[];
  /** Despachos con más de una tanda y despachos en que más de un worker percibió filas. */
  despachosConVariasTandas = 0; despachosRepartidos = 0;
  readonly #workers: Worker[];
  #salida: PercepcionCpu | undefined;
  // [0] siguiente tanda, [1] workers que terminaron, [2] errores, [3] workers listos para reclamar
  readonly #control = new Int32Array(new SharedArrayBuffer(16));
  readonly #filas: Int32Array;
  #n = 0;
  constructor(private readonly vista: VistaMundo, hilos: number, private readonly tanda = 64) {
    this.#workers = Array.from({ length: hilos }, () => {
      const worker = new Worker(new URL(import.meta.url));
      worker.unref();
      return worker;
    });
    this.#filas = new Int32Array(new SharedArrayBuffer(4 * hilos));
    this.filasPorHilo = new Array<number>(hilos).fill(0);
  }
  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    const salida = this.#salida = reservarPercepcion(lote.slots.length, planes, this.#salida, true);
    sellar(salida, lote);
    this.#n = lote.slots.length;
    for (let i = 0; i < 4; i++) Atomics.store(this.#control, i, 0);
    this.#filas.fill(0);
    const descriptor = this.vista.descriptor();
    this.#workers.forEach((worker, indice) => worker.postMessage({ descriptor, lote, planes, salida, control: this.#control, filas: this.#filas, indice, tanda: this.tanda,
      hilos: this.#workers.length } satisfies Trabajo));
  }
  esperar(plazoMs: number): PercepcionCpu {
    const limite = Date.now() + plazoMs * 10;
    for (let hechos; (hechos = Atomics.load(this.#control, 1)) < this.#workers.length;) {
      if (Date.now() > limite) throw new Error('El doble de hilos no terminó a tiempo');
      Atomics.wait(this.#control, 1, hechos, 100);
    }
    if (Atomics.load(this.#control, 2) > 0) throw new Error('Un worker del doble falló');
    let conFilas = 0, total = 0;
    for (let h = 0; h < this.#workers.length; h++) { this.filasPorHilo[h]! += this.#filas[h]!; total += this.#filas[h]!; if (this.#filas[h]! > 0) conFilas++; }
    if (total !== this.#n) throw new Error(`El doble de hilos percibió ${total} filas de ${this.#n}`);
    if (this.#n > this.tanda) this.despachosConVariasTandas++;
    if (conFilas > 1) this.despachosRepartidos++;
    return this.#salida!;
  }
  async cerrar(): Promise<void> { await Promise.all(this.#workers.map(w => w.terminate())); }
}

if (!isMainThread) {
  parentPort!.on('message', ({ descriptor, lote, planes, salida, control, filas, indice, tanda, hilos }: Trabajo) => {
    try {
      const vista = VistaMundo.desde(descriptor);
      // Nadie reclama hasta que todos estén listos: si no, el primero en despertar se lleva un lote corto entero.
      Atomics.add(control, 3, 1);
      Atomics.notify(control, 3);
      for (let listos; (listos = Atomics.load(control, 3)) < hilos;) Atomics.wait(control, 3, listos, 100);
      for (let desde; (desde = Atomics.add(control, 0, tanda)) < lote.slots.length;) {
        const hasta = Math.min(lote.slots.length, desde + tanda);
        percibirLote(vista, lote, planes, salida, desde, hasta);
        Atomics.add(filas, indice, hasta - desde);
      }
    } catch (error) {
      Atomics.add(control, 2, 1);
      console.error(error);
    } finally {
      Atomics.add(control, 1, 1);
      Atomics.notify(control, 1);
    }
  });
}
