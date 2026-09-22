import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd(), sha = value => createHash('sha256').update(value).digest('hex');
const mod = path => import(pathToFileURL(path).href);
const parentSource = execFileSync('git', ['show', 'cc83409:src/server/snapshot.ts'], { encoding: 'utf8' });
const candidateSource = readFileSync('src/server/snapshot.ts', 'utf8');
const directory = mkdtempSync(join(tmpdir(), 'atlas-required-finite-'));
try {
  const parentPath = join(directory, 'parent.mts');
  writeFileSync(parentPath, parentSource.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
    (_all, before, relative, after) => `${before}${pathToFileURL(resolve(root, 'src/server', relative)).href}${after}`));
  const parent = (await mod(parentPath)).encodeSnapshot;
  const candidate = (await mod(join(root, 'src/server/snapshot.ts'))).encodeSnapshot;
  const { Store } = await mod(join(root, 'src/server/store.ts'));
  const { paramsOf } = await mod(join(root, 'src/world/params.ts'));
  const store = new Store(process.argv[2], { readOnly: true });
  let world;
  try { world = store.load().world; } finally { store.close(); }
  const params = paramsOf(world), reference = parent(world, params), samples = { parent: [], candidate: [] }, load = loadavg();
  for (let round = -5; round < 40; round++) for (const [name, encode] of round % 2 ? [['candidate', candidate], ['parent', parent]] : [['parent', parent], ['candidate', candidate]]) {
    const start = performance.now(), body = encode(world, params), ms = performance.now() - start;
    assert.equal(body, reference);
    if (round >= 0) samples[name].push(ms);
  }
  assert.equal(readFileSync('src/server/snapshot.ts', 'utf8'), candidateSource);
  const distribution = values => { const sorted = [...values].sort((a, b) => a - b); return { median: (sorted[19] + sorted[20]) / 2, p95: sorted[38] }; };
  const report = { parent: execFileSync('git', ['rev-parse', 'cc83409'], { encoding: 'utf8' }).trim(), parentSourceHash: sha(parentSource),
    candidateSourceHash: sha(candidateSource), instrumentHash: sha(readFileSync(new URL(import.meta.url))),
    fixture: process.argv[2], tick: world.tick, tiles: world.tiles.length, bytes: Buffer.byteLength(reference), bodyHash: sha(reference),
    rounds: 40, warmups: 5, timings: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, distribution(values)])), samples, load,
    limits: 'Encoder only, shared host, alternating same verified real-world state; no saveMs/server/2M claim.' };
  writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.timings));
} finally { rmSync(directory, { recursive: true, force: true }); }
