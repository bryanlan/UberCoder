import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTurnStartParams,
  CODEX_CAPABILITIES,
  pendingQuestions,
} from '../src/providers/transport/codex/app-server-session.js';
import { RequestNotPendingError, type RequestResponse, type TransportEvent, type TransportSession } from '../src/providers/transport/types.js';
import {
  agentMessageItem,
  baseHandlers,
  EventLog,
  itemCompleted,
  itemStarted,
  notification,
  OPEN_OPTIONS,
  readLog,
  receivedRequests,
  serverRequest,
  setupFake,
  sleep,
  turnCompleted,
  turnObject,
  turnStarted,
  userMessageItem,
  waitUntil,
  type FakeSetup,
} from './helpers/codex-harness.js';

vi.setConfig({ testTimeout: 20_000 });

// Questions the agent asks (`item/tool/requestUserInput`) are held open until the host answers them; approvals
// and elicitations are still declined at once. See docs/structured-cutover.md, "Parity features".

const THREAD = 'thread-1';
const TURN = 'turn-1';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function track<T extends FakeSetup>(setup: T): T {
  cleanups.push(async () => {
    await setup.instance.dispose('shutdown');
    fs.rmSync(setup.dir, { recursive: true, force: true });
  });
  return setup;
}

const QUESTION = {
  id: 'schema_preference',
  header: 'Fixture',
  question: 'Should this fixture prefer strict schemas or UI flexibility?',
  isOther: true,
  isSecret: false,
  options: [
    { label: 'Strict schemas (Recommended)', description: 'Keep fixture data tightly validated.' },
    { label: 'UI flexibility', description: 'Allow looser fixture shapes.' },
  ],
};

function ask(questions: unknown[], threadId = THREAD, turnId = TURN) {
  return serverRequest('item/tool/requestUserInput', { threadId, turnId, itemId: 'call_1', questions, isBlocking: true, autoResolutionMs: null });
}

/** `turn/start` answers with a queued turn and then plays `after` (which must not end the turn unless the test says so). */
function scenario(after: unknown[]) {
  return { handlers: { ...baseHandlers(THREAD), 'turn/start': { result: { turn: turnObject(TURN, 'inProgress', null) }, emitAfter: after } } };
}

async function startTurn(fake: FakeSetup): Promise<{ session: TransportSession; log: EventLog }> {
  const session = await fake.instance.start(OPEN_OPTIONS);
  const log = new EventLog(session);
  await session.sendTurn({ text: 'go' });
  return { session, log };
}

/** The client's JSON-RPC answers to the fake's server requests, in order. */
function answers(fake: FakeSetup): Array<Record<string, any>> {
  return readLog(fake.logFile).filter((entry) => entry.response).map((entry) => entry.response!);
}

type Opened = Extract<TransportEvent, { type: 'request.opened' }>;
type Closed = Extract<TransportEvent, { type: 'request.closed' }>;

describe('pendingQuestions', () => {
  it('maps options, a header and the free-text flag', () => {
    expect(pendingQuestions({ questions: [QUESTION] })).toEqual([{
      id: 'schema_preference',
      header: 'Fixture',
      question: QUESTION.question,
      options: [
        { label: 'Strict schemas (Recommended)', description: 'Keep fixture data tightly validated.' },
        { label: 'UI flexibility', description: 'Allow looser fixture shapes.' },
      ],
      allowCustom: true,
    }]);
  });

  it('allows a typed answer when there are no options, and not when options are closed', () => {
    const questions = pendingQuestions({ questions: [
      { id: 'free', header: '', question: 'Name?', isOther: false, isSecret: false, options: null },
      { id: 'closed', header: 'H', question: 'Pick', isOther: false, isSecret: false, options: [{ label: 'A', description: '' }] },
    ] });
    expect(questions).toEqual([
      { id: 'free', question: 'Name?', options: [], allowCustom: true },
      { id: 'closed', header: 'H', question: 'Pick', options: [{ label: 'A' }], allowCustom: false },
    ]);
  });

  it.each([
    ['no questions', { questions: [] }],
    ['a missing list', {}],
    ['a question without an id', { questions: [{ question: 'x', options: null }] }],
    ['a question without text', { questions: [{ id: 'q', options: null }] }],
    ['a secret question', { questions: [{ id: 'q', question: 'Password?', isSecret: true, options: null }] }],
    ['one secret question among others', { questions: [{ id: 'a', question: 'Fine?', options: null }, { id: 'b', question: 'Token?', isSecret: true, options: null }] }],
  ])('refuses %s, so the request is declined', (_label, params) => {
    expect(pendingQuestions(params)).toBeUndefined();
  });
});

describe('Codex questions', () => {
  it('holds a question open, then answers it with the chosen option', async () => {
    const fake = track(setupFake(scenario([turnStarted(THREAD, TURN), ask([QUESTION])])));
    const { session, log } = await startTurn(fake);
    const opened = await log.waitForType('request.opened') as Opened;

    expect(opened).toEqual({
      type: 'request.opened',
      requestId: '0',
      kind: 'question',
      summary: `Fixture: ${QUESTION.question}`,
      turnId: TURN,
      questions: pendingQuestions({ questions: [QUESTION] }),
    });
    // The reply is held: the turn waits for the person.
    await sleep(150);
    expect(answers(fake)).toEqual([]);
    expect(log.of('request.closed')).toEqual([]);

    await session.respond('0', { decision: 'answer', answers: { schema_preference: ['Strict schemas (Recommended)'] } });
    await waitUntil(() => answers(fake).length === 1, 5000, 'the reply');
    expect(answers(fake)).toEqual([{ id: 0, result: { answers: { schema_preference: { answers: ['Strict schemas (Recommended)'] } } } }]);
    expect(log.of('request.closed')).toEqual([{ type: 'request.closed', requestId: '0', outcome: 'resolved' }]);
  });

  it('never answers twice: a second respond, a late cancel and the server echo have no effect', async () => {
    const fake = track(setupFake(scenario([
      turnStarted(THREAD, TURN),
      ask([QUESTION]),
      // The server confirms the resolution after our reply.
      notification('serverRequest/resolved', { threadId: THREAD, requestId: 0 }, 400),
    ])));
    const { session, log } = await startTurn(fake);
    await log.waitForType('request.opened');
    const first: RequestResponse = { decision: 'answer', answers: { schema_preference: ['UI flexibility'] } };

    // The first answer settles the question; every later one finds it closed and says so.
    const results = await Promise.allSettled([session.respond('0', first), session.respond('0', { decision: 'answer', answers: { schema_preference: ['Strict schemas (Recommended)'] } })]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(RequestNotPendingError);
    await expect(session.respond('0', { decision: 'cancel' })).rejects.toBeInstanceOf(RequestNotPendingError);
    await sleep(600);

    expect(answers(fake)).toEqual([{ id: 0, result: { answers: { schema_preference: { answers: ['UI flexibility'] } } } }]);
    expect(log.of('request.closed')).toHaveLength(1);
  });

  it('answers decline and cancel with no answers', async () => {
    const fake = track(setupFake(scenario([turnStarted(THREAD, TURN), ask([QUESTION]), ask([{ ...QUESTION, id: 'other' }])])));
    const { session, log } = await startTurn(fake);
    await waitUntil(() => log.of('request.opened').length === 2, 5000, 'two questions');

    await session.respond('0', { decision: 'decline' });
    await session.respond('1', { decision: 'cancel' });
    await waitUntil(() => answers(fake).length === 2, 5000, 'both replies');
    expect(answers(fake)).toEqual([{ id: 0, result: { answers: {} } }, { id: 1, result: { answers: {} } }]);
    expect(log.of('request.closed')).toEqual([
      { type: 'request.closed', requestId: '0', outcome: 'declined' },
      { type: 'request.closed', requestId: '1', outcome: 'cancelled' },
    ]);
  });

  it('shapes the answer by the asked questions: every id answered, unknown ids dropped, typed text on the first', async () => {
    const second = { id: 'second', header: '', question: 'Anything else?', isOther: false, isSecret: false, options: null };
    const fake = track(setupFake(scenario([turnStarted(THREAD, TURN), ask([QUESTION, second])])));
    const { session, log } = await startTurn(fake);
    await log.waitForType('request.opened');

    await session.respond('0', { decision: 'answer', answers: { second: ['Nothing'], stranger: ['ignored'] }, text: '  but keep it short  ' });
    await waitUntil(() => answers(fake).length === 1, 5000, 'the reply');
    expect(answers(fake)[0]).toEqual({ id: 0, result: { answers: {
      schema_preference: { answers: ['but keep it short'] },
      second: { answers: ['Nothing'] },
    } } });
  });

  it('releases a question the server withdrew, without waiting for the person', async () => {
    const fake = track(setupFake(scenario([
      turnStarted(THREAD, TURN),
      ask([QUESTION]),
      notification('serverRequest/resolved', { threadId: THREAD, requestId: 0 }, 200),
    ])));
    const { session, log } = await startTurn(fake);
    await log.waitForType('request.opened');
    await log.waitForType('request.closed');

    expect(log.of('request.closed')).toEqual([{ type: 'request.closed', requestId: '0', outcome: 'cancelled' }]);
    await waitUntil(() => answers(fake).length === 1, 5000, 'the settling reply');
    expect(answers(fake)).toEqual([{ id: 0, result: { answers: {} } }]);
    // The person's late answer finds nothing to answer, and the caller is told so (it must not report the answer as delivered).
    await expect(session.respond('0', { decision: 'answer', answers: { schema_preference: ['UI flexibility'] } })).rejects.toBeInstanceOf(RequestNotPendingError);
    await sleep(100);
    expect(answers(fake)).toHaveLength(1);
    expect(log.of('request.closed')).toHaveLength(1);
  });

  it('closes a question when its turn ends, before the terminal event', async () => {
    const fake = track(setupFake(scenario([
      turnStarted(THREAD, TURN),
      ask([QUESTION]),
      turnCompleted(THREAD, TURN, 'interrupted', null, 200),
    ])));
    const { log } = await startTurn(fake);
    await log.waitForType('turn.terminal');

    const types = log.events.map((event) => event.type).filter((type) => ['request.opened', 'request.closed', 'turn.terminal'].includes(type));
    expect(types).toEqual(['request.opened', 'request.closed', 'turn.terminal']);
    expect(log.of('request.closed')[0]).toEqual({ type: 'request.closed', requestId: '0', outcome: 'cancelled' });
    await waitUntil(() => answers(fake).length === 1, 5000, 'the settling reply');
    expect(answers(fake)).toEqual([{ id: 0, result: { answers: {} } }]);
  });

  it('closes open questions when the session is closed', async () => {
    const fake = track(setupFake(scenario([turnStarted(THREAD, TURN), ask([QUESTION])])));
    const { session, log } = await startTurn(fake);
    await log.waitForType('request.opened');

    await session.close('shutdown');
    await log.done;
    expect(log.of('request.closed')).toEqual([{ type: 'request.closed', requestId: '0', outcome: 'cancelled' }]);
    expect(log.events.at(-1)).toEqual({ type: 'session.state', state: 'stopped' });
  });

  it('declines a secret question at once, as before', async () => {
    const secret = { id: 'token', header: 'Auth', question: 'Paste the API token', isOther: true, isSecret: true, options: null };
    const fake = track(setupFake(scenario([turnStarted(THREAD, TURN), ask([secret])])));
    const { log } = await startTurn(fake);
    await waitUntil(() => answers(fake).length === 1, 5000, 'the reply');

    expect(answers(fake)).toEqual([{ id: 0, result: { answers: {} } }]);
    const opened = log.of('request.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: 'question', summary: 'Auth: Paste the API token' });
    expect(opened[0]).not.toHaveProperty('questions');
    expect(log.of('request.closed')).toEqual([{ type: 'request.closed', requestId: '0', outcome: 'declined' }]);
  });

  it('keeps declining approvals and elicitations while a question is open', async () => {
    const fake = track(setupFake(scenario([
      turnStarted(THREAD, TURN),
      ask([QUESTION]),
      serverRequest('item/commandExecution/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'i2', startedAtMs: 1, environmentId: null, command: 'rm -rf /tmp/x' }),
      serverRequest('mcpServer/elicitation/request', { threadId: THREAD, turnId: TURN, serverName: 'gmail', mode: 'form', message: 'Allow sending?', requestedSchema: {}, _meta: null }),
    ])));
    const { session, log } = await startTurn(fake);
    await waitUntil(() => answers(fake).length === 2, 5000, 'the two declines');

    expect(answers(fake)).toEqual([
      { id: 1, result: { decision: 'decline' } },
      { id: 2, result: { action: 'decline', content: null, _meta: null } },
    ]);
    expect(log.of('request.opened').map((event) => [event.requestId, event.kind])).toEqual([['0', 'question'], ['1', 'command'], ['2', 'mcp']]);
    // The question is still waiting.
    expect(log.of('request.closed').map((event) => event.requestId)).toEqual(['1', '2']);
    await session.respond('0', { decision: 'answer', answers: { schema_preference: ['UI flexibility'] } });
    await waitUntil(() => answers(fake).length === 3, 5000, 'the answer');
  });
});

// codex-cli 0.164.0 in the default collaboration mode gives the model `request_user_input_async` instead of a blocking
// `item/tool/requestUserInput`. The frames below are the ones a real app-server sent (captured over stdio on 2026-10-26, ids
// shortened): the tool answers `{"accepted":true}` at once, no server request is raised, the question arrives as an agentMessage
// item with `delivery: 'async'` and `questions: [{ title, options }]` (item/started, then an identical item/completed), the model
// then polls with a 60 s `sleep` item, and a steered answer interrupts the sleep and ends the same turn.
const ASK_ID = 'call_12c928c4cfa3441b81ffa8baf557987c';
const ASK_ITEM = {
  ...agentMessageItem(ASK_ID, 'Which color do you prefer?\n- Red\n- Blue'),
  delivery: 'async',
  questions: [{ title: 'Which color do you prefer?', options: ['Red', 'Blue'] }],
};
const COMMENTARY_ITEM = { ...agentMessageItem('msg_0b8abc5af500dbee', 'I’ll ask for your color preference and wait for your answer.\n'), phase: 'commentary' };
const SLEEP_ITEM = { type: 'sleep', id: 'call_0b6df4df884f4e96', durationMs: 60_000 };
const OBSERVED_FRAMES = [
  turnStarted(THREAD, TURN),
  itemStarted(THREAD, TURN, userMessageItem('um-1', 'Ask me which color I prefer.')),
  itemCompleted(THREAD, TURN, userMessageItem('um-1', 'Ask me which color I prefer.')),
  itemStarted(THREAD, TURN, { ...COMMENTARY_ITEM, text: '' }),
  itemCompleted(THREAD, TURN, COMMENTARY_ITEM),
  itemStarted(THREAD, TURN, ASK_ITEM),
  itemCompleted(THREAD, TURN, ASK_ITEM),
  itemStarted(THREAD, TURN, SLEEP_ITEM),
];

describe('A question the model asked with request_user_input_async', () => {
  it('opens one message-mode card from the observed frames, holds nothing, and survives the end of its turn', async () => {
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', null) }, emitAfter: OBSERVED_FRAMES },
        'turn/steer': { result: { turnId: TURN }, emitAfter: [itemCompleted(THREAD, TURN, SLEEP_ITEM), turnCompleted(THREAD, TURN, 'completed', null, 100)] },
      },
    }));
    const { session, log } = await startTurn(fake);
    const opened = await log.waitForType('request.opened') as Opened;
    await sleep(150);

    expect(opened).toEqual({
      type: 'request.opened',
      requestId: `item:${ASK_ID}`,
      kind: 'question',
      summary: 'Which color do you prefer?',
      turnId: TURN,
      questions: [{ id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowCustom: true }],
      responseMode: 'message',
    });
    // item/started and item/completed carry the same item: one card. Nothing is held, so no JSON-RPC reply is owed.
    expect(log.of('request.opened')).toHaveLength(1);
    expect(log.of('request.closed')).toEqual([]);
    expect(answers(fake)).toEqual([]);
    // The turn is still open (the model polls), and the message the question became is an ordinary assistant item.
    expect(log.of('turn.terminal')).toEqual([]);
    expect(log.of('item.completed').map((event) => [event.itemId, event.kind])).toContainEqual([ASK_ID, 'assistant']);

    // The answer is a message: a steer into the open turn, which interrupts the sleep and ends the turn.
    await session.steer!(TURN, { text: 'Answer to your question: Which color do you prefer?: Blue' });
    expect(receivedRequests(fake.logFile, 'turn/steer')[0]!.params).toMatchObject({
      expectedTurnId: TURN,
      input: [{ type: 'text', text: 'Answer to your question: Which color do you prefer?: Blue' }],
    });
    await log.waitForType('turn.terminal');
    // The card outlives its turn: only the host closes it, when the person answers or declines.
    expect(log.of('request.closed')).toEqual([]);
    expect(log.of('request.opened')).toHaveLength(1);
  });

  it('maps several questions by position, with and without options', async () => {
    const item = {
      ...agentMessageItem('call_two', 'Which package?\n- pnpm\n- npm\n\nWhat should it be named?'),
      delivery: 'async',
      questions: [{ title: 'Which package manager?', options: ['pnpm', 'npm'] }, { title: 'What should it be named?' }, { title: 'Anything else?', options: null }],
    };
    const fake = track(setupFake(scenario([turnStarted(THREAD, TURN), itemCompleted(THREAD, TURN, item)])));
    const { log } = await startTurn(fake);
    const opened = await log.waitForType('request.opened') as Opened;

    expect(opened.requestId).toBe('item:call_two');
    expect(opened.summary).toBe('Which package manager?');
    expect(opened.questions).toEqual([
      { id: 'q1', question: 'Which package manager?', options: [{ label: 'pnpm' }, { label: 'npm' }], allowCustom: true },
      { id: 'q2', question: 'What should it be named?', options: [], allowCustom: true },
      { id: 'q3', question: 'Anything else?', options: [], allowCustom: true },
    ]);
  });

  it('says so when the question cannot be shown, and ignores a message that asks nothing', async () => {
    const asyncItem = (id: string, questions: unknown) => ({ ...agentMessageItem(id, 'A question.'), delivery: 'async', questions });
    const fake = track(setupFake(scenario([
      turnStarted(THREAD, TURN),
      itemCompleted(THREAD, TURN, asyncItem('call_a', [{ question: 'The old field name', options: ['x'] }])), // no title
      itemCompleted(THREAD, TURN, asyncItem('call_b', [{ title: 'Which?', options: [{ label: 'x' }] }])), // option is not a string
      itemCompleted(THREAD, TURN, asyncItem('call_c', 'Which?')), // not a list
      itemCompleted(THREAD, TURN, asyncItem('call_a', [{ question: 'The old field name' }])), // the same item again: one notice
      itemCompleted(THREAD, TURN, asyncItem('call_d', [])), // nothing asked
      itemCompleted(THREAD, TURN, { ...agentMessageItem('msg_plain', 'Hello'), delivery: null, questions: null }),
      turnCompleted(THREAD, TURN, 'completed', null, 100),
    ])));
    const { log } = await startTurn(fake);
    await log.waitForType('turn.terminal');

    expect(log.of('request.opened')).toEqual([]);
    const notices = log.of('notice').filter((event) => /cannot show as a card/.test(event.text));
    expect(notices.map((event) => event.level)).toEqual(['warn', 'warn', 'warn']);
  });
});

describe('Codex images', () => {
  it('advertises image support', () => {
    expect(CODEX_CAPABILITIES.images).toBe(true);
  });

  it('sends one localImage item per attached file, then the text', () => {
    const params = buildTurnStartParams('t1', {
      text: 'Look at this',
      images: [{ path: '/images/a.png', mimeType: 'image/png' }, { path: '/images/b.jpg', mimeType: 'image/jpeg' }],
    }, OPEN_OPTIONS.policy, '/work', 'm1');
    expect(params.input).toEqual([
      { type: 'localImage', path: '/images/a.png' },
      { type: 'localImage', path: '/images/b.jpg' },
      { type: 'text', text: 'Look at this' },
    ]);
  });

  it('writes the images in turn/start and in a steer', async () => {
    const fake = track(setupFake({
      handlers: {
        ...baseHandlers(THREAD),
        'turn/start': { result: { turn: turnObject(TURN, 'inProgress', 1790000001) }, emitAfter: [turnStarted(THREAD, TURN)] },
        'turn/steer': { result: { turnId: TURN } },
      },
    }));
    const session = await fake.instance.start(OPEN_OPTIONS);
    new EventLog(session);
    await session.sendTurn({ text: 'first', images: [{ path: '/images/a.png', mimeType: 'image/png' }] });
    expect(receivedRequests(fake.logFile, 'turn/start')[0]!.params.input).toEqual([
      { type: 'localImage', path: '/images/a.png' },
      { type: 'text', text: 'first' },
    ]);
    await session.steer(TURN, { text: 'second', images: [{ path: '/images/b.webp', mimeType: 'image/webp' }] });
    expect(receivedRequests(fake.logFile, 'turn/steer')[0]!.params.input).toEqual([
      { type: 'localImage', path: '/images/b.webp' },
      { type: 'text', text: 'second' },
    ]);
  });
});
