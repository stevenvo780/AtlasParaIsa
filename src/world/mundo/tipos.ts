import type { Point } from './geometria.js';
import type { WorldContext as SpatialWorldContext, ChunkMeta } from '../spatial.js';
import type { EcologyExecution } from '../ecosystem-kernel.js';
import type { PersonView, Order, MemoryView, Action, Tile, PlaceView, ChronicleEvent, CommunityView, WorldSample } from '../../shared/types.js';
import type { CompoundLot } from '../../shared/chemistry.js';
import type { Genome } from '../genetics.js';
import type { Culture } from '../society.js';
import type { PolicyGenome, PolicyPlasticity } from '../politica.js';
import type { TechnologyKnowledge, TechnologyState } from '../../shared/technology.js';
import type { DemographicState, LegacyRecord } from '../../shared/demography.js';
import type { ChemistryState } from '../chemistry.js';
import type { WhisperRecord } from '../whispers.js';
import type { ChronicleJournal } from '../chronicle-journal.js';
import type { Chunk } from '../terrain.js';
import type { Animal } from '../animals.js';
import type { AnimalDynamics, BlueprintView, StructureView, InventionDynamics } from '../../shared/life.js';

/**
 * Cota anticorrupción compartida por la crónica, los checkpoints y `assertWorld` (ruling R17).
 */
export { POPULATION_HARD_LIMIT } from '../../shared/life.js';

/** Observación/partición del anfitrión: no se serializa ni forma parte de las leyes del mundo. */
export type WorldContext = SpatialWorldContext & { ecologyExecution?: EcologyExecution };


// V12 adds opt-in local neighborhood natality (D2), uncapped organic communities (`maxComunidades=0`),
// evolvable 12→8→12 local neural policy + lifetime Baldwin plasticity, and multi-chip CPU+Dual-GPU dispatch.
export const RULES_VERSION = 14;

export const TICKS_PER_DAY = 2400;

export const MAX_EVENTS = 120;

export const MAX_EXPERIENCES = 8;

export const MAX_HABITS = 3;

export const RADIUS = 7;

export const COOLDOWN = 30;

export interface Experience { tick: number; text: string; causeId: string; placeId: string; }

export interface Habit {
  placeId: string; observations: number; strength: number; demonstrator: string;
  sourceEvent: string; repetitions: number;
  evidence: { eventId: string; tick: number; demonstrator: string; recipient: string; food: number }[];
}

export interface Person extends PersonView {
  /** V23: identidad durable en la tabla de organismos (`World.siguienteUid`); ninguna ley la lee. */
  uid?: number;
  huntingPreyId?: string;
  tending?: { id: string; work: number };
  compounds?: CompoundLot[];
  inventory: number; curiosity: number; sociability: number; generosity: number;
  closeness: number; socialLoad: number; target: Point; decisionAt: number;
  lastMeeting: number; lastShared: number; experiences: Experience[]; habits: Habit[];
  traits: NonNullable<PersonView['traits']>; skills: Record<string, number>; materials: { wood: number; stone: number };
  activity: Record<string, number>; values: Record<string, number>; visited: string[]; heading: number;
  command: { order: Exclude<Order, 'auto'>; x: number; y: number } | null;
  work: number; lastOutcome: number; intentContext: 'hungry' | 'thirsty' | 'tired' | 'ready'; controlMode: 'auto' | 'directed';
  thirst: number; genome: Genome; bornAt: number; lastBirth: number; lastSocial: number; lastDispute: number; lastPracticeMemory: number;
  culture: Culture; communityId: string | null; bonds: Record<string, number>;
  lastInvention?: number;
  home?: { x: number; y: number; quality: number; observedAt: number };
  /** Ley candidata `agua.memoria`: último lugar donde bebió agua del entorno. Sólo existe con la ley activa. */
  waterMemory?: { x: number; y: number };
  /** Ley candidata `social.memoriaDisputa` (CONFL): fuente donde cedió su última disputa y paso en que la cedió.
   * Sólo existe con la ley activa; se olvida un día después. */
  conflictMemory?: { x: number; y: number; tick: number };
  /** V19/S (`social.acuerdosMateriales`): turno acordado ante una fuente escasa que quien cedió espera ver cumplido.
   * `level` es su hambre o sed al firmar; se resuelve con el cambio corporal real (`society.ts` → `settleAgreement`).
   * Adquirido, nunca heredable: se borra al nacer. */
  agreement?: { partner: string; x: number; y: number; tick: number; metric: 'hunger' | 'thirst'; level: number };
  /** Ley V16 (`social.vinculoEncuentro > 0`): último punto de encuentro o rastro recordado de S/I. */
  partnerMemory?: { x: number; y: number; tick: number };
  /** Ley evolutiva V12 (`conducta.politicaPeso > 0`): red de política local 12→8→12 heredable. */
  policy?: PolicyGenome;
  /** Plasticidad adquirida en vida (efecto Baldwin, nunca heredable): sesgo y traza por familia de acción. */
  policyPlasticity?: PolicyPlasticity;
  technology: TechnologyKnowledge; demography: DemographicState;
}

export interface Memory extends MemoryView {
  context: 'partner-tired' | 'shelter-tired' | 'food-hungry' | 'rain-shelter' | 'irrelevant';
  action: Action; weight: number; roles: ('S' | 'I')[];
}

export interface World {
  chemistry?: ChemistryState;
  /** V24: Mensajes Divinos asíncronos. Ausente (o vacío) en todo mundo que nunca recibió uno: entonces el
   * paso no hace NI UNA operación ni sorteo extra y los digestos históricos no cambian. */
  whispers?: WhisperRecord[];
  version: number; seed: number; rng: number; tick: number; width: number; height: number;
  weather: 'clear' | 'rain'; tiles: Tile[]; people: Person[]; places: PlaceView[];
  memories: Memory[]; events: ChronicleEvent[]; eventCounter: number; chronicleJournal?: ChronicleJournal;
  invitations: { id: string; x: number; y: number; until: number }[];
  reminders: { memoryId: string; until: number }[];
  lastGestureTick: number; learningEnabled: boolean;
  chunks: Record<string, ChunkMeta>; retiredChunks: Chunk[]; discoveredChunks: number; settlementCount: number;
  adaptationEnabled: boolean; noveltyEnabled: boolean; shelterBenefitEnabled: boolean;
  cooperationEnabled: boolean; reproductionEnabled: boolean; communities: CommunityView[]; communityCounter: number; birthCounter: number;
  history: WorldSample[]; totals: Record<string, number>;
  animals: Animal[]; animalCounter: number; animalDynamics: AnimalDynamics;
  /** V23: el próximo uid de la tabla de organismos, común a personas y fauna (ausente hasta la primera alta). */
  siguienteUid?: number;
  blueprints: BlueprintView[]; structures: StructureView[]; blueprintCounter: number; structureCounter: number; inventionDynamics: InventionDynamics;
  technology: TechnologyState; legacy: LegacyRecord[]; retiredLegacy: LegacyRecord[];
  demographyDynamics: { deaths: number; causes: Record<LegacyRecord['cause'], number>; foodLost: number; woodLost: number; stoneLost: number };
}
