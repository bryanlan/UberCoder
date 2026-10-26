import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTurnStartParams,
  CODEX_CAPABILITIES,
  pendingQuestions,
} from '../src/providers/transport/codex/app-server-session.js';
import type { RequestResponse, TransportEvent, TransportSession } from '../src/providers/transport/types.js';
import {
  baseHandlers,
  EventLog,
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

    await Promise.all([session.respond('0', first), session.respond('0', { decision: 'answer', answers: { schema_preference: ['Strict schemas (Recommended)'] } })]);
    await session.respond('0', { decision: 'cancel' });
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
    // The person's late answer finds nothing to answer.
    await session.respond('0', { decision: 'answer', answers: { schema_preference: ['UI flexibility'] } });
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
