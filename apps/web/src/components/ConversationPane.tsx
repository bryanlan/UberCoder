import { ArrowRight, Bug, Link as LinkIcon, PlugZap, Unplug } from 'lucide-react';
import type { BoundSession, ConversationTimeline, ProjectSummary } from '@agent-console/shared';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

function MessageBubble({ role, text, timestamp }: { role: string; text: string; timestamp: string }) {
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

interface ConversationPaneProps {
  project?: ProjectSummary;
  timeline?: ConversationTimeline;
  loading: boolean;
  onBind: () => Promise<void>;
  onRelease: (sessionId: string) => Promise<void>;
  onSend: (sessionId: string, text: string) => Promise<boolean>;
  sending: boolean;
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
  onSend,
  sending,
  binding,
  releasing,
  debugOpen,
  onToggleDebug,
  rawOutput,
  rawLoading,
}: ConversationPaneProps) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const boundSession = timeline?.boundSession;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [timeline?.messages.length, rawOutput]);

  if (!timeline) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-slate-400">
        <div>
          <div className="mb-2 text-lg font-medium text-slate-200">{loading ? 'Loading conversation…' : 'Pick a conversation'}</div>
          <div>{loading ? 'Fetching normalized history and live state.' : 'Choose an indexed history item or start a new conversation from the project tree.'}</div>
        </div>
      </div>
    );
  }

  const proxyLinks = project?.allowedLocalhostPorts ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
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

      <div ref={scrollRef} className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-4 py-5">
        {loading ? (
          <div className="text-sm text-slate-400">Loading conversation…</div>
        ) : timeline.messages.length > 0 ? (
          timeline.messages.map((message) => (
            <MessageBubble key={message.id} role={message.role} text={message.text} timestamp={message.timestamp} />
          ))
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-center text-slate-400">
            No messages yet. Start the conversation from the composer below.
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

      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!boundSession || !text.trim()) return;
          const currentText = text.trim();
          const sent = await onSend(boundSession.id, currentText);
          if (sent) {
            setText('');
          }
        }}
        className="border-t border-slate-800 bg-slate-950/90 px-4 py-4"
      >
        <div className="flex items-end gap-3">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={boundSession ? 'Send input to the bound agent session…' : 'Bind this conversation to unlock the composer.'}
            disabled={!boundSession || sending}
            rows={3}
            className="min-h-[5rem] flex-1 resize-y rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!boundSession || !text.trim() || sending}
            className="inline-flex h-12 items-center gap-2 rounded-2xl border border-sky-400/30 bg-sky-500/10 px-4 text-sm font-medium text-sky-50 transition hover:bg-sky-500/20 disabled:opacity-50"
          >
            <ArrowRight className="h-4 w-4" />
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
