import type { ConversationSummary } from '@agent-console/shared';

export function isSystemInvocationConversationTitle(title: string): boolean {
  return title.trimStart().startsWith('#');
}

export function isConversationVisibleInDiscovery(conversation: Pick<ConversationSummary, 'title'>): boolean {
  return !isSystemInvocationConversationTitle(conversation.title);
}
