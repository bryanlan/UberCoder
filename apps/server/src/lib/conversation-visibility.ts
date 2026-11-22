import type { BoundSession, ConversationSummary, ProviderId } from '@agent-console/shared';

type VisibilityConversation = Pick<ConversationSummary, 'title'> & Partial<Pick<ConversationSummary, 'provider' | 'rawMetadata'>>;
type SessionVisibilityLookup = {
  getPendingConversation(ref: string): ConversationSummary | undefined;
  getIndexedConversation(projectSlug: string, provider: ProviderId, conversationRef: string): ConversationSummary | undefined;
};

// An automated prompt opens with a markdown heading ("### Review ..."). A title
// such as "#109 lane" is an issue reference, not a heading, and stays visible.
export function isSystemInvocationConversationTitle(title: string): boolean {
  return /^#+(\s|$)/.test(title.trimStart());
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
