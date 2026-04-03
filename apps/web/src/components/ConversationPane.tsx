import { Bot, Bug, Check, ChevronDown, ChevronRight, Copy, FolderTree, Link as LinkIcon, PlugZap, Sparkles, Unplug } from 'lucide-react';
import type { ConversationTimeline, ProjectSummary, ProviderId, SessionKeystrokeRequest } from '@agent-console/shared';
import { AnsiUp } from 'ansi_up';
import clsx from 'clsx';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { copyTextToClipboard } from '../lib/clipboard';

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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const mediaQuery = globalThis.matchMedia?.(query);
    if (!mediaQuery) {
      return;
    }

    const updateMatches = (event?: MediaQueryListEvent) => {
      setMatches(event?.matches ?? mediaQuery.matches);
    };

    updateMatches();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updateMatches);
      return () => mediaQuery.removeEventListener('change', updateMatches);
    }

    mediaQuery.addListener(updateMatches);
    return () => mediaQuery.removeListener(updateMatches);
  }, [query]);

  return matches;
}

function MobileSummaryStrip({
  title,
  summary,
  className,
}: {
  title: string;
  summary?: string;
  className: string;
}) {
  return (
    <div className={clsx('px-4 py-3', className)}>
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</div>
      {summary ? <div className="mt-1 truncate text-sm text-slate-200">{summary}</div> : null}
    </div>
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
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const output = outputRef.current;
    if (!output) {
      return;
    }

    const updateStickiness = () => {
      const distanceFromBottom = output.scrollHeight - output.scrollTop - output.clientHeight;
      stickToBottomRef.current = distanceFromBottom <= 48;
    };

    updateStickiness();
    output.addEventListener('scroll', updateStickiness);
    return () => output.removeEventListener('scroll', updateStickiness);
  }, []);

  useEffect(() => {
    const output = outputRef.current;
    if (!output || !stickToBottomRef.current) {
      return;
    }
    output.scrollTo({ top: output.scrollHeight, behavior: 'auto' });
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

function LiveSessionStatus({
  status,
  statusAnsi,
  mobileCompact,
}: {
  status: string;
  statusAnsi?: string;
  mobileCompact: boolean;
}) {
  const statusSummary = status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? 'Session active';

  if (mobileCompact) {
    return (
      <MobileSummaryStrip
        title="Status"
        summary={statusSummary}
        className="border-t border-slate-800 bg-slate-900/90"
      />
    );
  }

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

interface LiveBridgeDraftState {
  draftText?: string;
  draftDirty?: boolean;
  firstPrompt?: string;
}

const liveBridgeDraftStore = new Map<string, LiveBridgeDraftState>();

function upsertLiveBridgeDraft(
  conversationKey: string,
  updater: (current: LiveBridgeDraftState) => LiveBridgeDraftState,
): void {
  const next = updater(liveBridgeDraftStore.get(conversationKey) ?? {});
  if (!next.firstPrompt && !next.draftText && !next.draftDirty) {
    liveBridgeDraftStore.delete(conversationKey);
    return;
  }
  liveBridgeDraftStore.set(conversationKey, next);
}

function LiveSessionInputBridge({
  sessionId,
  projectSlug,
  conversationKey,
  conversationRef,
  provider,
  conversationKind,
  rawMetadata,
  inputText,
  onSendText,
  onSendKeystrokes,
  sendingText,
  compact,
  mobileCollapsible,
  bridgeOpen,
  onToggleBridge,
  mobileControlsHidden,
  onToggleMobileControls,
  mobileChromeHidden,
  onToggleMobileChrome,
  latestAssistantMessage,
}: {
  sessionId: string;
  projectSlug: string;
  conversationKey: string;
  conversationRef: string;
  provider: ConversationTimeline['conversation']['provider'];
  conversationKind: ConversationTimeline['conversation']['kind'];
  rawMetadata?: Record<string, unknown>;
  inputText: string;
  onSendText: (sessionId: string, text: string) => Promise<boolean>;
  onSendKeystrokes: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<boolean>;
  sendingText: boolean;
  compact: boolean;
  mobileCollapsible: boolean;
  bridgeOpen: boolean;
  onToggleBridge: () => void;
  mobileControlsHidden: boolean;
  onToggleMobileControls: () => void;
  mobileChromeHidden: boolean;
  onToggleMobileChrome: () => void;
  latestAssistantMessage: string;
}) {
  const [firstPrompt, setFirstPrompt] = useState('');
  const [textBypassEnabled, setTextBypassEnabled] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftDirty, setDraftDirty] = useState(false);
  const [bypassPreviewText, setBypassPreviewText] = useState<string>();
  const [copyingLastMessage, setCopyingLastMessage] = useState(false);
  const [copiedLastMessage, setCopiedLastMessage] = useState(false);
  const captureRef = useRef<HTMLTextAreaElement | null>(null);
  const keyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingTextRef = useRef('');
  const flushTimerRef = useRef<number | undefined>(undefined);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const committedInputRef = useRef(inputText);
  const bridgeBusyRef = useRef(false);
  const [bridgeBusy, setBridgeBusy] = useState(false);

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
    if (!bridgeOpen || needsBufferedFirstCodexTurn) {
      return;
    }
    captureRef.current?.focus();
  }, [bridgeOpen, needsBufferedFirstCodexTurn]);

  useEffect(() => {
    pendingTextRef.current = '';
    committedInputRef.current = inputText;
    setTextBypassEnabled(false);
    setBypassPreviewText(undefined);
    const storedDraft = liveBridgeDraftStore.get(conversationKey);
    setFirstPrompt(storedDraft?.firstPrompt ?? '');
    if (storedDraft) {
      setDraftText(storedDraft.draftText ?? '');
      setDraftDirty(storedDraft.draftDirty ?? false);
      return;
    }
    setDraftText('');
    setDraftDirty(false);
  }, [conversationKey]);

  useEffect(() => {
    if (!textBypassEnabled && !draftDirty) {
      committedInputRef.current = inputText;
    }
  }, [inputText, draftDirty, textBypassEnabled]);

  useEffect(() => {
    upsertLiveBridgeDraft(conversationKey, (current) => ({
      ...current,
      firstPrompt,
    }));
  }, [conversationKey, firstPrompt]);

  useEffect(() => {
    if (textBypassEnabled || (!draftDirty && !draftText)) {
      upsertLiveBridgeDraft(conversationKey, (current) => ({
        ...current,
        draftText: '',
        draftDirty: false,
      }));
      return;
    }
    upsertLiveBridgeDraft(conversationKey, (current) => ({
      ...current,
      draftText,
      draftDirty,
    }));
  }, [conversationKey, draftDirty, draftText, textBypassEnabled]);

  useEffect(() => () => {
    if (flushTimerRef.current !== undefined) {
      window.clearTimeout(flushTimerRef.current);
    }
    if (copyResetTimerRef.current !== undefined) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  useEffect(() => {
    setCopiedLastMessage(false);
  }, [latestAssistantMessage]);

  const bridgeText = textBypassEnabled ? (bypassPreviewText ?? inputText) : draftText;

  useEffect(() => {
    const capture = captureRef.current;
    if (!capture) {
      return;
    }
    const value = bridgeText;
    if (document.activeElement === capture) {
      if (textBypassEnabled) {
        const end = value.length;
        capture.setSelectionRange(end, end);
      }
    }
    if (textBypassEnabled) {
      capture.scrollTop = capture.scrollHeight;
    }
  }, [bridgeText, textBypassEnabled]);

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

  async function runBridgeAction<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (bridgeBusyRef.current) {
      return undefined;
    }

    bridgeBusyRef.current = true;
    setBridgeBusy(true);
    try {
      return await action();
    } finally {
      bridgeBusyRef.current = false;
      setBridgeBusy(false);
    }
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
    setBypassPreviewText((current) => `${current ?? inputText}${text}`);
    scheduleBufferedTextFlush();
  }

  function replaceDraftText(text: string): void {
    setDraftDirty(true);
    setDraftText(text);
    window.requestAnimationFrame(() => {
      captureRef.current?.setSelectionRange(text.length, text.length);
    });
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
      const ok = await queueKeystrokes({ keys: Array.from({ length: backspaces }, () => 'BSpace' as const) });
      if (!ok) {
        return false;
      }
    }

    if (appendedText || extraKeys.length > 0) {
      const ok = await queueKeystrokes({
        ...(appendedText ? { text: appendedText } : {}),
        ...(extraKeys.length > 0 ? { keys: extraKeys } : {}),
      });
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
    captureRef.current?.focus({ preventScroll: true });
  }

  async function handleToggleTextBypass(): Promise<void> {
    await runBridgeAction(async () => {
      if (textBypassEnabled) {
        const ok = await flushBufferedText();
        if (!ok) {
          return;
        }
        committedInputRef.current = bypassPreviewText ?? inputText;
        setDraftText('');
        setDraftDirty(false);
        setTextBypassEnabled(false);
        setBypassPreviewText(undefined);
        captureRef.current?.focus({ preventScroll: true });
        return;
      }

      if (draftDirty) {
        const ok = await syncDraftToRemote();
        if (!ok) {
          return;
        }
      }
      setBypassPreviewText(draftDirty ? draftText : inputText);
      setTextBypassEnabled(true);
      captureRef.current?.focus({ preventScroll: true });
    });
  }

  async function handleSpecialKey(specialKey: SessionKeyToken, source: 'keyboard' | 'button' = 'keyboard'): Promise<void> {
    if (source === 'button') {
      if (specialKey === 'Enter') {
        if (textBypassEnabled) {
          const ok = await flushBufferedText();
          if (!ok) {
            return;
          }
          setBypassPreviewText('');
          enqueueKeystrokes({ keys: ['Enter'] });
          return;
        }
        await runBridgeAction(async () => {
          await syncDraftToRemote(['Enter'], { clearAfterSend: true });
        });
        return;
      }
      if (textBypassEnabled) {
        const ok = await flushBufferedText();
        if (!ok) {
          return;
        }
        if (specialKey === 'BSpace') {
          setBypassPreviewText((current) => (current ?? inputText).slice(0, -1));
        } else {
          setBypassPreviewText(undefined);
        }
        enqueueKeystrokes({ keys: [specialKey] });
        return;
      }
      await runBridgeAction(async () => {
        await syncDraftAndEnableBypass([specialKey]);
      });
      return;
    }

    if (specialKey === 'BSpace') {
      if (textBypassEnabled) {
        if (pendingTextRef.current.length > 0) {
          pendingTextRef.current = pendingTextRef.current.slice(0, -1);
          setBypassPreviewText((current) => (current ?? inputText).slice(0, -1));
          return;
        }
        setBypassPreviewText((current) => (current ?? inputText).slice(0, -1));
        enqueueKeystrokes({ keys: ['BSpace'] });
        return;
      }
      replaceDraftText(draftText.slice(0, -1));
      return;
    }

    if (textBypassEnabled) {
      const ok = await flushBufferedText();
      if (!ok) {
        return;
      }
      if (specialKey === 'Enter') {
        setBypassPreviewText('');
      } else {
        setBypassPreviewText(undefined);
      }
      enqueueKeystrokes({ keys: [specialKey] });
      return;
    }

    if (specialKey === 'Enter') {
      await runBridgeAction(async () => {
        await syncDraftToRemote(['Enter'], { clearAfterSend: true });
      });
      return;
    }

    await runBridgeAction(async () => {
      await syncDraftAndEnableBypass([specialKey]);
    });
  }

  async function submitFirstPrompt(): Promise<void> {
    await runBridgeAction(async () => {
      const nextPrompt = firstPrompt.trim();
      if (!nextPrompt) {
        return;
      }
      const sent = await onSendText(sessionId, nextPrompt);
      if (sent) {
        setFirstPrompt('');
      }
    });
  }

  async function handleCopyLatestAssistantMessage(): Promise<void> {
    setCopyingLastMessage(true);
    try {
      const freshTimeline = await api.timeline(projectSlug, provider, conversationRef);
      const nextAssistantMessage = [...freshTimeline.messages]
        .reverse()
        .find((message) => message.role === 'assistant')
        ?.text;
      if (!nextAssistantMessage) {
        setCopiedLastMessage(false);
        return;
      }

      await copyTextToClipboard(nextAssistantMessage);
      setCopiedLastMessage(true);
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedLastMessage(false);
      }, 1500);
    } catch {
      setCopiedLastMessage(false);
    } finally {
      setCopyingLastMessage(false);
      captureRef.current?.focus({ preventScroll: true });
    }
  }

  async function handleToggleBridgePanel(): Promise<void> {
    if (bridgeOpen && textBypassEnabled) {
      await flushBufferedText();
    }
    onToggleBridge();
  }

  function renderBridgeHeader(
    title: string,
    summary?: string,
    options: { showControlsToggle?: boolean; showChromeToggle?: boolean } = {},
  ): ReactNode {
    const { showControlsToggle = false, showChromeToggle = true } = options;
    return (
      <div className={clsx(
        'flex items-center justify-between gap-3',
        mobileCollapsible ? 'px-4 py-3' : 'mb-2 py-1',
      )}>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</div>
          {summary ? <div className="mt-1 truncate text-sm text-slate-200">{summary}</div> : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={bridgeOpen}
            aria-label={bridgeOpen ? 'Collapse live input bridge' : 'Expand live input bridge'}
            onClick={() => {
              void handleToggleBridgePanel();
            }}
            className="rounded-xl border border-slate-700 p-2 text-slate-300 transition hover:border-slate-500 hover:bg-slate-800"
          >
            <ChevronDown className={clsx('h-4 w-4 transition-transform', bridgeOpen && 'rotate-180')} />
          </button>
          {showControlsToggle && (
            <button
              type="button"
              aria-label={mobileControlsHidden ? 'Show bridge controls and status' : 'Hide bridge controls and status'}
              title={mobileControlsHidden ? 'Show bridge controls and status' : 'Hide bridge controls and status'}
              onClick={onToggleMobileControls}
              className="rounded-xl border border-slate-700 p-2 text-slate-300 transition hover:border-slate-500 hover:bg-slate-800"
            >
              <ChevronRight className={clsx('h-4 w-4 transition-transform', mobileControlsHidden && 'rotate-180')} />
            </button>
          )}
          {showChromeToggle && (
            <button
              type="button"
              aria-label={mobileChromeHidden ? 'Show banners' : 'Hide banners'}
              title={mobileChromeHidden ? 'Show banners' : 'Hide banners'}
              onClick={onToggleMobileChrome}
              className="rounded-xl border border-slate-700 p-2 text-slate-300 transition hover:border-slate-500 hover:bg-slate-800"
            >
              <ChevronDown className={clsx('h-4 w-4 transition-transform', !mobileChromeHidden && 'rotate-180')} />
            </button>
          )}
        </div>
      </div>
    );
  }

  const bridgeBodyClassName = mobileCollapsible ? 'px-4 pb-4' : 'px-4 py-4';

  if (needsBufferedFirstCodexTurn) {
    return (
      <div className="border-t border-slate-800 bg-slate-950/90">
        {renderBridgeHeader('First prompt', 'Buffered locally until Enter launches the session.')}
        {bridgeOpen && (
          <div className={bridgeBodyClassName}>
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
              disabled={sendingText || bridgeBusy}
              rows={3}
              className="min-h-[5rem] w-full resize-y rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-slate-800 bg-slate-950/90">
      {renderBridgeHeader('Live input bridge', 'Expand to type directly into the live session.', { showControlsToggle: true })}
      {bridgeOpen && (
        <div className={bridgeBodyClassName}>
          <textarea
            ref={captureRef}
            readOnly={bridgeBusy}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
            onFocus={(event) => {
              if (textBypassEnabled) {
                const end = bridgeText.length;
                event.currentTarget.setSelectionRange(end, end);
              }
            }}
            onChange={(event) => {
              if (bridgeBusy) {
                return;
              }
              if (textBypassEnabled) {
                return;
              }
              setDraftDirty(true);
              setDraftText(event.target.value);
            }}
            onBlur={() => {
              if (textBypassEnabled) {
                void flushBufferedText();
              }
            }}
            onPaste={(event) => {
              if (bridgeBusy) {
                event.preventDefault();
                return;
              }
              if (!textBypassEnabled) {
                return;
              }
              event.preventDefault();
              const text = event.clipboardData.getData('text');
              if (text) {
                appendLiteralText(text);
              }
            }}
            onKeyDown={(event) => {
              if (bridgeBusy) {
                event.preventDefault();
                return;
              }
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (textBypassEnabled && event.ctrlKey && event.key.toLowerCase() === 'c') {
                event.preventDefault();
                void flushBufferedText().then((ok) => {
                  if (!ok) {
                    return;
                  }
                  setBypassPreviewText(undefined);
                  enqueueKeystrokes({ keys: ['C-c'] });
                });
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
                if (!textBypassEnabled) {
                  if (specialKey === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSpecialKey('Enter');
                  }
                  return;
                }
                event.preventDefault();
                void handleSpecialKey(specialKey);
                return;
              }
              if (textBypassEnabled && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
                event.preventDefault();
                appendLiteralText(event.key);
              }
            }}
            onBeforeInput={(event) => {
              if (bridgeBusy) {
                event.preventDefault();
                return;
              }
              const nativeEvent = event.nativeEvent as InputEvent;
              if (textBypassEnabled || nativeEvent.isComposing) {
                return;
              }
              if (nativeEvent.inputType === 'insertLineBreak') {
                event.preventDefault();
                void handleSpecialKey('Enter');
              }
            }}
            placeholder={bridgeText ? undefined : 'Type directly into the live session…'}
            rows={3}
            value={bridgeText}
            className={clsx(
              'w-full resize-none overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 font-mono text-sm text-slate-100 outline-none transition focus:border-sky-400',
              compact ? 'h-28 sm:h-48' : 'h-24',
            )}
          />
          {!mobileControlsHidden && (
            <div className="mt-3 flex flex-wrap gap-2">
              {specialKeyButtons.map((button) => (
                <button
                  key={button.label}
                  type="button"
                  disabled={bridgeBusy}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    void handleSpecialKey(button.keys[0]!, 'button');
                    captureRef.current?.focus({ preventScroll: true });
                  }}
                  className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {button.label}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={textBypassEnabled}
                disabled={bridgeBusy}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  void handleToggleTextBypass();
                }}
                className={clsx(
                  'rounded-xl border px-3 py-2 text-xs font-medium transition',
                  textBypassEnabled
                    ? 'border-sky-400/40 bg-sky-500/10 text-sky-100 hover:bg-sky-500/20'
                    : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800',
                  bridgeBusy && 'cursor-not-allowed opacity-60',
                )}
              >
                Text Bypass
              </button>
              <button
                type="button"
                aria-label="Copy latest assistant message"
                title={copyingLastMessage ? 'Loading latest assistant message…' : 'Copy latest assistant message'}
                disabled={copyingLastMessage}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  void handleCopyLatestAssistantMessage();
                }}
                className={clsx(
                  'inline-flex h-9 w-9 items-center justify-center rounded-xl border transition',
                  copiedLastMessage
                    ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                    : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-800',
                  copyingLastMessage && 'cursor-not-allowed opacity-60',
                )}
                >
                  {copiedLastMessage ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
            </div>
          )}
        </div>
      )}
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
  mobileChromeHidden: boolean;
  onToggleMobileChrome: () => void;
  mobileControlsHidden: boolean;
  onToggleMobileControls: () => void;
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
  mobileChromeHidden,
  onToggleMobileChrome,
  mobileControlsHidden,
  onToggleMobileControls,
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
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [mobileBridgeOpen, setMobileBridgeOpen] = useState(true);
  const boundSession = timeline?.boundSession;
  const liveScreen = timeline?.liveScreen;
  const liveMode = Boolean(boundSession && liveScreen);
  const compactLiveLayout = workMode && liveMode;
  const hideTopPanel = mobileChromeHidden;
  const latestAssistantMessage = [...(timeline?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant')
    ?.text ?? '';

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
      {!hideTopPanel && (
        isMobile ? (
          <div className="border-b border-slate-800 bg-slate-950/90 backdrop-blur">
            <MobileSummaryStrip
              title="Conversation"
              summary={[
                timeline.conversation.title,
                boundSession ? 'Bound' : 'Not bound',
                timeline.conversation.degraded ? 'Degraded parse' : undefined,
              ].filter(Boolean).join(' · ')}
              className=""
            />
            <div className="flex flex-wrap gap-2 px-4 pb-3">
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
        ) : (
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
        )
      )}

      <div
        ref={scrollRef}
        className={clsx(
          'flex-1 min-h-0',
          compactLiveLayout
            ? 'overflow-hidden'
            : liveMode
              ? 'overflow-hidden px-4 py-5'
              : 'scrollbar-thin space-y-4 overflow-y-auto px-4 py-5',
        )}
      >
        {loading ? (
          <div className="text-sm text-slate-400">Loading conversation…</div>
        ) : liveMode && liveScreen ? (
          compactLiveLayout
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
          projectSlug={timeline.conversation.projectSlug}
          conversationKey={`${timeline.conversation.projectSlug}:${timeline.conversation.provider}:${timeline.conversation.ref}`}
          conversationRef={timeline.conversation.ref}
          provider={timeline.conversation.provider}
          conversationKind={timeline.conversation.kind}
          rawMetadata={timeline.conversation.rawMetadata}
          inputText={liveScreen?.inputText ?? ''}
          onSendText={onSendText}
          onSendKeystrokes={onSendKeystrokes}
          sendingText={sendingText}
          compact={compactLiveLayout}
          mobileCollapsible={isMobile}
          bridgeOpen={mobileBridgeOpen}
          onToggleBridge={() => setMobileBridgeOpen((current) => !current)}
          mobileControlsHidden={mobileControlsHidden}
          onToggleMobileControls={onToggleMobileControls}
          mobileChromeHidden={mobileChromeHidden}
          onToggleMobileChrome={onToggleMobileChrome}
          latestAssistantMessage={latestAssistantMessage}
        />
      ) : (
        <div className="border-t border-slate-800 bg-slate-950/90 px-4 py-4 text-sm text-slate-400">
          <div>Bind this conversation to unlock the live input bridge.</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void onBind()}
              disabled={binding}
              className="inline-flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-60"
            >
              <PlugZap className="h-4 w-4" />
              Bind / resume
            </button>
            {mobileChromeHidden && (
              <button
                type="button"
                onClick={onToggleMobileChrome}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              >
                <ChevronDown className="h-4 w-4 rotate-180" />
                Show banners
              </button>
            )}
          </div>
        </div>
      )}

      {liveMode && liveScreen && !mobileControlsHidden && (
        <LiveSessionStatus
          status={liveScreen.status}
          statusAnsi={liveScreen.statusAnsi}
          mobileCompact={isMobile}
        />
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
