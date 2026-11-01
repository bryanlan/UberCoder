import { LoaderCircle, Send, X } from 'lucide-react';
import { useState } from 'react';

/**
 * The small box behind the Start action: a first message for one project. Console picks the provider, so there is nothing else
 * to choose. The draft stays in the box when the start fails, so the person can send it again.
 */
export function StartComposer({
  projectName,
  starting,
  disabled,
  onSend,
  onClose,
}: {
  projectName: string;
  /** This box's own chat is being created. */
  starting: boolean;
  /** Some chat is being created, so no second one can begin. */
  disabled: boolean;
  /** Resolves true when the chat was created. */
  onSend: (prompt: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const prompt = draft.trim();
  const canSend = prompt.length > 0 && !disabled;

  async function send(): Promise<void> {
    if (!canSend) return;
    if (await onSend(prompt)) onClose();
  }

  return (
    <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" data-testid="start-composer">
      <div className="text-xs text-slate-400">Start a chat in {projectName}. Console picks the agent for your first message.</div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !starting) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void send();
          }
        }}
        autoFocus
        rows={4}
        readOnly={starting}
        aria-label={`First message for ${projectName}`}
        placeholder="What should the agent do?"
        className="mt-2 w-full resize-y rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400 read-only:opacity-60"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">Ctrl+Enter to send · Esc to cancel</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={starting}
            className="rounded-lg border border-slate-700 p-2 text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Cancel start"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-400/40 bg-sky-500/10 px-3 py-2 text-xs font-medium text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {starting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {starting ? 'Starting…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
