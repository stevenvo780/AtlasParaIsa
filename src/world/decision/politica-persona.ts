import { type World, type Person, RADIUS } from '../mundo/tipos.js';
import { distance } from '../mundo/geometria.js';
import type { Action, Tile } from '../../shared/types.js';
import { paramsOf } from '../params.js';
import { updatePolicyPlasticityCausal, type PolicyGenome, type PolicyPlasticity, founderPolicy, initialPolicyPlasticity, POLICY_ACTIONS, POLICY_INPUTS, POLICY_WEIGHTS } from '../politica.js';
import { type ResidentFastAccess, residentFastAccess } from '../soa/terreno.js';
import { tileLookup } from '../tile-index.js';
import { vecinos } from '../rejilla.js';
import { computeLocalPolicyObservation } from '../politica-obs.js';
import { gpuNvrtcAvailable } from '../gpu/puente.js';
import { residentPolicyRegistry, evaluatePoliciesBatch } from '../gpu/politica-gpu.js';


/** V19/L (`conducta.aprendizajeCausal`): acredita la consecuencia corporal REAL observada desde la última marca a la
 * acción que la precedió; el retorno lo mide `updatePolicyPlasticityCausal`, no una constante por acción hecha. */
export function creditCausalOutcome(world: World, person: Person, action: Action | 'rest', serviceBenefit = 0): void {
  const { conducta } = paramsOf(world);
  const { plasticity } = ensurePersonPolicy(world, person);
  updatePolicyPlasticityCausal(plasticity, action, person.intentContext,
    [person.hunger, person.thirst, person.fatigue, person.energy], world.tick, conducta.memoriaResultadoTicks,
    person.genome.learningRate * (conducta.politicaAutonomia > 0 ? 0.4 : 0.25), serviceBenefit);
}


export function ensurePersonPolicy(world: World, person: Person): { genome: PolicyGenome; plasticity: PolicyPlasticity } {
  if (!person.policy) person.policy = founderPolicy(world.seed, person.id);
  if (!person.policyPlasticity) person.policyPlasticity = initialPolicyPlasticity();
  return { genome: person.policy, plasticity: person.policyPlasticity };
}


/** Observación estrictamente local (radio ≤ 4 en teselas, ≤ 7 en vecinos) para la red de política V12.
 * El índice de teselas llega ya construido desde `precomputePolicyScores` (una vez por paso). */
const policyNearby: Person[] = [];

export function localPolicyObservation(
  world: World,
  person: Person,
  tileIn?: (x: number, y: number) => Tile | undefined,
  fast?: ResidentFastAccess,
  out?: Float64Array,
  offset = 0,
  people?: readonly Person[],
): Float64Array {
  const lookup = tileIn ?? tileLookup(world.tiles);
  const nearby = people ?? vecinos(world, person, RADIUS + 1, other => other.id !== person.id && distance(person, other) <= RADIUS, 'policy', policyNearby);
  return computeLocalPolicyObservation(world, person, lookup, nearby, fast, out, offset);
}


/** Evalúa por lote (CPU o Dual-GPU FP64 exacta) las políticas de los actores con decisión prevista en este paso.
 * En Dual-GPU lanza el kernel de forma no bloqueante (`begin`) para solaparlo con los workers CPU de `personas`. */
export function precomputePolicyScores(world: World): (() => Map<string, Float64Array>) | undefined {
  const params = paramsOf(world);
  if (params.conducta.politicaPeso <= 0) return undefined;
  const deciding: Person[] = [];
  for (const person of world.people) {
    if (world.tick >= person.decisionAt && person.hunger <= 0.75 && person.thirst <= 0.75) deciding.push(person);
  }
  const count = deciding.length;
  if (count === 0) return undefined;
  const tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles);
  const devices = params.motor.gpu.length > 0 && gpuNvrtcAvailable() ? params.motor.gpu : [];
  const toMap = (raw: Float64Array): Map<string, Float64Array> => {
    const byId = new Map<string, Float64Array>();
    for (let i = 0; i < count; i++) {
      const start = i * POLICY_ACTIONS.length;
      byId.set(deciding[i]!.id, raw.subarray(start, start + POLICY_ACTIONS.length));
    }
    return byId;
  };
  if (devices.length > 0) {
    const actors = new Array<{ id: string; weights: readonly number[]; obs: Float64Array; bias: Float64Array }>(count);
    for (let i = 0; i < count; i++) {
      const person = deciding[i]!;
      const { genome, plasticity } = ensurePersonPolicy(world, person);
      actors[i] = {
        id: person.id,
        weights: genome.weights,
        obs: localPolicyObservation(world, person, tileIn, fast),
        bias: Float64Array.from(plasticity.bias),
      };
    }
    const pending = residentPolicyRegistry(devices).begin(actors);
    return () => toMap(pending.wait());
  }
  const obs = new Float64Array(count * POLICY_INPUTS);
  const weights = new Float64Array(count * POLICY_WEIGHTS);
  const biases = new Float64Array(count * POLICY_ACTIONS.length);
  for (let i = 0; i < count; i++) {
    const person = deciding[i]!;
    const { genome, plasticity } = ensurePersonPolicy(world, person);
    localPolicyObservation(world, person, tileIn, fast, obs, i * POLICY_INPUTS);
    weights.set(genome.weights, i * POLICY_WEIGHTS);
    biases.set(plasticity.bias, i * POLICY_ACTIONS.length);
  }
  const ready = toMap(evaluatePoliciesBatch(obs, weights, biases, count, devices));
  return () => ready;
}
