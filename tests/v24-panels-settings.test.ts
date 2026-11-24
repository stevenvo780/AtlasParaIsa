import test from 'node:test';
import assert from 'node:assert/strict';
import { clampPanelRect, makeFloatingPanel, parseStoredRect, type PanelRect } from '../src/client/panel-manager.js';
import {
  PRESET_SETTINGS, applyPreset, loadGraphicsSettings, renderGraphicsSettingsHtml, sanitizeGraphicsSettings, saveGraphicsSettings,
  type GraphicsSettings,
} from '../src/client/graphics-settings.js';
import {
  MAP_LAYER_CATALOG, activeLayersSummary, clearLayers, renderLayersPopoverHtml, toggleLayer, type MapLayerId,
} from '../src/client/layers-control.js';

// ───────────────────────── panel-manager: función pura ─────────────────────────

const VP = { width: 1280, height: 720 };

test('clampPanelRect deja intacto un rectángulo válido', () => {
  assert.deepEqual(clampPanelRect({ x: 100, y: 80, width: 400, height: 300 }, VP), { x: 100, y: 80, width: 400, height: 300 });
});

test('clampPanelRect mantiene el panel dentro del viewport', () => {
  assert.deepEqual(clampPanelRect({ x: -50, y: -9, width: 400, height: 300 }, VP), { x: 0, y: 0, width: 400, height: 300 });
  assert.deepEqual(clampPanelRect({ x: 1200, y: 700, width: 400, height: 300 }, VP), { x: 880, y: 420, width: 400, height: 300 });
});

test('clampPanelRect aplica mínimos y recorta lo que excede el viewport', () => {
  assert.deepEqual(clampPanelRect({ x: 0, y: 0, width: 10, height: 10 }, VP), { x: 0, y: 0, width: 280, height: 220 });
  assert.deepEqual(clampPanelRect({ x: 0, y: 0, width: 10, height: 10 }, VP, 300, 250), { x: 0, y: 0, width: 300, height: 250 });
  assert.deepEqual(clampPanelRect({ x: 50, y: 50, width: 5000, height: 5000 }, VP), { x: 0, y: 0, width: 1280, height: 720 });
});

test('clampPanelRect con viewport menor que el mínimo nunca saca el panel de pantalla', () => {
  const r = clampPanelRect({ x: 10, y: 10, width: 400, height: 400 }, { width: 200, height: 150 });
  assert.deepEqual(r, { x: 0, y: 0, width: 200, height: 150 });
});

test('clampPanelRect trata NaN/Infinity sin lanzar ni devolver NaN', () => {
  const r = clampPanelRect({ x: NaN, y: Infinity, width: NaN, height: -Infinity }, VP);
  for (const value of Object.values(r)) assert.ok(Number.isFinite(value));
  assert.equal(r.width, 280); assert.equal(r.height, 220); assert.equal(r.x, 0);
  assert.deepEqual(clampPanelRect({ x: 0, y: 0, width: 300, height: 300 }, { width: NaN, height: NaN }), { x: 0, y: 0, width: 0, height: 0 });
});

test('clampPanelRect es idempotente y no muta la entrada', () => {
  const input: PanelRect = { x: 2000, y: -4, width: 33, height: 9000 };
  const frozen = Object.freeze({ ...input });
  const once = clampPanelRect(frozen, VP);
  assert.deepEqual(clampPanelRect(once, VP), once);
  assert.deepEqual(input, { x: 2000, y: -4, width: 33, height: 9000 });
});

test('parseStoredRect rechaza JSON corrupto, incompleto o no finito', () => {
  assert.deepEqual(parseStoredRect('{"x":1,"y":2,"width":300,"height":250}'), { x: 1, y: 2, width: 300, height: 250 });
  for (const bad of [null, undefined, '', 'no-json', '[]', 'null', '{"x":1}', '{"x":"1","y":2,"width":3,"height":4}', '{"x":1,"y":2,"width":0,"height":4}', '{"x":1,"y":2,"width":3,"height":null}']) {
    assert.equal(parseStoredRect(bad as string | null | undefined), null, String(bad));
  }
});

// ───────────────────────── panel-manager: DOM simulado ─────────────────────────

type Handler = (event: any) => void;
class FakeNode {
  style: Record<string, string> = {};
  className = '';
  title = '';
  id = '';
  textContent = '';
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<Handler>>();
  captured = new Set<number>();
  classSet = new Set<string>();
  ownerDocument: FakeDoc;
  box = { left: 100, top: 50, width: 400, height: 300 };
  offsetParent: FakeNode | null = null;
  classList = { add: (...n: string[]) => n.forEach(x => this.classSet.add(x)), remove: (...n: string[]) => n.forEach(x => this.classSet.delete(x)), contains: (n: string) => this.classSet.has(n) };
  constructor(doc: FakeDoc) { this.ownerDocument = doc; }
  addEventListener(type: string, handler: Handler): void { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(handler); }
  removeEventListener(type: string, handler: Handler): void { this.listeners.get(type)?.delete(handler); }
  emit(type: string, event: Record<string, unknown> = {}): { prevented: boolean } {
    const state = { prevented: false };
    const e = { target: this, pointerId: 1, button: 0, clientX: 0, clientY: 0, preventDefault: () => { state.prevented = true; }, ...event };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(e);
    return state;
  }
  count(): number { let n = 0; for (const set of this.listeners.values()) n += set.size; return n; }
  appendChild(child: FakeNode): FakeNode { child.parent = this; this.children.push(child); return child; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getBoundingClientRect(): any { const b = this.box; return { left: b.left, top: b.top, width: b.width, height: b.height, right: b.left + b.width, bottom: b.top + b.height }; }
  setPointerCapture(id: number): void { this.captured.add(id); }
  releasePointerCapture(id: number): void { this.captured.delete(id); }
  interactive = false;
  closest(selector: string): FakeNode | null { return this.interactive && selector.includes('button') ? this : null; }
  querySelector(selector: string): FakeNode | null { return this.children.find(c => selector.split(',').map(s => s.trim()).includes(c.attrs.get('data-sel') ?? '')) ?? null; }
}
class FakeDoc {
  head = new FakeNode(this);
  defaultView: FakeWin;
  constructor(win: FakeWin) { this.defaultView = win; }
  createElement(): FakeNode { return new FakeNode(this); }
  getElementById(id: string): FakeNode | null { return this.head.children.find(c => c.id === id) ?? null; }
}
class FakeWin extends FakeNode { innerWidth = 1280; innerHeight = 720; constructor() { super(null as unknown as FakeDoc); } }

function setup(opts: { storage?: any; defaultRect?: Partial<PanelRect>; viewport?: [number, number]; id?: string } = {}) {
  const win = new FakeWin();
  if (opts.viewport) [win.innerWidth, win.innerHeight] = opts.viewport;
  const doc = new FakeDoc(win);
  const panel = new FakeNode(doc);
  const head = new FakeNode(doc); head.attrs.set('data-sel', '.drawer-head');
  const button = new FakeNode(doc); button.interactive = true; head.appendChild(button);
  panel.appendChild(head);
  const mem = new Map<string, string>();
  const storage = opts.storage ?? { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
  const fp = makeFloatingPanel(panel as unknown as HTMLElement, { id: opts.id ?? 'mundo', storage, defaultRect: opts.defaultRect });
  const grip = panel.children.find(c => c.className === 'panel-resize-handle')!;
  return { win, doc, panel, head, button, grip, mem, fp, storage };
}
const px = (value: string | undefined): number => Number.parseFloat(value ?? 'NaN');

test('makeFloatingPanel inyecta un asa de redimensión .panel-resize-handle y el estilo una sola vez', () => {
  const { grip, doc, panel } = setup();
  assert.ok(grip, 'asa creada');
  assert.equal(grip.attrs.get('aria-hidden'), 'true');
  makeFloatingPanel(panel as unknown as HTMLElement, { id: 'otro', storage: { getItem: () => null, setItem: () => {} } });
  assert.equal(doc.head.children.filter(c => c.id === 'panel-manager-style').length, 1);
});

test('sin posición guardada ni defaultRect, el CSS sigue mandando', () => {
  const { panel, fp } = setup();
  assert.equal(panel.style.left, undefined);
  assert.deepEqual(fp.getRect(), { x: 100, y: 50, width: 400, height: 300 });
});

test('arrastrar por la cabecera mueve el panel, lo recorta al viewport y persiste al soltar', () => {
  const { head, panel, mem, fp } = setup();
  head.emit('pointerdown', { clientX: 150, clientY: 60 });
  assert.ok(head.captured.has(1), 'captura de puntero');
  head.emit('pointermove', { clientX: 250, clientY: 160 });
  assert.equal(px(panel.style.left), 200); assert.equal(px(panel.style.top), 150);
  assert.equal(mem.size, 0, 'no persiste a mitad del gesto');
  head.emit('pointermove', { clientX: 99999, clientY: 99999 });
  assert.deepEqual(fp.getRect(), { x: 880, y: 420, width: 400, height: 300 });
  head.emit('pointerup', { clientX: 99999, clientY: 99999 });
  assert.ok(!head.captured.has(1), 'captura liberada');
  assert.deepEqual(JSON.parse(mem.get('carta.panel.mundo')!), { x: 880, y: 420, width: 400, height: 300 });
});

test('un pointerdown sobre un botón de la cabecera no inicia arrastre', () => {
  const { button, head, panel, mem } = setup();
  head.emit('pointerdown', { clientX: 10, clientY: 10, target: button });
  head.emit('pointermove', { clientX: 300, clientY: 300 });
  assert.equal(panel.style.left, undefined);
  assert.equal(mem.size, 0);
});

test('solo el botón principal arrastra, y otro puntero no interfiere', () => {
  const { head, panel } = setup();
  head.emit('pointerdown', { button: 2, clientX: 0, clientY: 0 });
  head.emit('pointermove', { clientX: 90, clientY: 90 });
  assert.equal(panel.style.left, undefined);
  head.emit('pointerdown', { pointerId: 7, clientX: 0, clientY: 0 });
  head.emit('pointermove', { pointerId: 9, clientX: 90, clientY: 90 });
  assert.equal(px(panel.style.left), 100, 'el puntero ajeno no mueve el panel');
});

test('el asa de esquina redimensiona con el mínimo y el viewport como límites', () => {
  const { grip, fp, mem, panel } = setup();
  grip.emit('pointerdown', { clientX: 500, clientY: 350 });
  grip.emit('pointermove', { clientX: 900, clientY: 650 });
  assert.deepEqual(fp.getRect(), { x: 100, y: 50, width: 800, height: 600 });
  grip.emit('pointermove', { clientX: -5000, clientY: -5000 });
  assert.deepEqual(fp.getRect(), { x: 100, y: 50, width: 280, height: 220 });
  grip.emit('pointermove', { clientX: 99999, clientY: 99999 });
  const r = fp.getRect();
  assert.equal(r.x, 0, 'al crecer más allá del borde, el panel se desplaza para caber');
  assert.equal(r.width, 1280);
  grip.emit('pointerup', {});
  assert.deepEqual(JSON.parse(mem.get('carta.panel.mundo')!), r);
  assert.equal(panel.style.maxHeight, 'none');
});

test('restaura la posición guardada, recortada al viewport actual', () => {
  const storage = { getItem: () => JSON.stringify({ x: 2000, y: 2000, width: 600, height: 400 }), setItem: () => {} };
  const { panel } = setup({ storage });
  assert.equal(px(panel.style.left), 680); assert.equal(px(panel.style.top), 320);
  assert.equal(px(panel.style.width), 600); assert.equal(px(panel.style.height), 400);
  assert.ok(panel.classSet.has('panel-floating'));
});

test('un valor guardado corrupto se ignora', () => {
  const { panel } = setup({ storage: { getItem: () => '{"x":"mal"', setItem: () => {} } });
  assert.equal(panel.style.left, undefined);
});

test('defaultRect parcial se completa con la medición del panel', () => {
  const { panel } = setup({ defaultRect: { width: 700 } });
  assert.equal(px(panel.style.width), 700); assert.equal(px(panel.style.left), 100); assert.equal(px(panel.style.height), 300);
});

test('al cambiar el tamaño de la ventana el panel se reajusta y no sale de pantalla', () => {
  const { win, panel, fp } = setup({ storage: { getItem: () => JSON.stringify({ x: 800, y: 400, width: 400, height: 300 }), setItem: () => {} } });
  win.innerWidth = 900; win.innerHeight = 500;
  win.emit('resize');
  assert.deepEqual(fp.getRect(), { x: 500, y: 200, width: 400, height: 300 });
  assert.equal(px(panel.style.left), 500);
});

test('en pantallas estrechas (hoja inferior) no se aplica ni se arrastra', () => {
  const { panel, head } = setup({ viewport: [500, 800], storage: { getItem: () => JSON.stringify({ x: 5, y: 5, width: 300, height: 300 }), setItem: () => {} } });
  assert.equal(panel.style.left, undefined);
  head.emit('pointerdown', { clientX: 0, clientY: 0 });
  head.emit('pointermove', { clientX: 50, clientY: 50 });
  assert.equal(panel.style.left, undefined);
});

test('pasa al frente con z-index creciente desde 40', () => {
  const a = setup({ id: 'a' }), b = setup({ id: 'b' });
  a.fp.bringToFront(); b.fp.bringToFront();
  const za = px(a.panel.style.zIndex), zb = px(b.panel.style.zIndex);
  assert.ok(za >= 41 && zb > za);
  a.panel.emit('pointerdown', {});
  assert.ok(px(a.panel.style.zIndex) > zb);
  b.panel.emit('focusin', {});
  assert.ok(px(b.panel.style.zIndex) > px(a.panel.style.zIndex));
});

test('reset devuelve el panel al CSS y olvida lo guardado', () => {
  const { head, panel, mem, fp } = setup();
  head.emit('pointerdown', { clientX: 0, clientY: 0 });
  head.emit('pointermove', { clientX: 20, clientY: 20 });
  head.emit('pointerup', {});
  assert.ok(mem.has('carta.panel.mundo'));
  fp.reset();
  assert.equal(panel.style.left, '');
  assert.equal(panel.style.width, '');
  assert.ok(!panel.classSet.has('panel-floating'));
  assert.equal(mem.has('carta.panel.mundo'), false);
});

test('destroy retira asa, listeners y estilos; es idempotente', () => {
  const { head, grip, panel, win, fp } = setup({ storage: { getItem: () => JSON.stringify({ x: 5, y: 5, width: 300, height: 300 }), setItem: () => {} } });
  fp.bringToFront();
  fp.destroy(); fp.destroy();
  assert.equal(head.count(), 0); assert.equal(grip.count(), 0); assert.equal(panel.count(), 0); assert.equal(win.count(), 0);
  assert.ok(!panel.children.includes(grip));
  assert.equal(panel.style.left, ''); assert.equal(panel.style.zIndex, '');
  fp.bringToFront();
  assert.equal(panel.style.zIndex, '');
});

test('nunca lanza si el almacenamiento falla al leer, escribir o resetear', () => {
  const boom = { getItem: () => { throw new Error('denegado'); }, setItem: () => { throw new Error('cuota'); } };
  const { head, fp } = setup({ storage: boom });
  head.emit('pointerdown', { clientX: 0, clientY: 0 });
  head.emit('pointermove', { clientX: 30, clientY: 30 });
  assert.doesNotThrow(() => head.emit('pointerup', {}));
  assert.doesNotThrow(() => fp.reset());
  assert.doesNotThrow(() => fp.destroy());
});

test('setPointerCapture que lanza no rompe el arrastre', () => {
  const { head, panel } = setup();
  head.setPointerCapture = () => { throw new Error('puntero inválido'); };
  head.emit('pointerdown', { clientX: 0, clientY: 0 });
  head.emit('pointermove', { clientX: 10, clientY: 10 });
  assert.equal(px(panel.style.left), 110);
});

// ───────────────────────── graphics-settings ─────────────────────────

const memStorage = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [['carta.graphics', initial]]);
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
};

test('los tres perfiles son completos, distintos y están dentro de rango', () => {
  assert.deepEqual(Object.keys(PRESET_SETTINGS), ['ultra', 'equilibrado', 'ligero']);
  for (const [name, s] of Object.entries(PRESET_SETTINGS)) {
    assert.equal(s.preset, name);
    assert.ok(s.minZoom >= 4 && s.minZoom <= 16, `${name} minZoom`);
    assert.ok([1, 1.5, 2].includes(s.maxDpr));
    assert.ok(s.soundVolume >= 0 && s.soundVolume <= 1);
    assert.deepEqual(sanitizeGraphicsSettings(s), s, `${name} es estable al sanear`);
  }
  assert.ok(PRESET_SETTINGS.ultra.minZoom < PRESET_SETTINGS.ligero.minZoom, 'ultra se aleja más');
  assert.ok(PRESET_SETTINGS.ultra.maxDpr > PRESET_SETTINGS.ligero.maxDpr);
  assert.equal(PRESET_SETTINGS.ligero.shadows, false);
});

test('sanitizeGraphicsSettings corrige basura, recorta rangos y completa lo que falta', () => {
  assert.deepEqual(sanitizeGraphicsSettings(undefined), PRESET_SETTINGS.equilibrado);
  assert.deepEqual(sanitizeGraphicsSettings('x'), PRESET_SETTINGS.equilibrado);
  assert.deepEqual(sanitizeGraphicsSettings({ preset: 'ligero' }), PRESET_SETTINGS.ligero);
  const s = sanitizeGraphicsSettings({ preset: 'nada', minZoom: 99, maxDpr: 7, soundVolume: -3, shadows: 'si', cutaways: false, extra: 1 });
  assert.equal(s.preset, 'equilibrado'); assert.equal(s.minZoom, 16); assert.equal(s.maxDpr, 2); assert.equal(s.soundVolume, 0);
  assert.equal(s.shadows, PRESET_SETTINGS.equilibrado.shadows, 'booleano inválido cae al perfil');
  assert.equal(s.cutaways, false);
  assert.ok(!('extra' in s));
  assert.equal(sanitizeGraphicsSettings({ minZoom: 1 }).minZoom, 4);
  assert.equal(sanitizeGraphicsSettings({ maxDpr: 1.2 }).maxDpr, 1);
  assert.equal(sanitizeGraphicsSettings({ maxDpr: 1.4 }).maxDpr, 1.5);
  const nan = sanitizeGraphicsSettings({ minZoom: NaN, soundVolume: Infinity, maxDpr: NaN });
  assert.deepEqual(nan, PRESET_SETTINGS.equilibrado);
  assert.equal(sanitizeGraphicsSettings({ soundVolume: 0.4567 }).soundVolume, 0.46);
});

test('applyPreset sustituye los controles pero conserva el volumen y no muta', () => {
  const current: GraphicsSettings = { ...PRESET_SETTINGS.ultra, soundVolume: 0.9, shadows: false };
  const before = { ...current };
  const next = applyPreset('ligero', current);
  assert.deepEqual(next, { ...PRESET_SETTINGS.ligero, soundVolume: 0.9 });
  assert.deepEqual(current, before);
  assert.notEqual(next, PRESET_SETTINGS.ligero);
  next.shadows = true;
  assert.equal(PRESET_SETTINGS.ligero.shadows, false, 'los perfiles no se contaminan');
  assert.equal(applyPreset('inexistente' as never, current).preset, 'equilibrado');
});

test('guardar y cargar ajustes es ida y vuelta; sin datos o corruptos da equilibrado', () => {
  const st = memStorage();
  assert.deepEqual(loadGraphicsSettings(st), PRESET_SETTINGS.equilibrado);
  const custom: GraphicsSettings = { ...PRESET_SETTINGS.ultra, minZoom: 6, waterRipples: false, soundVolume: 0.25 };
  assert.equal(saveGraphicsSettings(st, custom), true);
  assert.deepEqual(loadGraphicsSettings(st), custom);
  assert.deepEqual(loadGraphicsSettings(memStorage('{rota')), PRESET_SETTINGS.equilibrado);
  assert.deepEqual(loadGraphicsSettings(memStorage('{"minZoom":500,"preset":"ultra"}')), { ...PRESET_SETTINGS.ultra, minZoom: 16 });
  saveGraphicsSettings(st, { ...custom, minZoom: 1000 });
  assert.equal(JSON.parse(st.m.get('carta.graphics')!).minZoom, 16, 'se guarda saneado');
});

test('el almacenamiento no disponible nunca lanza', () => {
  const boom = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.deepEqual(loadGraphicsSettings(boom), PRESET_SETTINGS.equilibrado);
  assert.equal(saveGraphicsSettings(boom, PRESET_SETTINGS.ultra), false);
  assert.equal(saveGraphicsSettings(undefined, PRESET_SETTINGS.ultra), false);
});

test('renderGraphicsSettingsHtml muestra perfiles, deslizadores y efectos en español', () => {
  const html = renderGraphicsSettingsHtml(PRESET_SETTINGS.equilibrado);
  for (const text of ['Ultra', 'Equilibrado', 'Ligero', 'Alejamiento máx. de cámara', 'Resolución (DPR)', 'Volumen ambiental', 'Sombras', 'Atmósfera', 'Ondas en el agua', 'Brillo químico']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/type="range"/g) ?? []).length, 2);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 6);
  assert.match(html, /data-preset="equilibrado"[^>]*aria-pressed="true"/);
  assert.match(html, /data-preset="ultra"[^>]*aria-pressed="false"/);
  assert.match(html, /data-setting="shadows" checked/);
  assert.doesNotMatch(html, /data-setting="waterRipples" checked/);
  assert.match(html, /data-setting="soundVolume"[^>]*value="0\.5"/);
  assert.ok(html.includes('50 %'));
});

test('renderGraphicsSettingsHtml es a prueba de XSS aunque los ajustes vengan manipulados', () => {
  const evil = { preset: '"><script>alert(1)</script>', minZoom: '<img onerror=x>', maxDpr: '"><b>', soundVolume: '<svg/onload=1>', shadows: '<i>' } as unknown as GraphicsSettings;
  const html = renderGraphicsSettingsHtml(evil);
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<svg'));
  assert.doesNotMatch(html, /onerror|onload/);
  assert.deepEqual(sanitizeGraphicsSettings(evil), PRESET_SETTINGS.equilibrado);
});

// ───────────────────────── layers-control ─────────────────────────

test('el catálogo tiene las 9 capas en orden, sin duplicados y con metadatos completos', () => {
  assert.deepEqual(MAP_LAYER_CATALOG.map(l => l.id), ['food', 'vegetation', 'water', 'fertility', 'wood', 'moisture', 'geology', 'roads', 'activeRegions']);
  assert.equal(new Set(MAP_LAYER_CATALOG.map(l => l.color)).size, MAP_LAYER_CATALOG.length, 'colores distinguibles');
  for (const l of MAP_LAYER_CATALOG) {
    assert.match(l.color, /^#[0-9a-f]{6}$/i);
    assert.ok(l.label && l.short && l.description.length > 10, l.id);
  }
});

test('legacyCapa enlaza con las capas del sistema anterior (calor + humedad)', async () => {
  const { capasDeCalor } = await import('../src/client/calor.js');
  const legacy = MAP_LAYER_CATALOG.flatMap(l => l.legacyCapa ? [l.legacyCapa] : []);
  for (const capa of [...capasDeCalor, 'humedad']) assert.ok(legacy.includes(capa), `falta ${capa}`);
  assert.equal(new Set(legacy).size, legacy.length);
  assert.equal(MAP_LAYER_CATALOG.find(l => l.id === 'geology')?.legacyCapa, undefined);
});

test('toggleLayer enciende/apaga sin mutar y ignora ids desconocidos', () => {
  const empty: ReadonlySet<MapLayerId> = new Set();
  const one = toggleLayer(empty, 'water');
  assert.deepEqual([...one], ['water']); assert.equal(empty.size, 0);
  const two = toggleLayer(one, 'food');
  assert.deepEqual([...two].sort(), ['food', 'water']); assert.equal(one.size, 1, 'selección múltiple, sin mutar');
  assert.deepEqual([...toggleLayer(two, 'water')], ['food']);
  assert.equal(toggleLayer(one, 'nada' as MapLayerId).size, 1);
  assert.notEqual(toggleLayer(one, 'nada' as MapLayerId), one);
});

test('clearLayers devuelve un conjunto vacío nuevo cada vez', () => {
  const a = clearLayers(), b = clearLayers();
  assert.equal(a.size, 0); assert.notEqual(a, b);
});

test('activeLayersSummary resume en orden de catálogo', () => {
  const s = (...ids: MapLayerId[]) => activeLayersSummary(new Set(ids));
  assert.equal(s(), 'Capas');
  assert.equal(s('water'), 'Agua');
  assert.equal(s('water', 'food'), 'Comida + Agua');
  assert.equal(s('roads', 'water', 'food'), 'Comida + 2 más');
  assert.equal(s(...MAP_LAYER_CATALOG.map(l => l.id)), 'Comida + 8 más');
});

test('renderLayersPopoverHtml lista una casilla por capa con muestra, descripción y «Limpiar capas»', () => {
  const html = renderLayersPopoverHtml(new Set<MapLayerId>(['water', 'roads']));
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 9);
  assert.equal((html.match(/layer-swatch/g) ?? []).length, 9);
  assert.match(html, /data-layer="water" checked/); assert.match(html, /data-layer="roads" checked/);
  assert.doesNotMatch(html, /data-layer="food" checked/);
  for (const l of MAP_LAYER_CATALOG) { assert.ok(html.includes(`background:${l.color}`)); assert.ok(html.includes(l.label)); }
  assert.ok(html.includes('Limpiar capas'));
  assert.doesNotMatch(html, /layers-clear"[^>]*disabled/);
  assert.match(renderLayersPopoverHtml(new Set()), /data-action="clear-layers" disabled/);
});

test('renderLayersPopoverHtml ignora ids inyectados en el conjunto activo', () => {
  const html = renderLayersPopoverHtml(new Set(['"><script>x</script>' as MapLayerId]));
  assert.ok(!html.includes('<script'));
  assert.equal((html.match(/ checked/g) ?? []).length, 0);
});
