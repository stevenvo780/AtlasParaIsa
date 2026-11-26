import test from 'node:test';
import assert from 'node:assert/strict';
import { CronicaBuffer } from '../src/client/cronica.js';
import { EvidenceTimeline, evidenceAtTick, recentEvidence } from '../src/client/world-evidence.js';
import type { ChronicleEvent, WorldView } from '../src/shared/types.js';

test('la cinta muestra solo episodios hasta el corte sin borrar los recibidos después', () => {
  const event = (tick: number): ChronicleEvent => ({ id: `e${tick}`, tick, kind: 'meeting', actors: ['p'], text: `episodio ${tick}`, cause: 'causa', source: 'simulation' });
  const buffer = new CronicaBuffer();
  buffer.acumular([event(30), event(10), event(20)]);
  const world = { tick: 15, people: [], events: [] } as unknown as WorldView;
  assert.deepEqual(evidenceAtTick(buffer.todos(), world.tick).map(e => e.tick), [10]);
  const earlier = recentEvidence(world, 'p', buffer.todos());
  assert.match(earlier, /episodio 10/);
  assert.doesNotMatch(earlier, /episodio (20|30)/);
  world.tick = 30;
  const later = recentEvidence(world, 'p', buffer.todos());
  assert.match(later, /episodio 20/);
  assert.match(later, /episodio 30/);
  assert.equal(buffer.size, 3);
});

test('el corte se reutiliza entre episodios y cambia con el reloj o una revisión del búfer', () => {
  const timeline = new EvidenceTimeline<{ tick: number }>();
  timeline.setEvents([{ tick: 10 }, { tick: 20 }, { tick: 30 }]);
  const first = timeline.at(11), same = timeline.at(19), next = timeline.at(20);
  assert.strictEqual(first.events, same.events);
  assert.equal(first.key, same.key);
  assert.notEqual(first.key, next.key);
  assert.deepEqual(next.events.map(e => e.tick), [10, 20]);
  assert.deepEqual(timeline.at(9).events, []);
  timeline.setEvents([{ tick: 5 }, { tick: 20 }, { tick: 30 }]);
  const revised = timeline.at(11);
  assert.notEqual(first.key, revised.key);
  assert.deepEqual(revised.events.map(e => e.tick), [5]);
});
