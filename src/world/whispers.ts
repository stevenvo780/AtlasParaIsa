/**
 * V24 — Mensajes Divinos (susurros asíncronos); V23 — la escucha.
 *
 * Quien observa deja un mensaje («ve allí», «explora esa región»…) y no sabe CUÁNDO lo oirá la persona, ni si lo hará.
 * En cada paso la probabilidad de oírlo es proporcional a `escucha² · calma · audibilidad` (`probabilidadDeOir`): la
 * escucha es un gen (`genetics.ts`), la calma es lo poco acuciada que está su necesidad, y la audibilidad cae con la
 * distancia en los mensajes regionales. No hay espera mínima, ni horizonte que lo garantice, ni umbral de calma: quien
 * casi no escucha casi nunca oye, y el mensaje se desvanece si pasa su plazo sin oírse. El azar es un hash de semilla,
 * paso y destinatario (nunca el RNG del mundo ni el reloj): con un hilo y semilla, la misma corrida. Una vez oído, la
 * persona lo cumple caminando por tierra (`personas.ts`, `choose`) y puede olvidarlo por el camino con un riesgo que baja
 * con su escucha. Nunca hay teletransporte ni obediencia instantánea.
 */
import type { DivineWhisper, DivineWhisperIntent, DivineWhisperRequest } from '../shared/worldmap.js';
import { RADIUS } from './mundo/tipos.js';
import { escuchaDe } from './genetics.js';

export const WHISPER_INTENTS: readonly DivineWhisperIntent[] = ['travel', 'explore', 'gather', 'build', 'craft', 'tend'] as const;
export const MAX_ACTIVE_WHISPERS = 16;
export const MAX_RETAINED_WHISPERS = 32;
/** Cada cuántos pasos se avanza la cola de mensajes (1 s del mundo). */
export const WHISPER_CHECK_TICKS = 10;
/** Probabilidad por paso de oír un mensaje de quien tiene escucha 1, calma plena y lo oye sin pérdida (audibilidad 1):
 * fija la escala del tiempo. Con ella, con calma 0,7, escucha 0,8 espera de media ≈ 110 pasos (≈ 1 h del mundo),
 * 0,4 ≈ 450 pasos (≈ 5 h) y 0,2 ≈ 1800 pasos (≈ 18 h); por debajo de ≈ 0,1 casi nunca lo oye antes del plazo. */
export const OIDO_POR_TICK = 0.02;
/** Riesgo por paso de olvidar un mensaje ya oído, por cada unidad que le falta a la escucha: `(1 − escucha) · OLVIDO_POR_TICK`. */
export const OLVIDO_POR_TICK = 0.001;
/** Distancia (celdas) a la que un mensaje regional se oye a la mitad: la que alcanza la vista de una persona. */
export const ALCANCE_VOZ = RADIUS;
/** Un mensaje que nadie oye en 3 días se desvanece. */
export const WHISPER_LIFETIME_TICKS = 7200;
/** Plazo para cumplirlo una vez oído (3 días); pasado, se desvanece. */
export const FULFIL_DEADLINE_TICKS = 7200;
/** Llegó: a 1,5 celdas o menos del destino. */
export const FULFIL_RADIUS = 1.5;
/** Comprobaciones seguidas (cada 10 pasos) persiguiéndolo sin acercarse nunca más: destino inalcanzable. */
export const STALL_CHECKS = 60;

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
  hunger: number;
  thirst: number;
  fatigue: number;
  genome: { alleles: readonly number[] };
}

export type WhisperFadeReason = 'gone' | 'unreachable' | 'deadline' | 'unheard' | 'forgotten';
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
  // Identificador único aunque la historia retenida ya haya descartado mensajes del mismo paso: el último
  // mensaje insertado nunca se descarta, así que el mayor número retenido de este paso más uno es siempre
  // nuevo (contar los retenidos repetía `w-<paso>-33` desde el mensaje 34 de un mismo paso).
  let sequence = 1;
  const prefix = `w-${tick}-`;
  for (const w of whispers) if (w.createdTick === tick && w.id.startsWith(prefix)) {
    const n = Number(w.id.slice(prefix.length));
    if (Number.isSafeInteger(n) && n >= sequence) sequence = n + 1;
  }
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

/** Cuánto le deja oír su cuerpo, en [0, 1]: cada necesidad acuciante le resta atención, sin umbral. */
export function calma(person: Pick<WhisperPersonLike, 'hunger' | 'thirst' | 'fatigue'>): number {
  const libre = (necesidad: number) => 1 - Math.min(1, Math.max(0, necesidad));
  return libre(person.hunger) * libre(person.thirst) * libre(person.fatigue);
}

/** Qué parte del mensaje llega a quien está a `distancia` de donde suena: 1 junto a él, 1/2 a `ALCANCE_VOZ`. */
export function audibilidad(distancia: number): number {
  const r = distancia / ALCANCE_VOZ;
  return 1 / (1 + r * r);
}

/** Probabilidad por paso de oír un mensaje: proporcional a `escucha² · calma · audibilidad`. */
export function probabilidadDeOir(escucha: number, calmaCuerpo: number, audible: number): number {
  return OIDO_POR_TICK * escucha * escucha * calmaCuerpo * audible;
}

/** Probabilidad de que algo con riesgo `p` por paso ocurra en `pasos` pasos seguidos. */
function enPasos(p: number, pasos: number): number {
  return p <= 0 || pasos <= 0 ? 0 : p >= 1 ? 1 : -Math.expm1(pasos * Math.log1p(-p));
}

/** Riesgo por paso de olvidar un mensaje ya oído. */
export function riesgoDeOlvido(escucha: number): number {
  return (1 - escucha) * OLVIDO_POR_TICK;
}

function resolve(w: WhisperRecord, status: 'fulfilled' | 'faded', tick: number) {
  w.status = status; w.resolvedTick = tick;
  delete w.bestDistance; delete w.stalledChecks;
}

/**
 * Avanza la cola de mensajes (llamar cada 10 pasos, sólo con mensajes). `isWater` dice si el destino es
 * agua (`undefined` si la celda no está cargada: se sabrá al acercarse). `elapsed` son los pasos desde la comprobación
 * anterior: el riesgo por paso se compone sobre ellos, así que el ritmo de las comprobaciones no cambia la ley. Sin
 * `Math.random`, sin reloj y sin el RNG del mundo.
 */
export function stepWhispers(
  whispers: WhisperRecord[],
  people: readonly WhisperPersonLike[],
  tick: number,
  seed: number,
  isWater?: (x: number, y: number) => boolean | undefined,
  elapsed: number = WHISPER_CHECK_TICKS,
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
      const oido = Math.min(elapsed, tick - (w.heardTick ?? w.createdTick));
      if (deterministicUnit(seed, tick, listener.id, `${w.id}:olvido`) < enPasos(riesgoDeOlvido(escuchaDe(listener.genome)), oido)) { fade(w, 'forgotten', listener); continue; }
      // Sólo cuenta como atasco el tiempo que la persona lo persigue (comer, beber o descansar no cuentan).
      const pursuing = listener.action === 'explore' && listener.target?.x === w.x && listener.target?.y === w.y;
      if (w.bestDistance === undefined || away < w.bestDistance - 0.5) { w.bestDistance = away; w.stalledChecks = 0; }
      else if (pursuing && (w.stalledChecks = (w.stalledChecks ?? 0) + 1) >= STALL_CHECKS) fade(w, 'unreachable', listener);
      continue;
    }

    // Latente.
    const age = tick - w.createdTick;
    if (age >= WHISPER_LIFETIME_TICKS) { fade(w, 'unheard', w.personId ? find(w.personId) : undefined); continue; }
    const dirigido = w.personId ? find(w.personId) : undefined;
    if (w.personId && !dirigido) { fade(w, 'gone'); continue; }
    if (isWater?.(w.x, w.y) === true) { fade(w, 'unreachable', dirigido); continue; }
    // Sólo cuenta el tiempo que el mensaje lleva sonando: uno recién dejado no se oye con pasos que no existían.
    const pasos = Math.min(elapsed, age);
    if (pasos <= 0) continue;
    // Un mensaje dirigido llega entero; uno regional lo oye quien esté cerca, y lo oye antes quien antes lo logre
    // (menor u/P entre los que aciertan), con independencia del orden de la lista.
    let oyente: WhisperPersonLike | undefined, mejor = Infinity;
    const posibles: readonly WhisperPersonLike[] = dirigido ? [dirigido] : people;
    for (let i = 0; i < posibles.length; i++) {
      const person = posibles[i]!;
      const probabilidad = enPasos(probabilidadDeOir(escuchaDe(person.genome), calma(person), dirigido ? 1 : audibilidad(dist(person, w))), pasos);
      if (probabilidad <= 0) continue;
      const u = deterministicUnit(seed, tick, person.id, w.id);
      if (u < probabilidad && u / probabilidad < mejor) { mejor = u / probabilidad; oyente = person; }
    }
    if (!oyente) continue;
    w.status = 'heard';
    w.heardTick = tick;
    w.heardById = oyente.id;
    w.heardByName = oyente.name;
    w.bestDistance = dist(oyente, w);
    w.stalledChecks = 0;
    outcome.heard.push({ whisper: w, person: oyente });
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
