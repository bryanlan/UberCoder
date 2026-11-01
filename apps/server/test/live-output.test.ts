import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { LiveOutputReader } from '../src/sessions/live-output/reader.js';

const liveOutputReader = new LiveOutputReader();
const readLiveMessages = liveOutputReader.readLiveMessages.bind(liveOutputReader);

// The live rows of a bound session come from its event log: the person's messages and the Console's status lines.
// `live-output-incremental` covers the append-only reuse and which event types become rows.
describe('readLiveMessages', () => {
  it('keeps live message ids stable when the event-log tail window shifts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    const rows = [
      JSON.stringify({ type: 'user-input', text: 'summarize the result', timestamp: '2026-07-01T02:00:00.000Z' }),
      JSON.stringify({ type: 'status', text: 'The result is stable.', timestamp: '2026-07-01T02:00:01.000Z' }),
      JSON.stringify({ type: 'status', text: 'Bound claude session in Demo.', timestamp: '2026-07-01T02:00:02.000Z' }),
    ];
    await fs.writeFile(eventLogPath, `${rows.join('\n')}\n`);
    const targetOffset = Buffer.byteLength(`${rows[0]}\n`, 'utf8');

    const session: BoundSession = {
      id: 'session-stable-offset',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:stable-offset',
      status: 'bound',
      startedAt: '2026-07-01T02:00:00.000Z',
      updatedAt: '2026-07-01T02:00:02.000Z',
      eventLogPath,
    };

    const fullMessages = await readLiveMessages(session);
    const tailMessages = await readLiveMessages(session, {
      maxBytesFromEnd: Buffer.byteLength(`${rows[1]}\n${rows[2]}\n`, 'utf8') + 4,
    });
    const fullAssistant = fullMessages.find((message) => message.text === 'The result is stable.');
    const tailAssistant = tailMessages.find((message) => message.text === 'The result is stable.');

    expect(fullAssistant?.id).toBe(`live:${session.id}:${targetOffset}`);
    expect(tailAssistant?.id).toBe(fullAssistant?.id);
  });

  it('reads a bounded event-log tail from the next complete JSONL row', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-live-output-'));
    const eventLogPath = path.join(tempDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: `This old live output should be outside the bounded tail. old-tail-needle ${'x'.repeat(4000)}`,
        timestamp: '2026-03-07T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: 'Only the recent complete user row should remain.',
        timestamp: '2026-03-07T00:01:00.000Z',
      }),
      JSON.stringify({
        type: 'status',
        text: 'recent bounded tail answer',
        timestamp: '2026-03-07T00:01:01.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-3',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:test-3',
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
    await fs.writeFile(eventLogPath, [
      JSON.stringify({
        type: 'user-input',
        text: 'An earlier message.',
        timestamp: '2026-03-07T00:01:59.000Z',
      }),
      JSON.stringify({
        type: 'user-input',
        text: oversizedRecentText,
        timestamp: '2026-03-07T00:02:00.000Z',
      }),
    ].join('\n'));

    const session: BoundSession = {
      id: 'session-4',
      provider: 'claude',
      projectSlug: 'demo',
      conversationRef: 'pending:test-4',
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
