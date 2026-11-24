/** Read-only telemetry over the received projection. No DOM, timers or simulation state. */
import type { AnimalView, CommunityView, PersonView, StructureView, WorldStats, WorldView } from '../shared/types.js';
import { esc, number, percentage } from './ui-catalog.js';
import { censoDe } from './censo-view.js';
import { ELEMENTS, geologyAt, type ChemOperator, type ChemistrySummaryView, type CompoundLot, type ElementSymbol, type ElementVector, type ThermalPhase } from '../shared/chemistry.js';

export type HudNav = 'people' | 'life' | 'communities' | 'animals' | 'land' | 'technology' | 'performance';
export type PulseHealth = 'unknown' | 'healthy' | 'warn' | 'hot';
export interface TelemetryKpi { nav: HudNav; label: string; value: string; detail: string; health?: PulseHealth; }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: number | undefined): number => finite(value) ? Math.max(0, value) : 0;
const sum = (values: number[]): number => values.reduce((total, value) => total + count(value), 0);
const workActions = new Set(['farm', 'build', 'gather', 'forage', 'hunt', 'craft', 'research', 'invent', 'repair', 'cooperate', 'share']);
const movingActions = new Set(['move', 'explore', 'approach', 'accompany', 'retreat']);

/** Fractions of ALL reported actions; an empty distribution has no measured percentages. */
export function activitySplit(actions?: Record<string, number>) {
  let working = 0, resting = 0, moving = 0, survival = 0, other = 0;
  for (const [action, raw] of Object.entries(actions ?? {})) {
    const n = count(raw);
    if (workActions.has(action)) working += n;
    else if (action === 'rest') resting += n;
    else if (movingActions.has(action)) moving += n;
    else if (action === 'eat' || action === 'drink') survival += n;
    else other += n;
  }
  const total = working + resting + moving + survival + other;
  const fraction = (n: number) => total ? n / total : undefined;
  return { total, working: fraction(working), resting: fraction(resting), moving: fraction(moving), survival: fraction(survival), other: fraction(other) };
}

export type CropStage = 'unplowed' | 'plowed' | 'sprout' | 'growing' | 'ripe';
export const cropLabels: Record<CropStage, string> = { unplowed: 'Sin arar', plowed: 'Arado', sprout: 'Brote', growing: 'En crecimiento', ripe: 'Cosecha madura' };
export function cropStage(cultivation = 0): CropStage {
  if (!finite(cultivation) || cultivation <= 0) return 'unplowed';
  return cultivation < .25 ? 'plowed' : cultivation < .5 ? 'sprout' : cultivation < .75 ? 'growing' : 'ripe';
}
export function cropCounts(tiles: WorldView['tiles']): Record<CropStage, number> {
  const stages: Record<CropStage, number> = { unplowed: 0, plowed: 0, sprout: 0, growing: 0, ripe: 0 };
  for (const tile of tiles) stages[cropStage(tile.cultivation)]++;
  return stages;
}
export function viewportCensus(world: WorldView) {
  return { people: world.people.length, animals: world.animals?.length, structures: world.structures?.length,
    crops: world.tiles.filter(tile => finite(tile.cultivation) && tile.cultivation > 0).length };
}
export function viewportCensusText(world: WorldView): string {
  const c = viewportCensus(world);
  return `En vista: ${number(c.people)} hab · ${number(c.animals)} fauna · ${number(c.structures)} obras · ${number(c.crops)} cultivos`;
}

const axes = { sharing: 'Compartir', stewardship: 'Cuidado', openness: 'Apertura' } as const;
export function communitySummary(communities?: CommunityView[]) {
  const values = communities ?? [];
  const cultures = Object.keys(axes).map(key => {
    const axis = key as keyof typeof axes;
    const samples = values.map(c => c.culture[axis]).filter(finite);
    return { axis, label: axes[axis], mean: samples.length ? sum(samples) / samples.length : undefined,
      min: samples.length ? samples.reduce((min, value) => Math.min(min, value), Infinity) : undefined, max: samples.length ? samples.reduce((max, value) => Math.max(max, value), -Infinity) : undefined };
  });
  return { total: communities?.length, cooperation: communities ? sum(values.map(c => c.cooperation)) : undefined,
    disputes: communities ? sum(values.map(c => c.disputes)) : undefined, cultures };
}
export function pulseHealth(performance?: WorldView['performance']): PulseHealth {
  const p95 = performance?.p95StepMs, budget = performance?.gobernador?.presupuestoMs;
  if (!finite(p95) || p95 < 0 || !finite(budget) || budget <= 0) return 'unknown';
  return p95 / budget > 1 ? 'hot' : p95 / budget >= .7 ? 'warn' : 'healthy';
}

export function telemetryKpis(world: WorldView | null): TelemetryKpi[] {
  const stats = world?.stats, census = world ? censoDe(world) : null;
  const generations = Object.entries(stats?.generations ?? {}).filter(([g, n]) => finite(Number(g)) && n > 0).map(([g]) => Number(g));
  const generation = generations.length ? generations.reduce((max, value) => Math.max(max, value), 0) : undefined;
  const activity = activitySplit(stats?.actions), community = communitySummary(world?.communities);
  const wildlife = stats?.wildlife ? sum(Object.values(stats.wildlife)) : undefined;
  const predators = stats?.wildlife ? count(stats.wildlife.fox) + count(stats.wildlife.wolf) : undefined;
  const recipes = world?.technology?.dynamics.recipes;
  const runtime = world?.performance;
  const herds = habituatedFauna(world?.animals), forged = forgedToolsCount(world?.technology?.items);
  return [
    { nav: 'people', label: 'Población · linaje', value: `${number(census?.total ?? stats?.population)} · ${generation === undefined ? '—' : `G${number(generation)}`}`,
      detail: census ? `${number(census.neighbors)} vecinos · ${number(census.identities)} S/I · J/A/M: ${number(census.lifeStage.juvenile)}/${number(census.lifeStage.adult)}/${number(census.lifeStage.senescent)} · sin etapa: ${number(census.lifeStage.unknown)}. Mundo › Vidas.` : 'Censo no recibido. Abrir Vidas.' },
    { nav: 'life', label: 'Faena / descanso', value: `${percentage(activity.working)} / ${percentage(activity.resting)}`,
      detail: `Actividad viva · faena ${percentage(activity.working)} · descanso ${percentage(activity.resting)} · diversidad de conducta ${percentage(stats?.diversidad?.conducta)}. Abrir Mundo › Vida.` },
    { nav: 'communities', label: 'Sociedad · coop/desac', value: `${number(community.total)} · ${number(community.cooperation)}/${number(community.disputes)}`,
      detail: `${number(community.total)} comunidades · ${number(community.cooperation)} cooperaciones · ${number(community.disputes)} desacuerdos · apertura media ${percentage(community.cultures.find(c => c.axis === 'openness')?.mean)}. Abrir Mundo › Comunidades.` },
    { nav: 'animals', label: 'Fauna · depred.', value: `${number(wildlife)} · ${number(predators)} dep.${herds.known ? ` · ${herds.tame} mans. / ${herds.calming} hab.` : ''}`, detail: `Regiones activas: ${number(wildlife)} animales · ${number(predators)} depredadores (zorros y lobos). En vista: ${herds.known ? `${herds.tame} mansos y ${herds.calming} habituándose (individuos recibidos)` : 'habituación no recibida'}. Abrir Vidas › Fauna.` },
    { nav: 'land', label: 'Cultivos · planos', value: `${number(stats?.cultivatedTiles)} · ${number(stats?.blueprints)}${count(stats?.pavedTiles) > 0 ? ` · ${number(stats?.pavedTiles)} calz.` : ''}`,
      detail: `${number(stats?.cultivatedTiles)} cultivos en regiones activas · ${number(stats?.blueprints)} planos conocidos · ${number(world?.structures?.length)} obras en esta vista${stats?.pavedTiles !== undefined ? ` · ${number(stats.pavedTiles)} calzadas empedradas` : ''}${stats?.polyominoStructures !== undefined ? ` · ${number(stats.polyominoStructures)} edificios poliominó` : ''}. Abrir Mundo › Paisaje.` },
    { nav: 'technology', label: 'Oficios · recetas', value: `${number(recipes)} · ${number(world?.technology?.items.length)} obj.${forged === undefined ? '' : ` · ${forged} forj.`}${count(stats?.chemicalFormulas) > 0 ? ` · ${number(stats?.chemicalFormulas)} fórm.` : ''}`,
      detail: `${number(recipes)} recetas registradas · ${number(world?.technology?.items.length)} objetos proyectados · ${number(forged)} herramientas químicas forjadas en vista · ${number(stats?.blueprints)} planos${stats?.chemicalFormulas !== undefined ? ` · ${number(stats.chemicalFormulas)} fórmulas químicas emergentes` : ''}. Abrir Mundo › Técnica.` },
    { nav: 'performance', label: 'Motor · p95 / Hz', value: `${number(runtime?.p95StepMs, 1)} ms · ${number(runtime?.tickHz, 1)} Hz`, health: pulseHealth(runtime),
      detail: `Paso p95 ${number(runtime?.p95StepMs, 2)} ms / presupuesto ${number(runtime?.gobernador?.presupuestoMs)} ms · ${number(runtime?.tickHz, 2)} Hz · ${pulseHealth(runtime) === 'hot' ? 'Presupuesto superado' : pulseHealth(runtime) === 'warn' ? 'Cerca del presupuesto' : pulseHealth(runtime) === 'healthy' ? 'Con margen' : 'Sin presupuesto medido'}. Abrir Mundo › Rendimiento.` },
  ];
}
export function renderTelemetry(world: WorldView | null): string {
  return telemetryKpis(world).map(kpi => `<button type="button" class="hud-kpi" data-hud-nav="${kpi.nav}" data-health="${kpi.health ?? 'unknown'}" title="${esc(kpi.detail)}" aria-label="${esc(`${kpi.label}: ${kpi.value}. ${kpi.detail}`)}"><span>${esc(kpi.label)}</span><strong data-hud-value>${esc(kpi.value)}</strong></button>`).join('');
}

function facts(entries: [string, string][]): string {
  return `<div class="telemetry-facts">${entries.map(([label, value]) => `<span>${esc(label)}<strong>${esc(value)}</strong></span>`).join('')}</div>`;
}
function section(title: string, body: string, scope?: string): string {
  return `<section class="stats-section telemetry-section"><h3 class="section-title">${esc(title)}</h3>${scope ? `<p class="stats-note">${esc(scope)}</p>` : ''}${body}</section>`;
}
export function renderLifeTelemetry(stats: WorldStats): string {
  const a = activitySplit(stats.actions);
  return section('Actividad vs descanso', facts([
    ['Faena', percentage(a.working)], ['Descanso', percentage(a.resting)], ['Movimiento / exploración', percentage(a.moving)],
    ['Supervivencia · comer / beber', percentage(a.survival)], ...(a.other ? [['Otras acciones', percentage(a.other)] as [string, string]] : []),
  ]), 'Distribución actual de todas las acciones del mundo; faena incluye cooperación y compartir.')
    + section('Diversidad y acceso a recursos', facts([
      ['Diversidad de conducta', percentage(stats.diversidad?.conducta)], ['Diversidad de oficios', percentage(stats.diversidad?.oficios)],
      ['Diversidad total', percentage(stats.diversidad?.total)], ['Desigualdad regional de recursos · Gini', number(stats.giniRecursosPorRegion, 3)],
      ['Terreno con alimento', percentage(stats.fraccionCeldasConComida)], ['Distancia media al agua potable', stats.distanciaMediaAgua === -1 ? 'Sin fuente potable' : `${number(stats.distanciaMediaAgua, 1)} celdas`],
      ['Regiones secas', percentage(stats.regionesSinAgua)],
    ]), `Diversidad: población viva. Recursos: regiones activas. Medición: ${stats.statsTick === undefined ? 'paso no informado' : `paso ${number(stats.statsTick)}`}.`);
}

/** V19 fields can arrive as {width,height} or cell arrays; absent is unknown. */
export type StructureTelemetry = Omit<StructureView, 'footprint' | 'site' | 'installed'> & {
  storedFood?: number; storedWood?: number; storedStone?: number;
  site?: StructureView['site'] | { progress?: number; requiredWork?: number; completedWork?: number } | boolean | null;
  installed?: readonly unknown[];
  footprint?: { width: number; height: number } | readonly { x: number; y: number }[];
};
function footprintArea(fp: StructureTelemetry['footprint']): number {
  if (!fp) return 1;
  if ('width' in fp) return Math.max(1, (fp.width || 1) * (fp.height || 1));
  return fp.length || 1;
}
function isSitePending(site: StructureTelemetry['site']): boolean {
  if (!site) return false;
  if (typeof site === 'boolean') return site;
  if ('completedWork' in site && typeof site.completedWork === 'number') {
    const reqWork = site.requiredWork ?? 1;
    const reqWood = 'requiredWood' in site ? site.requiredWood : 0, depWood = 'depositedWood' in site ? site.depositedWood : reqWood;
    const reqStone = 'requiredStone' in site ? site.requiredStone : 0, depStone = 'depositedStone' in site ? site.depositedStone : reqStone;
    return site.completedWork < reqWork || depWood < reqWood || depStone < reqStone;
  }
  return ('progress' in site ? (site.progress ?? 0) : 0) < (site.requiredWork ?? 1);
}
export function structureRollup(structures?: readonly StructureTelemetry[]) {
  const values = structures ?? [];
  const optionalSum = (key: 'storedWood' | 'storedStone') => values.some(s => finite(s[key])) ? sum(values.map(s => s[key] ?? 0)) : undefined;
  return { total: structures?.length, food: structures ? sum(values.map(s => s.storedFood ?? s.food)) : undefined,
    wood: optionalSum('storedWood'), stone: optionalSum('storedStone'),
    sites: values.some(s => s.site !== undefined) ? values.filter(s => isSitePending(s.site)).length : undefined,
    installed: values.some(s => s.installed !== undefined) ? sum(values.map(s => s.installed?.length ?? 0)) : undefined,
    multiTile: values.some(s => s.footprint !== undefined) ? values.filter(s => footprintArea(s.footprint) > 1).length : undefined,
    footprintTiles: values.some(s => s.footprint !== undefined) ? sum(values.map(s => footprintArea(s.footprint))) : undefined };
}
export function renderLandTelemetry(world: WorldView): string {
  const stages = cropCounts(world.tiles);
  const s = structureRollup(world.structures), wildlife = world.stats?.wildlife, dynamics = world.stats?.animalDynamics;
  const speciesLabels: Record<string, string> = { hare: 'Liebres', deer: 'Venados', boar: 'Jabalíes', fish: 'Peces', fox: 'Zorros', wolf: 'Lobos' };
  const predators = wildlife ? count(wildlife.fox) + count(wildlife.wolf) : undefined;
  const total = wildlife ? sum(Object.values(wildlife)) : undefined;
  const ratio = (n: number | undefined) => dynamics && dynamics.deaths > 0 && n !== undefined ? percentage(n / dynamics.deaths) : '—';
  return section('Cultivos por estado en esta vista', facts(Object.entries(stages).map(([key, value]) => [cropLabels[key as CropStage], number(value)])), 'Casillas recibidas de esta cámara; los cultivos se clasifican por su avance.')
    + section('Almacenes y obras en esta vista', facts([
      ['Obras', number(s.total)], ['Alimento almacenado', number(s.food, 2)], ['Madera almacenada', number(s.wood, 2)], ['Piedra almacenada', number(s.stone, 2)],
      ['Obras sin terminar', number(s.sites)], ['Tecnología instalada', number(s.installed)], ['Obras de varias casillas', number(s.multiTile)], ['Casillas de huella', number(s.footprintTiles)],
    ]), 'Existencias del modelo. — indica un campo aún no proyectado; no significa cero.')
    + renderRoadsAndChemistryRollup(world)
    + section('Fauna por especie y depredadores', facts([
      ['Herbívoros y otros no depredadores', number(total === undefined || predators === undefined ? undefined : total - predators)], ['Carnívoros · zorros y lobos', number(predators)],
      ...Object.entries(wildlife ?? {}).map(([key, value]): [string, string] => [speciesLabels[key] ?? key, number(value)]),
      ['Nacimientos / muertes', dynamics && dynamics.deaths > 0 ? number(dynamics.births / dynamics.deaths, 2) : '—'],
      ['Depredación / muertes', ratio(dynamics?.predations)], ['Caza humana / muertes', ratio(dynamics?.humanHunts)],
    ]), 'Censo de regiones activas. Ratios acumulados de fauna; sin muertes el cociente no está definido.');
}
export function renderCommunityTelemetry(communities?: CommunityView[]): string {
  const c = communitySummary(communities);
  return section('Sociedad y divergencia cultural', facts([
    ['Comunidades', number(c.total)], ['Cooperaciones', number(c.cooperation)], ['Desacuerdos', number(c.disputes)],
    ...c.cultures.map(axis => [axis.label, `${percentage(axis.mean)} · ${percentage(axis.min)}–${percentage(axis.max)}`] as [string, string]),
  ]), 'Todas las comunidades. Cultura: media por comunidad · mínimo–máximo; no ponderada por población.');
}

export function renderPersonTelemetry(p: PersonView): string {
  const stage = p.lifeStage ? { juvenile: 'Joven', adult: 'Adulto', senescent: 'Mayor' }[p.lifeStage] : '—';
  const progress = p.working || count(p.workProgress) > 0 ? `<div class="telemetry-work"><span>Trabajo en curso <strong>${percentage(p.workProgress)}</strong></span><meter aria-label="Progreso de la tarea" min="0" max="100" value="${esc(Math.round(Math.min(1, count(p.workProgress)) * 100))}"></meter></div>` : '';
  const skillLabels: Record<string, string> = { gather: 'Recolección', gathering: 'Recolección', forage: 'Cosecha', farm: 'Cultivo', farming: 'Cultivo', build: 'Construcción', building: 'Construcción', explore: 'Exploración', exploration: 'Exploración', care: 'Cuidado', cooperate: 'Cooperación', hunt: 'Caza', drink: 'Agua', research: 'Investigación', share: 'Compartir', craft: 'Fabricación', technology: 'Técnica', invent: 'Invención', repair: 'Reparación', eat: 'Alimentarse', rest: 'Descanso', approach: 'Acercarse', accompany: 'Compañía', retreat: 'Buscar espacio' };
  const skills = Object.entries(p.skills ?? {}).filter(([, value]) => finite(value) && value > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  return progress + section('Estado vital y etapa', facts([
    ['Salud', percentage(p.health)], ['Vitalidad', percentage(p.vitality)], ['Etapa', stage], ['Edad', `${number(p.age)} pasos`],
    ['Gen', p.genome ? `G${number(p.genome.generation)}` : '—'], ['Reserva', `${number(p.foodReserve, 2)} / ${number(p.foodReserveCapacity, 2)}`],
    ['Madera', number(p.materials?.wood)], ['Piedra', number(p.materials?.stone)],
  ])) + (p.craftFocus || p.craftTint ? section('Oficio emergente', `${swatch(p.craftTint)}<strong>${esc(p.craftFocus ?? 'Práctica material')}</strong>`) : '') + personCompoundsSection(p) + section('Habilidades y cultura personal', `${skills.length ? facts(skills.map(([key, value]) => [skillLabels[key] ?? key, percentage(value)])) : '<p class="stats-note">Sin habilidades practicadas recibidas.</p>'}${facts(Object.entries(axes).map(([key, label]) => [label, percentage(p.culture?.[key as keyof typeof axes])]))}`);
}
export function renderAnimalTelemetry(animal: AnimalView & { reproductiveReserve?: number }): string {
  const reserve = animal.reproReserve ?? animal.reproductiveReserve;
  return section('Genética y estado', facts([
    ['Velocidad', number(animal.genes.speed, 2)], ['Percepción', number(animal.genes.perception, 2)], ['Metabolismo', number(animal.genes.metabolism, 2)],
    ['Carnivoría', number(animal.genes.carnivory, 2)], ['Agua · eficiencia', number(animal.genes.waterEfficiency, 2)], ['Camuflaje', number(animal.genes.camouflage, 2)],
    ['Edad', `${number(animal.age)} pasos`], ['Generación', `G${number(animal.generation)}`], ['Progenitores', animal.parents.length ? animal.parents.join(' · ') : 'Primera generación registrada'],
    ...(reserve === undefined ? [] : [['Reserva reproductiva', number(reserve, 3)] as [string, string]]),
  ])) + (animal.morphology ? section('Morfología evolutiva', facts([
    ['Cautela', percentage(animal.morphology.caution)], ['Tamaño', percentage(animal.morphology.size)],
    ['Pelaje', percentage(animal.morphology.coat)], ['Defensa', percentage(animal.morphology.defense)],
  ])) : '') + section('Habituación / Mansedumbre',
    facts([['Estado', finite(animal.habituation) ? animal.habituation >= .75 ? 'Manso · aprovechable sin caza' : animal.habituation >= .45 ? 'Habituándose' : 'Salvaje' : 'Sin dato'], ['Cuidados', number(animal.tends)]])
    + (finite(animal.habituation) ? `<meter aria-label="Habituación / Mansedumbre" min="0" max="1" value="${Math.max(0, Math.min(1, animal.habituation))}">${esc(percentage(animal.habituation))}</meter>` : ''), 'Habituación aprendida en vida; la morfología es heredable.');
}
export function renderTileTelemetry(tile: WorldView['tiles'][number], seed?: number): string {
  return facts([['Estado del cultivo', cropLabels[cropStage(tile.cultivation)]], ['Crecimiento', percentage(tile.growth)]]) + roadSection(tile) + geologySection(tile, seed);
}

/* ------------------------------------------------------------------ */
/* V20 — caminos, geología, compuestos y química emergente             */
/* ------------------------------------------------------------------ */

export const phaseLabels: Record<ThermalPhase, string> = { raw: 'crudo', ground: 'molido', washed: 'lavado', fired: 'cocido', smelted: 'fundido', vitrified: 'vítreo' };
export const operatorLabels: Record<ChemOperator, string> = { grind: 'moler', wash: 'lavar', heat: 'calentar', bind: 'unir' };
export const elementNames: Record<ElementSymbol, string> = { C: 'Carbono', Si: 'Silicio', Ca: 'Calcio', Fe: 'Hierro', S: 'Azufre', H: 'Hidrógeno' };
/** Color propio de cada elemento en barras e insignias (carbón, pizarra, cal, óxido, azufre, agua). */
export const elementColors: Record<ElementSymbol, string> = { C: '#4a4743', Si: '#8d9bab', Ca: '#e1dccb', Fe: '#b5532e', S: '#e0cf5a', H: '#5fb2d6' };
const safeColor = (hex: string | undefined, fallback = '#a29484'): string => typeof hex === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex) ? hex : fallback;
const pct = (v: number | undefined): string => percentage(finite(v) ? Math.max(0, Math.min(1, v)) : undefined);

export function swatch(color: string | undefined): string { return `<i class="chem-swatch" style="background:${esc(safeColor(color))}" aria-hidden="true"></i>`; }

/** Ocupación local: la senda necesita `traffic ≥ 0,25` y la calzada `paved ≥ 0,5` (mismos umbrales que el dibujo del mapa). */
export type RoadState = 'none' | 'trail' | 'paved';
export function roadState(tile: { traffic?: number; paved?: number; terrain?: string }): RoadState {
  if (tile.terrain === 'water') return 'none';
  if (count(tile.paved) >= .5) return 'paved';
  return count(tile.traffic) >= .25 ? 'trail' : 'none';
}
/** Alivio de esfuerzo al pisar la casilla. Refleja `roadEffortFactor` del servidor V20: 1 − min(0,55; tráfico·0,45 + empedrado·0,15). */
export function roadEffortRelief(tile: { traffic?: number; paved?: number }): number {
  return Math.min(.55, Math.max(0, Math.min(1, count(tile.traffic))) * .45 + Math.max(0, Math.min(1, count(tile.paved))) * .15);
}
const roadLabels: Record<RoadState, string> = { none: 'Sin sendero', trail: 'Sendero pisado', paved: 'Calzada empedrada' };
export function roadSection(tile: { traffic?: number; paved?: number; terrain?: string }): string {
  const state = roadState(tile), relief = roadEffortRelief(tile);
  return `<div class="telemetry-facts" data-tile-road="${state}"><span>Camino<strong>${esc(roadLabels[state])}</strong></span><span>Alivio de esfuerzo<strong>${esc(percentage(relief))}</strong></span>${tile.paved !== undefined ? `<span>Empedrado<strong>${esc(percentage(tile.paved))}</strong></span>` : ''}${tile.traffic !== undefined ? `<span>Huellas de paso<strong>${esc(number(tile.traffic, 2))}</strong></span>` : ''}</div>`;
}

/** Insignias compactas de cada elemento; la veta que aflora en el mapa (Fe ≥ 24 %, Ca ≥ 28 %, S ≥ 22 %) se marca. */
export function elementBadges(vector: ElementVector): string {
  const veins: Partial<Record<ElementSymbol, number>> = { Fe: .24, Ca: .28, S: .22 };
  return `<div class="element-badges">${ELEMENTS.map(e => `<span class="element-badge${vector[e] >= (veins[e] ?? 2) ? ' is-vein' : ''}" data-element="${e}" title="${esc(elementNames[e])}"><i style="background:${elementColors[e]}" aria-hidden="true"></i>${e} <strong>${esc(pct(vector[e]))}</strong></span>`).join('')}</div>`;
}
/** Barra apilada de los 6 elementos (cada tramo proporcional a su fracción). */
export function elementBar(vector: ElementVector): string {
  const total = ELEMENTS.reduce((sum, e) => sum + count(vector[e]), 0) || 1;
  const label = ELEMENTS.map(e => `${e} ${pct(vector[e] / total)}`).join(' · ');
  return `<div class="element-bar" role="img" aria-label="${esc(label)}" title="${esc(label)}">${ELEMENTS.map(e => `<span data-element="${e}" style="flex:${(count(vector[e]) / total).toFixed(4)} 1 0;background:${elementColors[e]}"></span>`).join('')}</div>`;
}

export function geologySection(tile: WorldView['tiles'][number], seed: number | undefined): string {
  if (seed === undefined || !finite(seed) || tile.terrain === 'water') return '';
  const geo = geologyAt(seed, tile.x, tile.y, tile.biome, tile.feature);
  return `<div class="tile-geology" data-tile-geology><h4 class="detail-subtitle">Geología local</h4>${elementBadges(geo)}<p class="stats-note">Composición latente del suelo, derivada de la semilla del mundo; no cambia sola.</p></div>`;
}

/** Lotes con muestra de color, fase, masa y sus propiedades principales. */
export function compoundLotsMarkup(lots: readonly CompoundLot[], attribute: string): string {
  if (!lots.length) return '';
  const attr = /^data-[a-z0-9-]+$/.test(attribute) ? attribute : 'data-compounds';
  return `<ul class="compound-lots" ${attr}>${lots.map(lot => `<li data-compound="${esc(lot.id)}">${swatch(lot.properties?.colorHex)}<span class="compound-name">${esc(lot.formulaId)}</span><span class="detail-badge">${esc(phaseLabels[lot.phase] ?? lot.phase)}</span><strong>${esc(number(lot.mass, 2))} u.</strong><small>dureza ${esc(pct(lot.properties?.hardness))} · sellado ${esc(pct(lot.properties?.seal))} · combustible ${esc(pct(lot.properties?.fuelPower))}</small>${materialPropertiesMarkup(lot.properties)}</li>`).join('')}</ul>`;
}
function personCompoundsSection(p: PersonView): string {
  return p.compounds?.length ? section('Compuestos que lleva', compoundLotsMarkup(p.compounds, 'data-person-compounds'), 'Lotes químicos que carga ahora: color, fase y masa.') : '';
}

/** V20 en Mundo › Paisaje: calzadas, edificios poliominó, sinergias y compuestos en las bodegas visibles. */
export function renderRoadsAndChemistryRollup(world: WorldView): string {
  const stats = world.stats, structures = world.structures ?? [];
  const stored = structures.flatMap(s => s.storedCompounds ?? []);
  const polyHere = structures.filter(s => (s.cells?.length ?? 0) > 1).length, linksHere = structures.reduce((n, s) => n + count(s.synergy?.sharedEdges), 0);
  const trails = world.tiles.filter(t => roadState(t) === 'trail').length, paved = world.tiles.filter(t => roadState(t) === 'paved').length;
  return section('Caminos, edificios y química', facts([
    ['Calzadas empedradas', number(stats?.pavedTiles)], ['Edificios poliominó', number(stats?.polyominoStructures)], ['Enlaces de sinergia', number(stats?.synergyLinks)],
    ['Fórmulas descubiertas', number(stats?.chemicalFormulas ?? world.chemistry?.totalFormulas)],
    ['Compuestos en bodegas de esta vista', `${number(stored.length)} lotes · ${number(stored.reduce((n, l) => n + count(l.mass), 0), 2)} u.`],
    ['Sendas y calzadas en vista', `${number(trails)} · ${number(paved)}`], ['Poliominós en vista', number(polyHere)], ['Muros compartidos en vista', number(linksHere)],
  ]), 'Las cifras globales cuentan regiones activas; las de «en vista» solo lo que llegó a esta cámara. — indica un campo aún no proyectado.');
}

/** Mundo › Oficios: química emergente (fórmulas halladas, lotes activos, temperatura máxima y operadores). */
export function renderChemistryTelemetry(chemistry: ChemistrySummaryView | undefined): string {
  if (!chemistry) return '';
  const tiers = ['T0 · sin fuego', 'T1 · fuego abierto', 'T2 · horno'];
  const summary = facts([
    ['Fórmulas', number(chemistry.totalFormulas)], ['Lotes activos', number(chemistry.totalLots)], ['Temperatura máx.', tiers[chemistry.maxTemperatureTier] ?? `T${chemistry.maxTemperatureTier}`],
    ...(Object.keys(operatorLabels) as ChemOperator[]).map((op): [string, string] => [`Operador · ${operatorLabels[op]}`, number(chemistry.byOperator?.[op])]),
  ]);
  const cards = chemistry.formulas.slice(0, 12).map(f => `<article class="chem-card" data-formula="${esc(f.id)}">
    <header>${swatch(f.properties.colorHex)}<strong>${esc(f.name)}</strong><span class="detail-badge">${esc(phaseLabels[f.phase] ?? f.phase)}</span><span class="detail-badge">T${esc(f.temperatureTier)}</span><span class="detail-badge">${esc(operatorLabels[f.operator] ?? f.operator)}</span></header>
    ${elementBar(f.composition)}
    ${materialPropertiesMarkup(f.properties)}
    <small>Usos ${esc(number(f.uses))} · descubierta en el paso ${esc(number(f.discoveredAt))}</small></article>`).join('');
  return `<section class="stats-section telemetry-section" data-chemistry><h3 class="section-title">Química emergente</h3><p class="stats-note">Seis elementos conservados (C, Si, Ca, Fe, S, H) y cuatro operadores físicos; cada fórmula nace de lo que alguien hizo.</p>${summary}${cards ? `<div class="chem-cards">${cards}</div>` : '<p class="stats-note">Todavía nadie ha descubierto una fórmula.</p>'}${chemistry.formulas.length < chemistry.totalFormulas ? `<p class="stats-note">Se muestran ${number(Math.min(12, chemistry.formulas.length))} de ${number(chemistry.totalFormulas)} fórmulas.</p>` : ''}</section>`;
}


const materialProperties = [['Dureza', 'hardness'], ['Tenacidad', 'toughness'], ['Sellado', 'seal'], ['Aislamiento', 'insulation'], ['Combustible', 'fuelPower'], ['Fertilidad', 'fertility'], ['Ligereza', 'lightness']] as const;
/** Seven received chemical properties; absent legacy values stay unknown. */
export function materialPropertiesMarkup(properties: Partial<CompoundLot['properties']> | undefined): string {
  return `<div class="chem-props">${materialProperties.map(([label, key]) => {
    const raw = properties?.[key], v = finite(raw) ? Math.max(0, Math.min(1, raw)) : undefined;
    return `<span>${label}${v === undefined ? '' : `<meter aria-label="${label}" min="0" max="1" value="${v}"></meter>`}<small>${esc(percentage(v))}</small></span>`;
  }).join('')}</div>`;
}
export function habituatedFauna(animals?: readonly AnimalView[]) {
  const alive = (animals ?? []).filter(a => a.health > 0);
  return { known: alive.some(a => finite(a.habituation)), tame: alive.filter(a => (a.habituation ?? 0) >= .75).length,
    calming: alive.filter(a => (a.habituation ?? 0) >= .45 && (a.habituation ?? 0) < .75).length };
}
export function forgedToolsCount(items?: NonNullable<WorldView['technology']>['items']): number | undefined {
  return items?.filter(item => item.mass > 0 && !!item.chemFormulaId && !!item.chemPhase && item.chemPhase !== 'raw' && item.chemPhase !== 'ground' && item.chemPhase !== 'washed' && Object.values(item.capacities).some(v => v > .08)).length;
}
