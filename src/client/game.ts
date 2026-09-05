import type { ChronicleEvent, Gesture, Order, PersonView, WorldView } from '../shared/types.js';
import { Connection, type ConnectionStatus } from './connection.js';
import { Landscape, type Selection } from './landscape.js';
import { icons } from './icons.js';
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
};
const actions: Record<PersonView['action'], string> = { explore: 'Explorando', eat: 'Buscando alimento', rest: 'Descansando', approach: 'Acercándose', accompany: 'Acompañando', retreat: 'Buscando espacio', share: 'Compartiendo', gather: 'Recolectando', farm: 'Cultivando', build: 'Construyendo' };
const phases = { dawn: 'Amanecer', day: 'Día', dusk: 'Atardecer', night: 'Noche' };
const terrains = { water: 'Agua', meadow: 'Pradera', soil: 'Tierra', shelter: 'Refugio' };
const biomes: Record<string, string> = { grassland: 'Praderas', forest: 'Bosque', desert: 'Desierto', mountain: 'Montañas', wetland: 'Humedal', ocean: 'Océano' };
const orders: { order: Order; title: string; icon: string }[] = [
  { order: 'explore', title: 'Explorar', icon: icon.focus }, { order: 'gather', title: 'Recolectar', icon: icon.bag },
  { order: 'farm', title: 'Cultivar', icon: icon.leaf }, { order: 'build', title: 'Construir', icon: icon.hammer },
  { order: 'rest', title: 'Descansar', icon: icon.tent }, { order: 'auto', title: 'Autonomía', icon: icon.star },
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
let soundContext: AudioContext | null = null;
let soundTimer: ReturnType<typeof setTimeout> | undefined;
const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const mobile = (): boolean => matchMedia('(max-width: 760px)').matches;
function saveVisit(): void { if (world) try { localStorage.setItem('carta:last-visit', String(world.tick)); } catch { /* Optional. */ } }
function readVisit(): number | null { try { const raw = localStorage.getItem('carta:last-visit'); return raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null; } catch { return null; } }
function stopSound(): void { clearTimeout(soundTimer); if (soundContext) void soundContext.close(); soundContext = null; document.getElementById('sound-toggle')?.setAttribute('aria-pressed', 'false'); }
function clean(): void { saveVisit(); connection?.stop(); landscape?.destroy(); stopSound(); connection = null; landscape = null; world = null; pending = false; following = false; control = 'inspect'; populationSignature = ''; inspectorSignature = ''; memorySignature = ''; }

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
    <aside class="world-rail hud-surface" aria-label="Exploración"><button id="population-toggle" class="icon-button" aria-label="Población" aria-expanded="false" aria-controls="population-drawer">${icon.people}</button><button id="layer-toggle" class="icon-button" aria-label="Capas y coordenadas" aria-expanded="false" aria-controls="layer-drawer">${icon.layers}</button><span></span><button id="focus-s" class="role-button role-s" aria-label="Encontrar a S">S</button><button id="focus-i" class="role-button role-i" aria-label="Encontrar a I">I</button></aside>
    <aside id="population-drawer" class="game-drawer population-drawer" hidden aria-label="Población del mundo"><header><div><p class="eyebrow">CADA VIDA, UN CAMINO</p><h2>Habitantes <span id="population-count">0</span></h2></div><button class="icon-button" data-close="population" aria-label="Cerrar población">×</button></header><label class="search-label" for="population-search">Buscar habitante<input id="population-search" type="search" placeholder="Nombre o especialidad" autocomplete="off"></label><div id="population-list" class="population-list"></div><p class="drawer-footnote">Las habilidades cambian al practicar. Puedes observar o dar una orden.</p></aside>
    <aside id="inspector-drawer" class="game-drawer inspector-drawer" hidden aria-label="Inspector de selección"><header><div><p class="eyebrow">MIRAR DE CERCA</p><h2 id="inspector-title">Habitante</h2></div><button class="icon-button" data-close="inspector" aria-label="Cerrar inspector">×</button></header><div id="person-primary" class="control-pair"><button id="follow-toggle" class="button secondary" aria-pressed="false">${icon.eye}Seguir</button><button id="direct-toggle" class="button primary" aria-pressed="false">${icon.hand}Dirigir</button></div><div id="inhabitant-card" tabindex="-1"></div><div id="person-controls"><p id="control-help" class="control-help"></p><div class="order-grid">${orders.map(order => `<button data-order="${order.order}">${order.icon}<span>${order.title}</span></button>`).join('')}</div></div></aside>
    <aside id="layer-drawer" class="game-drawer layer-drawer" hidden aria-label="Capas y coordenadas"><header><div><p class="eyebrow">LEER EL PAISAJE</p><h2>Observar</h2></div><button class="icon-button" data-close="layer" aria-label="Cerrar capas">×</button></header><label for="observation-layer">Capa del mapa<select id="observation-layer"><option value="none">El paisaje</option><option value="moisture">La humedad</option><option value="food">El alimento</option></select></label><p id="layer-explanation" class="drawer-note">Agua, recursos y encuentros cambian las posibilidades.</p><label for="person-select">Ir a un habitante<select id="person-select"></select></label><label for="place-select">Ir a un lugar conocido<select id="place-select"></select></label><form id="tile-form"><fieldset><legend>Recorrer por coordenadas</legend><label for="tile-x">X<input id="tile-x" type="number" min="-9999900" max="9999900" value="0" required></label><label for="tile-y">Y<input id="tile-y" type="number" min="-9999900" max="9999900" value="0" required></label><button class="button primary" type="submit">Ir ${icon.arrow}</button></fieldset></form></aside>
    <aside id="tool-drawer" class="game-drawer tool-drawer" hidden aria-label="Gesto en el mundo"><header><div><p class="eyebrow">CAMBIAR UNA POSIBILIDAD</p><h2 id="gesture-title">Sembrar</h2></div><button class="icon-button" data-close="tool" aria-label="Cerrar gesto">×</button></header><p id="gesture-description" class="drawer-note"></p><div id="memory-choice" hidden><label for="memory-select">Recuerdo disponible<select id="memory-select"></select></label><p id="memory-preview" class="memory-preview"></p></div><p class="target-line">Destino: <strong id="gesture-target">toca una casilla</strong></p><button id="gesture-send" class="button primary" disabled>Sembrar aquí ${icon.arrow}</button></aside>
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

type Drawer = 'population' | 'inspector' | 'layer' | 'tool';
function drawer(name: Drawer, open?: boolean): void {
  const target = el(`${name}-drawer`), next = open ?? target.hidden;
  if (next && mobile()) for (const other of root.querySelectorAll<HTMLElement>('.game-drawer')) other.hidden = true;
  target.hidden = !next;
  for (const item of ['population', 'inspector', 'layer']) el(`${item}-toggle`).setAttribute('aria-expanded', String(!el(`${item}-drawer`).hidden));
  if (name === 'population' && next) el('population-search').focus();
}
function choosePerson(id: string, focus = true): void {
  const person = world?.people.find(p => p.id === id); if (!person) return;
  activePersonId = person.id; selected = { kind: 'person', id }; control = 'inspect'; following = false; landscape?.follow(null); landscape?.select(selected);
  if (focus) landscape?.focus(person.x, person.y);
  inspectorSignature = ''; renderInspector(); renderPopulation(); renderControls(); drawer('inspector', true); el('inspector-drawer').scrollTop = 0; if (!pending) message('');
}
function pick(selection: Selection): void {
  if (control === 'direct' && selection.kind === 'tile') { sendCommand('move', selection); return; }
  selected = selection; landscape?.select(selection);
  if (selection.kind === 'person') { choosePerson(selection.id, false); return; }
  inspectorSignature = ''; renderInspector(); renderTool(); if (el('tool-drawer').hidden) drawer('inspector', true);
}
function person(): PersonView | undefined { return world?.people.find(p => p.id === activePersonId); }
function target(): { x: number; y: number } | null { if (!world) return null; if (selected.kind === 'tile') return selected; const p = person(); return p ? { x: p.x, y: p.y } : null; }
function message(text: string, accepted?: boolean): void { const output = document.getElementById('gesture-result'); if (output) { output.textContent = text; output.hidden = !text; output.dataset.accepted = accepted === undefined ? 'pending' : String(accepted); } }
function send(input: Omit<Gesture, 'id'>): void { if (!world || world.paused || status !== 'live' || pending) return; if (connection?.send({ ...input, id: crypto.randomUUID() })) { landscape?.setPendingTarget(input); message('Esperando la confirmación del mundo…'); } }
function sendCommand(order: Order, position?: { x: number; y: number }): void { const p = person(); if (!p) return; send({ kind: 'command', agentId: p.id, order, x: position?.x ?? p.x, y: position?.y ?? p.y }); if (order === 'auto') { control = 'inspect'; renderControls(); } }

function wire(): void {
  for (const name of ['population', 'inspector', 'layer'] as const) el(`${name}-toggle`).addEventListener('click', () => drawer(name));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-close]')) button.addEventListener('click', () => drawer(button.dataset.close as Drawer, false));
  el('population-search').addEventListener('input', () => { populationSignature = ''; renderPopulation(); });
  el('population-list').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-person]'); if (button) choosePerson(button.dataset.person!); });
  el('letter-button').addEventListener('click', () => el<HTMLDialogElement>('letter-dialog').showModal());
  el('chronicle-button').addEventListener('click', () => { renderJournal(); el<HTMLDialogElement>('chronicle-dialog').showModal(); });
  el('enter-landscape').addEventListener('click', () => { el<HTMLDialogElement>('letter-dialog').close(); el('landscape').focus(); });
  for (const dialog of root.querySelectorAll<HTMLDialogElement>('dialog')) dialog.querySelector('.dialog-close')!.addEventListener('click', () => dialog.close());
  el('logout-button').addEventListener('click', async () => { try { const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(); loginScreen(); } catch { loginScreen('Ocultamos la carta, pero no pudimos revocar la sesión. Vuelve a conectar para cerrar la sesión.'); } });
  el('zoom-in').addEventListener('click', () => landscape?.zoom(1)); el('zoom-out').addEventListener('click', () => landscape?.zoom(-1)); el('map-reset').addEventListener('click', () => { following = false; landscape?.follow(null); landscape?.fit(); renderControls(); });
  for (const role of ['S', 'I']) el(`focus-${role.toLowerCase()}`).addEventListener('click', () => { const p = world?.people.find(p => p.role === role); if (p) choosePerson(p.id); });
  el('follow-toggle').addEventListener('click', () => { following = !following; landscape?.follow(following ? activePersonId : null); renderControls(); if (mobile()) drawer('inspector', false); });
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
  el('game').addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Escape') { for (const name of ['population', 'inspector', 'layer', 'tool'] as const) drawer(name, false); control = 'inspect'; renderControls(); } });
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
  const signature = JSON.stringify([search, activePersonId, people.map(p => [p.id, p.name, p.specialty, p.action, p.controlMode])]); el('population-count').textContent = String(world.people.length); if (signature === populationSignature) return; populationSignature = signature;
  el('population-list').innerHTML = people.map(p => `<button class="population-person" data-person="${esc(p.id)}" aria-pressed="${p.id === activePersonId}"><span class="person-avatar ${p.role === 'S' ? 'avatar-s' : p.role === 'I' ? 'avatar-i' : ''}">${esc(p.role === 'neighbor' ? p.name.slice(0, 1) : p.role)}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.specialty ?? 'Aprendiendo su camino')}</small></span><span class="population-action">${p.controlMode === 'directed' ? icon.hand : icon.leaf}</span></button>`).join('') || '<p class="drawer-note">No hay habitantes que coincidan.</p>';
  const select = el<HTMLSelectElement>('person-select'); select.innerHTML = '<option value="">Elige un habitante</option>' + world.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); select.value = activePersonId;
}
function meter(label: string, value: number): string { const v = Math.max(0, Math.min(100, Math.round(value * 100))); return `<div class="game-need"><span>${esc(label)}</span><meter min="0" max="100" value="${v}" aria-label="${esc(label)}">${v}%</meter><span>${v}%</span></div>`; }
function renderInspector(): void {
  if (!world) return;
  if (selected.kind === 'person') {
    const p = person(); if (!p) return; const signature = JSON.stringify(p); if (signature === inspectorSignature) return; inspectorSignature = signature;
    el('inspector-title').textContent = p.name; el('person-controls').hidden = false; el('person-primary').hidden = false; const source = world.memories.find(m => m.text === p.recentMemory)?.source;
    const color = /^#[\da-f]{3,8}$/i.test(p.color) ? p.color : '#a4805b'; const skills = Object.entries(p.skills ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const skillNames: Record<string, string> = { gather: 'Recolección', gathering: 'Recolección', farm: 'Cultivo', farming: 'Cultivo', build: 'Construcción', building: 'Construcción', explore: 'Exploración', exploration: 'Exploración', care: 'Cuidado' };
    const openDetails = new Set([...el('inhabitant-card').querySelectorAll<HTMLDetailsElement>('details[open]')].map(d => d.dataset.detail));
    el('inhabitant-card').innerHTML = `<div class="game-person-heading"><div class="pixel-portrait ${p.role === 'I' ? 'portrait-i' : ''}" style="--person-color:${color}" aria-hidden="true"><span class="pixel-body"></span></div><div><strong>${esc(p.specialty ?? 'Su camino está tomando forma')}</strong><span class="agency-state ${p.controlMode === 'directed' ? 'is-directed' : ''}">${p.controlMode === 'directed' ? 'Siguiendo una orden' : 'Actuando por su cuenta'}</span></div></div><p class="game-current-action">${actions[p.action]} <span>· ${p.x}, ${p.y}</span></p><p class="game-reason">${esc(p.reason)}</p><div class="game-needs"><h3>Ahora necesita ${esc(p.need.toLocaleLowerCase('es'))}</h3>${meter('Energía', p.energy)}${meter('Hambre', p.hunger)}${meter('Cansancio', p.fatigue)}</div><div class="material-pouch"><span>${icon.leaf}<strong>${Math.floor(p.materials?.wood ?? 0)}</strong> madera</span><span>${icon.hammer}<strong>${Math.floor(p.materials?.stone ?? 0)}</strong> piedra</span></div>${skills.length ? `<details class="person-detail" data-detail="skills" ${openDetails.has('skills') ? 'open' : ''}><summary>Habilidades y carácter</summary>${skills.map(([name, value]) => `<div class="skill-row"><span>${esc(skillNames[name] ?? name)}</span><strong>${value.toFixed(1)}</strong></div>`).join('')}${p.traits ? `<p>${Object.entries(p.traits).map(([name, value]) => `${({ curiosity: 'Curiosidad', sociability: 'Sociabilidad', industriousness: 'Constancia', care: 'Cuidado', resilience: 'Resiliencia' } as Record<string, string>)[name] ?? name}: ${Math.round(value * 100)}%`).join(' · ')}</p>` : ''}<p>Las habilidades se forman al practicar; el carácter orienta sus preferencias.</p></details>` : ''}${p.recentMemory ? `<details class="person-detail memory-detail" data-detail="memory" ${openDetails.has('memory') ? 'open' : ''}><summary>Algo que lleva consigo</summary><p>${esc(p.recentMemory)}</p><small>${source === 'sample' ? 'RECUERDO DE PRUEBA · NO ES BIOGRAFÍA' : source === 'approved' ? 'RECUERDO APROBADO' : 'EXPERIENCIA DEL MUNDO SIMULADO'}</small></details>` : ''}`;
  } else {
    const position = selected, tile = world.tiles.find(t => t.x === position.x && t.y === position.y); el('person-controls').hidden = true; el('person-primary').hidden = true;
    if (!tile) { el('inspector-title').textContent = 'Otra región'; el('inhabitant-card').innerHTML = '<p class="drawer-note">Esperando esta parte del paisaje. Recorrer con la cámara no añade hechos a la crónica.</p>'; return; }
    const place = world.places.find(p => Math.hypot(p.x - tile.x, p.y - tile.y) < 1.5); const signature = JSON.stringify([tile, place]); if (signature === inspectorSignature) return; inspectorSignature = signature; el('inspector-title').textContent = place?.name ?? terrains[tile.terrain];
    el('inhabitant-card').innerHTML = `<p class="tile-biome">${esc(biomes[tile.biome ?? ''] ?? terrains[tile.terrain])} <span>· ${tile.x}, ${tile.y}</span></p><p class="game-reason">${esc(place?.description ?? 'El terreno y los recursos abren posibilidades distintas para cada habitante.')}</p><div class="game-needs"><h3>Recursos del lugar</h3>${meter('Humedad', tile.moisture)}${meter('Vegetación', tile.vegetation)}${meter('Alimento', tile.food)}</div><div class="material-pouch"><span>${icon.leaf}<strong>${Math.floor(tile.wood ?? 0)}</strong> madera</span><span>${icon.hammer}<strong>${Math.floor(tile.stone ?? 0)}</strong> piedra</span></div>${place ? `<p class="drawer-note">${place.gatherings} encuentros registrados aquí.</p>` : ''}<p class="drawer-note">Selecciona un habitante para dar una orden; usa las herramientas para intervenir en esta casilla.</p>`;
  }
}
function renderControls(): void {
  if (!document.getElementById('direct-toggle')) return; const blocked = status !== 'live' || !!world?.paused || pending || !world;
  el<HTMLButtonElement>('direct-toggle').disabled = blocked; el('direct-toggle').setAttribute('aria-pressed', String(control === 'direct')); el('follow-toggle').setAttribute('aria-pressed', String(following));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-order]')) button.disabled = blocked;
  el('mode-indicator').hidden = control !== 'direct' && !following; el('mode-indicator').textContent = control === 'direct' ? `Dirigir a ${person()?.name ?? ''}: toca un destino · WASD mueve una casilla · Esc sale` : `Siguiendo a ${person()?.name ?? ''} · arrastra para liberar la cámara`;
  el('control-help').textContent = control === 'direct' ? 'Toca un lugar del mapa. El habitante camina; no se teletransporta.' : 'Las órdenes se confirman en el servidor. Autonomía devuelve las decisiones al habitante.';
  el('game').classList.toggle('direct-mode', control === 'direct'); renderTool();
}
function renderStatus(): void {
  if (!document.getElementById('connection-label')) return; const paused = !!world?.paused; el('connection-label').textContent = paused ? 'En pausa' : status === 'live' ? 'En vivo' : status === 'offline' ? 'Reconectando' : 'Conectando'; el('connection-label').dataset.live = String(status === 'live' && !paused);
  el('connection-notice').hidden = status === 'live' && !paused; el('connection-notice').textContent = paused ? world?.pauseReason ?? 'El mundo está en pausa para proteger lo guardado.' : status === 'offline' ? 'Sin conexión. Ves el último estado recibido; las órdenes esperan hasta reconectar.' : 'Conectando con el mundo…'; renderControls();
}
function renderTool(): void {
  if (!document.getElementById('gesture-title')) return;
  const labels = { plant: ['Sembrar', 'Deja una planta en la casilla elegida. Necesita agua y luz para crecer.', 'Sembrar aquí'], invite: ['Invitar', 'Deja una invitación en el lugar elegido. Cada habitante decide si responder.', 'Invitar aquí'], remember: ['Recordar', 'Un recuerdo ofrece contexto; no impone una reconciliación ni una decisión.', 'Traer este recuerdo'] };
  el('gesture-title').textContent = labels[tool][0]!; el('gesture-description').textContent = labels[tool][1]!; el('memory-choice').hidden = tool !== 'remember'; const memory = world?.memories.find(m => m.id === el<HTMLSelectElement>('memory-select').value);
  el('memory-preview').textContent = memory ? `${memory.source === 'sample' ? 'Recuerdo de prueba, no biográfico' : 'Recuerdo aprobado'}: ${memory.text}` : 'No hay recuerdos disponibles.';
  const position = target(); el('gesture-target').textContent = position ? `casilla ${position.x}, ${position.y}` : 'toca una casilla'; const button = el<HTMLButtonElement>('gesture-send'); button.innerHTML = pending ? 'Esperando confirmación…' : `${labels[tool][2]} ${icon.arrow}`; button.disabled = status !== 'live' || !!world?.paused || pending || !position || (tool === 'remember' && !memory);
}
function renderJournal(): void {
  const names: Record<ChronicleEvent['kind'], string> = { ecology: 'Paisaje', meeting: 'Encuentro', care: 'Cuidado', learning: 'Aprendizaje', memory: 'Memoria', gesture: 'Tu gesto', pause: 'Pausa del servidor', discovery: 'Un descubrimiento', settlement: 'Un nuevo lugar' };
  el('journal-events').innerHTML = world?.events.length ? [...world.events].slice(-32).reverse().map(event => `<article class="chronicle-event"><div class="event-label"><span>${names[event.kind]}</span><span>${event.source === 'sample' ? 'Material de prueba' : event.source === 'approved' ? 'Contenido aprobado' : 'Ficción simulada'}</span></div><p>${esc(event.text)}</p><div class="event-cause"><strong>Qué influyó</strong> ${esc(event.cause)}</div><span class="event-tick">Momento ${event.tick} del mundo</span></article>`).join('') : '<p class="quiet-event">Todavía no hay episodios guardados. El mundo también tiene silencios.</p>';
}
window.addEventListener('pagehide', saveVisit); document.addEventListener('visibilitychange', () => { if (document.hidden) saveVisit(); });
async function boot(): Promise<void> { root.innerHTML = '<main class="boot-screen"><span>✧</span><p>Abriendo la carta…</p></main>'; try { const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) }); const session = await response.json() as { authenticated: boolean }; if (response.ok && session.authenticated) enterWorld(); else loginScreen(); } catch { loginScreen('No hay conexión con el servidor. Puedes volver a intentar.'); } }
void boot();
