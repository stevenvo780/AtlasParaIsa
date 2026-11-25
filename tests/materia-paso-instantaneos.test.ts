/**
 * Fase instantánea del integrador de P (`instantaneos` en paso.ts) sobre mezclas al azar con la química real: conservación
 * exacta, independencia del orden de las ranuras, reparto de un reactivo compartido y paso a paso muy pequeño.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { KAPPA0, KAPPA_SUELO, KAPPA_SUELO_HH } from '../src/shared/naturaleza.js';
import { cuentaIntegrador, pasoLote, type CtxPaso, type Kappa } from '../src/world/materia/paso.js';
import type { ArenaMateria, LoteRef } from '../src/world/materia/tipos.js';
import { azarSembrado, materiaReal, type Base, type Contenido, type MateriaReal } from './lib/materia-real.js';

const SUELO: Kappa = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH];
const KAPPAS: Kappa[] = [SUELO, [80, 0, 0, 0], [KAPPA0, KAPPA0, KAPPA0, KAPPA0], [130, 130, 0, KAPPA_SUELO_HH]];
const CANDIDATAS: (keyof Base)[] = ['madera', 'proteina', 'orgP', 'glicosido', 'O2', 'H2O', 'CaCO3', 'C', 'N2', 'NH3', 'urea', 'acetico', 'metanol', 'H3PO4', 'formamida', 'H2'];
const CANTIDADES = [1, 2, 3, 7, 40, 1e3, 1e4, 2e5, 1e6];
const PASOS = [1e-4, 1e-2, 0.5, 1, 10, 100];

/** La arena con un contador de recortes de `aplicar`: pasoLote debe pedir siempre lo que hay. */
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

function mezclaAlAzar(azar: () => number): Contenido {
  const c: Contenido = {};
  const cuantas = 2 + Math.floor(azar() * 6);
  for (let i = 0; i < cuantas; i++) c[CANDIDATAS[Math.floor(azar() * CANDIDATAS.length)]!] = CANTIDADES[Math.floor(azar() * CANTIDADES.length)]!;
  // Con frecuencia un limitante escaso frente a un compañero abundante: lo que mueve el reparto de un reactivo compartido.
  if (azar() < 0.5) { c.O2 = CANTIDADES[Math.floor(azar() * 3)]!; c.madera ??= 1e4; c.orgP ??= 1e3; c.proteina ??= 5e3; }
  return c;
}

const estado = (m: MateriaReal, l: LoteRef) => [...Object.values(m.S).map(id => m.arena.cuantos(l, id)), m.arena.calor(l)];

test('conservación: mezclas al azar con reactivos instantáneos compartidos dejan átomos y energía exactos y nada negativo', async () => {
  const m = materiaReal({ capacidad: 2048 });
  const azar = azarSembrado(20261125);
  const { arena, recortes } = conRecortes(m.arena);
  const antes = { ...cuentaIntegrador };
  let casos = 0;
  try {
    for (let i = 0; i < 600; i++) {
      const c = mezclaAlAzar(azar), T = [295, 310, 450, 600, 900][Math.floor(azar() * 5)]!, kappa = KAPPAS[Math.floor(azar() * KAPPAS.length)]!;
      const dt = PASOS[Math.floor(azar() * PASOS.length)]!;
      const l = m.lote(c, T);
      const ctx: CtxPaso = { ...m.ctx(1000 + i), arena };
      for (let t = 0; t < 3; t++) pasoLote(ctx, l, dt, kappa);
      for (const id of Object.values(m.S)) assert.ok(m.arena.cuantos(l, id) >= 0, `negativo en la mezcla ${i}`);
      assert.ok(m.arena.calor(l) >= 0);
      casos++;
    }
    assert.deepEqual(m.arena.saldo(), m.esperado());
    assert.equal(recortes(), 0, 'pasoLote nunca pide más de lo que hay');
    assert.ok(cuentaIntegrador.instantaneas - antes.instantaneas > 100, `la fase instantánea actuó en ${cuentaIntegrador.instantaneas - antes.instantaneas} de ${casos}`);
  } finally { await m.cerrar(); }
});

test('orden: la misma mezcla con las sustancias en otro orden de ranuras da exactamente lo mismo', async () => {
  const m = materiaReal({ capacidad: 2048 });
  const azar = azarSembrado(77);
  try {
    for (let i = 0; i < 150; i++) {
      const c = mezclaAlAzar(azar), T = [295, 310, 600][Math.floor(azar() * 3)]!, kappa = KAPPAS[Math.floor(azar() * KAPPAS.length)]!;
      const dt = PASOS[Math.floor(azar() * PASOS.length)]!;
      const pares = Object.entries(c);
      const invertida = Object.fromEntries([...pares].reverse()) as Contenido;
      const barajada = Object.fromEntries(pares.map(p => [azar(), p] as const).sort((a, b) => a[0] - b[0]).map(([, p]) => p)) as Contenido;
      const [a, b, d] = [c, invertida, barajada].map(x => {
        const l = m.lote(x, T);
        for (let t = 0; t < 2; t++) pasoLote(m.ctx(500 + i), l, dt, kappa);
        return estado(m, l);
      });
      assert.deepEqual(b, a, `mezcla ${i}: orden invertido`);
      assert.deepEqual(d, a, `mezcla ${i}: orden barajado`);
    }
  } finally { await m.cerrar(); }
});
