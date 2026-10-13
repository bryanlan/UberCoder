import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '@agent-console/shared';
import { WorkerOpeningMessages } from '../src/workers/opening-message.js';
import { normalizeComparableText, stableTextHash } from '../src/lib/text.js';
import { PEER_WAKE_PROMPT } from '../src/coordination/wake.js';
import { imagePromptSuffix } from '../src/images/prompt.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const codex = (text: string, role = 'user') => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
const claude = (text: string, extra = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
async function fixture(provider: 'codex' | 'claude', text: string, records: unknown[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-opening-')); directories.push(directory);
  const file = path.join(directory, 'transcript.jsonl');
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const summary: ConversationSummary = { ref: 'native', kind: 'history', projectSlug: 'demo', provider,
    title: `${text.slice(0, 285)}…`, updatedAt: new Date().toISOString(), transcriptPath: file,
    isBound: true, degraded: false, rawMetadata: { firstUserTextHash: stableTextHash(normalizeComparableText(text)) } };
  return { file, summary, reader: new WorkerOpeningMessages() };
}

it('returns complete Codex opening text while excluding instructions, peer wakes and assistant copies', async () => {
  const text = 'The complete first message '.repeat(30) + '\nIts final paragraph must remain visible.';
  const f = await fixture('codex', text, [codex('# AGENTS.md instructions for /tmp/demo'), codex(PEER_WAKE_PROMPT),
    codex(text, 'assistant'), codex(text)]);
  expect(await f.reader.read(f.summary)).toEqual({ text, error: null });
});

it('matches the indexed Claude opening hash across branches and restores bracketed paste text', async () => {
  const text = 'Full pasted opening text '.repeat(30);
  const f = await fixture('claude', text, [claude('A different branch opening.'), claude(text, { isCompactSummary: true }),
    claude('<local-command-stdout>ignore this</local-command-stdout>'),
    claude(`<pasted_content id="fixture">\n${text}\n</pasted_content id="fixture">`)]);
  expect(await f.reader.read(f.summary)).toEqual({ text, error: null });
});

it('strips private image transport without losing the full caption', async () => {
  const caption = 'The complete image caption '.repeat(20);
  const text = caption + imagePromptSuffix([{ id: '00000000-0000-4000-8000-000000000001', mediaType: 'image/png',
    name: 'image.png', sizeBytes: 100, width: 10, height: 10, path: '/private/image.png' }], 'codex');
  const f = await fixture('codex', text, [codex(text)]);
  expect(await f.reader.read(f.summary)).toEqual({ text: caption.trimEnd(), error: null });
});

it('shares an in-flight head read and caches immutable opening text across transcript appends', async () => {
  const text = 'An immutable opening message.'; const f = await fixture('codex', text, [codex(text)]);
  const scan = vi.spyOn(f.reader as unknown as { scan(...args: unknown[]): Promise<unknown> }, 'scan');
  expect(await Promise.all([f.reader.read(f.summary), f.reader.read(f.summary)])).toEqual([{ text, error: null }, { text, error: null }]);
  await fs.appendFile(f.file, JSON.stringify(codex('A later user message.')) + '\n');
  expect((await f.reader.read(f.summary)).text).toBe(text); expect(scan).toHaveBeenCalledTimes(1);
});

it('returns unavailable to both callers when a shared read fails', async () => {
  const f = await fixture('codex', 'An opening message.', []);
  let fail!: (error: Error) => void;
  vi.spyOn(f.reader as unknown as { scan(...args: unknown[]): Promise<unknown> }, 'scan')
    .mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const reads = [f.reader.read(f.summary), f.reader.read(f.summary)];
  await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  fail(new Error('Transcript vanished during the read.'));
  expect(await Promise.all(reads)).toEqual([
    { text: null, error: 'The complete opening message is unavailable.' },
    { text: null, error: 'The complete opening message is unavailable.' },
  ]);
});

it('stops at the8MiB head limit without returning partial or unrelated text', async () => {
  const text = 'An opening beyond the bounded head.';
  const f = await fixture('codex', text, [{ type: 'padding', value: 'x'.repeat(8 * 1024 * 1024) }, codex(text)]);
  expect(await f.reader.read(f.summary)).toEqual({ text: null, error: 'The complete opening message is unavailable.' });
});

it('does not cache unavailable results before the opening record finishes writing', async () => {
  const text = 'An opening that finishes writing later.'; const f = await fixture('codex', text, []);
  expect((await f.reader.read(f.summary)).text).toBeNull();
  await fs.appendFile(f.file, JSON.stringify(codex(text)) + '\n');
  expect((await f.reader.read(f.summary)).text).toBe(text);
});
