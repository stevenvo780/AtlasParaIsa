import test from 'node:test';
import assert from 'node:assert/strict';
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { KAPPA0, KAPPA_SUELO, NU, R } from '../src/shared/naturaleza.js';
import { binomial, medir, pasoLote, type CtxPaso, type Kappa } from '../src/world/materia/paso.js';
import { fluir, fluirCalor } from '../src/world/materia/fluir.js';
import { pasarLotes } from '../src/world/materia/paso-worker.js';
import {
  ArenaDoble, PiscinaDoble, QuimicaDoble, RECETA, S, buffersArena, ctxDoble, type RecetaReaccion,
} from './lib/materia-doble.js';
import type { SustanciaId } from '../src/shared/materia.js';
import type { ArenaMateria, Reaccion, Sustancia } from '../src/world/materia/tipos.js';

const SIN: Kappa = [0, 0, 0];

/** KS de dos muestras con la p asintótica de Kolmogorov (Numerical Recipes); con empates es conservadora. */
function ks(x: number[], y: number[]): { d: number; p: number } {
  const a = [...x].sort((u, v) => u - v), b = [...y].sort((u, v) => u - v);
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    const v = Math.min(a[i]!, b[j]!);
    while (i < a.length && a[i] === v) i++;
    while (j < b.length && b[j] === v) j++;
    d = Math.max(d, Math.abs(i / a.length - j / b.length));
  }
  const ne = Math.sqrt(a.length * b.length / (a.length + b.length)), l = (ne + 0.12 + 0.11 / ne) * d;
  if (l < 0.3) return { d, p: 1 };
  let p = 0;
  for (let k = 1; k <= 100; k++) p += 2 * (k % 2 ? 1 : -1) * Math.exp(-2 * k * k * l * l);
  return { d, p: Math.min(1, Math.max(0, p)) };
}

/** Un lote (o varios) con lo que dice `contenido` (cuantos por sustancia) y su calor para la temperatura T. */
function lotes(partes: number, contenido: Partial<Record<keyof typeof S, number>>, T: number, quimica = new QuimicaDoble()) {
  const arena = new ArenaDoble(buffersArena(partes), quimica);
  for (let l = 0; l < partes; l++) for (const [nombre, q] of Object.entries(contenido)) arena.poner(l, S[nombre as keyof typeof S], q / partes);
  const c = ctxDoble(arena, 1);
  for (let l = 0; l < partes; l++) arena.ponerCalor(l, Math.round(0.025 * arena.atomos(l) * T));
  return { arena, c };
}

const solo = (...indices: number[]): RecetaReaccion[] => indices.map(i => RECETA[i]!);

test('I2: átomos y energía exactos tras reaccionar y fluir (enteros, sin un átomo ni un julio de diferencia)', () => {
  const arena = new ArenaDoble(buffersArena(6), new QuimicaDoble());
  const mezclas: [number, number, number, number, number, number][] = [ // A, O2, H2O, D, X, T
    [2000, 1500, 0, 0, 0, 700], [2 ** 40, 2 ** 39, 0, 0, 3 ** 20, 650], [0, 300, 5000, 0, 0, 295],
    [10, 0, 0, 7_000_001, 0, 900], [123_457, 99_999, 17, 3, 1, 1200], [0, 0, 0, 0, 2 ** 45, 310],
  ];
  mezclas.forEach(([a, o2, h2o, d, x, T], l) => {
    arena.poner(l, S.A, a); arena.poner(l, S.O2, o2); arena.poner(l, S.H2O, h2o); arena.poner(l, S.D, d); arena.poner(l, S.X, x);
    arena.ponerCalor(l, Math.round(0.025 * arena.atomos(l) * T));
  });
  const todos = [0, 1, 2, 3, 4, 5];
  const antes = arena.balance(todos);
  const c = ctxDoble(arena, 2026);
  const kappas: Kappa[] = [SIN, [KAPPA0, KAPPA0, KAPPA0], SIN, [0, 0, KAPPA0], [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO], [0, KAPPA0, 0]];
  let veces = 0, movidos = 0;
  for (let t = 0; t < 300; t++) {
    const dt = t % 3 === 0 ? 10 : 1;
    for (const l of todos) veces += pasoLote(c, l, dt, kappas[l]!);
    for (const [de, a] of [[0, 2], [2, 4], [4, 1], [3, 5]] as const) {
      for (const esp of [S.O2, S.CO2, S.H2O, S.Y]) movidos += Math.abs(fluir(c, de, a, esp, 0.05, 1e3 * (1 + de), 1e3 * (1 + a), 0, dt));
      movidos += Math.abs(fluirCalor(c, de, a, 3, dt));
    }
  }
  assert.ok(veces > 1e6 && movidos > 1e3, `hubo química (${veces}) y transporte (${movidos})`);
  assert.deepEqual(arena.balance(todos), antes);
  assert.equal(arena.recortes, 0, 'pasoLote nunca pide más de lo que hay');
});

test('I5: dividir un lote en dos mitades no cambia la distribución de productos (KS, p > 0,01)', () => {
  const replicas = 2000;
  const escenarios = [
    // Combustión exotérmica que compite por A con una dimerización rápida (reactivo compartido) y su inversa al calentarse.
    { nombre: 'combustión y dimerización, 3 ticks', contenido: { A: 2e6, O2: 1.5e6 }, T: 700, ticks: 3, kappa: SIN, mide: [S.CO2, S.D] },
    { nombre: 'combustión, 6 ticks', contenido: { A: 2e6, O2: 1.5e6 }, T: 700, ticks: 6, kappa: SIN, mide: [S.CO2] },
    // Primer orden casi isoterma (agua inerte). Con pocos cuantos por paso manda el ruido, y el de redondear cada canal
    // con un uniforme (§3.1) no crece con el lote: el segundo caso lo distingue (KS p ≈ 10⁻⁶ con 2.000 réplicas).
    { nombre: 'descomposición de primer orden', contenido: { X: 1e5, H2O: 1e7 }, T: 310, ticks: 4, kappa: [0, 30, 0] as Kappa, mide: [S.X] },
    { nombre: 'descomposición con pocos cuantos', contenido: { X: 2000, H2O: 2e6 }, T: 310, ticks: 40, kappa: [0, 30, 0] as Kappa, mide: [S.X] },
    // a + a con pocos cuantos (20 por mitad, agua líquida como baño): sortear cuantos y descartar el impar perdía de
    // media ¼ de vez por lote y paso, el doble con dos mitades.
    { nombre: 'dimerización con pocos cuantos', contenido: { A: 40, H2O: 1e6 }, T: 320, ticks: 10, kappa: [0, 0, 25] as Kappa, mide: [S.D] },
    { nombre: 'dimerización de cuatro cuantos', contenido: { A: 4, H2O: 1e6 }, T: 320, ticks: 1, kappa: [0, 0, 35] as Kappa, mide: [S.D] },
  ];
  for (const e of escenarios) {
    const muestras = [1, 2].map(partes => Array.from({ length: replicas }, (_, r) => {
      const { arena } = lotes(partes, e.contenido, e.T);
      const c = ctxDoble(arena, 7919 * r + 104_729 * partes);
      for (let t = 0; t < e.ticks; t++) for (let l = 0; l < partes; l++) pasoLote(c, l, 1, e.kappa);
      return e.mide.map(esp => { let q = 0; for (let l = 0; l < partes; l++) q += arena.cuantos(l, esp); return q; });
    }));
    e.mide.forEach((esp, k) => {
      assert.ok(muestras[0]!.some(v => v[k]! > 0), `${e.nombre}: reacciona`);
      const { d, p } = ks(muestras[0]!.map(v => v[k]!), muestras[1]!.map(v => v[k]!));
      assert.ok(p > 0.01, `${e.nombre}, sustancia ${esp}: KS D = ${d.toFixed(3)}, p = ${p.toExponential(2)}`);
    });
  }
});

test('extremo: con κ ≥ ea (k = ν) la reacción se completa en una llamada hasta el reactivo limitante', () => {
  // X → 2Y (C–N, ea 98) con κ del suelo (105) y 2⁴⁵ cuantos: con «partir dt» serían del orden de ν·dt = 10⁹ subpasos.
  const unaria = lotes(1, { X: 2 ** 45 }, 295, new QuimicaDoble(solo(3)));
  let t0 = performance.now();
  pasoLote(unaria.c, 0, 1, [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO]);
  const msUnaria = performance.now() - t0;
  assert.equal(unaria.arena.cuantos(0, S.X), 0);
  assert.equal(unaria.arena.cuantos(0, S.Y), 2 ** 46);
  // A + O₂ con la barrera anulada: el O₂ (limitante) se agota exacto y sobra el A.
  const par = lotes(1, { A: 1e12, O2: 4e11 }, 295, new QuimicaDoble(solo(0)));
  t0 = performance.now();
  pasoLote(par.c, 0, 1, [200, 0, 0]);
  const msPar = performance.now() - t0;
  assert.equal(par.arena.cuantos(0, S.O2), 0);
  assert.equal(par.arena.cuantos(0, S.A), 6e11);
  assert.equal(par.arena.cuantos(0, S.CO2), 4e11);
  assert.ok(msUnaria < 50 && msPar < 50, `coste acotado: ${msUnaria.toFixed(2)} y ${msPar.toFixed(2)} ms`);
});

test('extremo: k·dt ≫ 1 (κ₀ frente a C–N a 310 K, ~400/tick) agota el reactivo en un paso', () => {
  const k = NU * Math.exp(-(98 - KAPPA0) / (R * 310));
  assert.ok(k > 300 && k < 500, `k = ${k.toFixed(0)}/tick`);
  const { arena, c } = lotes(1, { X: 3 ** 30 }, 310, new QuimicaDoble(solo(3)));
  pasoLote(c, 0, 1, [0, KAPPA0, 0]);
  assert.equal(arena.cuantos(0, S.X), 0);
  assert.equal(arena.cuantos(0, S.Y), 2 * 3 ** 30);
});

test('extremo: barrera enorme, frío, sin calor, endotérmica recortada, lote vacío y química encolada', () => {
  // Combustión sin catálisis a 295 K: k ~ 10⁻²² por tick, nada en 1.000 ticks y sin NaN.
  const frio = lotes(1, { A: 1e9, O2: 1e9 }, 295, new QuimicaDoble(solo(0)));
  for (let t = 0; t < 1000; t++) pasoLote(frio.c, 0, 10, SIN);
  assert.equal(frio.arena.cuantos(0, S.CO2), 0);
  // T = 0 con barrera > 0: no reacciona.
  const cero = lotes(1, { A: 1e6, O2: 1e6 }, 0, new QuimicaDoble(solo(0)));
  assert.equal(pasoLote(cero.c, 0, 10, SIN), 0);
  // Y + Y → X es endotérmica (dH = +20): con k = ν solo avanza lo que paga el calor y el calor queda en 0, nunca negativo.
  const endo = lotes(1, { Y: 1e6 }, 1, new QuimicaDoble([{ a: S.Y, b: S.Y, salidas: [[S.X, 1]], ea: 98, catalisis: 1 }]));
  const calor = endo.arena.calor(0);
  assert.equal(pasoLote(endo.c, 0, 1, [0, KAPPA_SUELO, 0]), Math.floor(calor / 20));
  assert.equal(endo.arena.calor(0), calor % 20);
  assert.equal(endo.arena.recortes, 0, 'el recorte por calor lo hace pasoLote, no la arena');
  // Bordes de la tabla de niveles: a 5.000 K (ℓ = 15) D → 2A sin catálisis va a ~10⁸/tick; a 150 K (ℓ = 0) A + A con
  // la barrera anulada se dimeriza entero.
  const caliente = lotes(1, { D: 1e6 }, 5000);
  pasoLote(caliente.c, 0, 1, SIN);
  assert.equal(caliente.arena.cuantos(0, S.D), 0);
  assert.equal(caliente.arena.cuantos(0, S.A), 2e6);
  const helado = lotes(1, { A: 1e6 }, 150);
  pasoLote(helado.c, 0, 1, [0, 0, 90]);
  assert.equal(helado.arena.cuantos(0, S.D), 5e5);
  // Lotes de un cuanto: X → 2Y entero, A + O₂ con barrera 0 reacciona, un A solo no tiene con quién dimerizarse.
  const unX = lotes(1, { X: 1 }, 295, new QuimicaDoble(solo(3)));
  pasoLote(unX.c, 0, 1, [0, KAPPA_SUELO, 0]);
  assert.equal(unX.arena.cuantos(0, S.Y), 2);
  const unPar = lotes(1, { A: 1, O2: 1 }, 295, new QuimicaDoble(solo(0)));
  pasoLote(unPar.c, 0, 1, [200, 0, 0]);
  assert.equal(unPar.arena.cuantos(0, S.CO2), 1);
  const unA = lotes(1, { A: 1 }, 295, new QuimicaDoble(solo(1)));
  assert.equal(pasoLote(unA.c, 0, 1, [0, 0, 90]), 0);
  // Lote vacío.
  const vacio = lotes(1, {}, 300);
  assert.equal(pasoLote(vacio.c, 0, 1, SIN), 0);
  // Pares encolados en Q (undefined): no reaccionan este paso.
  const encolada = lotes(1, { X: 1000 }, 310, new QuimicaDoble(solo(3)));
  const q = encolada.arena.quimica;
  const c: CtxPaso = { ...encolada.c, quimica: { sustancia: id => q.sustancia(id), internar: () => 0, reaccion: () => undefined } };
  assert.equal(pasoLote(c, 0, 1, [0, KAPPA0, 0]), 0);
  assert.equal(encolada.arena.cuantos(0, S.X), 1000);
});

test('cadencia: un paso con dt = 10 da la misma distribución que diez de dt = 1, con la media de primer orden', () => {
  const kappa: Kappa = [0, 30, 0], n0 = 20_000, replicas = 400;
  const k = NU * Math.exp(-(98 - 30) / (R * 310));
  const correr = (pasos: number, dt: number, r: number) => {
    // 10⁷ de agua inerte: la reacción endotérmica apenas enfría el lote (0,02 K), así que k es la misma en los dos casos.
    const { arena } = lotes(1, { X: n0, H2O: 1e7 }, 310, new QuimicaDoble(solo(3)));
    const c = ctxDoble(arena, 31 * r + pasos);
    for (let t = 0; t < pasos; t++) pasoLote(c, 0, dt, kappa);
    return arena.cuantos(0, S.X);
  };
  const largo = Array.from({ length: replicas }, (_, r) => correr(1, 10, r));
  const corto = Array.from({ length: replicas }, (_, r) => correr(10, 1, r));
  const { d, p } = ks(largo, corto);
  assert.ok(p > 0.01, `KS D = ${d.toFixed(3)}, p = ${p.toExponential(2)}`);
  const media = largo.reduce((s, v) => s + v, 0) / replicas, teorica = n0 * Math.exp(-k * 10);
  const sigma = Math.sqrt(teorica * (1 - teorica / n0) / replicas);
  assert.ok(Math.abs(media - teorica) < 5 * sigma + 2, `media ${media.toFixed(1)} frente a ${teorica.toFixed(1)} ± ${sigma.toFixed(2)}`);
});

test('binomial: momentos en las dos ramas y enteros en [0, n] hasta 2⁵³ − 1', () => {
  const azar = ctxDoble(new ArenaDoble(buffersArena(1), new QuimicaDoble()), 99).azar;
  for (const [n, p] of [[40, 0.3], [1000, 0.05], [1000, 0.97], [1e6, 0.4], [1e12, 1e-11]] as const) {
    const veces = 50_000;
    let s = 0, s2 = 0;
    for (let i = 0; i < veces; i++) { const x = binomial(n, p, azar); s += x; s2 += x * x; }
    const media = s / veces, varianza = s2 / veces - media ** 2, v = n * p * (1 - p);
    assert.ok(Math.abs(media - n * p) < 5 * Math.sqrt(v / veces), `n=${n} p=${p}: media ${media} frente a ${n * p}`);
    assert.ok(Math.abs(varianza / v - 1) < 0.05, `n=${n} p=${p}: varianza ${varianza} frente a ${v}`);
  }
  for (let i = 0; i < 1000; i++) {
    const x = binomial(Number.MAX_SAFE_INTEGER, azar(), azar);
    assert.ok(Number.isSafeInteger(x) && x >= 0);
  }
});

test('competencia: canales que comparten reactivo conservan su diferencia de velocidad (frente a la EDO integrada fina)', () => {
  // Medias de 10 réplicas con dt = 1 frente a RK4 con pasos de ≤ 0,1 % de cambio, a T y V fijos como en pasoLote.
  const edo = (kc: number, kd: number, A0: number, O0: number, V: number): [number, number] => {
    let A = A0, O = O0, C = 0, D = 0, t = 0;
    const tasas = (a: number, o: number) => [kc * a * o / V, kd * a * a / V] as const;
    while (t < 1) {
      const [rc, rd] = tasas(A, O), dA = rc + 2 * rd;
      let h = 1 - t;
      if (A > 1e-9 && dA > 0) h = Math.min(h, 1e-3 * A / dA);
      if (O > 1e-9 && rc > 0) h = Math.min(h, 1e-3 * O / rc);
      const k1 = tasas(A, O);
      const k2 = tasas(Math.max(0, A - h / 2 * (k1[0] + 2 * k1[1])), Math.max(0, O - h / 2 * k1[0]));
      const k3 = tasas(Math.max(0, A - h / 2 * (k2[0] + 2 * k2[1])), Math.max(0, O - h / 2 * k2[0]));
      const k4 = tasas(Math.max(0, A - h * (k3[0] + 2 * k3[1])), Math.max(0, O - h * k3[0]));
      const c = h * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6, d = h * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
      A = Math.max(0, A - c - 2 * d); O = Math.max(0, O - c); C += c; D += d; t += h;
    }
    return [C, D];
  };
  const casos = [
    { nombre: 'parecidas', eaC: 60, eaD: 60, A: 1e6, O2: 1e6 },
    { nombre: 'dímero rápido', eaC: 70, eaD: 40, A: 1e6, O2: 1e6 },
    { nombre: 'O₂ escaso', eaC: 55, eaD: 55, A: 1e6, O2: 1e3 },
    { nombre: 'A escaso', eaC: 55, eaD: 55, A: 1e3, O2: 1e6 },
  ];
  for (const e of casos) {
    const q = new QuimicaDoble([
      { a: S.A, b: S.O2, salidas: [[S.CO2, 1], [S.H2O, 1]], ea: e.eaC, catalisis: -1 },
      { a: S.A, b: S.A, salidas: [[S.D, 1]], ea: e.eaD, catalisis: -1 },
    ]);
    let co2 = 0, d = 0, V = 0, T = 0;
    for (let r = 0; r < 10; r++) {
      const { arena } = lotes(1, { A: e.A, O2: e.O2 }, 600, q);
      const c = ctxDoble(arena, 17 + r);
      ({ V, T } = medir(c, 0));
      pasoLote(c, 0, 1, SIN);
      co2 += arena.cuantos(0, S.CO2) / 10; d += arena.cuantos(0, S.D) / 10;
    }
    const k = (ea: number) => NU * Math.exp(-ea / (R * T));
    const [C, D] = edo(k(e.eaC), k(e.eaD), e.A, e.O2, V);
    assert.ok(Math.abs(co2 - C) <= 0.05 * C + 3, `${e.nombre}: CO₂ ${co2.toFixed(1)} frente a ${C.toFixed(1)}`);
    assert.ok(Math.abs(d - D) <= 0.05 * D + 3, `${e.nombre}: D ${d.toFixed(1)} frente a ${D.toFixed(1)}`);
  }
  // El caso del revisor: dimerización con k = ν (κ C–C = ea) frente a la combustión con k ≈ 2,9/tick. La EDO da 0,03
  // cuantos de CO₂; repartir las demandas ya saturadas le daba ~500.000.
  let co2 = 0;
  for (let r = 0; r < 10; r++) {
    const { arena } = lotes(1, { A: 1e6, O2: 1e6 }, 600);
    pasoLote(ctxDoble(arena, 1 + r), 0, 1, [75, 0, 90]);
    co2 += arena.cuantos(0, S.CO2);
    assert.equal(arena.cuantos(0, S.D), 5e5);
  }
  assert.ok(co2 <= 3, `CO₂ en 10 réplicas: ${co2}`);
});

test('calor y existencias: el recorte no depende del orden de las ranuras y reparte en proporción', () => {
  // D → 2A (+50 J) y 2Y → X (+20 J), los dos con k = ν: con un D, dos Y y 50 J el orden de las ranuras decidía quién se
  // llevaba el calor.
  const receta: RecetaReaccion[] = [
    { a: S.D, b: 0, salidas: [[S.A, 2]], ea: 0, catalisis: -1 },
    { a: S.Y, b: S.Y, salidas: [[S.X, 1]], ea: 0, catalisis: -1 },
  ];
  const correr = (orden: SustanciaId[], d: number, y: number, calor: number, semilla: number) => {
    const arena = new ArenaDoble(buffersArena(1), new QuimicaDoble(receta));
    for (const id of orden) arena.poner(0, id, id === S.D ? d : y);
    arena.ponerCalor(0, calor);
    const antes = arena.balance([0]);
    pasoLote(ctxDoble(arena, semilla), 0, 1, SIN);
    assert.deepEqual(arena.balance([0]), antes);
    assert.equal(arena.recortes, 0);
    return [arena.cuantos(0, S.A), arena.cuantos(0, S.X), arena.calor(0)];
  };
  for (let semilla = 1; semilla <= 20; semilla++) {
    assert.deepEqual(correr([S.D, S.Y], 1, 2, 50, semilla), correr([S.Y, S.D], 1, 2, 50, semilla));
    assert.deepEqual(correr([S.D, S.Y], 1000, 2000, 35_000, semilla), correr([S.Y, S.D], 1000, 2000, 35_000, semilla));
  }
  // Piden 50.000 + 20.000 J y hay la mitad: cada una avanza cerca de la mitad de lo pedido y no sobra un D entero de calor.
  const [a, x, calor] = correr([S.D, S.Y], 1000, 2000, 35_000, 7);
  assert.ok(Math.abs(a / 2 - 500) <= 2 && Math.abs(x - 500) <= 2 && calor < 50, `A ${a}, X ${x}, calor ${calor}`);
});

test('coste: con la tabla densa el sorteo es lineal en los canales, no cúbico', () => {
  // n sustancias que reaccionan todas con todas, lentas (nada se aplica): m ≈ n²/2 canales. Recorrer los m canales por
  // cada sustancia costaba n·m (de 512 a 1.024, ×8); agrupados, m (×4). Se mide la razón: no depende de la carga.
  const medirMs = (n: number): number => {
    const tabla = Array.from({ length: n + 1 }, (_, id): Sustancia => ({
      id, clase: 1, enlaces: new Uint16Array(0), atomos: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]), masa: 10, energia: 0,
      prop: { r: 0, dMedia: 0, tFusion: 0, tEbullicion: 1e9, qOxidacion: 0, dureza: 0, tenacidad: 0, flexibilidad: 0, polaridad: 0, densidad: 1, color: 0 },
    }));
    const r: Reaccion = { a: 1, b: 2, nivelT: 0, entradas: [], salidas: [], dH: 0, ea: 120, catalisis: -1 };
    const arena = {
      especies: (_l: number, ids: Uint32Array) => { for (let i = 0; i < Math.min(n, ids.length); i++) ids[i] = i + 1; return n; },
      cuantos: () => 1000, calor: () => 0.025 * 1000 * n * 300, aplicar: () => assert.fail('nada debería aplicarse'),
    } as unknown as ArenaMateria;
    const c: CtxPaso = { arena, quimica: { internar: () => 0, sustancia: id => tabla[id]!, reaccion: () => r }, azar: () => 0.5 };
    const ms: number[] = [];
    for (let k = 0; k < 3; k++) { const t0 = performance.now(); pasoLote(c, 0, 1, SIN); ms.push(performance.now() - t0); }
    return ms.sort((a, b) => a - b)[1]!;
  };
  medirMs(256); // calienta
  const razon = medirMs(1024) / medirMs(512);
  assert.ok(razon < 6, `de 512 a 1.024 sustancias el coste crece ×${razon.toFixed(1)}`);
});

test('fluir: relaja hacia el equilibrio sin cruzarlo, con empuje y con el calor de lo que se mueve', () => {
  const { arena, c } = lotes(2, {}, 300, new QuimicaDoble([]));
  arena.poner(0, S.O2, 1_000_000); arena.poner(1, S.CO2, 10); arena.ponerCalor(0, 7_500_000); arena.ponerCalor(1, 1_000);
  const antes = arena.balance([0, 1]);
  // G·dt enorme: queda en el equilibrio (±1 por el redondeo), sin oscilar.
  assert.ok(Math.abs(fluir(c, 0, 1, S.O2, 1e12, 1, 1, 0, 1) - 500_000) <= 1);
  assert.ok(Math.abs(arena.cuantos(0, S.O2) - arena.cuantos(1, S.O2)) <= 2);
  assert.ok(arena.calor(1) > 1_000, 'el O₂ lleva su parte del calor');
  // Con empuje φ el equilibrio es ψ_a − ψ_de = φ.
  fluir(c, 0, 1, S.O2, 1e12, 1, 1, 100_000, 1);
  assert.ok(Math.abs(arena.cuantos(1, S.O2) - arena.cuantos(0, S.O2) - 100_000) <= 2);
  // Calor: con G enorme iguala temperaturas; con G pequeña pasa ≈ G·dt·ΔT y del caliente al frío.
  const T = (l: number) => arena.calor(l) / (0.025 * arena.atomos(l));
  arena.moverCalor(1, 0, 400_000);
  const dT = T(0) - T(1), q = fluirCalor(c, 0, 1, 0.5, 1);
  assert.ok(q > 0 && Math.abs(q - 0.5 * dT) <= 0.01 * 0.5 * dT + 1, `q = ${q} frente a ${0.5 * dT}`);
  fluirCalor(c, 0, 1, 1e12, 1);
  assert.ok(Math.abs(T(0) - T(1)) < 1e-3, `T ${T(0)} y ${T(1)}`);
  assert.deepEqual(arena.balance([0, 1]), antes);
});

test('fluir: capacidad del compartimento (llena uno vacío) y equilibrio discreto sin vaivén del último cuanto', () => {
  const { arena, c } = lotes(3, {}, 300, new QuimicaDoble([]));
  // Un lote vacío (ni cuantos ni calor) recibe gas de otro; y entre dos de O₂ puro a la misma T, el denso empuja al
  // ralo. Con medir(…).V como capacidad las dos cosas daban 0.
  arena.poner(0, S.O2, 1_000_000); arena.ponerCalor(0, 1_000_000);
  assert.ok(fluir(c, 0, 1, S.O2, 1e12, 100, 100, 0, 1) >= 499_999);
  arena.poner(2, S.O2, 1000); arena.ponerCalor(2, Math.round(arena.calor(0) * 1000 / arena.cuantos(0, S.O2)));
  assert.ok(fluir(c, 0, 2, S.O2, 1e12, 100, 100, 0, 1) > 200_000);
  // Un cuanto entre capacidades iguales: el equilibrio continuo es medio cuanto y no se mueve en ningún sentido.
  const dos = lotes(2, {}, 300, new QuimicaDoble([]));
  dos.arena.poner(0, S.O2, 1);
  for (let t = 0; t < 200; t++) {
    assert.equal(fluir(dos.c, 0, 1, S.O2, 1e12, 1, 1, 0, 1), 0);
    assert.equal(fluir(dos.c, 1, 0, S.O2, 1e12, 1, 1, 0, 1), 0);
  }
  // Tres cuantos: se asientan en 1 y 2 (o 2 y 1) y ahí se quedan.
  dos.arena.poner(0, S.O2, 3);
  fluir(dos.c, 0, 1, S.O2, 1e12, 1, 1, 0, 1);
  const asentado = [dos.arena.cuantos(0, S.O2), dos.arena.cuantos(1, S.O2)];
  assert.deepEqual([...asentado].sort(), [1, 2]);
  for (let t = 0; t < 200; t++) { fluir(dos.c, 0, 1, S.O2, 1e12, 1, 1, 0, 1); fluir(dos.c, 1, 0, S.O2, 1e12, 1, 1, 0, 1); }
  assert.deepEqual([dos.arena.cuantos(0, S.O2), dos.arena.cuantos(1, S.O2)], asentado);
  // Calor: con 1 J de diferencia el equilibrio es medio julio, que en coma flotante queda a un lado en los dos sentidos:
  // no se mueve ni va y viene.
  dos.arena.poner(1, S.O2, 1); dos.arena.poner(0, S.O2, 1); dos.arena.ponerCalor(0, 1001); dos.arena.ponerCalor(1, 1000);
  for (let t = 0; t < 200; t++) { assert.equal(fluirCalor(dos.c, 0, 1, 1e12, 1), 0); assert.equal(fluirCalor(dos.c, 1, 0, 1e12, 1), 0); }
});

test('dueños: un hilo solo escribe sus lotes; los caducados se saltan; el doble no deja la arena a medias', () => {
  const buffers = buffersArena(2);
  const arena = new ArenaDoble(buffers, new QuimicaDoble(solo(3)));
  arena.poner(0, S.X, 100); arena.poner(1, S.X, 100); arena.ponerCalor(0, 1000); arena.ponerCalor(1, 1000);
  new Int32Array(buffers.dueno)[1] = 1;
  const c = ctxDoble(arena, 3), lista = Float64Array.from([0, 1, 99]), kappas = new Float64Array(9).fill(KAPPA_SUELO);
  assert.throws(() => pasarLotes(c, lista, kappas, 0, 2, 1), /otro dueño/);
  assert.equal(arena.cuantos(1, S.X), 100, 'el lote ajeno no se tocó');
  assert.equal(pasarLotes(c, Float64Array.from([0, 99]), kappas, 0, 2, 1), 1, 'el 99 no existe: se salta');
  assert.throws(() => arena.moverCalor(0, 1, 1), /es del hilo 1/);
  // Validar antes de escribir: 1 J hacia un lote con 2⁵³ − 1 J falla sin debitar el origen.
  new Int32Array(buffers.dueno)[1] = 0;
  arena.ponerCalor(1, Number.MAX_SAFE_INTEGER);
  const antes = arena.balance([0, 1]);
  assert.throws(() => arena.moverCalor(0, 1, 1), /I3/);
  assert.throws(() => arena.moverParte(0, 1, { parte: 0, esp: S.Y, cuantos: 1, kappa: null }), /I3/);
  assert.deepEqual(arena.balance([0, 1]), antes);
});

test('reparto entre hilos: µs por lote con 1 y 28 hilos desde la misma mezcla, cobertura e I2 exacto', async t => {
  const n = 28 * 2000;
  const buffers = buffersArena(n);
  const arena = new ArenaDoble(buffers, new QuimicaDoble());
  for (let l = 0; l < n; l++) {
    arena.poner(l, S.A, 2000 + l % 97); arena.poner(l, S.O2, 1500); arena.poner(l, S.H2O, 300); arena.poner(l, S.X, 500 + l % 13);
    arena.ponerCalor(l, Math.round(0.025 * arena.atomos(l) * (650 + l % 200)));
  }
  const todos = Array.from({ length: n }, (_, l) => l), antes = arena.balance(todos);
  const foto = { esp: arena.esp.slice(), cant: arena.cant.slice(), cal: arena.cal.slice() };
  const restaurar = () => { arena.esp.set(foto.esp); arena.cant.set(foto.cant); arena.cal.set(foto.cal); };
  const productos = () => [S.CO2, S.D, S.Y].map(esp => { let q = 0; for (let l = 0; l < n; l++) q += arena.cuantos(l, esp); return q; });
  const dueno = new Int32Array(buffers.dueno);
  // Dueños por bloques contiguos, como las páginas de un chunk (intercalados, varios hilos escribirían la misma línea de
  // caché del calor del doble), la lista agrupada por dueño y dónde empieza cada grupo.
  const despacho = (hilos: number) => {
    const lista = new Float64Array(new SharedArrayBuffer(8 * n)), kappas = new Float64Array(new SharedArrayBuffer(24 * n));
    const cortes = new Float64Array(new SharedArrayBuffer(8 * (hilos + 1)));
    for (let l = 0; l < n; l++) dueno[l] = Math.floor(l * hilos / n);
    let i = 0;
    for (let h = 0; h < hilos; h++) {
      cortes[h] = i;
      for (let l = 0; l < n; l++) if (dueno[l] === h) { lista[i] = l; kappas[3 * i + 1] = KAPPA0 / 2; i++; }
    }
    cortes[hilos] = n;
    return { lotes: lista.buffer as SharedArrayBuffer, kappas: kappas.buffer as SharedArrayBuffer, cortes: cortes.buffer as SharedArrayBuffer };
  };
  // Referencia en el hilo principal: el mismo bucle que corre cada worker.
  const uno = despacho(1);
  const t0 = performance.now();
  assert.equal(pasarLotes(ctxDoble(arena, 5), new Float64Array(uno.lotes), new Float64Array(uno.kappas), 0, n, 1), n);
  const principal = performance.now() - t0, referencia = productos();
  assert.deepEqual(arena.balance(todos), antes);
  const medidas: Record<number, number> = {}, mezcla: Record<number, number[]> = {};
  for (const hilos of [1, 28]) {
    restaurar();
    const trabajo = despacho(hilos);
    const piscina = new PiscinaDoble(hilos, buffers, 1000 * hilos);
    try {
      await piscina.correr(trabajo, { dt: 1 }); // calienta: carga de módulos y JIT
      const ms: number[] = [];
      for (let r = 0; r < 5; r++) {
        restaurar();
        const { ms: m, lotes: avanzados } = await piscina.correr(trabajo, { dt: 1 });
        assert.equal(avanzados, n, 'cada lote avanzó una vez');
        assert.deepEqual(arena.balance(todos), antes);
        ms.push(m);
      }
      medidas[hilos] = ms.sort((a, b) => a - b)[2]!;
      mezcla[hilos] = productos();
    } finally { await piscina.cerrar(); }
  }
  // Misma mezcla de partida: CO₂, D e Y totales coinciden con la referencia dentro del ruido (CO₂ ~2·10⁵, σ ≈ 0,3 %).
  for (const hilos of [1, 28]) mezcla[hilos]!.forEach((v, k) => assert.ok(Math.abs(v - referencia[k]!) <= 0.01 * referencia[k]!,
    `${hilos} hilos: ${v} frente a ${referencia[k]} (producto ${k})`));
  const informe = `${n} lotes (A, O₂, H₂O y X; combustión, dimerización y X → 2Y; CO₂/D/Y = ${referencia.join('/')}): `
    + `hilo principal ${(1000 * principal / n).toFixed(2)} µs/lote; `
    + `1 hilo ${(1000 * medidas[1]! / n).toFixed(2)} µs/lote (${medidas[1]!.toFixed(1)} ms); `
    + `28 hilos ${(1000 * medidas[28]! / n).toFixed(2)} µs/lote (${medidas[28]!.toFixed(1)} ms), aceleración ${(medidas[1]! / medidas[28]!).toFixed(1)}×; `
    + `carga ${loadavg().map(v => v.toFixed(1)).join(' ')}`;
  t.diagnostic(informe);
  console.log(informe);
});
