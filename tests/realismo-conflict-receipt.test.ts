import assert from 'node:assert/strict';
import test from 'node:test';
import { cloneWorld, tileAt, type World } from '../src/world/index.js';
import { resourceDispute } from '../src/world/society.js';
import { setParams, parseParams, DEFAULT_PARAMS } from '../src/world/params.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { beginObservationAttempt, bindObservation, createObservationSession, enterObservationPhase,
  markObservationAttempt, observedEvents, unbindObservation } from '../src/world/observation.js';
import { projectObservedEvents } from '../scripts/lab/realismo-observer.js';
import { aula } from './lib/escenas.js';

function emit(world: World) {
  return (event: Parameters<typeof recordChronicleEvent>[1]) => {
    const recorded = recordChronicleEvent(world, event);
    world.events.push(recorded);
    return recorded;
  };
}

for (const agreement of [false, true]) test(`C18 real ${agreement ? 'agreement' : 'dispute'} receipt preserves the world with observation on/off`, () => {
  const { world, maestro: a, aprendiz: b } = aula({ cuerpo: { energy: 0.9, fatigue: 0.1, hunger: 0.1, thirst: 0.1 },
    decisionAt: 999, vaciarMateriales: false, sinEncuentroReciente: false });
  a.action = b.action = 'drink';
  a.thirst = b.thirst = 0.95;
  a.culture.openness = b.culture.openness = 0.1;
  a.communityId = 'one'; b.communityId = 'two';
  a.bonds[b.id] = agreement ? 0.8 : 0.2;
  const source = tileAt(world, a)!;
  source.drinkingWater = 0.05;
  const sourceId = `${a.target.x},${a.target.y}`;
  setParams(world, parseParams('social.disputaNecesidad=0.65,social.disputaEscasez=1,social.disputaRadio=2,social.memoriaDisputa=8', DEFAULT_PARAMS));
  const without = cloneWorld(world);
  const withoutA = without.people.find(p => p.id === a.id)!;
  const session = createObservationSession({ runId: `c18-${agreement}`, epochId: 'e', sourceSHA: 'a'.repeat(40) });
  bindObservation(world, session);
  try {
    beginObservationAttempt(world, world.tick);
    enterObservationPhase(world, 'society');
    assert.equal(resourceDispute(world, a, emit(world)), true);
    markObservationAttempt(world, 'adopted');
    assert.equal(resourceDispute(without, withoutA, emit(without)), true);
    assert.deepEqual(world, without, 'observation must not change physical or historical World state');

    const events = observedEvents(session);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.siteId, agreement ? 'society.dispute-agreement' : 'society.dispute-conflict');
    const projected = projectObservedEvents(events, { gaps: session.gaps, attemptHistory: session.attemptHistory });
    assert.equal(projected.records.length, 1);
    assert.equal(projected.conflictSourceReceipts.length, 1);
    const record = projected.records[0]!;
    if (record.family !== 'conflict') assert.fail('the real dispute must project as conflict');
    assert.equal(record.payload.agreement, agreement);
    assert.equal(record.payload.memoryEnabled, true);
    assert.equal(record.payload.sourceId, sourceId);
    assert.equal(record.causalContext.sourceEventId, events[0]!.sourceEventId);
    assert.equal(events[0]!.eventOrdinal, 1);
    for (const field of ['needInputsRef', 'triggerLawRef', 'costRefs', 'consumptionRefs', 'recurrenceRefs', 'followupEndTick', 'eligibleOpportunityRefs'] as const) {
      assert.equal(Object.hasOwn(record.payload, field), false, `${field} needs distinct typed or future evidence`);
      assert.equal(record.fieldCoverage[field].status, 'missing');
    }
    const receipt = projected.conflictSourceReceipts[0]!;
    assert.equal(receipt.sourceEventId, events[0]!.sourceEventId);
    const detail = receipt.details as { rule: { memoriaDisputa: number; disputaNecesidad: number }; source: { stock: number; x: number; y: number };
      actors: Array<{ id: string; thirst: number; fatigue: number; socialLoad: number; trustTowardOther: number }>;
      costsAfter: Array<{ id: string; fatigue: number; socialLoad: number; trustTowardOther: number }>;
      selectedToYieldId: string; selectedToContinueId: string;
      cededOpportunity?: { actorId: string; action: string; decisionAt: number } };
    assert.equal(detail.rule.memoriaDisputa, 8);
    assert.equal(detail.rule.disputaNecesidad, 0.65);
    assert.deepEqual([detail.source.x, detail.source.y, detail.source.stock], [source.x, source.y, 0.05]);
    assert.deepEqual(detail.actors.map(p => p.id), [a.id, b.id], 'source actor order is preserved');
    assert.deepEqual(detail.costsAfter.map(p => p.id), [a.id, b.id]);
    assert.deepEqual(detail.actors.map(p => p.thirst), [0.95, 0.95]);
    assert.equal(detail.actors[0]!.fatigue, 0.1);
    assert.equal(detail.actors[0]!.trustTowardOther, agreement ? 0.8 : 0.2);
    if (agreement) {
      assert.equal(detail.costsAfter[0]!.fatigue, detail.actors[0]!.fatigue);
      assert.equal(detail.costsAfter[0]!.socialLoad, detail.actors[0]!.socialLoad);
      assert.ok(detail.costsAfter[0]!.trustTowardOther > detail.actors[0]!.trustTowardOther);
      assert.deepEqual(detail.cededOpportunity, { actorId: detail.selectedToYieldId, action: 'retreat', decisionAt: world.tick + 12 });
    } else {
      assert.equal(detail.cededOpportunity, undefined, 'retreat is applied after this receipt');
      assert.ok(detail.costsAfter.every((p, i) => p.fatigue > detail.actors[i]!.fatigue && p.socialLoad > detail.actors[i]!.socialLoad));
      assert.ok(detail.costsAfter[0]!.trustTowardOther < detail.actors[0]!.trustTowardOther);
    }
    assert.equal(tileAt(world, a)!.drinkingWater, 0.05, 'the episode itself grants no water');
    assert.ok(projected.modelGaps.some(gap => gap.includes('conflict-typed-refs-consumption-and-followup-unavailable')));
    assert.ok(Object.isFrozen(receipt.details) && Object.isFrozen(detail.actors[0]));
  } finally { unbindObservation(world); }
});
