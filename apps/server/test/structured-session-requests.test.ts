import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingRequestSummary, SessionEvent } from '@agent-console/shared';
import { SessionInputRejectedError, StructuredRequestNotFoundError } from '../src/sessions/session-manager.js';
import type { StructuredQuestionNotice } from '../src/sessions/structured/pending-requests.js';
import type { TransportEvent } from '../src/providers/transport/types.js';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

// Questions a structured agent asks stay on the session row until they are answered or withdrawn; every
// other request is declined. See docs/structured-cutover.md, "Parity features".

const open: StructuredSessionFixture[] = [];
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  return f;
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

/** A promise the test settles by hand. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const QUESTION_TEXT = 'Strict schemas or UI flexibility?';
const questions = [{
  id: 'schema',
  header: 'Fixture',
  question: QUESTION_TEXT,
  options: [{ label: 'Strict', description: 'Validate tightly' }, { label: 'Flexible' }],
  allowCustom: true,
}];
const opened = (requestId = 'q1', turnId: string | undefined = 'turn-1'): TransportEvent => ({
  type: 'request.opened', requestId, kind: 'question', summary: `Fixture: ${QUESTION_TEXT}`, ...(turnId ? { turnId } : {}), questions,
});

/** A bound session with a running turn (`turn-1`) and a notification spy. */
async function withTurn(options: { notify?: (notice: StructuredQuestionNotice) => void | Promise<unknown> } = {}) {
  const notify = vi.fn(options.notify ?? (() => undefined));
  const f = fixture({ manager: { notifyStructuredQuestion: notify } });
  const { session } = await f.bindNew();
  await f.manager.sendInput(session.id, 'go');
  await settle();
  const thread = f.thread(session.conversationRef);
  const stored = () => f.db.meta.get(`structured-requests:${session.id}`);
  const pending = (): PendingRequestSummary[] => f.row(session.id).pendingRequests ?? [];
  const updates = (): SessionEvent[] => f.events.filter(event => event.type === 'session.updated' && event.session.id === session.id);
  const responses = () => f.calls(session.conversationRef, 'respond');
  return { f, session, thread, notify, stored, pending, updates, responses };
}

describe('A structured question', () => {
  it('stays open on the row, is announced without its text, and is pushed with its summary', async () => {
    const { f, session, thread, notify, stored, pending, updates, responses } = await withTurn();
    const before = updates().length;
    thread.push(opened());
    await settle();

    expect(pending()).toEqual([{
      requestId: 'q1', kind: 'question', summary: `Fixture: ${QUESTION_TEXT}`, questions, turnId: 'turn-1', openedAt: expect.any(String),
    }]);
    expect(JSON.parse(stored()!)).toHaveLength(1);
    // The browser sees it through the ordinary session update.
    expect(updates().length).toBeGreaterThan(before);
    expect((updates().at(-1) as Extract<SessionEvent, { type: 'session.updated' }>).session.pendingRequests).toHaveLength(1);
    // It is not declined, and the log carries a status line but not the question.
    expect(responses()).toEqual([]);
    const log = eventLogLines(f.row(session.id));
    expect(log.filter(line => line.type === 'status').map(line => line.text)).toContain('The agent asked a question');
    expect(JSON.stringify(log)).not.toContain(QUESTION_TEXT);
    expect(JSON.stringify(log)).not.toContain('Declined a provider request');
    // The push goes out once, with the summary and the conversation to open.
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sessionId: session.id, projectSlug: session.projectSlug, provider: 'codex', conversationRef: session.conversationRef,
      requestId: 'q1', summary: `Fixture: ${QUESTION_TEXT}`,
    });
    expect(f.tmuxTouched()).toBe(0);
  });

  it('is announced once when the transport announces it again', async () => {
    const { thread, notify, pending } = await withTurn();
    thread.push(opened());
    thread.push(opened());
    await settle();
    expect(pending()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not fail the question when the push fails', async () => {
    const { thread, pending } = await withTurn({ notify: () => Promise.reject(new Error('push service down')) });
    thread.push(opened());
    await settle();
    expect(pending()).toHaveLength(1);
  });

  it('is answered once: the answer reaches the transport, the row drops it, and a second answer is a 404', async () => {
    const { f, session, thread, stored, pending, updates, responses } = await withTurn();
    thread.push(opened());
    await settle();
    const before = updates().length;

    const answered = await f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'answer', answers: { schema: ['Strict'] }, text: 'and fast' });
    expect(responses()).toHaveLength(1);
    expect(responses()[0]!.args).toEqual(['q1', { decision: 'answer', answers: { schema: ['Strict'] }, text: 'and fast' }]);
    expect(answered.pendingRequests).toBeUndefined();
    expect(pending()).toEqual([]);
    expect(stored()).toBeUndefined();
    expect(updates().length).toBeGreaterThan(before);
    expect((updates().at(-1) as Extract<SessionEvent, { type: 'session.updated' }>).session.pendingRequests).toBeUndefined();

    await expect(f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'decline' })).rejects.toBeInstanceOf(StructuredRequestNotFoundError);
    // The transport closing the request afterwards changes nothing.
    thread.push({ type: 'request.closed', requestId: 'q1', outcome: 'resolved' });
    await settle();
    expect(responses()).toHaveLength(1);
  });

  it('lets exactly one of two simultaneous answers through', async () => {
    const { f, session, thread, responses } = await withTurn();
    thread.push(opened());
    await settle();
    const release = gate();
    const original = thread.respond.bind(thread);
    thread.respond = async (requestId, response) => { await release.promise; return original(requestId, response); };

    const first = f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'answer', answers: { schema: ['Strict'] } });
    const second = f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'answer', answers: { schema: ['Flexible'] } });
    release.resolve();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(responses()).toHaveLength(1);
    expect(responses()[0]!.args[1]).toMatchObject({ answers: { schema: ['Strict'] } });
  });

  it('lets exactly one answer through the service even without the session lock', async () => {
    const { f, session, thread, responses } = await withTurn();
    thread.push(opened());
    await settle();
    const release = gate();
    const original = thread.respond.bind(thread);
    thread.respond = async (requestId, response) => { await release.promise; return original(requestId, response); };
    const service = (f.manager as unknown as { structured: { respond(session: { id: string }, requestId: string, response: unknown): Promise<void> } }).structured;

    const first = service.respond(session, 'q1', { decision: 'answer', answers: { schema: ['Strict'] } });
    const second = service.respond(session, 'q1', { decision: 'answer', answers: { schema: ['Flexible'] } });
    await expect(second).rejects.toMatchObject({ code: 'structured_request_not_pending' });
    release.resolve();
    await first;
    expect(responses()).toHaveLength(1);
  });

  it('forwards a decline', async () => {
    const { f, session, thread, pending, responses } = await withTurn();
    thread.push(opened());
    await settle();
    await f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'decline' });
    expect(responses()[0]!.args).toEqual(['q1', { decision: 'decline' }]);
    expect(pending()).toEqual([]);
  });

  it('stays open and can be answered again when the transport fails to take the answer', async () => {
    const { f, session, thread, pending, responses } = await withTurn();
    thread.push(opened());
    await settle();
    const original = thread.respond.bind(thread);
    thread.respond = async () => { throw new Error('connection reset'); };
    await expect(f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'answer', answers: { schema: ['Strict'] } })).rejects.toThrow('connection reset');
    expect(pending()).toHaveLength(1);

    thread.respond = original;
    await f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'answer', answers: { schema: ['Strict'] } });
    expect(pending()).toEqual([]);
    expect(responses()).toHaveLength(1);
  });

  it('rejects an answer for a request that was never asked', async () => {
    const { f, session } = await withTurn();
    await expect(f.manager.answerStructuredRequest(session.id, 'nope', { decision: 'decline' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('is dropped when the transport withdraws it, so it cannot block the row or be answered', async () => {
    const { f, session, thread, stored, pending, updates, responses } = await withTurn();
    thread.push(opened());
    await settle();
    const before = updates().length;
    thread.push({ type: 'request.closed', requestId: 'q1', outcome: 'cancelled' });
    await settle();

    expect(pending()).toEqual([]);
    expect(stored()).toBeUndefined();
    expect(updates().length).toBeGreaterThan(before);
    await expect(f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'decline' })).rejects.toBeInstanceOf(StructuredRequestNotFoundError);
    expect(responses()).toEqual([]);
    // The turn is not blocked by the withdrawn request: a message still steers it.
    await f.manager.sendInput(session.id, 'carry on');
    expect(f.calls(session.conversationRef, 'steer')).toHaveLength(1);
  });

  it('is dropped when its turn ends', async () => {
    const { thread, pending, stored } = await withTurn();
    thread.push(opened());
    await settle();
    thread.completeTurn('interrupted');
    await settle();
    expect(pending()).toEqual([]);
    expect(stored()).toBeUndefined();
  });

  it('is dropped when a later turn starts, even if the transport never closed it', async () => {
    const { thread, pending } = await withTurn();
    thread.push(opened());
    await settle();
    expect(pending()).toHaveLength(1);
    thread.push({ type: 'turn.started', turnId: 'turn-9', origin: 'provider', replay: false });
    await settle();
    expect(pending()).toEqual([]);
  });

  it('keeps a question that belongs to the turn that just started', async () => {
    const { thread, pending } = await withTurn();
    thread.push(opened('q1', 'turn-1'));
    thread.push({ type: 'turn.started', turnId: 'turn-1', origin: 'user', replay: false });
    await settle();
    expect(pending()).toHaveLength(1);
  });

  it('is dropped when the session sleeps or is released', async () => {
    const slept = await withTurn();
    slept.thread.push(opened());
    await settle();
    slept.thread.completeTurn();
    slept.thread.push(opened('q2', undefined));
    await settle();
    expect(slept.pending()).toHaveLength(1);
    await slept.f.manager.suspendSession(slept.session.id);
    expect(slept.pending()).toEqual([]);
    expect(slept.stored()).toBeUndefined();

    const released = await withTurn();
    released.thread.push(opened());
    await settle();
    expect(released.pending()).toHaveLength(1);
    await released.f.manager.releaseSession(released.session.id);
    expect(released.stored()).toBeUndefined();
  });

  it('is gone after a backend restart, because the connection that asked it is', async () => {
    const { f, session, thread, stored } = await withTurn();
    thread.push(opened());
    await settle();
    expect(stored()).toBeTruthy();
    const next = await f.restartBackend();
    expect(stored()).toBeUndefined();
    expect(f.row(session.id).pendingRequests).toBeUndefined();
    await expect(next.manager.answerStructuredRequest(session.id, 'q1', { decision: 'decline' })).rejects.toBeInstanceOf(StructuredRequestNotFoundError);
  });

  it('holds off coordination wakes while it waits', async () => {
    const { f, session, thread } = await withTurn();
    thread.push(opened());
    await settle();
    thread.completeTurn();
    thread.push(opened('q2', undefined));
    await settle();
    const delivery = await (f.manager as unknown as { structured: { deliverAutomatic(session: unknown, prompt: string): Promise<{ status: string; reason?: string }> } })
      .structured.deliverAutomatic(f.row(session.id), 'wake up');
    expect(delivery).toMatchObject({ status: 'deferred', reason: 'The provider is waiting on a request.' });
  });
});

describe('Requests the service still declines', () => {
  it.each(['permission', 'mcp', 'command', 'file_change'] as const)('declines a %s request without keeping it', async (kind) => {
    const { f, session, thread, notify, pending, responses } = await withTurn();
    thread.push({ type: 'request.opened', requestId: 'r1', kind, summary: 'needs approval' });
    await settle();
    expect(responses()[0]!.args).toEqual(['r1', { decision: 'decline' }]);
    expect(pending()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(eventLogLines(f.row(session.id)).some(line => line.type === 'status' && line.text.includes('Declined a provider request'))).toBe(true);
  });

  it('declines a question that arrives without anything to show', async () => {
    const { thread, notify, pending, responses } = await withTurn();
    thread.push({ type: 'request.opened', requestId: 'q0', kind: 'question', summary: 'Password?' });
    await settle();
    expect(responses()[0]!.args).toEqual(['q0', { decision: 'decline' }]);
    expect(pending()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('Answering on a row that is not structured', () => {
  it('is refused', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    f.db.sqlite.prepare("update bound_sessions set transport = 'tmux' where id = ?").run(session.id);
    await expect(f.manager.answerStructuredRequest(session.id, 'q1', { decision: 'decline' })).rejects.toBeInstanceOf(SessionInputRejectedError);
  });
});
