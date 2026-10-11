import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PEER_WAKE_PROMPT } from '../src/coordination/wake.js';
import { readNativeWakeTurns } from '../src/providers/transcripts/peer-wake-usage.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function transcript(records: unknown[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-usage-')); roots.push(root);
  const file = path.join(root, 'native.jsonl'); fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n'); return file;
}
const at = (second: number) => `2026-10-11T04:00:${String(second).padStart(2, '0')}.000Z`;
const codex = (second: number, payload: unknown, type = 'event_msg') => ({ timestamp: at(second), type, payload });
const nativeTokens = { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 10 };
const claudeTokens = { input_tokens: 2, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 5 };
describe('Native peer-wake usage', () => {
  it('reads Codex native turn snapshots once and excludes a preceding human turn and token_count duplicates', async () => {
    const file = transcript([
      codex(0, { type: 'task_started', turn_id: 'human' }),
      codex(1, { turn_id: 'human', turn_token_usage: nativeTokens }, 'token_usage_record'),
      codex(2, { type: 'task_started', turn_id: 'peer' }),
      codex(3, { turn_id: 'peer', model: 'test-model' }, 'turn_context'),
      codex(4, { role: 'user', content: [{ type: 'input_text', text: PEER_WAKE_PROMPT }] }, 'response_item'),
      codex(5, { turn_id: 'peer', turn_token_usage: nativeTokens }, 'token_usage_record'),
      codex(6, { type: 'token_count', info: { total_token_usage: nativeTokens } }),
      codex(7, { turn_id: 'peer', turn_token_usage: { ...nativeTokens, input_tokens: 200, output_tokens: 20 } }, 'token_usage_record'),
      codex(8, { type: 'task_complete', turn_id: 'peer' }),
    ]);
    const turns = await readNativeWakeTurns('codex', file);
    expect(turns).toHaveLength(1); expect(turns[0]).toMatchObject({ turnId: 'peer', outcome: 'completed', model: 'test-model', usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 } });
  });
  it('keeps usage unknown when Codex lacks explicit native turn usage', async () => {
    const file = transcript([codex(0, { type: 'task_started', turn_id: 'peer' }),
      codex(1, { role: 'user', content: [{ type: 'input_text', text: PEER_WAKE_PROMPT }] }, 'response_item'),
      codex(2, { type: 'token_count', info: { total_token_usage: nativeTokens } })]);
    expect((await readNativeWakeTurns('codex', file))[0]?.usage).toBeNull();
  });
  it('deduplicates Claude streamed usage, includes cache input, and stops at the next actual user prompt', async () => {
    const assistant = (second: number, id: string, usage = claudeTokens, extra = {}) => ({ timestamp: at(second), type: 'assistant', message: { id, usage, model: 'test-model', ...extra } });
    const file = transcript([
      { timestamp: at(0), type: 'user', uuid: 'peer', message: { content: PEER_WAKE_PROMPT } },
      assistant(1, 'request1'), assistant(2, 'request1', { ...claudeTokens, output_tokens: 8 }),
      { timestamp: at(3), type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } },
      { ...assistant(4, 'child'), isSidechain: true },
      assistant(5, 'request2', claudeTokens, { stop_reason: 'end_turn' }),
      { timestamp: at(6), type: 'user', uuid: 'human', message: { content: 'human question' } }, assistant(7, 'request3'),
    ]);
    expect((await readNativeWakeTurns('claude', file))[0]).toMatchObject({ outcome: 'completed', completedAt: at(5), usage: { inputTokens: 184, cachedInputTokens: 160, cacheWriteInputTokens: 20, outputTokens: 13, totalTokens: 197 } });
  });
  it('does not attribute text that merely quotes the coordination notice', async () => {
    const file = transcript([{ timestamp: at(0), type: 'user', uuid: 'human', message: { content: 'Explain this: ' + PEER_WAKE_PROMPT } }]);
    expect(await readNativeWakeTurns('claude', file)).toEqual([]);
  });
  it('bounds native outcome and usage to the audit snapshot time', async () => {
    const file = transcript([codex(0, { type: 'task_started', turn_id: 'peer' }),
      codex(1, { role: 'user', content: [{ type: 'input_text', text: PEER_WAKE_PROMPT }] }, 'response_item'),
      codex(2, { turn_id: 'peer', turn_token_usage: nativeTokens }, 'token_usage_record'), codex(4, { type: 'task_complete', turn_id: 'peer' })]);
    expect((await readNativeWakeTurns('codex', file, Date.parse(at(3))))[0]).toMatchObject({ outcome: 'running', completedAt: null, usage: { totalTokens: 110 } });
  });
});
