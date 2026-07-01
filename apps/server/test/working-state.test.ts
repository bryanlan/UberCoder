import { describe, expect, it } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { nextIdleExpiryDecision, nextScreenWorkingState } from '../src/sessions/working-state.js';

function session(input: Partial<BoundSession> = {}): BoundSession {
  return {
    id: 'session-working',
    provider: 'codex',
    projectSlug: 'demo',
    conversationRef: 'conversation-1',
    tmuxSessionName: 'ac-codex-demo-working',
    status: 'bound',
    shouldRestore: true,
    startedAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    isWorking: false,
    ...input,
  };
}

describe('working-state reducer', () => {
  it('keeps recent output working on repaint without moving recency fields', () => {
    const current = session({
      updatedAt: '2026-03-01T00:00:05.000Z',
      lastActivityAt: '2026-03-01T00:00:05.000Z',
      lastOutputAt: '2026-03-01T00:00:10.000Z',
      isWorking: false,
    });

    const next = nextScreenWorkingState(current, {
      screenShowsWorking: false,
      capturedAt: '2026-03-01T00:00:20.000Z',
      idleMs: 60_000,
    });

    expect(next.expiryHeartbeatAt).toBe('2026-03-01T00:00:10.000Z');
    expect(next.updatedSession).toMatchObject({
      updatedAt: '2026-03-01T00:00:20.000Z',
      lastActivityAt: '2026-03-01T00:00:05.000Z',
      lastOutputAt: '2026-03-01T00:00:10.000Z',
      isWorking: true,
    });
  });

  it('clears working on stale repaint without inventing a completion timestamp', () => {
    const current = session({
      isWorking: true,
      lastOutputAt: '2026-03-01T00:00:00.000Z',
      lastCompletedAt: '2026-02-29T23:59:00.000Z',
    });

    const next = nextScreenWorkingState(current, {
      screenShowsWorking: false,
      capturedAt: '2026-03-01T00:02:00.000Z',
      idleMs: 60_000,
    });

    expect(next.clearExpiry).toBe(true);
    expect(next.updatedSession).toMatchObject({
      isWorking: false,
      lastCompletedAt: '2026-02-29T23:59:00.000Z',
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
