import { describe, expect, it } from 'vitest';
import { getConversationStatusClass } from './work-status';

describe('Work mode status colors', () => {
  const now = Date.parse('2026-09-26T12:00:00.000Z');
  const ago = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();

  it('uses red for active work regardless of response age', () => {
    expect(getConversationStatusClass(true, ago(90), true, now)).toBe('bg-rose-500');
  });

  it.each([
    [0.99, 'bg-emerald-400'],
    [1, 'bg-yellow-400'],
    [11.99, 'bg-yellow-400'],
    [12, 'bg-amber-500'],
    [47.99, 'bg-amber-500'],
    [48, 'bg-violet-500'],
    [120, 'bg-violet-500'],
    [168, 'bg-violet-500'],
    [215.99, 'bg-violet-500'],
  ])('maps a response age of %s hours to %s', (hours, expected) => {
    expect(getConversationStatusClass(true, ago(hours), false, now)).toBe(expected);
  });

  it('shows unknown bound status and unbound history distinctly', () => {
    expect(getConversationStatusClass(true, undefined, false, now)).toBe('bg-slate-500');
    expect(getConversationStatusClass(false, ago(1), false, now)).toBe('border border-slate-700 bg-transparent');
  });

  it('does not show a prior response as ready after a provider failure', () => {
    expect(getConversationStatusClass(true, ago(0.5), false, now, {
      turnId: 'turn-2', failedAt: ago(0.1), code: 'unknown', message: 'Stopped',
      attempts: 0, maxAttempts: 3, status: 'stopped',
    })).toBe('bg-slate-500');
  });
});
