import { expect, test, type Page } from '@playwright/test';
import type { BoundSession, ConversationSummary, ProjectSummary, StartConversationResponse } from '@agent-console/shared';

const stamp = new Date().toISOString();
const warning = 'Routing was unavailable, so Codex at Medium took this chat.';

function fixtures(started: boolean) {
  const session: BoundSession = {
    id: 'start-fixture', provider: 'grok', projectSlug: 'demo', conversationRef: 'c2', tmuxSessionName: 'fixture-only',
    transport: 'structured', status: 'bound', shouldRestore: true, startedAt: stamp, updatedAt: stamp, isWorking: false,
    grokProfile: 'auto',
  };
  const conversation: ConversationSummary = {
    ref: 'c2', provider: 'grok', projectSlug: 'demo', kind: 'history', title: 'Fix the login bug',
    updatedAt: stamp, isBound: true, boundSessionId: session.id, degraded: false,
  };
  const project: ProjectSummary = {
    slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo', tags: [], allowedLocalhostPorts: [],
    providers: {
      codex: { id: 'codex', label: 'Codex', conversations: [] },
      claude: { id: 'claude', label: 'Claude', conversations: [] },
      grok: { id: 'grok', label: 'Grok', conversations: started ? [conversation] : [] },
    },
  };
  return { session, conversation, project };
}

async function openConsole(page: Page, structuredProviders: string[]) {
  const calls = { starts: [] as { token?: string; body: { prompt: string } }[] };
  let started = false;
  await page.route('**/api/auth/me', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-only' } }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/settings/ui-preferences', route => route.fulfill({ json: { recentActivitySortEnabled: false, manualProjectOrder: [] } }));
  await page.route('**/api/assignment-activity**', route => route.fulfill({ status: 404, json: { error: 'Fixture has no coordination' } }));
  await page.route('**/api/projects/tree', route => {
    const { project, session } = fixtures(started);
    return route.fulfill({ json: { projects: [project], boundSessions: started ? [session] : [], structuredProviders } });
  });
  await page.route('**/api/conversations/demo/grok/c2/messages**', route => {
    const { conversation, session } = fixtures(true);
    return route.fulfill({ json: { conversation, boundSession: session, messages: [], messagePage: { hasOlder: false, total: 0 } } });
  });
  await page.route('**/api/conversations/demo/start', route => {
    const { session } = fixtures(true);
    calls.starts.push({ token: route.request().headers()['x-csrf-token'], body: route.request().postDataJSON() });
    started = true;
    const answer: StartConversationResponse = { session, conversationRef: 'c2', provider: 'grok', warning };
    return route.fulfill({ json: answer });
  });
  await page.goto('/');
  await expect(page.locator('aside').getByRole('link', { name: 'Demo' })).toBeVisible();
  return calls;
}

test('Start sends the first prompt, opens the chat the server routed it to and shows the routing warning', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await openConsole(page, ['codex', 'claude', 'grok']);
  const sidebar = page.locator('aside');

  await sidebar.getByRole('button', { name: 'Project actions for Demo' }).click();
  await sidebar.getByRole('button', { name: 'Start a chat (agent picked for you)' }).click();
  await sidebar.getByRole('textbox', { name: 'First message for Demo' }).fill('Fix the login bug');
  await sidebar.getByRole('button', { name: 'Send' }).click();

  await expect(page).toHaveURL(/\/projects\/demo\/grok\/c2$/);
  expect(calls.starts).toEqual([{ token: 'fixture-only', body: { prompt: 'Fix the login bug' } }]);
  await expect(page.getByTestId('start-warning')).toHaveText(warning);
  await expect(page.getByText('ACP', { exact: true })).toBeVisible();
  await expect(sidebar.getByTestId('start-composer')).toHaveCount(0);

  await page.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(page.getByTestId('start-warning')).toHaveCount(0);
});

test('Start is not offered when no structured provider is enabled', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openConsole(page, []);
  const sidebar = page.locator('aside');

  await sidebar.getByRole('button', { name: 'Project actions for Demo' }).click();

  await expect(sidebar.getByRole('button', { name: 'New Codex conversation' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Start a chat (agent picked for you)' })).toHaveCount(0);
});
