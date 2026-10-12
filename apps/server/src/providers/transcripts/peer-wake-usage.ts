import type { ProviderId } from '@agent-console/shared';
import { iterateJsonlRecords } from './base.js';
import { isCoordinationWakePrompt } from '../../coordination/wake.js';

export interface WakeTokens {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface NativeWakeTurn {
  turnId: string;
  promptAt: string;
  completedAt: string | null;
  outcome: 'running' | 'completed' | 'failed' | 'cancelled';
  model: string | null;
  usage: WakeTokens | null;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(object).filter((v) => v.type === 'text' || v.type === 'input_text')
    .map((v) => typeof v.text === 'string' ? v.text : '').join('\n') : '';
}
function tokens(raw: unknown, provider: ProviderId): WakeTokens | null {
  const u = object(raw);
  const input = u.input_tokens, output = u.output_tokens;
  const cached = provider === 'codex' ? u.cached_input_tokens : u.cache_read_input_tokens;
  const write = provider === 'codex' ? u.cache_write_input_tokens : u.cache_creation_input_tokens;
  if (![input, output, cached, write].every(count)) return null;
  const inputTokens = (input as number) + (provider === 'claude' ? (cached as number) + (write as number) : 0);
  if (provider === 'codex' && (cached as number) + (write as number) > inputTokens) return null;
  return { inputTokens, cachedInputTokens: cached as number, cacheWriteInputTokens: write as number,
    outputTokens: output as number, totalTokens: inputTokens + (output as number) };
}
function sum(values: WakeTokens[]): WakeTokens {
  return values.reduce((a, b) => ({ inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens }),
  { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

/** Native, exact control-prompt turns only. No session-total or timestamp-only usage estimates. */
export async function readNativeWakeTurns(provider: ProviderId, filePath: string, until = Infinity): Promise<NativeWakeTurn[]> {
  const turns: NativeWakeTurn[] = [];
  let current: NativeWakeTurn | undefined;
  let codexId: string | undefined;
  let model: string | null = null;
  const requests = new Map<string, WakeTokens | null>();
  const finalizeClaude = () => {
    if (current && provider === 'claude') current.usage = requests.size && [...requests.values()].every(Boolean)
      ? sum([...requests.values()] as WakeTokens[]) : null;
    requests.clear();
  };
  for await (const { record: r } of iterateJsonlRecords(filePath)) {
    const p = object(r.payload), m = object(r.message);
    const timestamp = typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)) ? r.timestamp : undefined;
    if (!timestamp || Date.parse(timestamp) > until || r.isSidechain === true) continue;
    if (provider === 'codex') {
      if (r.type === 'event_msg' && p.type === 'task_started') {
        codexId = typeof p.turn_id === 'string' ? p.turn_id : undefined;
        current = undefined;
      } else if (r.type === 'turn_context') {
        model = typeof p.model === 'string' ? p.model : null;
        if (current && p.turn_id === current.turnId) current.model = model;
      } else if (r.type === 'response_item' && p.role === 'user' && codexId && isCoordinationWakePrompt(text(p.content))) {
        if (!current) {
          current = { turnId: codexId, promptAt: timestamp, completedAt: null, outcome: 'running', model, usage: null };
          turns.push(current);
        }
      } else if (r.type === 'token_usage_record' && current && p.turn_id === current.turnId) {
        // The native turn snapshot includes earlier requests and cannot double-count duplicate token_count envelopes.
        current.usage = tokens(p.turn_token_usage, provider);
      } else if (r.type === 'event_msg' && current && p.turn_id === current.turnId
        && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
        current.outcome = p.type === 'turn_aborted' ? 'cancelled' : p.error ? 'failed' : 'completed';
        current.completedAt = timestamp;
      }
    } else {
      const prompt = text(m.content);
      if (r.type === 'user' && r.isMeta !== true && r.isCompactSummary !== true && prompt.trim()) {
        finalizeClaude();
        current = undefined;
        if (isCoordinationWakePrompt(prompt) && typeof r.uuid === 'string') {
          current = { turnId: r.uuid, promptAt: timestamp, completedAt: null, outcome: 'running', model: null, usage: null };
          turns.push(current);
        }
      } else if (r.type === 'assistant' && current && timestamp >= current.promptAt && typeof m.id === 'string') {
        current.model = typeof m.model === 'string' ? m.model : current.model;
        // Claude streams multiple records for the same request. Keep the latest usage once per native message ID.
        requests.set(m.id, tokens(m.usage, provider));
        if (m.stop_reason === 'end_turn') { current.outcome = 'completed'; current.completedAt = timestamp; }
      }
    }
  }
  finalizeClaude();
  return turns;
}
