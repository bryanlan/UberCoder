import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BoundSession, ConversationKind, ConversationSummary, ProjectSummary, ProviderId, SessionEvent } from '@agent-console/shared';
import { AppDatabase } from '../../server/src/db/database.js';
import { RealtimeEventBus } from '../../server/src/realtime/event-bus.js';
import { SessionManager } from '../../server/src/sessions/session-manager.js';
import { FakeTmux } from '../../server/test/helpers/session-fixtures.js';

async function openChat(page: Page, provider: ProviderId, kind: ConversationKind = 'history') {
  const stamp = new Date().toISOString();
  const ref = kind === 'pending' ? 'pending:c1' : 'c1';
  const session: BoundSession = {
    id: 'session-to-close', provider, projectSlug: 'demo', conversationRef: ref,
    tmuxSessionName: 'fixture-only', status: 'bound', shouldRestore: true,
    startedAt: stamp, updatedAt: stamp, isWorking: false,
  };
  const conversation: ConversationSummary = {
    ref, provider, projectSlug: 'demo', kind, title: 'Chat to close',
    updatedAt: stamp, isBound: true, boundSessionId: session.id, degraded: false,
  };
  const project: ProjectSummary = {
    slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo', tags: [], allowedLocalhostPorts: [],
    providers: {
      codex: { id: 'codex', label: 'Codex', conversations: provider === 'codex' ? [conversation] : [] },
      claude: { id: 'claude', label: 'Claude', conversations: provider === 'claude' ? [conversation] : [] },
    },
  };
  const calls = { releases: 0, binds: 0 };
  await page.route('**/api/auth/me', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-only' } }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/settings/ui-preferences', route => route.fulfill({ json: { recentActivitySortEnabled: true, manualProjectOrder: [] } }));
  await page.route('**/api/projects/tree', route => route.fulfill({ json: {
    projects: [project], boundSessions: conversation.isBound ? [session] : [],
  } }));
  await page.route(`**/api/conversations/demo/${provider}/*/messages**`, route => route.fulfill({ json: {
    conversation, boundSession: conversation.isBound ? session : undefined,
    messages: [], messagePage: { hasOlder: false, total: 0 },
  } }));
  await page.route('**/api/sessions/*/screen**', route => route.fulfill({ json: { session, screen: {
    content: '', inputText: '', capturedAt: stamp, status: 'Ready',
  } } }));
  await page.route('**/api/conversations/**/bind', route => {
    calls.binds += 1;
    return route.fulfill({ status: 500, json: { error: 'Unexpected bind' } });
  });
  await page.route('**/api/sessions/*/release', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().url()).toContain('/api/sessions/session-to-close/release');
    expect(route.request().headers()['x-csrf-token']).toBe('fixture-only');
    calls.releases += 1;
    conversation.isBound = false;
    conversation.boundSessionId = undefined;
    conversation.lastClosedAt = new Date().toISOString();
    await route.fulfill({ status: 204 });
  });
  const chatPath = `/projects/demo/${provider}/${encodeURIComponent(ref)}`;
  await page.goto(chatPath);
  await expect(page.locator('aside').getByRole('link', { name: /Chat to close/ })).toBeVisible();
  return { calls, chatPath, session, conversation };
}

async function closeChat(page: Page) {
  await page.getByRole('button', { name: 'Conversation actions for Chat to close' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}

for (const width of [1280, 390]) {
  test(`closed Claude chats resume without terminal handoff at ${width}px`, async ({ page }, testInfo) => {
    const { calls, chatPath, session, conversation } = await openChat(page, 'claude');
    await closeChat(page);
    await expect(page).toHaveURL(/\/projects\/demo$/);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(chatPath);
    await expect(page.getByText('This conversation is closed. Resume it to continue in Agent Console.')).toBeVisible();
    await expect(page.getByText(/outside Agent Console|original terminal/)).toHaveCount(0);
    expect(calls.binds).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`closed-claude-${width}.png`) });
    await page.route('**/api/conversations/**/bind', route => {
      calls.binds += 1;
      expect(route.request().postDataJSON()).toEqual({ force: false });
      conversation.isBound = true;
      conversation.boundSessionId = session.id;
      return route.fulfill({ json: { session } });
    });
    await page.getByRole('button', { name: 'Resume', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('This conversation is closed. Resume it to continue in Agent Console.')).toHaveCount(0);
    expect(calls.binds).toBe(1);
  });
}

for (const provider of ['codex', 'claude'] as const) {
  for (const kind of ['history', 'pending'] as const) {
    test(`Close unloads a ${provider} ${kind} chat from Work and keeps it in Browse`, async ({ page }) => {
      const { calls } = await openChat(page, provider, kind);
      await closeChat(page);
      await expect(page).toHaveURL(/\/projects\/demo$/);
      await expect(page.locator('aside').getByRole('link', { name: /Chat to close/ })).toHaveCount(0);
      await expect(page.getByText('No active conversations.')).toBeVisible();
      expect(calls.releases).toBe(1);
      expect(calls.binds).toBe(0);

      await page.getByRole('button', { name: 'Work mode', exact: true }).click();
      await expect(page.locator('aside').getByRole('link', { name: /Chat to close/ })).toBeVisible();
      await page.getByRole('button', { name: 'Conversation actions for Chat to close' }).click();
      await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
      await page.reload();
      await expect(page.locator('aside').getByRole('link', { name: /Chat to close/ })).toBeVisible();
      expect(calls.binds).toBe(0);
    });
  }
}

test('Close preserves Browse mode and the current view for a background chat', async ({ page }) => {
  const { calls } = await openChat(page, 'claude');
  await page.getByRole('button', { name: 'Work mode', exact: true }).click();
  await page.locator('aside').getByRole('link', { name: 'Demo', exact: true }).click();
  await closeChat(page);
  await expect(page).toHaveURL(/\/projects\/demo$/);
  await expect(page.locator('aside').getByRole('link', { name: /Chat to close/ })).toBeVisible();
  await page.getByRole('button', { name: 'Conversation actions for Chat to close' }).click();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  expect(calls.releases).toBe(1);
});

for (const failure of ['kill', 'liveness'] as const) {
  test(`a real ${failure} failure keeps Close available and the chat selected`, async ({ page }) => {
    await page.addInitScript(() => {
      class FixtureEventSource {
        onmessage: ((event: MessageEvent) => void) | null = null;
        private readonly listener = (event: Event) => {
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify((event as CustomEvent).detail) }));
        };
        constructor() { window.addEventListener('close-fixture-event', this.listener); }
        close() { window.removeEventListener('close-fixture-event', this.listener); }
      }
      window.EventSource = FixtureEventSource as unknown as typeof EventSource;
    });
    const { chatPath, session } = await openChat(page, 'codex');
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-close-failure-'));
    const db = new AppDatabase(path.join(fixtureDir, 'private.sqlite'));
    const tmux = new FakeTmux();
    tmux.alive.add(session.tmuxSessionName);
    if (failure === 'kill') tmux.failKill = true;
    else tmux.hasSessionResults.push(new Error('Fixture tmux unavailable'));
    const events: SessionEvent[] = [];
    const bus = new RealtimeEventBus();
    const unsubscribe = bus.subscribe(event => events.push(event));
    db.boundSessions.upsert(session);
    const manager = new SessionManager(db, tmux, path.join(fixtureDir, 'runtime'), bus);
    let releaseError = '';
    try {
      await page.route('**/api/sessions/*/release', async route => {
        try {
          await manager.releaseSession(session.id);
          await route.fulfill({ status: 204 });
        } catch (error) {
          releaseError = (error as Error).message;
          for (const event of events) {
            await page.evaluate(value => window.dispatchEvent(new CustomEvent('close-fixture-event', { detail: value })), event);
          }
          await route.fulfill({ status: 500, json: { error: releaseError } });
        }
      });
      await closeChat(page);
      await expect.poll(() => releaseError).not.toBe('');
      await expect(page.getByText(releaseError, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${chatPath}$`));
      await expect(page.locator('aside').getByRole('link', { name: /Chat to close/ })).toBeVisible();
      await page.getByRole('button', { name: 'Conversation actions for Chat to close' }).click();
      await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
      expect(db.boundSessions.getById(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
      expect(db.boundSessions.listTreeVisible().map(item => item.id)).toContain(session.id);
      expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
      const statuses = events.filter(event => event.type === 'session.updated').map(event => event.session.status);
      const releaseStartedAt = statuses.indexOf('releasing');
      // Queue cancellation can publish the still-bound session before release starts.
      expect(statuses.slice(0, releaseStartedAt).every(status => status === 'bound')).toBe(true);
      expect(statuses.slice(releaseStartedAt)).toEqual(['releasing', 'bound']);
    } finally {
      unsubscribe();
      await manager.stop();
      db.close();
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });
}

for (const { kind, routeRef } of [
  { kind: 'history', routeRef: 'c1/' },
  { kind: 'history', routeRef: 'c%31' },
  { kind: 'pending', routeRef: 'pending:c1' },
] as const) {
  test(`Close recognizes the selected chat at equivalent URL ${routeRef}`, async ({ page }) => {
    await openChat(page, 'codex', kind);
    await page.goto(`/projects/demo/codex/${routeRef}`);
    await expect(page.locator('aside').getByRole('link', { name: /Chat to close/ })).toBeVisible();
    await closeChat(page);
    await expect(page).toHaveURL(/\/projects\/demo$/);
    await expect(page.locator('aside').getByRole('link', { name: /Chat to close/ })).toHaveCount(0);
  });
}

test('finishing Close preserves navigation made while release is pending', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agent-console:mobile-chrome-hidden:v2', 'false'));
  await openChat(page, 'codex');
  let finishRelease!: () => void;
  const releaseGate = new Promise<void>(resolve => { finishRelease = resolve; });
  await page.route('**/api/sessions/*/release', async route => {
    await releaseGate;
    await route.fallback();
  });
  const releaseRequest = page.waitForRequest('**/api/sessions/*/release');
  await closeChat(page);
  await releaseRequest;
  await page.getByRole('button', { name: 'Conversation actions for Chat to close' }).click();
  await expect(page.getByRole('button', { name: 'Closing…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Rebind', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Conversation actions for Chat to close' }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const released = page.waitForResponse('**/api/sessions/*/release');
  finishRelease();
  await released;
  await expect(page.locator('aside').getByRole('link', { name: /Chat to close/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings$/);
});
