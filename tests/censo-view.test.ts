import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, projectWorld, stepWorld } from '../src/world/index.js';
import { ausenteEstado, censoDe, demographicSummary, recuentoPoblacion, rotuloRecuento } from '../src/client/censo-view.js';

/** M1: `people` llega recortado a la cámara; el censo del mundo es `stats.census`. */
function vistaLejos() {
  const world = createWorld(51926);
  for (let i = 0; i < 200; i++) stepWorld(world);
  // Una cámara a 300,300: ni S, ni I, ni ningún vecino en cuadro.
  const view = projectWorld(world, { x: 300, y: 300, width: 12, height: 8 });
  return { world, view };
}

test('lejos de la gente el censo sigue contando a todo el mundo y no a la cámara', () => {
  const { world, view } = vistaLejos();
  assert.equal(view.people.length, 0, 'la cámara está lejos de todos');
  const censo = censoDe(view)!;
  assert.equal(censo.total, world.people.length);
  assert.equal(censo.identities, 2);
  const html = demographicSummary(view);
  assert.match(html, new RegExp(`${world.people.length} vidas en el mundo · 0 en esta vista`));
  assert.doesNotMatch(html, /Sin vecinos vivos/);
  assert.doesNotMatch(html, /Vecinos vivos<\/span><strong>0</);
  assert.match(html, /S\/I protegidos<\/span><strong>2</);
  assert.match(html, /la cámara muestra a 0/);
  assert.equal(rotuloRecuento(view), `0 en esta vista · ${world.people.length} en el mundo`);
});

test('una vista recortada dice 13 en esta vista y 23 en el mundo (caso de la auditoría móvil)', () => {
  const view = projectWorld(createWorld(51926));
  view.people = view.people.slice(0, 13);
  view.stats!.census = { neighbors: 21, identities: 2, protectedCount: 2, lifeStage: { juvenile: 5, adult: 14, senescent: 2, unknown: 0 } };
  assert.deepEqual(recuentoPoblacion(view), { enVista: 13, enMundo: 23 });
  assert.equal(rotuloRecuento(view), '13 en esta vista · 23 en el mundo');
  const html = demographicSummary(view);
  assert.match(html, /23 vidas en el mundo · 13 en esta vista/);
  assert.match(html, /Vecinos vivos<\/span><strong>21</);
  assert.match(html, /data-life-stage="adult">Edad de crianza<strong>14</);
  assert.match(html, /21\/21 con dato · todo el mundo/);
});

test('sin censo no se cuenta la cámara como si fuera el mundo', () => {
  const view = projectWorld(createWorld(51926));
  delete view.stats!.census;
  assert.equal(censoDe(view), null);
  const html = demographicSummary(view);
  assert.match(html, /Vecinos vivos<\/span><strong>—</);
  assert.match(html, /S\/I protegidos<\/span><strong>—</);
  assert.match(html, /censo no recibido/);
  assert.doesNotMatch(html, /vidas en el mundo/);
  assert.equal(rotuloRecuento(view), `${view.people.length} en esta vista`);
  // Un censo con números inválidos tampoco se dibuja.
  view.stats!.census = { neighbors: -1, identities: 2, protectedCount: 2, lifeStage: { juvenile: 0, adult: 0, senescent: 0, unknown: 0 } };
  assert.equal(censoDe(view), null);
});

test('estar fuera de la cámara no es morir: solo demography.recent acredita una muerte', () => {
  const { world, view } = vistaLejos();
  const s = world.people.find(p => p.role === 'S')!;
  assert.equal(ausenteEstado(view, s.id, undefined), 'comprobando');
  assert.equal(ausenteEstado(view, s.id, true), 'fuera');
  assert.equal(ausenteEstado(view, 'descendant-999', false), 'no-servido');
  view.demography!.recent = [{ id: 'descendant-7', name: 'Olmo 7', generation: 1, parents: [], bornAt: 0, diedAt: 100, cause: 'dehydration' }];
  assert.equal(ausenteEstado(view, 'descendant-7', true), 'difunto', 'el registro de muerte manda sobre una respuesta vieja');
});
