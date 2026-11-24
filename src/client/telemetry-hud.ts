/** Read-only telemetry over the received projection. No DOM, timers or simulation state. */
import type { AnimalView, CommunityView, PersonView, StructureView, WorldStats, WorldView } from '../shared/types.js';
import { esc, number, percentage } from './ui-catalog.js';
import { censoDe } from './censo-view.js';

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
  return [
    { nav: 'people', label: 'Población · linaje', value: `${number(census?.total ?? stats?.population)} · ${generation === undefined ? '—' : `G${number(generation)}`}`,
      detail: census ? `${number(census.neighbors)} vecinos · ${number(census.identities)} S/I · J/A/M: ${number(census.lifeStage.juvenile)}/${number(census.lifeStage.adult)}/${number(census.lifeStage.senescent)} · sin etapa: ${number(census.lifeStage.unknown)}. Mundo › Vidas.` : 'Censo no recibido. Abrir Vidas.' },
    { nav: 'life', label: 'Faena / descanso', value: `${percentage(activity.working)} / ${percentage(activity.resting)}`,
      detail: `Actividad viva · faena ${percentage(activity.working)} · descanso ${percentage(activity.resting)} · diversidad de conducta ${percentage(stats?.diversidad?.conducta)}. Abrir Mundo › Vida.` },
    { nav: 'communities', label: 'Sociedad · coop/desac', value: `${number(community.total)} · ${number(community.cooperation)}/${number(community.disputes)}`,
      detail: `${number(community.total)} comunidades · ${number(community.cooperation)} cooperaciones · ${number(community.disputes)} desacuerdos · apertura media ${percentage(community.cultures.find(c => c.axis === 'openness')?.mean)}. Abrir Mundo › Comunidades.` },
    { nav: 'animals', label: 'Fauna · depred.', value: `${number(wildlife)} · ${number(predators)} dep.`, detail: `Regiones activas: ${number(wildlife)} animales · ${number(predators)} depredadores (zorros y lobos). Abrir Vidas › Fauna.` },
    { nav: 'land', label: 'Cultivos · planos', value: `${number(stats?.cultivatedTiles)} · ${number(stats?.blueprints)}`,
      detail: `${number(stats?.cultivatedTiles)} cultivos en regiones activas · ${number(stats?.blueprints)} planos conocidos · ${number(world?.structures?.length)} obras en esta vista. Abrir Mundo › Paisaje.` },
    { nav: 'technology', label: 'Oficios · recetas', value: `${number(recipes)} · ${number(world?.technology?.items.length)} obj.`,
      detail: `${number(recipes)} recetas registradas · ${number(world?.technology?.items.length)} objetos proyectados · ${number(stats?.blueprints)} planos. Abrir Mundo › Técnica.` },
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

/** V19 fields can arrive before shared projection typings are upgraded. Absent is unknown. */
export type StructureTelemetry = StructureView & {
  storedFood?: number; storedWood?: number; storedStone?: number;
  site?: { progress?: number; requiredWork?: number } | boolean | null;
  installed?: readonly unknown[];
  footprint?: readonly { x: number; y: number }[];
};
export function structureRollup(structures?: readonly StructureTelemetry[]) {
  const values = structures ?? [];
  const optionalSum = (key: 'storedWood' | 'storedStone') => values.some(s => finite(s[key])) ? sum(values.map(s => s[key] ?? 0)) : undefined;
  return { total: structures?.length, food: structures ? sum(values.map(s => s.storedFood ?? s.food)) : undefined,
    wood: optionalSum('storedWood'), stone: optionalSum('storedStone'),
    sites: values.some(s => s.site !== undefined) ? values.filter(s => s.site && (typeof s.site === 'boolean' || (s.site.progress ?? 0) < (s.site.requiredWork ?? 1))).length : undefined,
    installed: values.some(s => s.installed !== undefined) ? sum(values.map(s => s.installed?.length ?? 0)) : undefined,
    multiTile: values.some(s => s.footprint !== undefined) ? values.filter(s => (s.footprint?.length ?? 0) > 1).length : undefined,
    footprintTiles: values.some(s => s.footprint !== undefined) ? sum(values.map(s => s.footprint?.length ?? 1)) : undefined };
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
  ])) + section('Habilidades y cultura personal', `${skills.length ? facts(skills.map(([key, value]) => [skillLabels[key] ?? key, percentage(value)])) : '<p class="stats-note">Sin habilidades practicadas recibidas.</p>'}${facts(Object.entries(axes).map(([key, label]) => [label, percentage(p.culture?.[key as keyof typeof axes])]))}`);
}
export function renderAnimalTelemetry(animal: AnimalView & { reproductiveReserve?: number }): string {
  return section('Genética y estado', facts([
    ['Velocidad', number(animal.genes.speed, 2)], ['Percepción', number(animal.genes.perception, 2)], ['Metabolismo', number(animal.genes.metabolism, 2)],
    ['Carnivoría', number(animal.genes.carnivory, 2)], ['Agua · eficiencia', number(animal.genes.waterEfficiency, 2)], ['Camuflaje', number(animal.genes.camouflage, 2)],
    ['Edad', `${number(animal.age)} pasos`], ['Generación', `G${number(animal.generation)}`], ['Progenitores', animal.parents.length ? animal.parents.join(' · ') : 'Primera generación registrada'],
    ...(animal.reproductiveReserve === undefined ? [] : [['Reserva reproductiva', number(animal.reproductiveReserve, 2)] as [string, string]]),
  ]));
}
export function renderTileTelemetry(tile: WorldView['tiles'][number]): string {
  return facts([['Estado del cultivo', cropLabels[cropStage(tile.cultivation)]], ['Crecimiento', percentage(tile.growth)]]);
}
