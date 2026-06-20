import type { ConversationSummary } from '@agent-console/shared';

type VisibilityConversation = Pick<ConversationSummary, 'title'> & Partial<Pick<ConversationSummary, 'provider' | 'rawMetadata'>>;

export function isSystemInvocationConversationTitle(title: string): boolean {
  return title.trimStart().startsWith('#');
}

export function isCodexExecInvocationConversation(conversation: Partial<Pick<ConversationSummary, 'provider' | 'rawMetadata'>>): boolean {
  if (conversation.provider !== 'codex') {
    return false;
  }
  return conversation.rawMetadata?.originator === 'codex_exec'
    || conversation.rawMetadata?.source === 'exec';
}

export function isConversationVisibleInDiscovery(conversation: VisibilityConversation): boolean {
  return !isSystemInvocationConversationTitle(conversation.title)
    && !isCodexExecInvocationConversation(conversation);
}
