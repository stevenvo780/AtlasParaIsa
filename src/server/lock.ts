import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const leases = new Set<DatabaseSync>();
// Separate OS-managed lifetime lock: process death releases it; world revocation/backup remain available.
export function acquireLock(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lease = new DatabaseSync(path);
  try { lease.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS instance_lock (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;'); }
  catch { lease.close(); throw new Error('Another service instance is using this world.'); }
  leases.add(lease);
  let released = false;
  return () => { if (!released) { released = true; lease.exec('ROLLBACK'); lease.close(); leases.delete(lease); } };
}
