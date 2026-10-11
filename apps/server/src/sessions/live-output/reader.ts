import type { BoundSession, NormalizedMessage } from '@agent-console/shared';
import { normalizeWhitespace, stripAnsiAndControl, truncate } from '../../lib/text.js';
import {
  classifyChunk,
  linesAreOnlyProviderProgressRepaint,
  normalizeRawOutputLines,
  rawOutputStartsProviderProgress,
  shouldDropPreSubmitPromptEcho,
  splitRawOutputAtProviderProgress,
} from './filters.js';
import {
  getEventLogReadPlan,
  parseSessionEventEntries,
  readAppendedEventLogText,
  type EventLogReadPlan,
  type EventLogReadResult,
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
  return /(?:Select model|Select Reasoning Level for|Switch between Claude models|Your pick becomes the default|For other\/previous model names|Enter to set as default|s to use this session only|Set\s*model\s*to|Set\s*mode\s*to|saved as your default for new sessions|Select Model and Effort|Effort not supported|Faster Smarter|lowmediumhighxhighmax|Enter (?:select|default)\s*·\s*(?:s session\s*·\s*)?Esc back|Enter to confirm\s*·\s*Esc to exit|Press enter to confirm or esc to go back)/i.test(context);
}

interface NormalizedRawEvent {
  type: SessionEventEntry['event']['type'];
  text: string;
  echoContext: string;
  lines: string[];
  rawOutputHasProviderProgress: boolean;
  providerProgress?: ReturnType<typeof splitRawOutputAtProviderProgress>;
}
interface LiveSnapshot {
  plan: EventLogReadPlan;
  read: EventLogReadResult;
  messages: NormalizedMessage[];
  normalizedEvents: Map<number, NormalizedRawEvent>;
  bytes: number;
}
const MAX_LIVE_CACHE_BYTES = 64 * 1024 * 1024;

export class LiveOutputReader {
  private readonly liveMessageCache = new Map<string, LiveSnapshot>();
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<LiveSnapshot> }>();
  private cacheBytes = 0;
  private generation = 0;

  clear(): void {
    this.generation++;
    this.liveMessageCache.clear();
    this.inFlight.clear();
    this.cacheBytes = 0;
  }

  async readLiveMessages(session: BoundSession, options: ReadLiveMessagesOptions = {}): Promise<NormalizedMessage[]> {
    if (!session.eventLogPath) return [];
    try {
      const plan = await getEventLogReadPlan(session.eventLogPath, options);
      const key = `${session.provider}:${session.id}:${session.conversationRef}:${session.eventLogPath}:${plan.maxBytes ?? 'all'}`;
      const cached = this.liveMessageCache.get(key);
      if (cached?.plan.cacheKey === plan.cacheKey) {
        this.liveMessageCache.delete(key);
        this.liveMessageCache.set(key, cached);
        return cloneMessages(cached.messages);
      }
      const pending = this.inFlight.get(key);
      if (pending?.fingerprint === plan.cacheKey) return cloneMessages((await pending.promise).messages);
      const generation = this.generation;
      const promise = this.reconstruct(session, plan, cached);
      this.inFlight.set(key, { fingerprint: plan.cacheKey, promise });
      try {
        const snapshot = await promise;
        if (generation === this.generation && this.inFlight.get(key)?.promise === promise) {
          this.rememberLiveMessages(key, snapshot);
        }
        return cloneMessages(snapshot.messages);
      } finally {
        if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
      }
    } catch {
      return [];
    }
  }

  private async reconstruct(session: BoundSession, plan: EventLogReadPlan, previous?: LiveSnapshot): Promise<LiveSnapshot> {
    const readResult = await readAppendedEventLogText(session.eventLogPath!, plan,
      previous ? { plan: previous.plan, read: previous.read } : undefined);
    const events = await parseSessionEventEntries(readResult);

    const grouped: NormalizedMessage[] = [];
    let lastUserInput = readResult.lastUserInputBeforeText;
    let hasTrackedUserTurn = Boolean(readResult.lastUserInputBeforeText?.trim());
    const priorUserInputEchoes = readResult.lastUserInputBeforeText ? [readResult.lastUserInputBeforeText] : [];
    let suppressProviderProgressRepaints = false;
    const seenAssistantLines = new Set<string>();
    let echoContext = JSON.stringify(priorUserInputEchoes);
    let yieldedAt = performance.now();
    const normalizedEvents = new Map<number, NormalizedRawEvent>();
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      if (performance.now() - yieldedAt >= 8) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        yieldedAt = performance.now();
      }
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
        seenAssistantLines.clear();
        lastUserInput = text;
        hasTrackedUserTurn = true;
        priorUserInputEchoes.push(text);
        echoContext = JSON.stringify(priorUserInputEchoes);
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

      // Codex conversation text comes exclusively from its structured transcript.
      // Terminal output remains available through the screen and debug routes.
      if (event.type === 'raw-output' && (session.provider === 'codex' || !hasTrackedUserTurn)) {
        continue;
      }

      let normalized = previous?.normalizedEvents.get(entry.offset);
      if (!normalized || normalized.type !== event.type || normalized.text !== event.text || normalized.echoContext !== echoContext) {
        const rawOutputHasProviderProgress = event.type === 'raw-output' && rawOutputStartsProviderProgress(event.text);
        const providerProgress = rawOutputHasProviderProgress
          ? splitRawOutputAtProviderProgress(event.text, lastUserInput) : undefined;
        normalized = {
          type: event.type, text: event.text, echoContext, rawOutputHasProviderProgress, providerProgress,
          lines: event.type === 'status'
            ? [truncate(normalizeWhitespace(stripAnsiAndControl(event.text)), 240)].filter(Boolean)
            : normalizeRawOutputLines(providerProgress?.progressStarted ? providerProgress.beforeProgressText : event.text,
                lastUserInput, priorUserInputEchoes),
        };
      }
      normalizedEvents.set(entry.offset, normalized);
      const { rawOutputHasProviderProgress, providerProgress, lines } = normalized;

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
        if (performance.now() - yieldedAt >= 8) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          yieldedAt = performance.now();
        }
        const dedupedLine = event.type === 'raw-output'
          ? seenAssistantLines.has(line.trim()) ? '' : line
          : line;
        if (!dedupedLine) {
          continue;
        }
        const role = event.type === 'status' ? 'status' : classifyChunk(dedupedLine);
        const text = role === 'status' ? truncate(dedupedLine, 240) : dedupedLine;
        if (role === 'user') seenAssistantLines.clear();
        else if (role === 'assistant' && event.type === 'raw-output' && text.trim().length >= 6) {
          seenAssistantLines.add(text.trim());
        }
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
    const echoContextLength = [...new Set([...normalizedEvents.values()].map((event) => event.echoContext))]
      .reduce((sum, context) => sum + context.length, 0);
    const bytes = 2 * (readResult.text.length + grouped.reduce((sum, message) => sum + message.text.length, 0)
      + echoContextLength + [...normalizedEvents.values()].reduce((sum, event) => sum + event.text.length
        + event.lines.reduce((n, line) => n + line.length, 0), 0));
    return { plan, read: readResult, messages: grouped, normalizedEvents, bytes };
  }

  private rememberLiveMessages(key: string, snapshot: LiveSnapshot): void {
    const previous = this.liveMessageCache.get(key);
    if (previous) this.cacheBytes -= previous.bytes;
    this.liveMessageCache.delete(key);
    if (snapshot.bytes <= MAX_LIVE_CACHE_BYTES) {
      this.liveMessageCache.set(key, snapshot);
      this.cacheBytes += snapshot.bytes;
    }
    while (this.cacheBytes > MAX_LIVE_CACHE_BYTES || this.liveMessageCache.size > MAX_LIVE_MESSAGE_CACHE_ENTRIES) {
      const oldest = this.liveMessageCache.keys().next().value!;
      this.cacheBytes -= this.liveMessageCache.get(oldest)!.bytes;
      this.liveMessageCache.delete(oldest);
    }
  }
}
