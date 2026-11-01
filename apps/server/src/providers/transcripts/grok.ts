import fs from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedMessage } from '@agent-console/shared';
import { stableTextHash } from '../../lib/text.js';
import { isCoordinationWakePrompt, UNATTENDED_CONTINUATION_PROMPT } from '../../coordination/wake.js';
import { isAgentLaunchPrompt } from '../../grants/authority.js';
import { asObject, buildParsedTranscript, loadJsonlRecords } from './base.js';
import type { ParsedTranscript, TranscriptParseInput } from './types.js';

// Grok keeps each conversation in `<grok home>/sessions/<URL-encoded cwd>/<session id>/`:
//   summary.json   the index entry: the working directory (`info.cwd`), the generated title and the model
//   updates.jsonl  the ACP update stream, one line per update, in order
// The stream is chunked: a reply is many `agent_message_chunk` lines, so consecutive chunks of one speaker are joined into one
// message. Tool calls end the text before them; reasoning, hook output and bookkeeping updates are not conversation.

type JsonRecord = Record<string, unknown>;

/** The saved `summary.json` of a Grok session, or undefined when it is missing or not readable. */
export async function readGrokSummary(sessionDir: string): Promise<JsonRecord | undefined> {
  try {
    return asObject(JSON.parse(await fs.readFile(path.join(sessionDir, 'summary.json'), 'utf8')));
  } catch {
    return undefined;
  }
}

function recordTimestamp(record: JsonRecord, fallback: string): string {
  const meta = asObject(asObject(record.params)?._meta);
  const ms = typeof meta?.agentTimestampMs === 'number' ? meta.agentTimestampMs : undefined;
  if (ms !== undefined) return new Date(ms).toISOString();
  const seconds = typeof record.timestamp === 'number' ? record.timestamp : undefined;
  return seconds !== undefined ? new Date(seconds * 1000).toISOString() : fallback;
}

interface OpenMessage {
  role: 'user' | 'assistant';
  text: string;
  index: number;
  timestamp: string;
}

export async function parseGrokConversationFile(input: TranscriptParseInput): Promise<ParsedTranscript> {
  const sessionDir = path.dirname(input.filePath);
  const summary = await readGrokSummary(sessionDir);
  const { records, fallbackTime } = await loadJsonlRecords(input.filePath);
  const messages: NormalizedMessage[] = [];
  let open: OpenMessage | undefined;

  const flush = (): void => {
    if (!open) return;
    const { role, index, timestamp } = open;
    const text = open.text;
    open = undefined;
    if (!text.trim()) return;
    const peerWake = role === 'user' && isCoordinationWakePrompt(text);
    const agentLaunch = role === 'user' && isAgentLaunchPrompt(text);
    messages.push({
      id: stableTextHash(`${input.provider}:${input.conversationRef}:${input.filePath}:${index}:${role}:${text}`),
      provider: input.provider,
      role: peerWake || agentLaunch ? 'status' : role,
      lifecycle: 'durable',
      text: peerWake
        ? text.trim() === UNATTENDED_CONTINUATION_PROMPT ? 'Agent continuing the unattended assignment.' : 'Agent responding to peer messages.'
        : text,
      ...(peerWake || agentLaunch ? { statusKind: 'coordination' as const } : {}),
      timestamp,
      conversationRef: input.conversationRef,
      source: 'history-file',
    });
  };

  for (const { index, record } of records) {
    const update = asObject(asObject(record.params)?.update);
    const type = typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
    if (!update || !type) continue;
    if (type === 'user_message_chunk' || type === 'agent_message_chunk') {
      const role = type === 'user_message_chunk' ? 'user' : 'assistant';
      const content = asObject(update.content);
      if (content?.type !== 'text' || typeof content.text !== 'string') continue;
      if (open && open.role !== role) flush();
      if (!open) open = { role, text: '', index, timestamp: recordTimestamp(record, fallbackTime) };
      open.text += content.text;
      continue;
    }
    // Only these end the text being collected; hook runs and other bookkeeping can fall between two chunks of one reply.
    if (type === 'tool_call' || type === 'agent_thought_chunk' || type === 'turn_completed') flush();
  }
  flush();

  const cwd = typeof asObject(summary?.info)?.cwd === 'string' ? path.resolve(asObject(summary?.info)!.cwd as string) : undefined;
  const projectPaths = new Set<string>(cwd ? [cwd] : []);
  const title = typeof summary?.generated_title === 'string' && summary.generated_title.trim()
    ? summary.generated_title.trim()
    : typeof summary?.session_summary === 'string' && summary.session_summary.trim() ? summary.session_summary.trim() : undefined;
  const model = typeof summary?.current_model_id === 'string' ? summary.current_model_id : undefined;

  return buildParsedTranscript({
    ...input,
    fallbackTime,
    messages,
    projectPaths,
    authoritativeProjectPaths: new Set(projectPaths),
    ...(model ? { model } : {}),
    metadata: { ...(title ? { title } : {}), source: 'grok' },
  });
}
