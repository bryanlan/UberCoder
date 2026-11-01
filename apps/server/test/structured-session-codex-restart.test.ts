import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { createCodexAppServerPlugin } from '../src/providers/transport/codex/index.js';
import { TransportPluginRegistry } from '../src/providers/transport/registry.js';
import { createLineTransportFactory, terminateHost } from '../src/providers/transport/line-transport.js';
import {
  FAKE_APP_SERVER, FAST_TIMINGS, HOST_PROGRAM, agentMessageItem, baseHandlers, commandItem, itemCompleted, itemStarted, readLog, receivedRequests, serverRequest,
  threadResult, turnCompleted, turnObject, turnStarted, userMessageItem, waitUntil, writeScenario,
} from './helpers/codex-harness.js';
import { createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';
import { eventLogLines } from './helpers/structured-session-fixture.js';

// A turn the shared Codex app-server is running survives a Console backend restart, because the app-server runs behind a
// session host. The host (SessionManager) and the real Codex plugin must find the turn again instead of declaring it lost:
// no loss line, no recovery prompt sent into the running turn, Stop and the terminal reach the row. The app-server is a
// scripted stand-in; the session host is the real one.

const THREAD = 'thread-codex-restart';
const TURN = 'turn-1';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const activeThread = (flags: string[], rollout: string) => {
  const result = threadResult(THREAD, rollout) as { thread: Record<string, unknown> };
  return { ...result, thread: { ...result.thread, status: { type: 'active', activeFlags: flags } }, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
};

const QUESTION = {
  id: 'schema_preference', header: 'Fixture', question: 'Strict schemas or UI flexibility?', isOther: true, isSecret: false,
  options: [{ label: 'Strict', description: 'Validate tightly.' }, { label: 'Flexible', description: 'Looser.' }],
};

async function restartFixture(scenarioExtra: Record<string, unknown>, turn: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-codex-restart-'));
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, '{}\n');
  const { scenarioPath, logFile } = writeScenario(root, {
    handlers: {
      ...baseHandlers(THREAD, rollout),
      'thread/resume': { result: activeThread(['waitingOnUserInput'], rollout) },
      'thread/turns/list': { result: { data: [turnObject(TURN, 'inProgress', 1790000001)], nextCursor: null, backwardsCursor: null } },
      'turn/start': turn,
      ...scenarioExtra,
    },
  });
  const db = new AppDatabase(path.join(root, 'state.sqlite'));
  const bus = new RealtimeEventBus();
  const log = { info: () => undefined, warn: () => undefined };
  const backends: Array<{ stop(): Promise<void> }> = [];
  /** A backend: a manager with its own plugin instance and line transport factory, over the shared database and runtime. */
  const backend = () => {
    const registry = new TransportPluginRegistry();
    registry.register(createCodexAppServerPlugin({ timings: FAST_TIMINGS, baseEnv: { PATH: process.env.PATH }, clientVersion: '9.9.9' }));
      const manager = createRecoveryManager(db, root, bus, provider, providerSettings, {
      transportPlugins: registry,
      structuredSessions: { codex: { enabled: true, command: [process.execPath, FAKE_APP_SERVER, scenarioPath], idleUnloadMinutes: 60, env: {} } },
      lineTransport: createLineTransportFactory({ runtimeDir: root, log, hostProgramPath: HOST_PROGRAM }),
    });
    backends.push(manager);
    return { manager };
  };
  cleanups.push(async () => {
    for (const manager of backends.splice(0)) await manager.stop().catch(() => undefined);
    await terminateHost(root, 'codex', log, { closeGraceMs: 300, termGraceMs: 300, staleTermGraceMs: 300 }).catch(() => undefined);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pendingRef = `pending:${randomUUID()}`;
  const now = new Date().toISOString();
  const pending: ConversationSummary = {
    ref: pendingRef, kind: 'pending', projectSlug: project.slug, provider: 'codex', title: 'New Codex conversation',
    createdAt: now, updatedAt: now, isBound: false, degraded: false, rawMetadata: { pending: true },
  };
  db.pendingConversations.put(pending);
  const first = backend();
  const session = await first.manager.bindConversation({
    project, provider, conversationRef: pendingRef, title: pending.title, kind: 'pending',
  });
  const row = () => db.boundSessions.getById(session.id)!;
  const lossLines = () => eventLogLines(row()).filter(line => /connection ended/.test(line.text));
  return { root, db, logFile, first, session, row, lossLines, backend, wait: waitUntil };
}

describe('A Codex turn that runs across a backend restart, through the host', () => {
  it('is adopted by the new backend: the row stays working, no recovery is sent into it, and its terminal ends it', async () => {
    const f = await restartFixture({}, {
      result: { turn: turnObject(TURN, 'inProgress', 1790000001) },
      emitAfter: [turnStarted(THREAD, TURN), itemCompleted(THREAD, TURN, agentMessageItem('item-a', 'working'), 1500), turnCompleted(THREAD, TURN, 'completed', null, 300)],
    });
    await f.first.manager.sendInput(f.session.id, 'a long task');
    await waitUntil(() => f.row().isWorking, 5_000, 'the turn to start');
    const activityBefore = f.row().lastActivityAt;
    const startedProcess = JSON.parse(f.db.meta.get('structured-instance:codex')!) as { pid: number };

    await f.first.manager.stop(); // the backend goes away mid-turn
    expect(f.row().isWorking).toBe(true); // nothing marked it ended
    const second = f.backend();
    // The conversation that is open during the deploy polls its screen before the first reconcile pass.
    const polled = await second.manager.getSessionScreen(f.session.id);
    expect(polled?.screen.status).toMatch(/working/);
    expect(f.lossLines()).toEqual([]);
    expect(f.row().isWorking).toBe(true);
    expect(f.row().lastActivityAt).toBe(activityBefore);
    // The same app-server process, found again; the thread was resumed once and no second turn was started.
    expect(JSON.parse(f.db.meta.get('structured-instance:codex')!)).toMatchObject({ pid: startedProcess.pid });
    expect(receivedRequests(f.logFile, 'thread/resume')).toHaveLength(1);
    expect(receivedRequests(f.logFile, 'turn/start')).toHaveLength(1);
    expect(readLog(f.logFile).filter(entry => entry.event === 'start')).toHaveLength(1);

    // The reconcile pass finds the row loaded, asks nobody again, and a wake or recovery would see a running turn.
    await second.manager.reconcileSessions();
    expect(receivedRequests(f.logFile, 'thread/resume')).toHaveLength(1);

    await waitUntil(() => f.row().lastResponseAt, 10_000, 'the adopted turn to complete');
    expect(f.row().isWorking).toBe(false);
    expect(receivedRequests(f.logFile, 'turn/start')).toHaveLength(1);
    expect(f.lossLines()).toEqual([]);
  });

  it('can be stopped by the new backend: Stop reaches the app-server for the adopted turn', async () => {
    const f = await restartFixture({ 'turn/interrupt': { result: {} } }, {
      result: { turn: turnObject(TURN, 'inProgress', 1790000001) },
      emitAfter: [turnStarted(THREAD, TURN)],
    });
    await f.first.manager.sendInput(f.session.id, 'a long task');
    await waitUntil(() => f.row().isWorking, 5_000, 'the turn to start');
    await f.first.manager.stop();

    const second = f.backend();
    await second.manager.reconcileSessions();
    expect(f.row().isWorking).toBe(true);
    await second.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(receivedRequests(f.logFile, 'turn/interrupt')).toEqual([expect.objectContaining({ params: { threadId: THREAD, turnId: TURN } })]);
  });

  it('keeps a question held across the restart and delivers the answer to the app-server by id', async () => {
    const f = await restartFixture({}, {
      result: { turn: turnObject(TURN, 'inProgress', 1790000001) },
      emitAfter: [turnStarted(THREAD, TURN), serverRequest('item/tool/requestUserInput', {
        threadId: THREAD, turnId: TURN, itemId: 'call_1', questions: [QUESTION], isBlocking: true, autoResolutionMs: null,
      })],
    });
    await f.first.manager.sendInput(f.session.id, 'ask me something');
    await waitUntil(() => (f.row().pendingRequests ?? []).length === 1, 5_000, 'the question');
    const statusLines = () => eventLogLines(f.row()).filter(line => line.text === 'The agent asked a question');
    expect(statusLines()).toHaveLength(1);
    await f.first.manager.stop();

    const second = f.backend();
    await second.manager.reconcileSessions();
    await waitUntil(() => (f.row().pendingRequests ?? []).length === 1, 5_000, 'the question to come back');
    expect(f.row().pendingRequests![0]).toMatchObject({ requestId: '0', kind: 'question', turnId: TURN });
    expect(statusLines()).toHaveLength(1); // the person was told once
    // Nothing was sent to the app-server on the question's behalf: it is still waiting for the person.
    expect(readLog(f.logFile).filter(entry => entry.response)).toEqual([]);

    await second.manager.answerStructuredRequest(f.session.id, '0', { decision: 'answer', answers: { schema_preference: ['Flexible'] } });
    await waitUntil(() => readLog(f.logFile).some(entry => entry.response), 5_000, 'the answer');
    expect(readLog(f.logFile).filter(entry => entry.response).map(entry => entry.response)).toEqual([
      { id: 0, result: { answers: { schema_preference: { answers: ['Flexible'] } } } },
    ]);
    expect(f.row().pendingRequests).toBeUndefined();
  });
});

describe('A Codex turn found running after a backend restart, through the host', () => {
  it('ends the command it was running when Stop reaches it: the new backend asks the app-server which terminals are live', async () => {
    // As codex-cli 0.164.0 answers while a command runs (probed 2026-10-26): the item listing holds completed items only, and the
    // running command is in the thread's live terminals.
    const entry = (item: Record<string, unknown>) => ({ turnId: TURN, item, startedAtMs: 1, completedAtMs: null });
    const f = await restartFixture({
      'turn/interrupt': { result: {} },
      'thread/items/list': { result: { data: [entry(userMessageItem('user-1', 'run a long command')), entry(agentMessageItem('msg-1', 'working'))], nextCursor: null } },
      'thread/backgroundTerminals/list': { result: { data: [{ itemId: 'cmd-1', processId: 'proc-1', command: 'sleep 30', cwd: '/work', osPid: null, cpuPercent: null, rssKb: null }], nextCursor: null } },
      'thread/backgroundTerminals/terminate': { result: { terminated: true } },
    }, {
      result: { turn: turnObject(TURN, 'inProgress', 1790000001) },
      emitAfter: [turnStarted(THREAD, TURN), itemStarted(THREAD, TURN, commandItem('cmd-1', 'proc-1'))],
    });
    await f.first.manager.sendInput(f.session.id, 'run a long command');
    await waitUntil(() => f.row().isWorking, 5_000, 'the turn to start');
    await f.first.manager.stop(); // the backend that saw the command start goes away

    const second = f.backend();
    await second.manager.reconcileSessions();
    expect(f.row().isWorking).toBe(true);
    expect(receivedRequests(f.logFile, 'thread/backgroundTerminals/terminate')).toEqual([]);
    await second.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    expect(receivedRequests(f.logFile, 'turn/interrupt')).toHaveLength(1);
    await waitUntil(() => receivedRequests(f.logFile, 'thread/backgroundTerminals/terminate').length === 1, 5_000, 'the command to be ended');
    expect(receivedRequests(f.logFile, 'thread/backgroundTerminals/terminate')[0]!.params).toEqual({ threadId: THREAD, processId: 'proc-1' });
  });

  it('leaves a terminal an earlier turn left running when Stop reaches the adopted turn, and ends only that turn\'s commands', async () => {
    const entry = (item: Record<string, unknown>) => ({ turnId: TURN, item, startedAtMs: 1, completedAtMs: null });
    const terminal = (itemId: string, processId: string) => ({ itemId, processId, command: 'sleep 30', cwd: '/work', osPid: null, cpuPercent: null, rssKb: null });
    const f = await restartFixture({
      'turn/interrupt': { result: {} },
      'thread/items/list': { result: { data: [entry(userMessageItem('user-1', 'run the build')), entry(agentMessageItem('msg-1', 'working'))], nextCursor: null } },
      // The dev server turn 0 left running, the build turn 1 runs, and a command that started while no backend was attached.
      'thread/backgroundTerminals/list': { result: { data: [terminal('cmd-dev', 'proc-dev'), terminal('cmd-1', 'proc-1'), terminal('cmd-2', 'proc-2')], nextCursor: null } },
      'thread/backgroundTerminals/terminate': { result: { terminated: true } },
    }, [
      {
        result: { turn: turnObject('turn-0', 'inProgress', 1790000001) },
        emitAfter: [turnStarted(THREAD, 'turn-0'), itemStarted(THREAD, 'turn-0', commandItem('cmd-dev', 'proc-dev')), turnCompleted(THREAD, 'turn-0', 'completed', null, 100)],
      },
      {
        result: { turn: turnObject(TURN, 'inProgress', 1790000001) },
        emitAfter: [turnStarted(THREAD, TURN), itemStarted(THREAD, TURN, commandItem('cmd-1', 'proc-1'))],
      },
    ]);
    await f.first.manager.sendInput(f.session.id, 'start the dev server');
    await waitUntil(() => f.row().lastResponseAt, 10_000, 'the first turn to end');
    await waitUntil(() => !f.row().isWorking, 5_000, 'the first turn to end');
    await f.first.manager.sendInput(f.session.id, 'run the build');
    await waitUntil(() => f.row().isWorking, 5_000, 'the second turn to start');
    await waitUntil(() => (JSON.parse(f.db.meta.get('structured-codex-commands') ?? '{}') as Record<string, Record<string, unknown>>)[THREAD]?.['cmd-1'], 5_000, 'the build command to be recorded');
    await f.first.manager.stop();

    const second = f.backend();
    await second.manager.reconcileSessions();
    expect(f.row().isWorking).toBe(true);
    await second.manager.sendKeystrokes(f.session.id, { keys: ['Escape'] });
    await waitUntil(() => receivedRequests(f.logFile, 'thread/backgroundTerminals/terminate').length >= 2, 5_000, 'the commands to be ended');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(receivedRequests(f.logFile, 'thread/backgroundTerminals/terminate').map(frame => frame.params.processId).sort()).toEqual(['proc-1', 'proc-2']);
  });

  it('is not declared lost when the app-server says the thread is running but no listing names the turn: the first event adopts it', async () => {
    const f = await restartFixture({ 'thread/turns/list': { error: { code: -32603, message: 'cannot list turns' } } }, {
      result: { turn: turnObject(TURN, 'inProgress', 1790000001) },
      emitAfter: [turnStarted(THREAD, TURN), itemCompleted(THREAD, TURN, agentMessageItem('item-a', 'working'), 2500), turnCompleted(THREAD, TURN, 'completed', null, 300)],
    });
    await f.first.manager.sendInput(f.session.id, 'a long task');
    await waitUntil(() => f.row().isWorking, 5_000, 'the turn to start');
    await f.first.manager.stop();

    const second = f.backend();
    // The conversation that is open during the deploy polls first. The thread is active, so the turn is not lost, whatever the listing says.
    const polled = await second.manager.getSessionScreen(f.session.id);
    expect(polled?.screen.status).toMatch(/working/);
    expect(f.lossLines()).toEqual([]);
    expect(f.row().isWorking).toBe(true);
    await second.manager.reconcileSessions();
    expect(f.lossLines()).toEqual([]);
    expect(receivedRequests(f.logFile, 'thread/resume')).toHaveLength(1);

    await waitUntil(() => f.row().lastResponseAt, 10_000, 'the turn to complete');
    expect(f.row().isWorking).toBe(false);
    expect(f.lossLines()).toEqual([]);
    expect(receivedRequests(f.logFile, 'turn/start')).toHaveLength(1);
  });
});
