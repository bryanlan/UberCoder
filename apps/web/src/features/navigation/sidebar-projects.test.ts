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
}: {
  projectSlug: string;
  provider: ProviderId;
  conversationRef: string;
  lastCompletedAt?: string;
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
    expect(visibleProjects[0]?.combinedConversations[0]?.freshnessTimestamp).toBe('2026-07-01T11:00:00.000Z');
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

  it('filters unbound conversations and empty projects in work mode', () => {
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
      ],
      boundSessions: [],
    };

    const visibleProjects = deriveSidebarProjects({
      tree,
      workMode: true,
      recentActivitySortEnabled: true,
      manualProjectOrder: [],
    });

    expect(visibleProjects.map((item) => item.slug)).toEqual(['active']);
    expect(visibleProjects[0]?.combinedConversations.map((item) => item.conversation.ref)).toEqual(['bound']);
    expect(visibleProjects[0]?.providers.codex.conversations.map((item) => item.ref)).toEqual(['bound']);
  });
});
