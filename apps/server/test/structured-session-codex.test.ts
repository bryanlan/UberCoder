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
  turnStarted, waitUntil, writeScenario,
} from './helpers/codex-harness.js';
import { FakeTmux, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

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

async function codexFixture(turns: unknown[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-codex-'));
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, '{}\n');
  const { scenarioPath, logFile } = writeScenario(root, { handlers: { ...baseHandlers(THREAD, rollout), 'turn/start': turns } });
  const db = new AppDatabase(path.join(root, 'state.sqlite'));
  const tmux = new FakeTmux();
  const registry = new TransportPluginRegistry();
  registry.register(createCodexAppServerPlugin({ timings: FAST_TIMINGS, baseEnv: { PATH: process.env.PATH }, clientVersion: '9.9.9' }));
  const manager = createRecoveryManager(db, tmux, root, new RealtimeEventBus(), provider, providerSettings, {
    transportPlugins: registry,
    structuredSessions: { codex: { enabled: true, command: [process.execPath, FAKE_APP_SERVER, scenarioPath], idleUnloadMinutes: 60 } },
  });
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const pendingRef = `pending:${randomUUID()}`;
  const now = new Date().toISOString();
  const pending: ConversationSummary = {
    ref: pendingRef, kind: 'pending', projectSlug: project.slug, provider: 'codex', title: 'New Codex conversation',
    createdAt: now, updatedAt: now, isBound: false, degraded: false, rawMetadata: { pending: true },
  };
  db.pendingConversations.put(pending);
  const session = await manager.bindConversation({
    project, provider, providerSettings, conversationRef: pendingRef, title: pending.title, kind: 'pending', transport: 'structured',
  });
  return { root, rollout, db, tmux, manager, session, logFile, pendingRef };
}

describe('Structured sessions on the Codex plugin', () => {
  it('binds on thread/start, runs a turn on turn/start and records the live result', async () => {
    const f = await codexFixture([completedTurn('turn-1', 'Done.')]);
    expect(f.session).toMatchObject({ transport: 'structured', status: 'bound', conversationRef: THREAD, resumeConversationRef: THREAD });
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
    expect(f.tmux.created).toEqual([]);
    expect(f.tmux.captureStartLines).toEqual([]);
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
    f.db.sqlite.prepare('update bound_sessions set updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, started_at=?, is_working=0 where id=?')
      .run(at, at, at, at, at, at, f.session.id);
    await f.manager.reconcileSessions();
    expect(f.db.boundSessions.getById(f.session.id)?.idleSuspendedAt).toBeTruthy();
    expect(receivedRequests(f.logFile, 'thread/unsubscribe')).toHaveLength(1);

    await f.manager.sendInput(f.session.id, 'second');
    expect(receivedRequests(f.logFile, 'thread/resume')).toHaveLength(1);
    expect(receivedRequests(f.logFile, 'thread/resume')[0]!.params).toMatchObject({ threadId: THREAD });
    expect(receivedRequests(f.logFile, 'turn/start')).toHaveLength(2);
    expect(f.db.boundSessions.getById(f.session.id)?.idleSuspendedAt).toBeUndefined();
  });

  it('notices the app-server exiting under a running turn', async () => {
    const dies = { result: { turn: turnObject('turn-1', 'inProgress', null) }, emitAfter: [turnStarted(THREAD, 'turn-1'), { delayMs: 50, exit: { code: 1 } }] };
    const f = await codexFixture([dies]);
    await f.manager.sendInput(f.session.id, 'work');
    await waitUntil(() => {
      const row = f.db.boundSessions.getById(f.session.id);
      return row && !row.isWorking && fs.readFileSync(row.eventLogPath!, 'utf8').includes('connection ended');
    }, 5_000, 'the connection loss to be recorded');
    expect(f.db.boundSessions.getById(f.session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
  });
});
