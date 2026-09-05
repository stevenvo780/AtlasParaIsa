// Full-screen browser gates live here; all fixtures are synthetic and isolated per test.
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import type { Gesture, WorldView } from '../src/shared/types.js';

const password = 'synthetic-browser-test-only';
let app: ReturnType<typeof createApp>, store: Store, dir: string, origin: string;
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'carta-browser-')); store = new Store(join(dir, 'world.sqlite'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve())); origin = `http://127.0.0.1:${port}`;
  app = createApp({ store, password, origin, seed: 51926, ...(process.env.E2E_STATIC_DIR ? { staticDir: process.env.E2E_STATIC_DIR } : {}) });
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
  await page.locator('[data-close="population"]').click(); await page.locator('#focus-s').click(); await expect(page.locator('#inspector-title')).toBeInViewport();
  await page.screenshot({ path: 'artifacts/desktop-fullscreen.png' }); expect(observed.errors).toEqual([]);
});

test('free camera requests signed distant terrain and layers without a finite map edge', async ({ page }) => {
  const observed = observeMessages(page); await page.setViewportSize({ width: 1440, height: 900 }); await enter(page);
  await page.locator('#layer-toggle').click(); await page.locator('#observation-layer').selectOption('moisture'); await expect(page.locator('#layer-explanation')).toContainText('humedad');
  await page.locator('#observation-layer').selectOption('none'); await page.locator('#tile-x').fill('-384'); await page.locator('#tile-y').fill('240'); await page.locator('#tile-form button').click();
  await expect(page.locator('#camera-coordinates')).toHaveText('-384, 240');
  await expect.poll(() => observed.views.some(v => (v.originX ?? 0) < -350 && (v.originY ?? 0) > 200 && v.tiles.some(t => t.x < 0))).toBe(true);
  const last = observed.views.at(-1)!; expect(last.infinite).toBe(true); expect(last.width).toBeLessThanOrEqual(96); expect(last.height).toBeLessThanOrEqual(64);
  await page.locator('#landscape').focus(); await page.keyboard.press('ArrowLeft'); await expect(page.locator('#camera-coordinates')).not.toHaveText('-384, 240');
  await page.locator('[data-close="inspector"]').click(); await page.screenshot({ path: 'artifacts/distant-terrain.png' }); expect(observed.errors).toEqual([]);
});

test('mobile touch: full-screen canvas, one drawer, three gestures, synthetic memories and readable letter', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' }); const page = await context.newPage(); const observed = observeMessages(page);
  try {
    await enter(page); await fullscreen(page, 390, 844); await expect(page.locator('#inspector-drawer')).toBeHidden();
    await page.locator('#focus-i').tap(); await expect(page.locator('#inspector-drawer')).toBeVisible(); await expect(page.locator('#direct-toggle')).toBeInViewport();
    await page.locator('#population-toggle').tap(); await expect(page.locator('#population-drawer')).toBeVisible(); await expect(page.locator('#inspector-drawer')).toBeHidden();
    await page.locator('#focus-s').tap(); await expect(page.locator('#population-drawer')).toBeHidden();
    await page.locator('[data-gesture="plant"]').tap(); await expect(page.locator('#tool-drawer')).toBeVisible(); await expect(page.locator('#inspector-drawer')).toBeHidden();
    await page.locator('#gesture-send').tap(); await expect(page.locator('#gesture-result')).toContainText('planta nueva');
    await expect.poll(() => app.world.tick - app.world.lastGestureTick).toBeGreaterThanOrEqual(30);
    await page.locator('[data-gesture="invite"]').tap(); await page.locator('#gesture-send').tap(); await expect(page.locator('#gesture-result')).toContainText('invitación');
    await page.locator('#layer-toggle').tap(); await page.locator('#place-select').selectOption('claro');
    await page.locator('[data-gesture="remember"]').tap(); await expect(page.locator('#memory-preview')).toContainText('no biográfico');
    await expect.poll(() => app.world.tick - app.world.lastGestureTick).toBeGreaterThanOrEqual(30);
    await page.locator('#gesture-send').tap(); await expect(page.locator('#gesture-result')).toContainText('contexto');
    await page.locator('[data-close="tool"]').tap(); await page.screenshot({ path: 'artifacts/mobile-fullscreen.png' });
    await page.locator('#focus-s').tap(); await page.screenshot({ path: 'artifacts/mobile-inspector.png' });
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
