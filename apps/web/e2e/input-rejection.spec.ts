import { expect, test, type Page } from '@playwright/test';
import type { BoundSession, ConversationSummary, ProjectSummary, ProviderId, SessionKeystrokeRequest } from '@agent-console/shared';

const rejection = 'Live session did not accept the typed text into its input buffer. The draft was not submitted.';

async function openConversation(page: Page, provider: ProviderId, delivery: 'reject' | 'queue' = 'reject') {
  const stamp = new Date().toISOString();
  let session: BoundSession = {
    id: 'original-session', provider, projectSlug: 'demo', conversationRef: 'c1',
    tmuxSessionName: 'fixture-only', status: 'bound', shouldRestore: true,
    startedAt: stamp, updatedAt: stamp, isWorking: false,
  };
  const conversation: ConversationSummary = {
    ref: 'c1', provider, projectSlug: 'demo', kind: 'history', title: 'Background build',
    updatedAt: stamp, isBound: true, boundSessionId: session.id, degraded: false,
  };
  const project: ProjectSummary = {
    slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo', tags: [], allowedLocalhostPorts: [],
    providers: {
      codex: { id: 'codex', label: 'Codex', conversations: provider === 'codex' ? [conversation] : [] },
      claude: { id: 'claude', label: 'Claude', conversations: provider === 'claude' ? [conversation] : [] },
    },
  };
  const inputCalls: { sessionId: string; body: SessionKeystrokeRequest }[] = [];
  const bindCalls: unknown[] = [];
  const releaseCalls: string[] = [];
  const screenSessions: string[] = [];
  await page.route('**/api/auth/me', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-only' } }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/settings/ui-preferences', route => route.fulfill({ json: { recentActivitySortEnabled: true, manualProjectOrder: [] } }));
  await page.route('**/api/assignment-activity**', route => route.fulfill({ status: 404, json: { error: 'Fixture has no coordination' } }));
  await page.route('**/api/projects/tree', route => route.fulfill({ json: { projects: [project], boundSessions: [session] } }));
  await page.route(`**/api/conversations/demo/${provider}/c1/messages**`, route => route.fulfill({
    json: { conversation, boundSession: session, messages: [], messagePage: { hasOlder: false, total: 0 } },
  }));
  await page.route('**/api/sessions/*/screen**', route => {
    screenSessions.push(session.id);
    return route.fulfill({ json: { session, screen: {
      content: 'Three background agents are building.', inputText: '', capturedAt: stamp,
      status: provider === 'claude' ? '⏵⏵ bypass permissions on (shift+tab to cycle)' : 'gpt-6.1-sol · 80% left',
    } } });
  });
  await page.route('**/api/sessions/*/keys', async route => {
    inputCalls.push({ sessionId: route.request().url().split('/').at(-2)!, body: route.request().postDataJSON() });
    if (delivery === 'queue') {
      const body = route.request().postDataJSON() as SessionKeystrokeRequest;
      if (!body.keys?.includes('Enter')) {
        await route.fulfill({ json: { session } });
        return;
      }
      const queuedInput = { requestId: body.submissionId!, text: body.submittedText!, requestedAt: new Date().toISOString(),
        state: 'waiting_for_input' as const, reason: 'Waiting for the typed message to appear.' };
      session = { ...session, queuedInputs: [...session.queuedInputs ?? [], queuedInput], updatedAt: new Date(Date.now() + 1).toISOString() };
      await route.fulfill({ json: { session, queuedInput } });
      return;
    }
    await route.fulfill({ status: 409, json: { error: rejection } });
  });
  await page.route('**/api/sessions/*/queued-inputs/*', async route => {
    session = { ...session, queuedInputs: undefined, updatedAt: new Date(Date.now() + 2).toISOString() };
    await route.fulfill({ json: { session } });
  });
  await page.route('**/api/sessions/*/release', async route => {
    releaseCalls.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await page.route(`**/api/conversations/demo/${provider}/c1/bind`, async route => {
    bindCalls.push(route.request().postDataJSON());
    session = { ...session, id: 'replacement-session', updatedAt: new Date().toISOString() };
    conversation.boundSessionId = session.id;
    await route.fulfill({ json: { session } });
  });
  await page.goto(`/projects/demo/${provider}/c1`);
  await expect(page.getByRole('textbox')).toBeVisible();
  return { inputCalls, bindCalls, releaseCalls, screenSessions };
}

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider} input rejection preserves the draft and live binding without restarting or replaying`, async ({ page }) => {
    const calls = await openConversation(page, provider);
    const draft = 'keep building; here is my answer';
    const textbox = page.getByRole('textbox');
    await textbox.fill(draft);
    await textbox.press('Enter');

    await expect(page.getByText(rejection, { exact: true })).toBeVisible();
    await expect(textbox).toHaveValue(draft);
    await expect(page.getByText(draft, { exact: true }).and(page.locator(':not(textarea)'))).toHaveCount(0);
    expect(calls.inputCalls).toEqual([{ sessionId: 'original-session', body: { text: draft, keys: ['Enter'], submittedText: draft, submissionId: expect.any(String) } }]);
    expect(calls.bindCalls).toEqual([]);
    expect(calls.releaseCalls).toEqual([]);
    // Observe the next ordinary screen poll after the rejection, not just the send's immediate result.
    const priorPolls = calls.screenSessions.length;
    await expect.poll(() => calls.screenSessions.length).toBeGreaterThan(priorPolls);
    expect(calls.screenSessions.every(id => id === 'original-session')).toBe(true);
    expect(calls.inputCalls).toHaveLength(1);
    expect(calls.bindCalls).toEqual([]);

    await page.locator('aside').getByRole('link', { name: 'Demo', exact: true }).click();
    await page.locator('aside').getByRole('link', { name: /Background build/ }).click();
    await expect(textbox).toHaveValue(draft);
    expect(calls.bindCalls).toEqual([]);
    expect(calls.releaseCalls).toEqual([]);
    if (provider === 'claude') {
      await page.getByRole('button', { name: 'Conversation actions for Background build' }).click();
      await expect(page.getByRole('button', { name: 'Rebind', exact: true })).toBeDisabled();
    }
  });
}

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider} queued Text Bypass send leaves subsequent typing in a separate draft`, async ({ page }) => {
    const calls = await openConversation(page, provider, 'queue');
    const textbox = page.getByRole('textbox');
    const bypass = page.getByRole('button', { name: 'Text Bypass' });
    await bypass.click();
    await expect(bypass).toHaveAttribute('aria-pressed', 'true');
    await textbox.pressSequentially('first message');
    await textbox.press('Enter');
    await expect(page.getByText('Queued', { exact: true })).toHaveCount(1);
    await expect(bypass).toHaveAttribute('aria-pressed', 'false');
    await expect(bypass).toBeDisabled();
    const priorCalls = calls.inputCalls.length;
    await textbox.fill('second message');
    await page.waitForTimeout(100);
    expect(calls.inputCalls).toHaveLength(priorCalls);
    await textbox.press('Enter');
    await expect(page.getByText('Queued', { exact: true })).toHaveCount(2);
    expect(calls.inputCalls.slice(priorCalls)).toEqual([{ sessionId: 'original-session', body: {
      text: 'second message', submittedText: 'second message', keys: ['Enter'], submissionId: expect.any(String),
    } }]);
    await page.reload();
    await expect(page.getByText('Queued', { exact: true })).toHaveCount(2);
    await expect(bypass).toBeDisabled();
    expect(calls.bindCalls).toEqual([]);
    expect(calls.releaseCalls).toEqual([]);
  });

  test(`${provider} pending send survives browser refresh without resubmitting and can be cancelled`, async ({ page }) => {
    const calls = await openConversation(page, provider, 'queue');
    const draft = 'send this as soon as the session accepts it';
    await page.getByRole('textbox').fill(draft);
    await page.getByRole('textbox').press('Enter');
    await expect(page.getByText('Queued', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveValue('');
    await expect(page.getByText(rejection, { exact: true })).toHaveCount(0);
    expect(calls.inputCalls).toHaveLength(1);
    expect(calls.inputCalls[0]!.body.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    await page.reload();
    await expect(page.getByText('Queued', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').getByText(draft, { exact: true })).toBeVisible();
    expect(calls.inputCalls).toHaveLength(1);
    expect(calls.bindCalls).toEqual([]);
    expect(calls.releaseCalls).toEqual([]);
    await page.getByRole('button', { name: 'Cancel queued send' }).click();
    await expect(page.getByText('Queued', { exact: true })).toHaveCount(0);
    expect(calls.inputCalls).toHaveLength(1);
  });
}

test('Codex Rebind still replaces the session only when explicitly selected', async ({ page }) => {
  const calls = await openConversation(page, 'codex');
  expect(calls.bindCalls).toEqual([]);
  await page.getByRole('button', { name: 'Conversation actions for Background build' }).click();
  await page.getByRole('button', { name: 'Rebind', exact: true }).click();

  await expect.poll(() => calls.bindCalls).toEqual([{ force: true }]);
  await expect.poll(() => calls.screenSessions).toContain('replacement-session');
  expect(calls.inputCalls).toEqual([]);
});
