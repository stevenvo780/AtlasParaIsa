import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serialize } from 'node:v8';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import type { StructureView } from '../src/shared/life.js';
import { codigoForma } from '../src/shared/materia.js';
import type { WorldView } from '../src/shared/types.js';
import { blueprintCap, completeConstruction, MAX_BLUEPRINTS, MAX_STRUCTURES, structureCap } from '../src/world/inventions.js';
import { colocarPieza, depositarEnObra, estadoObra, leyObra, loteDepositoObra, piezasDe, prestacionesDePiezas, servicioDe } from '../src/world/materia/piezas.js';
import { Rol, type VistaLote } from '../src/world/materia/tipos.js';
import { ctxMateriaDe, type CtxF0, type CtxLeyMateria } from '../src/world/motor/acceso.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { chunkKey } from '../src/world/terrain.js';
import { tileAt } from '../src/world/spatial.js';
import { assertStructures } from '../src/world/validation.js';
import { assertWorld, createWorld, type World } from '../src/world/index.js';
import { DEFAULT_PARAMS, parseParams, setParams } from '../src/world/params.js';
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
    const original = { ...s, water: 0, food: 0 } as unknown as StructureView;
    const reflejo = { structures: [original] } as WorldView;
    leyObra.proyectar?.mundo?.(c, reflejo);
    assert.equal(reflejo.structures![0]!.water, almacenado);
    assert.equal(original.water, 0);
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

test('el primer plano material, con el id cero del registro, se puede guardar', () => {
  const mundo = createWorld(7, parseParams({ v23: { materia: true, natalidad: true, cuerpos: true, tecnica: true, obra: true } }));
  const base = mundo.blueprints[0]!;
  const plano = { ...base, id: 'blueprint-obra-0', generation: 1, parents: [base.id], inventorId: mundo.people[0]!.id,
    components: Array.from({ length: 25 }, (): string => 'arco') as StructureView['components'],
    cost: { wood: 0, stone: 0, work: 0 }, planoMaterial: { area: 2, compacto: true, forma } };
  mundo.blueprints.push(plano);
  assert.doesNotThrow(() => assertWorld(mundo));
  plano.id = 'blueprint-obra-1';
  assert.throws(() => assertWorld(mundo));
});

test('la obra terminada deja un lugar durable antes del F0 que lo replica', async t => {
  const mundo = createWorld(7, parseParams({ v23: escalon('obra') }));
  const motor = crearMotor(mundo, { hilos: 1, gpu: [], decisionGpu: 'siempre', verificar: false, semilla: 7 });
  t.after(() => motor.cerrar());
  motor.paso([]);
  const c = ctxMateriaDe(mundo), p = mundo.people.find(p => {
    const tile = tileAt(mundo, p);
    return tile && tile.terrain !== 'water' && tile.terrain !== 'shelter';
  })!;
  const tile = tileAt(mundo, p)!;
  const celda = c.terreno.celda(p.x, p.y);
  const lote = c.materia.nuevo(Rol.Objeto, celda, forma);
  c.materia.fuente(lote, Float64Array.of(sustanciasDe(c).SiO2, 100_000, 0, 1000), c.libro);
  p.carga!.push(lote);
  const obra = completeConstruction(mundo, p, tile, e => ({ ...e, id: 'obra-prueba', tick: mundo.tick }));
  assert.ok(obra && estadoObra(obra)?.terminada);
  assert.deepEqual(obra.components, []);
  const lugar = mundo.places.find(l => l.x === obra.x && l.y === obra.y && l.id.startsWith('settlement-'));
  assert.ok(lugar);
  assert.ok(mundo.chunks[chunkKey(obra.x, obra.y)]!.places.includes(lugar));

  const otrasObras = mundo.structures.slice();
  assert.doesNotThrow(() => assertStructures(otrasObras, mundo.tick, mundo.tiles, 1, true));
  assert.throws(() => assertStructures(otrasObras, mundo.tick, mundo.tiles, 1));
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.guardar(motor.instantanea());
  const carga = store.cargarInstantanea()!;
  assert.deepEqual(carga.instantanea.world.places.find(l => l.id === lugar.id), lugar);
  assert.deepEqual(carga.instantanea.world.structures.find(s => s.id === obra.id), obra);
});

test('F0 consume y replica las peticiones de lugar una vez', () => {
  const mundo = createWorld(7);
  const lugar = { id: 'settlement-320-40', name: 'Taller', x: 320, y: 40, description: '', gatherings: 0 };
  const datos = [serialize(lugar), serialize(lugar)];
  const c = {
    mundo,
    peticiones: (tipo: string) => { assert.equal(tipo, 'lugar'); return datos.splice(0); },
    publicarLugares: (lugares: World['places']) => { mundo.places = lugares; },
  } as unknown as CtxF0;
  leyObra.F0!(c);
  leyObra.F0!(c);
  assert.equal(datos.length, 0);
  assert.deepEqual(mundo.places.filter(l => l.id === lugar.id), [lugar]);
});
