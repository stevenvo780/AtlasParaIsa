export const PROTOCOL_VERSION = 2;
export interface Viewport { x: number; y: number; width: number; height: number; }
export type Biome = 'grassland' | 'forest' | 'desert' | 'mountain' | 'wetland' | 'ocean';
export type Terrain = 'water' | 'soil' | 'meadow' | 'shelter';
export interface Tile { x: number; y: number; terrain: Terrain; moisture: number; vegetation: number; food: number; biome?: Biome; elevation?: number; wood?: number; stone?: number; }
export type Action = 'explore' | 'eat' | 'rest' | 'approach' | 'accompany' | 'retreat' | 'share' | 'gather' | 'farm' | 'build';
export type Order = 'move' | 'explore' | 'gather' | 'farm' | 'build' | 'rest' | 'auto';
export interface PersonView {
  id: string; name: string; role: 'S' | 'I' | 'neighbor'; x: number; y: number;
  color: string; action: Action; reason: string;
  energy: number; hunger: number; fatigue: number; need: string;
  recentMemory: string | null;
  specialty?: string; controlMode?: 'auto' | 'directed';
  traits?: { curiosity: number; sociability: number; industriousness: number; care: number; resilience: number };
  skills?: Record<string, number>; materials?: { wood: number; stone: number };
}
export interface PlaceView { id: string; name: string; x: number; y: number; description: string; gatherings: number; }
export interface ChronicleEvent {
  id: string; tick: number; kind: 'ecology' | 'meeting' | 'care' | 'learning' | 'memory' | 'gesture' | 'pause' | 'discovery' | 'settlement';
  actors: string[]; text: string; cause: string; x?: number; y?: number; source: 'simulation' | 'sample' | 'approved';
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
}
export type GestureKind = 'plant' | 'invite' | 'remember' | 'command';
export interface Gesture { id: string; kind: GestureKind; x: number; y: number; memoryId?: string; agentId?: string; order?: Order; }
export interface GestureResult {
  id: string; accepted: boolean; tick: number; order: number; message: string;
}
export type ServerMessage =
  | { type: 'state'; world: WorldView }
  | { type: 'result'; result: GestureResult }
  | { type: 'error'; message: string };
