import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createVibePlugin, buildVibeEnv, buildMcpServers, hostIdFor, VIBE_RATE_LIMIT_NOTICE } from '../src/providers/transport/vibe/index.js';
import { VibeInstance } from '../src/providers/transport/vibe/vibe-instance.js';
import { createLineTransportFactory, terminateHost } from '../src/providers/transport/line-transport.js';
import { NotSentError, ResumeFailedError, SendRejectedError, type OpenOptions, type TransportSession } from '../src/providers/transport/types.js';
import { EventLog, makeContext, makeTempDir, sleep, waitUntil, type TestContext } from './helpers/claude-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_VIBE = path.join(here, 'helpers/fake-vibe.mjs');
const HOST_PROGRAM = path.join(here, '../src/providers/transport/session-host.ts');

const FAST = { initializeTimeoutMs: 5_000, requestTimeoutMs: 5_000, interruptGraceMs: 300, closeGraceMs: 400, termGraceMs: 400 };

interface Logged { method: string; params: any; pid: number; jsonrpc?: string }
interface Registered { provider: string; nativeSessionId: string; conversationId: string; cwd: string; pid: number; fresh: boolean }

/** One conversation's worth of setup: a temp project, a fake `vibe-acp`, and the plugin over either stdio or a real session host. */
function setup(options: { host?: boolean; coordination?: boolean; trusted?: boolean; register?: boolean; loggedOut?: boolean } = {}) {
  const dir = makeTempDir('vibe-plugin-');
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const logFile = path.join(dir, 'fake.log');
  const holdFile = path.join(dir, 'hold');
  const quotaFile = path.join(dir, 'quota');
  const runtime = path.join(dir, 'runtime');
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    VIBE_HOME: home,
    FAKE_VIBE_LOG: logFile,
    FAKE_VIBE_HOLD: holdFile,
    // Identity of the process that started the backend must not reach the child.
    CLAUDECODE: '1',
    TMUX: '/tmp/tmux-1/default,1,0',
    AGENT_CONSOLE_SESSION_ID: 'someone-else',
    MISTRAL_API_KEY: 'not-a-real-key',
  };
  if (options.trusted !== false) baseEnv.FAKE_VIBE_TRUSTED = '1';
  if (options.loggedOut) baseEnv.FAKE_VIBE_LOGGED_OUT = '1';
  const command = [process.execPath, FAKE_VIBE];
  const coordination = options.coordination ? { runtimeDir: '/tmp/agent-runtime', helperPath: '/opt/agent-coord.mjs' } : undefined;
  const registrations: Registered[] = [];
  const instances: VibeInstance[] = [];
  const sessions: TransportSession[] = [];
  const makeBackend = (metaFrom?: TestContext) => {
    const context = makeContext(path.join(runtime, 'structured', 'vibe'), coordination ? { coordination } : {});
    if (metaFrom) for (const [key, value] of metaFrom.metaStore) context.metaStore.set(key, value);
    if (options.host) context.lineTransport = createLineTransportFactory({ runtimeDir: runtime, log: context.log, hostProgramPath: HOST_PROGRAM });
    if (options.register) {
      context.registerConversation = async (input) => {
        registrations.push(input);
        return input.fresh ? { startupContext: '[Agent Console coordination — session start]\nassignment demo' } : {};
      };
    }
    const instance = createVibePlugin({
      timings: FAST,
      baseEnv,
      homeDir: home,
      quotaCommand: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "limited")', quotaFile],
    }).create({ enabled: true, command, idleUnloadMinutes: 60, env: {} }, context) as VibeInstance;
    instances.push(instance);
    return { instance, context };
  };
  const first = makeBackend();
  const open = (overrides: Partial<OpenOptions> = {}): OpenOptions => ({ conversationId: 'conversation-1', cwd, policy: { approvals: 'never', sandbox: 'full-access' }, model: 'glm-5-3', effort: 'high', ...overrides });
  const log = (): Logged[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Logged) : []);
  const received = (method: string): Logged[] => log().filter(entry => entry.method === method);
  const track = <T extends TransportSession>(session: T): T => { sessions.push(session); return session; };
  const currentOf = (sessionId: string) => JSON.parse(fs.readFileSync(path.join(home, 'logs', 'session', 'unified', sessionId, 'CURRENT'), 'utf8')) as { generation: string; snapshot_sequence: number };
  return {
    dir, cwd, home, holdFile, quotaFile, runtime, registrations, ...first, makeBackend, open, log, received, track, currentOf,
    release: () => fs.writeFileSync(holdFile, 'go'),
    cleanup: async () => {
      await Promise.allSettled(sessions.map(session => session.close('release')));
      await Promise.allSettled(instances.map(instance => instance.dispose('shutdown')));
      if (options.host) {
        await terminateHost(runtime, hostIdFor('conversation-1'), first.context.log, { closeGraceMs: 300, termGraceMs: 300, staleTermGraceMs: 300 }).catch(() => undefined);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const live: Array<ReturnType<typeof setup>> = [];
function fresh(options: Parameters<typeof setup>[0] = {}) {
  const s = setup(options);
  live.push(s);
  return s;
}
afterEach(async () => { for (const s of live.splice(0)) await s.cleanup(); });

const text = (value: string, extra: Record<string, unknown> = {}) => ({ text: value, clientMessageId: 'm', ...extra });

describe('Vibe plugin: launch', () => {
  it('starts `vibe-acp` with no flags, speaks JSON-RPC 2.0, trusts nothing extra when the workspace is trusted, and sets auto-approve', async () => {
    const s = fresh({ coordination: true });
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    await events.waitForType('session.state');
    expect(session.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.capabilities).toMatchObject({ processModel: 'per-session', steer: 'none', images: true, modelSwitch: 'next-turn' });
    expect(events.of('session.native')[0]).toMatchObject({ nativeSessionId: session.nativeSessionId, transcriptPath: path.join(s.home, 'logs', 'session', 'unified', session.nativeSessionId, 'CURRENT') });
    expect(events.of('session.state')[0]).toMatchObject({ state: 'ready' });

    const log = s.log();
    expect(log.map(entry => entry.method)).toEqual(['initialize', 'session/new', 'session/set_config_option']);
    expect(log.every(entry => entry.jsonrpc === '2.0')).toBe(true);
    const created = s.received('session/new')[0]!.params;
    expect(created).toMatchObject({ cwd: s.cwd });
    expect(created.mcpServers).toEqual([{
      name: 'agent_console_coordination', command: 'node', args: ['/opt/agent-coord.mjs', 'mcp'],
      env: [{ name: 'AGENT_COORD_RUNTIME', value: '/tmp/agent-runtime' }, { name: 'AGENT_CONSOLE_SESSION_ID', value: 'conversation-1' }],
    }]);
    expect(s.received('session/set_config_option')[0]!.params).toEqual({ sessionId: session.nativeSessionId, configId: 'mode', value: 'auto-approve' });
    expect(s.received('_trust/decision')).toHaveLength(0);
    // session/new reports context usage before it answers, and that report is kept.
    expect(events.of('usage.updated')[0]).toMatchObject({ contextUsedTokens: 10, contextMaxTokens: 800000 });
  });

  it('trusts an untrusted configured directory, then reloads the model so project instructions are rebuilt, then sets auto-approve', async () => {
    const s = fresh({ trusted: false });
    const session = s.track(await s.instance.start(s.open()));
    new EventLog(session);
    expect(s.log().map(entry => entry.method)).toEqual(['initialize', 'session/new', '_trust/decision', 'session/set_config_option', 'session/set_config_option']);
    expect(s.received('_trust/decision')[0]!.params).toEqual({ sessionId: session.nativeSessionId, decision: 'trust_cwd' });
    expect(s.received('session/set_config_option').map(entry => entry.params)).toEqual([
      { sessionId: session.nativeSessionId, configId: 'model', value: 'glm-5-3' },
      { sessionId: session.nativeSessionId, configId: 'mode', value: 'auto-approve' },
    ]);
  });

  it('builds the environment and the MCP list from the shared helpers, and drops Mistral API keys from every layer', () => {
    const env = buildVibeEnv({
      base: { PATH: '/bin', HOME: '/home/me', CLAUDECODE: '1', MISTRAL_API_KEY: 'from-base', MISTRAL_OTHER_TOKEN: 'from-base', KEEP: 'yes', AGENT_COORD_RUNTIME: '/old' },
      configEnv: { VIBE_HOME: '~/alt', MISTRAL_API_KEY: 'from-config' },
      optionsEnv: { AGENT_COORD_RUNTIME: '/new', MISTRAL_SESSION_SECRET: 'from-options' },
      conversationId: 'c1',
      home: '/home/me',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me', KEEP: 'yes', VIBE_HOME: '/home/me/alt', AGENT_COORD_RUNTIME: '/new', AGENT_CONSOLE_SESSION_ID: 'c1' });
    expect(env.MISTRAL_API_KEY).toBeUndefined();
    expect(buildMcpServers(undefined, 'c1')).toEqual([]);
    expect(hostIdFor('a b/c')).toBe('vibe-a-b-c');
  });

  it('probes without a session: version and login, no models, no session/new', async () => {
    const s = fresh();
    const probe = await s.instance.probe();
    expect(probe).toEqual({ installed: true, version: '3.0.4-fake', auth: 'ok', models: [] });
    expect(s.received('session/new')).toHaveLength(0);
    expect(s.log().map(entry => entry.method)).toEqual(['initialize', '_auth/status']);
  });

  it('registers the conversation itself and prepends the session-start context to the first prompt only', async () => {
    const s = fresh({ register: true });
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    expect(s.registrations).toEqual([{
      provider: 'vibe', nativeSessionId: session.nativeSessionId, conversationId: 'conversation-1', cwd: s.cwd, pid: session.pid, fresh: true,
    }]);
    const first = await session.sendTurn(text('plain'));
    await events.waitForTerminal(first.turnId);
    expect(s.received('session/prompt')[0]!.params.prompt).toEqual([
      { type: 'text', text: '[Agent Console coordination — session start]\nassignment demo\n\nplain' },
    ]);
    const second = await session.sendTurn(text('again'));
    await events.waitForTerminal(second.turnId);
    expect(s.received('session/prompt')[1]!.params.prompt).toEqual([{ type: 'text', text: 'again' }]);

    await session.close('shutdown');
    await events.done;
    const next = s.makeBackend();
    const resumed = s.track(await next.instance.resume(session.nativeSessionId, s.open()));
    expect(s.registrations.at(-1)).toMatchObject({ fresh: false, nativeSessionId: session.nativeSessionId });
    const resumedEvents = new EventLog(resumed);
    const follow = await resumed.sendTurn(text('after resume'));
    await resumedEvents.waitForTerminal(follow.turnId);
    expect(s.received('session/prompt').at(-1)!.params.prompt).toEqual([{ type: 'text', text: 'after resume' }]);
  });
});

describe('Vibe plugin: turns', () => {
  it('maps an ACP turn to started, assistant and reasoning items, a tool item, context usage and exactly one terminal', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn(text('use a tool please'));
    const terminal = await events.waitForTerminal(turnId);
    expect(terminal).toMatchObject({ status: 'completed', sessionUsable: true, replay: false });
    expect(events.terminalsOf(turnId)).toHaveLength(1);
    expect(events.of('turn.started').at(-1)).toMatchObject({ turnId, origin: 'user', replay: false });
    const items = events.of('item.completed');
    expect(items.map(item => item.kind)).toEqual(['reasoning', 'command', 'assistant']);
    expect(items[1]).toMatchObject({ itemId: 'call-1', title: 'Execute `ls`' });
    expect(events.of('usage.updated').at(-1)).toMatchObject({ contextUsedTokens: 1234, contextMaxTokens: 800000 });
    expect(session.activeTurn).toBeUndefined();
    expect(s.context.metaStore.has('vibe-turn:conversation-1')).toBe(false);
  });

  it('refuses a second turn while one runs, records the prompt request id, and runs another after the first ends', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const first = await session.sendTurn(text('slow one'));
    expect(session.activeTurn).toBe(first.turnId);
    const recorded = JSON.parse(s.context.metaStore.get('vibe-turn:conversation-1')!) as { turnId: string; requestId: number; generation: string; snapshotSequence: number };
    expect(recorded).toMatchObject({ turnId: first.turnId, generation: 'gen-0001', snapshotSequence: 1 });
    expect(recorded.requestId).toEqual(expect.any(Number));
    await expect(session.sendTurn(text('another'))).rejects.toMatchObject({ code: 'previous_turn_active' });
    s.release();
    await events.waitForTerminal(first.turnId);
    expect(s.context.metaStore.has('vibe-turn:conversation-1')).toBe(false);
    const second = await session.sendTurn(text('plain'));
    expect((await events.waitForTerminal(second.turnId)).status).toBe('completed');
  });

  it('applies a different model and thinking level before the turn, and only when they differ from the session\'s own', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open({ model: 'glm-5-3', effort: 'high' })));
    const events = new EventLog(session);
    const same = await session.sendTurn(text('plain', { model: 'glm-5-3', effort: 'high' }));
    await events.waitForTerminal(same.turnId);
    expect(s.received('session/set_config_option').filter(entry => entry.params.configId !== 'mode')).toHaveLength(0);

    const switched = await session.sendTurn(text('plain', { model: 'zai-glm-5-3-flash', effort: 'low' }));
    await events.waitForTerminal(switched.turnId);
    const calls = s.received('session/set_config_option').map(entry => entry.params).filter(params => params.configId !== 'mode');
    expect(calls).toEqual([
      { sessionId: session.nativeSessionId, configId: 'model', value: 'zai-glm-5-3-flash' },
      { sessionId: session.nativeSessionId, configId: 'thinking', value: 'low' },
    ]);
    const methods = s.log().map(entry => entry.method);
    expect(methods.lastIndexOf('session/set_config_option')).toBeLessThan(methods.lastIndexOf('session/prompt'));

    const again = await session.sendTurn(text('plain', { model: 'zai-glm-5-3-flash', effort: 'low' }));
    await events.waitForTerminal(again.turnId);
    expect(s.received('session/set_config_option').filter(entry => entry.params.configId !== 'mode')).toHaveLength(2);
  });

  it('sets and confirms thinking while a turn is running', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn(text('slow one'));
    await session.setEffort('max');
    expect(s.received('session/set_config_option').at(-1)?.params).toEqual({ sessionId: session.nativeSessionId, configId: 'thinking', value: 'max' });
    expect(session.activeTurn).toBe(turnId);
    s.release();
    await events.waitForTerminal(turnId);
  });

  it('rejects a model or thinking level Vibe does not offer, without sending the prompt', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    new EventLog(session);
    await expect(session.sendTurn(text('plain', { model: 'glm-9' }))).rejects.toBeInstanceOf(SendRejectedError);
    await expect(session.sendTurn(text('plain', { effort: 'ultra' }))).rejects.toBeInstanceOf(SendRejectedError);
    expect(s.received('session/prompt')).toHaveLength(0);
    expect(session.activeTurn).toBeUndefined();
  });

  it('attaches images as ACP image blocks before the text, and refuses a missing file as a rejection', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const image = path.join(s.dir, 'pic.png');
    fs.writeFileSync(image, Buffer.from('png-bytes'));
    const { turnId } = await session.sendTurn(text('see the picture', { images: [{ path: image, mimeType: 'image/png' }] }));
    await events.waitForTerminal(turnId);
    expect(s.received('session/prompt')[0]!.params.prompt).toEqual([
      { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: 'see the picture' },
    ]);
    await expect(session.sendTurn(text('x', { images: [{ path: path.join(s.dir, 'gone.png'), mimeType: 'image/png' }] }))).rejects.toBeInstanceOf(SendRejectedError);
  });

  it('sends session/cancel on interrupt and reports the turn as interrupted', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn(text('slow one'));
    await session.interrupt(turnId);
    const terminal = await events.waitForTerminal(turnId);
    expect(terminal.status).toBe('interrupted');
    expect(s.received('session/cancel')[0]!.params).toEqual({ sessionId: session.nativeSessionId });
    expect(events.terminalsOf(turnId)).toHaveLength(1);
    const next = await session.sendTurn(text('plain'));
    expect((await events.waitForTerminal(next.turnId)).status).toBe('completed');
  });

  it('closes an interrupted turn itself when Vibe never answers the cancel', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn(text('silent-cancel'));
    await session.interrupt(turnId);
    const terminal = await events.waitForTerminal(turnId, 3_000);
    expect(terminal.status).toBe('interrupted');
  });

  it('ends a rate-limited turn with a plain notice, records it for the router, and classifies any other error as the provider\'s', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const limited = await session.sendTurn(text('rate-limit'));
    const limitTerminal = await events.waitForTerminal(limited.turnId);
    expect(limitTerminal).toMatchObject({ status: 'failed', failure: { class: 'provider_error', code: 'rate_limited', message: VIBE_RATE_LIMIT_NOTICE, retryable: true }, sessionUsable: true });
    expect(events.of('notice').at(-1)).toMatchObject({ level: 'warn', text: VIBE_RATE_LIMIT_NOTICE });
    await waitUntil(() => fs.existsSync(s.quotaFile), 3_000, 'the quota command to record the limit');
    expect(fs.readFileSync(s.quotaFile, 'utf8')).toBe('limited');
    const failed = await session.sendTurn(text('please fail'));
    const failTerminal = await events.waitForTerminal(failed.turnId);
    expect(failTerminal).toMatchObject({ status: 'failed', failure: { class: 'provider_error', code: '-32603' } });
  });

  it('warns when Vibe ends with a whitespace-only response', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn(text('blank-answer'));
    await events.waitForTerminal(turnId);
    expect(events.of('notice')).toContainEqual(expect.objectContaining({ level: 'warn', text: expect.stringContaining('empty response') }));
  });

  it('declines a permission request the agent raises, and tells the agent it was cancelled', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn(text('needs permission'));
    const opened = await events.waitForType('request.opened');
    expect(opened).toMatchObject({ requestId: 'perm-1', kind: 'permission', summary: 'Run rm -rf build', turnId });
    await session.respond('perm-1', { decision: 'decline' });
    await events.waitForTerminal(turnId);
    expect(events.of('request.closed')[0]).toMatchObject({ requestId: 'perm-1', outcome: 'declined' });
    expect(s.received('agent-saw-permission-outcome')[0]!.params).toEqual({ outcome: { outcome: 'cancelled' } });
    await expect(session.respond('perm-1', { decision: 'decline' })).rejects.toMatchObject({ code: 'request_not_pending' });
  });

  it('fails the running turn and stops the session when the process dies under it', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn(text('slow one'));
    process.kill(session.pid!, 'SIGKILL');
    const terminal = await events.waitForTerminal(turnId);
    expect(terminal).toMatchObject({ status: 'failed', failure: { class: 'transport_error', code: 'process_exited' }, sessionUsable: false });
    await events.done;
    expect(events.of('session.state').at(-1)).toMatchObject({ state: 'stopped' });
    await expect(session.sendTurn(text('after'))).rejects.toBeInstanceOf(NotSentError);
  });
});

describe('Vibe plugin: resume', () => {
  it('starts a new process and runs session/load when no process is left, dropping the replayed history', async () => {
    const s = fresh();
    const first = s.track(await s.instance.start(s.open({ model: 'glm-5-3', effort: 'high' })));
    const firstEvents = new EventLog(first);
    const turn = await first.sendTurn(text('plain', { model: 'zai-glm-5-3-flash', effort: 'low' }));
    await firstEvents.waitForTerminal(turn.turnId);
    await first.close('shutdown');
    await firstEvents.done;

    const second = s.makeBackend();
    const resumed = s.track(await second.instance.resume(first.nativeSessionId, s.open({ model: 'glm-5-3', effort: 'high' })));
    const events = new EventLog(resumed);
    expect(resumed.nativeSessionId).toBe(first.nativeSessionId);
    expect(s.received('session/load')[0]!.params).toMatchObject({ sessionId: first.nativeSessionId, cwd: s.cwd });
    await events.waitForType('session.state');
    await sleep(30);
    expect(events.types()).toEqual(['session.native', 'session.state']);
    expect(resumed.activeTurn).toBeUndefined();
    const next = await resumed.sendTurn(text('plain', { model: 'glm-5-3', effort: 'high' }));
    expect((await events.waitForTerminal(next.turnId)).status).toBe('completed');
    expect(s.received('session/set_config_option').map(entry => entry.params).filter(params => params.configId !== 'mode').slice(-2)).toEqual([
      { sessionId: resumed.nativeSessionId, configId: 'model', value: 'glm-5-3' },
      { sessionId: resumed.nativeSessionId, configId: 'thinking', value: 'high' },
    ]);
  });

  it('refuses a session Vibe no longer has, as a failed resume', async () => {
    const s = fresh();
    await expect(s.instance.resume('00000000-0000-7000-8000-000000000000', s.open())).rejects.toBeInstanceOf(ResumeFailedError);
  });

  it('adopts the process that outlived the backend behind its session host: idle, no turn, no session/load, a second initialize', async () => {
    const s = fresh({ host: true });
    const first = s.track(await s.instance.start(s.open()));
    const firstEvents = new EventLog(first);
    const turn = await first.sendTurn(text('plain'));
    await firstEvents.waitForTerminal(turn.turnId);
    const pid = first.pid;
    await s.instance.dispose('shutdown');

    const next = s.makeBackend(s.context);
    const adopted = await next.instance.reattach(first.nativeSessionId, s.open());
    expect(adopted).toBeDefined();
    s.track(adopted!);
    expect(adopted!.nativeSessionId).toBe(first.nativeSessionId);
    expect(adopted!.pid).toBe(pid);
    expect(adopted!.activeTurn).toBeUndefined();
    expect(s.received('session/new')).toHaveLength(1);
    expect(s.received('session/load')).toHaveLength(0);
    expect(s.received('initialize')).toHaveLength(2);
    expect(s.received('_trust/decision')).toHaveLength(0);
    const events = new EventLog(adopted!);
    const again = await adopted!.sendTurn(text('plain'));
    expect((await events.waitForTerminal(again.turnId)).status).toBe('completed');
  });

  it('adopts a turn that was still running, and ends it when the answer to the old prompt arrives on the new connection', async () => {
    const s = fresh({ host: true });
    const first = s.track(await s.instance.start(s.open()));
    const running = await first.sendTurn(text('slow one'));
    await waitUntil(() => s.received('session/prompt').length === 1, 3_000, 'the prompt to arrive');
    await s.instance.dispose('shutdown');

    const next = s.makeBackend(s.context);
    const adopted = s.track((await next.instance.reattach(first.nativeSessionId, s.open()))!);
    expect(adopted.activeTurn).toBe(running.turnId);
    const events = new EventLog(adopted);
    await expect(adopted.sendTurn(text('plain'))).rejects.toMatchObject({ code: 'previous_turn_active' });
    s.release();
    const terminal = await events.waitForTerminal(running.turnId);
    expect(terminal.status).toBe('completed');
    expect(events.terminalsOf(running.turnId)).toHaveLength(1);
    expect(adopted.activeTurn).toBeUndefined();
    expect([...next.context.metaStore.keys()].filter(key => key.startsWith('vibe-turn:'))).toEqual([]);
    expect(s.received('session/load')).toHaveLength(0);
  });

  it('ends an adopted turn as completed when the store shows it finished while no backend was connected', async () => {
    const s = fresh({ host: true });
    const first = s.track(await s.instance.start(s.open()));
    const running = await first.sendTurn(text('drop-answer'));
    await waitUntil(() => s.currentOf(first.nativeSessionId).generation === 'gen-0002', 3_000, 'the store to advance');
    expect(s.currentOf(first.nativeSessionId).snapshot_sequence).toBe(1);
    await s.instance.dispose('shutdown');

    const next = s.makeBackend(s.context);
    const adopted = s.track((await next.instance.reattach(first.nativeSessionId, s.open()))!);
    const events = new EventLog(adopted);
    const terminal = await events.waitForTerminal(running.turnId);
    expect(terminal).toMatchObject({ status: 'completed', sessionUsable: true });
    expect(adopted.activeTurn).toBeUndefined();
    expect(s.received('session/load')).toHaveLength(0);
    expect([...next.context.metaStore.keys()].filter(key => key.startsWith('vibe-turn:'))).toEqual([]);
  });

  it('forgets the launch when the process is gone, so a later resume starts a new one with session/load', async () => {
    const s = fresh({ host: true });
    const first = s.track(await s.instance.start(s.open()));
    const firstEvents = new EventLog(first);
    const turn = await first.sendTurn(text('plain'));
    await firstEvents.waitForTerminal(turn.turnId);
    expect(s.context.metaStore.has('vibe-launch:conversation-1')).toBe(true);
    await first.close('release');
    await firstEvents.done;
    expect(s.context.metaStore.has('vibe-launch:conversation-1')).toBe(false);

    const next = s.makeBackend(s.context);
    expect(await next.instance.reattach(first.nativeSessionId, s.open())).toBeUndefined();
    const resumed = s.track(await next.instance.resume(first.nativeSessionId, s.open()));
    expect(resumed.pid).not.toBe(first.pid);
    expect(s.received('session/load')).toHaveLength(1);
    await sleep(10);
  });
});
