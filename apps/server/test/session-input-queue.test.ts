import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionCommandResult } from '../src/sessions/session-manager.js';
import { SessionInputRejectedError } from '../src/sessions/session-manager.js';
import { InputQueue, type QueuedInputRecord } from '../src/sessions/input-queue.js';
import { settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

// The durable input journal behind `POST /api/sessions/:id/keys` with a submission id: what is queued, in which order it is
// delivered, and how Stop, cancellation, suspension and a backend restart end a message that has not been sent.
const open: StructuredSessionFixture[] = [];
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  return f;
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

/** A provider that cannot steer, so a message sent while a turn runs waits in the queue. */
const QUEUEING = { plugin: { capabilities: { steer: 'none' as const } } };

function send(f: StructuredSessionFixture, sessionId: string, text: string, requestId: string = randomUUID(), revision?: number): Promise<SessionCommandResult> {
  return f.manager.sendKeystrokes(sessionId, { submissionId: requestId, text, submittedText: text, keys: ['Enter'] }, revision);
}
function record(f: StructuredSessionFixture, sessionId: string, requestId: string): QueuedInputRecord {
  return new InputQueue(f.db.sqlite).get(sessionId, requestId)!;
}
const sentTexts = (f: StructuredSessionFixture, native: string) =>
  f.calls(native, 'sendTurn').map(call => (call.args[0] as { text: string }).text);

describe('durable human input queue', () => {
  it('delivers queued messages one turn at a time, in the order they were sent', async () => {
    const f = fixture(QUEUEING);
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    const second = randomUUID(), third = randomUUID();
    expect((await send(f, session.id, 'second', second)).queuedInput).toMatchObject({ requestId: second, state: 'queued' });
    expect((await send(f, session.id, 'third', third)).queuedInput).toMatchObject({ requestId: third, state: 'queued' });
    expect(f.row(session.id).queuedInputs?.map(input => input.text)).toEqual(['second', 'third']);

    f.thread(session.conversationRef).completeTurn();
    await expect.poll(() => record(f, session.id, second).state, { timeout: 5000, interval: 100 }).toBe('submitted');
    expect(record(f, session.id, third).state).toBe('queued');
    f.thread(session.conversationRef).completeTurn();
    await expect.poll(() => record(f, session.id, third).state, { timeout: 5000, interval: 100 }).toBe('submitted');
    expect(sentTexts(f, session.conversationRef)).toEqual(['first', 'second', 'third']);
    expect(f.row(session.id).queuedInputs).toBeUndefined();
  });

  it('delivers a submission id once, and refuses the same id for another message', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const requestId = randomUUID();
    const first = await send(f, session.id, 'only once', requestId);
    const again = await send(f, session.id, 'only once', requestId);
    expect(first.recordedUserInput).toMatchObject({ text: 'only once' });
    expect(again.queuedInput).toBeUndefined();
    expect(sentTexts(f, session.conversationRef)).toEqual(['only once']);
    await expect(send(f, session.id, 'something else', requestId)).rejects.toThrow(/already belongs to another message/);
  });

  it('cancels a queued message so it is never sent, and refuses to cancel one that was already sent', async () => {
    const f = fixture(QUEUEING);
    const { session } = await f.bindNew();
    const sent = randomUUID(), queued = randomUUID();
    await send(f, session.id, 'running', sent);
    await settle();
    await send(f, session.id, 'never mind', queued);

    await f.manager.cancelQueuedInput(session.id, queued);
    expect(record(f, session.id, queued).state).toBe('cancelled');
    expect(f.row(session.id).queuedInputs).toBeUndefined();
    await expect(f.manager.cancelQueuedInput(session.id, sent)).rejects.toThrow(/already started/);

    f.thread(session.conversationRef).completeTurn();
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(sentTexts(f, session.conversationRef)).toEqual(['running']);
  });

  it('cancels a send that a later Stop overtook before it reached the queue, and sends nothing', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const revision = new InputQueue(f.db.sqlite).revision(session.id);
    await f.manager.sendKeystrokes(session.id, { keys: ['Escape'] });
    const requestId = randomUUID();
    await expect(send(f, session.id, 'typed before Stop', requestId, revision)).rejects.toBeInstanceOf(SessionInputRejectedError);
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'cancelled' });
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
  });

  it('fails a message the backend was sending when it restarted, and never sends it again', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const requestId = randomUUID();
    new InputQueue(f.db.sqlite).put(session.id, { requestId, text: 'in flight', requestedAt: new Date().toISOString(), state: 'submitting', reason: 'Sending the message.' });

    const backend = await f.restartBackend();
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/server restarted during submission/) });
    expect(f.row(session.id).queuedInputs).toEqual([expect.objectContaining({ requestId, state: 'failed' })]);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(backend.plugin.instances.flatMap(instance => instance.sessions.flatMap(thread => thread.calls))
      .filter(call => call.method === 'sendTurn')).toHaveLength(0);

    // The person dismisses it.
    await backend.manager.cancelQueuedInput(session.id, requestId);
    expect(f.row(session.id).queuedInputs).toBeUndefined();
  });

  it('cancels unsent queued messages when the person suspends the session', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const requestId = randomUUID();
    new InputQueue(f.db.sqlite).put(session.id, { requestId, text: 'later', requestedAt: new Date().toISOString(), state: 'queued', reason: 'Waiting.' });

    await f.manager.suspendSession(session.id);
    expect(record(f, session.id, requestId).state).toBe('cancelled');
    expect(f.row(session.id).manualSuspendedAt).toBeTruthy();
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
  });

  it('holds a model switch while a message waits for the person to review it', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const requestId = randomUUID();
    new InputQueue(f.db.sqlite).put(session.id, { requestId, text: 'unclear', requestedAt: new Date().toISOString(), state: 'failed', reason: 'Submission could not be confirmed.' });

    await f.manager.requestModelProfile(session.id, 'low');
    await expect.poll(() => f.row(session.id).modelProfileRequest, { timeout: 2000, interval: 50 })
      .toMatchObject({ state: 'queued', deferredReason: 'unsent_input' });
    await f.manager.cancelQueuedInput(session.id, requestId);
    await f.manager.reconcileSessions();
    await expect.poll(() => f.row(session.id).codexProfile, { timeout: 2000, interval: 50 }).toBe('low');
  });
});
