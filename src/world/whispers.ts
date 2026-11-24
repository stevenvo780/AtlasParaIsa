/**
 * V24 — Mensajes Divinos (susurros asíncronos).
 *
 * Quien observa deja un mensaje («ve allí», «explora esa región»…) y no sabe CUÁNDO lo oirá la persona:
 * el retraso es determinista (hash de semilla, paso y destinatario, nunca el RNG del mundo ni el reloj),
 * imprevisible para el observador y acotado: un mensaje dirigido a alguien vivo se oye seguro antes de
 * `HEAR_HORIZON_TICKS`. Una vez oído, la persona lo cumple caminando por tierra en cuanto su cuerpo no
 * tenga una necesidad aguda (`index.ts`, `choose`). Nunca hay teletransporte ni obediencia instantánea.
 * Se desvanece sólo si la persona muere, si el destino es inalcanzable o si pasa un plazo largo tras oírlo.
 */
import type { DivineWhisper, DivineWhisperIntent, DivineWhisperRequest } from '../shared/worldmap.js';

export const WHISPER_INTENTS: readonly DivineWhisperIntent[] = ['travel', 'explore', 'gather', 'build', 'craft', 'tend'] as const;
export const MAX_ACTIVE_WHISPERS = 16;
export const MAX_RETAINED_WHISPERS = 32;
/** Nadie oye un mensaje antes de 20 pasos (2 s del mundo): nunca es una orden de mando. */
export const HEAR_MIN_DELAY_TICKS = 20;
/** Un mensaje dirigido a una persona viva se oye, a más tardar, en un día del mundo. */
export const HEAR_HORIZON_TICKS = 2400;
/** Plazo para cumplirlo una vez oído (3 días); pasado, se desvanece. */
export const FULFIL_DEADLINE_TICKS = 7200;
/** Un mensaje regional (sin destinatario) que nadie oye en 3 días se desvanece. */
export const WHISPER_LIFETIME_TICKS = 7200;
/** Llegó: a 1,5 celdas o menos del destino. */
export const FULFIL_RADIUS = 1.5;
/** Comprobaciones seguidas (cada 10 pasos) persiguiéndolo sin acercarse nunca más: destino inalcanzable. */
export const STALL_CHECKS = 60;
/** Radio en el que un mensaje regional busca a quien lo oiga. */
export const REGIONAL_RADIUS = 28;

/** Estado interno que el mundo persiste junto a cada mensaje (nunca se proyecta: ver `whisperView`). */
export interface WhisperRecord extends DivineWhisper {
  /** Menor distancia al destino alcanzada desde que lo oyó. */
  bestDistance?: number;
  /** Comprobaciones seguidas persiguiéndolo sin mejorar `bestDistance`. */
  stalledChecks?: number;
}

export interface WhisperPersonLike {
  id: string;
  name: string;
  x: number;
  y: number;
  action?: string;
  target?: { x: number; y: number };
  traits?: { curiosity?: number };
  culture?: { openness?: number };
}

export type WhisperFadeReason = 'gone' | 'unreachable' | 'deadline' | 'unheard';
export interface WhisperStepOutcome {
  heard: Array<{ whisper: WhisperRecord; person: WhisperPersonLike }>;
  fulfilled: Array<{ whisper: WhisperRecord; person: WhisperPersonLike }>;
  faded: Array<{ whisper: WhisperRecord; reason: WhisperFadeReason; person?: WhisperPersonLike }>;
}

/** Hash determinista en [0, 1): ni `Math.random`, ni el RNG del mundo, ni el reloj. */
function deterministicUnit(seed: number, tick: number, a: string, b: string): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(tick | 0, 0x85ebca6b)) >>> 0;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a.charCodeAt(i), 0x2c1b3c6d) >>> 0;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b.charCodeAt(i), 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 0x1_0000_0000;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};

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

const isActive = (w: DivineWhisper): boolean => w.status === 'latent' || w.status === 'heard';

export function enqueueWhisper(
  whispers: DivineWhisper[],
  req: DivineWhisperRequest,
  tick: number,
  day: number,
  personName?: string,
): DivineWhisper {
  // Con el cupo lleno, el mensaje activo más antiguo cede su lugar (queda como desvanecido).
  if (whispers.filter(isActive).length >= MAX_ACTIVE_WHISPERS) {
    const oldest = whispers.find(isActive)!;
    oldest.status = 'faded';
    oldest.resolvedTick = tick;
  }
  // Identificador único aunque la historia retenida ya haya descartado mensajes del mismo paso.
  let sequence = 1;
  for (const w of whispers) if (w.createdTick === tick) sequence++;
  const created: DivineWhisper = {
    id: `w-${tick}-${sequence}`,
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

/** Probabilidad de oírlo en esta comprobación: crece con la espera y la curiosidad; 1 al llegar al horizonte. */
function hearingChance(person: WhisperPersonLike, age: number, targeted: boolean): number {
  if (targeted && age >= HEAR_HORIZON_TICKS) return 1;
  const ramp = Math.min(1, (age - HEAR_MIN_DELAY_TICKS) / (HEAR_HORIZON_TICKS - HEAR_MIN_DELAY_TICKS));
  return 0.01 + (person.traits?.curiosity ?? 0.5) * 0.03 + (person.culture?.openness ?? 0.5) * 0.02 + ramp * 0.06;
}

function resolve(w: WhisperRecord, status: 'fulfilled' | 'faded', tick: number) {
  w.status = status; w.resolvedTick = tick;
  delete w.bestDistance; delete w.stalledChecks;
}

/**
 * Avanza la cola de mensajes (llamar cada 10 pasos, sólo con mensajes). `isWater` dice si el destino es
 * agua (`undefined` si la celda no está cargada: se sabrá al acercarse). Sin `Math.random`, sin reloj y
 * sin el RNG del mundo.
 */
export function stepWhispers(
  whispers: WhisperRecord[],
  people: readonly WhisperPersonLike[],
  tick: number,
  seed: number,
  isWater?: (x: number, y: number) => boolean | undefined,
): WhisperStepOutcome {
  const outcome: WhisperStepOutcome = { heard: [], fulfilled: [], faded: [] };
  let byId: Map<string, WhisperPersonLike> | undefined;
  const find = (id: string): WhisperPersonLike | undefined => {
    if (!byId) { byId = new Map(); for (let i = 0; i < people.length; i++) byId.set(people[i]!.id, people[i]!); }
    return byId.get(id);
  };
  const fade = (w: WhisperRecord, reason: WhisperFadeReason, person?: WhisperPersonLike) => {
    resolve(w, 'faded', tick);
    outcome.faded.push({ whisper: w, reason, ...(person ? { person } : {}) });
  };

  for (const w of whispers) {
    if (!isActive(w)) continue;
    if (w.status === 'heard') {
      const listener = w.heardById ? find(w.heardById) : undefined;
      if (!listener) { fade(w, 'gone'); continue; }
      const away = dist(listener, w);
      if (away <= FULFIL_RADIUS) {
        resolve(w, 'fulfilled', tick);
        outcome.fulfilled.push({ whisper: w, person: listener });
        continue;
      }
      if (tick - (w.heardTick ?? w.createdTick) >= FULFIL_DEADLINE_TICKS) { fade(w, 'deadline', listener); continue; }
      if (isWater?.(w.x, w.y) === true) { fade(w, 'unreachable', listener); continue; }
      // Sólo cuenta como atasco el tiempo que la persona lo persigue (comer, beber o descansar no cuentan).
      const pursuing = listener.action === 'explore' && listener.target?.x === w.x && listener.target?.y === w.y;
      if (w.bestDistance === undefined || away < w.bestDistance - 0.5) { w.bestDistance = away; w.stalledChecks = 0; }
      else if (pursuing && (w.stalledChecks = (w.stalledChecks ?? 0) + 1) >= STALL_CHECKS) fade(w, 'unreachable', listener);
      continue;
    }

    // Latente.
    const age = tick - w.createdTick;
    let candidate: WhisperPersonLike | undefined;
    if (w.personId) {
      candidate = find(w.personId);
      if (!candidate) { fade(w, 'gone'); continue; }
    } else {
      if (age >= WHISPER_LIFETIME_TICKS) { fade(w, 'unheard'); continue; }
      let best = REGIONAL_RADIUS;
      for (let i = 0; i < people.length; i++) {
        const d = dist(people[i]!, w);
        if (d < best) { best = d; candidate = people[i]; }
      }
    }
    if (isWater?.(w.x, w.y) === true) { fade(w, 'unreachable', candidate); continue; }
    if (!candidate || age < HEAR_MIN_DELAY_TICKS) continue;
    if (deterministicUnit(seed, tick, candidate.id, w.id) < hearingChance(candidate, age, !!w.personId)) {
      w.status = 'heard';
      w.heardTick = tick;
      w.heardById = candidate.id;
      w.heardByName = candidate.name;
      w.bestDistance = dist(candidate, w);
      w.stalledChecks = 0;
      outcome.heard.push({ whisper: w, person: candidate });
    }
  }
  return outcome;
}

/** El mensaje oído que hoy inspira a `personId`, si lo hay (el más reciente). */
export function activeWhisperForPerson(whispers: readonly DivineWhisper[] | undefined, personId: string): DivineWhisper | undefined {
  if (!whispers?.length) return undefined;
  for (let i = whispers.length - 1; i >= 0; i--) {
    const w = whispers[i]!;
    if (w.status === 'heard' && w.heardById === personId) return w;
  }
  return undefined;
}

/** Copia pública de un mensaje (contrato `DivineWhisper`), sin el estado interno de seguimiento. */
export function whisperView(w: WhisperRecord): DivineWhisper {
  const { bestDistance: _best, stalledChecks: _stalled, ...view } = w;
  return view;
}
