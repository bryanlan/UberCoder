import type { RunFailure } from '@agent-console/shared';

type ConversationStatusColor = 'unbound' | 'red' | 'gray' | 'green' | 'yellow' | 'amber' | 'purple';

export const conversationStatusClasses: Record<ConversationStatusColor, string> = {
  unbound: 'border border-slate-700 bg-transparent',
  red: 'bg-rose-500',
  gray: 'bg-slate-500',
  green: 'bg-emerald-400',
  yellow: 'bg-yellow-400',
  amber: 'bg-amber-500',
  purple: 'bg-violet-500',
};

export function getConversationStatusColor(
  isBound: boolean,
  lastResponseAt: string | undefined,
  isWorking: boolean,
  nowMs: number,
  runFailure?: RunFailure,
): ConversationStatusColor {
  if (!isBound) return 'unbound';
  if (isWorking) return 'red';
  if (runFailure && runFailure.status !== 'retrying') return 'gray';

  const responseMs = lastResponseAt ? Date.parse(lastResponseAt) : Number.NaN;
  if (!Number.isFinite(responseMs)) return 'gray';
  const ageMinutes = Math.max(0, nowMs - responseMs) / 60_000;
  if (ageMinutes < 60) return 'green';
  if (ageMinutes < 12 * 60) return 'yellow';
  if (ageMinutes < 48 * 60) return 'amber';
  return 'purple';
}
