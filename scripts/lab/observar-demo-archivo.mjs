import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const [direccion, salida] = process.argv.slice(2);
assert.ok(direccion && salida, 'Uso: node scripts/lab/observar-demo-archivo.mjs URL_LOCAL DIRECTORIO_NUEVO');
const url = new URL(direccion);
assert.equal(url.hostname, '127.0.0.1');
const meta = await fetch(new URL('/api/cinta/meta', url), { signal: AbortSignal.timeout(5000) }).then(r => r.json());
assert.ok(meta.t1 > meta.t0);
mkdirSync(salida, { mode: 0o700 });
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
const comprobadas = [];
try {
  for (const [nombre, width, height] of [['escritorio', 1440, 900], ['movil', 390, 844], ['movil-compacto', 320, 720]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 500, reducedMotion: 'reduce' });
    try {
      const pagina = await context.newPage(), rutas = new Set(), errores = [], sockets = [];
      pagina.on('request', request => {
        const ruta = new URL(request.url()).pathname;
        if (ruta.startsWith('/api/')) rutas.add(`${request.method()} ${ruta}`);
      });
      pagina.on('websocket', socket => sockets.push(socket.url()));
      pagina.on('pageerror', error => errores.push(error.message));
      await pagina.goto(url.href);
      const rango = pagina.locator('[data-dvr-range]');
      await expect(pagina.locator('#map-loading')).toBeHidden();
      await expect(rango).toBeVisible();
      await expect(rango).toHaveValue(String(meta.t0));
      await expect(pagina.locator('[data-dvr-play]')).toHaveAttribute('aria-pressed', 'false');
      await pagina.screenshot({ path: join(salida, `${nombre}-grabacion.png`) });
      await pagina.locator('#population-toggle').click();
      await pagina.locator('#population-list .population-person').nth(2).click();
      await pagina.locator('#inspector-tab-story').click();
      await pagina.locator('.dvr-tramo summary').click();
      const transporte = pagina.locator('.dvr-transport');
      await rango.press('PageUp');
      await expect.poll(async () => Number(await rango.inputValue())).toBeGreaterThan(meta.t0);
      await expect(transporte).not.toHaveAttribute('data-loading', 'true');
      const inicio = Number(await rango.inputValue());
      await pagina.getByRole('button', { name: 'Marcar inicio' }).click();
      await pagina.getByRole('button', { name: 'Último fotograma' }).click();
      await expect(rango).toHaveValue(String(meta.t1));
      await rango.press('PageDown');
      await expect.poll(async () => Number(await rango.inputValue())).toBeLessThan(meta.t1);
      await expect(transporte).not.toHaveAttribute('data-loading', 'true');
      const fin = Number(await rango.inputValue());
      assert.ok(inicio < fin);
      await pagina.getByRole('button', { name: 'Marcar final' }).click();
      if (width < 500) {
        await expect.poll(() => pagina.evaluate(() =>
          document.querySelector('#inspector-drawer').getBoundingClientRect().bottom <=
          document.querySelector('#dvr-bar').getBoundingClientRect().top)).toBe(true);
      }
      await pagina.screenshot({ path: join(salida, `${nombre}-intervalo.png`) });
      await pagina.getByRole('button', { name: '25×' }).click();
      await pagina.getByRole('button', { name: 'Ver tramo' }).click();
      const reproduciendo = pagina.locator('[data-dvr-play]');
      await expect(reproduciendo).toHaveAttribute('aria-pressed', 'true');
      const comienzo = Number(await rango.inputValue());
      assert.ok(comienzo >= inicio && comienzo < fin);
      await expect(rango).toHaveValue(String(fin), { timeout: 20_000 });
      await expect(reproduciendo).toHaveAttribute('aria-pressed', 'false');
      await expect(pagina.locator('.dvr-tramo')).not.toHaveAttribute('open', '');
      await pagina.screenshot({ path: join(salida, `${nombre}-final.png`) });
      await pagina.evaluate(() => localStorage.setItem('carta:last-visit-v2', 'visita-previa'));
      assert.equal(await pagina.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await pagina.goto(new URL('/api/session', url).href);
      assert.equal(await pagina.evaluate(() => localStorage.getItem('carta:last-visit-v2')), 'visita-previa');
      assert.deepEqual(sockets, []);
      assert.deepEqual(errores, []);
      assert.deepEqual([...rutas].sort(), ['GET /api/cinta/chunk', 'GET /api/cinta/meta', 'GET /api/session']);
      comprobadas.push({ nombre, width, height, inicioGrabacion: meta.t0, finGrabacion: meta.t1, inicio, fin, pausaEnFin: true, peticiones: [...rutas].sort() });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
writeFileSync(join(salida, 'observacion.json'), JSON.stringify(comprobadas, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(comprobadas));
