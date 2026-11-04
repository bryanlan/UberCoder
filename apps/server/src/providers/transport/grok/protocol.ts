// What the Grok plugin knows about the Agent Client Protocol (ACP) as `grok agent stdio` speaks it. Checked against
// grok 1.0.70 on 2026-11-01 (see docs/structured-providers.md, "Grok plugin"). Everything here is small readers over
// untyped JSON: a reply that does not have the expected shape is ignored or refused, never trusted.

import type { ProviderFailure } from '../types.js';
import { asNumber, asString, isRecord, readConfigValue as readAnyConfigValue } from '../acp/readers.js';
import { stopReasonStatus as stopReasonFor } from '../acp/updates.js';

export { isRecord, asString, asNumber } from '../acp/readers.js';
export { itemKindForTool } from '../acp/updates.js';

/** The ACP method names the plugin sends. Extension methods carry the leading underscore ACP puts on the wire. */
export const ACP = {
  initialize: 'initialize',
  newSession: 'session/new',
  loadSession: 'session/load',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  setConfigOption: 'session/set_config_option',
  requestPermission: 'session/request_permission',
  /** Notification: streamed content of a turn. */
  update: 'session/update',
  /** Notification: Grok's own session events (turn end, background tasks, retries). */
  extUpdate: '_x.ai/session_notification',
  /** Notification: the end of a prompt, with the stop reason. */
  extPromptComplete: '_x.ai/session/prompt_complete',
  /** Request: every resident session with its `activity` (`working`, `idle`). Used to learn what a surviving process is doing. */
  extSessionsList: '_x.ai/sessions/list',
  /** Request: whether the login is good. */
  extCheckSubscription: '_x.ai/auth/check_subscription',
} as const;

export interface GrokModel {
  id: string;
  label: string;
  efforts: string[];
  contextTokens?: number;
}

/** The model list that `initialize` (`_meta.modelState`) and `session/new` (`models`) both carry. */
export function readModels(source: unknown): { current?: string; models: GrokModel[] } {
  if (!isRecord(source)) return { models: [] };
  const available = Array.isArray(source.availableModels) ? source.availableModels : [];
  const models: GrokModel[] = [];
  for (const entry of available) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.modelId);
    if (!id) continue;
    const meta = isRecord(entry._meta) ? entry._meta : {};
    const efforts = Array.isArray(meta.reasoningEfforts)
      ? meta.reasoningEfforts.flatMap(item => (isRecord(item) && asString(item.id) ? [asString(item.id)!] : []))
      : [];
    const contextTokens = asNumber(meta.totalContextTokens);
    models.push({ id, label: asString(entry.name) ?? id, efforts, ...(contextTokens !== undefined ? { contextTokens } : {}) });
  }
  return { ...(asString(source.currentModelId) ? { current: asString(source.currentModelId)! } : {}), models };
}

/** The current value of a `select` config option (`model` or `reasoning_effort`) in a `configOptions` list. */
export function readConfigValue(options: unknown, id: 'model' | 'reasoning_effort'): string | undefined {
  return readAnyConfigValue(options, id);
}

/** ACP stop reasons, as a turn status. `max_tokens` and `max_turn_requests` end the turn normally; the notice says why it stopped. */
export function stopReasonStatus(stopReason: unknown): { status: 'completed' | 'interrupted' | 'failed'; notice?: string } {
  return stopReasonFor(stopReason, 'Grok');
}

const USAGE_LIMIT_PATTERN = /usage[_ ]limit|weekly limit|credit limit|spending cap|out of credits|usage_pool_exhausted|\b402\b/i;
const RATE_LIMIT_PATTERN = /rate[_ ]limit|\b429\b|too many requests|capacity|overloaded|\b50[234]\b|\b529\b/i;
const AUTH_PATTERN = /unauthori[sz]ed|not logged in|login required|authentication|\b401\b|\b403\b|auth(?:_|\s)?expired/i;

/** The failure a JSON-RPC error answer to `session/prompt` stands for. `message` is cut short; the caller redacts it. */
export function classifyGrokFailure(code: number | undefined, message: string, data?: unknown): ProviderFailure {
  const detail = `${message} ${typeof data === 'string' ? data : isRecord(data) ? JSON.stringify(data).slice(0, 400) : ''}`;
  if (USAGE_LIMIT_PATTERN.test(detail)) return { class: 'usage_limit', code: 'usage_limit', message, retryable: false };
  if (AUTH_PATTERN.test(detail)) return { class: 'permission_error', code: 'unauthorized', message, retryable: false };
  if (RATE_LIMIT_PATTERN.test(detail)) return { class: 'provider_error', code: 'rate_limited', message, retryable: true };
  return { class: 'provider_error', ...(code !== undefined ? { code: String(code) } : {}), message, retryable: false };
}
