import { createWorld } from '../../src/world/index.js';
import { captureTechnologyCheckpoint } from '../../src/world/technology-checkpoint.js';

/** Synthetic validation load, not a population reached by simulated reproduction. */
export function validationFixture(population: number, bonds = 64) {
  if (!Number.isInteger(population) || population < 16) throw new Error('Population must be >= 16.');
  const world = createWorld(51926), source = world.people[2]!;
  while (world.people.length < population) {
    const person = structuredClone(source);
    person.id = `validation-${world.people.length}`;
    world.people.push(person);
  }
  for (const [slot, person] of world.people.entries()) {
    person.bonds = Object.fromEntries(Array.from({ length: Math.min(bonds, population - 1) }, (_, offset) =>
      [world.people[(slot + offset + 1) % population]!.id, 0.5]));
  }
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'initial');
  return world;
}
