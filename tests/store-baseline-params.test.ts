import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { encodeSnapshot } from '../src/server/snapshot.js';
import { createWorld } from '../src/world/index.js';
import { paramsOf, parseParams } from '../src/world/params.js';
import { filaInstantanea, reescribirInstantanea, sha256 } from './lib/store.js';

function rows(store: Store): unknown {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]);
}
type SnapshotRecord = { params: { agua: { cuencas: number }; [key: string]: unknown }; paramsEncoding?: string };
function rewrite(store: Store, change: (value: SnapshotRecord) => void): void {
  const row = filaInstantanea(store);
  const value = JSON.parse(row.body); change(value); const body = JSON.stringify(value);
  reescribirInstantanea(store, body);
}
const corruptions: [string, (value: SnapshotRecord) => void][] = [
  ['out of range', value => { value.params.agua.cuencas = 9; }],
  ['unknown law', value => { value.params.unknown = { field: 1 }; }],
  ['missing encoding', value => { delete value.paramsEncoding; }],
  ['unknown encoding', value => { value.paramsEncoding = 'params-future'; }],
];

for (const [label, corrupt] of corruptions) test(`saving cannot repair invalid baseline parameters: ${label}`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const world = createWorld(51926, parseParams('agua.cuencas=0.8'));
  store.save(world);
  rewrite(store, corrupt);
  const before = rows(store), candidate = structuredClone(world);
  assert.throws(() => store.save(world), /Invalid snapshot parameter/);
  assert.deepEqual(rows(store), before, 'rollback preserves all durable tables');
  assert.deepEqual(world, candidate, 'rejected save does not rewrite the candidate');
});

for (const origin of [false, true]) for (const invalid of [false, true]) {
  test(`pre-journal recovery validates the newer snapshot laws (origin=${origin}, invalid=${invalid})`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-baseline-params-'));
    const store = new Store(join(directory, 'original.sqlite'));
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    const params = parseParams('agua.cuencas=0.8,persistencia.cadaTicks=20');
    const old = createWorld(51926, params); delete old.chronicleJournal;
    const body = encodeSnapshot(old, params);
    assert.equal(old.technology.journal, undefined);
    for (const event of old.events) store.db.prepare('INSERT INTO events VALUES (?,?,?)').run(event.id, event.tick, JSON.stringify(event));
    store.db.prepare('INSERT INTO snapshots VALUES (0,?,?,?)').run(body, sha256(body), 1);
    store.db.prepare("INSERT INTO metadata VALUES ('initialized','1')").run();
    if (origin) store.save(old); // Keeps the genuine pre-journal checkpoint in slot 1.
    else store.db.prepare('INSERT INTO snapshots VALUES (1,?,?,?)').run(body, sha256(body), 1);
    if (invalid) rewrite(store, value => { value.params.agua.cuencas = 9; });
    const before = rows(store), destination = join(directory, 'previous.sqlite');
    if (invalid) assert.throws(() => store.previous(destination), /Invalid snapshot parameters/);
    else {
      assert.equal(store.previous(destination), 1);
      const recovered = new Store(destination, { readOnly: true });
      try { assert.deepEqual(paramsOf(recovered.load()!.world), params); }
      finally { recovered.close(); }
    }
    assert.deepEqual(rows(store), before, 'recovery never modifies the original');
  });
}
