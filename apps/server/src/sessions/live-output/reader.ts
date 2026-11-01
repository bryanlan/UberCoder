import type { BoundSession, NormalizedMessage } from '@agent-console/shared';
import { normalizeWhitespace, stripAnsiAndControl, truncate } from '../../lib/text.js';
import {
  getEventLogReadPlan,
  parseSessionEventEntries,
  readAppendedEventLogText,
  type EventLogReadPlan,
  type EventLogReadResult,
  type ReadLiveMessagesOptions,
} from './event-log-reader.js';
const MAX_LIVE_MESSAGE_CACHE_ENTRIES = 64;

function cloneMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  return messages.map((message) => ({ ...message }));
}

function liveMessageId(sessionId: string, offset: number): string {
  return `live:${sessionId}:${offset}`;
}

interface LiveSnapshot {
  plan: EventLogReadPlan;
  read: EventLogReadResult;
  messages: NormalizedMessage[];
  bytes: number;
}
const MAX_LIVE_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * The live rows of a bound session, read from its event log: the person's messages (durable `user` rows until the provider
 * transcript carries them) and the Console's status lines. Conversation content comes only from the provider transcript, so an
 * automatic opening prompt (`agent-input`) and terminal output an earlier build logged (`raw-output`) are not shown here.
 */
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

    const messages: NormalizedMessage[] = [];
    for (const { event, offset } of events) {
      if (event.type === 'user-input') {
        const text = event.text.trim();
        if (!text) continue;
        messages.push({
          id: liveMessageId(session.id, offset),
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
      if (event.type !== 'status') continue;
      const text = truncate(normalizeWhitespace(stripAnsiAndControl(event.text)), 240);
      if (!text) continue;
      messages.push({
        id: liveMessageId(session.id, offset),
        provider: session.provider,
        role: 'status',
        lifecycle: 'status',
        text,
        timestamp: event.timestamp,
        conversationRef: session.conversationRef,
        source: 'synthetic-status',
      });
    }
    const bytes = 2 * (readResult.text.length + messages.reduce((sum, message) => sum + message.text.length, 0));
    return { plan, read: readResult, messages, bytes };
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
