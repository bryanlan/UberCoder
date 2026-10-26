import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PendingRequestSummary } from '@agent-console/shared';
import clsx from 'clsx';
import { api } from '../lib/api';

type Selection = Record<string, { picked: string[]; typed: string }>;

/** What the person chose and typed for one question, in the order the provider expects (choices, then typed text). */
function answersFor(selection: Selection[string] | undefined): string[] {
  const typed = selection?.typed.trim();
  return [...(selection?.picked ?? []), ...(typed ? [typed] : [])];
}

/**
 * The questions an app-server agent is waiting on. Each card answers one request: pick options, type an answer
 * where the question allows one, then Submit; or Decline. The card disappears when the server drops the request
 * from the session (answered here, in another browser, or withdrawn by the agent). The composer stays usable.
 */
export function PendingQuestionCard({ sessionId, requests, csrfToken }: {
  sessionId: string;
  requests: PendingRequestSummary[];
  csrfToken?: string;
}) {
  const open = requests.filter(request => request.kind === 'question' && request.questions.length > 0);
  if (!open.length) return null;
  return <div className="max-h-[45vh] shrink-0 space-y-2 overflow-y-auto overscroll-contain border-b border-amber-700/50 bg-amber-950/30 px-4 py-3" data-testid="pending-questions">
    {open.map(request => <QuestionRequest key={request.requestId} sessionId={sessionId} request={request} csrfToken={csrfToken} />)}
  </div>;
}

function QuestionRequest({ sessionId, request, csrfToken }: { sessionId: string; request: PendingRequestSummary; csrfToken?: string }) {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<Selection>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const complete = request.questions.every(question => answersFor(selection[question.id]).length > 0);

  function pick(questionId: string, label: string, multiSelect: boolean): void {
    setSelection(current => {
      const row = current[questionId] ?? { picked: [], typed: '' };
      const picked = multiSelect
        ? (row.picked.includes(label) ? row.picked.filter(item => item !== label) : [...row.picked, label])
        : [label];
      // A single choice replaces a typed answer, as the two are alternatives.
      return { ...current, [questionId]: { picked, typed: multiSelect ? row.typed : '' } };
    });
  }

  function type(questionId: string, typed: string, multiSelect: boolean): void {
    setSelection(current => {
      const row = current[questionId] ?? { picked: [], typed: '' };
      return { ...current, [questionId]: { picked: multiSelect ? row.picked : [], typed } };
    });
  }

  async function send(body: Parameters<typeof api.answerSessionRequest>[2]): Promise<void> {
    setBusy(true);
    try {
      await api.answerSessionRequest(sessionId, request.requestId, body, csrfToken);
      setError(undefined);
      // The session update event drops the card; refetching the row covers a missed event.
      await queryClient.invalidateQueries({ queryKey: ['session-screen', sessionId] });
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      setError(status === 404 ? 'This question is no longer waiting for an answer.' : cause instanceof Error ? cause.message : 'Could not send the answer.');
      if (status === 404) await queryClient.invalidateQueries({ queryKey: ['session-screen', sessionId] });
    } finally {
      setBusy(false);
    }
  }

  function submit(): void {
    const answers: Record<string, string[]> = {};
    for (const question of request.questions) answers[question.id] = answersFor(selection[question.id]);
    void send({ decision: 'answer', answers });
  }

  return <section className="rounded-xl border border-amber-600/40 bg-slate-900/80 p-3 text-sm text-slate-100" aria-label="Agent question">
    <div className="mb-2 text-[11px] uppercase tracking-[0.16em] text-amber-300">The agent is asking</div>
    {request.questions.map(question => {
      const row = selection[question.id];
      const multiSelect = question.multiSelect === true;
      const showTyped = question.allowCustom === true || question.options.length === 0;
      return <fieldset key={question.id} className="mb-3 min-w-0" disabled={busy}>
        {question.header && <legend className="mb-0.5 text-xs font-semibold text-slate-300">{question.header}</legend>}
        <p className="mb-2 whitespace-pre-wrap break-words">{question.question}</p>
        {question.options.length > 0 && <div className="flex flex-wrap gap-2" role={multiSelect ? 'group' : 'radiogroup'} aria-label={question.header ?? question.question}>
          {question.options.map(option => {
            const chosen = row?.picked.includes(option.label) === true;
            return <button
              key={option.label}
              type="button"
              role={multiSelect ? 'checkbox' : 'radio'}
              aria-checked={chosen}
              title={option.description}
              onClick={() => pick(question.id, option.label, multiSelect)}
              className={clsx('min-h-9 rounded-lg border px-3 py-1.5 text-left text-xs transition',
                chosen ? 'border-sky-400 bg-sky-500/20 text-sky-100' : 'border-slate-700 text-slate-200 hover:border-slate-500 hover:bg-slate-800')}
            >
              <span className="font-medium">{option.label}</span>
              {option.description && <span className="mt-0.5 block text-[11px] text-slate-400">{option.description}</span>}
            </button>;
          })}
        </div>}
        {showTyped && <input
          type="text"
          aria-label={`Your answer: ${question.header ?? question.question}`}
          placeholder={question.options.length > 0 ? 'Or type your own answer' : 'Type your answer'}
          value={row?.typed ?? ''}
          onChange={event => type(question.id, event.target.value, multiSelect)}
          className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-400"
        />}
      </fieldset>;
    })}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy || !complete} onClick={submit}
        className="min-h-9 rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-40">Submit</button>
      <button type="button" disabled={busy} onClick={() => { void send({ decision: 'decline' }); }}
        className="min-h-9 rounded-lg border border-slate-600 px-4 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40">Decline</button>
      {busy && <span role="status" className="text-xs text-slate-400">Sending…</span>}
    </div>
    {error && <div role="alert" className="mt-2 text-xs text-rose-300">{error}</div>}
  </section>;
}
