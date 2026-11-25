import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fraccionSerial } from '../src/world/index.js';
import type { FaseNombre } from '../src/shared/types.js';
import { primeraDiferencia } from './lib/comparar.js';

const FAST_PARAMS = 'persistencia.cadaTicks=300';
const FASE_NOMBRES: readonly FaseNombre[] = [
  'maintainRegions', 'ecologia', 'kernel', 'fauna', 'personas', 'encuentros',
  'demografia', 'comunidades', 'reproduccion', 'checkpoint', 'muestreo', 'save', 'broadcast',
];

type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const stripTimings = (o: Json): Json => {
  const { p50Ms: _p50, p95Ms: _p95, rss: _rss, rssMaximo: _rssMax, ...rest } = o;
  return rest;
};

function spawnReplica(t: TestContext, args: readonly string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-lab-hw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', ...args, '--salida', dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(dir) : reject(new Error(`replica.ts salió con ${code}:\n${output}`)));
  });
}

test('replica.ts acepta --hilos, --gpu y --orden, registra fases/fraccionSerial/teselas en replica.json y --hilos 1 reproduce exactamente las cifras de hoy', { timeout: 600_000 }, async (t) => {
  const baseArgs = ['--seed', '51926', '--dias', '1', '--params', FAST_PARAMS];
  const [dirBase, dirHilos1, dirHw] = await Promise.all([
    spawnReplica(t, baseArgs),
    spawnReplica(t, [...baseArgs, '--hilos', '1', '--gpu', '[]', '--orden', 'natural']),
    spawnReplica(t, [...baseArgs, '--hilos', '4', '--gpu', '[0,1]', '--orden', 'adversarial']),
  ]);

  const diaBase = readJson(join(dirBase, 'dia-001.json'));
  const diaHilos1 = readJson(join(dirHilos1, 'dia-001.json'));
  const diaHw = readJson(join(dirHw, 'dia-001.json'));
  assert.deepEqual(stripTimings(diaHilos1), stripTimings(diaBase), '--hilos 1 debe producir exactamente el mismo dia-001.json que hoy');
  // Desde V23 no hay paridad de 0 ULP entre hilos/tarjetas y el modo de un hilo (decisión del 24-nov: la tarjeta compila con
  // FMA y el reparto en hilos cambia el orden de las sumas): las banderas de hardware solo mueven los últimos dígitos.
  assert.equal(primeraDiferencia(stripTimings(diaHw), stripTimings(diaBase), 1e-6), null, 'las banderas de hardware no deben alterar las métricas del día más allá del redondeo');

  const repBase = readJson(join(dirBase, 'replica.json'));
  const repHilos1 = readJson(join(dirHilos1, 'replica.json'));
  const repHw = readJson(join(dirHw, 'replica.json'));

  assert.equal(repHilos1.digestoMundoFinal, repBase.digestoMundoFinal, '--hilos 1 debe dar el mismo digestoMundoFinal que sin banderas');
  assert.equal(typeof repHw.digestoMundoFinal, 'string', '--hilos 4 --gpu [0,1] --orden adversarial registra su digestoMundoFinal (ya no coincide con el de un hilo)');
  assert.deepEqual(stripTimings(repHilos1.resumen as Json), stripTimings(repBase.resumen as Json));
  assert.equal(primeraDiferencia(stripTimings(repHw.resumen as Json), stripTimings(repBase.resumen as Json), 1e-6), null);

  const motor1 = ((repHilos1.params as Json).motor as Json);
  assert.equal(motor1.hilos, 1);
  assert.deepEqual(motor1.gpu, []);
  assert.equal(motor1.orden, 'natural');

  const motorHw = ((repHw.params as Json).motor as Json);
  assert.equal(motorHw.hilos, 4);
  assert.deepEqual(motorHw.gpu, [0, 1]);
  assert.equal(motorHw.orden, 'adversarial');

  for (const rep of [repBase, repHilos1, repHw]) {
    assert.equal(typeof rep.teselasActivas, 'number');
    assert.ok(Number.isInteger(rep.teselasActivas) && (rep.teselasActivas as number) > 0);
    const pobFinal = (rep.resumen as Json).poblacionFinal as number;
    assert.equal(rep.teselasPorHabitante, (rep.teselasActivas as number) / Math.max(1, pobFinal));

    const fases = rep.fases as Record<FaseNombre, number>;
    assert.ok(fases && typeof fases === 'object');
    assert.deepEqual(Object.keys(fases).sort(), [...FASE_NOMBRES].sort());
    for (const nombre of FASE_NOMBRES) {
      assert.ok(Number.isFinite(fases[nombre]) && fases[nombre] >= 0, `fase ${nombre} inválida: ${fases[nombre]}`);
    }
    const fs = rep.fraccionSerial as number;
    assert.ok(Number.isFinite(fs) && fs >= 0 && fs <= 1, `fraccionSerial fuera de [0,1]: ${fs}`);
    assert.equal(fs, fraccionSerial(fases));
  }
});

test('replica.ts y barrido.ts validan --hilos, --gpu y --orden y barrido.ts los reenvía a cada réplica', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-lab-hw-val-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const invalidArgs of [
    ['--hilos', '0'],
    ['--hilos', '513'],
    ['--hilos', 'no-num'],
    ['--gpu', '[0,0]'],
    ['--gpu', '[0,1'],
    ['--orden', 'aleatorio'],
  ]) {
    const resReplica = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/replica.ts', '--seed', '1', '--dias', '1', ...invalidArgs, '--salida', join(dir, 'rep')], { encoding: 'utf8' });
    assert.notEqual(resReplica.status, 0, `replica.ts debe rechazar ${invalidArgs.join(' ')}`);

    const resBarrido = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/barrido.ts', '--replicas', '1', '--dias', '1', ...invalidArgs, '--salida', join(dir, 'bar')], { encoding: 'utf8' });
    assert.notEqual(resBarrido.status, 0, `barrido.ts debe rechazar ${invalidArgs.join(' ')}`);
  }

  // Verificar que barrido.ts reenvía --hilos, --gpu y --orden al proceso de réplica
  const stubDir = mkdtempSync(join(tmpdir(), 'atlas-lab-hw-stub-'));
  t.after(() => rmSync(stubDir, { recursive: true, force: true }));
  const replicaStub = join(stubDir, 'replica.ts');
  const resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(
    replicaStub,
    "import { mkdirSync, writeFileSync } from 'node:fs';\n" +
    "const args = process.argv.slice(2);\n" +
    "const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };\n" +
    "const salida = at('--salida');\n" +
    "mkdirSync(salida, { recursive: true });\n" +
    "writeFileSync(salida + '/replica.json', JSON.stringify({ seed: Number(at('--seed')), hilos: at('--hilos'), gpu: at('--gpu'), orden: at('--orden') }) + '\\n');\n",
  );
  writeFileSync(
    resumenStub,
    "import { writeFileSync } from 'node:fs';\n" +
    "import { join } from 'node:path';\n" +
    "const args = process.argv.slice(2);\n" +
    "const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };\n" +
    "const salida = at('--salida') ?? at('--entrada');\n" +
    "writeFileSync(join(salida, 'resumen.json'), '{}\\n');\n" +
    "writeFileSync(join(salida, 'resumen.md'), '# ok\\n');\n",
  );
  const salidaBarrido = join(dir, 'reenvio');
  const outcome = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/lab/barrido.ts', '--replicas', '1', '--dias', '1', '--seed-base', '77', '--hilos', '8', '--gpu', '[0,1]', '--orden', 'inverso', '--salida', salidaBarrido],
    { encoding: 'utf8', env: { ...process.env, CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub } },
  );
  assert.equal(outcome.status, 0, outcome.stderr);
  const recibido = readJson(join(salidaBarrido, 'base', 'seed-77', 'replica.json'));
  assert.equal(recibido.hilos, '8');
  assert.equal(recibido.gpu, '[0,1]');
  assert.equal(recibido.orden, 'inverso');
});

test('barrido de 2 réplicas × 2 backends (motor.hilos=1,2) produce semáforo de determinismo 🟢 y curva p95(teselas), y detecta una rotura sintética como 🔴', { timeout: 600_000 }, (t) => {
  const salida = mkdtempSync(join(tmpdir(), 'atlas-lab-hw-sweep-'));
  t.after(() => rmSync(salida, { recursive: true, force: true }));

  const sweep = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', 'scripts/lab/barrido.ts',
      '--replicas', '2', '--dias', '1', '--seed-base', '100', '--concurrencia', '4',
      '--param', 'motor.hilos=1,2',
      '--param', FAST_PARAMS,
      '--salida', salida,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(sweep.status, 0, `barrido falló:\n${sweep.stderr}\n${sweep.stdout}`);

  const resumenOk = readJson(join(salida, 'resumen.json'));
  const mdOk = readFileSync(join(salida, 'resumen.md'), 'utf8');

  assert.equal(resumenOk.totalReplicas, 4);
  assert.equal((resumenOk.grupos as unknown[]).length, 2);

  const detOk = resumenOk.determinismo as {
    ok: boolean;
    semaforo: string;
    estado: string;
    conflictos: unknown[];
    comparacionesBackend: Array<{ seed: number; backends: string[]; digestoMundoFinal: string[]; ok: boolean; semaforo: string; estado: string }>;
  };
  assert.equal(detOk.ok, true);
  assert.equal(detOk.semaforo, '🟢');
  assert.equal(detOk.estado, '🟢 DETERMINISTA');
  assert.equal(detOk.conflictos.length, 0);
  assert.equal(detOk.comparacionesBackend.length, 2, 'debe comparar los 2 backends para cada una de las 2 semillas');
  for (const comp of detOk.comparacionesBackend) {
    assert.equal(comp.ok, true);
    assert.equal(comp.semaforo, '🟢');
    assert.equal(comp.estado, '🟢 DETERMINISTA');
    assert.equal(comp.backends.length, 2);
    assert.equal(comp.digestoMundoFinal[0], comp.digestoMundoFinal[1], `semilla ${comp.seed} debe coincidir en digestoMundoFinal entre backends`);
  }

  const curva = resumenOk.curvaTeselas as Array<{
    grupo: string;
    backend: string;
    teselasActivas: { mediana: number } | null;
    teselasPorHabitante: { mediana: number } | null;
    p95Ms: { mediana: number } | null;
    fraccionSerial: { mediana: number } | null;
  }>;
  assert.equal(curva.length, 2);
  for (const punto of curva) {
    assert.ok(punto.teselasActivas && punto.teselasActivas.mediana > 0);
    assert.ok(punto.teselasPorHabitante && punto.teselasPorHabitante.mediana > 0);
    assert.ok(punto.p95Ms && punto.p95Ms.mediana >= 0);
    assert.ok(punto.fraccionSerial && punto.fraccionSerial.mediana >= 0 && punto.fraccionSerial.mediana <= 1);
  }
  assert.ok(mdOk.includes('🟢 DETERMINISTA'), 'resumen.md debe mostrar 🟢 DETERMINISTA');
  assert.ok(mdOk.includes('## Curva p95(teselasActivas) y hardware'), 'resumen.md debe incluir la curva p95(teselasActivas)');
  assert.ok(mdOk.includes('teselasPorHabitante'), 'resumen.md debe incluir teselasPorHabitante');

  // Inyectar rotura sintética de determinismo alterando digestoMundoFinal en un backend (motor.hilos=2, seed-101)
  const slugHilos2 = `motor.hilos=2_${FAST_PARAMS}`;
  const replicaRotaPath = join(salida, slugHilos2, 'seed-101', 'replica.json');
  const replicaRota = readJson(replicaRotaPath);
  replicaRota.digestoMundoFinal = 'f'.repeat(64);
  writeFileSync(replicaRotaPath, JSON.stringify(replicaRota, null, 2) + '\n');

  const resRoto = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/lab/resumen.ts', '--entrada', salida],
    { encoding: 'utf8' },
  );
  assert.equal(resRoto.status, 1, 'resumen.ts debe salir con código 1 ante rotura de determinismo entre backends');

  const resumenRoto = readJson(join(salida, 'resumen.json'));
  const mdRoto = readFileSync(join(salida, 'resumen.md'), 'utf8');
  const detRoto = resumenRoto.determinismo as {
    ok: boolean;
    semaforo: string;
    estado: string;
    conflictos: Array<{ seed: number; backends: string[]; primeraDiferencia: string }>;
    comparacionesBackend: Array<{ seed: number; ok: boolean; semaforo: string; estado: string }>;
  };

  assert.equal(detRoto.ok, false);
  assert.equal(detRoto.semaforo, '🔴');
  assert.equal(detRoto.estado, '🔴 ROTO');
  assert.equal(detRoto.conflictos.length, 1);
  assert.equal(detRoto.conflictos[0]!.seed, 101);
  assert.match(detRoto.conflictos[0]!.primeraDiferencia, /digestoMundoFinal distinto/);
  assert.ok(detRoto.conflictos[0]!.backends.some(b => b.includes('hilos=1')));
  assert.ok(detRoto.conflictos[0]!.backends.some(b => b.includes('hilos=2')));

  const comp101 = detRoto.comparacionesBackend.find(c => c.seed === 101)!;
  assert.equal(comp101.ok, false);
  assert.equal(comp101.semaforo, '🔴');
  assert.equal(comp101.estado, '🔴 ROTO');

  assert.ok(mdRoto.includes('🔴 ROTO'), 'resumen.md debe mostrar 🔴 ROTO cuando un backend diverge');
  assert.ok(mdRoto.includes('digestoMundoFinal distinto'), 'resumen.md debe detallar la divergencia de digestoMundoFinal');
});
