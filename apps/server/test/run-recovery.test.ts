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
function fixture(provider: BoundSession['provider'] = 'codex') {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-14T15:00:00Z'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-recovery-'));
  const db = new AppDatabase(path.join(dir, 'test.sqlite'));
  const session: BoundSession = { id: 's1', provider, projectSlug: 'demo', conversationRef: 'c1', tmuxSessionName: 'ac-s1', status: 'bound', shouldRestore: true, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isWorking: true };
  db.boundSessions.upsert(session);
  let run: ProviderRunState | undefined;
  let queue = Promise.resolve();
  const submit = vi.fn(async (_session: BoundSession, _text: string, _isCurrent: () => boolean) => {});
  const canRetry = vi.fn(async (): Promise<string | undefined> => undefined);
  const publish = vi.fn(); const onError = vi.fn(); const mayRecover = vi.fn(() => true);
  const options = { db, submit, canRetry, mayRecover, publish, onError, delaysMs: [10, 20, 30], runExclusive: (_id: string, fn: () => Promise<void>) => { queue = queue.then(fn); return queue; } };
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
  return { db, session, submit, canRetry, mayRecover, publish, onError, failure, setRun, advance, settle,
    budget: () => JSON.parse(db.meta.get("run-recovery-budget:s1") || "null"),
    getRun: () => run!,
    confirmReady: (completed = run!) => {
      db.boundSessions.upsert({ ...db.boundSessions.getById(session.id)!, lastResponseAt: completed.timestamp });
      recovery.confirmCompletion(session.id, completed);
    },
    cancel: () => recovery.cancel(session.id),
    processExited: async () => { await recovery.processExited(session.id); await settle(); },
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

  it.each(['codex', 'claude'] as const)('never retries %s without explicit unattended permission', async provider => {
    const f = fixture(provider); f.mayRecover.mockReturnValue(false); await f.setRun('failed'); await f.advance(60_000);
    expect(f.failure()).toMatchObject({ status: 'stopped', attempts: 0, stoppedReason: 'Unattended recovery is disabled for this session.' });
    expect(f.submit).not.toHaveBeenCalled();
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

  it('keeps the Claude retry ceiling through provisional end_turn and Stop-hook continuation, including restart', async () => {
    const f = fixture('claude'); await f.setRun('failed');
    for (let i = 0; i < 3; i++) {
      await f.advance([10, 20, 30][i]!);
      const turn = `retry${i}`;
      await f.setRun('running', turn);
      await f.advance(1); await f.setRun('completed', turn);
      expect(f.failure()).toBeUndefined();
      expect(f.budget()).toMatchObject({ status: 'retrying', attempts: i + 1 });
      if (i === 0) {
        await f.restart();
        expect(f.failure()).toBeUndefined();
        expect(f.budget()).toMatchObject({ status: 'retrying', attempts: 1 });
      }
      await f.advance(1); await f.setRun('running', turn);
      await f.advance(1); await f.setRun('failed', turn);
    }
    await f.advance(60_000);
    expect(f.submit).toHaveBeenCalledTimes(3);
    expect(f.failure()).toMatchObject({ status: 'stopped', attempts: 3 });
    expect(f.submit.mock.calls.map(call => call[1].match(/Recovery attempt (\d)/)?.[1])).toEqual(['1', '2', '3']);
  });

  it('clears the Claude budget only after confirmed completion', async () => {
    const f = fixture('claude'); await f.setRun('failed'); await f.advance(10);
    await f.setRun('running', 'retry1'); await f.advance(1); await f.setRun('completed', 'retry1');
    expect(f.failure()).toBeUndefined();
    expect(f.budget()).toMatchObject({ status: 'retrying', attempts: 1 });
    f.confirmReady(); expect(f.failure()).toBeUndefined();
    await f.advance(1); await f.setRun('failed', 'next-task');
    expect(f.failure()).toMatchObject({ status: 'scheduled', attempts: 0 });
  });

  it('rejects stale completion confirmation after a Stop-hook continuation fails', async () => {
    const f = fixture('claude'); await f.setRun('failed'); await f.advance(10);
    await f.setRun('running', 'retry1'); await f.advance(1); await f.setRun('completed', 'retry1');
    const provisional = f.getRun();
    await f.advance(1); await f.setRun('running', 'retry1');
    await f.advance(1); await f.setRun('failed', 'retry1');
    f.confirmReady(provisional);
    expect(f.failure()).toMatchObject({ status: 'scheduled', attempts: 1 });
    await f.advance(20); expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.failure()).toMatchObject({ status: 'retrying', attempts: 2 });
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

  it('keeps cancellation of the running turn across backend restart', async () => {
    const f = fixture(); await f.setRun('running'); f.cancel(); await f.advance(100);
    await f.restart(); await f.setRun('failed'); await f.advance(60_000);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.failure()?.stoppedReason).toBe('Automatic recovery was cancelled for this turn.');
  });

  it('admits the native transient server error and respects the same retry ceiling', async () => {
    const f = fixture(); await f.setRun('failed', 'turn1', 'server_unavailable'); await f.advance(10);
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.failure()).toMatchObject({ status: 'retrying', attempts: 1 });
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

  it('keeps cancellation authoritative while transport is in progress', async () => {
    const f = fixture();
    f.submit.mockImplementationOnce(async (_session, _text, isCurrent) => {
      expect(isCurrent()).toBe(true); f.cancel(); expect(isCurrent()).toBe(false);
      throw new Error('Cancelled during text entry');
    });
    await f.setRun('failed'); await f.advance(60_000);
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.failure()?.stoppedReason).toBe('Automatic recovery cancelled by user input or Stop.');
  });

  it('stops when the provider never acknowledges the continuation', async () => {
    const f = fixture(); await f.setRun('failed'); await f.advance(30_010);
    expect(f.failure()?.stoppedReason).toContain('did not acknowledge'); expect(f.submit).toHaveBeenCalledOnce();
  });

  it('clears a recovered failure after successful completion', async () => {
    const f = fixture(); await f.setRun('failed'); await f.advance(10); await f.setRun('running', 'retry1'); await f.setRun('completed', 'retry1');
    expect(f.failure()).toBeUndefined();
  });


  it('clears retrying on acknowledgment and retains the budget through restart until actual progress', async () => {
    const f = fixture(); await f.setRun('failed'); await f.advance(10);
    await f.setRun('running', 'retry1');
    expect(f.failure()).toBeUndefined(); expect(f.budget()?.attempts).toBe(1);
    await f.restart(); expect(f.failure()).toBeUndefined(); expect(f.budget()?.attempts).toBe(1);
    await f.advance(1);
    f.setUnreadRun({ ...f.getRun(), progressAt: new Date().toISOString() });
    await f.advance(1); await f.restart();
    expect(f.budget()).toBeNull();
    await f.setRun('failed', 'retry1'); expect(f.failure()?.attempts).toBe(0);
  });

  it('ordinary session status writes cannot erase the persisted recovery budget', async () => {
    const f = fixture(); await f.setRun('failed'); await f.advance(10); f.db.boundSessions.upsert(f.session);
    expect(f.failure()?.attempts).toBe(1);
  });

  it('backs off process-exit recovery across repeated reconciliation and backend restart', async () => {
    const f = fixture(); await f.setRun('running'); await f.advance(1);
    await f.processExited();
    expect(f.failure()).toMatchObject({ code: 'process_exited', status: 'scheduled', attempts: 0 });
    const due = f.failure()?.nextRetryAt;
    await f.processExited(); expect(f.failure()?.nextRetryAt).toBe(due);
    await f.restart(); await f.advance(9); expect(f.submit).not.toHaveBeenCalled();
    await f.advance(1); expect(f.submit).toHaveBeenCalledOnce();
    await f.setRun('running', 'resumed'); expect(f.failure()).toBeUndefined();
  });

  it('cannot renew a stopped process-exit budget by repeated reconciliation', async () => {
    const f = fixture(); await f.setRun('running'); await f.advance(1); await f.processExited(); f.cancel();
    await f.processExited(); await f.processExited(); await f.advance(60_000);
    expect(f.failure()?.status).toBe('stopped'); expect(f.submit).not.toHaveBeenCalled();
  });

  it('bounds failed process relaunches with the same persistent backoff', async () => {
    const f = fixture(); await f.setRun('running'); await f.advance(1); await f.processExited();
    f.canRetry.mockResolvedValue('The original provider conversation could not be restored.');
    await f.advance(10); expect(f.failure()).toMatchObject({ status: 'scheduled', attempts: 1 });
    await f.restart(); await f.advance(20); expect(f.failure()).toMatchObject({ status: 'scheduled', attempts: 2 });
    await f.advance(30); expect(f.failure()).toMatchObject({ status: 'stopped', attempts: 3 });
    expect(f.submit).not.toHaveBeenCalled();
  });
});
