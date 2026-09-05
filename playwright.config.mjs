import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:3107',
    channel: 'chrome',
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/dev-recovery-test.mjs',
    url: 'http://127.0.0.1:3107/ledger',
    reuseExistingServer: false,
    timeout: 90000,
    gracefulShutdown: { signal: 'SIGINT', timeout: 5000 },
  },
});
