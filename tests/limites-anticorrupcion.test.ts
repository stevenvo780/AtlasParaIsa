import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWorld, createWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { decodeSnapshot, encodeSnapshot, takeSnapshotParams, SnapshotSemanticError } from '../src/server/snapshot.js';
import { Store } from '../src/server/store.js';

function wideWorld(): World {
  const world = createWorld(51926, parseParams('limites.teselasActivas=65792,limites.chunks=257,limites.comunidades=12'));
  const template = world.tiles.find(tile => tile.terrain === 'meadow')!;
  for (let cx = 100; Object.keys(world.chunks).length < 257; cx++) {
    const cy = 100, key = `${cx},${cy}`;
    world.chunks[key] = { key, cx, cy, discovered: false, places: [], lastTick: 0 };
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++)
      world.tiles.push({ ...template, x: cx * 16 + x, y: cy * 16 + y, fauna: 0, species: undefined });
  }
  return world;
}
const checksum = (body: string): string => createHash('sha256').update(body).digest('hex');
function tables(store: Store): string {
  const names = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
  const hash = createHash('sha256');
  for (const { name } of names) hash.update(name).update(JSON.stringify(store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()));
  return hash.digest('hex');
}

test('T100: 65792 teselas y 257 chunks conservan el digesto confirmado al reabrir SQLite', t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-limits-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const world = wideWorld(), path = join(directory, 'world.sqlite');
  assert.equal(world.tiles.length, 65792); assert.equal(Object.keys(world.chunks).length, 257);
  assertWorld(world);
  const store = new Store(path);
  let digest: string;
  try {
    store.save(world); digest = digestoCanonico(world);
    const manifest = JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body);
    assert.equal(manifest.snapshotEncoding, 'snapshot-parts-v1');
    assert.deepEqual(manifest.world.limitsProfile, { version: 1, ...paramsOf(world).limites });
  } finally { store.close(); }
  const reopened = new Store(path);
  try { assert.equal(digestoCanonico(reopened.load()!.world), digest); }
  finally { reopened.close(); }
});

test('T100: doce comunidades son admisibles sin cambiar la ley de fundación', () => {
  const world = createWorld(51926, parseParams('limites.comunidades=12'));
  world.communities = Array.from({ length: 12 }, (_, index) => ({ id: `test-${index}`, name: `Grupo ${index}`, x: 17, y: 13,
    color: '#ffffff', members: [], culture: { sharing: 0, stewardship: 0, openness: 0 }, formedAt: 0, cooperation: 0, disputes: 0 }));
  const store = new Store(':memory:');
  try { store.save(world); assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world)); }
  finally { store.close(); }
});

for (const key of ['teselasActivas', 'chunks', 'comunidades', 'fauna'] as const) {
  test(`T100: ${key} acepta el borde y rechaza una unidad más sin escritura`, () => {
    const world = createWorld(), store = new Store(':memory:');
    if (key === 'comunidades') world.communities = [0, 1].map(index => ({ id: `test-${index}`, name: 'Grupo', x: 17, y: 13,
      color: '#ffffff', members: [], culture: { sharing: 0, stewardship: 0, openness: 0 }, formedAt: 0, cooperation: 0, disputes: 0 }));
    const count = key === 'teselasActivas' ? world.tiles.length : key === 'chunks' ? Object.keys(world.chunks).length
      : key === 'comunidades' ? world.communities.length : world.animals.length;
    const params = parseParams({ limites: { [key]: count } }); setParams(world, params);
    try {
      store.save(world); assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
      const before = tables(store);
      setParams(world, parseParams({ limites: { [key]: count - 1 } }, params));
      assert.throws(() => assertWorld(world)); assert.throws(() => store.save(world));
      assert.equal(tables(store), before); assert.equal(store.db.isTransaction, false);
    } finally { store.close(); }
  });
}

for (const paged of [false, true]) for (const corruption of ['unknown', 'partial', 'contradiction', 'extra', 'legacy version'] as const) {
  test(`T100: perfil ${corruption}, ${paged ? 'páginas' : 'inline'}, falla cerrado con checksum válido`, () => {
    const world = createWorld(), store = new Store(':memory:', { snapshotInlineTileLimit: paged ? 0 : 32768 });
    try {
      store.save(world);
      const value = JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body);
      const metadata = paged ? value.world : value;
      metadata.limitsProfile = { version: 1, ...DEFAULT_PARAMS.limites };
      if (corruption === 'unknown') metadata.limitsProfile.version = 2;
      if (corruption === 'partial') delete metadata.limitsProfile.fauna;
      if (corruption === 'contradiction') metadata.limitsProfile.chunks++;
      if (corruption === 'extra') metadata.limitsProfile.hostRam = 1;
      if (corruption === 'legacy version') metadata.version = 4;
      const body = JSON.stringify(value);
      store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, checksum(body));
      const before = tables(store);
      assert.throws(() => store.load(), SnapshotSemanticError);
      assert.throws(() => store.save(world), SnapshotSemanticError);
      assert.equal(tables(store), before); assert.equal(store.db.isTransaction, false);
    } finally { store.close(); }
  });
}

test('T100: snapshot sin perfil no evade bounds históricos mediante params amplios', () => {
  const world = wideWorld(), value = JSON.parse(encodeSnapshot(world, paramsOf(world)));
  delete value.limitsProfile;
  assert.throws(() => decodeSnapshot(JSON.stringify(value)), SnapshotSemanticError);
  value.version = 4;
  assert.throws(() => decodeSnapshot(JSON.stringify(value)), SnapshotSemanticError);
});

test('T100: perfil exacto desaparece del World y los defaults siguen siendo deterministas', () => {
  const world = createWorld(), before = digestoCanonico(world), body = encodeSnapshot(world, paramsOf(world));
  assert.deepEqual(JSON.parse(body).limitsProfile, { version: 1, ...DEFAULT_PARAMS.limites });
  const value = decodeSnapshot(body) as World, params = takeSnapshotParams(value); setParams(value, params);
  assert.equal(Object.hasOwn(value, 'limitsProfile'), false);
  assert.equal(digestoCanonico(value), before); assert.equal(params, DEFAULT_PARAMS);
});
