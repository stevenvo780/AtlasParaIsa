import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decidirConTecho } from '../src/server/governor.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import { decidirTechoLab, TECHO_LAB_MINIMO, techoLabCota } from '../scripts/lab/techo-lab.js';

/**
 * Techo determinista de laboratorio (`scripts/lab/replica.ts --techo-lab N`, noche 2026-09-22): emula
 * la política `techo` del gobernador del servidor con el techo ya fijado en N (no disparado por el p95
 * del reloj). Garantías: la población nunca pasa de `techoLabCota` (N − 1 + los nacidos de UN paso) y
 * la réplica es determinista (mismo `digestoMundoFinal`).
 */

/** Paquete de leyes de la etapa 1 (mismo que tests/instrumentos-lab.test.ts). */
const ETAPA1 = 'persistencia.cadaTicks=300,poblacion.cortejo=2,poblacion.radioCortejo=128,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35';
const CLAVES_TECHO_DIA = ['techoLab', 'reproduccionActivaFraccion', 'poblacionMaximaDia'];

type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;

test('decidirTechoLab es la rama roja de decidirConTecho con el techo fijado: reproducción ⇔ población < N', () => {
  const presupuesto = DEFAULT_PARAMS.gobernador.presupuestoMs;
  for (const techo of [16, 18, 40]) {
    for (let poblacion = 0; poblacion <= techo + 3; poblacion++) {
      assert.equal(decidirTechoLab(poblacion, techo, presupuesto), poblacion < techo, `población ${poblacion}, techo ${techo}`);
      // Rojo o banda muerta con el techo ya fijado: el servidor decide exactamente lo mismo.
      for (const p95 of [presupuesto * 0.7, presupuesto, presupuesto * 3])
        assert.equal(decidirConTecho(p95, presupuesto, poblacion, { techo }).reproduccion, poblacion < techo);
    }
  }
  assert.equal(TECHO_LAB_MINIMO, 16);
  // Cota: N − 1 + nacidos de un paso (≤ nacimientosPorComprobacion), o la población inicial si ya era mayor.
  assert.equal(techoLabCota(18, 16, 2), 19);
  assert.equal(techoLabCota(18, 16, 2, 1), 25);
  assert.equal(techoLabCota(16, 16, 0), 16);
  assert.equal(techoLabCota(16, 32, 2), 32);
});

test('CLI: --techo-lab exige un entero ≥ 16 y es incompatible con --gobernador servidor', t => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-techo-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const correr = (...extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', '--seed', '1', '--dias', '1', ...extra, '--salida', dir], { encoding: 'utf8' });
  // « 18», «1e2», «0x14», «+18» y «18.0» los aceptaba Number() como enteros ≥ 16: ahora solo dígitos.
  for (const malo of ['15', '17.5', 'veinte', '', '-3', ' 18', '18 ', '1e2', '0x14', '+18', '18.0', '99999999999999999999']) {
    const r = correr('--techo-lab', malo);
    assert.notEqual(r.status, 0, `--techo-lab «${malo}» debe fallar`);
    assert.match(r.stderr, /--techo-lab N \(entero ≥ 16/);
  }
  // Un --techo-lab final sin valor se ignoraba y la réplica corría sin techo; ahora es un error.
  const sinValor = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', '--seed', '1', '--dias', '1', '--salida', dir, '--techo-lab'], { encoding: 'utf8' });
  assert.notEqual(sinValor.status, 0, '--techo-lab sin valor debe fallar');
  assert.match(sinValor.stderr, /--techo-lab N \(entero ≥ 16.*Falta el valor tras --techo-lab/);
  // Seguida de otra bandera, el «valor» sería esa bandera: también falla.
  const seguidaDeBandera = correr('--techo-lab', '--instrumentos', 'no');
  assert.notEqual(seguidaDeBandera.status, 0);
  assert.match(seguidaDeBandera.stderr, /Recibido «--instrumentos»/);
  const conServidor = correr('--techo-lab', '18', '--gobernador', 'servidor');
  assert.notEqual(conServidor.status, 0);
  assert.match(conServidor.stderr, /--techo-lab es incompatible con --gobernador servidor/);
});

/** Lanza replica.ts sin bloquear (las réplicas corren a la vez). */
function replica(t: TestContext, args: readonly string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-techo-cli-'));
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

test('CLI: con --techo-lab N = población inicial + 2 la población nunca pasa de la cota, el techo muerde y la réplica es determinista', { timeout: 1_800_000 }, async t => {
  // Semilla 42 con la etapa 1: sin techo llega a 23 habitantes el día 1 (7 nacimientos).
  const base = ['--seed', '42', '--dias', '1', '--params', ETAPA1];
  const techo = 16 + 2;
  const [dirA, dirB, dirSin] = await Promise.all([replica(t, [...base, '--techo-lab', String(techo)]), replica(t, [...base, '--techo-lab', String(techo)]), replica(t, base)]);
  const replicaA = readJson(join(dirA, 'replica.json')), replicaB = readJson(join(dirB, 'replica.json')), replicaSin = readJson(join(dirSin, 'replica.json'));
  const diaA = readJson(join(dirA, 'dia-001.json')), diaB = readJson(join(dirB, 'dia-001.json')), diaSin = readJson(join(dirSin, 'dia-001.json'));

  // Determinista: dos corridas, el mismo mundo final y el mismo día.
  assert.match(replicaA.digestoMundoFinal as string, /^[0-9a-f]{64}$/);
  assert.equal(replicaA.digestoMundoFinal, replicaB.digestoMundoFinal);
  const sinTiempos = (o: Json): Json => { const { p50Ms: _p50, p95Ms: _p95, rss: _rss, ...resto } = o; return resto; };
  assert.deepEqual(sinTiempos(diaA), sinTiempos(diaB));
  assert.deepEqual(replicaA.techoLabDetalle, replicaB.techoLabDetalle);

  // Registro: techoLab y la fracción de ticks del día con reproducción habilitada.
  const poblacionInicial = (replicaA.resumen as Json).poblacionInicial as number;
  const cota = techoLabCota(techo, poblacionInicial, DEFAULT_PARAMS.poblacion.nacimientosPorComprobacion);
  assert.equal(poblacionInicial, 16);
  assert.equal(cota, techo + 1);
  assert.equal(diaA.techoLab, techo);
  assert.equal(replicaA.techoLab, techo);
  assert.match(replicaA.gobernador as string, /^techo de laboratorio fijo en 18/);
  const detalle = replicaA.techoLabDetalle as Json;
  assert.equal(detalle.cotaPoblacion, cota);
  assert.equal(detalle.reproduccionActivaFraccion, diaA.reproduccionActivaFraccion, 'un solo día: la fracción de la réplica es la del día');

  // La cota se comprueba a resolución de paso (poblacionMaximaDia = máximo tras cada paso del día).
  const maxima = diaA.poblacionMaximaDia as number;
  assert.ok(maxima <= cota, `población máxima ${maxima} > cota ${cota}`);
  assert.equal(detalle.poblacionMaxima, maxima);
  assert.ok((diaA.poblacion as number) <= cota);
  // El techo muerde (la prueba no es vacía): se alcanzó N, la reproducción estuvo apagada parte del día y,
  // sin techo, el mismo mundo pasa de la cota.
  assert.ok(maxima >= techo, `la población debe alcanzar el techo (${maxima} < ${techo})`);
  const fraccion = diaA.reproduccionActivaFraccion as number;
  assert.ok(fraccion > 0 && fraccion < 1, `reproduccionActivaFraccion ${fraccion} debe caer en (0,1)`);
  assert.ok((diaSin.poblacion as number) > cota, `sin techo la semilla 42 debe pasar de ${cota} el día 1 (tiene ${diaSin.poblacion})`);
  assert.ok((diaA.nacimientos as number) < (diaSin.nacimientos as number));

  // Sin la bandera no aparece nada del techo.
  for (const clave of CLAVES_TECHO_DIA) assert.ok(!(clave in diaSin), `${clave} no debe existir sin --techo-lab`);
  assert.ok(!('techoLab' in replicaSin) && !('techoLabDetalle' in replicaSin));
  for (const clave of CLAVES_TECHO_DIA) assert.ok(clave in diaA);
});
