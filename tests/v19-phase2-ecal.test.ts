import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, ecology } from '../src/world/index.js';
import { regionalClimateFactor } from '../src/world/clima.js';
import { initialPolicyPlasticity, updatePolicyPlasticityCausal } from '../src/world/politica.js';
import { parseParams, setParams } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { fundador, mundo, paso, tile } from './v19-phase1-fauna-fixture.js';

test('E: clima regional determinista, sin RNG, acotado, con contraste espacial/temporal y media cercana a 1', () => {
  const random = Math.random;
  Math.random = () => { throw new Error('the climate field must not use Math.random'); };
  try {
    assert.deepEqual(regionalClimateFactor(42, 1200, -33, 85, 0), { rainScale: 1, evapScale: 1, growthScale: 1 });
    const first = regionalClimateFactor(42, 1200, 16, 16, 0.25);
    assert.deepEqual(first, regionalClimateFactor(42, 1200, 16, 16, 0.25));
    const regions = Array.from({ length: 64 }, (_, i) => regionalClimateFactor(42, 12_000, (i % 8) * 64, Math.floor(i / 8) * 64, 0.25));
    const dry = regionalClimateFactor(42, 0, 0, 0, 0.25), wet = regionalClimateFactor(42, 12_000, 0, 0, 0.25);
    assert.ok(Math.max(...regions.map(x => x.rainScale)) - Math.min(...regions.map(x => x.rainScale)) > 0.1);
    assert.ok(Math.abs(dry.rainScale - wet.rainScale) > 0.2);
    for (const factor of [...regions, dry, wet]) for (const value of Object.values(factor)) assert.ok(value >= 0.75 && value <= 1.25);
    const temporal = Array.from({ length: 20 }, (_, i) => regionalClimateFactor(42, i * 2400, 0, 0, 0.25));
    for (const key of ['rainScale', 'evapScale'] as const) {
      const mean = temporal.reduce((sum, value) => sum + value[key], 0) / temporal.length;
      assert.ok(Math.abs(mean - 1) < 1e-12, `${key} mean = ${mean}`);
    }
  } finally { Math.random = random; }
});

test('E=0: ecología con la clave explícita reproduce el mismo estado V18 que los parámetros por defecto', () => {
  const a = createWorld(42);
  const b = cloneWorld(a);
  setParams(a, parseParams('ecologia.amplitudEstacional=0'));
  for (const world of [a, b]) { world.tick = 10; ecology(world); }
  assert.equal(digestoCanonico(a), digestoCanonico(b));
});

test('R: herbívoros reservan biomasa ingerida con suficiente rapidez para el cooldown, sin inventarla', () => {
  for (const species of ['hare', 'deer', 'boar', 'fish'] as const) {
    const animal = fundador(species, 1, 1, `calibrated-${species}`);
    animal.hunger = 0.6;
    animal.action = 'graze'; animal.lastDecision = 1_000_000; animal.target = { x: 1, y: 1 };
    const tiles = Array.from({ length: 9 }, (_, i) => tile(i % 3, Math.floor(i / 3)));
    const world = mundo(tiles, [animal], 'fauna.reservaReproductiva=true');
    let reached = 0;
    for (let tick = 1; tick <= 450 && (animal.reproReserve ?? 0) < 0.03; tick++) { paso(world); reached = tick; }
    assert.ok((animal.reproReserve ?? 0) >= 0.03, `${species} reserve by tick ${reached}`);
    assert.ok(animal.reproReserve! <= 0.12);
    assert.ok(Math.abs(animal.reproReserve! - Math.min(0.12, world.animalDynamics.plantConsumed * 0.6)) < 1e-12,
      `${species} reserve is debited from ingested plants`);
  }
});

test('L: una entrega de servicio observada causa aprendizaje positivo y un intento fallido aprendizaje negativo', () => {
  const positive = initialPolicyPlasticity(), negative = initialPolicyPlasticity();
  const body: [number, number, number, number] = [0.3, 0.2, 0.1, 0.8];
  updatePolicyPlasticityCausal(positive, 'share', 'ready', body, 0, 2400, 0.2);
  updatePolicyPlasticityCausal(negative, 'repair', 'ready', body, 0, 2400, 0.2);
  updatePolicyPlasticityCausal(positive, 'share', 'ready', body, 30, 2400, 0.2, 0.2);
  updatePolicyPlasticityCausal(negative, 'repair', 'ready', body, 30, 2400, 0.2, -0.2);
  assert.ok(positive.bias[6]! > 0, 'witnessed share has positive contextual credit');
  assert.ok(negative.bias[11]! < 0, 'failed repair has negative prediction error');
});
