import { describe, expect, it, vi } from 'vitest';
import { checkTmuxLiveness } from '../src/sessions/tmux-health.js';
import { TmuxError, isTmuxSessionMissingError } from '../src/sessions/tmux-client.js';

describe('tmux liveness', () => {
  it('classifies explicit missing-session tmux errors as definitive misses', () => {
    expect(isTmuxSessionMissingError(new TmuxError(
      "can't find session: agent-console",
      ['has-session', '-t', 'agent-console'],
      1,
      "can't find session: agent-console",
    ))).toBe(true);
    expect(isTmuxSessionMissingError(new TmuxError(
      'no server running on /tmp/tmux-1000/default',
      ['has-session', '-t', 'agent-console'],
      1,
      'no server running on /tmp/tmux-1000/default',
    ))).toBe(true);
    expect(isTmuxSessionMissingError(new TmuxError(
      'error connecting to /tmp/tmux-1000/default (No such file or directory)',
      ['has-session', '-t', 'agent-console'],
      1,
      'error connecting to /tmp/tmux-1000/default (No such file or directory)',
    ))).toBe(true);
  });

  it('does not classify spawn failures or unrelated tmux failures as missing sessions', () => {
    expect(isTmuxSessionMissingError(new TmuxError(
      'spawn tmux ENOENT',
      ['has-session', '-t', 'agent-console'],
      undefined,
      '',
    ))).toBe(false);
    expect(isTmuxSessionMissingError(new TmuxError(
      'connection timed out',
      ['has-session', '-t', 'agent-console'],
      1,
      'connection timed out',
    ))).toBe(false);
  });

  it('reports alive immediately when the first probe succeeds', async () => {
    const hasSession = vi.fn(async () => true);

    await expect(checkTmuxLiveness({ hasSession }, 'agent-console', { retryDelayMs: 0 })).resolves.toBe('alive');

    expect(hasSession).toHaveBeenCalledTimes(1);
  });

  it('requires two consecutive definitive misses before reporting dead', async () => {
    const hasSession = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    await expect(checkTmuxLiveness({ hasSession }, 'agent-console', { retryDelayMs: 0 })).resolves.toBe('dead');

    expect(hasSession).toHaveBeenCalledTimes(2);
  });

  it('treats a second successful probe as alive', async () => {
    const hasSession = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(checkTmuxLiveness({ hasSession }, 'agent-console', { retryDelayMs: 0 })).resolves.toBe('alive');
  });

  it('reports unknown instead of dead when either probe throws', async () => {
    await expect(checkTmuxLiveness(
      { hasSession: vi.fn(async () => { throw new Error('tmux timed out'); }) },
      'agent-console',
      { retryDelayMs: 0 },
    )).resolves.toBe('unknown');

    const hasSession = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('tmux timed out'));
    await expect(checkTmuxLiveness({ hasSession }, 'agent-console', { retryDelayMs: 0 })).resolves.toBe('unknown');
  });
});
