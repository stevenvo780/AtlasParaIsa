import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validWorldInstanceId } from '../shared/world-instance.js';

/** Call only on the writable app store after its world has validated and saved.
 * Backups and recovery retain metadata; a fresh database gets a distinct ID. */
export function ensureWorldInstance(db: DatabaseSync): string {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT value FROM metadata WHERE key=?').get('world-instance-id') as { value: unknown } | undefined;
    if (row && !validWorldInstanceId(row.value)) throw new Error('Invalid world instance identity. Explicit recovery required.');
    const instanceId = row ? row.value as string : randomUUID();
    if (!row) db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('world-instance-id', instanceId);
    db.exec('COMMIT');
    return instanceId;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
