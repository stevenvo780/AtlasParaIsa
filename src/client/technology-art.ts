import type { TechnologyView, TechnologyRecipe, TechnologyRecipeSummary } from '../shared/technology.js';
import type { OrganizationSummary } from '../shared/organization.js';
import type { WorldStats } from '../shared/types.js';
import { nombreProcedimiento, recursoEnClaro } from './textos.js';
import { nombreConocido } from './vistos.js';

const esc = (value: string | number): string => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const n = (value: number, digits = 1): string => value.toLocaleString('es-CO', {maximumFractionDigits:digits});
const operations: Record<string,string> = {combine:'Unir',separate:'Separar',form:'Dar forma',abrade:'Desgastar',heat:'Calentar',cool:'Enfriar',compress:'Comprimir',weave:'Entrelazar'};
const capacities: Record<string,string> = {cutting:'Cortar',storage:'Contener',insulation:'Aislar',cultivation:'Cultivar',binding:'Unir',abrasion:'Pulir'};
const sourceName: Record<string,string> = {wood:'madera',stone:'piedra',water:'agua',raw:'materia prima',product:'producto anterior',residue:'residuo'};
const shapes: Record<string,string> = {edge:'filo',hollow:'hueco',sheet:'lámina',rod:'vara',granular:'granos'};

/** Optional authoritative projection. Older views omit it; absence is not zero.
 * Geometry and leakage are calculated by the server, never by this renderer. */
interface ProjectedWater {
  version: 1; quanta: number; capacityQuanta: number; quantaPerUnit: 50000;
  leakageNumerator: number; leakageDenominator: 1000000;
}
function projectedWater(value: unknown): ProjectedWater | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const water = value as Partial<ProjectedWater>;
  // Only version 1 supplies these fixed format constants. Explicit null, wrong
  // units, unknown versions or missing quantities never become plausible zeros.
  const quantaPerUnit = water.quantaPerUnit === undefined ? 50000 : water.quantaPerUnit;
  const leakageDenominator = water.leakageDenominator === undefined ? 1000000 : water.leakageDenominator;
  if (water.version === 1 && quantaPerUnit === 50000 && leakageDenominator === 1000000
    && Number.isSafeInteger(water.quanta) && water.quanta! >= 0
    && Number.isSafeInteger(water.capacityQuanta) && water.capacityQuanta! >= water.quanta!
    && Number.isSafeInteger(water.leakageNumerator) && water.leakageNumerator! >= 0
    && water.leakageNumerator! <= leakageDenominator)
    return { version: 1, quanta: water.quanta!, capacityQuanta: water.capacityQuanta!, quantaPerUnit,
      leakageNumerator: water.leakageNumerator!, leakageDenominator };
  return;
}
export function carriedWaterCard(item: TechnologyView['items'][number]): string {
  const payload: unknown = (item as { water?: unknown }).water;
  if (payload === undefined) return '<p class="drawer-note" data-water-state="unavailable">Contenido de agua no recibido en esta vista.</p>';
  const water = projectedWater(payload);
  if (!water) return '<p class="drawer-note" data-water-state="unavailable">Datos de agua no disponibles en esta vista.</p>';
  if (!water.capacityQuanta) return '<p class="drawer-note" data-water-state="incapable">Este objeto no retiene agua transportada.</p>';
  const state = water.quanta === 0 ? 'empty' : water.quanta === water.capacityQuanta ? 'full' : 'partial';
  const label = state === 'empty' ? 'Vacío' : state === 'full' ? 'Lleno' : 'Con agua';
  const amount = n(water.quanta / water.quantaPerUnit, 5), capacity = n(water.capacityQuanta / water.quantaPerUnit, 5);
  const rate = n(100 * water.leakageNumerator / water.leakageDenominator, 4);
  return `<section class="food-reserve carried-water" data-water-item="${esc(item.id)}" data-water-state="${state}" aria-label="Agua transportada · ${label}">
    <p><strong>Agua transportada · ${label}</strong></p>
    <div><span>Contenido</span><strong>${amount} u. de agua</strong></div>
    <div><span>Capacidad actual</span><strong>${capacity} u. de agua</strong></div>
    <meter min="0" max="${water.capacityQuanta}" value="${water.quanta}" aria-label="Agua transportada: ${amount} de ${capacity} unidades">${amount} / ${capacity}</meter>
    <p>Fuga prevista: ${rate} % por paso.</p>
  </section>`;
}
/** The server names an unnamed procedure after its operations; only that pattern is translated. */
export function recipeLabel(recipe: TechnologyRecipeSummary): string {
  const serial=recipe.id.replace('recipe-',''), suffix=` ${serial}`;
  if(!recipe.name.endsWith(suffix)) return recipe.name;
  const program=recipe.name.slice(0,-suffix.length);
  return /^[a-z]+(·[a-z]+)*·?$/.test(program)
    ? `${program.split('·').map(op=>operations[op] ?? op).join(' · ')} ${serial}` : recipe.name;
}

/** M9: «Inventada por Duna el día 2»: autor y momento de la definición pedida (nunca se inventan). */
export function origenReceta(detail: Partial<Pick<TechnologyRecipe, 'inventorId' | 'tick'>>): string {
  // Una definición sin autor o sin paso (proyecciones antiguas) no se completa con suposiciones.
  if (typeof detail.inventorId !== 'string') return '';
  const autor = nombreConocido(detail.inventorId);
  const dia = typeof detail.tick === 'number' && Number.isFinite(detail.tick) ? ` el día ${n(Math.floor(detail.tick / 2400) + 1, 0)}` : '';
  return `Inventada ${autor ? `por ${autor}` : 'por un habitante que este navegador no ha visto'}${dia}.`;
}

/** A summary card states that the steps are absent from this snapshot; it never draws an empty program.
 * Only what cannot change is drawn from a requested detail: steps, inputs and lineage. `manufactured`,
 * `uses` and `utility` move every step and are frozen at the moment of the query, so a card asked for an
 * hour ago would present them as this tick's under a header that says «paso N». They are not drawn. */
export function recipeCard(recipe: TechnologyRecipe | TechnologyRecipeSummary, technology?: TechnologyView): string {
  const strongest = Object.entries(recipe.capacities).sort((a,b)=>b[1]-a[1]).slice(0,3);
  const detail = 'program' in recipe ? recipe : null;
  const inputs = detail?.program.inputs.map(input=>`${esc(n(input.mass/1000,2))} u. de ${esc(sourceName[input.material ?? input.source] ?? input.source)}`).join(' + ');
  const steps = detail?.program.steps.map(step=>`<li><span>${esc(operations[step.op] ?? step.op)}${step.shape ? ` · ${esc(shapes[step.shape] ?? step.shape)}` : ''}</span><small>Intensidad ${esc(n(step.intensity,0))}/4${step.requiredCatalyst ? ` · requiere ${esc(capacities[step.requiredCatalyst] ?? step.requiredCatalyst)}` : step.catalyst ? ` · ayuda: ${esc(capacities[step.catalyst] ?? step.catalyst)}` : ''}</small></li>`).join('');
  return `<details class="person-detail technology-recipe" data-detail="recipe-${esc(recipe.id)}"><summary>${esc(recipeLabel(recipe))} <span>G${recipe.generation}</span></summary>
    ${detail ? `<p class="technology-materials">${inputs}</p><ol class="process-steps">${steps}</ol>` : `<p class="stats-note">Los pasos de este procedimiento no viajan en cada actualización. <button class="entity-link" data-recipe="${esc(recipe.id)}">Pedir los pasos</button></p>`}
    <div class="technology-capacities">${strongest.map(([capacity,value])=>`<span>${esc(capacities[capacity] ?? capacity)}<meter aria-label="${esc(capacities[capacity] ?? capacity)}" min="0" max="1" value="${Math.max(0,Math.min(1,value))}"></meter></span>`).join('')}</div>
    ${detail ? `<small data-recipe-origin>${esc(origenReceta(detail))} ${detail.parents.length ? `Procede de ${detail.parents.map(id => esc(nombreProcedimiento(id, { technology }))).join(', ')}.` : 'Primer procedimiento de esta línea.'}</small>` : ''}</details>`;
}

/** M9: la etiqueta de un nodo en dos líneas de hasta `max` caracteres, cortando SOLO entre operaciones
 * («·») y nunca a media palabra. Si no cabe, la segunda línea termina en «… N» con el número del
 * procedimiento, que lo identifica (el nombre entero va en el <title> del nodo). */
export function etiquetaEnDosLineas(texto: string, max = 24): string[] {
  // Se corta entre operaciones («·»); un nombre sin operaciones se corta entre palabras.
  const sep = texto.includes(' · ') ? ' · ' : ' ', partes = texto.split(sep);
  const llenar = (items: string[], reserva = 0): [string, string[]] => {
    let linea = '', i = 0;
    for (; i < items.length; i++) { const junto = linea ? `${linea}${sep}${items[i]}` : items[i]!; if (junto.length + reserva > max && linea) break; linea = junto; }
    return [linea, items.slice(i)];
  };
  const [primera, resto] = llenar(partes);
  if (!resto.length) return [primera];
  const [segunda, sobra] = llenar(resto);
  if (!sobra.length) return [primera, segunda];
  const serial = /\s(\d+)$/.exec(texto)?.[1], cola = serial ? `… ${serial}` : '…';
  let linea = '';
  for (const item of resto) { const junto = linea ? `${linea}${sep}${item}` : item; if (`${junto} ${cola}`.length > max) break; linea = junto; }
  return [primera, linea ? `${linea} ${cola}` : cola];
}

function organizationGraph(analysis: OrganizationSummary, technology: TechnologyView): string {
  const processes = [...analysis.processes].sort((a,b)=>b.executions-a.executions).slice(0,12);
  if (!processes.length) return '<p class="stats-empty">Aún no hay procesos registrados para conectar.</p>';
  const positions = new Map(processes.map((process,i)=>[process.id,{x:i%2 ? 205 : 75,y:35+Math.floor(i/2)*62}]));
  const edges = analysis.observedDependencies.filter(edge=>positions.has(edge.producerId)&&positions.has(edge.consumerId)).slice(0,36);
  const name = (id: string): string => {
    const base=id.split('#')[0]!, recipeId=base.replace(/^(use|recycle):/,'');
    const recipe=technology.recipes.find(recipe=>recipe.id===recipeId);
    const verbo = base.startsWith('use:')?'Usar · ':base.startsWith('recycle:')?'Reciclar · ':'';
    // M9: nunca «Proceso N»: el nombre del procedimiento, su número si no está en esta vista, o lo que se sabe.
    return recipe ? `${verbo}${recipeLabel(recipe)}` : /^recipe-\d+$/.test(recipeId) ? `${verbo}${nombreProcedimiento(recipeId, { technology })}` : 'Procedimiento fuera de esta vista';
  };
  const height = Math.ceil(processes.length/2)*62+12;
  return `<figure class="organization-network"><figcaption>Cómo se conectan los oficios</figcaption><svg viewBox="0 0 280 ${height}" role="img" aria-label="${processes.length} procesos; ${edges.length} dependencias con producción y consumo observados"><defs><marker id="process-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L6 3L0 6" fill="#81996a"/></marker></defs>${edges.map(edge=>{const a=positions.get(edge.producerId)!,b=positions.get(edge.consumerId)!;return `<path class="process-edge ${edge.kind==='catalyst'?'is-catalyst':''}" d="M${a.x} ${a.y+10}Q140 ${(a.y+b.y)/2+20} ${b.x} ${b.y-11}" marker-end="url(#process-arrow)"><title>${esc(name(edge.producerId))} → ${esc(name(edge.consumerId))}: ${esc(recursoEnClaro(edge.resourceId, { technology }))}</title></path>`;}).join('')}${processes.map(process=>{const point=positions.get(process.id)!;return `<g class="process-node ${process.maintained?'is-maintained':''}"><rect x="${point.x-64}" y="${point.y-23}" width="128" height="47" rx="7"/>${etiquetaEnDosLineas(name(process.id)).map((linea,i,todas)=>`<text x="${point.x}" y="${point.y-(todas.length===2?9:3)+i*11}" text-anchor="middle">${esc(linea)}</text>`).join('')}<text class="process-flux" x="${point.x}" y="${point.y+17}" text-anchor="middle">${n(process.executions,0)} ${process.executions === 1 ? 'ejecución' : 'ejecuciones'}</text><title>${esc(name(process.id))}. ${process.maintained?'Recursos repuestos en la ventana.':process.blockers.map(esc).join(', ') || 'Sin reposición comprobada.'}</title></g>`;}).join('')}</svg><p class="stats-note">Las flechas muestran intercambios observados; el trazo discontinuo indica uso de una herramienta.${analysis.processes.length>12?' Vista de los 12 procesos con más actividad.':''}</p></figure>`;
}

/** `details` holds the programs already asked for; a summary is drawn where none arrived. */
export function technologyPane(technology?: TechnologyView, organization?: OrganizationSummary, details?: ReadonlyMap<string, TechnologyRecipe | null>, stats?: WorldStats): string {
  if (!technology) return '<p class="stats-empty">Todavía no se recibieron los materiales y procedimientos de este mundo.</p>';
  const d = technology.dynamics;
  const card = (recipe: TechnologyRecipeSummary): string => recipeCard(details?.get(recipe.id) ?? recipe, technology);
  const fact = (label:string,value:string,note:string):string=>`<article class="stat-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
  const notebook = `<section class="stats-section"><div class="stats-section-heading"><h3>Cuaderno de procedimientos</h3><span>${n(technology.recipes.length,0)} en esta vista</span></div>
    <p class="stats-note">El total de descubrimientos pertenece al mundo. Cada habitante conserva su propio repertorio.${technology.recipes.length < d.recipes ? ' Esta lista no muestra todo lo descubierto.' : ''}</p>
    ${technology.recipes.length ? technology.recipes.slice(-20).reverse().map(card).join('') : `<p class="stats-empty">${d.recipes > 0 ? 'Hay procedimientos descubiertos, pero sus detalles no están en esta vista.' : 'Todavía no hay una receta descubierta. Investigar requiere materiales, tiempo y energía.'}</p>`}
    ${technology.recipes.length > 20 ? '<p class="stats-note">Se muestran 20 procedimientos de esta vista.</p>' : ''}</section>`;
  return `<div class="technology-intro"><p class="eyebrow">MATERIA QUE CAMBIA DE MANOS</p><h3>Aprender a hacer</h3><p>Los habitantes prueban operaciones, conservan los procedimientos útiles y usan sus productos en trabajos posteriores.</p></div><div class="stats-grid">${fact('Descubiertos',n(d.recipes,0),'Procedimientos en todo el mundo')}${fact('Productos',n(d.products,0),'Objetos que existen ahora')}${fact('Usos',n(d.toolUses,0),'Aplicaciones con desgaste')}${fact('Generaciones',n(d.generations,0),'Profundidad de las recetas')}</div><section class="stats-section" data-transmission><div class="stats-section-heading"><h3>La técnica se transmite</h3><span>Acumulado del mundo</span></div><div class="stats-grid">${fact('Recetas enseñadas',Number.isFinite(d.shared) ? n(d.shared,0) : '—','Pasadas a otra persona por enseñanza cercana')}${fact('Productos reutilizados',Number.isFinite(d.reusedProducts) ? n(d.reusedProducts,0) : '—','Usados como materia de otro procedimiento (historial reciente)')}${stats?.diversidad ? fact('Diversidad de oficios',`${n(stats.diversidad.oficios*100,0)} %`,`Habituación: cada quien tiende a lo que practica${stats.statsTick !== undefined ? ` · medido en el paso ${n(stats.statsTick,0)}` : ''}`) : ''}</div></section><section class="stats-section"><div class="stats-section-heading"><h3>La materia se conserva</h3><span>Unidades del modelo</span></div><div class="stats-facts"><span>Entrada acumulada<strong>${n(d.importedMass/1000,2)}</strong></span><span>En productos<strong>${n(d.productMass/1000,2)}</strong></span><span>En residuos<strong>${n(d.residueMass/1000,2)}</strong></span><span>Diferencia del balance<strong>${n(d.massError/1000,3)}</strong></span></div><p class="stats-note">${n(d.attempts,0)} intentos, ${n(d.failures,0)} fallidos. Los intentos también consumen trabajo y energía.</p></section>${organization ? `${organizationGraph(organization,technology)}<section class="stats-section"><div class="stats-section-heading"><h3>Qué logra sostenerse</h3><span>Pasos ${organization.window.startTick}–${organization.window.endTick}</span></div><div class="stats-grid">${fact('Oficios activos',n(organization.diversity.activeProcesses,0),'Actividad registrada en la ventana')}${fact('Ciclos mantenidos',n(organization.maintainedComponents.length,0),'Reposición comprobada en esta ventana')}${fact('Reposición de herramientas',organization.maintenance.catalystReplacementCoverage === null?'Sin demanda':`${n(organization.maintenance.catalystReplacementCoverage*100,0)}%`,'Producción interna frente al desgaste')}${fact('Balance observado',organization.evidence.balanced?'Consistente':'Sin verificar',`${n(organization.evidence.successful,0)} ejecuciones conformes`)}</div><p class="stats-note">${organization.window.complete?'Ventana completa.':'Historial parcial: faltan episodios de la ventana.'} Un ciclo dibujado no demuestra que el sistema se mantenga por sí solo. No se modela una frontera autónoma ni se ha establecido autopoiesis.</p>${organization.maintenance.depletedResources.length?`<p class="technology-blocker">Reservas que disminuyen: ${organization.maintenance.depletedResources.map(id => esc(recursoEnClaro(id, { technology }))).join(', ')}.</p>`:''}</section>`:''}${notebook}`;
}
