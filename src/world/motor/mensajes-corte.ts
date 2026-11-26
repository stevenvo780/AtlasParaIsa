import { deserialize, serialize } from 'node:v8';
import { MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { World } from '../mundo/tipos.js';
import { prepararFaunaCorte, prepararFaunaDirecta, recibirFaunaDirecta, validarFaunaCorte, vincularFaunaCorte,
  type BloqueFaunaCorte } from './fauna-corte.js';
import type { ParteFotoDueno } from './fotograma-dueno.js';
import { parteCorteDe, type ParteMundo } from './reunir.js';
import { prepararTeselasDirectas, recibirTeselasDirectas, type BloqueTeselasCorte } from './teselas-corte.js';

export type SolicitudCorte = BigUint64Array<SharedArrayBuffer>;
const SOLICITUD = 0, PREPARAR_FAUNA = 1, PREPARAR_TESELAS = 2;
const SIN_FAUNA = 0n, FAUNA_SOMBRA = 1n, FAUNA_DIRECTA = 2n;

interface ParteCorte {
  solicitud: bigint;
  epoca: number;
  tick: number;
  dueno: number;
  bytes: Uint8Array;
  fauna?: readonly BloqueFaunaCorte[];
  faunaSustituida?: { cantidad: number } | null;
  teselas?: readonly BloqueTeselasCorte[];
  teselasSustituidas?: { cantidad: number } | null;
}

interface DiagnosticoTeselasCorte {
  bytesV8: number; v8Ms: number; bytesTuplas: number; tuplasMs: number; duenosTuplas: number; duenosV8: number;
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
  const modo = Atomics.load(solicitud, PREPARAR_FAUNA);
  const fauna = modo === FAUNA_DIRECTA ? prepararFaunaDirecta(contenido) : undefined;
  const pideTeselas = Atomics.load(solicitud, PREPARAR_TESELAS) === 1n;
  const teselas = pideTeselas ? prepararTeselasDirectas(contenido) : undefined;
  const reducido = fauna || teselas ? { ...contenido, ...(fauna && { animals: [] }), ...(teselas && { tiles: [] }) } : contenido;
  const bytes = serialize(reducido), buffer = bytes.buffer;
  if (!(buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== buffer.byteLength)
    throw new Error('V8 no entregó un bloque de corte transferible entero.');
  const parte: ParteCorte = { solicitud: Atomics.load(solicitud, SOLICITUD), epoca, tick: mundo.tick, dueno, bytes };
  const transferibles = [buffer];
  if (modo === FAUNA_DIRECTA) parte.faunaSustituida = fauna ? { cantidad: fauna.reduce((n, bloque) => n + bloque.filas, 0) } : null;
  if (fauna) parte.fauna = fauna;
  if (modo === FAUNA_SOMBRA) parte.fauna = prepararFaunaCorte(contenido.animals);
  if (pideTeselas) parte.teselasSustituidas = teselas ? { cantidad: teselas.reduce((n, bloque) => n + bloque.filas, 0) } : null;
  if (teselas) parte.teselas = teselas;
  for (const bloques of [parte.fauna, parte.teselas]) {
    if (!bloques) continue;
    for (const { cuerpo } of bloques) {
      if (!(cuerpo.buffer instanceof ArrayBuffer) || cuerpo.byteOffset !== 0 || cuerpo.byteLength !== cuerpo.buffer.byteLength)
        throw new Error('Cada bloque del corte debe ocupar su propio ArrayBuffer.');
      transferibles.push(cuerpo.buffer);
    }
  }
  puerto.postMessage(parte, transferibles);
  if (transferibles.some(bloque => bloque.byteLength !== 0)) throw new Error('Un bloque de corte no se desprendió al enviarlo.');
}

/** Un canal por dueño remoto, nuevo en cada apertura. Solo se elige F0 antes de abrir la piscina. */
export class CanalesCorte {
  readonly solicitud = new BigUint64Array(new SharedArrayBuffer(3 * BigUint64Array.BYTES_PER_ELEMENT));
  private readonly entradas: MessagePort[] = [];
  readonly puertosRemotos: MessagePort[] = [];
  private ultimaRecepcionTeselas?: DiagnosticoTeselasCorte;

  get diagnosticoTeselasCorte(): Readonly<DiagnosticoTeselasCorte> | undefined {
    return this.ultimaRecepcionTeselas;
  }

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

  pedir(prepararFauna: boolean | 'directa' = false, prepararTeselas = false): bigint {
    Atomics.store(this.solicitud, PREPARAR_FAUNA, prepararFauna === 'directa' ? FAUNA_DIRECTA : prepararFauna ? FAUNA_SOMBRA : SIN_FAUNA);
    Atomics.store(this.solicitud, PREPARAR_TESELAS, prepararTeselas ? 1n : 0n);
    return BigInt.asUintN(64, Atomics.add(this.solicitud, SOLICITUD, 1n) + 1n);
  }

  /** La barrera de reunir ya terminó. Una respuesta llega antes de que su dueño indique que terminó. */
  recibir(solicitud: bigint, epoca: number, tick: number): ParteMundo[] {
    const modo = Atomics.load(this.solicitud, PREPARAR_FAUNA);
    const pideTeselas = Atomics.load(this.solicitud, PREPARAR_TESELAS) === 1n;
    const datos = this.ultimaRecepcionTeselas = pideTeselas
      ? { bytesV8: 0, v8Ms: 0, bytesTuplas: 0, tuplasMs: 0, duenosTuplas: 0, duenosV8: 0 } : undefined;
    return this.entradas.map((puerto, i) => {
      const dueno = i + 1;
      const parte = receiveMessageOnPort(puerto)?.message as ParteCorte | undefined;
      if (!parte || parte.dueno !== dueno || parte.solicitud !== solicitud || parte.epoca !== epoca || parte.tick !== tick
        || !(parte.bytes instanceof Uint8Array) || parte.bytes.byteLength === 0 || receiveMessageOnPort(puerto) !== undefined)
        throw new Error(`Instantánea incompleta o incoherente para el dueño ${dueno}.`);
      const inicioV8 = datos ? performance.now() : 0;
      const contenido = deserialize(parte.bytes) as ParteMundo;
      if (contenido.tick !== tick) throw new Error(`El mundo del dueño ${dueno} no pertenece al tick del corte.`);
      if (datos) {
        datos.bytesV8 += parte.bytes.byteLength;
        datos.v8Ms += performance.now() - inicioV8;
        const sustituidas = parte.teselasSustituidas;
        try {
          if (!Array.isArray(contenido.tiles)) throw new Error('Falta el array de teselas en V8.');
          if (sustituidas === null && !Object.hasOwn(parte, 'teselas')) datos.duenosV8++;
          else {
            if (!sustituidas || typeof sustituidas !== 'object' || contenido.tiles.length !== 0
              || Object.keys(contenido.tiles).length !== 0 || !Array.isArray(parte.teselas))
              throw new Error('Sobre de teselas directas incoherente.');
            const inicioTuplas = performance.now();
            contenido.tiles = recibirTeselasDirectas(parte.teselas, sustituidas.cantidad);
            datos.tuplasMs += performance.now() - inicioTuplas;
            datos.bytesTuplas += parte.teselas.reduce((n, bloque) => n + bloque.cuerpo.byteLength, 0);
            datos.duenosTuplas++;
          }
        } catch (error) {
          throw new Error(`Teselas directas inválidas para el dueño ${dueno}.`, { cause: error });
        }
      } else if (Object.hasOwn(parte, 'teselasSustituidas') || Object.hasOwn(parte, 'teselas')) {
        throw new Error(`Modo de teselas incoherente para el dueño ${dueno}.`);
      }
      if (modo === FAUNA_DIRECTA) {
        const sustituida = parte.faunaSustituida;
        try {
          if (!Array.isArray(contenido.animals)) throw new Error('Falta el array de fauna en V8.');
          if (sustituida === null && !Object.hasOwn(parte, 'fauna')) return contenido;
          if (!sustituida || typeof sustituida !== 'object' || contenido.animals.length !== 0
            || Object.keys(contenido.animals).length !== 0 || !Array.isArray(parte.fauna))
            throw new Error('Sobre de fauna directa incoherente.');
          contenido.animals = recibirFaunaDirecta(parte.fauna, sustituida.cantidad);
          return contenido;
        } catch (error) {
          throw new Error(`Fauna directa inválida para el dueño ${dueno}.`, { cause: error });
        }
      }
      if (Object.hasOwn(parte, 'faunaSustituida')) throw new Error(`Modo de fauna incoherente para el dueño ${dueno}.`);
      // Si falta la optimización, el guardado conserva las filas canónicas de este dueño.
      const bloques = modo === FAUNA_SOMBRA ? parte.fauna : undefined;
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
