/**
 * Una carta para Isa — modo ligero móvil (corrige P1, FR-008).
 *
 * `completo` dibuja con toda la resolución posible; `observador` recorta dpr,
 * fps e interpolación para un móvil de gama baja. La elección es del visitante
 * (`?modo=`, recordado en `localStorage`) o, a falta de eso, una heurística
 * conservadora del dispositivo: pantalla pequeña, poca memoria o sin WebGL2.
 */
export type Modo = 'completo' | 'observador';

const STORAGE_KEY = 'atlas-modo';
const isModo = (value: unknown): value is Modo => value === 'completo' || value === 'observador';

function fromQuery(): Modo | null {
  if (typeof location === 'undefined') return null;
  try { const value = new URLSearchParams(location.search).get('modo'); return isModo(value) ? value : null; }
  catch { return null; }
}

function fromStorage(): Modo | null {
  if (typeof localStorage === 'undefined') return null;
  try { const value = localStorage.getItem(STORAGE_KEY); return isModo(value) ? value : null; } catch { return null; }
}

const smallScreen = (): boolean => typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;

function limitedMemory(): boolean {
  if (typeof navigator === 'undefined') return false;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof memory === 'number' && memory < 4;
}

function noWebgl2(): boolean {
  // Sin `document` (Node, pruebas sin DOM) no hay forma de comprobarlo: se asume lo peor.
  if (typeof document === 'undefined') return true;
  try { return !document.createElement('canvas').getContext('webgl2'); } catch { return true; }
}

/** Persiste una elección explícita (conmutador de la barra, o `?modo=` al llegar). */
export function setModo(modo: Modo): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, modo); } catch { /* Almacenamiento no disponible; la elección no sobrevive a esta visita. */ }
}

/** `?modo=` manda y se recuerda; si no, la última elección; si no, heurística del dispositivo. */
export function decidirModo(): Modo {
  const query = fromQuery();
  if (query) { setModo(query); return query; }
  const stored = fromStorage();
  if (stored) return stored;
  return smallScreen() || limitedMemory() || noWebgl2() ? 'observador' : 'completo';
}
