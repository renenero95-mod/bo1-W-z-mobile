import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 180_000,
  reporter: 'list',
  outputDir: '.cache/e2e/results',
  webServer: { command: 'node server/index.ts', url: 'http://127.0.0.1:8630/', env: { ...process.env, PORT: '8630', NET_PORT: '0' } },
  use: { channel: 'chrome', baseURL: 'http://127.0.0.1:8630', locale: 'fr-FR' },
});
