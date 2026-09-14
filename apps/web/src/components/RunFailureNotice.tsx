import type { RunFailure } from '@agent-console/shared';

export function RunFailureNotice({ failure, onStop }: { failure: RunFailure; onStop: () => void }) {
  const retrying = failure.status === 'retrying';
  const scheduled = failure.status === 'scheduled';
  return (
    <div role="alert" className="shrink-0 border-b border-amber-400/40 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
      <p className="font-semibold">{scheduled ? 'Run stopped — automatic retry scheduled' : retrying ? 'Continuing after a provider failure' : 'Run stopped'}</p>
      <p className="mt-1 break-words">{failure.message}</p>
      <p className="mt-1 text-amber-200/80">
        {scheduled && failure.nextRetryAt ? `Retry ${failure.attempts + 1} of ${failure.maxAttempts} at ${new Date(failure.nextRetryAt).toLocaleTimeString()}. ` : null}
        {retrying ? `Recovery attempt ${failure.attempts} of ${failure.maxAttempts}. ` : null}
        {failure.status === 'stopped' ? `${failure.stoppedReason ?? 'Automatic recovery is stopped.'} You can continue by sending a message.` : 'New input or Stop cancels automatic recovery.'}
      </p>
      {failure.status !== 'stopped' && <button type="button" onClick={onStop} className="mt-2 min-h-11 rounded-md border border-amber-300/50 px-3 py-2">Stop automatic recovery</button>}
    </div>
  );
}
