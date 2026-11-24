import { Buffer } from 'node:buffer';
import { NE } from '../../shared/naturaleza.js';
import { REF_NULA, TipoIntento, slotDe, type Hilo, type Intento } from '../motor/contratos.js';
import { balancePares, comprobarConservacion } from './libro.js';
import { Rol, type LoteRef, type MateriaCheckpoint, type Sustancia } from './tipos.js';

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
const TOTAL_MAX_U32 = 0xffff_ffff;
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
  u32(valor: number): void { const inicio = this.reservar(4); this.vista.setUint32(inicio, entero(valor, 0, TOTAL_MAX_U32), true); }
  f64(valor: number): void { const inicio = this.reservar(8); this.vista.setFloat64(inicio, valor, true); }
  entero(valor: number, min = 0): void { this.f64(entero(valor, min)); }

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

class Lector {
  private readonly vista: DataView;
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private leer(n: number): number {
    if (n > this.bytes.length - this.pos) throw new Error('Punto de control truncado.');
    const inicio = this.pos;
    this.pos += n;
    return inicio;
  }

  u8(): number { return this.vista.getUint8(this.leer(1)); }
  u32(): number { return this.vista.getUint32(this.leer(4), true); }
  f64(): number { return this.vista.getFloat64(this.leer(8), true); }
  entero(min = 0): number { return entero(this.f64(), min); }

  bloque(): Uint8Array | null {
    const longitud = this.entero(-1);
    return longitud === -1 ? null : this.subarray(longitud);
  }

  cuenta(): bigint {
    const longitud = this.entero(-Number.MAX_SAFE_INTEGER);
    if (longitud === 0) return 0n;
    const bytes = this.subarray(Math.abs(longitud));
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
    if (cantidad > (this.bytes.length - this.pos) / bytesPorElemento) throw new Error('Punto de control truncado.');
  }

  terminar(): void {
    if (this.pos !== this.bytes.length) throw new Error('Sobran bytes en el punto de control.');
  }

  private subarray(longitud: number): Uint8Array {
    const inicio = this.leer(longitud);
    return this.bytes.subarray(inicio, inicio + longitud);
  }
}

function paginaDe(celda: number): number { return Math.floor(entero(celda, -1) / CELDAS_POR_PAGINA); }

function registrarRanura(ranuras: Set<number>, ref: LoteRef): void {
  const ranura = slotDe(entero(ref));
  if (ranuras.has(ranura)) throw new Error(`Ranura de materia duplicada: ${ranura}`);
  ranuras.add(ranura);
}

function validarRanuras(ranuras: Set<number>): void {
  for (const ranura of ranuras) if (ranura >= ranuras.size || ranura >= TOTAL_MAX_U32) {
    throw new Error(`Ranuras de materia no consecutivas: ${ranura}.`);
  }
}

function validarLote(lote: LoteGuardado, exclusivos: Set<string>): void {
  const { celda, rol, dueno, pares } = lote;
  entero(rol, Rol.Suelo, Rol.Pieza);
  entero(dueno, 0, TOTAL_MAX_U32);
  if (celda >= 0 && rol <= Rol.Aire) {
    if (rol === Rol.Aire && celda % CELDAS_POR_PAGINA !== 0) throw new Error('Celda de aire fuera del inicio de página.');
    const clave = `${celda}:${rol}`;
    if (exclusivos.has(clave)) throw new Error(`Lote exclusivo duplicado en celda ${celda}.`);
    exclusivos.add(clave);
  }
  if (!(pares instanceof Float64Array)) throw new Error('Composición de lote ausente en el punto de control.');
  const ids = new Set<number>();
  for (let i = 0; i < pares.length; i += 2) {
    const id = pares[i]!;
    if (ids.has(id)) throw new Error(`Composición de lote con sustancia repetida: ${id}.`);
    ids.add(id);
  }
}

export function codificarPaginas(epoca: number, lotes: Iterable<LoteGuardado>, libres: Iterable<LoteRef>): Uint8Array {
  const paginas = new Map<number, LoteGuardado[]>();
  const ranuras = new Set<number>();
  const exclusivos = new Set<string>();
  for (const lote of lotes) {
    registrarRanura(ranuras, lote.ref);
    const pagina = paginaDe(lote.celda);
    validarLote(lote, exclusivos);
    let propios = paginas.get(pagina);
    if (!propios) { propios = []; paginas.set(pagina, propios); }
    propios.push(lote);
  }
  const salida = new Escritor();
  salida.entero(epoca);
  salida.entero(paginas.size);
  for (const [pagina, propios] of paginas) {
    salida.entero(pagina, -1);
    salida.entero(epoca);
    salida.entero(propios.length);
    for (const lote of propios) {
      salida.entero(lote.ref);
      salida.entero(lote.celda, -1);
      salida.u8(lote.rol);
      salida.u32(lote.forma);
      salida.entero(lote.dueno);
      salida.pares(lote.pares);
    }
  }
  const retirados = Array.from(libres);
  salida.entero(retirados.length);
  for (const ref of retirados) { registrarRanura(ranuras, ref); salida.entero(ref); }
  validarRanuras(ranuras);
  return salida.terminar();
}

function leerPaginas(epoca: number, bytes: Uint8Array, lote: (lote: LoteGuardado) => void, libre: (ref: LoteRef) => void): void {
  const entrada = new Lector(bytes);
  if (entrada.entero() !== epoca) throw new Error('Sello de época incorrecto en las páginas de materia.');
  const cantidad = entrada.entero();
  const paginas = new Set<number>();
  const ranuras = new Set<number>();
  const exclusivos = new Set<string>();
  for (let i = 0; i < cantidad; i++) {
    const pagina = entrada.entero(-1);
    if (paginas.has(pagina)) throw new Error(`Página de materia duplicada: ${pagina}`);
    paginas.add(pagina);
    if (entrada.entero() !== epoca) throw new Error(`Sello de época incorrecto en la página de materia ${pagina}.`);
    const numeroLotes = entrada.entero();
    for (let j = 0; j < numeroLotes; j++) {
      const ref = entrada.entero();
      registrarRanura(ranuras, ref);
      const celda = entrada.entero(-1);
      if (paginaDe(celda) !== pagina) throw new Error(`Celda ${celda} fuera de su página de materia.`);
      const rol = entrada.u8() as Rol;
      const forma = entrada.u32();
      const dueno = entrada.entero();
      const pares = entrada.pares();
      if (pares === null) throw new Error('Composición de lote ausente en el punto de control.');
      const guardado = { ref, celda, rol, forma, dueno, pares };
      validarLote(guardado, exclusivos);
      lote(guardado);
    }
  }
  const numeroLibres = entrada.entero();
  for (let i = 0; i < numeroLibres; i++) {
    const ref = entrada.entero();
    registrarRanura(ranuras, ref);
    libre(ref);
  }
  validarRanuras(ranuras);
  entrada.terminar();
}

export function decodificarPaginas(epoca: number, bytes: Uint8Array): { lotes: LoteGuardado[]; libres: LoteRef[] } {
  const lotes: LoteGuardado[] = [];
  const libres: LoteRef[] = [];
  leerPaginas(epoca, bytes, lote => lotes.push(lote), ref => libres.push(ref));
  return { lotes, libres };
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

export function codificarCheckpoint(checkpoint: MateriaCheckpoint): Uint8Array {
  const epoca = entero(checkpoint.epoca);
  const tick = entero(checkpoint.tick);
  const bloques = [checkpoint.sustancias, checkpoint.registro, checkpoint.paginas, checkpoint.enVuelo];
  if (bloques.some(bytes => !(bytes instanceof Uint8Array))) throw new Error('Falta un bloque del punto de control de materia.');
  const cuentas = new Escritor();
  for (const cuenta of [checkpoint.inicial, checkpoint.fuentes, checkpoint.sumideros]) {
    if (cuenta.length !== NE + 1) throw new Error('Ancho de cuenta incorrecto en el punto de control.');
    for (const valor of cuenta) cuentas.cuenta(valor);
  }
  leerPaginas(epoca, checkpoint.paginas, () => {}, () => {});
  leerEnVuelo(checkpoint.enVuelo, () => {});
  const libro = cuentas.terminar();
  const salida = new Escritor(24 + libro.length + bloques.reduce((n, bytes) => n + 8 + bytes.length, 0));
  salida.u32(FIRMA);
  salida.u32(VERSION);
  salida.entero(epoca);
  salida.entero(tick);
  for (const bytes of bloques) salida.bloque(bytes);
  salida.crudo(libro);
  return salida.terminar();
}

function* entradasPares(pares: Float64Array): IterableIterator<readonly [number, number]> {
  for (let i = 0; i < pares.length; i += 2) yield [pares[i]!, pares[i + 1]!];
}

export function decodificarCheckpoint(bytes: Uint8Array, sustancia: (id: number, registroQuimico: Uint8Array) => Readonly<Sustancia>): MateriaCheckpoint {
  const entrada = new Lector(bytes);
  if (entrada.u32() !== FIRMA || entrada.u32() !== VERSION) throw new Error('Formato de punto de control de materia desconocido.');
  const epoca = entrada.entero();
  const tick = entrada.entero();
  const [sustancias, registro, paginas, enVuelo] = Array.from({ length: 4 }, () => entrada.bloque());
  if (!sustancias || !registro || !paginas || !enVuelo) throw new Error('Falta un bloque del punto de control de materia.');
  const [inicial, fuentes, sumideros] = Array.from({ length: 3 }, () => Array.from({ length: NE + 1 }, () => entrada.cuenta()));
  entrada.terminar();

  const lotes = Array<bigint>(NE + 1).fill(0n);
  const depositos = Array<bigint>(NE + 1).fill(0n);
  const contar = (cuenta: bigint[], pares: Float64Array): void => {
    const balance = balancePares(entradasPares(pares), id => sustancia(id, sustancias));
    for (let e = 0; e <= NE; e++) cuenta[e] += balance[e]!;
  };
  leerPaginas(epoca, paginas, lote => contar(lotes, lote.pares), () => {});
  leerEnVuelo(enVuelo, intento => { if (intento.materia) contar(depositos, intento.materia); });
  comprobarConservacion({ inicial: inicial!, fuentes: fuentes!, sumideros: sumideros! }, lotes, depositos);
  return { epoca, tick, sustancias, registro, paginas, enVuelo, inicial: inicial!, fuentes: fuentes!, sumideros: sumideros! };
}
