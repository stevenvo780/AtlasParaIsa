import type { AnimalView, BlueprintView, ChronicleEvent, Gesture, Order, PersonView, StructureView, WorldView } from '../shared/types.js';
import { Connection, type ConnectionStatus } from './connection.js';
import { Landscape, type Selection } from './landscape.js';
import { actions, phases, terrains, biomes, deathCauses, icon, esc, number, percentage } from './ui-catalog.js';
import { meter, animalSilhouette, blueprintCard, personBlueprint, structureCard, inheritedAndLearned } from './inspector-view.js';
import { worldShell } from './world-shell.js';
import { Notebook, wireTabs, type NotebookPage } from './notebook.js';
import { personLink, recentEvidence } from './world-evidence.js';
import { retainViewState } from './view-state.js';
import { animalActions, animalColors, componentNames, speciesNames, speciesPlural } from './life-art.js';
import { technologyPane, recipeCard } from './technology-art.js';
import './style.css';
import './game.css';
import './notebook.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
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
let notebook: Notebook | null = null;
let inspectorTab: 'now' | 'kit' | 'story' = 'now';
let focusedRecipe: string | null = null;
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
  root.innerHTML = worldShell();
  notebook = new Notebook(el('game')); inspectorTab = 'now';
  focusedRecipe = null;
  connection = new Connection({ world: receiveWorld, status: value => { status = value; renderStatus(); }, pending: value => { pending = value; if (!value) landscape?.setPendingTarget(null); renderControls(); }, result: result => message(result.message, result.accepted), error: text => message(text, false), expired: () => loginScreen('La sesión terminó. Vuelve a entrar para ver la carta.') });
  landscape = new Landscape(el<HTMLCanvasElement>('landscape'), pick, viewport => { connection?.setViewport(viewport); el('camera-coordinates').textContent = `${viewport.x + Math.floor(viewport.width / 2)}, ${viewport.y + Math.floor(viewport.height / 2)}`; }, () => { following = false; renderControls(); });
  wire(); renderTool(); connection.start();
}

type Drawer = NotebookPage;
function drawer(name: Drawer, open?: boolean): void {
  const next = notebook?.show(name, open) ?? false;
  syncPickingMode();
  if (name === 'population' && next) el('population-search').focus();
  if (name === 'stats' && next) { renderStats(); el(`stats-tab-${statsTab}`).focus(); }
}
function syncPickingMode(): void { landscape?.setPickMode(control !== 'direct' && el('tool-drawer').hidden ? 'inspect' : 'ground'); }
function choosePerson(id: string, focus = true): void {
  const person = world?.people.find(p => p.id === id); if (!person) return;
  inspectorTab = 'now'; toggleTasks(false); activePersonId = person.id; selected = { kind: 'person', id }; control = 'inspect'; following = false; landscape?.follow(null); landscape?.select(selected);
  if (focus) landscape?.focus(person.x, person.y);
  inspectorSignature = ''; renderInspector(); renderPopulation(); renderControls(); drawer('inspector', true); el('inspector-tab-now').focus({ preventScroll: true }); if (!pending) message('');
}
function chooseAnimal(id: string, focus = true): void {
  const animal = world?.animals?.find(a => a.id === id); if (!animal) return;
  inspectorTab = 'now'; toggleTasks(false); selected = { kind: 'animal', id }; control = 'inspect'; following = false; landscape?.follow(null); landscape?.select(selected);
  if (focus) landscape?.focus(animal.x, animal.y);
  inspectorSignature = ''; renderInspector(); renderPopulation(); renderControls(); renderTool(); drawer('inspector', true); el('inspector-tab-now').focus({ preventScroll: true });
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
  root.removeEventListener('click', navigateEntity);
  root.addEventListener('click', navigateEntity);
  for (const name of ['population', 'inspector', 'layer', 'stats'] as const) el(`${name}-toggle`).addEventListener('click', () => drawer(name));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-close]')) button.addEventListener('click', () => drawer(button.dataset.close as Drawer, false));
  el('intervene-toggle').addEventListener('click', () => { control = 'inspect'; renderTool(); renderControls(); drawer('tool'); });
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
  el('observe-tool').addEventListener('click', () => { control = 'inspect'; notebook?.close(); root.querySelectorAll('[data-gesture]').forEach(b => b.setAttribute('aria-pressed', 'false')); el('observe-tool').setAttribute('aria-pressed', 'true'); renderControls(); });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-gesture]')) button.addEventListener('click', () => { tool = button.dataset.gesture as typeof tool; control = 'inspect'; root.querySelectorAll('[data-gesture]').forEach(item => item.setAttribute('aria-pressed', String((item as HTMLElement).dataset.gesture === tool))); el('observe-tool').setAttribute('aria-pressed', 'false'); renderTool(); renderControls(); drawer('tool', true); });
  el('gesture-send').addEventListener('click', () => { const position = target(); if (position) send({ kind: tool, x: position.x, y: position.y, ...(tool === 'remember' ? { memoryId: el<HTMLSelectElement>('memory-select').value } : {}) }); });
  el('memory-select').addEventListener('change', renderTool);
  el<HTMLSelectElement>('observation-layer').addEventListener('change', event => { const layer = (event.target as HTMLSelectElement).value as 'none' | 'moisture' | 'food'; landscape?.setLayer(layer); el('layer-explanation').textContent = layer === 'none' ? 'Agua, recursos y encuentros cambian las posibilidades.' : layer === 'food' ? 'Más dorado: más alimento. Inspecciona una casilla para ver su valor.' : 'Más azul: más humedad. Inspecciona una casilla para ver su valor.'; });
  el<HTMLSelectElement>('person-select').addEventListener('change', event => choosePerson((event.target as HTMLSelectElement).value));
  el<HTMLSelectElement>('place-select').addEventListener('change', event => { const place = world?.places.find(p => p.id === (event.target as HTMLSelectElement).value); if (place) { selected = { kind: 'tile', x: place.x, y: place.y }; landscape?.focus(place.x, place.y); landscape?.select(selected); inspectorSignature = ''; renderInspector(); drawer('layer', false); drawer('inspector', true); } });
  el<HTMLFormElement>('tile-form').addEventListener('submit', event => { event.preventDefault(); const x = Number(el<HTMLInputElement>('tile-x').value), y = Number(el<HTMLInputElement>('tile-y').value); if (!Number.isInteger(x) || !Number.isInteger(y)) return; selected = { kind: 'tile', x, y }; following = false; landscape?.follow(null); landscape?.focus(x, y); landscape?.select(selected); inspectorSignature = ''; renderInspector(); renderTool(); drawer('inspector', true); });
  el('landscape').addEventListener('keydown', event => { const keyboard = event as KeyboardEvent; if (control !== 'direct' || keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey || keyboard.repeat) return; const key = keyboard.key.toLowerCase(); const offsets: Record<string, [number, number]> = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] }; const offset = offsets[key], p = person(); if (!offset || !p) return; event.preventDefault(); sendCommand('move', { x: p.x + offset[0], y: p.y + offset[1] }); });
  el('game').addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Escape') { if (!el('inspector-drawer').hidden && !el('task-palette').hidden) { toggleTasks(false); el('task-toggle').focus(); return; } if (control === 'direct') { control = 'inspect'; renderControls(); if (!el('inspector-drawer').hidden) el('direct-toggle').focus(); else el('landscape').focus(); return; } notebook?.close(); } });
  el('sound-toggle').addEventListener('click', async () => { if (soundContext) { stopSound(); return; } try { soundContext = new AudioContext(); await soundContext.resume(); el('sound-toggle').setAttribute('aria-pressed', 'true'); sound(); } catch { stopSound(); message('No se pudo activar el sonido. Puedes explorar sin él.', false); } });
}

function navigateEntity(event: MouseEvent): void {
  const link = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-person-link], [data-community], [data-recipe], [data-place-x]');
  if (!link || !world) return;
  // A link changes the camera or notebook selection, never submits a gesture.
  if (link.dataset.personLink) { choosePerson(link.dataset.personLink); el('inhabitant-card').focus({ preventScroll: true }); }
  else if (link.dataset.community) {
    selectStatsTab('communities'); drawer('stats', true);
    const card = [...el('stats-content').querySelectorAll<HTMLElement>('[data-community-card]')].find(card=>card.dataset.communityCard===link.dataset.community);
    card?.scrollIntoView({ block: 'nearest' }); card?.focus({ preventScroll: true });
  } else if (link.dataset.recipe) {
    focusedRecipe = link.dataset.recipe; selectStatsTab('technology'); drawer('stats', true);
    const detail = [...el('stats-content').querySelectorAll<HTMLDetailsElement>('details')].find(detail=>detail.dataset.detail===`recipe-${focusedRecipe}`);
    if (detail) { detail.open = true; detail.scrollIntoView({ block: 'start' }); detail.querySelector('summary')?.focus({ preventScroll: true }); }
  } else if (link.dataset.placeX !== undefined && link.dataset.placeY !== undefined) {
    const x = Number(link.dataset.placeX), y = Number(link.dataset.placeY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    control = 'inspect'; following = false; landscape?.follow(null); landscape?.focus(x,y);
    pick({ kind: 'tile', x, y }); renderControls(); drawer('inspector', true);
  }
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
function replacePersonCard(html: string): void {
  const card = el('inhabitant-card');
  const restore = retainViewState(card);
  card.innerHTML = html;
  selectInspectorTab(inspectorTab, false);
  el('selection-label').textContent = el('inspector-title').textContent;
  el('inspector-toggle').setAttribute('aria-label', `Ficha de ${el('inspector-title').textContent}`);
  restore();
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
    replacePersonCard(`<section id="inspector-section-now" role="tabpanel" aria-labelledby="inspector-tab-now"><div class="game-person-heading"><div class="animal-avatar animal-portrait" style="--animal-color:${animalColors[animal.species]}" aria-hidden="true">${animalSilhouette(animal.species)}</div><div><strong>Una vida del paisaje</strong><span class="agency-state">${esc(animal.id)} · generación ${esc(animal.generation)}</span></div></div><p class="game-current-action">${animalActions[animal.action]} <span>· ${number(animal.x, 1)}, ${number(animal.y, 1)}</span></p><p class="game-reason">${esc(animal.reason)}</p><div class="game-needs"><h3>Necesidades de este individuo</h3>${meter('Energía', animal.energy)}${meter('Hambre', animal.hunger)}${meter('Sed', animal.thirst)}${meter('Cansancio', animal.fatigue)}${meter('Salud', animal.health)}</div><p class="drawer-note">Observas un animal autónomo. Su actividad y sus desplazamientos llegan del mundo.</p></section><section id="inspector-section-story" role="tabpanel" aria-labelledby="inspector-tab-story"><details class="person-detail" data-detail="animal-genes"><summary>Rasgos y ascendencia</summary><p>Edad: ${esc(animal.age)} pasos. Sus rasgos orientan cómo busca alimento, detecta peligro y conserva energía.</p>${Object.entries(animal.genes).map(([key, value]) => `<div class="skill-row"><span>${({ speed: 'Velocidad', perception: 'Percepción', metabolism: 'Metabolismo', carnivory: 'Carnivoría', waterEfficiency: 'Eficiencia de agua', camouflage: 'Camuflaje' } as Record<string, string>)[key] ?? esc(key)}</span><strong>${number(value, 2)}</strong></div>`).join('')}<p>Progenitores: ${animal.parents.length ? animal.parents.map(esc).join(' · ') : 'Primera generación registrada'}.</p></details></section>`);
    return;
  }
  el('person-primary').classList.toggle('animal-primary', false);
  if (selected.kind === 'person') {
    const p = person();
    if (!p) {
      const id = selected.id, legacy = world.demography?.recent.find(entry=>entry.id===id);
      el('person-controls').hidden = true; el('person-primary').hidden = true; el('direct-toggle').hidden = true;
      el('inspector-tabs').hidden = true;
      el('inspector-title').textContent = legacy?.name ?? 'Fuera de esta vista';
      replacePersonCard(legacy ? `<p class="game-reason">Esta vida terminó en el paso ${esc(legacy.diedAt)}.</p><p class="drawer-note">${esc(deathCauses[legacy.cause] ?? legacy.cause)}</p><p class="drawer-note">Generación ${esc(legacy.generation)}. Su historia permanece en la crónica del mundo.</p>` : '<p class="drawer-note">Este habitante ya no aparece en el estado recibido.</p>');
      if (following) { following=false; landscape?.follow(null); } control='inspect'; inspectorSignature='';return;
    }
    const signature = JSON.stringify([p, world.events.map(event => event.id), world.communities, world.blueprints, world.technology?.items.filter(item=>item.ownerId===p.id)]); if (signature === inspectorSignature) return; inspectorSignature = signature;
    el('inspector-title').textContent = p.name; el('person-controls').hidden = false; el('person-primary').hidden = false; const source = world.memories.find(m => m.text === p.recentMemory)?.source;
    const sections = inheritedAndLearned(p, world);
    const color = /^#[\da-f]{3,8}$/i.test(p.color) ? p.color : '#a4805b';
    replacePersonCard(`<section id="inspector-section-now" role="tabpanel" aria-labelledby="inspector-tab-now"><div class="game-person-heading"><div class="pixel-portrait ${p.role === 'I' ? 'portrait-i' : ''}" style="--person-color:${color}" aria-hidden="true"><span class="pixel-body"></span></div><div><strong>${esc(p.specialty ?? 'Su camino está tomando forma')}</strong><span class="agency-state ${p.controlMode === 'directed' ? 'is-directed' : ''}">${p.controlMode === 'directed' ? 'Siguiendo una orden' : 'Actuando por su cuenta'}</span></div></div><p class="game-current-action">${actions[p.action]} <span>· ${esc(p.x)}, ${esc(p.y)}</span></p><p class="game-reason">${esc(p.reason)}</p><div class="game-needs"><h3>Ahora necesita ${esc(p.need.toLocaleLowerCase('es'))}</h3>${meter('Energía', p.energy)}${meter('Hambre', p.hunger)}${p.thirst === undefined ? '' : meter('Sed', p.thirst)}${meter('Cansancio', p.fatigue)}</div>${p.target ? `<button class="entity-link" data-place-x="${esc(p.target.x)}" data-place-y="${esc(p.target.y)}">Destino recibido: ${number(p.target.x,1)}, ${number(p.target.y,1)} ${icon.arrow}</button>` : ''}${sections.now}</section><section id="inspector-section-kit" role="tabpanel" aria-labelledby="inspector-tab-kit"><h3 class="section-title">Lo que lleva y sabe hacer</h3><div class="material-pouch"><span>${icon.leaf}<strong>${number(p.materials?.wood)}</strong> madera</span><span>${icon.hammer}<strong>${number(p.materials?.stone)}</strong> piedra</span></div>${personBlueprint(p, world) ? `<details class="person-detail" data-detail="blueprint"><summary>Proyecto que sabe construir</summary>${blueprintCard(personBlueprint(p, world)!, world)}</details>` : ''}${sections.kit}</section><section id="inspector-section-story" role="tabpanel" aria-labelledby="inspector-tab-story"><h3 class="section-title">Una vida entre otras</h3>${sections.story}${recentEvidence(world, p.id)}${p.recentMemory ? `<details class="person-detail memory-detail" data-detail="memory"><summary>Algo que lleva consigo</summary><p>${esc(p.recentMemory)}</p><small>${source === 'sample' ? 'RECUERDO DE PRUEBA · NO ES BIOGRAFÍA' : source === 'approved' ? 'RECUERDO APROBADO' : 'EXPERIENCIA DEL MUNDO SIMULADO'}</small></details>` : ''}</section>`);
  } else {
    const position = selected, tile = world.tiles.find(t => t.x === position.x && t.y === position.y); el('person-controls').hidden = true; el('person-primary').hidden = true;
    if (!tile) { el('inspector-title').textContent = 'Otra región'; replacePersonCard('<p class="drawer-note">Esperando esta parte del paisaje. Recorrer con la cámara no añade hechos a la crónica.</p>'); return; }
    const place = world.places.find(p => Math.hypot(p.x - tile.x, p.y - tile.y) < 1.5); const structures = world.structures?.filter(s => s.x === tile.x && s.y === tile.y) ?? []; const signature = JSON.stringify([tile, place, structures, world.blueprints, world.animals?.filter(a => a.x === tile.x && a.y === tile.y)]); if (signature === inspectorSignature) return; inspectorSignature = signature; el('inspector-title').textContent = place?.name ?? terrains[tile.terrain];
    replacePersonCard(`<p class="tile-biome">${esc(biomes[tile.biome ?? ''] ?? terrains[tile.terrain])} <span>· ${esc(tile.x)}, ${esc(tile.y)}</span></p><p class="game-reason">${esc(place?.description ?? 'El terreno y los recursos abren posibilidades distintas para cada habitante.')}</p><div class="game-needs"><h3>Recursos del lugar</h3>${meter('Humedad', tile.moisture)}${meter('Vegetación', tile.vegetation)}${meter('Alimento', tile.food)}</div><div class="material-pouch"><span>${icon.leaf}<strong>${Math.floor(tile.wood ?? 0)}</strong> madera</span><span>${icon.hammer}<strong>${Math.floor(tile.stone ?? 0)}</strong> piedra</span></div><div class="tile-facts">${tile.drinkingWater !== undefined ? `<span>Agua dulce<strong>${number(tile.drinkingWater, 1)} u.</strong></span>` : ''}${world.animals === undefined && tile.species && tile.fauna !== undefined ? `<span>${esc(({ hare: 'Liebres', deer: 'Venados', boar: 'Jabalíes', fish: 'Peces' } as Record<string, string>)[tile.species] ?? tile.species)}<strong>${number(tile.fauna)} animales</strong></span>` : ''}${tile.cultivation !== undefined ? `<span>Cultivo<strong>${percentage(tile.cultivation)}</strong></span>` : ''}${tile.fertility !== undefined ? `<span>Fertilidad<strong>${percentage(tile.fertility)}</strong></span>` : ''}${tile.traffic !== undefined ? `<span>Huellas de paso<strong>${number(tile.traffic, 1)}</strong></span>` : ''}</div>${structures.map(structure=>structureCard(structure, world)).join('')}${world.animals ? `<p class="drawer-note">${world.animals.filter(a => a.x === tile.x && a.y === tile.y).length} animales individuales en esta casilla.</p>` : ''}${place ? `<p class="drawer-note">${place.gatherings} encuentros registrados aquí.</p>` : ''}<p class="drawer-note">Selecciona un habitante para dar una orden; usa las herramientas para intervenir en esta casilla.</p>`);
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
  if (tab !== statsTab) el('stats-content').scrollTop = 0;
  statsTab = tab;
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-stats]')) { const active = button.dataset.stats === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
  el('stats-content').setAttribute('aria-labelledby', `stats-tab-${tab}`); renderStats();
}

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
  return `<section class="stats-section"><div class="stats-section-heading"><h3>Proyectos y construcciones</h3><span>Aprendidos en el mundo</span></div><div class="stats-grid">${statCard('Planos conocidos', number(stats.blueprints), 'Familias y variantes registradas')}${statCard('Investigaciones', number(dynamics?.attempts), 'Intentos acumulados')}${statCard('Variantes aceptadas', number(dynamics?.accepted), 'Proyectos viables')}${statCard('Reparaciones', number(dynamics?.repairs), 'Acciones con material y trabajo')}${statCard('Lluvia recogida', number(dynamics?.waterCollected, 2), 'Agua en cisternas')}${statCard('Alimento retirado', number(dynamics?.foodTaken, 2), 'Consumido desde graneros')}</div>${distribution(stats.structures, componentNames, 'componentes')}<p class="stats-note">Las estructuras combinan funciones. Se desgastan, conservan existencias reales y pueden repararse.</p>${world?.blueprints?.length ? `<details class="person-detail" data-detail="blueprints"><summary>Cuaderno de proyectos (${world.blueprints.length})</summary>${world.blueprints.slice(-24).map(blueprint=>blueprintCard(blueprint, world)).join('')}${world.blueprints.length > 24 ? '<p>Se muestran los 24 proyectos más recientes.</p>' : ''}</details>` : ''}</section>`;
}
function renderStats(): void {
  const panel = document.getElementById('stats-content'); if (!panel) return;
  const restore = retainViewState(panel);
  renderStatsContent();
  restore();
}
function renderStatsContent(): void {
  const panel = document.getElementById('stats-content'); if (!panel || !world) return;
  const stats = world.stats, runtime = world.performance;
  const stamp = `<div class="stats-scope"><span class="scope-dot"></span><span>${status === 'live' && !world.paused ? 'Estado recibido del servidor' : 'Último estado recibido'} · paso ${world.tick}</span></div>`;
  if (statsTab === 'technology') {
    const targeted = world.technology?.recipes.find(recipe=>recipe.id===focusedRecipe);
    panel.innerHTML = stamp + (targeted && !world.technology?.recipes.slice(-20).includes(targeted) ? recipeCard(targeted) : '') + technologyPane(world.technology,world.organization);
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
      const members = community.members.map(id => personLink(world!,id));
      return `<article class="community-card" data-community-card="${esc(community.id)}" tabindex="-1"><header><span class="community-swatch" style="background:${color}" aria-hidden="true"></span><div><h3>${esc(community.name)}</h3><p>${community.members.length} habitantes · desde el paso ${community.formedAt}</p></div></header><p class="community-members">${members.join(' ')}</p><div class="community-counts"><span><strong>${number(community.cooperation)}</strong> cooperaciones</span><span><strong>${number(community.disputes)}</strong> desacuerdos</span></div>${meter('Compartir', community.culture.sharing)}${meter('Cuidar el entorno', community.culture.stewardship)}${meter('Apertura', community.culture.openness)}</article>`;
    }).join('') : '<div class="stats-empty illustrated-empty">Todavía no se ha formado una comunidad. Los encuentros y las acciones locales pueden dejar costumbres compartidas.</div>'}`;
    return;
  }
  if (!stats) { panel.innerHTML = `${stamp}<p class="stats-empty">El servidor todavía no envió estas estadísticas.</p>`; return; }
  const scope = '<p class="stats-note stats-scope-note">Paisaje y recursos: regiones activas del servidor, no todo el territorio posible ni solo la cámara. Los acumulados se identifican aparte.</p>';
  if (statsTab === 'land') {
    const featureNames: Record<string, string> = { tree: 'Árboles', pine: 'Pinos', palm: 'Palmeras', cactus: 'Cactus', reeds: 'Juncos', berries: 'Bayas', flowers: 'Flores', rock: 'Rocas', clay: 'Arcilla', stump: 'Tocones', spring: 'Manantiales', none: 'Sin elemento destacado' };
    const species = speciesPlural;
    panel.innerHTML = `${stamp}${scope}<div class="stats-grid">${statCard('Regiones activas', number(world.activeChunks), 'Cerca de los habitantes')}${statCard('Casillas activas', number(runtime?.activeTiles), 'Terreno en actividad')}${statCard('Agua dulce', number(stats.freshWater, 1), 'Unidades del modelo')}${statCard('Cultivos', number(stats.cultivatedTiles), 'Casillas cultivadas')}${statCard('Senderos', number(stats.trailTiles), 'Casillas con huellas')}${statCard('Madera y piedra', `${number(stats.materials.wood)} / ${number(stats.materials.stone)}`, 'Inventarios de habitantes')}</div><div class="stats-two-columns"><section class="stats-section"><div class="stats-section-heading"><h3>Biomas activos</h3><span>Casillas</span></div>${distribution(stats.biomes, biomes, '')}</section><section class="stats-section"><div class="stats-section-heading"><h3>Vida animal</h3><span>Individuos en regiones activas</span></div>${distribution(stats.wildlife, species, '')}<p class="stats-note">El censo cuenta cuerpos individuales. La caza, la depredación, el agua y las plantas influyen en su supervivencia.</p></section></div><section class="stats-section"><div class="stats-section-heading"><h3>Elementos del paisaje</h3><span>Casillas activas</span></div>${distribution(stats.features, featureNames, '')}</section>${lifeDynamics()}${inventionStats()}${world.structures?.length ? `<section class="stats-section"><h3 class="section-title">Construcciones en esta vista</h3>${world.structures.slice(0,24).map(structure=>`<button class="structure-link entity-link" data-place-x="${esc(structure.x)}" data-place-y="${esc(structure.y)}"><span>${esc(structure.name)}<small>${esc(structure.x)}, ${esc(structure.y)} · estado ${percentage(structure.condition)}</small></span>${icon.arrow}</button>`).join('')}</section>` : ''}`;
    return;
  }
  const history = stats.history ?? [];
  const actionLabels = Object.fromEntries(Object.entries(actions).map(([key, text]) => [key, text]));
  const accumulated = `<section class="stats-section"><div class="stats-section-heading"><h3>Lo que han hecho juntos</h3><span>Acumulado del mundo</span></div><div class="stats-facts">${([['teaching', 'Aprendizajes compartidos'], ['trade', 'Intercambios'], ['constructionHelp', 'Ayudas en tareas'], ['conflicts', 'Desacuerdos'], ['hunts', 'Animales cazados'], ['cultivations', 'Acciones de cultivo']] as const).map(([key, label]) => `<span>${label}<strong>${number(stats.totals[key])}</strong></span>`).join('')}</div></section>`;
  panel.innerHTML = `${stamp}<div class="stats-grid">${statCard('Habitantes', number(stats.population), 'Población de la simulación')}${statCard('Energía media', percentage(stats.meanEnergy), 'Estado corporal, no afecto')}${statCard('Hambre media', percentage(stats.meanHunger), 'Necesidad de alimento')}${statCard('Sed media', percentage(stats.meanThirst), 'Necesidad de agua')}${statCard('Cooperaciones', number(stats.totals.cooperation), 'Acciones acumuladas')}${statCard('Nuevas vidas', number(stats.totals.births), 'Nacimientos simulados acumulados')}</div>${recentEvidence(world)}<div class="stats-chart-grid">${sparkline(history.map(p => ({ tick: p.tick, value: p.population })), 'Población en el tiempo', 'habitantes')}${sparkline(history.map(p => ({ tick: p.tick, value: p.energy * 100 })), 'Energía media', '% media', [0, 100])}</div><section class="stats-section"><div class="stats-section-heading"><h3>Qué están haciendo</h3><span>Habitantes ahora</span></div>${distribution(stats.actions, actionLabels, '')}</section><div class="stats-two-columns"><section class="stats-section"><div class="stats-section-heading"><h3>Generaciones</h3><span>Habitantes</span></div>${distribution(stats.generations, Object.fromEntries(Object.keys(stats.generations).map(key => [key, `Generación ${key}`])), '')}</section><section class="stats-section"><div class="stats-section-heading"><h3>Historia que se acumula</h3></div><div class="stats-facts"><span>Regiones descubiertas<strong>${number(world.discoveredChunks)}</strong></span><span>Asentamientos construidos<strong>${number(world.settlementCount)}</strong></span><span>Cansancio medio<strong>${percentage(stats.meanFatigue)}</strong></span></div></section></div>${accumulated}${scope}`;
}
window.addEventListener('pagehide', saveVisit); document.addEventListener('visibilitychange', () => { if (document.hidden) saveVisit(); });
async function boot(): Promise<void> { root.innerHTML = '<main class="boot-screen"><span>✧</span><p>Abriendo la carta…</p></main>'; try { const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) }); const session = await response.json() as { authenticated: boolean }; if (response.ok && session.authenticated) enterWorld(); else loginScreen(); } catch { loginScreen('No hay conexión con el servidor. Puedes volver a intentar.'); } }
void boot();
