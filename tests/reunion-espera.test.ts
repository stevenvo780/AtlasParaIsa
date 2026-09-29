import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { demographicTraits, initialDemography } from '../src/world/demography.js';
import { familyOpportunity } from '../src/world/family.js';
import { paramsOf, setParams } from '../src/world/params.js';
import type { ReproductionCheckSample } from '../src/world/spatial.js';

function withLaw(world: World, enabled: 0 | 1): void {
  const params = paramsOf(world);
  setParams(world, { ...params, poblacion: { ...params.poblacion, reunionSinEspera: enabled } });
}

function familyScene(distanceBetween = 0, placeX = 17): { world: World; a: Person; b: Person } {
  const world = createWorld(51926);
  world.tick = 6000;
  const [a, b] = world.people.filter(person => person.role === 'neighbor').slice(0, 2) as [Person, Person];
  world.people = [a, b];
  for (const person of world.people) {
    person.x = 17; person.y = 13; person.target = { x: person.x, y: person.y };
    person.communityId = 'family-test'; person.bonds = {};
    person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9; person.inventory = 0.2;
    person.demography = initialDemography(world.tick - person.bornAt);
    person.lastBirth = world.tick - demographicTraits(person.genome).fertilityCooldown;
    person.decisionAt = 0; person.action = 'rest'; person.values = {}; person.command = null;
  }
  b.x += distanceBetween; b.target = { x: b.x, y: b.y };
  a.bonds[b.id] = b.bonds[a.id] = 0.7;
  world.places = [{ ...world.places[0]!, x: placeX, y: 13 }];
  return { world, a, b };
}

const reunionReason = /el vínculo y el cuidado corporal permiten intentar una crianza/;

test('R=1 quita solo la oferta de reunión cuando la pareja ya cumple el predicado desde ambos', () => {
  const { world, a, b } = familyScene();
  assert.equal(familyOpportunity(world, a)?.partner.id, b.id);
  const control = cloneWorld(world);
  withLaw(world, 1);
  const seleccionControl: string[] = [], seleccionR: string[] = [];
  stepWorld(control, [], { observeReunionSelection: (_world, actorId, partnerId) => seleccionControl.push(`${actorId}:${partnerId}`) });
  stepWorld(world, [], { observeReunionSelection: (_world, actorId, partnerId) => seleccionR.push(`${actorId}:${partnerId}`) });
  const controlA = control.people.find(person => person.id === a.id)!;
  const candidateA = world.people.find(person => person.id === a.id)!;
  assert.equal(controlA.action, 'approach');
  assert.match(controlA.reason, reunionReason);
  assert.ok(seleccionControl.includes(`${a.id}:${b.id}`), 'la selección observada conserva el ID de la pareja');
  assert.deepEqual(seleccionR, [], 'R suprime la cola antes de seleccionar reunión');
  assert.doesNotMatch(candidateA.reason, reunionReason);
});

test('R=1 conserva reunión cuando falta acercarse a la pareja o a su lugar', () => {
  for (const [distanceBetween, placeX] of [[4, 19], [3, 13]] as const) {
    const { world, a, b } = familyScene(distanceBetween, placeX);
    assert.equal(familyOpportunity(world, a)?.partner.id, b.id);
    withLaw(world, 1);
    const checks: ReproductionCheckSample[] = [];
    stepWorld(world, [], { observeReproduction: sample => checks.push(sample) });
    const actor = world.people.find(person => person.id === a.id)!;
    assert.equal(actor.action, 'approach');
    assert.match(actor.reason, reunionReason);
    if (distanceBetween === 3) {
      assert.equal(checks[0]!.eligiblePairs, 1, 'reproduce admite un iniciador con lugar');
      assert.equal(checks[0]!.eligiblePairsBoth, 0, 'R conserva reunión hasta que ambos tengan lugar');
    }
  }
});

test('R=1 no altera S e I', () => {
  const control = createWorld(51926);
  control.people = control.people.filter(person => person.role !== 'neighbor');
  const candidate = cloneWorld(control);
  withLaw(candidate, 1);
  for (let step = 0; step < 120; step++) {
    stepWorld(control); stepWorld(candidate);
    assert.deepEqual(candidate.people, control.people, `S/I inalterados en paso ${step + 1}`);
  }
});

test('R=1 es determinista con el observador externo y reporta parejas y plazas exactas', () => {
  const { world } = familyScene();
  withLaw(world, 1);
  const copy = cloneWorld(world);
  const checks: ReproductionCheckSample[] = [];
  // El observador está en el contexto del anfitrión, fuera del estado persistido.
  stepWorld(world, [], { observeReproduction: sample => checks.push(sample) });
  stepWorld(copy);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.eligiblePairs, 1);
  assert.equal(checks[0]!.eligiblePairsBoth, 1);
  assert.equal(checks[0]!.capSlots, 2);
  assert.equal(checks[0]!.slotsAvailable, 2);
  assert.equal(checks[0]!.slotsUsed, 0, 'ningún nacimiento anterior ocupa la ventana');
  assert.ok(checks[0]!.births <= checks[0]!.slotsAvailable);
  assert.equal(digestoCanonico(world), digestoCanonico(copy), 'medir no modifica el mundo');
  for (let step = 0; step < 120; step++) { stepWorld(world); stepWorld(copy); }
  assert.equal(digestoCanonico(world), digestoCanonico(copy), 'dos réplicas R=1 siguen idénticas');
});

test('el observador distingue ventana llena de nacimientos nuevos', () => {
  const world = createWorld(42);
  world.tick = 6000;
  const neighbors = world.people.filter(person => person.role === 'neighbor');
  assert.ok(neighbors.length >= 2);
  neighbors[0]!.bornAt = world.tick - 1;
  neighbors[1]!.bornAt = world.tick - 1;
  const params = paramsOf(world);
  setParams(world, { ...params, poblacion: { ...params.poblacion,
    comprobacionContinua: true, nacimientosPorComprobacion: 2 } });
  const checks: ReproductionCheckSample[] = [];
  stepWorld(world, [], { observeReproduction: sample => checks.push(sample) });
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.capSlots, 2);
  assert.equal(checks[0]!.slotsUsed, 2, 'dos nacimientos anteriores ocupan la ventana móvil');
  assert.equal(checks[0]!.slotsAvailable, 0);
  assert.equal(checks[0]!.births, 0, 'no hay nacimientos nuevos con el cupo lleno');
});
