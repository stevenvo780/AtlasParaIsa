/**
 * Cinética de un lote (ARQ-materia §3.1, carril P): cada par de sustancias presentes, y cada una sola, avanza la reacción
 * que da la química con tasa de Arrhenius y un número entero de veces. Todo cambio pasa por `ArenaMateria.aplicar`, que
 * conserva átomos y energía exactos (I2); aquí solo se decide cuántas veces.
 *
 * Diferencias con el pseudocódigo de §3.1, todas por necesidad:
 * - No se parte dt. Cada par se integra en forma cerrada sobre dt (primer orden, segundo orden con reactivos distintos o
 *   iguales), así que una constante enorme (κ ≥ ea: k = ν; o k·dt ≫ 1) agota el reactivo limitante en una sola llamada y
 *   nunca lo sobrepasa. La regla «si x > ½·min, partir dt» costaba hasta ν·dt subpasos (refirma de 0B).
 * - ξ no sale de redondear x con un uniforme: los cuantos de cada reactivo se sortean entre sus canales con una
 *   multinomial cuyas medias son las de la forma cerrada. El ruido del redondeo no crece con el lote (≤ ¼ por par y
 *   paso), así que dividir un lote duplicaba la varianza y se distinguía (I5); una multinomial es la suma de las de sus
 *   mitades.
 * - Los canales no se aplican uno tras otro: se evalúan todos con el lote del inicio del paso y, si piden más de un
 *   reactivo del que hay, se lo reparten en proporción (ver `pasoLote`).
 * La temperatura, el nivel ℓ y el volumen se fijan al empezar el paso: los productos reaccionan desde el paso siguiente.
 */
import { CAPACIDAD_ATOMO, NU, R } from '../../shared/naturaleza.js';
import type { SustanciaId } from '../../shared/materia.js';
import { nivelDeT, type ArenaMateria, type LoteRef, type Reaccion, type ServicioQuimico, type Sustancia } from './tipos.js';

/** Lo que el paso necesita de su hilo: la arena del dueño, la química y su azar sembrado (nunca Math.random). */
export interface CtxPaso {
  readonly arena: ArenaMateria;
  readonly quimica: ServicioQuimico;
  azar(): number;
}

/** J por cuanto de rebaja de barrera por familia (C–O, C–N, C–C/C–H), como `Plantilla.kappa`; la pone el rol del lote. */
export type Kappa = readonly [number, number, number];

/** kPa: un cuanto de gas ocupa R·T/ATMOSFERA litros a la presión de una atmósfera. */
const ATMOSFERA = 101.325;
const MG_POR_KG = 1e6;

/** Litros que ocupa un cuanto: gas ideal desde su ebullición, si no su densidad en fase condensada. */
const volumenMolar = (s: Readonly<Sustancia>, T: number): number =>
  T >= s.prop.tEbullicion ? R * T / ATMOSFERA : s.masa / (s.prop.densidad * MG_POR_KG);

const atomosDe = (s: Readonly<Sustancia>): number => {
  let n = 0;
  for (let e = 0; e < s.atomos.length; e++) n += s.atomos[e]!;
  return n;
};

// Búferes del hilo: cada worker tiene su propia copia del módulo.
let ids = new Uint32Array(16);
let cant = new Float64Array(16);
let demanda = new Float64Array(16);
const canales: (Reaccion | null)[] = [];
let canalI = new Int32Array(64), canalJ = new Int32Array(64);
let medias = new Float64Array(64), gobierna = new Int32Array(64);

function leerEspecies(arena: ArenaMateria, l: LoteRef): number {
  let n = arena.especies(l, ids);
  if (n > ids.length) {
    ids = new Uint32Array(2 * n); cant = new Float64Array(2 * n); demanda = new Float64Array(2 * n);
    n = arena.especies(l, ids);
  }
  return n;
}

/** Cuantos de átomos, temperatura (K) y volumen (L) de un lote. El objeto es del hilo: vale hasta la siguiente llamada. */
export interface Estado { atomos: number; T: number; V: number }
const estado: Estado = { atomos: 0, T: 0, V: 0 };
let presentes = 0; // sustancias de `ids` (con sus cuantos en `cant`) que leyó el último `medir`

export function medir(c: CtxPaso, l: LoteRef): Readonly<Estado> {
  const n = presentes = leerEspecies(c.arena, l);
  let atomos = 0;
  for (let i = 0; i < n; i++) {
    cant[i] = c.arena.cuantos(l, ids[i]!);
    atomos += cant[i]! * atomosDe(c.quimica.sustancia(ids[i]!));
  }
  const T = atomos > 0 ? c.arena.calor(l) / (CAPACIDAD_ATOMO * atomos) : 0;
  let V = 0;
  for (let i = 0; i < n; i++) V += cant[i]! * volumenMolar(c.quimica.sustancia(ids[i]!), T);
  estado.atomos = atomos; estado.T = T; estado.V = V;
  return estado;
}

/**
 * Avanza `dt` ticks las reacciones de `l` con la catálisis `kappa` y devuelve cuántas veces se aplicaron en total.
 * Todos los canales (pares i ≤ j y cada sustancia sola) se evalúan a la vez con las cantidades del inicio del paso.
 * Aplicarlos uno tras otro no servía: el primer canal rápido se llevaba el reactivo compartido, barajar el orden por lote
 * hacía que dividir el lote cambiara el resultado, y recortar al aplicar sesgaba en proporción al ruido (I5).
 */
export function pasoLote(c: CtxPaso, l: LoteRef, dt: number, kappa: Kappa): number {
  const { arena, quimica } = c;
  const { atomos, T, V } = medir(c, l);
  if (atomos === 0) return 0;
  const n = presentes;
  const nivel = nivelDeT(T);
  const maxCanales = n * (n + 1) / 2 + n;
  if (canalI.length < maxCanales) {
    canalI = new Int32Array(2 * maxCanales); canalJ = new Int32Array(2 * maxCanales);
    medias = new Float64Array(2 * maxCanales); gobierna = new Int32Array(2 * maxCanales);
  }
  demanda.fill(0, 0, n);
  let m = 0;
  for (let i = 0; i < n; i++) for (let j = i - 1; j < n; j++) { // j = i − 1: la sustancia sola
    const a: SustanciaId = ids[i]!, b: SustanciaId = j < i ? 0 : ids[j]!;
    const r = quimica.reaccion(a, b, nivel);
    if (!r) continue; // null: no reaccionan; undefined: encolada para la barrera siguiente
    const familia = r.catalisis;
    const barrera = Math.max(0, r.ea - (familia === -1 ? 0 : kappa[familia]));
    const kt = (barrera === 0 ? NU : T > 0 ? NU * Math.exp(-barrera / (R * T)) : 0) * dt;
    if (kt === 0) continue;
    const na = cant[i]!;
    let limite: number, prob: number;
    if (b === 0) {
      limite = na;
      prob = -Math.expm1(-kt);
    } else if (a === b) {
      // a + a → …: dn/dt = −2·k·n²/V; de ⌊n/2⌋ veces posibles se da la fracción 2·n·s/(1 + 2·n·s), s = k·dt/V.
      limite = Math.floor(na / 2);
      prob = 1 / (1 + V / (2 * na * kt));
    } else {
      const nb = cant[j]!;
      const lo = Math.min(na, nb), d = Math.abs(na - nb), s = kt / V;
      limite = lo;
      // dξ/dt = k·(na − ξ)(nb − ξ)/V cerrada; con d = 0 queda lo·s/(1 + lo·s).
      if (d === 0) prob = 1 / (1 + 1 / (lo * s));
      else {
        const e = -Math.expm1(-d * s);
        prob = (lo + d) * e / (d + lo * e);
      }
    }
    if (limite <= 0 || !(prob > 0)) continue;
    const media = limite * Math.min(1, prob);
    canales[m] = r; canalI[m] = i; canalJ[m] = j; medias[m] = media;
    if (b === 0) demanda[i]! += media;
    else if (a === b) demanda[i]! += 2 * media;
    else { demanda[i]! += media; demanda[j]! += media; }
    m++;
  }
  // Cada canal lo gobierna su reactivo más pedido respecto a lo que hay (a igualdad, el de menos cuantos), y si lo
  // piden de más, todos los canales que lo usan se lo reparten en proporción.
  for (let k = 0; k < m; k++) {
    const i = canalI[k]!, j = canalJ[k]!;
    const ri = demanda[i]! / cant[i]!, rj = j > i ? demanda[j]! / cant[j]! : 0;
    gobierna[k] = rj > ri || (rj === ri && cant[j]! < cant[i]!) ? j : i;
    medias[k]! /= Math.max(1, ri, rj);
  }
  // Los cuantos de cada reactivo se sortean entre sus canales en una multinomial (binomiales condicionadas): nunca se
  // pide más de lo que hay y la multinomial de un lote es la suma de las de sus mitades.
  let total = 0;
  for (let s = 0; s < n; s++) {
    let quedan = cant[s]!, resto = 1;
    for (let k = 0; k < m; k++) {
      if (gobierna[k] !== s) continue;
      const nu = canalI[k] === s && canalJ[k] === s ? 2 : 1;
      const parte = nu * medias[k]! / cant[s]!;
      const x = binomial(quedan, Math.min(1, parte / resto), c.azar);
      quedan -= x; resto -= parte;
      const veces = Math.floor(x / nu);
      if (veces > 0) total += arena.aplicar(l, canales[k]!, veces);
    }
  }
  canales.fill(null, 0, m);
  return total;
}

/** Normal estándar por Box–Muller (dos uniformes). */
function normal(azar: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - azar())) * Math.cos(2 * Math.PI * azar());
}

/** Varianza desde la que la binomial se toma normal: por debajo se invierte exacta, con ≤ 2·VARIANZA_NORMAL iteraciones. */
const VARIANZA_NORMAL = 100;

/** Binomial(n, p) entera en [0, n] para n hasta 2⁵³: inversión exacta en la cola menor o normal redondeada. */
export function binomial(n: number, p: number, azar: () => number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  const q = p > 0.5 ? 1 - p : p;
  const media = n * q, varianza = media * (1 - q);
  let k: number;
  if (varianza >= VARIANZA_NORMAL) {
    k = Math.min(n, Math.max(0, Math.round(media + Math.sqrt(varianza) * normal(azar))));
  } else {
    const razon = q / (1 - q);
    let pk = Math.exp(n * Math.log1p(-q)), u = azar();
    k = 0;
    while (u > pk && k < n && pk > 0) {
      u -= pk;
      pk *= (n - k) / (k + 1) * razon;
      k++;
    }
  }
  return p > 0.5 ? n - k : k;
}
