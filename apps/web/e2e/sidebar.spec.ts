import { expect, test, type Page } from '@playwright/test';
import type { BoundSession, ConversationSummary, ProjectSummary, TreeResponse } from '@agent-console/shared';

async function openConsole(page: Page): Promise<void> {
  const conversation: ConversationSummary = {
    ref: 'c1', provider: 'codex', projectSlug: 'demo', kind: 'history',
    title: 'Existing conversation name', updatedAt: new Date().toISOString(), isBound: true, degraded: false,
  };
  const project: ProjectSummary = {
    slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo', tags: [], allowedLocalhostPorts: [],
    providers: {
      codex: { id: 'codex', label: 'Codex', conversations: [conversation] },
      claude: { id: 'claude', label: 'Claude', conversations: [] },
    },
  };
  await page.route('**/api/auth/me', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-only' } }));
  await page.route('**/api/projects/tree', route => route.fulfill({ json: { projects: [project], boundSessions: [] } }));
  await page.route('**/api/conversations/demo/codex/c1/title', async route => {
    expect(route.request().method()).toBe('PUT');
    conversation.title = route.request().postDataJSON().title;
    await route.fulfill({ json: { conversation } });
  });
  await page.goto('/');
  await expect(page.locator('aside').getByRole('link', { name: /Existing conversation name/ })).toBeVisible();
}

async function dragSidebar(page: Page, delta: number): Promise<void> {
  const handle = await page.getByRole('separator', { name: 'Resize sidebar width' }).boundingBox();
  if (!handle) throw new Error('Sidebar resize handle is missing');
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 10 });
  await page.mouse.up();
}

test('drags the sidebar, remembers its width, and keeps the conversation pane usable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openConsole(page);
  const sidebar = page.locator('aside');
  const handle = page.getByRole('separator', { name: 'Resize sidebar width' });
  await expect(sidebar).toHaveCSS('width', '352px');

  await dragSidebar(page, 128);
  await expect(sidebar).toHaveCSS('width', '480px');
  await expect(sidebar.locator(':scope > div').first()).toHaveCSS('width', '480px');
  expect(await page.locator('main').evaluate(el => el.getBoundingClientRect().width)).toBe(960);
  await expect.poll(() => page.evaluate(() => document.body.style.userSelect)).toBe('');
  await page.reload();
  await expect(sidebar).toHaveCSS('width', '480px');

  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(sidebar).toHaveCSS('width', '496px');
  await dragSidebar(page, 600);
  await expect(sidebar).toHaveCSS('width', '640px');
  await page.setViewportSize({ width: 1024, height: 1000 });
  await expect(sidebar).toHaveCSS('width', '544px');
  expect(await page.locator('main').evaluate(el => el.getBoundingClientRect().width)).toBe(480);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(sidebar).toHaveCSS('width', '640px');

  await dragSidebar(page, -600);
  await expect(sidebar).toHaveCSS('width', '280px');
  await handle.dblclick();
  await expect(sidebar).toHaveCSS('width', '352px');
});

test('uses the full mobile viewport regardless of the saved desktop sidebar width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('agent-console:sidebar-width', '640'));
  await openConsole(page);
  await expect(page.getByRole('separator', { name: 'Resize sidebar width' })).toBeHidden();
  const bounds = await page.locator('aside').boundingBox();
  expect(bounds?.width).toBe(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('opens conversation rename empty and saves the entered name', async ({ page }) => {
  await openConsole(page);
  async function startRename(title: string): Promise<void> {
    await page.getByRole('button', { name: `Conversation actions for ${title}` }).click();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'New conversation name' })).toHaveValue('');
    await expect(page.getByRole('textbox', { name: 'New conversation name' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Save conversation title' })).toBeDisabled();
  }

  await startRename('Existing conversation name');
  await page.getByRole('textbox', { name: 'New conversation name' }).fill('Cancelled draft');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: /Existing conversation name/ })).toBeVisible();
  await startRename('Existing conversation name');
  await page.getByRole('textbox', { name: 'New conversation name' }).fill('New conversation name');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: /CODEX: New conversation name/ })).toBeVisible();
  await startRename('New conversation name');
  await page.getByRole('button', { name: 'Cancel rename' }).click();
  await page.reload();
  await expect(page.getByRole('link', { name: /CODEX: New conversation name/ })).toBeVisible();
});

test('filters to active status chats beside Work mode and remembers the choice', async ({ page }, testInfo) => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  await page.clock.install({ time: now });
  const cases: Array<{ ref: string; session?: Partial<BoundSession> }> = [
    { ref: 'Green chat', session: { lastResponseAt: ago(0.5) } },
    { ref: 'Red chat', session: { isWorking: true, lastResponseAt: ago(90) } },
    { ref: 'Yellow chat', session: { lastResponseAt: ago(12 - 10 / 3600) } },
    { ref: 'Amber chat', session: { lastResponseAt: ago(12) } },
    { ref: 'Purple chat', session: { lastResponseAt: ago(48) } },
    { ref: 'Gray chat', session: {} },
    { ref: 'Manual chat', session: { lastResponseAt: ago(0.5), manualSuspendedAt: ago(0) } },
    { ref: 'Pressure chat', session: { lastResponseAt: ago(2), pressureSuspendedAt: ago(0) } },
    { ref: 'Idle chat', session: { isWorking: true, idleSuspendedAt: ago(0) } },
    { ref: 'History chat' },
  ];
  const tree: TreeResponse = {
    projects: [{
      slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo', tags: [], allowedLocalhostPorts: [],
      providers: {
        codex: { id: 'codex', label: 'Codex', conversations: cases.filter(item => item.ref !== 'Yellow chat').map(({ ref, session }) => ({
          ref, provider: 'codex', projectSlug: 'demo', kind: 'history', title: ref,
          updatedAt: ago(0), isBound: Boolean(session), degraded: false,
        })) },
        claude: { id: 'claude', label: 'Claude', conversations: [{
          ref: 'Yellow chat', provider: 'claude', projectSlug: 'demo', kind: 'history', title: 'Yellow chat',
          updatedAt: ago(0), isBound: true, degraded: false,
        }] },
      },
    }],
    boundSessions: cases.flatMap(({ ref, session }) => session ? [{
      id: ref, provider: ref === 'Yellow chat' ? 'claude' : 'codex', projectSlug: 'demo', conversationRef: ref,
      tmuxSessionName: `fixture-${ref}`, status: 'bound', startedAt: ago(90), updatedAt: ago(0), ...session,
    }] : []),
  };
  await page.route('**/api/auth/me', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-only' } }));
  await page.route('**/api/projects/tree', route => route.fulfill({ json: tree }));
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: 'Chats' });
  const activeOnly = sidebar.getByRole('button', { name: 'Active only', exact: true });
  await expect(activeOnly).toHaveAttribute('aria-pressed', 'false');
  await expect(sidebar.getByRole('link', { name: /History chat/ })).toHaveCount(0);
  await sidebar.getByRole('button', { name: 'Work mode', exact: true }).click();
  // Browse mode caps the list until expanded.
  await sidebar.getByRole('button', { name: /Show all/ }).click();
  await expect(sidebar.getByRole('link', { name: /History chat/ })).toBeVisible();
  await activeOnly.click();
  await expect(activeOnly).toHaveAttribute('aria-pressed', 'true');
  for (const { ref } of cases) {
    await expect(sidebar.getByRole('link', { name: new RegExp(ref) })).toHaveCount(
      ['Green chat', 'Red chat', 'Yellow chat'].includes(ref) ? 1 : 0,
    );
  }
  await page.screenshot({ path: testInfo.outputPath('active-only.png') });
  await page.reload();
  await expect(activeOnly).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar.getByRole('link', { name: /Manual chat/ })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /Yellow chat/ })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(sidebar.getByRole('link', { name: /Yellow chat/ })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /Red chat/ })).toBeVisible();
  await sidebar.getByRole('button', { name: 'Work mode', exact: true }).click();
  await expect(sidebar.getByRole('link', { name: /Manual chat/ })).toHaveCount(0);
  await activeOnly.click();
  await expect(sidebar.getByRole('link', { name: /Manual chat/ })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /Amber chat/ })).toBeVisible();
});
