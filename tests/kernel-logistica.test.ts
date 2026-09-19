import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, ecology, phaseAt, TICKS_PER_DAY, type World } from '../src/world/index.js';
import { initializeEcosystem, stepEcosystem } from '../src/world/ecosystem.js';
import { DEFAULT_PARAMS, paramsOf } from '../src/world/params.js';
import { generateChunk } from '../src/world/terrain.js';
import type { Tile } from '../src/shared/types.js';

/**
 * Ley logística CON el kernel dentro (R4, segunda mitad del hallazgo).
 *
 * `tests/recursos.test.ts` comprueba la capacidad de carga ejecutando SOLO `ecology()`; el paso real
 * (`stepWorld`) ejecuta además `EcosystemKernel.step`, que suma `produced · 0,25` a `vegetation` sin
 * ningún término de capacidad (`ecosystem-kernel.ts`, línea de `tile.vegetation`). El hallazgo dice
 * que por eso la vegetación «se estabiliza por encima de la capacidad de carga». Aquí se mide con
 * las dos leyes juntas, que es como corren de verdad.
 *
 * Resultado medido (y lo que fija este test): NO se estabiliza por encima. La fuerza restauradora de
 * `ecology` (`headroom = 1 − vegetation/K` se vuelve negativa por encima de K) domina al aporte del
 * kernel, y en cinco días toda celda de tierra queda en K o por debajo, arranque donde arranque.
 * Lo que sí está por encima de K es el terreno RECIÉN GENERADO: `generateTile` no conoce `K`, así
 * que cada chunk que se activa entra con celdas por encima de su capacidad y tarda días en bajar.
 * Esa es la procedencia real de las celdas sobre-capacidad que se ven en un mundo vivo.
 */
const capacidad = (tile: Tile): number => tile.biome === 'forest' ? DEFAULT_PARAMS.recursos.capacidadBosque
  : tile.biome === 'grassland' ? DEFAULT_PARAMS.recursos.capacidadPastizal : DEFAULT_PARAMS.recursos.capacidadOtros;

function mundo(tiles: Tile[]): World {
  const world = createWorld(51926);
  world.tiles = tiles; world.people = []; world.animals = []; world.structures = [];
  return world;
}

/** El paso real: la misma pareja `ecology` + `stepEcosystem` que ejecuta `stepWorld`. */
function dias(world: World, cuantos: number): void {
  const params = paramsOf(world);
  for (let paso = 0; paso < cuantos * TICKS_PER_DAY; paso++) {
    world.tick++;
    ecology(world);
    stepEcosystem(world.tiles, world.tick, world.weather, phaseAt(world.tick), false,
      { decaimientoFertilidad: params.recursos.decaimientoFertilidad, seed: world.seed, cuencas: params.agua.cuencas });
  }
}

const tierra = (tiles: readonly Tile[]): Tile[] => tiles.filter(tile => tile.terrain !== 'water');
const sobreCapacidad = (tiles: readonly Tile[]): Tile[] => tierra(tiles).filter(tile => tile.vegetation > capacidad(tile) + 1e-9);

test('el kernel no sostiene vegetación por encima de la capacidad de carga: desde K, cinco días la devuelven a K o menos', () => {
  const tiles = generateChunk(51926, 0, 0).tiles.map(tile => initializeEcosystem(51926, tile));
  // Arranque adversarial: toda celda de tierra justo EN su capacidad, que es donde `ecology` deja de
  // empujar (`headroom = 0`) y solo queda el aporte sin tope del kernel.
  for (const tile of tierra(tiles)) tile.vegetation = capacidad(tile);
  const world = mundo(tiles);
  dias(world, 5);
  const excedidas = sobreCapacidad(tiles);
  assert.equal(excedidas.length, 0,
    `${excedidas.length} celdas quedaron por encima de su capacidad; la mayor, ${excedidas[0]?.biome} con ${excedidas[0]?.vegetation}`);
  // Y no es que todo se haya apagado: el mundo sigue vivo cerca del techo.
  const media = tierra(tiles).reduce((suma, tile) => suma + tile.vegetation / capacidad(tile), 0) / tierra(tiles).length;
  assert.ok(media > 0.5, `la vegetación media relativa cayó a ${media}: el control adversarial dejó de ser informativo`);
});

test('el exceso de capacidad que se ve en un mundo vivo lo trae el generador, no el kernel', () => {
  // Censo del terreno recién generado (25 chunks dispersos, sin simular ni un paso): una de cada
  // ocho celdas de tierra NACE por encima de su capacidad de carga, hasta 2,2 × K.
  let tierraGenerada = 0, sobreGenerada = 0;
  for (let cx = -40; cx <= 40; cx += 20) for (let cy = -40; cy <= 40; cy += 20) {
    const chunk = generateChunk(51926, cx, cy).tiles.map(tile => initializeEcosystem(51926, tile));
    tierraGenerada += tierra(chunk).length; sobreGenerada += sobreCapacidad(chunk).length;
  }
  assert.ok(sobreGenerada / tierraGenerada > 0.1,
    `solo el ${(100 * sobreGenerada / tierraGenerada).toFixed(1)} % del terreno nace por encima de K: revísese la procedencia documentada`);
  // Y la ley real absorbe ese exceso: el chunk (0,20) nace con sus 256 celdas de tierra por encima
  // de K (hasta 2,12 ×) y a los cinco días no queda ninguna.
  const tiles = generateChunk(51926, 0, 20).tiles.map(tile => initializeEcosystem(51926, tile));
  assert.equal(sobreCapacidad(tiles).length, tierra(tiles).length);
  dias(mundo(tiles), 5);
  assert.equal(sobreCapacidad(tiles).length, 0, 'cinco días de la ley real no bastaron para absorber el exceso del generador');
});
