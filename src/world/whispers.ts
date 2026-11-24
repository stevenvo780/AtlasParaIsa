/**
 * V24 — Asynchronous "Mensajes Divinos" (Divine Whispers).
 * Non-coercive, delayed, deterministic inspiration queue designed for a DVR / non-real-time living world:
 * an observer sends a whisper (destination/intent), never knowing exactly WHEN the inhabitant will hear it
 * or how they will weave it into their autonomous survival & community life.
 */
import type { DivineWhisper, DivineWhisperIntent, DivineWhisperRequest } from '../shared/worldmap.js';

export const WHISPER_INTENTS: readonly DivineWhisperIntent[] = ['travel', 'explore', 'gather', 'build', 'craft', 'tend'] as const;
export const MAX_ACTIVE_WHISPERS = 16;
export const MAX_RETAINED_WHISPERS = 32;
/** A whisper fades peacefully if unheard or unfulfilled after 3 simulated days (7200 ticks). */
export const WHISPER_LIFETIME_TICKS = 7200;

export interface WhisperPersonLike {
  id: string;
  name: string;
  x: number;
  y: number;
  hunger: number;
  thirst?: number;
  fatigue: number;
  energy: number;
  traits?: { curiosity?: number; openness?: number };
  culture?: { openness?: number };
}

export interface WhisperStepOutcome {
  heard: Array<{ whisper: DivineWhisper; person: WhisperPersonLike }>;
  fulfilled: Array<{ whisper: DivineWhisper; person: WhisperPersonLike }>;
}

function deterministicUnit(seed: number, tick: number, a: string, b: string): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(tick | 0, 0x85ebca6b)) >>> 0;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a.charCodeAt(i), 0x2c1b3c6d) >>> 0;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b.charCodeAt(i), 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 0x1_0000_0000;
}

export function parseWhisperRequest(raw: unknown): DivineWhisperRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Mensaje divino no válido.');
  const obj = raw as Record<string, unknown>;
  const intent = obj.intent;
  if (typeof intent !== 'string' || !(WHISPER_INTENTS as readonly string[]).includes(intent)) {
    throw new Error('Intención de mensaje divino no válida.');
  }
  const x = obj.x, y = obj.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y)
    || Math.abs(x) >= 10_000_000 || Math.abs(y) >= 10_000_000) {
    throw new Error('Coordenadas del mensaje divino no válidas.');
  }
  let personId: string | null = null;
  if (obj.personId !== undefined && obj.personId !== null && obj.personId !== '') {
    if (typeof obj.personId !== 'string' || obj.personId.length > 64) throw new Error('Destinatario no válido.');
    personId = obj.personId;
  }
  let note = '';
  if (obj.note !== undefined) {
    if (typeof obj.note !== 'string') throw new Error('Nota no válida.');
    // eslint-disable-next-line no-control-regex
    note = obj.note.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim().slice(0, 120);
  }
  return { personId, intent: intent as DivineWhisperIntent, x, y, note };
}

export function enqueueWhisper(
  whispers: DivineWhisper[],
  req: DivineWhisperRequest,
  tick: number,
  day: number,
  personName?: string,
): DivineWhisper {
  const activeCount = whispers.filter(w => w.status === 'latent' || w.status === 'heard').length;
  if (activeCount >= MAX_ACTIVE_WHISPERS) {
    const oldestActiveIdx = whispers.findIndex(w => w.status === 'latent' || w.status === 'heard');
    if (oldestActiveIdx >= 0) {
      whispers[oldestActiveIdx]!.status = 'faded';
      whispers[oldestActiveIdx]!.resolvedTick = tick;
    }
  }
  const id = `w-${tick}-${whispers.length + 1}`;
  const created: DivineWhisper = {
    id,
    createdTick: tick,
    createdDay: day,
    personId: req.personId ?? null,
    ...(personName ? { personName } : {}),
    intent: req.intent,
    x: req.x,
    y: req.y,
    note: req.note ?? '',
    status: 'latent',
  };
  whispers.push(created);
  while (whispers.length > MAX_RETAINED_WHISPERS) whispers.shift();
  return created;
}

/**
 * Advance the asynchronous divine whisper queue deterministically (ZERO Math.random, ZERO wall clock).
 * Called inside the simulation step (e.g. every 10 ticks) so whispers are heard unpredictably when
 * inhabitants are calm & curious — never overriding urgent hunger, thirst, or exhaustion.
 */
export function stepWhispers(
  whispers: DivineWhisper[],
  people: readonly WhisperPersonLike[],
  tick: number,
  seed: number,
): WhisperStepOutcome {
  const outcome: WhisperStepOutcome = { heard: [], fulfilled: [] };
  if (!whispers.length) return outcome;
  const byId = new Map<string, WhisperPersonLike>();
  for (let i = 0; i < people.length; i++) byId.set(people[i]!.id, people[i]!);

  for (const w of whispers) {
    if (w.status !== 'latent' && w.status !== 'heard') continue;
    if (tick - w.createdTick >= WHISPER_LIFETIME_TICKS) {
      w.status = 'faded';
      w.resolvedTick = tick;
      continue;
    }
    if (w.status === 'heard') {
      const listener = w.heardById ? byId.get(w.heardById) : undefined;
      if (!listener) {
        w.status = 'faded';
        w.resolvedTick = tick;
        continue;
      }
      const dist = Math.hypot(listener.x - w.x, listener.y - w.y);
      if (dist <= 3.2) {
        w.status = 'fulfilled';
        w.resolvedTick = tick;
        outcome.fulfilled.push({ whisper: w, person: listener });
      }
      continue;
    }

    // Status === 'latent': wait at least 20 ticks so a whisper is NEVER an instant arcade command!
    const age = tick - w.createdTick;
    if (age < 20) continue;

    let candidate: WhisperPersonLike | undefined;
    if (w.personId) {
      candidate = byId.get(w.personId);
      if (!candidate) {
        w.status = 'faded';
        w.resolvedTick = tick;
        continue;
      }
    } else {
      // Regional whisper: closest calm inhabitant within 28 cells
      let bestDist = 28;
      for (let i = 0; i < people.length; i++) {
        const p = people[i]!;
        const d = Math.hypot(p.x - w.x, p.y - w.y);
        if (d < bestDist) { bestDist = d; candidate = p; }
      }
    }
    if (!candidate) continue;

    // Only hear a whisper when survival needs are calm
    const calm = candidate.hunger < 0.65 && (candidate.thirst ?? 0) < 0.65 && candidate.fatigue < 0.72 && candidate.energy > 0.25;
    if (!calm) continue;

    const receptivity = 0.035
      + (candidate.traits?.curiosity ?? 0.5) * 0.055
      + (candidate.culture?.openness ?? 0.5) * 0.045
      + Math.min(0.08, age / 2400 * 0.08);
    if (deterministicUnit(seed, tick, candidate.id, w.id) < receptivity) {
      w.status = 'heard';
      w.heardTick = tick;
      w.heardById = candidate.id;
      w.heardByName = candidate.name;
      outcome.heard.push({ whisper: w, person: candidate });
    }
  }
  return outcome;
}

/** Return the active 'heard' divine whisper currently inspiring `personId`, if any. */
export function activeWhisperForPerson(whispers: readonly DivineWhisper[] | undefined, personId: string): DivineWhisper | undefined {
  if (!whispers?.length) return undefined;
  for (let i = whispers.length - 1; i >= 0; i--) {
    const w = whispers[i]!;
    if (w.status === 'heard' && w.heardById === personId) return w;
  }
  return undefined;
}
