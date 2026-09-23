import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { CONDUCTA_DIMENSIONS } from '../src/world/diversidad.js';
import { worldStatistics } from '../src/world/statistics.js';
import { parseParams } from '../src/world/params.js';
import { ACCIONES, indiceDiversidadConActividad, InstrumentosConducta } from '../scripts/lab/instrumentos.js';

/**
 * Instrumentos de medida del laboratorio (scripts/lab/instrumentos.ts, ronda INSTR 2026-09-22):
 * conducta por TIEMPO (`diversidadConductaTiempo`) y comida compartida
 * (`cooperacionAcumuladaPorTipo.foodShared`). Garantía de no intrusión: con y sin observadores el
 * mundo es bit a bit el mismo (digestoCanonico) y los dia-NNN.json coinciden salvo los campos nuevos.
 */

/** Paquete de leyes de la etapa 1 (mismo que las réplicas r2/Psinagua de la noche 2026-09-22). */
const ETAPA1 = 'persistencia.cadaTicks=300,poblacion.cortejo=2,poblacion.radioCortejo=128,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35';

/** Claves de dia-NNN.json SIN instrumentos (las de tests/lab.test.ts, `--gobernador no`). */
const CLAVES_ANTIGUAS = new Set([
  'tick', 'poblacion', 'nacimientos', 'muertesPorCausa', 'fundadoresVivos', 'generacionesVivas',
  'diversidadOficios', 'recetasCreadasAcumuladas', 'diversidadConducta', 'diversidadFuncional',
  'catalogoActivo', 'cooperaciones', 'gini', 'fraccionComida', 'distanciaAgua', 'regionesSinAgua',
  'ventanaActividad', 'vecinosMortales', 'fundadoresMortalesVivos', 'generacionesMortalesVivas',
  'recetasDistintasEnUso', 'recetasDistintasFabricadas', 'usosUtiles', 'beneficioUso',
  'usosDeInventorAjeno', 'usosSinAutorResuelto', 'fraccionUsoAjeno', 'usosConEnsenanzaRecordada',
  'cooperacionAcumuladaPorTipo', 'otrasCooperacionesAcumuladas', 'conflictosAcumulados',
  'p50Ms', 'p95Ms', 'rss',
]);
const CLAVES_NUEVAS = ['diversidadConductaTiempo', 'diversidadConductaTiempoComponentes', 'diversidadConductaComponentes', 'repartoTiempoPorAccion', 'repartoActividadPorAccion'];

type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const sinTiempos = (o: Json): Json => { const { p50Ms: _p50, p95Ms: _p95, rss: _rss, rssMaximo: _rssMax, ...resto } = o; return resto; };
/** Quita de un dia-NNN.json con instrumentos exactamente lo que añaden: sus claves y foodShared. */
function sinInstrumentos(dia: Json): Json {
  const copia: Json = { ...dia };
  for (const clave of CLAVES_NUEVAS) delete copia[clave];
  const { foodShared: _f, ...tipos } = dia.cooperacionAcumuladaPorTipo as Json;
  copia.cooperacionAcumuladaPorTipo = tipos;
  return copia;
}

/** Réplica mínima como scripts/lab/replica.ts: Store temporal guardado antes del primer paso. */
function mundo(t: TestContext, seed: number, params: string): { world: World; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-instr-'));
  const store = new Store(join(dir, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const world = createWorld(seed, parseParams(params));
  store.save(world);
  return { world, store };
}

test('ACCIONES cubre las 18 acciones del vector de conducta de src/world/diversidad.ts', () => {
  assert.equal(new Set(ACCIONES).size, 18);
  // CONDUCTA_DIMENSIONS = 2·|ACTIONS| + 5 (tecnología) + 6 (acciones de comida) + 6 (lugares).
  assert.equal(ACCIONES.length * 2 + 5 + 6 + 6, CONDUCTA_DIMENSIONS);
});

test('en proceso: el observador no mueve un bit del mundo, cuenta cada share() y sustituye solo la actividad del índice', { timeout: 1_800_000 }, t => {
  const a = mundo(t, 7, ETAPA1), b = mundo(t, 7, ETAPA1);
  const instrumentos = new InstrumentosConducta(a.world);
  const pasos = 600, cadencia = 300;
  let porLastShared = 0, mortalesPorPaso = 0;
  const vistoDesde = new Map<string, number>();
  for (let tick = 1; tick <= pasos; tick++) {
    const antes = new Set(a.world.people.map(person => person.id));
    instrumentos.antesDelPaso(a.world);
    stepWorld(a.world);
    instrumentos.despuesDelPaso(a.world);
    stepWorld(b.world);
    // Contraprueba independiente de los sucesos: share() fija donor.lastShared = tick (los recién
    // nacidos también, al nacer: por eso solo cuentan quienes ya vivían antes del paso).
    porLastShared += a.world.people.filter(person => antes.has(person.id) && person.lastShared === a.world.tick).length;
    mortalesPorPaso += a.world.people.filter(person => person.role === 'neighbor').length;
    for (const person of a.world.people) if (!vistoDesde.has(person.id)) vistoDesde.set(person.id, tick);
    if (tick % cadencia === 0) {
      a.store.save(a.world); b.store.save(b.world);
      assert.equal(digestoCanonico(a.world), digestoCanonico(b.world), `el mundo observado divergió en el paso ${tick}`);
    }
  }
  const dia = instrumentos.metricasDia(a.world);
  assert.equal(digestoCanonico(a.world), digestoCanonico(b.world), 'metricasDia no debe tocar el mundo');
  assert.ok(dia.foodShared > 0, 'en 600 pasos de la semilla 7 hay comida compartida');
  assert.equal(dia.foodShared, porLastShared, 'un acto de compartir = un suceso care = un donante con lastShared = tick');
  // Cada paso cuenta un tick por vecino mortal vivo; las fracciones suman 1.
  assert.equal(dia.repartoTiempoPorAccion.personaTicks, mortalesPorPaso);
  const suma = (f: Record<string, number>) => Object.values(f).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(suma(dia.repartoTiempoPorAccion.fracciones) - 1) < 1e-12);
  assert.ok(Math.abs(suma(dia.repartoActividadPorAccion.fracciones) - 1) < 1e-12);
  // Con la activity original, la vista da EXACTAMENTE el índice del mundo (worldStatistics: la misma
  // cadena que escribe diversidadConducta en dia-NNN.json).
  const original = indiceDiversidadConActividad(a.world, person => person.activity);
  const estadisticas = worldStatistics(a.world);
  assert.equal(estadisticas.statsTick, a.world.tick);
  const indiceMundo = estadisticas.diversidad!;
  assert.deepEqual(original, indiceMundo);
  assert.equal(dia.diversidadConductaComponentes.conducta, indiceMundo.conducta);
  assert.equal(dia.diversidadConductaComponentes.oficios, indiceMundo.oficios);
  // Con los ticks del observador el índice es otro (la entrada cambió): cada persona viva suma
  // exactamente los pasos en que el observador la vio, y el índice por tiempo es el de esos ticks.
  assert.notEqual(dia.diversidadConductaTiempo, indiceMundo.total);
  for (const person of a.world.people) {
    const ticks = instrumentos.ticksDe(person.id)!;
    assert.equal(Object.values(ticks).reduce((s, n) => s + n, 0), pasos - vistoDesde.get(person.id)! + 1, `ticks de ${person.id}`);
    assert.ok(ticks[person.action]! >= 1, 'la acción del último paso está contada');
  }
  const porTiempo = indiceDiversidadConActividad(a.world, person => instrumentos.ticksDe(person.id)!);
  assert.equal(porTiempo.total, dia.diversidadConductaTiempo);
  assert.deepEqual({ conducta: porTiempo.conducta, oficios: porTiempo.oficios }, dia.diversidadConductaTiempoComponentes);
});

/** Lanza replica.ts sin bloquear (las dos réplicas corren a la vez). */
function replica(t: TestContext, args: readonly string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-instr-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Promise((resolve, reject) => {
    const hijo = spawn(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', ...args, '--salida', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    hijo.stdout.on('data', chunk => { salida += String(chunk); });
    hijo.stderr.on('data', chunk => { salida += String(chunk); });
    hijo.on('error', reject);
    hijo.on('close', code => code === 0 ? resolve(dir) : reject(new Error(`replica.ts salió con ${code}:\n${salida}`)));
  });
}

test('CLI: réplica corta con y sin instrumentos — digestoCanonico idéntico y dia-NNN.json idénticos salvo los campos nuevos', { timeout: 1_800_000 }, async t => {
  const base = ['--seed', '42', '--dias', '1', '--params', ETAPA1];
  const [conDir, sinDir] = await Promise.all([replica(t, base), replica(t, [...base, '--instrumentos', 'no'])]);
  const con = readJson(join(conDir, 'dia-001.json')), sin = readJson(join(sinDir, 'dia-001.json'));
  assert.deepEqual(new Set(Object.keys(sin)), CLAVES_ANTIGUAS, '--instrumentos no: exactamente las claves de siempre');
  assert.deepEqual(new Set(Object.keys(con)), new Set([...CLAVES_ANTIGUAS, ...CLAVES_NUEVAS]));
  assert.deepEqual(Object.keys(con.cooperacionAcumuladaPorTipo as Json), ['teaching', 'trade', 'constructionHelp', 'foodShared']);
  assert.deepEqual(sinTiempos(sinInstrumentos(con)), sinTiempos(sin), 'los campos antiguos coinciden bit a bit');

  const replicaCon = readJson(join(conDir, 'replica.json')), replicaSin = readJson(join(sinDir, 'replica.json'));
  assert.match(replicaCon.digestoMundoFinal as string, /^[0-9a-f]{64}$/);
  assert.equal(replicaCon.digestoMundoFinal, replicaSin.digestoMundoFinal, 'el estado final del mundo es el mismo con y sin instrumentos');
  assert.deepEqual(sinTiempos(replicaCon.resumen as Json), sinTiempos(replicaSin.resumen as Json));
  assert.match(replicaCon.instrumentos as string, /^si/);
  assert.equal(replicaSin.instrumentos, 'no');

  // Coherencia de los campos nuevos.
  const componentes = con.diversidadConductaComponentes as { conducta: number; oficios: number };
  assert.equal((componentes.conducta + componentes.oficios) / 2, con.diversidadConducta, 'los componentes son los del índice antiguo');
  const tiempo = con.diversidadConductaTiempoComponentes as { conducta: number; oficios: number };
  assert.equal((tiempo.conducta + tiempo.oficios) / 2, con.diversidadConductaTiempo);
  const reparto = con.repartoTiempoPorAccion as { personaTicks: number; fracciones: Record<string, number> };
  assert.ok(reparto.personaTicks >= 2400 * 14, 'al menos los 14 fundadores mortales observados cada paso del día (hay nacimientos, pocas muertes)');
  assert.ok(Math.abs(Object.values(reparto.fracciones).reduce((s, x) => s + x, 0) - 1) < 1e-12);
  assert.deepEqual(Object.keys(reparto.fracciones), ACCIONES.filter(accion => accion in reparto.fracciones), 'claves en el orden fijo de ACCIONES');
  const foodShared = (con.cooperacionAcumuladaPorTipo as Json).foodShared as number;
  assert.ok(Number.isInteger(foodShared) && foodShared > 0);
});

test('CLI: --instrumentos acepta solo "si"|"no"', t => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-instr-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', '--seed', '1', '--dias', '1', '--instrumentos', 'quizas', '--salida', dir], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--instrumentos si\|no/);
});
