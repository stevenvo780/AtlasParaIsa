import assert from 'node:assert/strict';
import test from 'node:test';
import type { Worker } from 'node:worker_threads';
import { ELEMENTOS, GAMMA, KAPPA0, KAPPA_SUELO, NE, S_GAS, TABLA } from '../src/shared/naturaleza.js';
import { ClaseSustancia, TIPOS } from '../src/shared/materia.js';
import { createWorld } from '../src/world/index.js';
import { comprobarInvariantes, listaInvariantes } from '../src/world/invariantes.js';
import { NIVELES_T, nivelDeT, tDeNivel, type Reaccion, type Sustancia } from '../src/world/materia/tipos.js';
import {
  ContextoSolver, atomosDeEnlaces, calcularCinetica, construirSustancia, energiaRed,
  esGasA, grafoElementosConexo, indiceTipoEnlace, normalizarEnlaces,
  productos, realizable,
} from '../src/world/materia/quimica.js';
import {
  asociarServicioQuimico, cargarSustancias, crearServicioQuimico,
  serializarSustancias, verificarI4, verificarI4Acotado,
  type FilaMemoQuimico, type ServicioQuimicoAuditable,
} from '../src/world/materia/servicio.js';
import {
  ejecutarBancoRendimiento, ejecutarTablaCordura, registrarSustanciasBase, tasaArrhenius,
} from '../scripts/lab-materia.mjs';

function E(a: string, b: string, k: 1 | 2 | 3 = 1): number {
  const i = indiceTipoEnlace(ELEMENTOS.indexOf(a as never), ELEMENTOS.indexOf(b as never), k);
  assert.ok(i >= 0, `Enlace inexistente ${a}-${b}(${k})`);
  return i;
}

function B(pares: readonly [number, number][]): Uint16Array {
  return normalizarEnlaces(Uint16Array.from(pares.flat()));
}

/**
 * Oráculo sin poda e independiente del solver: todos los vectores saturados y conexos de cada sub-estequiometría,
 * evaluados con `construirSustancia`, y una programación dinámica sobre todas las particiones (≤ 6 átomos).
 */
function minimoFuerzaBruta(objetivo: Uint8Array, nivelT: number): { g: number; gases: number } | null {
  const Ts = tDeNivel(nivelT) * S_GAS;
  const g = (s: Sustancia) => s.energia - (esGasA(s, tDeNivel(nivelT)) ? Ts : 0);
  function mejorDe(u: Uint8Array): { g: number; gases: number } | null {
    const rem = Array.from(u, (n, e) => n * TABLA[e]!.valencia);
    const tipos = TIPOS.flatMap((t, i) => (u[t.e]! > 0 && u[t.f]! > 0 ? [i] : []));
    const cuentas = new Array<number>(tipos.length).fill(0);
    let mejor: { g: number; gases: number } | null = null;
    function rec(pos: number): void {
      if (pos === tipos.length) {
        if (rem.some(r => r !== 0)) return;
        const en = B(tipos.flatMap((t, i) => (cuentas[i]! > 0 ? [[t, cuentas[i]!] as [number, number]] : [])));
        const at = atomosDeEnlaces(en);
        if (!at || at.some((n, e) => n !== u[e]) || !grafoElementosConexo(en, at)) return;
        const s = construirSustancia(1, en);
        const cand = { g: g(s), gases: esGasA(s, tDeNivel(nivelT)) ? 1 : 0 };
        if (!mejor || cand.g < mejor.g - 1e-9 || (Math.abs(cand.g - mejor.g) <= 1e-9 && cand.gases > mejor.gases)) mejor = cand;
        return;
      }
      const t = TIPOS[tipos[pos]!]!;
      const paso = t.e === t.f ? 2 * t.k : t.k;
      for (let c = 0; t.e === t.f ? rem[t.e]! >= c * paso : rem[t.e]! >= c * t.k && rem[t.f]! >= c * t.k; c++) {
        cuentas[pos] = c;
        rem[t.e]! -= c * t.k; rem[t.f]! -= c * t.k;
        rec(pos + 1);
        rem[t.e]! += c * t.k; rem[t.f]! += c * t.k;
      }
      cuentas[pos] = 0;
    }
    rec(0);
    return mejor;
  }
  const pasos = Array.from(objetivo, (_, e) => objetivo.slice(0, e).reduce((p, n) => p * (n + 1), 1));
  const estados = objetivo.reduce((p, n) => p * (n + 1), 1);
  const dp: ({ g: number; gases: number } | null)[] = new Array(estados).fill(null);
  dp[0] = { g: 0, gases: 0 };
  const sub = (idx: number) => Uint8Array.from(objetivo, (n, e) => Math.floor(idx / pasos[e]!) % (n + 1));
  const opt = Array.from({ length: estados }, (_, i) => (i === 0 ? null : mejorDe(sub(i))));
  for (let i = 1; i < estados; i++) {
    const ui = sub(i);
    for (let j = 1; j <= i; j++) {
      const uj = sub(j);
      if (!opt[j] || uj.some((n, e) => n > ui[e]!)) continue;
      const resto = dp[i - j];
      if (!resto) continue;
      const cand = { g: resto.g + opt[j]!.g, gases: resto.gases + opt[j]!.gases };
      const d = dp[i];
      if (!d || cand.g < d.g - 1e-9 || (Math.abs(cand.g - d.g) <= 1e-9 && cand.gases > d.gases)) dp[i] = cand;
    }
  }
  return dp[estados - 1]!;
}

test('normalizarEnlaces, saturación y rechazo de vectores inválidos o > 8 átomos', () => {
  const desordenado = Uint16Array.from([E('C', 'O'), 1, E('H', 'O'), 1, E('C', 'O'), 0, E('C', 'C'), 1, E('H', 'C'), 1]);
  const norm = normalizarEnlaces(desordenado);
  assert.equal(norm.length, 8);
  assert.ok(norm[0]! < norm[2]! && norm[2]! < norm[4]! && norm[4]! < norm[6]!);
  const at = atomosDeEnlaces(norm);
  assert.deepEqual([...at!], [2, 1, 0, 1, 0, 0, 0, 0]);

  // Longitud impar, tipo inválido, sin saturar, > 8 átomos y grafo de elementos disconexo.
  assert.throws(() => normalizarEnlaces(Uint16Array.from([0, 1, 2])));
  assert.throws(() => normalizarEnlaces(Uint16Array.from([TIPOS.length, 1])));
  assert.equal(atomosDeEnlaces(Uint16Array.from([E('H', 'O'), 1])), null, 'OH radical no satura');
  assert.equal(atomosDeEnlaces(B([[E('C', 'O'), 2], [E('H', 'C'), 6]])), null, 'C2H6O tiene 9 átomos > 8');
  assert.throws(() => construirSustancia(1, B([[E('O', 'Ca'), 2], [E('H', 'H'), 1]])), 'CaO + H2 es disconexo');
});

test('realizable() distingue moléculas reales, unidades, contraejemplos de grafos y jaulas 3D rígidas', () => {
  const moleculas: [string, Uint16Array][] = [
    ['H2', B([[E('H', 'H'), 1]])],
    ['O2', B([[E('O', 'O', 2), 1]])],
    ['N2', B([[E('N', 'N', 3), 1]])],
    ['H2O', B([[E('H', 'O'), 2]])],
    ['NH3', B([[E('H', 'N'), 3]])],
    ['CH4', B([[E('H', 'C'), 4]])],
    ['CO2', B([[E('C', 'O', 2), 2]])],
    ['C2H6 etano', B([[E('C', 'C'), 1], [E('H', 'C'), 6]])],
    ['C2H4 eteno', B([[E('C', 'C', 2), 1], [E('H', 'C'), 4]])],
    ['C2H2 etino', B([[E('C', 'C', 3), 1], [E('H', 'C'), 2]])],
    ['CH2O formaldehído', B([[E('C', 'O', 2), 1], [E('H', 'C'), 2]])],
    ['HCN', B([[E('C', 'N', 3), 1], [E('H', 'C'), 1]])],
    ['H3PO4', B([[E('O', 'P'), 3], [E('O', 'P', 2), 1], [E('H', 'O'), 3]])],
    ['urea CON2H4', B([[E('C', 'O', 2), 1], [E('C', 'N'), 2], [E('H', 'N'), 4]])],
    ['ácido acético', B([[E('C', 'C'), 1], [E('C', 'O', 2), 1], [E('C', 'O'), 1], [E('H', 'C'), 3], [E('H', 'O'), 1]])],
    ['butatrieno C4H4', B([[E('C', 'C', 2), 3], [E('H', 'C'), 4]])],
  ];
  for (const [nombre, en] of moleculas) {
    assert.equal(realizable(en), true, `${nombre} debe ser molécula realizable`);
  }

  const noRealizables: [string, Uint16Array][] = [
    // Unidades de red clásicas.
    ['C carbón', B([[E('C', 'C'), 2]])],
    ['CH2 polietileno/grasa', B([[E('C', 'C'), 1], [E('H', 'C'), 2]])],
    ['CH2O madera', B([[E('C', 'C'), 1], [E('H', 'C'), 1], [E('C', 'O'), 1], [E('H', 'O'), 1]])],
    ['SiO2 sílice', B([[E('O', 'Si'), 4]])],
    ['H2SiO3 arcilla', B([[E('O', 'Si'), 4], [E('H', 'O'), 2]])],
    ['Fe2 hierro', B([[E('Fe', 'Fe'), 3]])],
    ['CaCO3 caliza', B([[E('O', 'Ca'), 2], [E('C', 'O'), 2], [E('C', 'O', 2), 1]])],
    ['CaHPO4 hueso', B([[E('O', 'Ca'), 2], [E('O', 'P'), 3], [E('O', 'P', 2), 1], [E('H', 'O'), 1]])],
    // 4 contraejemplos que pasaban la condición relajada E ≥ N − 1 + cotas por par.
    ['CE1 grafo elementos disconexo {C=C:3, O=O:1}', B([[E('C', 'C', 2), 3], [E('O', 'O', 2), 1]])],
    ['CE2 N≡N aislado en {N≡N:1, N-N:3, N-H:3}', B([[E('N', 'N', 3), 1], [E('N', 'N'), 3], [E('H', 'N'), 3]])],
    ['CE3 desborde valencia {C≡C:1, C=C:1, C-H:2}', B([[E('C', 'C', 3), 1], [E('C', 'C', 2), 1], [E('H', 'C'), 2]])],
    ['CE4 C≡C aísla CO2 en {C=O:2, C≡C:1, C-C:1}', B([[E('C', 'O', 2), 2], [E('C', 'C', 3), 1], [E('C', 'C'), 1]])],
    // Jaulas 3D rígidas (r ≥ R_RIGIDEZ = 2,4) que de otro modo volatilizarían rocas/carbón.
    ['Jaula K5 carbono C5', B([[E('C', 'C'), 10]])],
    ['Jaula K2,4 sílice Si2O4', B([[E('O', 'Si'), 8]])],
    ['Jaula K3,4 Si3N4', B([[E('N', 'Si'), 12]])],
    ['Jaula K2,5 P2O5', B([[E('O', 'P'), 10]])],
    ['Jaula K2,4 poli-CO2 C2O4', B([[E('C', 'O'), 8]])],
    ['Jaula K2,3 Si2O3H2', B([[E('O', 'Si'), 6], [E('H', 'Si'), 2]])],
    ['Jaula K4 N4', B([[E('N', 'N'), 6]])],
  ];
  for (const [nombre, en] of noRealizables) {
    assert.equal(realizable(en), false, `${nombre} NO debe ser molécula`);
  }
});

test('energiaRed() es homogénea de grado 1, nula en covalentes y resiste exploits iónicos', () => {
  // Nula en toda especie covalente.
  for (const en of [
    B([[E('C', 'O', 2), 2]]),
    B([[E('C', 'O'), 4]]),
    B([[E('C', 'O', 2), 1], [E('C', 'O'), 2], [E('H', 'O'), 2]]), // H2CO3
    B([[E('O', 'Si'), 4]]),
    B([[E('O', 'Fe'), 6]]),
  ]) assert.equal(energiaRed(en), 0);

  // Homogeneidad exacta de grado 1: E_red(m·b) === m·E_red(b).
  const caCO3 = B([[E('O', 'Ca'), 2], [E('C', 'O'), 2], [E('C', 'O', 2), 1]]);
  const caCO3x2 = Uint16Array.from(caCO3, (v, i) => (i % 2 === 1 ? v * 2 : v));
  assert.equal(energiaRed(caCO3), 270);
  assert.equal(energiaRed(caCO3x2), 2 * energiaRed(caCO3));

  const caOH2 = B([[E('O', 'Ca'), 2], [E('H', 'O'), 2]]);
  const caOH2x2 = Uint16Array.from(caOH2, (v, i) => (i % 2 === 1 ? v * 2 : v));
  assert.equal(energiaRed(caOH2), 100);
  assert.equal(energiaRed(caOH2x2), 2 * energiaRed(caOH2));

  // Sin exploit de super-ozónido {Ca-O:2, O-O:2, O=O:1} (Y === X excluido) ni CaO + O2 / N2 / CH4.
  assert.equal(energiaRed(B([[E('O', 'Ca'), 2], [E('O', 'O'), 2], [E('O', 'O', 2), 1]])), 0);
  // Sin doble conteo en CaC2O5 (tope min(I_O, C_O) = 2) ni en CaHPO4.
  const caC2O5 = B([[E('O', 'Ca'), 2], [E('C', 'O'), 4], [E('C', 'O', 2), 2]]);
  assert.equal(energiaRed(caC2O5), energiaRed(caCO3));
  const caHPO4 = B([[E('O', 'Ca'), 2], [E('O', 'P'), 3], [E('O', 'P', 2), 1], [E('H', 'O'), 1]]);
  assert.equal(energiaRed(caHPO4), 270);

  const serv = crearServicioQuimico({ modo: 'inmediato' });
  const idCaO = serv.internar(B([[E('O', 'Ca'), 2]]));
  const idO2 = serv.internar(B([[E('O', 'O', 2), 1]]));
  const idN2 = serv.internar(B([[E('N', 'N', 3), 1]]));
  const idCH4 = serv.internar(B([[E('H', 'C'), 4]]));
  const idCaCO3 = serv.internar(caCO3);
  const idCO2 = serv.internar(B([[E('C', 'O', 2), 2]]));
  for (const lvl of [nivelDeT(295), nivelDeT(800), nivelDeT(1250)]) {
    assert.equal(serv.reaccion(idCaO, idO2, lvl), null, 'CaO no debe reaccionar con O2');
    assert.equal(serv.reaccion(idCaO, idN2, lvl), null, 'CaO no debe reaccionar con N2');
    assert.equal(serv.reaccion(idCaO, idCH4, lvl), null, 'CaO es espectador frente a CH4');
    assert.equal(serv.reaccion(idCaCO3, idCO2, lvl), null, 'CO2 extra no debe pegarse a CaCO3');
  }
});

test('el solver exacto MRV+LP-dual coincide al 100 % con el oráculo de fuerza bruta (sin mínimos locales)', () => {
  // Comparar mínimo global G exacto sobre 20 sistemas variados de ≤ 6 átomos y 4 niveles de T.
  const casos: [string, Uint16Array, Uint16Array | null][] = [
    ['H2 + O2', B([[E('H', 'H'), 1]]), B([[E('O', 'O', 2), 1]])],
    ['C + O2', B([[E('C', 'C'), 2]]), B([[E('O', 'O', 2), 1]])],
    ['CH2O sola', B([[E('C', 'C'), 1], [E('H', 'C'), 1], [E('C', 'O'), 1], [E('H', 'O'), 1]]), null],
    ['CH2O + O2', B([[E('C', 'C'), 1], [E('H', 'C'), 1], [E('C', 'O'), 1], [E('H', 'O'), 1]]), B([[E('O', 'O', 2), 1]])],
    ['CH2 + O2', B([[E('C', 'C'), 1], [E('H', 'C'), 2]]), B([[E('O', 'O', 2), 1]])],
    ['CH4 sola', B([[E('H', 'C'), 4]]), null],
    ['N2 + O2', B([[E('N', 'N', 3), 1]]), B([[E('O', 'O', 2), 1]])],
    ['NH3 + O2', B([[E('H', 'N'), 3]]), B([[E('O', 'O', 2), 1]])],
    ['CH2N sola', B([[E('C', 'C'), 1], [E('H', 'C'), 1], [E('C', 'N'), 1], [E('H', 'N'), 2]]), null],
    ['CaCO3 sola', B([[E('O', 'Ca'), 2], [E('C', 'O'), 2], [E('C', 'O', 2), 1]]), null],
    ['CaO + CO2', B([[E('O', 'Ca'), 2]]), B([[E('C', 'O', 2), 2]])],
    ['CaO + H2O', B([[E('O', 'Ca'), 2]]), B([[E('H', 'O'), 2]])],
    ['Ca(OH)2 sola', B([[E('O', 'Ca'), 2], [E('H', 'O'), 2]]), null],
    ['H2SiO3 arcilla', B([[E('O', 'Si'), 4], [E('H', 'O'), 2]]), null],
    ['SiO2 + C', B([[E('O', 'Si'), 4]]), B([[E('C', 'C'), 2]])],
    ['Fe2O3 + C', B([[E('O', 'Fe'), 6]]), B([[E('C', 'C'), 2]])],
    ['Fe2O2 + C', B([[E('O', 'Fe'), 4], [E('Fe', 'Fe'), 1]]), B([[E('C', 'C'), 2]])],
    ['Fe2O + C', B([[E('O', 'Fe'), 2], [E('Fe', 'Fe'), 2]]), B([[E('C', 'C'), 2]])],
    ['C + H2O', B([[E('C', 'C'), 2]]), B([[E('H', 'O'), 2]])],
    ['2 CO2', B([[E('C', 'O', 2), 2]]), B([[E('C', 'O', 2), 2]])],
  ];

  const niveles = [0, 2, 6, 10, 14];
  const ctx = new ContextoSolver();

  for (const [nombre, eA, eB] of casos) {
    const sA = construirSustancia(1, eA);
    const sB = eB ? construirSustancia(2, eB) : null;
    const objetivo = new Uint8Array(NE);
    for (let e = 0; e < NE; e++) objetivo[e] = sA.atomos[e]! + (sB ? sB.atomos[e]! : 0);

    for (const lvl of niveles) {
      const T = tDeNivel(lvl);
      const bruto = minimoFuerzaBruta(objetivo, lvl);
      assert.ok(bruto !== null, `Fuerza bruta nula para ${nombre}`);

      const res = productos(sA, sB, lvl, ctx);
      const gA = sA.energia - (esGasA(sA, T) ? T * S_GAS : 0);
      const gB = sB ? sB.energia - (esGasA(sB, T) ? T * S_GAS : 0) : 0;
      const brutoA = minimoFuerzaBruta(sA.atomos, lvl)!;
      const brutoB = sB ? minimoFuerzaBruta(sB.atomos, lvl)! : null;
      const gRefBruto = sB ? Math.min(gA + gB, brutoA.g + brutoB!.g) : gA;

      if (bruto.g < gRefBruto - 1 - 1e-6) {
        assert.ok(res !== null, `Solver no halló reacción óptima para ${nombre} @L${lvl} (bruto=${bruto.g}, ref=${gRefBruto})`);
        let gRes = 0;
        for (const p of res.productos) {
          const sp = construirSustancia(99, p.enlaces);
          gRes += p.nu * (sp.energia - (esGasA(sp, T) ? T * S_GAS : 0));
        }
        assert.ok(Math.abs(gRes - bruto.g) < 1e-6, `${nombre} @L${lvl}: solver G=${gRes} ≠ bruto G=${bruto.g}`);
      } else if (bruto.g > gRefBruto - 1 + 1e-6) {
        assert.equal(res, null, `Solver devolvió reacción espuria para ${nombre} @L${lvl}`);
      }
    }
  }
});

test('reacciones de control y tabla de cordura completa (E0 / I6) pasan sin violaciones I4', async () => {
  const { cordura, violacionesI4, servicio } = ejecutarTablaCordura();
  try {
    for (const c of cordura) {
      assert.equal(c.cumple, true, `Falló cordura «${c.nombre}»: ${c.detalle}`);
    }
    assert.deepEqual(violacionesI4, [], 'I4 debe tener 0 violaciones en la tabla de cordura');
  } finally {
    await servicio.cerrar();
  }
});

test('servicio químico en worker propio: encola fallos, publica en barrera, es simétrico y reproducible en T=1', async () => {
  const sWorker = crearServicioQuimico({ modo: 'worker' });
  const sDiferido = crearServicioQuimico({ modo: 'diferido' });
  try {
    const ch4 = B([[E('H', 'C'), 4]]);
    const o2 = B([[E('O', 'O', 2), 1]]);
    const n2 = B([[E('N', 'N', 3), 1]]);
    const madera = B([[E('C', 'C'), 1], [E('H', 'C'), 1], [E('C', 'O'), 1], [E('H', 'O'), 1]]);
    const caCO3 = B([[E('O', 'Ca'), 2], [E('C', 'O'), 2], [E('C', 'O', 2), 1]]);

    const cargarBase = (s: typeof sWorker) => ({
      ch4: s.internar(ch4), o2: s.internar(o2), n2: s.internar(n2),
      madera: s.internar(madera), caCO3: s.internar(caCO3),
    });
    const A = cargarBase(sWorker);
    const B2 = cargarBase(sDiferido);

    // Idempotencia de internar y unicidad append-only.
    assert.equal(sWorker.internar(ch4), A.ch4);
    assert.equal(sWorker.totalSustancias(), 5);

    const lvlLlama = nivelDeT(1095);
    const lvlHorno = nivelDeT(1250);

    // Antes de la barrera: los fallos se encolan y devuelven undefined (no bloquean el paso).
    for (const [s, ids] of [[sWorker, A], [sDiferido, B2]] as const) {
      assert.equal(s.reaccion(ids.ch4, ids.o2, lvlLlama), undefined);
      assert.equal(s.reaccion(ids.o2, ids.ch4, lvlLlama), undefined); // mismo par simétrico: no duplica cola
      assert.equal(s.reaccion(ids.madera, 0, nivelDeT(800)), undefined);
      assert.equal(s.reaccion(ids.madera, ids.n2, nivelDeT(800)), undefined); // espectador N2 → null
      assert.equal(s.reaccion(ids.caCO3, 0, lvlHorno), undefined);
      assert.equal(s.pendientes(), 4);
    }

    const pubW = await sWorker.esperarBarrera();
    const pubD = await sDiferido.esperarBarrera();
    assert.equal(pubW, 4);
    assert.equal(pubD, 4);
    assert.equal(sWorker.pendientes(), 0);

    // Tras la barrera: filas visibles, productos ya internados, simetría exacta y espectador descartado.
    const rMet = sWorker.reaccion(A.ch4, A.o2, lvlLlama);
    assert.ok(rMet && rMet.dH === -172);
    assert.equal(sWorker.reaccion(A.o2, A.ch4, lvlLlama), rMet, 'simetría exacta (b,a) === (a,b)');
    for (const sal of rMet.salidas) assert.ok(sWorker.sustancia(sal.id).id === sal.id);

    const rPir = sWorker.reaccion(A.madera, 0, nivelDeT(800));
    assert.ok(rPir && rPir.salidas.length === 2);
    assert.equal(sWorker.reaccion(A.madera, A.n2, nivelDeT(800)), null, 'espectador N2 no reacciona');

    const rCal = sWorker.reaccion(A.caCO3, 0, lvlHorno);
    assert.ok(rCal && rCal.dH === 207 && rCal.salidas.length === 2);

    // Reproducibilidad T=1: los bytes del registro en worker y diferido son idénticos bit a bit.
    assert.deepEqual(serializarSustancias(sWorker), serializarSustancias(sDiferido));
    assert.deepEqual(verificarI4(sWorker, 1), []);
  } finally {
    await sWorker.cerrar();
    await sDiferido.cerrar();
  }
});

test('serialización binaria (MateriaCheckpoint.sustancias) conserva ids y detecta corrupción CRC32', async () => {
  const { servicio } = ejecutarTablaCordura();
  let restaurado: ReturnType<typeof cargarSustancias> | undefined;
  try {
    const bytes = serializarSustancias(servicio);
    assert.ok(bytes.byteLength > 16);
    restaurado = cargarSustancias(bytes, { modo: 'inmediato' });
    assert.equal(restaurado.totalSustancias(), servicio.totalSustancias());
    for (let id = 1; id <= servicio.totalSustancias(); id++) {
      const orig = servicio.sustancia(id);
      const copy = restaurado.sustancia(id);
      assert.deepEqual([...copy.enlaces], [...orig.enlaces]);
      assert.deepEqual([...copy.atomos], [...orig.atomos]);
      assert.equal(copy.clase, orig.clase);
      assert.equal(copy.energia, orig.energia);
      assert.equal(copy.masa, orig.masa);
      assert.deepEqual(copy.prop, orig.prop);
    }
    assert.deepEqual(verificarI4(restaurado, 0), []);

    // Corrupción de un bit → fallo de CRC32; truncado → error.
    const corrompido = new Uint8Array(bytes);
    corrompido[corrompido.length - 5]! ^= 0x01;
    assert.throws(() => cargarSustancias(corrompido, { modo: 'inmediato' }), /CRC32/);
    assert.throws(() => cargarSustancias(bytes.subarray(0, 8), { modo: 'inmediato' }), /truncado/);
  } finally {
    await servicio.cerrar();
    if (restaurado) await restaurado.cerrar();
  }
});

test('invariante I4 registrada en invariantes.ts detecta corrupciones e integra con comprobarInvariantes()', async () => {
  const inv = listaInvariantes().find(i => i.id === 'materia.quimica.i4');
  assert.ok(inv, 'materia.quimica.i4 debe estar registrada con registrar()');
  assert.equal(inv.carril, 'Q');
  assert.equal(inv.gravedad, 'dura');

  const mundo = createWorld(51926);
  // Sin servicio asociado, el mundo base sigue pasando sin violaciones.
  assert.deepEqual(comprobarInvariantes(mundo, { ids: ['materia.quimica.i4'] }), []);

  const serv = crearServicioQuimico({ modo: 'inmediato' });
  const quitar = asociarServicioQuimico(mundo, serv);
  try {
    const idC = serv.internar(B([[E('C', 'C'), 2]]));
    const idO2 = serv.internar(B([[E('O', 'O', 2), 1]]));
    serv.reaccion(idC, idO2, nivelDeT(1095));
    assert.deepEqual(comprobarInvariantes(mundo, { ids: ['materia.quimica.i4'] }), []);

    // Inyectar un servicio sintético corrupto (reacción que viola conservación de átomos y energía).
    const sustC = serv.sustancia(idC);
    const sustO2 = serv.sustancia(idO2);
    const sustCorrupta: Readonly<Sustancia> = { ...sustC, energia: sustC.energia + 17 };
    const reacCorrupta: Reaccion = {
      a: idC, b: idO2, nivelT: nivelDeT(1095),
      entradas: [{ id: idC, nu: 1 }, { id: idO2, nu: 1 }],
      salidas: [{ id: idC, nu: 1 }], // pierde O2
      dH: 999, ea: 100, catalisis: 2,
    };
    const falso: ServicioQuimicoAuditable = {
      modo: 'inmediato',
      internar: () => idC,
      sustancia: id => (id === idC ? sustCorrupta : sustO2),
      reaccion: () => reacCorrupta,
      totalSustancias: () => 2,
      totalMemo: () => 1,
      pendientes: () => 0,
      filasMemo: (): readonly FilaMemoQuimico[] => [{ a: idC, b: idO2, nivelT: nivelDeT(1095), reaccion: reacCorrupta }],
      publicarBarrera: () => 0,
      esperarBarrera: async () => 0,
      cerrar: async () => {},
    };
    const quitarFalso = asociarServicioQuimico(mundo, falso);
    try {
      const viols = comprobarInvariantes(mundo, { ids: ['materia.quimica.i4'] });
      assert.ok(viols.some(v => v.detalle.includes('Energía de sustancia')), 'debe detectar energía adulterada');
      assert.ok(viols.some(v => v.detalle.includes('no conserva átomos')), 'debe detectar pérdida de átomos');
      assert.ok(viols.every(v => v.gravedad === 'dura' && v.id === 'materia.quimica.i4'));
    } finally {
      quitarFalso();
    }
  } finally {
    quitar();
    await serv.cerrar();
  }
});

test('cinética de digestión (310 K, KAPPA0) y suelo (295 K, KAPPA_SUELO) coherente con la refirma', () => {
  const dCN = TIPOS[E('C', 'N')]!.d, dCO = TIPOS[E('C', 'O')]!.d;
  const dCC = TIPOS[E('C', 'C')]!.d, dCH = TIPOS[E('H', 'C')]!.d;
  assert.ok(dCN < dCO && dCO < dCC && dCC < dCH, 'orden catalítico preservado');

  const madera = construirSustancia(1, B([[E('C', 'C'), 1], [E('H', 'C'), 1], [E('C', 'O'), 1], [E('H', 'O'), 1]]));
  const o2 = construirSustancia(2, B([[E('O', 'O', 2), 1]]));
  const prot = construirSustancia(3, B([[E('C', 'C'), 1], [E('H', 'C'), 1], [E('C', 'N'), 1], [E('H', 'N'), 2]]));

  const rMad = productos(madera, null, nivelDeT(310))!;
  const rProt = productos(prot, null, nivelDeT(310))!;
  const rComb = productos(madera, o2, nivelDeT(310))!;
  assert.equal(rMad.catalisis, 0, 'madera (CH2O) cae en familia herbívora C–O (0)');
  assert.equal(rProt.catalisis, 1, 'proteína (CH2N) cae en familia carnívora C–N (1)');
  assert.ok(tasaArrhenius(310, rMad.ea, rMad.catalisis, KAPPA0) < 1e-4, 'con KAPPA0=60, CH2O no carboniza rápido en estómago');
  assert.ok(tasaArrhenius(295, rComb.ea, rComb.catalisis, KAPPA_SUELO) > 1e-4, 'con KAPPA_SUELO=105, el suelo mineraliza con O2');
  assert.ok(tasaArrhenius(295, rProt.ea, rProt.catalisis, KAPPA_SUELO) > 1, 'el suelo libera NH3 de proteínas');
});

test('banco de rendimiento de productos() cumple p99 < 50 ms hasta 16 átomos en frío y en caliente', () => {
  const banco = ejecutarBancoRendimiento();
  assert.equal(banco.maxAtomos, 16, 'el banco debe alcanzar 16 átomos');
  assert.ok(banco.muestras >= 100, `muestras insuficientes: ${banco.muestras}`);
  assert.ok(banco.frioMs.p99 < 50, `p99 frío=${banco.frioMs.p99.toFixed(2)} ms supera 50 ms`);
  assert.ok(banco.calienteMs.p99 < 1, `p99 caliente=${banco.calienteMs.p99.toFixed(3)} ms supera 1 ms`);
});

test('cinética: ninguna barrera es menor que dH ni nula al partir una especie; la asociación pura no tiene barrera', async () => {
  const serv = crearServicioQuimico({ modo: 'inmediato' });
  try {
    const S = registrarSustanciasBase(serv);
    const r = (a: number, b: number, l: number) => serv.reaccion(a, b, l) ?? null;
    const dCC = TIPOS[E('C', 'C')]!.d;

    // 2 CH₂ → CH₄ + C conserva el vector de enlaces: hay que cortar al menos un C–C para partir la grasa.
    const rGrasa = r(S.CH2, S.CH2, nivelDeT(259));
    assert.ok(rGrasa && rGrasa.dH === 0);
    assert.ok(Math.abs(rGrasa.ea - GAMMA * dCC) < 1e-9, `2 CH₂ → CH₄ + C con ea=${rGrasa.ea}`);
    assert.ok(tasaArrhenius(259, rGrasa.ea, rGrasa.catalisis, 0) < 1e-12, 'la grasa no se desproporciona en frío');
    // Arcilla + cal: sin cocer, no hay cerámica a 295 K.
    const rArcCal = r(S.arcilla, S.CaO, nivelDeT(295));
    assert.ok(rArcCal && tasaArrhenius(295, rArcCal.ea, rArcCal.catalisis, 0) < 1e-12, `arcilla + CaO con ea=${rArcCal?.ea}`);
    // 2 H₃PO₄ → 3 H₂O + P₂O₅ se parte: tiene barrera.
    const rFosf = r(S.H3PO4, S.H3PO4, nivelDeT(436));
    assert.ok(rFosf && rFosf.ea > 100, `2 H₃PO₄ con ea=${rFosf?.ea}`);
    // CaO + H₂O → Ca(OH)₂ es una asociación (un solo producto, mismo vector): el apagado sigue siendo inmediato.
    const rApagado = r(S.CaO, S.H2O, nivelDeT(295));
    assert.ok(rApagado && rApagado.salidas.length === 1 && rApagado.ea === 0);
    // Su vuelta, Ca(OH)₂ → CaO + H₂O, es endotérmica: su barrera no puede ser menor que dH.
    const rDesh = r(S.CaOH2, 0, nivelDeT(1037));
    assert.ok(rDesh && rDesh.dH > 0 && rDesh.ea >= rDesh.dH, `Ca(OH)₂ → CaO + H₂O con ea=${rDesh?.ea}, dH=${rDesh?.dH}`);
    const rCal = r(S.CaCO3, 0, nivelDeT(1250));
    assert.ok(rCal && rCal.ea >= rCal.dH);

    // En el cierre de la base, en los 16 niveles, ninguna reacción publicada tiene ea < max(0, dH).
    const n = serv.totalSustancias();
    for (let a = 1; a <= n; a++) for (let b = 0; b <= a; b++) for (let l = 0; l < NIVELES_T; l++) {
      const x = r(a, b, l);
      if (x) assert.ok(x.ea >= 0 && x.ea >= x.dH, `(${a}, ${b}) @L${l}: ea=${x.ea} < dH=${x.dH}`);
    }
    assert.deepEqual(verificarI4(serv), []);
  } finally {
    await serv.cerrar();
  }

  // Un triple que pasa a simple sin perder enlaces del par solo corta sus dos componentes π.
  const n2 = B([[E('N', 'N', 3), 1]]), nn = B([[E('N', 'N'), 1], [E('H', 'N'), 4]]), h2 = B([[E('H', 'H'), 1]]);
  const { ea } = calcularCinetica([{ enlaces: n2, nu: 1 }, { enlaces: h2, nu: 2 }], [{ enlaces: nn, nu: 1 }], 0);
  const d = (k: 1 | 2 | 3) => TIPOS[E('N', 'N', k)]!.d;
  assert.equal(ea, GAMMA * Math.max(d(3) - d(1), TIPOS[E('H', 'H')]!.d));
});

test('productos(): con ΔG = −ε exacto decide la aritmética entera, no el redondeo', () => {
  // ΔE = −1 y los mismos gases que la mejor referencia (caso de la auditoría): debe ser null.
  const a = construirSustancia(1, B([[E('H', 'C'), 1], [E('H', 'P'), 1], [E('C', 'C'), 2], [E('C', 'N'), 1], [E('C', 'P'), 2], [E('N', 'N'), 1], [E('P', 'P'), 1]]));
  const b = construirSustancia(2, B([[E('H', 'N'), 1], [E('H', 'O'), 1], [E('C', 'N', 2), 2], [E('N', 'O'), 1]]));
  assert.equal(productos(a, b, 4, new ContextoSolver()), null);
  assert.equal(productos(b, a, 4, new ContextoSolver()), null);
});

test('los tres modos del servicio publican las mismas reacciones; worker y diferido, los mismos ids', async () => {
  const modos = (['inmediato', 'diferido', 'worker'] as const).map(modo => crearServicioQuimico({ modo }));
  try {
    const consultas: [string, string, number][] = [
      ['CH4', 'O2', 9], ['madera', '', 8], ['madera', 'N2', 8], ['CaCO3', '', 10], ['CaOH2', 'CO2', 2],
      ['Fe2O3', 'C', 10], ['proteina', '', 2], ['arcilla', 'CaO', 2], ['CH2', 'CH2', 1], ['H2', 'O2', 0],
    ];
    const vistas: string[][] = [];
    for (const s of modos) {
      const S = registrarSustanciasBase(s) as Record<string, number>;
      for (const [x, y, l] of consultas) s.reaccion(S[x]!, y ? S[y]! : 0, l);
      await s.esperarBarrera();
      assert.equal(s.pendientes(), 0);
      vistas.push(consultas.map(([x, y, l]) => {
        const r = s.reaccion(S[x]!, y ? S[y]! : 0, l);
        assert.notEqual(r, undefined, 'tras la barrera no queda nada encolado');
        if (!r) return 'null';
        const lado = (xs: Reaccion['salidas']) => xs.map(p => `${p.nu}·${[...s.sustancia(p.id).enlaces]}`).join('+');
        return `${lado(r.entradas)}→${lado(r.salidas)} dH=${r.dH} ea=${r.ea} cat=${r.catalisis}`;
      }));
    }
    assert.deepEqual(vistas[1], vistas[0]);
    assert.deepEqual(vistas[2], vistas[0]);
    assert.deepEqual(serializarSustancias(modos[2]!), serializarSustancias(modos[1]!));
  } finally {
    for (const s of modos) await s.cerrar();
  }
});

test('si el worker muere, el servicio falla en vez de colgarse o perder peticiones', async () => {
  const s = crearServicioQuimico({ modo: 'worker' });
  try {
    const S = registrarSustanciasBase(s);
    assert.equal(s.reaccion(S.CH4, S.O2, 9), undefined);
    await (s as unknown as { worker: Worker }).worker.terminate();
    await assert.rejects(s.esperarBarrera(), /worker de química/);
    assert.throws(() => s.reaccion(S.madera, 0, 8), /worker de química/);
  } finally {
    await s.cerrar();
  }
});

test('códec de sustancias: cualquier bit cambiado falla y otra química no se carga en silencio', async () => {
  const { servicio } = ejecutarTablaCordura();
  try {
    const bytes = serializarSustancias(servicio);
    for (let bit = 0; bit < bytes.length * 8; bit++) {
      const malo = new Uint8Array(bytes);
      malo[bit >> 3]! ^= 1 << (bit & 7);
      assert.throws(() => cargarSustancias(malo, { modo: 'inmediato' }), Error, `bit ${bit} sin detectar`);
    }
    // Misma clave y CRC correcto, pero otra energía guardada: es otra química (otra TABLA o constantes de red).
    const otra = new Uint8Array(bytes);
    const vista = new DataView(otra.buffer);
    const finPrimera = 12 + 1 + otra[12]! * 2 + 1;
    vista.setInt32(finPrimera, vista.getInt32(finPrimera, true) + 1, true);
    vista.setUint32(otra.length - 4, crc32(otra.subarray(0, otra.length - 4)), true);
    assert.throws(() => cargarSustancias(otra, { modo: 'inmediato' }), /Química incompatible/);
  } finally {
    await servicio.cerrar();
  }
});

test('I4 registrada: coste acotado por llamada y un servicio de producción sin asociar no queda sin comprobar', async () => {
  const mundo = createWorld(51926);
  const huerfano = crearServicioQuimico({ modo: 'diferido' });
  try {
    const viols = comprobarInvariantes(mundo, { ids: ['materia.quimica.i4'] });
    assert.ok(viols.some(v => v.detalle.includes('sin asociar')), 'un servicio vivo sin mundo debe denunciarse');
    const quitar = asociarServicioQuimico(mundo, huerfano);
    registrarSustanciasBase(huerfano);
    assert.deepEqual(comprobarInvariantes(mundo, { ids: ['materia.quimica.i4'] }), []);
    assert.deepEqual(verificarI4Acotado(huerfano, 1), [], 'la rueda vuelve sobre lo ya revisado sin falsos positivos');
    quitar();
    assert.ok(comprobarInvariantes(mundo, { ids: ['materia.quimica.i4'] }).some(v => v.detalle.includes('sin asociar')));
  } finally {
    await huerfano.cerrar();
  }
  assert.deepEqual(comprobarInvariantes(mundo, { ids: ['materia.quimica.i4'] }), [], 'cerrado, ya no hay nada que comprobar');
});

function crc32(datos: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of datos) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
