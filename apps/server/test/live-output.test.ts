import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { readLiveMessages } from '../src/sessions/live-output.js';

describe('readLiveMessages', () => {
  it('strips ansi noise and suppresses echoed user input from live chunks', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'status', text: 'Bound codex session in Demo.', timestamp: '2026-03-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'user-input', text: 'Reply with exactly PONG and nothing else.', timestamp: '2026-03-07T00:00:01.000Z' }),
      JSON.stringify({ type: 'raw-output', text: '\u001b[?2026h\u001b[1;1H\u001b[J\u001b[3;1H› Reply with exactly PONG and nothing else.\u001b[6;1Hgpt-5.4 xhigh · 100% left · ~/code/demo\u001b[?2026l', timestamp: '2026-03-07T00:00:02.000Z' }),
      JSON.stringify({ type: 'raw-output', text: '\u001b[32mPONG\u001b[39m', timestamp: '2026-03-07T00:00:03.000Z' }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-1',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test',
      tmuxSessionName: 'ac-codex-demo',
      status: 'bound',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:03.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.map((message) => message.role)).toEqual(['status', 'user', 'assistant']);
    expect(messages[2]?.text).toBe('PONG');
    expect(messages.some((message) => message.text.includes('\u001b'))).toBe(false);
  });

  it('keeps startup chrome in status and drops repaint fragments', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({ type: 'status', text: 'Bound codex session in Demo.', timestamp: '2026-03-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'raw-output', text: '\u001b[2mTip:\u001b[22m When the composer is empty, press Esc to step back and edit your last', timestamp: '2026-03-07T00:00:01.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'message; Enter confirms. Starting MCP servers (0/3): chrome-devtools, codex_apps, playwright (0s esc to interrupt)', timestamp: '2026-03-07T00:00:02.000Z' }),
      JSON.stringify({ type: 'raw-output', text: 'St\nta\nart\nti\nSin\nng\nMCP\nsers', timestamp: '2026-03-07T00:00:03.000Z' }),
      JSON.stringify({ type: 'raw-output', text: '\u001b[32msmoke-ok\u001b[39m', timestamp: '2026-03-07T00:00:04.000Z' }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-2',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test-2',
      tmuxSessionName: 'ac-codex-demo-2',
      status: 'bound',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:04.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session);
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual(['smoke-ok']);
    expect(messages.some((message) => /Tip:|Starting MCP servers/.test(message.text) && message.role !== 'status')).toBe(false);
  });

  it('reads a bounded event-log tail from the next complete JSONL row', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'raw-output',
        text: `This old live output should be outside the bounded tail. old-tail-needle ${'x'.repeat(4000)}`,
        timestamp: '2026-03-07T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Only the recent complete user row should remain.',
        timestamp: '2026-03-07T00:01:00.000Z',
      }),
      JSON.stringify({
        type: 'raw-output',
        text: 'recent bounded tail answer',
        timestamp: '2026-03-07T00:01:01.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-3',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test-3',
      tmuxSessionName: 'ac-codex-demo-3',
      status: 'bound',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:01:01.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session, { maxBytesFromEnd: 512 });
    expect(messages.map((message) => message.text)).toEqual([
      'Only the recent complete user row should remain.',
      'recent bounded tail answer',
    ]);
    expect(messages.some((message) => message.text.includes('old-tail-needle'))).toBe(false);
  });

  it('keeps the latest complete JSONL row when it starts before the bounded tail', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const oversizedRecentText = `recent oversized needle ${'payloadword '.repeat(300)}`;
    await fs.writeFile(eventLogPath, `${JSON.stringify({
      type: 'raw-output',
      text: oversizedRecentText,
      timestamp: '2026-03-07T00:02:00.000Z',
    })}\n`);

    const session: BoundSession = {
      id: 'session-4',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test-4',
      tmuxSessionName: 'ac-codex-demo-4',
      status: 'bound',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:02:00.000Z',
      eventLogPath,
    };

    const messages = await readLiveMessages(session, { maxBytesFromEnd: 512 });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain('recent oversized needle');
  });
});
