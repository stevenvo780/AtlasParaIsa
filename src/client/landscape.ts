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
import { sanitizeGraphicsSettings, PRESET_SETTINGS, type GraphicsSettings } from './graphics-settings.js';
import { CAPAS_V23, MAP_LAYER_CATALOG, colorDeDueno, isMapLayerId, type MapLayerId } from './layers-control.js';
import { valorCrudo, posicionEnRampa, type Capa as LegacyCapa } from './calor.js';
import { geologyAt } from '../shared/chemistry.js';
import { PROTOCOL_VERSION } from '../shared/types.js';
import type { AnimalView, PersonView, PlaceView, StructureView, Terrain, Tile, Viewport, WorldView } from '../shared/types.js';
import { BoundedCache, GpuTerrain, type GpuStatus, type TerrainRaster } from './gpu-terrain.js';
import { animalActions, paintAnimal, paintStructure, paintTree, treeForm, type TreeForm, type AnimalVisualTraits,
  escalaDeCuerpo, escalaDeFauna, extraccionVisible, fraccionGestacion, madurezDeFauna, nombreDeFauna, paintEmbarazo, paintMarcaExtraccion,
  paintMiedo, pelajeDeLinaje, planDeFauna } from './life-art.js';
import { bodySeed, animalPose, daylightAt, intensidadLluvia, newEventAccents, AtmosphereSmoother, CadenceEstimator, MotionTracker, PlaybackBuffer, VISUAL_BUDGET, EVENT_LIFETIME_MS, type EventAccent } from './visual-state.js';
import { firmaMat, mismaMat, PaletaSustancias, type ClientTileCache } from './tile-cache.js';
import type { AireVisible, CuerpoVisible, LoteVisible } from '../shared/vistas-v23.js';
import type { Capability } from '../shared/technology.js';
import { decidirModo, rendererProfile, type Modo } from './modo.js';
import { dibujarCalor, type Capa, type RangoCalor } from './calor.js';
import { claveRegion } from './regiones.js';
import { cropSignature, cropStage, cropWorkMode, drawCropWork, paintCropField } from './crop-art.js';
import { paintGeologyVeins, paintRoadTile, paintVetasComposicion } from './road-geology-art.js';
import { footprintBox, footprintCells, isModular, paintCompactAccessories, paintConstructionSite, paintModularHall, structureExtent, type ExtendedStructure,
  claveLote, figuraDeLote, humoDeFuego, paintFuego, paintLote, LOTE_SPRITE } from './structure-art.js';
import { brilloTermico, classifyTerrainPixel, colorCuerpoNegro, colorTermico, escarcha, hash3, materialNoise, newFieldPixel, prepareTerrainStencil, rnd,
  sustanciaDelPixel, umbralBayer as umbralTrama, waterDepthTone, type FieldSample, type Rgb } from './terrain-field.js';

/** Only discrete phenotype buckets enter the sprite key; continuous genetic noise never does. */
export function animalVisualTraits(v: AnimalView): AnimalVisualTraits {
  const bucket = (n: number | undefined): 0 | 1 | 2 => n === undefined || !Number.isFinite(n) ? 1 : n < .35 ? 0 : n >= .65 ? 2 : 1;
  const base = animalVisualTraitsBase(v, bucket);
  // V23: sin especie en las reglas, el pelaje sale del linaje fundador y la madurez de la masa sobre la adulta.
  return v.v23 ? { ...base, maturity: madurezDeFauna(v) ?? base.maturity, pelaje: pelajeDeLinaje(v.v23.linaje) } : base;
}
function animalVisualTraitsBase(v: AnimalView, bucket: (n: number | undefined) => 0 | 1 | 2): AnimalVisualTraits {
  return {
    camouflage: v.genes?.camouflage > .56 ? 2 : v.genes?.camouflage < .44 ? 0 : 1,
    agile: v.genes?.speed > .56 || v.genes?.perception > .56 || (v.morphology?.caution ?? 0) >= .65 ? 1 : 0,
    fierce: v.genes?.carnivory > .54 ? 1 : 0,
    maturity: (v.age ?? 1200) < 700 ? 0 : (v.generation ?? 0) >= 3 ? 2 : 1,
    size: bucket(v.morphology?.size), coat: bucket(v.morphology?.coat), defense: bucket(v.morphology?.defense),
    tame: (v.habituation ?? 0) >= .75 ? 2 : (v.habituation ?? 0) >= .45 ? 1 : 0,
  };
}
export function animalSpriteKey(v: AnimalView, pose: number, traits = animalVisualTraits(v), plan: AnimalView['species'] = v.species): string {
  // Drink/graze and roam/flee/hunt use identical silhouettes at a given pose.
  const action = v.action === 'rest' ? 'rest' : v.action === 'drink' || v.action === 'graze' ? 'graze' : 'roam';
  return `animal:${plan}:${action}:${pose}:${Object.values(traits).join(':')}`;
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
/** Un vínculo de confianza de la persona seleccionada: con quién, cuánto (0–1) y el color de la comunidad de ese otro. */
export interface VinculoMapa { id: string; peso: number; color: string }

/* ------------------------------------------------------------------ */
/* Constantes de arte                                                  */
/* ------------------------------------------------------------------ */

/** Píxeles de arte por tile: la resolución nativa del pixel-art. */
const ART = 16;
const CHUNK_ART_TILES = 8;
/** V24: rasters de 128×128 (64 KiB). Debe superar a los trozos visibles del nivel lejano (`FAR_CHUNK_CAP`): con menos, la LRU
 * expulsaba trozos aún visibles (lienzos de 0×0) y el bucle de dibujo moría al alejar. */
const TERRAIN_CACHE_LIMIT = 1100;
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
/**
 * V24 — nivel «mapa»: por debajo de estos px/tesela, o si el nivel lejano necesitaría más de `FAR_CHUNK_CAP` trozos de suelo
 * visibles, el suelo y el arbolado se pintan con trozos de baja resolución (`MAP_ART` px/tesela) y los cuerpos como puntos.
 * Así el coste por fotograma queda acotado por la pantalla y no por las teselas visibles.
 */
const MAP_ZOOM = 7;
/**
 * V24: el nivel cercano (escena a 16 px/tesela con vaivén, sombras y recortes, rehecha en cada fotograma en que algo se
 * mueve) solo si lo visible no pasa de tantas teselas (a 1080p, desde ≈ 18 px/tesela). Más allá, el lejano: el mismo
 * pixel-art (copas a escala 1) sin vaivén ni sombras. Así el coste cercano lo acota la pantalla y no el zoom.
 */
const NEAR_TILE_CAP = 6400;
/** Teselas de más por eje que puede tener la rejilla de cerca antes de recomponerla (≥ 2·WINDOW_MARGIN + 2·alineación). */
const NEAR_GRID_SLACK = 48;
const FAR_CHUNK_CAP = 900;
const MAP_ART = 4;
/** Bloques del mapa de 32×32 teselas (128×128 px): a 1080p y 4 px/tesela, ≈ 150 volcados por fotograma en vez de 2.000. */
const MAP_BLOCK = 32;
const MAP_CACHE_LIMIT = 512; // 128×128 RGBA = 64 KiB cada uno
/** V24: copas del nivel lejano por trozo de 8×8 (holgura para copas altas y anchas), a la escala de la pantalla (≤ 1). */
const CANOPY_PAD = { left: 16, right: 16, top: 40, bottom: 4 } as const;
const CANOPY_CACHE_LIMIT = 1100;
/** V24: horneado de suelo por fotograma (ms) cuando hay muchos trozos pendientes; el resto espera al siguiente fotograma. */
const BAKE_BUDGET_MS = 6;
/** V24: tras tantos ms sin cambiar el zoom se rehacen las copas/suelos reducidos a la escala nueva. */
const ZOOM_SETTLE_MS = 250;
/** V24: hasta tantos trozos sucios se rehornean en el mismo `update` (un tick normal toca muy pocos). */
const BAKE_SYNC_CHUNKS = 24;
/** V24: ventana completa horneada de golpe (primer encuadre, pruebas) si no pasa de tantos trozos. */
const BAKE_SYNC_WINDOW = 320;
/** V24: sprites de persona por identidad + pose (32×32 RGBA = 4 KiB). */
const PERSON_SPRITE_LIMIT = 3072;
/** V23: sprites de lotes (32×36 RGBA ≈ 4,5 KiB cada uno). */
const LOTE_CACHE_LIMIT = 1024;
/** V23: lado de una página del motor en teselas (`Fotograma.paginas`: páginas 16×16). */
const PAGINA = 16;
/** V23: lo que dura el destello de una página que cambió de dueño (ms). */
const MIGRACION_DESTELLO_MS = 1500;
const PERSON_SPRITE = { w: 32, h: 32, ox: 16, oy: 22 } as const;
/** V24: ventana pedida al servidor (la mayor que acepta): más grande que la cámara, para no repedir con cada paneo. */
const REQUEST_WINDOW = { w: 96, h: 64 } as const;
/** V22/V24: la animación de los salones modulares (humo, brasas) se re-pinta a esta cadencia, no en cada fotograma. */
const HALL_POSES_PER_SEC = 12;
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
  /** V23: colores de las sustancias de `Tile.mat` (ya con su temperatura) y sus fracciones; ausente = suelo de hoy. */
  mat: { colores: RGB[]; fracciones: number[]; escarcha: number } | null;
  /** Versión de la paleta con que se calculó (una sustancia aprendida después rehace el material). */
  paleta: number;
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
/** V23: color de la escarcha y del hielo sobre suelo o agua por debajo de la fusión. */
const ESCARCHA = rgb(226, 236, 242);
/** V23: humo y color de un lote cuya sustancia aún no tiene ficha (gris neutro de piedra). */
const HUMO = rgb(104, 100, 96);
const LOTE_SIN_FICHA: Rgb = [136, 128, 120];
const deRgb = (c: Rgb): RGB => rgb(c[0], c[1], c[2]);
const aRgb = (c: RGB): Rgb => [c.r, c.g, c.b];
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
/** V23: uid del frente con que `FaunaVisible.persigue`/`huyeDe` nombran a alguien. Viaja en `CuerpoVisible.uid` (pedido
 * al integrador); sin él la línea de persecución o huida no se dibuja (no se adivina a quién). */
function uidVisible(v: { cuerpoVisto?: CuerpoVisible }): number | undefined {
  const uid = (v.cuerpoVisto as (CuerpoVisible & { uid?: unknown }) | undefined)?.uid;
  return typeof uid === 'number' && Number.isFinite(uid) ? uid : undefined;
}

function cellKey(x: number, y: number): number { return (x + 16777216) * 33554432 + (y + 16777216); }

/** V24: misma tesela por valor (un fotograma completo de la cinta trae objetos nuevos aunque nada haya cambiado). */
function sameTile(a: Tile, b: Tile): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as unknown as Record<string, unknown>, rb = b as unknown as Record<string, unknown>;
  for (const key of ka) if (ra[key] !== rb[key] && !(key === 'mat' && mismaMat(a.mat, b.mat))) return false;
  return true;
}

function sameRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function formKey(form: TreeForm | null | undefined): string { return form ? `${form.kind}:${form.variant}:${form.height}:${form.width}:${form.foliage}` : ''; }

/** `#rrggbb` → [r, g, b] (las capas del catálogo son constantes; un color raro cae a gris). */
function hexRgb(hex: string): [number, number, number] {
  const m = /^#([\da-f]{6})$/i.exec(hex); const n = m ? Number.parseInt(m[1]!, 16) : 0x808080;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

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
  dvrMode: boolean; farLod: boolean; lod: LodTier;
  personSpriteBuilds: number; personSprites: number; terrainBakes: number; canopyChunkBuilds: number; mapChunkBuilds: number;
  windowComposes: number; tilePatches: number; farFrames: number; bodiesDrawn: number;
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
  Lote = 6,
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
  lote?: LoteVisible;
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

interface GroundChunk extends TerrainRaster { signature: number; stamp: number; }
/** V24: copas de un trozo (nivel lejano). `canvas` nulo = trozo sin árboles ni cabañas. */
interface CanopyChunk { sig: string; stamp: number; structureRevision: number; scale: number; canvas: HTMLCanvasElement | null; }
/** V24: suelo + arbolado de un trozo a `MAP_ART` px/tesela (nivel mapa). */
interface MapChunk { stamp: number; canvas: HTMLCanvasElement; x: number; y: number; }
export type LodTier = 'near' | 'far' | 'map';
interface LayerImage { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData; key: string; x: number; y: number; w: number; h: number; }
/** V24: con más teselas parcheadas que esto entre dos fotogramas, la imagen de capas se rehace entera. */
const LAYER_DIRTY_LIMIT = 8192;

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
  /** Hueco hasta el próximo fotograma de la cinta, solo si es corto (Paseo). 0 = el deslizamiento medido. */
  private dvrHoldMs = 0;
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
  /* V24 — coste por fotograma acotado al alejar */
  /** Sello de contenido por trozo de 8×8 (`cx:cy`): sube cuando cambia una de sus teselas o de su borde de 1 tesela. */
  private readonly chunkStamp = new Map<string, number>();
  /** Teselas (con borde) con las que se selló cada trozo de la ventana: una ventana nueva solo re-sella lo que cambió. */
  private chunkRefs = new Map<string, (Tile | undefined)[]>();
  private windowChunkKeys: string[] = [];
  /** Trozos de una recomposición de cámara cuya firma aún no se miró: se reparte entre fotogramas. */
  private pendingPrep: { cx: number; cy: number }[] | null = null;
  private stampCounter = 0;
  /** Sube si cambia algo que `SceneProps` deriva de la rejilla (árboles, cabañas, agua, rasgos), no con cada tesela. */
  private propsRevision = 0;
  /** Sube con cada parche de teselas (capas de datos del nivel lejano). */
  private tileRevision = 0;
  private readonly canopyCache = new BoundedCache<CanopyChunk>(CANOPY_CACHE_LIMIT, chunk => { if (chunk.canvas) chunk.canvas.width = chunk.canvas.height = 0; });
  private readonly mapCache = new BoundedCache<MapChunk>(MAP_CACHE_LIMIT, chunk => { chunk.canvas.width = chunk.canvas.height = 0; });
  private personSprites: BoundedCache<HTMLCanvasElement> | null = null;
  private spriteHits = 0; private spriteDirect = 0; private spriteFresh = 0;
  private communityColors = new Map<string, string>();
  private readonly layerImages: Record<'data' | 'legacy', LayerImage | null> = { data: null, legacy: null };
  private heatImage: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; key: string; x: number; y: number; w: number; h: number } | null = null;
  /** Teselas parcheadas desde el último fotograma lejano (para las imágenes de capas); se vacía en cada fotograma. */
  private layerDirty: Tile[] = [];
  private reportedWindow: Viewport | null = null;
  private reducedCache: BoundedCache<{ revision: number; size: number; canvas: HTMLCanvasElement }> | null = null;
  private reducedBudgetAt = -1;
  private reducedSpent = 0;
  private frameStamp = 0;
  private lastFrameZoom = 0;
  private zoomMovedAt = -Infinity;
  private zoomSettled = true;
  private perf: PerfCounters = { dvrMode: false, farLod: false, lod: 'near', personSpriteBuilds: 0, personSprites: 0, terrainBakes: 0, canopyChunkBuilds: 0, mapChunkBuilds: 0,
    windowComposes: 0, tilePatches: 0, farFrames: 0, bodiesDrawn: 0, structuredTileBuilds: 0, scenePropsBuilds: 0, canopyBuilds: 0, canopyBlits: 0, hallBuilds: 0, hallBlits: 0, sceneBuilds: 0, bodyGridBuilds: 0, behindQueries: 0, behindCandidateTests: 0, behindSkipped: 0, gridRevision: 0, spritesSorted: 0 };
  /** V20: semilla del mundo para la geología latente (veta de hierro/cal/sal) horneada en el suelo. */
  private worldSeed: number | undefined;
  private sceneKey = '';
  /** Identidad de la rejilla retenida. Si no cambia, un paneo no vuelve a pintar la escena. */
  private sceneGridKey = '';
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
  /** V23: color y densidad de las sustancias vistas (los ids son estables en un mundo). */
  private readonly paleta = new PaletaSustancias();
  private readonly conoceSustancia = (id: number): boolean => this.paleta.conoce(id);
  private readonly colorSustancia = (id: number): Rgb | undefined => this.paleta.color(id);
  private mundoV23: string | undefined;
  /** V23: aire de las páginas visibles (clave «px,py») y dueño de cada página; null = la vista no lo trae. */
  private aire: Map<number, AireVisible> | null = null;
  private aireKey = '';
  private reparto: Map<number, number> | null = null;
  private repartoKey = '';
  private readonly coloresHilo = new Map<number, string>();
  /** Páginas que cambiaron de dueño y cuándo (ms de `performance.now`): destello de la migración en la capa «Hilos». */
  private readonly migraciones = new Map<number, number>();
  private readonly loteCache = new BoundedCache<HTMLCanvasElement>(LOTE_CACHE_LIMIT, canvas => { canvas.width = canvas.height = 0; });
  private grid: (Tile | undefined)[] = [];
  private prevPeople = new Map<string, PersonView>();
  private prevAnimals = new Map<string, AnimalView>();
  private followedKind: 'person' | 'animal' = 'person';
  private groundBaked = false;
  /** Celdas conocidas de la rejilla. */
  private gridCount = 0;

  private cam: Camera = { x: 0, y: 0, zoom: 24 };
  private minZoom = 8;
  private graphicsSettings: GraphicsSettings = { ...PRESET_SETTINGS.equilibrado };
  private activeLayers: ReadonlySet<MapLayerId> = new Set();
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
  private vinculos: { origen: string; aristas: readonly VinculoMapa[] } | null = null;

  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  // Ligero móvil (P1): decidido una vez por instancia; `resize`/`frame` lo usan. Wiring mínimo
  // fuera de esos dos métodos (una constante calculada, no una regla) — ver informe de T024.
  // R5: manda `options.modo` (así lo decidió quien instancia); solo se recae en la heurística
  // de `decidirModo()` cuando no se pasa ninguno explícito. Se asigna en el constructor (no aquí,
  // en el inicializador de campo) porque ahí ya existe `options`.
  private readonly modo: Modo;
  private readonly cutArchive: boolean;
  private archiveFocus: { x: number; y: number } | null = null;
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
    this.reduceMotion = this.cutArchive || e.matches;
  };

  constructor(canvas: HTMLCanvasElement, onSelect: SelectHandler, private readonly onViewport?: (viewport: Viewport) => void, private readonly onManualCamera?: () => void, options: { allowSoftwareWebGL?: boolean; modo?: 'completo' | 'observador'; cutArchive?: boolean } = {}) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.modo = options.modo ?? decidirModo();
    this.cutArchive = !!options.cutArchive;

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
      `${this.cutArchive ? 'Corte guardado del mundo' : 'Mundo vivo'}. Arrastra o usa las flechas para recorrer, más y menos para acercar, Inicio para volver. También puedes seleccionar habitantes y fauna desde el panel Población.`,
    );

    this.motionQuery =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reduceMotion = this.cutArchive || (this.motionQuery?.matches ?? false);
    if (this.motionQuery) {
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

  /**
   * Recibe un snapshot del servidor. Guarda el anterior para interpolar. V24: `changedTiles` (de la cinta delta) dice qué
   * teselas cambiaron; sin él se compara por valor. Solo se re-sellan y rehornean los trozos de 8×8 afectados.
   */
  update(world: WorldView, changedTiles?: readonly Tile[]): void {
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
    if (this.cutArchive && !first) this.clearCut();
    const resubmitted = this.curr === world; // el mismo objeto otra vez: su contenido pudo mutarse en sitio
    // Un eco de cámara (misma `sequence`) no es un paso del servidor: no mide cadencia.
    if (!this.cutArchive) {
      this.cadence.observe(world.sequence, world.tick, now);
      this.interval = this.cadence.tickIntervalMs;
      // V22: el DVR ya entrega los fotogramas a su ritmo exacto. Los cuerpos interpolan sin el colchón V18.
      if (this.dvrMode) {
        if (!this.reduceMotion) {
          this.peopleMotion.ingest(world.people, now); this.animalMotion.ingest(world.animals ?? [], now);
          if (this.dvrHoldMs > 0) { this.peopleMotion.prolongar(this.dvrHoldMs, now); this.animalMotion.prolongar(this.dvrHoldMs, now); }
        }
      }
      else this.playback.push(world, world.sequence, world.tick, now);
    }

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
    this.communityColors.clear();
    for (const community of world.communities ?? []) this.communityColors.set(community.id, community.color);
    this.ingestV23(world);
    this.sceneRevision++;
    this.syncStructures(world);

    this.serverWindow = { x: world.originX ?? 0, y: world.originY ?? 0, w: Math.max(0, Math.floor(world.width)), h: Math.max(0, Math.floor(world.height)) };
    // La cámara pudo moverse mientras el servidor terminaba el paso: si su ventana ya no cubre lo que se ve,
    // se compone con la caché (verdad fresca encima) en vez de dejar el hueco hasta el siguiente estado.
    const view = !first && !this.cutArchive && this.tileCache ? this.visibleBounds() : null;
    // V24: si la rejilla ya cubre la cámara y la ventana del servidor, un tick solo parchea sus teselas (antes cada tick
    // recomponía/rehorneaba la ventana entera: al alejar, decenas de miles de teselas 6 veces por segundo).
    if (!first && !resubmitted && this.canPatch(world, view)) this.patchTiles(changedTiles ?? world.tiles, changedTiles === undefined, world.tiles);
    else if (view && !this.windowCovers(this.serverWindow, view)) this.composeWindow(view, world.tiles);
    else if (this.rebuildGrid(world, resubmitted)) this.bakeGround(resubmitted);

    if (first) {
      this.fitWorld();
    }
  }

  /** Un corte reemplaza la escena completa, incluida la información que una vista continua puede heredar. */
  private clearCut(): void {
    this.curr = this.prev = null;
    this.eventAccents = [];
    this.playback.clear(); this.peopleMotion.clear(); this.animalMotion.clear();
    this.atmosphere.reset();

    this.paleta.clear(); this.aire = null; this.aireKey = '';
    this.reparto = null; this.repartoKey = ''; this.migraciones.clear(); this.loteCache.clear();

    this.sceneKey = ''; this.ambientKey = '';
    this.sceneProps = null; this.staticPropsOwner = null;
    this.spriteCache.clear(); this.animalCache.clear(); this.personSprites?.clear(); this.hallSlots.clear();
    this.layerImages.data = this.layerImages.legacy = null; this.heatImage = null; this.layerDirty = [];
    this.terrainCache.clear(); this.canopyCache.clear(); this.mapCache.clear(); this.reducedCache?.clear();
    this.chunks = []; this.groundBaked = false; this.gridTilesRef = null;
  }

  /** V18 capa 1.5: colapsa el colchón al estado más reciente (cámara movida u orden directa); luego se vuelve a llenar. */
  flushPlayback(): void { this.playback.flushToLatest(); }

  /**
   * V22: `true` cuando `DvrPlayer` conduce la reproducción. El colchón V18 (`PlaybackBuffer`, 3–6 s de retraso) se
   * puentea —el DVR ya da un ritmo regular— pero `MotionTracker` sigue interpolando A→B entre ticks consecutivos.
   */
  /** El reproductor avisa cuánto falta para el fotograma siguiente. Más de 8 s no se estira: el terreno espera. */
  setDvrHold(ms: number): void { this.dvrHoldMs = Number.isFinite(ms) && ms > 0 && ms <= 8_000 ? ms : 0; }

  setDvrMode(active: boolean): void {
    if (this.dvrMode === active) return;
    this.dvrMode = active; this.perf.dvrMode = active;
    this.playback.clear(); this.peopleMotion.clear(); this.animalMotion.clear();
    this.sceneKey = '';
    if (active && this.curr && !this.reduceMotion) { const now = performance.now(); this.peopleMotion.ingest(this.curr.people, now); this.animalMotion.ingest(this.curr.animals ?? [], now); }
  }

  /** V22: contadores internos (pruebas y diagnóstico): cuántas veces se rehízo cada caché y cuánto trabajo evitó el LOD. */
  getPerfCounters(): PerfCounters {
    return { ...this.perf, dvrMode: this.dvrMode, farLod: this.lodTier() !== 'near', lod: this.lodTier(), gridRevision: this.gridRevision, personSprites: this.personSprites?.size ?? 0 };
  }

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

  /** Rendering preferences only; no world mutation. Invalidate caches so every flag applies now. */
  setGraphicsSettings(settings: GraphicsSettings): void {
    this.graphicsSettings = sanitizeGraphicsSettings(settings);
    this.sceneKey = ''; this.ambientKey = ''; this.staticPropsOwner = null;
    this.spriteCache.clear(); this.hallSlots.clear();
    this.phaseLayer.style.opacity = '0'; this.rainLayer.style.opacity = '0';
    this.resize();
  }

  setActiveLayers(layers: ReadonlySet<MapLayerId>): void {
    this.activeLayers = new Set([...layers].filter(isMapLayerId));
    this.layer = 'none'; this.capaCalor = null; this.sceneKey = '';
  }

  setOverlay(layer: OverlayLayer): void { this.setLayer(layer); }
  setHeatMode(capa: Capa | null): void { this.setCapaCalor(capa); }
  focusTile(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.follow(null); this.focus(x, y);
  }
  setArchiveFocus(x: number, y: number): void {
    if (this.cutArchive && Number.isSafeInteger(x) && Number.isSafeInteger(y)) this.archiveFocus = { x, y };
  }
  getViewportBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfW = this.cssW / this.cam.zoom / 2, halfH = this.cssH / this.cam.zoom / 2;
    return { minX: this.cam.x - halfW, minY: this.cam.y - halfH, maxX: this.cam.x + halfW, maxY: this.cam.y + halfH };
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
  /** Aristas de confianza de `origen` que se dibujan mientras siga seleccionado; sin aristas no se dibuja nada. */
  setVinculos(origen: string | null, aristas: readonly VinculoMapa[] = []): void { this.vinculos = origen && aristas.length ? { origen, aristas } : null; }

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
    this.dpr = clamp(window.devicePixelRatio || 1, 1, Math.min(this.graphicsSettings.maxDpr, rendererProfile(this.modo).dprCeiling));
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
      // V24: el lienzo de escena (16 px/tesela) solo existe en el nivel cercano; `drawScene` lo dimensiona.
      this.worldW = w;
      this.worldH = h;
      this.groundBaked = false;
      this.recomputeMinZoom();
    }
    const cells = w * h;
    const previous = this.grid;
    const next = new Array<Tile | undefined>(cells);
    let count = 0;
    for (const t of tiles) {
      const tx = Math.floor(t.x) - this.originX;
      const ty = Math.floor(t.y) - this.originY;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      if (!next[ty * w + tx]) count++;
      next[ty * w + tx] = t;
    }
    this.gridCount = count;
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
    // V24: lejos la holgura crece con la vista (¼ por lado): pasear o alejar no recompone la ventana en cada fotograma.
    const near = this.lodTier() === 'near';
    const mx = near ? WINDOW_MARGIN : Math.max(WINDOW_MARGIN, Math.ceil((view.x1 - view.x0) / 4)), my = near ? WINDOW_MARGIN : Math.max(WINDOW_MARGIN, Math.ceil((view.y1 - view.y0) / 4));
    const x = Math.floor((view.x0 - mx) / WINDOW_ALIGN) * WINDOW_ALIGN, y = Math.floor((view.y0 - my) / WINDOW_ALIGN) * WINDOW_ALIGN;
    const w = Math.ceil((view.x1 + 1 + mx) / WINDOW_ALIGN) * WINDOW_ALIGN - x, h = Math.ceil((view.y1 + 1 + my) / WINDOW_ALIGN) * WINDOW_ALIGN - y;
    const composed = cache.composeViewport(x, y, w, h, live);
    this.perf.windowComposes++;
    this.setWindow(x, y, w, h, composed.tiles);
    // Paneo, teclado o zoom: la rejilla nueva entra ya, pero los trozos que faltan se hornean por tandas.
    // Hornearlos todos aquí clavaba el fotograma (cientos de ms al alejar). Lo ya visto sigue en la caché.
    this.bakeGround(false, BAKE_BUDGET_MS);
    this.sceneKey = '';
    this.measureCoverage(view, performance.now());
  }

  /** V24: ¿basta con parchear las teselas del tick sobre la rejilla actual? */
  private canPatch(world: WorldView, view: ViewBounds | null): boolean {
    const win = this.serverWindow;
    if (!win || !this.groundBaked || this.bakedSeed !== this.worldSeed || this.worldW === 0) return false;
    if (!this.tileCache) return win.x === this.originX && win.y === this.originY && win.w === this.worldW && win.h === this.worldH && world.tiles.length === this.gridCount;
    const grid = { x: this.originX, y: this.originY, w: this.worldW, h: this.worldH };
    return (!view || this.windowCovers(grid, view)) && win.x >= grid.x && win.y >= grid.y && win.x + win.w <= grid.x + grid.w && win.y + win.h <= grid.y + grid.h;
  }

  /**
   * V24: aplica las teselas de un tick a la rejilla. Con `byValue` (fotograma completo) una tesela igual por valor conserva
   * el objeto anterior (sus cachés siguen valiendo). Solo los trozos tocados (y sus vecinos, por el borde de 1 tesela) se
   * re-sellan; los demás no se miran.
   */
  private patchTiles(tiles: readonly Tile[], byValue: boolean, frameTiles: readonly Tile[]): void {
    this.gridTilesRef = frameTiles;
    const w = this.worldW, h = this.worldH;
    const dirty = new Set<string>();
    const pairs: [Tile | undefined, Tile][] = [];
    let propsChanged = false, presence = false;
    for (const t of tiles) {
      const lx = Math.floor(t.x) - this.originX, ly = Math.floor(t.y) - this.originY;
      if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
      const i = ly * w + lx, old = this.grid[i];
      if (old === t || (byValue && old !== undefined && sameTile(old, t))) continue;
      this.grid[i] = t; pairs.push([old, t]);
      if (!old) { this.gridCount++; presence = true; }
      if (this.layerDirty.length < LAYER_DIRTY_LIMIT) this.layerDirty.push(t);
      const x = lx + this.originX, y = ly + this.originY;
      for (let cy = Math.floor((y - 1) / CHUNK_ART_TILES); cy <= Math.floor((y + 1) / CHUNK_ART_TILES); cy++)
        for (let cx = Math.floor((x - 1) / CHUNK_ART_TILES); cx <= Math.floor((x + 1) / CHUNK_ART_TILES); cx++) dirty.add(`${cx}:${cy}`);
    }
    if (!pairs.length) return;
    this.perf.tilePatches += pairs.length; this.tileRevision++;
    const touched = new Set<string>();
    for (const key of dirty) {
      if (!this.chunkRefs.has(key)) continue; // borde fuera de la ventana
      const sep = key.indexOf(':'), x0 = Number(key.slice(0, sep)) * CHUNK_ART_TILES, y0 = Number(key.slice(sep + 1)) * CHUNK_ART_TILES;
      this.chunkRefs.set(key, this.chunkTileRefs(x0, y0));
      this.chunkStamp.set(key, ++this.stampCounter);
      if (this.refreshChunkForms(x0, y0)) propsChanged = true;
      touched.add(key);
    }
    // Tras recalcular las formas: una tesela de bosque cuyo alimento cambió no rehace la decoración.
    if (!propsChanged) for (const [old, t] of pairs) if (this.propKey(old) !== this.propKey(t)) { propsChanged = true; break; }
    if (presence) this.gridRevision++;
    if (propsChanged || presence) this.propsRevision++;
    // Los trozos tocados por el tick se rehornean ya (si son pocos); lo demás que falte, por tandas.
    this.syncTerrain(BAKE_BUDGET_MS, touched.size <= BAKE_SYNC_CHUNKS ? touched : undefined);
  }

  /** Lo que `SceneProps`/copas derivan de una tesela: si no cambia, el parche no rehace la decoración. */
  private propKey(tile: Tile | undefined): string {
    if (!tile) return '';
    return `${tile.terrain}|${tile.feature ?? ''}|${(tile.drinkingWater ?? 0) > .04 ? 1 : 0}|${tile.species ?? ''}|${(tile.fauna ?? 0) > .04 ? 1 : 0}|${formKey(this.treeForms.get(tile))}`;
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
    const grid = { x: this.originX, y: this.originY, w: this.worldW, h: this.worldH };
    // Al volver a acercar, una rejilla compuesta lejos sigue «cubriendo» la cámara pero haría un lienzo de escena de cientos de MiB:
    // se recompone a la medida de lo visible (la holgura cercana es de ±WINDOW_MARGIN + alineación a trozos).
    const oversized = this.lodTier() === 'near' && (grid.w > view.x1 - view.x0 + NEAR_GRID_SLACK || grid.h > view.y1 - view.y0 + NEAR_GRID_SLACK);
    if (oversized || !this.windowCovers(grid, view)) this.composeWindow(view, world.tiles);
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
      // V23: composición, brillo térmico y escarcha en pasos visibles (0 sin materia: la huella de siempre).
      const materia = firmaMat(t.mat, t.T, t.moisture, this.conoceSustancia);
      if (materia) h = Math.imul(h ^ materia, 16777619) >>> 0;
    }
    return h;
  }

  /* ---------------------------------------------------------------- */
  /* Horneado del suelo                                               */
  /* ---------------------------------------------------------------- */

  /**
   * V24: re-sella los trozos de la ventana cuyas teselas (con borde) cambiaron de identidad y hornea los que hacen falta.
   * Las memorias por tesela (material, borde de bioma, forma de árbol) duran mientras dure el objeto tesela; `force`
   * (el mismo objeto reenviado, quizá mutado en sitio) o una semilla nueva las vacían.
   */
  private bakeGround(force = false, syncBudget?: number): void {
    if (this.worldW === 0 || this.worldH === 0) return;
    const first = !this.groundBaked || force;
    if (force || this.bakedSeed !== this.worldSeed) {
      this.groundMaterials = new WeakMap(); this.biomeFractions = new WeakMap(); this.treeForms = new WeakMap();
      this.chunkRefs = new Map(); this.chunkStamp.clear();
    }
    const budgeted = syncBudget !== undefined && Number.isFinite(syncBudget);
    const prepStart = performance.now();
    const refs = new Map<string, (Tile | undefined)[]>(), keys: string[] = [];
    const pending: { cx: number; cy: number }[] = [];
    let prepOpen = true;
    for (let cy = Math.floor(this.originY / CHUNK_ART_TILES); cy <= Math.floor((this.originY + this.worldH - 1) / CHUNK_ART_TILES); cy++) {
      for (let cx = Math.floor(this.originX / CHUNK_ART_TILES); cx <= Math.floor((this.originX + this.worldW - 1) / CHUNK_ART_TILES); cx++) {
        const key = `${cx}:${cy}`, previous = this.chunkRefs.get(key);
        if (budgeted && prepOpen && performance.now() - prepStart >= (syncBudget ?? 0)) prepOpen = false;
        if (!prepOpen) {
          // Lo ya firmado sigue en pantalla; la firma nueva espera a los fotogramas siguientes.
          if (previous && this.chunkStamp.has(key)) { refs.set(key, previous); keys.push(key); }
          pending.push({ cx, cy });
          continue;
        }
        this.prepareChunk(cx, cy, previous, refs, keys);
      }
    }
    for (const key of this.chunkStamp.keys()) if (!refs.has(key)) this.chunkStamp.delete(key);
    this.chunkRefs = refs; this.windowChunkKeys = keys;
    this.pendingPrep = pending.length ? pending : null;
    this.propsRevision++;
    // El primer encuadre y una ventana pequeña se hornean de una vez (las pruebas leen el suelo en el mismo fotograma).
    // Una recomposición de cámara trae su propio presupuesto: el resto lo sigue `frame` → `resumePrep`.
    const budget = syncBudget ?? (first || keys.length <= BAKE_SYNC_WINDOW ? Infinity : BAKE_BUDGET_MS);
    const left = budget === Infinity ? Infinity : Math.max(0, budget - (performance.now() - prepStart));
    if (left > 0) this.syncTerrain(left);
    this.groundBaked = true; this.bakedSeed = this.worldSeed;
  }

  /** Firma de un trozo (y sus formas de árbol) y lo anota en la ventana que se dibuja. `true` si hay decoración nueva. */
  private prepareChunk(cx: number, cy: number, previous: (Tile | undefined)[] | undefined, refs: Map<string, (Tile | undefined)[]>, keys: string[]): boolean {
    const x0 = cx * CHUNK_ART_TILES, y0 = cy * CHUNK_ART_TILES, key = `${cx}:${cy}`;
    const next = this.chunkTileRefs(x0, y0);
    let changed = false;
    if (!previous || !sameRefs(previous, next) || !this.chunkStamp.has(key)) {
      this.chunkStamp.set(key, ++this.stampCounter);
      changed = this.refreshChunkForms(x0, y0) || !previous;
    }
    if (!refs.has(key)) keys.push(key);
    refs.set(key, next);
    return changed;
  }

  /** Sigue la firma aplazada por un paneo o un zoom, sin ocupar el fotograma. */
  private resumePrep(budgetMs: number): void {
    const pending = this.pendingPrep;
    if (!pending?.length || this.lodTier() === 'map') return;
    const start = performance.now();
    const refs = this.chunkRefs, keys = this.windowChunkKeys;
    const still: { cx: number; cy: number }[] = [];
    let open = true, changed = false;
    for (const item of pending) {
      if (open && performance.now() - start >= budgetMs) open = false;
      if (!open) { still.push(item); continue; }
      changed = this.prepareChunk(item.cx, item.cy, refs.get(`${item.cx}:${item.cy}`), refs, keys) || changed;
    }
    this.pendingPrep = still.length ? still : null;
    if (changed) { this.propsRevision++; this.sceneKey = ''; }
  }

  /** Teselas de un trozo con su borde de 1 (lo que mira su firma): 10×10 referencias. */
  private chunkTileRefs(x0: number, y0: number): (Tile | undefined)[] {
    const out = new Array<Tile | undefined>((CHUNK_ART_TILES + 2) * (CHUNK_ART_TILES + 2));
    let i = 0;
    for (let y = y0 - 1; y <= y0 + CHUNK_ART_TILES; y++) for (let x = x0 - 1; x <= x0 + CHUNK_ART_TILES; x++) out[i++] = this.tileAt(x, y);
    return out;
  }

  /** Formas de árbol de un trozo (dependen del borde de bioma). `true` si alguna forma ya conocida cambió. */
  private refreshChunkForms(x0: number, y0: number): boolean {
    let changed = false;
    for (let y = y0; y < y0 + CHUNK_ART_TILES; y++) for (let x = x0; x < x0 + CHUNK_ART_TILES; x++) {
      const tile = this.tileAt(x, y);
      if (!tile) continue;
      const before = this.treeForms.get(tile);
      this.biomeFractions.delete(tile);
      const form = (tile.wood ?? 0) > .05 ? treeForm(tile, this.biomeEdgeFraction(tile)) : null;
      if (form) this.treeForms.set(tile, form); else this.treeForms.delete(tile);
      if (before && formKey(before) !== formKey(form)) changed = true;
    }
    return changed;
  }

  /** Trozos de la ventana que se dibujan ahora: todos si la ventana es normal; si es enorme (lejos), solo los visibles. */
  private neededChunkKeys(): string[] {
    if (this.windowChunkKeys.length <= BAKE_SYNC_WINDOW) return this.windowChunkKeys;
    const v = this.visibleBounds(), out: string[] = [];
    const cx0 = Math.floor(Math.max(v.x0, this.originX) / CHUNK_ART_TILES), cx1 = Math.floor(Math.min(v.x1, this.originX + this.worldW - 1) / CHUNK_ART_TILES);
    const cy0 = Math.floor(Math.max(v.y0, this.originY) / CHUNK_ART_TILES), cy1 = Math.floor(Math.min(v.y1, this.originY + this.worldH - 1) / CHUNK_ART_TILES);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) { const key = `${cx}:${cy}`; if (this.chunkRefs.has(key)) out.push(key); }
    return out;
  }

  /**
   * V24: pone al día los trozos de suelo que se ven (dentro de `budgetMs`) y fija `this.chunks`. Un trozo con el sello viejo
   * se sigue dibujando hasta rehornearse; uno nunca horneado espera (niebla) en vez de bloquear el fotograma. En el nivel
   * mapa no se hornea suelo a resolución completa.
   */
  private syncTerrain(budgetMs: number, priority?: ReadonlySet<string>): void {
    if (this.worldW === 0 || this.worldH === 0) return;
    if (this.lodTier() === 'map') { this.chunks = []; return; }
    const start = performance.now(), chunks: GroundChunk[] = [];
    for (const key of this.neededChunkKeys()) {
      let chunk = this.terrainCache.get(key);
      const stamp = this.chunkStamp.get(key) ?? 0;
      if ((!chunk || chunk.stamp !== stamp || chunk.canvas.width === 0) && (budgetMs === Infinity || priority?.has(key) || performance.now() - start < budgetMs)) chunk = this.bakeChunk(key, chunk, stamp);
      if (chunk && chunk.canvas.width > 0) chunks.push(chunk);
    }
    this.chunks = chunks;
  }

  private bakeChunk(key: string, chunk: GroundChunk | undefined, stamp: number): GroundChunk {
    const sep = key.indexOf(':'), x0 = Number(key.slice(0, sep)) * CHUNK_ART_TILES, y0 = Number(key.slice(sep + 1)) * CHUNK_ART_TILES;
    const signature = this.chunkSignature(x0, y0);
    if (chunk && chunk.signature === signature && chunk.canvas.width > 0) { chunk.stamp = stamp; return chunk; }
    const canvas = chunk && chunk.canvas.width > 0 ? chunk.canvas : document.createElement('canvas');
    // Un lienzo nuevo mide 300×150: se dimensiona siempre al trozo (si no, Canvas2D lo comprimiría y deformaría el suelo).
    if (canvas.width !== CHUNK_ART_TILES * ART || canvas.height !== CHUNK_ART_TILES * ART) canvas.width = canvas.height = CHUNK_ART_TILES * ART;
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
    this.perf.terrainBakes++;
    if (chunk && chunk.canvas === canvas) { chunk.signature = signature; chunk.stamp = stamp; chunk.revision = ++this.cacheBuilds; return chunk; }
    const fresh: GroundChunk = { key, signature, stamp, revision: ++this.cacheBuilds, canvas, x: x0, y: y0 };
    this.terrainCache.set(key, fresh);
    return fresh;
  }

  private groundMaterial(tile: Tile): GroundMaterial {
    const cached = this.groundMaterials.get(tile);
    if (cached && (cached.paleta === this.paleta.version || !tile.mat?.length)) return cached;
    const fertility = groundValue(tile.fertility ?? .5), moisture = groundValue(tile.moisture);
    const cultivation = groundValue(tile.cultivation ?? 0), traffic = groundValue(tile.traffic ?? 0);
    const mineral = tile.biome === 'desert' ? P.sand : tile.biome === 'mountain' ? P.stoneShade : P.soilLight;
    const humus = tile.biome === 'wetland' ? mix(P.soilDark, P.mossHigh, .55) : darken(P.soil, .38);
    const green = tile.biome === 'wetland' ? mix(P.mossHigh, P.waterShallow, .25)
      : tile.biome === 'forest' ? mix(P.mossHigh, P.sageLow, .3) : mix(P.sageLow, P.mossHigh, .32);
    const legacySoil = darken(mix(mineral, humus, fertility * .72), moisture * .2);
    const mat = this.materiaDeTesela(tile, legacySoil, moisture);
    const material: GroundMaterial = {
      soil: mat ? mat.colores[0]! : legacySoil,
      leaf: mix(green, P.sandDark, (1 - moisture) * .6),
      cover: tile.terrain === 'water' ? 0 : groundValue(tile.vegetation) * (1 - cultivation * .6) * (1 - traffic * .88) * (tile.terrain === 'shelter' ? .25 : 1),
      moisture, traffic: tile.terrain === 'water' ? 0 : traffic,
      biome: tile.biome ?? 'grassland', water: tile.terrain === 'water',
      mat, paleta: this.paleta.version,
    };
    this.groundMaterials.set(tile, material); return material;
  }

  /**
   * V23: el suelo por composición. Cada sustancia de `Tile.mat` con ficha conocida aporta su color (oscurecido por la
   * humedad como el suelo de siempre y al rojo si `Tile.T` pasa del punto de Draper) y su fracción; sin ninguna conocida
   * pero con `T`, el suelo de siempre a su temperatura. `null` = la tesela no trae materia: se pinta como hoy.
   */
  private materiaDeTesela(tile: Tile, legacySoil: RGB, moisture: number): GroundMaterial['mat'] {
    if (!tile.mat?.length && tile.T === undefined) return null;
    const colores: RGB[] = [], fracciones: number[] = [];
    for (const [id, fraccion] of tile.mat ?? []) {
      const color = this.paleta.color(id);
      if (!color || !(fraccion > 0)) continue;
      colores.push(deRgb(colorTermico(aRgb(darken(deRgb(color), moisture * .2)), tile.T)));
      fracciones.push(fraccion);
    }
    if (!colores.length) { colores.push(deRgb(colorTermico(aRgb(legacySoil), tile.T))); fracciones.push(1); }
    return { colores, fracciones, escarcha: escarcha(tile.T, moisture) };
  }

  /** V23: aprende de la vista las sustancias, el aire y el reparto. Lo ausente deja el mapa como hoy. */
  private ingestV23(world: WorldView): void {
    if (world.instanceId !== undefined && world.instanceId !== this.mundoV23) {
      if (this.mundoV23 !== undefined) { this.paleta.clear(); this.reparto = null; this.repartoKey = ''; this.loteCache.clear(); }
      this.mundoV23 = world.instanceId;
    }
    this.paleta.ingest(world.sustancias);
    if (world.aire) {
      const aire = new Map<number, AireVisible>(), partes: string[] = [];
      for (const [clave, a] of Object.entries(world.aire)) {
        const [px, py] = clave.split(',').map(Number);
        if (!Number.isInteger(px) || !Number.isInteger(py)) continue;
        aire.set(cellKey(px!, py!), a);
        partes.push(`${clave}:${Math.round(clamp01(a.humedadRelativa) * 20)}:${Math.round(intensidadLluvia(a.lluvia) * 10)}`);
      }
      this.aire = aire; this.aireKey = partes.join(';');
    } else { this.aire = null; this.aireKey = ''; }
    // El reparto viaja solo en los fotogramas completos: entre uno y otro vale el último conocido de este mundo.
    if (world.reparto?.paginas.length) {
      const reparto = new Map<number, number>(), partes: string[] = [];
      const ahora = performance.now(), previo = this.reparto;
      for (const [px, py, dueno] of world.reparto.paginas) {
        const key = cellKey(px, py), antes = previo?.get(key);
        reparto.set(key, dueno); partes.push(`${px},${py}:${dueno}`);
        if (antes !== undefined && antes !== dueno) this.migraciones.set(key, ahora);
      }
      for (const [key, at] of this.migraciones) if (ahora - at > MIGRACION_DESTELLO_MS) this.migraciones.delete(key);
      this.reparto = reparto; this.repartoKey = partes.join(';');
    }
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
      // V23: agua por debajo de la fusión: placas de hielo tramadas (sin degradado).
      const helada = owner.mat?.escarcha ?? 0;
      if (helada > 0) for (let by = 0; by < ART; by++) for (let bx = 0; bx < ART; bx++) {
        if (umbralTrama(ox + bx, oy + by) < helada) px(g, ox + bx, oy + by, 1, 1, css(ESCARCHA, .85));
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
        if (owner.mat && owner.mat.escarcha > 0 && umbralTrama(wx, wy) < owner.mat.escarcha) color = ESCARCHA;
        data[offset] = color.r; data[offset + 1] = color.g; data[offset + 2] = color.b; data[offset + 3] = 255;
        continue;
      }
      if (pixel.sand) {
        const color = pixel.sandEdge ? P.sandDark : P.sand;
        data[offset] = color.r; data[offset + 1] = color.g; data[offset + 2] = color.b; data[offset + 3] = 255;
        continue;
      }
      let soilR = 0, soilG = 0, soilB = 0, leafR = 0, leafG = 0, leafB = 0, total = 0;
      // V23: con composición, el suelo es la sustancia que el tramado asigna a este píxel; nunca se funde con el vecino.
      const sustancia = owner.mat ? owner.mat.colores[sustanciaDelPixel(owner.mat.fracciones, wx, wy)] : undefined;
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
      if (sustancia) { soilR = sustancia.r; soilG = sustancia.g; soilB = sustancia.b; }
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
      if (owner.mat && owner.mat.escarcha > 0 && umbralTrama(wx, wy) < owner.mat.escarcha) {
        data[offset] = ESCARCHA.r; data[offset + 1] = ESCARCHA.g; data[offset + 2] = ESCARCHA.b;
      }
    }
    this.groundStampContext.putImageData(this.groundPixels, 0, 0);
    g.drawImage(this.groundStamp, ox, oy);
  }

  /** V20: vetas minerales y caminos (senda/calzada) sobre el suelo; se hornean con el trozo, cero coste por fotograma. */
  private bakeV20Ground(g: CanvasRenderingContext2D, tile: Tile): void {
    // V23: con composición servida las vetas salen de ella; `paintGeologyVeins` ya no pinta la geología latente.
    if (tile.mat?.length) paintVetasComposicion(g, tile, this.colorSustancia);
    else paintGeologyVeins(g, tile, this.worldSeed);
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
    // User camera preference; the subscription window cap still bounds server projection work.
    this.minZoom = this.graphicsSettings.minZoom;
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

  /**
   * V24: pide al servidor la ventana más grande que acepta (`REQUEST_WINDOW`) centrada en la cámara y solo vuelve a pedir
   * cuando lo que se ve se sale de la última pedida (o, si la vista es mayor que la ventana, cuando el centro se desplaza
   * más de ⅙ de ella). Antes cada paso de paneo o de zoom repedía y la cinta se congelaba al alejar.
   */
  private reportViewport(): void {
    if (!this.curr) return;
    const viewW = Math.ceil(this.cssW / this.cam.zoom) + 6, viewH = Math.ceil(this.cssH / this.cam.zoom) + 6;
    const last = this.reportedWindow;
    if (last) {
      const v = this.visibleBounds();
      const fits = viewW <= REQUEST_WINDOW.w && viewH <= REQUEST_WINDOW.h;
      const inside = v.x0 >= last.x && v.y0 >= last.y && v.x1 < last.x + last.width && v.y1 < last.y + last.height;
      const drift = Math.abs(this.cam.x - (last.x + last.width / 2)) <= last.width / 6 && Math.abs(this.cam.y - (last.y + last.height / 2)) <= last.height / 6;
      if (fits ? inside : drift) return;
    }
    const width = REQUEST_WINDOW.w, height = REQUEST_WINDOW.h;
    const viewport = { x: Math.floor(this.cam.x - width / 2), y: Math.floor(this.cam.y - height / 2), width, height };
    const signature = JSON.stringify(viewport);
    if (signature === this.reportedViewport) return;
    this.reportedViewport = signature; this.reportedWindow = viewport;
    this.cameraMovedAt = performance.now();
    this.onViewport?.(viewport);
  }

  /** V24: nivel de detalle según los px por tesela y los trozos de suelo que harían falta para cubrir la pantalla. */
  private lodTier(): LodTier {
    const zoom = this.cam.zoom;
    if (zoom >= FAR_ZOOM && Math.ceil(this.cssW / zoom) * Math.ceil(this.cssH / zoom) <= NEAR_TILE_CAP) return 'near';
    if (zoom < MAP_ZOOM) return 'map';
    const chunks = (Math.ceil(this.cssW / zoom / CHUNK_ART_TILES) + 2) * (Math.ceil(this.cssH / zoom / CHUNK_ART_TILES) + 2);
    return chunks > FAR_CHUNK_CAP ? 'map' : 'far';
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
    this.frameStamp++;
    // V24: mientras el zoom cambia (rueda, pellizco, enfoque) no se rehacen copas ni suelos reducidos por la escala nueva:
    // se estiran los de la escala anterior y se rehacen al asentarse (≈ ¼ s), sin tirones a mitad del gesto.
    if (this.cam.zoom !== this.lastFrameZoom) { this.lastFrameZoom = this.cam.zoom; this.zoomMovedAt = now; }
    this.zoomSettled = now - this.zoomMovedAt >= ZOOM_SETTLE_MS;
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
    this.resumePrep(BAKE_BUDGET_MS);
    this.syncTerrain(BAKE_BUDGET_MS); // V24: lo visible que falte se hornea por tandas, sin bloquear el fotograma
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
    const tier = this.lodTier();
    const accelerated = this.gpu?.render(tier === 'map' ? [] : this.chunks, { ...this.cam, width: this.cssW, height: this.cssH, dpr: this.dpr }) ?? false;
    ctx.clearRect(0, 0, cw, ch);
    this.labelCtx.setTransform(1,0,0,1,0,0); this.labelCtx.clearRect(0,0,cw,ch);
    if (tier === 'map') {
      ctx.fillStyle = '#425f50'; ctx.fillRect(0, 0, cw, ch);
      this.drawMapChunks(ctx);
    } else if (!accelerated) {
      ctx.fillStyle = '#425f50'; ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = false;
      for (const chunk of this.chunks) {
        if (chunk.canvas.width === 0) continue; // expulsado de la caché: nunca rompe el bucle de dibujo
        const x = Math.round((this.cssW/2+(chunk.x-this.cam.x)*this.cam.zoom)*this.dpr);
        const y = Math.round((this.cssH/2+(chunk.y-this.cam.y)*this.cam.zoom)*this.dpr);
        const x1 = Math.round((this.cssW/2+(chunk.x+CHUNK_ART_TILES-this.cam.x)*this.cam.zoom)*this.dpr);
        const y1 = Math.round((this.cssH/2+(chunk.y+CHUNK_ART_TILES-this.cam.y)*this.cam.zoom)*this.dpr);
        if (x1 < 0 || y1 < 0 || x > cw || y > ch) continue;
        // V24: lejos (menos de 1 px de pantalla por px de arte) se copia una versión reducida a la escala de la pantalla.
        ctx.drawImage(tier === 'far' ? this.reducedTerrain(chunk, x1 - x) : chunk.canvas,x,y,x1-x,y1-y); this.drawCalls++;
      }
    }

    const world = this.curr;
    if (world && this.groundBaked && this.worldW > 0) {
      const t = now / 1000;
      this.actionActive = !this.cutArchive && !world.paused && now - this.currAt < Math.max(1200, this.interval * 2);
      // V18: la fase del día y la lluvia se acercan a lo recibido en ~1,5 s en vez de saltar entre amanecer/día/noche.
      if (this.reduceMotion) this.atmosphere.reset();
      // Con colchón, la luz y la lluvia siguen al mismo instante A→B que se dibuja (no al más reciente).
      const shownTime = this.reduceMotion || this.dvrMode ? null : this.playback.bracket();
      const shownTick = this.reduceMotion || this.dvrMode ? world.tick : this.playback.shownTick(world.tick);
      const shownWeather = shownTime ? (shownTime.alpha < .5 ? shownTime.a.view : shownTime.b.view).weather : world.weather;
      // V23: con el aire servido, la lluvia es la de las páginas que se ven, no un tiempo global.
      const light = this.atmosphere.step(daylightAt(shownTick), this.aire ? this.lluviaVisible() : shownWeather === 'rain', now);
      this.lighting = { shadowX: light.shadowX, shadowY: light.shadowY, shadowAlpha: light.shadowAlpha * (1 - .6 * light.rain) };
      const people = this.interpolatePeople(this.motionClock);
      const animals = this.interpolateAnimals(this.motionClock);
      if (tier === 'near') {
        // Las imágenes de capas del nivel lejano no se mantienen de cerca: se rehacen al volver a alejar.
        if (this.layerImages) { this.layerDirty.length = 0; this.layerImages.data = this.layerImages.legacy = null; this.heatImage = null; }
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
      } else {
        // V24: lejos no hay lienzo de escena a 16 px/tesela (decenas de megapíxeles): todo va directo al panel.
        if (this.scene.width > 1) { this.scene.width = this.scene.height = 1; this.sceneKey = ''; }
        this.drawFar(world, people, animals, t, tier);
      }

      if (this.graphicsSettings.atmosphere) this.drawAmbient(cw, ch, now, light);
      else { this.effects.rain = 0; this.drawEventAccents(now); }
      this.drawOverlaysScreen(people, animals, tier);
    }
  }

  private drawScene(world: WorldView, people: RenderPerson[], animals: RenderAnimal[], t: number): void {
    const g = this.sceneCtx;

    // Ventana visible en tiles (con holgura para copas altas).
    const halfW = this.cssW / this.cam.zoom / 2;
    const halfH = this.cssH / this.cam.zoom / 2;
    const vx0 = Math.max(this.originX, Math.floor(this.cam.x - halfW) - 1);
    const vx1 = Math.min(this.originX + this.worldW - 1, Math.ceil(this.cam.x + halfW) + 1);
    const vy0 = Math.max(this.originY, Math.floor(this.cam.y - halfH) - 3);
    const vy1 = Math.min(this.originY + this.worldH - 1, Math.ceil(this.cam.y + halfH) + 3);
    // Quien se desliza entre dos ticks rehace lo visible cada fotograma. Si nadie se mueve, la rejilla
    // retenida se pinta una vez y el paneo solo mueve el volcado; la pose (8/s) refresca lo que se ve.
    const glide = people.some(person => person.moving) || animals.some(animal => animal.moving);
    const pose = glide ? t : this.reduceMotion ? 0 : Math.floor(t * 8);
    const selectedBody = this.selection?.kind === 'animal' ? this.selection.id : '';
    const selectedTile = this.selection?.kind === 'tile' ? this.selection : null;
    const far = this.cam.zoom < FAR_ZOOM; // solo en llamadas directas (pruebas): `render` usa `drawFar` lejos
    const gridId = `${this.originX}:${this.originY}:${this.worldW}:${this.worldH}:${this.gridRevision}:${this.propsRevision}:${this.structureRevision}:${this.vivasKey}:${[...(this.activeLayers ?? [])].join(',')}:${this.layer}:${this.capaCalor ?? ''}:${far ? 'far' : 'near'}`;
    const sceneKey = glide
      ? `${gridId}:${this.sceneRevision}:${vx0}:${vx1}:${vy0}:${vy1}:${pose}:${selectedBody}:${selectedTile?.x}:${selectedTile?.y}`
      : `${gridId}:${this.sceneRevision}:${pose}:${selectedBody}:${selectedTile?.x}:${selectedTile?.y}`;
    // V24: el lienzo de escena (16 px/tesela sobre la ventana) solo vive en el nivel cercano.
    const sceneW = Math.max(1, this.worldW * ART), sceneH = Math.max(1, this.worldH * ART);
    if (this.scene.width !== sceneW || this.scene.height !== sceneH) { this.scene.width = sceneW; this.scene.height = sceneH; this.sceneCtx.imageSmoothingEnabled = false; this.sceneKey = ''; this.sceneGridKey = ''; }
    if (sceneKey === this.sceneKey) return;
    const paintAll = !glide && this.sceneGridKey !== gridId;
    this.sceneGridKey = gridId;
    this.sceneKey = sceneKey;
    const x0 = paintAll ? this.originX : vx0;
    const x1 = paintAll ? this.originX + this.worldW - 1 : vx1;
    const y0 = paintAll ? this.originY : vy0;
    const y1 = paintAll ? this.originY + this.worldH - 1 : vy1;
    this.perf.sceneBuilds++;
    // V24: solo se borra lo que se va a volcar (lo visible con la holgura de copas); el resto del lienzo nunca se ve.
    {
      const cx0 = Math.max(0, (x0 - this.originX - 1) * ART), cy0 = Math.max(0, (y0 - this.originY - 1) * ART);
      const cx1 = Math.min(this.scene.width, (x1 - this.originX + 2) * ART), cy1 = Math.min(this.scene.height, (y1 - this.originY + 2) * ART);
      if (cx1 > cx0 && cy1 > cy0) g.clearRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    }
    g.save(); g.translate(-this.originX * ART, -this.originY * ART);

    // Mapa de calor: sobre el terreno ya pintado (los chunks van al lienzo principal)
    // y debajo de decoración, animales y personas de esta escena.
    this.drawActiveLayers(g, x0, x1, y0, y1);
    pintarCalor(g, this.teselasVisibles(x0, x1, y0, y1), this.capaCalor, this.rangoCalor);

    this.effects.water = this.effects.vegetation = this.effects.shadows = 0;
    this.visibleAnimals = 0; this.visibleStructures = 0;
    // V22: lo que solo depende de rejilla + estructuras + ventana se calcula una vez por cambio, no por fotograma.
    const props = this.scenePropsFor(world, x0, x1, y0, y1);
    this.visibleTiles = props.visibleTiles;
    for (const item of props.animated) {
      if (item.kind === 0) {
        if (this.graphicsSettings.waterRipples && this.effects.water < VISUAL_BUDGET.water) { this.drawRipples(g, item.x, item.y, item.x * ART, item.y * ART, t); this.effects.water++; }
      } else if (item.kind === 1) {
        if (this.graphicsSettings.waterRipples && this.effects.water < VISUAL_BUDGET.water) {
          const shift = this.reduceMotion ? 0 : Math.floor(t * 2 + rnd(item.x, item.y, 917) * 4) % 3;
          px(g, item.x * ART + 8 + shift, item.y * ART + 10, 2, 1, css(P.waterGleam, .55)); this.effects.water++;
        }
      // V24: la decoración sobrevive a los parches que no la cambian; el crecimiento/vegetación se lee de la tesela actual.
      } else if (!far && this.graphicsSettings.vegetationSway) this.drawPlantMovement(g, this.tileAt(item.x, item.y) ?? item.tile, t); // < 14 px/tesela una caña de 1 px no se distingue
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
    this.pushLotes(world, dynamic, x0, x1, y0, y1, selectedTile);
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
    if (this.graphicsSettings.shadows && this.cam.zoom >= 18) {
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
      if (this.graphicsSettings?.cutaways === false) return false;
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
      else if (s.lote) this.drawLote(g, s.lote, s.ax, s.ay, t);
      else if (s.tile) this.drawFauna(g, s.tile, t);
      else if (s.person) this.drawPerson(g, s.person, t);
    }
    this.settlePersonSprites();
    // A selected facility or water patch is a local cutaway, like the existing body reveal.
    // Redraw received material within its footprint; no state, roots or hit targets change.
    if (site && this.graphicsSettings.cutaways) {
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
    if (this.vivas) this.drawRestVeil(g, x0, x1, y0, y1);
    g.restore();
  }

  /* ------------------ V23: lotes con forma ------------------ */

  /**
   * Lotes visibles (`WorldView.lotes`) y piezas de obra (`StructureView.piezas`) como sprites ordenados por su pie. Las piezas
   * de una obra terminada ya están en el dibujo del edificio: se ven en la obra en marcha, calientes (un horno) o al
   * inspeccionar su casilla. Varios lotes en una celda se apilan en un montón legible.
   */
  private pushLotes(world: WorldView, dynamic: Sprite[], x0: number, x1: number, y0: number, y1: number, selectedTile: { x: number; y: number } | null): void {
    const enCelda = new Map<number, number>();
    const push = (lote: LoteVisible): void => {
      if (lote.x < x0 || lote.x > x1 || lote.y < y0 || lote.y > y1) return;
      const cx = Math.floor(lote.x), cy = Math.floor(lote.y), key = cellKey(cx, cy), k = enCelda.get(key) ?? 0;
      enCelda.set(key, k + 1);
      // Celda de 16 px: hasta tres lotes por hilera, la siguiente hilera un poco más arriba (montón).
      const ax = cx * ART + 8 + ((k % 3) - 1) * 5, ay = cy * ART + 13 - Math.floor(k / 3) * 3;
      dynamic.push({ kind: SpriteKind.Lote, sortY: cy * ART + 13 + (k % 3) * .01, ax, ay, seed: 0, size: 0, person: null, lote });
    };
    for (const lote of world.lotes ?? []) push(lote);
    for (const structure of world.structures ?? []) {
      if (!structure.piezas?.length) continue;
      const enObra = structure.site !== undefined;
      const inspeccionada = selectedTile !== null && footprintCells(structure as ExtendedStructure).some(c => c.x === selectedTile.x && c.y === selectedTile.y);
      for (const pieza of structure.piezas) if (enObra || inspeccionada || brilloTermico(pieza.T) > 0) push(pieza);
    }
  }

  /** Un lote desde su sprite en caché (fuego con su llama por pose, y su humo encima, que sí cambia con el reloj). */
  private drawLote(g: CanvasRenderingContext2D, lote: LoteVisible, ax: number, ay: number, t: number): void {
    const color = this.paleta.color(lote.principal) ?? LOTE_SIN_FICHA;
    const figura = figuraDeLote(lote, this.paleta.densidad(lote.principal));
    const pose = this.reduceMotion ? 0 : Math.floor(t * 8) & 3;
    const pintar = (ctx: CanvasRenderingContext2D, x: number, y: number) => lote.rol === 'fuego'
      ? paintFuego(ctx, lote, color, x, y, pose) : paintLote(ctx, lote, figura, color, x, y);
    if (typeof document === 'undefined') pintar(g, ax, ay);
    else {
      const key = claveLote(lote, figura, color, pose);
      let sprite = this.loteCache.get(key);
      if (!sprite) {
        sprite = document.createElement('canvas'); sprite.width = LOTE_SPRITE.w; sprite.height = LOTE_SPRITE.h;
        pintar(sprite.getContext('2d')!, LOTE_SPRITE.ox, LOTE_SPRITE.oy);
        this.loteCache.set(key, sprite);
      }
      g.drawImage(sprite, Math.round(ax) - LOTE_SPRITE.ox, Math.round(ay) - LOTE_SPRITE.oy); this.drawCalls++;
    }
    if (lote.rol === 'fuego' && this.graphicsSettings.atmosphere) {
      for (const humo of humoDeFuego(lote, this.reduceMotion ? 0 : t)) {
        px(g, Math.round(ax + humo.dx - humo.lado / 2), Math.round(ay + humo.dy), humo.lado, humo.lado, css(HUMO, humo.alfa));
      }
    }
  }

  /**
   * Lejos solo se distingue lo que brilla: fuegos (con su llama de cerca del lejano) y lotes al rojo como un resplandor de
   * una tesela del color de cuerpo negro de su T; en el mapa, un punto. Lo frío se ve al acercarse.
   */
  private drawLotesCalientes(g: CanvasRenderingContext2D, world: WorldView, x0: number, x1: number, y0: number, y1: number, tier: LodTier, t: number): void {
    const brillan = (l: LoteVisible) => l.rol === 'fuego' || brilloTermico(l.T) > 0;
    const pinta = (l: LoteVisible): void => {
      if (l.x < x0 || l.x > x1 || l.y < y0 || l.y > y1 || !brillan(l)) return;
      const [r, gr, b] = colorCuerpoNegro(l.T), cx = Math.floor(l.x) * ART, cy = Math.floor(l.y) * ART;
      g.fillStyle = `rgba(${r},${gr},${b},${(.25 + .5 * Math.max(brilloTermico(l.T), l.rol === 'fuego' ? .6 : 0)).toFixed(3)})`;
      if (tier === 'map') g.fillRect(cx + ART / 4, cy + ART / 4, ART / 2, ART / 2);
      else { g.fillRect(cx, cy, ART, ART); if (l.rol === 'fuego') this.drawLote(g, l, cx + 8, cy + 13, t); }
      this.drawCalls++;
    };
    for (const lote of world.lotes ?? []) pinta(lote);
    for (const structure of world.structures ?? []) for (const pieza of structure.piezas ?? []) pinta(pieza);
  }

  /* ------------------ V23: aire, lluvia y reparto por página ------------------ */

  private paginaDe(x: number, y: number): number { return cellKey(Math.floor(x / PAGINA), Math.floor(y / PAGINA)); }

  /** Intensidad media [0, 1] de la lluvia en las páginas visibles (las que el aire servido trae). */
  private lluviaVisible(): number {
    if (!this.aire?.size) return 0;
    const b = this.getViewportBounds();
    let suma = 0, n = 0;
    for (let py = Math.floor(b.minY / PAGINA); py <= Math.floor(b.maxY / PAGINA); py++) for (let px = Math.floor(b.minX / PAGINA); px <= Math.floor(b.maxX / PAGINA); px++) {
      const a = this.aire?.get(cellKey(px, py));
      if (a) { suma += intensidadLluvia(a.lluvia); n++; }
    }
    return n ? suma / n : 0;
  }

  /** Lluvia [0, 1] de la página bajo un punto de pantalla; `null` sin aire servido (llueve en todo el cuadro, como hoy). */
  private lluviaEnPantalla(sx: number, sy: number): number | null {
    if (!this.aire) return null;
    const w = this.screenToWorld(sx, sy), a = this.aire?.get(this.paginaDe(w.x, w.y));
    return a ? intensidadLluvia(a.lluvia) : 0;
  }

  /** Capas V23 activas cuyo dato trae la vista, en el orden del catálogo. */
  private capasV23Activas(): typeof CAPAS_V23[number][] {
    return CAPAS_V23.filter(meta => this.activeLayers?.has(meta.id) && (meta.id === 'hilos' ? this.reparto !== null : this.aire !== null));
  }

  /** Color CSS del dueño de una página (capa «Hilos»), memorizado por dueño. */
  private colorHilo(dueno: number): string {
    let c = this.coloresHilo.get(dueno);
    if (!c) { const [r, g, b] = colorDeDueno(dueno); c = `rgb(${r},${g},${b})`; this.coloresHilo.set(dueno, c); }
    return c;
  }

  /** Capas V23 del nivel cercano: un rectángulo por página (no por tesela) y un borde de 1 px donde cambia el dueño. */
  private drawCapasV23(g: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number, total: number): void {
    const capas = this.capasV23Activas();
    if (!capas.length) return;
    const alfa = Math.min(.36, .7 / Math.sqrt(Math.max(1, total)));
    g.save();
    for (const meta of capas) for (let py = Math.floor(y0 / PAGINA); py <= Math.floor(y1 / PAGINA); py++) for (let pxp = Math.floor(x0 / PAGINA); pxp <= Math.floor(x1 / PAGINA); pxp++) {
      const key = cellKey(pxp, py), left = Math.max(x0, pxp * PAGINA), top = Math.max(y0, py * PAGINA);
      const w = Math.min(x1 + 1, (pxp + 1) * PAGINA) - left, h = Math.min(y1 + 1, (py + 1) * PAGINA) - top;
      if (w <= 0 || h <= 0) continue;
      if (meta.id === 'hilos') {
        const dueno = this.reparto?.get(key);
        if (dueno === undefined) continue;
        g.globalAlpha = alfa; g.fillStyle = this.colorHilo(dueno); g.fillRect(left * ART, top * ART, w * ART, h * ART);
        g.globalAlpha = .8;
        if (this.reparto?.get(cellKey(pxp + 1, py)) !== dueno && (pxp + 1) * PAGINA <= x1 + 1) g.fillRect((pxp + 1) * PAGINA * ART - 1, top * ART, 1, h * ART);
        if (this.reparto?.get(cellKey(pxp, py + 1)) !== dueno && (py + 1) * PAGINA <= y1 + 1) g.fillRect(left * ART, (py + 1) * PAGINA * ART - 1, w * ART, 1);
        const migro = this.migraciones.get(key);
        if (migro !== undefined) {
          const vida = 1 - (performance.now() - migro) / MIGRACION_DESTELLO_MS;
          if (vida > 0) { g.globalAlpha = .45 * vida; g.fillStyle = css(P.paper); g.fillRect(left * ART, top * ART, w * ART, h * ART); }
        }
      } else {
        const a = this.aire?.get(key);
        if (!a) continue;
        g.globalAlpha = clamp01(a.humedadRelativa) * alfa; g.fillStyle = meta.color; g.fillRect(left * ART, top * ART, w * ART, h * ART);
        const lluvia = intensidadLluvia(a.lluvia);
        // Donde llueve, trazos de agua tramados en la página (fijos: la lluvia animada va en la atmósfera).
        if (lluvia > 0) {
          g.globalAlpha = .5; g.fillStyle = css(P.waterShallow);
          for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) if (rnd(x, y, 1777) < lluvia * .35) g.fillRect(x * ART + 5, y * ART + 3, 1, 4);
        }
      }
    }
    g.restore();
  }

  /** M10: velo de las regiones en reposo (una máscara de 1 px por celda, suavizada al escalar). */
  private drawRestVeil(g: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number): void {
    if (!this.vivas) return;
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
    const key = `${this.gridRevision}:${this.propsRevision}:${this.structureRevision}:${x0}:${x1}:${y0}:${y1}:${world.animals === undefined ? 1 : 0}`;
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
    // V23: sin especie, el cuerpo dibujado sale de la masa, la carnivoría y el agua; la talla, de la masa real.
    const plan = planDeFauna(v, this.tileAt(Math.round(animal.x), Math.round(animal.y))?.terrain === 'water');
    const escala = escalaDeFauna(v, plan);
    const key = animalSpriteKey(v, pose, traits, plan);
    let art = this.animalCache.get(key);
    if (!art) {
      art = document.createElement('canvas');
      art.width = art.height = 32;
      paintAnimal(art.getContext('2d')!, plan, v.action, pose, traits);
      this.cacheSprite(key, art, this.animalCache);
    }
    const x = Math.round(animal.x * ART + 8), y = Math.round(animal.y * ART + 12);
    g.save(); g.translate(x, y); if (animal.left) g.scale(-1, 1);
    if (escala === 1) g.drawImage(art, -16, -26);
    else g.drawImage(art, Math.round(-16 * escala), Math.round(-26 * escala), Math.round(32 * escala), Math.round(32 * escala));
    g.restore(); this.drawCalls++;
    if (!v.v23) return;
    const extraido = extraccionVisible(v, this.curr?.tick ?? 0);
    if (extraido) paintMarcaExtraccion(g, x + Math.round(5 * escala), y - Math.round(14 * escala), extraido);
    paintMiedo(g, x, y - Math.round(24 * escala), v.v23.miedo);
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

  private drawStructure(g: CanvasRenderingContext2D, structure: StructureView, t = 0, still = false): void {
    const ext = structure as ExtendedStructure, animate = !still && !this.reduceMotion && this.actionActive;
    if (ext.site) { paintConstructionSite(g, ext, ext.site, t, animate); this.drawCalls++; return; }
    if (isModular(ext)) { this.drawModularHall(g, ext, t, animate); return; }
    const art = this.structureRaster(structure);
    g.drawImage(art, Math.round(structure.x * ART + 8) - 16, Math.round(structure.y * ART + 13) - 29); this.drawCalls++;
    paintCompactAccessories(g, ext, t, animate, true);
    if (still) return;
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
    const moving = this.graphicsSettings?.vegetationSway !== false && !this.reduceMotion && sprite.seed % 11 === 0 && this.effects.vegetation < VISUAL_BUDGET.vegetation;
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

  private drawActiveLayers(g: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number): void {
    const layers = MAP_LAYER_CATALOG.filter(meta => this.activeLayers?.has(meta.id));
    const v23 = this.capasV23Activas().length;
    if (layers.length) {
      g.save();
      for (const meta of layers) {
        g.fillStyle = meta.color;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const tile = this.tileAt(x, y); if (!tile) continue;
          const intensity = this.layerIntensity(meta, tile, x, y);
          if (intensity === null) continue;
          g.globalAlpha = clamp01(intensity) * Math.min(.36, .7 / Math.sqrt(layers.length + v23));
          g.fillRect(x * ART, y * ART, ART, ART);
        }
      }
      g.restore();
    }
    if (v23) this.drawCapasV23(g, x0, x1, y0, y1, layers.length + v23);
  }

  /** Intensidad 0..1 de una capa en una tesela; `null` = sin evidencia (geología sin semilla recibida): no se pinta. */
  private layerIntensity(meta: (typeof MAP_LAYER_CATALOG)[number], tile: Tile, x: number, y: number): number | null {
    if (meta.id === 'moisture') return tile.moisture;
    if (meta.id === 'activeRegions') return this.vivas?.has(claveRegion(x, y)) ? 1 : 0;
    if (meta.id === 'geology') {
      if (this.worldSeed === undefined) return null;
      const geology = geologyAt(this.worldSeed, x, y, tile.biome, tile.feature);
      return Math.max(geology.Fe, geology.Ca, geology.S);
    }
    if (meta.id === 'hilos') return this.reparto?.has(this.paginaDe(x, y)) ? 1 : null;
    if (meta.id === 'aire') { const a = this.aire?.get(this.paginaDe(x, y)); return a ? a.humedadRelativa : null; }
    if (meta.legacyCapa) { const capa = meta.legacyCapa as LegacyCapa; return posicionEnRampa(valorCrudo(tile, capa), capa); }
    return 0;
  }

  /* ------------------ V24: niveles lejano y mapa ------------------ */

  /**
   * Nivel lejano y mapa: todo se dibuja directo en el panel con la transformación arte→pantalla (sin lienzo de escena).
   * Capas de datos (una imagen de 1 px por tesela), lugares, copas por trozos (lejano), estructuras quietas y cuerpos
   * cacheados (lejano) o puntos (mapa). El coste por fotograma lo acotan los trozos y cuerpos visibles, no las teselas.
   */
  private drawFar(world: WorldView, people: RenderPerson[], animals: RenderAnimal[], t: number, tier: LodTier): void {
    const ctx = this.ctx, k = this.cam.zoom * this.dpr / ART;
    const v = this.visibleBounds();
    const x0 = Math.max(this.originX, v.x0), x1 = Math.min(this.originX + this.worldW - 1, v.x1);
    const y0 = Math.max(this.originY, v.y0), y1 = Math.min(this.originY + this.worldH - 1, v.y1);
    this.perf.farFrames++;
    this.visibleTiles = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
    this.effects.water = this.effects.vegetation = this.effects.shadows = 0;
    this.bodyCutaways = 0;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, (this.cssW / 2 - this.cam.x * this.cam.zoom) * this.dpr, (this.cssH / 2 - this.cam.y * this.cam.zoom) * this.dpr);
    ctx.imageSmoothingEnabled = false;
    this.drawLayerImage(ctx, 'data');
    this.drawHeatImage(ctx);
    this.drawPlaces(ctx, world.places, x0, x1, y0, y1);
    if (tier === 'far') this.drawCanopy(ctx, x0, x1, y0, y1, k);
    this.visibleStructures = 0;
    for (const structure of world.structures ?? []) {
      const box = footprintBox(structure as ExtendedStructure);
      if (box.x0 + box.w - 1 < x0 || box.x0 > x1 || box.y0 + box.h - 1 < y0 || box.y0 > y1) continue;
      this.visibleStructures++;
      this.drawStructure(ctx, structure, t, true);
    }
    this.drawLotesCalientes(ctx, world, x0, x1, y0, y1, tier, t);
    this.drawLayerImage(ctx, 'legacy'); // los datos clásicos quedan visibles sobre el arbolado, como de cerca
    this.layerDirty.length = 0;
    if (this.vivas) this.drawRestVeil(ctx, x0, x1, y0, y1);
    // Cuerpos: Y-ordenados (el de más al sur, encima).
    const bodies: (RenderPerson | RenderAnimal)[] = [];
    this.visibleAnimals = 0;
    for (const animal of animals) if (animal.x >= x0 && animal.x <= x1 && animal.y >= y0 && animal.y <= y1) { bodies.push(animal); this.visibleAnimals++; }
    for (const person of people) if (person.x >= x0 - 2 && person.x <= x1 + 2 && person.y >= y0 - 2 && person.y <= y1 + 2) bodies.push(person);
    bodies.sort((a, b) => a.y - b.y);
    this.perf.bodiesDrawn += bodies.length;
    if (tier === 'far') {
      for (const body of bodies) if ('role' in body.view) this.drawPerson(ctx, body as RenderPerson, t); else this.drawAnimal(ctx, body as RenderAnimal, t);
      this.settlePersonSprites();
    } else {
      // Mapa: un punto con contorno por cuerpo (≥ 2 px de pantalla); la ropa y la especie dan el color.
      const unit = Math.max(2 / k, 4);
      for (const body of bodies) {
        const ax = body.x * ART + ART / 2, ay = body.y * ART + ART / 2;
        const person = 'role' in body.view ? body as RenderPerson : null;
        const animal = person ? null : body.view as AnimalView, species = animal?.species;
        const fill = person ? this.personDotColor(person.view) : animal?.v23 ? pelajeDeLinaje(animal.v23.linaje) : species === 'deer' ? css(P.soil) : species === 'boar' || species === 'wolf' ? css(P.trunkLight) : css(P.soilLight);
        const size = person ? unit * 1.5 : unit;
        ctx.fillStyle = '#231710'; ctx.fillRect(ax - size / 2 - unit / 4, ay - size - unit / 4, size + unit / 2, size + unit / 2);
        ctx.fillStyle = fill; ctx.fillRect(ax - size / 2, ay - size, size, size);
      }
      this.drawCalls += bodies.length;
    }
    ctx.restore();
  }

  /** Color de un habitante en el mapa: S e I con sus colores; el resto, el de su comunidad o el de su ropa. */
  private personDotColor(view: PersonView): string {
    if (view.role === 'S') return css(P.amber);
    if (view.role === 'I') return css(P.coral);
    const community = view.communityId ? this.communityColors.get(view.communityId) : undefined;
    return css(parseColor(community ?? view.color ?? '', P.neutralCloth));
  }

  /**
   * V24 (Canvas2D sin GPU): suelo de un trozo reducido a `size` px (su tamaño en pantalla), para que el volcado sea 1:1 y
   * no una reducción de 128×128 por trozo y fotograma. Se rehace por tandas al cambiar el zoom; entretanto, el original.
   */
  private reducedTerrain(chunk: GroundChunk, size: number): HTMLCanvasElement {
    const full = CHUNK_ART_TILES * ART;
    if (size >= full) return chunk.canvas;
    const cache = this.reducedCache ??= new BoundedCache<{ revision: number; size: number; canvas: HTMLCanvasElement }>(TERRAIN_CACHE_LIMIT, entry => { entry.canvas.width = entry.canvas.height = 0; });
    let entry = cache.get(chunk.key);
    if (entry && entry.revision === chunk.revision && (entry.size === size || !this.zoomSettled) && entry.canvas.width > 0) return entry.canvas;
    if (!this.zoomSettled) return chunk.canvas;
    if (this.reducedBudgetAt !== this.frameStamp) { this.reducedBudgetAt = this.frameStamp; this.reducedSpent = 0; }
    if (this.reducedSpent >= 96) return entry && entry.canvas.width > 0 && entry.revision === chunk.revision ? entry.canvas : chunk.canvas;
    this.reducedSpent++;
    const canvas = entry && entry.canvas.width > 0 ? entry.canvas : document.createElement('canvas');
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d')!; c.imageSmoothingEnabled = false; c.drawImage(chunk.canvas, 0, 0, size, size);
    if (entry) { entry.revision = chunk.revision; entry.size = size; entry.canvas = canvas; }
    else { entry = { revision: chunk.revision, size, canvas }; cache.set(chunk.key, entry); }
    return canvas;
  }

  /** Copas y cabañas de un trozo de 8×8 a la escala de la pantalla (≤ 1 px de arte, en octavos), cacheadas por contenido. */
  private drawCanopy(g: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number, k: number): void {
    const scale = k >= 1 ? 1 : Math.max(.25, Math.ceil(k * 8) / 8);
    // Las copas suben hasta ~2,5 teselas por encima de su casilla: se incluye una fila de trozos más abajo.
    const cx0 = Math.floor(Math.max(x0 - 1, this.originX) / CHUNK_ART_TILES), cx1 = Math.floor(Math.min(x1 + 1, this.originX + this.worldW - 1) / CHUNK_ART_TILES);
    const cy0 = Math.floor(Math.max(y0, this.originY) / CHUNK_ART_TILES), cy1 = Math.floor(Math.min(y1 + 3, this.originY + this.worldH - 1) / CHUNK_ART_TILES);
    const start = performance.now();
    // Una ventana chica (el encuadre de prueba, o un pueblo) se hornea entera: el pixel-art lejano coincide con el cercano.
    // Una ventana grande se reparte: un zoom no hornea cientos de copas en el mismo fotograma.
    const syncCanopy = (cx1 - cx0 + 1) * (cy1 - cy0 + 1) <= 128;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const key = `${cx}:${cy}`, stamp = this.chunkStamp.get(key);
      if (stamp === undefined) continue;
      let entry = this.canopyCache.get(key);
      if (!entry || entry.stamp !== stamp || entry.structureRevision !== this.structureRevision || (entry.scale !== scale && this.zoomSettled)) {
        if (!syncCanopy && performance.now() - start > BAKE_BUDGET_MS) { /* la anterior, o ninguna, hasta el fotograma siguiente */ }
        else entry = this.buildCanopy(key, cx * CHUNK_ART_TILES, cy * CHUNK_ART_TILES, entry && !this.zoomSettled ? entry.scale : scale, stamp, entry);
      }
      if (!entry?.canvas) continue;
      g.drawImage(entry.canvas, cx * CHUNK_ART_TILES * ART - CANOPY_PAD.left, cy * CHUNK_ART_TILES * ART - CANOPY_PAD.top,
        CHUNK_ART_TILES * ART + CANOPY_PAD.left + CANOPY_PAD.right, CHUNK_ART_TILES * ART + CANOPY_PAD.top + CANOPY_PAD.bottom);
      this.drawCalls++; this.perf.canopyBlits++;
    }
  }

  private buildCanopy(cacheKey: string, x0: number, y0: number, scale: number, stamp: number, entry: CanopyChunk | undefined): CanopyChunk {
    const sprites: Sprite[] = [];
    let sig = '';
    for (let y = y0; y < y0 + CHUNK_ART_TILES; y++) for (let x = x0; x < x0 + CHUNK_ART_TILES; x++) {
      const tile = this.tileAt(x, y);
      if (!tile || tile.terrain === 'water' || this.structuredTiles.has(cellKey(x, y))) continue;
      if (tile.terrain === 'shelter') { sprites.push({ kind: SpriteKind.Hut, sortY: y * ART + 13, ax: x * ART + 8, ay: y * ART + 13, seed: hash3(x, y, 900), size: 0, person: null }); sig += `h${x},${y};`; continue; }
      const tree = this.treeSprite(tile);
      if (tree) { sprites.push(tree); sig += `${x},${y}:${formKey(tree.tree)};`; }
    }
    const result: CanopyChunk = entry ?? { sig: '', stamp, structureRevision: this.structureRevision, scale, canvas: null };
    const sameScale = result.scale === scale;
    result.stamp = stamp; result.structureRevision = this.structureRevision; result.scale = scale;
    if (entry && entry.sig === sig && sameScale) return entry;
    result.sig = sig;
    if (!sprites.length) { if (result.canvas) result.canvas.width = result.canvas.height = 0; result.canvas = null; }
    else {
      const width = Math.ceil((CHUNK_ART_TILES * ART + CANOPY_PAD.left + CANOPY_PAD.right) * scale), height = Math.ceil((CHUNK_ART_TILES * ART + CANOPY_PAD.top + CANOPY_PAD.bottom) * scale);
      const canvas = result.canvas && result.canvas.width > 0 ? result.canvas : document.createElement('canvas');
      canvas.width = width; canvas.height = height; // también limpia
      const c = canvas.getContext('2d')!;
      c.imageSmoothingEnabled = false;
      c.setTransform(scale, 0, 0, scale, -(x0 * ART - CANOPY_PAD.left) * scale, -(y0 * ART - CANOPY_PAD.top) * scale);
      sprites.sort((a, b) => a.sortY - b.sortY);
      for (const sprite of sprites) {
        if (sprite.kind === SpriteKind.Tree) c.drawImage(this.treeRaster(sprite.tree!, 1), Math.round(sprite.ax) - 16, Math.round(sprite.ay) - 44);
        else this.drawHut(c, sprite.ax, sprite.ay, sprite.seed);
      }
      result.canvas = canvas;
      this.perf.canopyBuilds++;
    }
    this.perf.canopyChunkBuilds++;
    if (!entry) this.canopyCache.set(cacheKey, result);
    return result;
  }

  /** Nivel mapa: suelo + arbolado a `MAP_ART` px/tesela por bloques de `MAP_BLOCK`, cacheados por los sellos de sus trozos. */
  private drawMapChunks(ctx: CanvasRenderingContext2D): void {
    if (!this.worldW || !this.worldH) return;
    const v = this.visibleBounds(), start = performance.now();
    const bx0 = Math.floor(Math.max(v.x0, this.originX) / MAP_BLOCK), bx1 = Math.floor(Math.min(v.x1, this.originX + this.worldW - 1) / MAP_BLOCK);
    const by0 = Math.floor(Math.max(v.y0, this.originY) / MAP_BLOCK), by1 = Math.floor(Math.min(v.y1, this.originY + this.worldH - 1) / MAP_BLOCK);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const zoom = this.cam.zoom, dpr = this.dpr, per = MAP_BLOCK / CHUNK_ART_TILES;
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      // Sello del bloque: el mayor de sus trozos (los sellos solo crecen) y cuántos hay.
      let stamp = 0, present = 0;
      for (let cy = by * per; cy < (by + 1) * per; cy++) for (let cx = bx * per; cx < (bx + 1) * per; cx++) {
        const value = this.chunkStamp.get(`${cx}:${cy}`);
        if (value !== undefined) { present++; if (value > stamp) stamp = value; }
      }
      if (!present) continue;
      const key = `${bx}:${by}`, version = stamp * 64 + present;
      let block = this.mapCache.get(key);
      if ((!block || block.stamp !== version) && performance.now() - start < BAKE_BUDGET_MS) block = this.buildMapBlock(key, bx * MAP_BLOCK, by * MAP_BLOCK, version, block);
      if (!block || block.canvas.width === 0) continue;
      const x = Math.round((this.cssW / 2 + (block.x - this.cam.x) * zoom) * dpr), y = Math.round((this.cssH / 2 + (block.y - this.cam.y) * zoom) * dpr);
      const xe = Math.round((this.cssW / 2 + (block.x + MAP_BLOCK - this.cam.x) * zoom) * dpr), ye = Math.round((this.cssH / 2 + (block.y + MAP_BLOCK - this.cam.y) * zoom) * dpr);
      ctx.drawImage(block.canvas, x, y, xe - x, ye - y); this.drawCalls++;
    }
    ctx.restore();
  }

  private buildMapBlock(key: string, x0: number, y0: number, stamp: number, block: MapChunk | undefined): MapChunk {
    const size = MAP_BLOCK * MAP_ART;
    const canvas = block && block.canvas.width > 0 ? block.canvas : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const c = canvas.getContext('2d')!;
    const image = c.createImageData(size, size), data = image.data;
    const put = (px0: number, py0: number, w: number, h: number, color: RGB): void => {
      for (let y = py0; y < py0 + h; y++) for (let x = px0; x < px0 + w; x++) {
        const o = (y * size + x) * 4; data[o] = color.r; data[o + 1] = color.g; data[o + 2] = color.b; data[o + 3] = 255;
      }
    };
    for (let ty = 0; ty < MAP_BLOCK; ty++) for (let tx = 0; tx < MAP_BLOCK; tx++) {
      const x = x0 + tx, y = y0 + ty, tile = this.tileAt(x, y);
      if (!tile) continue;
      const px0 = tx * MAP_ART, py0 = ty * MAP_ART;
      if (tile.terrain === 'water') {
        const shore = this.tileAt(x - 1, y)?.terrain === 'meadow' || this.tileAt(x + 1, y)?.terrain === 'meadow' || this.tileAt(x, y - 1)?.terrain === 'meadow' || this.tileAt(x, y + 1)?.terrain === 'meadow';
        put(px0, py0, MAP_ART, MAP_ART, shore ? P.water : P.waterDeep);
        continue;
      }
      const m = this.groundMaterial(tile);
      let base = mix(m.soil, m.leaf, m.cover);
      if (cropStage(tile) !== null) base = mix(base, P.amber, .35);
      if ((tile.paved ?? 0) >= .5) base = P.stone; else if ((tile.traffic ?? 0) >= .25) base = mix(base, P.soilLight, .5);
      if (tile.terrain === 'shelter') base = P.shelterGround;
      put(px0, py0, MAP_ART, MAP_ART, base);
      if (this.structuredTiles.has(cellKey(x, y))) continue;
      if (tile.terrain === 'shelter') { put(px0 + 1, py0 + 1, 2, 2, P.hutRoof); continue; }
      const form = this.treeForms.get(tile);
      if (form) {
        // Árbol agregado: copa de 3×3 con un píxel de luz; el tronco asoma debajo.
        const leaf = form.kind === 'pine' ? P.canopyDark : form.kind === 'palm' ? P.reed : form.foliage < .2 ? P.trunkLight : P.canopyMid;
        put(px0, py0, 3, 3, leaf); put(px0 + 1, py0, 1, 1, lighten(leaf, .25)); put(px0 + 1, py0 + 3, 1, 1, P.trunk);
      }
    }
    c.putImageData(image, 0, 0);
    this.perf.mapChunkBuilds++;
    if (block && block.canvas === canvas) { block.stamp = stamp; return block; }
    const fresh: MapChunk = { stamp, canvas, x: x0, y: y0 };
    this.mapCache.set(key, fresh);
    return fresh;
  }

  /**
   * Capas de datos como una imagen de 1 px por tesela de la ventana, parcheada tesela a tesela con cada tick: `data` (las del
   * catálogo, bajo el arbolado, como `drawActiveLayers`) o `legacy` (la capa clásica de agua/comida, encima, como
   * `drawLayerCell`). Mismos colores y alfas que el dibujo por tesela del nivel cercano.
   */
  private drawLayerImage(g: CanvasRenderingContext2D, which: 'data' | 'legacy'): void {
    const layers = which === 'data' ? [...MAP_LAYER_CATALOG.filter(meta => this.activeLayers?.has(meta.id)), ...this.capasV23Activas()] : [];
    const legacy = which === 'legacy' ? this.layer : 'none';
    if ((which === 'data' ? !layers.length : legacy === 'none') || !this.worldW || !this.worldH) { this.layerImages[which] = null; return; }
    const v23Key = layers.some(meta => meta.id === 'hilos') ? this.repartoKey : '', aireKey = layers.some(meta => meta.id === 'aire') ? this.aireKey : '';
    const key = `${which === 'data' ? layers.map(meta => meta.id).join(',') : legacy}:${this.gridRevision}:${this.vivasKey}:${this.worldSeed}:${this.originX}:${this.originY}:${this.worldW}:${this.worldH}:${v23Key}:${aireKey}`;
    const colors = layers.map(meta => hexRgb(meta.color)), base = Math.min(.36, .7 / Math.sqrt(Math.max(1, layers.length)));
    const legacyColor = legacy === 'moisture' ? P.waterShallow : P.amber;
    const paint = (img: LayerImage, tile: Tile): void => {
      const lx = Math.floor(tile.x) - img.x, ly = Math.floor(tile.y) - img.y;
      if (lx < 0 || ly < 0 || lx >= img.w || ly >= img.h) return;
      let r = 0, gr = 0, b = 0, a = 0; // premultiplicado: mismas capas, mismo orden y alfa que el dibujo por tesela
      if (which === 'legacy') {
        const v = clamp01(legacy === 'moisture' ? tile.moisture : tile.food);
        if (v >= .05) { a = v * (legacy === 'moisture' ? .45 : .42); r = legacyColor.r * a; gr = legacyColor.g * a; b = legacyColor.b * a; }
      } else layers.forEach((meta, i) => {
        const intensity = this.layerIntensity(meta, tile, tile.x, tile.y);
        if (intensity === null) return;
        const alpha = clamp01(intensity) * base;
        const [cr, cg, cb] = meta.id === 'hilos' ? colorDeDueno(this.reparto!.get(this.paginaDe(tile.x, tile.y))!) : colors[i]!;
        r = cr * alpha + r * (1 - alpha); gr = cg * alpha + gr * (1 - alpha); b = cb * alpha + b * (1 - alpha); a = alpha + a * (1 - alpha);
      });
      const o = (ly * img.w + lx) * 4, d = img.data.data;
      if (a <= 0) { d[o + 3] = 0; return; }
      d[o] = Math.round(r / a); d[o + 1] = Math.round(gr / a); d[o + 2] = Math.round(b / a); d[o + 3] = Math.round(a * 255);
    };
    let image = this.layerImages[which];
    if (!image || image.key !== key || this.layerDirty.length >= LAYER_DIRTY_LIMIT) {
      const canvas = image?.canvas ?? document.createElement('canvas');
      canvas.width = this.worldW; canvas.height = this.worldH;
      const ctx = canvas.getContext('2d')!;
      image = { canvas, ctx, data: ctx.createImageData(this.worldW, this.worldH), key, x: this.originX, y: this.originY, w: this.worldW, h: this.worldH };
      for (let i = 0; i < this.grid.length; i++) { const tile = this.grid[i]; if (tile) paint(image, tile); }
      ctx.putImageData(image.data, 0, 0);
      this.layerImages[which] = image;
    } else if (this.layerDirty.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const tile of this.layerDirty) {
        paint(image, tile);
        const lx = Math.floor(tile.x) - image.x, ly = Math.floor(tile.y) - image.y;
        minX = Math.min(minX, lx); minY = Math.min(minY, ly); maxX = Math.max(maxX, lx); maxY = Math.max(maxY, ly);
      }
      minX = Math.max(0, minX); minY = Math.max(0, minY); maxX = Math.min(image.w - 1, maxX); maxY = Math.min(image.h - 1, maxY);
      if (maxX >= minX && maxY >= minY) image.ctx.putImageData(image.data, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
    }
    g.drawImage(image.canvas, image.x * ART, image.y * ART, image.w * ART, image.h * ART); this.drawCalls++;
  }

  /** Mapa de calor (T033) del nivel lejano: 1 px por tesela con `dibujarCalor`, parcheado con las teselas del tick. */
  private drawHeatImage(g: CanvasRenderingContext2D): void {
    const capa = this.capaCalor;
    if (!capa || !this.worldW || !this.worldH) { this.heatImage = null; return; }
    const key = `${capa}:${this.rangoCalorKey}:${this.gridRevision}:${this.originX}:${this.originY}:${this.worldW}:${this.worldH}`;
    const view = { x0: this.originX, y0: this.originY, tileSize: 1, scale: 1 };
    let image = this.heatImage;
    if (!image || image.key !== key || this.layerDirty.length >= LAYER_DIRTY_LIMIT) {
      const canvas = image?.canvas ?? document.createElement('canvas');
      canvas.width = this.worldW; canvas.height = this.worldH; // también limpia
      const ctx = canvas.getContext('2d')!;
      dibujarCalor(ctx, this.grid.filter((tile): tile is Tile => tile !== undefined), capa, view, .55, this.rangoCalor);
      image = this.heatImage = { canvas, ctx, key, x: this.originX, y: this.originY, w: this.worldW, h: this.worldH };
    } else if (this.layerDirty.length) {
      for (const tile of this.layerDirty) image.ctx.clearRect(Math.floor(tile.x) - image.x, Math.floor(tile.y) - image.y, 1, 1);
      dibujarCalor(image.ctx, this.layerDirty, capa, view, .55, this.rangoCalor);
    }
    g.drawImage(image.canvas, image.x * ART, image.y * ART, image.w * ART, image.h * ART); this.drawCalls++;
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

  /**
   * V24: un habitante se pinta una vez por identidad + pose (ropa, oficio, acción, paso, golpe de trabajo, avisos) en un
   * sprite de 32×32 y luego se copia. El pintado es el mismo que antes, desplazado un número entero de píxeles: mismos
   * píxeles. La barra de trabajo y la labor agrícola (dependen del zoom y del tiempo) se pintan encima, como antes.
   */
  private drawPerson(g: CanvasRenderingContext2D, p: RenderPerson, t: number): void {
    const view = p.view;
    const senescent = view.lifeStage === 'senescent';
    const ax = Math.round(p.x * ART + ART / 2);
    const ay = Math.round(p.y * ART + ART / 2 + 4);
    const baseY = view.action === 'rest' ? ay + 2 : ay;
    // Balanceo de paso: sólo si el servidor la movió de verdad.
    // V18: el paso sale de la distancia recorrida (mayores caminan a zancada más corta): andar sereno, nunca a trompicones.
    const step = !this.reduceMotion && p.moving ? (Math.floor(p.stride / (senescent ? STRIDE_TILES * 1.3 : STRIDE_TILES) + p.seed) & 1) : 0;
    const atTarget = view.target ? Math.hypot(view.x - view.target.x, view.y - view.target.y) < .5 : false;
    const working = view.working === true || (view.working === undefined && atTarget);
    const previous = this.prevPeople.get(view.id);
    const consuming = view.action === 'drink' ? previous?.thirst !== undefined && view.thirst !== undefined && previous.thirst > view.thirst
      : view.action === 'eat' && previous !== undefined && previous.hunger > view.hunger;
    const beat = !this.reduceMotion && this.actionActive && !p.moving && (working || consuming) ? Math.floor(t * 3 + p.seed) % 2 : 0;
    // V19: labor agrícola sobre el cultivo real de la casilla (azada al arar, hoz al cosechar, gavilla al comer).
    const cropWork = cropWorkMode(view.action, working, p.moving, this.tileAt(Math.round(p.x), Math.round(p.y)));
    const pose = { step, beat };
    if (typeof document === 'undefined') this.paintPerson(g, p, ax, ay, pose);
    else {
      const craft = this.craftVisuals.get(view.id), glint = this.graphicsSettings?.chemicalGlint !== false;
      const community = view.communityId ? this.communityColors?.get(view.communityId) : undefined;
      const health = view.health !== undefined && view.health < .45 ? Math.max(1, Math.round(clamp01(view.health) * 8)) : 0;
      const key = `${p.seed}|${view.color ?? ''}|${view.role}|${view.lifeStage ?? ''}|${view.action}|${p.moving ? 1 : 0}|${step}|${beat}|${community ?? ''}`
        + `|${craft ? `${craft.tint ?? ''},${craft.packTint ?? ''},${craft.lightPack ? 1 : 0},${craft.glint && glint ? 1 : 0}` : ''}`
        + `|${this.carriedProducts.get(view.id) ?? ''}|${this.secondaryProducts.get(view.id) ?? ''}|${this.carriedWater.get(view.id) ? 1 : 0}`
        + `|${this.curr?.technology?.items !== undefined ? 1 : 0}|${(view.materials?.stone ?? 0) > 0 ? 1 : 0}|${(view.foodReserve ?? 0) > 0 ? 1 : 0}`
        + `|${view.controlMode === 'directed' ? 1 : 0}|${(view.thirst ?? 0) >= .82 ? 1 : (view.hunger ?? 0) >= .82 ? 2 : 0}|${health}`;
      const cache = this.personSprites ??= new BoundedCache<HTMLCanvasElement>(PERSON_SPRITE_LIMIT, canvas => { canvas.width = canvas.height = 0; });
      let sprite = cache.get(key);
      // V23: el sprite de su etapa, a la talla de su masa (cuantizada: pocas tallas, píxeles enteros).
      const escala = escalaDeCuerpo(view.cuerpoVisto, view.lifeStage);
      const blit = (art: HTMLCanvasElement): void => {
        if (escala === 1) g.drawImage(art, ax - PERSON_SPRITE.ox, ay - PERSON_SPRITE.oy);
        else g.drawImage(art, Math.round(ax - PERSON_SPRITE.ox * escala), Math.round(ay - PERSON_SPRITE.oy * escala), Math.round(PERSON_SPRITE.w * escala), Math.round(PERSON_SPRITE.h * escala));
      };
      if (sprite && sprite.width > 0) { this.spriteHits++; blit(sprite); this.drawCalls++; }
      else if (cache.size >= cache.capacity) {
        // Caché llena: un recorrido cíclico más largo que ella la expulsaría entera en cada fotograma (0 aciertos).
        // Lo que no cabe se pinta directo y lo ya guardado se conserva; `settlePersonSprites` la vacía si solo quedan obsoletos.
        this.spriteDirect++; this.paintPerson(g, p, ax, ay, pose);
      } else {
        sprite = document.createElement('canvas'); sprite.width = PERSON_SPRITE.w; sprite.height = PERSON_SPRITE.h;
        this.paintPerson(sprite.getContext('2d')!, p, PERSON_SPRITE.ox, PERSON_SPRITE.oy, pose);
        cache.set(key, sprite);
        this.perf.personSpriteBuilds++; this.spriteFresh++;
        blit(sprite); this.drawCalls++;
      }
    }
    const gestacion = fraccionGestacion(view.cuerpoVisto);
    if (gestacion !== null) paintEmbarazo(g, ax, baseY, gestacion, escalaDeCuerpo(view.cuerpoVisto, view.lifeStage));
    if (working && view.workProgress !== undefined && view.workProgress > 0 && this.cam.zoom >= 18) {
      px(g,ax-5,baseY+4,10,2,css(P.ink,.65)); px(g,ax-5,baseY+4,Math.max(1,Math.round(clamp01(view.workProgress)*10)),1,css(P.amber));
    }
    if (cropWork) drawCropWork(g, { mode: cropWork, ax, baseY, t, seed: p.seed, animate: !this.reduceMotion && this.actionActive, workProgress: view.workProgress, ring: this.cam.zoom >= 18 });
  }

  /** Tras dibujar los cuerpos: si la caché está llena, no acertó ni una vez y no admitió ninguna pose nueva, solo guarda poses obsoletas y se vacía. */
  private settlePersonSprites(): void {
    if (this.spriteDirect > 0 && this.spriteHits === 0 && this.spriteFresh === 0) this.personSprites?.clear();
    this.spriteHits = this.spriteDirect = this.spriteFresh = 0;
  }

  /** Cuerpo de un habitante con su pie en (`ax`, `ay`) de arte (sin barra de trabajo ni labor agrícola). */
  private paintPerson(g: CanvasRenderingContext2D, p: RenderPerson, ax: number, ay: number, pose: { step: number; beat: number }): void {
    const view = p.view;
    const resting = view.action === 'rest';
    const stage = view.lifeStage;
    const juvenile = stage === 'juvenile';
    const senescent = stage === 'senescent';

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

    const communityColor = view.communityId ? this.communityColors?.get(view.communityId) ?? this.curr?.communities?.find(group => group.id === view.communityId)?.color : undefined;
    const community = communityColor !== undefined;
    const commRgb = community ? parseColor(communityColor, P.amber) : parseColor(view.color, P.amber);
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

    const step = pose.step;
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

    if (product && (this.graphicsSettings?.chemicalGlint !== false && craft?.glint)) add(ax - 7, baseY - 5, 1, 1, '#f4ffff', false);

    const hasInventoryView = this.curr?.technology?.items !== undefined;
    const hasRealTool = product !== undefined && product !== 'material';
    const showActionTool = !hasInventoryView || hasRealTool;
    const beat = pose.beat;
    const cropWork = cropWorkMode(view.action, view.working === true || (view.working === undefined && (view.target ? Math.hypot(view.x - view.target.x, view.y - view.target.y) < .5 : false)), p.moving, this.tileAt(Math.round(p.x), Math.round(p.y)));

    if (view.action === 'hunt') {
      if (showActionTool) {
        add(ax + 5 + beat, baseY - 13 + beat * 3, 1, 13, css(P.trunkLight), true);
        add(ax + 4 + beat, baseY - 15 + beat * 3, 3, 3, toolHex, true);
        add(ax + 5 + beat, baseY - 16 + beat * 3, 1, 1, (this.graphicsSettings?.chemicalGlint !== false && craft?.glint) ? '#f4ffff' : toolHex, false);
      } else {
        add(ax + 3 + beat, baseY - 7 + beat * 2, 3, 2, skinHex, true);
      }
    } else if (view.action === 'drink') {
      const lift = p.moving ? 4 : beat;
      add(ax + 3, headTop + 3 + lift, 3, 3, craft?.tint ?? css(P.waterGleam), true);
      if ((this.graphicsSettings?.chemicalGlint !== false && craft?.glint)) add(ax + 3, headTop + 3 + lift, 1, 1, '#f4ffff', false);
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
        if ((this.graphicsSettings?.chemicalGlint !== false && craft?.glint)) add(ax + 5, hand - 4, 1, 1, '#f4ffff', false);
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
      // V23: con aire servido, cada gota cae solo si en su página llueve (en proporción a su lluvia sobre la media).
      const local = this.lluviaEnPantalla(x, y);
      if (local !== null && rnd(i, 2, 997) * intensity >= local) continue;
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

    // 2. Acciones vivas (compartir, cooperar, acompañar, acercarse) y la cercanía S↔I.
    // El radio es 3,2 teselas: una rejilla de 4 y su vecindad 3×3 encuentra al mismo más cercano, sin recorrer a todos.
    const CELL = 4;
    const view = this.visibleBounds();
    const xLo = view.x0 - 6, xHi = view.x1 + 6, yLo = view.y0 - 6, yHi = view.y1 + 6;
    const bucketKey = (x: number, y: number): number => (Math.floor(x / CELL) + 8_388_608) * 16_777_216 + (Math.floor(y / CELL) + 8_388_608);
    const buckets = new Map<number, RenderPerson[]>();
    for (const p of people) {
      if (p.x < xLo || p.x > xHi || p.y < yLo || p.y > yHi) continue;
      const key = bucketKey(p.x, p.y);
      const list = buckets.get(key);
      if (list) list.push(p); else buckets.set(key, [p]);
    }
    const visitNear = (p: RenderPerson, fn: (other: RenderPerson) => void): void => {
      const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        const list = buckets.get((x + 8_388_608) * 16_777_216 + (y + 8_388_608));
        if (list) for (const other of list) fn(other);
      }
    };
    for (const p of people) {
      const act = p.view.action;
      if (act !== 'share' && act !== 'cooperate' && act !== 'accompany' && act !== 'approach' && p.view.role !== 'S') continue;
      if (p.x < xLo || p.x > xHi || p.y < yLo || p.y > yHi) continue;
      let nearest: RenderPerson | null = null;
      let bestD = 3.2;
      visitNear(p, other => {
        if (other.view.id === p.view.id) return;
        if (p.view.role === 'S' && act !== 'share' && act !== 'cooperate' && act !== 'accompany' && act !== 'approach' && other.view.role !== 'I') return;
        const d = Math.hypot(p.x - other.x, p.y - other.y);
        if (d < bestD) { bestD = d; nearest = other; }
      });
      if (nearest) {
        const kind = (p.view.role === 'S' && nearest.view.role === 'I') || act === 'accompany' || act === 'approach' ? 'bond' : 'cooperate';
        drawArc(p, nearest, kind);
      }
    }
  }

  /** Selección e insignias: en píxeles de pantalla, para que el texto no se pixele. */
  private drawOverlaysScreen(people: RenderPerson[], animals: RenderAnimal[], tier: LodTier = 'near'): void {
    const ctx = this.labelCtx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (tier !== 'map') this.drawSocialLinks(people); // en el mapa los arcos medirían unos pocos píxeles
    this.drawVinculos(people);
    if (tier !== 'map') this.drawCuerposV23(people, animals, tier === 'near');

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
          this.drawChip(s.x, s.y + 15, `${nombreDeFauna(animal.view)} · ${animalActions[animal.view.action]}`, P.ink, P.rule, 'meta');
        }
      }
    }
    if (this.archiveFocus) {
      // El contorno corresponde exactamente a una tesela, no a una longitud de camino.
      const a = this.worldToScreen(this.archiveFocus.x, this.archiveFocus.y);
      ctx.setLineDash([]);
      ctx.strokeStyle = '#193329'; ctx.lineWidth = 5;
      ctx.strokeRect(a.x, a.y, this.cam.zoom, this.cam.zoom);
      ctx.strokeStyle = '#f6df78'; ctx.lineWidth = 2;
      ctx.strokeRect(a.x, a.y, this.cam.zoom, this.cam.zoom);
      this.drawChip(a.x + this.cam.zoom / 2, a.y - 12, 'Casilla observada', P.ink, P.amber, 'meta');
    }
    this.drawLoading();
    ctx.restore();
  }

  /** Red de confianza de la persona seleccionada: grosor y opacidad según el peso, color de la comunidad del otro y un
   * píxel en su extremo. Una pasada por `people` (O(n + k)); los vínculos con quien está fuera de cuadro se cuentan. */
  private drawVinculos(people: RenderPerson[]): void {
    const v = this.vinculos, sel = this.selection;
    if (!v || sel?.kind !== 'person' || sel.id !== v.origen) return;
    const pesos = new Map(v.aristas.map(a => [a.id, a]));
    let origen: RenderPerson | undefined;
    const presentes: [RenderPerson, VinculoMapa][] = [];
    for (const p of people) {
      if (p.view.id === v.origen) origen = p;
      else { const arista = pesos.get(p.view.id); if (arista) presentes.push([p, arista]); }
    }
    if (!origen) return;
    const ctx = this.labelCtx, a = this.worldToScreen(origen.x + .5, origen.y + .6);
    ctx.save();
    ctx.lineCap = 'square';
    for (const [otro, arista] of presentes) {
      const b = this.worldToScreen(otro.x + .5, otro.y + .6), peso = clamp01(arista.peso);
      const ancho = 1 + 3 * peso;
      ctx.beginPath(); ctx.moveTo(Math.round(a.x), Math.round(a.y)); ctx.lineTo(Math.round(b.x), Math.round(b.y));
      // Contorno de tinta debajo, como el de los sprites: la línea se lee sobre hierba, agua o roca.
      ctx.globalAlpha = .45 + .4 * peso; ctx.strokeStyle = '#1f1a15'; ctx.lineWidth = ancho + 2; ctx.stroke();
      ctx.globalAlpha = .55 + .45 * peso; ctx.strokeStyle = arista.color; ctx.lineWidth = ancho; ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = '#1f1a15'; ctx.fillRect(Math.round(b.x) - 3, Math.round(b.y) - 3, 6, 6);
      ctx.fillStyle = arista.color; ctx.fillRect(Math.round(b.x) - 2, Math.round(b.y) - 2, 4, 4);
    }
    ctx.restore();
    const fuera = v.aristas.length - presentes.length;
    this.drawChip(a.x, a.y + 34, `${presentes.length} vínculos aquí${fuera ? ` · ${fuera} fuera` : ''}`, P.ink, P.rule, 'meta');
  }

  /**
   * V23: persecución (línea de la cazadora a su presa, con remate en la presa), huida (trazos de carrera del lado de la
   * amenaza) y, de cerca, la crianza (hilo cálido punteado de cada cría a sus cuidadores a la vista). O(n + k).
   */
  private drawCuerposV23(people: RenderPerson[], animals: RenderAnimal[], near: boolean): void {
    const fauna = animals.some(a => a.view.v23 && (a.view.v23.persigue !== undefined || a.view.v23.huyeDe !== undefined));
    const crias = near && people.some(p => p.view.crianza?.cuidadores.length);
    if (!fauna && !crias) return;
    const ctx = this.labelCtx;
    ctx.save(); ctx.lineCap = 'square';
    if (fauna) {
      const porUid = new Map<number, RenderPerson | RenderAnimal>();
      for (const a of animals) { const uid = uidVisible(a.view); if (uid !== undefined) porUid.set(uid, a); }
      for (const p of people) { const uid = uidVisible(p.view); if (uid !== undefined) porUid.set(uid, p); }
      for (const a of animals) {
        const f = a.view.v23;
        if (!f) continue;
        const o = this.worldToScreen(a.x + .5, a.y + .6);
        const presa = f.persigue !== undefined ? porUid.get(f.persigue) : undefined;
        if (presa) {
          const b = this.worldToScreen(presa.x + .5, presa.y + .6);
          ctx.setLineDash([5, 3]);
          ctx.beginPath(); ctx.moveTo(Math.round(o.x), Math.round(o.y)); ctx.lineTo(Math.round(b.x), Math.round(b.y));
          ctx.globalAlpha = .55; ctx.strokeStyle = '#1f1a15'; ctx.lineWidth = 3; ctx.stroke();
          ctx.globalAlpha = .9; ctx.strokeStyle = '#c8553d'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.setLineDash([]); ctx.globalAlpha = 1;
          ctx.fillStyle = '#1f1a15'; ctx.fillRect(Math.round(b.x) - 3, Math.round(b.y) - 3, 6, 6);
          ctx.fillStyle = '#c8553d'; ctx.fillRect(Math.round(b.x) - 2, Math.round(b.y) - 2, 4, 4);
        }
        const amenaza = f.huyeDe !== undefined ? porUid.get(f.huyeDe) : undefined;
        if (amenaza) {
          const b = this.worldToScreen(amenaza.x + .5, amenaza.y + .6), dx = b.x - o.x, dy = b.y - o.y, d = Math.hypot(dx, dy);
          if (d > 1) {
            const ux = dx / d, uy = dy / d, paso = Math.max(4, this.cam.zoom * .25);
            ctx.globalAlpha = .4 + .5 * clamp01(f.miedo); ctx.strokeStyle = '#f2dfb0'; ctx.lineWidth = 1.5;
            for (let i = -1; i <= 1; i++) {
              const sx = o.x + ux * paso - uy * i * 3, sy = o.y + uy * paso + ux * i * 3;
              ctx.beginPath(); ctx.moveTo(Math.round(sx), Math.round(sy)); ctx.lineTo(Math.round(sx + ux * paso), Math.round(sy + uy * paso)); ctx.stroke();
            }
            ctx.globalAlpha = 1;
          }
        }
      }
    }
    if (crias) {
      const porId = new Map(people.map(p => [p.view.id, p]));
      ctx.setLineDash([2, 3]); ctx.lineWidth = 1.5;
      for (const p of people) {
        const c = p.view.crianza;
        if (!c?.cuidadores.length) continue;
        const a = this.worldToScreen(p.x + .5, p.y + .6);
        // Cuanto más depende la cría (menos madura), más se ve el hilo.
        ctx.globalAlpha = .35 + .5 * (1 - clamp01(c.madurez)); ctx.strokeStyle = '#e9b07a';
        for (const id of c.cuidadores) {
          const q = porId.get(id);
          if (!q) continue;
          const b = this.worldToScreen(q.x + .5, q.y + .6);
          ctx.beginPath(); ctx.moveTo(Math.round(a.x), Math.round(a.y)); ctx.lineTo(Math.round(b.x), Math.round(b.y)); ctx.stroke();
        }
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
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
    if (this.pickMode === 'inspect' && this.layer === 'none' && !this.activeLayers.size) {
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
