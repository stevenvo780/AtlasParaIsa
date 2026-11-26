import { types } from 'node:util';
import { stringifyExact } from '../../shared/exact-json.js';
import { clavesJsonUnicas } from '../../shared/json-keys.js';
import type { Animal } from '../animals.js';
import type { ParteMundo } from './reunir.js';

export interface BloqueFaunaCorte {
  readonly filas: number;
  readonly cuerpo: Uint8Array;
}

export interface TramoFaunaCorte {
  readonly desde: number;
  readonly bloques: readonly BloqueFaunaCorte[];
}

export interface TramoFaunaVerificada {
  readonly desde: number;
  readonly filas: readonly string[];
}

const cortes = new WeakMap<readonly Animal[], readonly TramoFaunaCorte[]>();
const verificadas = new WeakMap<readonly Animal[], readonly TramoFaunaVerificada[]>();
const TAMANO_BLOQUE = 4 * 1024 * 1024;
const utf8 = new TextEncoder();
const utf8Estricto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Las filas preparadas viven lo que vive el array de la instantánea. */
export function vincularFaunaCorte(animales: readonly Animal[], tramos: readonly TramoFaunaCorte[]): void {
  cortes.set(animales, tramos);
}

export function faunaCorteDe(animales: readonly Animal[]): readonly TramoFaunaCorte[] | undefined {
  return cortes.get(animales);
}

export function vincularFaunaVerificada(animales: readonly Animal[], tramos: readonly TramoFaunaVerificada[]): void {
  verificadas.set(animales, tramos);
}

export function faunaVerificadaDe(animales: readonly Animal[]): readonly TramoFaunaVerificada[] | undefined {
  return verificadas.get(animales);
}

export function tomarFaunaVerificada(animales: readonly Animal[]): readonly TramoFaunaVerificada[] | undefined {
  const tramos = verificadas.get(animales);
  verificadas.delete(animales);
  return tramos;
}

/** Comprueba un árbol de datos antes de delegar la codificación al JSON durable. */
function representable(valor: unknown, vistos: WeakSet<object>, profundidad = 0): boolean {
  if (valor === null || typeof valor === 'string' || typeof valor === 'boolean') return true;
  if (typeof valor === 'number') return Number.isFinite(valor);
  // Una forma desconocida muy profunda conserva el camino canónico, incluida su gestión de errores.
  if (typeof valor !== 'object' || profundidad > 32 || types.isProxy(valor) || vistos.has(valor)) return false;
  const array = Array.isArray(valor);
  if (Object.getPrototypeOf(valor) !== (array ? Array.prototype : Object.prototype) || 'toJSON' in valor) return false;
  // V8 conserva la marca interna de algunos objetos aunque se les sustituya el prototipo.
  if (!array && (types.isAnyArrayBuffer(valor) || ArrayBuffer.isView(valor) || types.isMap(valor) || types.isSet(valor)
    || types.isWeakMap(valor) || types.isWeakSet(valor) || types.isPromise(valor) || types.isBoxedPrimitive(valor)
    || types.isDate(valor) || types.isRegExp(valor) || types.isNativeError(valor))) return false;
  vistos.add(valor);
  const claves = Reflect.ownKeys(valor);
  if (array && claves.length !== valor.length + 1) return false;
  for (let i = 0; i < (array ? valor.length : claves.length); i++) {
    const clave = array ? i : claves[i]!;
    if (typeof clave === 'symbol') return false;
    const descriptor = Object.getOwnPropertyDescriptor(valor, clave);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const hijo: unknown = descriptor.value;
    // JSON durable omite propiedades opcionales propias con valor undefined.
    if (!array && hijo === undefined) continue;
    if (!representable(hijo, vistos, profundidad + 1)) return false;
  }
  return true;
}

/** Reunir escribe sobre las filas de teselas y personas. Comprueba las identidades sin ejecutar accesores. */
function comparteFilas(filas: readonly object[], vistos: WeakSet<object>): boolean {
  if (!Array.isArray(filas) || types.isProxy(filas) || vistos.has(filas)) return true;
  for (let i = 0; i < filas.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(filas, i);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || vistos.has(descriptor.value)) return true;
  }
  return false;
}

export function prepararFaunaDirecta(parte: ParteMundo): BloqueFaunaCorte[] | undefined {
  const { animals, tiles, people, ...resto } = parte, vistos = new WeakSet<object>();
  if (!Array.isArray(animals) || !representable(animals, vistos)) return undefined;
  if (animals.some(animal => animal === null || typeof animal !== 'object' || Array.isArray(animal))) return undefined;
  if (Object.values(resto).some(valor => typeof valor === 'object' && valor !== null && vistos.has(valor))) return undefined;
  if (animals.length && (comparteFilas(tiles, vistos) || comparteFilas(people, vistos))) return undefined;
  try { return prepararFaunaCorte(animals); }
  catch { return undefined; }
}

/** Una fila por línea, con el JSON exacto del guardado y un buffer transferible por bloque. */
export function prepararFaunaCorte(animales: readonly Animal[]): BloqueFaunaCorte[] {
  const bloques: BloqueFaunaCorte[] = [], filas: string[] = [];
  let bytes = 0;
  const volcar = (): void => {
    bloques.push({ filas: filas.length, cuerpo: utf8.encode(filas.join('\n')) });
    filas.length = 0;
    bytes = 0;
  };
  for (const animal of animales) {
    const fila = stringifyExact(animal);
    if (typeof fila !== 'string' || !fila.startsWith('{')) throw new Error('Fila de fauna inválida en el corte.');
    const tamano = Buffer.byteLength(fila);
    if (filas.length && bytes + 1 + tamano > TAMANO_BLOQUE) volcar();
    bytes += tamano + Number(filas.length > 0);
    filas.push(fila);
    if (bytes >= TAMANO_BLOQUE) volcar();
  }
  if (filas.length) volcar();
  return bloques;
}

export function validarFaunaCorte(bloques: readonly BloqueFaunaCorte[], esperadas: number): boolean {
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

/** Decodifica una sola vez los organismos y conserva las filas exactas en el orden del corte. */
export function recibirFaunaDirecta(bloques: readonly BloqueFaunaCorte[], cantidad: number): Animal[] {
  if (!Number.isSafeInteger(cantidad) || cantidad < 0 || cantidad > 0xffffffff
    || !Array.isArray(bloques) || !validarFaunaCorte(bloques, cantidad)) throw new Error('Rango de fauna directa inválido.');
  const animales: Animal[] = [], tramos: TramoFaunaVerificada[] = [];
  for (const { filas, cuerpo } of bloques) {
    if (filas > (cuerpo.byteLength + 1) / 3) throw new Error('Cantidad de fauna directa inválida.');
    const texto = utf8Estricto.decode(cuerpo);
    if (!clavesJsonUnicas(texto)) throw new Error('Fauna directa con claves repetidas.');
    const filasTexto = texto.split('\n', filas + 1);
    if (filasTexto.length !== filas) throw new Error('Cantidad de fauna directa inválida.');
    const desde = animales.length;
    for (const fila of filasTexto) {
      if (!fila.startsWith('{') || !fila.endsWith('}') || fila.includes('\r')) throw new Error('Fila de fauna directa inválida.');
      animales.push(JSON.parse(fila) as Animal);
    }
    tramos.push(Object.freeze({ desde, filas: Object.freeze(filasTexto) }));
  }
  vincularFaunaVerificada(animales, Object.freeze(tramos));
  return animales;
}
