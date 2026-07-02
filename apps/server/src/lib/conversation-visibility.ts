import type { BoundSession, ConversationSummary, ProviderId } from '@agent-console/shared';

type VisibilityConversation = Pick<ConversationSummary, 'title'> & Partial<Pick<ConversationSummary, 'provider' | 'rawMetadata'>>;
type SessionVisibilityLookup = {
  getPendingConversation(ref: string): ConversationSummary | undefined;
  getIndexedConversation(projectSlug: string, provider: ProviderId, conversationRef: string): ConversationSummary | undefined;
};

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

export function isBoundSessionVisibleInDiscovery(
  session: BoundSession,
  lookup: SessionVisibilityLookup,
): boolean {
  const summary = session.conversationRef.startsWith('pending:')
    ? lookup.getPendingConversation(session.conversationRef)
    : lookup.getIndexedConversation(session.projectSlug, session.provider, session.conversationRef);
  return isConversationVisibleInDiscovery(summary ?? {
    title: session.title ?? 'Live session',
    provider: session.provider,
  });
}
