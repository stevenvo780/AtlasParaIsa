/**
 * ¿Qué mueve el sello con el que el Store decide si reverificar TODO el archivo? (sprint noche-arch 2026-09-23)
 *
 *   TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/sello-sqlite.ts
 *
 * `flushTechnology` y `assertChronicleChanges` reutilizan la verificación de la carga sólo si
 * `PRAGMA data_version` (commits de OTRAS conexiones) y `total_changes()` (escrituras de ESTA conexión)
 * no se movieron desde el último guardado. Si se mueven, el guardado siguiente relee la línea base y
 * recorre el archivo de ejecuciones entero dos veces (medido: 120 s con 296 495 ejecuciones). Esto prueba,
 * sobre una base de juguete en `$TMPDIR`, qué operaciones reales del servicio lo mueven: un inicio de sesión
 * (`addSession` escribe `sessions` por la misma conexión), un guardado deshecho, un `revoke` desde otro
 * proceso (`npm run access`), el respaldo horario (`sqlite3 -readonly … VACUUM INTO`) y checkpoints ajenos.
 * Requiere el binario `sqlite3` (el mismo que usa `scripts/respaldo.sh`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp'))
  throw new Error('TMPDIR debe apuntar fuera de /tmp: TMPDIR=/datos/tmp-atlas-lab');
const dir = mkdtempSync(join(tmpdir(), 'atlas-sello-')), ruta = join(dir, 'w.sqlite');
const ajena = (...sql: string[]) => execFileSync('sqlite3', [...sql.slice(0, -1), ruta, sql.at(-1)!]);
try {
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);'
    + ' CREATE TABLE t (x); INSERT INTO t VALUES (1);');
  const sello = () => ({ dataVersion: Number((db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version),
    totalChanges: Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n) });
  const filas: { operacion: string; dataVersion: number; totalChanges: number; mueve: boolean }[] = [];
  let previo = sello();
  const anotar = (operacion: string) => {
    const actual = sello();
    filas.push({ operacion, ...actual, mueve: actual.dataVersion !== previo.dataVersion || actual.totalChanges !== previo.totalChanges });
    previo = actual;
  };
  anotar('inicio');
  db.exec("BEGIN; SELECT * FROM t; COMMIT;"); anotar('lectura propia en transacción');
  db.exec('DELETE FROM sessions WHERE expires <= 0'); db.exec("INSERT INTO sessions VALUES ('h', 1)");
  anotar('addSession (inicio de sesión: DELETE + INSERT por la misma conexión)');
  try { db.exec('BEGIN; INSERT INTO t VALUES (2); SELECT * FROM tabla_que_no_existe;'); }
  catch { db.exec('ROLLBACK'); }
  anotar('guardado deshecho (ROLLBACK tras un INSERT)');
  ajena('-readonly', `VACUUM INTO '${join(dir, 'copia.sqlite')}'`); anotar('respaldo horario: sqlite3 -readonly VACUUM INTO');
  ajena('-readonly', 'PRAGMA quick_check'); anotar('lectura ajena de solo lectura');
  db.exec('PRAGMA wal_checkpoint(PASSIVE)'); anotar('checkpoint propio');
  ajena('PRAGMA wal_checkpoint(PASSIVE)'); anotar('checkpoint PASSIVE de otra conexión');
  // TRUNCATE (o RESTART) reinicia el WAL: las demás conexiones lo ven como un cambio de la base.
  ajena('PRAGMA wal_checkpoint(TRUNCATE)'); anotar('checkpoint TRUNCATE de otra conexión (sin escribir datos)');
  ajena("DELETE FROM sessions WHERE hash='h'"); anotar('revoke desde otro proceso (npm run access)');
  db.close();
  console.table(filas);
} finally { rmSync(dir, { recursive: true, force: true }); }
