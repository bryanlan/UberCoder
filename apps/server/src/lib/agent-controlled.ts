import { PROVIDERS, type ConversationSummary, type ProjectSummary, type ProviderId } from '@agent-console/shared';

/** One retained session row that an agent launched under a standing grant. */
export interface AgentLaunchMark {
  projectSlug: string;
  provider: ProviderId;
  conversationRef: string;
  resumeConversationRef?: string;
  launcherName: string;
  updatedAt: string;
}

function conversationKey(projectSlug: string, provider: string, conversationRef: string): string {
  return `${projectSlug}:${provider}:${conversationRef}`;
}

/** Latest launch name for each conversation ref, including the ref it resumed from. */
export function agentControlledByConversation(marks: readonly AgentLaunchMark[]): Map<string, { launcherName: string }> {
  const ordered = [...marks].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
    || left.conversationRef.localeCompare(right.conversationRef));
  const byKey = new Map<string, { launcherName: string }>();
  for (const mark of ordered) {
    const value = { launcherName: mark.launcherName.trim() || 'an agent' };
    byKey.set(conversationKey(mark.projectSlug, mark.provider, mark.conversationRef), value);
    if (mark.resumeConversationRef && mark.resumeConversationRef !== mark.conversationRef) {
      byKey.set(conversationKey(mark.projectSlug, mark.provider, mark.resumeConversationRef), value);
    }
  }
  return byKey;
}

/** Copies the launch label onto tree conversations. Missing or older rows stay unchanged. */
export function stampAgentControlledConversations(projects: ProjectSummary[], marks: readonly AgentLaunchMark[]): void {
  const byKey = agentControlledByConversation(marks);
  if (byKey.size === 0) return;
  for (const project of projects) {
    for (const providerId of PROVIDERS) {
      const node = project.providers[providerId];
      node.conversations = node.conversations.map((conversation: ConversationSummary) => {
        const mark = byKey.get(conversationKey(project.slug, providerId, conversation.ref));
        return mark ? { ...conversation, agentControlled: mark } : conversation;
      });
    }
  }
}
