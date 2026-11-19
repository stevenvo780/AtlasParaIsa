import { defineConfig } from '@playwright/test';

// Opt in only when the controller provides a real headed browser environment.
const headed = process.env.E2E_FULLSCREEN_HEADED === '1';
if (headed && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  throw new Error('NOT_RUN/UNKNOWN: Chromium headed requiere un servidor de pantalla accesible (DISPLAY o WAYLAND_DISPLAY).');
}

export default defineConfig({
  testDir: '.',
  testMatch: 'e2e-fullscreen.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: !headed,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    viewport: { width: 1440, height: 900 },
  },
});
