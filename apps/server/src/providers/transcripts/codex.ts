import type { NormalizedMessage } from '@agent-console/shared';
import { stableTextHash } from '../../lib/text.js';
import {
  asObject,
  buildParsedTranscript,
  collectAuthoritativeProjectPaths,
  collectProjectPaths,
  coerceMessageRole,
  extractTextBlocks,
  extractTextFromFields,
  extractTimestamp,
  loadJsonlRecords,
} from './base.js';
import type { ParsedTranscript, TranscriptParseInput } from './types.js';

function shouldHideCodexDisplayMessage(message: NormalizedMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return true;
  }

  if (message.role !== 'user') {
    return false;
  }

  const trimmed = message.text.trim();
  return /^<user_instructions>[\s\S]*<\/user_instructions>$/i.test(trimmed)
    || /^<environment_context>[\s\S]*<\/environment_context>$/i.test(trimmed)
    || /^#\s*AGENTS\.md instructions for\b[\s\S]*$/i.test(trimmed)
    || /^<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/i.test(trimmed);
}

function extractCodexMessage(record: Record<string, unknown>): { role: NormalizedMessage['role']; text: string } | undefined {
  const payload = asObject(record.payload);

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

export async function parseCodexConversationFile(input: TranscriptParseInput): Promise<ParsedTranscript> {
  const { records, fallbackTime } = await loadJsonlRecords(input.filePath);
  const messages: NormalizedMessage[] = [];
  const projectPaths = new Set<string>();
  const authoritativeProjectPaths = new Set<string>();

  for (const { index, record } of records) {
    collectProjectPaths(record, projectPaths);
    collectAuthoritativeProjectPaths(record, authoritativeProjectPaths);
    const extracted = extractCodexMessage(record);
    if (!extracted) continue;
    const timestamp = extractTimestamp(record, fallbackTime);
    messages.push({
      id: stableTextHash(`${input.provider}:${input.conversationRef}:${input.filePath}:${index}:${extracted.role}:${extracted.text}`),
      provider: input.provider,
      role: extracted.role,
      text: extracted.text,
      timestamp,
      conversationRef: input.conversationRef,
      source: 'history-file',
      rawMetadata: record,
    });
  }

  const displayMessages = messages.filter((message) => !shouldHideCodexDisplayMessage(message));

  return buildParsedTranscript({
    ...input,
    fallbackTime,
    messages,
    displayMessages,
    projectPaths,
    authoritativeProjectPaths,
  });
}
