import type { BoundSession, ConversationSummary, SessionInteractionSummary } from '@agent-console/shared';

function latestTimestamp(...timestamps: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const timestamp of timestamps) {
    if (!timestamp) {
      continue;
    }
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || parsed <= latestMs) {
      continue;
    }
    latest = timestamp;
    latestMs = parsed;
  }
  return latest;
}

export function getBoundSessionConversationUpdatedAt(
  session: BoundSession,
  conversation?: Pick<ConversationSummary, 'updatedAt'>,
): string {
  return latestTimestamp(
    session.lastCompletedAt,
    session.lastOutputAt,
    session.lastActivityAt,
    conversation?.updatedAt,
    session.startedAt,
  ) ?? session.startedAt;
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
