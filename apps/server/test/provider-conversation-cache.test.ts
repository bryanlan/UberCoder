import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '@agent-console/shared';
import { loadProviderConversationFromSummary } from '../src/lib/provider-conversation-cache.js';

function codexUserMessage(text: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
}

function summaryFor(transcriptPath: string, ref: string): ConversationSummary {
  return {
    ref,
    kind: 'history',
    projectSlug: 'demo',
    provider: 'codex',
    title: 'Cache test',
    updatedAt: '2026-07-07T00:00:00.000Z',
    transcriptPath,
    isBound: false,
    degraded: false,
  };
}

describe('provider conversation cache', () => {
  it('re-parses small changing transcripts even when stale-while-changing is requested', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-cache-'));
    const transcriptPath = path.join(tempDir, 'rollout-small-stale.jsonl');
    await fs.writeFile(transcriptPath, `${codexUserMessage('first message', '2026-07-07T00:00:00.000Z')}\n`);
    const summary = summaryFor(transcriptPath, 'small-stale');

    const initial = await loadProviderConversationFromSummary(summary, { allowStaleWhileChanging: true });
    expect(initial?.messages.map((message) => message.text)).toEqual(['first message']);

    await fs.appendFile(transcriptPath, `${codexUserMessage('second message', '2026-07-07T00:01:00.000Z')}\n`);

    const refreshed = await loadProviderConversationFromSummary(summary, { allowStaleWhileChanging: true });
    expect(refreshed?.messages.map((message) => message.text)).toEqual(['first message', 'second message']);
  });

  it('serves the stale parse for large changing transcripts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-cache-'));
    const transcriptPath = path.join(tempDir, 'rollout-large-stale.jsonl');
    const padding = codexUserMessage(`padding ${'x'.repeat(64 * 1024)}`, '2026-07-07T00:00:00.000Z');
    const lines = Array.from({ length: 140 }, () => padding);
    lines.push(codexUserMessage('large first', '2026-07-07T00:00:01.000Z'));
    await fs.writeFile(transcriptPath, `${lines.join('\n')}\n`);
    const stat = await fs.stat(transcriptPath);
    expect(stat.size).toBeGreaterThan(8 * 1024 * 1024);
    const summary = summaryFor(transcriptPath, 'large-stale');

    const initial = await loadProviderConversationFromSummary(summary, { allowStaleWhileChanging: true });
    expect(initial?.messages.at(-1)?.text).toBe('large first');

    await fs.appendFile(transcriptPath, `${codexUserMessage('large second', '2026-07-07T00:02:00.000Z')}\n`);

    const stale = await loadProviderConversationFromSummary(summary, { allowStaleWhileChanging: true });
    expect(stale?.messages.at(-1)?.text).toBe('large first');

    const fresh = await loadProviderConversationFromSummary(summary);
    expect(fresh?.messages.at(-1)?.text).toBe('large second');
  });
});
