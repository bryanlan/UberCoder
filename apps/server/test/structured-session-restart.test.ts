import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_PROMPT } from '../src/sessions/run-recovery.js';
import { CodexRunMonitor } from '../src/providers/transcripts/codex-run-state.js';
import { NotSentError } from '../src/providers/transport/types.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { enableUnattendedRecovery, project, provider } from './helpers/session-fixtures.js';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

// A structured thread that is not loaded (after a backend restart, an idle sleep or a lost connection) runs nothing,
// but its rollout and its persisted recovery budget survive. These tests drive the real SessionManager with the fake
// plugin and Codex's own run monitor over a rollout file.

const codexProvider: ProviderAdapter = { ...provider, createRunMonitor: () => new CodexRunMonitor() };
const overloaded = { class: 'provider_error' as const, code: 'server_overloaded', message: 'Selected model is at capacity.' };

const open: StructuredSessionFixture[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of open.splice(0)) await f.cleanup();
});

function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture({ provider: codexProvider, ...options });
  open.push(f);
  return f;
}

const rolloutRecord = (type: 'task_started' | 'task_complete', turnId: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turnId, ...extra } })}\n`;

/** Gives the row a Codex rollout (as the provider writes it) and tells the manager's watchers about it. */
function writeRollout(f: StructuredSessionFixture, sessionId: string, native: string, records: string[]): string {
  const rollout = path.join(f.root, 'rollout.jsonl');
  fs.writeFileSync(rollout, records.join(''));
  const now = new Date().toISOString();
  f.db.conversationIndex.upsert({
    ref: native, kind: 'history', projectSlug: project.slug, provider: 'codex', title: 'Thread', createdAt: now, updatedAt: now,
    providerConversationId: native, isBound: true, boundSessionId: sessionId, degraded: false, transcriptPath: rollout,
  });
  f.bus.emit({ type: 'conversation.index-updated', projectSlug: project.slug, provider: 'codex', conversationRef: native, timestamp: now });
  return rollout;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** No thread is loaded and the provider was asked for nothing. The reconcile pass may create the instance object to read its process model. */
const nothingLoaded = (plugin: { instances: Array<{ sessions: unknown[]; calls: unknown[] }> }) =>
  plugin.instances.every(instance => instance.sessions.length === 0 && instance.calls.length === 0);
const lossLines = (f: StructuredSessionFixture, sessionId: string) =>
  eventLogLines(f.row(sessionId)).filter(line => /connection ended/.test(line.text));
const runState = (manager: StructuredSessionFixture['manager'], sessionId: string) =>
  (manager as unknown as { runRecovery: { getRunState(id: string): { status: string } | undefined } }).runRecovery.getRunState(sessionId);

describe('A turn cut by a backend restart', () => {
  it('never reads as working again from its unfinished rollout while the thread is not loaded, through an idle sleep', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    await f.manager.sendInput(session.id, 'long task');
    await settle();
    expect(f.row(session.id).isWorking).toBe(true);
    // Codex's rollout for the turn that was running: started, never finished.
    writeRollout(f, session.id, native, [rolloutRecord('task_started', 'turn-1')]);

    const backend = await f.restartBackend();
    await backend.manager.reconcileSessions();
    // The new manager reads the rollout and sees a run that is "running"...
    await vi.waitFor(() => expect(runState(backend.manager, session.id)?.status).toBe('running'), { timeout: 5000, interval: 20 });
    // ...which says nothing about a thread that is not loaded.
    for (let sample = 0; sample < 8; sample += 1) {
      await pause(30);
      expect(f.row(session.id).isWorking).toBe(false);
    }
    expect(nothingLoaded(backend.plugin)).toBe(true);
    expect(lossLines(f, session.id)).toHaveLength(1);
    await backend.manager.reconcileSessions();
    await pause(100);
    expect(f.row(session.id).isWorking).toBe(false);
    expect(lossLines(f, session.id)).toHaveLength(1); // no second "connection ended" line

    // Idle sleep re-watches the row and reads the same rollout again: still idle, on every later reconcile.
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    f.db.sqlite.prepare('update bound_sessions set started_at=?, updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=? where id=?')
      .run(old, old, old, old, old, old, session.id);
    await backend.manager.reconcileSessions();
    await pause(150);
    expect(f.row(session.id).idleSuspendedAt).toBeTruthy();
    expect(f.row(session.id).isWorking).toBe(false);
    await vi.waitFor(() => expect(runState(backend.manager, session.id)?.status).toBe('running'), { timeout: 5000, interval: 20 });
    await backend.manager.reconcileSessions();
    await pause(150);
    expect(f.row(session.id).isWorking).toBe(false);
    expect(lossLines(f, session.id)).toHaveLength(1);
  });

  it('keeps the run monitor across an idle sleep instead of replacing it', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const monitors = (f.manager as unknown as { structuredMonitors: Map<string, object> }).structuredMonitors;
    const before = monitors.get(session.id);
    expect(before).toBeDefined();
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    f.db.sqlite.prepare('update bound_sessions set started_at=?, updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=? where id=?')
      .run(old, old, old, old, old, old, session.id);
    await f.manager.reconcileSessions();
    expect(f.row(session.id).idleSuspendedAt).toBeTruthy();
    expect(monitors.get(session.id)).toBe(before);
  });
});

describe('Recovery that was scheduled when the backend restarted', () => {
  async function scheduledRecovery() {
    // Only the scheduling clock is faked, from the start, so recovery captures it; file reads stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = fixture({ plugin: { manualTurns: true } });
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    await f.manager.sendInput(session.id, 'long running job');
    await vi.advanceTimersByTimeAsync(10);
    const thread = f.thread(native);
    thread.push({ type: 'turn.started', turnId: 'turn-1', origin: 'user', replay: false });
    await vi.advanceTimersByTimeAsync(0);
    enableUnattendedRecovery(f.db, 'codex', native);
    thread.push({ type: 'turn.terminal', turnId: 'turn-1', status: 'failed', failure: overloaded, sessionUsable: true, replay: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.row(session.id).runFailure).toMatchObject({ code: 'server_overloaded', status: 'scheduled', attempts: 0 });
    // The rollout Codex wrote for the failed turn.
    writeRollout(f, session.id, native, [
      rolloutRecord('task_started', 'turn-1'),
      rolloutRecord('task_complete', 'turn-1', { error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity.' } }),
    ]);
    return { f, session, native };
  }
  const recoveryTurns = (plugin: StructuredSessionFixture['plugin']) => plugin.instances.flatMap(instance => instance.sessions)
    .flatMap(thread => thread.calls.filter(call => call.method === 'sendTurn').map(call => (call.args[0] as { text: string }).text))
    .filter(text => text.includes(RECOVERY_PROMPT));

  it('re-arms from the persisted budget and the rollout, loads the thread and sends the recovery prompt', async () => {
    const { f, session, native } = await scheduledRecovery();
    const backend = await f.restartBackend();
    await backend.manager.reconcileSessions();
    expect(nothingLoaded(backend.plugin)).toBe(true); // nothing is loaded at boot
    await vi.waitFor(() => expect(runState(backend.manager, session.id)?.status).toBe('failed'), { timeout: 5000, interval: 20 });

    await vi.advanceTimersByTimeAsync(15_000); // the first retry delay of the persisted budget
    await vi.waitFor(() => expect(recoveryTurns(backend.plugin)).toHaveLength(1), { timeout: 5000, interval: 20 });
    expect(backend.plugin.instance!.calls.find(call => call.method === 'resume')?.args[0]).toBe(native);
    expect(f.row(session.id).runFailure).toMatchObject({ code: 'server_overloaded', status: 'retrying', attempts: 1 });
    expect(backend.tmux.created).toEqual([]);
  });

  it('does not watch a thread that has no recovery to run', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    writeRollout(f, session.id, session.conversationRef, [rolloutRecord('task_started', 'turn-9'), rolloutRecord('task_complete', 'turn-9')]);
    const backend = await f.restartBackend();
    await backend.manager.reconcileSessions();
    await pause(100);
    expect(runState(backend.manager, session.id)).toBeUndefined();
  });
});

describe('A restore the backend crashed in the middle of', () => {
  it('is retried at boot instead of leaving the row half restored', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    // The crash left the row `starting`, not working, with no loaded thread.
    f.db.boundSessions.upsert({ ...f.row(session.id), status: 'starting', isWorking: false, pid: undefined });
    const backend = await f.restartBackend();

    await backend.manager.reconcileSessions();

    expect(f.row(session.id).status).toBe('bound');
    expect(backend.plugin.instance!.calls.find(call => call.method === 'resume')?.args[0]).toBe(native);
    expect(backend.tmux.created).toEqual([]);
  });
});

describe('A transport that reports nothing was sent', () => {
  it('lets a wake or recovery prompt wait for a later attempt, and still fails an uncertain error', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const thread = f.thread(session.conversationRef);
    const service = (f.manager as unknown as { structured: { deliverAutomatic(row: unknown, prompt: string): Promise<{ status: string; reason?: string }> } }).structured;

    thread.failNextSend = new NotSentError('The Codex session has ended.');
    await expect(service.deliverAutomatic(f.row(session.id), 'notice')).resolves.toEqual({ status: 'deferred', reason: 'The Codex session has ended.' });
    thread.failNextSend = new Error('connection reset after the write');
    await expect(service.deliverAutomatic(f.row(session.id), 'notice')).resolves.toMatchObject({ status: 'failed', reason: 'connection reset after the write' });
  });
});

describe('A turn the transport reports as running again', () => {
  it('gets its own terminal even though its id was closed before', async () => {
    const f = fixture({ plugin: { manualTurns: true } });
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'first');
    const thread = f.thread(session.conversationRef);
    thread.push({ type: 'turn.started', turnId: 'turn-1', origin: 'user', replay: false });
    await settle();
    thread.push({ type: 'turn.terminal', turnId: 'turn-1', status: 'interrupted', sessionUsable: true, replay: false });
    await settle();
    expect(f.row(session.id).isWorking).toBe(false);

    // Codex still ran that turn: the same id starts again, and later ends for real.
    thread.push({ type: 'turn.started', turnId: 'turn-1', origin: 'user', replay: false });
    await settle();
    expect(f.row(session.id).isWorking).toBe(true);
    thread.push({ type: 'turn.terminal', turnId: 'turn-1', status: 'completed', sessionUsable: true, replay: false });
    await settle();
    expect(f.row(session.id)).toMatchObject({ isWorking: false });
    expect(f.row(session.id).lastResponseAt).toBeTruthy();
  });
});
