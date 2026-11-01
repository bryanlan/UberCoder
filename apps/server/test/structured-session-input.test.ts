import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionCommandResult } from '../src/sessions/session-manager.js';
import { SessionInputRejectedError } from '../src/sessions/session-manager.js';
import type { QueuedInputRecord } from '../src/sessions/input-queue.js';
import { imagePromptSuffix, withoutImageInstruction } from '../src/images/prompt.js';
import { CoordinationService } from '../src/coordination/service.js';
import { peerWakeAttemptKey, peerWakePaused, type PeerWakeAttempt } from '../src/coordination/wake.js';
import { NotSentError, SendRejectedError, TurnNotActiveError } from '../src/providers/transport/types.js';
import { enableUnattendedRecovery } from './helpers/session-fixtures.js';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: StructuredSessionFixture[] = [];
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  return f;
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

function send(f: StructuredSessionFixture, sessionId: string, text: string, requestId: string = randomUUID()): Promise<SessionCommandResult> {
  return f.manager.sendKeystrokes(sessionId, { submissionId: requestId, text, submittedText: text, keys: ['Enter'] });
}
function record(f: StructuredSessionFixture, sessionId: string, requestId: string): QueuedInputRecord {
  return JSON.parse(f.db.meta.get(`session-input:${sessionId}:${requestId}`)!) as QueuedInputRecord;
}

describe('Structured human input', () => {
  it('starts a turn when idle, journaling the message from queued to submitted with its turn id', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const requestId = randomUUID();
    const result = await send(f, session.id, 'Refactor the parser', requestId);

    expect(result.queuedInput).toBeUndefined();
    expect(result.recordedUserInput).toMatchObject({ text: 'Refactor the parser' });
    const turn = f.calls(session.conversationRef, 'sendTurn');
    expect(turn).toHaveLength(1);
    expect(turn[0]!.args[0]).toMatchObject({ text: 'Refactor the parser', model: 'gpt-6.1-sol', effort: 'xhigh', clientMessageId: requestId });
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'submitted', turnId: 'turn-1', deliveryMode: 'turn' });
    expect(eventLogLines(f.row(session.id)).filter(line => line.type === 'user-input').map(line => line.text)).toEqual(['Refactor the parser']);
    expect(f.row(session.id).lastActivityAt).toBeTruthy();
    await settle();
    expect(f.row(session.id).isWorking).toBe(true);
  });

  it('steers the running turn instead of starting another', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    const requestId = randomUUID();
    const result = await send(f, session.id, 'and also this', requestId);

    expect(result.queuedInput).toBeUndefined();
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);
    expect(f.calls(session.conversationRef, 'steer')).toHaveLength(1);
    expect(f.calls(session.conversationRef, 'steer')[0]!.args[0]).toBe('turn-1');
    expect(f.calls(session.conversationRef, 'steer')[0]!.args[1]).toMatchObject({ text: 'and also this' });
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'submitted', turnId: 'turn-1', deliveryMode: 'steer' });
    expect(eventLogLines(f.row(session.id)).filter(line => line.type === 'user-input')).toHaveLength(2);
  });

  it('starts a new turn when the steer loses the race with the end of the turn', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    // The provider finished the turn but the host has not seen the terminal yet.
    f.thread(session.conversationRef).activeTurnId = undefined;
    const requestId = randomUUID();
    await send(f, session.id, 'late follow-up', requestId);

    expect(f.calls(session.conversationRef, 'steer')).toHaveLength(1);
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(2);
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'submitted', turnId: 'turn-2', deliveryMode: 'turn' });
  });

  it('falls back on a lost steer race the plugin reports as TurnNotActiveError', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    const thread = f.thread(session.conversationRef);
    thread.steer = async (turnId, input) => {
      thread.calls.push({ method: 'steer', args: [turnId, input] });
      thread.activeTurnId = undefined;
      throw new TurnNotActiveError(turnId);
    };
    await send(f, session.id, 'racing message');
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(2);
  });

  it('never sends a refused steer again as a new turn, whatever its message says', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    const thread = f.thread(session.conversationRef);
    thread.steer = async (turnId, input) => {
      thread.calls.push({ method: 'steer', args: [turnId, input] });
      // Wording the old matcher took for "the turn is gone": only the typed error may mean that now.
      throw new Error('The turn has already completed according to this refusal.');
    };
    const requestId = randomUUID();
    await send(f, session.id, 'refused message', requestId);
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/could not be confirmed/i) });
  });

  it('does not resend a steer of unknown outcome when the turn ended while it was in flight', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    const thread = f.thread(session.conversationRef);
    thread.steer = async (turnId, input) => {
      thread.calls.push({ method: 'steer', args: [turnId, input] });
      thread.completeTurn('completed'); // the terminal reaches the host while the steer is pending
      await settle();
      throw new Error('turn/steer did not answer within 60000 ms.');
    };
    const requestId = randomUUID();
    await send(f, session.id, 'maybe delivered', requestId);
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);
    expect(record(f, session.id, requestId).state).toBe('failed');
  });

  it('queues a message the transport reports as never sent, then delivers it, instead of marking it unconfirmed', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    f.thread(session.conversationRef).failNextSend = new NotSentError('The Codex session has ended.');
    const requestId = randomUUID();
    const result = await send(f, session.id, 'try again please', requestId);
    expect(result.queuedInput).toMatchObject({ requestId, state: 'queued' });
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'queued', reason: 'Waiting for the session to accept the message.' });
    await expect.poll(() => record(f, session.id, requestId).state, { timeout: 5000, interval: 100 }).toBe('submitted');
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(2);
  });

  it('fails a message the provider can never accept, with the reason, instead of retrying it every second', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const thread = f.thread(session.conversationRef);
    const rejected = new SendRejectedError('The message could not be sent: set_model: Model opus-9 is not available');
    const real = thread.sendTurn.bind(thread);
    thread.sendTurn = async input => {
      thread.calls.push({ method: 'sendTurn', args: [input] });
      throw rejected;
    };
    const requestId = randomUUID();
    const result = await send(f, session.id, 'use the new model', requestId);

    expect(result.queuedInput).toMatchObject({ requestId, state: 'failed', reason: rejected.message });
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'failed', reason: rejected.message });
    // Nothing retries it: no timer is left to send it again, and a later message waits behind it for the person to decide.
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);
    expect(record(f, session.id, requestId).state).toBe('failed');
    thread.sendTurn = real;
  });

  it('rejects a direct send the provider can never accept as input that was not sent', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const thread = f.thread(session.conversationRef);
    thread.sendTurn = async input => {
      thread.calls.push({ method: 'sendTurn', args: [input] });
      throw new SendRejectedError('The message could not be sent: the image could not be read.');
    };
    await expect(f.manager.sendInput(session.id, 'look at this')).rejects.toThrow(/image could not be read.*Nothing was sent/);
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);
  });

  it('stops retrying a message the transport keeps refusing before it writes anything, after 10 minutes', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const thread = f.thread(session.conversationRef);
    thread.sendTurn = async input => {
      thread.calls.push({ method: 'sendTurn', args: [input] });
      throw new NotSentError('The fake connection is down.');
    };
    const requestId = randomUUID();
    const result = await send(f, session.id, 'send me when you can', requestId);
    expect(result.queuedInput).toMatchObject({ requestId, state: 'queued' });
    const first = record(f, session.id, requestId);
    expect(first).toMatchObject({ state: 'queued', reason: 'Waiting for the session to accept the message.' });
    expect(Date.parse(first.notSentSince!)).toBeLessThanOrEqual(Date.now());

    // A run of refusals that began a little under 10 minutes ago does not end the wait: the message is still retried.
    const age = (ms: number) => f.db.meta.set(`session-input:${session.id}:${requestId}`, JSON.stringify({ ...record(f, session.id, requestId), notSentSince: new Date(Date.now() - ms).toISOString() }));
    age(9 * 60_000);
    await expect.poll(() => f.calls(session.conversationRef, 'sendTurn').length, { timeout: 5000, interval: 100 }).toBeGreaterThan(1);
    expect(record(f, session.id, requestId).state).toBe('queued');
    expect(Date.now() - Date.parse(record(f, session.id, requestId).notSentSince!)).toBeGreaterThan(8.5 * 60_000); // the run keeps its start

    // Past 10 minutes of refusals the message fails, with the reason, and nothing retries it.
    age(10 * 60_000 + 1_000);
    await expect.poll(() => record(f, session.id, requestId).state, { timeout: 5000, interval: 100 }).toBe('failed');
    // The reason keeps the last refusal and says nothing was sent; it does not send the person to check for a message that never left.
    expect(record(f, session.id, requestId).reason).toMatch(/could not be sent for 10 minutes \(The fake connection is down\.\)\. Nothing was sent\./);
    expect(record(f, session.id, requestId).reason).not.toMatch(/Check the conversation/);
    expect(f.row(session.id).queuedInputs?.find(item => item.requestId === requestId)).toMatchObject({ state: 'failed' });
    const attempts = f.calls(session.conversationRef, 'sendTurn').length;
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(attempts);
  });

  it('does not count a wait for the session itself: while it is suspended or cannot be loaded, the run of refusals starts over', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const thread = f.thread(session.conversationRef);
    thread.sendTurn = async input => {
      thread.calls.push({ method: 'sendTurn', args: [input] });
      throw new NotSentError('The fake connection is down.');
    };
    const requestId = randomUUID();
    await send(f, session.id, 'send me when you can', requestId);
    expect(record(f, session.id, requestId).notSentSince).toBeTruthy();
    // The run of refusals began almost 10 minutes ago.
    f.db.meta.set(`session-input:${session.id}:${requestId}`, JSON.stringify({ ...record(f, session.id, requestId), notSentSince: new Date(Date.now() - 9.9 * 60_000).toISOString() }));

    // Memory pressure puts the session to sleep: the message waits for the session, which is not a refusal by the transport.
    f.db.boundSessions.setPressureSuspendedAt(session.id, new Date().toISOString());
    await expect.poll(() => record(f, session.id, requestId).reason, { timeout: 5000, interval: 100 }).toBe('Waiting for the session to resume.');
    expect(record(f, session.id, requestId).notSentSince).toBeUndefined();

    // It comes back, and the transport refuses again: a new run starts instead of the old one failing the message at once.
    f.db.boundSessions.setPressureSuspendedAt(session.id, undefined);
    await expect.poll(() => record(f, session.id, requestId).notSentSince, { timeout: 5000, interval: 100 }).toBeTruthy();
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'queued', reason: 'Waiting for the session to accept the message.' });
    expect(Date.now() - Date.parse(record(f, session.id, requestId).notSentSince!)).toBeLessThan(60_000);
  });

  it('does not count the wait for a running turn as refusals: the run of refusals starts again afterwards', async () => {
    const f = fixture({ plugin: { capabilities: { steer: 'none' } } });
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    const requestId = randomUUID();
    await send(f, session.id, 'wait for the turn', requestId);
    // Hours of waiting for a turn are not a failure to send.
    f.db.meta.set(`session-input:${session.id}:${requestId}`, JSON.stringify({ ...record(f, session.id, requestId), notSentSince: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(record(f, session.id, requestId).state).toBe('queued');
    expect(record(f, session.id, requestId).notSentSince).toBeUndefined();
  });

  it('queues a steer the transport reports as never sent, then delivers it as a steer, instead of marking it unconfirmed', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    const thread = f.thread(session.conversationRef);
    const steer = thread.steer.bind(thread);
    let attempts = 0;
    thread.steer = async (turnId, input) => {
      attempts += 1;
      if (attempts > 1) return steer(turnId, input);
      thread.calls.push({ method: 'steer', args: [turnId, input] });
      throw new NotSentError('The Codex session has ended.'); // refused before the frame was written
    };
    const requestId = randomUUID();
    const result = await send(f, session.id, 'steer me later', requestId);
    expect(result.queuedInput).toMatchObject({ requestId, state: 'queued' });
    expect(record(f, session.id, requestId)).toMatchObject({ state: 'queued', reason: 'Waiting for the session to accept the message.' });

    await expect.poll(() => record(f, session.id, requestId).state, { timeout: 5000, interval: 100 }).toBe('submitted');
    expect(record(f, session.id, requestId)).toMatchObject({ turnId: 'turn-1', deliveryMode: 'steer' });
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1); // the text was never sent as a second turn
  });

  it('keeps a message queued while a provider that cannot steer is busy, then sends it after the turn', async () => {
    const f = fixture({ plugin: { capabilities: { steer: 'none' } } });
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    const requestId = randomUUID();
    const result = await send(f, session.id, 'wait your turn', requestId);

    expect(result.queuedInput).toMatchObject({ requestId, state: 'queued' });
    expect(f.calls(session.conversationRef, 'steer')).toHaveLength(0);
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);

    f.thread(session.conversationRef).completeTurn();
    await expect.poll(() => record(f, session.id, requestId).state, { timeout: 5000, interval: 100 }).toBe('submitted');
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(2);
  });

  it('delivers an old queued message to a sleeping session by waking it', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    f.db.sqlite.prepare('update bound_sessions set updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, started_at=? where id=?')
      .run(at, at, at, at, at, at, session.id);
    await f.manager.reconcileSessions();
    expect(f.row(session.id).idleSuspendedAt).toBeTruthy();

    const requestId = randomUUID();
    await send(f, session.id, 'are you there', requestId);
    expect(record(f, session.id, requestId).state).toBe('submitted');
    expect(f.plugin.instance!.calls.filter(call => call.method === 'resume')).toHaveLength(1);
    expect(f.row(session.id).idleSuspendedAt).toBeUndefined();
  });

  it('holds the message when the thread cannot be reloaded and does not mark it failed', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await f.plugin.instance!.dispose('restart');
    await settle();
    // Every later instance refuses to resume.
    const originalCreate = f.plugin.create.bind(f.plugin);
    f.plugin.create = (config, context) => { const instance = originalCreate(config, context); instance.failResume = true; return instance; };
    const requestId = randomUUID();
    const result = await send(f, session.id, 'cannot reach you', requestId);
    expect(result.queuedInput).toMatchObject({ requestId });
    expect(record(f, session.id, requestId).state).toBe('queued');
  });

  it('sends direct input and text with Enter outside the queue', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const direct = await f.manager.sendInput(session.id, 'via input route');
    expect(direct.recordedUserInput).toMatchObject({ text: 'via input route' });
    f.thread(session.conversationRef).completeTurn();
    await settle();
    await f.manager.sendKeystrokes(session.id, { text: 'plain enter', keys: ['Enter'] });
    expect(f.calls(session.conversationRef, 'sendTurn').map(call => (call.args[0] as { text: string }).text)).toEqual(['via input route', 'plain enter']);
  });

  it('treats a numeric message as ordinary text', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, '1');
    expect(f.calls(session.conversationRef, 'sendTurn')[0]!.args[0]).toMatchObject({ text: '1' });
  });
});

describe('Structured Stop', () => {
  it('interrupts the running turn and records a late completed terminal as interrupted', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'long job');
    await settle();
    const assignment = enableUnattendedRecovery(f.db, 'codex', session.conversationRef);
    const result = await f.manager.sendKeystrokes(session.id, { keys: ['Escape'] });

    expect(result.session.lastActivityAt).toBeTruthy();
    expect(peerWakePaused(f.db, assignment)).toBe(true);
    expect(f.calls(session.conversationRef, 'interrupt')).toHaveLength(1);
    expect(f.calls(session.conversationRef, 'interrupt')[0]!.args[0]).toBe('turn-1');

    // Some providers still end a stopped turn as "completed".
    f.thread(session.conversationRef).completeTurn('completed');
    await settle();
    expect(f.row(session.id)).toMatchObject({ isWorking: false, lastResponseAt: undefined });
    expect(f.manager['runRecovery'].getRunState(session.id)).toMatchObject({ status: 'cancelled' });
  });

  it('is a no-op when nothing is running and cancels queued messages', async () => {
    const f = fixture({ plugin: { capabilities: { steer: 'none' } } });
    const { session } = await f.bindNew();
    await f.manager.sendKeystrokes(session.id, { keys: ['Escape'] });
    expect(f.calls(session.conversationRef, 'interrupt')).toHaveLength(0);

    await send(f, session.id, 'first');
    await settle();
    const requestId = randomUUID();
    await send(f, session.id, 'queued behind', requestId);
    await f.manager.sendKeystrokes(session.id, { keys: ['Escape'] });
    expect(record(f, session.id, requestId).state).toBe('cancelled');
    expect(f.calls(session.conversationRef, 'interrupt')).toHaveLength(1);
  });
});

describe('Structured input that has no meaning without a terminal', () => {
  const rejected = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionInputRejectedError);
    expect((error as SessionInputRejectedError).statusCode).toBe(409);
    return (error as Error).message;
  };

  it.each([['Tab'], ['Up'], ['Left'], ['BSpace'], ['C-c']])('rejects the %s key with the message-or-Stop contract, without pausing automatic input', async key => {
    const f = fixture();
    const { session } = await f.bindNew();
    const assignment = enableUnattendedRecovery(f.db, 'codex', session.conversationRef);
    const message = await rejected(f.manager.sendKeystrokes(session.id, { keys: [key] }));
    expect(message).toMatch(/complete messages and Stop/);
    expect(peerWakePaused(f.db, assignment)).toBe(false);
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
    expect(f.calls(session.conversationRef, 'interrupt')).toHaveLength(0);
  });

  it('rejects per-keystroke text, text with a non-Enter key and Escape with text', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await rejected(f.manager.sendKeystrokes(session.id, { text: 'typing' }));
    await rejected(f.manager.sendKeystrokes(session.id, { text: '1', keys: ['Down'] }));
    await rejected(f.manager.sendKeystrokes(session.id, { text: 'x', keys: ['Escape'] }));
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
  });

  it('rejects a message that is only a slash command, on every submit path', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await rejected(send(f, session.id, '/compact'));
    await rejected(send(f, session.id, '  /model  '));
    await rejected(f.manager.sendInput(session.id, '/status'));
    await rejected(f.manager.sendKeystrokes(session.id, { text: '/review', keys: ['Enter'] }));
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
  });

  it('accepts ordinary messages that merely start with a slash', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, '/tmp is full');
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);
    f.thread(session.conversationRef).completeTurn();
    await settle();
    await send(f, session.id, '/home/bryan/code/app/main.ts needs a look');
    expect(f.calls(session.conversationRef, 'sendTurn').map(call => (call.args[0] as { text: string }).text))
      .toEqual(['/tmp is full', '/home/bryan/code/app/main.ts needs a look']);
  });

  describe('image attachments', () => {
    const IMAGE_STORE = '/data/images';
    const imageRow = (directory = IMAGE_STORE) => {
      const id = randomUUID();
      return { id, mediaType: 'image/png' as const, name: 'shot.png', sizeBytes: 10, width: 4, height: 4, path: `${directory}/${id}.png` };
    };
    const withImages = (rows: Array<ReturnType<typeof imageRow>>) => `Look at this${imagePromptSuffix(rows, 'codex')}`;
    const imageFixture = () => fixture({ plugin: { capabilities: { images: true } }, manager: { imageStoreDir: IMAGE_STORE } });

    it('hands the stored files to a transport that takes images, without telling the model to open them again', async () => {
      const f = imageFixture();
      const { session } = await f.bindNew();
      const [a, b] = [imageRow(), imageRow()];
      const text = withImages([a, b]);
      const requestId = randomUUID();
      const result = await send(f, session.id, text, requestId);

      expect(result.queuedInput).toBeUndefined();
      const turn = f.calls(session.conversationRef, 'sendTurn');
      expect(turn).toHaveLength(1);
      const sent = turn[0]!.args[0] as { text: string };
      expect(sent).toMatchObject({
        images: [{ path: a.path, mimeType: 'image/png' }, { path: b.path, mimeType: 'image/png' }],
        clientMessageId: requestId,
      });
      // The model gets the images natively. The line that tells a terminal agent to open the files is not sent (each image would
      // be read, and charged, twice), but the envelope rows still are.
      expect(sent.text).toBe(withoutImageInstruction(text));
      expect(sent.text).not.toContain('Inspect the attached local image files');
      expect(sent.text).toContain(`"id":"${a.id}"`);
      expect(sent.text).toContain(`"id":"${b.id}"`);
      // What the Console stores and shows is unchanged: the journal and the conversation log keep the whole message.
      expect(record(f, session.id, requestId)).toMatchObject({ state: 'submitted', turnId: 'turn-1', deliveryMode: 'turn', text });
      expect(eventLogLines(f.row(session.id)).filter(line => line.type === 'user-input').map(line => line.text)).toEqual([text]);
    });

    it('judges a caption without its image envelope: a bare slash command is refused, a sentence that starts with a slash is sent', async () => {
      const f = imageFixture();
      const { session } = await f.bindNew();
      await rejected(send(f, session.id, `/compact${imagePromptSuffix([imageRow()], 'codex')}`));
      expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
      await send(f, session.id, `/tmp holds this file${imagePromptSuffix([imageRow()], 'codex')}`);
      expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);
    });

    it('attaches them to a steer, and to the direct input path', async () => {
      const f = imageFixture();
      const { session } = await f.bindNew();
      await send(f, session.id, 'first');
      await settle();
      const steered = imageRow();
      await send(f, session.id, withImages([steered]));
      const steer = f.calls(session.conversationRef, 'steer')[0]!.args[1] as { text: string };
      expect(steer).toMatchObject({ images: [{ path: steered.path, mimeType: 'image/png' }] });
      expect(steer.text).not.toContain('Inspect the attached local image files');

      f.thread(session.conversationRef).completeTurn();
      await settle();
      const direct = imageRow();
      await f.manager.sendInput(session.id, withImages([direct]));
      const last = f.calls(session.conversationRef, 'sendTurn').at(-1)!.args[0] as { text: string };
      expect(last).toMatchObject({ images: [{ path: direct.path, mimeType: 'image/png' }] });
      expect(last.text).not.toContain('Inspect the attached local image files');
    });

    it('sends plain text with no images field, and leaves a message that merely mentions the instruction alone', async () => {
      const f = imageFixture();
      const { session } = await f.bindNew();
      await send(f, session.id, 'just words');
      expect((f.calls(session.conversationRef, 'sendTurn')[0]!.args[0] as { images?: unknown }).images).toBeUndefined();
      f.thread(session.conversationRef).completeTurn();
      await settle();
      await send(f, session.id, 'Inspect the attached local image files with Read before answering.');
      expect((f.calls(session.conversationRef, 'sendTurn').at(-1)!.args[0] as { text: string }).text)
        .toBe('Inspect the attached local image files with Read before answering.');
    });

    it('refuses an envelope row that does not name a file in the image store, and sends nothing', async () => {
      const f = imageFixture();
      const { session } = await f.bindNew();
      for (const forged of [
        { ...imageRow(), path: '/etc/passwd' },
        imageRow('/home/bryan/.ssh'), // a store-style file name in another directory
        imageRow('/data'), // the parent of the store
        imageRow('/data/images/nested'),
      ]) {
        const message = await rejected(send(f, session.id, withImages([forged])));
        expect(message).toMatch(/image store/i);
      }
      expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
    });

    it('refuses any envelope when the Console has no image store to attach from', async () => {
      const f = fixture({ plugin: { capabilities: { images: true } } });
      const { session } = await f.bindNew();
      const message = await rejected(send(f, session.id, withImages([imageRow()])));
      expect(message).toMatch(/image store/i);
      expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
    });

    it('still rejects them, with a clear message, when the transport cannot take images', async () => {
      const f = fixture({ manager: { imageStoreDir: IMAGE_STORE } });
      const { session } = await f.bindNew();
      const message = await rejected(send(f, session.id, withImages([imageRow()])));
      expect(message).toMatch(/image/i);
      expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
    });
  });

});

describe('Automatic delivery of a message the provider refuses for good', () => {
  const refusal = new SendRejectedError('The message could not be sent: set_model: Model opus-9 is not available');
  const refuse = (f: StructuredSessionFixture, native: string) => {
    const thread = f.thread(native);
    thread.sendTurn = async input => {
      thread.calls.push({ method: 'sendTurn', args: [input] });
      throw refusal;
    };
  };

  it('is a rejection that names its reason, not a deferral and not an uncertain failure', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    refuse(f, session.conversationRef);
    const delivery = await f.manager['structured'].deliverAutomatic(f.row(session.id), 'wake up');
    expect(delivery).toEqual({ status: 'rejected', reason: refusal.message });
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);

    // The other refusals keep their meaning.
    const thread = f.thread(session.conversationRef);
    thread.sendTurn = async input => { thread.calls.push({ method: 'sendTurn', args: [input] }); throw new NotSentError('The fake connection is down.'); };
    expect(await f.manager['structured'].deliverAutomatic(f.row(session.id), 'wake up')).toMatchObject({ status: 'deferred' });
    thread.sendTurn = async input => { thread.calls.push({ method: 'sendTurn', args: [input] }); throw new Error('socket reset'); };
    expect(await f.manager['structured'].deliverAutomatic(f.row(session.id), 'wake up')).toMatchObject({ status: 'failed', reason: 'socket reset' });
  });

  it('stops a peer wake with the reason and without calling the delivery uncertain, and never sends it again', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    refuse(f, native);
    const service = new CoordinationService(f.db, { enabled: true, pilotPaths: [] }, () => { void f.manager.wakePendingAssignments(); });
    const recipient = service.register({ provider: 'codex', nativeSessionId: native, token: randomUUID(), pid: process.pid, cwd: f.root }).assignmentId!;
    const sender = service.register({ provider: 'claude', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: f.root }).assignmentId!;
    const message = { priority: 'P1' as const, wakeReason: 'A critical assigned run is paused; answer now.', id: randomUUID(), recipientId: recipient, text: 'Please answer the question.' };
    service.send(sender, message);
    await f.manager.wakePendingAssignments();

    const attempt = JSON.parse(f.db.meta.get(peerWakeAttemptKey(message.id))!) as PeerWakeAttempt;
    expect(attempt).toMatchObject({ status: 'failed', reason: refusal.message });
    const lines = eventLogLines(f.row(session.id)).filter(line => line.type === 'status').map(line => line.text);
    expect(lines).toContain(`Automatic inbox input was not sent, and sending it again would fail the same way: ${refusal.message}`);
    expect(lines.some(line => /uncertain delivery/.test(line))).toBe(false);
    await f.manager.wakePendingAssignments();
    expect(f.calls(native, 'sendTurn')).toHaveLength(1);
  });
});
