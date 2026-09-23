import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect, type WebSocketRoute } from '@playwright/test';
import { createBrowserTestServer as createServer } from './lib/vite.js';
import { createWorld, projectWorld } from '../src/world/index.js';
import { enriquecerPersona } from '../src/server/persona-extra.js';
import type { Viewport, WorldView } from '../src/shared/types.js';

/** M3: con la cámara en 300,300 (lejos de todos), el botón S centra en S y abre su ficha; la ficha abierta
 * no se vuelve a pedir en cada paso. El servidor se emula con el mundo real: proyección por cámara y la
 * ficha a demanda de `persona-extra`. */
test('lejos de la gente, S e I se encuentran y la ficha no se pide en cada paso', { timeout: 120_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: find-out-of-camera checks not run.'); return; }
  let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    server = await createServer(); await server.listen(); browser = await chromium.launch({ headless: true });
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const world = createWorld(51926), s = world.people.find(p => p.role === 'S')!, i = world.people.find(p => p.role === 'I')!;
      let sequence = 1, tick = 10;
      const project = (viewport: Viewport): WorldView => ({ ...projectWorld(world, viewport), sequence: sequence++, tick });
      let current = project({ x: 300, y: 300, width: 12, height: 8 });
      assert.equal(current.people.length, 0, 'la vista inicial no tiene a nadie');
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' }), page = await context.newPage();
      const asked: string[] = [], errors: string[] = []; let socket: WebSocketRoute | undefined;
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/session', r => r.fulfill({ json: { authenticated: true } }));
      await page.route('**/api/world**', r => r.fulfill({ json: current }));
      await page.routeWebSocket('**/ws', ws => { socket = ws; ws.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'persona') { asked.push(message.id); ws.send(JSON.stringify({ type: 'persona', id: message.id, persona: enriquecerPersona(world, message.id) ?? null })); }
        if (message.type === 'viewport') { current = project(message.viewport); ws.send(JSON.stringify({ type: 'state', world: current })); }
      }); });
      await page.goto(server.resolvedUrls!.local[0]!); await expect(page.locator('#connection-label')).toHaveText('En vivo');
      if (await page.locator('#letter-dialog').isVisible()) await page.getByRole('button', { name: 'Entrar al mundo' }).click();
      // S está lejos: el botón pide su ficha, la cámara va a su posición exacta y la ficha completa aparece.
      await page.locator('#focus-s').click();
      await expect(page.locator('#inspector-title')).toHaveText('S', { timeout: 15_000 });
      await expect(page.locator('#inspector-tab-kit')).toBeVisible({ timeout: 15_000 });
      assert.ok(asked.includes(s.id), 'se pidió la ficha de S');
      assert.ok(current.people.some(p => p.id === s.id), 'la cámara llegó a S');
      await expect(page.locator('#focus-s')).toHaveAttribute('aria-pressed', 'true');
      // I también se encuentra aunque no esté en cuadro.
      await page.locator('#layer-toggle').click(); await page.locator('#tile-x').fill('300'); await page.locator('#tile-y').fill('300'); await page.locator('#tile-form button').click();
      await expect.poll(() => current.people.length, { timeout: 10_000 }).toBe(0);
      await page.locator('#focus-i').click();
      await expect(page.locator('#inspector-title')).toHaveText(i.name, { timeout: 15_000 });
      await expect(page.locator('#inspector-tab-kit')).toBeVisible({ timeout: 15_000 });
      // «Volver a S» también funciona lejos de S.
      await page.locator('#layer-toggle').click(); await page.locator('#tile-x').fill('300'); await page.locator('#tile-y').fill('300'); await page.locator('#tile-form button').click();
      await expect.poll(() => current.people.length, { timeout: 10_000 }).toBe(0);
      for (const drawer of ['inspector', 'layer']) if (await page.locator(`#${drawer}-drawer`).isVisible()) await page.locator(`[data-close="${drawer}"]`).click();
      await page.locator('#map-reset').click();
      await expect.poll(() => current.people.some(p => p.id === s.id), { timeout: 15_000 }).toBe(true);
      // Con la ficha de S abierta, 40 pasos seguidos no piden su biografía 40 veces.
      await page.locator('#focus-s').click(); await expect(page.locator('#inspector-tab-kit')).toBeVisible();
      const before = asked.filter(id => id === s.id).length;
      for (let n = 0; n < 40; n++) { tick++; current = { ...current, sequence: sequence++, tick }; socket!.send(JSON.stringify({ type: 'state', world: current })); await page.waitForTimeout(15); }
      await page.waitForTimeout(300);
      const during = asked.filter(id => id === s.id).length - before;
      assert.ok(during <= 3, `40 pasos con la ficha abierta pidieron ${during} fichas (antes: una por paso)`);
      assert.deepEqual(errors, []); await context.close();
    }
  } finally { await browser?.close(); await server?.close(); }
});
