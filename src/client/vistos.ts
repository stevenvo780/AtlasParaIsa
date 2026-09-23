/**
 * M3: memoria del cliente de la última vez que vio a cada persona. `world.people` llega recortado a la
 * cámara, así que quien sale de cuadro deja de estar en el estado; aquí queda su nombre, su rol y la
 * última posición y paso en que se le vio (0 B en el cable). También recoge nombres de los difuntos
 * recientes (`demography.recent`) y lo que responde la ficha a demanda (`persona`, con x e y exactas).
 * Es una comodidad de esta visita: no se guarda y nunca sustituye al estado del servidor.
 */
import type { PersonDetail, PersonView, WorldView } from '../shared/types.js';

export interface Visto { id: string; nombre: string; role?: PersonView['role']; x?: number; y?: number; tick?: number; difunto?: boolean }

/** Cota: la memoria no crece con el mundo más allá de esto; se olvida primero a quien se vio hace más tiempo. */
export const MAX_VISTOS = 5000;
const vistos = new Map<string, Visto>();

function guardar(entry: Visto): void {
  vistos.delete(entry.id); vistos.set(entry.id, entry);
  if (vistos.size > MAX_VISTOS) vistos.delete(vistos.keys().next().value!);
}

/** Alimenta la memoria con un estado recibido. */
export function recordarVistos(view: Pick<WorldView, 'people' | 'tick' | 'demography'>): void {
  for (const entry of view.demography?.recent ?? []) {
    const known = vistos.get(entry.id);
    if (!known?.difunto) guardar({ ...known, id: entry.id, nombre: entry.name, difunto: true });
  }
  for (const p of view.people) guardar({ id: p.id, nombre: p.name, role: p.role, x: p.x, y: p.y, tick: view.tick });
}

/** La ficha a demanda trae la posición exacta aunque la persona esté fuera de cuadro. */
export function recordarPersona(detail: PersonDetail, tick: number): void {
  if (detail.x === undefined || detail.y === undefined) return;
  const known = vistos.get(detail.id);
  guardar({ ...known, id: detail.id, nombre: detail.name ?? known?.nombre ?? detail.id, x: detail.x, y: detail.y, tick, difunto: false });
}

export function visto(id: string): Visto | undefined { return vistos.get(id); }

/** Nombre conocido de una identidad: primero el estado actual, luego la memoria de esta visita. */
export function nombreConocido(id: string, view?: Pick<WorldView, 'people' | 'demography'> | null): string | undefined {
  return view?.people.find(p => p.id === id)?.name ?? view?.demography?.recent.find(entry => entry.id === id)?.name ?? vistos.get(id)?.nombre;
}

/** El id de S o de I si alguna vez se vio (en la vista o en la memoria). */
export function idDeRol(role: 'S' | 'I', view?: Pick<WorldView, 'people'> | null): string {
  const now = view?.people.find(p => p.role === role);
  if (now) return now.id;
  for (const entry of vistos.values()) if (entry.role === role) return entry.id;
  return role.toLowerCase();
}

export function olvidarVistos(): void { vistos.clear(); }
