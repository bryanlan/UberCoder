import { expect, test, type Page } from '@playwright/test';
import type { BoundSession, ConversationSummary, ProjectSummary, ProviderId } from '@agent-console/shared';

async function openConversation(page: Page, provider: ProviderId, unavailable = false) {
  const stamp = new Date().toISOString();
  const session: BoundSession = { id: 'current-session', provider, projectSlug: 'demo', conversationRef: 'current',
    tmuxSessionName: 'fixture-only', status: 'bound', shouldRestore: true, startedAt: stamp, updatedAt: stamp };
  const current: ConversationSummary = { ref: 'current', provider, projectSlug: 'demo', kind: 'history',
    title: 'Current chat', updatedAt: stamp, isBound: true, boundSessionId: session.id, degraded: false };
  const peerProvider = provider === 'codex' ? 'claude' : 'codex';
  const peer: ConversationSummary = { ...current, ref: 'peer', projectSlug: 'peer-project', provider: peerProvider, title: 'Review helper' };
  function project(slug: string, conversation: ConversationSummary): ProjectSummary {
    return { slug, directoryName: slug, displayName: slug, path: `/fixture/${slug}`, tags: [], allowedLocalhostPorts: [],
      providers: { codex: { id: 'codex', label: 'Codex', conversations: conversation.provider === 'codex' ? [conversation] : [] },
        claude: { id: 'claude', label: 'Claude', conversations: conversation.provider === 'claude' ? [conversation] : [] } } };
  }
  const inputCalls: unknown[] = [];
  const lookups: string[] = [];
  await page.route('**/api/auth/me', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-only' } }));
  await page.route('**/api/projects/tree', route => route.fulfill({ json: { projects: [project('demo', current), project('peer-project', peer)], boundSessions: [session] } }));
  await page.route(`**/api/conversations/demo/${provider}/current/messages**`, route => route.fulfill({ json: {
    conversation: current, boundSession: session, messages: [], messagePage: { hasOlder: false, total: 0 },
  } }));
  await page.route('**/api/sessions/current-session/screen**', route => route.fulfill({ json: { session, screen: {
    content: '', inputText: '', inputActive: true, capturedAt: stamp, status: 'Ready',
  } } }));
  await page.route('**/api/sessions/*/keys', route => {
    inputCalls.push(route.request().postDataJSON());
    return route.fulfill({ json: { session } });
  });
  await page.route('**/api/agent-reference?**', route => {
    lookups.push(route.request().url());
    return route.fulfill(unavailable ? { status: 409, json: { error: 'This chat has no connected agent.' } } : { json: {
      recipientId: 'a06ad31c-168d-4bdd-83fd-1c71d2d39728', provider: peer.provider, projectSlug: peer.projectSlug,
      conversationRef: peer.ref, title: peer.title,
    } });
  });
  await page.route('**/api/search/conversations?**', route => route.fulfill({ json: { query: 'Review', results: [{
    projectSlug: peer.projectSlug, projectDisplayName: 'Peer project', provider: peer.provider, conversationRef: peer.ref,
    conversationKind: 'history', conversationTitle: peer.title, conversationUpdatedAt: stamp, isBound: true,
    role: 'assistant', timestamp: stamp, snippet: 'Review fixture', score: 1, recencyBucket: '0-5-days',
  }] } }));
  await page.goto(`/projects/demo/${provider}/current`);
  await expect(page.getByRole('textbox')).toBeVisible();
  return { inputCalls, lookups, peer };
}

for (const provider of ['codex', 'claude'] as const) {
  test(`native sidebar drag inserts a cross-project agent into the ${provider} draft`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const calls = await openConversation(page, provider);
    const textbox = page.locator('textarea');
    await textbox.fill('Please coordinate with');
    await page.locator('aside').getByRole('link', { name: /Review helper/ }).dragTo(textbox);
    await expect(textbox).toHaveValue(/Please coordinate with\n\[Agent "Review helper".*recipientId=a06ad31c-168d-4bdd-83fd-1c71d2d39728\]\n/);
    expect(calls.inputCalls).toEqual([]);
    expect(calls.lookups).toHaveLength(1);
    const lookup = new URL(calls.lookups[0]!);
    expect(Object.fromEntries(lookup.searchParams)).toEqual({ projectSlug: calls.peer.projectSlug, provider: calls.peer.provider, conversationRef: calls.peer.ref });
    await expect(page).toHaveURL(new RegExp(`/demo/${provider}/current$`));
    await textbox.press('Enter');
    await expect.poll(() => calls.inputCalls.length).toBe(1);
    expect(calls.inputCalls[0]).toMatchObject({ text: expect.stringContaining('recipientId=a06ad31c-168d-4bdd-83fd-1c71d2d39728'), keys: ['Enter'] });
  });
}

test('a native search-result drag preserves the draft when the peer is unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await openConversation(page, 'codex', true);
  const textbox = page.locator('textarea');
  await textbox.fill('Keep my draft');
  await page.getByPlaceholder('Search all chats').fill('Review');
  await page.getByPlaceholder('Search all chats').press('Enter');
  await expect(page.getByText('Peer project', { exact: true })).toBeVisible();
  await page.locator('aside').getByRole('link', { name: /Review helper/ }).dragTo(textbox);
  await expect(page.getByRole('alert')).toHaveText('This chat has no connected agent.');
  await expect(textbox).toHaveValue('Keep my draft');
  expect(calls.inputCalls).toEqual([]);
});
