import { ErrorFatalMotor } from '../paralelo/barrera.js';
import { crecerSAB, crearSAB } from '../soa/arena.js';
import type { Buzon, Cola, Hilo, Intento } from './contratos.js';
import { TipoIntento } from './contratos.js';

export type FaseMotor = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const FASE_LECTURA = { M: 1, A: 5, B: 1, F0: 0 } as const;
const PALABRA = Float64Array.BYTES_PER_ELEMENT;
const CABECERA = 9;
/** Tope por cola si el anfitrión no da otro. Es reserva virtual, no memoria usada: 28 dueños × 3 colas
 * caben de sobra en los 128 TiB de direcciones. Las leyes no preguntan a la máquina, así que el
 * anfitrión que quiera el límite físico lo pasa al construir `Buzones`. */
export const MAX_BYTES_COLA = 2 ** 36;

function colaDe(fase: FaseMotor, tipo: Intento['tipo']): Cola {
  if (tipo === TipoIntento.Migrante) return 'M';
  if (tipo === TipoIntento.Activar || tipo === TipoIntento.Global) return 'F0';
  return fase >= 1 && fase <= 4 ? 'A' : 'B';
}

function barajar<T>(lote: T[], azar: () => number): void {
  for (let i = lote.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1));
    [lote[i], lote[j]] = [lote[j], lote[i]];
  }
}

interface ColaCompartida {
  readonly cursores: BigUint64Array;
  readonly datos: SharedArrayBuffer;
  readonly listos: Uint8Array;
}

export interface MemoriaBuzones {
  readonly fase: Int32Array;
  readonly f0: ColaCompartida;
  readonly duenos: readonly Pick<Record<Cola, ColaCompartida>, 'M' | 'A' | 'B'>[];
}

function crearCola(maxBytes: number): ColaCompartida {
  return {
    cursores: new BigUint64Array(new SharedArrayBuffer(2 * BigUint64Array.BYTES_PER_ELEMENT)),
    datos: crearSAB(0, maxBytes),
    listos: new Uint8Array(crearSAB(0, maxBytes / PALABRA)),
  };
}

const capacidad = (n: number, actual: number, max: number) => Math.min(max, Math.max(n, 512, 2 * actual));

function enviar(cola: ColaCompartida, i: Intento): void {
  const m = i.materia?.length ?? -1, d = i.dato?.length ?? -1, b = i.bytes?.length ?? -1;
  const palabras = CABECERA + Math.max(0, m) + Math.max(0, d);
  const tam = palabras + Math.ceil(Math.max(0, b) / PALABRA);
  const inicio = Number(Atomics.add(cola.cursores, 0, BigInt(tam)));
  const fin = inicio + tam;
  const maxBytes = cola.datos.maxByteLength;
  if (fin * PALABRA > maxBytes) throw new ErrorFatalMotor('Buzón sin memoria para el paso.');
  if (fin * PALABRA > cola.datos.byteLength) {
    crecerSAB(cola.datos, capacidad(fin * PALABRA, cola.datos.byteLength, maxBytes));
  }
  if (fin > cola.listos.length) {
    crecerSAB(cola.listos.buffer as SharedArrayBuffer, capacidad(fin, cola.listos.length, maxBytes / PALABRA));
  }
  const fila = new Float64Array(cola.datos, inicio * PALABRA, palabras);
  fila[0] = i.tipo; fila[1] = i.de; fila[2] = i.a; fila[3] = i.celda; fila[4] = i.lote; fila[5] = i.nonce;
  fila[6] = m; fila[7] = d; fila[8] = b;
  if (i.materia) fila.set(i.materia, CABECERA);
  if (i.dato) fila.set(i.dato, CABECERA + Math.max(0, m));
  if (i.bytes) new Uint8Array(cola.datos, (inicio + palabras) * PALABRA, b).set(i.bytes);
  Atomics.store(cola.listos, inicio, 1);
}

function entregar(datos: Float64Array, inicio: number, f: (i: Intento) => void): void {
  const m = datos[inicio + 6], d = datos[inicio + 7], b = datos[inicio + 8];
  const materia = inicio + CABECERA, datum = materia + Math.max(0, m);
  f({ tipo: datos[inicio] as Intento['tipo'], de: datos[inicio + 1], a: datos[inicio + 2],
    celda: datos[inicio + 3], lote: datos[inicio + 4], nonce: datos[inicio + 5],
    materia: m < 0 ? null : datos.subarray(materia, materia + m),
    dato: d < 0 ? null : datos.subarray(datum, datum + d),
    bytes: b < 0 ? null : new Uint8Array(datos.buffer, (datum + Math.max(0, d)) * PALABRA, b),
  });
}

function vaciar(cola: ColaCompartida, f: (i: Intento) => void, azar?: () => number): number {
  const datos = new Float64Array(cola.datos);
  const fin = Atomics.load(cola.cursores, 0);
  let inicio = Number(Atomics.load(cola.cursores, 1));
  const orden = azar ? [] as number[] : null;
  let n = 0;
  // Un envío reserva su rango antes de copiarlo. Solo el prefijo publicado es legible.
  while (inicio < Number(fin) && inicio < cola.listos.length && Atomics.load(cola.listos, inicio) === 1) {
    if (orden) orden.push(inicio);
    else entregar(datos, inicio, f);
    Atomics.store(cola.listos, inicio, 0);
    inicio += CABECERA + Math.max(0, datos[inicio + 6]) + Math.max(0, datos[inicio + 7])
      + Math.ceil(Math.max(0, datos[inicio + 8]) / PALABRA);
    n++;
  }
  if (orden && azar) {
    barajar(orden, azar);
    for (const posicion of orden) entregar(datos, posicion, f);
  }
  const leidos = BigInt(inicio);
  // Se recicla el espacio solo tras la última entrega y si ningún productor añadió un rango.
  const reciclar = leidos === fin && Atomics.compareExchange(cola.cursores, 0, fin, 0n) === fin;
  Atomics.store(cola.cursores, 1, reciclar ? 0n : leidos);
  return n;
}

function abrirBuzon(hilo: Hilo, azar: () => number, fase: () => FaseMotor,
  poner: (destino: Hilo, cola: Cola, i: Intento) => void,
  sacar: (cola: Cola, f: (i: Intento) => void, azar?: () => number) => number): Buzon {
  const vaciando = new Set<Cola>();
  let fallo = false;
  return {
    enviar(destino, i) {
      if (fallo) throw new ErrorFatalMotor('Buzón abortado.');
      const cola = colaDe(fase(), i.tipo);
      try { poner(cola === 'F0' ? 0 : destino, cola, i); }
      catch (error) { fallo = true; throw error instanceof ErrorFatalMotor ? error : new ErrorFatalMotor(error); }
    },
    vaciar(cola, f) {
      if (fallo) throw new ErrorFatalMotor('Buzón abortado.');
      if (FASE_LECTURA[cola] !== fase() || cola === 'F0' && hilo !== 0 || vaciando.has(cola)) {
        throw new Error(`Vaciado de ${cola} inválido en F${fase()} por el hilo ${hilo}.`);
      }
      vaciando.add(cola);
      try { return sacar(cola, f, cola === 'A' || cola === 'B' ? azar : undefined); }
      catch (error) { fallo = true; throw error instanceof ErrorFatalMotor ? error : new ErrorFatalMotor(error); }
      finally { vaciando.delete(cola); }
    },
  };
}

export function conectarBuzon(memoria: MemoriaBuzones, hilo: Hilo, azar: () => number): Buzon {
  const propio = memoria.duenos[hilo];
  if (!propio) throw new RangeError(`Hilo sin buzón: ${hilo}.`);
  return abrirBuzon(hilo, azar, () => Atomics.load(memoria.fase, 0) as FaseMotor, (destino, cola, i) => {
    const entrada = cola === 'F0' ? memoria.f0 : memoria.duenos[destino]?.[cola];
    if (!entrada) throw new RangeError(`Destino sin buzón: ${destino}.`);
    enviar(entrada, i);
  }, (cola, f, rng) => vaciar(cola === 'F0' ? memoria.f0 : propio[cola], f, rng));
}

export class Buzones {
  readonly memoria: MemoriaBuzones | null;
  private fase: FaseMotor = 0;
  private local: Record<Cola, Intento[]> = { F0: [], M: [], A: [], B: [] };

  constructor(hilos: number, maxBytesCola = MAX_BYTES_COLA) {
    if (!Number.isSafeInteger(hilos) || hilos < 1) throw new RangeError(`Cantidad de hilos inválida: ${hilos}.`);
    if (!Number.isSafeInteger(maxBytesCola) || maxBytesCola < PALABRA) throw new RangeError(`Tope de cola inválido: ${maxBytesCola}.`);
    const max = Math.floor(maxBytesCola / PALABRA) * PALABRA;
    this.memoria = hilos === 1 ? null : {
      fase: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      f0: crearCola(max),
      duenos: Array.from({ length: hilos }, () => ({ M: crearCola(max), A: crearCola(max), B: crearCola(max) })),
    };
  }

  fijarFase(fase: FaseMotor): void {
    if (this.memoria) Atomics.store(this.memoria.fase, 0, fase);
    else this.fase = fase;
  }

  dueno(hilo: Hilo, azar: () => number): Buzon {
    if (this.memoria) return conectarBuzon(this.memoria, hilo, azar);
    if (hilo !== 0) throw new RangeError(`Hilo sin buzón: ${hilo}.`);
    return abrirBuzon(0, azar, () => this.fase, (destino, cola, i) => {
      if (destino !== 0) throw new RangeError(`Destino sin buzón: ${destino}.`);
      this.local[cola].push({ ...i, materia: i.materia && new Float64Array(i.materia),
        dato: i.dato && new Float64Array(i.dato), bytes: i.bytes && new Uint8Array(i.bytes) });
    }, (cola, f, rng) => {
      const lote = this.local[cola];
      this.local[cola] = [];
      if (rng) barajar(lote, rng);
      for (const i of lote) f(i);
      return lote.length;
    });
  }
}
