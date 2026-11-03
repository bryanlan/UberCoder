import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import type { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { GrantService } from '../src/grants/service.js';
import { AgentSessionLaunches } from '../src/grants/session-launches.js';
import { continuationControl } from '../src/coordination/continuation.js';
import { GRANTED_RESTART_PROMPT, PEER_WAKE_PROMPT, peerWakePaused, setPeerWakePaused } from '../src/coordination/wake.js';
import { dispatchGrants } from '../src/grants/transport.js';
import type { TurnInput } from '../src/providers/transport/types.js';
import { project, providerSettings } from './helpers/session-fixtures.js';
import { settle, structuredSessionFixture } from './helpers/structured-session-fixture.js';

type LaunchRequest = Parameters<AgentSessionLaunches['request']>[2];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
});

/**
 * A planner lead with a grant recorded from its own human message, launching and controlling helper conversations through the
 * durable request queue, the real session manager and the fake transport plugin.
 */
async function fixture(maxConcurrentSessions = 2, models: string[] = []) {
  let authority: GrantService | undefined;
  const f = structuredSessionFixture({ manager: { launchAuthorityContext: context => authority?.authorityContext(context) } });
  cleanups.push(f.cleanup);
  const grants = new GrantService(f.db, f.bus);
  authority = grants;
  const coordination = new CoordinationService(f.db, { enabled: true, pilotPaths: [] }, undefined, grants);
  const native = randomUUID(), token = randomUUID(), actor = coordination.register({ provider: 'codex', nativeSessionId: native, token, pid: process.pid, cwd: f.root }).assignmentId!;
  coordination.update(actor, { description: 'Planner lead', continuation: 'unattended' });
  const lead = randomUUID(), log = path.join(f.root, 'lead.jsonl'), words = 'I authorize all planner demo work, including launch, restart and helper delegation.';
  fs.writeFileSync(log, JSON.stringify({ type: 'user-input', text: words, timestamp: new Date().toISOString() }) + '\n');
  f.db.boundSessions.upsert({ id: lead, provider: 'codex', projectSlug: project.slug, conversationRef: native, status: 'bound', shouldRestore: true,
    title: 'Planner lead', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), eventLogPath: log });
  const grant = await grants.record(actor, { grantee: { kind: 'assignment', id: actor }, scope: words, limits: { maxConcurrentSessions, models } }, `live:${lead}:0`);
  let memory = 'MemAvailable: 8000000 kB';
  let projectRead: (() => Promise<void>) | undefined;
  const queue = () => new AgentSessionLaunches(f.db, grants, f.manager, { getProjectBySlug: async slug => { await projectRead?.(); return slug === project.slug ? project : undefined; }, getMergedProviderSettings: () => providerSettings },
    { get: () => f.adapter }, f.bus, 1024 * 1024, () => memory);
  let launches = queue();
  cleanups.push(async () => { await launches.stop(); });
  const launch = async (input: LaunchRequest = {}) => {
    const result = await launches.request(actor, 'launch_session', { projectSlug: project.slug, provider: 'codex', model: 'gpt-6-luna', effort: 'medium', prompt: 'Complete the planner lane.', title: 'Planner lane', ...input });
    await launches.drain();
    return result;
  };
  const child = (sessionId: string) => {
    const session = f.db.boundSessions.getById(sessionId)!;
    return coordination.register({ provider: 'codex', nativeSessionId: session.conversationRef.startsWith('pending:') ? randomUUID() : session.conversationRef, token: randomUUID(), pid: process.pid, cwd: f.root, consoleSessionId: sessionId }).assignmentId!;
  };
  const nativeRef = (sessionId: string) => f.db.boundSessions.getById(sessionId)!.conversationRef;
  /** Every transport session that served a conversation, across reloads. */
  const threads = (sessionId: string) => f.plugin.instances.flatMap(instance => instance.sessions).filter(thread => thread.nativeSessionId === nativeRef(sessionId));
  const thread = (sessionId: string) => threads(sessionId).at(-1)!;
  const turns = (sessionId: string) => threads(sessionId).flatMap(candidate => candidate.calls).filter(call => call.method === 'sendTurn').map(call => (call.args[0] as TurnInput).text);
  /** New helper threads the plugin started. */
  const starts = () => f.plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'start').length;
  /** Reloads of a conversation that was already running (a restart, or a wake of a sleeping one). */
  const resumes = (sessionId: string) => f.plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'resume' && call.args[0] === nativeRef(sessionId)).length;
  /** The helper's opening turn ends. */
  const finishOpeningTurn = async (sessionId: string) => { thread(sessionId).completeTurn(); await settle(); };
  return { db: f.db, root: f.root, grants, coordination, manager: f.manager, actor, token, grant, lead, get launches() { return launches; }, launch, child,
    threads, thread, turns, starts, resumes, finishOpeningTurn, row: (id: string) => f.db.boundSessions.getById(id)!,
    setMemory: (value: string) => { memory = value; },
    onProjectRead: (hook: () => Promise<void>) => { projectRead = hook; },
    restartQueue: async () => { await launches.stop(); launches = queue(); } };
}

/** The helper's native transcript is indexed and readable, as close requires before it retires the session. */
function indexHistory(db: AppDatabase, session: BoundSession): string {
  const transcriptPath = path.join(path.dirname(path.dirname(session.eventLogPath!)), `native-${session.id}.jsonl`);
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Completed helper work.' } }) + '\n');
  db.conversationIndex.upsert({ ref: session.conversationRef, kind: 'history', projectSlug: session.projectSlug, provider: session.provider,
    title: session.title ?? 'Helper', updatedAt: new Date().toISOString(), transcriptPath, isBound: true, degraded: false });
  return transcriptPath;
}

describe('Granted real-session launch pipeline', () => {
  it.each(['memory', 'launch', 'failure'] as const)('does not resurrect cancellation during a %s retry', async boundary => {
    const f = await fixture(); f.setMemory('MemAvailable: 100 kB');
    await f.launch();
    const request = f.launches.status(f.actor).requests[0]!;
    if (boundary !== 'memory') f.setMemory('MemAvailable: 8000000 kB');
    f.onProjectRead(async () => {
      expect(f.launches.cancel(request.id, f.actor).cancelled).toBe(true);
      if (boundary === 'failure') throw new Error('Project read failed after cancellation');
    });
    await f.launches.drain();
    expect(f.launches.status(f.actor, request.id).requests[0]).toMatchObject({ status: 'cancelled', reason: 'Cancelled by requester.' });
    await f.restartQueue(); await f.launches.drain();
    expect(f.launches.cancel(request.id, f.actor).cancelled).toBe(true);
    expect(f.launches.status(f.actor, request.id).requests[0]?.status).toBe('cancelled');
    expect(f.starts()).toBe(0);
  });

  it('allows human cancellation, rejects another owner, and reports started requests as too late', async () => {
    const f = await fixture(); f.setMemory('MemAvailable: 100 kB'); await f.launch();
    const request = f.launches.status(f.actor).requests[0]!;
    expect(() => f.launches.cancel(request.id, randomUUID())).toThrow('another assignment');
    f.db.sqlite.prepare("update agent_session_requests set status='starting' where id=?").run(request.id);
    expect(f.launches.cancel(request.id)).toMatchObject({ cancelled: false, reason: expect.stringContaining('Too late') });
    f.db.sqlite.prepare("update agent_session_requests set status='queued' where id=?").run(request.id);
    expect(f.launches.cancel(request.id).cancelled).toBe(true);
    await f.launch({ requestId: request.id });
    expect(f.starts()).toBe(0);
  });

  it('wakes a supervisor after granted worker launches, an ordinary turn end and action-needed BLOCKED', async () => {
    const f = await fixture();
    await f.launch({ title: 'Lane one', supervisorId: f.actor }); await f.launch({ title: 'Lane two', supervisorId: f.actor });
    const sessions = f.launches.status(f.actor).requests.map(request => request.session!);
    const worker = f.child(sessions[0]!.id);
    expect(continuationControl(f.db, worker).supervisorId).toBe(f.actor);
    f.child(sessions[1]!.id);
    f.coordination.update(f.actor, { status: 'waiting' }); // Ordinary native Stop.
    expect(continuationControl(f.db, f.actor).continuation).toBe('unattended');
    expect(peerWakePaused(f.db, f.actor)).toBe(false);
    f.coordination.update(worker, { summary: 'Lane one completed its requested work.', task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked', actionNeeded: 'Review this result to unblock the assigned task' }, priority: 'P1', wakeReason: 'The critical assigned run is paused for this result; act now so it can resume before its waiting window ends.' });
    await f.manager.wakePendingAssignments();
    // The lead conversation was not loaded: the wake reloads it and starts the inbox turn there.
    expect(f.resumes(f.lead)).toBe(1);
    expect(f.turns(f.lead)).toEqual([PEER_WAKE_PROMPT]);
    expect(continuationControl(f.db, f.actor).continuation).toBe('unattended');
    const inbox = f.coordination.poll(f.actor);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ senderId: worker, recipientId: f.actor });
    f.coordination.acknowledge(f.actor, [inbox.messages[0]!.id]);
  });

  it('closes its own helper under low memory, retains history and deduplicates close across controller restart', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    const transcriptPath = indexHistory(f.db, session), before = fs.readFileSync(transcriptPath, 'utf8');
    f.setMemory('MemAvailable: 100 kB');
    const requestId = randomUUID();
    await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId });
    await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]).toMatchObject({ status: 'completed', action: 'close_session' });
    expect(f.row(session.id)).toMatchObject({ status: 'ended', shouldRestore: false });
    expect(f.manager.listActiveSessions().map(s => s.id)).not.toContain(session.id);
    expect(f.thread(session.id).closed).toBe(true);
    expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(before);
    await f.restartQueue();
    await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId });
    await f.launches.drain(); await f.manager.reconcileSessions();
    expect(f.starts()).toBe(1);
    expect(f.resumes(session.id)).toBe(0);
    expect(f.grants.snapshot().uses.filter(use => use.action === 'close_session')).toHaveLength(1);
  });

  it('does not let another agent sharing the same grant close a helper, or let the launcher close a human session', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    const other = f.child(session.id);
    expect(f.grants.grantsFor(other)[0]?.id).toBe(f.grant.id);
    await expect(f.launches.request(other, 'close_session', { sessionId: session.id })).rejects.toThrow('only sessions your assignment launched');
    const human = f.db.boundSessions.list().find(s => !s.launchContext)!;
    await expect(f.launches.request(f.actor, 'close_session', { sessionId: human.id })).rejects.toThrow('only sessions your assignment launched');
    expect(f.row(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    expect(f.thread(session.id).closed).toBe(false);
  });

  it('keeps existing grants narrow until close_session is explicitly authorized', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    const definition = { ...f.grant, actions: ['launch_session', 'restart_session'] };
    f.db.sqlite.prepare('update agent_grants set definition_json=? where id=?').run(JSON.stringify(definition), f.grant.id);
    expect(await f.launches.request(f.actor, 'close_session', { sessionId: session.id })).toMatchObject({ requiresGrant: true });
    expect(f.thread(session.id).closed).toBe(false);
  });

  it('waits for indexed history, then closes the original target from a persisted starting request', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!, requestId = randomUUID();
    await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId }); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]).toMatchObject({ status: 'queued', reason: expect.stringContaining('transcript') });
    expect(f.thread(session.id).closed).toBe(false);
    indexHistory(f.db, f.row(session.id));
    f.db.sqlite.prepare("update agent_session_requests set status='starting' where id=?").run(requestId);
    await f.restartQueue(); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('completed');
    expect(f.row(session.id).shouldRestore).toBe(false);
    expect(f.thread(session.id).closed).toBe(true);
    await expect(f.launches.request(f.actor, 'close_session', { sessionId: randomUUID(), requestId })).rejects.toThrow('different session');
  });

  it('cancels a history-deferred close when the grant is revoked', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!, requestId = randomUUID();
    await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId }); await f.launches.drain();
    f.grants.revoke(f.grant.id); indexHistory(f.db, session); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('cancelled');
    expect(f.thread(session.id).closed).toBe(false);
  });

  it('reports a failed close and retains the live helper in Work when its provider cannot be stopped', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!; indexHistory(f.db, session);
    f.thread(session.id).close = async () => { throw new Error('The provider did not stop.'); };
    const requestId = randomUUID(); await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId }); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('failed');
    expect(f.row(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    expect(f.manager.listActiveSessions().map(s => s.id)).toContain(session.id);
  });

  it.each(['authority', 'ownership'] as const)('rechecks %s inside the session command lock before close', async (boundary) => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!; indexHistory(f.db, session);
    await f.finishOpeningTurn(session.id);
    // A human message holds the session's command lock while the close is requested.
    const thread = f.thread(session.id), sendTurn = thread.sendTurn.bind(thread);
    let entering!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { entering = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    thread.sendTurn = async input => { entering(); await released; return sendTurn(input); };
    const human = f.manager.sendInput(session.id, 'One more check before you stop.');
    await entered;
    const requestId = randomUUID();
    await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId });
    const draining = f.launches.drain();
    await settle();
    // The checks before the lock passed; the close waits for the lock.
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('starting');
    if (boundary === 'authority') f.grants.revoke(f.grant.id);
    else f.db.boundSessions.setLaunchContext(session.id, { ...session.launchContext!, launchedBy: randomUUID() });
    release(); await human; await draining;
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('failed');
    expect(thread.closed).toBe(false);
    expect(f.row(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
  });

  it('queues under low memory, launches the same reservation when memory returns, and records agent input separately', async () => {
    const f = await fixture(); f.setMemory('MemAvailable: 100 kB'); const request = await f.launch() as { requests: Array<{ id: string; sessionId: string }> };
    const id = request.requests[0]!.id; expect(f.launches.status(f.actor, id).requests[0]).toMatchObject({ status: 'queued', reason: 'Waiting for available memory.' }); expect(f.starts()).toBe(0);
    f.setMemory('MemAvailable: 8000000 kB'); await f.launches.drain();
    const result = f.launches.status(f.actor, id).requests[0]!; expect(result.status).toBe('completed');
    expect(result.sessionId).toBe(request.requests[0]!.sessionId);
    expect(result.session).toMatchObject({ launchContext: { launchedBy: f.actor, grantIds: [f.grant.id], model: 'gpt-6-luna', effort: 'medium', supervisorId: f.actor } });
    const log = fs.readFileSync(result.session!.eventLogPath!, 'utf8'); expect(log).toContain('"type":"agent-input"'); expect(log).not.toContain('"type":"user-input"');
    const opening = log.split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; text: string }).find(line => line.type === 'agent-input')!;
    expect(opening.text).toContain("Bryan's grant");
    expect(f.turns(result.sessionId)).toEqual([opening.text]);
    const child = f.child(result.sessionId); expect(f.grants.grantsFor(child)[0]?.id).toBe(f.grant.id); expect(continuationControl(f.db, child)).toMatchObject({ continuation: 'unattended', supervisorId: f.actor });
    expect(f.grants.latestHumanInput(child)).toBeUndefined();
    await expect(f.grants.record(child, { grantee: { kind: 'assignment', id: child }, scope: 'Copied opener' }, `live:${result.sessionId}:0`)).rejects.toThrow('not Console human input');
  });

  it('applies concurrent limits across inherited helpers and frees the slot without a new approval', async () => {
    const f = await fixture(1); await f.launch(); const first = f.launches.status(f.actor).requests[0]!; const child = f.child(first.sessionId);
    const pending = await f.launches.request(child, 'launch_session', { projectSlug: project.slug, provider: 'codex', model: 'gpt-6-luna', prompt: 'Delegate within the same grant.' }) as { requests: Array<{ id: string }> };
    await f.launches.drain(); expect(f.launches.status(child, pending.requests[0]!.id).requests[0]).toMatchObject({ status: 'queued', reason: 'Waiting for a granted session slot.' });
    expect(f.starts()).toBe(1);
    f.db.boundSessions.setManualSuspendedAt(first.sessionId, new Date().toISOString()); await f.launches.drain();
    expect(f.launches.status(child, pending.requests[0]!.id).requests[0]?.status).toBe('completed'); expect(f.grants.snapshot().grants).toHaveLength(1);
    expect(f.starts()).toBe(2);
  });

  it('requires a matching action/project/model and cancels a queued action after revoke', async () => {
    const f = await fixture(2, ['gpt-6-luna']);
    expect(await f.launch({ model: 'gpt-6.1-sol' })).toMatchObject({ requiresGrant: true }); expect(f.starts()).toBe(0);
    f.setMemory('MemAvailable: 100 kB'); const request = await f.launch() as { requests: Array<{ id: string }> };
    f.grants.revoke(f.grant.id); await f.launches.drain(); expect(f.launches.status(f.actor, request.requests[0]!.id).requests[0]?.status).toBe('cancelled'); expect(f.starts()).toBe(0);
  });

  it('checks a launch that names no model against the Medium model of the catalog', async () => {
    const none = { model: undefined, effort: undefined };
    // The stand-in catalog (test/helpers/fake-wo.mjs) makes gpt-6.1-terra the Codex Medium model.
    const allowed = await fixture(2, ['gpt-6.1-terra']);
    allowed.setMemory('MemAvailable: 100 kB');
    expect(await allowed.launch(none)).not.toMatchObject({ requiresGrant: true });
    const refused = await fixture(2, ['gpt-6-luna']);
    expect(await refused.launch(none)).toMatchObject({ requiresGrant: true, model: 'gpt-6.1-terra' });
    expect(refused.starts()).toBe(0);
  });

  it('deduplicates a submitted launch ID and retains its reservation through controller restart', async () => {
    const f = await fixture(); f.setMemory('MemAvailable: 100 kB'); const requestId = randomUUID(); await f.launch({ requestId }); await f.launch({ requestId });
    expect(f.launches.status(f.actor).requests).toHaveLength(1); expect(f.grants.snapshot().uses).toHaveLength(1);
    const reservation = f.launches.status(f.actor, requestId).requests[0]!.sessionId;
    await f.restartQueue(); expect(f.launches.status(f.actor, requestId).requests[0]?.sessionId).toBe(reservation);
    f.setMemory('MemAvailable: 8000000 kB'); await f.launches.drain(); await f.launch({ requestId }); expect(f.starts()).toBe(1); expect(f.grants.snapshot().uses).toHaveLength(1);
    expect(f.row(reservation)).toMatchObject({ status: 'bound', shouldRestore: true });
  });

  it('recovers a persisted starting action without creating a second live session', async () => {
    const f = await fixture(); const requestId = randomUUID(); await f.launch({ requestId });
    f.db.sqlite.prepare("update agent_session_requests set status='starting' where id=?").run(requestId);
    await f.restartQueue(); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('completed'); expect(f.starts()).toBe(1);
  });

  it('cancels a memory-queued launch when the requesting assignment finishes', async () => {
    const f = await fixture(); f.setMemory('MemAvailable: 100 kB'); await f.launch(); f.coordination.finish(f.actor, 'Work completed without this helper.');
    f.setMemory('MemAvailable: 8000000 kB'); await f.launches.drain();
    expect(f.launches.status(f.actor).requests[0]).toMatchObject({ status: 'cancelled', reason: 'The requesting assignment has finished.' }); expect(f.starts()).toBe(0);
  });

  it('defers a granted restart while the original session is working and fails it under a human pause', async () => {
    const f = await fixture(); await f.launch(); const session = f.launches.status(f.actor).requests[0]!.session!; f.child(session.id);
    // The opening turn is still running, and a grant never ends work in progress.
    const result = await f.launches.request(f.actor, 'restart_session', { sessionId: session.id }) as { requests: Array<{ id: string }> }; await f.launches.drain();
    expect(f.launches.status(f.actor, result.requests[0]!.id).requests[0]).toMatchObject({ status: 'queued', reason: 'Restart is waiting for the current work to finish.' });
    expect(f.thread(session.id).calls.map(call => call.method)).not.toContain('unload');
    expect(f.resumes(session.id)).toBe(0);
    f.db.boundSessions.setManualSuspendedAt(session.id, new Date().toISOString()); await f.launches.drain();
    expect(f.resumes(session.id)).toBe(0); expect(f.launches.status(f.actor, result.requests[0]!.id).requests[0]?.status).toBe('failed');
  });

  it.each(['unattended', 'waiting_for_input', 'finished'] as const)('starts a new turn on a granted restart of an idle %s assignment', async state => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    indexHistory(f.db, session);
    await f.finishOpeningTurn(session.id);
    const worker = f.child(session.id);
    if (state === 'finished') f.coordination.finish(worker, 'Previous assignment completed.');
    else f.coordination.update(worker, { continuation: state, status: 'waiting' });
    const before = continuationControl(f.db, worker);
    const requestId = randomUUID();
    await dispatchGrants(f.coordination, f.grants, { action: 'restart', assignmentId: f.actor, token: f.token,
      targetAssignmentId: worker, requestId }, f.launches);
    await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]).toMatchObject({ status: 'completed', sessionId: session.id });
    // The original conversation was reloaded, not replaced, and the restart turn started in it.
    expect(f.resumes(session.id)).toBe(1);
    expect(f.row(session.id).conversationRef).toBe(session.conversationRef);
    expect(f.turns(session.id).at(-1)).toBe(GRANTED_RESTART_PROMPT);
    expect(f.starts()).toBe(1);
    expect(f.row(session.id).runFailure).toBeUndefined();
    expect(continuationControl(f.db, worker)).toEqual(before);
    await f.restartQueue();
    await f.launches.request(f.actor, 'restart_session', { targetAssignmentId: worker, requestId }); await f.launches.drain();
    expect(f.resumes(session.id)).toBe(1);
    await expect(f.launches.request(f.actor, 'restart_session', { sessionId: randomUUID(), requestId })).rejects.toThrow('different restart target');
  });

  it('passes the requested restart task to the original conversation and rejects ambiguous or missing targets', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    indexHistory(f.db, session); await f.finishOpeningTurn(session.id); const worker = f.child(session.id);
    await expect(f.launches.request(f.actor, 'restart_session', { targetAssignmentId: randomUUID() })).rejects.toThrow('no restorable Console session');
    await expect(f.launches.request(f.actor, 'restart_session', { sessionId: session.id, targetAssignmentId: worker })).rejects.toThrow('either');
    await f.launches.request(f.actor, 'restart_session', { sessionId: session.id, prompt: 'Reconcile the remaining comparison work.' });
    await f.launches.drain();
    expect(f.resumes(session.id)).toBe(1);
    expect(f.turns(session.id).at(-1)).toBe('Reconcile the remaining comparison work.');
    expect(f.turns(session.id)).not.toContain(GRANTED_RESTART_PROMPT);
  });

  it.each(['stop', 'revoked'] as const)('preserves %s during a granted restart', async boundary => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    indexHistory(f.db, session); await f.finishOpeningTurn(session.id); f.child(session.id);
    // The Stop or revocation lands while the old conversation is being unloaded.
    const thread = f.thread(session.id), unload = thread.unload.bind(thread);
    let stop: Promise<unknown> | undefined;
    thread.unload = async () => {
      if (boundary === 'stop') stop = f.manager.sendKeystrokes(session.id, { keys: ['Escape'] });
      else f.grants.revoke(f.grant.id);
      return unload();
    };
    const requested = await f.launches.request(f.actor, 'restart_session', { sessionId: session.id }) as { requests: Array<{ id: string }> };
    await f.launches.drain();
    await stop;
    expect(f.resumes(session.id)).toBe(0);
    expect(f.turns(session.id)).not.toContain(GRANTED_RESTART_PROMPT);
    expect(f.launches.status(f.actor, requested.requests[0]!.id).requests[0]).toMatchObject(boundary === 'stop'
      ? { status: 'queued', reason: expect.stringContaining('session pause') } : { status: 'failed' });
    expect(f.row(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
  });

  it('rechecks Stop after restore preparation before starting the replacement', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    indexHistory(f.db, session); await f.finishOpeningTurn(session.id); const worker = f.child(session.id);
    // Clearing the old run's failure is the last preparation step before the reload; a Stop that lands there still holds the restart.
    const setRunFailure = f.db.boundSessions.setRunFailure.bind(f.db.boundSessions);
    vi.spyOn(f.db.boundSessions, 'setRunFailure').mockImplementation((id, failure) => {
      if (id === session.id) setPeerWakePaused(f.db, worker, true);
      setRunFailure(id, failure);
    });
    await f.launches.request(f.actor, 'restart_session', { sessionId: session.id }); await f.launches.drain();
    expect(f.resumes(session.id)).toBe(0);
    expect(f.launches.status(f.actor).requests[0]).toMatchObject({ status: 'queued', reason: expect.stringContaining('session pause') });
  });

  it('attaches shared active grants to peer messages and drops revoked authority immediately', async () => {
    const f = await fixture(); await f.launch(); const session = f.launches.status(f.actor).requests[0]!.session!; const worker = f.child(session.id);
    const messageId = randomUUID(); f.coordination.send(f.actor, { priority: 'P2', id: messageId, recipientId: worker, text: 'Continue the broader planner task within our grant.' });
    expect(f.coordination.poll(worker).messages[0]).toMatchObject({ id: messageId, grantIds: [f.grant.id] });
    f.grants.revoke(f.grant.id); expect(f.grants.grantsFor(worker)).toEqual([]); expect(continuationControl(f.db, worker).continuation).toBe('waiting_for_input');
    expect(f.coordination.poll(worker, false).authority).toEqual([]);
  });
});
