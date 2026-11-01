import type { BoundSession } from '@agent-console/shared';

export function isRecentTimestamp(timestamp: string | undefined, referenceTimestamp: string, maxAgeMs: number): boolean {
  if (!timestamp) {
    return false;
  }

  const referenceMs = Date.parse(referenceTimestamp);
  const valueMs = Date.parse(timestamp);
  if (!Number.isFinite(referenceMs) || !Number.isFinite(valueMs)) {
    return false;
  }

  return referenceMs - valueMs <= maxAgeMs;
}

/**
 * The working flag a row should carry now. The provider's own turn state decides it (a conversation that is not loaded runs
 * nothing); a stopped run failure holds it down. Output that arrived after the last completion keeps an expiry armed, so the row's
 * completion time is recorded once the output has been quiet for the idle window.
 */
export function nextWorkingState(
  session: BoundSession,
  input: {
    /** Authoritative provider lifecycle; independent of recency. */
    turnIsWorking: boolean;
    capturedAt: string;
  },
): {
  nextIsWorking: boolean;
  expiryHeartbeatAt?: string;
  clearExpiry: boolean;
  updatedSession?: BoundSession;
} {
  const failureStopped = session.runFailure && session.runFailure.status !== 'retrying';
  const nextIsWorking = !failureStopped && input.turnIsWorking;
  const pendingCompletion = !input.turnIsWorking && session.lastOutputAt && session.lastOutputAt !== session.lastCompletedAt;
  const expiryHeartbeatAt = nextIsWorking || pendingCompletion ? session.lastOutputAt : undefined;
  const updatedSession = session.isWorking === nextIsWorking
    ? undefined
    : { ...session, updatedAt: input.capturedAt, isWorking: nextIsWorking };

  return {
    nextIsWorking,
    expiryHeartbeatAt,
    clearExpiry: !expiryHeartbeatAt,
    updatedSession,
  };
}

export type IdleExpiryDecision =
  | { action: 'clear' }
  | { action: 'reschedule'; heartbeatAt: string }
  | { action: 'update'; updatedSession: BoundSession };

export function nextIdleExpiryDecision(
  session: BoundSession,
  input: {
    expectedHeartbeatAt: string;
    now: string;
    idleMs: number;
    turnIsWorking?: boolean;
    /**
     * The provider says a turn is running that the transport has not named. Its terminal event may
     * never come: the unnamed period can end by the thread going idle, with the turn's own end dropped. So the expiry looks again
     * after an idle window instead of ending, and the first look after the period ends settles the row.
     */
    turnUnidentified?: boolean;
  },
): IdleExpiryDecision {
  if (session.runFailure && session.runFailure.status !== 'retrying') {
    return { action: 'clear' };
  }
  if (input.turnIsWorking === true) {
    return input.turnUnidentified ? { action: 'reschedule', heartbeatAt: input.now } : { action: 'clear' };
  }
  if (!session.isWorking && (input.turnIsWorking !== false || !session.lastOutputAt || session.lastOutputAt === session.lastCompletedAt)) {
    return { action: 'clear' };
  }

  const latestHeartbeatAt = session.lastOutputAt;
  if (latestHeartbeatAt && latestHeartbeatAt !== input.expectedHeartbeatAt) {
    return { action: 'reschedule', heartbeatAt: latestHeartbeatAt };
  }

  if (isRecentTimestamp(latestHeartbeatAt, input.now, input.idleMs)) {
    return latestHeartbeatAt
      ? { action: 'reschedule', heartbeatAt: latestHeartbeatAt }
      : { action: 'clear' };
  }

  const completedAt = session.lastOutputAt;
  const updatedSession = completedAt
    ? {
        ...session,
        updatedAt: input.now,
        isWorking: false,
        lastCompletedAt: completedAt,
      }
    : {
        ...session,
        updatedAt: input.now,
        isWorking: false,
      };

  return { action: 'update', updatedSession };
}
