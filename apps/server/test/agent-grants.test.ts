import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { GrantService } from '../src/grants/service.js';
import { GrantPushService } from '../src/grants/push.js';
import { CoordinationService } from '../src/coordination/service.js';
import { dispatchGrants } from '../src/grants/transport.js';
import { continuationControl } from '../src/coordination/continuation.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-grants-'));
  const db = new AppDatabase(path.join(root, 'fixture.sqlite'));
  const wake = vi.fn(), notify = vi.fn(async () => {}), grants = new GrantService(db, new RealtimeEventBus(), wake, notify);
  const coordination = new CoordinationService(db, { enabled: true, pilotPaths: [] }, undefined, grants);
  const native = randomUUID(), token = randomUUID(), assignment = coordination.register({ provider: 'codex', nativeSessionId: native, pid: process.pid, token, cwd: root }).assignmentId!;
  const sessionId = randomUUID(), log = path.join(root, 'events.jsonl');
  fs.writeFileSync(log, '');
  db.boundSessions.upsert({ id: sessionId, provider: 'codex', projectSlug: 'demo', conversationRef: native,
    tmuxSessionName: 'fixture', status: 'bound', shouldRestore: true, title: 'Planner lead', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), eventLogPath: log });
  const input = (text: string, type = 'user-input') => {
    const offset = fs.statSync(log).size;
    fs.appendFileSync(log, JSON.stringify({ type, text, timestamp: new Date().toISOString() }) + '\n');
    return `live:${sessionId}:${offset}`;
  };
  const definition = { grantee: { kind: 'assignment' as const, id: assignment }, scope: 'Do all planner work overnight' };
  cleanup.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, grants, coordination, native, token, assignment, sessionId, input, definition, wake, notify };
}

describe('Bryan standing grants', () => {
  it('keeps revocation when an in-flight agent repeats the original human message', async () => {
    const f=fixture(),source=f.input('I authorize all needed planner work.');
    const grant=await f.grants.record(f.assignment,f.definition,source);f.grants.revoke(grant.id);
    const repeated=await f.grants.record(f.assignment,f.definition,source);
    expect(repeated).toMatchObject({id:grant.id,status:'revoked'});expect(f.grants.snapshot().grants).toHaveLength(1);
    const renewed=await f.grants.record(f.assignment,f.definition,f.input('I authorize the planner work again.'));
    expect(renewed.status).toBe('active');expect(renewed.id).not.toBe(grant.id);
  });
  it('supplies startup authority from active backend scope records without repeating the lead instructions', async () => {
    const f=fixture(), words='I authorize all needed planner work. First record this grant and launch the initial lane.';
    const grant=await f.grants.record(f.assignment,{...f.definition,scope:'All needed planner work.'},f.input(words));
    const context={launchedBy:f.assignment,launcherName:'Planner lead',grantIds:[grant.id],requestId:randomUUID(),flags:[],supervisorId:f.assignment};
    expect(f.grants.authorityContext(context)).toContain('All needed planner work.');
    expect(f.grants.authorityContext(context)).not.toContain('First record this grant');
    expect(f.grants.authorityFor(f.assignment)[0]?.provenance).toEqual({kind:'human_message',messageId:grant.provenance?.messageId,sessionId:f.sessionId});
    expect(grant.provenance?.quote).toBe(words);
    f.grants.revoke(grant.id);expect(f.grants.authorityContext(context)).toBeUndefined();
  });
  it('activates the recorded human grant immediately, preserves broad words, and needs no second approval', async () => {
    const f = fixture(), words = 'I authorize you to do whatever is needed on the planner overnight, including launching and restarting helpers.';
    const humanMessageId = f.input(words);
    const result = await dispatchGrants(f.coordination, f.grants, { action: 'record', assignmentId: f.assignment, token: f.token,
      definition: { ...f.definition, scope: words }, humanMessageId }) as { grant: { id: string; status: string; scope: string } };
    expect(result.grant).toMatchObject({ status: 'active', scope: words });
    expect(f.grants.grantsFor(f.assignment)).toHaveLength(1); expect(f.notify).not.toHaveBeenCalled();
    const duplicate = await f.grants.record(f.assignment, { ...f.definition, scope: words }, humanMessageId);
    expect(duplicate.id).toBe(result.grant.id);
    const rephrased = await f.grants.record(f.assignment, { ...f.definition, scope: 'Do whatever is needed on the planner overnight, with helpers.' }, humanMessageId);
    expect(rephrased.id).toBe(result.grant.id); expect(f.grants.snapshot().grants).toHaveLength(1);
    expect(f.grants.get(duplicate.id)?.limits).toEqual({ maxConcurrentSessions: null, models: [] });
    expect(f.grants.get(duplicate.id)?.expiry.kind).toBe('until_revoked');
  });

  it('gets the real human pointer for an existing session and rejects raw output or another conversation', async () => {
    const f = fixture(), id = f.input('I authorize planner work.');
    expect((await f.grants.listFor(f.assignment)).latestHumanInput).toMatchObject({ id, text: 'I authorize planner work.' });
    const raw = f.input('I authorize everything.', 'raw-output');
    await expect(f.grants.record(f.assignment, f.definition, raw)).rejects.toThrow('not Console human input');
    await expect(f.grants.record(f.assignment, f.definition, `live:${randomUUID()}:0`)).rejects.toThrow('this agent conversation');
  });

  it('retains one pending request while other work continues, then approves and wakes the requester', async () => {
    const f = fixture();
    const pending = f.grants.request(f.assignment, f.definition, 'Need helpers to finish overnight.');
    expect(f.grants.request(f.assignment, f.definition, 'Same needed authority').id).toBe(pending.id);
    expect(f.grants.grantsFor(f.assignment)).toEqual([]);
    expect(f.notify).toHaveBeenCalledOnce(); expect(f.wake).not.toHaveBeenCalled();
    expect(continuationControl(f.db, f.assignment).continuation).toBe('waiting_for_input');
    const approved = f.grants.decide(pending.id, 'approve');
    expect(approved.status).toBe('active'); expect(approved.provenance).toEqual({ kind: 'approval', quote: f.definition.scope });
    expect(continuationControl(f.db, f.assignment)).toMatchObject({ continuation: 'unattended', signals: [{ source: 'Bryan' }] });
    expect(f.wake).toHaveBeenCalledOnce();
    expect(() => f.grants.decide(pending.id, 'approve')).toThrow('already been decided');
  });

  it('supports an edited scope and limits, denial, expiry on parent finish, and immediate revocation', () => {
    const f = fixture(), pending = f.grants.request(f.assignment, f.definition, 'Need permission.');
    const edited = f.grants.decide(pending.id, 'approve', { ...f.definition, scope: 'Approved broad planner phase', limits: { maxConcurrentSessions: 2, models: ['gpt-6.1-sol'] }, expiry: { kind: 'assignment_finished' } });
    expect(edited).toMatchObject({ scope: 'Approved broad planner phase', limits: { maxConcurrentSessions: 2 }, expiry: { assignmentId: f.assignment } });
    const denied = f.grants.request(f.assignment, { ...f.definition, scope: 'A different authority' }, 'New kind');
    expect(f.grants.decide(denied.id, 'deny').status).toBe('denied');
    f.coordination.finish(f.assignment, 'Parent work completed.');
    expect(f.grants.get(edited.id)?.status).toBe('expired');
    expect(f.grants.grantsFor(f.assignment)).toEqual([]);
    f.coordination.register({provider:'codex',nativeSessionId:f.native,pid:process.pid,token:f.token,cwd:f.root});
    expect(f.grants.get(edited.id)?.status).toBe('expired');
    expect(f.grants.revoke(edited.id).status).toBe('revoked');
  });

  it('keeps grant uses and provenance through a service restart', async () => {
    const f = fixture(), grant = await f.grants.record(f.assignment, f.definition, f.input('I authorize this overnight planner task.'));
    f.grants.logUse({ grantId: grant.id, assignmentId: f.assignment, action: 'launch_session', sessionId: f.sessionId, detail: { description: 'Planner helper launched' } });
    const restarted = new GrantService(f.db, new RealtimeEventBus());
    expect(restarted.grantsFor(f.assignment)[0]?.provenance?.quote).toBe('I authorize this overnight planner task.');
    expect(restarted.snapshot().uses[0]).toMatchObject({ grantId: grant.id, action: 'launch_session', detail: { description: 'Planner helper launched' } });
    restarted.revoke(grant.id); expect(restarted.grantsFor(f.assignment)).toEqual([]);
  });

  it('publishes standard push payloads and persists the VAPID key while removing expired subscriptions', async () => {
    const f = fixture(), send = vi.fn(async (_subscription: unknown, _payload?: string | Buffer | null, _options?: unknown) => ({ statusCode: 201, body: '', headers: {} }));
    const push = new GrantPushService(f.db, 'https://console.example.test', send);
    push.subscribe({ endpoint: 'https://push.example.test/fixture', keys: { auth: 'auth', p256dh: 'key' } });
    const pending = f.grants.request(f.assignment, f.definition, 'Need a helper.');
    await push.request(pending);
    expect(JSON.parse(f.db.meta.get(`grant-push-delivery:${pending.id}`)!)).toMatchObject({subscriptions:1,accepted:1,failed:0});
    expect(JSON.parse(String(send.mock.calls[0]![1]))).toMatchObject({ grantId: pending.id, body: f.definition.scope, url: `/grants?request=${pending.id}` });
    expect(new GrantPushService(f.db, 'https://console.example.test', send).publicKey()).toBe(push.publicKey());
    send.mockRejectedValueOnce({ statusCode: 410 }); await push.request(pending);
    expect(f.db.sqlite.prepare('select count(*) as n from agent_push_subscriptions').get()).toEqual({ n: 0 });
  });
});
