import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, type Person } from '../src/world/index.js';
import { CONDUCTA_DIMENSIONS, OFICIOS_CATEGORIAS, indiceDiversidad, vectorConducta } from '../src/world/diversidad.js';

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
  // Ronda de arreglo: la entropía normaliza por las OFICIOS_CATEGORIAS POSIBLES (18),
  // no por las 2 observadas, así que 2 oficios a partes iguales NO da entropía máxima
  // (antes de esta ronda, `assert.equal(result.oficios, 1)` fijaba la convención rota).
  const esperado = Math.log(2) / Math.log(OFICIOS_CATEGORIAS);
  assert.ok(Math.abs(result.oficios - esperado) < 1e-9, `oficios esperado ${esperado}, obtenido ${result.oficios}`);
  assert.ok(result.oficios < 1, 'con solo 2 de 18 oficios posibles, la entropía no debe alcanzar el máximo');
});

test('indiceDiversidad: monocultivo de 2 oficios de 18 posibles no puntúa entropía máxima (hallazgo de revisión)', () => {
  // Reproduce el caso medido en la revisión: 20 personas repartidas 50/50 entre solo
  // 2 de los 18 oficios posibles (hunt/farm). Con normalización por categorías
  // OBSERVADAS esto daba oficios=1 (máximo) y aprobaba SC-003 pese a ser un
  // monocultivo; este test refuta esa regresión.
  const world = createWorld(5);
  const template = world.people[0]!;
  const people: Person[] = [];
  for (let i = 0; i < 20; i++) {
    const person: Person = structuredClone(template);
    person.id = `persona-${i}`;
    person.activity = i % 2 === 0 ? { hunt: 10 } : { farm: 10 };
    person.skills = i % 2 === 0 ? { hunt: 0.5 } : { farm: 0.5 };
    person.experiences = [];
    people.push(person);
  }
  world.people = people;
  const result = indiceDiversidad(world);
  assert.ok(result.oficios < 0.5, `oficios esperado < 0,5 (monocultivo de 2/18), obtenido ${result.oficios}`);
});

test('vectorConducta: los grupos pesan por igual tras normalizar cada uno a norma 1 (hallazgo de revisión)', () => {
  // Hallazgo de revisión: sin `pushNormalized`, el peso de cada grupo en la distancia
  // coseno dependía de su escala de origen (tecnología ~54,5 % de la norma², "lugares"
  // mucho menos). Con el arreglo, sustituir un grupo EN BLANCO por contenido no nulo
  // mueve la distancia coseno EXACTAMENTE IGUAL sin importar qué grupo sea — aquí
  // comparamos "solo difiere tecnología" contra "solo difiere lugar" partiendo del
  // mismo resto (acciones/oficio idénticos, alimento en blanco en ambos casos).
  const base = (seed: number): Person => {
    const world = createWorld(seed);
    const person = world.people[0]!;
    person.activity = { hunt: 10 };
    person.skills = {};
    person.experiences = [];
    person.technology.knownRecipes = [];
    person.technology.items = [];
    person.technology.competence = {};
    return person;
  };
  const a1 = base(6), b1 = base(6);
  b1.id = 'con-tecnologia';
  b1.technology.knownRecipes = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
  b1.technology.competence = { r1: { attempts: 10, successes: 9, work: 5, benefit: 8 } };
  const worldTecnologia = createWorld(6);
  worldTecnologia.people = [a1, b1];
  const distanciaTecnologia = indiceDiversidad(worldTecnologia).conducta;

  const a2 = base(6), c2 = base(6);
  c2.id = 'con-lugar';
  c2.experiences = [{ tick: 0, text: 'x', causeId: 'c1', placeId: 'lugar-norte' }];
  const worldLugar = createWorld(6);
  worldLugar.people = [a2, c2];
  const distanciaLugar = indiceDiversidad(worldLugar).conducta;

  assert.ok(
    Math.abs(distanciaTecnologia - distanciaLugar) < 1e-6,
    `con peso equitativo por grupo ambas distancias deben coincidir: tecnología=${distanciaTecnologia}, lugar=${distanciaLugar}`,
  );
  // Antes del arreglo (grupo tecnología sin normalizar, dominando la norma²) esta
  // igualdad no se sostenía: sirve de guarda de regresión del peso por grupo.
});

test('indiceDiversidad: 0 ó 1 habitante da 0 en las tres cifras, sin excepción', () => {
  const empty = createWorld(4);
  empty.people = [];
  assert.deepEqual(indiceDiversidad(empty), { conducta: 0, oficios: 0, total: 0 });
  const single = createWorld(4);
  single.people = single.people.slice(0, 1);
  assert.deepEqual(indiceDiversidad(single), { conducta: 0, oficios: 0, total: 0 });
});

test('indiceDiversidad: semilla 4821 tras 600 pasos es estable y está en [0,1]', () => {
  // El determinismo del mundo lo prueba world.test.ts; aquí basta un mundo real y la función pura.
  const world = createWorld(4821);
  for (let t = 0; t < 600; t++) stepWorld(world);
  const first = indiceDiversidad(world);
  const second = indiceDiversidad(world);
  assert.deepEqual(first, second);
  assert.ok(Number.isFinite(first.conducta) && first.conducta >= 0 && first.conducta <= 1);
  assert.ok(Number.isFinite(first.oficios) && first.oficios >= 0 && first.oficios <= 1);
});
