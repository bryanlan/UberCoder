import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingRequestSummary, SessionEvent } from '@agent-console/shared';
import { StructuredRequestNotFoundError } from '../src/sessions/session-manager.js';
import type { StructuredQuestionNotice } from '../src/sessions/structured/pending-requests.js';
import type { TransportEvent } from '../src/providers/transport/types.js';
import type { FakeTransportPluginOptions } from './helpers/structured-fixtures.js';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

// A turn can outlive a backend restart in the provider process that runs it (a Claude CLI, or the shared Codex app-server, each
// behind its session host). The new backend must find it again instead of declaring it lost, on every path that loads the row,
// and what it finds must not count as new activity. The fake plugin stands in for the real ones; the Codex plugin is covered by
// `structured-codex-restart`, the Claude plugin by `structured-claude-plugin`.

const PER_SESSION: FakeTransportPluginOptions = {
  id: 'claude',
  capabilities: { processModel: 'per-session', nativeIds: 'client-allocated', images: true },
};

const open: StructuredSessionFixture[] = [];
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  return f;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of open.splice(0)) await f.cleanup();
});

const lossLines = (f: StructuredSessionFixture, sessionId: string) =>
  eventLogLines(f.row(sessionId)).filter(line => /connection ended/.test(line.text));
const methods = (instance: { calls: Array<{ method: string }> } | undefined) => (instance?.calls ?? []).map(call => call.method);

/** A bound row with a running turn (`turn-1`), then a new backend over the same database whose process survived running it. */
async function runningThenRestarted(options: { plugin?: FakeTransportPluginOptions; survivorRunsTurn?: boolean } = {}) {
  const f = fixture({ plugin: options.plugin });
  const { session } = await f.bindNew();
  const native = session.conversationRef;
  await f.manager.sendInput(session.id, 'a long task');
  await settle();
  expect(f.row(session.id).isWorking).toBe(true);
  const activityBefore = f.row(session.id).lastActivityAt;
  const pid = f.thread(native).pid ?? 4242;
  const backend = await f.restartBackend({
    survivors: { [native]: pid },
    ...(options.survivorRunsTurn === false ? {} : { survivorTurns: { [native]: 'turn-1' } }),
  });
  return { f, session, native, backend, activityBefore };
}

describe.each([
  ['a shared process (Codex)', undefined],
  ['a per-session process (Claude)', PER_SESSION],
] as const)('A turn that survives a backend restart in %s', (_label, plugin) => {
  it('is adopted by the first reconcile pass: the row stays working, recency stays, Stop reaches the provider and the terminal ends it', async () => {
    const { f, session, native, backend, activityBefore } = await runningThenRestarted({ plugin });
    await backend.manager.reconcileSessions();
    await settle();

    const instance = backend.plugin.instance!;
    // The plugin was asked to adopt it; nothing was resumed, started or declared lost.
    expect(methods(instance)).toEqual(['reattach']);
    expect(lossLines(f, session.id)).toEqual([]);
    expect(f.row(session.id).isWorking).toBe(true);
    // Finding the turn again is not new activity.
    expect(f.row(session.id).lastActivityAt).toBe(activityBefore);
    expect(backend.tmux.created).toEqual([]);

    // The adopted turn is the session's turn: Stop reaches the provider, and a message steers it instead of starting another.
    const adopted = instance.sessions[0]!;
    expect(adopted.nativeSessionId).toBe(native);
    await backend.manager.sendKeystrokes(session.id, { keys: ['Escape'] });
    expect(adopted.calls.map(call => call.method)).toContain('interrupt');
    expect(adopted.calls.find(call => call.method === 'interrupt')!.args[0]).toBe('turn-1');

    adopted.completeTurn('interrupted');
    await settle();
    expect(f.row(session.id).isWorking).toBe(false);
  });

  it('is adopted by a screen poll that comes before the first reconcile pass, not declared lost', async () => {
    const { f, session, backend, activityBefore } = await runningThenRestarted({ plugin });
    // The browser polls /screen every second; for the conversation that is open during a deploy it comes first.
    const polled = await backend.manager.getSessionScreen(session.id);
    await settle();

    expect(polled?.session.id).toBe(session.id);
    expect(lossLines(f, session.id)).toEqual([]);
    expect(f.row(session.id).isWorking).toBe(true);
    expect(f.row(session.id).lastActivityAt).toBe(activityBefore);
    expect(methods(backend.plugin.instance)).toEqual(['reattach']); // looked for the survivor; no resume beside it
    expect(polled!.screen.status).toMatch(/working/);

    // The later reconcile pass finds the row loaded and asks nobody.
    await backend.manager.reconcileSessions();
    await settle();
    expect(methods(backend.plugin.instance)).toEqual(['reattach']);
  });

  it('is adopted by a message sent before the first reconcile pass, which steers the turn instead of starting a second one', async () => {
    const { f, session, backend } = await runningThenRestarted({ plugin });
    await backend.manager.sendInput(session.id, 'one more thing');
    await settle();

    const adopted = backend.plugin.instance!.sessions[0]!;
    expect(methods(backend.plugin.instance)).toEqual(['reattach']);
    expect(lossLines(f, session.id)).toEqual([]);
    expect(adopted.calls.map(call => call.method)).toEqual(expect.arrayContaining(['steer']));
    expect(adopted.calls.map(call => call.method)).not.toContain('sendTurn');
  });

  it('does not count as the activity of a later turn the provider starts on its own', async () => {
    const { f, session, backend, activityBefore } = await runningThenRestarted({ plugin });
    await backend.manager.reconcileSessions();
    await settle();
    const adopted = backend.plugin.instance!.sessions[0]!;
    adopted.completeTurn();
    await settle();
    expect(f.row(session.id).lastActivityAt).toBe(activityBefore);
    await new Promise(resolve => setTimeout(resolve, 5));

    // A turn the provider starts later, on its own, is agent activity and moves recency as before.
    adopted.push({ type: 'turn.started', turnId: 'provider-turn', origin: 'provider', replay: false });
    await settle();
    expect(f.row(session.id).lastActivityAt).not.toBe(activityBefore);
    expect(f.row(session.id).isWorking).toBe(true);
  });
});

describe('A turn that did not survive a backend restart', () => {
  it('is declared lost for a shared process that is found without it, and the thread stays adopted', async () => {
    const { f, session, backend } = await runningThenRestarted({ survivorRunsTurn: false });
    await backend.manager.reconcileSessions();
    await settle();

    // The app-server runs and has no turn for the thread: the turn ended where nobody could see it.
    expect(methods(backend.plugin.instance)).toEqual(['reattach']);
    expect(f.row(session.id).isWorking).toBe(false);
    expect(lossLines(f, session.id)).toHaveLength(1);
    expect(backend.plugin.instance!.sessions[0]!.reattached).toBe(true);
  });

  it('is declared lost once when no process survived, and the row is looked up before that on every load', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'long task');
    await settle();
    const backend = await f.restartBackend(); // nothing survived

    await backend.manager.getSessionScreen(session.id);
    await settle();
    expect(methods(backend.plugin.instance)).toContain('reattach');
    expect(lossLines(f, session.id)).toHaveLength(1);
    expect(f.row(session.id).isWorking).toBe(false);
    await backend.manager.reconcileSessions();
    await settle();
    expect(lossLines(f, session.id)).toHaveLength(1);
  });

  it('is not looked for on a shared-process row that is not working', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const backend = await f.restartBackend({ survivors: { [session.conversationRef]: 4242 } });
    await backend.manager.reconcileSessions();
    await settle();
    expect(methods(backend.plugin.instance)).toEqual([]);
  });
});

describe('Stop and the steers queued behind the turn', () => {
  async function stopWithSteers(cancelled: (steerRequestId: string) => string[]) {
    const f = fixture();
    const { session } = await f.bindNew();
    await f.manager.sendKeystrokes(session.id, { text: 'first', submittedText: 'first', keys: ['Enter'] });
    await settle();
    const steerId = 'steer-request-1';
    await f.manager.sendKeystrokes(session.id, { submissionId: steerId, text: 'and this', submittedText: 'and this', keys: ['Enter'] });
    const thread = f.thread(session.conversationRef);
    expect(thread.calls.filter(call => call.method === 'steer')).toHaveLength(1);
    const events: SessionEvent[] = [];
    f.bus.subscribe(event => { events.push(event); });
    thread.nextInterruptResult = { cancelledSteerIds: cancelled(steerId) };
    await f.manager.sendKeystrokes(session.id, { keys: ['Escape'] });
    return { f, session, steerId, events };
  }
  const record = (f: StructuredSessionFixture, sessionId: string, requestId: string) =>
    JSON.parse(f.db.meta.get(`session-input:${sessionId}:${requestId}`)!) as { state: string; reason: string };

  it('marks a steer the provider dropped as not delivered, and announces the change', async () => {
    const { f, session, steerId, events } = await stopWithSteers(id => [id]);
    expect(record(f, session.id, steerId)).toMatchObject({ state: 'failed', reason: 'cancelled by Stop' });
    const updates = events.filter(event => event.type === 'session.updated' && event.session.id === session.id);
    expect(updates.length).toBeGreaterThan(0);
    const queued = (updates.at(-1) as Extract<SessionEvent, { type: 'session.updated' }>).session.queuedInputs ?? [];
    expect(queued.find(item => item.requestId === steerId)).toMatchObject({ state: 'needs_review', reason: 'cancelled by Stop' });
  });

  it('leaves a steer alone that Stop did not cancel, and says so once for a message with no journal entry', async () => {
    const { f, session, steerId } = await stopWithSteers(() => ['typed-directly']);
    expect(record(f, session.id, steerId)).toMatchObject({ state: 'submitted' });
    const lines = eventLogLines(f.row(session.id)).filter(line => /cancelled by Stop/.test(line.text));
    expect(lines).toHaveLength(1);
  });

  it('changes nothing when the provider reports no cancelled steers', async () => {
    const { f, session, steerId } = await stopWithSteers(() => []);
    expect(record(f, session.id, steerId)).toMatchObject({ state: 'submitted' });
    expect(eventLogLines(f.row(session.id)).some(line => /cancelled by Stop/.test(line.text))).toBe(false);
  });
});

describe('Answering a question the provider just withdrew', () => {
  const questions = [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], allowCustom: false }];
  const opened = (requestId: string): TransportEvent => ({ type: 'request.opened', requestId, kind: 'question', summary: 'Which?', turnId: 'turn-1', questions });

  it('is not reported as delivered: the route sees a 404 and the card goes away', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'go');
    await settle();
    const thread = f.thread(session.conversationRef);
    thread.push(opened('q1'));
    await settle();
    expect(f.row(session.id).pendingRequests).toHaveLength(1);

    // The provider withdrew it while the withdrawal was still on its way to the host.
    thread.withdrawn.add('q1');
    await expect(f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'answer', answers: { q: ['A'] } })).rejects.toBeInstanceOf(StructuredRequestNotFoundError);
    expect(thread.calls.filter(call => call.method === 'respond')).toHaveLength(1); // it did ask the provider
    expect(f.row(session.id).pendingRequests).toBeUndefined();
    expect(f.db.meta.get(`structured-requests:${session.id}`)).toBeUndefined();
    // A second try finds nothing at the host already.
    await expect(f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'decline' })).rejects.toBeInstanceOf(StructuredRequestNotFoundError);
    expect(thread.calls.filter(call => call.method === 'respond')).toHaveLength(1);
  });
});

describe('A question that outlives a backend restart', () => {
  const questions = [{ id: 'q', question: 'Strict schemas or UI flexibility?', options: [{ label: 'Strict' }], allowCustom: true }];
  const opened = (requestId: string, replay?: boolean): TransportEvent => ({
    type: 'request.opened', requestId, kind: 'question', summary: 'Fixture: Strict schemas or UI flexibility?', turnId: 'turn-1', questions, ...(replay ? { replay } : {}),
  });

  async function askedThenRestarted(plugin?: FakeTransportPluginOptions) {
    const notify = vi.fn<(notice: StructuredQuestionNotice) => void>();
    const f = fixture({ plugin, manager: { notifyStructuredQuestion: notify } });
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    await f.manager.sendInput(session.id, 'go');
    await settle();
    f.thread(native).push(opened('q1'));
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    const statusLines = () => eventLogLines(f.row(session.id)).filter(line => line.text === 'The agent asked a question');
    expect(statusLines()).toHaveLength(1);
    const activityBefore = f.row(session.id).lastActivityAt;
    // The process is the same one: a shared app-server keeps its pid across a backend restart.
    const backend = await f.restartBackend({ survivors: { [native]: f.thread(native).pid ?? process.pid }, survivorTurns: { [native]: 'turn-1' } });
    return { f, session, native, backend, notify, statusLines, activityBefore };
  }

  it('is shown again without a second status line or push, and without moving recency', async () => {
    const { f, session, native, backend, notify, statusLines, activityBefore } = await askedThenRestarted();
    await backend.manager.reconcileSessions();
    await settle();
    backend.plugin.instance!.sessions.find(thread => thread.nativeSessionId === native)!.push(opened('q1', true));
    await settle();

    const pending: PendingRequestSummary[] = f.row(session.id).pendingRequests ?? [];
    expect(pending.map(request => request.requestId)).toEqual(['q1']);
    expect(statusLines()).toHaveLength(1); // not repeated
    expect(notify).toHaveBeenCalledTimes(1); // not pushed again (the new backend uses the same notifier)
    expect(f.row(session.id).lastActivityAt).toBe(activityBefore);
    expect(f.row(session.id).isWorking).toBe(true);
  });

  it('is announced when the person was never told about it, even though it was already open', async () => {
    const { f, session, native, backend, notify, statusLines } = await askedThenRestarted();
    await backend.manager.reconcileSessions();
    await settle();
    // A question that arrived while no backend listened: new to the person, although replayed to the session.
    backend.plugin.instance!.sessions.find(thread => thread.nativeSessionId === native)!.push(opened('q2', true));
    await settle();

    expect((f.row(session.id).pendingRequests ?? []).map(request => request.requestId).sort()).toEqual(['q2']);
    expect(statusLines()).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'q2' }));
  });

  it('is announced when the same request id comes from a different provider process', async () => {
    // Codex numbers its requests from 0 in every app-server process: an id written down for the old process means nothing here.
    const notify = vi.fn<(notice: StructuredQuestionNotice) => void>();
    const f = fixture({ manager: { notifyStructuredQuestion: notify } });
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    await f.manager.sendInput(session.id, 'go');
    await settle();
    f.thread(native).push(opened('0'));
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    const backend = await f.restartBackend({ survivors: { [native]: 987_654 }, survivorTurns: { [native]: 'turn-1' } });
    await backend.manager.reconcileSessions();
    await settle();
    backend.plugin.instance!.sessions.find(thread => thread.nativeSessionId === native)!.push(opened('0', true));
    await settle();

    expect(eventLogLines(f.row(session.id)).filter(line => line.text === 'The agent asked a question')).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('is announced again once it has been answered and the provider asks the same id anew', async () => {
    const { f, session, native, backend, statusLines } = await askedThenRestarted();
    await backend.manager.reconcileSessions();
    await settle();
    const adopted = backend.plugin.instance!.sessions.find(thread => thread.nativeSessionId === native)!;
    adopted.push(opened('q1', true));
    await settle();
    await backend.manager.answerStructuredRequest(session.id, 'q1', { decision: 'answer', answers: { q: ['Strict'] } });
    expect(f.row(session.id).pendingRequests).toBeUndefined();
    adopted.push(opened('q1'));
    await settle();
    expect(statusLines()).toHaveLength(2);
  });

  it('declines a question the Console cannot show with a fixed line that carries nothing of what was asked', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'go');
    await settle();
    const thread = f.thread(session.conversationRef);
    thread.push({ type: 'request.opened', requestId: 'secret-1', kind: 'question', summary: 'API token: paste your sk-live-123456 here', turnId: 'turn-1' });
    thread.push({ type: 'request.opened', requestId: 'cmd-1', kind: 'command', summary: 'rm -rf build/', turnId: 'turn-1' });
    await settle();

    const statuses = eventLogLines(f.row(session.id)).filter(line => line.type === 'status').map(line => line.text);
    expect(statuses).toContain('Declined a question the Console cannot show');
    expect(statuses).toContain('Declined a provider request: rm -rf build/');
    expect(JSON.stringify(eventLogLines(f.row(session.id)))).not.toContain('sk-live-123456');
    expect(thread.calls.filter(call => call.method === 'respond').map(call => call.args)).toEqual([
      ['secret-1', { decision: 'decline' }],
      ['cmd-1', { decision: 'decline' }],
    ]);
  });
});

describe('A question the model asked in a message', () => {
  const questions = [
    { id: 'schema', question: 'Strict schemas or UI flexibility?', options: [{ label: 'Strict' }, { label: 'Flexible' }], allowCustom: true },
    { id: 'where', question: 'Which directory?', options: [], allowCustom: true },
  ];
  const asked: TransportEvent = {
    type: 'request.opened', requestId: 'item:msg-1', kind: 'question', summary: 'Strict schemas or UI flexibility?', turnId: 'turn-1', questions, responseMode: 'message',
  };

  async function askedInAMessage() {
    const f = fixture();
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'go');
    await settle();
    const thread = f.thread(session.conversationRef);
    thread.push(asked);
    await settle();
    return { f, session, thread };
  }

  it('stays on the row after its turn ends, and is answered with a normal message that quotes the question', async () => {
    const { f, session, thread } = await askedInAMessage();
    expect(f.row(session.id).pendingRequests).toEqual([expect.objectContaining({ requestId: 'item:msg-1', responseMode: 'message' })]);
    // The model asked and ended its turn: nothing is waiting, and the card must stay.
    thread.completeTurn();
    await settle();
    expect(f.row(session.id).isWorking).toBe(false);
    expect(f.row(session.id).pendingRequests).toHaveLength(1);

    const activityBefore = f.row(session.id).lastActivityAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    const answered = await f.manager.answerStructuredRequest(session.id, 'item:msg-1', {
      decision: 'answer', answers: { schema: ['Strict', 'Flexible'], where: [] }, text: 'apps/web',
    });
    // No `respond` reaches the provider: the answer is a user turn.
    expect(thread.calls.filter(call => call.method === 'respond')).toEqual([]);
    const sent = thread.calls.filter(call => call.method === 'sendTurn');
    expect(sent).toHaveLength(2);
    expect((sent[1]!.args[0] as { text: string }).text).toBe(
      'Answer to your question: Strict schemas or UI flexibility?: Strict, Flexible, apps/web\nAnswer to your question: Which directory?: ',
    );
    expect(answered.pendingRequests).toBeUndefined();
    expect(f.db.meta.get(`structured-requests:${session.id}`)).toBeUndefined();
    // It is the person's input: recorded in the log, and recency moves.
    expect(eventLogLines(f.row(session.id)).filter(line => line.type === 'user-input').map(line => line.text).at(-1)).toContain('Answer to your question: Strict schemas');
    expect(f.row(session.id).lastActivityAt).not.toBe(activityBefore);
    // A second answer finds nothing.
    await expect(f.manager.answerStructuredRequest(session.id, 'item:msg-1', { decision: 'decline' })).rejects.toBeInstanceOf(StructuredRequestNotFoundError);
  });

  it('is answered as a steer while the turn still runs, and typed text joins the first question', async () => {
    const { f, session, thread } = await askedInAMessage();
    await f.manager.answerStructuredRequest(session.id, 'item:msg-1', { decision: 'answer', answers: { schema: ['Strict'] }, text: 'and fast' });
    expect(thread.calls.filter(call => call.method === 'sendTurn')).toHaveLength(1);
    const steers = thread.calls.filter(call => call.method === 'steer');
    expect(steers).toHaveLength(1);
    expect((steers[0]!.args[1] as { text: string }).text.split('\n')[0]).toBe('Answer to your question: Strict schemas or UI flexibility?: Strict, and fast');
    expect(f.row(session.id).pendingRequests).toBeUndefined();
  });

  it('is dismissed without a message when the person declines it', async () => {
    const { f, session, thread } = await askedInAMessage();
    await f.manager.answerStructuredRequest(session.id, 'item:msg-1', { decision: 'decline' });
    expect(thread.calls.filter(call => ['respond', 'steer'].includes(call.method))).toEqual([]);
    expect(thread.calls.filter(call => call.method === 'sendTurn')).toHaveLength(1);
    expect(f.row(session.id).pendingRequests).toBeUndefined();
  });

  it('stays open when the answer could not be sent', async () => {
    const { f, session, thread } = await askedInAMessage();
    thread.completeTurn();
    await settle();
    thread.failNextSend = new Error('provider refused');
    await expect(f.manager.answerStructuredRequest(session.id, 'item:msg-1', { decision: 'answer', answers: { schema: ['Strict'] } })).rejects.toThrow();
    expect(f.row(session.id).pendingRequests).toHaveLength(1);
    // The person can try again.
    await f.manager.answerStructuredRequest(session.id, 'item:msg-1', { decision: 'answer', answers: { schema: ['Strict'] } });
    expect(f.row(session.id).pendingRequests).toBeUndefined();
  });
});
