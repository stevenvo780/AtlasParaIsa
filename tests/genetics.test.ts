import test from 'node:test';
import assert from 'node:assert/strict';
import { founderGenome, assertGenome, inheritGenome, DEFAULT_MUTATION_RATE, GENE_COUNT, expressGenome, localRandom } from '../src/world/genetics.js';

function mockTraits() {
  return { curiosity: 0.5, sociability: 0.5, industriousness: 0.5, care: 0.5, resilience: 0.5 };
}

test('control bit a bit: varianza 0 produce exactamente el mismo genoma que la versión base', () => {
  const seed = 12345;
  const traits = mockTraits();
  
  // Test with 's'
  const g1 = founderGenome(seed, 's', traits, 0);
  // Manual equivalent of what it should produce without variance
  const random1 = localRandom(seed, `genome:s`);
  const phenotype1 = [traits.curiosity, traits.sociability, traits.industriousness, traits.care, traits.resilience, 0.5, 0.2 + random1() * 0.65];
  const expectedAlleles1 = phenotype1.flatMap(v => [v, v]);
  
  assert.deepEqual(g1.alleles, expectedAlleles1);
  assert.equal(g1.learningRate, 0.12);
  assert.equal(g1.cooperation, phenotype1[6]);
  
  // Test with 'i'
  const g2 = founderGenome(seed, 'i', traits, 0);
  const random2 = localRandom(seed, `genome:i`);
  const phenotype2 = [traits.curiosity, traits.sociability, traits.industriousness, traits.care, traits.resilience, 0.5, 0.2 + random2() * 0.65];
  const expectedAlleles2 = phenotype2.flatMap(v => [v, v]);
  
  assert.deepEqual(g2.alleles, expectedAlleles2);
  assert.equal(g2.learningRate, 0.12);
  assert.equal(g2.cooperation, phenotype2[6]);
});

test('heterocigosis real: varianza 0.15 genera diversidad y heterocigosis', () => {
  const seed = 20260905; // same seed as createWorld
  const ids = ['s', 'i', ...Array.from({ length: 14 }, (_, i) => `neighbor-${i}`)];
  const genomes = ids.map((id, index) => {
    // Generate some diverse traits just to simulate seededTraits roughly, or use constant, 
    // the variance comes from founderGenome anyway.
    const traits = {
      curiosity: 0.4 + (index % 3) * 0.1,
      sociability: 0.4 + (index % 4) * 0.1,
      industriousness: 0.5,
      care: 0.5,
      resilience: 0.5
    };
    return founderGenome(seed, id, traits, 0.15);
  });
  
  // Check >= 12 distinct learningRates
  const rates = new Set(genomes.map(g => g.learningRate.toFixed(6)));
  assert.ok(rates.size >= 12, `Se esperaban >=12 learningRates distintos, se obtuvieron ${rates.size}`);
  
  // Check mean heterozygosity > 0.3
  let totalHeterozygosity = 0;
  for (const g of genomes) {
    for (let gene = 0; gene < GENE_COUNT; gene++) {
      totalHeterozygosity += Math.abs(g.alleles[gene * 2]! - g.alleles[gene * 2 + 1]!);
    }
  }
  const meanHeterozygosity = totalHeterozygosity / (16 * GENE_COUNT);
  assert.ok(meanHeterozygosity > 0.3, `Heterocigosis media ${meanHeterozygosity} debería ser > 0.3`);
});

test('determinismo: misma semilla, id y varianza producen mismo genoma', () => {
  const seed = 999;
  const traits = mockTraits();
  const g1 = founderGenome(seed, 'test-id', traits, 0.2);
  const g2 = founderGenome(seed, 'test-id', traits, 0.2);
  assert.deepEqual(g1, g2);
});

test('rango: varianza alta mantiene todo dentro de rangos válidos', () => {
  const traits = mockTraits();
  // Call 100 times with high variance to ensure no throw
  for (let i = 0; i < 100; i++) {
    const g = founderGenome(i, `test-${i}`, traits, 1.0);
    assert.doesNotThrow(() => assertGenome(g));
  }
});

test('escalado de DEFAULT_MUTATION_RATE', () => {
  const seedBase = 500;
  const parent1 = { id: 'p1', genome: founderGenome(1, 'p1', mockTraits(), 0.1) };
  const parent2 = { id: 'p2', genome: founderGenome(2, 'p2', mockTraits(), 0.1) };
  const parents = [parent1, parent2];
  
  // mutationRate 0 -> 0 mutations
  const childZero = inheritGenome(seedBase, 'c0', parents, DEFAULT_MUTATION_RATE * 0);
  assert.equal(childZero.mutations, 0);
  
  // Check average mutations scale up
  let mutBase = 0;
  let mutHigh = 0;
  const iterations = 50;
  for (let i = 0; i < iterations; i++) {
    const c1 = inheritGenome(seedBase + i, `c1-${i}`, parents, DEFAULT_MUTATION_RATE);
    const c2 = inheritGenome(seedBase + i, `c2-${i}`, parents, DEFAULT_MUTATION_RATE * 5);
    mutBase += c1.mutations;
    mutHigh += c2.mutations;
  }
  
  assert.ok(mutHigh > mutBase, `Tasa alta (${mutHigh}) debería dar más mutaciones que tasa base (${mutBase})`);
});
