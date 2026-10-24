import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { dispatchCoordination } from '../src/coordination/transport.js';
import { alertOverdueAwait, AWAIT_ALERT_MS, continuationControl, CONTINUATION_DELAYS_MS, pendingContinuation, prepareContinuation, saveContinuation, setContinuation, signalContinuation, UNATTENDED_IDLE_MS } from '../src/coordination/continuation.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T19:00:00Z'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assignment-continuation-'));
  const db = new AppDatabase(path.join(root, 'fixture.sqlite'));
  const service = new CoordinationService(db, { enabled: true, pilotPaths: [] });
  const register = () => {
    const token = randomUUID(); const nativeSessionId = randomUUID();
    const id = service.register({ provider: 'codex', nativeSessionId, token, pid: process.pid, cwd: root }).assignmentId!;
    return { id, token };
  };
  const parent = register(), worker = register();
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const signal = (key = 'native-child:1') => ({ key, source: worker.id, timestamp: new Date().toISOString(), reason: 'Worker completed.' });
  return { db, service, parent, worker, register, signal };
}

describe('Explicit unattended continuation contract', () => {
  it('starts waiting for input and never infers permission from active status or worker facts', () => {
    const f = fixture();
    expect(f.service.agentStatus(f.parent.id).assignment).toMatchObject({ status: 'active', continuation: 'waiting_for_input', supervisorId: null, recovery: null });
    expect(signalContinuation(f.db, f.parent.id, f.signal())).toBe(false);
    expect(prepareContinuation(f.db, f.parent.id, undefined, Date.now() + 86400_000).recovery).toBeNull();
  });

  it('preserves explicit continuation through ordinary Stop-hook waiting status and pause through registration', () => {
    const f = fixture(); f.service.update(f.parent.id, { continuation: 'unattended' });
    f.service.update(f.parent.id, { status: 'waiting', description: 'Unfinished task' });
    expect(f.service.agentStatus(f.parent.id).assignment?.continuation).toBe('unattended');
    f.service.update(f.parent.id, { continuation: 'waiting_for_input' });
    expect(signalContinuation(f.db, f.parent.id, f.signal())).toBe(false);
  });

  it('only schedules genuine idle work after five minutes, then observes a 15-second first delay', () => {
    const f = fixture(); setContinuation(f.db, f.parent.id, 'unattended');
    vi.setSystemTime(Date.now() + UNATTENDED_IDLE_MS - 1);
    expect(prepareContinuation(f.db, f.parent.id, undefined).recovery).toBeNull();
    vi.setSystemTime(Date.now() + 1); const control = prepareContinuation(f.db, f.parent.id, undefined);
    expect(control.recovery).toMatchObject({ status: 'scheduled', attempts: 0 });
    expect(pendingContinuation(control)).toBe(false);
    vi.setSystemTime(Date.now() + 15000); expect(pendingContinuation(control)).toBe(true);
  });

  it('deduplicates fresh native facts across restart and rejects historical facts', () => {
    const f = fixture(); setContinuation(f.db, f.parent.id, 'unattended');
    expect(signalContinuation(f.db, f.parent.id, { ...f.signal(), timestamp: '2026-10-11T19:00:00Z' })).toBe(false);
    expect(signalContinuation(f.db, f.parent.id, f.signal())).toBe(true);
    const restarted = new CoordinationService(f.db, { enabled: true, pilotPaths: [] });
    expect(signalContinuation(f.db, f.parent.id, f.signal())).toBe(false);
    expect(restarted.agentStatus(f.parent.id).assignment?.continuation).toBe('unattended');
    expect(prepareContinuation(f.db, f.parent.id, undefined).recovery?.nextAttemptAt).toBe('2026-10-12T19:00:15.000Z');
  });

  it('retains the three-attempt budget through new facts and ordinary activity updates', () => {
    const f = fixture(); setContinuation(f.db, f.parent.id, 'unattended'); signalContinuation(f.db, f.parent.id, f.signal());
    let control = prepareContinuation(f.db, f.parent.id, undefined);
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.parse(control.recovery!.nextAttemptAt));
      control = prepareContinuation(f.db, f.parent.id, undefined);
      expect(pendingContinuation(control)).toBe(true);
      control.recovery = { ...control.recovery!, attempts: i + 1, status: 'submitted',
        nextAttemptAt: new Date(Date.now() + CONTINUATION_DELAYS_MS[Math.min(i + 1, 2)]!).toISOString() };
      saveContinuation(f.db, f.parent.id, control);
      signalContinuation(f.db, f.parent.id, f.signal(`native-child:${i + 2}`));
      f.service.update(f.parent.id, { description: 'Same unfinished work' });
      control = continuationControl(f.db, f.parent.id);
      expect(control.recovery?.attempts).toBe(i + 1);
    }
    expect(prepareContinuation(f.db, f.parent.id, undefined).recovery).toMatchObject({ status: 'stalled', attempts: 3 });
    f.service.update(f.parent.id, { continuation: 'unattended' });
    expect(continuationControl(f.db, f.parent.id).recovery).toBeNull();
  });

  it('blocks an interrupted submission across restart and never replays it for a new signal or supervisor link', () => {
    const f = fixture(); setContinuation(f.db, f.parent.id, 'unattended'); signalContinuation(f.db, f.parent.id, f.signal());
    const control = prepareContinuation(f.db, f.parent.id, undefined);
    control.recovery = { ...control.recovery!, status: 'submitting', attempts: 1 }; saveContinuation(f.db, f.parent.id, control);
    f.service.update(f.parent.id, { supervisorId: f.worker.id });
    expect(prepareContinuation(f.db, f.parent.id, undefined).recovery?.status).toBe('blocked');
    signalContinuation(f.db, f.parent.id, f.signal('next-fact'));
    expect(pendingContinuation(prepareContinuation(f.db, f.parent.id, undefined, Date.now() + 600_000))).toBe(false);
  });

  it('notifies an explicit supervisor on handoff and finish without enabling it', async () => {
    const f = fixture();
    await dispatchCoordination(f.service, { action: 'update', assignmentId: f.worker.id, token: f.worker.token, supervisorId: f.parent.id, task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked' as const, actionNeeded: 'Review this result to unblock the assigned task' } });
    expect(continuationControl(f.db, f.parent.id).continuation).toBe('waiting_for_input');
    expect(continuationControl(f.db, f.parent.id).signals).toEqual([]);
    f.service.update(f.parent.id, { continuation: 'unattended' });
    f.service.update(f.worker.id, { summary: 'A new candidate is ready', task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked' as const, actionNeeded: 'Review this result to unblock the assigned task' } });
    expect(continuationControl(f.db, f.parent.id).signals).toEqual([]);
    f.service.finish(f.worker.id, 'Done');
    expect(continuationControl(f.db, f.parent.id).signals).toEqual([]);
    expect(continuationControl(f.db, f.worker.id).continuation).toBe('waiting_for_input');
  });

  it('delivers the actual result and final summary without a separate direct message', () => {
    const f = fixture();
    f.service.update(f.worker.id, { description: 'Repair result delivery', supervisorId: f.parent.id,
      summary: 'Candidate ready. Seven checks pass. Next: integrate the change. Details: docs/result.md.', task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked' as const, actionNeeded: 'Review this result to unblock the assigned task' } });
    const ready = f.service.mail(f.parent.id).messages;
    expect(ready).toHaveLength(1);
    expect(ready[0]!.text).toContain('Latest update (activity event');
    expect(ready[0]!.text).toContain('Seven checks pass. Next: integrate the change. Details: docs/result.md.');
    f.service.acknowledge(f.parent.id, [ready[0]!.id]);

    f.service.finish(f.worker.id, 'Integrated and verified. Next: resume the dependent task. Details: docs/final.md.');
    const final = f.service.mail(f.parent.id).messages;
    expect(final).toHaveLength(1);
    expect(final[0]!.text).toContain('Final summary (activity event');
    expect(final[0]!.text).toContain('Integrated and verified. Next: resume the dependent task. Details: docs/final.md.');
    expect(final[0]!.text).not.toContain('Candidate ready');
    expect(continuationControl(f.db, f.parent.id).continuation).toBe('waiting_for_input');
  });

  it('deduplicates unchanged blocked state across status updates and restart', () => {
    const f = fixture();
    const result = { summary: 'Review complete. Ready for the next round.', task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked' as const, actionNeeded: 'Review this result to unblock the assigned task' } };
    f.service.update(f.worker.id, { supervisorId: f.parent.id, ...result });
    f.service.update(f.worker.id, result);
    const restarted = new CoordinationService(f.db, { enabled: true, pilotPaths: [] });
    restarted.update(f.worker.id, { task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked' as const, actionNeeded: 'Review this result to unblock the assigned task' } });
    const messages = restarted.mail(f.parent.id).messages;
    expect(messages).toHaveLength(1);
    expect(new Set(messages.map(message => message.id)).size).toBe(1);
    expect(messages.every(message => message.text.includes(result.summary))).toBe(true);
  });

  it('bounds a handoff while retaining its full result and activity reference', () => {
    const f = fixture();
    const summary = 'Result and next action first. Details: docs/result.md. ' + 'supporting evidence '.repeat(120);
    f.service.update(f.worker.id, { supervisorId: f.parent.id, summary, task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked' as const, actionNeeded: 'Review this result to unblock the assigned task' } });
    const message = f.service.mail(f.parent.id).messages[0]!;
    expect(message.text).toContain('Result and next action first. Details: docs/result.md.');
    expect(message.text).toContain('…');
    expect(message.text.length).toBeLessThanOrEqual(2000);
    const event = f.db.sqlite.prepare("select seq,text from coordination_events where assignment_id=? and kind='update' order by seq desc limit 1")
      .get(f.worker.id) as { seq: number; text: string };
    expect(event.text).toBe(summary);
    expect(message.text).toContain(`activity event ${event.seq}`);
    expect(continuationControl(f.db, f.parent.id).signals).toEqual([]);
  });

  it('retains a supervisor handoff behind a full inbox and queues it when acknowledgements open space', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.service.send(f.worker.id, { id: randomUUID(), recipientId: f.parent.id, text: 'Existing peer result.' });
    f.service.update(f.worker.id, { supervisorId: f.parent.id, summary: 'Actual result retained while the inbox is full.', task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked' as const, actionNeeded: 'Review this result to unblock the assigned task' } });
    const saved = f.db.sqlite.prepare("select value from meta where key like 'supervisor-handoff:%'").get() as { value: string };
    const handoff = JSON.parse(saved.value);
    expect(handoff.blockedReason).toContain('inbox is full');
    expect(handoff.text).toContain('Actual result retained while the inbox is full.');
    expect(f.db.sqlite.prepare('select id from coordination_messages where id=?').get(handoff.messageId)).toBeUndefined();
    const restarted = new CoordinationService(f.db, { enabled: true, pilotPaths: [] });
    const inbox = restarted.mail(f.parent.id);
    restarted.acknowledge(f.parent.id, inbox.messages.map(message => message.id));
    expect(f.db.sqlite.prepare('select id,text from coordination_messages where id=?').get(handoff.messageId))
      .toEqual({ id: handoff.messageId, text: handoff.text });
    restarted.reconcileProcesses();
    expect(f.db.sqlite.prepare('select count(*) as n from coordination_messages where id=?').get(handoff.messageId)).toEqual({ n: 1 });
    expect(continuationControl(f.db, f.parent.id).continuation).toBe('waiting_for_input');
  });

  it('notifies the supervisor when the native SessionEnd hook disconnects an unattended worker', () => {
    const f = fixture(); f.service.update(f.parent.id, { continuation: 'unattended' });
    f.service.update(f.worker.id, { continuation: 'unattended', supervisorId: f.parent.id });
    f.service.disconnect(f.worker.id);
    expect(continuationControl(f.db, f.parent.id).signals).toEqual([]);
    expect(f.service.mail(f.parent.id).messages[0]?.text).toContain('disconnected');
  });

  it('accepts await through RPC, freezes a spent budget across restart, then clears it for a new peer notice', async () => {
    const f = fixture(); f.service.update(f.worker.id, { continuation: 'unattended' });
    const control = continuationControl(f.db, f.worker.id);
    control.recovery = { status: 'submitted', attempts: 3, reason: 'Existing attempt', startedAt: new Date().toISOString(), nextAttemptAt: new Date().toISOString() };
    saveContinuation(f.db, f.worker.id, control);
    const request = { action: 'update', assignmentId: f.worker.id, token: f.worker.token, awaiting: 'Desktop workflow result' };
    await dispatchCoordination(f.service, request);
    f.service.update(f.worker.id, { status: 'waiting' });
    vi.setSystemTime(Date.now() + AWAIT_ALERT_MS);
    const frozen = prepareContinuation(f.db, f.worker.id, undefined);
    expect(frozen.recovery).toMatchObject({ attempts: 3, status: 'scheduled' });
    expect(pendingContinuation(frozen)).toBe(false);
    const restarted = new CoordinationService(f.db, { enabled: true, pilotPaths: [] });
    expect(restarted.agentStatus(f.worker.id).assignment).toMatchObject({ continuation: 'unattended', awaiting: 'Desktop workflow result' });
    restarted.send(f.parent.id, { id: randomUUID(), recipientId: f.worker.id, text: 'Result is ready' });
    expect(restarted.agentStatus(f.worker.id).assignment).toMatchObject({ awaiting: 'Desktop workflow result', continuation: 'unattended', recovery: { attempts: 3 } });
    restarted.update(f.worker.id,{awaiting:null});
    expect(restarted.agentStatus(f.worker.id).assignment?.awaiting).toBeNull();
  });

  it('does not clear a new wait on a message retry and rejects invalid waits atomically', async () => {
    const f = fixture();
    const message = { id: randomUUID(), recipientId: f.worker.id, text: 'Old notice' };
    f.service.send(f.parent.id, message);
    const request = { action: 'update', assignmentId: f.worker.id, token: f.worker.token };
    await expect(dispatchCoordination(f.service, { ...request, awaiting: 'Job' })).rejects.toThrow('unattended');
    for (const awaiting of ['', '   ', 'a'.repeat(501)]) await expect(dispatchCoordination(f.service, { ...request, awaiting })).rejects.toThrow();
    await dispatchCoordination(f.service, { ...request, continuation: 'unattended', awaiting: 'Job' });
    f.service.send(f.parent.id, message);
    expect(f.service.agentStatus(f.worker.id).assignment?.awaiting).toBe('Job');
    await dispatchCoordination(f.service, { ...request, awaiting: null });
    expect(f.service.agentStatus(f.worker.id).assignment?.awaiting).toBeNull();
  });

  it.each(['blocked', 'stalled', 'submitting'] as const)('does not repair %s recovery by awaiting a peer notice', status => {
    const f = fixture(); f.service.update(f.worker.id, { continuation: 'unattended' });
    const control = continuationControl(f.db, f.worker.id);
    control.recovery = { status, attempts: 3, reason: 'Requires review', startedAt: new Date().toISOString(), nextAttemptAt: new Date().toISOString() };
    saveContinuation(f.db, f.worker.id, control);
    f.service.update(f.worker.id, { awaiting: 'Job result' });
    f.service.send(f.parent.id, { id: randomUUID(), recipientId: f.worker.id, text: 'Ready' });
    f.service.update(f.worker.id,{awaiting:null});
    expect(prepareContinuation(f.db, f.worker.id, undefined).recovery).toMatchObject({ status: status === 'submitting' ? 'blocked' : status, attempts: 3 });
  });

  it('alerts a waiting supervisor once after four hours and retains deduplication across restart', () => {
    const f = fixture();
    f.service.update(f.worker.id, { continuation: 'unattended', supervisorId: f.parent.id, awaiting: 'Desktop workflow result' });
    expect(alertOverdueAwait(f.db, f.worker.id, Date.now() + AWAIT_ALERT_MS - 1)).toBe(false);
    vi.setSystemTime(Date.now() + AWAIT_ALERT_MS);
    expect(alertOverdueAwait(f.db, f.worker.id)).toBe(true);
    const restarted = new CoordinationService(f.db, { enabled: true, pilotPaths: [] });
    const inbox = restarted.mail(f.parent.id).messages;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.text).toContain('Desktop workflow result');
    expect(alertOverdueAwait(f.db, f.worker.id, Date.now() + AWAIT_ALERT_MS)).toBe(false);
    expect(continuationControl(f.db, f.worker.id).awaiting?.description).toBe('Desktop workflow result');
    expect(continuationControl(f.db, f.parent.id).continuation).toBe('waiting_for_input');
  });

  it('retries the overdue alert after a full inbox opens and clears the parent wait on supervisor handoff', () => {
    const f = fixture();
    f.service.update(f.worker.id, { continuation: 'unattended', supervisorId: f.parent.id, awaiting: 'Long job' });
    const ids = Array.from({ length: 100 }, () => randomUUID());
    for (const id of ids) f.service.send(f.worker.id, { id, recipientId: f.parent.id, validFor:604800, text: 'Existing message' });
    vi.setSystemTime(Date.now() + AWAIT_ALERT_MS);
    expect(alertOverdueAwait(f.db, f.worker.id)).toBe(false);
    f.service.acknowledge(f.parent.id, f.service.mail(f.parent.id).messages.map(message => message.id));
    f.service.update(f.parent.id, { continuation: 'unattended', awaiting: 'Child result' });
    expect(alertOverdueAwait(f.db, f.worker.id)).toBe(true);
    expect(continuationControl(f.db, f.parent.id).awaiting).not.toBeNull();
    f.service.update(f.parent.id, { awaiting: 'Next child result' });
    f.service.update(f.worker.id, { task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked' as const, actionNeeded: 'Review this result to unblock the assigned task' } });
    expect(continuationControl(f.db, f.parent.id).awaiting).not.toBeNull();
  });

  it('delivers result handoffs and overdue alerts to a finished supervisor without reopening it', () => {
    const f = fixture();
    f.service.update(f.worker.id, { supervisorId: f.parent.id, continuation: 'unattended', awaiting: 'Late result' });
    f.service.finish(f.parent.id, 'Supervisor work completed');
    f.service.update(f.worker.id, { summary: 'A distinct late review result', validFor:604800, task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked' as const, actionNeeded: 'Review this result to unblock the assigned task' } });
    expect(f.service.mail(f.parent.id).messages[0]?.text).toContain('A distinct late review result');
    expect(alertOverdueAwait(f.db, f.worker.id, Date.now() + AWAIT_ALERT_MS)).toBe(true);
    expect(f.service.agentStatus(f.parent.id).assignment).toMatchObject({ status: 'finished', continuation: 'waiting_for_input', recovery: null });
    expect(f.service.snapshot().messages.filter(m => m.recipientId === f.parent.id)).toHaveLength(2);
  });

  it('rejects unknown, self, cyclic and finished supervisors and notification without a link', () => {
    const f = fixture();
    expect(() => f.service.update(f.worker.id, { supervisorId: randomUUID() })).toThrow('Unknown');
    expect(() => f.service.update(f.worker.id, { supervisorId: f.worker.id })).toThrow('cycle');
    expect(() => f.service.update(f.worker.id, { task: { state: 'blocked' } })).toThrow('deliverable');
    f.service.update(f.worker.id, { supervisorId: f.parent.id });
    expect(() => f.service.update(f.parent.id, { supervisorId: f.worker.id })).toThrow('cycle');
    f.service.finish(f.parent.id, 'Finished');
    expect(() => f.service.update(f.worker.id, { supervisorId: f.parent.id })).toThrow('finished');
  });
});


describe('Supervisor task workflow', () => {
  const task = { deliverable: 'Repair notification delivery', doneWhen: 'Verified behavior and reviewed change', evidencePath: 'docs/proof.md', state: 'working' as const };
  it('keeps ordinary progress silent, emits blocked/done once and suppresses disconnect after done', () => {
    const f = fixture();
    f.service.update(f.worker.id, { supervisorId: f.parent.id, continuation: 'unattended', task });
    for (let i = 0; i < 5; i++) f.service.update(f.worker.id, { summary: `Progress ${i}` });
    expect(f.service.poll(f.parent.id).messages).toEqual([]);
    f.service.update(f.worker.id, { task: { state: 'blocked', actionNeeded: 'Provide the missing build' } });
    f.service.update(f.worker.id, { summary: 'Still blocked', task: { state: 'blocked', actionNeeded: 'Provide the missing build' } });
    const blocked = f.service.poll(f.parent.id).messages;
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ channel: 'worker', priority: 'P2' });
    f.service.acknowledge(f.parent.id, blocked.map(m => m.id));
    f.service.update(f.worker.id, { task: { state: 'done' } });
    f.service.finish(f.worker.id, 'Final evidence');
    f.service.disconnect(f.worker.id);
    expect(f.service.mail(f.parent.id).messages).toHaveLength(1);
    expect(f.service.taskBoard(f.parent.id).workers[0]?.task).toMatchObject({ ...task, state: 'done' });
  });
  it('batches worker P2 reports once per fifteen minutes without holding P1, peer P2 or injecting P3', () => {
    const f = fixture(); f.service.update(f.worker.id, { supervisorId: f.parent.id });
    const send = (priority: 'P1'|'P2'|'P3') => {
      const id = randomUUID(); f.service.send(f.worker.id, { id, recipientId: f.parent.id, text: priority, priority }); return id;
    };
    const first = send('P2'); expect(f.service.poll(f.parent.id).messages.map(m => m.id)).toEqual([first]);
    f.service.acknowledge(f.parent.id, [first]);
    const flushed = send('P2'), awareness = send('P3');
    expect(f.service.poll(f.parent.id).messages).toEqual([]);
    const urgent = send('P1');
    const peer = f.register(); const peerId = randomUUID();
    f.service.send(peer.id, { id: peerId, recipientId: f.parent.id, text: 'Peer result', priority: 'P2' });
    expect(f.service.poll(f.parent.id).messages.map(m => m.id).sort()).toEqual([urgent, peerId, flushed].sort());
    f.service.acknowledge(f.parent.id, [urgent, peerId, flushed]);
    const held = send('P2');
    vi.setSystemTime(Date.now() + 15 * 60_000 - 1);
    const restarted = new CoordinationService(f.db, { enabled: true, pilotPaths: [] });
    expect(restarted.poll(f.parent.id).messages).toEqual([]);
    vi.setSystemTime(Date.now() + 1);
    expect(restarted.poll(f.parent.id).messages.map(m => m.id)).toEqual([held]);
    expect(restarted.mail(f.parent.id).messages.map(m => m.id)).toContain(awareness);
  });
  it('does not let reused SQLite row IDs bypass a held digest', () => {
    const f = fixture(); f.service.update(f.worker.id, { supervisorId: f.parent.id });
    const first = randomUUID();
    f.service.send(f.worker.id, { id: first, recipientId: f.parent.id, text: 'First result', priority: 'P2', validFor: 1 });
    f.service.poll(f.parent.id); vi.setSystemTime(Date.now() + 1001); f.service.poll(f.parent.id);
    f.service.send(f.worker.id, { id: randomUUID(), recipientId: f.parent.id, text: 'New result after expiry', priority: 'P2' });
    expect(f.service.poll(f.parent.id).messages).toEqual([]);
  });
  it('reports a later genuine blocked transition even when the needed action is unchanged', () => {
    const f = fixture(); f.service.update(f.worker.id, { supervisorId: f.parent.id, task });
    f.service.update(f.worker.id, { task: { state: 'blocked', actionNeeded: 'Review build' } });
    f.service.update(f.worker.id, { task: { state: 'working' } });
    f.service.update(f.worker.id, { task: { state: 'blocked', actionNeeded: 'Review build' } });
    expect(f.service.mail(f.parent.id).messages).toHaveLength(2);
  });
  it('drains all messages from an open digest across twenty-message hook batches', () => {
    const f = fixture(); f.service.update(f.worker.id, { supervisorId: f.parent.id });
    for (let i = 0; i < 25; i++) f.service.send(f.worker.id, { id: randomUUID(), recipientId: f.parent.id, text: 'Worker result', priority: 'P2' });
    expect(f.service.poll(f.parent.id).messages).toHaveLength(20);
    expect(f.service.poll(f.parent.id).messages).toHaveLength(5);
    expect(f.service.poll(f.parent.id).messages).toHaveLength(0);
  });
  it('returns expiredUnread for expired unsupplied content without claiming acknowledgement', () => {
    const f = fixture(), id = randomUUID();
    f.service.send(f.worker.id, { id, recipientId: f.parent.id, text: 'Expired awareness', priority: 'P3', validFor: 1 });
    vi.setSystemTime(Date.now() + 1001);
    expect(f.service.acknowledge(f.parent.id, [id])).toEqual({ acknowledged: [], expiredUnread: [id] });
    expect(() => f.service.acknowledge(f.worker.id, [id])).toThrow('recipient');
    expect(f.db.meta.get(`inbox-message:${id}`)).not.toContain('acknowledgedAt');
  });
  it('dispatches only a supervised authorized task once, with revision checks and idempotent receipt', async () => {
    const f = fixture(); f.service.update(f.worker.id, { supervisorId: f.parent.id, continuation: 'unattended' });
    const command = { action: 'dispatch', assignmentId: f.parent.id, token: f.parent.token, messageId: randomUUID(), recipientId: f.worker.id, expectedTaskRevision: 0, task };
    await expect(dispatchCoordination(f.service, command)).resolves.toMatchObject({ priority: 'P2' });
    await expect(dispatchCoordination(f.service, command)).resolves.toMatchObject({ id: command.messageId });
    await expect(dispatchCoordination(f.service, { ...command, messageId: randomUUID(), expectedTaskRevision: 1 })).rejects.toThrow('already dispatched');
    await expect(dispatchCoordination(f.service, { ...command, messageId: randomUUID(), assignmentId: f.worker.id, token: f.worker.token })).rejects.toThrow('declared supervisor');
    await expect(dispatchCoordination(f.service, { ...command, messageId: randomUUID() })).rejects.toThrow('revision changed');
    expect(f.service.poll(f.worker.id).messages[0]).toMatchObject({ channel: 'supervisor' });
  });
  it.each(['waiting', 'awaiting', 'blocked', 'stalled', 'finished'] as const)('refuses dispatch across %s permission/recovery state', condition => {
    const f = fixture(); f.service.update(f.worker.id, { supervisorId: f.parent.id, continuation: 'unattended' });
    if (condition === 'waiting') f.service.update(f.worker.id, { continuation: 'waiting_for_input' });
    if (condition === 'awaiting') f.service.update(f.worker.id, { awaiting: 'External job' });
    if (condition === 'finished') f.service.finish(f.worker.id, 'Complete');
    if (condition === 'blocked' || condition === 'stalled') {
      const control = continuationControl(f.db, f.worker.id);
      control.recovery = { status: condition, reason: 'Requires owner', attempts: 3, startedAt: new Date().toISOString(), nextAttemptAt: new Date().toISOString() };
      saveContinuation(f.db, f.worker.id, control);
    }
    expect(() => f.service.dispatch(f.parent.id, { id: randomUUID(), recipientId: f.worker.id, expectedTaskRevision: 0, task })).toThrow('paused');
    expect(f.service.taskBoard(f.parent.id).workers[0]?.task).toBeNull();
  });
  it('rejects retired notification fields with actionable guidance', async () => {
    const f = fixture();
    await expect(dispatchCoordination(f.service, { action: 'update', assignmentId: f.worker.id, token: f.worker.token, notifySupervisor: true })).rejects.toThrow('retired');
  });
});
