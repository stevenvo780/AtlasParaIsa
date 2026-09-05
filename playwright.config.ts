import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'e2e.spec.ts', fullyParallel: false, workers: 1,
  timeout: 30_000, expect: { timeout: 8000 }, reporter: 'list',
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
});
