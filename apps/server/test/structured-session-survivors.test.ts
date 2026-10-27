import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredSessionService } from '../src/sessions/structured/structured-session-service.js';
import { TransportPluginRegistry } from '../src/providers/transport/registry.js';
import { FakeTransportInstance, FakeTransportPlugin, fakePluginContext, type FakeTransportPluginOptions } from './helpers/structured-fixtures.js';
import { eventLogLines, failReattach, recordHistoryNotes, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

// A per-session provider process (one Claude CLI per conversation) can outlive a backend restart behind its session host.
// Nothing owns it until its conversation is used, so the first reconcile pass asks the plugin to adopt it. These tests drive
// the real SessionManager with the fake plugin; `restartBackend({ survivors })` names the processes that outlived the old one.

const PER_SESSION: FakeTransportPluginOptions = {
  id: 'claude',
  capabilities: { processModel: 'per-session', nativeIds: 'client-allocated', images: true },
};

const RECONNECTED = /Reconnected to the running agent process/;

const open: StructuredSessionFixture[] = [];
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  return f;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of open.splice(0)) await f.cleanup();
});

function backdate(f: StructuredSessionFixture, sessionId: string, minutes: number) {
  const at = new Date(Date.now() - minutes * 60_000).toISOString();
  f.db.sqlite.prepare(`update bound_sessions set started_at=?, updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, is_working=0 where id=?`)
    .run(at, at, at, at, at, at, sessionId);
}

const methods = (instance: FakeTransportInstance | undefined) => (instance?.calls ?? []).map(call => call.method);
/** The adopted session of a conversation (the pass adopts rows in database order, not in the order a test made them). */
const adoptedFor = (backend: { plugin: FakeTransportPlugin }, nativeSessionId: string) =>
  backend.plugin.instance!.sessions.find(thread => thread.nativeSessionId === nativeSessionId)!;

describe('Survivors after a backend restart: a per-session process', () => {
  it('is reattached at the first reconcile pass, owned like any loaded session, and then sleeps at idle', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    const pid = f.thread(native).pid!;

    const backend = await f.restartBackend({ survivors: { [native]: pid } });
    await backend.manager.reconcileSessions();
    await settle();

    const instance = backend.plugin.instance!;
    // The plugin was asked to adopt it; nothing was started or resumed.
    expect(methods(instance)).toEqual(['reattach']);
    expect(instance.calls[0]!.args[0]).toBe(native);
    expect(instance.calls[0]!.args[1]).toMatchObject({ conversationId: session.id, env: { AGENT_CONSOLE_SESSION_ID: session.id } });
    const survivor = instance.sessions[0]!;
    expect(survivor).toMatchObject({ reattached: true, pid, closed: false });
    expect(f.row(session.id)).toMatchObject({ status: 'bound', pid });
    expect(f.db.meta.get(`structured-epoch:${session.id}`)).toBeTruthy();
    const lines = eventLogLines(f.row(session.id)).filter(line => RECONNECTED.test(line.text));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.type).toBe('status');
    // No connection-loss line, no tmux.
    expect(eventLogLines(f.row(session.id)).some(line => /connection ended/i.test(line.text))).toBe(false);
    expect(backend.tmux.created).toHaveLength(0);

    // Later passes do not look again.
    await backend.manager.reconcileSessions();
    expect(methods(instance)).toEqual(['reattach']);

    // Idle sleep now ends it, which it could not before: an unloaded row only got a marker.
    backdate(f, session.id, 120);
    await backend.manager.reconcileSessions();
    await settle();
    expect(survivor.calls.map(call => call.method)).toEqual(expect.arrayContaining(['unload']));
    expect(survivor.closed).toBe(true);
    const asleep = f.row(session.id);
    expect(asleep.idleSuspendedAt).toBeTruthy();
    expect(asleep).toMatchObject({ status: 'bound', pid: undefined });
    expect(eventLogLines(asleep).some(line => /connection ended/i.test(line.text))).toBe(false);

    // The next message resumes it by native id, as for any slept conversation.
    await new Promise(resolve => setTimeout(resolve, 5));
    await backend.manager.sendInput(session.id, 'wake up');
    expect(methods(instance)).toEqual(['reattach', 'resume']);
    expect(instance.calls[1]!.args[0]).toBe(native);
    expect(instance.sessions[1]!.reattached).toBe(false);
  });

  it('is ended by memory pressure, and by a release, like a process this backend started', async () => {
    const f = fixture({
      plugin: PER_SESSION,
      manager: { pressureSuspendAvailableBytes: 8 * 1024 ** 3, pressureSuspendIdleMs: 1, readMemInfo: () => 'MemAvailable:      1048576 kB\n' },
    });
    const first = await f.bindNew();
    const second = await f.bindNew();
    const survivors = Object.fromEntries([first, second].map(({ session }) => [session.conversationRef, f.thread(session.conversationRef).pid!]));
    const backend = await f.restartBackend({ survivors });
    await backend.manager.reconcileSessions();
    await settle();
    const a = adoptedFor(backend, first.session.conversationRef);
    const b = adoptedFor(backend, second.session.conversationRef);
    expect(a.reattached && b.reattached).toBe(true);

    // The reattach pass was the first low sample; this one confirms it. Pressure ends the conversation idle longest and
    // only that one; the other is left for the next pass.
    backdate(f, first.session.id, 10);
    backdate(f, second.session.id, 5);
    await backend.manager.reconcileSessions();
    await settle();
    expect(f.row(first.session.id).pressureSuspendedAt).toBeTruthy();
    expect(a.closed).toBe(true);
    expect(a.calls.filter(call => call.method === 'unload')).toHaveLength(1);
    expect(f.row(second.session.id).pressureSuspendedAt).toBeUndefined();
    expect(b.closed).toBe(false);

    await backend.manager.releaseSession(second.session.id);
    expect(b.closed).toBe(true);
    expect(b.calls.map(call => call.method)).toEqual(['close']);
    expect(f.row(second.session.id)).toMatchObject({ status: 'ended', shouldRestore: false });
  });

  it('stays out of the way of a running turn: the adopted session reports the turn the process starts', async () => {
    const f = fixture({ plugin: { ...PER_SESSION, manualTurns: true } });
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    const backend = await f.restartBackend({ survivors: { [native]: f.thread(native).pid! } });
    await backend.manager.reconcileSessions();
    await settle();
    const survivor = backend.plugin.instance!.sessions[0]!;

    survivor.push({ type: 'turn.started', turnId: 'provider-turn', origin: 'provider', replay: false });
    await settle();
    expect(f.row(session.id).isWorking).toBe(true);
    backdate(f, session.id, 120); // long idle by every timestamp, and the row no longer says working
    await backend.manager.reconcileSessions();
    await settle();
    expect(survivor.closed).toBe(false); // the adopted session knows the turn is running, so idle sleep leaves it alone
    expect(f.row(session.id).idleSuspendedAt).toBeUndefined();
    survivor.completeTurn();
    await settle();
    expect(f.row(session.id).isWorking).toBe(false);
  });

  it('clears a working flag the process never explains, after the idle window, but keeps it while a turn is reported', async () => {
    const f = fixture({ plugin: { ...PER_SESSION, manualTurns: true } });
    const quiet = await f.bindNew();
    const busy = await f.bindNew();
    const survivors = Object.fromEntries([quiet, busy].map(({ session }) => [session.conversationRef, f.thread(session.conversationRef).pid!]));
    // Both rows say a turn was running when the old backend went away.
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    f.db.sqlite.prepare('update bound_sessions set is_working=1, last_output_at=?, last_activity_at=? where id in (?, ?)').run(stale, stale, quiet.session.id, busy.session.id);
    const backend = await f.restartBackend({ survivors });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await backend.manager.reconcileSessions();
    await settle();
    expect(f.row(quiet.session.id).isWorking).toBe(true); // not judged at the instant of reconnecting
    adoptedFor(backend, busy.session.conversationRef).push({ type: 'turn.started', turnId: 'still-running', origin: 'provider', replay: false });
    await settle();

    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    expect(adoptedFor(backend, quiet.session.conversationRef).reattached).toBe(true);
    expect(f.row(quiet.session.id).isWorking).toBe(false);
    expect(f.row(busy.session.id).isWorking).toBe(true);
  });

  it('is not looked for on a suspended row or one that is not established', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const manual = await f.bindNew();
    const idle = await f.bindNew();
    const pressure = await f.bindNew();
    const starting = await f.bindNew();
    const survivors = Object.fromEntries([manual, idle, pressure, starting].map(({ session }) => [session.conversationRef, f.thread(session.conversationRef).pid!]));
    const mark = (column: string, id: string) => f.db.sqlite.prepare(`update bound_sessions set ${column}=? where id=?`).run(new Date().toISOString(), id);
    mark('manual_suspended_at', manual.session.id);
    mark('idle_suspended_at', idle.session.id);
    mark('pressure_suspended_at', pressure.session.id);
    f.db.sqlite.prepare("update bound_sessions set status='starting' where id=?").run(starting.session.id);

    const backend = await f.restartBackend({ survivors });
    await backend.manager.reconcileSessions();
    await settle();
    // Nobody was asked to adopt anything. Only the half-started row is brought back, and by a resume, not a reattach.
    expect(methods(backend.plugin.instance)).not.toContain('reattach');
    expect(backend.plugin.instance!.sessions.map(thread => [thread.nativeSessionId, thread.reattached]))
      .toEqual([[starting.session.conversationRef, false]]);
    for (const { session } of [manual, idle, pressure]) {
      expect(eventLogLines(f.row(session.id)).some(line => RECONNECTED.test(line.text))).toBe(false);
    }
  });

  it('is left unloaded when the plugin finds nothing, and resumes on the next use', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    const backend = await f.restartBackend(); // nothing survived
    await backend.manager.reconcileSessions();
    await settle();

    const instance = backend.plugin.instance!;
    expect(methods(instance)).toEqual(['reattach']); // asked; nothing started
    expect(instance.sessions).toHaveLength(0);
    expect(eventLogLines(f.row(session.id)).some(line => RECONNECTED.test(line.text))).toBe(false);

    await backend.manager.sendInput(session.id, 'hello again');
    expect(methods(instance)).toEqual(['reattach', 'resume']);
    expect(instance.calls[1]!.args[0]).toBe(native);
    expect(instance.sessions).toHaveLength(1);
    expect(instance.sessions[0]!.reattached).toBe(false);
    expect(f.row(session.id)).toMatchObject({ status: 'bound', pid: instance.sessions[0]!.pid });
  });

  it('leaves the row unloaded when the plugin refuses the survivor, and goes on with the other rows', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const held = await f.bindNew();
    const fine = await f.bindNew();
    const survivors = Object.fromEntries([held, fine].map(({ session }) => [session.conversationRef, f.thread(session.conversationRef).pid!]));
    const backend = await f.restartBackend({ survivors });
    const real = FakeTransportInstance.prototype.reattach;
    const spy = vi.spyOn(FakeTransportInstance.prototype, 'reattach').mockImplementation(async function (this: FakeTransportInstance, native, options) {
      if (native === held.session.conversationRef) throw new Error('another process holds this session');
      return real.call(this, native, options);
    });
    await backend.manager.reconcileSessions();
    await settle();

    const sessions = backend.plugin.instance!.sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nativeSessionId).toBe(fine.session.conversationRef);
    expect(eventLogLines(f.row(held.session.id)).some(line => RECONNECTED.test(line.text))).toBe(false);
    expect(eventLogLines(f.row(fine.session.id)).some(line => RECONNECTED.test(line.text))).toBe(true);
    // Each row was asked once, and later passes do not ask again.
    await backend.manager.reconcileSessions();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('Survivors after a backend restart: a shared process', () => {
  it('is untouched: the one process reconnects on first use and the plugin is never asked to reattach', async () => {
    const f = fixture(); // the Codex-like shared app-server
    const { session } = await f.bindNew();
    const native = session.conversationRef;
    const backend = await f.restartBackend({ survivors: { [native]: 4242 } });
    await backend.manager.reconcileSessions();
    await settle();

    expect(methods(backend.plugin.instance)).toEqual([]);
    expect(backend.plugin.instance?.sessions ?? []).toHaveLength(0);
    expect(eventLogLines(f.row(session.id)).some(line => RECONNECTED.test(line.text))).toBe(false);
    // Still resumes on first use, as before.
    await backend.manager.sendInput(session.id, 'hello');
    expect(methods(backend.plugin.instance)).toEqual(['resume']);
  });
});

describe('StructuredSessionService.reattachSurvivors', () => {
  function service(plugin: FakeTransportPlugin, statuses: string[] = []) {
    const registry = new TransportPluginRegistry();
    registry.register(plugin);
    const context = fakePluginContext();
    return new StructuredSessionService({
      registry,
      config: { claude: { enabled: true, command: ['x'], idleUnloadMinutes: 60, env: {} } },
      createContext: () => context,
      meta: context.meta,
      callbacks: {
        onTurnStarted() {}, onItemCompleted() {}, onTurnTerminal() {}, onRequest() {}, onQuestion() {},
        onRequestsChanged() {}, onSessionState() {}, appendStatus: (_id, text) => { statuses.push(text); },
      },
    });
  }

  const row = (id: string, native: string) => ({
    id, provider: 'claude', conversationRef: native, projectSlug: 'p',
  }) as never;

  it('registers an adopted process as loaded with its epoch and pid, and refuses a second open beside it', async () => {
    const plugin = new FakeTransportPlugin({ ...PER_SESSION, survivors: { 'native-1': 4321 } });
    const statuses: string[] = [];
    const svc = service(plugin, statuses);
    const adopted = await svc.reattachSurvivors([{ session: row('c1', 'native-1'), cwd: '/tmp' }]);

    expect(adopted).toEqual(['c1']);
    expect(svc.alive({ id: 'c1' })).toBe(true);
    expect(svc.loadedPid('c1')).toBe(4321);
    expect(svc.epoch('c1')).toBeTruthy();
    expect(statuses).toEqual(['Reconnected to the running agent process']);
    await expect(svc.start({ sessionId: 'c1', provider: 'claude', cwd: '/tmp' })).rejects.toThrow(/already has a running provider process/);
    await svc.shutdown();
  });

  it('answers a use of the conversation only after the survivor lookup, so a resume never starts a second process', async () => {
    const plugin = new FakeTransportPlugin({ ...PER_SESSION, survivors: { 'native-1': 4321 } });
    const svc = service(plugin);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const instance = (svc as unknown as { instanceFor(provider: string): FakeTransportInstance }).instanceFor('claude');
    const real = instance.reattach.bind(instance);
    instance.reattach = async (native, options) => { await gate; return real(native, options); };

    const lookup = svc.reattachSurvivors([{ session: row('c1', 'native-1'), cwd: '/tmp' }]);
    await settle();
    const use = svc.ensureLoaded(row('c1', 'native-1'), '/tmp');
    await settle();
    expect(instance.calls.map(call => call.method)).not.toContain('resume'); // the use is waiting for the answer
    release();
    expect(await use).toBe('loaded');
    expect(await lookup).toEqual(['c1']);
    expect(instance.calls.map(call => call.method)).toEqual(['reattach']); // no resume
    expect(instance.sessions).toHaveLength(1);
    await svc.shutdown();
  });

  it('reports a session host that runs but did not answer as busy, which is not the same as absent, and forgets it once the process answers', async () => {
    const plugin = new FakeTransportPlugin({ ...PER_SESSION, survivors: { 'native-1': 4321 } });
    failReattach('unreachable', 1);
    const svc = service(plugin);
    expect(await svc.reattachSurvivors([{ session: row('c1', 'native-1'), cwd: '/tmp' }])).toEqual([]);
    expect(svc.survivorBusy('c1')).toBe(true);
    expect(svc.alive({ id: 'c1' })).toBe(false);

    expect(await svc.reattachSurvivors([{ session: row('c1', 'native-1'), cwd: '/tmp' }])).toEqual(['c1']);
    expect(svc.survivorBusy('c1')).toBe(false);
    expect(svc.alive({ id: 'c1' })).toBe(true);
    await svc.shutdown();

    const none = service(new FakeTransportPlugin({ ...PER_SESSION }));
    expect(await none.reattachSurvivors([{ session: row('c2', 'native-9'), cwd: '/tmp' }])).toEqual([]);
    expect(none.survivorBusy('c2')).toBe(false); // nothing runs for it
    await none.shutdown();
  });

  it('does not report a lookup that failed after the process was reached as busy: that is a loss with a reason, not a wait', async () => {
    const plugin = new FakeTransportPlugin({ ...PER_SESSION, survivors: { 'native-1': 4321, 'native-2': 4322 } });
    const svc = service(plugin);
    failReattach('refused', 1);
    expect(await svc.reattachSurvivors([{ session: row('c1', 'native-1'), cwd: '/tmp' }])).toEqual([]);
    expect(svc.survivorBusy('c1')).toBe(false);

    // The same row that was busy is no longer so once a lookup fails another way.
    failReattach('unreachable', 1);
    expect(await svc.reattachSurvivors([{ session: row('c2', 'native-2'), cwd: '/tmp' }])).toEqual([]);
    expect(svc.survivorBusy('c2')).toBe(true);
    failReattach('refused', 1);
    expect(await svc.reattachSurvivors([{ session: row('c2', 'native-2'), cwd: '/tmp' }])).toEqual([]);
    expect(svc.survivorBusy('c2')).toBe(false);
    await svc.shutdown();
  });

  it('keeps the record of completed turns through a sleep and ends it with the conversation', async () => {
    const registry = new TransportPluginRegistry();
    registry.register(new FakeTransportPlugin({ ...PER_SESSION }));
    const context = fakePluginContext();
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turns-record-'));
    const svc = new StructuredSessionService({
      registry,
      config: { claude: { enabled: true, command: ['x'], idleUnloadMinutes: 60, env: {} } },
      createContext: () => context,
      meta: context.meta,
      callbacks: { onTurnStarted() {}, onItemCompleted() {}, onTurnTerminal() {}, onRequest() {}, onQuestion() {}, onRequestsChanged() {}, onSessionState() {}, appendStatus() {} },
      hosts: { runtimeDir, log: { info() {}, warn() {} } },
    });
    context.meta.set('claude-turns:c1', JSON.stringify({ sessionId: 'native-1' }));
    context.meta.set('claude-launch:c1', JSON.stringify({ sessionId: 'native-1', argv: ['claude'] }));

    await svc.unload({ id: 'c1', provider: 'claude' }); // a sleep: the process and its launch record go, the record of turns stays
    expect(context.metaValues.has('claude-launch:c1')).toBe(false);
    expect(context.metaValues.has('claude-turns:c1')).toBe(true);

    await svc.release({ id: 'c1', provider: 'claude' }); // the conversation is over
    expect(context.metaValues.has('claude-turns:c1')).toBe(false);
    await svc.shutdown();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('skips a conversation that is loaded already, one without a native id yet, and a plugin without reattach', async () => {
    const plugin = new FakeTransportPlugin({ ...PER_SESSION, survivors: { 'native-1': 1, 'native-2': 2 } });
    const svc = service(plugin);
    await svc.resume(row('c1', 'native-1'), '/tmp');
    const adopted = await svc.reattachSurvivors([
      { session: row('c1', 'native-1'), cwd: '/tmp' },
      { session: row('c2', 'pending:abc'), cwd: '/tmp' },
    ]);
    expect(adopted).toEqual([]);
    expect(plugin.instance!.calls.map(call => call.method)).toEqual(['resume']);
    await svc.shutdown();

    const bare = new FakeTransportPlugin({ ...PER_SESSION, survivors: { 'native-2': 2 } });
    const bareService = service(bare);
    const instance = (bareService as unknown as { instanceFor(provider: string): { reattach?: unknown } }).instanceFor('claude');
    instance.reattach = undefined; // a plugin that cannot adopt survivors
    expect(await bareService.reattachSurvivors([{ session: row('c3', 'native-2'), cwd: '/tmp' }])).toEqual([]);
    await bareService.shutdown();
  });
});

describe('StructuredSessionService.noteConversationHistory', () => {
  function service(plugin: FakeTransportPlugin) {
    const registry = new TransportPluginRegistry();
    registry.register(plugin);
    const context = fakePluginContext();
    return new StructuredSessionService({
      registry,
      config: { claude: { enabled: true, command: ['x'], idleUnloadMinutes: 60, env: {} } },
      createContext: () => context,
      meta: context.meta,
      callbacks: { onTurnStarted() {}, onItemCompleted() {}, onTurnTerminal() {}, onRequest() {}, onQuestion() {}, onRequestsChanged() {}, onSessionState() {}, appendStatus() {} },
    });
  }
  const row = (id: string, conversationRef: string, resumeConversationRef?: string) =>
    ({ id, provider: 'claude', conversationRef, ...(resumeConversationRef ? { resumeConversationRef } : {}), projectSlug: 'p' }) as never;

  it('hands the plugin the row id and the native id the row resumes by, and skips a conversation with no native id yet', async () => {
    const history = recordHistoryNotes();
    try {
      const svc = service(new FakeTransportPlugin({ ...PER_SESSION }));
      svc.noteConversationHistory(row('c1', 'old-native', 'resume-native'));
      svc.noteConversationHistory(row('c2', 'native-2'));
      svc.noteConversationHistory(row('c3', 'pending:abc'));
      expect(history.notes).toEqual([
        { conversationId: 'c1', nativeSessionId: 'resume-native' },
        { conversationId: 'c2', nativeSessionId: 'native-2' },
      ]);
      await svc.shutdown();
    } finally {
      history.restore();
    }
  });

  it('is ignored by a plugin that has no such guard', async () => {
    const svc = service(new FakeTransportPlugin({ ...PER_SESSION }));
    expect(() => svc.noteConversationHistory(row('c1', 'native-1'))).not.toThrow();
    await svc.shutdown();
  });
});
