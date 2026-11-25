import { SED_POR_UNIDAD } from './ecologia-constantes.js';

/** Normalized bodily needs and readiness for activity. Energy is not a thermodynamic measurement;
 * rates are per simulation tick. Species, inherited traits, age and action feasibility belong to the caller.
 */
export interface BodyState { hunger: number; thirst: number; fatigue: number; energy: number; }
export interface BodyRates { hunger: number; thirst: number; energy: number; stressEnergy: number; fatigue: number; }
export interface BodyEffort { energy: number; fatigue: number; }
export interface BodyRecovery { fatigue: number; energy: number; }
/** The existing dietary factor scales hunger relief; readiness has its own independent yield. */
export interface FoodAssimilation { hungerPerUnit: number; energyPerUnit: number; assimilation?: number; }

/** V23 (`v23.cuerpos`): lo que un cuerpo de átomos hace con el esfuerzo que estas funciones cobran en «energía». Lo
 * instala `materia/cuerpo.ts`; este módulo no conoce la materia. */
export interface CuerpoMaterial {
  /** Paga `fraccion` de la energía llena del cuerpo de `body` quemando su reserva. */
  esfuerzo(body: BodyState, fraccion: number): void;
}
let material: CuerpoMaterial | null = null;
export function instalarCuerpoMaterial(m: CuerpoMaterial): void { material = m; }

/** Con `v23.cuerpos`, quien tiene un cuerpo de átomos (`Person.cuerpo`, `Animal.cuerpo`) no lleva la cuenta de su hambre,
 * su sed ni su energía aquí: son vistas de su cuerpo, que la ley escribe en cada tick (hambre = lo que falta de reserva,
 * sed = lo que falta de agua libre, energía = el O₂ de la reserva). Estas funciones solo le mueven la fatiga, que sigue
 * siendo escalar, y cobran el esfuerzo en julios. Comer y beber son traslados de materia (`ingerir`, `beber`), no sumas.
 * Las previsiones que copian el estado a un objeto suelto (sin `cuerpo`) siguen la contabilidad escalar de siempre. */
export const tieneCuerpoMaterial = (body: BodyState): boolean => (body as { cuerpo?: unknown }).cuerpo !== undefined;

const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const nonnegative = (n: number): boolean => Number.isFinite(n) && n >= 0;
const unit = (n: number): boolean => nonnegative(n) && n <= 1;
function assertBody(body: BodyState): void {
  if (!unit(body.hunger) || !unit(body.thirst) || !unit(body.fatigue) || !unit(body.energy)) throw new RangeError('Estado corporal inválido.');
}

/** Stress uses this tick's updated needs; preserve this order when sharing the law across species. */
export function advanceBody(body: BodyState, rates: BodyRates, dt = 1): void {
  assertBody(body);
  if (!nonnegative(dt) || !nonnegative(rates.hunger) || !nonnegative(rates.thirst) || !nonnegative(rates.energy)
    || !nonnegative(rates.stressEnergy) || !nonnegative(rates.fatigue)) throw new RangeError('Tasas fisiológicas inválidas.');
  if (tieneCuerpoMaterial(body)) { body.fatigue = clamp(body.fatigue + rates.fatigue * dt); return; }
  const hunger = clamp(body.hunger + rates.hunger * dt), thirst = clamp(body.thirst + rates.thirst * dt);
  const energy = clamp(body.energy - (rates.energy + (hunger > 0.85 ? rates.stressEnergy : 0)
    + (thirst > 0.85 ? rates.stressEnergy : 0)) * dt);
  if (!Number.isFinite(energy)) throw new RangeError('Desbordamiento fisiológico.');
  body.hunger = hunger; body.thirst = thirst; body.energy = energy;
  body.fatigue = clamp(body.fatigue + rates.fatigue * dt);
}

/** The caller decides whether an action actually happened and supplies its existing bodily cost. */
export function exertBody(body: BodyState, cost: BodyEffort): void {
  assertBody(body);
  if (!nonnegative(cost.energy) || !nonnegative(cost.fatigue)) throw new RangeError('Coste corporal inválido.');
  if (tieneCuerpoMaterial(body)) material?.esfuerzo(body, cost.energy);
  else body.energy = clamp(body.energy - cost.energy);
  body.fatigue = clamp(body.fatigue + cost.fatigue);
}

/** Rest relieves fatigue, but cannot replenish energy when hunger or thirst is maximal. */
export function restBody(body: BodyState, rates: BodyRecovery, quality = 1): void {
  assertBody(body);
  if (!nonnegative(rates.fatigue) || !nonnegative(rates.energy) || !unit(quality)) throw new RangeError('Descanso corporal inválido.');
  body.fatigue = clamp(body.fatigue - rates.fatigue * quality);
  if (tieneCuerpoMaterial(body)) return; // la energía vuelve respirando
  body.energy = clamp(body.energy + rates.energy * quality * clamp((1 - Math.max(body.hunger, body.thirst)) / 0.5));
}

/** consumed is the quantity already removed from a local stock or a single real prey identity.
 * It is in that source's simulation units. This helper owns neither stock nor access to the map.
 */
export function assimilateFood(body: BodyState, consumed: number, profile: FoodAssimilation): void {
  assertBody(body);
  const assimilation = profile.assimilation === undefined ? 1 : profile.assimilation;
  if (!nonnegative(consumed) || !nonnegative(profile.hungerPerUnit) || !nonnegative(profile.energyPerUnit)
    || !unit(assimilation)) throw new RangeError('Asimilación corporal inválida.');
  if (tieneCuerpoMaterial(body)) return; // lo comido entra como materia en su digestivo
  // Do not precompute hungerPerUnit * assimilation: its rounding differs from the original grazing/predation law.
  const hunger = clamp(body.hunger - consumed * profile.hungerPerUnit * assimilation);
  if (!Number.isFinite(hunger)) throw new RangeError('Desbordamiento de asimilación.');
  body.hunger = hunger;
  body.energy = clamp(body.energy + consumed * profile.energyPerUnit);
}

/** consumed has already been debited; habitat moisture and potable water retain their caller's conversion. */
export function hydrateBody(body: BodyState, consumed: number, thirstPerUnit = SED_POR_UNIDAD): void {
  assertBody(body);
  if (!nonnegative(consumed) || !nonnegative(thirstPerUnit)) throw new RangeError('Hidratación corporal inválida.');
  if (tieneCuerpoMaterial(body)) return; // lo bebido entra como agua en su digestivo
  body.thirst = clamp(body.thirst - consumed * thirstPerUnit);
}
