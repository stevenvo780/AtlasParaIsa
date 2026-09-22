import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
/** El contrato de `curva-techo.mts` («salida determinista salvo tiempos», igual que
 * `scripts/lab/replica.ts`) exime `p50`, `p95`, `tickHz` y `rss` — dependen del reloj de
 * pared y del asignador de memoria del proceso, no de la simulación. */
const stripTimings = (o: Json): Json => { const { p50: _p50, p95: _p95, tickHz: _tickHz, rss: _rss, ...rest } = o; return rest; };

function runCurva(t: TestContext, args: readonly string[]): { dir: string; result: SpawnSyncReturns<string> } {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-techo-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/curva-techo.mts', ...args, '--salida', dir], { encoding: 'utf8' });
  return { dir, result };
}

const PUNTO_KEYS = ['escala', 'habitantes', 'teselasActivas', 'teselasPorHabitante', 'p50', 'p95', 'tickHz', 'rss', 'fraccionSerial', 'presupuestoMs', 'hilosSolicitados', 'gpuSolicitada', 'tick'] as const;

test('escala de habitantes: produce puntos con las claves pedidas por T109 y para por hasta', (t) => {
  const { dir, result } = runCurva(t, ['--seed', '51926', '--escala', 'habitantes', '--hasta', '32']);
  assert.equal(result.status, 0, result.stderr);

  const puntos = readdirSync(dir).filter(f => f.startsWith('punto-')).sort();
  assert.ok(puntos.length >= 1, 'debe escribir al menos un punto-NNN.json');
  for (const nombre of puntos) {
    const punto = readJson(join(dir, nombre));
    for (const key of PUNTO_KEYS) assert.ok(Object.hasOwn(punto, key), `${nombre} debe tener la clave "${key}"`);
    assert.equal(typeof punto.escala, 'number');
    assert.equal(typeof punto.p95, 'number');
    assert.equal(typeof punto.p50, 'number');
    assert.equal(punto.fraccionSerial, 1, 'hoy no hay backend paralelo: fraccionSerial documentado como 1 (ver cabecera del script)');
    assert.ok((punto.teselasActivas as number) > 0);
    assert.equal(punto.teselasPorHabitante, (punto.teselasActivas as number) / (punto.habitantes as number));
  }

  const curva = readJson(join(dir, 'curva.json'));
  assert.equal(curva.seed, 51926);
  assert.equal(curva.escala, 'habitantes');
  assert.match(curva.sha as string, /^[0-9a-f]{40}$/);
  assert.match(curva.digest as string, /^[0-9a-f]{64}$/);
  assert.ok(['hasta', 'presupuesto', 'limite-seguridad'].includes(curva.motivoParada as string));
  const primerPunto = (curva.puntos as Json[])[0]!;
  assert.equal(primerPunto.escala, 16, 'el primer escalón de la escala de habitantes es la población inicial de createWorld');
});

test('el instrumento encuentra el techo (p95 ≥ presupuestoMs) antes de un hasta generoso', (t) => {
  const { result } = runCurva(t, ['--seed', '51926', '--escala', 'habitantes', '--hasta', '4096']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Curva completa \(presupuesto\)/, 'con --hasta generoso el criterio de parada real es cruzar gobernador.presupuestoMs, no agotar --hasta');
});

test('dos corridas con la misma semilla dan la misma curva salvo tiempos (hasta donde ambas llegaron)', (t) => {
  // Esta torre corre varios worktrees hermanos en paralelo (load average de dos dígitos no es
  // raro durante un sprint nocturno): el p95 real de UNA corrida concreta puede cruzar
  // `presupuestoMs` (50 ms) en un escalón distinto al de otra corrida por puro ruido del
  // sistema (contención de CPU, no el instrumento), así que las dos curvas pueden tener
  // distinto NÚMERO de puntos. Lo que SÍ es determinista pase lo que pase con el reloj: cada
  // punto de índice `i` corresponde siempre a la MISMA cantidad de pasos simulados desde la
  // misma semilla (`(i+1) × GOVERNOR_WINDOW_STEPS` pasos deterministas de `createWorld`), así
  // que sus campos estructurales (escala/habitantes/teselas/tick/digest…) deben coincidir
  // exactamente entre corridas para todo índice que AMBAS alcanzaron — solo el índice en el
  // que cada corrida decide parar (y las columnas de tiempo: p50/p95/tickHz/rss) pueden variar.
  // Esto valida bastante más que el primer escalón sin volverse frágil ante el ruido de la torre.
  const args = ['--seed', '20260905', '--escala', 'habitantes', '--hasta', '64'];
  const a = runCurva(t, args), b = runCurva(t, args);
  assert.equal(a.result.status, 0, a.result.stderr);
  assert.equal(b.result.status, 0, b.result.stderr);
  const curvaA = readJson(join(a.dir, 'curva.json')), curvaB = readJson(join(b.dir, 'curva.json'));
  assert.equal(curvaA.digest, curvaB.digest);
  const puntosA = curvaA.puntos as Json[], puntosB = curvaB.puntos as Json[];
  assert.ok(puntosA.length >= 1 && puntosB.length >= 1);
  const comunes = Math.min(puntosA.length, puntosB.length);
  for (let i = 0; i < comunes; i++) {
    assert.deepEqual(stripTimings(puntosA[i]!), stripTimings(puntosB[i]!), `el escalón ${i} (misma cantidad de pasos deterministas desde la misma semilla) debe ser idéntico salvo tiempos`);
  }
});

test('el criterio de parada es una función determinista de p95 y presupuestoMs, no del reloj', (t) => {
  // Sanity de una sola corrida: dado lo que de verdad tardó cada paso (ruido de esta torre
  // incluido), la DECISIÓN de seguir o parar es una comparación pura — se comprueba sobre los
  // números que el propio instrumento escribió, no reinventando su medición.
  const { dir, result } = runCurva(t, ['--seed', '51926', '--escala', 'habitantes', '--hasta', '4096']);
  assert.equal(result.status, 0, result.stderr);
  const curva = readJson(join(dir, 'curva.json'));
  const puntos = curva.puntos as Json[];
  for (const punto of puntos.slice(0, -1)) assert.ok((punto.p95 as number) < (punto.presupuestoMs as number), 'ningún punto salvo el último puede haber cruzado el presupuesto: si lo cruzó, ahí paraba');
  const ultimo = puntos[puntos.length - 1]!;
  if (curva.motivoParada === 'presupuesto') assert.ok((ultimo.p95 as number) >= (ultimo.presupuestoMs as number));
  else if (curva.motivoParada === 'hasta') assert.equal(ultimo.escala, 4096);
});

test('escala de teselas: crece las teselas activas por encima de la escena inicial sin reventar', (t) => {
  const { dir, result } = runCurva(t, ['--seed', '51926', '--escala', 'teselas', '--hasta', '3072']);
  assert.equal(result.status, 0, result.stderr);
  const curva = readJson(join(dir, 'curva.json'));
  assert.equal(curva.escala, 'teselas');
  const puntos = curva.puntos as Json[];
  assert.ok(puntos.length >= 1);
  const ultimo = puntos[puntos.length - 1]!;
  assert.ok((ultimo.teselasActivas as number) >= 1536, 'debe superar las 1536 teselas (6 chunks) que activa createWorld de partida');
  for (const punto of puntos) assert.equal(punto.escala, punto.teselasActivas, 'en escala "teselas" el punto reporta las teselas activas alcanzadas, no un nominal');
});

test('valida los argumentos: --escala inválida, --hilos fuera de rango y falta de --salida', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-techo-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/curva-techo.mts', ...args], { encoding: 'utf8' });

  const escalaInvalida = base(['--seed', '1', '--escala', 'kilómetros', '--salida', dir]);
  assert.notEqual(escalaInvalida.status, 0);
  assert.match(escalaInvalida.stderr, /--escala/);

  const hilosInvalidos = base(['--seed', '1', '--escala', 'habitantes', '--hilos', '0', '--salida', dir]);
  assert.notEqual(hilosInvalidos.status, 0);

  const sinSalida = base(['--seed', '1', '--escala', 'habitantes']);
  assert.notEqual(sinSalida.status, 0);
  assert.match(sinSalida.stderr, /--salida/);
});

test('--hilos y --gpu se aceptan y se registran aunque hoy no exista backend paralelo ni GPU', (t) => {
  const { dir, result } = runCurva(t, ['--seed', '51926', '--escala', 'habitantes', '--hasta', '16', '--hilos', '4', '--gpu', '0,1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no existe ningún backend paralelo ni de GPU/);
  const curva = readJson(join(dir, 'curva.json'));
  assert.equal(curva.hilosSolicitados, 4);
  assert.deepEqual(curva.gpuSolicitada, [0, 1]);
  const punto = readJson(join(dir, 'punto-000.json'));
  assert.equal(punto.hilosSolicitados, 4);
  assert.deepEqual(punto.gpuSolicitada, [0, 1]);
  assert.equal(punto.fraccionSerial, 1, 'con --hilos > 1 el paso sigue siendo 100% serial: no hay backend que lo paralelice todavía');
});
