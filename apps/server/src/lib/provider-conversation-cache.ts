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

const transcriptConversationCache = new Map<string, CachedProviderConversation>();

function cacheKey(summary: ConversationSummary): string | undefined {
  if (!summary.transcriptPath) {
    return undefined;
  }

  return `${summary.provider}:${summary.projectSlug}:${summary.ref}:${summary.transcriptPath}`;
}

export async function loadProviderConversationFromSummary(
  summary: ConversationSummary,
): Promise<ProviderConversation | null> {
  const key = cacheKey(summary);
  if (!key || !summary.transcriptPath) {
    return null;
  }

  try {
    const stat = await fs.stat(summary.transcriptPath);
    const cached = transcriptConversationCache.get(key);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.conversation;
    }

    const parsed = summary.provider === 'claude'
      ? await parseClaudeConversationFile({
          filePath: summary.transcriptPath,
          provider: summary.provider,
          projectSlug: summary.projectSlug,
          conversationRef: summary.ref,
        })
      : await parseCodexConversationFile({
          filePath: summary.transcriptPath,
          provider: summary.provider,
          projectSlug: summary.projectSlug,
          conversationRef: summary.ref,
        });

    const conversation: ProviderConversation = {
      summary: parsed.summary,
      messages: parsed.displayMessages,
      allMessages: parsed.messages,
    };

    transcriptConversationCache.set(key, {
      conversation,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
    return conversation;
  } catch {
    transcriptConversationCache.delete(key);
    return null;
  }
}
