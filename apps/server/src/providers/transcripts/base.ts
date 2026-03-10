import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationSummary, MessageRole, NormalizedMessage, ProviderId } from '@agent-console/shared';
import { samePath } from '../../lib/path-utils.js';
import { coerceText, normalizeComparableText, stableTextHash, truncate } from '../../lib/text.js';
import { readTextWindowed } from '../file-utils.js';
import type { ParsedTranscript, TranscriptParseInput } from './types.js';

type JsonRecord = Record<string, unknown>;

const PATH_KEYS = new Set([
  'cwd',
  'current_working_directory',
  'currentWorkingDirectory',
  'project_path',
  'projectPath',
  'workspace',
  'workspace_path',
  'worktree',
  'root',
  'repoPath',
  'transcript_path',
]);

const AUTHORITATIVE_PATH_KEYS = new Set([
  'cwd',
  'current_working_directory',
  'currentWorkingDirectory',
  'project_path',
  'projectPath',
  'workspace',
  'workspace_path',
  'worktree',
  'root',
  'repoPath',
]);

const ROLE_ALIASES: Record<string, MessageRole> = {
  user: 'user',
  human: 'user',
  assistant: 'assistant',
  model: 'assistant',
  ai: 'assistant',
  system: 'system',
  tool: 'tool',
  status: 'status',
};

const EMBEDDED_PATH_PATTERNS = [
  /(?:current working directory|working directory|cwd|project path|workspace path|repo path|directory):\s*([~\/][^\s<>"')\]]+)/gi,
  /<(?:cwd|project_path|projectPath|workspace_path|workspacePath)>\s*([^<]+?)\s*<\/(?:cwd|project_path|projectPath|workspace_path|workspacePath)>/gi,
];

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\\/.test(value);
}

function extractCandidateStrings(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractCandidateStrings(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as JsonRecord).flatMap((item) => extractCandidateStrings(item, depth + 1));
  }
  return [];
}

function normalizeExtractedPath(value: string): string | undefined {
  const trimmed = value.trim().replace(/^['"`]+|['"`]+$/g, '').replace(/[.,;:)\]]+$/g, '');
  const home = process.env.HOME;
  const expanded = trimmed.startsWith('~/') && home
    ? path.join(home, trimmed.slice(2))
    : trimmed;
  return looksLikeAbsolutePath(expanded) ? path.resolve(expanded) : undefined;
}

function collectEmbeddedPaths(text: string, into: Set<string>): void {
  for (const pattern of EMBEDDED_PATH_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const candidate = normalizeExtractedPath(match[1] ?? '');
      if (candidate) {
        into.add(candidate);
      }
    }
  }
}

export function collectProjectPaths(value: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6 || value == null) return into;
  if (typeof value === 'string') {
    collectEmbeddedPaths(value, into);
    return into;
  }
  if (typeof value !== 'object') return into;
  for (const [key, nested] of Object.entries(value as JsonRecord)) {
    if (PATH_KEYS.has(key) && typeof nested === 'string') {
      const candidate = normalizeExtractedPath(nested);
      if (candidate) {
        into.add(candidate);
      }
    }
    if (typeof nested === 'string') {
      collectEmbeddedPaths(nested, into);
    }
    if (typeof nested === 'object') {
      collectProjectPaths(nested, into, depth + 1);
    }
  }
  return into;
}

function collectDirectPaths(value: unknown, into = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return into;
  for (const [key, nested] of Object.entries(value as JsonRecord)) {
    if (!AUTHORITATIVE_PATH_KEYS.has(key) || typeof nested !== 'string' || !looksLikeAbsolutePath(nested)) continue;
    into.add(path.resolve(nested));
  }
  return into;
}

function collectCwdFromContentText(value: unknown, into = new Set<string>()): Set<string> {
  const strings = extractCandidateStrings(value);
  for (const stringValue of strings) {
    collectEmbeddedPaths(stringValue, into);
    for (const match of stringValue.matchAll(/<cwd>\s*([^<]+?)\s*<\/cwd>/g)) {
      const candidate = match[1]?.trim();
      const normalized = candidate ? normalizeExtractedPath(candidate) : undefined;
      if (normalized) {
        into.add(normalized);
      }
    }
  }
  return into;
}

export function collectAuthoritativeProjectPaths(record: JsonRecord, into = new Set<string>()): Set<string> {
  collectDirectPaths(record, into);

  const payload = asObject(record.payload);
  const eventType = typeof record.type === 'string' ? record.type : undefined;
  if (payload && (eventType === 'session_meta' || eventType === 'turn_context')) {
    collectDirectPaths(payload, into);
  }

  if (payload && eventType === 'response_item' && payload.type === 'message') {
    collectCwdFromContentText(payload.content, into);
  }

  if (payload && eventType === 'event_msg' && payload.type === 'user_message') {
    collectCwdFromContentText(payload.message, into);
  }

  return into;
}

export function extractAuthoritativeProjectPathsFromJsonlText(text: string): Set<string> {
  const authoritativeProjectPaths = new Set<string>();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      collectAuthoritativeProjectPaths(JSON.parse(line) as JsonRecord, authoritativeProjectPaths);
    } catch {
      // Ignore malformed lines while scanning for session metadata.
    }
  }
  return authoritativeProjectPaths;
}

export function conversationBelongsToProject(projectPath: string, parsedPaths: Set<string>): boolean {
  for (const candidate of parsedPaths) {
    if (samePath(candidate, projectPath)) return true;
  }
  return false;
}

export function deriveConversationRef(filePath: string): string {
  const directUuid = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (directUuid) return directUuid;
  const rollout = filePath.match(/rollout-([^.\/]+)\.jsonl$/i)?.[1];
  if (rollout) return rollout;
  return path.basename(filePath, path.extname(filePath));
}

export function coerceMessageRole(value: unknown): MessageRole | undefined {
  if (typeof value !== 'string') return undefined;
  return ROLE_ALIASES[value.toLowerCase()];
}

export function asObject(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

export function extractTextBlocks(value: unknown, allowedTypes: string[]): string {
  const allowed = new Set(allowedTypes);

  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const pieces = value.flatMap((item) => {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        return trimmed ? [trimmed] : [];
      }
      const object = asObject(item);
      if (!object) return [];
      const type = typeof object.type === 'string' ? object.type : undefined;
      if (type && !allowed.has(type)) return [];
      const text = typeof object.text === 'string'
        ? object.text
        : typeof object.content === 'string'
          ? object.content
          : '';
      const trimmed = text.trim();
      return trimmed ? [trimmed] : [];
    });
    return pieces.join('\n').trim();
  }

  const object = asObject(value);
  if (!object) {
    return '';
  }

  const directType = typeof object.type === 'string' ? object.type : undefined;
  if (typeof object.text === 'string' && (!directType || allowed.has(directType))) {
    return object.text.trim();
  }
  if (typeof object.content === 'string' && (!directType || allowed.has(directType))) {
    return object.content.trim();
  }
  if (object.content !== undefined) {
    return extractTextBlocks(object.content, allowedTypes);
  }
  return '';
}

export function extractTextFromFields(record: JsonRecord, fieldNames: string[], allowedTypes: string[]): string {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (value === undefined) continue;
    const text = extractTextBlocks(value, allowedTypes);
    if (text) {
      return text;
    }
  }
  return '';
}

export function extractTimestamp(record: JsonRecord, fallback: string): string {
  const candidates = [record.timestamp, record.created_at, record.createdAt, record.ts, record.time]
    .map(coerceText)
    .filter(Boolean);
  const iso = candidates.find((value) => !Number.isNaN(Date.parse(value)));
  return iso ?? fallback;
}

export function filterUserVisibleMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  return messages.filter((message) => message.role === 'user' || message.role === 'assistant');
}

export async function loadJsonlRecords(filePath: string): Promise<{
  records: Array<{ index: number; record: JsonRecord }>;
  fallbackTime: string;
}> {
  const text = await readTextWindowed(filePath);
  const stat = await fs.stat(filePath);
  const records = text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line, index) => {
      try {
        return [{ index, record: JSON.parse(line) as JsonRecord }];
      } catch {
        return [];
      }
    });
  return {
    records,
    fallbackTime: stat.mtime.toISOString(),
  };
}

export function buildParsedTranscript(input: TranscriptParseInput & {
  fallbackTime: string;
  messages: NormalizedMessage[];
  displayMessages?: NormalizedMessage[];
  projectPaths: Set<string>;
  authoritativeProjectPaths: Set<string>;
}): ParsedTranscript {
  const sortedMessages = [...input.messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const displayMessages = [...(input.displayMessages ?? filterUserVisibleMessages(sortedMessages))]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const firstVisibleUser = displayMessages.find((message) => message.role === 'user');
  const lastVisible = [...displayMessages].reverse().find((message) => message.role === 'assistant' || message.role === 'user');
  const allUserMessages = sortedMessages.filter((message) => message.role === 'user');
  const firstUser = allUserMessages[0];
  const lastUser = allUserMessages.at(-1);
  const lastMeaningful = [...sortedMessages].reverse().find((message) => (
    message.role === 'assistant'
      || message.role === 'user'
      || message.role === 'status'
  ));
  const title = truncate(firstVisibleUser?.text ?? firstUser?.text ?? path.basename(input.filePath, path.extname(input.filePath)), 72);
  const updatedAt = lastVisible?.timestamp ?? lastMeaningful?.timestamp ?? input.fallbackTime;
  const createdAt = sortedMessages[0]?.timestamp ?? input.fallbackTime;

  const summary: ConversationSummary = {
    ref: input.conversationRef,
    kind: 'history',
    projectSlug: input.projectSlug,
    provider: input.provider,
    title,
    excerpt: lastVisible ? truncate(lastVisible.text, 120) : undefined,
    createdAt,
    updatedAt,
    transcriptPath: input.filePath,
    providerConversationId: input.conversationRef,
    isBound: false,
    degraded: displayMessages.length === 0,
    rawMetadata: {
      projectPaths: [...input.projectPaths],
      authoritativeProjectPaths: [...input.authoritativeProjectPaths],
      firstUserTextHash: firstUser ? stableTextHash(normalizeComparableText(firstUser.text)) : undefined,
      lastUserTextHash: lastUser ? stableTextHash(normalizeComparableText(lastUser.text)) : undefined,
    },
  };

  return {
    summary,
    messages: sortedMessages,
    displayMessages,
    projectPaths: input.projectPaths,
    authoritativeProjectPaths: input.authoritativeProjectPaths,
  };
}
