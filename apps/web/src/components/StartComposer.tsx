import { FIXED_MODEL_PROFILE_KEYS, MODEL_PROFILE_NAMES, MODEL_PROFILE_SHORTCUTS, type FixedModelProfileKey, type ModelProfilesResponse } from '@agent-console/shared';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, Send, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';

const START_CHOICES = ['auto', ...FIXED_MODEL_PROFILE_KEYS] as const;
type StartChoice = (typeof START_CHOICES)[number];

/** What each choice does, naming the models the server's list holds at a level (the web app keeps no list of its own). */
function choiceHint(choice: StartChoice, profiles: ModelProfilesResponse | undefined): string {
  if (choice === 'auto') return 'Auto: Console picks the agent and model from your first message.';
  const name = MODEL_PROFILE_NAMES[choice];
  const labels = profiles ? Object.values(profiles.providers).flatMap((provider) => provider.levels[choice]?.label ?? []) : [];
  return labels.length > 0
    ? `${name}: ${labels.join(', ')}. Console picks the one with the most quota room.`
    : `${name}: Console picks the ${name} model with the most quota room.`;
}

/**
 * The small box behind the Start action: a first message for one project. Console picks the provider. The person may also pick a
 * level (Ultra, High, Medium or Low); Console then starts on the model at that level with the most quota room. The draft stays in
 * the box when the start fails, so the person can send it again.
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
  /** Resolves true when the chat was created. Without a level the chat starts on Auto. */
  onSend: (prompt: string, level?: FixedModelProfileKey) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [choice, setChoice] = useState<StartChoice>('auto');
  // The list App already loads; this only reads it from the shared cache.
  const { data: profiles } = useQuery({ queryKey: ['model-profiles'], queryFn: api.modelProfiles, enabled: false });
  const prompt = draft.trim();
  const canSend = prompt.length > 0 && !disabled;

  async function send(): Promise<void> {
    if (!canSend) return;
    if (await onSend(prompt, choice === 'auto' ? undefined : choice)) onClose();
  }

  return (
    <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" data-testid="start-composer">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-slate-400">Start a chat in {projectName}.</div>
        <div role="radiogroup" aria-label="Model level" className="flex shrink-0 overflow-hidden rounded-lg border border-slate-700">
          {START_CHOICES.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={choice === key}
              aria-label={MODEL_PROFILE_NAMES[key]}
              title={choiceHint(key, profiles)}
              disabled={starting}
              onClick={() => setChoice(key)}
              className={`px-2 py-1 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${choice === key ? 'bg-sky-500/20 text-sky-100' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
            >
              {MODEL_PROFILE_SHORTCUTS[key]}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1 text-[11px] text-slate-500" data-testid="start-level-hint">{choiceHint(choice, profiles)}</div>
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
