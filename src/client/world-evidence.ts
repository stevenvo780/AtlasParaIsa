import type { ChronicleEvent, WorldView } from '../shared/types.js';
import { momento } from './cronica.js';
import { enClaro } from './textos.js';
import { esc, icon } from './ui-catalog.js';
import { nombreConocido } from './vistos.js';

/** Enlace a una persona. En cuadro: su nombre. Fuera de la cámara (M3): «Olmo · fuera de esta vista · Ir»,
 * que busca su posición; si murió hace poco, «Olmo · murió», que abre su despedida. Nunca un id interno. */
export function personLink(world: WorldView, id: string): string {
  const person = world.people.find(person => person.id === id);
  if (person) return `<button class="entity-link" data-person-link="${esc(id)}">${esc(person.name)}</button>`;
  const dead = world.demography?.recent.find(entry => entry.id === id);
  if (dead) return `<button class="entity-link is-absent" data-person-link="${esc(id)}" aria-label="${esc(dead.name)}, murió: ver su despedida">${esc(dead.name)} · murió</button>`;
  const name = nombreConocido(id, world);
  return `<button class="entity-link is-absent" data-person-link="${esc(id)}" aria-label="Ir a ${esc(name ?? 'una persona')} (fuera de esta vista)">${esc(name ?? 'Alguien')} · fuera de esta vista · Ir</button>`;
}

/** «Qué está ocurriendo» y «Huellas de esta vida». M5: lee el búfer de esta visita (`received`), no solo
 * los 40 episodios del último estado. */
export function recentEvidence(world: WorldView, personId?: string, received: readonly ChronicleEvent[] = world.events): string {
  const events = received.filter(event => !personId || event.actors.includes(personId)).slice(-4).reverse();
  const opening = personId ? '<section class="recent-evidence"><h3 class="section-title">Huellas de esta vida</h3>' : `<details class="recent-evidence" data-detail="world-events"><summary>Qué está ocurriendo <span>${events.length} episodios recientes</span></summary>`;
  return `${opening}<p class="stats-note">Episodios recibidos, con su causa registrada.</p>${events.length ? events.map(event => `<article data-event-id="${esc(event.id)}"><span class="experience-tick">${esc(momento(event.tick).toLocaleUpperCase('es'))} · ${event.source === 'sample' ? 'PRUEBA' : event.source === 'approved' ? 'APROBADO' : 'SIMULACIÓN'}</span><p>${esc(enClaro(event.text, { world }))}</p><small><strong>Qué influyó:</strong> ${esc(enClaro(event.cause, { world }))}</small><div class="evidence-links">${event.actors.slice(0,4).map(id=>personLink(world,id)).join('')}${event.x !== undefined && event.y !== undefined ? `<button class="entity-link" data-place-x="${esc(event.x)}" data-place-y="${esc(event.y)}">Ver lugar ${icon.arrow}</button>` : ''}</div></article>`).join('') : '<p class="stats-empty">No hay episodios de esta selección entre los que recibió este navegador.</p>'}${personId ? '</section>' : '</details>'}`;
}
