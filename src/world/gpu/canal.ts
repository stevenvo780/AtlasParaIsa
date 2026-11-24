import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { ErrorDispositivo, type CanalGpu } from '../motor/contratos.js';

const MAX_ORDEN = 4096;
const [EVENTO, FALLO, PID] = [0, 1, 2];

// El worker hace el IPC de control aunque el coordinador esté en Atomics.wait en B2.
const CONTROL = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { dispositivo, script, nvrtc, fd, entorno, control, respuestas, max } = workerData;
const estado = new Int32Array(control);
const child = spawn('python3', [script, '--device', String(dispositivo), '--nvrtc', nvrtc, '--fd', '3'],
  { stdio: ['pipe', 'pipe', 'inherit', fd], env: entorno });
Atomics.store(estado, 2, child.pid ?? 0);
let resto = Buffer.alloc(0);
function avisar() {
  Atomics.add(estado, 0, 1);
  Atomics.notify(estado, 0);
}
function fallar() {
  Atomics.store(estado, 1, 1);
  avisar();
  child.kill('SIGKILL');
}
child.on('error', fallar);
child.on('close', () => {
  Atomics.store(estado, 1, 1);
  avisar();
  respuestas.close();
  parentPort.close();
});
child.stdin.on('error', fallar);
child.stdout.on('error', fallar);
child.stdout.on('data', chunk => {
  resto = resto.length ? Buffer.concat([resto, chunk]) : chunk;
  while (resto.length >= 4) {
    const longitud = resto.readUInt32LE(0);
    if (longitud > max) { fallar(); return; }
    if (resto.length < longitud + 4) return;
    respuestas.postMessage(resto.subarray(4, longitud + 4));
    resto = resto.subarray(longitud + 4);
    avisar();
  }
});
parentPort.on('message', orden => {
  if (orden === null) { child.kill('SIGKILL'); return; }
  if (Atomics.load(estado, 1)) return;
  const frame = Buffer.allocUnsafe(4 + orden.length);
  frame.writeUInt32LE(orden.length);
  frame.set(orden, 4);
  child.stdin.write(frame);
});
`;

function servidorGpu(): string {
  for (const ruta of ['../../../scripts/gpu/servidor-gpu.py', '../../../../scripts/gpu/servidor-gpu.py']) {
    const path = fileURLToPath(new URL(ruta, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error('No se encontró servidor-gpu.py.');
}

export interface OpcionesCanalGpu {
  script?: string;
  nvrtc?: string;
  entorno?: NodeJS.ProcessEnv;
}

export class CanalCompartido implements CanalGpu {
  readonly #fd: number;
  readonly #control = new Int32Array(new SharedArrayBuffer(3 * 4));
  readonly #worker: Worker;
  readonly #respuestas: MessageChannel['port1'];
  #bytes = 0;
  #pendientes = 0;
  #listo = false;
  #cerrado = false;

  constructor(readonly dispositivo: number, opciones: OpcionesCanalGpu = {}) {
    if (!Number.isSafeInteger(dispositivo) || dispositivo < 0) throw new RangeError('Índice de GPU inválido.');
    let script: string;
    try { script = opciones.script ?? servidorGpu(); }
    catch (error) { throw this.#error(String(error)); }
    const nvrtc = opciones.nvrtc ?? process.env.COMPUTE_NVRTC;
    if (!nvrtc && !opciones.script) throw this.#error('Falta COMPUTE_NVRTC.');
    try {
      const directorio = mkdtempSync('/dev/shm/atlas-m3-');
      const ruta = directorio + '/canal';
      try {
        this.#fd = openSync(ruta, 'wx+', 0o600);
        try { unlinkSync(ruta); }
        catch (error) { closeSync(this.#fd); throw error; }
      } finally {
        rmdirSync(directorio);
      }
    } catch (error) { throw this.#error('No se pudo abrir el canal GPU: ' + String(error)); }
    const { port1, port2 } = new MessageChannel();
    this.#respuestas = port1;
    try {
      this.#worker = new Worker(CONTROL, {
        eval: true, execArgv: [], name: `atlas-m3-gpu${dispositivo}`, transferList: [port2],
        workerData: { dispositivo, script, nvrtc: nvrtc ?? '', fd: this.#fd, entorno: opciones.entorno,
          control: this.#control.buffer, respuestas: port2, max: MAX_ORDEN },
      });
    } catch (error) {
      port1.close();
      port2.close();
      closeSync(this.#fd);
      throw this.#error('No se pudo iniciar el canal GPU: ' + String(error));
    }
    this.#worker.unref();
    const fallar = () => { Atomics.store(this.#control, FALLO, 1); Atomics.add(this.#control, EVENTO, 1); Atomics.notify(this.#control, EVENTO); };
    this.#worker.on('error', fallar);
    this.#worker.on('exit', fallar);
  }

  get bytes(): number { return this.#bytes; }
  get pid(): number | null { return Atomics.load(this.#control, PID) || null; }

  #error(mensaje: string): ErrorDispositivo { return new ErrorDispositivo(`gpu${this.dispositivo}`, mensaje); }
  #vivo(): void {
    if (this.#cerrado || Atomics.load(this.#control, FALLO)) throw this.#error('El servidor GPU se cerró.');
  }

  crecer(bytes: number): void {
    this.#vivo();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Tamaño de canal inválido.');
    if (bytes <= this.#bytes) return;
    try {
      ftruncateSync(this.#fd, bytes);
      this.#bytes = bytes;
    } catch (error) { throw this.#error('No se pudo crecer el canal GPU: ' + String(error)); }
  }

  #vista(desde: number, datos: ArrayBufferView): Uint8Array {
    this.#vivo();
    if (!Number.isSafeInteger(desde) || desde < 0 || datos.byteLength > this.#bytes - desde)
      throw new RangeError('Vista fuera del canal GPU.');
    return new Uint8Array(datos.buffer, datos.byteOffset, datos.byteLength);
  }

  escribir(desde: number, datos: ArrayBufferView): void {
    const vista = this.#vista(desde, datos);
    try {
      for (let off = 0; off < vista.length;) {
        const n = writeSync(this.#fd, vista, off, vista.length - off, desde + off);
        if (n === 0) throw new Error('Escritura incompleta.');
        off += n;
      }
    } catch (error) { throw this.#error('Escritura en memoria compartida: ' + String(error)); }
  }

  leer(desde: number, destino: ArrayBufferView): void {
    const vista = this.#vista(desde, destino);
    try {
      for (let off = 0; off < vista.length;) {
        const n = readSync(this.#fd, vista, off, vista.length - off, desde + off);
        if (n === 0) throw new Error('Lectura incompleta.');
        off += n;
      }
    } catch (error) { throw this.#error('Lectura en memoria compartida: ' + String(error)); }
  }

  enviar(orden: Uint8Array): void {
    this.#vivo();
    if (orden.byteLength > MAX_ORDEN) throw new RangeError('Orden demasiado grande para la tubería GPU.');
    this.#worker.postMessage(orden);
    this.#pendientes++;
  }

  #esperar(fin: number): Uint8Array {
    for (;;) {
      const evento = Atomics.load(this.#control, EVENTO);
      if (this.#cerrado) throw this.#error('El canal GPU se cerró.');
      const respuesta = receiveMessageOnPort(this.#respuestas);
      if (respuesta) return respuesta.message as Uint8Array;
      this.#vivo();
      const queda = fin - performance.now();
      if (queda <= 0) {
        this.cerrar();
        throw this.#error('Venció el plazo del servidor GPU.');
      }
      Atomics.wait(this.#control, EVENTO, evento, queda);
    }
  }

  #iniciar(fin: number): void {
    if (this.#listo) return;
    const respuesta = decodificar<{ listo?: boolean }>(this, this.#esperar(fin));
    if (!respuesta.listo) throw this.#error('El servidor GPU no confirmó el arranque.');
    this.#listo = true;
  }

  iniciar(plazoMs: number): void {
    if (!Number.isFinite(plazoMs) || plazoMs < 0) throw new RangeError('Plazo GPU inválido.');
    this.#iniciar(performance.now() + plazoMs);
    this.#vivo();
  }

  recibir(plazoMs: number): Uint8Array {
    if (this.#pendientes === 0) {
      this.#vivo();
      throw new Error('No hay órdenes GPU pendientes.');
    }
    if (!Number.isFinite(plazoMs) || plazoMs < 0) throw new RangeError('Plazo GPU inválido.');
    const fin = performance.now() + plazoMs;
    this.#iniciar(fin);
    const respuesta = this.#esperar(fin);
    this.#pendientes--;
    return respuesta;
  }

  cerrar(): void {
    if (this.#cerrado) return;
    this.#cerrado = true;
    this.#worker.postMessage(null);
    this.#respuestas.close();
    // Antes de READY el worker aún podría necesitar el descriptor para spawn.
    if (this.pid || Atomics.load(this.#control, FALLO)) closeSync(this.#fd);
    else this.#worker.once('exit', () => closeSync(this.#fd));
  }
}

export function enviarOrden(canal: CanalGpu, orden: object): void {
  canal.enviar(Buffer.from(JSON.stringify(orden)));
}

function decodificar<T>(canal: CanalGpu, datos: Uint8Array): T {
  let respuesta: { error?: string };
  try {
    respuesta = JSON.parse(Buffer.from(datos.buffer, datos.byteOffset, datos.byteLength).toString()) as typeof respuesta;
  } catch {
    throw new ErrorDispositivo(`gpu${canal.dispositivo}`, 'Respuesta GPU inválida.');
  }
  if (!respuesta || typeof respuesta !== 'object' || respuesta.error)
    throw new ErrorDispositivo(`gpu${canal.dispositivo}`, respuesta?.error ?? 'Respuesta GPU inválida.');
  return respuesta as T;
}

export function recibirRespuesta<T>(canal: CanalGpu, plazoMs: number): T {
  return decodificar<T>(canal, canal.recibir(plazoMs));
}
