import { Bug, Link as LinkIcon, PlugZap, Unplug } from 'lucide-react';
import type { ConversationTimeline, ProjectSummary, SessionKeystrokeRequest } from '@agent-console/shared';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

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

function LiveSessionSurface({ content, status }: { content: string; status: string }) {
  const outputRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'auto' });
  }, [content, status]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col rounded-[1.75rem] border border-slate-800 bg-slate-950/80 p-4 shadow-panel">
        <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-slate-500">Live session output</div>
        <pre
          ref={outputRef}
          className="scrollbar-thin flex-1 min-h-0 overflow-auto whitespace-pre-wrap break-words rounded-[1.25rem] border border-slate-800 bg-slate-900/90 p-4 font-mono text-[13px] leading-6 text-slate-100"
        >
          {content.trim() || 'Waiting for session output…'}
        </pre>
      </div>

      <div className="rounded-[1.5rem] border border-slate-800 bg-slate-900/90 px-4 py-3 shadow-panel">
        <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">Status</div>
        <div className="font-mono text-sm text-slate-200">{status || 'Session active'}</div>
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

function LiveSessionInputBridge({
  sessionId,
  provider,
  conversationKind,
  rawMetadata,
  onSendText,
  onSendKeystrokes,
  sendingText,
}: {
  sessionId: string;
  provider: ConversationTimeline['conversation']['provider'];
  conversationKind: ConversationTimeline['conversation']['kind'];
  rawMetadata?: Record<string, unknown>;
  onSendText: (sessionId: string, text: string) => Promise<boolean>;
  onSendKeystrokes: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<boolean>;
  sendingText: boolean;
}) {
  const [firstPrompt, setFirstPrompt] = useState('');
  const captureRef = useRef<HTMLTextAreaElement | null>(null);
  const keyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingTextRef = useRef('');
  const flushTimerRef = useRef<number | undefined>(undefined);

  const needsBufferedFirstCodexTurn =
    provider === 'codex'
    && conversationKind === 'pending'
    && typeof rawMetadata?.lastUserInputHash !== 'string';

  useEffect(() => {
    if (!needsBufferedFirstCodexTurn) {
      captureRef.current?.focus();
    }
  }, [needsBufferedFirstCodexTurn, sessionId]);

  useEffect(() => () => {
    if (flushTimerRef.current !== undefined) {
      window.clearTimeout(flushTimerRef.current);
    }
  }, []);

  function enqueueKeystrokes(payload: SessionKeystrokeRequest): void {
    keyQueueRef.current = keyQueueRef.current
      .then(async () => {
        const ok = await onSendKeystrokes(sessionId, payload);
        if (!ok) {
          throw new Error('keystroke-send-failed');
        }
      })
      .catch(() => undefined);
  }

  function flushBufferedText(): void {
    if (!pendingTextRef.current) {
      return;
    }
    const text = pendingTextRef.current;
    pendingTextRef.current = '';
    if (flushTimerRef.current !== undefined) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = undefined;
    }
    enqueueKeystrokes({ text });
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
      <div className="mb-3 text-sm text-slate-400">Click the capture box and type directly. Keystrokes go to the hidden session, not to a local chat buffer.</div>
      <textarea
        ref={captureRef}
        value=""
        onChange={() => undefined}
        onBlur={() => flushBufferedText()}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData('text');
          if (text) {
            appendLiteralText(text);
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.ctrlKey && event.key.toLowerCase() === 'c') {
            event.preventDefault();
            flushBufferedText();
            enqueueKeystrokes({ keys: ['C-c'] });
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
            event.preventDefault();
            if (specialKey === 'BSpace' && pendingTextRef.current.length > 0) {
              pendingTextRef.current = pendingTextRef.current.slice(0, -1);
              return;
            }
            flushBufferedText();
            enqueueKeystrokes({ keys: [specialKey] });
            return;
          }
          if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
            event.preventDefault();
            appendLiteralText(event.key);
          }
        }}
        placeholder="Type directly into the live session…"
        rows={2}
        className="min-h-[4.25rem] w-full resize-none rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 font-mono text-sm text-slate-100 outline-none transition focus:border-sky-400"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {specialKeyButtons.map((button) => (
          <button
            key={button.label}
            type="button"
            onClick={() => {
              flushBufferedText();
              enqueueKeystrokes({ keys: button.keys });
              captureRef.current?.focus();
            }}
            className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
          >
            {button.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ConversationPaneProps {
  project?: ProjectSummary;
  timeline?: ConversationTimeline;
  loading: boolean;
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
  project,
  timeline,
  loading,
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

  useEffect(() => {
    if (liveMode) {
      return;
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [liveMode, timeline?.messages.length, rawOutput, liveScreen?.capturedAt, liveScreen?.content]);

  if (!timeline) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-slate-400">
        <div>
          <div className="mb-2 text-lg font-medium text-slate-200">{loading ? 'Loading conversation…' : 'Pick a conversation'}</div>
          <div>{loading ? 'Fetching saved history and live session state.' : 'Choose an indexed history item or start a new conversation from the project tree.'}</div>
        </div>
      </div>
    );
  }

  const proxyLinks = project?.allowedLocalhostPorts ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-slate-800 bg-slate-950/90 px-4 py-4 backdrop-blur">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-500">{project?.displayName} · {timeline.conversation.provider}</div>
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

      <div
        ref={scrollRef}
        className={clsx(
          'flex-1 min-h-0 px-4 py-5',
          liveMode ? 'overflow-hidden' : 'scrollbar-thin space-y-4 overflow-y-auto',
        )}
      >
        {loading ? (
          <div className="text-sm text-slate-400">Loading conversation…</div>
        ) : liveMode && liveScreen ? (
          <LiveSessionSurface content={liveScreen.content} status={liveScreen.status} />
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

      {debugOpen && (
        <div className="border-t border-slate-800 bg-slate-900/90 px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-sm text-slate-300">
            <div className="font-medium">Raw terminal/debug output</div>
            <div className="text-xs text-slate-500">{rawLoading ? 'Refreshing…' : 'Live view'}</div>
          </div>
          <pre className="scrollbar-thin max-h-52 overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-3 text-xs leading-6 text-slate-300">{rawOutput?.trim() || 'No raw output captured yet.'}</pre>
        </div>
      )}

      {boundSession ? (
        <LiveSessionInputBridge
          sessionId={boundSession.id}
          provider={timeline.conversation.provider}
          conversationKind={timeline.conversation.kind}
          rawMetadata={timeline.conversation.rawMetadata}
          onSendText={onSendText}
          onSendKeystrokes={onSendKeystrokes}
          sendingText={sendingText}
        />
      ) : (
        <div className="border-t border-slate-800 bg-slate-950/90 px-4 py-4 text-sm text-slate-400">
          Bind this conversation to unlock the live input bridge.
        </div>
      )}
    </div>
  );
}
