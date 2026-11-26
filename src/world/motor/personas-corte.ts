import { types } from 'node:util';
import {
  conservarFilasWpf1, marcarPoliticaBasePesos, olvidarPoliticaBasePesos, preparePackedPerson,
  type PackedPersonRow, WPF1_WEIGHT_BYTES,
} from '../../server/snapshot-packed-people.js';
import { clavesJsonUnicas } from '../../shared/json-keys.js';
import type { Person } from '../mundo/tipos.js';
import {
  aceptarRefPesos, ESTADO_BASE_PESOS, evaluarCandidatoRefPesos, identidadBasePesosValida, mismaIdentidadBasePesos,
  type ContextoBasePesos, type IdentidadBasePesos, type LectorBasePesosCorte, type LectorReconstruccionBasePesos,
  type MotivoRechazoRefPesos,
} from './base-pesos-corte.js';
import type { ParteMundo } from './reunir.js';

export interface BasePesosActiva {
  readonly lector: LectorBasePesosCorte;
  readonly contexto: ContextoBasePesos;
}

export interface ReferenciasBloquePersonasCorte {
  readonly identidad: IdentidadBasePesos;
  /** Pares (filaEnBloque, indiceEnBase) en su propio ArrayBuffer transferible. */
  readonly pares: Uint32Array;
}

export interface BloquePersonasCorte {
  readonly filas: number;
  /** Máscara WPF1 (bit menos significativo primero), seguida de una fila JSON por línea. */
  readonly cuerpo: Uint8Array;
  /** Pesos WPF1 F64LE de las filas marcadas enviadas como FULL, en el mismo orden. */
  readonly pesos: Uint8Array;
  /** Referencias a la base F64 publicada para las filas marcadas que omitieron sus 1696 B. */
  readonly refs?: ReferenciasBloquePersonasCorte;
}

export class RechazoBasePesosError extends Error {
  readonly motivo: MotivoRechazoRefPesos;
  constructor(motivo: MotivoRechazoRefPesos, detalle?: string) {
    super(detalle ?? `Referencia de base F64 rechazada (${motivo}).`);
    this.name = 'RechazoBasePesosError';
    this.motivo = motivo;
  }
}

export interface TramoPersonasVerificadas {
  readonly desde: number;
  readonly filas: readonly PackedPersonRow[];
}

export interface PersonasCorteVerificadas {
  readonly tramos: readonly TramoPersonasVerificadas[];
  readonly modificadas: ReadonlySet<Person>;
}

const verificadas = new WeakMap<readonly Person[], PersonasCorteVerificadas>();
const FILAS_POR_BLOQUE = 4096, BYTES_POR_BLOQUE = 4 * 1024 * 1024, PROFUNDIDAD_MAXIMA = 32;
const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const copiarU8 = Uint8Array.prototype.set;
const subvistaU8 = Uint8Array.prototype.subarray;
const lookupGetter: (this: object, key: PropertyKey) => unknown =
  Object.getOwnPropertyDescriptor(Object.prototype, '__lookupGetter__')!.value;

export function vincularPersonasVerificadas(personas: readonly Person[], datos: PersonasCorteVerificadas): void {
  verificadas.set(personas, datos);
}

export function personasVerificadasDe(personas: readonly Person[]): PersonasCorteVerificadas | undefined {
  return verificadas.get(personas);
}

export function tomarPersonasVerificadas(personas: readonly Person[]): PersonasCorteVerificadas | undefined {
  const datos = verificadas.get(personas);
  verificadas.delete(personas);
  return datos;
}

type Ausencia = readonly [objeto: number, posicion: number, clave: string];
interface Inspeccion {
  readonly vistos: WeakSet<object>;
  readonly ausencias: Ausencia[];
  objeto: number;
}

function registro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function filaPersona(valor: unknown): valor is Record<string, unknown> {
  return registro(valor) && Object.hasOwn(valor, 'id') && typeof valor.id === 'string'
    && Object.hasOwn(valor, 'x') && Number.isFinite(valor.x) && Object.hasOwn(valor, 'y') && Number.isFinite(valor.y);
}

function datoPropio(objeto: object, clave: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(objeto, clave);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor : undefined;
}

/** Algunas marcas internas de V8 sobreviven aunque se cambie el prototipo. */
function marcaDeV8(valor: object): boolean {
  return ArrayBuffer.isView(valor) || types.isAnyArrayBuffer(valor) || types.isMap(valor) || types.isSet(valor)
    || types.isWeakMap(valor) || types.isWeakSet(valor) || types.isPromise(valor) || types.isBoxedPrimitive(valor)
    || types.isDate(valor) || types.isRegExp(valor) || types.isNativeError(valor) || types.isArgumentsObject(valor)
    || types.isGeneratorObject(valor) || types.isMapIterator(valor) || types.isSetIterator(valor) || types.isExternal(valor);
}

/** El camino directo solo admite árboles planos con las mismas propiedades enumerables que V8. */
function inspeccionar(valor: unknown, estado: Inspeccion, profundidad: number): boolean {
  if (valor === null || typeof valor === 'string' || typeof valor === 'boolean') return true;
  if (typeof valor === 'number') return Number.isFinite(valor);
  if (typeof valor !== 'object' || profundidad > PROFUNDIDAD_MAXIMA || types.isProxy(valor) || estado.vistos.has(valor))
    return false;
  const array = Array.isArray(valor);
  if (Object.getPrototypeOf(valor) !== (array ? Array.prototype : Object.prototype) || 'toJSON' in valor
    || (!array && marcaDeV8(valor))) return false;
  estado.vistos.add(valor);
  const claves = Reflect.ownKeys(valor);
  if (array && claves.length !== valor.length + 1) return false;
  const objeto = array ? -1 : estado.objeto++;
  for (let posicion = 0; posicion < (array ? valor.length : claves.length); posicion++) {
    const clave = array ? String(posicion) : claves[posicion]!;
    if (typeof clave !== 'string') return false;
    const descriptor = datoPropio(valor, clave);
    if (!descriptor) return false;
    const hijo: unknown = descriptor.value;
    if (hijo === undefined && !array) estado.ausencias.push([objeto, posicion, clave]);
    else if (!inspeccionar(hijo, estado, profundidad + 1)) return false;
  }
  return true;
}

/** Si V8 conservaría una referencia entre las personas y otra rama, se serializan juntas. */
function comparteConElResto(parte: ParteMundo, personas: WeakSet<object>): boolean {
  const vistos = new WeakSet<object>();
  function visitar(valor: unknown): boolean {
    if (typeof valor !== 'object' || valor === null) return false;
    if (personas.has(valor) || types.isProxy(valor)) return true;
    if (vistos.has(valor)) return false;
    const proto: unknown = Object.getPrototypeOf(valor);
    // Un buffer o una vista no puede referenciar una fila o un nodo del árbol directo.
    if (ArrayBuffer.isView(valor) || types.isAnyArrayBuffer(valor)) return false;
    if (Array.isArray(valor) ? proto !== Array.prototype : (proto !== Object.prototype && proto !== null) || marcaDeV8(valor))
      return true;
    vistos.add(valor);
    const datos = valor as Record<string, unknown>;
    for (const clave of Object.keys(datos)) {
      if (lookupGetter.call(datos, clave) !== undefined || visitar(datos[clave])) return true;
    }
    return false;
  }
  for (const clave of Object.keys(parte)) {
    if (clave === 'people') continue;
    const descriptor = datoPropio(parte, clave);
    if (!descriptor || visitar(descriptor.value)) return true;
  }
  return false;
}

function empaquetar(
  filas: readonly { texto: string; fila: PackedPersonRow; indiceBase?: number }[],
  bytesTexto: number,
  bytesPesos: number,
  cantidadRefs: number,
  identidadBase?: IdentidadBasePesos,
): BloquePersonasCorte {
  const bytesMascara = Math.ceil(filas.length / 8);
  const cuerpo = new Uint8Array(bytesMascara + bytesTexto), pesos = new Uint8Array(bytesPesos);
  utf8.encodeInto(filas.map(({ texto }) => texto).join('\n'), cuerpo.subarray(bytesMascara));
  const datos = new DataView(pesos.buffer);
  const pares = cantidadRefs > 0 ? new Uint32Array(cantidadRefs * 2) : undefined;
  let offset = 0, cursorRef = 0;
  for (let i = 0; i < filas.length; i++) {
    const entrada = filas[i]!;
    const weights = entrada.fila.weights;
    if (!weights) continue;
    cuerpo[i >>> 3]! |= 1 << (i & 7);
    if (entrada.indiceBase !== undefined && pares) {
      pares[cursorRef++] = i;
      pares[cursorRef++] = entrada.indiceBase;
      continue;
    }
    for (const peso of weights) {
      datos.setFloat64(offset, peso, true);
      offset += Float64Array.BYTES_PER_ELEMENT;
    }
  }
  return pares && identidadBase
    ? { filas: filas.length, cuerpo, pesos, refs: { identidad: { ...identidadBase }, pares } }
    : { filas: filas.length, cuerpo, pesos };
}

export function prepararPersonasDirectas(parte: ParteMundo, basePesos?: BasePesosActiva): BloquePersonasCorte[] | undefined {
  if (types.isProxy(parte) || !registro(parte) || Object.getPrototypeOf(parte) !== Object.prototype) return undefined;
  const people: unknown = datoPropio(parte, 'people')?.value;
  if (types.isProxy(people) || !Array.isArray(people) || Object.getPrototypeOf(people) !== Array.prototype
    || Reflect.ownKeys(people).length !== people.length + 1) return undefined;
  try {
    const vistos = new WeakSet<object>([people]);
    const bloques: BloquePersonasCorte[] = [], filas: { texto: string; fila: PackedPersonRow; indiceBase?: number }[] = [];
    const identidadBase = basePesos?.lector.estaPublicada() ? basePesos.lector.identidad : undefined;
    let bytesTexto = 0, bytesPesos = 0, cantidadRefs = 0;
    const volcar = (): void => {
      bloques.push(empaquetar(filas, bytesTexto, bytesPesos, cantidadRefs, identidadBase));
      filas.length = bytesTexto = bytesPesos = cantidadRefs = 0;
    };
    for (let i = 0; i < people.length; i++) {
      const persona: unknown = datoPropio(people, i)?.value;
      const estado: Inspeccion = { vistos, ausencias: [], objeto: 0 };
      if (!inspeccionar(persona, estado, 0) || !filaPersona(persona)) return undefined;
      const fila = preparePackedPerson(persona);
      // En una fila con claves propias undefined, la tabulación delimita el JSON WPF1 exacto.
      estado.ausencias.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const texto = estado.ausencias.length ? `[${fila.json},\t${JSON.stringify(estado.ausencias)}]` : fila.json;
      const cuantosTexto = texto === fila.json
        ? fila.bytes - (fila.weights ? WPF1_WEIGHT_BYTES : 0) : Buffer.byteLength(texto);
      let indiceBase: number | undefined;
      if (fila.weights && basePesos && identidadBase) {
        const decision = evaluarCandidatoRefPesos(basePesos.lector, basePesos.contexto, persona.uid, fila.weights);
        if (decision.modo === 'REF') indiceBase = decision.referencia.indice;
      }
      const cuantosPesos = fila.weights && indiceBase === undefined ? WPF1_WEIGHT_BYTES : 0;
      const cuantosRefsBytes = indiceBase === undefined ? 0 : 8;
      if (1 + cuantosTexto + cuantosPesos + cuantosRefsBytes > BYTES_POR_BLOQUE) return undefined;
      if (filas.length === FILAS_POR_BLOQUE
        || Math.ceil((filas.length + 1) / 8) + bytesTexto + bytesPesos + cantidadRefs * 8
          + Number(filas.length > 0) + cuantosTexto + cuantosPesos + cuantosRefsBytes > BYTES_POR_BLOQUE)
        volcar();
      bytesTexto += cuantosTexto + Number(filas.length > 0);
      bytesPesos += cuantosPesos;
      if (indiceBase !== undefined) cantidadRefs++;
      filas.push({ texto, fila, indiceBase });
    }
    if (comparteConElResto(parte, vistos)) return undefined;
    if (filas.length) volcar();
    return bloques;
  } catch {
    return undefined;
  }
}

function ausenciasDe(texto: string): ReadonlyMap<number, readonly Ausencia[]> {
  const ausencias: unknown = JSON.parse(texto);
  if (!Array.isArray(ausencias) || !ausencias.length) throw new Error('Ausencias de personas directas inválidas.');
  const porObjeto = new Map<number, Ausencia[]>();
  let objeto = -1, posicion = -1;
  for (const ausencia of ausencias) {
    if (!Array.isArray(ausencia) || ausencia.length !== 3) throw new Error('Ausencia de persona directa inválida.');
    const [nodo, indice, clave] = ausencia;
    if (!Number.isSafeInteger(nodo) || !Number.isSafeInteger(indice) || nodo < 0 || indice < 0
      || nodo < objeto || (nodo === objeto && indice <= posicion) || typeof clave !== 'string' || clave === 'toJSON')
      throw new Error('Ausencia de persona directa inválida.');
    if (nodo !== objeto) porObjeto.set(nodo, []);
    porObjeto.get(nodo)!.push([nodo, indice, clave]);
    objeto = nodo;
    posicion = indice;
  }
  return porObjeto;
}

/** Los ordinales siguen el recorrido en profundidad de los registros; los arrays no tienen ordinal. */
function validarYRestaurar(valor: unknown, ausencias?: ReadonlyMap<number, readonly Ausencia[]>): unknown {
  let objeto = 0, restauradas = 0;
  function visitar(actual: unknown, profundidad: number): unknown {
    if (typeof actual === 'number' && !Number.isFinite(actual)) throw new Error('Número de persona directa no finito.');
    if (actual === null || typeof actual !== 'object') return actual;
    if (profundidad > PROFUNDIDAD_MAXIMA || 'toJSON' in actual) throw new Error('Forma de persona directa inválida.');
    if (Array.isArray(actual)) {
      for (let i = 0; i < actual.length; i++) actual[i] = visitar(actual[i], profundidad + 1);
      return actual;
    }
    const propias = ausencias?.get(objeto++);
    const dato = actual as Record<string, unknown>, claves = Object.keys(dato);
    if (!propias) {
      for (const clave of claves) dato[clave] = visitar(dato[clave], profundidad + 1);
      return dato;
    }
    const entradas: [string, unknown][] = [];
    let presente = 0, siguiente = 0;
    while (presente < claves.length || siguiente < propias.length) {
      const ausencia = propias[siguiente];
      if (ausencia?.[1] === entradas.length) {
        entradas.push([ausencia[2], undefined]);
        siguiente++;
      } else {
        const clave = claves[presente++];
        if (clave === undefined) throw new Error('Posición de ausencia de persona directa inválida.');
        entradas.push([clave, visitar(dato[clave], profundidad + 1)]);
      }
    }
    const restaurado = Object.fromEntries(entradas), orden = Object.keys(restaurado);
    if (orden.length !== entradas.length || orden.some((clave, i) => clave !== entradas[i]![0]))
      throw new Error('Claves de ausencia de persona directa inválidas.');
    restauradas++;
    return restaurado;
  }
  const restaurado = visitar(valor, 0);
  if (restauradas !== (ausencias?.size ?? 0)) throw new Error('Objeto de ausencia de persona directa inválido.');
  return restaurado;
}

function bufferEntero(datos: unknown): datos is Uint8Array & { buffer: ArrayBuffer } {
  return types.isUint8Array(datos) && datos.buffer instanceof ArrayBuffer
    && datos.byteOffset === 0 && datos.byteLength === datos.buffer.byteLength;
}

function paresEnteros(datos: unknown): datos is Uint32Array & { buffer: ArrayBuffer } {
  return types.isUint32Array(datos) && datos.buffer instanceof ArrayBuffer
    && datos.byteOffset === 0 && datos.byteLength === datos.buffer.byteLength && (datos.length & 1) === 0;
}

function comprobarIdentidadContraBase(
  identidadRef: unknown,
  basePesos: BasePesosActiva | undefined,
): void {
  if (!identidadBasePesosValida(identidadRef)) {
    throw new RechazoBasePesosError('referencia_invalida', 'Identidad de referencia F64 malformada o con campos inválidos.');
  }
  if (!basePesos) throw new RechazoBasePesosError('sin_base', 'El bloque usa referencias F64 sin una base publicada.');
  const { lector, contexto } = basePesos;
  const estado = lector.estado();
  if (estado === ESTADO_BASE_PESOS.PENDIENTE_ACUSE) throw new RechazoBasePesosError('base_no_publicada');
  if (estado !== ESTADO_BASE_PESOS.PUBLICADA) throw new RechazoBasePesosError('base_revocada');
  const idBase = lector.identidad;
  if (identidadRef.publicacion !== idBase.publicacion || identidadRef.publicacion !== contexto.publicacion)
    throw new RechazoBasePesosError('publicacion_distinta');
  if (identidadRef.epoca !== idBase.epoca || identidadRef.epoca !== contexto.epoca)
    throw new RechazoBasePesosError('epoca_cambiada');
  if (identidadRef.instancia !== idBase.instancia || identidadRef.instancia !== contexto.instancia)
    throw new RechazoBasePesosError('instancia_distinta');
  if (identidadRef.secuencia !== idBase.secuencia || identidadRef.secuencia !== contexto.secuencia)
    throw new RechazoBasePesosError('secuencia_distinta');
  if (identidadRef.digesto !== idBase.digesto || (contexto.digesto !== undefined && identidadRef.digesto !== contexto.digesto))
    throw new RechazoBasePesosError('digesto_distinto');
}

function validarFormaBloquePersonas(
  bloque: BloquePersonasCorte | undefined,
  restantes: number,
  buffers: WeakSet<ArrayBuffer>,
): { filas: number; anchoMascara: number; marcadas: number; cantidadRefs: number } {
  const refs = bloque?.refs;
  const bytesRefs = refs ? (paresEnteros(refs.pares) ? refs.pares.byteLength : -1) : 0;
  if (!Number.isSafeInteger(bloque?.filas) || bloque!.filas <= 0 || bloque!.filas > FILAS_POR_BLOQUE
    || bloque!.filas > restantes || !bufferEntero(bloque!.cuerpo) || !bufferEntero(bloque!.pesos)
    || bytesRefs < 0 || (refs && bytesRefs === 0)
    || bloque!.cuerpo.byteLength + bloque!.pesos.byteLength + bytesRefs > BYTES_POR_BLOQUE)
    throw new Error('Bloque de personas directas inválido.');
  const { filas, cuerpo, pesos } = bloque!;
  for (const bytes of [cuerpo, pesos, ...(refs ? [refs.pares] : [])]) {
    const buffer = bytes.buffer as ArrayBuffer;
    if (buffers.has(buffer)) throw new Error('Buffer repetido en personas directas.');
    if (!bytes.byteLength) continue;
    buffers.add(buffer);
  }
  const anchoMascara = Math.ceil(filas / 8), resto = filas & 7;
  if (cuerpo.byteLength < anchoMascara + 3 * filas - 1 || (resto && cuerpo[anchoMascara - 1]! >>> resto))
    throw new Error('Máscara de personas directas inválida.');
  let marcadas = 0;
  for (let i = 0; i < anchoMascara; i++) {
    for (let bits = cuerpo[i]!; bits; bits &= bits - 1) marcadas++;
  }
  const cantidadRefs = refs ? refs.pares.length >>> 1 : 0;
  if (cantidadRefs > marcadas) throw new Error('Referencias de pesos exceden las filas marcadas.');
  if (pesos.byteLength !== (marcadas - cantidadRefs) * WPF1_WEIGHT_BYTES)
    throw new Error('Longitud de pesos de personas directas inválida.');
  if (refs) {
    let filaAnterior = -1;
    for (let r = 0; r < refs.pares.length; r += 2) {
      const filaRef = refs.pares[r]!;
      if (filaRef >= filas || filaRef <= filaAnterior || (cuerpo[filaRef >>> 3]! & (1 << (filaRef & 7))) === 0)
        throw new Error('Índice de fila de referencia F64 inválido.');
      filaAnterior = filaRef;
    }
  }
  return { filas, anchoMascara, marcadas, cantidadRefs };
}

/** Validación previa no destructiva de forma, buffers y autoridad de referencias antes de consumir el sobre. */
export function validarBloquesPersonasPreDecode(
  bloques: readonly BloquePersonasCorte[],
  cantidad: number,
  basePesos?: BasePesosActiva,
): void {
  if (!Number.isSafeInteger(cantidad) || cantidad < 0 || cantidad > 0xffff_ffff || !Array.isArray(bloques))
    throw new Error('Rango de personas directas inválido.');
  const buffers = new WeakSet<ArrayBuffer>();
  let total = 0;
  for (const bloque of bloques) {
    const { filas } = validarFormaBloquePersonas(bloque, cantidad - total, buffers);
    if (bloque.refs) comprobarIdentidadContraBase(bloque.refs.identidad, basePesos);
    total += filas;
  }
  if (total !== cantidad) throw new Error('Cantidad de personas directas inválida.');
}

/**
 * Reconstruye bloques FULL privados e intactos a partir de bloques con REFs tras revocación natural de una base
 * previamente autorizada. No muta ni desprende los buffers de entrada y divide bloques si expandir REF→FULL
 * supera `BYTES_POR_BLOQUE`.
 */
export function reconstruirBloquesPersonasFull(
  bloques: readonly BloquePersonasCorte[],
  cantidad: number,
  lector: LectorReconstruccionBasePesos,
): BloquePersonasCorte[] {
  if (!Number.isSafeInteger(cantidad) || cantidad < 0 || cantidad > 0xffff_ffff || !Array.isArray(bloques))
    throw new Error('Rango de personas directas inválido.');
  const buffers = new WeakSet<ArrayBuffer>();
  const salida: BloquePersonasCorte[] = [];
  let total = 0;
  for (const bloque of bloques) {
    const { filas, anchoMascara, marcadas } = validarFormaBloquePersonas(bloque, cantidad - total, buffers);
    total += filas;
    const refs = bloque.refs;
    if (!refs) {
      salida.push(bloque);
      continue;
    }
    if (!identidadBasePesosValida(refs.identidad)) {
      throw new RechazoBasePesosError('referencia_invalida', 'Identidad de referencia F64 malformada.');
    }
    if (!mismaIdentidadBasePesos(refs.identidad, lector.identidad)) {
      throw new RechazoBasePesosError('publicacion_distinta', 'La referencia F64 no coincide con la base autorizada del ticket.');
    }
    const texto = utf8Strict.decode(subvistaU8.call(bloque.cuerpo, anchoMascara));
    const lineas = texto.split('\n', filas + 1);
    if (lineas.length !== filas) throw new Error('Cantidad de personas directas inválida.');
    if (!clavesJsonUnicas(texto)) throw new Error('Personas directas con claves repetidas.');

    const filasInfo: {
      textoBytes: Uint8Array;
      marcada: boolean;
      indiceBase?: number;
      uid?: number;
      offsetPesoOrigen?: number;
    }[] = new Array(filas);
    let cursorRef = 0, offsetOrigen = 0;
    for (let i = 0; i < filas; i++) {
      const linea = lineas[i]!;
      const separador = linea.startsWith('[{') ? linea.indexOf(',\t') : -1;
      const conAusencias = linea.startsWith('[{') && linea.endsWith(']]') && separador !== -1;
      const json = conAusencias ? linea.slice(1, separador) : linea;
      if (!json.startsWith('{') || !json.endsWith('}') || json.includes('\r') || json.includes('\t'))
        throw new Error('Fila de persona directa inválida.');
      const ausencias = conAusencias ? ausenciasDe(linea.slice(separador + 2, -1)) : undefined;
      const persona = validarYRestaurar(JSON.parse(json), ausencias);
      if (!filaPersona(persona)) throw new Error('Fila de persona directa inválida.');
      const marcada = (bloque.cuerpo[i >>> 3]! & (1 << (i & 7))) !== 0;
      if (marcada) {
        const candidata = persona.policy;
        if (!Object.hasOwn(persona, 'policy') || !registro(candidata) || Object.keys(candidata).length !== 1
          || !Object.hasOwn(candidata, 'weights') || !Array.isArray(candidata.weights) || candidata.weights.length !== 0)
          throw new Error('Marcador de pesos de persona directa inválido.');
      }
      const esRef = marcada && cursorRef < refs.pares.length && refs.pares[cursorRef] === i;
      if (esRef) {
        const indiceEnBase = refs.pares[cursorRef + 1]!;
        cursorRef += 2;
        const uid = persona.uid;
        if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0) {
          throw new RechazoBasePesosError('uid_invalido');
        }
        if (indiceEnBase >= lector.cantidad) {
          throw new RechazoBasePesosError('indice_invalido');
        }
        if (lector.uidEn(indiceEnBase) !== uid) {
          throw new RechazoBasePesosError('uid_no_coincide');
        }
        filasInfo[i] = { textoBytes: utf8.encode(linea), marcada: true, indiceBase: indiceEnBase, uid };
      } else if (marcada) {
        filasInfo[i] = { textoBytes: utf8.encode(linea), marcada: true, offsetPesoOrigen: offsetOrigen };
        offsetOrigen += WPF1_WEIGHT_BYTES;
      } else {
        filasInfo[i] = { textoBytes: utf8.encode(linea), marcada: false };
      }
    }
    if (cursorRef !== refs.pares.length || offsetOrigen !== bloque.pesos.byteLength) {
      throw new Error('Desajuste interno al reconstruir pesos FULL.');
    }

    const bytesFullUnico = bloque.cuerpo.byteLength + marcadas * WPF1_WEIGHT_BYTES;
    if (bytesFullUnico <= BYTES_POR_BLOQUE) {
      const cuerpoCopia = new Uint8Array(bloque.cuerpo.byteLength);
      copiarU8.call(cuerpoCopia, bloque.cuerpo, 0);
      const pesosFull = new Uint8Array(marcadas * WPF1_WEIGHT_BYTES);
      let destinoOffset = 0;
      for (const info of filasInfo) {
        if (!info.marcada) continue;
        if (info.indiceBase !== undefined) {
          lector.copiarPesosExactosEn(info.uid, info.indiceBase, pesosFull, destinoOffset);
        } else {
          copiarU8.call(
            pesosFull,
            subvistaU8.call(bloque.pesos, info.offsetPesoOrigen!, info.offsetPesoOrigen! + WPF1_WEIGHT_BYTES),
            destinoOffset,
          );
        }
        destinoOffset += WPF1_WEIGHT_BYTES;
      }
      salida.push({ filas, cuerpo: cuerpoCopia, pesos: pesosFull });
      continue;
    }

    // Si al expandir REF->FULL el bloque supera BYTES_POR_BLOQUE, se reparte en sub-bloques FULL válidos.
    let subInicio = 0;
    while (subInicio < filas) {
      let subFin = subInicio, bytesTexto = 0, subMarcadas = 0;
      while (subFin < filas && subFin - subInicio < FILAS_POR_BLOQUE) {
        const info = filasInfo[subFin]!;
        const siguienteFilas = subFin - subInicio + 1;
        const siguienteTexto = bytesTexto + info.textoBytes.byteLength + Number(subFin > subInicio);
        const siguienteMarcadas = subMarcadas + Number(info.marcada);
        const totalSub = Math.ceil(siguienteFilas / 8) + siguienteTexto + siguienteMarcadas * WPF1_WEIGHT_BYTES;
        if (totalSub > BYTES_POR_BLOQUE) {
          if (subFin === subInicio) throw new Error('Fila individual excede BYTES_POR_BLOQUE al reconstruir FULL.');
          break;
        }
        bytesTexto = siguienteTexto;
        subMarcadas = siguienteMarcadas;
        subFin++;
      }
      const subFilas = subFin - subInicio;
      const bytesMascara = Math.ceil(subFilas / 8);
      const cuerpoSub = new Uint8Array(bytesMascara + bytesTexto);
      const pesosSub = new Uint8Array(subMarcadas * WPF1_WEIGHT_BYTES);
      let cursorTexto = bytesMascara, cursorPeso = 0;
      for (let j = 0; j < subFilas; j++) {
        const info = filasInfo[subInicio + j]!;
        if (j > 0) cuerpoSub[cursorTexto++] = 0x0a;
        copiarU8.call(cuerpoSub, info.textoBytes, cursorTexto);
        cursorTexto += info.textoBytes.byteLength;
        if (!info.marcada) continue;
        cuerpoSub[j >>> 3]! |= 1 << (j & 7);
        if (info.indiceBase !== undefined) {
          lector.copiarPesosExactosEn(info.uid, info.indiceBase, pesosSub, cursorPeso);
        } else {
          copiarU8.call(
            pesosSub,
            subvistaU8.call(bloque.pesos, info.offsetPesoOrigen!, info.offsetPesoOrigen! + WPF1_WEIGHT_BYTES),
            cursorPeso,
          );
        }
        cursorPeso += WPF1_WEIGHT_BYTES;
      }
      salida.push({ filas: subFilas, cuerpo: cuerpoSub, pesos: pesosSub });
      subInicio = subFin;
    }
  }
  if (total !== cantidad) throw new Error('Cantidad de personas directas inválida.');
  return salida;
}

/** El puerto puede ceder los buffers completos. Cada buffer que el llamador conserva se copia. */
export function recibirPersonasDirectas(bloques: readonly BloquePersonasCorte[], cantidad: number,
  { transferirCuerpo = false, transferirPesos = false, basePesos, diagnostico }: {
    transferirCuerpo?: boolean;
    transferirPesos?: boolean;
    basePesos?: BasePesosActiva;
    diagnostico?: { personasRef: number; personasFull: number };
  } = {}): Person[] {
  if (!Number.isSafeInteger(cantidad) || cantidad < 0 || cantidad > 0xffff_ffff || !Array.isArray(bloques))
    throw new Error('Rango de personas directas inválido.');
  const personas: Person[] = [], tramos: TramoPersonasVerificadas[] = [], buffers = new WeakSet<ArrayBuffer>();
  for (const bloque of bloques) {
    const refs = bloque?.refs;
    const bytesRefs = refs ? (paresEnteros(refs.pares) ? refs.pares.byteLength : -1) : 0;
    if (!Number.isSafeInteger(bloque?.filas) || bloque.filas <= 0 || bloque.filas > FILAS_POR_BLOQUE
      || bloque.filas > cantidad - personas.length || !bufferEntero(bloque.cuerpo) || !bufferEntero(bloque.pesos)
      || bytesRefs < 0 || (refs && bytesRefs === 0)
      || bloque.cuerpo.byteLength + bloque.pesos.byteLength + bytesRefs > BYTES_POR_BLOQUE)
      throw new Error('Bloque de personas directas inválido.');
    const { filas, cuerpo, pesos } = bloque;
    for (const bytes of [cuerpo, pesos, ...(refs ? [refs.pares] : [])]) {
      if (buffers.has(bytes.buffer)) throw new Error('Buffer repetido en personas directas.');
      if (!bytes.byteLength) continue;
      buffers.add(bytes.buffer);
    }
    const anchoMascara = Math.ceil(filas / 8), resto = filas & 7;
    if (cuerpo.byteLength < anchoMascara + 3 * filas - 1 || (resto && cuerpo[anchoMascara - 1]! >>> resto))
      throw new Error('Máscara de personas directas inválida.');
    let marcadas = 0;
    for (let i = 0; i < anchoMascara; i++) {
      for (let bits = cuerpo[i]!; bits; bits &= bits - 1) marcadas++;
    }
    const cantidadRefs = refs ? refs.pares.length >>> 1 : 0;
    if (cantidadRefs > marcadas) throw new Error('Referencias de pesos exceden las filas marcadas.');
    if (pesos.byteLength !== (marcadas - cantidadRefs) * WPF1_WEIGHT_BYTES)
      throw new Error('Longitud de pesos de personas directas inválida.');
    if (refs) {
      if (!basePesos) throw new RechazoBasePesosError('sin_base', 'El bloque usa referencias F64 sin una base publicada.');
      let filaAnterior = -1;
      for (let r = 0; r < refs.pares.length; r += 2) {
        const filaRef = refs.pares[r]!;
        if (filaRef >= filas || filaRef <= filaAnterior || (cuerpo[filaRef >>> 3]! & (1 << (filaRef & 7))) === 0)
          throw new Error('Índice de fila de referencia F64 inválido.');
        filaAnterior = filaRef;
      }
    }
    const capturada = conservarFilasWpf1(cuerpo, anchoMascara, pesos, { transferirCuerpo, transferirPesos });
    const { texto } = capturada;
    const lineas = texto.split('\n', filas + 1);
    if (lineas.length !== filas) throw new Error('Cantidad de personas directas inválida.');
    const desde = personas.length, preparadas: PackedPersonRow[] = [];
    let inicioLinea = anchoMascara, offset = 0, cursorRef = 0;
    for (let i = 0; i < filas; i++) {
      const linea = lineas[i]!, separador = linea.startsWith('[{') ? linea.indexOf(',\t') : -1;
      const conAusencias = linea.startsWith('[{') && linea.endsWith(']]') && separador !== -1;
      const json = conAusencias ? linea.slice(1, separador) : linea;
      if (!json.startsWith('{') || !json.endsWith('}') || json.includes('\r') || json.includes('\t'))
        throw new Error('Fila de persona directa inválida.');
      const ausencias = conAusencias ? ausenciasDe(linea.slice(separador + 2, -1)) : undefined;
      const persona = validarYRestaurar(JSON.parse(json), ausencias);
      if (!filaPersona(persona)) throw new Error('Fila de persona directa inválida.');
      let policy: Record<string, unknown> | undefined;
      if (capturada.marcada(i)) {
        const candidata = persona.policy;
        if (!Object.hasOwn(persona, 'policy') || !registro(candidata) || Object.keys(candidata).length !== 1
          || !Object.hasOwn(candidata, 'weights') || !Array.isArray(candidata.weights) || candidata.weights.length !== 0)
          throw new Error('Marcador de pesos de persona directa inválido.');
        policy = candidata;
      }
      const esRef = policy !== undefined && refs !== undefined && cursorRef < refs.pares.length && refs.pares[cursorRef] === i;
      if (esRef) {
        const indiceEnBase = refs!.pares[cursorRef + 1]!;
        cursorRef += 2;
        const lector = basePesos!.lector;
        const uidEsperado = persona.uid;
        const aceptacion = aceptarRefPesos(lector, basePesos!.contexto, uidEsperado, {
          ...refs!.identidad, uid: uidEsperado, indice: indiceEnBase,
        });
        if (!aceptacion.aceptada) throw new RechazoBasePesosError(aceptacion.motivo);
        const indiceAceptado = aceptacion.indice;
        const copiarDesdeBase = (destino: Buffer, offsetDestino: number): void => {
          try { lector.copiarPesosEn(indiceAceptado, destino, offsetDestino); }
          catch (error) {
            if (!lector.estaPublicada()) throw new RechazoBasePesosError('base_revocada');
            throw error;
          }
        };
        const { fila, siguienteLinea } = capturada.fila(
          inicioLinea, linea.length, json.length, conAusencias, undefined, copiarDesdeBase,
        );
        const politicaObjetivo = policy!;
        Object.defineProperty(politicaObjetivo, 'weights', {
          enumerable: true,
          configurable: true,
          get() {
            olvidarPoliticaBasePesos(politicaObjetivo);
            let valores: number[];
            try { valores = lector.materializarPesosEn(indiceAceptado); }
            catch (error) {
              if (!lector.estaPublicada()) throw new RechazoBasePesosError('base_revocada');
              throw error;
            }
            Object.defineProperty(politicaObjetivo, 'weights', {
              value: valores, writable: true, enumerable: true, configurable: true,
            });
            return valores;
          },
        });
        marcarPoliticaBasePesos(
          politicaObjetivo,
          uid => lector.estaPublicada() && lector.uidEn(indiceAceptado) === uid,
          copiarDesdeBase,
        );
        if (diagnostico) diagnostico.personasRef++;
        preparadas.push(fila);
        inicioLinea = siguienteLinea;
        personas.push(persona as unknown as Person);
        continue;
      }
      const { fila, pesos: valores, siguienteLinea } = capturada.fila(
        inicioLinea, linea.length, json.length, conAusencias, policy ? offset : undefined);
      if (policy) {
        offset += WPF1_WEIGHT_BYTES;
        policy.weights = valores;
        if (diagnostico) diagnostico.personasFull++;
      }
      preparadas.push(fila);
      inicioLinea = siguienteLinea;
      personas.push(persona as unknown as Person);
    }
    if (!clavesJsonUnicas(texto)) throw new Error('Personas directas con claves repetidas.');
    tramos.push(Object.freeze({ desde, filas: Object.freeze(preparadas) }));
  }
  if (personas.length !== cantidad) throw new Error('Cantidad de personas directas inválida.');
  vincularPersonasVerificadas(personas, { tramos: Object.freeze(tramos), modificadas: new Set<Person>() });
  return personas;
}
