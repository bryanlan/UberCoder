import type { ConversationSummary } from '@agent-console/shared';

export function compareConversationDiscoveryOrder(a: ConversationSummary, b: ConversationSummary): number {
  const aPlacedAt = a.createdAt ?? a.updatedAt;
  const bPlacedAt = b.createdAt ?? b.updatedAt;
  const placedAtComparison = bPlacedAt.localeCompare(aPlacedAt);
  return placedAtComparison || a.ref.localeCompare(b.ref);
}

export function ensureProviderFlag(argv: string[], flag: string): string[] {
  if (argv.length === 0 || argv.includes(flag)) {
    return argv;
  }
  const command = argv[0]!;
  const rest = argv.slice(1);
  return [command, flag, ...rest];
}
