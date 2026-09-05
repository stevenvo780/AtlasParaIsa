import type { WorldView } from '../shared/types.js';
import { esc, icon } from './ui-catalog.js';

export function personLink(world: WorldView, id: string): string {
  const person = world.people.find(person => person.id === id);
  return person ? `<button class="entity-link" data-person-link="${esc(id)}">${esc(person.name)}</button>` : `<span>${esc(id)} · fuera de esta vista</span>`;
}

export function recentEvidence(world: WorldView, personId?: string): string {
  const events = world.events.filter(event => !personId || event.actors.includes(personId)).slice(-4).reverse();
  const opening = personId ? '<section class="recent-evidence"><h3 class="section-title">Huellas de esta vida</h3>' : `<details class="recent-evidence" data-detail="world-events"><summary>Qué está ocurriendo <span>${events.length} episodios recientes</span></summary>`;
  return `${opening}<p class="stats-note">Episodios recibidos, con su causa registrada.</p>${events.length ? events.map(event => `<article data-event-id="${esc(event.id)}"><span class="experience-tick">PASO ${esc(event.tick)} · ${event.source === 'sample' ? 'PRUEBA' : event.source === 'approved' ? 'APROBADO' : 'SIMULACIÓN'}</span><p>${esc(event.text)}</p><small><strong>Qué influyó:</strong> ${esc(event.cause)}</small><div class="evidence-links">${event.actors.filter(id=>world.people.some(person=>person.id===id)).slice(0,4).map(id=>personLink(world,id)).join('')}${event.x !== undefined && event.y !== undefined ? `<button class="entity-link" data-place-x="${esc(event.x)}" data-place-y="${esc(event.y)}">Ver lugar ${icon.arrow}</button>` : ''}</div></article>`).join('') : '<p class="stats-empty">No hay episodios de esta selección en la ventana recibida.</p>'}${personId ? '</section>' : '</details>'}`;
}
