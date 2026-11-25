import { conCerrojo, ErrorFatalMotor } from '../paralelo/barrera.js';
import { crecerSAB, crearSAB } from '../soa/arena.js';
import type { Registro } from './contratos.js';

const BYTES = BigUint64Array.BYTES_PER_ELEMENT;
/** Tope de reserva virtual si el anfitrión no da otro; las leyes no preguntan a la máquina. */
export const MAX_BYTES_REGISTRO = 2 ** 36;
const clave = (datos: Uint8Array) => Buffer.from(datos.buffer, datos.byteOffset, datos.byteLength).toString('base64');

function preparar(memoria: MemoriaRegistro, fin: number, n: number): void {
  const bytesIndice = n * BYTES;
  const max = (vista: Uint8Array | BigUint64Array) => (vista.buffer as SharedArrayBuffer).maxByteLength;
  if (fin > max(memoria.datos) || bytesIndice > max(memoria.fines)) throw new ErrorFatalMotor('Registro sin memoria.');
  const crecer = (vista: Uint8Array | BigUint64Array, bytes: number) => {
    if (bytes > vista.byteLength) crecerSAB(vista.buffer as SharedArrayBuffer,
      Math.min(max(vista), Math.max(bytes, 512, 2 * vista.byteLength)));
  };
  try {
    crecer(memoria.datos, fin);
    crecer(memoria.fines, bytesIndice);
  } catch (error) { throw new ErrorFatalMotor(error); }
}

export interface MemoriaRegistro {
  readonly escritor: Int32Array;
  readonly publicados: BigUint64Array;
  readonly fines: BigUint64Array;
  readonly datos: Uint8Array;
}

export class RegistroContenido implements Registro {
  readonly memoria: MemoriaRegistro | null;
  private readonly indices = new Map<string, number>();
  private readonly locales: Uint8Array[] = [];

  constructor(hilosOMemoria: number | MemoriaRegistro, maxBytes = MAX_BYTES_REGISTRO) {
    if (typeof hilosOMemoria !== 'number') { this.memoria = hilosOMemoria; return; }
    if (!Number.isSafeInteger(hilosOMemoria) || hilosOMemoria < 1) throw new RangeError('Cantidad de hilos inválida.');
    this.memoria = hilosOMemoria === 1 ? null : {
      escritor: new Int32Array(new SharedArrayBuffer(4)),
      publicados: new BigUint64Array(new SharedArrayBuffer(BYTES)),
      fines: new BigUint64Array(crearSAB(0, Math.floor(maxBytes / BYTES) * BYTES)),
      datos: new Uint8Array(crearSAB(0, maxBytes)),
    };
  }

  get n(): number { return this.memoria ? Number(Atomics.load(this.memoria.publicados, 0)) : this.locales.length; }

  private entrada(id: number): Uint8Array {
    const m = this.memoria;
    if (!m) return this.locales[id];
    const inicio = id === 0 ? 0 : Number(m.fines[id - 1]);
    return m.datos.subarray(inicio, Number(m.fines[id]));
  }

  leer(id: number): Uint8Array | undefined {
    if (Number.isSafeInteger(id) && id >= 0 && id < this.n) return new Uint8Array(this.entrada(id));
  }

  private sincronizar(): void {
    const n = this.n;
    for (let id = this.indices.size; id < n; id++) this.indices.set(clave(this.entrada(id)), id);
  }

  private agregar(canonico: Uint8Array, hash: string): number {
    const id = this.n;
    const m = this.memoria;
    if (m) {
      const inicio = id === 0 ? 0 : Number(m.fines[id - 1]);
      const fin = inicio + canonico.length;
      preparar(m, fin, id + 1);
      m.datos.set(canonico, inicio);
      m.fines[id] = BigInt(fin);
      Atomics.store(m.publicados, 0, BigInt(id + 1));
    } else this.locales.push(canonico);
    this.indices.set(hash, id);
    return id;
  }

  private conEscritor<T>(f: () => T): T {
    return this.memoria ? conCerrojo(this.memoria.escritor, 0, 'el escritor del registro', f) : f();
  }

  insertar(canonico: Uint8Array): number {
    const copia = new Uint8Array(canonico);
    const hash = clave(copia);
    const existente = this.indices.get(hash);
    if (existente !== undefined) return existente;
    return this.conEscritor(() => {
      this.sincronizar();
      return this.indices.get(hash) ?? this.agregar(copia, hash);
    });
  }

  /** Formato denso LE: número de ids, fines acumulados, bytes canónicos en orden de id. */
  guardar(): Uint8Array {
    const n = this.n, cabecera = (n + 1) * BYTES;
    let total = 0;
    if (this.memoria) total = n === 0 ? 0 : Number(this.memoria.fines[n - 1]);
    else for (const bytes of this.locales) total += bytes.length;
    const salida = new Uint8Array(cabecera + total);
    const tabla = new DataView(salida.buffer);
    tabla.setBigUint64(0, BigInt(n), true);
    let inicio = 0;
    for (let id = 0; id < n; id++) {
      const datos = this.entrada(id);
      salida.set(datos, cabecera + inicio);
      inicio += datos.length;
      tabla.setBigUint64((id + 1) * BYTES, BigInt(inicio), true);
    }
    return salida;
  }

  /** Antes de arrancar los dueños, sobre un registro vacío. */
  cargar(datos: Uint8Array): void {
    if (datos.length < BYTES) throw new Error('Registro truncado.');
    const tabla = new DataView(datos.buffer, datos.byteOffset, datos.byteLength);
    const n = Number(tabla.getBigUint64(0, true)), cabecera = (n + 1) * BYTES;
    if (cabecera > datos.length) throw new Error('Índice del registro truncado.');
    const entradas = new Map<string, Uint8Array>();
    let inicio = cabecera;
    for (let id = 0; id < n; id++) {
      const fin = cabecera + Number(tabla.getBigUint64((id + 1) * BYTES, true));
      if (fin < inicio || fin > datos.length) throw new Error('Rango inválido en el registro.');
      const bytes = new Uint8Array(datos.subarray(inicio, fin)), hash = clave(bytes);
      if (entradas.has(hash)) throw new Error('Entrada duplicada en el registro.');
      entradas.set(hash, bytes);
      inicio = fin;
    }
    if (inicio !== datos.length) throw new Error('Sobran bytes en el registro.');
    this.conEscritor(() => {
      if (this.n !== 0) throw new Error('La carga exige un registro vacío.');
      const m = this.memoria;
      if (!m) {
        for (const [hash, bytes] of entradas) this.agregar(bytes, hash);
        return;
      }
      preparar(m, datos.length - cabecera, n);
      let id = 0, offset = 0;
      for (const [hash, bytes] of entradas) {
        m.datos.set(bytes, offset);
        offset += bytes.length;
        m.fines[id] = BigInt(offset);
        this.indices.set(hash, id++);
      }
      Atomics.store(m.publicados, 0, BigInt(n));
    });
  }
}
