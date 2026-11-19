import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CASES, SCHEMA, assess, parseMessage, type CaseEvidence } from './protocol.js';
import { encodeSqlValue, readDatabaseDigest } from './database-digest.js';

function fixture(c: typeof CASES[number]): CaseEvidence {
  return { caseId: c.id, reached: c.phase, killedByController: true, childExitSignal: 'SIGKILL',
    ackReceived: c.ack, recoveredResultMatches: c.committed, recoveredResultPresent: c.committed,
    recoveredTick: c.committed ? 1 : 0, expectedTick: c.committed ? 1 : 0,
    expectedFullDigest: 'a'.repeat(64), recoveredFullDigest: 'a'.repeat(64),
    independentPreKillRead: true, independentPostKillRead: true, sourcePinsUnchanged: true };
}
function scratch(): string {
  const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const owned = join(worktree, '.orchestration/c21-durabilidad-v1');
  const tmp = process.env.TMPDIR;
  if (!tmp || !realpathSync(tmp).startsWith(owned + sep)) throw new Error('OWNED_TMPDIR_REQUIRED');
  const path = mkdtempSync(join(tmp, 'c21-selfcheck-')); mkdirSync(join(path, 'artifacts'), { mode: 0o700 });
  return join(path, 'artifacts/fixture.sqlite'); // Keep own artifacts; never delete global temp or other jobs.
}
function initialize(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA application_id=1128354388; PRAGMA user_version=5; "
      + "CREATE TABLE snapshots(slot INTEGER PRIMARY KEY,body TEXT,digest TEXT,saved_at INTEGER); "
      + "CREATE TABLE history(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE sessions(hash TEXT,expires INTEGER); "
      + "INSERT INTO snapshots VALUES(0,'{\"tick\":0}','fixture',1); "
      + "INSERT INTO history VALUES('h1','retained mortal history');");
  } finally { db.close(); }
}
test('protocol fixtures cannot grant scientific acceptance for any crash phase', () => {
  for (const c of CASES) {
    const r = assess(fixture(c)); assert.equal(r.verdict, 'TECHNICAL_PASS');
    assert.equal(r.scope, 'STORE_API_PROCESS_CRASH_ONLY'); assert.equal(r.scientificAcceptance, false);
  }
});
test('ACK before commit and a lost acknowledged result are explicit contradictions', () => {
  assert.equal(assess({ ...fixture(CASES[0]), ackReceived: true }).verdict, 'FAIL');
  const r = assess({ ...fixture(CASES[3]), recoveredResultMatches: false, recoveredResultPresent: false });
  assert.equal(r.verdict, 'FAIL'); assert.ok(r.reasons.includes('RESULT_CHANGED_OR_LOST'));
});
test('unobserved cut/boundary remains UNKNOWN; missing data cannot become a zero-loss proof', () => {
  const r = assess({ ...fixture(CASES[2]), reached: null, independentPreKillRead: false,
    expectedFullDigest: null, killedByController: false, recoveredResultPresent: null,
    recoveredResultMatches: null, recoveredTick: null });
  assert.equal(r.verdict, 'UNKNOWN'); assert.ok(r.reasons.includes('FULL_DATABASE_CUT_UNOBSERVED'));
});
test('receipt bindings reject a mislabeled phase or non-Store ACK', () => {
  const receipt = { schema: SCHEMA, caseId: 'B01', sequence: 1, tick: 1,
    gestureId: 'c21-technical-B01', kind: 'boundary', phase: 'B02_AFTER_BEGIN', source: 'Store.save' };
  assert.throws(() => parseMessage(receipt), /BOUNDARY_CASE_MISMATCH/);
  assert.throws(() => parseMessage({ ...receipt, caseId: 'ACK01', kind: 'store-api-ack', phase: 'AFTER_ACK',
    resultBody: '{}', resultHash: 'a'.repeat(64) }), /NOT_A_STORE_API_ACK/);
});
test('full database digest detects lost history despite an identical resident snapshot', () => {
  const path = scratch(); initialize(path);
  const before = readDatabaseDigest(path), db = new DatabaseSync(path);
  try { db.exec("DELETE FROM history WHERE id='h1'"); } finally { db.close(); }
  const after = readDatabaseDigest(path);
  assert.equal(before.snapshotTick, after.snapshotTick);
  assert.notEqual(before.digest, after.digest);
  assert.equal(before.tables.find(t => t.name === 'snapshots')?.digest,
    after.tables.find(t => t.name === 'snapshots')?.digest);
});
test('digest includes sessions and newly discovered tables; repeated reads do not mutate the cut', () => {
  const path = scratch(); initialize(path); const before = readDatabaseDigest(path);
  assert.deepEqual(readDatabaseDigest(path), before);
  const db = new DatabaseSync(path);
  try {
    db.exec("INSERT INTO sessions VALUES('private-fixture-hash',123); CREATE TABLE extra(id INTEGER,data BLOB);");
    db.prepare('INSERT INTO extra VALUES(?,?)').run(9_007_199_254_740_993n, Buffer.from([0, 255]));
  } finally { db.close(); }
  const after = readDatabaseDigest(path);
  assert.notEqual(after.digest, before.digest); assert.ok(after.tables.some(t => t.name === 'extra'));
});
test('SQL digest encoding keeps storage type, bigint precision, float bits, and blob bytes', () => {
  assert.notEqual(encodeSqlValue(42n), encodeSqlValue('42'));
  assert.notEqual(encodeSqlValue(9_007_199_254_740_993n), encodeSqlValue(9_007_199_254_740_992n));
  assert.notEqual(encodeSqlValue(0), encodeSqlValue(-0));
  assert.notEqual(encodeSqlValue(Buffer.from([1, 2])), encodeSqlValue('0102'));
});
