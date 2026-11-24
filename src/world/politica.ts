import { localRandom } from './genetics.js';

export const POLICY_INPUTS = 12;
export const POLICY_HIDDEN = 8;
export const POLICY_ACTIONS = [
  'explore', 'eat', 'forage', 'drink', 'hunt', 'rest', 'share', 'gather',
  'farm', 'build', 'cooperate', 'tech',
] as const;
export const POLICY_WEIGHTS = POLICY_INPUTS * POLICY_HIDDEN + POLICY_HIDDEN
  + POLICY_HIDDEN * POLICY_ACTIONS.length + POLICY_ACTIONS.length;

export interface PolicyGenome { weights: number[]; }
/** `baseline`, `at` y `body` sólo existen con V19/L (`conducta.aprendizajeCausal`): línea base de retorno por contexto
 * corporal, tick de la última observación y cuerpo (hambre, sed, fatiga, energía) en ese tick. Adquirido, no heredable. */
export interface PolicyPlasticity { bias: number[]; trace: number[]; baseline?: number[]; at?: number; body?: number[]; }
export const POLICY_CONTEXTS = ['ready', 'hungry', 'thirsty', 'tired'] as const;
export type PolicyContext = typeof POLICY_CONTEXTS[number];

/** Fractions in [0,1], measured by the caller from the body and its local
 * neighbourhood only. Counts/stocks must first be divided by LOCAL capacity.
 * No world, population statistic, remote stock or hardware enters this API. */
export interface LocalObservationInput {
  hunger: number; thirst: number; fatigue: number; energy: number;
  inventoryFrac: number; localFood: number; localWater: number; localCrowd: number;
  localShelter: number; localResources: number; communityTrust: number; biomeNovelty: number;
}
const OBSERVATION_KEYS = [
  'hunger', 'thirst', 'fatigue', 'energy', 'inventoryFrac', 'localFood',
  'localWater', 'localCrowd', 'localShelter', 'localResources', 'communityTrust', 'biomeNovelty',
] as const;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

function bounded(x: number, lo: number, hi: number, label: string): void {
  if (!Number.isFinite(x) || x < lo || x > hi) throw new RangeError(`Invalid ${label}`);
}
function vector(v: ArrayLike<number>, length: number, lo: number, hi: number, label: string): void {
  if (!v || v.length !== length) throw new RangeError(`Invalid ${label} length`);
  // Indexed iteration also rejects sparse arrays (Array.every would skip holes).
  for (let i = 0; i < length; i++) bounded(v[i], lo, hi, label);
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
export function assertPolicyGenome(g: unknown): asserts g is PolicyGenome {
  if (!record(g, ['weights']) || !Array.isArray(g.weights)) throw new Error('Invalid policy genome');
  vector(g.weights, POLICY_WEIGHTS, -1, 1, 'policy weights');
}
export function assertPolicyPlasticity(p: unknown): asserts p is PolicyPlasticity {
  const causal = p !== null && typeof p === 'object' && Object.hasOwn(p, 'baseline');
  if (!record(p, causal ? ['bias', 'trace', 'baseline', 'at', 'body'] : ['bias', 'trace']) || !Array.isArray(p.bias) || !Array.isArray(p.trace))
    throw new Error('Invalid policy plasticity');
  if (p.bias === p.trace) throw new Error('Aliased policy plasticity');
  vector(p.bias, POLICY_ACTIONS.length, -0.5, 0.5, 'policy bias');
  vector(p.trace, POLICY_ACTIONS.length, 0, 1, 'policy trace');
  if (causal) {
    if (!Array.isArray(p.baseline) || !Array.isArray(p.body) || !Number.isSafeInteger(p.at) || (p.at as number) < 0
      || p.baseline === p.body || p.baseline === p.bias || p.baseline === p.trace || p.body === p.bias || p.body === p.trace)
      throw new Error('Invalid policy plasticity');
    vector(p.baseline, POLICY_CONTEXTS.length, -1, 1, 'policy baseline');
    vector(p.body, 4, 0, 1, 'policy body');
  }
}
function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}
/** Zero-centred Gaussian; variance is measured before clipping to [-1,1]. */
export function founderPolicy(seed: number, id: string, variance = 0.25): PolicyGenome {
  bounded(variance, 0, 1, 'founder variance');
  const random = localRandom(seed, 'policy:' + id), sd = Math.sqrt(variance);
  return { weights: Array.from({ length: POLICY_WEIGHTS }, () => clamp(gaussian(random) * sd, -1, 1)) };
}
/** Uniform per-weight recombination, followed by bounded Gaussian mutation
 * (sd=0.08). Only inherited weights enter; acquired biases/traces never do. */
export function inheritPolicy(seed: number, childId: string, parentA: PolicyGenome,
  parentB: PolicyGenome, mutationRate = 0.08): PolicyGenome {
  assertPolicyGenome(parentA); assertPolicyGenome(parentB);
  bounded(mutationRate, 0, 1, 'mutation rate');
  const random = localRandom(seed, 'policy-inherit:' + childId);
  const weights = Array.from({ length: POLICY_WEIGHTS }, (_, i) => {
    let x = (random() < 0.5 ? parentA : parentB).weights[i];
    if (random() < mutationRate) x = clamp(x + gaussian(random) * 0.08, -1, 1);
    return x;
  });
  return { weights };
}
export function initialPolicyPlasticity(): PolicyPlasticity {
  return { bias: new Array<number>(12).fill(0), trace: new Array<number>(12).fill(0) };
}
function actionIndex(action: string): number {
  return POLICY_ACTIONS.indexOf((['research', 'craft', 'invent', 'repair'].includes(action)
    ? 'tech' : action) as typeof POLICY_ACTIONS[number]);
}
/** One call per observed outcome, including zero benefit. Replacing eligibility
 * trace (decay 0.8); bounded signed benefit updates all eligible action families.
 * The caller supplies an actual bodily/material delta, never predicted utility.
 * This mechanism enables Baldwin experiments; it does not itself prove the effect. */
export function updatePolicyPlasticity(plasticity: PolicyPlasticity, action: string,
  benefit: number, learningRate: number): void {
  assertPolicyPlasticity(plasticity);
  if (!Number.isFinite(benefit)) throw new RangeError('Invalid policy benefit');
  bounded(learningRate, 0, 1, 'learning rate');
  const chosen = actionIndex(action);
  if (chosen < 0 || learningRate === 0) return;
  const reward = clamp(benefit, -1, 1);
  for (let i = 0; i < 12; i++) {
    plasticity.trace[i] = i === chosen ? 1 : plasticity.trace[i] * 0.8;
    plasticity.bias[i] = clamp(plasticity.bias[i] + learningRate * reward * plasticity.trace[i], -0.5, 0.5);
  }
}
/** Escala del retorno corporal observado: un cambio de 0,25 en la suma de las cuatro magnitudes satura en 1. */
const CAUSAL_RETURN_SCALE = 4;
/** La elegibilidad dura `memoryTicks / 20` ticks (≈ 120 con el valor inicial 2400): la vieja traza de 0,8 por
 * llamada con una observación cada ~30 ticks; el olvido del sesgo y de la línea base dura `memoryTicks`. */
const ELIGIBILITY_FRACTION = 20;
/** V19/L: aprendizaje causal contextual. Una llamada por consecuencia corporal observada (no por acción hecha).
 * El retorno es el cambio REAL del cuerpo desde la observación anterior (hambre, sed y fatiga que bajan, energía que
 * sube); no se recompensa producción prevista, inventario ni acuerdos sin cumplir. Sobre él:
 *   ventaja = retorno − línea_base[contexto]
 *   sesgo[i] ← sesgo[i] + η · elegibilidad[i] · (ventaja − sesgo[i])        (acotado a ±0,5)
 *   línea_base[contexto] ← línea_base[contexto] + η · (retorno − línea_base[contexto])
 * La elegibilidad y el sesgo/línea base decaen con los ticks transcurridos (no con el número de llamadas), de modo
 * que una preferencia que nada confirma se olvida. La primera llamada sólo fija la marca corporal. Devuelve el
 * retorno observado (0 en la primera llamada). */
export function updatePolicyPlasticityCausal(plasticity: PolicyPlasticity, action: string, context: PolicyContext,
  body: readonly [number, number, number, number], tick: number, memoryTicks: number, learningRate: number, serviceBenefit = 0): number {
  assertPolicyPlasticity(plasticity);
  vector(body, 4, 0, 1, 'policy body');
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('Invalid policy tick');
  if (!Number.isSafeInteger(memoryTicks) || memoryTicks < 1) throw new RangeError('Invalid policy memory');
  bounded(learningRate, 0, 1, 'learning rate');
  bounded(serviceBenefit, -1, 1, 'policy service benefit');
  if (plasticity.baseline === undefined) {
    plasticity.baseline = new Array<number>(POLICY_CONTEXTS.length).fill(0);
    plasticity.at = tick; plasticity.body = [body[0], body[1], body[2], body[3]];
    const chosen = actionIndex(action), contextIndex = POLICY_CONTEXTS.indexOf(context);
    if (serviceBenefit !== 0 && chosen >= 0 && contextIndex >= 0 && learningRate > 0) {
      plasticity.trace[chosen] = 1;
      plasticity.bias[chosen] = clamp(plasticity.bias[chosen] + learningRate * serviceBenefit, -0.5, 0.5);
      plasticity.baseline[contextIndex] = clamp(learningRate * serviceBenefit, -1, 1);
    }
    return 0;
  }
  const previous = plasticity.body!, elapsed = Math.max(0, tick - plasticity.at!);
  const observed = clamp(CAUSAL_RETURN_SCALE * ((previous[0] - body[0]) + (previous[1] - body[1])
    + (previous[2] - body[2]) + (body[3] - previous[3])) + serviceBenefit, -1, 1);
  plasticity.at = tick; plasticity.body = [body[0], body[1], body[2], body[3]];
  const chosen = actionIndex(action), contextIndex = POLICY_CONTEXTS.indexOf(context);
  if (chosen < 0 || contextIndex < 0 || learningRate === 0) return observed;
  const forget = Math.exp(-elapsed / memoryTicks), eligibility = Math.exp(-elapsed * ELIGIBILITY_FRACTION / memoryTicks);
  const advantage = clamp(observed - plasticity.baseline[contextIndex] * forget, -1, 1);
  for (let i = 0; i < POLICY_CONTEXTS.length; i++) plasticity.baseline[i] *= forget;
  for (let i = 0; i < 12; i++) {
    plasticity.trace[i] = i === chosen ? 1 : plasticity.trace[i] * eligibility;
    const kept = plasticity.bias[i] * forget;
    plasticity.bias[i] = clamp(kept + learningRate * plasticity.trace[i] * (advantage - kept), -0.5, 0.5);
  }
  plasticity.baseline[contextIndex] = clamp(plasticity.baseline[contextIndex] + learningRate * (observed - plasticity.baseline[contextIndex]), -1, 1);
  return observed;
}
export function extractLocalObservation(input: LocalObservationInput): Float64Array {
  return Float64Array.from(OBSERVATION_KEYS, key => {
    const value = input[key];
    if (!Number.isFinite(value)) throw new RangeError(`Invalid local observation: ${key}`);
    return clamp(value, 0, 1) * 2 - 1;
  });
}
export function softSign(x: number): number { return x / (1 + Math.abs(x)); }

// Layout: W1[hidden][input] (0..95), b1 (96..103),
// W2[action][hidden] (104..199), b2 (200..211). Bias FIRST, then left-to-right
// products, then lifetime bias. CUDA repeats these exact FP64 operations.
function evaluateRow(obs: ArrayLike<number>, oi: number, weights: ArrayLike<number>, wi: number,
  biases: ArrayLike<number> | null, bi: number, out: Float64Array, dest: number, hidden: Float64Array): void {
  for (let h = 0; h < 8; h++) {
    let sum = weights[wi + 96 + h];
    for (let j = 0; j < 12; j++) sum = sum + obs[oi + j] * weights[wi + h * 12 + j];
    hidden[h] = softSign(sum);
  }
  for (let a = 0; a < 12; a++) {
    let sum = weights[wi + 200 + a];
    for (let h = 0; h < 8; h++) sum = sum + hidden[h] * weights[wi + 104 + a * 8 + h];
    out[dest + a] = softSign(sum + (biases === null ? 0 : biases[bi + a]));
  }
}
export function evaluatePolicySingle(obs: Float64Array | readonly number[],
  weights: Float64Array | readonly number[], plasticityBias?: readonly number[]): Float64Array {
  vector(obs, 12, -1, 1, 'observations'); vector(weights, 212, -1, 1, 'weights');
  if (plasticityBias !== undefined) vector(plasticityBias, 12, -0.5, 0.5, 'plasticity bias');
  const out = new Float64Array(12);
  evaluateRow(obs, 0, weights, 0, plasticityBias ?? null, 0, out, 0, new Float64Array(8));
  return out;
}
/** Shared boundary validation for both dispatch paths: backend cannot affect
 * acceptance of inputs. Full rows, no padding, finite and bounded FP64 values. */
export function assertPolicyBatch(observations: Float64Array, weights: Float64Array,
  plasticityBiases: Float64Array | null, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid policy count');
  if (!(observations instanceof Float64Array) || !(weights instanceof Float64Array)
    || (plasticityBiases !== null && !(plasticityBiases instanceof Float64Array)))
    throw new TypeError('Policy batches require Float64Array');
  vector(observations, count * 12, -1, 1, 'observations');
  vector(weights, count * 212, -1, 1, 'weights');
  if (plasticityBiases !== null) vector(plasticityBiases, count * 12, -0.5, 0.5, 'plasticity biases');
}
export function evaluatePoliciesCpu(observations: Float64Array, weights: Float64Array,
  plasticityBiases: Float64Array | null, count: number): Float64Array {
  assertPolicyBatch(observations, weights, plasticityBiases, count);
  const out = new Float64Array(count * 12), hidden = new Float64Array(8);
  for (let i = 0; i < count; i++)
    evaluateRow(observations, i * 12, weights, i * 212, plasticityBiases, i * 12, out, i * 12, hidden);
  return out;
}
export function policyActionBias(scores: Float64Array | readonly number[], action: string, weight: number): number {
  const index = actionIndex(action);
  if (weight <= 0 || index < 0) return 0;
  if (!Number.isFinite(weight)) throw new RangeError('Invalid policy action weight');
  vector(scores, 12, -1, 1, 'policy scores');
  return scores[index] * weight;
}
/** Mean cosine distance, in [0,2] for signed weights. Zero/zero distance = 0;
 * zero/nonzero = 1. Half the squared L2 distance of unit vectors equals cosine
 * distance. Identity: (M * sum(norm²) - norm(sum(u))²)/2, O(P*W), O(W) space. */
export function policyDiversity(genomes: readonly PolicyGenome[]): number {
  const sum = new Float64Array(POLICY_WEIGHTS);
  let nonzero = 0, zero = 0, normSum = 0;
  for (const g of genomes) {
    assertPolicyGenome(g);
    // Scaling before normalization also handles finite subnormal genomes.
    let scale = 0;
    for (const x of g.weights) scale = Math.max(scale, Math.abs(x));
    if (scale === 0) { zero++; continue; }
    let norm = 0;
    for (const x of g.weights) { const y = x / scale; norm += y * y; }
    norm = Math.sqrt(norm);
    nonzero++;
    let unitNorm = 0;
    for (let k = 0; k < POLICY_WEIGHTS; k++) {
      const u = (g.weights[k] / scale) / norm;
      sum[k] += u; unitNorm += u * u;
    }
    normSum += unitNorm;
  }
  const n = genomes.length;
  if (n < 2) return 0;
  let sumSq = 0;
  for (const x of sum) sumSq += x * x;
  const distance = zero * nonzero + Math.max(0, (nonzero * normSum - sumSq) / 2);
  return clamp(distance / (n * (n - 1) / 2), 0, 2);
}
