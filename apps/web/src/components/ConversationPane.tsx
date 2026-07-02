import { Bot, Bug, Check, ChevronDown, ChevronRight, Copy, FolderTree, Link as LinkIcon, PlugZap, Sparkles, Unplug } from 'lucide-react';
import type { ConversationTimeline, NormalizedMessage, ProjectSummary, ProviderId, SessionKeystrokeRequest } from '@agent-console/shared';
import { AnsiUp } from 'ansi_up';
import clsx from 'clsx';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { copyTextToClipboard } from '../lib/clipboard';
import { useConversationScrollController } from '../features/conversation/useConversationScrollController';

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

const LiveAnsiBlock = memo(function LiveAnsiBlock({
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
});

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

function useFrozenValue<T,>(value: T, frozen: boolean, resetKey?: string): T {
  const valueRef = useRef(value);
  const resetKeyRef = useRef(resetKey);
  const frozenRef = useRef(frozen);

  if (resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    valueRef.current = value;
  } else if (!frozen || !frozenRef.current) {
    valueRef.current = value;
  }
  frozenRef.current = frozen;

  return valueRef.current;
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

function messageRoleLabel(role: NormalizedMessage['role']): string {
  switch (role) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Assistant';
    case 'tool':
      return 'Tool';
    case 'system':
      return 'System';
    case 'status':
      return 'Status';
  }
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code key={`${match.index}:code`} className="font-mono text-[0.92em] text-inherit">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<strong key={`${match.index}:bold`} className="font-semibold text-inherit">{token.slice(2, -2)}</strong>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

function renderInlineLines(lines: string[]): ReactNode[] {
  return lines.flatMap((line, index) => [
    ...renderInlineMarkdown(line),
    ...(index < lines.length - 1 ? [<br key={`br:${index}`} />] : []),
  ]);
}

function isMarkdownBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return /^```/.test(trimmed)
    || /^#{1,4}\s+/.test(trimmed)
    || /^[-*_]{3,}$/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || /^[-*]\s+/.test(trimmed)
    || /^\d+[.)]\s+/.test(trimmed);
}

function renderMessageMarkdown(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test((lines[index] ?? '').trim())) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(
        <pre key={`code:${index}`} className="my-3 overflow-x-auto border-l border-current pl-3 text-xs leading-5 text-inherit">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      blocks.push(
        <div key={`heading:${index}`} className="mt-4 text-base font-semibold text-inherit first:mt-0">
          {renderInlineMarkdown(headingMatch[2] ?? '')}
        </div>,
      );
      index += 1;
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      blocks.push(<div key={`rule:${index}`} className="my-4 border-t border-slate-800" />);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test((lines[index] ?? '').trim())) {
        quoteLines.push((lines[index] ?? '').trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote:${index}`} className="my-3 pl-3 text-inherit">
          {renderInlineLines(quoteLines)}
        </blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test((lines[index] ?? '').trim())) {
        items.push((lines[index] ?? '').trim().replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`ul:${index}`} className="my-3 list-disc space-y-1 pl-5">
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test((lines[index] ?? '').trim())) {
        items.push((lines[index] ?? '').trim().replace(/^\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`ol:${index}`} className="my-3 list-decimal space-y-1 pl-5">
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
        </ol>,
      );
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim() && !isMarkdownBlockStart(lines[index] ?? '')) {
      paragraphLines.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(
      <p key={`p:${index}`} className="my-3 first:mt-0 last:mb-0">
        {renderInlineLines(paragraphLines)}
      </p>,
    );
  }

  return blocks.length > 0 ? blocks : [text];
}

type TranscriptTurn = {
  id: string;
  role: NormalizedMessage['role'];
  lifecycle: NormalizedMessage['lifecycle'];
  startedAt: string;
  endedAt: string;
  messages: NormalizedMessage[];
};

type EmbeddedTranscriptSegment = {
  type: 'transcript';
  role: NormalizedMessage['role'];
  label: string;
  timestamp: string;
  text: string;
};

type EmbeddedTranscriptPart =
  | { type: 'text'; text: string }
  | EmbeddedTranscriptSegment;

function transcriptSpeakerRole(label: string): NormalizedMessage['role'] | undefined {
  switch (label.trim().toLowerCase()) {
    case 'you':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return 'tool';
    case 'system':
      return 'system';
    case 'status':
      return 'status';
    default:
      return undefined;
  }
}

function parseTranscriptSpeakerLine(line: string): { role: NormalizedMessage['role']; label: string; prefix?: string } | undefined {
  const exactRole = transcriptSpeakerRole(line);
  if (exactRole) {
    return { role: exactRole, label: line.trim() };
  }
  const suffixMatch = line.match(/^(.*:\s*)(You|Assistant|Tool|System|Status)\s*$/i);
  const suffixRole = suffixMatch ? transcriptSpeakerRole(suffixMatch[2] ?? '') : undefined;
  if (!suffixMatch || !suffixRole) {
    return undefined;
  }
  return { role: suffixRole, label: suffixMatch[2] ?? '', prefix: suffixMatch[1] ?? '' };
}

function isTranscriptTimestampLine(line: string): boolean {
  return /^\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:AM|PM)$/i.test(line.trim());
}

function parseEmbeddedTranscriptParts(text: string): EmbeddedTranscriptPart[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const parts: EmbeddedTranscriptPart[] = [];
  const pendingTextLines: string[] = [];
  let index = 0;

  const flushPendingText = () => {
    const pendingText = pendingTextLines.join('\n').trimEnd();
    if (pendingText) {
      parts.push({ type: 'text', text: pendingText });
    }
    pendingTextLines.length = 0;
  };

  while (index < lines.length) {
    const speaker = parseTranscriptSpeakerLine(lines[index] ?? '');
    if (!speaker || !isTranscriptTimestampLine(lines[index + 1] ?? '')) {
      pendingTextLines.push(lines[index] ?? '');
      index += 1;
      continue;
    }

    if (speaker.prefix) {
      pendingTextLines.push(speaker.prefix.trimEnd());
    }
    flushPendingText();

    const timestamp = (lines[index + 1] ?? '').trim();
    index += 2;
    const transcriptLines: string[] = [];
    while (index < lines.length) {
      const nextSpeaker = parseTranscriptSpeakerLine(lines[index] ?? '');
      if (nextSpeaker && isTranscriptTimestampLine(lines[index + 1] ?? '')) {
        break;
      }
      transcriptLines.push(lines[index] ?? '');
      index += 1;
    }

    parts.push({
      type: 'transcript',
      role: speaker.role,
      label: speaker.label,
      timestamp,
      text: transcriptLines.join('\n').trim(),
    });
  }

  flushPendingText();
  return parts;
}

function renderUserMessageContent(text: string): ReactNode[] {
  const parts = parseEmbeddedTranscriptParts(text);
  if (!parts.some((part) => part.type === 'transcript')) {
    return [
      <div key="user-text" className="font-bold text-emerald-600">
        {renderMessageMarkdown(text)}
      </div>,
    ];
  }

  return parts.map((part, index) => {
    if (part.type === 'text') {
      return (
        <div key={`text:${index}`} className="font-bold text-emerald-600">
          {renderMessageMarkdown(part.text)}
        </div>
      );
    }
    const isEmbeddedUser = part.role === 'user';
    return (
      <div
        key={`transcript:${index}`}
        className={clsx(
          'my-3 border-l pl-3',
          isEmbeddedUser
            ? 'border-emerald-800 font-bold text-emerald-600'
            : 'border-slate-800 font-normal text-slate-100',
        )}
      >
        <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className={clsx(isEmbeddedUser ? 'font-bold text-emerald-600' : 'font-semibold text-slate-300')}>{part.label}</span>
          <span>{part.timestamp}</span>
        </div>
        {part.text ? renderMessageMarkdown(part.text) : null}
      </div>
    );
  });
}

function messagesShareTranscriptTurn(previous: NormalizedMessage, next: NormalizedMessage): boolean {
  if (previous.role !== next.role) {
    return false;
  }
  return previous.role === 'assistant' || previous.role === 'user' || previous.role === 'tool';
}

function groupTranscriptTurns(messages: NormalizedMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const message of messages) {
    const lastTurn = turns.at(-1);
    const lastMessage = lastTurn?.messages.at(-1);
    if (lastTurn && lastMessage && messagesShareTranscriptTurn(lastMessage, message)) {
      lastTurn.id = `${lastTurn.id}:${message.id}`;
      lastTurn.lifecycle = lastTurn.lifecycle === 'pending' || message.lifecycle === 'pending' ? 'pending' : message.lifecycle;
      lastTurn.endedAt = message.timestamp;
      lastTurn.messages.push(message);
      continue;
    }
    turns.push({
      id: message.id,
      role: message.role,
      lifecycle: message.lifecycle,
      startedAt: message.timestamp,
      endedAt: message.timestamp,
      messages: [message],
    });
  }
  return turns;
}

function shouldShowInMainTranscript(message: NormalizedMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false;
  }
  if (message.lifecycle === 'pending' && message.source === 'live-output' && message.role !== 'assistant') {
    return false;
  }
  return true;
}

function formatTimestampRange(startedAt: string, endedAt: string): string {
  const started = new Date(startedAt).toLocaleString();
  if (startedAt === endedAt) {
    return started;
  }
  return `${started} - ${new Date(endedAt).toLocaleTimeString()}`;
}

function combinedTurnText(turn: TranscriptTurn): string {
  return turn.messages
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join(turn.role === 'assistant' ? '\n' : '\n\n');
}

const TranscriptDocumentTurn = memo(function TranscriptDocumentTurn({ turn }: { turn: TranscriptTurn }) {
  const isPending = turn.lifecycle === 'pending';
  const isUser = turn.role === 'user';
  const turnText = combinedTurnText(turn);
  return (
    <article className="py-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-slate-500">
        <span className={clsx(isUser ? 'font-bold text-emerald-500' : 'font-semibold text-slate-300')}>{messageRoleLabel(turn.role)}</span>
        {isPending ? <span className="text-amber-300">pending</span> : null}
        <time>{formatTimestampRange(turn.startedAt, turn.endedAt)}</time>
      </div>
      <div className="max-w-none break-words text-sm leading-7 text-slate-100">
        {isUser ? renderUserMessageContent(turnText) : renderMessageMarkdown(turnText)}
      </div>
    </article>
  );
});

function LiveSessionStatus({
  status,
  statusAnsi,
  model,
  contextPercent,
  mobileCompact,
}: {
  status: string;
  statusAnsi?: string;
  model?: string;
  contextPercent?: number;
  mobileCompact: boolean;
}) {
  const statusSummary = status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? 'Session active';

  const metaLine = [model, contextPercent !== undefined ? `${contextPercent}% left` : undefined]
    .filter(Boolean)
    .join(' · ') || undefined;

  const statusAlreadyHasMeta = (model && status.includes(model)) || /\d{1,3}% left/.test(status);

  if (mobileCompact) {
    return (
      <MobileSummaryStrip
        title="Status"
        summary={metaLine && !statusAlreadyHasMeta ? `${metaLine} · ${statusSummary}` : statusSummary}
        className="border-t border-slate-800 bg-slate-900/90"
      />
    );
  }

  return (
    <div className="border-t border-slate-800 bg-slate-900/90 px-4 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">Status</div>
      {metaLine && !statusAlreadyHasMeta && (
        <div className="mb-1 font-mono text-sm leading-6 text-slate-400">{metaLine}</div>
      )}
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

const MIN_BRIDGE_HEIGHT_PX = 96;
const MAX_BRIDGE_HEIGHT_VIEWPORT_RATIO = 0.6;
const BRIDGE_HEIGHT_STORAGE_KEY = 'agent-console:live-bridge-height';

function readStoredBridgeHeight(): number {
  const stored = globalThis.localStorage?.getItem(BRIDGE_HEIGHT_STORAGE_KEY);
  if (!stored) {
    return MIN_BRIDGE_HEIGHT_PX;
  }
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : MIN_BRIDGE_HEIGHT_PX;
}

function storeBridgeHeight(height: number): void {
  globalThis.localStorage?.setItem(BRIDGE_HEIGHT_STORAGE_KEY, String(height));
}

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
}

const liveBridgeDraftStore = new Map<string, LiveBridgeDraftState>();

function upsertLiveBridgeDraft(
  conversationKey: string,
  updater: (current: LiveBridgeDraftState) => LiveBridgeDraftState,
): void {
  const next = updater(liveBridgeDraftStore.get(conversationKey) ?? {});
  if (!next.draftText && !next.draftDirty) {
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
  inputText,
  onSendKeystrokes,
  onLocalSubmittedText,
  onDiscardLocalSubmittedText,
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
  inputText: string;
  onSendKeystrokes: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<boolean>;
  onLocalSubmittedText: (sessionId: string, text: string) => { id: string } | undefined;
  onDiscardLocalSubmittedText: (messageId: string) => void;
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
  const [textBypassEnabled, setTextBypassEnabled] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftDirty, setDraftDirty] = useState(false);
  const [bypassPreviewText, setBypassPreviewText] = useState<string>();
  const [copyingLastMessage, setCopyingLastMessage] = useState(false);
  const [copiedLastMessage, setCopiedLastMessage] = useState(false);
  const [bridgeHeight, setBridgeHeight] = useState(readStoredBridgeHeight);
  const captureRef = useRef<HTMLTextAreaElement | null>(null);
  const bridgeHeightRef = useRef(bridgeHeight);
  const resizeSessionRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const keyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingTextRef = useRef('');
  const textFlushInFlightRef = useRef<Promise<boolean> | undefined>(undefined);
  const keepBypassSelectionPinnedRef = useRef(false);
  const flushTimerRef = useRef<number | undefined>(undefined);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const committedInputRef = useRef(inputText);
  const bridgeBusyRef = useRef(false);
  const [bridgeBusy, setBridgeBusy] = useState(false);

  useEffect(() => {
    captureRef.current?.focus();
  }, [sessionId]);

  useEffect(() => {
    bridgeHeightRef.current = bridgeHeight;
  }, [bridgeHeight]);

  useEffect(() => {
    resizeCleanupRef.current?.();
    const nextHeight = clampBridgeHeight(bridgeHeightRef.current);
    setBridgeHeight(nextHeight);
    storeBridgeHeight(nextHeight);
  }, [compact, sessionId]);

  useEffect(() => {
    if (!bridgeOpen) {
      return;
    }
    captureRef.current?.focus();
  }, [bridgeOpen]);

  useEffect(() => {
    pendingTextRef.current = '';
    textFlushInFlightRef.current = undefined;
    keepBypassSelectionPinnedRef.current = false;
    committedInputRef.current = inputText;
    setTextBypassEnabled(false);
    setBypassPreviewText(undefined);
    const storedDraft = liveBridgeDraftStore.get(conversationKey);
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
    resizeCleanupRef.current?.();
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
      if (textBypassEnabled && keepBypassSelectionPinnedRef.current) {
        const end = value.length;
        capture.setSelectionRange(end, end);
      }
    }
    if (textBypassEnabled && keepBypassSelectionPinnedRef.current) {
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
    if (textFlushInFlightRef.current) {
      return await textFlushInFlightRef.current;
    }
    if (!pendingTextRef.current) {
      return true;
    }
    if (flushTimerRef.current !== undefined) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = undefined;
    }
    const task = (async (): Promise<boolean> => {
      let ok = true;
      while (pendingTextRef.current) {
        const text = pendingTextRef.current;
        pendingTextRef.current = '';
        ok = await queueKeystrokes({ text, deferScreenUpdate: true });
        if (!ok) {
          break;
        }
      }
      return ok;
    })();
    textFlushInFlightRef.current = task;
    try {
      return await task;
    } finally {
      if (textFlushInFlightRef.current === task) {
        textFlushInFlightRef.current = undefined;
      }
      if (pendingTextRef.current) {
        scheduleBufferedTextFlush();
      }
    }
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
    keepBypassSelectionPinnedRef.current = true;
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
    const submittedText = extraKeys.includes('Enter') ? nextText.trim() : '';
    const clearImmediately = options.clearAfterSend === true;
    if (clearImmediately) {
      setDraftText('');
      setDraftDirty(false);
    }
    let prefixLength = 0;
    while (prefixLength < baseText.length && prefixLength < nextText.length && baseText[prefixLength] === nextText[prefixLength]) {
      prefixLength += 1;
    }
    const backspaces = baseText.length - prefixLength;
    const appendedText = nextText.slice(prefixLength);

    if (backspaces > 0) {
      const ok = await queueKeystrokes({ keys: Array.from({ length: backspaces }, () => 'BSpace' as const) });
      if (!ok) {
        if (clearImmediately) {
          setDraftText(nextText);
          setDraftDirty(true);
        }
        return false;
      }
    }

    if (appendedText || extraKeys.length > 0) {
      const ok = await queueKeystrokes({
        ...(appendedText ? { text: appendedText } : {}),
        ...(extraKeys.length > 0 ? { keys: extraKeys } : {}),
        ...(submittedText ? { submittedText } : {}),
      });
      if (!ok) {
        if (clearImmediately) {
          setDraftText(nextText);
          setDraftDirty(true);
        }
        return false;
      }
    }

    committedInputRef.current = options.clearAfterSend ? '' : nextText;
    if (!clearImmediately) {
      setDraftDirty(false);
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
        keepBypassSelectionPinnedRef.current = false;
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
      keepBypassSelectionPinnedRef.current = true;
      captureRef.current?.focus({ preventScroll: true });
    });
  }

  function bypassPreviewAfterSubmit(preview: string, submittedText: string): string {
    if (!preview) {
      return '';
    }
    if (submittedText && preview.startsWith(submittedText)) {
      return preview.slice(submittedText.length);
    }
    return preview;
  }

  function clearSubmittedBypassPreview(submittedText: string): string {
    const previewBeforeSubmit = bypassPreviewText ?? inputText;
    setBypassPreviewText((current) => bypassPreviewAfterSubmit(current ?? '', submittedText));
    return previewBeforeSubmit;
  }

  function restoreSubmittedBypassPreview(submittedText: string, previewBeforeSubmit: string): void {
    const expectedPreview = bypassPreviewAfterSubmit(previewBeforeSubmit, submittedText);
    setBypassPreviewText((current) => ((current ?? '') === expectedPreview ? previewBeforeSubmit : current));
  }

  async function submitTextBypassEnter(): Promise<void> {
    await runBridgeAction(async () => {
      const submittedText = (bypassPreviewText ?? inputText).trim();
      keepBypassSelectionPinnedRef.current = true;
      const previewBeforeSubmit = clearSubmittedBypassPreview(submittedText);
      const optimisticMessage = submittedText ? onLocalSubmittedText(sessionId, submittedText) : undefined;
      const restore = () => {
        restoreSubmittedBypassPreview(submittedText, previewBeforeSubmit);
        if (optimisticMessage) {
          onDiscardLocalSubmittedText(optimisticMessage.id);
        }
      };

      const flushed = await flushBufferedText();
      if (!flushed) {
        restore();
        return;
      }
      const submitted = await queueKeystrokes({
        keys: ['Enter'],
        ...(submittedText ? {
          submittedText,
          ...(optimisticMessage ? { clientOptimisticMessageId: optimisticMessage.id } : {}),
        } : {}),
      });
      if (!submitted) {
        restore();
      }
    });
  }

  async function handleSpecialKey(specialKey: SessionKeyToken, source: 'keyboard' | 'button' = 'keyboard'): Promise<void> {
    if (source === 'button') {
      if (specialKey === 'Enter') {
        if (textBypassEnabled) {
          await submitTextBypassEnter();
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
        keepBypassSelectionPinnedRef.current = true;
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
          keepBypassSelectionPinnedRef.current = true;
          pendingTextRef.current = pendingTextRef.current.slice(0, -1);
          setBypassPreviewText((current) => (current ?? inputText).slice(0, -1));
          return;
        }
        keepBypassSelectionPinnedRef.current = true;
        setBypassPreviewText((current) => (current ?? inputText).slice(0, -1));
        enqueueKeystrokes({ keys: ['BSpace'] });
        return;
      }
      replaceDraftText(draftText.slice(0, -1));
      return;
    }

    if (textBypassEnabled) {
      const submittedText = specialKey === 'Enter' ? (bypassPreviewText ?? inputText).trim() : '';
      if (specialKey === 'Enter') {
        await submitTextBypassEnter();
        return;
      }
      const ok = await flushBufferedText();
      if (!ok) {
        return;
      }
      keepBypassSelectionPinnedRef.current = true;
      setBypassPreviewText(undefined);
      enqueueKeystrokes({
        keys: [specialKey],
        ...(submittedText ? { submittedText } : {}),
      });
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

  function clampBridgeHeight(nextHeight: number): number {
    const viewportCap = Math.floor(window.innerHeight * MAX_BRIDGE_HEIGHT_VIEWPORT_RATIO);
    return Math.max(MIN_BRIDGE_HEIGHT_PX, Math.min(viewportCap, Math.round(nextHeight)));
  }

  function updateBridgeHeight(nextHeight: number): void {
    const clampedHeight = clampBridgeHeight(nextHeight);
    setBridgeHeight(clampedHeight);
    storeBridgeHeight(clampedHeight);
  }

  function beginBridgeResize(pointerY: number): void {
    resizeCleanupRef.current?.();
    resizeSessionRef.current = {
      startY: pointerY,
      startHeight: bridgeHeightRef.current,
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (event: PointerEvent) => {
      const active = resizeSessionRef.current;
      if (!active) {
        return;
      }
      const nextHeight = active.startHeight + (active.startY - event.clientY);
      updateBridgeHeight(nextHeight);
    };

    const endResize = () => {
      resizeSessionRef.current = null;
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      if (resizeCleanupRef.current === endResize) {
        resizeCleanupRef.current = null;
      }
    };

    resizeCleanupRef.current = endResize;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
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

  return (
    <div className="border-t border-slate-800 bg-slate-950/90">
      {renderBridgeHeader('Live input bridge', 'Expand to type directly into the live session.', { showControlsToggle: true })}
      {bridgeOpen && (
        <div className={bridgeBodyClassName}>
          <button
            type="button"
            aria-label="Resize live input bridge"
            title="Drag to resize live input bridge"
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              beginBridgeResize(event.clientY);
            }}
            className="mb-3 flex h-4 w-full touch-none cursor-row-resize items-center justify-center rounded-xl text-slate-500 transition hover:text-slate-300"
          >
            <span className="h-1.5 w-16 rounded-full bg-slate-700/90" />
          </button>
          <textarea
            ref={captureRef}
            readOnly={bridgeBusy}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
            onFocus={(event) => {
              if (textBypassEnabled) {
                keepBypassSelectionPinnedRef.current = true;
                const end = bridgeText.length;
                event.currentTarget.setSelectionRange(end, end);
              }
            }}
            onPointerDown={() => {
              keepBypassSelectionPinnedRef.current = false;
            }}
            onSelect={(event) => {
              if (!textBypassEnabled) {
                return;
              }
              const target = event.currentTarget;
              const end = target.value.length;
              keepBypassSelectionPinnedRef.current = target.selectionStart === end && target.selectionEnd === end;
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
              if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === '/') {
                event.preventDefault();
                if (!event.repeat) {
                  void handleToggleTextBypass();
                }
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
            rows={3}
            value={bridgeText}
            style={{ height: `${bridgeHeight}px` }}
            className={clsx(
              'w-full resize-none overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 font-mono text-sm text-slate-100 outline-none transition focus:border-sky-400',
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
  liveMode: boolean;
  loading: boolean;
  workMode: boolean;
  mobileChromeHidden: boolean;
  onToggleMobileChrome: () => void;
  mobileControlsHidden: boolean;
  onToggleMobileControls: () => void;
  onBind: () => Promise<void>;
  onRelease: (sessionId: string) => Promise<void>;
  onSendKeystrokes: (sessionId: string, payload: SessionKeystrokeRequest) => Promise<boolean>;
  onLocalSubmittedText: (sessionId: string, text: string) => { id: string } | undefined;
  onDiscardLocalSubmittedText: (messageId: string) => void;
  binding: boolean;
  releasing: boolean;
  debugOpen: boolean;
  onToggleDebug: () => void;
  rawOutput?: string;
  rawLoading: boolean;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => Promise<void>;
  conversationKey?: string;
  historyPrependVersion: number;
  tailKey?: string;
}

export function ConversationPane({
  projects,
  project,
  selectedProvider,
  timeline,
  liveMode,
  loading,
  workMode,
  mobileChromeHidden,
  onToggleMobileChrome,
  mobileControlsHidden,
  onToggleMobileControls,
  onBind,
  onRelease,
  onSendKeystrokes,
  onLocalSubmittedText,
  onDiscardLocalSubmittedText,
  binding,
  releasing,
  debugOpen,
  onToggleDebug,
  rawOutput,
  rawLoading,
  hasOlderMessages,
  loadingOlderMessages,
  onLoadOlderMessages,
  conversationKey,
  historyPrependVersion,
  tailKey,
}: ConversationPaneProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [mobileBridgeOpen, setMobileBridgeOpen] = useState(true);
  const boundSession = timeline?.boundSession;
  const liveScreen = timeline?.liveScreen;
  const compactLiveLayout = workMode && liveMode;
  const hideTopPanel = mobileChromeHidden;
  const historyMessages = timeline?.messages ?? [];
  const hasSavedHistory = historyMessages.length > 0;
  const showHistory = hasSavedHistory;
  const latestAssistantMessage = useMemo(() => {
    for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
      const message = historyMessages[index];
      if (message?.role === 'assistant') {
        return message.text;
      }
    }
    return '';
  }, [historyMessages]);
  const activeSurface = showHistory || hasOlderMessages || loadingOlderMessages
    ? 'history'
    : (liveMode ? 'live' : 'empty');
  const layoutKey = [
    hideTopPanel ? 'top:hidden' : 'top:shown',
    debugOpen ? 'debug:open' : 'debug:closed',
    mobileBridgeOpen ? 'bridge:open' : 'bridge:closed',
    mobileControlsHidden ? 'controls:hidden' : 'controls:shown',
    `surface:${activeSurface}`,
    compactLiveLayout ? 'layout:compact' : 'layout:regular',
    isMobile ? 'viewport:mobile' : 'viewport:desktop',
  ].join('|');
  const { scrollRef, selectionActive } = useConversationScrollController({
    conversationKey,
    activeSurface,
    tailKey,
    layoutKey,
    historyPrependVersion,
    hasOlderHistory: hasOlderMessages,
    loadingOlderHistory: loadingOlderMessages,
    onLoadOlderHistory: onLoadOlderMessages,
    loading,
  });
  const historyRenderState = useMemo(() => ({
    messages: historyMessages,
    hasOlderMessages,
    loadingOlderMessages,
  }), [hasOlderMessages, historyMessages, loadingOlderMessages]);
  const renderedHistoryState = useFrozenValue(historyRenderState, selectionActive, conversationKey);
  const renderedHistoryMessages = renderedHistoryState.messages;
  const renderedHasOlderMessages = renderedHistoryState.hasOlderMessages;
  const renderedLoadingOlderMessages = renderedHistoryState.loadingOlderMessages;
  const visibleHistoryMessages = useMemo(
    () => renderedHistoryMessages.filter(shouldShowInMainTranscript),
    [renderedHistoryMessages],
  );
  const renderedShowMessages = visibleHistoryMessages.length > 0;
  const renderedHistoryTurns = useMemo(
    () => groupTranscriptTurns(visibleHistoryMessages),
    [visibleHistoryMessages],
  );

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

  if (workMode && !boundSession) {
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
        className="scrollbar-thin flex-1 min-h-0 overflow-y-auto px-4 py-5"
      >
        {renderedShowMessages || renderedHasOlderMessages || renderedLoadingOlderMessages ? (
          <div className="w-full divide-y divide-slate-900/80 pb-5">
            {(renderedHasOlderMessages || renderedLoadingOlderMessages) && (
              <div className="text-center text-xs text-slate-500">
                {renderedLoadingOlderMessages ? 'Loading earlier messages…' : 'Scroll up to load earlier messages'}
              </div>
            )}
            {renderedHistoryTurns.map((turn) => (
              <TranscriptDocumentTurn key={turn.id} turn={turn} />
            ))}
          </div>
        ) : boundSession ? (
          <div className="mx-auto max-w-2xl rounded-md border border-dashed border-slate-700 p-6 text-center text-slate-400">
            Waiting for session output…
          </div>
        ) : (
          <div className="mx-auto max-w-2xl rounded-md border border-dashed border-slate-700 p-6 text-center text-slate-400">
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
          inputText={liveScreen?.inputText ?? ''}
          onSendKeystrokes={onSendKeystrokes}
          onLocalSubmittedText={onLocalSubmittedText}
          onDiscardLocalSubmittedText={onDiscardLocalSubmittedText}
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
          model={liveScreen.model ?? timeline?.conversation.model}
          contextPercent={liveScreen.contextPercent}
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
