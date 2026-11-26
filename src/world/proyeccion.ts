import { PROTOCOL_VERSION, type PersonDetail, type PersonView, type Tile, type Viewport, type WorldView } from '../shared/types.js';
import type { TechnologyState } from '../shared/technology.js';
import { publicGeologyKey, type ChemicalFormulaView, type ChemistrySummaryView } from '../shared/chemistry.js';
import { phaseAt, TICKS_PER_DAY, type Person, type World, type WorldContext } from './index.js';
import { bindWorldContext, projectTerrain, worldContext } from './spatial.js';
import { paramsOf, type WorldParams } from './params.js';
import { demographicTraits } from './demography.js';
import { escuchaDe } from './genetics.js';
import { constructionCost } from './inventions.js';
import { worldStatistics } from './statistics.js';
import { residentFastAccess, type ResidentFastAccess } from './soa/terreno.js';
import { projectTechnology } from './technology.js';
import { analyzeTechnologyOrganization } from './technology-organization.js';
import { whisperView } from './whispers.js';
import { ctxSi } from './motor/acceso.js';
import { leyesActivas } from './motor/leyes.js';
import type { Animal } from './animals.js';

const clamp = (n: number, max = 1): number => Math.max(0, Math.min(max, n));
// El coste escalar de trabajo de una pieza material es uno. La vista no necesita abrir los lotes del dueño.
export function progresoConstruccion(world: World, persona: Person): number {
  return clamp(paramsOf(world).v23.obra ? persona.work : persona.work / constructionCost(world, persona).work);
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

export function specialty(person: Person): string {
  const names: Record<string, string> = { explore: 'exploración', eat: 'recolección de alimento', forage: 'cosecha y provisión', drink: 'búsqueda de agua', hunt: 'caza', rest: 'recuperación', share: 'cuidado', gather: 'materiales', farm: 'cultivo', build: 'construcción', cooperate: 'cooperación' };
  const practiced = Object.entries(person.activity).filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return practiced.length ? practiced.map(([action]) => names[action] ?? action).join(' · ') : 'Descubriendo sus aptitudes';
}

/** Explicit allow-list: no PRNG, habit internals, private provenance or session data cross the wire. */
const organizationViews = new WeakMap<World, { tick: number; executionCounter: number; checkpoint: TechnologyState['checkpoint']; value: NonNullable<WorldView['organization']> }>();
/** Windows of the projection, not of the world: the chronicle and the letter keep their own bounds. */
export const VIEW_EVENTS = 40, VIEW_MEMORIES = 100;
/** A snapshot is read by a screen: thousandths are the resolution it draws and the one the wire pays for.
 * An absent datum stays absent; rounding never invents a zero. */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const viewNumber = <T extends number | undefined>(value: T): T => (typeof value === 'number' ? r3(value) : value) as T;
/** El empedrado pequeño viaja con tres cifras significativas y la calzada se dibuja a partir de 0,5. */
export function projectPaving(paved: number | undefined): number | undefined {
  if (typeof paved !== 'number' || paved === 0) return undefined;
  if (paved > 0 && paved < 0.001) return Number(paved.toPrecision(3));
  const rounded = r3(paved);
  return paved < 0.5 && rounded === 0.5 ? paved : rounded;
}
/** T036(h): las cantidades (existencias, huellas, fauna) no viajan cuando valen 0; el cliente las lee
 * con `?? 0`. Las magnitudes del terreno viajan siempre, porque ahí un cero es un dato. Se asignan
 * directamente (sin objetos ni spreads intermedios por tesela). */
export function projectTile(t: ReturnType<typeof projectTerrain>['tiles'][number], fast?: ResidentFastAccess): Tile {
  const cell = fast ? fast.cellOf(t as Tile) : -1;
  const paved = projectPaving(t.paved);
  if (cell >= 0 && fast) {
    const tc = fast.terrainArr[cell]!, bc = fast.biomeArr[cell]!, fc = fast.featureArr[cell]!;
    const mo = fast.moistureArr[cell]!, fo = fast.foodArr[cell]!, ve = fast.vegetationArr[cell]!;
    const gr = fast.growthArr[cell]!, fe = fast.fertilityArr[cell]!;
    const out: Tile = {
      x: t.x, y: t.y,
      terrain: (tc ? fast.TERRAIN_NAMES[tc - 1] : undefined) as Tile['terrain'],
      biome: (bc ? fast.BIOME_NAMES[bc - 1] : undefined) as Tile['biome'],
      elevation: viewNumber(t.elevation),
      moisture: (mo === mo ? r3(mo) : undefined) as number,
      food: (fo === fo ? r3(fo) : undefined) as number,
      vegetation: (ve === ve ? r3(ve) : undefined) as number,
      feature: (fc ? fast.FEATURE_NAMES[fc - 1] : undefined) as Tile['feature'],
      growth: gr === gr ? r3(gr) : undefined,
      fertility: fe === fe ? r3(fe) : undefined,
      species: t.species,
    };
    const wo = fast.woodArr[cell]!; if (wo === wo && wo !== 0) out.wood = r3(wo);
    if (typeof t.stone === 'number' && t.stone !== 0) out.stone = r3(t.stone);
    if (typeof t.variety === 'number' && t.variety !== 0) out.variety = r3(t.variety);
    const cu = fast.cultivationArr[cell]!; if (cu === cu && cu !== 0) out.cultivation = r3(cu);
    const tr = fast.trafficArr[cell]!; if (tr === tr && tr !== 0) out.traffic = r3(tr);
    if (paved !== undefined) out.paved = paved;
    const dw = fast.drinkingWaterArr[cell]!; if (dw === dw && dw !== 0) out.drinkingWater = r3(dw);
    if (typeof t.fauna === 'number' && t.fauna !== 0) out.fauna = r3(t.fauna);
    const li = fast.lifeArr[cell]!; if (li === li && li !== 0) out.life = r3(li);
    return out;
  }
  const out: Tile = { x: t.x, y: t.y, terrain: t.terrain, biome: t.biome, elevation: viewNumber(t.elevation), moisture: viewNumber(t.moisture), food: viewNumber(t.food), vegetation: viewNumber(t.vegetation), feature: t.feature, growth: viewNumber(t.growth), fertility: viewNumber(t.fertility), species: t.species };
  if (typeof t.wood === 'number' && t.wood !== 0) out.wood = r3(t.wood);
  if (typeof t.stone === 'number' && t.stone !== 0) out.stone = r3(t.stone);
  if (typeof t.variety === 'number' && t.variety !== 0) out.variety = r3(t.variety);
  if (typeof t.cultivation === 'number' && t.cultivation !== 0) out.cultivation = r3(t.cultivation);
  if (typeof t.traffic === 'number' && t.traffic !== 0) out.traffic = r3(t.traffic);
  if (paved !== undefined) out.paved = paved;
  if (typeof t.drinkingWater === 'number' && t.drinkingWater !== 0) out.drinkingWater = r3(t.drinkingWater);
  if (typeof t.fauna === 'number' && t.fauna !== 0) out.fauna = r3(t.fauna);
  if (typeof t.life === 'number' && t.life !== 0) out.life = r3(t.life);
  return out;
}
/** Acciones de trabajo y de proyecto, fuera de la proyección para no crear un arreglo por persona. */
const WORKING_ACTIONS: ReadonlySet<string> = new Set(['gather', 'farm', 'build', 'hunt', 'invent', 'repair', 'research', 'craft', 'forage']);
const PROJECT_ACTIONS: ReadonlySet<string> = new Set(['research', 'craft']);
const SKILLED_ACTIONS: ReadonlySet<string> = new Set(['farm', 'hunt']);

/** Structural boundary for the chemistry worktree: only public summary fields cross the wire.
 * Internal ledgers/provenance remain private; every nested public value is detached. */
export function projectChemistry(world: World): ChemistrySummaryView {
  const state = (world.chemistry && typeof world.chemistry === 'object' ? world.chemistry : {}) as Partial<ChemistrySummaryView>;
  const formulas: ChemicalFormulaView[] = (Array.isArray(state.formulas) ? state.formulas : []).map(f => ({
    id: f.id, signature: f.signature, name: f.name, composition: { ...f.composition }, phase: f.phase,
    temperatureTier: f.temperatureTier, operator: f.operator, discoveredAt: f.discoveredAt,
    discovererId: f.discovererId, uses: f.uses, properties: { ...f.properties },
  }));
  const byOperator: ChemistrySummaryView['byOperator'] = { grind: 0, wash: 0, heat: 0, bind: 0 };
  let maxTemperatureTier: ChemistrySummaryView['maxTemperatureTier'] = 0;
  for (const f of formulas) {
    if (Object.hasOwn(byOperator, f.operator)) byOperator[f.operator]++;
    if (f.temperatureTier > maxTemperatureTier) maxTemperatureTier = f.temperatureTier;
  }
  if (state.byOperator) for (const op of ['grind', 'wash', 'heat', 'bind'] as const) byOperator[op] = state.byOperator[op] ?? byOperator[op];
  let lots = 0;
  for (const p of world.people) lots += p.compounds?.length ?? 0;
  for (const s of world.structures) lots += s.storedCompounds?.length ?? 0;
  return { formulas, totalFormulas: state.totalFormulas ?? formulas.length, totalLots: state.totalLots ?? lots,
    maxTemperatureTier: state.maxTemperatureTier ?? maxTemperatureTier, byOperator };
}

export function projectWorld(world: World, viewport?: Viewport, context: WorldContext = worldContext(world),
  decorarPersona?: (persona: Person, vista: PersonView) => void): WorldView {
  bindWorldContext(world, context);
  const c = ctxSi(world);
  const ganchos = c ? leyesActivas(paramsOf(world).v23).flatMap(l => l.proyectar ? [l.proyectar] : []) : [];
  const animales = ganchos.some(l => l.animal) ? new Map<string, Animal>() : undefined;
  const loadChunk = context.loadChunk;
  // La proyección del terreno también puede encontrar fauna archivada en el almacén.
  const contextoTerreno = animales && loadChunk ? { ...context, loadChunk(key: string, tick: number, v23?: WorldParams['v23']) {
    const chunk = loadChunk.call(context, key, tick, v23);
    for (const a of chunk?.animals ?? []) animales.set(a.id, a);
    return chunk;
  } } : context;
  const projected = projectTerrain(world, viewport, contextoTerreno), v = projected.viewport;
  if (animales) {
    for (const chunk of world.retiredChunks) for (const a of chunk.animals ?? []) animales.set(a.id, a);
    for (const a of world.animals) animales.set(a.id, a);
  }
  let organization=organizationViews.get(world);
  if(!organization||organization.tick!==world.tick||organization.executionCounter!==world.technology.executionCounter||organization.checkpoint!==world.technology.checkpoint) {
    organization={tick:world.tick,executionCounter:world.technology.executionCounter,checkpoint:world.technology.checkpoint,value:analyzeTechnologyOrganization(world.technology,world.people,world.tick)};
    organizationViews.set(world,organization);
  }
  // La ley de longevidad del mundo, leída una vez por proyección: decide `lifeStage` de cada persona.
  const cuerpo = paramsOf(world).cuerpo;
  // T134: `people` se recorta con la misma prueba de cámara que `projectTerrain` aplica a `tiles`,
  // con una celda de margen para que nadie parpadee al entrar en cuadro. El censo (`stats.census`)
  // sigue viendo toda la población.
  const visible = (p: { x: number; y: number }, margin: number): boolean =>
    p.x >= v.x - margin && p.y >= v.y - margin && p.x < v.x + v.width + margin && p.y < v.y + v.height + margin;
  const peopleInView = world.people.filter(p => visible(p, 1));
  const visibleIds = new Set(peopleInView.map(p => p.id));
  // Solo viajan los planos que referencia alguna estructura visible; el resto se pide a demanda.
  const referencedBlueprintIds = new Set(projected.structures.map(s => s.blueprintId).filter((id): id is string => typeof id === 'string'));
  const fastTiles = residentFastAccess(world.tiles);
  const vista: WorldView = {
    version: PROTOCOL_VERSION, sequence: world.tick, tick: world.tick, geologyKey: publicGeologyKey(world.seed), day: Math.floor(world.tick / TICKS_PER_DAY) + 1,
    phase: phaseAt(world.tick), weather: world.weather, width: v.width, height: v.height,
    originX: v.x, originY: v.y, infinite: true, activeChunks: Object.keys(world.chunks).length, discoveredChunks: world.discoveredChunks, settlementCount: world.settlementCount,
    tiles: projected.tiles.map(t => {
      const vista = projectTile(t, fastTiles);
      if (c) for (const l of ganchos) l.tesela?.(c, t, vista);
      return vista;
    }),
    people: peopleInView.map((p): PersonView => {
      const life = demographicTraits(p.genome, cuerpo);
      const vista: PersonView = { id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, color: p.color, action: p.action, reason: p.reason, energy: p.energy, hunger: p.hunger, fatigue: p.fatigue, thirst: p.thirst, need: p.need, recentMemory: p.recentMemory, traits: { ...p.traits }, escucha: escuchaDe(p.genome), skills: { ...p.skills }, materials: { ...p.materials }, specialty: specialty(p), controlMode: p.controlMode, blueprintId:p.blueprintId??null,
      target: { x:p.target.x,y:p.target.y }, foodReserve:p.inventory, foodReserveCapacity:0.25, working: !!p.technology.waterPreparation || WORKING_ACTIONS.has(p.action) && distance(p,p.target)<0.5,
      workProgress: p.technology.waterPreparation ? clamp(((p.technology.items.find(item => item.id === p.technology.waterPreparation!.itemId)?.contents?.water ?? 0) - p.technology.waterPreparation.initialQuanta) / (p.technology.waterPreparation.targetQuanta - p.technology.waterPreparation.initialQuanta))
        : PROJECT_ACTIONS.has(p.action) ? (p.technology.project ? clamp(p.technology.project.progress/p.technology.project.requiredWork) : 0) : p.action === 'build' ? progresoConstruccion(world, p) : clamp(p.work / (p.action==='invent'?60:p.action==='repair'?30:SKILLED_ACTIONS.has(p.action)?Math.ceil(45*(1-(p.skills[p.action]??0)*0.25)):Math.ceil(18*(1-(p.skills[p.action]??0)*0.25)))),
      health:p.demography.health,vitality:p.demography.vitality,continuityProtected:p.role!=='neighbor',
      lifeStage: p.demography.age < life.maturityAge ? 'juvenile' : p.demography.age < life.senescenceStart ? 'adult' : 'senescent',
      genome: { generation: p.genome.generation, parents: [...p.genome.parents], learningRate: p.genome.learningRate, cooperation: p.genome.cooperation, mutations: p.genome.mutations }, age: world.tick - p.bornAt, communityId: p.communityId, culture: { ...p.culture },
      ...(p.compounds?.length ? { compounds: p.compounds.map(c => ({ ...c, composition: { ...c.composition }, properties: { ...c.properties } })) } : {}) };
      decorarPersona?.(p, vista);
      if (c) for (const l of ganchos) l.persona?.(c, p, vista);
      return vista;
    }),
    places: projected.places.map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, description: p.description, gatherings: p.gatherings })), events: world.events.slice(-VIEW_EVENTS).map(e => ({ id: e.id, tick: e.tick, kind: e.kind, actors: [...e.actors], ...(e.x === undefined ? {} : { x: e.x }), ...(e.y === undefined ? {} : { y: e.y }), text: e.text, cause: e.cause, source: e.source, ...(e.death === undefined ? {} : { death: { ...e.death, previous: [...e.death.previous] } }) })),
    memories: world.memories.slice(-VIEW_MEMORIES).map(m => ({ id: m.id, title: m.title, text: m.text, source: m.source, placeId: m.placeId })),
    animals: projected.animals, structures: projected.structures, blueprints: world.blueprints.filter(b=>referencedBlueprintIds.has(b.id)).map(b=>({id:b.id,name:b.name,components:[...b.components],generation:b.generation,parents:[...b.parents],inventorId:b.inventorId,tick:b.tick,uses:b.uses,usefulness:b.usefulness,cost:{wood:b.cost.wood,stone:b.cost.stone,work:b.cost.work}})),
    stats: worldStatistics(world), communities: world.communities.map(c => ({ id: c.id, name: c.name, x: c.x, y: c.y, color: c.color, members: c.members.filter(id=>visibleIds.has(id)), memberCount: c.members.length, culture: { ...c.culture }, formedAt: c.formedAt, cooperation: c.cooperation, disputes: c.disputes })),
    technology: projectTechnology(world, peopleInView), organization: (({ resources: _resources, ...summary }) => structuredClone(summary))(organization.value),
    ...(world.chemistry ? { chemistry: projectChemistry(world) } : {}),
    // V24: los Mensajes Divinos son públicos para quien observa (copias, nunca el estado vivo).
    ...(world.whispers?.length ? { whispers: world.whispers.map(whisperView) } : {}),
    demography: {deaths:world.demographyDynamics.deaths,causes:{...world.demographyDynamics.causes},recent:world.legacy.slice(0,32).map(p=>({id:p.id,name:p.name,generation:p.generation,parents:[...p.parents],bornAt:p.bornAt,diedAt:p.diedAt,cause:p.cause}))},
  };
  if (c && animales) for (const a of projected.animals) {
    const origen = animales.get(a.id);
    if (origen) for (const l of ganchos) l.animal?.(c, origen, a);
  }
  if (c) for (const l of ganchos) l.mundo?.(c, vista);
  return vista;
}

/** T036(h): la biografía de UN habitante, servida a petición y de sólo lectura, como
 * `technologyRecipeDetail`. Una identidad que ya no vive devuelve `undefined`: ausente, no vacía. */
export function personDetail(world: World, id: string): PersonDetail | undefined {
  if (typeof id !== 'string' || id.length > 50) return undefined;
  const person = world.people.find(p => p.id === id);
  if (!person) return undefined;
  return { id: person.id,
    experiences: person.experiences.map(e => ({ tick: e.tick, text: e.text, causeId: e.causeId })),
    trust: Object.entries(person.bonds).map(([other, value]) => ({ id: other, value: viewNumber(value) })),
    recipeIds: [...person.technology.knownRecipes] };
}
