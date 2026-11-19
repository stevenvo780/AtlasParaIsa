import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { PersonStore, HOT_BYTES_PER_PERSON, TOTAL_BUDGET_BYTES } from '../src/world/soa/personas.js';
import { topSkillByInsertionOrder } from '../src/world/society.js';
import { clonarVecino, registrarInyectados } from './lib/escenas.js';

/**
 * T147: SoA caliente de persona conservando el orden de iteración. La puerta es
 * `digestoCanonico` más el orden efectivo de claves de los `Record`, que el digesto
 * ordena y por tanto no ve: por eso cada ida y vuelta comprueba también `Object.keys`.
 */

function grownWorld(steps: number, seed = 51926): World {
  const world = createWorld(seed);
  for (let n = 0; n < steps; n++) stepWorld(world);
  return world;
}

function assertRecordOrders(original: Person, back: Person): void {
  assert.deepEqual(Object.keys(back.skills), Object.keys(original.skills), `orden de skills de ${original.id}`);
  assert.deepEqual(Object.keys(back.activity), Object.keys(original.activity), `orden de activity de ${original.id}`);
  assert.deepEqual(Object.keys(back.values), Object.keys(original.values), `orden de values de ${original.id}`);
  assert.deepEqual(Object.keys(back.bonds), Object.keys(original.bonds), `orden de bonds de ${original.id}`);
  assert.deepEqual(Object.keys(back.technology.competence), Object.keys(original.technology.competence), `orden de competence de ${original.id}`);
}

test('empate de habilidades: el desempate por orden de inserción sobrevive a la ida y vuelta, en ambos órdenes', () => {
  const world = grownWorld(60);
  const template = world.people.find(p => p.role === 'neighbor')!;
  const make = (id: string, skills: Record<string, number>): Person => {
    const person = structuredClone(template);
    person.id = id; person.skills = skills;
    person.bonds = { 'vecino-a': 0.4, 'vecino-b': 0.4, 'vecino-c': 0.1 };
    return person;
  };
  // Dos habilidades empatadas en cabeza, insertadas en orden contrario en cada persona.
  const a = make('empate-a', { gather: 0.5, farm: 0.5, hunt: 0.25 });
  const b = make('empate-b', { farm: 0.5, gather: 0.5, hunt: 0.25 });
  const beforeA = topSkillByInsertionOrder(a.skills);
  const beforeB = topSkillByInsertionOrder(b.skills);
  assert.equal(beforeA, 'gather');
  assert.equal(beforeB, 'farm');
  assert.notEqual(beforeA, beforeB, 'el empate debe ser sensible al orden: si no, la prueba no muerde');

  const store = new PersonStore();
  store.pack([a, b]);
  const back = store.unpack();
  assert.deepEqual(Object.keys(back[0]!.skills), ['gather', 'farm', 'hunt']);
  assert.deepEqual(Object.keys(back[1]!.skills), ['farm', 'gather', 'hunt']);
  assert.deepEqual(store.skillsOrder(0), ['gather', 'farm', 'hunt']);
  assert.deepEqual(store.skillsOrder(1), ['farm', 'gather', 'hunt']);
  // El desempate elige exactamente la misma habilidad tras la ida y vuelta, por las tres vías.
  assert.equal(topSkillByInsertionOrder(back[0]!.skills), beforeA);
  assert.equal(topSkillByInsertionOrder(back[1]!.skills), beforeB);
  assert.equal(topSkillByInsertionOrder(back[0]!.skills, store.skillsOrder(0)), beforeA);
  assert.equal(topSkillByInsertionOrder(back[1]!.skills, store.skillsOrder(1)), beforeB);
  assert.equal(store.topSkill(0), beforeA);
  assert.equal(store.topSkill(1), beforeB);
  // Y los vínculos conservan su orden de claves.
  assert.deepEqual(Object.keys(back[0]!.bonds), ['vecino-a', 'vecino-b', 'vecino-c']);
  assert.deepEqual(store.bondsOrder(0), ['vecino-a', 'vecino-b', 'vecino-c']);
  assert.deepStrictEqual(back, [a, b]);
});

test('ida y vuelta de todas las personas de un mundo real tras 1200 pasos: digestoCanonico idéntico', () => {
  const world = grownWorld(1200);
  assert.ok(world.people.length >= 16, `personas reales: ${world.people.length}`);
  const store = new PersonStore();
  store.pack(world.people);
  const back = store.unpack();
  assert.deepStrictEqual(back, world.people);
  for (let i = 0; i < world.people.length; i++) assertRecordOrders(world.people[i]!, back[i]!);
  const replaced = cloneWorld(world);
  replaced.people = back;
  assert.equal(digestoCanonico(replaced), digestoCanonico(world));
});

test('el mundo desempaquetado sigue dando el mismo digesto que el original 120 pasos después', () => {
  const original = grownWorld(600);
  const roundTripped = grownWorld(600);
  const store = new PersonStore();
  store.pack(roundTripped.people);
  roundTripped.people = store.unpack();
  assert.equal(digestoCanonico(roundTripped), digestoCanonico(original));
  for (let n = 0; n < 120; n++) { stepWorld(original); stepWorld(roundTripped); }
  assert.equal(digestoCanonico(roundTripped), digestoCanonico(original));
});

test('bytes por habitante medidos sobre los buffers del PersonStore en un mundo real de 1000 habitantes: ≤ 4096', t => {
  const world = grownWorld(600);
  // Mundo real envejecido 600 pasos; se clonan vecinos reales hasta 1000 habitantes
  // (500–2000) para medir a escala, como hacen las pruebas de escala del repo.
  const target = 1000;
  for (let i = world.people.length; i < target; i++) {
    const clone = clonarVecino(world, `medida-${i}`, `Sintético medida ${i}`, { x: 10, y: 10 }, null);
    // Textos propios por habitante: sin esto la piscina de cadenas internadas
    // deduplicaría los textos de los clones y la medida sería optimista.
    clone.reason = `Razón propia del habitante de medida ${i}: observa el entorno y decide su siguiente paso.`;
    clone.recentMemory = `Recuerdo propio del habitante de medida ${i}: una experiencia reciente en el claro.`;
    clone.experiences = clone.experiences.map((experience, k) => ({ ...experience, text: `Experiencia ${k} propia del habitante de medida ${i}: detalle observado en su recorrido.` }));
    world.people.push(clone);
  }
  registrarInyectados(world);
  assert.equal(world.people.length, target);
  const store = new PersonStore();
  store.pack(world.people);
  const back = store.unpack();
  assert.deepStrictEqual(back, world.people);
  t.diagnostic(`T147 bytes/habitante ${JSON.stringify({ personas: store.count, bytes: store.bytes, bytesPorHabitante: store.bytesPerPerson, calientePorHabitante: store.hotBytesPerPerson })}`);
  assert.equal(HOT_BYTES_PER_PERSON, store.hotBytesPerPerson);
  assert.ok(store.hotBytesPerPerson <= 1024, `página caliente: ${store.hotBytesPerPerson} B`);
  assert.ok(store.bytesPerPerson > 0 && store.bytesPerPerson <= TOTAL_BUDGET_BYTES, `${store.bytesPerPerson} B/habitante`);
});

test('opcionales, -0, registros vacíos y comando sobreviven; lo no representable lanza', () => {
  const world = grownWorld(30);
  const base = structuredClone(world.people.find(p => p.role === 'neighbor')!);
  base.id = 'opcional-1';
  base.skills = { gather: -0, farm: 0 };
  base.bonds = {};
  base.home = { x: 3, y: 4, quality: 0.5, observedAt: 12 };
  base.waterMemory = { x: 5, y: 6 };
  base.conflictMemory = { x: 7, y: 8, tick: 9 };
  base.command = { order: 'move', x: 1, y: 2 };
  base.controlMode = 'directed';
  base.lastInvention = 42;
  const empty = structuredClone(base);
  empty.id = 'opcional-2'; empty.skills = {}; empty.activity = {}; empty.values = {};
  delete empty.home; delete empty.waterMemory; delete empty.conflictMemory; delete empty.lastInvention;
  empty.command = null; empty.controlMode = 'auto';
  const store = new PersonStore();
  store.pack([base, empty]);
  const [backBase, backEmpty] = store.unpack() as [Person, Person];
  assert.ok(Object.is(backBase.skills.gather, -0), '-0 se conserva');
  assert.equal(topSkillByInsertionOrder(backBase.skills), 'gather');
  assert.equal(store.topSkill(1), undefined);
  assert.deepEqual(backBase.home, base.home);
  assert.deepEqual(backBase.command, base.command);
  assert.equal('home' in backEmpty, false);
  assert.equal('lastInvention' in backEmpty, false);
  assert.deepStrictEqual([backBase, backEmpty], [base, empty]);

  const badVisited = structuredClone(base); badVisited.visited = ['no-es-un-par'];
  assert.throws(() => new PersonStore().pack([badVisited]), RangeError);
  const badAction = structuredClone(base); (badAction as { action: string }).action = 'volar';
  assert.throws(() => new PersonStore().pack([badAction]), RangeError);
  assert.throws(() => store.unpackPerson(99), RangeError);
});
