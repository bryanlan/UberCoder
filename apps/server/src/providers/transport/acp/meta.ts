/**
 * How long a running provider process may keep failing the handshake of ordinary opens before the next ordinary open ends
 * and replaces it. Until then a timeout only lets go of the connection and reports busy. A reattach never ends a process.
 */
export const UNRESPONSIVE_LIMIT_MS = 5 * 60_000;

/** After `session/cancel`, how long a turn may stay open before the plugin closes it locally. */
export const INTERRUPT_GRACE_MS = 10_000;

/** A session host id: the provider prefix, then letters, digits, `.`, `_` and `-` only, at most 128 characters. */
export function hostIdFor(prefix: string, conversationId: string): string {
  return `${prefix}-${conversationId.replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 128);
}

/** Where plugin meta keeps the argv a conversation was launched with, so a restart finds the same process. */
export function launchMetaKey(prefix: string, conversationId: string): string {
  return `${prefix}-launch:${conversationId}`;
}

/** Where plugin meta keeps the turn a surviving process may still be running. */
export function turnMetaKey(prefix: string, conversationId: string): string {
  return `${prefix}-turn:${conversationId}`;
}

/**
 * A request id larger than any this process used before, so a late answer to a request an earlier backend wrote never
 * matches a new one. The clock is `Date.now`, and two calls in the same millisecond still differ.
 */
export function createRequestIdClock(now: () => number = Date.now): () => number {
  let last = now();
  return () => {
    last = Math.max(last + 1, now());
    return last;
  };
}
