import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect, type WebSocketRoute } from '@playwright/test';
import { createBrowserTestServer as createServer } from './lib/vite.js';
import { createWorld, projectWorld } from '../src/world/index.js';
import type { RuntimeStats, WorldView } from '../src/shared/types.js';

/** M2: fixture de presentación con el gobernador en el techo (política techo, p95 > presupuesto). */
function enTecho(): WorldView {
  const view = projectWorld(createWorld(51926));
  const population = view.stats!.population;
  const performance: RuntimeStats = { stepMs: 52, p95StepMs: 53.6, saveMs: 1, projectionMs: 2, snapshotBytes: 4096, activeTiles: 1200, processRssMiB: 300, tickHz: 6.1, tickHzObjetivo: 10,
    fases: { maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0, demografia: 0, comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0 }, fraccionSerial: 0,
    gobernador: { activo: false, presupuestoMs: 50, p95StepMs: 53.6, manual: null, politica: 'techo', techo: population,
      techoObservado: { p95: 53.6, poblacion: population, teselasActivas: 1200, teselasPorHabitante: 1200 / population, senal: 'p95', tick: 0, motivo: 'frenado por p95 = 53.6 ms > 50 ms' } } };
  return { ...view, performance };
}

test('390×844: la barra no desborda, los objetivos miden ≥44 px y el HUD dice que el crecimiento está en pausa', { timeout: 120_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: mobile HUD checks not run.'); return; }
  let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    server = await createServer(); await server.listen(); browser = await chromium.launch({ headless: true });
    for (const [width, height] of [[390, 844], [1440, 900]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' }), page = await context.newPage();
      let current = enTecho(), socket: WebSocketRoute | undefined; const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/session', r => r.fulfill({ json: { authenticated: true } })); await page.route('**/api/world**', r => r.fulfill({ json: current }));
      await page.routeWebSocket('**/ws', ws => { socket = ws; ws.onMessage(() => {}); });
      await page.goto(server.resolvedUrls!.local[0]!); await expect(page.locator('#connection-label')).toHaveText('En vivo');
      if (await page.locator('#letter-dialog').isVisible()) await page.getByRole('button', { name: 'Entrar al mundo' }).click();
      // El chip del HUD: en el techo no se dice «reponiendo».
      const chip = page.locator('#growth-chip');
      await expect(chip).toBeVisible(); await expect(chip).toContainText('Crecimiento en pausa'); await expect(chip).not.toContainText('Reponiendo');
      const rhythm = page.locator('#world-rhythm');
      // 390 px decide modo ligero por heurística: el HUD lo dice en vez de un «En vivo» a secas.
      if (width === 390) await expect(rhythm).toContainText('cada 5 s'); else await expect(rhythm).toContainText('6,1 pasos/s · más lento');
      // Sin desborde horizontal y la barra de acciones entera dentro de la pantalla.
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'sin desborde horizontal');
      const actions = await page.locator('.game-actions').boundingBox();
      assert.ok(actions && actions.x >= 0 && actions.x + actions.width <= width, `barra de acciones dentro de ${width}px: ${JSON.stringify(actions)}`);
      const logout = await page.locator('#logout-button').boundingBox();
      assert.ok(logout && logout.x + logout.width <= width, 'el botón de salir no queda cortado');
      // Objetivos táctiles ≥ 44 px en la barra, IR A, la navegación y las pestañas de Mundo.
      const small = await page.locator('.game-actions button, .selection-shortcuts button, .world-navigation button, #growth-chip').evaluateAll(buttons => buttons
        .filter(b => (b as HTMLElement).offsetParent !== null)
        .map(b => { const r = b.getBoundingClientRect(); return { id: b.id || b.textContent, w: r.width, h: r.height }; })
        .filter(r => r.w < 44 || r.h < 44));
      if (width === 390) assert.deepEqual(small, [], `objetivos menores de 44 px: ${JSON.stringify(small)}`);
      // Tocar el chip abre Mundo › Vida con la causa completa.
      await chip.click();
      await expect(page.locator('#stats-drawer')).toBeVisible();
      await expect(page.locator('.growth-status')).toContainText('se queda en');
      const tabs = await page.locator('[data-stats]').evaluateAll(buttons => buttons.map(b => { const r = b.getBoundingClientRect(); const style = getComputedStyle(b); return { text: b.textContent, h: r.height, w: r.width, wrap: style.whiteSpace, lines: Math.round(r.height / parseFloat(style.lineHeight || '12')) }; }));
      assert.ok(tabs.every(tab => tab.wrap === 'nowrap' && tab.h >= 44 && tab.w >= 44), `pestañas sin partir palabras y ≥44 px: ${JSON.stringify(tabs)}`);
      // Rendimiento: p95 con presupuesto, ritmo, frenazo vigente con coma decimal y la instantánea con su nombre claro.
      await page.locator('#stats-tab-performance').click();
      const content = page.locator('#stats-content');
      await expect(content.locator('[data-p95]')).toContainText('53,6 ms');
      await expect(content.locator('[data-p95]')).toContainText('de 50 ms');
      await expect(content.locator('[data-rhythm]')).toContainText('6,1 pasos/s');
      await expect(content.locator('[data-rhythm]')).toContainText('Más lento de lo pedido');
      await expect(content.locator('[data-last-brake]')).toContainText('vigente');
      await expect(content.locator('[data-last-brake]')).toContainText('53,6 ms > 50 ms');
      await expect(content).toContainText('Instantánea guardada en disco');
      await expect(content).not.toContainText('reponiendo hasta');
      // Una muerte deja la población bajo el techo: el HUD pasa a «Reponiendo».
      current = structuredClone(current); current.sequence++; current.stats!.population -= 2; current.performance!.gobernador!.activo = true;
      socket!.send(JSON.stringify({ type: 'state', world: current }));
      await expect(chip).toContainText(`Reponiendo ${current.stats!.population} de ${current.stats!.population + 2}`);
      assert.deepEqual(errors, []); await context.close();
    }
  } finally { await browser?.close(); await server?.close(); }
});
