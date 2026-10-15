import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionQueuedInput } from '@agent-console/shared';
import { api } from '../lib/api';

export function QueuedInputNotice({ sessionId, inputs, csrfToken }: {
  sessionId: string;
  inputs: SessionQueuedInput[];
  csrfToken?: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  async function cancel(requestId: string): Promise<void> {
    try {
      await api.cancelQueuedInput(sessionId, requestId, csrfToken);
      setError(undefined);
      await queryClient.invalidateQueries({ queryKey: ['session-screen', sessionId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not cancel the queued message.');
    }
  }
  return <div className="border-b border-sky-800/60 bg-sky-950/40 px-4 py-2 text-sm text-sky-100" role="status">
    {inputs.map(input => <div key={input.requestId} className="py-1">
      <div className="flex items-center gap-3">
        <span className="font-medium">{input.state === 'needs_review' ? 'Check delivery' : input.state === 'submitting' ? 'Sending…' : 'Queued'}</span>
        <span>{input.reason}</span>
        {input.state !== 'submitting' && <button type="button" className="ml-auto text-sky-300 hover:text-sky-200" onClick={() => { void cancel(input.requestId); }}>
          {input.state === 'needs_review' ? 'Dismiss' : 'Cancel queued send'}
        </button>}
      </div>
      <div className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-slate-300">{input.text}</div>
    </div>)}
    {error && <div className="text-rose-300">{error}</div>}
  </div>;
}
