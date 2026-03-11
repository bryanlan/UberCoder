import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5178',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'npm exec --workspace @agent-console/server tsx apps/server/test/e2e/server.ts',
      url: 'http://127.0.0.1:4317/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -w @agent-console/web -- --host 127.0.0.1',
      url: 'http://127.0.0.1:5178/login',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
