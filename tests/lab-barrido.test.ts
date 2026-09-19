import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// T017 (scripts/lab/barrido.ts) depende de scripts/lab/replica.ts (T016) y scripts/lab/resumen.ts
// (T018): workstreams paralelos ajenos a esta tarea (regla 1 de tasks.md: "toca SOLO los ficheros
// listados en tu tarea"). Para probar la cola/concurrencia/timeout en aislamiento sin tocar los
// ficheros reales de T016/T018, las pruebas instalan un stub desechable de replica.ts solo si no
// existe ya uno real (nunca lo pisan) y lo borran siempre en el finally; si ya existe (T016
// integrado), la prueba se salta con t.skip(). La invocación final a resumen.ts es best-effort
// (T018 puede no existir todavía) y no debe bloquear ni hacer fallar el barrido en sí.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPLICA_PATH = join(ROOT, 'scripts/lab/replica.ts');
const BARRIDO = join(ROOT, 'scripts/lab/barrido.ts');

function runBarrido(args: string[], timeoutMs = 120_000) {
  return spawnSync(process.execPath, ['--import', 'tsx', BARRIDO, ...args], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs });
}

const STUB_OK =
  "import { mkdirSync, writeFileSync } from 'node:fs';\n" +
  "const args = process.argv.slice(2);\n" +
  "const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };\n" +
  "const salida = at('--salida'); if (!salida) throw new Error('stub: falta --salida');\n" +
  "mkdirSync(salida, { recursive: true });\n" +
  "writeFileSync(salida + '/replica.json', JSON.stringify({ seed: Number(at('--seed')), dias: Number(at('--dias')), params: at('--params') ?? '' }) + '\\n');\n";

const STUB_SLOW =
  "process.on('SIGTERM', () => process.exit(1));\n" +
  "setTimeout(() => { console.log('no debería llegar aquí: --timeout debe matar antes'); }, 5000);\n";

function withReplicaStub<T>(source: string, run: () => T): T | undefined {
  if (existsSync(REPLICA_PATH)) return undefined; // T016 ya integrado: nunca se pisa el fichero real.
  mkdirSync(dirname(REPLICA_PATH), { recursive: true });
  writeFileSync(REPLICA_PATH, source);
  try { return run(); } finally { rmSync(REPLICA_PATH, { force: true }); }
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

test('barrido: falta --timeout falla con código de salida distinto de cero y mensaje claro', () => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  try {
    const result = runBarrido(['--replicas', '1', '--dias', '1', '--salida', salida]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--timeout/);
  } finally { rmSync(salida, { recursive: true, force: true }); }
});

test('barrido: 3 réplicas × 1 día con concurrencia 2 termina y encola todo', (t) => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  try {
    const outcome = withReplicaStub(STUB_OK, () => runBarrido([
      '--replicas', '3', '--dias', '1', '--concurrencia', '2', '--timeout', '20', '--seed-base', '500', '--salida', salida,
    ]));
    if (outcome === undefined) { t.skip('scripts/lab/replica.ts ya existe (T016 integrado); prueba de aislamiento omitida.'); return; }
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    const log = readFileSync(join(salida, 'progreso.log'), 'utf8');
    const jobLines = log.trim().split('\n').filter(line => line.includes('job='));
    assert.equal(jobLines.length, 3, 'una línea de progreso por réplica encolada');
    assert.ok(jobLines.every(line => line.includes('estado=ok')), 'las 3 réplicas del stub terminan ok');
    assert.ok(jobLines.some(line => line.includes('(100.0%)')), 'el progreso llega a 100%');
    for (const seed of [500, 501, 502]) {
      assert.ok(existsSync(join(salida, 'base', `seed-${seed}`, 'replica.json')), `falta el directorio de la réplica seed-${seed}`);
    }
  } finally { rmSync(salida, { recursive: true, force: true }); }
});

test('barrido: una réplica que supera --timeout se mata y queda "abortada", sin bloquear el resto', (t) => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  try {
    const outcome = withReplicaStub(STUB_SLOW, () => runBarrido([
      '--replicas', '1', '--dias', '1', '--concurrencia', '1', '--timeout', '1', '--seed-base', '900', '--salida', salida,
    ]));
    if (outcome === undefined) { t.skip('scripts/lab/replica.ts ya existe (T016 integrado); prueba de aislamiento omitida.'); return; }
    assert.notEqual(outcome.status, 0, 'el barrido refleja en su código de salida que hubo una réplica abortada');
    const log = readFileSync(join(salida, 'progreso.log'), 'utf8');
    assert.match(log, /estado=abortada/);
  } finally { rmSync(salida, { recursive: true, force: true }); }
});

test('barrido: --param con varios valores produce el producto cartesiano de trabajos', (t) => {
  const salida = mkdtempSync(join(tmpdir(), 'carta-barrido-'));
  try {
    const outcome = withReplicaStub(STUB_OK, () => runBarrido([
      '--replicas', '1', '--dias', '1', '--concurrencia', '2', '--timeout', '20', '--seed-base', '10', '--param', 'demo.k=a,b', '--salida', salida,
    ]));
    if (outcome === undefined) { t.skip('scripts/lab/replica.ts ya existe (T016 integrado); prueba de aislamiento omitida.'); return; }
    assert.equal(outcome.status, 0, `barrido.ts falló: ${outcome.stderr}`);
    assert.ok(existsSync(join(salida, 'demo.k=a', 'seed-10', 'replica.json')));
    assert.ok(existsSync(join(salida, 'demo.k=b', 'seed-10', 'replica.json')));
  } finally { rmSync(salida, { recursive: true, force: true }); }
});
