import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoordinationService } from '../src/coordination/service.js';
import { PEER_WAKE_PROMPT, UNATTENDED_CONTINUATION_PROMPT, scheduledWakePrompt, peerWakeAttemptKey, type PeerWakeAttempt } from '../src/coordination/wake.js';
import { continuationControl, saveContinuation, signalContinuation } from '../src/coordination/continuation.js';
import { dispatchCoordination } from '../src/coordination/transport.js';
import { parseCodexConversationFile } from '../src/providers/transcripts/codex.js';
import { NotSentError, PreviousTurnActiveError } from '../src/providers/transport/types.js';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: StructuredSessionFixture[] = [];
afterEach(async () => { vi.useRealTimers(); for (const f of open.splice(0)) await f.cleanup(); });

/** A bound structured session whose thread is registered as a coordination recipient. */
async function wakeFixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  const { session } = await f.bindNew();
  const native = session.conversationRef;
  const makeService = (manager = f.manager) => new CoordinationService(f.db, { enabled: true, pilotPaths: [] }, () => { void manager.wakePendingAssignments(); });
  const service = makeService();
  const token = randomUUID();
  const recipient = service.register({ provider: 'codex', nativeSessionId: native, token, pid: process.pid, cwd: f.root }).assignmentId!;
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
  return { f, session, native, service, recipient, token, sender, send, attempt, turnTexts };
}

describe('Structured peer wake delivery', () => {
  it('delivers the fixed wake notice as a new turn and keeps the attempt record', async () => {
    const w = await wakeFixture();
    const message = w.send();
    await w.f.manager.wakePendingAssignments();

    expect(w.turnTexts()).toEqual([PEER_WAKE_PROMPT]);
    expect(w.f.calls(w.native, 'sendTurn')[0]!.args[0]).toMatchObject({ model: 'gpt-6.1-terra', effort: 'high' });
    expect(w.attempt(message.id)).toMatchObject({ status: 'submitted', sessionId: w.session.id, restoration: 'already_loaded' });
    await settle();
    expect(w.f.row(w.session.id).isWorking).toBe(true);
    expect(w.f.row(w.session.id).lastActivityAt).toBeTruthy();
    expect(eventLogLines(w.f.row(w.session.id)).some(line => line.type === 'status' && /peer-inbox response/.test(line.text))).toBe(true);
    // The notice is not typed into any terminal.

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
  });

  it('loads the thread after a backend restart and delivers, never launching tmux', async () => {
    const w = await wakeFixture();
    const backend = await w.f.restartBackend();
    const message = w.send();
    await backend.manager.wakePendingAssignments();
    expect(backend.plugin.instance!.calls.find(call => call.method === 'resume')?.args[0]).toBe(w.native);
    expect(backend.plugin.instance!.sessions[0]!.calls.filter(call => call.method === 'sendTurn')).toHaveLength(1);
    expect(w.attempt(message.id)).toMatchObject({ status: 'submitted', restoration: 'restored' });
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
  });
});

describe('Scheduled same-session wake', () => {
  const objective = 'Verify the original assignment and cancel when complete.';
  const notice = scheduledWakePrompt(objective);
  const intervalSeconds = 1800;

  async function scheduledFixture(awaiting?: string, options: Parameters<typeof wakeFixture>[0] = {}) {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await wakeFixture(options);
    const rpc = (input: object = {}) => dispatchCoordination(w.service, {
      ...input, action: 'self_wake', assignmentId: w.recipient, token: w.token,
    });
    const input = { intervalSeconds, objective };
    await expect(rpc({ schedule: input })).rejects.toThrow('unattended');
    w.service.update(w.recipient, { continuation: 'unattended', awaiting });
    const start = Date.now();
    expect(await rpc({ schedule: input })).toMatchObject({
      schedule: { ...input, state: 'scheduled', sessionId: w.session.id, nextWakeAt: new Date(start + 1_800_000).toISOString() },
    });
    return { ...w, rpc, start, input, setTime: (elapsed: number) => vi.setSystemTime(start + elapsed) };
  }

  it('starts one objective turn in the same idle session per elapsed interval, even during an external wait', async () => {
    const w = await scheduledFixture('Waiting for the worker result');
    w.setTime(1_799_999);
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([]);
    expect(w.f.row(w.session.id).isWorking).toBe(false);

    w.setTime(1_800_000);
    await Promise.all([w.f.manager.wakePendingAssignments(), w.f.manager.wakePendingAssignments()]);
    expect(w.turnTexts()).toEqual([notice]);
    expect(w.f.row(w.session.id)).toMatchObject({ id: w.session.id, conversationRef: w.native, isWorking: true });
    expect(eventLogLines(w.f.row(w.session.id))).toContainEqual(expect.objectContaining({
      type: 'status', text: 'Started scheduled objective reminder.',
    }));
    expect(continuationControl(w.f.db, w.recipient)).toMatchObject({
      continuation: 'unattended', awaiting: { description: 'Waiting for the worker result' }, recovery: null,
    });
    expect(await w.rpc()).toMatchObject({ schedule: { lastSubmittedAt: new Date(w.start + 1_800_000).toISOString() } });
    expect(w.f.db.sqlite.prepare('select count(*) as count from coordination_messages').get()).toEqual({ count: 0 });

    // A busy turn spans multiple due times. Its completion permits one reminder.
    w.setTime(5_400_000);
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([notice]);
    w.f.thread(w.native).completeTurn();
    await settle();
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([notice, notice]);
    expect(await w.rpc()).toMatchObject({ schedule: { nextWakeAt: new Date(w.start + 7_200_000).toISOString() } });

    // Manual cancel clears the schedule across recurring wake passes.
    expect(await w.rpc({ schedule: null })).toEqual({ schedule: null });
    w.f.thread(w.native).completeTurn();
    await settle();
    w.setTime(7_200_000);
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([notice, notice]);
  });

  it('runs at its own cadence without an await and respects an explicit need for input', async () => {
    const w = await scheduledFixture();
    w.setTime(1_799_999);
    await w.f.manager.wakePendingAssignments();
    expect(continuationControl(w.f.db, w.recipient).recovery).toBeNull();
    expect(w.turnTexts()).toEqual([]);
    w.service.update(w.recipient, { continuation: 'waiting_for_input' });
    w.setTime(1_800_000);
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([]);
    w.service.update(w.recipient, { continuation: 'unattended' });
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([notice]);
  });

  it('keeps a due reminder paused by human Stop', async () => {
    const w = await scheduledFixture();
    await w.f.manager.sendKeystrokes(w.session.id, { keys: ['Escape'] });
    w.setTime(1_800_000);
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([]);
    expect(w.f.row(w.session.id).isWorking).toBe(false);
    expect(continuationControl(w.f.db, w.recipient).continuation).toBe('waiting_for_input');
    expect(await w.rpc()).toMatchObject({ schedule: { state: 'scheduled' } });
  });

  it.each(['task done', 'assignment finish'])('clears the schedule on %s', async (completion) => {
    const w = await scheduledFixture();
    if (completion === 'task done') {
      w.service.update(w.recipient, { task: { state: 'done', deliverable: objective, doneWhen: 'Verified', evidencePath: 'proof.json' } });
    } else {
      w.service.finish(w.recipient, 'Verified');
    }
    expect(await w.rpc()).toEqual({ schedule: null });
    w.setTime(1_800_000);
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([]);
  });

  it('defers to an eligible peer wake and preserves the reminder', async () => {
    const w = await scheduledFixture();
    w.setTime(1_800_000);
    w.send();
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([PEER_WAKE_PROMPT]);
    expect(await w.rpc()).toMatchObject({ schedule: { nextWakeAt: new Date(w.start + 1_800_000).toISOString() } });
    w.f.thread(w.native).completeTurn();
    await settle();
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([PEER_WAKE_PROMPT, notice]);
  });

  it('does not recreate a schedule cancelled during provider submission', async () => {
    const w = await scheduledFixture();
    const thread = w.f.thread(w.native);
    const sendTurn = thread.sendTurn.bind(thread);
    thread.sendTurn = async (input) => {
      expect(await w.rpc()).toMatchObject({ schedule: { state: 'submitting' } });
      expect(await w.rpc({ schedule: null })).toEqual({ schedule: null });
      return sendTurn(input);
    };
    w.setTime(1_800_000);
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([notice]);
    expect(await w.rpc()).toEqual({ schedule: null });
  });

  it('holds due reminders while continuation recovery is blocked or stalled', async () => {
    const w = await scheduledFixture('Waiting for a worker');
    w.setTime(1_800_000);
    for (const status of ['blocked', 'stalled'] as const) {
      const control = continuationControl(w.f.db, w.recipient);
      const now = new Date().toISOString();
      control.recovery = { attempts: 3, status, reason: 'Review required', startedAt: now, nextAttemptAt: now };
      saveContinuation(w.f.db, w.recipient, control);
      await w.f.manager.wakePendingAssignments();
      expect(w.turnTexts()).toEqual([]);
    }
  });

  it('does not wake an agent-launched conversation after its authority expires', async () => {
    let authorized = true;
    const w = await scheduledFixture(undefined, { manager: { hasActiveLaunchAuthority: () => authorized } });
    w.f.db.boundSessions.setLaunchContext(w.session.id, {
      launchedBy: w.sender, supervisorId: w.sender, launcherName: 'Test lead', requestId: randomUUID(), grantIds: [randomUUID()],
    });
    authorized = false;
    w.setTime(1_800_000);
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([]);
    authorized = true;
    await w.f.manager.wakePendingAssignments();
    expect(w.turnTexts()).toEqual([notice]);
  });

  it('leaves inconclusive delivery blocked after a backend restart', async () => {
    const w = await scheduledFixture();
    w.f.thread(w.native).failNextSend = new Error('socket reset');
    w.setTime(1_800_000);
    await w.f.manager.wakePendingAssignments();
    expect(await w.rpc()).toMatchObject({ schedule: { state: 'blocked', reason: 'socket reset' } });
    const next = await w.f.restartBackend();
    w.setTime(3_600_000);
    await next.manager.wakePendingAssignments();
    expect(next.plugin.instances).toHaveLength(0);
  });

  it('classifies only the exact scheduled prompt as a coordination transcript row', async () => {
    const w = await scheduledFixture();
    const filePath = path.join(w.f.root, 'scheduled.jsonl');
    const lines = [notice, notice + '\nA person wrote this suffix.'].map((text) => ({
      timestamp: new Date().toISOString(), type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }));
    fs.writeFileSync(filePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    const parsed = await parseCodexConversationFile({ filePath, provider: 'codex', projectSlug: 'demo', conversationRef: w.native });
    expect(parsed.messages).toMatchObject([
      { role: 'status', statusKind: 'coordination', text: 'Agent responding to a scheduled objective reminder.' },
      { role: 'user', text: notice + '\nA person wrote this suffix.' },
    ]);
  });
});
