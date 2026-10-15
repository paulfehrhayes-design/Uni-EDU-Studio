import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  webServer: {
    command: 'python backend/server.py >/tmp/uni-edu-backend.log 2>&1 & sleep 3 && npm run dev -- --host 0.0.0.0 --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 120000,
  },
  use: {
    headless: true,
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
});
