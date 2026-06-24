import { CONVERSATION_SEARCH_RECENCY_BUCKETS, type ConversationSearchRecencyBucket, type ConversationSearchResult, type ConversationSummary, type NormalizedMessage, type ProviderId } from '@agent-console/shared';
import type { ConversationSearchIndexChunk, AppDatabase } from '../db/database.js';
import { isTreeVisibleBoundSession } from '../lib/bound-session-state.js';
import { getBoundSessionConversationUpdatedAt } from '../lib/conversation-summary.js';
import { isConversationVisibleInDiscovery } from '../lib/conversation-visibility.js';
import { sanitizeSearchableProse } from '../lib/prose-sanitizer.js';
import { normalizeWhitespace } from '../lib/text.js';
import type { ActiveProject, ProjectService } from '../projects/project-service.js';
import { readLiveMessages } from '../sessions/live-output.js';

const MAX_SEARCH_CHUNK_CHARS = 1200;
const SEARCH_RESULT_MULTIPLIER = 4;
const MAX_QUERY_TERMS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_SEARCH_EVENT_LOG_TAIL_BYTES = 512 * 1024;

export function getConversationSearchRecencyBucket(timestamp: string, nowMs = Date.now()): ConversationSearchRecencyBucket {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return '60-plus-days';
  }
  const ageDays = Math.max(0, (nowMs - timestampMs) / DAY_MS);
  if (ageDays < 5) return '0-5-days';
  if (ageDays < 15) return '5-15-days';
  if (ageDays < 30) return '15-30-days';
  if (ageDays < 60) return '30-60-days';
  return '60-plus-days';
}

function recencyBucketPriority(bucket: ConversationSearchRecencyBucket): number {
  const index = CONVERSATION_SEARCH_RECENCY_BUCKETS.indexOf(bucket);
  return index === -1 ? CONVERSATION_SEARCH_RECENCY_BUCKETS.length : index;
}

export function tokenizeSearchQuery(query: string): string[] {
  const seen = new Set<string>();
  const terms = query
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms
    .filter((term) => term.length > 1 || /^\d$/.test(term))
    .filter((term) => {
      if (seen.has(term)) {
        return false;
      }
      seen.add(term);
      return true;
    })
    .slice(0, MAX_QUERY_TERMS);
}

export function buildFtsQuery(query: string): string | undefined {
  const terms = tokenizeSearchQuery(query);
  if (terms.length === 0) {
    return undefined;
  }
  // FTS ANDs terms within a single chunk row; this is a deliberate v1 precision tradeoff.
  const textTerms = terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' AND ');
  return `text : (${textTerms})`;
}

function splitLongText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const splitAt = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
      window.lastIndexOf(' '),
    );
    const nextEnd = splitAt > Math.floor(maxChars * 0.55) ? splitAt + 1 : maxChars;
    chunks.push(remaining.slice(0, nextEnd).trim());
    remaining = remaining.slice(nextEnd).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function chunkSearchableText(text: string): string[] {
  const paragraphs = text
    .split(/\n+/)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_SEARCH_CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitLongText(paragraph, MAX_SEARCH_CHUNK_CHARS));
      continue;
    }
    const next = current ? `${current}\n${paragraph}` : paragraph;
    if (next.length > MAX_SEARCH_CHUNK_CHARS) {
      chunks.push(current);
      current = paragraph;
      continue;
    }
    current = next;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export function buildConversationSearchChunks(input: {
  project: ActiveProject;
  conversation: ConversationSummary;
  messages: NormalizedMessage[];
}): ConversationSearchIndexChunk[] {
  if (!isConversationVisibleInDiscovery(input.conversation)) {
    return [];
  }

  return input.messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }
    const role = message.role;
    const text = sanitizeSearchableProse(message.text);
    if (!text) {
      return [];
    }
    return chunkSearchableText(text).map((chunk, chunkIndex) => ({
      projectSlug: input.project.slug,
      projectDisplayName: input.project.displayName,
      projectPath: input.project.path,
      projectTags: input.project.tags,
      provider: input.conversation.provider,
      conversationRef: input.conversation.ref,
      conversationKind: input.conversation.kind,
      conversationTitle: input.conversation.title,
      conversationUpdatedAt: input.conversation.updatedAt,
      isBound: input.conversation.isBound,
      messageId: `${message.id}:${chunkIndex}`,
      role,
      timestamp: message.timestamp,
      text: chunk,
    }));
  });
}

function normalizedHaystack(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function countMatches(haystack: string, term: string): number {
  let count = 0;
  let index = haystack.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  return count;
}

function termsMatch(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}

function buildPlainSnippet(text: string, terms: string[]): string {
  const normalized = normalizedHaystack(text);
  const firstIndex = terms
    .map((term) => normalized.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstIndex - 90);
  const end = Math.min(text.length, firstIndex + 260);
  const prefix = start > 0 ? '... ' : '';
  const suffix = end < text.length ? ' ...' : '';
  return `${prefix}${normalizeWhitespace(text.slice(start, end))}${suffix}`;
}

function scoreLiveResult(input: {
  title: string;
  projectDisplayName: string;
  text: string;
  terms: string[];
}): number {
  const text = normalizedHaystack(input.text);
  const title = normalizedHaystack(input.title);
  const project = normalizedHaystack(input.projectDisplayName);
  const textScore = input.terms.reduce((score, term) => score + countMatches(text, term), 0);
  const titleScore = input.terms.reduce((score, term) => score + (title.includes(term) ? 3 : 0), 0);
  const projectScore = input.terms.reduce((score, term) => score + (project.includes(term) ? 2 : 0), 0);
  return textScore + titleScore + projectScore;
}

function chooseBetterSearchResult(
  existing: ConversationSearchResult | undefined,
  candidate: ConversationSearchResult,
): ConversationSearchResult {
  if (!existing) {
    return candidate;
  }
  return compareSearchResults(candidate, existing) < 0 ? candidate : existing;
}

function compareSearchResults(a: ConversationSearchResult, b: ConversationSearchResult): number {
  const bucketComparison = recencyBucketPriority(a.recencyBucket) - recencyBucketPriority(b.recencyBucket);
  if (bucketComparison !== 0) {
    return bucketComparison;
  }
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  return b.conversationUpdatedAt.localeCompare(a.conversationUpdatedAt);
}

function resultKey(result: ConversationSearchResult): string {
  return `${result.projectSlug}:${result.provider}:${result.conversationRef}`;
}

function dedupeConversationResults(results: ConversationSearchResult[], limit: number): ConversationSearchResult[] {
  const byConversation = new Map<string, ConversationSearchResult>();
  for (const result of results) {
    if (!isConversationVisibleInDiscovery({ title: result.conversationTitle })) {
      continue;
    }
    const key = resultKey(result);
    byConversation.set(key, chooseBetterSearchResult(byConversation.get(key), result));
  }
  return [...byConversation.values()]
    .sort(compareSearchResults)
    .slice(0, limit);
}

function mergePersistedAndLiveResults(
  persistedResults: ConversationSearchResult[],
  liveResults: ConversationSearchResult[],
  limit: number,
): ConversationSearchResult[] {
  return dedupeConversationResults([...persistedResults, ...liveResults], limit);
}

export class ConversationSearchService {
  constructor(
    private readonly db: AppDatabase,
    private readonly projectService: Pick<ProjectService, 'listActiveProjects'>,
  ) {}

  async search(query: string, limit: number): Promise<ConversationSearchResult[]> {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    const activeProjects = await this.projectService.listActiveProjects();
    const now = new Date();
    const persistedResults = this.db.searchConversationIndex(ftsQuery, limit * SEARCH_RESULT_MULTIPLIER, {
      projectSlugs: activeProjects.map((project) => project.slug),
      now: now.toISOString(),
    });
    const liveResults = await this.searchLiveSessions(query, activeProjects, now.getTime());
    return mergePersistedAndLiveResults(persistedResults, liveResults, limit);
  }

  private async searchLiveSessions(query: string, activeProjects: ActiveProject[], nowMs: number): Promise<ConversationSearchResult[]> {
    const terms = tokenizeSearchQuery(query);
    if (terms.length === 0) {
      return [];
    }
    const projectMap = new Map(activeProjects.map((project) => [project.slug, project]));
    const sessions = this.db.listBoundSessions().filter(isTreeVisibleBoundSession);
    const results: ConversationSearchResult[] = [];

    for (const session of sessions) {
      const project = projectMap.get(session.projectSlug);
      if (!project) {
        continue;
      }
      const summary = session.conversationRef.startsWith('pending:')
        ? this.db.getPendingConversation(session.conversationRef)
        : this.db.getConversationIndexEntry(session.projectSlug, session.provider, session.conversationRef);
      const title = summary?.title ?? session.title ?? 'Live session';
      if (!isConversationVisibleInDiscovery(summary ?? {
        title,
        provider: session.provider as ProviderId,
      })) {
        continue;
      }
      const providerHasTranscript = Boolean(summary) && !session.conversationRef.startsWith('pending:');
      const conversationUpdatedAt = getBoundSessionConversationUpdatedAt(session, summary);
      const messages = await readLiveMessages(session, {
        maxBytesFromEnd: LIVE_SEARCH_EVENT_LOG_TAIL_BYTES,
      });

      for (const message of messages) {
        if (providerHasTranscript && message.role === 'assistant' && message.source === 'live-output') {
          continue;
        }
        if (message.role !== 'user' && message.role !== 'assistant') {
          continue;
        }
        const text = sanitizeSearchableProse(message.text);
        if (!text) {
          continue;
        }
        const haystack = normalizedHaystack(text);
        if (!termsMatch(haystack, terms)) {
          continue;
        }
        results.push({
          projectSlug: project.slug,
          projectDisplayName: project.displayName,
          projectPath: project.path,
          provider: session.provider as ProviderId,
          conversationRef: session.conversationRef,
          conversationKind: session.conversationRef.startsWith('pending:') ? 'pending' : 'history',
          conversationTitle: title,
          conversationUpdatedAt,
          isBound: true,
          role: message.role,
          timestamp: message.timestamp,
          snippet: buildPlainSnippet(text, terms),
          recencyBucket: getConversationSearchRecencyBucket(conversationUpdatedAt, nowMs),
          score: scoreLiveResult({
            title,
            projectDisplayName: project.displayName,
            text,
            terms,
          }),
        });
      }
    }

    return results;
  }
}
