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
  const { name: _n, x: _x, y: _y, vivo: _v, fertil: _f, busca: _b, familia: _fa, edades: _e, ...resto } = ficha;
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
