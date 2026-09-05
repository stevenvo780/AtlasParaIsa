import type { AnimalView, ChronicleEvent, WorldView } from '../shared/types.js';

/** Hard bounds apply at every zoom and on both render backends. */
export const VISUAL_BUDGET = { water: 120, vegetation: 96, rain: 90, events: 16, shadows: 260 } as const;
export const EVENT_LIFETIME_MS = 2400;

/** Daylight is a presentation of a received model tick, not a browser clock. */
export function daylightAt(tick: number): { color: string; alpha: number; shadowX: number; shadowY: number; shadowAlpha: number } {
  const phase = ((tick % 2400) + 2400) % 2400;
  const stops = [
    [0, 138, 153, 191, .34], [140, 248, 193, 150, .22], [340, 255, 249, 226, .03],
    [1300, 255, 249, 226, .03], [1590, 240, 178, 135, .23], [1840, 117, 137, 192, .48],
    [2220, 111, 133, 183, .49], [2400, 138, 153, 191, .34],
  ];
  const index = Math.max(0, stops.findIndex((stop, i) => i < stops.length - 1 && phase >= stop[0]! && phase < stops[i + 1]![0]!));
  const from = stops[index]!, to = stops[index + 1]!;
  let blend = (phase - from[0]!) / (to[0]! - from[0]!); blend = blend * blend * (3 - 2 * blend);
  const value = (i: number) => from[i]! + (to[i]! - from[i]!) * blend;
  const sun = Math.max(0, Math.sin((phase - 70) / 1750 * Math.PI));
  return { color: `rgb(${Math.round(value(1))},${Math.round(value(2))},${Math.round(value(3))})`, alpha: value(4),
    shadowX: Math.cos((phase - 70) / 1750 * Math.PI) * 8, shadowY: 2 + (1 - sun) * 4, shadowAlpha: sun * .2 };
}

export interface EventAccent { id: string; x: number; y: number; kind: ChronicleEvent['kind']; bornAt: number; }
const ACCENT_KINDS = new Set<ChronicleEvent['kind']>(['birth', 'care', 'learning', 'discovery', 'settlement', 'cooperation', 'community', 'invention']);

/** Marks acknowledge received facts, never generate outcomes or replay old chronicle entries. */
export function newEventAccents(previous: WorldView | null, current: WorldView, now: number): EventAccent[] {
  if (!previous || current.tick <= previous.tick || current.paused) return [];
  const seen = new Set(previous.events.map(event => event.id));
  return current.events.filter(event => !seen.has(event.id) && event.tick > previous.tick && event.tick <= current.tick
    && event.source === 'simulation' && ACCENT_KINDS.has(event.kind) && Number.isFinite(event.x) && Number.isFinite(event.y))
    .slice(-VISUAL_BUDGET.events).map(event => ({ id: event.id, x: event.x!, y: event.y!, kind: event.kind, bornAt: now }));
}

/** A standing animal never walks in place. Feeding poses require an active received action. */
export function animalPose(animal: Pick<AnimalView, 'action'>, moving: boolean, time: number, reduced: boolean, active: boolean): number {
  if (reduced || !active || animal.action === 'rest') return 0;
  if (moving) return Math.floor(time * (animal.action === 'flee' || animal.action === 'hunt' ? 10 : 6)) % 4;
  if (animal.action === 'graze' || animal.action === 'drink') return Math.floor(time * 2) % 2;
  return 0;
}
