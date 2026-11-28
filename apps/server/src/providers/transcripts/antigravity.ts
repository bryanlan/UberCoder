import path from 'node:path';
import type { NormalizedMessage } from '@agent-console/shared';
import { stableTextHash } from '../../lib/text.js';
import { coordinationWakeStatus } from '../../coordination/wake.js';
import { isAgentLaunchPrompt } from '../../grants/authority.js';
import { withoutSessionStartContext } from '../../coordination/console-registration.js';
import { buildParsedTranscript } from './base.js';
import type { ParsedTranscript, TranscriptParseInput } from './types.js';
import {
  AntigravityStoreFormatError,
  discoveryRootFromTranscriptPath,
  readAntigravityHistory,
  readAntigravityMetadataMap,
  type AntigravityConversationMeta,
} from '../antigravity-store.js';

/**
 * One past Antigravity conversation. `filePath` is `brain/<sessionId>/.system_generated/logs/transcript.jsonl`.
 * Metadata (title and workspace URIs) comes from `<discoveryRoot>/cache/conversation_metadata.json`.
 */
export async function parseAntigravityConversationFile(
  input: TranscriptParseInput,
  metaOverride?: AntigravityConversationMeta,
): Promise<ParsedTranscript> {
  const discoveryRoot = discoveryRootFromTranscriptPath(input.filePath);
  const meta = metaOverride ?? (discoveryRoot ? readAntigravityMetadataMap(discoveryRoot).get(input.conversationRef) : undefined);
  const read = readAntigravityHistory(input.filePath, meta);
  if (!read.ok) throw new AntigravityStoreFormatError(read.reason);

  const messages: NormalizedMessage[] = [];
  read.value.messages.forEach((message, index) => {
    const text = message.role === 'user' ? withoutSessionStartContext(message.text) : message.text;
    if (!text.trim()) return;
    const wakeStatus = message.role === 'user' ? coordinationWakeStatus(text) : undefined;
    const agentLaunch = message.role === 'user' && isAgentLaunchPrompt(text);
    messages.push({
      id: stableTextHash(`${input.provider}:${input.conversationRef}:${input.filePath}:${index}:${message.role}:${text}`),
      provider: input.provider,
      role: wakeStatus || agentLaunch ? 'status' : message.role,
      lifecycle: 'durable',
      text: wakeStatus ?? text,
      ...(wakeStatus || agentLaunch ? { statusKind: 'coordination' as const } : {}),
      timestamp: message.timestamp,
      conversationRef: input.conversationRef,
      source: 'history-file',
    });
  });

  const projectPaths = new Set<string>(read.value.workspacePaths.map(p => path.resolve(p)));
  return buildParsedTranscript({
    ...input,
    fallbackTime: read.value.updatedAt ?? messages[0]?.timestamp ?? new Date(0).toISOString(),
    messages,
    projectPaths,
    authoritativeProjectPaths: new Set(projectPaths),
    ...(read.value.model ? { model: read.value.model } : {}),
    metadata: { ...(read.value.title ? { title: read.value.title } : {}), source: 'antigravity' },
  });
}
