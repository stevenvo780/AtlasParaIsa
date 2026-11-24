/**
 * V24 — Shared contract for:
 *  1. Real Discovered-Terrain World Minimap (`GET /api/worldmap`, 4×4 palette nibbles/chunk = ~16 B/chunk!)
 *  2. Global Searchable Directory (`GET /api/directory` — all living inhabitants, communities, structures & herds)
 *  3. Asynchronous "Mensajes Divinos" / Divine Whispers (`POST /api/whisper`, `GET /api/whispers`)
 */

/** 4-bit palette for 4×4 downsampled terrain blocks (16 hex nibbles per 16×16 chunk). */
export const MINIMAP_PALETTE = [
  '#14404a', // 0: ocean
  '#237178', // 1: inland water / river / spring
  '#d9c088', // 2: desert / sand
  '#7ca163', // 3: grassland / meadow
  '#3b6e44', // 4: forest / dense woods
  '#4a7d6c', // 5: wetland
  '#8f8b84', // 6: mountain / rock
  '#c4b454', // 7: cultivated farmland
  '#cbb99b', // 8: paved road
  '#e08a4c', // 9: settlement / structure
  '#cfd5d6', // a: high peak
  '#b57e58', // b: soil / clay
  '#5d8a55', // c: sparse trees / shrub
  '#d97b54', // d: kiln / warm hearth cluster
  '#87b8a8', // e: shallow shore
  '#20302a', // f: unexplored fallback
] as const;

export interface WorldMapChunkSummary {
  /** Chunk coordinate X (worldX = cx * 16). */
  cx: number;
  /** Chunk coordinate Y (worldY = cy * 16). */
  cy: number;
  /** 16 hex chars (4×4 grid, row-major) indexing `MINIMAP_PALETTE`. */
  cells: string;
  /** True when currently simulated in the resident active region set. */
  active?: boolean;
}

export interface WorldMapMarker {
  kind: 'S' | 'I' | 'community' | 'herd' | 'whisper';
  id: string;
  name: string;
  x: number;
  y: number;
  color?: string;
  count?: number;
}

export interface WorldMapResponse {
  tick: number;
  day: number;
  discoveredChunks: number;
  activeChunks: number;
  bounds: { minCx: number; maxCx: number; minCy: number; maxCy: number };
  chunks: WorldMapChunkSummary[];
  markers: WorldMapMarker[];
}

export interface DirectoryPersonEntry {
  id: string;
  name: string;
  role: 'S' | 'I' | 'neighbor';
  x: number;
  y: number;
  action: string;
  age: number;
  generation: number;
  communityId: string | null;
  craftFocus?: string;
  craftTint?: string;
  health?: number;
  hunger: number;
  energy: number;
  lifeStage?: 'juvenile' | 'adult' | 'senescent';
}

export interface DirectoryCommunityEntry {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
  memberCount: number;
  cooperation: number;
  disputes: number;
}

export interface DirectoryStructureEntry {
  id: string;
  name: string;
  x: number;
  y: number;
  cells: number;
  kilnTier: number;
  tint?: string;
  condition: number;
}

export interface DirectoryHerdEntry {
  species: string;
  x: number;
  y: number;
  count: number;
  tameCount: number;
  avgHabituation: number;
}

export interface WorldDirectoryResponse {
  tick: number;
  day: number;
  totalPeople: number;
  totalAnimals: number;
  totalTameAnimals: number;
  totalStructures: number;
  totalPolyominoes: number;
  people: DirectoryPersonEntry[];
  communities: DirectoryCommunityEntry[];
  structures: DirectoryStructureEntry[];
  herds: DirectoryHerdEntry[];
}

export type DivineWhisperIntent = 'travel' | 'explore' | 'gather' | 'build' | 'craft' | 'tend';
export type DivineWhisperStatus = 'latent' | 'heard' | 'fulfilled' | 'faded';

export interface DivineWhisper {
  id: string;
  createdTick: number;
  createdDay: number;
  /** Specific inhabitant ID, or null to whisper to whoever passes closest to the region. */
  personId: string | null;
  personName?: string;
  intent: DivineWhisperIntent;
  x: number;
  y: number;
  note: string;
  status: DivineWhisperStatus;
  heardTick?: number;
  heardById?: string;
  heardByName?: string;
  resolvedTick?: number;
}

export interface DivineWhisperRequest {
  personId?: string | null;
  intent: DivineWhisperIntent;
  x: number;
  y: number;
  note?: string;
}
