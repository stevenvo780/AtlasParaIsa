/**
 * Una carta para Isa — paneles flotantes arrastrables y redimensionables (V24).
 *
 * `clampPanelRect` es puro y se prueba sin DOM. `makeFloatingPanel` convierte un panel ya existente
 * (Mundo, Vidas, Inspector, Crónica, Ajustes…) en una ventana que se mueve por la cabecera y cambia de
 * tamaño desde una esquina, recuerda su sitio en `localStorage` (`carta.panel.<id>`) y pasa al frente
 * al tocarla. Nunca lanza: sin almacenamiento, sin `setPointerCapture` o sin ventana, degrada a no hacer nada.
 *
 * En pantallas estrechas (< 760 px) los paneles son hojas inferiores del CSS existente: no se tocan.
 */

export interface PanelRect { x: number; y: number; width: number; height: number }
export interface PanelViewport { width: number; height: number }

export interface FloatingPanelOptions {
  id: string;
  /** Selector de la zona de arrastre dentro del panel. Por defecto `.drawer-head, header, h2`. */
  handleSelector?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  defaultRect?: Partial<PanelRect>;
  minWidth?: number;
  minHeight?: number;
}

export interface FloatingPanel {
  /** Olvida la posición guardada y devuelve el panel a su sitio de CSS. */
  reset(): void;
  bringToFront(): void;
  getRect(): PanelRect;
  destroy(): void;
}

export const PANEL_MIN_WIDTH = 280;
export const PANEL_MIN_HEIGHT = 220;
export const PANEL_BASE_Z_INDEX = 40;
export const PANEL_STORAGE_PREFIX = 'carta.panel.';
/** Por debajo de este ancho el CSS convierte los paneles en hojas inferiores. */
export const PANEL_MOBILE_MAX_WIDTH = 760;
export const DEFAULT_HANDLE_SELECTOR = '.drawer-head, header, h2';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const INTERACTIVE = 'button, input, select, textarea, a, label, summary, [role="button"], [contenteditable="true"]';

/**
 * Ajusta un rectángulo al viewport: tamaño entre `minW`/`minH` y el viewport, y posición que nunca deja
 * el panel (ni su cabecera) fuera de pantalla. Valores no finitos caen al mínimo / al origen.
 */
export function clampPanelRect(rect: PanelRect, viewport: PanelViewport, minW = PANEL_MIN_WIDTH, minH = PANEL_MIN_HEIGHT): PanelRect {
  const vw = finite(viewport.width) ? Math.max(0, viewport.width) : 0;
  const vh = finite(viewport.height) ? Math.max(0, viewport.height) : 0;
  const width = Math.round(Math.min(Math.max(finite(rect.width) ? rect.width : minW, minW), vw));
  const height = Math.round(Math.min(Math.max(finite(rect.height) ? rect.height : minH, minH), vh));
  const x = Math.round(Math.min(Math.max(finite(rect.x) ? rect.x : 0, 0), Math.max(0, vw - width)));
  const y = Math.round(Math.min(Math.max(finite(rect.y) ? rect.y : 0, 0), Math.max(0, vh - height)));
  return { x, y, width, height };
}

/** Lee `{x,y,width,height}` guardado; `null` si falta, está corrupto o el almacenamiento falla. */
export function parseStoredRect(raw: string | null | undefined): PanelRect | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { x, y, width, height } = value as Record<string, unknown>;
    return finite(x) && finite(y) && finite(width) && finite(height) && width > 0 && height > 0 ? { x, y, width, height } : null;
  } catch { return null; }
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

let zCounter = PANEL_BASE_Z_INDEX;
const STYLE_ID = 'panel-manager-style';
const STYLE = `.panel-floating{position:absolute;max-height:none;transform:none;right:auto;bottom:auto}`
  + `.panel-floating.panel-dragging{user-select:none;-webkit-user-select:none}`
  + `.panel-drag-handle{cursor:grab;touch-action:none}.panel-dragging .panel-drag-handle{cursor:grabbing}`
  + `.panel-resize-handle{position:sticky;display:block;float:right;clear:both;bottom:2px;right:2px;width:18px;height:18px;margin:-18px 0 0 auto;cursor:nwse-resize;touch-action:none;z-index:2;`
  + `background:linear-gradient(135deg,transparent 0 50%,#8a9c76 50% 58%,transparent 58% 70%,#8a9c76 70% 78%,transparent 78%);border-radius:0 0 8px 0;opacity:.8}`
  + `.panel-resize-handle:hover{opacity:1}`;

function injectStyle(doc: Document | undefined): void {
  try {
    if (!doc?.head || doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.appendChild(style);
  } catch { /* sin DOM completo: el panel funciona igual con estilos en línea */ }
}

type Gesture = { kind: 'move' | 'resize'; pointerId: number; startX: number; startY: number; origin: PanelRect };
const STYLE_KEYS = ['position', 'left', 'top', 'width', 'height', 'maxHeight', 'right', 'bottom', 'transform'] as const;

export function makeFloatingPanel(panel: HTMLElement, options: FloatingPanelOptions): FloatingPanel {
  const minW = options.minWidth ?? PANEL_MIN_WIDTH, minH = options.minHeight ?? PANEL_MIN_HEIGHT;
  const storage = options.storage ?? defaultStorage();
  const storageKey = PANEL_STORAGE_PREFIX + options.id;
  const doc = panel.ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
  const win = doc?.defaultView ?? (typeof window === 'undefined' ? null : window);
  const viewport = (): PanelViewport => ({ width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 });
  const isMobile = (): boolean => viewport().width > 0 && viewport().width < PANEL_MOBILE_MAX_WIDTH;

  injectStyle(doc);

  let rect: PanelRect | null = null;
  let gesture: Gesture | null = null;
  let destroyed = false;
  let active: HTMLElement | null = null;
  const cleanups: (() => void)[] = [];
  const on = (target: EventTarget | null | undefined, type: string, handler: (event: any) => void, capture = false): void => {
    if (!target) return;
    target.addEventListener(type, handler, capture);
    cleanups.push(() => target.removeEventListener(type, handler, capture));
  };

  /** Origen del bloque contenedor: las coordenadas del panel son relativas a él, las del puntero al viewport. */
  const origin = (): { x: number; y: number } => {
    try { const parent = panel.offsetParent as HTMLElement | null; const box = parent?.getBoundingClientRect(); return box ? { x: box.left, y: box.top } : { x: 0, y: 0 }; }
    catch { return { x: 0, y: 0 }; }
  };

  const measure = (): PanelRect => {
    let box: DOMRect | null = null;
    try { box = panel.getBoundingClientRect(); } catch { box = null; }
    const o = origin();
    const d = options.defaultRect ?? {};
    const visible = !!box && box.width > 0 && box.height > 0;
    return {
      x: d.x ?? (visible ? box!.left - o.x : 16), y: d.y ?? (visible ? box!.top - o.y : 96),
      width: d.width ?? (visible ? box!.width : Math.max(minW, 360)), height: d.height ?? (visible ? box!.height : Math.max(minH, 420)),
    };
  };

  const apply = (next: PanelRect): void => {
    rect = next;
    const s = panel.style;
    panel.classList?.add('panel-floating');
    s.position = 'absolute'; s.maxHeight = 'none'; s.right = 'auto'; s.bottom = 'auto'; s.transform = 'none';
    s.left = `${next.x}px`; s.top = `${next.y}px`; s.width = `${next.width}px`; s.height = `${next.height}px`;
  };

  const persist = (): void => {
    if (!rect) return;
    try { storage?.setItem(storageKey, JSON.stringify(rect)); } catch { /* cuota o modo privado: se sigue sin recordar */ }
  };

  const bringToFront = (): void => { if (!destroyed) panel.style.zIndex = String(++zCounter); };

  const handles = (): HTMLElement | null => {
    try { return panel.querySelector<HTMLElement>(options.handleSelector ?? DEFAULT_HANDLE_SELECTOR); } catch { return null; }
  };

  const fit = (next: PanelRect): PanelRect => clampPanelRect(next, viewport(), minW, minH);

  // Restaura: lo guardado manda; si no, `defaultRect` (solo si se pidió); si no, el CSS decide.
  let stored: PanelRect | null = null;
  try { stored = parseStoredRect(storage?.getItem(storageKey)); } catch { stored = null; }
  if (!isMobile()) {
    if (stored) apply(fit(stored));
    else if (options.defaultRect) apply(fit(measure()));
  }

  const handle = handles();
  handle?.classList?.add('panel-drag-handle');
  const grip = doc?.createElement('div') ?? null;
  if (grip) {
    grip.className = 'panel-resize-handle';
    grip.setAttribute('aria-hidden', 'true');
    grip.title = 'Arrastra para cambiar el tamaño';
    panel.appendChild(grip);
  }

  const begin = (kind: Gesture['kind'], event: PointerEvent, target: HTMLElement | null): void => {
    if (destroyed || isMobile() || (event.button ?? 0) !== 0) return;
    const target0 = event.target as Partial<Element> | null;
    if (kind === 'move' && typeof target0?.closest === 'function' && target0.closest(INTERACTIVE)) return;
    const origin0 = rect ?? fit(measure());
    gesture = { kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: origin0 };
    active = target;
    try { target?.setPointerCapture?.(event.pointerId); } catch { /* el puntero ya terminó */ }
    panel.classList?.add('panel-dragging');
    apply(origin0);
    bringToFront();
    event.preventDefault?.();
  };

  const move = (event: PointerEvent): void => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY, o = gesture.origin;
    apply(fit(gesture.kind === 'move' ? { ...o, x: o.x + dx, y: o.y + dy } : { ...o, width: o.width + dx, height: o.height + dy }));
  };

  const end = (event: PointerEvent): void => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    try { active?.releasePointerCapture?.(gesture.pointerId); } catch { /* ya liberado */ }
    gesture = null; active = null;
    panel.classList?.remove('panel-dragging');
    persist();
  };

  on(handle, 'pointerdown', (event: PointerEvent) => begin('move', event, handle));
  on(grip, 'pointerdown', (event: PointerEvent) => begin('resize', event, grip));
  for (const target of [handle, grip]) { on(target, 'pointermove', move); on(target, 'pointerup', end); on(target, 'pointercancel', end); }
  on(panel, 'pointerdown', () => bringToFront(), true);
  on(panel, 'focusin', () => bringToFront());
  on(win, 'resize', () => { if (rect && !isMobile()) { const next = fit(rect); if (next.x !== rect.x || next.y !== rect.y || next.width !== rect.width || next.height !== rect.height) apply(next); } });

  const clearStyles = (): void => {
    for (const key of STYLE_KEYS) panel.style[key] = '';
    panel.classList?.remove('panel-floating', 'panel-dragging');
  };

  return {
    reset(): void {
      if (destroyed) return;
      gesture = null; rect = null;
      clearStyles();
      // `storage` solo exige getItem/setItem: si no hay removeItem, un valor vacío cuenta como «sin guardar».
      try { const remove = (storage as Partial<Storage> | undefined)?.removeItem; if (remove) remove.call(storage, storageKey); else storage?.setItem(storageKey, ''); } catch { /* sin almacenamiento */ }
    },
    bringToFront,
    getRect(): PanelRect { return rect ? { ...rect } : fit(measure()); },
    destroy(): void {
      if (destroyed) return;
      destroyed = true; gesture = null;
      for (const cleanup of cleanups.splice(0)) cleanup();
      handle?.classList?.remove('panel-drag-handle');
      try { grip?.remove(); } catch { /* ya fuera */ }
      clearStyles();
      panel.style.zIndex = '';
    },
  };
}
