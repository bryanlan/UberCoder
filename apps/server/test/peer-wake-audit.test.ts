import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { auditPeerWakes } from '../src/coordination/audit.js';
import { peerWakeAttemptKey, peerWakeFollowupKey, setPeerWakePaused } from '../src/coordination/wake.js';
import { WakeAlerts } from '../src/coordination/wake-alerts.js';
import { GrantPushService } from '../src/grants/push.js';
import { FakeTmux, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

const now = Date.parse('2026-10-11T04:30:00Z');
const minute = 60_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-audit-'));
  const db = new AppDatabase(path.join(root, 'state.sqlite'));
  const manager = createRecoveryManager(db, new FakeTmux(), root);
  const service = new CoordinationService(db, { enabled: true, pilotPaths: [] });
  const native = randomUUID();
  const recipient = service.register({ provider: 'codex', nativeSessionId: native, token: randomUUID(), pid: process.pid, cwd: root }).assignmentId!;
  const senderNative = randomUUID();
  const sender = service.register({ provider: 'claude', nativeSessionId: senderNative, token: randomUUID(), pid: process.pid, cwd: root }).assignmentId!;
  const session = await manager.bindConversation({ project, provider, providerSettings, conversationRef: native, title: 'Audit fixture', kind: 'history' });
  const reverse = { ...session, id: randomUUID(), provider: 'claude' as const, conversationRef: senderNative, tmuxSessionName: 'audit-reverse' };
  db.boundSessions.upsert(reverse);
  cleanups.push(async () => { await manager.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function add(at: number, options: { batch?: number; old?: boolean; fixture?: boolean; reverse?: boolean; failed?: boolean; acknowledged?: boolean } = {}) {
    const selectedSender = options.fixture ? service.register({ provider: 'claude', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: root }).assignmentId! : sender;
    if (options.fixture) db.sqlite.prepare('update coordination_assignments set description=? where id=?').run('Disposable deployment verification sender', selectedSender);
    for (let i = 0; i < (options.batch ?? 1); i++) {
      const id = randomUUID();
      service.send(options.reverse ? recipient : selectedSender, { id, recipientId: options.reverse ? sender : recipient, text: 'PRIVATE_PEER_TEXT' });
      db.sqlite.prepare('update coordination_messages set created_at=?,acknowledged_at=? where id=?')
        .run(new Date(at - (options.old ? 120 * minute : 1000)).toISOString(), options.acknowledged ? new Date(at + 1000).toISOString() : null, id);
      db.meta.set(peerWakeAttemptKey(id), JSON.stringify({ sessionId: options.reverse ? reverse.id : session.id,
        timestamp: new Date(at).toISOString(), status: options.failed ? 'failed' : 'submitted', reason: options.failed ? 'queue rejected' : undefined }));
    }
  }
  return { db, manager, service, session, sender, recipient, root, add };
}
describe('Peer wake audit', () => {
  it('warns on a failed wake even when no native response turn ever started', async () => {
    const f = await fixture(); f.add(now - 3 * minute, { failed: true });
    const report = await auditPeerWakes(f.db.sqlite, { now });
    expect(report.warnings).toMatchObject([{ kind: 'delivery', title: 'Peer wake is blocked', summary: expect.stringContaining('queue rejected') }]);
    expect(report.counts.submittedWakes).toBe(0);
  });

  it('allows a fresh submission of an old queued message to finish before warning', async () => {
    const f = await fixture(); f.add(now - 130 * minute);
    const message = f.db.sqlite.prepare('select id from coordination_messages').get() as { id: string };
    f.db.meta.set(peerWakeAttemptKey(message.id), JSON.stringify({ sessionId: f.session.id, timestamp: new Date(now - 10_000).toISOString(), status: 'submitting' }));
    expect((await auditPeerWakes(f.db.sqlite, { now })).warnings).toEqual([]);
    expect((await auditPeerWakes(f.db.sqlite, { now: now + 21_000 })).warnings).toMatchObject([{ title: 'Peer wake is blocked' }]);
  });

  it('sends one browser alert for a failed message batch while retaining each audit warning', async () => {
    const f = await fixture(); f.add(now - 3 * minute, { failed: true, batch: 8 });
    const notify = vi.fn(async () => ({ subscriptions: 1, accepted: 1, failed: 0, acceptedEndpoints: ['desktop'] }));
    const alerts = new WakeAlerts(f.db, notify);
    await alerts.check(now);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await auditPeerWakes(f.db.sqlite, { now })).warnings).toHaveLength(8);
    await new WakeAlerts(f.db, notify).check(now + minute);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('retains unread supervisor results and the exact pause reason after continuation changes and restart', async () => {
    const f = await fixture();
    f.service.update(f.sender, { supervisorId: f.recipient, notifySupervisor: true });
    const row = f.db.sqlite.prepare("select key,value from meta where key like 'supervisor-handoff:%'").get() as { key: string; value: string };
    const handoff = JSON.parse(row.value);
    const timestamp = new Date(now - 6 * minute).toISOString();
    f.db.meta.set(row.key, JSON.stringify({ ...handoff, timestamp }));
    f.db.sqlite.prepare('update coordination_messages set created_at=? where id=?').run(timestamp, handoff.messageId);
    setPeerWakePaused(f.db, f.recipient, true, { sessionId: f.session.id, timestamp, code: 'native_cancellation', reason: 'The native provider cancelled turn proof-turn.' });
    expect(f.service.send(f.sender, { id: handoff.messageId, recipientId: f.recipient,
      text: 'A supervised worker has a result ready for review. Worker ' + f.sender + ': Assignment not yet described' }).note).toContain('cancelled turn proof-turn');
    f.service.update(f.recipient, { continuation: 'waiting_for_input', status: 'waiting' });
    f.db.sqlite.pragma('query_only=ON');
    const report = await auditPeerWakes(f.db.sqlite, { now, hours: 1 });
    expect(report.warnings).toMatchObject([{ key: `supervisor-results:${f.recipient}`, title: 'Supervisor has unread worker results',
      summary: expect.stringContaining('cancelled turn proof-turn') }]);
    expect(report.pauses).toMatchObject([{ assignmentId: f.recipient, code: 'native_cancellation', sessionId: f.session.id }]);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_PEER_TEXT');
    f.db.sqlite.pragma('query_only=OFF');
    const resumed = new CoordinationService(f.db, { enabled: true, pilotPaths: [] });
    const inbox = resumed.poll(f.recipient, 0);
    expect(inbox.messages.map(message => message.id)).toContain(handoff.messageId);
    resumed.acknowledge(f.recipient, [handoff.messageId]);
    expect((await auditPeerWakes(f.db.sqlite, { now })).warnings).toEqual([]);
  });

  it('pushes an overdue result once across backend restart, records delivery and retries an unavailable push', async () => {
    const f = await fixture();
    f.service.update(f.sender, { supervisorId: f.recipient, notifySupervisor: true });
    const row = f.db.sqlite.prepare("select key,value from meta where key like 'supervisor-handoff:%'").get() as { key: string; value: string };
    f.db.meta.set(row.key, JSON.stringify({ ...JSON.parse(row.value), timestamp: new Date(now - 6 * minute).toISOString() }));
    const send = vi.fn(async (_subscription: unknown, _payload?: string | Buffer | null) => ({ statusCode: 201, body: '', headers: {} }));
    const push = new GrantPushService(f.db, 'https://console.example.test', send);
    const alerts = () => new WakeAlerts(f.db, (warning, delivered) => push.wakeWarning(warning, delivered));
    await alerts().check(now); // No subscription: retained audit, no claimed delivery.
    expect(send).not.toHaveBeenCalled();
    push.subscribe({ endpoint: 'https://push.example.test/fixture', keys: { auth: 'auth', p256dh: 'key' } });
    await alerts().check(now + minute); expect(send).not.toHaveBeenCalled();
    await alerts().check(now + 5 * minute); expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(send.mock.calls[0]![1]))).toMatchObject({ warningKey: `supervisor-results:${f.recipient}`, title: 'Supervisor has unread worker results' });
    expect(JSON.parse(f.db.meta.get(`wake-push-delivery:supervisor-results:${f.recipient}`)!)).toMatchObject({ subscriptions: 1, accepted: 1, failed: 0 });
    await alerts().check(now + 6 * minute); expect(send).toHaveBeenCalledTimes(1);
    const inbox = f.service.poll(f.recipient, 0);
    f.service.acknowledge(f.recipient, inbox.messages.map(message => message.id));
    await alerts().check(now + 7 * minute);
    expect(JSON.parse(f.db.meta.get(`wake-alert:supervisor-results:${f.recipient}`)!)).toMatchObject({ active: false });
  });
  it('retries failed devices across restart without repeating accepted pushes and forgets delivery after resolution', async () => {
    const f = await fixture(); f.add(now - 3 * minute, { failed: true });
    let phoneAvailable = false;
    const send = vi.fn(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint.endsWith('/phone') && !phoneAvailable) throw { statusCode: 503 };
      if (subscription.endpoint.endsWith('/expired')) throw { statusCode: 410 };
      return { statusCode: 201, body: '', headers: {} };
    });
    const push = new GrantPushService(f.db, 'https://console.example.test', send);
    for (const device of ['desktop', 'phone', 'expired']) push.subscribe({ endpoint: `https://push.example.test/${device}`, keys: { auth: 'auth', p256dh: 'key' } });
    const check = (at: number) => new WakeAlerts(f.db, (warning, delivered) => push.wakeWarning(warning, delivered)).check(at);
    await check(now);
    await check(now + minute);
    await check(now + 6 * minute);
    expect(send.mock.calls.map(([sub]) => sub.endpoint.split('/').at(-1))).toEqual(['desktop', 'phone', 'expired', 'phone']);
    phoneAvailable = true;
    await check(now + 12 * minute);
    await check(now + 18 * minute);
    expect(send.mock.calls.map(([sub]) => sub.endpoint.split('/').at(-1))).toEqual(['desktop', 'phone', 'expired', 'phone', 'phone']);
    const inbox = f.service.poll(f.recipient, 0);
    f.service.acknowledge(f.recipient, inbox.messages.map(message => message.id));
    await check(now + 19 * minute);
    f.add(now + 17 * minute, { failed: true });
    await check(now + 20 * minute);
    expect(send.mock.calls.slice(-2).map(([sub]) => sub.endpoint.split('/').at(-1))).toEqual(['desktop', 'phone']);
  });
  it('keeps both attempts and counts the acknowledgement once', async () => {
    const f = await fixture(); f.add(now - 5 * minute, { acknowledged: true });
    const message = f.db.sqlite.prepare('select id from coordination_messages').get() as { id: string };
    f.db.meta.set(peerWakeFollowupKey(message.id), JSON.stringify({ sessionId: f.session.id, timestamp: new Date(now - 3 * minute).toISOString(), status: 'submitted' }));
    const result = await auditPeerWakes(f.db.sqlite, { now });
    expect(result.counts).toMatchObject({ submittedWakes: 2, followupWakes: 1, attemptedMessages: 2, acknowledgedMessages: 1 });
    expect(result.wakes.map((w) => w.messages[0]?.attempt)).toEqual([1, 2]);
  });
  it('retains recovered timeouts and finished versus abandoned offers in the daily audit', async () => {
    const f = await fixture(); f.add(now - 30 * minute, { acknowledged: true });
    const message = f.db.sqlite.prepare('select id,created_at,acknowledged_at from coordination_messages').get() as { id: string; created_at: string; acknowledged_at: string };
    const directory = path.join(f.root, 'coordination/telemetry'); fs.mkdirSync(directory, { recursive: true });
    const at = now - 30 * minute;
    const records = [
      { kind: 'rpc_client', timestamp: at, action: 'poll', outcome: 'error', error: 'timeout', durationMs: 2300 },
      { kind: 'hook', timestamp: at, outcome: 'error' },
      { kind: 'offer', timestamp: at, messageId: message.id, offeredAt: at - 500, outcome: 'abandoned' },
      { kind: 'offer', timestamp: at + 500, messageId: message.id, offeredAt: at, outcome: 'finished' },
      { kind: 'rpc_client', timestamp: now, action: 'poll', outcome: 'ok', durationMs: 4 },
    ];
    fs.writeFileSync(path.join(directory, '2026-10-11.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const result = await auditPeerWakes(f.db.sqlite, { now, runtimeDir: f.root });
    expect(result.warnings).toEqual([]);
    expect(result.observedWarnings).toMatchObject([{ kind: 'transport' }]);
    expect(result.transport).toMatchObject({ clientTimeouts: 1, hookFailures: 1, offerResponsesFinished: 1, offerResponsesAbandoned: 1,
      firstFinishedOfferDelayMs: { samples: 1, median: 1000 }, finishedOfferToAcknowledgementMs: { samples: 1, median: 1000 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PEER_TEXT');
  });
  it('warns after a completed unacknowledged wake well before the old ten-minute pending alert', async () => {
    const f = await fixture(); f.add(now - 3 * minute);
    f.db.boundSessions.upsert({ ...f.session, lastCompletedAt: new Date(now - minute).toISOString() });
    expect((await auditPeerWakes(f.db.sqlite, { now })).warnings).toMatchObject([{ kind: 'delivery' }]);
  });
  it('keeps delivery warnings past the audit window and during or after a follow-up until acknowledged', async () => {
    const f = await fixture(); f.add(now - 130 * minute);
    const message = f.db.sqlite.prepare('select id from coordination_messages').get() as { id: string };
    f.db.boundSessions.upsert({ ...f.session, lastCompletedAt: new Date(now - 125 * minute).toISOString() });
    expect((await auditPeerWakes(f.db.sqlite, { now, hours: 1 })).warnings).toMatchObject([{ kind: 'delivery' }]);
    f.db.meta.set(peerWakeFollowupKey(message.id), JSON.stringify({ sessionId: f.session.id, timestamp: new Date(now - minute).toISOString(), status: 'submitted' }));
    const during = await auditPeerWakes(f.db.sqlite, { now, hours: 1 });
    expect(during.warnings).toMatchObject([{ kind: 'delivery', summary: expect.stringContaining('no further automatic attempts') }]);
    f.db.sqlite.prepare('update coordination_messages set supplied_at=?,acknowledged_at=? where id=?')
      .run(new Date(now).toISOString(), new Date(now).toISOString(), message.id);
    expect((await auditPeerWakes(f.db.sqlite, { now, hours: 1 })).warnings).toEqual([]);
  });
  it('counts one submission for a message batch and performs no database writes', async () => {
    const f = await fixture(); f.add(now - minute, { batch: 20, acknowledged: true });
    f.db.meta.set('unrelated-measurement', 'not JSON');
    f.db.sqlite.pragma('query_only=ON');
    const result = await auditPeerWakes(f.db.sqlite, { now });
    expect(result.counts).toMatchObject({ submittedWakes: 1, attemptedMessages: 20, acknowledgedMessages: 20, unknownRestorationWakes: 1 });
    expect(result.acknowledgementDelayMs).toEqual({ median: 2000, p95: 2000 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PEER_TEXT');
    f.db.sqlite.pragma('query_only=OFF');
  });
  it('warns at five normal submissions, while retaining separate fixture and backlog counts', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) f.add(now - (i + 1) * minute);
    f.add(now - 20 * minute, { old: true });
    let result = await auditPeerWakes(f.db.sqlite, { now });
    expect(result.warnings).toHaveLength(1); expect(result.warnings[0]?.kind).toBe('frequency');
    expect(result.agents.find((r) => r.key === f.recipient)).toMatchObject({ normalWakes: 5, backlogWakes: 1 });
    f.add(now - 30 * minute, { fixture: true });
    result = await auditPeerWakes(f.db.sqlite, { now });
    expect(result.warnings).toHaveLength(1);
    expect(result.agents.find((r) => r.key === f.recipient)?.fixtureWakes).toBe(1);
  });
  it('retains but excludes deployment fixtures and backlog-only bursts from frequency warnings', async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) { f.add(now - (i + 1) * minute, { fixture: true }); f.add(now - (i + 1.5) * minute, { old: true }); }
    const result = await auditPeerWakes(f.db.sqlite, { now });
    expect(result.counts.submittedWakes).toBe(12); expect(result.warnings).toEqual([]);
  });
  it('checks the hourly threshold without treating messages within one batch as separate wakes', async () => {
    const f = await fixture();
    for (let i = 0; i < 19; i++) f.add(now - (i * 2 + 11) * minute);
    expect((await auditPeerWakes(f.db.sqlite, { now })).warnings).toEqual([]);
    f.add(now - 52 * minute, { batch: 3 });
    expect((await auditPeerWakes(f.db.sqlite, { now })).warnings[0]?.summary).toContain('20 in one hour');
  });
  it('flags alternating pair wakes and clears the rolling condition when it ages out', async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) f.add(now - (i + 1) * minute, { reverse: i % 2 === 0 });
    const result = await auditPeerWakes(f.db.sqlite, { now });
    expect(result.warnings).toMatchObject([{ kind: 'possible_loop' }]);
    expect((await auditPeerWakes(f.db.sqlite, { now: now + 11 * minute })).warnings).toEqual([]);
  });
  it('retains a burst between five-minute checks and reports it later in the daily history', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) f.add(now + (1 + i * 2.4) * minute);
    for (const minutes of [5, 10]) expect((await auditPeerWakes(f.db.sqlite, { now: now + minutes * minute })).warnings).toEqual([]);
    const check = await auditPeerWakes(f.db.sqlite, { now: now + 15 * minute });
    expect(check.warnings).toMatchObject([{ kind: 'frequency', observedAt: new Date(now + 10.6 * minute).toISOString() }]);
    const daily = await auditPeerWakes(f.db.sqlite, { now: now + 4 * 60 * minute });
    expect(daily.warnings).toEqual([]);
    expect(daily.observedWarnings).toMatchObject([{ kind: 'frequency' }]);
  });
  it('retains a possible loop whose six alternating wakes fall between checks', async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) f.add(now + (1 + i * 1.92) * minute, { reverse: i % 2 === 0 });
    expect((await auditPeerWakes(f.db.sqlite, { now: now + 10 * minute })).warnings).toEqual([]);
    expect((await auditPeerWakes(f.db.sqlite, { now: now + 15 * minute })).warnings).toMatchObject([{ kind: 'possible_loop' }]);
  });
  it('uses preceding-hour context for observed thresholds without adding it to window counts', async () => {
    const f = await fixture();
    for (let i = 0; i < 20; i++) f.add(now - (67 - i * 59 / 19) * minute);
    const result = await auditPeerWakes(f.db.sqlite, { now, hours: 1 });
    expect(result.warnings).toMatchObject([{ kind: 'frequency' }]);
    expect(result.counts.submittedWakes).toBeLessThan(20);
    expect(result.wakes.every((w) => Date.parse(w.timestamp) >= now - 60 * minute)).toBe(true);
  });
  it('reports failed submission and old managed pending messages without claiming receipt', async () => {
    const f = await fixture(); f.add(now - 20 * minute, { failed: true });
    const result = await auditPeerWakes(f.db.sqlite, { now });
    expect(result.counts).toMatchObject({ submittedWakes: 0, acknowledgedMessages: 0, failedMessages: 1, managedPendingMessages: 1 });
    expect(result.pending[0]!.ageMinutes).toBeGreaterThan(20);
    expect(result.usage[0]!.measuredTokens).toBeNull();
  });
  it('keeps wake counts when a historical binding is removed', async () => {
    const f = await fixture(); f.add(now - minute);
    f.db.sqlite.prepare('delete from bound_sessions where id=?').run(f.session.id);
    expect((await auditPeerWakes(f.db.sqlite, { now })).counts.submittedWakes).toBe(1);
  });
  it('rejects corrupt measurement data and invalid windows instead of reporting zero wakes', async () => {
    const f = await fixture(); f.add(now - minute);
    f.db.sqlite.prepare("update meta set value='invalid' where key like 'peer-wake-attempt:%'").run();
    await expect(auditPeerWakes(f.db.sqlite, { now })).rejects.toThrow();
    await expect(auditPeerWakes(f.db.sqlite, { now, hours: 0 })).rejects.toThrow('between');
  });
});
