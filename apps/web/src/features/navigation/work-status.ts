import type { RunFailure } from '@agent-console/shared';

export function getConversationStatusClass(
  isBound: boolean,
  lastResponseAt: string | undefined,
  isWorking: boolean,
  nowMs: number,
  runFailure?: RunFailure,
): string {
  if (!isBound) return 'border border-slate-700 bg-transparent';
  if (isWorking) return 'bg-rose-500';
  if (runFailure && runFailure.status !== 'retrying') return 'bg-slate-500';

  const responseMs = lastResponseAt ? Date.parse(lastResponseAt) : Number.NaN;
  if (!Number.isFinite(responseMs)) return 'bg-slate-500';
  const ageMinutes = Math.max(0, nowMs - responseMs) / 60_000;
  if (ageMinutes < 60) return 'bg-emerald-400';
  if (ageMinutes < 12 * 60) return 'bg-yellow-400';
  if (ageMinutes < 48 * 60) return 'bg-amber-500';
  return 'bg-violet-500';
}
