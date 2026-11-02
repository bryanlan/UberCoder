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
  hiddenAgentControlledCount: number;
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
  showAgentControlled = false,
  nowMs = Date.now(),
}: {
  tree?: TreeResponse;
  workMode: boolean;
  recentActivitySortEnabled: boolean;
  manualProjectOrder: string[];
  mobileActiveOnly?: boolean;
  activeOnly?: boolean;
  /** When false, chats an agent launched stay out of the list. */
  showAgentControlled?: boolean;
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
      const passesListFilters = (item: SidebarConversation, includeAgentControlled: boolean): boolean => {
        if (!includeAgentControlled && (item.launchContext || item.conversation.agentControlled)) return false;
        if (workMode && !item.conversation.isBound) return false;
        if ((activeOnly || mobileActiveOnly)
          && (!item.conversation.isBound || item.manualSuspendedAt || item.pressureSuspendedAt || item.idleSuspendedAt)) return false;
        if (!activeOnly) return true;
        const color = getConversationStatusColor(item.conversation.isBound, item.lastResponseAt, item.isWorking, nowMs, item.runFailure);
        return color === 'red' || color === 'green' || color === 'yellow';
      };
      const combinedConversations = listedConversations.filter((item) => passesListFilters(item, showAgentControlled));
      const hiddenAgentControlledCount = showAgentControlled ? 0 : listedConversations
        .filter((item) => (item.launchContext || item.conversation.agentControlled) && passesListFilters(item, true)).length;
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
        hiddenAgentControlledCount,
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

export function agentControlledConversationKey(projectSlug: string, provider: string, conversationRef: string): string {
  return `${projectSlug}:${provider}:${conversationRef}`;
}

/** Conversations the chat list treats as agent-launched, from the tree label or a live launch record. */
export function agentControlledConversationKeys(tree: TreeResponse | undefined): Set<string> {
  const keys = new Set<string>();
  for (const project of tree?.projects ?? []) {
    for (const provider of PROVIDERS) {
      for (const conversation of project.providers[provider].conversations) {
        if (conversation.agentControlled) keys.add(agentControlledConversationKey(project.slug, provider, conversation.ref));
      }
    }
  }
  for (const session of tree?.boundSessions ?? []) {
    if (session.launchContext) keys.add(agentControlledConversationKey(session.projectSlug, session.provider, session.conversationRef));
  }
  return keys;
}

export function withoutAgentControlledSearchResults<T extends { projectSlug: string; provider: string; conversationRef: string }>(
  results: readonly T[],
  keys: ReadonlySet<string>,
  showAgentControlled: boolean,
): T[] {
  if (showAgentControlled) return [...results];
  return results.filter((result) => !keys.has(agentControlledConversationKey(result.projectSlug, result.provider, result.conversationRef)));
}
