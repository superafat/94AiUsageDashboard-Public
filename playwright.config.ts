import { defineConfig, devices } from '@playwright/test';

const E2E_PORT = process.env.E2E_PORT ?? '42813';
const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  use: { ...devices['Pixel 7'], baseURL: E2E_ORIGIN },
  webServer: {
    command: `VITE_E2E=1 npm run build -w apps/web && npm run preview -w apps/web -- --host 127.0.0.1 --port ${E2E_PORT}`,
    url: E2E_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
