import { codexRunState } from './codex-run-state.js';
import fs from 'node:fs';
import readline from 'node:readline';
import type { NormalizedMessage } from '@agent-console/shared';
import { normalizeComparableText, stableTextHash } from '../../lib/text.js';
import {
  asObject,
  buildParsedTranscript,
  collectAuthoritativeProjectPaths,
  collectProjectPaths,
  coerceMessageRole,
  extractTextBlocks,
  extractTextFromFields,
  extractTimestamp,
  iterateJsonlRecords,
} from './base.js';
import type { ParsedTranscript, TranscriptParseInput } from './types.js';

const CODEX_EVENT_RESPONSE_DUPLICATE_WINDOW_MS = 1_000;

function isCodexDisplayChromeLine(line: string): boolean {
  const trimmed = line.trim();
  return /^[✻✽✦]\s*(?:Cogitated|Thinking|Thought|Worked)\b.*\bfor\s+\d+/i.test(trimmed)
    || /^Live input bridge$/i.test(trimmed)
    || /^LIVE INPUT BRIDGE$/i.test(trimmed)
    || /^Expand to type directly into the live session\.$/i.test(trimmed);
}

function sanitizeCodexDisplayText(text: string, role: NormalizedMessage['role']): string {
  const displayText = role === 'assistant'
    ? text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, '')
    : text;
  return displayText
    .replace(/^<codex_internal_context\b[\s\S]*?<\/codex_internal_context>\s*/gim, '')
    .replace(/^<turn_aborted>[\s\S]*?<\/turn_aborted>\s*/gim, '')
    .split('\n')
    .filter((line) => !isCodexDisplayChromeLine(line))
    .join('\n')
    .trim();
}

function shouldHideCodexDisplayMessage(message: NormalizedMessage): boolean {
  if (message.role === 'status' && codexRunState(message.rawMetadata ?? {})?.status === 'failed') return false;
  if (message.role !== 'user' && message.role !== 'assistant') {
    return true;
  }

  if (message.role === 'assistant') {
    const trimmed = message.text.trim();
    return isCodexDisplayChromeLine(trimmed);
  }

  const trimmed = message.text.trim();
  return /^<user_instructions>[\s\S]*<\/user_instructions>$/i.test(trimmed)
    || /^<environment_context>[\s\S]*<\/environment_context>$/i.test(trimmed)
    || /^<codex_internal_context\b[\s\S]*<\/codex_internal_context>$/i.test(trimmed)
    || /^<turn_aborted>[\s\S]*<\/turn_aborted>$/i.test(trimmed)
    || /^<permissions instructions>[\s\S]*<\/permissions instructions>$/i.test(trimmed)
    || /^<collaboration_mode>[\s\S]*<\/collaboration_mode>$/i.test(trimmed)
    || /^<apps_instructions>[\s\S]*<\/apps_instructions>$/i.test(trimmed)
    || /^<skills_instructions>[\s\S]*<\/skills_instructions>$/i.test(trimmed)
    || /^<plugins_instructions>[\s\S]*<\/plugins_instructions>$/i.test(trimmed)
    || trimmed === 'Live session did not accept the typed text into its input buffer. The draft was not submitted'
    || /^#\s*AGENTS\.md instructions for\b[\s\S]*$/i.test(trimmed)
    || /^<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/i.test(trimmed);
}

function codexMessagePhase(message: NormalizedMessage): string | undefined {
  const record = asObject(message.rawMetadata);
  const payload = asObject(record?.payload);
  return typeof payload?.phase === 'string' ? payload.phase : undefined;
}

function isCodexAssistantCommentaryMessage(message: NormalizedMessage): boolean {
  return message.role === 'assistant' && codexMessagePhase(message) === 'commentary';
}

function codexMessageLifecycle(record: Record<string, unknown>, role: NormalizedMessage['role']): NormalizedMessage['lifecycle'] {
  const payload = asObject(record.payload);
  return role === 'assistant' && payload?.phase === 'commentary' ? 'pending' : 'durable';
}

function pendingCommentaryIdsAfterLastDurableMessage(messages: NormalizedMessage[]): Set<string> {
  let lastDurableIndex = -1;
  messages.forEach((message, index) => {
    if (message.lifecycle === 'durable') {
      lastDurableIndex = index;
    }
  });

  const pendingTail = messages
    .slice(lastDurableIndex + 1)
    .filter(isCodexAssistantCommentaryMessage);
  return new Set(pendingTail.map((message) => message.id));
}

function shouldShowCodexDisplayCandidate(message: NormalizedMessage, pendingCommentaryIds: Set<string>): boolean {
  if (!isCodexAssistantCommentaryMessage(message)) {
    return true;
  }
  return pendingCommentaryIds.has(message.id);
}

function toCodexDisplayMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const candidates = messages.filter((message) => !shouldHideCodexDisplayMessage(message));
  const pendingCommentaryIds = pendingCommentaryIdsAfterLastDurableMessage(candidates);
  return candidates.filter((message) => shouldShowCodexDisplayCandidate(message, pendingCommentaryIds));
}

function extractCodexMessage(record: Record<string, unknown>): { role: NormalizedMessage['role']; text: string } | undefined {
  const payload = asObject(record.payload);
  const run = codexRunState(record);
  if (run?.status === 'failed') return { role: 'status', text: `Run stopped: ${run.error!.message}` };

  if (record.type === 'response_item' && payload?.type === 'message') {
    const role = coerceMessageRole(payload.role);
    if (!role) return undefined;
    const allowedTypes = role === 'user'
      ? ['input_text', 'text']
      : role === 'assistant'
        ? ['output_text', 'text']
        : ['text'];
    const text = extractTextBlocks(payload.content, allowedTypes);
    return text ? { role, text } : undefined;
  }

  if (record.type === 'event_msg' && payload?.type === 'user_message') {
    const messageObject = asObject(payload.message);
    const text = messageObject
      ? extractTextFromFields(messageObject, ['text', 'content'], ['input_text', 'text'])
      : extractTextBlocks(payload.message, ['input_text', 'text']);
    return text ? { role: 'user', text } : undefined;
  }

  if (record.type === 'event_msg' && payload?.type === 'agent_message') {
    const messageObject = asObject(payload.message);
    const text = messageObject
      ? extractTextFromFields(messageObject, ['text', 'content'], ['output_text', 'text'])
      : extractTextBlocks(payload.message, ['output_text', 'text']);
    return text ? { role: 'assistant', text } : undefined;
  }

  const directRole = coerceMessageRole(record.role)
    ?? coerceMessageRole(payload?.role)
    ?? coerceMessageRole(asObject(record.message)?.role)
    ?? coerceMessageRole(asObject(payload?.message)?.role);
  if (!directRole) {
    return undefined;
  }

  const directAllowedTypes = directRole === 'user'
    ? ['input_text', 'text']
    : directRole === 'assistant'
      ? ['output_text', 'text']
      : ['text'];

  const directText = extractTextFromFields(record, ['text', 'message_text', 'content'], directAllowedTypes)
    || (asObject(record.message) ? extractTextFromFields(asObject(record.message)!, ['text', 'content'], directAllowedTypes) : '')
    || (payload ? extractTextFromFields(payload, ['text', 'message_text', 'content'], directAllowedTypes) : '')
    || (asObject(payload?.message) ? extractTextFromFields(asObject(payload?.message)!, ['text', 'content'], directAllowedTypes) : '');

  return directText ? { role: directRole, text: directText } : undefined;
}

function codexJsonlLineContainsUserHash(line: string, userTextHash: string): boolean {
  if (!line.trim()) return false;
  try {
    const extracted = extractCodexMessage(JSON.parse(line) as Record<string, unknown>);
    return extracted?.role === 'user'
      && stableTextHash(normalizeComparableText(extracted.text)) === userTextHash;
  } catch {
    return false;
  }
}

export async function codexJsonlFileContainsUserHash(filePath: string, userTextHash: string): Promise<boolean> {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (codexJsonlLineContainsUserHash(line, userTextHash)) {
        return true;
      }
    }
    return false;
  } finally {
    lines.close();
    input.destroy();
  }
}

function timestampMs(message: NormalizedMessage): number | undefined {
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface DedupeSlot {
  message: NormalizedMessage;
  comparable: string;
  timestampMs: number | undefined;
  kind: ReturnType<typeof codexRecordKind>;
}

function codexRecordKind(message: NormalizedMessage): 'response-message' | 'event-message' | 'other' {
  const record = asObject(message.rawMetadata);
  const payload = asObject(record?.payload);
  if (record?.type === 'response_item' && payload?.type === 'message') {
    return 'response-message';
  }
  if (
    record?.type === 'event_msg'
    && (payload?.type === 'user_message' || payload?.type === 'agent_message')
  ) {
    return 'event-message';
  }
  return 'other';
}

function isCodexEventResponseDuplicate(existing: DedupeSlot, candidate: DedupeSlot): boolean {
  if (
    existing.timestampMs === undefined
    || candidate.timestampMs === undefined
    || Math.abs(existing.timestampMs - candidate.timestampMs) > CODEX_EVENT_RESPONSE_DUPLICATE_WINDOW_MS
  ) {
    return false;
  }

  return (existing.kind === 'event-message' && candidate.kind === 'response-message')
    || (existing.kind === 'response-message' && candidate.kind === 'event-message');
}

function dedupeCodexEventResponseMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const slots: DedupeSlot[] = [];
  const slotIndexesByKey = new Map<string, number[]>();

  for (const message of messages) {
    const comparable = normalizeComparableText(sanitizeCodexDisplayText(message.text, message.role));
    const slot: DedupeSlot = {
      message,
      comparable,
      timestampMs: timestampMs(message),
      kind: codexRecordKind(message),
    };

    // Empty comparable text never participates in event/response deduplication.
    if (!comparable) {
      slots.push(slot);
      continue;
    }

    const key = `${message.role}:${comparable}`;
    const candidateIndexes = slotIndexesByKey.get(key);
    const duplicateIndex = candidateIndexes?.find((index) => isCodexEventResponseDuplicate(slots[index]!, slot));
    if (duplicateIndex === undefined) {
      const index = slots.length;
      slots.push(slot);
      if (candidateIndexes) {
        candidateIndexes.push(index);
      } else {
        slotIndexesByKey.set(key, [index]);
      }
      continue;
    }

    const existing = slots[duplicateIndex]!;
    if (existing.kind !== 'response-message' && slot.kind === 'response-message') {
      slots[duplicateIndex] = slot;
    }
  }

  return slots.map((slot) => slot.message);
}

export async function parseCodexConversationFile(input: TranscriptParseInput): Promise<ParsedTranscript> {
  const fallbackTime = (await fs.promises.stat(input.filePath)).mtime.toISOString();
  const messages: NormalizedMessage[] = [];
  const projectPaths = new Set<string>();
  const authoritativeProjectPaths = new Set<string>();
  const shouldCollectPathMetadata = input.collectPathMetadata !== false;
  let originator: string | undefined;
  let source: string | undefined;
  let threadSource: string | undefined;

  for await (const { index, record } of iterateJsonlRecords(input.filePath)) {
    if (shouldCollectPathMetadata) {
      collectProjectPaths(record, projectPaths);
      collectAuthoritativeProjectPaths(record, authoritativeProjectPaths);
    }
    if (record.type === 'session_meta') {
      const payload = asObject(record.payload);
      originator ??= typeof payload?.originator === 'string' ? payload.originator : undefined;
      source ??= typeof payload?.source === 'string' ? payload.source : undefined;
      threadSource ??= typeof payload?.thread_source === 'string' ? payload.thread_source : undefined;
    }
    const extracted = extractCodexMessage(record);
    if (!extracted) continue;
    const timestamp = extractTimestamp(record, fallbackTime);
    messages.push({
      id: stableTextHash(`${input.provider}:${input.conversationRef}:${input.filePath}:${index}:${extracted.role}:${extracted.text}`),
      provider: input.provider,
      role: extracted.role,
      statusKind: codexRunState(record)?.status === 'failed' ? 'run-failure' : undefined,
      lifecycle: codexMessageLifecycle(record, extracted.role),
      text: extracted.text,
      timestamp,
      conversationRef: input.conversationRef,
      source: 'history-file',
      rawMetadata: record,
    });
  }

  const dedupedMessages = dedupeCodexEventResponseMessages(messages);
  const displayMessages = toCodexDisplayMessages(dedupedMessages)
    .map((message) => ({
      ...message,
      text: sanitizeCodexDisplayText(message.text, message.role),
    }))
    .filter((message) => message.text.length > 0);

  return buildParsedTranscript({
    ...input,
    fallbackTime,
    messages: dedupedMessages,
    displayMessages,
    projectPaths,
    authoritativeProjectPaths,
    metadata: {
      originator,
      source,
      threadSource,
    },
  });
}
