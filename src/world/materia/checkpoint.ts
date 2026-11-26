import { Buffer } from 'node:buffer';
import { crc32 } from 'node:zlib';
import { NE } from '../../shared/naturaleza.js';
import { REF_NULA, TipoIntento, slotDe, type Hilo, type Intento } from '../motor/contratos.js';
import { balancePares, comprobarConservacion } from './libro.js';
import { Rol, type BytesMateria, type LoteRef, type MateriaCheckpoint, type Sustancia, type TramosMateria } from './tipos.js';

export interface LoteGuardado {
  ref: LoteRef;
  celda: number;
  rol: Rol;
  forma: number;
  dueno: Hilo;
  pares: Float64Array;
}

const FIRMA = 0x54414d56; // VMAT, little endian
const VERSION = 1;
const CELDAS_POR_PAGINA = 256;
const U32_MAX = 0xffff_ffff;
const BYTES_ENTERO = 8;
const BYTES_CRC = 4;
const BYTES_LOTE = 4 * BYTES_ENTERO + 1 + 4; // ref, celda, dueño, número de pares, rol y forma
const BYTES_PAR = 12;
const TIPOS_CON_GARANTIA = new Set<TipoIntento>([TipoIntento.Depositar, TipoIntento.Dar, TipoIntento.Concedido, TipoIntento.Devuelto]);

function entero(valor: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(valor) || valor < min || valor > max) throw new Error(`Entero inválido en el punto de control: ${valor}`);
  return valor;
}

class Escritor {
  private bytes: Uint8Array<ArrayBuffer>;
  private vista: DataView<ArrayBuffer>;
  private pos = 0;

  constructor(capacidad = 256) {
    this.bytes = new Uint8Array(capacidad);
    this.vista = new DataView(this.bytes.buffer);
  }

  private reservar(n: number): number {
    const inicio = this.pos;
    const fin = inicio + n;
    if (fin > this.bytes.length) {
      const crecido = new Uint8Array(Math.max(fin, this.bytes.length * 2));
      crecido.set(this.bytes);
      this.bytes = crecido;
      this.vista = new DataView(crecido.buffer);
    }
    this.pos = fin;
    return inicio;
  }

  u8(valor: number): void { const inicio = this.reservar(1); this.vista.setUint8(inicio, entero(valor, 0, 255)); }
  u32(valor: number): void { const inicio = this.reservar(4); this.vista.setUint32(inicio, entero(valor, 0, U32_MAX), true); }
  f64(valor: number): void { const inicio = this.reservar(8); this.vista.setFloat64(inicio, valor, true); }
  entero(valor: number, min = 0): void { this.f64(entero(valor, min)); }
  get posicion(): number { return this.pos; }
  irA(posicion: number): void { this.pos = posicion; }

  bloque(bytes: Uint8Array | null): void {
    this.entero(bytes?.length ?? -1, -1);
    if (bytes) this.crudo(bytes);
  }

  crudo(bytes: Uint8Array): void { const inicio = this.reservar(bytes.length); this.bytes.set(bytes, inicio); }

  cuenta(valor: bigint): void {
    if (typeof valor !== 'bigint') throw new Error('Total no entero en el punto de control.');
    if (valor === 0n) { this.entero(0); return; }
    const magnitud = valor < 0n ? -valor : valor;
    const hex = magnitud.toString(16);
    const bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex').reverse();
    this.f64(valor < 0n ? -bytes.length : bytes.length);
    this.crudo(bytes);
  }

  pares(pares: Float64Array | null): void {
    this.entero(pares ? pares.length / 2 : -1, -1);
    if (!pares) return;
    for (let i = 0; i < pares.length; i += 2) { this.u32(pares[i]!); this.entero(pares[i + 1]!); }
  }

  terminar(): Uint8Array { return this.bytes.subarray(0, this.pos); }
}

const SIN_BYTES = new Uint8Array();
const tramosDe = (bytes: BytesMateria): readonly Uint8Array[] => bytes instanceof Uint8Array ? [bytes] : bytes.tramos;

function agrupar(tramos: Uint8Array[], longitud: number): BytesMateria {
  if (tramos.length <= 1) return tramos[0] ?? SIN_BYTES;
  return { tramos, byteLength: longitud, length: longitud };
}

function contiguo(bytes: BytesMateria): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  const salida = new Uint8Array(bytes.length);
  let pos = 0;
  for (const tramo of bytes.tramos) {
    salida.set(tramo, pos);
    pos += tramo.length;
  }
  return salida;
}

class Lector {
  private vista: DataView;
  private readonly segmentos?: { inicios: number[]; vistas: DataView[]; cruce: Uint8Array; vistaCruce: DataView };
  private tramo = 0;
  private pos = 0;
  private fin: number;

  constructor(private readonly bytes: BytesMateria) {
    if (!bytes) throw new Error('Falta un bloque del punto de control de materia.');
    this.fin = bytes.length;
    if (bytes instanceof Uint8Array) {
      this.vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return;
    }
    if (!Array.isArray(bytes.tramos) || !bytes.tramos.length)
      throw new Error('Falta un bloque del punto de control de materia.');
    const inicios = [0], vistas: DataView[] = [];
    let longitud = 0;
    for (const tramo of bytes.tramos) {
      if (!(tramo instanceof Uint8Array) || tramo.length === 0) throw new Error('Tramo de materia inválido.');
      longitud = entero(longitud + tramo.length);
      inicios.push(longitud);
      vistas.push(new DataView(tramo.buffer, tramo.byteOffset, tramo.byteLength));
    }
    if (longitud !== bytes.length || longitud !== bytes.byteLength) throw new Error('Longitud de tramos de materia incorrecta.');
    const cruce = new Uint8Array(BYTES_ENTERO);
    this.segmentos = { inicios, vistas, cruce, vistaCruce: new DataView(cruce.buffer) };
    this.vista = vistas[0]!;
  }

  private reservar(n: number): number {
    if (n > this.fin - this.pos) throw new Error('Punto de control truncado.');
    const inicio = this.pos;
    this.pos += n;
    return inicio;
  }

  private localizar(pos: number, inicios: readonly number[]): number {
    let tramo = this.tramo;
    if (inicios[tramo]! <= pos && pos < inicios[tramo + 1]!) return tramo;
    if (inicios[tramo + 1]! <= pos && pos < inicios[tramo + 2]!) return this.tramo = tramo + 1;
    let fin = inicios.length - 1;
    tramo = 0;
    while (fin - tramo > 1) {
      const medio = tramo + Math.floor((fin - tramo) / 2);
      if (inicios[medio]! <= pos) tramo = medio;
      else fin = medio;
    }
    return this.tramo = tramo;
  }

  /** El camino contiguo conserva las lecturas directas; sólo un escalar partido usa scratch. */
  private leer(n: number): number {
    const inicio = this.reservar(n), segmentos = this.segmentos;
    if (!segmentos) return inicio;
    const i = this.localizar(inicio, segmentos.inicios);
    const offset = inicio - segmentos.inicios[i]!;
    if (inicio + n <= segmentos.inicios[i + 1]!) {
      this.vista = segmentos.vistas[i]!;
      return offset;
    }
    let copiados = 0;
    for (const tramo of this.porciones(inicio, n)) {
      segmentos.cruce.set(tramo, copiados);
      copiados += tramo.length;
    }
    this.vista = segmentos.vistaCruce;
    return 0;
  }

  u8(): number { const offset = this.leer(1); return this.vista.getUint8(offset); }
  u32(): number { const offset = this.leer(4); return this.vista.getUint32(offset, true); }
  f64(): number { const offset = this.leer(8); return this.vista.getFloat64(offset, true); }
  entero(min = 0): number { return entero(this.f64(), min); }
  get posicion(): number { return this.pos; }
  irA(posicion: number): void { this.pos = posicion; }
  limitar(fin: number): void { this.fin = fin; }

  bloque(): Uint8Array | null {
    const bytes = this.bloqueSegmentado();
    return bytes === null ? null : contiguo(bytes);
  }

  bloqueSegmentado(): BytesMateria | null {
    const longitud = this.entero(-1);
    return longitud === -1 ? null : this.rango(this.reservar(longitud), longitud);
  }

  cuenta(): bigint {
    const longitud = this.entero(-Number.MAX_SAFE_INTEGER);
    if (longitud === 0) return 0n;
    const n = Math.abs(longitud);
    const bytes = contiguo(this.rango(this.reservar(n), n));
    if (bytes.at(-1) === 0) throw new Error('Total binario inválido en el punto de control.');
    const magnitud = BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`);
    return longitud < 0 ? -magnitud : magnitud;
  }

  pares(): Float64Array | null {
    const cantidad = this.entero(-1);
    if (cantidad === -1) return null;
    this.comprobarLongitud(cantidad, 12);
    const pares = new Float64Array(cantidad * 2);
    for (let i = 0; i < pares.length; i += 2) { pares[i] = this.u32(); pares[i + 1] = this.entero(); }
    return pares;
  }

  comprobarLongitud(cantidad: number, bytesPorElemento: number): void {
    if (cantidad > (this.fin - this.pos) / bytesPorElemento) throw new Error('Punto de control truncado.');
  }

  terminar(): void {
    if (this.pos !== this.fin) throw new Error('Sobran bytes en el punto de control.');
  }

  rango(inicio: number, longitud: number): BytesMateria {
    if (this.bytes instanceof Uint8Array) return this.bytes.subarray(inicio, inicio + longitud);
    if (longitud === 0) return SIN_BYTES;
    const { inicios } = this.segmentos!;
    const i = this.localizar(inicio, inicios), offset = inicio - inicios[i]!;
    if (inicio + longitud <= inicios[i + 1]!) return this.bytes.tramos[i]!.subarray(offset, offset + longitud);
    return agrupar([...this.porciones(inicio, longitud)], longitud);
  }

  private *porciones(inicio: number, longitud: number): IterableIterator<Uint8Array> {
    const { inicios } = this.segmentos!, { tramos } = this.bytes as TramosMateria;
    const fin = inicio + longitud;
    for (let i = this.localizar(inicio, inicios); inicio < fin; i++) {
      const hasta = Math.min(fin, inicios[i + 1]!);
      yield tramos[i]!.subarray(inicio - inicios[i]!, hasta - inicios[i]!);
      inicio = hasta;
    }
  }
}

function paginaDe(celda: number): number { return Math.floor(entero(celda, -1) / CELDAS_POR_PAGINA); }

function validarLote(lote: LoteGuardado, exclusivos: Uint8Array): number {
  const { celda, rol, dueno, pares } = lote;
  entero(rol, Rol.Suelo, Rol.Cielo);
  entero(dueno, 0, U32_MAX);
  if (celda >= 0 && (rol <= Rol.Aire || rol === Rol.Mar || rol === Rol.Cielo)) {
    if (rol >= Rol.Aire && celda % CELDAS_POR_PAGINA !== 0) throw new Error('Celda de aire fuera del inicio de página.');
    const local = celda % CELDAS_POR_PAGINA;
    const bit = 1 << (rol <= Rol.Aire ? rol : Rol.Aire + 1 + rol - Rol.Mar);
    if (exclusivos[local]! & bit) throw new Error(`Lote exclusivo duplicado en celda ${celda}.`);
    exclusivos[local]! |= bit;
  }
  if (!(pares instanceof Float64Array)) throw new Error('Composición de lote ausente en el punto de control.');
  const ids = new Set<number>();
  let especies = 0;
  for (let i = 0; i < pares.length; i += 2) {
    const id = pares[i]!;
    if (ids.has(id)) throw new Error(`Composición de lote con sustancia repetida: ${id}.`);
    ids.add(id);
    if (id !== 0 && pares[i + 1] !== 0) especies++;
  }
  return especies;
}

type Fuente<T> = Iterable<T> | (() => Iterable<T>);

export interface RecorridoPaginas {
  /** En orden lógico. El total de pares de un grupo puede imputarse a cualquiera de sus lotes. */
  medir(): Iterable<{ celda: number; pares: number }>;
  /** Lotes de una página de mundo en orden lógico. La página −1 agrupa los lotes sin celda. */
  lotesDePagina(pagina: number): Iterable<LoteGuardado>;
}

function repetible<T>(origen: Fuente<T>): () => Iterable<T> {
  if (typeof origen === 'function') return origen;
  const elementos = Array.isArray(origen) ? origen : Array.from(origen);
  return () => elementos;
}

interface PaginaPorEscribir {
  bytes: number;
  restantes: number;
  posicion: number;
  fin: number;
  exclusivos: Uint8Array;
}

function bytesDeLote(lote: LoteGuardado): number {
  if (!(lote.pares instanceof Float64Array)) throw new Error('Composición de lote ausente en el punto de control.');
  return BYTES_LOTE + BYTES_PAR * entero(lote.pares.length / 2);
}

/** Las fábricas recorren dos veces la misma arena inmóvil. El orden canónico es de primera visita por página y luego
 * de visita dentro de cada página. La primera pasada mide, la segunda escribe sin retener pares de otros lotes. */
export function codificarPaginas(epoca: number, lotes: Fuente<LoteGuardado>, libres: Fuente<LoteRef>,
  recorrido?: RecorridoPaginas): Uint8Array {
  entero(epoca);
  const recorrerLotes = recorrido ? undefined : repetible(lotes), recorrerLibres = repetible(libres);
  const paginas = new Map<number, PaginaPorEscribir>();
  let capacidad = 3 * BYTES_ENTERO; // época, número de páginas y número de ranuras retiradas
  function medir(celda: number, bytes: number): void {
    const pagina = paginaDe(celda);
    let plan = paginas.get(pagina);
    if (!plan) {
      plan = { bytes: 0, restantes: 0, posicion: 0, fin: 0, exclusivos: new Uint8Array(CELDAS_POR_PAGINA) };
      paginas.set(pagina, plan);
      capacidad += 3 * BYTES_ENTERO; // clave, época y número de lotes de la página
    }
    plan.bytes += bytes;
    plan.restantes++;
    capacidad += bytes;
  }
  if (recorrido) {
    for (const lote of recorrido.medir()) medir(lote.celda, BYTES_LOTE + BYTES_PAR * entero(lote.pares));
  } else {
    for (const lote of recorrerLotes!()) medir(lote.celda, bytesDeLote(lote));
  }
  let numeroLibres = 0;
  for (const _ of recorrerLibres()) numeroLibres++;
  capacidad = entero(capacidad + numeroLibres * BYTES_ENTERO);

  const salida = new Escritor(capacidad);
  const ranuras = new RanurasPaginas(capacidad, false);
  salida.entero(epoca);
  salida.entero(paginas.size);
  for (const [pagina, plan] of paginas) {
    salida.entero(pagina, -1);
    salida.entero(epoca);
    salida.entero(plan.restantes);
    plan.posicion = salida.posicion;
    plan.fin = plan.posicion + plan.bytes;
    salida.irA(plan.fin);
  }
  const inicioLibres = salida.posicion;
  function* recorrerPaginas(orden: RecorridoPaginas): IterableIterator<LoteGuardado> {
    for (const pagina of paginas.keys()) yield* orden.lotesDePagina(pagina);
  }
  for (const lote of recorrido ? recorrerPaginas(recorrido) : recorrerLotes!()) {
    const plan = paginas.get(paginaDe(lote.celda));
    const bytes = bytesDeLote(lote);
    if (!plan || plan.restantes === 0 || bytes > plan.fin - plan.posicion) throw new Error('Los lotes cambiaron durante la codificación.');
    validarLote(lote, plan.exclusivos);
    ranuras.registrar(entero(lote.ref), plan.posicion);
    salida.irA(plan.posicion);
    salida.entero(lote.ref);
    salida.entero(lote.celda, -1);
    salida.u8(lote.rol);
    salida.u32(lote.forma);
    salida.entero(lote.dueno);
    salida.pares(lote.pares);
    plan.posicion = salida.posicion;
    plan.restantes--;
  }
  for (const plan of paginas.values()) {
    if (plan.restantes !== 0 || plan.posicion !== plan.fin) throw new Error('Los lotes cambiaron durante la codificación.');
  }
  salida.irA(inicioLibres);
  salida.entero(numeroLibres);
  for (const ref of recorrerLibres()) {
    if (salida.posicion === capacidad) throw new Error('Las ranuras retiradas cambiaron durante la codificación.');
    ranuras.registrar(entero(ref), salida.posicion, true);
    salida.entero(ref);
  }
  if (salida.posicion !== capacidad) throw new Error('Las ranuras retiradas cambiaron durante la codificación.');
  ranuras.validar();
  return salida.terminar();
}

/** Las referencias ocupan al menos ocho bytes por ranura. Una referencia corrupta no puede dimensionar sola el índice. */
class RanurasPaginas {
  private readonly maximo: number;
  private readonly Tipo: Uint8ArrayConstructor | Int32ArrayConstructor | Float64ArrayConstructor;
  private posiciones: Uint8Array | Int32Array | Float64Array;
  private mayor = -1;
  private cantidad = 0;

  constructor(bytes: number, private readonly indexar: boolean) {
    this.maximo = Math.min(U32_MAX, Math.floor(bytes / BYTES_ENTERO));
    this.Tipo = !indexar ? Uint8Array : bytes <= 0x7fff_ffff ? Int32Array : Float64Array;
    this.posiciones = new this.Tipo(Math.min(256, this.maximo));
  }

  get longitud(): number { return this.cantidad; }
  en(ranura: number): number { return this.posiciones[ranura]!; }

  registrar(ref: LoteRef, posicion: number, libre = false): void {
    const ranura = slotDe(ref);
    if (ranura >= this.maximo) throw new Error(`Ranuras de materia no consecutivas: ${ranura}.`);
    if (ranura >= this.posiciones.length) {
      const crecidas = new this.Tipo(Math.min(this.maximo, Math.max(ranura + 1, this.posiciones.length * 2)));
      crecidas.set(this.posiciones);
      this.posiciones = crecidas;
    }
    if (this.posiciones[ranura] !== 0) throw new Error(`Ranura de materia duplicada: ${ranura}`);
    // 0 indica que no figura en el checkpoint. En el índice, el signo distingue una ranura retirada.
    this.posiciones[ranura] = this.indexar ? (libre ? -(posicion + 1) : posicion + 1) : 1;
    this.mayor = Math.max(this.mayor, ranura);
    this.cantidad++;
  }

  validar(): void {
    if (this.mayor >= this.cantidad) throw new Error(`Ranuras de materia no consecutivas: ${this.mayor}.`);
  }
}

function leerLote(entrada: Lector, ref: LoteRef, celda: number): LoteGuardado {
  const rol = entrada.u8() as Rol;
  const forma = entrada.u32();
  const dueno = entrada.entero();
  const pares = entrada.pares();
  if (pares === null) throw new Error('Composición de lote ausente en el punto de control.');
  return { ref, celda, rol, forma, dueno, pares };
}

function leerPaginas(
  epoca: number, bytes: BytesMateria, lote: (lote: LoteGuardado, especies: number) => void, libre: (ref: LoteRef) => void,
  indexar = false,
): RanurasPaginas {
  const entrada = new Lector(bytes);
  if (entrada.entero() !== epoca) throw new Error('Sello de época incorrecto en las páginas de materia.');
  const cantidad = entrada.entero();
  const paginas = new Set<number>();
  const ranuras = new RanurasPaginas(bytes.length, indexar);
  const exclusivos = new Uint8Array(CELDAS_POR_PAGINA);
  for (let i = 0; i < cantidad; i++) {
    const pagina = entrada.entero(-1);
    if (paginas.has(pagina)) throw new Error(`Página de materia duplicada: ${pagina}`);
    paginas.add(pagina);
    if (entrada.entero() !== epoca) throw new Error(`Sello de época incorrecto en la página de materia ${pagina}.`);
    const numeroLotes = entrada.entero();
    exclusivos.fill(0); // La celda de cada lote se comprueba contra esta página, que es única.
    for (let j = 0; j < numeroLotes; j++) {
      const posicion = entrada.posicion;
      const ref = entrada.entero();
      ranuras.registrar(ref, posicion);
      const celda = entrada.entero(-1);
      if (paginaDe(celda) !== pagina) throw new Error(`Celda ${celda} fuera de su página de materia.`);
      const guardado = leerLote(entrada, ref, celda);
      lote(guardado, validarLote(guardado, exclusivos));
    }
  }
  const numeroLibres = entrada.entero();
  for (let i = 0; i < numeroLibres; i++) {
    const posicion = entrada.posicion;
    const ref = entrada.entero();
    ranuras.registrar(ref, posicion, true);
    libre(ref);
  }
  ranuras.validar();
  entrada.terminar();
  return ranuras;
}

export function decodificarPaginas(epoca: number, bytes: BytesMateria): { lotes: LoteGuardado[]; libres: LoteRef[] } {
  const lotes: LoteGuardado[] = [];
  const libres: LoteRef[] = [];
  leerPaginas(epoca, bytes, lote => lotes.push(lote), ref => libres.push(ref));
  return { lotes, libres };
}

/** Valida las páginas en el orden del archivo. Después se puede leer cada lote o referencia retirada por ranura. */
export function indexarPaginas(
  epoca: number, bytes: BytesMateria, observarLote: (lote: LoteGuardado, especies: number) => void = () => {},
): { ranuras: number; leer(ranura: number): LoteGuardado | LoteRef | undefined } {
  const posiciones = leerPaginas(epoca, bytes, observarLote, () => {}, true);
  const entrada = new Lector(bytes);
  return {
    ranuras: posiciones.longitud,
    leer(ranura) {
      if (!Number.isInteger(ranura) || ranura < 0 || ranura >= posiciones.longitud) return undefined;
      const posicion = posiciones.en(ranura);
      entrada.irA(Math.abs(posicion) - 1);
      const ref = entrada.entero();
      return posicion < 0 ? ref : leerLote(entrada, ref, entrada.entero(-1));
    },
  };
}

function validarGarantia(tipo: TipoIntento, nonce: number, nonces: Set<number>): void {
  if (!TIPOS_CON_GARANTIA.has(tipo)) throw new Error(`Tipo de intento sin garantía: ${tipo}`);
  entero(nonce);
  if (nonces.has(nonce)) throw new Error(`Nonce de garantía duplicado: ${nonce}`);
  nonces.add(nonce);
}

export function codificarEnVuelo(intentos: Iterable<Intento>): Uint8Array {
  const salida = new Escritor();
  const pendientes = Array.from(intentos);
  const nonces = new Set<number>();
  salida.entero(pendientes.length);
  for (const i of pendientes) {
    validarGarantia(i.tipo, i.nonce, nonces);
    salida.u8(i.tipo);
    salida.entero(i.nonce);
    salida.entero(i.de, REF_NULA);
    salida.entero(i.a, REF_NULA);
    salida.entero(i.celda, -1);
    salida.entero(i.lote, REF_NULA);
    salida.pares(i.materia);
    salida.entero(i.dato?.length ?? -1, -1);
    if (i.dato) for (const valor of i.dato) salida.f64(valor);
    salida.bloque(i.bytes);
  }
  return salida.terminar();
}

function leerEnVuelo(bytes: Uint8Array, intento: (i: Intento) => void): void {
  const entrada = new Lector(bytes);
  const cantidad = entrada.entero();
  const nonces = new Set<number>();
  for (let j = 0; j < cantidad; j++) {
    const tipo = entrada.u8() as TipoIntento;
    const nonce = entrada.entero();
    validarGarantia(tipo, nonce, nonces);
    const de = entrada.entero(REF_NULA);
    const a = entrada.entero(REF_NULA);
    const celda = entrada.entero(-1);
    const lote = entrada.entero(REF_NULA);
    const materia = entrada.pares();
    const longitudDato = entrada.entero(-1);
    entrada.comprobarLongitud(longitudDato, 8);
    const dato = longitudDato === -1 ? null : Float64Array.from({ length: longitudDato }, () => entrada.f64());
    intento({ tipo, de, a, celda, lote, nonce, materia, dato, bytes: entrada.bloque() });
  }
  entrada.terminar();
}

export function decodificarEnVuelo(bytes: Uint8Array): Intento[] {
  const intentos: Intento[] = [];
  leerEnVuelo(bytes, intento => intentos.push(intento));
  return intentos;
}

function prepararCheckpoint(checkpoint: MateriaCheckpoint): { cuerpo: Uint8Array[]; longitud: number } {
  const epoca = entero(checkpoint.epoca);
  const tick = entero(checkpoint.tick);
  const { sustancias, registro, paginas, enVuelo } = checkpoint;
  if ([sustancias, registro, enVuelo].some(bytes => !(bytes instanceof Uint8Array)))
    throw new Error('Falta un bloque del punto de control de materia.');
  const bloques = [sustancias, registro, paginas, enVuelo];
  const cuentas = new Escritor();
  for (const cuenta of [checkpoint.inicial, checkpoint.fuentes, checkpoint.sumideros]) {
    if (cuenta.length !== NE + 1) throw new Error('Ancho de cuenta incorrecto en el punto de control.');
    for (const valor of cuenta) cuentas.cuenta(valor);
  }
  leerPaginas(epoca, checkpoint.paginas, () => {}, () => {});
  leerEnVuelo(checkpoint.enVuelo, () => {});
  const libro = cuentas.terminar();
  const cabeceras = new Escritor();
  cabeceras.u32(FIRMA);
  cabeceras.u32(VERSION);
  cabeceras.entero(epoca);
  cabeceras.entero(tick);
  const inicioLongitudes = cabeceras.posicion;
  for (const bytes of bloques) cabeceras.entero(bytes.length);

  const prefijos = cabeceras.terminar();
  const cuerpo = [prefijos.subarray(0, inicioLongitudes)];
  let longitud = prefijos.length + libro.length + BYTES_CRC;
  let pos = inicioLongitudes;
  for (const bytes of bloques) {
    cuerpo.push(prefijos.subarray(pos, pos + BYTES_ENTERO));
    for (const tramo of tramosDe(bytes)) cuerpo.push(tramo);
    pos += BYTES_ENTERO;
    longitud += bytes.length;
  }
  cuerpo.push(libro);
  return { cuerpo, longitud };
}

function* partir(bloque: Uint8Array, maximo: number): IterableIterator<Uint8Array> {
  for (let pos = 0; pos < bloque.length; pos += maximo) yield bloque.subarray(pos, pos + maximo);
}

function* escribirTramos(cuerpo: readonly Uint8Array[], maximo: number): IterableIterator<Uint8Array> {
  let crc = 0;
  for (const bloque of cuerpo) for (const tramo of partir(bloque, maximo)) {
    crc = crc32(tramo, crc);
    yield tramo;
  }
  const sello = new Escritor(BYTES_CRC);
  sello.u32(crc);
  yield* partir(sello.terminar(), maximo);
}

/** Valida la estructura antes de emitir y devuelve la longitud total (incluido el CRC32). Los tramos de una
 * sola pasada son vistas de solo lectura por contrato. Los bloques de entrada deben permanecer inmóviles
 * y accesibles hasta consumir el último tramo. */
export function codificarCheckpointEnTramos(checkpoint: MateriaCheckpoint, maximo: number):
  { longitud: number; tramos: IterableIterator<Uint8Array> } {
  entero(maximo, 1);
  const { cuerpo, longitud } = prepararCheckpoint(checkpoint);
  return { longitud, tramos: escribirTramos(cuerpo, maximo) };
}

export function codificarCheckpoint(checkpoint: MateriaCheckpoint): Uint8Array {
  const { cuerpo, longitud } = prepararCheckpoint(checkpoint);
  const salida = new Escritor(longitud);
  for (const bloque of cuerpo) salida.crudo(bloque);
  // La validación estructural y el balance no ven un bit cambiado en una forma, una celda o los bloques opacos.
  salida.u32(crc32(salida.terminar()));
  return salida.terminar();
}

function* entradasPares(pares: Float64Array): IterableIterator<readonly [number, number]> {
  for (let i = 0; i < pares.length; i += 2) yield [pares[i]!, pares[i + 1]!];
}

function sumarPares(cuenta: bigint[], pares: Float64Array, sustancia: (id: number) => Readonly<Sustancia>): void {
  const balance = balancePares(entradasPares(pares), sustancia);
  for (let e = 0; e <= NE; e++) cuenta[e] += balance[e]!;
}

/** Balance de las garantías de `MateriaCheckpoint.enVuelo`: al cargar es el `enVuelo` del libro del hilo 0. */
export function saldoEnVuelo(enVuelo: Uint8Array, sustancia: (id: number) => Readonly<Sustancia>): bigint[] {
  const saldo = Array<bigint>(NE + 1).fill(0n);
  leerEnVuelo(enVuelo, intento => { if (intento.materia) sumarPares(saldo, intento.materia, sustancia); });
  return saldo;
}

type ResolverSustancia = (id: number, registroQuimico: Uint8Array) => Readonly<Sustancia>;

export function decodificarCheckpoint(bytes: Uint8Array, sustancia: ResolverSustancia): MateriaCheckpoint<Uint8Array> {
  return decodificarFuente(bytes, sustancia);
}

/** Agota la fuente antes de decodificar. Retiene vistas inmutables de los tramos de páginas, sin unirlas.
 * Cada tramo entregado debe tener bytes estables, en particular el productor no puede reciclar su búfer. */
export function decodificarCheckpointEnTramos(tramos: Iterable<Uint8Array>, sustancia: ResolverSustancia): MateriaCheckpoint {
  const vistas: Uint8Array[] = [];
  let longitud = 0;
  for (const tramo of tramos) {
    if (!(tramo instanceof Uint8Array)) throw new Error('Tramo de materia inválido.');
    if (tramo.length === 0) continue;
    longitud = entero(longitud + tramo.length);
    vistas.push(tramo);
  }
  return decodificarFuente(agrupar(vistas, longitud), sustancia);
}

function decodificarFuente(bytes: Uint8Array, sustancia: ResolverSustancia): MateriaCheckpoint<Uint8Array>;
function decodificarFuente(bytes: BytesMateria, sustancia: ResolverSustancia): MateriaCheckpoint;
function decodificarFuente(bytes: BytesMateria, sustancia: ResolverSustancia): MateriaCheckpoint {
  const fin = bytes.length - BYTES_CRC;
  if (fin < 0) throw new Error('Punto de control truncado.');
  const entrada = new Lector(bytes);
  entrada.irA(fin);
  const sello = entrada.u32();
  entrada.irA(0);
  entrada.limitar(fin);
  if (entrada.u32() !== FIRMA || entrada.u32() !== VERSION) throw new Error('Formato de punto de control de materia desconocido.');
  let crc = 0, restantes = fin;
  for (const tramo of tramosDe(bytes)) {
    if (restantes === 0) break;
    crc = crc32(restantes >= tramo.length ? tramo : tramo.subarray(0, restantes), crc);
    restantes -= Math.min(restantes, tramo.length);
  }
  if (crc !== sello) {
    throw new Error('Punto de control de materia corrupto o truncado: no cuadra su CRC32.');
  }
  const epoca = entrada.entero();
  const tick = entrada.entero();
  const sustancias = entrada.bloque(), registro = entrada.bloque();
  const paginas = entrada.bloqueSegmentado(), enVuelo = entrada.bloque();
  if (!sustancias || !registro || !paginas || !enVuelo) throw new Error('Falta un bloque del punto de control de materia.');
  const [inicial, fuentes, sumideros] = Array.from({ length: 3 }, () => Array.from({ length: NE + 1 }, () => entrada.cuenta()));
  entrada.terminar();

  const quimica = (id: number) => sustancia(id, sustancias);
  const lotes = Array<bigint>(NE + 1).fill(0n);
  leerPaginas(epoca, paginas, lote => sumarPares(lotes, lote.pares, quimica), () => {});
  comprobarConservacion({ inicial: inicial!, fuentes: fuentes!, sumideros: sumideros! }, lotes, saldoEnVuelo(enVuelo, quimica));
  return { epoca, tick, sustancias, registro, paginas, enVuelo, inicial: inicial!, fuentes: fuentes!, sumideros: sumideros! };
}
