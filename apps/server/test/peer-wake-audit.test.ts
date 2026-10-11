import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { auditPeerWakes } from '../src/coordination/audit.js';
import { peerWakeAttemptKey } from '../src/coordination/wake.js';
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
