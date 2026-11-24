import test from 'node:test';
import assert from 'node:assert/strict';
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { KAPPA0, KAPPA_SUELO, NU, R } from '../src/shared/naturaleza.js';
import { binomial, medir, pasoLote, type CtxPaso, type Kappa } from '../src/world/materia/paso.js';
import { fluir, fluirCalor } from '../src/world/materia/fluir.js';
import { pasarLotes, tramo } from '../src/world/materia/paso-worker.js';
import {
  ArenaDoble, PiscinaDoble, QuimicaDoble, RECETA, S, buffersArena, ctxDoble, type RecetaReaccion,
} from './lib/materia-doble.js';

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
      for (const esp of [S.O2, S.CO2, S.H2O, S.Y]) movidos += Math.abs(fluir(c, de, a, esp, 0.05, medir(c, de).V, medir(c, a).V, 0, dt));
      movidos += Math.abs(fluirCalor(c, de, a, 3, dt));
    }
  }
  assert.ok(veces > 1e6 && movidos > 1e3, `hubo química (${veces}) y transporte (${movidos})`);
  assert.deepEqual(arena.balance(todos), antes);
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
  ];
  for (const e of escenarios) {
    const muestras = [1, 2].map(partes => Array.from({ length: replicas }, (_, r) => {
      const { arena } = lotes(partes, e.contenido, e.T);
      const c = ctxDoble(arena, 7919 * r + 104_729 * partes);
      for (let t = 0; t < e.ticks; t++) for (let l = 0; l < partes; l++) pasoLote(c, l, 1, e.kappa);
      return e.mide.map(esp => { let q = 0; for (let l = 0; l < partes; l++) q += arena.cuantos(l, esp); return q; });
    }));
    e.mide.forEach((esp, k) => {
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

test('reparto: tramos disjuntos que cubren la lista', () => {
  for (const [n, hilos] of [[0, 3], [5, 8], [100, 28], [1001, 28]] as const) {
    let siguiente = 0;
    for (let h = 0; h < hilos; h++) {
      const [desde, hasta] = tramo(n, hilos, h);
      assert.equal(desde, siguiente);
      assert.ok(hasta - desde <= Math.ceil(n / hilos));
      siguiente = hasta;
    }
    assert.equal(siguiente, n);
  }
});

test('reparto entre hilos: ms por lote con 1 y 28 hilos, y I2 exacto con los hilos escribiendo a la vez', async t => {
  const n = 28 * 2000;
  const buffers = buffersArena(n);
  const arena = new ArenaDoble(buffers, new QuimicaDoble());
  for (let l = 0; l < n; l++) {
    arena.poner(l, S.A, 2000 + l % 97); arena.poner(l, S.O2, 1500); arena.poner(l, S.H2O, 300); arena.poner(l, S.X, 500 + l % 13);
    arena.ponerCalor(l, Math.round(0.025 * arena.atomos(l) * (650 + l % 200)));
  }
  const lista = new Float64Array(new SharedArrayBuffer(8 * n)), kappas = new Float64Array(new SharedArrayBuffer(24 * n));
  for (let l = 0; l < n; l++) { lista[l] = l; kappas[3 * l + 1] = KAPPA0 / 2; }
  const todos = Array.from({ length: n }, (_, l) => l), antes = arena.balance(todos);
  // Referencia en el hilo principal: el mismo bucle que corre cada worker.
  const t0 = performance.now();
  pasarLotes(ctxDoble(arena, 5), lista, kappas, 0, n, 1);
  const principal = performance.now() - t0;
  const medidas: Record<number, number> = {};
  for (const hilos of [1, 28]) {
    const piscina = new PiscinaDoble(hilos, buffers, 1000 * hilos);
    try {
      const trabajo = { lotes: lista.buffer as SharedArrayBuffer, kappas: kappas.buffer as SharedArrayBuffer };
      await piscina.correr(trabajo, { n, dt: 1, hilos }); // calienta: carga de módulos y JIT
      const ms: number[] = [];
      for (let r = 0; r < 5; r++) {
        const { ms: m, veces } = await piscina.correr(trabajo, { n, dt: 1, hilos });
        assert.ok(veces > 0);
        ms.push(m);
      }
      medidas[hilos] = ms.sort((a, b) => a - b)[2]!;
    } finally { await piscina.cerrar(); }
  }
  assert.deepEqual(arena.balance(todos), antes);
  const informe = `${n} lotes (A, O₂, H₂O y X; combustión, dimerización y X → 2Y): hilo principal ${(1000 * principal / n).toFixed(2)} µs/lote; `
    + `1 hilo ${(1000 * medidas[1]! / n).toFixed(2)} µs/lote (${medidas[1]!.toFixed(1)} ms); `
    + `28 hilos ${(1000 * medidas[28]! / n).toFixed(2)} µs/lote (${medidas[28]!.toFixed(1)} ms), aceleración ${(medidas[1]! / medidas[28]!).toFixed(1)}×; `
    + `carga ${loadavg().map(v => v.toFixed(1)).join(' ')}`;
  t.diagnostic(informe);
  console.log(informe);
});
