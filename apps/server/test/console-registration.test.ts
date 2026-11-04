import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService, processStart } from '../src/coordination/service.js';
import { registerConsoleConversation } from '../src/coordination/console-registration.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function sleeper(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (!child.pid) throw new Error('The sleeper process did not start.');
  return {
    pid: child.pid,
    stop: () => {
      child.kill('SIGKILL');
    },
  };
}

function waitUntilGone(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (!processStart(pid)) { resolve(); return; }
      if (Date.now() - started > 2000) { reject(new Error(`process ${pid} is still alive`)); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('Console-side Vibe registration', () => {
  it('registers a new conversation, then keeps the same credential when a new process resumes it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-registration-'));
    const db = new AppDatabase(path.join(root, 'state.sqlite'));
    const service = new CoordinationService(db, { enabled: true, pilotPaths: [] });
    cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const nativeSessionId = randomUUID();
    const cwd = root;
    const first = sleeper();
    cleanups.push(() => first.stop());
    const started = registerConsoleConversation(service, root, {
      provider: 'vibe', nativeSessionId, conversationId: 'conversation-1', cwd, pid: first.pid, fresh: true,
    });
    expect(started.startupContext?.startsWith('[Agent Console coordination — session start]\n')).toBe(true);
    const key = createHash('sha256').update(`vibe:${nativeSessionId}`).digest('hex');
    const statePath = path.join(root, 'coordination', 'clients', `${key}.json`);
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { token: string; assignmentId: string; ownerPid: number };
    expect(saved.ownerPid).toBe(first.pid);
    expect(fs.existsSync(path.join(root, 'coordination', 'owners', `${first.pid}-${processStart(first.pid)}.json`))).toBe(true);
    service.authenticate(saved.assignmentId, saved.token);

    first.stop();
    await waitUntilGone(first.pid);
    const second = sleeper();
    cleanups.push(() => second.stop());
    const resumed = registerConsoleConversation(service, root, {
      provider: 'vibe', nativeSessionId, conversationId: 'conversation-1', cwd, pid: second.pid, fresh: false,
    });
    expect(resumed.startupContext).toBeUndefined();
    const rewritten = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { token: string; ownerPid: number };
    expect(rewritten.token).toBe(saved.token);
    expect(rewritten.ownerPid).toBe(second.pid);
    expect(fs.existsSync(path.join(root, 'coordination', 'owners', `${second.pid}-${processStart(second.pid)}.json`))).toBe(true);
    service.authenticate(saved.assignmentId, saved.token);
  });
});
