import { execFileSync } from 'node:child_process';
import {
  closeSync, constants, existsSync, ftruncateSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync, writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ErrorDispositivo, type CanalGpu } from '../motor/contratos.js';

const MAX_ORDEN = 4096;
/** Antes de dormir en la tubería, el motor sondea la respuesta este tiempo: cada despertar cuesta ~1 ms con la torre cargada. */
const ESPERA_ACTIVA_MS = 1;
const [EVENTO, FALLO, PID, LEIDAS, VENCIDO] = [0, 1, 2, 3, 4];

// El worker arranca el servidor, avisa si muere y lo mata si vence el plazo de la respuesta pendiente.
// Las órdenes y respuestas no pasan por él: el motor escribe y lee las tuberías directamente.
const VIGIA = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { dispositivo, script, nvrtc, fds, entorno, control } = workerData;
const estado = new Int32Array(control);
const avisar = () => { Atomics.add(estado, 0, 1); Atomics.notify(estado, 0); };
const fallar = () => { Atomics.store(estado, 1, 1); avisar(); };
const hijo = spawn('python3', ['-B', script, '--device', String(dispositivo), '--nvrtc', nvrtc, '--fd', '3'],
  { stdio: [fds[0], fds[1], 'inherit', fds[2]], env: entorno });
Atomics.store(estado, 2, hijo.pid ?? 0);
avisar();
hijo.on('error', fallar);
hijo.on('exit', () => { fallar(); parentPort.close(); });
let plazo;
parentPort.on('message', orden => {
  if (orden === null) { hijo.kill('SIGKILL'); return; }
  clearTimeout(plazo);
  plazo = setTimeout(() => {
    if (Atomics.load(estado, 3) < orden.lectura) { Atomics.store(estado, 4, 1); hijo.kill('SIGKILL'); }
  }, orden.ms);
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

/**
 * Datos por un fichero de /dev/shm y control por dos FIFO, sin nombre en disco desde que se abren. El motor tiene
 * el extremo de escritura de las órdenes y dos lecturas de las respuestas: una no bloqueante para la espera activa y
 * otra bloqueante, que devuelve EOF cuando el servidor muere porque nadie más conserva su extremo de escritura.
 */
export class CanalCompartido implements CanalGpu {
  readonly #shm: number;
  readonly #ordenes: number;
  readonly #sondeo: number;
  readonly #respuestas: number;
  #delServidor: number[];                  // extremos del servidor: se cierran aquí cuando el worker lo arrancó
  #shmAbierto = true;
  readonly #control = new Int32Array(new SharedArrayBuffer(5 * 4));
  readonly #vigia: Worker;
  readonly #trozo = Buffer.allocUnsafe(MAX_ORDEN + 4);
  #resto = Buffer.alloc(0);
  #bytes = 0;
  #pendientes = 0;
  #leidas = 0;
  #listo = false;
  #cerrado = false;

  constructor(readonly dispositivo: number, opciones: OpcionesCanalGpu = {}) {
    if (!Number.isSafeInteger(dispositivo) || dispositivo < 0) throw new RangeError('Índice de GPU inválido.');
    let script: string;
    try { script = opciones.script ?? servidorGpu(); }
    catch (error) { throw this.#error(String(error)); }
    const nvrtc = opciones.nvrtc ?? process.env.COMPUTE_NVRTC;
    if (!nvrtc && !opciones.script) throw this.#error('Falta COMPUTE_NVRTC.');
    const abiertos: number[] = [];
    const abrir = (ruta: string, modo: number | string, permisos?: number) => {
      const fd = openSync(ruta, modo, permisos);
      abiertos.push(fd);
      return fd;
    };
    const { O_RDONLY, O_WRONLY, O_NONBLOCK } = constants;
    let directorio: string | undefined;
    try {
      directorio = mkdtempSync('/dev/shm/atlas-m3-');
      const [datos, ordenes, respuestas] = ['canal', 'ordenes', 'respuestas'].map(n => `${directorio}/${n}`);
      try {
        execFileSync('mkfifo', ['-m', '600', ordenes, respuestas]);
        this.#shm = abrir(datos, 'wx+', 0o600);
        // Una FIFO solo se abre para escribir si ya tiene lector: la lectura provisional no bloqueante lo da.
        const provisional = abrir(ordenes, O_RDONLY | O_NONBLOCK);
        this.#ordenes = abrir(ordenes, O_WRONLY | O_NONBLOCK);
        const ordenesServidor = abrir(ordenes, O_RDONLY);
        closeSync(abiertos.splice(abiertos.indexOf(provisional), 1)[0]!);
        this.#sondeo = abrir(respuestas, O_RDONLY | O_NONBLOCK);
        const respuestasServidor = abrir(respuestas, O_WRONLY);
        this.#respuestas = abrir(respuestas, O_RDONLY);
        this.#delServidor = [ordenesServidor, respuestasServidor];
      } finally {
        for (const ruta of [datos, ordenes, respuestas]) {
          try { unlinkSync(ruta); } catch { /* no llegó a crearse */ }
        }
        rmdirSync(directorio);
      }
    } catch (error) {
      for (const fd of abiertos) closeSync(fd);
      throw this.#error('No se pudo abrir el canal GPU: ' + String(error));
    }
    try {
      this.#vigia = new Worker(VIGIA, {
        eval: true, execArgv: [], name: `atlas-m3-gpu${dispositivo}`,
        workerData: { dispositivo, script, nvrtc: nvrtc ?? '', fds: [...this.#delServidor, this.#shm],
          entorno: opciones.entorno, control: this.#control.buffer },
      });
    } catch (error) {
      for (const fd of abiertos) closeSync(fd);
      throw this.#error('No se pudo iniciar el canal GPU: ' + String(error));
    }
    this.#vigia.unref();
    const fallar = () => { Atomics.store(this.#control, FALLO, 1); Atomics.add(this.#control, EVENTO, 1); Atomics.notify(this.#control, EVENTO); };
    this.#vigia.on('error', fallar);
    this.#vigia.on('exit', () => {
      fallar();
      this.#soltarServidor();
      if (this.#cerrado) this.#soltarShm();
    });
  }

  get bytes(): number { return this.#bytes; }
  get pid(): number | null { return Atomics.load(this.#control, PID) || null; }

  #error(mensaje: string): ErrorDispositivo { return new ErrorDispositivo(`gpu${this.dispositivo}`, mensaje); }
  #vivo(): void {
    if (this.#cerrado || Atomics.load(this.#control, FALLO)) throw this.#error('El servidor GPU se cerró.');
  }
  #soltarServidor(): void {
    for (const fd of this.#delServidor) closeSync(fd);
    this.#delServidor = [];
  }
  #soltarShm(): void {
    if (!this.#shmAbierto) return;
    this.#shmAbierto = false;
    closeSync(this.#shm);
  }

  crecer(bytes: number): void {
    this.#vivo();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Tamaño de canal inválido.');
    if (bytes <= this.#bytes) return;
    try {
      ftruncateSync(this.#shm, bytes);
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
        const n = writeSync(this.#shm, vista, off, vista.length - off, desde + off);
        if (n === 0) throw new Error('Escritura incompleta.');
        off += n;
      }
    } catch (error) { throw this.#error('Escritura en memoria compartida: ' + String(error)); }
  }

  leer(desde: number, destino: ArrayBufferView): void {
    const vista = this.#vista(desde, destino);
    try {
      for (let off = 0; off < vista.length;) {
        const n = readSync(this.#shm, vista, off, vista.length - off, desde + off);
        if (n === 0) throw new Error('Lectura incompleta.');
        off += n;
      }
    } catch (error) { throw this.#error('Lectura en memoria compartida: ' + String(error)); }
  }

  enviar(orden: Uint8Array): void {
    this.#vivo();
    if (orden.byteLength > MAX_ORDEN) throw new RangeError('Orden demasiado grande para la tubería GPU.');
    const marco = Buffer.allocUnsafe(4 + orden.byteLength);
    marco.writeUInt32LE(orden.byteLength);
    marco.set(orden, 4);
    // Un marco ≤ PIPE_BUF se escribe entero o nada; EAGAIN significa que el servidor dejó de leer.
    try {
      if (writeSync(this.#ordenes, marco) !== marco.length) throw new Error('Orden partida.');
    } catch (error) {
      this.cerrar();
      throw this.#error('No se pudo enviar la orden GPU: ' + String(error));
    }
    this.#pendientes++;
  }

  #marco(): Uint8Array | null {
    if (this.#resto.length < 4) return null;
    const largo = this.#resto.readUInt32LE(0);
    if (largo > MAX_ORDEN) {
      this.cerrar();
      throw this.#error('Respuesta GPU demasiado grande.');
    }
    if (this.#resto.length < 4 + largo) return null;
    const marco = Uint8Array.prototype.slice.call(this.#resto, 4, 4 + largo);
    this.#resto = this.#resto.subarray(4 + largo);
    Atomics.store(this.#control, LEIDAS, ++this.#leidas);
    return marco;
  }

  #anadir(n: number): void {
    this.#resto = this.#resto.length ? Buffer.concat([this.#resto, this.#trozo.subarray(0, n)]) : Buffer.from(this.#trozo.subarray(0, n));
  }

  #caida(): ErrorDispositivo {
    const vencido = Atomics.load(this.#control, VENCIDO) === 1;
    this.cerrar();
    return this.#error(vencido ? 'Venció el plazo del servidor GPU.' : 'El servidor GPU se cerró.');
  }

  #vencido(): ErrorDispositivo {
    this.cerrar();
    return this.#error('Venció el plazo del servidor GPU.');
  }

  #esperar(fin: number): Uint8Array {
    if (this.#cerrado) throw this.#error('El canal GPU se cerró.');
    // Mientras el worker no haya arrancado al servidor, este proceso conserva su extremo de escritura y no vería EOF.
    while (this.#delServidor.length) {
      if (Atomics.load(this.#control, PID) || Atomics.load(this.#control, FALLO)) { this.#soltarServidor(); break; }
      const evento = Atomics.load(this.#control, EVENTO), queda = fin - performance.now();
      if (queda <= 0) throw this.#vencido();
      Atomics.wait(this.#control, EVENTO, evento, queda);
    }
    const sondeo = Math.min(fin, performance.now() + ESPERA_ACTIVA_MS);
    for (;;) {
      const marco = this.#marco();
      if (marco) return marco;
      let n: number;
      try { n = readSync(this.#sondeo, this.#trozo); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw this.#caida();
        if (performance.now() >= sondeo) break;
        continue;
      }
      if (n === 0) throw this.#caida();
      this.#anadir(n);
    }
    if (performance.now() >= fin) throw this.#vencido();
    if (Number.isFinite(fin)) this.#vigia.postMessage({ lectura: this.#leidas + 1, ms: fin - performance.now() });
    for (;;) {
      const marco = this.#marco();
      if (marco) return marco;
      let n: number;
      try { n = readSync(this.#respuestas, this.#trozo); }
      catch { throw this.#caida(); }
      if (n === 0) throw this.#caida();
      this.#anadir(n);
    }
  }

  #iniciar(fin: number): void {
    if (this.#listo) return;
    let respuesta: { listo?: boolean };
    try { respuesta = decodificar<{ listo?: boolean }>(this, this.#esperar(fin)); }
    catch (error) { this.cerrar(); throw error; }
    if (!respuesta.listo) {
      this.cerrar();
      throw this.#error('El servidor GPU no confirmó el arranque.');
    }
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
    if (Number.isNaN(plazoMs) || plazoMs < 0) throw new RangeError('Plazo GPU inválido.');
    const fin = performance.now() + plazoMs;
    this.#iniciar(fin);
    const respuesta = this.#esperar(fin);
    this.#pendientes--;
    return respuesta;
  }

  cerrar(): void {
    if (this.#cerrado) return;
    this.#cerrado = true;
    this.#vigia.postMessage(null);
    for (const fd of [this.#ordenes, this.#sondeo, this.#respuestas]) closeSync(fd);
    // Antes del arranque, el worker todavía pasará al servidor su extremo de cada FIFO y el fichero de datos.
    if (this.pid || Atomics.load(this.#control, FALLO)) {
      this.#soltarServidor();
      this.#soltarShm();
    }
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

const canalesOcupados = new WeakSet<CanalGpu>();

/** Los clientes de una tarjeta comparten el tramo de /dev/shm desde el byte 0. */
export function reservarCanalGpu(canal: CanalGpu): (() => void) | undefined {
  if (canalesOcupados.has(canal)) return;
  canalesOcupados.add(canal);
  return () => { canalesOcupados.delete(canal); };
}
