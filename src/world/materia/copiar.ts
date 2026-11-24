/**
 * Ley de copiar (ARQ-materia §3.2): la vida sintetiza su plantilla (crecer, gestar, construir tejido). Cada plantilla trae
 * su `Ecuacion` de síntesis balanceada al crearla por eliminación entera, sin flotantes; si no se balancea, no es viable.
 * Copiar hace tantas unidades enteras como permitan el elemento más escaso (Liebig), la energía y el ritmo; lo demás se
 * queda donde estaba. No hay recetas ni materiales: todo sale de los átomos y energías de las sustancias.
 */
import { NE } from '../../shared/naturaleza.js';
import type { SustanciaId } from '../../shared/materia.js';
import type { Registro } from '../motor/contratos.js';
import type { ArenaMateria, Ecuacion, LoteRef, Plantilla, ServicioQuimico } from './tipos.js';

type Termino = { id: SustanciaId; nu: number };

/** Cierto si `e` conserva cada elemento y su `dH` es exactamente Σ energía de las salidas − Σ de las entradas, en enteros.
 * Va en el camino caliente de `copiar` y `quemar`, así que suma en doble: es exacto porque exige Σ nu·(|energía| + 8) ≤ 2⁵³
 * (cota de toda suma parcial); una ecuación que no cabe ahí tampoco cabría en la arena (I3) y no ocurre. */
export function balanceada(q: ServicioQuimico, e: Ecuacion): boolean {
  const atomos = new Float64Array(NE);
  let energia = 0, cota = 0;
  const sumar = (ts: readonly Termino[], signo: number): boolean => {
    for (const t of ts) {
      const s = q.sustancia(t.id);
      if (!Number.isSafeInteger(t.nu) || t.nu <= 0 || !Number.isSafeInteger(s.energia)) return false;
      for (let k = 0; k < NE; k++) atomos[k]! += signo * t.nu * s.atomos[k]!;
      energia += signo * t.nu * s.energia;
      cota += t.nu * (Math.abs(s.energia) + 8);
    }
    return true;
  };
  return Number.isSafeInteger(e.dH) && sumar(e.salidas, 1) && sumar(e.entradas, -1)
    && cota + Math.abs(e.dH) <= Number.MAX_SAFE_INTEGER && atomos.every((a) => a === 0) && energia === e.dH;
}

/** Lo que define una plantilla antes de balancearla: `partes` es la unidad propuesta (se multiplica por el menor entero
 * que balancea), `entradas` de dónde puede sacar sus átomos y `subproductos` lo que puede devolver (O₂, H₂O…). */
export interface DatosPlantilla extends Omit<Plantilla, 'id' | 'sintesis'> {
  entradas: readonly SustanciaId[];
  subproductos: readonly SustanciaId[];
}

/**
 * Balancea la síntesis de `d` y la registra. Incógnitas: las unidades de `partes`, cuánto de cada entrada y de cada
 * subproducto. Exige una solución única (núcleo de dimensión 1) con todo ≥ 0 y unidades > 0; las especies con 0 salen
 * de la ecuación. null = no viable: le falta un elemento, la solución es ambigua, una especie está en los dos lados o
 * un número no es un entero seguro.
 */
export function crearPlantilla(q: ServicioQuimico, registro: Registro, d: DatosPlantilla): Plantilla | null {
  const ids = [...d.partes.map((t) => t.id), ...d.subproductos, ...d.entradas];
  if (d.partes.length === 0 || new Set(ids).size !== ids.length) return null;
  if (d.partes.some((t) => !Number.isSafeInteger(t.nu) || t.nu <= 0)) return null;

  // Columnas: la unidad de partes, cada subproducto (lado de las salidas) y cada entrada (con signo −).
  const cols = 1 + d.subproductos.length + d.entradas.length;
  const m = Array.from({ length: NE }, () => new Array<bigint>(cols).fill(0n));
  for (const t of d.partes) {
    const a = q.sustancia(t.id).atomos;
    for (let k = 0; k < NE; k++) m[k]![0]! += BigInt(t.nu) * BigInt(a[k]!);
  }
  [...d.subproductos, ...d.entradas].forEach((id, j) => {
    const a = q.sustancia(id).atomos, signo = j < d.subproductos.length ? 1n : -1n;
    for (let k = 0; k < NE; k++) m[k]![1 + j] = signo * BigInt(a[k]!);
  });
  let z = nucleo(m, cols);
  if (!z) return null;
  if (z[0]! < 0n) z = z.map((v) => -v);
  if (z[0] === 0n || z.some((v) => v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER))) return null;

  const u = Number(z[0]);
  const partes = d.partes.map((t) => ({ id: t.id, nu: t.nu * u })).sort(porId);
  const terminos = (lista: readonly SustanciaId[], desde: number) =>
    lista.map((id, j) => ({ id, nu: Number(z![desde + j]) })).filter((t) => t.nu > 0);
  const entradas = terminos(d.entradas, 1 + d.subproductos.length).sort(porId);
  const salidas = [...partes, ...terminos(d.subproductos, 1)].sort(porId);
  if (partes.some((t) => !Number.isSafeInteger(t.nu))) return null;
  let dH = 0n;
  for (const t of salidas) dH += BigInt(t.nu) * BigInt(q.sustancia(t.id).energia);
  for (const t of entradas) dH -= BigInt(t.nu) * BigInt(q.sustancia(t.id).energia);
  if (dH > BigInt(Number.MAX_SAFE_INTEGER) || dH < -BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const sintesis: Ecuacion = { entradas, salidas, dH: Number(dH) };
  const resto = { kappa: d.kappa, captura: d.captura, masaAdulta: d.masaAdulta, m0: d.m0, linaje: d.linaje };
  return { id: registro.insertar(canonico(partes, sintesis, resto)), partes, sintesis, ...resto };
}

/**
 * Sintetiza en `destino` unidades enteras de `p`: n = min(⌊maxUnidades⌋, Liebig sobre la suma de `fuentes`,
 * ⌊min(energia, calor del destino)/dH⌋ si la síntesis es endotérmica). Mueve n·nu de cada entrada desde las fuentes (en
 * su orden) al destino, aplica la síntesis y lleva los subproductos al lote `residuo` (aire, agua, digestivo); las partes
 * se quedan en el destino. `energia` es lo que el llamador autoriza a fijar (luz captada, o lo quemado por η): el calor
 * ambiente del lote no paga síntesis. Destino, fuentes y residuo son lotes distintos del mismo dueño. Devuelve n.
 */
export function copiar(arena: ArenaMateria, q: ServicioQuimico, p: Plantilla, destino: LoteRef,
  fuentes: readonly LoteRef[], residuo: LoteRef, energia: number, maxUnidades: number): number {
  const e = p.sintesis;
  if (!balanceada(q, e)) return 0;
  let n = Math.floor(maxUnidades);
  if (e.dH > 0) n = Math.min(n, Math.floor(Math.min(energia, arena.calor(destino)) / e.dH));
  for (const t of e.entradas) {
    let hay = 0;
    for (const f of fuentes) hay += arena.cuantos(f, t.id);
    n = Math.min(n, Math.floor(hay / t.nu));
  }
  if (!(n > 0)) return 0;
  for (const t of e.entradas) {
    let falta = n * t.nu;
    for (const f of fuentes) if (falta > 0) falta -= arena.mover({ de: f, a: destino, esp: t.id, cuantos: falta });
  }
  const hechas = arena.aplicar(destino, e, n);
  const partes = new Set(p.partes.map((t) => t.id));
  for (const t of e.salidas) {
    if (!partes.has(t.id)) arena.mover({ de: destino, a: residuo, esp: t.id, cuantos: hechas * t.nu });
  }
  return hechas;
}

const porId = (a: Termino, b: Termino) => a.id - b.id;

/** Bytes canónicos de una plantilla: los mismos datos dan el mismo id del `Registro` desde cualquier hilo. */
function canonico(partes: readonly Termino[], e: Ecuacion, r: Omit<Plantilla, 'id' | 'partes' | 'sintesis'>): Uint8Array {
  const v: number[] = [];
  for (const lista of [partes, e.entradas, e.salidas]) {
    v.push(lista.length);
    for (const t of lista) v.push(t.id, t.nu);
  }
  v.push(e.dH, ...r.kappa, r.captura, r.masaAdulta, r.m0, r.linaje);
  return new Uint8Array(Float64Array.from(v).buffer);
}

/** Vector primitivo del núcleo de `m` si tiene dimensión 1; si no, null. Eliminación de Gauss-Jordan sin fracciones. */
function nucleo(m: readonly bigint[][], n: number): bigint[] | null {
  const filas = m.map((f) => f.slice());
  const pivotes: number[] = [];
  for (let c = 0; c < n && pivotes.length < filas.length; c++) {
    const r = pivotes.length;
    const p = filas.findIndex((f, i) => i >= r && f[c] !== 0n);
    if (p < 0) continue;
    [filas[r], filas[p]] = [filas[p]!, filas[r]!];
    const piv = filas[r]!;
    for (let i = 0; i < filas.length; i++) {
      const a = filas[i]![c]!;
      if (i !== r && a !== 0n) filas[i] = primitivo(filas[i]!.map((v, j) => v * piv[c]! - piv[j]! * a));
    }
    pivotes.push(c);
  }
  if (n - pivotes.length !== 1) return null;
  const libre = [...Array(n).keys()].find((c) => !pivotes.includes(c))!;
  // Fila i: p_i·z[pivote_i] + a_i·z[libre] = 0; con z[libre] = mcm de los |p_i|, todo z es entero.
  const escala = pivotes.reduce((acc, c, i) => mcm(acc, abs(filas[i]![c]!)), 1n);
  const z = new Array<bigint>(n).fill(0n);
  z[libre] = escala;
  pivotes.forEach((c, i) => { z[c] = -filas[i]![libre]! * escala / filas[i]![c]!; });
  return primitivo(z);
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const mcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : mcd(b, a % b));
const mcm = (a: bigint, b: bigint) => a / mcd(a, b) * b;
function primitivo(v: bigint[]): bigint[] {
  const g = v.reduce((acc, x) => mcd(acc, abs(x)), 0n);
  return g > 1n ? v.map((x) => x / g) : v;
}
