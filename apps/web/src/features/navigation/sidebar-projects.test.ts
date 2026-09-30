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
