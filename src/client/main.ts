import type { ChronicleEvent, GestureKind, PersonView, Tile, WorldView } from '../shared/types.js';
import { Connection, type ConnectionStatus } from './connection.js';
import { Landscape, type Selection } from './landscape.js';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
const escape = (value: string | number): string => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const icons = {
  leaf: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 4C9 2 3 7 5 14c2 7 13 7 14-10Z" stroke="currentColor" stroke-width="1.5"/><path d="m4 21 11-12M8 16l-1-5m4 2 5 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 6C9 4 5 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m11 5-5 4H3v6h3l5 4V5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h15m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  focus: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/></svg>',
};
const actionNames: Record<PersonView['action'], string> = { explore: 'Explorando', eat: 'Buscando alimento', rest: 'Descansando', approach: 'Acercándose', accompany: 'Acompañando', retreat: 'Buscando espacio', share: 'Compartiendo' };
const phaseNames: Record<WorldView['phase'], string> = { dawn: 'Amanece', day: 'Es de día', dusk: 'Cae la tarde', night: 'Es de noche' };
const terrainNames: Record<Tile['terrain'], string> = { water: 'Agua', meadow: 'Pradera', soil: 'Tierra', shelter: 'Refugio' };
let connection: Connection | null = null;
let landscape: Landscape | null = null;
let world: WorldView | null = null;
let selected: Selection = { kind: 'person', id: 'S' };
let status: ConnectionStatus = 'connecting';
let gestureKind: GestureKind = 'plant';
let gesturePending = false;
let opened = false;
let lastVisit: number | null = null;
let returnEvents: ChronicleEvent[] = [];
let audioContext: AudioContext | null = null;
let soundOn = false;
let soundTimer: ReturnType<typeof setTimeout> | undefined;

function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function savedVisit(): number | null {
  try { const raw = localStorage.getItem('carta:last-visit'); return raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null; } catch { return null; }
}
function saveVisit(): void { if (world) { try { localStorage.setItem('carta:last-visit', String(world.tick)); } catch { /* Browsing without storage still works. */ } } }
function stopSound(): void {
  clearTimeout(soundTimer);
  soundOn = false;
  if (audioContext) void audioContext.close();
  audioContext = null;
  const button = document.getElementById('sound-toggle');
  button?.setAttribute('aria-pressed', 'false');
}
function clean(): void {
  saveVisit();
  connection?.stop(); connection = null;
  landscape?.destroy(); landscape = null;
  stopSound();
  world = null; gesturePending = false; opened = false; returnEvents = [];
}

function loginScreen(message = ''): void {
  clean();
  root.innerHTML = `<main class="entry-page">
    <div class="entry-monogram">${icons.leaf}<span>UN PEQUEÑO MUNDO PRIVADO</span></div>
    <section class="entry-card" aria-labelledby="entry-title">
      <div class="letter-stamp" aria-hidden="true">I<span>PARA TI</span></div>
      <p class="eyebrow">HAY LUGARES A LOS QUE SIEMPRE SE PUEDE VOLVER</p>
      <h1 id="entry-title">Una carta<br>para <em>Isa.</em></h1>
      <p class="entry-intro">Un paisaje, algunas vidas<br>y espacio para lo que viene.</p>
      <form id="login-form">
        <label for="password">Contraseña privada</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required placeholder="La llave de este lugar" />
        <button class="button primary entry-submit" type="submit">Entrar a la carta ${icons.arrow}</button>
        <p id="login-error" class="form-message" role="status">${escape(message)}</p>
      </form>
      <div class="entry-footnote">${icons.leaf}<span>Lo pequeño también puede contener un mundo.</span></div>
    </section>
    <p class="entry-footer">UNA CARTA PARA ISA <span>·</span> ACCESO PRIVADO</p>
  </main>`;
  element<HTMLFormElement>('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = element<HTMLButtonElement>('login-form').querySelector<HTMLButtonElement>('button')!;
    submit.disabled = true;
    element('login-error').textContent = 'Abriendo la carta…';
    try {
      const response = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: element<HTMLInputElement>('password').value }),
      });
      element<HTMLInputElement>('password').value = '';
      if (!response.ok) {
        element('login-error').textContent = response.status === 429 ? 'Han sido varios intentos. Espera un momento antes de volver a entrar.' : 'No pudimos abrir la carta con esa contraseña.';
        submit.disabled = false;
        element('password').focus();
        return;
      }
      enterWorld();
    } catch {
      element('login-error').textContent = 'No hay conexión con el servidor. Puedes intentarlo de nuevo.';
      submit.disabled = false;
    }
  });
}

function enterWorld(): void {
  clean();
  lastVisit = savedVisit();
  status = 'connecting';
  root.innerHTML = `<div class="world-shell">
    <a class="skip-link" href="#inhabitant-card">Ir a los habitantes</a>
    <header class="topbar">
      <a class="brand" href="#" aria-label="Una carta para Isa, leer la carta">${icons.leaf}<span>Una carta <i>para Isa</i></span></a>
      <nav aria-label="La carta y el mundo">
        <button id="letter-button" class="text-button" aria-label="La carta">${icons.book}<span>La carta</span></button>
        <button id="chronicle-button" class="text-button" aria-label="Crónica">${icons.star}<span>Crónica</span><span id="chronicle-count" class="small-count">0</span></button>
        <span class="nav-divider" aria-hidden="true"></span>
        <button id="sound-toggle" class="icon-button" aria-label="Sonido opcional" aria-pressed="false" title="Activar sonido suave">${icons.sound}</button>
        <button id="logout-button" class="text-button exit-button">Salir</button>
      </nav>
    </header>
    <main class="world-main">
      <section class="heading-row" aria-labelledby="world-title">
        <div><p class="eyebrow">UN PEQUEÑO ATLAS DE LO QUE IMPORTA</p><h1 id="world-title">Un lugar para <em>volver.</em></h1><p class="world-intro">La vida sigue su curso. Puedes quedarte a mirar.</p></div>
        <div class="world-time"><span class="sun-mark" aria-hidden="true">☼</span><div><span id="world-day">Abriendo el paisaje</span><span id="world-phase">Un momento de calma</span></div></div>
      </section>
      <div id="connection-notice" class="connection-notice" role="status">Conectando con el mundo…</div>
      <section id="return-card" class="return-card" hidden aria-label="Desde tu última visita"></section>
      <div class="world-grid">
        <section class="landscape-section" aria-label="El paisaje y sus lugares">
          <div class="map-topline"><span class="section-label"><span class="living-dot"></span> EL MUNDO, AHORA</span><span id="connection-label">Conectando</span></div>
          <div class="map-frame">
            <canvas id="landscape" tabindex="0" role="img" aria-label="Paisaje vivo. Arrastra para recorrer; usa las flechas para mover la cámara, más y menos para acercar, y los controles bajo el mapa para seleccionar habitantes y lugares." aria-describedby="map-help"></canvas>
            <div id="map-loading" class="map-loading">${icons.leaf}<span>El paisaje está por abrirse…</span></div>
            <div class="map-location"><span class="location-mark" aria-hidden="true">${icons.focus}</span><div><span>UN RINCÓN COMPARTIDO</span><strong id="region-label">La región de la carta</strong></div></div>
            <div class="map-zoom" aria-label="Cámara"><button id="zoom-in" class="icon-button" aria-label="Acercar mapa">+</button><span></span><button id="zoom-out" class="icon-button" aria-label="Alejar mapa">−</button><span></span><button id="map-reset" class="icon-button" aria-label="Ver toda la región">${icons.focus}</button></div>
            <div class="map-bottom"><span id="map-help">Arrastra para recorrer · toca para descubrir</span><span class="compass" aria-hidden="true">N ↑</span></div>
          </div>
          <div class="map-controls"><div class="find-people"><span>Volver a</span><button id="focus-s" class="person-focus"><span class="person-dot person-s">S</span>S</button><button id="focus-i" class="person-focus"><span class="person-dot person-i">I</span>I</button></div><label class="layer-control" for="observation-layer">Observar <select id="observation-layer"><option value="none">El paisaje</option><option value="moisture">La humedad</option><option value="food">El alimento</option></select></label></div>
          <p id="layer-explanation" class="layer-explanation" hidden></p>
          <div class="below-map"><span class="tiny-sprout">${icons.leaf}</span><p>Un encuentro cambia algo.<br><span>También hay espacio para tomar otro camino.</span></p><span class="handwritten">cada vida, a su ritmo</span></div>
          <details class="accessible-explorer"><summary>Explorar sin usar el mapa</summary><div class="explorer-fields"><label for="person-select">Habitante<select id="person-select"><option value="">Elige un habitante</option></select></label><label for="place-select">Lugar<select id="place-select"><option value="">Elige un lugar</option></select></label><form id="tile-form"><fieldset><legend>Elegir una casilla</legend><label for="tile-x">Columna<input id="tile-x" type="number" min="0" value="20" required></label><label for="tile-y">Fila<input id="tile-y" type="number" min="0" value="14" required></label><button class="button secondary" type="submit">Ver casilla</button></fieldset></form></div><p>Con el mapa enfocado: flechas para recorrer, + y − para acercar; Inicio para volver a S e I.</p></details>
        </section>
        <aside class="world-sidebar">
          <section id="inhabitant-card" class="inhabitant-card" aria-label="Lo que ocurre aquí" tabindex="-1"><p class="section-label">UNA VIDA DE CERCA</p><p class="subtle">Esperando al mundo…</p></section>
          <section class="gesture-card" aria-labelledby="gesture-title"><div class="card-heading"><h2 id="gesture-title">Dejar algo pequeño</h2>${icons.leaf}</div><p class="card-intro">Una posibilidad. Cada vida decide qué hacer con ella.</p><div class="gesture-tabs" role="group" aria-label="Elige un gesto"><button data-gesture="plant" aria-pressed="true">${icons.leaf}<span>Sembrar</span></button><button data-gesture="invite" aria-pressed="false">${icons.star}<span>Invitar</span></button><button data-gesture="remember" aria-pressed="false">${icons.book}<span>Recordar</span></button></div><p id="gesture-description" class="gesture-description"></p><div id="memory-choice" hidden><label for="memory-select">Recuerdo disponible</label><select id="memory-select"></select><p id="memory-preview" class="memory-preview"></p></div><p class="target-line">Lugar: <strong id="gesture-target">selecciona en el mapa</strong></p><button id="gesture-send" class="button primary" disabled>Sembrar aquí ${icons.arrow}</button><p id="gesture-result" class="gesture-result" role="status" aria-live="polite"></p></section>
        </aside>
      </div>
      <section class="chronicle-preview" aria-labelledby="chronicle-title"><div class="chronicle-heading"><div><p class="eyebrow">LAS HUELLAS QUE VAN QUEDANDO</p><h2 id="chronicle-title">Mientras la vida sucede</h2></div><button id="all-chronicle" class="text-button" aria-label="Abrir la crónica">Abrir la crónica ${icons.arrow}</button></div><div id="chronicle-cards" class="chronicle-cards"><p class="subtle">Los hechos del mundo aparecerán aquí.</p></div></section>
      <footer class="world-footer"><span>${icons.leaf} HECHO DE TIEMPO, ENCUENTROS Y POSIBILIDAD</span><p>Prototipo privado · S e I son representaciones provisionales · recuerdos de prueba identificados.</p></footer>
    </main>
  </div>
  <dialog id="letter-dialog" class="letter-dialog" aria-labelledby="letter-title"><button class="dialog-close icon-button" aria-label="Cerrar la carta">×</button><span class="letter-index">01 / LA CARTA</span><div class="letter-flower">${icons.leaf}</div><p class="eyebrow">BORRADOR DE APERTURA · PENDIENTE DE STEVEN</p><h2 id="letter-title">Para ti, <em>Isa.</em></h2><blockquote>Te hice un mundo pequeño. Dejé en él algo de nuestra historia y espacio para lo que todavía no sabemos.</blockquote><p class="letter-note">Esta apertura es un borrador editorial. La voz del autor y los recuerdos reales llegarán después de su revisión. Por ahora, este lugar empieza con S, I y recuerdos de prueba.</p><p class="letter-signature">Un lugar donde volver a encontrarnos.</p><button id="enter-landscape" class="button primary">Entrar al mundo ${icons.arrow}</button></dialog>
  <dialog id="chronicle-dialog" class="chronicle-dialog" aria-labelledby="journal-title"><button class="dialog-close icon-button" aria-label="Cerrar crónica">×</button><p class="eyebrow">HECHOS QUE EL MUNDO RECUERDA</p><h2 id="journal-title">Una pequeña <em>crónica.</em></h2><p class="journal-intro">Lo que ocurrió, y qué ayudó a que ocurriera. Los episodios son ficción simulada salvo cuando se indica otro origen.</p><div id="journal-events"></div></dialog>`;
  landscape = new Landscape(element<HTMLCanvasElement>('landscape'), select);
  wireWorld();
  renderGesture();
  connection = new Connection({
    world: receiveWorld,
    status: (next) => { status = next; renderConnection(); },
    result: (result) => {
      gesturePending = false;
      element('gesture-result').textContent = result.message;
      element('gesture-result').dataset.accepted = String(result.accepted);
      renderGesture();
    },
    expired: () => loginScreen('La sesión terminó. Vuelve a entrar para ver la carta.'),
    error: (message) => { if (document.getElementById('gesture-result')) element('gesture-result').textContent = message; },
    pending: (pending) => { gesturePending = pending; renderGesture(); },
  });
  connection.start();
}

function wireWorld(): void {
  const openLetter = (): void => element<HTMLDialogElement>('letter-dialog').showModal();
  element('letter-button').addEventListener('click', openLetter);
  root.querySelector('.brand')!.addEventListener('click', (event) => { event.preventDefault(); openLetter(); });
  element('enter-landscape').addEventListener('click', () => { element<HTMLDialogElement>('letter-dialog').close(); element('landscape').focus(); });
  for (const dialog of root.querySelectorAll<HTMLDialogElement>('dialog')) {
    dialog.querySelector('.dialog-close')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
  }
  for (const id of ['chronicle-button', 'all-chronicle']) element(id).addEventListener('click', () => {
    renderJournal(); element<HTMLDialogElement>('chronicle-dialog').showModal();
  });
  element('logout-button').addEventListener('click', async () => {
    const button = element<HTMLButtonElement>('logout-button'); button.disabled = true;
    try {
      const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('logout');
      loginScreen();
    } catch {
      loginScreen('Ocultamos la carta, pero no pudimos revocar la sesión en el servidor. Vuelve a conectar para cerrar la sesión.');
    }
  });
  element('zoom-in').addEventListener('click', () => landscape?.zoom(1));
  element('zoom-out').addEventListener('click', () => landscape?.zoom(-1));
  element('map-reset').addEventListener('click', () => landscape?.fit());
  for (const role of ['S', 'I'] as const) element(`focus-${role.toLowerCase()}`).addEventListener('click', () => {
    const person = world?.people.find((entry) => entry.role === role);
    if (person) { select({ kind: 'person', id: person.id }); landscape?.focus(person.x, person.y); }
  });
  element<HTMLSelectElement>('observation-layer').addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value as 'none' | 'moisture' | 'food';
    landscape?.setLayer(value);
    element('layer-explanation').hidden = value === 'none';
    element('layer-explanation').textContent = value === 'moisture' ? 'Humedad: las casillas más azules tienen más agua disponible. La ficha muestra el valor del modelo.' : 'Alimento: las casillas más doradas tienen más alimento. La ficha muestra el valor del modelo.';
  });
  element<HTMLSelectElement>('person-select').addEventListener('change', (event) => {
    const person = world?.people.find((entry) => entry.id === (event.target as HTMLSelectElement).value);
    if (person) { select({ kind: 'person', id: person.id }); landscape?.focus(person.x, person.y); }
  });
  element<HTMLSelectElement>('place-select').addEventListener('change', (event) => {
    const place = world?.places.find((entry) => entry.id === (event.target as HTMLSelectElement).value);
    if (place) { select({ kind: 'tile', x: place.x, y: place.y }); landscape?.focus(place.x, place.y); }
  });
  element<HTMLFormElement>('tile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const x = Number(element<HTMLInputElement>('tile-x').value), y = Number(element<HTMLInputElement>('tile-y').value);
    if (world && Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < world.width && y < world.height) { select({ kind: 'tile', x, y }); landscape?.focus(x, y); }
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-gesture]')) button.addEventListener('click', () => {
    gestureKind = button.dataset.gesture as GestureKind; renderGesture();
  });
  element('gesture-send').addEventListener('click', sendGesture);
  element('memory-select').addEventListener('change', renderGesture);
  element('sound-toggle').addEventListener('click', async () => {
    if (soundOn) { stopSound(); return; }
    try {
      audioContext = new AudioContext(); await audioContext.resume(); soundOn = true;
      element('sound-toggle').setAttribute('aria-pressed', 'true');
      playSound();
    } catch { stopSound(); element('gesture-result').textContent = 'No se pudo activar el sonido. Puedes explorar sin él.'; }
  });
}

function playSound(): void {
  if (!audioContext || !soundOn) return;
  if (!document.hidden) {
    const start = audioContext.currentTime;
    for (const [index, frequency] of [261.63, 329.63, 392].entries()) {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.008, start + 1.5 + index * 0.25); gain.gain.exponentialRampToValueAtTime(0.0001, start + 7);
      oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(start + index * 0.15); oscillator.stop(start + 7.2);
    }
  }
  soundTimer = setTimeout(playSound, 12_000);
}

function receiveWorld(next: WorldView): void {
  const first = world === null;
  world = next;
  landscape?.update(next);
  element('map-loading').hidden = true;
  element('world-day').textContent = `Día ${next.day}`;
  element('world-phase').textContent = `${phaseNames[next.phase]}${next.weather === 'rain' ? ' · llueve' : ''}`;
  element('chronicle-count').textContent = String(next.events.length);
  if (first) {
    const person = next.people.find((entry) => entry.role === 'S') ?? next.people[0];
    if (person) selected = { kind: 'person', id: person.id };
    landscape?.select(selected);
    element('person-select').innerHTML = '<option value="">Elige un habitante</option>' + next.people.map((entry) => `<option value="${escape(entry.id)}">${escape(entry.name)}${entry.role === 'neighbor' ? ' · vecino/a' : ` · ${entry.role}`}</option>`).join('');
    element('place-select').innerHTML = '<option value="">Elige un lugar</option>' + next.places.map((place) => `<option value="${escape(place.id)}">${escape(place.name)}</option>`).join('');
    element<HTMLInputElement>('tile-x').max = String(next.width - 1); element<HTMLInputElement>('tile-y').max = String(next.height - 1);
    element('memory-select').innerHTML = next.memories.map((memory) => `<option value="${escape(memory.id)}">${escape(memory.title)}${memory.source === 'sample' ? ' · prueba' : ' · aprobado'}</option>`).join('');
    returnEvents = lastVisit === null ? [] : next.events.filter((event) => event.tick > lastVisit!).slice(-3).reverse();
    renderReturn();
    if (!opened && lastVisit === null) { opened = true; element<HTMLDialogElement>('letter-dialog').showModal(); }
  }
  renderSelection(); renderConnection(); renderChronicle(); renderGesture();
}

function select(selection: Selection): void {
  selected = selection;
  landscape?.select(selection);
  renderSelection(); renderGesture();
}

function target(): { x: number; y: number } | null {
  if (!world) return null;
  if (selected.kind === 'tile') return { x: selected.x, y: selected.y };
  const person = world.people.find((entry) => selected.kind === 'person' && entry.id === selected.id);
  return person ? { x: Math.round(person.x), y: Math.round(person.y) } : null;
}

function meter(label: string, value: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(value * 100)));
  return `<div class="need-row"><span>${label}</span><meter min="0" max="100" value="${clamped}" aria-label="${label}">${clamped}%</meter><span>${clamped < 30 ? 'Baja' : clamped < 65 ? 'Media' : 'Alta'}</span></div>`;
}

function renderSelection(): void {
  if (!world) return;
  const card = element('inhabitant-card');
  if (selected.kind === 'person') {
    const person = world.people.find((entry) => selected.kind === 'person' && entry.id === selected.id);
    if (!person) return;
    const label = person.role === 'neighbor' ? 'UNA VIDA DE LA VECINDAD' : 'UNA VIDA DE CERCA';
    const color = /^#[\da-f]{3,8}$/i.test(person.color) ? person.color : '#a4805b';
    const memorySource = world.memories.find((memory) => memory.text === person.recentMemory)?.source;
    const memoryAttribution = memorySource === 'sample' ? 'RECUERDO DE PRUEBA · NO ES BIOGRAFÍA' : memorySource === 'approved' ? 'RECUERDO APROBADO' : 'EXPERIENCIA DEL MUNDO SIMULADO';
    card.innerHTML = `<p class="section-label">${label}</p><div class="person-heading"><div class="pixel-portrait ${person.role === 'I' ? 'portrait-i' : ''}" style="--person-color:${color}" aria-hidden="true"><span class="pixel-body"></span></div><div><h2>${escape(person.name)}</h2><span class="person-role">${person.role === 'neighbor' ? 'Habitante del mundo' : 'Una representación provisional'}</span></div><span class="person-initial">${escape(person.role === 'neighbor' ? person.name.slice(0, 1) : person.role)}</span></div><div class="current-action"><span class="living-dot"></span>${actionNames[person.action]}</div><p class="person-reason">${escape(person.reason)}</p><div class="need-section"><h3>Lo que necesita ahora</h3><p>${escape(person.need)}</p>${meter('Energía', person.energy)}${meter('Hambre', person.hunger)}${meter('Cansancio', person.fatigue)}</div><div class="recent-memory">${icons.book}<div><h3>Algo que lleva consigo</h3><p>${escape(person.recentMemory ?? 'Todavía no hay una experiencia reciente que contar.')}</p><span>${memoryAttribution}</span></div></div>`;
    element<HTMLSelectElement>('person-select').value = person.id;
  } else {
    const position = selected;
    const tile = world.tiles.find((entry) => entry.x === position.x && entry.y === position.y);
    if (!tile) return;
    const place = world.places.find((entry) => Math.hypot(entry.x - tile.x, entry.y - tile.y) < 1.5);
    const memories = world.memories.filter((memory) => memory.placeId === place?.id);
    card.innerHTML = `<p class="section-label">UN LUGAR DE CERCA</p><div class="place-heading">${icons.leaf}<h2>${escape(place?.name ?? terrainNames[tile.terrain])}</h2></div><p class="person-reason">${escape(place?.description ?? 'El agua, la luz y las visitas transforman este pequeño lugar.')}</p><div class="place-coordinates">${terrainNames[tile.terrain]} · casilla ${tile.x}, ${tile.y}</div><div class="need-section"><h3>Lo que sostiene este lugar</h3>${meter('Humedad', tile.moisture)}${meter('Vegetación', tile.vegetation)}${meter('Alimento', tile.food)}<p class="model-note">Valores del modelo, entre 0 y 1: ${tile.moisture.toFixed(2)} · ${tile.vegetation.toFixed(2)} · ${tile.food.toFixed(2)}.</p></div>${place ? `<p class="place-visits">${place.gatherings} encuentros registrados aquí.</p>` : ''}${memories.map((memory) => `<div class="recent-memory">${icons.book}<div><h3>${escape(memory.title)}</h3><p>${escape(memory.text)}</p><span>${memory.source === 'sample' ? 'RECUERDO DE PRUEBA · NO ES BIOGRAFÍA' : 'RECUERDO APROBADO'}</span></div></div>`).join('')}`;
    element<HTMLInputElement>('tile-x').value = String(tile.x); element<HTMLInputElement>('tile-y').value = String(tile.y);
    if (place) element<HTMLSelectElement>('place-select').value = place.id;
  }
}

function renderConnection(): void {
  const label = document.getElementById('connection-label'); if (!label) return;
  const paused = world?.paused;
  label.textContent = paused ? 'En pausa' : status === 'live' ? 'En vivo' : status === 'offline' ? 'Reconectando' : 'Conectando';
  element('connection-notice').hidden = status === 'live' && !paused;
  element('connection-notice').textContent = paused ? (world?.pauseReason ?? 'El servidor hizo una pausa. Los gestos estarán disponibles cuando vuelva a avanzar.') : status === 'offline' ? 'La conexión se interrumpió. Este es el último estado recibido; los gestos esperan hasta reconectar.' : 'Conectando con el mundo…';
  root.querySelector('.living-dot')?.classList.toggle('is-offline', status !== 'live' || !!paused);
  renderGesture();
}

function renderGesture(): void {
  const button = document.getElementById('gesture-send') as HTMLButtonElement | null; if (!button) return;
  const descriptions: Record<GestureKind, string> = { plant: 'Deja una semilla en la casilla elegida. El agua y la luz decidirán cómo crece.', invite: 'Deja una invitación en este lugar. Quien la perciba puede acercarse o seguir su camino.', remember: 'Acerca un recuerdo a la escena. Su contexto decidirá si cambia una elección.' };
  const labels: Record<GestureKind, string> = { plant: 'Sembrar aquí', invite: 'Invitar a este lugar', remember: 'Traer este recuerdo' };
  element('gesture-description').textContent = descriptions[gestureKind];
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-gesture]')) tab.setAttribute('aria-pressed', String(tab.dataset.gesture === gestureKind));
  element('memory-choice').hidden = gestureKind !== 'remember';
  const memoryId = element<HTMLSelectElement>('memory-select').value;
  const memory = world?.memories.find((entry) => entry.id === memoryId);
  element('memory-preview').textContent = memory ? `${memory.source === 'sample' ? 'Recuerdo de prueba, no biográfico' : 'Recuerdo aprobado'}: ${memory.text}` : 'No hay recuerdos disponibles todavía.';
  const position = target();
  const place = position ? world?.places.find((entry) => Math.hypot(entry.x - position.x, entry.y - position.y) < 1.5) : null;
  element('gesture-target').textContent = position ? `${place?.name ?? 'Casilla'} (${position.x}, ${position.y})` : 'selecciona en el mapa';
  button.innerHTML = gesturePending ? 'Esperando confirmación…' : `${labels[gestureKind]} ${icons.arrow}`;
  button.disabled = !world || status !== 'live' || !!world.paused || !position || gesturePending || (gestureKind === 'remember' && !memory);
}

function sendGesture(): void {
  const position = target(); if (!position || !connection || status !== 'live' || gesturePending) return;
  const id = crypto.randomUUID();
  const gesture = { id, kind: gestureKind, ...position, ...(gestureKind === 'remember' ? { memoryId: element<HTMLSelectElement>('memory-select').value } : {}) };
  if (!connection.send(gesture)) return;
  gesturePending = true;
  element('gesture-result').textContent = 'El gesto viaja al mundo. Aún no está confirmado.';
  delete element('gesture-result').dataset.accepted;
  renderGesture();
}

function eventMarkup(event: ChronicleEvent, compact = false): string {
  const kind: Record<ChronicleEvent['kind'], string> = { ecology: 'El paisaje', meeting: 'Un encuentro', care: 'Un gesto de cuidado', learning: 'Algo aprendido', memory: 'Una huella', gesture: 'Tu gesto', pause: 'Una pausa del servidor' };
  const source = event.source === 'sample' ? 'Material de prueba' : event.source === 'approved' ? 'Contenido aprobado' : 'Ficción simulada';
  return `<article class="chronicle-event${compact ? ' compact-event' : ''}"><div class="event-label"><span>${kind[event.kind]}</span><span>${escape(source)}</span></div><p>${escape(event.text)}</p>${compact ? '' : `<div class="event-cause"><strong>Qué influyó</strong> ${escape(event.cause)}</div>`}<span class="event-tick">Momento ${event.tick} del mundo</span></article>`;
}
function renderChronicle(): void {
  if (!world) return;
  const events = [...world.events].slice(-3).reverse();
  element('chronicle-cards').innerHTML = events.length ? events.map((event) => eventMarkup(event, true)).join('') : '<p class="quiet-event">Aún no hay episodios que contar. El mundo también tiene sus silencios.</p>';
  if (element<HTMLDialogElement>('chronicle-dialog').open) renderJournal();
}
function renderJournal(): void {
  element('journal-events').innerHTML = world?.events.length ? [...world.events].slice(-24).reverse().map((event) => eventMarkup(event)).join('') : '<p class="quiet-event">Aún no hay episodios guardados. No hace falta llenar el silencio.</p>';
}
function renderReturn(): void {
  const card = element('return-card');
  card.hidden = returnEvents.length === 0;
  if (!returnEvents.length) return;
  card.innerHTML = `<div><p class="eyebrow">DESDE TU ÚLTIMA VISITA</p><h2>El mundo siguió su camino.</h2></div><ol>${returnEvents.map((event) => `<li>${escape(event.text)}</li>`).join('')}</ol><button class="icon-button" aria-label="Cerrar resumen de regreso">×</button>`;
  card.querySelector('button')!.addEventListener('click', () => { card.hidden = true; });
}

window.addEventListener('pagehide', saveVisit);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveVisit(); });
async function boot(): Promise<void> {
  root.innerHTML = '<main class="boot-screen"><span class="boot-leaf">✧</span><p>Abriendo la carta…</p></main>';
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    const session = await response.json() as { authenticated: boolean };
    if (response.ok && session.authenticated) enterWorld(); else loginScreen();
  } catch { loginScreen('No hay conexión con el servidor. Puedes intentar entrar cuando vuelva.'); }
}
void boot();
