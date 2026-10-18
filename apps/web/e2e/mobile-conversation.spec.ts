import { expect, test, type Page } from '@playwright/test';
import type { BoundSession, ConversationSummary, NormalizedMessage, ProjectSummary, SessionKeystrokeRequest } from '@agent-console/shared';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function openMobile(page: Page, delivery: 'accepted' | 'rejected' | 'queued' = 'accepted') {
  const stamp = new Date().toISOString();
  const calls: SessionKeystrokeRequest[] = [];
  const chats: ConversationSummary[] = ['first', 'second', 'sleeping', 'history'].map(ref => ({
    ref, projectSlug: 'demo', provider: 'codex', kind: 'history', title: `${ref} conversation`,
    updatedAt: stamp, isBound: ref !== 'history', boundSessionId: ref !== 'history' ? ref : undefined, degraded: false,
  }));
  const sessions: BoundSession[] = chats.filter(chat => chat.isBound).map(chat => ({
    id: chat.ref, provider: 'codex', projectSlug: 'demo', conversationRef: chat.ref,
    tmuxSessionName: 'fixture-only', status: 'bound', startedAt: stamp, updatedAt: stamp,
    isWorking: false, ...(chat.ref === 'sleeping' ? { manualSuspendedAt: stamp } : {}),
  }));
  const projects: ProjectSummary[] = ['demo', 'empty'].map(slug => ({
    slug, directoryName: slug, displayName: slug === 'demo' ? 'Demo project' : 'Empty project',
    path: `/fixture/${slug}`, tags: [], allowedLocalhostPorts: [],
    providers: {
      codex: { id: 'codex', label: 'Codex', conversations: slug === 'demo' ? chats : [] },
      claude: { id: 'claude', label: 'Claude', conversations: [] },
    },
  }));
  const messages: NormalizedMessage[] = Array.from({ length: 30 }, (_, i) => ({
    id: `message-${i}`, role: i % 2 ? 'assistant' : 'user', provider: 'codex', lifecycle: 'durable',
    text: `${i % 2 ? 'Agent output' : 'Human question'} ${i}: ${'A paragraph of conversation that stays readable while composing a reply. '.repeat(3)}`,
    timestamp: new Date(Date.now() + i * 1000).toISOString(), conversationRef: 'first', source: 'history-file',
  }));
  await page.addInitScript(() => {
    // Exercise browsers that resize only visualViewport when the keyboard opens.
    let visibleHeight: number | undefined;
    const viewport = Object.assign(new EventTarget(), { offsetTop: 0 });
    Object.defineProperty(viewport, 'height', { get: () => visibleHeight ?? innerHeight });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.assign(window, { setKeyboardViewport(height: number, top = 0) {
      visibleHeight = height;
      viewport.offsetTop = top;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    } });
  });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-only' } }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/settings/ui-preferences', route => route.fulfill({ json: { recentActivitySortEnabled: true, manualProjectOrder: [] } }));
  await page.route('**/api/network-info', route => route.fulfill({ json: {} }));
  await page.route('**/api/projects/tree', route => route.fulfill({ json: { projects, boundSessions: sessions } }));
  await page.route('**/api/conversations/demo/codex/*/messages**', route => {
    const ref = route.request().url().split('/codex/')[1]!.split('/')[0];
    return route.fulfill({ json: { conversation: chats.find(chat => chat.ref === ref), boundSession: sessions.find(session => session.id === ref), messages, messagePage: { hasOlder: false, total: messages.length } } });
  });
  await page.route('**/api/sessions/*/screen**', route => {
    const ref = route.request().url().split('/sessions/')[1]!.split('/')[0];
    return route.fulfill({ json: { session: sessions.find(session => session.id === ref), screen: {
      content: 'Terminal details should stay out of the mobile reading view.', inputText: '', inputActive: true, capturedAt: stamp, status: 'Ready',
    } } });
  });
  await page.route('**/api/sessions/*/keys', route => {
    const body = route.request().postDataJSON() as SessionKeystrokeRequest;
    calls.push(body);
    if (delivery === 'rejected') return route.fulfill({ status: 409, json: { error: 'Fixture rejected the message; the draft is retained.' } });
    const queuedInput = delivery === 'queued' ? { requestId: body.submissionId!, requestedAt: stamp, text: body.submittedText!, state: 'queued', reason: 'Waiting for input' } : undefined;
    const session = { ...sessions[0], updatedAt: new Date().toISOString(), ...(queuedInput ? { queuedInputs: [queuedInput] } : {}) };
    sessions[0] = session;
    return route.fulfill({ json: { session, queuedInput } });
  });
  await page.goto('/projects/demo/codex/first');
  await expect(page.getByTestId('conversation-scroll')).toBeVisible();
  await expect.poll(() => page.getByTestId('conversation-scroll').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
  return { calls, appendOutput() {
    messages.push({ ...messages.at(-1)!, id: 'new-output', text: 'New agent output while you read earlier messages.' });
    sessions[0] = { ...sessions[0], updatedAt: new Date().toISOString(), lastCompletedAt: new Date(Date.now() + 60_000).toISOString() };
  } };
}

async function setKeyboard(page: Page, height: number, top = 0) {
  await page.evaluate(({ height, top }) => {
    (window as unknown as { setKeyboardViewport(height: number, top: number): void }).setKeyboardViewport(height, top);
  }, { height, top });
}

test('starts in reading mode and switches chats in a full-screen filtered list', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('agent-console:workers-open', 'true'));
  await openMobile(page);
  await expect(page.getByRole('complementary', { name: 'Active workers' })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Use high Codex profile' })).toBeHidden();
  await expect(page.getByText('Terminal details should stay out of the mobile reading view.')).toBeHidden();
  expect((await page.getByTestId('conversation-scroll').boundingBox())!.height).toBeGreaterThan(700);
  await page.screenshot({ path: testInfo.outputPath('mobile-reading.png') });
  await page.getByRole('button', { name: 'Chats', exact: true }).tap();
  const list = page.getByRole('complementary', { name: 'Chats' });
  expect((await list.boundingBox())!.width).toBe(390);
  await expect.poll(async () => (await list.boundingBox())!.x).toBe(0);
  await expect(list.locator(':scope > div').first()).toHaveCSS('background-color', 'rgb(2, 6, 23)');
  await expect(list.getByRole('heading', { name: 'Demo project' })).toBeVisible();
  await expect(list.getByRole('link', { name: /first conversation/ })).toBeVisible();
  await expect(list.getByRole('link', { name: /sleeping conversation/ })).toBeHidden();
  await expect(list.getByText('Empty project', { exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('mobile-chats.png') });
  await list.getByRole('button', { name: 'Show all', exact: true }).tap();
  await expect(list.getByRole('link', { name: /sleeping conversation/ })).toBeVisible();
  await expect(list.getByText('Empty project', { exact: true })).toBeVisible();
  await list.getByRole('link', { name: /second conversation/ }).tap();
  await expect(page).toHaveURL(/\/second$/);
  await expect(list).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeHidden();
});

test('keeps a readable scroll area above a compact reply when the keyboard opens and pans', async ({ page }, testInfo) => {
  await openMobile(page);
  await page.getByRole('button', { name: 'Reply', exact: true }).tap();
  const input = page.getByRole('textbox', { name: 'Message' });
  await expect(input).toBeFocused();
  await input.fill('A long draft.\n'.repeat(40));
  await setKeyboard(page, 400, 90);
  await expect(page.getByTestId('console-shell')).toHaveCSS('height', '400px');
  await expect(page.getByTestId('console-shell')).toHaveCSS('top', '90px');
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(88);
  const scroller = page.getByTestId('conversation-scroll');
  expect((await scroller.boundingBox())!.height).toBeGreaterThanOrEqual(170);
  const send = (await page.getByRole('button', { name: 'Send message' }).boundingBox())!;
  expect(send.y + send.height).toBeLessThanOrEqual(490);
  await scroller.evaluate(node => { node.scrollTop = 350; node.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(350);
  await setKeyboard(page, 360, 0);
  await expect(page.getByTestId('console-shell')).toHaveCSS('height', '360px');
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(350);
  await input.press('Enter');
  await expect(input).toHaveValue(/A long draft/);
  await page.screenshot({ path: testInfo.outputPath('mobile-keyboard-viewport.png') });
  await page.getByRole('button', { name: 'Close input' }).tap();
  await expect(input).toBeHidden();
  await page.getByRole('button', { name: 'Reply', exact: true }).tap();
  await expect(input).toHaveValue(/A long draft/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('keeps separate per-chat drafts and uses controls without focusing the phone keyboard', async ({ page }) => {
  const { calls } = await openMobile(page);
  await page.getByRole('button', { name: 'Reply', exact: true }).tap();
  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill('Draft for first chat');
  await page.getByRole('button', { name: 'Controls', exact: true }).tap();
  await expect(input).toBeHidden();
  await page.getByRole('button', { name: '↓', exact: true }).tap();
  await expect.poll(() => calls).toEqual([{ keys: ['Down'] }]);
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
  await page.getByRole('button', { name: 'Chats', exact: true }).tap();
  await page.getByRole('complementary', { name: 'Chats' }).getByRole('link', { name: /second conversation/ }).tap();
  await page.getByRole('button', { name: 'Reply', exact: true }).tap();
  await expect(input).toHaveValue('');
  await input.fill('Draft for second chat');
  await page.getByRole('button', { name: 'Chats', exact: true }).tap();
  await page.getByRole('complementary', { name: 'Chats' }).getByRole('link', { name: /first conversation/ }).tap();
  await page.getByRole('button', { name: 'Reply', exact: true }).tap();
  await expect(input).toHaveValue('Draft for first chat');
});

for (const delivery of ['accepted', 'queued', 'rejected'] as const) {
  test(`${delivery} reply preserves the correct draft and reading state`, async ({ page }) => {
    const { calls } = await openMobile(page, delivery);
    await page.getByRole('button', { name: 'Reply', exact: true }).tap();
    const input = page.getByRole('textbox', { name: 'Message' });
    await input.fill('My mobile reply');
    await input.press('Enter');
    expect(calls).toHaveLength(0);
    await page.getByRole('button', { name: 'Send message' }).tap();
    await expect.poll(() => calls).toHaveLength(1);
    if (delivery === 'rejected') {
      await expect(input).toHaveValue('My mobile reply\n');
      await expect(page.getByText('Fixture rejected the message; the draft is retained.')).toBeVisible();
    } else {
      await expect(input).toBeHidden();
      if (delivery === 'queued') await expect(page.getByText('1 queued message', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Reply', exact: true }).tap();
      await expect(input).toHaveValue('');
    }
  });
}

test('new chat includes projects hidden from the active list and small phones keep navigation usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openMobile(page);
  await page.getByRole('button', { name: 'Chats', exact: true }).tap();
  await page.getByRole('button', { name: 'New chat', exact: true }).tap();
  await expect(page.getByText('Empty project', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('landscape phones retain the mobile layout and leave room to read while typing', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openMobile(page);
  await expect(page.getByTestId('mobile-actions')).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).tap();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
  expect((await page.getByTestId('conversation-scroll').boundingBox())!.height).toBeGreaterThan(200);
});

test('new output does not move a reader away from earlier conversation', async ({ page }) => {
  const fixture = await openMobile(page);
  const scroller = page.getByTestId('conversation-scroll');
  await page.getByRole('button', { name: 'Reply', exact: true }).tap();
  await page.getByRole('textbox', { name: 'Message' }).fill('Reading while the agent responds');
  await scroller.evaluate(node => { node.scrollTop = 350; node.dispatchEvent(new Event('scroll')); });
  fixture.appendOutput();
  await expect(page.getByText('New agent output while you read earlier messages.')).toBeAttached();
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(350);
  await page.getByRole('button', { name: 'Close input' }).tap();
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(350);
});


test('opening Reply clears optional session details so they cannot crowd the keyboard', async ({ page }) => {
  await openMobile(page);
  await page.getByRole('button', { name: 'More options', exact: true }).tap();
  await page.getByRole('button', { name: 'Session details', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toBeHidden();
  await setKeyboard(page, 400);
  expect((await page.getByTestId('conversation-scroll').boundingBox())!.height).toBeGreaterThanOrEqual(170);
});
