import path from 'node:path';
import type { NormalizedMessage } from '@agent-console/shared';
import { stableTextHash } from '../../lib/text.js';
import { isCoordinationWakePrompt, UNATTENDED_CONTINUATION_PROMPT } from '../../coordination/wake.js';
import { isAgentLaunchPrompt } from '../../grants/authority.js';
import { withoutSessionStartContext } from '../../coordination/console-registration.js';
import { buildParsedTranscript } from './base.js';
import type { ParsedTranscript, TranscriptParseInput } from './types.js';
import { readVibeHistory, VibeStoreFormatError } from '../vibe-store.js';

/**
 * One past Vibe conversation. `filePath` is the session's `CURRENT` pointer. An unknown store format throws
 * {@link VibeStoreFormatError} so the caller skips that conversation instead of inventing messages.
 */
export async function parseVibeConversationFile(input: TranscriptParseInput): Promise<ParsedTranscript> {
  const sessionDir = path.dirname(input.filePath);
  const read = readVibeHistory(sessionDir);
  if (!read.ok) throw new VibeStoreFormatError(read.reason);
  const messages: NormalizedMessage[] = [];
  read.history.messages.forEach((message, index) => {
    // The first prompt of a new conversation carries the Console's session-start block in front of the person's words.
    const text = message.role === 'user' ? withoutSessionStartContext(message.text) : message.text;
    if (!text.trim()) return;
    const peerWake = message.role === 'user' && isCoordinationWakePrompt(text);
    const agentLaunch = message.role === 'user' && isAgentLaunchPrompt(text);
    messages.push({
      id: stableTextHash(`${input.provider}:${input.conversationRef}:${input.filePath}:${index}:${message.role}:${text}`),
      provider: input.provider,
      role: peerWake || agentLaunch ? 'status' : message.role,
      lifecycle: 'durable',
      text: peerWake
        ? text.trim() === UNATTENDED_CONTINUATION_PROMPT ? 'Agent continuing the unattended assignment.' : 'Agent responding to peer messages.'
        : text,
      ...(peerWake || agentLaunch ? { statusKind: 'coordination' as const } : {}),
      timestamp: message.timestamp,
      conversationRef: input.conversationRef,
      source: 'history-file',
    });
  });
  const cwd = read.history.cwd ? path.resolve(read.history.cwd) : undefined;
  const projectPaths = new Set<string>(cwd ? [cwd] : []);
  return buildParsedTranscript({
    ...input,
    fallbackTime: messages[0]?.timestamp ?? new Date(0).toISOString(),
    messages,
    projectPaths,
    authoritativeProjectPaths: new Set(projectPaths),
    ...(read.history.model ? { model: read.history.model } : {}),
    metadata: { ...(read.history.title ? { title: read.history.title } : {}), source: 'vibe' },
  });
}
