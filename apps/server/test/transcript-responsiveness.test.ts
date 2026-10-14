import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as base from '../src/providers/transcripts/base.js';
import { parseClaudeConversationFile } from '../src/providers/transcripts/claude.js';

it('keeps coordination timers responsive through an expensive Claude metadata discovery pass', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-responsiveness-'));
  const filePath = path.join(root, 'history.jsonl');
  const record = JSON.stringify({ type: 'progress', cwd: root, data: { text: 'Private discovery fixture.' } });
  await fs.writeFile(filePath, (record + '\n').repeat(700));
  // Model the synchronous metadata cost measured in large real transcripts.
  // The parse result and path discovery still use the real implementation.
  const collect = base.collectProjectPaths;
  const slow = vi.spyOn(base, 'collectProjectPaths').mockImplementation((...args) => {
    const until = performance.now() + 1;
    while (performance.now() < until) { /* Controlled CPU work on the server thread. */ }
    return collect(...args);
  });
  let last = performance.now(), largestGap = 0, samples = 0;
  const timer = setInterval(() => {
    const now = performance.now(); largestGap = Math.max(largestGap, now - last); last = now; samples++;
  }, 10);
  try {
    const parsed = await parseClaudeConversationFile({ filePath, provider: 'claude', projectSlug: 'fixture', conversationRef: 'private' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(parsed.projectPaths.has(root)).toBe(true);
    expect(samples).toBeGreaterThan(10);
    expect(largestGap).toBeLessThan(200);
  } finally { clearInterval(timer); slow.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});
