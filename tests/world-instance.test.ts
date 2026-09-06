import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { ensureWorldInstance } from '../src/server/world-instance.js';
import { validWorldInstanceId } from '../src/shared/world-instance.js';
import { readWorldVisit, saveWorldVisit } from '../src/client/visit-memory.js';

function memory() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test('world identity survives close, backup and previous recovery; a fresh world with the same seed differs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-world-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'world.sqlite');
  let store = new Store(path);
  const world = createWorld(51926); store.save(world);
  const before = JSON.stringify(world), id = ensureWorldInstance(store.db);
  assert.ok(validWorldInstanceId(id)); assert.equal(JSON.stringify(world), before);
  assert.equal(ensureWorldInstance(store.db), id);
  stepWorld(world, [], store.context); store.save(world);
  store.backup(join(dir, 'backup.sqlite'));
  store.previous(join(dir, 'previous.sqlite'));
  store.close(); store = new Store(path);
  try { assert.equal(ensureWorldInstance(store.db), id); assert.equal(store.load()!.world.tick, 1); }
  finally { store.close(); }
  for (const name of ['backup.sqlite', 'previous.sqlite']) {
    const copy = new Store(join(dir, name), { readOnly: true });
    try {
      assert.equal(copy.db.prepare('SELECT value FROM metadata WHERE key=?').get('world-instance-id')?.value, id);
      assert.equal(copy.load()!.world.tick, name === 'backup.sqlite' ? 1 : 0);
    } finally { copy.close(); }
  }
  const fresh = new Store(join(dir, 'fresh.sqlite'));
  try { fresh.save(createWorld(51926)); assert.notEqual(ensureWorldInstance(fresh.db), id); assert.equal(fresh.load()!.world.tick, 0); }
  finally { fresh.close(); }
});

test('malformed durable identity is rejected without replacing it or touching snapshots', () => {
  const store = new Store(':memory:');
  try {
    store.save(createWorld(42));
    store.db.prepare('INSERT INTO metadata VALUES(?,?)').run('world-instance-id', 'broken');
    const before = store.db.prepare('SELECT * FROM snapshots').all();
    assert.throws(() => ensureWorldInstance(store.db), /Explicit recovery required/);
    assert.equal(store.db.isTransaction, false);
    assert.equal(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('world-instance-id')?.value, 'broken');
    assert.deepEqual(store.db.prepare('SELECT * FROM snapshots').all(), before);
  } finally { store.close(); }
});

test('app startup with malformed identity preserves the previous checkpoint and all durable rows', () => {
  const store = new Store(':memory:');
  try {
    const world = createWorld(42); store.save(world);
    stepWorld(world, [], store.context); store.save(world);
    store.db.prepare('INSERT INTO metadata VALUES(?,?)').run('world-instance-id', 'broken');
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const rows = () => tables.map(name => ({ name, rows: store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }));
    const before = rows();
    assert.throws(() => createApp({ store, password: 'synthetic-identity-test-only', origin: 'http://127.0.0.1:3000', manual: true }), /Invalid world instance identity/);
    assert.equal(store.db.isTransaction, false);
    assert.deepEqual(rows(), before, 'startup must not rotate tick0 out of the recovery slot before refusing tick1');
  } finally { store.close(); }
});

test('visit provenance separates fresh worlds and retains restarts, without attributing legacy or future bookmarks', () => {
  const storage = memory();
  const a = { instanceId: '11111111-1111-4111-8111-111111111111', tick: 300 };
  const b = { instanceId: '22222222-2222-4222-8222-222222222222', tick: 300 };
  storage.setItem('carta:last-visit', '299');
  assert.equal(readWorldVisit(storage, a), null);
  saveWorldVisit(storage, a);
  assert.equal(readWorldVisit(storage, { ...a, tick: 400 }), 300);
  assert.equal(readWorldVisit(storage, b), null);
  assert.equal(readWorldVisit(storage, { ...a, tick: 200 }), null);
  assert.equal(readWorldVisit(storage, { tick: 400 }), null);
  saveWorldVisit(storage, { ...b, tick: 0 });
  assert.equal(readWorldVisit(storage, b), 0);
  assert.equal(readWorldVisit(storage, a), null);
  assert.equal(storage.values.size, 2, 'one bounded new bookmark plus the untouched legacy entry');
});

test('invalid or denied browser storage cannot break entry and never claims an observed visit', () => {
  const storage = memory(), world = { instanceId: '11111111-1111-4111-8111-111111111111', tick: 10 };
  for (const raw of ['oops', 'null', '[]', '{}', '9', 'x'.repeat(300), ...[-1, 0.5, 1e99, '4'].map(tick => JSON.stringify({ version: 1, instanceId: world.instanceId, tick }))]) {
    storage.setItem('carta:last-visit-v2', raw); assert.equal(readWorldVisit(storage, world), null);
  }
  const denied = { getItem(): string | null { throw new Error('denied'); }, setItem(): void { throw new Error('quota'); } };
  assert.equal(readWorldVisit(denied, world), null); assert.doesNotThrow(() => saveWorldVisit(denied, world));
  const before = [...storage.values]; saveWorldVisit(storage, { ...world, instanceId: 'broken' });
  assert.deepEqual([...storage.values], before);
});
