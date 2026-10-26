import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CoordinationService } from '../src/coordination/service.js';
import { PEER_WAKE_PROMPT, UNATTENDED_CONTINUATION_PROMPT, peerWakeAttemptKey, type PeerWakeAttempt } from '../src/coordination/wake.js';
import { continuationControl, saveContinuation, signalContinuation } from '../src/coordination/continuation.js';
import { NotSentError, PreviousTurnActiveError } from '../src/providers/transport/types.js';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: StructuredSessionFixture[] = [];
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

/** A bound structured session whose thread is registered as a coordination recipient. */
async function wakeFixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  const { session } = await f.bindNew();
  const native = session.conversationRef;
  const makeService = (manager = f.manager) => new CoordinationService(f.db, { enabled: true, pilotPaths: [] }, () => { void manager.wakePendingAssignments(); });
  const service = makeService();
  const recipient = service.register({ provider: 'codex', nativeSessionId: native, token: randomUUID(), pid: process.pid, cwd: f.root }).assignmentId!;
  const sender = service.register({ provider: 'claude', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: f.root }).assignmentId!;
  const send = () => {
    const message = { priority: 'P1' as const, wakeReason: 'A critical assigned run is paused; answer now.', id: randomUUID(), recipientId: recipient, text: 'Please answer the question.' };
    service.send(sender, message);
    return message;
  };
  const attempt = (messageId: string) => {
    const stored = f.db.meta.get(peerWakeAttemptKey(messageId));
    return stored ? JSON.parse(stored) as PeerWakeAttempt : undefined;
  };
  const turnTexts = () => f.calls(native, 'sendTurn').map(call => (call.args[0] as { text: string }).text);
  return { f, session, native, service, recipient, sender, send, attempt, turnTexts };
}

describe('Structured peer wake delivery', () => {
  it('delivers the fixed wake notice as a new turn and keeps the attempt record', async () => {
    const w = await wakeFixture();
    const message = w.send();
    await w.f.manager.wakePendingAssignments();

    expect(w.turnTexts()).toEqual([PEER_WAKE_PROMPT]);
    expect(w.f.calls(w.native, 'sendTurn')[0]!.args[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(w.attempt(message.id)).toMatchObject({ status: 'submitted', sessionId: w.session.id, restoration: 'already_loaded' });
    await settle();
    expect(w.f.row(w.session.id).isWorking).toBe(true);
    expect(w.f.row(w.session.id).lastActivityAt).toBeTruthy();
    expect(eventLogLines(w.f.row(w.session.id)).some(line => line.type === 'status' && /peer-inbox response/.test(line.text))).toBe(true);
    // The notice is not typed into any terminal.
    expect(w.f.tmuxTouched()).toBe(0);

    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([PEER_WAKE_PROMPT]);
  });

  it('does not wake while a turn is running, then delivers once the turn ends', async () => {
    const w = await wakeFixture();
    await w.f.manager.sendInput(w.session.id, 'busy work');
    await settle();
    const message = w.send();
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual(['busy work']);
    expect(w.attempt(message.id)).toBeUndefined();

    w.f.thread(w.native).completeTurn();
    await settle();
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual(['busy work', PEER_WAKE_PROMPT]);
    expect(w.attempt(message.id)).toMatchObject({ status: 'submitted' });
  });

  it('defers without replay when the transport reports a turn already running', async () => {
    const w = await wakeFixture();
    const thread = w.f.thread(w.native);
    thread.sendTurn = async (input) => { thread.calls.push({ method: 'sendTurn', args: [input] }); throw new PreviousTurnActiveError(); };
    const message = w.send();
    await w.f.manager.wakePendingAssignments();
    expect(w.attempt(message.id)).toMatchObject({ status: 'deferred' });
    expect(w.attempt(message.id)?.nextAttemptAt).toBeTruthy();
    expect(w.f.row(w.session.id).isWorking).toBe(false);
  });

  it('defers when the transport reports nothing was sent, and delivers on the next attempt', async () => {
    const w = await wakeFixture();
    w.f.thread(w.native).failNextSend = new NotSentError('The Codex session has ended.');
    const message = w.send();
    await w.f.manager.wakePendingAssignments();
    // Certainly not delivered: no "delivery is uncertain" block, only a later attempt.
    expect(w.attempt(message.id)).toMatchObject({ status: 'deferred' });
    expect(w.attempt(message.id)?.nextAttemptAt).toBeTruthy();

    w.f.db.meta.set(peerWakeAttemptKey(message.id), JSON.stringify({ ...w.attempt(message.id), nextAttemptAt: new Date(Date.now() - 1).toISOString() }));
    await w.f.manager.wakePendingAssignments();
    expect(w.attempt(message.id)).toMatchObject({ status: 'submitted' });
    expect(w.turnTexts()).toEqual([PEER_WAKE_PROMPT, PEER_WAKE_PROMPT]);
  });

  it('records an uncertain transport failure and never replays it', async () => {
    const w = await wakeFixture();
    const thread = w.f.thread(w.native);
    thread.sendTurn = async (input) => { thread.calls.push({ method: 'sendTurn', args: [input] }); throw new Error('socket reset'); };
    const message = w.send();
    await w.f.manager.wakePendingAssignments();
    expect(w.attempt(message.id)).toMatchObject({ status: 'failed', reason: 'socket reset' });
    await w.f.manager.wakePendingAssignments();
    expect(w.f.calls(w.native, 'sendTurn')).toHaveLength(1);
  });

  it('reloads a sleeping thread before delivering and reports the restoration', async () => {
    const w = await wakeFixture();
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    w.f.db.sqlite.prepare('update bound_sessions set updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, started_at=? where id=?')
      .run(at, at, at, at, at, at, w.session.id);
    await w.f.manager.reconcileSessions();
    expect(w.f.row(w.session.id).idleSuspendedAt).toBeTruthy();

    const message = w.send();
    await w.f.manager.wakePendingAssignments();
    expect(w.f.plugin.instance!.calls.filter(call => call.method === 'resume')).toHaveLength(1);
    expect(w.attempt(message.id)).toMatchObject({ status: 'submitted', restoration: 'restored' });
    expect(w.f.row(w.session.id).idleSuspendedAt).toBeUndefined();
    expect(w.turnTexts()).toEqual([PEER_WAKE_PROMPT]);
    expect(w.f.tmuxTouched()).toBe(0);
  });

  it('loads the thread after a backend restart and delivers, never launching tmux', async () => {
    const w = await wakeFixture();
    const backend = await w.f.restartBackend();
    const message = w.send();
    await backend.manager.wakePendingAssignments();
    expect(backend.plugin.instance!.calls.find(call => call.method === 'resume')?.args[0]).toBe(w.native);
    expect(backend.plugin.instance!.sessions[0]!.calls.filter(call => call.method === 'sendTurn')).toHaveLength(1);
    expect(w.attempt(message.id)).toMatchObject({ status: 'submitted', restoration: 'restored' });
    expect(backend.tmux.created).toEqual([]);
  });

  it('does not wake a manually suspended session', async () => {
    const w = await wakeFixture();
    w.service.update(w.recipient, { status: 'waiting' });
    await w.f.manager.suspendSession(w.session.id);
    w.send();
    await w.f.manager.wakePendingAssignments();
    expect(w.f.calls(w.native, 'sendTurn')).toHaveLength(0);
  });

  it('does not deliver while a queued human message waits', async () => {
    const w = await wakeFixture({ plugin: { capabilities: { steer: 'none' } } });
    await w.f.manager.sendInput(w.session.id, 'first');
    await settle();
    await w.f.manager.sendKeystrokes(w.session.id, { submissionId: randomUUID(), text: 'queued', submittedText: 'queued', keys: ['Enter'] });
    const message = w.send();
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual(['first']);
    expect(w.attempt(message.id)).toBeUndefined();
  });
});

describe('Structured unattended continuation', () => {
  function due(w: Awaited<ReturnType<typeof wakeFixture>>) {
    const control = continuationControl(w.f.db, w.recipient);
    control.recovery!.nextAttemptAt = new Date(Date.now() - 1).toISOString();
    saveContinuation(w.f.db, w.recipient, control);
  }

  it('continues unfinished unattended work with the fixed continuation notice', async () => {
    const w = await wakeFixture();
    w.service.update(w.recipient, { continuation: 'unattended' });
    signalContinuation(w.f.db, w.recipient, { key: 'first', source: w.sender, timestamp: new Date().toISOString(), reason: 'Work ready' });
    await w.f.manager.wakePendingAssignments();
    due(w);
    await w.f.manager.wakePendingAssignments();

    expect(w.turnTexts()).toEqual([UNATTENDED_CONTINUATION_PROMPT]);
    expect(continuationControl(w.f.db, w.recipient).recovery).toMatchObject({ status: 'submitted' });
    expect(eventLogLines(w.f.row(w.session.id)).some(line => /unattended continuation/.test(line.text))).toBe(true);
    expect(w.f.tmuxTouched()).toBe(0);
  });
});
