import { deserialize, serialize } from 'node:v8';
import { MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { World } from '../mundo/tipos.js';
import { prepararFaunaCorte, vincularFaunaCorte, type BloqueFaunaCorte } from './fauna-corte.js';
import type { ParteFotoDueno } from './fotograma-dueno.js';
import { parteCorteDe, type ParteMundo } from './reunir.js';

export type SolicitudCorte = BigUint64Array<SharedArrayBuffer>;
const SOLICITUD = 0, PREPARAR_FAUNA = 1;

interface ParteCorte {
  solicitud: bigint;
  epoca: number;
  tick: number;
  dueno: number;
  bytes: Uint8Array;
  fauna?: readonly BloqueFaunaCorte[];
}

interface FotoTransferida {
  tipo: 'foto';
  epoca: number;
  parte: ParteFotoDueno;
}

export function enviarParteFoto(puerto: MessagePort, epoca: number, parte: ParteFotoDueno): void {
  const bloques = new Set<ArrayBuffer>();
  for (const bytes of [parte.bajasBytes, parte.altasBytes]) {
    if (bytes.byteLength === 0) continue;
    if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength)
      throw new Error('El bloque de fotograma debe ocupar su propio ArrayBuffer.');
    bloques.add(bytes.buffer);
  }
  const entrega: FotoTransferida = { tipo: 'foto', epoca, parte };
  puerto.postMessage(entrega, [...bloques]);
}

/** Se transfiere el bloque de V8 tal cual. Un runtime que no lo pueda mover falla antes de construir el corte. */
export function enviarParteCorte(puerto: MessagePort, solicitud: SolicitudCorte, epoca: number, dueno: number, mundo: World): void {
  const contenido = parteCorteDe(mundo);
  const bytes = serialize(contenido), buffer = bytes.buffer;
  if (!(buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== buffer.byteLength)
    throw new Error('V8 no entregó un bloque de corte transferible entero.');
  const parte: ParteCorte = { solicitud: Atomics.load(solicitud, SOLICITUD), epoca, tick: mundo.tick, dueno, bytes };
  const transferibles = [buffer];
  if (Atomics.load(solicitud, PREPARAR_FAUNA) === 1n) {
    parte.fauna = prepararFaunaCorte(contenido.animals);
    for (const { cuerpo } of parte.fauna) {
      if (!(cuerpo.buffer instanceof ArrayBuffer) || cuerpo.byteOffset !== 0 || cuerpo.byteLength !== cuerpo.buffer.byteLength)
        throw new Error('El bloque de fauna debe ocupar su propio ArrayBuffer.');
      transferibles.push(cuerpo.buffer);
    }
  }
  puerto.postMessage(parte, transferibles);
  if (transferibles.some(bloque => bloque.byteLength !== 0)) throw new Error('Un bloque de corte no se desprendió al enviarlo.');
}

/** Un canal por dueño remoto, nuevo en cada apertura. Solo se elige F0 antes de abrir la piscina. */
export class CanalesCorte {
  readonly solicitud = new BigUint64Array(new SharedArrayBuffer(2 * BigUint64Array.BYTES_PER_ELEMENT));
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

  pedir(prepararFauna = false): bigint {
    Atomics.store(this.solicitud, PREPARAR_FAUNA, prepararFauna ? 1n : 0n);
    return BigInt.asUintN(64, Atomics.add(this.solicitud, SOLICITUD, 1n) + 1n);
  }

  /** La barrera de reunir ya terminó. Una respuesta llega antes de que su dueño indique que terminó. */
  recibir(solicitud: bigint, epoca: number, tick: number): ParteMundo[] {
    const conFauna = Atomics.load(this.solicitud, PREPARAR_FAUNA) === 1n;
    return this.entradas.map((puerto, i) => {
      const dueno = i + 1;
      const parte = receiveMessageOnPort(puerto)?.message as ParteCorte | undefined;
      if (!parte || parte.dueno !== dueno || parte.solicitud !== solicitud || parte.epoca !== epoca || parte.tick !== tick
        || !(parte.bytes instanceof Uint8Array) || parte.bytes.byteLength === 0 || receiveMessageOnPort(puerto) !== undefined)
        throw new Error(`Instantánea incompleta o incoherente para el dueño ${dueno}.`);
      const contenido = deserialize(parte.bytes) as ParteMundo;
      if (contenido.tick !== tick) throw new Error(`El mundo del dueño ${dueno} no pertenece al tick del corte.`);
      // Si falta la optimización, el guardado conserva las filas canónicas de este dueño.
      const bloques = conFauna ? parte.fauna : undefined;
      if (Array.isArray(bloques) && bloques.length && Array.isArray(contenido.animals)
        && validarFaunaCorte(bloques, contenido.animals.length)) {
        vincularFaunaCorte(contenido.animals, [{ desde: 0, bloques }]);
      }
      return contenido;
    });
  }

  /** F6 ya terminó y el coordinador aún no puede pedir otro corte. Un dueño sin parte provoca el camino reunido. */
  recibirFotos(epoca: number, tick: number): ParteFotoDueno[] {
    const partes: ParteFotoDueno[] = [];
    for (const [i, puerto] of this.entradas.entries()) {
      const entrega = receiveMessageOnPort(puerto)?.message as FotoTransferida | undefined;
      let repetida = false;
      while (receiveMessageOnPort(puerto) !== undefined) repetida = true;
      if (repetida || entrega?.tipo !== 'foto' || entrega.epoca !== epoca || entrega.parte?.tick !== tick
        || entrega.parte.hilo !== i + 1 || !(entrega.parte.bajasBytes instanceof Uint8Array)
        || !(entrega.parte.altasBytes instanceof Uint8Array)) continue;
      partes.push(entrega.parte);
    }
    return partes;
  }

  cerrar(): void {
    for (const puerto of this.entradas) puerto.close();
    for (const puerto of this.puertosRemotos) puerto.close();
  }
}

function validarFaunaCorte(bloques: readonly BloqueFaunaCorte[], esperadas: number): boolean {
  let filas = 0;
  for (const bloque of bloques) {
    if (!Number.isSafeInteger(bloque?.filas) || bloque.filas <= 0 || !(bloque.cuerpo instanceof Uint8Array)
      || bloque.cuerpo.byteLength === 0 || !(bloque.cuerpo.buffer instanceof ArrayBuffer)
      || bloque.cuerpo.byteOffset !== 0 || bloque.cuerpo.byteLength !== bloque.cuerpo.buffer.byteLength) return false;
    filas += bloque.filas;
    if (filas > esperadas) return false;
  }
  return filas === esperadas;
}
