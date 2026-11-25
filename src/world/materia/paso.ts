/**
 * Cinética de un lote (ARQ-materia §3.1, carril P): cada par de sustancias presentes, y cada una sola, avanza la reacción
 * que da la química con tasa de Arrhenius y un número entero de veces. Todo cambio pasa por `ArenaMateria.aplicar`, que
 * conserva átomos y energía exactos (I2); aquí solo se decide cuántas veces.
 *
 * Enmienda 1 (contrato de `Reaccion`): la barrera es max(0, ea − κ[catalisis], dH), así que ningún catalizador la baja
 * por debajo de dH; y una vez consume ν_a de a y ν_b de b con los coeficientes que elige Q (2 H₂ + O₂ → 2 H₂O). Las
 * veces por tick son k·n_a·n_b/V (a + b), k·n_a²/V (a + a) y k·n_a (a sola) sean cuales sean los ν: los coeficientes son
 * estequiométricos, no órdenes cinéticos (el ritmo lo ponen los encuentros de un a con un b). En unidades de vez
 * (α = n_a/ν_a, β = n_b/ν_b) un a + b es el problema 1:1 con constante ν_a·ν_b·k, así que la forma cerrada no cambia.
 *
 * Diferencias con el pseudocódigo de §3.1, todas por necesidad:
 * - Cada canal da en forma cerrada (primer orden, segundo orden con reactivos distintos o iguales) el riesgo integrado
 *   h = −ln(fracción que sobrevive) de sus reactivos, así que una constante enorme (κ ≥ ea: k = ν; o k·dt ≫ 1) agota el
 *   reactivo limitante sin pasarse. Los canales que comparten un reactivo compiten: sobrevive e^(−Σh) y lo consumido se
 *   reparte según el riesgo instantáneo de cada canal; con un a + a entre ellos, por la solución cerrada de Bernoulli
 *   (`extensiones`). Es exacto con canales que no comparten reactivo y con competidores cuyo compañero no se gasta (pseudo
 *   primer orden: el O₂ del suelo entre muchas sustancias orgánicas). Si el compañero de un competidor también se gasta,
 *   las proporciones cambian dentro de dt y el paso se parte en subpasos en los que ningún compañero pierde más de la
 *   mitad, con el reparto del punto medio (orden 2), hasta que le queda medio cuanto (`AGOTADO`; un canal saturado
 *   necesita ~log₂ n subpasos). Frente a la EDO integrada fina (combustión contra dimerización, 12 regímenes con k hasta
 *   ν y hasta 10¹² cuantos) queda dentro del 5 %; repartir las demandas ya saturadas, como antes, daba a la combustión 60
 *   veces lo que le toca.
 * - ξ no sale de redondear con un uniforme: los cuantos de cada reactivo se sortean entre sus canales en una multinomial
 *   con las medias de la integración, que es la suma de las de las mitades del lote (I5); a + a sortea pares enteros.
 * - Lo sorteado se recorta antes de aplicar, en proporción y en orden de id (nunca en el de las ranuras), a lo que hay de
 *   cada reactivo y al calor que pagan las endotérmicas tras sumar el que sueltan las exotérmicas del mismo paso.
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

/** J por cuanto de rebaja de barrera por familia (C–O, C–N, C–C/C–H/H–H), como `Plantilla.kappa`; la pone el rol del lote. */
export type Kappa = readonly [number, number, number];

/** kPa: un cuanto de gas ocupa R·T/ATMOSFERA litros a la presión de una atmósfera. */
const ATMOSFERA = 101.325;
const MG_POR_KG = 1e6;
/** Fracción que un compañero de un competidor puede perder en un subpaso. */
const SUBPASO = 0.5;
/** Cuantos (absolutos) por debajo de los cuales un reactivo ya no se vigila: lo que queda no llega a una vez. Antes era
 * una fracción (10⁻⁴ de lo que había) y un canal saturado (k = ν) con un compañero compartido dejaba ese resto sin
 * gastar: el último subpaso reparte por el punto medio, donde ya no queda reactivo, y el compañero le daba 0. */
const AGOTADO = 0.5;
/** Tope de subpasos: medio cuanto desde 2⁵³ son 54 mitades; si se llegara, lo que falta va en uno. */
const SUBPASOS_MAX = 200;

/** Litros que ocupa un cuanto: gas ideal desde su ebullición, si no su densidad en fase condensada. */
const volumenMolar = (s: Readonly<Sustancia>, T: number): number =>
  T >= s.prop.tEbullicion ? R * T / ATMOSFERA : s.masa / (s.prop.densidad * MG_POR_KG);

const atomosDe = (s: Readonly<Sustancia>): number => {
  let n = 0;
  for (let e = 0; e < s.atomos.length; e++) n += s.atomos[e]!;
  return n;
};

// Búferes del hilo (cada worker tiene su propia copia del módulo).
// Por sustancia, en orden de id: cuantos, media en curso y en el punto medio, riesgo integrado H y riesgo instantáneo
// (L en el estado del reparto, L0 en el de partida) de sus canales que no son a + a, su canal a + a, lo que gastan en el
// subpaso unos y otro, consumo por tick, canales que la usan y grupos de sorteo.
let ids = new Uint32Array(16);
let cant = new Float64Array(16), x = new Float64Array(16), xm = new Float64Array(16), H = new Float64Array(16);
let L = new Float64Array(16), L0 = new Float64Array(16), aa = new Int32Array(16);
let gastoLineal = new Float64Array(16), gastoAa = new Float64Array(16);
let consumo = new Float64Array(16), usos = new Int32Array(16), inicio = new Int32Array(17);
// Por canal: sus reactivos (j = i − 1: sola; j = i: a + a) y sus coeficientes ν, su reacción y k por tick; riesgos
// integrados e instantáneos por reactivo; extensión del subpaso y acumulada; quién lo sortea, orden de sorteo, veces y
// veces antes de recortar.
let canales: (Reaccion | null)[] = [];
let canalI = new Int32Array(16), canalJ = new Int32Array(16), nuI = new Int32Array(16), nuJ = new Int32Array(16);
let gobierna = new Int32Array(16), orden = new Int32Array(16);
let kTick = new Float64Array(16), hI = new Float64Array(16), hJ = new Float64Array(16);
let lI = new Float64Array(16), lJ = new Float64Array(16), l0I = new Float64Array(16), l0J = new Float64Array(16);
let ext = new Float64Array(16), xi = new Float64Array(16), veces = new Float64Array(16), pedidas = new Float64Array(16);

function leerEspecies(arena: ArenaMateria, l: LoteRef): number {
  let n = arena.especies(l, ids);
  if (n > ids.length) {
    const t = 2 * n;
    ids = new Uint32Array(t); cant = new Float64Array(t); x = new Float64Array(t); xm = new Float64Array(t);
    H = new Float64Array(t); L = new Float64Array(t); L0 = new Float64Array(t); aa = new Int32Array(t);
    gastoLineal = new Float64Array(t); gastoAa = new Float64Array(t);
    consumo = new Float64Array(t); usos = new Int32Array(t); inicio = new Int32Array(t + 1);
    n = arena.especies(l, ids);
  }
  ids.subarray(0, n).sort(); // orden de id: nada depende de en qué ranura esté cada sustancia
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
    atomos += cant[i]! * atomosDe(c.quimica.sustancia(ids[i]!));
  }
  const T = atomos > 0 ? c.arena.calor(l) / (CAPACIDAD_ATOMO * atomos) : 0;
  let V = 0;
  for (let i = 0; i < n; i++) V += cant[i]! * volumenMolar(c.quimica.sustancia(ids[i]!), T);
  estado.atomos = atomos; estado.T = T; estado.V = V;
  return estado;
}

/** Cuántos cuantos de su reactivo s consume una vez el canal k (ν de la reacción; s es uno de sus reactivos). */
const nuDe = (k: number, s: number): number => (canalI[k] === s ? nuI[k]! : nuJ[k]!);

/** Parte del canal k (no a + a) entre los de s que no son a + a: por su riesgo en el punto medio, o en el de partida si
 * allí ya no queda compañero. */
const reparto = (s: number, l: number, l0: number): number => (L[s]! > 0 ? l / L[s]! : L0[s]! > 0 ? l0 / L0[s]! : 0);

/**
 * Extensión media (veces) de cada canal en un subpaso h: riesgos integrados desde `xa`; reparto con los riesgos de `xb`.
 * Lo que se gasta de s: sin a + a, sobrevive e^(−H). Con a + a (β = ν·k·h/V) y el resto de canales con riesgo por
 * cuanto μ (Bernoulli: dA/dτ = −μA − βA²) quedan μ·A0·e^(−μ)/(μ + β·A0·(1 − e^(−μ))), y los canales de μ se llevan
 * (μ/β)·ln(1 + β·A0·(1 − e^(−μ))/μ). Así a + a compite sin subpasos con los de compañero que no se gasta.
 */
function extensiones(m: number, n: number, V: number, h: number, xa: Float64Array, xb: Float64Array): void {
  H.fill(0, 0, n); L.fill(0, 0, n); L0.fill(0, 0, n); aa.fill(-1, 0, n);
  for (let k = 0; k < m; k++) {
    const i = canalI[k]!, j = canalJ[k]!, kt = kTick[k]! * h, s = kt / V, na = xa[i]!;
    if (j < i) { hI[k] = lI[k] = l0I[k] = kt; }
    else if (j === i) { aa[i] = k; lI[k] = nuI[k]! * s; continue; }
    else {
      // dξ/dt = k·(na − p·ξ)(nb − q·ξ)/V = p·q·k·(α − ξ)(β − ξ)/V con α = na/p y β = nb/q, cerrada. Con s′ = p·q·s y
      // e = 1 − e^(−d·s′) sobreviven d(1 − e)/(d + lo·e) del menor (en veces) y d/(d + lo·e) del mayor; con d = 0,
      // 1/(1 + lo·s′) de los dos.
      const p = nuI[k]!, q = nuJ[k]!, nb = xa[j]!, alfa = na / p, beta = nb / q, s2 = p * q * s;
      const lo = Math.min(alfa, beta), d = Math.abs(alfa - beta);
      let hMenor: number, hMayor: number;
      if (d === 0) hMenor = hMayor = Math.log1p(lo * s2);
      else {
        const e = -Math.expm1(-d * s2);
        hMayor = Math.log1p(lo * e / d); hMenor = hMayor + d * s2;
      }
      hI[k] = alfa <= beta ? hMenor : hMayor; hJ[k] = alfa <= beta ? hMayor : hMenor;
      // Riesgo instantáneo por cuanto: a pierde p por vez, a ritmo k·b/V por cuanto de a.
      lI[k] = p * xb[j]! * s; lJ[k] = q * xb[i]! * s; l0I[k] = p * nb * s; l0J[k] = q * na * s;
      H[j]! += hJ[k]!; L[j]! += lJ[k]!; L0[j]! += l0J[k]!;
    }
    H[i]! += hI[k]!; L[i]! += lI[k]!; L0[i]! += l0I[k]!;
  }
  for (let s = 0; s < n; s++) {
    const A0 = xa[s]!;
    gastoLineal[s] = gastoAa[s] = 0;
    if (A0 === 0) continue;
    if (aa[s]! < 0) { gastoLineal[s] = A0 * -Math.expm1(-H[s]!); continue; }
    const beta = lI[aa[s]!]!, mu = L[s]! > 0 ? L[s]! : L0[s]!;
    let fin: number;
    if (mu === 0) fin = A0 / (1 + beta * A0);
    else {
      const e = -Math.expm1(-mu);
      fin = mu * A0 * (1 - e) / (mu + beta * A0 * e);
      gastoLineal[s] = beta * A0 > 0 ? mu / beta * Math.log1p(beta * A0 * e / mu) : A0 * e;
    }
    gastoAa[s] = Math.max(0, A0 - fin - gastoLineal[s]!);
  }
  for (let k = 0; k < m; k++) {
    const i = canalI[k]!, j = canalJ[k]!;
    if (j === i) { ext[k] = gastoAa[i]! / nuI[k]!; continue; }
    let e = gastoLineal[i]! * reparto(i, lI[k]!, l0I[k]!) / nuI[k]!;
    if (j > i) e = Math.min(e, gastoLineal[j]! * reparto(j, lJ[k]!, l0J[k]!) / nuJ[k]!);
    ext[k] = e;
  }
}

/** `destino` = `desde` menos lo que consumen las extensiones `ext` (sin bajar de 0). */
function consumir(m: number, n: number, desde: Float64Array, destino: Float64Array): void {
  if (destino !== desde) destino.set(desde.subarray(0, n));
  for (let k = 0; k < m; k++) {
    const i = canalI[k]!, j = canalJ[k]!;
    destino[i] = Math.max(0, destino[i]! - nuI[k]! * ext[k]!);
    if (j > i) destino[j] = Math.max(0, destino[j]! - nuJ[k]! * ext[k]!);
  }
}

/** Medias de veces de cada canal en dt, en `xi`: un paso si ningún reactivo se comparte; si no, subpasos (cabecera). */
function integrar(m: number, n: number, V: number, dt: number): void {
  x.set(cant.subarray(0, n));
  xi.fill(0, 0, m);
  let compite = false;
  for (let s = 0; s < n; s++) if (usos[s]! > 1) compite = true;
  if (!compite) { extensiones(m, n, V, dt, x, x); xi.set(ext.subarray(0, m)); return; }
  const vivo = (s: number) => x[s]! > AGOTADO;
  let resta = dt;
  for (let pasos = 1; resta > 0; pasos++) {
    consumo.fill(0, 0, n);
    for (let k = 0; k < m; k++) {
      const i = canalI[k]!, j = canalJ[k]!;
      const r = j < i ? kTick[k]! * x[i]! : kTick[k]! * x[i]! * x[j]! / V;
      consumo[i]! += nuI[k]! * r;
      if (j > i) consumo[j]! += nuJ[k]! * r;
    }
    let h = resta;
    const vigilar = (p: number) => { if (vivo(p) && consumo[p]! > 0) h = Math.min(h, SUBPASO * x[p]! / consumo[p]!); };
    if (pasos < SUBPASOS_MAX) for (let k = 0; k < m; k++) {
      const i = canalI[k]!, j = canalJ[k]!;
      if (j > i) {
        if (usos[i]! > 1 && vivo(i)) vigilar(j);
        if (usos[j]! > 1 && vivo(j)) vigilar(i);
      }
    }
    extensiones(m, n, V, h / 2, x, x);
    consumir(m, n, x, xm);
    extensiones(m, n, V, h, x, xm);
    consumir(m, n, x, x);
    for (let k = 0; k < m; k++) xi[k]! += ext[k]!;
    resta = h === resta ? 0 : resta - h;
  }
}

/**
 * Avanza `dt` ticks las reacciones de `l` con la catálisis `kappa` y devuelve cuántas veces se aplicaron en total
 * (suma en number: es un contador, no un balance). Todos los canales (pares i ≤ j y cada sustancia sola) se evalúan a la
 * vez con las cantidades del inicio del paso.
 */
export function pasoLote(c: CtxPaso, l: LoteRef, dt: number, kappa: Kappa): number {
  const { arena, quimica } = c;
  const { atomos, T, V } = medir(c, l);
  if (atomos === 0) return 0;
  const n = presentes;
  const nivel = nivelDeT(T);
  usos.fill(0, 0, n);
  let m = 0;
  for (let i = 0; i < n; i++) for (let j = i - 1; j < n; j++) {
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
    const familia = r.catalisis;
    const barrera = Math.max(0, r.ea - (familia === -1 ? 0 : kappa[familia]), r.dH);
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
  // Cada canal lo sortea su reactivo más gastado (a igualdad, el de menos cuantos). Agrupados con un conteo: O(n + m).
  H.fill(0, 0, n); // aquí: fracción media que se gasta de cada sustancia
  for (let k = 0; k < m; k++) {
    const i = canalI[k]!, j = canalJ[k]!;
    H[i]! += nuI[k]! * xi[k]! / cant[i]!;
    if (j > i) H[j]! += nuJ[k]! * xi[k]! / cant[j]!;
  }
  inicio.fill(0, 0, n + 1);
  for (let k = 0; k < m; k++) {
    const i = canalI[k]!, j = canalJ[k]!;
    gobierna[k] = j > i && (H[j]! > H[i]! || (H[j] === H[i] && cant[j]! < cant[i]!)) ? j : i;
    inicio[gobierna[k]! + 1]!++;
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
    else if (veces[k]! > 0) { const v = arena.aplicar(l, r, veces[k]!); total += v; calor -= v * r.dH; }
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
  for (let k = 0; k < m; k++) if (canales[k]!.dH > 0 && veces[k]! > 0) total += arena.aplicar(l, canales[k]!, veces[k]!);
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
