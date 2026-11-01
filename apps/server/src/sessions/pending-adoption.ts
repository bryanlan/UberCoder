import type { BoundSession, ConversationSummary, ProviderId } from '@agent-console/shared';
import { AppDatabase } from '../db/database.js';
import { nowIso } from '../lib/time.js';

// A new chat starts as a pending alias (`pending:<uuid>`). Its bind learns the provider's native id at once, and the native
// conversation adopts the alias here, so a read of the alias resolves to it.

export function adoptPendingConversation(input: {
  db: AppDatabase;
  projectSlug: string;
  providerId: ProviderId;
  pendingRef: string;
  matchedConversation: ConversationSummary;
  adoptedAt?: string;
}): { adopted: boolean; reboundSession?: BoundSession } {
  return input.db.transaction(() => {
    const pending = input.db.pendingConversations.get(input.pendingRef);
    if (!pending || typeof pending.rawMetadata?.adoptedConversationRef === 'string') {
      return { adopted: false };
    }

    const boundId = pending.boundSessionId ?? input.db.boundSessions.getRestorableByConversation(input.projectSlug, input.providerId, pending.ref)?.id;
    const existingOwner = input.db.boundSessions.getRestorableByConversation(input.projectSlug, input.providerId, input.matchedConversation.ref);
    if (existingOwner && existingOwner.id !== boundId) return { adopted: false };

    // Persist the native ref and transcript path in the same transaction as the
    // binding. Polling, transcript watchers and alias reads use this index.
    input.db.conversationIndex.upsert(input.matchedConversation);

    const adoptedAt = input.adoptedAt ?? nowIso();
    const titleOverride = input.db.titleOverrides.get(input.projectSlug, input.providerId, pending.ref);
    if (titleOverride) {
      input.db.titleOverrides.set(
        input.projectSlug,
        input.providerId,
        input.matchedConversation.ref,
        titleOverride.title,
        adoptedAt,
      );
      input.db.titleOverrides.delete(input.projectSlug, input.providerId, pending.ref);
    }

    const session = pending.boundSessionId
      ? input.db.boundSessions.getById(pending.boundSessionId)
      : input.db.boundSessions.getRestorableByConversation(input.projectSlug, input.providerId, pending.ref);
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
      input.db.boundSessions.upsert(reboundSession);
    }

    input.db.pendingConversations.put({
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
      ? input.db.pendingConversations.get(input.session.conversationRef)
      : undefined;
    if (pending) {
      input.db.pendingConversations.put({
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
    input.db.boundSessions.upsert(ended);
    return ended;
  });
}
