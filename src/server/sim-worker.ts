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
 * con `?? 0`. Las magnitudes del terreno viajan siempre, porque ahí un cero es un dato. Se asignan
 * directamente (sin objetos ni spreads intermedios por tesela). */
export function projectMirrorTile(t: ReturnType<typeof projectTerrain>['tiles'][number], fast?: ResidentFastAccess): Tile {
  const cell = fast ? fast.cellOf(t as Tile) : -1;
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
    if (typeof t.paved === 'number' && t.paved !== 0) out.paved = r3(t.paved);
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
export function projectMirrorWorld(world: World, viewport?: Viewport, context: WorldContext = worldContext(world)): WorldView {
  bindWorldContext(world, context);
  const projected = { tiles: [], places: world.places, animals: world.animals.map(a => projectAnimal(a, world.tick)), structures: world.structures }, v = { x: 0, y: 0, width: 40, height: 28 };
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
  const visible = (_p: { x: number; y: number }, _margin: number): boolean => true;
  const peopleInView = world.people.filter(p => visible(p, 1));
  const visibleIds = new Set(peopleInView.map(p => p.id));
  // Solo viajan los planos que referencia alguna estructura visible; el resto se pide a demanda.
  const referencedBlueprintIds = new Set(projected.structures.map(s => s.blueprintId).filter((id): id is string => typeof id === 'string'));
  const fastTiles = residentFastAccess(world.tiles);
  return {
    version: PROTOCOL_VERSION, sequence: world.tick, tick: world.tick, geologyKey: publicGeologyKey(world.seed), day: Math.floor(world.tick / TICKS_PER_DAY) + 1,
    phase: phaseAt(world.tick), weather: world.weather, width: v.width, height: v.height,
    originX: v.x, originY: v.y, infinite: true, activeChunks: Object.keys(world.chunks).length, discoveredChunks: world.discoveredChunks, settlementCount: world.settlementCount,
    tiles: projected.tiles.map(t => projectMirrorTile(t, fastTiles)),
    people: peopleInView.map((p): PersonView => {
      const life = demographicTraits(p.genome, cuerpo);
      return { id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, color: p.color, action: p.action, reason: p.reason, energy: p.energy, hunger: p.hunger, fatigue: p.fatigue, thirst: p.thirst, need: p.need, recentMemory: p.recentMemory, traits: { ...p.traits }, skills: { ...p.skills }, materials: { ...p.materials }, specialty: specialty(p), controlMode: p.controlMode, blueprintId:p.blueprintId??null,
      target: { x:p.target.x,y:p.target.y }, foodReserve:p.inventory, foodReserveCapacity:0.25, working: !!p.technology.waterPreparation || WORKING_ACTIONS.has(p.action) && distance(p,p.target)<0.5,
      workProgress: p.technology.waterPreparation ? clamp(((p.technology.items.find(item => item.id === p.technology.waterPreparation!.itemId)?.contents?.water ?? 0) - p.technology.waterPreparation.initialQuanta) / (p.technology.waterPreparation.targetQuanta - p.technology.waterPreparation.initialQuanta))
        : PROJECT_ACTIONS.has(p.action) ? (p.technology.project ? clamp(p.technology.project.progress/p.technology.project.requiredWork) : 0) : clamp(p.work / (p.action==='build'?constructionCost(world,p).work:p.action==='invent'?60:p.action==='repair'?30:SKILLED_ACTIONS.has(p.action)?Math.ceil(45*(1-(p.skills[p.action]??0)*0.25)):Math.ceil(18*(1-(p.skills[p.action]??0)*0.25)))),
      health:p.demography.health,vitality:p.demography.vitality,continuityProtected:p.role!=='neighbor',
      lifeStage: p.demography.age < life.maturityAge ? 'juvenile' : p.demography.age < life.senescenceStart ? 'adult' : 'senescent',
      genome: { generation: p.genome.generation, parents: [...p.genome.parents], learningRate: p.genome.learningRate, cooperation: p.genome.cooperation, mutations: p.genome.mutations }, age: world.tick - p.bornAt, communityId: p.communityId, culture: { ...p.culture },
      ...(p.compounds?.length ? { compounds: p.compounds.map(c => ({ ...c, composition: { ...c.composition }, properties: { ...c.properties } })) } : {}) };
    }),
    places: projected.places.map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, description: p.description, gatherings: p.gatherings })), events: world.events.slice(-VIEW_EVENTS).map(e => ({ id: e.id, tick: e.tick, kind: e.kind, actors: [...e.actors], ...(e.x === undefined ? {} : { x: e.x }), ...(e.y === undefined ? {} : { y: e.y }), text: e.text, cause: e.cause, source: e.source, ...(e.death === undefined ? {} : { death: { ...e.death, previous: [...e.death.previous] } }) })),
    memories: world.memories.slice(-VIEW_MEMORIES).map(m => ({ id: m.id, title: m.title, text: m.text, source: m.source, placeId: m.placeId })),
    animals: projected.animals, structures: projected.structures, blueprints: world.blueprints.map(b=>({id:b.id,name:b.name,components:[...b.components],generation:b.generation,parents:[...b.parents],inventorId:b.inventorId,tick:b.tick,uses:b.uses,usefulness:b.usefulness,cost:{wood:b.cost.wood,stone:b.cost.stone,work:b.cost.work}})),
    stats: worldStatistics(world), communities: world.communities.map(c => ({ id: c.id, name: c.name, x: c.x, y: c.y, color: c.color, members: c.members.filter(id=>visibleIds.has(id)), memberCount: c.members.length, culture: { ...c.culture }, formedAt: c.formedAt, cooperation: c.cooperation, disputes: c.disputes })),
    technology: projectTechnology(world, peopleInView), organization: (({ resources: _resources, ...summary }) => structuredClone(summary))(organization.value),
    ...(world.chemistry ? { chemistry: projectChemistry(world) } : {}),
    demography: {deaths:world.demographyDynamics.deaths,causes:{...world.demographyDynamics.causes},recent:world.legacy.slice(0,32).map(p=>({id:p.id,name:p.name,generation:p.generation,parents:[...p.parents],bornAt:p.bornAt,diedAt:p.diedAt,cause:p.cause}))},
  };
}


import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { serialize } from 'node:v8';
import { createApp, HttpError } from './app.js';
import { Store } from './store.js';
import { setParams } from '../world/params.js';
import { ResidentTopologyOwner, residentBackingArray, residentTileRevision } from '../world/soa/topologia.js';
import { residentSnapshotGate } from '../world/soa/terreno.js';
import { gpuParitySession } from '../world/gpu/autoprueba.js';
import { deploymentParams } from './deployment-params.js';
import { hostFullHardwareParams, hostOpenWorldParams, hostParams } from './hardware-limits.js';
import { resumenDespacho } from './resumen-vivo.js';
import { readWorldInstance } from './world-instance.js';
import { projectAnimal } from '../world/animals.js';
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
  pendingChunks: Chunk[];
  pages: { field: MirrorPageField; data: Uint8Array }[];
  deltas: boolean;
  failed: boolean;
  respaldo: unknown;
  publishMs: number;
}
export type SimRpc = { type: 'rpc'; id: number; method: string; args: unknown[] };
export type SimReply = { type: 'reply'; id: number; value?: unknown; error?: { status: number; message: string } };
function packed(value: unknown): Uint8Array<ArrayBuffer> {
  // Own transferable storage, never a pooled Buffer (which would clone the entire slab).
  return Uint8Array.from(serialize(value));
}

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
  const revisions = new WeakMap<Tile, number | undefined>();
  let previousKeys = new Set<string>(), lastWorld: World | undefined;
  let lastGate: ReturnType<typeof residentSnapshotGate>;
  let lastGateSerial = 0;
  let previousPaused = false;
  function publish() {
    const live = app!;
    // A failed in-place step must NEVER leak its partially mutated world into the mirror.
    if (live.failed) {
      if (!previousPaused) { previousPaused = true; port.postMessage({ type: 'paused' }); }
      return;
    }
    const world = live.world, gate = residentSnapshotGate(world.tiles);
    const raw = residentBackingArray(world.tiles);
    const changed = new Set<string>();
    const chunks = new Map<string, Tile[]>();
    const force = lastWorld !== world || gate?.identity !== lastGate?.identity || gate?.epoch !== lastGate?.epoch;
    const parallelChanged = !!gate && gate.serial !== lastGateSerial;
    for (const tile of raw) {
      const key = `${Math.floor(tile.x / 16)},${Math.floor(tile.y / 16)}`;
      let chunk = chunks.get(key);
      if (!chunk) { chunk = []; chunks.set(key, chunk); }
      chunk.push(tile);
      const revision = residentTileRevision(tile);
      // This is an independent observer. Never drain the TileStore's change channel.
      // The SAB stamp covers kernel/ecology writes which bypass the JS setters.
      if (force || !previousKeys.has(key) || revision === undefined || revisions.get(tile) !== revision
        || parallelChanged && gate!.stampOfTile(tile) > lastGateSerial) changed.add(key);
      revisions.set(tile, revision);
    }
    const fast = residentFastAccess(world.tiles);
    const updates: MirrorUpdate['chunks'] = [];
    const transfers: ArrayBuffer[] = [];
    for (const key of changed) {
      const data = packed(chunks.get(key)!.map(tile => projectMirrorTile(tile, fast)));
      updates.push({ key, data }); transfers.push(data.buffer as ArrayBuffer);
    }
    const view = projectMirrorWorld(world, undefined, worldContext(world));
    view.instanceId = readWorldInstance(store.db)!;
    view.performance = live.runtime;
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
    for (const chunk of world.retiredChunks) {
      // Resident tile proxies must never be passed to structuredClone/v8.serialize.
      packPages('pendingChunks', [{ ...chunk, tiles: chunk.tiles.map(tile => ({ ...tile })) }], 1);
    }
    const update: MirrorUpdate = { type: 'mirror', view, seed: world.seed, cuencas: paramsOf(world).agua.cuencas,
      activeKeys: Object.keys(world.chunks), activeChunks: world.chunks, chunks: updates, pendingChunks: [], pages,
      deltas: paramsOf(world).red.deltas, failed: false, respaldo: live.respaldo, publishMs: 0 };
    // Terrain preparation stays OFF the HTTP thread. Chunk buffers move, rather than cloning
    // hundreds of thousands of Tile objects on every postMessage.
    const started = performance.now();
    port.postMessage(update, transfers);
    port.postMessage({ type: 'published', ms: performance.now() - started });
    previousKeys = new Set(update.activeKeys); lastWorld = world; lastGate = gate; lastGateSerial = gate?.serial ?? 0;
  }
  try {
    const base = () => process.env.CARTA_OPEN_WORLD === '1' ? hostOpenWorldParams()
      : process.env.CARTA_FULL_HARDWARE === '1' ? hostFullHardwareParams() : hostParams();
    app = createApp({ store, password: 'worker-private-unused-credential', origin: 'http://127.0.0.1',
      manual: true, seed: options.seed, tickMs: options.tickMs,
      params: options.deployment ? () => deploymentParams(base()) : options.params,
      beforeStep: () => {
        if (options.testStepDelayMs) {
          port.postMessage({ type: 'step-blocked', tick: app!.world.tick });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.testStepDelayMs);
        }
      },
      afterStep: publish });
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
    publish();
    port.on('message', (message: SimRpc) => { void handle(message); });
    port.postMessage({ type: 'ready', sessions: initialSessions });
  } catch (error) {
    try { await app?.close(); } finally { store.close(); }
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
        case 'shutdown':
          closing = true;
          try { await app!.close(); if (!app!.failed) store.save(app!.world); }
          finally { store.close(); }
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
