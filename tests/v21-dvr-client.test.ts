import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CINTA, type SeriePunto } from '../src/shared/cinta.js';
import { PROTOCOL_VERSION, type WorldView } from '../src/shared/types.js';
import { VELOCIDADES } from '../src/client/dvr-player.js';
import {
  desfaseLabel, duracionDeMundo, duracionDeTicks, dvrEngineLabel, dvrHoverLabel, dvrTimeLabel, escalaLabel, marcasMarkup, mountDvrBar,
  nearestSeriePoint, renderDvrBar, segundosDeMundoPorSegundo, type DvrBarHandlers, type DvrBarState,
} from '../src/client/dvr-bar.js';
import { applyObserverOnly, OBSERVER_HIDDEN_IDS, OBSERVER_NOTE, worldShell } from '../src/client/world-shell.js';
import { Connection } from '../src/client/connection.js';

/* El reproductor se prueba en `ola-cintacli-reproductor.test.ts`; aquí la barra y lo que la rodea. */

const frame = (tick: number): WorldView => ({ version: PROTOCOL_VERSION, sequence: tick, tick, day: Math.floor(tick / 100), people: [], animals: [], tiles: [] }) as unknown as WorldView;

function serie(): SeriePunto[] {
  return [0, 4800, 9600, 14400].map((t, i) => ({ t, poblacion: 10 + i * 5, nacimientos: i, muertes: 0, fauna: 3 + i, estructuras: i, sustancias: i * 2, hz: 100 }));
}

function barState(overrides: Partial<DvrBarState> = {}): DvrBarState {
  return { playing: true, speed: 2, currentTick: 4800, minTick: 0, maxTick: 14400, latestDay: 7, simHz: 119.6, serie: serie(), bifurcaciones: [], lagunas: [], nivel: 3, aheadOfPlayhead: 9600, atLiveEdge: false, ...overrides };
}

test('renderDvrBar: transporte, velocidades, serie de fondo, insignia de escala, desfase y Presente', () => {
  const html = renderDvrBar(barState());
  assert.match(html, /data-dvr-step="-1"/); assert.match(html, /data-dvr-step="1"/);
  assert.match(html, /data-dvr-play[^>]*aria-pressed="true"[^>]*aria-label="Pausar"[^>]*title="Espacio">⏸</);
  for (const speed of VELOCIDADES) assert.match(html, new RegExp(`data-dvr-speed="${speed}" aria-pressed="${speed === 2}">${speed}×<`));
  assert.match(html, /<svg class="dvr-sparkline"[^>]*viewBox="0 0 100 24"/);
  assert.match(html, /<path class="dvr-spark-line" d="M0\.00,/); assert.match(html, /<path class="dvr-spark-area"/);
  assert.match(html, /<input type="range" class="dvr-range" data-dvr-range min="0" max="14400" step="1" value="4800"/);
  assert.match(html, /Día 3 · 00:00/);
  assert.match(html, /data-dvr-escala[^>]*>Resumen diario · 1 s = 12 d de mundo</);
  assert.match(html, /a 4 d del presente/);
  assert.match(html, /⚡ 120 Hz/);
  assert.match(html, /<button type="button" class="dvr-live" data-dvr-live aria-pressed="false"[^>]*>● Presente<\/button>/);
  assert.doesNotMatch(html, /Borde vivo|NaN|undefined|Infinity/);
});

test('renderDvrBar: pausa muestra ▶, el presente se resalta, la vista previa del punto aparece y un fallo de la cinta se dice', () => {
  const paused = renderDvrBar(barState({ playing: false, atLiveEdge: true, aheadOfPlayhead: 12 }), serie()[2]!);
  assert.match(paused, /aria-label="Reproducir"[^>]*>▶</);
  assert.match(paused, /class="dvr-live is-live" data-dvr-live aria-pressed="true"/);
  assert.match(paused, /en el presente/);
  assert.match(paused, /<span class="dvr-hover" data-dvr-hover>Día 5 · 00:00 · Pob 20 · Fauna 5 · Obras 2 · Sustancias 4<\/span>/);
  assert.match(renderDvrBar(barState()), /<span class="dvr-hover" data-dvr-hover><\/span>/);
  assert.doesNotMatch(renderDvrBar(barState()), /dejó de grabar/);
  assert.match(renderDvrBar(barState({ estado: 'error' })), /data-dvr-estado role="status">⚠ La cinta dejó de grabar/);
});

test('renderDvrBar: marcas de bifurcación y de laguna sobre la serie, en su posición', () => {
  const html = renderDvrBar(barState({ bifurcaciones: [{ epoca: 0, desde: 7200, hasta: 9000, motivo: 'reinicio' }], lagunas: [{ t0: 2880, t1: 4320 }] }));
  assert.match(html, /<line class="dvr-marca dvr-marca-bifurcacion" data-dvr-bifurcacion="0" x1="50\.00" y1="0" x2="50\.00"/);
  assert.match(html, /<rect class="dvr-marca dvr-marca-laguna" data-dvr-laguna="2880" x="20\.00" y="0" width="10\.00"/);
  assert.equal(marcasMarkup([], [], 0, 100), '');
  assert.doesNotMatch(marcasMarkup([{ epoca: 1, desde: NaN, hasta: 1, motivo: 'reinicio' }], [{ t0: NaN, t1: Infinity }], 0, 100), /NaN|Infinity/);
});

test('renderDvrBar: nada del servidor llega sin escapar ni como no-número', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const bad = { t: evil, poblacion: evil, nacimientos: 0, muertes: 0, fauna: evil, estructuras: evil, sustancias: evil, hz: evil } as unknown as SeriePunto;
  const html = renderDvrBar(barState({ serie: [bad, ...serie()], latestDay: evil as never, simHz: evil as never, speed: evil as never, aheadOfPlayhead: evil as never, currentTick: evil as never, nivel: evil as never }), bad);
  assert.doesNotMatch(html, /<img|onerror|alert/);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
  assert.match(html, /data-dvr-speed="1" aria-pressed="true"/, 'una velocidad desconocida cae a 1×');
  for (const empty of [renderDvrBar(barState({ serie: [], minTick: 0, maxTick: 0, currentTick: 0, nivel: null })), renderDvrBar(barState({ serie: [serie()[0]!], minTick: 5, maxTick: 5, currentTick: 5 }))]) {
    assert.doesNotMatch(empty, /NaN|undefined|Infinity/); assert.match(empty, /<svg class="dvr-sparkline"/);
  }
});

test('escala: nivel y paso en tiempo de mundo (fps del nivel × paso × velocidad), con un día de 2400 ticks', () => {
  assert.equal(segundosDeMundoPorSegundo(3, 1), CINTA.fpsNormal * 2400 * 36);
  assert.equal(escalaLabel(3, 1), 'Resumen diario · 1 s = 6 d de mundo');
  assert.equal(escalaLabel(0, 1), 'Detalle completo · 1 s = 14 min de mundo');
  assert.equal(escalaLabel(4, 1), 'Resumen de 10 días · 1 s = 60 d de mundo');
  assert.equal(escalaLabel(2, 0.5), 'Fauna en densidad · 1 s = 9 h de mundo');
  assert.equal(escalaLabel(1, 25), 'Sin telemetría · 1 s = 2 d de mundo');
  assert.equal(escalaLabel(null, 1), ''); assert.equal(escalaLabel(9 as never, 1), '');
  assert.equal(duracionDeMundo(30), '30 s'); assert.equal(duracionDeMundo(5400), '1 h 30 min'); assert.equal(duracionDeMundo(86_400 * 2.25), '2 d 6 h'); assert.equal(duracionDeMundo(-5), '1 s');
});

test('helpers de la barra: tiempo, motor, desfase y punto más cercano', () => {
  const state = barState();
  assert.equal(dvrTimeLabel(state), 'Día 3 · 00:00');
  assert.equal(dvrTimeLabel(state, 3600), 'Día 2 · 12:00');
  assert.equal(dvrEngineLabel(state), '⚡ 120 Hz');
  assert.equal(desfaseLabel({ aheadOfPlayhead: 4 * 2400 + 600, atLiveEdge: false }), 'a 4 d 6 h del presente');
  assert.equal(duracionDeTicks(2400 * 4 + 600), '4 d 6 h');
  assert.equal(desfaseLabel({ aheadOfPlayhead: 5, atLiveEdge: true }), 'en el presente');
  assert.equal(nearestSeriePoint(state.serie, 9000)!.t, 9600);
  assert.equal(nearestSeriePoint([], 1), null);
  assert.equal(dvrHoverLabel(null), '');
});

class FakeButton {
  constructor(private readonly attributes: Record<string, string>) {}
  hasAttribute(name: string): boolean { return name in this.attributes; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  closest(selector: string): FakeButton | null { return selector === 'button' ? this : null; }
}
class FakeContainer {
  innerHTML = '';
  listeners = new Map<string, (event: unknown) => void>();
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, listener); }
  removeEventListener(type: string): void { this.listeners.delete(type); }
  querySelector(): null { return null; }
  contains(): boolean { return true; }
  click(attributes: Record<string, string>): void { this.listeners.get('click')!({ target: new FakeButton(attributes) }); }
}

test('mountDvrBar: pinta la barra y delega cada botón en su manejador', () => {
  const container = new FakeContainer();
  const calls: unknown[] = [];
  const handlers: DvrBarHandlers = { togglePlay: () => calls.push('play'), step: d => calls.push(['step', d]), setSpeed: s => calls.push(['speed', s]), seek: t => calls.push(['seek', t]), jumpLive: () => calls.push('live') };
  const bar = mountDvrBar(container as unknown as HTMLElement, handlers);
  bar.update(barState());
  assert.match(container.innerHTML, /class="dvr-transport"/);
  container.click({ 'data-dvr-play': '' }); container.click({ 'data-dvr-live': '' });
  container.click({ 'data-dvr-step': '-1' }); container.click({ 'data-dvr-step': '1' });
  container.click({ 'data-dvr-speed': '10' }); container.click({ 'data-dvr-speed': '3' });
  assert.deepEqual(calls, ['play', 'live', ['step', -1], ['step', 1], ['speed', 10]]);
  bar.destroy();
  assert.equal(container.innerHTML, ''); assert.equal(container.listeners.size, 0);
});

/* ------------------------------------------------------------------ */
/* Modo observador puro + compatibilidad del shell                    */
/* ------------------------------------------------------------------ */

interface FakeNode { hidden?: boolean | 'until-found'; textContent: string | null; attributes: Record<string, string>; classes: Set<string>; classList: { toggle(token: string, force?: boolean): void }; setAttribute(name: string, value: string): void }
function fakeDocument(ids: readonly string[]) {
  const nodes = new Map<string, FakeNode>();
  for (const id of ids) {
    const node: FakeNode = { hidden: false, textContent: `texto original de ${id}`, attributes: {}, classes: new Set(),
      classList: { toggle: (token, force) => { if (force ?? !node.classes.has(token)) node.classes.add(token); else node.classes.delete(token); } },
      setAttribute: (name, value) => { node.attributes[name] = value; } };
    nodes.set(id, node);
  }
  return { nodes, getElementById: (id: string) => nodes.get(id) ?? null };
}

test('observerOnly: oculta la UI de dirección e intervención y reescribe las ayudas', () => {
  const ids = ['game', ...OBSERVER_HIDDEN_IDS, 'population-note', 'control-help', 'follow-toggle', 'inspector-tabs', 'dvr-bar'];
  const doc = fakeDocument(ids);
  applyObserverOnly(doc, true);
  assert.ok(doc.nodes.get('game')!.classes.has('is-observer-only'));
  for (const id of ['direct-toggle', 'person-controls', 'task-palette']) { assert.equal(doc.nodes.get(id)!.hidden, true, id); assert.equal(doc.nodes.get(id)!.attributes['aria-hidden'], 'true'); }
  assert.equal(OBSERVER_NOTE, 'Observación pura: cada habitante decide por su cuenta.');
  assert.equal(doc.nodes.get('population-note')!.textContent, OBSERVER_NOTE);
  assert.equal(doc.nodes.get('control-help')!.textContent, OBSERVER_NOTE);
  for (const id of ['follow-toggle', 'inspector-tabs', 'dvr-bar']) { assert.equal(doc.nodes.get(id)!.hidden, false, `${id} sigue visible`); assert.equal(doc.nodes.get(id)!.textContent, `texto original de ${id}`); }
});

test('observerOnly = false: no toca nada salvo quitar la marca', () => {
  const doc = fakeDocument(['game', ...OBSERVER_HIDDEN_IDS, 'population-note']);
  doc.nodes.get('game')!.classes.add('is-observer-only');
  applyObserverOnly(doc, false);
  assert.equal(doc.nodes.get('game')!.classes.has('is-observer-only'), false);
  for (const id of OBSERVER_HIDDEN_IDS) assert.equal(doc.nodes.get(id)!.hidden, false);
  assert.equal(doc.nodes.get('population-note')!.textContent, 'texto original de population-note');
  applyObserverOnly({ getElementById: () => null }, true); // un shell sin esos nodos no revienta
});

test('worldShell: monta #dvr-bar oculto y conserva todo lo existente (modo vivo sin cinta)', () => {
  const html = worldShell();
  assert.match(html, /<div id="dvr-bar" class="dvr-bar hud-surface"[^>]*hidden><\/div>/);
  assert.doesNotMatch(html, /is-observer-only/);
  for (const id of OBSERVER_HIDDEN_IDS) assert.ok(html.includes(`id="${id}"`), `${id} sigue en el shell por defecto`);
  for (const label of ['Mapa', 'Vidas', 'Mundo', 'Capas', 'Ajustes', 'Susurros', 'Crónica']) assert.ok(html.includes(label), label);
  for (const id of ['focus-s', 'focus-i', 'follow-toggle', 'letter-button', 'inspector-tab-now', 'inspector-tab-kit', 'inspector-tab-story', 'world-coordinates'.replace('world-coordinates', 'camera-coordinates')]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('id="dvr-bar"') < html.indexOf('class="world-coordinates'), 'la barra va antes de las coordenadas en el DOM');
  assert.ok(html.includes('id="layers-popover"')); // V24 mounts the multi-select catalogue here.
});

test('game.css: barra DVR flotante y reglas de observador puro presentes', () => {
  const css = readFileSync(new URL('../src/client/game.css', import.meta.url), 'utf8');
  assert.match(css, /\.dvr-bar\{position:absolute;left:50%;bottom:92px/);
  assert.match(css, /\.dvr-bar\[hidden\]\{display:none\}/);
  assert.match(css, /\.game-shell\.is-observer-only :is\(#direct-toggle,#person-controls,#task-palette\)\{display:none!important\}/);
  assert.match(css, /@media\(max-width:760px\)\{\s*\.dvr-bar\{left:8px;right:8px/);
});

/* ------------------------------------------------------------------ */
/* Connection: la cinta manda, el socket sigue para recetas/fichas      */
/* ------------------------------------------------------------------ */

test('Connection.setTapeMode: los estados del socket se encadenan pero no se entregan; al volver al vivo se reanudan', () => {
  const delivered: number[] = [];
  const connection = new Connection({ world: w => delivered.push(w.sequence), result: () => undefined, status: () => undefined, expired: () => undefined, error: () => undefined, pending: () => undefined });
  const accept = (world: WorldView): void => (connection as unknown as { accept(w: WorldView): void }).accept(world);
  const view = (sequence: number): WorldView => ({ ...frame(sequence), sequence, width: 1, height: 1 }) as WorldView;
  accept(view(1));
  assert.deepEqual(delivered, [1]); assert.equal(connection.isTapeMode, false);
  connection.setTapeMode(true);
  assert.equal(connection.isTapeMode, true);
  accept(view(2)); accept(view(3));
  assert.deepEqual(delivered, [1], 'en modo cinta el mundo no viene del socket');
  connection.setTapeMode(false);
  accept(view(4));
  assert.deepEqual(delivered, [1, 4]);
  // Las preguntas por socket siguen disponibles en modo cinta (sin socket abierto simplemente devuelven false, sin romper).
  connection.setTapeMode(true);
  assert.equal(connection.requestRecipe('recipe-1'), false); assert.equal(connection.requestPersona('s'), false);
  connection.stop();
});
