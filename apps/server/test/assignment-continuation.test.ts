import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { dispatchCoordination } from '../src/coordination/transport.js';
import { continuationControl, CONTINUATION_DELAYS_MS, pendingContinuation, prepareContinuation, saveContinuation, setContinuation, signalContinuation, UNATTENDED_IDLE_MS } from '../src/coordination/continuation.js';

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
    await dispatchCoordination(f.service, { action: 'update', assignmentId: f.worker.id, token: f.worker.token, supervisorId: f.parent.id, notifySupervisor: true });
    expect(continuationControl(f.db, f.parent.id).continuation).toBe('waiting_for_input');
    expect(continuationControl(f.db, f.parent.id).signals).toEqual([]);
    f.service.update(f.parent.id, { continuation: 'unattended' });
    f.service.update(f.worker.id, { summary: 'A new candidate is ready', notifySupervisor: true });
    expect(continuationControl(f.db, f.parent.id).signals[0]?.source).toBe(f.worker.id);
    f.service.finish(f.worker.id, 'Done');
    expect(continuationControl(f.db, f.parent.id).signals).toHaveLength(2);
    expect(continuationControl(f.db, f.worker.id).continuation).toBe('waiting_for_input');
  });

  it('retains a supervisor handoff behind a full inbox and queues it when acknowledgements open space', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.service.send(f.worker.id, { id: randomUUID(), recipientId: f.parent.id, text: 'Existing peer result.' });
    f.service.update(f.worker.id, { supervisorId: f.parent.id, notifySupervisor: true });
    const saved = f.db.sqlite.prepare("select value from meta where key like 'supervisor-handoff:%'").get() as { value: string };
    const handoff = JSON.parse(saved.value);
    expect(handoff.blockedReason).toContain('inbox is full');
    expect(f.db.sqlite.prepare('select id from coordination_messages where id=?').get(handoff.messageId)).toBeUndefined();
    const inbox = f.service.poll(f.parent.id, 0);
    f.service.acknowledge(f.parent.id, inbox.messages.map(message => message.id));
    expect(f.db.sqlite.prepare('select id from coordination_messages where id=?').get(handoff.messageId)).toEqual({ id: handoff.messageId });
    f.service.reconcileProcesses();
    expect(f.db.sqlite.prepare('select count(*) as n from coordination_messages where id=?').get(handoff.messageId)).toEqual({ n: 1 });
    expect(continuationControl(f.db, f.parent.id).continuation).toBe('waiting_for_input');
  });

  it('notifies the supervisor when the native SessionEnd hook disconnects an unattended worker', () => {
    const f = fixture(); f.service.update(f.parent.id, { continuation: 'unattended' });
    f.service.update(f.worker.id, { continuation: 'unattended', supervisorId: f.parent.id });
    f.service.disconnect(f.worker.id);
    expect(continuationControl(f.db, f.parent.id).signals[0]).toMatchObject({ source: f.worker.id, reason: expect.stringContaining('disconnected') });
  });

  it('rejects unknown, self, cyclic and finished supervisors and notification without a link', () => {
    const f = fixture();
    expect(() => f.service.update(f.worker.id, { supervisorId: randomUUID() })).toThrow('Unknown');
    expect(() => f.service.update(f.worker.id, { supervisorId: f.worker.id })).toThrow('cycle');
    expect(() => f.service.update(f.worker.id, { notifySupervisor: true })).toThrow('Declare');
    f.service.update(f.worker.id, { supervisorId: f.parent.id });
    expect(() => f.service.update(f.parent.id, { supervisorId: f.worker.id })).toThrow('cycle');
    f.service.finish(f.parent.id, 'Finished');
    expect(() => f.service.update(f.worker.id, { supervisorId: f.parent.id })).toThrow('finished');
  });
});
