import { expect, test, type Page } from '@playwright/test';
import type { BoundSession, ConversationSummary, ProjectSummary, ProviderId, SessionKeystrokeRequest } from '@agent-console/shared';

const rejection = 'Live session did not accept the typed text into its input buffer. The draft was not submitted.';

async function openConversation(page: Page, provider: ProviderId, nativeMenu = false) {
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
      content: nativeMenu ? 'Select model\n❯ 2. Opus 5.5\nEnter to confirm · Esc to cancel' : 'Three background agents are building.',
      inputText: '', inputActive: !nativeMenu, capturedAt: stamp,
      status: provider === 'claude' ? '⏵⏵ bypass permissions on (shift+tab to cycle)' : 'gpt-6.1-sol · 80% left',
    } } });
  });
  await page.route('**/api/sessions/*/keys', async route => {
    const body = route.request().postDataJSON() as SessionKeystrokeRequest;
    inputCalls.push({ sessionId: route.request().url().split('/').at(-2)!, body });
    if (nativeMenu && !body.text && !body.submittedText && !body.imageIds) {
      return route.fulfill({ json: { session } });
    }
    await route.fulfill({ status: 409, json: { error: rejection } });
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
    expect(calls.inputCalls).toEqual([{ sessionId: 'original-session', body: { text: draft, keys: ['Enter'], submittedText: draft } }]);
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

test('Codex Rebind still replaces the session only when explicitly selected', async ({ page }) => {
  const calls = await openConversation(page, 'codex');
  expect(calls.bindCalls).toEqual([]);
  await page.getByRole('button', { name: 'Conversation actions for Background build' }).click();
  await page.getByRole('button', { name: 'Rebind', exact: true }).click();

  await expect.poll(() => calls.bindCalls).toEqual([{ force: true }]);
  await expect.poll(() => calls.screenSessions).toContain('replacement-session');
  expect(calls.inputCalls).toEqual([]);
});

test.describe('mobile live input', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('native menu buttons preserve a draft, and oversized input can shrink by touch', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('agent-console:live-bridge-height', '600'));
    const calls = await openConversation(page, 'claude', true);
    await page.locator('aside').getByRole('link', { name: /Background build/ }).tap();
    const textbox = page.getByRole('textbox');
    const draft = 'Switching to Fable for the plan review';
    await textbox.fill(draft);
    const initialHeight = await textbox.evaluate(node => node.getBoundingClientRect().height);
    expect(initialHeight).toBeLessThanOrEqual(844 * 0.3);
    await page.getByRole('button', { name: '↓', exact: true }).tap();
    await expect.poll(() => calls.inputCalls).toEqual([{ sessionId: 'original-session', body: { keys: ['Down'] } }]);
    await page.getByRole('button', { name: 'Enter', exact: true }).tap();
    await expect.poll(() => calls.inputCalls).toHaveLength(2);
    expect(calls.inputCalls[1].body).toEqual({ keys: ['Enter'] });
    await page.getByRole('button', { name: 'Esc', exact: true }).tap();
    await expect.poll(() => calls.inputCalls).toHaveLength(3);
    expect(calls.inputCalls[2].body).toEqual({ keys: ['Escape'] });
    await expect(textbox).toHaveValue(draft);
    await page.getByRole('button', { name: 'Reset input height' }).tap();
    await expect(textbox).toHaveCSS('height', '96px');
    await expect(textbox).toHaveValue(draft);
    // Raw CDP touch drags suppress the next synthesized compatibility click
    // even on plain HTML buttons. Verify the native reset tap before dragging.
    const handle = page.getByRole('button', { name: 'Resize live input bridge' });
    await handle.scrollIntoViewIfNeeded();
    const handleBox = await handle.boundingBox();
    expect(handleBox!.height).toBeGreaterThanOrEqual(44);
    const cdp = await page.context().newCDPSession(page);
    const point = { x: handleBox!.x + handleBox!.width / 2, y: handleBox!.y + handleBox!.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y - 80 }] });
    await expect.poll(() => textbox.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(96);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + 60 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('');
    await expect(textbox).toHaveCSS('height', '96px');
    await cdp.detach();
    await expect(textbox).toHaveValue(draft);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('agent-console:live-bridge-height'))).toBe('96');
    expect(calls.bindCalls).toEqual([]);
    expect(calls.releaseCalls).toEqual([]);
    await page.screenshot({ path: '/tmp/console-input-mobile-20261013.png', fullPage: true });
  });
});
