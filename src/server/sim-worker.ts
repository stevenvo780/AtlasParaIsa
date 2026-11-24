import { projectChemistry } from '../world/proyeccion.js';
import { publicGeologyKey } from '../shared/chemistry.js';
import { PROTOCOL_VERSION, type PersonDetail, type PersonView, type Tile, type Viewport, type WorldView } from '../shared/types.js';
import type { TechnologyState } from '../shared/technology.js';
import { phaseAt, TICKS_PER_DAY, type Person, type World, type WorldContext } from '../world/index.js';
import { bindWorldContext, projectTerrain, worldContext } from '../world/spatial.js';
import { paramsOf } from '../world/params.js';
import { demographicTraits } from '../world/demography.js';
import { constructionCost } from '../world/inventions.js';
import { worldStatistics } from '../world/statistics.js';
import { residentFastAccess, type ResidentFastAccess } from '../world/soa/terreno.js';
import { projectTechnology } from '../world/technology.js';
import { analyzeTechnologyOrganization } from '../world/technology-organization.js';
import { projectCraft } from '../world/projection.js';
import { encodeChunkMinimapCells } from './worldmap-service.js';
import { parseWhisperRequest, whisperView } from '../world/whispers.js';
import type { DivineWhisperRequest } from '../shared/worldmap.js';

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
const nonZero = (n: number | undefined): number | undefined => typeof n === 'number' && n !== 0 ? r3(n) : undefined;
/** The SoA-bound projection: terrain magnitudes from the shared arrays, the object-held fields already projected. */
function projectSoaTile(fast: ResidentFastAccess, cell: number, x: number, y: number, elevation: number | undefined, species: Tile['species'],
  stone: number | undefined, variety: number | undefined, paved: number | undefined, fauna: number | undefined): Tile {
  const tc = fast.terrainArr[cell]!, bc = fast.biomeArr[cell]!, fc = fast.featureArr[cell]!;
  const mo = fast.moistureArr[cell]!, fo = fast.foodArr[cell]!, ve = fast.vegetationArr[cell]!;
  const gr = fast.growthArr[cell]!, fe = fast.fertilityArr[cell]!;
  const out: Tile = {
    x, y,
    terrain: (tc ? fast.TERRAIN_NAMES[tc - 1] : undefined) as Tile['terrain'],
    biome: (bc ? fast.BIOME_NAMES[bc - 1] : undefined) as Tile['biome'],
    elevation,
    moisture: (mo === mo ? r3(mo) : undefined) as number,
    food: (fo === fo ? r3(fo) : undefined) as number,
    vegetation: (ve === ve ? r3(ve) : undefined) as number,
    feature: (fc ? fast.FEATURE_NAMES[fc - 1] : undefined) as Tile['feature'],
    growth: gr === gr ? r3(gr) : undefined,
    fertility: fe === fe ? r3(fe) : undefined,
    species,
  };
  const wo = fast.woodArr[cell]!; if (wo === wo && wo !== 0) out.wood = r3(wo);
  if (stone !== undefined) out.stone = stone;
  if (variety !== undefined) out.variety = variety;
  const cu = fast.cultivationArr[cell]!; if (cu === cu && cu !== 0) out.cultivation = r3(cu);
  const tr = fast.trafficArr[cell]!; if (tr === tr && tr !== 0) out.traffic = r3(tr);
  if (paved !== undefined) out.paved = paved;
  const dw = fast.drinkingWaterArr[cell]!; if (dw === dw && dw !== 0) out.drinkingWater = r3(dw);
  if (fauna !== undefined) out.fauna = fauna;
  const li = fast.lifeArr[cell]!; if (li === li && li !== 0) out.life = r3(li);
  return out;
}
const same = (value: number, projected: number | undefined): boolean => value === value ? r3(value) === projected : projected === undefined;
const optional = (value: number, projected: number | undefined): boolean => value === value && value !== 0 ? r3(value) === projected : projected === undefined;
/** True when the shared-array fields of `cell` still project to exactly what `previous` holds. */
function soaFieldsEqual(previous: Tile, fast: ResidentFastAccess, cell: number): boolean {
  const tc = fast.terrainArr[cell]!, bc = fast.biomeArr[cell]!, fc = fast.featureArr[cell]!;
  if ((tc ? fast.TERRAIN_NAMES[tc - 1] : undefined) !== previous.terrain || (bc ? fast.BIOME_NAMES[bc - 1] : undefined) !== previous.biome
    || (fc ? fast.FEATURE_NAMES[fc - 1] : undefined) !== previous.feature) return false;
  return same(fast.moistureArr[cell]!, previous.moisture) && same(fast.foodArr[cell]!, previous.food)
    && same(fast.vegetationArr[cell]!, previous.vegetation) && same(fast.growthArr[cell]!, previous.growth)
    && same(fast.fertilityArr[cell]!, previous.fertility) && optional(fast.woodArr[cell]!, previous.wood)
    && optional(fast.cultivationArr[cell]!, previous.cultivation) && optional(fast.trafficArr[cell]!, previous.traffic)
    && optional(fast.drinkingWaterArr[cell]!, previous.drinkingWater) && optional(fast.lifeArr[cell]!, previous.life);
}
/** Same tile object, same revision, SoA slot stamped by a parallel write: only the shared-array fields can
 * differ, so they are re-read and the object-held ones are taken from the previous projection (no Proxy reads). */
function refreshSoaTile(previous: Tile, fast: ResidentFastAccess, cell: number): Tile {
  return projectSoaTile(fast, cell, previous.x, previous.y, previous.elevation, previous.species, previous.stone, previous.variety, previous.paved, previous.fauna);
}
/** T036(h): las cantidades (existencias, huellas, fauna) no viajan cuando valen 0; el cliente las lee
 * con `?? 0`. Las magnitudes del terreno viajan siempre, porque ahí un cero es un dato. Se asignan
 * directamente (sin objetos ni spreads intermedios por tesela). */
export function projectMirrorTile(t: ReturnType<typeof projectTerrain>['tiles'][number], fast?: ResidentFastAccess): Tile {
  const cell = fast ? fast.cellOf(t as Tile) : -1;
  if (cell >= 0 && fast) return projectSoaTile(fast, cell, t.x, t.y, viewNumber(t.elevation), t.species,
    nonZero(t.stone), nonZero(t.variety), nonZero(t.paved), nonZero(t.fauna));
  const out: Tile = { x: t.x, y: t.y, terrain: t.terrain, biome: t.biome, elevation: viewNumber(t.elevation), moisture: viewNumber(t.moisture), food: viewNumber(t.food), vegetation: viewNumber(t.vegetation), feature: t.feature, growth: viewNumber(t.growth), fertility: viewNumber(t.fertility), species: t.species };
  if (typeof t.wood === 'number' && t.wood !== 0) out.wood = r3(t.wood);
  if (typeof t.stone === 'number' && t.stone !== 0) out.stone = r3(t.stone);
  if (typeof t.variety === 'number' && t.variety !== 0) out.variety = r3(t.variety);
  if (typeof t.cultivation === 'number' && t.cultivation !== 0) out.cultivation = r3(t.cultivation);
  if (typeof t.traffic === 'number' && t.traffic !== 0) out.traffic = r3(t.traffic);
  if (typeof t.paved === 'number' && t.paved !== 0) out.paved = r3(t.paved);
  if (typeof t.drinkingWater === 'number' && t.drinkingWater !== 0) out.drinkingWater = r3(t.drinkingWater);
  if (typeof t.fauna === 'number' && t.fauna !== 0) out.fauna = r3(t.fauna);
  if (typeof t.life === 'number' && t.life !== 0) out.life = r3(t.life);
  return out;
}
/** Acciones de trabajo y de proyecto, fuera de la proyección para no crear un arreglo por persona. */
const WORKING_ACTIONS: ReadonlySet<string> = new Set(['gather', 'farm', 'build', 'hunt', 'invent', 'repair', 'research', 'craft', 'forage']);
const PROJECT_ACTIONS: ReadonlySet<string> = new Set(['research', 'craft']);
const SKILLED_ACTIONS: ReadonlySet<string> = new Set(['farm', 'hunt']);
const q2 = (n: number): number => Math.round(n * 100) / 100;
const q2opt = <T extends number | undefined>(n: T): T => (typeof n === 'number' ? q2(n) : n) as T;
interface MirrorProjection {
  /** DVR telemetry resolution (V21): fast-drifting bodies to 2 decimals, animal age to 20-tick buckets,
   * applied in the projection pass itself. */
  quantize?: boolean;
  /** Leave out `CARRIED_VIEW_FIELDS` (not even computed). */
  carry?: boolean;
}
export function projectMirrorWorld(world: World, viewport?: Viewport, context: WorldContext = worldContext(world)): WorldView {
  return projectMirror(world, context, {});
}
function projectMirror(world: World, context: WorldContext, options: MirrorProjection): WorldView {
  bindWorldContext(world, context);
  const quantize = !!options.quantize, carry = !!options.carry;
  const animals = new Array<ReturnType<typeof projectAnimal>>(world.animals.length);
  for (let i = 0; i < animals.length; i++) {
    const a = projectAnimal(world.animals[i]!, world.tick);
    if (quantize) {
      a.hunger = q2(a.hunger); a.thirst = q2(a.thirst); a.energy = q2(a.energy); a.fatigue = q2(a.fatigue); a.health = q2(a.health);
      if (a.reproReserve !== undefined) a.reproReserve = q2(a.reproReserve);
      if (a.age !== undefined) a.age = Math.floor(a.age / 20) * 20;
    }
    animals[i] = a;
  }
  const projected = { tiles: [], places: world.places, animals, structures: world.structures }, v = { x: 0, y: 0, width: 40, height: 28 };
  let organization=organizationViews.get(world);
  if(!carry&&(!organization||organization.tick!==world.tick||organization.executionCounter!==world.technology.executionCounter||organization.checkpoint!==world.technology.checkpoint)) {
    organization={tick:world.tick,executionCounter:world.technology.executionCounter,checkpoint:world.technology.checkpoint,value:analyzeTechnologyOrganization(world.technology,world.people,world.tick)};
    organizationViews.set(world,organization);
  }
  // La ley de longevidad del mundo, leída una vez por proyección: decide `lifeStage` de cada persona.
  const cuerpo = paramsOf(world).cuerpo;
  // T134: `people` se recorta con la misma prueba de cámara que `projectTerrain` aplica a `tiles`,
  // con una celda de margen para que nadie parpadee al entrar en cuadro. El censo (`stats.census`)
  // sigue viendo toda la población.
  const visible = (_p: { x: number; y: number }, _margin: number): boolean => true;
  const peopleInView = world.people.filter(p => visible(p, 1));
  const visibleIds = new Set(peopleInView.map(p => p.id));
  // Solo viajan los planos que referencia alguna estructura visible; el resto se pide a demanda.
  const referencedBlueprintIds = new Set(projected.structures.map(s => s.blueprintId).filter((id): id is string => typeof id === 'string'));
  const fastTiles = residentFastAccess(world.tiles);
  const view: WorldView = {
    version: PROTOCOL_VERSION, sequence: world.tick, tick: world.tick, geologyKey: publicGeologyKey(world.seed), day: Math.floor(world.tick / TICKS_PER_DAY) + 1,
    phase: phaseAt(world.tick), weather: world.weather, width: v.width, height: v.height,
    originX: v.x, originY: v.y, infinite: true, activeChunks: Object.keys(world.chunks).length, discoveredChunks: world.discoveredChunks, settlementCount: world.settlementCount,
    tiles: projected.tiles.map(t => projectMirrorTile(t, fastTiles)),
    people: peopleInView.map((p): PersonView => {
      const life = demographicTraits(p.genome, cuerpo);
      const view: PersonView = { id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, color: p.color, action: p.action, reason: p.reason,
      energy: quantize ? q2(p.energy) : p.energy, hunger: quantize ? q2(p.hunger) : p.hunger, fatigue: quantize ? q2(p.fatigue) : p.fatigue, thirst: quantize ? q2opt(p.thirst) : p.thirst,
      need: p.need, recentMemory: p.recentMemory, traits: { ...p.traits }, skills: { ...p.skills }, materials: { ...p.materials }, specialty: specialty(p), controlMode: p.controlMode, blueprintId:p.blueprintId??null,
      target: { x:p.target.x,y:p.target.y }, foodReserve:quantize ? q2opt(p.inventory) : p.inventory, foodReserveCapacity:0.25, working: !!p.technology.waterPreparation || WORKING_ACTIONS.has(p.action) && distance(p,p.target)<0.5,
      workProgress: p.technology.waterPreparation ? clamp(((p.technology.items.find(item => item.id === p.technology.waterPreparation!.itemId)?.contents?.water ?? 0) - p.technology.waterPreparation.initialQuanta) / (p.technology.waterPreparation.targetQuanta - p.technology.waterPreparation.initialQuanta))
        : PROJECT_ACTIONS.has(p.action) ? (p.technology.project ? clamp(p.technology.project.progress/p.technology.project.requiredWork) : 0) : clamp(p.work / (p.action==='build'?constructionCost(world,p).work:p.action==='invent'?60:p.action==='repair'?30:SKILLED_ACTIONS.has(p.action)?Math.ceil(45*(1-(p.skills[p.action]??0)*0.25)):Math.ceil(18*(1-(p.skills[p.action]??0)*0.25)))),
      health:quantize ? q2opt(p.demography.health) : p.demography.health,vitality:quantize ? q2opt(p.demography.vitality) : p.demography.vitality,continuityProtected:p.role!=='neighbor',
      lifeStage: p.demography.age < life.maturityAge ? 'juvenile' : p.demography.age < life.senescenceStart ? 'adult' : 'senescent',
      genome: { generation: p.genome.generation, parents: [...p.genome.parents], learningRate: p.genome.learningRate, cooperation: p.genome.cooperation, mutations: p.genome.mutations }, age: world.tick - p.bornAt, communityId: p.communityId, culture: { ...p.culture },
      ...(p.compounds?.length ? { compounds: p.compounds.map(c => ({ ...c, composition: { ...c.composition }, properties: { ...c.properties } })) } : {}) };
      // V24: the live mirror and the DVR show what each inhabitant works with (no allocation when empty).
      projectCraft(p, view);
      return view;
    }),
    places: projected.places.map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, description: p.description, gatherings: p.gatherings })), events: world.events.slice(-VIEW_EVENTS).map(e => ({ id: e.id, tick: e.tick, kind: e.kind, actors: [...e.actors], ...(e.x === undefined ? {} : { x: e.x }), ...(e.y === undefined ? {} : { y: e.y }), text: e.text, cause: e.cause, source: e.source, ...(e.death === undefined ? {} : { death: { ...e.death, previous: [...e.death.previous] } }) })),
    memories: world.memories.slice(-VIEW_MEMORIES).map(m => ({ id: m.id, title: m.title, text: m.text, source: m.source, placeId: m.placeId })),
    animals: projected.animals, structures: projected.structures, blueprints: carry ? undefined : world.blueprints.map(b=>({id:b.id,name:b.name,components:[...b.components],generation:b.generation,parents:[...b.parents],inventorId:b.inventorId,tick:b.tick,uses:b.uses,usefulness:b.usefulness,cost:{wood:b.cost.wood,stone:b.cost.stone,work:b.cost.work}})),
    stats: carry ? undefined : worldStatistics(world), communities: world.communities.map(c => ({ id: c.id, name: c.name, x: c.x, y: c.y, color: c.color, members: c.members.filter(id=>visibleIds.has(id)), memberCount: c.members.length, culture: { ...c.culture }, formedAt: c.formedAt, cooperation: c.cooperation, disputes: c.disputes })),
    technology: carry ? undefined : projectTechnology(world, peopleInView), organization: carry ? undefined : (({ resources: _resources, ...summary }) => structuredClone(summary))(organization!.value),
    ...(world.chemistry && !carry ? { chemistry: projectChemistry(world) } : {}),
    ...(world.whispers?.length ? { whispers: world.whispers.map(whisperView) } : {}),
    demography: {deaths:world.demographyDynamics.deaths,causes:{...world.demographyDynamics.causes},recent:world.legacy.slice(0,32).map(p=>({id:p.id,name:p.name,generation:p.generation,parents:[...p.parents],bornAt:p.bornAt,diedAt:p.diedAt,cause:p.cause}))},
  };
  if (carry) for (const field of CARRIED_VIEW_FIELDS) delete (view as unknown as Record<string, unknown>)[field];
  return view;
}


import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { serialize } from 'node:v8';
import { createApp, HttpError } from './app.js';
import { Store } from './store.js';
import { setParams } from '../world/params.js';
import { ResidentTopologyOwner, residentBackingArray, residentTileRevision, residentTopologyToken, sameResidentTopology } from '../world/soa/topologia.js';
import { residentSnapshotGate } from '../world/soa/terreno.js';
import { gpuParitySession } from '../world/gpu/autoprueba.js';
import { deploymentParams } from './deployment-params.js';
import { hostFullHardwareParams, hostOpenWorldParams, hostParams } from './hardware-limits.js';
import { resumenDespacho } from './resumen-vivo.js';
import { readWorldInstance } from './world-instance.js';
import { projectAnimal } from '../world/animals.js';
import { tapePathForWorld, tileEqual } from './tape-store.js';
import { CARRIED_VIEW_FIELDS, type TapeWorkerRequest, type TapeWorkerReply } from './tape-worker.js';
import { TAPE_KEYFRAME_INTERVAL } from '../shared/tape.js';
import type { AppOptions } from './app.js';
import type { Gesture, RuntimeStats } from '../shared/types.js';
import type { Chunk } from '../world/terrain.js';

export interface SimWorkerOptions {
  worldPath: string;
  seed?: number;
  params?: Exclude<AppOptions['params'], Function>;
  tickMs?: number;
  /** Main's deployment policy, evaluated ONLY inside the simulation worker. */
  deployment?: boolean;
  /** Test-only synchronous block, deliberately occupying the worker event loop. */
  testStepDelayMs?: number;
  /** V21: uncapped loop (`tickMs = 0`, a step per `setImmediate`); the live mirror is throttled to
   * `TURBO_MIRROR_MS` while the tape still records every tick. */
  turbo?: boolean;
  turboSaveIntervalMs?: number;
  /** V21: record every step in the DVR tape (`tapePathForWorld(worldPath)`). Defaults to `turbo`. */
  tape?: boolean;
  tapeMaxFrames?: number;
  tapeKeyframeInterval?: number;
  /** V21: inhabitants act autonomously; direct NPC orders are rejected. */
  observerOnly?: boolean;
}
export interface SessionMirror { hash: string; expires: number; validity: SharedArrayBuffer; }
export type MirrorPageField = 'people' | 'places' | 'animals' | 'structures' | 'blueprints' | 'communities'
  | 'technology.items' | 'technology.recipes' | 'technology.knowledge' | 'pendingChunks';
export interface MirrorUpdate {
  type: 'mirror';
  view: WorldView;
  seed: number;
  cuencas: number;
  activeKeys: string[];
  activeChunks: World['chunks'];
  chunks: { key: string; data: Uint8Array }[];
  /** Retired chunks first posted in this update (`pendingChunks` pages). */
  pendingChunks: Chunk[];
  /** V24: keys of every retired chunk still pending an archive; earlier posts carried their contents. */
  pendingKeys: string[];
  pages: { field: MirrorPageField; data: Uint8Array }[];
  deltas: boolean;
  failed: boolean;
  respaldo: unknown;
  publishMs: number;
  /** V24: 4×4 minimap palette summary of every chunk page in this post (`/api/worldmap`). */
  minimap?: { key: string; cells: string }[];
}
export type SimRpc = { type: 'rpc'; id: number; method: string; args: unknown[] };
export type SimReply = { type: 'reply'; id: number; value?: unknown; error?: { status: number; message: string } };
function packed(value: unknown): Uint8Array<ArrayBuffer> {
  // Own transferable storage, never a pooled Buffer (which would clone the entire slab).
  return Uint8Array.from(serialize(value));
}

export interface TileObservation {
  /** Public projection of every resident tile, grouped by 16×16 chunk in resident order. Owned by the
   * observer and updated in place by later scans: consume (copy, serialize, post) before the next scan. */
  chunks: ReadonlyMap<string, readonly Tile[]>;
  /** Projected tiles whose public value changed since the previous scan (every tile when `force`), in chunk order. */
  changed: Tile[];
  /** Chunks holding at least one `changed` tile. */
  dirty: ReadonlySet<string>;
  /** A new world, tile store or resident epoch: nothing of the previous scan is comparable. */
  force: boolean;
}

/** Independent per-observer change tracker over the resident tiles that keeps their public projection.
 * Never drains the TileStore's change channel: revisions and the SAB gate are read-only stamps.
 *
 * V24: a tile is re-projected only when its revision moved, or the parallel kernel stamped its SoA slot,
 * and it is reported only when that projection differs from the cached one (`tileEqual`, the tape's own
 * equality). The 16×16 grouping is rebuilt only when the resident set changes (another tile object or
 * coordinates at some slot). A scan with nothing written is one allocation-free pass over the slots. */
export function createTileObserver() {
  let lastWorld: World | undefined;
  let lastGate: ReturnType<typeof residentSnapshotGate>;
  let lastGateSerial = 0;
  let lastToken: ReturnType<typeof residentTopologyToken>;
  let slotTiles: Tile[] = [], slotX = new Float64Array(0), slotY = new Float64Array(0), slotRevision = new Float64Array(0);
  let slotChunk = new Int32Array(0), slotIndex = new Int32Array(0), changedFlag = new Uint8Array(0);
  let chunkKeys: string[] = [], chunkSlots: Int32Array[] = [], chunkTiles: Tile[][] = [];
  let chunks = new Map<string, Tile[]>();
  /** Rebuilds the grouping. A tile object that survives at the same coordinates keeps its revision and
   * projection; the previous projections by coordinate let a replaced tile object report only real changes. */
  function regroup(raw: readonly Tile[]): Map<string, Tile> {
    const previous = new Map<string, Tile>(), survivors = new Map<Tile, number>();
    for (const tiles of chunkTiles) for (const tile of tiles) if (tile) previous.set(`${tile.x},${tile.y}`, tile);
    for (let j = 0; j < slotTiles.length; j++) survivors.set(slotTiles[j]!, j);
    const old = { slotX, slotY, slotRevision, slotChunk, slotIndex, chunkTiles };
    const n = raw.length, index = new Map<string, number>(), members: number[][] = [];
    slotTiles = raw.slice(); slotX = new Float64Array(n); slotY = new Float64Array(n); slotRevision = new Float64Array(n).fill(NaN);
    slotChunk = new Int32Array(n); slotIndex = new Int32Array(n); changedFlag = new Uint8Array(n);
    chunkKeys = [];
    const carried: (Tile | undefined)[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const tile = raw[i]!, x = tile.x, y = tile.y, key = `${Math.floor(x / 16)},${Math.floor(y / 16)}`;
      let c = index.get(key);
      if (c === undefined) { c = chunkKeys.length; index.set(key, c); chunkKeys.push(key); members.push([]); }
      slotX[i] = x; slotY[i] = y; slotChunk[i] = c; slotIndex[i] = members[c]!.length; members[c]!.push(i);
      const j = survivors.get(tile);
      if (j !== undefined && old.slotX[j] === x && old.slotY[j] === y) {
        slotRevision[i] = old.slotRevision[j]!; carried[i] = old.chunkTiles[old.slotChunk[j]!]![old.slotIndex[j]!];
      }
    }
    chunkSlots = members.map(list => Int32Array.from(list));
    chunkTiles = members.map(list => list.map(i => carried[i]!));
    chunks = new Map(chunkKeys.map((key, c) => [key, chunkTiles[c]!]));
    return previous;
  }
  return {
    scan(world: World): TileObservation {
      const gate = residentSnapshotGate(world.tiles);
      const raw = residentBackingArray(world.tiles);
      const fast = residentFastAccess(world.tiles);
      const force = lastWorld !== world || gate?.identity !== lastGate?.identity || gate?.epoch !== lastGate?.epoch;
      const parallelChanged = !!gate && gate.serial !== lastGateSerial;
      // The owner's topology token moves on any array write or coordinate write: with it unchanged the
      // resident set is the one already grouped, without touching each tile (Proxy reads are not free).
      const token = residentTopologyToken(world.tiles as Tile[]);
      let same = !force && raw.length === slotTiles.length;

      if (same && !sameResidentTopology(token, lastToken)) for (let i = 0; same && i < raw.length; i++) {
        const tile = raw[i]!;
        if (tile !== slotTiles[i] || tile.x !== slotX[i] || tile.y !== slotY[i]) same = false;
      }
      const previous = same ? undefined : regroup(raw);
      let any = false;
      for (let i = 0; i < raw.length; i++) {
        const tile = raw[i]!;
        // `undefined` (an unobserved tile) never equals the remembered NaN: re-projected every scan, as before.
        const revision = residentTileRevision(tile) ?? NaN;
        const cached = chunkTiles[slotChunk[i]!]![slotIndex[i]!];
        // The SAB stamp covers kernel/ecology writes which bypass the JS setters.
        const moved = revision !== slotRevision[i];
        if (cached && !moved && !(parallelChanged && gate!.stampOfTile(tile) > lastGateSerial)) continue;
        slotRevision[i] = revision;
        const cell = cached && !moved && fast ? fast.cellOf(tile) : -1;
        // Stamped only: the object-held fields cannot have moved; compare the shared-array ones first.
        if (cell >= 0 && !force && soaFieldsEqual(cached!, fast!, cell)) continue;
        const projected = cell >= 0 ? refreshSoaTile(cached!, fast!, cell) : projectMirrorTile(tile, fast);
        const before = cached ?? previous?.get(`${projected.x},${projected.y}`);
        if (!force && before && tileEqual(before, projected)) { if (!cached) chunkTiles[slotChunk[i]!]![slotIndex[i]!] = before; continue; }
        chunkTiles[slotChunk[i]!]![slotIndex[i]!] = projected;
        changedFlag[i] = 1; any = true;
      }
      const changed: Tile[] = [], dirty = new Set<string>();
      if (any) for (let c = 0; c < chunkSlots.length; c++) {
        const slots = chunkSlots[c]!;
        for (let j = 0; j < slots.length; j++) if (changedFlag[slots[j]!]) {
          changedFlag[slots[j]!] = 0; changed.push(chunkTiles[c]![j]!); dirty.add(chunkKeys[c]!);
        }
      }
      lastWorld = world; lastGate = gate; lastGateSerial = gate?.serial ?? 0; lastToken = token;
      return { chunks, changed, dirty, force };
    },
  };
}

/**
 * Full-population DVR projection (no private fields), plus the caller's changed/resident tiles.
 * Consume before the next step: postMessage makes the single cross-thread copy, while the
 * same-thread app's TapeWriter copies its input synchronously inside record().
 * Fast-drifting continuous body telemetry is quantized to 2 decimals (animal age to 20-tick buckets)
 * so resting inhabitants and hundreds of grazing fauna don't rewrite unchanged entities on every delta
 * tick. `carry` leaves out `CARRIED_VIEW_FIELDS` for the tape writer to carry over.
 */
export function projectTapeFrame(world: World, runtime: RuntimeStats, instanceId: string | undefined, tiles: Tile[], carry = false): WorldView {
  const view = projectMirror(world, worldContext(world), { quantize: true, carry });
  if (instanceId !== undefined) view.instanceId = instanceId;
  view.performance = { ...runtime, ...(runtime.gobernador ? { gobernador: { ...runtime.gobernador } } : {}) };
  // Consume synchronously: postMessage clones the live structures exactly once before the next step.
  view.tiles = tiles;
  return view;
}

/** Ticks at which a tape frame carries every resident tile instead of only the changed chunks. */
export function tapeKeyframeDue(tick: number, interval: number | undefined, first: boolean): boolean {
  return first || tick % Math.max(1, interval ?? TAPE_KEYFRAME_INTERVAL) === 0;
}

/** Minimum spacing between live mirror posts while the turbo loop runs uncapped. */
export const TURBO_MIRROR_MS = 250;

async function runSimulation(options: SimWorkerOptions) {
  const port = parentPort!;
  const store = new Store(options.worldPath);
  let app: ReturnType<typeof createApp> | undefined;
  let closing = false;
  const sessionFlags = new Map<string, Int32Array>();
  const realSessionValid = store.sessionValid.bind(store);
  store.sessionValid = hash => (!sessionFlags.has(hash) || Atomics.load(sessionFlags.get(hash)!, 0) === 1) && realSessionValid(hash);
  const initialSessions = (store.db.prepare('SELECT hash,expires FROM sessions WHERE expires>?').all(Date.now()) as { hash: string; expires: number }[])
    .map(row => { const validity = new SharedArrayBuffer(4); const flag = new Int32Array(validity); flag[0] = 1; sessionFlags.set(row.hash, flag); return { ...row, validity }; });
  const observer = createTileObserver();
  const turbo = !!options.turbo || options.tickMs === 0;
  const tapeEnabled = options.tape ?? turbo;
  let tapeWorker: Worker | undefined;
  let tapeClosed = false;
  let tapeError: Error | undefined;
  let inFlightFrames = 0;
  let tapeRequestId = 0;
  type TapeResult = { frames: number; latestTick: number };
  const tapeCalls = new Map<number, { resolve(value: TapeResult): void; reject(error: Error): void }>();
  let tapeExited: Promise<void> | undefined;
  let firstTapeFrame = true;
  /** Latest tick a reopened tape already holds: the writer drops frames up to it (append-only), so they are
   * not even projected, and the first frame it DOES accept must be a full keyframe (it has no base yet). */
  let tapeLatestTick = -1;
  let lastSimHz = 0;
  /** Chunks changed since the last mirror post (turbo accumulates across throttled ticks). */
  const unpostedChunks = new Set<string>();
  /** Retired chunks already posted to the gateway (they never change until a save archives them). */
  const postedRetired = new WeakSet<Chunk>();
  let lastPostAt = -Infinity;
  let previousPaused = false;
  function failTape(error: Error) {
    if (tapeError) return;
    tapeError = error;
    inFlightFrames = 0;
    for (const call of tapeCalls.values()) call.reject(error);
    tapeCalls.clear();
    port.postMessage({ type: 'log', level: 'warn', value: { cinta: 'detenida', motivo: error.message } });
  }
  function tapeCommand(type: 'flush' | 'close'): Promise<TapeResult> {
    if (tapeError) return Promise.reject(tapeError);
    if (!tapeWorker) return Promise.resolve({ frames: 0, latestTick: -1 });
    const id = ++tapeRequestId;
    return new Promise((resolve, reject) => {
      tapeCalls.set(id, { resolve, reject });
      try { tapeWorker!.postMessage({ type, id } satisfies TapeWorkerRequest); }
      catch (error) { tapeCalls.delete(id); reject(error); }
    });
  }
  async function closeTape() {
    if (!tapeWorker || tapeClosed) return;
    tapeClosed = true;
    try { await tapeCommand('close'); await tapeExited; }
    finally { if (tapeError) await tapeWorker.terminate(); }
  }
  let instanceId: string | undefined;
  function publish({ forcePost = false, record = true }: { forcePost?: boolean; record?: boolean } = {}) {
    const live = app!;
    // A failed in-place step must NEVER leak its partially mutated world into the mirror (nor the tape).
    if (live.failed) {
      if (!previousPaused) { previousPaused = true; port.postMessage({ type: 'paused' }); }
      return;
    }
    const world = live.world;
    // The world's identity never changes under its single writer: read once, not per (turbo) tick.
    instanceId ??= readWorldInstance(store.db)!;
    const now = performance.now();
    const recording = record && !!tapeWorker && !tapeClosed && !tapeError && world.tick > tapeLatestTick;
    const keyframe = recording && tapeKeyframeDue(world.tick, options.tapeKeyframeInterval, firstTapeFrame);
    let postDue = !turbo || forcePost || now - lastPostAt >= TURBO_MIRROR_MS;
    // V24 turbo: the terrain and the slow summaries are sampled at the live mirror's cadence (and on every
    // keyframe); the frames between them still record every inhabitant, animal, work and event of their tick.
    const refresh = postDue || keyframe;
    let observation: TileObservation | undefined;
    if (refresh) {
      observation = observer.scan(world);
      for (const key of observation.dirty) unpostedChunks.add(key);
      if (observation.force) postDue = true;
    }
    let frame: WorldView | undefined;
    if (recording) {
      // Every tick reaches the tape, even when the live mirror is throttled. A delta frame carries only
      // the tiles whose public value changed; a keyframe, every resident tile.
      let tiles: Tile[] = observation?.changed ?? [];
      if (keyframe) { tiles = []; for (const chunk of observation!.chunks.values()) for (const tile of chunk) tiles.push(tile); }
      frame = projectTapeFrame(world, live.runtime, instanceId, tiles, !refresh);
      try {
        tapeWorker!.postMessage({ type: 'record', view: frame, simHz: lastSimHz,
          partialTiles: !keyframe, ...(refresh ? {} : { carried: true as const }) } satisfies TapeWorkerRequest);
        inFlightFrames++;
        firstTapeFrame = false;
      } catch (error) {
        // A DVR is an observer: it never pauses the world. It stops recording and says so once.
        failTape(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!postDue) return;
    lastPostAt = now;
    const updates: MirrorUpdate['chunks'] = [];
    const minimap: NonNullable<MirrorUpdate['minimap']> = [];
    const transfers: ArrayBuffer[] = [];
    const chunks = observation!.chunks;
    for (const key of unpostedChunks) {
      // A chunk that changed and then left the resident set before this post is no longer a page.
      const tiles = chunks.get(key);
      if (!tiles) continue;
      const data = packed(tiles);
      updates.push({ key, data }); transfers.push(data.buffer as ArrayBuffer);
      const comma = key.indexOf(',');
      minimap.push({ key, cells: encodeChunkMinimapCells(tiles, Number(key.slice(0, comma)), Number(key.slice(comma + 1))) });
    }
    unpostedChunks.clear();
    // The tape frame is reused as the mirror's base; only this shallow copy is emptied into pages.
    const base = frame ?? projectMirrorWorld(world, undefined, worldContext(world));
    const view: WorldView = { ...base, tiles: [], instanceId, performance: live.runtime,
      ...(base.technology ? { technology: { ...base.technology } } : {}) };
    const pages: MirrorUpdate['pages'] = [];
    function packPages(field: MirrorPageField, values: readonly unknown[], count = 64) {
      for (let offset = 0; offset < values.length; offset += count) {
        const data = packed(values.slice(offset, offset + count));
        pages.push({ field, data }); transfers.push(data.buffer as ArrayBuffer);
      }
    }
    // No large structured clones in postMessage, nor a monolithic decode on the HTTP loop.
    // The receiver builds the next immutable mirror in bounded turns, serving the old one meanwhile.
    for (const field of ['people', 'places', 'animals', 'structures', 'blueprints', 'communities'] as const) {
      const values = view[field];
      if (values) { packPages(field, values); view[field] = []; }
    }
    if (view.technology) {
      for (const field of ['items', 'recipes', 'knowledge'] as const) {
        const values = view.technology[field];
        if (values) { packPages(`technology.${field}`, values); view.technology[field] = []; }
      }
    }
    // A retired chunk is an immutable snapshot until a save archives it: each one crosses once, and
    // every post names the keys still pending so the gateway drops the archived ones.
    for (const chunk of world.retiredChunks) {
      if (postedRetired.has(chunk)) continue;
      postedRetired.add(chunk);
      // Resident tile proxies must never be passed to structuredClone/v8.serialize.
      packPages('pendingChunks', [{ ...chunk, tiles: chunk.tiles.map(tile => ({ ...tile })) }], 1);
    }
    const update: MirrorUpdate = { type: 'mirror', view, seed: world.seed, cuencas: paramsOf(world).agua.cuencas,
      activeKeys: Object.keys(world.chunks), activeChunks: world.chunks, chunks: updates, pendingChunks: [], pendingKeys: world.retiredChunks.map(chunk => chunk.key), pages,
      deltas: paramsOf(world).red.deltas, failed: false, respaldo: live.respaldo, publishMs: 0, minimap };
    // Terrain preparation stays OFF the HTTP thread. Chunk buffers move, rather than cloning
    // hundreds of thousands of Tile objects on every postMessage.
    const started = performance.now();
    port.postMessage(update, transfers);
    port.postMessage({ type: 'published', ms: performance.now() - started });
  }
  try {
    const base = () => process.env.CARTA_OPEN_WORLD === '1' ? hostOpenWorldParams()
      : process.env.CARTA_FULL_HARDWARE === '1' ? hostFullHardwareParams() : hostParams();
    app = createApp({ store, password: 'worker-private-unused-credential', origin: 'http://127.0.0.1',
      manual: true, seed: options.seed, tickMs: turbo ? 0 : options.tickMs, turbo, observerOnly: options.observerOnly,
      // publish sends to the dedicated writer thread; the inner app must not open another writer.
      tape: false,
      turboSaveIntervalMs: options.turboSaveIntervalMs,
      params: options.deployment ? () => deploymentParams(base()) : options.params,
      beforeStep: () => {
        if (inFlightFrames >= 64) return false;
        if (options.testStepDelayMs) {
          port.postMessage({ type: 'step-blocked', tick: app!.world.tick });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.testStepDelayMs);
        }
      },
      // A step that applied a Mensaje Divino posts the mirror at once (and still records its frame).
      afterStep: simHz => { lastSimHz = simHz; publish({ forcePost: app!.susurrosEnUltimoPaso }); } });
    if (options.deployment) setParams(app.world, deploymentParams(paramsOf(app.world)));
    const motor = paramsOf(app.world).motor;
    if ((motor.hilos > 1 || motor.gpu.length > 0) && !worldContext(app.world).tileOwnership) {
      const tileOwnership = new ResidentTopologyOwner();
      app.world.tiles = tileOwnership.tiles(app.world.tiles.map(t => tileOwnership.tile(t)));
      bindWorldContext(app.world, { ...worldContext(app.world), tileOwnership });
    }
    for (const device of motor.gpu) {
      const parity = await gpuParitySession.initialize(device, { budgetMs: 5000, log: diagnostic => port.postMessage({ type: 'log', level: 'warn', value: diagnostic }) });
      port.postMessage({ type: 'log', level: 'info', value: { gpuAutoprueba: parity, v15: resumenDespacho(app.world) } });
    }
    if (motor.gpu.length === 0) port.postMessage({ type: 'log', level: 'info', value: { gpuAutoprueba: null, v15: resumenDespacho(app.world) } });
    if (tapeEnabled) {
      let moduleURL = new URL('./tape-worker.js', import.meta.url);
      const sourceLoader = new URL(import.meta.url).pathname.endsWith('.ts');
      if (sourceLoader && !existsSync(moduleURL)) moduleURL = new URL('./tape-worker.ts', import.meta.url);
      tapeWorker = new Worker(`
        const { workerData } = require('node:worker_threads');
        (async () => {
          if (workerData.loaderURL) (await import(workerData.loaderURL)).register();
          await import(workerData.moduleURL);
        })().catch(error => { setImmediate(() => { throw error; }); });
      `, { eval: true, execArgv: [], name: 'carta-tape', workerData: {
        role: 'carta-tape', moduleURL: moduleURL.href,
        loaderURL: sourceLoader ? import.meta.resolve('tsx/esm/api') : undefined,
        options: { path: tapePathForWorld(options.worldPath), maxFrames: options.tapeMaxFrames,
          keyframeInterval: options.tapeKeyframeInterval },
      } });
      tapeWorker.on('message', (message: TapeWorkerReply) => {
        if (message.type === 'ack') inFlightFrames--;
        else {
          tapeCalls.get(message.id)?.resolve({ frames: message.frames, latestTick: message.latestTick });
          tapeCalls.delete(message.id);
        }
      });
      tapeWorker.on('error', failTape);
      tapeExited = new Promise(resolve => tapeWorker!.once('exit', code => {
        if (!tapeClosed || code !== 0 || tapeCalls.size) failTape(new Error(`Tape worker exited (code ${code}).`));
        resolve();
      }));
    }
    tapeLatestTick = (await tapeCommand('flush')).latestTick;
    publish({ forcePost: true });
    // The gateway opens its read-only TapeReader on `ready`: the initial frame must already be durable.
    await tapeCommand('flush');
    port.on('message', (message: SimRpc) => { void handle(message); });
    port.postMessage({ type: 'ready', sessions: initialSessions });
  } catch (error) {
    try { await app?.close(); } finally { try { await closeTape(); } finally { store.close(); } }
    throw error;
  }
  async function handle(message: SimRpc) {
    if (message.type !== 'rpc') return;
    const { id, method, args } = message;
    try {
      if (closing) throw new HttpError(503, 'El servicio se está cerrando.');
      let value: unknown;
      switch (method) {
        case 'start': app!.start(); break;
        case 'login': {
          const [hash, expires, validity] = args as [string, number, SharedArrayBuffer];
          store.addSession(hash, expires); sessionFlags.set(hash, new Int32Array(validity)); break;
        }
        case 'logout': { const hash = args[0] as string; store.revoke(hash); sessionFlags.delete(hash); break; }
        case 'verifySession': value = store.sessionValid(args[0] as string); break;
        case 'gesture': value = await app!.requestGesture(args[0] as Gesture, args[1] as string); break;
        case 'personDetail': {
          if (app!.failed) throw new HttpError(503, 'El mundo está en pausa.');
          value = enriquecerPersona(app!.world, args[0] as string) ?? null; break;
        }
        case 'recipeDetail': {
          if (app!.failed) throw new HttpError(503, 'El mundo está en pausa.');
          value = technologyRecipeDetail(app!.world, args[0] as string) ?? null; break;
        }
        case 'whisper': {
          // V24 Mensajes Divinos: allowed in observer-only worlds (an inhabitant hears them later, never an order).
          if (app!.failed) throw new HttpError(503, 'El mundo está en pausa.');
          let request: DivineWhisperRequest;
          try { request = parseWhisperRequest(args[0]); }
          catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Mensaje divino no válido.'); }
          // Applied by the next step and confirmed after its save (session checked there too). That step
          // posts the live mirror (`afterStep`) before this reply on the same FIFO port.
          value = await app!.requestWhisper(request, args[1] as string);
          break;
        }
        case 'flushTape':
          value = { enabled: !!tapeWorker && !tapeClosed && !tapeError, ...await tapeCommand('flush') };
          break;
        case 'shutdown':
          closing = true;
          try {
            await app!.close();
            if (!app!.failed) {
              // Turbo throttles the mirror: the last steps reach the gateway before it goes away.
              if (turbo) publish({ forcePost: true, record: false });
            }
          } finally { try { await closeTape(); } finally { store.close(); } }
          break;
        default: throw new HttpError(400, 'RPC desconocido.');
      }
      port.postMessage({ type: 'reply', id, value } satisfies SimReply);
      if (method === 'shutdown') port.close();
    } catch (error) {
      port.postMessage({ type: 'reply', id, error: { status: error instanceof HttpError ? error.status : 503,
        message: error instanceof HttpError ? error.message : 'El servicio no pudo completar la solicitud.' } } satisfies SimReply);
      if (method === 'shutdown') port.close();
    }
  }
}
import { enriquecerPersona } from './persona-extra.js';
import { technologyRecipeDetail } from '../world/technology.js';
if (!isMainThread && workerData?.role === 'carta-sim') await runSimulation(workerData.options);
