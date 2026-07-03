import type { NormalizedMessage } from '@agent-console/shared';
import clsx from 'clsx';
import { memo, type ReactNode } from 'react';
import { renderMessageMarkdown } from './markdown';

export type TranscriptTurn = {
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
  if (previous.lifecycle !== next.lifecycle) {
    return false;
  }
  return previous.role === 'assistant' || previous.role === 'user' || previous.role === 'tool';
}

export function groupTranscriptTurns(messages: NormalizedMessage[]): TranscriptTurn[] {
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

export function shouldShowInMainTranscript(message: NormalizedMessage): boolean {
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

export const TranscriptDocumentTurn = memo(function TranscriptDocumentTurn({ turn }: { turn: TranscriptTurn }) {
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
