import { expect, test, type Page } from '@playwright/test';
import type { WorkerPanelSnapshot } from '@agent-console/shared';

const snapshot: WorkerPanelSnapshot = {
  enabled: true, trackingEnabled: true, snapshotAt: '2026-10-12T12:00:00Z', generating: false, error: null, workingCount: 2,
  workers: [
    { id: 'one', projectSlug: 'demo', projectName: 'PlaidBasic', provider: 'codex', conversationRef: 'worker-one',
      title: 'Prepare the reminder schema publication', working: true, task: 'Publish the schema',
      summary: { task: 'Prepare the reminder schema publication.', latest: 'Checking empty-table readbacks.', coordination: 'Asked the Web agent for its producer requirements.' },
      summaryAt: new Date().toISOString(), stale: false },
    { id: 'two', projectSlug: 'web', projectName: 'WaltiumWeb', provider: 'claude', conversationRef: 'worker-two',
      title: 'Improve portfolio chart loading', working: true, task: 'Improve chart loading',
      summary: { task: 'Improve portfolio chart loading.', latest: 'Running the focused browser checks.', coordination: 'Sent PlaidBasic the required column list.' },
      summaryAt: new Date().toISOString(), stale: false },
  ],
  usage: { date: '2026-10-12', calls: 3, failedCalls: 0, unknownUsageCalls: 0, runningCalls: 0,
    inputTokens: 1400, cachedInputTokens: 600, cacheWriteTokens: 0, outputTokens: 180, totalTokens: 2180 },
};

async function openConsole(page: Page, data = snapshot) {
  const refreshes: number[] = [];
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture' } }));
  await page.route('**/api/projects/tree', (route) => route.fulfill({ json: { projects: data.workers.map((worker) => ({
    slug: worker.projectSlug, directoryName: worker.projectSlug, displayName: worker.projectName, path: `/tmp/${worker.projectSlug}`,
    tags: [], allowedLocalhostPorts: [], providers: Object.fromEntries(['codex', 'claude'].map((provider) => [provider, {
      id: provider, label: provider, conversations: worker.provider === provider ? [{ ref: worker.conversationRef, title: worker.title,
        provider, projectSlug: worker.projectSlug, kind: 'history', isBound: true, degraded: false, updatedAt: new Date().toISOString() }] : [],
    }])) })) , boundSessions: [] } }));
  await page.route('**/api/settings/ui-preferences', (route) => route.fulfill({ json: { recentActivitySortEnabled: false, manualProjectOrder: [] } }));
  await page.route('**/api/settings/network', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/workers', (route) => route.fulfill({ json: data }));
  await page.route('**/api/workers/refresh', (route) => { refreshes.push(route.request().postDataJSON().intervalMinutes); return route.fulfill({ json: data }); });
  await page.route('**/api/workers/tracking', (route) => {
    const enabled = route.request().postDataJSON().enabled;
    data = { ...data, enabled, trackingEnabled: enabled, workingCount: enabled ? 2 : 0 };
    return route.fulfill({ json: data });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open worker panel' }).click();
  await expect(page.getByRole('complementary', { name: 'Active workers' })).toBeVisible();
  return refreshes;
}

test('desktop panel shows all projects, exact identity, cadence and separately reported usage', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const calls = await openConsole(page);
  const panel = page.getByRole('complementary', { name: 'Active workers' });
  await expect(panel.getByText('PlaidBasic', { exact: true })).toBeVisible();
  await expect(panel.getByText('WaltiumWeb', { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: /CODEX:/ })).toHaveAttribute('href', '/projects/demo/codex/worker-one');
  await expect(panel.getByText('Latest: Checking empty-table readbacks.', { exact: true })).toBeVisible();
  await expect(panel.getByText(/2,180 known tokens/)).toBeVisible();
  await expect.poll(() => calls).toContain(2);
  await panel.getByLabel('Summaries every').selectOption('5');
  await expect.poll(() => calls).toContain(5);
  await page.screenshot({ path: testInfo.outputPath('desktop-panel.png') });
  await panel.getByRole('button', { name: 'Close worker panel' }).click();
  const closedCount = calls.length;
  await page.waitForTimeout(250);
  expect(calls).toHaveLength(closedCount);
  await page.getByRole('button', { name: 'Open worker panel' }).click();
  await expect(page.getByLabel('Summaries every')).toHaveValue('5');
});

test('mobile opens a readable drawer and closes it without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openConsole(page);
  await expect(page.getByText('Latest: Checking empty-table readbacks.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('mobile-panel.png') });
  await page.getByRole('button', { name: 'Close worker panel' }).click();
  await expect(page.getByRole('complementary', { name: 'Active workers' })).toHaveCount(0);
});

test('an idle fleet shows paused summaries and never requests generation', async ({ page }) => {
  const calls = await openConsole(page, { ...snapshot, workingCount: 0, workers: snapshot.workers.map((w) => ({ ...w, working: false })) });
  await expect(page.getByText('No workers are running. Summaries are paused.')).toBeVisible();
  expect(calls).toHaveLength(0);
});

test('Off survives page reload and stops further summary requests', async ({ page }) => {
  const calls = await openConsole(page);
  const toggle = page.getByRole('switch', { name: 'Worker tracking' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('Summaries every')).toBeDisabled();
  const count = calls.length;
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(/Worker tracking is off across all tabs/)).toBeVisible();
  await expect(page.getByText('Latest: Checking empty-table readbacks.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Showing saved information from/)).toBeVisible();
  await expect(page.getByText('Was working', { exact: true })).toHaveCount(2);
  expect(calls).toHaveLength(count);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => calls.length).toBeGreaterThan(count);
});
