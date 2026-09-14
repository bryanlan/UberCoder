import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import type { ProviderRunState } from '../src/providers/types.js';
import { RunRecovery } from '../src/sessions/run-recovery.js';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-14T15:00:00Z'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-recovery-'));
  const db = new AppDatabase(path.join(dir, 'test.sqlite'));
  const session: BoundSession = { id: 's1', provider: 'codex', projectSlug: 'demo', conversationRef: 'c1', tmuxSessionName: 'ac-s1', status: 'bound', shouldRestore: true, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isWorking: true };
  db.boundSessions.upsert(session);
  let run: ProviderRunState | undefined;
  let queue = Promise.resolve();
  const submit = vi.fn(async (_session: BoundSession, _text: string) => {});
  const canRetry = vi.fn(async (): Promise<string | undefined> => undefined);
  const publish = vi.fn(); const onError = vi.fn();
  const options = { db, submit, canRetry, publish, onError, delaysMs: [10, 20, 30], runExclusive: (_id: string, fn: () => Promise<void>) => { queue = queue.then(fn); return queue; } };
  let recovery = new RunRecovery(options);
  const watch = () => recovery.watch(session.id, 'transcript', () => ({ read: async () => run }));
  watch();
  const settle = async () => { await queue; await Promise.resolve(); await queue; };
  const setRun = async (status: ProviderRunState['status'], turnId = 'turn1', code = 'server_overloaded', timestamp = new Date().toISOString()) => {
    run = { turnId, status, timestamp, startedAt: timestamp, error: status === 'failed' ? { code, message: 'Selected model is at capacity.' } : undefined };
    recovery.changed(session.id); await settle();
  };
  const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };
  const failure = () => db.boundSessions.getById(session.id)?.runFailure;
  cleanups.push(() => { recovery.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, session, submit, canRetry, publish, onError, failure, setRun, advance, settle,
    cancel: () => recovery.cancel(session.id),
    restart: async () => { recovery.stop(); recovery = new RunRecovery(options); watch(); await settle(); },
    setUnreadRun: (value: ProviderRunState) => { run = value; },
  };
}

describe('Bounded provider failure recovery', () => {
  it('shows the exact error and submits one continuation after the delay', async () => {
    const f = fixture(); await f.setRun('failed');
    expect(f.failure()).toMatchObject({ status: 'scheduled', attempts: 0, maxAttempts: 3, message: 'Selected model is at capacity.' });
    expect(f.db.boundSessions.getById('s1')?.isWorking).toBe(false);
    await f.advance(9); expect(f.submit).not.toHaveBeenCalled();
    await f.advance(1); expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0]?.[1]).toContain('Do not replay completed commands');
    expect(f.failure()).toMatchObject({ status: 'retrying', attempts: 1 });
    await f.setRun('failed'); await f.advance(20); expect(f.submit).toHaveBeenCalledOnce();
  });

  it.each(['misalignment_policy_violation', 'unauthorized', 'usage_limit', 'unknown'])('never retries %s even when its message mentions capacity', async code => {
    const f = fixture(); await f.setRun('failed', 'turn1', code); await f.advance(60_000);
    expect(f.failure()?.status).toBe('stopped'); expect(f.submit).not.toHaveBeenCalled();
  });

  it('keeps historical failures visible without resuming old work', async () => {
    const f = fixture(); await f.setRun('failed', 'old', 'server_overloaded', '2026-09-14T14:00:00Z'); await f.advance(60_000);
    expect(f.failure()?.status).toBe('stopped'); expect(f.submit).not.toHaveBeenCalled();
  });

  it('stops after three retries across successive failed turns', async () => {
    const f = fixture(); await f.setRun('failed');
    for (let i = 0; i < 3; i++) {
      await f.advance([10, 20, 30][i]!);
      await f.setRun('running', `retry${i}`);
      await f.advance(1); await f.setRun('failed', `retry${i}`);
    }
    expect(f.submit).toHaveBeenCalledTimes(3);
    expect(f.failure()).toMatchObject({ status: 'stopped', attempts: 3 });
    await f.advance(60_000); expect(f.submit).toHaveBeenCalledTimes(3);
  });

  it('preserves a scheduled retry budget across a server restart', async () => {
    const f = fixture(); await f.setRun('failed'); await f.advance(10);
    await f.setRun('running', 'retry1'); await f.advance(1); await f.setRun('failed', 'retry1');
    await f.restart(); await f.advance(20);
    expect(f.submit).toHaveBeenCalledTimes(2); expect(f.failure()?.attempts).toBe(2);
  });

  it('does not resend an uncertain submission after restart', async () => {
    const f = fixture(); await f.setRun('failed'); await f.advance(10); await f.restart(); await f.advance(60_000);
    expect(f.failure()?.status).toBe('stopped'); expect(f.submit).toHaveBeenCalledOnce();
  });

  it('cancels on user input and rejects a failure from the cancelled turn', async () => {
    const f = fixture(); await f.setRun('failed'); f.cancel(); await f.advance(60_000);
    expect(f.submit).not.toHaveBeenCalled(); expect(f.failure()?.status).toBe('stopped');
    await f.setRun('running', 'next'); await f.advance(1); await f.setRun('failed', 'next');
    expect(f.failure()?.status).toBe('scheduled');
  });

  it('cancellation during an asynchronous ownership check prevents submission', async () => {
    const f = fixture(); await f.setRun('failed');
    f.canRetry.mockImplementationOnce(async () => { f.cancel(); return undefined; });
    await f.advance(10); expect(f.submit).not.toHaveBeenCalled();
  });

  it('rechecks provider state before retrying if a manual turn started', async () => {
    const f = fixture(); await f.setRun('failed');
    f.setUnreadRun({ turnId: 'manual', status: 'running', timestamp: new Date().toISOString() });
    await f.advance(10); expect(f.submit).not.toHaveBeenCalled(); expect(f.failure()).toBeUndefined();
  });

  it('does not borrow an older timer to submit a newly discovered failure early', async () => {
    const f = fixture(); await f.setRun('failed');
    f.setUnreadRun({ turnId: 'new-failure', status: 'failed', timestamp: new Date().toISOString(), error: { code: 'server_overloaded', message: 'Capacity' } });
    await f.advance(10); expect(f.submit).not.toHaveBeenCalled();
    await f.advance(10); expect(f.submit).toHaveBeenCalledOnce();
  });

  it('stops on lost ownership, a busy provider, or an unsent draft', async () => {
    const f = fixture(); f.canRetry.mockResolvedValue('The provider has an unsent draft.'); await f.setRun('failed'); await f.advance(10);
    expect(f.failure()).toMatchObject({ status: 'stopped', stoppedReason: 'The provider has an unsent draft.' }); expect(f.submit).not.toHaveBeenCalled();
  });

  it('does not submit when a suspended host wakes after the recovery window', async () => {
    const f = fixture(); await f.setRun('failed');
    vi.setSystemTime(Date.now() + 20 * 60_000);
    await f.advance(10);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.failure()).toMatchObject({ status: 'stopped', attempts: 0, stoppedReason: 'The recovery window expired.' });
    expect(f.failure()?.nextRetryAt).toBeUndefined();
  });

  it('rechecks expiry after asynchronous readiness checks', async () => {
    const f = fixture(); await f.setRun('failed');
    f.canRetry.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      return undefined;
    });
    await f.advance(10);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.failure()?.stoppedReason).toBe('The recovery window expired.');
  });

  it('does not replay an ambiguous transport failure', async () => {
    const f = fixture(); f.submit.mockRejectedValueOnce(new Error('transport closed')); await f.setRun('failed'); await f.advance(60_000);
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.failure()?.status).toBe('stopped'); expect(f.onError).toHaveBeenCalledOnce();
  });

  it('stops when the provider never acknowledges the continuation', async () => {
    const f = fixture(); await f.setRun('failed'); await f.advance(30_010);
    expect(f.failure()?.stoppedReason).toContain('did not acknowledge'); expect(f.submit).toHaveBeenCalledOnce();
  });

  it('clears a recovered failure after successful completion', async () => {
    const f = fixture(); await f.setRun('failed'); await f.advance(10); await f.setRun('running', 'retry1'); await f.setRun('completed', 'retry1');
    expect(f.failure()).toBeUndefined();
  });

  it('ordinary session status writes cannot erase the persisted recovery budget', async () => {
    const f = fixture(); await f.setRun('failed'); await f.advance(10); f.db.boundSessions.upsert(f.session);
    expect(f.failure()?.attempts).toBe(1);
  });
});
