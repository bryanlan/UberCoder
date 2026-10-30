import type { ProjectSummary, ProviderId, TreeResponse } from '@agent-console/shared';
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
  mobileActiveOnly = false,
  activeOnly = false,
  nowMs = Date.now(),
}: {
  tree?: TreeResponse;
  workMode: boolean;
  recentActivitySortEnabled: boolean;
  manualProjectOrder: string[];
  mobileActiveOnly?: boolean;
  activeOnly?: boolean;
  nowMs?: number;
}): SidebarProject[] {
  const boundSessionMap = new Map((tree?.boundSessions ?? []).map((session) => [`${session.projectSlug}:${session.provider}:${session.conversationRef}`, session]));
  const manualOrderIndex = new Map(manualProjectOrder.map((slug, index) => [slug, index]));

  return (tree?.projects ?? [])
    .map((project) => {
      const combinedConversations = (['codex', 'claude'] as const)
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
        }))
        .filter(({ conversation, manualSuspendedAt, pressureSuspendedAt, idleSuspendedAt, lastResponseAt, isWorking, runFailure }) => {
          if (workMode && !conversation.isBound) return false;
          if ((activeOnly || mobileActiveOnly)
            && (!conversation.isBound || manualSuspendedAt || pressureSuspendedAt || idleSuspendedAt)) return false;
          if (!activeOnly) return true;
          const color = getConversationStatusColor(conversation.isBound, lastResponseAt, isWorking, nowMs, runFailure);
          return color === 'red' || color === 'green' || color === 'yellow';
        });
      const providerEntries = (['codex', 'claude'] as const).map((provider) => [provider, {
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
    .filter((project) => !mobileActiveOnly || project.combinedConversations.length > 0)
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
