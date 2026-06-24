import type { BoundSession, ConversationSummary, SessionInteractionSummary } from '@agent-console/shared';

export function getBoundSessionConversationUpdatedAt(
  session: BoundSession,
  conversation?: Pick<ConversationSummary, 'updatedAt'>,
): string {
  return session.lastCompletedAt
    ?? session.lastOutputAt
    ?? session.lastActivityAt
    ?? conversation?.updatedAt
    ?? session.startedAt;
}

export function buildSyntheticConversationFromSession(
  session: BoundSession,
  sessionSummary?: SessionInteractionSummary,
): ConversationSummary {
  return {
    ref: session.conversationRef,
    kind: session.conversationRef.startsWith('pending:') ? 'pending' : 'history',
    projectSlug: session.projectSlug,
    provider: session.provider,
    title: session.title ?? 'Live session',
    createdAt: session.startedAt,
    updatedAt: getBoundSessionConversationUpdatedAt(session),
    isBound: true,
    boundSessionId: session.id,
    degraded: false,
    rawMetadata: {
      syntheticSessionPlaceholder: true,
    },
    sessionSummary,
  };
}
