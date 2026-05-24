import type { ConversationSummary } from '@agent-console/shared';

export function getPendingConversationMatchTimestamp(pending: ConversationSummary): number {
  const hasRecordedUserInput = typeof pending.rawMetadata?.lastUserInputHash === 'string';
  const recordedAt = typeof pending.rawMetadata?.lastUserInputAt === 'string'
    ? Date.parse(pending.rawMetadata.lastUserInputAt)
    : NaN;
  if (hasRecordedUserInput && Number.isFinite(recordedAt)) {
    return recordedAt;
  }

  const updatedAt = Date.parse(pending.updatedAt);
  if (hasRecordedUserInput && Number.isFinite(updatedAt)) {
    return updatedAt;
  }

  return Date.parse(pending.createdAt ?? pending.updatedAt);
}
