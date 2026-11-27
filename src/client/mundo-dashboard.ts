/** Read-only deep statistics over received data; no simulation or DOM side effects. */
import type { Nivel } from '../shared/cinta.js';
import type { CommunityView, WorldView } from '../shared/types.js';
import type { WorldDirectoryResponse } from '../shared/worldmap.js';
import { ELEMENTS, type ThermalPhase } from '../shared/chemistry.js';
import { DEMOGRAPHY_TICKS_PER_DAY } from '../shared/demography.js';
import { esc, number, percentage } from './ui-catalog.js';

export type MundoTab = 'life' | 'land' | 'communities' | 'technology' | 'materia' | 'performance';

export interface MundoDeepSummary {
  livingCount: number;
  tameCount: number;
  totalTends: number;
  forgedTools: number;
  activeWhispers: number;
  heardWhispers: number;
  fulfilledWhispers: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const sum = (ns: readonly number[]): number => ns.reduce((a, b) => a + b, 0);
/** A missing measurement must not silently become a zero in the rendered UI. */
const measuredSum = (ns?: readonly (number | undefined)[]): number | undefined =>
  ns && ns.every(finite) ? sum(ns) : undefined;
const note = (s: string): string => `<p class="stats-note">${esc(s)}</p>`;
const section = (title: string, body: string, scope?: string): string =>
  `<section class="stats-section"><div class="stats-section-heading"><h3>${esc(title)}</h3></div>${body}${scope ? note(scope) : ''}</section>`;
type Fact = readonly [string, string];
const facts = (rows: readonly Fact[]): string => `<div class="stats-facts">${rows.map(([k, v]) =>
  `<span style="flex-wrap:wrap">${esc(k)}<strong style="white-space:normal;overflow-wrap:anywhere">${esc(v)}</strong></span>`).join('')}</div>`;
// Container-responsive even when the floating panel is resized without a viewport resize.
const grid = (body: string, columns = false): string => `<div class="${columns ? 'stats-two-columns' : 'stats-grid'}" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,max(160px,calc((100% - 36px)/4))),1fr));gap:12px">${body}</div>`;
const cards = (rows: readonly Fact[]): string => grid(rows.map(([k, v]) =>
  `<article class="stat-card"><span>${esc(k)}</span><strong>${esc(v)}</strong></article>`).join(''));
const swatch = (color?: string): string => `<i class="chem-swatch" style="background:${esc(typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#7a8c67')}" aria-hidden="true"></i>`;
const jump = (x: number, y: number, label = 'Ver lugar'): string => finite(x) && finite(y)
  ? `<button type="button" class="entity-link" data-place-x="${esc(x)}" data-place-y="${esc(y)}">${esc(label)}</button>` : '';
const bars = (rows: readonly (readonly [string, number | undefined])[], unit = '', digits = 2): string => {
  const valid = rows.filter((r): r is [string, number] => finite(r[1]) && r[1] >= 0);
  const max = valid.reduce((m, [, n]) => Math.max(m, n), 0);
  return `<div class="distribution">${rows.map(([label, value]) => {
    const width = finite(value) && value >= 0 ? max > 0 ? value / max * 100 : 0 : undefined;
    return `<div class="distribution-row"><div><span style="overflow-wrap:anywhere;min-width:0">${esc(label)}</span><strong>${esc(number(value, digits))}${unit ? `<small>${esc(unit)}</small>` : ''}</strong></div>${width === undefined ? '' : `<span class="distribution-track" aria-hidden="true"><i style="width:${width.toFixed(4)}%"></i></span>`}</div>`;
  }).join('')}</div>`;
};

/** Numeric summary counts received entities; absence yields 0 here, but stays unknown in UI. */
export function summarizeMundo(world: WorldView, directory?: WorldDirectoryResponse | null): MundoDeepSummary {
  const whispers = world.whispers ?? [];
  return {
    livingCount: world.stats?.population ?? directory?.people.length ?? world.people.length,
    tameCount: (world.animals ?? []).filter(a => finite(a.habituation) && a.habituation >= .45).length,
    totalTends: sum((world.animals ?? []).map(a => finite(a.tends) ? a.tends : 0)),
    forgedTools: (world.technology?.items ?? []).filter(i => !!i.materialTint).length,
    activeWhispers: whispers.filter(w => w.status === 'latent' || w.status === 'heard').length,
    heardWhispers: whispers.filter(w => w.status === 'heard').length,
    fulfilledWhispers: whispers.filter(w => w.status === 'fulfilled').length,
  };
}

function life(world: WorldView, directory: WorldDirectoryResponse | null | undefined, nivel: Nivel | null): string {
  const s = world.stats;
  if (!s && nivel !== null && nivel >= 2) {
    const cantidad = world.people.length;
    const habitantes = nivel === 2 ? ` En esta vista: ${number(cantidad)} ${cantidad === 1 ? 'habitante' : 'habitantes'}.` : '';
    return note(`Este nivel de la grabación omite el censo global y las estadísticas de vida.${habitantes}`);
  }
  const census = s?.census, summary = summarizeMundo(world, directory);
  const generationScope = s?.generations ? 'censo' : directory ? 'directorio' : 'en vista';
  const generations = s?.generations
    ? Object.entries(s.generations).filter(([, n]) => n > 0).map(([g]) => Number(g)).filter(finite)
    : directory ? directory.people.map(p => p.generation).filter(finite)
      : world.people.map(p => p.genome?.generation).filter(finite);
  const maxGeneration = generations.length ? generations.reduce((a, b) => Math.max(a, b)) : undefined;
  const populationScope = s?.population !== undefined ? 'Censo global.' : directory ? 'Directorio global recibido.' : 'Vivos: solo habitantes en vista; censo global no recibido.';
  const causes = new Map([['starvation', 'Falta de alimento'], ['dehydration', 'Falta de agua'], ['exposure', 'Exposición'], ['senescence', 'Vejez']]);
  const censusHtml = section('Censo y vitalidad global', cards([
    ['Vivos', number(summary.livingCount)], ['S/I protegidos', number(census?.protectedCount)], ['Vecinos', number(census?.neighbors)],
    ['Jóvenes', number(census?.lifeStage.juvenile)], ['Adultos', number(census?.lifeStage.adult)], ['Mayores', number(census?.lifeStage.senescent)],
    ['Sin etapa registrada', number(census?.lifeStage.unknown)], ['Nacimientos', number(s?.totals.births)], ['Muertes', number(world.demography?.deaths)],
    [`Generación más alta · ${generationScope}`, number(maxGeneration)], ['Diversidad · conducta', percentage(s?.diversidad?.conducta)],
    ['Diversidad · oficios', percentage(s?.diversidad?.oficios)], ['Diversidad · total', percentage(s?.diversidad?.total)],
    ['Energía media', percentage(s?.meanEnergy)], ['Hambre media', percentage(s?.meanHunger)], ['Sed media', percentage(s?.meanThirst)], ['Cansancio medio', percentage(s?.meanFatigue)],
  ]) + (world.demography ? section('Principales causas de muerte', bars(Object.entries(world.demography.causes).sort((a, b) => b[1] - a[1]).map(([cause, n]) => [causes.get(cause) ?? cause, n]))) : ''), populationScope);

  const animals = world.animals, morphological = animals?.filter(a => a.morphology) ?? [];
  const species = [...new Set(morphological.map(a => a.species))];
  const labels: Record<string, string> = { hare: 'Liebres', deer: 'Venados', boar: 'Jabalíes', fish: 'Peces', wolf: 'Lobos', fox: 'Zorros' };
  const morphology = grid(species.map(sp => {
    const samples = morphological.filter(a => a.species === sp);
    const mean = (k: 'coat' | 'size' | 'defense' | 'caution') => {
      const ns = samples.map(a => a.morphology?.[k]).filter(finite);
      return ns.length ? sum(ns) / ns.length : undefined;
    };
    return `<article class="stat-card"><span>${esc(labels[sp] ?? sp)} · ${esc(number(samples.length))} con morfología</span>${facts([
      ['Pelaje medio', percentage(mean('coat'))], ['Talla media', percentage(mean('size'))], ['Defensa media', percentage(mean('defense'))], ['Cautela media', percentage(mean('caution'))],
    ])}</article>`;
  }).join(''));
  const animalHtml = section('Evolución morfológica y domesticación emergente',
    (morphological.length ? morphology : note('Todavía no llegaron animales con morfología a esta vista.')) + facts([
      ['Habituados / mansos en vista (≥ 0,45)', number(animals && animals.every(a => finite(a.habituation)) ? summary.tameCount : undefined)],
      ['Cuidados no letales en vista', number(measuredSum(animals?.map(a => a.tends)))],
      ['Caza humana acumulada', number(s?.animalDynamics?.humanHunts)], ['Depredaciones acumuladas', number(s?.animalDynamics?.predations)],
    ]), 'Morfología: medias por especie de los individuos recibidos. Habituación y cuidados: cámara actual; campos ausentes = —.');

  const whispers = world.whispers;
  const active = whispers?.filter(w => w.status === 'latent' || w.status === 'heard') ?? [];
  const whisperHtml = section('Mensajes Divinos activos', cards([
    ['Latentes', number(whispers?.filter(w => w.status === 'latent').length)], ['Escuchados', number(whispers?.filter(w => w.status === 'heard').length)],
    ['Cumplidos', number(whispers?.filter(w => w.status === 'fulfilled').length)], ['Desvanecidos', number(whispers?.filter(w => w.status === 'faded').length)],
  ]) + grid(active.map(w => `<article class="stat-card" data-whisper="${esc(w.id)}"><span>${esc(w.status === 'latent' ? 'Latente' : 'Escuchado')}</span><p style="overflow-wrap:anywhere">${esc(w.note)}</p>${w.personName ? `<span>Para ${esc(w.personName)}</span>` : ''}${w.heardByName ? `<span>Escuchado por ${esc(w.heardByName)}</span>` : ''}${jump(w.x, w.y, `Ver mensaje (${number(w.x)}, ${number(w.y)})`)}</article>`).join('')),
  'Estados del registro de mensajes recibido; incluye activos y recientes, no el historial completo.');
  return censusHtml + animalHtml + whisperHtml;
}

function land(world: WorldView, directory: WorldDirectoryResponse | null | undefined, nivel: Nivel | null): string {
  const s = world.stats;
  const sinEstadisticas = !s && nivel !== null && nivel >= 2;
  const visible = new Map(world.structures?.map(v => [v.id, v]));
  const structures = directory?.structures.map(v => ({ ...v, workshop: (visible.get(v.id)?.synergy?.workshopBonus ?? 0) > 0 })) ?? world.structures?.map(v => ({
    id: v.id, name: v.name, x: v.x, y: v.y, cells: v.cells?.length ?? (v.footprint ? v.footprint.width * v.footprint.height : undefined),
    kilnTier: v.synergy?.kilnTier, tint: v.materialProfile?.tint, condition: v.condition,
    workshop: (v.synergy?.workshopBonus ?? 0) > 0,
  }));
  const top = structures?.filter(v => (v.cells ?? 0) > 1 || (v.kilnTier ?? 0) > 0 || v.workshop)
    .sort((a, b) => (b.cells ?? 0) - (a.cells ?? 0)).slice(0, 12);
  const infraestructura: [string, string][] = [
    ['Calzadas pavimentadas', number(s?.pavedTiles)], ['Senderos', number(s?.trailTiles)], ['Cultivos', number(s?.cultivatedTiles)],
    ['Salones poliominó', number(s?.polyominoStructures)], ['Sinergias entre obras', number(s?.synergyLinks)],
    ['Regiones descubiertas', number(world.discoveredChunks)], ['Regiones activas', number(world.activeChunks)],
  ];
  if (sinEstadisticas) {
    infraestructura.push(['Obras en vista', number(world.structures?.length)]);
  }
  const datosInfra = sinEstadisticas ? infraestructura.filter(([, valor]) => valor !== '—') : infraestructura;
  const aviso = sinEstadisticas ? note('Este nivel de la grabación omite las estadísticas de suelo, agua y cultivos.') : '';
  return aviso + (datosInfra.length ? section('Infraestructura y conectividad', cards(datosInfra), 'Infraestructura: regiones activas. Regiones descubiertas: territorio acumulado.') : '')
    + (sinEstadisticas ? '' : section('Hidrología y desigualdad espacial', facts([
      ['Agua dulce', number(s?.freshWater, 2)], ['Distancia media al agua potable', s?.distanciaMediaAgua === -1 ? 'Sin fuente potable en las celdas cargadas' : finite(s?.distanciaMediaAgua) ? `${number(s.distanciaMediaAgua, 2)} celdas` : '—'],
      ['Regiones sin agua', percentage(s?.regionesSinAgua)], ['Celdas con comida', percentage(s?.fraccionCeldasConComida)], ['Gini de recursos por región', number(s?.giniRecursosPorRegion, 3)],
    ]), 'Mediciones de regiones activas; — indica que el servidor no envió el dato.'))
    + (sinEstadisticas && !top?.length ? '' : section('Catálogo de grandes obras', top?.length ? grid(top.map(v =>
      `<article class="stat-card" data-structure="${esc(v.id)}"><header style="overflow-wrap:anywhere">${swatch(v.tint)}${esc(v.name)}</header>${facts([
        ['Celdas', number(v.cells)], ['Condición', percentage(v.condition)], ['Nivel de horno', finite(v.kilnTier) ? `T${number(v.kilnTier)}` : '—'],
      ])}${jump(v.x, v.y)}</article>`).join('')) : note(structures ? 'No hay grandes obras identificables en los datos recibidos.' : 'Catálogo de obras no recibido.'),
    directory ? 'Hasta 12 obras del directorio global, ordenadas por celdas.' : 'Hasta 12 obras en vista, ordenadas por celdas.'));
}

/** Pluralizes from the rounded figure shown, so 2401 ticks reads «1 día», not «1 días». */
const ageLabel = (ticks: number): string => {
  const days = number(ticks / DEMOGRAPHY_TICKS_PER_DAY, 2);
  return `${days} ${days === '1' ? 'día' : 'días'}`;
};

function communities(world: WorldView, directory: WorldDirectoryResponse | null | undefined, personasParciales: boolean): string {
  const local = new Map(world.communities?.map(c => [c.id, c]));
  const rows = directory ? directory.communities.map(c => ({ ...c, culture: local.get(c.id)?.culture, formedAt: local.get(c.id)?.formedAt })) : world.communities?.map(c => ({ ...c, memberCount: c.memberCount ?? c.members.length }));
  const ranked = rows ? [...rows].sort((a, b) => b.memberCount - a.memberCount) : [];
  const roster = directory?.people ?? (personasParciales ? undefined : world.people);
  const unaffiliated = roster?.every(p => p.communityId !== undefined) ? roster.filter(p => p.communityId === null).length : undefined;
  const axes: readonly [keyof CommunityView['culture'], string][] = [['sharing', 'Compartir'], ['stewardship', 'Cuidado'], ['openness', 'Apertura']];
  return section('Asentamientos y clanes', cards([
    ['Asentamientos globales', number(world.settlementCount)], ['Comunidades recibidas', number(rows?.length)],
    [`Sin comunidad · ${directory ? 'directorio global' : 'en vista'}`, number(unaffiliated)],
    ['Cooperaciones agregadas', number(measuredSum(rows?.map(c => c.cooperation)))], ['Disputas agregadas', number(measuredSum(rows?.map(c => c.disputes)))],
  ]), directory ? 'Resumen del directorio global recibido.' : 'Comunidades recibidas; habitantes sin comunidad: solo cámara actual.')
    + section('Tabla comparativa de asentamientos y clanes', rows ? ranked.length ? grid(ranked.map((c, index) => {
      const cultural = axes.map(([k, label]) => ({ label, n: c.culture?.[k] })).filter((v): v is { label: string; n: number } => finite(v.n));
      const max = cultural.reduce((m, v) => Math.max(m, v.n), -Infinity);
      const dominant = cultural.filter(v => v.n === max).map(v => `${v.label} (${percentage(v.n)})`).join(' · ') || '—';
      const elapsed = (directory?.tick ?? world.tick) - (c.formedAt ?? NaN);
      return `<article class="stat-card" data-community="${esc(c.id)}"><header style="overflow-wrap:anywhere">${swatch(c.color)}${esc(index + 1)}. ${esc(c.name)}</header>${facts([
        ['Miembros', number(c.memberCount)], ['Edad', finite(elapsed) && elapsed >= 0 ? ageLabel(elapsed) : '—'],
        ['Eje cultural dominante', dominant], ['Cooperaciones', number(c.cooperation)], ['Disputas', number(c.disputes)],
        ['Cooperación / disputa', finite(c.cooperation) && finite(c.disputes) && c.disputes > 0 ? number(c.cooperation / c.disputes, 3) : '—'],
      ])}${jump(c.x, c.y)}</article>`;
    }).join(''), true) : note('No hay comunidades en el registro recibido.') : note('Comunidades no recibidas.'),
    'Orden por miembros totales; cultura y fundación solo cuando fueron recibidas. Con cero disputas el cociente no está definido.');
}

const phaseLabels: Record<ThermalPhase, string> = { raw: 'Crudo', ground: 'Molido', washed: 'Lavado', fired: 'Cocido', smelted: 'Fundido', vitrified: 'Vítreo' };
const tiers = ['T0 frío', 'T1 hoguera', 'T2 horno'];
const properties = [['Dureza', 'hardness'], ['Tenacidad', 'toughness'], ['Sellado', 'seal'], ['Aislamiento', 'insulation'], ['Combustible', 'fuelPower'], ['Fertilidad', 'fertility'], ['Ligereza', 'lightness']] as const;

function technology(world: WorldView): string {
  const chemistry = world.chemistry, tech = world.technology, org = world.organization, summary = summarizeMundo(world);
  const formulas = chemistry ? [...chemistry.formulas].sort((a, b) => b.uses - a.uses || a.id.localeCompare(b.id)).slice(0, 8) : [];
  const focuses = new Map<string, number>();
  for (const p of world.people) if (p.craftFocus) focuses.set(p.craftFocus, (focuses.get(p.craftFocus) ?? 0) + 1);
  const topFocuses = [...focuses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  const crafts = grid(topFocuses.map(([focus, count]) => `<article class="stat-card"><span style="overflow-wrap:anywhere">${esc(focus)}</span><strong>${esc(number(count))}</strong>${world.people.filter(p => p.craftFocus === focus).slice(0, 4).map(p => jump(p.x, p.y, p.name)).join('')}</article>`).join(''));
  return section('Química algebraica universal (C · Si · Ca · Fe · S · H)', cards([
    ['Fórmulas descubiertas', number(chemistry?.totalFormulas)], ['Lotes activos', number(chemistry?.totalLots)],
    ['Mayor nivel de horno', chemistry ? tiers[chemistry.maxTemperatureTier] ?? '—' : '—'],
  ]) + bars((['grind', 'wash', 'heat', 'bind'] as const).map((op, i) => [(['Molienda', 'Lavado', 'Cocción', 'Mezcla'])[i], chemistry?.byOperator?.[op]])),
  'Operadores y totales informados por el servidor.')
    + section('Top 8 fórmulas descubiertas', formulas.length ? grid(formulas.map(f =>
      `<article class="stat-card" data-formula="${esc(f.id)}"><header style="overflow-wrap:anywhere">${swatch(f.properties?.colorHex)}${esc(f.name)}</header>${facts([
        ['Fase térmica', phaseLabels[f.phase] ?? f.phase], ['Nivel de horno', tiers[f.temperatureTier] ?? '—'], ['Usos', number(f.uses)],
      ])}<div class="gene-chips">${ELEMENTS.map(e => `<span>${esc(e)}<strong>${esc(percentage(f.composition?.[e]))}</strong></span>`).join('')}</div><div class="trait-list">${properties.map(([label, k]) =>
        `<span>${esc(label)}<strong>${esc(percentage(f.properties?.[k]))}</strong></span>`).join('')}</div></article>`).join('')) : note(chemistry ? 'No llegaron fórmulas descubiertas en esta muestra.' : 'Química no recibida.'),
    'Hasta ocho fórmulas recibidas, ordenadas por usos; la muestra puede ser parcial.')
    + section('Herramientas forjadas y oficios emergentes', cards([
      ['Objetos químicos con tinte recibido', number(tech ? summary.forgedTools : undefined)], ['Recetas registradas', number(tech?.dynamics.recipes)],
      ['Productos fabricados', number(tech?.dynamics.products)], ['Intentos', number(tech?.dynamics.attempts)], ['Fallos', number(tech?.dynamics.failures)],
      ['Usos de herramientas', number(tech?.dynamics.toolUses)], ['Recetas compartidas', number(tech?.dynamics.shared)],
    ]) + (topFocuses.length ? crafts : note('No llegaron oficios emergentes en los habitantes de esta vista.')),
    'Objetos forjados: presencia de materialTint en los objetos recibidos. Oficios: craftFocus de habitantes en cámara.')
    + section('Flujo de recetas y organización', facts([
      ['Ventana observada · pasos', org ? `${number(org.window.startTick)}–${number(org.window.endTick)}` : '—'],
      ['Ventana completa', org ? org.window.complete ? 'Sí' : 'No' : '—'], ['Ejecuciones observadas', number(org?.evidence.executed)], ['Ejecuciones exitosas', number(org?.evidence.successful)],
      ['Procesos activos', number(org?.diversity.activeProcesses)], ['Actores activos', number(org?.diversity.activeActors)],
    ]) + (org ? bars([...org.processes].sort((a, b) => b.fluxPerTick - a.fluxPerTick).map(p => [p.id, p.fluxPerTick]), 'ejecuciones/paso', 6) : note('Organización no recibida.')),
    'Flujo observado en una ventana finita; no certifica vida ni autosuficiencia.');
}

function performance(world: WorldView): string {
  const p = world.performance;
  const ms = (n?: number): string => finite(n) ? `${number(n, 6)} ms` : '—';
  const rows = Object.entries(p?.fases ?? {}).filter((r): r is [string, number] => finite(r[1])).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return section('Motor y paralelismo de hardware', cards([
    ['Frecuencia real', finite(p?.tickHz) ? `${number(p.tickHz, 3)} Hz` : '—'], ['Frecuencia objetivo', finite(p?.tickHzObjetivo) ? `${number(p.tickHzObjetivo, 3)} Hz` : '—'],
    ['Paso actual', ms(p?.stepMs)], ['p95', ms(p?.p95StepMs)],
    ['Ocupación de workers', percentage(p?.ocupacionWorkers)], ['Fracción serial real', percentage(p?.fraccionSerialReal)],
    ['Tiempo paralelo', ms(p?.tiempoParaleloMs)], ['Tiempo de barrera', ms(p?.tiempoBarreraMs)], ['Clon', ms(p?.cloneMs)], ['Simulación', ms(p?.simulationMs)],
    ['Guardado', ms(p?.saveMs)], ['Proyección', ms(p?.projectionMs)], ['Memoria RSS', finite(p?.processRssMiB) ? `${number(p.processRssMiB, 3)} MiB` : '—'],
    ['Instantánea', finite(p?.snapshotBytes) ? `${number(p.snapshotBytes / 1024, 3)} KiB` : '—'], ['Teselas activas', number(p?.activeTiles)],
  ]), 'Telemetría medida; los campos no recibidos se muestran como —.')
    + section('Desglose por fase (último paso, ms)',
      rows.length ? bars(rows, 'ms', 20) : note('No se recibieron mediciones por fase.'));
}

export function renderMundoDeepStats(world: WorldView, tab: MundoTab, directory?: WorldDirectoryResponse | null, nivel: Nivel | null = null): string {
  const personasParciales = nivel !== null && nivel >= 3;
  switch (tab) {
    case 'life': return life(world, directory, nivel);
    case 'land': return land(world, directory, nivel);
    case 'communities': return communities(world, directory, personasParciales);
    case 'technology': return technology(world);
    case 'materia': return '';
    case 'performance': return performance(world);
  }
}
