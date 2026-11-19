import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { LIMITS } from './protocol.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
/** Preserve SQLite storage types, bigint precision, float bits, and blobs. */
export function encodeSqlValue(value: SQLOutputValue): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return 'integer:' + value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NONFINITE_SQL_VALUE');
    const b = Buffer.alloc(8); b.writeDoubleBE(value); return 'real:' + b.toString('hex');
  }
  if (typeof value === 'string') return 'text:' + JSON.stringify(value);
  return 'blob:' + Buffer.from(value).toString('hex');
}
export interface DatabaseDigest {
  schema: 'c21-full-logical-sqlite/v1'; digest: string; schemaDigest: string;
  applicationId: string; userVersion: string;
  tables: { name: string; columns: string[]; rows: number; digest: string }[];
  encodedBytes: number; snapshotTick: number | null;
  coverage: 'ALL_SQLITE_TABLES_ALL_COLUMNS_IN_ONE_READ_TRANSACTION';
  excludes: ['WAL_FILE_LAYOUT', 'POWER_LOSS_GUARANTEE'];
}
/** Opens readonly and closes the connection. No Store caches or projections define the oracle. */
export function readDatabaseDigest(path: string): DatabaseDigest {
  const db = new DatabaseSync(path, { readOnly: true });
  let encodedBytes = 0, rowCount = 0;
  const encodedRows = (sql: string): string[] => {
    const statement = db.prepare(sql); statement.setReadBigInts(true);
    const result: string[] = [];
    for (const row of statement.iterate()) {
      const encoded = JSON.stringify(Object.entries(row).map(([key, value]) => [key, encodeSqlValue(value)]));
      encodedBytes += Buffer.byteLength(encoded); rowCount++;
      if (encodedBytes > LIMITS.databaseEncodedBytes || rowCount > LIMITS.databaseRows)
        throw new Error('DATABASE_DIGEST_BUDGET_EXCEEDED');
      result.push(encoded);
    }
    return result.sort();
  };
  try {
    db.exec('BEGIN');
    const schemaRows = encodedRows('SELECT type,name,tbl_name,sql FROM sqlite_schema');
    const schemaDigest = hash(JSON.stringify(schemaRows));
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    const tables = names.map(row => {
      if (typeof row.name !== 'string') throw new Error('UNKNOWN_TABLE_NAME');
      const name = row.name;
      const info = db.prepare('SELECT name FROM pragma_table_xinfo(?) ORDER BY cid').all(name);
      const columns = info.map(c => {
        if (typeof c.name !== 'string') throw new Error('UNKNOWN_COLUMN'); return c.name;
      });
      if (!columns.length) throw new Error('NO_COLUMNS');
      const rows = encodedRows(`SELECT ${columns.map(quote).join(',')} FROM ${quote(name)}`);
      return { name, columns, rows: rows.length, digest: hash(JSON.stringify(rows)) };
    });
    const applicationId = String(db.prepare('PRAGMA application_id').get()?.application_id);
    const userVersion = String(db.prepare('PRAGMA user_version').get()?.user_version);
    const snapshot = db.prepare('SELECT body FROM snapshots WHERE slot=0').get();
    let snapshotTick: number | null = null;
    if (typeof snapshot?.body === 'string') {
      const body: unknown = JSON.parse(snapshot.body);
      if (body && typeof body === 'object' && 'tick' in body && Number.isSafeInteger(body.tick))
        snapshotTick = Number(body.tick);
      // A paged snapshot may place tick in a Store envelope; Store.load is the semantic check.
    }
    const digest = hash(JSON.stringify({ schemaDigest, applicationId, userVersion, tables }));
    db.exec('ROLLBACK');
    return { schema: 'c21-full-logical-sqlite/v1', digest, schemaDigest, applicationId, userVersion,
      tables, encodedBytes, snapshotTick, coverage: 'ALL_SQLITE_TABLES_ALL_COLUMNS_IN_ONE_READ_TRANSACTION',
      excludes: ['WAL_FILE_LAYOUT', 'POWER_LOSS_GUARANTEE'] };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
