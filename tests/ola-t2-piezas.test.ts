import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StructureView } from '../src/shared/life.js';
import { codigoForma } from '../src/shared/materia.js';
import type { WorldView } from '../src/shared/types.js';
import { blueprintCap, MAX_BLUEPRINTS, MAX_STRUCTURES, structureCap } from '../src/world/inventions.js';
import { colocarPieza, depositarEnObra, leyObra, loteDepositoObra, piezasDe, prestacionesDePiezas, servicioDe } from '../src/world/materia/piezas.js';
import { Rol, type VistaLote } from '../src/world/materia/tipos.js';
import type { CtxLeyMateria } from '../src/world/motor/acceso.js';
import type { World } from '../src/world/mundo/tipos.js';
import { DEFAULT_PARAMS, setParams } from '../src/world/params.js';
import { materiaReal } from './lib/materia-real.js';

const forma = codigoForma({ largo: 1, ancho: 1, grueso: 0.2, hueco: 0.4, filo: 0 });
const pieza: VistaLote = { masa: 8, forma, fase: 0, T: 400, dureza: 0.7, tenacidad: 0.5, sellado: 0.6,
  aislamiento: 0.2, energia: 0, digerible: 0, agua: 0, principal: 1, color: 0 };

test('la misma materia puede proteger, guardar y calentar según forma y temperatura', () => {
  const bien = prestacionesDePiezas([pieza], 1);
  assert.ok(bien.cobijo > 0 && bien.volumen > 0 && bien.calor > 0);
  const plancha = prestacionesDePiezas([{ ...pieza, forma: codigoForma({ largo: 1, ancho: 1, grueso: 0.2, hueco: 0, filo: 0 }), T: 290 }], 1);
  assert.ok(plancha.cobijo > 0);
  assert.equal(plancha.calor, 0);
  assert.equal(plancha.volumen, 0);
  for (const fallo of [{ ...pieza, masa: 1 }, { ...pieza, forma: 0 }, { ...pieza, fase: 1 as const }]) {
    const servicio = prestacionesDePiezas([fallo], 1);
    assert.equal(servicio.cobijo, 0);
    assert.equal(servicio.volumen, 0);
    assert.equal(servicio.calor, 0);
  }
});

test('colocar cambia rol, conserva átomos y calor, y publica la pieza desde la arena', async () => {
  const material = materiaReal({ chunks: 2, hilos: 2 }), { arena, S, libro, quimica } = material;
  try {
    const s = { id: 'structure-1', x: 0, y: 0, obraMaterial: { piezas: [], agua: -1, comida: -1, pendiente: null, terminada: false } };
    const c = {
      mundo: { structures: [s] }, materia: arena, quimica, hilo: 0, tick: 1, libro,
      terreno: { celda: (x: number) => x >= 0 ? x * 256 : -1, chunkDe: (l: number) => l / 256, duenoChunk: material.memoria.duenoChunk },
      propio: { marcar() {} },
    } as unknown as CtxLeyMateria;
    const l = arena.nuevo(Rol.Objeto, 0, forma);
    arena.fuente(l, Float64Array.of(S.SiO2, 500_000, 0, 2_000_000), libro);
    const antes = arena.vista(l);
    assert.throws(() => colocarPieza(c, s.id, l, 256));
    assert.equal(arena.vivo(l), true);
    colocarPieza(c, s.id, l, 0);
    assert.equal(arena.vivo(l), false);
    const [ref] = piezasDe(c, s.id, []);
    assert.equal(arena.calor(ref!), 2_000_000);
    assert.deepEqual(arena.vista(ref!), antes);
    assert.equal(servicioDe(c, s.id).masa, antes.masa);
    assert.deepEqual(leyObra.comprobar?.(c), []);
    assert.deepEqual(arena.saldo(), material.esperado());
    const vista = { structures: [{ id: s.id }] } as WorldView;
    leyObra.proyectar?.mundo?.(c, vista);
    const [visible] = (vista.structures![0] as StructureView).piezas!;
    assert.deepEqual(visible, { x: 0, y: 0, rol: 'pieza', forma, principal: S.SiO2, masa: antes.masa, T: antes.T });
    const agua = material.lote({ H2O: 100_000 }, 285);
    const almacenado = depositarEnObra(c, s as unknown as StructureView, 'agua', agua, 1);
    assert.ok(almacenado > 0.999 && almacenado <= 1);
    const deposito = loteDepositoObra(c, s as unknown as StructureView, 'agua');
    assert.ok(deposito >= 0);
    assert.equal(arena.cuantos(agua, S.H2O) + arena.cuantos(deposito, S.H2O), 100_000);
    assert.deepEqual(arena.saldo(), material.esperado());
    assert.deepEqual(leyObra.comprobar?.(c), []);
    s.obraMaterial.comida = ref!;
    assert.ok(leyObra.comprobar?.(c)?.some(v => v.id === 't2-obra'));
  } finally { await material.cerrar(); }
});

test('los topes por cantidad solo pertenecen al camino escalar', () => {
  const mundo = {} as World;
  assert.equal(structureCap(mundo), MAX_STRUCTURES);
  assert.equal(blueprintCap(mundo), MAX_BLUEPRINTS);
  setParams(mundo, { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, materia: true, cuerpos: true, tecnica: true, obra: true } });
  assert.equal(structureCap(mundo), Infinity);
  assert.equal(blueprintCap(mundo), Infinity);
});
