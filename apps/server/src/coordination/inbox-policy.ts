import type { AssignmentContinuation } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';

export const DEFAULT_WAITING_INBOX_COOLDOWN_MS = 10 * 60_000;
export const inboxWakeKey = (assignmentId: string) => `inbox-last-wake:${assignmentId}`;
export const urgentMessageKey = (messageId: string) => `inbox-urgent:${messageId}`;
export const sendOnlyKey = (assignmentId: string) => `inbox-send-only:${assignmentId}`;

export const isUrgentMessage = (db: AppDatabase, messageId: string) => db.meta.get(urgentMessageKey(messageId)) === 'true';
export const acceptsMessages = (db: AppDatabase, assignmentId: string) => db.meta.get(sendOnlyKey(assignmentId)) !== 'true';

/** A scheduling deadline only. Native hooks may deliver the inbox earlier. */
export function routineInboxWakeAt(db: AppDatabase, assignmentId: string, continuation: AssignmentContinuation,
  cooldownMs = DEFAULT_WAITING_INBOX_COOLDOWN_MS, now = Date.now()): string | undefined {
  if (continuation !== 'waiting_for_input') return;
  const last = Date.parse(db.meta.get(inboxWakeKey(assignmentId)) ?? '');
  if (Number.isFinite(last) && now < last + cooldownMs) return new Date(last + cooldownMs).toISOString();
}
