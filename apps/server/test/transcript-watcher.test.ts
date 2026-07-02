import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptWatcherRegistry } from '../src/sessions/transcript-watcher.js';

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for transcript watcher.');
}

describe('TranscriptWatcherRegistry', () => {
  it('emits when the provider transcript changes', async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agent-console-transcript-watcher-'));
    const transcriptPath = path.join(tempDir, 'conversation.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"session_meta"}\n');
    const changes: number[] = [];
    const watcher = new TranscriptWatcherRegistry({ pollIntervalMs: 10 });

    watcher.watch({
      sessionId: 'session-transcript',
      transcriptPath,
      onChange: () => changes.push(Date.now()),
    });

    try {
      expect(changes).toEqual([]);
      fs.appendFileSync(transcriptPath, '{"type":"response_item"}\n');
      await waitFor(() => changes.length === 1);
    } finally {
      watcher.stop('session-transcript');
    }
  });

  it('polls the transcript when fs.watch drops append notifications', async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agent-console-transcript-watcher-'));
    const transcriptPath = path.join(tempDir, 'conversation.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"session_meta"}\n');
    const changes: number[] = [];
    const watcher = new TranscriptWatcherRegistry({ pollIntervalMs: 10 });
    const watchSpy = vi.spyOn(fs, 'watch').mockReturnValue({
      close: vi.fn(),
    } as unknown as fs.FSWatcher);

    watcher.watch({
      sessionId: 'session-transcript-poll',
      transcriptPath,
      onChange: () => changes.push(Date.now()),
    });

    try {
      fs.appendFileSync(transcriptPath, '{"type":"task_complete"}\n');
      await waitFor(() => changes.length === 1);
    } finally {
      watcher.stop('session-transcript-poll');
      watchSpy.mockRestore();
    }
  });
});
