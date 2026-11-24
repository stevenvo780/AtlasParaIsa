import { type World, type Person, RADIUS } from '../mundo/tipos.js';
import { distance } from '../mundo/geometria.js';
import type { Action, Tile } from '../../shared/types.js';
import { paramsOf } from '../params.js';
import { updatePolicyPlasticityCausal, type PolicyGenome, type PolicyPlasticity, founderPolicy, initialPolicyPlasticity, POLICY_ACTIONS, POLICY_INPUTS } from '../politica.js';
import { type ResidentFastAccess, residentFastAccess } from '../soa/terreno.js';
import { tileLookup } from '../tile-index.js';
import { vecinos } from '../rejilla.js';
import { computeLocalPolicyObservation } from '../politica-obs.js';
import type { LotePercepcion, Percepcion } from '../motor/contratos.js';
import type { VistaMundo } from './percepcion.js';
import { PLAN } from './planes.js';


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
 * El índice de teselas llega ya construido desde `prepararCerebros` (una vez por paso). */
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


/** Quien decide con la red en este tick: decisión vencida y sin urgencia corporal severa (> 0,75), como en `choose`. */
export function decideConCerebro(world: World, person: Person): boolean {
  return paramsOf(world).conducta.politicaPeso > 0 && world.tick >= person.decisionAt && person.hunger <= 0.75 && person.thirst <= 0.75;
}

/** F2: observación, pesos y plasticidad de cada slot del lote con plan `conCerebro`, en las columnas del cerebro. */
export function prepararCerebros(world: World, vista: VistaMundo, lote: LotePercepcion, tileIn: (x: number, y: number) => Tile | undefined): void {
  const fast = residentFastAccess(world.tiles), obs = new Float64Array(POLICY_INPUTS);
  for (let i = 0; i < lote.slots.length; i++) {
    if (lote.plan[i] !== PLAN.conCerebro) continue;
    const person = world.people[lote.slots[i]!]!;
    const { genome, plasticity } = ensurePersonPolicy(world, person);
    localPolicyObservation(world, person, tileIn, fast, obs);
    vista.cerebro(lote.slots[i]!, obs, genome.weights, plasticity.bias);
  }
}

/** Las utilidades del cerebro percibidas, por persona, como las lee `choose`. */
export function puntuacionesPercibidas(world: World, lote: LotePercepcion, salida: Percepcion): Map<string, Float64Array> {
  const scores = new Map<string, Float64Array>();
  for (let i = 0; i < lote.slots.length; i++) {
    if (lote.plan[i] !== PLAN.conCerebro) continue;
    scores.set(world.people[lote.slots[i]!]!.id, Float64Array.from(salida.utilidad.subarray(i * salida.a, i * salida.a + POLICY_ACTIONS.length)));
  }
  return scores;
}
