import { expect, test } from '@playwright/test';
import type { BoundSession, ConversationSummary, ProjectSummary } from '@agent-console/shared';

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`stopped run visibility and cancellation on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const stamp = new Date().toISOString();
    const session: BoundSession = { id: 'recovery-fixture', provider: 'codex', projectSlug: 'demo', conversationRef: 'c1', tmuxSessionName: 'fixture-only', status: 'bound', shouldRestore: true, startedAt: stamp, updatedAt: stamp, isWorking: false,
      runFailure: { turnId: 't1', failedAt: stamp, code: 'server_overloaded', message: 'Selected model is at capacity. Please try a different model.', status: 'scheduled', attempts: 1, maxAttempts: 3, nextRetryAt: new Date(Date.now() + 45_000).toISOString() } };
    const conversation: ConversationSummary = { ref: 'c1', provider: 'codex', projectSlug: 'demo', kind: 'history', title: 'Interrupted deployment', updatedAt: stamp, isBound: true, boundSessionId: session.id, degraded: false };
    const project: ProjectSummary = { slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo', tags: [], allowedLocalhostPorts: [], providers: { codex: { id: 'codex', label: 'Codex', conversations: [conversation] }, claude: { id: 'claude', label: 'Claude', conversations: [] } } };
    let stopCalls = 0;
    await page.route('**/api/auth/me', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-only' } }));
    await page.route('**/api/projects/tree', route => route.fulfill({ json: { projects: [project], boundSessions: [session] } }));
    await page.route('**/api/conversations/demo/codex/c1/messages**', route => route.fulfill({ json: { conversation, boundSession: session, messages: [{ id: 'm1', provider: 'codex', role: 'status', statusKind: 'run-failure', lifecycle: 'durable', text: 'Run stopped: Selected model is at capacity.', timestamp: stamp, conversationRef: 'c1', source: 'history-file' }] } }));
    await page.route('**/api/sessions/recovery-fixture/screen**', route => route.fulfill({ json: { session, screen: { content: '', inputText: '', status: '98% left', capturedAt: stamp, contextPercent: 98 } } }));
    await page.route('**/api/sessions/recovery-fixture/keys', async route => {
      expect(route.request().postDataJSON().keys).toEqual(['Escape']); stopCalls += 1;
      session.runFailure = { ...session.runFailure!, status: 'stopped', stoppedReason: 'Automatic recovery cancelled by user input or Stop.' };
      await route.fulfill({ json: { session } });
    });
    await page.goto('/projects/demo/codex/c1');
    if (viewport.name === 'mobile') {
      await page.locator('aside').getByRole('link', { name: /Interrupted deployment/ }).click();
      await expect.poll(() => page.locator('aside').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    }
    await expect(page.getByText('Run stopped: Selected model is at capacity.', { exact: true })).toBeVisible();
    await expect(page.getByText('Waiting for session output…', { exact: true })).toHaveCount(0);
    const notice = page.getByRole('alert');
    await expect(notice).toContainText('Run stopped');
    await expect(notice).toContainText('Retry 2 of 3');
    await expect(page.getByRole('button', { name: 'Stop automatic recovery' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-scheduled.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Stop automatic recovery' }).click();
    await expect(notice).toContainText('cancelled');
    expect(stopCalls).toBe(1);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-stopped.png`) });
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('cancelled');
  });
}
