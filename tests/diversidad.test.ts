import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, TICKS_PER_DAY, type Person } from '../src/world/index.js';
import { CONDUCTA_DIMENSIONS, indiceDiversidad, vectorConducta } from '../src/world/diversidad.js';

test('vectorConducta: dimensión fija y normalizada L2', () => {
  const world = createWorld(1);
  const person = world.people[0]!;
  person.activity = { hunt: 5, gather: 2 };
  person.skills = { hunt: 0.4 };
  person.experiences = [{ tick: 0, text: 'x', causeId: 'c1', placeId: 'lugar-norte' }];
  const vector = vectorConducta(person, world);
  assert.equal(vector.length, CONDUCTA_DIMENSIONS);
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `norma L2 esperada 1, obtenida ${norm}`);
});

test('indiceDiversidad: dos clones de conducta dan distancia 0', () => {
  const world = createWorld(2);
  const original = world.people[0]!;
  original.activity = { hunt: 4, share: 1 };
  original.skills = { hunt: 0.6, share: 0.2 };
  original.technology.knownRecipes = ['a', 'b'];
  original.experiences = [{ tick: 0, text: 'x', causeId: 'c1', placeId: 'lugar-norte' }];
  const clone: Person = structuredClone(original);
  clone.id = 'clon-de-prueba';
  world.people = [original, clone];
  const result = indiceDiversidad(world);
  assert.equal(result.conducta, 0);
  // Mismo oficio dominante en ambos clones: sin diversidad de oficios tampoco.
  assert.equal(result.oficios, 0);
  assert.equal(result.total, 0);
});

test('indiceDiversidad: oficios y memorias opuestas superan 0,8 de distancia', () => {
  const world = createWorld(3);
  const hunter = world.people[0]!, farmer = world.people[1]!;
  hunter.activity = { hunt: 10 }; hunter.skills = { hunt: 0.9 };
  hunter.experiences = [{ tick: 0, text: 'cazó cerca del bosque', causeId: 'c1', placeId: 'lugar-norte' }];
  farmer.activity = { farm: 10 }; farmer.skills = { farm: 0.9 };
  farmer.experiences = [{ tick: 0, text: 'cultivó junto al río', causeId: 'c2', placeId: 'lugar-sur' }];
  world.people = [hunter, farmer];
  const result = indiceDiversidad(world);
  assert.ok(result.conducta > 0.8, `conducta esperada > 0,8, obtenida ${result.conducta}`);
  // Un único oficio por persona, ambos distintos y a partes iguales: entropía máxima (1).
  assert.equal(result.oficios, 1);
});

test('indiceDiversidad: 0 ó 1 habitante da 0 en las tres cifras, sin excepción', () => {
  const empty = createWorld(4);
  empty.people = [];
  assert.deepEqual(indiceDiversidad(empty), { conducta: 0, oficios: 0, total: 0 });
  const single = createWorld(4);
  single.people = single.people.slice(0, 1);
  assert.deepEqual(indiceDiversidad(single), { conducta: 0, oficios: 0, total: 0 });
});

test('indiceDiversidad: semilla 4821 tras 2 días es estable y determinista entre ejecuciones', () => {
  const days = 2, ticks = days * TICKS_PER_DAY;
  const run = (): { conducta: number; oficios: number; total: number } => {
    const world = createWorld(4821);
    for (let t = 0; t < ticks; t++) stepWorld(world);
    return indiceDiversidad(world);
  };
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  assert.ok(Number.isFinite(first.conducta) && first.conducta >= 0 && first.conducta <= 1);
  assert.ok(Number.isFinite(first.oficios) && first.oficios >= 0 && first.oficios <= 1);
});
