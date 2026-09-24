import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { CONDUCTA_DIMENSIONS, indiceDiversidad } from '../src/world/diversidad.js';
import { worldStatistics } from '../src/world/statistics.js';
import { parseParams } from '../src/world/params.js';
import { ACCIONES, indiceDiversidadConActividad, InstrumentosConducta, sinDescanso } from '../scripts/lab/instrumentos.js';

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
const CLAVES_NUEVAS = ['diversidadConductaTiempo', 'diversidadConductaTiempoComponentes', 'diversidadConductaActiva', 'diversidadConductaActivaComponentes', 'diversidadConductaComponentes', 'diversidadConductaVentana', 'diversidadConductaVentanaComponentes', 'personasVentana', 'repartoTiempoPorAccion', 'repartoActividadPorAccion', 'vocacionVarianza', 'vocacionEntropiaArgmax', 'vocacionCoincidencia', 'diversidadConductaVentanaGen1', 'approachHogar', 'maderaMediaAdultos', 'piedraMediaAdultos', 'muertesMenores8Dias', 'cambiosHogar', 'diversidadPerfilesJS', 'linajesVivos', 'linajesHerfindahl'];

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

/** Persona mínima para `indiceDiversidad`: sin tecnología, alimento ni lugares (esos grupos del vector
 * quedan en blanco), así que solo la actividad distingue a unas de otras. */
function personaEnBlanco(id: string): Person {
  return { id, activity: {}, technology: { competence: {}, knownRecipes: [], items: [] }, skills: {}, experiences: [] } as unknown as Person;
}

test('conducta activa: sinDescanso quita solo rest y el índice con ticks conocidos da el valor calculado a mano', () => {
  assert.deepEqual(sinDescanso({ rest: 100, explore: 10, farm: 0 }), { explore: 10 });
  assert.deepEqual(sinDescanso({ rest: 30 }), {}, 'solo descanso ⇒ actividad vacía, como quien aún no actuó');
  assert.deepEqual(sinDescanso({}), {});
  const entrada = { rest: 5, eat: 2 };
  sinDescanso(entrada);
  assert.deepEqual(entrada, { rest: 5, eat: 2 }, 'no modifica la entrada');

  // A explora, B cultiva, C solo descansa. Conducta activa: A = explore, B = farm, C vacío.
  const ticks: Record<string, Record<string, number>> = { a: { rest: 100, explore: 10 }, b: { rest: 50, farm: 5 }, c: { rest: 30 } };
  const mundo = { people: ['a', 'b', 'c'].map(personaEnBlanco) } as unknown as World;
  const activa = indiceDiversidadConActividad(mundo, person => sinDescanso(ticks[person.id]!));
  // Vectores: A y B one-hot en acciones distintas (distancia coseno 1); C en blanco frente a otro con
  // contenido: distancia 1 (diversidad.ts). Oficios: explore, farm y «sin oficio aún», 1/3 cada uno.
  const oficiosActiva = Math.log(3) / Math.log(18);
  assert.equal(activa.conducta, 1);
  assert.ok(Math.abs(activa.oficios - oficiosActiva) < 1e-12, `oficios ${activa.oficios} ≠ ln3/ln18`);
  assert.ok(Math.abs(activa.total - (1 + oficiosActiva) / 2) < 1e-12);

  // Con descanso (índice por tiempo) los tres tienen rest como oficio dominante: oficios = 0, y el
  // vector de actividad de A y B es (10, 1)/√101 sobre (rest, su acción) + one-hot rest.
  const tiempo = indiceDiversidadConActividad(mundo, person => ticks[person.id]!);
  const dAB = 1 - (100 / 101 + 1) / 2, dAC = 1 - (10 / Math.sqrt(101) + 1) / 2;
  assert.equal(tiempo.oficios, 0);
  assert.ok(Math.abs(tiempo.conducta - (dAB + 2 * dAC) / 3) < 1e-12, `conducta por tiempo ${tiempo.conducta}`);
  // Con la activity de cada persona (aquí vacía) es el índice de siempre: indiceDiversidad sin sustituir nada.
  assert.deepEqual(indiceDiversidadConActividad(mundo, person => person.activity), indiceDiversidad(mundo));
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
  // Conducta activa: los mismos ticks sin descansar; quien solo descansó queda con la actividad vacía.
  const activa = indiceDiversidadConActividad(a.world, person => sinDescanso(instrumentos.ticksDe(person.id)!));
  assert.equal(activa.total, dia.diversidadConductaActiva);
  assert.deepEqual({ conducta: activa.conducta, oficios: activa.oficios }, dia.diversidadConductaActivaComponentes);
  assert.notEqual(dia.diversidadConductaActiva, dia.diversidadConductaTiempo, 'quitar descansar cambia la entrada');
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
  // Sin --techo-lab no aparece nada del techo de laboratorio (tests/lab-techo.test.ts).
  for (const r of [replicaCon, replicaSin]) { assert.ok(!('techoLab' in r) && !('techoLabDetalle' in r)); assert.equal(r.gobernador, 'no-ejecutado; replica de leyes, no del servidor'); }

  // Coherencia de los campos nuevos.
  const componentes = con.diversidadConductaComponentes as { conducta: number; oficios: number };
  assert.equal((componentes.conducta + componentes.oficios) / 2, con.diversidadConducta, 'los componentes son los del índice antiguo');
  const tiempo = con.diversidadConductaTiempoComponentes as { conducta: number; oficios: number };
  assert.equal((tiempo.conducta + tiempo.oficios) / 2, con.diversidadConductaTiempo);
  const activa = con.diversidadConductaActivaComponentes as { conducta: number; oficios: number };
  assert.equal((activa.conducta + activa.oficios) / 2, con.diversidadConductaActiva);
  const reparto = con.repartoTiempoPorAccion as { personaTicks: number; fracciones: Record<string, number> };
  assert.ok(reparto.personaTicks >= 2400 * 14, 'al menos los 14 fundadores mortales observados cada paso del día (hay nacimientos, pocas muertes)');
  assert.ok(Math.abs(Object.values(reparto.fracciones).reduce((s, x) => s + x, 0) - 1) < 1e-12);
  assert.deepEqual(Object.keys(reparto.fracciones), ACCIONES.filter(accion => accion in reparto.fracciones), 'claves en el orden fijo de ACCIONES');
  const foodShared = (con.cooperacionAcumuladaPorTipo as Json).foodShared as number;
  assert.ok(Number.isInteger(foodShared) && foodShared > 0);
});

test('CLI: --instrumentos acepta solo "si"|"no"', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-instr-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const errores = join(dir, 'stderr');
    const err = openSync(errores, 'w');
    const hijo = spawn(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', '--seed', '1', '--dias', '1', '--instrumentos', 'quizas', '--salida', dir], { stdio: ['ignore', 'ignore', err] });
    hijo.on('error', reject);
    hijo.on('close', status => { closeSync(err); resolve({ status, stderr: readFileSync(errores, 'utf8') }); });
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--instrumentos si\|no/);
});

test('C8 v3: la diversidad de ventana usa solo a los mortales que vivieron el día completo y sus ticks de ese día', async () => {
  const { createWorld, stepWorld } = await import('../src/world/index.js');
  const { InstrumentosConducta, indiceDiversidadDe, sinDescanso } = await import('../scripts/lab/instrumentos.js');
  const world = createWorld(7);
  const inst = new InstrumentosConducta(world);
  const dia: Record<string, Record<string, number>> = {};
  const alInicio = new Set(world.people.filter(p => p.role === 'neighbor').map(p => p.id));
  for (let i = 0; i < 2400; i++) {
    inst.antesDelPaso(world); stepWorld(world); inst.despuesDelPaso(world);
    for (const p of world.people) { const d = (dia[p.id] ??= {}); d[p.action] = (d[p.action] ?? 0) + 1; }
  }
  const m = inst.metricasDia(world);
  const enVentana = world.people.filter(p => p.role === 'neighbor' && alInicio.has(p.id));
  assert.equal(m.personasVentana, enVentana.length);
  const esperado = indiceDiversidadDe(world, enVentana, p => sinDescanso(dia[p.id] ?? {}));
  assert.equal(m.diversidadConductaVentana, esperado.total);
  assert.deepEqual(m.diversidadConductaVentanaComponentes, { conducta: esperado.conducta, oficios: esperado.oficios });
});
