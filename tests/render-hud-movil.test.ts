import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { createBrowserTestServer as createServer } from './lib/vite.js';
import { createWorld, projectWorld } from '../src/world/index.js';
import type { WorldView } from '../src/shared/types.js';
import type { SaludVisible } from '../src/client/salud-view.js';

function vistaInicial(): WorldView {
  const view = projectWorld(createWorld(51926));
  return { ...view, performance: { stepMs: 52, p95StepMs: 53.6, saveMs: 1, projectionMs: 2, snapshotBytes: 4096,
    activeTiles: 1200, processRssMiB: 300, tickHz: 6.1, tickHzObjetivo: 10,
    fases: { maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0, demografia: 0,
      comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0 }, fraccionSerial: 0 } };
}

test('390×844 y escritorio: la barra cabe y la salud se actualiza aun sin nuevos pasos', { timeout: 120_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: mobile HUD checks not run.'); return; }
  let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    server = await createServer(); await server.listen(); browser = await chromium.launch({ headless: true });
    for (const [width, height] of [[390, 844], [1440, 900]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' }), page = await context.newPage();
      const view = vistaInicial(), errors: string[] = [];
      let salud: SaludVisible = { estado: 'ok', tick: 4321, ticksPorSegundo: 6.1, gpu: [{ dispositivo: 0, estado: 'ok' }], recargas: 0 };
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/session', r => r.fulfill({ json: { authenticated: true } }));
      await page.route('**/api/world**', r => r.fulfill({ json: view }));
      await page.route('**/health', r => r.fulfill({ status: salud.estado === 'parado' ? 503 : 200, json: salud }));
      await page.routeWebSocket(/\/ws(\?.*)?$/, ws => ws.onMessage(() => {}));
      await page.goto(server.resolvedUrls!.local[0]!); await expect(page.locator('#connection-label')).toHaveText('En vivo');
      if (await page.locator('#letter-dialog').isVisible()) await page.getByRole('button', { name: 'Entrar al mundo' }).click();
      const chip = page.locator('#salud-chip');
      await expect(chip).toBeVisible(); await expect(chip).toHaveText('Servidor · en marcha');
      const rhythm = page.locator('#world-rhythm');
      if (width === 390) await expect(rhythm).toContainText('cada 5 s'); else await expect(rhythm).toContainText('6,1 pasos/s · más lento');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'sin desborde horizontal');
      const actions = await page.locator('.game-actions').boundingBox();
      assert.ok(actions && actions.x >= 0 && actions.x + actions.width <= width, `barra de acciones dentro de ${width}px: ${JSON.stringify(actions)}`);
      const logout = await page.locator('#logout-button').boundingBox();
      assert.ok(logout && logout.x + logout.width <= width, 'el botón de salir no queda cortado');
      const small = await page.locator('.game-actions button, .selection-shortcuts button, .world-navigation button, #salud-chip').evaluateAll(buttons => buttons
        .filter(b => (b as HTMLElement).offsetParent !== null)
        .map(b => { const r = b.getBoundingClientRect(); return { id: b.id || b.textContent, w: r.width, h: r.height }; })
        .filter(r => r.w < 44 || r.h < 44));
      if (width === 390) assert.deepEqual(small, [], `objetivos menores de 44 px: ${JSON.stringify(small)}`);
      await chip.click();
      await expect(page.locator('#stats-drawer')).toBeVisible();
      await expect(page.locator('#stats-tab-performance')).toHaveAttribute('aria-selected', 'true');
      const panel = page.locator('[data-panel-salud]');
      await expect(panel).toContainText('En marcha');
      await expect(panel).toContainText('4.321');
      await expect(panel).toContainText('6,1');
      await expect(panel).toContainText('GPU 0');
      const tabs = await page.locator('[data-stats]').evaluateAll(buttons => buttons.map(b => { const r = b.getBoundingClientRect(); const style = getComputedStyle(b); return { text: b.textContent, h: r.height, w: r.width, wrap: style.whiteSpace }; }));
      assert.ok(tabs.every(tab => tab.wrap === 'nowrap' && tab.h >= 44 && tab.w >= 44), `pestañas sin partir palabras y ≥44 px: ${JSON.stringify(tabs)}`);
      const content = page.locator('#stats-content');
      await expect(content.locator('[data-p95]')).toContainText('53,6 ms');
      await expect(content.locator('[data-rhythm]')).toContainText('6,1 pasos/s');
      await expect(content.locator('[data-rhythm]')).toContainText('Más lento de lo pedido');
      await expect(content).toContainText('Instantánea guardada en disco');
      salud = { ...salud, estado: 'parado', ticksPorSegundo: 0, gpu: [{ dispositivo: 0, estado: 'cpu' }], recargas: 2 };
      await expect(chip).toHaveText('Servidor · parado');
      await expect(panel).toHaveAttribute('data-estado', 'parado');
      await expect(panel).toContainText('GPU 0 → CPU');
      await expect(panel.locator('span').filter({ hasText: 'Recargas' }).locator('strong')).toHaveText('2');
      assert.deepEqual(errors, []); await context.close();
    }
  } finally { await browser?.close(); await server?.close(); }
});
