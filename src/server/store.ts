import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Gesture, GestureResult } from '../shared/types.js';
import { assertWorld, type World } from '../world/index.js';

const checksum = (s: string) => createHash('sha256').update(s).digest('hex');
export const fingerprint = (g: Gesture) => checksum(JSON.stringify([g.kind, g.x, g.y, g.memoryId ?? null]));
type Row = { body: string; digest: string; saved_at: number };
export class GestureConflict extends Error {}
export class SessionRevoked extends Error {}
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string, options: { readOnly?: boolean } = {}) {
    const existed = path !== ':memory:' && existsSync(path);
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (existed) {
      try {
        const marker = this.db.prepare('PRAGMA application_id').get() as { application_id: number };
        const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
        if (marker.application_id !== 1128354388 || version.user_version !== 1) throw new Error('Unrecognized database or schema version. Explicit recovery required.');
        const tables: Record<string, string[]> = {
          snapshots: ['slot','body','digest','saved_at'], events: ['id','tick','body'],
          inputs: ['id','fingerprint','tick','ordinal','body','result'], sessions: ['hash','expires'], metadata: ['key','value'],
        };
        for (const [table, columns] of Object.entries(tables)) {
          const actual = (this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row => row.name);
          if (JSON.stringify(actual) !== JSON.stringify(columns)) throw new Error('Database schema is incomplete. Explicit recovery required.');
        }
      } catch (error) { this.db.close(); throw error; }
    }
    if (options.readOnly) return;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    if (!existed) this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (slot INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, saved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, tick INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, tick INTEGER NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!existed) this.db.exec('PRAGMA application_id=1128354388; PRAGMA user_version=1;');
  }
  load(): { world: World; savedAt: number } | null {
    const check = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
    if (Object.values(check)[0] !== 'ok') throw new Error('SQLite integrity check failed. Explicit recovery required.');
    const row = this.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=0').get() as Row | undefined;
    if (!row) {
      const initialized = this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get();
      if (initialized) throw new Error('Snapshot missing from initialized database. Explicit recovery required.');
      return null;
    }
    if (checksum(row.body) !== row.digest) throw new Error('Snapshot checksum mismatch. Explicit recovery required.');
    const world: unknown = JSON.parse(row.body);
    assertWorld(world);
    return { world, savedAt: row.saved_at };
  }
  save(world: World, inputs: { gesture: Gesture; result: GestureResult }[] = [], requiredSessions: string[] = []): void {
    const body = JSON.stringify(world);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Authorization and commit share a transaction with respect to external revocation.
      if (requiredSessions.some(hash => !this.sessionValid(hash))) throw new SessionRevoked('Session revoked before commit.');
      this.db.exec('INSERT OR REPLACE INTO snapshots SELECT 1,body,digest,saved_at FROM snapshots WHERE slot=0');
      this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (0,?,?,?)').run(body, checksum(body), Date.now());
      this.db.prepare("INSERT OR REPLACE INTO metadata VALUES ('initialized','1')").run();
      const insertEvent = this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?)');
      for (const event of world.events) insertEvent.run(event.id, event.tick, JSON.stringify(event));
      const insertInput = this.db.prepare('INSERT INTO inputs VALUES (?,?,?,?,?,?)');
      for (const { gesture, result } of inputs) insertInput.run(gesture.id, fingerprint(gesture), result.tick, result.order, JSON.stringify(gesture), JSON.stringify(result));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  result(gesture: Gesture): GestureResult | null {
    const row = this.db.prepare('SELECT fingerprint,result FROM inputs WHERE id=?').get(gesture.id) as { fingerprint: string; result: string } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint(gesture)) throw new GestureConflict('Ese identificador ya se usó para otro gesto.');
    return JSON.parse(row.result) as GestureResult;
  }
  addSession(hash: string, expires: number) {
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(hash, expires);
  }
  sessionValid(hash: string): boolean {
    const row = this.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(hash) as { expires: number } | undefined;
    return !!row && row.expires > Date.now();
  }
  revoke(hash?: string) {
    if (hash) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash);
    else this.db.exec('DELETE FROM sessions');
  }
  backup(destination: string) {
    if (existsSync(destination)) throw new Error('Backup destination exists; choose a new path.');
    mkdirSync(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
    this.db.prepare('VACUUM INTO ?').run(resolve(destination));
  }
  previous(destination: string) {
    const row = this.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=1').get() as Row | undefined;
    if (!row || checksum(row.body) !== row.digest) throw new Error('No valid previous checkpoint.');
    const world: unknown = JSON.parse(row.body); assertWorld(world);
    this.backup(destination);
    const recovered = new Store(destination);
    try {
      recovered.db.exec('BEGIN IMMEDIATE');
      recovered.db.prepare('UPDATE snapshots SET body=?,digest=?,saved_at=? WHERE slot=0').run(row.body,row.digest,row.saved_at);
      recovered.db.prepare('DELETE FROM inputs WHERE tick>?').run(world.tick);
      recovered.db.prepare('DELETE FROM events WHERE tick>?').run(world.tick);
      for (const event of recovered.db.prepare('SELECT id FROM events WHERE tick=?').all(world.tick) as {id:string}[]) {
        if (!world.events.some(e => e.id === event.id)) recovered.db.prepare('DELETE FROM events WHERE id=?').run(event.id);
      }
      recovered.revoke(); recovered.db.exec('COMMIT'); recovered.load();
    } catch (error) { if (recovered.db.isTransaction) recovered.db.exec('ROLLBACK'); throw error; }
    finally { recovered.close(); }
  }
  close() { this.db.close(); }
}
