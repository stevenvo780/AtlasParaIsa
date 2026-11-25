import { advanceBody, type BodyState, type BodyRates } from './body.js';
import type { VistaCuerpo } from './materia/tipos.js';
export type NeedsBody = BodyState;
export type NeedsRates = BodyRates;

/** The same physiological accounting is used by people and wildlife; rates are per simulation tick. */
export function advanceNeeds(body: NeedsBody, rates: NeedsRates, dt = 1): void {
  advanceBody(body, rates, dt);
}

const unidad = (n: number): number => (n > 0 ? (n < 1 ? n : 1) : 0);

/** V23 (`v23.cuerpos`): hambre, sed y energía pasan a ser las vistas del cuerpo de átomos (`VistaCuerpo`). La fatiga no
 * se toca: sigue siendo escalar. */
export function necesidadesDeVista(body: NeedsBody, vista: Readonly<Pick<VistaCuerpo, 'hambre' | 'sed' | 'energia'>>): void {
  body.hunger = unidad(vista.hambre); body.thirst = unidad(vista.sed); body.energy = unidad(vista.energia);
}
