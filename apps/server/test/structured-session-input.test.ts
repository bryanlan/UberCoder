import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionCommandResult } from '../src/sessions/session-manager.js';
import { SessionInputRejectedError } from '../src/sessions/session-manager.js';
import type { QueuedInputRecord } from '../src/sessions/input-queue.js';
import { imagePromptSuffix } from '../src/images/prompt.js';
import { peerWakePaused } from '../src/coordination/wake.js';
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
    expect(f.tmuxTouched()).toBe(0);
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

  it('falls back on a plugin-coded lost steer race too', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await send(f, session.id, 'first');
    await settle();
    const thread = f.thread(session.conversationRef);
    thread.steer = async (turnId, input) => {
      thread.calls.push({ method: 'steer', args: [turnId, input] });
      thread.activeTurnId = undefined;
      throw Object.assign(new Error('The turn ended first.'), { code: 'turn_already_completed' });
    };
    await send(f, session.id, 'racing message');
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(2);
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
    expect(f.tmuxTouched()).toBe(0);
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

  it.each([['Tab'], ['Up'], ['Left'], ['BSpace'], ['C-c']])('rejects the %s key naming the structured transport, without pausing automatic input', async key => {
    const f = fixture();
    const { session } = await f.bindNew();
    const assignment = enableUnattendedRecovery(f.db, 'codex', session.conversationRef);
    const message = await rejected(f.manager.sendKeystrokes(session.id, { keys: [key] }));
    expect(message).toMatch(/structured/i);
    expect(peerWakePaused(f.db, assignment)).toBe(false);
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
    expect(f.calls(session.conversationRef, 'interrupt')).toHaveLength(0);
    expect(f.tmuxTouched()).toBe(0);
  });

  it('rejects per-keystroke text, text with a non-Enter key and Escape with text', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await rejected(f.manager.sendKeystrokes(session.id, { text: 'typing', deferScreenUpdate: true }));
    await rejected(f.manager.sendKeystrokes(session.id, { text: '1', keys: ['Down'] }));
    await rejected(f.manager.sendKeystrokes(session.id, { text: 'x', keys: ['Escape'] }));
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
  });

  it('rejects slash commands on every submit path', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    await rejected(send(f, session.id, '/compact'));
    await rejected(send(f, session.id, '/model gpt-6'));
    await rejected(f.manager.sendInput(session.id, '/status'));
    await rejected(f.manager.sendKeystrokes(session.id, { text: '/review', keys: ['Enter'] }));
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
    // A file path is a normal message.
    await send(f, session.id, '/home/bryan/code/app/main.ts needs a look');
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(1);
  });

  it('rejects image attachments with a clear message', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    const text = `Look at this${imagePromptSuffix([{ id: randomUUID(), mediaType: 'image/png', name: 'shot.png', sizeBytes: 10, width: 4, height: 4, path: '/tmp/shot.png' }], 'codex')}`;
    const message = await rejected(send(f, session.id, text));
    expect(message).toMatch(/image/i);
    expect(f.calls(session.conversationRef, 'sendTurn')).toHaveLength(0);
  });

  it('never answers a literal selection check with a pane capture', async () => {
    const f = fixture();
    const { session } = await f.bindNew();
    expect(await f.manager.allowsLiteralSelectionKeystroke(session.id, '2')).toBe(false);
    expect(f.tmux.captureStartLines).toEqual([]);
  });
});
