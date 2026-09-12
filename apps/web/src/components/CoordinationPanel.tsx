import { useQuery } from '@tanstack/react-query';
import type { CoordinationSnapshot } from '@agent-console/shared';

export function CoordinationPanel({ checkout }: { checkout: string }) {
  const query = useQuery({
    queryKey: ['coordination', checkout],
    queryFn: async () => {
      const response = await fetch(`/api/assignment-activity?${new URLSearchParams({ checkout })}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Coordination is unavailable. Activity and message delivery cannot be verified. Work is not blocked.');
      return await response.json() as CoordinationSnapshot;
    },
    refetchInterval: 5000,
    retry: false,
  });
  if (query.error) return <div role="status" className="mx-4 my-1 text-xs text-amber-200">{query.error.message}</div>;
  const data = query.data;
  if (!data?.enabled) return null;
  const activeAssignments = data.assignments.filter((assignment) => assignment.status === 'active' || assignment.status === 'waiting');
  const label = (id: string) => {
    const assignment = data.assignments.find((item) => item.id === id);
    return assignment ? `${assignment.provider}: ${assignment.description}` : id.slice(0, 8);
  };
  return (
    <details className="mx-4 my-2 rounded-xl border border-slate-700 bg-slate-900 text-sm text-slate-200 lg:mx-6">
      <summary className="cursor-pointer px-3 py-2">Work in this repository · {activeAssignments.length} assignments · {data.pendingMessageCount} messages awaiting acknowledgement</summary>
      <div className="max-h-72 space-y-4 overflow-auto border-t border-slate-700 p-3">
        <p className="text-xs text-slate-400">Activity and messages only. Agents coordinate overlaps directly; files and Git operations are not locked.</p>
        {activeAssignments.length === 0 && <p>No registered assignments currently affect this repository.</p>}
        <ul className="space-y-2" aria-label="Active assignments">
          {activeAssignments.map((assignment) => (
            <li key={assignment.id}>
              <div><strong>{assignment.description}</strong> <span className="text-slate-400">· {assignment.provider} · {assignment.status}</span></div>
              {data.scopes.filter((scope) => scope.assignmentId === assignment.id).map((scope) => <div key={scope.checkout} className="break-all text-xs text-slate-400">{scope.checkout}: {scope.summary}</div>)}
            </li>
          ))}
        </ul>
        {data.messages.length > 0 && <div>
          <p className="mb-2 font-medium">Peer messages</p>
          <ul className="space-y-3" aria-label="Peer messages">
            {data.messages.map((message) => <li key={message.id} className="rounded-lg bg-slate-800 p-2">
              <div className="text-xs text-slate-400">{label(message.senderId)} → {label(message.recipientId)}</div>
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
              <div className="text-xs text-slate-400">{new Date(message.createdAt).toLocaleTimeString()} · {message.acknowledgedAt ? 'Acknowledged' : message.suppliedAt ? 'Offered to runtime; awaiting acknowledgement' : 'Queued'}</div>
            </li>)}
          </ul>
        </div>}
        {data.events.length > 0 && <details><summary className="cursor-pointer">Recent activity</summary><ol className="mt-2 space-y-1 text-xs text-slate-400">
          {data.events.map((event) => <li key={event.seq}>{new Date(event.timestamp).toLocaleTimeString()} · {label(event.assignmentId)} · {event.kind}: {event.text}</li>)}
        </ol></details>}
      </div>
    </details>
  );
}
