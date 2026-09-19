import type { TechnologyView, TechnologyRecipe, TechnologyRecipeSummary } from '../shared/technology.js';
import type { OrganizationAnalysis } from '../shared/organization.js';

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
function projectedWater(value: unknown): value is ProjectedWater {
  if (!value || typeof value !== 'object') return false;
  const water = value as Partial<ProjectedWater>;
  return water.version === 1 && water.quantaPerUnit === 50000 && water.leakageDenominator === 1000000
    && Number.isSafeInteger(water.quanta) && water.quanta! >= 0
    && Number.isSafeInteger(water.capacityQuanta) && water.capacityQuanta! >= water.quanta!
    && Number.isSafeInteger(water.leakageNumerator) && water.leakageNumerator! >= 0
    && water.leakageNumerator! <= water.leakageDenominator;
}
export function carriedWaterCard(item: TechnologyView['items'][number]): string {
  const water: unknown = (item as { water?: unknown }).water;
  if (water === undefined) return '<p class="drawer-note" data-water-state="unavailable">Contenido de agua no recibido en esta vista.</p>';
  if (!projectedWater(water)) return '<p class="drawer-note" data-water-state="unavailable">Datos de agua no disponibles en esta vista.</p>';
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

/** A summary card states that the steps are absent from this snapshot; it never draws an empty program. */
export function recipeCard(recipe: TechnologyRecipe | TechnologyRecipeSummary): string {
  const strongest = Object.entries(recipe.capacities).sort((a,b)=>b[1]-a[1]).slice(0,3);
  const detail = 'program' in recipe ? recipe : null;
  const inputs = detail?.program.inputs.map(input=>`${esc(n(input.mass/1000,2))} u. de ${esc(sourceName[input.material ?? input.source] ?? input.source)}`).join(' + ');
  const steps = detail?.program.steps.map(step=>`<li><span>${esc(operations[step.op] ?? step.op)}${step.shape ? ` · ${esc(shapes[step.shape] ?? step.shape)}` : ''}</span><small>Intensidad ${esc(n(step.intensity,0))}/4${step.requiredCatalyst ? ` · requiere ${esc(capacities[step.requiredCatalyst] ?? step.requiredCatalyst)}` : step.catalyst ? ` · ayuda: ${esc(capacities[step.catalyst] ?? step.catalyst)}` : ''}</small></li>`).join('');
  return `<details class="person-detail technology-recipe" data-detail="recipe-${esc(recipe.id)}"><summary>${esc(recipeLabel(recipe))} <span>G${recipe.generation}</span></summary>
    ${detail ? `<p class="technology-materials">${inputs}</p><ol class="process-steps">${steps}</ol>` : `<p class="stats-note">Los pasos de este procedimiento no viajan en cada actualización. <button class="entity-link" data-recipe="${esc(recipe.id)}">Pedir los pasos</button></p>`}
    <div class="technology-capacities">${strongest.map(([capacity,value])=>`<span>${esc(capacities[capacity] ?? capacity)}<meter aria-label="${esc(capacities[capacity] ?? capacity)}" min="0" max="1" value="${Math.max(0,Math.min(1,value))}"></meter></span>`).join('')}</div>
    ${detail ? `<p>${n(detail.manufactured,0)} fabricados · ${n(detail.uses,0)} usos · utilidad observada ${n(detail.utility,2)}.</p><small>${detail.parents.length ? `Procede de ${detail.parents.map(esc).join(', ')}.` : 'Primer procedimiento de esta línea.'}</small>` : ''}</details>`;
}

function organizationGraph(analysis: OrganizationAnalysis, technology: TechnologyView): string {
  const processes = [...analysis.processes].sort((a,b)=>b.executions-a.executions).slice(0,12);
  if (!processes.length) return '<p class="stats-empty">Aún no hay procesos registrados para conectar.</p>';
  const positions = new Map(processes.map((process,i)=>[process.id,{x:i%2 ? 205 : 75,y:35+Math.floor(i/2)*62}]));
  const edges = analysis.observedDependencies.filter(edge=>positions.has(edge.producerId)&&positions.has(edge.consumerId)).slice(0,36);
  const name = (id: string): string => {
    const base=id.split('#')[0]!, recipeId=base.replace(/^(use|recycle):/,'');
    const recipe=technology.recipes.find(recipe=>recipe.id===recipeId);
    return recipe ? `${base.startsWith('use:')?'Usar · ':base.startsWith('recycle:')?'Reciclar · ':''}${recipeLabel(recipe)}` : `Proceso ${Math.max(0,processes.findIndex(process=>process.id===id))+1}`;
  };
  const height = Math.ceil(processes.length/2)*62+12;
  return `<figure class="organization-network"><figcaption>Cómo se conectan los oficios</figcaption><svg viewBox="0 0 280 ${height}" role="img" aria-label="${processes.length} procesos; ${edges.length} dependencias con producción y consumo observados"><defs><marker id="process-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L6 3L0 6" fill="#81996a"/></marker></defs>${edges.map(edge=>{const a=positions.get(edge.producerId)!,b=positions.get(edge.consumerId)!;return `<path class="process-edge ${edge.kind==='catalyst'?'is-catalyst':''}" d="M${a.x} ${a.y+10}Q140 ${(a.y+b.y)/2+20} ${b.x} ${b.y-11}" marker-end="url(#process-arrow)"><title>${esc(name(edge.producerId))} → ${esc(name(edge.consumerId))}: ${esc(edge.resourceId)}</title></path>`;}).join('')}${processes.map(process=>{const point=positions.get(process.id)!;return `<g class="process-node ${process.maintained?'is-maintained':''}"><rect x="${point.x-60}" y="${point.y-17}" width="120" height="35" rx="7"/><text x="${point.x}" y="${point.y-2}" text-anchor="middle">${esc(name(process.id).slice(0,18))}</text><text class="process-flux" x="${point.x}" y="${point.y+11}" text-anchor="middle">${n(process.executions,0)} ejecuciones</text><title>${esc(name(process.id))}. ${process.maintained?'Recursos repuestos en la ventana.':process.blockers.map(esc).join(', ') || 'Sin reposición comprobada.'}</title></g>`;}).join('')}</svg><p class="stats-note">Las flechas muestran intercambios observados; el trazo discontinuo indica uso de una herramienta.${analysis.processes.length>12?' Vista de los 12 procesos con más actividad.':''}</p></figure>`;
}

/** `details` holds the programs already asked for; a summary is drawn where none arrived. */
export function technologyPane(technology?: TechnologyView, organization?: OrganizationAnalysis, details?: ReadonlyMap<string, TechnologyRecipe | null>): string {
  if (!technology) return '<p class="stats-empty">Todavía no se recibieron los materiales y procedimientos de este mundo.</p>';
  const d = technology.dynamics;
  const card = (recipe: TechnologyRecipeSummary): string => recipeCard(details?.get(recipe.id) ?? recipe);
  const fact = (label:string,value:string,note:string):string=>`<article class="stat-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
  const notebook = `<section class="stats-section"><div class="stats-section-heading"><h3>Cuaderno de procedimientos</h3><span>${n(technology.recipes.length,0)} en esta vista</span></div>
    <p class="stats-note">El total de descubrimientos pertenece al mundo. Cada habitante conserva su propio repertorio.${technology.recipes.length < d.recipes ? ' Esta lista no muestra todo lo descubierto.' : ''}</p>
    ${technology.recipes.length ? technology.recipes.slice(-20).reverse().map(card).join('') : `<p class="stats-empty">${d.recipes > 0 ? 'Hay procedimientos descubiertos, pero sus detalles no están en esta vista.' : 'Todavía no hay una receta descubierta. Investigar requiere materiales, tiempo y energía.'}</p>`}
    ${technology.recipes.length > 20 ? '<p class="stats-note">Se muestran 20 procedimientos de esta vista.</p>' : ''}</section>`;
  return `<div class="technology-intro"><p class="eyebrow">MATERIA QUE CAMBIA DE MANOS</p><h3>Aprender a hacer</h3><p>Los habitantes prueban operaciones, conservan los procedimientos útiles y usan sus productos en trabajos posteriores.</p></div><div class="stats-grid">${fact('Descubiertos',n(d.recipes,0),'Procedimientos en todo el mundo')}${fact('Productos',n(d.products,0),'Objetos que existen ahora')}${fact('Usos',n(d.toolUses,0),'Aplicaciones con desgaste')}${fact('Generaciones',n(d.generations,0),'Profundidad de las recetas')}</div><section class="stats-section"><div class="stats-section-heading"><h3>La materia se conserva</h3><span>Unidades del modelo</span></div><div class="stats-facts"><span>Entrada acumulada<strong>${n(d.importedMass/1000,2)}</strong></span><span>En productos<strong>${n(d.productMass/1000,2)}</strong></span><span>En residuos<strong>${n(d.residueMass/1000,2)}</strong></span><span>Diferencia del balance<strong>${n(d.massError/1000,3)}</strong></span></div><p class="stats-note">${n(d.attempts,0)} intentos, ${n(d.failures,0)} fallidos. Los intentos también consumen trabajo y energía.</p></section>${organization ? `${organizationGraph(organization,technology)}<section class="stats-section"><div class="stats-section-heading"><h3>Qué logra sostenerse</h3><span>Pasos ${organization.window.startTick}–${organization.window.endTick}</span></div><div class="stats-grid">${fact('Oficios activos',n(organization.diversity.activeProcesses,0),'Actividad registrada en la ventana')}${fact('Ciclos mantenidos',n(organization.maintainedComponents.length,0),'Reposición comprobada en esta ventana')}${fact('Reposición de herramientas',organization.maintenance.catalystReplacementCoverage === null?'Sin demanda':`${n(organization.maintenance.catalystReplacementCoverage*100,0)}%`,'Producción interna frente al desgaste')}${fact('Balance observado',organization.evidence.balanced?'Consistente':'Sin verificar',`${n(organization.evidence.successful,0)} ejecuciones conformes`)}</div><p class="stats-note">${organization.window.complete?'Ventana completa.':'Historial parcial: faltan episodios de la ventana.'} Un ciclo dibujado no demuestra que el sistema se mantenga por sí solo. No se modela una frontera autónoma ni se ha establecido autopoiesis.</p>${organization.maintenance.depletedResources.length?`<p class="technology-blocker">Reservas que disminuyen: ${organization.maintenance.depletedResources.map(esc).join(', ')}.</p>`:''}</section>`:''}${notebook}`;
}
