import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { CoordinationService } from '../src/coordination/service.js';
import { GrantService } from '../src/grants/service.js';
import { AgentSessionLaunches } from '../src/grants/session-launches.js';
import { continuationControl } from '../src/coordination/continuation.js';
import { GRANTED_RESTART_PROMPT, PEER_WAKE_PROMPT, peerWakePaused, setPeerWakePaused } from '../src/coordination/wake.js';
import { dispatchGrants } from '../src/grants/transport.js';
import { FakeTmux, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';
import type { BoundSession } from '@agent-console/shared';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(maxConcurrentSessions = 2, models: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-launches-')), db = new AppDatabase(path.join(root, 'fixture.sqlite'));
  const events = new RealtimeEventBus(), tmux = new FakeTmux(); tmux.paneText = 'OpenAI Codex\nCompleted response.\n› Ask Codex to do anything\ngpt-6-luna xhigh · 90% left · ~/demo';
  const adapter = { ...provider, getLaunchCommand: (_project: unknown, ref: string | null, _settings: unknown, options?: { model?: string; effort?: string; flags?: string[]; initialPrompt?: string }) =>
    ({ cwd: root, argv: ['codex', '--model', options?.model ?? 'gpt-6.1-sol', ...(ref ? ['resume',ref] : []), ...(options?.flags ?? []), ...(options?.initialPrompt ? [options.initialPrompt] : [])], env: {} }) };
  const manager = createRecoveryManager(db, tmux, root, events, adapter, providerSettings,
    { queueCodexNotice: async (_id, _settings, _cwd, prompt) => { tmux.sent.push(prompt); } });
  const grants = new GrantService(db, events);
  const coordination = new CoordinationService(db, { enabled: true, pilotPaths: [] }, undefined, grants);
  const native = randomUUID(), token = randomUUID(), actor = coordination.register({ provider: 'codex', nativeSessionId: native, token, pid: process.pid, cwd: root }).assignmentId!;
  coordination.update(actor, { description: 'Planner lead', continuation: 'unattended' });
  const lead = randomUUID(), log = path.join(root,'lead.jsonl'), words = 'I authorize all planner demo work, including launch, restart and helper delegation.';
  fs.writeFileSync(log, JSON.stringify({ type: 'user-input', text: words, timestamp: new Date().toISOString() })+'\n');
  db.boundSessions.upsert({ id: lead, provider: 'codex', projectSlug: project.slug, conversationRef: native, tmuxSessionName: 'lead', status:'bound', shouldRestore:true,
    title:'Planner lead', startedAt:new Date().toISOString(), updatedAt:new Date().toISOString(), eventLogPath:log });
  const grant = await grants.record(actor, { grantee:{kind:'assignment',id:actor}, scope:words, limits:{maxConcurrentSessions,models} }, `live:${lead}:0`);
  let memory = 'MemAvailable: 8000000 kB';
  let projectRead: (() => Promise<void>) | undefined;
  const queue = () => new AgentSessionLaunches(db, grants, manager, { getProjectBySlug: async slug => { await projectRead?.(); return slug===project.slug?project:undefined; }, getMergedProviderSettings:()=>providerSettings },
    {get:()=>adapter},events,1024*1024,()=>memory);
  let launches = queue();
  const launch = async (input = {}) => { const result = await launches.request(actor,'launch_session',{ projectSlug:project.slug,provider:'codex',model:'gpt-6-luna',effort:'medium',flags:['--no-alt-screen'],prompt:'Complete the planner lane.',title:'Planner lane',...input }); await launches.drain(); return result; };
  const child = (sessionId: string) => {
    const session = db.boundSessions.getById(sessionId)!;
    const id = coordination.register({ provider:'codex',nativeSessionId:session.conversationRef.startsWith('pending:') ? randomUUID() : session.conversationRef,token:randomUUID(),pid:process.pid,cwd:root,consoleSessionId:sessionId }).assignmentId!;
    return id;
  };
  cleanups.push(async()=>{await launches.stop();await manager.stop();db.close();fs.rmSync(root,{recursive:true,force:true});});
  return {db,tmux,adapter,grants,coordination,manager,actor,token,grant,get launches(){return launches;},launch,child,setMemory:(value:string)=>{memory=value;},
    onProjectRead: (hook: () => Promise<void>) => { projectRead = hook; },
    restartQueue:async()=>{await launches.stop(); launches=queue();}};
}

function indexHistory(db: AppDatabase, session: BoundSession): string {
  const ref = randomUUID(), transcriptPath = path.join(path.dirname(path.dirname(session.eventLogPath!)), `native-${session.id}.jsonl`);
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Completed helper work.' } }) + '\n');
  db.boundSessions.upsert({ ...session, conversationRef: ref, resumeConversationRef: ref });
  db.conversationIndex.upsert({ ref, kind: 'history', projectSlug: session.projectSlug, provider: session.provider,
    title: session.title ?? 'Helper', updatedAt: new Date().toISOString(), transcriptPath, isBound: true, degraded: false });
  return transcriptPath;
}

describe('Granted real-session launch pipeline',()=>{
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
    expect(f.tmux.created).toHaveLength(0);
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
    expect(f.tmux.created).toHaveLength(0);
  });

  it('wakes a supervisor after granted worker launches, an ordinary turn end and action-needed BLOCKED', async () => {
    const f = await fixture();
    await f.launch({ title: 'Lane one', supervisorId: f.actor }); await f.launch({ title: 'Lane two', supervisorId: f.actor });
    const sessions = f.launches.status(f.actor).requests.map(request => request.session!);
    const worker = f.child(sessions[0]!.id);
    expect(continuationControl(f.db, worker).supervisorId).toBe(f.actor);
    f.child(sessions[1]!.id);
    const lead = f.grants.sessionFor(f.actor)!;
    f.db.boundSessions.upsert({ ...lead, pid: await f.tmux.getPanePid() });
    f.tmux.alive.add(lead.tmuxSessionName);
    await f.tmux.setOption(lead.tmuxSessionName, '@agent_console_session_id', lead.id);
    f.coordination.update(f.actor, { status: 'waiting' }); // Ordinary native Stop.
    expect(continuationControl(f.db, f.actor).continuation).toBe('unattended');
    expect(peerWakePaused(f.db, f.actor)).toBe(false);
    f.tmux.sent.length = 0;
    f.tmux.paneText = 'OpenAI Codex\n\nCompleted response.\n› Ask Codex to do anything\ngpt-6.1-sol xhigh · 98% left · ~/demo';
    f.coordination.update(worker, { summary: 'Lane one completed its requested work.', task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked', actionNeeded: 'Review this result to unblock the assigned task' }, priority:'P1' });
    await f.manager.wakePendingAssignments();
    expect(f.tmux.sent).toEqual([PEER_WAKE_PROMPT]);
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
    expect(f.db.boundSessions.getById(session.id)).toMatchObject({ status: 'ended', shouldRestore: false });
    expect(f.manager.listActiveSessions().map(s => s.id)).not.toContain(session.id);
    expect(f.tmux.alive.has(session.tmuxSessionName)).toBe(false);
    expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(before);
    await f.restartQueue();
    await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId });
    await f.launches.drain(); await f.manager.reconcileSessions();
    expect(f.tmux.created.filter(name => name === session.tmuxSessionName)).toHaveLength(1);
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
    expect(f.tmux.alive.has(session.tmuxSessionName)).toBe(true);
  });

  it('keeps existing grants narrow until close_session is explicitly authorized', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    const definition = { ...f.grant, actions: ['launch_session', 'restart_session'] };
    f.db.sqlite.prepare('update agent_grants set definition_json=? where id=?').run(JSON.stringify(definition), f.grant.id);
    expect(await f.launches.request(f.actor, 'close_session', { sessionId: session.id })).toMatchObject({ requiresGrant: true });
    expect(f.tmux.alive.has(session.tmuxSessionName)).toBe(true);
  });

  it('waits for indexed history, then closes the original target from a persisted starting request', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!, requestId = randomUUID();
    await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId }); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]).toMatchObject({ status: 'queued', reason: expect.stringContaining('transcript') });
    expect(f.tmux.alive.has(session.tmuxSessionName)).toBe(true);
    indexHistory(f.db, f.db.boundSessions.getById(session.id)!);
    f.db.sqlite.prepare("update agent_session_requests set status='starting' where id=?").run(requestId);
    await f.restartQueue(); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('completed');
    expect(f.db.boundSessions.getById(session.id)?.shouldRestore).toBe(false);
    await expect(f.launches.request(f.actor, 'close_session', { sessionId: randomUUID(), requestId })).rejects.toThrow('different session');
  });

  it('cancels a history-deferred close when the grant is revoked', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!, requestId = randomUUID();
    await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId }); await f.launches.drain();
    f.grants.revoke(f.grant.id); indexHistory(f.db, session); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('cancelled');
    expect(f.tmux.alive.has(session.tmuxSessionName)).toBe(true);
  });

  it('reports a failed close and retains the live helper in Work when tmux cannot stop it', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!; indexHistory(f.db, session);
    f.tmux.failKill = true;
    const requestId = randomUUID(); await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId }); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('failed');
    expect(f.db.boundSessions.getById(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    expect(f.manager.listActiveSessions().map(s => s.id)).toContain(session.id);
    expect(f.tmux.alive.has(session.tmuxSessionName)).toBe(true);
  });

  it.each(['authority', 'ownership'] as const)('rechecks %s inside the session command lock before close', async (boundary) => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!; indexHistory(f.db, session);
    const original = f.tmux.getOption.bind(f.tmux);
    f.tmux.getOption = async (name, key) => {
      if (key === '@agent_console_session_id') {
        if (boundary === 'authority') f.grants.revoke(f.grant.id);
        else return 'another-session';
      }
      return original(name, key);
    };
    const requestId = randomUUID(); await f.launches.request(f.actor, 'close_session', { sessionId: session.id, requestId }); await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]?.status).toBe('failed');
    expect(f.tmux.alive.has(session.tmuxSessionName)).toBe(true);
    expect(f.db.boundSessions.getById(session.id)?.shouldRestore).toBe(true);
  });

  it('queues under low memory, launches the same reservation when memory returns, and records agent input separately',async()=>{
    const f=await fixture();f.setMemory('MemAvailable: 100 kB');const request=await f.launch() as {requests:Array<{id:string;sessionId:string}>};
    const id=request.requests[0]!.id;expect(f.launches.status(f.actor,id).requests[0]).toMatchObject({status:'queued',reason:'Waiting for available memory.'});expect(f.tmux.created).toEqual([]);
    f.setMemory('MemAvailable: 8000000 kB');await f.launches.drain();
    const result=f.launches.status(f.actor,id).requests[0]!;expect(result.status).toBe('completed');
    expect(result.session).toMatchObject({launchContext:{launchedBy:f.actor,grantIds:[f.grant.id],model:'gpt-6-luna',effort:'medium',flags:['--no-alt-screen'],supervisorId:f.actor}});
    const log=fs.readFileSync(result.session!.eventLogPath!,'utf8');expect(log).toContain('"type":"agent-input"');expect(log).not.toContain('"type":"user-input"');
    expect(f.tmux.createdCommands[0]).toContain('AGENT_CONSOLE_SESSION_ID');expect(JSON.parse(log.split("\n")[0]!).text).toContain("Bryan's grant");
    const child=f.child(result.sessionId);expect(f.grants.grantsFor(child)[0]?.id).toBe(f.grant.id);expect(continuationControl(f.db,child)).toMatchObject({continuation:'unattended',supervisorId:f.actor});
    expect(f.grants.latestHumanInput(child)).toBeUndefined();
    await expect(f.grants.record(child,{grantee:{kind:'assignment',id:child},scope:'Copied opener'},`live:${result.sessionId}:0`)).rejects.toThrow('not Console human input');
  });

  it('applies concurrent limits across inherited helpers and frees the slot without a new approval',async()=>{
    const f=await fixture(1);await f.launch();const first=f.launches.status(f.actor).requests[0]!;const child=f.child(first.sessionId);
    const pending=await f.launches.request(child,'launch_session',{projectSlug:project.slug,provider:'codex',model:'gpt-6-luna',prompt:'Delegate within the same grant.'}) as {requests:Array<{id:string}>};
    await f.launches.drain();expect(f.launches.status(child,pending.requests[0]!.id).requests[0]).toMatchObject({status:'queued',reason:'Waiting for a granted session slot.'});
    f.db.boundSessions.setManualSuspendedAt(first.sessionId,new Date().toISOString());await f.launches.drain();
    expect(f.launches.status(child,pending.requests[0]!.id).requests[0]?.status).toBe('completed');expect(f.grants.snapshot().grants).toHaveLength(1);
  });

  it('requires a matching action/project/model and cancels a queued action after revoke',async()=>{
    const f=await fixture(2,['gpt-6-luna']);
    expect(await f.launch({model:'gpt-6.1-sol'})).toMatchObject({requiresGrant:true});expect(f.tmux.created).toEqual([]);
    f.setMemory('MemAvailable: 100 kB');const request=await f.launch() as {requests:Array<{id:string}>};
    f.grants.revoke(f.grant.id);await f.launches.drain();expect(f.launches.status(f.actor,request.requests[0]!.id).requests[0]?.status).toBe('cancelled');expect(f.tmux.created).toEqual([]);
  });

  it('deduplicates a submitted launch ID and retains its reservation through controller restart',async()=>{
    const f=await fixture();f.setMemory('MemAvailable: 100 kB');const requestId=randomUUID();await f.launch({requestId});await f.launch({requestId});
    expect(f.launches.status(f.actor).requests).toHaveLength(1);expect(f.grants.snapshot().uses).toHaveLength(1);
    const reservation=f.launches.status(f.actor,requestId).requests[0]!.sessionId;
    await f.restartQueue();expect(f.launches.status(f.actor,requestId).requests[0]?.sessionId).toBe(reservation);
    f.setMemory('MemAvailable: 8000000 kB');await f.launches.drain();await f.launch({requestId});expect(f.tmux.created).toHaveLength(1);expect(f.grants.snapshot().uses).toHaveLength(1);
  });

  it('recovers a persisted starting action without creating a second live session',async()=>{
    const f=await fixture();const requestId=randomUUID();await f.launch({requestId});
    f.db.sqlite.prepare("update agent_session_requests set status='starting' where id=?").run(requestId);
    await f.restartQueue();await f.launches.drain();
    expect(f.launches.status(f.actor,requestId).requests[0]?.status).toBe('completed');expect(f.tmux.created).toHaveLength(1);
  });

  it('cancels a memory-queued launch when the requesting assignment finishes',async()=>{
    const f=await fixture();f.setMemory('MemAvailable: 100 kB');await f.launch();f.coordination.finish(f.actor,'Work completed without this helper.');
    f.setMemory('MemAvailable: 8000000 kB');await f.launches.drain();
    expect(f.launches.status(f.actor).requests[0]).toMatchObject({status:'cancelled',reason:'The requesting assignment has finished.'});expect(f.tmux.created).toHaveLength(0);
  });

  it('defers a granted restart while the original session has a draft or a human pause',async()=>{
    const f=await fixture();await f.launch();const session=f.launches.status(f.actor).requests[0]!.session!;f.child(session.id);
    f.tmux.paneText='› Preserve this draft\n\n  gpt-6-luna';
    const result=await f.launches.request(f.actor,'restart_session',{sessionId:session.id}) as {requests:Array<{id:string}>};await f.launches.drain();
    expect(f.launches.status(f.actor,result.requests[0]!.id).requests[0]).toMatchObject({status:'queued'});expect(f.tmux.created).toHaveLength(1);
    f.db.boundSessions.setManualSuspendedAt(session.id,new Date().toISOString());await f.launches.drain();
    expect(f.tmux.created).toHaveLength(1);expect(f.launches.status(f.actor,result.requests[0]!.id).requests[0]?.status).toBe('failed');
  });

  it.each(['unattended', 'waiting_for_input', 'finished'] as const)('starts a new turn on a granted restart of an idle %s assignment', async state => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    indexHistory(f.db, session);
    const worker = f.child(session.id);
    if (state === 'finished') f.coordination.finish(worker, 'Previous assignment completed.');
    else f.coordination.update(worker, { continuation: state, status: 'waiting' });
    const before = continuationControl(f.db, worker);
    f.db.boundSessions.upsert({ ...f.db.boundSessions.getById(session.id)!, isWorking: false });
    const requestId = randomUUID();
    await dispatchGrants(f.coordination, f.grants, { action: 'restart', assignmentId: f.actor, token: f.token,
      targetAssignmentId: worker, requestId }, f.launches);
    await f.launches.drain();
    expect(f.launches.status(f.actor, requestId).requests[0]).toMatchObject({ status: 'completed', sessionId: session.id });
    expect(f.tmux.created).toHaveLength(2);
    expect(f.tmux.createdCommands.at(-1)).toContain(GRANTED_RESTART_PROMPT);
    expect(f.tmux.createdCommands.at(-1)).toContain(f.db.boundSessions.getById(session.id)!.conversationRef);
    expect(f.db.boundSessions.getById(session.id)?.runFailure).toBeUndefined();
    expect(continuationControl(f.db, worker)).toEqual(before);
    await f.restartQueue();
    await f.launches.request(f.actor, 'restart_session', { targetAssignmentId: worker, requestId }); await f.launches.drain();
    expect(f.tmux.created).toHaveLength(2);
    await expect(f.launches.request(f.actor, 'restart_session', { sessionId: randomUUID(), requestId })).rejects.toThrow('different restart target');
  });

  it('passes the requested restart task to the original conversation and rejects ambiguous or missing targets', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    indexHistory(f.db, session); const worker = f.child(session.id);
    await expect(f.launches.request(f.actor, 'restart_session', { targetAssignmentId: randomUUID() })).rejects.toThrow('no restorable Console session');
    await expect(f.launches.request(f.actor, 'restart_session', { sessionId: session.id, targetAssignmentId: worker })).rejects.toThrow('either');
    await f.launches.request(f.actor, 'restart_session', { sessionId: session.id, prompt: 'Reconcile the remaining comparison work.' });
    await f.launches.drain();
    expect(f.tmux.createdCommands.at(-1)).toContain('Reconcile the remaining comparison work.');
    expect(f.tmux.createdCommands.at(-1)).not.toContain(GRANTED_RESTART_PROMPT);
  });

  it.each(['stop', 'revoked'] as const)('preserves %s during a granted restart', async boundary => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    indexHistory(f.db, session); f.child(session.id);
    const capture = f.tmux.capturePane.bind(f.tmux);
    let stop: Promise<unknown> | undefined, checked = false;
    f.tmux.capturePane = async (...args) => {
      if (!checked) {
        checked = true;
        if (boundary === 'stop') stop = f.manager.sendKeystrokes(session.id, { keys: ['Escape'] });
        else f.grants.revoke(f.grant.id);
      }
      return capture(...args);
    };
    await f.launches.request(f.actor, 'restart_session', { sessionId: session.id });
    await f.launches.drain();
    await stop;
    expect(f.tmux.created).toHaveLength(1);
    expect(f.tmux.alive.has(session.tmuxSessionName)).toBe(true);
  });

  it('does not restart a provider still owned outside the recorded tmux binding', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    indexHistory(f.db, session); f.child(session.id);
    f.tmux.alive.clear();
    await f.launches.request(f.actor, 'restart_session', { sessionId: session.id }); await f.launches.drain();
    expect(f.launches.status(f.actor).requests[0]).toMatchObject({ status: 'queued', reason: expect.stringContaining('live owner outside') });
    expect(f.tmux.created).toHaveLength(1);
  });

  it('rechecks Stop after asynchronous restore preparation before starting the replacement', async () => {
    const f = await fixture(); await f.launch();
    const session = f.launches.status(f.actor).requests[0]!.session!;
    indexHistory(f.db, session); const worker = f.child(session.id);
    const kill = f.tmux.killSession.bind(f.tmux);
    const command = f.adapter.getLaunchCommand;
    f.tmux.killSession = async name => {
      await kill(name);
      f.adapter.getLaunchCommand = (...args) => {
        setPeerWakePaused(f.db, worker, true);
        return command(...args);
      };
    };
    await f.launches.request(f.actor, 'restart_session', { sessionId: session.id }); await f.launches.drain();
    expect(f.tmux.created).toHaveLength(1);
    expect(f.launches.status(f.actor).requests[0]).toMatchObject({ status: 'queued', reason: expect.stringContaining('session pause') });
  });

  it('attaches shared active grants to peer messages and drops revoked authority immediately',async()=>{
    const f=await fixture();await f.launch();const session=f.launches.status(f.actor).requests[0]!.session!;const worker=f.child(session.id);
    const messageId=randomUUID();f.coordination.send(f.actor,{priority:'P2',id:messageId,recipientId:worker,text:'Continue the broader planner task within our grant.'});
    expect(f.coordination.poll(worker).messages[0]).toMatchObject({id:messageId,grantIds:[f.grant.id]});
    f.grants.revoke(f.grant.id);expect(f.grants.grantsFor(worker)).toEqual([]);expect(continuationControl(f.db,worker).continuation).toBe('waiting_for_input');
    expect(f.coordination.poll(worker,false).authority).toEqual([]);
  });
});
