import type { AnimalView, BlueprintView, ChronicleEvent, Gesture, Order, PersonView, StructureView, WorldView } from '../shared/types.js';
import { Connection, type ConnectionStatus } from './connection.js';
import { Landscape, type Selection } from './landscape.js';
import { icons } from './icons.js';
import { animalActions, animalColors, componentNames, componentPurpose, speciesNames, speciesPlural } from './life-art.js';
import { technologyPane } from './technology-art.js';
import './style.css';
import './game.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
const esc = (value: string | number): string => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const svg = (path: string): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icon = { ...icons,
  people: svg('<circle cx="9" cy="7" r="3"/><path d="M3 21v-5a6 6 0 0 1 12 0v5M17 4a3 3 0 0 1 0 6m2 3a5 5 0 0 1 2 4v4"/>'),
  hand: svg('<path d="M8 12V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 4-3 6-7 6-3 0-5-3-7-6l-2-3c-1-2 1-3 2-2l2 1Z"/>'),
  layers: svg('<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>'),
  eye: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  hammer: svg('<path d="m4 20 9-9M9 5l5-3 7 7-3 3-7-7Z"/>'),
  bag: svg('<path d="M5 9h14l2 12H3L5 9Zm3 0V6a4 4 0 0 1 8 0v3"/>'),
  tent: svg('<path d="m12 3 10 18H2L12 3Zm0 9-5 9m5-9 5 9"/>'),
  stats: svg('<path d="M3 3v18h18M7 15v-4m5 4V6m5 9V9"/>'),
  cooperate: svg('<path d="m3 11 4-5 5 2 5-2 4 5-6 8h-6l-6-8ZM7 12l4 4m6-4-4 4m-6-5 5-3 3 3-3 3-2-1"/>'),
  water: svg('<path d="M12 2C9 7 5 10 5 15a7 7 0 0 0 14 0c0-5-4-8-7-13Z"/><path d="M8 15a4 4 0 0 0 4 4"/>'),
  hunt: svg('<path d="M5 3c13 0 13 18 0 18L15 12 5 3Zm0 9h17m-3-3 3 3-3 3"/>'),
};
const actions: Record<PersonView['action'], string> = { explore: 'Explorando', eat: 'Buscando alimento', drink: 'Buscando agua', hunt: 'Cazando', rest: 'Descansando', approach: 'Acercándose', accompany: 'Acompañando', retreat: 'Buscando espacio', share: 'Compartiendo', gather: 'Recolectando', farm: 'Cultivando', build: 'Construyendo', cooperate: 'Cooperando', invent: 'Investigando un proyecto', repair: 'Reparando', research: 'Probando materiales', craft: 'Fabricando un producto' };
const phases = { dawn: 'Amanecer', day: 'Día', dusk: 'Atardecer', night: 'Noche' };
const terrains = { water: 'Agua', meadow: 'Pradera', soil: 'Tierra', shelter: 'Refugio' };
const biomes: Record<string, string> = { grassland: 'Praderas', forest: 'Bosque', desert: 'Desierto', mountain: 'Montañas', wetland: 'Humedal', ocean: 'Océano' };
const deathCauses: Record<string,string> = {starvation:'Falta prolongada de alimento.',dehydration:'Falta prolongada de agua.',exposure:'Desgaste corporal por exposición.',senescence:'Llegó al término de su ciclo de vida simulado.'};
const orders: { order: Order; title: string; icon: string }[] = [
  { order: 'explore', title: 'Explorar', icon: icon.focus }, { order: 'gather', title: 'Recolectar', icon: icon.bag },
  { order: 'farm', title: 'Cultivar', icon: icon.leaf }, { order: 'build', title: 'Construir', icon: icon.hammer },
  { order: 'rest', title: 'Descansar', icon: icon.tent }, { order: 'auto', title: 'Autonomía', icon: icon.star },
  { order: 'cooperate', title: 'Cooperar', icon: icon.cooperate },
  { order: 'drink', title: 'Beber', icon: icon.water }, { order: 'hunt', title: 'Cazar', icon: icon.hunt },
  { order: 'invent', title: 'Inventar', icon: icon.star }, { order: 'repair', title: 'Reparar', icon: icon.hammer },
  { order: 'research', title: 'Investigar', icon: icon.layers }, { order: 'craft', title: 'Fabricar', icon: icon.hammer },
];
let world: WorldView | null = null;
let connection: Connection | null = null;
let landscape: Landscape | null = null;
let selected: Selection = { kind: 'person', id: 's' };
let activePersonId = 's';
let control: 'inspect' | 'direct' = 'inspect';
let following = false;
let status: ConnectionStatus = 'connecting';
let pending = false;
let tool: 'plant' | 'invite' | 'remember' = 'plant';
let lastVisit: number | null = null;
let populationSignature = '', inspectorSignature = '', memorySignature = '';
let statsTab: 'life' | 'land' | 'communities' | 'technology' | 'performance' = 'life';
let populationKind: 'people' | 'animals' = 'people';
let soundContext: AudioContext | null = null;
let soundTimer: ReturnType<typeof setTimeout> | undefined;
const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const mobile = (): boolean => matchMedia('(max-width: 760px)').matches;
function saveVisit(): void { if (world) try { localStorage.setItem('carta:last-visit', String(world.tick)); } catch { /* Optional. */ } }
function readVisit(): number | null { try { const raw = localStorage.getItem('carta:last-visit'); return raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null; } catch { return null; } }
function stopSound(): void { clearTimeout(soundTimer); if (soundContext) void soundContext.close(); soundContext = null; document.getElementById('sound-toggle')?.setAttribute('aria-pressed', 'false'); }
function clean(): void { saveVisit(); connection?.stop(); landscape?.destroy(); stopSound(); connection = null; landscape = null; world = null; pending = false; following = false; control = 'inspect'; populationSignature = ''; inspectorSignature = ''; memorySignature = ''; statsTab = 'life'; populationKind = 'people'; }

function loginScreen(message = ''): void {
  clean(); root.innerHTML = `<main class="entry-page"><div class="entry-monogram">${icon.leaf}<span>UN MUNDO PRIVADO POR DESCUBRIR</span></div><section class="entry-card" aria-labelledby="entry-title"><div class="letter-stamp" aria-hidden="true">I<span>PARA TI</span></div><p class="eyebrow">UN LUGAR PARA ENCONTRARNOS</p><h1 id="entry-title">Una carta<br>para <em>Isa.</em></h1><p class="entry-intro">Un mundo que crece.<br>Muchas vidas. Tu forma de recorrerlo.</p><form id="login-form"><label for="password">Contraseña privada</label><input id="password" name="password" type="password" autocomplete="current-password" required placeholder="La llave de este lugar"><button class="button primary entry-submit" type="submit">Entrar a la carta ${icon.arrow}</button><p id="login-error" class="form-message" role="status">${esc(message)}</p></form><div class="entry-footnote">${icon.leaf}<span>Lo pequeño también puede contener un mundo.</span></div></section><p class="entry-footer">UNA CARTA PARA ISA · ACCESO PRIVADO</p></main>`;
  el<HTMLFormElement>('login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = el('login-form').querySelector<HTMLButtonElement>('button')!; button.disabled = true; el('login-error').textContent = 'Abriendo la carta…';
    try {
      const response = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: el<HTMLInputElement>('password').value }), signal: AbortSignal.timeout(10_000) });
      el<HTMLInputElement>('password').value = '';
      if (!response.ok) { el('login-error').textContent = response.status === 429 ? 'Espera un momento antes de volver a intentar.' : 'No pudimos abrir la carta con esa contraseña.'; button.disabled = false; return; }
      enterWorld();
    } catch { el('login-error').textContent = 'No hay conexión con el servidor. Puedes intentarlo de nuevo.'; button.disabled = false; }
  });
}

function enterWorld(): void {
  clean(); lastVisit = readVisit(); status = 'connecting';
  root.innerHTML = `<main id="game" class="game-shell" aria-label="Mundo vivo de la carta">
    <canvas id="landscape" tabindex="0" aria-label="Mundo vivo, arrastra para recorrer"></canvas>
    <div id="map-loading" class="game-loading">${icon.leaf}<span>Abriendo el mundo…</span></div>
    <header class="game-top"><button id="letter-button" class="game-brand hud-surface" aria-label="La carta">${icon.leaf}<span>Una carta <em>para Isa</em><small>UN MUNDO PARA VOLVER</small></span></button><div class="game-clock hud-surface"><span class="clock-sun" aria-hidden="true">☼</span><div><strong id="world-day">Día 1</strong><span id="world-phase">Conectando</span></div><span class="clock-line"></span><span id="connection-label" class="connection-label">Conectando</span></div><nav class="game-actions hud-surface" aria-label="Opciones del mundo"><button id="chronicle-button" class="icon-button" aria-label="Crónica">${icon.book}</button><button id="sound-toggle" class="icon-button" aria-label="Sonido opcional" aria-pressed="false">${icon.sound}</button><button id="logout-button" class="icon-button logout" aria-label="Cerrar sesión">↪</button></nav></header>
    <aside class="world-rail hud-surface" aria-label="Exploración"><button id="population-toggle" class="icon-button" aria-label="Población" aria-expanded="false" aria-controls="population-drawer">${icon.people}</button><button id="stats-toggle" class="icon-button" aria-label="Vida del mundo y estadísticas" aria-expanded="false" aria-controls="stats-drawer">${icon.stats}</button><button id="layer-toggle" class="icon-button" aria-label="Capas y coordenadas" aria-expanded="false" aria-controls="layer-drawer">${icon.layers}</button><span></span><button id="focus-s" class="role-button role-s" aria-label="Encontrar a S">S</button><button id="focus-i" class="role-button role-i" aria-label="Encontrar a I">I</button></aside>
    <aside id="population-drawer" class="game-drawer population-drawer" hidden aria-label="Población del mundo"><header><div><p class="eyebrow">CADA VIDA, UN CAMINO</p><h2><span id="population-heading">Habitantes</span> <span id="population-count">0</span></h2></div><button class="icon-button" data-close="population" aria-label="Cerrar población">×</button></header><div class="population-tabs" role="group" aria-label="Vidas del mundo"><button data-population="people" aria-pressed="true">Habitantes</button><button data-population="animals" aria-pressed="false">Fauna</button></div><label class="search-label" for="population-search"><span id="population-search-label">Buscar habitante</span><input id="population-search" type="search" placeholder="Nombre o especialidad" autocomplete="off"></label><label id="species-filter-label" class="search-label" for="species-filter" hidden>Especie<select id="species-filter"><option value="">Todas las especies</option>${Object.entries(speciesPlural).map(([key, name]) => `<option value="${key}">${name}</option>`).join('')}</select></label><div id="species-legend" class="species-legend" hidden>${Object.entries(speciesNames).map(([key, name]) => `<span><i style="background:${animalColors[key as AnimalView['species']]}" aria-hidden="true"></i>${name}</span>`).join('')}</div><div id="population-list" class="population-list"></div><p id="population-note" class="drawer-footnote">Las habilidades cambian al practicar. Puedes observar o dar una orden.</p></aside>
    <aside id="inspector-drawer" class="game-drawer inspector-drawer" hidden aria-label="Inspector de selección"><header><div><p class="eyebrow">MIRAR DE CERCA</p><h2 id="inspector-title">Habitante</h2></div><button class="icon-button" data-close="inspector" aria-label="Cerrar inspector">×</button></header><div id="person-primary" class="control-pair"><button id="follow-toggle" class="button secondary" aria-pressed="false">${icon.eye}Seguir</button><button id="direct-toggle" class="button primary" aria-pressed="false">${icon.hand}Dirigir</button></div><div id="inhabitant-card" tabindex="-1"></div><div id="person-controls"><p id="control-help" class="control-help"></p><div class="order-grid">${orders.map(order => `<button data-order="${order.order}">${order.icon}<span>${order.title}</span></button>`).join('')}</div></div></aside>
    <aside id="layer-drawer" class="game-drawer layer-drawer" hidden aria-label="Capas y coordenadas"><header><div><p class="eyebrow">LEER EL PAISAJE</p><h2>Observar</h2></div><button class="icon-button" data-close="layer" aria-label="Cerrar capas">×</button></header><label for="observation-layer">Capa del mapa<select id="observation-layer"><option value="none">El paisaje</option><option value="moisture">La humedad</option><option value="food">El alimento</option></select></label><p id="layer-explanation" class="drawer-note">Agua, recursos y encuentros cambian las posibilidades.</p><label for="person-select">Ir a un habitante<select id="person-select"></select></label><label for="place-select">Ir a un lugar conocido<select id="place-select"></select></label><form id="tile-form"><fieldset><legend>Recorrer por coordenadas</legend><label for="tile-x">X<input id="tile-x" type="number" min="-9999900" max="9999900" value="0" required></label><label for="tile-y">Y<input id="tile-y" type="number" min="-9999900" max="9999900" value="0" required></label><button class="button primary" type="submit">Ir ${icon.arrow}</button></fieldset></form></aside>
    <aside id="tool-drawer" class="game-drawer tool-drawer" hidden aria-label="Gesto en el mundo"><header><div><p class="eyebrow">CAMBIAR UNA POSIBILIDAD</p><h2 id="gesture-title">Sembrar</h2></div><button class="icon-button" data-close="tool" aria-label="Cerrar gesto">×</button></header><p id="gesture-description" class="drawer-note"></p><div id="memory-choice" hidden><label for="memory-select">Recuerdo disponible<select id="memory-select"></select></label><p id="memory-preview" class="memory-preview"></p></div><p class="target-line">Destino: <strong id="gesture-target">toca una casilla</strong></p><button id="gesture-send" class="button primary" disabled>Sembrar aquí ${icon.arrow}</button></aside>
    <aside id="stats-drawer" class="game-drawer stats-drawer" hidden aria-label="Vida del mundo y estadísticas"><header><div><p class="eyebrow">LO QUE ESTÁ TOMANDO FORMA</p><h2>Vida del mundo</h2></div><button class="icon-button" data-close="stats" aria-label="Cerrar estadísticas">×</button></header><div class="stats-tabs" role="tablist" aria-label="Vistas de estadísticas"><button id="stats-tab-life" role="tab" data-stats="life" aria-selected="true" aria-controls="stats-content">Vida</button><button id="stats-tab-land" role="tab" data-stats="land" aria-selected="false" aria-controls="stats-content" tabindex="-1">Paisaje</button><button id="stats-tab-communities" role="tab" data-stats="communities" aria-selected="false" aria-controls="stats-content" tabindex="-1">Comunidades</button><button id="stats-tab-technology" role="tab" data-stats="technology" aria-selected="false" aria-controls="stats-content" tabindex="-1">Oficios</button><button id="stats-tab-performance" role="tab" data-stats="performance" aria-selected="false" aria-controls="stats-content" tabindex="-1">Rendimiento</button></div><div id="stats-content" role="tabpanel" aria-labelledby="stats-tab-life" tabindex="0"><p class="drawer-note">Esperando las medidas del servidor.</p></div></aside>
    <section id="return-card" class="return-toast hud-surface" hidden aria-label="Desde tu última visita"></section>
    <div class="game-message-stack"><div id="connection-notice" class="game-notice" role="status">Conectando con el mundo…</div><p id="gesture-result" class="game-result" role="status" aria-live="polite" hidden></p><p id="mode-indicator" class="mode-indicator" hidden></p></div>
    <div class="camera-controls hud-surface" aria-label="Cámara"><button id="zoom-in" class="icon-button" aria-label="Acercar mapa">+</button><button id="zoom-out" class="icon-button" aria-label="Alejar mapa">−</button><button id="map-reset" class="icon-button" aria-label="Volver a S">${icon.focus}</button></div>
    <div class="world-coordinates hud-surface"><span id="camera-coordinates">0, 0</span><span id="world-extent">Recibiendo el mundo</span></div>
    <nav class="game-tools hud-surface" aria-label="Herramientas del mundo"><button id="observe-tool" class="game-tool" aria-pressed="true">${icon.eye}<span>Observar</span></button><span class="tool-divider"></span><button class="game-tool" data-gesture="plant" aria-pressed="false">${icon.leaf}<span>Sembrar</span></button><button class="game-tool" data-gesture="invite" aria-pressed="false">${icon.star}<span>Invitar</span></button><button class="game-tool" data-gesture="remember" aria-pressed="false">${icon.book}<span>Recordar</span></button><span class="tool-divider"></span><button id="inspector-toggle" class="game-tool" aria-expanded="false" aria-controls="inspector-drawer">${icon.people}<span>Inspeccionar</span></button></nav>
    <p class="map-hint" id="map-help">Arrastra para recorrer · toca para descubrir · rueda para acercar</p>
  </main>
  <dialog id="letter-dialog" class="letter-dialog" aria-labelledby="letter-title"><button class="dialog-close icon-button" aria-label="Cerrar la carta">×</button><span class="letter-index">01 / LA CARTA</span><div class="letter-flower">${icon.leaf}</div><p class="eyebrow">BORRADOR DE APERTURA · PENDIENTE DE STEVEN</p><h2 id="letter-title">Para ti, <em>Isa.</em></h2><blockquote>Te hice un mundo pequeño. Dejé en él algo de nuestra historia y espacio para lo que todavía no sabemos.</blockquote><p class="letter-note">La voz del autor y los recuerdos reales están pendientes de revisión. S e I son representaciones provisionales; los recuerdos de prueba están identificados.</p><p class="letter-signature">Hay espacio para tomar tu propio camino.</p><button id="enter-landscape" class="button primary">Entrar al mundo ${icon.arrow}</button></dialog>
  <dialog id="chronicle-dialog" class="chronicle-dialog" aria-labelledby="journal-title"><button class="dialog-close icon-button" aria-label="Cerrar crónica">×</button><p class="eyebrow">LAS HUELLAS QUE VAN QUEDANDO</p><h2 id="journal-title">Una pequeña <em>crónica.</em></h2><p class="journal-intro">Hechos guardados por el mundo. Cada episodio conserva su causa y su origen.</p><div id="journal-events"></div></dialog>`;
  connection = new Connection({ world: receiveWorld, status: value => { status = value; renderStatus(); }, pending: value => { pending = value; if (!value) landscape?.setPendingTarget(null); renderControls(); }, result: result => message(result.message, result.accepted), error: text => message(text, false), expired: () => loginScreen('La sesión terminó. Vuelve a entrar para ver la carta.') });
  landscape = new Landscape(el<HTMLCanvasElement>('landscape'), pick, viewport => { connection?.setViewport(viewport); el('camera-coordinates').textContent = `${viewport.x + Math.floor(viewport.width / 2)}, ${viewport.y + Math.floor(viewport.height / 2)}`; }, () => { following = false; renderControls(); });
  wire(); renderTool(); connection.start();
}

type Drawer = 'population' | 'inspector' | 'layer' | 'tool' | 'stats';
function drawer(name: Drawer, open?: boolean): void {
  const target = el(`${name}-drawer`), next = open ?? target.hidden;
  if (next && mobile()) for (const other of root.querySelectorAll<HTMLElement>('.game-drawer')) other.hidden = true;
  target.hidden = !next;
  for (const item of ['population', 'inspector', 'layer', 'stats']) el(`${item}-toggle`).setAttribute('aria-expanded', String(!el(`${item}-drawer`).hidden));
  if (name === 'population' && next) el('population-search').focus();
  if (name === 'stats' && next) { renderStats(); el(`stats-tab-${statsTab}`).focus(); }
}
function choosePerson(id: string, focus = true): void {
  const person = world?.people.find(p => p.id === id); if (!person) return;
  activePersonId = person.id; selected = { kind: 'person', id }; control = 'inspect'; following = false; landscape?.follow(null); landscape?.select(selected);
  if (focus) landscape?.focus(person.x, person.y);
  inspectorSignature = ''; renderInspector(); renderPopulation(); renderControls(); drawer('inspector', true); el('inspector-drawer').scrollTop = 0; if (!pending) message('');
}
function chooseAnimal(id: string, focus = true): void {
  const animal = world?.animals?.find(a => a.id === id); if (!animal) return;
  selected = { kind: 'animal', id }; control = 'inspect'; following = false; landscape?.follow(null); landscape?.select(selected);
  if (focus) landscape?.focus(animal.x, animal.y);
  inspectorSignature = ''; renderInspector(); renderPopulation(); renderControls(); renderTool(); drawer('inspector', true); el('inspector-drawer').scrollTop = 0;
}
function pick(selection: Selection): void {
  if (control === 'direct' && selection.kind === 'tile') { sendCommand('move', selection); return; }
  selected = selection; landscape?.select(selection);
  if (selection.kind === 'person') { choosePerson(selection.id, false); return; }
  if (selection.kind === 'animal') { chooseAnimal(selection.id, false); return; }
  inspectorSignature = ''; renderInspector(); renderTool(); if (el('tool-drawer').hidden) drawer('inspector', true);
}
function person(): PersonView | undefined { return world?.people.find(p => p.id === activePersonId); }
function target(): { x: number; y: number } | null { if (!world) return null; const selection = selected; if (selection.kind === 'tile') return selection; const p = selection.kind === 'animal' ? world.animals?.find(a => a.id === selection.id) : person(); return p ? { x: p.x, y: p.y } : null; }
function message(text: string, accepted?: boolean): void { const output = document.getElementById('gesture-result'); if (output) { output.textContent = text; output.hidden = !text; output.dataset.accepted = accepted === undefined ? 'pending' : String(accepted); } }
function send(input: Omit<Gesture, 'id'>): void { if (!world || world.paused || status !== 'live' || pending) return; if (connection?.send({ ...input, id: crypto.randomUUID() })) { landscape?.setPendingTarget(input); message('Esperando la confirmación del mundo…'); } }
function sendCommand(order: Order, position?: { x: number; y: number }): void { const p = person(); if (!p || selected.kind === 'animal') return; send({ kind: 'command', agentId: p.id, order, x: position?.x ?? p.x, y: position?.y ?? p.y }); if (order === 'auto') { control = 'inspect'; renderControls(); } }

function wire(): void {
  for (const name of ['population', 'inspector', 'layer', 'stats'] as const) el(`${name}-toggle`).addEventListener('click', () => drawer(name));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-close]')) button.addEventListener('click', () => drawer(button.dataset.close as Drawer, false));
  el('population-search').addEventListener('input', () => { populationSignature = ''; renderPopulation(); });
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-population]')) tab.addEventListener('click', () => { populationKind = tab.dataset.population as typeof populationKind; el<HTMLInputElement>('population-search').value = ''; populationSignature = ''; renderPopulation(); el('population-search').focus(); });
  el('species-filter').addEventListener('change', () => { populationSignature = ''; renderPopulation(); });
  el('population-list').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-person], [data-animal]'); if (button?.dataset.person) choosePerson(button.dataset.person); else if (button?.dataset.animal) chooseAnimal(button.dataset.animal); });
  el('inhabitant-card').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-parent]'); if (button) choosePerson(button.dataset.parent!); });
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-stats]')) {
    tab.addEventListener('click', () => selectStatsTab(tab.dataset.stats as typeof statsTab));
    tab.addEventListener('keydown', event => { const names = ['life', 'land', 'communities', 'technology', 'performance'] as const; const index = names.indexOf(statsTab); let next = index; if (event.key === 'ArrowRight') next = (index + 1) % names.length; else if (event.key === 'ArrowLeft') next = (index + names.length - 1) % names.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = names.length - 1; else return; event.preventDefault(); selectStatsTab(names[next]!); el(`stats-tab-${statsTab}`).focus(); });
  }
  el('letter-button').addEventListener('click', () => el<HTMLDialogElement>('letter-dialog').showModal());
  el('chronicle-button').addEventListener('click', () => { renderJournal(); el<HTMLDialogElement>('chronicle-dialog').showModal(); });
  el('enter-landscape').addEventListener('click', () => { el<HTMLDialogElement>('letter-dialog').close(); el('landscape').focus(); });
  for (const dialog of root.querySelectorAll<HTMLDialogElement>('dialog')) dialog.querySelector('.dialog-close')!.addEventListener('click', () => dialog.close());
  el('logout-button').addEventListener('click', async () => { try { const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(); loginScreen(); } catch { loginScreen('Ocultamos la carta, pero no pudimos revocar la sesión. Vuelve a conectar para cerrar la sesión.'); } });
  el('zoom-in').addEventListener('click', () => landscape?.zoom(1)); el('zoom-out').addEventListener('click', () => landscape?.zoom(-1)); el('map-reset').addEventListener('click', () => { following = false; landscape?.follow(null); landscape?.fit(); renderControls(); });
  for (const role of ['S', 'I']) el(`focus-${role.toLowerCase()}`).addEventListener('click', () => { const p = world?.people.find(p => p.role === role); if (p) choosePerson(p.id); });
  el('follow-toggle').addEventListener('click', () => { if (selected.kind === 'tile') return; following = !following; landscape?.follow(following ? selected.id : null, selected.kind); renderControls(); if (mobile()) drawer('inspector', false); });
  el('direct-toggle').addEventListener('click', () => { control = control === 'direct' ? 'inspect' : 'direct'; renderControls(); if (control === 'direct' && mobile()) drawer('inspector', false); });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-order]')) button.addEventListener('click', () => sendCommand(button.dataset.order as Order));
  el('observe-tool').addEventListener('click', () => { control = 'inspect'; drawer('tool', false); root.querySelectorAll('[data-gesture]').forEach(b => b.setAttribute('aria-pressed', 'false')); el('observe-tool').setAttribute('aria-pressed', 'true'); renderControls(); });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-gesture]')) button.addEventListener('click', () => { tool = button.dataset.gesture as typeof tool; control = 'inspect'; root.querySelectorAll('[data-gesture]').forEach(item => item.setAttribute('aria-pressed', String((item as HTMLElement).dataset.gesture === tool))); el('observe-tool').setAttribute('aria-pressed', 'false'); renderTool(); renderControls(); drawer('tool', true); });
  el('gesture-send').addEventListener('click', () => { const position = target(); if (position) send({ kind: tool, x: position.x, y: position.y, ...(tool === 'remember' ? { memoryId: el<HTMLSelectElement>('memory-select').value } : {}) }); });
  el('memory-select').addEventListener('change', renderTool);
  el<HTMLSelectElement>('observation-layer').addEventListener('change', event => { const layer = (event.target as HTMLSelectElement).value as 'none' | 'moisture' | 'food'; landscape?.setLayer(layer); el('layer-explanation').textContent = layer === 'none' ? 'Agua, recursos y encuentros cambian las posibilidades.' : layer === 'food' ? 'Más dorado: más alimento. Inspecciona una casilla para ver su valor.' : 'Más azul: más humedad. Inspecciona una casilla para ver su valor.'; });
  el<HTMLSelectElement>('person-select').addEventListener('change', event => choosePerson((event.target as HTMLSelectElement).value));
  el<HTMLSelectElement>('place-select').addEventListener('change', event => { const place = world?.places.find(p => p.id === (event.target as HTMLSelectElement).value); if (place) { selected = { kind: 'tile', x: place.x, y: place.y }; landscape?.focus(place.x, place.y); landscape?.select(selected); inspectorSignature = ''; renderInspector(); drawer('layer', false); drawer('inspector', true); } });
  el<HTMLFormElement>('tile-form').addEventListener('submit', event => { event.preventDefault(); const x = Number(el<HTMLInputElement>('tile-x').value), y = Number(el<HTMLInputElement>('tile-y').value); if (!Number.isInteger(x) || !Number.isInteger(y)) return; selected = { kind: 'tile', x, y }; following = false; landscape?.follow(null); landscape?.focus(x, y); landscape?.select(selected); inspectorSignature = ''; renderInspector(); renderTool(); drawer('layer', false); });
  el('landscape').addEventListener('keydown', event => { const keyboard = event as KeyboardEvent; if (control !== 'direct' || keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey || keyboard.repeat) return; const key = keyboard.key.toLowerCase(); const offsets: Record<string, [number, number]> = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] }; const offset = offsets[key], p = person(); if (!offset || !p) return; event.preventDefault(); sendCommand('move', { x: p.x + offset[0], y: p.y + offset[1] }); });
  el('game').addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Escape') { const closingStats = !el('stats-drawer').hidden; for (const name of ['population', 'inspector', 'layer', 'tool', 'stats'] as const) drawer(name, false); control = 'inspect'; renderControls(); if (closingStats) el('stats-toggle').focus(); } });
  el('sound-toggle').addEventListener('click', async () => { if (soundContext) { stopSound(); return; } try { soundContext = new AudioContext(); await soundContext.resume(); el('sound-toggle').setAttribute('aria-pressed', 'true'); sound(); } catch { stopSound(); message('No se pudo activar el sonido. Puedes explorar sin él.', false); } });
}

function sound(): void {
  if (!soundContext) return;
  if (!document.hidden) for (const [index, frequency] of [261.63, 329.63, 392].entries()) { const oscillator = soundContext.createOscillator(), gain = soundContext.createGain(), now = soundContext.currentTime; oscillator.frequency.value = frequency; oscillator.type = 'sine'; gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.008, now + 1.5); gain.gain.exponentialRampToValueAtTime(0.0001, now + 7); oscillator.connect(gain); gain.connect(soundContext.destination); oscillator.start(now + index * .15); oscillator.stop(now + 7.2); }
  soundTimer = setTimeout(sound, 12_000);
}

function receiveWorld(next: WorldView): void {
  const first = world === null; world = next; landscape?.update(next); el('map-loading').hidden = true; el('world-day').textContent = `Día ${next.day}`; el('world-phase').textContent = `${phases[next.phase]}${next.weather === 'rain' ? ' · lluvia' : ''}`;
  el('world-extent').textContent = next.infinite ? `${next.discoveredChunks ?? 0} regiones · ${next.settlementCount ?? 0} asentamientos` : 'Región inicial';
  if (first) {
    const p = next.people.find(p => p.role === 'S') ?? next.people[0]; if (p) { activePersonId = p.id; selected = { kind: 'person', id: p.id }; landscape?.select(selected); }
    if (!mobile()) drawer('inspector', true);
    if (lastVisit === null) el<HTMLDialogElement>('letter-dialog').showModal();
    else { const events = next.events.filter(event => event.tick > lastVisit!).slice(-3).reverse(); if (events.length) { el('return-card').hidden = false; el('return-card').innerHTML = `<button class="icon-button" aria-label="Cerrar resumen de regreso">×</button><p class="eyebrow">DESDE TU ÚLTIMA VISITA</p><h2>El mundo siguió su camino.</h2><ul>${events.map(event => `<li>${esc(event.text)}</li>`).join('')}</ul>`; el('return-card').querySelector('button')!.addEventListener('click', () => { el('return-card').hidden = true; }); } }
  }
  const memoryKey = JSON.stringify(next.memories); if (memoryKey !== memorySignature) { memorySignature = memoryKey; const old = el<HTMLSelectElement>('memory-select').value; el('memory-select').innerHTML = next.memories.map(m => `<option value="${esc(m.id)}">${esc(m.title)} · ${m.source === 'sample' ? 'prueba' : 'aprobado'}</option>`).join(''); if (next.memories.some(m => m.id === old)) el<HTMLSelectElement>('memory-select').value = old; }
  const places = el<HTMLSelectElement>('place-select'), oldPlace = places.value; const placesHtml = '<option value="">Un lugar de esta región</option>' + next.places.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); if (places.innerHTML !== placesHtml) { places.innerHTML = placesHtml; places.value = oldPlace; }
  renderPopulation(); renderInspector(); renderStatus(); if (el<HTMLDialogElement>('chronicle-dialog').open) renderJournal();
}
function renderPopulation(): void {
  if (!world) return; const search = el<HTMLInputElement>('population-search').value.toLocaleLowerCase('es'); const people = world.people.filter(p => `${p.name} ${p.specialty ?? ''}`.toLocaleLowerCase('es').includes(search));
  const fauna = populationKind === 'animals';
  el('population-heading').textContent = fauna ? 'Fauna' : 'Habitantes';
  el('population-search-label').textContent = fauna ? 'Buscar animal' : 'Buscar habitante';
  el<HTMLInputElement>('population-search').placeholder = fauna ? 'Especie, actividad o identificador' : 'Nombre o especialidad';
  el('species-filter-label').hidden = !fauna; el('species-legend').hidden = !fauna;
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-population]')) tab.setAttribute('aria-pressed', String(tab.dataset.population === populationKind));
  if (fauna) {
    const species = el<HTMLSelectElement>('species-filter').value;
    const animals = (world.animals ?? []).filter(a => (!species || species === a.species) && `${speciesNames[a.species]} ${a.id} ${animalActions[a.action]}`.toLocaleLowerCase('es').includes(search));
    const signature = JSON.stringify(['animals', search, species, selected, animals.map(a => [a.id, a.species, a.action])]); el('population-count').textContent = String(world.animals?.length ?? 0);
    el('population-note').textContent = `Individuos de la región recibida por la cámara. ${animals.length} coincidencias${animals.length > 80 ? '; se muestran las primeras 80, afina la búsqueda' : ''}. Sus necesidades guían su actividad; puedes observarlos y seguirlos.`;
    if (signature === populationSignature) return; populationSignature = signature;
    el('population-list').innerHTML = animals.slice(0, 80).map(a => `<button class="population-person animal-row" data-animal="${esc(a.id)}" aria-pressed="${selected.kind === 'animal' && selected.id === a.id}"><span class="animal-avatar" style="--animal-color:${animalColors[a.species]}" aria-hidden="true">${animalSilhouette(a.species)}</span><span><strong>${speciesNames[a.species]}</strong><small>${animalActions[a.action]} · ${esc(a.id)}</small></span></button>`).join('') || '<p class="drawer-note">No hay animales que coincidan en esta región. Puedes recorrer el mapa o ampliar el filtro.</p>';
    return;
  }
  el('population-note').textContent = 'Las habilidades cambian al practicar. Puedes observar o dar una orden.';
  const signature = JSON.stringify([search, activePersonId, people.map(p => [p.id, p.name, p.specialty, p.action, p.controlMode])]); el('population-count').textContent = String(world.people.length); if (signature === populationSignature) return; populationSignature = signature;
  el('population-list').innerHTML = people.map(p => `<button class="population-person" data-person="${esc(p.id)}" aria-pressed="${p.id === activePersonId}"><span class="person-avatar ${p.role === 'S' ? 'avatar-s' : p.role === 'I' ? 'avatar-i' : ''}">${esc(p.role === 'neighbor' ? p.name.slice(0, 1) : p.role)}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.specialty ?? 'Aprendiendo su camino')}</small></span><span class="population-action">${p.controlMode === 'directed' ? icon.hand : icon.leaf}</span></button>`).join('') || '<p class="drawer-note">No hay habitantes que coincidan.</p>';
  const select = el<HTMLSelectElement>('person-select'); select.innerHTML = '<option value="">Elige un habitante</option>' + world.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); select.value = activePersonId;
}
function meter(label: string, value: number): string { const v = Math.max(0, Math.min(100, Math.round(value * 100))); return `<div class="game-need"><span>${esc(label)}</span><meter min="0" max="100" value="${v}" aria-label="${esc(label)}">${v}%</meter><span>${v}%</span></div>`; }
function animalSilhouette(species: AnimalView['species']): string {
  const paths = { hare: 'M5 17h12v-7h4v7h-4v4H3v-4h2ZM16 10V2h2v8m2 0V3h2v7', deer: 'M3 13h13V8h6v7h-4v7h-2v-7H6v7H4V13Zm15-5V1m4 7V1m-6 2h7', boar: 'M3 12h16v-2h3v8h-3v4h-2v-4H6v4H4v-4H1v-6h2Zm17 6h4v-3', fish: 'm2 6 6 6L2 18V6Zm6 6 6-5h6l4 5-4 5h-6l-6-5Z', wolf: 'M4 14h11V7l3-5 2 5h3v8h-3v7h-2v-6H7v6H5v-6l-5-4v-3l4 5Z', fox: 'M7 14h8V8l2-6 3 5h3v7h-3v7h-2v-5H9v5H7v-4l-6-2V8l6 6Z' };
  return svg(`<path d="${paths[species]}"/>`);
}
function blueprintCard(blueprint: BlueprintView): string {
  const parts = [...new Set(blueprint.components)].map(part => ({ part, count: blueprint.components.filter(c => c === part).length }));
  const author = blueprint.inventorId ? world?.people.find(p => p.id === blueprint.inventorId)?.name ?? 'Habitante fuera de esta vista' : 'Proyecto inicial';
  return `<article class="blueprint-card" data-blueprint="${esc(blueprint.id)}"><p class="eyebrow">PROYECTO · GENERACIÓN ${blueprint.generation}</p><h4>${esc(blueprint.name)}</h4><ul class="component-list">${parts.map(({ part, count }) => `<li><strong>${componentNames[part]}${count > 1 ? ` ×${count}` : ''}</strong><span>${componentPurpose[part]}</span></li>`).join('')}</ul><div class="blueprint-cost"><span><strong>${number(blueprint.cost.wood)}</strong> madera</span><span><strong>${number(blueprint.cost.stone)}</strong> piedra</span><span><strong>${number(blueprint.cost.work)}</strong> trabajo</span></div><p>Autor: ${esc(author)} · paso ${blueprint.tick}</p><p>Antecesores: ${blueprint.parents.length ? blueprint.parents.map(id => esc(world?.blueprints?.find(b => b.id === id)?.name ?? id)).join(' · ') : 'Primer diseño de su línea'}</p><div class="tile-facts"><span>Usos observados<strong>${number(blueprint.uses)}</strong></span><span>Utilidad aprendida<strong>${percentage(blueprint.usefulness)}</strong></span></div><small>La utilidad procede del uso; un proyecto nuevo todavía debe probarse.</small></article>`;
}
function personBlueprint(person: PersonView): BlueprintView | undefined {
  return world?.blueprints?.find(blueprint => blueprint.id === (person.blueprintId ?? 'blueprint-base'));
}
function structureCard(structure: StructureView): string {
  const blueprint = world?.blueprints?.find(b => b.id === structure.blueprintId);
  return `<section class="structure-card"><h3>${esc(structure.name)}</h3>${meter('Estado', structure.condition)}<p class="drawer-note">${structure.condition <= .1 ? 'Dañada: necesita reparación para funcionar.' : structure.condition < .65 ? 'El desgaste reduce sus prestaciones.' : 'En condiciones de uso.'}</p><div class="tile-facts"><span>Agua almacenada<strong>${number(structure.water, 2)} u.</strong></span><span>Alimento guardado<strong>${number(structure.food, 2)} u.</strong></span><span>Usos reales<strong>${number(structure.uses)}</strong></span></div>${blueprint ? blueprintCard(blueprint) : `<p class="drawer-note">Componentes: ${structure.components.map(part => componentNames[part]).join(' · ')}.</p>`}</section>`;
}
function replacePersonCard(html: string): void {
  const card = el('inhabitant-card');
  const active = document.activeElement as HTMLElement | null;
  const focusedDetail = active && card.contains(active) ? active.closest<HTMLDetailsElement>('details')?.dataset.detail : undefined;
  const focusedParent = active?.dataset.parent;
  const expanded = new Set([...card.querySelectorAll<HTMLDetailsElement>('details[open]')].map(detail => detail.dataset.detail));
  card.innerHTML = html;
  for (const detail of card.querySelectorAll<HTMLDetailsElement>('details')) if (expanded.has(detail.dataset.detail)) detail.open = true;
  if (focusedDetail) {
    const detail = [...card.querySelectorAll<HTMLDetailsElement>('details')].find(item => item.dataset.detail === focusedDetail);
    const next = focusedParent ? [...card.querySelectorAll<HTMLButtonElement>('[data-parent]')].find(button => button.dataset.parent === focusedParent) : detail?.querySelector<HTMLElement>('summary');
    next?.focus({ preventScroll: true });
  }
}
function inheritedAndLearned(p: PersonView): string {
  const skillNames: Record<string, string> = { gather: 'Recolección', gathering: 'Recolección', farm: 'Cultivo', farming: 'Cultivo', build: 'Construcción', building: 'Construcción', explore: 'Exploración', exploration: 'Exploración', care: 'Cuidado', cooperate: 'Cooperación', hunt: 'Caza', drink: 'Búsqueda de agua' };
  const skills = Object.entries(p.skills ?? {}).sort((a, b) => b[1] - a[1]);
  const traitNames: Record<string, string> = { curiosity: 'Curiosidad', sociability: 'Sociabilidad', industriousness: 'Constancia', care: 'Cuidado', resilience: 'Resiliencia' };
  const genome = p.genome;
  const parentMarkup = genome?.parents.length ? genome.parents.map(id => { const parent = world!.people.find(item => item.id === id); return parent ? `<button class="lineage-person" data-parent="${esc(id)}">${esc(parent.name)} ${icon.arrow}</button>` : `<span class="lineage-absent">${esc(id)} · fuera de esta vista</span>`; }).join('') : '<span class="lineage-absent">Población inicial · sin progenitores registrados</span>';
  const genetics = genome ? `<details class="person-detail" data-detail="genome"><summary>Herencia y genealogía <span class="detail-badge">G${genome.generation}</span></summary><p>Parámetros heredados y fijados al nacer. No cambian durante esta vida; no describen una biografía real.</p><div class="gene-chips"><span>Generación <strong>${genome.generation}</strong></span><span>Mutaciones <strong>${genome.mutations}</strong></span></div><div class="lineage"><h4>Progenitores</h4>${parentMarkup}</div><div class="skill-row"><span>Ritmo de aprendizaje</span><strong>${number(genome.learningRate, 2)}</strong></div>${meter('Cooperación heredada', genome.cooperation)}${p.age !== undefined ? `<p class="agent-age">Edad simulada: ${number(p.age)} pasos. No son años humanos.</p>` : ''}<p>El ritmo heredado regula cuánto aprende de sus experiencias; no garantiza una conducta.</p></details>` : '';
  const learned = skills.length || p.traits ? `<details class="person-detail" data-detail="skills"><summary>Habilidades y carácter</summary>${skills.map(([name, value]) => `<div class="skill-row"><span>${esc(skillNames[name] ?? name)}</span><strong>${percentage(value)}</strong></div>`).join('')}${p.traits ? `<div class="trait-list">${Object.entries(p.traits).map(([name, value]) => `<span>${esc(traitNames[name] ?? name)} <strong>${percentage(value)}</strong></span>`).join('')}</div>` : ''}<p>Las habilidades cambian con la práctica y la experiencia. Los rasgos heredados orientan sus preferencias.</p></details>` : '';
  const community = world?.communities?.find(group => group.id === p.communityId);
  const social = p.culture ? `<details class="person-detail" data-detail="community"><summary>Cultura y vínculos</summary><div class="person-community"><small>COMUNIDAD ACTUAL</small><strong>${esc(community?.name ?? 'Sin comunidad todavía')}</strong></div>${meter('Compartir', p.culture.sharing)}${meter('Cuidar el entorno', p.culture.stewardship)}${meter('Apertura', p.culture.openness)}<p>Costumbres aprendidas en las interacciones. Pertenecer a otro grupo no implica hostilidad.</p>${p.trust?.length ? `<h4 class="detail-subtitle">Confianza registrada</h4><div class="trust-list">${[...p.trust].sort((a, b) => b.value - a.value).slice(0, 6).map(t => `<span>${esc(world!.people.find(other => other.id === t.id)?.name ?? t.id)}<strong>${number(t.value, 2)}</strong></span>`).join('')}</div><p>Valores del modelo, no una medida de afecto real.</p>` : '<p>Todavía no hay vínculos de confianza registrados.</p>'}</details>` : '';
  const experiences = `<details class="person-detail" data-detail="experiences"><summary>Últimas experiencias <span class="detail-badge">${Math.min(8, p.experiences?.length ?? 0)}</span></summary><p>Registro reciente de esta vida simulada. Conserva el momento y el episodio que lo originó.</p>${p.experiences?.length ? `<ol class="experience-list">${p.experiences.slice(-8).reverse().map(experience => { const cause = world!.events.find(event => event.id === experience.causeId); return `<li><span class="experience-tick">PASO ${experience.tick}</span><p>${esc(experience.text)}</p><small><strong>Qué influyó:</strong> ${esc(cause?.cause ?? 'El episodio causal ya no está en la ventana reciente de la crónica.')}</small></li>`; }).join('')}</ol>` : '<p>Aún no hay experiencias registradas.</p>'}</details>`;
  const technology = world?.technology;
  const products = technology?.items.filter(item=>item.ownerId===p.id) ?? [];
  const toolkit = products.length ? `<details class="person-detail" data-detail="products"><summary>Objetos que lleva <span class="detail-badge">${products.length}</span></summary>${products.slice(0,8).map(item=>{const recipe=technology?.recipes.find(recipe=>recipe.id===item.recipeId);return `<div class="skill-row"><span>${esc(recipe?.name ?? 'Producto material')}</span><strong>${number(item.mass/1000,2)} u.</strong></div>`;}).join('')}<p>Objetos fabricados que conserva este habitante. Su masa cambia al usarlos o transformarlos.</p></details>` : '';
  const progress = p.working && p.workProgress !== undefined ? `<div class="game-needs task-progress">${meter('Progreso de la tarea',p.workProgress)}</div>` : '';
  return progress + toolkit + genetics + learned + social + experiences;
}
function renderInspector(): void {
  if (!world) return;
  el('direct-toggle').hidden = selected.kind !== 'person';
  if (selected.kind === 'animal') {
    const animalId = selected.id, animal = world.animals?.find(a => a.id === animalId);
    el('person-controls').hidden = true; el('person-primary').hidden = !animal;
    el('person-primary').classList.toggle('animal-primary', true);
    if (!animal) {
      el('inspector-title').textContent = 'Fuera de esta vista';
      replacePersonCard('<p class="drawer-note">Este individuo ya no aparece en la región recibida. Puede haber salido de la cámara o terminado su vida; la crónica conserva los episodios registrados.</p>');
      if (following) { following = false; landscape?.follow(null); }
      inspectorSignature = ''; return;
    }
    const signature = JSON.stringify(animal); if (signature === inspectorSignature) return; inspectorSignature = signature;
    el('inspector-title').textContent = speciesNames[animal.species];
    replacePersonCard(`<div class="game-person-heading"><div class="animal-avatar animal-portrait" style="--animal-color:${animalColors[animal.species]}" aria-hidden="true">${animalSilhouette(animal.species)}</div><div><strong>Una vida del paisaje</strong><span class="agency-state">${esc(animal.id)} · generación ${animal.generation}</span></div></div><p class="game-current-action">${animalActions[animal.action]} <span>· ${number(animal.x, 1)}, ${number(animal.y, 1)}</span></p><p class="game-reason">${esc(animal.reason)}</p><div class="game-needs"><h3>Necesidades de este individuo</h3>${meter('Energía', animal.energy)}${meter('Hambre', animal.hunger)}${meter('Sed', animal.thirst)}${meter('Cansancio', animal.fatigue)}${meter('Salud', animal.health)}</div><details class="person-detail" data-detail="animal-genes"><summary>Rasgos y ascendencia</summary><p>Edad: ${animal.age} pasos. Sus rasgos orientan cómo busca alimento, detecta peligro y conserva energía.</p>${Object.entries(animal.genes).map(([key, value]) => `<div class="skill-row"><span>${({ speed: 'Velocidad', perception: 'Percepción', metabolism: 'Metabolismo', carnivory: 'Carnivoría', waterEfficiency: 'Eficiencia de agua', camouflage: 'Camuflaje' } as Record<string, string>)[key] ?? esc(key)}</span><strong>${number(value, 2)}</strong></div>`).join('')}<p>Progenitores: ${animal.parents.length ? animal.parents.map(esc).join(' · ') : 'Primera generación registrada'}.</p></details><p class="drawer-note">Observas un animal autónomo. Su actividad y sus desplazamientos llegan del mundo.</p>`);
    return;
  }
  el('person-primary').classList.toggle('animal-primary', false);
  if (selected.kind === 'person') {
    const p = person();
    if (!p) {
      const id = selected.id, legacy = world.demography?.recent.find(entry=>entry.id===id);
      el('person-controls').hidden = true; el('person-primary').hidden = true; el('direct-toggle').hidden = true;
      el('inspector-title').textContent = legacy?.name ?? 'Fuera de esta vista';
      replacePersonCard(legacy ? `<p class="game-reason">Esta vida terminó en el paso ${legacy.diedAt}.</p><p class="drawer-note">${esc(deathCauses[legacy.cause] ?? legacy.cause)}</p><p>Generación ${legacy.generation}. Su historia permanece en la crónica del mundo.</p>` : '<p class="drawer-note">Este habitante ya no aparece en el estado recibido.</p>');
      if (following) { following=false; landscape?.follow(null); } control='inspect'; inspectorSignature='';return;
    }
    const signature = JSON.stringify([p, world.events.map(event => event.id), world.communities, world.blueprints, world.technology?.items.filter(item=>item.ownerId===p.id)]); if (signature === inspectorSignature) return; inspectorSignature = signature;
    el('inspector-title').textContent = p.name; el('person-controls').hidden = false; el('person-primary').hidden = false; const source = world.memories.find(m => m.text === p.recentMemory)?.source;
    const color = /^#[\da-f]{3,8}$/i.test(p.color) ? p.color : '#a4805b';
    replacePersonCard(`<div class="game-person-heading"><div class="pixel-portrait ${p.role === 'I' ? 'portrait-i' : ''}" style="--person-color:${color}" aria-hidden="true"><span class="pixel-body"></span></div><div><strong>${esc(p.specialty ?? 'Su camino está tomando forma')}</strong><span class="agency-state ${p.controlMode === 'directed' ? 'is-directed' : ''}">${p.controlMode === 'directed' ? 'Siguiendo una orden' : 'Actuando por su cuenta'}</span></div></div><p class="game-current-action">${actions[p.action]} <span>· ${p.x}, ${p.y}</span></p><p class="game-reason">${esc(p.reason)}</p><div class="game-needs"><h3>Ahora necesita ${esc(p.need.toLocaleLowerCase('es'))}</h3>${meter('Energía', p.energy)}${meter('Hambre', p.hunger)}${p.thirst === undefined ? '' : meter('Sed', p.thirst)}${meter('Cansancio', p.fatigue)}</div><div class="material-pouch"><span>${icon.leaf}<strong>${number(p.materials?.wood)}</strong> madera</span><span>${icon.hammer}<strong>${number(p.materials?.stone)}</strong> piedra</span></div>${personBlueprint(p) ? `<details class="person-detail" data-detail="blueprint"><summary>Proyecto que sabe construir</summary>${blueprintCard(personBlueprint(p)!)}</details>` : ''}${inheritedAndLearned(p)}${p.recentMemory ? `<details class="person-detail memory-detail" data-detail="memory"><summary>Algo que lleva consigo</summary><p>${esc(p.recentMemory)}</p><small>${source === 'sample' ? 'RECUERDO DE PRUEBA · NO ES BIOGRAFÍA' : source === 'approved' ? 'RECUERDO APROBADO' : 'EXPERIENCIA DEL MUNDO SIMULADO'}</small></details>` : ''}`);
  } else {
    const position = selected, tile = world.tiles.find(t => t.x === position.x && t.y === position.y); el('person-controls').hidden = true; el('person-primary').hidden = true;
    if (!tile) { el('inspector-title').textContent = 'Otra región'; el('inhabitant-card').innerHTML = '<p class="drawer-note">Esperando esta parte del paisaje. Recorrer con la cámara no añade hechos a la crónica.</p>'; return; }
    const place = world.places.find(p => Math.hypot(p.x - tile.x, p.y - tile.y) < 1.5); const structures = world.structures?.filter(s => s.x === tile.x && s.y === tile.y) ?? []; const signature = JSON.stringify([tile, place, structures, world.blueprints, world.animals?.filter(a => a.x === tile.x && a.y === tile.y)]); if (signature === inspectorSignature) return; inspectorSignature = signature; el('inspector-title').textContent = place?.name ?? terrains[tile.terrain];
    el('inhabitant-card').innerHTML = `<p class="tile-biome">${esc(biomes[tile.biome ?? ''] ?? terrains[tile.terrain])} <span>· ${tile.x}, ${tile.y}</span></p><p class="game-reason">${esc(place?.description ?? 'El terreno y los recursos abren posibilidades distintas para cada habitante.')}</p><div class="game-needs"><h3>Recursos del lugar</h3>${meter('Humedad', tile.moisture)}${meter('Vegetación', tile.vegetation)}${meter('Alimento', tile.food)}</div><div class="material-pouch"><span>${icon.leaf}<strong>${Math.floor(tile.wood ?? 0)}</strong> madera</span><span>${icon.hammer}<strong>${Math.floor(tile.stone ?? 0)}</strong> piedra</span></div><div class="tile-facts">${tile.drinkingWater !== undefined ? `<span>Agua dulce<strong>${number(tile.drinkingWater, 1)} u.</strong></span>` : ''}${world.animals === undefined && tile.species && tile.fauna !== undefined ? `<span>${esc(({ hare: 'Liebres', deer: 'Venados', boar: 'Jabalíes', fish: 'Peces' } as Record<string, string>)[tile.species] ?? tile.species)}<strong>${number(tile.fauna)} animales</strong></span>` : ''}${tile.cultivation !== undefined ? `<span>Cultivo<strong>${percentage(tile.cultivation)}</strong></span>` : ''}${tile.fertility !== undefined ? `<span>Fertilidad<strong>${percentage(tile.fertility)}</strong></span>` : ''}${tile.traffic !== undefined ? `<span>Huellas de paso<strong>${number(tile.traffic, 1)}</strong></span>` : ''}</div>${structures.map(structureCard).join('')}${world.animals ? `<p class="drawer-note">${world.animals.filter(a => a.x === tile.x && a.y === tile.y).length} animales individuales en esta casilla.</p>` : ''}${place ? `<p class="drawer-note">${place.gatherings} encuentros registrados aquí.</p>` : ''}<p class="drawer-note">Selecciona un habitante para dar una orden; usa las herramientas para intervenir en esta casilla.</p>`;
  }
}
function renderControls(): void {
  const selection = selected;
  if (!document.getElementById('direct-toggle')) return; const blocked = status !== 'live' || !!world?.paused || pending || !world || !person() || selected.kind === 'animal';
  el<HTMLButtonElement>('direct-toggle').disabled = blocked; el('direct-toggle').setAttribute('aria-pressed', String(control === 'direct')); el('follow-toggle').setAttribute('aria-pressed', String(following));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-order]')) button.disabled = blocked;
  el('mode-indicator').hidden = control !== 'direct' && !following; el('mode-indicator').textContent = control === 'direct' ? `Dirigir a ${person()?.name ?? ''}: toca un destino · WASD mueve una casilla · Esc sale` : `Siguiendo a ${selected.kind === 'animal' ? speciesNames[world?.animals?.find(a => a.id === (selection.kind === 'animal' ? selection.id : ''))?.species ?? 'hare'] : person()?.name ?? ''} · arrastra para liberar la cámara`;
  el('control-help').textContent = control === 'direct' ? 'Toca un lugar del mapa. El habitante camina; no se teletransporta.' : 'Las órdenes se confirman en el servidor. Autonomía devuelve las decisiones al habitante.';
  el('game').classList.toggle('direct-mode', control === 'direct'); renderTool();
}
function renderStatus(): void {
  if (!document.getElementById('connection-label')) return; const paused = !!world?.paused; el('connection-label').textContent = paused ? 'En pausa' : status === 'live' ? 'En vivo' : status === 'offline' ? 'Reconectando' : 'Conectando'; el('connection-label').dataset.live = String(status === 'live' && !paused);
  el('connection-notice').hidden = status === 'live' && !paused; el('connection-notice').textContent = paused ? world?.pauseReason ?? 'El mundo está en pausa para proteger lo guardado.' : status === 'offline' ? 'Sin conexión. Ves el último estado recibido; las órdenes esperan hasta reconectar.' : 'Conectando con el mundo…'; renderControls(); if (!el('stats-drawer').hidden) renderStats();
}
function renderTool(): void {
  if (!document.getElementById('gesture-title')) return;
  const labels = { plant: ['Sembrar', 'Deja una planta en la casilla elegida. Necesita agua y luz para crecer.', 'Sembrar aquí'], invite: ['Invitar', 'Deja una invitación en el lugar elegido. Cada habitante decide si responder.', 'Invitar aquí'], remember: ['Recordar', 'Un recuerdo ofrece contexto; no impone una reconciliación ni una decisión.', 'Traer este recuerdo'] };
  el('gesture-title').textContent = labels[tool][0]!; el('gesture-description').textContent = labels[tool][1]!; el('memory-choice').hidden = tool !== 'remember'; const memory = world?.memories.find(m => m.id === el<HTMLSelectElement>('memory-select').value);
  el('memory-preview').textContent = memory ? `${memory.source === 'sample' ? 'Recuerdo de prueba, no biográfico' : 'Recuerdo aprobado'}: ${memory.text}` : 'No hay recuerdos disponibles.';
  const position = target(); el('gesture-target').textContent = position ? `casilla ${position.x}, ${position.y}` : 'toca una casilla'; const button = el<HTMLButtonElement>('gesture-send'); button.innerHTML = pending ? 'Esperando confirmación…' : `${labels[tool][2]} ${icon.arrow}`; button.disabled = status !== 'live' || !!world?.paused || pending || !position || (tool === 'remember' && !memory);
}
function renderJournal(): void {
  const names: Record<ChronicleEvent['kind'], string> = { ecology: 'Paisaje', meeting: 'Encuentro', care: 'Cuidado', learning: 'Aprendizaje', memory: 'Memoria', gesture: 'Tu gesto', pause: 'Pausa del servidor', discovery: 'Un descubrimiento', settlement: 'Un nuevo lugar', cooperation: 'Cooperación', birth: 'Una nueva vida', death: 'Una vida que terminó', animal: 'Vida animal', invention: 'Un proyecto aprendido', community: 'Comunidad', conflict: 'Un desacuerdo', adaptation: 'Adaptación local' };
  el('journal-events').innerHTML = world?.events.length ? [...world.events].slice(-32).reverse().map(event => `<article class="chronicle-event"><div class="event-label"><span>${names[event.kind]}</span><span>${event.source === 'sample' ? 'Material de prueba' : event.source === 'approved' ? 'Contenido aprobado' : 'Ficción simulada'}</span></div><p>${esc(event.text)}</p><div class="event-cause"><strong>Qué influyó</strong> ${esc(event.cause)}</div><span class="event-tick">Momento ${event.tick} del mundo</span></article>`).join('') : '<p class="quiet-event">Todavía no hay episodios guardados. El mundo también tiene silencios.</p>';
}

function selectStatsTab(tab: typeof statsTab): void {
  statsTab = tab;
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-stats]')) { const active = button.dataset.stats === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
  el('stats-content').setAttribute('aria-labelledby', `stats-tab-${tab}`); renderStats();
}

const number = (value: number | undefined, digits = 0): string => value !== undefined && Number.isFinite(value) ? value.toLocaleString('es-CO', { maximumFractionDigits: digits }) : '—';
const percentage = (value: number | undefined): string => value !== undefined && Number.isFinite(value) ? `${number(value * 100)}%` : '—';
function statCard(label: string, value: string, note: string, accent = ''): string { return `<article class="stat-card ${accent}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`; }

/** Charts use the server's sample ticks, not evenly spaced invented timestamps. */
function sparkline(points: { tick: number; value: number }[], title: string, unit: string, fixedRange?: [number, number]): string {
  const safe = points.filter(p => Number.isFinite(p.tick) && Number.isFinite(p.value)).slice(-96);
  if (!safe.length) return `<figure class="history-chart"><figcaption>${esc(title)}</figcaption><p class="stats-empty">Todavía no hay muestras de esta serie.</p></figure>`;
  const width = 280, height = 92, padding = 8;
  const start = safe[0]!.tick, end = safe.at(-1)!.tick;
  const minimum = fixedRange?.[0] ?? 0, maximum = fixedRange?.[1] ?? Math.max(1, ...safe.map(p => p.value)) * 1.1;
  const span = Math.max(0.0001, maximum - minimum);
  const mapped = safe.map(p => ({ x: safe.length === 1 ? width / 2 : padding + (p.tick - start) / Math.max(1, end - start) * (width - padding * 2), y: height - padding - Math.max(0, Math.min(1, (p.value - minimum) / span)) * (height - padding * 2) }));
  const coordinates = mapped.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const latest = safe.at(-1)!; const label = `${title}. ${safe.length} ${safe.length === 1 ? 'muestra' : 'muestras'}, pasos ${start} a ${end}. Último valor ${number(latest.value, 2)} ${unit}.`;
  return `<figure class="history-chart"><figcaption><span>${esc(title)}</span><strong>${esc(number(latest.value, 1))}<small>${esc(unit)}</small></strong></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><path class="chart-grid" d="M8 8H272M8 46H272M8 84H272"/><polyline class="chart-line" points="${coordinates}" fill="none"/><circle class="chart-point" cx="${mapped.at(-1)!.x.toFixed(2)}" cy="${mapped.at(-1)!.y.toFixed(2)}" r="3"/></svg><div class="chart-axis"><span>Paso ${start}</span><span>${safe.length} ${safe.length === 1 ? 'muestra' : 'muestras'}</span><span>${end}</span></div></figure>`;
}

function distribution(data: Record<string, number> | undefined, labels: Record<string, string>, unit: string): string {
  const rows = Object.entries(data ?? {}).filter(([, value]) => Number.isFinite(value) && value >= 0).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<p class="stats-empty">Aún no hay datos registrados.</p>';
  const maximum = Math.max(1, ...rows.map(([, value]) => value));
  return `<div class="distribution">${rows.map(([key, value]) => `<div class="distribution-row"><div><span>${esc(labels[key] ?? key)}</span><strong>${esc(number(value, 1))}<small>${esc(unit)}</small></strong></div><span class="distribution-track" aria-hidden="true"><i style="width:${(value / maximum * 100).toFixed(2)}%"></i></span></div>`).join('')}</div>`;
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
  return `<section class="stats-section"><div class="stats-section-heading"><h3>Proyectos y construcciones</h3><span>Aprendidos en el mundo</span></div><div class="stats-grid">${statCard('Planos conocidos', number(stats.blueprints), 'Familias y variantes registradas')}${statCard('Investigaciones', number(dynamics?.attempts), 'Intentos acumulados')}${statCard('Variantes aceptadas', number(dynamics?.accepted), 'Proyectos viables')}${statCard('Reparaciones', number(dynamics?.repairs), 'Acciones con material y trabajo')}${statCard('Lluvia recogida', number(dynamics?.waterCollected, 2), 'Agua en cisternas')}${statCard('Alimento retirado', number(dynamics?.foodTaken, 2), 'Consumido desde graneros')}</div>${distribution(stats.structures, componentNames, 'componentes')}<p class="stats-note">Las estructuras combinan funciones. Se desgastan, conservan existencias reales y pueden repararse.</p>${world?.blueprints?.length ? `<details class="person-detail" data-detail="blueprints"><summary>Cuaderno de proyectos (${world.blueprints.length})</summary>${world.blueprints.slice(-24).map(blueprintCard).join('')}${world.blueprints.length > 24 ? '<p>Se muestran los 24 proyectos más recientes.</p>' : ''}</details>` : ''}</section>`;
}
function renderStats(): void {
  const panel = document.getElementById('stats-content'); if (!panel || !world) return;
  const stats = world.stats, runtime = world.performance;
  const stamp = `<div class="stats-scope"><span class="scope-dot"></span><span>${status === 'live' && !world.paused ? 'Estado recibido del servidor' : 'Último estado recibido'} · paso ${world.tick}</span></div>`;
  if (statsTab === 'technology') {
    const opened = new Set([...panel.querySelectorAll<HTMLDetailsElement>('details[open]')].map(detail=>detail.dataset.detail));
    const focused = panel.contains(document.activeElement) ? (document.activeElement?.closest('details') as HTMLDetailsElement | null)?.dataset.detail : undefined;
    const scroll = panel.scrollTop;
    panel.innerHTML = stamp + technologyPane(world.technology,world.organization);
    for (const detail of panel.querySelectorAll<HTMLDetailsElement>('details')) { if (opened.has(detail.dataset.detail)) detail.open = true; if (focused && focused === detail.dataset.detail) detail.querySelector('summary')?.focus({preventScroll:true}); }
    panel.scrollTop = scroll;
    return;
  }
  if (statsTab === 'performance') {
    const graphics = (landscape as (Landscape & { getDiagnostics?: () => GraphicsDiagnostics }) | null)?.getDiagnostics?.();
    const gpuLabels: Record<string, string> = { hardware: 'WebGL · adaptador físico reconocido', software: 'Respaldo Canvas2D · adaptador de software', unverified: 'WebGL activo · hardware sin verificar', 'context-lost': 'Contexto perdido · respaldo Canvas2D', active: 'GPU activa', ready: 'GPU preparada', available: 'GPU disponible', pending: 'Consultando GPU', initializing: 'Inicializando GPU', unavailable: 'GPU no disponible', unsupported: 'GPU no compatible', disabled: 'GPU desactivada', failed: 'GPU no disponible', lost: 'Dispositivo perdido', 'device-lost': 'Dispositivo perdido', fallback: 'Respaldo gráfico activo' };
    panel.innerHTML = `${stamp}<section class="stats-section"><div class="stats-section-heading"><h3>Servidor · CPU y persistencia</h3><span>Mediciones reales</span></div><p class="stats-note">Duración del trabajo y memoria del proceso. No representan el porcentaje de uso total de la CPU.</p>${runtime ? `<div class="stats-grid">${statCard('Paso de simulación', `${number(runtime.stepMs, 2)} ms`, 'Último paso')}${statCard('Paso p95', `${number(runtime.p95StepMs, 2)} ms`, 'Ventana medida por el servidor')}${statCard('Guardado', `${number(runtime.saveMs, 2)} ms`, 'Persistencia')}${statCard('Proyección', `${number(runtime.projectionMs, 2)} ms`, 'Preparación de una vista')}${statCard('Memoria del proceso', `${number(runtime.processRssMiB, 1)} MiB`, 'RSS del servidor')}${statCard('Estado serializado', `${number(runtime.snapshotBytes / 1024, 1)} KiB`, 'Tamaño de la muestra medida')}</div>` : '<p class="stats-empty">El servidor todavía no envió sus medidas de rendimiento.</p>'}</section><section class="stats-section"><div class="stats-section-heading"><h3>Este navegador · gráficos</h3><span>${esc(graphics?.backend === 'canvas2d-cached' ? 'Canvas2D con caché' : graphics?.backend === 'webgl2' ? 'WebGL2' : 'Esperando diagnóstico')}</span></div>${graphics ? `<div class="gpu-state"><span>${icon.layers}</span><div><strong>${esc(gpuLabels[graphics.gpuStatus ?? ''] ?? graphics.gpuStatus ?? 'Estado gráfico sin informar')}</strong><p>${esc(graphics.gpuLabel ?? 'El navegador no informó un nombre de dispositivo.')}</p></div></div><div class="stats-grid">${statCard('Dibujo', `${number(graphics.fps, 1)} FPS`, 'Frecuencia observada en esta pestaña')}${statCard('CPU por cuadro', `${number(graphics.frameMs, 2)} ms`, 'Preparación y envío del dibujo')}${statCard('Casillas visibles', number(graphics.visibleTiles), 'Trabajo de esta cámara')}${statCard('Animales visibles', number(graphics.visibleAnimals), 'Cuerpos dibujados en esta cámara')}${statCard('Construcciones visibles', number(graphics.visibleStructures), 'Componentes de estructuras')}${statCard('Composiciones', number(graphics.drawCalls), 'Sprites y texturas, no todas las operaciones')}${statCard('Caché gráfico', `${number(graphics.cacheBytes === undefined ? undefined : graphics.cacheBytes / 1048576, 2)} MiB`, `${number(graphics.cacheEntries)} entradas · ${number(graphics.cacheBuilds)} construcciones`)}</div>` : '<p class="stats-empty">Todavía no hay diagnóstico del renderizador. No se puede afirmar que la GPU esté activa.</p>'}<p class="stats-note">La CPU del servidor decide lo que ocurre; los gráficos de esta pestaña dibujan el estado recibido. Los tiempos de dibujo no miden la ocupación de la GPU. Cerrar la pestaña no detiene el mundo.</p></section>`;
    return;
  }
  if (statsTab === 'communities') {
    panel.innerHTML = `${stamp}<p class="stats-note">Las comunidades se forman en el mundo simulado. Su cultura y confianza cambian con las interacciones; pertenecer a grupos distintos no implica hostilidad.</p>${world.communities?.length ? world.communities.map(community => {
      const color = /^#[\da-f]{3,8}$/i.test(community.color) ? community.color : '#779264';
      const members = community.members.map(id => world!.people.find(p => p.id === id)?.name ?? 'Habitante del mundo');
      return `<article class="community-card"><header><span class="community-swatch" style="background:${color}" aria-hidden="true"></span><div><h3>${esc(community.name)}</h3><p>${community.members.length} habitantes · desde el paso ${community.formedAt}</p></div></header><p class="community-members">${members.map(esc).join(' · ')}</p><div class="community-counts"><span><strong>${number(community.cooperation)}</strong> cooperaciones</span><span><strong>${number(community.disputes)}</strong> desacuerdos</span></div>${meter('Compartir', community.culture.sharing)}${meter('Cuidar el entorno', community.culture.stewardship)}${meter('Apertura', community.culture.openness)}</article>`;
    }).join('') : '<div class="stats-empty illustrated-empty">Todavía no se ha formado una comunidad. Los encuentros y las acciones locales pueden dejar costumbres compartidas.</div>'}`;
    return;
  }
  if (!stats) { panel.innerHTML = `${stamp}<p class="stats-empty">El servidor todavía no envió estas estadísticas.</p>`; return; }
  const scope = '<p class="stats-note stats-scope-note">Paisaje y recursos: regiones activas del servidor, no todo el territorio posible ni solo la cámara. Los acumulados se identifican aparte.</p>';
  if (statsTab === 'land') {
    const featureNames: Record<string, string> = { tree: 'Árboles', pine: 'Pinos', palm: 'Palmeras', cactus: 'Cactus', reeds: 'Juncos', berries: 'Bayas', flowers: 'Flores', rock: 'Rocas', clay: 'Arcilla', stump: 'Tocones', spring: 'Manantiales', none: 'Sin elemento destacado' };
    const species = speciesPlural;
    panel.innerHTML = `${stamp}${scope}<div class="stats-grid">${statCard('Regiones activas', number(world.activeChunks), 'Cerca de los habitantes')}${statCard('Casillas activas', number(runtime?.activeTiles), 'Terreno en actividad')}${statCard('Agua dulce', number(stats.freshWater, 1), 'Unidades del modelo')}${statCard('Cultivos', number(stats.cultivatedTiles), 'Casillas cultivadas')}${statCard('Senderos', number(stats.trailTiles), 'Casillas con huellas')}${statCard('Madera y piedra', `${number(stats.materials.wood)} / ${number(stats.materials.stone)}`, 'Inventarios de habitantes')}</div><div class="stats-two-columns"><section class="stats-section"><div class="stats-section-heading"><h3>Biomas activos</h3><span>Casillas</span></div>${distribution(stats.biomes, biomes, '')}</section><section class="stats-section"><div class="stats-section-heading"><h3>Vida animal</h3><span>Individuos en regiones activas</span></div>${distribution(stats.wildlife, species, '')}<p class="stats-note">El censo cuenta cuerpos individuales. La caza, la depredación, el agua y las plantas influyen en su supervivencia.</p></section></div><section class="stats-section"><div class="stats-section-heading"><h3>Elementos del paisaje</h3><span>Casillas activas</span></div>${distribution(stats.features, featureNames, '')}</section>${lifeDynamics()}${inventionStats()}`;
    return;
  }
  const history = stats.history ?? [];
  const actionLabels = Object.fromEntries(Object.entries(actions).map(([key, text]) => [key, text]));
  const accumulated = `<section class="stats-section"><div class="stats-section-heading"><h3>Lo que han hecho juntos</h3><span>Acumulado del mundo</span></div><div class="stats-facts">${([['teaching', 'Aprendizajes compartidos'], ['trade', 'Intercambios'], ['constructionHelp', 'Ayudas en tareas'], ['conflicts', 'Desacuerdos'], ['hunts', 'Animales cazados'], ['cultivations', 'Acciones de cultivo']] as const).map(([key, label]) => `<span>${label}<strong>${number(stats.totals[key])}</strong></span>`).join('')}</div></section>`;
  panel.innerHTML = `${stamp}<div class="stats-grid">${statCard('Habitantes', number(stats.population), 'Población de la simulación')}${statCard('Energía media', percentage(stats.meanEnergy), 'Estado corporal, no afecto')}${statCard('Hambre media', percentage(stats.meanHunger), 'Necesidad de alimento')}${statCard('Sed media', percentage(stats.meanThirst), 'Necesidad de agua')}${statCard('Cooperaciones', number(stats.totals.cooperation), 'Acciones acumuladas')}${statCard('Nuevas vidas', number(stats.totals.births), 'Nacimientos simulados acumulados')}</div><div class="stats-chart-grid">${sparkline(history.map(p => ({ tick: p.tick, value: p.population })), 'Población en el tiempo', 'habitantes')}${sparkline(history.map(p => ({ tick: p.tick, value: p.energy * 100 })), 'Energía media', '% media', [0, 100])}</div><section class="stats-section"><div class="stats-section-heading"><h3>Qué están haciendo</h3><span>Habitantes ahora</span></div>${distribution(stats.actions, actionLabels, '')}</section><div class="stats-two-columns"><section class="stats-section"><div class="stats-section-heading"><h3>Generaciones</h3><span>Habitantes</span></div>${distribution(stats.generations, Object.fromEntries(Object.keys(stats.generations).map(key => [key, `Generación ${key}`])), '')}</section><section class="stats-section"><div class="stats-section-heading"><h3>Historia que se acumula</h3></div><div class="stats-facts"><span>Regiones descubiertas<strong>${number(world.discoveredChunks)}</strong></span><span>Asentamientos construidos<strong>${number(world.settlementCount)}</strong></span><span>Cansancio medio<strong>${percentage(stats.meanFatigue)}</strong></span></div></section></div>${accumulated}${scope}`;
}
window.addEventListener('pagehide', saveVisit); document.addEventListener('visibilitychange', () => { if (document.hidden) saveVisit(); });
async function boot(): Promise<void> { root.innerHTML = '<main class="boot-screen"><span>✧</span><p>Abriendo la carta…</p></main>'; try { const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) }); const session = await response.json() as { authenticated: boolean }; if (response.ok && session.authenticated) enterWorld(); else loginScreen(); } catch { loginScreen('No hay conexión con el servidor. Puedes volver a intentar.'); } }
void boot();
