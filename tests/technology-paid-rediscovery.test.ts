import test from 'node:test';
import assert from 'node:assert/strict';
import { beginObservationAttempt, bindObservation, createObservationSession, endObservationAttempt,
  observationSession, observedEvents, unbindObservation } from '../src/world/observation.js';
import { bindTechnologyCatalogue, enableTechnologyCatalogue, resolveTechnologyRecipe } from '../src/world/technology-catalogue.js';
import { inspectRediscoveryCensus, paidRediscoveryPayload } from '../src/world/technology-rediscovery.js';
import { defaultTechnologyState, initialTechnologyKnowledge, programSignature, researchTechnology,
  settleTechnologyEstate, technologyWorkCost, type TechnologyActor, type TechnologyHost, type TechnologyProgram } from '../src/world/technology.js';
import { cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { tileAt } from '../src/world/spatial.js';
import { proyectoInvestigacion } from './lib/escenas.js';

const edge: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
  steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
const other: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }],
  steps: [{ op: 'form', intensity: 4, shape: 'rod' }] };

function scene() {
  const actor = (id: string): TechnologyActor => ({ id, x: 0, y: 0, energy: 1, fatigue: 0,
    materials: { wood: 100, stone: 100 }, skills: {}, technology: initialTechnologyKnowledge() });
  const inventor = actor('inventor'), neighbor = actor('neighbor');
  const host: TechnologyHost = { seed: 751, tick: 0, people: [inventor, neighbor],
    technology: defaultTechnologyState(), legacy: [], retiredLegacy: [] };
  return { host, inventor, neighbor };
}
function finish(host: TechnologyHost, actor: TechnologyActor, program: TechnologyProgram) {
  actor.technology.project = { kind: 'research', program: structuredClone(program), parents: [], recipeId: null,
    progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: host.tick };
  let success = false;
  while (actor.technology.project) {
    if (observationSession(host)) endObservationAttempt(host);
    host.tick++;
    if (observationSession(host)) beginObservationAttempt(host, host.tick);
    success = researchTechnology(host, actor);
  }
  assert.equal(success, true);
}
function finishWorld(world: World, actor: World['people'][number], program = edge) {
  actor.technology.project = proyectoInvestigacion(structuredClone(program), world.tick);
  while (actor.technology.project) {
    if (observationSession(world)) endObservationAttempt(world);
    world.tick++;
    for (const person of world.people) person.demography.age = world.tick - person.bornAt;
    if (observationSession(world)) beginObservationAttempt(world, world.tick);
    researchTechnology(world, actor);
  }
}
function observe(host: TechnologyHost) {
  const session = createObservationSession({ runId: 'c14', epochId: 'e1', sourceSHA: 'a'.repeat(40) });
  bindObservation(host, session); return session;
}
function rediscoveries(session: ReturnType<typeof observe>) {
  return observedEvents(session).filter(event => event.siteId === 'technology.paid-rediscovery');
}

test('cold historical definition plus full pre-learning census links a real paid receipt without reauthoring', () => {
  const { host, inventor, neighbor } = scene();
  const session = observe(host);
  finish(host, inventor, edge);
  assert.equal(rediscoveries(session).length, 0, 'first invention is not a rediscovery');
  const original = structuredClone(resolveTechnologyRecipe(host, 'recipe-1')!);
  const taggedItem = inventor.technology.items[0]!.id;
  // A synthetic loss cut: the inventor remains alive and still owns the labelled object.
  inventor.technology.knownRecipes = [];
  const archive = new Map([[original.id, structuredClone(original)]]);
  enableTechnologyCatalogue(host.technology, { committedThrough: 1, memoryCapacity: 1 });
  host.technology.recipes = [];
  bindTechnologyCatalogue(host.technology, { resolve: id => structuredClone(archive.get(id) ?? null),
    findBySignature: signature => structuredClone([...archive.values()].find(r => r.signature === signature) ?? null) });
  const before = { counter: host.technology.recipeCounter, work: host.technology.ledger.work,
    energy: neighbor.energy, stone: neighbor.materials.stone, rng: host.seed };
  finish(host, neighbor, edge);
  const events = rediscoveries(session);
  assert.equal(events.length, 1);
  const event = events[0]!, payload = event.payload as ReturnType<typeof paidRediscoveryPayload>;
  const receipt = host.technology.history.find(entry => entry.id === payload.executionId)!;
  const receiptEvent = observedEvents(session).find(entry => entry.siteId === 'technology-execution.append'
    && (entry.payload as { executionId?: string }).executionId === receipt.id);
  assert.equal((receiptEvent?.payload as { programSignature?: string } | undefined)?.programSignature, original.signature);
  const receiptIndex = observedEvents(session).findIndex(entry => entry.sourceEventId === receiptEvent?.sourceEventId);
  const rediscoveryIndex = observedEvents(session).findIndex(entry => entry.sourceEventId === event.sourceEventId);
  assert.ok(receiptIndex >= 0 && rediscoveryIndex > receiptIndex);
  assert.equal(payload.status, 'OBSERVED'); assert.equal(payload.census.status, 'ZERO');
  assert.deepEqual(payload.census.livingActorIds, [inventor.id, neighbor.id]);
  assert.equal(payload.executionId, receipt.id); assert.equal(receipt.kind, 'research');
  assert.equal(payload.itemId, neighbor.technology.items[0]!.id);
  assert.deepEqual(payload.definition, { signature: original.signature, originalAuthorId: inventor.id,
    originalTick: original.tick, generation: original.generation, parentRecipeIds: original.parents });
  assert.equal(host.technology.recipeCounter, before.counter);
  assert.equal(host.technology.ledger.work - before.work, technologyWorkCost(edge));
  assert.equal(before.stone - neighbor.materials.stone, 1);
  assert.ok(neighbor.energy < before.energy); assert.equal(host.seed, before.rng);
  assert.equal(inventor.technology.items[0]!.id, taggedItem);
  assert.equal(inventor.technology.knownRecipes.includes(original.id), false);
  assert.deepEqual(neighbor.technology.knownRecipes, [original.id]);
  assert.equal(resolveTechnologyRecipe(host, original.id)!.inventorId, inventor.id);
  unbindObservation(host);
});

test('a contemporary knower inhibits the event; an unrelated program is a new invention', () => {
  const { host, inventor, neighbor } = scene();
  finish(host, inventor, edge);
  const session = observe(host);
  finish(host, neighbor, edge);
  assert.equal(rediscoveries(session).length, 0, 'death of the inventor alone would not establish a loss while another knows');
  finish(host, neighbor, other);
  assert.equal(rediscoveries(session).length, 0, 'a different signature creates a new definition');
  assert.equal(host.technology.recipeCounter, 2);
  unbindObservation(host);
});

test('accessible archived instructions inhibit; incomplete archive and census stay UNKNOWN', () => {
  const { host, inventor, neighbor } = scene();
  finish(host, inventor, edge);
  inventor.technology.knownRecipes = [];
  host.legacy = [{ id: 'older', diedAt: host.tick,
    technology: { knownRecipes: ['recipe-1'] } } as unknown as { id: string; diedAt: number }];
  assert.deepEqual(inspectRediscoveryCensus(host, 'recipe-1').knownActorIds, ['older']);
  assert.equal(inspectRediscoveryCensus(host, 'recipe-1').status, 'KNOWN');
  const session = observe(host);
  finish(host, neighbor, edge);
  assert.equal(rediscoveries(session).length, 0);
  unbindObservation(host);
  assert.deepEqual(inspectRediscoveryCensus(host, 'recipe-1').knownActorIds, ['neighbor', 'older']);
  assert.equal(inspectRediscoveryCensus(host, 'recipe-1').status, 'KNOWN');

  const incompleteArchive = scene();
  finish(incompleteArchive.host, incompleteArchive.inventor, edge);
  incompleteArchive.inventor.technology.knownRecipes = [];
  incompleteArchive.host.legacy = [{ id: 'older', diedAt: Number.NaN }];
  assert.deepEqual(inspectRediscoveryCensus(incompleteArchive.host, 'recipe-1').knownActorIds, []);
  assert.equal(inspectRediscoveryCensus(incompleteArchive.host, 'recipe-1').status, 'UNKNOWN');

  const incompleteCensus = scene();
  finish(incompleteCensus.host, incompleteCensus.inventor, edge);
  incompleteCensus.inventor.technology.knownRecipes = [];
  incompleteCensus.host.retiredLegacy = undefined;
  assert.deepEqual(inspectRediscoveryCensus(incompleteCensus.host, 'recipe-1').knownActorIds, []);
  assert.equal(inspectRediscoveryCensus(incompleteCensus.host, 'recipe-1').status, 'UNKNOWN');
});

test('missing archival provenance emits UNKNOWN after a paid experiment', () => {
  const { host, inventor, neighbor } = scene();
  finish(host, inventor, edge);
  inventor.technology.knownRecipes = [];
  host.retiredLegacy = undefined;
  const session = observe(host);
  finish(host, neighbor, edge);
  const payload = rediscoveries(session)[0]?.payload as ReturnType<typeof paidRediscoveryPayload> | undefined;
  assert.equal(payload?.status, 'UNKNOWN');
  assert.equal(payload?.reason, 'CENSUS_OR_ARCHIVE_INCOMPLETE');
  unbindObservation(host);
});

test('observation preserves paid source state, serials and event order', () => {
  const off = createWorld(51926), on = createWorld(51926);
  for (const world of [off, on]) {
    world.people[2]!.materials.stone = world.people[3]!.materials.stone = 8;
    finishWorld(world, world.people[2]!);
    world.people[2]!.technology.knownRecipes = [];
  }
  const session = observe(on);
  finishWorld(off, off.people[3]!);
  finishWorld(on, on.people[3]!);
  assert.deepEqual(on, off);
  assert.equal(on.rng, off.rng);
  assert.equal(on.eventCounter, off.eventCounter);
  assert.deepEqual(on.events, off.events);
  assert.deepEqual(on.technology.history.map(entry => entry.id), off.technology.history.map(entry => entry.id));
  assert.equal(rediscoveries(session).length, 1);
  unbindObservation(on);
});

test('rediscovered tool only becomes useful when finite harvesting exceeds the contemporary bare control', () => {
  const world: World = createWorld(51926), inventor = world.people[2]!, researcher = world.people[3]!;
  for (const person of world.people) {
    person.action = 'approach'; person.target = { x: person.x, y: person.y };
    person.decisionAt = world.tick + 1000;
    person.hunger = person.thirst = person.fatigue = 0.2; person.energy = 1;
  }
  inventor.materials.stone = researcher.materials.stone = 8;
  finishWorld(world, inventor);
  const original = resolveTechnologyRecipe(world, 'recipe-1')!;
  inventor.technology.knownRecipes = []; // synthetic last-knower loss; the original object remains labelled
  const session = observe(world);
  finishWorld(world, researcher);
  assert.equal((rediscoveries(session)[0]?.payload as { status?: string } | undefined)?.status, 'OBSERVED');
  assert.equal(resolveTechnologyRecipe(world, original.id)!.inventorId, inventor.id);
  endObservationAttempt(world);
  researcher.action = 'gather'; researcher.command = { order: 'gather', x: researcher.x, y: researcher.y };
  researcher.controlMode = 'directed'; researcher.target = { x: researcher.x, y: researcher.y };
  researcher.decisionAt = world.tick + 100; researcher.work = 17; researcher.materials.wood = 0;
  researcher.energy = 0.8; researcher.fatigue = 0.2;
  const tile = tileAt(world, researcher)!; tile.wood = 6;
  const control = cloneWorld(world), bare = control.people.find(person => person.id === researcher.id)!;
  settleTechnologyEstate(control, bare, []);
  stepWorld(world); stepWorld(control);
  const extra = researcher.materials.wood - bare.materials.wood;
  assert.ok(extra > 0);
  assert.ok((tileAt(world, researcher)!.wood ?? 0) < (tileAt(control, bare)!.wood ?? 0));
  const use = [...world.technology.history].reverse().find(entry => entry.kind === 'use'
    && entry.actorId === researcher.id && entry.recipeId === original.id)!;
  assert.ok(Math.abs(use.benefit - extra) < 1e-12);
  assert.ok(observedEvents(session).some(entry => entry.siteId === 'technology.benefit-applied'
    && (entry.payload as { executionId?: string; benefitContext?: string }).executionId === use.id
    && (entry.payload as { benefitContext?: string }).benefitContext === 'applied-world'));
  unbindObservation(world);
});

test('unpaid, detached, mismatched and authorless receipts cannot be labelled observed rediscovery', () => {
  const { host, inventor, neighbor } = scene();
  finish(host, inventor, edge);
  inventor.technology.knownRecipes = [];
  finish(host, neighbor, edge);
  const original = resolveTechnologyRecipe(host, 'recipe-1')!;
  const receipt = host.technology.history.at(-1)!;
  const census = inspectRediscoveryCensus(host, 'recipe-1');
  // Recreate the pre-learning cut; the present neighbor now knows and cannot certify it.
  const preCut = { ...census, status: 'ZERO' as const, knownActorIds: [], reason: null };
  const payload = (entry: typeof receipt, recipe = original, signatureMatches = true) =>
    paidRediscoveryPayload(host, recipe, entry, neighbor.id, neighbor.technology.items.at(-1)!.id, preCut, signatureMatches);
  assert.equal(payload(receipt).status, 'OBSERVED');
  for (const wrong of [{ ...receipt, work: 0 }, { ...receipt, energy: 0 },
    { ...receipt, recipeId: 'recipe-999' }, { ...receipt, actorId: 'someone-else' },
    { ...receipt, id: 'process-999' }]) assert.equal(payload(wrong).status, 'UNKNOWN');
  assert.equal(payload(receipt, { ...original, inventorId: '' }).status, 'UNKNOWN');
  assert.equal(payload(receipt, original, false).status, 'UNKNOWN');
  assert.equal(programSignature(other) === original.signature, false);
});
