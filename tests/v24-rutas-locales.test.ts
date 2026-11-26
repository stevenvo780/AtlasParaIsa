import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terrain, Tile } from '../src/shared/types.js';
import { move } from '../src/world/actuar/mover.js';
import { createWorld } from '../src/world/index.js';
import { distance, type Point } from '../src/world/mundo/geometria.js';
import { parseParams } from '../src/world/params.js';

type Ground = (x: number, y: number) => Terrain | undefined;
const key = (x: number, y: number) => `${x},${y}`;
const land: Ground = () => 'meadow';
const tile = (x: number, y: number, terrain: Terrain): Tile => ({ x, y, terrain, moisture: 0.5, vegetation: 0.5, food: 0 });

/** BFS de referencia por coordenadas. La frontera se observa en las consultas, incluyendo las repetidas. */
function reference(start: Point, target: Point, ground: Ground, side?: number) {
  const queue = [start], previous = new Map<string, Point | null>([[key(start.x, start.y), null]]);
  const reads: Point[] = [];
  let head = 0, best = start, bestDistance = distance(start, target);
  while (head < queue.length && head < 2048) {
    const current = queue[head++]!, currentDistance = distance(current, target);
    if (currentDistance < bestDistance) { best = current; bestDistance = currentDistance; }
    if (currentDistance < 0.5) { best = current; break; }
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const x = dx ? current.x + dx : current.x, y = dy ? current.y + dy : current.y;
      if (Math.max(Math.abs(x - start.x), Math.abs(y - start.y)) > 24) continue;
      reads.push({ x, y });
      const terreno = ground(x, y), id = key(x, y);
      if (!terreno || terreno === 'water' || previous.has(id)) continue;
      previous.set(id, current);
      queue.push({ x, y });
    }
  }
  if (side !== undefined && queue.length > 1 && distance(start, target) - distance(best, target) < 1.5) {
    const angle = Math.atan2(target.y - start.y, target.x - start.x) + side;
    const tx = Math.cos(angle), ty = Math.sin(angle);
    let bestDot = -Infinity;
    for (const point of queue.slice(1)) {
      const dot = (point.x - start.x) * tx + (point.y - start.y) * ty;
      if (dot > bestDot) { bestDot = dot; best = point; }
    }
  }
  if (best !== start) {
    while (previous.get(key(best.x, best.y)) !== start) best = previous.get(key(best.x, best.y))!;
    reads.push(best); // El motor consulta la tesela viva una última vez al pisarla.
  }
  return { step: best, reads, processed: head, queued: queue.length };
}

test('la ruta local conserva el orden, los empates, el límite y las teselas de frontera', () => {
  const world = createWorld(7, parseParams({ terreno: { caminosFisicos: false }, social: { vinculoEncuentro: 1 } }));
  const actor = world.people[2]!;
  function check(start: Point, target: Point, ground: Ground, coastTick?: number) {
    const side = coastTick === undefined ? undefined : Math.floor(coastTick / 360) % 2 === 0 ? Math.PI / 2 : -Math.PI / 2;
    world.tick = coastTick ?? 6;
    Object.assign(actor, start, { target, action: side === undefined ? 'gather' : 'approach', command: null,
      lastOutcome: world.tick, energy: 1, fatigue: 0 });
    const expected = reference(start, target, ground, side);
    const observed: Point[] = [];
    move(world, actor, (x, y) => {
      observed.push({ x, y });
      const terrain = ground(x, y);
      return terrain && tile(x, y, terrain);
    }, null);
    assert.deepEqual({ x: actor.x, y: actor.y }, expected.step);
    assert.deepEqual(observed, expected.reads);
    return expected;
  }

  const frontera = { x: 15, y: -1 }, destino = { x: 19, y: 3 };
  assert.deepEqual(check(frontera, destino, land).step, { x: 16, y: -1 });
  const vecinoInundado: Ground = (x, y) => x === 16 && y === -1 ? 'water' : 'meadow';
  assert.deepEqual(check(frontera, destino, vecinoInundado).step, { x: 15, y: 0 });
  const paginaAjena: Ground = x => x < 16 ? 'meadow' : undefined;
  assert.deepEqual(check(frontera, { x: 18, y: -1 }, paginaAjena).step, frontera);
  const amplia = check({ x: 0, y: 0 }, { x: 100, y: 100 }, land);
  assert.equal(amplia.processed, 2048);
  assert.ok(amplia.queued > amplia.processed);
  const costa: Ground = x => x <= 0 ? 'meadow' : 'water';
  assert.deepEqual(check({ x: 0, y: 0 }, { x: 50, y: 0 }, costa, 6).step, { x: 0, y: 1 });
  assert.deepEqual(check({ x: 0, y: 0 }, { x: 50, y: 0 }, costa, 366).step, { x: 0, y: -1 });
  check({ x: -2.5, y: 1.5 }, { x: 3.5, y: 4.5 }, land);
  assert.deepEqual(check({ x: -0, y: 1 }, { x: -0, y: 4 }, land).step, { x: -0, y: 2 });
});

test('una consulta de terreno reentrante conserva ambas rutas', () => {
  const world = createWorld(7);
  const outer = world.people[2]!, inner = world.people[1]!;
  Object.assign(outer, { x: 3, y: 3, target: { x: 8, y: 3 }, action: 'gather' });
  Object.assign(inner, { x: 8, y: 8, target: { x: 8, y: 3 }, action: 'gather' });
  let pending = true;
  move(world, outer, (x, y) => {
    if (pending) {
      pending = false;
      move(world, inner, (ix, iy) => tile(ix, iy, 'meadow'), null);
    }
    return tile(x, y, 'meadow');
  }, null);
  assert.deepEqual({ x: outer.x, y: outer.y }, { x: 4, y: 3 });
  assert.deepEqual({ x: inner.x, y: inner.y }, { x: 8, y: 7 });
});
