import type { GenomeView, PersonView } from '../shared/types.js';

export interface Genome extends GenomeView { alleles: number[]; }
export const GENE_COUNT = 7;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function localRandom(seed: number, salt: string): () => number {
  let state = seed >>> 0;
  for (const c of salt) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
/** Seven diploid design loci. They encode model parameters, not human biological traits. */
export function founderGenome(seed: number, id: string, traits: NonNullable<PersonView['traits']>): Genome {
  const random = localRandom(seed, `genome:${id}`);
  const phenotype = [traits.curiosity, traits.sociability, traits.industriousness, traits.care, traits.resilience, 0.5, 0.2 + random() * 0.65];
  const alleles = phenotype.flatMap(value => [value, value]);
  return { alleles, generation: 0, parents: [], mutations: 0, learningRate: 0.12, cooperation: phenotype[6]! };
}
export function expressGenome(genome: Genome): NonNullable<PersonView['traits']> {
  const values = Array.from({ length: GENE_COUNT }, (_, index) => (genome.alleles[index * 2]! + genome.alleles[index * 2 + 1]!) / 2);
  return { curiosity: values[0]!, sociability: values[1]!, industriousness: values[2]!, care: values[3]!, resilience: values[4]! };
}
export function inheritGenome(seed: number, childId: string, parents: { id: string; genome: Genome }[], mutationRate = 0.08): Genome {
  if (parents.length !== 2 || parents[0]!.id === parents[1]!.id || !Number.isFinite(mutationRate) || mutationRate < 0 || mutationRate > 1) throw new Error('Herencia requiere dos progenitores distintos y una tasa válida.');
  const random = localRandom(seed, `inherit:${childId}`), alleles: number[] = [];
  let mutations = 0;
  for (let gene = 0; gene < GENE_COUNT; gene++) for (const parent of parents) {
    let value = parent.genome.alleles[gene * 2 + Math.floor(random() * 2)]!;
    if (random() < mutationRate) { value = clamp(value + (random() - 0.5) * 0.16); mutations++; }
    alleles.push(value);
  }
  return { alleles, generation: Math.max(...parents.map(p => p.genome.generation)) + 1, parents: parents.map(p => p.id), mutations,
    learningRate: 0.04 + ((alleles[10]! + alleles[11]!) / 2) * 0.16, cooperation: (alleles[12]! + alleles[13]!) / 2 };
}
export function assertGenome(genome: unknown): asserts genome is Genome {
  const g = genome as Genome;
  if (!g || !Array.isArray(g.alleles) || g.alleles.length !== GENE_COUNT * 2 || !g.alleles.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) || !Number.isSafeInteger(g.generation) || g.generation < 0 || !Array.isArray(g.parents) || ![0, 2].includes(g.parents.length) || !g.parents.every(id => typeof id === 'string' && id.length < 50) || !Number.isInteger(g.mutations) || g.mutations < 0 || g.mutations > 14 || !Number.isFinite(g.learningRate) || g.learningRate < 0.04 || g.learningRate > 0.2 || !Number.isFinite(g.cooperation) || g.cooperation < 0 || g.cooperation > 1) throw new Error('Genoma de simulación inválido.');
}
