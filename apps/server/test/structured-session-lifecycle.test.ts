import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CoordinationService } from '../src/coordination/service.js';
import { project, provider, providerSettings } from './helpers/session-fixtures.js';
import { SessionInputRejectedError, StructuredSessionDisabledError } from '../src/sessions/session-manager.js';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

const open: StructuredSessionFixture[] = [];
async function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  return f;
}
afterEach(async () => { for (const f of open.splice(0)) await f.cleanup(); });

describe('Structured session bind', () => {
  it('binds a new chat to a thread without touching tmux, adopting the pending alias immediately', async () => {
    const f = await fixture();
    const { session, pendingRef } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;

    expect(session).toMatchObject({
      status: 'bound',
      shouldRestore: true,
      conversationRef: thread.nativeSessionId,
      resumeConversationRef: thread.nativeSessionId,
      pid: process.pid,
      codexProfile: 'medium',
    });
    expect(session.eventLogPath).toBeTruthy();
    expect(fs.existsSync(path.join(f.root, session.id, 'raw.log'))).toBe(false);
    // The alias stays as the URL and title carrier and points at the thread.
    expect(f.db.pendingConversations.get(pendingRef)?.rawMetadata).toMatchObject({ adoptedConversationRef: thread.nativeSessionId });
    expect(f.db.conversationIndex.get(project.slug, 'codex', thread.nativeSessionId)).toMatchObject({ kind: 'history' });
    expect(f.db.meta.get(`structured-epoch:${session.id}`)).toBeTruthy();
    expect(f.plugin.instance!.calls.filter(call => call.method === 'start')).toHaveLength(1);
    expect(f.eventTypes()).toContain('session.updated');
  });

  it('opens the thread in the project directory with approvals off and the medium profile', async () => {
    const f = await fixture();
    await f.bindNew();
    const options = f.plugin.instance!.sessions[0]!.options;
    expect(options).toMatchObject({
      cwd: project.path,
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      policy: { approvals: 'never', sandbox: 'full-access' },
    });
  });

  it('returns the same session when a pending bind is retried after adoption', async () => {
    const f = await fixture();
    const { session, pendingRef } = await f.bindNew();
    const again = await f.manager.bindConversation({
      project, provider, conversationRef: pendingRef, title: 'New Codex conversation', kind: 'pending',
    });
    expect(again.id).toBe(session.id);
    expect(f.plugin.instance!.calls.filter(call => call.method === 'start')).toHaveLength(1);
  });

  it('refuses a structured bind unless the provider lane is enabled, naming the lane in the error', async () => {
    const f = await fixture({ disabled: true });
    const error = await f.bindNew().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StructuredSessionDisabledError);
    expect((error as StructuredSessionDisabledError).statusCode).toBe(400);
    expect((error as Error).message).toMatch(/not enabled for codex: structuredSessions\.codex\.enabled/);
    expect(f.plugin.instances).toHaveLength(0);
  });

  it('fails clearly when the pending alias row is missing', async () => {
    const f = await fixture();
    await expect(f.manager.bindConversation({
      project, provider, conversationRef: 'pending:missing', title: 'x', kind: 'pending',
    })).rejects.toThrow(/must exist/);
    expect(f.plugin.instances).toHaveLength(0);
  });

  it('binds a history conversation by resuming its native session', async () => {
    const f = await fixture();
    const session = await f.bindHistory('native-history-1');
    expect(f.plugin.instance!.calls.find(call => call.method === 'resume')?.args[0]).toBe('native-history-1');
    expect(session).toMatchObject({
      status: 'bound', conversationRef: 'native-history-1', resumeConversationRef: 'native-history-1',
      pid: process.pid,
    });
  });

  it('ends a failed history bind as an error row and leaves nothing to restore', async () => {
    const f = await fixture({ plugin: { failResume: true } });
    await expect(f.bindHistory('native-missing')).rejects.toThrow(/resume/i);
    const rows = f.db.boundSessions.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error', shouldRestore: false });
  });

  it('journals the opening prompt and sends it as the first turn', async () => {
    const f = await fixture();
    const { session } = await f.bindNew({ initialPrompt: 'Plan the migration' });
    const thread = f.plugin.instance!.sessions[0]!;
    expect(thread.calls.filter(call => call.method === 'sendTurn')).toHaveLength(1);
    expect(thread.calls[0]!.args[0]).toMatchObject({ text: 'Plan the migration', model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(eventLogLines(f.row(session.id)).filter(line => line.type === 'user-input').map(line => line.text)).toEqual(['Plan the migration']);
    await settle();
    expect(f.row(session.id).isWorking).toBe(true);
    expect(f.row(session.id).lastActivityAt).toBeTruthy();
  });

  it('journals an automatic opening prompt as agent input', async () => {
    const f = await fixture();
    const { session } = await f.bindNew({ initialPrompt: 'Helper task', initialPromptIsHuman: false });
    const lines = eventLogLines(f.row(session.id));
    expect(lines.some(line => line.type === 'agent-input' && line.text === 'Helper task')).toBe(true);
    expect(lines.some(line => line.type === 'user-input')).toBe(false);
  });

  it('rolls the bind back when the opening prompt cannot be sent', async () => {
    const f = await fixture();
    f.plugin.create = ((original) => function (this: unknown, ...args: Parameters<typeof original>) {
      const instance = original.apply(this, args);
      const start = instance.start.bind(instance);
      instance.start = async (options) => {
        const session = await start(options);
        session.sendTurn = async () => { throw new Error('sendTurn exploded'); };
        return session;
      };
      return instance;
    })(f.plugin.create.bind(f.plugin));
    await expect(f.bindNew({ initialPrompt: 'Go' })).rejects.toThrow('sendTurn exploded');
    expect(f.db.boundSessions.list()[0]).toMatchObject({ status: 'error', shouldRestore: false });
    expect(f.plugin.instance!.sessions[0]!.closed).toBe(true);
  });
});

describe('Structured session screen', () => {
  it('synthesizes an idle then working screen without polling tmux', async () => {
    const f = await fixture();
    const { session } = await f.bindNew({ initialPrompt: undefined });
    const idle = await f.manager.getSessionScreen(session.id);
    expect(idle!.screen).toEqual({ status: 'Codex (app-server) idle', capturedAt: expect.any(String), model: 'gpt-6.1-sol xhigh' });
    await f.manager.sendInput(session.id, 'work');
    await settle();
    expect((await f.manager.getSessionScreen(session.id))!.screen.status).toBe('Codex (app-server) working');
  });

  it('keeps the poll cheap: a loaded session never reloads or locks', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!;
    for (let index = 0; index < 5; index += 1) await f.manager.getSessionScreen(session.id);
    expect(thread.calls.filter(call => call.method === 'resume')).toHaveLength(0);
  });

});

describe('Structured recency and working state', () => {
  it('drives working state from turn events and recency only from live output', async () => {
    const f = await fixture({ plugin: { manualTurns: true } });
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    const before = f.row(session.id);

    // Resume backfill is history: it must not move recency or working state.
    thread.push({ type: 'turn.started', turnId: 'old-1', origin: 'user', replay: true });
    thread.push({ type: 'item.completed', turnId: 'old-1', itemId: 'i0', kind: 'assistant', replay: true });
    thread.push({ type: 'turn.terminal', turnId: 'old-1', status: 'completed', sessionUsable: true, replay: true });
    await settle();
    expect(f.row(session.id)).toMatchObject({ isWorking: false, lastOutputAt: undefined, lastResponseAt: undefined, lastActivityAt: before.lastActivityAt });

    thread.push({ type: 'turn.started', turnId: 'live-1', origin: 'provider', replay: false });
    await settle();
    expect(f.row(session.id).isWorking).toBe(true);
    expect(f.row(session.id).lastActivityAt).toBeTruthy();

    thread.push({ type: 'item.completed', turnId: 'live-1', itemId: 'i1', kind: 'assistant', replay: false });
    await settle();
    const working = f.row(session.id);
    expect(working.lastOutputAt).toBeTruthy();
    expect(working.lastActivityAt).toBe(working.lastOutputAt);

    thread.push({ type: 'turn.terminal', turnId: 'live-1', status: 'completed', sessionUsable: true, replay: false });
    await settle();
    const done = f.row(session.id);
    expect(done.isWorking).toBe(false);
    expect(done.lastResponseAt).toBeTruthy();
  });

  it('records a terminal once even when the transport repeats it', async () => {
    const f = await fixture({ plugin: { manualTurns: true } });
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    thread.push({ type: 'turn.started', turnId: 't1', origin: 'user', replay: false });
    thread.push({ type: 'turn.terminal', turnId: 't1', status: 'completed', sessionUsable: true, replay: false });
    await settle();
    const first = f.row(session.id).lastResponseAt;
    expect(first).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 5));
    thread.push({ type: 'turn.terminal', turnId: 't1', status: 'failed', failure: { class: 'unknown', message: 'late' }, sessionUsable: true, replay: false });
    await settle();
    expect(f.row(session.id).lastResponseAt).toBe(first);
    expect(f.row(session.id).runFailure).toBeUndefined();
  });

  it('does not count an interrupted or failed turn as a provider response', async () => {
    const f = await fixture({ plugin: { manualTurns: true } });
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    thread.push({ type: 'turn.started', turnId: 't1', origin: 'user', replay: false });
    thread.push({ type: 'turn.terminal', turnId: 't1', status: 'interrupted', sessionUsable: true, replay: false });
    await settle();
    expect(f.row(session.id)).toMatchObject({ isWorking: false, lastResponseAt: undefined });
  });

  it('indexes the transcript once the provider reports it after a turn', async () => {
    const f = await fixture({ plugin: { manualTurns: true } });
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    const rollout = path.join(f.root, 'rollout.jsonl');
    fs.writeFileSync(rollout, '{}\n');
    thread.transcriptPath = rollout;
    thread.push({ type: 'turn.started', turnId: 't1', origin: 'user', replay: false });
    thread.push({ type: 'turn.terminal', turnId: 't1', status: 'completed', sessionUsable: true, replay: false });
    await expect.poll(() => f.db.conversationIndex.get(project.slug, 'codex', session.conversationRef)?.transcriptPath).toBe(rollout);
    expect(f.eventTypes()).toContain('conversation.index-updated');
  });
});

describe('Structured sleep, restore and release', () => {
  function backdate(f: StructuredSessionFixture, sessionId: string, minutes: number) {
    const at = new Date(Date.now() - minutes * 60_000).toISOString();
    f.db.sqlite.prepare(`update bound_sessions set started_at=?, updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, is_working=0 where id=?`)
      .run(at, at, at, at, at, at, sessionId);
  }

  it('unloads an idle thread on idle sleep and resumes it on the next use, without tmux', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    const threadId = session.conversationRef;
    backdate(f, session.id, 120);
    await f.manager.reconcileSessions();
    expect(f.calls(threadId, 'unload')).toHaveLength(1);
    expect(f.row(session.id)).toMatchObject({ pid: undefined, isWorking: false });
    expect(f.row(session.id).idleSuspendedAt).toBeTruthy();
    expect(await f.manager.getSessionScreen(session.id)).toBeUndefined();

    const epochBefore = f.db.meta.get(`structured-epoch:${session.id}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    const restored = await f.manager.sendInput(session.id, 'wake up');
    expect(restored.session.idleSuspendedAt).toBeUndefined();
    expect(f.plugin.instance!.calls.filter(call => call.method === 'resume')).toHaveLength(1);
    expect(f.plugin.instance!.calls.find(call => call.method === 'resume')?.args[0]).toBe(threadId);
    expect(f.db.meta.get(`structured-epoch:${session.id}`)).not.toBe(epochBefore);
    expect(f.row(session.id)).toMatchObject({ status: 'bound', pid: process.pid });
  });

  it('does not sleep a thread with a running turn or queued input', async () => {
    const f = await fixture({ plugin: { manualTurns: true } });
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    thread.push({ type: 'turn.started', turnId: 't1', origin: 'user', replay: false });
    await settle();
    backdate(f, session.id, 120);
    f.db.sqlite.prepare('update bound_sessions set is_working=1 where id=?').run(session.id);
    await f.manager.reconcileSessions();
    expect(f.row(session.id).idleSuspendedAt).toBeUndefined();
    expect(thread.calls.filter(call => call.method === 'unload')).toHaveLength(0);
  });

  it('leaves structured rows alone under memory pressure', async () => {
    const f = await fixture({ manager: {
      pressureSuspendAvailableBytes: 8 * 1024 ** 3, pressureSuspendIdleMs: 1,
      readMemInfo: () => 'MemAvailable:      1048576 kB\n',
    } });
    const { session } = await f.bindNew();
    backdate(f, session.id, 5);
    f.db.boundSessions.upsert({ ...f.row(session.id), lastResponseAt: new Date(Date.now() - 300_000).toISOString() });
    await f.manager.reconcileSessions();
    await f.manager.reconcileSessions();
    expect(f.row(session.id).pressureSuspendedAt).toBeUndefined();
    expect(f.calls(session.conversationRef, 'unload')).toHaveLength(0);
  });

  it('suspends manually, refuses while a turn runs, and resumes on request', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'busy');
    await settle();
    await expect(f.manager.suspendSession(session.id)).rejects.toThrow(/turn is running/i);
    f.plugin.instance!.sessions[0]!.completeTurn();
    await settle();

    const suspended = await f.manager.suspendSession(session.id);
    expect(suspended.manualSuspendedAt).toBeTruthy();
    expect(f.calls(session.conversationRef, 'unload')).toHaveLength(1);
    const resumed = await f.manager.resumeSession(session.id);
    expect(resumed.manualSuspendedAt).toBeUndefined();
    expect(f.plugin.instance!.calls.filter(call => call.method === 'resume')).toHaveLength(1);
  });

  it('reads asleep while the thread is unloaded (manual and idle sleep), and idle again once it is restored', async () => {
    const statusesOf = (f: StructuredSessionFixture, sessionId: string) => f.events
      .flatMap(event => event.type === 'session.screen-updated' && event.sessionId === sessionId ? [event.screen.status] : []);

    const manual = await fixture();
    const { session } = await manual.bindNew();
    expect(statusesOf(manual, session.id).at(-1)).toBe('Codex (app-server) idle');
    await manual.manager.suspendSession(session.id);
    expect(statusesOf(manual, session.id).at(-1)).toBe('Codex (app-server) asleep'); // published after the unload
    expect(await manual.manager.getSessionScreen(session.id)).toBeUndefined(); // a suspended row has no screen to poll
    await manual.manager.resumeSession(session.id);
    expect(statusesOf(manual, session.id).at(-1)).toBe('Codex (app-server) idle'); // published once the thread is back
    expect(manual.plugin.instance!.sessions[0]!.calls.filter(call => call.method === 'unload')).toHaveLength(1);

    const idle = await fixture();
    const { session: sleeper } = await idle.bindNew();
    backdate(idle, sleeper.id, 180);
    await idle.manager.reconcileSessions();
    expect(idle.row(sleeper.id).idleSuspendedAt).toBeTruthy();
    expect(statusesOf(idle, sleeper.id).at(-1)).toBe('Codex (app-server) asleep');
    await idle.manager.sendInput(sleeper.id, 'wake up');
    expect(statusesOf(idle, sleeper.id).at(-1)).toMatch(/Codex \(app-server\) (idle|working)/);
  });

  it('interrupts a running turn, unloads and ends the thread on release', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'long task');
    await settle();
    const thread = f.plugin.instance!.sessions[0]!;
    await f.manager.releaseSession(session.id);

    const methods = thread.calls.map(call => call.method);
    expect(methods).toEqual(expect.arrayContaining(['interrupt', 'unload', 'close']));
    expect(methods.indexOf('interrupt')).toBeLessThan(methods.indexOf('unload'));
    expect(thread.calls.find(call => call.method === 'close')?.args[0]).toBe('release');
    expect(f.row(session.id)).toMatchObject({ status: 'ended', shouldRestore: false, isWorking: false, pid: undefined });
    expect(f.db.meta.get(`structured-epoch:${session.id}`)).toBeUndefined();
    expect(f.eventTypes()).toContain('session.released');
  });

  it('releases an idle structured session after the nine-day work window, ending its thread', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    const transcript = path.join(f.root, 'rollout.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    f.db.conversationIndex.upsert({
      ref: session.conversationRef, kind: 'history', projectSlug: project.slug, provider: 'codex', title: 'Old work',
      updatedAt: new Date().toISOString(), transcriptPath: transcript, isBound: true, degraded: false,
    });
    backdate(f, session.id, 10 * 24 * 60);
    await f.manager.reconcileSessions();
    expect(f.row(session.id)).toMatchObject({ status: 'ended', shouldRestore: false });
    expect(f.calls(session.conversationRef, 'close')[0]!.args[0]).toBe('release');
  });

  it('does not reload the thread of a finished assignment, keeping its inbox restorable', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    const coordination = new CoordinationService(f.db, { enabled: true, pilotPaths: [] });
    const assignment = coordination.register({ provider: 'codex', nativeSessionId: session.conversationRef, token: randomUUID(), pid: process.pid, cwd: f.root }).assignmentId!;
    coordination.finish(assignment, 'All done.');
    const backend = await f.restartBackend();
    await backend.manager.reconcileSessions();
    expect(backend.plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'resume')).toHaveLength(0);
    expect(f.row(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    expect(f.row(session.id).idleSuspendedAt).toBeTruthy();
  });

  it('keeps the binding when releasing the thread fails', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    thread.close = async () => { throw new Error('close failed'); };
    await expect(f.manager.releaseSession(session.id)).rejects.toThrow('close failed');
    expect(f.row(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
  });
});

describe('Structured startup and connection loss', () => {
  it('reconciles structured rows at startup without launching tmux or resuming every thread', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    f.db.sqlite.prepare('update bound_sessions set is_working=1 where id=?').run(session.id);
    // A new backend over the same database: the previous connection died with the old process.
    const backend = await f.restartBackend();
    await backend.manager.reconcileSessions();
    expect(backend.plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'resume')).toHaveLength(0);
    expect(f.row(session.id)).toMatchObject({ status: 'bound', isWorking: false });
    expect(eventLogLines(f.row(session.id)).some(line => /connection ended/.test(line.text))).toBe(true);
  });

  it('loads a thread on first use after a restart', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    const backend = await f.restartBackend();
    const screen = await backend.manager.getSessionScreen(session.id);
    expect(screen?.screen.status).toBe('Codex (app-server) idle');
    expect(backend.plugin.instance!.calls.find(call => call.method === 'resume')?.args[0]).toBe(session.conversationRef);
  });

  it('marks a lost connection on the session and reconnects with a fresh instance on next use', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'long task');
    await settle();
    expect(f.row(session.id).isWorking).toBe(true);

    await f.plugin.instance!.dispose('restart'); // the app-server went away under the Console
    await expect.poll(() => f.row(session.id).isWorking).toBe(false);
    expect(f.row(session.id)).toMatchObject({ status: 'bound', shouldRestore: true });
    expect(eventLogLines(f.row(session.id)).some(line => line.type === 'status' && /connection ended/.test(line.text))).toBe(true);

    const restored = await f.manager.ensureSession(session.id);
    expect(restored?.status).toBe('bound');
    expect(f.plugin.instances).toHaveLength(2);
    expect(f.plugin.instances[1]!.calls.find(call => call.method === 'resume')?.args[0]).toBe(session.conversationRef);
  });

  it('records a status when the provider declines a request', async () => {
    const f = await fixture({ plugin: { manualTurns: true } });
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    thread.push({ type: 'request.opened', requestId: 'r1', kind: 'command', summary: 'run rm -rf' });
    await settle();
    expect(thread.calls.find(call => call.method === 'respond')?.args).toEqual(['r1', { decision: 'decline' }]);
    expect(eventLogLines(f.row(session.id)).some(line => line.type === 'status' && line.text.includes('run rm -rf'))).toBe(true);
  });
});

describe('Structured model profile', () => {
  it('switches the profile without a restart and carries it on the next turn', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    const accepted = await f.manager.requestModelProfile(session.id, 'high');
    expect(accepted.session.modelProfileRequest).toMatchObject({ profile: 'high' });
    await expect.poll(() => f.row(session.id).modelProfileRequest).toBeUndefined();
    expect(f.row(session.id).codexProfile).toBe('high');
    expect(f.calls(session.conversationRef, 'close')).toHaveLength(0);
    expect(f.plugin.instances.flatMap(instance => instance.calls).filter(call => call.method === 'start')).toHaveLength(1);

    await f.manager.sendInput(session.id, 'after the switch');
    expect(f.calls(session.conversationRef, 'sendTurn').at(-1)?.args[0]).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh' });
    expect((await f.manager.getSessionScreen(session.id))!.screen.model).toBe('gpt-6-astra xhigh');
  });

  it('defers a switch while a turn runs and completes it at the next terminal', async () => {
    const f = await fixture();
    const { session } = await f.bindNew();
    await f.manager.sendInput(session.id, 'running');
    await settle();
    await f.manager.requestModelProfile(session.id, 'low');
    await expect.poll(() => f.row(session.id).modelProfileRequest).toMatchObject({ state: 'queued', deferredReason: 'turn_running' });
    expect(f.row(session.id).codexProfile).toBe('medium');

    f.plugin.instance!.sessions[0]!.completeTurn();
    await expect.poll(() => f.row(session.id).modelProfileRequest).toBeUndefined();
    expect(f.row(session.id).codexProfile).toBe('low');
    await f.manager.sendInput(session.id, 'next');
    expect(f.calls(session.conversationRef, 'sendTurn').at(-1)?.args[0]).toMatchObject({ model: 'gpt-6-luna' });
  });
});
