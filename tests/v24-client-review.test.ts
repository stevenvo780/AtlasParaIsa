/**
 * V24 — correcciones de la revisión cruzada del cliente: comportamiento real (no solo texto fuente) de las guardas de
 * red, del arranque del sonido, del modo de dibujo y de los tres fallos de Landscape (trozo de suelo, rejilla
 * sobredimensionada y caché de personas saturada).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Landscape } from '../src/client/landscape.js';
import { PRESET_SETTINGS } from '../src/client/graphics-settings.js';
import { fetchJson, modoDeAjustes, validDirectory, validMap, validWhisper, validWhisperResult, validWhispers } from '../src/client/ui-guards.js';
import { SpatialSoundscape } from '../src/client/soundscape.js';
import { telemetryKpis } from '../src/client/telemetry-hud.js';
import { createWorld, projectWorld } from '../src/world/index.js';

const source = (file: string) => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
const noOpContext = (): any => new Proxy({ fillStyle: '', globalAlpha: 1 }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });

const person = { id: 'p1', name: 'Ana', role: 'neighbor', x: 1, y: 2, action: 'gather', age: 3, generation: 1, communityId: null, hunger: 0, energy: 1 };
const directory = { tick: 5, day: 1, totalPeople: 1, totalAnimals: 0, totalTameAnimals: 0, totalStructures: 0, totalPolyominoes: 0, people: [person],
  communities: [{ id: 'c1', name: 'Alba', x: 3, y: 4, color: '#fff', memberCount: 2, cooperation: 0, disputes: 0 }], structures: [{ id: 's1', name: 'Choza', x: 1, y: 1, cells: 1, kilnTier: 0, condition: 1 }],
  herds: [{ species: 'deer', x: 1, y: 1, count: 4, tameCount: 0, avgHabituation: 0 }] };
const whisper = { id: 'w1', createdTick: 1, createdDay: 1, personId: null, intent: 'travel', x: 1, y: 2, note: 'hola', status: 'latent' };
const map = { tick: 1, day: 1, discoveredChunks: 1, activeChunks: 1, bounds: { minCx: 0, maxCx: 1, minCy: 0, maxCy: 1 }, chunks: [{ cx: 0, cy: 0, cells: '0123456789abcdef' }], markers: [{ kind: 'S', id: 's', name: 'S', x: 1, y: 1 }] };

test('guardas: una respuesta válida pasa y cualquier elemento nulo o incompleto se rechaza', () => {
  assert.ok(validDirectory(directory)); assert.ok(validMap(map)); assert.ok(validWhisper(whisper)); assert.ok(validWhispers({ tick: 1, whispers: [whisper] }));
  assert.ok(validWhisperResult({ ok: true, whisper }));
  for (const key of ['people', 'communities', 'structures', 'herds'] as const) {
    assert.ok(!validDirectory({ ...directory, [key]: [null] }), `${key}: [null]`);
    assert.ok(!validDirectory({ ...directory, [key]: [{}] }), `${key}: [{}]`);
    assert.ok(!validDirectory({ ...directory, [key]: 'x' }), `${key}: no es lista`);
  }
  assert.ok(!validDirectory({ ...directory, people: [{ ...person, x: Number.NaN }] }));
  assert.ok(!validDirectory(null) && !validDirectory([]) && !validDirectory('x'));
  assert.ok(!validWhispers({ whispers: [null] }) && !validWhispers({ whispers: [{ ...whisper, x: 'a' }] }) && !validWhispers({ whispers: {} }));
  assert.ok(!validWhisperResult({ ok: true, whisper: null }) && !validWhisperResult(null) && !validWhisperResult({ ok: true }));
  assert.ok(!validMap({ ...map, chunks: [null] }) && !validMap({ ...map, markers: [null] }) && !validMap({ ...map, markers: undefined }) && !validMap({ ...map, bounds: null }));
  assert.ok(!validMap({ ...map, chunks: [{ cx: 0, cy: 0 }] }), 'un trozo sin celdas no llega al minimapa');
});

test('fetchJson: respuestas válidas, errores HTTP, cuerpos rotos o con forma inesperada, tiempo agotado y cancelación', async () => {
  const original = globalThis.fetch;
  const respond = (init: { ok?: boolean; body?: unknown; json?: () => Promise<unknown> }) => (async () => ({ ok: init.ok ?? true, json: init.json ?? (async () => init.body) })) as unknown as typeof fetch;
  const session = new AbortController();
  const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout no mantiene vivo el bucle de eventos de Node
  try {
    globalThis.fetch = respond({ body: directory });
    assert.deepEqual(await fetchJson('/api/directory', session.signal, validDirectory), directory);
    globalThis.fetch = respond({ ok: false, body: directory });
    await assert.rejects(fetchJson('/api/directory', session.signal, validDirectory), /no disponible/);
    globalThis.fetch = respond({ body: { ...directory, people: [null] } });
    await assert.rejects(fetchJson('/api/directory', session.signal, validDirectory), /forma inesperada/);
    globalThis.fetch = respond({ json: async () => { throw new SyntaxError('JSON roto'); } });
    await assert.rejects(fetchJson('/api/directory', session.signal, validDirectory), SyntaxError);
    // Un endpoint colgado se corta por tiempo (la señal llega al fetch) y nunca deja la UI esperando para siempre.
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('abortado'))))) as unknown as typeof fetch;
    await assert.rejects(fetchJson('/api/directory', session.signal, validDirectory, 30), /abortado/);
    const cancelled = fetchJson('/api/directory', session.signal, validDirectory, 60_000); session.abort();
    await assert.rejects(cancelled, /abortado/);
  } finally { globalThis.fetch = original; clearInterval(keepAlive); }
});

test('game.ts usa las guardas reales: sin validadores locales y la confirmación del susurro se valida', () => {
  const code = source('game.ts');
  assert.match(code, /from '\.\/ui-guards\.js'/);
  assert.doesNotMatch(code, /const isArr = /);
  assert.match(code, /uiJson\('\/api\/directory', session, validDirectory\)/);
  assert.match(code, /uiJson\('\/api\/whispers', session, validWhispers\)/);
  assert.match(code, /validWhisperResult\(result\)/);
});

test('el perfil de Ajustes decide el modo: Ultra y Equilibrado salen del modo ligero heredado', () => {
  assert.equal(modoDeAjustes(PRESET_SETTINGS.ultra), 'completo');
  assert.equal(modoDeAjustes(PRESET_SETTINGS.equilibrado), 'completo');
  assert.equal(modoDeAjustes(PRESET_SETTINGS.ligero), 'observador');
  const code = source('game.ts');
  assert.match(code, /const modo = modoDeAjustes\(graphicsSettings\)/);
  assert.doesNotMatch(code, /const modo = decidirModo\(\)/, 'la heurística solo siembra el perfil inicial');
  assert.match(code, /if \(modoDeAjustes\(graphicsSettings\) !== modoActual\) \{ enterWorld\(sessionFlags\); return; \}/, 'cambiar entre Ligero y el resto reconstruye el dibujo');
});

test('Escape, cerrar Susurros, elegir otra cosa o volver a Mapa cancelan la elección de casilla', () => {
  const code = source('game.ts');
  assert.match(code, /if \(name === 'whisper' && !next && pickingWhisper\) setPickingWhisper\(false\)/);
  assert.match(code, /if \(pickingWhisper\) \{ setPickingWhisper\(false\); return; \}/, 'Escape');
  assert.match(code, /control = 'inspect'; if \(pickingWhisper\) setPickingWhisper\(false\); notebook\?\.close\(\)/, 'Mapa');
  assert.match(code, /if \(pickingWhisper\) setPickingWhisper\(false\); \/\/ eligió otra cosa/);
  assert.match(source('world-shell.ts'), /id="pick-hint"[^>]*hidden>Toca una casilla[^<]*Esc cancela/);
});

test('el sonido no abre dos AudioContext con pulsaciones rápidas mientras resume() espera', async () => {
  const created: { closed: boolean; release: () => void }[] = [];
  const createContext = () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const param = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} };
    const node = () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, gain: param, frequency: param, Q: param, pan: param, buffer: null, loop: false, type: '' });
    const ctx = { closed: false, release, currentTime: 0, sampleRate: 8000, destination: {}, resume: () => gate, suspend: async () => {}, close: async () => { ctx.closed = true; },
      createGain: node, createBufferSource: node, createBiquadFilter: node, createOscillator: node, createStereoPanner: node,
      createBuffer: (_c: number, length: number) => ({ getChannelData: () => new Float32Array(length) }) };
    created.push(ctx); return ctx as unknown as AudioContext;
  };
  // Réplica del manejador de game.ts: mientras `soundBusy`, una pulsación no vuelve a llamar a start().
  const audio = new SpatialSoundscape({ createContext });
  let busy = false, enabled = false;
  const click = async (): Promise<void> => {
    if (busy) return;
    if (enabled) { enabled = false; audio.setMuted(true); return; }
    enabled = true; busy = true; audio.setMuted(false);
    try { await audio.start(); } finally { busy = false; }
  };
  const first = click(); void click(); void click(); // activar, desactivar y volver a activar con resume() pendiente
  assert.equal(created.length, 1, 'un solo contexto creado mientras el primero arranca');
  created[0]!.release(); await first;
  assert.ok(audio.active);
  audio.stop(); assert.ok(created.every(ctx => ctx.closed), 'ningún contexto queda abierto');
  const handler = source('game.ts').match(/el\('sound-toggle'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n  \}\);/)![0];
  assert.match(handler, /if \(soundBusy\) return;/); assert.match(handler, /soundBusy = true/); assert.match(handler, /finally \{ if \(session === uiSession\) \{ soundBusy = false;/);
});

test('«Obras» del HUD global no cuenta componentes como edificios', () => {
  const world = projectWorld(createWorld(901));
  const withStats = { ...world, stats: { ...world.stats!, structures: { frame: 4, roof: 4, hearth: 4, cistern: 4 } } };
  const land = telemetryKpis(withStats as typeof world).find(kpi => kpi.nav === 'land')!;
  assert.match(land.summary ?? '', /Obras: 16 componentes globales/);
  assert.doesNotMatch(land.summary ?? '', /Obras 16 globales/);
});

/* ---------------------------- Landscape ---------------------------- */

function harness(extra: Record<string, unknown> = {}): any {
  return Object.assign(Object.create(Landscape.prototype), {
    canvas: { width: 0, height: 0 }, cam: { x: 0, y: 0, zoom: 32 }, cssW: 1920, cssH: 1080, dpr: 1, modo: 'completo',
    graphicsSettings: { ...PRESET_SETTINGS.ultra }, reduceMotion: true, ...extra,
  });
}

test('un trozo de suelo nuevo se dimensiona a 128×128 aunque el lienzo nazca de 300×150', () => {
  const previous = (globalThis as any).document;
  const canvases: { width: number; height: number }[] = [];
  (globalThis as any).document = { createElement: () => { const canvas = { width: 300, height: 150, getContext: () => noOpContext() }; canvases.push(canvas); return canvas; } };
  try {
    const r = harness({ terrainCache: new Map(), perf: { terrainBakes: 0 }, cacheBuilds: 0, chunkSignature: () => 's', tileAt: () => undefined });
    const chunk = r.bakeChunk('0:0', undefined, 1);
    assert.equal(chunk.canvas.width, 128); assert.equal(chunk.canvas.height, 128);
    // Un lienzo con otra medida (p. ej. reutilizado) también se corrige.
    const odd = { key: '1:0', signature: 'x', stamp: 0, revision: 0, canvas: { width: 64, height: 64, getContext: () => noOpContext() }, x: 8, y: 0 };
    assert.equal(r.bakeChunk('1:0', odd, 2).canvas.width, 128);
  } finally { (globalThis as any).document = previous; if (previous === undefined) Reflect.deleteProperty(globalThis, 'document'); }
});

test('al volver a acercar, una rejilla compuesta lejos se recompone a la medida de lo visible', () => {
  let composes = 0;
  const r = harness({ curr: { tiles: [] }, groundBaked: true, tileCache: {}, composeWindow() { composes++; }, measureCoverage() {},
    serverWindow: { x: -1000, y: -1000, w: 2000, h: 2000 }, originX: -368, originY: -208, worldW: 736, worldH: 416, coverageAt: 0, cameraMovedAt: 0, loadingSince: 0 });
  assert.equal(r.lodTier(), 'near');
  r.ensureWindow(1000); assert.equal(composes, 1, 'rejilla de 736×416 con el zoom cercano: se recompone');
  const view = r.visibleBounds();
  const fitted = { originX: view.x0 - 8, originY: view.y0 - 8, worldW: view.x1 - view.x0 + 1 + 16, worldH: view.y1 - view.y0 + 1 + 16 };
  Object.assign(r, fitted); composes = 0;
  r.ensureWindow(1100); assert.equal(composes, 0, 'una rejilla ajustada no se recompone en cada fotograma');
  // Lejos (nivel lejano) la rejilla grande es la esperada y no se toca.
  r.cam.zoom = 4; Object.assign(r, { originX: -400, originY: -250, worldW: 800, worldH: 500 }); composes = 0;
  r.ensureWindow(1200); assert.equal(composes, 0);
});

test('con más personas visibles que la caché, los sprites ya guardados se conservan y el resto se pinta directo', () => {
  const previous = (globalThis as any).document;
  (globalThis as any).document = { createElement: () => ({ width: 0, height: 0, getContext: () => noOpContext() }) };
  try {
    const base = projectWorld(createWorld(527)).people[0]!;
    const r = harness({ curr: { technology: undefined }, tileAt: () => undefined, carriedProducts: new Map(), secondaryProducts: new Map(), carriedWater: new Map(),
      prevPeople: new Map(), craftVisuals: new Map(), communityColors: new Map(), actionActive: false, effects: {}, drawCalls: 0, spriteHits: 0, spriteDirect: 0, spriteFresh: 0,
      perf: { personSpriteBuilds: 0 } });
    let painted = 0; r.paintPerson = () => { painted++; };
    const total = 3500;
    const bodies = Array.from({ length: total }, (_, i) => ({ view: { ...base, id: `n${i}`, action: 'rest' }, x: i % 70, y: Math.floor(i / 70), seed: i, stride: 0, moving: false }));
    const frame = (): void => { for (const body of bodies) r.drawPerson(noOpContext(), body, 0); r.settlePersonSprites(); };
    frame();
    const first = { builds: r.perf.personSpriteBuilds, painted };
    assert.equal(first.builds, 3072, 'la caché se llena una sola vez');
    painted = 0; frame();
    assert.equal(r.perf.personSpriteBuilds, 3072, 'el segundo fotograma no vuelve a construir lo que ya estaba');
    assert.equal(painted, total - 3072, 'solo los excedentes se pintan directo (antes: los 3500)');
    // Solo quedan poses obsoletas (nadie las vuelve a pedir): la caché se vacía y vuelve a servir.
    for (const body of bodies) body.view = { ...body.view, action: 'explore' };
    frame(); assert.equal(r.personSprites.size, 0, 'sin aciertos, se vacía');
    frame(); assert.equal(r.personSprites.size, 3072);
  } finally { (globalThis as any).document = previous; if (previous === undefined) Reflect.deleteProperty(globalThis, 'document'); }
});
