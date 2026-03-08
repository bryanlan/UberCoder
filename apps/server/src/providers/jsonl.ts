import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationSummary, MessageRole, NormalizedMessage, ProviderId } from '@agent-console/shared';
import { nowIso } from '../lib/time.js';
import { samePath } from '../lib/path-utils.js';
import { coerceText, normalizeComparableText, stableTextHash, truncate } from '../lib/text.js';
import { readTextWindowed } from './file-utils.js';

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

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\\/.test(value);
}

const EMBEDDED_PATH_PATTERNS = [
  /(?:current working directory|working directory|cwd|project path|workspace path|repo path|directory):\s*([~\/][^\s<>"')\]]+)/gi,
  /<(?:cwd|project_path|projectPath|workspace_path|workspacePath)>\s*([^<]+?)\s*<\/(?:cwd|project_path|projectPath|workspace_path|workspacePath)>/gi,
];

function extractCandidateStrings(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractCandidateStrings(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) => extractCandidateStrings(item, depth + 1));
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

function collectPaths(value: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6 || value == null) return into;
  if (typeof value === 'string') {
    collectEmbeddedPaths(value, into);
    return into;
  }
  if (typeof value !== 'object') return into;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
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
      collectPaths(nested, into, depth + 1);
    }
  }
  return into;
}

function collectDirectPaths(value: unknown, into = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return into;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
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

function collectAuthoritativeProjectPaths(record: Record<string, unknown>, into = new Set<string>()): Set<string> {
  collectDirectPaths(record, into);

  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : undefined;
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

function inferRole(record: Record<string, unknown>): MessageRole | undefined {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : undefined;
  const directRole =
    record.role
    ?? payload?.role
    ?? (record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>).role : undefined)
    ?? (payload?.message && typeof payload.message === 'object' ? (payload.message as Record<string, unknown>).role : undefined);
  if (typeof directRole === 'string' && ROLE_ALIASES[directRole.toLowerCase()]) {
    return ROLE_ALIASES[directRole.toLowerCase()];
  }

  if (typeof record.type === 'string' && record.type === 'event_msg' && payload?.type === 'user_message') {
    return 'user';
  }
  if (typeof record.type === 'string' && record.type === 'event_msg' && payload?.type === 'agent_message') {
    return 'assistant';
  }

  const typeValues = [record.type, record.event, record.kind, record.category].flatMap((value) => extractCandidateStrings(value).slice(0, 4));
  for (const candidate of typeValues) {
    const lower = candidate.toLowerCase();
    if (lower.includes('user')) return 'user';
    if (lower.includes('assistant') || lower.includes('response') || lower.includes('model')) return 'assistant';
    if (lower.includes('tool')) return 'tool';
    if (lower.includes('system')) return 'system';
    if (lower.includes('status') || lower.includes('event')) return 'status';
  }

  return undefined;
}

function extractText(record: Record<string, unknown>): string {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : undefined;
  const priority = [
    payload?.text,
    payload?.message,
    payload?.delta,
    payload?.content,
    payload?.output,
    payload?.input,
    payload?.summary,
    payload?.description,
    payload?.result,
    payload?.value,
    payload?.message_text,
    record.text,
    record.message,
    record.delta,
    record.content,
    record.output,
    record.input,
    record.summary,
    record.description,
    record.result,
    record.value,
    record.message_text,
  ];

  for (const candidate of priority) {
    const pieces = extractCandidateStrings(candidate)
      .map((piece) => piece.trim())
      .filter(Boolean)
      .filter((piece) => !piece.startsWith('{') && !piece.startsWith('['));
    if (pieces.length > 0) {
      return pieces
        .filter((piece) => !/^(input_text|output_text|tool_use|tool_result|thinking)$/i.test(piece))
        .join('\n')
        .trim();
    }
  }

  return '';
}

function extractTimestamp(record: Record<string, unknown>, fallback: string): string {
  const candidates = [record.timestamp, record.created_at, record.createdAt, record.ts, record.time].map(coerceText).filter(Boolean);
  const iso = candidates.find((value) => !Number.isNaN(Date.parse(value)));
  return iso ?? fallback;
}

export interface ParsedJsonlConversation {
  summary: ConversationSummary;
  messages: NormalizedMessage[];
  projectPaths: Set<string>;
  authoritativeProjectPaths: Set<string>;
}

export function extractAuthoritativeProjectPathsFromText(text: string): Set<string> {
  const authoritativeProjectPaths = new Set<string>();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      collectAuthoritativeProjectPaths(JSON.parse(line) as Record<string, unknown>, authoritativeProjectPaths);
    } catch {
      // Ignore malformed lines while scanning for session metadata.
    }
  }
  return authoritativeProjectPaths;
}

export async function parseJsonlConversationFile(input: {
  filePath: string;
  provider: ProviderId;
  projectSlug: string;
  conversationRef: string;
}): Promise<ParsedJsonlConversation> {
  const text = await readTextWindowed(input.filePath);
  const stat = await fs.stat(input.filePath);
  const fallbackTime = stat.mtime.toISOString();
  const messages: NormalizedMessage[] = [];
  const projectPaths = new Set<string>();
  const authoritativeProjectPaths = new Set<string>();
  const lines = text.split(/\r?\n/).filter(Boolean);

  for (const [index, line] of lines.entries()) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      collectPaths(record, projectPaths);
      collectAuthoritativeProjectPaths(record, authoritativeProjectPaths);
      const role = inferRole(record);
      const text = extractText(record);
      if (!role || !text) continue;
      const timestamp = extractTimestamp(record, fallbackTime);
      messages.push({
        id: stableTextHash(`${input.provider}:${input.conversationRef}:${input.filePath}:${index}:${role}:${text}`),
        provider: input.provider,
        role,
        text,
        timestamp,
        conversationRef: input.conversationRef,
        source: 'history-file',
        rawMetadata: record,
      });
    } catch {
      // Ignore malformed jsonl lines and continue in degraded mode.
    }
  }

  const sortedMessages = messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const userMessages = sortedMessages.filter((message) => message.role === 'user');
  const firstUser = userMessages[0];
  const lastUser = userMessages.at(-1);
  const lastMeaningful = [...sortedMessages].reverse().find((message) => message.role === 'assistant' || message.role === 'user' || message.role === 'status');
  const title = truncate(firstUser?.text ?? path.basename(input.filePath, path.extname(input.filePath)), 72);
  const updatedAt = lastMeaningful?.timestamp ?? fallbackTime;
  const createdAt = sortedMessages[0]?.timestamp ?? fallbackTime;

  return {
    summary: {
      ref: input.conversationRef,
      kind: 'history',
      projectSlug: input.projectSlug,
      provider: input.provider,
      title,
      excerpt: lastMeaningful ? truncate(lastMeaningful.text, 120) : undefined,
      createdAt,
      updatedAt,
      transcriptPath: input.filePath,
      providerConversationId: input.conversationRef,
      isBound: false,
      degraded: sortedMessages.length === 0,
      rawMetadata: {
        projectPaths: [...projectPaths],
        authoritativeProjectPaths: [...authoritativeProjectPaths],
        firstUserTextHash: firstUser ? stableTextHash(normalizeComparableText(firstUser.text)) : undefined,
        lastUserTextHash: lastUser ? stableTextHash(normalizeComparableText(lastUser.text)) : undefined,
      },
    },
    messages: sortedMessages,
    projectPaths,
    authoritativeProjectPaths,
  };
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

export async function groupAndMergeMessages(messages: NormalizedMessage[]): Promise<NormalizedMessage[]> {
  return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
