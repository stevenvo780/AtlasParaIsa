/**
 * Cinética de un lote (ARQ-materia §3.1, carril P): cada par de sustancias presentes, y cada una sola, avanza la reacción
 * que da la química con tasa de Arrhenius y un número entero de veces. Todo cambio pasa por `ArenaMateria.aplicar`, que
 * conserva átomos y energía exactos (I2); aquí solo se decide cuántas veces.
 *
 * Enmiendas 1 a 3 (contrato de `Reaccion`): la barrera es `barreraEfectiva`, max(0, ea − κ[catalisis]·paresCatalisis) en una
 * exotérmica y ea (≥ dH) en una endotérmica, así que la catálisis solo acelera lo que suelta calor (κ en 4 familias:
 * C–O, C–N, C–C/C–H y H–H) y un lote con algún κ > 0 elige productos al menos en el nivel 2 (`nivelDeLote`: el suelo frío
 * no hace HCN); y una vez consume ν_a de a y ν_b de b con los coeficientes que elige Q (2 H₂ + O₂ → 2 H₂O). Las
 * veces por tick son k·n_a·n_b/V (a + b), k·n_a²/V (a + a) y k·n_a (a sola) sean cuales sean los ν: los coeficientes son
 * estequiométricos, no órdenes cinéticos (el ritmo lo ponen los encuentros de un a con un b). En unidades de vez
 * (α = n_a/ν_a, β = n_b/ν_b) un a + b es el problema 1:1 con constante ν_a·ν_b·k, así que la forma cerrada no cambia.
 * Un canal solo corre si su reacción gana energía libre a la T y con las fases reales del lote (`favorableA`: ΔG < −ε,
 * como Q a la de su nivel; revisión de la enmienda 3, hallazgo 5).
 *
 * Diferencias con el pseudocódigo de §3.1, todas por necesidad:
 * - Cada canal da en forma cerrada (primer orden, segundo orden con reactivos distintos o iguales) el riesgo integrado
 *   h = −ln(fracción que sobrevive) de sus reactivos, así que una constante enorme (κ ≥ ea: k = ν; o k·dt ≫ 1) agota el
 *   reactivo limitante sin pasarse. Los canales que comparten un reactivo compiten: sobrevive e^(−Σh) y lo consumido se
 *   reparte según el riesgo instantáneo de cada canal; con un a + a entre ellos, por la solución cerrada de Bernoulli
 *   (`extensiones`). Es exacto con canales que no comparten reactivo y con competidores cuyo compañero no se gasta (pseudo
 *   primer orden: el O₂ del suelo entre muchas sustancias orgánicas). Si el compañero de un competidor también se gasta,
 *   las proporciones cambian dentro de dt y el paso se parte en subpasos en los que ningún compañero pierde más de la
 *   mitad, con el reparto del punto medio (orden 2), hasta que le quedan 2⁻¹⁰ cuantos (`AGOTADO`; un canal saturado
 *   necesita ~log₂ n + 10 subpasos). Frente a la EDO integrada fina (combustión contra dimerización, 12 regímenes con k hasta
 *   ν y hasta 10¹² cuantos) queda dentro del 5 %; repartir las demandas ya saturadas, como antes, daba a la combustión 60
 *   veces lo que le toca. Antes de los subpasos, los reactivos instantáneos a la escala del paso (Λ·dt ≥ 64: la madera,
 *   la proteína y el orgP de un suelo catalizado) se agotan en forma cerrada repartidos entre sus canales como en el
 *   límite de subpasos muy pequeños (`instantaneos`), y los subpasos integran lo demás.
 * - ξ no sale de redondear con un uniforme: los cuantos de cada reactivo se sortean entre sus canales en una multinomial
 *   con las medias de la integración, que es la suma de las de las mitades del lote (I5, para particiones que conservan
 *   grupos enteros de la estequiometría); a + a sortea pares enteros. Cada canal a + b lo sortea el reactivo cuyo sorteo
 *   menos arriesga pedirle al otro más de lo que le sobra (z = holgura/σ, revisión de la enmienda 3, hallazgo 4).
 * - Lo sorteado se recorta antes de aplicar, en proporción y en orden de id (nunca en el de las ranuras), a lo que hay de
 *   cada reactivo y al calor que pagan las endotérmicas tras sumar el que sueltan las exotérmicas del mismo paso; lo que el
 *   recorte libera de un reactivo se vuelve a sortear entre sus canales no recortados.
 * - Pases encadenados (`PASES_ENCADENADOS`, validación de la enmienda 3, hallazgo 7): lo que produce un pase reacciona
 *   en el mismo paso, en ventanas dt/2, dt/4, …, en los canales que tienen algún reactivo nuevo.
 * La temperatura y el nivel ℓ (`nivelDeLote`) se fijan al empezar el paso y valen para todos sus pases; el volumen, en
 * cada pase con lo que hay. G replica todo esto (pedido en ARQ-materia §3.1, enmienda 3).
 */
import { CAPACIDAD_ATOMO, NU, R } from '../../shared/naturaleza.js';
import { favorableA } from './quimica.js';
import type { SustanciaId } from '../../shared/materia.js';
import {
  barreraEfectiva, nivelDeLote, type ArenaMateria, type Kappa, type LoteRef, type Reaccion, type ServicioQuimico, type Sustancia,
} from './tipos.js';

/** Lo que el paso necesita de su hilo: la arena del dueño, la química y su azar sembrado (nunca Math.random). */
export interface CtxPaso {
  readonly arena: ArenaMateria;
  readonly quimica: ServicioQuimico;
  azar(): number;
}

/** J por cuanto de rebaja de barrera por familia (C–O, C–N, C–C/C–H, H–H): el `Kappa` de tipos.ts; lo pone el rol del lote. */
export type { Kappa };

/** kPa: un cuanto de gas ocupa R·T/ATMOSFERA litros a la presión de una atmósfera. */
const ATMOSFERA = 101.325;
const MG_POR_KG = 1e6;
/** Fracción que un compañero de un competidor puede perder en un subpaso. */
const SUBPASO = 0.5;
/** Cuantos (absolutos) por debajo de los cuales un reactivo ya no se vigila. Antes era una fracción (10⁻⁴ de lo que
 * había) y un canal saturado (k = ν) con un compañero compartido dejaba ese resto sin gastar: el último subpaso reparte
 * por el punto medio, donde ya no queda reactivo, y el compañero le daba 0. Era medio cuanto hasta la revisión de la
 * enmienda 3: con ν = 2 y una sola vez posible (2 H₂ recién nacidos en un suelo con O₂), lo que quedaba sin dar llegaba
 * a 0,45 cuantos, ξ = 0,78, y en el 22 % de los pasos la vez no se daba; en el suelo denso de la validación (hallazgo
 * 7), 3.287 de 20.000 pasos dejaban sus 2 H₂ y salían al aire (0,15 % del H a los 200 recambios, sin meseta). Con
 * 2⁻¹⁰ lo que se pierde de media es < 10⁻³ veces por canal, a costa de ~10 subpasos más en un canal saturado. */
const AGOTADO = 2 ** -10;
/** Λ·dt (riesgo por cuanto en el paso) desde el que un reactivo es instantáneo: queda e^(−64) de él (nada, hasta 2⁹²
 * cuantos) y su vida media es ≤ 1/64 del paso. */
const INSTANTANEO = 64;
/** Fracción del riesgo de un instantáneo que puede venir de canales cuyo ritmo cambia mientras se agota (a + a, o
 * compañero también instantáneo), y la que puede tener un compañero lento de riesgo propio frente al del instantáneo. */
const VARIABLE = 1 / 64;
/** Tope de subpasos: medio cuanto desde 2⁵³ son 54 mitades; si se llegara, lo que falta va en uno. */
const SUBPASOS_MAX = 200;
/** Pases encadenados tras el principal (ventanas dt/2, dt/4, …, dt/2⁸): lo que aún quede nuevo espera al paso siguiente. */
export const PASES_ENCADENADOS = 8;

// Por sustancia (índice: su id), de la química en curso: átomos por cuanto (0: aún sin leer), temperatura de ebullición
// y litros por cuanto en fase condensada. Las sustancias no cambian, así que se leen una vez por hilo.
let quimicaLeida: ServicioQuimico | null = null;
let atomosId = new Float64Array(64), ebullicionId = new Float64Array(64), condensadoId = new Float64Array(64);

function leerSustancia(q: ServicioQuimico, id: SustanciaId): void {
  if (q !== quimicaLeida) { quimicaLeida = q; atomosId.fill(0); }
  if (id >= atomosId.length) {
    const t = Math.max(2 * atomosId.length, id + 1);
    const mas = (a: Float64Array) => { const b = new Float64Array(t); b.set(a); return b; };
    atomosId = mas(atomosId); ebullicionId = mas(ebullicionId); condensadoId = mas(condensadoId);
  }
  const s = q.sustancia(id);
  let n = 0;
  for (let e = 0; e < s.atomos.length; e++) n += s.atomos[e]!;
  ebullicionId[id] = s.prop.tEbullicion;
  condensadoId[id] = s.masa / (s.prop.densidad * MG_POR_KG);
  atomosId[id] = n;
}

/** Átomos por cuanto de `id` (y deja leídos sus datos de volumen). */
function atomosDe(q: ServicioQuimico, id: SustanciaId): number {
  if (q !== quimicaLeida || id >= atomosId.length || atomosId[id] === 0) leerSustancia(q, id);
  return atomosId[id]!;
}

/** Litros que ocupa un cuanto de `id`: gas ideal desde su ebullición, si no su densidad en fase condensada. */
function volumenMolar(q: ServicioQuimico, id: SustanciaId, T: number): number {
  if (q !== quimicaLeida || id >= atomosId.length || atomosId[id] === 0) leerSustancia(q, id);
  return T >= ebullicionId[id]! ? R * T / ATMOSFERA : condensadoId[id]!;
}

const DOS_M54 = 2 ** -54, DOS_M29 = 2 ** -29;
/** Math.expm1 con su rama de argumento pequeño hecha aquí: la de fdlibm, que es la de V8 (|x| < 2⁻⁵⁴: x), así que el
 * resultado es el mismo bit a bit (tests/materia-rendimiento.test.ts). Casi la mitad de los argumentos de un suelo
 * vienen de canales lentos y no llegan a 2⁻⁵⁴. */
export function expm1(x: number): number { return x > -DOS_M54 && x < DOS_M54 ? x : Math.expm1(x); }
/** Math.log1p con sus ramas de fdlibm para |x| < 2⁻²⁹ (x, y x − x²/2 desde 2⁻⁵⁴), las de V8, bit a bit. */
export function log1p(x: number): number {
  const a = Math.abs(x);
  return a < DOS_M29 ? (a < DOS_M54 ? x : x - x * x * 0.5) : Math.log1p(x);
}

// Búferes del hilo (cada worker tiene su propia copia del módulo).
// Por sustancia, en orden de id: cuantos, media en curso y en el punto medio, riesgo integrado H y riesgo instantáneo
// (L en el estado del reparto, L0 en el de partida) de sus canales que no son a + a, su canal a + a, lo que gastan en el
// subpaso unos y otro, consumo por tick, canales que la usan y grupos de sorteo.
let ids = new Uint32Array(16);
let cant = new Float64Array(16), x = new Float64Array(16), xm = new Float64Array(16), H = new Float64Array(16);
let L = new Float64Array(16), L0 = new Float64Array(16), aa = new Int32Array(16);
let gastoLineal = new Float64Array(16), gastoAa = new Float64Array(16);
let consumo = new Float64Array(16), usos = new Int32Array(16), inicio = new Int32Array(17);
// Fase instantánea (`instantaneos`): riesgo por cuanto total y de canales fijos, riesgo propio de un compañero lento,
// lo que piden de él los instantáneos, lo que queda por repartir de cada instantáneo y si lo es.
let riesgo = new Float64Array(16), riesgoFijo = new Float64Array(16), riesgoLento = new Float64Array(16);
let demanda = new Float64Array(16), reparto = new Float64Array(16), rapido = new Uint8Array(16);
// Por canal: sus reactivos (j = i − 1: sola; j = i: a + a) y sus coeficientes ν, su reacción y k por tick; riesgos
// integrados e instantáneos por reactivo; extensión del subpaso y acumulada; quién lo sortea, orden de sorteo, veces y
// veces antes de recortar.
let canales: (Reaccion | null)[] = [];
let canalI = new Int32Array(16), canalJ = new Int32Array(16), nuI = new Int32Array(16), nuJ = new Int32Array(16);
let gobierna = new Int32Array(16), orden = new Int32Array(16);
let kTick = new Float64Array(16), hI = new Float64Array(16), hJ = new Float64Array(16);
let lI = new Float64Array(16), lJ = new Float64Array(16), l0I = new Float64Array(16), l0J = new Float64Array(16);
let ext = new Float64Array(16), xi = new Float64Array(16), veces = new Float64Array(16), pedidas = new Float64Array(16);
// Pases encadenados: lo que produjo el pase anterior y lo que produce este (cuantos por id, con la lista de ids tocados);
// por sustancia del lote, si es nueva.
let nuevos = new Float64Array(64), producidos = new Float64Array(64);
let idsNuevos = new Uint32Array(16), idsProducidos = new Uint32Array(16);
let nNuevos = 0, nProducidos = 0;
let esNueva = new Uint8Array(16);
// La química del pase en curso, para `favorableA` sin crear un cierre por pase.
let quimicaPase: ServicioQuimico | null = null;
const sustanciaPase = (id: SustanciaId): Readonly<Sustancia> => quimicaPase!.sustancia(id);

function leerEspecies(arena: ArenaMateria, l: LoteRef): number {
  let n = arena.especies(l, ids);
  if (n > ids.length) {
    const t = 2 * n;
    ids = new Uint32Array(t); cant = new Float64Array(t); x = new Float64Array(t); xm = new Float64Array(t);
    H = new Float64Array(t); L = new Float64Array(t); L0 = new Float64Array(t); aa = new Int32Array(t);
    gastoLineal = new Float64Array(t); gastoAa = new Float64Array(t);
    consumo = new Float64Array(t); usos = new Int32Array(t); inicio = new Int32Array(t + 1); esNueva = new Uint8Array(t);
    riesgo = new Float64Array(t); riesgoFijo = new Float64Array(t); riesgoLento = new Float64Array(t);
    demanda = new Float64Array(t); reparto = new Float64Array(t); rapido = new Uint8Array(t);
    n = arena.especies(l, ids);
  }
  // Orden de id (nada depende de en qué ranura esté cada sustancia): por inserción, sin asignar.
  for (let a = 1; a < n; a++) {
    const v = ids[a]!;
    let b = a - 1;
    for (; b >= 0 && ids[b]! > v; b--) ids[b + 1] = ids[b]!;
    ids[b + 1] = v;
  }
  return n;
}

function crecerCanales(): void {
  const t = 2 * canalI.length;
  const mas = <A extends Int32Array | Float64Array>(a: A): A => { const b = new (a.constructor as new (n: number) => A)(t); b.set(a); return b; };
  canalI = mas(canalI); canalJ = mas(canalJ); nuI = mas(nuI); nuJ = mas(nuJ); kTick = mas(kTick);
  gobierna = new Int32Array(t); orden = new Int32Array(t); hI = new Float64Array(t); hJ = new Float64Array(t);
  lI = new Float64Array(t); lJ = new Float64Array(t); l0I = new Float64Array(t); l0J = new Float64Array(t);
  ext = new Float64Array(t); xi = new Float64Array(t); veces = new Float64Array(t); pedidas = new Float64Array(t);
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
    atomos += cant[i]! * atomosDe(c.quimica, ids[i]!);
  }
  const T = atomos > 0 ? c.arena.calor(l) / (CAPACIDAD_ATOMO * atomos) : 0;
  let V = 0;
  for (let i = 0; i < n; i++) V += cant[i]! * volumenMolar(c.quimica, ids[i]!, T);
  estado.atomos = atomos; estado.T = T; estado.V = V;
  return estado;
}

/** Cuántos cuantos de su reactivo s consume una vez el canal k (ν de la reacción; s es uno de sus reactivos). */
const nuDe = (k: number, s: number): number => (canalI[k] === s ? nuI[k]! : nuJ[k]!);

/**
 * Extensión media (veces) de cada canal en un subpaso h: riesgos integrados desde `xa`; reparto con los riesgos de `xb`.
 * Lo que se gasta de s: sin a + a, sobrevive e^(−H). Con a + a (β = ν·k·h/V) y el resto de canales con riesgo por
 * cuanto μ (Bernoulli: dA/dτ = −μA − βA²) quedan μ·A0·e^(−μ)/(μ + β·A0·(1 − e^(−μ))), y los canales de μ se llevan
 * (μ/β)·ln(1 + β·A0·(1 − e^(−μ))/μ). Así a + a compite sin subpasos con los de compañero que no se gasta.
 */
function extensiones(m: number, n: number, V: number, h: number, xa: Float64Array, xb: Float64Array): void {
  // Las tablas del módulo en locales: así V8 no vuelve a cargar cada una (ni su longitud) en cada acceso.
  const cI = canalI, cJ = canalJ, pI = nuI, pJ = nuJ, kT = kTick, rI = hI, rJ = hJ, iI = lI, iJ = lJ, i0I = l0I, i0J = l0J;
  const Hs = H, Ls = L, L0s = L0, aas = aa, gL = gastoLineal, gA = gastoAa, ex = ext;
  Hs.fill(0, 0, n); Ls.fill(0, 0, n); L0s.fill(0, 0, n); aas.fill(-1, 0, n);
  for (let k = 0; k < m; k++) {
    const i = cI[k]!, j = cJ[k]!, kt = kT[k]! * h, s = kt / V, na = xa[i]!;
    if (j < i) { rI[k] = iI[k] = i0I[k] = kt; }
    else if (j === i) { aas[i] = k; iI[k] = pI[k]! * s; continue; }
    else {
      // dξ/dt = k·(na − p·ξ)(nb − q·ξ)/V = p·q·k·(α − ξ)(β − ξ)/V con α = na/p y β = nb/q, cerrada. Con s′ = p·q·s y
      // e = 1 − e^(−d·s′) sobreviven d(1 − e)/(d + lo·e) del menor (en veces) y d/(d + lo·e) del mayor; con d = 0,
      // 1/(1 + lo·s′) de los dos.
      const p = pI[k]!, q = pJ[k]!, nb = xa[j]!, alfa = na / p, beta = nb / q, s2 = p * q * s;
      const lo = Math.min(alfa, beta), d = Math.abs(alfa - beta);
      let hMenor: number, hMayor: number;
      if (d === 0) hMenor = hMayor = log1p(lo * s2);
      else {
        const e = -expm1(-d * s2);
        hMayor = log1p(lo * e / d); hMenor = hMayor + d * s2;
      }
      const hi = alfa <= beta ? hMenor : hMayor, hj = alfa <= beta ? hMayor : hMenor;
      // Riesgo instantáneo por cuanto: a pierde p por vez, a ritmo k·b/V por cuanto de a.
      const li = p * xb[j]! * s, lj = q * xb[i]! * s, l0i = p * nb * s, l0j = q * na * s;
      rI[k] = hi; rJ[k] = hj; iI[k] = li; iJ[k] = lj; i0I[k] = l0i; i0J[k] = l0j;
      Hs[j]! += hj; Ls[j]! += lj; L0s[j]! += l0j;
    }
    Hs[i]! += rI[k]!; Ls[i]! += iI[k]!; L0s[i]! += i0I[k]!;
  }
  for (let s = 0; s < n; s++) {
    const A0 = xa[s]!;
    gL[s] = gA[s] = 0;
    if (A0 === 0) continue;
    const kAa = aas[s]!;
    if (kAa < 0) { gL[s] = A0 * -expm1(-Hs[s]!); continue; }
    const beta = iI[kAa]!, mu = Ls[s]! > 0 ? Ls[s]! : L0s[s]!;
    let fin: number;
    if (mu === 0) fin = A0 / (1 + beta * A0);
    else {
      const e = -Math.expm1(-mu);
      fin = mu * A0 * (1 - e) / (mu + beta * A0 * e);
      gL[s] = beta * A0 > 0 ? mu / beta * Math.log1p(beta * A0 * e / mu) : A0 * e;
    }
    gA[s] = Math.max(0, A0 - fin - gL[s]!);
  }
  for (let k = 0; k < m; k++) {
    const i = cI[k]!, j = cJ[k]!;
    if (j === i) { ex[k] = gA[i]! / pI[k]!; continue; }
    // Parte del canal entre los de su reactivo que no son a + a: por su riesgo en el punto medio, o en el de partida si
    // allí ya no queda compañero.
    const Li = Ls[i]!, ri = Li > 0 ? iI[k]! / Li : L0s[i]! > 0 ? i0I[k]! / L0s[i]! : 0;
    let e = gL[i]! * ri / pI[k]!;
    if (j > i) {
      const Lj = Ls[j]!, rj = Lj > 0 ? iJ[k]! / Lj : L0s[j]! > 0 ? i0J[k]! / L0s[j]! : 0;
      e = Math.min(e, gL[j]! * rj / pJ[k]!);
    }
    ex[k] = e;
  }
}

/** z de `pasoLote`: holgura media de r (cuantos que le sobran, `cant − L`) en desviaciones del sorteo del canal (de
 * media ξ veces) por s, en cuantos de r. Infinito si ese sorteo no tiene ruido (p = 0 o 1). */
function holguraEnSigmas(r: number, nuR: number, s: number, nuS: number, xiK: number): number {
  const grupos = cant[s]! / nuS, p = Math.min(1, Math.max(0, xiK / grupos));
  const sigma = Math.sqrt(grupos * p * (1 - p));
  return sigma > 0 ? Math.max(0, cant[r]! - L[r]!) / (nuR * sigma) : Infinity;
}

/** `destino` = `desde` menos lo que consumen las extensiones `ext` (sin bajar de 0). */
function consumir(m: number, n: number, desde: Float64Array, destino: Float64Array): void {
  if (destino !== desde) for (let s = 0; s < n; s++) destino[s] = desde[s]!;
  const cI = canalI, cJ = canalJ, pI = nuI, pJ = nuJ, ex = ext;
  for (let k = 0; k < m; k++) {
    const i = cI[k]!, j = cJ[k]!;
    destino[i] = Math.max(0, destino[i]! - pI[k]! * ex[k]!);
    if (j > i) destino[j] = Math.max(0, destino[j]! - pJ[k]! * ex[k]!);
  }
}

/**
 * Fase instantánea de `integrar`: los reactivos con Λ·dt ≥ INSTANTANEO (Λ, su riesgo por cuanto al empezar) se agotan
 * dentro del paso en un tiempo en que lo demás apenas cambia, así que se resuelven primero y en forma cerrada, y el resto
 * del paso se integra después con lo que dejan (separación de escalas; el error en los canales lentos de un compañero es
 * ≤ lo que le piden por 1/(Λ·dt)). Lo que pierde un instantáneo s, x_s(1 − e^(−Λ·dt)), se reparte entre sus canales
 * fijos (solo, o con un compañero lento, de riesgo λ constante mientras s vive) en proporción a λ, que es el límite de los
 * subpasos muy pequeños: ∫λ·x_s dt / ∫Λ·x_s dt. Los canales de ritmo variable (a + a, o con el compañero también
 * instantáneo) se llevan ∫k·x_a·x_b/V dt con los dos decayendo a su Λ, que es exacto cuando son una parte pequeña del
 * riesgo (≤ VARIABLE), y se descuentan antes del reparto. Los compañeros lentos entran en el punto medio de lo que les
 * piden (predictor y corrector, orden 2), así que pueden perder hasta SUBPASO; un instantáneo con un compañero que pierde
 * más, o que tiene riesgo propio comparable (> VARIABLE·Λ), o con demasiado riesgo variable, deja de serlo y va a los
 * subpasos; si ya no queda ninguno, no se hace nada. Antes, cada uno de ellos fijaba el subpaso en ~1/(2Λ) hasta bajar
 * de AGOTADO: unos 49 subpasos con madera, proteína y orgP en un suelo catalizado (k = 414 por tick). Deja en `ext` las
 * veces de cada canal (0 en los que no tocan un instantáneo) y en `x` lo que queda; devuelve si resolvió alguno.
 */
function instantaneos(m: number, n: number, V: number, dt: number): boolean {
  const cI = canalI, cJ = canalJ, pI = nuI, pJ = nuJ, kT = kTick, iI = lI, iJ = lJ, ex = ext, xs = x, med = xm;
  const Lt = riesgo, Lf = riesgoFijo, Ll = riesgoLento, D = demanda, B = reparto, rap = rapido;
  Lt.fill(0, 0, n);
  for (let k = 0; k < m; k++) {
    const i = cI[k]!, j = cJ[k]!, kt = kT[k]!;
    if (j < i) Lt[i]! += kt;
    else if (j === i) Lt[i]! += pI[k]! * kt * xs[i]! / V;
    else { Lt[i]! += pI[k]! * kt * xs[j]! / V; Lt[j]! += pJ[k]! * kt * xs[i]! / V; }
  }
  for (let s = 0; s < n; s++) rap[s] = Lt[s]! * dt >= INSTANTANEO ? 1 : 0;
  // El reactivo en exceso (más veces posibles) de un canal entre dos candidatos no se agota por él, solo pierde lo que
  // el otro le pide: ese riesgo no cuenta para ser instantáneo (el CaCO₃ frente al orgP).
  Lf.fill(0, 0, n);
  for (let k = 0; k < m; k++) {
    const i = cI[k]!, j = cJ[k]!, kt = kT[k]!;
    if (j < i) Lf[i]! += kt;
    else if (j === i) Lf[i]! += pI[k]! * kt * xs[i]! / V;
    else {
      const ai = xs[i]! / pI[k]!, aj = xs[j]! / pJ[k]!, ambos = rap[i] && rap[j];
      if (!ambos || ai <= aj) Lf[i]! += pI[k]! * kt * xs[j]! / V;
      if (!ambos || aj <= ai) Lf[j]! += pJ[k]! * kt * xs[i]! / V;
    }
  }
  let alguno = false;
  for (let s = 0; s < n; s++) { if (rap[s] && Lf[s]! * dt < INSTANTANEO) rap[s] = 0; if (rap[s]) alguno = true; }
  // Cada vuelta quita al menos un instantáneo que no cumple, así que acaba en ≤ n vueltas.
  while (alguno) {
    for (let s = 0; s < n; s++) med[s] = xs[s]!;
    for (let corrector = 0; corrector < 2; corrector++) {
      Lt.fill(0, 0, n); Lf.fill(0, 0, n); Ll.fill(0, 0, n); D.fill(0, 0, n);
      for (let k = 0; k < m; k++) {
        const i = cI[k]!, j = cJ[k]!, kt = kT[k]!;
        if (j < i) { iI[k] = kt; Lt[i]! += kt; Ll[i]! += kt; if (rap[i]) Lf[i]! += kt; continue; }
        if (j === i) { const l = pI[k]! * kt * xs[i]! / V; iI[k] = l; Lt[i]! += l; Ll[i]! += l; continue; }
        // Un compañero lento entra con su punto medio; uno instantáneo, con lo que tiene al empezar (decae aparte).
        const li = pI[k]! * kt * (rap[j] ? xs[j]! : med[j]!) / V, lj = pJ[k]! * kt * (rap[i] ? xs[i]! : med[i]!) / V;
        iI[k] = li; iJ[k] = lj; Lt[i]! += li; Lt[j]! += lj;
        if (!rap[j]) { Ll[i]! += li; if (rap[i]) Lf[i]! += li; }
        if (!rap[i]) { Ll[j]! += lj; if (rap[j]) Lf[j]! += lj; }
      }
      for (let s = 0; s < n; s++) B[s] = rap[s] ? xs[s]! * -expm1(-Lt[s]! * dt) : 0;
      // Canales de ritmo variable: ∫k·x_a(t)·x_b(t)/V dt con x = x0·e^(−Λt), descontados de lo que pierde cada uno.
      for (let k = 0; k < m; k++) {
        const i = cI[k]!, j = cJ[k]!;
        ex[k] = 0;
        if (j < i || !rap[i] || (j > i && !rap[j])) continue;
        const L2 = j === i ? 2 * Lt[i]! : Lt[i]! + Lt[j]!;
        const e = kT[k]! * xs[i]! * xs[j]! / V * -expm1(-L2 * dt) / L2;
        ex[k] = e; B[i]! -= pI[k]! * e;
        if (j > i) B[j]! -= pJ[k]! * e;
      }
      for (let k = 0; k < m; k++) {
        const i = cI[k]!, j = cJ[k]!;
        if (j < i) { if (rap[i] && Lf[i]! > 0) ex[k] = Math.max(0, B[i]!) * iI[k]! / Lf[i]! / pI[k]!; continue; }
        if (j === i || rap[i] === rap[j]) continue;
        const s = rap[i] ? i : j, r = rap[i] ? j : i;
        const l = s === i ? iI[k]! : iJ[k]!, p = s === i ? pI[k]! : pJ[k]!;
        const e = Lf[s]! > 0 ? Math.max(0, B[s]!) * l / Lf[s]! / p : 0;
        ex[k] = e; D[r]! += (r === i ? pI[k]! : pJ[k]!) * e;
      }
      for (let s = 0; s < n; s++) if (!rap[s]) med[s] = Math.max(0, xs[s]! - D[s]! / 2);
    }
    let quita = false;
    for (let s = 0; s < n; s++) if (rap[s] && Lt[s]! - Lf[s]! > VARIABLE * Lt[s]!) { rap[s] = 0; quita = true; }
    for (let k = 0; k < m; k++) {
      const i = cI[k]!, j = cJ[k]!;
      if (j <= i || rap[i] === rap[j]) continue;
      const s = rap[i] ? i : j, r = rap[i] ? j : i;
      if (D[r]! > SUBPASO * xs[r]! || Ll[r]! > VARIABLE * Lt[s]!) { rap[s] = 0; quita = true; }
    }
    if (!quita) break;
    alguno = false;
    for (let s = 0; s < n; s++) if (rap[s]) alguno = true;
  }
  if (!alguno) return false;
  consumir(m, n, xs, xs);
  // Lo que queda de un instantáneo es e^(−Λ·dt) de lo que había (nada): sin restas que dejen el redondeo vivo.
  for (let s = 0; s < n; s++) if (rap[s]) xs[s] = cant[s]! * Math.exp(-Lt[s]! * dt);
  return true;
}

/** Contadores del integrador en este hilo (los lee el banco): integraciones, cuántas con algún reactivo compartido y
 * subpasos que dieron esas. */
export const cuentaIntegrador = { integraciones: 0, compartidas: 0, subpasos: 0, instantaneas: 0 };

/** Medias de veces de cada canal en dt, en `xi`: un paso si ningún reactivo se comparte; si no, subpasos (cabecera). */
function integrar(m: number, n: number, V: number, dt: number): void {
  const cI = canalI, cJ = canalJ, pI = nuI, pJ = nuJ, kT = kTick, xs = x, ritmo = consumo, us = usos, acum = xi;
  for (let s = 0; s < n; s++) xs[s] = cant[s]!;
  acum.fill(0, 0, m);
  let compite = false;
  for (let s = 0; s < n; s++) if (us[s]! > 1) compite = true;
  cuentaIntegrador.integraciones++;
  if (!compite) {
    extensiones(m, n, V, dt, xs, xs);
    for (let k = 0; k < m; k++) acum[k] = ext[k]!;
    return;
  }
  cuentaIntegrador.compartidas++;
  if (instantaneos(m, n, V, dt)) {
    cuentaIntegrador.instantaneas++;
    for (let k = 0; k < m; k++) acum[k] = ext[k]!;
  }
  let resta = dt;
  for (let pasos = 1; resta > 0; pasos++) {
    cuentaIntegrador.subpasos++;
    ritmo.fill(0, 0, n);
    for (let k = 0; k < m; k++) {
      const i = cI[k]!, j = cJ[k]!;
      const r = j < i ? kT[k]! * xs[i]! : kT[k]! * xs[i]! * xs[j]! / V;
      ritmo[i]! += pI[k]! * r;
      if (j > i) ritmo[j]! += pJ[k]! * r;
    }
    // Ningún compañero vivo (x > AGOTADO) de un reactivo compartido y vivo pierde en h más de SUBPASO de lo que tiene.
    let h = resta;
    if (pasos < SUBPASOS_MAX) for (let k = 0; k < m; k++) {
      const i = cI[k]!, j = cJ[k]!;
      if (j > i) {
        const vi = xs[i]! > AGOTADO, vj = xs[j]! > AGOTADO;
        if (us[i]! > 1 && vi && vj && ritmo[j]! > 0) h = Math.min(h, SUBPASO * xs[j]! / ritmo[j]!);
        if (us[j]! > 1 && vj && vi && ritmo[i]! > 0) h = Math.min(h, SUBPASO * xs[i]! / ritmo[i]!);
      }
    }
    extensiones(m, n, V, h / 2, xs, xs);
    consumir(m, n, xs, xm);
    extensiones(m, n, V, h, xs, xm);
    consumir(m, n, xs, xs);
    const ex = ext;
    for (let k = 0; k < m; k++) acum[k]! += ex[k]!;
    resta = h === resta ? 0 : resta - h;
  }
}

/**
 * Avanza `dt` ticks las reacciones de `l` con la catálisis `kappa` y devuelve cuántas veces se aplicaron en total
 * (suma en number: es un contador, no un balance). Un pase principal evalúa a la vez todos los canales (pares i ≤ j y
 * cada sustancia sola) con las cantidades del inicio del paso; después, hasta PASES_ENCADENADOS pases encadenados dan a
 * lo producido en el pase anterior el tiempo que de media le queda (ventanas dt/2, dt/4, …): solo los canales con algún
 * reactivo nuevo, que entra con lo que se produjo (los demás, con lo que hay). La T y el nivel son los del inicio del
 * paso en todos los pases (el calor que suelta o pide el paso cambia la T del siguiente, como antes); V, con lo que hay.
 * Por qué (validación de la enmienda 3, hallazgo 7): en un suelo denso el H₂ que nace de 2 glicósido → 2 H₂ + C + CO₂ o
 * de H₂O + 2 orgP salía por `fluir` antes de que el propio suelo, que lo oxida sin barrera, lo viera (le llegaba 1/1.001
 * del gas): la caja llegaba al 15,4 % del H en H₂. En un tick una bacteria del hidrógeno encuentra el H₂ que nace a su
 * lado muchas veces; sin encadenar, ninguna. No se cuentan dos veces: cada cuanto entra en un pase como viejo o como
 * nuevo, nunca en los dos; quedan fuera los encuentros de lo nuevo de a con lo viejo de b cuando b también es nuevo.
 * Con la T medida otra vez, un lote adiabático que arde (sin roca que se lleve el calor) disociaba en el mismo paso el
 * agua que acababa de hacer y la volvía a hacer en el pase siguiente, ocho veces; con la del inicio, no.
 */
export function pasoLote(c: CtxPaso, l: LoteRef, dt: number, kappa: Kappa): number {
  const { atomos, T, V } = medir(c, l);
  if (atomos === 0) return 0;
  const nivel = nivelDeLote(T, kappa);
  vaciarNuevos(); vaciarProducidos();
  let total = pase(c, l, dt, kappa, T, V, nivel, false);
  for (let p = 0, w = dt / 2; p < PASES_ENCADENADOS && nProducidos > 0; p++, w /= 2) {
    [nuevos, producidos] = [producidos, nuevos];
    [idsNuevos, idsProducidos] = [idsProducidos, idsNuevos];
    [nNuevos, nProducidos] = [nProducidos, nNuevos];
    vaciarProducidos();
    // Lo nuevo entra con lo que se produjo (nunca más de lo que hay); lo viejo, con lo que hay.
    const n = presentes = leerEspecies(c.arena, l);
    let vol = 0;
    for (let i = 0; i < n; i++) {
      const id = ids[i]!;
      cant[i] = c.arena.cuantos(l, id);
      vol += cant[i]! * volumenMolar(c.quimica, id, T);
      const nueva = id < nuevos.length && nuevos[id]! > 0;
      esNueva[i] = nueva ? 1 : 0;
      if (nueva) cant[i] = Math.min(cant[i]!, nuevos[id]!);
    }
    total += pase(c, l, w, kappa, T, vol, nivel, true);
  }
  vaciarNuevos(); vaciarProducidos();
  return total;
}

function vaciarNuevos(): void {
  for (let k = 0; k < nNuevos; k++) nuevos[idsNuevos[k]!] = 0;
  nNuevos = 0;
}
function vaciarProducidos(): void {
  for (let k = 0; k < nProducidos; k++) producidos[idsProducidos[k]!] = 0;
  nProducidos = 0;
}

/** Anota en `producidos` las salidas de `v` veces de `r` (v > 0). */
function producir(r: Reaccion, v: number): void {
  if (!(v > 0)) return;
  for (const t of r.salidas) {
    const id = t.id;
    if (id >= producidos.length) {
      const b = new Float64Array(Math.max(2 * producidos.length, id + 1));
      b.set(producidos);
      producidos = b;
    }
    if (producidos[id] === 0) {
      if (nProducidos === idsProducidos.length) { const b = new Uint32Array(2 * nProducidos); b.set(idsProducidos); idsProducidos = b; }
      idsProducidos[nProducidos++] = id;
    }
    producidos[id]! += v * t.nu;
  }
}

/**
 * Un pase de `pasoLote` en una ventana de `dt` ticks sobre las `presentes` sustancias de `ids` con sus cuantos en `cant`;
 * `encadenado`: solo canales con algún reactivo nuevo (`esNueva`).
 */
function pase(c: CtxPaso, l: LoteRef, dt: number, kappa: Kappa, T: number, V: number, nivel: number, encadenado: boolean): number {
  const { arena, quimica } = c;
  const n = presentes;
  quimicaPase = quimica;
  usos.fill(0, 0, n);
  let m = 0;
  for (let i = 0; i < n; i++) for (let j = i - 1; j < n; j++) {
    if (encadenado && !esNueva[i] && (j <= i || !esNueva[j])) continue;
    if (j === i && cant[i]! < 2) continue;
    const a: SustanciaId = ids[i]!, b: SustanciaId = j < i ? 0 : ids[j]!;
    const r = quimica.reaccion(a, b, nivel);
    if (!r) continue; // null: no reaccionan; undefined: encolada para la barrera siguiente
    // Coeficientes de la reacción para los reactivos del canal (contrato de `Reaccion`): otra forma es un fallo de Q.
    let pa = 0, pb = 0;
    for (const t of r.entradas) {
      if (t.id === a && pa === 0) pa = t.nu;
      else if (j > i && t.id === b && pb === 0) pb = t.nu;
      else pa = -1;
    }
    if (!(pa >= 1 && (j <= i || pb >= 1) && Number.isSafeInteger(pa) && Number.isSafeInteger(pb))) {
      throw new Error(`Reacción (${r.a}, ${r.b}) con entradas que no son las del canal (${a}, ${b}).`);
    }
    if (cant[i]! < pa || (j > i && cant[j]! < pb)) continue; // ni una vez entera
    if (!favorableA(r, T, sustanciaPase)) continue; // ΔG a la T y fases reales del lote (revisión de la enmienda 3, hallazgo 5)
    const barrera = barreraEfectiva(r, kappa);
    const k = barrera === 0 ? NU : T > 0 ? NU * Math.exp(-barrera / (R * T)) : 0;
    if (!(k * dt > 0)) continue;
    if (m === canalI.length) crecerCanales();
    canales[m] = r; canalI[m] = i; canalJ[m] = j; nuI[m] = pa; nuJ[m] = pb; kTick[m] = k;
    usos[i]!++;
    if (j > i) usos[j]!++;
    m++;
  }
  if (m === 0) return 0;
  integrar(m, n, V, dt);
  // Quién sortea cada canal a + b: el reactivo cuyo sorteo menos arriesga pedirle al otro más de lo que le sobra de media.
  // El sorteo del canal k por s es una binomial de cant_s/ν_s grupos con p = ν_s·ξ_k/cant_s (la marginal de la
  // multinomial de s), de desviación σ_s; lo que sobra del otro, r, es su holgura E_r = cant_r − Σ ν·ξ. Sortea el de mayor
  // z = E_r/(ν_r·σ_s) (σ_s = 0: sin ruido, z infinito); a igualdad, el más gastado y luego el de menos cuantos. Cuando uno
  // de los dos es escaso y el otro sobra, es el escaso, como antes (z ≫ 1 frente a z ~ 1). Cuando los dos se agotan, el
  // que se reparte entre menos canales: su p ≈ 1 no tiene ruido. Antes sorteaba siempre el más gastado, y en 10⁶ H₂ +
  // 10⁶ CH₄ + 2,5·10⁶ O₂ saturados (revisión de la enmienda 3, hallazgo 4) el O₂, gastado en 10⁻¹¹ más que el CH₄,
  // sorteaba su canal con p = 0,8 (σ ≈ 450 veces) y el recorte dejaba cientos de combustiones sin hacer.
  H.fill(0, 0, n); // aquí: fracción media que se gasta de cada sustancia
  L.fill(0, 0, n); // aquí: cuantos que se gastan de media de cada sustancia
  for (let k = 0; k < m; k++) {
    const i = canalI[k]!, j = canalJ[k]!;
    H[i]! += nuI[k]! * xi[k]! / cant[i]!;
    L[i]! += nuI[k]! * xi[k]!;
    if (j > i) { H[j]! += nuJ[k]! * xi[k]! / cant[j]!; L[j]! += nuJ[k]! * xi[k]!; }
  }
  inicio.fill(0, 0, n + 1);
  for (let k = 0; k < m; k++) {
    const i = canalI[k]!, j = canalJ[k]!;
    let g = i;
    if (j > i) {
      const zi = holguraEnSigmas(j, nuJ[k]!, i, nuI[k]!, xi[k]!), zj = holguraEnSigmas(i, nuI[k]!, j, nuJ[k]!, xi[k]!);
      if (zj > zi || (zj === zi && (H[j]! > H[i]! || (H[j] === H[i] && cant[j]! < cant[i]!)))) g = j;
    }
    gobierna[k] = g;
    inicio[g + 1]!++;
  }
  for (let s = 0; s < n; s++) inicio[s + 1]! += inicio[s]!;
  consumo.fill(0, 0, n); // aquí: siguiente hueco de cada grupo
  for (let k = 0; k < m; k++) { const g = gobierna[k]!; orden[inicio[g]! + consumo[g]!] = k; consumo[g]!++; }
  // Multinomial por reactivo con binomiales condicionadas: el canal k se lleva la fracción ν·ξ_k/cant de sus cuantos,
  // en grupos enteros de ν (una vez cada uno). a + a va al final y sortea grupos de ν de los que quedan (sortear cuantos
  // y descartar el resto sesgaba, I5).
  for (let s = 0; s < n; s++) {
    let quedan = cant[s]!, resto = 1;
    const kAa = aa[s]!; // de la última `extensiones`; a + a siempre lo sortea su único reactivo
    for (let o = inicio[s]!; o < inicio[s + 1]!; o++) {
      const k = orden[o]!;
      if (k === kAa) continue;
      const nu = nuDe(k, s), parte = nu * xi[k]! / cant[s]!;
      const v = binomial(Math.floor(quedan / nu), Math.min(1, parte / resto), c.azar);
      veces[k] = v; quedan -= nu * v; resto -= parte;
    }
    if (kAa >= 0) {
      const nu = nuI[kAa]!;
      veces[kAa] = binomial(Math.floor(quedan / nu), Math.min(1, nu * xi[kAa]! / cant[s]! / resto), c.azar);
    }
  }
  // Recorte a existencias: un reactivo que no sortea puede quedar pedido de más por canales que sortean otros.
  consumo.fill(0, 0, n); // aquí: demanda
  for (let k = 0; k < m; k++) {
    consumo[canalI[k]!]! += nuI[k]! * veces[k]!;
    if (canalJ[k]! > canalI[k]!) consumo[canalJ[k]!]! += nuJ[k]! * veces[k]!;
  }
  let falta = false;
  for (let s = 0; s < n; s++) if (consumo[s]! > cant[s]!) falta = true;
  if (falta) {
    for (let k = 0; k < m; k++) {
      const i = canalI[k]!, j = canalJ[k]!;
      const f = Math.min(1, cant[i]! / consumo[i]!, j > i ? cant[j]! / consumo[j]! : 1);
      pedidas[k] = veces[k]!; veces[k] = Math.floor(veces[k]! * f);
    }
    x.set(cant.subarray(0, n)); // aquí: lo que queda
    for (let k = 0; k < m; k++) {
      const i = canalI[k]!, j = canalJ[k]!;
      x[i]! -= nuI[k]! * veces[k]!;
      if (j > i) x[j]! -= nuJ[k]! * veces[k]!;
    }
    // Lo que el recorte quitó a los canales que sortea s se vuelve a sortear entre los de s que no se recortaron, con sus
    // partes y hasta lo que quede de su compañero: el O₂ que el H₂ agotado no pudo tomar va al CH₄ que aún hay (revisión
    // de la enmienda 3, hallazgo 4; antes quedaba sin reaccionar hasta el paso siguiente, ~σ del sorteo).
    for (let s = 0; s < n; s++) {
      let libre = 0, resto = 0;
      for (let o = inicio[s]!; o < inicio[s + 1]!; o++) {
        const k = orden[o]!, nu = nuDe(k, s);
        libre += nu * (pedidas[k]! - veces[k]!);
        if (veces[k] === pedidas[k]) resto += nu * xi[k]! / cant[s]!;
      }
      if (!(libre > 0 && resto > 0)) continue;
      let quedan = Math.min(libre, x[s]!);
      for (let o = inicio[s]!; o < inicio[s + 1]! && quedan > 0; o++) {
        const k = orden[o]!;
        if (veces[k] !== pedidas[k]) continue;
        const i = canalI[k]!, j = canalJ[k]!, nu = nuDe(k, s), parte = nu * xi[k]! / cant[s]!;
        const r = j > i ? (s === i ? j : i) : -1, nuR = r < 0 ? 0 : nuDe(k, r);
        let v = binomial(Math.floor(quedan / nu), Math.min(1, parte / resto), c.azar);
        if (r >= 0) v = Math.min(v, Math.floor(x[r]! / nuR));
        veces[k]! += v; pedidas[k]! += v; x[s]! -= nu * v; quedan -= nu * v; resto -= parte;
        if (r >= 0) x[r]! -= nuR * v;
      }
    }
    // Lo que el redondeo hacia abajo dejó libre, una vez más por canal en orden de id: sin esto, dos canales que piden
    // el último cuanto se lo negarían los dos para siempre.
    for (let k = 0; k < m; k++) {
      const i = canalI[k]!, j = canalJ[k]!, p = nuI[k]!, q = nuJ[k]!;
      if (veces[k]! < pedidas[k]! && x[i]! >= p && (j <= i || x[j]! >= q)) {
        veces[k]!++; x[i]! -= p;
        if (j > i) x[j]! -= q;
      }
    }
  }
  // Calor: primero las exotérmicas; las endotérmicas se reparten lo que haya después, en proporción y luego en orden de id.
  let total = 0, calor = arena.calor(l), pide = 0;
  for (let k = 0; k < m; k++) {
    const r = canales[k]!;
    if (r.dH > 0) pide += veces[k]! * r.dH;
    else if (veces[k]! > 0) { const v = arena.aplicar(l, r, veces[k]!); total += v; calor -= v * r.dH; producir(r, v); }
  }
  if (pide > calor) {
    const f = calor / pide;
    for (let k = 0; k < m; k++) {
      const dH = canales[k]!.dH;
      if (dH <= 0) continue;
      pedidas[k] = veces[k]!; veces[k] = Math.floor(veces[k]! * f); calor -= veces[k]! * dH;
    }
    for (let k = 0; k < m; k++) {
      const dH = canales[k]!.dH;
      if (dH > 0 && veces[k]! < pedidas[k]! && calor >= dH) { veces[k]!++; calor -= dH; }
    }
  }
  for (let k = 0; k < m; k++) {
    if (canales[k]!.dH > 0 && veces[k]! > 0) { const v = arena.aplicar(l, canales[k]!, veces[k]!); total += v; producir(canales[k]!, v); }
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
