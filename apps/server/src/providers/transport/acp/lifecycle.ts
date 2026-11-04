export type HandshakeKind = 'reattach' | 'survivor' | 'launch';

/**
 * What a failed handshake does with the process.
 * `replace`: an ordinary open, and the process has stayed silent past the limit — end it so the caller starts another.
 * `busy-leave`: it may be running a turn — disconnect and report busy. A reattach always lands here when it times out.
 * `fail-fresh`: this call started the process and it failed — end it.
 * `fail-existing`: a process this call did not start failed for a reason other than a timeout — disconnect, do not end it.
 */
export type HandshakeFailureAction = 'replace' | 'busy-leave' | 'fail-fresh' | 'fail-existing';

export function decideHandshakeFailure(input: {
  kind: HandshakeKind;
  fresh: boolean;
  timedOut: boolean;
  /** How long the run of handshake timeouts has lasted. Only read when the process is treated as busy and this is not a reattach. */
  silentForMs: number;
  limitMs: number;
}): HandshakeFailureAction {
  const busy = input.timedOut && (input.kind !== 'launch' || !input.fresh);
  if (busy && input.kind !== 'reattach' && input.silentForMs >= input.limitMs) return 'replace';
  if (busy) return 'busy-leave';
  if (input.fresh) return 'fail-fresh';
  return 'fail-existing';
}
