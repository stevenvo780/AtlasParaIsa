import { makeFloatingPanel, type FloatingPanel } from './panel-manager.js';
import { GRAPHICS_STORAGE_KEY, loadGraphicsSettings, saveGraphicsSettings, sanitizeGraphicsSettings, applyPreset, renderGraphicsSettingsHtml, minZoomLabel, GRAPHICS_PRESETS, type GraphicsPreset, type GraphicsSettings } from './graphics-settings.js';
import { MAP_LAYER_CATALOG, isMapLayerId, toggleLayer, clearLayers, activeLayersSummary, renderLayersPopoverHtml, type MapLayerId } from './layers-control.js';
import { mountMinimap, type MinimapController } from './minimap.js';
import { SpatialSoundscape } from './soundscape.js';
import { fetchJson, modoDeAjustes, validDirectory, validMap, validWhisperResult, validWhispers } from './ui-guards.js';
import { renderMundoDeepStats } from './mundo-dashboard.js';
import type { WorldMapResponse, WorldDirectoryResponse, DivineWhisper, DivineWhisperIntent, DivineWhisperRequest } from '../shared/worldmap.js';
import type { AnimalView, BlueprintView, ChronicleEvent, Gesture, Order, PersonDetail, PersonView, StructureView, TechnologyRecipe, Tile, WorldView } from '../shared/types.js';
import { Connection, type ConnectionStatus } from './connection.js';
import { Landscape, type Selection } from './landscape.js';
import { ClientTileCache } from './tile-cache.js';
import { actions, phases, terrains, biomes, deathCauses, icon, esc, number, percentage } from './ui-catalog.js';
import { meter, deathHistory, animalSilhouette, blueprintCard, personBlueprint, structureCard, resourceQuantity, inheritedAndLearned, destinationLink } from './inspector-view.js';
import { applyObserverOnly, OBSERVER_NOTE, worldShell } from './world-shell.js';
import { DvrPlayer, type DvrFrameInfo } from './dvr-player.js';
import { mountDvrBar, type DvrBarController } from './dvr-bar.js';
import type { TapeChunkResponse, TapeMetaResponse } from '../shared/tape.js';
import { telemetryKpis, viewportCensusText, renderLifeTelemetry, renderLandTelemetry, renderCommunityTelemetry, renderPersonTelemetry, renderAnimalTelemetry, renderTileTelemetry, renderChemistryTelemetry, type HudNav } from './telemetry-hud.js';
import { Notebook, wireTabs, type NotebookPage } from './notebook.js';
import { personLink, recentEvidence } from './world-evidence.js';
import { retainViewState } from './view-state.js';
import { animalActions, animalColors, componentNames, speciesNames, speciesPlural } from './life-art.js';
import { technologyPane, recipeCard } from './technology-art.js';
import { readHitos, readVisitCounters, readWorldVisit, saveHitos, saveVisitCounters, saveWorldVisit, type HitoGuardado } from './visit-memory.js';
import { enClaro } from './textos.js';
import { CronicaBuffer, clasificar, contadoresDe, esHito, filtrar, momento, quienCedio, resumenDesdeVisita, type GrupoCronica } from './cronica.js';
import { decidirModo, type Modo } from './modo.js';
import { ausenteEstado, comunidadesOrdenadas, demographicSummary, ejeDominante, ejesCultura, miembrosNombrados, resumenCultural, rotuloRecuento, ventanaLista } from './censo-view.js';
import { estadoCrecimiento, renderPanelGobernador, ritmo, seccionFases, ultimoFrenazo } from './gobernador-view.js';
import { distribution, sparkline, statCard } from './charts.js';
import { notaAcercamientos, seccionNacimientos } from './natalidad-view.js';
import { seccionDesacuerdos, seccionJuntos } from './cooperacion-view.js';
import { generacionMaxima, sinComunidad, vidasQueTerminaron } from './linaje-view.js';
import { rotuloTerritorio, seccionTerritorio } from './territorio-view.js';
import { enReposo } from './regiones.js';
import { idDeRol, nombreConocido, olvidarVistos, recordarPersona, recordarVistos, visto } from './vistos.js';
import './style.css';
import './game.css';
import './notebook.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
let world: WorldView | null = null;
let connection: Connection | null = null;
/** V21: reproductor DVR de la cinta (`/api/tape/*`), su barra y el bucle rAF que lo avanza. `null` = modo vivo por WebSocket. */
let dvr: DvrPlayer | null = null;
let dvrBar: DvrBarController | null = null;
let dvrRaf = 0;
let lastTapeHudAt = 0;
/** V21: el servidor sólo deja observar (sin órdenes ni gestos): la UI de dirección e intervención no existe. */
let observerOnly = false;
interface SessionFlags { tapeEnabled?: boolean; observerOnly?: boolean }
let landscape: Landscape | null = null;
/** V18: última verdad de teselas recibida (256 trozos); la cámara pinta lo ya visitado sin esperar al servidor. Se vacía al salir o cambiar de mundo. */
// V24: 640 trozos de 16×16 (≈ 164 k teselas): alejar al zoom mínimo (≈ 480×270 teselas a 1080p) cabe sin expulsar lo visible.
const tileCache = new ClientTileCache(640);
let selected: Selection = { kind: 'person', id: 's' };
let activePersonId = 's';
let control: 'inspect' | 'direct' = 'inspect';
let following = false;
let status: ConnectionStatus = 'connecting';
let pending = false;
let lastVisit: number | null = null;
/** M5: los episodios que este navegador recibió en esta visita (sin duplicados, acotados) y los hitos
 * guardados en visitas anteriores de este mismo mundo (localStorage, como mucho 80). */
const cronica = new CronicaBuffer();
let hitosGuardados: HitoGuardado[] = [];
let journalFilter: GrupoCronica | 'todo' = 'todo';
let populationSignature = '', inspectorSignature = '', statsSignature = '';
let statsTab: 'life' | 'land' | 'communities' | 'technology' | 'performance' = 'life';
/** M2: modo de dibujo decidido al entrar; el HUD dice «cada 5 s (ligero)» en observador. */
let modoActual: Modo = 'completo';
let populationKind: 'people' | 'animals' | 'communities' | 'structures' = 'people';
let notebook: Notebook | null = null;
let inspectorTab: 'now' | 'kit' | 'story' = 'now';
let focusedRecipe: string | null = null;
let focusedCommunity: string | null = null;
/** Steps requested one by one: the snapshot only carries each procedure's identity and capacities. */
const recipeDetails = new Map<string, TechnologyRecipe | null>();
/** T036(h): biografías pedidas de una en una; el `state` sólo trae la identidad y el estado de ahora.
 * M3: cada ficha recuerda el paso en que llegó y se vuelve a pedir como mucho cada `PERSONA_REFRESCO`
 * pasos (antes se borraba en cada paso y la ficha abierta se pedía ~10 veces por segundo). */
const personaDetails = new Map<string, { detail: PersonDetail | null; tick: number }>();
const PERSONA_REFRESCO = 20;
/** M3: a quién estamos yendo a buscar fuera de la cámara; su ficha trae la posición exacta. */
let buscando: string | null = null;
/** M1: lo que el servidor contestó sobre cada identidad pedida (true = vive en el mundo servido). No caduca por tick:
 * una muerte llega por `demography.recent`, que manda sobre este registro. */
const personaVivo = new Map<string, boolean>();
let soundscape = new SpatialSoundscape();
let soundEnabled = false;
let graphicsSettings = loadGraphicsSettings();
/** `true` cuando el visitante ya eligió en Ajustes: desde entonces el perfil manda sobre la heurística del aparato. */
let graphicsChosen = false;
let sessionFlags: SessionFlags = {};
let soundBusy = false;
let activeLayers = clearLayers();
const panels: Partial<Record<NotebookPage, FloatingPanel>> = {};
let panelQuery: MediaQueryList | null = null, panelSync: (() => void) | null = null;
let minimap: MinimapController | null = null;
let uiSession: AbortController | null = null;
const uiTimers: ReturnType<typeof setInterval>[] = [];
let uiRaf = 0;
let directory: WorldDirectoryResponse | null = null;
/** Antes de la primera respuesta del directorio no es lo mismo que tras un fallo. */
let directoryState: 'loading' | 'ready' | 'failed' = 'loading';
let recentWhispers: DivineWhisper[] = [];
let directoryBusy = false, mapBusy = false, whispersBusy = false;
let pickingWhisper = false;
let whisperTile = { x: 0, y: 0 };
/** El lugar del susurro sigue a la cámara hasta que se elige una casilla a propósito. */
let whisperPicked = false;
/** Tras un fallo de /api/worldmap se espera antes de volver a pedirlo (no se insiste cada 3 s a un servidor lento). */
let mapFailures = 0, mapRetryAt = 0;
/** Filas máximas que se dibujan en Vidas; la búsqueda siempre recorre todo el directorio. */
const DIRECTORY_ROWS = 300;
const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const mobile = (): boolean => matchMedia('(max-width: 760px)').matches;
function saveVisit(): void {
  if (!world) return;
  try {
    saveWorldVisit(localStorage, world);
    const counters = contadoresDe(world); if (counters) saveVisitCounters(localStorage, world, counters);
    const vistos = new Map(hitosGuardados.map(h => [h.id, h]));
    for (const event of cronica.todos()) if (esHito(event)) vistos.set(event.id, { id: event.id, tick: event.tick, kind: event.kind, text: event.text });
    saveHitos(localStorage, world, [...vistos.values()].sort((a, b) => a.tick - b.tick));
  } catch { /* Optional. */ }
}
function readVisit(current: WorldView): number | null { try { return readWorldVisit(localStorage, current); } catch { return null; } }
function stopSound(): void { soundEnabled = false; soundBusy = false; soundscape.stop(); document.getElementById('sound-toggle')?.setAttribute('aria-pressed', 'false'); }
function clean(): void { stopClientUi(); stopTape(); observerOnly = false; tileCache.clear(); activeLayers = clearLayers(); saveVisit(); connection?.stop(); landscape?.destroy(); stopSound(); connection = null; landscape = null; world = null; pending = false; following = false; control = 'inspect'; populationSignature = ''; inspectorSignature = ''; statsSignature = ''; if (statsTrailing) { clearTimeout(statsTrailing); statsTrailing = null; } focusedCommunity = null; statsTab = 'life'; populationKind = 'people'; }

function loginScreen(message = ''): void {
  clean(); root.innerHTML = `<main class="entry-page"><div class="entry-monogram">${icon.leaf}<span>UN MUNDO PRIVADO POR DESCUBRIR</span></div><section class="entry-card" aria-labelledby="entry-title"><div class="letter-stamp" aria-hidden="true">I<span>PARA TI</span></div><p class="eyebrow">UN LUGAR PARA ENCONTRARNOS</p><h1 id="entry-title">Una carta<br>para <em>Isa.</em></h1><p class="entry-intro">Un mundo que crece.<br>Muchas vidas. Tu forma de recorrerlo.</p><form id="login-form"><label for="password">Contraseña privada</label><input id="password" name="password" type="password" autocomplete="current-password" required placeholder="La llave de este lugar"><button class="button primary entry-submit" type="submit">Entrar a la carta ${icon.arrow}</button><p id="login-error" class="form-message" role="status">${esc(message)}</p></form><div class="entry-footnote">${icon.leaf}<span>Lo pequeño también puede contener un mundo.</span></div></section><p class="entry-footer">UNA CARTA PARA ISA · ACCESO PRIVADO</p></main>`;
  el<HTMLFormElement>('login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = el('login-form').querySelector<HTMLButtonElement>('button')!; button.disabled = true; el('login-error').textContent = 'Abriendo la carta…';
    try {
      const response = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: el<HTMLInputElement>('password').value }), signal: AbortSignal.timeout(10_000) });
      el<HTMLInputElement>('password').value = '';
      if (!response.ok) { el('login-error').textContent = response.status === 429 ? 'Espera un momento antes de volver a intentar.' : 'No pudimos abrir la carta con esa contraseña.'; button.disabled = false; return; }
      enterWorld(await readSessionFlags());
    } catch { el('login-error').textContent = 'No hay conexión con el servidor. Puedes intentarlo de nuevo.'; button.disabled = false; }
  });
}

/** V21: banderas del servidor (`tapeEnabled`, `observerOnly`); sin respuesta válida, modo vivo clásico. */
async function readSessionFlags(): Promise<SessionFlags> {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.json() as SessionFlags : {};
  } catch { return {}; }
}

/** Sin elección guardada manda la heurística del aparato (pantalla pequeña, poca memoria, sin WebGL2, `?modo=`) y se muestra como perfil Ligero. */
function startupSettings(): GraphicsSettings {
  if (graphicsChosen) return graphicsSettings;
  const loaded = loadGraphicsSettings();
  let saved = false;
  try { saved = localStorage.getItem(GRAPHICS_STORAGE_KEY) !== null; } catch { /* Sin almacenamiento: no hay elección guardada. */ }
  return !saved && decidirModo() === 'observador' ? applyPreset('ligero', loaded) : loaded;
}

function enterWorld(flags: SessionFlags = {}): void {
  sessionFlags = flags;
  clean(); lastVisit = null; status = 'connecting'; cronica.clear(); hitosGuardados = []; journalFilter = 'todo';
  root.innerHTML = worldShell();
  inspectorTab = 'now';
  focusedRecipe = null; focusedCommunity = null; statsSignature = ''; recipeDetails.clear(); personaDetails.clear(); personaVivo.clear(); olvidarVistos(); buscando = null;
  // El perfil de Ajustes decide el modo de dibujo (Ligero = observador); ya no hay otro conmutador que lo deje atrapado.
  graphicsSettings = startupSettings();
  const modo = modoDeAjustes(graphicsSettings); modoActual = modo;
  connection = new Connection({ world: receiveWorld, status: value => { status = value; renderStatus(); }, pending: value => { pending = value; if (!value) landscape?.setPendingTarget(null); renderControls(); }, result: result => message(result.message, result.accepted), error: text => message(text, false), expired: () => loginScreen('La sesión terminó. Vuelve a entrar para ver la carta.'), recipe: (id, recipe) => { recipeDetails.set(id, recipe); statsSignature = ''; if (statsTab === 'technology' && !el('stats-drawer').hidden) renderStats(); }, persona: (id, persona) => { personaDetails.set(id, { detail: persona, tick: world?.tick ?? 0 }); personaVivo.set(id, persona !== null); if (persona) recordarPersona(persona, world?.tick ?? 0); llegoPersona(id, persona); if (selected?.kind === 'person' && selected.id === id) { inspectorSignature = ''; renderInspector(); } } });
  landscape = new Landscape(el<HTMLCanvasElement>('landscape'), pick, viewport => { connection?.setViewport(viewport); dvr?.setViewport(viewport); }, () => { following = false; renderControls(); }, { modo });
  landscape.setTileCache(tileCache);
  // T036(a): en observador el mundo llega cada 5 s (el servidor acota a 1000 ms) y el terreno se
  // dibuja en Canvas 2D: ni WebGL2 ni una cadencia que un móvil lento no puede sostener.
  if (modo === 'observador') connection.suscribir(5000);
  startClientUi(); wire(); wireClientUi();
  observerOnly = !!flags.observerOnly; applyObserverOnly(document, observerOnly);
  if (flags.tapeEnabled) startTape(); // la cinta manda el mundo; el socket sigue para gestos, recetas y fichas
  connection.start();
}

/* ------------------------------------------------------------------ */
/* V21 — cinta DVR: el mundo se reproduce desde `/api/tape/*` a 60 fps  */
/* ------------------------------------------------------------------ */
async function tapeJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: signal ?? AbortSignal.timeout(10_000) });
  if (response.status === 401 || response.status === 403) { loginScreen('La sesión terminó. Vuelve a entrar para ver la carta.'); throw new Error('Sesión terminada.'); }
  if (!response.ok) throw new Error('La cinta del mundo no está disponible todavía.');
  return await response.json() as T;
}

/** Con la cinta, el HUD pesado se rehace a ≈ 6 Hz (y en cada salto); el paisaje recibe todos los fotogramas. */
function receiveTapeFrame(frame: WorldView, info: DvrFrameInfo): void {
  const now = performance.now();
  // V22: con trozos delta solo se ingieren las teselas que cambiaron (10–50) en vez de las ~6.000 de la vista.
  // Sin `changedTiles` (fotograma completo, base de trozo, salto) se ingiere la vista entera como siempre.
  const tiles = info.changedTiles ?? frame.tiles;
  // V24: el paisaje también recibe `changedTiles`: solo rehornea los trozos de 8×8 que tocan esas teselas.
  if (world === null || info.discontinuity || now - lastTapeHudAt >= 160) { lastTapeHudAt = now; receiveWorld(frame, tiles, info.changedTiles); }
  else { recordarVistos(frame); tileCache.ingest(tiles, frame.tick); world = frame; landscape?.update(frame, info.changedTiles); cronica.acumular(frame.events); }
  if (info.discontinuity) landscape?.flushPlayback();
}

function startTape(): void {
  const container = document.getElementById('dvr-bar'); if (!container) return;
  connection?.setTapeMode(true);
  dvrBar = mountDvrBar(container, {
    togglePlay: () => dvr?.togglePlaying(), step: delta => void dvr?.step(delta), setSpeed: speed => dvr?.setSpeed(speed),
    seek: tick => void dvr?.seek(tick), jumpLive: () => void dvr?.jumpToLiveEdge(),
  });
  const player = new DvrPlayer({
    fetchMeta: () => tapeJson<TapeMetaResponse>('/api/tape/meta'),
    fetchChunk: request => tapeJson<TapeChunkResponse>(`/api/tape/chunk?${new URLSearchParams({ fromTick: String(request.fromTick), count: String(request.count), encoding: 'delta', ...(request.viewport ? Object.fromEntries(Object.entries(request.viewport).map(([key, value]) => [key, String(value)])) : {}) })}`, request.signal),
    onFrame: receiveTapeFrame,
    onStateChange: state => { dvrBar?.update(state); },
  });
  dvr = player;
  void player.start().then(active => {
    if (dvr !== player) return; // se salió del mundo mientras cargaba
    if (!active) { // cinta apagada o sin respuesta: de vuelta al modo vivo clásico por WebSocket
      dvrBar?.destroy(); dvrBar = null; dvr = null; connection?.setTapeMode(false); landscape?.setDvrMode(false); return;
    }
    landscape?.setDvrMode(true); // el DVR ya entrega a 60 fps: el colchón V18 de Landscape sobraría (solo interpola A→B)
    if (player.observerOnly && !observerOnly) { observerOnly = true; applyObserverOnly(document, true); }
    container.hidden = false; el('game').classList.add('has-dvr'); renderStatus();
    const loop = (now: number): void => { player.advance(now); dvrRaf = requestAnimationFrame(loop); };
    dvrRaf = requestAnimationFrame(loop);
  });
}

function stopTape(): void {
  cancelAnimationFrame(dvrRaf); dvrRaf = 0;
  dvr?.stop(); dvr = null; dvrBar?.destroy(); dvrBar = null;
  landscape?.setDvrMode(false);
  document.getElementById('game')?.classList.remove('has-dvr');
}

/** Atajos de la cinta (Espacio, «,», «.», «0»): nunca mientras se escribe ni con modificadores. */
function tapeShortcut(event: KeyboardEvent): void {
  if (!dvr?.enabled || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const focus = event.target as HTMLElement | null, tag = focus?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || focus?.isContentEditable) return;
  if (event.key === ' ' && (tag === 'BUTTON' || tag === 'A' || focus?.getAttribute?.('role') === 'tab')) return; // Espacio activa el botón enfocado
  if (event.key === ' ') dvr.togglePlaying();
  else if (event.key === ',') void dvr.step(-1);
  else if (event.key === '.') void dvr.step(1);
  else if (event.key === '0') void dvr.jumpToLiveEdge();
  else return;
  event.preventDefault();
}

type Drawer = NotebookPage;
function drawer(name: Drawer, open?: boolean): void {
  const next = notebook?.show(name, open) ?? false;
  if (next && mobile()) { el('layers-popover').hidden = true; el('layers-toggle').setAttribute('aria-expanded', 'false'); }
  if (name === 'whisper' && !next && pickingWhisper) setPickingWhisper(false);
  syncPickingMode();
  if (name === 'population' && next) { renderPopulation(); void refreshDirectory(); el('population-search').focus(); }
  if (name === 'whisper' && next) { if (!whisperPicked) followWhisperTile(); renderWhisperPeople(); renderWhispers(); void refreshDirectory(); void refreshWhispers(); }
  if (name === 'stats' && next) { renderStats(); void refreshDirectory(); el(`stats-tab-${statsTab}`).focus(); }
}
function setWhisperTile(x: number, y: number, picked: boolean): void {
  whisperTile = { x: Math.floor(x), y: Math.floor(y) }; whisperPicked = picked;
  el('whisper-coordinates').textContent = `${whisperTile.x}, ${whisperTile.y}`;
  el('whisper-place-label').textContent = picked ? 'Lugar: casilla elegida' : 'Lugar: centro de la cámara';
}
/** Sin casilla elegida, el lugar del susurro es el centro de lo que se está mirando. */
function followWhisperTile(): void { const camera = landscape?.camera(); if (camera) setWhisperTile(camera.x, camera.y, false); }
/** Elegir casilla para un susurro no queda armado: Esc, cerrar Susurros, elegir otra cosa o volver a Mapa lo cancelan. */
function setPickingWhisper(active: boolean): void {
  pickingWhisper = active;
  el('whisper-pick').setAttribute('aria-pressed', String(active)); el('pick-hint').hidden = !active;
  syncPickingMode();
}
function syncPickingMode(): void { landscape?.setPickMode(control !== 'direct' && !pickingWhisper ? 'inspect' : 'ground'); }
function choosePerson(id: string, focus = true): void {
  const person = world?.people.find(p => p.id === id); if (!person) { irAPersona(id); return; }
  buscando = null;
  inspectorTab = 'now'; toggleTasks(false); activePersonId = person.id; selected = { kind: 'person', id }; control = 'inspect'; following = false; landscape?.follow(null); landscape?.select(selected);
  if (focus) landscape?.focus(person.x, person.y);
  inspectorSignature = ''; renderInspector(); renderPopulation(); renderControls(); drawer('inspector', true); el('inspector-tab-now').focus({ preventScroll: true }); if (!pending) message('');
}
/** M3: seleccionar a alguien que no está en la cámara. Si murió hace poco se abre su despedida; si no,
 * se centra la cámara en la última posición conocida y se pide su ficha, que trae la posición exacta.
 * Cuando entra en cuadro, la ficha completa aparece sola (la selección ya es suya). */
function irAPersona(id: string): void {
  if (!world) return;
  inspectorTab = 'now'; toggleTasks(false); activePersonId = id; selected = { kind: 'person', id }; control = 'inspect'; following = false; landscape?.follow(null); landscape?.select(selected);
  const muerto = world.demography?.recent.some(entry => entry.id === id);
  buscando = muerto ? null : id;
  const known = visto(id);
  if (!muerto && known?.x !== undefined && known.y !== undefined) landscape?.focus(known.x, known.y);
  if (!muerto) connection?.requestPersona(id);
  inspectorSignature = ''; renderInspector(); renderPopulation(); renderControls(); drawer('inspector', true); el('inspector-tab-now').focus({ preventScroll: true }); if (!pending) message('');
}
/** M3: respuesta de una ficha. Si íbamos a buscar a esa persona, la cámara va a su posición exacta. */
function llegoPersona(id: string, persona: PersonDetail | null): void {
  if (persona?.x !== undefined && persona.y !== undefined && persona.id === idDeRol('S', world)) landscape?.setHome({ x: persona.x, y: persona.y });
  if (buscando !== id) return;
  buscando = null;
  if (persona?.x !== undefined && persona.y !== undefined) landscape?.focus(persona.x, persona.y);
}
function chooseAnimal(id: string, focus = true): void {
  const animal = world?.animals?.find(a => a.id === id); if (!animal) return;
  inspectorTab = 'now'; toggleTasks(false); selected = { kind: 'animal', id }; control = 'inspect'; following = false; landscape?.follow(null); landscape?.select(selected);
  if (focus) landscape?.focus(animal.x, animal.y);
  inspectorSignature = ''; renderInspector(); renderPopulation(); renderControls(); drawer('inspector', true); el('inspector-tab-now').focus({ preventScroll: true });
}
function pick(selection: Selection): void {
  if (pickingWhisper && selection.kind === 'tile') {
    setWhisperTile(selection.x, selection.y, true); setPickingWhisper(false); drawer('whisper', true); return;
  }
  if (pickingWhisper) setPickingWhisper(false); // eligió otra cosa: el susurro ya no espera casilla
  if (control === 'direct' && selection.kind === 'tile') { sendCommand('move', selection); return; }
  selected = selection; landscape?.select(selection);
  if (selection.kind === 'person') { choosePerson(selection.id, false); return; }
  if (selection.kind === 'animal') { chooseAnimal(selection.id, false); return; }
  inspectorSignature = ''; renderInspector(); drawer('inspector', true);
}
function person(): PersonView | undefined { return world?.people.find(p => p.id === activePersonId); }
function focusTile(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  following = false; control = 'inspect'; landscape?.focusTile(x, y); renderControls();
}
function message(text: string, accepted?: boolean): void { const output = document.getElementById('gesture-result'); if (output) { output.textContent = text; output.hidden = !text; output.dataset.accepted = accepted === undefined ? 'pending' : String(accepted); } }
function send(input: Omit<Gesture, 'id'>): boolean { if (!world || world.paused || status !== 'live' || pending) return false; if (connection?.send({ ...input, id: crypto.randomUUID() })) { landscape?.flushPlayback(); /* V18 capa 1.5: la orden se ve sobre el estado más reciente */ landscape?.setPendingTarget(input); message('Esperando la confirmación del mundo…'); return true; } return false; }
function sendCommand(order: Order, position?: { x: number; y: number }): void { if (observerOnly) return; const p = person(); if (!p || selected.kind === 'animal') return; const x = position?.x ?? p.x, y = position?.y ?? p.y; // V18: el destino se marca al instante; el servidor lo aplica en su siguiente paso.
  if (send({ kind: 'command', agentId: p.id, order, x, y }) && order === 'move') landscape?.markDestination({ x, y }, p.id); if (order === 'auto') { control = 'inspect'; renderControls(); } }

function wire(): void {
  root.removeEventListener('click', navigateEntity);
  root.addEventListener('click', navigateEntity);
  for (const name of ['population', 'inspector', 'settings', 'whisper', 'stats'] as const) el(`${name}-toggle`).addEventListener('click', () => drawer(name));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-close]')) button.addEventListener('click', () => drawer(button.dataset.close as Drawer, false));
  el('selection-back').addEventListener('click', () => drawer('population', true));
  wireTabs(el('inspector-tabs'), 'data-inspector-tab', value => selectInspectorTab(value as typeof inspectorTab));
  el('task-toggle').addEventListener('click', () => toggleTasks(!!el('task-palette').hidden));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-task-group]')) button.addEventListener('click', () => {
    for (const group of root.querySelectorAll<HTMLButtonElement>('[data-task-group]')) group.setAttribute('aria-pressed', String(group === button));
    for (const task of root.querySelectorAll<HTMLButtonElement>('[data-order-group]')) task.hidden = task.dataset.orderGroup !== button.dataset.taskGroup;
  });
  el('population-search').addEventListener('input', () => { populationSignature = ''; renderPopulation(); });
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-population]')) tab.addEventListener('click', () => { populationKind = tab.dataset.population as typeof populationKind; el<HTMLInputElement>('population-search').value = ''; populationSignature = ''; renderPopulation(); el('population-search').focus(); });
  el('species-filter').addEventListener('change', () => { populationSignature = ''; renderPopulation(); });
  el('population-list').addEventListener('click', event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-directory-kind]'); if (!row) return;
    const x = Number(row.dataset.directoryX), y = Number(row.dataset.directoryY), id = row.dataset.directoryId;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (row.dataset.directoryKind === 'person' && id) choosePerson(id, false);
    else if (row.dataset.directoryKind === 'animal' && id) chooseAnimal(id, false);
    else if (row.dataset.directoryKind === 'herd') {
      const animal = world?.animals?.find(a => Math.hypot(a.x - x, a.y - y) < 2);
      if (animal) chooseAnimal(animal.id, false); else pick({ kind: 'tile', x, y });
    }
    focusTile(x, y);
  });
  el('inhabitant-card').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-parent]'); if (button) choosePerson(button.dataset.parent!); });
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-stats]')) {
    tab.addEventListener('click', () => selectStatsTab(tab.dataset.stats as typeof statsTab));
    tab.addEventListener('keydown', event => { const names = ['life', 'land', 'communities', 'technology', 'performance'] as const; const index = names.indexOf(statsTab); let next = index; if (event.key === 'ArrowRight') next = (index + 1) % names.length; else if (event.key === 'ArrowLeft') next = (index + names.length - 1) % names.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = names.length - 1; else return; event.preventDefault(); selectStatsTab(names[next]!); el(`stats-tab-${statsTab}`).focus(); });
  }
  el('hud-telemetry').addEventListener('click', event => {
    const nav = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-hud-nav]')?.dataset.hudNav as HudNav | undefined;
    if (!nav) return;
    if (nav === 'people' || nav === 'animals') {
      populationKind = nav; el<HTMLInputElement>('population-search').value = '';
      el<HTMLSelectElement>('species-filter').value = ''; populationSignature = '';
      renderPopulation(); drawer('population', true);
    } else {
      focusedCommunity = null; focusedRecipe = null; statsSignature = '';
      selectStatsTab(nav); drawer('stats', true);
    }
  });
  el('letter-button').addEventListener('click', () => el<HTMLDialogElement>('letter-dialog').showModal());
  el('chronicle-button').addEventListener('click', () => { renderJournal(); el<HTMLDialogElement>('chronicle-dialog').showModal(); });
  for (const chip of root.querySelectorAll<HTMLButtonElement>('[data-journal-filter]')) chip.addEventListener('click', () => { journalFilter = chip.dataset.journalFilter as typeof journalFilter; renderJournal(); });
  el('enter-landscape').addEventListener('click', () => { el<HTMLDialogElement>('letter-dialog').close(); el('landscape').focus(); });
  for (const dialog of root.querySelectorAll<HTMLDialogElement>('dialog')) dialog.querySelector('.dialog-close')!.addEventListener('click', () => dialog.close());
  el('logout-button').addEventListener('click', async () => { try { const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(); loginScreen(); } catch { loginScreen('Ocultamos la carta, pero no pudimos revocar la sesión. Vuelve a conectar para cerrar la sesión.'); } });
  el('zoom-in').addEventListener('click', () => landscape?.zoom(1)); el('zoom-out').addEventListener('click', () => landscape?.zoom(-1)); el('map-reset').addEventListener('click', () => { following = false; landscape?.follow(null); const s = world?.people.find(p => p.role === 'S'); if (s) { landscape?.fit(); renderControls(); return; } irAPersona(idDeRol('S', world)); });
  // M3: S e I se encuentran aunque estén fuera de la cámara (la ficha a demanda trae su posición).
  for (const role of ['S', 'I'] as const) el(`focus-${role.toLowerCase()}`).addEventListener('click', () => choosePerson(idDeRol(role, world)));
  el('follow-toggle').addEventListener('click', () => { if (selected.kind === 'tile') return; following = !following; landscape?.follow(following ? selected.id : null, selected.kind); renderControls(); if (mobile()) drawer('inspector', false); });
  el('direct-toggle').addEventListener('click', () => { if (observerOnly) return; control = control === 'direct' ? 'inspect' : 'direct'; renderControls(); if (control === 'direct' && mobile()) drawer('inspector', false); });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-order]')) button.addEventListener('click', () => sendCommand(button.dataset.order as Order));
  el('observe-tool').addEventListener('click', () => { control = 'inspect'; if (pickingWhisper) setPickingWhisper(false); notebook?.close(); el('observe-tool').setAttribute('aria-pressed', 'true'); renderControls(); });
  el<HTMLFormElement>('tile-form').addEventListener('submit', event => { event.preventDefault(); const x = Number(el<HTMLInputElement>('tile-x').value), y = Number(el<HTMLInputElement>('tile-y').value); if (!Number.isInteger(x) || !Number.isInteger(y)) return; selected = { kind: 'tile', x, y }; focusTile(x, y); landscape?.select(selected); inspectorSignature = ''; renderInspector(); if (!el('layers-popover').hidden) toggleLayers(); drawer('inspector', true); });
  el('landscape').addEventListener('keydown', event => { const keyboard = event as KeyboardEvent; if (control !== 'direct' || keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey || keyboard.repeat) return; const key = keyboard.key.toLowerCase(); const offsets: Record<string, [number, number]> = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] }; const offset = offsets[key], p = person(); if (!offset || !p) return; event.preventDefault(); sendCommand('move', { x: p.x + offset[0], y: p.y + offset[1] }); });
  el('game').addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Escape') { if (pickingWhisper) { setPickingWhisper(false); return; } if (!el('layers-popover').hidden) { toggleLayers(); el('layers-toggle').focus(); return; } if (!el('inspector-drawer').hidden && !el('task-palette').hidden) { toggleTasks(false); el('task-toggle').focus(); return; } if (control === 'direct') { control = 'inspect'; renderControls(); if (!el('inspector-drawer').hidden) el('direct-toggle').focus(); else el('landscape').focus(); return; } notebook?.close(); } });
  el('growth-chip').addEventListener('click', () => { selectStatsTab('life'); drawer('stats', true); });
  el('game').addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'h' || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const focus = event.target as HTMLElement | null;
    const tag = focus?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || focus?.isContentEditable) return;
    event.preventDefault();
    toggleLayers();
  });
  el('sound-toggle').addEventListener('click', async () => {
    // Un arranque en curso no admite otra pulsación: dos start() simultáneos abrirían dos AudioContext y solo se guardaría el último.
    if (soundBusy) return;
    const session = uiSession, audio = soundscape, button = el('sound-toggle');
    if (soundEnabled) { soundEnabled = false; soundscape.setMuted(true); }
    else {
      soundEnabled = true; soundBusy = true; button.setAttribute('aria-busy', 'true');
      soundscape.setMuted(false); soundscape.setHidden(document.hidden);
      let started = false;
      try { started = await audio.start(); }
      finally { if (session === uiSession) { soundBusy = false; button.removeAttribute('aria-busy'); } }
      if (session !== uiSession) { audio.stop(); return; }
      if (!started) { soundEnabled = false; message('No se pudo activar el sonido. Puedes explorar sin él.', false); }
    }
    button.setAttribute('aria-pressed', String(soundEnabled));
  });
}

function navigateEntity(event: MouseEvent): void {
  const link = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-person-link], [data-community], [data-recipe], [data-place-x]');
  if (!link || !world) return;
  // A link changes the camera or notebook selection, never submits a gesture.
  if (link.dataset.personLink) { choosePerson(link.dataset.personLink); el('inhabitant-card').focus({ preventScroll: true }); }
  else if (link.dataset.community) {
    focusedCommunity = link.dataset.community; statsSignature = '';
    selectStatsTab('communities'); drawer('stats', true);
    const card = [...el('stats-content').querySelectorAll<HTMLElement>('[data-community-card]')].find(card=>card.dataset.communityCard===link.dataset.community);
    card?.scrollIntoView({ block: 'nearest' }); card?.focus({ preventScroll: true });
  } else if (link.dataset.recipe) {
    focusedRecipe = link.dataset.recipe; statsSignature = '';
    // Opening a procedure is what asks the server for its steps; the snapshot never carries them.
    if (!recipeDetails.has(focusedRecipe)) connection?.requestRecipe(focusedRecipe);
    selectStatsTab('technology'); drawer('stats', true);
    const detail = [...el('stats-content').querySelectorAll<HTMLDetailsElement>('details')].find(detail=>detail.dataset.detail===`recipe-${focusedRecipe}`);
    if (detail) { detail.open = true; detail.scrollIntoView({ block: 'start' }); detail.querySelector('summary')?.focus({ preventScroll: true }); }
  } else if (link.dataset.placeX !== undefined && link.dataset.placeY !== undefined) {
    const x = Number(link.dataset.placeX), y = Number(link.dataset.placeY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    control = 'inspect'; following = false; landscape?.follow(null); landscape?.focus(x,y);
    pick({ kind: 'tile', x, y }); renderControls(); drawer('inspector', true);
  }
}

/** Session-owned V24 windows, network refreshes and camera/audio bridge. */
function startClientUi(): void {
  const vw = window.innerWidth, vh = window.innerHeight;
  const rects = {
    // Cascada inicial: cada ventana nace con su cabecera a la vista (Vidas y Susurros a la izquierda, Inspector y Ajustes a la derecha).
    population: { x: 24, y: 96, width: 390, height: 560 },
    whisper: { x: 64, y: 140, width: 380, height: 500 },
    inspector: { x: vw - 414, y: 96, width: 390, height: 580 },
    settings: { x: vw - 454, y: 140, width: 360, height: 520 },
    stats: { x: Math.max(24, Math.round((vw - 920) / 2)), y: 88, width: Math.min(920, vw - 48), height: Math.min(720, vh - 160) },
  };
  // Ventanas libres solo en escritorio; en móvil rige la hoja única del cuaderno (sin estilos en línea).
  const syncPanels = (): void => {
    for (const page of Object.keys(rects) as NotebookPage[]) {
      const panel = el(`${page}-drawer`);
      if (mobile()) { panels[page]?.destroy(); delete panels[page]; panel.classList.remove('is-floating'); }
      else if (!panels[page]) { panel.classList.add('is-floating'); panels[page] = makeFloatingPanel(panel, { id: page, handleSelector: 'header', defaultRect: rects[page] }); }
    }
  };
  syncPanels();
  panelQuery = matchMedia('(max-width: 760px)'); panelQuery.addEventListener('change', syncPanels); panelSync = syncPanels;
  notebook = new Notebook(el('game'), panels);
  soundscape = new SpatialSoundscape();
  el('settings-body').innerHTML = renderGraphicsSettingsHtml(graphicsSettings);
  landscape?.setGraphicsSettings(graphicsSettings); soundscape.setVolume(graphicsSettings.soundVolume);
  minimap = mountMinimap(el<HTMLCanvasElement>('minimap-canvas'), focusTile);
  uiSession = new AbortController();
  void refreshMap();
  uiTimers.push(setInterval(() => { if (!document.hidden) void refreshMap(); }, 3000));
  uiTimers.push(setInterval(() => {
    if (document.hidden) return;
    if (!el('population-drawer').hidden || !el('whisper-drawer').hidden) void refreshDirectory();
    if (!el('whisper-drawer').hidden) void refreshWhispers();
  }, 2500));
  let previous = '';
  const frame = (): void => {
    uiRaf = requestAnimationFrame(frame); // primero: un fallo de dibujo o de audio no detiene el bucle
    if (document.hidden || !landscape || !world) return;
    try {
      const b = landscape.getViewportBounds(), camera = landscape.camera();
      const viewport = { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
      const key = JSON.stringify(viewport);
      if (key !== previous) {
        previous = key; minimap?.updateViewport(viewport);
        // V24: la ventana pedida al servidor ya no sigue a la cámara paso a paso; las coordenadas salen de la cámara.
        el('camera-coordinates').textContent = `${Math.floor(camera.x)}, ${Math.floor(camera.y)}`;
        if (!whisperPicked && !el('whisper-drawer').hidden) followWhisperTile(); // lo que se ve en el formulario es lo que se envía
      }
      // Con el mundo en pausa (o la cinta detenida) el paisaje conserva sus camas pero no repite golpes sobre un fotograma congelado.
      if (!world.paused && !(dvr?.enabled && !dvr.playing)) soundscape.update(world, { ...viewport, zoom: camera.zoom });
    } catch { /* La cámara visible manda; el minimapa y el sonido son accesorios. */ }
  };
  uiRaf = requestAnimationFrame(frame);
}
function stopClientUi(): void {
  uiSession?.abort(); uiSession = null;
  for (const timer of uiTimers.splice(0)) clearInterval(timer);
  cancelAnimationFrame(uiRaf); minimap?.destroy(); minimap = null;
  notebook?.destroy();
  if (panelQuery && panelSync) panelQuery.removeEventListener('change', panelSync);
  panelQuery = null; panelSync = null;
  for (const page of Object.keys(panels) as NotebookPage[]) { panels[page]?.destroy(); delete panels[page]; }
  directory = null; directoryState = 'loading'; recentWhispers = []; pickingWhisper = false; whisperTile = { x: 0, y: 0 }; whisperPicked = false;
  directoryBusy = mapBusy = whispersBusy = false; mapFailures = 0; mapRetryAt = 0; notebook = null;
}
const uiJson = <T>(url: string, session: AbortController, valid: (data: unknown) => data is T): Promise<T> => fetchJson(url, session.signal, valid);
async function refreshMap(): Promise<void> {
  const session = uiSession; if (!session || mapBusy || document.hidden || Date.now() < mapRetryAt) return; mapBusy = true;
  try { const data = await uiJson('/api/worldmap', session, validMap); if (session !== uiSession) return; mapFailures = 0; minimap?.updateMap(data); el('minimap-status').textContent = `${number(data.discoveredChunks)} regiones descubiertas`; }
  catch { if (session === uiSession) { mapFailures = Math.min(mapFailures + 1, 5); mapRetryAt = Date.now() + 3000 * 2 ** mapFailures; el('minimap-status').textContent = 'Mapa sin actualizar · reintentando'; } }
  finally { if (session === uiSession) mapBusy = false; }
}
async function refreshDirectory(): Promise<void> {
  const session = uiSession; if (!session || directoryBusy || document.hidden) return; directoryBusy = true;
  try { const data = await uiJson('/api/directory', session, validDirectory); if (session !== uiSession) return; directory = data; directoryState = 'ready'; }
  catch { if (session === uiSession) directoryState = 'failed'; } // se conserva el último directorio válido: su paso dice cuán viejo es
  finally {
    if (session === uiSession) {
      directoryBusy = false;
      if (!el('population-drawer').hidden) renderPopulation();
      if (!el('whisper-drawer').hidden) renderWhisperPeople();
      if (!el('stats-drawer').hidden) renderStats();
    }
  }
}
async function refreshWhispers(): Promise<void> {
  const session = uiSession; if (!session || whispersBusy || document.hidden) return; whispersBusy = true;
  try { const data = await uiJson('/api/whispers', session, validWhispers); if (session !== uiSession) return; recentWhispers = data.whispers; }
  catch { /* Received world whispers remain available offline. */ }
  finally { if (session === uiSession) { whispersBusy = false; renderWhispers(); } }
}
function renderWhisperPeople(): void {
  const select = el<HTMLSelectElement>('whisper-person'), previous = select.value || activePersonId;
  const all = directory?.people ?? world?.people ?? [];
  // Un mundo grande no cabe en un desplegable: S, I y la persona elegida primero, luego por nombre hasta el tope.
  const rank = (p: { id: string; role: string }): number => p.id === previous ? 0 : p.role === 'S' ? 1 : p.role === 'I' ? 2 : 3;
  const people = all.length > DIRECTORY_ROWS ? [...all].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'es')).slice(0, DIRECTORY_ROWS) : all;
  const html = people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.role === 'S' || p.role === 'I' ? ` (${esc(p.role)})` : ''} · ${esc(p.x)}, ${esc(p.y)}</option>`).join('')
    + (all.length > people.length ? `<option disabled>… y ${esc(number(all.length - people.length))} más (solo se listan 300): usa «A quien pase por el lugar»</option>` : '');
  if (select.innerHTML !== html) { select.innerHTML = html; if (people.some(p => p.id === previous)) select.value = previous; }
}
function renderWhispers(): void {
  const whispers = new Map((world?.whispers ?? []).map(w => [w.id, w]));
  // Polling reflects the live world; tape snapshots remain the truth while replaying history.
  if (!dvr?.enabled || dvr.atLiveEdge) for (const w of recentWhispers) {
    const current = whispers.get(w.id);
    const changedAt = (item: DivineWhisper): number => item.resolvedTick ?? item.heardTick ?? item.createdTick;
    if (!current || changedAt(w) >= changedAt(current)) whispers.set(w.id, w);
  }
  const labels = { latent: 'Latente', heard: 'Escuchado', fulfilled: 'Cumplido', faded: 'Desvanecido' };
  const intents: Record<DivineWhisperIntent, string> = { travel: 'Viajar', explore: 'Explorar', gather: 'Recolectar', build: 'Construir', craft: 'Crear', tend: 'Cuidar fauna' };
  el('whisper-list').innerHTML = [...whispers.values()].sort((a, b) => b.createdTick - a.createdTick).map(w => `<article class="whisper-card"><span class="whisper-state">${esc(labels[w.status] ?? w.status)}</span><strong>${esc(w.personName ?? w.personId ?? 'Quien pase por el lugar')}</strong><p>${esc(w.note)}</p><button type="button" data-whisper-x="${esc(w.x)}" data-whisper-y="${esc(w.y)}">${esc(w.x)}, ${esc(w.y)} · ${esc(intents[w.intent] ?? w.intent)}</button></article>`).join('') || '<p class="drawer-note">Aún no hay susurros recibidos.</p>';
}
function renderLayers(): void {
  landscape?.setActiveLayers(activeLayers);
  const options = el('layers-options'), focused = (document.activeElement as HTMLElement | null)?.dataset?.layer;
  options.innerHTML = renderLayersPopoverHtml(activeLayers);
  if (focused) options.querySelector<HTMLElement>(`[data-layer="${focused}"]`)?.focus({ preventScroll: true });
  const summary = el('layers-summary'); summary.hidden = !activeLayers.size; summary.textContent = activeLayersSummary(activeLayers);
  const legend = el('heat-legend'); legend.hidden = !activeLayers.size;
  legend.innerHTML = MAP_LAYER_CATALOG.filter(layer => activeLayers.has(layer.id)).map(layer => `<p class="layer-legend-row"><i class="layer-swatch" style="background:${layer.color}"></i><span><strong>${esc(layer.label)}</strong> · ${esc(layer.description)}</span><button type="button" data-remove-layer="${layer.id}" aria-label="Quitar ${esc(layer.label)}">×</button></p>`).join('') + (activeLayers.size ? '<button type="button" data-action="clear-layers">Limpiar</button>' : '');
}
function toggleLayers(): void {
  const panel = el('layers-popover'); panel.hidden = !panel.hidden;
  if (!panel.hidden && mobile()) notebook?.close();
  el('layers-toggle').setAttribute('aria-expanded', String(!panel.hidden));
}
function wireClientUi(): void {
  renderLayers();
  el('layers-toggle').addEventListener('click', toggleLayers);
  const layerClick = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="clear-layers"], [data-remove-layer]'); if (!button) return;
    activeLayers = isMapLayerId(button.dataset.removeLayer) ? toggleLayer(activeLayers, button.dataset.removeLayer) : clearLayers(); renderLayers();
  };
  el('layers-options').addEventListener('change', event => { const id = (event.target as HTMLElement).dataset.layer; if (isMapLayerId(id)) { activeLayers = toggleLayer(activeLayers, id); renderLayers(); } });
  el('layers-options').addEventListener('click', layerClick); el('heat-legend').addEventListener('click', layerClick);
  const applyGraphics = (): void => {
    graphicsSettings = sanitizeGraphicsSettings(graphicsSettings);
    try { saveGraphicsSettings(localStorage, graphicsSettings); } catch { /* Private browsing. */ }
    graphicsChosen = true;
    // Ligero ⇄ Ultra/Equilibrado cambia el modo de dibujo (GPU, dpr, fps y cadencia del mundo), que se decide al entrar: se reentra.
    if (modoDeAjustes(graphicsSettings) !== modoActual) { enterWorld(sessionFlags); return; }
    landscape?.setGraphicsSettings(graphicsSettings); soundscape.setVolume(graphicsSettings.soundVolume);
    el('setting-min-zoom-out').textContent = minZoomLabel(graphicsSettings.minZoom);
    el('setting-sound-volume-out').textContent = `${Math.round(graphicsSettings.soundVolume * 100)} %`;
  };
  el('settings-body').addEventListener('click', event => { const preset = (event.target as HTMLElement).closest<HTMLElement>('[data-preset]')?.dataset.preset; if (!GRAPHICS_PRESETS.includes(preset as GraphicsPreset)) return; graphicsSettings = applyPreset(preset as GraphicsPreset, graphicsSettings); el('settings-body').innerHTML = renderGraphicsSettingsHtml(graphicsSettings); applyGraphics(); });
  const settingChanged = (event: Event): void => {
    const input = event.target as HTMLInputElement, key = input.dataset.setting;
    if (key === 'minZoom') graphicsSettings.minZoom = Number(input.value);
    else if (key === 'maxDpr') graphicsSettings.maxDpr = ([1, 1.5, 2] as const)[Number(input.value)] ?? 1.5;
    else if (key === 'soundVolume') graphicsSettings.soundVolume = Number(input.value);
    else if (key === 'shadows' || key === 'atmosphere' || key === 'vegetationSway' || key === 'waterRipples' || key === 'cutaways' || key === 'chemicalGlint') graphicsSettings[key] = input.checked;
    else return;
    applyGraphics();
  };
  el('settings-body').addEventListener('input', settingChanged);
  el('minimap-expand').addEventListener('click', () => { const expanded = el('world-minimap').classList.toggle('is-expanded'); el('minimap-expand').setAttribute('aria-expanded', String(expanded)); el('minimap-expand').textContent = expanded ? 'Reducir mapa' : 'Ampliar mapa'; const bounds = landscape?.getViewportBounds(); if (bounds) minimap?.updateViewport({ x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }); });
  el('tame-filter').addEventListener('change', renderPopulation);
  el('whisper-mode').addEventListener('change', () => { el('whisper-person-label').hidden = el<HTMLSelectElement>('whisper-mode').value === 'place'; });
  el('whisper-pick').addEventListener('click', () => { const next = !pickingWhisper; control = 'inspect'; if (next && mobile()) drawer('whisper', false); setPickingWhisper(next); });
  el('whisper-list').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-whisper-x]'); if (button) focusTile(Number(button.dataset.whisperX), Number(button.dataset.whisperY)); });
  el('whisper-form').addEventListener('submit', async event => {
    event.preventDefault(); const session = uiSession; if (!session) return;
    const isPerson = el<HTMLSelectElement>('whisper-mode').value === 'person';
    const id = el<HTMLSelectElement>('whisper-person').value;
    const recipient = (directory?.people ?? world?.people ?? []).find(p => p.id === id);
    if (isPerson && !recipient) { el('whisper-status').textContent = 'Elige un habitante recibido.'; return; }
    // El lugar es el destino del susurro; la persona solo decide quién lo puede escuchar.
    const request: DivineWhisperRequest = { personId: isPerson ? id : null, x: whisperTile.x, y: whisperTile.y, intent: el<HTMLSelectElement>('whisper-intent').value as DivineWhisperIntent, note: el<HTMLInputElement>('whisper-note').value.slice(0, 120) };
    const button = el<HTMLButtonElement>('whisper-submit'); button.disabled = true; el('whisper-status').textContent = 'Enviando susurro…';
    try {
      const response = await fetch('/api/whisper', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.any([session.signal, AbortSignal.timeout(10000)]) });
      if (session !== uiSession) return;
      if (response.status !== 201) throw new Error(response.status === 401 || response.status === 403 ? 'La sesión no permite enviar el susurro.' : 'El mundo no aceptó el susurro.');
      const result: unknown = await response.json();
      if (session !== uiSession) return;
      if (!validWhisperResult(result)) { el('whisper-status').textContent = 'El mundo recibió el susurro, pero su confirmación llegó ilegible; míralo en la lista.'; void refreshWhispers(); return; }
      recentWhispers = [...recentWhispers.filter(w => w.id !== result.whisper.id), result.whisper]; renderWhispers();
      el('whisper-status').textContent = 'Susurro recibido por el mundo; escucharlo y actuar dependen de cada vida.';
    } catch (error) { if (session === uiSession) el('whisper-status').textContent = error instanceof Error && error.message.startsWith('El mundo') ? error.message : 'No se pudo confirmar el envío. Revisa los susurros antes de reintentar.'; }
    finally { if (session === uiSession) button.disabled = false; }
  });
}

function receiveWorld(next: WorldView, tilesToIngest: readonly Tile[] = next.tiles, changedTiles?: readonly Tile[]): void {
  // T036(g): un procedimiento puede reformularse mientras el mundo avanza. La caché describe un
  // paso concreto: al cambiar `tick` deja de ser válida y se vuelve a preguntar bajo demanda.
  // M3: la ficha a demanda ya no se borra en cada paso (ver PERSONA_REFRESCO); las definiciones de receta
  // son inmutables por id y nunca se invalidan por tick (T041).
  recordarVistos(next);
  tileCache.ingest(tilesToIngest, next.tick);
  const sNow = next.people.find(p => p.role === 'S'); if (sNow) landscape?.setHome({ x: sNow.x, y: sNow.y });
  const first = world === null; world = next; landscape?.update(next, changedTiles); el('map-loading').hidden = true; el('world-day').textContent = `Día ${next.day}`; el('world-phase').textContent = `${phases[next.phase]}${next.weather === 'rain' ? ' · lluvia' : ''}`;
  const territorio = rotuloTerritorio(next); el('world-extent').textContent = territorio.texto; el('world-extent').title = territorio.ayuda;
  renderTelemetryHud(next);
  cronica.acumular(next.events);
  if (first) {
    try { hitosGuardados = readHitos(localStorage, next); } catch { hitosGuardados = []; }
    lastVisit = readVisit(next);
    const p = next.people.find(p => p.role === 'S') ?? next.people[0]; if (p) { activePersonId = p.id; selected = { kind: 'person', id: p.id }; landscape?.select(selected); }
    if (!mobile()) drawer('inspector', true);
    if (lastVisit !== null) returnCard(next, lastVisit);
  }
  if (!el('whisper-drawer').hidden) { renderWhisperPeople(); renderWhispers(); }
  if (!el('population-drawer').hidden) renderPopulation();
  renderInspector(); renderStatus(); if (el<HTMLDialogElement>('chronicle-dialog').open) renderJournal();
}
/** V21: en observación pura toda ayuda de la lista se completa con la nota única (sin «dar una orden»). */
function observerNote(text: string): string { return observerOnly ? `${OBSERVER_NOTE} ${text}` : text; }
function renderTelemetryHud(current: WorldView): void {
  for (const kpi of telemetryKpis(current)) {
    const button = el('hud-telemetry').querySelector<HTMLButtonElement>(`[data-hud-nav="${kpi.nav}"]`)!;
    const value = button.querySelector<HTMLElement>('[data-hud-value]')!;
    if (value.textContent !== kpi.value) value.textContent = kpi.value;
    const extra = button.querySelector<HTMLElement>('[data-hud-extra]');
    if (extra && extra.textContent !== (kpi.summary ?? '')) extra.textContent = kpi.summary ?? '';
    button.title = kpi.detail;
    button.setAttribute('aria-label', `${kpi.label}: ${kpi.value}. ${kpi.summary ?? ''} ${kpi.detail}`);
    button.dataset.health = kpi.health ?? 'unknown';
  }
  el('viewport-census').textContent = viewportCensusText(current);
}
function renderPopulation(): void {
  if (!world) return;
  const query = el<HTMLInputElement>('population-search').value.trim().toLocaleLowerCase('es');
  const fauna = populationKind === 'animals', tameOnly = el<HTMLInputElement>('tame-filter').checked;
  const labels = { people: 'Habitantes', animals: 'Fauna', communities: 'Comunidades', structures: 'Obras' };
  el('population-heading').textContent = labels[populationKind];
  el('population-search-label').textContent = `Buscar en ${labels[populationKind]}`;
  el<HTMLInputElement>('population-search').placeholder = 'Nombre, oficio, comunidad, especie o x,y';
  el('species-filter-label').hidden = !fauna; el('species-legend').hidden = !fauna; el('tame-filter-label').hidden = !fauna;
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-population]')) tab.setAttribute('aria-pressed', String(tab.dataset.population === populationKind));
  type Row = { id?: string; kind: 'person' | 'animal' | 'place' | 'herd'; name: string; detail: string; x: number; y: number; role?: string; species?: string; tame?: boolean };
  let rows: Row[] = [];
  if (populationKind === 'people') {
    rows = (directory?.people ?? world.people).map<Row>(p => {
      const specialty = 'craftFocus' in p ? p.craftFocus : 'specialty' in p ? p.specialty : '';
      const community = (directory?.communities ?? world!.communities ?? []).find(c => c.id === p.communityId)?.name ?? p.communityId ?? '';
      return { id: p.id, kind: 'person', name: p.name, role: p.role, x: p.x, y: p.y, detail: `${specialty ?? ''} · ${community} · ${p.role === 'S' || p.role === 'I' ? p.role : 'Vecino'} · ${actions[p.action as PersonView['action']] ?? p.action}` };
    }).sort((a, b) => (a.role === 'S' ? 0 : a.role === 'I' ? 1 : 2) - (b.role === 'S' ? 0 : b.role === 'I' ? 1 : 2) || a.name.localeCompare(b.name, 'es'));
  } else if (fauna) {
    if (directory) rows = directory.herds.map(h => ({ kind: 'herd', name: speciesPlural[h.species as AnimalView['species']] ?? h.species, species: h.species, x: h.x, y: h.y, tame: h.tameCount > 0 || h.avgHabituation >= .45, detail: `${h.count} individuos · ${h.tameCount} mansos · habituación ${percentage(h.avgHabituation)}` }));
    else rows = (world.animals ?? []).map(a => ({ id: a.id, kind: 'animal', name: speciesNames[a.species], species: a.species, x: a.x, y: a.y, tame: (a.habituation ?? 0) >= .45, detail: `${a.id} · ${animalActions[a.action]} · G${a.generation}` }));
    const species = el<HTMLSelectElement>('species-filter').value;
    rows = rows.filter(row => (!species || row.species === species) && (!tameOnly || row.tame));
  } else if (populationKind === 'communities') rows = (directory?.communities ?? world.communities ?? []).map(c => ({ kind: 'place', name: c.name, x: c.x, y: c.y, detail: `${c.memberCount ?? ('members' in c ? c.members.length : 0)} habitantes · comunidad` }));
  else rows = (directory?.structures ?? world.structures ?? []).map(s => ({ kind: 'place', name: s.name, x: s.x, y: s.y, detail: `${typeof s.cells === 'number' ? s.cells : s.cells?.length ?? 1} casillas · obra / poliominó · estado ${percentage(s.condition)}` }));
  const matches = rows.filter(row => `${row.name} ${row.detail} ${row.species ?? ''} ${row.x},${row.y} ${row.x}, ${row.y}`.toLocaleLowerCase('es').includes(query));
  const totals = populationKind === 'people' ? directory?.totalPeople : fauna ? directory?.totalAnimals : populationKind === 'structures' ? directory?.totalStructures : directory?.communities.length;
  const shown = matches.slice(0, DIRECTORY_ROWS);
  const found = `${number(matches.length)} coincidencias${matches.length > shown.length ? ` · se muestran ${number(shown.length)}` : ''}`;
  // Sin directorio global, el recuento honesto de siempre: lo recibido por la cámara frente al censo del mundo.
  el('population-count').textContent = !directory && populationKind === 'people' ? `${rotuloRecuento(world)}${query ? ` · ${found}` : ''}` : `${number(totals ?? rows.length)}${directory ? ' en el mundo' : ' recibidos'} · ${found}`;
  el('population-note').textContent = observerNote(directory ? `Directorio global · paso ${directory.tick}${directoryState === 'failed' ? ' (no se pudo actualizar; se reintenta solo)' : ''}.${fauna ? ' La fauna está agrupada en rebaños; toca uno para inspeccionar el lugar y sus individuos recibidos.' : ''}` : directoryState === 'loading' ? 'Cargando el directorio global… mientras tanto se muestra lo recibido por la cámara.' : 'Directorio global no disponible. Se muestra solo la instantánea recibida por la cámara; se reintenta solo.');
  const html = shown.map(row => `<button type="button" class="population-person${row.kind === 'animal' ? ' animal-row' : ''}"${row.kind === 'person' && row.id ? ` data-person="${esc(row.id)}" aria-pressed="${row.id === activePersonId && selected.kind === 'person'}"` : row.kind === 'animal' && row.id ? ` data-animal="${esc(row.id)}" aria-pressed="${selected.kind === 'animal' && selected.id === row.id}"` : ''} data-directory-kind="${row.kind}" data-directory-id="${esc(row.id ?? '')}" data-directory-x="${esc(row.x)}" data-directory-y="${esc(row.y)}"><span><strong>${esc(row.name)}${row.tame ? ' <b class="tame-badge">Habituado / manso</b>' : ''}</strong><small>${esc(row.detail)}</small><small>${esc(row.x)}, ${esc(row.y)}</small></span>${icon.arrow}</button>`).join('') + (matches.length > shown.length ? '<p class="drawer-note">Hay más resultados: escribe un nombre, oficio, comunidad o coordenadas para afinar la búsqueda.</p>' : '') || '<p class="drawer-note">No hay coincidencias en la información recibida.</p>';
  if (populationSignature !== html) { populationSignature = html; el('population-list').innerHTML = html; }
}
function replacePersonCard(html: string): void {
  const card = el('inhabitant-card');
  const restore = retainViewState(card);
  card.innerHTML = html;
  selectInspectorTab(inspectorTab, false);
  syncSelectionLabel();
  restore();
}
/** M2: «IR A S I · Ficha». El botón de ficha no repite S o I (ya tienen su botón, que queda marcado). */
function syncSelectionLabel(): void {
  const title = el('inspector-title').textContent ?? '';
  const selection = selected, role = selection.kind === 'person' ? world?.people.find(p => p.id === selection.id)?.role ?? visto(selection.id)?.role ?? (selection.id === idDeRol('S', world) ? 'S' : selection.id === idDeRol('I', world) ? 'I' : undefined) : undefined;
  el('selection-label').textContent = role === 'S' || role === 'I' ? 'Ficha' : title;
  el('inspector-toggle').setAttribute('aria-label', `Ficha de ${title}`);
  el('focus-s').setAttribute('aria-pressed', String(role === 'S'));
  el('focus-i').setAttribute('aria-pressed', String(role === 'I'));
}
function selectInspectorTab(tab: typeof inspectorTab, resetScroll = true): void {
  if (!document.getElementById(`inspector-section-${tab}`)) tab = 'now';
  inspectorTab = tab;
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]')) {
    const active = button.dataset.inspectorTab === tab;
    button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
  }
  for (const section of el('inhabitant-card').querySelectorAll<HTMLElement>('[role="tabpanel"]')) section.hidden = section.id !== `inspector-section-${tab}`;
  if (resetScroll) el('inhabitant-card').scrollTop = 0;
}
function toggleTasks(open: boolean): void {
  el('task-palette').hidden = !open;
  el('task-toggle').setAttribute('aria-expanded', String(open));
  el('task-label').textContent = open ? 'Cerrar tareas' : 'Dar una tarea';
  el('task-toggle').classList.toggle('is-open', open);
}
function renderInspector(): void {
  if (!world) return;
  el('direct-toggle').hidden = selected.kind !== 'person';
  el('inspector-tabs').hidden = selected.kind === 'tile';
  el('inspector-tab-kit').hidden = selected.kind !== 'person';
  if (selected.kind === 'animal') {
    const animalId = selected.id, animal = world.animals?.find(a => a.id === animalId);
    el('person-controls').hidden = true; el('person-primary').hidden = !animal;
    el('person-primary').classList.toggle('animal-primary', true);
    if (!animal) {
      el('inspector-tabs').hidden = true;
      el('inspector-title').textContent = 'Fuera de esta vista';
      replacePersonCard('<p class="drawer-note">Este individuo ya no aparece en la región recibida. Puede haber salido de la cámara o terminado su vida; la crónica conserva los episodios registrados.</p>');
      if (following) { following = false; landscape?.follow(null); }
      inspectorSignature = ''; return;
    }
    const signature = JSON.stringify(animal); if (signature === inspectorSignature) return; inspectorSignature = signature;
    el('inspector-title').textContent = speciesNames[animal.species];
    replacePersonCard(`<section id="inspector-section-now" role="tabpanel" aria-labelledby="inspector-tab-now"><div class="game-person-heading"><div class="animal-avatar animal-portrait" style="--animal-color:${animalColors[animal.species]}" aria-hidden="true">${animalSilhouette(animal.species)}</div><div><strong>Una vida del paisaje</strong><span class="agency-state">${esc(animal.id)} · generación ${esc(animal.generation)}</span></div></div><p class="game-current-action">${animalActions[animal.action]} <span>· ${number(animal.x, 1)}, ${number(animal.y, 1)}</span></p><p class="game-reason">${esc(animal.reason)}</p><div class="game-needs"><h3>Necesidades de este individuo</h3>${meter('Energía', animal.energy)}${meter('Hambre', animal.hunger)}${meter('Sed', animal.thirst)}${meter('Cansancio', animal.fatigue)}${meter('Salud', animal.health)}</div>${renderAnimalTelemetry(animal)}<p class="drawer-note">Observas un animal autónomo. Su actividad y sus desplazamientos llegan del mundo.</p></section><section id="inspector-section-story" role="tabpanel" aria-labelledby="inspector-tab-story"><p class="drawer-note">La edad, generación y progenitores recibidos se muestran en Ahora. No se ha recibido una crónica individual de este animal.</p></section>`);
    return;
  }
  el('person-primary').classList.toggle('animal-primary', false);
  if (selected.kind === 'person') {
    const p = person();
    if (!p) {
      const id = selected.id, legacy = world.demography?.recent.find(entry=>entry.id===id);
      // M1: estar fuera de `people` no es morir. Solo `demography.recent` acredita una muerte; si no,
      // se pregunta al servidor (la ficha a demanda mira el mundo entero) y se dice lo que contestó.
      const estado = ausenteEstado(world, id, personaVivo.get(id));
      const cachedAbsent = personaDetails.get(id);
      if (estado === 'comprobando' || (estado === 'fuera' && (!cachedAbsent || world.tick - cachedAbsent.tick >= PERSONA_REFRESCO))) connection?.requestPersona(id);
      el('person-controls').hidden = true; el('person-primary').hidden = true; el('direct-toggle').hidden = true;
      el('inspector-tabs').hidden = true;
      // S e I se llaman así en el mundo (createWorld); su botón ya lo dice aunque aún no se les haya visto.
      const name = legacy?.name ?? nombreConocido(id, world) ?? (id === idDeRol('S', world) ? 'S' : id === idDeRol('I', world) ? 'I' : undefined);
      el('inspector-title').textContent = name ?? 'Fuera de esta vista';
      // M3: la posición exacta llega con la ficha a demanda; si no, la última en que se la vio.
      const detail = cachedAbsent?.detail, known = visto(id);
      const where = detail?.x !== undefined && detail.y !== undefined ? { x: detail.x, y: detail.y, exact: true } : known?.x !== undefined && known.y !== undefined ? { x: known.x, y: known.y, exact: false } : null;
      const away = `<p class="game-reason" data-absent="fuera">Vive fuera de esta vista${where ? `, en ${esc(number(where.x))}, ${esc(number(where.y))}` : ''}.</p><p class="drawer-note">${buscando === id ? 'Yendo a su posición; la ficha completa aparece al entrar en cuadro.' : where && !where.exact ? `Última posición vista en esta visita (paso ${esc(number(known?.tick))}).` : 'Sigue en el mundo, fuera de la zona que muestra la cámara.'}</p>${buscando === id ? '' : `<button class="button secondary" data-person-link="${esc(id)}">${icon.focus} Ir a ${esc(name ?? 'su posición')}</button>`}`;
      // T036(b): la «Historia» de una identidad difunta es su contexto de muerte (FR-006). Un evento
      // sin campo `death` (crónica antigua) no dibuja nada, en vez de un hueco que parezca un dato.
      const farewell = world.events.find(event => event.kind === 'death' && event.actors.includes(id));
      replacePersonCard(legacy ? `<p class="game-reason">Esta vida terminó en el paso ${esc(legacy.diedAt)}.</p><p class="drawer-note">${esc(deathCauses[legacy.cause] ?? legacy.cause)}</p><p class="drawer-note">Generación ${esc(legacy.generation)}. Su historia permanece en la crónica del mundo.</p>${farewell ? deathHistory(farewell) : ''}` : estado === 'fuera' ? away : estado === 'no-servido' ? '<p class="drawer-note" data-absent="no-servido">El servidor no tiene ahora a esta identidad entre las vidas del mundo. Si murió hace tiempo, su despedida ya no está entre las 32 más recientes.</p>' : `<p class="drawer-note" data-absent="comprobando">${buscando === id ? 'Buscando su posición en el mundo…' : 'Fuera de esta vista. Comprobando con el servidor si sigue en el mundo…'}</p>`);
      if (following) { following=false; landscape?.follow(null); } control='inspect'; inspectorSignature='';return;
    }
    // T036(h): la biografía no viaja en el `state`; se pide al abrir la ficha y se cachea por tick.
    const cached = personaDetails.get(p.id);
    if (!cached || world.tick - cached.tick >= PERSONA_REFRESCO || world.tick < cached.tick) connection?.requestPersona(p.id);
    const persona = cached?.detail ?? undefined;
    const ownCommunity = p.communityId ? world.communities?.find(c => c.id === p.communityId) ?? null : null;
    const signature = JSON.stringify([p, persona ?? null, world.events.map(event => event.id), ownCommunity, world.blueprints, world.technology?.items.filter(item=>item.ownerId===p.id), world.technology?.knowledge?.find(entry=>entry.actorId===p.id) ?? null, world.technology?.recipes, world.people.filter(q => q.role !== 'neighbor').map(q => [q.role, q.x, q.y])]); if (signature === inspectorSignature) return; inspectorSignature = signature;
    el('inspector-title').textContent = p.name; el('person-controls').hidden = false; el('person-primary').hidden = false; const source = world.memories.find(m => m.text === p.recentMemory)?.source;
    // The progress meter is rendered by the always-visible telemetry below.
    const sections = inheritedAndLearned(persona ? { ...p, working: false, experiences: persona.experiences, trust: persona.trust } : { ...p, working: false }, world, persona?.recipeIds, persona ?? null, id => cronica.get(id) ?? world?.events.find(event => event.id === id), cronica.todos());
    const color = /^#[\da-f]{3,8}$/i.test(p.color) ? p.color : '#a4805b';
    replacePersonCard(`<section id="inspector-section-now" role="tabpanel" aria-labelledby="inspector-tab-now"><div class="game-person-heading"><div class="pixel-portrait ${p.role === 'I' ? 'portrait-i' : ''}" style="--person-color:${color}" aria-hidden="true"><span class="pixel-body"></span></div><div><strong>${esc(p.specialty ? enClaro(p.specialty, {}, 'especialidad') : 'Su camino está tomando forma')}</strong><span class="agency-state ${p.controlMode === 'directed' ? 'is-directed' : ''}">${p.controlMode === 'directed' ? 'Siguiendo una orden' : 'Actuando por su cuenta'}</span></div></div><p class="game-current-action">${actions[p.action]} <span>· ${esc(p.x)}, ${esc(p.y)}</span></p><p class="game-reason">${esc(enClaro(p.reason, { world }))}</p><div class="game-needs"><h3>Ahora necesita ${esc(p.need.toLocaleLowerCase('es'))}</h3>${meter('Energía', p.energy)}${meter('Hambre', p.hunger)}${p.thirst === undefined ? '' : meter('Sed', p.thirst)}${meter('Cansancio', p.fatigue)}</div>${renderPersonTelemetry(p)}${destinationLink(p)}${sections.now}</section><section id="inspector-section-kit" role="tabpanel" aria-labelledby="inspector-tab-kit"><h3 class="section-title">Lo que lleva y sabe hacer</h3><div class="material-pouch"><span>${icon.leaf}<strong>${number(p.materials?.wood)}</strong> madera</span><span>${icon.hammer}<strong>${number(p.materials?.stone)}</strong> piedra</span></div>${personBlueprint(p, world) ? `<details class="person-detail" data-detail="blueprint"><summary>Proyecto que sabe construir</summary>${blueprintCard(personBlueprint(p, world)!, world)}</details>` : ''}${sections.kit}</section><section id="inspector-section-story" role="tabpanel" aria-labelledby="inspector-tab-story"><h3 class="section-title">Una vida entre otras</h3>${sections.story}${recentEvidence(world, p.id, cronica.todos())}${p.recentMemory ? `<details class="person-detail memory-detail" data-detail="memory"><summary>Algo que lleva consigo</summary><p>${esc(source ? p.recentMemory : enClaro(p.recentMemory, { world }))}</p><small>${source === 'sample' ? 'RECUERDO DE PRUEBA · NO ES BIOGRAFÍA' : source === 'approved' ? 'RECUERDO APROBADO' : 'EXPERIENCIA DEL MUNDO SIMULADO'}</small></details>` : ''}</section>`);
  } else {
    const position = selected, tile = world.tiles.find(t => t.x === position.x && t.y === position.y); el('person-controls').hidden = true; el('person-primary').hidden = true;
    if (!tile) { el('inspector-title').textContent = 'Otra región'; replacePersonCard('<p class="drawer-note">Esperando esta parte del paisaje. Recorrer con la cámara no añade hechos a la crónica.</p>'); return; }
    const place = world.places.find(p => Math.hypot(p.x - tile.x, p.y - tile.y) < 1.5); const structures = world.structures?.filter(s => s.cells?.length ? s.cells.some(c => c.x === tile.x && c.y === tile.y) : tile.x >= s.x && tile.x < s.x + (s.footprint?.width ?? 1) && tile.y >= s.y && tile.y < s.y + (s.footprint?.height ?? 1)) ?? []; const reposo = enReposo(world, tile.x, tile.y) === true; const signature = JSON.stringify([tile, place, structures, world.blueprints, world.animals?.filter(a => a.x === tile.x && a.y === tile.y), reposo]); if (signature === inspectorSignature) return; inspectorSignature = signature; el('inspector-title').textContent = place?.name ?? (reposo ? biomes[tile.biome ?? ''] ?? terrains[tile.terrain] : terrains[tile.terrain]);
    replacePersonCard(`<p class="tile-biome">${esc(biomes[tile.biome ?? ''] ?? terrains[tile.terrain])} <span>· ${esc(tile.x)}, ${esc(tile.y)}</span></p>${reposo ? '<p class="rest-zone-note" data-rest-zone>Zona en reposo: el servidor no simula esta región ahora; lo que ves es su estado guardado o una vista previa generada con la semilla. Cambiará cuando alguien llegue.</p>' : ''}${structures.map(structure=>structureCard(structure, world)).join('')}${structures.length ? '<details class="person-detail" data-detail="structure-ground"><summary>Suelo y recursos del lugar</summary>' : ''}<p class="game-reason">${esc((structures.length ? undefined : place?.description) ?? 'El terreno y los recursos abren posibilidades distintas para cada habitante.')}</p><div class="game-needs"><h3>Recursos del lugar</h3>${meter('Humedad', tile.moisture)}${meter('Vegetación', tile.vegetation)}${meter('Alimento', tile.food)}</div><div class="material-pouch"><span>${icon.leaf}<strong>${resourceQuantity(tile.wood ?? 0)}</strong> madera</span><span>${icon.hammer}<strong>${resourceQuantity(tile.stone ?? 0)}</strong> piedra</span></div>${renderTileTelemetry(tile, world.geologyKey)}<div class="tile-facts">${tile.drinkingWater !== undefined ? `<span>Agua en el terreno<strong>${resourceQuantity(tile.drinkingWater)} u.</strong></span>` : ''}${world.animals === undefined && tile.species && tile.fauna !== undefined ? `<span>${esc(({ hare: 'Liebres', deer: 'Venados', boar: 'Jabalíes', fish: 'Peces' } as Record<string, string>)[tile.species] ?? tile.species)}<strong>${number(tile.fauna)} animales</strong></span>` : ''}${tile.cultivation !== undefined ? `<span>Cultivo<strong>${percentage(tile.cultivation)}</strong></span>` : ''}${tile.fertility !== undefined ? `<span>Fertilidad<strong>${percentage(tile.fertility)}</strong></span>` : ''}${tile.traffic !== undefined ? `<span>Huellas de paso<strong>${number(tile.traffic, 1)}</strong></span>` : ''}</div>${structures.length ? '</details>' : ''}${world.animals ? `<p class="drawer-note">${world.animals.filter(a => a.x === tile.x && a.y === tile.y).length} animales individuales en esta casilla.</p>` : ''}${place ? `<p class="drawer-note" data-place-gatherings>${place.gatherings ? `Aquí se compartió comida ${number(place.gatherings)} ${place.gatherings === 1 ? 'vez' : 'veces'}.` : 'Aquí todavía no se ha compartido comida.'}</p>` : ''}<p class="drawer-note">${observerOnly ? OBSERVER_NOTE : 'Selecciona un habitante para dar una orden; puedes compartir un susurro desde Susurros.'}</p>`);
  }
}
function renderControls(): void {
  syncPickingMode();
  const selection = selected;
  if (!document.getElementById('direct-toggle')) return; const blocked = status !== 'live' || !!world?.paused || pending || !world || !person() || selected.kind !== 'person';
  el<HTMLButtonElement>('direct-toggle').disabled = blocked; el('direct-toggle').setAttribute('aria-pressed', String(control === 'direct')); el('follow-toggle').setAttribute('aria-pressed', String(following));
  el<HTMLButtonElement>('task-toggle').disabled = blocked;
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-order]')) button.disabled = blocked;
  el('mode-indicator').hidden = control !== 'direct' && !following; el('mode-indicator').textContent = control === 'direct' ? `Dirigir a ${person()?.name ?? ''}: toca un destino · WASD mueve una casilla · Esc sale` : `Siguiendo a ${selected.kind === 'animal' ? (world?.animals?.find(a=>a.id===(selection.kind==='animal'?selection.id:'')) ? speciesNames[world.animals.find(a=>a.id===(selection.kind==='animal'?selection.id:''))!.species] : 'un animal') : person()?.name ?? ''} · arrastra para liberar la cámara`;
  el('control-help').textContent = pending ? 'Esperando confirmación del mundo.' : world?.paused ? 'Mundo en pausa · las tareas esperan.' : status !== 'live' ? 'Sin conexión para dar tareas.' : control === 'direct' ? 'Toca un destino · WASD camina · Esc sale.' : 'Una tarea cambia su actividad. Sus necesidades siguen contando.';
  el('game').classList.toggle('direct-mode', control === 'direct');
}
function renderStatus(): void {
  if (!document.getElementById('connection-label')) return; const paused = !!world?.paused; const tape = !!dvr?.enabled && !!world; el('connection-label').textContent = paused ? 'En pausa' : tape ? (dvr!.atLiveEdge ? 'En vivo · cinta' : 'Cinta') : status === 'live' ? 'En vivo' : status === 'offline' ? 'Reconectando' : 'Conectando'; el('connection-label').dataset.live = String((tape || status === 'live') && !paused);
  el('connection-notice').hidden = (status === 'live' || tape) && !paused; el('connection-notice').textContent = paused ? world?.pauseReason ?? 'El mundo está en pausa para proteger lo guardado.' : status === 'offline' ? 'Sin conexión. Ves el último estado recibido; las órdenes esperan hasta reconectar.' : 'Conectando con el mundo…';
  renderRhythm(); renderControls(); if (!el('stats-drawer').hidden) renderStats();
}
/** M2: el HUD dice cómo llega el mundo (cada 5 s en modo ligero, o más lento de lo pedido) y si su
 * crecimiento está frenado por el gobernador. Todo sale de `performance` y del modo elegido. */
function renderRhythm(): void {
  const rhythm = el('world-rhythm'), live = status === 'live' && !world?.paused;
  const pace = ritmo(world?.performance?.tickHz, world?.performance?.tickHzObjetivo);
  const text = !live ? '' : modoActual === 'observador' ? (pace?.lento ? 'cada 5 s · mundo lento' : 'cada 5 s · modo ligero') : pace?.lento ? `${pace.pasosPorSegundo} · más lento` : '';
  rhythm.hidden = !text; rhythm.textContent = text; rhythm.dataset.kind = modoActual === 'observador' ? 'light' : 'slow';
  const growth = estadoCrecimiento(world?.performance?.gobernador, world?.stats?.population);
  const chip = el('growth-chip');
  chip.hidden = !growth?.chip;
  if (growth?.chip) {
    chip.dataset.growth = growth.estado;
    el('growth-chip-text').textContent = growth.chip;
    el('growth-chip-detail').textContent = growth.detalle;
    chip.title = `${growth.detalle} Toca para ver Mundo › Vida.`;
  }
}
/** M5: «Desde tu última visita» con lo que cambió (contadores del estado real) y los hitos, no 3 episodios al azar. */
function returnCard(current: WorldView, since: number): void {
  let counters = null; try { counters = readVisitCounters(localStorage, current); } catch { counters = null; }
  const resumen = resumenDesdeVisita(counters, since, current);
  const hitos = [...hitosGuardados.filter(h => h.tick > since), ...current.events.filter(event => event.tick > since && esHito(event))]
    .filter((h, i, all) => all.findIndex(other => other.id === h.id) === i).sort((a, b) => b.tick - a.tick).slice(0, 4);
  if (current.tick <= since && !hitos.length) return;
  const card = el('return-card'); card.hidden = false;
  card.innerHTML = `<button class="icon-button" aria-label="Cerrar resumen de regreso">×</button><p class="eyebrow">DESDE TU ÚLTIMA VISITA</p><h2>El mundo siguió su camino.</h2><p class="return-summary">${esc(resumen.dias)}${resumen.cambios.length ? ` ${esc(resumen.cambios.join(' · '))}.` : counters ? ' Sin nacimientos, muertes ni regiones nuevas.' : ''}</p>${hitos.length ? `<ul>${hitos.map(h => `<li><small>${esc(momento(h.tick))} · ${esc(clasificar({ kind: h.kind as ChronicleEvent['kind'], text: h.text }).etiqueta)}</small> ${esc(enClaro(h.text, { world: current }))}</li>`).join('')}</ul>` : ''}${counters ? '' : '<p class="return-note">Esta es la primera visita que guarda contadores: la próxima vez se verá qué cambió.</p>'}`;
  card.querySelector('button')!.addEventListener('click', () => { card.hidden = true; });
}
function renderJournal(): void {
  for (const chip of root.querySelectorAll<HTMLButtonElement>('[data-journal-filter]')) chip.setAttribute('aria-pressed', String(chip.dataset.journalFilter === journalFilter));
  // Los hitos que este navegador vio en visitas anteriores (localStorage) no se pierden: se listan con su
  // texto y su momento, sin causa (no se guardó), marcados como vistos antes.
  const anteriores: ChronicleEvent[] = hitosGuardados.filter(h => !cronica.get(h.id)).map(h => ({ id: h.id, tick: h.tick, kind: h.kind as ChronicleEvent['kind'], actors: [], text: h.text, cause: '', source: 'simulation' }));
  const previos = new Set(anteriores.map(e => e.id));
  const todos = [...anteriores, ...cronica.todos()].sort((a, b) => a.tick - b.tick), lista = filtrar(todos, journalFilter).reverse(), shown = lista.slice(0, 80);
  el('journal-note').textContent = todos.length ? `Este navegador guarda ${number(cronica.size)} episodios desde que abriste la carta${anteriores.length ? ` y ${number(anteriores.length)} ${anteriores.length === 1 ? 'hito' : 'hitos'} de visitas anteriores` : ''}${cronica.size >= cronica.max ? ' (los más viejos y comunes se van olvidando)' : ''}. ${lista.length > shown.length ? `Se muestran los ${shown.length} más recientes de ${number(lista.length)}.` : ''}` : '';
  el('journal-events').innerHTML = shown.length ? shown.map(event => {
    const tipo = clasificar(event), cedio = quienCedio(event);
    const who = (id: string) => world ? personLink(world, id) : esc(id);
    return `<article class="chronicle-event" data-grupo="${tipo.grupo}"><div class="event-label"><span>${esc(tipo.etiqueta)}</span><span>${event.source === 'sample' ? 'Material de prueba' : event.source === 'approved' ? 'Contenido aprobado' : 'Ficción simulada'}</span></div><p>${esc(enClaro(event.text, { world }))}</p>${cedio ? `<p class="event-yield" data-yield>Cedió: ${who(cedio.cede)} (${esc(cedio.como)}); ${who(cedio.sigue)} siguió.</p>` : ''}${previos.has(event.id) ? '<div class="event-cause">Visto por este navegador en una visita anterior; su causa no se guardó.</div>' : `<div class="event-cause"><strong>Qué influyó</strong> ${esc(enClaro(event.cause, { world }))}</div>`}<span class="event-tick">${esc(momento(event.tick))}</span></article>`;
  }).join('') : `<p class="quiet-event">${todos.length ? 'No hay episodios de este tipo entre los que recibió este navegador.' : 'Todavía no hay episodios guardados. El mundo también tiene silencios.'}</p>`;
}

function selectStatsTab(tab: typeof statsTab): void {
  if (tab !== statsTab) el('stats-content').scrollTop = 0;
  statsTab = tab;
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-stats]')) { const active = button.dataset.stats === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
  el('stats-content').setAttribute('aria-labelledby', `stats-tab-${tab}`); renderStats();
}

interface GraphicsDiagnostics {
  fps?: number; frameMs?: number; backend?: string; gpuStatus?: string; gpuLabel?: string;
  visibleAnimals?: number; visibleStructures?: number; visibleTiles?: number; drawCalls?: number; cacheBuilds?: number; cacheEntries?: number; cacheBytes?: number;
  effects?: Record<string,number>; effectBudget?: Record<string,number>;
}
function lifeDynamics(): string {
  const dynamics = world?.stats?.animalDynamics; if (!dynamics) return '';
  const labels = { births: 'Nacimientos', deaths: 'Muertes', predations: 'Depredaciones', humanHunts: 'Cazas humanas', waterConsumed: 'Agua consumida', plantConsumed: 'Plantas consumidas' };
  return `<section class="stats-section"><div class="stats-section-heading"><h3>El ciclo de la fauna</h3><span>Acumulado del mundo</span></div><div class="stats-facts">${Object.entries(labels).map(([key, label]) => `<span>${label}<strong>${number(dynamics[key as keyof typeof dynamics], key.endsWith('Consumed') ? 2 : 0)}</strong></span>`).join('')}</div><p class="stats-note">Nacimientos y pérdidas pertenecen a la fauna. Las necesidades y la memoria de los habitantes se contabilizan aparte.</p></section>`;
}
function inventionStats(): string {
  const stats = world?.stats; if (!stats) return '';
  const dynamics = stats.inventionDynamics;
  return `<section class="stats-section"><div class="stats-section-heading"><h3>Proyectos y construcciones</h3><span>Aprendidos en el mundo</span></div><div class="stats-grid">${statCard('Planos conocidos', number(stats.blueprints), 'Familias y variantes registradas')}${statCard('Investigaciones', number(dynamics?.attempts), 'Intentos acumulados')}${statCard('Variantes aceptadas', number(dynamics?.accepted), 'Proyectos viables')}${statCard('Reparaciones', number(dynamics?.repairs), 'Acciones con material y trabajo')}${statCard('Lluvia recogida', number(dynamics?.waterCollected, 2), 'Agua en cisternas')}${statCard('Alimento retirado', number(dynamics?.foodTaken, 2), 'Consumido desde graneros')}</div>${distribution(stats.structures, componentNames, 'componentes')}<p class="stats-note">Las estructuras combinan funciones. Se desgastan, conservan existencias reales y pueden repararse.</p>${world?.blueprints?.length ? `<details class="person-detail" data-detail="blueprints"><summary>Cuaderno de proyectos (${world.blueprints.length})</summary>${world.blueprints.slice(-24).map(blueprint=>blueprintCard(blueprint, world)).join('')}${world.blueprints.length > 24 ? '<p>Se muestran los 24 proyectos más recientes.</p>' : ''}</details>` : ''}</section>`;
}
function populationWindow(points: { tick: number; value: number }[]): string {
  const samples = points.filter(p => Number.isFinite(p.tick) && Number.isFinite(p.value)).slice(-96);
  if (!samples.length) return '<p class="stats-note" data-population-window>No se han recibido muestras de población. Los acumulados se muestran aparte.</p>';
  const first = samples[0]!.tick, last = samples.at(-1)!.tick;
  // The existing simulation and daylight presentation use 2,400 ticks per model day.
  const days = (last - first) / 2400;
  return `<p class="stats-note stats-scope-note" data-population-window>Ventana recibida: pasos ${number(first)}–${number(last)} · ${number(days, 2)} días simulados entre muestras (${samples.length} ${samples.length === 1 ? 'muestra' : 'muestras'}). La curva incluye S/I y vecinos; no es un registro completo de nacimientos y muertes.</p>`;
}
/** M2: Rendimiento honesto. El p95 frente al presupuesto con barra, el ritmo real y cuánto dura un día,
 * el gobernador en claro (mismo módulo que el HUD), el último frenazo compuesto desde sus campos y lo
 * que recibe este navegador. Todo sale de `performance` y de la conexión; nada se supone. */
function serverPerformance(runtime: WorldView['performance']): string {
  if (!runtime) return '<section class="stats-section"><div class="stats-section-heading"><h3>Servidor · CPU y persistencia</h3><span>Mediciones reales</span></div><p class="stats-empty">El servidor todavía no envió sus medidas de rendimiento.</p></section>';
  const g = runtime.gobernador, growth = estadoCrecimiento(g, world?.stats?.population), frenazo = ultimoFrenazo(g);
  const pace = ritmo(runtime.tickHz, runtime.tickHzObjetivo);
  const budget = g?.presupuestoMs;
  const p95Card = budget !== undefined && Number.isFinite(budget) && budget > 0
    ? `<article class="stat-card" data-p95><span>Paso p95</span><strong>${esc(number(runtime.p95StepMs, 1))} ms <small>de ${esc(number(budget, 0))} ms</small></strong><meter class="stat-meter" min="0" max="${esc(budget)}" low="${esc(budget * 0.7)}" high="${esc(budget)}" optimum="0" value="${esc(Math.min(runtime.p95StepMs, budget * 1.5))}" aria-label="Paso p95 frente al presupuesto del gobernador"></meter><small>Presupuesto del gobernador; por encima frena el crecimiento.</small></article>`
    : statCard('Paso p95', `${number(runtime.p95StepMs, 2)} ms`, 'Ventana medida por el servidor');
  const paceCard = pace ? `<article class="stat-card" data-rhythm><span>Ritmo real</span><strong>${esc(pace.pasosPorSegundo)}</strong><small>Un día del mundo dura ~${esc(pace.diaDura)}.${pace.lento && runtime.tickHzObjetivo ? ` Más lento de lo pedido (${esc(number(runtime.tickHzObjetivo, 1))} pasos/s).` : ''}</small></article>` : statCard('Ritmo real', '—', 'Aún sin pasos medidos');
  const growthCard = growth ? `<article class="stat-card" data-growth-card="${esc(growth.estado)}"><span>Gobernador · crecimiento</span><strong>${esc(growth.titulo)}</strong><small>${esc(growth.explicacion)}</small></article>` : '';
  // El titular es lo vigente (el techo del chip); el registro del último frenazo va aparte, como historia.
  const brakeCard = frenazo ? '<article class="stat-card" data-last-brake><span>Último frenazo '
    + `<b class="stat-state" data-vigente="${frenazo.vigente}">${frenazo.vigente ? 'freno vigente' : 'ya retirado'}</b></span>`
    + `<strong>${esc(frenazo.titular)}</strong>`
    + `<small data-brake-history>Registro histórico · ${esc(frenazo.texto)}</small></article>` : '';
  const received = connection?.reception();
  const receivedCard = received ? statCard('Recibido por este navegador', `≈ ${number(received.meanBytes / 1024, 0)} KiB`, `Por actualización (media de las últimas)${received.perSecond ? ` · ${number(received.perSecond, 1)} actualizaciones/s` : ''}. Tamaño del JSON recibido, sin cabeceras.`) : statCard('Recibido por este navegador', '—', 'Aún no llegó ninguna actualización por la conexión en vivo.');
  return `<section class="stats-section"><div class="stats-section-heading"><h3>Servidor · CPU y persistencia</h3><span>Mediciones reales</span></div><p class="stats-note">Duración del trabajo y memoria del proceso. No representan el porcentaje de uso total de la CPU.</p><div class="stats-grid">${p95Card}${paceCard}${growthCard}${brakeCard}${statCard('Paso de simulación', `${number(runtime.stepMs, 2)} ms`, 'Último paso')}${statCard('Guardado', `${number(runtime.saveMs, 2)} ms`, 'Persistencia')}${statCard('Proyección', `${number(runtime.projectionMs, 2)} ms`, 'Preparación de una vista')}${statCard('Memoria del proceso', `${number(runtime.processRssMiB, 1)} MiB`, 'RSS del servidor')}${statCard('Instantánea guardada en disco', `${number(runtime.snapshotBytes / 1024, 1)} KiB`, 'Tamaño del último guardado del mundo')}${receivedCard}</div></section>${seccionFases(runtime)}`;
}
/** T165: panel del gobernador en el cajón Mundo, visible en escritorio y en modo observador. */
function renderPanelGobernadorEnDom(): void {
  const contenedor = document.getElementById('panel-gobernador'); if (!contenedor) return;
  const html = world ? renderPanelGobernador(world.performance, world.stats?.population) : '';
  contenedor.innerHTML = html; contenedor.hidden = !html;
}
/**
 * V24: el panel de estadísticas solo se rehace si está abierto y algo cambió. Lo que cambia con cada paso del mundo
 * (tick/secuencia) lo refresca a lo sumo una vez por segundo; cambiar de pestaña, de foco, de receta o de estado lo
 * rehace al momento. Antes se reconstruía su HTML ~6 veces por segundo y competía con el dibujo del mapa.
 */
const STATS_TICK_MS = 1000;
let statsRenderedAt = -Infinity, statsTrailing: ReturnType<typeof setTimeout> | null = null;
function renderStats(): void {
  const panel = document.getElementById('stats-content'); if (!panel || el('stats-drawer').hidden) return;
  const structure = `${statsTab}|${directory?.tick ?? -1}|${status}|${world?.paused ? 1 : 0}|${focusedRecipe ?? ''}|${focusedCommunity ?? ''}|${recipeDetails.size}`;
  const sig = `${structure}#${world?.tick ?? -1}|${world?.sequence ?? -1}`;
  if (sig === statsSignature) return;
  const now = performance.now();
  if (statsSignature.startsWith(`${structure}#`) && now - statsRenderedAt < STATS_TICK_MS) {
    // El último paso recibido se muestra igual, al cumplirse el segundo (aunque no llegue otro paso).
    statsTrailing ??= setTimeout(() => { statsTrailing = null; renderStats(); }, STATS_TICK_MS - (now - statsRenderedAt));
    return;
  }
  if (statsTrailing) { clearTimeout(statsTrailing); statsTrailing = null; }
  statsSignature = sig; statsRenderedAt = now;
  renderPanelGobernadorEnDom();
  const restore = retainViewState(panel);
  const deepStats = document.getElementById('mundo-deep-stats') ?? Object.assign(document.createElement('div'), { id: 'mundo-deep-stats' });
  renderStatsContent();
  // Estadísticas profundas de Mundo (mundo-dashboard.ts): lectura pura de lo recibido; un fallo suyo no tumba el panel.
  try { deepStats.innerHTML = world ? renderMundoDeepStats(world, statsTab, directory) : ''; } catch { deepStats.innerHTML = '<p class="stats-note">Las estadísticas ampliadas no están disponibles ahora.</p>'; }
  el('stats-content').append(deepStats);
  restore();
}
function renderStatsContent(): void {
  const panel = document.getElementById('stats-content'); if (!panel || !world) return;
  const stats = world.stats, runtime = world.performance;
  const stamp = `<div class="stats-scope"><span class="scope-dot"></span><span>${status === 'live' && !world.paused ? 'Estado recibido del servidor' : 'Último estado recibido'} · paso ${world.tick}</span></div>`;
  if (statsTab === 'technology') {
    // The notebook already draws the last twenty with whatever detail arrived; only a recipe outside it needs its own card.
    const listed = world.technology?.recipes.slice(-20).some(recipe=>recipe.id===focusedRecipe) ?? false;
    const targeted = listed ? undefined : (focusedRecipe ? recipeDetails.get(focusedRecipe) : null) ?? world.technology?.recipes.find(recipe=>recipe.id===focusedRecipe);
    const missing = focusedRecipe && recipeDetails.get(focusedRecipe) === null ? `<p class="stats-note">Los pasos de ${esc(focusedRecipe)} no están disponibles en este mundo ahora.</p>` : '';
    panel.innerHTML = stamp + missing + (targeted ? recipeCard(targeted, world.technology) : '')
      + renderChemistryTelemetry(world.chemistry) + technologyPane(world.technology, world.organization, recipeDetails, world.stats, world.performance?.conducta);
    return;
  }
  if (statsTab === 'performance') {
    const graphics = (landscape as (Landscape & { getDiagnostics?: () => GraphicsDiagnostics }) | null)?.getDiagnostics?.();
    const gpuLabels: Record<string, string> = { hardware: 'WebGL · adaptador físico reconocido', software: 'Respaldo Canvas2D · adaptador de software', unverified: 'WebGL activo · hardware sin verificar', 'context-lost': 'Contexto perdido · respaldo Canvas2D', active: 'GPU activa', ready: 'GPU preparada', available: 'GPU disponible', pending: 'Consultando GPU', initializing: 'Inicializando GPU', unavailable: 'GPU no disponible', unsupported: 'GPU no compatible', disabled: 'GPU desactivada', failed: 'GPU no disponible', lost: 'Dispositivo perdido', 'device-lost': 'Dispositivo perdido', fallback: 'Respaldo gráfico activo' };
    panel.innerHTML = `${stamp}${serverPerformance(runtime)}`+`<section class="stats-section"><div class="stats-section-heading"><h3>Este navegador · gráficos</h3><span>${esc(graphics?.backend === 'canvas2d-cached' ? 'Canvas2D con caché' : graphics?.backend === 'webgl2' ? 'WebGL2' : 'Esperando diagnóstico')}</span></div>${graphics ? `<div class="gpu-state"><span>${icon.layers}</span><div><strong>${esc(gpuLabels[graphics.gpuStatus ?? ''] ?? graphics.gpuStatus ?? 'Estado gráfico sin informar')}</strong><p>${esc(graphics.gpuLabel ?? 'El navegador no informó un nombre de dispositivo.')}</p></div></div><div class="stats-grid">${statCard('Dibujo', `${number(graphics.fps, 1)} FPS`, 'Frecuencia observada en esta pestaña')}${statCard('CPU por cuadro', `${number(graphics.frameMs, 2)} ms`, 'Preparación y envío del dibujo')}${statCard('Casillas visibles', number(graphics.visibleTiles), 'Trabajo de esta cámara')}${statCard('Animales visibles', number(graphics.visibleAnimals), 'Cuerpos dibujados en esta cámara')}${statCard('Construcciones visibles', number(graphics.visibleStructures), 'Componentes de estructuras')}${statCard('Composiciones', number(graphics.drawCalls), 'Sprites y texturas, no todas las operaciones')}${statCard('Caché gráfico', `${number(graphics.cacheBytes === undefined ? undefined : graphics.cacheBytes / 1048576, 2)} MiB`, `${number(graphics.cacheEntries)} entradas · ${number(graphics.cacheBuilds)} construcciones`)}</div>` : '<p class="stats-empty">Todavía no hay diagnóstico del renderizador. No se puede afirmar que la GPU esté activa.</p>'}<p class="stats-note">La CPU del servidor decide lo que ocurre; los gráficos de esta pestaña dibujan el estado recibido. Los tiempos de dibujo no miden la ocupación de la GPU. Cerrar la pestaña no detiene el mundo.</p></section>`;
    return;
  }
  if (statsTab === 'communities') {
    const sueltos = sinComunidad(world);
    const comunidades = comunidadesOrdenadas(world.communities);
    const ventana = ventanaLista(comunidades, 60);
    const mostradas = focusedCommunity && !ventana.visibles.some(c => c.id === focusedCommunity)
      ? (() => { const extra = comunidades.find(c => c.id === focusedCommunity); return extra ? [extra, ...ventana.visibles] : ventana.visibles; })()
      : ventana.visibles;
    const notaVentana = ventana.restantes > 0
      ? `<p class="stats-note stats-scope-note" data-communities-window>Se muestran las ${number(mostradas.length)} comunidades más pobladas de ${number(comunidades.length)} vivas; el resumen cultural incluye a todas.</p>`
      : '';
    panel.innerHTML = `${stamp}${renderCommunityTelemetry(world.communities)}<p class="stats-note">Las comunidades se forman en el mundo simulado, de la más poblada a la menos. Su cultura y confianza cambian con las interacciones; pertenecer a grupos distintos no implica hostilidad.</p>${sueltos !== null ? `<p class="stats-note stats-scope-note" data-without-community>${number(sueltos)} ${sueltos === 1 ? 'vida no pertenece' : 'vidas no pertenecen'} a ninguna comunidad (pertenecer es opcional).</p>` : ''}${resumenCultural(world)}${notaVentana}${mostradas.length ? mostradas.map(community => {
      const color = /^#[\da-f]{3,8}$/i.test(community.color) ? community.color : '#779264';
      // T134 (FR-026): `members` ya no viaja completo — solo quien está en la cámara. `memberCount`
      // trae el total real; si faltan miembros por estar fuera de vista, se dice explícitamente
      // en vez de dar a entender que la lista mostrada es la comunidad entera.
      const total = community.memberCount ?? community.members.length;
      const nombrados = miembrosNombrados(community.members);
      const members = nombrados.nombrados.map(id => personLink(world!,id));
      const hidden = total - community.members.length;
      const dominante = ejeDominante(community.culture);
      return `<article class="community-card" data-community-card="${esc(community.id)}" tabindex="-1"><header><span class="community-swatch" style="background:${color}" aria-hidden="true"></span><div><h3>${esc(community.name)}</h3><p>${number(total)} habitantes · desde el paso ${community.formedAt}</p></div></header><p class="community-members">${members.join(' ')}${nombrados.restantesEnVista > 0 ? `<span class="community-members-more">y ${number(nombrados.restantesEnVista)} más en esta vista</span>` : ''}${hidden > 0 ? `<span class="community-members-more">y ${number(hidden)} más fuera de esta vista</span>` : ''}</p><div class="community-counts"><span><strong>${number(community.cooperation)}</strong> cooperaciones</span><span><strong>${number(community.disputes)}</strong> desacuerdos</span><button class="entity-link" data-place-x="${esc(community.x)}" data-place-y="${esc(community.y)}">Ver lugar ${icon.arrow}</button></div>${ejesCultura(community.culture).map(eje => eje.valor === null ? '' : meter(eje.etiqueta, eje.valor)).join('')}${dominante ? `<p class="stats-note" data-community-dominant>Su eje más alto: <strong>${esc(dominante.etiqueta)} (${esc(percentage(dominante.valor!))})</strong>. ${esc(dominante.lectura)}</p>` : ''}</article>`;
    }).join('') : '<div class="stats-empty illustrated-empty">Todavía no se ha formado una comunidad. Los encuentros y las acciones locales pueden dejar costumbres compartidas.</div>'}`;
    return;
  }
  if (!stats) { panel.innerHTML = `${stamp}<p class="stats-empty">El servidor todavía no envió estas estadísticas.</p>`; return; }
  const scope = '<p class="stats-note stats-scope-note">Paisaje y recursos: regiones activas del servidor, no todo el territorio posible ni solo la cámara. Los acumulados se identifican aparte.</p>';
  if (statsTab === 'land') {
    const featureNames: Record<string, string> = { tree: 'Árboles', pine: 'Pinos', palm: 'Palmeras', cactus: 'Cactus', reeds: 'Juncos', berries: 'Bayas', flowers: 'Flores', rock: 'Rocas', clay: 'Arcilla', stump: 'Tocones', spring: 'Manantiales', pool: 'Pozas', none: 'Sin elemento destacado' };
    const species = speciesPlural;
    panel.innerHTML = `${stamp}${scope}${renderLandTelemetry(world)}${seccionTerritorio(world)}<div class="stats-grid">${statCard('Regiones activas', number(world.activeChunks), 'Cerca de los habitantes')}${statCard('Casillas activas', number(runtime?.activeTiles), 'Terreno en actividad')}${statCard('Agua dulce', number(stats.freshWater, 1), 'Unidades del modelo')}${statCard('Cultivos', number(stats.cultivatedTiles), 'Casillas cultivadas')}${statCard('Senderos', number(stats.trailTiles), 'Casillas con huellas')}${statCard('Madera y piedra', `${number(stats.materials.wood)} / ${number(stats.materials.stone)}`, 'Inventarios de habitantes')}</div><div class="stats-two-columns"><section class="stats-section"><div class="stats-section-heading"><h3>Biomas activos</h3><span>Casillas</span></div>${distribution(stats.biomes, biomes, '')}</section><section class="stats-section"><div class="stats-section-heading"><h3>Vida animal</h3><span>Individuos en regiones activas</span></div>${distribution(stats.wildlife, species, '')}<p class="stats-note">El censo cuenta cuerpos individuales. La caza, la depredación, el agua y las plantas influyen en su supervivencia.</p></section></div><section class="stats-section"><div class="stats-section-heading"><h3>Elementos del paisaje</h3><span>Casillas activas</span></div>${distribution(stats.features, featureNames, '')}</section>${lifeDynamics()}${inventionStats()}${world.structures?.length ? `<section class="stats-section"><h3 class="section-title">Construcciones en esta vista</h3>${world.structures.slice(0,24).map(structure=>`<button class="structure-link entity-link" data-place-x="${esc(structure.x)}" data-place-y="${esc(structure.y)}"><span>${esc(structure.name)}<small>${esc(structure.x)}, ${esc(structure.y)} · estado ${percentage(structure.condition)}</small></span>${icon.arrow}</button>`).join('')}</section>` : ''}`;
    return;
  }
  const history = stats.history ?? [];
  const actionLabels = Object.fromEntries(Object.entries(actions).map(([key, text]) => [key, text]));
  // M7: cooperación por tipo (identidad de society.ts), comida compartida, graneros y desacuerdos con quién cedió.
  const accumulated = `${seccionJuntos(world, cronica.todos())}${seccionDesacuerdos(world, cronica.todos())}`;
  const growth = estadoCrecimiento(world.performance?.gobernador, stats.population);
  const growthLine = growth ? `<p class="growth-status" data-growth="${esc(growth.estado)}"><strong>${esc(growth.titulo)}</strong>${esc(growth.explicacion)}</p>` : '';
  panel.innerHTML = `${stamp}${growthLine}${demographicSummary(world)}${vidasQueTerminaron(world)}${renderLifeTelemetry(stats)}<div class="stats-grid">${statCard('Energía media', percentage(stats.meanEnergy), 'Estado corporal, no afecto')}${statCard('Hambre media', percentage(stats.meanHunger), 'Necesidad de alimento')}${statCard('Sed media', percentage(stats.meanThirst), 'Necesidad de agua')}${statCard('Cansancio medio', percentage(stats.meanFatigue), 'Necesidad de descanso')}</div>${recentEvidence(world, undefined, cronica.todos())}${populationWindow(history.map(p => ({ tick: p.tick, value: p.population })))}<div class="stats-chart-grid">${sparkline(history.map(p => ({ tick: p.tick, value: p.population })), 'Población · ventana recibida', 'habitantes')}${sparkline(history.map(p => ({ tick: p.tick, value: p.energy * 100 })), 'Energía media', '% media', [0, 100])}</div>${seccionNacimientos(world)}<section class="stats-section"><div class="stats-section-heading"><h3>Qué están haciendo</h3><span>Todo el mundo, ahora</span></div>${distribution(stats.actions, actionLabels, '')}${notaAcercamientos(world)}</section><div class="stats-two-columns"><section class="stats-section"><div class="stats-section-heading"><h3>Generaciones</h3><span>${generacionMaxima(world) !== null ? `La más alta viva: G${generacionMaxima(world)}` : 'Habitantes'}</span></div>${distribution(stats.generations, Object.fromEntries(Object.keys(stats.generations).map(key => [key, `Generación ${key}`])), '')}</section><section class="stats-section"><div class="stats-section-heading"><h3>Historia que se acumula</h3></div><div class="stats-facts"><span>Regiones descubiertas<strong>${number(world.discoveredChunks)}</strong></span><span>Asentamientos construidos<strong>${number(world.settlementCount)}</strong></span><span>Animales cazados<strong>${number(stats.totals.hunts)}</strong></span><span>Acciones de cultivo<strong>${number(stats.totals.cultivations)}</strong></span></div></section></div>${accumulated}${scope}`;
}
document.addEventListener('keydown', tapeShortcut); // una sola vez: `wire()` corre en cada entrada al mundo
window.addEventListener('pagehide', saveVisit); document.addEventListener('visibilitychange', () => { soundscape.setHidden(document.hidden); if (document.hidden) saveVisit(); else if (uiSession) { void refreshMap(); if (!el('population-drawer').hidden) void refreshDirectory(); if (!el('whisper-drawer').hidden) void refreshWhispers(); } });
async function boot(): Promise<void> { root.innerHTML = '<main class="boot-screen"><span>✧</span><p>Abriendo la carta…</p></main>'; try { const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) }); const session = await response.json() as { authenticated: boolean } & SessionFlags; if (response.ok && session.authenticated) enterWorld({ tapeEnabled: session.tapeEnabled, observerOnly: session.observerOnly }); else loginScreen(); } catch { loginScreen('No hay conexión con el servidor. Puedes volver a intentar.'); } }
void boot();
