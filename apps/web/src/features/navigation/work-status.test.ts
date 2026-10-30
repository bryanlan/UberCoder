import { describe, expect, it } from 'vitest';
import { getConversationStatusColor } from './work-status';

describe('Work mode status colors', () => {
  const now = Date.parse('2026-09-26T12:00:00.000Z');
  const ago = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();

  it('uses red for active work regardless of response age', () => {
    expect(getConversationStatusColor(true, ago(90), true, now)).toBe('red');
  });

  it.each([
    [0.99, 'green'],
    [1, 'yellow'],
    [11.99, 'yellow'],
    [12, 'amber'],
    [47.99, 'amber'],
    [48, 'purple'],
    [120, 'purple'],
    [168, 'purple'],
    [215.99, 'purple'],
  ])('maps a response age of %s hours to %s', (hours, expected) => {
    expect(getConversationStatusColor(true, ago(hours), false, now)).toBe(expected);
  });

  it('shows unknown bound status and unbound history distinctly', () => {
    expect(getConversationStatusColor(true, undefined, false, now)).toBe('gray');
    expect(getConversationStatusColor(false, ago(1), false, now)).toBe('unbound');
  });

  it('does not show a prior response as ready after a provider failure', () => {
    expect(getConversationStatusColor(true, ago(0.5), false, now, {
      turnId: 'turn-2', failedAt: ago(0.1), code: 'unknown', message: 'Stopped',
      attempts: 0, maxAttempts: 3, status: 'stopped',
    })).toBe('gray');
  });
});
