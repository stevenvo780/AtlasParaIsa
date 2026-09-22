import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { validationFixture } from './lib/validation-fixture.js';

// --baseline points to an immutable checkout of the previous validator.
const at = process.argv.indexOf('--baseline');
if (at < 0 || !process.argv[at + 1]) throw new Error('Expected --baseline <root>.');
const baseline = resolve(process.argv[at + 1]!);
const prior: typeof import('../src/world/index.js') = await import(pathToFileURL(join(baseline, 'src/world/index.ts')).href);
const validateOld = (world: unknown): void => prior.assertWorld(world, (world as { version: number }).version);
const validateCurrent = (world: unknown): void => assertWorld(world);
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
const measurements = [];
for (const population of [200, 800, 2000]) {
  const world = validationFixture(population), before = digestoCanonico(world);
  for (let round = 0; round < 3; round++) { validateOld(world); validateCurrent(world); }
  const old: number[] = [], current: number[] = [];
  for (let round = 0; round < 12; round++) {
    const runs = round % 2 === 0 ? [[validateOld, old], [validateCurrent, current]] as const
      : [[validateCurrent, current], [validateOld, old]] as const;
    for (const [validate, samples] of runs) { const start = performance.now(); validate(world); samples.push(performance.now() - start); }
  }
  if (digestoCanonico(world) !== before) throw new Error('Validation changed world state.');
  measurements.push({ population, bondsPerPerson: 64, oldMedianMs: median(old), currentMedianMs: median(current), old, current });
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
console.log(JSON.stringify({ scope: 'assertWorld, synthetic roster; no simulation, storage or population-growth claim',
  baselineIndex: sha(join(baseline, 'src/world/index.ts')), candidateIndex: sha(new URL('../src/world/index.ts', import.meta.url).pathname), measurements }, null, 2));
