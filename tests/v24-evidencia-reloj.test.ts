import test from 'node:test';
import assert from 'node:assert/strict';
import { CronicaBuffer } from '../src/client/cronica.js';
import { evidenceAtTick, recentEvidence } from '../src/client/world-evidence.js';
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
