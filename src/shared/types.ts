export const PROTOCOL_VERSION = 1;
export type Terrain = 'water' | 'soil' | 'meadow' | 'shelter';
export interface Tile { x: number; y: number; terrain: Terrain; moisture: number; vegetation: number; food: number; }
export type Action = 'explore' | 'eat' | 'rest' | 'approach' | 'accompany' | 'retreat' | 'share';
export interface PersonView {
  id: string; name: string; role: 'S' | 'I' | 'neighbor'; x: number; y: number;
  color: string; action: Action; reason: string;
  energy: number; hunger: number; fatigue: number; need: string;
  recentMemory: string | null;
}
export interface PlaceView { id: string; name: string; x: number; y: number; description: string; gatherings: number; }
export interface ChronicleEvent {
  id: string; tick: number; kind: 'ecology' | 'meeting' | 'care' | 'learning' | 'memory' | 'gesture' | 'pause';
  actors: string[]; text: string; cause: string; x?: number; y?: number; source: 'simulation' | 'sample' | 'approved';
}
export interface MemoryView { id: string; title: string; text: string; source: 'sample' | 'approved'; placeId: string; }
export interface WorldView {
  version: number; sequence: number; tick: number; day: number;
  phase: 'dawn' | 'day' | 'dusk' | 'night'; weather: 'clear' | 'rain';
  width: number; height: number; tiles: Tile[]; people: PersonView[]; places: PlaceView[];
  events: ChronicleEvent[]; memories: MemoryView[];
  paused?: boolean; pauseReason?: string;
}
export type GestureKind = 'plant' | 'invite' | 'remember';
export interface Gesture { id: string; kind: GestureKind; x: number; y: number; memoryId?: string; }
export interface GestureResult {
  id: string; accepted: boolean; tick: number; order: number; message: string;
}
export type ServerMessage =
  | { type: 'state'; world: WorldView }
  | { type: 'result'; result: GestureResult }
  | { type: 'error'; message: string };
