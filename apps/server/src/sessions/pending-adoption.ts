import type { BoundSession, ConversationSummary, ProviderId } from '@agent-console/shared';
import { AppDatabase } from '../db/database.js';
import { getPendingConversationMatchTimestamp } from '../lib/pending-conversation-match.js';
import { nowIso } from '../lib/time.js';
import { normalizeComparableText, stableTextHash, truncate } from '../lib/text.js';

const PENDING_ADOPTION_MATCH_WINDOW_MS = 30 * 60 * 1000;

export function pendingConversationHasRecordedUserInput(pending: ConversationSummary | undefined): boolean {
  return typeof pending?.rawMetadata?.lastUserInputHash === 'string';
}

export function recordPendingUserInput(input: {
  db: AppDatabase;
  pendingRef: string;
  boundSessionId: string;
  text: string;
  inputAt?: string;
}): ConversationSummary | undefined {
  return input.db.transaction(() => {
    const pending = input.db.getPendingConversation(input.pendingRef);
    if (!pending) {
      return undefined;
    }
    const inputAt = input.inputAt ?? nowIso();
    const rawMetadata = { ...(pending.rawMetadata ?? {}) } as Record<string, unknown>;
    rawMetadata.lastUserInputHash = stableTextHash(normalizeComparableText(input.text));
    rawMetadata.lastUserInputPreview = truncate(input.text, 120);
    rawMetadata.lastUserInputAt = inputAt;
    const updated = {
      ...pending,
      updatedAt: inputAt,
      isBound: true,
      boundSessionId: input.boundSessionId,
      rawMetadata,
    };
    input.db.putPendingConversation(updated);
    return updated;
  });
}

export function scorePendingMatch(
  pendingLastUserHash: string | undefined,
  conversation: ConversationSummary,
): number {
  const rawMetadata = conversation.rawMetadata ?? {};
  const candidateHashes = [
    rawMetadata.lastUserTextHash,
    rawMetadata.firstUserTextHash,
  ].filter((value): value is string => typeof value === 'string');

  if (pendingLastUserHash) {
    return candidateHashes.includes(pendingLastUserHash) ? 0 : -1;
  }

  return -1;
}

export function findPendingAdoptionMatch(
  pending: ConversationSummary,
  conversations: ConversationSummary[],
  options: { claimedRefs?: Set<string> } = {},
): ConversationSummary | undefined {
  const pendingTimestamp = getPendingConversationMatchTimestamp(pending);
  const pendingLastUserHash = typeof pending.rawMetadata?.lastUserInputHash === 'string'
    ? pending.rawMetadata.lastUserInputHash
    : undefined;
  if (!Number.isFinite(pendingTimestamp) || !pendingLastUserHash) {
    return undefined;
  }

  return conversations
    .filter((conversation) => !options.claimedRefs?.has(conversation.ref) && conversation.ref !== pending.ref)
    .map((conversation) => ({
      conversation,
      delta: Math.abs(Date.parse(conversation.createdAt ?? conversation.updatedAt) - pendingTimestamp),
      score: scorePendingMatch(pendingLastUserHash, conversation),
    }))
    .filter(({ delta, score }) => score >= 0 && Number.isFinite(delta) && delta <= PENDING_ADOPTION_MATCH_WINDOW_MS)
    .sort((a, b) => a.score - b.score || a.delta - b.delta)[0]?.conversation;
}

export function adoptPendingConversation(input: {
  db: AppDatabase;
  projectSlug: string;
  providerId: ProviderId;
  pendingRef: string;
  matchedConversation: ConversationSummary;
  adoptedAt?: string;
}): { adopted: boolean; reboundSession?: BoundSession } {
  return input.db.transaction(() => {
    const pending = input.db.getPendingConversation(input.pendingRef);
    if (!pending || typeof pending.rawMetadata?.adoptedConversationRef === 'string') {
      return { adopted: false };
    }

    const adoptedAt = input.adoptedAt ?? nowIso();
    const titleOverride = input.db.getConversationTitleOverride(input.projectSlug, input.providerId, pending.ref);
    if (titleOverride) {
      input.db.setConversationTitleOverride(
        input.projectSlug,
        input.providerId,
        input.matchedConversation.ref,
        titleOverride.title,
        adoptedAt,
      );
      input.db.deleteConversationTitleOverride(input.projectSlug, input.providerId, pending.ref);
    }

    const session = pending.boundSessionId
      ? input.db.getBoundSessionById(pending.boundSessionId)
      : input.db.getBoundSessionByConversation(input.projectSlug, input.providerId, pending.ref);
    const reboundSession = session && session.shouldRestore && session.conversationRef === pending.ref
      ? {
          ...session,
          conversationRef: input.matchedConversation.ref,
          resumeConversationRef: input.matchedConversation.ref,
          title: input.matchedConversation.title,
          updatedAt: adoptedAt,
        }
      : undefined;
    if (reboundSession) {
      input.db.upsertBoundSession(reboundSession);
    }

    input.db.putPendingConversation({
      ...pending,
      isBound: false,
      boundSessionId: undefined,
      updatedAt: adoptedAt,
      transcriptPath: input.matchedConversation.transcriptPath,
      rawMetadata: {
        ...(pending.rawMetadata ?? {}),
        adoptedConversationRef: input.matchedConversation.ref,
        adoptedTranscriptPath: input.matchedConversation.transcriptPath,
        adoptedAt,
      },
    });

    return { adopted: true, reboundSession };
  });
}

export function clearPendingRestoreBinding(input: {
  db: AppDatabase;
  session: BoundSession;
  updatedAt?: string;
}): BoundSession {
  const updatedAt = input.updatedAt ?? nowIso();
  return input.db.transaction(() => {
    const pending = input.session.conversationRef.startsWith('pending:')
      ? input.db.getPendingConversation(input.session.conversationRef)
      : undefined;
    if (pending) {
      input.db.putPendingConversation({
        ...pending,
        isBound: false,
        boundSessionId: undefined,
        updatedAt,
      });
    }

    const ended: BoundSession = {
      ...input.session,
      status: 'ended',
      shouldRestore: false,
      updatedAt,
      isWorking: false,
    };
    input.db.upsertBoundSession(ended);
    return ended;
  });
}

export function markPendingSessionNotLive(input: {
  db: AppDatabase;
  session: BoundSession;
  updatedAt?: string;
}): { failed: BoundSession; shouldEmitFailure: boolean } {
  const updatedAt = input.updatedAt ?? nowIso();
  return input.db.transaction(() => {
    const pending = input.session.conversationRef.startsWith('pending:')
      ? input.db.getPendingConversation(input.session.conversationRef)
      : undefined;
    if (pending) {
      input.db.putPendingConversation({
        ...pending,
        isBound: false,
        boundSessionId: undefined,
        updatedAt: pending.updatedAt,
      });
    }

    const failed: BoundSession = {
      ...input.session,
      status: 'error',
      updatedAt,
      isWorking: false,
      pid: undefined,
    };
    const shouldEmitFailure = input.session.status !== 'error';
    input.db.upsertBoundSession(failed);
    return { failed, shouldEmitFailure };
  });
}
