import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { serialize } from 'node:v8';
import { createWorld, type World } from '../src/world/index.js';
import { comprobarInvariantes, comprobarLeyes, crearObservadorNacimientos, listaInvariantes } from '../src/world/invariantes.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { escalon } from '../src/shared/interruptores.js';
import type { Ley } from '../src/world/motor/acceso.js';
import { enlazarCtx } from '../src/world/motor/acceso.js';
import { cargarPunto, argumentosCorrida, confianzaMutuaMinima, paramsDeCorrida } from '../scripts/lab/poblacion.mjs';
import { argumentosEncender, paramsDeEncender } from '../scripts/lab/encender.mjs';
import { juzgarCinta, juzgarRecuperacion, leerSalud, planDeCaidas, FASES, argumentosCaidas } from '../scripts/lab/caidas.mjs';

const conInterruptores = (m: World, hasta: Parameters<typeof escalon>[0]): World => {
  setParams(m, parseParams({ v23: escalon(hasta) }, paramsOf(m)));
  return m;
};
const ids = ['motor-conservacion', 'motor-garantias', 'motor-nacimientos', 'motor-referencias', 'vistas.materia'];

test('los invariantes V23 están registrados con su carril y callan con los interruptores apagados', () => {
  const lista = new Map(listaInvariantes().map(i => [i.id, i]));
  for (const id of ids) assert.ok(lista.has(id), id);
  assert.equal(lista.get('motor-conservacion')!.carril, 'I-C');
  assert.equal(lista.get('motor-garantias')!.carril, 'I-B');
  assert.equal(lista.get('motor-nacimientos')!.carril, 'I-N');
  assert.equal(lista.get('motor-referencias')!.carril, 'I-R');
  const m = createWorld(51926);
  assert.deepEqual(comprobarInvariantes(m, { ids }), []);
});

test('I-N detecta un uid repetido y uno nulo', () => {
  const m = createWorld(51926);
  m.people[0]!.uid = 7; m.people[1]!.uid = 7;
  const v = comprobarInvariantes(m, { ids: ['motor-nacimientos'] });
  assert.ok(v.some(x => /repetido/.test(x.detalle)));
  m.people[1]!.uid = 0;
  assert.ok(comprobarInvariantes(m, { ids: ['motor-nacimientos'] }).some(x => /inválido/.test(x.detalle)));
});

test('I-R detecta un cuerpo con la ley apagada', () => {
  const m = createWorld(51926);
  m.people[0]!.cuerpo = { tejido: 1, reserva: 2, digestivo: 3, plantilla: 0 };
  assert.ok(comprobarInvariantes(m, { ids: ['motor-referencias'] }).some(x => /apagada/.test(x.detalle)));
});

test('las vistas de materia: fracciones fuera de [0, 1], sumas excesivas y temperaturas inválidas', () => {
  const m = conInterruptores(createWorld(51926), 'materia');
  const t = m.tiles[0]!;
  t.mat = [[1, 0.6], [2, 0.3]]; t.T = 290;
  assert.deepEqual(comprobarInvariantes(m, { ids: ['vistas.materia'] }), []);
  t.mat = [[1, 0.6], [2, 0.6]];
  assert.ok(comprobarInvariantes(m, { ids: ['vistas.materia'] }).some(x => /suman más de 1/.test(x.detalle)));
  t.mat = [[1, 0.2], [2, 0.5]];
  assert.ok(comprobarInvariantes(m, { ids: ['vistas.materia'] }).some(x => /no ordenadas/.test(x.detalle)));
  t.mat = [[1, 1.5]]; t.T = -3;
  const detalles = comprobarInvariantes(m, { ids: ['vistas.materia'] }).map(x => x.detalle).join('|');
  assert.match(detalles, /fuera de \[0, 1\]/); assert.match(detalles, /Temperatura/);
});

test('I-N con historia: un nacido exige la gestación previa de uno de sus padres', () => {
  const m = conInterruptores(createWorld(51926), 'cuerpos');
  const observar = crearObservadorNacimientos();
  const madre = m.people[0]!;
  madre.cuerpo = { tejido: 1, reserva: 2, digestivo: 3, plantilla: 0, gestacion: { embrion: 4, otro: 9, genoma: [], inicio: 0, bajoBasalDesde: -1 } };
  assert.deepEqual(observar(m), []);
  m.tick++;
  const cria = structuredClone(m.people[1]!);
  cria.id = 'cria-prueba'; cria.genome.generation = 1; cria.genome.parents = [madre.id, 'otro-padre'];
  m.people.push(cria);
  assert.deepEqual(observar(m), []);
  // Sin gestación previa de ninguno de los dos padres, el nacimiento es una violación.
  madre.cuerpo = undefined;
  m.tick++; assert.deepEqual(observar(m), []);
  m.tick++;
  const huerfana = structuredClone(cria); huerfana.id = 'cria-sin-gestacion'; m.people.push(huerfana);
  const v = observar(m);
  assert.equal(v.length, 1); assert.equal(v[0]!.id, 'motor-nacimientos');
});

test('comprobarLeyes no corre sin contexto de dueño, y recoge violaciones y excepciones de las leyes encendidas', () => {
  const m = conInterruptores(createWorld(51926), 'cohesion');
  const mala: Ley = { id: 'x', interruptor: 'cohesion', comprobar: () => [{ id: 'x.rota', gravedad: 'dura', tick: 0, detalle: 'rota' }] };
  const lanza: Ley = { id: 'y', interruptor: 'cohesion', comprobar: () => { throw new Error('boom'); } };
  const apagada: Ley = { id: 'z', interruptor: 'materia', comprobar: () => [{ id: 'z.rota', gravedad: 'dura', tick: 0, detalle: 'no debe salir' }] };
  assert.deepEqual(comprobarLeyes(m, [mala, lanza, apagada]), []);
  enlazarCtx(m, { tick: m.tick, mundo: m } as never);
  const v = comprobarLeyes(m, [mala, lanza, apagada]);
  assert.deepEqual(v.map(x => x.id), ['x.rota', 'ley.y.excepcion']);
  assert.equal((v[0]!.contexto as { ley: string }).ley, 'x');
});

test('encender: argumentos y escalón de interruptores en un mundo de un hilo', () => {
  const o = argumentosEncender(['--semilla', '7', '--hasta', 'cuerpos', '--dias', '2', '--cada', '10', '--continuar']);
  assert.equal(o.semilla, 7); assert.equal(o.hasta, 'cuerpos'); assert.equal(o.cada, 10); assert.ok(o.continuar);
  assert.throws(() => argumentosEncender(['--hasta', 'inventado']));
  const p = paramsDeEncender({ regimen: 'defecto', hasta: 'cuerpos' });
  assert.ok(p.v23.materia && p.v23.cuerpos && p.v23.natalidad && !p.v23.fauna && !p.v23.duenos);
  assert.equal(p.motor.hilos, 1); assert.deepEqual(p.motor.gpu, []);
  assert.deepEqual(paramsDeEncender({ regimen: 'defecto' }).v23, DEFAULT_PARAMS.v23);
});

test('poblacion: --hasta, la regla de pareja detrás de su función y el punto del panel', () => {
  const o = argumentosCorrida(['--semilla', '1', '--n', '10', '--salida', '/tmp/x.json', '--hasta', 'natalidad']);
  assert.equal(o.hasta, 'natalidad');
  assert.equal(paramsDeCorrida({ regimen: 'defecto', hilos: 1, gpu: [], hasta: 'natalidad' }).v23.natalidad, true);
  assert.equal(confianzaMutuaMinima(), 0.3);
  const dir = mkdtempSync(join(tmpdir(), 'ola-lab-'));
  try {
    const m = createWorld(1), ruta = join(dir, '1-1.punto');
    writeFileSync(ruta, serialize({ formato: 1, mundo: m, params: paramsOf(m), archivo: new Map([['0,0', Buffer.from('a')]]) }));
    const punto = cargarPunto(ruta);
    assert.equal(punto.mundo.people.length, m.people.length); assert.equal(punto.archivo.get('0,0')!.toString(), 'a');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('caídas: plan al azar reproducible con todas las fases, /health normalizado y veredictos', () => {
  const plan = planDeCaidas(20, 51926);
  assert.equal(plan.length, 20); assert.deepEqual(planDeCaidas(20, 51926), plan);
  for (const f of FASES) assert.ok(plan.includes(f), f);
  assert.equal(argumentosCaidas(['--worktree', '/tmp/x']).caidas, 20);
  assert.deepEqual(leerSalud({ tick: 5, epoca: 3, ultimoTickGuardado: 4, ultimoGuardado: 99 }), { tick: 5, epoca: 3, ultimoTickGuardado: 4, guardadoEn: 99 });
  assert.deepEqual(leerSalud({ tick: 5 }), { tick: 5, epoca: null, ultimoTickGuardado: null, guardadoEn: null });
  const antes = { tick: 100, epoca: 2, ultimoTickGuardado: 80, guardadoEn: 1, maxTickGuardadoVisto: 80, maxTickVisto: 100, epocasVistas: [1, 2] };
  assert.deepEqual(juzgarRecuperacion(antes, { tick: 81, epoca: 3, ultimoTickGuardado: 80, guardadoEn: 2 }).problemas, []);
  assert.equal(juzgarRecuperacion(antes, { tick: 81, epoca: 2, ultimoTickGuardado: 80, guardadoEn: 2 }).problemas.length, 1);
  assert.equal(juzgarRecuperacion(antes, { tick: 60, epoca: 3, ultimoTickGuardado: 60, guardadoEn: 2 }).problemas.length, 1);
  assert.equal(juzgarRecuperacion(antes, null).problemas.length, 1);
  assert.equal(juzgarRecuperacion(antes, { tick: 81, epoca: null, ultimoTickGuardado: null, guardadoEn: null }).desconocidos.length, 2);
});

test('caídas: la cinta debe abrir una época de reinicio y marcar lo huérfano', () => {
  const vieja = { id: 1, instanciaId: 'a', tMundo: 0, motivo: 'reinicio', t1: 500, visibleHasta: null };
  const bien = { id: 2, instanciaId: 'b', tMundo: 400, motivo: 'reinicio', t1: 400, visibleHasta: null };
  const marcada = { ...vieja, visibleHasta: 400 };
  const bif = [{ epoca: 1, desde: 400, hasta: 500, motivo: 'reinicio' }];
  assert.deepEqual(juzgarCinta([vieja], [marcada, bien], bif, true).problemas, []);
  assert.equal(juzgarCinta([vieja], [marcada, bien], [], true).problemas.length, 1);
  assert.equal(juzgarCinta([vieja], [vieja, bien], bif, true).problemas.length, 1);
  assert.equal(juzgarCinta([vieja], [vieja], [], true).problemas.length, 1);
  assert.equal(juzgarCinta([vieja], [vieja], [], false).problemas.length, 0);
});
