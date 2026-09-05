export interface NeedsBody { hunger: number; thirst: number; fatigue: number; energy: number; }
export interface NeedsRates { hunger: number; thirst: number; energy: number; stressEnergy: number; fatigue: number; }
const clamp = (n: number): number => Math.max(0, Math.min(1, n));

/** The same physiological accounting is used by people and wildlife; rates are per simulation tick. */
export function advanceNeeds(body: NeedsBody, rates: NeedsRates, dt = 1): void {
  if (!Number.isFinite(dt) || dt < 0 || Object.values(rates).some(n => !Number.isFinite(n) || n < 0)) throw new RangeError('Tasas fisiológicas inválidas.');
  body.hunger = clamp(body.hunger + rates.hunger * dt);
  body.thirst = clamp(body.thirst + rates.thirst * dt);
  body.energy = clamp(body.energy - (rates.energy + (body.hunger > 0.85 ? rates.stressEnergy : 0)
    + (body.thirst > 0.85 ? rates.stressEnergy : 0)) * dt);
  body.fatigue = clamp(body.fatigue + rates.fatigue * dt);
}
