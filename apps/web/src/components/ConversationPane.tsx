import { Bot, Bug, ChevronRight, FolderTree, Link as LinkIcon, PlugZap, Sparkles, Unplug } from 'lucide-react';
import type { ConversationTimeline, ProjectSummary, ProviderId, SessionKeystrokeRequest } from '@agent-console/shared';
import { AnsiUp } from 'ansi_up';
import clsx from 'clsx';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';

type AnsiPaletteColor = {
  rgb: [number, number, number];
  class_name: string;
};

type MutableAnsiConverter = {
  use_classes: boolean;
  escape_html: boolean;
  ansi_colors: [AnsiPaletteColor[], AnsiPaletteColor[]];
  palette_256: AnsiPaletteColor[];
  ansi_to_html(text: string): string;
};

const ansiConverter = new AnsiUp() as unknown as MutableAnsiConverter;
ansiConverter.use_classes = false;
ansiConverter.escape_html = true;
ansiConverter.ansi_colors = [
  [
    { rgb: [12, 16, 24], class_name: 'ansi-black' },
    { rgb: [255, 92, 87], class_name: 'ansi-red' },
    { rgb: [94, 234, 140], class_name: 'ansi-green' },
    { rgb: [241, 250, 140], class_name: 'ansi-yellow' },
    { rgb: [96, 165, 250], class_name: 'ansi-blue' },
    { rgb: [255, 121, 198], class_name: 'ansi-magenta' },
    { rgb: [139, 233, 253], class_name: 'ansi-cyan' },
    { rgb: [226, 232, 240], class_name: 'ansi-white' },
  ],
  [
    { rgb: [100, 116, 139], class_name: 'ansi-bright-black' },
    { rgb: [255, 110, 118], class_name: 'ansi-bright-red' },
    { rgb: [134, 239, 172], class_name: 'ansi-bright-green' },
    { rgb: [253, 224, 71], class_name: 'ansi-bright-yellow' },
    { rgb: [147, 197, 253], class_name: 'ansi-bright-blue' },
    { rgb: [244, 114, 182], class_name: 'ansi-bright-magenta' },
    { rgb: [103, 232, 249], class_name: 'ansi-bright-cyan' },
    { rgb: [248, 250, 252], class_name: 'ansi-bright-white' },
  ],
];
ansiConverter.palette_256.splice(0, 16, ...ansiConverter.ansi_colors[0], ...ansiConverter.ansi_colors[1]);

function renderAnsiHtml(text: string): string {
  return ansiConverter.ansi_to_html(text);
}

function LiveAnsiBlock({
  text,
  ansiText,
  className,
  containerRef,
}: {
  text: string;
  ansiText?: string;
  className: string;
  containerRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={containerRef}
      className={className}
      dangerouslySetInnerHTML={{ __html: renderAnsiHtml(ansiText ?? text) }}
    />
  );
}

function TranscriptBubble({ role, text, timestamp }: { role: string; text: string; timestamp: string }) {
  const isUser = role === 'user';
  const isStatus = role === 'status' || role === 'system';
  return (
    <div className={clsx('flex', isUser ? 'justify-end' : isStatus ? 'justify-center' : 'justify-start')}>
      <div className={clsx(
        'max-w-[90%] rounded-2xl px-4 py-3 text-sm shadow-panel whitespace-pre-wrap',
        isUser
          ? 'bg-sky-500/20 text-sky-50 border border-sky-400/30'
          : isStatus
            ? 'bg-slate-900/90 text-slate-300 border border-slate-700'
            : 'bg-slate-800/85 text-slate-50 border border-slate-700',
      )}>
        <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">{role}</div>
        <div>{text}</div>
        <div className="mt-2 text-[11px] text-slate-500">{new Date(timestamp).toLocaleString()}</div>
      </div>
    </div>
  );
}

function LiveSessionOutput({ content, contentAnsi }: { content: string; contentAnsi?: string }) {
  return <LiveSessionOutputBlock content={content} contentAnsi={contentAnsi} compact={false} />;
}

function LiveSessionOutputBlock({
  content,
  contentAnsi,
  compact,
}: {
  content: string;
  contentAnsi?: string;
  compact: boolean;
}) {
  const outputRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'auto' });
  }, [content]);

  if (compact) {
    return (
      <LiveAnsiBlock
        containerRef={outputRef}
        text={content.trim() || 'Waiting for session output…'}
        ansiText={contentAnsi}
        className="scrollbar-thin h-full min-h-0 overflow-auto whitespace-pre-wrap break-words bg-slate-950/80 px-4 py-4 font-mono text-[13px] leading-6 text-slate-300"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-[1.75rem] border border-slate-800 bg-slate-950/80 p-4 shadow-panel">
      <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-slate-500">Live session output</div>
      <LiveAnsiBlock
        containerRef={outputRef}
        text={content.trim() || 'Waiting for session output…'}
        ansiText={contentAnsi}
        className="scrollbar-thin flex-1 min-h-0 overflow-auto whitespace-pre-wrap break-words rounded-[1.25rem] border border-slate-800 bg-slate-900/90 p-4 font-mono text-[13px] leading-6 text-slate-300"
      />
    </div>
  );
}

function LiveSessionStatus({ status, statusAnsi }: { status: string; statusAnsi?: string }) {
  return (
    <div className="border-t border-slate-800 bg-slate-900/90 px-4 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">Status</div>
      <LiveAnsiBlock
        text={status || 'Session active'}
        ansiText={statusAnsi}
        className="scrollbar-thin max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-sm leading-6 text-slate-300"
      />
    </div>
  );
}

function ProviderPill({ provider }: { provider: ProviderId }) {
  return provider === 'codex' ? (
    <>
      <Sparkles className="h-4 w-4 text-sky-300" />
      Codex
    </>
  ) : (
    <>
      <Bot className="h-4 w-4 text-sky-300" />
      Claude
    </>
  );
}

function NavigationCrumbs({
  project,
  selectedProvider,
  conversationTitle,
}: {
  project?: ProjectSummary;
  selectedProvider?: ProviderId;
  conversationTitle?: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
      <Link to="/" className="inline-flex items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800 hover:text-slate-100">
        <FolderTree className="h-4 w-4 text-sky-300" />
        Projects
      </Link>
      {project ? <ChevronRight className="h-4 w-4 text-slate-600" /> : null}
      {project ? (
        <Link to={`/projects/${encodeURIComponent(project.slug)}`} className="rounded-lg px-2 py-1 transition hover:bg-slate-800 hover:text-slate-100">
          {project.displayName}
        </Link>
      ) : null}
      {project && selectedProvider ? <ChevronRight className="h-4 w-4 text-slate-600" /> : null}
      {project && selectedProvider ? (
        <Link
          to={`/projects/${encodeURIComponent(project.slug)}/${selectedProvider}`}
          className="inline-flex items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800 hover:text-slate-100"
        >
          <ProviderPill provider={selectedProvider} />
        </Link>
      ) : null}
      {conversationTitle ? <ChevronRight className="h-4 w-4 text-slate-600" /> : null}
      {conversationTitle ? <span className="rounded-lg px-2 py-1 text-slate-200">{conversationTitle}</span> : null}
    </div>
  );
}

function ExplorerPane({
  projects,
  project,
  selectedProvider,
}: {
  projects?: ProjectSummary[];
  project?: ProjectSummary;
  selectedProvider?: ProviderId;
}) {
  if (!project) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <NavigationCrumbs />
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">Projects</h1>
            <p className="mt-1 text-sm text-slate-400">Browse the active project folders under the configured projects root.</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {(projects ?? []).map((item) => (
              <Link
                key={item.slug}
                to={`/projects/${encodeURIComponent(item.slug)}`}
                className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-panel transition hover:border-slate-600 hover:bg-slate-900"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl border border-slate-700 bg-slate-950 p-3 text-sky-300">
                    <FolderTree className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-lg font-semibold text-slate-100">{item.displayName}</div>
                    <div className="mt-1 break-all text-sm text-slate-400">{item.path}</div>
                    <div className="mt-3 text-xs uppercase tracking-[0.16em] text-slate-500">
                      {item.providers.codex.conversations.length + item.providers.claude.conversations.length} conversations
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <NavigationCrumbs project={project} />
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">{project.displayName}</h1>
            <p className="mt-1 text-sm text-slate-400">Choose a provider to browse indexed conversations for this project.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {(['codex', 'claude'] as const).map((provider) => (
              <Link
                key={provider}
                to={`/projects/${encodeURIComponent(project.slug)}/${provider}`}
                className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-panel transition hover:border-slate-600 hover:bg-slate-900"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl border border-slate-700 bg-slate-950 p-3 text-sky-300">
                    {provider === 'codex' ? <Sparkles className="h-5 w-5" /> : <Bot className="h-5 w-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="inline-flex items-center gap-2 text-lg font-semibold text-slate-100">
                      <ProviderPill provider={provider} />
                    </div>
                    <div className="mt-1 text-sm text-slate-400">
                      {project.providers[provider].conversations.length} indexed conversations
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const conversations = project.providers[selectedProvider].conversations;
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <NavigationCrumbs project={project} selectedProvider={selectedProvider} />
        <div>
          <h1 className="inline-flex items-center gap-2 text-2xl font-semibold text-slate-100">
            <ProviderPill provider={selectedProvider} />
          </h1>
          <p className="mt-1 text-sm text-slate-400">Choose an indexed conversation or start a new one from the sidebar.</p>
        </div>
        {conversations.length > 0 ? (
          <div className="space-y-3">
            {conversations.map((conversation) => (
              <Link
                key={conversation.ref}
                to={`/projects/${encodeURIComponent(project.slug)}/${selectedProvider}/${encodeURIComponent(conversation.ref)}`}
                className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 shadow-panel transition hover:border-slate-600 hover:bg-slate-900"
              >
                <span className={clsx('h-2.5 w-2.5 rounded-full', conversation.isBound ? 'bg-emerald-400' : 'border border-slate-700 bg-transparent')} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-100">{conversation.title}</div>
                  <div className="truncate text-xs text-slate-500">{new Date(conversation.updatedAt).toLocaleString()}</div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-700 p-6 text-sm text-slate-400">
            No indexed conversations yet for this provider.
          </div>
        )}
      </div>
    </div>
  );
}

type SessionKeyToken = NonNullable<SessionKeystrokeRequest['keys']>[number];

const specialKeyButtons = [
  { label: 'Enter', keys: ['Enter'] },
  { label: 'Esc', keys: ['Escape'] },
  { label: '↑', keys: ['Up'] },
  { label: '↓', keys: ['Down'] },
  { label: '←', keys: ['Left'] },
  { label: '→', keys: ['Right'] },
  { label: 'Backspace', keys: ['BSpace'] },
  { label: 'Tab', keys: ['Tab'] },
] satisfies Array<{ label: string; keys: SessionKeyToken[] }>;

function sanitizeBridgeInputText(
  provider: ConversationTimeline['conversation']['provider'],
  inputText: string,
): string {
  if (provider === 'codex' && inputText.trim() === 'Explain this codebase') {
    return '';
  }
  return inputText;
}

function LiveSessionInputBridge({
  sessionId,
  provider,
  conversationKind,
  rawMetadata,
  inputText,
  onSendText,
  onSendKeystrokes,
  sendingText,
  compact,
}: {
  sessionId: string;
  provider: ConversationTimeline['conversation']['provider'];
  conversationKind: ConversationTimeline['conversation']['kind'];
  rawMetadata?: Record<string, unknown>;
  inputText: string;
  onSendText: (sessionId: string, text: string) => Promise<boolean>;
  onSendKeystrokes: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<boolean>;
  sendingText: boolean;
  compact: boolean;
}) {
  const bridgeInputText = sanitizeBridgeInputText(provider, inputText);
  const [firstPrompt, setFirstPrompt] = useState('');
  const [textBypassEnabled, setTextBypassEnabled] = useState(false);
  const [draftText, setDraftText] = useState(bridgeInputText);
  const [draftDirty, setDraftDirty] = useState(false);
  const captureRef = useRef<HTMLTextAreaElement | null>(null);
  const keyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingTextRef = useRef('');
  const flushTimerRef = useRef<number | undefined>(undefined);
  const committedInputRef = useRef(bridgeInputText);

  const needsBufferedFirstCodexTurn =
    provider === 'codex'
    && conversationKind === 'pending'
    && typeof rawMetadata?.lastUserInputHash !== 'string';

  useEffect(() => {
    if (!needsBufferedFirstCodexTurn) {
      captureRef.current?.focus();
    }
  }, [needsBufferedFirstCodexTurn, sessionId]);

  useEffect(() => {
    pendingTextRef.current = '';
    committedInputRef.current = bridgeInputText;
    setTextBypassEnabled(false);
    setDraftText(bridgeInputText);
    setDraftDirty(false);
  }, [sessionId]);

  useEffect(() => {
    if (!textBypassEnabled && !draftDirty) {
      committedInputRef.current = bridgeInputText;
      setDraftText(bridgeInputText);
    }
  }, [bridgeInputText, draftDirty, textBypassEnabled]);

  useEffect(() => () => {
    if (flushTimerRef.current !== undefined) {
      window.clearTimeout(flushTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const capture = captureRef.current;
    if (!capture) {
      return;
    }
    const value = textBypassEnabled ? bridgeInputText : draftText;
    if (document.activeElement === capture) {
      const end = value.length;
      capture.setSelectionRange(end, end);
    }
    capture.scrollTop = capture.scrollHeight;
  }, [bridgeInputText, draftText, textBypassEnabled]);

  function queueKeystrokes(payload: SessionKeystrokeRequest): Promise<boolean> {
    const task = keyQueueRef.current
      .then(async () => await onSendKeystrokes(sessionId, payload))
      .catch(() => false);
    keyQueueRef.current = task.then(() => undefined, () => undefined);
    return task;
  }

  function enqueueKeystrokes(payload: SessionKeystrokeRequest): void {
    void queueKeystrokes(payload);
  }

  async function flushBufferedText(): Promise<boolean> {
    if (!pendingTextRef.current) {
      return true;
    }
    const text = pendingTextRef.current;
    pendingTextRef.current = '';
    if (flushTimerRef.current !== undefined) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = undefined;
    }
    return await queueKeystrokes({ text });
  }

  function scheduleBufferedTextFlush(): void {
    if (flushTimerRef.current !== undefined) {
      window.clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = window.setTimeout(() => {
      flushBufferedText();
    }, 45);
  }

  function appendLiteralText(text: string): void {
    pendingTextRef.current += text;
    scheduleBufferedTextFlush();
  }

  function appendDraftText(text: string): void {
    setDraftDirty(true);
    setDraftText((current) => current + text);
  }

  function removeDraftText(): void {
    setDraftDirty(true);
    setDraftText((current) => current.slice(0, -1));
  }

  async function syncDraftToRemote(extraKeys: SessionKeyToken[] = [], options: { clearAfterSend?: boolean } = {}): Promise<boolean> {
    const baseText = committedInputRef.current;
    const nextText = draftText;
    let prefixLength = 0;
    while (prefixLength < baseText.length && prefixLength < nextText.length && baseText[prefixLength] === nextText[prefixLength]) {
      prefixLength += 1;
    }
    const backspaces = baseText.length - prefixLength;
    const appendedText = nextText.slice(prefixLength);

    if (backspaces > 0) {
      const ok = await onSendKeystrokes(sessionId, { keys: Array.from({ length: backspaces }, () => 'BSpace' as const) });
      if (!ok) {
        return false;
      }
    }

    if (appendedText) {
      const ok = await onSendKeystrokes(sessionId, { text: appendedText });
      if (!ok) {
        return false;
      }
    }

    if (extraKeys.length > 0) {
      const ok = await onSendKeystrokes(sessionId, { keys: extraKeys });
      if (!ok) {
        return false;
      }
    }

    committedInputRef.current = options.clearAfterSend ? '' : nextText;
    setDraftDirty(false);
    if (options.clearAfterSend) {
      setDraftText('');
    }
    return true;
  }

  async function syncDraftAndEnableBypass(extraKeys: SessionKeyToken[] = []): Promise<void> {
    const ok = await syncDraftToRemote(extraKeys);
    if (!ok) {
      return;
    }
    setTextBypassEnabled(true);
    captureRef.current?.focus();
  }

  async function handleToggleTextBypass(): Promise<void> {
    if (textBypassEnabled) {
      const ok = await flushBufferedText();
      if (!ok) {
        return;
      }
      committedInputRef.current = bridgeInputText;
      setDraftText(bridgeInputText);
      setDraftDirty(false);
      setTextBypassEnabled(false);
      captureRef.current?.focus();
      return;
    }

    if (draftDirty) {
      const ok = await syncDraftToRemote();
      if (!ok) {
        return;
      }
    }
    setTextBypassEnabled(true);
    captureRef.current?.focus();
  }

  async function handleSpecialKey(specialKey: SessionKeyToken): Promise<void> {
    if (specialKey === 'BSpace') {
      if (textBypassEnabled) {
        if (pendingTextRef.current.length > 0) {
          pendingTextRef.current = pendingTextRef.current.slice(0, -1);
          return;
        }
        enqueueKeystrokes({ keys: ['BSpace'] });
        return;
      }
      removeDraftText();
      return;
    }

    if (textBypassEnabled) {
      const ok = await flushBufferedText();
      if (!ok) {
        return;
      }
      enqueueKeystrokes({ keys: [specialKey] });
      return;
    }

    if (specialKey === 'Enter') {
      await syncDraftToRemote(['Enter'], { clearAfterSend: true });
      return;
    }

    await syncDraftAndEnableBypass([specialKey]);
  }

  async function submitFirstPrompt(): Promise<void> {
    const nextPrompt = firstPrompt.trim();
    if (!nextPrompt) {
      return;
    }
    const sent = await onSendText(sessionId, nextPrompt);
    if (sent) {
      setFirstPrompt('');
    }
  }

  if (needsBufferedFirstCodexTurn) {
    return (
      <div className="border-t border-slate-800 bg-slate-950/90 px-4 py-4">
        <div className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">First prompt</div>
        <div className="mb-3 text-sm text-slate-400">Codex first-turn startup is buffered locally until you press Enter, then it is launched into the hidden session.</div>
        <textarea
          value={firstPrompt}
          onChange={(event) => setFirstPrompt(event.target.value)}
          onKeyDown={async (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              await submitFirstPrompt();
            }
          }}
          placeholder="Type the first prompt, then press Enter…"
          disabled={sendingText}
          rows={3}
          className="min-h-[5rem] w-full resize-y rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>
    );
  }

  return (
    <div className="border-t border-slate-800 bg-slate-950/90 px-4 py-4">
      <div className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">Live input bridge</div>
      <textarea
        ref={captureRef}
        value={textBypassEnabled ? bridgeInputText : draftText}
        onChange={() => undefined}
        onBlur={() => {
          if (textBypassEnabled) {
            void flushBufferedText();
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData('text');
          if (text) {
            if (textBypassEnabled) {
              appendLiteralText(text);
            } else {
              appendDraftText(text);
            }
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.ctrlKey && event.key.toLowerCase() === 'c') {
            event.preventDefault();
            if (textBypassEnabled) {
              void flushBufferedText().then((ok) => {
                if (!ok) {
                  return;
                }
                enqueueKeystrokes({ keys: ['C-c'] });
              });
            } else {
              void syncDraftAndEnableBypass(['C-c']);
            }
            return;
          }
          const specialKeyMap: Record<string, SessionKeyToken> = {
            Enter: 'Enter',
            Escape: 'Escape',
            ArrowUp: 'Up',
            ArrowDown: 'Down',
            ArrowLeft: 'Left',
            ArrowRight: 'Right',
            Backspace: 'BSpace',
            Tab: 'Tab',
          };
          const specialKey = specialKeyMap[event.key];
          if (specialKey) {
            if (!textBypassEnabled && ['Up', 'Down', 'Left', 'Right'].includes(specialKey)) {
              return;
            }
            event.preventDefault();
            void handleSpecialKey(specialKey);
            return;
          }
          if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
            event.preventDefault();
            if (textBypassEnabled) {
              appendLiteralText(event.key);
            } else {
              appendDraftText(event.key);
            }
          }
        }}
        placeholder={(textBypassEnabled ? bridgeInputText : draftText) ? undefined : 'Type directly into the live session…'}
        rows={3}
        className={clsx(
          'w-full resize-none overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 font-mono text-sm text-slate-100 outline-none transition focus:border-sky-400',
          compact ? 'h-48' : 'h-24',
        )}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {specialKeyButtons.map((button) => (
          <button
            key={button.label}
            type="button"
            onClick={() => {
              void handleSpecialKey(button.keys[0]!);
              captureRef.current?.focus();
            }}
            className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
          >
            {button.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={textBypassEnabled}
          onClick={() => {
            void handleToggleTextBypass();
          }}
          className={clsx(
            'rounded-xl border px-3 py-2 text-xs font-medium transition',
            textBypassEnabled
              ? 'border-sky-400/40 bg-sky-500/10 text-sky-100 hover:bg-sky-500/20'
              : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800',
          )}
        >
          Text Bypass
        </button>
      </div>
    </div>
  );
}

interface ConversationPaneProps {
  projects?: ProjectSummary[];
  project?: ProjectSummary;
  selectedProvider?: ProviderId;
  timeline?: ConversationTimeline;
  loading: boolean;
  workMode: boolean;
  onBind: () => Promise<void>;
  onRelease: (sessionId: string) => Promise<void>;
  onSendText: (sessionId: string, text: string) => Promise<boolean>;
  onSendKeystrokes: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<boolean>;
  sendingText: boolean;
  binding: boolean;
  releasing: boolean;
  debugOpen: boolean;
  onToggleDebug: () => void;
  rawOutput?: string;
  rawLoading: boolean;
}

export function ConversationPane({
  projects,
  project,
  selectedProvider,
  timeline,
  loading,
  workMode,
  onBind,
  onRelease,
  onSendText,
  onSendKeystrokes,
  sendingText,
  binding,
  releasing,
  debugOpen,
  onToggleDebug,
  rawOutput,
  rawLoading,
}: ConversationPaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const boundSession = timeline?.boundSession;
  const liveScreen = timeline?.liveScreen;
  const liveMode = Boolean(boundSession && liveScreen);
  const compactBoundLayout = workMode && liveMode;

  useEffect(() => {
    if (liveMode) {
      return;
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [liveMode, timeline?.messages.length, rawOutput, liveScreen?.capturedAt, liveScreen?.content]);

  if (!timeline) {
    if (loading && selectedProvider && project) {
      return (
        <div className="flex h-full items-center justify-center p-8 text-center text-slate-400">
          <div>
            <div className="mb-2 text-lg font-medium text-slate-200">Loading conversation…</div>
            <div>Fetching saved history and live session state.</div>
          </div>
        </div>
      );
    }
    if (workMode) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div className="max-w-md">
            <div className="text-lg font-medium text-slate-100">Work mode</div>
            <div className="mt-2 text-sm text-slate-400">Select a bound session from the left pane or start a new Codex or Claude session there.</div>
          </div>
        </div>
      );
    }
    return <ExplorerPane projects={projects} project={project} selectedProvider={selectedProvider} />;
  }

  if (workMode && !liveMode) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-md">
          <div className="text-lg font-medium text-slate-100">{timeline.conversation.title}</div>
          <div className="mt-2 text-sm text-slate-400">This conversation is not currently bound. Start a new session from the left pane, or bind this one to continue working here.</div>
          <div className="mt-5">
            <button
              type="button"
              onClick={() => void onBind()}
              disabled={binding}
              className="inline-flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-60"
            >
              <PlugZap className="h-4 w-4" />
              Bind / resume
            </button>
          </div>
        </div>
      </div>
    );
  }

  const proxyLinks = project?.allowedLocalhostPorts ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!compactBoundLayout && (
      <div className="border-b border-slate-800 bg-slate-950/90 px-4 py-4 backdrop-blur">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <NavigationCrumbs project={project} selectedProvider={timeline.conversation.provider} conversationTitle={timeline.conversation.title} />
            <h1 className="truncate text-xl font-semibold text-white">{timeline.conversation.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className={clsx('rounded-full border px-2.5 py-1', boundSession ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 text-slate-400')}>
                {boundSession ? 'Bound' : 'Not bound'}
              </span>
              {timeline.conversation.degraded && (
                <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-amber-300">Degraded parse</span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onToggleDebug}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
            >
              <Bug className="h-4 w-4" />
              {debugOpen ? 'Hide debug' : 'Show debug'}
            </button>
            {boundSession ? (
              <button
                type="button"
                onClick={() => onRelease(boundSession.id)}
                disabled={releasing}
                className="inline-flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-60"
              >
                <Unplug className="h-4 w-4" />
                Release
              </button>
            ) : (
              <button
                type="button"
                onClick={onBind}
                disabled={binding}
                className="inline-flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-60"
              >
                <PlugZap className="h-4 w-4" />
                Bind / resume
              </button>
            )}
          </div>
        </div>

        {proxyLinks.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {proxyLinks.map((port) => (
              <a
                key={port}
                href={`/proxy/${encodeURIComponent(project!.slug)}/${port}/`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition hover:border-sky-400 hover:bg-sky-500/10"
              >
                <LinkIcon className="h-4 w-4 text-sky-300" />
                localhost:{port}
              </a>
            ))}
          </div>
        )}
      </div>
      )}

      <div
        ref={scrollRef}
        className={clsx(
          'flex-1 min-h-0',
          compactBoundLayout
            ? 'overflow-hidden'
            : liveMode
              ? 'overflow-hidden px-4 py-5'
              : 'scrollbar-thin space-y-4 overflow-y-auto px-4 py-5',
        )}
      >
        {loading ? (
          <div className="text-sm text-slate-400">Loading conversation…</div>
        ) : liveMode && liveScreen ? (
          compactBoundLayout
            ? <LiveSessionOutputBlock content={liveScreen.content} contentAnsi={liveScreen.contentAnsi} compact />
            : <LiveSessionOutput content={liveScreen.content} contentAnsi={liveScreen.contentAnsi} />
        ) : timeline.messages.length > 0 ? (
          <div className="space-y-4">
            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Saved transcript</div>
            {timeline.messages.map((message) => (
              <TranscriptBubble key={message.id} role={message.role} text={message.text} timestamp={message.timestamp} />
            ))}
          </div>
        ) : boundSession ? (
          <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-center text-slate-400">
            Waiting for the live session surface to populate.
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-center text-slate-400">
            No saved transcript yet. Bind this conversation and use the composer below to drive the live session.
          </div>
        )}
      </div>

      {boundSession ? (
        <LiveSessionInputBridge
          sessionId={boundSession.id}
          provider={timeline.conversation.provider}
          conversationKind={timeline.conversation.kind}
          rawMetadata={timeline.conversation.rawMetadata}
          inputText={liveScreen?.inputText ?? ''}
          onSendText={onSendText}
          onSendKeystrokes={onSendKeystrokes}
          sendingText={sendingText}
          compact={compactBoundLayout}
        />
      ) : (
        <div className="border-t border-slate-800 bg-slate-950/90 px-4 py-4 text-sm text-slate-400">
          Bind this conversation to unlock the live input bridge.
        </div>
      )}

      {liveMode && liveScreen && (
        <LiveSessionStatus status={liveScreen.status} statusAnsi={liveScreen.statusAnsi} />
      )}

      {debugOpen && (
        <div className="border-t border-slate-800 bg-slate-900/90 px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-sm text-slate-300">
            <div className="font-medium">Raw terminal/debug output</div>
            <div className="text-xs text-slate-500">{rawLoading ? 'Refreshing…' : 'Live view'}</div>
          </div>
          <pre className="scrollbar-thin max-h-52 overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-3 text-xs leading-6 text-slate-300">{rawOutput?.trim() || 'No raw output captured yet.'}</pre>
        </div>
      )}
    </div>
  );
}
