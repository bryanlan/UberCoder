import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OutputWatcherRegistry } from '../src/sessions/output-watcher.js';

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for output watcher.');
}

describe('OutputWatcherRegistry', () => {
  it('emits appended chunks after the configured initial offset', async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agent-console-output-watcher-'));
    const rawLogPath = path.join(tempDir, 'raw.log');
    fs.writeFileSync(rawLogPath, 'existing output\n');
    const initialOffset = fs.statSync(rawLogPath).size;
    const chunks: string[] = [];
    const watcher = new OutputWatcherRegistry();

    watcher.watch({
      sessionId: 'session-output',
      rawLogPath,
      initialOffset,
      onChunk: (chunk) => chunks.push(chunk),
    });

    try {
      fs.appendFileSync(rawLogPath, 'new output\n');
      await waitFor(() => chunks.length === 1);
      expect(chunks).toEqual(['new output\n']);
    } finally {
      watcher.stop('session-output');
    }
  });

  it('polls the raw log when fs.watch drops append notifications', async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agent-console-output-watcher-'));
    const rawLogPath = path.join(tempDir, 'raw.log');
    fs.writeFileSync(rawLogPath, 'existing output\n');
    const initialOffset = fs.statSync(rawLogPath).size;
    const chunks: string[] = [];
    const watcher = new OutputWatcherRegistry({ pollIntervalMs: 10 });
    const watchSpy = vi.spyOn(fs, 'watch').mockReturnValue({
      close: vi.fn(),
    } as unknown as fs.FSWatcher);

    watcher.watch({
      sessionId: 'session-output-poll',
      rawLogPath,
      initialOffset,
      onChunk: (chunk) => chunks.push(chunk),
    });

    try {
      fs.appendFileSync(rawLogPath, 'late answer after missed watch event\n');
      await waitFor(() => chunks.length === 1);
      expect(chunks).toEqual(['late answer after missed watch event\n']);
    } finally {
      watcher.stop('session-output-poll');
      watchSpy.mockRestore();
    }
  });
});
