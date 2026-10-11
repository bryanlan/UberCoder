import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as codexParser from '../src/providers/transcripts/codex.js';
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
  afterEach(() => vi.restoreAllMocks());

  it('warms stale reads while a newer large-transcript parse is still running', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-cache-warming-'));
    const file = path.join(root, 'history.jsonl');
    await fs.writeFile(file, codexUserMessage('Earlier completed evidence', '2026-10-11T10:00:00.000Z') + '\n');
    const summary = summaryFor(file, 'warm-during-newer-parse');
    const original = codexParser.parseCodexConversationFile;
    const parsed = await original({ filePath: file, provider: 'codex', projectSlug: summary.projectSlug,
      conversationRef: summary.ref, collectPathMetadata: false });
    await fs.truncate(file, 8 * 1024 * 1024);
    let releaseOlder!: () => void;
    let releaseNewer!: () => void;
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const newerGate = new Promise<void>((resolve) => { releaseNewer = resolve; });
    const spy = vi.spyOn(codexParser, 'parseCodexConversationFile')
      .mockImplementationOnce(async () => { await olderGate; return parsed; })
      .mockImplementation(async () => { await newerGate; return parsed; });
    try {
      const older = loadProviderConversationFromSummary(summary, { allowStaleWhileChanging: true });
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      await fs.appendFile(file, '\n');
      const newer = loadProviderConversationFromSummary(summary, { allowStaleWhileChanging: true });
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
      releaseOlder();
      const warmed = await older;
      const staleRead = loadProviderConversationFromSummary(summary, { allowStaleWhileChanging: true });
      expect(await Promise.race([staleRead, new Promise((resolve) => setTimeout(() => resolve('blocked'), 100))]))
        .toBe(warmed);
      expect(spy).toHaveBeenCalledTimes(2);
      releaseNewer();
      const fresh = await newer;
      expect(await loadProviderConversationFromSummary(summary)).toBe(fresh);
    } finally { releaseOlder(); releaseNewer(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it('shares concurrent loads and releases failed in-flight parses for retry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-cache-shared-'));
    const file = path.join(root, 'history.jsonl');
    await fs.writeFile(file, codexUserMessage('Concurrent evidence', '2026-10-11T10:00:00.000Z') + '\n');
    const summary = summaryFor(file, 'concurrent-evidence');
    const original = codexParser.parseCodexConversationFile;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(codexParser, 'parseCodexConversationFile').mockImplementation(async (input) => {
      await gate;
      return original(input);
    });
    try {
      const reads = Promise.all(Array.from({ length: 3 }, () => loadProviderConversationFromSummary(summary)));
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      release();
      const loaded = await reads;
      expect(loaded[0]).not.toBeNull();
      expect(loaded.every((result) => result === loaded[0])).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      await fs.appendFile(file, codexUserMessage('Retry evidence', '2026-10-11T10:01:00.000Z') + '\n');
      spy.mockRejectedValueOnce(new Error('Transient fixture failure'));
      expect(await loadProviderConversationFromSummary(summary)).toBeNull();
      expect((await loadProviderConversationFromSummary(summary))?.messages.at(-1)?.text).toBe('Retry evidence');
    } finally { release(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it('does not let an older parse replace a newer file fingerprint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-cache-race-'));
    const file = path.join(root, 'history.jsonl');
    await fs.writeFile(file, codexUserMessage('Older evidence', '2026-10-11T10:00:00.000Z') + '\n');
    const summary = summaryFor(file, 'fingerprint-race');
    const original = codexParser.parseCodexConversationFile;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let parsedOlder = false;
    vi.spyOn(codexParser, 'parseCodexConversationFile').mockImplementationOnce(async (input) => {
      const result = await original(input);
      parsedOlder = true;
      await gate;
      return result;
    });
    try {
      const older = loadProviderConversationFromSummary(summary);
      await vi.waitFor(() => expect(parsedOlder).toBe(true));
      await fs.appendFile(file, codexUserMessage('Newer evidence', '2026-10-11T10:01:00.000Z') + '\n');
      const newer = await loadProviderConversationFromSummary(summary);
      expect(newer?.messages.at(-1)?.text).toBe('Newer evidence');
      release();
      expect((await older)?.messages.at(-1)?.text).toBe('Older evidence');
      expect(await loadProviderConversationFromSummary(summary)).toBe(newer);
    } finally { release(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it('invalidates a replaced file even when its length and modification time match', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-cache-replace-'));
    const file = path.join(root, 'history.jsonl');
    const summary = summaryFor(file, 'replaced-evidence');
    try {
      await fs.writeFile(file, codexUserMessage('Old evidence', '2026-10-11T10:00:00.000Z') + '\n');
      const stat = await fs.stat(file);
      expect((await loadProviderConversationFromSummary(summary))?.messages.at(-1)?.text).toBe('Old evidence');
      const replacement = file + '.new';
      await fs.writeFile(replacement, codexUserMessage('New evidence', '2026-10-11T10:00:00.000Z') + '\n');
      await fs.utimes(replacement, stat.atime, stat.mtime);
      await fs.rename(replacement, file);
      expect((await loadProviderConversationFromSummary(summary))?.messages.at(-1)?.text).toBe('New evidence');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
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
