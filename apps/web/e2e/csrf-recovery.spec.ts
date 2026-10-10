import { expect, test, type Page } from '@playwright/test';
import type { BoundSession, ConversationSummary, ProjectSummary, ProviderId, SessionKeystrokeRequest } from '@agent-console/shared';

type Outcome = 'recovered' | 'rejected-again' | 'refresh-failed' | 'sign-in';

async function openConversation(page: Page, provider: ProviderId, outcome: Outcome) {
  const stamp = new Date().toISOString();
  const session: BoundSession = {
    id: 'csrf-fixture', provider, projectSlug: 'demo', conversationRef: 'c1',
    tmuxSessionName: 'fixture-only', status: 'bound', shouldRestore: true,
    startedAt: stamp, updatedAt: stamp, isWorking: false,
  };
  const conversation: ConversationSummary = {
    ref: 'c1', provider, projectSlug: 'demo', kind: 'history', title: 'CSRF recovery',
    updatedAt: stamp, isBound: true, boundSessionId: session.id, degraded: false,
  };
  const project: ProjectSummary = {
    slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo', tags: [], allowedLocalhostPorts: [],
    providers: {
      codex: { id: 'codex', label: 'Codex', conversations: provider === 'codex' ? [conversation] : [] },
      claude: { id: 'claude', label: 'Claude', conversations: provider === 'claude' ? [conversation] : [] },
    },
  };
  const calls = { auth: 0, initialAuthReads: 0, navigations: 0, delivered: 0, input: [] as { token?: string; body: SessionKeystrokeRequest }[] };
  let recovering = false;
  let signedBackIn = false;
  const messages: unknown[] = [];
  page.on('request', request => {
    if (request.isNavigationRequest() && request.resourceType() === 'document' && request.frame() === page.mainFrame()) calls.navigations += 1;
  });
  await page.route('**/api/auth/me', route => {
    calls.auth += 1;
    if (!recovering) return route.fulfill({ json: { authenticated: true, csrfToken: 'old-token' } });
    if (outcome === 'refresh-failed') return route.fulfill({ status: 503, json: { error: 'Authentication refresh unavailable.' } });
    if (outcome === 'sign-in' && !signedBackIn) return route.fulfill({ json: { authenticated: false } });
    return route.fulfill({ json: { authenticated: true, csrfToken: 'new-token' } });
  });
  await page.route('**/api/auth/login', route => {
    signedBackIn = true;
    return route.fulfill({ json: { authenticated: true, csrfToken: 'new-token' } });
  });
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/settings/ui-preferences', route => route.fulfill({ json: { recentActivitySortEnabled: true, manualProjectOrder: [] } }));
  await page.route('**/api/assignment-activity**', route => route.fulfill({ status: 404, json: { error: 'Fixture has no coordination' } }));
  await page.route('**/api/projects/tree', route => route.fulfill({ json: { projects: [project], boundSessions: [session] } }));
  await page.route(`**/api/conversations/demo/${provider}/c1/messages**`, route => route.fulfill({
    json: { conversation, boundSession: session, messages, messagePage: { hasOlder: false, total: messages.length } },
  }));
  await page.route('**/api/sessions/*/screen**', route => route.fulfill({ json: { session, screen: {
    content: 'Ready', inputText: '', capturedAt: stamp,
    status: provider === 'claude' ? '⏵⏵ bypass permissions on (shift+tab to cycle)' : 'gpt-6.1-sol · 80% left',
  } } }));
  await page.route('**/api/sessions/*/keys', async route => {
    const token = route.request().headers()['x-csrf-token'];
    const body = route.request().postDataJSON() as SessionKeystrokeRequest;
    calls.input.push({ token, body });
    if (token !== 'new-token' || outcome === 'rejected-again') {
      recovering = true;
      return route.fulfill({ status: 403, json: { error: 'Invalid CSRF token.', code: 'invalid_csrf_token' } });
    }
    calls.delivered += 1;
    const recordedUserInput = { id: `submitted-${calls.delivered}`, text: body.submittedText!, timestamp: stamp };
    messages.push({ ...recordedUserInput, role: 'user', provider, conversationRef: 'c1', source: 'event-log' });
    return route.fulfill({ json: { session, recordedUserInput } });
  });
  await page.goto(`/projects/demo/${provider}/c1`);
  await expect(page.getByRole('textbox')).toBeVisible();
  calls.initialAuthReads = calls.auth;
  return calls;
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} recovers a stale CSRF token without refreshing or duplicating a chat`, async ({ page }) => {
    const calls = await openConversation(page, provider, 'recovered');
    const draft = 'Continue the authorized work';
    const textbox = page.getByRole('textbox');
    await textbox.fill(draft);
    await textbox.press('Enter');
    await expect.poll(() => calls.delivered).toBe(1);
    await expect(textbox).toHaveValue('');
    expect(calls.input).toEqual([
      { token: 'old-token', body: { text: draft, keys: ['Enter'], submittedText: draft } },
      { token: 'new-token', body: { text: draft, keys: ['Enter'], submittedText: draft } },
    ]);
    expect(calls.auth).toBe(calls.initialAuthReads + 1);
    expect(calls.navigations).toBe(1);
    await expect(page.getByText('Invalid CSRF token.', { exact: true })).toHaveCount(0);
    // A later action uses the new token without another auth refresh.
    await textbox.fill('Next instruction');
    await textbox.press('Enter');
    await expect.poll(() => calls.delivered).toBe(2);
    expect(calls.input).toHaveLength(3);
    expect(calls.input[2]?.token).toBe('new-token');
    expect(calls.auth).toBe(calls.initialAuthReads + 1);
  });
}

for (const outcome of ['rejected-again', 'refresh-failed'] as const) {
  test(`${outcome} preserves the draft and stops recovery`, async ({ page }) => {
    const calls = await openConversation(page, 'codex', outcome);
    const textbox = page.getByRole('textbox');
    await textbox.fill('Keep this draft');
    await textbox.press('Enter');
    await expect(page.getByText(outcome === 'rejected-again' ? 'Invalid CSRF token.' : 'Authentication refresh unavailable.', { exact: true })).toBeVisible();
    await expect(textbox).toHaveValue('Keep this draft');
    expect(calls.input).toHaveLength(outcome === 'rejected-again' ? 2 : 1);
    expect(calls.auth).toBe(calls.initialAuthReads + 1);
    expect(calls.delivered).toBe(0);
    expect(calls.navigations).toBe(1);
  });
}

test('sign-in recovery preserves the unsent draft without submitting it after login', async ({ page }) => {
  const calls = await openConversation(page, 'codex', 'sign-in');
  await page.getByRole('textbox').fill('Keep this draft through sign-in');
  await page.getByRole('textbox').press('Enter');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(calls.input).toHaveLength(1);
  expect(calls.delivered).toBe(0);
  await page.getByLabel('Password').fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('aside').getByRole('link', { name: /CSRF recovery/ }).click();
  await expect(page.getByRole('textbox')).toHaveValue('Keep this draft through sign-in');
  expect(calls.input).toHaveLength(1);
  expect(calls.delivered).toBe(0);
});
