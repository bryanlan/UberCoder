import type { ProjectSummary, ProviderId, TreeResponse } from '@agent-console/shared';

type ConversationItem = ProjectSummary['providers'][ProviderId]['conversations'][number];
type BoundSessionItem = TreeResponse['boundSessions'][number];

export interface SidebarConversation {
  provider: ProviderId;
  conversation: ConversationItem;
  freshnessTimestamp: string;
}

export type SidebarProject = ProjectSummary & {
  combinedConversations: SidebarConversation[];
  latestActivityAt: string;
};

function getConversationRecencyTimestamp(
  conversation: ConversationItem,
  session?: BoundSessionItem,
): string {
  if (!session) {
    return conversation.updatedAt;
  }
  return session.lastCompletedAt ?? conversation.updatedAt;
}

export function deriveSidebarProjects({
  tree,
  workMode,
  recentActivitySortEnabled,
  manualProjectOrder,
}: {
  tree?: TreeResponse;
  workMode: boolean;
  recentActivitySortEnabled: boolean;
  manualProjectOrder: string[];
}): SidebarProject[] {
  const boundSessionMap = new Map((tree?.boundSessions ?? []).map((session) => [`${session.projectSlug}:${session.provider}:${session.conversationRef}`, session]));
  const manualOrderIndex = new Map(manualProjectOrder.map((slug, index) => [slug, index]));

  return (tree?.projects ?? [])
    .map((project) => {
      const providerEntries = (['codex', 'claude'] as const).map((provider) => {
        const conversations = project.providers[provider].conversations
          .filter((conversation) => !workMode || conversation.isBound);
        return [provider, { ...project.providers[provider], conversations }] as const;
      });
      const combinedConversations = (['codex', 'claude'] as const)
        .flatMap((provider) => project.providers[provider].conversations.map((conversation) => {
          const session = boundSessionMap.get(`${project.slug}:${provider}:${conversation.ref}`);
          const freshnessTimestamp = getConversationRecencyTimestamp(conversation, session);
          return {
            provider,
            conversation,
            freshnessTimestamp,
          };
        }))
        .filter(({ conversation }) => !workMode || conversation.isBound);
      const latestActivityAt = combinedConversations.reduce(
        (latest, conversation) => conversation.freshnessTimestamp > latest ? conversation.freshnessTimestamp : latest,
        '',
      );
      return {
        ...project,
        providers: Object.fromEntries(providerEntries) as ProjectSummary['providers'],
        combinedConversations,
        latestActivityAt,
      };
    })
    .filter((project) => !workMode || project.combinedConversations.length > 0)
    .sort((a, b) => {
      if (recentActivitySortEnabled) {
        return (b.latestActivityAt || '').localeCompare(a.latestActivityAt || '');
      }
      const aIndex = manualOrderIndex.get(a.slug) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = manualOrderIndex.get(b.slug) ?? Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) {
        return aIndex - bIndex;
      }
      return a.displayName.localeCompare(b.displayName);
    });
}
