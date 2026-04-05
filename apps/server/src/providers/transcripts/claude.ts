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

function extractClaudeText(container: Record<string, unknown>, role: NormalizedMessage['role']): string {
  const allowedTypes = ['text'];
  return extractTextFromFields(container, ['text', 'content'], allowedTypes)
    || (asObject(container.message) ? extractTextFromFields(asObject(container.message)!, ['text', 'content'], allowedTypes) : '')
    || (asObject(container.data) ? extractTextFromFields(asObject(container.data)!, ['text', 'content'], allowedTypes) : '')
    || (
      role === 'user' || role === 'assistant'
        ? extractTextBlocks(container.content, allowedTypes)
        : ''
    );
}

function shouldHideClaudeDisplayMessage(message: NormalizedMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return true;
  }

  return /^<(?:command-name|command-message|command-args|local-command-(?:stdout|stderr|caveat))>/i.test(message.text.trim());
}

function extractClaudeMessage(record: Record<string, unknown>): { role: NormalizedMessage['role']; text: string } | undefined {
  const progressEnvelope = asObject(asObject(record.data)?.message);
  if (progressEnvelope) {
    const nestedMessage = asObject(progressEnvelope.message) ?? progressEnvelope;
    const role = coerceMessageRole(progressEnvelope.type) ?? coerceMessageRole(nestedMessage.role);
    if (role === 'user' || role === 'assistant') {
      const text = extractClaudeText(nestedMessage, role);
      return text ? { role, text } : undefined;
    }
  }

  const directMessage = asObject(record.message);
  if (directMessage) {
    const role = coerceMessageRole(record.type) ?? coerceMessageRole(directMessage.role);
    if (role === 'user' || role === 'assistant') {
      const text = extractClaudeText(directMessage, role);
      return text ? { role, text } : undefined;
    }
  }

  const directRole = coerceMessageRole(record.role) ?? coerceMessageRole(record.type);
  if (directRole === 'user' || directRole === 'assistant') {
    const text = extractClaudeText(record, directRole);
    return text ? { role: directRole, text } : undefined;
  }

  return undefined;
}

export async function parseClaudeConversationFile(input: TranscriptParseInput): Promise<ParsedTranscript> {
  const { records, fallbackTime } = await loadJsonlRecords(input.filePath);
  const messages: NormalizedMessage[] = [];
  const projectPaths = new Set<string>();
  const authoritativeProjectPaths = new Set<string>();
  let model: string | undefined;

  for (const { index, record } of records) {
    collectProjectPaths(record, projectPaths);
    collectAuthoritativeProjectPaths(record, authoritativeProjectPaths);
    if (typeof record.cwd === 'string') {
      projectPaths.add(record.cwd);
    }
    if (typeof record.project_path === 'string') {
      projectPaths.add(record.project_path);
    }

    if (!model) {
      const msg = asObject(record.message);
      if (msg && typeof msg.model === 'string') {
        model = msg.model;
      }
    }

    const extracted = extractClaudeMessage(record);
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

  const displayMessages = messages.filter((message) => !shouldHideClaudeDisplayMessage(message));

  return buildParsedTranscript({
    ...input,
    fallbackTime,
    messages,
    displayMessages,
    projectPaths,
    authoritativeProjectPaths,
    model,
  });
}
