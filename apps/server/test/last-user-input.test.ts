import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LastUserInputCache, readLastUserInput } from '../src/sessions/last-user-input.js';

describe('last recorded user input', () => {
  it('restores the last prompt beyond a large output tail, preserving Unicode and malformed-line handling', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'last-user-input-'));
    try {
      const file = path.join(dir, 'events.jsonl');
      const prompt = 'Check the café and 中文\nthen reply.';
      const output = `${JSON.stringify({ type: 'raw-output', text: 'x'.repeat(8192) })}\n`;
      await fs.writeFile(file, `${JSON.stringify({ type: 'user-input', text: 'old' })}\n`
        + `${JSON.stringify({ type: 'user-input', text: prompt })}\r\n` + output.repeat(1024) + 'null\n{"broken":');
      expect(await readLastUserInput(file)).toBe(prompt);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loads history once for concurrent output and uses subsequent recorded input without rereading it', async () => {
    const load = vi.fn(async () => 'restored');
    const cache = new LastUserInputCache(load);
    expect(await Promise.all([cache.read('/events'), cache.read('/events')])).toEqual(['restored', 'restored']);
    cache.record('/events', 'new prompt');
    expect(await cache.read('/events')).toBe('new prompt');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite input recorded during history restoration or return the older value to waiters', async () => {
    let finish!: (text: string) => void;
    const cache = new LastUserInputCache(() => new Promise(resolve => { finish = resolve; }));
    const waiting = cache.read('/events');
    cache.record('/events', 'new prompt');
    finish('old prompt');
    expect(await waiting).toBe('new prompt');
    expect(await cache.read('/events')).toBe('new prompt');
  });

  it('retries a transient read failure and keeps another event log separate', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('temporary read error'))
      .mockResolvedValueOnce('recovered').mockResolvedValueOnce('different prompt');
    const cache = new LastUserInputCache(load);
    expect(await cache.read('/events')).toBeUndefined();
    expect(await cache.read('/events')).toBe('recovered');
    expect(await cache.read('/other')).toBe('different prompt');
    expect(load).toHaveBeenCalledTimes(3);
  });
});
