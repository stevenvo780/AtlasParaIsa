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
import { animalActions, speciesNames, paintAnimal, paintStructure } from './life-art.js';
import { animalPose, daylightAt, newEventAccents, VISUAL_BUDGET, EVENT_LIFETIME_MS, type EventAccent } from './visual-state.js';
import type { Capability } from '../shared/technology.js';

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
const TERRAIN_CACHE_LIMIT = 128; // 8 MiB CPU rasters; at most 8 MiB GPU textures.
const SPRITE_CACHE_LIMIT = 512; // 2 MiB of 32 × 32 RGBA sprites.
const MAX_ZOOM = 84;
/** Radio de acierto al tocar una persona, en tiles. */
const PERSON_HIT = 0.65;
/** Margen (en tiles) de mar visible alrededor de la isla al encuadrar. */
const FIT_PADDING = 1.4;
const FOCUS_MS = 380;

/* ------------------------------------------------------------------ */
/* Utilidades de color                                                 */
/* ------------------------------------------------------------------ */

interface RGB {
  r: number;
  g: number;
  b: number;
}

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

/* ------------------------------------------------------------------ */
/* Aleatoriedad determinista (misma isla en todos los clientes)        */
/* ------------------------------------------------------------------ */

function hash3(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** [0,1) determinista. */
function rnd(x: number, y: number, salt: number): number {
  return hash3(x, y, salt) / 4294967296;
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
}
interface RenderAnimal { view: AnimalView; x: number; y: number; moving: boolean; left: boolean; }

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
}

export interface RenderDiagnostics {
  fps: number; frameMs: number; backend: 'webgl2' | 'canvas2d-cached'; gpuStatus: GpuStatus; gpuLabel?: string;
  visibleTiles: number; drawCalls: number; cacheBuilds: number; cacheEntries: number; cacheBytes: number;
  textureUploads: number; gpuTextureBytes: number;
  terrainBuilds: number; spriteBuilds: number;
  visibleAnimals: number; visibleStructures: number;
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

export class Landscape {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onSelect: SelectHandler;
  private readonly labels = document.createElement('canvas');
  private readonly labelCtx: CanvasRenderingContext2D;
  private readonly phaseLayer = document.createElement('div');
  private readonly rainLayer = document.createElement('div');

  private readonly gpu: GpuTerrain;
  private readonly terrainCache = new BoundedCache<GroundChunk>(TERRAIN_CACHE_LIMIT, (chunk, key) => {
    this.gpu?.drop(key); chunk.canvas.width = chunk.canvas.height = 0;
  });
  private readonly spriteCache = new BoundedCache<HTMLCanvasElement>(SPRITE_CACHE_LIMIT, canvas => { canvas.width = canvas.height = 0; });
  private chunks: GroundChunk[] = [];
  private cacheBuilds = 0;
  private spriteBuilds = 0;
  private frameMs = 0;
  private fps = 0;
  private fpsAt = 0;
  private fpsFrames = 0;
  private visibleTiles = 0;
  private visibleAnimals = 0;
  private visibleStructures = 0;
  private drawCalls = 0;
  private sceneRevision = 0;
  private sceneKey = '';
  private ambientKey = '';
  private eventAccents: EventAccent[] = [];
  private effects = { water: 0, vegetation: 0, rain: 0, events: 0, shadows: 0 };
  private actionActive = false;
  private lighting = { shadowX: 4, shadowY: 3, shadowAlpha: .14 };
  private carriedProducts = new Map<string, Capability | 'material'>();
  /** Escena completa por frame, también a resolución de arte. */
  private scene: HTMLCanvasElement;
  private sceneCtx: CanvasRenderingContext2D;

  private prev: WorldView | null = null;
  private curr: WorldView | null = null;
  private prevAt = 0;
  private currAt = 0;
  private interval = 500;

  private worldW = 0;
  private worldH = 0;
  private originX = 0;
  private originY = 0;
  private reportedViewport = '';
  private followedId: string | null = null;
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
  private selection: LandscapeSelection | null = null;
  private pendingTarget: { x: number; y: number } | null = null;

  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

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

  constructor(canvas: HTMLCanvasElement, onSelect: SelectHandler, private readonly onViewport?: (viewport: Viewport) => void, private readonly onManualCamera?: () => void, options: { allowSoftwareWebGL?: boolean } = {}) {
    this.canvas = canvas;
    this.onSelect = onSelect;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Landscape: este navegador no expone un contexto 2D.');
    this.ctx = ctx;

    this.gpu = new GpuTerrain(canvas, options.allowSoftwareWebGL);
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

    // A new camera window at the same tick must not restart body interpolation.
    if (!this.curr || this.curr.tick !== world.tick) {
      this.prevPeople.clear();
      this.prevAnimals.clear();
      if (this.curr && world.tick > this.curr.tick) {
        for (const p of this.curr.people) this.prevPeople.set(p.id, p);
        for (const a of this.curr.animals ?? []) this.prevAnimals.set(a.id, a);
        this.interval = clamp(now - this.currAt, 60, 2000);
      }
      this.prev = this.curr && world.tick > this.curr.tick ? this.curr : null;
      this.prevAt = this.currAt;
      this.currAt = now;
    }
    const newAccents = newEventAccents(this.curr, world, now);
    if (this.curr && world.tick < this.curr.tick) this.eventAccents = [];
    this.eventAccents = [...this.eventAccents.filter(event => now - event.bornAt < EVENT_LIFETIME_MS), ...newAccents].slice(-VISUAL_BUDGET.events);
    this.curr = world;
    this.carriedProducts.clear();
    for (const item of world.technology?.items ?? []) {
      if (item.mass <= 0 || this.carriedProducts.has(item.ownerId)) continue;
      const dominant = (Object.entries(item.capacities) as [Capability,number][]).sort((a,b)=>b[1]-a[1])[0];
      if (dominant) this.carriedProducts.set(item.ownerId,dominant[1]>.08 ? dominant[0] : 'material');
    }
    this.sceneRevision++;

    this.rebuildGrid(world);
    this.bakeGround();

    if (first) {
      this.fitWorld();
    }
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

  follow(id: string | null, kind: 'person' | 'animal' = 'person'): void { this.followedId = id; this.followedKind = kind; }

  setPendingTarget(position: { x: number; y: number } | null): void { this.pendingTarget = position; }

  camera(): { x: number; y: number; zoom: number } { return { ...this.cam }; }

  /** CPU submission time, actual RAF rate, and detected backend; not a GPU timer. */
  getDiagnostics(): RenderDiagnostics {
    return { fps: this.fps, frameMs: this.frameMs, backend: this.gpu.active ? 'webgl2' : 'canvas2d-cached', gpuStatus: this.gpu.status, gpuLabel: this.gpu.label || undefined,
      visibleTiles: this.visibleTiles, drawCalls: this.drawCalls + this.gpu.drawCalls, cacheBuilds: this.cacheBuilds + this.spriteBuilds,
      cacheEntries: this.terrainCache.size + this.spriteCache.size, cacheBytes: this.terrainCache.size * 128 * 128 * 4 + this.spriteCache.size * 32 * 32 * 4,
      textureUploads: this.gpu.uploads, gpuTextureBytes: this.gpu.textureCount * 128 * 128 * 4, terrainBuilds: this.cacheBuilds, spriteBuilds: this.spriteBuilds, visibleAnimals: this.visibleAnimals, visibleStructures: this.visibleStructures,
      effects: { ...this.effects }, effectBudget: VISUAL_BUDGET };
  }

  /** Extra pequeño: permite que la barra lateral resalte a quien se elige en una tarjeta. */
  fit(): void { this.fitWorld(); }

  select(selection: Selection): void { this.selection = selection; }

  setSelection(selection: LandscapeSelection | null): void {
    this.selection = selection;
  }

  resize(): void {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.dpr = clamp(window.devicePixelRatio || 1, 1, 3);
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
    this.terrainCache.clear(); this.spriteCache.clear(); this.chunks = []; this.gpu.destroy();
    this.scene.width = this.scene.height = 0;
    this.labels.width = this.labels.height = 0; this.labels.remove(); this.phaseLayer.remove(); this.rainLayer.remove();
  }

  /* ---------------------------------------------------------------- */
  /* Mundo y rejilla                                                  */
  /* ---------------------------------------------------------------- */

  private rebuildGrid(world: WorldView): void {
    this.originX = world.originX ?? 0;
    this.originY = world.originY ?? 0;
    const w = Math.max(0, Math.floor(world.width));
    const h = Math.max(0, Math.floor(world.height));
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
    if (this.grid.length !== cells) this.grid = new Array<Tile | undefined>(cells);
    this.grid.fill(undefined);
    for (const t of world.tiles) {
      const tx = Math.floor(t.x) - this.originX;
      const ty = Math.floor(t.y) - this.originY;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      this.grid[ty * w + tx] = t;
    }
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
    const acc = (v: number): void => {
      h = Math.imul(h ^ (v | 0), 16777619) >>> 0;
    };
    // Include the one-cell border: a neighbouring coastline change invalidates both chunks.
    for (let y = startY - 1; y <= startY + CHUNK_ART_TILES; y++) for (let x = startX - 1; x <= startX + CHUNK_ART_TILES; x++) {
      const t = this.tileAt(x, y);
      if (!t) { acc(-1); continue; }
      for (const value of `${t.terrain}:${t.biome ?? ''}:${t.feature ?? ''}`) acc(value.charCodeAt(0));
      for (const value of [t.moisture, t.vegetation, t.food, t.growth ?? 1, t.cultivation ?? 0, t.traffic ?? 0, t.drinkingWater ?? 0, t.life ?? 0]) acc(Math.round(clamp01(value) * 12));
      acc(Math.round((t.wood ?? 0) * 2)); acc(Math.round((t.stone ?? 0) * 2)); acc(t.variety ?? 0);
    }
    return h;
  }

  /* ---------------------------------------------------------------- */
  /* Horneado del suelo                                               */
  /* ---------------------------------------------------------------- */

  private bakeGround(): void {
    if (this.worldW === 0 || this.worldH === 0) return;
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
            if (tile) { this.bakeCoast(g, x, y); this.bakeFeatures(g, tile); }
          }
          g.restore();
          if (chunk) { chunk.signature = signature; chunk.revision = ++this.cacheBuilds; }
          else { chunk = { key, signature, revision: ++this.cacheBuilds, canvas, x: x0, y: y0 }; this.terrainCache.set(key, chunk); }
        }
        this.chunks.push(chunk);
      }
    }
    this.groundBaked = true;
  }

  private bakeTileBase(g: CanvasRenderingContext2D, x: number, y: number): void {
    const tile = this.tileAt(x, y);
    const ox = x * ART;
    const oy = y * ART;
    const terrain: Terrain = tile ? tile.terrain : 'water';
    const moisture = tile ? clamp01(tile.moisture) : 1;
    const veg = tile ? clamp01(tile.vegetation) : 0;

    if (terrain === 'water') {
      // Profundidad legible: cuanto más agua alrededor, más oscuro el teal.
      let neighbours = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (this.terrainAt(x + dx, y + dy) === 'water') neighbours++;
        }
      }
      const depth = neighbours / 8;
      const base = mix(P.waterShallow, P.waterDeep, depth * depth);
      px(g, ox, oy, ART, ART, css(base));
      for (let i = 0; i < 2; i++) {
        const rx = ox + Math.floor(rnd(x, y, 10 + i) * ART);
        const ry = oy + Math.floor(rnd(x, y, 40 + i) * ART);
        const up = rnd(x, y, 70 + i) > 0.5;
        px(g, rx, ry, 1 + Math.floor(rnd(x, y, 90 + i) * 2), 1, css(up ? lighten(base, 0.1) : darken(base, 0.08)));
      }
      return;
    }

    if (terrain === 'soil') {
      const base = tile?.biome === 'desert' ? mix(P.sand, P.soilLight, moisture * 0.5) : tile?.biome === 'mountain' ? mix(P.stone, P.stoneShade, 0.35) : mix(P.soilLight, P.soilDark, moisture * 0.7 + 0.1);
      px(g, ox, oy, ART, ART, css(base));
      for (let i = 0; i < 5; i++) {
        const rx = ox + Math.floor(rnd(x, y, 110 + i) * ART);
        const ry = oy + Math.floor(rnd(x, y, 150 + i) * ART);
        const light = rnd(x, y, 190 + i) > 0.55;
        px(g, rx, ry, 1, 1, css(light ? lighten(base, 0.12) : darken(base, 0.12)));
      }
      // Guijarros ocasionales.
      if (rnd(x, y, 231) > 0.78) {
        const rx = ox + 3 + Math.floor(rnd(x, y, 232) * 9);
        const ry = oy + 4 + Math.floor(rnd(x, y, 233) * 8);
        px(g, rx, ry, 2, 1, css(P.stone));
        px(g, rx, ry + 1, 2, 1, css(P.stoneShade));
      }
      return;
    }

    if (terrain === 'shelter') {
      const base = mix(P.shelterGround, P.soilDark, moisture * 0.35);
      px(g, ox, oy, ART, ART, css(base));
      // Suelo pisado: anillo de tierra más clara.
      ellipse(g, ox + 8, oy + 9, 7, 5, css(lighten(base, 0.1)));
      for (let i = 0; i < 10; i++) {
        const rx = ox + Math.floor(rnd(x, y, 260 + i) * ART);
        const ry = oy + Math.floor(rnd(x, y, 300 + i) * ART);
        px(g, rx, ry, 1, 1, css(darken(base, 0.12)));
      }
      return;
    }

    // Pradera: de salvia pálida (poca vegetación) a musgo luminoso (mucha).
    const base = tile?.biome === 'wetland' ? mix(rgb(132, 157, 108), rgb(69, 111, 86), veg * .8) : tile?.biome === 'forest' ? mix(P.sageLow, P.mossHigh, veg * .93) : mix(P.sageLow, P.mossHigh, veg * .72);
    const damp = mix(base, darken(base, 0.1), moisture * 0.35);
    px(g, ox, oy, ART, ART, css(damp));
    const blades = 3 + Math.round(veg * 3);
    for (let i = 0; i < blades; i++) {
      const rx = ox + Math.floor(rnd(x, y, 340 + i) * ART);
      const ry = oy + Math.floor(rnd(x, y, 400 + i) * ART);
      const r = rnd(x, y, 460 + i);
      if (r > 0.62) {
        px(g, rx, ry, 1, 2, css(mix(P.grassLight, damp, 0.72)));
      } else if (r > 0.3) {
        px(g, rx, ry, 2, 1, css(mix(P.grassDark, damp, 0.72)));
      } else {
        px(g, rx, ry, 1, 1, css(lighten(damp, 0.08)));
      }
    }
    // Florecillas: raras, y sólo donde hay musgo vivo.
    if (veg > 0.45 && rnd(x, y, 521) > 0.86) {
      const fx = ox + 2 + Math.floor(rnd(x, y, 522) * 12);
      const fy = oy + 2 + Math.floor(rnd(x, y, 523) * 12);
      px(g, fx, fy, 1, 1, css(rnd(x, y, 524) > 0.5 ? P.paper : lighten(P.amber, 0.4)));
    }
  }

  /** Resource art follows server stock/growth. Depleted resources do not remain lush props. */
  private bakeFeatures(g: CanvasRenderingContext2D, tile: Tile): void {
    const { x, y } = tile, ox = x * ART, oy = y * ART;
    const growth = clamp01(tile.growth ?? tile.vegetation);
    if (tile.terrain === 'water') { this.drawReeds(g, x, y, ox, oy, 0); return; }
    const traffic = clamp01(tile.traffic ?? 0);
    if (traffic > .12) {
      for (let i = 0; i < 5; i++) px(g, ox + 1 + i*3, oy + 8 + Math.round(Math.sin(i + (tile.variety ?? 0)) * 2), 3, Math.max(1, Math.round(traffic * 4)), css(P.soilLight, .25 + traffic * .5));
    }
    const cultivation = clamp01(tile.cultivation ?? 0);
    if (cultivation > .08) {
      for (let row = 0; row < 3; row++) {
        px(g, ox+2, oy+5+row*3, 12, 2, css(P.soilDark, .7));
        for (let plant = 0; plant < 4; plant++) if (growth > .15) px(g, ox+3+plant*3, oy+4+row*3, 1, 1 + Math.round(growth*2), css(mix(P.reed, P.grassLight, cultivation)));
      }
    }
    const water = clamp01(tile.drinkingWater ?? 0);
    const reservoir = tile.feature === 'spring' || tile.feature === 'pool';
    if (water > .04 && (reservoir || tile.biome === 'wetland' || tile.moisture > .65)) {
      ellipse(g, ox+10, oy+11, 2 + water*3, 1+water*2, css(P.soilDark));
      ellipse(g, ox+10, oy+10, 1 + water*3, .5+water*2, css(P.waterShallow));
      px(g, ox+9, oy+9, Math.max(1,Math.round(water*3)), 1, css(P.waterGleam, .65));
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
      const h = 3 + Math.round(growth*8), color = css(mix(P.canopyDark,P.reed,growth));
      px(g,ox+7,oy+12-h,3,h,color); px(g,ox+4,oy+7,4,2,color); px(g,ox+4,oy+4,2,4,color);
      px(g,ox+9,oy+9,4,2,color); px(g,ox+11,oy+6,2,4,color); px(g,ox+8,oy+13-h,1,h-2,css(P.reedLight));
      if (tile.food > .3) px(g,ox+7,oy+11-h,2,1,css(P.berryLight));
    } else if (feature === 'rock' || feature === 'clay') {
      const stock = feature === 'rock' ? (tile.stone ?? 0) : (tile.fertility ?? .6) * 8;
      if (stock > .2) {
        const size = Math.min(5, 2 + stock / 3), color = feature === 'clay' ? rgb(185,118,88) : P.stone;
        ellipse(g,ox+8,oy+12,size+1,2,css(P.shadow,.2)); ellipse(g,ox+8,oy+9,size,size*.7,css(darken(color,.2)));
        ellipse(g,ox+7,oy+8,size*.8,size*.5,css(color)); px(g,ox+6,oy+6,3,1,css(lighten(color,.2)));
      }
    } else if (feature === 'reeds') {
      for(let i=0;i<4;i++){ const h = 2+Math.round(growth*5); px(g,ox+3+i*3,oy+12-h,1,h,css(P.reed));px(g,ox+3+i*3,oy+10-h,1,2,css(P.reedLight)); }
    } else if (feature === 'flowers') {
      for(let i=0;i<3+Math.round(growth*4);i++){const fx=ox+2+Math.floor(rnd(x,y,1800+i)*12),fy=oy+3+Math.floor(rnd(x,y,1850+i)*10); px(g,fx,fy,1,2,css(P.reed));px(g,fx-1,fy-1,3,1,css(i%2?P.paper:P.berryLight));px(g,fx,fy-2,1,3,css(i%2?P.amber:P.coral));}
    }
    if (feature === 'berries' || (!feature && tile.food > .3)) this.drawBerries(g,x,y,ox,oy,tile.food,0);
    if ((tile.life ?? 0) > .45 && tile.vegetation > .25) {
      for(let i=0;i<3;i++) px(g, ox+2+Math.floor(rnd(x,y,1900+i)*12), oy+2+Math.floor(rnd(x,y,1920+i)*12), 1, 1, css(P.grassLight,.8));
    }
  }

  /** Orillas arenosas por adyacencia: la arena se pinta en el borde que da al agua. */
  private bakeCoast(g: CanvasRenderingContext2D, x: number, y: number): void {
    const here = this.terrainAt(x, y);
    const ox = x * ART;
    const oy = y * ART;

    if (here === 'water') {
      // Bajío luminoso mirando a la tierra.
      const gleam = css(mix(P.waterShallow, P.waterGleam, 0.35), 0.55);
      if (this.terrainAt(x, y - 1) !== 'water') px(g, ox, oy, ART, 1, gleam);
      if (this.terrainAt(x, y + 1) !== 'water') px(g, ox, oy + ART - 1, ART, 1, gleam);
      if (this.terrainAt(x - 1, y) !== 'water') px(g, ox, oy, 1, ART, gleam);
      if (this.terrainAt(x + 1, y) !== 'water') px(g, ox + ART - 1, oy, 1, ART, gleam);
      return;
    }

    const sand = css(P.sand);
    const sandEdge = css(P.sandDark);
    const north = this.terrainAt(x, y - 1) === 'water';
    const south = this.terrainAt(x, y + 1) === 'water';
    const west = this.terrainAt(x - 1, y) === 'water';
    const east = this.terrainAt(x + 1, y) === 'water';

    for (let i = 0; i < ART; i++) {
      const j = 2 + Math.floor(rnd(x * 31 + i, y, 610) * 3); // borde irregular, no una regla
      if (north) {
        px(g, ox + i, oy, 1, j, sand);
        px(g, ox + i, oy + j - 1, 1, 1, sandEdge);
      }
      if (south) {
        px(g, ox + i, oy + ART - j, 1, j, sand);
        px(g, ox + i, oy + ART - j, 1, 1, sandEdge);
      }
      if (west) {
        px(g, ox, oy + i, j, 1, sand);
        px(g, ox + j - 1, oy + i, 1, 1, sandEdge);
      }
      if (east) {
        px(g, ox + ART - j, oy + i, j, 1, sand);
        px(g, ox + ART - j, oy + i, 1, 1, sandEdge);
      }
    }
    // Esquinas diagonales, para que la playa no tenga muescas.
    if (!north && !west && this.terrainAt(x - 1, y - 1) === 'water') px(g, ox, oy, 3, 3, sand);
    if (!north && !east && this.terrainAt(x + 1, y - 1) === 'water') px(g, ox + ART - 3, oy, 3, 3, sand);
    if (!south && !west && this.terrainAt(x - 1, y + 1) === 'water') px(g, ox, oy + ART - 3, 3, 3, sand);
    if (!south && !east && this.terrainAt(x + 1, y + 1) === 'water') px(g, ox + ART - 3, oy + ART - 3, 3, 3, sand);
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
    const person = this.curr?.people.find(p => p.role === 'S');
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

  private interpolatePeople(now: number): RenderPerson[] {
    const world = this.curr;
    if (!world) return [];
    const alpha = this.prev && !this.reduceMotion ? clamp01((now - this.currAt) / this.interval) : 1;
    const out: RenderPerson[] = [];
    for (const p of world.people) {
      const before = this.prevPeople.get(p.id);
      let x = p.x;
      let y = p.y;
      let moving = false;
      if (before) {
        const dx = p.x - before.x;
        const dy = p.y - before.y;
        moving = dx * dx + dy * dy > 0.0004 && alpha < 1;
        x = before.x + dx * alpha;
        y = before.y + dy * alpha;
      }
      out.push({
        view: p,
        x,
        y,
        moving,
        seed: hash3(p.id.length, p.id.charCodeAt(0) | 0, p.id.charCodeAt(p.id.length - 1) | 0) % 4096,
      });
    }
    return out;
  }

  private interpolateAnimals(now: number): RenderAnimal[] {
    const alpha = this.prev && !this.reduceMotion ? clamp01((now - this.currAt) / this.interval) : 1;
    return (this.curr?.animals ?? []).map(view => {
      const before = this.prevAnimals.get(view.id);
      const dx = before ? view.x - before.x : 0, dy = before ? view.y - before.y : 0;
      return { view, x: before ? before.x + dx * alpha : view.x, y: before ? before.y + dy * alpha : view.y,
        moving: !!before && (dx !== 0 || dy !== 0) && alpha < 1, left: dx < 0 };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Bucle de dibujo                                                  */
  /* ---------------------------------------------------------------- */

  private frame(now: number): void {
    if (this.destroyed) return;
    this.tickFocus(now);
    if (this.followedId) {
      const person = (this.followedKind === 'animal' ? this.interpolateAnimals(now) : this.interpolatePeople(now)).find(p => p.view.id === this.followedId);
      if (person) { this.cam.x = person.x + 0.5; this.cam.y = person.y + 0.5; }
    }
    this.reportViewport();
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
    const accelerated = this.gpu.render(this.chunks, { ...this.cam, width: this.cssW, height: this.cssH, dpr: this.dpr });
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
      const alpha = this.prev && !this.reduceMotion ? clamp01((now - this.currAt) / this.interval) : 1;
      const light = daylightAt(this.prev ? this.prev.tick + (world.tick - this.prev.tick) * alpha : world.tick);
      if (world.weather === 'rain') light.shadowAlpha *= .4;
      this.lighting = light;
      const people = this.interpolatePeople(now);
      const animals = this.interpolateAnimals(now);
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

      this.drawAmbient(world, cw, ch, now, light);
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
    const y0 = Math.max(this.originY, Math.floor(this.cam.y - halfH) - 2);
    const y1 = Math.min(this.originY + this.worldH - 1, Math.ceil(this.cam.y + halfH) + 2);

    // Pixel-art decoration needs only eight poses/s. Moving people retain full RAF interpolation.
    // With reduced motion, a stationary snapshot costs one cached scene composite per frame.
    const pose = people.some(person => person.moving) || animals.some(animal => animal.moving) ? t : this.reduceMotion ? 0 : Math.floor(t * 8);
    const sceneKey = `${this.sceneRevision}:${this.layer}:${x0}:${x1}:${y0}:${y1}:${pose}`;
    if (sceneKey === this.sceneKey) return;
    this.sceneKey = sceneKey;
    g.clearRect(0, 0, this.scene.width, this.scene.height);
    g.save(); g.translate(-this.originX * ART, -this.originY * ART);

    const sprites: Sprite[] = [];
    this.effects.water = this.effects.vegetation = this.effects.shadows = 0;
    this.visibleTiles = 0;
    this.visibleAnimals = 0; this.visibleStructures = 0;
    const structuredTiles = new Set((world.structures ?? []).map(s => `${s.x},${s.y}`));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const tile = this.tileAt(x, y);
        if (!tile) continue;
        this.visibleTiles++;
        const ox = x * ART;
        const oy = y * ART;

        if (tile.terrain === 'water') {
          if (rnd(x, y, 712) > .6 && this.effects.water < VISUAL_BUDGET.water) { this.drawRipples(g, x, y, ox, oy, t); this.effects.water++; }
        } else {
          if ((tile.feature === 'pool' || tile.feature === 'spring') && (tile.drinkingWater ?? 0) > .04 && this.effects.water < VISUAL_BUDGET.water) {
            const shift = this.reduceMotion ? 0 : Math.floor(t * 2 + rnd(x, y, 917) * 4) % 3;
            px(g, ox + 8 + shift, oy + 10, 2, 1, css(P.waterGleam, .55)); this.effects.water++;
          }
          if (tile.feature === 'reeds' || tile.feature === 'flowers') this.drawPlantMovement(g, tile, t);
          if (tile.terrain === 'shelter' && !structuredTiles.has(`${x},${y}`)) {
            sprites.push({
              kind: SpriteKind.Hut,
              sortY: oy + 13,
              ax: ox + 8,
              ay: oy + 13,
              seed: hash3(x, y, 900),
              size: 0,
              person: null,
            });
          } else if (!structuredTiles.has(`${x},${y}`)) {
            this.collectTrees(sprites, x, y, ox, oy, clamp01(tile.vegetation));
          }
        }
        if (world.animals === undefined && tile.species && (tile.fauna ?? 0) > .04) sprites.push({kind: SpriteKind.Fauna, sortY: oy + 11, ax: ox + 8, ay: oy + 11, seed: 0, size: 0, person: null, tile});
      }
    }

    this.drawPlaces(g, world.places, x0, x1, y0, y1);

    for (const structure of world.structures ?? []) {
      if (structure.x < x0 || structure.x > x1 || structure.y < y0 || structure.y > y1) continue;
      this.visibleStructures++;
      sprites.push({ kind: SpriteKind.Structure, sortY: structure.y * ART + 13, ax: structure.x * ART + 8, ay: structure.y * ART + 13, seed: 0, size: 0, person: null, structure });
    }
    for (const animal of animals) {
      if (animal.x < x0 || animal.x > x1 || animal.y < y0 || animal.y > y1) continue;
      this.visibleAnimals++;
      sprites.push({ kind: SpriteKind.Animal, sortY: animal.y * ART + 12, ax: animal.x * ART + 8, ay: animal.y * ART + 12, seed: 0, size: 0, person: null, animal });
    }

    for (const p of people) {
      if (p.x < x0 - 2 || p.x > x1 + 2 || p.y < y0 - 2 || p.y > y1 + 2) continue;
      const ax = p.x * ART + ART / 2;
      const ay = p.y * ART + ART / 2 + 4;
      sprites.push({ kind: SpriteKind.Person, sortY: ay, ax, ay, seed: p.seed, size: 0, person: p });
    }

    // Y-sort: quien está más al sur tapa a quien está al norte.
    sprites.sort((a, b) => a.sortY - b.sortY);
    if (this.cam.zoom >= 18) {
      for (const sprite of sprites) if (this.effects.shadows < VISUAL_BUDGET.shadows && (sprite.kind === SpriteKind.Structure || sprite.kind === SpriteKind.Person)) this.drawCastShadow(g, sprite);
      for (const sprite of sprites) if (this.effects.shadows < VISUAL_BUDGET.shadows && sprite.kind === SpriteKind.Tree && sprite.seed % 13 === 0) this.drawCastShadow(g, sprite);
    }
    for (const s of sprites) {
      if (s.kind === SpriteKind.Tree) this.drawCachedTree(g, s, t);
      else if (s.kind === SpriteKind.Hut) this.drawHut(g, s.ax, s.ay, s.seed);
      else if (s.animal) this.drawAnimal(g, s.animal, t);
      else if (s.structure) this.drawStructure(g, s.structure);
      else if (s.tile) this.drawFauna(g, s.tile, t);
      else if (s.person) this.drawPerson(g, s.person, t);
    }
    // Data stays visible over canopy, with people badges preserved above it.
    if (this.layer !== 'none') {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const tile = this.tileAt(x, y);
        if (tile) this.drawLayerCell(g, tile, x * ART, y * ART);
      }
    }
    g.restore();
  }

  /* -------------------------- decorado vivo ------------------------ */

  private drawCastShadow(g: CanvasRenderingContext2D, sprite: Sprite): void {
    const height = sprite.kind === SpriteKind.Tree ? 1 + sprite.size : sprite.kind === SpriteKind.Structure ? 1.5 : .65;
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
    const pose = animalPose(animal.view, animal.moving, t + hash3(animal.view.id.length, animal.view.id.charCodeAt(animal.view.id.length-1), 48) % 13, this.reduceMotion, this.actionActive);
    const key = `animal:${animal.view.species}:${animal.view.action}:${pose}`;
    let art = this.spriteCache.get(key);
    if (!art) { art = document.createElement('canvas'); art.width = art.height = 32; paintAnimal(art.getContext('2d')!, animal.view.species, animal.view.action, pose); this.spriteCache.set(key, art); this.spriteBuilds++; }
    g.save(); g.translate(Math.round(animal.x * ART + 8), Math.round(animal.y * ART + 12)); if (animal.left) g.scale(-1, 1);
    g.drawImage(art, -16, -26); g.restore(); this.drawCalls++;
  }

  private drawStructure(g: CanvasRenderingContext2D, structure: StructureView): void {
    const key = `structure:${structure.components.join(',')}:${structure.condition < .3 ? 0 : structure.condition < .65 ? 1 : 2}:${Math.ceil(structure.water * 8)}:${Math.ceil(structure.food * 8)}`;
    let art = this.spriteCache.get(key);
    if (!art) { art = document.createElement('canvas'); art.width = art.height = 32; paintStructure(art.getContext('2d')!, structure); this.spriteCache.set(key, art); this.spriteBuilds++; }
    g.drawImage(art, Math.round(structure.x * ART + 8) - 16, Math.round(structure.y * ART + 13) - 29); this.drawCalls++;
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

  private collectTrees(sprites: Sprite[], x: number, y: number, ox: number, oy: number, veg: number): void {
    const tile = this.tileAt(x,y);
    const feature = tile?.feature;
    if (feature && feature !== 'tree' && feature !== 'pine' && feature !== 'palm') return;
    if (!feature && (veg < .42 || rnd(x, y, 1090) > veg*.62)) return;
    if (feature && (tile?.wood ?? 1) <= .05) return;
    const growth = clamp01(tile?.growth ?? veg);
    const count = growth > .9 && (tile?.variety ?? 0) % 5 === 0 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const jx = ox + 3 + Math.floor(rnd(x, y, 1100 + i) * (ART - 6));
      const jy = oy + 6 + Math.floor(rnd(x, y, 1140 + i) * (ART - 7));
      const size = clamp(growth * .8 + rnd(x, y, 1180 + i) * .2, .1, 1);
      sprites.push({
        kind: SpriteKind.Tree,
        sortY: jy,
        ax: jx,
        ay: jy,
        seed: hash3(x * 7 + i, y, 1220),
        size,
        person: null,
        feature,
      });
    }
  }

  private drawCachedTree(g: CanvasRenderingContext2D, sprite: Sprite, t: number): void {
    const seed = sprite.seed % 6, size = Math.round(sprite.size * 3) / 3;
    const moving = !this.reduceMotion && sprite.seed % 11 === 0 && this.effects.vegetation < VISUAL_BUDGET.vegetation;
    if (moving) this.effects.vegetation++;
    const pose = moving ? Math.round((Math.sin(t * .65 + sprite.ax * .013 + sprite.ay * .007) + 1)) : 1;
    const feature = sprite.feature ?? 'tree';
    const key = `tree:${feature}:${seed}:${size}:${pose}`;
    let art = this.spriteCache.get(key);
    if (!art) {
      art = document.createElement('canvas'); art.width = art.height = 32;
      const pen = art.getContext('2d')!;
      if (feature === 'pine') {
        const height = 8+Math.round(size*12), half = 3+Math.round(size*4);
        ellipse(pen,16,28,half,2,css(P.shadow,.22)); px(pen,15,23,2,4,css(P.trunk));
        for(let row=0;row<height;row++){
          const radius=Math.max(1,Math.round(row/height*half)), inset = row % 6 === 5 ? 1 : 0;
          px(pen,16-radius+inset+(pose-1),26-height+row,(radius-inset)*2,1,css(P.canopyDark));
          px(pen,16-radius+inset+(pose-1),26-height+row,Math.max(1,radius-1),1,css(row < height * .6 ? P.canopyMid : mix(P.canopyDark,P.canopyMid,.65)));
        }
        px(pen,15+(pose-1),26-height,1,3,css(P.canopyLight));
      } else if (feature === 'palm') {
        const height = 5+Math.round(size*8), top = 26-height;
        ellipse(pen,16,28,5,2,css(P.shadow,.2)); px(pen,15,top,2,height,css(P.trunkLight));
        for(let side=-1;side<=1;side+=2) for(let step=0;step<6;step++) px(pen,16+side*step+(pose-1),top-2+Math.floor(step*step/10),3,2,css(step%2?P.canopyMid:P.canopyLight));
        px(pen,15,top-5,2,5,css(P.canopyMid));
      } else this.drawTree(pen,16+(pose-1)*.5,27,seed,size,0);
      this.spriteCache.set(key, art); this.spriteBuilds++;
    }
    g.drawImage(art, Math.round(sprite.ax)-16, Math.round(sprite.ay)-27); this.drawCalls++;
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

  /** Copa por capas: base oscura, cuerpo medio, luz alta y motas — nunca un círculo plano. */
  private drawTree(g: CanvasRenderingContext2D, ax: number, ay: number, seed: number, size: number, t: number): void {
    const r = 3.2 + size * 4.2;
    const trunkH = Math.round(3 + size * 4);
    const sway = this.reduceMotion ? 0 : Math.sin(t * 0.7 + (seed % 100) / 16) * (0.5 + size * 0.7);
    const sage = (seed & 7) === 0; // algún árbol de hoja salvia rompe el verde

    ellipse(g, ax, ay + 1, r * 0.85, r * 0.32, css(P.shadow, 0.22));
    px(g, ax - 1, ay - trunkH, 2, trunkH, css(P.trunk));
    px(g, ax, ay - trunkH, 1, trunkH, css(P.trunkLight));

    const cy = ay - trunkH - r * 0.55;
    const cx = ax + sway;
    const dark = sage ? mix(P.canopyDark, P.canopySage, 0.3) : P.canopyDark;
    const mid = sage ? P.canopySage : P.canopyMid;
    const light = sage ? lighten(P.canopySage, 0.2) : P.canopyLight;

    ellipse(g, cx, cy + r * .28, r, r * .76, css(dark));
    ellipse(g, cx - r * .25, cy, r * .75, r * .64, css(mid));
    ellipse(g, cx + r * .34, cy - r * .14, r * .57, r * .65, css(mid));
    ellipse(g, cx - r * .16, cy - r * .49, r * .57, r * .5, css(light));
    ellipse(g, cx - r * .54, cy - r * .2, r * .35, r * .35, css(mix(light,mid,.25)));
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
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * 6.283 + (hash3(px0, py0, 1400) % 100) / 100;
        const sx = Math.round(cx + Math.cos(a) * 6);
        const sy = Math.round(cy + Math.sin(a) * 4);
        px(g, sx, sy, 2, 1, css(lively ? lighten(P.stone, 0.12) : P.stone, 0.85));
        px(g, sx, sy + 1, 2, 1, css(P.stoneShade, 0.7));
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
    const ax = Math.round(p.x * ART + ART / 2);
    const ay = Math.round(p.y * ART + ART / 2 + 4) - (resting ? 0 : 0);

    const fallback = view.role === 'I' ? P.coral : view.role === 'S' ? P.neutralCloth : P.neutralCloth;
    const given = parseColor(view.color, fallback);
    const body =
      view.role === 'I' ? P.coral : view.role === 'S' ? mix(given, P.paper, 0.18) : mix(given, P.neutralCloth, 0.45);
    const bodyDark = darken(body, 0.24);
    const legs = darken(body, 0.4);

    // Balanceo de paso: sólo si el servidor la movió de verdad.
    const step = !this.reduceMotion && p.moving ? (Math.floor(t * 6 + p.seed) & 1) : 0;
    const bob = resting ? 0 : step === 1 ? -1 : 0;
    const baseY = resting ? ay + 2 : ay;

    ellipse(g, ax, baseY + 1, 4, 1.6, css(P.shadow, 0.28));
    const community = this.curr?.communities?.find(group => group.id === view.communityId);
    if (community) ellipse(g,ax,baseY+2,5,1.1,css(parseColor(community.color,P.amber),.8));

    if (resting) {
      px(g, ax - 4, baseY - 3, 8, 3, css(bodyDark));
      px(g, ax - 3, baseY - 6, 6, 4, css(body));
    } else {
      px(g, ax - 2, baseY - 3 + (step === 1 ? 0 : 0), 2, 3, css(legs));
      px(g, ax, baseY - 3, 2, 3 - step, css(legs));
      px(g, ax - 3, baseY - 8, 6, 5, css(body));
      px(g, ax - 3, baseY - 4, 6, 1, css(bodyDark));
      px(g, ax - 4, baseY - 8 + bob, 1, 3, css(bodyDark));
      px(g, ax + 3, baseY - 8 - bob, 1, 3, css(bodyDark));
    }

    const headTop = (resting ? baseY - 10 : baseY - 12) + bob;
    px(g, ax - 2, headTop, 4, 4, css(P.skin));
    px(g, ax - 2, headTop - 1, 4, 2, css(P.hair));
    px(g, ax - 3, headTop, 1, 2, css(P.hair));
    px(g, ax + 2, headTop, 1, 2, css(P.hair));
    px(g, ax - 1, headTop + 2, 1, 1, css(darken(P.hair, 0.2), 0.75));
    px(g, ax + 1, headTop + 2, 1, 1, css(darken(P.hair, 0.2), 0.75));

    if (view.role === 'S') {
      // Bufanda ámbar, con la cola al viento.
      const neck = headTop + 4;
      px(g, ax - 4, neck, 8, 2, css(P.amber));
      px(g, ax - 4, neck + 1, 8, 1, css(P.amberDeep));
      const tail = this.reduceMotion || !p.moving ? 0 : step;
      px(g, ax + 3 + tail, neck + 1, 2, 4, css(P.amber));
      px(g, ax + 3 + tail, neck + 4, 2, 1, css(P.amberDeep));
    } else if (view.role === 'I') {
      // Túnica coral con vuelo y capucha.
      px(g, ax - 4, baseY - 9, 8, 7, css(P.coral));
      px(g, ax - 5, baseY - 3, 10, 2, css(P.coral));
      px(g, ax - 5, baseY - 2, 10, 1, css(P.coralDeep));
      px(g, ax - 3, headTop - 2, 6, 3, css(P.coral));
      px(g, ax - 3, headTop - 2, 6, 1, css(lighten(P.coral, 0.2)));
      px(g, ax - 2, headTop, 4, 3, css(P.skin));
      px(g, ax - 1, headTop + 1, 1, 1, css(darken(P.hair, 0.2), 0.75));
      px(g, ax + 1, headTop + 1, 1, 1, css(darken(P.hair, 0.2), 0.75));
    } else {
      // Vecindario: tres prendas apagadas, siempre la misma para la misma persona.
      const variant = p.seed % 3;
      if (variant === 0) px(g, ax - 3, baseY - 5, 6, 2, css(lighten(body, 0.22)));
      else if (variant === 1) px(g, ax - 3, headTop - 1, 6, 1, css(darken(body, 0.15)));
      else px(g, ax - 4, baseY - 8, 8, 2, css(darken(body, 0.3)));
    }
    const atTarget = view.target ? Math.hypot(view.x - view.target.x, view.y - view.target.y) < .5 : false;
    const product = this.carriedProducts.get(view.id);
    if (product) {
      // One carried-object symbol per owner, present only while a real material batch exists.
      const x = ax - 7, y = baseY - 5;
      if (product === 'material') { px(g,x,y,4,3,css(P.stoneShade));px(g,x,y,3,1,css(P.stone)); }
      else if (product === 'storage') { px(g,x,y,4,4,css(P.soil)); px(g,x+1,y-1,2,1,css(P.soilLight)); }
      else if (product === 'insulation' || product === 'binding') { px(g,x,y,4,3,css(P.sand));px(g,x+1,y,1,4,css(P.trunkLight)); }
      else { px(g,x+1,y-3,1,7,css(P.trunkLight));px(g,x,y-4,product === 'cutting'?2:4,3,css(P.stone));px(g,x,y-4,1,2,css(P.paper)); }
    }
    const working = view.working === true || (view.working === undefined && atTarget);
    const previous = this.prevPeople.get(view.id);
    const consuming = view.action === 'drink' ? previous?.thirst !== undefined && view.thirst !== undefined && previous.thirst > view.thirst
      : view.action === 'eat' && previous !== undefined && previous.hunger > view.hunger;
    const beat = !this.reduceMotion && this.actionActive && !p.moving && (working || consuming) ? Math.floor(t * 3 + p.seed) % 2 : 0;
    if (view.action === 'hunt') { px(g,ax+5+beat,baseY-13+beat*3,1,13,css(P.trunkLight));px(g,ax+4+beat,baseY-15+beat*3,3,3,css(P.stone)); }
    else if (view.action === 'drink') { const lift = p.moving ? 4 : beat; px(g,ax+3,headTop+3+lift,3,3,css(P.waterGleam));px(g,ax+3,headTop+5+lift,3,1,css(P.water)); }
    else if (view.action === 'eat') { px(g,ax+3,headTop+4+beat,2,2,css(P.amber)); px(g,ax+2,headTop+5+beat,2,1,css(P.skin)); }
    else if (view.action === 'forage') {
      // Reach toward the ground only during confirmed work; the pouch fills only from received stock.
      const reach = beat * 3;
      px(g,ax+3+reach,baseY-6+beat*3,3,1,css(P.skin));
      px(g,ax+3,baseY-3,4,3,css(P.trunkLight)); px(g,ax+3,baseY-1,4,1,css(P.soil));
      px(g,ax+4,baseY-4,2,1,css(P.soil));
      if ((view.foodReserve ?? 0) > 0) { px(g,ax+4,baseY-3,2,1,css(P.amber)); px(g,ax+5,baseY-4,1,1,css(P.grassLight)); }
    }
    else if (view.action === 'build' || view.action === 'repair' || view.action === 'invent' || view.action === 'research' || view.action === 'craft') {
      const hand = baseY - 6 - beat * 4; px(g,ax+3,hand,3,1,css(P.skin));
      px(g,ax+6,hand-3,1,5,css(P.trunkLight)); px(g,ax+5,hand-4,4,2,css(P.stone));
    } else if (view.action === 'farm' || view.action === 'gather') {
      const hand = baseY - 6 + beat * 2; px(g,ax+3,hand,3,1,css(P.skin));
      px(g,ax+6,hand-1,1,7,css(P.trunkLight)); px(g,ax+6,hand+5,4,1,css(P.stoneShade));
    }
    else if (view.action === 'cooperate' || view.action === 'share') { px(g,ax+3,baseY-6,4,4,css(P.soil));px(g,ax+3,baseY-7,4,1,css(P.grassLight)); }
    if (working && view.workProgress !== undefined && view.workProgress > 0 && this.cam.zoom >= 18) {
      px(g,ax-5,baseY+4,10,2,css(P.ink,.65)); px(g,ax-5,baseY+4,Math.max(1,Math.round(clamp01(view.workProgress)*10)),1,css(P.amber));
    }
  }

  /* ------------------------ capas de pantalla ---------------------- */

  private drawAmbient(world: WorldView, cw: number, ch: number, now: number, tint: { color: string; alpha: number }): void {
    const ctx = this.labelCtx;
    const key = `${tint.color}:${tint.alpha.toFixed(3)}:${world.weather}:${this.reduceMotion}`;
    if (key !== this.ambientKey) {
      this.ambientKey = key;
      this.phaseLayer.style.transition = this.reduceMotion ? 'none' : 'background-color 1600ms linear, opacity 1600ms linear';
      this.rainLayer.style.transition = this.reduceMotion ? 'none' : 'opacity 1000ms linear';
      this.phaseLayer.style.backgroundColor = tint.color; this.phaseLayer.style.opacity = String(tint.alpha);
      this.rainLayer.style.backgroundColor = RAIN_TINT.color; this.rainLayer.style.opacity = world.weather === 'rain' ? String(RAIN_TINT.alpha) : '0';
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
    this.drawRain(world, now);
    this.drawEventAccents(now);
  }

  private drawRain(world: WorldView, now: number): void {
    this.effects.rain = 0;
    if (world.weather !== 'rain') return;
    const g = this.labelCtx, count = Math.min(VISUAL_BUDGET.rain, Math.ceil(this.cssW * this.cssH / 12500));
    const time = this.reduceMotion ? 0 : Math.floor(now / 85) * .085;
    g.save(); g.scale(this.dpr, this.dpr); g.strokeStyle = 'rgba(211,232,223,.30)'; g.lineWidth = 1; g.beginPath();
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
      g.strokeStyle = `rgba(239,208,136,${(1 - progress) * .8})`; g.lineWidth = 1.5; g.beginPath();
      g.ellipse(screen.x, screen.y, radius, radius * .46, 0, 0, Math.PI * 2); g.stroke();
      // Four small marks read as an acknowledgement, not sparks, births or physical light.
      g.fillStyle = `rgba(249,231,181,${1 - progress})`;
      for (const side of [-1, 1]) g.fillRect(screen.x + side * radius - 1, screen.y - radius * .5 - 3, 2, 3);
      this.effects.events++;
    }
    g.restore();
  }

  /** Selección e insignias: en píxeles de pantalla, para que el texto no se pixele. */
  private drawOverlaysScreen(people: RenderPerson[], animals: RenderAnimal[]): void {
    const ctx = this.labelCtx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (this.pendingTarget) {
      const mark = this.worldToScreen(this.pendingTarget.x + .5, this.pendingTarget.y + .5);
      ctx.strokeStyle = '#f4d18b'; ctx.fillStyle = '#ddb25533'; ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.arc(mark.x, mark.y, Math.max(9, this.cam.zoom * .42), 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      this.drawChip(mark.x, mark.y - 23, 'Pendiente', P.ink, P.amber, 'meta');
    }

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
        const s = this.curr?.people.find((p) => p.role === 'S');
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

    const tx = Math.floor(w.x);
    const ty = Math.floor(w.y);
    if (!this.tileAt(tx, ty)) return;
    this.selection = { kind: 'tile', x: tx, y: ty };
    this.onSelect(this.selection);
  }
}
