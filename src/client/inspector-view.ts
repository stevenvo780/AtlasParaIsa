import type { AnimalView, BlueprintView, ChronicleEvent, PersonDetail, PersonView, StructureView, WorldView } from '../shared/types.js';
import { fertilidadFicha } from './natalidad-view.js';
import { momento } from './cronica.js';
import { enClaro } from './textos.js';
import { edadFicha, genealogiaFicha } from './linaje-view.js';
import { componentNames, componentPurpose } from './life-art.js';
import { carriedWaterCard, recipeLabel } from './technology-art.js';
import { esc, svg, icon, number, percentage } from './ui-catalog.js';
import { nombreConocido } from './vistos.js';
import { ejeDominante, ejesCultura } from './censo-view.js';
import { footprintCells, footprintLabel, installedCount, siteFractions, type ExtendedStructure } from './structure-art.js';
import { compoundLotsMarkup, swatch, phaseLabels, materialPropertiesMarkup } from './telemetry-hud.js';

/** FR-006: the legible context (place, tick, up to 3 prior episodes) of a `death` chronicle event,
 * for a «Historia» detail on an identity that no longer appears in `world.people`. The caller
 * resolves which event corresponds to the inspected legacy id (`world.events.find(...)`); an
 * event without a `death` field (older archive) renders nothing rather than a false blank. */
export function deathHistory(event: ChronicleEvent): string {
  if (!event.death) return '';
  const { x, y, tick, previous } = event.death;
  return `<details class="person-detail" data-detail="death" open><summary>Cómo y dónde terminó <span class="detail-badge">paso ${esc(tick)}</span></summary><p>Lugar: (${esc(x)}, ${esc(y)}).</p>${previous.length ? `<h4 class="detail-subtitle">Episodios previos</h4><ol class="experience-list">${previous.map(text => `<li><p>${esc(enClaro(text))}</p></li>`).join('')}</ol>` : '<p>Sin episodios previos en la ventana reciente de la crónica.</p>'}</details>`;
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
  const author = blueprint.inventorId ? nombreConocido(blueprint.inventorId, world) ?? 'Habitante fuera de esta vista' : 'Proyecto inicial';
  return `<article class="blueprint-card" data-blueprint="${esc(blueprint.id)}"><p class="eyebrow">PROYECTO · GENERACIÓN ${esc(blueprint.generation)}</p><h4>${esc(blueprint.name)}</h4><ul class="component-list">${parts.map(({ part, count }) => `<li><strong>${componentNames[part]}${count > 1 ? ` ×${count}` : ''}</strong><span>${componentPurpose[part]}</span></li>`).join('')}</ul><div class="blueprint-cost"><span><strong>${number(blueprint.cost.wood)}</strong> madera</span><span><strong>${number(blueprint.cost.stone)}</strong> piedra</span><span><strong>${number(blueprint.cost.work)}</strong> trabajo</span></div><p>Autor: ${esc(author)} · paso ${esc(blueprint.tick)}</p><p>Antecesores: ${blueprint.parents.length ? blueprint.parents.map(id => esc(world?.blueprints?.find(b => b.id === id)?.name ?? id)).join(' · ') : 'Primer diseño de su línea'}</p><div class="tile-facts"><span>Usos observados<strong>${number(blueprint.uses)}</strong></span><span>Utilidad aprendida<strong>${percentage(blueprint.usefulness)}</strong></span></div><small>La utilidad procede del uso; un proyecto nuevo todavía debe probarse.</small></article>`;
}
export function personBlueprint(person: PersonView, world: WorldView | null): BlueprintView | undefined {
  return world?.blueprints?.find(blueprint => blueprint.id === person.blueprintId);
}
/** V19: obra, planta, bodega y piezas instaladas; cada línea solo aparece si el servidor mandó ese dato. */
function structureV19Facts(structure: ExtendedStructure): string {
  const lines: string[] = [];
  const site = structure.site;
  if (site) lines.push(`<div data-structure-site><span>Obra en curso</span><strong>Madera ${number(site.depositedWood, 1)}/${number(site.requiredWood, 1)} · Piedra ${number(site.depositedStone, 1)}/${number(site.requiredStone, 1)} · Obra ${Math.round(siteFractions(site).work * 100)}%</strong></div>`);
  const footprint = footprintLabel(structure);
  if (footprint) lines.push(`<div data-structure-footprint><span>Planta</span><strong>${esc(footprint)}${structure.cells?.length ? ` <small>${number(footprintCells(structure).length)} ${footprintCells(structure).length === 1 ? 'casilla' : 'casillas'}</small>` : ''}</strong></div>`);
  if (structure.storedWood !== undefined || structure.storedStone !== undefined) lines.push(`<div data-structure-stock><span>Almacén</span><strong>Bodega: ${resourceQuantity(structure.storedWood ?? 0)} madera · ${resourceQuantity(structure.storedStone ?? 0)} piedra</strong></div>`);
  if (structure.installed) lines.push(`<div data-structure-installed><span>Piezas técnicas instaladas</span><strong>${number(installedCount(structure))}</strong></div>`);
  return lines.length ? `<div class="structure-reserves structure-v19">${lines.join('')}</div>` : '';
}
/** V20: sinergias vivas, perfil material y compuestos almacenados; cada bloque solo aparece si el servidor mandó ese dato. */
export function structureV20Facts(structure: StructureView): string {
  const blocks: string[] = [];
  const syn = structure.synergy;
  if (syn) {
    const badges: string[] = [];
    if (syn.sharedEdges > 0) badges.push(`<span class="synergy-badge" data-synergy="shared">+${number(syn.sharedEdges)} ${syn.sharedEdges === 1 ? 'muro compartido' : 'muros compartidos'}</span>`);
    if (syn.heated) badges.push('<span class="synergy-badge is-heat" data-synergy="heated">Secado / calor local</span>');
    if ((syn.kilnTier ?? 0) >= 1) badges.push(`<span class="synergy-badge is-heat" data-synergy="kiln">Horno T${esc(syn.kilnTier ?? 0)}</span>`);
    if (syn.irrigated) badges.push('<span class="synergy-badge is-water" data-synergy="irrigated">Riego de cisterna</span>');
    if (syn.workshopBonus > 0) badges.push(`<span class="synergy-badge" data-synergy="workshop">Taller -${esc(percentage(Math.min(1, syn.workshopBonus)))} tiempo</span>`);
    blocks.push(`<div data-structure-synergy><span>Sinergias activas</span><div class="synergy-badges">${badges.length ? badges.join('') : '<small>Ninguna por ahora</small>'}</div></div>`);
  }
  const mat = structure.materialProfile;
  if (mat) blocks.push(`<div data-structure-material><span>Perfil material</span><div class="material-profile">${swatch(mat.tint)}<span>Fuerza <strong>${esc(percentage(mat.strength))}</strong></span><span>Aislamiento <strong>${esc(percentage(mat.insulation))}</strong></span><span>Sellado <strong>${esc(percentage(mat.seal))}</strong></span></div></div>`);
  const lots = structure.storedCompounds ?? [];
  if (lots.length) blocks.push(`<div data-structure-compounds-block><span>Compuestos almacenados</span>${compoundLotsMarkup(lots, 'data-structure-compounds')}</div>`);
  return blocks.length ? `<div class="structure-reserves structure-v20">${blocks.join('')}</div>` : '';
}
export function structureCard(structure: StructureView, world: WorldView | null): string {
  const blueprint = world?.blueprints?.find(b => b.id === structure.blueprintId);
  const parts = [...new Set(structure.components)].map(part => `${componentNames[part]}${structure.components.filter(p => p === part).length > 1 ? ` ×${structure.components.filter(p => p === part).length}` : ''}`);
  const cisterns = structure.components.filter(part => part === 'cistern').length, granaries = structure.components.filter(part => part === 'granary').length;
  return `<section class="structure-card" data-structure="${esc(structure.id)}">${meter('Estado', structure.condition)}<div class="structure-reserves">${cisterns ? `<div data-structure-water><span>Agua en la cisterna</span><strong>${resourceQuantity(structure.water)} <small>/ ${number(cisterns * .6, 2)} u.</small></strong></div>` : ''}${granaries ? `<div data-structure-food><span>Alimento en el granero</span><strong>${resourceQuantity(structure.food)} <small>/ ${number(granaries * .7, 2)} u.</small></strong></div>` : ''}</div>${structureV19Facts(structure as ExtendedStructure)}${structureV20Facts(structure)}<p class="drawer-note">${structure.condition <= .1 ? 'Dañada: necesita reparación para funcionar.' : structure.condition < .65 ? 'El desgaste reduce sus prestaciones.' : 'En condiciones de uso.'}</p><p class="structure-components">${parts.join(' · ')}</p><div class="structure-benefit"><span>Usos con beneficio</span><strong>${number(structure.uses)}</strong></div><p class="drawer-note structure-history-note">Acumulados desde su construcción; no indican ocupación actual.</p>${blueprint ? `<details class="person-detail" data-detail="structure-blueprint-${esc(structure.id)}"><summary>Proyecto y materiales</summary>${blueprintCard(blueprint, world)}</details>` : ''}</section>`;
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

/** Material provenance remains visible even when its formula details are outside the sample. */
export function forgedToolMarkup(item: NonNullable<WorldView['technology']>['items'][number], world: WorldView): string {
  const formula = item.chemFormulaId ? world.chemistry?.formulas.find(f => f.id === item.chemFormulaId) : undefined;
  const chemical = item.materialTint || item.chemFormulaId || item.chemPhase;
  return `<div data-held-item="${esc(item.id)}"><div class="skill-row"><span>${item.recipeId ? procedureReference(item.recipeId, world.technology) : 'Material sin procedimiento asociado'}</span></div><div class="skill-row"><span>Material del objeto</span><strong>${number(item.mass / 1000, 3)} u. de material</strong></div>${chemical ? `<div data-forged-material>${swatch(item.materialTint)}<span>Procedencia química: ${esc(item.chemFormulaId ?? 'Sin fórmula recibida')}</span>${item.chemPhase ? `<span class="detail-badge">${esc(item.chemPhase === 'vitrified' ? 'vitrificado' : phaseLabels[item.chemPhase] ?? item.chemPhase)}</span>` : ''}${materialPropertiesMarkup(formula?.properties)}${formula ? '' : '<small>Propiedades de la fórmula fuera de esta vista.</small>'}</div>` : ''}${carriedWaterCard(item)}</div>`;
}

/** M9: de dónde viene un procedimiento que recuerda: lo inventó, de quién lo aprendió y cuándo, o que no consta. */
function origenProcedimiento(id: string, procedimientos: PersonDetail['procedimientos'], world: WorldView): string {
  const origen = procedimientos?.find(entry => entry.id === id);
  if (!origen) return '';
  const dia = origen.tick !== undefined ? `, día ${number(Math.floor(origen.tick / 2400) + 1)}` : '';
  // Sin nombre en el servidor ni en este navegador no se dice que «el mundo ya no lo conserva»: solo que no consta.
  const maestro = origen.maestro?.nombre ?? nombreConocido(origen.maestro?.id ?? '', world) ?? 'alguien cuyo nombre ya no consta';
  const texto = origen.origen === 'invento' ? `Lo inventó${dia}`
    : origen.origen === 'aprendido' ? `Aprendido de ${maestro}${dia}` : 'Origen no registrado';
  return `<small class="procedure-origin" data-origin="${esc(origen.origen)}">${esc(texto)}</small>`;
}

/** Una experiencia causada por un episodio `memory` de la carta (fuente de prueba o aprobada) ES el texto del
 * recuerdo (`remember(…, memory.text, …)` en world/index.ts): se muestra literal aunque ese recuerdo ya no
 * llegue en `world.memories`. El resto pasa por `enClaro`, que también deja literal lo que reconoce de la carta. */
export function textoDeExperiencia(text: string, cause: ChronicleEvent | undefined, world: WorldView): string {
  return cause?.kind === 'memory' && cause.source !== 'simulation' ? text : enClaro(text, { world });
}

/** V18: la ÚNICA señal de la política neuronal que cruza el cable. `projectWorld` no envía
 * `policy` ni `policyPlasticity` (pesos y sesgos quedan en el servidor); la ley deja constancia
 * en `reason` solo cuando ese empuje SUPERÓ a la opción que iba primera por cuerpo y cercanía
 * (`choose` en world/index.ts: delta > 0,12 y acción distinta de la ganadora heurística). */
export const MARCA_POLITICA = 'Su política neuronal aprendida inclinó esta estrategia.';

export interface LecturaDecision {
  inclinadaPorPolitica: boolean;
  dirigida: boolean;
  razonBase: string;
  presionCorporal: { etiqueta: string; valor: number } | null;
  urgenciaCorporalSevera: boolean;
  distintivo: 'aprendida' | 'dirigida' | 'sin marca';
}

type CuerpoDecision = Pick<PersonView, 'reason' | 'controlMode' | 'hunger' | 'thirst' | 'fatigue' | 'energy'>;

const enRango = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Descompone la elección recibida en causa corporal y estrategia aprendida, solo con campos que
 * ya viajan en `PersonView`. Sin la marca no se afirma que la política no exista ni que no empujara
 * en la misma dirección: solo que no consta que cambiara esta elección. */
export function lecturaDecision(p: CuerpoDecision): LecturaDecision {
  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
  const inclinadaPorPolitica = reason.endsWith(MARCA_POLITICA);
  const razonBase = inclinadaPorPolitica ? reason.slice(0, -MARCA_POLITICA.length).trim() : reason;
  const presiones: { etiqueta: string; valor: number }[] = [];
  if (enRango(p.hunger)) presiones.push({ etiqueta: 'Hambre', valor: p.hunger });
  if (enRango(p.thirst)) presiones.push({ etiqueta: 'Sed', valor: p.thirst });
  if (enRango(p.fatigue)) presiones.push({ etiqueta: 'Cansancio', valor: p.fatigue });
  if (enRango(p.energy)) presiones.push({ etiqueta: 'Falta de energía', valor: 1 - p.energy });
  presiones.sort((a, b) => b.valor - a.valor);
  const dirigida = p.controlMode === 'directed';
  return {
    inclinadaPorPolitica,
    dirigida,
    razonBase,
    presionCorporal: presiones[0] ?? null,
    // La ley apaga el empuje de la política con hambre o sed por encima de 0,75.
    urgenciaCorporalSevera: (enRango(p.hunger) && p.hunger > 0.75) || (enRango(p.thirst) && p.thirst > 0.75),
    distintivo: inclinadaPorPolitica ? 'aprendida' : dirigida ? 'dirigida' : 'sin marca',
  };
}

/** Ficha › Ahora › «Por qué hace esto»: cuerpo y cercanía frente a estrategia aprendida, en un
 * `<details>` cerrado (no satura ni carga el modo ligero; el distintivo se lee en el resumen). */
export function decisionFicha(p: PersonView, world: WorldView): string {
  const d = lecturaDecision(p);
  const presion = d.presionCorporal
    ? `<div class="skill-row"><span>Lo que más aprieta en su cuerpo</span><strong>${esc(d.presionCorporal.etiqueta)} · ${esc(percentage(d.presionCorporal.valor))}</strong></div>`
    : '<p>Su estado corporal no llegó completo en esta vista.</p>';
  const base = d.razonBase ? `<p><strong>Cuerpo y cercanía.</strong> ${esc(enClaro(d.razonBase, { world }))}</p>` : '';
  const estrategia = d.inclinadaPorPolitica
    ? '<p data-policy="inclinada"><strong>Estrategia aprendida.</strong> Su política aprendida inclinó esta elección por encima de la opción que iba primera por cuerpo y cercanía. Combina su red heredada con el sesgo que fue adquiriendo en esta vida; ese sesgo no pasa a su descendencia. Sus cifras no viajan a este navegador, así que aquí no se inventa cuánto empujó cada acción.</p>'
    : d.dirigida
      ? '<p data-policy="dirigida"><strong>Tarea dirigida.</strong> Sigue una orden: mientras su cuerpo lo permite, la tarea va por delante de su estrategia aprendida; el hambre, la sed o el agotamiento extremos pueden interrumpirla.</p>'
      : '<p data-policy="sin-marca"><strong>Estrategia aprendida.</strong> En esta elección no consta que su política aprendida la inclinara: la razón recibida se sostiene en su cuerpo y en lo que percibe cerca. Que no haya marca no dice que no tenga política, solo que no cambió esta elección.</p>';
  const urgencia = d.urgenciaCorporalSevera
    ? '<p>Con hambre o sed por encima del 75 %, esa política ni siquiera participa: manda la urgencia corporal.</p>' : '';
  const ritmoHeredado = p.genome && enRango(p.genome.learningRate)
    ? `<div class="skill-row"><span>Ritmo de aprendizaje heredado</span><strong>${esc(number(p.genome.learningRate, 2))}</strong></div><p>Ese ritmo, fijado al nacer, regula cuánto puede ajustar en vida el sesgo de su política.</p>` : '';
  return `<details class="person-detail" data-detail="decision"><summary>Por qué hace esto <span class="detail-badge">${esc(d.distintivo)}</span></summary>${presion}${base}${estrategia}${urgencia}${ritmoHeredado}</details>`;
}

export interface VinculoSI {
  distanciaCasillas: number;
  /** A 1,5 casillas o menos: el mismo umbral al que la ley deja que compartan una pausa. */
  juntoAhora: boolean;
  ultimoEncuentroTick: number | null;
  pasosDesdeEncuentro: number | null;
}

/** Distancia actual entre S e I y su último encuentro, solo con el estado recibido: posiciones de
 * AMBAS en este mismo `people` y episodios `meeting` (actores + paso) que este navegador recibió.
 * Nunca lee `memories`, `recentMemory` ni el texto de los episodios: ni un dato biográfico. */
export function vinculoSI(view: Pick<WorldView, 'people' | 'tick'>, eventos: readonly ChronicleEvent[]): VinculoSI | null {
  const s = view.people.find(p => p.role === 'S'), i = view.people.find(p => p.role === 'I');
  if (!s || !i || s.id === i.id) return null;
  if (![s.x, s.y, i.x, i.y].every(Number.isFinite)) return null;
  const distanciaCasillas = Math.hypot(s.x - i.x, s.y - i.y);
  let ultimo: number | null = null;
  for (const event of eventos) {
    if (event.kind !== 'meeting' || !event.actors.includes(s.id) || !event.actors.includes(i.id)) continue;
    if (!Number.isFinite(event.tick) || event.tick > view.tick) continue;
    if (ultimo === null || event.tick > ultimo) ultimo = event.tick;
  }
  return { distanciaCasillas, juntoAhora: distanciaCasillas <= 1.5, ultimoEncuentroTick: ultimo,
    pasosDesdeEncuentro: ultimo === null ? null : view.tick - ultimo };
}

/** Línea discreta en la ficha de S o de I. Si la otra identidad no está en el estado recibido no
 * dibuja nada: estar fuera de la cámara no es una distancia, y una posición recordada sería vieja. */
export function vinculoSIFicha(p: PersonView, world: WorldView, eventos: readonly ChronicleEvent[]): string {
  if (p.role !== 'S' && p.role !== 'I') return '';
  const v = vinculoSI(world, eventos);
  if (!v) return '';
  const cerca = v.juntoAhora ? ' Están lado a lado.' : '';
  const encuentro = v.ultimoEncuentroTick === null
    ? 'Este navegador no recibió ningún encuentro entre ambas entre los episodios guardados de esta visita.'
    : `Su último encuentro entre los episodios que recibió este navegador fue hace ${number(v.pasosDesdeEncuentro!)} ${v.pasosDesdeEncuentro === 1 ? 'paso' : 'pasos'} (${momento(v.ultimoEncuentroTick)}).`;
  return `<p class="drawer-note" data-vinculo-si>S e I están ahora a ${esc(number(v.distanciaCasillas, 1))} casillas en esta vista.${esc(cerca)} ${esc(encuentro)}</p>`;
}

/** T036(h): `p.experiences`, `p.trust` y el repertorio (`recipeIds`) ya no viajan en el `state`:
 * llegan con `{type:'persona'}`. `undefined` significa «todavía no ha llegado» y se dibuja como
 * «cargando…»; una lista vacía sí significa «no hay nada», y se dice con esas palabras. */
export function inheritedAndLearned(p: PersonView, world: WorldView, recipeIds?: string[], extra?: Pick<PersonDetail, 'fertil' | 'busca' | 'familia' | 'edades' | 'procedimientos' | 'inventadas'> | null, buscarEpisodio: (id: string) => ChronicleEvent | undefined = id => world.events.find(event => event.id === id), eventosRecibidos: readonly ChronicleEvent[] = world.events): { now: string; kit: string; story: string } {
  const skillNames: Record<string, string> = { gather: 'Recolección', gathering: 'Recolección', forage: 'Cosecha', farm: 'Cultivo', farming: 'Cultivo', build: 'Construcción', building: 'Construcción', explore: 'Exploración', exploration: 'Exploración', care: 'Cuidado', cooperate: 'Cooperación', hunt: 'Caza', drink: 'Búsqueda de agua',
    // M6: el resto de las prácticas que registra `outcome()` (world/index.ts), en claro.
    research: 'Investigación', share: 'Compartir', craft: 'Fabricación', technology: 'Técnica', invent: 'Invención', repair: 'Reparación', eat: 'Alimentarse', rest: 'Descanso', approach: 'Acercarse a otros', accompany: 'Compañía', retreat: 'Buscar espacio' };
  const skills = Object.entries(p.skills ?? {}).sort((a, b) => b[1] - a[1]);
  const traitNames: Record<string, string> = { curiosity: 'Curiosidad', sociability: 'Sociabilidad', industriousness: 'Constancia', care: 'Cuidado', resilience: 'Resiliencia' };
  const genome = p.genome;
  // M3: un progenitor fuera de la cámara se nombra y se puede ir a él; uno difunto abre su despedida.
  const parentMarkup = genome?.parents.length ? genome.parents.map(id => { const parent = world!.people.find(item => item.id === id); if (parent) return `<button class="lineage-person" data-parent="${esc(id)}">${esc(parent.name)} ${icon.arrow}</button>`; const dead = world.demography?.recent.find(entry => entry.id === id); const name = dead?.name ?? nombreConocido(id, world); return `<button class="lineage-person is-absent" data-parent="${esc(id)}">${esc(name ?? 'Progenitor')} · ${dead ? 'murió' : 'fuera de esta vista · Ir'} ${icon.arrow}</button>`; }).join('') : '<span class="lineage-absent">Población inicial · sin progenitores registrados</span>';
  const descendants = world.people.filter(other=>other.genome?.parents.includes(p.id));
  // M8: con la ficha a demanda, la familia se nombra en todo el mundo (vivos y difuntos registrados).
  const familia = genealogiaFicha(p, world, extra);
  const genetics = genome ? `<details class="person-detail" data-detail="genome"><summary>Herencia y genealogía <span class="detail-badge">G${esc(genome.generation)}</span></summary><p>Parámetros heredados y fijados al nacer. No cambian durante esta vida; no describen una biografía real.</p><div class="gene-chips"><span>Generación <strong>${esc(genome.generation)}</strong></span><span>Mutaciones <strong>${esc(genome.mutations)}</strong></span></div>${familia.progenitores ? `<div class="lineage"><h4>Progenitores</h4>${familia.progenitores}</div><div class="lineage"><h4>Descendencia</h4>${familia.descendencia}</div>` : `<div class="lineage"><h4>Progenitores</h4>${parentMarkup}</div><div class="lineage"><h4>Descendencia en esta vista</h4>${descendants.length ? descendants.map(child=>`<button class="lineage-person" data-parent="${esc(child.id)}">${esc(child.name)} · G${esc(child.genome?.generation ?? 'sin dato')} ${icon.arrow}</button>`).join('') : '<span class="lineage-absent">No hay descendientes en esta vista.</span>'}${extra === null ? '<p class="drawer-note" data-loading="family">Cargando su familia en todo el mundo…</p>' : ''}</div>`}<div class="skill-row"><span>Ritmo de aprendizaje</span><strong>${number(genome.learningRate, 2)}</strong></div>${meter('Cooperación heredada', genome.cooperation)}${edadFicha(p, extra)}<p>El ritmo heredado regula cuánto aprende de sus experiencias; no garantiza una conducta.</p></details>` : '';
  const learned = skills.length || p.traits ? `<details class="person-detail" data-detail="skills"><summary>Habilidades y carácter</summary>${skills.map(([name, value]) => `<div class="skill-row"><span>${esc(skillNames[name] ?? name)}</span><strong>${percentage(value)}</strong></div>`).join('')}${p.traits ? `<div class="trait-list">${Object.entries(p.traits).map(([name, value]) => `<span>${esc(traitNames[name] ?? name)} <strong>${percentage(value)}</strong></span>`).join('')}</div>` : ''}<p>Las habilidades cambian con la práctica y la experiencia. Los rasgos heredados orientan sus preferencias.</p></details>` : '';
  const community = world?.communities?.find(group => group.id === p.communityId);
  const ejePropio = ejeDominante(p.culture), ejeComunidad = community ? ejeDominante(community.culture) : null;
  const culturaLineas = `${ejePropio ? `<p data-culture-dominant>Su eje más alto en esta vista: <strong>${esc(ejePropio.etiqueta)} (${esc(percentage(ejePropio.valor!))})</strong>. ${esc(ejePropio.lectura)}</p>` : ''}${ejeComunidad && community ? `<p>El eje más alto de ${esc(community.name)} es ${esc(ejeComunidad.etiqueta.toLocaleLowerCase('es'))} (${esc(percentage(ejeComunidad.valor!))}), como promedio de sus miembros vivos.</p>` : ''}`;
  const social = p.culture || p.trust?.length || community ? `<details class="person-detail" data-detail="community"><summary>Cultura y vínculos</summary><div class="person-community"><small>COMUNIDAD ACTUAL</small>${community ? `<button class="entity-link" data-community="${esc(community.id)}">${esc(community.name)} ${icon.arrow}</button>` : '<strong>Sin comunidad</strong> <small>(pertenecer a una es opcional)</small>'}</div>${p.culture ? ejesCultura(p.culture).map(eje => eje.valor === null ? '' : meter(eje.etiqueta, eje.valor)).join('') || '<p>Cultura sin dato en esta vista.</p>' : '<p>Cultura sin dato en esta vista.</p>'}${culturaLineas}<p>Costumbres aprendidas en las interacciones. Pertenecer a otro grupo no implica hostilidad.</p>${p.trust === undefined ? '<p class="drawer-note" data-loading="trust">Cargando sus vínculos…</p>' : p.trust.length ? `<h4 class="detail-subtitle">Confianza registrada</h4><div class="trust-list">${[...p.trust].sort((a, b) => b.value - a.value).slice(0, 6).map(t => `<span><button class="entity-link" data-parent="${esc(t.id)}">${esc(nombreConocido(t.id, world) ?? 'Alguien')}${world!.people.some(other=>other.id===t.id) ? '' : ' · fuera de esta vista'}</button><strong>${number(t.value, 2)}</strong></span>`).join('')}</div><p>Valores del modelo, no una medida de afecto real.</p>` : '<p>Todavía no hay vínculos de confianza registrados.</p>'}</details>` : '';
  const experiences = `<details class="person-detail" data-detail="experiences"><summary>Últimas experiencias${p.experiences === undefined ? '' : ` <span class="detail-badge">${Math.min(8, p.experiences.length)}</span>`}</summary><p>Registro reciente de esta vida simulada. Conserva el momento y el episodio que lo originó.</p>${p.experiences === undefined ? '<p class="drawer-note" data-loading="experiences">Cargando sus últimas experiencias…</p>' : p.experiences.length ? `<ol class="experience-list">${p.experiences.slice(-8).reverse().map(experience => { const cause = buscarEpisodio(experience.causeId); return `<li><span class="experience-tick">${esc(momento(experience.tick).toLocaleUpperCase('es'))}</span><p>${esc(textoDeExperiencia(experience.text, cause, world))}</p><small><strong>Qué influyó:</strong> ${esc(cause ? enClaro(cause.cause, { world }) : 'El episodio que lo causó no está entre los que recibió este navegador.')}</small></li>`; }).join('')}</ol>` : '<p>Aún no hay experiencias registradas.</p>'}</details>`;
  const technology = world?.technology;
  const knowledge = recipeIds ?? technology?.knowledge?.find(entry => entry.actorId === p.id)?.recipeIds;
  const remembered = `<details class="person-detail" data-detail="procedures"><summary>Procedimientos que recuerda${knowledge ? ` <span class="detail-badge">${knowledge.length}</span>` : ''}</summary>
    ${!knowledge ? '<p class="drawer-note" data-loading="procedures">Cargando su repertorio…</p>' : knowledge.length
      ? `${extra?.inventadas ? `<p class="drawer-note" data-invented>Inventó ${number(extra.inventadas)} ${extra.inventadas === 1 ? 'procedimiento' : 'procedimientos'} de los que el mundo conserva.</p>` : ''}${knowledge.slice(0,32).map(id => `<div class="skill-row procedure-row">${procedureReference(id, technology)}${origenProcedimiento(id, extra?.procedimientos, world)}</div>`).join('')}${knowledge.length > 32 ? `<p>Aquí se muestran 32 de los ${number(knowledge.length)} procedimientos que recuerda.</p>` : ''}`
      : '<p>No recuerda ningún procedimiento ahora.</p>'}
    <p>Este repertorio cambia al aprender y olvidar. Es distinto de los rasgos heredados. Recordar un procedimiento no asegura tener los materiales para realizarlo.</p></details>`;
  const products = technology?.items.filter(item=>item.ownerId===p.id) ?? [];
  const toolkit = products.length ? `<details class="person-detail" data-detail="products"><summary>Objetos que lleva <span class="detail-badge">${products.length}</span></summary>${products.slice(0,8).map(item => forgedToolMarkup(item, world)).join('')}${products.length > 8 ? `<p>Se muestran 8 de los ${number(products.length)} objetos que lleva.</p>` : ''}<p>La masa del material cambia al usarlo o transformarlo. El agua de su composición es distinta del agua potable transportada. Las unidades de material y de agua del entorno son diferentes. Llevar un objeto no implica recordar cómo se fabrica.</p></details>` : '';
  const progress = p.working && p.workProgress !== undefined ? `<div class="game-needs task-progress">${meter('Progreso de la tarea',p.workProgress)}</div>` : '';
  const reserve = p.foodReserve !== undefined ? `<div class="food-reserve"><div><span>${icon.bag} Reserva de alimento</span><strong>${number(p.foodReserve,2)}${p.foodReserveCapacity !== undefined ? ` / ${number(p.foodReserveCapacity,2)}` : ''} u.</strong></div>${p.foodReserveCapacity !== undefined && p.foodReserveCapacity > 0 ? `<meter aria-label="Alimento reservado" min="0" max="${esc(p.foodReserveCapacity)}" value="${esc(p.foodReserve)}"></meter>` : ''}<p>Unidades de alimento del mundo.</p></div>` : '';
  const lifeStage = p.lifeStage === 'juvenile' ? 'En crecimiento' : p.lifeStage === 'adult' ? 'Edad de crianza' : p.lifeStage === 'senescent' ? 'Vejez' : 'Sin dato';
  const body = `<details class="person-detail" data-detail="vitality"><summary>Salud y ciclo de vida</summary><div class="skill-row" data-person-life-stage><span>Etapa del modelo</span><strong>${lifeStage}</strong></div>${fertilidadFicha(extra, world)}${p.health !== undefined?meter('Salud',p.health):''}${p.vitality !== undefined?meter('Vitalidad',p.vitality):''}<p>La etapa describe la edad del modelo; no garantiza una crianza. El alimento, el agua, el descanso y la exposición dejan consecuencias en el cuerpo.</p>${p.continuityProtected?'<p class="drawer-note">La continuidad de esta identidad está protegida por la configuración del mundo.</p>':''}</details>`;
  return { now: decisionFicha(p, world) + vinculoSIFicha(p, world, eventosRecibidos) + reserve + progress + body, kit: toolkit + remembered + learned, story: genetics + social + experiences };
}
