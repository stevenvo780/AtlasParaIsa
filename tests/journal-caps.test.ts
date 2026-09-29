import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, assertWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import {
  recordChronicleEvent, chronicleJournalPendingCount, chronicleJournalNearCapacity,
  MAX_PENDING_CHRONICLE_EVENTS, CHRONICLE_JOURNAL_COMMIT_THRESHOLD, type ChronicleHost,
} from '../src/world/chronicle-journal.js';
import {
  technologyJournalPendingCount, technologyJournalNearCapacity,
  MAX_PENDING_TECHNOLOGY_EXECUTIONS, TECHNOLOGY_JOURNAL_COMMIT_THRESHOLD,
} from '../src/world/technology-journal.js';
import { appendTechnologyExecution } from '../src/world/technology-execution.js';
import type { TechnologyState } from '../src/shared/technology.js';
import { laboratorio } from './lib/store.js';

/**
 * sprint/journal-caps-20260929. Reproduce, sin las 38 días reales, el fallo de
 * `CUPO20-8103.log` (3 775 vecinos, `persistencia.cadaTicks=300`): el diario de tecnología (y,
 * con el mismo patrón, el de crónica) moría con «journal is full» mucho antes de los 65 536
 * pendientes que hoy admite. Ambas pruebas de bulto usan recibos/eventos sintéticos, sin
 * físico ni recursos, para acumular volumen barato — el punto es el TOPE, no la jugabilidad
 * (mismo espíritu que `scripts/lab/t100-escala-procesos.mts`, que fabrica su mundo grande
 * directamente en vez de simularlo desde cero).
 */
const OLD_TECHNOLOGY_CAP = 65_536;
const OLD_CHRONICLE_CAP = 32_768;

function noopExecution() {
  return {
    kind: 'research' as const, actorId: 'synthetic', recipeId: null, programSignature: '',
    inputs: [], outputs: [], residueMass: 0, energy: 0, work: 0, success: true,
    parentRecipeIds: [], catalysts: [], benefit: 0,
    balance: { opening: [], closing: [], externalInputs: [], externalLoss: [] },
  };
}
function chronicleObservation() {
  return { kind: 'ecology' as const, actors: [], text: 'Synthetic backlog observation.', cause: 'journal-caps test fixture.', source: 'simulation' as const };
}

test('the two new caps stay above the old ones, in the old 2:1 ratio', () => {
  assert.ok(MAX_PENDING_TECHNOLOGY_EXECUTIONS > OLD_TECHNOLOGY_CAP);
  assert.ok(MAX_PENDING_CHRONICLE_EVENTS > OLD_CHRONICLE_CAP);
  assert.equal(MAX_PENDING_TECHNOLOGY_EXECUTIONS, MAX_PENDING_CHRONICLE_EVENTS * 2);
});

test('technology journal: more than 65 536 pending receipts no longer kills the host, and the Store commits and reloads it coherently', t => {
  const { store } = laboratorio(t, 'atlas-journal-caps-tech-');
  const world = createWorld(4242);
  store.save(world); // bootstrap: attaches the journal, same as replica.ts before its first tick.
  // The opening checkpoint anchors at tick 0; every execution after it must land on a strictly
  // later tick (`assertTechnologyCheckpoint`'s whole-tick boundary rule), so run one real tick
  // first (as replica.ts does) instead of hand-forging `world.tick`, which would desync
  // `person.demography.age` and fail `assertPopulation` on reload.
  stepWorld(world);
  assertWorld(world);
  const target = OLD_TECHNOLOGY_CAP + 5_000;
  assert.doesNotThrow(() => {
    for (let n = 0; n < target; n++) appendTechnologyExecution(world, noopExecution());
  }, 'a pending count above the OLD cap must not throw "Technology journal is full" anymore');
  assert.equal(technologyJournalPendingCount(world.technology), target);
  assert.equal(technologyJournalNearCapacity(world.technology), false,
    'far below the new cap: the host should not need an early commit here');
  store.save(world); // used to be unreachable at this backlog size; must now succeed.
  assert.equal(technologyJournalPendingCount(world.technology), 0, 'a successful commit always empties the queue');
  const reloaded = store.load();
  assert.ok(reloaded, 'the Store must still produce a committed world');
  assert.equal(digestoCanonico(reloaded!.world), digestoCanonico(world));
  assert.deepEqual(reloaded!.world, world);
});

test('chronicle journal: more than 65 536 pending events no longer kills the host, and the Store commits and reloads it coherently', t => {
  const { store } = laboratorio(t, 'atlas-journal-caps-chronicle-');
  const world = createWorld(4343);
  store.save(world);
  const target = OLD_TECHNOLOGY_CAP + 5_000; // > both old caps, per the task's literal ">65 536".
  assert.doesNotThrow(() => {
    for (let n = 0; n < target; n++) {
      const event = recordChronicleEvent(world, chronicleObservation());
      world.events.push(event); if (world.events.length > 120) world.events.shift();
    }
  }, 'a pending count above the OLD cap must not throw "Chronicle journal is full" anymore');
  assert.equal(chronicleJournalPendingCount(world), target);
  assert.equal(chronicleJournalNearCapacity(world), false);
  store.save(world);
  assert.equal(chronicleJournalPendingCount(world), 0);
  const reloaded = store.load();
  assert.ok(reloaded);
  assert.equal(digestoCanonico(reloaded!.world), digestoCanonico(world));
  assert.deepEqual(reloaded!.world, world);
});

test('technologyJournalNearCapacity flags the queue exactly at its 75% threshold, not before', () => {
  const below: TechnologyState = { journal: { pending: { length: TECHNOLOGY_JOURNAL_COMMIT_THRESHOLD - 1 } } } as unknown as TechnologyState;
  const at: TechnologyState = { journal: { pending: { length: TECHNOLOGY_JOURNAL_COMMIT_THRESHOLD } } } as unknown as TechnologyState;
  const disabled: TechnologyState = { journal: undefined } as unknown as TechnologyState;
  assert.equal(technologyJournalNearCapacity(below), false);
  assert.equal(technologyJournalNearCapacity(at), true);
  assert.equal(technologyJournalNearCapacity(disabled), false, 'a host without a journal attached never needs an early commit');
});

test('chronicleJournalNearCapacity flags the queue exactly at its 75% threshold, not before', () => {
  const below: ChronicleHost = { tick: 0, eventCounter: 0, events: [], chronicleJournal: { pending: { length: CHRONICLE_JOURNAL_COMMIT_THRESHOLD - 1 } } } as unknown as ChronicleHost;
  const at: ChronicleHost = { tick: 0, eventCounter: 0, events: [], chronicleJournal: { pending: { length: CHRONICLE_JOURNAL_COMMIT_THRESHOLD } } } as unknown as ChronicleHost;
  const disabled: ChronicleHost = { tick: 0, eventCounter: 0, events: [], chronicleJournal: undefined };
  assert.equal(chronicleJournalNearCapacity(below), false);
  assert.equal(chronicleJournalNearCapacity(at), true);
  assert.equal(chronicleJournalNearCapacity(disabled), false);
});
