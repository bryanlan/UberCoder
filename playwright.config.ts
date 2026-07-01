import { defineConfig } from '@playwright/test';

const backendPort = Number(process.env.AGENT_CONSOLE_E2E_SERVER_PORT ?? 4317);
const webPort = Number(process.env.AGENT_CONSOLE_E2E_WEB_PORT ?? 5178);

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: `AGENT_CONSOLE_E2E_SERVER_PORT=${backendPort} npm exec --workspace @agent-console/server -- tsx --tsconfig tsconfig.e2e.json test/e2e/server.ts`,
      url: `http://127.0.0.1:${backendPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `AGENT_CONSOLE_E2E_SERVER_PORT=${backendPort} npm run dev -w @agent-console/web -- --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
