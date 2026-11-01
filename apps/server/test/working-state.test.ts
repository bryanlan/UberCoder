import { describe, expect, it } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { nextIdleExpiryDecision, nextWorkingState } from '../src/sessions/working-state.js';

function session(input: Partial<BoundSession> = {}): BoundSession {
  return {
    id: 'session-working',
    provider: 'codex',
    projectSlug: 'demo',
    conversationRef: 'conversation-1',
    status: 'bound',
    shouldRestore: true,
    startedAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    isWorking: false,
    ...input,
  };
}

describe('working-state reducer', () => {
  it('releases a completed provider turn immediately but retains the recency idle timer', () => {
    const current = session({ isWorking: true, lastOutputAt: '2026-03-01T00:00:10.000Z' });
    const next = nextWorkingState(current, { turnIsWorking: false, capturedAt: '2026-03-01T00:00:11.000Z' });
    expect(next.updatedSession).toMatchObject({ isWorking: false });
    expect(next.updatedSession?.lastCompletedAt).toBeUndefined();
    expect(next.expiryHeartbeatAt).toBe(current.lastOutputAt);
    expect(next.clearExpiry).toBe(false);
    const expiry = nextIdleExpiryDecision(next.updatedSession!, {
      expectedHeartbeatAt: current.lastOutputAt!, now: '2026-03-01T00:01:11.000Z', idleMs: 60_000,
      turnIsWorking: false,
    });
    expect(expiry).toMatchObject({ action: 'update', updatedSession: { isWorking: false, lastCompletedAt: current.lastOutputAt } });
  });

  it('does not mistake a quiet but running provider turn for completion', () => {
    const current = session({ isWorking: true, lastOutputAt: '2026-03-01T00:00:10.000Z' });
    expect(nextWorkingState(current, { turnIsWorking: true, capturedAt: '2026-03-01T00:02:00.000Z' }).nextIsWorking).toBe(true);
    expect(nextIdleExpiryDecision(current, {
      expectedHeartbeatAt: current.lastOutputAt!, now: '2026-03-01T00:02:00.000Z', idleMs: 60_000,
      turnIsWorking: true,
    })).toEqual({ action: 'clear' });
  });

  it('marks a row working when the provider reports a turn, without moving recency fields', () => {
    const current = session({
      updatedAt: '2026-03-01T00:00:05.000Z',
      lastActivityAt: '2026-03-01T00:00:05.000Z',
      lastOutputAt: '2026-03-01T00:00:10.000Z',
      isWorking: false,
    });

    const next = nextWorkingState(current, { turnIsWorking: true, capturedAt: '2026-03-01T00:00:20.000Z' });

    expect(next.expiryHeartbeatAt).toBe('2026-03-01T00:00:10.000Z');
    expect(next.updatedSession).toMatchObject({
      updatedAt: '2026-03-01T00:00:20.000Z',
      lastActivityAt: '2026-03-01T00:00:05.000Z',
      lastOutputAt: '2026-03-01T00:00:10.000Z',
      isWorking: true,
    });
  });

  it('holds working down while a run failure is stopped, whatever the provider reports', () => {
    const current = session({
      isWorking: true,
      lastOutputAt: '2026-03-01T00:00:00.000Z',
      lastCompletedAt: '2026-03-01T00:00:00.000Z',
      runFailure: { turnId: 't', failedAt: '2026-03-01T00:00:00.000Z', code: 'x', message: 'x', attempts: 3, maxAttempts: 3, status: 'stopped' },
    });

    const next = nextWorkingState(current, { turnIsWorking: true, capturedAt: '2026-03-01T00:02:00.000Z' });

    expect(next.clearExpiry).toBe(true);
    expect(next.updatedSession).toMatchObject({
      isWorking: false,
      lastCompletedAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:02:00.000Z',
    });
  });

  it('reschedules idle expiry when a newer output heartbeat wins the race', () => {
    const decision = nextIdleExpiryDecision(session({
      isWorking: true,
      lastOutputAt: '2026-03-01T00:00:30.000Z',
    }), {
      expectedHeartbeatAt: '2026-03-01T00:00:10.000Z',
      now: '2026-03-01T00:01:20.000Z',
      idleMs: 60_000,
    });

    expect(decision).toEqual({
      action: 'reschedule',
      heartbeatAt: '2026-03-01T00:00:30.000Z',
    });
  });

  it('marks output completed only when the expected heartbeat is stale', () => {
    const decision = nextIdleExpiryDecision(session({
      isWorking: true,
      lastOutputAt: '2026-03-01T00:00:10.000Z',
    }), {
      expectedHeartbeatAt: '2026-03-01T00:00:10.000Z',
      now: '2026-03-01T00:01:20.000Z',
      idleMs: 60_000,
    });

    expect(decision.action).toBe('update');
    if (decision.action === 'update') {
      expect(decision.updatedSession).toMatchObject({
        isWorking: false,
        lastCompletedAt: '2026-03-01T00:00:10.000Z',
        updatedAt: '2026-03-01T00:01:20.000Z',
      });
    }
  });
});
