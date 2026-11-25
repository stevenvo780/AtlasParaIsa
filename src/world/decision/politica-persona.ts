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
import type { Vencidos, VistaMundo } from './percepcion.js';
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

const observacionF2 = new Float64Array(POLICY_INPUTS);

/** F2: las columnas del cerebro antes de lanzar. Toda ranura cuyo ocupante cambió se publica con sus pesos heredados
 * aunque no decida en este tick (contrato: los pesos se escriben para toda ranura cuya `gen` cambió; quien los espeje por
 * `gen` los toma en cuanto la ve), y cada ranura del despacho con plan `conCerebro`, con su observación y su plasticidad
 * de ahora. */
export function prepararCerebros(world: World, vista: VistaMundo, despacho: LotePercepcion, tileIn: (x: number, y: number) => Tile | undefined): void {
  if (paramsOf(world).conducta.politicaPeso <= 0) return;
  // Sin crearle la política a nadie: la de un fundador que aún no decidió es la misma que le dará `ensurePersonPolicy`.
  for (const s of vista.ranurasPersonas) {
    if (vista.pesosAlDia(s)) continue;
    const persona = vista.persona(s)!;
    vista.escribirPesos(s, (persona.policy ?? founderPolicy(world.seed, persona.id)).weights);
  }
  const fast = residentFastAccess(world.tiles);
  for (let i = 0; i < despacho.slots.length; i++) {
    if (despacho.plan[i] !== PLAN.conCerebro) continue;
    const slot = despacho.slots[i]!, person = vista.persona(slot)!;
    const { genome, plasticity } = ensurePersonPolicy(world, person);
    localPolicyObservation(world, person, tileIn, fast, observacionF2);
    vista.escribirPesos(slot, genome.weights);
    vista.escribirEstado(slot, observacionF2, plasticity.bias);
  }
}

/** Las utilidades del cerebro percibidas, por persona, como las lee `choose`: vistas de una sola copia en f64 por tick. */
export function puntuacionesPercibidas(world: World, lote: Vencidos, salida: Percepcion): Map<string, Float64Array> {
  const puntuaciones = new Map<string, Float64Array>(), n = lote.slots.length, a = salida.a;
  if (a === 0) return puntuaciones;
  const utilidades = Float64Array.from(salida.utilidad.subarray(0, n * a));
  for (let i = 0; i < n; i++)
    if (lote.plan[i] === PLAN.conCerebro) puntuaciones.set(world.people[lote.slots[i]!]!.id, utilidades.subarray(i * a, i * a + POLICY_ACTIONS.length));
  return puntuaciones;
}
