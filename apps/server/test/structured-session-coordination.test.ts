import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentLaunchContext } from '@agent-console/shared';
import { CoordinationService } from '../src/coordination/service.js';
import { GRANTED_RESTART_PROMPT } from '../src/coordination/wake.js';
import { GrantService } from '../src/grants/service.js';
import { AgentSessionLaunches } from '../src/grants/session-launches.js';
import { project, provider, providerSettings } from './helpers/session-fixtures.js';
import { structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of open.splice(0)) await cleanup(); });

function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f.cleanup);
  const grants = new GrantService(f.db, f.bus, undefined, undefined, undefined,
    cwd => cwd.startsWith(project.path) ? project.slug : undefined);
  const coordination = new CoordinationService(f.db, { enabled: true, pilotPaths: [] }, undefined, grants);
  const instanceMeta = (pid: number | undefined) => {
    if (pid === undefined) f.db.sqlite.prepare("delete from meta where key='structured-instance:codex'").run();
    else f.db.meta.set('structured-instance:codex', JSON.stringify({ pid, startedAt: new Date().toISOString(), version: 'fake' }));
  };
  const register = (nativeSessionId: string, extra: { consoleSessionId?: string } = {}) =>
    coordination.register({ provider: 'codex', nativeSessionId, token: randomUUID(), pid: process.pid, cwd: `${project.path}/work`, ...extra }).assignmentId!;
  const deadPid = 2147483647;
  const stale = (assignmentId: string) =>
    f.db.sqlite.prepare("update coordination_assignments set pid=?, process_start='gone' where id=?").run(deadPid, assignmentId);
  const sender = () => coordination.register({ provider: 'claude', nativeSessionId: randomUUID(), token: randomUUID(), pid: process.pid, cwd: f.root }).assignmentId!;
  return { f, grants, coordination, instanceMeta, register, stale, sender, deadPid };
}

describe('Coordination registration for structured threads', () => {
  it('finds the Console session from the thread id when the hook carries no per-thread identity', async () => {
    const c = fixture();
    const { session } = await c.f.bindNew();
    const assignment = c.register(session.conversationRef);
    expect(c.f.db.meta.get(`console-session:${assignment}`)).toBe(session.id);
    expect(c.f.db.meta.get(`assignment-project:${assignment}`)).toBe(project.slug);
    expect(c.grants.sessionFor(assignment)?.id).toBe(session.id);
  });

  it('replaces a console session id that matches no restorable row', async () => {
    const c = fixture();
    const { session } = await c.f.bindNew();
    const assignment = c.register(session.conversationRef, { consoleSessionId: randomUUID() });
    expect(c.f.db.meta.get(`console-session:${assignment}`)).toBe(session.id);
  });

  it('does not resolve a released structured row', async () => {
    const c = fixture();
    const { session } = await c.f.bindNew();
    const threadId = session.conversationRef;
    await c.f.manager.releaseSession(session.id);
    const assignment = c.register(threadId);
    expect(c.f.db.meta.get(`console-session:${assignment}`)).toBeUndefined();
  });

  it('keeps an explicit tmux console session id as it is', async () => {
    const c = fixture();
    c.f.tmux.paneText = 'OpenAI Codex\n› \ngpt-6.1-sol xhigh · 98% left · ~/demo';
    const tmuxSession = await c.f.manager.bindConversation({ project, provider, providerSettings, conversationRef: 'tmux-thread', title: 'T', kind: 'history' });
    const assignment = c.register('tmux-thread', { consoleSessionId: tmuxSession.id });
    expect(c.f.db.meta.get(`console-session:${assignment}`)).toBe(tmuxSession.id);
  });
});

describe('Coordination liveness for structured threads', () => {
  const receipt = (c: ReturnType<typeof fixture>, recipient: string) => c.coordination.send(c.sender(), {
    id: randomUUID(), recipientId: recipient, text: 'Hello', priority: 'P2',
  });

  it('reports a bound thread as alive while the shared process runs, whatever pid the assignment recorded', async () => {
    const c = fixture();
    const { session } = await c.f.bindNew();
    const recipient = c.register(session.conversationRef);
    c.stale(recipient);
    c.instanceMeta(process.pid);
    expect(receipt(c, recipient).recipient).toMatchObject({ status: 'idle', resumableInConsole: true });
    c.f.db.boundSessions.upsert({ ...c.f.row(session.id), isWorking: true });
    expect(receipt(c, recipient).recipient.status).toBe('working');
  });

  it('reports stopped when the shared process is gone or was never recorded', async () => {
    const c = fixture();
    const { session } = await c.f.bindNew();
    const recipient = c.register(session.conversationRef);
    c.stale(recipient);
    c.instanceMeta(c.deadPid);
    expect(receipt(c, recipient).recipient.status).toBe('stopped');
    c.instanceMeta(undefined);
    expect(receipt(c, recipient).recipient.status).toBe('stopped');
  });

  it('reports stopped for a released structured row even while the shared process runs', async () => {
    const c = fixture();
    const { session } = await c.f.bindNew();
    const recipient = c.register(session.conversationRef);
    c.instanceMeta(process.pid);
    expect(receipt(c, recipient).recipient.status).not.toBe('stopped');
    await c.f.manager.releaseSession(session.id);
    expect(receipt(c, recipient).recipient).toMatchObject({ status: 'stopped', resumableInConsole: false });
  });

  it('keeps a structured assignment connected while its row is bound and the shared process lives', async () => {
    const c = fixture();
    const { session } = await c.f.bindNew();
    const recipient = c.register(session.conversationRef);
    const other = c.register(randomUUID());
    c.stale(recipient);
    c.stale(other);
    c.instanceMeta(process.pid);
    c.coordination.reconcileProcesses();
    const status = (id: string) => (c.f.db.sqlite.prepare('select status from coordination_assignments where id=?').get(id) as { status: string }).status;
    expect(status(recipient)).toBe('active');
    // An assignment with no structured binding still follows its own process.
    expect(status(other)).toBe('disconnected');
  });

  it('disconnects a structured assignment when the shared process is gone or its row was released', async () => {
    const c = fixture();
    const { session } = await c.f.bindNew();
    const recipient = c.register(session.conversationRef);
    c.stale(recipient);
    c.instanceMeta(c.deadPid);
    c.coordination.reconcileProcesses();
    expect((c.f.db.sqlite.prepare('select status from coordination_assignments where id=?').get(recipient) as { status: string }).status).toBe('disconnected');
  });
});

describe('Granted restart of a structured session', () => {
  const words = 'I authorize all planner demo work, including launch, restart and helper delegation.';

  async function restartFixture() {
    const c = fixture();
    const adapter = { ...provider, getLaunchCommand: () => ({ cwd: c.f.root, argv: ['codex', '--model', 'gpt-6.1-sol'], env: {} }) };
    const lead = randomUUID();
    const log = path.join(c.f.root, 'lead.jsonl');
    fs.writeFileSync(log, JSON.stringify({ type: 'user-input', text: words, timestamp: new Date().toISOString() }) + '\n');
    const actor = c.register(randomUUID());
    c.coordination.update(actor, { description: 'Planner lead', continuation: 'unattended' });
    const leadNative = c.f.db.sqlite.prepare('select native_session_id as n from coordination_assignments where id=?').get(actor) as { n: string };
    const now = new Date().toISOString();
    c.f.db.boundSessions.upsert({ id: lead, provider: 'codex', projectSlug: project.slug, conversationRef: leadNative.n, tmuxSessionName: 'lead',
      status: 'bound', shouldRestore: true, title: 'Planner lead', startedAt: now, updatedAt: now, eventLogPath: log } as never);
    const grant = await c.grants.record(actor, { grantee: { kind: 'assignment', id: actor }, scope: words, limits: { maxConcurrentSessions: 2, models: [] } }, `live:${lead}:0`);
    const launches = new AgentSessionLaunches(c.f.db, c.grants, c.f.manager,
      { getProjectBySlug: async slug => slug === project.slug ? project : undefined, getMergedProviderSettings: () => providerSettings },
      { get: () => adapter }, c.f.bus, 1024 * 1024, () => 'MemAvailable: 8000000 kB');
    open.push(async () => { await launches.stop(); });
    const launchContext: AgentLaunchContext = { launchedBy: actor, launcherName: 'Planner lead', grantIds: [grant.id], requestId: 'r', flags: [], supervisorId: actor };
    const { session } = await c.f.bindNew({ launchContext });
    await c.f.manager.sendInput(session.id, 'earlier work');
    c.f.thread(session.conversationRef).completeTurn();
    return { c, actor, launches, session, grant };
  }
  const request = (row: { id: string; input_json: string }) => JSON.parse(row.input_json) as { previousEpoch?: string };

  it('completes by a new load epoch, since the shared process keeps its pid', async () => {
    const { c, actor, launches, session } = await restartFixture();
    const epochBefore = c.f.db.meta.get(`structured-epoch:${session.id}`);
    const requestId = randomUUID();
    await new Promise(resolve => setTimeout(resolve, 5));
    await launches.request(actor, 'restart_session', { sessionId: session.id, requestId });
    const row = c.f.db.sqlite.prepare('select * from agent_session_requests where id=?').get(requestId) as { id: string; input_json: string };
    expect(request(row).previousEpoch).toBe(epochBefore);

    await launches.drain();
    expect(launches.status(actor, requestId).requests[0]).toMatchObject({ status: 'completed', sessionId: session.id });
    const epochAfter = c.f.db.meta.get(`structured-epoch:${session.id}`);
    expect(epochAfter).not.toBe(epochBefore);
    const turns = c.f.plugin.instance!.sessions.filter(candidate => candidate.nativeSessionId === session.conversationRef).at(-1)!.calls
      .filter(call => call.method === 'sendTurn');
    expect(turns).toHaveLength(1);
    expect((turns[0]!.args[0] as { text: string }).text).toBe(GRANTED_RESTART_PROMPT);
    expect(c.f.tmuxTouched()).toBe(0);

    // A request interrupted after the restart completed is finished by the epoch, not restarted again.
    c.f.db.sqlite.prepare("update agent_session_requests set status='starting' where id=?").run(requestId);
    await launches.drain();
    expect(launches.status(actor, requestId).requests[0]?.status).toBe('completed');
    expect(c.f.plugin.instance!.sessions.filter(candidate => candidate.nativeSessionId === session.conversationRef)).toHaveLength(2);
  });

  it('does not treat a request as finished while the epoch is unchanged', async () => {
    const { c, actor, launches, session } = await restartFixture();
    const requestId = randomUUID();
    await launches.request(actor, 'restart_session', { sessionId: session.id, requestId });
    c.f.db.sqlite.prepare("update agent_session_requests set status='starting' where id=?").run(requestId);
    // Nothing restarted yet, so the persisted request continues its reservation and performs the restart.
    await launches.drain();
    expect(launches.status(actor, requestId).requests[0]?.status).toBe('completed');
    expect(c.f.plugin.instance!.sessions.filter(candidate => candidate.nativeSessionId === session.conversationRef)).toHaveLength(2);
  });
});
