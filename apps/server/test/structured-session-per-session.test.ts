import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLaunchContext } from '@agent-console/shared';
import { StructuredSessionService } from '../src/sessions/structured/structured-session-service.js';
import { TransportPluginRegistry } from '../src/providers/transport/registry.js';
import type { OpenOptions, TurnInput } from '../src/providers/transport/types.js';
import { FakeTransportPlugin, fakePluginContext, noModelTargets, type FakeTransportPluginOptions } from './helpers/structured-fixtures.js';
import { eventLogLines, settle, structuredSessionFixture, type StructuredSessionFixture } from './helpers/structured-session-fixture.js';

/** The Claude plugin's shape: one process per conversation, ids chosen by the client. */
const PER_SESSION: FakeTransportPluginOptions = {
  id: 'claude',
  capabilities: { processModel: 'per-session', nativeIds: 'client-allocated', images: true },
};

const open: StructuredSessionFixture[] = [];
function fixture(options: Parameters<typeof structuredSessionFixture>[0] = {}) {
  const f = structuredSessionFixture(options);
  open.push(f);
  return f;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const f of open.splice(0)) await f.cleanup();
});

function backdate(f: StructuredSessionFixture, sessionId: string, minutes: number) {
  const at = new Date(Date.now() - minutes * 60_000).toISOString();
  f.db.sqlite.prepare(`update bound_sessions set started_at=?, updated_at=?, last_activity_at=?, last_output_at=?, last_completed_at=?, last_response_at=?, is_working=0 where id=?`)
    .run(at, at, at, at, at, at, sessionId);
}

const launchContext: AgentLaunchContext = {
  launchedBy: 'assignment-1', launcherName: 'Lead agent', grantIds: ['grant-1'], requestId: 'request-1', supervisorId: 'assignment-1',
};

function startOptions(f: StructuredSessionFixture, index = 0): OpenOptions {
  return f.plugin.instance!.sessions[index]!.options;
}

describe('Per-session processes: what the host hands a conversation', () => {
  it('gives the conversation its own environment and coordination identity', async () => {
    const f = fixture({
      plugin: PER_SESSION,
      manager: { structuredEnv: { AGENT_COORD_RUNTIME: '/runtime', AGENT_CONSOLE_CONFIG: '/config.json' } },
    });
    const { session } = await f.bindNew();
    const options = startOptions(f);

    expect(options.conversationId).toBe(session.id);
    expect(options.env).toEqual({ AGENT_COORD_RUNTIME: '/runtime', AGENT_CONSOLE_CONFIG: '/config.json', AGENT_CONSOLE_SESSION_ID: session.id });
    expect(options.consoleIdentity).toEqual({
      sessionId: session.id, runtimeDir: f.root, helperPath: expect.stringMatching(/scripts\/agent-coord\.mjs$/),
    });
    expect(fs.existsSync(options.consoleIdentity!.helperPath)).toBe(true);
    // The identity is the one the tmux launch pins, and the resume hands over the same.
    const again = await f.manager.suspendSession(session.id).then(() => f.manager.resumeSession(session.id));
    expect(again.id).toBe(session.id);
    expect(startOptions(f, 1).env).toMatchObject({ AGENT_CONSOLE_SESSION_ID: session.id });
    expect(startOptions(f, 1).consoleIdentity).toMatchObject({ sessionId: session.id });
  });

  it('lets the configured env override the Console variables but never the session id', async () => {
    const f = fixture({
      plugin: PER_SESSION,
      manager: {
        structuredEnv: { AGENT_COORD_RUNTIME: '/runtime' },
        structuredSessions: { claude: { enabled: true, command: ['fake-claude'], idleUnloadMinutes: 60, env: { AGENT_COORD_RUNTIME: '/override', AGENT_CONSOLE_SESSION_ID: 'pinned', EXTRA: '1' } } },
      },
    });
    const { session } = await f.bindNew();
    expect(startOptions(f).env).toEqual({ AGENT_COORD_RUNTIME: '/override', AGENT_CONSOLE_SESSION_ID: session.id, EXTRA: '1' });
  });

  it('gives no coordination identity when coordination is off, but still the session id', async () => {
    const f = fixture({ plugin: PER_SESSION, manager: { coordinationEnabled: false } });
    const { session } = await f.bindNew();
    expect(startOptions(f).consoleIdentity).toBeUndefined();
    expect(startOptions(f).env).toEqual({ AGENT_CONSOLE_SESSION_ID: session.id });
  });

  it('never gives a shared process one conversation\'s identity', async () => {
    const f = fixture();
    await f.bindNew();
    const options = startOptions(f);
    expect(options.env).toBeUndefined();
    expect(options.consoleIdentity).toBeUndefined();
  });

  it('appends the grant authority text for a granted launch and rebuilds the system prompt when it resumes', async () => {
    const f = fixture({
      plugin: PER_SESSION,
      manager: { launchAuthorityContext: context => `AUTHORITY from ${context.launcherName}` },
    });
    const { session } = await f.bindNew({ launchContext });
    expect(startOptions(f).appendSystemPrompt).toBe('AUTHORITY from Lead agent');
    // A new conversation records its system prompt on the first request; only a resume must ask for a fresh one.
    expect(startOptions(f).systemPromptSnapshot).toBeUndefined();

    await f.manager.suspendSession(session.id);
    await f.manager.resumeSession(session.id);
    expect(startOptions(f, 1).appendSystemPrompt).toBe('AUTHORITY from Lead agent');
    expect(startOptions(f, 1).systemPromptSnapshot).toBe('off');
  });

  it('still rebuilds the system prompt on a resume when the grants have since been revoked, so no stale authority stays in it', async () => {
    let active = true;
    const f = fixture({
      plugin: PER_SESSION,
      manager: { launchAuthorityContext: () => (active ? 'AUTHORITY while granted' : undefined) },
    });
    const { session } = await f.bindNew({ launchContext });
    expect(startOptions(f).appendSystemPrompt).toBe('AUTHORITY while granted');

    active = false;
    await f.manager.suspendSession(session.id);
    await f.manager.resumeSession(session.id);
    expect(startOptions(f, 1).appendSystemPrompt).toBeUndefined();
    expect(startOptions(f, 1).systemPromptSnapshot).toBe('off');
  });

  it('sends no authority text to a conversation nobody granted authority', async () => {
    const f = fixture({ plugin: PER_SESSION, manager: { launchAuthorityContext: () => 'never used' } });
    const { session } = await f.bindNew();
    expect(startOptions(f).appendSystemPrompt).toBeUndefined();
    await f.manager.suspendSession(session.id);
    await f.manager.resumeSession(session.id);
    expect(startOptions(f, 1).appendSystemPrompt).toBeUndefined();
    expect(startOptions(f, 1).systemPromptSnapshot).toBeUndefined();
  });

  it('records the process of this conversation, not of the instance, as the row pid', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const first = await f.bindNew();
    const second = await f.bindNew();
    const [a, b] = f.plugin.instance!.sessions;

    expect(a!.pid).toBeDefined();
    expect(b!.pid).toBeDefined();
    expect(a!.pid).not.toBe(b!.pid);
    expect(f.row(first.session.id).pid).toBe(a!.pid);
    expect(f.row(second.session.id).pid).toBe(b!.pid);
    // One instance serves both conversations; each has its own transport session and none is shared.
    expect(f.plugin.instances).toHaveLength(1);
    expect(a).not.toBe(b);
  });

  it('refuses to open a second process for a conversation that has one', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const { session } = await f.bindNew();
    const registry = new TransportPluginRegistry();
    registry.register(new FakeTransportPlugin(PER_SESSION));
    const service = new StructuredSessionService({
      targets: noModelTargets,
      registry, config: { claude: { enabled: true, command: ['x'], idleUnloadMinutes: 60, env: {} } },
      createContext: () => fakePluginContext(), meta: fakePluginContext().meta,
      callbacks: {
        onTurnStarted() {}, onItemCompleted() {}, onTurnTerminal() {}, onRequest() {}, onQuestion() {},
        onRequestsChanged() {}, onSessionState() {}, appendStatus() {},
      },
    });
    await service.start({ sessionId: session.id, provider: 'claude', cwd: f.root });
    await expect(service.start({ sessionId: session.id, provider: 'claude', cwd: f.root })).rejects.toThrow(/already has a running provider process/);
    await service.shutdown();
  });
});

describe('Per-session processes: sleep, pressure, release', () => {
  it('ends the process on idle sleep without reading the stop as a lost connection, then resumes it by native id', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const { session } = await f.bindNew();
    const first = f.plugin.instance!.sessions[0]!;
    backdate(f, session.id, 120);
    await f.manager.reconcileSessions();
    await settle();

    expect(first.calls.map(call => call.method)).toEqual(expect.arrayContaining(['unload']));
    expect(first.closed).toBe(true);
    const asleep = f.row(session.id);
    expect(asleep).toMatchObject({ status: 'bound', pid: undefined, isWorking: false });
    expect(asleep.idleSuspendedAt).toBeTruthy();
    // The stopped state that follows an idle unload is a normal end: no error row, no connection-loss line.
    expect(eventLogLines(asleep).some(line => /connection ended/i.test(line.text))).toBe(false);
    expect(f.events.some(event => event.type === 'session.updated' && event.session.id === session.id && event.session.status === 'error')).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 5));
    const restored = await f.manager.sendInput(session.id, 'wake up');
    expect(restored.session.idleSuspendedAt).toBeUndefined();
    const resumes = f.plugin.instance!.calls.filter(call => call.method === 'resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.args[0]).toBe(session.conversationRef);
    const second = f.plugin.instance!.sessions[1]!;
    expect(second).not.toBe(first);
    expect(f.row(session.id).pid).toBe(second.pid);
  });

  it('ends the process on a manual suspend and starts a new one on resume', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const { session } = await f.bindNew();
    const first = f.plugin.instance!.sessions[0]!;
    const suspended = await f.manager.suspendSession(session.id);
    expect(suspended.manualSuspendedAt).toBeTruthy();
    expect(first.closed).toBe(true);
    expect(f.row(session.id).status).toBe('bound');
    await f.manager.resumeSession(session.id);
    expect(f.plugin.instance!.sessions).toHaveLength(2);
    expect(f.plugin.instance!.sessions[1]!.resumed).toBe(true);
  });

  it('ends an idle conversation\'s process under memory pressure, once, and leaves it asleep until the person comes back', async () => {
    const f = fixture({
      plugin: PER_SESSION,
      manager: { pressureSuspendAvailableBytes: 8 * 1024 ** 3, pressureSuspendIdleMs: 1, readMemInfo: () => 'MemAvailable:      1048576 kB\n' },
    });
    const { session } = await f.bindNew();
    const first = f.plugin.instance!.sessions[0]!;
    backdate(f, session.id, 5);
    await f.manager.reconcileSessions(); // the first low sample only counts
    expect(f.row(session.id).pressureSuspendedAt).toBeUndefined();
    await f.manager.reconcileSessions();
    await settle();

    const row = f.row(session.id);
    expect(row.pressureSuspendedAt).toBeTruthy();
    expect(row).toMatchObject({ status: 'bound', pid: undefined });
    expect(first.closed).toBe(true);
    expect(first.calls.filter(call => call.method === 'unload')).toHaveLength(1);
    expect(eventLogLines(row).some(line => /available memory was low/i.test(line.text))).toBe(true);
    expect(eventLogLines(row).some(line => /connection ended/i.test(line.text))).toBe(false);

    // Reconciling again neither resumes it nor suspends it twice.
    await f.manager.reconcileSessions();
    expect(f.plugin.instance!.sessions).toHaveLength(1);

    const resumed = await f.manager.resumeSession(session.id);
    expect(resumed.pressureSuspendedAt).toBeUndefined();
    expect(f.plugin.instance!.sessions).toHaveLength(2);
  });

  it('leaves a running turn and a queued message alone under memory pressure', async () => {
    const f = fixture({
      plugin: { ...PER_SESSION, manualTurns: true },
      manager: { pressureSuspendAvailableBytes: 8 * 1024 ** 3, pressureSuspendIdleMs: 1, readMemInfo: () => 'MemAvailable:      1048576 kB\n' },
    });
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    thread.push({ type: 'turn.started', turnId: 't1', origin: 'user', replay: false });
    await settle();
    backdate(f, session.id, 5);
    f.db.sqlite.prepare('update bound_sessions set is_working=1 where id=?').run(session.id);
    await f.manager.reconcileSessions();
    await f.manager.reconcileSessions();
    expect(f.row(session.id).pressureSuspendedAt).toBeUndefined();
    expect(thread.closed).toBe(false);
  });

  it('still leaves a shared process alone under memory pressure', async () => {
    const f = fixture({ manager: { pressureSuspendAvailableBytes: 8 * 1024 ** 3, pressureSuspendIdleMs: 1, readMemInfo: () => 'MemAvailable:      1048576 kB\n' } });
    const { session } = await f.bindNew();
    backdate(f, session.id, 5);
    await f.manager.reconcileSessions();
    await f.manager.reconcileSessions();
    expect(f.row(session.id).pressureSuspendedAt).toBeUndefined();
    expect(f.calls(session.conversationRef, 'unload')).toHaveLength(0);
  });

  it('ends the process with the release itself and does not unload it first', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    await f.manager.releaseSession(session.id);

    expect(thread.calls.map(call => call.method)).toEqual(['close']);
    expect(thread.calls[0]!.args[0]).toBe('release');
    expect(thread.closed).toBe(true);
    expect(f.row(session.id)).toMatchObject({ status: 'ended', shouldRestore: false });
    expect(f.db.meta.get(`structured-epoch:${session.id}`)).toBeUndefined();
  });

  it('reads a process that ended on its own as a lost connection, which an idle unload never does', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const { session } = await f.bindNew();
    f.plugin.instance!.sessions[0]!.stop();
    await settle();

    const row = f.row(session.id);
    expect(eventLogLines(row).some(line => /connection ended/i.test(line.text))).toBe(true);
    // Nothing runs it any more, so the next use resumes it by native id.
    const restored = await f.manager.sendInput(session.id, 'are you there');
    expect(restored.session.status).toBe('bound');
    expect(f.plugin.instance!.sessions).toHaveLength(2);
    // One conversation ending leaves the instance alone: it only starts processes, it holds no shared connection.
    expect(f.plugin.instances).toHaveLength(1);
    expect(f.plugin.instance!.disposed).toBe(false);
  });
});

describe('Per-session processes: a row with no cost profile', () => {
  // What the tmux resume template runs: effort medium, and no model of its own. No profile is stored on the row.
  const TEMPLATE = { effort: 'medium' };

  it('starts a history-bound conversation on the template effort, names it on every turn and stores no profile', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const session = await f.bindHistory('native-history-1');

    expect(f.row(session.id).claudeProfile).toBeUndefined();
    expect(startOptions(f)).toMatchObject(TEMPLATE);
    expect(startOptions(f).model).toBeUndefined();
    await f.manager.sendInput(session.id, 'hello');
    const sent = f.calls('native-history-1', 'sendTurn').map(call => call.args[0] as TurnInput);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject(TEMPLATE);
    expect(sent[0]!.model).toBeUndefined();
    // The row never carries a profile the person did not choose.
    expect(f.events.some(event => event.type === 'session.updated' && event.session.id === session.id && event.session.claudeProfile !== undefined)).toBe(false);
    expect(f.row(session.id).claudeProfile).toBeUndefined();
  });

  it('gives a migrated row with no profile the template effort when it wakes, and still stores nothing', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const { session } = await f.bindNew();
    f.db.sqlite.prepare('update bound_sessions set claude_profile=null where id=?').run(session.id);
    expect(f.row(session.id).claudeProfile).toBeUndefined();

    await f.manager.suspendSession(session.id);
    await f.manager.resumeSession(session.id);
    expect(startOptions(f, 1)).toMatchObject(TEMPLATE);
    expect(startOptions(f, 1).model).toBeUndefined();
    expect(f.row(session.id).claudeProfile).toBeUndefined();
    await f.manager.sendInput(session.id, 'hello');
    const turn = f.calls(session.conversationRef, 'sendTurn').map(call => call.args[0] as TurnInput)[0]!;
    expect(turn).toMatchObject(TEMPLATE);
    expect(turn.model).toBeUndefined();
  });

  it('leaves a row that has a profile on it, and a granted launch on the model it named', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const low = await f.bindNew({ claudeProfile: 'low' });
    expect(startOptions(f, 0)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(f.row(low.session.id).claudeProfile).toBe('low');

    const granted = await f.bindNew({ launchContext: { ...launchContext, model: 'claude-custom', effort: 'low' } });
    expect(startOptions(f, 1)).toMatchObject({ model: 'claude-custom', effort: 'low' });
    expect(f.row(granted.session.id).claudeProfile).toBeUndefined();
    await f.manager.suspendSession(granted.session.id);
    await f.manager.resumeSession(granted.session.id);
    expect(startOptions(f, 2)).toMatchObject({ model: 'claude-custom', effort: 'low' });
    expect(f.row(granted.session.id).claudeProfile).toBeUndefined();
  });

  it('uses the profile the person picks from then on', async () => {
    const f = fixture({ plugin: PER_SESSION });
    const session = await f.bindHistory('native-history-2');
    expect(f.row(session.id).claudeProfile).toBeUndefined();
    await f.manager.requestModelProfile(session.id, 'low');
    // The switch reads the model catalog (a subprocess): wait for it rather than for a fixed delay, which a loaded host can outlast.
    await expect.poll(() => f.row(session.id).claudeProfile, { timeout: 5000, interval: 20 }).toBe('low');
    await f.manager.sendInput(session.id, 'hello');
    expect(f.row(session.id).claudeProfile).toBe('low');
    expect(f.calls('native-history-2', 'sendTurn').map(call => call.args[0] as TurnInput)[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
  });

  it('gives a shared Codex thread no default: its process keeps the model it was configured with', async () => {
    const f = fixture();
    const session = await f.bindHistory('native-history-3');
    expect(startOptions(f).model).toBeUndefined();
    expect(startOptions(f).effort).toBeUndefined();
    expect(f.row(session.id).codexProfile).toBeUndefined();
    await f.manager.sendInput(session.id, 'hello');
    const sent = f.calls('native-history-3', 'sendTurn').map(call => call.args[0] as TurnInput)[0]!;
    expect(sent.model).toBeUndefined();
    expect(sent.effort).toBeUndefined();
  });
});

describe('Per-session processes: background work', () => {
  const PRESSURE = { pressureSuspendAvailableBytes: 8 * 1024 ** 3, pressureSuspendIdleMs: 1, readMemInfo: () => 'MemAvailable:      1048576 kB\n' };
  const HOUR = 3_600_000;

  async function backgroundSession(manager: Parameters<typeof structuredSessionFixture>[0] = {}) {
    const f = fixture({ plugin: PER_SESSION, ...manager });
    const { session } = await f.bindNew();
    const thread = f.plugin.instance!.sessions[0]!;
    thread.backgroundWork = true;
    return { f, session, thread };
  }

  it('leaves an idle process alone while it runs background work and sleeps it once that ends', async () => {
    const { f, session, thread } = await backgroundSession();
    backdate(f, session.id, 120);
    await f.manager.reconcileSessions();
    await f.manager.reconcileSessions();
    await settle();
    expect(thread.closed).toBe(false);
    expect(thread.calls.map(call => call.method)).not.toContain('unload');
    expect(f.row(session.id).idleSuspendedAt).toBeUndefined();
    expect(eventLogLines(f.row(session.id)).some(line => /suspended/i.test(line.text))).toBe(false);

    thread.backgroundWork = false;
    await f.manager.reconcileSessions();
    await settle();
    expect(thread.closed).toBe(true);
    expect(f.row(session.id).idleSuspendedAt).toBeTruthy();
  });

  it('leaves it alone under memory pressure too, until the work ends', async () => {
    const { f, session, thread } = await backgroundSession({ manager: PRESSURE });
    backdate(f, session.id, 5);
    await f.manager.reconcileSessions(); // the first low sample only counts
    await f.manager.reconcileSessions();
    await f.manager.reconcileSessions();
    await settle();
    expect(f.row(session.id).pressureSuspendedAt).toBeUndefined();
    expect(thread.closed).toBe(false);

    thread.backgroundWork = false;
    await f.manager.reconcileSessions();
    await settle();
    expect(f.row(session.id).pressureSuspendedAt).toBeTruthy();
    expect(thread.closed).toBe(true);
  });

  it('refuses a manual suspend and says why', async () => {
    const { f, session, thread } = await backgroundSession();
    await expect(f.manager.suspendSession(session.id)).rejects.toThrow(/background work/i);
    expect(thread.closed).toBe(false);
    expect(f.row(session.id).manualSuspendedAt).toBeUndefined();
    thread.backgroundWork = false;
    expect((await f.manager.suspendSession(session.id)).manualSuspendedAt).toBeTruthy();
    expect(thread.closed).toBe(true);
  });

  it('stops honoring the flag after four hours without a single event from the process', async () => {
    const { f, session, thread } = await backgroundSession();
    backdate(f, session.id, 120);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * HOUR);
    await f.manager.reconcileSessions();
    await settle();
    expect(thread.closed).toBe(false); // three hours of silence is still inside the bound

    vi.setSystemTime(Date.now() + 2 * HOUR); // five hours in all
    await f.manager.reconcileSessions();
    await settle();
    expect(thread.closed).toBe(true);
    expect(thread.backgroundWork).toBe(true); // the flag was never cleared; it was no longer believed
    expect(f.row(session.id).idleSuspendedAt).toBeTruthy();
  });

  it('counts any event from the process as proof of life, so the bound restarts', async () => {
    const { f, session, thread } = await backgroundSession();
    backdate(f, session.id, 120);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * HOUR);
    thread.push({ type: 'notice', level: 'info', text: 'still here' });
    await settle();
    vi.setSystemTime(Date.now() + 2 * HOUR); // five hours since the start, two since the last event
    await f.manager.reconcileSessions();
    await settle();
    expect(thread.closed).toBe(false);

    vi.setSystemTime(Date.now() + 3 * HOUR); // five hours since the last event
    await f.manager.reconcileSessions();
    await settle();
    expect(thread.closed).toBe(true);
  });

  it('reads as no background work when the session is not loaded or its plugin cannot tell', async () => {
    const { f, session, thread } = await backgroundSession();
    const service = (f.manager as unknown as { structured: { hasBackgroundWork(session: { id: string }): boolean } }).structured;
    expect(service.hasBackgroundWork({ id: session.id })).toBe(true);
    expect(service.hasBackgroundWork({ id: 'no-such-session' })).toBe(false);
    (thread as { hasBackgroundWork?: unknown }).hasBackgroundWork = undefined;
    expect(service.hasBackgroundWork({ id: session.id })).toBe(false);
    await f.manager.releaseSession(session.id);
    expect(service.hasBackgroundWork({ id: session.id })).toBe(false);
  });
});
