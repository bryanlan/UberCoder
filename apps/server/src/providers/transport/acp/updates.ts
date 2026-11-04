import { asNumber, asString, isRecord } from './readers.js';

/** The kind the Console files a tool call under, from the `kind` ACP gives it. */
export function itemKindForTool(kind: unknown, title: unknown): 'command' | 'file_change' | 'mcp' | 'search' | 'other' {
  switch (kind) {
    case 'execute':
      return 'command';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_change';
    case 'search':
    case 'fetch':
      return 'search';
    default:
      return typeof title === 'string' && /mcp/i.test(title) ? 'mcp' : 'other';
  }
}

/**
 * ACP stop reasons, as a turn status. `max_tokens` and `max_turn_requests` end the turn normally; the notice names the
 * product and says why it stopped.
 */
export function stopReasonStatus(stopReason: unknown, productLabel: string): { status: 'completed' | 'interrupted' | 'failed'; notice?: string } {
  switch (stopReason) {
    case 'cancelled':
      return { status: 'interrupted' };
    case 'refusal':
      return { status: 'failed' };
    case 'max_tokens':
      return { status: 'completed', notice: `${productLabel} stopped because it reached its output limit for the turn.` };
    case 'max_turn_requests':
      return { status: 'completed', notice: `${productLabel} stopped because it reached its limit of model calls for the turn.` };
    default:
      return { status: 'completed' };
  }
}

export type StandardUpdate =
  | { action: 'config' }
  | { action: 'message' | 'thought' }
  | { action: 'tool' | 'tool-update' }
  | { action: 'usage'; used?: number; size?: number }
  | { action: 'ignore' }
  | { action: 'unknown'; type?: string };

/** What a standard `session/update` body is. Dialect notifications (`_x.ai/*`, rate limits) are not this. */
export function classifyStandardUpdate(update: Record<string, unknown>): StandardUpdate {
  const type = asString(update.sessionUpdate);
  switch (type) {
    case 'config_option_update':
      return { action: 'config' };
    case 'agent_message_chunk':
      return { action: 'message' };
    case 'agent_thought_chunk':
      return { action: 'thought' };
    case 'tool_call':
      return { action: 'tool' };
    case 'tool_call_update':
      return { action: 'tool-update' };
    case 'usage_update':
      return { action: 'usage', used: asNumber(update.used), size: asNumber(update.size) };
    case 'user_message_chunk':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'plan':
    case 'session_info_update':
      return { action: 'ignore' };
    default:
      return { action: 'unknown', ...(type ? { type } : {}) };
  }
}

/** A finished tool call that has not already been filed, or undefined. */
export function completedToolCall(update: Record<string, unknown>, isUpdate: boolean, seen: Set<string>): { id: string; kind: ReturnType<typeof itemKindForTool>; title?: string } | undefined {
  const id = asString(update.toolCallId);
  if (!id || !isUpdate) return undefined;
  const status = asString(update.status);
  if (status !== 'completed' && status !== 'failed') return undefined;
  if (seen.has(id)) return undefined;
  seen.add(id);
  const title = asString(update.title);
  return { id, kind: itemKindForTool(update.kind, title), ...(title ? { title } : {}) };
}

export function usageMeta(update: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(update._meta) ? update._meta : undefined;
}
