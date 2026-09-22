import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/index.js';
import { expressGenome } from '../src/world/genetics.js';
import { parseParams } from '../src/world/params.js';

test('fictional founders express their inherited alleles like descendants, over four seeds', () => {
  for (const seed of [1, 4, 7, 51926]) {
    const world = createWorld(seed);
    for (const person of world.people.filter(person => person.role === 'neighbor')) {
      assert.deepEqual(person.traits, expressGenome(person.genome));
      assert.equal(person.curiosity, person.traits.curiosity);
      assert.equal(person.sociability, person.traits.sociability);
      assert.equal(person.generosity, person.traits.care);
    }
    // Genetic heterogeneity must not rewrite the authored characterization of S/I.
    const neutral = createWorld(seed, parseParams('genes.varianzaFundadores=0'));
    for (const person of world.people.filter(person => person.role !== 'neighbor')) {
      assert.deepEqual(person.traits, neutral.people.find(other => other.id === person.id)!.traits);
    }
  }
});
