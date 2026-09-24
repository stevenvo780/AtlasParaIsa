import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, phaseAt, TICKS_PER_DAY } from '../src/world/index.js';
import { demographicTraits } from '../src/world/demography.js';
import { EcosystemKernel } from '../src/world/ecosystem-kernel.js';
import { enCuenca } from '../src/world/agua.js';
import { capacidadLocal, hacinamientoLocal, intervaloCumplido, reposicionLocal } from '../src/world/natalidad.js';
import { parseParams } from '../src/world/params.js';
import type { Tile } from '../src/shared/types.js';

const tile = (x = 0, y = 0, changes: Partial<Tile> = {}): Tile => ({ x, y, terrain: 'meadow', biome: 'grassland',
  moisture: 0.8, vegetation: 0.8, food: 0.5, feature: 'pool', fertility: 0.7, drinkingWater: 0.5, ...changes });

function escena() {
  const world = createWorld(42, parseParams('agua.cuencas=1'));
  world.tiles = [tile()]; world.structures = []; world.people = [];
  return world;
}

test('6: el intervalo empieza exactamente en ceil(T/(1−x)); x≥1 y K=0 bloquean', () => {
  const world = escena(), p = createWorld(42).people.find(p => p.role === 'neighbor')!;
  const T = demographicTraits(p.genome, parseParams('').cuerpo).fertilityCooldown;
  p.lastBirth = 100; world.tick = p.lastBirth + Math.ceil(T / 0.5) - 1;
  assert.equal(intervaloCumplido(world, p, 0.5), false);
  world.tick++;
  assert.equal(intervaloCumplido(world, p, 0.5), true);
  assert.equal(intervaloCumplido(world, p, 1), false);
  assert.equal(intervaloCumplido(world, p, Infinity), false);
  world.tiles = [tile(0, 0, { feature: 'none', moisture: 0, vegetation: 0 })];
  world.people = [p];
  assert.equal(hacinamientoLocal(world, { x: 0, y: 0 }, 4, 1), Infinity);
});

test('7 y 10: más consumidores retrasan; manantial y fertilidad ayudan; fuentes inválidas aportan cero', () => {
  const world = escena(), c = { x: 0, y: 0 };
  const base = reposicionLocal(world, c, 4);
  assert.ok(base.agua > 0 && base.comida > 0);
  const p = createWorld(42).people[0]!;
  p.x = p.y = 0;
  world.people = [p];
  const x1 = hacinamientoLocal(world, c, 4, 1);
  world.people.push({ ...p, id: 'extra' });
  const x2 = hacinamientoLocal(world, c, 4, 1);
  assert.ok(x2 > x1);
  world.people.push({ ...p, id: 'S-local', role: 'S' }, { ...p, id: 'I-local', role: 'I' });
  const K = capacidadLocal(base, 1);
  assert.ok(Math.abs(hacinamientoLocal(world, c, 4, 1) - x2 - 2 / K) < 1e-12);
  world.people = [];
  world.tiles.push(tile(1, 0));
  assert.ok(reposicionLocal(world, c, 4).agua > base.agua, 'una segunda charca en cuenca añade agua');
  world.tiles = world.tiles.slice(0, 1);
  world.tiles.push(tile(1, 0, { feature: 'spring' }));
  assert.ok(reposicionLocal(world, c, 4).agua > base.agua);
  world.tiles = [tile(0, 0, { fertility: 0.9 })];
  assert.ok(reposicionLocal(world, c, 4).agua > base.agua);
  world.tiles = [tile(0, 0, { feature: 'none' })];
  assert.equal(reposicionLocal(world, c, 4).agua, 0);
  world.tiles = [tile(0, 0, { terrain: 'water' })];
  assert.deepEqual(reposicionLocal(world, c, 4), { agua: 0, comida: 0 });
  const fuera = createWorld(42, parseParams('agua.cuencas=0.05'));
  fuera.tiles = [tile()]; fuera.structures = [];
  if (enCuenca(fuera.seed, 0, 0, 0.05)) {
    // Busca una celda sin cuenca para que la aserción no dependa de este punto arbitrario.
    for (let x = 1; x < 100; x++) if (!enCuenca(fuera.seed, x, 0, 0.05)) { fuera.tiles = [tile(x, 0)]; break; }
  }
  const t = fuera.tiles[0]!;
  assert.equal(enCuenca(fuera.seed, t.x, t.y, 0.05), false);
  assert.equal(reposicionLocal(fuera, t, 4).agua, 0);
  world.tiles = [tile(0, 0, { terrain: 'shelter', feature: 'none' })];
  const structure = { ...createWorld(42).structures[0]!, x: 0, y: 0, condition: 0.1,
    components: ['frame', 'roof', 'cistern'] as ('frame' | 'roof' | 'cistern')[] };
  // Una estructura rota jamás capta lluvia.
  world.structures = [structure];
  assert.equal(reposicionLocal(world, c, 4).agua, 0);
});

test('11: una charca simulada por el kernel sigue la recarga media esperada', () => {
  const world = escena(), estimate = reposicionLocal(world, { x: 0, y: 0 }, 4).agua;
  const pool = tile(), kernel = new EcosystemKernel();
  const days = 120;
  let weather: 'rain' | 'clear' = 'clear', rng = 42, gained = 0;
  for (let tick = 10; tick <= days * TICKS_PER_DAY; tick += 10) {
    if (tick % 600 === 0) { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; weather = rng / 4294967296 < 0.4 ? 'rain' : 'clear'; }
    pool.drinkingWater = 0.5;
    pool.fertility = 0.7;
    kernel.step([pool], tick, weather, phaseAt(tick), { seed: world.seed, cuencas: 1 });
    gained += pool.drinkingWater! - 0.5;
  }
  assert.ok(Math.abs(gained / days - estimate) < estimate * 0.09, `${gained / days} frente a ${estimate}`);
});
