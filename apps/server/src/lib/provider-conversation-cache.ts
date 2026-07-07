import fs from 'node:fs/promises';
import type { ConversationSummary } from '@agent-console/shared';
import { parseClaudeConversationFile } from '../providers/transcripts/claude.js';
import { parseCodexConversationFile } from '../providers/transcripts/codex.js';
import type { ProviderConversation } from '../providers/types.js';

interface CachedProviderConversation {
  conversation: ProviderConversation;
  mtimeMs: number;
  size: number;
}

// Parsed conversations retain every raw transcript record, so in-memory cost is a
// multiple (roughly 3-5x) of the file size. Cap the cache by total transcript bytes
// (LRU), always keeping the most recently used entry so the active conversation
// stays warm even when it alone exceeds the cap.
const MAX_CACHED_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

const transcriptConversationCache = new Map<string, CachedProviderConversation>();

let cachedTranscriptBytes = 0;

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

  try {
    const stat = await fs.stat(summary.transcriptPath);
    const cached = transcriptConversationCache.get(key);
    if (
      cached
      && (
        options.allowStaleWhileChanging === true
        || (cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
      )
    ) {
      refreshCacheRecency(key, cached);
      return cached.conversation;
    }

    const parsed = summary.provider === 'claude'
      ? await parseClaudeConversationFile({
          filePath: summary.transcriptPath,
          provider: summary.provider,
          projectSlug: summary.projectSlug,
          conversationRef: summary.ref,
          collectPathMetadata: false,
        })
      : await parseCodexConversationFile({
          filePath: summary.transcriptPath,
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

    insertCacheEntry(key, {
      conversation,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
    return conversation;
  } catch {
    deleteCacheEntry(key);
    return null;
  }
}
