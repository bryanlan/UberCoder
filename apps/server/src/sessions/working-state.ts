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
  const nextIsWorking = outputIsCoolingDown
    || (input.screenShowsWorking && isRecentTimestamp(workingHeartbeatAt, input.capturedAt, input.idleMs));
  const nextLastCompletedAt = session.lastCompletedAt;
  const expiryHeartbeatAt = nextIsWorking
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
    clearExpiry: !nextIsWorking,
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
  },
): IdleExpiryDecision {
  if (!session.isWorking) {
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
