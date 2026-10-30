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
}: {
  slug: string;
  displayName: string;
  codex?: ConversationSummary[];
  claude?: ConversationSummary[];
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
    tmuxSessionName: `ac-${projectSlug}-${provider}`,
    status: 'bound',
    startedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    lastCompletedAt,
    autoTrackedAt,
  };
}

describe('deriveSidebarProjects', () => {
  it('sorts by recent activity using bound-session completion time when present', () => {
    const tree: TreeResponse = {
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
      })],
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
      boundSessions: [],
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


describe('mobile active conversations', () => {
  it('hides every suspension reason, history and projects with no visible chats without changing desktop filtering', () => {
    const stamp = '2026-10-18T00:00:00Z';
    const refs = ['ready', 'manual', 'pressure', 'idle', 'history'];
    const chats = refs.map(ref => conversation({ ref, provider: 'codex', projectSlug: 'alpha', updatedAt: stamp, isBound: ref !== 'history' }));
    const sessions = refs.slice(0, 4).map(ref => ({
      ...boundSession({ projectSlug: 'alpha', provider: 'codex', conversationRef: ref }),
      ...(ref === 'manual' ? { manualSuspendedAt: stamp } : ref === 'pressure' ? { pressureSuspendedAt: stamp } : ref === 'idle' ? { idleSuspendedAt: stamp } : {}),
    }));
    const tree: TreeResponse = { projects: [project({ slug: 'alpha', displayName: 'Alpha', codex: chats }), project({ slug: 'empty', displayName: 'Empty' })], boundSessions: sessions };
    const options = { tree, workMode: true, recentActivitySortEnabled: true, manualProjectOrder: [] };
    const mobile = deriveSidebarProjects({ ...options, mobileActiveOnly: true });
    expect(mobile.map(item => item.slug)).toEqual(['alpha']);
    expect(mobile[0]?.combinedConversations.map(item => item.conversation.ref)).toEqual(['ready']);
    const desktop = deriveSidebarProjects(options);
    expect(desktop).toHaveLength(2);
    expect(desktop[0]?.combinedConversations).toHaveLength(4);
    expect(tree.projects[0]?.providers.codex.conversations).toHaveLength(5);
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
    { ref: 'gray', provider: 'codex', session: {} },
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
    projects: [project({
      slug: 'alpha', displayName: 'Alpha',
      codex: chats.filter(chat => chat.provider === 'codex'),
      claude: chats.filter(chat => chat.provider === 'claude'),
    }), project({ slug: 'empty', displayName: 'Empty' })],
    boundSessions: cases.flatMap(({ ref, provider, session }) => session ? [{
      ...boundSession({ projectSlug: 'alpha', provider, conversationRef: ref }), ...session,
    }] : []),
  };

  it.each([true, false])('keeps only unsuspended red, green and yellow chats with Work mode %s', (workMode) => {
    const options = { tree, workMode, recentActivitySortEnabled: true, manualProjectOrder: [], nowMs };
    const projects = deriveSidebarProjects({ ...options, activeOnly: true });
    expect(projects.map(item => item.slug)).toEqual(['alpha', 'empty']);
    const visible = projects[0]!;
    expect(visible.combinedConversations.map(item => item.conversation.ref)).toEqual(['green', 'retrying', 'red', 'yellow']);
    expect(visible.providers.codex.conversations.map(item => item.ref)).toEqual(['green', 'retrying']);
    expect(visible.providers.claude.conversations.map(item => item.ref)).toEqual(['red', 'yellow']);
    expect(deriveSidebarProjects(options)[0]?.combinedConversations).toHaveLength(workMode ? 11 : 12);
    expect(tree.projects[0]?.providers.codex.conversations).toHaveLength(7);
  });

  it('removes a yellow chat as its response reaches twelve hours old', () => {
    const options = { tree, workMode: true, activeOnly: true, recentActivitySortEnabled: true, manualProjectOrder: [] };
    expect(deriveSidebarProjects({ ...options, nowMs })[0]?.combinedConversations.some(item => item.conversation.ref === 'yellow')).toBe(true);
    expect(deriveSidebarProjects({ ...options, nowMs: nowMs + 60_000 })[0]?.combinedConversations.some(item => item.conversation.ref === 'yellow')).toBe(false);
  });
});
