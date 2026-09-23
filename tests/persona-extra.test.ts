import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, projectWorld, personDetail } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { enriquecerPersona } from '../src/server/persona-extra.js';

/** Un mundo sembrado real, avanzado lo bastante para que haya experiencias y vínculos. */
function mundo(ticks = 400) {
  const world = createWorld(51926);
  for (let i = 0; i < ticks; i++) stepWorld(world);
  return world;
}

test('M3: la ficha a demanda trae nombre y posición exacta de alguien fuera de la cámara', () => {
  const world = mundo();
  const s = world.people.find(p => p.role === 'S')!;
  const lejos = projectWorld(world, { x: 300, y: 300, width: 12, height: 8 });
  assert.equal(lejos.people.some(p => p.id === s.id), false, 'S está fuera de esta cámara');
  const ficha = enriquecerPersona(world, s.id)!;
  assert.equal(ficha.name, s.name);
  assert.equal(ficha.x, s.x); assert.equal(ficha.y, s.y);
  assert.equal(ficha.vivo, true);
  // La biografía es la misma que ya se servía: solo se añaden campos.
  const { name: _n, x: _x, y: _y, vivo: _v, fertil: _f, busca: _b, familia: _fa, edades: _e, procedimientos: _pr, inventadas: _in, ...resto } = ficha;
  assert.deepEqual(resto, personDetail(world, s.id));
  assert.equal(enriquecerPersona(world, 'descendant-999999'), undefined, 'una identidad que no vive no se inventa');
  assert.equal(enriquecerPersona(world, '../s'), undefined);
});

test('M3: pedir fichas no cambia el mundo ni su digesto canónico', () => {
  const a = mundo(300), b = mundo(300);
  for (const person of a.people) enriquecerPersona(a, person.id);
  assert.equal(digestoCanonico(a), digestoCanonico(b), 'consultar no es una transacción');
  for (let i = 0; i < 50; i++) { stepWorld(a); stepWorld(b); if (i % 7 === 0) for (const p of a.people) enriquecerPersona(a, p.id); }
  assert.equal(digestoCanonico(a), digestoCanonico(b), 'y la trayectoria sigue idéntica');
});

test('M8: la familia se nombra en todo el mundo: hijos fuera de cámara, difuntos y progenitores que murieron', () => {
  const world = mundo(60);
  const [a, b, hijo, nieto] = world.people.filter(p => p.role === 'neighbor');
  hijo!.genome.parents = [a!.id, b!.id];
  hijo!.x = a!.x + 200; hijo!.y = a!.y + 200; // lejos de cualquier cámara cercana a su progenitor
  const muerto = { ...structuredClone(world.legacy[0] ?? { id: 'x', name: 'x', role: 'neighbor', generation: 1, parents: [], bornAt: 0, diedAt: 10, cause: 'dehydration' }), id: 'descendant-900', name: 'Olmo 900', generation: 1, parents: [a!.id], bornAt: 0, diedAt: 40, cause: 'dehydration' };
  world.legacy.push(muerto as typeof world.legacy[number]);
  nieto!.genome.parents = ['descendant-900'];
  const f = enriquecerPersona(world, a!.id)!.familia!;
  assert.equal(f.totalHijos, 2); assert.equal(f.hijosVivos, 1);
  assert.deepEqual(f.hijos.map(h => [h.id, h.nombre, h.vivo]).sort(), [[hijo!.id, hijo!.name, true], ['descendant-900', 'Olmo 900', false]].sort());
  assert.deepEqual(enriquecerPersona(world, nieto!.id)!.familia!.progenitores, [{ id: 'descendant-900', nombre: 'Olmo 900', vivo: false, generacion: 1 }]);
  nieto!.genome.parents = ['descendant-123456'];
  assert.deepEqual(enriquecerPersona(world, nieto!.id)!.familia!.progenitores, [{ id: 'descendant-123456', nombre: null, vivo: null, generacion: null }], 'un registro que el mundo no conserva no se inventa');
  const edades = enriquecerPersona(world, a!.id)!.edades!;
  assert.ok(edades.madurez < edades.vejez && edades.vejez < edades.maxima);
  assert.equal(edades.edad, a!.demography.age);
});

test('M9: la ficha dice quién inventó y de quién se aprendió un procedimiento tras un shareTechnology real', async () => {
  const { researchTechnology, shareTechnology, technologyWorkCost } = await import('../src/world/technology.js');
  const { recordChronicleEvent } = await import('../src/world/chronicle-journal.js');
  const world = createWorld(51926), teacher = world.people[2]!, learner = world.people[3]!;
  for (const person of [teacher, learner]) { person.x = 36; person.y = 12; person.target = { x: 36, y: 12 }; person.energy = 1; person.fatigue = person.hunger = person.thirst = 0; }
  teacher.materials = { wood: 12, stone: 8 };
  const program = { inputs: [{ source: 'raw' as const, material: 'stone' as const, mass: 1000 }], steps: [{ op: 'form' as const, intensity: 4, shape: 'edge' as const }, { op: 'compress' as const, intensity: 2 }] };
  teacher.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  while (teacher.technology.project) { world.tick++; researchTechnology(world, teacher); }
  const recipe = world.technology.recipes.at(-1)!;
  assert.equal(recipe.inventorId, teacher.id);
  world.tick += 5;
  assert.equal(shareTechnology(world, teacher, learner, e => { const r = recordChronicleEvent(world, e); world.events.push(r); return r; }, recipe.id), true);
  const aprendio = enriquecerPersona(world, learner.id)!;
  assert.deepEqual(aprendio.procedimientos!.find(p => p.id === recipe.id), { id: recipe.id, origen: 'aprendido', tick: world.tick, maestro: { id: teacher.id, nombre: teacher.name } });
  const invento = enriquecerPersona(world, teacher.id)!;
  assert.deepEqual(invento.procedimientos!.find(p => p.id === recipe.id), { id: recipe.id, origen: 'invento', tick: recipe.tick });
  assert.ok(invento.inventadas! >= 1);
  assert.ok(aprendio.procedimientos!.length <= 32);
  assert.ok(Buffer.byteLength(JSON.stringify(aprendio.procedimientos)) <= 32 * 90, 'como mucho ~90 B por procedimiento');
  // El maestro murió y su registro pasó a `retiredLegacy`: su nombre sigue constando. Fuera de todo registro, null.
  const maestroDe = (): unknown => enriquecerPersona(world, learner.id)!.procedimientos!.find(p => p.id === recipe.id)!.maestro;
  world.people.splice(world.people.indexOf(teacher), 1);
  world.retiredLegacy.push({ id: teacher.id, name: teacher.name, role: 'neighbor', generation: 0, parents: [], bornAt: 0,
    diedAt: world.tick, cause: 'senescence', communityId: null } as unknown as (typeof world.retiredLegacy)[number]);
  assert.deepEqual(maestroDe(), { id: teacher.id, nombre: teacher.name });
  world.retiredLegacy.pop();
  assert.deepEqual(maestroDe(), { id: teacher.id, nombre: null });
});
