import fs from 'node:fs/promises';
import { LARGE_TRANSCRIPT_STALE_THRESHOLD_BYTES, type ConversationSummary } from '@agent-console/shared';
import { parseClaudeConversationFile } from '../providers/transcripts/claude.js';
import { parseCodexConversationFile } from '../providers/transcripts/codex.js';
import type { ProviderConversation } from '../providers/types.js';

interface CachedProviderConversation {
  conversation: ProviderConversation;
  mtimeMs: number;
  size: number;
  identity: string;
  generation: number;
}

// Parsed messages retain provider metadata and normalized text, so source bytes are
// a conservative proxy for their in-memory cost. Cap the cache by total transcript
// bytes (LRU), always keeping the most recently used entry so the active conversation
// stays warm even when it alone exceeds the cap.
const MAX_CACHED_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

// Serving a stale parse while the transcript is being appended to is only worth
// it when re-parsing is genuinely expensive. Below this size the fresh parse is
// fast enough for poll cadence, and staleness would hide completed messages that
// the provider already wrote mid-turn.
const STALE_WHILE_CHANGING_MIN_BYTES = LARGE_TRANSCRIPT_STALE_THRESHOLD_BYTES;

const transcriptConversationCache = new Map<string, CachedProviderConversation>();
const inFlightParses = new Map<string, { fingerprint: string; promise: Promise<ProviderConversation | null> }>();

let cachedTranscriptBytes = 0;
let nextParseGeneration = 0;

function refreshCacheRecency(key: string, entry: CachedProviderConversation): void {
  transcriptConversationCache.delete(key);
  transcriptConversationCache.set(key, entry);
}

function insertCacheEntry(key: string, entry: CachedProviderConversation): void {
  const previous = transcriptConversationCache.get(key);
  if (previous) {
    cachedTranscriptBytes -= previous.size;
    transcriptConversationCache.delete(key);
  }
  transcriptConversationCache.set(key, entry);
  cachedTranscriptBytes += entry.size;
  for (const oldestKey of transcriptConversationCache.keys()) {
    if (cachedTranscriptBytes <= MAX_CACHED_TRANSCRIPT_BYTES || oldestKey === key) {
      break;
    }
    cachedTranscriptBytes -= transcriptConversationCache.get(oldestKey)!.size;
    transcriptConversationCache.delete(oldestKey);
  }
}

function deleteCacheEntry(key: string): void {
  const existing = transcriptConversationCache.get(key);
  if (existing) {
    cachedTranscriptBytes -= existing.size;
    transcriptConversationCache.delete(key);
  }
}

interface LoadProviderConversationOptions {
  allowStaleWhileChanging?: boolean;
}

function cacheKey(summary: ConversationSummary): string | undefined {
  if (!summary.transcriptPath) {
    return undefined;
  }

  return `${summary.provider}:${summary.projectSlug}:${summary.ref}:${summary.transcriptPath}`;
}

export async function loadProviderConversationFromSummary(
  summary: ConversationSummary,
  options: LoadProviderConversationOptions = {},
): Promise<ProviderConversation | null> {
  const key = cacheKey(summary);
  if (!key || !summary.transcriptPath) {
    return null;
  }

  const transcriptPath = summary.transcriptPath;
  try {
    const stat = await fs.stat(transcriptPath);
    const identity = `${stat.dev}:${stat.ino}`;
    const cached = transcriptConversationCache.get(key);
    const allowStale = options.allowStaleWhileChanging === true
      && stat.size >= STALE_WHILE_CHANGING_MIN_BYTES;
    if (
      cached
      && cached.identity === identity
      && (
        allowStale
        || (cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
      )
    ) {
      refreshCacheRecency(key, cached);
      return cached.conversation;
    }

    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const pending = inFlightParses.get(key);
    if (pending?.fingerprint === fingerprint) return await pending.promise;

    const generation = ++nextParseGeneration;
    const promise: Promise<ProviderConversation | null> = Promise.resolve().then(async () => {
      try {
        const parsed = summary.provider === 'claude'
          ? await parseClaudeConversationFile({
              filePath: transcriptPath,
              provider: summary.provider,
              projectSlug: summary.projectSlug,
              conversationRef: summary.ref,
              collectPathMetadata: false,
            })
          : await parseCodexConversationFile({
              filePath: transcriptPath,
              provider: summary.provider,
              projectSlug: summary.projectSlug,
              conversationRef: summary.ref,
              collectPathMetadata: false,
            });

        const conversation: ProviderConversation = {
          summary: parsed.summary,
          messages: parsed.displayMessages,
          allMessages: parsed.messages,
        };

        // Warm stale reads even while a newer parse runs, without replacing a
        // newer completed result when parses finish out of order.
        if ((transcriptConversationCache.get(key)?.generation ?? -1) < generation) insertCacheEntry(key, {
          conversation, mtimeMs: stat.mtimeMs, size: stat.size, identity, generation,
        });
        return conversation;
      } catch {
        if (inFlightParses.get(key)?.promise === promise) deleteCacheEntry(key);
        return null;
      } finally {
        if (inFlightParses.get(key)?.promise === promise) inFlightParses.delete(key);
      }
    });
    inFlightParses.set(key, { fingerprint, promise });
    return await promise;
  } catch {
    deleteCacheEntry(key);
    return null;
  }
}
