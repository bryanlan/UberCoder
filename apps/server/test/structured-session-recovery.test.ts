import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLaunchContext } from '@agent-console/shared';
import { GRANTED_RESTART_PROMPT } from '../src/coordination/wake.js';
import { RECOVERY_PROMPT } from '../src/sessions/run-recovery.js';
import { project, enableUnattendedRecovery } from './helpers/session-fixtures.js';
import { settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: StructuredSessionFixture[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of open.splice(0)) await f.cleanup();
});

async function recoveryFixture(options: Parameters<typeof structuredSessionFixture>[0] = {}, unattended = true) {
  // The scheduling clock is the only thing faked, and from the start so recovery captures it: transport
  // events still flow through real microtasks. Turn starts are pushed by hand so a clock tick separates
  // the human message (which cancels older recovery) from the turn it starts, as network latency does.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const f = structuredSessionFixture({ ...options, plugin: { manualTurns: true, ...options.plugin } });
  open.push(f);
  const { session } = await f.bindNew();
  const native = session.conversationRef;
  await f.manager.sendInput(session.id, 'long running job');
  await vi.advanceTimersByTimeAsync(10);
  const thread = f.thread(native);
  thread.push({ type: 'turn.started', turnId: thread.activeTurnId!, origin: 'user', replay: false });
  await vi.advanceTimersByTimeAsync(0);
  // A human message pauses unattended work, so the agent opts in after it.
  const assignment = unattended ? enableUnattendedRecovery(f.db, 'codex', native) : undefined;
  const fail = async (failure: { class: 'provider_error' | 'usage_limit'; code?: string; message: string }, turnId = thread.activeTurnId!) => {
    thread.push({ type: 'turn.terminal', turnId, status: 'failed', failure, sessionUsable: true, replay: false });
    await vi.advanceTimersByTimeAsync(0);
  };
  const failure = () => f.row(session.id).runFailure;
  const turnTexts = () => f.calls(native, 'sendTurn').map(call => (call.args[0] as { text: string }).text);
  return { f, session, native, assignment, thread, fail, failure, turnTexts };
}

const overloaded = { class: 'provider_error' as const, code: 'server_overloaded', message: 'Selected model is at capacity.' };

describe('Structured run failure and recovery', () => {
  it('persists the failure, then recovers the interrupted turn through sendTurn', async () => {
    const r = await recoveryFixture();
    await r.fail(overloaded);

    expect(r.failure()).toMatchObject({
      code: 'server_overloaded', message: 'Selected model is at capacity.', status: 'scheduled', attempts: 0, maxAttempts: 3,
    });
    expect(r.f.row(r.session.id).isWorking).toBe(false);
    expect(r.f.row(r.session.id).lastResponseAt).toBeUndefined();
    expect(r.turnTexts()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(r.turnTexts()).toHaveLength(2);
    expect(r.turnTexts()[1]).toContain(RECOVERY_PROMPT);
    expect(r.turnTexts()[1]).toContain('Recovery attempt 1 of 3.');
    expect(r.failure()).toMatchObject({ status: 'retrying', attempts: 1 });
    expect(r.f.row(r.session.id).isWorking).toBe(true);
    expect(r.f.tmuxTouched()).toBe(0);

    // Real output from the new turn acknowledges the retry and clears the notice.
    r.thread.push({ type: 'turn.started', turnId: 'turn-2', origin: 'user', replay: false });
    r.thread.push({ type: 'item.completed', turnId: 'turn-2', itemId: 'i1', kind: 'assistant', replay: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.failure()).toBeUndefined();
    expect(r.f.row(r.session.id).isWorking).toBe(true);
    r.thread.completeTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.f.row(r.session.id)).toMatchObject({ isWorking: false });
    expect(r.f.row(r.session.id).lastResponseAt).toBeTruthy();
  });

  it('stops after the retry limit across repeated failures', async () => {
    const r = await recoveryFixture();
    const recoveries = () => r.turnTexts().filter(text => text.includes(RECOVERY_PROMPT)).length;
    await r.fail(overloaded);
    for (const [index, wait] of [15_000, 45_000, 120_000].entries()) {
      await vi.advanceTimersByTimeAsync(wait);
      expect(recoveries()).toBe(index + 1);
      const turnId = r.thread.activeTurnId!;
      r.thread.push({ type: 'turn.started', turnId, origin: 'user', replay: false });
      await r.fail(overloaded, turnId);
    }
    expect(r.failure()).toMatchObject({ status: 'stopped', stoppedReason: 'The automatic retry limit was reached.' });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(recoveries()).toBe(3);
  });

  it('never retries without unattended permission', async () => {
    const r = await recoveryFixture({}, false);
    await r.fail(overloaded);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.failure()).toMatchObject({ status: 'stopped', stoppedReason: 'Unattended recovery is disabled for this session.' });
    expect(r.turnTexts()).toHaveLength(1);
  });

  it('never retries an error that needs attention', async () => {
    const r = await recoveryFixture();
    await r.fail({ class: 'usage_limit', message: 'Usage limit reached.' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.failure()).toMatchObject({ code: 'usage_limit', status: 'stopped' });
    expect(r.turnTexts()).toHaveLength(1);
  });

  it('does not retry when a human stops the failed turn', async () => {
    const r = await recoveryFixture();
    await r.fail(overloaded);
    await r.f.manager.sendKeystrokes(r.session.id, { keys: ['Escape'] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.failure()?.status).toBe('stopped');
    expect(r.turnTexts()).toHaveLength(1);
  });

  it('waits while a human turn is running instead of sending a recovery prompt over it', async () => {
    const r = await recoveryFixture();
    await r.fail(overloaded);
    // A human message arrives before the retry: the new turn supersedes recovery.
    await r.f.manager.sendInput(r.session.id, 'I will take it from here');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.turnTexts()).toEqual(['long running job', 'I will take it from here']);
  });

  it('recovers unfinished unattended work after the connection is lost mid-turn', async () => {
    const r = await recoveryFixture();
    await r.f.plugin.instance!.dispose('restart');

    await vi.waitFor(() => expect(r.failure()).toMatchObject({ code: 'process_exited', status: 'scheduled' }));
    expect(r.f.row(r.session.id).isWorking).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    // A fresh instance resumed the same native thread and received the recovery prompt.
    expect(r.f.plugin.instances).toHaveLength(2);
    expect(r.f.plugin.instances[1]!.calls.find(call => call.method === 'resume')?.args[0]).toBe(r.native);
    const resumed = r.f.plugin.instances[1]!.sessions[0]!;
    expect((resumed.calls.find(call => call.method === 'sendTurn')!.args[0] as { text: string }).text).toContain(RECOVERY_PROMPT);
    expect(r.f.tmuxTouched()).toBe(0);
  });

  it('recovers unattended work that was running when the whole backend restarted', async () => {
    const r = await recoveryFixture();
    expect(r.f.row(r.session.id).isWorking).toBe(true);
    const backend = await r.f.restartBackend();
    await backend.manager.reconcileSessions();
    await vi.waitFor(() => expect(r.f.row(r.session.id).runFailure).toMatchObject({ code: 'process_exited', status: 'scheduled' }));
    expect(r.f.row(r.session.id).isWorking).toBe(false);
    expect(backend.plugin.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(15_000);
    // The new backend resumes the thread only now, to hand it the recovery prompt.
    expect(backend.plugin.instance!.calls.find(call => call.method === 'resume')?.args[0]).toBe(r.native);
    const resumed = backend.plugin.instance!.sessions[0]!;
    expect((resumed.calls.find(call => call.method === 'sendTurn')!.args[0] as { text: string }).text).toContain(RECOVERY_PROMPT);
    expect(backend.tmux.created).toEqual([]);
  });

  it('does not recover a lost connection without unattended work', async () => {
    const r = await recoveryFixture({}, false);
    await r.f.plugin.instance!.dispose('restart');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.failure()).toBeUndefined();
    expect(r.f.plugin.instances).toHaveLength(1);
  });
});

describe('Structured granted restart and close', () => {
  const launchContext: AgentLaunchContext = {
    launchedBy: 'launcher-assignment', launcherName: 'Launcher', grantIds: [], requestId: 'request-1', flags: [], supervisorId: 'launcher-assignment',
  };

  it('refuses to restart while a turn is running, as on tmux, and leaves the turn alone', async () => {
    const f = structuredSessionFixture();
    open.push(f);
    const { session } = await f.bindNew({ launchContext });
    const native = session.conversationRef;
    await f.manager.sendInput(session.id, 'a human is waiting on this');
    await settle();
    const thread = f.thread(native);
    const epochBefore = f.db.meta.get(`structured-epoch:${session.id}`);

    await expect(f.manager.restartGrantedSession(session.id, undefined, () => true))
      .rejects.toMatchObject({ name: 'SessionInputRejectedError', message: 'Restart is waiting for the current work to finish.' });

    // Nothing was stopped, unloaded or restarted: the grant never ends a human's running turn.
    expect(thread.calls.map(call => call.method)).not.toEqual(expect.arrayContaining(['interrupt']));
    expect(thread.calls.map(call => call.method)).not.toEqual(expect.arrayContaining(['unload']));
    expect(thread.activeTurnId).toBe('turn-1');
    expect(f.row(session.id).isWorking).toBe(true);
    expect(f.db.meta.get(`structured-epoch:${session.id}`)).toBe(epochBefore);
    expect(f.plugin.instance!.sessions.filter(candidate => candidate.nativeSessionId === native)).toHaveLength(1);

    // Once the turn has finished the same request goes through.
    thread.completeTurn();
    await settle();
    await new Promise(resolve => setTimeout(resolve, 5));
    const restarted = await f.manager.restartGrantedSession(session.id, undefined, () => true);
    expect(restarted).toMatchObject({ status: 'bound', transport: 'structured' });
    expect(f.db.meta.get(`structured-epoch:${session.id}`)).not.toBe(epochBefore);
  });

  it('reloads an idle thread for a fresh epoch and starts the restart turn', async () => {
    const f = structuredSessionFixture();
    open.push(f);
    const { session } = await f.bindNew({ launchContext });
    const native = session.conversationRef;
    await f.manager.sendInput(session.id, 'earlier work');
    await settle();
    const thread = f.thread(native);
    thread.completeTurn();
    await settle();
    const epochBefore = f.db.meta.get(`structured-epoch:${session.id}`);
    await new Promise(resolve => setTimeout(resolve, 5));

    const restarted = await f.manager.restartGrantedSession(session.id, undefined, () => true);

    expect(restarted).toMatchObject({ status: 'bound', transport: 'structured', pid: process.pid });
    expect(thread.calls.map(call => call.method)).toEqual(expect.arrayContaining(['unload']));
    expect(thread.calls.map(call => call.method)).not.toContain('interrupt');
    const reloaded = f.plugin.instance!.sessions.filter(candidate => candidate.nativeSessionId === native);
    expect(reloaded).toHaveLength(2);
    expect(reloaded[1]!.resumed).toBe(true);
    expect((reloaded[1]!.calls.find(call => call.method === 'sendTurn')!.args[0] as { text: string }).text).toBe(GRANTED_RESTART_PROMPT);
    expect(f.db.meta.get(`structured-epoch:${session.id}`)).not.toBe(epochBefore);
    expect(f.tmuxTouched()).toBe(0);
  });

  it('releases the thread when its launcher closes it', async () => {
    const f = structuredSessionFixture();
    open.push(f);
    const { session } = await f.bindNew({ launchContext });
    const transcript = path.join(f.root, 'rollout.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    f.db.conversationIndex.upsert({
      ref: session.conversationRef, kind: 'history', projectSlug: project.slug, provider: 'codex', title: 'Helper',
      updatedAt: new Date().toISOString(), transcriptPath: transcript, isBound: true, degraded: false,
    });
    await f.manager.closeGrantedSession(session.id, 'launcher-assignment', () => true);
    expect(f.row(session.id)).toMatchObject({ status: 'ended', shouldRestore: false });
    expect(f.calls(session.conversationRef, 'close')[0]!.args[0]).toBe('release');
    expect(f.tmuxTouched()).toBe(0);
  });
});
