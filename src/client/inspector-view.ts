import type { AnimalView, BlueprintView, ChronicleEvent, PersonView, StructureView, WorldView } from '../shared/types.js';
import { componentNames, componentPurpose } from './life-art.js';
import { carriedWaterCard, recipeLabel } from './technology-art.js';
import { esc, svg, icon, number, percentage } from './ui-catalog.js';

/** FR-006: the legible context (place, tick, up to 3 prior episodes) of a `death` chronicle event,
 * for a «Historia» detail on an identity that no longer appears in `world.people`. The caller
 * resolves which event corresponds to the inspected legacy id (`world.events.find(...)`); an
 * event without a `death` field (older archive) renders nothing rather than a false blank. */
export function deathHistory(event: ChronicleEvent): string {
  if (!event.death) return '';
  const { x, y, tick, previous } = event.death;
  return `<details class="person-detail" data-detail="death" open><summary>Cómo y dónde terminó <span class="detail-badge">paso ${esc(tick)}</span></summary><p>Lugar: (${esc(x)}, ${esc(y)}).</p>${previous.length ? `<h4 class="detail-subtitle">Episodios previos</h4><ol class="experience-list">${previous.map(text => `<li><p>${esc(text)}</p></li>`).join('')}</ol>` : '<p>Sin episodios previos en la ventana reciente de la crónica.</p>'}</details>`;
}

/** A received snapshot describes current intent; it is not a new command acknowledgement. */
export function destinationLink(person: PersonView): string {
  if (!person.target) return '';
  const label = person.controlMode === 'directed' ? 'Destino de la tarea' : 'Destino actual';
  return `<button class="entity-link" title="Centrar la cámara en este destino" data-place-x="${esc(person.target.x)}" data-place-y="${esc(person.target.y)}">${label}: ${number(person.target.x, 1)}, ${number(person.target.y, 1)} ${icon.arrow}</button>`;
}

export function meter(label: string, value: number): string { const v = Math.max(0, Math.min(100, Math.round(value * 100))); return `<div class="game-need"><span>${esc(label)}</span><meter min="0" max="100" value="${v}" aria-label="${esc(label)}">${v}%</meter><span>${v}%</span></div>`; }
export function animalSilhouette(species: AnimalView['species']): string {
  const paths = { hare: 'M5 17h12v-7h4v7h-4v4H3v-4h2ZM16 10V2h2v8m2 0V3h2v7', deer: 'M3 13h13V8h6v7h-4v7h-2v-7H6v7H4V13Zm15-5V1m4 7V1m-6 2h7', boar: 'M3 12h16v-2h3v8h-3v4h-2v-4H6v4H4v-4H1v-6h2Zm17 6h4v-3', fish: 'm2 6 6 6L2 18V6Zm6 6 6-5h6l4 5-4 5h-6l-6-5Z', wolf: 'M4 14h11V7l3-5 2 5h3v8h-3v7h-2v-6H7v6H5v-6l-5-4v-3l4 5Z', fox: 'M7 14h8V8l2-6 3 5h3v7h-3v7h-2v-5H9v5H7v-4l-6-2V8l6 6Z' };
  return svg(`<path d="${paths[species]}"/>`);
}
export function blueprintCard(blueprint: BlueprintView, world: WorldView | null): string {
  const parts = [...new Set(blueprint.components)].map(part => ({ part, count: blueprint.components.filter(c => c === part).length }));
  const author = blueprint.inventorId ? world?.people.find(p => p.id === blueprint.inventorId)?.name ?? 'Habitante fuera de esta vista' : 'Proyecto inicial';
  return `<article class="blueprint-card" data-blueprint="${esc(blueprint.id)}"><p class="eyebrow">PROYECTO · GENERACIÓN ${esc(blueprint.generation)}</p><h4>${esc(blueprint.name)}</h4><ul class="component-list">${parts.map(({ part, count }) => `<li><strong>${componentNames[part]}${count > 1 ? ` ×${count}` : ''}</strong><span>${componentPurpose[part]}</span></li>`).join('')}</ul><div class="blueprint-cost"><span><strong>${number(blueprint.cost.wood)}</strong> madera</span><span><strong>${number(blueprint.cost.stone)}</strong> piedra</span><span><strong>${number(blueprint.cost.work)}</strong> trabajo</span></div><p>Autor: ${esc(author)} · paso ${esc(blueprint.tick)}</p><p>Antecesores: ${blueprint.parents.length ? blueprint.parents.map(id => esc(world?.blueprints?.find(b => b.id === id)?.name ?? id)).join(' · ') : 'Primer diseño de su línea'}</p><div class="tile-facts"><span>Usos observados<strong>${number(blueprint.uses)}</strong></span><span>Utilidad aprendida<strong>${percentage(blueprint.usefulness)}</strong></span></div><small>La utilidad procede del uso; un proyecto nuevo todavía debe probarse.</small></article>`;
}
export function personBlueprint(person: PersonView, world: WorldView | null): BlueprintView | undefined {
  return world?.blueprints?.find(blueprint => blueprint.id === person.blueprintId);
}
export function structureCard(structure: StructureView, world: WorldView | null): string {
  const blueprint = world?.blueprints?.find(b => b.id === structure.blueprintId);
  const parts = [...new Set(structure.components)].map(part => `${componentNames[part]}${structure.components.filter(p => p === part).length > 1 ? ` ×${structure.components.filter(p => p === part).length}` : ''}`);
  const cisterns = structure.components.filter(part => part === 'cistern').length, granaries = structure.components.filter(part => part === 'granary').length;
  return `<section class="structure-card" data-structure="${esc(structure.id)}">${meter('Estado', structure.condition)}<div class="structure-reserves">${cisterns ? `<div data-structure-water><span>Agua en la cisterna</span><strong>${resourceQuantity(structure.water)} <small>/ ${number(cisterns * .6, 2)} u.</small></strong></div>` : ''}${granaries ? `<div data-structure-food><span>Alimento en el granero</span><strong>${resourceQuantity(structure.food)} <small>/ ${number(granaries * .7, 2)} u.</small></strong></div>` : ''}</div><p class="drawer-note">${structure.condition <= .1 ? 'Dañada: necesita reparación para funcionar.' : structure.condition < .65 ? 'El desgaste reduce sus prestaciones.' : 'En condiciones de uso.'}</p><p class="structure-components">${parts.join(' · ')}</p><div class="structure-benefit"><span>Usos con beneficio</span><strong>${number(structure.uses)}</strong></div><p class="drawer-note structure-history-note">Acumulados desde su construcción; no indican ocupación actual.</p>${blueprint ? `<details class="person-detail" data-detail="structure-blueprint-${esc(structure.id)}"><summary>Proyecto y materiales</summary>${blueprintCard(blueprint, world)}</details>` : ''}</section>`;
}

/** A positive reserve smaller than the display precision must never read as zero. */
export function resourceQuantity(value: number): string {
  return value > 0 && value < .01 ? `&lt;${number(.01, 2)}` : number(value, 2);
}

function procedureReference(recipeId: string, technology: WorldView['technology']): string {
  const recipe = technology?.recipes.find(recipe => recipe.id === recipeId);
  return recipe
    ? `<button class="entity-link" data-recipe="${esc(recipe.id)}">${esc(recipeLabel(recipe))} ${icon.arrow}</button>`
    : `<span>Procedimiento ${esc(recipeId)}<br><small>Detalles fuera de esta vista.</small></span>`;
}

/** T036(h): `p.experiences`, `p.trust` y el repertorio (`recipeIds`) ya no viajan en el `state`:
 * llegan con `{type:'persona'}`. `undefined` significa «todavía no ha llegado» y se dibuja como
 * «cargando…»; una lista vacía sí significa «no hay nada», y se dice con esas palabras. */
export function inheritedAndLearned(p: PersonView, world: WorldView, recipeIds?: string[]): { now: string; kit: string; story: string } {
  const skillNames: Record<string, string> = { gather: 'Recolección', gathering: 'Recolección', forage: 'Cosecha', farm: 'Cultivo', farming: 'Cultivo', build: 'Construcción', building: 'Construcción', explore: 'Exploración', exploration: 'Exploración', care: 'Cuidado', cooperate: 'Cooperación', hunt: 'Caza', drink: 'Búsqueda de agua' };
  const skills = Object.entries(p.skills ?? {}).sort((a, b) => b[1] - a[1]);
  const traitNames: Record<string, string> = { curiosity: 'Curiosidad', sociability: 'Sociabilidad', industriousness: 'Constancia', care: 'Cuidado', resilience: 'Resiliencia' };
  const genome = p.genome;
  const parentMarkup = genome?.parents.length ? genome.parents.map(id => { const parent = world!.people.find(item => item.id === id); return parent ? `<button class="lineage-person" data-parent="${esc(id)}">${esc(parent.name)} ${icon.arrow}</button>` : `<span class="lineage-absent">${esc(id)} · fuera de esta vista</span>`; }).join('') : '<span class="lineage-absent">Población inicial · sin progenitores registrados</span>';
  const descendants = world.people.filter(other=>other.genome?.parents.includes(p.id));
  const genetics = genome ? `<details class="person-detail" data-detail="genome"><summary>Herencia y genealogía <span class="detail-badge">G${esc(genome.generation)}</span></summary><p>Parámetros heredados y fijados al nacer. No cambian durante esta vida; no describen una biografía real.</p><div class="gene-chips"><span>Generación <strong>${esc(genome.generation)}</strong></span><span>Mutaciones <strong>${esc(genome.mutations)}</strong></span></div><div class="lineage"><h4>Progenitores</h4>${parentMarkup}</div><div class="lineage"><h4>Descendencia en esta vista</h4>${descendants.length ? descendants.map(child=>`<button class="lineage-person" data-parent="${esc(child.id)}">${esc(child.name)} · G${esc(child.genome?.generation ?? 'sin dato')} ${icon.arrow}</button>`).join('') : '<span class="lineage-absent">No hay descendientes en el estado recibido.</span>'}</div><div class="skill-row"><span>Ritmo de aprendizaje</span><strong>${number(genome.learningRate, 2)}</strong></div>${meter('Cooperación heredada', genome.cooperation)}${p.age !== undefined ? `<p class="agent-age">Edad simulada: ${number(p.age)} pasos. No son años humanos.</p>` : ''}<p>El ritmo heredado regula cuánto aprende de sus experiencias; no garantiza una conducta.</p></details>` : '';
  const learned = skills.length || p.traits ? `<details class="person-detail" data-detail="skills"><summary>Habilidades y carácter</summary>${skills.map(([name, value]) => `<div class="skill-row"><span>${esc(skillNames[name] ?? name)}</span><strong>${percentage(value)}</strong></div>`).join('')}${p.traits ? `<div class="trait-list">${Object.entries(p.traits).map(([name, value]) => `<span>${esc(traitNames[name] ?? name)} <strong>${percentage(value)}</strong></span>`).join('')}</div>` : ''}<p>Las habilidades cambian con la práctica y la experiencia. Los rasgos heredados orientan sus preferencias.</p></details>` : '';
  const community = world?.communities?.find(group => group.id === p.communityId);
  const social = p.culture || p.trust?.length || community ? `<details class="person-detail" data-detail="community"><summary>Cultura y vínculos</summary><div class="person-community"><small>COMUNIDAD ACTUAL</small>${community ? `<button class="entity-link" data-community="${esc(community.id)}">${esc(community.name)} ${icon.arrow}</button>` : '<strong>Sin comunidad todavía</strong>'}</div>${p.culture ? meter('Compartir', p.culture.sharing)+meter('Cuidar el entorno', p.culture.stewardship)+meter('Apertura', p.culture.openness) : '<p>Cultura sin dato en esta vista.</p>'}<p>Costumbres aprendidas en las interacciones. Pertenecer a otro grupo no implica hostilidad.</p>${p.trust === undefined ? '<p class="drawer-note" data-loading="trust">Cargando sus vínculos…</p>' : p.trust.length ? `<h4 class="detail-subtitle">Confianza registrada</h4><div class="trust-list">${[...p.trust].sort((a, b) => b.value - a.value).slice(0, 6).map(t => `<span>${world!.people.some(other=>other.id===t.id) ? `<button class="entity-link" data-parent="${esc(t.id)}">${esc(world!.people.find(other=>other.id===t.id)!.name)}</button>` : esc(t.id)}<strong>${number(t.value, 2)}</strong></span>`).join('')}</div><p>Valores del modelo, no una medida de afecto real.</p>` : '<p>Todavía no hay vínculos de confianza registrados.</p>'}</details>` : '';
  const experiences = `<details class="person-detail" data-detail="experiences"><summary>Últimas experiencias${p.experiences === undefined ? '' : ` <span class="detail-badge">${Math.min(8, p.experiences.length)}</span>`}</summary><p>Registro reciente de esta vida simulada. Conserva el momento y el episodio que lo originó.</p>${p.experiences === undefined ? '<p class="drawer-note" data-loading="experiences">Cargando sus últimas experiencias…</p>' : p.experiences.length ? `<ol class="experience-list">${p.experiences.slice(-8).reverse().map(experience => { const cause = world!.events.find(event => event.id === experience.causeId); return `<li><span class="experience-tick">PASO ${esc(experience.tick)}</span><p>${esc(experience.text)}</p><small><strong>Qué influyó:</strong> ${esc(cause?.cause ?? 'El episodio causal ya no está en la ventana reciente de la crónica.')}</small></li>`; }).join('')}</ol>` : '<p>Aún no hay experiencias registradas.</p>'}</details>`;
  const technology = world?.technology;
  const knowledge = recipeIds ?? technology?.knowledge?.find(entry => entry.actorId === p.id)?.recipeIds;
  const remembered = `<details class="person-detail" data-detail="procedures"><summary>Procedimientos que recuerda${knowledge ? ` <span class="detail-badge">${knowledge.length}</span>` : ''}</summary>
    ${!knowledge ? '<p class="drawer-note" data-loading="procedures">Cargando su repertorio…</p>' : knowledge.length
      ? `${knowledge.slice(0,32).map(id => `<div class="skill-row">${procedureReference(id, technology)}</div>`).join('')}${knowledge.length > 32 ? `<p>Aquí se muestran 32 de los ${number(knowledge.length)} procedimientos que recuerda.</p>` : ''}`
      : '<p>No recuerda ningún procedimiento ahora.</p>'}
    <p>Este repertorio cambia al aprender y olvidar. Es distinto de los rasgos heredados. Recordar un procedimiento no asegura tener los materiales para realizarlo.</p></details>`;
  const products = technology?.items.filter(item=>item.ownerId===p.id) ?? [];
  const toolkit = products.length ? `<details class="person-detail" data-detail="products"><summary>Objetos que lleva <span class="detail-badge">${products.length}</span></summary>${products.slice(0,8).map(item=>`<div data-held-item="${esc(item.id)}"><div class="skill-row"><span>${item.recipeId ? procedureReference(item.recipeId, technology) : 'Material sin procedimiento asociado'}</span></div><div class="skill-row"><span>Material del objeto</span><strong>${number(item.mass/1000,3)} u. de material</strong></div>${carriedWaterCard(item)}</div>`).join('')}${products.length > 8 ? `<p>Se muestran 8 de los ${number(products.length)} objetos que lleva.</p>` : ''}<p>La masa del material cambia al usarlo o transformarlo. El agua de su composición es distinta del agua potable transportada. Las unidades de material y de agua del entorno son diferentes. Llevar un objeto no implica recordar cómo se fabrica.</p></details>` : '';
  const progress = p.working && p.workProgress !== undefined ? `<div class="game-needs task-progress">${meter('Progreso de la tarea',p.workProgress)}</div>` : '';
  const reserve = p.foodReserve !== undefined ? `<div class="food-reserve"><div><span>${icon.bag} Reserva de alimento</span><strong>${number(p.foodReserve,2)}${p.foodReserveCapacity !== undefined ? ` / ${number(p.foodReserveCapacity,2)}` : ''} u.</strong></div>${p.foodReserveCapacity !== undefined && p.foodReserveCapacity > 0 ? `<meter aria-label="Alimento reservado" min="0" max="${esc(p.foodReserveCapacity)}" value="${esc(p.foodReserve)}"></meter>` : ''}<p>Unidades de alimento del mundo.</p></div>` : '';
  const lifeStage = p.lifeStage === 'juvenile' ? 'En crecimiento' : p.lifeStage === 'adult' ? 'Edad de crianza' : p.lifeStage === 'senescent' ? 'Vejez' : 'Sin dato';
  const body = `<details class="person-detail" data-detail="vitality"><summary>Salud y ciclo de vida</summary><div class="skill-row" data-person-life-stage><span>Etapa del modelo</span><strong>${lifeStage}</strong></div>${p.health !== undefined?meter('Salud',p.health):''}${p.vitality !== undefined?meter('Vitalidad',p.vitality):''}<p>La etapa describe la edad del modelo; no garantiza una crianza. El alimento, el agua, el descanso y la exposición dejan consecuencias en el cuerpo.</p>${p.continuityProtected?'<p class="drawer-note">La continuidad de esta identidad está protegida por la configuración del mundo.</p>':''}</details>`;
  return { now: reserve + progress + body, kit: toolkit + remembered + learned, story: genetics + social + experiences };
}
