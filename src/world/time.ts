import type { WorldView } from '../shared/types.js';

export const TICKS_PER_DAY = 2400;
/** Simulation time only. Neither wall time nor camera requests are inputs. */
export function phaseAt(tick: number): WorldView['phase'] {
  const t = tick % TICKS_PER_DAY;
  return t < 300 ? 'dawn' : t < 1500 ? 'day' : t < 1800 ? 'dusk' : 'night';
}
