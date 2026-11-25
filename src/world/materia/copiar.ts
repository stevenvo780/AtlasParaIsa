/**
 * Ley de copiar (ARQ-materia §3.2): la vida sintetiza su plantilla (crecer, gestar, construir tejido). Cada plantilla trae
 * su `Ecuacion` de síntesis balanceada al crearla por eliminación entera, sin flotantes; si no se balancea, no es viable.
 * Copiar hace tantas unidades enteras como permitan el elemento más escaso (Liebig), la energía y el ritmo; lo demás se
 * queda donde estaba. No hay recetas ni materiales: todo sale de los átomos y energías de las sustancias.
 */
import { NE } from '../../shared/naturaleza.js';
import type { SustanciaId } from '../../shared/materia.js';
import type { Registro } from '../motor/contratos.js';
import { Parte, type ArenaMateria, type Ecuacion, type LoteRef, type Plantilla, type ServicioQuimico } from './tipos.js';

type Termino = { id: SustanciaId; nu: number };
const MAX = Number.MAX_SAFE_INTEGER;

/** Cierto si `e` conserva cada elemento y su `dH` es exactamente Σ energía de las salidas − Σ de las entradas, en enteros.
 * Va en el camino caliente de `copiar` y `quemar`, así que suma en doble; es exacto porque exige que Σ nu·(|energía| + 8)
 * + |dH| ≤ 2⁵³ acote toda suma parcial. Una ecuación fuera de esa cota se trata como desbalanceada: no es viable al crear
 * la plantilla y no ocurre al copiar ni al quemar. */
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
    && cota + Math.abs(e.dH) <= MAX && atomos.every((a) => a === 0) && energia === e.dH;
}

/** Lo que define una plantilla antes de balancearla: `partes` es la unidad propuesta (se multiplica por el menor entero
 * que balancea), `entradas` de dónde puede sacar sus átomos y `subproductos` lo que puede devolver (O₂, H₂O…), las dos en
 * orden de preferencia. Una misma sustancia puede ser parte y entrada (el agua del tejido) o parte y subproducto. */
export interface DatosPlantilla extends Omit<Plantilla, 'id' | 'sintesis'> {
  entradas: readonly SustanciaId[];
  subproductos: readonly SustanciaId[];
}

/**
 * Balancea la síntesis de `d` y la registra. Incógnitas ≥ 0: las unidades de `partes` (> 0), cuánto de cada subproducto y
 * cuánto de cada entrada. Si hay varias soluciones, toma la reacción de menos especies y, a igualdad, la de las primeras
 * de cada lista. null = no viable: ninguna solución (falta un elemento o sobraría uno que no puede salir), datos repetidos
 * en una lista o números que no son enteros seguros.
 */
export function crearPlantilla(q: ServicioQuimico, registro: Registro, d: DatosPlantilla): Plantilla | null {
  if (d.partes.length === 0 || d.partes.some((t) => !Number.isSafeInteger(t.nu) || t.nu <= 0)) return null;
  if ([d.partes.map((t) => t.id), d.subproductos, d.entradas].some((l) => new Set(l).size !== l.length)) return null;

  // Columnas: la unidad de partes, cada subproducto (lado de las salidas) y cada entrada (con signo −).
  const unidad = new Array<bigint>(NE).fill(0n);
  for (const t of d.partes) {
    const a = q.sustancia(t.id).atomos;
    for (let k = 0; k < NE; k++) unidad[k]! += BigInt(t.nu) * BigInt(a[k]!);
  }
  const especies = [...d.subproductos, ...d.entradas], nSub = d.subproductos.length;
  const cols = [unidad, ...especies.map((id, j) =>
    Array.from(q.sustancia(id).atomos, (a) => (j < nSub ? 1n : -1n) * BigInt(a)))];
  const z = reaccionMinima(cols);
  if (!z || z.some((v) => v > BigInt(MAX))) return null;

  const u = Number(z[0]);
  const partes = d.partes.map((t) => ({ id: t.id, nu: t.nu * u })).sort(porId);
  const salen = new Map(partes.map((t) => [t.id, t.nu]));
  const entradas: Termino[] = [];
  especies.forEach((id, j) => {
    const nu = Number(z[1 + j]);
    if (nu > 0 && j < nSub) salen.set(id, (salen.get(id) ?? 0) + nu);
    else if (nu > 0) entradas.push({ id, nu });
  });
  const salidas = [...salen].map(([id, nu]) => ({ id, nu })).sort(porId);
  entradas.sort(porId);
  const dH = salidas.reduce((s, t) => s + t.nu * q.sustancia(t.id).energia, 0)
    - entradas.reduce((s, t) => s + t.nu * q.sustancia(t.id).energia, 0);
  const sintesis: Ecuacion = { entradas, salidas, dH };
  // Exacta si cabe en la cota de `balanceada`; si no, la plantilla no se podría copiar nunca y no es viable.
  if (!balanceada(q, sintesis)) return null;

  const resto = { kappa: [d.kappa[0], d.kappa[1], d.kappa[2], d.kappa[3]] as const, // copia: los bytes registrados no cambian
    captura: d.captura, masaAdulta: d.masaAdulta, m0: d.m0, linaje: d.linaje };
  return { id: registro.insertar(canonico(partes, sintesis, resto)), partes, sintesis, ...resto };
}

/**
 * Sintetiza en `destino` unidades enteras de `p`: n = min(⌊maxUnidades⌋, Liebig sobre la suma de `fuentes`,
 * ⌊min(energia, calor del destino)/dH⌋ si la síntesis es endotérmica). Mueve n·nu de cada entrada desde las fuentes (en
 * su orden) al destino, aplica la síntesis y lleva al lote `residuo` (aire, agua, digestivo) lo que sale por encima de
 * las partes, que se quedan en el destino. Cada traslado lleva su parte del calor (`moverParte` Exacta, enmienda 2):
 * la materia sale a la T de su lote, así que tomar casi todo un charco no lo calienta (antes el calor se quedaba en la
 * fuente: 1.000 H₂O de los que la planta toma 945 pasaban de 295 a 5.364 K y el agua que quedaba se partía). `energia`
 * es lo que el llamador autoriza a fijar (luz captada, o lo quemado por η): el calor ambiente del lote no paga síntesis
 * (la cota de n usa el calor del destino antes de recibir las entradas). Destino, fuentes y residuo son lotes distintos
 * del mismo dueño. Devuelve n.
 */
export function copiar(arena: ArenaMateria, q: ServicioQuimico, p: Plantilla, destino: LoteRef,
  fuentes: readonly LoteRef[], residuo: LoteRef, energia: number, maxUnidades: number): number {
  const e = p.sintesis;
  if (!balanceada(q, e)) return 0;
  const enPartes = new Map(p.partes.map((t) => [t.id, t.nu]));
  // Cuántas veces caben `por` más en algo que ya tiene `ya`: ningún estado intermedio puede pasar de 2⁵³ (I3).
  const cabe = (ya: number, por: number) => Math.floor((MAX - ya) / por);
  let n = Math.floor(maxUnidades);
  if (e.dH > 0) n = Math.min(n, Math.floor(Math.min(energia, arena.calor(destino)) / e.dH));
  if (e.dH < 0) n = Math.min(n, cabe(arena.calor(destino), -e.dH));
  for (const t of e.entradas) {
    let hay = 0;
    for (const f of fuentes) hay += arena.cuantos(f, t.id);
    n = Math.min(n, Math.floor(hay / t.nu), cabe(arena.cuantos(destino, t.id), t.nu));
  }
  for (const t of e.salidas) {
    n = Math.min(n, cabe(arena.cuantos(destino, t.id), t.nu));
    const sobra = t.nu - (enPartes.get(t.id) ?? 0);
    if (sobra > 0) n = Math.min(n, cabe(arena.cuantos(residuo, t.id), sobra));
  }
  if (!(n > 0)) return 0;
  const exacta = (esp: SustanciaId, cuantos: number) => ({ parte: Parte.Exacta, esp, cuantos, kappa: null });
  for (const t of e.entradas) {
    let falta = n * t.nu;
    for (const f of fuentes) if (falta > 0) falta -= arena.moverParte(f, destino, exacta(t.id, falta));
  }
  const hechas = arena.aplicar(destino, e, n);
  for (const t of e.salidas) {
    const sobra = t.nu - (enPartes.get(t.id) ?? 0);
    if (sobra > 0 && hechas > 0) arena.moverParte(destino, residuo, exacta(t.id, hechas * sobra));
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

/**
 * Coeficientes ≥ 0 por columna (0 fuera de la reacción) de la reacción con la columna 0 > 0 de menos columnas: el primer
 * soporte S ∋ 0, por tamaño y luego en orden lexicográfico, cuyo núcleo es de dimensión 1 y > 0 en todo S. Si existe
 * alguna solución ≥ 0 con la columna 0 > 0, la de soporte mínimo es de esta forma (si su núcleo tuviera dimensión ≥ 2, una
 * dirección con la columna 0 a cero vaciaría otra columna), así que no encontrarla prueba que no hay solución.
 */
function reaccionMinima(cols: readonly (readonly bigint[])[]): bigint[] | null {
  // Un elemento cuyos términos tienen todos el mismo signo obliga a 0 esas columnas: se quitan hasta que no quede ninguno
  // (así lo que no puede balancearse cae sin recorrer soportes).
  const signo = cols.map((c) => c.map((v) => (v > 0n ? 1 : v < 0n ? -1 : 0)));
  const unSigno = (s: readonly number[], e: number) => {
    let mas = false, menos = false;
    for (const j of s) { mas ||= signo[j]![e]! > 0; menos ||= signo[j]![e]! < 0; }
    return mas !== menos;
  };
  let vivas = cols.map((_, j) => j);
  for (let cambio = true; cambio;) {
    cambio = false;
    for (let e = 0; e < NE; e++) {
      if (!unSigno(vivas, e)) continue;
      vivas = vivas.filter((j) => signo[j]![e] === 0);
      cambio = true;
    }
  }
  if (vivas[0] !== 0) return null;
  // Un soporte tiene a lo sumo rango + 1 ≤ NE + 1 columnas.
  for (let k = 0; k < vivas.length && k <= NE; k++) {
    for (const resto of combinaciones(vivas.length - 1, k)) {
      const s = [0, ...resto.map((i) => vivas[i + 1]!)];
      if (signo[0]!.some((_, e) => unSigno(s, e))) continue; // el mismo criterio dentro de S: no admite z > 0
      let z = nucleo(Array.from({ length: NE }, (_, e) => s.map((j) => cols[j]![e]!)), s.length);
      if (!z) continue;
      if (z[0]! < 0n) z = z.map((v) => -v);
      if (!z.every((v) => v > 0n)) continue;
      const todo = new Array<bigint>(cols.length).fill(0n);
      s.forEach((j, i) => { todo[j] = z![i]!; });
      return todo;
    }
  }
  return null;
}

function* combinaciones(n: number, k: number, desde = 0): Generator<number[]> {
  if (k === 0) { yield []; return; }
  for (let i = desde; i <= n - k; i++) for (const r of combinaciones(n, k - 1, i + 1)) yield [i, ...r];
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
