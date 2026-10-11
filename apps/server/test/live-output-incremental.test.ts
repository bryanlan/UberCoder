import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { LiveOutputReader } from '../src/sessions/live-output/reader.js';
import { getEventLogReadPlan, readEventLogText, readAppendedEventLogText } from '../src/sessions/live-output/event-log-reader.js';

function event(type: string, text: string, second = 0) {
  return JSON.stringify({ type, text, timestamp: `2026-10-11T10:00:${String(second).padStart(2, '0')}.000Z` }) + '\n';
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-incremental-'));
  const file = path.join(root, 'events.jsonl');
  const session: BoundSession = { id: root, provider: 'claude', projectSlug: 'demo', conversationRef: 'pending:append',
    tmuxSessionName: 'fixture-only', status: 'bound', eventLogPath: file,
    startedAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z' };
  return { file, session, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

it('preserves byte offsets, UTF-8 and sliding-window behavior while appending', async () => {
  const { file, session, cleanup } = await fixture();
  const reader = new LiveOutputReader();
  try {
    await fs.writeFile(file, event('user-input', 'Explain the café result.'));
    let plan = await getEventLogReadPlan(file, { maxBytesFromEnd: 600 });
    let read = await readEventLogText(file, plan);
    for (let i = 1; i <= 12; i++) {
      await fs.appendFile(file, event('raw-output', `Unique café result ${i} is complete.\nShared assistant line.`, i));
      const next = await getEventLogReadPlan(file, { maxBytesFromEnd: 600 });
      const updated = await readAppendedEventLogText(file, next, { plan, read });
      expect(updated).toEqual(await readEventLogText(file, next));
      expect(updated.startOffset).toBe((await fs.readFile(file)).indexOf(Buffer.from(updated.text)));
      expect(await reader.readLiveMessages(session, { maxBytesFromEnd: 600 }))
        .toEqual(await new LiveOutputReader().readLiveMessages(session, { maxBytesFromEnd: 600 }));
      plan = next; read = updated;
    }
  } finally { await cleanup(); }
});

it('keeps many events with shared prompt contexts cached', async () => {
  const { file, session, cleanup } = await fixture();
  const reader = new LiveOutputReader();
  const open = vi.spyOn(fs, 'open');
  try {
    const rows: string[] = [];
    for (let turn = 0; turn < 25; turn++) {
      rows.push(event('user-input', `Turn ${turn}: ${'Detailed prompt context. '.repeat(90)}`));
      for (let line = 0; line < 70; line++) rows.push(event('raw-output', `Completed answer for turn ${turn}, line ${line}.`, 1));
    }
    await fs.writeFile(file, rows.join(''));
    const expected = await reader.readLiveMessages(session, { maxBytesFromEnd: 2 * 1024 * 1024 });
    expect(expected.some((message) => message.role === 'assistant')).toBe(true);
    expect(open).toHaveBeenCalled();
    open.mockClear();
    expect(await reader.readLiveMessages(session, { maxBytesFromEnd: 2 * 1024 * 1024 })).toEqual(expected);
    expect(open).not.toHaveBeenCalled();
  } finally { open.mockRestore(); await cleanup(); }
});

it('reconstructs partial records, truncation and replacement without stale messages', async () => {
  const { file, session, cleanup } = await fixture();
  const reader = new LiveOutputReader();
  try {
    await fs.writeFile(file, event('user-input', 'First turn.'));
    await reader.readLiveMessages(session);
    const next = event('raw-output', 'The first answer is complete.', 1);
    await fs.appendFile(file, next.slice(0, 25));
    expect(await reader.readLiveMessages(session)).toEqual(await new LiveOutputReader().readLiveMessages(session));
    await fs.appendFile(file, next.slice(25));
    expect(await reader.readLiveMessages(session)).toEqual(await new LiveOutputReader().readLiveMessages(session));
    await fs.writeFile(file, event('user-input', 'A replacement turn.'));
    expect(await reader.readLiveMessages(session)).toEqual(await new LiveOutputReader().readLiveMessages(session));
    const replacement = file + '.new';
    await fs.writeFile(replacement, event('user-input', 'A different turn.') + event('status', 'The status stays visible.', 2));
    await fs.rename(replacement, file);
    expect(await reader.readLiveMessages(session)).toEqual(await new LiveOutputReader().readLiveMessages(session));
  } finally { await cleanup(); }
});

it('resets duplicate state per turn and isolates returned message mutations', async () => {
  const { file, session, cleanup } = await fixture();
  const reader = new LiveOutputReader();
  try {
    await fs.writeFile(file, event('user-input', 'First turn.') + event('raw-output', 'Repeated answer line.\nRepeated answer line.', 1));
    const first = await reader.readLiveMessages(session);
    expect(first.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['Repeated answer line.']);
    first[0]!.text = 'External mutation';
    await fs.appendFile(file, event('user-input', 'Second turn.', 2) + event('raw-output', 'Repeated answer line.', 3));
    const result = await reader.readLiveMessages(session);
    expect(result.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['Repeated answer line.', 'Repeated answer line.']);
    expect(result.some((m) => m.text === 'External mutation')).toBe(false);
    reader.clear();
    expect(await reader.readLiveMessages(session)).toEqual(await new LiveOutputReader().readLiveMessages(session));
  } finally { await cleanup(); }
});
