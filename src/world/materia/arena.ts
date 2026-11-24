import { formaDeCodigo, type SustanciaId } from '../../shared/materia.js';
import { CAPACIDAD_ATOMO, KAPPA0, NE, PERCOLACION, R } from '../../shared/naturaleza.js';
import { genDe, refDe, slotDe, type Hilo, type Terreno } from '../motor/contratos.js';
import type { PageArena } from '../soa/arena.js';
import type { LoteGuardado } from './checkpoint.js';
import { balancePares, prepararAsiento } from './libro.js';
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
  terreno: Pick<Terreno, 'chunkDe' | 'duenoChunk'>;
  quimica: Pick<ServicioQuimico, 'sustancia'>;
  hilo: Hilo;
  agua: SustanciaId;
  digerible: (s: Readonly<Sustancia>, kappa: NonNullable<Pedido['kappa']>) => number;
}

type Cantidades = Map<SustanciaId, number>; // id 0: calor
const RANURAS = 8;
const MARCAS = 4;
const BYTES_POR_LOTE = 120;
const ACTIVO = 1;
const USADO = 2; // Distingue la primera asignación de la reutilización de una ranura.
const GEN_MAX = genDe(Number.MAX_SAFE_INTEGER);
const UINT32_MAX = 0xffffffff;
const CELDAS_PAGINA = 256;
const KAPPA_BASE = [KAPPA0, KAPPA0, KAPPA0] as const;

function natural(n: number, nombre: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new RangeError(`${nombre} inválido: ${n}`);
  return n;
}
const puntero = (slot: number) => natural(slot + 1, 'Puntero de materia', UINT32_MAX);
const aPares = (m: Cantidades) => Float64Array.from([...m].flat());
function sumar(m: Cantidades, id: SustanciaId, delta: number): void {
  const total = natural((m.get(id) ?? 0) + delta, id === 0 ? 'Calor' : 'Cantidad');
  if (total === 0) m.delete(id);
  else m.set(id, total);
}

function leerPares(pares: Float64Array): Cantidades {
  if (pares.length % 2 !== 0) throw new Error('Pares de materia incompletos.');
  const m: Cantidades = new Map();
  for (let i = 0; i < pares.length; i += 2) {
    sumar(m, natural(pares[i], 'Sustancia', UINT32_MAX), natural(pares[i + 1], 'Cantidad'));
  }
  return m;
}

function columnasLote(bytes: Uint8Array, bloque: number) {
  const n = LOTES_POR_BLOQUE;
  const base = bytes.byteOffset + bloque * n * BYTES_POR_LOTE;
  const memoria = bytes.buffer;
  return {
    esp: new Uint32Array(memoria, base, n * RANURAS),
    cant: new Float64Array(memoria, base + 32 * n, n * RANURAS),
    calor: new Float64Array(memoria, base + 96 * n, n),
    exceso: new Uint32Array(memoria, base + 104 * n, n),
    marcas: new Uint8Array(memoria, base + 108 * n, n * MARCAS),
    forma: new Uint32Array(memoria, base + 112 * n, n),
    gen: new Uint32Array(memoria, base + 116 * n, n),
  };
}

export class ArenaLotes implements ArenaMateria {
  private readonly datos: Uint8Array;
  private readonly bloques: ReturnType<typeof columnasLote>[] = [];
  private readonly celda: Float64Array;
  private readonly dueno: Uint32Array;
  private readonly siguiente: Uint32Array;
  private readonly primero: Uint32Array;
  private readonly extraEsp: Uint32Array;
  private readonly extraCant: Float64Array;
  private readonly extraSig: Uint32Array;
  private readonly retirar: number[] = [];
  private readonly retirarExtra: number[] = [];
  // I-B: una garantía se resuelve en dos ticks. Las tres cubetas incluyen el tick en curso.
  private readonly garantizados = [new Set<number>(), new Set<number>(), new Set<number>()];
  private readonly abonados = [new Set<number>(), new Set<number>(), new Set<number>()];
  private turno = 0;

  constructor(private readonly op: OpcionesArena) {
    const { lotes, paginas, desborde } = op;
    natural(op.hilo, 'Hilo', UINT32_MAX);
    // M1 reserva bloques completos en F0. Al crecer el SAB las columnas anteriores mantienen su desplazamiento.
    this.datos = lotes.field('materia.lotes', Uint8Array, BYTES_POR_LOTE);
    if (!(this.datos.buffer instanceof SharedArrayBuffer) || !('growable' in this.datos.buffer && this.datos.buffer.growable)) {
      throw new Error('Los lotes exigen un SharedArrayBuffer crecible.');
    }
    this.celda = lotes.field('materia.celda', Float64Array, 1);
    this.dueno = lotes.field('materia.dueno', Uint32Array, 1);
    this.siguiente = lotes.field('materia.siguiente', Uint32Array, 1);
    this.primero = paginas.field('materia.primero', Uint32Array, CELDAS_PAGINA);
    this.extraEsp = desborde.field('materia.esp', Uint32Array, 1);
    this.extraCant = desborde.field('materia.cant', Float64Array, 1);
    this.extraSig = desborde.field('materia.siguiente', Uint32Array, 1);
  }

  private sustancia = (id: SustanciaId): Readonly<Sustancia> => this.op.quimica.sustancia(id);

  private bloque(s: number) {
    const i = Math.floor(s / LOTES_POR_BLOQUE);
    if (i >= this.bloques.length && this.datos.byteLength < (i + 1) * LOTES_POR_BLOQUE * BYTES_POR_LOTE) {
      throw new Error(`Falta el bloque ${i} de materia que debe reservarse en F0.`);
    }
    return this.bloques[i] ??= columnasLote(this.datos, i);
  }

  private celdaDe(celda: number, rol: Rol): number {
    if (celda === -1) return celda;
    natural(celda, 'Celda');
    if (celda >= this.primero.length) throw new RangeError(`Celda material fuera del terreno: ${celda}`);
    return rol === Rol.Aire ? this.op.terreno.chunkDe(celda) * CELDAS_PAGINA : celda;
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
    natural(rol, 'Rol', Rol.Pieza);
    natural(forma, 'Forma', UINT32_MAX);
    celda = this.celdaDe(celda, rol);
    if (celda !== -1 && this.op.terreno.duenoChunk[this.op.terreno.chunkDe(celda)] !== this.op.hilo) {
      throw new Error(`Celda ajena: ${celda}`);
    }
    if (celda !== -1 && rol <= Rol.Aire && this.lotes(celda, rol, new Float64Array(0))) {
      throw new Error(`Lote de rol ${rol} duplicado en celda ${celda}.`);
    }
    const s = this.op.lotes.reserve();
    puntero(s);
    const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
    if (b.marcas[i * MARCAS + USADO]) b.gen[i] = natural(b.gen[i] + 1, 'Generación de lote', GEN_MAX);
    this.instalar(s, rol, celda, forma, this.op.hilo);
    return refDe(s, b.gen[i]);
  }

  liberar(l: LoteRef): void {
    const s = this.propioSlot(l);
    const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
    if (b.calor[i] !== 0 || b.esp[i * RANURAS] || b.exceso[i]) {
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
    if (b.gen[i] < GEN_MAX) this.retirar.push(s);
  }

  /** Una vez por tick en F0, con todos los dueños fuera de las fases de escritura. */
  barrera(): void {
    for (const s of this.retirar) this.op.lotes.release(s);
    for (const s of this.retirarExtra) this.op.desborde.release(s);
    this.retirar.length = 0;
    this.retirarExtra.length = 0;
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
  private propioSlot(l: LoteRef): number {
    const s = this.vivoSlot(l);
    if (this.duenoDe(s) !== this.op.hilo) throw new Error(`Lote ajeno: ${l}`);
    return s;
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

  private *componentes(s: number): IterableIterator<[SustanciaId, number]> {
    const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
    const inicio = i * RANURAS;
    for (let j = inicio; j < inicio + RANURAS; j++) {
      const id = b.esp[j];
      if (id !== 0) yield [id, b.cant[j]];
    }
    let restantes = this.op.desborde.slots;
    for (let p = Atomics.load(b.exceso, i); p && restantes-- > 0; p = Atomics.load(this.extraSig, p - 1)) {
      const id = this.extraEsp[p - 1];
      if (id !== 0) yield [id, this.extraCant[p - 1]];
    }
  }
  private contenido(s: number): Cantidades {
    const m = new Map(this.componentes(s));
    const calor = this.bloque(s).calor[s % LOTES_POR_BLOQUE];
    if (calor !== 0) m.set(0, calor);
    return m;
  }
  especies(l: LoteRef, ids: Uint32Array): number {
    let n = 0;
    for (const [id] of this.componentes(this.vivoSlot(l))) {
      if (n < ids.length) ids[n] = id;
      n++;
    }
    return n;
  }
  cuantos(l: LoteRef, id: SustanciaId): number {
    for (const [esp, cuantos] of this.componentes(this.vivoSlot(l))) if (esp === id) return cuantos;
    return 0;
  }
  calor(l: LoteRef): number {
    const s = this.vivoSlot(l);
    return this.bloque(s).calor[s % LOTES_POR_BLOQUE];
  }

  private escribir(s: number, m: Cantidades): void {
    const b = this.bloque(s), local = s % LOTES_POR_BLOQUE;
    let i = local * RANURAS;
    const fin = i + RANURAS;
    let p = b.exceso[local];
    let anterior = -1;
    for (const [id, q] of m) {
      if (id === 0) continue;
      if (i < fin) {
        b.esp[i] = id;
        b.cant[i++] = q;
        continue;
      }
      const extra = p === 0 ? this.op.desborde.reserve() : p - 1;
      p = this.extraSig[extra];
      this.extraEsp[extra] = id;
      this.extraCant[extra] = q;
      this.enlazarExtra(s, anterior, puntero(extra));
      anterior = extra;
    }
    this.enlazarExtra(s, anterior, 0);
    while (p !== 0) {
      const extra = p - 1;
      p = this.extraSig[extra];
      this.extraSig[extra] = 0;
      this.retirarExtra.push(extra);
    }
    b.esp.fill(0, i, fin);
    b.cant.fill(0, i, fin);
    b.calor[local] = m.get(0) ?? 0;
  }

  private enlazarExtra(s: number, anterior: number, p: number): void {
    if (anterior === -1) Atomics.store(this.bloque(s).exceso, s % LOTES_POR_BLOQUE, p);
    else Atomics.store(this.extraSig, anterior, p);
  }

  formar(l: LoteRef, forma: number): void {
    const s = this.propioSlot(l);
    this.bloque(s).forma[s % LOTES_POR_BLOQUE] = natural(forma, 'Forma', UINT32_MAX);
  }

  private transferir(de: number, a: number, origen: Cantidades, parte: Cantidades): void {
    if (de === a || parte.size === 0) return;
    const destino = this.contenido(a);
    for (const [id, q] of parte) {
      sumar(origen, id, -q);
      sumar(destino, id, q);
    }
    this.escribir(de, origen);
    this.escribir(a, destino);
  }

  mover({ de, a, esp, cuantos }: Traslado): number {
    const s = this.propioSlot(de), d = this.propioSlot(a);
    natural(esp, 'Sustancia', UINT32_MAX);
    if (!esp) throw new Error('Mover calor requiere moverCalor.');
    natural(cuantos, 'Cuantos');
    const origen = this.contenido(s);
    const usar = Math.min(cuantos, origen.get(esp) ?? 0);
    if (s === d || !usar) return 0;
    this.transferir(s, d, origen, new Map([[esp, usar]]));
    return usar;
  }

  moverCalor(de: LoteRef, a: LoteRef, j: number): number {
    const s = this.propioSlot(de), d = this.propioSlot(a);
    const origen = this.bloque(s).calor, destino = this.bloque(d).calor;
    const i = s % LOTES_POR_BLOQUE, k = d % LOTES_POR_BLOQUE;
    const usar = Math.min(natural(j, 'Calor'), origen[i]);
    if (s === d || !usar) return 0;
    const calor = natural(destino[k] + usar, 'Calor');
    origen[i] -= usar;
    destino[k] = calor;
    return usar;
  }

  private seleccionar(origen: Cantidades, p: Pedido): Cantidades {
    let faltan = natural(p.cuantos, 'Cuantos solicitados');
    if (p.parte === Parte.Todo) return new Map(origen);
    const parte: Cantidades = new Map();
    let atomos = 0n, tomados = 0n;
    if (p.parte !== Parte.Exacta && p.parte !== Parte.Agua && p.parte !== Parte.Digerible) {
      throw new Error(`Selección de materia inválida: ${p.parte}`);
    }
    for (const [id, q] of origen) {
      if (id === 0) continue;
      const s = this.sustancia(id);
      const porCuanto = BigInt(s.atomos.reduce((suma, n) => suma + n, 0));
      atomos += BigInt(q) * porCuanto;
      const coincide = p.parte === Parte.Exacta ? id === p.esp : p.parte === Parte.Agua ? id === this.op.agua
        : this.op.digerible(s, p.kappa ?? KAPPA_BASE) > 0;
      if (coincide && faltan > 0) {
        const n = Math.min(q, faltan);
        faltan -= n;
        parte.set(id, n);
        tomados += BigInt(n) * porCuanto;
      }
    }
    const calor = origen.get(0) ?? 0;
    if (calor && tomados) sumar(parte, 0, Number(BigInt(calor) * tomados / atomos));
    return parte;
  }

  moverParte(de: LoteRef, a: LoteRef, p: Pedido): number {
    const s = this.propioSlot(de), d = this.propioSlot(a);
    const origen = this.contenido(s);
    const parte = this.seleccionar(origen, p);
    if (s === d) return 0;
    let cuantos = 0;
    for (const [id, q] of parte) if (id !== 0) cuantos = natural(cuantos + q, 'Cuantos movidos');
    this.transferir(s, d, origen, parte);
    return cuantos;
  }

  aplicar(l: LoteRef, e: Ecuacion, veces: number): number {
    const s = this.propioSlot(l);
    natural(veces, 'Veces');
    if (!Number.isSafeInteger(e.dH)) throw new Error(`Energía de reacción inválida: ${e.dH}`);
    const grupos = (partes: Ecuacion['entradas']) => {
      const m: Cantidades = new Map();
      for (const { id, nu } of partes) {
        if (!natural(id, 'Sustancia', UINT32_MAX) || !natural(nu, 'Coeficiente')) throw new Error('Coeficiente o sustancia nulos.');
        sumar(m, id, nu);
      }
      return m;
    };
    const entradas = grupos(e.entradas), salidas = grupos(e.salidas);
    const antes = balancePares(entradas, this.sustancia), despues = balancePares(salidas, this.sustancia);
    if (antes.some((n, i) => despues[i] - n !== (i === ENERGIA ? BigInt(e.dH) : 0n))) {
      throw new Error('La ecuación de materia no está balanceada.');
    }
    const m = this.contenido(s);
    const calor = m.get(0) ?? 0;
    const dividir = (q: number, nu: number) => Number(BigInt(q) / BigInt(nu));
    for (const [id, nu] of entradas) veces = Math.min(veces, dividir(m.get(id) ?? 0, nu));
    if (e.dH > 0) veces = Math.min(veces, dividir(calor, e.dH));
    if (!veces) return 0;
    for (const [id, nu] of entradas) sumar(m, id, -veces * nu);
    for (const [id, nu] of salidas) sumar(m, id, natural(veces * nu, 'Producción'));
    sumar(m, 0, -veces * e.dH);
    this.escribir(s, m);
    return veces;
  }

  private asentar(s: number, m: Cantidades, pares: Cantidades, cuenta: Float64Array, signo: 1 | -1, cambio: 1 | -1): void {
    for (const [id, q] of pares) sumar(m, id, cambio * q);
    const asiento = prepararAsiento(cuenta, balancePares(pares, this.sustancia), signo);
    if (pares.size) this.escribir(s, m);
    cuenta.set(asiento);
  }

  garantizar(l: LoteRef, p: Pedido, libro: Libro): Float64Array {
    const s = this.propioSlot(l);
    const m = this.contenido(s);
    const parte = this.seleccionar(m, p);
    this.asentar(s, m, parte, libro.enVuelo, 1, -1);
    return aPares(parte);
  }

  abonar(l: LoteRef, garantia: Float64Array, libro: Libro): void {
    const s = this.propioSlot(l);
    this.asentar(s, this.contenido(s), leerPares(garantia), libro.enVuelo, -1, 1);
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
    this.asentar(s, this.contenido(s), leerPares(pares), libro.fuentes, 1, 1);
  }

  sumidero(l: LoteRef, pares: Float64Array, libro: Libro): Float64Array {
    const s = this.propioSlot(l);
    const m = this.contenido(s);
    const salida = leerPares(pares);
    for (const [id, q] of salida) sumar(salida, id, Math.min(q, m.get(id) ?? 0) - q);
    this.asentar(s, m, salida, libro.sumideros, 1, -1);
    return aPares(salida);
  }

  vista(l: LoteRef): VistaLote {
    const s = this.vivoSlot(l);
    const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
    const forma = b.forma[i], fisica = formaDeCodigo(forma);
    const partes = Array.from(this.componentes(s), ([id, q]) => ({ esp: this.sustancia(id), q }));
    const atomos = partes.reduce((total, { esp, q }) => total + q * esp.atomos.reduce((a, b) => a + b, 0), 0);
    const T = atomos ? b.calor[i] / (CAPACIDAD_ATOMO * atomos) : 0;
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

  *muestras(): IterableIterator<LoteGuardado> {
    for (let s = 0; s < this.op.lotes.slots; s++) if (this.activo(s)) {
      const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
      yield { ref: refDe(s, b.gen[i]), celda: this.celda[s], rol: b.marcas[i * MARCAS] as Rol, forma: b.forma[i],
        dueno: this.duenoDe(s), pares: aPares(this.contenido(s)) };
    }
  }

  *libres(): IterableIterator<LoteRef> {
    for (let s = 0; s < this.op.lotes.slots; s++) if (!this.activo(s)) {
      yield refDe(s, this.bloque(s).gen[s % LOTES_POR_BLOQUE]);
    }
  }

  saldo(): bigint[] {
    const saldo = Array<bigint>(NE + 1).fill(0n);
    for (let s = 0; s < this.op.lotes.slots; s++) if (this.activo(s)) {
      const parcial = balancePares(this.contenido(s), this.sustancia);
      for (let i = 0; i < saldo.length; i++) saldo[i] += parcial[i];
    }
    return saldo;
  }

  cargar(lotes: readonly LoteGuardado[], libres: readonly LoteRef[]): void {
    if (this.op.lotes.slots !== 0) throw new Error('La carga de materia exige una arena vacía.');
    const porSlot = new Map(lotes.map(l => [slotDe(l.ref), l]));
    const retirados = new Map(libres.map(ref => [slotDe(ref), genDe(ref)]));
    const devolver: number[] = [];
    for (let s = 0; s < lotes.length + libres.length; s++) {
      if (this.op.lotes.reserve() !== s) throw new Error('Ranuras de materia no consecutivas durante la carga.');
      const b = this.bloque(s), i = s % LOTES_POR_BLOQUE;
      const lote = porSlot.get(s);
      if (lote) {
        b.gen[i] = genDe(lote.ref);
        this.escribir(s, leerPares(lote.pares));
        this.instalar(s, lote.rol, this.celdaDe(lote.celda, lote.rol), lote.forma, lote.dueno);
      } else {
        const gen = retirados.get(s);
        if (gen === undefined) throw new Error(`Falta la ranura ${s} de materia.`);
        b.gen[i] = gen;
        b.marcas[i * MARCAS + USADO] = 1;
        if (gen < GEN_MAX) devolver.push(s);
      }
    }
    for (const s of devolver) this.op.lotes.release(s);
  }
}
