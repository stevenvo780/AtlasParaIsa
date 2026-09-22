import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { generateChunk } from '../src/world/terrain.js';
import { demographicTraits } from '../src/world/demography.js';
import { parseParams } from '../src/world/params.js';

const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
for (const paged of [false, true]) for (const corruption of ['none', 'chunk-checksum', 'chunk-semantic', 'old-chunk-checksum', 'legacy-checksum', 'legacy-semantic'] as const) {
  test(`backup validates every lazy archive record after copying: ${corruption}, paged=${paged}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-backup-lazy-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = join(directory, 'world.sqlite'), target = join(directory, 'copy.sqlite');
    const store = new Store(source, { snapshotInlineTileLimit: paged ? 0 : 32768 });
    try {
      const world = createWorld(51926, parseParams('persistencia.ventanaEventosTicks=0'));
      const chunk = generateChunk(world.seed, -4, 7), founder = world.people.find(person => person.role === 'neighbor')!;
      world.retiredChunks.push(chunk);
      const record = { id: 'backup-archive-fixture', name: 'Archivo', role: 'neighbor' as const, generation: 0, parents: [],
        bornAt: founder.bornAt, diedAt: world.tick, cause: 'exposure' as const, genome: structuredClone(founder.genome),
        traits: demographicTraits(founder.genome), communityId: null };
      world.retiredLegacy.push(record);
      world.demographyDynamics.deaths++; world.demographyDynamics.causes.exposure++;
      store.save(world);
      stepWorld(world);
      world.retiredChunks.push(structuredClone(chunk));
      store.save(world);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()!.n, 2);
      assert.ok(store.load()); assert.ok(store.loadChunk(chunk.key, 0)); assert.ok(store.loadLegacy(record.id));
      const boundary = join(directory, 'boundary.json'), hook = join(directory, 'after-preload.mts');
      writeFileSync(hook, `
import { Store } from ${JSON.stringify(new URL('../src/server/store.ts', import.meta.url).href)};
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const backup = Store.prototype.backup;
Store.prototype.backup = function(destination) {
  const mode = ${JSON.stringify(corruption)}, source = ${JSON.stringify(source)};
  const writer = new DatabaseSync(source);
  try {
    if (mode !== 'none') {
      const table = mode.startsWith('legacy') ? 'legacy' : 'chunks';
      const tick = mode === 'old-chunk-checksum' || table === 'legacy' ? 0 : 1;
      const row = writer.prepare('SELECT rowid,body FROM ' + table + ' WHERE tick=?').get(tick);
      const value = JSON.parse(row.body);
      if (table === 'chunks') value.tiles[0].food = mode.endsWith('semantic') ? -1 : 0.987654321;
      else value.cause = mode.endsWith('semantic') ? 'invalid' : 'dehydration';
      const body = JSON.stringify(value);
      if (mode.endsWith('semantic')) writer.prepare('UPDATE ' + table + ' SET body=?,digest=? WHERE rowid=?')
        .run(body, createHash('sha256').update(body).digest('hex'), row.rowid);
      else writer.prepare('UPDATE ' + table + ' SET body=? WHERE rowid=?').run(body, row.rowid);
    }
  } finally { writer.close(); }
  const sourceHash = hash(source), walHash = hash(source + '-wal');
  const result = backup.call(this, destination);
  writeFileSync(${JSON.stringify(boundary)}, JSON.stringify({sourceHash,walHash,copyHash:hash(destination)}));
  return result;
};
`);
      const cli = spawnSync(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(hook).href,
        fileURLToPath(new URL('../scripts/storage.ts', import.meta.url)), 'backup', target],
      { env: { ...process.env, CARTA_DATA_DIR: directory }, encoding: 'utf8', timeout: 30000 });
      assert.equal(cli.error, undefined); assert.equal(cli.signal, null);
      const bytes = JSON.parse(readFileSync(boundary, 'utf8')) as {sourceHash: string; walHash: string; copyHash: string};
      assert.equal(hash(source), bytes.sourceHash); assert.equal(hash(source + '-wal'), bytes.walHash);
      assert.equal(hash(target), bytes.copyHash, 'validation preserves the completed evidence');
      assert.equal(statSync(target).mode & 0o777, 0o600);
      const copied = new Store(target, { readOnly: true });
      try {
        assert.equal(copied.db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
        assert.ok(copied.load(), 'the loaded world alone does not exercise these lazy records');
        if (corruption === 'none') {
          assert.ok(copied.loadChunk(chunk.key, 0)); assert.ok(copied.loadChunk(chunk.key, 1));
          assert.ok(copied.loadLegacy(record.id));
        } else if (corruption.startsWith('legacy')) assert.throws(() => copied.loadLegacy(record.id));
        else assert.throws(() => copied.loadChunk(chunk.key, corruption === 'old-chunk-checksum' ? 0 : 1));
      } finally { copied.close(); }
      assert.equal(cli.status, corruption === 'none' ? 0 : 1, cli.stderr || 'lazy corruption must not be certified');
      if (corruption === 'none') assert.match(cli.stdout, /Copia coherente creada/);
      else assert.doesNotMatch(cli.stdout, /Copia coherente creada/);
    } finally { store.close(); }
  });
}
