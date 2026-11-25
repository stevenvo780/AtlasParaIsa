import { ELEMENTOS, NE } from '../../shared/naturaleza.js';
import type { registrar } from '../invariantes.js';
import { TICKS_PER_DAY, type World } from '../mundo/tipos.js';
import { ENERGIA, type Libro, type MateriaCheckpoint, type Sustancia } from './tipos.js';

const ANCHO = NE + 1;
const MAX_SEGURO = BigInt(Number.MAX_SAFE_INTEGER);
export type TotalesMateria = Pick<MateriaCheckpoint, 'inicial' | 'fuentes' | 'sumideros'>;

function entero(v: number, campo: string): bigint {
  if (!Number.isSafeInteger(v)) throw new Error(`Entero inseguro en ${campo}: ${v}.`);
  return BigInt(v);
}

function comoNumero(v: bigint, campo: string): number {
  if (typeof v !== 'bigint' || v < -MAX_SEGURO || v > MAX_SEGURO) throw new Error(`Entero inseguro en ${campo}: ${v}.`);
  return Number(v);
}

function validarBalance(vector: readonly bigint[], campo: string): void {
  if (vector.length !== ANCHO) throw new Error(`Ancho inválido en ${campo}.`);
  for (let i = 0; i < ANCHO; i++) {
    const v = vector[i]!;
    if (typeof v !== 'bigint' || i !== ENERGIA && v < 0n) throw new Error(`Balance inválido en ${campo}[${i}]: ${v}.`);
  }
}

export function balancePares(
  pares: Iterable<readonly [number, number]>, sustancia: (id: number) => Readonly<Sustancia>,
): bigint[] {
  const balance = Array<bigint>(ANCHO).fill(0n);
  for (const [id, cantidad] of pares) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new Error(`Sustancia inválida: ${id}.`);
    const cuantos = entero(cantidad, 'cantidad');
    if (cuantos < 0n) throw new Error(`Cantidad negativa: ${cuantos}.`);
    if (id === 0) {
      balance[ENERGIA] += cuantos;
      continue;
    }
    const s = sustancia(id);
    if (!s || s.id !== id || s.atomos.length !== NE) throw new Error(`Sustancia inválida: ${id}.`);
    for (let i = 0; i < NE; i++) balance[i] += cuantos * BigInt(s.atomos[i]!);
    balance[ENERGIA] += cuantos * entero(s.energia, 'energía de enlace');
  }
  return balance;
}

/** Cota de Σ|términos| bajo la que un balance en doble es exacto (la mitad de 2⁵³: margen para el redondeo de la cota). */
const COTA_DOBLE = 2 ** 52;

/**
 * `balancePares` en doble para el camino caliente (fuentes, sumideros, garantías): las mismas comprobaciones con los mismos
 * errores, en `out`. Devuelve false si alguna suma parcial pudiera dejar de ser exacta; entonces vale `balancePares`.
 */
export function balanceDoble(ids: ArrayLike<number>, cant: ArrayLike<number>, n: number,
  sustancia: (id: number) => Readonly<Sustancia>, out: Float64Array): boolean {
  out.fill(0);
  let cota = 0;
  for (let k = 0; k < n; k++) {
    const id = ids[k]!, cuantos = cant[k]!;
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new Error(`Sustancia inválida: ${id}.`);
    if (!Number.isSafeInteger(cuantos)) throw new Error(`Entero inseguro en cantidad: ${cuantos}.`);
    if (cuantos < 0) throw new Error(`Cantidad negativa: ${cuantos}.`);
    if (id === 0) {
      out[ENERGIA]! += cuantos;
      cota += cuantos;
      continue;
    }
    const s = sustancia(id);
    if (!s || s.id !== id || s.atomos.length !== NE) throw new Error(`Sustancia inválida: ${id}.`);
    if (!Number.isSafeInteger(s.energia)) throw new Error(`Entero inseguro en energía de enlace: ${s.energia}.`);
    let atomos = 0;
    for (let i = 0; i < NE; i++) {
      out[i]! += cuantos * s.atomos[i]!;
      atomos += s.atomos[i]!;
    }
    out[ENERGIA]! += cuantos * s.energia;
    cota += cuantos * (atomos + Math.abs(s.energia));
  }
  return cota < COTA_DOBLE;
}

/** `prepararAsiento` con un delta de `balanceDoble`, en `out`: las mismas comprobaciones y errores. */
export function prepararAsientoDoble(cuenta: Float64Array, delta: Float64Array, signo: 1 | -1, out: Float64Array): Float64Array {
  if (cuenta.length !== ANCHO || delta.length !== ANCHO) throw new Error('Ancho de asiento inválido.');
  for (let i = 0; i < ANCHO; i++) {
    const v = cuenta[i]!;
    if (!Number.isSafeInteger(v)) throw new Error(`Entero inseguro en cuenta[${i}]: ${v}.`);
    // Si la suma exacta pasa de 2⁵³ − 1, la redondeada también: el error es el mismo que en bigint.
    const r = v + signo * delta[i]!;
    if (!(Math.abs(r) <= Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Entero inseguro en cuenta[${i}]: ${BigInt(v) + BigInt(signo) * BigInt(delta[i]!)}.`);
    }
    out[i] = r;
  }
  return out;
}

/** Valida el asiento entero antes de modificar el lote o el libro. */
export function prepararAsiento(cuenta: Float64Array, delta: readonly bigint[], signo: 1 | -1 = 1): Float64Array {
  if (cuenta.length !== ANCHO || delta.length !== ANCHO) throw new Error('Ancho de asiento inválido.');
  const factor = BigInt(signo);
  return cuenta.map((v, i) => {
    const cambio = delta[i]!;
    comoNumero(cambio, `asiento[${i}]`);
    return comoNumero(entero(v, `cuenta[${i}]`) + factor * cambio, `cuenta[${i}]`);
  });
}

function sumarCampo(libros: readonly Libro[], campo: keyof Libro): bigint[] {
  const suma = Array<bigint>(ANCHO).fill(0n);
  for (const libro of libros) {
    const cuenta = libro[campo];
    if (cuenta.length !== ANCHO) throw new Error(`Ancho inválido en ${campo}.`);
    for (let i = 0; i < ANCHO; i++) {
      const v = entero(cuenta[i]!, `${campo}[${i}]`);
      // Un abono puede dejar negativo el delta local de enVuelo hasta F0.
      if (campo !== 'enVuelo' && i !== ENERGIA && v < 0n) throw new Error(`Cuenta negativa en ${campo}[${i}].`);
      suma[i] += v;
    }
  }
  return suma;
}

export function sumarEnVuelo(libros: readonly Libro[]): bigint[] {
  const suma = sumarCampo(libros, 'enVuelo');
  validarBalance(suma, 'enVuelo');
  return suma;
}

function acumular(libros: readonly Libro[], totales: TotalesMateria): TotalesMateria {
  validarBalance(totales.inicial, 'inicial');
  validarBalance(totales.fuentes, 'fuentes');
  validarBalance(totales.sumideros, 'sumideros');
  const fuentes = sumarCampo(libros, 'fuentes').map((v, i) => totales.fuentes[i]! + v);
  const sumideros = sumarCampo(libros, 'sumideros').map((v, i) => totales.sumideros[i]! + v);
  return { inicial: totales.inicial, fuentes, sumideros };
}

/** Solo en F0 con todos los dueños detenidos. Devuelve los acumulados que sustituyen a los del mundo. */
export function plegarLibros(libros: readonly Libro[], totales: TotalesMateria): TotalesMateria {
  if (libros.length === 0) throw new Error('Falta el libro del hilo 0.');
  const nuevosTotales = acumular(libros, totales);
  const vuelos = sumarEnVuelo(libros).map((v, i) => comoNumero(v, `enVuelo[${i}]`));
  for (const libro of libros) {
    libro.enVuelo.fill(0);
    libro.fuentes.fill(0);
    libro.sumideros.fill(0);
  }
  libros[0]!.enVuelo.set(vuelos);
  return nuevosTotales;
}

function desbalances(totales: TotalesMateria, lotes: readonly bigint[], enVuelo: readonly bigint[]) {
  validarBalance(totales.inicial, 'inicial');
  validarBalance(totales.fuentes, 'fuentes');
  validarBalance(totales.sumideros, 'sumideros');
  validarBalance(lotes, 'lotes');
  validarBalance(enVuelo, 'enVuelo');
  const errores: { magnitud: string; esperado: bigint; observado: bigint }[] = [];
  for (let i = 0; i < ANCHO; i++) {
    const esperado = totales.inicial[i]! + totales.fuentes[i]! - totales.sumideros[i]!;
    const observado = lotes[i]! + enVuelo[i]!;
    if (esperado !== observado) errores.push({ magnitud: ELEMENTOS[i] ?? 'energía', esperado, observado });
  }
  return errores;
}

export function comprobarConservacion(totales: TotalesMateria, lotes: readonly bigint[], enVuelo: readonly bigint[]): void {
  const [error] = desbalances(totales, lotes, enVuelo);
  if (error) throw new Error(`No se conserva ${error.magnitud}: se esperaba ${error.esperado}, hay ${error.observado}.`);
}

export function registrarConservacion(
  alta: typeof registrar,
  leer: (mundo: World) => { totales: TotalesMateria; lotes: readonly bigint[]; libros: readonly Libro[] } | null,
): () => void {
  const id = 'materia.conservacion';
  return alta({
    id, carril: 'A', gravedad: 'dura', alcance: 'global', cadaTicks: TICKS_PER_DAY,
    comprobar(mundo) {
      const lectura = leer(mundo);
      if (!lectura) return [];
      const { totales, lotes, libros } = lectura;
      return desbalances(acumular(libros, totales), lotes, sumarEnVuelo(libros)).map(({ magnitud, esperado, observado }) => ({
        id, gravedad: 'dura', tick: mundo.tick, detalle: `No se conserva ${magnitud}.`,
        contexto: { magnitud, esperado: String(esperado), observado: String(observado) },
      }));
    },
  });
}
