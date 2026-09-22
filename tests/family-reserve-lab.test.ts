import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cloneWorld, createWorld, stepWorld } from '../src/world/index.js';
import * as family from '../src/world/family.js';
import { FamilyObservation, familySample, roleActivity } from '../scripts/lab/family-observation.js';
import { classifyOutcome, prepare, verifyPlan } from '../scripts/lab/family-reserve-batch.js';

test('V8 paired plan fixes both arms, seeds, horizon, persistence and deadline, refusing altered contracts', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = resolve(root, 'artifacts/family-reserve-v8-20260922', `fixture-${randomUUID()}`);
  try {
    const batch = prepare(directory);
    assert.equal(batch.sources.baseline.originSha, '3dd615ee069d9d61f51a4c74f85d33c15a4583e0');
    assert.equal(batch.days, 13); assert.equal(batch.ticks, 31200); assert.equal(batch.workers, 6);
    assert.equal(batch.timeoutMs, 3600000); assert.equal(batch.params, 'persistencia.cadaTicks=20');
    assert.deepEqual(batch.jobs.map(j => j.id), ['baseline-1007', 'candidate-1007', 'baseline-1012', 'candidate-1012', 'baseline-1013', 'candidate-1013']);
    assert.match(readFileSync(resolve(batch.sources.baseline.root, 'src/world/index.ts'), 'utf8'), /RULES_VERSION = 7;/);
    assert.match(readFileSync(resolve(batch.sources.candidate.root, 'src/world/index.ts'), 'utf8'), /RULES_VERSION = 8;/);
    verifyPlan(batch);
    for (const changed of [{ ...batch, days: 14 }, { ...batch, workers: 7 }, { ...batch, timeoutMs: 3600001 },
      { ...batch, jobs: batch.jobs.map((j, i) => i === 0 ? { ...j, seed: 9999 } : j) }]) assert.throws(() => verifyPlan(changed));
    assert.throws(() => prepare(directory), /EEXIST/);
    assert.equal(classifyOutcome(0, { timedOut: true }), 'timeout');
    assert.equal(classifyOutcome(0, { invalidEvidence: true }), 'invalid-evidence');
    assert.equal(classifyOutcome(0, {}), 'success');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('external family observation preserves the complete seeded trajectory and never grants readiness', () => {
  const world = createWorld(1007), control = cloneWorld(world), observer = new FamilyObservation();
  for (let tick = 0; tick < 240; tick++) {
    const before = structuredClone(world); familySample(world, family); observer.begin(world);
    assert.deepEqual(world, before);
    stepWorld(world); observer.end(world); stepWorld(control);
  }
  assert.deepEqual(world, control);
  const result = observer.closeInterval(); assert.equal(result.firstExtinctionTick, null);
  world.people.forEach(p => { p.energy = 0; });
  assert.equal(familySample(world, family).completeLocalPairs, 0);
  assert.ok(familySample(world, family).neighbors.every(p => !p.ready && p.opportunityPartner === null));
});

test('durable role split includes deceased mortals, excludes failed and zero-benefit uses, and respects interval', () => {
  const db = new DatabaseSync(':memory:'), world = createWorld(); world.tick = 20;
  try {
    db.exec('CREATE TABLE technology_executions(serial INTEGER PRIMARY KEY,tick INTEGER,body TEXT)');
    const rows = [
      { actorId: 's', benefit: .4, tick: 12 }, { actorId: 'already-dead-neighbor', benefit: .6, tick: 13 },
      { actorId: 'i', benefit: 0, tick: 14 }, { actorId: 'neighbor-1', benefit: 2, tick: 10 },
      { actorId: 'neighbor-1', benefit: 2, tick: 21 }, { actorId: 'neighbor-1', benefit: 2, tick: 15, success: false },
    ];
    rows.forEach((row, i) => db.prepare('INSERT INTO technology_executions VALUES(?,?,?)').run(i, row.tick,
      JSON.stringify({ success: true, kind: 'use', recipeId: 'fixture', ...row })));
    assert.deepEqual(roleActivity(world, db, 10), { mortals: { uses: 1, benefit: .6 }, protected: { uses: 1, benefit: .4 } });
  } finally { db.close(); }
});
