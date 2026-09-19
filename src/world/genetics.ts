import type { GenomeView, PersonView } from '../shared/types.js';

export interface Genome extends GenomeView { alleles: number[]; }
export const GENE_COUNT = 7;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
/** Como `clamp`, pero el excedente fuera de [0,1] decae de forma continua hacia el borde en vez
 * de pegarse EXACTAMENTE a él (revisión T011: con el clamp duro, dos alelos que se salían de
 * rango por distinto margen podían terminar ambos en el mismo 0 o 1 literal, colapsando a 0 la
 * heterocigosis de ese locus aunque el ruido gaussiano de cada uno fuera distinto — medido:
 * 36,6 % de los alelos fundadores con varianzaFundadores=0.15). `EXCESS_SOFTENING` (0.02) fija
 * la escala del amortiguado: coincide con `clamp` en el borde exacto (continuidad en n=0 y n=1)
 * y para |excedente| grande se acerca asintóticamente a 0/1 sin tocarlos nunca, así que dos
 * excedentes distintos siempre producen alelos distintos. Cambia el resultado en como mucho
 * `EXCESS_SOFTENING` frente al clamp duro, así que no hace falta re-calibrar el factor de `sd`
 * (T011 §4) ni los umbrales de heterocigosis ya verificados. */
const EXCESS_SOFTENING = 0.02;
function softClamp(n: number): number {
  if (n < 0) { const excess = -n; return EXCESS_SOFTENING * excess / (1 + excess); }
  if (n > 1) { const excess = n - 1; return 1 - EXCESS_SOFTENING * excess / (1 + excess); }
  return n;
}
export function localRandom(seed: number, salt: string): () => number {
  let state = seed >>> 0;
  for (const c of salt) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export const DEFAULT_MUTATION_RATE = 0.08;

function gaussian(random: () => number): number {
  const u1 = 1 - random(); // (0,1], evita log(0) = -Infinity
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Seven diploid design loci. They encode model parameters, not human biological traits. */
export function founderGenome(seed: number, id: string, traits: NonNullable<PersonView['traits']>, varianza = 0): Genome {
  const random = localRandom(seed, `genome:${id}`);
  const phenotype = [traits.curiosity, traits.sociability, traits.industriousness, traits.care, traits.resilience, 0.5, 0.2 + random() * 0.65];
  // Factor 1.5 compensa la pérdida de varianza empírica al truncar cerca de [0,1] (T011 §4,
  // verificado con las semillas reales del juego: heterocigosis 0.359/0.402). Sigue siendo un
  // ajuste empírico, no una fórmula cerrada — igual que antes de esta ronda de arreglo; lo único
  // que cambia aquí es softClamp en vez de clamp (ver comentario de softClamp arriba).
  const sd = Math.sqrt(varianza) * 1.5;
  const displaced = (value: number) => varianza === 0 ? value : softClamp(value + gaussian(random) * sd);
  const alleles = phenotype.flatMap(value => [displaced(value), displaced(value)]);
  return { alleles, generation: 0, parents: [], mutations: 0,
    learningRate: 0.04 + ((alleles[10]! + alleles[11]!) / 2) * 0.16, cooperation: (alleles[12]! + alleles[13]!) / 2 };
}
export function expressGenome(genome: Genome): NonNullable<PersonView['traits']> {
  const values = Array.from({ length: GENE_COUNT }, (_, index) => (genome.alleles[index * 2]! + genome.alleles[index * 2 + 1]!) / 2);
  return { curiosity: values[0]!, sociability: values[1]!, industriousness: values[2]!, care: values[3]!, resilience: values[4]! };
}
export function inheritGenome(seed: number, childId: string, parents: { id: string; genome: Genome }[], mutationRate = DEFAULT_MUTATION_RATE): Genome {
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
  if ((g.generation === 0) !== (g.parents.length === 0) || new Set(g.parents).size !== g.parents.length || g.parents.some(id => !id)) throw new Error('Genealogía de simulación inválida.');
}
