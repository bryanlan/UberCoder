import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BoundSession, FixedModelProfileKey, ModelProfilesResponse, TreeResponse } from '@agent-console/shared';
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
    structuredProviders: ['codex', 'claude'],
    boundSessions: [{
      id: 'session-1', provider: 'codex', projectSlug: 'demo', conversationRef: 'conversation-1',
      status: 'bound',
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
    status: 'bound', shouldRestore: true,
    startedAt: responseAt, updatedAt: new Date(now).toISOString(),
    lastResponseAt: responseAt, lastActivityAt: responseAt, isWorking: false,
    [marker]: new Date(now).toISOString(),
  };
  const tree: TreeResponse = {
    structuredProviders: [],
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

describe('New Chat options', () => {
  function treeWithProject(structuredProviders: TreeResponse['structuredProviders'] = ['codex', 'claude']): TreeResponse {
    return {
      structuredProviders,
      boundSessions: [],
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

  it('starts a conversation for each provider from the project menu', async () => {
    const onNewConversation = renderSidebar(treeWithProject());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));
    await user.click(screen.getByRole('button', { name: 'New Codex conversation' }));
    expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'codex');

    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));
    await user.click(screen.getByRole('button', { name: 'New Claude conversation' }));
    expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'claude');
  });

  it('offers one button per provider in the mobile new-chat picker', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      const user = userEvent.setup();
      const onNewConversation = renderSidebar(treeWithProject());
      await user.click(screen.getByRole('button', { name: 'New chat' }));
      expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Claude' }));
      expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'claude');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers a new Grok conversation from the project menu only when the tree advertises grok', async () => {
    const onNewConversation = renderSidebar(treeWithProject(['codex', 'claude', 'grok']));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));
    await user.click(screen.getByRole('button', { name: 'New Grok conversation' }));
    expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'grok');
  });

  it.each([
    ['an empty list', [] as TreeResponse['structuredProviders']],
    ['a list without grok', ['codex', 'claude'] as TreeResponse['structuredProviders']],
  ])('has no new Grok conversation for %s', async (_name, structuredProviders) => {
    renderSidebar(treeWithProject(structuredProviders));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));

    expect(screen.queryByRole('button', { name: /New Grok/ })).not.toBeInTheDocument();
  });

  it('adds Grok to the mobile new-chat picker when its lane is on', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      const user = userEvent.setup();
      const onNewConversation = renderSidebar(treeWithProject(['codex', 'claude', 'grok']));
      await user.click(screen.getByRole('button', { name: 'New chat' }));
      await user.click(screen.getByRole('button', { name: 'Grok' }));
      expect(onNewConversation).toHaveBeenLastCalledWith('demo', 'grok');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { enabled: ['codex'] as const, hidden: 'Claude', shown: 'Codex' },
    { enabled: ['claude'] as const, hidden: 'Codex', shown: 'Claude' },
  ])('offers no new $hidden conversation when its lane is off', async ({ enabled, hidden, shown }) => {
    renderSidebar(treeWithProject([...enabled]));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));
    expect(screen.getByRole('button', { name: `New ${shown} conversation` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `New ${hidden} conversation` })).not.toBeInTheDocument();
  });

  it('offers no new conversation for any provider when every lane is off', async () => {
    renderSidebar(treeWithProject([]));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));
    expect(screen.queryByRole('button', { name: /^New (Codex|Claude|Grok) conversation$/ })).not.toBeInTheDocument();
  });

  it('leaves a provider whose lane is off out of the mobile new-chat picker', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      const user = userEvent.setup();
      renderSidebar(treeWithProject(['claude']));
      await user.click(screen.getByRole('button', { name: 'New chat' }));
      expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Codex' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it('hides an agent-launched chat until Agent controlled is turned on', async () => {
  const tree: TreeResponse = {
    structuredProviders: ['codex'],
    boundSessions: [{
      id: 'helper-session', provider: 'codex', projectSlug: 'demo', conversationRef: 'helper',
      status: 'bound', shouldRestore: true,
      startedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
      launchContext: {
        launchedBy: 'assignment-1', launcherName: 'Planner lead', grantIds: ['grant-1'],
        requestId: 'req', supervisorId: 'assignment-1',
      },
    }],
    projects: [{
      slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo',
      tags: [], allowedLocalhostPorts: [],
      providers: {
        codex: { id: 'codex', label: 'Codex', conversations: [
          { ref: 'mine', projectSlug: 'demo', provider: 'codex', kind: 'history', title: 'My chat', updatedAt: '2026-07-01T09:00:00.000Z', isBound: true, degraded: false },
          { ref: 'helper', projectSlug: 'demo', provider: 'codex', kind: 'history', title: 'Helper chat', updatedAt: '2026-07-01T10:00:00.000Z', isBound: true, degraded: false },
        ] },
        claude: { id: 'claude', label: 'Claude', conversations: [] },
        grok: { id: 'grok', label: 'Grok', conversations: [] },
      },
    }],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['network-info'], {});
  const onToggleAgentControlled = vi.fn();
  const element = (showAgentControlled: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Sidebar
          tree={tree} open workMode activeOnly={false} onToggleActiveOnly={() => {}}
          showAgentControlled={showAgentControlled} onToggleAgentControlled={onToggleAgentControlled}
          recentActivitySortEnabled={false} manualProjectOrder={[]}
          onClose={() => {}} onToggleWorkMode={() => {}} onNewConversation={() => {}} onStartConversation={async () => true}
          onToggleRecentActivity={async () => {}} onReorderProjects={async () => {}}
          onRenameProject={async () => true} onRebindConversation={async () => true}
          onRenameConversation={async () => true} updatingUiPreferences={false}
          onCloseConversation={async () => true}
          onRefresh={() => {}} refreshing={false}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(element(false));
  expect(screen.getByRole('link', { name: /My chat/ })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Helper chat/ })).not.toBeInTheDocument();
  const toggle = screen.getByRole('button', { name: 'Agent controlled' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await userEvent.setup().click(toggle);
  expect(onToggleAgentControlled).toHaveBeenCalledOnce();

  view.rerender(element(true));
  expect(screen.getByRole('link', { name: /Helper chat/ })).toBeInTheDocument();
  expect(screen.getByText('Launched by Planner lead')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Agent controlled' })).toHaveAttribute('aria-pressed', 'true');
});

describe('Start (provider-neutral new chat)', () => {
  const startLabel = 'Start a chat (agent picked for you)';

  function treeWith(structuredProviders: TreeResponse['structuredProviders']): TreeResponse {
    return {
      boundSessions: [],
      structuredProviders,
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

  function sidebarElement(tree: TreeResponse, props: {
    onStartConversation?: (projectSlug: string, prompt: string, level?: FixedModelProfileKey) => Promise<boolean>; creatingConversationKey?: string; onClose?: () => void;
    modelProfiles?: ModelProfilesResponse;
  } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['network-info'], {});
    if (props.modelProfiles) client.setQueryData(['model-profiles'], props.modelProfiles);
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
    ['one provider is enabled', ['grok'] as TreeResponse['structuredProviders'], true],
    ['every provider is enabled', ['codex', 'claude', 'grok'] as TreeResponse['structuredProviders'], true],
    ['the list is empty', [] as TreeResponse['structuredProviders'], false],
  ])('shows or hides Start correctly when %s', async (_name, structuredProviders, shown) => {
    render(sidebarElement(treeWith(structuredProviders)));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Project actions for Demo' }));

    if (shown) expect(screen.getByRole('button', { name: startLabel })).toBeInTheDocument();
    else expect(screen.queryByRole('button', { name: startLabel })).not.toBeInTheDocument();
    // The provider-specific entries follow the same list of enabled providers.
    if (structuredProviders.includes('codex')) expect(screen.getByRole('button', { name: 'New Codex conversation' })).toBeInTheDocument();
    else expect(screen.queryByRole('button', { name: 'New Codex conversation' })).not.toBeInTheDocument();
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

    expect(onStartConversation).toHaveBeenCalledWith('demo', 'Fix the login bug', undefined);
    await waitFor(() => expect(screen.queryByTestId('start-composer')).not.toBeInTheDocument());
  });

  it('starts on the level picked, and names the models the server lists at that level', async () => {
    const onStartConversation = vi.fn().mockResolvedValue(true);
    const entry = (label: string) => ({ model: label, label, effort: 'xhigh', launchName: label });
    const modelProfiles: ModelProfilesResponse = { loadedAt: 'now', providers: {
      codex: { routerProvider: 'openai', levels: { ultra: entry('GPT-6 Astra'), medium: entry('GPT-6.1 Terra') } },
      claude: { routerProvider: 'anthropic', levels: { ultra: entry('Claude Fable 5.1'), medium: entry('Claude Sonnet 5.5') } },
      grok: { routerProvider: 'xai', levels: { medium: entry('Grok 4.7') } },
    } };
    render(sidebarElement(treeWith(['codex', 'claude']), { onStartConversation, modelProfiles }));
    const user = userEvent.setup();

    const textbox = await openStartBox(user);
    const levels = screen.getByRole('radiogroup', { name: 'Model level' });
    expect(Array.from(levels.querySelectorAll('[role="radio"]')).map((button) => button.textContent)).toEqual(['A', 'U', 'H', 'M', 'L']);
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Ultra' }));
    expect(screen.getByRole('radio', { name: 'Ultra' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('start-level-hint')).toHaveTextContent('Ultra: GPT-6 Astra, Claude Fable 5.1. Console picks the one with the most quota room.');
    await user.click(screen.getByRole('radio', { name: 'High' }));
    // No model at a level in the list: the hint says what the choice does without naming one.
    expect(screen.getByTestId('start-level-hint')).toHaveTextContent('High: Console picks the High model with the most quota room.');
    await user.click(screen.getByRole('radio', { name: 'Ultra' }));
    await user.type(textbox, 'Design the rewrite');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onStartConversation).toHaveBeenCalledWith('demo', 'Design the rewrite', 'ultra');
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
    expect(onStartConversation).toHaveBeenCalledWith('demo', 'Send this one', undefined);
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

      expect(onStartConversation).toHaveBeenCalledWith('demo', 'Plan the release', undefined);
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hides Start from the mobile new-chat picker when no provider is enabled', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      render(sidebarElement(treeWith([])));
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'New chat' }));

      expect(screen.queryByRole('button', { name: 'Codex' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
