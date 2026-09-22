import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// T017 (scripts/lab/barrido.ts) depende de scripts/lab/replica.ts (T016) y scripts/lab/resumen.ts
// (T018): workstreams paralelos ajenos a esta tarea (regla 1 de tasks.md: "toca SOLO los ficheros
// listados en tu tarea"). Ronda de arreglo (revisión T017, hallazgo 3): las pruebas ya NO tocan
// (ni se saltan por la existencia de) los ficheros reales de T016/T018 — inyectan stubs propios
// vía CARTA_REPLICA_SCRIPT/CARTA_RESUMEN_SCRIPT (env, soportadas por barrido.ts para esto mismo),
// así que corren SIEMPRE, integrado o no, y pueden fallar de verdad si el seam se rompe.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BARRIDO = join(ROOT, 'scripts/lab/barrido.ts');

function runBarrido(args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 120_000) {
  return spawnSync(process.execPath, ['--import', 'tsx', BARRIDO, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env },
  });
}

function newStubDir(): string {
  return mkdtempSync(join(tmpdir(), 'carta-barrido-stub-'));
}

const STUB_REPLICA_OK =
  "import { mkdirSync, writeFileSync } from 'node:fs';\n" +
  "const args = process.argv.slice(2);\n" +
  "const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };\n" +
  "const salida = at('--salida'); if (!salida) throw new Error('stub: falta --salida');\n" +
  "mkdirSync(salida, { recursive: true });\n" +
  "writeFileSync(salida + '/replica.json', JSON.stringify({ seed: Number(at('--seed')), dias: Number(at('--dias')), params: at('--params') ?? '' }) + '\\n');\n";

const STUB_RESUMEN_OK =
  "import { writeFileSync } from 'node:fs';\n" +
  "import { join } from 'node:path';\n" +
  "const args = process.argv.slice(2);\n" +
  "const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };\n" +
  "const entrada = at('--entrada');\n" +
  // Misma comprobación que el resumen.ts real (T018): sin --entrada, falla. Si barrido.ts
  // regresa a pasar --salida en su lugar (hallazgo 1), este stub lo detecta.
  "if (!entrada) throw new Error('Falta --entrada <dir> (directorio del barrido).');\n" +
  "const salida = at('--salida') ?? entrada;\n" +
  "writeFileSync(join(salida, 'resumen.json'), JSON.stringify({ entradaRecibida: entrada }) + '\\n');\n" +
  "writeFileSync(join(salida, 'resumen.md'), '# resumen stub\\n');\n";

const STUB_RESUMEN_FALLA = "throw new Error('resumen.ts (stub): simulo un fallo antes de escribir nada');\n";

/** Réplica que ignora SIGTERM y lanza un NIETO (otro proceso `node`) que también lo ignora y solo
 * escribe su pid en `pidFile` antes de quedarse vivo. Modela el árbol real npx→tsx→node de forma
 * determinista (sin depender de cómo reenvíe señales la versión de npm/tsx instalada) para probar
 * que el SIGKILL de gracia de barrido.ts mata el GRUPO completo, no solo a su hijo directo. */
function writeOrphanGuardStub(dir: string, pidFile: string): string {
  const grandchildPath = join(dir, 'nieto.cjs');
  writeFileSync(
    grandchildPath,
    "process.on('SIGTERM', () => {});\n" +
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
    'setInterval(() => {}, 1000);\n',
  );
  const replicaPath = join(dir, 'replica.ts');
  writeFileSync(
    replicaPath,
    "import { spawn } from 'node:child_process';\n" +
    "import { writeFileSync } from 'node:fs';\n" +
    "process.on('SIGTERM', () => {});\n" +
    `writeFileSync(${JSON.stringify(`${pidFile}.parent`)}, String(process.pid));\n` +
    `spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(grandchildPath)}], { stdio: 'ignore' });\n` +
    'setInterval(() => {}, 1000);\n',
  );
  return replicaPath;
}

function cleanOrphanGuardStub(pidFile: string): void {
  for (const path of [pidFile, `${pidFile}.parent`]) {
    if (!existsSync(path)) continue;
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* ya terminado */ }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('barrido: --help muestra el uso y no toca --salida', () => {
  const base = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const salida = join(base, 'no-debe-crearse');
  try {
    const result = runBarrido(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--replicas/);
    assert.ok(!existsSync(salida));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('barrido: sin --timeout ni --salida usa defaults (600 s y artifacts/lab/<sello>), no falla por eso', () => {
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts');
  writeFileSync(replicaStub, STUB_REPLICA_OK);
  const resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  const labDir = join(ROOT, 'artifacts', 'lab');
  const antes = new Set(existsSync(labDir) ? readdirSync(labDir) : []);
  let nuevoDir: string | undefined;
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '1', '--concurrencia', '1', '--seed-base', '600'],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    const despues = existsSync(labDir) ? readdirSync(labDir) : [];
    const nuevos = despues.filter(nombre => !antes.has(nombre));
    assert.equal(nuevos.length, 1, `se esperaba exactamente 1 directorio nuevo con sello bajo artifacts/lab, hubo ${nuevos.length}`);
    nuevoDir = join(labDir, nuevos[0]!);
    assert.ok(existsSync(join(nuevoDir, 'progreso.log')));
    assert.ok(existsSync(join(nuevoDir, 'base', 'seed-600', 'replica.json')));
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
    if (nuevoDir) rmSync(nuevoDir, { recursive: true, force: true });
  }
});

test('barrido: 3 réplicas × 1 día con concurrencia 2 termina y encola todo (stub inyectado, sin tocar T016)', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts');
  writeFileSync(replicaStub, STUB_REPLICA_OK);
  const resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  try {
    const outcome = runBarrido(
      ['--replicas', '3', '--dias', '1', '--concurrencia', '2', '--timeout', '20', '--seed-base', '500', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    const log = readFileSync(join(salida, 'progreso.log'), 'utf8');
    const jobLines = log.trim().split('\n').filter(line => line.includes('job='));
    assert.equal(jobLines.length, 3, 'una línea de progreso por réplica encolada');
    assert.ok(jobLines.every(line => line.includes('estado=ok')), 'las 3 réplicas del stub terminan ok');
    assert.ok(jobLines.some(line => line.includes('(100.0%)')), 'el progreso llega a 100%');
    for (const seed of [500, 501, 502]) {
      assert.ok(existsSync(join(salida, 'base', `seed-${seed}`, 'replica.json')), `falta el directorio de la réplica seed-${seed}`);
    }
  } finally { rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: --param con varios valores produce el producto cartesiano de trabajos (una clave, --param repetible)', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts');
  writeFileSync(replicaStub, STUB_REPLICA_OK);
  const resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '1', '--concurrencia', '2', '--timeout', '20', '--seed-base', '10', '--param', 'demo.k=a,b', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    assert.ok(existsSync(join(salida, 'demo.k=a', 'seed-10', 'replica.json')));
    assert.ok(existsSync(join(salida, 'demo.k=b', 'seed-10', 'replica.json')));
  } finally { rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: --param acepta varios grupos "clave=v1,v2" sueltos tras un solo --param (forma de T031)', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts');
  writeFileSync(replicaStub, STUB_REPLICA_OK);
  const resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  try {
    const outcome = runBarrido(
      ['--param', 'demo.a=x,y', 'demo.b=z', '--replicas', '1', '--dias', '1', '--concurrencia', '2', '--timeout', '20', '--seed-base', '20', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    assert.ok(existsSync(join(salida, 'demo.a=x_demo.b=z', 'seed-20', 'replica.json')));
    assert.ok(existsSync(join(salida, 'demo.a=y_demo.b=z', 'seed-20', 'replica.json')));
  } finally { rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: combina números, arrays, booleanos y enums sin separar las comas de motor.gpu', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts'), resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(replicaStub, STUB_REPLICA_OK);
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '2', '--concurrencia', '4', '--timeout', '20', '--seed-base', '30',
        '--param', 'motor.hilos=1', 'motor.gpu=[], [0], [0,1]', 'motor.clonPorPaso=false,true',
        '--param', 'motor.orden=natural,inverso', '--param', 'motor.hilos=8', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    const recibidos = readdirSync(salida, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
      const replica = JSON.parse(readFileSync(join(salida, entry.name, 'seed-30', 'replica.json'), 'utf8'));
      assert.equal(replica.seed, 30);
      assert.equal(replica.dias, 2);
      return replica.params as string;
    });
    const esperados: string[] = [];
    for (const hilos of [1, 8]) for (const gpu of ['[]', '[0]', '[0,1]']) {
      for (const clon of [false, true]) for (const orden of ['natural', 'inverso']) {
        esperados.push(`motor.hilos=${hilos},motor.gpu=${gpu},motor.clonPorPaso=${clon},motor.orden=${orden}`);
      }
    }
    assert.equal(recibidos.length, 24, 'cada array es un valor; repetir --param agrega valores a la misma clave');
    assert.deepEqual(recibidos.sort(), esperados.sort(), 'cada réplica recibe --params completo y en el orden de claves de la CLI');
    const log = readFileSync(join(salida, 'progreso.log'), 'utf8');
    assert.equal(log.split('\n').filter(line => line.includes('job=')).length, 24);
    assert.match(log, /barrido completo: ok=24 abortadas=0 errores=0/);
  } finally { rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: arrays con delimitadores o comillas sin cerrar fallan antes de crear el barrido', () => {
  const base = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts'), resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(replicaStub, STUB_REPLICA_OK);
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  try {
    const invalidos = ['motor.gpu=[0,1', 'motor.gpu=0,1]', 'motor.gpu=[0,1}', 'motor.gpu=["0,1]'];
    for (const [index, raw] of invalidos.entries()) {
      const salida = join(base, `invalido-${index}`);
      const outcome = runBarrido(
        ['--replicas', '1', '--dias', '1', '--concurrencia', '1', '--param', raw, '--salida', salida],
        { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
      );
      assert.equal(outcome.status, 1, `el barrido debe rechazar ${raw}: ${outcome.stderr}`);
      assert.ok(outcome.stderr.trim().length > 0, `el error de ${raw} debe explicar la sintaxis inválida`);
      assert.equal(existsSync(salida), false, `no debe encolar réplicas ni crear progreso para ${raw}`);
    }
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: el marcador de réplica fallida conserva arrays y opciones de motor normalizados', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts'), resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(replicaStub, "throw new Error('fallo antes de producir replica.json');\n");
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '1', '--concurrencia', '1', '--timeout', '20', '--seed-base', '31',
        '--param', 'motor.gpu=[0,1]', 'motor.hilos=8', 'motor.clonPorPaso=false', 'motor.orden=inverso', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.equal(outcome.status, 1, 'la réplica fallida no se convierte en un barrido exitoso');
    const grupos = readdirSync(salida, { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert.equal(grupos.length, 1, 'el array de dos GPU sigue siendo una sola combinación');
    const marcador = JSON.parse(readFileSync(join(salida, grupos[0]!.name, 'seed-31', 'replica.json'), 'utf8'));
    assert.equal(marcador.abortada, true);
    assert.equal(marcador.barrido.estado, 'error');
    assert.equal(marcador.params._paramsCrudos, undefined, 'el marcador debe agruparse por parámetros normalizados');
    assert.equal(marcador.params.motor.hilos, 8);
    assert.deepEqual(marcador.params.motor.gpu, [0, 1]);
    assert.equal(marcador.params.motor.clonPorPaso, false);
    assert.equal(marcador.params.motor.orden, 'inverso');
  } finally { rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: una réplica que supera --timeout mata TODO el árbol de procesos, queda "abortada" con marcador replica.json para T018, y no bloquea el resto', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const pidFile = join(stubDir, 'nieto.pid');
  const replicaStub = writeOrphanGuardStub(stubDir, pidFile);
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '1', '--concurrencia', '1', '--timeout', '2', '--seed-base', '900', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub },
    );
    assert.notEqual(outcome.status, 0, 'el barrido refleja en su código de salida que hubo una réplica abortada');
    const log = readFileSync(join(salida, 'progreso.log'), 'utf8');
    assert.match(log, /estado=abortada/);

    // Hallazgo 5 (revisión T017): réplica abortada deja un replica.json legible por T018.
    const marcadorPath = join(salida, 'base', 'seed-900', 'replica.json');
    assert.ok(existsSync(marcadorPath), 'la réplica abortada debe dejar un replica.json marcador');
    const marcador = JSON.parse(readFileSync(marcadorPath, 'utf8')) as Record<string, unknown>;
    assert.equal(marcador.abortada, true);
    assert.equal(typeof marcador.seed, 'number');
    assert.equal(typeof marcador.sha, 'string');
    assert.equal(typeof marcador.digest, 'string');

    // Hallazgo 4 (revisión T017): el SIGKILL de gracia llega a TODO el grupo, no solo al hijo
    // directo; el nieto no debe quedar huérfano vivo.
    assert.ok(existsSync(pidFile), 'el nieto llegó a arrancar y escribir su pid (si esto falla de forma intermitente, subir --timeout)');
    const nietoPid = Number(readFileSync(pidFile, 'utf8').trim());
    const vivo = (): boolean => { try { process.kill(nietoPid, 0); return true; } catch { return false; } };
    const desde = Date.now();
    while (vivo() && Date.now() - desde < 5000) sleepSync(100);
    assert.ok(!vivo(), `el nieto (pid ${nietoPid}) quedó huérfano vivo tras marcarse "abortada": el SIGKILL no llegó a todo el grupo de procesos`);
  } finally { cleanOrphanGuardStub(pidFile); rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: el padre termina con SIGTERM pero la gracia mata al nieto que lo ignora', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir(), pidFile = join(stubDir, 'nieto.pid'), parentExit = join(stubDir, 'padre-termino');
  const replicaStub = writeOrphanGuardStub(stubDir, pidFile), resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  // El hijo directo es este npx controlado: sale 0 al recibir SIGTERM mientras
  // la réplica y su nieto siguen vivos. No depende del reenvío de npm/tsx.
  writeFileSync(join(stubDir, 'npx'), `#!${process.execPath}\n` +
    "const { spawn } = require('node:child_process');\n" +
    "process.on('SIGTERM', () => {\n" +
    `  require('node:fs').writeFileSync(${JSON.stringify(parentExit)}, String(process.pid)); process.exit(0);\n` +
    "});\n" +
    "const child = spawn(process.execPath, ['--import', 'tsx', ...process.argv.slice(3)], { stdio: 'inherit' });\n" +
    "child.once('error', () => process.exit(1)); child.once('exit', code => process.exit(code ?? 1));\n", { mode: 0o700 });
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '1', '--concurrencia', '1', '--timeout', '2', '--seed-base', '901', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub, PATH: `${stubDir}:${process.env.PATH ?? ''}` },
    );
    assert.notEqual(outcome.status, 0, 'el padre saliendo 0 no convierte una réplica abortada en éxito');
    assert.ok(existsSync(parentExit), 'el hijo directo recibió SIGTERM y terminó voluntariamente');
    assert.ok(existsSync(pidFile), 'el nieto alcanzó a instalar su handler y arrancar');
    const marker = JSON.parse(readFileSync(join(salida, 'base', 'seed-901', 'replica.json'), 'utf8'));
    assert.equal(marker.abortada, true);
    assert.equal(marker.barrido.codigo, 0, 'el hijo directo terminó antes del SIGKILL de gracia');
    assert.equal(marker.barrido.senal, null);
    assert.match(readFileSync(join(salida, 'progreso.log'), 'utf8'), /estado=abortada/);
    const nietoPid = Number(readFileSync(pidFile, 'utf8').trim());
    const vivo = (): boolean => { try { process.kill(nietoPid, 0); return true; } catch { return false; } };
    const desde = Date.now();
    while (vivo() && Date.now() - desde < 5000) sleepSync(100);
    assert.ok(!vivo(), `el nieto (pid ${nietoPid}) sobrevivió a la gracia porque su padre ya había terminado`);
  } finally { cleanOrphanGuardStub(pidFile); rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: invoca resumen.ts con --entrada (no --salida) y no marca error si produce resumen.json/md', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts');
  writeFileSync(replicaStub, STUB_REPLICA_OK);
  const resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '1', '--concurrencia', '1', '--timeout', '20', '--seed-base', '700', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    const resumenJson = JSON.parse(readFileSync(join(salida, 'resumen.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(resumenJson.entradaRecibida, salida, 'resumen.ts debe recibir el directorio del barrido en --entrada (no en --salida)');
    assert.ok(existsSync(join(salida, 'resumen.md')));
  } finally { rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: si resumen.ts no logra escribir resumen.json/md, el código de salida y progreso.log lo reflejan', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts');
  writeFileSync(replicaStub, STUB_REPLICA_OK);
  const resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(resumenStub, STUB_RESUMEN_FALLA);
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '1', '--concurrencia', '1', '--timeout', '20', '--seed-base', '701', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.notEqual(outcome.status, 0, 'sin resumen.json/md no hay evidencia agregada del barrido (constitución II): no debe salir 0');
    assert.ok(!existsSync(join(salida, 'resumen.json')));
    const log = readFileSync(join(salida, 'progreso.log'), 'utf8');
    assert.match(log, /no se gener[oó]/i);
  } finally { rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

// T118-bis: --gobernador se reenvía a CADA réplica; sin la bandera, no se pasa nada (compatible
// con réplicas viejas que no la conocen).
const STUB_REPLICA_REGISTRA_GOBERNADOR =
  "import { mkdirSync, writeFileSync } from 'node:fs';\n" +
  "const args = process.argv.slice(2);\n" +
  "const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };\n" +
  "const salida = at('--salida'); if (!salida) throw new Error('stub: falta --salida');\n" +
  "mkdirSync(salida, { recursive: true });\n" +
  "writeFileSync(salida + '/replica.json', JSON.stringify({ seed: Number(at('--seed')), dias: Number(at('--dias')), params: at('--params') ?? '', gobernadorRecibido: at('--gobernador') ?? null }) + '\\n');\n";

test('barrido: --gobernador servidor se reenvía a la réplica', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts');
  writeFileSync(replicaStub, STUB_REPLICA_REGISTRA_GOBERNADOR);
  const resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '1', '--concurrencia', '1', '--timeout', '20', '--seed-base', '710', '--gobernador', 'servidor', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    const replicaJson = JSON.parse(readFileSync(join(salida, 'base', 'seed-710', 'replica.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(replicaJson.gobernadorRecibido, 'servidor');
  } finally { rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: sin --gobernador no se pasa nada a la réplica (compatibilidad)', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  const stubDir = newStubDir();
  const replicaStub = join(stubDir, 'replica.ts');
  writeFileSync(replicaStub, STUB_REPLICA_REGISTRA_GOBERNADOR);
  const resumenStub = join(stubDir, 'resumen.ts');
  writeFileSync(resumenStub, STUB_RESUMEN_OK);
  try {
    const outcome = runBarrido(
      ['--replicas', '1', '--dias', '1', '--concurrencia', '1', '--timeout', '20', '--seed-base', '711', '--salida', salida],
      { CARTA_REPLICA_SCRIPT: replicaStub, CARTA_RESUMEN_SCRIPT: resumenStub },
    );
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    const replicaJson = JSON.parse(readFileSync(join(salida, 'base', 'seed-711', 'replica.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(replicaJson.gobernadorRecibido, null);
  } finally { rmSync(salida, { recursive: true, force: true }); rmSync(stubDir, { recursive: true, force: true }); }
});

test('barrido: --gobernador rechaza valores fuera de no|servidor', () => {
  const outcome = runBarrido(['--replicas', '1', '--dias', '1', '--gobernador', 'invalido']);
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /--gobernador/);
});
