import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTechnology, defaultTechnologyState, initialTechnologyKnowledge, recordTechnologyBenefit,
  researchTechnology, technologyWorkCost, useTool, type TechnologyActor, type TechnologyHost,
  type TechnologyProgram } from '../src/world/technology.js';
import { assertTechnologyJournal, enableTechnologyJournal, markTechnologyJournalCommitted,
  technologyStateForCommit } from '../src/world/technology-journal.js';

function scene(journal = true): TechnologyHost {
  const actor: TechnologyActor = { id: 'a', x: 0, y: 0, energy: 1, fatigue: 0,
    materials: { wood: 12, stone: 8 }, skills: {}, technology: initialTechnologyKnowledge() };
  const host: TechnologyHost = { seed: 51926, tick: 0, people: [actor], technology: defaultTechnologyState() };
  if (journal) enableTechnologyJournal(host.technology);
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 4000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
  actor.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: 0 };
  while (actor.technology.project) { host.tick++; researchTechnology(host, actor); }
  assert.equal(actor.technology.items.length, 1);
  return host;
}
function useMany(host: TechnologyHost, count: number) {
  const receipts = [];
  for (let n = 0; n < count; n++) {
    const receipt = useTool(host, host.people[0]!, 'cutting', 0.01);
    assert.ok(receipt); receipts.push(receipt);
  }
  return receipts;
}

test('one tick preserves 700 physical receipts outside the recent ring and their final benefit after a clone', () => {
  let host = scene(); host.tick++;
  const first = useMany(host, 1)[0]!;
  host = structuredClone(host);
  useMany(host, 699);
  assert.equal(host.technology.history.length, 256);
  assert.equal(host.technology.journal!.pending.length, 701);
  assert.equal(host.technology.history.some(execution => execution.id === first.executionId), false);
  recordTechnologyBenefit(host, host.people[0]!, first, 0.25);
  const retained = host.technology.journal!.pending.find(execution => execution.id === first.executionId)!;
  assert.equal(retained.benefit, 0.25);
  assert.equal(host.technology.recipes[0]!.utility, 0.25);
  const recent = host.technology.history.at(-1)!;
  assert.equal(host.technology.journal!.pending.at(-1), recent, 'cloning must retain shared references within the draft');
  assertTechnology(host);
});

test('preparing a commit leaves the retry queue and watermark unchanged until explicit success', () => {
  const host = scene(); useMany(host, 3);
  const before = structuredClone(host.technology.journal);
  const prepared = technologyStateForCommit(host.technology);
  assert.deepEqual(host.technology.journal, before);
  assert.equal(prepared.journal!.pending.length, 0);
  assert.equal(prepared.journal!.committedThrough, host.technology.executionCounter);
  assert.equal(prepared.journal!.startsAfter, 0);
  assertTechnology({ ...host, technology: prepared });
  markTechnologyJournalCommitted(host.technology);
  assert.equal(host.technology.journal!.pending.length, 0);
  assert.equal(host.technology.journal!.committedThrough, host.technology.executionCounter);
  host.tick++; useMany(host, 1);
  assert.equal(host.technology.journal!.pending.length, 1);
  assertTechnology(host);
});

test('receipt benefits cannot rewrite an already committed observation or its recipe statistics', () => {
  const host = scene(), receipt = useMany(host, 1)[0]!;
  recordTechnologyBenefit(host, host.people[0]!, receipt, 0.125);
  markTechnologyJournalCommitted(host.technology);
  const before = structuredClone(host);
  assert.throws(() => recordTechnologyBenefit(host, host.people[0]!, receipt, 0.5), /committed technology receipt/);
  assert.deepEqual(host, before);
});

test('enabling an older host records exactly its surviving receipts and an explicit missing prefix', () => {
  const host = scene(false); host.tick++; useMany(host, 700);
  assert.equal(host.technology.journal, undefined);
  const dropped = host.technology.historyDropped;
  assert.ok(dropped > 0);
  enableTechnologyJournal(host.technology);
  assert.equal(host.technology.journal!.startsAfter, dropped);
  assert.equal(host.technology.journal!.committedThrough, dropped);
  assert.equal(host.technology.journal!.pending.length, 256);
  assert.equal(host.technology.journal!.pending[0], host.technology.history[0]);
  const initial = host.technology.journal;
  enableTechnologyJournal(host.technology);
  assert.equal(host.technology.journal, initial);
  assertTechnology(host);
});

test('physical corruption in a pending receipt evicted from the visible ring is still rejected', () => {
  const host = scene(); host.tick++; useMany(host, 700);
  const receipt = host.technology.journal!.pending[1]!;
  assert.equal(host.technology.history.some(execution => execution.id === receipt.id), false);
  receipt.balance.closing[0]!.mass++;
  assert.throws(() => assertTechnology(host), /tecnología física inválido/);
});

test('journal validation rejects gaps, mismatched duplicate observations, time reversal and false watermarks', () => {
  const original = scene(); original.tick++; useMany(original, 5);
  const mutations = [
    (host: TechnologyHost) => { host.technology.journal!.pending.splice(1, 1); },
    (host: TechnologyHost) => { host.technology.journal!.committedThrough++; },
    (host: TechnologyHost) => { host.technology.journal!.startsAfter = 1000; },
    (host: TechnologyHost) => { host.technology.journal!.pending[0]!.tick = host.tick + 1; },
    (host: TechnologyHost) => { host.technology.journal!.pending[1]!.tick = 0; },
    (host: TechnologyHost) => { host.technology.journal!.pending[0]!.id = 'process-01'; },
    (host: TechnologyHost) => { delete host.technology.journal!.pending[1]; },
    (host: TechnologyHost) => {
      host.technology.journal!.pending = structuredClone(host.technology.journal!.pending);
      host.technology.journal!.pending.at(-1)!.benefit = 0.25;
    },
  ];
  for (const mutate of mutations) {
    const host = structuredClone(original); mutate(host);
    assert.throws(() => assertTechnologyJournal(host.technology, host.tick), /technology journal coverage/);
  }
});

test('journaling preserves the same physical simulation and receipts without granting stock or knowledge', () => {
  const recorded = scene(), control = scene(false);
  for (let n = 0; n < 320; n++) {
    for (const host of [recorded, control]) {
      host.tick++;
      const receipt = useMany(host, 1)[0]!;
      recordTechnologyBenefit(host, host.people[0]!, receipt, 0.001);
    }
    if (n % 17 === 0) markTechnologyJournalCommitted(recorded.technology);
  }
  delete recorded.technology.journal;
  assert.deepEqual(recorded, control);
  assertTechnology(recorded); assertTechnology(control);
});
