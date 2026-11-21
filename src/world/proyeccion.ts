import { PROTOCOL_VERSION, type PersonDetail, type PersonView, type Viewport, type WorldView } from '../shared/types.js';
import type { TechnologyState } from '../shared/technology.js';
import { phaseAt, TICKS_PER_DAY, type Person, type World, type WorldContext } from './index.js';
import { bindWorldContext, projectTerrain, worldContext } from './spatial.js';
import { paramsOf } from './params.js';
import { demographicTraits } from './demography.js';
import { constructionCost } from './inventions.js';
import { worldStatistics } from './statistics.js';
import { projectTechnology } from './technology.js';
import { analyzeTechnologyOrganization } from './technology-organization.js';

const clamp = (n: number, max = 1): number => Math.max(0, Math.min(max, n));
const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

function specialty(person: Person): string {
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
/** T036(h): las cantidades (existencias, huellas, fauna) no viajan cuando valen 0; el cliente las lee
 * con `?? 0`. Las magnitudes del terreno viajan siempre, porque ahí un cero es un dato. */
const amount = <K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> =>
  (typeof value !== 'number' || value === 0 ? {} : { [key]: r3(value) } as Record<K, number>);
export function projectWorld(world: World, viewport?: Viewport, context: WorldContext = worldContext(world)): WorldView {
  bindWorldContext(world, context);
  const projected = projectTerrain(world, viewport, context), v = projected.viewport;
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
  return {
    version: PROTOCOL_VERSION, sequence: world.tick, tick: world.tick, day: Math.floor(world.tick / TICKS_PER_DAY) + 1,
    phase: phaseAt(world.tick), weather: world.weather, width: v.width, height: v.height,
    originX: v.x, originY: v.y, infinite: true, activeChunks: Object.keys(world.chunks).length, discoveredChunks: world.discoveredChunks, settlementCount: world.settlementCount,
    tiles: projected.tiles.map(t => ({ x: t.x, y: t.y, terrain: t.terrain, biome: t.biome, elevation: viewNumber(t.elevation), moisture: viewNumber(t.moisture), food: viewNumber(t.food), vegetation: viewNumber(t.vegetation), feature: t.feature, growth: viewNumber(t.growth), fertility: viewNumber(t.fertility), species: t.species, ...amount('wood', t.wood), ...amount('stone', t.stone), ...amount('variety', t.variety), ...amount('cultivation', t.cultivation), ...amount('traffic', t.traffic), ...amount('drinkingWater', t.drinkingWater), ...amount('fauna', t.fauna), ...amount('life', t.life) })),
    people: peopleInView.map((p): PersonView => {
      const life = demographicTraits(p.genome, cuerpo);
      return { id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, color: p.color, action: p.action, reason: p.reason, energy: p.energy, hunger: p.hunger, fatigue: p.fatigue, thirst: p.thirst, need: p.need, recentMemory: p.recentMemory, traits: { ...p.traits }, skills: { ...p.skills }, materials: { ...p.materials }, specialty: specialty(p), controlMode: p.controlMode, blueprintId:p.blueprintId??null,
      target: { x:p.target.x,y:p.target.y }, foodReserve:p.inventory, foodReserveCapacity:0.25, working: !!p.technology.waterPreparation || ['gather','farm','build','hunt','invent','repair','research','craft','forage'].includes(p.action) && distance(p,p.target)<0.5,
      workProgress: p.technology.waterPreparation ? clamp(((p.technology.items.find(item => item.id === p.technology.waterPreparation!.itemId)?.contents?.water ?? 0) - p.technology.waterPreparation.initialQuanta) / (p.technology.waterPreparation.targetQuanta - p.technology.waterPreparation.initialQuanta))
        : ['research','craft'].includes(p.action) ? (p.technology.project ? clamp(p.technology.project.progress/p.technology.project.requiredWork) : 0) : clamp(p.work / (p.action==='build'?constructionCost(world,p).work:p.action==='invent'?60:p.action==='repair'?30:['farm','hunt'].includes(p.action)?Math.ceil(45*(1-(p.skills[p.action]??0)*0.25)):Math.ceil(18*(1-(p.skills[p.action]??0)*0.25)))),
      health:p.demography.health,vitality:p.demography.vitality,continuityProtected:p.role!=='neighbor',
      lifeStage: p.demography.age < life.maturityAge ? 'juvenile' : p.demography.age < life.senescenceStart ? 'adult' : 'senescent',
      genome: { generation: p.genome.generation, parents: [...p.genome.parents], learningRate: p.genome.learningRate, cooperation: p.genome.cooperation, mutations: p.genome.mutations }, age: world.tick - p.bornAt, communityId: p.communityId, culture: { ...p.culture } };
    }),
    places: projected.places.map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, description: p.description, gatherings: p.gatherings })), events: world.events.slice(-VIEW_EVENTS).map(e => ({ id: e.id, tick: e.tick, kind: e.kind, actors: [...e.actors], ...(e.x === undefined ? {} : { x: e.x }), ...(e.y === undefined ? {} : { y: e.y }), text: e.text, cause: e.cause, source: e.source, ...(e.death === undefined ? {} : { death: { ...e.death, previous: [...e.death.previous] } }) })),
    memories: world.memories.slice(-VIEW_MEMORIES).map(m => ({ id: m.id, title: m.title, text: m.text, source: m.source, placeId: m.placeId })),
    animals: projected.animals, structures: projected.structures, blueprints: world.blueprints.filter(b=>referencedBlueprintIds.has(b.id)).map(b=>({id:b.id,name:b.name,components:[...b.components],generation:b.generation,parents:[...b.parents],inventorId:b.inventorId,tick:b.tick,uses:b.uses,usefulness:b.usefulness,cost:{wood:b.cost.wood,stone:b.cost.stone,work:b.cost.work}})),
    stats: worldStatistics(world), communities: world.communities.map(c => ({ id: c.id, name: c.name, x: c.x, y: c.y, color: c.color, members: c.members.filter(id=>visibleIds.has(id)), memberCount: c.members.length, culture: { ...c.culture }, formedAt: c.formedAt, cooperation: c.cooperation, disputes: c.disputes })),
    technology: projectTechnology(world), organization: (({ resources: _resources, ...summary }) => structuredClone(summary))(organization.value),
    demography: {deaths:world.demographyDynamics.deaths,causes:{...world.demographyDynamics.causes},recent:world.legacy.slice(0,32).map(p=>({id:p.id,name:p.name,generation:p.generation,parents:[...p.parents],bornAt:p.bornAt,diedAt:p.diedAt,cause:p.cause}))},
  };
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
