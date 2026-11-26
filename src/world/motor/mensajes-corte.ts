import { deserialize, serialize } from 'node:v8';
import { MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { World } from '../mundo/tipos.js';

export type SolicitudCorte = BigUint64Array<SharedArrayBuffer>;

interface ParteCorte {
  solicitud: bigint;
  epoca: number;
  tick: number;
  dueno: number;
  bytes: Uint8Array;
}

/** Se transfiere el bloque de V8 tal cual. Un runtime que no lo pueda mover falla antes de construir el corte. */
export function enviarParteCorte(puerto: MessagePort, solicitud: SolicitudCorte, epoca: number, dueno: number, mundo: World): void {
  const bytes = serialize(mundo), buffer = bytes.buffer;
  if (!(buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== buffer.byteLength)
    throw new Error('V8 no entregó un bloque de corte transferible entero.');
  const parte: ParteCorte = { solicitud: Atomics.load(solicitud, 0), epoca, tick: mundo.tick, dueno, bytes };
  puerto.postMessage(parte, [buffer]);
  if (buffer.byteLength !== 0) throw new Error('El bloque de corte no se desprendió al enviarlo.');
}

/** Un canal por dueño remoto, nuevo en cada apertura. Solo se elige F0 antes de abrir la piscina. */
export class CanalesCorte {
  readonly solicitud = new BigUint64Array(new SharedArrayBuffer(BigUint64Array.BYTES_PER_ELEMENT));
  private readonly entradas: MessagePort[] = [];
  readonly puertosRemotos: MessagePort[] = [];

  private constructor() {}

  static abrir(remotos: number): CanalesCorte | undefined {
    const canales = new CanalesCorte();
    try {
      for (let i = 0; i < remotos; i++) {
        const { port1, port2 } = new MessageChannel();
        canales.entradas.push(port1);
        canales.puertosRemotos.push(port2);
        port1.unref();
      }
      return canales;
    } catch {
      canales.cerrar();
      return undefined;
    }
  }

  pedir(): bigint {
    return BigInt.asUintN(64, Atomics.add(this.solicitud, 0, 1n) + 1n);
  }

  /** La barrera de reunir ya terminó. Una respuesta llega antes de que su dueño indique que terminó. */
  recibir(solicitud: bigint, epoca: number, tick: number): World[] {
    return this.entradas.map((puerto, i) => {
      const dueno = i + 1;
      const parte = receiveMessageOnPort(puerto)?.message as ParteCorte | undefined;
      if (!parte || parte.dueno !== dueno || parte.solicitud !== solicitud || parte.epoca !== epoca || parte.tick !== tick
        || !(parte.bytes instanceof Uint8Array) || parte.bytes.byteLength === 0 || receiveMessageOnPort(puerto) !== undefined)
        throw new Error(`Instantánea incompleta o incoherente para el dueño ${dueno}.`);
      const mundo = deserialize(parte.bytes) as World;
      if (mundo.tick !== tick) throw new Error(`El mundo del dueño ${dueno} no pertenece al tick del corte.`);
      return mundo;
    });
  }

  cerrar(): void {
    for (const puerto of this.entradas) puerto.close();
    for (const puerto of this.puertosRemotos) puerto.close();
  }
}
