import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionRuntimeRegistry, type SlowSessionCommandEvent } from '../src/sessions/session-runtime.js';
import { FakeTmux, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('Session runtime queue', () => {
  it('reports commands that remain queued in-flight past the watchdog threshold', async () => {
    const started = deferred();
    const release = deferred();
    const warnings: SlowSessionCommandEvent[] = [];
    const registry = new SessionRuntimeRegistry({
      slowCommandMs: 10,
      onSlowCommand: (event) => warnings.push(event),
    });

    const command = registry.run('session-1', 'slow-command', async () => {
      started.resolve();
      await release.promise;
      return 'done';
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      sessionId: 'session-1',
      label: 'slow-command',
    });
    expect(warnings[0]?.elapsedMs).toBeGreaterThanOrEqual(10);

    release.resolve();
    await expect(command).resolves.toBe('done');
  });

  it('serializes mutating sends for the same session', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-runtime-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const firstWrite = deferred();
    const firstStarted = deferred();
    const events: string[] = [];
    class BlockingTmux extends FakeTmux {
      override async sendLiteralText(sessionName: string, text: string): Promise<void> {
        events.push(`start:${text}`);
        if (text === 'first') {
          firstStarted.resolve();
          await firstWrite.promise;
        }
        await super.sendLiteralText(sessionName, text);
        events.push(`end:${text}`);
      }
    }
    const tmux = new BlockingTmux();
    const manager = createRecoveryManager(db, tmux, tempDir, new RealtimeEventBus());

    try {
      const session = await manager.bindConversation({
        project,
        provider,
        providerSettings,
        conversationRef: 'runtime-queue',
        title: 'Runtime queue',
        kind: 'history',
      });

      const first = manager.sendKeystrokes(session.id, { text: 'first', deferScreenUpdate: true });
      await firstStarted.promise;
      const second = manager.sendKeystrokes(session.id, { text: 'second', deferScreenUpdate: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(['start:first']);

      firstWrite.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    } finally {
      manager.stop();
      db.close();
    }
  });
});
