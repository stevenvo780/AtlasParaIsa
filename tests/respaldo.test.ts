import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Store } from '../src/server/store.js';
import { createWorld } from '../src/world/index.js';

const SCRIPT = resolve('scripts/respaldo.sh');

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-respaldo-'));
  const db = join(directory, 'world.sqlite'), dest = join(directory, 'backups');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, db, dest };
}

function run(env: Record<string, string>) {
  return spawnSync('bash', [SCRIPT], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

test('respaldo.sh produce una copia que Store abre y load() acepta', (t: TestContext) => {
  const { db, dest } = fixture(t);
  const store = new Store(db); const world = createWorld(70401); store.save(world); store.close();

  const result = run({ DB: db, DEST: dest });
  assert.equal(result.status, 0, result.stderr);

  const files = readdirSync(dest).filter(name => /^world-\d{8}-\d{4}\.sqlite\.gz$/.test(name));
  assert.equal(files.length, 1, `esperaba una copia comprimida, encontré: ${readdirSync(dest).join(', ')}`);

  const decompressed = join(dest, 'decoded.sqlite');
  writeFileSync(decompressed, gunzipSync(readFileSync(join(dest, files[0]!))));
  const copy = new Store(decompressed, { readOnly: true });
  try {
    const loaded = copy.load();
    assert.ok(loaded, 'Store.load() debe aceptar la copia');
    assert.equal(loaded!.world.people.length, world.people.length);
    assert.equal(loaded!.world.tick, world.tick);
  } finally { copy.close(); }
});

test('respaldo.sh verifica quick_check y no deja el mundo original tocado', (t: TestContext) => {
  const { db, dest } = fixture(t);
  const store = new Store(db); const world = createWorld(70402); store.save(world); store.close();
  const before = readFileSync(db);

  const result = run({ DB: db, DEST: dest });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(db), before, 'el respaldo solo debe LEER el mundo original');
});

test('respaldo.sh falla explícitamente si la base de datos no existe (sin rescates ocultos)', (t: TestContext) => {
  const { db, dest } = fixture(t);
  const result = run({ DB: db, DEST: dest });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no existe la base de datos/);
  assert.throws(() => readdirSync(dest));
});

test('respaldo.sh aplica la retención: conserva solo las últimas RETENCION copias', (t: TestContext) => {
  const { db, dest } = fixture(t);
  const store = new Store(db); const world = createWorld(70403); store.save(world); store.close();
  mkdirSync(dest, { recursive: true });

  const antiguas = 7;
  const ahora = Date.now();
  for (let i = 0; i < antiguas; i++) {
    const path = join(dest, `world-dummy-${String(i).padStart(2, '0')}.sqlite.gz`);
    writeFileSync(path, 'contenido de prueba, no es sqlite real');
    // La más nueva (i=0) es la más reciente; cada una 1 hora más vieja que la anterior.
    const t2 = (ahora - (i + 1) * 3_600_000) / 1000;
    utimesSync(path, t2, t2);
  }

  const result = run({ DB: db, DEST: dest, RETENCION: '5' });
  assert.equal(result.status, 0, result.stderr);

  const restantes = readdirSync(dest).filter(name => name.endsWith('.sqlite.gz'));
  assert.equal(restantes.length, 5, `esperaba 5 copias tras la retención, quedaron: ${restantes.join(', ')}`);
  // La copia recién creada y las 4 más nuevas de las antiguas deben sobrevivir.
  assert.ok(restantes.some(name => /^world-\d{8}-\d{4}\.sqlite\.gz$/.test(name)));
  for (let i = 0; i < 4; i++) assert.ok(restantes.includes(`world-dummy-${String(i).padStart(2, '0')}.sqlite.gz`));
  for (let i = 4; i < antiguas; i++) assert.ok(!restantes.includes(`world-dummy-${String(i).padStart(2, '0')}.sqlite.gz`));
});

test('respaldo.sh sin RETENCION explícita no borra si hay menos de 48 copias', (t: TestContext) => {
  const { db, dest } = fixture(t);
  const store = new Store(db); const world = createWorld(70404); store.save(world); store.close();
  mkdirSync(dest, { recursive: true });
  for (let i = 0; i < 3; i++) writeFileSync(join(dest, `world-dummy-${i}.sqlite.gz`), 'x');

  const result = run({ DB: db, DEST: dest });
  assert.equal(result.status, 0, result.stderr);

  const restantes = readdirSync(dest).filter(name => name.endsWith('.sqlite.gz'));
  assert.equal(restantes.length, 4);
});
