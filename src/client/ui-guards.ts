/**
 * V24 — validación de lo que el cliente recibe de /api/worldmap, /api/directory y /api/whispers, y perfil de dibujo.
 * Puro y sin DOM: una respuesta con forma inesperada (elementos nulos, coordenadas ausentes) se trata como un fallo y
 * nunca llega a las listas, al minimapa ni al bucle de dibujo.
 */
import type { DivineWhisper, WorldDirectoryResponse, WorldMapResponse } from '../shared/worldmap.js';
import type { GraphicsSettings } from './graphics-settings.js';
import type { Modo } from './modo.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string';
const everyRecord = (list: unknown, ok: (row: Record<string, unknown>) => boolean): boolean => Array.isArray(list) && list.every(row => record(row) && ok(row));
const place = (row: Record<string, unknown>): boolean => finite(row.x) && finite(row.y);

export function validMap(data: unknown): data is WorldMapResponse {
  if (!record(data) || !record(data.bounds)) return false;
  const b = data.bounds;
  return [b.minCx, b.maxCx, b.minCy, b.maxCy].every(finite)
    && everyRecord(data.chunks, c => finite(c.cx) && finite(c.cy) && text(c.cells))
    && everyRecord(data.markers, m => place(m) && text(m.kind));
}

export function validDirectory(data: unknown): data is WorldDirectoryResponse {
  return record(data)
    && everyRecord(data.people, p => text(p.id) && text(p.name) && place(p))
    && everyRecord(data.communities, c => text(c.id) && text(c.name) && place(c))
    && everyRecord(data.structures, s => text(s.name) && place(s))
    && everyRecord(data.herds, h => text(h.species) && place(h) && finite(h.count));
}

export function validWhisper(value: unknown): value is DivineWhisper {
  return record(value) && text(value.id) && place(value) && finite(value.createdTick) && text(value.note) && text(value.status) && text(value.intent);
}

export const validWhispers = (data: unknown): data is { tick: number; whispers: DivineWhisper[] } =>
  record(data) && Array.isArray(data.whispers) && data.whispers.every(validWhisper);

export const validWhisperResult = (data: unknown): data is { ok: true; whisper: DivineWhisper } => record(data) && validWhisper(data.whisper);

/**
 * GET con tiempo límite y validación. Cualquier fallo (red, HTTP ≠ 2xx, JSON roto, forma inesperada, tiempo agotado,
 * cancelación de la sesión) se convierte en un `Error`; quien llama decide cómo degradar.
 */
export async function fetchJson<T>(url: string, session: AbortSignal, valid: (data: unknown) => data is T, timeoutMs = 8000): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([session, AbortSignal.timeout(timeoutMs)]) });
  if (!response.ok) throw new Error('Información no disponible.');
  const data: unknown = await response.json();
  if (!valid(data)) throw new Error('Información con forma inesperada.');
  return data;
}

/** El perfil elegido en Ajustes es lo único que decide el modo de dibujo: «Ligero» es el modo observador; los demás, el completo. */
export const modoDeAjustes = (settings: Pick<GraphicsSettings, 'preset'>): Modo => settings.preset === 'ligero' ? 'observador' : 'completo';
