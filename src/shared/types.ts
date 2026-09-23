import type { AnimalView, AnimalDynamics, BlueprintView, StructureView, InventionDynamics } from './life.js';
import type { TechnologyRecipe, TechnologyView } from './technology.js';
import type { OrganizationSummary } from './organization.js';
export type { AnimalView, AnimalDynamics, BlueprintView, StructureView, InventionDynamics } from './life.js';
export type { TechnologyRecipe, TechnologyRecipeSummary } from './technology.js';
/** 7: `TechnologyView.recipes` carries summaries; the program travels only on request.
 * 8 (T036(h)): dieta del `state`. `PersonView.experiences`, `PersonView.trust` y
 * `TechnologyView.knowledge` ya no viajan en cada instantánea: el inspector los pide con
 * `{type:'persona', id}`. Las magnitudes de tesela que valen cero se omiten, `VIEW_EVENTS` baja a 40 y
 * `organization` viaja sin el balance por recurso. Un cliente antiguo en caché debe fallar a la vista
 * en lugar de dibujar como «cero» lo que sólo está ausente.
 * 9: water projection v1 omits its fixed unit and leakage denominator. The reader
 * supplies those format constants; quantities and the water version stay explicit.
 * A cached older client must fail in the open instead of drawing missing metadata.
 * 10 (T134, FR-026): `people` is trimmed to the camera (same `visible()` as `tiles`, margin one
 * cell); census aggregates (`neighbors`, `lifeStage`, `protectedCount`) move to `stats.census`,
 * computed over the whole population, not the trimmed view. `communities[].members` carries only
 * visible members plus `memberCount`; `blueprints` carries only the ones a visible structure
 * references. A cached older client must fail in the open, not draw a partial roster as complete. */
export const PROTOCOL_VERSION = 10;
export interface Viewport { x: number; y: number; width: number; height: number; }
export type Biome = 'grassland' | 'forest' | 'desert' | 'mountain' | 'wetland' | 'ocean';
export type Terrain = 'water' | 'soil' | 'meadow' | 'shelter';
export type Feature = 'tree' | 'pine' | 'palm' | 'cactus' | 'reeds' | 'berries' | 'flowers' | 'rock' | 'clay' | 'stump' | 'spring' | 'pool' | 'none';
export type Species = 'hare' | 'deer' | 'boar' | 'fish' | 'wolf' | 'fox';
export interface Tile { x: number; y: number; terrain: Terrain; moisture: number; vegetation: number; food: number; biome?: Biome; elevation?: number; wood?: number; stone?: number; feature?: Feature; variety?: number; growth?: number; fertility?: number; cultivation?: number; traffic?: number; drinkingWater?: number; species?: Species; fauna?: number; life?: number; }
export type Action = 'explore' | 'eat' | 'forage' | 'drink' | 'hunt' | 'rest' | 'approach' | 'accompany' | 'retreat' | 'share' | 'gather' | 'farm' | 'build' | 'cooperate' | 'invent' | 'repair' | 'research' | 'craft';
export type Order = 'move' | 'explore' | 'forage' | 'gather' | 'farm' | 'build' | 'hunt' | 'drink' | 'rest' | 'cooperate' | 'invent' | 'repair' | 'research' | 'craft' | 'auto';
export interface GenomeView { generation: number; parents: string[]; learningRate: number; cooperation: number; mutations: number; }
export interface PersonView {
  id: string; name: string; role: 'S' | 'I' | 'neighbor'; x: number; y: number;
  color: string; action: Action; reason: string;
  energy: number; hunger: number; fatigue: number; need: string;
  recentMemory: string | null; thirst?: number;
  specialty?: string; controlMode?: 'auto' | 'directed';
  traits?: { curiosity: number; sociability: number; industriousness: number; care: number; resilience: number };
  skills?: Record<string, number>; materials?: { wood: number; stone: number };
  genome?: GenomeView; age?: number;
  /** T036(h): fuera del `state`; llegan con `{type:'persona'}`. Ausente = «todavía no pedido», nunca «no tiene». */
  experiences?: { tick: number; text: string; causeId: string }[];
  communityId?: string | null; culture?: { sharing: number; stewardship: number; openness: number };
  /** T036(h): fuera del `state`; llega con `{type:'persona'}`. Ausente = «todavía no pedido», nunca «sin vínculos». */
  trust?: { id: string; value: number }[];
  blueprintId?: string | null;
  target?: { x: number; y: number }; working?: boolean; workProgress?: number;
  foodReserve?: number; foodReserveCapacity?: number;
  health?: number; vitality?: number; continuityProtected?: boolean;
  /** Server-derived inherited age thresholds; absence means unknown, not reproductive readiness. */
  lifeStage?: 'juvenile' | 'adult' | 'senescent';
}
/** T036(h): lo que el inspector pide por habitante y no viaja en cada `state`. */
export interface PersonDetail {
  id: string;
  experiences: { tick: number; text: string; causeId: string }[];
  trust: { id: string; value: number }[];
  /** Repertorio de procedimientos que recuerda; antes `TechnologyView.knowledge`. */
  recipeIds: string[];
}
export interface PlaceView { id: string; name: string; x: number; y: number; description: string; gatherings: number; }
export interface ChronicleEvent {
  id: string; tick: number; kind: 'ecology' | 'meeting' | 'care' | 'learning' | 'adaptation' | 'memory' | 'gesture' | 'pause' | 'discovery' | 'settlement' | 'cooperation' | 'birth' | 'community' | 'conflict' | 'animal' | 'invention' | 'death';
  actors: string[]; text: string; cause: string; x?: number; y?: number; source: 'simulation' | 'sample' | 'approved';
  /** FR-006: only on kind 'death'. Explicit place, tick and up to 3 prior events of the same actor,
   * so the inspector can show legible context beyond the free-text `cause`. */
  death?: { cause: string; tick: number; x: number; y: number; previous: string[] };
}
export interface MemoryView { id: string; title: string; text: string; source: 'sample' | 'approved'; placeId: string; }
export interface WorldView {
  version: number; sequence: number; tick: number; day: number;
  phase: 'dawn' | 'day' | 'dusk' | 'night'; weather: 'clear' | 'rain';
  width: number; height: number; tiles: Tile[]; people: PersonView[]; places: PlaceView[];
  events: ChronicleEvent[]; memories: MemoryView[];
  paused?: boolean; pauseReason?: string;
  originX?: number; originY?: number; infinite?: boolean;
  discoveredChunks?: number; settlementCount?: number; activeChunks?: number;
  stats?: WorldStats; performance?: RuntimeStats;
  communities?: CommunityView[];
  animals?: AnimalView[]; blueprints?: BlueprintView[]; structures?: StructureView[];
  technology?: TechnologyView; organization?: OrganizationSummary;
  /** Identity of the served world; the projection omits it and the server adds it. */
  instanceId?: string;
  demography?: { deaths: number; causes: Record<string, number>; recent: { id: string; name: string; generation: number; parents: string[]; bornAt: number; diedAt: number; cause: string }[] };
}
/** `CommunityView` es a la vez la entidad interna (`World.communities`, `members` completo, sin
 * `memberCount`) y la forma que viaja por la red (T134/FR-026: `members` recortado a la cámara,
 * `memberCount` con el total real). `memberCount` queda opcional para no forzar al productor
 * interno; `projectWorld` SIEMPRE lo rellena, así que el cliente lo trata como presente. */
export interface CommunityView { id: string; name: string; x: number; y: number; color: string; members: string[]; memberCount?: number; culture: { sharing: number; stewardship: number; openness: number }; formedAt: number; cooperation: number; disputes: number; }
export interface WorldSample { tick: number; population: number; energy: number; hunger: number; fatigue: number; thirst: number; discoveries: number; settlements: number; cooperation: number; births: number; }
export interface WorldStats { population: number; meanEnergy: number; meanHunger: number; meanFatigue: number; meanThirst: number; materials: { wood: number; stone: number }; actions: Record<string, number>; biomes: Record<string, number>; features: Record<string, number>; totals: Record<string, number>; generations: Record<string, number>; history: WorldSample[]; scope: 'active-regions'; wildlife: Record<string, number>; freshWater: number; cultivatedTiles: number; trailTiles: number; animalDynamics?: AnimalDynamics; structures?: Record<string, number>; blueprints?: number; inventionDynamics?: InventionDynamics;
  /** T019/T036(e): diversidad de conducta y de oficios de la población viva (0..1 cada una). */
  diversidad?: { conducta: number; oficios: number; total: number };
  /** R1 (SC-004, T035/T036e): métricas de recursos/agua declaradas para que crucen el tipo del
   * cable (antes viajaban en runtime vía WorldStatsRecursos pero eran invisibles al cliente). */
  giniRecursosPorRegion?: number; fraccionCeldasConComida?: number;
  /** Distancia BFS media (celdas) desde tierra cargada hasta agua POTABLE conectada; centinela
   * `-1` sin ninguna fuente potable en las celdas cargadas (nunca cuenta el mar). SC-004 parte 3. */
  distanciaMediaAgua?: number;
  /** Fracción [0,1] de regiones con tierra sin ninguna celda de agua potable superficial; las
   * regiones 100% océano no cuentan. SC-004 parte 2 (objetivo ≥ 0,30). */
  regionesSinAgua?: number;
  /** T134 (FR-026): censo sobre TODA la población, ajeno al viewport de `people`. `neighbors` y
   * `identities` cuentan por rol; `lifeStage` solo suma vecinos, con `unknown` para los que no
   * tienen edad registrada; `protectedCount` son las identidades S/I (siempre protegidas por rol). */
  census?: { neighbors: number; identities: number; protectedCount: number;
    lifeStage: { juvenile: number; adult: number; senescent: number; unknown: number } }; }
/**
 * T107 (perfil por fase y fracción serial): nombres fijos de las fases medidas del paso.
 * `maintainRegions`…`muestreo` se miden dentro de `stepWorld` (`world/index.ts`); `save` y
 * `broadcast` se miden en `stepOnce` (`server/app.ts`). El clon del paso ya tiene su propio
 * campo (`cloneMs`) y queda fuera a propósito: FR-021/D21 piden la fracción serial de las
 * fases nombradas, no del `stepOnce` entero (que además incluye E/S de red).
 */
export type FaseNombre = 'maintainRegions' | 'ecologia' | 'kernel' | 'fauna' | 'personas' | 'encuentros' | 'demografia' | 'comunidades' | 'reproduccion' | 'checkpoint' | 'muestreo' | 'save' | 'broadcast';
/** `tickHz`: ritmo real medido en reloj de pared sobre los últimos pasos, no el ritmo pedido.
 * `tickHzObjetivo` (M2, opcional): el ritmo pedido (1000 / tickMs), fijado al arrancar; permite decir
 * «más lento de lo normal» sin suponer 10 Hz. Ausente = el servidor no lo informa. */
export interface RuntimeStats { stepMs: number; p95StepMs: number; saveMs: number; projectionMs: number; snapshotBytes: number; activeTiles: number; processRssMiB: number; tickHz: number; tickHzObjetivo?: number;
  /** Coste del borrador y de las leyes, separado del guardado del mismo paso. */
  cloneMs?: number; simulationMs?: number;
  /**
   * T107: ms por fase (cero cuando esa fase no corrió en el paso, p.ej. `broadcast` fuera de
   * su cadencia) y fracción de esas fases que es serial **por diseño** (fases 0/D/E de
   * `plan.md`, lista irreducible de `research.md` D21) sobre la suma de las 13 fases — no
   * sobre `stepMs`, que además incluye el clon (ver arriba). Con 320 hilos manda Amdahl: un
   * 5 % de fracción serial topa la aceleración en 20×, un 10 % en 10×.
   */
  fases: Record<FaseNombre, number>; fraccionSerial: number;
  /**
   * Ruling R17: el hardware, no un tope fijo, limita la población. `activo` es el valor
   * vigente de `world.reproductionEnabled`. Con la política `techo` (la de hoy) el gobernador no
   * apaga la natalidad: cuando `p95StepMs` supera `presupuestoMs` fija un techo en la población de
   * ese momento y solo permite nacimientos por debajo de él (reponer, no crecer); `activo` es false
   * mientras la población está EN el techo. Bajo el 70 % del presupuesto el techo se retira; en la
   * banda muerta se conserva y nunca baja. Con `apagar` (histórica) lo apaga por encima del
   * presupuesto y lo reenciende bajo el 70 %.
   * `manual` guarda una orden humana (null = sin orden); mientras no sea null, manda ella.
   */
  gobernador?: { activo: boolean; presupuestoMs: number; p95StepMs: number; manual: boolean | null;
    /** Política vigente (`gobernador.politica`), techo de población vigente con la política `techo`
     * (null = sin freno) y el último frenazo registrado (T164; no se borra al volver a verde). */
    politica?: 'apagar' | 'techo'; techo?: number | null;
    techoObservado?: { p95: number; poblacion: number; teselasActivas: number; teselasPorHabitante: number; senal: 'p95'; tick: number; motivo: string } | null }; }
export type GestureKind = 'plant' | 'invite' | 'remember' | 'command';
export interface Gesture { id: string; kind: GestureKind; x: number; y: number; memoryId?: string; agentId?: string; order?: Order; }
export interface GestureResult {
  id: string; accepted: boolean; tick: number; order: number; message: string;
}
/** Everything a client may send upstream. A camera or a query is never a gesture. */
export type ClientMessage =
  | { type: 'gesture'; gesture: Gesture }
  | { type: 'viewport'; viewport: Viewport }
  | { type: 'recipe'; id: string }
  /** T036(h): la biografía de un solo habitante, pedida al abrir su ficha. */
  | { type: 'persona'; id: string }
  /** Modo ligero móvil (T024): cadencia mínima pedida por ese cliente; el servidor acota a 1000 ms. */
  | { type: 'suscripcion'; intervaloMs: number };
export type ServerMessage =
  | { type: 'state'; world: WorldView }
  | { type: 'result'; result: GestureResult }
  /** A null definition means the server cannot serve that program now, never that it is empty. */
  | { type: 'recipe'; id: string; recipe: TechnologyRecipe | null }
  /** A null persona means that identity is not in the served world now, never that it lived nothing. */
  | { type: 'persona'; id: string; persona: PersonDetail | null }
  | { type: 'error'; message: string };
