import { NE } from '../../shared/naturaleza.js';
import { registrar, type Violacion } from '../invariantes.js';
import type { Libro } from '../materia/tipos.js';
import type { World } from '../mundo/tipos.js';
import { ErrorFatalMotor } from '../paralelo/barrera.js';
import type { CtxDueno } from './contratos.js';

export type TipoId = Parameters<CtxDueno['id']>[0];
const TIPOS = { uid: 0, suceso: 1, comunidad: 2, estructura: 3, nonce: 4 } as const;
const CLAVES = Object.keys(TIPOS) as TipoId[];
const LIMITE = 2 ** 53;
/** Celda aparte, fuera de `CtxDueno.id`: el número del próximo suceso de la crónica (`e<n>`). La crónica exige ids
 * contiguos, así que solo lo toma `CtxDueno.suceso`, que crea siempre el suceso que numera. */
const CRONICA = CLAVES.length;
const CELDAS = CLAVES.length + 1;

export class Contadores {
  readonly memoria: BigUint64Array | null;
  private readonly locales = new Float64Array(CELDAS);

  constructor(hilosOMemoria: number | BigUint64Array, primeros: Partial<Record<TipoId, number>> = {}) {
    if (hilosOMemoria instanceof BigUint64Array) {
      this.memoria = hilosOMemoria;
      return;
    }
    if (!Number.isSafeInteger(hilosOMemoria) || hilosOMemoria < 1) throw new RangeError('Cantidad de hilos inválida.');
    this.memoria = hilosOMemoria === 1 ? null : new BigUint64Array(new SharedArrayBuffer(CELDAS * 8));
    for (const tipo of CLAVES) {
      const minimo = tipo === 'uid' ? 1 : 0;
      const n = primeros[tipo] ?? minimo;
      if (!Number.isInteger(n) || n < minimo || n > LIMITE) throw new RangeError(`Contador inicial inválido: ${tipo}.`);
      if (this.memoria) Atomics.store(this.memoria, TIPOS[tipo], BigInt(n));
      else this.locales[TIPOS[tipo]] = n;
    }
  }

  id(tipo: TipoId): number { return this.tomar(TIPOS[tipo], tipo); }

  /** Número del siguiente suceso de la crónica. */
  cronica(): number { return this.tomar(CRONICA, 'crónica'); }
  /** Fija el próximo número de crónica (al abrir una época, con los dueños detenidos). */
  fijarCronica(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Contador de crónica inválido.');
    if (this.memoria && this.memoria.length > CRONICA) Atomics.store(this.memoria, CRONICA, BigInt(n));
    else this.locales[CRONICA] = n;
  }
  get siguienteCronica(): number {
    return this.memoria && this.memoria.length > CRONICA ? Number(Atomics.load(this.memoria, CRONICA)) : this.locales[CRONICA]!;
  }

  private tomar(i: number, tipo: string): number {
    if (this.memoria) {
      let siguiente = Atomics.load(this.memoria, i);
      while (siguiente < BigInt(LIMITE)) {
        const anterior = Atomics.compareExchange(this.memoria, i, siguiente, siguiente + 1n);
        if (anterior === siguiente) return Number(siguiente);
        siguiente = anterior;
      }
    } else if (this.locales[i] < LIMITE) {
      return this.locales[i]++;
    }
    throw new ErrorFatalMotor(`Agotado el espacio de identificadores de ${tipo}.`);
  }

  siguientes(): Record<TipoId, number> {
    const n = (tipo: TipoId) => this.memoria ? Number(Atomics.load(this.memoria, TIPOS[tipo])) : this.locales[TIPOS[tipo]];
    return { uid: n('uid'), suceso: n('suceso'), comunidad: n('comunidad'), estructura: n('estructura'), nonce: n('nonce') };
  }
}

export function crearLibros(hilos: number): Libro[] {
  if (!Number.isSafeInteger(hilos) || hilos < 1) throw new RangeError('Cantidad de hilos inválida.');
  const ancho = NE + 1;
  const bytes = ancho * Float64Array.BYTES_PER_ELEMENT;
  const memoria = hilos === 1 ? new ArrayBuffer(3 * bytes) : new SharedArrayBuffer(hilos * 3 * bytes);
  return Array.from({ length: hilos }, (_, hilo) => ({
    enVuelo: new Float64Array(memoria, hilo * 3 * bytes, ancho),
    fuentes: new Float64Array(memoria, (hilo * 3 + 1) * bytes, ancho),
    sumideros: new Float64Array(memoria, (hilo * 3 + 2) * bytes, ancho),
  }));
}

export interface BalanceBuzones {
  enviados: number; aplicados: number; devueltos: number; depositados: number; reenviados: number;
  pendientes: number; edadMaxGarantia: number;
}

/** M5 aporta los destinos reales de cada envío al reunir los resultados en F0. */
export function registrarInvarianteBuzones(leer: (mundo: World) => BalanceBuzones | null): () => void {
  const id = 'motor-buzones', gravedad = 'dura';
  return registrar({ id, carril: 'M1', gravedad, alcance: 'global', cadaTicks: 60, comprobar(mundo) {
    const balance = leer(mundo);
    if (!balance) return [];
    if (!Object.values(balance).every(n => Number.isSafeInteger(n) && n >= 0)) return [{
      id, gravedad, tick: mundo.tick, detalle: 'El balance de intentos contiene un contador inválido.',
    }];
    const resultados: Violacion[] = [];
    const { enviados, aplicados, devueltos, depositados, reenviados, pendientes, edadMaxGarantia } = balance;
    const acreditados = aplicados + devueltos + depositados + reenviados + pendientes;
    const fallo = (detalle: string, esperado: number, observado: number) => resultados.push({
      id, gravedad, tick: mundo.tick, detalle, esperado, observado,
    });
    if (enviados !== acreditados) fallo('El saldo de intentos no cuadra.', enviados, acreditados);
    if (edadMaxGarantia > 2) fallo('Hay una garantía con más de dos ticks.', 2, edadMaxGarantia);
    return resultados;
  } });
}
