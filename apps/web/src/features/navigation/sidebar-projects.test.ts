import { describe, expect, it } from 'vitest';
import type { BoundSession, ConversationSummary, ProjectSummary, ProviderId, TreeResponse } from '@agent-console/shared';
import { deriveSidebarProjects } from './sidebar-projects';

function conversation({
  ref,
  provider,
  projectSlug,
  updatedAt,
  isBound = false,
}: {
  ref: string;
  provider: ProviderId;
  projectSlug: string;
  updatedAt: string;
  isBound?: boolean;
}): ConversationSummary {
  return {
    ref,
    kind: 'history',
    projectSlug,
    provider,
    title: ref,
    updatedAt,
    isBound,
    degraded: false,
  };
}

function project({
  slug,
  displayName,
  codex = [],
  claude = [],
  grok = [],
}: {
  slug: string;
  displayName: string;
  codex?: ConversationSummary[];
  claude?: ConversationSummary[];
  grok?: ConversationSummary[];
}): ProjectSummary {
  return {
    slug,
    directoryName: slug,
    displayName,
    path: `/tmp/${slug}`,
    tags: [],
    allowedLocalhostPorts: [],
    providers: {
      codex: { id: 'codex', label: 'Codex', conversations: codex },
      claude: { id: 'claude', label: 'Claude', conversations: claude },
      grok: { id: 'grok', label: 'Grok', conversations: grok },
      vibe: { id: 'vibe', label: 'Mistral Vibe', conversations: [] },
      antigravity: { id: 'antigravity', label: 'Antigravity', conversations: [] },
    },
  };
}

function boundSession({
  projectSlug,
  provider,
  conversationRef,
  lastCompletedAt,
  autoTrackedAt,
}: {
  projectSlug: string;
  provider: ProviderId;
  conversationRef: string;
  lastCompletedAt?: string;
  autoTrackedAt?: string;
}): BoundSession {
  return {
    id: `${projectSlug}:${provider}:${conversationRef}`,
    provider,
    projectSlug,
    conversationRef,
    status: 'bound',
    startedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    lastCompletedAt,
    lastResponseAt: lastCompletedAt ?? '2026-07-01T00:00:00.000Z',
    autoTrackedAt,
  };
}

describe('deriveSidebarProjects', () => {
  it('lists Grok conversations beside Codex and Claude and keeps them under their own provider', () => {
    const tree: TreeResponse = {
      projects: [project({
        slug: 'alpha',
        displayName: 'Alpha',
        codex: [conversation({ ref: 'c1', provider: 'codex', projectSlug: 'alpha', updatedAt: '2026-07-01T09:00:00.000Z', isBound: true })],
        grok: [conversation({ ref: 'g1', provider: 'grok', projectSlug: 'alpha', updatedAt: '2026-07-01T10:00:00.000Z', isBound: true })],
      })],
      structuredProviders: [],
      boundSessions: [boundSession({ projectSlug: 'alpha', provider: 'codex', conversationRef: 'c1' }), boundSession({ projectSlug: 'alpha', provider: 'grok', conversationRef: 'g1' })],
    };

    const [alpha] = deriveSidebarProjects({ tree, workMode: true, recentActivitySortEnabled: false, manualProjectOrder: [] });

    expect(alpha?.combinedConversations.map((item) => `${item.provider}:${item.conversation.ref}`)).toEqual(['codex:c1', 'grok:g1']);
    expect(alpha?.providers.grok.conversations.map((item) => item.ref)).toEqual(['g1']);
    expect(alpha?.providers.claude.conversations).toEqual([]);
  });

  it('sorts by recent activity using bound-session completion time when present', () => {
    const tree: TreeResponse = {
      structuredProviders: [],
      projects: [
        project({
          slug: 'alpha',
          displayName: 'Alpha',
          codex: [conversation({
            ref: 'old-source',
            provider: 'codex',
            projectSlug: 'alpha',
            updatedAt: '2026-07-01T09:00:00.000Z',
            isBound: true,
          })],
        }),
        project({
          slug: 'beta',
          displayName: 'Beta',
          claude: [conversation({
            ref: 'newer-source',
            provider: 'claude',
            projectSlug: 'beta',
            updatedAt: '2026-07-01T10:00:00.000Z',
            isBound: true,
          })],
        }),
      ],
      boundSessions: [
        boundSession({
          projectSlug: 'alpha',
          provider: 'codex',
          conversationRef: 'old-source',
          lastCompletedAt: '2026-07-01T11:00:00.000Z',
        }),
      ],
    };

    const visibleProjects = deriveSidebarProjects({
      tree,
      workMode: false,
      recentActivitySortEnabled: true,
      manualProjectOrder: [],
    });

    expect(visibleProjects.map((item) => item.slug)).toEqual(['alpha', 'beta']);
    expect(visibleProjects[0]?.combinedConversations[0]?.activityTimestamp).toBe('2026-07-01T11:00:00.000Z');
  });

  it('uses auto-tracked time for the indicator without moving genuine recent-activity order', () => {
    const tree: TreeResponse = {
      structuredProviders: [],
      projects: [
        project({
          slug: 'auto-tracked',
          displayName: 'Auto tracked',
          codex: [conversation({
            ref: 'older-source',
            provider: 'codex',
            projectSlug: 'auto-tracked',
            updatedAt: '2026-07-01T09:00:00.000Z',
            isBound: true,
          })],
        }),
        project({
          slug: 'genuinely-newer',
          displayName: 'Genuinely newer',
          claude: [conversation({
            ref: 'newer-source',
            provider: 'claude',
            projectSlug: 'genuinely-newer',
            updatedAt: '2026-07-01T10:00:00.000Z',
            isBound: true,
          })],
        }),
      ],
      boundSessions: [boundSession({
        projectSlug: 'auto-tracked',
        provider: 'codex',
        conversationRef: 'older-source',
        autoTrackedAt: '2026-07-01T12:00:00.000Z',
      }), boundSession({ projectSlug: 'genuinely-newer', provider: 'claude', conversationRef: 'newer-source' })],
    };

    const visibleProjects = deriveSidebarProjects({
      tree,
      workMode: true,
      recentActivitySortEnabled: true,
      manualProjectOrder: [],
    });

    expect(visibleProjects.map((item) => item.slug)).toEqual(['genuinely-newer', 'auto-tracked']);
    expect(visibleProjects[1]?.combinedConversations[0]).toMatchObject({
      activityTimestamp: '2026-07-01T09:00:00.000Z',
      autoTrackedAt: '2026-07-01T12:00:00.000Z',
    });
  });

  it('uses manual order and display-name fallback when recent sorting is disabled', () => {
    const tree: TreeResponse = {
      structuredProviders: [],
      projects: [
        project({ slug: 'gamma', displayName: 'Gamma' }),
        project({ slug: 'alpha', displayName: 'Alpha' }),
        project({ slug: 'beta', displayName: 'Beta' }),
      ],
      boundSessions: [],
    };

    const visibleProjects = deriveSidebarProjects({
      tree,
      workMode: false,
      recentActivitySortEnabled: false,
      manualProjectOrder: ['beta'],
    });

    expect(visibleProjects.map((item) => item.slug)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it.each([true, false])('moves projects without bound conversations below active projects until a chat binds (recent sorting: %s)', (recentActivitySortEnabled) => {
    const tree: TreeResponse = {
      structuredProviders: [],
      projects: [
        project({
          slug: 'active',
          displayName: 'Active',
          codex: [
            conversation({
              ref: 'bound',
              provider: 'codex',
              projectSlug: 'active',
              updatedAt: '2026-07-01T10:00:00.000Z',
              isBound: true,
            }),
            conversation({
              ref: 'history',
              provider: 'codex',
              projectSlug: 'active',
              updatedAt: '2026-07-01T09:00:00.000Z',
            }),
          ],
        }),
        project({
          slug: 'inactive',
          displayName: 'Inactive',
          claude: [conversation({
            ref: 'only-history',
            provider: 'claude',
            projectSlug: 'inactive',
            updatedAt: '2026-07-01T11:00:00.000Z',
          })],
        }),
        project({ slug: 'empty', displayName: 'Empty' }),
      ],
      boundSessions: [boundSession({ projectSlug: 'active', provider: 'codex', conversationRef: 'bound' })],
    };

    const visibleProjects = deriveSidebarProjects({
      tree,
      workMode: true,
      recentActivitySortEnabled,
      manualProjectOrder: ['inactive', 'active', 'empty'],
    });

    expect(visibleProjects.map((item) => item.slug)).toEqual(['active', 'inactive', 'empty']);
    const active = visibleProjects.find((item) => item.slug === 'active');
    expect(active?.combinedConversations.map((item) => item.conversation.ref)).toEqual(['bound']);
    expect(active?.providers.codex.conversations.map((item) => item.ref)).toEqual(['bound']);
    for (const slug of ['inactive', 'empty']) {
      const retained = visibleProjects.find((item) => item.slug === slug);
      expect(retained?.combinedConversations).toEqual([]);
      expect(retained?.providers.codex.conversations).toEqual([]);
      expect(retained?.providers.claude.conversations).toEqual([]);
    }

    const reboundTree: TreeResponse = {
      ...tree,
      boundSessions: [...tree.boundSessions, boundSession({ projectSlug: 'inactive', provider: 'claude', conversationRef: 'only-history' })],
      projects: tree.projects.map((item) => item.slug === 'inactive' ? {
        ...item,
        providers: {
          ...item.providers,
          claude: {
            ...item.providers.claude,
            conversations: item.providers.claude.conversations.map((chat) => ({ ...chat, isBound: true })),
          },
        },
      } : item),
    };
    const afterRebind = deriveSidebarProjects({
      tree: reboundTree,
      workMode: true,
      recentActivitySortEnabled,
      manualProjectOrder: ['inactive', 'active', 'empty'],
    });
    expect(afterRebind.map((item) => item.slug)).toEqual(['inactive', 'active', 'empty']);
    expect(afterRebind[0]?.combinedConversations.map((item) => item.conversation.ref)).toEqual(['only-history']);
  });
});


describe('Active only', () => {
  const nowMs = Date.parse('2026-10-30T12:00:00Z');
  const ago = (hours: number) => new Date(nowMs - hours * 3_600_000).toISOString();
  const failures: BoundSession['runFailure'] = {
    turnId: 'failed-turn', failedAt: ago(0.1), code: 'unknown', message: 'Stopped',
    attempts: 0, maxAttempts: 3, status: 'stopped',
  };
  const cases: Array<{ ref: string; provider: ProviderId; session?: Partial<BoundSession> }> = [
    { ref: 'green', provider: 'codex', session: { lastResponseAt: ago(0.5) } },
    { ref: 'red', provider: 'claude', session: { isWorking: true, lastResponseAt: ago(90) } },
    { ref: 'yellow', provider: 'claude', session: { lastResponseAt: ago(11.99) } },
    { ref: 'amber', provider: 'codex', session: { lastResponseAt: ago(12) } },
    { ref: 'purple', provider: 'claude', session: { lastResponseAt: ago(48) } },
    { ref: 'gray', provider: 'codex', session: { lastResponseAt: undefined } },
    { ref: 'failed', provider: 'claude', session: { lastResponseAt: ago(0.5), runFailure: failures } },
    { ref: 'retrying', provider: 'codex', session: { lastResponseAt: ago(0.5), runFailure: { ...failures, status: 'retrying' } } },
    { ref: 'manual', provider: 'codex', session: { lastResponseAt: ago(0.5), manualSuspendedAt: ago(0) } },
    { ref: 'pressure', provider: 'claude', session: { lastResponseAt: ago(2), pressureSuspendedAt: ago(0) } },
    { ref: 'idle', provider: 'codex', session: { isWorking: true, idleSuspendedAt: ago(0) } },
    { ref: 'history', provider: 'codex' },
  ];
  const chats = cases.map(({ ref, provider, session }) => conversation({
    ref, provider, projectSlug: 'alpha', updatedAt: ago(0), isBound: Boolean(session),
  }));
  const tree: TreeResponse = {
    structuredProviders: [],
    projects: [project({
      slug: 'alpha', displayName: 'Alpha',
      codex: chats.filter(chat => chat.provider === 'codex'),
      claude: chats.filter(chat => chat.provider === 'claude'),
    }), project({ slug: 'empty', displayName: 'Empty' })],
    boundSessions: cases.flatMap(({ ref, provider, session }) => session ? [{
      ...boundSession({ projectSlug: 'alpha', provider, conversationRef: ref }), ...session,
    }] : []),
  };

  it.each([
    { activeOnly: false, recentActivity: false, refs: ['green', 'amber', 'retrying', 'manual', 'idle', 'red', 'yellow', 'purple', 'pressure'] },
    { activeOnly: true, recentActivity: false, refs: ['green', 'amber', 'retrying', 'idle', 'red', 'yellow', 'purple'] },
    { activeOnly: false, recentActivity: true, refs: ['green', 'amber', 'retrying', 'manual', 'idle', 'red', 'yellow', 'pressure'] },
  ])('filters by status and suspension: $activeOnly / $recentActivity', ({ refs, ...filters }) => {
    const projects = deriveSidebarProjects({ tree, workMode: true, recentActivitySortEnabled: true, manualProjectOrder: [], nowMs, ...filters });
    expect(projects.map(item => item.slug)).toEqual(['alpha', 'empty']);
    expect(projects[0]?.combinedConversations.map(item => item.conversation.ref)).toEqual(refs);
    expect(tree.projects[0]?.providers.codex.conversations).toHaveLength(7);
  });

  it.each(['manual', 'pressure', 'idle'])('includes a working chat with %s suspension, then hides it when work stops', (ref) => {
    const options = { tree, workMode: true, activeOnly: true, recentActivitySortEnabled: false, manualProjectOrder: [], nowMs };
    const visible = (isWorking: boolean) => deriveSidebarProjects({
      ...options,
      tree: { ...tree, boundSessions: tree.boundSessions.map(session => session.conversationRef === ref ? { ...session, isWorking, lastResponseAt: isWorking ? undefined : session.lastResponseAt } : session) },
    })[0]?.combinedConversations.map(item => item.conversation.ref);
    expect(visible(false)).not.toContain(ref);
    expect(visible(true)).toContain(ref);
    expect(visible(false)).not.toContain(ref);
  });

  it('shows an older chat while it works, then filters it again when work stops', () => {
    const options = { tree, workMode: true, recentActivity: true, recentActivitySortEnabled: false, manualProjectOrder: [], nowMs };
    const refs = (sessions: BoundSession[]) => deriveSidebarProjects({ ...options, tree: { ...tree, boundSessions: sessions } })[0]?.combinedConversations.map(item => item.conversation.ref);
    expect(refs(tree.boundSessions)).not.toContain('purple');
    const working = tree.boundSessions.map(session => session.conversationRef === 'purple' ? { ...session, isWorking: true } : session);
    expect(refs(working)).toContain('purple');
    expect(refs(tree.boundSessions)).not.toContain('purple');
  });

  it('shows all chats when Work Mode is off even with stale subfilters', () => {
    const projects = deriveSidebarProjects({ tree, workMode: false, activeOnly: true, recentActivity: true, recentActivitySortEnabled: false, manualProjectOrder: [], nowMs });
    expect(projects[0]?.combinedConversations).toHaveLength(12);
  });

  it('keeps a chat when it turns amber and removes it when it turns purple', () => {
    const options = { tree, workMode: true, recentActivity: true, recentActivitySortEnabled: true, manualProjectOrder: [] };
    const lastResponse = Date.parse(ago(11.99));
    const visible = (hoursSinceResponse: number) => deriveSidebarProjects({
      ...options, nowMs: lastResponse + hoursSinceResponse * 3_600_000,
    })[0]?.combinedConversations.some(item => item.conversation.ref === 'yellow');
    expect(visible(11.99)).toBe(true);
    expect(visible(12)).toBe(true);
    expect(visible(47.99)).toBe(true);
    expect(visible(48)).toBe(false);
  });
});

describe('agent-controlled chats', () => {
  const launchContext = {
    launchedBy: 'assignment-1',
    launcherName: 'Planner lead',
    grantIds: ['grant-1'],
    requestId: 'req',
    supervisorId: 'assignment-1',
  };
  const tree: TreeResponse = {
    structuredProviders: [],
    projects: [project({
      slug: 'alpha',
      displayName: 'Alpha',
      codex: [
        conversation({ ref: 'mine', provider: 'codex', projectSlug: 'alpha', updatedAt: '2026-07-01T09:00:00.000Z', isBound: true }),
        conversation({ ref: 'helper', provider: 'codex', projectSlug: 'alpha', updatedAt: '2026-07-01T10:00:00.000Z', isBound: true }),
        { ...conversation({ ref: 'old-helper', provider: 'codex', projectSlug: 'alpha', updatedAt: '2026-07-01T08:00:00.000Z' }), agentControlled: { launcherName: 'Planner lead' } },
      ],
    })],
    boundSessions: [{
      ...boundSession({ projectSlug: 'alpha', provider: 'codex', conversationRef: 'helper' }),
      launchContext,
    }],
  };
  const options = { tree, workMode: true, recentActivitySortEnabled: false, manualProjectOrder: [] };

  it('includes agent-launched chats and their saved history', () => {
    const history = deriveSidebarProjects({ ...options, workMode: false });
    expect(history[0]?.combinedConversations.map(item => item.conversation.ref)).toEqual(['mine', 'helper', 'old-helper']);
    const work = deriveSidebarProjects(options);
    expect(work[0]?.combinedConversations.map(item => item.conversation.ref)).toEqual(['helper']);
  });
});
