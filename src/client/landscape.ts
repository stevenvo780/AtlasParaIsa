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
import type { PersonView, PlaceView, Terrain, Tile, Viewport, WorldView } from '../shared/types.js';

/* ------------------------------------------------------------------ */
/* Tipos públicos                                                      */
/* ------------------------------------------------------------------ */

export type OverlayLayer = 'none' | 'moisture' | 'food';

export type Selection =
  | { kind: 'person'; id: string }
  | { kind: 'tile'; x: number; y: number };

export type LandscapeSelection = Selection;

export type SelectHandler = (selection: LandscapeSelection) => void;

/* ------------------------------------------------------------------ */
/* Constantes de arte                                                  */
/* ------------------------------------------------------------------ */

/** Píxeles de arte por tile: la resolución nativa del pixel-art. */
const ART = 16;
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

const PHASE_TINT: Record<WorldView['phase'], Tint> = {
  dawn: { color: 'rgb(255,201,163)', alpha: 0.3 },
  day: { color: 'rgb(255,252,242)', alpha: 0.0 },
  dusk: { color: 'rgb(242,158,120)', alpha: 0.34 },
  night: { color: 'rgb(92,108,176)', alpha: 0.42 },
};

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

const enum SpriteKind {
  Tree = 0,
  Hut = 1,
  Person = 2,
}

interface Sprite {
  kind: SpriteKind;
  sortY: number;
  ax: number;
  ay: number;
  seed: number;
  size: number;
  person: RenderPerson | null;
}

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

  /** Suelo horneado (terreno + costa + textura) a resolución de arte. */
  private ground: HTMLCanvasElement;
  private groundCtx: CanvasRenderingContext2D;
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
  private groundSignature = -1;
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

  constructor(canvas: HTMLCanvasElement, onSelect: SelectHandler, private readonly onViewport?: (viewport: Viewport) => void, private readonly onManualCamera?: () => void) {
    this.canvas = canvas;
    this.onSelect = onSelect;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Landscape: este navegador no expone un contexto 2D.');
    this.ctx = ctx;

    this.ground = document.createElement('canvas');
    const gc = this.ground.getContext('2d');
    if (!gc) throw new Error('Landscape: no se pudo crear el lienzo del suelo.');
    this.groundCtx = gc;

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
      'Mundo vivo. Arrastra o usa las flechas para recorrer, más y menos para acercar, Inicio para volver. También puedes seleccionar habitantes desde el panel Población.',
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
      if (this.curr && world.tick > this.curr.tick) {
        for (const p of this.curr.people) this.prevPeople.set(p.id, p);
        this.interval = clamp(now - this.currAt, 60, 2000);
      }
      this.prev = this.curr && world.tick > this.curr.tick ? this.curr : null;
      this.prevAt = this.currAt;
      this.currAt = now;
    }
    this.curr = world;

    this.rebuildGrid(world);
    const sig = this.signature(world);
    if (sig !== this.groundSignature) {
      this.groundSignature = sig;
      this.bakeGround();
    }

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

  follow(id: string | null): void { this.followedId = id; }

  setPendingTarget(position: { x: number; y: number } | null): void { this.pendingTarget = position; }

  camera(): { x: number; y: number; zoom: number } { return { ...this.cam }; }

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
      this.ground.width = Math.max(1, w * ART);
      this.ground.height = Math.max(1, h * ART);
      this.scene.width = this.ground.width;
      this.scene.height = this.ground.height;
      this.groundCtx.imageSmoothingEnabled = false;
      this.sceneCtx.imageSmoothingEnabled = false;
      this.groundBaked = false;
      this.groundSignature = -1;
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

  private signature(world: WorldView): number {
    let h = 2166136261;
    const acc = (v: number): void => {
      h = Math.imul(h ^ (v | 0), 16777619) >>> 0;
    };
    acc(world.width);
    acc(world.height);
    acc(world.originX ?? 0);
    acc(world.originY ?? 0);
    for (const t of world.tiles) {
      acc(t.x);
      acc(t.y);
      acc(t.terrain.charCodeAt(0));
      acc(Math.round(clamp01(t.moisture) * 12));
      acc(Math.round(clamp01(t.vegetation) * 12));
    }
    return h;
  }

  /* ---------------------------------------------------------------- */
  /* Horneado del suelo                                               */
  /* ---------------------------------------------------------------- */

  private bakeGround(): void {
    if (this.worldW === 0 || this.worldH === 0) return;
    const g = this.groundCtx;
    g.clearRect(0, 0, this.ground.width, this.ground.height);
    g.save();
    g.translate(-this.originX * ART, -this.originY * ART);

    for (let y = this.originY; y < this.originY + this.worldH; y++) {
      for (let x = this.originX; x < this.originX + this.worldW; x++) {
        this.bakeTileBase(g, x, y);
      }
    }
    for (let y = this.originY; y < this.originY + this.worldH; y++) {
      for (let x = this.originX; x < this.originX + this.worldW; x++) {
        this.bakeCoast(g, x, y);
      }
    }
    g.restore();
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
      for (let i = 0; i < 6; i++) {
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
      for (let i = 0; i < 14; i++) {
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
    const blades = 10 + Math.round(veg * 10);
    for (let i = 0; i < blades; i++) {
      const rx = ox + Math.floor(rnd(x, y, 340 + i) * ART);
      const ry = oy + Math.floor(rnd(x, y, 400 + i) * ART);
      const r = rnd(x, y, 460 + i);
      if (r > 0.62) {
        px(g, rx, ry, 1, 2, css(mix(P.grassLight, damp, 0.35)));
      } else if (r > 0.3) {
        px(g, rx, ry, 1, 1, css(mix(P.grassDark, damp, 0.4)));
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

  /* ---------------------------------------------------------------- */
  /* Bucle de dibujo                                                  */
  /* ---------------------------------------------------------------- */

  private frame(now: number): void {
    if (this.destroyed) return;
    this.tickFocus(now);
    if (this.followedId) {
      const person = this.interpolatePeople(now).find(p => p.view.id === this.followedId);
      if (person) { this.cam.x = person.x + 0.5; this.cam.y = person.y + 0.5; }
    }
    this.reportViewport();
    this.render(now);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private render(now: number): void {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw === 0 || ch === 0) return;

    // Neutral fog means this part of the projection has not arrived. It is never invented sea.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#425f50';
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = 'rgba(203,220,175,.035)';
    for (let y = 0; y < ch; y += Math.max(6, Math.round(9 * this.dpr))) {
      ctx.fillRect(0, y, cw, Math.max(1, Math.round(this.dpr)));
    }

    const world = this.curr;
    if (world && this.groundBaked && this.worldW > 0) {
      const t = now / 1000;
      const people = this.interpolatePeople(now);
      this.drawScene(world, people, t);

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

      this.drawAmbient(world, cw, ch);
      this.drawOverlaysScreen(people);
    }
  }

  private drawScene(world: WorldView, people: RenderPerson[], t: number): void {
    const g = this.sceneCtx;
    g.clearRect(0, 0, this.scene.width, this.scene.height);
    g.drawImage(this.ground, 0, 0);
    g.save();
    g.translate(-this.originX * ART, -this.originY * ART);

    // Ventana visible en tiles (con holgura para copas altas).
    const halfW = this.cssW / this.cam.zoom / 2;
    const halfH = this.cssH / this.cam.zoom / 2;
    const x0 = Math.max(this.originX, Math.floor(this.cam.x - halfW) - 1);
    const x1 = Math.min(this.originX + this.worldW - 1, Math.ceil(this.cam.x + halfW) + 1);
    const y0 = Math.max(this.originY, Math.floor(this.cam.y - halfH) - 2);
    const y1 = Math.min(this.originY + this.worldH - 1, Math.ceil(this.cam.y + halfH) + 2);

    const sprites: Sprite[] = [];

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const tile = this.tileAt(x, y);
        if (!tile) continue;
        const ox = x * ART;
        const oy = y * ART;

        if (tile.terrain === 'water') {
          this.drawRipples(g, x, y, ox, oy, t);
          this.drawReeds(g, x, y, ox, oy, t);
        } else {
          this.drawBerries(g, x, y, ox, oy, tile.food, t);
          if ((tile.stone ?? 0) > 0.25 && rnd(x, y, 1700) < Math.min(.85, (tile.stone ?? 0) / 12)) {
            const rx = ox + 4 + Math.floor(rnd(x, y, 1701) * 7), ry = oy + 9;
            const size = tile.biome === 'mountain' ? 5 : 3;
            ellipse(g, rx + 1, ry + 2, size + 1, size * .4, css(P.shadow, .2));
            ellipse(g, rx, ry - 1, size, size * .75, css(P.stoneShade));
            ellipse(g, rx - 1, ry - 2, size * .8, size * .6, css(P.stone));
            px(g, rx - 2, ry - 4, 3, 1, css(lighten(P.stone, .22)));
          }
          if (tile.terrain === 'shelter') {
            sprites.push({
              kind: SpriteKind.Hut,
              sortY: oy + 13,
              ax: ox + 8,
              ay: oy + 13,
              seed: hash3(x, y, 900),
              size: 0,
              person: null,
            });
          } else {
            this.collectTrees(sprites, x, y, ox, oy, clamp01(tile.vegetation));
          }
        }
      }
    }

    this.drawPlaces(g, world.places, x0, x1, y0, y1);

    for (const p of people) {
      if (p.x < x0 - 2 || p.x > x1 + 2 || p.y < y0 - 2 || p.y > y1 + 2) continue;
      const ax = p.x * ART + ART / 2;
      const ay = p.y * ART + ART / 2 + 4;
      sprites.push({ kind: SpriteKind.Person, sortY: ay, ax, ay, seed: p.seed, size: 0, person: p });
    }

    // Y-sort: quien está más al sur tapa a quien está al norte.
    sprites.sort((a, b) => a.sortY - b.sortY);
    for (const s of sprites) {
      if (s.kind === SpriteKind.Tree) this.drawTree(g, s.ax, s.ay, s.seed, s.size, t);
      else if (s.kind === SpriteKind.Hut) this.drawHut(g, s.ax, s.ay, s.seed, world.phase);
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

  private drawRipples(g: CanvasRenderingContext2D, x: number, y: number, ox: number, oy: number, t: number): void {
    const gleam = css(P.waterGleam, 0.4);
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
    if (veg < 0.42 || rnd(x, y, 1090) > veg * 0.62) return;
    const count = veg > 0.84 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const jx = ox + 3 + Math.floor(rnd(x, y, 1100 + i) * (ART - 6));
      const jy = oy + 6 + Math.floor(rnd(x, y, 1140 + i) * (ART - 7));
      const size = clamp(veg * 0.7 + rnd(x, y, 1180 + i) * 0.4, 0.3, 1);
      sprites.push({
        kind: SpriteKind.Tree,
        sortY: jy,
        ax: jx,
        ay: jy,
        seed: hash3(x * 7 + i, y, 1220),
        size,
        person: null,
      });
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

    ellipse(g, cx, cy + r * 0.28, r, r * 0.72, css(dark));
    ellipse(g, cx - r * 0.18, cy, r * 0.92, r * 0.68, css(mid));
    ellipse(g, cx - r * 0.34, cy - r * 0.3, r * 0.5, r * 0.36, css(light));
    for (let i = 0; i < 4; i++) {
      const a = rnd(seed, i, 1300) * 6.283;
      const d = r * (0.45 + rnd(seed, i, 1340) * 0.45);
      px(g, Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d * 0.7), 1, 1, css(light, 0.8));
    }
  }

  private drawHut(g: CanvasRenderingContext2D, ax: number, ay: number, seed: number, phase: WorldView['phase']): void {
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
    if (phase === 'night' || phase === 'dusk') {
      px(g, dx, ay - 2, 3, 2, css(P.hutGlow, phase === 'night' ? 0.85 : 0.45));
    }
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
      const tail = this.reduceMotion ? 0 : Math.round(Math.sin(t * 2.3 + p.seed) * 1.4);
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
  }

  /* ------------------------ capas de pantalla ---------------------- */

  private drawAmbient(world: WorldView, cw: number, ch: number): void {
    const ctx = this.ctx;
    const tint = PHASE_TINT[world.phase];
    if (tint.alpha > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = tint.alpha;
      ctx.fillStyle = tint.color;
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
    }
    if (world.weather === 'rain') {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = RAIN_TINT.alpha;
      ctx.fillStyle = RAIN_TINT.color;
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
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
  }

  /** Selección e insignias: en píxeles de pantalla, para que el texto no se pixele. */
  private drawOverlaysScreen(people: RenderPerson[]): void {
    const ctx = this.ctx;
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
    ctx.restore();
  }

  private drawChip(cx: number, cy: number, text: string, ink: RGB, accent: RGB, style: 'serif' | 'meta'): void {
    const ctx = this.ctx;
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

    let best: PersonView | null = null;
    let bestD = PERSON_HIT * PERSON_HIT;
    for (const p of this.interpolatePeople(performance.now())) {
      const dx = p.x + 0.5 - w.x;
      const dy = p.y + 0.5 - w.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = p.view;
      }
    }

    if (best) {
      this.selection = { kind: 'person', id: best.id };
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
