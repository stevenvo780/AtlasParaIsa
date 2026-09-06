// Full-screen browser gates live here; all fixtures are synthetic and isolated per test.
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { assertWorld } from '../src/world/index.js';
import type { Gesture, WorldView } from '../src/shared/types.js';
import { materializeAnimals, syncFauna } from '../src/world/animals.js';
import { researchTechnology, technologyWorkCost } from '../src/world/technology.js';
import type { TechnologyProgram } from '../src/shared/technology.js';

const password = 'synthetic-browser-test-only';
let app: ReturnType<typeof createApp>, store: Store, dir: string, origin: string;

test('V6 visit provenance follows one execution across restart and recognizes a fresh world at the same origin', async ({ page }) => {
  const observed = observeMessages(page);
  await enter(page);
  const firstView = await page.evaluate(async () => (await fetch('/api/world')).json()) as WorldView & { instanceId: string };
  expect(firstView.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  for (let i = 0; i < 5; i++) app.stepOnce();
  await expect.poll(() => observed.views.at(-1)?.tick).toBe(5);
  await page.reload();
  await expect(page.locator('#connection-label')).toHaveText('En vivo');
  await expect(page.locator('#letter-dialog')).toBeHidden();
  const bookmark = await page.evaluate(() => JSON.parse(localStorage.getItem('carta:last-visit-v2')!));
  expect(bookmark).toEqual({ version: 1, instanceId: firstView.instanceId, tick: 5 });

  await app.close(); store.close();
  store = new Store(join(dir, 'world.sqlite'));
  app = createApp({ store, password, origin, manual: true });
  app.server.listen(Number(new URL(origin).port), '127.0.0.1'); await once(app.server, 'listening');
  await page.reload();
  await expect(page.locator('#connection-label')).toHaveText('En vivo');
  await expect(page.locator('#letter-dialog')).toBeHidden();
  expect(await page.evaluate(async () => (await (await fetch('/api/world')).json()).instanceId)).toBe(firstView.instanceId);

  await app.close(); store.close();
  store = new Store(join(dir, 'fresh.sqlite'));
  app = createApp({ store, password, origin, manual: true, seed: 51926 });
  expect(app.world.tick).toBe(0);
  // New publication may already have advanced when its owner first visits.
  // A clock comparison alone cannot identify which execution was observed.
  for (let i = 0; i < 10; i++) app.stepOnce();
  app.server.listen(Number(new URL(origin).port), '127.0.0.1'); await once(app.server, 'listening');
  await page.reload();
  await expect(page.getByLabel('Contraseña privada')).toBeVisible();
  await page.getByLabel('Contraseña privada').fill(password);
  await page.getByRole('button', { name: 'Entrar a la carta' }).click();
  await expect(page.locator('#letter-dialog')).toBeVisible();
  const freshView = await page.evaluate(async () => (await fetch('/api/world')).json()) as WorldView & { instanceId: string };
  expect(freshView.instanceId).not.toBe(firstView.instanceId);
  expect(freshView.tick).toBe(10);
  expect(observed.gestures).toHaveLength(0); expect(observed.errors).toEqual([]);
});
test.beforeEach(async ({}, testInfo) => {
  dir = mkdtempSync(join(tmpdir(), 'carta-browser-')); store = new Store(join(dir, 'world.sqlite'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve())); origin = `http://127.0.0.1:${port}`;
  app = createApp({ store, password, origin, seed: 51926, ...(/^V[456] /.test(testInfo.title) ? { manual: true } : {}), ...(process.env.E2E_STATIC_DIR ? { staticDir: process.env.E2E_STATIC_DIR } : {}) });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening'); mkdirSync('artifacts', { recursive: true });
});
test.afterEach(async () => { await app?.close(); store?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function enter(page: Page): Promise<void> {
  await page.goto(origin); await page.getByLabel('Contraseña privada').fill(password); await page.getByRole('button', { name: 'Entrar a la carta' }).click();
  await expect(page.getByRole('dialog', { name: 'Para ti, Isa.' })).toBeVisible();
  await expect(page.locator('#letter-dialog')).toContainText('BORRADOR');
  await page.getByRole('button', { name: 'Entrar al mundo' }).click();
  await expect(page.locator('#connection-label')).toHaveText('En vivo'); await expect(page.locator('#map-loading')).toBeHidden();
}
async function fullscreen(page: Page, width: number, height: number): Promise<void> {
  const bounds = await page.locator('#landscape').boundingBox(); expect(bounds).toEqual({ x: 0, y: 0, width, height });
  expect(await page.evaluate(() => ({ x: document.documentElement.scrollWidth > innerWidth, y: document.documentElement.scrollHeight > innerHeight }))).toEqual({ x: false, y: false });
}
async function chooseGesture(page: Page, kind: 'plant' | 'invite' | 'remember'): Promise<void> {
  if (await page.locator('#tool-drawer').isHidden()) await page.locator('#intervene-toggle').click();
  await page.locator(`[data-gesture="${kind}"]`).click();
}
async function showTask(page: Page, order: string): Promise<void> {
  if (order === 'auto') return;
  if (await page.locator('#task-palette').isHidden()) await page.locator('#task-toggle').click();
  const group = await page.locator(`[data-order="${order}"]`).getAttribute('data-order-group');
  await page.locator(`[data-task-group="${group}"]`).click();
}
async function issueTask(page: Page, order: string): Promise<void> {
  await showTask(page, order); await page.locator(`[data-order="${order}"]`).click();
}
function setFixtureTick(tick: number): void {
  app.world.tick=tick;
  // Clock fixtures preserve the V5 identity-age invariant before any real step is run.
  for (const person of app.world.people) person.demography.age=tick-person.bornAt;
}
function observeMessages(page: Page) {
  const gestures: Gesture[] = [], views: WorldView[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    socket.on('framesent', event => { try { const message = JSON.parse(String(event.payload)); if (message.type === 'gesture') gestures.push(message.gesture as Gesture); } catch { /* Non-JSON frames are not our protocol. */ } });
    socket.on('framereceived', event => { try { const message = JSON.parse(String(event.payload)); if (message.type === 'state') views.push(message.world as WorldView); } catch { /* Transport control frame. */ } });
  });
  return { gestures, views, errors };
}

test('desktop full-screen HUD, keyboard population selection and physical neighbor control', async ({ page }) => {
  const observed = observeMessages(page); await page.setViewportSize({ width: 1440, height: 900 }); await enter(page); await fullscreen(page, 1440, 900);
  const neighbor = app.world.people.find(p => p.role === 'neighbor')!;
  await page.locator('#population-toggle').focus(); await page.keyboard.press('Enter');
  await page.getByLabel('Buscar habitante').fill(neighbor.name); const row = page.locator(`[data-person="${neighbor.id}"]`); await expect(row).toBeVisible();
  await row.focus(); await page.keyboard.press('Enter'); await expect(page.locator('#inspector-title')).toHaveText(neighbor.name);
  await page.locator('#direct-toggle').click(); await expect(page.locator('#mode-indicator')).toContainText('Dirigir');
  const current = app.world.people.find(p => p.id === neighbor.id)!;
  const offsets = [{ key: 'd', x: 1, y: 0 }, { key: 'a', x: -1, y: 0 }, { key: 'w', x: 0, y: -1 }, { key: 's', x: 0, y: 1 }];
  const direction = offsets.find(offset => app.world.tiles.some(tile => tile.x === current.x + offset.x && tile.y === current.y + offset.y && tile.terrain !== 'water'))!;
  const before = { x: current.x, y: current.y }; await page.locator('#landscape').focus(); await page.keyboard.press(direction.key);
  await expect.poll(() => observed.gestures.some(g => g.kind === 'command' && g.agentId === neighbor.id && g.order === 'move')).toBe(true);
  await expect(page.locator('#gesture-result')).toContainText('Tarea recibida');
  await expect.poll(() => { const p = app.world.people.find(p => p.id === neighbor.id)!; return Math.abs(p.x - before.x) + Math.abs(p.y - before.y); }).toBeGreaterThan(0);
  const movement = observed.gestures.find(g => g.agentId === neighbor.id && g.order === 'move')!;
  expect(Math.abs(movement.x - before.x) + Math.abs(movement.y - before.y)).toBeLessThanOrEqual(2);
  await page.locator('[data-order="auto"]').click(); await expect(page.locator('#gesture-result')).toContainText('Retoma');
  await expect.poll(() => app.world.people.find(p => p.id === neighbor.id)!.controlMode).toBe('auto');
  await page.locator('#follow-toggle').click(); await expect(page.locator('#follow-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#direct-toggle').click();
  const countBeforeClick = observed.gestures.length;
  await page.mouse.click(816, 450);
  await expect.poll(() => observed.gestures.length).toBeGreaterThan(countBeforeClick);
  expect(observed.gestures.at(-1)).toMatchObject({ kind: 'command', agentId: neighbor.id, order: 'move' });
  await expect(page.locator('#gesture-result')).toContainText('Tarea recibida');
  await page.locator('[data-order="auto"]').click(); await expect(page.locator('#gesture-result')).toContainText('Retoma');
  await page.locator('#landscape').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('#follow-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#population-drawer')).toBeHidden(); await page.locator('#focus-s').click(); await expect(page.locator('#inspector-title')).toBeInViewport();
  await page.screenshot({ path: 'artifacts/desktop-fullscreen-v5.png' }); expect(observed.errors).toEqual([]);
});

test('free camera requests signed distant terrain and layers without a finite map edge', async ({ page }) => {
  const observed = observeMessages(page); await page.setViewportSize({ width: 1440, height: 900 }); await enter(page);
  await page.locator('#layer-toggle').click(); await page.locator('#observation-layer').selectOption('moisture'); await expect(page.locator('#layer-explanation')).toContainText('humedad');
  await page.locator('#observation-layer').selectOption('none'); await page.locator('#tile-x').fill('-384'); await page.locator('#tile-y').fill('240'); await page.locator('#tile-form button').click();
  await expect(page.locator('#camera-coordinates')).toHaveText('-384, 240');
  await expect.poll(() => observed.views.some(v => (v.originX ?? 0) < -350 && (v.originY ?? 0) > 200 && v.tiles.some(t => t.x < 0))).toBe(true);
  const last = observed.views.at(-1)!; expect(last.infinite).toBe(true); expect(last.width).toBeLessThanOrEqual(96); expect(last.height).toBeLessThanOrEqual(64);
  await page.locator('#landscape').focus(); await page.keyboard.press('ArrowLeft'); await expect(page.locator('#camera-coordinates')).not.toHaveText('-384, 240');
  await page.locator('[data-close="inspector"]').click(); await page.screenshot({ path: 'artifacts/distant-terrain-v5.png' }); expect(observed.errors).toEqual([]);
});

test('mobile touch: full-screen canvas, one drawer, three gestures, synthetic memories and readable letter', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' }); const page = await context.newPage(); const observed = observeMessages(page);
  try {
    await enter(page); await fullscreen(page, 390, 844); await expect(page.locator('#inspector-drawer')).toBeHidden();
    await page.locator('#focus-i').tap(); await expect(page.locator('#inspector-drawer')).toBeVisible(); await expect(page.locator('#direct-toggle')).toBeInViewport();
    await page.locator('#population-toggle').tap(); await expect(page.locator('#population-drawer')).toBeVisible(); await expect(page.locator('#inspector-drawer')).toBeHidden();
    await page.locator('#focus-s').tap(); await expect(page.locator('#population-drawer')).toBeHidden();
    await chooseGesture(page, 'plant'); await expect(page.locator('#tool-drawer')).toBeVisible(); await expect(page.locator('#inspector-drawer')).toBeHidden();
    await page.locator('#gesture-send').tap(); await expect(page.locator('#gesture-result')).toContainText('planta nueva');
    await expect.poll(() => app.world.tick - app.world.lastGestureTick).toBeGreaterThanOrEqual(30);
    await chooseGesture(page, 'invite'); await page.locator('#gesture-send').tap(); await expect(page.locator('#gesture-result')).toContainText('invitación');
    await page.locator('#layer-toggle').tap(); await page.locator('#place-select').selectOption('claro');
    await chooseGesture(page, 'remember'); await expect(page.locator('#memory-preview')).toContainText('no biográfico');
    await expect.poll(() => app.world.tick - app.world.lastGestureTick).toBeGreaterThanOrEqual(30);
    await page.locator('#gesture-send').tap(); await expect(page.locator('#gesture-result')).toContainText('contexto');
    await page.locator('[data-close="tool"]').tap(); await page.screenshot({ path: 'artifacts/mobile-fullscreen-v5.png' });
    await page.locator('#focus-s').tap(); await page.screenshot({ path: 'artifacts/mobile-inspector-v5.png' });
    await page.locator('#stats-toggle').tap(); await expect(page.locator('#stats-drawer')).toBeVisible(); await expect(page.locator('#inspector-drawer')).toBeHidden();
    await expect(page.locator('#stats-content')).toContainText('Sed media'); await fullscreen(page, 390, 844);
    const tabSizes = await page.locator('[data-stats]').evaluateAll(buttons => buttons.map(button => { const r = button.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
    expect(tabSizes.every(r => r.width >= 44 && r.height >= 44)).toBe(true);
    await page.screenshot({ path: 'artifacts/mobile-stats-v5.png' });
    await page.locator('#stats-tab-land').tap(); await expect(page.locator('#stats-content')).toContainText('regiones activas del servidor');
    await page.locator('#stats-content').evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
    await expect(page.locator('#stats-tab-performance')).toBeInViewport();
    await page.locator('#stats-tab-performance').tap(); await expect(page.locator('#stats-content')).toContainText('Este navegador');
    await page.locator('[data-close="stats"]').tap();
    const targetSizes = await page.locator('.game-tools button').evaluateAll(buttons => buttons.map(button => { const r = button.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
    expect(targetSizes.every(r => r.width >= 44 && r.height >= 44)).toBe(true);
    await page.locator('#letter-button').tap(); await expect(page.locator('#letter-dialog')).toBeVisible(); expect(await page.locator('#letter-dialog').evaluate(dialog => dialog.getBoundingClientRect().width <= innerWidth)).toBe(true); await page.getByRole('button', { name: 'Cerrar la carta' }).tap(); expect(observed.errors).toEqual([]);
  } finally { await context.close(); }
});

test('private content, offline, reconnect, closed-tab continuity and session revocation keep their negative controls', async ({ page, context }) => {
  const unauth = await page.request.get(`${origin}/api/world?x=-400&y=200&width=40&height=28`); expect(unauth.status()).toBe(401);
  const mutation = await page.request.post(`${origin}/api/gesture`, { headers: { Origin: origin }, data: { id: 'unauth-command', kind: 'command', agentId: 's', order: 'move', x: 0, y: 0 } }); expect(mutation.status()).toBe(401);
  await enter(page); const tick = app.world.tick; await context.setOffline(true); await expect(page.locator('#connection-label')).not.toHaveText('En vivo');
  await expect(page.locator('#gesture-send')).toBeDisabled(); await expect(page.locator('#direct-toggle')).toBeDisabled(); await expect.poll(() => app.world.tick).toBeGreaterThan(tick);
  await context.setOffline(false); await expect(page.locator('#connection-label')).toHaveText('En vivo', { timeout: 15_000 });
  const closedTick = app.world.tick; await page.close(); await expect.poll(() => app.world.tick).toBeGreaterThan(closedTick);
  const resumed = await context.newPage(); await resumed.goto(origin); await expect(resumed.locator('#landscape')).toBeVisible(); await expect(resumed.locator('#connection-label')).toHaveText('En vivo');
  store.revoke(); await expect(resumed.getByLabel('Contraseña privada')).toBeVisible(); await expect(resumed.locator('#landscape')).toHaveCount(0);
});

test('server persistence failure pauses the same-sequence world and blocks commands', async ({ page }) => {
  await enter(page); const save = store.save.bind(store); store.save = () => { throw new Error('synthetic browser disk error'); };
  try { await expect(page.locator('#connection-notice')).toContainText('pausa'); await expect(page.locator('#gesture-send')).toBeDisabled(); await expect(page.locator('#direct-toggle')).toBeDisabled(); await expect(page.locator('[data-order="build"]')).toBeDisabled(); }
  finally { store.save = save; }
});

test('world statistics show real scopes, live series and keyboard-operated tabs', async ({ page }) => {
  const observed = observeMessages(page); await page.setViewportSize({ width: 1440, height: 900 }); await enter(page);
  await page.locator('#stats-toggle').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#stats-tab-life')).toBeFocused();
  await expect(page.locator('#stats-content .stat-card').filter({ has: page.locator(':scope > span', { hasText: /^Habitantes$/ }) }).locator('strong')).toHaveText(String(app.world.people.length));
  await expect(page.locator('#stats-content')).toContainText('Todavía no hay muestras');
  await expect.poll(() => observed.views.at(-1)?.stats?.history.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.locator('.history-chart svg')).toHaveCount(2);
  const geometry = await page.locator('.history-chart svg').evaluateAll(charts => charts.map(chart => ({ text: chart.getAttribute('aria-label'), points: chart.querySelector('polyline')?.getAttribute('points') })));
  expect(geometry.every(chart => chart.text?.includes('muestra') && chart.points && !/NaN|Infinity/.test(chart.points))).toBe(true);
  await page.screenshot({ path: 'artifacts/desktop-stats-v5.png' });
  const episodes=page.locator('[data-detail="world-events"]'); await episodes.locator('summary').click();
  await expect(episodes).toContainText('Qué influyó:');
  await page.locator('#stats-tab-life').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#stats-tab-land')).toBeFocused(); await expect(page.locator('#stats-tab-land')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#stats-content')).toContainText('no todo el territorio posible');
  await expect(page.locator('#stats-content')).toContainText('Agua dulce'); await expect(page.locator('#stats-content')).toContainText('Vida animal');
  await page.screenshot({ path: 'artifacts/land-stats-v5.png' });
  await page.keyboard.press('ArrowRight'); await expect(page.locator('#stats-content')).toContainText('no implica hostilidad');
  await page.keyboard.press('End'); await expect(page.locator('#stats-tab-performance')).toBeFocused();
  await expect(page.locator('#stats-content')).toContainText('CPU por cuadro');
  await expect(page.locator('#stats-content')).toContainText('Los tiempos de dibujo no miden la ocupación de la GPU');
  await page.screenshot({ path: 'artifacts/performance-v5.png' });
  await page.locator('#stats-content').evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
  await page.screenshot({ path: 'artifacts/performance-graphics-v5.png' });
  await page.keyboard.press('Escape'); await expect(page.locator('#stats-drawer')).toBeHidden(); await expect(page.locator('#stats-toggle')).toBeFocused();
  await fullscreen(page, 1440, 900); expect(observed.errors).toEqual([]);
});

test('an engine-born descendant exposes genealogy, causal memories and learned culture without losing keyboard focus', async ({ page }) => {
  // Arrange sufficient local resources and trust, then let one actual server step form a community and birth.
  // The UI receives the resulting real WorldView; no browser-injected person, genealogy or episode.
  const fixture = app.world; const founders = fixture.people.filter(p => p.role === 'neighbor').slice(0, 3); setFixtureTick(119);
  for (const founder of founders) {
    founder.x = 25; founder.y = 8; founder.target = { x: 25, y: 8 }; founder.action = 'rest'; founder.decisionAt = 500;
    founder.hunger = .1; founder.thirst = .1; founder.fatigue = .1; founder.energy = .9; founder.inventory = .25;
    founder.culture = { sharing: .6, stewardship: .6, openness: .6 };
    for (const other of founders) if (other !== founder) founder.bonds[other.id] = .5;
  }
  assertWorld(fixture);
  app.stepOnce(); expect(app.failed).toBe(false); assertWorld(app.world);
  const child = app.world.people.find(p => p.genome.generation === 1)!; expect(child).toBeTruthy();
  const birth = app.world.events.find(event => event.kind === 'birth' && event.actors.includes(child.id))!; expect(birth).toBeTruthy();
  const observed = observeMessages(page); await page.setViewportSize({ width: 1440, height: 900 }); await enter(page);
  await page.locator('#population-toggle').click(); await page.getByLabel('Buscar habitante').fill(child.name); await page.locator(`[data-person="${child.id}"]`).click();
  await expect(page.locator('#population-drawer')).toBeHidden();
  await page.locator('#inspector-tab-story').click();
  const genomeSummary = page.locator('[data-detail="genome"] summary'); await genomeSummary.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-detail="genome"]')).toContainText('Parámetros heredados y fijados al nacer');
  await expect(page.locator('[data-detail="genome"] [data-parent]')).toHaveCount(2);
  const tickBefore = app.world.tick; await expect.poll(() => app.world.tick).toBeGreaterThan(tickBefore + 6); await expect(genomeSummary).toBeFocused();
  await page.locator('[data-detail="experiences"] summary').click(); await expect(page.locator('.experience-list')).toContainText(birth.cause);
  await page.locator('[data-detail="community"] summary').click(); await expect(page.locator('.person-community')).not.toContainText('Sin comunidad');
  await expect(page.locator('#inhabitant-card meter[aria-label="Sed"]')).toHaveCount(1);
  await page.locator('#inhabitant-card').evaluate(panel => { panel.scrollTop = 240; });
  await page.screenshot({ path: 'artifacts/genealogy-v5.png' });
  const parentId = child.genome.parents[0]!, parent = app.world.people.find(p => p.id === parentId)!;
  await page.locator(`[data-detail="genome"] [data-parent="${parentId}"]`).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#inspector-title')).toHaveText(parent.name);
  await page.locator('#stats-toggle').click(); await page.locator('#stats-tab-communities').click();
  await expect(page.locator('.community-card')).toHaveCount(app.world.communities.length);
  await page.screenshot({ path: 'artifacts/communities-v5.png' });
  await page.locator(`.community-members [data-person-link="${child.id}"]`).click();
  await expect(page.locator('#inspector-title')).toHaveText(child.name);
  await page.locator('#inspector-tab-story').click();
  if (await page.locator('[data-detail="community"]').getAttribute('open') === null) await page.locator('[data-detail="community"] summary').click();
  const communityLink=page.locator('[data-community]'); await communityLink.focus();
  const linkedTick=app.world.tick, scroll=await page.locator('#inhabitant-card').evaluate(card=>card.scrollTop);
  await expect.poll(()=>app.world.tick).toBeGreaterThan(linkedTick+5); await expect(communityLink).toBeFocused();
  expect(await page.locator('#inhabitant-card').evaluate(card=>card.scrollTop)).toBeCloseTo(scroll,0);
  await page.keyboard.press('Enter');
  await expect(page.locator(`[data-community-card="${child.communityId}"]`)).toBeFocused();
  const persisted = store.load()!.world; assertWorld(persisted);
  expect(persisted.tick).toBe(app.world.tick); expect(app.failed).toBe(false);
  expect(persisted.people.find(person => person.id === child.id)?.genome).toMatchObject({ generation: 1, parents: child.genome.parents });
  expect(observed.gestures).toHaveLength(0); expect(observed.errors).toEqual([]);
});

test('drink, hunt and cooperate orders use confirmed protocol and return to autonomy', async ({ page }) => {
  // Controlled starting conditions only: outcomes still run through browser -> authenticated
  // command -> persisted engine steps. Other actors rest so their successes cannot satisfy ours.
  for (const inhabitant of app.world.people) { inhabitant.action = 'rest'; inhabitant.target = { x: inhabitant.x, y: inhabitant.y }; inhabitant.decisionAt = 5000; }
  const actor = app.world.people.find(p => p.id === 's')!, learner = app.world.people.find(p => p.role === 'neighbor')!;
  for (const inhabitant of [actor, learner]) { inhabitant.x = 25; inhabitant.y = 8; inhabitant.target = { x: 25, y: 8 }; inhabitant.hunger = .3; inhabitant.energy = .9; inhabitant.fatigue = .1; }
  actor.thirst = .65; actor.skills.gather = .8; actor.inventory = 0; actor.bonds[learner.id] = .8; learner.skills = {};
  const resource = app.world.tiles.find(tile => tile.x === 25 && tile.y === 8)!; resource.drinkingWater = 1; resource.species = 'hare'; resource.fauna = 1; resource.growth = 1;
  const prey = materializeAnimals(app.world.seed, [resource], app.world.tick)[0]!; prey.hunger = .95; prey.thirst = .1;
  app.world.animals = [prey]; syncFauna(app.world.tiles, app.world.animals);
  const observed = observeMessages(page); await enter(page);
  const outcomeKey = { drink: 'waterConsumed', hunt: 'hunts', cooperate: 'cooperation' } as const;
  for (const order of ['drink', 'hunt', 'cooperate'] as const) {
    const baseline = app.world.totals[outcomeKey[order]] ?? 0;
    // The app swaps its authoritative world after every durable step: re-read, never keep stale refs.
    const currentActor = () => app.world.people.find(p => p.id === actor.id)!;
    const currentLearner = () => app.world.people.find(p => p.id === learner.id)!;
    const currentResource = () => app.world.tiles.find(tile => tile.x === 25 && tile.y === 8)!;
    const before = { water: currentResource().drinkingWater!, fauna: currentResource().fauna!, thirst: currentActor().thirst,
      inventory: currentActor().inventory, skill: currentLearner().skills.gather ?? 0, trust: currentActor().bonds[learner.id] ?? 0, tick: app.world.tick };
    await issueTask(page, order);
    await expect.poll(() => observed.gestures.some(gesture => gesture.order === order)).toBe(true);
    await expect(page.locator('#gesture-result')).toContainText('Tarea recibida');
    await expect.poll(() => app.world.people.find(p => p.id === 's')!.command?.order).toBe(order);
    await expect.poll(() => app.world.totals[outcomeKey[order]] ?? 0).toBeGreaterThan(baseline);
    if (order === 'drink') {
      expect(currentResource().drinkingWater).toBeLessThan(before.water);
      expect(currentActor().thirst).toBeLessThan(before.thirst);
    } else if (order === 'hunt') {
      expect(app.world.animals.some(animal => animal.id === prey.id)).toBe(false);
      expect(app.world.events.some(event => event.kind === 'animal' && event.actors.includes(prey.id) && event.actors.includes(actor.id) && event.cause === 'caza humana')).toBe(true);
      expect(currentActor().inventory).toBeGreaterThan(before.inventory);
    } else {
      expect(currentLearner().skills.gather).toBeGreaterThan(before.skill);
      expect(currentActor().bonds[learner.id]).toBeGreaterThan(before.trust);
      const event = app.world.events.find(item => item.kind === 'cooperation' && item.tick > before.tick && item.actors.includes(actor.id) && item.actors.includes(learner.id));
      expect(event).toBeTruthy(); expect(event!.cause).toContain('teach');
      expect(currentLearner().experiences.some(experience => experience.causeId === event!.id)).toBe(true);
    }
    await page.locator('[data-order="auto"]').click(); await expect(page.locator('#gesture-result')).toContainText('Retoma');
    await expect.poll(() => app.world.people.find(p => p.id === 's')!.controlMode).toBe('auto');
  }
  const cooperation = app.world.events.find(event => event.kind === 'cooperation' && event.actors.includes('s'))!; expect(cooperation).toBeTruthy();
  await page.locator('#inspector-tab-story').click();
  await page.locator('[data-detail="experiences"] summary').click(); await expect(page.locator('.experience-list')).toContainText(cooperation.cause);
  await page.screenshot({ path: 'artifacts/cooperation-v5.png' });
  expect(new Set(observed.gestures.map(gesture => gesture.id)).size).toBe(observed.gestures.length);
  expect(observed.errors).toEqual([]);
});

test('V4 mobile animal search, inspection and follow preserve human authority boundaries', async ({ browser }) => {
  const tile = app.world.tiles.find(t => t.x === 25 && t.y === 8)!;
  for (const t of app.world.tiles) if (Math.abs(t.x - tile.x) <= 6 && Math.abs(t.y - tile.y) <= 6) { t.drinkingWater = 0; if (t.y === 8 && t.x >= 25 && t.x <= 28) t.terrain = 'meadow'; }
  tile.species = 'deer'; tile.fauna = 1;
  const animal = materializeAnimals(app.world.seed, [tile], app.world.tick)[0]!; animal.hunger = .1; animal.thirst = .8;
  app.world.animals = [animal]; syncFauna(app.world.tiles, app.world.animals);
  app.world.tiles.find(t => t.x === 28 && t.y === 8)!.drinkingWater = .8;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage(), observed = observeMessages(page);
  try {
    await enter(page); await page.locator('#population-toggle').tap(); await page.getByRole('button', {name:'Fauna',exact:true}).tap();
    await page.getByRole('combobox', {name:'Especie',exact:true}).selectOption('wolf'); await expect(page.locator('[data-animal]')).toHaveCount(0);
    await page.getByRole('combobox', {name:'Especie',exact:true}).selectOption('deer'); await page.getByLabel('Buscar animal').fill(animal.id);
    const row = page.locator(`[data-animal="${animal.id}"]`); await expect(row).toHaveCount(1); await row.tap();
    await expect(page.locator('#inspector-title')).toHaveText('Venado'); await expect(page.locator('#person-controls')).toBeHidden(); await expect(page.locator('#direct-toggle')).toBeHidden();
    await expect(page.locator('#inhabitant-card meter')).toHaveCount(5); await expect(page.locator('#inhabitant-card')).not.toContainText('Últimas experiencias');
    const bounds = await page.locator('#inspector-drawer').boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThan(0); expect(bounds!.y+bounds!.height).toBeLessThan(844);
    await page.screenshot({path:'artifacts/animal-inspector-mobile-v5.png'});
    await page.locator('#follow-toggle').tap(); await expect(page.locator('#inspector-drawer')).toBeHidden(); await expect(page.locator('#mode-indicator')).toContainText('Siguiendo a Venado');
    await expect(page.locator('#camera-coordinates')).toHaveText('25, 8');
    for (let i=0;i<25;i++) app.stepOnce(); expect(app.failed).toBe(false);
    await expect.poll(() => observed.views.some(view => view.animals?.some(a => a.id===animal.id && a.x>25))).toBe(true);
    await expect(page.locator('#camera-coordinates')).not.toHaveText('25, 8');
    await page.locator('#landscape').focus(); await page.keyboard.press('d'); expect(observed.gestures).toHaveLength(0);
    await page.locator('#landscape').press('ArrowRight'); await expect(page.locator('#follow-toggle')).toHaveAttribute('aria-pressed','false');
    await page.locator('#population-toggle').tap(); await page.getByRole('button',{name:'Habitantes',exact:true}).tap(); await expect(page.locator('#population-count')).toHaveText(String(app.world.people.length));
    await fullscreen(page,390,844); expect(observed.errors).toEqual([]);
  } finally { await context.close(); }
});

test('V5 received daylight, rain and reduced motion preserve the world and camera controls', async ({ page }) => {
  // Prepared server state only; every browser frame still comes from the authenticated projection.
  setFixtureTick(899);
  for (const inhabitant of app.world.people) { inhabitant.action = 'rest'; inhabitant.target = {x:inhabitant.x,y:inhabitant.y}; inhabitant.decisionAt = 5000; }
  app.stepOnce(); expect(app.failed).toBe(false);
  const observed = observeMessages(page); await page.setViewportSize({width:1440,height:900}); await page.emulateMedia({reducedMotion:'reduce'}); await enter(page);
  await page.locator('[data-close="inspector"]').click(); await page.locator('#zoom-in').click(); await page.locator('#zoom-in').click();
  const phase = page.locator('[data-landscape-layer="atmosphere"]').first();
  const day = await phase.evaluate(layer=>getComputedStyle(layer).opacity); await page.screenshot({path:'artifacts/daylight-v5.png'});
  const before = app.world.tick; await page.locator('#landscape').focus(); await page.keyboard.press('ArrowRight');
  expect(app.world.tick).toBe(before); expect(observed.gestures).toHaveLength(0);
  setFixtureTick(2099); app.world.weather = 'rain'; app.stepOnce(); expect(app.failed).toBe(false);
  await expect.poll(()=>observed.views.at(-1)?.tick).toBe(2100);
  await expect.poll(async()=>Number(await phase.evaluate(layer=>getComputedStyle(layer).opacity))).toBeGreaterThan(Number(day)+.3);
  const tick = app.world.tick; await page.screenshot({path:'artifacts/night-rain-v5.png'}); expect(app.world.tick).toBe(tick);
  await page.locator('#stats-toggle').click(); await page.locator('#stats-tab-technology').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#stats-tab-technology')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#stats-content')).toHaveAttribute('aria-labelledby','stats-tab-technology');
  await page.keyboard.press('End'); await expect(page.locator('#stats-tab-performance')).toBeFocused();
  await fullscreen(page,1440,900); expect(observed.errors).toEqual([]);
});

test('V5 a keyboard harvest stores real food once, shows progress and respects the carrying limit', async ({ page }) => {
  for (const inhabitant of app.world.people) { inhabitant.action='rest';inhabitant.target={x:inhabitant.x,y:inhabitant.y};inhabitant.decisionAt=5000; }
  const site=app.world.tiles.find(tile=>tile.terrain!=='water'&&tile.x>4&&tile.x<35&&tile.y>3&&tile.y<24&&app.world.people.every(person=>Math.hypot(person.x-tile.x,person.y-tile.y)>5)&&app.world.animals.every(animal=>Math.hypot(animal.x-tile.x,animal.y-tile.y)>5))!;
  expect(site).toBeDefined();site.food=.8;
  const actor=app.world.people.find(person=>person.id==='s')!;
  actor.x=site.x;actor.y=site.y;actor.target={x:site.x,y:site.y};actor.energy=.95;actor.hunger=.2;actor.thirst=.1;actor.fatigue=.1;actor.inventory=.24;actor.work=0;actor.skills.forage=0;
  const current=()=>app.world.people.find(person=>person.id==='s')!;
  const currentTile=()=>app.world.tiles.find(tile=>tile.x===site.x&&tile.y===site.y)!;
  const observed=observeMessages(page);await page.setViewportSize({width:390,height:844});await enter(page);await page.locator('#focus-s').click();
  const reserve=page.getByRole('meter',{name:'Alimento reservado'});
  await expect(reserve).toHaveAttribute('value','0.24');await expect(reserve).toHaveAttribute('max','0.25');
  await showTask(page,'forage');
  const button=page.getByRole('button',{name:'Cosechar alimento',exact:true});await button.focus();await expect(button).toBeInViewport();
  await page.screenshot({path:'artifacts/forage-before-v5.png'});await page.keyboard.press('Enter');
  await expect.poll(()=>observed.gestures.length).toBe(1);
  for(let i=0;i<5;i++)app.stepOnce();expect(app.failed).toBe(false);
  await expect(page.locator('#gesture-result')).toContainText('Tarea recibida');
  await expect(page.locator('.game-current-action')).toContainText('Cosechando alimento');
  await expect(page.getByRole('meter',{name:'Progreso de la tarea'})).toBeVisible();
  await expect(reserve).toHaveAttribute('value','0.24');expect(current().inventory).toBe(.24);
  let lastFood=currentTile().food, lastHunger=current().hunger, steps=5;
  await expect.poll(()=>{
    if(current().inventory<.25){if(++steps>25)throw new Error('La cosecha no concluyó en 25 pasos reales');lastFood=currentTile().food;lastHunger=current().hunger;app.stepOnce();}
    expect(app.failed).toBe(false);return current().inventory;
  },{intervals:[10]}).toBe(.25);
  expect(lastFood-currentTile().food).toBeCloseTo(.01,10);expect(current().hunger).toBeGreaterThanOrEqual(lastHunger);
  expect(current().command).toBeNull();expect(current().controlMode).toBe('auto');expect(current().work).toBe(0);
  current().action='rest';current().decisionAt=app.world.tick+5000;
  for(let i=0;i<5;i++)app.stepOnce();expect(current().inventory).toBe(.25);
  await expect(reserve).toHaveAttribute('value','0.25');await expect(page.locator('.agency-state')).toContainText('Actuando por su cuenta');
  await expect(page.getByRole('meter',{name:'Progreso de la tarea'})).toHaveCount(0);
  await reserve.scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/forage-after-v5.png'});
  await fullscreen(page,390,844);expect(observed.gestures[0]).toMatchObject({kind:'command',agentId:'s',order:'forage'});expect(observed.errors).toEqual([]);
});

test('V5 research and immediate craft keep causal work, material balances and keyboard-readable procedures', async ({ page }) => {
  for (const inhabitant of app.world.people) { inhabitant.action='rest';inhabitant.target={x:inhabitant.x,y:inhabitant.y};inhabitant.decisionAt=5000; }
  const actor = app.world.people.find(person=>person.id==='s')!;
  actor.materials={wood:12,stone:8};actor.energy=.95;actor.hunger=.1;actor.thirst=.1;actor.fatigue=.1;
  // A reproducible unfinished experiment is the only prepared technology: no recipe or product exists yet.
  const program: TechnologyProgram = {inputs:[{source:'raw',material:'stone',mass:1000}],steps:[{op:'form',intensity:4,shape:'edge'},{op:'compress',intensity:2}]};
  actor.technology.project={kind:'research',program,parents:[],recipeId:null,progress:0,requiredWork:technologyWorkCost(program),energyPaid:0,startedAt:app.world.tick};
  expect(app.world.technology.recipes).toHaveLength(0);expect(actor.technology.items).toHaveLength(0);
  const observed=observeMessages(page);await page.setViewportSize({width:1440,height:900});await enter(page);
  const current=()=>app.world.people.find(person=>person.id==='s')!;
  async function command(order:'research'|'craft',done:()=>boolean):Promise<void>{
    const previous=observed.gestures.length;await issueTask(page, order);await expect.poll(()=>observed.gestures.length).toBe(previous+1);
    let steps=0;
    for(let i=0;i<5;i++)app.stepOnce();await expect(page.locator('#gesture-result')).toContainText('Tarea recibida');
    await expect.poll(()=>{for(let i=0;i<5&&!done();i++){if(++steps>150)throw new Error(`${order} no concluyó en 150 pasos reales`);app.stepOnce();}expect(app.failed).toBe(false);return done();},{intervals:[10,20,30]}).toBe(true);
    current().decisionAt=app.world.tick+5000;current().action='rest';
    for(let i=0;i<5;i++)app.stepOnce();
  }
  await command('research',()=>app.world.technology.recipes.length===1);
  expect(current().materials.stone).toBe(7);expect(current().technology.items).toHaveLength(1);
  expect(observed.views.some(view=>view.people.some(person=>person.id==='s'&&person.working&&Number(person.workProgress)>0))).toBe(true);
  await command('craft',()=>app.world.technology.ledger.crafted===2);
  expect(current().materials.stone).toBe(6);expect(current().technology.items).toHaveLength(2);
  await expect.poll(()=>observed.views.at(-1)?.technology?.dynamics.massError).toBe(0);
  await page.locator('#inspector-tab-kit').click(); await page.locator('[data-detail="products"] summary').click();
  await page.locator('[data-recipe]').first().click();
  await expect(page.locator('#stats-tab-technology')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#stats-content')).toContainText('La materia se conserva');
  await expect(page.locator('.technology-recipe')).toHaveCount(1);
  const summary=page.locator('.technology-recipe summary');await expect(summary).toBeFocused();
  await expect(page.locator('.technology-recipe')).toHaveAttribute('open','');
  await expect(page.locator('.process-steps')).toContainText('Intensidad 4/4');
  for(let i=0;i<5;i++)app.stepOnce();await expect.poll(()=>observed.views.at(-1)?.tick).toBe(app.world.tick);await expect(summary).toBeFocused();
  await page.locator('#stats-content').evaluate(panel=>{panel.scrollTop=panel.scrollHeight;});
  await page.screenshot({path:'artifacts/procedures-v5.png'});
  await expect(page.locator('#stats-content')).not.toContainText('NaN');await fullscreen(page,1440,900);
  expect(observed.gestures.map(gesture=>gesture.order)).toEqual(['research','craft']);expect(observed.errors).toEqual([]);
});

test('V5 an ended life leaves its cause visible and cannot retain human controls', async ({ page }) => {
  for (const inhabitant of app.world.people) { inhabitant.action='rest';inhabitant.target={x:inhabitant.x,y:inhabitant.y};inhabitant.decisionAt=5000; }
  const neighbor = app.world.people.find(person=>person.role==='neighbor')!;
  const observed=observeMessages(page);await page.setViewportSize({width:1440,height:900});await enter(page);
  await page.locator('#population-toggle').click();await page.locator(`[data-person="${neighbor.id}"]`).click();await expect(page.locator('#population-drawer')).toBeHidden();
  await page.locator('[data-detail="vitality"] summary').click();await expect(page.locator('#inhabitant-card meter[aria-label="Salud"]')).toHaveCount(1);
  await page.locator('#follow-toggle').click();await page.locator('#direct-toggle').click();
  // Prepared terminal injury; removal and its public cause are produced by actual engine steps.
  const current=app.world.people.find(person=>person.id===neighbor.id)!;current.demography.health=.000001;current.hunger=1;current.thirst=1;current.energy=.02;current.fatigue=.95;
  for(let i=0;i<5;i++)app.stepOnce();expect(app.failed).toBe(false);
  expect(app.world.people.some(person=>person.id===neighbor.id)).toBe(false);
  await expect.poll(()=>observed.views.at(-1)?.demography?.recent.some(entry=>entry.id===neighbor.id)).toBe(true);
  await expect(page.locator('#inhabitant-card')).toContainText('Esta vida terminó');await expect(page.locator('#person-controls')).toBeHidden();await expect(page.locator('#direct-toggle')).toBeHidden();
  await expect(page.locator('#follow-toggle')).toHaveAttribute('aria-pressed','false');
  const commands=observed.gestures.length;await page.locator('#landscape').focus();await page.keyboard.press('d');expect(observed.gestures).toHaveLength(commands);
  await page.screenshot({path:'artifacts/legacy-v5.png'});expect(observed.errors).toEqual([]);
});

test('V4 invention, component construction and repair debit real work and materials once', async ({ page }) => {
  for (const inhabitant of app.world.people) { inhabitant.action='rest';inhabitant.target={x:inhabitant.x,y:inhabitant.y};inhabitant.decisionAt=5000; }
  const site=app.world.tiles.find(tile=>tile.terrain!=='water'&&tile.terrain!=='shelter'&&tile.x>=8&&tile.y>=4&&app.world.places.every(place=>Math.hypot(place.x-tile.x,place.y-tile.y)>=6))!;
  const actor=app.world.people.find(p=>p.id==='s')!; actor.x=site.x;actor.y=site.y;actor.target={x:site.x,y:site.y};actor.materials={wood:12,stone:8};actor.skills.build=.4;actor.energy=.95;actor.hunger=.2;actor.thirst=.6;actor.fatigue=.1;actor.inventory=0;
  for(const tile of app.world.tiles) if(Math.abs(tile.x-site.x)<=4 && Math.abs(tile.y-site.y)<=4){tile.drinkingWater=0;tile.moisture=.7;}
  const observed=observeMessages(page);await page.setViewportSize({width:1440,height:900});await enter(page);
  const current=()=>app.world.people.find(p=>p.id==='s')!;
  async function command(order:'invent'|'build'|'repair',done:()=>boolean):Promise<void>{
    const previous=observed.gestures.length;await issueTask(page, order);await expect.poll(()=>observed.gestures.length).toBe(previous+1);
    let sawCommand=false, steps=0;
    await expect.poll(()=>{for(let i=0;i<5&&!done();i++){if(++steps>500)throw new Error(`${order} no concluyó en 500 pasos reales`);app.stepOnce();sawCommand ||= current().command?.order===order;if(sawCommand&&!current().command&&!done())throw new Error(`La orden ${order} terminó sin producir su resultado.`);}expect(app.failed).toBe(false);return done();},{intervals:[10,20,30,50],timeout:15_000}).toBe(true);expect(app.failed).toBe(false);expect(sawCommand).toBe(true);
  }
  await command('invent',()=>app.world.inventionDynamics.accepted===1);
  const blueprint=app.world.blueprints.find(b=>b.inventorId==='s')!;expect(blueprint).toBeTruthy();expect(blueprint.parents).toContain('blueprint-base');expect(blueprint.components.length).toBeGreaterThan(2);expect(current().materials.wood).toBe(11);expect(blueprint.uses).toBe(0);expect(blueprint.usefulness).toBe(0);
  current().decisionAt=app.world.tick+5000;for(let i=0;i<5;i++)app.stepOnce();
  await page.locator('#inspector-tab-kit').click();await page.locator('[data-detail="blueprint"] summary').click();await expect(page.locator(`[data-blueprint="${blueprint.id}"]`)).toContainText(blueprint.name);await expect(page.locator('.blueprint-cost').first()).toContainText(`${blueprint.cost.work} trabajo`);
  // The next starting inventory is prepared explicitly; construction itself must consume its exact recipe.
  current().materials={wood:blueprint.cost.wood,stone:blueprint.cost.stone};current().decisionAt=app.world.tick+5000;
  await command('build',()=>app.world.structures.some(s=>s.builderId==='s'));
  const structure=app.world.structures.find(s=>s.builderId==='s')!;expect(structure.components).toEqual(blueprint.components);expect(structure.water).toBe(0);expect(structure.food).toBe(0);expect(current().materials).toEqual({wood:0,stone:0});
  structure.condition=.35;current().materials.wood=1;
  await command('repair',()=>app.world.inventionDynamics.repairs===1);
  expect(app.world.structures.find(s=>s.id===structure.id)!.condition).toBeGreaterThan(.7);expect(current().materials.wood).toBe(0);
  for(let i=0;i<5;i++)app.stepOnce();
  await page.locator('#stats-toggle').click();await page.locator('#stats-tab-land').click();await expect(page.locator('#stats-content')).toContainText('Proyectos y construcciones');await page.locator('[data-detail="blueprints"] summary').click();
  await page.locator('#stats-content').evaluate(panel=>{panel.scrollTop=panel.scrollHeight;});await page.screenshot({path:'artifacts/inventions-v5.png'});
  await page.locator(`.structure-link[data-place-x="${structure.x}"][data-place-y="${structure.y}"]`).click();
  await expect(page.locator('#inspector-drawer .structure-card')).toContainText(structure.name);
  await expect(page.locator('#person-controls')).toBeHidden();
  expect(observed.gestures.map(g=>g.order)).toEqual(['invent','build','repair']);expect(new Set(observed.gestures.map(g=>g.id)).size).toBe(3);expect(observed.errors).toEqual([]);
});

test('V5 notebook navigation preserves a full map, fixed mobile tasks, keyboard focus and read-only selections', async ({ page }) => {
  const observed = observeMessages(page); await page.setViewportSize({width:1440,height:900}); await enter(page);
  await expect(page.locator('.game-drawer:visible')).toHaveCount(1);
  const dock=await page.locator('#inspector-drawer').boundingBox(); expect(dock!.x).toBeGreaterThanOrEqual(1020); expect(dock!.width).toBeLessThanOrEqual(400);
  await fullscreen(page,1440,900);
  for(const id of ['population-toggle','stats-toggle','layer-toggle','intervene-toggle','inspector-toggle']) {
    await page.locator(`#${id}`).click(); await expect(page.locator('.game-drawer:visible')).toHaveCount(1);
    await expect(page.locator(`#${id}`)).toHaveAttribute('aria-expanded','true');
  }
  await page.setViewportSize({width:390,height:844}); await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#inspector-tab-now').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#inspector-tab-kit')).toBeFocused(); await expect(page.locator('#inspector-section-now')).toBeHidden();
  await page.keyboard.press('End'); await expect(page.locator('#inspector-tab-story')).toBeFocused();
  const fixedBefore=await page.locator('#task-toggle').boundingBox();
  await page.locator('[data-detail="genome"] summary').click();
  await page.locator('#inhabitant-card').evaluate(card=>{card.scrollTop=card.scrollHeight;});
  const fixedAfter=await page.locator('#task-toggle').boundingBox(); expect(fixedAfter).toEqual(fixedBefore);
  await expect(page.locator('#task-toggle')).toBeInViewport(); await page.locator('#task-toggle').click();
  const available:string[]=[];
  for(const group of ['sustenance','work','building']) {
    await page.locator(`[data-task-group="${group}"]`).click();
    for(const button of await page.locator('[data-order-group]:visible').all()) { await expect(button).toBeInViewport(); available.push((await button.getAttribute('data-order'))!); }
  }
  expect(available.sort()).toEqual(['build','cooperate','craft','drink','explore','farm','forage','gather','hunt','invent','repair','research','rest'].sort());
  await expect(page.locator('[data-order="auto"]')).toBeInViewport();
  await page.setViewportSize({width:320,height:568});
  await page.locator('[data-task-group="work"]').click();
  for(const button of await page.locator('[data-order]:visible').all()) await expect(button).toBeInViewport({ratio:1});
  await fullscreen(page,320,568); await page.screenshot({path:'artifacts/interface-tasks-small-mobile.png'});
  await page.setViewportSize({width:667,height:375});
  for(const button of await page.locator('[data-order]:visible').all()) { await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport({ratio:1}); }
  await fullscreen(page,667,375); await page.screenshot({path:'artifacts/interface-tasks-landscape-mobile.png'});
  await page.setViewportSize({width:390,height:844});
  await page.keyboard.press('Escape'); await expect(page.locator('#task-palette')).toBeHidden(); await expect(page.locator('#task-toggle')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('.game-drawer:visible')).toHaveCount(0); await expect(page.locator('#inspector-toggle')).toBeFocused();
  expect(await page.locator('.world-navigation').evaluate(nav=>getComputedStyle(nav).animationName)).toBe('none');
  await fullscreen(page,390,844); expect(observed.gestures).toHaveLength(0); expect(app.world.tick).toBe(0); expect(observed.errors).toEqual([]);
  await page.screenshot({path:'artifacts/interface-navigation-mobile.png'});
});

test('V5 gesture targeting keeps geographic ground coordinates while opening the notebook stays read-only', async ({ page }) => {
  const site=app.world.tiles.find(tile=>tile.x>5&&tile.x<30&&tile.y>4&&tile.y<22&&app.world.people.every(person=>Math.hypot(person.x-tile.x,person.y-tile.y)>3)&&app.world.animals.every(animal=>Math.hypot(animal.x-tile.x,animal.y-tile.y)>3))!;
  expect(site).toBeDefined();
  const observed=observeMessages(page); await page.setViewportSize({width:1440,height:900}); await page.emulateMedia({reducedMotion:'reduce'}); await enter(page);
  await page.locator('#layer-toggle').click(); await page.locator('#tile-x').fill(String(site.x)); await page.locator('#tile-y').fill(String(site.y)); await page.locator('#tile-form button').click();
  await expect(page.locator('#camera-coordinates')).toHaveText(`${site.x}, ${site.y}`);
  await chooseGesture(page,'plant'); await page.mouse.click(720,450);
  await expect(page.locator('#gesture-target')).toHaveText(`casilla ${site.x}, ${site.y}`);
  await expect(page.locator('#tool-drawer')).toBeVisible(); await expect(page.locator('#inspector-drawer')).toBeHidden();
  await expect(page.locator('#gesture-send')).toBeEnabled();
  expect(observed.gestures).toHaveLength(0); expect(app.world.tick).toBe(0); expect(observed.errors).toEqual([]);
});

test('V6 a paid vessel prepares water autonomously and shows actual progress and contents through the server projection', async ({ page }) => {
  // Controlled physical laboratory: this program and starting substrate are
  // selected explicitly. The real process pays its material and work; subsequent
  // preparation comes only from ordinary server steps without user commands.
  const fixture = app.world, maker = fixture.people[2]!, makerId = maker.id;
  fixture.reproductionEnabled = false; fixture.cooperationEnabled = false;
  for (const person of fixture.people) {
    person.action = 'rest'; person.decisionAt = 1_000_000; person.target = { x: person.x, y: person.y };
    person.energy = 1; person.fatigue = 0; person.hunger = person.thirst = 0.1;
  }
  maker.materials = { wood: 0, stone: 2 };
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 2000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'hollow' }, { op: 'compress', intensity: 2 }] };
  maker.technology.project = { kind: 'research', program, parents: [], recipeId: null,
    progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: fixture.tick };
  while (maker.technology.project) { setFixtureTick(fixture.tick + 1); researchTechnology(fixture, maker); }
  expect(maker.technology.items).toHaveLength(1); expect(maker.materials.stone).toBe(0);
  fixture.noveltyEnabled = false;
  for (const tile of fixture.tiles) tile.drinkingWater = 0;
  for (const structure of fixture.structures) structure.water = 0;
  const source = fixture.tiles.find(tile => tile.x === maker.x && tile.y === maker.y)!;
  source.drinkingWater = 0.8; source.wood = source.stone = 0;
  maker.thirst = 0.5; maker.decisionAt = fixture.tick;
  assertWorld(fixture);
  const current = () => app.world.people.find(person => person.id === makerId)!;
  for (let tick = 0; tick < 120 && !current().technology.waterPreparation; tick++) app.stepOnce();
  expect(current().technology.waterPreparation).toBeDefined(); app.stepOnce();
  expect(app.failed).toBe(false); assertWorld(app.world);
  const held = current().technology.items[0]!, target = current().technology.waterPreparation!;
  expect(held.contents!.water).toBeGreaterThan(0); expect(app.world.technology.water!.consumed).toBe(0);
  const observed = observeMessages(page); await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await enter(page);
  await page.locator('#population-toggle').click(); await page.getByLabel('Buscar habitante').fill(current().name);
  await page.locator(`[data-person="${makerId}"]`).click();
  await expect(page.locator('.game-reason')).toContainText('Llena un objeto que retiene agua');
  await expect(page.locator('.game-needs h3')).toContainText('preparar agua para el camino');
  const progress = page.getByRole('meter', { name: 'Progreso de la tarea' });
  await expect(progress).toHaveAttribute('value', String(Math.round((held.contents!.water - target.initialQuanta) / (target.targetQuanta - target.initialQuanta) * 100)));
  await expect.poll(() => observed.views.at(-1)?.version).toBe(6);
  const projected = observed.views.at(-1)!.people.find(person => person.id === makerId)!;
  expect(projected.working).toBe(true); expect(projected.workProgress).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/contained-water-preparation-desktop.png' });
  await progress.scrollIntoViewIfNeeded(); await expect(progress).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: 'artifacts/contained-water-preparation-progress.png' });
  await page.locator('#inspector-tab-kit').click(); await page.locator('[data-detail="products"] summary').click();
  const card = page.locator(`[data-water-item="${held.id}"]`);
  await expect(card).toHaveAttribute('data-water-state', 'partial');
  await expect(card).toContainText('Agua transportada · Con agua');
  await expect(card.locator('meter')).toHaveAttribute('value', String(held.contents!.water));
  await page.setViewportSize({ width: 320, height: 568 }); await card.scrollIntoViewIfNeeded();
  await expect(card).toBeInViewport({ ratio: 1 }); await fullscreen(page, 320, 568);
  await page.screenshot({ path: 'artifacts/contained-water-real-mobile.png' });
  const before = app.world.technology.water!.filled; app.stepOnce();
  expect(app.world.technology.water!.filled).toBeGreaterThan(before);
  await expect(card.locator('meter')).toHaveAttribute('value', String(current().technology.items[0]!.contents!.water));
  for (let tick = 0; tick < 16 && current().technology.waterPreparation; tick++) app.stepOnce();
  expect(current().technology.waterPreparation).toBeUndefined(); expect(app.failed).toBe(false);
  // Normal broadcasts occur every five ticks. A read-only camera request obtains
  // the completed snapshot without advancing past its short completion phase.
  await page.locator('#landscape').focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => observed.views.at(-1)?.tick).toBe(app.world.tick);
  await page.locator('#inspector-tab-now').click();
  await expect(page.locator('.game-reason')).toContainText('Preparó una reserva finita de agua');
  await expect(progress).toHaveCount(0);
  expect(app.world.technology.water!.consumed).toBe(0); expect(app.world.technology.recipes[0]!.utility).toBe(0);
  expect(observed.gestures).toHaveLength(0); expect(observed.errors).toEqual([]); assertWorld(app.world);
});
