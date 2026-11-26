/// <reference lib="es2024.sharedmemory" />

import { conCerrojo, ErrorFatalMotor } from '../paralelo/barrera.js';

export type Elements = Uint8Array | Uint16Array | Uint32Array | Int16Array | Int32Array | Float32Array | Float64Array;
type Tipo = 'Uint8Array' | 'Uint16Array' | 'Uint32Array' | 'Int16Array' | 'Int32Array' | 'Float32Array' | 'Float64Array';
type Constructor<T extends Elements> = {
  new(buffer: SharedArrayBuffer): T;
  readonly name: string;
  readonly BYTES_PER_ELEMENT: number;
};
const TIPOS: Record<Tipo, Constructor<Elements>> = { Uint8Array, Uint16Array, Uint32Array, Int16Array, Int32Array, Float32Array, Float64Array };

interface ColumnaCompartida {
  nombre: string;
  tipo: Tipo;
  ancho: number;
  relleno: number;
  memoria: SharedArrayBuffer;
}
interface Columna extends ColumnaCompartida { vista: Elements }

export interface ArenaCompartida {
  control: SharedArrayBuffer;
  enlaces: SharedArrayBuffer;
  maxRanuras: number;
  columnas: ColumnaCompartida[];
}

const CERROJO = 0, CAPACIDAD = 1, ALTA = 2, USADAS = 3, LIBRE = 4, GENERACION = 5;
const OCUPADA = 0xffffffff;
const MAX_RANURAS = OCUPADA - 1; // El enlace libre es ranura + 1 y reserva 0 y OCUPADA.
const CRECIMIENTO = 1.25;

export function crearSAB(bytes: number, maxBytes: number): SharedArrayBuffer {
  return new SharedArrayBuffer(bytes, { maxByteLength: maxBytes });
}

/** Otro escritor puede haber alcanzado la longitud pedida al mismo tiempo. */
export function crecerSAB(buffer: SharedArrayBuffer, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Longitud de SAB inválida.');
  if (buffer.byteLength >= bytes) return;
  try {
    buffer.grow(bytes);
  } catch (error) {
    if (buffer.byteLength < bytes) throw error;
  }
}

/**
 * Arena de ranuras con una vista de longitud variable por columna. La capacidad se publica después
 * de crecer todas las columnas; un lector que conserva su vista sigue viendo los datos anteriores.
 * Una vez compartida, solo su coordinador puede crecerla y lo hace en F0.
 */
export class PageArena {
  private readonly columnas = new Map<string, Columna>();
  private readonly control: Int32Array<SharedArrayBuffer>;
  private readonly enlaces: Uint32Array<SharedArrayBuffer>;
  private readonly maxRanuras: number;
  private readonly coordinador: boolean;
  private compartida: boolean;

  constructor(origen: number | ArenaCompartida = MAX_RANURAS) {
    this.coordinador = typeof origen === 'number';
    this.compartida = !this.coordinador;
    if (typeof origen === 'number') {
      if (!Number.isInteger(origen) || origen < 1 || origen > MAX_RANURAS) throw new RangeError('Dominio de ranuras inválido.');
      this.maxRanuras = origen;
      this.control = new Int32Array(new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT));
      this.enlaces = new Uint32Array(crearSAB(0, origen * Uint32Array.BYTES_PER_ELEMENT));
    } else {
      this.maxRanuras = origen.maxRanuras;
      this.control = new Int32Array(origen.control);
      this.enlaces = new Uint32Array(origen.enlaces);
      for (const columna of origen.columnas) {
        this.columnas.set(columna.nombre, { ...columna, vista: new TIPOS[columna.tipo](columna.memoria) });
      }
    }
  }

  static conectar(descriptor: ArenaCompartida): PageArena {
    return new PageArena(descriptor);
  }

  get capacity(): number { return Atomics.load(this.control, CAPACIDAD) >>> 0; }
  get maxCapacity(): number { return this.maxRanuras; }
  get used(): number { return Atomics.load(this.control, USADAS) >>> 0; }
  get slots(): number { return Atomics.load(this.control, ALTA) >>> 0; }
  get generation(): number { return Atomics.load(this.control, GENERACION); }

  /** Registra el campo antes de compartirlo, o recupera su vista sin recalcularla. */
  field<T extends Elements>(nombre: string, make: Constructor<T>, ancho: number, relleno = 0): T {
    const actual = this.columnas.get(nombre);
    const tipo = make.name as Tipo;
    if (actual) {
      if (actual.tipo !== tipo || actual.ancho !== ancho || !Object.is(actual.relleno, relleno)) {
        throw new TypeError(`Campo SoA «${nombre}» redeclarado con otra forma.`);
      }
      return actual.vista as T;
    }
    if (this.compartida) throw new Error(`Campo SoA «${nombre}» no registrado antes de compartir.`);
    if (TIPOS[tipo] !== make || !Number.isSafeInteger(ancho) || ancho < 1) throw new TypeError(`Forma inválida: «${nombre}».`);
    const bytes = ancho * make.BYTES_PER_ELEMENT;
    const memoria = crearSAB(this.capacity * bytes, this.maxRanuras * bytes);
    const vista = new make(memoria);
    if (relleno !== 0) vista.fill(relleno);
    this.columnas.set(nombre, { nombre, tipo, ancho, relleno, memoria, vista });
    Atomics.add(this.control, GENERACION, 1);
    return vista;
  }

  compartir(): ArenaCompartida {
    this.compartida = true;
    return {
      control: this.control.buffer, enlaces: this.enlaces.buffer, maxRanuras: this.maxRanuras,
      columnas: [...this.columnas.values()].map(({ nombre, tipo, ancho, relleno, memoria }) => ({ nombre, tipo, ancho, relleno, memoria })),
    };
  }

  /** Garantiza ranuras libres sin consumirlas. Los lotes alinean el crecimiento a bloques de 256. */
  prepararF0(libres: number, bloque = 1): void {
    if (!this.coordinador) throw new Error('Solo el coordinador puede crecer la arena en F0.');
    if (!Number.isSafeInteger(libres) || libres < 0 || !Number.isSafeInteger(bloque) || bloque < 1) {
      throw new RangeError('Reserva de arena inválida.');
    }
    this.bajoCerrojo(() => {
      const minimo = this.used + libres;
      const capacidad = this.capacity;
      if (minimo <= capacidad && capacidad % bloque === 0) return;
      const maximo = Math.floor(this.maxRanuras / bloque) * bloque;
      const alinear = (n: number) => Math.ceil(n / bloque) * bloque;
      if (alinear(Math.max(minimo, capacidad)) > maximo) throw new RangeError('Ranuras de arena fuera de su dominio.');
      this.crecer(Math.min(maximo, alinear(Math.max(minimo, capacidad * CRECIMIENTO))));
    });
  }

  /** Reutiliza los valores de la última asignación; su validez la decide el cliente de la arena. */
  reserve(): number {
    return this.bajoCerrojo(() => {
      const libre = Atomics.load(this.control, LIBRE) >>> 0;
      const ranura = libre === 0 ? this.slots : libre - 1;
      if (libre !== 0) {
        Atomics.store(this.control, LIBRE, this.enlaces[ranura]!);
      } else {
        if (ranura === this.capacity) throw new ErrorFatalMotor('Arena agotada fuera de F0: falta reserva para el paso.');
        Atomics.store(this.control, ALTA, ranura + 1);
      }
      this.enlaces[ranura] = OCUPADA;
      Atomics.add(this.control, USADAS, 1);
      return ranura;
    });
  }

  release(ranura: number): void {
    this.bajoCerrojo(() => {
      if (!Number.isInteger(ranura) || ranura < 0 || ranura >= this.slots || this.enlaces[ranura] !== OCUPADA) {
        throw new RangeError(`Ranura no asignada: ${ranura}.`);
      }
      this.enlaces[ranura] = Atomics.load(this.control, LIBRE) >>> 0;
      Atomics.store(this.control, LIBRE, ranura + 1);
      Atomics.sub(this.control, USADAS, 1);
    });
  }

  /** Se llama con uso exclusivo de la ranura, mientras su nueva identidad aún no está publicada. */
  limpiar(ranura: number, conservar: readonly string[]): void {
    for (const { nombre, vista, ancho, relleno } of this.columnas.values()) {
      if (!conservar.includes(nombre)) vista.fill(relleno, ranura * ancho, (ranura + 1) * ancho);
    }
  }

  get bytes(): number {
    let total = this.control.byteLength + this.enlaces.byteLength;
    for (const { memoria } of this.columnas.values()) total += memoria.byteLength;
    return total;
  }

  private crecer(capacidad: number): void {
    const anterior = this.capacity;
    if (capacidad <= anterior) return;
    crecerSAB(this.enlaces.buffer, capacidad * Uint32Array.BYTES_PER_ELEMENT);
    for (const { vista, memoria, ancho, relleno } of this.columnas.values()) {
      crecerSAB(memoria, capacidad * ancho * vista.BYTES_PER_ELEMENT);
      if (relleno !== 0) vista.fill(relleno, anterior * ancho);
    }
    Atomics.store(this.control, CAPACIDAD, capacidad);
    Atomics.add(this.control, GENERACION, 1);
  }

  private bajoCerrojo<T>(trabajo: () => T): T {
    return conCerrojo(this.control, CERROJO, 'el asignador de la arena', trabajo);
  }
}
