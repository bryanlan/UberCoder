// Reads Antigravity's on-disk conversation metadata and JSONL transcripts without starting `agy`.
//
// Layout under `<discoveryRoot>` (default `~/.gemini/antigravity-cli`):
//   cache/conversation_metadata.json                       — titles, WorkspaceURIs, UpdatedAt, is_internal
//   brain/<sessionId>/.system_generated/logs/transcript.jsonl — step records (USER_INPUT, PLANNER_RESPONSE, etc.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AntigravityStoredMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface AntigravityConversationMeta {
  id: string;
  title?: string;
  workspacePaths: string[];
  updatedAt?: string;
  isInternal: boolean;
}

export interface AntigravityHistory {
  title?: string;
  model?: string;
  workspacePaths: string[];
  createdAt?: string;
  updatedAt?: string;
  messages: AntigravityStoredMessage[];
}

export type AntigravityReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export class AntigravityStoreFormatError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AntigravityStoreFormatError';
  }
}

export function antigravityMetadataPath(discoveryRoot: string): string {
  return path.join(discoveryRoot, 'cache', 'conversation_metadata.json');
}

export function antigravityBrainRoot(discoveryRoot: string): string {
  return path.join(discoveryRoot, 'brain');
}

export function antigravityTranscriptPath(discoveryRoot: string, sessionId: string): string {
  return path.join(discoveryRoot, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

/** Infer `<discoveryRoot>` from `<discoveryRoot>/brain/<sessionId>/.system_generated/logs/transcript.jsonl`. */
export function discoveryRootFromTranscriptPath(transcriptPath: string): string | undefined {
  const logsDir = path.dirname(transcriptPath);
  const sysDir = path.dirname(logsDir);
  const sessionDir = path.dirname(sysDir);
  const brainDir = path.dirname(sessionDir);
  if (path.basename(logsDir) === 'logs' && path.basename(sysDir) === '.system_generated' && path.basename(brainDir) === 'brain') {
    return path.dirname(brainDir);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function workspaceUriToPath(uri: string): string | undefined {
  const trimmed = uri.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('file://')) {
    try {
      return path.resolve(fileURLToPath(trimmed));
    } catch {
      return path.resolve(decodeURIComponent(trimmed.slice('file://'.length)));
    }
  }
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return undefined;
}

/** Read `cache/conversation_metadata.json`. Missing or malformed metadata degrades gracefully to an empty map. */
export function readAntigravityMetadataMap(discoveryRoot: string): Map<string, AntigravityConversationMeta> {
  const result = new Map<string, AntigravityConversationMeta>();
  const metaFile = antigravityMetadataPath(discoveryRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(metaFile, 'utf8');
  } catch {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!isRecord(parsed) || !isRecord(parsed.conversations)) return result;
  for (const [key, entry] of Object.entries(parsed.conversations)) {
    if (!isRecord(entry)) continue;
    const summary = isRecord(entry.summary) ? entry.summary : {};
    const id = typeof summary.ID === 'string' && summary.ID.trim() ? summary.ID.trim() : key;
    const title = typeof summary.Title === 'string' && summary.Title.trim() ? summary.Title.trim() : undefined;
    const updatedAt = typeof summary.UpdatedAt === 'string' && summary.UpdatedAt.trim()
      ? summary.UpdatedAt.trim()
      : typeof entry.last_modified_time === 'string' && entry.last_modified_time.trim()
        ? entry.last_modified_time.trim()
        : undefined;
    const workspacePaths: string[] = [];
    if (Array.isArray(summary.WorkspaceURIs)) {
      for (const uri of summary.WorkspaceURIs) {
        if (typeof uri !== 'string') continue;
        const resolved = workspaceUriToPath(uri);
        if (resolved && !workspacePaths.includes(resolved)) workspacePaths.push(resolved);
      }
    }
    const isInternal = entry.is_internal === true || summary.Internal === true;
    result.set(id, { id, ...(title ? { title } : {}), workspacePaths, ...(updatedAt ? { updatedAt } : {}), isInternal });
  }
  return result;
}

/**
 * Extracts the person's text from an Antigravity `USER_INPUT` step, which wraps the prompt in
 * `<USER_REQUEST>...</USER_REQUEST>` followed by `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>`.
 */
export function extractAntigravityUserText(raw: string): string {
  const match = raw.match(/<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/);
  if (match) return match[1]!.trim();
  const stripped = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim();
  return stripped;
}

/**
 * Turns Antigravity's combined model slug (`gemini-4-neon-high`) into space-separated `<model> <effort>`
 * (`gemini-4-neon high`), matching the form used by `visibleModelMatchesTarget` and Console status lines.
 */
export function normalizeAntigravityModel(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  const match = trimmed.match(/^(gemini-[\w.-]+)-(low|medium|high|xhigh)$/i);
  if (match) return `${match[1]} ${match[2]!.toLowerCase()}`;
  return trimmed;
}

function stepTimestamp(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() && Number.isFinite(Date.parse(raw)) ? raw : fallback;
}

function parseJsonlSteps(filePath: string): AntigravityReadResult<Record<string, unknown>[]> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, reason: `could not read Antigravity transcript: ${error instanceof Error ? error.message : String(error)}` };
  }
  const steps: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) steps.push(parsed);
    } catch {
      // Ignore a trailing half-written JSONL line while a turn is actively appending.
    }
  }
  return { ok: true, value: steps };
}

export function readAntigravityHistory(
  transcriptPath: string,
  meta?: AntigravityConversationMeta,
): AntigravityReadResult<AntigravityHistory> {
  const parsed = parseJsonlSteps(transcriptPath);
  if (!parsed.ok) return parsed;
  let fallbackTime = meta?.updatedAt ?? new Date(0).toISOString();
  try {
    fallbackTime = fs.statSync(transcriptPath).mtime.toISOString();
  } catch { /* keep metadata fallback */ }

  const messages: AntigravityStoredMessage[] = [];
  let model: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined = meta?.updatedAt;

  for (const step of parsed.value) {
    const ts = stepTimestamp(step.created_at, fallbackTime);
    if (!createdAt) createdAt = ts;
    if (!updatedAt || Date.parse(ts) > Date.parse(updatedAt)) updatedAt = ts;

    if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT' && typeof step.content === 'string') {
      const text = extractAntigravityUserText(step.content);
      if (text) messages.push({ role: 'user', text, timestamp: ts });
      continue;
    }

    if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
      if (typeof step.model === 'string' && step.model.trim()) {
        model = normalizeAntigravityModel(step.model);
      }
      if (typeof step.content === 'string' && step.content.trim()) {
        messages.push({ role: 'assistant', text: step.content.trim(), timestamp: ts });
      }
    }
  }

  return {
    ok: true,
    value: {
      ...(meta?.title ? { title: meta.title } : {}),
      ...(model ? { model } : {}),
      workspacePaths: meta?.workspacePaths ?? [],
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      messages,
    },
  };
}

/** Reads the highest `step_index` currently in `transcript.jsonl`, before a new turn is sent. */
export function readAntigravityTurnBaseline(transcriptPath: string): { lastStepIndex?: number } {
  const parsed = parseJsonlSteps(transcriptPath);
  if (!parsed.ok || parsed.value.length === 0) return {};
  let maxIndex = -1;
  for (const step of parsed.value) {
    if (typeof step.step_index === 'number' && Number.isInteger(step.step_index) && step.step_index > maxIndex) {
      maxIndex = step.step_index;
    }
  }
  return maxIndex >= 0 ? { lastStepIndex: maxIndex } : {};
}

/**
 * Checks whether a turn that was running before a backend restart has finished on disk: a step after `lastStepIndex`
 * where the latest step is a completed `PLANNER_RESPONSE` with no tool calls means the model finished its reply.
 */
export function antigravityTurnSettled(
  transcriptPath: string,
  baseline: { lastStepIndex?: number },
): 'finished' | 'running' | 'unknown' {
  const parsed = parseJsonlSteps(transcriptPath);
  if (!parsed.ok) return 'unknown';
  const threshold = baseline.lastStepIndex ?? -1;
  const newer = parsed.value.filter(step => typeof step.step_index === 'number' && step.step_index > threshold);
  if (newer.length === 0) return 'running';
  const latest = newer[newer.length - 1]!;
  const hasToolCalls = Array.isArray(latest.tool_calls) && latest.tool_calls.length > 0;
  if (latest.source === 'MODEL' && latest.type === 'PLANNER_RESPONSE' && latest.status === 'DONE' && !hasToolCalls) {
    return 'finished';
  }
  return 'running';
}
