import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { resourceDispute } from '../src/world/society.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { CronicaBuffer, clasificar, contadoresDe, filtrar, momento, quienCedio, resumenDesdeVisita } from '../src/client/cronica.js';
import { MAX_HITOS_GUARDADOS, readHitos, readVisitCounters, readWorldVisit, saveHitos, saveVisitCounters, saveWorldVisit } from '../src/client/visit-memory.js';
import { projectWorld } from '../src/world/index.js';

const ev = (id: string, tick: number, kind: ChronicleEvent['kind'] = 'invention', text = 'Duna descubrió algo.'): ChronicleEvent =>
  ({ id, tick, kind, actors: [], text, cause: 'Prueba.', source: 'simulation' });

test('M5: el búfer acumula sin duplicados, en orden, acotado, y conserva los hitos al podar', () => {
  const buffer = new CronicaBuffer(50, 10);
  assert.equal(buffer.acumular([ev('a', 1), ev('b', 2)]), 2);
  assert.equal(buffer.acumular([ev('b', 2), ev('c', 3)]), 1, 'un episodio repetido entre estados no se duplica');
  assert.deepEqual(buffer.todos().map(e => e.id), ['a', 'b', 'c']);
  buffer.acumular([ev('nacimiento', 4, 'birth', 'Olmo 7 nació del vínculo entre Duna y Lino.')]);
  for (let i = 0; i < 200; i++) buffer.acumular([ev(`x${i}`, 10 + i)]);
  assert.ok(buffer.size <= 50, `acotado: ${buffer.size}`);
  assert.ok(buffer.get('nacimiento'), 'el hito viejo sobrevive a 200 inventos posteriores');
  assert.equal(buffer.get('a'), undefined, 'lo común más viejo se olvida primero');
  assert.deepEqual(filtrar(buffer.todos(), 'hitos').map(e => e.id), ['nacimiento']);
});

test('M5: el momento se dice en días y pasos, con el mismo día que projectWorld', () => {
  assert.equal(momento(5496), 'Día 3 · paso 5.496');
  assert.equal(momento(0), 'Día 1 · paso 0');
});

test('M5: todos los episodios de un mundo sembrado real reciben una etiqueta específica', () => {
  const world = createWorld(51926), vistos: ChronicleEvent[] = [], ids = new Set<string>();
  for (let i = 0; i < 500; i++) { stepWorld(world); for (const e of world.events) if (!ids.has(e.id)) { ids.add(e.id); vistos.push(e as ChronicleEvent); } }
  assert.ok(vistos.length > 20, `episodios: ${vistos.length}`);
  const genericas = new Set(['Episodio', 'Invención', 'Comunidad', 'Cooperación', 'Vida animal']);
  const sinEtiqueta = vistos.filter(e => genericas.has(clasificar(e).etiqueta)).map(e => `${e.kind}: ${e.text}`);
  assert.deepEqual(sinEtiqueta, [], 'si world/*.ts cambia una plantilla, esta prueba lo detecta');
  const kinds = new Set(vistos.map(e => e.kind));
  if (kinds.has('care')) assert.equal(clasificar(vistos.find(e => e.kind === 'care')!).etiqueta, 'Compartió comida');
  if (kinds.has('invention')) assert.equal(clasificar(vistos.find(e => e.kind === 'invention' && e.text.includes(' descubrió '))!).grupo, 'tecnica');
});

/** Dos vecinos con hambre urgente, el mismo destino con una fuente casi agotada y comunidad: la ley de society.ts. */
function disputa(trust: number): { world: World; event: ChronicleEvent; person: World['people'][number]; other: World['people'][number] } {
  const world = createWorld(51926);
  const [person, other] = world.people.filter(p => p.role === 'neighbor');
  const tile = world.tiles.find(t => t.terrain !== 'water')!;
  tile.food = 0.03;
  world.communities.push({ id: 'c-a', name: 'A', x: tile.x, y: tile.y, color: '#888888', members: [person!.id], culture: { sharing: .5, stewardship: .5, openness: .1 }, formedAt: 0, cooperation: 0, disputes: 0 });
  world.communities.push({ id: 'c-b', name: 'B', x: tile.x, y: tile.y, color: '#999999', members: [other!.id], culture: { sharing: .5, stewardship: .5, openness: .1 }, formedAt: 0, cooperation: 0, disputes: 0 });
  for (const [p, c] of [[person!, 'c-a'], [other!, 'c-b']] as const) {
    Object.assign(p, { communityId: c, action: 'eat', target: { x: tile.x, y: tile.y }, x: tile.x, y: tile.y, hunger: 0.9, thirst: 0.2, lastDispute: -10_000 });
    p.culture.openness = 0.1;
  }
  person!.bonds[other!.id] = trust; other!.bonds[person!.id] = trust;
  let emitted: ChronicleEvent | undefined;
  const ok = resourceDispute(world, person!, e => { emitted = { ...e, id: 'e-1', tick: world.tick } as ChronicleEvent; return emitted; });
  assert.ok(ok && emitted, 'la ley produjo el episodio');
  return { world, event: emitted!, person: person!, other: other! };
}

test('M5: «cedió» coincide con quien se retira en un resourceDispute real (desacuerdo y turno)', () => {
  const conflicto = disputa(0.1);
  assert.equal(conflicto.event.kind, 'conflict');
  // Quién cede depende de la ley vigente (reglas 11: cede quien menos lo necesita), así que la etiqueta se
  // contrasta con quien de verdad se retira en el mundo, no con el orden de los argumentos.
  const cedio = quienCedio(conflicto.event)!;
  assert.equal(cedio.cede, [conflicto.person.id, conflicto.other.id].sort().at(-1), 'con igual necesidad, reglas 11 hace ceder al id mayor');
  const [cede, sigue] = cedio.cede === conflicto.person.id ? [conflicto.person, conflicto.other] : [conflicto.other, conflicto.person];
  assert.equal(cedio.cede, cede.id);
  assert.equal(cede.action, 'retreat', 'quien cede se retira');
  assert.match(cede.reason, /cede el intento|Cedió una fuente escasa/);
  assert.equal(cedio.sigue, sigue.id);
  assert.notEqual(sigue.action, 'retreat');
  assert.equal(clasificar(conflicto.event).etiqueta, 'Desacuerdo');
  const turno = disputa(0.9);
  assert.equal(turno.event.kind, 'cooperation');
  assert.equal(clasificar(turno.event).etiqueta, 'Se turnaron');
  const espera = quienCedio(turno.event)!;
  const quienEspera = espera.cede === turno.person.id ? turno.person : turno.other;
  assert.equal(espera.cede, quienEspera.id);
  // En reglas 11 el motivo del turno nombra la necesidad del vecino que accede primero.
  assert.match(quienEspera.reason, /su vecino lo necesita más y accede primero/);
});

class Memoria { values = new Map<string, string>(); getItem(k: string) { return this.values.get(k) ?? null; } setItem(k: string, v: string) { this.values.set(k, v); } }

test('M5: visita v3 con contadores; la v2 sigue leyéndose y otro mundo no mezcla contadores ni hitos', () => {
  const storage = new Memoria();
  const a = { instanceId: '11111111-1111-4111-8111-111111111111', tick: 300 }, b = { instanceId: '22222222-2222-4222-8222-222222222222', tick: 300 };
  saveWorldVisit(storage, a);
  assert.equal(readWorldVisit(storage, { ...a, tick: 500 }), 300, 'la v2 sigue funcionando');
  assert.equal(readVisitCounters(storage, a), null, 'sin v3 guardada, no hay contadores: no se inventan');
  const counters = { tick: 300, births: 4, deaths: 1, conflicts: 0, regions: 6, recipes: 40 };
  saveVisitCounters(storage, a, counters);
  assert.deepEqual(readVisitCounters(storage, { ...a, tick: 500 }), counters);
  assert.equal(readVisitCounters(storage, b), null, 'otro mundo no hereda contadores');
  assert.equal(readVisitCounters(storage, { ...a, tick: 100 }), null, 'un marcador del futuro no se acepta');
  saveHitos(storage, a, Array.from({ length: 120 }, (_, i) => ({ id: `h${i}`, tick: i, kind: 'birth', text: `Nació ${i}.` })));
  const hitos = readHitos(storage, a);
  assert.equal(hitos.length, MAX_HITOS_GUARDADOS);
  assert.equal(hitos[0]!.id, 'h40', 'se guardan los más recientes');
  assert.deepEqual(readHitos(storage, b), []);
  const denied = { getItem(): string { throw new Error('denegado'); }, setItem(): void { throw new Error('denegado'); } };
  assert.doesNotThrow(() => { saveVisitCounters(denied, a, counters); saveHitos(denied, a, []); });
  assert.equal(readVisitCounters(denied, a), null); assert.deepEqual(readHitos(denied, a), []);
});

test('M5: «Desde tu última visita» dice lo que cambió con contadores del estado real', () => {
  const world = createWorld(51926);
  for (let i = 0; i < 60; i++) stepWorld(world);
  const view = projectWorld(world);
  const now = contadoresDe(view)!;
  const prev = { ...now, tick: 0, births: now.births - 3, regions: now.regions - 2, recipes: now.recipes };
  view.demography = { deaths: now.deaths + 1, causes: {}, recent: [{ id: 'descendant-3', name: 'Olmo 3', generation: 1, parents: [], bornAt: 0, diedAt: 30, cause: 'dehydration' }] };
  const r = resumenDesdeVisita(prev, 0, view);
  assert.match(r.dias, /^Pasaron 60 pasos del mundo\.$/, 'menos de una décima de día se dice en pasos');
  assert.ok(r.cambios.includes('+3 nacimientos'));
  assert.ok(r.cambios.includes('1 vida terminó (Olmo 3, de sed)'));
  assert.ok(r.cambios.includes('+2 regiones'));
  assert.equal(resumenDesdeVisita(null, 0, view).cambios.filter(c => c.startsWith('+')).length, 0, 'sin contadores guardados no se afirman diferencias');
});
