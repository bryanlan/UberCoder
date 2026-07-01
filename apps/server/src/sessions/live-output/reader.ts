import type { BoundSession, NormalizedMessage } from '@agent-console/shared';
import { normalizeWhitespace, stripAnsiAndControl, truncate } from '../../lib/text.js';
import {
  classifyChunk,
  linesAreOnlyProviderProgressRepaint,
  normalizeRawOutputLines,
  rawOutputStartsProviderProgress,
  removePreviouslySeenAssistantText,
  shouldDropPreSubmitPromptEcho,
  splitRawOutputAtProviderProgress,
} from './filters.js';
import {
  getEventLogReadPlan,
  parseSessionEventEntries,
  readEventLogText,
  type ReadLiveMessagesOptions,
  type SessionEventEntry,
} from './event-log-reader.js';
const MAX_LIVE_MESSAGE_CACHE_ENTRIES = 64;

function cloneMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  return messages.map((message) => ({ ...message }));
}

function liveMessageId(sessionId: string, offset: number): string {
  return `live:${sessionId}:${offset}`;
}

function nearbyRawEventContext(events: SessionEventEntry[], index: number): string {
  const context: string[] = [];
  const start = Math.max(0, index - 4);
  const end = Math.min(events.length - 1, index + 4);
  for (let cursor = start; cursor <= end; cursor += 1) {
    if (cursor === index) {
      continue;
    }
    const event = events[cursor]?.event;
    if (event?.type === 'raw-output' || event?.type === 'status') {
      context.push(stripAnsiAndControl(event.text));
    }
  }
  return context.join('\n');
}

function userInputLooksLikeProviderCommandControl(text: string, events: SessionEventEntry[], index: number): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('/')) {
    return true;
  }
  if (!/^\d{1,8}$/.test(trimmed)) {
    return false;
  }

  const context = nearbyRawEventContext(events, index);
  return /(?:Select model|Switch between Claude models|Your pick becomes the default|For other\/previous model names|Enter to set as default|s to use this session only|Set\s*model\s*to|Set\s*mode\s*to|saved as your default for new sessions|Select Model and Effort|Effort not supported|Faster Smarter|lowmediumhighxhighmax|Enter to confirm\s*·\s*Esc to exit|Press enter to confirm or esc to go back)/i.test(context);
}

export class LiveOutputReader {
  private readonly liveMessageCache = new Map<string, { messages: NormalizedMessage[] }>();

  clear(): void {
    this.liveMessageCache.clear();
  }

  async readLiveMessages(session: BoundSession, options: ReadLiveMessagesOptions = {}): Promise<NormalizedMessage[]> {
    if (!session.eventLogPath) return [];
    try {
      const plan = await getEventLogReadPlan(session.eventLogPath, options);
      const { cacheKey } = plan;
      const cached = this.liveMessageCache.get(cacheKey);
      if (cached) {
        return cloneMessages(cached.messages);
      }
      const readResult = await readEventLogText(session.eventLogPath, plan);

    const events = parseSessionEventEntries(readResult);

    const grouped: NormalizedMessage[] = [];
    let lastUserInput = readResult.lastUserInputBeforeText;
    let hasTrackedUserTurn = Boolean(readResult.lastUserInputBeforeText?.trim());
    const priorUserInputEchoes = readResult.lastUserInputBeforeText ? [readResult.lastUserInputBeforeText] : [];
    let suppressProviderProgressRepaints = false;
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const entry = events[eventIndex]!;
      const event = entry.event;
      if (event.type === 'user-input') {
        const text = event.text.trim();
        if (!text) continue;
        suppressProviderProgressRepaints = false;
        if (userInputLooksLikeProviderCommandControl(text, events, eventIndex)) {
          continue;
        }
        if (shouldDropPreSubmitPromptEcho(grouped.at(-1), text, event.timestamp)) {
          grouped.pop();
        }
        lastUserInput = text;
        hasTrackedUserTurn = true;
        priorUserInputEchoes.push(text);
        grouped.push({
          id: liveMessageId(session.id, entry.offset),
          provider: session.provider,
          role: 'user',
          lifecycle: 'durable',
          text,
          timestamp: event.timestamp,
          conversationRef: session.conversationRef,
          source: 'user-input',
        });
        continue;
      }

      if (event.type === 'raw-output' && !hasTrackedUserTurn) {
        continue;
      }

      const rawOutputHasProviderProgress = event.type === 'raw-output'
        && rawOutputStartsProviderProgress(event.text);
      const providerProgress = rawOutputHasProviderProgress
        ? splitRawOutputAtProviderProgress(event.text, lastUserInput)
        : undefined;
      let lines = event.type === 'status'
        ? [truncate(normalizeWhitespace(stripAnsiAndControl(event.text)), 240)].filter(Boolean)
        : normalizeRawOutputLines(
          providerProgress?.progressStarted ? providerProgress.beforeProgressText : event.text,
          lastUserInput,
          priorUserInputEchoes,
        );

      if (event.type === 'raw-output') {
        if (providerProgress?.progressStarted && rawOutputHasProviderProgress) {
          suppressProviderProgressRepaints = true;
          if (
            providerProgress.echoedUserInputAfterProgress
            || linesAreOnlyProviderProgressRepaint(lines)
          ) {
            continue;
          }
        }
        if (suppressProviderProgressRepaints && linesAreOnlyProviderProgressRepaint(lines)) {
          continue;
        }
        if (lines.length > 0 && !providerProgress?.progressStarted) {
          suppressProviderProgressRepaints = false;
        }
      }

      for (const line of lines) {
        const dedupedLine = event.type === 'raw-output'
          ? removePreviouslySeenAssistantText(line, grouped)
          : line;
        if (!dedupedLine) {
          continue;
        }
        const role = event.type === 'status' ? 'status' : classifyChunk(dedupedLine);
        const text = role === 'status' ? truncate(dedupedLine, 240) : dedupedLine;
        const previous = grouped.at(-1);
        if (previous && previous.role === role && previous.source === 'live-output' && event.type === 'raw-output') {
          previous.text = role === 'status'
            ? text
            : `${previous.text}\n${text}`.trim();
          previous.timestamp = event.timestamp;
          continue;
        }
        grouped.push({
          id: liveMessageId(session.id, entry.offset),
          provider: session.provider,
          role,
          lifecycle: role === 'status' ? 'status' : 'pending',
          text,
          timestamp: event.timestamp,
          conversationRef: session.conversationRef,
          source: event.type === 'status' ? 'synthetic-status' : 'live-output',
        });
      }
    }
      this.rememberLiveMessages(cacheKey, grouped);
      return cloneMessages(grouped);
    } catch {
      return [];
    }
  }

  private rememberLiveMessages(cacheKey: string, messages: NormalizedMessage[]): void {
    this.liveMessageCache.set(cacheKey, { messages: cloneMessages(messages) });
    if (this.liveMessageCache.size <= MAX_LIVE_MESSAGE_CACHE_ENTRIES) {
      return;
    }

    const oldestKey = this.liveMessageCache.keys().next().value as string | undefined;
    if (oldestKey) {
      this.liveMessageCache.delete(oldestKey);
    }
  }
}
