/**
 * Una carta para Isa — renderizador del paisaje.
 *
 * Contrato: el mundo es autoritativo en el servidor. Este cliente NO simula.
 * `performance.now()` sólo alimenta (a) el vaivén decorativo y (b) la
 * interpolación entre el snapshot anterior y el actual. Ningún dato que se
 * presente como estado del mundo (tick, day, phase, weather, events) se deriva
 * del reloj local.
 *
 * Ajusta esta ruta a donde viva el contrato compartido; conserva la extensión
 * `.js` (resolución ESM / NodeNext).
 */
import { PROTOCOL_VERSION } from '../shared/types.js';
import type { AnimalView, PersonView, PlaceView, StructureView, Terrain, Tile, Viewport, WorldView } from '../shared/types.js';
import { BoundedCache, GpuTerrain, type GpuStatus, type TerrainRaster } from './gpu-terrain.js';
import { animalActions, speciesNames, paintAnimal, paintStructure, paintTree, treeForm, type TreeForm, type AnimalVisualTraits } from './life-art.js';
import { bodySeed, animalPose, daylightAt, newEventAccents, AtmosphereSmoother, CadenceEstimator, MotionTracker, PlaybackBuffer, VISUAL_BUDGET, EVENT_LIFETIME_MS, type EventAccent } from './visual-state.js';
import type { ClientTileCache } from './tile-cache.js';
import type { Capability } from '../shared/technology.js';
import { decidirModo, rendererProfile, type Modo } from './modo.js';
import { dibujarCalor, type Capa, type RangoCalor } from './calor.js';
import { claveRegion } from './regiones.js';
import { cropSignature, cropStage, cropWorkMode, drawCropWork, paintCropField } from './crop-art.js';
import { paintGeologyVeins, paintRoadTile } from './road-geology-art.js';
import { footprintBox, footprintCells, isModular, paintCompactAccessories, paintConstructionSite, paintModularHall, structureExtent, type ExtendedStructure } from './structure-art.js';
import { classifyTerrainPixel, hash3, materialNoise, newFieldPixel, prepareTerrainStencil, rnd, waterDepthTone, type FieldSample } from './terrain-field.js';

/** Only discrete phenotype buckets enter the sprite key; continuous genetic noise never does. */
export function animalVisualTraits(v: AnimalView): AnimalVisualTraits {
  const bucket = (n: number | undefined): 0 | 1 | 2 => n === undefined || !Number.isFinite(n) ? 1 : n < .35 ? 0 : n >= .65 ? 2 : 1;
  return {
    camouflage: v.genes?.camouflage > .56 ? 2 : v.genes?.camouflage < .44 ? 0 : 1,
    agile: v.genes?.speed > .56 || v.genes?.perception > .56 || (v.morphology?.caution ?? 0) >= .65 ? 1 : 0,
    fierce: v.genes?.carnivory > .54 ? 1 : 0,
    maturity: (v.age ?? 1200) < 700 ? 0 : (v.generation ?? 0) >= 3 ? 2 : 1,
    size: bucket(v.morphology?.size), coat: bucket(v.morphology?.coat), defense: bucket(v.morphology?.defense),
    tame: (v.habituation ?? 0) >= .75 ? 2 : (v.habituation ?? 0) >= .45 ? 1 : 0,
  };
}
export function animalSpriteKey(v: AnimalView, pose: number, traits = animalVisualTraits(v)): string {
  // Drink/graze and roam/flee/hunt use identical silhouettes at a given pose.
  const action = v.action === 'rest' ? 'rest' : v.action === 'drink' || v.action === 'graze' ? 'graze' : 'roam';
  return `animal:${v.species}:${action}:${pose}:${Object.values(traits).join(':')}`;
}
const chemicalColor = (v: string | undefined): string | undefined => v && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(v) ? v : undefined;
type ForgedItem = NonNullable<WorldView['technology']>['items'][number];
export interface CraftVisual { tint?: string; glint: boolean; packTint?: string; lightPack: boolean }
/** Snapshot-time selection, shared with tests: personal craft > best forged tool > carried chemistry. */
export function personCraftVisual(person: PersonView, items: readonly ForgedItem[] = []): CraftVisual {
  let best: ForgedItem | undefined, score = -Infinity;
  for (const item of items) {
    if (item.ownerId !== person.id || item.mass <= 0 || !chemicalColor(item.materialTint)) continue;
    const utility = Math.max(0, ...Object.values(item.capacities));
    if (utility > score || utility === score && item.mass > (best?.mass ?? 0)) { best = item; score = utility; }
  }
  let lot: NonNullable<PersonView['compounds']>[number] | undefined;
  for (const candidate of person.compounds ?? []) if (candidate.mass > 0 && chemicalColor(candidate.properties.colorHex) && (!lot || candidate.mass > lot.mass)) lot = candidate;
  const tint = chemicalColor(person.craftTint) ?? chemicalColor(best?.materialTint) ?? lot?.properties.colorHex;
  const phase = best?.chemPhase ?? lot?.phase;
  return { tint, glint: phase === 'smelted' || phase === 'vitrified', packTint: lot?.properties.colorHex, lightPack: (lot?.properties.lightness ?? 0) >= .65 };
}
const tintBucket = (tint: string | undefined): string => chemicalColor(tint)?.replace(/[\da-f]/gi, c => Math.floor(parseInt(c, 16) / 4).toString(16)) ?? '';

/* ------------------------------------------------------------------ */
/* Tipos públicos                                                      */
/* ------------------------------------------------------------------ */

export type OverlayLayer = 'none' | 'moisture' | 'food';

export type Selection =
  | { kind: 'person'; id: string }
  | { kind: 'animal'; id: string }
  | { kind: 'tile'; x: number; y: number };

export type LandscapeSelection = Selection;

export type SelectHandler = (selection: LandscapeSelection) => void;

/* ------------------------------------------------------------------ */
/* Constantes de arte                                                  */
/* ------------------------------------------------------------------ */

/** Píxeles de arte por tile: la resolución nativa del pixel-art. */
const ART = 16;
const CHUNK_ART_TILES = 8;
const TERRAIN_CACHE_LIMIT = 256; // V18: 16 MiB CPU rasters (256 chunks); volver a lo ya visitado no vuelve a hornear píxeles.
const SPRITE_CACHE_LIMIT = 320; // At most 1.875 MiB of 32 × 48 RGBA sprites.
const MAX_ZOOM = 84;
/** Radio de acierto al tocar una persona, en tiles. */
const PERSON_HIT = 0.65;
/** V18 capa 1.5: cuánto hay que mover (tiles) o acercar (ln del zoom) la cámara a mano para vaciar el colchón de reproducción. */
const PLAYBACK_PAN_TILES = 3;
const PLAYBACK_ZOOM_LOG = .15;
/** Margen (en tiles) de mar visible alrededor de la isla al encuadrar. */
const FIT_PADDING = 1.4;
const FOCUS_MS = 380;
/** Teselas que recorre un cuerpo entre dos medios pasos de su zancada (andar sereno, ligado a la distancia real). */
const STRIDE_TILES = .3;
const ANIMAL_STEP_TILES = .17;
/** Un destino ordenado se marca al instante y se retira al llegar o pasado este tiempo. */
const DESTINATION_MS = 12_000;
/** Ventana compuesta desde la caché: alineada a trozos de arte y con holgura para que arrastrar no la rehaga cada fotograma. */
const WINDOW_ALIGN = CHUNK_ART_TILES, WINDOW_MARGIN = 8;
/** Retraso mínimo antes de mostrar «cargando» (un instante no merece aviso) y vigencia máxima del aviso. */
const LOADING_DELAY_MS = 250, LOADING_MAX_MS = 6000;
/** V22: por debajo de estos px/tesela (zoom lejano) no se dibujan recortes, vaivenes ni sombras y el arbolado va en una capa estática. */
const FAR_ZOOM = 14;
/** V22: la animación de los salones modulares (humo, brasas) se re-pinta a esta cadencia, no en cada fotograma. */
const HALL_POSES_PER_SEC = 8;
const HALL_SLOT_LIMIT = 192;
/** Holgura (px de arte) alrededor de `structureExtent` para humo, chimeneas, bodega y contrafuertes del salón cacheado. */
const HALL_PAD = { x: 14, top: 30, bottom: 14 } as const;
/** Margen (teselas) de la rejilla espacial de cuerpos para `behind()`. */
const BODY_GRID_MARGIN = 6;

/* ------------------------------------------------------------------ */
/* Utilidades de color                                                 */
/* ------------------------------------------------------------------ */

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface GroundMaterial extends FieldSample {
  soil: RGB; leaf: RGB; cover: number; moisture: number; traffic: number;
}

/** The raster and its cache key must observe the same received-state buckets. */
const TERRAIN_SIG: Record<string, number> = { water: 1, soil: 2, meadow: 3, shelter: 4 };
const BIOME_SIG: Record<string, number> = { grassland: 1, forest: 2, desert: 3, mountain: 4, wetland: 5, ocean: 6 };
const FEATURE_SIG: Record<string, number> = { tree: 1, pine: 2, palm: 3, cactus: 4, reeds: 5, berries: 6, flowers: 7, rock: 8, clay: 9, stump: 10, spring: 11, pool: 12, none: 13 };
const PUDDLE_W3 = new Float32Array(9);
const PUDDLE_DEPR = new Float32Array(25);
const PUDDLE_GRID = new Float32Array(ART * ART);

function groundBucket(value: number): number { return Math.round(clamp01(value) * 12); }
function groundValue(value: number): number { return groundBucket(value) / 12; }

function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b };
}

function css(c: RGB, a = 1): string {
  const r = Math.max(0, Math.min(255, Math.round(c.r)));
  const g = Math.max(0, Math.min(255, Math.round(c.g)));
  const b = Math.max(0, Math.min(255, Math.round(c.b)));
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return rgb(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
}

const WHITE = rgb(255, 255, 255);
const BLACK = rgb(0, 0, 0);

function lighten(c: RGB, t: number): RGB {
  return mix(c, WHITE, t);
}

function darken(c: RGB, t: number): RGB {
  return mix(c, BLACK, t);
}

const HEX6 = /^#?([0-9a-fA-F]{6})$/;
const HEX3 = /^#?([0-9a-fA-F]{3})$/;

/** Parseo defensivo: `person.color` viene de la red, nunca se confía a ciegas. */
function parseColor(input: string, fallback: RGB): RGB {
  const six = HEX6.exec(input);
  if (six) {
    const h = six[1];
    if (h !== undefined) {
      const n = Number.parseInt(h, 16);
      return rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }
  }
  const three = HEX3.exec(input);
  if (three) {
    const h = three[1];
    if (h !== undefined && h.length === 3) {
      const r = h.charAt(0);
      const g = h.charAt(1);
      const b = h.charAt(2);
      const n = Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
      return rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/* Paleta                                                              */
/* ------------------------------------------------------------------ */

const P = {
  seaDeep: rgb(19, 62, 71),
  seaBand: rgb(24, 74, 83),
  waterDeep: rgb(23, 88, 95),
  water: rgb(31, 111, 116),
  waterShallow: rgb(52, 145, 141),
  waterGleam: rgb(140, 208, 196),

  sageLow: rgb(150, 170, 124),
  mossHigh: rgb(63, 107, 65),
  grassLight: rgb(176, 197, 141),
  grassDark: rgb(52, 88, 57),

  soil: rgb(168, 130, 92),
  soilDark: rgb(138, 103, 70),
  soilLight: rgb(196, 163, 120),

  sand: rgb(226, 207, 164),
  sandDark: rgb(203, 181, 137),

  shelterGround: rgb(184, 160, 124),
  hutWall: rgb(196, 168, 124),
  hutWallShade: rgb(160, 133, 94),
  hutRoof: rgb(179, 141, 84),
  hutRoofLight: rgb(211, 173, 110),
  hutDoor: rgb(60, 45, 34),
  hutGlow: rgb(238, 186, 108),

  trunk: rgb(74, 58, 44),
  trunkLight: rgb(96, 76, 56),
  canopyDark: rgb(46, 79, 53),
  canopyMid: rgb(74, 111, 66),
  canopyLight: rgb(122, 154, 92),
  canopySage: rgb(138, 158, 108),

  reed: rgb(112, 137, 88),
  reedLight: rgb(158, 178, 118),

  berryLeaf: rgb(70, 104, 62),
  berry: rgb(180, 62, 74),
  berryLight: rgb(214, 104, 106),

  stone: rgb(196, 189, 170),
  stoneShade: rgb(158, 150, 132),

  shadow: rgb(20, 34, 26),
  skin: rgb(226, 190, 158),
  hair: rgb(66, 50, 40),
  neutralCloth: rgb(138, 133, 118),

  amber: rgb(217, 146, 46),
  amberDeep: rgb(178, 112, 30),
  coral: rgb(226, 114, 91),
  coralDeep: rgb(186, 84, 68),

  paper: rgb(247, 242, 231),
  ink: rgb(46, 42, 34),
  rule: rgb(185, 173, 147),
} as const;

interface Tint {
  color: string;
  alpha: number;
}

const RAIN_TINT: Tint = { color: 'rgb(159,179,189)', alpha: 0.2 };

/** Fusiona dos listas ya ordenadas por `sortY`; a igualdad gana `first` (el orden estable de antes de V22). */
function mergeBySortY<T extends { sortY: number }>(first: readonly T[], second: readonly T[]): T[] {
  if (!second.length) return first as T[];
  const out = new Array<T>(first.length + second.length);
  let i = 0, j = 0, k = 0;
  while (i < first.length && j < second.length) out[k++] = second[j]!.sortY < first[i]!.sortY ? second[j++]! : first[i++]!;
  while (i < first.length) out[k++] = first[i++]!;
  while (j < second.length) out[k++] = second[j++]!;
  return out;
}

/** Clave numérica de una celda (|coordenada| < 2^24): evita construir cadenas `x,y` en el camino caliente. */
function cellKey(x: number, y: number): number { return (x + 16777216) * 33554432 + (y + 16777216); }

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

/** Texto que viene del servidor: se dibuja con fillText (nunca innerHTML) y se acota. */
function sanitizeLabel(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '—';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/* ------------------------------------------------------------------ */
/* Primitivas de pixel-art (bordes duros, sin antialias)               */
/* ------------------------------------------------------------------ */

function px(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** Elipse rellena por scanlines: cada píxel de arte queda entero, sin suavizado. */
function ellipse(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
): void {
  if (rx <= 0 || ry <= 0) return;
  g.fillStyle = color;
  const y0 = Math.floor(cy - ry);
  const y1 = Math.ceil(cy + ry);
  for (let y = y0; y < y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    if (dy * dy >= 1) continue;
    const half = rx * Math.sqrt(1 - dy * dy);
    const x0 = Math.round(cx - half);
    const x1 = Math.round(cx + half);
    if (x1 > x0) g.fillRect(x0, y, x1 - x0, 1);
  }
}

/* ------------------------------------------------------------------ */
/* Estructuras internas                                                */
/* ------------------------------------------------------------------ */

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

interface RenderPerson {
  view: PersonView;
  x: number;
  y: number;
  moving: boolean;
  seed: number;
  /** Teselas recorridas: la fase de la zancada sale de la distancia, no del reloj. */
  stride: number;
}
interface RenderAnimal { view: AnimalView; x: number; y: number; moving: boolean; left: boolean; stride: number; }
interface ViewBounds { x0: number; x1: number; y0: number; y1: number; }

/** V22: decoración por tesela que se anima (ondas, destellos, cañas), precalculada una vez por cambio de rejilla/vista. */
interface AnimatedTile { kind: 0 | 1 | 2; tile: Tile; x: number; y: number; }
/** V22: todo lo que `drawScene` deriva SOLO de la rejilla, las estructuras y la ventana visible (no del reloj ni de los cuerpos). */
interface SceneProps {
  key: string;
  visibleTiles: number;
  animated: AnimatedTile[];
  /** Árboles + cabañas + fauna antigua, ya ordenados por `sortY` (orden estable de inserción por teselas). */
  sprites: Sprite[];
  /** Solo árboles y cabañas (lo que va a la capa estática en zoom lejano). */
  props: Sprite[];
  fauna: Sprite[];
}
interface HallSlot { canvas: HTMLCanvasElement; sig: string; pose: number; left: number; top: number; }
export interface PerfCounters {
  dvrMode: boolean; farLod: boolean;
  structuredTileBuilds: number; scenePropsBuilds: number; canopyBuilds: number; canopyBlits: number;
  hallBuilds: number; hallBlits: number; sceneBuilds: number;
  bodyGridBuilds: number; behindQueries: number; behindCandidateTests: number; behindSkipped: number;
  gridRevision: number; spritesSorted: number;
}

const enum SpriteKind {
  Tree = 0,
  Hut = 1,
  Person = 2,
  Fauna = 3,
  Animal = 4,
  Structure = 5,
}

interface Sprite {
  kind: SpriteKind;
  sortY: number;
  ax: number;
  ay: number;
  seed: number;
  size: number;
  person: RenderPerson | null;
  feature?: Tile['feature'];
  tile?: Tile;
  animal?: RenderAnimal;
  structure?: StructureView;
  tree?: TreeForm;
}

export interface RenderDiagnostics {
  fps: number; frameMs: number; backend: 'webgl2' | 'canvas2d-cached'; gpuStatus: GpuStatus; gpuLabel?: string;
  visibleTiles: number; drawCalls: number; cacheBuilds: number; cacheEntries: number; cacheBytes: number;
  textureUploads: number; gpuTextureBytes: number;
  terrainBuilds: number; spriteBuilds: number;
  visibleAnimals: number; visibleStructures: number;
  bodyCutaways: number;
  effects: { water: number; vegetation: number; rain: number; events: number; shadows: number };
  effectBudget: typeof VISUAL_BUDGET;
}

interface GroundChunk extends TerrainRaster { signature: number; }

interface PointerState {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startedAt: number;
  moved: boolean;
}

/* ------------------------------------------------------------------ */
/* Landscape                                                           */
/* ------------------------------------------------------------------ */

/**
 * Pinta el mapa de calor (T033) sobre el lienzo de escena, que ya está trasladado
 * al origen del mundo: una tesela ocupa `ART` px en ese sistema. Con `capa === null`
 * no emite ninguna orden de dibujo.
 */
export function pintarCalor(g: CanvasRenderingContext2D, tiles: readonly Tile[], capa: Capa | null, rango?: RangoCalor | null): void {
  if (!capa || tiles.length === 0) return;
  const previo = g.fillStyle;
  dibujarCalor(g, tiles, capa, { x0: 0, y0: 0, tileSize: ART, scale: 1 }, 0.55, rango);
  g.fillStyle = previo;
}

export class Landscape {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onSelect: SelectHandler;
  private readonly labels = document.createElement('canvas');
  private readonly labelCtx: CanvasRenderingContext2D;
  private readonly phaseLayer = document.createElement('div');
  private readonly rainLayer = document.createElement('div');

  /** T036(a): en modo observador no se instancia GpuTerrain; el dibujado cae al Canvas 2D cacheado. */
  private readonly gpu: GpuTerrain | null;
  private readonly terrainCache = new BoundedCache<GroundChunk>(TERRAIN_CACHE_LIMIT, (chunk, key) => {
    this.gpu?.drop(key); chunk.canvas.width = chunk.canvas.height = 0;
  });
  private readonly groundStamp = Object.assign(document.createElement('canvas'), { width: ART, height: ART });
  private readonly groundStampContext = this.groundStamp.getContext('2d')!;
  private readonly groundPixels = this.groundStampContext.createImageData(ART, ART);
  private readonly restVeil = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
  private readonly restVeilContext = this.restVeil.getContext('2d')!;
  private restVeilPixels: ImageData | null = null;
  private groundMaterials = new WeakMap<Tile, GroundMaterial>();
  private biomeFractions = new WeakMap<Tile, number>();
  private treeForms = new WeakMap<Tile, TreeForm>();
  private spriteBytes = 0;
  private readonly spriteCache = new BoundedCache<HTMLCanvasElement>(SPRITE_CACHE_LIMIT, canvas => { this.spriteBytes -= canvas.width * canvas.height * 4; canvas.width = canvas.height = 0; });
  private chunks: GroundChunk[] = [];
  private cacheBuilds = 0;
  // Independent bounded phenotype bank prevents trees/buildings from evicting evolving herds.
  private readonly animalCache = new BoundedCache<HTMLCanvasElement>(2048, canvas => { this.spriteBytes -= canvas.width * canvas.height * 4; canvas.width = canvas.height = 0; });
  private spriteBuilds = 0;
  private frameMs = 0;
  private fps = 0;
  private fpsAt = 0;
  private fpsFrames = 0;
  private visibleTiles = 0;
  private visibleAnimals = 0;
  private visibleStructures = 0;
  private bodyCutaways = 0;
  private drawCalls = 0;
  private sceneRevision = 0;
  /* V22 — rendimiento a 60 fps con zoom lejano */
  private dvrMode = false;
  private gridRevision = 0;
  private gridTilesRef: readonly Tile[] | null = null;
  private bakedSeed: number | undefined;
  private veilKey = '';
  private gridOriginX = 0;
  private gridOriginY = 0;
  private structuresRef: readonly StructureView[] | undefined | null = null;
  private structureRevision = 0;
  private structuredTiles = new Set<number>();
  private sceneProps: SceneProps | null = null;
  private staticPropsCanvas: HTMLCanvasElement | null = null;
  private staticPropsOwner: SceneProps | null = null;
  private readonly hallSlots = new Map<string, HallSlot>();
  private readonly hallSigs = new WeakMap<object, string>();
  private bodyHead = new Int32Array(0);
  private bodyNext = new Int32Array(0);
  private perf: PerfCounters = { dvrMode: false, farLod: false, structuredTileBuilds: 0, scenePropsBuilds: 0, canopyBuilds: 0, canopyBlits: 0, hallBuilds: 0, hallBlits: 0, sceneBuilds: 0, bodyGridBuilds: 0, behindQueries: 0, behindCandidateTests: 0, behindSkipped: 0, gridRevision: 0, spritesSorted: 0 };
  /** V20: semilla del mundo para la geología latente (veta de hierro/cal/sal) horneada en el suelo. */
  private worldSeed: number | undefined;
  private sceneKey = '';
  private ambientKey = '';
  private eventAccents: EventAccent[] = [];
  private effects = { water: 0, vegetation: 0, rain: 0, events: 0, shadows: 0 };
  private actionActive = false;
  private lighting = { shadowX: 4, shadowY: 3, shadowAlpha: .14 };
  private craftVisuals = new Map<string, CraftVisual>();
  private carriedProducts = new Map<string, Capability | 'material'>();
  private secondaryProducts = new Map<string, Capability | 'material'>();
  private carriedWater = new Map<string, boolean>();
  /** Escena completa por frame, también a resolución de arte. */
  private scene: HTMLCanvasElement;
  private sceneCtx: CanvasRenderingContext2D;

  private prev: WorldView | null = null;
  private curr: WorldView | null = null;
  private prevAt = 0;
  private currAt = 0;
  private interval = 500;
  /** V18: cadencia real del servidor, trayectorias visuales de personas y animales, luz/lluvia suavizadas. */
  private readonly cadence = new CadenceEstimator();
  private readonly peopleMotion = new MotionTracker(this.cadence);
  private readonly animalMotion = new MotionTracker(this.cadence);
  private readonly atmosphere = new AtmosphereSmoother();
  /** V18 capa 1.5: colchón de 3–6 s de fotogramas recibidos; los cuerpos se reproducen A→B dentro de él. */
  private readonly playback = new PlaybackBuffer<WorldView>();
  /** Reloj de muestreo de los cuerpos en este fotograma (`playback.visualMs`). */
  private motionClock = 0;
  private playbackAnchor: { x: number; y: number; zoom: number } | null = null;
  /** V18: caché espacial del cliente (la posee `game.ts`). Sin ella el paisaje se comporta como antes. */
  private tileCache: ClientTileCache | null = null;
  /** Ventana (en teselas) que el servidor envió; la cuadrícula puede ser mayor si se compuso desde la caché. */
  private serverWindow: { x: number; y: number; w: number; h: number } | null = null;
  private viewCoverage = 1;
  private coverageAt = 0;
  private cameraMovedAt = 0;
  private loadingSince = 0;
  private loadingAlpha = 0;
  private destination: { x: number; y: number; id: string; bornAt: number } | null = null;

  private worldW = 0;
  private worldH = 0;
  private originX = 0;
  private originY = 0;
  private reportedViewport = '';
  private followedId: string | null = null;
  private home: { x: number; y: number } | null = null;
  /** M10: regiones que el servidor simula en la ventana recibida (null = no lo dijo). */
  private vivas: Set<string> | null = null;
  private vivasKey = '';
  private grid: (Tile | undefined)[] = [];
  private prevPeople = new Map<string, PersonView>();
  private prevAnimals = new Map<string, AnimalView>();
  private followedKind: 'person' | 'animal' = 'person';
  private groundBaked = false;

  private cam: Camera = { x: 0, y: 0, zoom: 24 };
  private minZoom = 8;
  private focusFrom: Camera | null = null;
  private focusTo: { x: number; y: number } | null = null;
  private focusStart = 0;

  private layer: OverlayLayer = 'none';
  private capaCalor: Capa | null = null;
  private rangoCalor: RangoCalor | null = null;
  private rangoCalorKey = '';
  private selection: LandscapeSelection | null = null;
  private pickMode: 'ground' | 'inspect' = 'ground';
  private pendingTarget: { x: number; y: number } | null = null;

  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  // Ligero móvil (P1): decidido una vez por instancia; `resize`/`frame` lo usan. Wiring mínimo
  // fuera de esos dos métodos (una constante calculada, no una regla) — ver informe de T024.
  // R5: manda `options.modo` (así lo decidió quien instancia); solo se recae en la heurística
  // de `decidirModo()` cuando no se pasa ninguno explícito. Se asigna en el constructor (no aquí,
  // en el inicializador de campo) porque ahí ya existe `options`.
  private readonly modo: Modo;
  private lastFrameAt = 0;

  private pointers = new Map<number, PointerState>();
  private pinchDist = 0;
  private pinchZoom = 0;
  private suppressClick = false;

  private raf = 0;
  private destroyed = false;
  private reduceMotion = false;
  private readonly motionQuery: MediaQueryList | null;
  private readonly resizeObserver: ResizeObserver | null;
  private warnedVersion = false;

  private readonly onPointerDown = (e: PointerEvent): void => this.handlePointerDown(e);
  private readonly onPointerMove = (e: PointerEvent): void => this.handlePointerMove(e);
  private readonly onPointerUp = (e: PointerEvent): void => this.handlePointerUp(e);
  private readonly onWheel = (e: WheelEvent): void => this.handleWheel(e);
  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKeyDown(e);
  private readonly onWindowResize = (): void => this.resize();
  private readonly onMotionChange = (e: MediaQueryListEvent): void => {
    this.reduceMotion = e.matches;
  };

  constructor(canvas: HTMLCanvasElement, onSelect: SelectHandler, private readonly onViewport?: (viewport: Viewport) => void, private readonly onManualCamera?: () => void, options: { allowSoftwareWebGL?: boolean; modo?: 'completo' | 'observador' } = {}) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.modo = options.modo ?? decidirModo();

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Landscape: este navegador no expone un contexto 2D.');
    this.ctx = ctx;

    this.gpu = this.modo === 'observador' ? null : new GpuTerrain(canvas, options.allowSoftwareWebGL);
    // Multiplication must happen after browser composition: tinting a transparent 2D
    // overlay alone would brighten the WebGL terrain at night. Labels remain above it.
    for (const layer of [this.phaseLayer, this.rainLayer]) {
      layer.dataset.landscapeLayer = 'atmosphere'; layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;opacity:0;z-index:1';
    }
    this.labels.dataset.landscapeLayer = 'labels'; this.labels.setAttribute('aria-hidden', 'true');
    this.labels.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
    canvas.after(this.phaseLayer, this.rainLayer, this.labels);
    const labelCtx = this.labels.getContext('2d');
    if (!labelCtx) throw new Error('Landscape: no se pudo crear el lienzo de etiquetas.');
    this.labelCtx = labelCtx;

    this.scene = document.createElement('canvas');
    const sc = this.scene.getContext('2d');
    if (!sc) throw new Error('Landscape: no se pudo crear el lienzo de escena.');
    this.sceneCtx = sc;

    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      'Mundo vivo. Arrastra o usa las flechas para recorrer, más y menos para acercar, Inicio para volver. También puedes seleccionar habitantes y fauna desde el panel Población.',
    );

    this.motionQuery =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (this.motionQuery) {
      this.reduceMotion = this.motionQuery.matches;
      this.motionQuery.addEventListener('change', this.onMotionChange);
    }

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onWindowResize);

    this.resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            this.resize();
          })
        : null;
    this.resizeObserver?.observe(canvas);

    this.resize();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /* ---------------------------------------------------------------- */
  /* API pública                                                      */
  /* ---------------------------------------------------------------- */

  /** Recibe un snapshot del servidor. Guarda el anterior para interpolar. */
  update(world: WorldView): void {
    if (this.destroyed) return;

    if (world.version !== PROTOCOL_VERSION && !this.warnedVersion) {
      this.warnedVersion = true;
      console.warn(
        `Landscape: versión de protocolo ${world.version}, esperada ${PROTOCOL_VERSION}. Se dibuja igualmente.`,
      );
    }
    // Snapshot repetido o fuera de orden: se descarta sin tocar la interpolación.
    // Connection owns ordering; a reconnect or explicit recovery can move the sequence backward.

    const now = performance.now();
    const first = this.curr === null;
    const resubmitted = this.curr === world; // el mismo objeto otra vez: su contenido pudo mutarse en sitio
    // Un eco de cámara (misma `sequence`) no es un paso del servidor: no mide cadencia.
    this.cadence.observe(world.sequence, world.tick, now);
    this.interval = this.cadence.tickIntervalMs;
    // Un eco de cámara (misma `sequence`) sustituye la vista del fotograma sin avanzar el reloj de reproducción.
    // V22: con la cinta DVR el reproductor ya entrega los fotogramas a su ritmo exacto: no hay colchón V18 que llenar.
    // Los cuerpos se alimentan al llegar (A→B por `MotionTracker`, sin los 3–6 s de retraso del colchón).
    if (this.dvrMode) { if (!this.reduceMotion) { this.peopleMotion.ingest(world.people, now); this.animalMotion.ingest(world.animals ?? [], now); } }
    else this.playback.push(world, world.sequence, world.tick, now);

    // A new camera window at the same tick must not restart body interpolation.
    if (!this.curr || this.curr.tick !== world.tick) {
      this.prevPeople.clear();
      this.prevAnimals.clear();
      if (this.curr && world.tick > this.curr.tick) {
        for (const p of this.curr.people) this.prevPeople.set(p.id, p);
        for (const a of this.curr.animals ?? []) this.prevAnimals.set(a.id, a);
      }
      this.prev = this.curr && world.tick > this.curr.tick ? this.curr : null;
      this.prevAt = this.currAt;
      this.currAt = now;
    }
    const newAccents = newEventAccents(this.curr, world, now);
    if (this.curr && world.tick < this.curr.tick) this.eventAccents = [];
    this.eventAccents = [...this.eventAccents.filter(event => now - event.bornAt < EVENT_LIFETIME_MS), ...newAccents].slice(-VISUAL_BUDGET.events);
    this.curr = world;
    this.worldSeed = world.geologyKey;
    this.vivas = world.regionesVivas ? new Set(world.regionesVivas) : null;
    this.vivasKey = world.regionesVivas ? world.regionesVivas.join(';') : '';
    this.craftVisuals.clear();
    const forgedByOwner = new Map<string, ForgedItem[]>();
    for (const item of world.technology?.items ?? []) {
      const group = forgedByOwner.get(item.ownerId);
      if (group) group.push(item); else forgedByOwner.set(item.ownerId, [item]);
    }
    for (const person of world.people) this.craftVisuals.set(person.id, personCraftVisual(person, forgedByOwner.get(person.id)));
    this.carriedProducts.clear();
    this.secondaryProducts.clear();
    this.carriedWater.clear();
    for (const item of world.technology?.items ?? []) {
      if (item.mass <= 0) continue;
      const w = (item as { water?: { quanta?: number } }).water;
      if (w && typeof w.quanta === 'number' && w.quanta > 0) {
        this.carriedWater.set(item.ownerId, true);
      }
      const dominant = (Object.entries(item.capacities) as [Capability,number][]).sort((a,b)=>b[1]-a[1])[0];
      if (!dominant) continue;
      const cap: Capability | 'material' = dominant[1] > .08 ? dominant[0] : 'material';
      if (!this.carriedProducts.has(item.ownerId)) {
        this.carriedProducts.set(item.ownerId, cap);
      } else if (!this.secondaryProducts.has(item.ownerId) && this.carriedProducts.get(item.ownerId) !== cap) {
        this.secondaryProducts.set(item.ownerId, cap);
      }
    }
    this.sceneRevision++;
    this.syncStructures(world);

    this.serverWindow = { x: world.originX ?? 0, y: world.originY ?? 0, w: Math.max(0, Math.floor(world.width)), h: Math.max(0, Math.floor(world.height)) };
    // La cámara pudo moverse mientras el servidor terminaba el paso: si su ventana ya no cubre lo que se ve,
    // se compone con la caché (verdad fresca encima) en vez de dejar el hueco hasta el siguiente estado.
    const view = !first && this.tileCache ? this.visibleBounds() : null;
    if (view && !this.windowCovers(this.serverWindow, view)) this.composeWindow(view, world.tiles);
    else if (this.rebuildGrid(world, resubmitted)) this.bakeGround();

    if (first) {
      this.fitWorld();
    }
  }

  /** V18 capa 1.5: colapsa el colchón al estado más reciente (cámara movida u orden directa); luego se vuelve a llenar. */
  flushPlayback(): void { this.playback.flushToLatest(); }

  /**
   * V22: `true` cuando `DvrPlayer` conduce la reproducción. El colchón V18 (`PlaybackBuffer`, 3–6 s de retraso) se
   * puentea —el DVR ya da un ritmo regular— pero `MotionTracker` sigue interpolando A→B entre ticks consecutivos.
   */
  setDvrMode(active: boolean): void {
    if (this.dvrMode === active) return;
    this.dvrMode = active; this.perf.dvrMode = active;
    this.playback.clear(); this.peopleMotion.clear(); this.animalMotion.clear();
    this.sceneKey = '';
    if (active && this.curr && !this.reduceMotion) { const now = performance.now(); this.peopleMotion.ingest(this.curr.people, now); this.animalMotion.ingest(this.curr.animals ?? [], now); }
  }

  /** V22: contadores internos (pruebas y diagnóstico): cuántas veces se rehízo cada caché y cuánto trabajo evitó el LOD. */
  getPerfCounters(): PerfCounters { return { ...this.perf, dvrMode: this.dvrMode, farLod: this.cam.zoom < FAR_ZOOM, gridRevision: this.gridRevision }; }

  /** Un paneo o zoom manual deja el colchón en vivo para ver el terreno y a la gente donde están ya. Seguir a alguien no. */
  private syncPlaybackCamera(): void {
    const anchor = this.playbackAnchor, cam = this.cam;
    if (!anchor || this.followedId) { this.playbackAnchor = { x: cam.x, y: cam.y, zoom: cam.zoom }; return; }
    if (Math.hypot(cam.x - anchor.x, cam.y - anchor.y) <= PLAYBACK_PAN_TILES && Math.abs(Math.log(cam.zoom / anchor.zoom)) <= PLAYBACK_ZOOM_LOG) return;
    this.playback.flushToLatest();
    this.playbackAnchor = { x: cam.x, y: cam.y, zoom: cam.zoom };
  }

  /** V18: la caché espacial del cliente (null la desactiva). */
  setTileCache(cache: ClientTileCache | null): void { this.tileCache = cache; }

  /** V18: marca al instante a dónde se ordenó ir (antes de que el servidor aplique la orden en su siguiente paso). */
  markDestination(position: { x: number; y: number } | null, personId = ''): void {
    this.destination = position ? { x: position.x, y: position.y, id: personId, bornAt: performance.now() } : null;
  }

  /** Centra la cámara en una coordenada del mundo (en tiles). */
  focus(x: number, y: number): void {
    if (this.destroyed) return;
    const tx = clamp(x + 0.5, -9_999_950, 9_999_950);
    const ty = clamp(y + 0.5, -9_999_950, 9_999_950);
    if (this.reduceMotion) {
      this.cam.x = tx;
      this.cam.y = ty;
      this.focusTo = null;
      this.clampCamera();
      return;
    }
    this.focusFrom = { ...this.cam };
    this.focusTo = { x: tx, y: ty };
    this.focusStart = performance.now();
  }

  /** delta en «pasos»: +1 acerca un escalón (×1.18), −1 aleja uno. */
  zoom(delta: number): void {
    if (this.destroyed || !Number.isFinite(delta)) return;
    this.focusTo = null;
    this.setZoom(this.cam.zoom * Math.pow(1.18, delta), this.cssW / 2, this.cssH / 2);
  }

  setLayer(layer: OverlayLayer): void {
    this.layer = layer;
  }

  /** Mapa de calor de recursos (T033). `null` lo apaga. Invalida la escena cacheada. M10: `rango` estira la
   * rampa entre el mínimo y el máximo realmente recibidos (la leyenda muestra esos valores). */
  setCapaCalor(capa: Capa | null, rango: RangoCalor | null = null): void {
    const key = rango ? `${rango.min}:${rango.max}` : '';
    if (this.capaCalor === capa && this.rangoCalorKey === key) return;
    this.capaCalor = capa; this.rangoCalor = rango; this.rangoCalorKey = key;
    this.sceneKey = '';
  }

  capaDeCalor(): Capa | null { return this.capaCalor; }

  follow(id: string | null, kind: 'person' | 'animal' = 'person'): void { this.followedId = id; this.followedKind = kind; }

  setPendingTarget(position: { x: number; y: number } | null): void { this.pendingTarget = position; }

  camera(): { x: number; y: number; zoom: number } { return { ...this.cam }; }

  /** Orders retain geographic targets. Only explicit inspection follows a canopy to its root. */
  setPickMode(mode: 'ground' | 'inspect'): void { this.pickMode = mode; }

  /** CPU submission time, actual RAF rate, and detected backend; not a GPU timer. */
  getDiagnostics(): RenderDiagnostics {
    return { fps: this.fps, frameMs: this.frameMs, backend: this.gpu?.active ? 'webgl2' : 'canvas2d-cached', gpuStatus: this.gpu?.status ?? 'unavailable', gpuLabel: this.gpu?.label || undefined,
      visibleTiles: this.visibleTiles, drawCalls: this.drawCalls + (this.gpu?.drawCalls ?? 0), cacheBuilds: this.cacheBuilds + this.spriteBuilds,
      cacheEntries: this.terrainCache.size + this.spriteCache.size + this.animalCache.size, cacheBytes: this.terrainCache.size * 128 * 128 * 4 + this.spriteBytes,
      textureUploads: this.gpu?.uploads ?? 0, gpuTextureBytes: (this.gpu?.textureCount ?? 0) * 128 * 128 * 4, terrainBuilds: this.cacheBuilds, spriteBuilds: this.spriteBuilds, visibleAnimals: this.visibleAnimals, visibleStructures: this.visibleStructures,
      bodyCutaways: this.bodyCutaways, effects: { ...this.effects }, effectBudget: VISUAL_BUDGET };
  }

  /** Extra pequeño: permite que la barra lateral resalte a quien se elige en una tarjeta. */
  fit(): void { this.fitWorld(); }

  /** M3: última posición conocida de S (en cuadro, o la que trajo su ficha a demanda). `fit()` y la tecla
   * Inicio vuelven a ella aunque S no esté en `people`, que llega recortado a la cámara. */
  setHome(position: { x: number; y: number } | null): void {
    this.home = position && Number.isFinite(position.x) && Number.isFinite(position.y) ? { x: position.x, y: position.y } : null;
  }

  select(selection: Selection): void { this.selection = selection; }

  setSelection(selection: LandscapeSelection | null): void {
    this.selection = selection;
  }

  resize(): void {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    // R5: techo de dpr por `this.modo` (ver `rendererProfile`, sin DOM) — completo hasta 3×,
    // observador ≤ 1,5× (P1: sin techo, un móvil de dpr 3 redibujaba > 3 MPx por frame).
    this.dpr = clamp(window.devicePixelRatio || 1, 1, rendererProfile(this.modo).dprCeiling);
    this.cssW = w;
    this.cssH = h;
    const dw = Math.round(w * this.dpr);
    const dh = Math.round(h * this.dpr);
    if (this.canvas.width !== dw) this.canvas.width = dw;
    if (this.canvas.height !== dh) this.canvas.height = dh;
    if (this.labels.width !== dw) this.labels.width = dw;
    if (this.labels.height !== dh) this.labels.height = dh;
    this.ctx.imageSmoothingEnabled = false;

    this.recomputeMinZoom();
    if (this.cam.zoom < this.minZoom) this.cam.zoom = this.minZoom;
    this.clampCamera();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destination = null; this.tileCache = null; this.peopleMotion.clear(); this.animalMotion.clear(); this.playback.clear();
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onWindowResize);
    this.resizeObserver?.disconnect();
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
    this.pointers.clear();
    this.prevPeople.clear();
    this.grid = [];
    this.prev = null;
    this.curr = null;
    this.terrainCache.clear(); this.spriteCache.clear(); this.animalCache.clear(); this.chunks = []; this.gpu?.destroy();
    for (const slot of this.hallSlots.values()) slot.canvas.width = slot.canvas.height = 0;
    this.hallSlots.clear(); this.sceneProps = null; this.staticPropsOwner = null; if (this.staticPropsCanvas) this.staticPropsCanvas.width = this.staticPropsCanvas.height = 0;
    this.groundStamp.width = this.groundStamp.height = 0;
    this.restVeil.width = this.restVeil.height = 0;
    this.scene.width = this.scene.height = 0;
    this.labels.width = this.labels.height = 0; this.labels.remove(); this.phaseLayer.remove(); this.rainLayer.remove();
  }

  /* ---------------------------------------------------------------- */
  /* Mundo y rejilla                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * `false` si la rejilla ya era exactamente `world.tiles` (mismo arreglo y ventana en un fotograma NUEVO, p. ej. un tick de
   * la cinta sin cambios de teselas): no hay nada que rehornear. Reenviar el mismo objeto fuerza el rehorneado completo.
   */
  private rebuildGrid(world: WorldView, force = false): boolean {
    const ox = world.originX ?? 0, oy = world.originY ?? 0, w = Math.max(0, Math.floor(world.width)), h = Math.max(0, Math.floor(world.height));
    if (!force && this.groundBaked && this.bakedSeed === this.worldSeed && world.tiles === this.gridTilesRef && ox === this.originX && oy === this.originY && w === this.worldW && h === this.worldH) return false;
    this.setWindow(ox, oy, w, h, world.tiles);
    if (force) this.gridRevision++;
    return true;
  }

  /** V22: celdas ocupadas por estructuras, una vez por cambio de `world.structures` (no 60×/s en `drawScene`). */
  private syncStructures(world: WorldView): void {
    const structures = world.structures;
    if (structures === this.structuresRef) return;
    this.structuresRef = structures; this.structureRevision++; this.perf.structuredTileBuilds++;
    const cells = new Set<number>();
    for (const structure of structures ?? []) for (const cell of footprintCells(structure as ExtendedStructure)) cells.add(cellKey(cell.x, cell.y));
    this.structuredTiles = cells;
  }

  private setWindow(originX: number, originY: number, w: number, h: number, tiles: readonly Tile[]): void {
    this.originX = originX;
    this.originY = originY;
    if (w !== this.worldW || h !== this.worldH) {
      this.worldW = w;
      this.worldH = h;
      this.scene.width = Math.max(1, w * ART);
      this.scene.height = Math.max(1, h * ART);
      this.sceneCtx.imageSmoothingEnabled = false;
      this.groundBaked = false;
      this.recomputeMinZoom();
    }
    const cells = w * h;
    const previous = this.grid;
    const next = new Array<Tile | undefined>(cells);
    for (const t of tiles) {
      const tx = Math.floor(t.x) - this.originX;
      const ty = Math.floor(t.y) - this.originY;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      next[ty * w + tx] = t;
    }
    // V22: la revisión solo avanza si cambió alguna tesela (identidad) o la ventana; las cachés de escena cuelgan de ella.
    let changed = previous.length !== cells || originX !== this.gridOriginX || originY !== this.gridOriginY;
    for (let i = 0; !changed && i < cells; i++) if (previous[i] !== next[i]) changed = true;
    if (changed) this.gridRevision++;
    this.gridOriginX = originX; this.gridOriginY = originY;
    this.grid = next; this.gridTilesRef = tiles;
  }

  /** Teselas que `drawScene` pinta con la cámara de ahora (misma holgura que allí: copas altas). */
  private visibleBounds(): ViewBounds {
    const halfW = this.cssW / this.cam.zoom / 2, halfH = this.cssH / this.cam.zoom / 2;
    return { x0: Math.floor(this.cam.x - halfW) - 1, x1: Math.ceil(this.cam.x + halfW) + 1, y0: Math.floor(this.cam.y - halfH) - 3, y1: Math.ceil(this.cam.y + halfH) + 3 };
  }

  private windowCovers(win: { x: number; y: number; w: number; h: number }, view: ViewBounds): boolean {
    return view.x0 >= win.x && view.x1 <= win.x + win.w - 1 && view.y0 >= win.y && view.y1 <= win.y + win.h - 1;
  }

  /** Cuadrícula = lo visible + holgura, alineada a trozos: verdad fresca del servidor encima, el resto de la caché. */
  private composeWindow(view: ViewBounds, live: readonly Tile[]): void {
    const cache = this.tileCache; if (!cache) return;
    const x = Math.floor((view.x0 - WINDOW_MARGIN) / WINDOW_ALIGN) * WINDOW_ALIGN, y = Math.floor((view.y0 - WINDOW_MARGIN) / WINDOW_ALIGN) * WINDOW_ALIGN;
    const w = Math.ceil((view.x1 + 1 + WINDOW_MARGIN) / WINDOW_ALIGN) * WINDOW_ALIGN - x, h = Math.ceil((view.y1 + 1 + WINDOW_MARGIN) / WINDOW_ALIGN) * WINDOW_ALIGN - y;
    const composed = cache.composeViewport(x, y, w, h, live);
    this.setWindow(x, y, w, h, composed.tiles);
    this.bakeGround();
    this.sceneKey = '';
    this.measureCoverage(view, performance.now());
  }

  /** Fracción de lo visible que ya se conoce (0..1). Sólo importa mientras el servidor aún no cubre la cámara. */
  private measureCoverage(view: ViewBounds, now: number): void {
    this.coverageAt = now;
    let known = 0, total = 0;
    for (let y = view.y0 + 3; y <= view.y1 - 3; y++) for (let x = view.x0 + 1; x <= view.x1 - 1; x++) { total++; if (this.tileAt(x, y)) known++; }
    this.viewCoverage = total ? known / total : 1;
  }

  /** Cada fotograma: si la cámara salió de la cuadrícula, se pinta YA lo visitado desde la caché (0 ms de espera al servidor). */
  private ensureWindow(now: number): void {
    const world = this.curr;
    if (!world || !this.groundBaked || !this.tileCache || !this.serverWindow) return;
    const view = this.visibleBounds();
    if (!this.windowCovers({ x: this.originX, y: this.originY, w: this.worldW, h: this.worldH }, view)) this.composeWindow(view, world.tiles);
    if (this.windowCovers(this.serverWindow, view)) { this.viewCoverage = 1; this.loadingSince = 0; return; }
    if (now - this.coverageAt > 250) this.measureCoverage(view, now);
    if (this.viewCoverage < 1 && now - this.cameraMovedAt < LOADING_MAX_MS) { if (!this.loadingSince) this.loadingSince = now; } else this.loadingSince = 0;
  }

  /** Teselas existentes dentro de la ventana visible ya calculada por `drawScene`. */
  private teselasVisibles(x0: number, x1: number, y0: number, y1: number): Tile[] {
    if (!this.capaCalor) return [];
    const teselas: Tile[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const tile = this.tileAt(x, y); if (tile) teselas.push(tile); }
    return teselas;
  }

  private tileAt(x: number, y: number): Tile | undefined {
    const localX = x - this.originX, localY = y - this.originY;
    if (localX < 0 || localY < 0 || localX >= this.worldW || localY >= this.worldH) return undefined;
    return this.grid[localY * this.worldW + localX];
  }

  /** A viewport boundary is not a coastline. Unknown neighbours repeat the edge terrain. */
  private terrainAt(x: number, y: number): Terrain {
    const t = this.tileAt(x, y);
    return t?.terrain ?? this.tileAt(clamp(x, this.originX, this.originX + this.worldW - 1), clamp(y, this.originY, this.originY + this.worldH - 1))?.terrain ?? 'meadow';
  }

  private chunkSignature(startX: number, startY: number): number {
    let h = 2166136261;
    if (this.worldSeed !== undefined) h = Math.imul(h ^ (this.worldSeed | 0), 16777619) >>> 0; // otra semilla = otras vetas
    // Include the one-cell border: a neighbouring coastline change invalidates both chunks.
    for (let y = startY - 1; y <= startY + CHUNK_ART_TILES; y++) for (let x = startX - 1; x <= startX + CHUNK_ART_TILES; x++) {
      const t = this.tileAt(x, y);
      if (!t) { h = Math.imul(h ^ -1, 16777619) >>> 0; continue; }
      const typeCode = (TERRAIN_SIG[t.terrain] ?? 0) | ((BIOME_SIG[t.biome ?? ''] ?? 0) << 4) | ((FEATURE_SIG[t.feature ?? ''] ?? 0) << 8);
      h = Math.imul(h ^ typeCode, 16777619) >>> 0;
      const growth = t.growth ?? 1, cult = t.cultivation ?? 0, dw = t.drinkingWater ?? 0;
      const foodTier = t.food < .3 ? 0 : Math.round(clamp01(t.food) * 3);
      const b1 = groundBucket(t.moisture) | (groundBucket(t.vegetation) << 4) | (foodTier << 8)
        | (groundBucket(growth) << 12) | (groundBucket(t.fertility ?? .5) << 16)
        | (groundBucket(cult) << 20) | (groundBucket(t.traffic ?? 0) << 24) | (groundBucket(dw) << 28);
      h = Math.imul(h ^ b1, 16777619) >>> 0;
      // Etapa del cultivo (arada → brote → hojas → madura): el trozo solo se rehornea al cruzar un umbral visual.
      h = Math.imul(h ^ (cropSignature(t) + 1), 16777619) >>> 0;
      // Preserve visible on/off boundaries even when both values share a coarse color bucket.
      const gEff = t.growth ?? t.vegetation;
      const flags = (cult > .08 ? 1 : 0) | (dw > .04 ? 2 : 0) | (t.moisture > .65 ? 4 : 0)
        | (gEff > .15 ? 8 : 0) | (gEff > .25 ? 16 : 0) | (t.vegetation > .04 ? 32 : 0)
        | ((t.life ?? 0) > .45 ? 64 : 0) | (t.vegetation > .25 ? 128 : 0)
        | (t.food > .3 ? 256 : 0) | (t.food > .72 ? 512 : 0)
        | ((t.wood ?? 0) > 0 ? 1024 : 0) | ((t.wood ?? 0) > .05 ? 2048 : 0)
        | (gEff > .55 && t.moisture > .35 ? 4096 : 0)
        | ((t.traffic ?? 0) >= .25 ? 8192 : 0) | ((t.paved ?? 0) >= .5 ? 16384 : 0) | ((t.paved ?? 0) > 0 ? 32768 : 0);
      h = Math.imul(h ^ flags, 16777619) >>> 0;
      const stock = (Math.round((t.wood ?? 0) * 2) & 0xff) | ((Math.round((t.stone ?? 0) * 2) & 0xff) << 8)
        | (((t.variety ?? 0) & 0xff) << 16) | ((t.elevation !== undefined ? Math.round(t.elevation * 32) & 0xff : 0) << 24);
      h = Math.imul(h ^ stock, 16777619) >>> 0;
    }
    return h;
  }

  /* ---------------------------------------------------------------- */
  /* Horneado del suelo                                               */
  /* ---------------------------------------------------------------- */

  private bakeGround(): void {
    if (this.worldW === 0 || this.worldH === 0) return;
    // Input objects may be reused by callers; palette memoization lasts only this bake.
    this.groundMaterials = new WeakMap();
    this.biomeFractions = new WeakMap();
    this.treeForms = new WeakMap();
    this.chunks = [];
    for (let cy = Math.floor(this.originY / CHUNK_ART_TILES); cy <= Math.floor((this.originY + this.worldH - 1) / CHUNK_ART_TILES); cy++) {
      for (let cx = Math.floor(this.originX / CHUNK_ART_TILES); cx <= Math.floor((this.originX + this.worldW - 1) / CHUNK_ART_TILES); cx++) {
        const x0 = cx * CHUNK_ART_TILES, y0 = cy * CHUNK_ART_TILES, key = `${cx}:${cy}`;
        const signature = this.chunkSignature(x0, y0);
        let chunk = this.terrainCache.get(key);
        if (!chunk || chunk.signature !== signature) {
          const canvas = chunk?.canvas ?? document.createElement('canvas');
          if (!chunk) { canvas.width = canvas.height = CHUNK_ART_TILES * ART; }
          const g = canvas.getContext('2d')!;
          g.clearRect(0, 0, canvas.width, canvas.height); g.save(); g.translate(-x0 * ART, -y0 * ART);
          for (let y = y0; y < y0 + CHUNK_ART_TILES; y++) for (let x = x0; x < x0 + CHUNK_ART_TILES; x++) {
            if (this.tileAt(x, y)) this.bakeTileBase(g, x, y);
          }
          for (let y = y0; y < y0 + CHUNK_ART_TILES; y++) for (let x = x0; x < x0 + CHUNK_ART_TILES; x++) {
            const tile = this.tileAt(x, y);
            if (tile) { this.bakeV20Ground(g, tile); this.bakeFeatures(g, tile); }
          }
          g.restore();
          if (chunk) { chunk.signature = signature; chunk.revision = ++this.cacheBuilds; }
          else { chunk = { key, signature, revision: ++this.cacheBuilds, canvas, x: x0, y: y0 }; this.terrainCache.set(key, chunk); }
        }
        // Sprite forms share this update's tile and neighbour state, even when the
        // ground raster itself came from the chunk cache.
        for (let y = y0; y < y0 + CHUNK_ART_TILES; y++) for (let x = x0; x < x0 + CHUNK_ART_TILES; x++) {
          const tile = this.tileAt(x, y);
          if (!tile || (tile.wood ?? 0) <= .05) continue;
          const form = treeForm(tile, this.biomeEdgeFraction(tile));
          if (form) this.treeForms.set(tile, form);
        }
        this.chunks.push(chunk);
      }
    }
    this.groundBaked = true; this.bakedSeed = this.worldSeed;
  }

  private groundMaterial(tile: Tile): GroundMaterial {
    const cached = this.groundMaterials.get(tile); if (cached) return cached;
    const fertility = groundValue(tile.fertility ?? .5), moisture = groundValue(tile.moisture);
    const cultivation = groundValue(tile.cultivation ?? 0), traffic = groundValue(tile.traffic ?? 0);
    const mineral = tile.biome === 'desert' ? P.sand : tile.biome === 'mountain' ? P.stoneShade : P.soilLight;
    const humus = tile.biome === 'wetland' ? mix(P.soilDark, P.mossHigh, .55) : darken(P.soil, .38);
    const green = tile.biome === 'wetland' ? mix(P.mossHigh, P.waterShallow, .25)
      : tile.biome === 'forest' ? mix(P.mossHigh, P.sageLow, .3) : mix(P.sageLow, P.mossHigh, .32);
    const material = {
      soil: darken(mix(mineral, humus, fertility * .72), moisture * .2),
      leaf: mix(green, P.sandDark, (1 - moisture) * .6),
      cover: tile.terrain === 'water' ? 0 : groundValue(tile.vegetation) * (1 - cultivation * .6) * (1 - traffic * .88) * (tile.terrain === 'shelter' ? .25 : 1),
      moisture, traffic: tile.terrain === 'water' ? 0 : traffic,
      biome: tile.biome ?? 'grassland', water: tile.terrain === 'water',
    };
    this.groundMaterials.set(tile, material); return material;
  }

  private biomeEdgeFraction(tile: Tile): number {
    const cached = this.biomeFractions.get(tile); if (cached !== undefined) return cached;
    if (!tile.biome) return 1;
    let same = 0;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      if (this.tileAt(tile.x + dx, tile.y + dy)?.biome === tile.biome) same++;
    }
    const fraction = Math.max(.4, same / 4);
    this.biomeFractions.set(tile, fraction);
    return fraction;
  }

  private bakeTileBase(g: CanvasRenderingContext2D, x: number, y: number): void {
    const tile = this.tileAt(x, y);
    if (!tile) return;
    const ox = x * ART;
    const oy = y * ART;
    const owner = this.groundMaterial(tile), samples: GroundMaterial[] = [];
    // Only the immediate 3 × 3 neighbours affect this cell and its one-pixel edges.
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const neighbour = this.tileAt(x + dx, y + dy);
      samples.push(neighbour ? this.groundMaterial(neighbour) : owner);
    }
    if (owner.water && samples.every(sample => sample.water)) {
      px(g, ox, oy, ART, ART, css(P.waterDeep));
      for (let i = 0; i < 2; i++) {
        const rx = ox + Math.floor(rnd(x, y, 10 + i) * ART);
        const ry = oy + Math.floor(rnd(x, y, 40 + i) * ART);
        px(g, rx, ry, 1 + Math.floor(rnd(x, y, 90 + i) * 2), 1, css(lighten(P.waterDeep, .1)));
      }
      return;
    }
    const stencil = prepareTerrainStencil(samples);
    const waveX0 = Math.floor(rnd(x, y, 10) * ART), waveY0 = Math.floor(rnd(x, y, 40) * ART);
    const waveX1 = Math.floor(rnd(x, y, 11) * ART), waveY1 = Math.floor(rnd(x, y, 41) * ART);
    const slopeShade = tile.elevation !== undefined
      ? clamp(Math.round(((this.tileAt(x - 1, y - 1)?.elevation ?? tile.elevation) - (this.tileAt(x + 1, y + 1)?.elevation ?? tile.elevation)) * 32), -7, 7)
      : 0;
    const pixel = newFieldPixel();
    const data = this.groundPixels.data;
    for (let by = 0; by < ART; by++) for (let bx = 0; bx < ART; bx++) {
      const wx = ox + bx, wy = oy + by;
      classifyTerrainPixel(wx, wy, x, y, stencil, pixel);
      const offset = (by * ART + bx) * 4;
      if (pixel.water) {
        const tone = waterDepthTone(wx, wy, x, y, stencil, pixel.waterValue);
        let color = mix(P.waterShallow, P.waterDeep, tone / 3);
        if ((bx === waveX0 && by === waveY0) || (bx === waveX1 && by === waveY1)) color = lighten(color, .1);
        data[offset] = color.r; data[offset + 1] = color.g; data[offset + 2] = color.b; data[offset + 3] = 255;
        continue;
      }
      if (pixel.sand) {
        const color = pixel.sandEdge ? P.sandDark : P.sand;
        data[offset] = color.r; data[offset + 1] = color.g; data[offset + 2] = color.b; data[offset + 3] = 255;
        continue;
      }
      let soilR = 0, soilG = 0, soilB = 0, leafR = 0, leafG = 0, leafB = 0, total = 0;
      for (let j = 0; j < 4; j++) {
        const sample = samples[pixel.corners[j]!]!;
        if (sample.water || sample.biome !== pixel.biome) continue;
        const weight = pixel.weights[j]!;
        soilR += sample.soil.r * weight; soilG += sample.soil.g * weight; soilB += sample.soil.b * weight;
        leafR += sample.leaf.r * weight; leafG += sample.leaf.g * weight; leafB += sample.leaf.b * weight;
        total += weight;
      }
      if (total > 0) { soilR /= total; soilG /= total; soilB /= total; leafR /= total; leafG /= total; leafB /= total; }
      else { soilR = owner.soil.r; soilG = owner.soil.g; soilB = owner.soil.b; leafR = owner.leaf.r; leafG = owner.leaf.g; leafB = owner.leaf.b; }
      const grainSeed = rnd(wx, wy, 358);
      const pigment = pixel.grass && !pixel.wear ? 1 : pixel.grass && pixel.wear ? .35 : 0;
      const grain = (grainSeed - .5) * (pixel.wear ? 1 : 4);
      // Sparse fibres and granules live on a world lattice incommensurate with
      // cells. They symbolize existing cover/soil, never countable extra plants.
      const fx = Math.floor(wx / 5), fy = Math.floor(wy / 7);
      const tx = fx * 5 + Math.floor(rnd(fx, fy, 364) * 5), ty = fy * 7 + 2 + Math.floor(rnd(fx, fy, 365) * 4);
      const fibre = pixel.grass && !pixel.wear && rnd(fx, fy, 366) < pixel.cover * .8 && wx === tx && wy >= ty - 1 && wy <= ty;
      const granule = !pixel.grass && grainSeed < .035 ? (owner.moisture > .5 ? -8 : 8) : 0;
      const relief = Math.round((pixel.fine - .5) * 3) * 3 + (pixel.fine - .5) * 6 + grain + granule + (fibre ? 15 : 0) + slopeShade;
      const edge = pixel.grassEdge ? -12 : pixel.wearEdge ? -9 : 0;
      data[offset] = soilR + (leafR - soilR) * pigment + (pixel.wear ? 9 : 0) + relief + edge;
      data[offset + 1] = soilG + (leafG - soilG) * pigment + (pixel.wear ? 6 : 0) + relief + edge;
      data[offset + 2] = soilB + (leafB - soilB) * pigment + (pixel.wear ? 3 : 0) + relief + edge;
      data[offset + 3] = 255;
    }
    this.groundStampContext.putImageData(this.groundPixels, 0, 0);
    g.drawImage(this.groundStamp, ox, oy);
  }

  /** V20: vetas minerales y caminos (senda/calzada) sobre el suelo; se hornean con el trozo, cero coste por fotograma. */
  private bakeV20Ground(g: CanvasRenderingContext2D, tile: Tile): void {
    paintGeologyVeins(g, tile, this.worldSeed);
    paintRoadTile(g, tile, { n: this.tileAt(tile.x, tile.y - 1), e: this.tileAt(tile.x + 1, tile.y), s: this.tileAt(tile.x, tile.y + 1), w: this.tileAt(tile.x - 1, tile.y) });
  }

  private isCropAt(x: number, y: number): boolean { const t = this.tileAt(x, y); return t !== undefined && cropStage(t) !== null; }

  /** Resource art follows server stock/growth. Depleted resources do not remain lush props. */
  private bakeFeatures(g: CanvasRenderingContext2D, tile: Tile): void {
    const { x, y } = tile, ox = x * ART, oy = y * ART;
    const growth = clamp01(tile.growth ?? tile.vegetation);
    if (tile.terrain === 'water') { this.drawReeds(g, x, y, ox, oy, 0); return; }
    const edge = this.biomeEdgeFraction(tile);
    const stage = cropStage(tile);
    if (stage !== null) {
      const inGrid = this.tileAt(x, y) === tile;
      paintCropField(g, tile, stage, ART, inGrid && this.isCropAt(x - 1, y), inGrid && this.isCropAt(x + 1, y));
    }
    const water = clamp01(tile.drinkingWater ?? 0);
    const reservoir = tile.feature === 'spring' || tile.feature === 'pool';
    if (water > .04 && (reservoir || tile.biome === 'wetland' || tile.moisture > .65)) {
      this.bakePuddleField(g, tile, ox, oy, water, reservoir);
    }
    const feature = tile.feature;
    if (reservoir && water <= .04) {
      ellipse(g, ox+9, oy+10, 5, 3, css(P.soilDark)); ellipse(g, ox+9, oy+9, 4, 2, css(P.soilLight));
      px(g,ox+8,oy+8,1,3,css(P.soilDark)); px(g,ox+6,oy+10,3,1,css(P.soilDark));
    }
    if (feature === 'stump') {
      ellipse(g, ox+8, oy+12, 4, 1.5, css(P.shadow,.22));
      px(g, ox+5, oy+8, 6, 4, css(P.trunk)); px(g, ox+6, oy+8, 4, 2, css(P.soilLight)); px(g, ox+7, oy+8, 2, 1, css(P.trunkLight));
      if (growth > .25) px(g,ox+11,oy+6,1,4,css(P.reedLight));
    } else if (feature === 'cactus') {
      const h = Math.max(2, Math.round((3 + growth*8) * edge)), color = css(mix(P.canopyDark,P.reed,growth));
      px(g,ox+7,oy+12-h,3,h,color);
      if (h >= 7) {
        const leftY = oy + 12 - Math.round(h * .45), rightY = oy + 12 - Math.round(h * .27);
        px(g,ox+4,leftY,4,2,color); px(g,ox+4,leftY-3,2,4,color);
        px(g,ox+9,rightY,4,2,color); px(g,ox+11,rightY-3,2,4,color);
      }
      px(g,ox+8,oy+13-h,1,h-2,css(P.reedLight));
      if (tile.food > .3) px(g,ox+7,oy+11-h,2,1,css(P.berryLight));
    } else if (feature === 'rock' || feature === 'clay') {
      const stock = feature === 'rock' ? (tile.stone ?? 0) : (tile.fertility ?? .6) * 8;
      if (stock > .2) {
        const size = Math.min(5, 2 + Math.min(stock / 3, 2.5) + rnd(x,y,2600) - .5) * edge;
        const cx = ox + 4 + Math.floor(rnd(x,y,2601)*9);
        const cy = oy + 5 + Math.floor(rnd(x,y,2602)*7);
        const aspect = .55 + rnd(x,y,2603)*.28;
        const color = feature === 'clay' ? mix(P.soilDark,P.coralDeep,.22) : P.stone;
        ellipse(g,cx,cy+2,size+1,Math.max(1,1.8*edge),css(P.shadow,.2));
        ellipse(g,cx,cy,size,size*aspect,css(darken(color,.2)));
        ellipse(g,cx-1,cy-1,size*.8,size*aspect*.72,css(color));
        px(g,cx-2,cy-2,Math.max(1,Math.round(size*.6)),1,css(lighten(color,.2)));
      }
    } else if (feature === 'reeds') {
      const count = Math.max(1, Math.round((3 + growth * 2) * edge));
      for (let i = 0; i < count; i++) {
        const h = 3 + Math.round(growth * 4) + (hash3(x, y, 801 + i) & 1);
        const rx = ox + 2 + Math.floor(rnd(x, y, 810 + i * 11) * 12);
        const ry = oy + 5 + Math.floor(rnd(x, y, 825 + i * 13) * 9);
        const lean = (hash3(x, y, 840 + i) % 3) - 1;
        px(g, rx, ry - h + 2, 1, Math.max(1, h - 2), css(P.reed));
        px(g, rx + lean, ry - h, 1, 2, css(P.reedLight));
        if (hash3(x, y, 860 + i) % 3 === 0) {
          px(g, rx + lean, ry - h + 1, 1, 2, '#6b4c2b');
        }
      }
    } else if (feature === 'flowers') {
      for(let i=0;i<Math.max(1,Math.round((3+growth*4)*edge));i++){const fx=ox+2+Math.floor(rnd(x,y,1800+i)*12),fy=oy+3+Math.floor(rnd(x,y,1850+i)*10); px(g,fx,fy,1,2,css(P.reed));px(g,fx-1,fy-1,3,1,css(i%2?P.paper:P.berryLight));px(g,fx,fy-2,1,3,css(i%2?P.amber:P.coral));}
    }
    if (feature === 'berries' || (!feature && tile.food > .3)) this.drawBerries(g,x,y,ox,oy,tile.food,0);
    // A reservoir, bare patch or building may retain legacy wood without a living
    // tree feature. Show the actual deposit; never turn its water/rock into a tree.
    if ((tile.wood ?? 0) > 0 && !treeForm(tile) && !['stump', 'reeds', 'cactus'].includes(feature ?? 'none')) {
      // Match the ground-cache stock buckets, keeping positive remnants visible with subtle world jitter.
      const stock = Math.min(12, Math.max(.5, Math.round(tile.wood! * 2) / 2)), pieces = Math.min(3, Math.ceil(stock / 4));
      const jx = Math.floor(rnd(x, y, 2701) * 4), jy = Math.floor(rnd(x, y, 2702) * 2);
      for (let i = 0; i < pieces; i++) {
        const width = Math.max(2, Math.round(2 + Math.sqrt(stock / 12) * 5));
        px(g, ox+1+jx+i*2, oy+11+jy+i, width, 2, css(P.trunk));
        px(g, ox+1+jx+i*2, oy+11+jy+i, width, 1, css(P.trunkLight));
        px(g, ox+jx+i*2, oy+11+jy+i, 1, 2, css(P.soilLight));
      }
    }
    if ((tile.life ?? 0) > .45 && tile.vegetation > .25) {
      for(let i=0;i<3;i++) px(g, ox+2+Math.floor(rnd(x,y,1900+i)*12), oy+2+Math.floor(rnd(x,y,1920+i)*12), 1, 1, css(P.grassLight,.8));
    }
  }

  /**
   * Continuous 3×3 surface-water puddle field ("charcos").
   * Neighboring tiles with potable surface water coalesce across cell edges via shared 2×2 corner
   * bilinear weights + world-space basin micro-topography, while isolated pools/springs (and standalone
   * unit-test calls where `tile` is not in `this.grid`) retain a guaranteed local pool away from the
   * bottom-left wood deposit (`bx <= 7, by >= 12`).
   */
  private bakePuddleField(
    g: CanvasRenderingContext2D,
    tile: Tile,
    ox: number,
    oy: number,
    water: number,
    reservoir: boolean,
  ): void {
    const { x, y } = tile;
    const inGrid = this.tileAt(x, y) === tile;
    const cellStrength = (t: Tile | undefined): number => {
      if (!t) return 0;
      if (t.terrain === 'water') return 0.85;
      const w = clamp01(t.drinkingWater ?? 0);
      const res = t.feature === 'spring' || t.feature === 'pool';
      if (w <= 0.04 || !(res || t.biome === 'wetland' || t.moisture > 0.65)) return 0;
      return Math.min(1, (res ? 0.38 : 0.14) + Math.sqrt(w) * 0.48);
    };
    const w3 = PUDDLE_W3;
    w3.fill(0);
    w3[4] = Math.min(1, (reservoir ? 0.38 : 0.14) + Math.sqrt(water) * 0.48);
    let neighborCount = 0;
    if (inGrid) {
      let idx = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, idx++) {
          if (idx === 4) continue;
          const s = cellStrength(this.tileAt(x + dx, y + dy));
          w3[idx] = s;
          if (s > 0) neighborCount++;
        }
      }
    }

    const mudColor = css(P.soilDark, 0.82);
    const shallowColor = css(P.waterShallow);
    const deepColor = css(mix(P.waterShallow, P.waterDeep, 0.45));
    const gleamColor = css(P.waterGleam, 0.65);

    // Local spring/pool kernel center (kept in upper-right quadrant around (10,9) so bottom-left wood deposits stay visible)
    const cx = 9.8 + (rnd(x, y, 503) - 0.5) * 2.2;
    const cy = 8.8 + (rnd(x, y, 507) - 0.5) * 2.0;
    const rx = 2.5 + water * 3.2;
    const ry = 1.7 + water * 2.2;
    const hasCore = reservoir || neighborCount === 0;
    const coreScale = 0.54 + water * 0.34;

    // Precompute the smooth low-frequency basin wave (28px & 11px lattices) on a 5×5 corner lattice
    // (step 4px → 25 evaluations instead of 256) and bilinearly interpolate across each 4×4 pixel block.
    const depr = PUDDLE_DEPR;
    for (let gy = 0; gy <= 4; gy++) {
      const wy = oy + gy * 4;
      for (let gx = 0; gx <= 4; gx++) {
        const wx = ox + gx * 4;
        depr[gy * 5 + gx] = materialNoise(wx, wy, 28, 509) * 0.64 + materialNoise(wx, wy, 11, 521) * 0.36;
      }
    }

    const fieldAt = (bx: number, by: number, depression: number): number => {
      const wx = ox + bx, wy = oy + by;
      const left = bx < 8 ? 0 : 1, top = by < 8 ? 0 : 1;
      const u = (bx + 8.5) / ART - left;
      const v = (by + 8.5) / ART - top;
      const i0 = top * 3 + left;
      const a = w3[i0]!, b = w3[i0 + 1]!, c = w3[i0 + 3]!, d = w3[i0 + 4]!;
      const wa = (1 - u) * (1 - v), wb = u * (1 - v), wc = (1 - u) * v, wd = u * v;
      let base = a * wa + b * wb + c * wc + d * wd;
      if (a > 0 && d > 0 && b === 0 && c === 0) {
        base = Math.max(base, Math.min(a, d) * (0.58 - Math.abs(u - v) * 0.42));
      } else if (b > 0 && c > 0 && a === 0 && d === 0) {
        base = Math.max(base, Math.min(b, c) * (0.58 - Math.abs(u + v - 1) * 0.42));
      }
      const fine = rnd(wx, wy, 533) - 0.5;
      let val = base * 0.88 + (depression - 0.54) * 0.82 + fine * 0.08;

      // Local pool core guarantees springs/pools and isolated puddle tiles always show a distinct water pool
      if (hasCore) {
        const dx = (bx + 0.5 - cx) / rx;
        const dy = (by + 0.5 - cy) / ry;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < 1.32) {
          const core = (1.14 - dist2) * coreScale + fine * 0.07;
          if (core > val) val = core;
        }
      }
      return val;
    };

    const grid = PUDDLE_GRID;
    for (let by = 0; by < ART; by++) {
      const gy = by >> 2, ty = (by & 3) * 0.25, r0 = gy * 5, r1 = r0 + 5;
      for (let bx = 0; bx < ART; bx++) {
        const gx = bx >> 2, tx = (bx & 3) * 0.25;
        const d00 = depr[r0 + gx]!, d10 = depr[r0 + gx + 1]!, d01 = depr[r1 + gx]!, d11 = depr[r1 + gx + 1]!;
        const depression = (d00 + (d10 - d00) * tx) * (1 - ty) + (d01 + (d11 - d01) * tx) * ty;
        grid[by * ART + bx] = fieldAt(bx, by, depression);
      }
    }

    for (let by = 0; by < ART; by++) {
      for (let bx = 0; bx < ART; bx++) {
        const f = grid[by * ART + bx]!;
        if (f <= 0.33) continue;
        const wx = ox + bx, wy = oy + by;
        if (f <= 0.40) {
          px(g, wx, wy, 1, 1, mudColor);
        } else if (f <= 0.52) {
          px(g, wx, wy, 1, 1, shallowColor);
          const above = by > 0
            ? grid[(by - 1) * ART + bx]!
            : fieldAt(bx, -1, materialNoise(wx, wy - 1, 28, 509) * 0.64 + materialNoise(wx, wy - 1, 11, 521) * 0.36);
          if (above <= 0.40 && (wx & 1) === 0 && (hash3(wx >> 1, wy, 541) % 5) === 0) {
            px(g, wx, wy, 1, 1, gleamColor);
          }
        } else {
          px(g, wx, wy, 1, 1, deepColor);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Cámara                                                           */
  /* ---------------------------------------------------------------- */

  private recomputeMinZoom(): void {
    // The window cap bounds work, not geography. Zoom-out must fit within 96 × 64 tiles.
    this.minZoom = Math.max(10, this.cssW / 88, this.cssH / 56);
  }

  /** Encuadre inicial: llena el panel y, aun así, cabe la isla entera. */
  private fitWorld(): void {
    this.recomputeMinZoom();
    this.cam.zoom = Math.max(this.minZoom, this.cssW < 600 ? 24 : 32);
    const person = this.curr?.people.find(p => p.role === 'S') ?? this.home;
    this.cam.x = person ? person.x + 0.5 : this.originX + this.worldW / 2;
    this.cam.y = person ? person.y + 0.5 : this.originY + this.worldH / 2;
    this.clampCamera();
  }

  private setZoom(next: number, anchorCssX: number, anchorCssY: number): void {
    const z = clamp(next, this.minZoom, MAX_ZOOM);
    if (z === this.cam.zoom) return;
    const before = this.screenToWorld(anchorCssX, anchorCssY);
    this.cam.zoom = z;
    const after = this.screenToWorld(anchorCssX, anchorCssY);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCamera();
  }

  private clampCamera(): void {
    this.cam.x = clamp(this.cam.x, -9_999_950, 9_999_950);
    this.cam.y = clamp(this.cam.y, -9_999_950, 9_999_950);
  }

  private reportViewport(): void {
    if (!this.curr) return;
    const width = Math.min(96, Math.ceil(this.cssW / this.cam.zoom) + 6);
    const height = Math.min(64, Math.ceil(this.cssH / this.cam.zoom) + 6);
    const viewport = { x: Math.floor(this.cam.x - width / 2), y: Math.floor(this.cam.y - height / 2), width, height };
    const signature = JSON.stringify(viewport);
    if (signature === this.reportedViewport) return;
    this.reportedViewport = signature;
    this.cameraMovedAt = performance.now();
    this.onViewport?.(viewport);
  }

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.cssW / 2) / this.cam.zoom + this.cam.x,
      y: (sy - this.cssH / 2) / this.cam.zoom + this.cam.y,
    };
  }

  private worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.cam.x) * this.cam.zoom + this.cssW / 2,
      y: (wy - this.cam.y) * this.cam.zoom + this.cssH / 2,
    };
  }

  private tickFocus(now: number): void {
    const to = this.focusTo;
    const from = this.focusFrom;
    if (!to || !from) return;
    const k = clamp01((now - this.focusStart) / FOCUS_MS);
    const e = 1 - Math.pow(1 - k, 3);
    this.cam.x = from.x + (to.x - from.x) * e;
    this.cam.y = from.y + (to.y - from.y) * e;
    this.clampCamera();
    if (k >= 1) {
      this.focusTo = null;
      this.focusFrom = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Interpolación                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * V18: cada cuerpo se desliza desde DONDE SE VE hacia su casilla nueva durante la duración medida del paso
   * del servidor (`MotionTracker`); ya no «salta» cuando llega un estado. Con movimiento reducido se coloca.
   */
  private interpolatePeople(now: number): RenderPerson[] {
    const world = this.curr;
    if (!world) return [];
    // T137: `prevPeople` solo conserva ids del frame actual; sin esto acumula huérfanos.
    const currentIds = new Set(world.people.map(p => p.id));
    for (const id of this.prevPeople.keys()) if (!currentIds.has(id)) this.prevPeople.delete(id);
    const smooth = !this.reduceMotion;
    const out: RenderPerson[] = [];
    for (const p of world.people) {
      const shown = smooth ? this.peopleMotion.sample(p.id, now) : undefined; // `now` = reloj virtual del colchón
      out.push({ view: p, x: shown ? shown.x : p.x, y: shown ? shown.y : p.y, moving: shown ? shown.moving : false, seed: shown ? shown.seed : bodySeed(p.id), stride: shown ? shown.stride : 0 });
    }
    return out;
  }

  private interpolateAnimals(now: number): RenderAnimal[] {
    const smooth = !this.reduceMotion;
    return (this.curr?.animals ?? []).map(view => {
      const shown = smooth ? this.animalMotion.sample(view.id, now) : undefined;
      if (shown) return { view, x: shown.x, y: shown.y, moving: shown.moving, left: shown.left, stride: shown.stride };
      const before = this.prevAnimals.get(view.id), dx = before ? view.x - before.x : 0;
      const defaultLeft = (hash3(view.id.length, view.id.charCodeAt(0) | 0, view.id.charCodeAt(view.id.length - 1) | 0) & 1) === 1;
      return { view, x: view.x, y: view.y, moving: false, left: dx !== 0 ? dx < 0 : defaultLeft, stride: 0 };
    });
  }

  /** Posición visual de un cuerpo seguido por la cámara (sin construir la lista de todos). */
  private bodyPosition(id: string, kind: 'person' | 'animal', now: number): { x: number; y: number } | undefined {
    const shown = this.reduceMotion ? undefined : (kind === 'animal' ? this.animalMotion : this.peopleMotion).sample(id, now);
    if (shown) return shown;
    return kind === 'animal' ? this.curr?.animals?.find(a => a.id === id) : this.curr?.people.find(p => p.id === id);
  }

  /* ---------------------------------------------------------------- */
  /* Bucle de dibujo                                                  */
  /* ---------------------------------------------------------------- */

  private frame(now: number): void {
    if (this.destroyed) return;
    // R5: tope de fps por `this.modo` (ver `rendererProfile`, sin DOM). P1 observador: 30 fps
    // (mitad de un rAF típico de 60 Hz) y sin interpolar — reutiliza `reduceMotion`, que ya
    // congela la pose y detiene la interpolación en todo el resto. Completo no tiene tope propio.
    const fpsCap = rendererProfile(this.modo).fpsCap;
    if (fpsCap !== null) {
      this.reduceMotion = true;
      if (now - this.lastFrameAt < 1000 / fpsCap) { this.raf = requestAnimationFrame((t) => this.frame(t)); return; }
    }
    this.lastFrameAt = now;
    this.tickFocus(now);
    if (!this.reduceMotion && !this.dvrMode) {
      this.syncPlaybackCamera(); this.playback.advance(now, this.cadence.tickIntervalMs);
      // Los fotogramas que el colchón libera alimentan a los rastreadores: cada casilla se reparte en ≈ 5,2 pasos y el servidor, aunque se atrase, no deja a nadie parado.
      for (const frame of this.playback.takeReleased()) {
        this.peopleMotion.ingest(frame.view.people, this.playback.visualMs);
        this.animalMotion.ingest(frame.view.animals ?? [], this.playback.visualMs);
      }
    }
    // Reloj con el que se muestrean los cuerpos (el virtual del colchón); con movimiento reducido no se interpola.
    this.motionClock = this.dvrMode ? performance.now() : this.playback.visualMs;
    if (this.followedId) {
      const body = this.bodyPosition(this.followedId, this.followedKind, this.motionClock);
      if (body) { this.cam.x = body.x + 0.5; this.cam.y = body.y + 0.5; }
    }
    this.reportViewport();
    this.ensureWindow(now);
    const renderAt = performance.now();
    this.render(now);
    const elapsed = performance.now() - renderAt;
    this.frameMs = this.frameMs === 0 ? elapsed : this.frameMs * .9 + elapsed * .1;
    this.fpsFrames++;
    if (!this.fpsAt) this.fpsAt = now;
    if (now - this.fpsAt >= 750) { this.fps = this.fpsFrames * 1000 / (now - this.fpsAt); this.fpsFrames = 0; this.fpsAt = now; }
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private render(now: number): void {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw === 0 || ch === 0) return;

    // Neutral fog means this part of the projection has not arrived. It is never invented sea.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawCalls = 0;
    const accelerated = this.gpu?.render(this.chunks, { ...this.cam, width: this.cssW, height: this.cssH, dpr: this.dpr }) ?? false;
    ctx.clearRect(0, 0, cw, ch);
    this.labelCtx.setTransform(1,0,0,1,0,0); this.labelCtx.clearRect(0,0,cw,ch);
    if (!accelerated) {
      ctx.fillStyle = '#425f50'; ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = false;
      for (const chunk of this.chunks) {
        const x = Math.round((this.cssW/2+(chunk.x-this.cam.x)*this.cam.zoom)*this.dpr);
        const y = Math.round((this.cssH/2+(chunk.y-this.cam.y)*this.cam.zoom)*this.dpr);
        const x1 = Math.round((this.cssW/2+(chunk.x+CHUNK_ART_TILES-this.cam.x)*this.cam.zoom)*this.dpr);
        const y1 = Math.round((this.cssH/2+(chunk.y+CHUNK_ART_TILES-this.cam.y)*this.cam.zoom)*this.dpr);
        if (x1 < 0 || y1 < 0 || x > cw || y > ch) continue;
        ctx.drawImage(chunk.canvas,x,y,x1-x,y1-y); this.drawCalls++;
      }
    }

    const world = this.curr;
    if (world && this.groundBaked && this.worldW > 0) {
      const t = now / 1000;
      this.actionActive = !world.paused && now - this.currAt < Math.max(1200, this.interval * 2);
      // V18: la fase del día y la lluvia se acercan a lo recibido en ~1,5 s en vez de saltar entre amanecer/día/noche.
      if (this.reduceMotion) this.atmosphere.reset();
      // Con colchón, la luz y la lluvia siguen al mismo instante A→B que se dibuja (no al más reciente).
      const shownTime = this.reduceMotion || this.dvrMode ? null : this.playback.bracket();
      const shownTick = this.reduceMotion || this.dvrMode ? world.tick : this.playback.shownTick(world.tick);
      const shownWeather = shownTime ? (shownTime.alpha < .5 ? shownTime.a.view : shownTime.b.view).weather : world.weather;
      const light = this.atmosphere.step(daylightAt(shownTick), shownWeather === 'rain', now);
      this.lighting = { shadowX: light.shadowX, shadowY: light.shadowY, shadowAlpha: light.shadowAlpha * (1 - .6 * light.rain) };
      const people = this.interpolatePeople(this.motionClock);
      const animals = this.interpolateAnimals(this.motionClock);
      this.drawScene(world, people, animals, t);

      // Volcado nítido de la escena al panel.
      const scale = (this.cam.zoom / ART) * this.dpr;
      const originX = (this.cssW / 2 + (this.originX - this.cam.x) * this.cam.zoom) * this.dpr;
      const originY = (this.cssH / 2 + (this.originY - this.cam.y) * this.cam.zoom) * this.dpr;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        this.scene,
        Math.round(originX),
        Math.round(originY),
        Math.round(this.scene.width * scale),
        Math.round(this.scene.height * scale),
      );
      this.drawCalls++;

      this.drawAmbient(cw, ch, now, light);
      this.drawOverlaysScreen(people, animals);
    }
  }

  private drawScene(world: WorldView, people: RenderPerson[], animals: RenderAnimal[], t: number): void {
    const g = this.sceneCtx;

    // Ventana visible en tiles (con holgura para copas altas).
    const halfW = this.cssW / this.cam.zoom / 2;
    const halfH = this.cssH / this.cam.zoom / 2;
    const x0 = Math.max(this.originX, Math.floor(this.cam.x - halfW) - 1);
    const x1 = Math.min(this.originX + this.worldW - 1, Math.ceil(this.cam.x + halfW) + 1);
    const y0 = Math.max(this.originY, Math.floor(this.cam.y - halfH) - 3);
    const y1 = Math.min(this.originY + this.worldH - 1, Math.ceil(this.cam.y + halfH) + 3);

    // Pixel-art decoration needs only eight poses/s. Moving people retain full RAF interpolation.
    // With reduced motion, a stationary snapshot costs one cached scene composite per frame.
    const pose = people.some(person => person.moving) || animals.some(animal => animal.moving) ? t : this.reduceMotion ? 0 : Math.floor(t * 8);
    const selectedBody = this.selection?.kind === 'animal' ? this.selection.id : '';
    const selectedTile = this.selection?.kind === 'tile' ? this.selection : null;
    const far = this.cam.zoom < FAR_ZOOM;
    const sceneKey = `${this.sceneRevision}:${this.layer}:${this.capaCalor ?? ''}:${this.vivasKey}:${x0}:${x1}:${y0}:${y1}:${pose}:${selectedBody}:${selectedTile?.x}:${selectedTile?.y}:${far ? 'far' : 'near'}`;
    if (sceneKey === this.sceneKey) return;
    this.sceneKey = sceneKey; this.perf.sceneBuilds++;
    g.clearRect(0, 0, this.scene.width, this.scene.height);
    g.save(); g.translate(-this.originX * ART, -this.originY * ART);

    // Mapa de calor: sobre el terreno ya pintado (los chunks van al lienzo principal)
    // y debajo de decoración, animales y personas de esta escena.
    pintarCalor(g, this.teselasVisibles(x0, x1, y0, y1), this.capaCalor, this.rangoCalor);

    this.effects.water = this.effects.vegetation = this.effects.shadows = 0;
    this.visibleAnimals = 0; this.visibleStructures = 0;
    // V22: lo que solo depende de rejilla + estructuras + ventana se calcula una vez por cambio, no por fotograma.
    const props = this.scenePropsFor(world, x0, x1, y0, y1);
    this.visibleTiles = props.visibleTiles;
    for (const item of props.animated) {
      if (item.kind === 0) {
        if (this.effects.water < VISUAL_BUDGET.water) { this.drawRipples(g, item.x, item.y, item.x * ART, item.y * ART, t); this.effects.water++; }
      } else if (item.kind === 1) {
        if (this.effects.water < VISUAL_BUDGET.water) {
          const shift = this.reduceMotion ? 0 : Math.floor(t * 2 + rnd(item.x, item.y, 917) * 4) % 3;
          px(g, item.x * ART + 8 + shift, item.y * ART + 10, 2, 1, css(P.waterGleam, .55)); this.effects.water++;
        }
      } else if (!far) this.drawPlantMovement(g, item.tile, t); // < 14 px/tesela una caña de 1 px no se distingue
    }

    this.drawPlaces(g, world.places, x0, x1, y0, y1);

    // Sprites vivos: estructuras, animales y personas (y la fauna antigua en zoom lejano, que sí se anima por reloj).
    const dynamic: Sprite[] = far ? props.fauna.slice() : [];
    for (const structure of world.structures ?? []) {
      const box = footprintBox(structure as ExtendedStructure);
      if (box.x0 + box.w - 1 < x0 || box.x0 > x1 || box.y0 + box.h - 1 < y0 || box.y0 > y1) continue;
      this.visibleStructures++;
      const foot = structureExtent(structure as ExtendedStructure).foot;
      dynamic.push({ kind: SpriteKind.Structure, sortY: foot, ax: (box.x0 + box.w / 2) * ART, ay: foot, seed: 0, size: 0, person: null, structure });
    }
    for (const animal of animals) {
      if (animal.x < x0 || animal.x > x1 || animal.y < y0 || animal.y > y1) continue;
      this.visibleAnimals++;
      dynamic.push({ kind: SpriteKind.Animal, sortY: animal.y * ART + 12, ax: animal.x * ART + 8, ay: animal.y * ART + 12, seed: 0, size: 0, person: null, animal });
    }

    for (const p of people) {
      if (p.x < x0 - 2 || p.x > x1 + 2 || p.y < y0 - 2 || p.y > y1 + 2) continue;
      const ax = p.x * ART + ART / 2;
      const ay = p.y * ART + ART / 2 + 4;
      dynamic.push({ kind: SpriteKind.Person, sortY: ay, ax, ay, seed: p.seed, size: 0, person: p });
    }

    // Y-sort: quien está más al sur tapa a quien está al norte. Lo estático ya viene ordenado: solo se ordena lo vivo (≈ cientos)
    // y se fusiona (a igualdad de `sortY` gana lo estático, igual que el orden de inserción de antes).
    dynamic.sort((a, b) => a.sortY - b.sortY);
    let sprites: Sprite[];
    if (far) {
      // Zoom lejano: arbolado y cabañas = UNA capa estática (un `drawImage`); encima, solo lo que se mueve o cambia.
      this.blitCanopy(g, props, x0, x1, y0, y1);
      sprites = dynamic;
    } else sprites = mergeBySortY(props.sprites, dynamic);
    this.perf.spritesSorted += dynamic.length;
    if (this.cam.zoom >= 18) {
      for (const sprite of sprites) if (this.effects.shadows < VISUAL_BUDGET.shadows && (sprite.kind === SpriteKind.Structure || sprite.kind === SpriteKind.Person)) this.drawCastShadow(g, sprite);
      for (const sprite of sprites) if (this.effects.shadows < VISUAL_BUDGET.shadows && sprite.kind === SpriteKind.Tree && sprite.seed % 13 === 0) this.drawCastShadow(g, sprite);
    }
    const inspectedAnimal = selectedBody ? animals.find(a=>a.view.id===selectedBody) : undefined;
    const inspectedStructures = selectedTile ? (world.structures ?? []).filter(s => footprintCells(s as ExtendedStructure).some(c => c.x === selectedTile.x && c.y === selectedTile.y)) : [];
    const siteTile = selectedTile ? this.tileAt(selectedTile.x, selectedTile.y) : undefined;
    const inspectedWater = siteTile && !inspectedStructures.length && (siteTile.terrain === 'water'
      || (siteTile.drinkingWater ?? 0) > 0 && (siteTile.feature === 'pool' || siteTile.feature === 'spring')) ? siteTile : undefined;
    const site = selectedTile && (inspectedStructures.length || inspectedWater) ? {
      left: selectedTile.x * ART + (inspectedStructures.length ? -8 : 0),
      right: selectedTile.x * ART + (inspectedStructures.length ? 24 : 16),
      top: selectedTile.y * ART + (inspectedStructures.length ? -16 : 0), bottom: selectedTile.y * ART + 16,
      foot: selectedTile.y * ART + 13,
    } : null;
    const revealedBodies: (RenderPerson | RenderAnimal)[] = inspectedAnimal ? [...people, inspectedAnimal] : people;
    const coveredPeople = new Set<string>();
    // V22: `behind()` mira solo los cuerpos de las celdas que el sprite puede tocar (rejilla espacial), no a todos.
    // En zoom lejano (< 14 px/tesela) los recortes miden menos de un píxel: se omiten (queda el recorte de la selección).
    if (!far) this.indexBodies(revealedBodies, x0, x1, y0, y1);
    const bodyGrid = this.bodyGridInfo;
    const behind = (sprite: Sprite, height: number, width: number) => {
      let intersects = !!site && sprite.ay > site.foot && sprite.ax + width / 2 > site.left
        && sprite.ax - width / 2 < site.right && sprite.ay > site.top && sprite.ay - height < site.bottom;
      if (far) { this.perf.behindSkipped++; return intersects; }
      this.perf.behindQueries++;
      const halfW = width / 2 + 4;
      const cx0 = Math.floor((sprite.ax - halfW) / ART) - bodyGrid.gx0, cx1 = Math.floor((sprite.ax + halfW) / ART) - bodyGrid.gx0;
      const cy0 = Math.floor((sprite.ay - height - 2) / ART) - bodyGrid.gy0, cy1 = Math.floor(sprite.ay / ART) - bodyGrid.gy0;
      const test = (body: RenderPerson | RenderAnimal): void => {
        this.perf.behindCandidateTests++;
        const x = body.x * ART + 8, foot = body.y * ART + 12;
        if (foot < sprite.ay && Math.abs(x - sprite.ax) < width / 2 + 4
          && foot + 2 > sprite.ay - height && foot - 14 < sprite.ay - 8) {
          intersects = true;
          if ('role' in body.view) coveredPeople.add(body.view.id);
        }
      };
      for (let cy = Math.max(0, cy0); cy <= Math.min(bodyGrid.gh - 1, cy1); cy++) for (let cx = Math.max(0, cx0); cx <= Math.min(bodyGrid.gw - 1, cx1); cx++) {
        for (let i = this.bodyHead[cy * bodyGrid.gw + cx]!; i >= 0; i = this.bodyNext[i]!) test(revealedBodies[i]!);
      }
      // Cuerpos fuera de la rejilla solo cuentan si el sprite también sale de ella (estructuras enormes en el borde).
      if ((cx0 < 0 || cy0 < 0 || cx1 >= bodyGrid.gw || cy1 >= bodyGrid.gh) && bodyGrid.outside.length) for (const i of bodyGrid.outside) test(revealedBodies[i]!);
      return intersects;
    };
    for (const s of sprites) {
      if (s.kind === SpriteKind.Tree) {
        this.drawCachedTree(g, s, t, behind(s, s.tree!.height, s.tree!.width));
      }
      else if (s.kind === SpriteKind.Hut) this.drawHut(g, s.ax, s.ay, s.seed);
      else if (s.animal) this.drawAnimal(g, s.animal, t);
      else if (s.structure) {
        const extent = structureExtent(s.structure as ExtendedStructure);
        const hidden = behind(s, Math.max(28, extent.foot - extent.top), Math.max(30, extent.right - extent.left));
        if (hidden) { g.save(); g.globalAlpha = .45; }
        this.drawStructure(g, s.structure, t);
        if (hidden) g.restore();
      }
      else if (s.tile) this.drawFauna(g, s.tile, t);
      else if (s.person) this.drawPerson(g, s.person, t);
    }
    // A selected facility or water patch is a local cutaway, like the existing body reveal.
    // Redraw received material within its footprint; no state, roots or hit targets change.
    if (site) {
      g.save(); g.beginPath(); g.rect(site.left, site.top, site.right - site.left, site.bottom - site.top); g.clip();
      if (inspectedWater) { this.bakeTileBase(g, inspectedWater.x, inspectedWater.y); this.bakeFeatures(g, inspectedWater); }
      for (const structure of inspectedStructures) this.drawStructure(g, structure, t);
      // Preserve bodies in front of the inspected object after the local reveal.
      for (const s of sprites) if (s.ay >= site.foot) {
        if (s.person) this.drawPerson(g, s.person, t); else if (s.animal) this.drawAnimal(g, s.animal, t);
      }
      g.restore();
    }
    this.bodyCutaways = coveredPeople.size;
    // Restore real bodies within a local cutaway. Contrast must not depend on selecting a person.
    for (const person of people) if (coveredPeople.has(person.view.id)) {
      const x = Math.round(person.x * ART + 8), y = Math.round(person.y * ART + 12);
      g.save(); g.lineJoin = 'round'; g.beginPath();
      g.moveTo(x - 3, y - 14); g.lineTo(x + 3, y - 14); g.lineTo(x + 3, y - 9);
      g.lineTo(x + 5, y - 9); g.lineTo(x + 4, y + 1); g.lineTo(x - 4, y + 1);
      g.lineTo(x - 5, y - 9); g.lineTo(x - 3, y - 9); g.closePath();
      g.strokeStyle = css(P.ink, .8); g.lineWidth = 3; g.stroke();
      g.strokeStyle = css(P.paper, .9); g.lineWidth = 1; g.stroke();
      this.drawPerson(g, person, t); g.restore();
    }
    // Data stays visible over canopy, with people badges preserved above it.
    if (this.layer !== 'none') {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const tile = this.tileAt(x, y);
        if (tile) this.drawLayerCell(g, tile, x * ART, y * ART);
      }
    }
    // M10: un velo tenue sobre las zonas en reposo (el servidor no las simula ahora; se ve su estado
    // guardado o una vista previa). Sin `regionesVivas` no se vela nada: no se sabe.
    if (this.vivas) {
      // One mask pixel per cell, plus a one-cell halo so a region crossing the
      // visible edge blends against its real neighbours. Reuse the mask storage.
      const maskX = x0 - 1, maskY = y0 - 1;
      const maskW = x1 - x0 + 3, maskH = y1 - y0 + 3;
      let resized = false;
      if (this.restVeil.width < maskW || this.restVeil.height < maskH || !this.restVeilPixels) {
        this.restVeil.width = Math.max(this.restVeil.width, maskW);
        this.restVeil.height = Math.max(this.restVeil.height, maskH);
        this.restVeilPixels = this.restVeilContext.createImageData(this.restVeil.width, this.restVeil.height);
        resized = true;
      }
      // V22: la máscara solo depende de la rejilla, las regiones vivas y los límites: no se rehace 60×/s.
      const veilKey = `${this.gridRevision}:${this.vivasKey}:${x0}:${x1}:${y0}:${y1}`;
      if (resized || veilKey !== this.veilKey) {
        this.veilKey = veilKey;
        const mask = this.restVeilPixels.data;
        const stride = this.restVeil.width;
        for (let y = 0; y < maskH; y++) for (let x = 0; x < maskW; x++) {
          const worldX = maskX + x, worldY = maskY + y;
          const offset = (y * stride + x) * 4;
          mask[offset] = 24; mask[offset + 1] = 38; mask[offset + 2] = 32;
          mask[offset + 3] = this.tileAt(worldX, worldY) && !this.vivas.has(claveRegion(worldX, worldY)) ? 87 : 0;
        }
        this.restVeilContext.putImageData(this.restVeilPixels, 0, 0, 0, 0, maskW, maskH);
      }
      g.save(); g.imageSmoothingEnabled = true;
      g.drawImage(this.restVeil, 0, 0, maskW, maskH, maskX * ART, maskY * ART, maskW * ART, maskH * ART);
      g.restore();
    }
    g.restore();
  }

  /* ----------------- V22: cachés de escena (60 fps lejos) ---------------- */

  private bodyGridInfo = { gx0: 0, gy0: 0, gw: 0, gh: 0, outside: [] as number[] };

  /** Rejilla de cubos por tesela con los cuerpos que pueden tapar/ser tapados: una vez por fotograma, O(cuerpos). */
  private indexBodies(bodies: readonly (RenderPerson | RenderAnimal)[], x0: number, x1: number, y0: number, y1: number): void {
    const gx0 = x0 - BODY_GRID_MARGIN, gy0 = y0 - BODY_GRID_MARGIN, gw = x1 - x0 + 1 + 2 * BODY_GRID_MARGIN, gh = y1 - y0 + 1 + 2 * BODY_GRID_MARGIN;
    if (this.bodyHead.length < gw * gh) this.bodyHead = new Int32Array(gw * gh);
    if (this.bodyNext.length < bodies.length) this.bodyNext = new Int32Array(Math.max(bodies.length, this.bodyNext.length * 2));
    this.bodyHead.fill(-1, 0, gw * gh);
    const outside: number[] = [];
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i]!;
      const cx = Math.floor((body.x * ART + 8) / ART) - gx0, cy = Math.floor((body.y * ART + 12) / ART) - gy0;
      if (!(cx >= 0 && cy >= 0 && cx < gw && cy < gh)) { outside.push(i); continue; }
      this.bodyNext[i] = this.bodyHead[cy * gw + cx]!; this.bodyHead[cy * gw + cx] = i;
    }
    this.bodyGridInfo = { gx0, gy0, gw, gh, outside };
    this.perf.bodyGridBuilds++;
  }

  /** Decoración por tesela de la ventana visible: se rehace solo si cambia la rejilla, las estructuras o los límites. */
  private scenePropsFor(world: WorldView, x0: number, x1: number, y0: number, y1: number): SceneProps {
    const key = `${this.gridRevision}:${this.structureRevision}:${x0}:${x1}:${y0}:${y1}:${world.animals === undefined ? 1 : 0}`;
    const cached = this.sceneProps;
    if (cached && cached.key === key) return cached;
    this.perf.scenePropsBuilds++;
    const sprites: Sprite[] = [], animated: AnimatedTile[] = [];
    let visibleTiles = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const tile = this.tileAt(x, y);
        if (!tile) continue;
        visibleTiles++;
        const ox = x * ART, oy = y * ART;
        if (tile.terrain === 'water') {
          if (rnd(x, y, 712) > .6) animated.push({ kind: 0, tile, x, y });
        } else {
          if ((tile.feature === 'pool' || tile.feature === 'spring') && (tile.drinkingWater ?? 0) > .04) animated.push({ kind: 1, tile, x, y });
          if (tile.feature === 'reeds' || tile.feature === 'flowers') animated.push({ kind: 2, tile, x, y });
          const structured = this.structuredTiles.has(cellKey(x, y));
          if (tile.terrain === 'shelter' && !structured) {
            sprites.push({ kind: SpriteKind.Hut, sortY: oy + 13, ax: ox + 8, ay: oy + 13, seed: hash3(x, y, 900), size: 0, person: null });
          } else if (!structured) {
            this.collectTrees(sprites, x, y, ox, oy);
          }
        }
        if (world.animals === undefined && tile.species && (tile.fauna ?? 0) > .04) sprites.push({ kind: SpriteKind.Fauna, sortY: oy + 11, ax: ox + 8, ay: oy + 11, seed: 0, size: 0, person: null, tile });
      }
    }
    sprites.sort((a, b) => a.sortY - b.sortY);
    const props = sprites.filter(sprite => sprite.kind === SpriteKind.Tree || sprite.kind === SpriteKind.Hut);
    const fauna = sprites.filter(sprite => sprite.kind === SpriteKind.Fauna);
    return this.sceneProps = { key, visibleTiles, animated, sprites, props, fauna };
  }

  /** Capa estática de arbolado + cabañas (pose fija, sin recortes): se repinta solo cuando cambia su `SceneProps`. */
  private blitCanopy(g: CanvasRenderingContext2D, props: SceneProps, x0: number, x1: number, y0: number, y1: number): void {
    const canvas = this.staticPropsCanvas ?? (this.staticPropsCanvas = document.createElement('canvas'));
    if (this.staticPropsOwner !== props || canvas.width !== this.scene.width || canvas.height !== this.scene.height) {
      if (canvas.width !== this.scene.width || canvas.height !== this.scene.height) { canvas.width = this.scene.width; canvas.height = this.scene.height; }
      const c = canvas.getContext('2d')!;
      c.imageSmoothingEnabled = false;
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.save(); c.translate(-this.originX * ART, -this.originY * ART);
      for (const sprite of props.props) {
        if (sprite.kind === SpriteKind.Tree) c.drawImage(this.treeRaster(sprite.tree!, 1), Math.round(sprite.ax) - 16, Math.round(sprite.ay) - 44);
        else this.drawHut(c, sprite.ax, sprite.ay, sprite.seed);
      }
      c.restore();
      this.staticPropsOwner = props; this.perf.canopyBuilds++;
    }
    // Solo la banda visible (con la misma holgura de copas altas que `visibleBounds`).
    const sx = Math.max(0, (x0 - this.originX - 1) * ART), sy = Math.max(0, (y0 - this.originY) * ART);
    const ex = Math.min(canvas.width, (x1 - this.originX + 2) * ART), ey = Math.min(canvas.height, (y1 - this.originY + 1) * ART + ART);
    if (ex > sx && ey > sy) { g.drawImage(canvas, sx, sy, ex - sx, ey - sy, sx + this.originX * ART, sy + this.originY * ART, ex - sx, ey - sy); this.drawCalls++; this.perf.canopyBlits++; }
  }

  /**
   * Salón modular (polyomino o rectangular) como un único `drawImage`: se hornea en un lienzo propio y solo se repinta si cambió
   * la estructura (firma completa) o, con animación, la pose de humo/brasas (≈ 12/s). Pixel a pixel igual que pintarlo directo.
   */
  private drawModularHall(g: CanvasRenderingContext2D, ext: ExtendedStructure, t: number, animate: boolean): void {
    const animated = animate && this.cam.zoom >= FAR_ZOOM;
    const pose = animated ? Math.floor(t * HALL_POSES_PER_SEC) : -1;
    let sig = this.hallSigs.get(ext);
    if (sig === undefined) { sig = `${tintBucket(ext.materialProfile?.tint)}:${ext.synergy?.kilnTier ?? 0}:${JSON.stringify(ext)}`; this.hallSigs.set(ext, sig); }
    const extent = structureExtent(ext);
    const left = extent.left - HALL_PAD.x, top = extent.top - HALL_PAD.top;
    const width = extent.right + HALL_PAD.x - left, height = extent.bottom + HALL_PAD.bottom - top;
    let slot = this.hallSlots.get(ext.id);
    if (!slot) {
      slot = { canvas: document.createElement('canvas'), sig: '', pose: -2, left, top };
      this.hallSlots.set(ext.id, slot);
      if (this.hallSlots.size > HALL_SLOT_LIMIT) { const oldest = this.hallSlots.keys().next().value!; const dead = this.hallSlots.get(oldest)!; dead.canvas.width = dead.canvas.height = 0; this.hallSlots.delete(oldest); }
    }
    if (slot.sig !== sig || slot.pose !== pose || slot.left !== left || slot.top !== top || slot.canvas.width !== width) {
      const canvas = slot.canvas;
      canvas.width = width; canvas.height = height; // redimensionar también limpia
      const c = canvas.getContext('2d')!;
      c.imageSmoothingEnabled = false;
      c.translate(-left, -top);
      paintModularHall(c, ext, pose >= 0 ? pose / HALL_POSES_PER_SEC : 0, animated);
      slot.sig = sig; slot.pose = pose; slot.left = left; slot.top = top;
      this.perf.hallBuilds++;
    }
    g.drawImage(slot.canvas, left, top); this.drawCalls++; this.perf.hallBlits++;
  }

  /* -------------------------- decorado vivo ------------------------ */

  private drawCastShadow(g: CanvasRenderingContext2D, sprite: Sprite): void {
    const height = sprite.kind === SpriteKind.Tree ? sprite.size : sprite.kind === SpriteKind.Structure ? 1.8 : .65;
    const width = sprite.kind === SpriteKind.Person ? 2.5 : 4;
    const { shadowX, shadowY, shadowAlpha } = this.lighting;
    g.fillStyle = css(P.shadow, shadowAlpha); g.beginPath();
    g.moveTo(sprite.ax - width, sprite.ay); g.lineTo(sprite.ax + width, sprite.ay);
    g.lineTo(sprite.ax + width + shadowX * height, sprite.ay + shadowY * height);
    g.lineTo(sprite.ax - width + shadowX * height, sprite.ay + shadowY * height); g.closePath(); g.fill();
    this.effects.shadows++;
  }

  private drawPlantMovement(g: CanvasRenderingContext2D, tile: Tile, t: number): void {
    if (this.reduceMotion || (tile.growth ?? tile.vegetation) < .25 || this.effects.vegetation >= VISUAL_BUDGET.vegetation || hash3(tile.x, tile.y, 813) % 3) return;
    const sway = Math.round(Math.sin(t * .8 + tile.x * .13 + tile.y * .07));
    const x = tile.x * ART + 8, y = tile.y * ART + 9;
    px(g, x, y - 3, 1, 4, css(P.reed)); px(g, x + sway, y - 5, 1, 3, css(P.reedLight));
    this.effects.vegetation++;
  }

  private drawAnimal(g: CanvasRenderingContext2D, animal: RenderAnimal, t: number): void {
    const v = animal.view;
    const phase = hash3(v.id.length, v.id.charCodeAt(v.id.length-1), 48) % 13;
    // En marcha la pose avanza con la distancia recorrida (una pose cada ANIMAL_STEP_TILES), no con el reloj.
    const rate = v.action === 'flee' || v.action === 'hunt' ? 10 : 6;
    const pose = animalPose(v, animal.moving, (animal.moving ? animal.stride / ANIMAL_STEP_TILES / rate : t) + phase, this.reduceMotion, this.actionActive || animal.moving);
    const traits = animalVisualTraits(v);
    const key = animalSpriteKey(v, pose, traits);
    let art = this.animalCache.get(key);
    if (!art) {
      art = document.createElement('canvas');
      art.width = art.height = 32;
      paintAnimal(art.getContext('2d')!, v.species, v.action, pose, traits);
      this.cacheSprite(key, art, this.animalCache);
    }
    g.save(); g.translate(Math.round(animal.x * ART + 8), Math.round(animal.y * ART + 12)); if (animal.left) g.scale(-1, 1);
    g.drawImage(art, -16, -26); g.restore(); this.drawCalls++;
  }

  private structureRaster(structure: StructureView): HTMLCanvasElement {
    const blueprint = this.curr?.blueprints?.find(b => b.id === structure.blueprintId);
    const materials = blueprint?.cost;
    const generation = blueprint?.generation;
    // `stepStructures` irrigates the 4 cardinal neighbor tiles around a garden structure; check own cell + 4 neighbors.
    let ground = this.tileAt(structure.x, structure.y);
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
      const nb = this.tileAt(structure.x + dx, structure.y + dy);
      if (!nb) continue;
      const nbPlanted = (nb.cultivation ?? 0) > .08 && nb.vegetation > .1 && (nb.growth ?? nb.vegetation) > .15;
      const curPlanted = ground && (ground.cultivation ?? 0) > .08 && ground.vegetation > .1 && (ground.growth ?? ground.vegetation) > .15;
      if (nbPlanted && (!curPlanted || nb.moisture > (ground?.moisture ?? 0))) {
        ground = nb;
      }
    }
    let communityColor: string | undefined;
    let culture: { sharing: number; stewardship: number; openness: number } | undefined;
    if (structure.builderId && this.curr?.communities?.length) {
      const builder = this.curr.people.find(p => p.id === structure.builderId);
      const comm = builder?.communityId
        ? this.curr.communities.find(c => c.id === builder.communityId)
        : undefined;
      if (comm) { communityColor = comm.color; culture = comm.culture; }
    }
    if (!communityColor && this.curr?.communities?.length) {
      let bestDist = 18 * 18;
      for (const c of this.curr.communities) {
        const d2 = (c.x - structure.x) ** 2 + (c.y - structure.y) ** 2;
        if (d2 < bestDist) { bestDist = d2; communityColor = c.color; culture = c.culture; }
      }
    }
    const cisterns = structure.components.filter(c=>c==='cistern').length, granaries = structure.components.filter(c=>c==='granary').length;
    const waterLevel = clamp(Math.ceil(structure.water / Math.max(1, cisterns) / .6 * 6), 0, 6);
    const foodLevel = clamp(Math.ceil(structure.food / Math.max(1, granaries) / .7 * 4), 0, 4);
    const planted = ground && (ground.cultivation ?? 0) > .08 && ground.vegetation > .1 && (ground.growth ?? ground.vegetation) > .15;
    const cultKey = culture ? `${culture.sharing > .52 ? 1 : 0}${culture.stewardship > .52 ? 1 : 0}${culture.openness > .52 ? 1 : 0}` : '';
    const materialKey = `${tintBucket(structure.materialProfile?.tint)}:${structure.materialProfile?.tint ?? ''}:${(structure.materialProfile?.strength ?? 0) >= .65}:${(structure.materialProfile?.seal ?? 0) >= .65}:${structure.synergy?.kilnTier ?? 0}:${(structure.storedCompounds ?? []).filter(l => l.mass > 0).slice(0, 3).map(l => l.properties.colorHex).join(',')}`;
    const key = `structure:${materialKey}:${structure.components.slice().sort().join(',')}:${structure.condition < .3 ? 0 : structure.condition < .65 ? 1 : 2}:${waterLevel}:${foodLevel}:${materials?.wood ?? 0}:${materials?.stone ?? 0}:${generation ?? -1}:${communityColor ?? ''}:${cultKey}:${!!planted}:${(ground?.moisture ?? 0) > .3}`;
    let art = this.spriteCache.get(key);
    if (!art) { art = document.createElement('canvas'); art.width = art.height = 32; paintStructure(art.getContext('2d')!, structure, {materials,ground,generation,communityColor,culture}); this.cacheSprite(key, art); }
    return art;
  }

  private drawStructure(g: CanvasRenderingContext2D, structure: StructureView, t = 0): void {
    const ext = structure as ExtendedStructure, animate = !this.reduceMotion && this.actionActive;
    if (ext.site) { paintConstructionSite(g, ext, ext.site, t, animate); this.drawCalls++; return; }
    if (isModular(ext)) { this.drawModularHall(g, ext, t, animate); return; }
    const art = this.structureRaster(structure);
    g.drawImage(art, Math.round(structure.x * ART + 8) - 16, Math.round(structure.y * ART + 13) - 29); this.drawCalls++;
    paintCompactAccessories(g, ext, t, animate, true);
    const previous = this.prev?.structures?.find(s => s.id === structure.id);
    if (!this.reduceMotion && this.actionActive && this.curr?.weather === 'rain' && previous && structure.water > previous.water
      && structure.components.includes('cistern') && this.effects.water < VISUAL_BUDGET.water) {
      const drop = Math.floor(t * 8) % 5;
      px(g, structure.x * ART + 19, structure.y * ART - 3 + drop, 1, 2, css(P.waterGleam));
      this.effects.water++;
    }
  }

  private drawRipples(g: CanvasRenderingContext2D, x: number, y: number, ox: number, oy: number, t: number): void {
    const gleam = css(P.waterGleam, 0.32);
    for (let i = 0; i < 2; i++) {
      const base = rnd(x, y, 700 + i);
      const py = oy + 3 + Math.floor(rnd(x, y, 740 + i) * 10);
      const drift = this.reduceMotion ? 0 : Math.floor((t * 2.1 + base * 9) % 7);
      const pxs = ox + ((Math.floor(base * ART) + drift) % (ART - 3));
      px(g, pxs, py, 3, 1, gleam);
      px(g, pxs + 1, py + 1, 1, 1, css(P.waterGleam, 0.22));
    }
  }

  private drawReeds(g: CanvasRenderingContext2D, x: number, y: number, ox: number, oy: number, t: number): void {
    // Sólo en el agua que toca tierra: la orilla es donde crece el junco.
    const touches =
      this.terrainAt(x, y - 1) !== 'water' ||
      this.terrainAt(x, y + 1) !== 'water' ||
      this.terrainAt(x - 1, y) !== 'water' ||
      this.terrainAt(x + 1, y) !== 'water';
    if (!touches) return;
    const n = Math.floor(rnd(x, y, 810) * 4);
    for (let i = 0; i < n; i++) {
      const rx = ox + 2 + Math.floor(rnd(x, y, 830 + i) * (ART - 4));
      const ry = oy + 6 + Math.floor(rnd(x, y, 860 + i) * 6);
      const hgt = 4 + Math.floor(rnd(x, y, 890 + i) * 4);
      const phase = rnd(x, y, 920 + i) * 6.283;
      const sway = this.reduceMotion ? 0 : Math.round(Math.sin(t * 1.5 + phase));
      px(g, rx, ry - hgt, 1, hgt, css(P.reed));
      px(g, rx + sway, ry - hgt - 2, 1, 2, css(P.reedLight));
    }
  }

  private drawBerries(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    ox: number,
    oy: number,
    food: number,
    t: number,
  ): void {
    const f = clamp01(food);
    if (f < 0.3) return;
    const bushes = f > 0.72 ? 2 : 1;
    for (let b = 0; b < bushes; b++) {
      const bx = ox + 3 + Math.floor(rnd(x, y, 950 + b) * (ART - 7));
      const by = oy + 6 + Math.floor(rnd(x, y, 980 + b) * 7);
      ellipse(g, bx + 2, by + 3, 3, 1.4, css(P.shadow, 0.16));
      ellipse(g, bx + 2, by, 3, 2.4, css(P.berryLeaf));
      ellipse(g, bx + 1, by - 1, 2, 1.4, css(lighten(P.berryLeaf, 0.18)));
      const berries = 2 + Math.round(f * 3);
      for (let i = 0; i < berries; i++) {
        const dx = bx + Math.floor(rnd(x, y, 1010 + b * 8 + i) * 5);
        const dy = by - 1 + Math.floor(rnd(x, y, 1050 + b * 8 + i) * 4);
        const twinkle = !this.reduceMotion && (Math.floor(t * 1.1 + i + b) & 3) === 0;
        px(g, dx, dy, 1, 1, css(twinkle ? P.berryLight : P.berry));
      }
    }
  }

  private collectTrees(sprites: Sprite[], x: number, y: number, ox: number, oy: number): void {
    const tile = this.tileAt(x, y);
    if (!tile) return;
    const sprite = this.treeSprite(tile, ox, oy);
    if (sprite) sprites.push(sprite);
  }

  private treeSprite(tile: Tile, ox = tile.x * ART, oy = tile.y * ART): Sprite | null {
    const form = this.treeForms.get(tile);
    if (!form) return null;
    const {x,y} = tile;
    // One visible woody patch per occupied cell; coordinate/variety jitter is stable while stocks change.
    const seed = hash3(x, y, 1220 + form.variant * 83);
    const patch = rnd(Math.floor(x / 3), Math.floor(y / 3), 1141);
    const ax = ox + 2 + Math.round(rnd(x, y, 1100 + form.variant) * 8 + patch * 3);
    const ay = oy + 6 + Math.round(rnd(x, y, 1140 + form.variant) * 7);
    return { kind: SpriteKind.Tree, sortY: ay, ax, ay, seed, size: form.height / ART,
      person: null, feature: form.kind, tree: form, tile };
  }

  private cacheSprite(key: string, canvas: HTMLCanvasElement, cache = this.spriteCache): void {
    this.spriteBytes += canvas.width * canvas.height * 4;
    cache.set(key, canvas); this.spriteBuilds++;
  }

  private treeRaster(form: TreeForm, pose: number): HTMLCanvasElement {
    const key = `tree:${form.kind}:${form.variant}:${form.height}:${form.width}:${form.foliage}:${pose}`;
    let art = this.spriteCache.get(key);
    if (!art) {
      art = document.createElement('canvas'); art.width = 32; art.height = 48;
      paintTree(art.getContext('2d')!, form, pose); this.cacheSprite(key, art);
    }
    return art;
  }

  private drawCachedTree(g: CanvasRenderingContext2D, sprite: Sprite, t: number, occluded = false): void {
    const moving = !this.reduceMotion && sprite.seed % 11 === 0 && this.effects.vegetation < VISUAL_BUDGET.vegetation;
    if (moving) this.effects.vegetation++;
    const pose = moving ? Math.round(Math.sin(t * .65 + sprite.ax * .013 + sprite.ay * .007) + 1) : 1;
    const art = this.treeRaster(sprite.tree!, pose);
    // A cutaway is a viewing aid: the body, stock, position and hit target remain unchanged.
    if (occluded) { g.save(); g.globalAlpha = .38; }
    g.drawImage(art, Math.round(sprite.ax) - 16, Math.round(sprite.ay) - 44); this.drawCalls++;
    if (occluded) g.restore();
  }

  /** At most two representatives per occupied cell; stock and migration remain server data. */
  private drawFauna(g: CanvasRenderingContext2D, tile: Tile, t: number): void {
    const species = tile.species, stock = tile.fauna ?? 0;
    if (!species || stock <= .04) return;
    const count = stock > .65 ? 2 : 1;
    for (let i=0;i<count;i++) {
      const x = tile.x*ART+4+Math.floor(rnd(tile.x,tile.y,2010+i)*8), y = tile.y*ART+7+i*5;
      const pose = this.reduceMotion ? 0 : Math.floor(t*1.6 + rnd(tile.x,tile.y,2040+i)*4)%2;
      if (species === 'fish') {
        ellipse(g,x,y,3,1.5,css(P.waterGleam,.8)); px(g,x-4,y-1+pose,2,2,css(P.waterGleam,.7)); px(g,x+2,y,1,1,css(P.waterDeep));
      } else if (species === 'hare') {
        ellipse(g,x,y+2,3,1,css(P.shadow,.2)); ellipse(g,x,y,3,2,css(P.soilLight));px(g,x+1,y-4-pose,1,3,css(P.paper));px(g,x+3,y-4,1,3,css(P.soilLight));px(g,x+2,y-1,1,1,css(P.ink));px(g,x-3,y,1,1,css(P.paper));
      } else {
        const deer = species === 'deer', coat = deer ? P.soil : P.trunkLight;
        ellipse(g,x,y+4,5,1.5,css(P.shadow,.2));ellipse(g,x,y,4,2.5,css(coat));
        px(g,x-3,y+1,1,3,css(darken(coat,.25)));px(g,x+2,y+1,1,3,css(darken(coat,.25)));
        px(g,x+3,y-3,3,3,css(lighten(coat,.12)));px(g,x+4,y-2,1,1,css(P.ink));
        if(deer){px(g,x+3,y-6,1,3,css(P.trunk));px(g,x+5,y-6,1,3,css(P.trunk));px(g,x+2,y-6,4,1,css(P.trunk));}
        else {px(g,x+5,y,2,1,css(P.paper));px(g,x-4,y-1-pose,1,2,css(P.trunk));}
      }
    }
  }

  private drawHut(g: CanvasRenderingContext2D, ax: number, ay: number, seed: number): void {
    const wide = (seed & 1) === 1;
    const w = wide ? 12 : 10;
    const h = 6;
    const left = ax - Math.floor(w / 2);
    const top = ay - h;

    ellipse(g, ax, ay + 1, w * 0.55, 2, css(P.shadow, 0.24));
    px(g, left, top, w, h, css(P.hutWall));
    px(g, left, top, 2, h, css(P.hutWallShade));
    px(g, left, ay - 1, w, 1, css(darken(P.hutWall, 0.22)));

    // Techo de paja: hiladas que se estrechan.
    const roofH = 6;
    for (let i = 0; i < roofH; i++) {
      const rw = 2 + Math.round((i / (roofH - 1)) * (w + 1));
      const rx = ax - Math.floor(rw / 2);
      const ry = top - roofH + i;
      px(g, rx, ry, rw, 1, css(i < 2 ? P.hutRoofLight : P.hutRoof));
    }
    px(g, left - 1, top - 1, w + 2, 1, css(darken(P.hutRoof, 0.25)));

    // Puerta; de noche, un rescoldo cálido.
    const dx = ax - 1;
    px(g, dx, ay - 4, 3, 4, css(P.hutDoor));
  }

  private drawPlaces(
    g: CanvasRenderingContext2D,
    places: readonly PlaceView[],
    x0: number,
    x1: number,
    y0: number,
    y1: number,
  ): void {
    for (const place of places) {
      const px0 = Math.floor(place.x);
      const py0 = Math.floor(place.y);
      if (px0 < x0 || px0 > x1 || py0 < y0 || py0 > y1) continue;
      const cx = place.x * ART + ART / 2;
      const cy = place.y * ART + ART / 2;
      const lively = place.gatherings > 0;
      const tier = Math.min(3, Math.ceil((place.gatherings ?? 0) / 5));
      const count = 7 + tier;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * 6.283 + (hash3(px0, py0, 1400) % 100) / 100;
        const sx = Math.round(cx + Math.cos(a) * (5.5 + tier * 0.4));
        const sy = Math.round(cy + Math.sin(a) * (3.8 + tier * 0.3));
        px(g, sx, sy, 2, 1, css(lively ? lighten(P.stone, 0.16) : P.stone, 0.88));
        px(g, sx, sy + 1, 2, 1, css(P.stoneShade, 0.75));
      }
      if (tier >= 2) {
        px(g, Math.round(cx) - 1, Math.round(cy), 2, 2, css(P.amber, 0.72));
      }
    }
  }

  private drawLayerCell(g: CanvasRenderingContext2D, tile: Tile, ox: number, oy: number): void {
    if (this.layer === 'none') return;
    if (this.layer === 'moisture') {
      const v = clamp01(tile.moisture);
      if (v < 0.05) return;
      px(g, ox, oy, ART, ART, css(P.waterShallow, v * 0.45));
    } else {
      const v = clamp01(tile.food);
      if (v < 0.05) return;
      px(g, ox, oy, ART, ART, css(P.amber, v * 0.42));
    }
  }

  /* ---------------------------- personas --------------------------- */

  private drawPerson(g: CanvasRenderingContext2D, p: RenderPerson, t: number): void {
    const view = p.view;
    const resting = view.action === 'rest';
    const stage = view.lifeStage;
    const juvenile = stage === 'juvenile';
    const senescent = stage === 'senescent';
    const ax = Math.round(p.x * ART + ART / 2);
    const ay = Math.round(p.y * ART + ART / 2 + 4);

    // Deterministic 32-bit identity seed combining FNV-1a(id) and view.color
    let h = p.seed >>> 0;
    const rawColor = view.color ?? '';
    for (let i = 0; i < rawColor.length; i++) {
      h = Math.imul(h ^ rawColor.charCodeAt(i), 16777619) >>> 0;
    }

    // 8 high-contrast personal garment palettes that never dissolve into brown soil (#a8825c) or sage grass (#96aa7c)
    const ROPA = [
      rgb(194, 59, 46),   // 0: crimson madder
      rgb(47, 109, 181),  // 1: indigo blue
      rgb(224, 165, 38),  // 2: saffron gold
      rgb(107, 63, 160),  // 3: plum violet
      rgb(31, 138, 122),  // 4: deep teal
      rgb(217, 106, 30),  // 5: rust terracotta
      rgb(59, 74, 140),   // 6: slate navy
      rgb(184, 51, 106),  // 7: berry rose
    ] as const;
    const SKINS = [
      rgb(241, 210, 180),
      rgb(226, 190, 158),
      rgb(201, 154, 114),
      rgb(164, 116, 79),
      rgb(126, 86, 58),
    ] as const;
    const HAIRS = [
      rgb(30, 22, 18),
      rgb(74, 44, 26),
      rgb(138, 75, 34),
      rgb(196, 132, 54),
      rgb(226, 202, 134),
      rgb(92, 76, 68),
    ] as const;

    const community = this.curr?.communities?.find(group => group.id === view.communityId);
    const commRgb = community ? parseColor(community.color, P.amber) : parseColor(view.color, P.amber);
    const mainIdx = h % 8;
    const secIdx = (mainIdx + 3 + ((h >>> 3) % 3)) % 8;
    const mainRgb = view.role === 'I' ? P.coral : view.role === 'S' ? rgb(44, 79, 138) : ROPA[mainIdx]!;
    const secRgb = view.role === 'I' ? P.coralDeep : view.role === 'S' ? P.amber : ROPA[secIdx]!;
    const claraHex = '#efe6d2';
    const mainHex = css(mainRgb);
    const mainDarkHex = css(darken(mainRgb, 0.25));
    const secHex = css(secRgb);
    const comHex = css(commRgb);
    const pantsHex = css(darken(secRgb, 0.42));
    const bootHex = '#3a2618';
    const outlineHex = '#231710';

    const skinRgb = view.role === 'S' || view.role === 'I' ? P.skin : SKINS[(h >>> 6) % SKINS.length]!;
    const skinHex = css(skinRgb);
    const skinLightHex = css(lighten(skinRgb, 0.28));
    const cheekHex = css(mix(skinRgb, rgb(217, 119, 106), 0.35));
    const hairRgb = senescent ? rgb(210, 206, 198) : view.role === 'S' || view.role === 'I' ? rgb(58, 36, 24) : HAIRS[(h >>> 9) % HAIRS.length]!;
    const hairHex = css(hairRgb);
    const hairLightHex = css(lighten(hairRgb, 0.24));
    const hairDarkHex = css(darken(hairRgb, 0.25));

    // Balanceo de paso: sólo si el servidor la movió de verdad.
    // V18: el paso sale de la distancia recorrida (mayores caminan a zancada más corta): andar sereno, nunca a trompicones.
    const step = !this.reduceMotion && p.moving ? (Math.floor(p.stride / (senescent ? STRIDE_TILES * 1.3 : STRIDE_TILES) + p.seed) & 1) : 0;
    const bob = resting ? 0 : step === 1 ? -1 : 0;
    const baseY = resting ? ay + 2 : ay;

    // Ground shadow & community ring
    ellipse(g, ax, baseY + 1, view.role === 'S' || view.role === 'I' ? 4.8 : juvenile ? 3.5 : 4.2, 1.7, css(P.shadow, 0.36));
    if (community) ellipse(g, ax, baseY + 2, juvenile ? 4.4 : 5.4, 1.35, css(commRgb, .9));

    const torsoH = juvenile ? 4 : 5;
    const legH = juvenile ? 2 : 3;
    const torsoTop = baseY - legH - torsoH;
    const headTop = (resting ? baseY - 10 : torsoTop - 4 + (senescent ? 1 : 0)) + bob;
    const headX = ax + (senescent && !resting ? 1 : 0);

    // 2-pass pixel buffer: pass 1 paints a 1px dark silhouette contour (#231710) around outlined rects;
    // pass 2 paints the interior colors in exact layer order.
    const rects: { x: number; y: number; w: number; h: number; color: string; outline: boolean }[] = [];
    const add = (x: number, y: number, w: number, h: number, color: string, outline = true): void => {
      if (w > 0 && h > 0) rects.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), color, outline });
    };

    // Determine hairstyle/headwear (0..7) and garment style (0..5) uniformly from 32-bit identity hash
    const headStyle = view.role === 'S' || view.role === 'I' ? -1 : (h >>> 12) % 8;
    const garmentStyle = (h >>> 15) % 6;

    // Back hair layer (for long flowing hair style 3)
    if (!resting && headStyle === 3) {
      add(headX - 3, headTop, 1, 5, hairDarkHex, true);
      add(headX + 2, headTop, 1, 5, hairDarkHex, true);
    }

    if (resting) {
      add(ax - 4, baseY - 3, 8, 3, mainDarkHex, true);
      add(ax - 3, baseY - 6, 6, 4, mainHex, true);
      add(ax - 2, baseY - 6, 4, 1, comHex, false);
    } else {
      // Legs & outward-pointing boots
      const leftLegH = legH;
      const rightLegH = Math.max(1, legH - step);
      add(ax - 2, baseY - leftLegH, 2, leftLegH, pantsHex, true);
      add(ax, baseY - rightLegH, 2, rightLegH, pantsHex, true);
      add(ax - 3, baseY - 1, 2, 1, bootHex, true);
      add(ax + 1, baseY - 1 + (legH - rightLegH), 2, 1, bootHex, true);

      // Torso base & arms
      add(ax - 3, torsoTop, 6, torsoH, mainHex, true);
      add(ax - 3, baseY - legH - 1, 6, 1, mainDarkHex, false);
      // Short sleeves + skin forearms
      const armH = Math.max(2, torsoH - 2);
      add(ax - 4, torsoTop + bob, 1, 1, mainHex, true);
      add(ax - 4, torsoTop + 1 + bob, 1, armH - 1, skinHex, true);
      add(ax + 3, torsoTop - bob, 1, 1, mainHex, true);
      add(ax + 3, torsoTop + 1 - bob, 1, armH - 1, skinHex, true);

      if (view.role !== 'S' && view.role !== 'I') {
        // 6 distinctive garment silhouettes
        if (garmentStyle === 0) {
          // A: Open vest over cream linen shirt
          add(ax - 1, torsoTop + 1, 2, torsoH - 1, claraHex, false);
          add(ax - 3, torsoTop, 2, torsoH, mainHex, false);
          add(ax + 1, torsoTop, 2, torsoH, mainHex, false);
          add(ax - 2, torsoTop, 4, 1, comHex, false);
        } else if (garmentStyle === 1) {
          // B: Wide V-neck poncho
          add(ax - 4, torsoTop + 1, 8, Math.min(3, torsoH - 1), mainHex, true);
          add(ax - 1, torsoTop, 2, 2, comHex, false);
          add(ax - 3, torsoTop + Math.min(3, torsoH - 1), 6, 1, secHex, false);
        } else if (garmentStyle === 2) {
          // C: Craftsman leather apron over tunic
          add(ax - 2, torsoTop + 1, 4, torsoH - 1, '#7a4a28', false);
          add(ax - 3, torsoTop + 2, 6, 1, secHex, false);
          add(ax - 2, torsoTop, 4, 1, comHex, false);
        } else if (garmentStyle === 3) {
          // D: Crossed tunic with wide community waist sash
          add(ax - 2, torsoTop, 4, 1, claraHex, false);
          add(ax - 3, torsoTop + Math.max(1, torsoH - 3), 6, 2, comHex, false);
        } else if (garmentStyle === 4) {
          // E: One-shoulder cloak with community brooch
          add(ax - 4, torsoTop, 3, Math.min(4, torsoH), secHex, true);
          add(ax - 1, torsoTop, 2, 1, comHex, false);
        } else {
          // F: Work suspenders over shirt
          add(ax - 2, torsoTop, 1, torsoH, secHex, false);
          add(ax + 1, torsoTop, 1, torsoH, secHex, false);
          add(ax - 1, torsoTop, 2, 1, comHex, false);
        }
      }
    }

    // Face & crisp eyes
    add(headX - 2, headTop, 4, 4, skinHex, true);
    add(headX - 2, headTop + 1, 1, 1, skinLightHex, false);
    add(headX - 2, headTop + 3, 1, 1, cheekHex, false);
    add(headX - 1, headTop + 2, 1, 1, '#1c1410', false);
    add(headX + 1, headTop + 2, 1, 1, '#1c1410', false);

    if (view.role === 'S') {
      // S: dark hair + iconic amber scarf with fluttering tail
      add(headX - 2, headTop - 1, 4, 2, hairHex, true);
      add(headX - 3, headTop, 1, 2, hairHex, true);
      add(headX + 2, headTop, 1, 2, hairHex, true);
      const neck = headTop + 4;
      add(ax - 4, neck, 8, 2, css(P.amber), true);
      add(ax - 4, neck + 1, 8, 1, css(P.amberDeep), false);
      const tail = this.reduceMotion || !p.moving ? 0 : step;
      add(ax + 3 + tail, neck + 1, 2, 4, css(P.amber), true);
      add(ax + 3 + tail, neck + 4, 2, 1, css(P.amberDeep), false);
    } else if (view.role === 'I') {
      // I: coral hooded cloak & dress with cream sash
      add(ax - 4, baseY - 9, 8, 7, css(P.coral), true);
      add(ax - 5, baseY - 3, 10, 2, css(P.coral), true);
      add(ax - 5, baseY - 2, 10, 1, css(P.coralDeep), false);
      add(ax - 3, baseY - 6, 6, 1, claraHex, false);
      add(headX - 3, headTop - 2, 6, 3, css(P.coral), true);
      add(headX - 3, headTop - 2, 6, 1, css(lighten(P.coral, 0.25)), false);
      add(headX - 2, headTop, 4, 3, skinHex, false);
      add(headX - 1, headTop + 1, 1, 1, '#1c1410', false);
      add(headX + 1, headTop + 1, 1, 1, '#1c1410', false);
    } else {
      // 8 distinct head / hairstyle / headwear silhouettes for neighbors
      if (headStyle === 0 && !juvenile) {
        // 0: Wide-brimmed straw sun hat with community band
        add(headX - 4, headTop - 1, 8, 1, '#e3c26a', true);
        add(headX - 2, headTop - 3, 4, 2, '#d4b052', true);
        add(headX - 2, headTop - 2, 4, 1, comHex, false);
      } else if (headStyle === 1) {
        // 1: Explorer headband + feather
        add(headX - 2, headTop - 1, 4, 1, hairHex, true);
        add(headX - 2, headTop, 4, 1, comHex, false);
        add(headX + 2, headTop - 3, 1, 3, claraHex, true);
        add(headX + 2, headTop - 3, 1, 1, css(ROPA[0]), false);
      } else if (headStyle === 2) {
        // 2: High top-knot / bun
        add(headX - 2, headTop - 1, 4, 1, hairHex, true);
        add(headX - 1, headTop - 3, 2, 2, hairHex, true);
        add(headX - 1, headTop - 1, 2, 1, comHex, false);
      } else if (headStyle === 3) {
        // 3: Long flowing hair
        add(headX - 2, headTop - 1, 4, 2, hairHex, true);
        add(headX - 1, headTop - 1, 2, 1, hairLightHex, false);
      } else if (headStyle === 4) {
        // 4: Full curly / textured crown
        add(headX - 3, headTop - 2, 6, 3, hairHex, true);
        add(headX - 2, headTop - 2, 1, 1, hairLightHex, false);
        add(headX, headTop - 1, 1, 1, hairLightHex, false);
        add(headX + 2, headTop - 2, 1, 1, hairLightHex, false);
      } else if (headStyle === 5) {
        // 5: Side braid with community ribbon tie
        add(headX - 2, headTop - 1, 4, 2, hairHex, true);
        add(headX + 2, headTop + 1, 1, 4, hairDarkHex, true);
        add(headX + 2, headTop + 4, 1, 1, comHex, false);
      } else if (headStyle === 6 && !juvenile) {
        // 6: Artisan knit cap with pom-pom & visible hair fringe
        add(headX - 2, headTop - 2, 4, 2, secHex, true);
        add(headX - 2, headTop - 1, 4, 1, comHex, false);
        add(headX - 2, headTop, 1, 1, hairHex, false);
        add(headX + 1, headTop, 1, 1, hairHex, false);
        add(headX, headTop - 3, 1, 1, claraHex, true);
      } else {
        // 7: Classic cropped cut with sideburns
        add(headX - 2, headTop - 1, 4, 2, hairHex, true);
        add(headX - 3, headTop, 1, 2, hairHex, true);
        add(headX + 2, headTop, 1, 2, hairHex, true);
      }
    }

    const atTarget = view.target ? Math.hypot(view.x - view.target.x, view.y - view.target.y) < .5 : false;
    const craft = this.craftVisuals.get(view.id);
    const toolHex = craft?.tint ?? css(P.stone);
    if (craft?.tint) {
      // A narrow sash/apron retains the inhabitant's own clothes and community colors.
      add(ax - 1, baseY - legH - 4, 1, 4, craft.tint, false);
      add(ax, baseY - legH - 2, 2, 2, craft.tint, false);
    }
    if (craft?.packTint) {
      const height = craft.lightPack ? 3 : 5;
      add(ax - 6, baseY - legH - height, craft.lightPack ? 3 : 4, height, craft.packTint, true);
      add(ax - 5, baseY - legH - height, 1, height, '#d9bf8c', false);
    }
    const product = this.carriedProducts.get(view.id);
    const secondary = this.secondaryProducts.get(view.id);
    if (secondary) {
      const sx = ax - 5, sy = baseY - legH - 2;
      add(sx, sy, 2, 2, toolHex, true);
    }
    if (product) {
      const x = ax - 7, y = baseY - 5;
      if (product === 'material') {
        add(x, y, 4, 3, toolHex, true); add(x, y, 3, 1, toolHex, false);
      } else if (product === 'storage') {
        add(x, y, 4, 4, craft?.tint ?? css(P.soil), true); add(x + 1, y - 1, 2, 1, css(P.soilLight), true);
        if (this.carriedWater.get(view.id)) {
          add(x + 1, y, 2, 2, css(P.waterShallow), false);
          add(x + 1, y, 2, 1, css(P.waterGleam), false);
        }
      } else if (product === 'insulation') {
        add(x, y, 4, 3, craft?.tint ?? css(P.sand), true); add(x, y + 1, 4, 1, css(P.soilLight), false);
      } else if (product === 'binding') {
        add(x, y, 3, 3, craft?.tint ?? css(P.trunkLight), true); add(x + 1, y - 1, 1, 5, css(P.sand), false);
      } else if (product === 'cultivation') {
        add(x + 1, y - 3, 1, 7, css(P.trunkLight), true); add(x, y - 3, 3, 1, toolHex, true); add(x + 2, y - 2, 1, 2, toolHex, false);
      } else if (product === 'abrasion') {
        add(x, y - 1, 4, 3, toolHex, true); add(x + 1, y - 2, 2, 1, css(P.paper), false);
      } else {
        add(x + 1, y - 3, 1, 7, css(P.trunkLight), true); add(x, y - 4, 3, 3, toolHex, true); add(x, y - 4, 1, 2, css(P.paper), false);
      }
    }

    if (product && craft?.glint) add(ax - 7, baseY - 5, 1, 1, '#f4ffff', false);

    const hasInventoryView = this.curr?.technology?.items !== undefined;
    const hasRealTool = product !== undefined && product !== 'material';
    const showActionTool = !hasInventoryView || hasRealTool;
    const working = view.working === true || (view.working === undefined && atTarget);
    const previous = this.prevPeople.get(view.id);
    const consuming = view.action === 'drink' ? previous?.thirst !== undefined && view.thirst !== undefined && previous.thirst > view.thirst
      : view.action === 'eat' && previous !== undefined && previous.hunger > view.hunger;
    const beat = !this.reduceMotion && this.actionActive && !p.moving && (working || consuming) ? Math.floor(t * 3 + p.seed) % 2 : 0;
    // V19: labor agrícola sobre el cultivo real de la casilla (azada al arar, hoz al cosechar, gavilla al comer).
    const cropWork = cropWorkMode(view.action, working, p.moving, this.tileAt(Math.round(p.x), Math.round(p.y)));

    if (view.action === 'hunt') {
      if (showActionTool) {
        add(ax + 5 + beat, baseY - 13 + beat * 3, 1, 13, css(P.trunkLight), true);
        add(ax + 4 + beat, baseY - 15 + beat * 3, 3, 3, toolHex, true);
        add(ax + 5 + beat, baseY - 16 + beat * 3, 1, 1, craft?.glint ? '#f4ffff' : toolHex, false);
      } else {
        add(ax + 3 + beat, baseY - 7 + beat * 2, 3, 2, skinHex, true);
      }
    } else if (view.action === 'drink') {
      const lift = p.moving ? 4 : beat;
      add(ax + 3, headTop + 3 + lift, 3, 3, craft?.tint ?? css(P.waterGleam), true);
      if (craft?.glint) add(ax + 3, headTop + 3 + lift, 1, 1, '#f4ffff', false);
      add(ax + 3, headTop + 5 + lift, 3, 1, css(P.water), false);
    } else if (view.action === 'eat') {
      add(ax + 3, headTop + 4 + beat, 2, 2, css(P.amber), true);
      add(ax + 2, headTop + 5 + beat, 2, 1, skinHex, false);
    } else if (view.action === 'forage') {
      const reach = beat * 3;
      add(ax + 3 + reach, baseY - 6 + beat * 3, 3, 1, skinHex, true);
      add(ax + 3, baseY - 3, 4, 3, css(P.trunkLight), true);
      add(ax + 3, baseY - 1, 4, 1, css(P.soil), false);
      add(ax + 4, baseY - 4, 2, 1, css(P.soil), true);
      if ((view.foodReserve ?? 0) > 0) {
        add(ax + 4, baseY - 3, 2, 1, css(P.amber), false);
        add(ax + 5, baseY - 4, 1, 1, css(P.grassLight), false);
      }
    } else if (view.action === 'build' || view.action === 'repair' || view.action === 'invent' || view.action === 'research' || view.action === 'craft') {
      const hand = baseY - 6 - beat * 4;
      add(ax + 3, hand, 3, 1, skinHex, true);
      if (showActionTool) {
        add(ax + 6, hand - 3, 1, 5, css(P.trunkLight), true);
        add(ax + 5, hand - 4, 4, 2, toolHex, true);
        if (craft?.glint) add(ax + 5, hand - 4, 1, 1, '#f4ffff', false);
      } else {
        const hasStone = (view.materials?.stone ?? 0) > 0;
        add(ax + 5, hand - 2, 3, 2, css(hasStone ? P.stone : P.trunkLight), true);
      }
    } else if ((view.action === 'farm' && !cropWork) || view.action === 'gather') {
      const hand = baseY - 6 + beat * 2;
      add(ax + 3, hand, 3, 1, skinHex, true);
      if (showActionTool) {
        add(ax + 6, hand - 1, 1, 7, css(P.trunkLight), true);
        add(ax + 6, hand + 5, 4, 1, toolHex, true);
      } else {
        add(ax + 5, hand, 2, 2, css(P.soilLight), true);
      }
    } else if (view.action === 'cooperate' || view.action === 'share') {
      add(ax + 3, baseY - 6, 4, 4, css(P.soil), true);
      add(ax + 3, baseY - 7, 4, 1, css(P.grassLight), false);
    }

    // Pass 1: 1px dark silhouette outline (#231710)
    for (const r of rects) {
      if (r.outline) px(g, r.x - 1, r.y - 1, r.w + 2, r.h + 2, outlineHex);
    }
    // Pass 2: interior fill in layer order
    for (const r of rects) {
      px(g, r.x, r.y, r.w, r.h, r.color);
    }

    // Discrete body distress & manual control cues (drawn above outline)
    if (view.controlMode === 'directed') {
      px(g, headX - 2, headTop - 5, 4, 4, outlineHex);
      px(g, headX - 1, headTop - 4, 2, 2, '#f4d18b');
      px(g, headX, headTop - 5, 1, 1, '#fff6d6');
    }
    if ((view.thirst ?? 0) >= 0.82) {
      px(g, headX + 3, headTop - 1, 4, 5, outlineHex);
      px(g, headX + 4, headTop, 2, 3, css(P.waterGleam));
      px(g, headX + 4, headTop + 2, 2, 1, css(P.water));
    } else if ((view.hunger ?? 0) >= 0.82) {
      px(g, headX + 3, headTop - 1, 4, 5, outlineHex);
      px(g, headX + 4, headTop, 2, 2, css(P.coral));
      px(g, headX + 4, headTop + 2, 2, 1, css(P.coralDeep));
    }
    if (view.health !== undefined && view.health < 0.45) {
      px(g, ax - 4, baseY + 3, 8, 1, '#2b1414');
      px(g, ax - 4, baseY + 3, Math.max(1, Math.round(clamp01(view.health) * 8)), 1, '#e05252');
    }
    if (working && view.workProgress !== undefined && view.workProgress > 0 && this.cam.zoom >= 18) {
      px(g,ax-5,baseY+4,10,2,css(P.ink,.65)); px(g,ax-5,baseY+4,Math.max(1,Math.round(clamp01(view.workProgress)*10)),1,css(P.amber));
    }
    if (cropWork) drawCropWork(g, { mode: cropWork, ax, baseY, t, seed: p.seed, animate: !this.reduceMotion && this.actionActive, workProgress: view.workProgress, ring: this.cam.zoom >= 18 });
  }

  /* ------------------------ capas de pantalla ---------------------- */

  private drawAmbient(cw: number, ch: number, now: number, tint: { color: string; alpha: number; rain: number }): void {
    const ctx = this.labelCtx;
    // El suavizado ya ocurre por fotograma (AtmosphereSmoother): sin transiciones CSS que lo contradigan.
    const rainAlpha = (RAIN_TINT.alpha * tint.rain).toFixed(3);
    const key = `${tint.color}:${tint.alpha.toFixed(3)}:${rainAlpha}`;
    if (key !== this.ambientKey) {
      this.ambientKey = key;
      this.phaseLayer.style.transition = 'none'; this.rainLayer.style.transition = 'none';
      this.phaseLayer.style.backgroundColor = tint.color; this.phaseLayer.style.opacity = tint.alpha.toFixed(3);
      this.rainLayer.style.backgroundColor = RAIN_TINT.color; this.rainLayer.style.opacity = rainAlpha;
    }
    // Viñeta muy leve: acerca el mapa al papel sin degradados pesados.
    const v = ctx.createRadialGradient(
      cw / 2,
      ch / 2,
      Math.min(cw, ch) * 0.42,
      cw / 2,
      ch / 2,
      Math.max(cw, ch) * 0.72,
    );
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(24,30,26,0.16)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, cw, ch);
    this.drawRain(tint.rain, now);
    this.drawEventAccents(now);
  }

  private drawRain(intensity: number, now: number): void {
    this.effects.rain = 0;
    if (intensity < .02) return;
    const g = this.labelCtx, count = Math.min(VISUAL_BUDGET.rain, Math.ceil(Math.ceil(this.cssW * this.cssH / 12500) * Math.min(1, intensity)));
    const time = this.reduceMotion ? 0 : Math.floor(now / 85) * .085;
    g.save(); g.scale(this.dpr, this.dpr); g.strokeStyle = intensity >= .98 ? 'rgba(211,232,223,.30)' : `rgba(211,232,223,${(.3 * Math.min(1, intensity)).toFixed(3)})`; g.lineWidth = 1; g.beginPath();
    for (let i = 0; i < count; i++) {
      const x = (rnd(i, 0, 991) * this.cssW + time * 38) % this.cssW;
      const y = (rnd(i, 1, 993) * this.cssH + time * 210) % this.cssH;
      g.moveTo(x, y); g.lineTo(x + 2, y + 8); this.effects.rain++;
    }
    g.stroke(); g.restore();
  }

  private drawEventAccents(now: number): void {
    this.effects.events = 0;
    this.eventAccents = this.eventAccents.filter(event => now - event.bornAt < EVENT_LIFETIME_MS);
    const g = this.labelCtx;
    g.save(); g.scale(this.dpr, this.dpr);
    for (const event of this.eventAccents) {
      const screen = this.worldToScreen(event.x + .5, event.y + .5);
      if (screen.x < -30 || screen.y < -30 || screen.x > this.cssW + 30 || screen.y > this.cssH + 30) continue;
      const progress = clamp01((now - event.bornAt) / EVENT_LIFETIME_MS);
      const radius = this.reduceMotion ? 12 : 10 + progress * 14;
      const isConflict = event.kind === 'conflict';
      const isMeeting = event.kind === 'meeting';
      const strokeRgb = isConflict ? '224,88,72'
        : isMeeting ? '238,148,118'
        : event.kind === 'birth' || event.kind === 'care' ? '168,224,132'
        : event.kind === 'invention' || event.kind === 'learning' ? '132,214,218'
        : event.kind === 'discovery' ? '232,158,120' : '239,208,136';
      const fillRgb = isConflict ? '250,165,152'
        : isMeeting ? '252,208,188'
        : event.kind === 'birth' || event.kind === 'care' ? '210,245,180'
        : event.kind === 'invention' || event.kind === 'learning' ? '190,242,245'
        : event.kind === 'discovery' ? '248,204,176' : '249,231,181';
      g.strokeStyle = `rgba(${strokeRgb},${(1 - progress) * .85})`; g.lineWidth = isConflict ? 2 : 1.5; g.beginPath();
      g.ellipse(screen.x, screen.y, radius, radius * .46, 0, 0, Math.PI * 2); g.stroke();
      if (isConflict) {
        g.beginPath();
        g.ellipse(screen.x, screen.y, radius * .68, radius * .31, 0, 0, Math.PI * 2);
        g.stroke();
      }
      // Four small marks read as an acknowledgement, not sparks, births or physical light.
      g.fillStyle = `rgba(${fillRgb},${1 - progress})`;
      for (const side of [-1, 1]) g.fillRect(screen.x + side * radius - 1, screen.y - radius * .5 - 3, 2, 3);
      this.effects.events++;
    }
    g.restore();
  }

  /**
   * Visualizes active interpersonal debates/disputes (`conflict`), teachings (`learning`),
   * cooperation/sharing (`cooperate`, `share`, `care`), and S↔I / close meetings on the overlay canvas.
   */
  private drawSocialLinks(people: RenderPerson[]): void {
    if (people.length < 2 || !this.curr) return;
    const ctx = this.labelCtx;
    const byId = new Map<string, RenderPerson>();
    for (const p of people) byId.set(p.view.id, p);
    const drawnPairs = new Set<string>();
    const drawArc = (a: RenderPerson, b: RenderPerson, kind: 'conflict' | 'learning' | 'cooperate' | 'bond'): void => {
      const pairKey = a.view.id < b.view.id ? `${a.view.id}:${b.view.id}` : `${b.view.id}:${a.view.id}`;
      if (drawnPairs.has(pairKey)) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 5.5) return;
      drawnPairs.add(pairKey);
      const sa = this.worldToScreen(a.x + 0.5, a.y + 0.35);
      const sb = this.worldToScreen(b.x + 0.5, b.y + 0.35);
      if ((sa.x < -40 && sb.x < -40) || (sa.x > this.cssW + 40 && sb.x > this.cssW + 40)) return;
      const mx = (sa.x + sb.x) / 2;
      const my = Math.min(sa.y, sb.y) - Math.max(8, Math.min(22, dist * this.cam.zoom * 0.22));
      ctx.save();
      ctx.strokeStyle = kind === 'conflict' ? 'rgba(224,92,74,0.82)'
        : kind === 'learning' ? 'rgba(132,214,218,0.82)'
        : kind === 'bond' ? 'rgba(232,134,108,0.78)' : 'rgba(176,214,132,0.78)';
      ctx.lineWidth = kind === 'conflict' ? 1.75 : 1.35;
      if (kind === 'conflict' || kind === 'learning') ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.quadraticCurveTo(mx, my, sb.x, sb.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Midpoint dialogue/interaction glyph
      const gx = Math.round(mx), gy = Math.round((sa.y + sb.y) / 4 + my / 2);
      ctx.fillStyle = '#1f1a15d9';
      ctx.fillRect(gx - 4, gy - 4, 8, 8);
      ctx.fillStyle = kind === 'conflict' ? '#f2725c'
        : kind === 'learning' ? '#8ce0e6'
        : kind === 'bond' ? '#f4a88e' : '#b8e288';
      if (kind === 'conflict') {
        ctx.fillRect(gx - 3, gy - 2, 2, 4);
        ctx.fillRect(gx + 1, gy - 2, 2, 4);
      } else if (kind === 'learning') {
        ctx.fillRect(gx - 1, gy - 3, 2, 6);
        ctx.fillRect(gx - 3, gy - 1, 6, 2);
      } else {
        ctx.fillRect(gx - 2, gy - 2, 4, 4);
      }
      ctx.restore();
    };

    // 1. Recent chronicle events in the current window involving 2 visible actors
    const recentCutoff = this.curr.tick - 30;
    for (const ev of this.curr.events) {
      if (ev.tick < recentCutoff || ev.actors.length < 2) continue;
      const a = byId.get(ev.actors[0]!), b = byId.get(ev.actors[1]!);
      if (!a || !b) continue;
      if (ev.kind === 'conflict') drawArc(a, b, 'conflict');
      else if (ev.kind === 'learning') drawArc(a, b, 'learning');
      else if (ev.kind === 'cooperation' || ev.kind === 'care') drawArc(a, b, 'cooperate');
      else if (ev.kind === 'meeting') drawArc(a, b, 'bond');
    }

    // 2. Active live social actions (share, cooperate, accompany, approach) & S↔I proximity
    for (const p of people) {
      const act = p.view.action;
      if (act !== 'share' && act !== 'cooperate' && act !== 'accompany' && act !== 'approach' && p.view.role !== 'S') continue;
      let nearest: RenderPerson | null = null;
      let bestD = 3.2;
      for (const other of people) {
        if (other.view.id === p.view.id) continue;
        if (p.view.role === 'S' && act !== 'share' && act !== 'cooperate' && act !== 'accompany' && act !== 'approach' && other.view.role !== 'I') continue;
        const d = Math.hypot(p.x - other.x, p.y - other.y);
        if (d < bestD) { bestD = d; nearest = other; }
      }
      if (nearest) {
        const kind = (p.view.role === 'S' && nearest.view.role === 'I') || act === 'accompany' || act === 'approach' ? 'bond' : 'cooperate';
        drawArc(p, nearest, kind);
      }
    }
  }

  /** Selección e insignias: en píxeles de pantalla, para que el texto no se pixele. */
  private drawOverlaysScreen(people: RenderPerson[], animals: RenderAnimal[]): void {
    const ctx = this.labelCtx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.drawSocialLinks(people);

    if (this.pendingTarget) {
      const mark = this.worldToScreen(this.pendingTarget.x + .5, this.pendingTarget.y + .5);
      ctx.strokeStyle = '#f4d18b'; ctx.fillStyle = '#ddb25533'; ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.arc(mark.x, mark.y, Math.max(9, this.cam.zoom * .42), 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      this.drawChip(mark.x, mark.y - 23, 'Pendiente', P.ink, P.amber, 'meta');
    }
    this.drawDestination(people);

    const sel = this.selection;
    if (sel && sel.kind === 'tile') {
      const a = this.worldToScreen(sel.x, sel.y);
      ctx.strokeStyle = css(P.paper, 0.9);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        Math.round(a.x) + 0.5,
        Math.round(a.y) + 0.5,
        Math.round(this.cam.zoom) - 1,
        Math.round(this.cam.zoom) - 1,
      );
      ctx.setLineDash([]);
    }

    for (const p of people) {
      const s = this.worldToScreen(p.x + 0.5, p.y + 0.75);
      if (s.x < -60 || s.x > this.cssW + 60 || s.y < -60 || s.y > this.cssH + 60) continue;

      if (sel && sel.kind === 'person' && sel.id === p.view.id) {
        ctx.beginPath();
        ctx.ellipse(s.x, s.y, this.cam.zoom * 0.42, this.cam.zoom * 0.2, 0, 0, Math.PI * 2);
        ctx.strokeStyle = css(P.paper, 0.95);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        this.drawChip(s.x, s.y + 14, sanitizeLabel(p.view.name, 22), P.ink, P.rule, 'meta');
      }

      if (p.view.role === 'S' || p.view.role === 'I') {
        const top = this.worldToScreen(p.x + 0.5, p.y + 0.5).y - Math.max(16, this.cam.zoom * 0.62);
        this.drawChip(
          s.x,
          top,
          p.view.role,
          p.view.role === 'S' ? P.amberDeep : P.coralDeep,
          p.view.role === 'S' ? P.amber : P.coral,
          'serif',
        );
      }
    }
    if (sel?.kind === 'animal') {
      const animal = animals.find(a => a.view.id === sel.id);
      if (animal) {
        const s = this.worldToScreen(animal.x + .5, animal.y + .75);
        if (s.x >= -60 && s.x <= this.cssW + 60 && s.y >= -60 && s.y <= this.cssH + 60) {
          ctx.beginPath(); ctx.ellipse(s.x, s.y, this.cam.zoom * .42, this.cam.zoom * .2, 0, 0, Math.PI * 2); ctx.strokeStyle = '#f2dfb0'; ctx.lineWidth = 1.5; ctx.stroke();
          this.drawChip(s.x, s.y + 15, `${speciesNames[animal.view.species]} · ${animalActions[animal.view.action]}`, P.ink, P.rule, 'meta');
        }
      }
    }
    this.drawLoading();
    ctx.restore();
  }

  /** V18: pulso local en el destino ordenado, visible desde el clic aunque el servidor aplique la orden un paso (o varios segundos) después. */
  private drawDestination(people: RenderPerson[]): void {
    const d = this.destination;
    if (!d) return;
    const now = performance.now(), age = now - d.bornAt;
    const body = d.id ? people.find(p => p.view.id === d.id) : undefined;
    const arrived = !!body && age > 500 && Math.hypot(body.x - d.x, body.y - d.y) < .3 && !body.moving;
    if (age > DESTINATION_MS || arrived) { this.destination = null; return; }
    const mark = this.worldToScreen(d.x + .5, d.y + .5);
    if (mark.x < -40 || mark.x > this.cssW + 40 || mark.y < -40 || mark.y > this.cssH + 40) return;
    const ctx = this.labelCtx, phase = this.reduceMotion ? .5 : (age % 1100) / 1100;
    const fade = clamp01(1 - Math.max(0, age - (DESTINATION_MS - 1500)) / 1500);
    ctx.save();
    ctx.strokeStyle = '#f4d18b'; ctx.fillStyle = '#f4d18b'; ctx.lineWidth = 2;
    ctx.globalAlpha = (1 - phase) * .85 * fade; ctx.beginPath(); ctx.arc(mark.x, mark.y, this.cam.zoom * (.18 + .42 * phase), 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = .9 * fade; ctx.beginPath(); ctx.arc(mark.x, mark.y, Math.max(2.5, this.cam.zoom * .09), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /** V18: aviso sereno y no bloqueante mientras llega terreno que el cliente todavía no conoce. */
  private drawLoading(): void {
    const now = performance.now();
    const wanted = this.loadingSince > 0 && now - this.loadingSince > LOADING_DELAY_MS;
    this.loadingAlpha += ((wanted ? 1 : 0) - this.loadingAlpha) * .12;
    if (this.loadingAlpha < .03) { this.loadingAlpha = 0; return; }
    const ctx = this.labelCtx;
    ctx.save(); ctx.globalAlpha = this.loadingAlpha * .85;
    this.drawChip(this.cssW / 2, this.cssH - 26, 'Explorando el terreno…', P.ink, P.rule, 'meta');
    ctx.restore();
  }

  private drawChip(cx: number, cy: number, text: string, ink: RGB, accent: RGB, style: 'serif' | 'meta'): void {
    const ctx = this.labelCtx;
    ctx.font =
      style === 'serif'
        ? '600 12px ui-serif, Georgia, "Times New Roman", serif'
        : '600 9px ui-sans-serif, system-ui, -apple-system, sans-serif';
    if (style === 'meta') ctx.letterSpacing = '0.08em';
    const w = Math.ceil(ctx.measureText(text).width) + 12;
    const h = style === 'serif' ? 17 : 15;
    const x = clamp(Math.round(cx - w / 2), 2, Math.max(2, this.cssW - w - 2));
    const y = clamp(Math.round(cy - h / 2), 2, Math.max(2, this.cssH - h - 2));
    const r = 3;

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = css(P.paper, 0.96);
    ctx.fill();
    ctx.strokeStyle = css(accent, 0.8);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = css(accent, 0.9);
    ctx.fillRect(x + 3, y + h - 2, w - 6, 1);
    ctx.fillStyle = css(ink);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + h / 2 + (style === 'serif' ? 0.5 : 0));
    ctx.letterSpacing = '0px';
  }

  /* ---------------------------------------------------------------- */
  /* Interacción                                                      */
  /* ---------------------------------------------------------------- */

  private localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private handlePointerDown(e: PointerEvent): void {
    this.followedId = null; this.onManualCamera?.();
    const pt = this.localPoint(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus({ preventScroll: true });
    this.pointers.set(e.pointerId, {
      x: pt.x,
      y: pt.y,
      startX: pt.x,
      startY: pt.y,
      startedAt: performance.now(),
      moved: false,
    });
    if (this.pointers.size === 2) {
      this.pinchDist = this.pointerDistance();
      this.pinchZoom = this.cam.zoom;
      this.suppressClick = true;
    }
    this.canvas.style.cursor = 'grabbing';
    this.focusTo = null;
  }

  private handlePointerMove(e: PointerEvent): void {
    const state = this.pointers.get(e.pointerId);
    if (!state) return;
    const pt = this.localPoint(e);
    const dx = pt.x - state.x;
    const dy = pt.y - state.y;
    state.x = pt.x;
    state.y = pt.y;
    if (Math.abs(pt.x - state.startX) > 4 || Math.abs(pt.y - state.startY) > 4) state.moved = true;

    if (this.pointers.size >= 2) {
      // Pellizco: escala por la razón de distancias, anclada al punto medio.
      const dist = this.pointerDistance();
      const mid = this.pointerMidpoint();
      if (this.pinchDist > 8 && dist > 8) {
        this.setZoom(this.pinchZoom * (dist / this.pinchDist), mid.x, mid.y);
      }
      return;
    }

    this.cam.x -= dx / this.cam.zoom;
    this.cam.y -= dy / this.cam.zoom;
    this.clampCamera();
  }

  private handlePointerUp(e: PointerEvent): void {
    const state = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    this.canvas.style.cursor = 'grab';
    if (!state) return;
    if (this.pointers.size > 0) return;

    const wasPinch = this.suppressClick;
    this.suppressClick = false;
    if (wasPinch || state.moved || e.type === 'pointercancel') return;
    if (performance.now() - state.startedAt > 700) return;
    this.pick(state.x, state.y);
  }

  private pointerDistance(): number {
    const list = [...this.pointers.values()];
    const a = list[0];
    const b = list[1];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private pointerMidpoint(): { x: number; y: number } {
    const list = [...this.pointers.values()];
    const a = list[0];
    const b = list[1];
    if (!a || !b) return { x: this.cssW / 2, y: this.cssH / 2 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private handleWheel(e: WheelEvent): void {
    this.followedId = null; this.onManualCamera?.();
    e.preventDefault();
    const pt = this.localPoint(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 200 : 1;
    const notches = clamp((-e.deltaY * unit) / 120, -3, 3);
    this.focusTo = null;
    this.setZoom(this.cam.zoom * Math.pow(1.18, notches), pt.x, pt.y);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? 6 : 2;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        this.cam.x -= step;
        break;
      case 'ArrowRight':
        this.cam.x += step;
        break;
      case 'ArrowUp':
        this.cam.y -= step;
        break;
      case 'ArrowDown':
        this.cam.y += step;
        break;
      case '+':
      case '=':
        this.zoom(1);
        break;
      case '-':
      case '_':
        this.zoom(-1);
        break;
      case 'Home': {
        const s = this.curr?.people.find((p) => p.role === 'S') ?? this.home;
        if (s) this.focus(s.x, s.y);
        else this.focus(this.worldW / 2, this.worldH / 2);
        break;
      }
      default:
        handled = false;
    }
    if (handled) {
      this.followedId = null; this.onManualCamera?.();
      e.preventDefault();
      if (e.key !== 'Home') this.focusTo = null;
      this.clampCamera();
    }
  }

  /** Primero las personas (radio 0,65 tiles); si no hay nadie cerca, el tile. */
  private pick(sx: number, sy: number): void {
    const world = this.curr;
    if (!world) return;
    const w = this.screenToWorld(sx, sy);

    let best: Selection | null = null;
    let bestD = PERSON_HIT * PERSON_HIT;
    for (const p of this.interpolatePeople(performance.now())) {
      const dx = p.x + 0.5 - w.x;
      const dy = p.y + 0.5 - w.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = { kind: 'person', id: p.view.id };
      }
    }
    for (const animal of this.interpolateAnimals(performance.now())) {
      const d = (animal.x + .5 - w.x) ** 2 + (animal.y + .5 - w.y) ** 2;
      if (d < bestD) { bestD = d; best = { kind: 'animal', id: animal.view.id }; }
    }

    if (best) {
      this.selection = best;
      this.onSelect(this.selection);
      return;
    }

    // Tall artwork belongs to its root cell; overlays explicitly inspect the ground beneath it.
    if (this.pickMode === 'inspect' && this.layer === 'none') {
      const decorations: { x: number; y: number; foot: number; left: number; top: number; raster: () => HTMLCanvasElement }[] = [];
      const cellX = Math.floor(w.x), cellY = Math.floor(w.y);
      for (let y = cellY; y <= cellY + 3; y++) for (let x = cellX - 1; x <= cellX + 1; x++) {
        const tile = this.tileAt(x, y), sprite = tile ? this.treeSprite(tile) : null;
        if (sprite) decorations.push({x,y,foot:sprite.ay,left:Math.round(sprite.ax)-16,top:Math.round(sprite.ay)-44,raster:()=>this.treeRaster(sprite.tree!,1)});
      }
      for (const structure of world.structures ?? []) {
        if (Math.abs(structure.x-cellX)>1 || structure.y<cellY || structure.y>cellY+1) continue;
        decorations.push({x:structure.x,y:structure.y,foot:structure.y*ART+13,left:structure.x*ART-8,top:structure.y*ART-16,raster:()=>this.structureRaster(structure)});
      }
      decorations.sort((a,b)=>b.foot-a.foot);
      for (const decoration of decorations) {
        const px = Math.floor(w.x*ART-decoration.left), py = Math.floor(w.y*ART-decoration.top);
        const art = decoration.raster();
        if (px < 0 || py < 0 || px >= art.width || py >= art.height) continue;
        if (art.getContext('2d')!.getImageData(px,py,1,1).data[3]! < 96) continue;
        this.selection = {kind:'tile',x:decoration.x,y:decoration.y}; this.onSelect(this.selection); return;
      }
    }

    const tx = Math.floor(w.x);
    const ty = Math.floor(w.y);
    if (!this.tileAt(tx, ty)) return;
    this.selection = { kind: 'tile', x: tx, y: ty };
    this.onSelect(this.selection);
  }
}
