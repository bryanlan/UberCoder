import type { BoundSession, ConversationSummary } from '@agent-console/shared';

export function getBoundSessionConversationUpdatedAt(
  session: BoundSession,
  transcriptUpdatedAt?: string,
  fallbackUpdatedAt?: string,
): string {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  // updatedAt tracks maintenance as well as activity. startedAt may be a new binding of old history.
  for (const timestamp of [session.lastCompletedAt, session.lastOutputAt, session.lastActivityAt, transcriptUpdatedAt]) {
    if (!timestamp) continue;
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs <= latestMs) continue;
    latest = timestamp;
    latestMs = timestampMs;
  }
  return latest
    ?? (fallbackUpdatedAt && Number.isFinite(Date.parse(fallbackUpdatedAt)) ? fallbackUpdatedAt : session.startedAt);
}

export function buildSyntheticConversationFromSession(session: BoundSession): ConversationSummary {
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
  };
}
