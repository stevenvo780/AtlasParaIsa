// node --import tsx docs/evidencia-2026-09-22/t100-snapshot-benchmark.mjs COPIED_DB [REPORT_JSON]
// Read-only fixture; bounded encoder benchmark, not Store.save or server timing.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const instrument = fileURLToPath(import.meta.url), root = resolve(dirname(instrument), '../..');
if (!process.argv[2]) throw new Error('Usage: t100-snapshot-benchmark.mjs COPIED_DB [REPORT_JSON]');
const fixture = resolve(process.argv[2]), parent = 'f3d4c3c';
const mod = file => import(pathToFileURL(join(root, file)).href);
const { encodeSnapshot, decodeSnapshot, takeSnapshotParams } = await mod('src/server/snapshot.ts');
const { DEFAULT_PARAMS } = await mod('src/world/params.ts');
const { stringifyExact } = await mod('src/shared/exact-json.ts');
const checksum = value => createHash('sha256').update(value).digest('hex');
const db = new DatabaseSync(fixture, { readOnly: true });
let source;
try { source = db.prepare('SELECT body FROM snapshots WHERE slot=0').get().body; }
finally { db.close(); }
const world = decodeSnapshot(source), params = takeSnapshotParams(world);
const defaults = JSON.stringify(DEFAULT_PARAMS), exactDefaults = stringifyExact(DEFAULT_PARAMS);

// Parent f3d4c3c's encoding path, retained here as the reference under measurement.
function record(exactParams = false) {
  const tiles = world.tiles.map(t => {
    const row = [t.x,t.y,t.terrain,t.moisture,t.vegetation,t.food,t.biome,t.elevation,t.wood,t.stone,t.feature,
      t.variety,t.growth,t.fertility,t.cultivation,t.traffic,t.drinkingWater,t.species,t.fauna,t.life];
    for (let i = 6; i < row.length; i++) {
      const value = row[i];
      if (value === null || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid optional tile value. Snapshot was not written.');
    }
    return row;
  });
  const body = exactParams ? stringifyExact(params) : JSON.stringify(params);
  const result = { ...world, retiredChunks: [], retiredLegacy: [], tiles, tileEncoding: 'tiles-tuple-v1' };
  delete result.params; delete result.paramsEncoding;
  if (body !== (exactParams ? exactDefaults : defaults)) { result.paramsEncoding = 'params-v1'; result.params = params; }
  return result;
}
const variants = {
  parent: () => JSON.stringify(record()),
  globalReplacer: () => stringifyExact(record(true)),
  candidate: () => encodeSnapshot(world, params),
};
const reference = variants.parent();
// This control deliberately requires ordinary fixture bytes. Signed-zero behavior
// is covered by dedicated negative tests, not conflated with this performance A/B.
for (const run of Object.values(variants)) assert.equal(run(), reference);
for (let n = 0; n < 5; n++) for (const run of Object.values(variants)) run();
const samples = Object.fromEntries(Object.keys(variants).map(name => [name, []]));
for (let n = 0; n < 60; n++) {
  for (const name of n % 2 ? Object.keys(variants).reverse() : Object.keys(variants)) {
    const start = performance.now(), result = variants[name](); samples[name].push(performance.now() - start);
    assert.equal(result, reference);
  }
}
const percentile = (values, quantile) => [...values].sort((a,b) => a-b)[Math.floor((values.length - 1) * quantile)];
const files = ['src/server/snapshot.ts', 'src/shared/exact-json.ts', 'src/server/store.ts', 'src/world/lineage.ts'];
const report = {
  date: new Date().toISOString(), node: process.version, fixture, sourceBodySHA256: checksum(source),
  parentCommit: execFileSync('git', ['rev-parse', parent], { cwd: root, encoding: 'utf8' }).trim(),
  parentEncoderSHA256: checksum(execFileSync('git', ['show', `${parent}:src/server/snapshot.ts`], { cwd: root })),
  candidateFilesSHA256: Object.fromEntries(files.map(file => [file, checksum(readFileSync(join(root, file)))])),
  instrumentSHA256: checksum(readFileSync(instrument)),
  tiles: world.tiles.length, people: world.people.length, characters: reference.length,
  outputSHA256: checksum(reference), rounds: 60, allOrdinaryBytesEqual: true, sharedHost: true,
  scope: 'Encoder only, same readonly fixture, alternating variants; not server/save latency or a 2M gate.',
  results: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name,
    { medianMs: percentile(values, .5), p95Ms: percentile(values, .95), minMs: Math.min(...values) }])),
};
if (process.argv[3]) writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
