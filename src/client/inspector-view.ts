import type { ReaccionObservada } from '../shared/reaccion-observada.js';
import type { TecnicaVisible } from '../shared/tecnica-visible.js';
import type { AnimalView, BlueprintView, ChronicleEvent, PersonDetail, PersonView, StructureView, Tile, WorldView } from '../shared/types.js';
import type { CrianzaVisible, CuerpoVisible, LoteVisible, SustanciasVisibles } from '../shared/vistas-v23.js';
import { ClaseSustancia, TIPOS, type Propiedades, type SustanciaVista } from '../shared/materia.js';
import { ELEMENTOS } from '../shared/naturaleza.js';
import { fertilidadFicha } from './natalidad-view.js';
import { momento } from './cronica.js';
import { enClaro } from './textos.js';
import { edadFicha, genealogiaFicha } from './linaje-view.js';
import { componentNames, componentPurpose } from './life-art.js';
import { carriedWaterCard, recipeLabel } from './technology-art.js';
import { esc, svg, icon, number, percentage, COLOR_ELEMENTO, NOMBRE_ELEMENTO } from './ui-catalog.js';
import { nombreConocido } from './vistos.js';
import { personLink } from './world-evidence.js';
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

export function meter(label: string, value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `<div class="game-need" data-meter="no-grabado"><span>${esc(label)}</span><em class="sin-dato">no grabado</em></div>`;
  const v = Math.max(0, Math.min(100, Math.round(value * 100)));
  return `<div class="game-need"><span>${esc(label)}</span><meter min="0" max="100" value="${v}" aria-label="${esc(label)}">${v}%</meter><span>${v}%</span></div>`;
}

const numeroFinito = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** L1 conserva necesidad y etapa, y no copia energía, hambre ni cansancio. Un cero grabado sigue siendo finito. */
export function instanteResumido(p: Pick<PersonView, 'energy' | 'hunger' | 'fatigue'>): boolean {
  return !numeroFinito(p.energy) && !numeroFinito(p.hunger) && !numeroFinito(p.fatigue);
}

/** Una sola nota, y solo cuando el instante no trae las tres necesidades. No rellena otro tick. */
export function notaGrabacionResumida(p: Pick<PersonView, 'energy' | 'hunger' | 'fatigue'>): string {
  if (!instanteResumido(p)) return '';
  return '<p class="drawer-note" data-grabacion="resumida">Esta grabación conserva la actividad y la etapa. Los datos individuales requieren el fotograma detallado de este instante.</p>';
}

/** Necesidades del habitante en el fotograma abierto. Ausente se omite; cero se muestra. */
export function necesidadesPersona(p: Pick<PersonView, 'need' | 'energy' | 'hunger' | 'thirst' | 'fatigue'>): string {
  const metros = ([['Energía', p.energy], ['Hambre', p.hunger], ['Sed', p.thirst], ['Cansancio', p.fatigue]] as const)
    .map(([etiqueta, valor]) => numeroFinito(valor) ? meter(etiqueta, valor) : '')
    .join('');
  const titulo = typeof p.need === 'string' && p.need.trim()
    ? `<h3>Ahora necesita ${esc(p.need.toLocaleLowerCase('es'))}</h3>` : '';
  return titulo || metros ? `<div class="game-needs">${titulo}${metros}</div>` : '';
}
/** Un resumen de fauna puede conservar la actividad sin incluir su estado corporal. */
export function necesidadesAnimal(a: Partial<Pick<AnimalView, 'energy' | 'hunger' | 'thirst' | 'fatigue' | 'health'>>): string {
  const metros = ([['Energía', a.energy], ['Hambre', a.hunger], ['Sed', a.thirst], ['Cansancio', a.fatigue], ['Salud', a.health]] as const)
    .map(([etiqueta, valor]) => numeroFinito(valor) ? meter(etiqueta, valor) : '')
    .join('');
  return metros ? `<div class="game-needs"><h3>Necesidades de este individuo</h3>${metros}</div>` : '';
}
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
  const almacen = [
    numeroFinito(structure.storedWood) ? `${resourceQuantity(structure.storedWood)} madera` : '',
    numeroFinito(structure.storedStone) ? `${resourceQuantity(structure.storedStone)} piedra` : '',
  ].filter(Boolean);
  if (almacen.length) lines.push(`<div data-structure-stock><span>Almacén</span><strong>Bodega: ${almacen.join(' · ')}</strong></div>`);
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
  const nombrePieza = (part: string): string => (componentNames as Record<string, string>)[part] ?? `componente «${part}» (sin nombre en el catálogo legado)`;
  const parts = [...new Set(structure.components)].map(part => `${nombrePieza(part)}${structure.components.filter(p => p === part).length > 1 ? ` ×${structure.components.filter(p => p === part).length}` : ''}`);
  const cisterns = structure.components.filter(part => part === 'cistern').length, granaries = structure.components.filter(part => part === 'granary').length;
  const agua = structure.water === undefined ? '<em class="sin-dato">no grabado</em>' : resourceQuantity(structure.water);
  const comida = structure.food === undefined ? '<em class="sin-dato">no grabado</em>' : resourceQuantity(structure.food);
  const autor = structure.builderId ? world?.people.find(p => p.id === structure.builderId) : undefined;
  const fecha = numeroFinito(structure.builtAt) && (world === null || structure.builtAt <= world.tick)
    ? `<p class="drawer-note" data-structure-built>Registro de construcción · paso ${number(structure.builtAt)}${world && autor ? ` · ${personLink(world, autor.id)}` : ''}</p>` : '';
  const estado = numeroFinito(structure.condition) ? meter('Estado', structure.condition)
    + `<p class="drawer-note">${structure.condition <= .1 ? 'Dañada: necesita reparación para funcionar.' : structure.condition < .65 ? 'El desgaste reduce sus prestaciones.' : 'En condiciones de uso.'}</p>` : '';
  return `<section class="structure-card" data-structure="${esc(structure.id)}">${estado}<div class="structure-reserves">${cisterns ? `<div data-structure-water><span>Agua en la cisterna</span><strong>${agua} <small>/ ${number(cisterns * .6, 2)} u.</small></strong></div>` : ''}${granaries ? `<div data-structure-food><span>Alimento en el granero</span><strong>${comida} <small>/ ${number(granaries * .7, 2)} u.</small></strong></div>` : ''}</div>${structureV19Facts(structure as ExtendedStructure)}${structureV20Facts(structure)}${parts.length ? `<p class="structure-components" data-structure-design>Diseño: ${parts.join(' · ')}</p>` : ''}${piezasObra(structure, world)}${fichaReaccion(undefined, 'obra')}${fecha}<div class="structure-benefit"><span>Usos con beneficio</span><strong>${number(structure.uses)}</strong></div><p class="drawer-note structure-history-note">Acumulados desde su construcción; no indican ocupación actual.</p>${blueprint ? `<details class="person-detail" data-detail="structure-blueprint-${esc(structure.id)}"><summary>Proyecto y materiales</summary>${blueprintCard(blueprint, world)}</details>` : ''}</section>`;
}

/** A positive reserve smaller than the display precision must never read as zero. */
export function resourceQuantity(value: number): string {
  return value > 0 && value < .01 ? `&lt;${number(.01, 2)}` : number(value, 2);
}

/** Inventario legado de madera y piedra. Ausente no es cero. */
export function fichaMateriales(p: Pick<PersonView, 'materials'>): string {
  const m = p.materials;
  if (!m) return '<p class="drawer-note" data-materiales="no-grabado">El inventario de madera y piedra no vino en este fotograma.</p>';
  const celda = (etiqueta: string, valor: number | undefined, marca: string): string => {
    const marcaIcono = marca === 'wood' ? icon.leaf : icon.hammer;
    if (typeof valor !== 'number' || !Number.isFinite(valor)) return `<span data-material="${marca}">${marcaIcono}<em class="sin-dato">no grabado</em> ${etiqueta}</span>`;
    return `<span data-material="${marca}" data-cero="${valor === 0 ? 'si' : 'no'}">${marcaIcono}<strong>${number(valor)}</strong> ${etiqueta}</span>`;
  };
  return `<div class="material-pouch" data-materiales="legado">${celda('madera', m.wood, 'wood')}${celda('piedra', m.stone, 'stone')}</div><p class="drawer-note">Contador legado. Un cero es cero de ese contador, no la masa del cuerpo ni de los lotes.</p>`;
}

/** Técnica sobre lotes de esta persona en su tick. Ausente no es «ninguna receta». */
export function fichaTecnica(t: TecnicaVisible | undefined): string {
  if (!t) return '<section class="tecnica-ficha" data-tecnica="no-grabado"><h4 class="detail-subtitle">Técnica sobre lotes</h4><p class="drawer-note">Esta ficha no trae técnica sobre lotes. Puede ser un mundo sin esa ley o un fotograma que no la grabó. No es cero recetas.</p></section>';
  const receta = (r: TecnicaVisible['recetas'][number]): string => {
    const origen = r.padres.length ? `Sale de las recetas nº ${r.padres.join(', ')}.` : 'No consta de qué receta sale ni de quién la enseñó.';
    const pasos = r.pasos === undefined
      ? '<p data-pasos="no-grabado">Esos pasos no estaban en el registro de este tick.</p>'
      : r.pasos.length
        ? `<ol>${r.pasos.map(p => `<li data-op="${esc(p.op)}">${esc(p.texto)}</li>`).join('')}</ol>`
        : '<p data-pasos="ninguno">El registro la tiene sin pasos.</p>';
    return `<article data-receta="${esc(r.id)}" data-tick="${esc(r.usada)}"><h5>Receta nº ${esc(r.id)} · generación ${esc(r.generacion)}</h5><p>Último uso en el paso ${esc(r.usada)}. ${esc(origen)}</p>${pasos}</article>`;
  };
  const lista = t.recetas.length
    ? t.recetas.map(receta).join('') + (t.omitidas ? `<p>Hay ${esc(t.omitidas)} recetas más recordadas; aquí están las de uso más reciente.</p>` : '')
    : '<p data-recetas="ninguna">No recuerda ninguna receta de lotes en este paso.</p>';
  const proceso = t.proceso
    ? `<div data-proceso="${esc(t.proceso.tipo)}" data-desde="${esc(t.proceso.desde)}"><p>${t.proceso.tipo === 'research' ? 'Investiga' : 'Fabrica'} la receta nº ${esc(t.proceso.receta)}, paso ${esc(t.proceso.paso)} de ${esc(t.proceso.total)}, desde el paso ${esc(t.proceso.desde)}.</p><ol>${t.proceso.pasos.map(p => `<li data-op="${esc(p.op)}">${esc(p.texto)}</li>`).join('')}</ol></div>`
    : '<p data-proceso="ninguno">Ningún proceso en curso.</p>';
  const intentos = Number.isFinite(t.intentos) ? `${number(t.intentos)} intentos registrados` : 'intentos no grabados';
  return `<section class="tecnica-ficha" data-tecnica="ok"><h4 class="detail-subtitle">Técnica sobre lotes</h4><p data-intentos>${esc(intentos)}.</p>${proceso}${lista}</section>`;
}

/** Una reacción aplicada de verdad. Una fórmula o dos fotos distintas no bastan. */
export function fichaReaccion(obs: ReaccionObservada | undefined, alcance: 'mundo' | 'obra'): string {
  if (!obs) {
    const texto = alcance === 'obra'
      ? 'Esta vista no trae una reacción aplicada a la obra. La fórmula de una pieza no es una reacción.'
      : 'Esta vista no trae una reacción aplicada. No se deduce de las sustancias presentes.';
    return `<p class="drawer-note" data-reaccion="no-grabado">${texto}</p>`;
  }
  const par = obs.b > 0 ? `las sustancias nº ${number(obs.a)} y nº ${number(obs.b)}` : `la sustancia nº ${number(obs.a)} sola`;
  const donde = alcance === 'obra'
    ? `Ocurrió en el lote nº ${number(obs.lote)}, no en la casa como tal.`
    : `Alcance: el lote nº ${number(obs.lote)}.`;
  return `<p class="drawer-note" data-reaccion="aplicada" data-muestra="si" data-tick="${esc(obs.tick)}" data-lote="${esc(obs.lote)}">Muestra de una reacción aplicada en el paso ${esc(obs.tick)}: ${par}, nivel ${esc(obs.nivel)}, ${esc(number(obs.veces))} ${obs.veces === 1 ? 'vez' : 'veces'}. ${donde} La fecha es la de esa aplicación, no la de la vista que la enseña.</p>`;
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
    : '';
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

/** Rasgos con la escucha de la ley E (`traits.escucha` ∈ [0,1], locus 8 del genoma); ausente en mundos sin esa ley. */
type ConEscucha = { escucha?: number; traits?: PersonView['traits'] & { escucha?: number } };
export function escuchaDe(p: ConEscucha | undefined): number | null {
  const e = p?.escucha ?? p?.traits?.escucha;
  return typeof e === 'number' && Number.isFinite(e) ? Math.max(0, Math.min(1, e)) : null;
}
/** 16 píxeles por barra: la escucha se lee como la cultura y las necesidades, de un vistazo. */
const barraEscucha = (etiqueta: string, e: number | null, clase = ''): string =>
  `<div class="escucha-fila${clase}"><span>${esc(etiqueta)}</span>${e === null ? '<em class="sin-dato">sin dato</em>' : `<span class="escucha-barra" style="--e:${Math.round(e * 16)}" role="meter" aria-label="${esc(etiqueta)}" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${e.toFixed(2)}"></span><strong>${esc(number(e, 2))}</strong>`}</div>`;

/** Ficha › Ahora › «Escucha»: su disposición heredable a atender susurros junto a la de sus progenitores, lo que
 * la ley le da ahora (oír ∝ escucha² · calma, con calma = (1 − hambre)(1 − sed)(1 − cansancio)) y la media de su
 * generación entre las vidas de esta vista. */
export function escuchaFicha(p: PersonView, world: Pick<WorldView, 'people' | 'demography'>): string {
  const propia = escuchaDe(p as ConEscucha);
  if (propia === null) return '';
  const padres = (p.genome?.parents ?? []).map((id, i) => {
    const padre = world.people.find(q => q.id === id);
    const nombre = padre?.name ?? nombreConocido(id, world) ?? `Progenitor ${i + 1}`;
    return padre ? barraEscucha(nombre, escuchaDe(padre as ConEscucha), ' escucha-padre') : `<div class="escucha-fila escucha-padre"><span>${esc(nombre)}</span><em class="sin-dato">fuera de esta vista</em></div>`;
  }).join('') || '<p class="drawer-note">Población inicial: su escucha no viene de progenitores registrados.</p>';
  const calma = [p.hunger, p.thirst, p.fatigue].every(v => typeof v === 'number' && Number.isFinite(v)) ? (1 - p.hunger) * (1 - p.thirst!) * (1 - p.fatigue) : null;
  const ahora = calma === null ? '' : `<p class="drawer-note" data-escucha-ahora>Con su calma de ahora (${esc(percentage(calma))}), la ley le da una probabilidad de oír un susurro audible proporcional a escucha² · calma = <strong>${esc(number(propia * propia * calma, 3))}</strong>.</p>`;
  const generacion = p.genome?.generation;
  const pares = generacion === undefined ? [] : world.people.filter(q => q.genome?.generation === generacion).map(q => escuchaDe(q as ConEscucha)).filter((e): e is number => e !== null);
  const media = pares.length ? `<p class="drawer-note" data-escucha-generacion>Media de la generación G${esc(generacion!)} en esta vista: <strong>${esc(number(pares.reduce((a, b) => a + b, 0) / pares.length, 2))}</strong> (${esc(number(pares.length))} ${pares.length === 1 ? 'vida' : 'vidas'}).</p>` : '';
  return `<section class="escucha-ficha" data-escucha="${propia.toFixed(2)}"><h4 class="detail-subtitle">Escucha</h4>${barraEscucha('Su escucha', propia, ' escucha-propia')}${padres}${ahora}${media}<p class="drawer-note">Disposición heredada a atender un susurro y quedarse con él. Se hereda de sus progenitores con mutación; obedecer no la cambia en vida.</p></section>`;
}

/** Los datos de la consulta a demanda solo se esperan al mirar la vista viva del servidor. */
export function inheritedAndLearned(p: PersonView, world: WorldView, recipeIds?: string[], extra?: Pick<PersonDetail, 'fertil' | 'busca' | 'familia' | 'edades' | 'procedimientos' | 'inventadas'> | null, buscarEpisodio: (id: string) => ChronicleEvent | undefined = id => world.events.find(event => event.id === id), eventosRecibidos: readonly ChronicleEvent[] = world.events, opciones?: { repertorio?: 'cargando' | 'no-grabado' }): { now: string; kit: string; story: string } {
  const enCinta = opciones?.repertorio === 'no-grabado';
  const skillNames: Record<string, string> = { gather: 'Recolección', gathering: 'Recolección', forage: 'Cosecha', farm: 'Cultivo', farming: 'Cultivo', build: 'Construcción', building: 'Construcción', explore: 'Exploración', exploration: 'Exploración', care: 'Cuidado', cooperate: 'Cooperación', hunt: 'Caza', drink: 'Búsqueda de agua',
    // M6: el resto de las prácticas que registra `outcome()` (world/index.ts), en claro.
    research: 'Investigación', share: 'Compartir', craft: 'Fabricación', technology: 'Técnica', invent: 'Invención', repair: 'Reparación', eat: 'Alimentarse', rest: 'Descanso', approach: 'Acercarse a otros', accompany: 'Compañía', retreat: 'Buscar espacio' };
  const skills = Object.entries(p.skills ?? {}).filter((entry): entry is [string, number] => numeroFinito(entry[1])).sort((a, b) => b[1] - a[1]);
  const traitNames: Record<string, string> = { curiosity: 'Curiosidad', sociability: 'Sociabilidad', industriousness: 'Constancia', care: 'Cuidado', resilience: 'Resiliencia', escucha: 'Escucha' };
  const genome = p.genome;
  // M3: un progenitor fuera de la cámara se nombra y se puede ir a él; uno difunto abre su despedida.
  const parentMarkup = genome?.parents.length ? genome.parents.map(id => {
    const parent = world.people.find(item => item.id === id);
    if (parent) return `<button class="lineage-person" data-parent="${esc(id)}">${esc(parent.name)} ${icon.arrow}</button>`;
    const dead = world.demography?.recent.find(entry => entry.id === id);
    if (enCinta && !dead) return '<span class="lineage-absent">Progenitor fuera de este fotograma.</span>';
    const name = dead?.name ?? nombreConocido(id, world);
    return `<button class="lineage-person is-absent" data-parent="${esc(id)}">${esc(name ?? 'Progenitor')} · ${dead ? 'murió' : 'fuera de esta vista · Ir'} ${icon.arrow}</button>`;
  }).join('') : '<span class="lineage-absent">Población inicial · sin progenitores registrados</span>';
  const descendants = world.people.filter(other=>other.genome?.parents.includes(p.id));
  // M8: con la ficha a demanda, la familia se nombra en todo el mundo (vivos y difuntos registrados).
  const familia = genealogiaFicha(p, world, extra);
  const genetics = genome ? `<details class="person-detail" data-detail="genome"><summary>Herencia y genealogía <span class="detail-badge">G${esc(genome.generation)}</span></summary><p>Parámetros heredados y fijados al nacer. No cambian durante esta vida; no describen una biografía real.</p><div class="gene-chips"><span>Generación <strong>${esc(genome.generation)}</strong></span><span>Mutaciones <strong>${esc(genome.mutations)}</strong></span></div>${familia.progenitores ? `<div class="lineage"><h4>Progenitores</h4>${familia.progenitores}</div><div class="lineage"><h4>Descendencia</h4>${familia.descendencia}</div>` : `<div class="lineage"><h4>Progenitores</h4>${parentMarkup}</div><div class="lineage"><h4>Descendencia en esta vista</h4>${descendants.length ? descendants.map(child=>`<button class="lineage-person" data-parent="${esc(child.id)}">${esc(child.name)} · G${esc(child.genome?.generation ?? 'sin dato')} ${icon.arrow}</button>`).join('') : '<span class="lineage-absent">No hay descendientes en esta vista.</span>'}${!enCinta && extra === null ? '<p class="drawer-note" data-loading="family">Cargando su familia en todo el mundo…</p>' : ''}</div>`}<div class="skill-row"><span>Ritmo de aprendizaje</span><strong>${number(genome.learningRate, 2)}</strong></div>${meter('Cooperación heredada', genome.cooperation)}${edadFicha(p, extra)}<p>El ritmo heredado regula cuánto aprende de sus experiencias; no garantiza una conducta.</p></details>` : '';
  const learned = skills.length || p.traits ? `<details class="person-detail" data-detail="skills"><summary>Habilidades y carácter</summary>${skills.map(([name, value]) => `<div class="skill-row"><span>${esc(skillNames[name] ?? name)}</span><strong>${percentage(value)}</strong></div>`).join('')}${p.traits ? `<div class="trait-list">${Object.entries(p.traits).map(([name, value]) => `<span>${esc(traitNames[name] ?? name)} <strong>${percentage(value)}</strong></span>`).join('')}</div>` : ''}<p>Las habilidades cambian con la práctica y la experiencia. Los rasgos heredados orientan sus preferencias.</p></details>` : '';
  const community = world?.communities?.find(group => group.id === p.communityId);
  const ejePropio = ejeDominante(p.culture), ejeComunidad = community ? ejeDominante(community.culture) : null;
  const culturaLineas = `${ejePropio ? `<p data-culture-dominant>Su eje más alto en esta vista: <strong>${esc(ejePropio.etiqueta)} (${esc(percentage(ejePropio.valor!))})</strong>. ${esc(ejePropio.lectura)}</p>` : ''}${ejeComunidad && community ? `<p>El eje más alto de ${esc(community.name)} es ${esc(ejeComunidad.etiqueta.toLocaleLowerCase('es'))} (${esc(percentage(ejeComunidad.valor!))}), como promedio de sus miembros vivos.</p>` : ''}`;
  const social = p.culture || p.trust?.length || community ? `<details class="person-detail" data-detail="community"><summary>Cultura y vínculos</summary><div class="person-community"><small>COMUNIDAD ACTUAL</small>${community ? `<button class="entity-link" data-community="${esc(community.id)}">${esc(community.name)} ${icon.arrow}</button>` : '<strong>Sin comunidad</strong> <small>(pertenecer a una es opcional)</small>'}</div>${p.culture ? ejesCultura(p.culture).map(eje => eje.valor === null ? '' : meter(eje.etiqueta, eje.valor)).join('') || '<p>Cultura sin dato en esta vista.</p>' : '<p>Cultura sin dato en esta vista.</p>'}${culturaLineas}<p>Costumbres aprendidas en las interacciones. Pertenecer a otro grupo no implica hostilidad.</p>${p.trust === undefined ? (enCinta ? '' : '<p class="drawer-note" data-loading="trust">Cargando sus vínculos…</p>') : p.trust.length ? `<h4 class="detail-subtitle">Confianza registrada</h4><div class="trust-list">${[...p.trust].sort((a, b) => b.value - a.value).slice(0, 6).map(t => `<span><button class="entity-link" data-parent="${esc(t.id)}">${esc(nombreConocido(t.id, world) ?? 'Alguien')}${world!.people.some(other=>other.id===t.id) ? '' : ' · fuera de esta vista'}</button><strong>${number(t.value, 2)}</strong></span>`).join('')}</div><p>Valores del modelo, no una medida de afecto real.</p>` : '<p>Todavía no hay vínculos de confianza registrados.</p>'}</details>` : '';
  const experiences = `<details class="person-detail" data-detail="experiences"><summary>Últimas experiencias${p.experiences === undefined ? '' : ` <span class="detail-badge">${Math.min(8, p.experiences.length)}</span>`}</summary><p>Registro reciente de esta vida simulada. Conserva el momento y el episodio que lo originó.</p>${p.experiences === undefined ? (enCinta ? '<p class="drawer-note" data-experiences="no-grabado">Las experiencias individuales requieren un registro que las incluya.</p>' : '<p class="drawer-note" data-loading="experiences">Cargando sus últimas experiencias…</p>') : p.experiences.length ? `<ol class="experience-list">${p.experiences.slice(-8).reverse().map(experience => { const cause = buscarEpisodio(experience.causeId); return `<li><span class="experience-tick">${esc(momento(experience.tick).toLocaleUpperCase('es'))}</span><p>${esc(textoDeExperiencia(experience.text, cause, world))}</p><small><strong>Qué influyó:</strong> ${esc(cause ? enClaro(cause.cause, { world }) : 'El episodio que lo causó no está entre los que recibió este navegador.')}</small></li>`; }).join('')}</ol>` : '<p>Aún no hay experiencias registradas.</p>'}</details>`;
  const technology = world?.technology;
  const knowledge = recipeIds ?? technology?.knowledge?.find(entry => entry.actorId === p.id)?.recipeIds;
  const avisoRepertorio = enCinta
    ? '<p class="drawer-note" data-procedures="no-grabado">Este fotograma no grabó el repertorio del catálogo legado. No se cuenta como cero.</p>'
    : '<p class="drawer-note" data-loading="procedures">Cargando su repertorio…</p>';
  const remembered = `<details class="person-detail" data-detail="procedures"><summary>Procedimientos que recuerda${knowledge ? ` <span class="detail-badge">${knowledge.length}</span>` : ''}</summary>
    ${!knowledge ? avisoRepertorio : knowledge.length
      ? `${extra?.inventadas ? `<p class="drawer-note" data-invented>Inventó ${number(extra.inventadas)} ${extra.inventadas === 1 ? 'procedimiento' : 'procedimientos'} de los que el mundo conserva.</p>` : ''}${knowledge.slice(0,32).map(id => `<div class="skill-row procedure-row">${procedureReference(id, technology)}${origenProcedimiento(id, extra?.procedimientos, world)}</div>`).join('')}${knowledge.length > 32 ? `<p>Aquí se muestran 32 de los ${number(knowledge.length)} procedimientos que recuerda.</p>` : ''}`
      : '<p data-procedures="ninguno">No recuerda ningún procedimiento ahora.</p>'}
    <p>Este repertorio cambia al aprender y olvidar. Es distinto de los rasgos heredados y de la técnica sobre lotes. Recordar un procedimiento no asegura tener los materiales para realizarlo.</p></details>`;
  const products = technology?.items.filter(item=>item.ownerId===p.id) ?? [];
  const toolkit = products.length ? `<details class="person-detail" data-detail="products"><summary>Objetos que lleva <span class="detail-badge">${products.length}</span></summary>${products.slice(0,8).map(item => forgedToolMarkup(item, world)).join('')}${products.length > 8 ? `<p>Se muestran 8 de los ${number(products.length)} objetos que lleva.</p>` : ''}<p>La masa del material cambia al usarlo o transformarlo. El agua de su composición es distinta del agua potable transportada. Las unidades de material y de agua del entorno son diferentes. Llevar un objeto no implica recordar cómo se fabrica.</p></details>` : '';
  const progress = p.working && p.workProgress !== undefined ? `<div class="game-needs task-progress">${meter('Progreso de la tarea',p.workProgress)}</div>` : '';
  const reserve = p.foodReserve !== undefined ? `<div class="food-reserve"><div><span>${icon.bag} Reserva de alimento</span><strong>${number(p.foodReserve,2)}${p.foodReserveCapacity !== undefined ? ` / ${number(p.foodReserveCapacity,2)}` : ''} u.</strong></div>${p.foodReserveCapacity !== undefined && p.foodReserveCapacity > 0 ? `<meter aria-label="Alimento reservado" min="0" max="${esc(p.foodReserveCapacity)}" value="${esc(p.foodReserve)}"></meter>` : ''}<p>Unidades de alimento del mundo.</p></div>` : '';
  const lifeStage = p.lifeStage === 'juvenile' ? 'En crecimiento' : p.lifeStage === 'adult' ? 'Edad de crianza' : p.lifeStage === 'senescent' ? 'Vejez' : 'Sin dato';
  const body = `<details class="person-detail" data-detail="vitality"><summary>Salud y ciclo de vida</summary><div class="skill-row" data-person-life-stage><span>Etapa del modelo</span><strong>${lifeStage}</strong></div>${fertilidadFicha(enCinta ? extra ?? undefined : extra, world)}${numeroFinito(p.health)?meter('Salud',p.health):''}${numeroFinito(p.vitality)?meter('Vitalidad',p.vitality):''}<p>La etapa describe la edad del modelo; no garantiza una crianza. El alimento, el agua, el descanso y la exposición dejan consecuencias en el cuerpo.</p>${p.continuityProtected?'<p class="drawer-note">La continuidad de esta identidad está protegida por la configuración del mundo.</p>':''}</details>`;
  return { now: notaGrabacionResumida(p) + decisionFicha(p, world) + escuchaFicha(p, world) + cuerpoPersonaFicha(p, world) + vinculoSIFicha(p, world, eventosRecibidos) + reserve + progress + body, kit: toolkit + fichaTecnica(p.tecnicaVista) + remembered + learned, story: genetics + social + experiences };
}

/* ------------------------------------------------------------------ */
/* V23 — cuerpo de átomos, crianza, fauna y sustancias                 */
/* ------------------------------------------------------------------ */

const sinDatoV23 = '<em class="sin-dato">sin dato</em>';
const finitoV23 = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fraccion = (v: number): number => Math.max(0, Math.min(1, v));
/** Barra de 16 píxeles, como la de escucha: se lee de un vistazo y el HTML no cambia con el ruido de una lectura. */
const barraPixeles = (etiqueta: string, v: unknown, texto?: string): string => finitoV23(v)
  ? `<div class="cuerpo-fila"><span>${esc(etiqueta)}</span><span class="cuerpo-barra" style="--e:${Math.round(fraccion(v) * 16)}" role="meter" aria-label="${esc(etiqueta)}" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${fraccion(v).toFixed(2)}"></span><strong>${esc(texto ?? percentage(fraccion(v)))}</strong></div>`
  : `<div class="cuerpo-fila"><span>${esc(etiqueta)}</span>${sinDatoV23}</div>`;
const dato = (etiqueta: string, valor: string | null, clave: string): string =>
  `<div class="skill-row" data-cuerpo="${esc(clave)}"><span>${esc(etiqueta)}</span><strong>${valor === null ? sinDatoV23 : esc(valor)}</strong></div>`;
const kg = (v: unknown): string | null => finitoV23(v) ? `${number(v, v < 1 ? 3 : 2)} kg` : null;
const hex = (color: number): string => `#${(Math.max(0, Math.min(0xffffff, Math.floor(color))) >>> 0).toString(16).padStart(6, '0')}`;

/** Temperatura en kelvin con su equivalente en °C (el cuerpo vivo se lee mejor en grados). */
export function temperaturaTexto(T: unknown): string | null {
  return finitoV23(T) ? `${number(T, 1)} K · ${number(T - 273.15, 1)} °C` : null;
}

const SUBINDICES = '₀₁₂₃₄₅₆₇₈₉';
/** Fórmula por elementos en orden de Hill (C, H y luego alfabético; sin C, todo alfabético). Sin átomos: «—». */
export function formulaDe(atomos: readonly number[] | undefined): string {
  if (!atomos) return '—';
  const partes = ELEMENTOS.map((simbolo, i) => ({ simbolo, n: atomos[i] ?? 0 })).filter(e => finitoV23(e.n) && e.n > 0);
  if (!partes.length) return '—';
  const hill = partes.some(e => e.simbolo === 'C');
  const rango = (s: string): number => hill ? (s === 'C' ? 0 : s === 'H' ? 1 : 2) : 2;
  partes.sort((a, b) => rango(a.simbolo) - rango(b.simbolo) || a.simbolo.localeCompare(b.simbolo));
  return partes.map(e => e.simbolo + (e.n === 1 ? '' : String(Math.round(e.n)).split('').map(d => SUBINDICES[Number(d)] ?? d).join(''))).join('');
}

/** Nombre del tipo de enlace de `TIPOS`: «C–O», «C=O», «C≡N». */
export function nombreEnlace(tipo: number): string {
  const t = TIPOS[tipo];
  if (!t) return `enlace ${tipo}`;
  return `${ELEMENTOS[t.e]}${t.k === 1 ? '–' : t.k === 2 ? '=' : '≡'}${ELEMENTOS[t.f]}`;
}

/** Los `max` tipos de enlace de más cuenta de la sustancia (`enlaces` = pares [tipo, cuenta]). */
export function enlacesDominantes(s: Pick<SustanciaVista, 'enlaces'>, max = 3): { nombre: string; cuenta: number }[] {
  const pares: { nombre: string; cuenta: number }[] = [];
  for (let i = 0; i + 1 < s.enlaces.length; i += 2) {
    const tipo = s.enlaces[i], cuenta = s.enlaces[i + 1];
    if (finitoV23(tipo) && finitoV23(cuenta) && cuenta > 0) pares.push({ nombre: nombreEnlace(tipo), cuenta });
  }
  return pares.sort((a, b) => b.cuenta - a.cuenta || a.nombre.localeCompare(b.nombre)).slice(0, max);
}

/** Nombre derivado de la estructura, sin tabla de nombres: «red Si–O rígida», «molécula C–H flexible». */
export function nombreDerivado(s: SustanciaVista): string {
  const principales = enlacesDominantes(s, 2).map(e => e.nombre);
  const forma = s.clase === ClaseSustancia.Unidad ? 'red' : 'molécula';
  const { dureza, flexibilidad } = s.prop;
  const rasgo = finitoV23(dureza) && dureza >= .66 ? 'rígida' : finitoV23(flexibilidad) && flexibilidad >= .6 ? 'flexible' : finitoV23(dureza) && dureza <= .25 ? 'blanda' : '';
  return [forma, principales.join(' · '), rasgo].filter(Boolean).join(' ');
}

export type FaseSustancia = 'sólido' | 'líquido' | 'gas';
/** Fase a la temperatura T según sus puntos de fusión y ebullición. */
export function faseA(prop: Pick<Propiedades, 'tFusion' | 'tEbullicion'>, T: number): FaseSustancia {
  return T < prop.tFusion ? 'sólido' : T < prop.tEbullicion ? 'líquido' : 'gas';
}

export function sustanciaPorId(lista: SustanciasVisibles | undefined, id: number): SustanciaVista | undefined {
  return lista?.find(s => s.id === id);
}

/** Los 8 átomos de la sustancia como barra apilada de 16 píxeles repartidos por fracción atómica (método del resto mayor). */
export function barraAtomos(atomos: readonly number[]): string {
  const total = ELEMENTOS.reduce((a, _, i) => a + Math.max(0, atomos[i] ?? 0), 0);
  if (!(total > 0)) return '';
  const cuotas = ELEMENTOS.map((_, i) => Math.max(0, atomos[i] ?? 0) / total * 16);
  const pixeles = cuotas.map(Math.floor);
  let resto = 16 - pixeles.reduce((a, b) => a + b, 0);
  for (const i of cuotas.map((c, k) => k).sort((a, b) => (cuotas[b]! - pixeles[b]!) - (cuotas[a]! - pixeles[a]!))) { if (resto <= 0) break; pixeles[i]!++; resto--; }
  const trozos = pixeles.map((n, i) => n > 0 ? `<i style="flex:${n} 1 0;background:${COLOR_ELEMENTO[i]}" title="${esc(`${NOMBRE_ELEMENTO[i]} · ${number(atomos[i] ?? 0)} átomos`)}"></i>` : '').join('');
  return `<span class="atomos-barra" role="img" aria-label="${esc(ELEMENTOS.map((s, i) => `${s} ${number(atomos[i] ?? 0)}`).join(' · '))}">${trozos}</span>`;
}

/** Ficha de sustancia (SustanciaVista): fórmula, clase, fase a T, enlaces dominantes y propiedades. `undefined` = el servidor no la mandó. */
export function sustanciaFicha(s: SustanciaVista | undefined, id: number, T?: number): string {
  if (!s) return `<details class="person-detail sustancia-ficha" data-sustancia="${esc(id)}"><summary>Sustancia nº ${esc(id)}</summary><p class="drawer-note">${sinDatoV23}: el servidor no mandó su estructura en esta vista.</p></details>`;
  const p = s.prop;
  const fase = finitoV23(T) ? `${faseA(p, T)} a ${number(T, 0)} K` : null;
  const enlaces = enlacesDominantes(s).map(e => `${e.nombre} ×${number(e.cuenta)}`).join(' · ') || null;
  const medida = (v: unknown, unidad: string, dig = 1): string | null => finitoV23(v) ? `${number(v, dig)} ${unidad}` : null;
  const filas = [
    dato('Fórmula', formulaDe(s.atomos), 'formula'),
    dato('Clase', s.clase === ClaseSustancia.Unidad ? 'unidad de red' : 'molécula', 'clase'),
    dato('Fase', fase, 'fase'),
    dato('Enlaces dominantes', enlaces, 'enlaces'),
    dato('Masa molar', medida(s.masa, 'g/mol', 2), 'masa'),
    dato('Densidad', medida(p.densidad, 'kg/L', 2), 'densidad'),
    dato('Fusión', medida(p.tFusion, 'K', 0), 'fusion'),
    dato('Ebullición', medida(p.tEbullicion, 'K', 0), 'ebullicion'),
    dato('Calor al oxidarse', medida(p.qOxidacion, 'J/cuanto', 0), 'oxidacion'),
    dato('Energía media de enlace', medida(p.dMedia, 'J/cuanto', 0), 'enlace-medio'),
    dato('Coordinación media', medida(p.r, '', 2), 'coordinacion'),
  ].join('');
  const rasgos = [barraPixeles('Dureza', p.dureza), barraPixeles('Tenacidad', p.tenacidad), barraPixeles('Flexibilidad', p.flexibilidad), barraPixeles('Polaridad', p.polaridad)].join('');
  return `<details class="person-detail sustancia-ficha" data-sustancia="${esc(s.id)}"><summary>${finitoV23(p.color) ? `<i class="chem-swatch" style="background:${hex(p.color)}" aria-hidden="true"></i> ` : ''}${esc(formulaDe(s.atomos))} <small>${esc(nombreDerivado(s))}</small></summary>${barraAtomos(s.atomos)}${filas}<div class="cuerpo-rasgos">${rasgos}</div></details>`;
}

/** Cuenta en el catálogo recibido (`world.sustancias`) o dice que falta. */
function nombreCorto(lista: SustanciasVisibles | undefined, id: number): string {
  const s = sustanciaPorId(lista, id);
  return s ? formulaDe(s.atomos) : `sustancia nº ${id}`;
}

/** Ficha › Suelo: de qué está hecha la superficie de la casilla (hasta 3 sustancias) y la ficha de cada una. */
export function materiaTeselaFicha(tile: Pick<Tile, 'mat' | 'T'>, sustancias: SustanciasVisibles | undefined): string {
  if (!tile.mat?.length) return '';
  const total = tile.mat.reduce((a, [, f]) => a + (finitoV23(f) ? Math.max(0, f) : 0), 0);
  const filas = tile.mat.map(([id, f]) => {
    const s = sustanciaPorId(sustancias, id);
    const parte = total > 0 && finitoV23(f) ? f / total : null;
    return `<div class="cuerpo-fila" data-mat="${esc(id)}"><span>${s && finitoV23(s.prop.color) ? `<i class="chem-swatch" style="background:${hex(s.prop.color)}" aria-hidden="true"></i>` : ''}${esc(nombreCorto(sustancias, id))}</span>${parte === null ? sinDatoV23 : `<span class="cuerpo-barra" style="--e:${Math.round(parte * 16)}" aria-hidden="true"></span><strong>${esc(percentage(parte))}</strong>`}</div>`;
  }).join('');
  const T = tile.T;
  const fichas = tile.mat.map(([id]) => sustanciaFicha(sustanciaPorId(sustancias, id), id, T)).join('');
  return `<section class="materia-tesela" data-materia-tesela><h4 class="detail-subtitle">De qué está hecha</h4>${filas}${dato('Temperatura', temperaturaTexto(T), 'temperatura')}${fichas}</section>`;
}

/** Lotes con forma de una casilla (objeto, cadáver, pieza, fuego) tal como los manda la vista. */
export function lotesDeCelda(lotes: readonly LoteVisible[] | undefined, x: number, y: number): LoteVisible[] {
  return lotes?.filter(l => l.x === x && l.y === y) ?? [];
}
const ROL_LOTE: Record<LoteVisible['rol'], string> = { objeto: 'Objeto', cadaver: 'Cadáver', pieza: 'Pieza de obra', fuego: 'Fuego' };
/** Ficha de cada lote de la casilla: rol, masa, temperatura y la ficha de su sustancia principal. */
export function lotesFicha(lotes: readonly LoteVisible[] | undefined, sustancias: SustanciasVisibles | undefined, x: number, y: number): string {
  const aqui = lotesDeCelda(lotes, x, y);
  if (!aqui.length) return '';
  const cards = aqui.map(l => `<article class="lote-ficha" data-lote="${esc(l.rol)}"><strong>${esc(ROL_LOTE[l.rol] ?? l.rol)}</strong>${dato('Masa', kg(l.masa), 'masa')}${dato('Temperatura', temperaturaTexto(l.T), 'temperatura')}${dato('Forma', finitoV23(l.forma) ? (l.forma === 0 ? 'montón sin forma' : `forma ${number(l.forma)}`) : null, 'forma')}${sustanciaFicha(sustanciaPorId(sustancias, l.principal), l.principal, l.T)}</article>`).join('');
  return `<section class="lotes-casilla" data-lotes><h4 class="detail-subtitle">Lo que hay en el suelo</h4>${cards}</section>`;
}

function piezasObra(structure: StructureView, world: WorldView | null): string {
  if (structure.piezas === undefined) return '<p class="drawer-note" data-piezas="no-grabado">Las piezas físicas de esta obra no vinieron en esta vista.</p>';
  if (!structure.piezas.length) return '<p class="drawer-note" data-piezas="ninguna">Ninguna pieza física observada en esta obra en este paso.</p>';
  const filas = structure.piezas.map(l => {
    const s = sustanciaPorId(world?.sustancias, l.principal);
    const nombre = s ? `${formulaDe(s.atomos)} · ${nombreDerivado(s)}` : (finitoV23(l.principal) && l.principal > 0 ? `sustancia nº ${l.principal} (su estructura no vino en esta vista)` : 'sustancia no grabada');
    return `<li data-pieza="${esc(l.principal)}">${esc(nombre)} · ${esc(kg(l.masa) ?? 'masa no grabada')} · ${esc(temperaturaTexto(l.T) ?? 'temperatura no grabada')}</li>`;
  }).join('');
  return `<div data-structure-pieces><span>Piezas físicas · ${esc(structure.piezas.length)}</span><ul>${filas}</ul></div>`;
}

/**
 * Ficha › Cuerpo: masa, reserva, agua, digestivo, carga y temperatura.
 * Animal y la llamada directa conservan el contrato: el campo ausente dice «sin dato».
 * Persona (`persona`): sólo magnitudes registradas, cero real incluido; no se inventa un hueco.
 */
export function cuerpoFicha(c: CuerpoVisible | undefined, sustancias?: SustanciasVisibles, persona = false): string {
  if (!c) return '<section class="cuerpo-ficha" data-cuerpo-ficha="sin-dato"><h4 class="detail-subtitle">Cuerpo</h4><p class="drawer-note">Sin dato: este instante no trae el cuerpo. No es un cuerpo en cero.</p></section>';
  const adulta = finitoV23(c.masaAdulta) && c.masaAdulta > 0 && finitoV23(c.masa) ? c.masa / c.masaAdulta : null;
  const carga = finitoV23(c.carga) && finitoV23(c.masa) && c.masa > 0 ? c.carga / c.masa : null;
  const principal = finitoV23(c.principal) ? sustanciaPorId(sustancias, c.principal) : undefined;
  const embrion = c.embrion ? gestacionFicha(c.embrion) : '';
  const barra = (etiqueta: string, v: unknown, texto?: string): string => persona && !finitoV23(v) ? '' : barraPixeles(etiqueta, v, texto);
  const campo = (etiqueta: string, valor: string | null, clave: string, origen: unknown): string => persona && !finitoV23(origen) ? '' : dato(etiqueta, valor, clave);
  return `<section class="cuerpo-ficha" data-cuerpo-ficha="ok"><h4 class="detail-subtitle">Cuerpo</h4>`
    + campo('Masa', kg(c.masa), 'masa', c.masa) + (adulta === null ? '' : barraPixeles('Sobre su masa adulta', adulta, `${number(adulta * 100)} %`))
    + barra('Reserva de energía', c.reserva) + barra('Agua del tejido', c.agua)
    + campo('En el tubo digestivo', kg(c.digestivo), 'digestivo', c.digestivo) + campo('Carga a cuestas', kg(c.carga), 'carga', c.carga) + (carga === null ? '' : barraPixeles('Peso de la carga', carga))
    + campo('Temperatura', temperaturaTexto(c.T), 'temperatura', c.T)
    + (principal ? dato('Tejido principal', `${formulaDe(principal.atomos)} · ${nombreDerivado(principal)}`, 'principal') : '')
    + embrion + '</section>';
}

/** Gestación en curso: masa del embrión sobre la que tendrá al nacer y la pareja que aportó su genoma (uid). */
export function gestacionFicha(e: NonNullable<CuerpoVisible['embrion']>): string {
  const avance = finitoV23(e.masa) && finitoV23(e.m0) && e.m0 > 0 ? e.masa / e.m0 : null;
  return `<div class="gestacion-ficha" data-embrion><h4 class="detail-subtitle">Gestación</h4>${barraPixeles('Avance del embrión', avance, avance === null ? undefined : `${number(fraccion(avance) * 100)} %`)}${dato('Masa del embrión', kg(e.masa), 'embrion-masa')}${dato('Pesará al nacer', kg(e.m0), 'embrion-m0')}${dato('Genoma aportado por', finitoV23(e.otro) ? `el individuo nº ${number(e.otro)}` : null, 'embrion-otro')}</div>`;
}

/** Cría que aún depende de quienes la cuidan: quiénes son y cuánto le falta para su masa adulta. */
export function crianzaFicha(c: CrianzaVisible | undefined, world: WorldView): string {
  if (!c) return '';
  const cuidadores = Array.isArray(c.cuidadores) ? c.cuidadores : null;
  return `<section class="crianza-ficha" data-crianza><h4 class="detail-subtitle">Crianza</h4>${barraPixeles('Madurez', c.madurez, finitoV23(c.madurez) ? `${number(fraccion(c.madurez) * 100)} % de su masa adulta` : undefined)}<p class="drawer-note" data-cuidadores>${cuidadores === null ? sinDatoV23 : cuidadores.length ? `La cuidan: ${cuidadores.map(id => personLink(world, id)).join(' ')}` : 'Nadie la cuida ahora.'}</p></section>`;
}

/** Ficha de persona: cuerpo (sólo lo registrado) y, si es cría o está gestando, su crianza. */
export function cuerpoPersonaFicha(p: Pick<PersonView, 'cuerpoVisto' | 'crianza'>, world: WorldView): string {
  return (p.cuerpoVisto ? cuerpoFicha(p.cuerpoVisto, world.sustancias, true) : '') + crianzaFicha(p.crianza, world);
}

/** Qué se extrajo sin matar, en pasado y en claro. */
const EXTRAIDO: Record<'reserva' | 'fibra', string> = { reserva: 'ordeñado', fibra: 'esquilado' };
/** Ficha de animal: cuerpo, miedo, a quién persigue o de quién huye, habituación y última extracción. */
export function faunaFicha(a: Pick<AnimalView, 'cuerpoVisto' | 'v23' | 'habituation'>, world: WorldView): string {
  const f = a.v23;
  const cuerpo = a.cuerpoVisto ? cuerpoFicha(a.cuerpoVisto, world.sustancias) : '';
  if (!f) return cuerpo || '<p class="drawer-note" data-fauna-ficha="sin-dato">Esta vista conserva la actividad. El cuerpo y el detalle de conducta requieren un fotograma que los incluya.</p>';
  const animal = (uid: number): string => `el animal nº ${number(uid)}`;
  const extraido = f.extraido ? `${EXTRAIDO[f.extraido.que] ?? f.extraido.que} por el individuo nº ${number(f.extraido.por)} · ${momento(f.extraido.tick)}` : null;
  return cuerpo + `<section class="fauna-ficha" data-fauna-ficha="ok"><h4 class="detail-subtitle">Conducta</h4>`
    + barraPixeles('Miedo', f.miedo) + (finitoV23(a.habituation) ? barraPixeles('Habituación', a.habituation) : '')
    + dato('Persigue a', finitoV23(f.persigue) ? animal(f.persigue) : 'a nadie', 'persigue') + dato('Huye de', finitoV23(f.huyeDe) ? `el individuo nº ${number(f.huyeDe)}` : 'de nadie', 'huye')
    + dato('Linaje fundador', finitoV23(f.linaje) ? `nº ${number(f.linaje)}` : null, 'linaje')
    + dato('Última extracción', f.extraido ? extraido : 'ninguna registrada', 'extraido') + '</section>';
}
