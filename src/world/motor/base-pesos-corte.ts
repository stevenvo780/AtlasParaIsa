import { createHash, hash as cryptoHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { isPackedPersonWeight, WPF1_WEIGHT_BYTES, WPF1_WEIGHT_COUNT } from '../../server/snapshot-packed-people.js';
import { decodePolicyWeightPage, POLICY_UIDS_PER_PAGE } from '../../server/snapshot-policy-pages.js';

export const VERSION_BASE_PESOS_CORTE = 1;
export const PESOS_POR_PERSONA = WPF1_WEIGHT_COUNT;
export const BYTES_PESOS_PERSONA = WPF1_WEIGHT_BYTES;
export const FILAS_POR_SLAB_DEFECTO = POLICY_UIDS_PER_PAGE;

export const ESTADO_BASE_PESOS = {
  PENDIENTE_ACUSE: 0,
  PUBLICADA: 1,
  REVOCADA: 2,
} as const;

export type EstadoBasePesos = (typeof ESTADO_BASE_PESOS)[keyof typeof ESTADO_BASE_PESOS];

const MAX_TEXTO_ID_LEN = 128;
const MAX_FILAS_ABSOLUTO = 4_000_000;
const MAX_FILAS_POR_SLAB_ABSOLUTO = 65_536;
const MAX_BYTES_PESOS_ABSOLUTO = MAX_FILAS_ABSOLUTO * BYTES_PESOS_PERSONA;
const CONTROL_SLOTS = 2;
const CONTROL_ESTADO = 0;
const CONTROL_SELLADO = 1;
const CONTROL_BYTES = CONTROL_SLOTS * Int32Array.BYTES_PER_ELEMENT;
const DIGESTO_HEX = /^[0-9a-f]{64}$/;
const DOMINIO_DIGESTO = Buffer.from('BASE_PESOS_F64_V1\0');
const BYTES_HUELLA_FILA = 32;
const ES_LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;
const CLAVES_IDENTIDAD = new Set([
  'version', 'publicacion', 'instancia', 'epoca', 'secuencia', 'digesto',
]);
const CLAVES_REFERENCIA = new Set([
  'version', 'publicacion', 'instancia', 'epoca', 'secuencia', 'digesto', 'uid', 'indice',
]);
const lookupGetter: (this: object, key: PropertyKey) => unknown =
  Object.getOwnPropertyDescriptor(Object.prototype, '__lookupGetter__')!.value;
const copiarBytesU8 = Uint8Array.prototype.set;
const rellenarBytesU8 = Uint8Array.prototype.fill;
const subvistaU8 = Uint8Array.prototype.subarray;

export interface CotasBasePesos {
  readonly maxFilas: number;
  readonly maxBytesPesos: number;
  readonly filasPorSlab: number;
  readonly pesosPorFila: number;
}

export const COTAS_BASE_PESOS_DEFECTO: Readonly<CotasBasePesos> = Object.freeze({
  maxFilas: 2_000_000,
  maxBytesPesos: 2_000_000 * BYTES_PESOS_PERSONA,
  filasPorSlab: FILAS_POR_SLAB_DEFECTO,
  pesosPorFila: PESOS_POR_PERSONA,
});

export interface IdentidadBasePesos {
  readonly version: number;
  /** Identificador irrepetible generado al construir la base: impide cruzar REFs entre publicaciones. */
  readonly publicacion: string;
  readonly instancia: string;
  readonly epoca: number;
  readonly secuencia: number;
  readonly digesto: string;
}

export interface MetadatosPublicacionBasePesos {
  readonly instancia: string;
  readonly epoca: number;
  readonly secuencia: number;
}

export interface AcuseDurableBasePesos extends IdentidadBasePesos {
  readonly confirmado: true;
}

export interface ContextoBasePesos {
  readonly publicacion: string;
  readonly instancia: string;
  readonly epoca: number;
  readonly secuencia: number;
  readonly digesto?: string;
}

/**
 * Descriptor clonable entre hilos vía canal de trabajadores de confianza (MessagePort/workerData).
 * Nunca debe viajar dentro de una REF ni aceptarse como autoridad externa: el receptor abre su propio lector
 * a partir del descriptor publicado localmente.
 *
 * Límite de plataforma: JavaScript/V8 no ofrece SharedArrayBuffer de solo lectura por hardware; esta API
 * no expone vistas mutables sobre los slabs, pero un escritor ajeno al contrato con acceso al SAB podría
 * alterar bytes (detectable con `verificarIntegridadBasePesos`).
 */
export interface DescriptorBasePesosCorte extends IdentidadBasePesos {
  readonly cotas: CotasBasePesos;
  readonly cantidad: number;
  readonly uidMin: number;
  readonly uidMax: number;
  readonly control: SharedArrayBuffer;
  readonly uids: SharedArrayBuffer;
  readonly slabs: readonly SharedArrayBuffer[];
}

export interface PaginaWgp1Entrada {
  readonly body: Uint8Array;
  readonly count: number;
}

export interface FilaWgp1Comprobada {
  readonly uid: number;
  readonly body: Uint8Array;
  readonly offset: number;
}

export type PesosF64Entrada = readonly number[] | Float64Array | Uint8Array;

export interface ReferenciaPesosCorte extends IdentidadBasePesos {
  readonly uid: number;
  readonly indice: number;
}

export type MotivoBasePesosComun =
  | 'sin_base'
  | 'identidad_ausente'
  | 'base_no_publicada'
  | 'base_revocada'
  | 'publicacion_distinta'
  | 'instancia_distinta'
  | 'epoca_cambiada'
  | 'secuencia_distinta'
  | 'digesto_distinto';

export type MotivoFallbackPesos =
  | MotivoBasePesosComun
  | 'uid_invalido'
  | 'uid_ausente'
  | 'pesos_invalidos'
  | 'pesos_modificados';

export type DecisionRefPesos =
  | { readonly modo: 'REF'; readonly referencia: ReferenciaPesosCorte }
  | { readonly modo: 'FULL'; readonly motivo: MotivoFallbackPesos };

export type MotivoRechazoRefPesos =
  | MotivoBasePesosComun
  | 'referencia_invalida'
  | 'version_distinta'
  | 'uid_invalido'
  | 'uid_no_coincide'
  | 'indice_invalido';

export type ResultadoAceptacionRefPesos =
  | { readonly aceptada: true; readonly uid: number; readonly indice: number }
  | { readonly aceptada: false; readonly motivo: MotivoRechazoRefPesos };

function esObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor) || types.isProxy(valor)) return false;
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

function esEnteroNoNegativo(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0 && !Object.is(valor, -0);
}

function esUidValido(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor > 0;
}

function validarTextoId(valor: unknown, nombre: string): string {
  if (typeof valor !== 'string' || valor.length === 0 || valor.length > MAX_TEXTO_ID_LEN)
    throw new Error(`${nombre} de base de pesos inválida.`);
  return valor;
}

function validarDigesto(valor: unknown): string {
  if (typeof valor !== 'string' || !DIGESTO_HEX.test(valor))
    throw new Error('Digesto de base de pesos inválido.');
  return valor;
}

function resolverCotas(parciales?: Partial<CotasBasePesos>): CotasBasePesos {
  const cotas: CotasBasePesos = {
    maxFilas: parciales?.maxFilas ?? COTAS_BASE_PESOS_DEFECTO.maxFilas,
    maxBytesPesos: parciales?.maxBytesPesos ?? COTAS_BASE_PESOS_DEFECTO.maxBytesPesos,
    filasPorSlab: parciales?.filasPorSlab ?? COTAS_BASE_PESOS_DEFECTO.filasPorSlab,
    pesosPorFila: parciales?.pesosPorFila ?? COTAS_BASE_PESOS_DEFECTO.pesosPorFila,
  };
  validarCotas(cotas);
  return Object.freeze(cotas);
}

function validarCotas(cotas: unknown): asserts cotas is CotasBasePesos {
  if (!esObjetoPlano(cotas)) throw new Error('Cotas de base de pesos inválidas.');
  const { maxFilas, maxBytesPesos, filasPorSlab, pesosPorFila } = cotas;
  if (pesosPorFila !== PESOS_POR_PERSONA) throw new Error('Dimensión de pesos por fila inválida.');
  if (!esEnteroNoNegativo(maxFilas) || maxFilas > MAX_FILAS_ABSOLUTO)
    throw new Error('Cota maxFilas de base de pesos fuera de rango.');
  if (!esEnteroNoNegativo(filasPorSlab) || filasPorSlab < 1 || filasPorSlab > MAX_FILAS_POR_SLAB_ABSOLUTO)
    throw new Error('Cota filasPorSlab de base de pesos fuera de rango.');
  if (!esEnteroNoNegativo(maxBytesPesos) || maxBytesPesos > MAX_BYTES_PESOS_ABSOLUTO)
    throw new Error('Cota maxBytesPesos de base de pesos fuera de rango.');
}

function validarMetadatos(meta: MetadatosPublicacionBasePesos): void {
  if (!esObjetoPlano(meta)) throw new Error('Metadatos de base de pesos inválidos.');
  validarTextoId(meta.instancia, 'Instancia');
  if (!esEnteroNoNegativo(meta.epoca)) throw new Error('Época de base de pesos inválida.');
  if (!esEnteroNoNegativo(meta.secuencia)) throw new Error('Secuencia de base de pesos inválida.');
}

function filasEsperadasEnSlab(cantidad: number, filasPorSlab: number, indiceSlab: number): number {
  return Math.min(filasPorSlab, cantidad - indiceSlab * filasPorSlab);
}

function crearCabeceraDigesto(cantidad: number): Uint8Array {
  const cabecera = new Uint8Array(12);
  const vista = new DataView(cabecera.buffer);
  vista.setUint32(0, VERSION_BASE_PESOS_CORTE, true);
  vista.setUint32(4, PESOS_POR_PERSONA, true);
  vista.setUint32(8, cantidad, true);
  return cabecera;
}

function leerUidLe(uidsData: DataView, uidsF64: Float64Array, indice: number): number {
  return ES_LITTLE_ENDIAN ? uidsF64[indice]! : uidsData.getFloat64(indice * Float64Array.BYTES_PER_ELEMENT, true);
}

function validarYCopiarFilaWgp1(
  origen: Uint8Array,
  offset: number,
  destino: Uint8Array,
  offsetDestino: number,
): void {
  if (!(origen instanceof Uint8Array) || types.isProxy(origen)) throw new Error('Vista de fila WGP1 inválida.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + BYTES_PESOS_PERSONA > origen.byteLength)
    throw new Error('Rango de bytes de fila WGP1 fuera de límites.');
  const vista = new DataView(origen.buffer, origen.byteOffset + offset, BYTES_PESOS_PERSONA);
  for (let i = 0; i < PESOS_POR_PERSONA; i++) {
    if (!isPackedPersonWeight(vista.getFloat64(i * Float64Array.BYTES_PER_ELEMENT, true)))
      throw new Error('Peso F64 fuera de rango o no finito en fila WGP1.');
  }
  copiarBytesU8.call(destino, subvistaU8.call(origen, offset, offset + BYTES_PESOS_PERSONA), offsetDestino);
}

/**
 * Controlador de publicación inmutable de una base F64 en SAB.
 * Separado de la aceptación de REF: nace en PENDIENTE_ACUSE y solo publica tras acuse durable exacto.
 */
type VerificarCopiaFila = (indice: number, uid: number, bytes: Uint8Array) => void;

export class ErrorIntegridadFilaBasePesos extends Error {}

export class PublicadorBasePesos {
  readonly #descriptor: DescriptorBasePesosCorte;
  readonly #control: Int32Array<SharedArrayBuffer>;

  constructor(descriptor: DescriptorBasePesosCorte, private readonly verificarCopia: VerificarCopiaFila) {
    this.#descriptor = descriptor;
    this.#control = new Int32Array(descriptor.control);
  }

  get identidad(): IdentidadBasePesos {
    const { version, publicacion, instancia, epoca, secuencia, digesto } = this.#descriptor;
    return Object.freeze({ version, publicacion, instancia, epoca, secuencia, digesto });
  }

  get cantidad(): number {
    return this.#descriptor.cantidad;
  }

  estado(): EstadoBasePesos {
    return Atomics.load(this.#control, CONTROL_ESTADO) as EstadoBasePesos;
  }

  /** El escritor conserva las huellas privadas. Los dueños solo reciben el descriptor SAB. */
  abrirLectorDelEscritor(): LectorBasePesosCorte {
    return new LectorBasePesosCorte(this.#descriptor, this.verificarCopia);
  }

  /** Expone el descriptor antes del acuse solo para inspección/pruebas; ningún consumidor REF lo aceptará. */
  descriptorSinPublicar(): DescriptorBasePesosCorte {
    return this.#descriptor;
  }

  /** Transición única PENDIENTE_ACUSE -> PUBLICADA tras verificar el acuse durable del persistidor. */
  publicarTrasAcuse(acuse: AcuseDurableBasePesos): DescriptorBasePesosCorte {
    if (!esObjetoPlano(acuse) || acuse.confirmado !== true)
      throw new Error('El acuse durable de la base de pesos no está confirmado.');
    const d = this.#descriptor;
    if (acuse.version !== d.version || acuse.publicacion !== d.publicacion || acuse.instancia !== d.instancia
      || acuse.epoca !== d.epoca || acuse.secuencia !== d.secuencia || acuse.digesto !== d.digesto)
      throw new Error('El acuse durable no coincide con la identidad de la base de pesos.');
    const previo = Atomics.compareExchange(
      this.#control, CONTROL_ESTADO, ESTADO_BASE_PESOS.PENDIENTE_ACUSE, ESTADO_BASE_PESOS.PUBLICADA,
    );
    if (previo === ESTADO_BASE_PESOS.PUBLICADA) throw new Error('La base de pesos ya fue publicada.');
    if (previo === ESTADO_BASE_PESOS.REVOCADA) throw new Error('No se puede publicar una base de pesos revocada.');
    Atomics.notify(this.#control, CONTROL_ESTADO);
    return this.#descriptor;
  }

  /** Revoca de forma atómica y permanente cualquier descriptor ya distribuido a dueños o lectores. */
  revocar(): void {
    Atomics.store(this.#control, CONTROL_ESTADO, ESTADO_BASE_PESOS.REVOCADA);
    Atomics.notify(this.#control, CONTROL_ESTADO);
  }
}

/** Construye una base SAB desde filas WGP1 comprobadas (UID estrictamente creciente) sin copias intermedias por fila. */
export function construirBasePesosDesdeFilasWgp1(
  filas: readonly FilaWgp1Comprobada[],
  meta: MetadatosPublicacionBasePesos,
  cotasEntrada?: Partial<CotasBasePesos>,
): PublicadorBasePesos {
  if (!Array.isArray(filas)) throw new Error('La lista de filas WGP1 debe ser un array.');
  validarMetadatos(meta);
  const cotas = resolverCotas(cotasEntrada);
  const cantidad = filas.length;
  if (cantidad > cotas.maxFilas || cantidad * BYTES_PESOS_PERSONA > cotas.maxBytesPesos)
    throw new Error('La base de pesos excede las cotas configuradas.');

  const numSlabs = cantidad === 0 ? 0 : Math.ceil(cantidad / cotas.filasPorSlab);
  const control = new SharedArrayBuffer(CONTROL_BYTES);
  const uids = new SharedArrayBuffer(cantidad * Float64Array.BYTES_PER_ELEMENT);
  const slabs: SharedArrayBuffer[] = new Array(numSlabs);
  const vistasSlabs: Uint8Array<SharedArrayBuffer>[] = new Array(numSlabs);
  for (let s = 0; s < numSlabs; s++) {
    const sab = new SharedArrayBuffer(filasEsperadasEnSlab(cantidad, cotas.filasPorSlab, s) * BYTES_PESOS_PERSONA);
    slabs[s] = sab;
    vistasSlabs[s] = new Uint8Array(sab);
  }

  const uidsF64 = new Float64Array(uids);
  const uidsData = new DataView(uids);
  const uidsPrivados = new Float64Array(cantidad);
  const huellas = Buffer.allocUnsafe(cantidad * BYTES_HUELLA_FILA);
  let anterior = 0;
  for (let i = 0; i < cantidad; i++) {
    const fila = filas[i];
    if (!fila || !esUidValido(fila.uid)) throw new Error('UID de fila WGP1 inválido.');
    if (fila.uid <= anterior) throw new Error('Los UID de la base WGP1 deben ser estrictamente crecientes y sin duplicados.');
    if (ES_LITTLE_ENDIAN) uidsF64[i] = fila.uid;
    else uidsData.setFloat64(i * Float64Array.BYTES_PER_ELEMENT, fila.uid, true);
    const slabIdx = Math.floor(i / cotas.filasPorSlab);
    const filaEnSlab = i - slabIdx * cotas.filasPorSlab;
    validarYCopiarFilaWgp1(fila.body, fila.offset, vistasSlabs[slabIdx]!, filaEnSlab * BYTES_PESOS_PERSONA);
    uidsPrivados[i] = fila.uid;
    huellas.set(cryptoHash('sha256', subvistaU8.call(fila.body, fila.offset, fila.offset + BYTES_PESOS_PERSONA), 'buffer'),
      i * BYTES_HUELLA_FILA);
    anterior = fila.uid;
  }

  const hash = createHash('sha256');
  hash.update(DOMINIO_DIGESTO);
  hash.update(crearCabeceraDigesto(cantidad));
  hash.update(new Uint8Array(uids));
  for (const vista of vistasSlabs) hash.update(vista);
  const digesto = hash.digest('hex');

  const controlI32 = new Int32Array(control);
  Atomics.store(controlI32, CONTROL_ESTADO, ESTADO_BASE_PESOS.PENDIENTE_ACUSE);
  Atomics.store(controlI32, CONTROL_SELLADO, 1);

  const descriptor: DescriptorBasePesosCorte = Object.freeze({
    version: VERSION_BASE_PESOS_CORTE,
    publicacion: randomUUID(),
    instancia: meta.instancia,
    epoca: meta.epoca,
    secuencia: meta.secuencia,
    digesto,
    cotas,
    cantidad,
    uidMin: cantidad === 0 ? 0 : filas[0]!.uid,
    uidMax: cantidad === 0 ? 0 : anterior,
    control,
    uids,
    slabs: Object.freeze(slabs),
  });
  return new PublicadorBasePesos(descriptor, (indice, uid, bytes) => {
    const offset = indice * BYTES_HUELLA_FILA;
    if (uidsPrivados[indice] !== uid
      || !cryptoHash('sha256', bytes, 'buffer').equals(huellas.subarray(offset, offset + BYTES_HUELLA_FILA)))
      throw new ErrorIntegridadFilaBasePesos('La fila F64 copiada no coincide con los bytes o el UID durables.');
  });
}

/** Construye la base SAB directamente desde páginas WGP1 en orden de cubeta creciente. */
export function construirBasePesosDesdePaginasWgp1(
  paginas: readonly PaginaWgp1Entrada[],
  meta: MetadatosPublicacionBasePesos,
  cotasEntrada?: Partial<CotasBasePesos>,
): PublicadorBasePesos {
  if (!Array.isArray(paginas)) throw new Error('La lista de páginas WGP1 debe ser un array.');
  validarMetadatos(meta);
  const cotas = resolverCotas(cotasEntrada);
  let total = 0;
  let bucketAnterior = -1;
  const filas: FilaWgp1Comprobada[] = [];
  for (const pagina of paginas) {
    if (!pagina || !(pagina.body instanceof Uint8Array) || types.isProxy(pagina.body))
      throw new Error('Página WGP1 inválida.');
    const { bucket, entries } = decodePolicyWeightPage(pagina.body, pagina.count);
    if (bucket <= bucketAnterior) throw new Error('Las cubetas de páginas WGP1 deben ser estrictamente crecientes.');
    bucketAnterior = bucket;
    total += entries.length;
    if (total > cotas.maxFilas || total * BYTES_PESOS_PERSONA > cotas.maxBytesPesos)
      throw new Error('Las páginas WGP1 exceden las cotas de la base de pesos.');
    for (const { uid, offset } of entries) filas.push({ uid, body: pagina.body, offset });
  }
  return construirBasePesosDesdeFilasWgp1(filas, meta, cotas);
}

/**
 * Lector sin tabla global duplicada ni vistas mutables expuestas: busca por UID con búsqueda binaria sobre el SAB
 * y ofrece solo comparación directa en sitio, copia a un buffer destino del consumidor y materialización bajo demanda.
 */
export class LectorBasePesosCorte {
  readonly identidad: IdentidadBasePesos;
  readonly cotas: CotasBasePesos;
  readonly cantidad: number;
  readonly uidMin: number;
  readonly uidMax: number;

  readonly #control: Int32Array<SharedArrayBuffer>;
  readonly #uidsF64: Float64Array<SharedArrayBuffer>;
  readonly #uidsData: DataView<SharedArrayBuffer>;
  readonly #slabsU8: readonly Uint8Array<SharedArrayBuffer>[];
  readonly #slabsF64: readonly Float64Array<SharedArrayBuffer>[];
  readonly #slabsU64: readonly BigUint64Array<SharedArrayBuffer>[];
  readonly #slabsData: readonly DataView<SharedArrayBuffer>[];

  constructor(descriptor: DescriptorBasePesosCorte, private readonly verificarCopia?: VerificarCopiaFila) {
    validarEstructuraDescriptor(descriptor);
    this.identidad = Object.freeze({
      version: descriptor.version,
      publicacion: descriptor.publicacion,
      instancia: descriptor.instancia,
      epoca: descriptor.epoca,
      secuencia: descriptor.secuencia,
      digesto: descriptor.digesto,
    });
    this.cotas = Object.freeze({ ...descriptor.cotas });
    this.cantidad = descriptor.cantidad;
    this.uidMin = descriptor.uidMin;
    this.uidMax = descriptor.uidMax;
    this.#control = new Int32Array(descriptor.control);
    this.#uidsF64 = new Float64Array(descriptor.uids);
    this.#uidsData = new DataView(descriptor.uids);
    this.#slabsU8 = descriptor.slabs.map(sab => new Uint8Array(sab));
    this.#slabsF64 = ES_LITTLE_ENDIAN ? descriptor.slabs.map(sab => new Float64Array(sab)) : [];
    this.#slabsU64 = ES_LITTLE_ENDIAN ? descriptor.slabs.map(sab => new BigUint64Array(sab)) : [];
    this.#slabsData = descriptor.slabs.map(sab => new DataView(sab));
  }

  estado(): EstadoBasePesos {
    return Atomics.load(this.#control, CONTROL_ESTADO) as EstadoBasePesos;
  }

  estaPublicada(): boolean {
    return this.estado() === ESTADO_BASE_PESOS.PUBLICADA;
  }

  uidEn(indice: number): number {
    if (!Number.isSafeInteger(indice) || indice < 0 || indice >= this.cantidad) return -1;
    return leerUidLe(this.#uidsData, this.#uidsF64, indice);
  }

  /** Búsqueda binaria O(log N) directa sobre el SAB de UIDs (cero Map por dueño). */
  buscarIndicePorUid(uid: number): number {
    if (!esUidValido(uid) || this.cantidad === 0 || uid < this.uidMin || uid > this.uidMax) return -1;
    let lo = 0, hi = this.cantidad - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const actual = leerUidLe(this.#uidsData, this.#uidsF64, mid);
      if (actual === uid) return mid;
      if (actual < uid) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Copia los 1696 bytes F64LE directo al destino del consumidor sin copia intermedia ni exponer el SAB. */
  copiarPesosEn(indice: number, destino: Uint8Array, offset: number, uidEsperado = this.uidEn(indice)): void {
    this.#assertPublicada();
    const { slabIdx, filaEnSlab } = this.#pos(indice);
    if (!types.isUint8Array(destino) || types.isProxy(destino) || !Number.isSafeInteger(offset) || offset < 0
      || offset + BYTES_PESOS_PERSONA > destino.byteLength)
      throw new Error('Rango de destino inválido al copiar pesos de la base.');
    const inicio = filaEnSlab * BYTES_PESOS_PERSONA;
    copiarBytesU8.call(destino, subvistaU8.call(this.#slabsU8[slabIdx]!, inicio, inicio + BYTES_PESOS_PERSONA), offset);
    if (!this.estaPublicada()) {
      rellenarBytesU8.call(destino, 0, offset, offset + BYTES_PESOS_PERSONA);
      throw new Error('La base de pesos fue revocada durante la copia.');
    }
    this.verificarCopiaEn(indice, uidEsperado, destino, offset);
  }

  verificarCopiaEn(indice: number, uidEsperado: number, destino: Uint8Array, offset: number): void {
    this.verificarCopia?.(indice, uidEsperado, subvistaU8.call(destino, offset, offset + BYTES_PESOS_PERSONA));
  }

  copiarPesosPorUid(uid: number, destino: Uint8Array, offset: number): boolean {
    if (!this.estaPublicada()) return false;
    const indice = this.buscarIndicePorUid(uid);
    if (indice < 0) return false;
    this.copiarPesosEn(indice, destino, offset, uid);
    return true;
  }

  /** Materializa un array JS mutable de 212 Float64 preservando -0 únicamente cuando el consumidor lo exige. */
  materializarPesosEn(indice: number, uidEsperado = this.uidEn(indice)): number[] {
    this.#assertPublicada();
    if (this.verificarCopia) {
      const bytes = new Uint8Array(BYTES_PESOS_PERSONA);
      this.copiarPesosEn(indice, bytes, 0, uidEsperado);
      const vista = new DataView(bytes.buffer);
      return Array.from({ length: PESOS_POR_PERSONA }, (_, i) => vista.getFloat64(i * 8, true));
    }
    const { slabIdx, filaEnSlab } = this.#pos(indice);
    const salida = new Array<number>(PESOS_POR_PERSONA);
    if (ES_LITTLE_ENDIAN) {
      const f64 = this.#slabsF64[slabIdx]!;
      const base = filaEnSlab * PESOS_POR_PERSONA;
      for (let i = 0; i < PESOS_POR_PERSONA; i++) salida[i] = f64[base + i]!;
    } else {
      const vista = this.#slabsData[slabIdx]!;
      const base = filaEnSlab * BYTES_PESOS_PERSONA;
      for (let i = 0; i < PESOS_POR_PERSONA; i++) salida[i] = vista.getFloat64(base + i * 8, true);
    }
    this.#assertPublicada();
    return salida;
  }

  /** Comparación exacta bit a bit de los 212 Float64 contra la fila en SAB (distingue +0 de -0, sin copias por fila). */
  compararEn(indice: number, pesos: PesosF64Entrada): 'igual' | 'modificado' | 'invalido' {
    const { slabIdx, filaEnSlab } = this.#pos(indice);
    if (types.isProxy(pesos)) return 'invalido';

    if (pesos instanceof Uint8Array || pesos instanceof Float64Array) {
      const esF64 = pesos instanceof Float64Array;
      if (esF64 ? pesos.length !== PESOS_POR_PERSONA : pesos.byteLength !== BYTES_PESOS_PERSONA) return 'invalido';
      if (ES_LITTLE_ENDIAN && (esF64 || (pesos.byteOffset & 7) === 0)) {
        const u64 = new BigUint64Array(pesos.buffer, pesos.byteOffset, PESOS_POR_PERSONA);
        const baseU64 = this.#slabsU64[slabIdx]!;
        const base = filaEnSlab * PESOS_POR_PERSONA;
        let modificado = false;
        for (let i = 0; i < PESOS_POR_PERSONA; i++) {
          if (u64[i] !== baseU64[base + i]) { modificado = true; break; }
        }
        if (!modificado) return 'igual';
        const f64 = esF64 ? pesos : new Float64Array(pesos.buffer, pesos.byteOffset, PESOS_POR_PERSONA);
        for (let i = 0; i < PESOS_POR_PERSONA; i++) if (!isPackedPersonWeight(f64[i])) return 'invalido';
        return 'modificado';
      }
      const vista = new DataView(pesos.buffer, pesos.byteOffset, BYTES_PESOS_PERSONA);
      const baseData = this.#slabsData[slabIdx]!;
      const baseOffset = filaEnSlab * BYTES_PESOS_PERSONA;
      let modificado = false;
      for (let i = 0; i < PESOS_POR_PERSONA; i++) {
        const off = i * Float64Array.BYTES_PER_ELEMENT;
        const v = esF64 ? pesos[i] : vista.getFloat64(off, true);
        if (!isPackedPersonWeight(v)) return 'invalido';
        const igual = esF64
          ? Object.is(v, baseData.getFloat64(baseOffset + off, true))
          : vista.getBigUint64(off, true) === baseData.getBigUint64(baseOffset + off, true);
        if (!igual) modificado = true;
      }
      return modificado ? 'modificado' : 'igual';
    }

    if (!Array.isArray(pesos) || Object.getPrototypeOf(pesos) !== Array.prototype || pesos.length !== PESOS_POR_PERSONA)
      return 'invalido';
    const baseF64 = ES_LITTLE_ENDIAN ? this.#slabsF64[slabIdx]! : undefined;
    const baseData = this.#slabsData[slabIdx]!;
    const base = filaEnSlab * (baseF64 ? PESOS_POR_PERSONA : BYTES_PESOS_PERSONA);
    let modificado = false;
    for (let i = 0; i < PESOS_POR_PERSONA; i++) {
      if (!Object.hasOwn(pesos, i) || lookupGetter.call(pesos, i) !== undefined) return 'invalido';
      const v: unknown = pesos[i];
      if (!isPackedPersonWeight(v)) return 'invalido';
      const esperado = baseF64 ? baseF64[base + i]! : baseData.getFloat64(base + i * 8, true);
      if (!Object.is(v, esperado)) modificado = true;
    }
    return modificado ? 'modificado' : 'igual';
  }

  #assertPublicada(): void {
    if (!this.estaPublicada()) throw new Error('La base de pesos no está publicada o fue revocada.');
  }

  #pos(indice: number): { slabIdx: number; filaEnSlab: number } {
    if (!Number.isSafeInteger(indice) || indice < 0 || indice >= this.cantidad)
      throw new RangeError(`Índice de base de pesos fuera de rango: ${indice}.`);
    const slabIdx = Math.floor(indice / this.cotas.filasPorSlab);
    return { slabIdx, filaEnSlab: indice - slabIdx * this.cotas.filasPorSlab };
  }
}

function validarEstructuraDescriptor(descriptor: unknown): asserts descriptor is DescriptorBasePesosCorte {
  if (!esObjetoPlano(descriptor)) throw new Error('Descriptor de base de pesos inválido.');
  if (descriptor.version !== VERSION_BASE_PESOS_CORTE)
    throw new Error(`Versión de base de pesos no soportada: ${String(descriptor.version)}.`);
  validarTextoId(descriptor.publicacion, 'Publicación');
  validarTextoId(descriptor.instancia, 'Instancia');
  if (!esEnteroNoNegativo(descriptor.epoca)) throw new Error('Época de descriptor inválida.');
  if (!esEnteroNoNegativo(descriptor.secuencia)) throw new Error('Secuencia de descriptor inválida.');
  validarDigesto(descriptor.digesto);
  validarCotas(descriptor.cotas);
  const { cotas, cantidad, uidMin, uidMax, control, uids, slabs } = descriptor;
  if (!esEnteroNoNegativo(cantidad) || cantidad > cotas.maxFilas || cantidad * BYTES_PESOS_PERSONA > cotas.maxBytesPesos)
    throw new Error('Cantidad de filas fuera de las cotas del descriptor.');
  if (!(control instanceof SharedArrayBuffer) || control.byteLength !== CONTROL_BYTES)
    throw new Error('Buffer de control de base de pesos inválido.');
  if (Atomics.load(new Int32Array(control), CONTROL_SELLADO) !== 1)
    throw new Error('Descriptor de base de pesos no sellado.');
  if (!(uids instanceof SharedArrayBuffer) || uids.byteLength !== cantidad * Float64Array.BYTES_PER_ELEMENT)
    throw new Error('Buffer de UIDs de base de pesos inválido.');
  if (!Array.isArray(slabs)) throw new Error('Lista de slabs de base de pesos inválida.');
  const slabsEsperados = cantidad === 0 ? 0 : Math.ceil(cantidad / cotas.filasPorSlab);
  if (slabs.length !== slabsEsperados) throw new Error('Cantidad de slabs incoherente con cantidad y filasPorSlab.');
  const vistos = new Set<SharedArrayBuffer>([control, uids]);
  for (let s = 0; s < slabsEsperados; s++) {
    const slab = slabs[s];
    const bytesEsperados = filasEsperadasEnSlab(cantidad, cotas.filasPorSlab, s) * BYTES_PESOS_PERSONA;
    if (!(slab instanceof SharedArrayBuffer) || slab.byteLength !== bytesEsperados || vistos.has(slab))
      throw new Error(`Slab ${s} de base de pesos inválido o repetido.`);
    vistos.add(slab);
  }
  if (cantidad === 0) {
    if (uidMin !== 0 || uidMax !== 0) throw new Error('Extremos de UID inválidos para base vacía.');
  } else {
    const uidsData = new DataView(uids), uidsF64 = new Float64Array(uids);
    const primero = leerUidLe(uidsData, uidsF64, 0);
    const ultimo = leerUidLe(uidsData, uidsF64, cantidad - 1);
    if (!esUidValido(uidMin) || !esUidValido(uidMax) || uidMin !== primero || uidMax !== ultimo || uidMin > uidMax)
      throw new Error('Extremos de UID incoherentes con el buffer de UIDs.');
  }
}

/**
 * Lector sellado de reconstrucción FULL tras revocación natural de una base previamente autorizada.
 * Nunca se expone como `LectorBasePesosCorte` ni admite REFs sin autorización previa: exige verificación
 * criptográfica SHA-256 completa del SAB (`verificarIntegridadBasePesos`) antes y después de copiar
 * los 1696 bytes F64LE a buffers privados del llamador, validando identidad, UID e índice exactos.
 */
export interface LectorReconstruccionBasePesos {
  readonly identidad: IdentidadBasePesos;
  readonly cantidad: number;
  uidEn(indice: number): number;
  copiarPesosExactosEn(uidEsperado: unknown, indice: number, destino: Uint8Array, offset: number): void;
  verificarIntegridadFinal(): void;
}

/** Valida estrictamente una identidad de base F64 plana (sin getters, claves extra ni buffers embebidos). */
export function identidadBasePesosValida(valor: unknown): valor is IdentidadBasePesos {
  if (!esObjetoPlano(valor)) return false;
  const claves = Reflect.ownKeys(valor);
  if (claves.length !== CLAVES_IDENTIDAD.size) return false;
  for (const clave of claves) {
    if (typeof clave !== 'string' || !CLAVES_IDENTIDAD.has(clave) || lookupGetter.call(valor, clave) !== undefined)
      return false;
  }
  return valor.version === VERSION_BASE_PESOS_CORTE
    && typeof valor.publicacion === 'string' && valor.publicacion.length > 0 && valor.publicacion.length <= MAX_TEXTO_ID_LEN
    && typeof valor.instancia === 'string' && valor.instancia.length > 0 && valor.instancia.length <= MAX_TEXTO_ID_LEN
    && esEnteroNoNegativo(valor.epoca)
    && esEnteroNoNegativo(valor.secuencia)
    && typeof valor.digesto === 'string' && DIGESTO_HEX.test(valor.digesto);
}

export function mismaIdentidadBasePesos(a: IdentidadBasePesos, b: IdentidadBasePesos): boolean {
  return a.version === b.version
    && a.publicacion === b.publicacion
    && a.instancia === b.instancia
    && a.epoca === b.epoca
    && a.secuencia === b.secuencia
    && a.digesto === b.digesto;
}

/** Abre un lector sellado de reconstrucción FULL verificando la integridad SHA-256 completa del SAB. */
export function abrirLectorReconstruccionBasePesos(
  descriptor: DescriptorBasePesosCorte,
  identidadEsperada: IdentidadBasePesos,
  lectorDelEscritor?: LectorBasePesosCorte,
): LectorReconstruccionBasePesos {
  if (!identidadBasePesosValida(identidadEsperada)) {
    throw new Error('Identidad esperada de reconstrucción de base F64 inválida.');
  }
  verificarIntegridadBasePesos(descriptor);
  if (!mismaIdentidadBasePesos(descriptor, identidadEsperada)) {
    throw new Error('La identidad del descriptor retenido no coincide con la base autorizada.');
  }
  const { cantidad, cotas, uids, slabs } = descriptor;
  const uidsF64 = new Float64Array(uids);
  const uidsData = new DataView(uids);
  const slabsU8 = slabs.map(sab => new Uint8Array(sab));
  const identidad: IdentidadBasePesos = Object.freeze({
    version: descriptor.version,
    publicacion: descriptor.publicacion,
    instancia: descriptor.instancia,
    epoca: descriptor.epoca,
    secuencia: descriptor.secuencia,
    digesto: descriptor.digesto,
  });
  return {
    identidad,
    cantidad,
    uidEn(indice: number): number {
      if (!Number.isSafeInteger(indice) || indice < 0 || indice >= cantidad) return -1;
      return leerUidLe(uidsData, uidsF64, indice);
    },
    copiarPesosExactosEn(uidEsperado: unknown, indice: number, destino: Uint8Array, offset: number): void {
      if (!esUidValido(uidEsperado)) throw new Error('UID inválido al reconstruir pesos FULL.');
      if (!esEnteroNoNegativo(indice) || indice >= cantidad)
        throw new Error(`Índice de base F64 fuera de rango al reconstruir FULL: ${indice}.`);
      if (leerUidLe(uidsData, uidsF64, indice) !== uidEsperado)
        throw new Error(`El UID de la fila no coincide con el índice ${indice} al reconstruir FULL.`);
      if (!types.isUint8Array(destino) || types.isProxy(destino) || !Number.isSafeInteger(offset) || offset < 0
        || offset + BYTES_PESOS_PERSONA > destino.byteLength)
        throw new Error('Rango de destino inválido al reconstruir pesos FULL.');
      const slabIdx = Math.floor(indice / cotas.filasPorSlab);
      const filaEnSlab = indice - slabIdx * cotas.filasPorSlab;
      const inicio = filaEnSlab * BYTES_PESOS_PERSONA;
      copiarBytesU8.call(destino, subvistaU8.call(slabsU8[slabIdx]!, inicio, inicio + BYTES_PESOS_PERSONA), offset);
      lectorDelEscritor?.verificarCopiaEn(indice, uidEsperado, destino, offset);
    },
    verificarIntegridadFinal(): void {
      verificarIntegridadBasePesos(descriptor);
    },
  };
}

/** Abre un lector ligero sobre un descriptor clonado recibido por canal interno de trabajadores de confianza. */
export function abrirLectorBasePesos(descriptor: DescriptorBasePesosCorte): LectorBasePesosCorte {
  return new LectorBasePesosCorte(descriptor);
}

/** Verificación exhaustiva del contenido del SAB: orden estricto de UIDs, 212 F64 válidos por fila y SHA-256 exacto. */
export function verificarIntegridadBasePesos(descriptor: DescriptorBasePesosCorte): void {
  validarEstructuraDescriptor(descriptor);
  const { cantidad, cotas, uids, slabs, digesto } = descriptor;
  const uidsData = new DataView(uids), uidsF64 = new Float64Array(uids);
  let anterior = 0;
  for (let i = 0; i < cantidad; i++) {
    const uid = leerUidLe(uidsData, uidsF64, i);
    if (!esUidValido(uid) || uid <= anterior) throw new Error('Orden o unicidad de UIDs corrupta en la base de pesos.');
    anterior = uid;
  }
  const hash = createHash('sha256');
  hash.update(DOMINIO_DIGESTO);
  hash.update(crearCabeceraDigesto(cantidad));
  hash.update(new Uint8Array(uids));
  for (let s = 0; s < slabs.length; s++) {
    const slab = slabs[s]!;
    const filas = filasEsperadasEnSlab(cantidad, cotas.filasPorSlab, s);
    const vista = new DataView(slab);
    for (let f = 0; f < filas; f++) {
      const base = f * BYTES_PESOS_PERSONA;
      for (let w = 0; w < PESOS_POR_PERSONA; w++) {
        if (!isPackedPersonWeight(vista.getFloat64(base + w * 8, true)))
          throw new Error('Peso F64 corrupto en la base de pesos.');
      }
    }
    hash.update(new Uint8Array(slab));
  }
  if (hash.digest('hex') !== digesto) throw new Error('El digesto SHA-256 de la base de pesos no coincide.');
}

function leerF64Entrada(entrada: PesosF64Entrada, indice: number, vista?: DataView): number | undefined {
  if (entrada instanceof Uint8Array) return vista!.getFloat64(indice * 8, true);
  if (entrada instanceof Float64Array) return entrada[indice];
  if (!Object.hasOwn(entrada, indice) || lookupGetter.call(entrada, indice) !== undefined) return undefined;
  const valor: unknown = entrada[indice];
  return typeof valor === 'number' ? valor : undefined;
}

function formaEntradaValida(entrada: PesosF64Entrada): DataView | null | undefined {
  if (types.isProxy(entrada)) return undefined;
  if (entrada instanceof Uint8Array)
    return entrada.byteLength === BYTES_PESOS_PERSONA ? new DataView(entrada.buffer, entrada.byteOffset, BYTES_PESOS_PERSONA) : undefined;
  if (entrada instanceof Float64Array) return entrada.length === PESOS_POR_PERSONA ? null : undefined;
  return Array.isArray(entrada) && Object.getPrototypeOf(entrada) === Array.prototype && entrada.length === PESOS_POR_PERSONA
    ? null : undefined;
}

/** Comparación exacta bit a bit de 212 Float64 finitos (distingue +0 de -0 y rechaza NaN/±Inf). */
export function compararPesosF64BitABit(a: PesosF64Entrada, b: PesosF64Entrada): boolean {
  const vistaA = formaEntradaValida(a), vistaB = formaEntradaValida(b);
  if (vistaA === undefined || vistaB === undefined) return false;
  for (let i = 0; i < PESOS_POR_PERSONA; i++) {
    const va = leerF64Entrada(a, i, vistaA ?? undefined);
    const vb = leerF64Entrada(b, i, vistaB ?? undefined);
    if (va === undefined || vb === undefined || !Number.isFinite(va) || !Number.isFinite(vb) || !Object.is(va, vb))
      return false;
  }
  return true;
}

function comprobarContextoContraLector(
  lector: LectorBasePesosCorte | undefined,
  contexto: ContextoBasePesos | undefined,
): MotivoBasePesosComun | null {
  if (!lector) return 'sin_base';
  if (!contexto || typeof contexto.publicacion !== 'string' || !contexto.publicacion.length
    || typeof contexto.instancia !== 'string' || !contexto.instancia.length
    || !esEnteroNoNegativo(contexto.epoca) || !esEnteroNoNegativo(contexto.secuencia))
    return 'identidad_ausente';
  const estado = lector.estado();
  if (estado === ESTADO_BASE_PESOS.PENDIENTE_ACUSE) return 'base_no_publicada';
  if (estado !== ESTADO_BASE_PESOS.PUBLICADA) return 'base_revocada';
  if (lector.identidad.publicacion !== contexto.publicacion) return 'publicacion_distinta';
  if (lector.identidad.epoca !== contexto.epoca) return 'epoca_cambiada';
  if (lector.identidad.instancia !== contexto.instancia) return 'instancia_distinta';
  if (lector.identidad.secuencia !== contexto.secuencia) return 'secuencia_distinta';
  if (contexto.digesto !== undefined && lector.identidad.digesto !== contexto.digesto) return 'digesto_distinto';
  return null;
}

function esReferenciaPlanaEstricta(valor: unknown): valor is Record<string, unknown> {
  if (!esObjetoPlano(valor)) return false;
  const claves = Reflect.ownKeys(valor);
  if (claves.length !== CLAVES_REFERENCIA.size) return false;
  for (const clave of claves) {
    if (typeof clave !== 'string' || !CLAVES_REFERENCIA.has(clave) || lookupGetter.call(valor, clave) !== undefined)
      return false;
  }
  return true;
}

/**
 * Contrato de emisión (dueño): decide REF o FULL comparando los 212 Float64 exactos contra el SAB publicado.
 * Ninguna huella probabilística sustituye la comparación bit a bit.
 */
export function evaluarCandidatoRefPesos(
  lector: LectorBasePesosCorte | undefined,
  contexto: ContextoBasePesos | undefined,
  uid: unknown,
  pesos: PesosF64Entrada,
): DecisionRefPesos {
  const fallo = comprobarContextoContraLector(lector, contexto);
  if (fallo) return { modo: 'FULL', motivo: fallo };
  if (!esUidValido(uid)) return { modo: 'FULL', motivo: 'uid_invalido' };
  const indice = lector!.buscarIndicePorUid(uid);
  if (indice < 0) return { modo: 'FULL', motivo: 'uid_ausente' };
  const comparacion = lector!.compararEn(indice, pesos);
  if (comparacion === 'invalido') return { modo: 'FULL', motivo: 'pesos_invalidos' };
  if (comparacion === 'modificado') return { modo: 'FULL', motivo: 'pesos_modificados' };
  if (!lector!.estaPublicada()) return { modo: 'FULL', motivo: 'base_revocada' };
  return {
    modo: 'REF',
    referencia: Object.freeze({ ...lector!.identidad, uid, indice }),
  };
}

/**
 * Contrato de aceptación (persistidor/receptor): valida una REF sin aceptar buffers embebidos ni exponer vistas SAB.
 * El consumidor lee los bytes validados mediante `lector.copiarPesosEn(res.indice, destino, offset)` o `materializarPesosEn`.
 */
export function aceptarRefPesos(
  lector: LectorBasePesosCorte | undefined,
  contexto: ContextoBasePesos | undefined,
  uidEsperado: unknown,
  referencia: unknown,
): ResultadoAceptacionRefPesos {
  const falloBase = comprobarContextoContraLector(lector, contexto);
  if (falloBase) return { aceptada: false, motivo: falloBase };
  if (!esUidValido(uidEsperado)) return { aceptada: false, motivo: 'uid_invalido' };
  if (!esReferenciaPlanaEstricta(referencia)) return { aceptada: false, motivo: 'referencia_invalida' };
  if (referencia.version !== VERSION_BASE_PESOS_CORTE) return { aceptada: false, motivo: 'version_distinta' };
  if (referencia.publicacion !== lector!.identidad.publicacion) return { aceptada: false, motivo: 'publicacion_distinta' };
  if (referencia.epoca !== contexto!.epoca) return { aceptada: false, motivo: 'epoca_cambiada' };
  if (referencia.instancia !== contexto!.instancia) return { aceptada: false, motivo: 'instancia_distinta' };
  if (referencia.secuencia !== contexto!.secuencia) return { aceptada: false, motivo: 'secuencia_distinta' };
  if (referencia.digesto !== lector!.identidad.digesto) return { aceptada: false, motivo: 'digesto_distinto' };
  if (referencia.uid !== uidEsperado) return { aceptada: false, motivo: 'uid_no_coincide' };
  const indice = referencia.indice;
  if (!esEnteroNoNegativo(indice) || indice >= lector!.cantidad || lector!.uidEn(indice) !== uidEsperado)
    return { aceptada: false, motivo: 'indice_invalido' };
  if (!lector!.estaPublicada()) return { aceptada: false, motivo: 'base_revocada' };
  return { aceptada: true, uid: uidEsperado, indice };
}
