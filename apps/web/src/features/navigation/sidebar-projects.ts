import { PROVIDERS, type ProjectSummary, type ProviderId, type TreeResponse } from '@agent-console/shared';
import { getConversationStatusColor } from './work-status';

type ConversationItem = ProjectSummary['providers'][ProviderId]['conversations'][number];
type BoundSessionItem = TreeResponse['boundSessions'][number];

export interface SidebarConversation {
  provider: ProviderId;
  conversation: ConversationItem;
  activityTimestamp: string;
  lastResponseAt?: string;
  isWorking: boolean;
  manualSuspendedAt?: string;
  pressureSuspendedAt?: string;
  idleSuspendedAt?: string;
  autoTrackedAt?: string;
  runFailure?: BoundSessionItem['runFailure'];
  launchContext?: BoundSessionItem['launchContext'];
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
  activeOnly = false,
  recentActivity = false,
  nowMs = Date.now(),
}: {
  tree?: TreeResponse;
  workMode: boolean;
  recentActivitySortEnabled: boolean;
  manualProjectOrder: string[];
  activeOnly?: boolean;
  recentActivity?: boolean;
  nowMs?: number;
}): SidebarProject[] {
  const boundSessionMap = new Map((tree?.boundSessions ?? []).map((session) => [`${session.projectSlug}:${session.provider}:${session.conversationRef}`, session]));
  const manualOrderIndex = new Map(manualProjectOrder.map((slug, index) => [slug, index]));

  return (tree?.projects ?? [])
    .map((project) => {
      const listedConversations = PROVIDERS
        .flatMap((provider) => project.providers[provider].conversations.map((conversation) => {
          const session = boundSessionMap.get(`${project.slug}:${provider}:${conversation.ref}`);
          const activityTimestamp = getConversationRecencyTimestamp(conversation, session);
          return {
            provider,
            conversation,
            activityTimestamp,
            lastResponseAt: session?.lastResponseAt,
            isWorking: session?.isWorking === true,
            manualSuspendedAt: session?.manualSuspendedAt,
            pressureSuspendedAt: session?.pressureSuspendedAt,
            idleSuspendedAt: session?.idleSuspendedAt,
            autoTrackedAt: session?.autoTrackedAt,
            runFailure: session?.runFailure,
            launchContext: session?.launchContext,
          };
        }));
      const combinedConversations = listedConversations.filter((item) => {
        if (!workMode) return true;
        const color = getConversationStatusColor(item.conversation.isBound, item.lastResponseAt, item.isWorking, nowMs, item.runFailure);
        if (color === 'unbound' || color === 'gray') return false;
        if (color === 'red') return true;
        if (recentActivity) return color === 'green' || color === 'yellow' || color === 'amber';
        return !activeOnly || !(item.manualSuspendedAt || item.pressureSuspendedAt || item.idleSuspendedAt);
      });
      const providerEntries = PROVIDERS.map((provider) => [provider, {
        ...project.providers[provider],
        conversations: combinedConversations.filter((item) => item.provider === provider).map((item) => item.conversation),
      }] as const);
      const latestActivityAt = combinedConversations.reduce(
        (latest, conversation) => conversation.activityTimestamp > latest ? conversation.activityTimestamp : latest,
        '',
      );
      return {
        ...project,
        providers: Object.fromEntries(providerEntries) as ProjectSummary['providers'],
        combinedConversations,
        latestActivityAt,
      };
    })
    .sort((a, b) => {
      if (workMode) {
        const aHasActiveConversation = a.combinedConversations.length > 0;
        const bHasActiveConversation = b.combinedConversations.length > 0;
        if (aHasActiveConversation !== bHasActiveConversation) {
          return aHasActiveConversation ? -1 : 1;
        }
      }
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
