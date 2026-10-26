import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestNotPendingError, type TransportEvent, type TransportSession } from '../src/providers/transport/types.js';
import {
  agentMessageItem,
  baseHandlers,
  EventLog,
  itemCompleted,
  OPEN_OPTIONS,
  readLog,
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

describe('A question the model asked in a message', () => {
  it('is opened as a message-mode question that no server request is waiting on', async () => {
    const item = { ...agentMessageItem('msg-1', 'I need to know one thing.'), delivery: 'async', questions: [QUESTION] };
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), itemCompleted(THREAD, TURN, item), itemCompleted(THREAD, TURN, item)] },
      },
    }));
    const { log } = await startTurn(fake);
    const opened = await log.waitForType('request.opened') as Opened;
    await sleep(150);
    expect(opened).toMatchObject({
      requestId: 'item:msg-1', kind: 'question', turnId: TURN, responseMode: 'message',
      summary: `Fixture: ${QUESTION.question}`,
    });
    expect(opened.questions).toEqual([expect.objectContaining({ id: 'schema_preference', question: QUESTION.question, allowCustom: true })]);
    // Announced once, and nothing is held: the plugin never closes it.
    expect(log.of('request.opened')).toHaveLength(1);
    expect(log.of('request.closed')).toEqual([]);
    expect(answers(fake)).toEqual([]);
  });

  it('is not a question when the async message carries none the Console can show', async () => {
    const secret = { ...agentMessageItem('msg-2', 'Password?'), delivery: 'async', questions: [{ ...QUESTION, isSecret: true }] };
    const plain = { ...agentMessageItem('msg-3', 'Hello'), delivery: null, questions: null };
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN), itemCompleted(THREAD, TURN, secret), itemCompleted(THREAD, TURN, plain), turnCompleted(THREAD, TURN)] },
      },
    }));
    const { log } = await startTurn(fake);
    await log.waitForType('turn.terminal');
    expect(log.of('request.opened')).toEqual([]);
  });
});
