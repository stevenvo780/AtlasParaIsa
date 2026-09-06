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
