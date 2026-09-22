import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/server/store.js';
import { encodeSnapshot } from '../src/server/snapshot.js';
import { paramsOf } from '../src/world/params.js';

const arg = (key: string) => { const at = process.argv.indexOf(key); if (at < 0 || !process.argv[at + 1]) throw new Error(`Missing ${key}`); return resolve(process.argv[at + 1]!); };
const baseline = await import(pathToFileURL(join(arg('--baseline'), 'src/server/snapshot.ts')).href) as typeof import('../src/server/snapshot.js');
const store = new Store(arg('--database'), { readOnly: true });
try {
  const world = store.load()!.world, params = paramsOf(world), reference = baseline.encodeSnapshot(world, params);
  assert.equal(encodeSnapshot(world, params), reference);
  for (let n = 0; n < 10; n++) { baseline.encodeSnapshot(world, params); encodeSnapshot(world, params); }
  const old: number[] = [], current: number[] = [];
  for (let n = 0; n < 80; n++) {
    const runs = n % 2 ? [[baseline.encodeSnapshot, old], [encodeSnapshot, current]] as const
      : [[encodeSnapshot, current], [baseline.encodeSnapshot, old]] as const;
    for (const [encode, samples] of runs) { const start = performance.now(); const body = encode(world, params); samples.push(performance.now() - start); assert.equal(body, reference); }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  console.log(JSON.stringify({ scope: 'encoding only, same real saved world, alternating runs; excludes SQLite',
    tick: world.tick, tiles: world.tiles.length, population: world.people.length, bytes: Buffer.byteLength(reference),
    sha256: createHash('sha256').update(reference).digest('hex'), oldMedianMs: median(old), currentMedianMs: median(current), old, current }, null, 2));
} finally { store.close(); }
