import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationSummary } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { createCodexAppServerPlugin } from '../src/providers/transport/codex/index.js';
import { TransportPluginRegistry } from '../src/providers/transport/registry.js';
import {
  FAKE_APP_SERVER, FAST_TIMINGS, agentMessageItem, baseHandlers, itemCompleted, receivedRequests, turnCompleted, turnObject,
  turnStarted, userMessageItem, waitUntil, writeScenario,
} from './helpers/codex-harness.js';
import { createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

// The host and the real Codex plugin together, against a scripted stand-in for `codex app-server`.
const THREAD = 'thread-codex-1';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function completedTurn(turnId: string, text: string) {
  return {
    result: { turn: turnObject(turnId, 'inProgress', null) },
    emitAfter: [turnStarted(THREAD, turnId), itemCompleted(THREAD, turnId, agentMessageItem(`item-${turnId}`, text)), turnCompleted(THREAD, turnId)],
  };
}

async function codexFixture(turns: unknown[], scenario: Record<string, unknown> = {}, options: { bind?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-codex-'));
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, '{}\n');
  const { scenarioPath, logFile } = writeScenario(root, { ...scenario, handlers: { ...baseHandlers(THREAD, rollout), 'turn/start': turns } });
  const db = new AppDatabase(path.join(root, 'state.sqlite'));
  const registry = new TransportPluginRegistry();
  registry.register(createCodexAppServerPlugin({ timings: FAST_TIMINGS, baseEnv: { PATH: process.env.PATH }, clientVersion: '9.9.9' }));
  const manager = createRecoveryManager(db, root, new RealtimeEventBus(), provider, providerSettings, {
    transportPlugins: registry,
    structuredSessions: { codex: { enabled: true, command: [process.execPath, FAKE_APP_SERVER, scenarioPath], idleUnloadMinutes: 60, env: {} } },
  });
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const pendingRef = `pending:${randomUUID()}`;
  const now = new Date().toISOString();
  const pending: ConversationSummary = {
    ref: pendingRef, kind: 'pending', projectSlug: project.slug, provider: 'codex', title: 'New Codex conversation',
    createdAt: now, updatedAt: now, isBound: false, degraded: false, rawMetadata: { pending: true },
  };
  db.pendingConversations.put(pending);
  const bind = () => manager.bindConversation({
    project, provider, conversationRef: pendingRef, title: pending.title, kind: 'pending',
  });
  const session = options.bind === false ? undefined as never : await bind();
  return { root, rollout, scenarioPath, db, manager, session, logFile, pendingRef, bind };
}

describe('Structured sessions on the Codex plugin', () => {
  it('binds on thread/start, runs a turn on turn/start and records the live result', async () => {
    const f = await codexFixture([completedTurn('turn-1', 'Done.')]);
    expect(f.session).toMatchObject({ status: 'bound', conversationRef: THREAD, resumeConversationRef: THREAD });
    expect(f.session.pid).toBeGreaterThan(0);
    // The plugin records its shared process for the coordination liveness check.
    expect(JSON.parse(f.db.meta.get('structured-instance:codex')!)).toMatchObject({ pid: f.session.pid });
    expect(receivedRequests(f.logFile, 'thread/start')[0]!.params).toMatchObject({ cwd: project.path, approvalPolicy: 'never', model: 'gpt-6.1-sol' });

    await f.manager.sendKeystrokes(f.session.id, { submissionId: randomUUID(), text: 'Do the thing', submittedText: 'Do the thing', keys: ['Enter'] });
    expect(receivedRequests(f.logFile, 'turn/start')[0]!.params).toMatchObject({ threadId: THREAD, model: 'gpt-6.1-sol', effort: 'xhigh' });
    await waitUntil(() => f.db.boundSessions.getById(f.session.id)?.lastResponseAt, 5_000, 'the turn to complete');
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ isWorking: false });
    expect(f.db.boundSessions.getById(f.session.id)?.lastOutputAt).toBeTruthy();
    await waitUntil(() => f.db.conversationIndex.get(project.slug, 'codex', THREAD)?.transcriptPath, 5_000, 'the transcript to be indexed');
  });

  it('turns a server-overloaded turn into the failure Console recovers from', async () => {
    const failed = {
      result: { turn: turnObject('turn-1', 'inProgress', null) },
      emitAfter: [turnStarted(THREAD, 'turn-1'), turnCompleted(THREAD, 'turn-1', 'failed', { message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded', additionalDetails: null })],
    };
    const f = await codexFixture([failed]);
    await f.manager.sendInput(f.session.id, 'work');
    await waitUntil(() => f.db.boundSessions.getById(f.session.id)?.runFailure, 5_000, 'the run failure');
    expect(f.db.boundSessions.getById(f.session.id)?.runFailure).toMatchObject({ code: 'server_overloaded', message: 'Selected model is at capacity.' });
    expect(f.db.boundSessions.getById(f.session.id)?.lastResponseAt).toBeUndefined();
  });

  it('unloads the thread on idle sleep and resumes it on the next message', async () => {
    const f = await codexFixture([completedTurn('turn-1', 'one'), completedTurn('turn-2', 'two')]);
    await f.manager.sendInput(f.session.id, 'first');
    await waitUntil(() => f.db.boundSessions.getById(f.session.id)?.lastResponseAt, 5_000, 'the first turn');
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    // Age the row past the idle window and reconcile. On a loaded host the end of the first turn can still be landing and
    // refresh the row's activity, so age it again on each pass until a pass puts it to sleep.
    await expect.poll(async () => {
      f.db.sqlite.prepare('update bound_sessions set updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, started_at=?, is_working=0 where id=?')
        .run(at, at, at, at, at, at, f.session.id);
      await f.manager.reconcileSessions();
      return f.db.boundSessions.getById(f.session.id)?.idleSuspendedAt;
    }, { timeout: 5_000, interval: 100 }).toBeTruthy();
    expect(receivedRequests(f.logFile, 'thread/unsubscribe')).toHaveLength(1);

    await f.manager.sendInput(f.session.id, 'second');
    expect(receivedRequests(f.logFile, 'thread/resume')).toHaveLength(1);
    expect(receivedRequests(f.logFile, 'thread/resume')[0]!.params).toMatchObject({ threadId: THREAD });
    expect(receivedRequests(f.logFile, 'turn/start')).toHaveLength(2);
    expect(f.db.boundSessions.getById(f.session.id)?.idleSuspendedAt).toBeUndefined();
  });

  it('notices the app-server exiting under a running turn, with a one-line reason and none of its stderr', async () => {
    const dies = {
      result: { turn: turnObject('turn-1', 'inProgress', null) },
      emitAfter: [turnStarted(THREAD, 'turn-1'), { delayMs: 50, stderr: 'FATAL: panicked at /home/someone/private/path/main.rs:12\n' }, { delayMs: 10, exit: { code: 1 } }],
    };
    const f = await codexFixture([dies]);
    await f.manager.sendInput(f.session.id, 'work');
    await waitUntil(() => {
      const row = f.db.boundSessions.getById(f.session.id);
      return row && !row.isWorking && fs.readFileSync(row.eventLogPath!, 'utf8').includes('connection ended');
    }, 5_000, 'the connection loss to be recorded');
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    const log = fs.readFileSync(f.db.boundSessions.getById(f.session.id)!.eventLogPath!, 'utf8');
    expect(log).toContain('The provider connection ended (exit code 1). The session reconnects on next use.');
    expect(log).not.toMatch(/panicked|private\/path/);
  });

  it('records a one-line reason, never the provider stderr, when a bind or a restore fails because the process ends', async () => {
    const stderr = 'FATAL: panicked at /home/someone/private/path/main.rs:12\nsecond line of the tail\n';
    // Bind: the app-server dies while starting.
    const failing = await codexFixture([], { stderr, exitAtStart: 3 }, { bind: false });
    await expect(failing.bind()).rejects.toThrow(/exit code 3/);
    const failed = failing.db.boundSessions.list()[0]!;
    expect(failed).toMatchObject({ status: 'error', shouldRestore: false });
    const bindLine = fs.readFileSync(failed.eventLogPath!, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { text: string })
      .find(entry => /^Failed to bind session/.test(entry.text))!;
    expect(bindLine.text).toBe('Failed to bind session: The Codex app-server is not available: The process ended (exit code 3).');
    expect(bindLine.text).not.toMatch(/panicked|private\/path|second line|FATAL/);

    // Restore: the thread is loaded, its process is killed, and the next process dies while starting.
    const f = await codexFixture([completedTurn('turn-1', 'one')]);
    await f.manager.sendInput(f.session.id, 'first');
    await waitUntil(() => f.db.boundSessions.getById(f.session.id)?.lastResponseAt, 5_000, 'the first turn');
    writeScenario(f.root, { stderr, exitAtStart: 3, handlers: baseHandlers(THREAD, f.rollout) });
    process.kill(f.db.boundSessions.getById(f.session.id)!.pid!, 'SIGKILL');
    await waitUntil(() => fs.readFileSync(f.db.boundSessions.getById(f.session.id)!.eventLogPath!, 'utf8').includes('connection ended'), 5_000, 'the connection loss');
    await expect(f.manager.sendInput(f.session.id, 'second')).rejects.toThrow();
    const lines = fs.readFileSync(f.db.boundSessions.getById(f.session.id)!.eventLogPath!, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { text: string });
    const restoreLine = lines.find(entry => /^Failed to restore session/.test(entry.text))!;
    expect(restoreLine.text).toBe('Failed to restore session: The Codex app-server is not available: The process ended (exit code 3).');
    expect(lines.map(entry => entry.text).join('\n')).not.toMatch(/panicked|private\/path|second line|FATAL/);
  });

  it('does not count the echo of the user\'s own message as agent output', async () => {
    const failsAfterEcho = {
      result: { turn: turnObject('turn-1', 'inProgress', null) },
      emitAfter: [
        turnStarted(THREAD, 'turn-1'),
        itemCompleted(THREAD, 'turn-1', userMessageItem('item-u', 'work')),
        turnCompleted(THREAD, 'turn-1', 'failed', { message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded', additionalDetails: null }),
      ],
    };
    const f = await codexFixture([failsAfterEcho]);
    await f.manager.sendInput(f.session.id, 'work');
    await waitUntil(() => f.db.boundSessions.getById(f.session.id)?.runFailure, 5_000, 'the run failure');
    // The turn echoed the user's message and then failed: the provider produced nothing.
    expect(f.db.boundSessions.getById(f.session.id)?.lastOutputAt).toBeUndefined();
  });
});
