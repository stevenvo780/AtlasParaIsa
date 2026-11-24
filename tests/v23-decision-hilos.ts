/**
 * Doble mínimo de percepción en N hilos para las pruebas de M2b: reparte el lote en tandas de 64 slots que los
 * workers reclaman con `Atomics.add` (ARQ-motor §3.1, F2) y escriben en una salida compartida. No es la piscina del
 * motor: solo comprueba que la percepción es pura y que repartirla no cambia el resultado.
 */
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import type { LotePercepcion, Percibidor, Plan } from '../src/world/motor/contratos.js';
import { VistaMundo, percibirLote, reservarPercepcion, type DescriptorVista, type PercepcionCpu } from '../src/world/decision/percepcion.js';

const TANDA = 64;

interface Trabajo { descriptor: DescriptorVista; lote: LotePercepcion; planes: readonly Plan[]; salida: PercepcionCpu; control: Int32Array }

export class PercibidorHilos implements Percibidor {
  readonly dispositivo = 'cpu' as const;
  readonly #workers: Worker[];
  #salida: PercepcionCpu | undefined;
  // [0] siguiente tanda, [1] workers que terminaron, [2] errores
  #control = new Int32Array(new SharedArrayBuffer(12));
  constructor(private readonly vista: VistaMundo, hilos: number) {
    this.#workers = Array.from({ length: hilos }, () => {
      const worker = new Worker(new URL(import.meta.url));
      worker.unref();
      return worker;
    });
  }
  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    this.#salida = reservarPercepcion(lote.slots.length, planes, this.#salida, true);
    Atomics.store(this.#control, 0, 0); Atomics.store(this.#control, 1, 0); Atomics.store(this.#control, 2, 0);
    const trabajo: Trabajo = { descriptor: this.vista.descriptor(), lote, planes, salida: this.#salida, control: this.#control };
    for (const worker of this.#workers) worker.postMessage(trabajo);
  }
  esperar(plazoMs: number): PercepcionCpu {
    const limite = Date.now() + plazoMs * 10;
    for (let hechos; (hechos = Atomics.load(this.#control, 1)) < this.#workers.length;) {
      if (Date.now() > limite) throw new Error('El doble de hilos no terminó a tiempo');
      Atomics.wait(this.#control, 1, hechos, 100);
    }
    if (Atomics.load(this.#control, 2) > 0) throw new Error('Un worker del doble falló');
    return this.#salida!;
  }
  async cerrar(): Promise<void> { await Promise.all(this.#workers.map(w => w.terminate())); }
}

if (!isMainThread) {
  parentPort!.on('message', ({ descriptor, lote, planes, salida, control }: Trabajo) => {
    try {
      const vista = VistaMundo.desde(descriptor);
      for (let desde; (desde = Atomics.add(control, 0, TANDA)) < lote.slots.length;)
        percibirLote(vista, lote, planes, salida, desde, Math.min(lote.slots.length, desde + TANDA));
    } catch (error) {
      Atomics.add(control, 2, 1);
      console.error(error);
    } finally {
      Atomics.add(control, 1, 1);
      Atomics.notify(control, 1);
    }
  });
}
