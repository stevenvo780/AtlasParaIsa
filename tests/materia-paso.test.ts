/**
 * Carril P (cinética, fluir y reparto entre hilos) sobre la arena real de A y la química real de Q (enmiendas 1 y 2): las
 * reacciones son las que da `productos()` con sus coeficientes, y la velocidad se elige con κ por familia (4: C–O, C–N,
 * C–C/C–H, H–H), que es entrada de P: k = ν·exp(−b/RT) con b = `barreraEfectiva` (max(0, ea − κ) en exotérmicas, ea en
 * endotérmicas). Dobles solo para M1 (memoria, terreno y piscina, tests/lib) y para
 * la prueba de coste, que necesita una tabla en la que reaccionen todas las parejas de 1.024 sustancias.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { EPSILON_G, KAPPA0, KAPPA_SUELO, KAPPA_SUELO_HH, NU, R } from '../src/shared/naturaleza.js';
import type { SustanciaId } from '../src/shared/materia.js';
import { binomial, cuentaIntegrador, medir, pasoLote, type CtxPaso, type Kappa } from '../src/world/materia/paso.js';
import { fluir, fluirCalor } from '../src/world/materia/fluir.js';
import { pasarLotes } from '../src/world/materia/paso-worker.js';
import { crearServicioQuimico } from '../src/world/materia/servicio.js';
import { dGA, favorableA } from '../src/world/materia/quimica.js';
import { slotDe } from '../src/world/motor/contratos.js';
import { Parte, barreraEfectiva, nivelDeLote, nivelDeT, type ArenaMateria, type LoteRef, type Reaccion, type Sustancia } from '../src/world/materia/tipos.js';
import { registrarSustanciasBase } from '../scripts/lab-materia.mjs';
import { PiscinaReal, azarSembrado, materiaReal, type Base, type Contenido, type MateriaReal } from './lib/materia-real.js';

const SIN: Kappa = [0, 0, 0, 0];
const SUELO: Kappa = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH];

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

/** La arena con un contador de recortes de `aplicar`: pasoLote debe pedir siempre lo que hay (y el calor que hay). */
function conRecortes(arena: ArenaMateria): { arena: ArenaMateria; recortes: () => number } {
  let recortes = 0;
  const envuelta = new Proxy(arena, {
    get(t, p) {
      if (p === 'aplicar') return (l: LoteRef, e: Parameters<ArenaMateria['aplicar']>[1], veces: number) => {
        const v = t.aplicar(l, e, veces);
        if (v < veces) recortes++;
        return v;
      };
      const x = Reflect.get(t, p) as unknown;
      return typeof x === 'function' ? (x as (...a: unknown[]) => unknown).bind(t) : x;
    },
  });
  return { arena: envuelta, recortes: () => recortes };
}

/** `partes` lotes con `contenido` repartido a partes iguales (cuantos enteros) y el calor de T. */
function repartido(m: MateriaReal, partes: number, contenido: Contenido, T: number): LoteRef[] {
  return Array.from({ length: partes }, () => m.lote(
    Object.fromEntries(Object.entries(contenido).map(([k, q]) => [k, q! / partes])) as Contenido, T));
}

/** Fija los cuantos de `id` (0: el calor) declarando fuente o sumidero. */
function poner(m: MateriaReal, l: LoteRef, id: SustanciaId, q: number): void {
  const d = q - (id === 0 ? m.arena.calor(l) : m.arena.cuantos(l, id));
  if (d > 0) m.arena.fuente(l, Float64Array.from([id, d]), m.libro);
  else if (d < 0) m.arena.sumidero(l, Float64Array.from([id, -d]), m.libro);
}

const total = (m: MateriaReal, lotes: LoteRef[], id: SustanciaId) => lotes.reduce((s, l) => s + m.arena.cuantos(l, id), 0);

test('I2: átomos y energía exactos tras reaccionar y fluir (enteros, sin un átomo ni un julio de diferencia)', async () => {
  // La arena real guarda cada asiento en un entero seguro: la energía de un lote no pasa de 2⁵³ J (2⁴⁵ cuantos de
  // proteína serían −6·10¹⁶; el doble de antes no lo comprobaba). Por eso los extremos son de 2⁴⁰.
  const m = materiaReal();
  try {
    const mezclas: [Contenido, number][] = [
      [{ madera: 2000, O2: 1500 }, 700], [{ madera: 2 ** 40, O2: 2 ** 39, proteina: 3 ** 20 }, 650],
      [{ O2: 300, H2O: 5000 }, 295], [{ madera: 10, proteina: 7_000_001 }, 900],
      [{ madera: 123_457, O2: 99_999, H2O: 17, proteina: 3, H2: 1001 }, 1200], [{ proteina: 2 ** 40, H2: 2 ** 20, O2: 2 ** 19 }, 310],
    ];
    const lotes = mezclas.map(([c, T]) => m.lote(c, T));
    const { arena, recortes } = conRecortes(m.arena);
    const c: CtxPaso = { ...m.ctx(2026), arena };
    const kappas: Kappa[] = [SIN, [KAPPA0, KAPPA0, KAPPA0, KAPPA0], SIN, [0, 0, KAPPA0, KAPPA0], SUELO, [0, KAPPA0, 120, 120]];
    let veces = 0, movidos = 0;
    for (let t = 0; t < 300; t++) {
      const dt = t % 3 === 0 ? 10 : 1;
      lotes.forEach((l, i) => { veces += pasoLote(c, l, dt, kappas[i]!); });
      for (const [de, a] of [[0, 2], [2, 4], [4, 1], [3, 5]] as const) {
        for (const esp of [m.S.O2, m.S.CO2, m.S.H2O, m.S.NH3, m.S.H2]) {
          movidos += Math.abs(fluir(c, lotes[de]!, lotes[a]!, esp, 0.05, 1e3 * (1 + de), 1e3 * (1 + a), 0, dt));
        }
        movidos += Math.abs(fluirCalor(c, lotes[de]!, lotes[a]!, 3, dt));
      }
    }
    assert.ok(veces > 1e6 && movidos > 1e3, `hubo química (${veces}) y transporte (${movidos})`);
    assert.deepEqual(m.arena.saldo(), m.esperado());
    assert.equal(recortes(), 0, 'pasoLote nunca pide más de lo que hay');
  } finally { await m.cerrar(); }
});

test('I5: dividir un lote en dos mitades con grupos enteros no cambia la distribución de productos (KS, p > 0,01)', async () => {
  const replicas = 2000;
  const m0 = materiaReal(), S = m0.S;
  await m0.cerrar();
  // Una arena y una química por escenario y partición; cada réplica, lotes nuevos y su propio azar.
  const escenarios: { nombre: string; contenido: Contenido; T: number; ticks: number; kappa: Kappa; mide: SustanciaId[] }[] = [
    // Combustión exotérmica que compite por la madera con su carbonización (canales con reactivo compartido), a 700 K.
    { nombre: 'combustión y carbonización, 3 ticks', contenido: { madera: 2e6, O2: 1.5e6 }, T: 700, ticks: 3, kappa: SIN, mide: [S.CO2, S.C] },
    // Primer orden casi isoterma (N₂ inerte). Con pocos cuantos por paso manda el ruido, y el de redondear cada canal
    // con un uniforme (§3.1) no crece con el lote: el segundo caso lo distingue.
    { nombre: 'descomposición de primer orden', contenido: { proteina: 1e5, N2: 1e7 }, T: 310, ticks: 4, kappa: [0, 73, 0, 0], mide: [S.proteina] },
    { nombre: 'descomposición con pocos cuantos', contenido: { proteina: 2000, N2: 2e6 }, T: 310, ticks: 40, kappa: [0, 73, 0, 0], mide: [S.proteina] },
    // ν = 2 con pocos cuantos (2 H₂ + O₂ en N₂): sortear cuantos sueltos y no veces de reacción perdía de media media vez
    // por lote y paso, el doble con dos mitades.
    { nombre: '2 H₂ + O₂ con pocos cuantos', contenido: { H2: 40, O2: 40, N2: 1e6 }, T: 295, ticks: 10, kappa: [0, 0, 0, 139], mide: [S.H2O] },
    { nombre: '2 H₂ + O₂ con cuatro cuantos de H₂', contenido: { H2: 4, O2: 2, N2: 1e6 }, T: 295, ticks: 1, kappa: [0, 0, 0, 142], mide: [S.H2O] },
  ];
  for (const e of escenarios) {
    const muestras: number[][][] = [];
    for (const partes of [1, 2]) {
      const m = materiaReal({ capacidad: replicas * partes + 16 });
      muestras.push(Array.from({ length: replicas }, (_, r) => {
        const lotes = repartido(m, partes, e.contenido, e.T);
        const c = m.ctx(7919 * r + 104_729 * partes);
        for (let t = 0; t < e.ticks; t++) for (const l of lotes) pasoLote(c, l, 1, e.kappa);
        return e.mide.map(esp => total(m, lotes, esp));
      }));
      assert.deepEqual(m.arena.saldo(), m.esperado());
      await m.cerrar();
    }
    e.mide.forEach((esp, k) => {
      // Reacciona de verdad: la media se aleja de lo que había al empezar (el producto aparece, el reactivo se gasta).
      const inicial = Object.entries(e.contenido).reduce((s, [nombre, q]) => s + (S[nombre as keyof Base] === esp ? q! : 0), 0);
      const media = muestras[0]!.reduce((s, v) => s + v[k]!, 0) / replicas;
      assert.ok(Math.abs(media - inicial) >= 1, `${e.nombre}, sustancia ${esp}: media ${media} frente a ${inicial} al empezar`);
      const { d, p } = ks(muestras[0]!.map(v => v[k]!), muestras[1]!.map(v => v[k]!));
      assert.ok(p > 0.01, `${e.nombre}, sustancia ${esp}: KS D = ${d.toFixed(3)}, p = ${p.toExponential(2)}`);
    });
  }
  // Alcance de I5 (revisión de la enmienda 3, hallazgo 7): vale para particiones en las que cada parte conserva grupos
  // enteros de la estequiometría (cuantos ≥ ν de cada reactivo de los canales que cuentan), como todos los escenarios de
  // arriba. Un cuanto es indivisible y P no junta lotes: 2 H₂ + 2 O₂ con k = ν hacen 2 H₂O en un lote y nada en dos
  // de 1 H₂ + 1 O₂ (cada uno con medio grupo de 2 H₂ + O₂). Repartir así la materia es decisión de W, no de P.
  const m = materiaReal({ capacidad: 8 });
  try {
    const entero = m.lote({ H2: 2, O2: 2, N2: 1e6 }, 295), mitades = repartido(m, 2, { H2: 2, O2: 2, N2: 1e6 }, 295);
    for (const l of [entero, ...mitades]) pasoLote(m.ctx(5), l, 1, [0, 0, 0, KAPPA_SUELO_HH]);
    assert.equal(m.arena.cuantos(entero, S.H2O), 2);
    assert.equal(total(m, mitades, S.H2O), 0);
  } finally { await m.cerrar(); }
});

test('extremo: con κ ≥ ea (k = ν) la reacción se completa en una llamada hasta el reactivo limitante, con sus coeficientes', async () => {
  const m = materiaReal();
  try {
    // proteína → NH₃ + C (C–N, ea 141,05) con κ = 142 y 2⁴⁰ cuantos: con «partir dt» serían del orden de ν·dt = 10⁹ subpasos.
    const unaria = m.lote({ proteina: 2 ** 40 }, 295);
    let t0 = performance.now();
    pasoLote(m.ctx(1), unaria, 1, [0, 142, 0, 0]);
    const msUnaria = performance.now() - t0;
    assert.equal(m.arena.cuantos(unaria, m.S.proteina), 0);
    assert.equal(m.arena.cuantos(unaria, m.S.NH3), 2 ** 40);
    // 2 H₂ + O₂ → 2 H₂O con la barrera anulada: el O₂ (limitante con ν = 2 de H₂) se agota exacto y sobra H₂.
    const par = m.lote({ H2: 1e12, O2: 4e11 }, 295);
    t0 = performance.now();
    pasoLote(m.ctx(2), par, 1, [0, 0, 0, 200]);
    const msPar = performance.now() - t0;
    assert.equal(m.arena.cuantos(par, m.S.O2), 0);
    assert.equal(m.arena.cuantos(par, m.S.H2), 2e11);
    assert.equal(m.arena.cuantos(par, m.S.H2O), 8e11);
    // A 150 K (ℓ = 0), el borde bajo de la tabla de niveles: lo mismo, con H₂ limitante.
    const helado = m.lote({ H2: 1e6, O2: 1e6 }, 150);
    assert.equal(nivelDeT(m.arena.vista(helado).T), 0);
    pasoLote(m.ctx(3), helado, 1, [0, 0, 0, 200]);
    assert.deepEqual([m.arena.cuantos(helado, m.S.H2), m.arena.cuantos(helado, m.S.O2), m.arena.cuantos(helado, m.S.H2O)], [0, 5e5, 1e6]);
    assert.ok(msUnaria < 50 && msPar < 50, `coste acotado: ${msUnaria.toFixed(2)} y ${msPar.toFixed(2)} ms`);
    assert.deepEqual(m.arena.saldo(), m.esperado());
  } finally { await m.cerrar(); }
});

test('extremo: dos canales saturados que comparten el O₂ con coeficientes distintos lo dejan todo hecho en un paso', async () => {
  // Revisión de la enmienda 3, hallazgo 4: 10⁶ H₂ + 10⁶ CH₄ + 2,5·10⁶ O₂ (2 H₂ + O₂ y CH₄ + 2 O₂, k = ν) dejaba con la
  // semilla 9 549 CH₄ y 1.098 O₂: el O₂, gastado en 10⁻¹¹ más que el CH₄, sorteaba la combustión del CH₄ con p = 0,8 y el
  // recorte no devolvía lo que sobraba. Con O₂ escaso, el que el H₂ agotado no pudo tomar se quedaba sin el CH₄ que había.
  const m = materiaReal({ capacidad: 512 });
  try {
    const S = m.S, q = (l: LoteRef, id: SustanciaId) => m.arena.cuantos(l, id);
    let peorExacto = 0, peorO2 = 0;
    for (let semilla = 1; semilla <= 60; semilla++) {
      const exacto = m.lote({ H2: 1_000_000, CH4: 1_000_000, O2: 2_500_000 }, 295);
      pasoLote(m.ctx(semilla), exacto, 1, [0, 0, 200, 200]);
      // Veces que aún cabrían de una u otra combustión.
      peorExacto = Math.max(peorExacto, Math.min(Math.floor(q(exacto, S.H2) / 2), q(exacto, S.O2)), Math.min(q(exacto, S.CH4), Math.floor(q(exacto, S.O2) / 2)));
      const escaso = m.lote({ H2: 1_000_000, CH4: 1_000_000, O2: 2_400_000 }, 295);
      pasoLote(m.ctx(semilla), escaso, 1, [0, 0, 200, 200]);
      peorO2 = Math.max(peorO2, q(escaso, S.O2));
      assert.ok(q(escaso, S.CH4) > 40_000, 'con O₂ escaso sobra CH₄');
    }
    assert.equal(peorExacto, 0, `en la mezcla estequiométrica caben aún ${peorExacto} combustiones`);
    assert.ok(peorO2 <= 8, `con O₂ escaso quedan hasta ${peorO2} O₂ (el resto de medio cuanto de la integración)`);
    assert.deepEqual(m.arena.saldo(), m.esperado());
  } finally { await m.cerrar(); }
});

test('encadenado: el H₂ que nace en un paso del suelo se oxida en ese mismo paso con el O₂ que hay', async () => {
  // Validación de la enmienda 3, hallazgo 7: en un suelo denso el H₂ de 2 glicósido → 2 H₂ + C + CO₂ (o de H₂O + 2 orgP)
  // salía por `fluir` antes de que el suelo, que lo oxida sin barrera (κ H–H), lo viera en el paso siguiente. Con los
  // pases encadenados, lo que nace en el paso reacciona en él: el O₂ se agota en la misma llamada.
  const m = materiaReal({ capacidad: 16 });
  try {
    const S = m.S, l = m.lote({ glicosido: 100_000, O2: 20_000, SiO2: 1_000_000, H2O: 300_000 }, 295);
    const h2o = (x: LoteRef) => m.arena.cuantos(x, S.H2O);
    pasoLote(m.ctx(3), l, 1, SUELO);
    assert.ok(m.arena.cuantos(l, S.glicosido) < 100, `glicósido ${m.arena.cuantos(l, S.glicosido)}`);
    assert.equal(m.arena.cuantos(l, S.O2), 0, 'el O₂ oxida en el mismo paso el H₂ que acaba de nacer');
    // Cada O₂ hizo 2 H₂O de 2 H₂; el resto del agua nueva es de glicósido → H₂O + C (una por C que no salió con CO₂).
    const c = m.arena.cuantos(l, S.C), co2 = m.arena.cuantos(l, S.CO2);
    assert.equal(h2o(l) - 300_000, 2 * 20_000 + (c - co2));
    assert.equal(m.arena.cuantos(l, S.H2), 2 * co2 - 2 * 20_000);
    assert.deepEqual(m.arena.saldo(), m.esperado());
  } finally { await m.cerrar(); }
});

test('ΔG a la T real: a 270 K el suelo no hace 3 H₂ + N₂ → 2 NH₃ (NH₃ líquido en el modelo), a 295 K sí', async () => {
  // Revisión de la enmienda 3, hallazgo 5: el piso (NIVEL_CATALIZADO) elige en el nivel 2, donde el NH₃ es gas, y a 270 K
  // el NH₃ del modelo es líquido (ebulle a 273,6 K): ΔG = −145 + 4·270·0,18 = +49,4 J. Con 4·10⁹ de cada uno y el κ del
  // suelo se hacían ~3.700 en 50 ticks. P exige ΔG < −EPSILON_G a la T y fases del lote, como Q a la de su nivel.
  const m = materiaReal({ capacidad: 16 });
  try {
    const S = m.S, r = m.quimica.reaccion(S.H2, S.N2, nivelDeLote(270, SUELO))!;
    assert.ok(r && r.dH === -145 && r.salidas.some((t) => t.id === S.NH3), 'el nivel 2 da 3 H₂ + N₂ → 2 NH₃');
    assert.ok(Math.abs(dGA(r, 270, (id) => m.quimica.sustancia(id)) - 49.4) < 1e-9 && !favorableA(r, 270, (id) => m.quimica.sustancia(id)));
    assert.ok(favorableA(r, 295, (id) => m.quimica.sustancia(id)), 'a 295 K el NH₃ es gas y ΔG < 0');
    const veces = (T: number) => {
      const l = m.lote({ H2: 4e9, N2: 4e9 }, T);
      let v = 0;
      for (let t = 0; t < 50; t++) v += pasoLote(m.ctx(1 + t), l, 1, SUELO);
      return v;
    };
    assert.equal(veces(270), 0);
    assert.ok(veces(295) > 0);
    assert.deepEqual(m.arena.saldo(), m.esperado());
    // `favorableA` decide sin mirar fases cuando ningún reparto de gases cambia el signo: lo mismo que ΔG < −ε en todas
    // las filas de las sustancias base, en los niveles 1–12 y de 150 a 2.000 K.
    const ids = Object.values(S) as SustanciaId[], sus = (id: SustanciaId) => m.quimica.sustancia(id);
    let filas = 0, cerca = 0;
    for (let nivel = 1; nivel <= 12; nivel++) for (const a of ids) for (const b of [0 as SustanciaId, ...ids]) {
      if (b !== 0 && b < a) continue;
      const x = m.quimica.reaccion(a, b, nivel);
      if (!x) continue;
      filas++;
      for (let T = 150; T <= 2000; T += 25) {
        const g = dGA(x, T, sus);
        if (Math.abs(g + EPSILON_G) < 60) cerca++;
        assert.equal(favorableA(x, T, sus), g < -EPSILON_G, `${a}+${b} nivel ${nivel} a ${T} K: ΔG ${g}`);
      }
    }
    assert.ok(filas > 200 && cerca > 100, `${filas} filas, ${cerca} casos a menos de 60 J del umbral`);
  } finally { await m.cerrar(); }
});

test('extremo: k·dt ≫ 1 (κ del suelo frente a C–N a 295 K, ~400/tick) agota el reactivo en un paso', async () => {
  const m = materiaReal();
  try {
    const l = m.lote({ proteina: 3 ** 24 }, 295);
    const r = m.quimica.reaccion(m.S.proteina, 0, nivelDeT(295))!;
    const k = NU * Math.exp(-(r.ea - KAPPA_SUELO) / (R * 295));
    assert.ok(r.catalisis === 1 && k > 300 && k < 500, `k = ${k.toFixed(0)}/tick`);
    pasoLote(m.ctx(4), l, 1, SUELO);
    assert.equal(m.arena.cuantos(l, m.S.proteina), 0);
    assert.equal(m.arena.cuantos(l, m.S.NH3), 3 ** 24);
    assert.equal(m.arena.cuantos(l, m.S.C), 3 ** 24);
  } finally { await m.cerrar(); }
});

test('enmienda 2: la catálisis solo rebaja exotérmicas y el H–H tiene familia propia (índice 3 de Kappa)', async () => {
  // La regla, en sus cuatro casos: exotérmica catalizada (rebaja hasta 0), endotérmica (ea, la cataliza nadie) y sin familia.
  const r = (ea: number, dH: number, catalisis: Reaccion['catalisis'], paresCatalisis: Reaccion['paresCatalisis'] = catalisis === -1 ? 0 : 1) =>
    ({ ea, dH, catalisis, paresCatalisis });
  assert.equal(barreraEfectiva(r(100, -10, 0), [30, 0, 0, 0]), 70);
  // Enmienda 3: κ por cada par del enlace que decide la familia (un triple, 3κ).
  assert.equal(barreraEfectiva(r(100, -10, 1, 3), [0, 30, 0, 0]), 10);
  assert.equal(barreraEfectiva(r(311.8, -10, 1, 3), [0, 105, 0, 0]), 0);
  assert.equal(barreraEfectiva(r(100, -10, 0), [200, 0, 0, 0]), 0);
  assert.equal(barreraEfectiva(r(100, 50, 0), [1e3, 1e3, 1e3, 1e3]), 100, 'endotérmica: sin rebaja');
  assert.equal(barreraEfectiva(r(100, -10, -1), [1e3, 1e3, 1e3, 1e3]), 100, 'sin familia: sin rebaja');
  assert.equal(barreraEfectiva(r(100, -10, 3), [0, 0, 1e3, 40]), 60, 'H–H usa su propio κ');
  const m = materiaReal();
  try {
    // Grasa en un suelo con κ enorme: CH₂ → H₂ + C es endotérmica (dH +24) y queda en su tasa sin catálisis (~10⁻¹⁶/tick).
    // Con la barrera de la enmienda 1, max(0, ea − κ, dH) = 24 J, iba a ~6·10⁴/tick y la grasa del suelo era H₂. (Con
    // SiO₂ de relleno: con N₂, N₂ + 3 CH₂ → 2 NH₃ + 3 C es exotérmica y un κ de 1.000 la satura.)
    const grasa = m.quimica.reaccion(m.S.CH2, 0, nivelDeT(295))!;
    assert.ok(grasa.dH > 0 && grasa.catalisis === 2, `CH₂ → H₂ + C: dH ${grasa.dH}, familia ${grasa.catalisis}`);
    const l = m.lote({ CH2: 1e6, SiO2: 1e6 }, 295);
    for (let t = 0; t < 100; t++) pasoLote(m.ctx(40 + t), l, 1, [1e3, 1e3, 1e3, 1e3]);
    assert.equal(m.arena.cuantos(l, m.S.H2), 0, 'ningún κ parte la grasa');
    assert.equal(m.arena.cuantos(l, m.S.CH2), 1e6);
    // 2 H₂ + O₂ → 2 H₂O es de la familia H–H (3): κ en C–C/C–H no la toca; el κ H–H del suelo la satura (k = ν).
    const h2 = m.quimica.reaccion(m.S.H2, m.S.O2, nivelDeT(295))!;
    assert.equal(h2.catalisis, 3);
    const sinHH = m.lote({ H2: 1e6, O2: 1e6, N2: 1e6 }, 295);
    for (let t = 0; t < 100; t++) pasoLote(m.ctx(200 + t), sinHH, 1, [KAPPA_SUELO, KAPPA_SUELO, 1e3, 0]);
    assert.equal(m.arena.cuantos(sinHH, m.S.H2O), 0, 'κ de C–C/C–H no oxida el H₂');
    const conHH = m.lote({ H2: 1e6, O2: 1e6, N2: 1e6 }, 295);
    pasoLote(m.ctx(300), conHH, 1, SUELO);
    assert.deepEqual([m.arena.cuantos(conHH, m.S.H2), m.arena.cuantos(conHH, m.S.H2O)], [0, 1e6], 'el suelo oxida el H₂ al paso');
    assert.deepEqual(m.arena.saldo(), m.esperado());
  } finally { await m.cerrar(); }
});

test('enmienda 2: un lote catalizado por debajo de 282,84 K elige los productos del nivel 2 (el suelo frío no hace HCN)', async () => {
  const m = materiaReal();
  try {
    // En el nivel 1 (275 K; Q calcula a 259,4 K, donde el NH₃ del modelo no es gas) NH₃ + orgP → H₂ + HCN + HPO₃ es
    // exotérmica y catalizable; en el nivel 2 no reaccionan, y la proteína da NH₃ + C.
    assert.equal(nivelDeT(275), 1);
    const frio = m.quimica.reaccion(m.S.NH3, m.S.orgP, 1);
    assert.ok(frio && frio.dH < 0 && frio.catalisis >= 0 && frio.salidas.some((t) => m.quimica.sustancia(t.id).atomos[2] && t.id !== m.S.NH3),
      'a 259 K NH₃ + orgP da un producto con N');
    assert.equal(m.quimica.reaccion(m.S.NH3, m.S.orgP, 2), null);
    assert.deepEqual([nivelDeLote(275, SUELO), nivelDeLote(275, SIN), nivelDeLote(275, [0, 0, 0, 1]), nivelDeLote(1000, SUELO)],
      [2, 1, 2, nivelDeT(1000)]);
    // Poca materia orgánica en mucha roca: el calor que sueltan apenas sube la T (sigue en el nivel 1).
    const l = m.lote({ NH3: 1000, orgP: 1000, proteina: 1000, SiO2: 1_000_000 }, 275);
    for (let t = 0; t < 10; t++) pasoLote(m.ctx(500 + t), l, 1, SUELO);
    assert.equal(nivelDeT(m.arena.vista(l).T), 1, `T ${m.arena.vista(l).T}`);
    const ids = new Uint32Array(64), n = m.arena.especies(l, ids);
    const conN = [...ids.subarray(0, n)].filter((id) => m.quimica.sustancia(id).atomos[2]! > 0);
    assert.deepEqual(conN.filter((id) => id !== m.S.NH3 && id !== m.S.proteina), [], 'ningún otro compuesto de N (HCN)');
    assert.equal(m.arena.cuantos(l, m.S.NH3), 2000, 'la proteína se mineraliza a NH₃ + C con la química del nivel 2');
    assert.deepEqual(m.arena.saldo(), m.esperado());
  } finally { await m.cerrar(); }
});

test('extremo: barrera enorme, frío, sin calor, endotérmica recortada, lote vacío, ν sin pareja y química encolada', async () => {
  const m = materiaReal();
  const diferida = crearServicioQuimico({ modo: 'diferido' });
  try {
    // Madera y O₂ sin catálisis a 295 K: k ~ 10⁻²² por tick, nada en 1.000 ticks y sin NaN.
    const frio = m.lote({ madera: 1e9, O2: 1e9 }, 295);
    for (let t = 0; t < 1000; t++) pasoLote(m.ctx(5), frio, 10, SIN);
    assert.equal(m.arena.cuantos(frio, m.S.CO2), 0);
    // T = 0 con barrera > 0: no reacciona.
    const cero = m.lote({ madera: 1e6, O2: 1e6 }, 0);
    assert.equal(pasoLote(m.ctx(6), cero, 10, SIN), 0);
    // CaCO₃ → CaO + CO₂ es endotérmica (dH = +207, la barrera nunca baja de dH): con k·dt ≫ 1 solo avanza lo que
    // paga el calor, que queda en el resto de la división, nunca negativo, y la arena no recorta.
    const endo = m.lote({ CaCO3: 1e6 }, 1250);
    const calor = m.arena.calor(endo);
    const { arena, recortes } = conRecortes(m.arena);
    assert.equal(pasoLote({ ...m.ctx(7), arena }, endo, 100, SIN), Math.floor(calor / 207));
    assert.equal(m.arena.calor(endo), calor % 207);
    assert.equal(recortes(), 0, 'el recorte por calor lo hace pasoLote, no la arena');
    // Borde alto de la tabla de niveles: a 5.000 K (ℓ = 15) la calcinación va a ~10⁵/tick y hay calor de sobra.
    const caliente = m.lote({ CaCO3: 1e6 }, 5000);
    assert.equal(nivelDeT(m.arena.vista(caliente).T), 15);
    pasoLote(m.ctx(8), caliente, 1, SIN);
    assert.equal(m.arena.cuantos(caliente, m.S.CaCO3), 0);
    assert.equal(m.arena.cuantos(caliente, m.S.CaO), 1e6);
    // Lotes de un cuanto: la proteína se parte entera; madera + O₂ con barrera 0 reacciona; un H₂ solo no tiene los dos
    // que pide 2 H₂ + O₂, y dos sí.
    const unaProt = m.lote({ proteina: 1 }, 295);
    pasoLote(m.ctx(9), unaProt, 1, [0, 141, 0, 0]);
    assert.equal(m.arena.cuantos(unaProt, m.S.NH3), 1);
    const unPar = m.lote({ madera: 1, O2: 1 }, 295);
    pasoLote(m.ctx(10), unPar, 1, [200, 0, 0, 0]);
    assert.equal(m.arena.cuantos(unPar, m.S.CO2), 1);
    const unH2 = m.lote({ H2: 1, O2: 1 }, 295);
    assert.equal(pasoLote(m.ctx(11), unH2, 1, [0, 0, 0, 200]), 0);
    const dosH2 = m.lote({ H2: 2, O2: 1 }, 295);
    assert.equal(pasoLote(m.ctx(12), dosH2, 1, [0, 0, 0, 200]), 1);
    assert.equal(m.arena.cuantos(dosH2, m.S.H2O), 2);
    // Lote vacío.
    assert.equal(pasoLote(m.ctx(13), m.lote({}, 300), 1, SIN), 0);
    // Química encolada (servicio diferido con las mismas sustancias): nada este paso; tras la barrera, sí.
    registrarSustanciasBase(diferida);
    const encolada = m.lote({ proteina: 1000 }, 295);
    assert.equal(pasoLote(m.ctx(14, diferida), encolada, 1, [0, 141, 0, 0]), 0);
    assert.equal(m.arena.cuantos(encolada, m.S.proteina), 1000);
    await diferida.esperarBarrera();
    assert.equal(pasoLote(m.ctx(15, diferida), encolada, 1, [0, 141, 0, 0]), 1000);
    assert.deepEqual(m.arena.saldo(), m.esperado());
  } finally { await m.cerrar(); await diferida.cerrar(); }
});

test('cadencia: un paso con dt = 10 da la misma distribución que diez de dt = 1, con la media de primer orden', async () => {
  const kappa: Kappa = [0, 73, 0, 0], n0 = 20_000, replicas = 400;
  const m = materiaReal({ capacidad: 2 * replicas + 16 });
  const r = m.quimica.reaccion(m.S.proteina, 0, nivelDeT(310))!; // ea = γ·D(C–H) = 141,05
  const k = NU * Math.exp(-(r.ea - 73) / (R * 310));
  const correr = (pasos: number, dt: number, r: number) => {
    // 10⁷ de N₂ inerte: la reacción apenas cambia la temperatura del lote (< 0,1 K), así que k es la misma en los dos casos.
    const l = m.lote({ proteina: n0, N2: 1e7 }, 310);
    const c = m.ctx(31 * r + pasos);
    for (let t = 0; t < pasos; t++) pasoLote(c, l, dt, kappa);
    return m.arena.cuantos(l, m.S.proteina);
  };
  const largo = Array.from({ length: replicas }, (_, r) => correr(1, 10, r));
  const corto = Array.from({ length: replicas }, (_, r) => correr(10, 1, r));
  await m.cerrar();
  const { d, p } = ks(largo, corto);
  assert.ok(p > 0.01, `KS D = ${d.toFixed(3)}, p = ${p.toExponential(2)}`);
  const media = largo.reduce((s, v) => s + v, 0) / replicas, teorica = n0 * Math.exp(-k * 10);
  const sigma = Math.sqrt(teorica * (1 - teorica / n0) / replicas);
  assert.ok(Math.abs(media - teorica) < 5 * sigma + 2, `media ${media.toFixed(1)} frente a ${teorica.toFixed(1)} ± ${sigma.toFixed(2)}`);
});

test('binomial: momentos en las dos ramas y enteros en [0, n] hasta 2⁵³ − 1', () => {
  const azar = azarSembrado(99);
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

/** Canales que registra P al empezar un paso (los de las especies presentes), con su k y sus coeficientes. */
function canalesDe(m: MateriaReal, l: LoteRef, kappa: Kappa) {
  const { T, V } = medir(m.ctx(0), l), nivel = nivelDeLote(T, kappa); // el mismo selector que pasoLote
  const ids = Object.values(m.S).filter(id => m.arena.cuantos(l, id) > 0).sort((a, b) => a - b);
  const canales: { r: Reaccion; k: number }[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = -1; j <= i; j++) {
    const r = m.quimica.reaccion(ids[i]!, j < 0 ? 0 : ids[j]!, nivel);
    if (!r) continue;
    canales.push({ r, k: NU * Math.exp(-barreraEfectiva(r, kappa) / (R * T)) });
  }
  return { canales, V };
}

/** EDO de acción de masas de esos canales, RK4 con pasos de ≤ 0,1 %. No abre los canales de los productos: los pases
 * encadenados de P sí, pero en estos casos ninguno reacciona a la T del paso (los productos son H₂O, C, CO₂ y H₂ sin κ H–H). */
function edo(canales: ReturnType<typeof canalesDe>['canales'], V: number, n0: Map<SustanciaId, number>): Map<SustanciaId, number> {
  const ids = [...new Set([...n0.keys(), ...canales.flatMap(c => [...c.r.entradas, ...c.r.salidas].map(x => x.id))])];
  const ix = new Map(ids.map((id, i) => [id, i]));
  const tasas = (n: Float64Array) => canales.map(({ r, k }) => {
    const [a, b] = r.entradas;
    return !b ? (r.b === 0 ? k * n[ix.get(a!.id)!]! : k * n[ix.get(a!.id)!]! ** 2 / V) : k * n[ix.get(a!.id)!]! * n[ix.get(b.id)!]! / V;
  });
  const derivada = (n: Float64Array) => {
    const d = new Float64Array(ids.length), w = tasas(n);
    canales.forEach(({ r }, c) => {
      for (const x of r.entradas) d[ix.get(x.id)!]! -= x.nu * w[c]!;
    });
    return { d, w };
  };
  let n = Float64Array.from(ids, id => n0.get(id) ?? 0);
  const hechos = new Float64Array(canales.length);
  for (let t = 0; t < 1;) {
    const { d } = derivada(n);
    let h = 1 - t;
    ids.forEach((_, i) => { if (n[i]! > 1e-9 && d[i]! < 0) h = Math.min(h, 1e-3 * n[i]! / -d[i]!); });
    const mas = (x: Float64Array, y: Float64Array, f: number) => x.map((v, i) => Math.max(0, v + f * y[i]!));
    const k1 = derivada(n), k2 = derivada(mas(n, k1.d, h / 2)), k3 = derivada(mas(n, k2.d, h / 2)), k4 = derivada(mas(n, k3.d, h));
    n = n.map((v, i) => Math.max(0, v + h * (k1.d[i]! + 2 * k2.d[i]! + 2 * k3.d[i]! + k4.d[i]!) / 6));
    for (let c = 0; c < canales.length; c++) hechos[c]! += h * (k1.w[c]! + 2 * k2.w[c]! + 2 * k3.w[c]! + k4.w[c]!) / 6;
    t += h;
  }
  const fin = new Map(ids.map((id, i) => [id, n[i]!]));
  canales.forEach(({ r }, c) => { for (const x of r.salidas) fin.set(x.id, (fin.get(x.id) ?? 0) + x.nu * hechos[c]!); });
  return fin;
}

test('competencia: canales reales que comparten reactivo conservan su diferencia de velocidad (frente a la EDO fina)', async () => {
  // Medias de 10 réplicas con dt = 1 frente a RK4 a T y V fijos, como en pasoLote. Madera a 310 K con κ₀ = 80: se
  // carboniza (unaria), da 2 H₂ + C + CO₂ de dos en dos (a + a, ν = 2, endotérmica: sin catálisis, enmienda 2) y arde
  // (a + b). El glicósido a 310 K da los mismos tres canales con su a + a exotérmica (2 glicósido → 2 H₂ + C + CO₂,
  // dH −78), así que compite de verdad (Bernoulli). A 600 K, solo carbonización y combustión, con O₂ o madera escasos.
  const casos: { nombre: string; contenido: Contenido; T: number; kappa: Kappa; canales: number }[] = [
    { nombre: 'tres canales a 310 K', contenido: { madera: 1e6, O2: 1e6 }, T: 310, kappa: [80, 0, 0, 0], canales: 3 },
    { nombre: 'tres canales con a + a exotérmica', contenido: { glicosido: 1e6, O2: 1e6 }, T: 310, kappa: [130, 0, 0, 0], canales: 3 },
    { nombre: 'parecidas a 600 K', contenido: { madera: 1e6, O2: 1e6 }, T: 600, kappa: [26, 0, 0, 0], canales: 2 },
    { nombre: 'O₂ escaso', contenido: { madera: 1e6, O2: 1e3 }, T: 600, kappa: [40, 0, 0, 0], canales: 2 },
    { nombre: 'madera escasa', contenido: { madera: 1e3, O2: 1e6 }, T: 600, kappa: [60, 0, 0, 0], canales: 2 },
  ];
  for (const e of casos) {
    const medias = new Map<SustanciaId, number>();
    let esperado = new Map<SustanciaId, number>();
    const m = materiaReal({ capacidad: 32 });
    for (let r = 0; r < 10; r++) {
      const l = m.lote(e.contenido, e.T);
      if (r === 0) {
        const { canales, V } = canalesDe(m, l, e.kappa);
        assert.equal(canales.length, e.canales, `${e.nombre}: ${canales.map(c => `${c.r.a}+${c.r.b}`).join(', ')}`);
        esperado = edo(canales, V, new Map(Object.entries(e.contenido).map(([k, q]) => [m.S[k as keyof Base], q!])));
      }
      pasoLote(m.ctx(17 + r), l, 1, e.kappa);
      for (const id of esperado.keys()) medias.set(id, (medias.get(id) ?? 0) + m.arena.cuantos(l, id) / 10);
    }
    await m.cerrar();
    for (const [id, x] of esperado) {
      const v = medias.get(id) ?? 0;
      assert.ok(Math.abs(v - x) <= 0.05 * x + 3, `${e.nombre}: sustancia ${id} ${v.toFixed(1)} frente a ${x.toFixed(1)}`);
    }
  }
  // El caso del revisor: 2 H₂ + O₂ con k = ν (κ H–H ≥ ea) frente a la madera, que arde con k ~ 10⁻²² en el
  // mismo O₂. Repartir las demandas ya saturadas le daba a la lenta una fracción del O₂. Defecto de P hallado con la
  // química real (enmienda 1): P dejaba de vigilar un reactivo cuando le quedaba 10⁻⁴ de lo que tenía y el último subpaso
  // repartía por el punto medio, donde ya no hay H₂, así que el O₂ le daba 0 y quedaban ~100 de 10⁶ H₂ (igual con C + O₂
  // 1:1; ~900 con 10⁷). Con AGOTADO absoluto (medio cuanto) queda a lo sumo una vez sin dar; O₂ y H₂ salen en la
  // proporción exacta de ν.
  let co2 = 0;
  const m = materiaReal({ capacidad: 32 });
  for (let r = 0; r < 10; r++) {
    const l = m.lote({ H2: 1e6, madera: 1e6, O2: 1e6 }, 295);
    pasoLote(m.ctx(1 + r), l, 1, [0, 0, 0, KAPPA_SUELO_HH]);
    const co2r = m.arena.cuantos(l, m.S.CO2), h2 = m.arena.cuantos(l, m.S.H2);
    co2 += co2r;
    assert.ok(h2 % 2 === 0 && h2 <= 2, `H₂ sin gastar: ${h2}`);
    assert.equal(m.arena.cuantos(l, m.S.O2) + co2r, 5e5 + h2 / 2);
  }
  await m.cerrar();
  assert.ok(co2 <= 3, `CO₂ en 10 réplicas: ${co2}`);
});

test('instantáneos: madera, proteína y orgP de un suelo catalizado se agotan sin subpasos, repartidos como en la EDO fina', async () => {
  // Con κ del suelo la madera, la proteína y el orgP se descomponen con k = 414 por tick, y el orgP además reacciona con
  // el CaCO₃ (k = 414 por cuanto de CaCO₃ y litro), con el agua y con la madera; todos arden en el O₂ que comparten con
  // el C. Con dt = 1, Λ·dt va de 414 a ~10⁴: la fase instantánea los resuelve antes de los subpasos (antes, ~45 por
  // paso). El CaCO₃, en exceso, no es instantáneo aunque su riesgo al empezar lo sea. Medias de 10 réplicas frente a RK4,
  // comparando lo que cambia cada sustancia; sin el O₂, el C, el CO₂ y el H₂, porque los pases encadenados queman el C y
  // el H₂ que nacen (C + O₂, k ~ 10⁻³; H₂ + O₂ sin barrera) y la EDO no abre los canales de los productos (el integrador
  // anterior se desviaba igual: CO₂ 10.244 frente a 9.906).
  const casos: { nombre: string; contenido: Contenido }[] = [
    { nombre: 'suelo del banco', contenido: { O2: 2e5, N2: 8e5, H2O: 1.2e5, madera: 6e4, proteina: 2e4, orgP: 1e4, CaCO3: 1e6, C: 2e4 } },
    // El CaCO₃ justo por encima del orgP: el canal compite con la descomposición y se lleva más de la mitad del CaCO₃,
    // así que el reparto depende de su punto medio (corrector).
    { nombre: 'CaCO₃ escaso', contenido: { O2: 1e5, N2: 4e5, H2O: 5e4, madera: 2e4, orgP: 1e4, CaCO3: 1.6e4, SiO2: 1e6 } },
  ];
  for (const e of casos) {
    const m = materiaReal({ capacidad: 32 });
    const antes = { ...cuentaIntegrador };
    const medias = new Map<SustanciaId, number>(), n0 = new Map(Object.entries(e.contenido).map(([k, q]) => [m.S[k as keyof Base], q!]));
    let esperado = new Map<SustanciaId, number>();
    for (let r = 0; r < 10; r++) {
      const l = m.lote(e.contenido, 295);
      if (r === 0) { const { canales, V } = canalesDe(m, l, SUELO); esperado = edo(canales, V, n0); }
      pasoLote(m.ctx(40 + r), l, 1, SUELO);
      for (const id of esperado.keys()) medias.set(id, (medias.get(id) ?? 0) + m.arena.cuantos(l, id) / 10);
    }
    await m.cerrar();
    const compartidas = cuentaIntegrador.compartidas - antes.compartidas, sub = cuentaIntegrador.subpasos - antes.subpasos;
    assert.ok(cuentaIntegrador.instantaneas - antes.instantaneas >= 10, `${e.nombre}: la fase instantánea no actuó`);
    assert.ok(sub <= 3 * compartidas, `${e.nombre}: ${sub} subpasos en ${compartidas} integraciones`);
    let cambia = 0;
    for (const [id, x] of esperado) {
      if (id === m.S.O2 || id === m.S.C || id === m.S.CO2 || id === m.S.H2) continue;
      const x0 = n0.get(id) ?? 0, v = medias.get(id) ?? 0;
      if (Math.abs(x - x0) > 100) cambia++;
      // 2 % de lo que cambia, más 3σ del sorteo de la media de 10 réplicas (σ ≈ √(cambio/10)).
      assert.ok(Math.abs(v - x) <= 0.02 * Math.abs(x - x0) + 3 * Math.sqrt(Math.abs(x - x0) / 10) + 3, `${e.nombre}: sustancia ${id} cambia ${(v - x0).toFixed(1)} frente a ${(x - x0).toFixed(1)} en la EDO`);
    }
    assert.ok(cambia >= 5, `${e.nombre}: solo ${cambia} sustancias cambian`);
  }
});

test('calor y existencias: el recorte no depende del orden de las ranuras y reparte en proporción', async () => {
  // CaCO₃ → CaO + CO₂ (+207 J) y 2 H₂O → 2 H₂ + O₂ (+382 J, ν = 2) a 2.300 K, las dos con k·dt ≫ 1: piden un 5 % más
  // calor del que hay. El orden de las ranuras decidía quién se lo llevaba.
  const m = materiaReal({ capacidad: 128 });
  const correr = (orden: (keyof Base)[], caco3: number, agua: number, semilla: number) => {
    const cantidades: Contenido = { CaCO3: caco3, H2O: agua };
    const l = m.lote(Object.fromEntries(orden.map(k => [k, cantidades[k]])) as Contenido, 2300);
    assert.equal(nivelDeT(m.arena.vista(l).T), 14);
    const { arena, recortes } = conRecortes(m.arena);
    pasoLote({ ...m.ctx(semilla), arena }, l, 10, SIN);
    assert.deepEqual(m.arena.saldo(), m.esperado());
    assert.equal(recortes(), 0);
    return [m.arena.cuantos(l, m.S.CaO), m.arena.cuantos(l, m.S.H2), m.arena.calor(l)];
  };
  for (let semilla = 1; semilla <= 20; semilla++) {
    assert.deepEqual(correr(['CaCO3', 'H2O'], 1, 10, semilla), correr(['H2O', 'CaCO3'], 1, 10, semilla));
    assert.deepEqual(correr(['CaCO3', 'H2O'], 1000, 10_000, semilla), correr(['H2O', 'CaCO3'], 1000, 10_000, semilla));
  }
  // Cada una avanza la misma fracción de lo pedido (≈ 0,95) y no sobra el calor de una vez de la más cara.
  const [cao, h2, calor] = correr(['CaCO3', 'H2O'], 1000, 10_000, 7);
  const fC = cao! / 1000, fW = h2! / 10_000;
  assert.ok(fC > 0.9 && fC < 1 && Math.abs(fC - fW) <= 0.01 && calor! < 382, `CaO ${cao}, H₂ ${h2}, calor ${calor}`);
  await m.cerrar();
});

test('coste: con la tabla densa el sorteo es lineal en los canales, no cúbico', () => {
  // n sustancias que reaccionan todas con todas, lentas (nada se aplica): m ≈ n²/2 canales. Recorrer los m canales por
  // cada sustancia costaba n·m (de 512 a 1.024, ×8); agrupados, m (×4). Se mide la razón: no depende de la carga.
  // Doble de Q justificado: ninguna química real da una tabla en la que reaccionen todas las parejas de 1.024 sustancias.
  const preparar = (n: number): (() => number) => {
    const tabla = Array.from({ length: n + 1 }, (_, id): Sustancia => ({
      id, clase: 1, enlaces: new Uint16Array(0), atomos: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]), masa: 10, energia: 0,
      prop: { r: 0, dMedia: 0, tFusion: 0, tEbullicion: 1e9, qOxidacion: 0, dureza: 0, tenacidad: 0, flexibilidad: 0, polaridad: 0, densidad: 1, color: 0 },
    }));
    const filas = new Map<number, Reaccion>();
    const reaccion = (a: number, b: number): Reaccion => {
      const clave = a * (n + 1) + b;
      let r = filas.get(clave);
      if (!r) {
        const entradas = b === 0 ? [{ id: a, nu: 1 }] : a === b ? [{ id: a, nu: 2 }] : [{ id: a, nu: 1 }, { id: b, nu: 1 }];
        // dH < 0: P solo registra canales que ganan energía libre a la T del lote (`favorableA`: ΔG < −EPSILON_G; con
        // −1.000 lo decide sin mirar fases, como en casi toda fila real).
        filas.set(clave, r = { a, b, nivelT: 0, entradas, salidas: [], dH: -1000, ea: 120, catalisis: -1, paresCatalisis: 0 });
      }
      return r;
    };
    const arena = {
      especies: (_l: number, ids: Uint32Array) => { for (let i = 0; i < Math.min(n, ids.length); i++) ids[i] = i + 1; return n; },
      cuantos: () => 1000, calor: () => 0.025 * 1000 * n * 300, aplicar: () => assert.fail('nada debería aplicarse'),
    } as unknown as ArenaMateria;
    const c: CtxPaso = { arena, quimica: { internar: () => 0, sustancia: id => tabla[id]!, reaccion }, azar: () => 0.5 };
    pasoLote(c, 0, 1, SIN); // llena la tabla de filas fuera de la medida
    return () => { const t0 = performance.now(); pasoLote(c, 0, 1, SIN); return performance.now() - t0; };
  };
  preparar(256)(); // calienta
  // Mínimo de 5 medidas alternas de cada tamaño: con la mediana de 3 de cada uno por separado, la torre cargada daba
  // razones de 4 a 6,7 con el mismo código (y la recolección tras otra prueba caía en una sola de las dos).
  const [de512, de1024] = [preparar(512), preparar(1024)];
  let t512 = Infinity, t1024 = Infinity;
  for (let k = 0; k < 5; k++) { t512 = Math.min(t512, de512()); t1024 = Math.min(t1024, de1024()); }
  const razon = t1024 / t512;
  assert.ok(razon < 6, `de 512 a 1.024 sustancias el coste crece ×${razon.toFixed(1)}`);
});

test('fluir: relaja hacia el equilibrio sin cruzarlo, con empuje y con el calor de lo que se mueve', async () => {
  const m = materiaReal();
  try {
    const c = m.ctx(1);
    const [a, b] = [m.lote({ O2: 1_000_000 }, 0), m.lote({ CO2: 10 }, 0)];
    poner(m, a, 0, 7_500_000); poner(m, b, 0, 1_000);
    // G·dt enorme: queda en el equilibrio (±1 por el redondeo), sin oscilar.
    assert.ok(Math.abs(fluir(c, a, b, m.S.O2, 1e12, 1, 1, 0, 1) - 500_000) <= 1);
    assert.ok(Math.abs(m.arena.cuantos(a, m.S.O2) - m.arena.cuantos(b, m.S.O2)) <= 2);
    assert.ok(m.arena.calor(b) > 1_000, 'el O₂ lleva su parte del calor');
    // Con empuje φ el equilibrio es ψ_a − ψ_de = φ.
    fluir(c, a, b, m.S.O2, 1e12, 1, 1, 100_000, 1);
    assert.ok(Math.abs(m.arena.cuantos(b, m.S.O2) - m.arena.cuantos(a, m.S.O2) - 100_000) <= 2);
    // Calor: con G enorme iguala temperaturas; con G pequeña pasa ≈ G·dt·ΔT y del caliente al frío.
    const T = (l: LoteRef) => m.arena.calor(l) / (0.025 * m.atomos(l));
    m.arena.moverCalor(b, a, 400_000);
    const dT = T(a) - T(b), q = fluirCalor(c, a, b, 0.5, 1);
    assert.ok(q > 0 && Math.abs(q - 0.5 * dT) <= 0.01 * 0.5 * dT + 1, `q = ${q} frente a ${0.5 * dT}`);
    fluirCalor(c, a, b, 1e12, 1);
    assert.ok(Math.abs(T(a) - T(b)) < 1e-3, `T ${T(a)} y ${T(b)}`);
    assert.deepEqual(m.arena.saldo(), m.esperado());
  } finally { await m.cerrar(); }
});

test('fluir: capacidad del compartimento (llena uno vacío) y equilibrio discreto sin vaivén del último cuanto', async () => {
  const m = materiaReal();
  try {
    const c = m.ctx(2);
    const [a, b, d] = [m.lote({}, 0), m.lote({}, 0), m.lote({}, 0)];
    // Un lote vacío (ni cuantos ni calor) recibe gas de otro; y entre dos de O₂ puro a la misma T, el denso empuja al
    // ralo. Con medir(…).V como capacidad las dos cosas daban 0.
    poner(m, a, m.S.O2, 1_000_000); poner(m, a, 0, 1_000_000);
    assert.ok(fluir(c, a, b, m.S.O2, 1e12, 100, 100, 0, 1) >= 499_999);
    poner(m, d, m.S.O2, 1000); poner(m, d, 0, Math.round(m.arena.calor(a) * 1000 / m.arena.cuantos(a, m.S.O2)));
    assert.ok(fluir(c, a, d, m.S.O2, 1e12, 100, 100, 0, 1) > 200_000);
    // Un cuanto entre capacidades iguales: el equilibrio continuo es medio cuanto y no se mueve en ningún sentido.
    const [x, y] = [m.lote({ O2: 1 }, 0), m.lote({}, 0)];
    for (let t = 0; t < 200; t++) {
      assert.equal(fluir(c, x, y, m.S.O2, 1e12, 1, 1, 0, 1), 0);
      assert.equal(fluir(c, y, x, m.S.O2, 1e12, 1, 1, 0, 1), 0);
    }
    // Tres cuantos: se asientan en 1 y 2 (o 2 y 1) y ahí se quedan.
    poner(m, x, m.S.O2, 3);
    fluir(c, x, y, m.S.O2, 1e12, 1, 1, 0, 1);
    const asentado = [m.arena.cuantos(x, m.S.O2), m.arena.cuantos(y, m.S.O2)];
    assert.deepEqual([...asentado].sort(), [1, 2]);
    for (let t = 0; t < 200; t++) { fluir(c, x, y, m.S.O2, 1e12, 1, 1, 0, 1); fluir(c, y, x, m.S.O2, 1e12, 1, 1, 0, 1); }
    assert.deepEqual([m.arena.cuantos(x, m.S.O2), m.arena.cuantos(y, m.S.O2)], asentado);
    // Calor: con 1 J de diferencia el equilibrio es medio julio, que en coma flotante queda a un lado en los dos sentidos.
    poner(m, x, m.S.O2, 1); poner(m, y, m.S.O2, 1); poner(m, x, 0, 1001); poner(m, y, 0, 1000);
    for (let t = 0; t < 200; t++) { assert.equal(fluirCalor(c, x, y, 1e12, 1), 0); assert.equal(fluirCalor(c, y, x, 1e12, 1), 0); }
    assert.deepEqual(m.arena.saldo(), m.esperado());
  } finally { await m.cerrar(); }
});

/** La columna de dueños de la arena real (lotes sin celda): la que reparte M1 entre hilos. */
const duenos = (m: MateriaReal) => new Uint32Array(m.memoria.lotes.columnas.get('materia.dueno')!.memoria);

test('dueños: un hilo solo escribe sus lotes; los caducados se saltan; la arena valida antes de escribir', async () => {
  const m = materiaReal();
  try {
    const [l0, l1, muerto] = [m.lote({ proteina: 100 }, 295), m.lote({ proteina: 100 }, 295), m.lote({}, 0)];
    m.arena.liberar(muerto);
    m.arena.barrera();
    duenos(m)[slotDe(l1)] = 1;
    const c = m.ctx(3), kappas = new Float64Array(12).fill(KAPPA_SUELO);
    assert.throws(() => pasarLotes(c, Float64Array.from([l0, l1, muerto]), kappas, 0, 3, 1), /otro dueño/);
    assert.equal(m.arena.cuantos(l1, m.S.proteina), 100, 'el lote ajeno no se tocó');
    assert.equal(pasarLotes(c, Float64Array.from([l0, muerto]), kappas, 0, 2, 1), 1, 'el caducado se salta');
    assert.throws(() => m.arena.moverCalor(l0, l1, 1), /ajeno/);
    // Validar antes de escribir: 1 J hacia un lote con 2⁵³ − 1 J falla sin debitar el origen; mover una parte que lleva
    // su calor (12.500 J de 100 de 1.000 CaCO₃ a 1.000 K), igual.
    duenos(m)[slotDe(l1)] = 0;
    poner(m, l1, 0, Number.MAX_SAFE_INTEGER);
    const caliza = m.lote({ CaCO3: 1000 }, 1000);
    const antes = m.arena.saldo();
    assert.throws(() => m.arena.moverCalor(caliza, l1, 1), /Calor/);
    assert.throws(() => m.arena.moverParte(caliza, l1, { parte: Parte.Exacta, esp: m.S.CaCO3, cuantos: 100, kappa: null }), /Calor/);
    assert.deepEqual(m.arena.saldo(), antes);
    assert.equal(m.arena.cuantos(caliza, m.S.CaCO3), 1000);
  } finally { await m.cerrar(); }
});

test('reparto entre hilos: µs por lote con 1 y 28 hilos desde la misma mezcla, cobertura e I2 exacto', async t => {
  const n = 28 * 2000;
  const m = materiaReal({ capacidad: n + 256 });
  try {
    const lotes = Array.from({ length: n }, (_, l) => m.lote(
      { madera: 2000 + l % 97, O2: 1500, H2O: 300, proteina: 500 + l % 13 }, 650 + l % 200));
    const foto = [...m.arena.muestras()].map(x => x.pares);
    const dueno = duenos(m);
    // Entre despachos, como el coordinador en F0: la barrera devuelve el desborde que soltaron los lotes. Con la enmienda
    // 2 la proteína caliente ya no se va entera a H₂ + HCN en un paso (endotérmica, sin catálisis) y cada lote acaba con 9
    // especies, una fila de desborde cada uno: sin la barrera, seis despachos agotaban el desborde de la memoria de prueba.
    const restaurar = () => {
      for (const l of lotes) dueno[slotDe(l)] = 0;
      [...m.arena.muestras()].forEach((x, i) => {
        m.arena.sumidero(x.ref, x.pares, m.libro);
        m.arena.fuente(x.ref, foto[i]!, m.libro);
      });
      m.arena.barrera();
    };
    const productos = () => [m.S.CO2, m.S.C, m.S.H2].map(esp => total(m, lotes, esp));
    // Dueños por bloques contiguos, como las páginas de un chunk, la lista agrupada por dueño y dónde empieza cada grupo.
    const despacho = (hilos: number) => {
      const lista = new Float64Array(new SharedArrayBuffer(8 * n)), kappas = new Float64Array(new SharedArrayBuffer(32 * n));
      const cortes = new Float64Array(new SharedArrayBuffer(8 * (hilos + 1)));
      lotes.forEach((l, i) => { dueno[slotDe(l)] = Math.floor(i * hilos / n); });
      let i = 0;
      for (let h = 0; h < hilos; h++) {
        cortes[h] = i;
        lotes.forEach((l, j) => { if (Math.floor(j * hilos / n) === h) { lista[i] = l; kappas[4 * i + 1] = KAPPA0 / 2; i++; } });
      }
      cortes[hilos] = n;
      return { lotes: lista.buffer as SharedArrayBuffer, kappas: kappas.buffer as SharedArrayBuffer, cortes: cortes.buffer as SharedArrayBuffer };
    };
    // Referencia en el hilo principal: el mismo bucle que corre cada worker.
    const uno = despacho(1);
    const t0 = performance.now();
    assert.equal(pasarLotes(m.ctx(5), new Float64Array(uno.lotes), new Float64Array(uno.kappas), 0, n, 1), n);
    const principal = performance.now() - t0, referencia = productos();
    assert.deepEqual(m.arena.saldo(), m.esperado());
    const medidas: Record<number, number> = {}, mezcla: Record<number, number[]> = {};
    for (const hilos of [1, 28]) {
      restaurar();
      const trabajo = despacho(hilos);
      const piscina = new PiscinaReal(hilos, m.memoria, m.quimica, 1000 * hilos);
      try {
        await piscina.correr(trabajo, { dt: 1 }); // calienta: carga de módulos, JIT y química en frío de cada worker
        const ms: number[] = [];
        for (let r = 0; r < 5; r++) {
          restaurar();
          despacho(hilos);
          const { ms: v, lotes: avanzados } = await piscina.correr(trabajo, { dt: 1 });
          assert.equal(avanzados, n, 'cada lote avanzó una vez');
          assert.deepEqual(m.arena.saldo(), m.esperado());
          ms.push(v);
        }
        medidas[hilos] = ms.sort((a, b) => a - b)[2]!;
        mezcla[hilos] = productos();
      } finally { await piscina.cerrar(); }
    }
    // Misma mezcla de partida: CO₂, C y H₂ totales coinciden con la referencia dentro del ruido.
    for (const hilos of [1, 28]) mezcla[hilos]!.forEach((v, k) => assert.ok(Math.abs(v - referencia[k]!) <= 0.01 * referencia[k]! + 30,
      `${hilos} hilos: ${v} frente a ${referencia[k]} (producto ${k})`));
    const informe = `${n} lotes reales (madera, O₂, H₂O y proteína a 650–850 K; CO₂/C/H₂ = ${referencia.join('/')}): `
      + `hilo principal ${(1000 * principal / n).toFixed(2)} µs/lote; `
      + `1 hilo ${(1000 * medidas[1]! / n).toFixed(2)} µs/lote (${medidas[1]!.toFixed(1)} ms); `
      + `28 hilos ${(1000 * medidas[28]! / n).toFixed(2)} µs/lote (${medidas[28]!.toFixed(1)} ms), aceleración ${(medidas[1]! / medidas[28]!).toFixed(1)}×; `
      + `carga ${loadavg().map(v => v.toFixed(1)).join(' ')}`;
    t.diagnostic(informe);
    console.log(informe);
  } finally { await m.cerrar(); }
});
