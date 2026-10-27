import type { BoundSession } from '@agent-console/shared';

export function latestTimestamp(...timestamps: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const timestamp of timestamps) {
    if (!timestamp) {
      continue;
    }
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || parsed <= latestMs) {
      continue;
    }
    latest = timestamp;
    latestMs = parsed;
  }
  return latest;
}

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

export function nextScreenWorkingState(
  session: BoundSession,
  input: {
    screenShowsWorking: boolean;
    /** Authoritative provider lifecycle, when available; independent of recency. */
    turnIsWorking?: boolean;
    capturedAt: string;
    idleMs: number;
  },
): {
  nextIsWorking: boolean;
  nextLastCompletedAt: string | undefined;
  expiryHeartbeatAt?: string;
  clearExpiry: boolean;
  updatedSession?: BoundSession;
} {
  const workingHeartbeatAt = latestTimestamp(
    session.lastOutputAt,
    input.screenShowsWorking ? session.lastActivityAt : undefined,
  );
  const outputIsCoolingDown = isRecentTimestamp(session.lastOutputAt, input.capturedAt, input.idleMs);
  const failureStopped = session.runFailure && session.runFailure.status !== 'retrying';
  const nextIsWorking = !failureStopped && (input.turnIsWorking ?? (outputIsCoolingDown
    || (input.screenShowsWorking && isRecentTimestamp(workingHeartbeatAt, input.capturedAt, input.idleMs))));
  const nextLastCompletedAt = session.lastCompletedAt;
  const pendingCompletion = input.turnIsWorking === false && session.lastOutputAt
    && session.lastOutputAt !== session.lastCompletedAt;
  const expiryHeartbeatAt = nextIsWorking || pendingCompletion
    ? session.lastOutputAt ?? workingHeartbeatAt
    : undefined;

  const updatedSession = session.isWorking === nextIsWorking && session.lastCompletedAt === nextLastCompletedAt
    ? undefined
    : {
        ...session,
        updatedAt: input.capturedAt,
        isWorking: nextIsWorking,
        lastCompletedAt: nextLastCompletedAt,
      };

  return {
    nextIsWorking,
    nextLastCompletedAt,
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
     * The provider says a turn is running that the transport has not named (structured sessions only). Its terminal event may
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
