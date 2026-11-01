import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeRunMonitor } from '../src/providers/transcripts/claude-run-state.js';
import { parseClaudeConversationFile } from '../src/providers/transcripts/claude.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
const prompt = { type: 'user', uuid: 'turn1', timestamp: new Date().toISOString(), message: { content: 'Continue the assignment.' } };
const failure = (text: string, extra = {}) => ({ type: 'assistant', uuid: 'failure', timestamp: new Date().toISOString(),
  isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text }], stop_reason: 'stop_sequence' }, ...extra });
const line = (r: unknown) => JSON.stringify(r) + '\n';
async function file(records: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-run-state-')); paths.push(dir);
  const p = path.join(dir, 'transcript.jsonl'); await fs.writeFile(p, records.map(line).join('')); return p;
}

describe('Claude authoritative failed turns', () => {
  it.each([['529 Overloaded', 'server_overloaded'], ['500 Internal server error', 'server_unavailable']])
    ('detects native %s and preserves visible failure history', async (message, code) => {
      const p = await file([prompt, failure(`API Error: ${message}`)]);
      expect(await new ClaudeRunMonitor().read(p)).toMatchObject({ turnId: 'turn1', status: 'failed', error: { code } });
      const transcript = await parseClaudeConversationFile({ filePath: p, provider: 'claude', projectSlug: 'demo', conversationRef: 'c1' });
      expect(transcript.displayMessages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'status', text: `Run stopped: API Error: ${message}` })]));
    });

  it.each([
    ['ordinary prose', { isApiErrorMessage: false }, 'API Error: 529 Overloaded', 'running'],
    ['background child', { isSidechain: true }, 'API Error: 529 Overloaded', 'running'],
    ['authentication', {}, 'Failed to refresh OAuth token', 'failed'],
    ['quota', { error: 'rate_limit' }, "You've hit your session limit", 'failed'],
  ])('does not classify %s as transient capacity', async (_name, extra, text, status) => {
    const p = await file([prompt, failure(text, extra)]); const run = await new ClaudeRunMonitor().read(p);
    expect(run?.status).toBe(status); expect(run?.error?.code).not.toBe('server_overloaded'); expect(run?.error?.code).not.toBe('server_unavailable');
  });

  it('starts a new turn after the failed turn and ignores child failures', async () => {
    const p = await file([prompt, failure('API Error: 529 Overloaded')]); const m = new ClaudeRunMonitor();
    expect((await m.read(p))?.status).toBe('failed');
    await fs.appendFile(p, line({ ...prompt, uuid: 'turn2' }) + line(failure('API Error: 529 Overloaded', { isSidechain: true })));
    expect(await m.read(p)).toMatchObject({ turnId: 'turn2', status: 'running' });
  });

  it('emits native task notification once without treating it as a human prompt', async () => {
    const p = await file([prompt, { type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn' } }]);
    const m = new ClaudeRunMonitor(); const root = await m.read(p);
    const native = { type: 'user', uuid: 'notification-1', timestamp: new Date().toISOString(),
      message: { content: '<task-notification>\n<task-id>child-1</task-id>\n<status>completed</status>\n<result>Finished</result>\n</task-notification>' } };
    await fs.appendFile(p, line(native)); expect(await m.read(p)).toEqual(root);
    expect(m.takeChildActivity()).toEqual([{ id: 'notification-1', childId: 'child-1', timestamp: native.timestamp, kind: 'completed' }]);
    await m.read(p); expect(m.takeChildActivity()).toEqual([]);
    await fs.appendFile(p, line({ ...native, type: 'assistant' }) + line({ ...native, isSidechain: true }));
    await m.read(p); expect(m.takeChildActivity()).toEqual([]);
  });

});

describe('Claude native interruption', () => {
  const toolUse = { type: 'assistant', uuid: 'ask', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} }], stop_reason: 'tool_use' } };
  const rejected = { type: 'user', uuid: 'rejected', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } };
  const interrupted = (text: string) => ({ type: 'user', uuid: `interrupt-${text.length}`, timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] } });

  it.each(['[Request interrupted by user for tool use]', '[Request interrupted by user]'])
    ('ends the running turn as cancelled instead of starting a new one: %s', async (text) => {
      const p = await file([prompt, toolUse, rejected, interrupted(text),
        { type: 'system', subtype: 'turn_duration', timestamp: new Date().toISOString() }]);
      expect(await new ClaudeRunMonitor().read(p)).toMatchObject({ turnId: 'turn1', status: 'cancelled' });
    });

  it('starts the next real prompt after an interruption', async () => {
    const p = await file([prompt, toolUse, interrupted('[Request interrupted by user for tool use]')]); const m = new ClaudeRunMonitor();
    expect((await m.read(p))?.status).toBe('cancelled');
    await fs.appendFile(p, line({ ...prompt, uuid: 'turn2', message: { content: 'give me the link' } }));
    expect(await m.read(p)).toMatchObject({ turnId: 'turn2', status: 'running' });
  });

  it('keeps a prompt that only quotes the interruption marker as a real prompt', async () => {
    const p = await file([{ ...prompt, message: { content: 'Why did I see [Request interrupted by user] earlier?' } }]);
    expect(await new ClaudeRunMonitor().read(p)).toMatchObject({ turnId: 'turn1', status: 'running' });
  });
});
