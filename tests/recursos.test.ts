import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { createWorld, ecology, stepWorld, TICKS_PER_DAY } from '../src/world/index.js';
import { parseParams, type WorldParams } from '../src/world/params.js';
import { generateChunk } from '../src/world/terrain.js';
import { distanciaMediaAgua, fraccionCeldasConComida, giniRecursosPorRegion } from '../src/world/statistics.js';

const tile = (x: number, y: number, food: number, changes: Partial<Tile> = {}): Tile => ({ x, y, terrain: 'meadow', moisture: 0, vegetation: 0, food, ...changes });

/** Mapa amplio y diverso (25 chunks dispersos): el mundo cargado alrededor de una persona es
 * una meseta hospitalaria y no representa la desigualdad del terreno. */
function diverseTiles(seed: number): Tile[] {
  const tiles: Tile[] = [];
  for (let cx = -40; cx <= 40; cx += 20) for (let cy = -40; cy <= 40; cy += 20) tiles.push(...generateChunk(seed, cx, cy).tiles);
  return tiles;
}

/** Diez días de la ley real `ecology` sobre ese mapa, sin habitantes que cosechen ni fauna que paste. */
function tenDays(seed: number, params?: WorldParams): Tile[] {
  const world = createWorld(seed, params);
  world.tiles = diverseTiles(seed); world.people = []; world.animals = [];
  for (let tick = 0; tick < 10 * TICKS_PER_DAY; tick++) { world.tick++; ecology(world); }
  return world.tiles;
}

const capacityOf = (tile: Tile, params: WorldParams): number => tile.biome === 'forest' ? params.recursos.capacidadBosque
  : tile.biome === 'grassland' ? params.recursos.capacidadPastizal : params.recursos.capacidadOtros;
const landOf = (tiles: readonly Tile[]): Tile[] => tiles.filter(tile => tile.terrain !== 'water');
const meanFood = (tiles: readonly Tile[]): number => { const land = landOf(tiles); return land.reduce((sum, tile) => sum + tile.food, 0) / land.length; };

test('implicit and explicit default resource parameters preserve the complete world bit for bit after two days', () => {
  const implicit = createWorld(51926), explicit = createWorld(51926, parseParams(''));
  for (let tick = 0; tick < 2 * TICKS_PER_DAY; tick++) { stepWorld(implicit); stepWorld(explicit); }
  assert.deepStrictEqual(implicit, explicit);
});

/* Evidencia de T013 / hallazgo C6. MEDIDO el 2026-09-19 (semilla 51926, 6 400 celdas, 10 días):
 * control  → fracción con food>0.1 = 1,000 · Gini regional = 0,000 · comida media = 0,962 (el «recursos
 *            en todos lados» que denuncia C6: sin capacidad, toda celda satura en 1).
 * T013     → fracción = 1,000 · Gini regional = 0,283 · comida media = 0,523 · ninguna celda sobre su K.
 * La banda «fracción entre 30 % y 70 % y Gini ≥ 0,35» que pedía el brief NO se cumple y NO es alcanzable
 * con esos parámetros: `moisture` no depende del bioma y la lluvia (40 % de las ventanas) la homogeneiza
 * hacia ~0,64 en TODAS las celdas, así que cada celda alcanza su K y, siendo todo K ≥ 0,1, la fracción
 * queda forzada a 1 sea cual sea la semilla o la región. Bajarla exigiría K < 0,1 o humedad por bioma:
 * queda reportado como tarea aparte. Aquí se afirma lo que la ley sí garantiza, y sigue siendo refutable:
 * si se quita la capacidad, la comida media vuelve a ~0,96 y el Gini se desploma a ~0. */
test('finite biome capacities bind the ten-day harvest and open regional inequality', () => {
  const seed = 51926, params = parseParams('recursos.capacidadOtros=0.2,recursos.capacidadPastizal=0.5,recursos.decaimientoFertilidad=0.001');
  const finite = tenDays(seed, params), control = tenDays(seed);
  const overCapacity = landOf(finite).filter(tile => tile.food > capacityOf(tile, params) + 1e-9 || tile.vegetation > capacityOf(tile, params) + 1e-9);
  assert.equal(overCapacity.length, 0, `${overCapacity.length} celdas superaron su capacidad de carga`);
  const gini = giniRecursosPorRegion(finite), giniControl = giniRecursosPorRegion(control);
  assert.ok(giniControl < 0.05, `sin capacidad el reparto es uniforme: Gini ${giniControl}`);
  assert.ok(gini >= 0.15 && gini > giniControl * 10, `la capacidad por bioma debe abrir desigualdad regional: Gini ${gini} frente a ${giniControl}`);
  assert.ok(meanFood(control) > 0.9, `sin capacidad la comida satura: media ${meanFood(control)}`);
  assert.ok(meanFood(finite) < meanFood(control) * 0.75, `la capacidad debe recortar la comida media: ${meanFood(finite)} frente a ${meanFood(control)}`);
  assert.equal(fraccionCeldasConComida(control), 1, 'el control satura todas las celdas de tierra (sintoma C6)');
});

test('resource statistics are pure and match hand-calculated examples', () => {
  const uniform = [tile(0, 0, 1), tile(16, 0, 1)];
  const concentrated = [tile(0, 0, 1), tile(16, 0, 0), tile(32, 0, 0), tile(48, 0, 0)];
  assert.equal(giniRecursosPorRegion(uniform), 0); assert.equal(giniRecursosPorRegion(concentrated), 0.75);
  const food = [tile(0, 0, 0.2), tile(1, 0, 0.1), tile(2, 0, 0.10001), tile(3, 0, 1, { terrain: 'water' })];
  assert.equal(fraccionCeldasConComida(food), 2 / 3);
  const grid: Tile[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) grid.push(tile(x, y, 0, x === 0 && y === 0 ? { terrain: 'water' } : {}));
  assert.equal(distanciaMediaAgua(grid), 18 / 8);
  assert.equal(distanciaMediaAgua([tile(0, 0, 0), tile(1, 0, 0)]), -1);
  assert.deepStrictEqual(uniform, [tile(0, 0, 1), tile(16, 0, 1)]);
});
