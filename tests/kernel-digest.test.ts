import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { EcosystemKernel } from '../src/world/ecosystem-kernel.js';
import { initializeEcosystem } from '../src/world/ecosystem.js';
import { generateChunk } from '../src/world/terrain.js';
import type { Tile } from '../src/shared/types.js';

/**
 * Control bit a bit del bucle caliente (R4, perfilado del kernel de ecología).
 *
 * El trabajo de R4 es de COSTE, no de ley: reordenar el kernel (`ecosystem-kernel.ts`) para que
 * deje de reconstruir índices de cadena y de copiar seis instantáneas por tesela no puede mover ni
 * un bit del mundo. Este test congela ese contrato con una huella SHA-256 de `tiles`, `people` y
 * `animals` tras 600 pasos de la semilla pública (51926, `app.ts:84`), más una del kernel aislado
 * sobre un mapa de 25 chunks. Si una optimización cambia el resultado, aquí se ve en un test de
 * ~2 s en vez de en `tests/world.test.ts` (varios minutos) o, peor, en el despliegue.
 *
 * Las huellas se tomaron en 99fac6d (antes de tocar el kernel). Si una tarea cambia una LEY a
 * propósito, este control debe actualizarse EN EL MISMO commit que la ley, citando la evidencia:
 * nunca al revés.
 */
const huella = (valor: unknown): string => createHash('sha256').update(JSON.stringify(valor)).digest('hex').slice(0, 16);
const huellaMundo = (world: World): string => huella({ tiles: world.tiles, people: world.people, animals: world.animals });

test('600 pasos de la semilla pública conservan la huella del mundo (coste ≠ ley)', () => {
  const world = createWorld(51926);
  for (let paso = 0; paso < 600; paso++) stepWorld(world);
  assert.equal(world.tiles.length, 3584);
  assert.equal(world.people.length, 18);
  assert.equal(world.animals.length, 111);
  assert.equal(huellaMundo(world), 'ad80ea717de47c3a');
});

/** Mapa de 25 chunks (6400 teselas) directamente contra el kernel: aísla el bucle caliente del
 * resto del paso, con el mismo régimen mixto de lluvia y fases que usa el mundo. */
test('240 actualizaciones del kernel sobre 6400 teselas conservan su huella', () => {
  const tiles: Tile[] = [];
  for (let c = 0; c < 25; c++) tiles.push(...generateChunk(51926, (c % 5) * 16, Math.floor(c / 5) * 16).tiles.map(tile => initializeEcosystem(51926, tile)));
  assert.equal(tiles.length, 6400);
  const kernel = new EcosystemKernel();
  for (let n = 0; n <= 240; n++) {
    kernel.step(tiles, n * 10, n % 3 === 0 ? 'rain' : 'clear', ['day', 'day', 'dusk', 'night'][n % 4]!,
      { decaimientoFertilidad: 0.001, seed: 51926, cuencas: 0.4 });
  }
  assert.equal(kernel.cachedTopologyCount, 1);
  assert.equal(huella(tiles), 'deabb0731215da45');
});
