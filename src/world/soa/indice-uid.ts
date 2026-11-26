import type { Col } from '../motor/contratos.js';
import { crearSAB, crecerSAB } from './arena.js';

export const MAX_FILAS_INDICE_UID = 2 ** 29;
const bytesPorRanura = Uint32Array.BYTES_PER_ELEMENT;

function capacidad(alta: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(2, 2 * alta)));
}

function mezclar(uid: number): number {
  let n = (uid | 0) ^ Math.imul((uid / 4294967296) | 0, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return n ^ (n >>> 16);
}

function buscar(ranuras: Uint32Array, uid: number, uids: Col, mascara: number): number {
  let casilla = mezclar(uid) & mascara;
  for (let entrada = ranuras[casilla]!; entrada !== 0; entrada = ranuras[casilla]!) {
    const clave = uids[entrada - 1]!;
    if (uid === clave || (Number.isNaN(uid) && Number.isNaN(clave))) break;
    casilla = (casilla + 1) & mascara;
  }
  return casilla;
}

/**
 * Índice del frente publicado. Cada casilla ocupa cuatro bytes y guarda ranura + 1; cero indica una casilla vacía.
 * Solo el coordinador lo reconstruye en la barrera, y cada dueño consulta con la columna uid de ese mismo frente.
 */
export class IndiceUid {
  readonly memoria: SharedArrayBuffer;
  readonly #ranuras: Uint32Array<SharedArrayBuffer>;

  constructor(reservaFilas: number | SharedArrayBuffer) {
    if (typeof reservaFilas === 'number') {
      if (!Number.isSafeInteger(reservaFilas) || reservaFilas < 0 || reservaFilas > MAX_FILAS_INDICE_UID) {
        throw new RangeError('Reserva de filas inválida para el índice UID.');
      }
      this.memoria = crearSAB(2 * bytesPorRanura, capacidad(reservaFilas) * bytesPorRanura);
    } else {
      this.memoria = reservaFilas;
    }
    this.#ranuras = new Uint32Array(this.memoria);
    const longitud = this.#ranuras.length;
    if (longitud < 2 || longitud > 2 * MAX_FILAS_INDICE_UID || (longitud & (longitud - 1)) !== 0) {
      throw new RangeError('Memoria incompatible con el índice UID.');
    }
  }

  reconstruir(vivo: Col, uids: Col, alta: number): void {
    if (!Number.isSafeInteger(alta) || alta < 0 || alta > Math.min(MAX_FILAS_INDICE_UID, vivo.length, uids.length)) {
      throw new RangeError('Alta inválida para el índice UID.');
    }
    const ranuras = this.#ranuras;
    crecerSAB(this.memoria, capacidad(alta) * bytesPorRanura);
    ranuras.fill(0);
    const mascara = ranuras.length - 1;
    // El recorrido ascendente deja el mismo ganador que Map.set si se repite un uid.
    for (let slot = 0; slot < alta; slot++) {
      if (!vivo[slot]) continue;
      ranuras[buscar(ranuras, uids[slot]!, uids, mascara)] = slot + 1;
    }
  }

  ranuraDe(uid: number, uids: Col): number {
    const ranuras = this.#ranuras;
    return ranuras[buscar(ranuras, uid, uids, ranuras.length - 1)]! - 1;
  }
}
