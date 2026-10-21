import { expect, test, type Page } from '@playwright/test';
import type { WorkerPanelSnapshot } from '@agent-console/shared';

const snapshot: WorkerPanelSnapshot = {
  enabled: true, trackingEnabled: true, pauseReason: null, snapshotAt: '2026-10-12T12:00:00Z', generating: false, error: null, workingCount: 2,
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

async function openConsole(page: Page, data = snapshot, openingTexts: Record<string, string> = {}) {
  const refreshes: number[] = [];
  const overviews = new Map<string, string>();
  await page.route('**/api/workers/*/project-overview', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!);
    if (route.request().method() === 'POST') overviews.set(id, 'Prepare reminder schema publication.');
    const text = overviews.get(id) ?? null;
    return route.fulfill({ json: { text, state: text ? 'ready' : 'missing' } });
  });
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
  await page.route('**/api/workers/*/opening-message', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!);
    return route.fulfill({ json: { text: openingTexts[id] ?? data.workers.find(worker => worker.id === id)!.title, error: null } });
  });
  await page.route('**/api/workers/refresh', (route) => { refreshes.push(route.request().postDataJSON().intervalMinutes); return route.fulfill({ json: data }); });
  await page.route('**/api/workers/tracking', (route) => {
    const enabled = route.request().postDataJSON().enabled;
    data = { ...data, enabled, trackingEnabled: enabled, pauseReason: enabled ? null : 'manual', workingCount: enabled ? 2 : 0 };
    return route.fulfill({ json: data });
  });
  await page.goto('/');
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.getByRole('button', { name: 'Close chats', exact: true }).click();
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    await page.getByRole('button', { name: 'Workers', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Open worker panel' }).click();
  }
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
  await expect(panel.getByText('CODEX: Prepare the reminder schema publication', { exact: true })).toBeVisible();
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

test('worker panel defaults to960px, drags, remembers width and fits beside navigation', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  await openConsole(page);
  const panel = page.getByRole('complementary', { name: 'Active workers' });
  const resize = page.getByRole('separator', { name: 'Resize worker panel width' });
  await expect(panel).toHaveCSS('width', '960px');
  const box = (await resize.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 100); await page.mouse.down();
  await page.mouse.move(box.x - 156, box.y + 100); await page.mouse.up();
  await expect(panel).toHaveCSS('width', '1120px');
  await page.reload(); await expect(panel).toHaveCSS('width', '1120px');
  await resize.focus(); await page.keyboard.press('ArrowRight'); await expect(panel).toHaveCSS('width', '1104px');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect(panel).toHaveCSS('width', '608px');
  expect(await page.locator('main').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(320);
  await page.setViewportSize({ width: 2200, height: 1000 }); await expect(panel).toHaveCSS('width', '1104px');
  await resize.dblclick(); await expect(panel).toHaveCSS('width', '960px');
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

test('complete sentences wrap and a card expands across the panel without another refresh', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  const data = { ...snapshot, enabled: false, trackingEnabled: false, pauseReason: 'manual' as const, workingCount: 0,
    workers: snapshot.workers.map(worker => ({ ...worker, summary: { ...worker.summary!,
      latest: 'The agent verified the complete production readbacks and is awaiting the independent review before publishing the corrected worker panel.' } })) };
  const calls = await openConsole(page, data);
  const panel = page.getByRole('complementary', { name: 'Active workers' });
  const latest = panel.getByText(`Latest: ${data.workers[0]!.summary.latest}`, { exact: true }).first();
  const overview = await latest.evaluate(el => ({ overflow: getComputedStyle(el).textOverflow,
    whiteSpace: getComputedStyle(el).whiteSpace, height: el.getBoundingClientRect().height }));
  expect(overview.overflow).not.toBe('ellipsis'); expect(overview.whiteSpace).not.toBe('nowrap'); expect(overview.height).toBeGreaterThan(36);
  await panel.getByRole('button', { name: /Expand worker details: PlaidBasic/ }).click();
  await expect(panel.locator('article')).toHaveCount(1);
  await expect(panel.getByText('CODEX: Prepare the reminder schema publication', { exact: true })).toBeVisible();
  await expect(panel.getByText('Latest: ' + data.workers[0]!.summary.latest, { exact: true })).toHaveCSS('font-size', '24px');
  expect((await panel.locator('article').boundingBox())!.width).toBeGreaterThan(900);
  const sentenceBox = (await panel.getByText('Latest: ' + data.workers[0]!.summary.latest, { exact: true }).boundingBox())!;
  await page.mouse.move(sentenceBox.x + 100, sentenceBox.y + 18); await page.mouse.down();
  await page.mouse.move(sentenceBox.x + 500, sentenceBox.y + 18, { steps: 10 }); await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString().length)).toBeGreaterThan(0);
  await expect(panel.locator('article')).toHaveCount(1);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.screenshot({ path: testInfo.outputPath('expanded-worker.png') });
  await panel.getByRole('button', { name: /Collapse worker details/ }).click();
  await expect(panel.locator('article')).toHaveCount(2);
  await panel.getByRole('button', { name: /Expand worker details: PlaidBasic/ }).click();
  await page.keyboard.press('Escape'); await expect(panel.locator('article')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: /Expand worker details: PlaidBasic/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(calls).toHaveLength(0);
});

test('opening message includes all text beyond the native288character title', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  const text = 'The complete original opening message '.repeat(16) + 'ends with these readable final words.';
  const data = { ...snapshot, workers: [{ ...snapshot.workers[0]!, title: `${text.slice(0, 285)}…` }] };
  await openConsole(page, data, { one: text });
  const full = page.getByRole('complementary', { name: 'Active workers' }).getByText(`CODEX: ${text}`, { exact: true });
  await expect(page.locator('[data-worker-opening]')).toHaveText('CODEX: Prepare reminder schema publication.');
  await page.getByRole('button', { name: /Expand worker details:/ }).click();
  await expect(full).toBeVisible();
  expect(await full.evaluate(el => el.scrollWidth <= el.clientWidth && getComputedStyle(el).whiteSpace !== 'nowrap')).toBe(true);
});


test('a long opening is summarized once, stays within two rows after resize/reload, and expands in full', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  let summaries = 0;
  page.on('request', request => { if (request.url().endsWith('/project-overview') && request.method() === 'POST') summaries++; });
  const text = 'Build a dependable cross-repository agent communication system. '.repeat(20);
  const data = { ...snapshot, workers: [snapshot.workers[0]!] };
  await openConsole(page, data, { one: text });
  const row = page.locator('[data-worker-opening]');
  await expect(row).toHaveText('CODEX: Prepare reminder schema publication.');
  expect(summaries).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const geometry = await row.evaluate(el => ({ height: el.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight), scrollHeight: el.scrollHeight }));
  expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1);
  await page.reload(); await expect(row).toHaveText('CODEX: Prepare reminder schema publication.');
  expect(summaries).toBe(1);
  await page.getByRole('button', { name: /Expand worker details:/ }).click();
  await expect(row).toHaveText(`CODEX: ${text}`);
  await expect(row).toHaveCSS('font-size', '24px');
  expect(summaries).toBe(1);
});

test('long openings stay within two rows while Off, without a project model request', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/project-overview') && request.method() === 'POST') requests.push(request.url()); });
  const text = 'The original project introduction contains several detailed requirements. '.repeat(20);
  await openConsole(page, { ...snapshot, enabled: false, trackingEnabled: false, pauseReason: 'manual', workingCount: 0,
    workers: [snapshot.workers[0]!] }, { one: text });
  await expect(page.locator('[data-worker-opening]')).toHaveText('CODEX: Project summary paused.');
  expect(await page.locator('[data-worker-opening]').evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(56);
  await page.getByRole('button', { name: /Expand worker details:/ }).click();
  await expect(page.locator('[data-worker-opening]')).toHaveText(`CODEX: ${text}`);
  expect(requests).toHaveLength(0);
});


test('a saved description is reused on narrow cards while a fitting opening stays complete on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let summaries = 0;
  page.on('request', request => { if (request.url().endsWith('/project-overview') && request.method() === 'POST') summaries++; });
  const text = 'Fix the flaky login test in the settings suite and publish the correction.';
  await openConsole(page, { ...snapshot, workers: [snapshot.workers[0]!] }, { one: text });
  const row = page.locator('[data-worker-opening]');
  await expect(row).toHaveText('CODEX: Prepare reminder schema publication.');
  await page.setViewportSize({ width: 2200, height: 1000 });
  await expect(row).toHaveText(`CODEX: ${text}`);
  expect(await row.evaluate(el => el.scrollHeight)).toBeLessThanOrEqual(56);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row).toHaveText('CODEX: Prepare reminder schema publication.');
  expect(summaries).toBe(1);
});

for (const state of ['idle', 'audit-paused'] as const) test(`${state} long openings say paused without a project model request`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/project-overview') && request.method() === 'POST') calls.push(request.url()); });
  await openConsole(page, { ...snapshot, enabled: state === 'idle', workingCount: state === 'idle' ? 0 : 1,
    workers: [snapshot.workers[0]!] }, { one: 'Build dependable coordination for agents working across multiple repositories. '.repeat(10) });
  await expect(page.locator('[data-worker-opening]')).toHaveText('CODEX: Project summary paused.');
  expect(calls).toHaveLength(0);
});
