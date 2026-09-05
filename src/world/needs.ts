import { advanceBody, type BodyState, type BodyRates } from './body.js';
export type NeedsBody = BodyState;
export type NeedsRates = BodyRates;

/** The same physiological accounting is used by people and wildlife; rates are per simulation tick. */
export function advanceNeeds(body: NeedsBody, rates: NeedsRates, dt = 1): void {
  advanceBody(body, rates, dt);
}
