import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  use: { ...devices['Pixel 7'], baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'VITE_E2E=1 npm run build -w apps/web && npm run preview -w apps/web -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
