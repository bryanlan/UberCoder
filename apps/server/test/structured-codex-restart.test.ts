import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAppServerPlugin } from '../src/providers/transport/codex/index.js';
import type { CodexAppServerInstance } from '../src/providers/transport/codex/app-server-instance.js';
import {
  LineTransportNotRunningError,
  RequestNotPendingError,
  TransportUnavailableError,
  type LineTransportFactory,
  type TransportEvent,
  type TransportSession,
} from '../src/providers/transport/types.js';
import {
  FAST_TIMINGS,
  hostTransportFactory,
  makeContext,
  agentMessageItem,
  baseHandlers,
  commandItem,
  EventLog,
  itemCompleted,
  itemStarted,
  OPEN_OPTIONS,
  readLog,
  receivedRequests,
  restartBackend,
  serverRequest,
  setupFake,
  sleep,
  threadResult,
  turnCompleted,
  turnObject,
  turnStarted,
  waitUntil,
  type FakeSetup,
} from './helpers/codex-harness.js';

vi.setConfig({ testTimeout: 30_000 });

// The shared app-server runs behind a session host and outlives a Console backend restart. A turn it is running, a question it is
// waiting on and a request that arrives while no backend listens must all be found again by the next backend.
// See docs/structured-cutover.md, "Session host relay".

const THREAD = 'thread-1';
const TURN = 'turn-1';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function track(setup: FakeSetup): FakeSetup {
  cleanups.push(async () => {
    await setup.instance.dispose('shutdown').catch(() => undefined);
    await setup.stopHost().catch(() => undefined);
    fs.rmSync(setup.dir, { recursive: true, force: true });
  });
  return setup;
}

function trackNext(setup: FakeSetup, next: ReturnType<typeof restartBackend>): ReturnType<typeof restartBackend> {
  cleanups.push(async () => {
    await next.instance.dispose('shutdown').catch(() => undefined);
  });
  void setup;
  return next;
}

const activeThread = (flags: string[] = []) => {
  const result = threadResult(THREAD) as { thread: Record<string, unknown> };
  return { ...result, thread: { ...result.thread, status: { type: 'active', activeFlags: flags } }, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
};
const turnsList = (...turns: unknown[]) => ({ result: { data: turns, nextCursor: null, backwardsCursor: null } });

const QUESTION = {
  id: 'schema_preference',
  header: 'Fixture',
  question: 'Should this fixture prefer strict schemas or UI flexibility?',
  isOther: true,
  isSecret: false,
  options: [{ label: 'Strict schemas (Recommended)', description: 'Keep fixture data tightly validated.' }, { label: 'UI flexibility', description: 'Allow looser shapes.' }],
};
const ask = (threadId = THREAD, turnId = TURN) =>
  serverRequest('item/tool/requestUserInput', { threadId, turnId, itemId: 'call_1', questions: [QUESTION], isBlocking: true, autoResolutionMs: null });

/** The client's JSON-RPC answers to the fake's server requests, in order. */
function answers(fake: FakeSetup): Array<Record<string, any>> {
  return readLog(fake.logFile).filter((entry) => entry.response).map((entry) => entry.response!);
}

type Opened = Extract<TransportEvent, { type: 'request.opened' }>;
type Terminal = Extract<TransportEvent, { type: 'turn.terminal' }>;
type Started = Extract<TransportEvent, { type: 'turn.started' }>;

async function startTurn(fake: FakeSetup): Promise<{ session: TransportSession; log: EventLog }> {
  const session = await fake.instance.start(OPEN_OPTIONS);
  const log = new EventLog(session);
  await session.sendTurn({ text: 'long task' });
  await log.waitForType('turn.started');
  return { session, log };
}

describe('A Codex turn that runs across a backend restart', () => {
  it('is adopted from the thread status, and its events and terminal are accepted', async () => {
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'thread/resume': { result: activeThread() },
        'thread/turns/list': turnsList(turnObject(TURN, 'inProgress', 1790000001)),
        'turn/start': [{
          result: { turn: turnObject(TURN, 'inProgress', 1790000001) },
          emitAfter: [turnStarted(THREAD, TURN), itemCompleted(THREAD, TURN, agentMessageItem('item-a', 'working'), 2500), turnCompleted(THREAD, TURN, 'completed', null, 300)],
        }],
      },
    }, undefined, {}, { host: true }));
    const { log: firstLog } = await startTurn(fake);
    expect(firstLog.of('turn.started')).toHaveLength(1);
    await fake.instance.dispose('shutdown'); // the backend goes away mid-turn

    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    // The turn the thread is running is the session's turn before the call returns.
    expect(resumed.activeTurn).toBe(TURN);
    const terminal = await log.waitFor((event): event is Terminal => event.type === 'turn.terminal', 10_000);
    expect(terminal).toMatchObject({ turnId: TURN, status: 'completed', replay: false });
    // The adopted start says so, so the host does not count it as new activity; the later item is accepted.
    expect(log.of('turn.started')).toEqual([{ type: 'turn.started', turnId: TURN, origin: 'provider', replay: false, adopted: true }]);
    expect(log.of('item.completed').map((event) => event.itemId)).toEqual(['item-a']);
    expect(log.of('turn.terminal')).toHaveLength(1);
    expect((resumed as unknown as { droppedTurnEvents: number }).droppedTurnEvents).toBe(0);
    expect(resumed.activeTurn).toBeUndefined();
  });

  it('is reported once when it ended while no backend listened, and not again after another restart', async () => {
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), turnCompleted(THREAD, TURN, 'completed', null, 400)] },
        'thread/turns/list': turnsList(turnObject(TURN, 'completed', 1790000001)),
      },
    }, undefined, {}, { host: true }));
    await startTurn(fake);
    await fake.instance.dispose('shutdown');
    await sleep(900); // the turn ends meanwhile

    const second = trackNext(fake, restartBackend(fake));
    const resumed = await second.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    await log.waitForType('turn.terminal');
    expect(log.of('turn.started')).toEqual([{ type: 'turn.started', turnId: TURN, origin: 'provider', replay: false, adopted: true }]);
    expect(log.of('turn.terminal')).toEqual([{ type: 'turn.terminal', turnId: TURN, status: 'completed', sessionUsable: true, replay: false }]);
    expect(resumed.activeTurn).toBeUndefined();

    await second.instance.dispose('shutdown');
    // The database is shared: the third backend starts from what the second one wrote.
    const third = trackNext(fake, restartBackend({ ...fake, context: second.context }));
    const again = await third.instance.resume(THREAD, OPEN_OPTIONS);
    const againLog = new EventLog(again);
    await sleep(200);
    expect(againLog.of('turn.started')).toEqual([]);
    expect(againLog.of('turn.terminal')).toEqual([]);
  });

  it('is closed with the failure the server recorded when it failed meanwhile', async () => {
    const failed = turnObject(TURN, 'failed', 1790000001, { message: 'overloaded', codexErrorInfo: 'serverOverloaded', additionalDetails: null });
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN)] },
        'thread/turns/list': turnsList(failed),
      },
    }, undefined, {}, { host: true }));
    await startTurn(fake);
    await fake.instance.dispose('shutdown');

    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    const terminal = await log.waitForType('turn.terminal') as Terminal;
    expect(terminal.status).toBe('failed');
    expect(terminal.failure).toMatchObject({ class: 'provider_error', code: 'server_overloaded', retryable: true });
  });

  it('is not invented for a thread that was idle: a plain resume adopts nothing', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }, undefined, {}, { host: true }));
    const session = await fake.instance.start(OPEN_OPTIONS);
    await fake.instance.dispose('shutdown');
    void session;
    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    await sleep(100);
    expect(resumed.activeTurn).toBeUndefined();
    expect(log.of('turn.started')).toEqual([]);
    expect(readLog(fake.logFile).filter((entry) => entry.frame?.method === 'thread/turns/list')).toEqual([]);
  });

  it('is found from the first event naming an unknown turn when the thread is active and no listing names it', async () => {
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'thread/resume': { result: activeThread() },
        'thread/turns/list': turnsList(),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), itemCompleted(THREAD, TURN, agentMessageItem('item-a', 'working'), 1500), turnCompleted(THREAD, TURN, 'completed', null, 200)] },
      },
    }, undefined, {}, { host: true }));
    await startTurn(fake);
    await fake.instance.dispose('shutdown');

    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    const terminal = await log.waitForType('turn.terminal', 10_000);
    expect(terminal).toMatchObject({ turnId: TURN, status: 'completed' });
    expect(log.of('turn.started').map((event) => ({ turnId: event.turnId, adopted: event.adopted }))).toEqual([{ turnId: TURN, adopted: true }]);
    expect(log.of('item.completed')).toHaveLength(1);
  });
});

describe('Stop on a Codex turn adopted after a backend restart', () => {
  // Codex does not end a turn's command on `turn/interrupt`: the plugin ends the ones it saw start. A backend that adopts a turn did
  // not see its commands start, so it asks the provider which ones the turn is running.
  const entry = (item: Record<string, unknown>) => ({ turnId: TURN, item, startedAtMs: 1, completedAtMs: null });
  const terminalOf = (itemId: string, processId: string) => ({ itemId, processId, command: 'sleep 30', cwd: '/work/project', osPid: 1, cpuPercent: null, rssKb: null });
  const terminated = (fake: FakeSetup) => receivedRequests(fake.logFile, 'thread/backgroundTerminals/terminate').map((frame) => frame.params.processId).sort();

  /** A turn that started `cmd-1` (proc-1) before the backend went away; the next backend's provider answers with `extra`. */
  async function adoptWith(extra: Record<string, unknown>, turnEmissions: Record<string, unknown>[] = []) {
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'thread/resume': { result: activeThread() },
        'thread/turns/list': turnsList(turnObject(TURN, 'inProgress', 1790000001)),
        'thread/backgroundTerminals/terminate': { result: { terminated: true } },
        'turn/interrupt': { result: {}, emitAfter: [turnCompleted(THREAD, TURN, 'interrupted', null, 50)] },
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), itemStarted(THREAD, TURN, commandItem('cmd-1', 'proc-1')), ...turnEmissions] },
        ...extra,
      },
    }, undefined, {}, { host: true }));
    await startTurn(fake);
    await fake.instance.dispose('shutdown');
    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    return { fake, resumed, log: new EventLog(resumed) };
  }

  it('ends the commands the turn was running, found by listing the turn\'s in-progress command items and the live terminals', async () => {
    const { fake, resumed, log } = await adoptWith({
      'thread/items/list': {
        result: {
          data: [
            entry(agentMessageItem('msg-1', 'working')),
            entry(commandItem('cmd-1', 'proc-1')),
            entry(commandItem('cmd-2', 'proc-2', 'completed')), // finished: nothing to end
            entry(commandItem('cmd-3', null)), // running, but the item has no process id: the terminal list supplies it
          ],
          nextCursor: null,
        },
      },
      'thread/backgroundTerminals/list': { result: { data: [terminalOf('cmd-1', 'proc-1'), terminalOf('cmd-3', 'proc-3'), terminalOf('cmd-9', 'proc-9')], nextCursor: null } },
    });
    expect(resumed.activeTurn).toBe(TURN);
    // The provider was asked about the adopted turn only, and for the live terminals.
    expect(receivedRequests(fake.logFile, 'thread/items/list').map((frame) => frame.params)).toEqual([expect.objectContaining({ threadId: THREAD, turnId: TURN })]);
    expect(receivedRequests(fake.logFile, 'thread/backgroundTerminals/list')).toHaveLength(1);

    await resumed.interrupt(TURN);
    await waitUntil(() => terminated(fake).length >= 2, 5000, 'the commands to be ended');
    // proc-9 belongs to no command of this turn and proc-2 already finished: only the turn's running commands are ended.
    expect(terminated(fake)).toEqual(['proc-1', 'proc-3']);
    expect((await log.waitForType('turn.terminal')).status).toBe('interrupted');
  });

  it('ends the commands even when the provider can list only the items (no live terminal list)', async () => {
    const { fake, resumed, log } = await adoptWith({
      'thread/items/list': { result: { data: [entry(commandItem('cmd-1', 'proc-1'))], nextCursor: null } },
    });
    await resumed.interrupt(TURN);
    await waitUntil(() => terminated(fake).length >= 1, 5000, 'the command to be ended');
    expect(terminated(fake)).toEqual(['proc-1']);
    await log.waitForType('turn.terminal');
  });

  it('still stops the turn when the provider can list nothing, and ends nothing it cannot name', async () => {
    const { fake, resumed, log } = await adoptWith({}); // neither listing is answered: the fake says "method not found"
    await resumed.interrupt(TURN);
    expect((await log.waitForType('turn.terminal')).status).toBe('interrupted');
    await sleep(100);
    expect(receivedRequests(fake.logFile, 'thread/items/list')).toHaveLength(1);
    expect(terminated(fake)).toEqual([]);
  });

  it('does not end a command that finished while the turn was being adopted', async () => {
    const { fake, resumed, log } = await adoptWith({
      // The command's completion arrives before the answer to the listing, and the listing still names it (it was read earlier).
      'thread/items/list': { emitBefore: [itemCompleted(THREAD, TURN, commandItem('cmd-1', 'proc-1', 'completed'))], result: { data: [entry(commandItem('cmd-1', 'proc-1'))], nextCursor: null } },
      'thread/backgroundTerminals/list': { result: { data: [terminalOf('cmd-1', 'proc-1')], nextCursor: null } },
    });
    await resumed.interrupt(TURN);
    await log.waitForType('turn.terminal');
    await sleep(100);
    expect(terminated(fake)).toEqual([]);
  });

  it('finds the commands of a turn that only its first event names, and says the turn is unidentified until then', async () => {
    const { fake, resumed, log } = await adoptWith(
      {
        'thread/turns/list': { error: { code: -32603, message: 'cannot list turns' } },
        // cmd-0 started before the restart and has not been mentioned since; cmd-1 starts again in the first event.
        'thread/items/list': { result: { data: [entry(commandItem('cmd-0', 'proc-0')), entry(commandItem('cmd-1', 'proc-1'))], nextCursor: null } },
      },
      [itemStarted(THREAD, TURN, commandItem('cmd-1', 'proc-1'), 1500)],
    );
    // The thread is active and no listing names the turn: not a lost turn, and not yet a known one.
    expect(resumed.activeTurn).toBeUndefined();
    expect(resumed.turnUnidentified).toBe(true);
    const started = await log.waitForType('turn.started', 10_000);
    expect(started).toMatchObject({ turnId: TURN, origin: 'provider', adopted: true });
    expect(resumed.turnUnidentified).toBe(false);
    expect(resumed.activeTurn).toBe(TURN);

    await waitUntil(() => receivedRequests(fake.logFile, 'thread/items/list').length >= 1, 5000, 'the listing of the adopted turn');
    await sleep(100); // the answer is read in the background
    await resumed.interrupt(TURN);
    await waitUntil(() => terminated(fake).length >= 2, 5000, 'the commands to be ended');
    expect(terminated(fake)).toEqual(['proc-0', 'proc-1']);
    await log.waitForType('turn.terminal');
  });

  it('keeps the end of the turn when a flood of output arrives while the listing is pending', async () => {
    const delta = { frame: { method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: 'msg-1', delta: '.' } } };
    // Past the buffer's limit the progress ticks are dropped, but the turn's completion is not.
    const flood = [...Array.from({ length: 4300 }, () => delta), turnCompleted(THREAD, TURN, 'completed')];
    const { resumed, log } = await adoptWith({ 'thread/turns/list': { emitBefore: flood, result: { data: [turnObject(TURN, 'inProgress', 1790000001)], nextCursor: null, backwardsCursor: null } } });
    const terminal = await log.waitForType('turn.terminal', 10_000);
    expect(terminal).toMatchObject({ turnId: TURN, status: 'completed' });
    expect(resumed.activeTurn).toBeUndefined();
  });
});

describe('A Codex question across a backend restart', () => {
  async function askAndRestart(extra: Record<string, unknown> = {}) {
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'thread/resume': { result: activeThread(['waitingOnUserInput']) },
        'thread/turns/list': turnsList(turnObject(TURN, 'inProgress', 1790000001)),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), ask()] },
        ...extra,
      },
    }, undefined, {}, { host: true }));
    const { log } = await startTurn(fake);
    const opened = await log.waitForType('request.opened') as Opened;
    return { fake, opened, log };
  }

  it('stays unanswered when the backend shuts down, and the next backend answers it by id', async () => {
    const { fake, opened, log: firstLog } = await askAndRestart();
    expect(opened.requestId).toBe('0');
    await fake.instance.dispose('shutdown');
    await sleep(300);
    // Nothing was sent to the app-server: it is still waiting for the person. The old session did not close the question
    // either (closing it would have answered it with no answers just before the socket closed).
    expect(answers(fake)).toEqual([]);
    expect(firstLog.of('request.closed')).toEqual([]);

    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    const reopened = await log.waitForType('request.opened') as Opened;
    expect(reopened).toMatchObject({ requestId: '0', kind: 'question', turnId: TURN, replay: true });
    expect(reopened.questions?.[0]).toMatchObject({ id: 'schema_preference', question: QUESTION.question });
    expect(answers(fake)).toEqual([]);

    await resumed.respond('0', { decision: 'answer', answers: { schema_preference: ['UI flexibility'] } });
    await waitUntil(() => answers(fake).length === 1, 5000, 'the reply');
    expect(answers(fake)).toEqual([{ id: 0, result: { answers: { schema_preference: { answers: ['UI flexibility'] } } } }]);
    await waitUntil(() => log.of('request.closed').length === 1, 5000, 'the close');
    expect(log.of('request.closed')[0]).toEqual({ type: 'request.closed', requestId: '0', outcome: 'resolved' });
    // A second answer finds nothing.
    await expect(resumed.respond('0', { decision: 'decline' })).rejects.toBeInstanceOf(RequestNotPendingError);
    expect(answers(fake)).toHaveLength(1);
  });

  it('is forgotten, with a warning, when the thread no longer waits for it', async () => {
    const { fake } = await askAndRestart({ 'thread/resume': { result: activeThread([]) } });
    await fake.instance.dispose('shutdown');

    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    await sleep(100);
    expect(log.of('request.opened')).toEqual([]);
    expect(log.of('notice').map((event) => event.text)).toEqual([expect.stringContaining('can no longer be answered')]);
    await expect(resumed.respond('0', { decision: 'decline' })).rejects.toBeInstanceOf(RequestNotPendingError);
    expect(answers(fake)).toEqual([]);
  });

  it('is closed, not answered, when its turn ends after the restart', async () => {
    const { fake } = await askAndRestart();
    await fake.instance.dispose('shutdown');
    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    await log.waitForType('request.opened');
    // The turn ends (the person answered elsewhere, or Stop): the question goes with it.
    const nextSession = resumed as unknown as { handleNotification(method: string, params: unknown): void };
    nextSession.handleNotification('turn/completed', { threadId: THREAD, turn: turnObject(TURN, 'interrupted', 1790000001) });
    await log.waitForType('request.closed');
    expect(log.of('request.closed')[0]).toEqual({ type: 'request.closed', requestId: '0', outcome: 'cancelled' });
    expect(answers(fake)).toEqual([]); // the server cleared it with the turn: nothing is written
  });

  it('that arrived while no backend listened is read from the host replay and held when the thread resumes', async () => {
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'thread/resume': { result: activeThread(['waitingOnUserInput']) },
        'thread/turns/list': turnsList(turnObject(TURN, 'inProgress', 1790000001)),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), { ...ask(), delayMs: 600 }] },
      },
    }, undefined, {}, { host: true }));
    await startTurn(fake);
    await fake.instance.dispose('shutdown');
    await sleep(1_000); // the server asks while nobody is connected

    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    const opened = await log.waitForType('request.opened') as Opened;
    expect(opened).toMatchObject({ requestId: '0', kind: 'question', replay: true });
    await resumed.respond('0', { decision: 'answer', answers: { schema_preference: ['Strict schemas (Recommended)'] } });
    await waitUntil(() => answers(fake).length === 1, 5000, 'the reply');
    expect(answers(fake)[0]).toMatchObject({ id: 0 });
  });

  it('an approval that arrived while no backend listened is declined by id when the next backend connects', async () => {
    const approval = serverRequest('item/commandExecution/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'cmd-1', command: 'rm -rf /tmp/x' });
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), { ...approval, delayMs: 600 }] },
      },
    }, undefined, {}, { host: true }));
    await startTurn(fake);
    await fake.instance.dispose('shutdown');
    await sleep(1_000);

    const next = trackNext(fake, restartBackend(fake));
    await next.instance.resume(THREAD, OPEN_OPTIONS);
    await waitUntil(() => answers(fake).length === 1, 5000, 'the decline');
    expect(answers(fake)).toEqual([{ id: 0, result: { decision: 'decline' } }]);
  });
});

describe('A host replay that does not reach back far enough', () => {
  it('cannot show a question that arrived while no backend listened, and says so instead of leaving the turn waiting unexplained', async () => {
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'thread/resume': { result: activeThread(['waitingOnUserInput']) },
        'thread/turns/list': turnsList(turnObject(TURN, 'inProgress', 1790000001)),
        // The question arrives while nobody listens, and a flood of output then pushes it out of the host's replay buffer.
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), { ...ask(), delayMs: 500 }, { delayMs: 50, bigLineBytes: 5 * 1024 * 1024 }] },
      },
    }, undefined, {}, { host: true }));
    await startTurn(fake);
    await fake.instance.dispose('shutdown');
    await sleep(1_500);

    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    await sleep(100);
    expect(log.of('request.opened')).toEqual([]);
    expect(log.of('notice').map((event) => event.text)).toEqual([expect.stringContaining('could not recover')]);
    expect(next.context.logs.info.map(([, message]) => message)).toEqual(expect.arrayContaining([expect.stringContaining('no longer holds every line')]));
    // The turn itself is still followed, and Stop is how it ends.
    expect(resumed.activeTurn).toBe(TURN);
  });

  it('is not misread when the saved cursor belongs to another process', async () => {
    const { fake } = await (async () => {
      const f = track(setupFake({
        handlers: {
          ...baseHandlers(THREAD),
          'thread/resume': { result: activeThread(['waitingOnUserInput']) },
          'thread/turns/list': turnsList(turnObject(TURN, 'inProgress', 1790000001)),
          'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), { ...ask(), delayMs: 500 }] },
        },
      }, undefined, {}, { host: true }));
      await startTurn(f);
      return { fake: f };
    })();
    await fake.instance.dispose('shutdown');
    await sleep(900);
    // The cursor on record is from a process that is gone.
    fake.context.metaStore.set('structured-codex-cursor', JSON.stringify({ seq: 10_000, pid: 1 }));

    const next = trackNext(fake, restartBackend(fake));
    const resumed = await next.instance.resume(THREAD, OPEN_OPTIONS);
    const log = new EventLog(resumed);
    // The whole buffer is read: the question that arrived meanwhile is found.
    const opened = await log.waitForType('request.opened') as Opened;
    expect(opened).toMatchObject({ requestId: '0', kind: 'question', replay: true });
  });
});

describe('Reattaching to the Codex app-server after a backend restart', () => {
  /** A backend over the fake's host and database whose line transport factory is wrapped by `wrap`. */
  function backendWith(fake: FakeSetup, wrap: (factory: LineTransportFactory) => LineTransportFactory): CodexAppServerInstance {
    const context = makeContext(fake.context.runtimeDir);
    context.lineTransport = wrap(hostTransportFactory(fake.hostRuntimeDir, context));
    const plugin = createCodexAppServerPlugin({ timings: FAST_TIMINGS, baseEnv: { PATH: process.env.PATH }, clientVersion: '9.9.9' });
    const instance = plugin.create({ enabled: true, command: fake.command, idleUnloadMinutes: 60, env: {} }, context) as CodexAppServerInstance;
    cleanups.push(async () => {
      await instance.dispose('shutdown').catch(() => undefined);
    });
    return instance;
  }
  const processStarts = (fake: FakeSetup) => readLog(fake.logFile).filter((entry) => entry.event === 'start');

  it('starts nothing when no app-server runs: it resolves undefined', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }, undefined, {}, { host: true }));
    expect(await fake.instance.reattach(THREAD, OPEN_OPTIONS)).toBeUndefined();
    expect(processStarts(fake)).toEqual([]);
    expect(fs.existsSync(`${fake.hostRuntimeDir}/structured/hosts`) ? fs.readdirSync(`${fake.hostRuntimeDir}/structured/hosts`) : []).toEqual([]);
  });

  it('adopts the app-server that kept running, without starting another', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }, undefined, {}, { host: true }));
    await fake.instance.start(OPEN_OPTIONS);
    await fake.instance.dispose('shutdown');
    const next = trackNext(fake, restartBackend(fake));
    const session = await next.instance.reattach(THREAD, OPEN_OPTIONS);
    expect(session?.nativeSessionId).toBe(THREAD);
    expect(processStarts(fake)).toHaveLength(1);
    expect(receivedRequests(fake.logFile, 'thread/resume')).toHaveLength(1);
  });

  it('leaves a host alone that runs but does not answer in time, and says so instead of reporting that nothing survived', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }, undefined, {}, { host: true }));
    await fake.instance.start(OPEN_OPTIONS);
    await fake.instance.dispose('shutdown');
    const slow = backendWith(fake, (factory) => async (spawn) => {
      if (spawn.attachOnly) throw new LineTransportNotRunningError('The session host did not answer.', 'unreachable');
      return factory(spawn);
    });
    await expect(slow.reattach(THREAD, OPEN_OPTIONS)).rejects.toBeInstanceOf(TransportUnavailableError);
    expect(processStarts(fake)).toHaveLength(1); // the app-server that is running was neither replaced nor ended
    expect(receivedRequests(fake.logFile, 'thread/resume')).toHaveLength(0);
  });

  it('does not make an ordinary start fail because an attach that found no host was in flight beside it', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }, undefined, {}, { host: true }));
    const instance = backendWith(fake, (factory) => async (spawn) => {
      if (spawn.attachOnly) {
        await sleep(250);
        throw new LineTransportNotRunningError('No host runs.', 'absent');
      }
      return factory(spawn);
    });
    const reattaching = instance.reattach(THREAD, OPEN_OPTIONS);
    await sleep(30);
    const started = instance.start(OPEN_OPTIONS); // an ordinary use, while the attach is still looking
    expect(await reattaching).toBeUndefined();
    expect((await started).nativeSessionId).toBe(THREAD);
    expect(processStarts(fake)).toHaveLength(1);
  });

  it('waits for an ordinary start that is in flight and uses its app-server instead of looking for another', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }, undefined, {}, { host: true }));
    const started = fake.instance.start(OPEN_OPTIONS);
    await sleep(10);
    const reattached = fake.instance.reattach(THREAD, OPEN_OPTIONS);
    const [first, second] = await Promise.all([started, reattached]);
    expect(first.nativeSessionId).toBe(THREAD);
    expect(second?.nativeSessionId).toBe(THREAD);
    expect(processStarts(fake)).toHaveLength(1);
  });

  it('starts nothing when the app-server it ran in has been ended since', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }, undefined, {}, { host: true }));
    await fake.instance.start(OPEN_OPTIONS);
    await fake.instance.dispose('shutdown');
    // The host is gone: the attach finds nothing, and nothing may be started in its place.
    await fake.stopHost();
    const next = trackNext(fake, restartBackend(fake));
    expect(await next.instance.reattach(THREAD, OPEN_OPTIONS)).toBeUndefined();
    expect(processStarts(fake)).toHaveLength(1);
  });
});

describe('The host replay, told apart by sequence number', () => {
  interface Listener { (line: string, seq?: number): void }
  /** A host connection that replays lines 1..`replayed` (the welcome says the newest is `newest`), then answers `status` as `answer` says. */
  function hostConnection(newest: number, answer: (emit: (seq: number) => void) => Promise<void>) {
    const listeners = new Set<Listener>();
    const emit = (seq: number): void => { for (const listener of [...listeners]) listener(`line-${seq}`, seq); };
    const transport = {
      info: { hostPid: 1, childPid: 2, alive: true, seq: newest, firstSeq: 1, everWrote: true, startedAt: '' },
      outlivesClose: true,
      pid: 2,
      onLine: (listener: Listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      onExit: () => () => undefined,
      status: () => answer(emit).then(() => ({ seq: newest })),
      write: async () => undefined,
      stderrTail: () => '',
      close: async () => undefined,
    };
    return { transport, emit };
  }
  const separate = async (fake: FakeSetup, transport: unknown) =>
    (fake.instance as unknown as { separateReplay(t: unknown): Promise<{ transport: { onLine(listener: (line: string) => void): () => void }; replay: { newestSeq: number; lines: Array<{ seq: number; line: string }> } }> }).separateReplay(transport);

  it('does not hand the rest of the replay to the client as live output when the host answers status too late', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }));
    const { transport, emit } = hostConnection(5, async (send) => {
      send(1); send(2); send(3); // the host is slow: lines 4 and 5 of the replay, and the answer, come later
      throw new Error('The session host did not answer status.');
    });
    const separated = await separate(fake, transport);
    expect(separated.replay.lines.map((entry) => entry.seq)).toEqual([1, 2, 3]);

    const live: string[] = [];
    separated.transport.onLine((line) => void live.push(line));
    emit(4); emit(5); // still the replay
    emit(6); emit(7); // output that happened after the connection was made
    expect(live).toEqual(['line-6', 'line-7']);
  });

  it('delivers output that came right behind the replay first, and the replay to nobody', async () => {
    const fake = track(setupFake({ handlers: baseHandlers(THREAD) }));
    const { transport, emit } = hostConnection(3, async (send) => {
      send(1); send(2); send(3); send(4); // line 4 is live: it came after the replay, before the answer
    });
    const separated = await separate(fake, transport);
    expect(separated.replay.lines.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    const live: string[] = [];
    separated.transport.onLine((line) => void live.push(line));
    emit(5);
    expect(live).toEqual(['line-4', 'line-5']);
  });
});

describe('Held Codex questions and the connection limit', () => {
  it('stop counting against the limit on requests being handled, so an approval is still declined behind them', async () => {
    const approval = serverRequest('item/commandExecution/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'cmd-1', command: 'ls' });
    const questions = Array.from({ length: 40 }, () => ask());
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), ...questions, approval] },
      },
    }));
    const { log } = await startTurn(fake);
    await waitUntil(() => answers(fake).some((answer) => answer.id === 40), 5000, 'the approval answer');
    // All 40 questions are held (none was refused for lack of a free handler slot), and the approval behind them got a real
    // decline, not the "too many server requests" error.
    expect(answers(fake).find((answer) => answer.id === 40)).toEqual({ id: 40, result: { decision: 'decline' } });
    expect(answers(fake).filter((answer) => answer.id < 40)).toEqual([]);
    expect(log.of('request.opened').filter((event) => event.kind === 'question')).toHaveLength(40);
  });
});
