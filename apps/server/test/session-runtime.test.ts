import { describe, expect, it } from 'vitest';
import { SessionRuntimeRegistry, type SlowSessionCommandEvent } from '../src/sessions/session-runtime.js';

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
    expect(warnings[0]?.elapsedMs).toBeGreaterThan(0);

    release.resolve();
    await expect(command).resolves.toBe('done');
  });

  it('runs the commands of one session one after another, in the order they were queued', async () => {
    const registry = new SessionRuntimeRegistry();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const events: string[] = [];
    const first = registry.run('session-1', 'first', async () => {
      events.push('start:first');
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push('end:first');
    });
    const second = registry.run('session-1', 'second', async () => { events.push('start:second'); });
    const other = registry.run('session-2', 'other', async () => { events.push('start:other'); });
    await firstStarted.promise;
    await other;
    expect(events).toEqual(['start:first', 'start:other']);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['start:first', 'start:other', 'end:first', 'start:second']);
  });
});
