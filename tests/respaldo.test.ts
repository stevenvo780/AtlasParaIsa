import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
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
  return spawnSync('bash', [SCRIPT], { env: { ...process.env, RESPALDO_TIMEOUT_SEGUNDOS: '10', ...env }, encoding: 'utf8', timeout: 20_000 });
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

test('respaldo.sh solo LEE el mundo original con WAL pendiente y sin conexión viva (servidor caído a mitad de escritura)', async (t: TestContext) => {
  const { db, dest } = fixture(t);
  // Un `store.close()` normal hace checkpoint y borra el -wal (node:sqlite), lo que dejaría
  // este test incapaz de refutar nada: no habría WAL pendiente que el respaldo pudiera tocar.
  // Para reproducir el escenario de riesgo real (servidor caído, sin ninguna conexión viva,
  // con escrituras aún en el -wal) se escribe desde un proceso hijo y se mata con SIGKILL
  // antes de que pueda cerrar limpiamente — mismo patrón que el test de crash de
  // tests/server.test.ts ("actual crash releases instance lock...").
  const storeUrl = pathToFileURL(resolve('src/server/store.ts')).href;
  const worldUrl = pathToFileURL(resolve('src/world/index.ts')).href;
  const code = `import { Store } from ${JSON.stringify(storeUrl)}; import { createWorld } from ${JSON.stringify(worldUrl)}; const s = new Store(${JSON.stringify(db)}); s.save(createWorld(70402)); console.log('guardado'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [data] = await once(child.stdout, 'data');
    assert.match(data.toString(), /guardado/);
    child.kill('SIGKILL');
    await once(child, 'exit');

    assert.ok(existsSync(`${db}-wal`), 'el fixture debe dejar un -wal pendiente para que el test pueda refutar el requisito');
    const before = readFileSync(db);

    const result = run({ DB: db, DEST: dest });
    assert.equal(result.status, 0, result.stderr);
    // Comparación por igualdad de bytes (no assert.deepEqual): si el respaldo checkpointeara
    // el origen, ambos buffers difieren mucho en tamaño y el diff de deepEqual sobre buffers
    // grandes puede tardar minutos; Buffer.compare falla rápido con un mensaje igual de claro.
    assert.equal(Buffer.compare(readFileSync(db), before), 0, 'el respaldo solo debe LEER el mundo original (bytes distintos: hizo un checkpoint)');
    assert.ok(existsSync(`${db}-wal`), 'el respaldo no debe checkpointear/borrar el -wal ajeno (eso sería una escritura)');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
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

test('respaldo.sh conserva rutas con apóstrofes y contenido real, con permisos privados', (t: TestContext) => {
  const { directory } = fixture(t), db = join(directory, "mundo de Isa's.sqlite");
  const dest = join(directory, "copias de Isa'; SELECT 'literal'; --");
  const source = new DatabaseSync(db);
  source.exec('CREATE TABLE recuerdo(id INTEGER PRIMARY KEY, texto TEXT NOT NULL)');
  source.prepare('INSERT INTO recuerdo VALUES(?,?)').run(1, "Una ruta con ' sigue siendo una ruta.");
  source.close();
  const before = readFileSync(db), result = run({ DB: db, DEST: dest });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.compare(readFileSync(db), before), 0, 'el origen no se reescribe');
  const copies = readdirSync(dest);
  assert.equal(copies.length, 1, 'no queda una copia parcial o un directorio temporal');
  const compressed = join(dest, copies[0]!);
  assert.equal(statSync(dest).mode & 0o777, 0o700); assert.equal(statSync(compressed).mode & 0o777, 0o600);
  const decoded = join(directory, 'decoded.sqlite'); writeFileSync(decoded, gunzipSync(readFileSync(compressed)));
  const copy = new DatabaseSync(decoded, { readOnly: true });
  try {
    assert.equal(copy.prepare('PRAGMA quick_check').get()!['quick_check'], 'ok');
    assert.equal(copy.prepare('SELECT texto FROM recuerdo WHERE id=1').get()!['texto'], "Una ruta con ' sigue siendo una ruta.");
  } finally { copy.close(); }
});

test('respaldo.sh termina con un escritor WAL vivo y conserva la atomicidad de sus transacciones', async (t: TestContext) => {
  const { directory, db, dest } = fixture(t);
  const code = `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(db)});
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE pares(id INTEGER PRIMARY KEY,n INTEGER); INSERT INTO pares VALUES(1,0),(2,0); CREATE TABLE bloques(data BLOB)');
    const insert = db.prepare('INSERT INTO bloques VALUES(?)');
    db.exec('BEGIN'); for(let i=0;i<256;i++) insert.run(Buffer.alloc(4096,i%256)); db.exec('COMMIT');
    const write = () => db.exec('BEGIN IMMEDIATE; UPDATE pares SET n=n+1 WHERE id=1; UPDATE pares SET n=n+1 WHERE id=2; COMMIT');
    write(); const timer=setInterval(write,2); console.log('escritor listo');
    process.on('SIGTERM',()=>{clearInterval(timer);db.close();process.exit(0);});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [data] = await once(child.stdout, 'data'); assert.match(data.toString(), /escritor listo/);
    assert.ok(existsSync(`${db}-wal`));
    const result = run({ DB: db, DEST: dest }); assert.equal(result.status, 0, result.stderr);
    assert.equal(child.exitCode, null, 'el respaldo debe terminar sin detener al escritor');
    const compressed = readdirSync(dest).find(name => name.endsWith('.sqlite.gz'))!;
    const decoded = join(directory, 'decoded.sqlite'); writeFileSync(decoded, gunzipSync(readFileSync(join(dest, compressed))));
    const copy = new DatabaseSync(decoded, { readOnly: true });
    try {
      const values = copy.prepare('SELECT n FROM pares ORDER BY id').all() as { n: number }[];
      assert.equal(values.length, 2); assert.equal(values[0]!.n, values[1]!.n, 'ninguna transacción queda partida en la copia');
      assert.ok(values[0]!.n >= 1); assert.equal(copy.prepare('SELECT count(*) AS n FROM bloques').get()!['n'], 256);
      assert.equal(copy.prepare('PRAGMA quick_check').get()!['quick_check'], 'ok');
    } finally { copy.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  }
});

test('respaldo.sh informa el timeout sin modificar el origen ni rotar respaldos existentes', (t: TestContext) => {
  const { db, dest } = fixture(t), source = new DatabaseSync(db);
  source.exec('CREATE TABLE hechos(id INTEGER PRIMARY KEY); INSERT INTO hechos VALUES(1)');
  mkdirSync(dest);
  const previous = gzipSync(readFileSync(db)), names = ['world-20200101-0000.sqlite.gz', 'world-20200102-0000.sqlite.gz'];
  for (const name of names) writeFileSync(join(dest, name), previous);
  const before = readFileSync(db);
  // Read bytes before taking the POSIX lock: opening/closing this same inode in
  // the lock-owning process would release SQLite's advisory lock on Linux.
  source.exec('BEGIN EXCLUSIVE; INSERT INTO hechos VALUES(2)');
  try {
    const result = run({ DB: db, DEST: dest, RETENCION: '1', RESPALDO_TIMEOUT_SEGUNDOS: '1' });
    assert.equal(result.status, 124, result.stderr); assert.match(result.stderr, /agotar 1s/);
    assert.deepEqual(readdirSync(dest).sort(), names, 'un timeout no publica parciales ni aplica retención');
    for (const name of names) assert.equal(Buffer.compare(readFileSync(join(dest, name)), previous), 0);
    assert.equal(Buffer.compare(readFileSync(db), before), 0);
  } finally { source.exec('ROLLBACK'); source.close(); }
});

test('respaldo.sh rechaza desbordamientos y parámetros fuera de rango antes de copiar o borrar', (t: TestContext) => {
  const { db, dest } = fixture(t), source = new DatabaseSync(db);
  source.exec('CREATE TABLE hechos(id INTEGER PRIMARY KEY); INSERT INTO hechos VALUES(1)'); source.close();
  mkdirSync(dest);
  const before = readFileSync(db), previous = gzipSync(before);
  const names = ['world-20200101-0000.sqlite.gz', 'world-20200102-0000.sqlite.gz'];
  for (const name of names) writeFileSync(join(dest, name), previous);
  for (const [key, values] of Object.entries({
    RETENCION: ['18446744073709551615', '9223372036854775807', '1000001', '0', '-1', '01', '1e3'],
    RESPALDO_TIMEOUT_SEGUNDOS: ['18446744073709551615', '86401', '0', '-1', '01', '1e3'],
  })) {
    for (const value of values) {
      const result = run({ DB: db, DEST: dest, [key]: value });
      assert.equal(result.status, 1, `${key}=${value}: ${result.stderr}`);
      assert.ok(result.stderr.includes(`${key} debe ser un entero entre`));
      assert.deepEqual(readdirSync(dest).sort(), names, `${key}=${value} no debe copiar ni rotar`);
      for (const name of names) assert.equal(Buffer.compare(readFileSync(join(dest, name)), previous), 0);
      assert.equal(Buffer.compare(readFileSync(db), before), 0);
    }
  }
  const boundary = run({ DB: db, DEST: dest, RETENCION: '1000000', RESPALDO_TIMEOUT_SEGUNDOS: '86400' });
  assert.equal(boundary.status, 0, boundary.stderr);
  assert.equal(readdirSync(dest).length, 3, 'los límites documentados son válidos y preservan copias');
});
