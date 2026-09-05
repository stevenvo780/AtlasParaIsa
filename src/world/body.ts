/** Normalized bodily needs and readiness for activity. Energy is not a thermodynamic measurement;
 * rates are per simulation tick. Species, inherited traits, age and action feasibility belong to the caller.
 */
export interface BodyState { hunger: number; thirst: number; fatigue: number; energy: number; }
export interface BodyRates { hunger: number; thirst: number; energy: number; stressEnergy: number; fatigue: number; }
export interface BodyEffort { energy: number; fatigue: number; }
export interface BodyRecovery { fatigue: number; energy: number; }
/** The existing dietary factor scales hunger relief; readiness has its own independent yield. */
export interface FoodAssimilation { hungerPerUnit: number; energyPerUnit: number; assimilation?: number; }

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
  body.energy = clamp(body.energy - cost.energy);
  body.fatigue = clamp(body.fatigue + cost.fatigue);
}

/** Rest relieves fatigue, but cannot replenish energy when hunger or thirst is maximal. */
export function restBody(body: BodyState, rates: BodyRecovery, quality = 1): void {
  assertBody(body);
  if (!nonnegative(rates.fatigue) || !nonnegative(rates.energy) || !unit(quality)) throw new RangeError('Descanso corporal inválido.');
  body.fatigue = clamp(body.fatigue - rates.fatigue * quality);
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
  // Do not precompute hungerPerUnit * assimilation: its rounding differs from the original grazing/predation law.
  const hunger = clamp(body.hunger - consumed * profile.hungerPerUnit * assimilation);
  if (!Number.isFinite(hunger)) throw new RangeError('Desbordamiento de asimilación.');
  body.hunger = hunger;
  body.energy = clamp(body.energy + consumed * profile.energyPerUnit);
}

/** consumed has already been debited; habitat moisture and potable water retain their caller's conversion. */
export function hydrateBody(body: BodyState, consumed: number, thirstPerUnit = 3): void {
  assertBody(body);
  if (!nonnegative(consumed) || !nonnegative(thirstPerUnit)) throw new RangeError('Hidratación corporal inválida.');
  body.thirst = clamp(body.thirst - consumed * thirstPerUnit);
}
