import { formaDeCodigo, type SustanciaId } from '../../shared/materia.js';
import { CAPACIDAD_ATOMO, KAPPA0, NE, PERCOLACION, R } from '../../shared/naturaleza.js';
import { genDe, refDe, slotDe, type Hilo, type Terreno } from '../motor/contratos.js';
import type { PageArena } from '../soa/arena.js';
import type { LoteGuardado } from './checkpoint.js';
import { balanceDoble, balancePares, prepararAsiento, prepararAsientoDoble } from './libro.js';
import {
  ENERGIA, Parte, Rol, type ArenaMateria, type Ecuacion, type Libro, type LoteRef, type Pedido,
  type ServicioQuimico, type Sustancia, type Traslado, type VistaLote,
} from './tipos.js';

export type MemoriaMateria = Pick<PageArena, 'field' | 'reserve' | 'release' | 'slots'>;
export const LOTES_POR_BLOQUE = 256;
interface OpcionesArena {
  lotes: MemoriaMateria;
  desborde: MemoriaMateria;
  paginas: MemoriaMateria;
  /** Solo para un dueño. El coordinador reserva los bloques físicos en F0. */
  contenido?: MemoriaMateria;
  /** Composición ya confirmada del lote, en el orden de `muestra`. */
  leerFrio?: (ref: LoteRef, celda: number) => Float64Array;
  terreno: Pick<Terreno, 'chunkDe' | 'duenoChunk'>;
  quimica: Pick<ServicioQuimico, 'sustancia'>;
  hilo: Hilo;
  agua: SustanciaId;
  digerible: (s: Readonly<Sustancia>, kappa: NonNullable<Pedido['kappa']>) => number;
}

const RANURAS = 8;
const MARCAS = 4;
const BYTES_CONTENIDO = 108;
const BYTES_IDENTIDAD = 12;
const BYTES_POR_LOTE = BYTES_CONTENIDO + BYTES_IDENTIDAD;
const ACTIVO = 1;
const USADO = 2; // Distingue la primera asignación de la reutilización de una ranura.
const GEN_MAX = genDe(Number.MAX_SAFE_INTEGER);
const UINT32_MAX = 0xffffffff;
const CELDAS_PAGINA = 256;
const KAPPA_BASE = [KAPPA0, KAPPA0, KAPPA0, KAPPA0] as const;

function natural(n: number, nombre: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new RangeError(`${nombre} inválido: ${n}`);
  return n;
}
const puntero = (slot: number) => natural(slot + 1, 'Puntero de materia', UINT32_MAX);
const DOS53 = 2 ** 53;

/** ⌊a/b⌋ de naturales seguros (b > 0), exacto: en doble si a + b < 2⁵³ (el cociente redondeado no llega a cruzar un
 * entero), si no en bigint. */
const cociente = (a: number, b: number): number => (a + b < DOS53 ? Math.floor(a / b) : Number(BigInt(a) / BigInt(b)));

/**
 * Pares (sustancia, cuantos) en orden de inserción, con el calor como sustancia 0: hace de Map sin asignar memoria por
 * lote (cada arena reutiliza las suyas). Un par que llega a 0 sale y corre los siguientes, y uno nuevo va al final, como
 * en un Map, así que `escribir` deja las ranuras en el mismo orden que antes.
 */
class Lista {
  id = new Float64Array(16);
  q = new Float64Array(16);
  n = 0;

  vaciar(): this { this.n = 0; return this; }
  indice(id: number): number {
    for (let k = 0; k < this.n; k++) if (this.id[k] === id) return k;
    return -1;
  }
  get(id: number): number {
    const k = this.indice(id);
    return k < 0 ? 0 : this.q[k]!;
  }
  /** El total ha de ser un natural; si es 0, el par sale. */
  sumar(id: number, delta: number): void {
    const k = this.indice(id);
    const total = natural((k < 0 ? 0 : this.q[k]!) + delta, id === 0 ? 'Calor' : 'Cantidad');
    if (total !== 0) {
      if (k >= 0) this.q[k] = total;
      else this.poner(id, total);
    } else if (k >= 0) {
      this.id.copyWithin(k, k + 1, this.n);
      this.q.copyWithin(k, k + 1, this.n);
      this.n--;
    }
  }
  /** Añade al final un par que no está. */
  poner(id: number, q: number): void {
    if (this.n === this.id.length) {
      const id2 = new Float64Array(2 * this.n), q2 = new Float64Array(2 * this.n);
      id2.set(this.id); q2.set(this.q);
      this.id = id2; this.q = q2;
    }
    this.id[this.n] = id;
    this.q[this.n++] = q;
  }
  /** Sustancias, sin el calor. */
  especies(): number { return this.n - (this.indice(0) >= 0 ? 1 : 0); }
  pares(): Float64Array {
    const out = new Float64Array(2 * this.n);
    for (let k = 0; k < this.n; k++) { out[2 * k] = this.id[k]!; out[2 * k + 1] = this.q[k]!; }
    return out;
  }
  *[Symbol.iterator](): IterableIterator<[number, number]> {
    for (let k = 0; k < this.n; k++) yield [this.id[k]!, this.q[k]!];
  }
}

function leerPares(pares: Float64Array, m: Lista): Lista {
  if (pares.length % 2 !== 0) throw new Error('Pares de materia incompletos.');
  m.vaciar();
  for (let i = 0; i < pares.length; i += 2) {
    m.sumar(natural(pares[i], 'Sustancia', UINT32_MAX), natural(pares[i + 1], 'Cantidad'));
  }
  return m;
}

/** Ranuras fuera de línea que requiere una arena vacía al volver a cargar estos lotes. */
export function ranurasDesborde(lotes: readonly LoteGuardado[]): number {
  const pares = new Lista();
  let desborde = 0;
  for (const lote of lotes) desborde += desbordeDeEspecies(leerPares(lote.pares, pares).especies());
  return desborde;
}

export function desbordeDeEspecies(especies: number): number {
  return Math.max(0, especies - RANURAS);
}

/** Entradas y salidas de una ecuación agrupadas por sustancia (id, ν, id, ν…), ya comprobado su balance. */
interface Grupos { entradas: Float64Array; salidas: Float64Array }

function columnasContenido(bytes: Uint8Array, bloque: number, ancho: number) {
  const n = LOTES_POR_BLOQUE;
  const base = bytes.byteOffset + bloque * n * ancho;
  const memoria = bytes.buffer;
  return {
    esp: new Uint32Array(memoria, base, n * RANURAS),
    cant: new Float64Array(memoria, base + 32 * n, n * RANURAS),
    calor: new Float64Array(memoria, base + 96 * n, n),
    exceso: new Uint32Array(memoria, base + 104 * n, n),
  };
}

function columnasIdentidad(bytes: Uint8Array, bloque: number, ancho: number) {
  const n = LOTES_POR_BLOQUE;
  const base = bytes.byteOffset + ((bloque + 1) * ancho - BYTES_IDENTIDAD) * n;
  const memoria = bytes.buffer;
  return {
    marcas: new Uint8Array(memoria, base, n * MARCAS),
    forma: new Uint32Array(memoria, base + 4 * n, n),
    gen: new Uint32Array(memoria, base + 8 * n, n),
  };
}

export class ArenaLotes implements ArenaMateria {
  private readonly datos: Uint8Array;
  private readonly anchoIdentidad: number;
  private readonly datosContenido: Uint8Array;
  private readonly anchoContenido: number;
  /** Puntero a ranura física. Cero en un lote vivo indica que está aparcado. */
  private readonly fisicas: Uint32Array | null;
  /** Saldo de los lotes aparcados. En el modo frío todos tienen el mismo dueño. */
  private readonly saldoFrio: bigint[] | null;
  private readonly bloques: ReturnType<typeof columnasIdentidad>[] = [];
  private readonly contenidos: ReturnType<typeof columnasContenido>[] = [];
  private readonly celda: Float64Array;
  private readonly dueno: Uint32Array;
  private readonly siguiente: Uint32Array;
  private readonly primero: Uint32Array;
  private readonly extraEsp: Uint32Array;
  private readonly extraCant: Float64Array;
  private readonly extraSig: Uint32Array;
  private readonly retirar: number[] = [];
  private readonly retirarExtra: number[] = [];
  private readonly retirarFisicas: number[] = [];
  // I-B: una garantía se resuelve en dos ticks. Las tres cubetas incluyen el tick en curso.
  private readonly garantizados = [new Set<number>(), new Set<number>(), new Set<number>()];
  private readonly abonados = [new Set<number>(), new Set<number>(), new Set<number>()];
  private turno = 0;
  // De trabajo: el lote que se lee (u origen), el destino de un traslado y la parte o los pares que llegan; el desborde
  // reservado para cada uno; átomos por cuanto de cada sustancia (0: aún sin leer); ecuaciones ya comprobadas.
  private readonly la = new Lista();
  private readonly lb = new Lista();
  private readonly lp = new Lista();
  private readonly nuevasA: number[] = [];
  private readonly nuevasB: number[] = [];
  private porCuanto = new Float64Array(64);
  private readonly grupos = new WeakMap<Ecuacion, Grupos>();
  private readonly balance = new Float64Array(NE + 1);
  private readonly asiento = new Float64Array(NE + 1);

  constructor(private readonly op: OpcionesArena) {
    const { lotes, paginas, desborde, contenido, leerFrio } = op;
    natural(op.hilo, 'Hilo', UINT32_MAX);
    if (contenido && (op.hilo !== 0 || contenido === lotes || contenido === desborde || contenido === paginas)) {
      throw new Error('La composición separada requiere una arena física independiente y un solo dueño.');
    }
    if (leerFrio && !contenido) throw new Error('La materia fría requiere una arena física independiente.');
    // M1 reserva bloques completos en F0. Al crecer el SAB las columnas anteriores mantienen su desplazamiento.
    this.anchoIdentidad = contenido ? BYTES_IDENTIDAD : BYTES_POR_LOTE;
    this.anchoContenido = contenido ? BYTES_CONTENIDO : BYTES_POR_LOTE;
    this.datos = lotes.field('materia.lotes', Uint8Array, this.anchoIdentidad);
    this.datosContenido = contenido?.field('materia.contenido', Uint8Array, this.anchoContenido) ?? this.datos;
    this.fisicas = contenido ? lotes.field('materia.fisica', Uint32Array, 1) : null;
    this.saldoFrio = leerFrio ? Array<bigint>(NE + 1).fill(0n) : null;
    this.celda = lotes.field('materia.celda', Float64Array, 1);
    this.dueno = lotes.field('materia.dueno', Uint32Array, 1);
    this.siguiente = lotes.field('materia.siguiente', Uint32Array, 1);
    this.primero = paginas.field('materia.primero', Uint32Array, CELDAS_PAGINA);
    this.extraEsp = desborde.field('materia.esp', Uint32Array, 1);
    this.extraCant = desborde.field('materia.cant', Float64Array, 1);
    this.extraSig = desborde.field('materia.siguiente', Uint32Array, 1);
    // Una vista que no crece con la memoria pierde en silencio lo que se escribe tras su final: sería materia destruida.
    for (const columna of [this.datos, this.datosContenido, this.fisicas, this.celda, this.dueno, this.siguiente,
      this.primero, this.extraEsp, this.extraCant, this.extraSig]) {
      if (!columna) continue;
      const memoria = columna.buffer;
      if (!(memoria instanceof SharedArrayBuffer) || !memoria.growable) {
        throw new Error('La materia exige columnas sobre un SharedArrayBuffer crecible.');
      }
    }
  }

  private sustancia = (id: SustanciaId): Readonly<Sustancia> => this.op.quimica.sustancia(id);

  private atomosDe(id: SustanciaId): number {
    if (id >= this.porCuanto.length) {
      const t = new Float64Array(Math.max(2 * this.porCuanto.length, id + 1));
      t.set(this.porCuanto);
      this.porCuanto = t;
    }
    let a = this.porCuanto[id]!;
    if (a === 0) {
      const at = this.sustancia(id).atomos;
      for (let e = 0; e < at.length; e++) a += at[e]!;
      this.porCuanto[id] = a;
    }
    return a;
  }

  private bloque(s: number) {
    const i = Math.floor(s / LOTES_POR_BLOQUE);
    if (i >= this.bloques.length && this.datos.byteLength < (i + 1) * LOTES_POR_BLOQUE * this.anchoIdentidad) {
      throw new Error(`Falta el bloque ${i} de materia que debe reservarse en F0.`);
    }
    return this.bloques[i] ??= columnasIdentidad(this.datos, i, this.anchoIdentidad);
  }

  private bloqueContenido(fisica: number) {
    const i = Math.floor(fisica / LOTES_POR_BLOQUE);
    if (i >= this.contenidos.length && this.datosContenido.byteLength < (i + 1) * LOTES_POR_BLOQUE * this.anchoContenido) {
      throw new Error(`Falta el bloque físico ${i} de materia que debe reservarse en F0.`);
    }
    return this.contenidos[i] ??= columnasContenido(this.datosContenido, i, this.anchoContenido);
  }

  private fisica(s: number): number { return this.fisicas ? Atomics.load(this.fisicas, s) - 1 : s; }

  private celdaDe(celda: number, rol: Rol): number {
    if (celda === -1) return celda;
    natural(celda, 'Celda');
    if (celda >= this.primero.length) throw new RangeError(`Celda material fuera del terreno: ${celda}`);
    return rol === Rol.Aire || rol === Rol.Mar || rol === Rol.Cielo ? this.op.terreno.chunkDe(celda) * CELDAS_PAGINA : celda;
  }

  private duenoDe(s: number): Hilo {
    const celda = this.celda[s];
    return celda === -1 ? this.dueno[s] : this.op.terreno.duenoChunk[this.op.terreno.chunkDe(celda)];
  }

  private activo(s: number): boolean {
    return Atomics.load(this.bloque(s).marcas, (s % LOTES_POR_BLOQUE) * MARCAS + ACTIVO) === 1;
  }

  private instalar(s: number, rol: Rol, celda: number, forma: number, dueno: Hilo): void {
    const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
    this.celda[s] = celda;
    this.dueno[s] = dueno;
    b.forma[i] = forma;
    b.marcas[i * MARCAS] = rol;
    b.marcas[i * MARCAS + USADO] = 1;
    if (celda !== -1) {
      this.siguiente[s] = Atomics.load(this.primero, celda);
      Atomics.store(this.primero, celda, puntero(s));
    }
    Atomics.store(b.marcas, i * MARCAS + ACTIVO, 1);
  }

  nuevo(rol: Rol, celda: number, forma: number): LoteRef {
    natural(rol, 'Rol', Rol.Cielo);
    natural(forma, 'Forma', UINT32_MAX);
    celda = this.celdaDe(celda, rol);
    if (celda !== -1 && this.op.terreno.duenoChunk[this.op.terreno.chunkDe(celda)] !== this.op.hilo) {
      throw new Error(`Celda ajena: ${celda}`);
    }
    if (celda !== -1 && (rol <= Rol.Aire || rol === Rol.Mar || rol === Rol.Cielo) && this.lotes(celda, rol, new Float64Array(0))) {
      throw new Error(`Lote de rol ${rol} duplicado en celda ${celda}.`);
    }
    const fisica = this.op.contenido?.reserve();
    let s: number;
    try { s = this.op.lotes.reserve(); }
    catch (error) {
      if (fisica !== undefined) this.op.contenido!.release(fisica);
      throw error;
    }
    puntero(s);
    const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
    if (b.marcas[i * MARCAS + USADO]) b.gen[i] = natural(b.gen[i] + 1, 'Generación de lote', GEN_MAX);
    if (fisica !== undefined) Atomics.store(this.fisicas!, s, puntero(fisica));
    this.instalar(s, rol, celda, forma, this.op.hilo);
    return refDe(s, b.gen[i]);
  }

  liberar(l: LoteRef): void {
    const s = this.propioSlot(l);
    const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
    const fisica = this.fisica(s), carga = this.bloqueContenido(fisica), local = fisica % LOTES_POR_BLOQUE;
    if (carga.calor[local] !== 0 || carga.esp[local * RANURAS] || carga.exceso[local]) {
      throw new Error(`No se puede liberar un lote con materia o calor: ${l}`);
    }
    Atomics.store(b.marcas, i * MARCAS + ACTIVO, 0);
    const celda = this.celda[s];
    if (celda !== -1) {
      let anterior = -1;
      for (let p = Atomics.load(this.primero, celda); p !== puntero(s); p = Atomics.load(this.siguiente, anterior)) {
        if (p === 0) throw new Error(`El lote ${l} no figura en la celda ${celda}.`);
        anterior = p - 1;
      }
      const sig = this.siguiente[s];
      if (anterior === -1) Atomics.store(this.primero, celda, sig);
      else Atomics.store(this.siguiente, anterior, sig);
    }
    if (this.fisicas) {
      Atomics.store(this.fisicas, s, 0);
      this.retirarFisicas.push(fisica);
    }
    if (b.gen[i] < GEN_MAX) this.retirar.push(s);
  }

  /** Una vez por tick en F0, con todos los dueños fuera de las fases de escritura. */
  barrera(): void {
    for (const s of this.retirar) this.op.lotes.release(s);
    for (const s of this.retirarExtra) this.op.desborde.release(s);
    for (const s of this.retirarFisicas) this.op.contenido!.release(s);
    this.retirar.length = 0;
    this.retirarExtra.length = 0;
    this.retirarFisicas.length = 0;
    this.turno = (this.turno + 1) % this.garantizados.length;
    this.garantizados[this.turno].clear();
    this.abonados[this.turno].clear();
  }

  vivo(l: LoteRef): boolean {
    if (!Number.isSafeInteger(l) || l < 0) return false;
    const s = slotDe(l);
    return s < this.op.lotes.slots && this.activo(s) && this.bloque(s).gen[s % LOTES_POR_BLOQUE] === genDe(l);
  }
  propio(l: LoteRef): boolean { return this.vivo(l) && this.duenoDe(slotDe(l)) === this.op.hilo; }
  adoptar(l: LoteRef): void {
    const s = this.vivoSlot(l);
    if (this.celda[s] !== -1) throw new Error(`Solo se adopta materia ligada a un organismo: ${l}`);
    this.dueno[s] = this.op.hilo;
  }

  private vivoSlot(l: LoteRef): number {
    if (!this.vivo(l)) throw new Error(`Lote caducado: ${l}`);
    return slotDe(l);
  }
  private propioLogico(l: LoteRef): number {
    const s = this.vivoSlot(l);
    if (this.duenoDe(s) !== this.op.hilo) throw new Error(`Lote ajeno: ${l}`);
    return s;
  }
  private propioSlot(l: LoteRef): number {
    const s = this.propioLogico(l);
    if (this.fisica(s) < 0) throw new Error(`Hay que reponer el lote aparcado antes de mutarlo: ${l}`);
    return s;
  }

  estaAparcado(l: LoteRef): boolean { return this.vivo(l) && this.fisica(slotDe(l)) < 0; }

  private paresFrios(s: number): Float64Array {
    const ref = refDe(s, this.bloque(s).gen[s % LOTES_POR_BLOQUE]);
    if (!this.op.leerFrio) throw new Error(`Falta el lector de la composición fría del lote ${ref}.`);
    return this.op.leerFrio(ref, this.celda[s]);
  }

  private ajustarSaldoFrio(parcial: readonly bigint[], sumar: boolean): void {
    const saldo = this.saldoFrio!;
    for (let i = 0; i < saldo.length; i++) saldo[i] += sumar ? parcial[i] : -parcial[i];
  }

  /** Solo en barrera, después de confirmar la copia durable. Valida la secuencia exacta antes de soltar memoria. */
  aparcar(l: LoteRef): void {
    if (!this.fisicas || !this.op.contenido) throw new Error('Falta la arena física de la materia fría.');
    const s = this.propioSlot(l), fisica = this.fisica(s), contenido = this.contenidoFisico(fisica, this.la);
    const esperado = contenido.pares(), guardado = this.paresFrios(s);
    if (esperado.length !== guardado.length || !esperado.every((v, i) => Object.is(v, guardado[i]))) {
      throw new Error(`La copia fría del lote ${l} no coincide con la composición residente.`);
    }
    const saldo = balancePares(contenido, this.sustancia);
    const previas = this.retirarExtra.length;
    this.escribirFisico(fisica, this.la.vaciar(), this.nuevasA);
    Atomics.store(this.fisicas, s, 0);
    this.ajustarSaldoFrio(saldo, true);
    for (let i = previas; i < this.retirarExtra.length; i++) this.op.desborde.release(this.retirarExtra[i]!);
    this.retirarExtra.length = previas;
    this.op.contenido.release(fisica);
  }

  /** Solo en F0, con espacio físico y de desborde reservado. Publica el enlace después de rellenar la composición. */
  reponer(l: LoteRef): void {
    if (!this.fisicas || !this.op.contenido) throw new Error('Falta la arena física de la materia fría.');
    const s = this.propioLogico(l);
    if (this.fisica(s) >= 0) return;
    const m = leerPares(this.paresFrios(s), this.la);
    const saldo = balancePares(m, this.sustancia);
    const fisica = this.op.contenido.reserve(), nuevas = this.nuevasA;
    nuevas.length = 0;
    try { this.reservarEn(fisica, m, nuevas); }
    catch (error) {
      for (const extra of nuevas) this.op.desborde.release(extra);
      nuevas.length = 0;
      this.op.contenido.release(fisica);
      throw error;
    }
    this.escribirFisico(fisica, m, nuevas);
    Atomics.store(this.fisicas, s, puntero(fisica));
    this.ajustarSaldoFrio(saldo, false);
  }

  lotes(celda: number, rol: Rol, destino: Float64Array): number {
    if (!Number.isSafeInteger(celda) || celda < 0 || celda >= this.primero.length) return 0;
    celda = this.celdaDe(celda, rol);
    let n = 0;
    let restantes = this.op.lotes.slots;
    for (let p = Atomics.load(this.primero, celda); p && restantes-- > 0; p = Atomics.load(this.siguiente, p - 1)) {
      const s = p - 1;
      const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
      if (this.activo(s) && b.marcas[i * MARCAS] === rol) {
        if (n < destino.length) destino[n] = refDe(s, b.gen[i]);
        n++;
      }
    }
    return n;
  }

  /** Lo que hay en la ranura s en `m`: sus ranuras y su desborde en orden, y el calor al final si no es 0. */
  private contenido(s: number, m: Lista): Lista {
    const fisica = this.fisica(s);
    if (fisica >= 0) return this.contenidoFisico(fisica, m);
    leerPares(this.paresFrios(s), m);
    // VMAT admite el calor en cualquier posición. La arena física siempre lo emite al final.
    const indice = m.indice(0), ultimo = m.n - 1;
    if (indice >= 0 && indice < ultimo) {
      const calor = m.q[indice]!;
      m.id.copyWithin(indice, indice + 1, m.n);
      m.q.copyWithin(indice, indice + 1, m.n);
      m.id[ultimo] = 0;
      m.q[ultimo] = calor;
    }
    return m;
  }

  private contenidoFisico(fisica: number, m: Lista): Lista {
    const b = this.bloqueContenido(fisica), i = fisica % LOTES_POR_BLOQUE, inicio = i * RANURAS;
    m.vaciar();
    for (let j = inicio; j < inicio + RANURAS; j++) {
      const id = b.esp[j]!;
      if (id !== 0) m.poner(id, b.cant[j]!);
    }
    let restantes = this.op.desborde.slots;
    for (let p = Atomics.load(b.exceso, i); p && restantes-- > 0; p = Atomics.load(this.extraSig, p - 1)) {
      const id = this.extraEsp[p - 1]!;
      if (id !== 0) m.poner(id, this.extraCant[p - 1]!);
    }
    const calor = b.calor[i]!;
    if (calor !== 0) m.poner(0, calor);
    return m;
  }
  especies(l: LoteRef, ids: Uint32Array, cantidades?: Float64Array): number {
    const s = this.vivoSlot(l), fisica = this.fisica(s);
    const limite = cantidades ? Math.min(ids.length, cantidades.length) : ids.length;
    let n = 0;
    if (fisica < 0) {
      const m = leerPares(this.paresFrios(s), this.la);
      for (let k = 0; k < m.n; k++) {
        const id = m.id[k]!;
        if (id === 0) continue;
        if (n < limite) {
          ids[n] = id;
          if (cantidades) cantidades[n] = m.q[k]!;
        }
        n++;
      }
      return n;
    }
    const b = this.bloqueContenido(fisica), i = fisica % LOTES_POR_BLOQUE, inicio = i * RANURAS;
    for (let j = inicio; j < inicio + RANURAS; j++) {
      const id = b.esp[j]!;
      if (id === 0) continue;
      if (n < limite) {
        ids[n] = id;
        if (cantidades) cantidades[n] = b.cant[j]!;
      }
      n++;
    }
    let p = Atomics.load(b.exceso, i);
    if (!p) return n;
    for (let restantes = this.op.desborde.slots; p && restantes-- > 0; p = Atomics.load(this.extraSig, p - 1)) {
      const id = this.extraEsp[p - 1]!;
      if (id === 0) continue;
      if (n < limite) {
        ids[n] = id;
        if (cantidades) cantidades[n] = this.extraCant[p - 1]!;
      }
      n++;
    }
    return n;
  }
  cuantos(l: LoteRef, id: SustanciaId): number {
    const s = this.vivoSlot(l);
    if (id === 0) return 0; // el calor no es una sustancia: `calor`
    const fisica = this.fisica(s);
    if (fisica < 0) return leerPares(this.paresFrios(s), this.la).get(id);
    const b = this.bloqueContenido(fisica), i = fisica % LOTES_POR_BLOQUE, inicio = i * RANURAS;
    for (let j = inicio; j < inicio + RANURAS; j++) if (b.esp[j] === id) return b.cant[j]!;
    let restantes = this.op.desborde.slots;
    for (let p = Atomics.load(b.exceso, i); p && restantes-- > 0; p = Atomics.load(this.extraSig, p - 1)) {
      if (this.extraEsp[p - 1] === id) return this.extraCant[p - 1]!;
    }
    return 0;
  }
  calor(l: LoteRef): number {
    const s = this.vivoSlot(l), fisica = this.fisica(s);
    if (fisica < 0) return leerPares(this.paresFrios(s), this.la).get(0);
    return this.bloqueContenido(fisica).calor[fisica % LOTES_POR_BLOQUE];
  }

  /** Reserva, antes de escribir nada, el desborde que les falta a estas composiciones: si no alcanza la memoria, ningún
   * lote cambia (un traslado a medias crearía o destruiría materia). Lo reservado y sin enlazar vuelve en barrera. */
  /** Para `m` en s (y `md` en d, si hay) en `nuevasA` (y `nuevasB`). */
  private reservar(s: number, m: Lista, d: number, md: Lista | null): void {
    this.nuevasA.length = 0;
    this.nuevasB.length = 0;
    try {
      this.reservarEn(this.fisica(s), m, this.nuevasA);
      if (md) this.reservarEn(this.fisica(d), md, this.nuevasB);
    } catch (error) {
      this.retirarExtra.push(...this.nuevasA, ...this.nuevasB);
      throw error;
    }
  }
  private reservarEn(fisica: number, m: Lista, nuevas: number[]): void {
    let faltan = m.especies() - RANURAS;
    for (let p = this.bloqueContenido(fisica).exceso[fisica % LOTES_POR_BLOQUE]; p && faltan > 0; p = this.extraSig[p - 1]) faltan--;
    while (nuevas.length < faltan) {
      nuevas.push(this.op.desborde.reserve());
      puntero(nuevas[nuevas.length - 1]);
    }
  }

  private escribirUno(s: number, m: Lista): void {
    this.reservar(s, m, -1, null);
    this.escribir(s, m, this.nuevasA);
  }

  private escribir(s: number, m: Lista, nuevas: number[]): void {
    this.escribirFisico(this.fisica(s), m, nuevas);
  }

  private escribirFisico(fisica: number, m: Lista, nuevas: number[]): void {
    const b = this.bloqueContenido(fisica), local = fisica % LOTES_POR_BLOQUE;
    let i = local * RANURAS;
    const fin = i + RANURAS;
    let p = b.exceso[local];
    let anterior = -1;
    for (let k = 0; k < m.n; k++) {
      const id = m.id[k]!, q = m.q[k]!;
      if (id === 0) continue;
      if (i < fin) {
        b.esp[i] = id;
        b.cant[i++] = q;
        continue;
      }
      let extra: number;
      if (p === 0) extra = nuevas.pop()!;
      else {
        extra = p - 1;
        p = this.extraSig[extra];
      }
      this.extraEsp[extra] = id;
      this.extraCant[extra] = q;
      this.enlazarExtra(b.exceso, local, anterior, puntero(extra));
      anterior = extra;
    }
    this.enlazarExtra(b.exceso, local, anterior, 0);
    while (p !== 0) {
      const extra = p - 1;
      p = this.extraSig[extra];
      this.extraSig[extra] = 0;
      this.retirarExtra.push(extra);
    }
    b.esp.fill(0, i, fin);
    b.cant.fill(0, i, fin);
    b.calor[local] = m.get(0);
  }

  /** Enlaza el desborde; un enlace que ya vale p no se vuelve a escribir (el almacén atómico es lo caro). */
  private enlazarExtra(exceso: Uint32Array, i: number, anterior: number, p: number): void {
    if (anterior === -1) {
      if (exceso[i] !== p) Atomics.store(exceso, i, p);
    } else if (this.extraSig[anterior] !== p) Atomics.store(this.extraSig, anterior, p);
  }

  formar(l: LoteRef, forma: number): void {
    const s = this.propioSlot(l);
    this.bloque(s).forma[s % LOTES_POR_BLOQUE] = natural(forma, 'Forma', UINT32_MAX);
  }

  private transferir(de: number, a: number, origen: Lista, parte: Lista): void {
    if (de === a || parte.n === 0) return;
    if (this.transferirSinReordenar(de, a, origen, parte)) return;
    const destino = this.contenido(a, this.lb);
    for (let k = 0; k < parte.n; k++) {
      const id = parte.id[k]!, q = parte.q[k]!;
      origen.sumar(id, -q);
      destino.sumar(id, q);
    }
    this.reservar(de, origen, a, destino);
    this.escribir(de, origen, this.nuevasA);
    this.escribir(a, destino, this.nuevasB);
  }

  /** En la arena fusionada los llamadores ya validaron ambas ranuras y su dueño.
   * Si se conserva la composición en línea, solo cambian los dos cuantos y el calor ya seleccionado. */
  private transferirSinReordenar(de: number, a: number, origen: Lista, parte: Lista): boolean {
    const id = parte.id[0]!;
    if (this.fisicas || id === 0 || (parte.n !== 1 && (parte.n !== 2 || parte.id[1] !== 0))) return false;
    const cuantos = parte.q[0]!, indiceOrigen = origen.indice(id);
    const cantidadOrigen = origen.q[indiceOrigen]! - cuantos;
    if (!(cantidadOrigen > 0)) return false;

    const bOrigen = this.bloqueContenido(de), bDestino = this.bloqueContenido(a);
    const localOrigen = de % LOTES_POR_BLOQUE, localDestino = a % LOTES_POR_BLOQUE;
    if (bOrigen.exceso[localOrigen] || bDestino.exceso[localDestino]) return false;
    const ranuraOrigen = localOrigen * RANURAS + indiceOrigen;
    const inicioDestino = localDestino * RANURAS, finDestino = inicioDestino + RANURAS;
    let ranuraDestino = inicioDestino;
    while (ranuraDestino < finDestino && bDestino.esp[ranuraDestino] !== id) ranuraDestino++;
    if (ranuraDestino === finDestino) return false;

    // Las ranuras en línea son compactas y el calor va al final de origen. Validar todo antes de tocar columnas.
    const nuevaCantidadOrigen = natural(cantidadOrigen, 'Cantidad');
    const nuevaCantidadDestino = natural(bDestino.cant[ranuraDestino]! + cuantos, 'Cantidad');
    if (parte.n === 2) {
      const calor = parte.q[1]!;
      const nuevoCalorOrigen = natural(bOrigen.calor[localOrigen]! - calor, 'Calor');
      const nuevoCalorDestino = natural(bDestino.calor[localDestino]! + calor, 'Calor');
      bOrigen.calor[localOrigen] = nuevoCalorOrigen;
      bDestino.calor[localDestino] = nuevoCalorDestino;
    }
    bOrigen.cant[ranuraOrigen] = nuevaCantidadOrigen;
    bDestino.cant[ranuraDestino] = nuevaCantidadDestino;
    return true;
  }

  mover({ de, a, esp, cuantos }: Traslado): number {
    const s = this.propioSlot(de), d = this.propioSlot(a);
    natural(esp, 'Sustancia', UINT32_MAX);
    if (!esp) throw new Error('Mover calor requiere moverCalor.');
    natural(cuantos, 'Cuantos');
    const origen = this.contenido(s, this.la);
    const usar = Math.min(cuantos, origen.get(esp));
    if (s === d || !usar) return 0;
    const parte = this.lp.vaciar();
    parte.poner(esp, usar);
    this.transferir(s, d, origen, parte);
    return usar;
  }

  moverCalor(de: LoteRef, a: LoteRef, j: number): number {
    const s = this.propioSlot(de), d = this.propioSlot(a);
    const origenFisico = this.fisica(s), destinoFisico = this.fisica(d);
    const origen = this.bloqueContenido(origenFisico).calor, destino = this.bloqueContenido(destinoFisico).calor;
    const i = origenFisico % LOTES_POR_BLOQUE, k = destinoFisico % LOTES_POR_BLOQUE;
    const usar = Math.min(natural(j, 'Calor'), origen[i]);
    if (s === d || !usar) return 0;
    const calor = natural(destino[k] + usar, 'Calor');
    origen[i] -= usar;
    destino[k] = calor;
    return usar;
  }

  /** Lo que el pedido toma de `origen`, en `parte`, con su parte del calor: ⌊calor·átomos tomados/átomos del lote⌋. */
  private seleccionar(origen: Lista, p: Pedido, parte: Lista): Lista {
    let faltan = natural(p.cuantos, 'Cuantos solicitados');
    parte.vaciar();
    if (p.parte === Parte.Todo) {
      for (let k = 0; k < origen.n; k++) parte.poner(origen.id[k]!, origen.q[k]!);
      return parte;
    }
    if (p.parte !== Parte.Exacta && p.parte !== Parte.Agua && p.parte !== Parte.Digerible) {
      throw new Error(`Selección de materia inválida: ${p.parte}`);
    }
    // En doble: términos ≥ 0, así que si el total queda bajo 2⁵³ todas las sumas fueron exactas.
    let atomos = 0, tomados = 0;
    for (let k = 0; k < origen.n; k++) {
      const id = origen.id[k]!, q = origen.q[k]!;
      if (id === 0) continue;
      const porCuanto = this.atomosDe(id);
      atomos += q * porCuanto;
      const coincide = p.parte === Parte.Exacta ? id === p.esp : p.parte === Parte.Agua ? id === this.op.agua
        : this.op.digerible(this.sustancia(id), p.kappa ?? KAPPA_BASE) > 0;
      if (coincide && faltan > 0) {
        const n = Math.min(q, faltan);
        faltan -= n;
        parte.poner(id, n);
        tomados += n * porCuanto;
      }
    }
    const calor = origen.get(0);
    if (calor && tomados) {
      const ct = calor * tomados;
      parte.sumar(0, atomos < DOS53 && ct < DOS53 && ct + atomos < DOS53 ? Math.floor(ct / atomos)
        : Number(BigInt(calor) * this.atomosBig(parte) / this.atomosBig(origen)));
    }
    return parte;
  }
  private atomosBig(m: Lista): bigint {
    let a = 0n;
    for (let k = 0; k < m.n; k++) if (m.id[k] !== 0) a += BigInt(m.q[k]!) * BigInt(this.atomosDe(m.id[k]!));
    return a;
  }

  moverParte(de: LoteRef, a: LoteRef, p: Pedido): number {
    const s = this.propioSlot(de), d = this.propioSlot(a);
    const origen = this.contenido(s, this.la);
    const parte = this.seleccionar(origen, p, this.lp);
    if (s === d) return 0;
    let cuantos = 0;
    for (let k = 0; k < parte.n; k++) if (parte.id[k] !== 0) cuantos = natural(cuantos + parte.q[k]!, 'Cuantos movidos');
    this.transferir(s, d, origen, parte);
    return cuantos;
  }

  aplicar(l: LoteRef, e: Ecuacion, veces: number): number {
    const s = this.propioSlot(l);
    natural(veces, 'Veces');
    if (!Number.isSafeInteger(e.dH)) throw new Error(`Energía de reacción inválida: ${e.dH}`);
    const { entradas, salidas } = this.grupos.get(e) ?? this.agrupar(e);
    const m = this.contenido(s, this.la);
    const calor = m.get(0);
    for (let k = 0; k < entradas.length; k += 2) veces = Math.min(veces, cociente(m.get(entradas[k]!), entradas[k + 1]!));
    if (e.dH > 0) veces = Math.min(veces, cociente(calor, e.dH));
    if (!veces) return 0;
    for (let k = 0; k < entradas.length; k += 2) m.sumar(entradas[k]!, -veces * entradas[k + 1]!);
    for (let k = 0; k < salidas.length; k += 2) m.sumar(salidas[k]!, natural(veces * salidas[k + 1]!, 'Producción'));
    m.sumar(0, -veces * e.dH);
    this.escribirUno(s, m);
    return veces;
  }

  /** Agrupa por sustancia las entradas y salidas de `e` y comprueba (en bigint, una vez por ecuación) que se balancea. */
  private agrupar(e: Ecuacion): Grupos {
    const grupos = (partes: Ecuacion['entradas']) => {
      const m = new Lista();
      for (const { id, nu } of partes) {
        if (!natural(id, 'Sustancia', UINT32_MAX) || !natural(nu, 'Coeficiente')) throw new Error('Coeficiente o sustancia nulos.');
        m.sumar(id, nu);
      }
      return m;
    };
    const entradas = grupos(e.entradas), salidas = grupos(e.salidas);
    const antes = balancePares(entradas, this.sustancia), despues = balancePares(salidas, this.sustancia);
    if (antes.some((n, i) => despues[i] - n !== (i === ENERGIA ? BigInt(e.dH) : 0n))) {
      throw new Error('La ecuación de materia no está balanceada.');
    }
    const g = { entradas: entradas.pares(), salidas: salidas.pares() };
    this.grupos.set(e, g);
    return g;
  }

  private asentar(s: number, m: Lista, pares: Lista, cuenta: Float64Array, signo: 1 | -1, cambio: 1 | -1): void {
    for (let k = 0; k < pares.n; k++) m.sumar(pares.id[k]!, cambio * pares.q[k]!);
    const asiento = balanceDoble(pares.id, pares.q, pares.n, this.sustancia, this.balance)
      ? prepararAsientoDoble(cuenta, this.balance, signo, this.asiento)
      : prepararAsiento(cuenta, balancePares(pares, this.sustancia), signo);
    if (pares.n) this.escribirUno(s, m);
    cuenta.set(asiento);
  }

  garantizar(l: LoteRef, p: Pedido, libro: Libro): Float64Array {
    const s = this.propioSlot(l);
    const m = this.contenido(s, this.la);
    const parte = this.seleccionar(m, p, this.lp);
    this.asentar(s, m, parte, libro.enVuelo, 1, -1);
    return parte.pares();
  }

  abonar(l: LoteRef, garantia: Float64Array, libro: Libro): void {
    const s = this.propioSlot(l);
    this.asentar(s, this.contenido(s, this.la), leerPares(garantia, this.lp), libro.enVuelo, -1, 1);
  }

  garantizarUna(nonce: number, l: LoteRef, p: Pedido, libro: Libro): Float64Array | null {
    natural(nonce, 'Nonce');
    if (this.garantizados.some(vistos => vistos.has(nonce))) return null;
    const g = this.garantizar(l, p, libro);
    this.garantizados[this.turno].add(nonce);
    return g;
  }

  /** M5 enruta cada nonce a un único dueño de abono, incluidos los retornos a Suelo. */
  abonarUna(nonce: number, l: LoteRef, garantia: Float64Array, libro: Libro): boolean {
    natural(nonce, 'Nonce');
    if (this.abonados.some(vistos => vistos.has(nonce))) return false;
    this.abonar(l, garantia, libro);
    this.abonados[this.turno].add(nonce);
    return true;
  }

  fuente(l: LoteRef, pares: Float64Array, libro: Libro): void {
    const s = this.propioSlot(l);
    this.asentar(s, this.contenido(s, this.la), leerPares(pares, this.lp), libro.fuentes, 1, 1);
  }

  sumidero(l: LoteRef, pares: Float64Array, libro: Libro): Float64Array {
    const s = this.propioSlot(l);
    const m = this.contenido(s, this.la);
    const salida = leerPares(pares, this.lp);
    // Cada par baja a lo que hay; el que queda a 0 sale y el siguiente ocupa su sitio.
    for (let k = 0; k < salida.n;) {
      const n = salida.n, id = salida.id[k]!, q = salida.q[k]!;
      salida.sumar(id, Math.min(q, m.get(id)) - q);
      if (salida.n === n) k++;
    }
    this.asentar(s, m, salida, libro.sumideros, 1, -1);
    return salida.pares();
  }

  vista(l: LoteRef): VistaLote {
    const s = this.vivoSlot(l);
    const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
    const forma = b.forma[i], fisica = formaDeCodigo(forma);
    const m = this.contenido(s, this.la), partes: { esp: Readonly<Sustancia>; q: number }[] = [];
    for (let k = 0; k < m.n; k++) if (m.id[k] !== 0) partes.push({ esp: this.sustancia(m.id[k]!), q: m.q[k]! });
    const atomos = partes.reduce((total, { esp, q }) => total + q * esp.atomos.reduce((a, b) => a + b, 0), 0);
    const T = atomos ? m.get(0) / (CAPACIDAD_ATOMO * atomos) : 0;
    let masa = 0, energia = 0, digerible = 0, agua = 0, principal = 0, masaPrincipal = 0;
    let volumen = 0, rigido = 0, dura = 0, tenaz = 0, permeable = 0, conductancia = 0;
    const color = [0, 0, 0];
    const fases = [0, 0, 0];
    for (const { esp, q } of partes) {
      const { prop, id } = esp;
      const m = q * esp.masa / 1e6;
      const fase = T < prop.tFusion ? 0 : T < prop.tEbullicion ? 1 : 2;
      const v = fase === 2 ? q * R * T / 101.325 : m / prop.densidad;
      fases[fase] += v;
      volumen += v;
      masa += m;
      energia += q * prop.qOxidacion;
      digerible += q * this.op.digerible(esp, KAPPA_BASE);
      if (id === this.op.agua) agua = q;
      if (m > masaPrincipal) { principal = id; masaPrincipal = m; }
      if (fase === 0 && prop.dureza > 0) {
        rigido += v;
        dura += v * prop.dureza;
      }
      tenaz += v * prop.tenacidad;
      permeable += fase === 2 ? v : 0;
      conductancia += fase === 0 ? v : 0;
      for (let i = 0; i < color.length; i++) color[i] += m * (prop.color >> ((2 - i) * 8) & 255);
    }
    const fase = fases.filter(v => v > 0).length > 1 ? 3 : Math.max(0, fases.findIndex(v => v > 0)) as 0 | 1 | 2;
    return { masa, T, fase, dureza: rigido && rigido >= PERCOLACION * volumen ? dura / rigido : 0,
      tenacidad: volumen ? tenaz / volumen : 0, sellado: volumen && forma ? (1 - fisica.hueco) * (1 - permeable / volumen) : 0,
      aislamiento: volumen ? 1 - conductancia / volumen : 0, energia, digerible, agua, forma, principal,
      color: masa ? color.reduce((rgb, c) => rgb * 256 + Math.round(c / masa), 0) : 0 };
  }

  private muestraDeRanura(s: number): LoteGuardado {
    const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
    return { ref: refDe(s, b.gen[i]), celda: this.celda[s], rol: b.marcas[i * MARCAS] as Rol, forma: b.forma[i],
      dueno: this.duenoDe(s), pares: this.contenido(s, this.la).pares() };
  }

  muestra(ref: LoteRef): LoteGuardado { return this.muestraDeRanura(this.vivoSlot(ref)); }

  *muestras(): IterableIterator<LoteGuardado> {
    for (let s = 0; s < this.op.lotes.slots; s++) if (this.activo(s)) yield this.muestraDeRanura(s);
  }

  /** Conserva la primera visita por ranura. El archivo aporta el tamaño de las composiciones frías. */
  *medirComposiciones(): IterableIterator<{ celda: number; pares: number | null }> {
    for (let s = 0; s < this.op.lotes.slots; s++) if (this.activo(s)) {
      const fisica = this.fisica(s);
      yield { celda: this.celda[s]!, pares: fisica < 0 ? null : this.contenidoFisico(fisica, this.la).n };
    }
  }

  /** En barrera. Los enlaces de celda dan pertenencia, y el orden canónico lo da la ranura lógica. */
  *muestrasDePagina(pagina: number): IterableIterator<LoteGuardado> {
    if (pagina === -1) {
      for (let s = 0; s < this.op.lotes.slots; s++) if (this.celda[s] === -1 && this.activo(s)) yield this.muestraDeRanura(s);
      return;
    }
    const ranuras: number[] = [];
    const inicio = pagina * CELDAS_PAGINA, fin = inicio + CELDAS_PAGINA;
    for (let celda = inicio; celda < fin; celda++) {
      let restantes = this.op.lotes.slots;
      for (let p = Atomics.load(this.primero, celda); p; p = Atomics.load(this.siguiente, p - 1)) {
        if (restantes-- === 0 || this.celda[p - 1] !== celda) throw new Error(`Enlace inválido de lotes en celda ${celda}.`);
        if (this.activo(p - 1)) ranuras.push(p - 1);
      }
    }
    ranuras.sort((a, b) => a - b);
    for (const s of ranuras) yield this.muestraDeRanura(s);
  }

  *libres(): IterableIterator<LoteRef> {
    for (let s = 0; s < this.op.lotes.slots; s++) if (!this.activo(s)) {
      yield refDe(s, this.bloque(s).gen[s % LOTES_POR_BLOQUE]);
    }
  }

  /** Todos los lotes vivos y las ranuras retiradas, para el punto de control (en barrera). La celda va tal
   * como la guarda la arena (la de `Terreno.celda`; el aire, en la primera celda de su página). */
  guardar(): { lotes: LoteGuardado[]; libres: LoteRef[] } {
    return { lotes: Array.from(this.muestras()), libres: Array.from(this.libres()) };
  }

  /** Σ de todos los lotes vivos, de todos los hilos (laboratorio y pruebas). */
  saldo(): bigint[] { return this.sumar(false); }

  saldoPropio(): bigint[] { return this.sumar(true); }

  private sumar(soloPropios: boolean): bigint[] {
    const saldo = this.saldoFrio?.slice() ?? Array<bigint>(NE + 1).fill(0n);
    for (let s = 0; s < this.op.lotes.slots; s++) if (this.activo(s) && (!soloPropios || this.duenoDe(s) === this.op.hilo)) {
      const fisica = this.fisica(s);
      if (fisica < 0) continue;
      const parcial = balancePares(this.contenidoFisico(fisica, this.la), this.sustancia);
      for (let i = 0; i < saldo.length; i++) saldo[i] += parcial[i];
    }
    return saldo;
  }

  cargar(lotes: readonly LoteGuardado[], libres: readonly LoteRef[]): void {
    if (this.op.lotes.slots !== 0) throw new Error('La carga de materia exige una arena vacía.');
    const porSlot = new Map(lotes.map(l => [slotDe(l.ref), l]));
    const retirados = new Map(libres.map(ref => [slotDe(ref), ref]));
    this.cargarPorRanura(lotes.length + libres.length, s => porSlot.get(s) ?? retirados.get(s));
  }

  /** Instala en el mismo orden de encadenado que la carga desde arrays. Si `fria` devuelve true, el llamador ya
   * archivó la composición exacta de ese lote bajo `leerFrio`. La carga no reserva espacio físico para esos lotes. */
  cargarPorRanura(cantidad: number, leer: (ranura: number) => LoteGuardado | LoteRef | undefined,
    fria?: (lote: LoteGuardado) => boolean): void {
    if (this.op.lotes.slots !== 0) throw new Error('La carga de materia exige una arena vacía.');
    let primerLibre = cantidad, ultimoLibre = -1;
    for (let s = 0; s < cantidad; s++) {
      const lote = leer(s);
      if (lote === undefined) throw new Error(`Falta la ranura ${s} de materia.`);
      const celda = typeof lote === 'number' ? -1 : this.celdaDe(lote.celda, lote.rol);
      const saldoFrio = typeof lote !== 'number' && fria?.(lote) ? this.saldoDeCargaFria(s, lote, celda) : null;
      if (this.op.lotes.reserve() !== s) throw new Error('Ranuras de materia no consecutivas durante la carga.');
      const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
      if (typeof lote === 'number') {
        const gen = genDe(lote);
        b.gen[i] = gen;
        b.marcas[i * MARCAS + USADO] = 1;
        if (gen < GEN_MAX) {
          primerLibre = Math.min(primerLibre, s);
          ultimoLibre = s;
        }
      } else {
        b.gen[i] = genDe(lote.ref);
        if (saldoFrio) this.ajustarSaldoFrio(saldoFrio, true);
        else {
          if (this.fisicas) Atomics.store(this.fisicas, s, puntero(this.op.contenido!.reserve()));
          this.escribirUno(s, leerPares(lote.pares, this.lp));
        }
        this.instalar(s, lote.rol, celda, lote.forma, lote.dueno);
      }
    }
    // Se devuelven después de asignar todas las ranuras. El asignador LIFO las reutiliza en orden descendente.
    for (let s = primerLibre; s <= ultimoLibre; s++) {
      const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
      if (b.marcas[i * MARCAS + ACTIVO] === 0 && b.gen[i] < GEN_MAX) this.op.lotes.release(s);
    }
  }

  private saldoDeCargaFria(s: number, lote: LoteGuardado, celda: number): bigint[] {
    if (!this.saldoFrio || !this.fisicas) throw new Error('La carga fría requiere una arena física y un lector.');
    if (slotDe(natural(lote.ref, 'Referencia de lote')) !== s || celda < 0
      || this.op.terreno.duenoChunk[this.op.terreno.chunkDe(celda)] !== this.op.hilo) {
      throw new Error(`El lote ${lote.ref} no identifica una ranura propia con celda para la carga fría.`);
    }
    return balancePares(leerPares(lote.pares, this.lp), this.sustancia);
  }
}
