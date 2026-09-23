import { validWorldInstanceId, type WorldInstanceView } from '../shared/world-instance.js';

interface VisitStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
const KEY = 'carta:last-visit-v2';
const validTick = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** One bounded bookmark. Legacy ticks have no provenance and cannot be assigned
 * to a new world, even when its seed, URL and protocol match the old world. */
export function readWorldVisit(storage: VisitStorage, world: WorldInstanceView): number | null {
  if (!validWorldInstanceId(world.instanceId) || !validTick(world.tick)) return null;
  try {
    const raw = storage.getItem(KEY);
    if (raw === null || raw.length > 256) return null;
    const visit: unknown = JSON.parse(raw);
    if (!visit || typeof visit !== 'object' || Array.isArray(visit)) return null;
    const value = visit as Record<string, unknown>;
    return value.version === 1 && value.instanceId === world.instanceId && validTick(value.tick) && value.tick <= world.tick
      ? value.tick : null;
  } catch { return null; }
}

export function saveWorldVisit(storage: VisitStorage, world: WorldInstanceView): void {
  if (!validWorldInstanceId(world.instanceId) || !validTick(world.tick)) return;
  try { storage.setItem(KEY, JSON.stringify({ version: 1, instanceId: world.instanceId, tick: world.tick })); }
  catch { /* Browser storage is optional; it never prevents access or saving the world. */ }
}

/**
 * M5 (versión 3): junto al marcador de la v2, contadores del estado real en el momento de irse, para
 * decir qué cambió al volver («+3 nacimientos · +2 regiones…»), y los hitos que este navegador vio
 * (como mucho 80). Todo va atado a `instanceId`: otro mundo no mezcla contadores ni hitos. Si solo
 * existe la v2, la visita sigue funcionando y los contadores faltan (null), sin romperse.
 */
const KEY_V3 = 'carta:visit-v3';
const KEY_HITOS = 'carta:hitos-v1';
export const MAX_HITOS_GUARDADOS = 80;

export interface VisitCounters { tick: number; births: number; deaths: number; conflicts: number; regions: number; recipes: number }
export interface HitoGuardado { id: string; tick: number; kind: string; text: string }

const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function saveVisitCounters(storage: VisitStorage, world: WorldInstanceView, counters: VisitCounters): void {
  if (!validWorldInstanceId(world.instanceId) || !validTick(world.tick)) return;
  try { storage.setItem(KEY_V3, JSON.stringify({ version: 3, instanceId: world.instanceId, ...counters })); } catch { /* Opcional. */ }
}

export function readVisitCounters(storage: VisitStorage, world: WorldInstanceView): VisitCounters | null {
  if (!validWorldInstanceId(world.instanceId) || !validTick(world.tick)) return null;
  try {
    const raw = storage.getItem(KEY_V3);
    if (raw === null || raw.length > 512) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || value.version !== 3 || value.instanceId !== world.instanceId) return null;
    const { tick, births, deaths, conflicts, regions, recipes } = value;
    if (![tick, births, deaths, conflicts, regions, recipes].every(counter) || (tick as number) > world.tick) return null;
    return { tick: tick as number, births: births as number, deaths: deaths as number, conflicts: conflicts as number, regions: regions as number, recipes: recipes as number };
  } catch { return null; }
}

export const MAX_TEXTO_HITO = 400;
/** Acota un hito a `max` caracteres sin partir una cita de la carta: la ley cita los recuerdos entre «»
 * (world/index.ts) y un título cortado a medias ya no sería el de la carta. Si el corte cae dentro de una
 * cita, se corta antes de ella y se marca con «…». */
export function recortarHito(text: string, max = MAX_TEXTO_HITO): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1), depth = 0, start = -1;
  // Profundidad de «»: un título de la carta puede llevar sus propias comillas dentro de la cita.
  for (let i = 0; i < cut.length; i++) {
    if (cut[i] === '«') { if (depth++ === 0) start = i; } else if (cut[i] === '»' && depth > 0) depth--;
  }
  if (depth > 0) cut = cut.slice(0, start).trimEnd();
  return `${cut}…`;
}

export function saveHitos(storage: VisitStorage, world: WorldInstanceView, hitos: readonly HitoGuardado[]): void {
  if (!validWorldInstanceId(world.instanceId)) return;
  const bounded = hitos.slice(-MAX_HITOS_GUARDADOS)
    .map(h => ({ id: String(h.id).slice(0, 100), tick: h.tick, kind: String(h.kind).slice(0, 20), text: recortarHito(String(h.text)) }));
  try { storage.setItem(KEY_HITOS, JSON.stringify({ version: 1, instanceId: world.instanceId, hitos: bounded })); } catch { /* Opcional. */ }
}

export function readHitos(storage: VisitStorage, world: WorldInstanceView): HitoGuardado[] {
  if (!validWorldInstanceId(world.instanceId)) return [];
  try {
    const raw = storage.getItem(KEY_HITOS);
    if (raw === null || raw.length > 64_000) return [];
    const value = JSON.parse(raw) as { version?: unknown; instanceId?: unknown; hitos?: unknown };
    if (value?.version !== 1 || value.instanceId !== world.instanceId || !Array.isArray(value.hitos)) return [];
    return value.hitos.filter((h): h is HitoGuardado => !!h && typeof h === 'object' && typeof h.id === 'string' && validTick(h.tick) && typeof h.kind === 'string' && typeof h.text === 'string')
      .slice(-MAX_HITOS_GUARDADOS);
  } catch { return []; }
}
