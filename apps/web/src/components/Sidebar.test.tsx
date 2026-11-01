import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BoundSession, TreeResponse } from '@agent-console/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

afterEach(() => vi.restoreAllMocks());

const now = Date.parse('2026-09-27T23:00:00.000Z');
const cases = (['manualSuspendedAt', 'pressureSuspendedAt', 'idleSuspendedAt'] as const).flatMap((marker) => (
  [
    { hours: 0.5, color: 'bg-emerald-400' },
    { hours: 2, color: 'bg-yellow-400' },
    { hours: 24, color: 'bg-amber-500' },
    { hours: 72, color: 'bg-violet-500' },
  ].map((age) => ({ marker, ...age }))
));

it.each([
  { workMode: true, activeOnly: false },
  { workMode: false, activeOnly: true },
])('keeps a project and its new-conversation actions after its last child is evicted with Work mode $workMode and Active only $activeOnly', async ({ workMode, activeOnly }) => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const tree: TreeResponse = {
    boundSessions: [{
      id: 'session-1', provider: 'codex', projectSlug: 'demo', conversationRef: 'conversation-1',
      tmuxSessionName: 'fixture-only', status: 'bound', transport: 'tmux',
      startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      lastResponseAt: new Date(now).toISOString(),
    }],
    projects: [{
      slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo',
      tags: [], allowedLocalhostPorts: [],
      providers: {
        codex: { id: 'codex', label: 'Codex', conversations: [{
          ref: 'conversation-1', projectSlug: 'demo', provider: 'codex',
          kind: 'history', title: 'Last active conversation', updatedAt: new Date(now).toISOString(),
          isBound: true, degraded: false,
        }] },
        claude: { id: 'claude', label: 'Claude', conversations: [] },
        grok: { id: 'grok', label: 'Grok', conversations: [] },
      },
    }],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['network-info'], {});
  const onNewConversation = vi.fn();
  const renderSidebar = (currentTree: TreeResponse) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Sidebar
          tree={currentTree} open workMode={workMode} activeOnly={activeOnly} onToggleActiveOnly={() => {}} recentActivitySortEnabled={false} manualProjectOrder={[]}
          onClose={() => {}} onToggleWorkMode={() => {}} onNewConversation={onNewConversation} onStartConversation={async () => true}
          onToggleRecentActivity={async () => {}} onReorderProjects={async () => {}}
          onRenameProject={async () => true} onRebindConversation={async () => true}
          onRenameConversation={async () => true} updatingUiPreferences={false}
          onCloseConversation={async () => true}
          onRefresh={() => {}} refreshing={false}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(renderSidebar(tree));
  expect(screen.getByRole('link', { name: /Last active conversation/ })).toBeInTheDocument();

  const evictedTree: TreeResponse = {
    ...tree,
    projects: tree.projects.map((project) => ({
      ...project,
      providers: {
        ...project.providers,
        codex: {
          ...project.providers.codex,
          conversations: project.providers.codex.conversations.map((conversation) => ({ ...conversation, isBound: false })),
        },
      },
    })),
  };
  view.rerender(renderSidebar(evictedTree));

  expect(screen.getByRole('link', { name: 'Demo' })).toHaveAttribute('href', '/projects/demo');
  expect(screen.queryByRole('link', { name: /Last active conversation/ })).not.toBeInTheDocument();
  expect(screen.getByText('No active conversations.')).toBeInTheDocument();
  expect(screen.queryByText('No conversations indexed yet.')).not.toBeInTheDocument();

  const user = userEvent.setup();
  for (const provider of ['Codex', 'Claude']) {
    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));
    await user.click(screen.getByRole('button', { name: `New ${provider} conversation` }));
    expect(onNewConversation).toHaveBeenLastCalledWith('demo', provider.toLowerCase());
  }
});

it.each(cases)('preserves $color for a $marker session with a $hours-hour-old response', ({ marker, hours, color }) => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const responseAt = new Date(now - hours * 60 * 60 * 1000).toISOString();
  const session: BoundSession = {
    id: 'session-1', provider: 'codex', projectSlug: 'demo', conversationRef: 'conversation-1',
    tmuxSessionName: 'ac-codex-demo', status: 'bound', shouldRestore: true,
    transport: 'tmux',
    startedAt: responseAt, updatedAt: new Date(now).toISOString(),
    lastResponseAt: responseAt, lastActivityAt: responseAt, isWorking: false,
    [marker]: new Date(now).toISOString(),
  };
  const tree: TreeResponse = {
    boundSessions: [session],
    projects: [{
      slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo',
      tags: [], allowedLocalhostPorts: [],
      providers: {
        codex: { id: 'codex', label: 'Codex', conversations: [{
          ref: session.conversationRef, projectSlug: 'demo', provider: 'codex',
          kind: 'history', title: 'Resume this conversation', updatedAt: responseAt,
          isBound: true, degraded: false,
        }] },
        claude: { id: 'claude', label: 'Claude', conversations: [] },
        grok: { id: 'grok', label: 'Grok', conversations: [] },
      },
    }],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['network-info'], {});
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Sidebar
          tree={tree} open workMode activeOnly={false} onToggleActiveOnly={() => {}} recentActivitySortEnabled={false} manualProjectOrder={[]}
          onClose={() => {}} onToggleWorkMode={() => {}} onNewConversation={() => {}} onStartConversation={async () => true}
          onToggleRecentActivity={async () => {}} onReorderProjects={async () => {}}
          onRenameProject={async () => true} onRebindConversation={async () => true}
          onRenameConversation={async () => true} updatingUiPreferences={false}
          onCloseConversation={async () => true}
          onRefresh={() => {}} refreshing={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const row = screen.getByRole('link', { name: /Resume this conversation/ });
  const dot = within(row).getByTitle(/Ready for you · response/);
  expect(dot).toHaveClass(color);
  expect(dot).not.toHaveClass('bg-transparent');
  expect(dot).toHaveAttribute('title', expect.stringContaining('select to resume'));
  expect(within(row).getByText('Suspended')).toBeInTheDocument();
});

describe('structured New Chat option', () => {
  function treeWith(structuredProviders?: TreeResponse['structuredProviders']): TreeResponse {
    return {
      boundSessions: [],
      ...(structuredProviders ? { structuredProviders } : {}),
      projects: [{
        slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo',
        tags: [], allowedLocalhostPorts: [],
        providers: {
          codex: { id: 'codex', label: 'Codex', conversations: [] },
          claude: { id: 'claude', label: 'Claude', conversations: [] },
          grok: { id: 'grok', label: 'Grok', conversations: [] },
        },
      }],
    };
  }

  function renderSidebar(tree: TreeResponse, onNewConversation = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['network-info'], {});
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Sidebar
            tree={tree} open workMode activeOnly={false} onToggleActiveOnly={() => {}} recentActivitySortEnabled={false} manualProjectOrder={[]}
            onClose={() => {}} onToggleWorkMode={() => {}} onNewConversation={onNewConversation} onStartConversation={async () => true}
            onToggleRecentActivity={async () => {}} onReorderProjects={async () => {}}
            onRenameProject={async () => true} onRebindConversation={async () => true}
            onRenameConversation={async () => true} updatingUiPreferences={false}
            onCloseConversation={async () => true}
            onRefresh={() => {}} refreshing={false}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return onNewConversation;
  }

  async function openProjectMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));
  }

  it('offers Codex (app-server) beside the unchanged terminal actions when the tree advertises codex', async () => {
    const onNewConversation = renderSidebar(treeWith(['codex']));
    const user = userEvent.setup();

    await openProjectMenu(user);
    expect(screen.getByRole('button', { name: 'New Codex conversation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Claude conversation' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Codex (app-server)' }));
    expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'codex', { transport: 'structured' });

    await openProjectMenu(user);
    await user.click(screen.getByRole('button', { name: 'New Codex conversation' }));
    expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'codex');
  });

  it('offers Claude (headless) only when the tree advertises claude, and creates it with the structured transport', async () => {
    const onNewConversation = renderSidebar(treeWith(['claude']));
    const user = userEvent.setup();

    await openProjectMenu(user);
    expect(screen.queryByRole('button', { name: 'Codex (app-server)' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Claude (headless)' }));
    expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'claude', { transport: 'structured' });
  });

  it('adds Claude (headless) to the mobile new-chat picker beside Codex (app-server) when both are advertised', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      const user = userEvent.setup();
      const onNewConversation = renderSidebar(treeWith(['codex', 'claude']));
      await user.click(screen.getByRole('button', { name: 'New chat' }));
      expect(screen.getByRole('button', { name: 'Codex (app-server)' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Claude (headless)' }));
      expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'claude', { transport: 'structured' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers Grok (ACP) only when the tree advertises grok, and creates it with the structured transport', async () => {
    const onNewConversation = renderSidebar(treeWith(['grok']));
    const user = userEvent.setup();

    await openProjectMenu(user);
    expect(screen.queryByRole('button', { name: 'Codex (app-server)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claude (headless)' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Grok (ACP)' }));
    expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'grok', { transport: 'structured' });
  });

  it.each([
    ['an absent list', undefined],
    ['an empty list', []],
    ['a list without grok', ['codex', 'claude'] as TreeResponse['structuredProviders']],
  ])('hides Grok (ACP) and has no terminal Grok chat for %s', async (_name, structuredProviders) => {
    renderSidebar(treeWith(structuredProviders));
    const user = userEvent.setup();

    await openProjectMenu(user);

    expect(screen.queryByRole('button', { name: 'Grok (ACP)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Grok/ })).not.toBeInTheDocument();
  });

  it('adds Grok (ACP) to the mobile new-chat picker without a terminal Grok button', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      const user = userEvent.setup();
      const onNewConversation = renderSidebar(treeWith(['codex', 'claude', 'grok']));
      await user.click(screen.getByRole('button', { name: 'New chat' }));
      expect(screen.queryByRole('button', { name: 'Grok' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Grok (ACP)' }));
      expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'grok', { transport: 'structured' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['an absent list', undefined],
    ['an empty list', []],
    ['a list without codex', ['claude'] as TreeResponse['structuredProviders']],
  ])('hides Codex (app-server) for %s', async (_name, structuredProviders) => {
    renderSidebar(treeWith(structuredProviders));
    const user = userEvent.setup();

    await openProjectMenu(user);

    expect(screen.getByRole('button', { name: 'New Codex conversation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Codex (app-server)' })).not.toBeInTheDocument();
  });

  it('adds the option to the mobile new-chat picker only when advertised', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      const user = userEvent.setup();
      const onNewConversation = renderSidebar(treeWith(['codex']));
      await user.click(screen.getByRole('button', { name: 'New chat' }));
      expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Codex (app-server)' }));
      expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'codex', { transport: 'structured' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the mobile new-chat picker to the two terminal providers when nothing is advertised', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      const user = userEvent.setup();
      renderSidebar(treeWith());
      await user.click(screen.getByRole('button', { name: 'New chat' }));
      expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Codex (app-server)' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Start (provider-neutral new chat)', () => {
  const startLabel = 'Start a chat (agent picked for you)';

  function treeWith(structuredProviders?: TreeResponse['structuredProviders']): TreeResponse {
    return {
      boundSessions: [],
      ...(structuredProviders ? { structuredProviders } : {}),
      projects: [{
        slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo',
        tags: [], allowedLocalhostPorts: [],
        providers: {
          codex: { id: 'codex', label: 'Codex', conversations: [] },
          claude: { id: 'claude', label: 'Claude', conversations: [] },
          grok: { id: 'grok', label: 'Grok', conversations: [] },
        },
      }],
    };
  }

  function sidebarElement(tree: TreeResponse, props: { onStartConversation?: (projectSlug: string, prompt: string) => Promise<boolean>; creatingConversationKey?: string; onClose?: () => void } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['network-info'], {});
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Sidebar
            tree={tree} open workMode activeOnly={false} onToggleActiveOnly={() => {}} recentActivitySortEnabled={false} manualProjectOrder={[]}
            onClose={props.onClose ?? (() => {})} onToggleWorkMode={() => {}} onNewConversation={() => {}}
            onStartConversation={props.onStartConversation ?? (async () => true)}
            creatingConversationKey={props.creatingConversationKey}
            onToggleRecentActivity={async () => {}} onReorderProjects={async () => {}}
            onRenameProject={async () => true} onRebindConversation={async () => true}
            onRenameConversation={async () => true} updatingUiPreferences={false}
            onCloseConversation={async () => true}
            onRefresh={() => {}} refreshing={false}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  async function openStartBox(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));
    await user.click(screen.getByRole('button', { name: startLabel }));
    return screen.getByRole('textbox', { name: 'First message for Demo' });
  }

  it.each([
    ['one structured provider is enabled', ['grok'] as TreeResponse['structuredProviders'], true],
    ['every structured provider is enabled', ['codex', 'claude', 'grok'] as TreeResponse['structuredProviders'], true],
    ['the list is empty', [] as TreeResponse['structuredProviders'], false],
    ['the list is absent', undefined, false],
  ])('shows or hides Start correctly when %s', async (_name, structuredProviders, shown) => {
    render(sidebarElement(treeWith(structuredProviders)));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));

    if (shown) expect(screen.getByRole('button', { name: startLabel })).toBeInTheDocument();
    else expect(screen.queryByRole('button', { name: startLabel })).not.toBeInTheDocument();
    // The provider-specific entries stay either way.
    expect(screen.getByRole('button', { name: 'New Codex conversation' })).toBeInTheDocument();
  });

  it('sends the typed prompt for the project and closes the box once the chat is created', async () => {
    const onStartConversation = vi.fn().mockResolvedValue(true);
    render(sidebarElement(treeWith(['codex']), { onStartConversation }));
    const user = userEvent.setup();

    const textbox = await openStartBox(user);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await user.type(textbox, 'Fix the login bug');
    await user.click(send);

    expect(onStartConversation).toHaveBeenCalledWith('demo', 'Fix the login bug');
    await waitFor(() => expect(screen.queryByTestId('start-composer')).not.toBeInTheDocument());
  });

  it('sends with Ctrl+Enter and cancels with Escape without sending', async () => {
    const onStartConversation = vi.fn().mockResolvedValue(true);
    render(sidebarElement(treeWith(['codex']), { onStartConversation }));
    const user = userEvent.setup();

    let textbox = await openStartBox(user);
    await user.type(textbox, 'Never sent');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('start-composer')).not.toBeInTheDocument();
    expect(onStartConversation).not.toHaveBeenCalled();

    textbox = await openStartBox(user);
    await user.type(textbox, 'Send this one');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onStartConversation).toHaveBeenCalledTimes(1);
    expect(onStartConversation).toHaveBeenCalledWith('demo', 'Send this one');
  });

  it('keeps the box and the typed prompt when the chat could not be created', async () => {
    const onStartConversation = vi.fn().mockResolvedValue(false);
    render(sidebarElement(treeWith(['codex']), { onStartConversation }));
    const user = userEvent.setup();

    const textbox = await openStartBox(user);
    await user.type(textbox, 'Try again later');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onStartConversation).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('start-composer')).toBeInTheDocument();
    expect(textbox).toHaveValue('Try again later');
  });

  it('cannot send a second time while a chat is being created', async () => {
    const onStartConversation = vi.fn().mockResolvedValue(true);
    const view = render(sidebarElement(treeWith(['codex']), { onStartConversation }));
    const user = userEvent.setup();

    const textbox = await openStartBox(user);
    await user.type(textbox, 'First and only');
    view.rerender(sidebarElement(treeWith(['codex']), { onStartConversation, creatingConversationKey: 'demo:start' }));

    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onStartConversation).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));
    expect(screen.getByRole('button', { name: startLabel })).toBeDisabled();
  });

  it('offers Start in the mobile new-chat picker, sends the prompt and closes the picker', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      const onStartConversation = vi.fn().mockResolvedValue(true);
      const onClose = vi.fn();
      render(sidebarElement(treeWith(['codex']), { onStartConversation, onClose }));
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'New chat' }));
      await user.click(screen.getByRole('button', { name: 'Start' }));
      await user.type(screen.getByRole('textbox', { name: 'First message for Demo' }), 'Plan the release');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      expect(onStartConversation).toHaveBeenCalledWith('demo', 'Plan the release');
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hides Start from the mobile new-chat picker when no structured provider is enabled', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      render(sidebarElement(treeWith([])));
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'New chat' }));

      expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
