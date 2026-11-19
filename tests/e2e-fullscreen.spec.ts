/** Native Fullscreen API gate. Run only against a copied Source capsule and its isolated client build. */
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

const sourcePins = {
  'src/client/game.ts': '514b1bc19c703cec7511a801519da08dba1e976e165ed82b3580fed9ce402dad',
  'src/client/world-shell.ts': '8a3abc9338ad955eb926df60667dc7f4342ba136ac87abad7fc9bee67120a6ef',
  'src/client/game.css': '19f9372025e320f2d12d771b9cf9199ec4f439be38ebe4b480120950df12324d',
} as const;
const password = 'fullscreen-harness-synthetic-only';
let app: ReturnType<typeof createApp> | undefined;
let store: Store | undefined;
let dir: string | undefined;
let origin: string;

test.beforeAll(() => {
  for (const [file, expected] of Object.entries(sourcePins)) {
    const actual = createHash('sha256').update(readFileSync(join(process.cwd(), file))).digest('hex');
    expect(actual, `Source pin: ${file}`).toBe(expected);
  }
  const staticDir = process.env.E2E_STATIC_DIR;
  if (!staticDir || !isAbsolute(staticDir) || !existsSync(join(staticDir, 'index.html'))) {
    throw new Error('E2E_STATIC_DIR debe apuntar al dist/client absoluto de la cápsula Source copiada.');
  }
});

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fullscreen-native-'));
  store = new Store(join(dir, 'world.sqlite'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  app = createApp({ store, password, origin, seed: 51926, manual: true, staticDir: process.env.E2E_STATIC_DIR! });
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
});

test.afterEach(async () => {
  await app?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = undefined; store = undefined; dir = undefined;
});

async function enter(page: Page): Promise<void> {
  await page.goto(origin);
  await page.getByLabel('Contraseña privada').fill(password);
  await page.getByRole('button', { name: 'Entrar a la carta' }).click();
  await expect(page.getByRole('dialog', { name: 'Para ti, Isa.' })).toBeVisible();
  await page.getByRole('button', { name: 'Entrar al mundo' }).click();
  await expect(page.locator('#connection-label')).toHaveText('En vivo');
  await expect(page.locator('#map-loading')).toBeHidden();
}

async function requireFullscreenCapability(page: Page, requiredForEscape = false): Promise<void> {
  const capability = await page.evaluate(() => ({
    enabled: document.fullscreenEnabled,
    request: typeof document.documentElement.requestFullscreen === 'function',
    exit: typeof document.exitFullscreen === 'function',
  }));
  if (!capability.enabled || !capability.request || !capability.exit) {
    const reason = `el navegador no ofrece Fullscreen nativo aquí (${JSON.stringify(capability)}).`;
    if (requiredForEscape) throw new Error(`NOT_RUN/UNKNOWN: Escape requiere esta capacidad; ${reason}`);
    test.skip(true, `SKIP capability: ${reason}`);
  }
}

async function fullscreenIs(page: Page, id: string | null): Promise<void> {
  await expect.poll(() => page.evaluate(expected => expected === 'app'
    ? document.fullscreenElement === document.getElementById('app')
    : document.fullscreenElement === null, id)).toBe(true);
}

test('Fullscreen nativo: gesto de teclado, cambio real, HUD y salida por botón', async ({ page }) => {
  await enter(page);
  await requireFullscreenCapability(page);
  await page.evaluate(() => {
    const events: Array<string | null> = [];
    Object.assign(window, { __fullscreenEvents: events });
    document.addEventListener('fullscreenchange', () => events.push(document.fullscreenElement?.id ?? null));
  });
  const toggle = page.locator('#fullscreen-toggle');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await fullscreenIs(page, 'app');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Salir de pantalla completa');
  await expect(page.locator('#connection-label')).toHaveText('En vivo');
  await expect(page.locator('#zoom-in')).toBeVisible();
  await page.locator('#zoom-in').click();
  await page.locator('#heat-button').click();
  await expect(page.locator('#heat-button')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#focus-s').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#focus-s')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#inspector-title')).toBeVisible();
  await page.locator('#follow-toggle').click();
  await expect(page.locator('#follow-toggle')).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await fullscreenIs(page, null);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Activar pantalla completa');
  expect(await page.evaluate(() => (window as typeof window & { __fullscreenEvents: Array<string | null> }).__fullscreenEvents)).toEqual(['app', null]);
});

test('Fullscreen nativo: Escape restaura el control', async ({ page }) => {
  if (process.env.E2E_FULLSCREEN_HEADED !== '1') {
    throw new Error('NOT_RUN/UNKNOWN: Escape requiere E2E_FULLSCREEN_HEADED=1 y un Chromium headed con pantalla disponible; el resultado headless no acredita el comportamiento del producto.');
  }
  await enter(page);
  await requireFullscreenCapability(page, true);
  const toggle = page.locator('#fullscreen-toggle');
  await toggle.click();
  await fullscreenIs(page, 'app');
  await page.keyboard.press('Escape');
  await fullscreenIs(page, null);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Activar pantalla completa');
});

test('Fullscreen nativo: cerrar sesión retira fullscreen y vuelve a entrada', async ({ page }) => {
  await enter(page);
  await requireFullscreenCapability(page);
  const toggle = page.locator('#fullscreen-toggle');
  await toggle.click();
  await fullscreenIs(page, 'app');
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await fullscreenIs(page, null);
  await expect(page.getByLabel('Contraseña privada')).toBeVisible();
  await expect(page.locator('#landscape')).toHaveCount(0);
  await expect(page.locator('#fullscreen-toggle')).toHaveCount(0);
});

test('Denegación real: policy adicional top-level rechaza la API y la App muestra aviso', async ({ page }) => {
  let originalHeaders: Record<string, string> | undefined;
  await page.route(`${origin}/`, async route => {
    const response = await route.fetch();
    originalHeaders = response.headers();
    await route.fulfill({
      response,
      headers: { ...originalHeaders, 'permissions-policy': 'fullscreen=()' },
    });
  });
  await enter(page);
  expect(originalHeaders?.['x-frame-options']).toBe('DENY');
  expect(originalHeaders?.['content-security-policy']).toContain("frame-ancestors 'none'");
  const capability = await page.evaluate(() => ({
    enabled: document.fullscreenEnabled,
    request: typeof document.getElementById('app')?.requestFullscreen === 'function',
  }));
  if (capability.enabled || !capability.request) {
    throw new Error(`NOT_RUN/UNKNOWN: Chromium no aplicó la policy top-level o no ofrece requestFullscreen (${JSON.stringify(capability)}).`);
  }

  // The real button click is the user gesture. This listener records an actual
  // native API attempt; the App's own handler still renders its normal notice.
  await page.evaluate(() => {
    const button = document.getElementById('fullscreen-toggle')!;
    const root = document.getElementById('app')!;
    const attempt = new Promise<{ rejected: boolean; name: string }>(resolve => {
      button.addEventListener('click', () => {
        try {
          void root.requestFullscreen().then(
            () => resolve({ rejected: false, name: '' }),
            (error: unknown) => resolve({ rejected: true, name: error instanceof Error ? error.name : String(error) }),
          );
        } catch (error) {
          resolve({ rejected: true, name: error instanceof Error ? error.name : String(error) });
        }
      }, { once: true, capture: true });
    });
    Object.assign(window, { __fullscreenPolicyAttempt: attempt });
  });
  const toggle = page.locator('#fullscreen-toggle');
  await toggle.click();
  const attempt = await page.evaluate(() => (window as typeof window & {
    __fullscreenPolicyAttempt: Promise<{ rejected: boolean; name: string }>;
  }).__fullscreenPolicyAttempt);
  expect(attempt.rejected).toBe(true);
  expect(attempt.name).not.toBe('');
  await expect(page.locator('#fullscreen-notice')).toBeVisible();
  await expect(page.locator('#fullscreen-notice')).toContainText('El navegador no permitió abrir pantalla completa.');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Activar pantalla completa');
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
});
