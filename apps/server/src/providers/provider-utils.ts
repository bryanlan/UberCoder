import type { ConversationSummary } from '@agent-console/shared';

export function compareConversationDiscoveryOrder(a: ConversationSummary, b: ConversationSummary): number {
  const aPlacedAt = a.createdAt ?? a.updatedAt;
  const bPlacedAt = b.createdAt ?? b.updatedAt;
  const placedAtComparison = bPlacedAt.localeCompare(aPlacedAt);
  return placedAtComparison || a.ref.localeCompare(b.ref);
}
