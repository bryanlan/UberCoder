import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createGrokPlugin, buildGrokArgv, buildGrokEnv, buildMcpServers, grokTranscriptPath, hostIdFor, type GrokSession } from '../src/providers/transport/grok/index.js';
import { GrokInstance } from '../src/providers/transport/grok/grok-instance.js';
import { createLineTransportFactory, terminateHost } from '../src/providers/transport/line-transport.js';
import { NotSentError, ResumeFailedError, SendRejectedError, type OpenOptions, type TransportSession } from '../src/providers/transport/types.js';
import { EventLog, makeContext, makeTempDir, sleep, waitUntil, type TestContext } from './helpers/claude-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_GROK = path.join(here, 'helpers/fake-grok.mjs');
const HOST_PROGRAM = path.join(here, '../src/providers/transport/session-host.ts');

const FAST = { initializeTimeoutMs: 5_000, requestTimeoutMs: 5_000, interruptGraceMs: 300, closeGraceMs: 400, termGraceMs: 400 };

interface Logged { method: string; params: any; pid: number; jsonrpc?: string }

/** One conversation's worth of setup: a temp project, a fake `grok` command, and the plugin over either stdio or a real session host. */
function setup(options: { host?: boolean; coordination?: boolean } = {}) {
  const dir = makeTempDir('grok-plugin-');
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const logFile = path.join(dir, 'fake.log');
  const holdFile = path.join(dir, 'hold');
  const runtime = path.join(dir, 'runtime');
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: home,
    FAKE_GROK_STATE: path.join(dir, 'state'),
    FAKE_GROK_LOG: logFile,
    FAKE_GROK_HOLD: holdFile,
    // Identity of the process that started the backend must not reach the child.
    CLAUDECODE: '1',
    TMUX: '/tmp/tmux-1/default,1,0',
    AGENT_CONSOLE_SESSION_ID: 'someone-else',
  };
  const command = [process.execPath, FAKE_GROK];
  const coordination = options.coordination ? { runtimeDir: '/tmp/agent-runtime', helperPath: '/opt/agent-coord.mjs' } : undefined;
  const instances: GrokInstance[] = [];
  const sessions: TransportSession[] = [];
  const makeBackend = (metaFrom?: TestContext) => {
    const context = makeContext(path.join(runtime, 'structured', 'grok'), coordination ? { coordination } : {});
    if (metaFrom) for (const [key, value] of metaFrom.metaStore) context.metaStore.set(key, value);
    if (options.host) context.lineTransport = createLineTransportFactory({ runtimeDir: runtime, log: context.log, hostProgramPath: HOST_PROGRAM });
    const instance = createGrokPlugin({ timings: FAST, baseEnv, homeDir: home }).create({ enabled: true, command, idleUnloadMinutes: 60, env: {} }, context) as GrokInstance;
    instances.push(instance);
    return { instance, context };
  };
  const first = makeBackend();
  const open = (overrides: Partial<OpenOptions> = {}): OpenOptions => ({ conversationId: 'conversation-1', cwd, policy: { approvals: 'never', sandbox: 'full-access' }, model: 'grok-4.7', effort: 'high', ...overrides });
  const log = (): Logged[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Logged) : []);
  const received = (method: string): Logged[] => log().filter(entry => entry.method === method);
  const track = <T extends TransportSession>(session: T): T => { sessions.push(session); return session; };
  return {
    dir, cwd, home, holdFile, runtime, ...first, makeBackend, open, log, received, track,
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

describe('Grok plugin: launch', () => {
  it('starts `grok agent --always-approve ... stdio` in the project, speaks JSON-RPC 2.0 and returns Grok\'s session id', async () => {
    const s = fresh({ coordination: true });
    const session = s.track(await s.instance.start(s.open({ env: { AGENT_CONSOLE_SESSION_ID: 'conversation-1' } })));
    const events = new EventLog(session);
    await events.waitForType('session.state');
    expect(session.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.capabilities).toMatchObject({ processModel: 'per-session', steer: 'none', images: true, modelSwitch: 'next-turn' });
    expect(events.of('session.native')[0]).toMatchObject({ nativeSessionId: session.nativeSessionId, transcriptPath: grokTranscriptPath(path.join(s.home, '.grok'), s.cwd, session.nativeSessionId) });
    expect(events.of('session.state')[0]).toMatchObject({ state: 'ready' });

    const log = s.log();
    expect(log.map(entry => entry.method)).toEqual(['initialize', 'session/new']);
    expect(log.every(entry => entry.jsonrpc === '2.0')).toBe(true);
    const created = s.received('session/new')[0]!.params;
    expect(created).toMatchObject({ cwd: s.cwd, _meta: { yoloMode: true } });
    // The coordination MCP server of this conversation rides on session/new, as ACP's name and value pairs.
    expect(created.mcpServers).toEqual([{
      name: 'agent_console_coordination', command: 'node', args: ['/opt/agent-coord.mjs', 'mcp'],
      env: [{ name: 'AGENT_COORD_RUNTIME', value: '/tmp/agent-runtime' }, { name: 'AGENT_CONSOLE_SESSION_ID', value: 'conversation-1' }],
    }]);
  });

  it('builds the command line, the environment and the MCP list from small pure helpers', () => {
    expect(buildGrokArgv({ command: ['grok'], model: 'grok-4.7', effort: 'xhigh' })).toEqual(['grok', 'agent', '--always-approve', '--model', 'grok-4.7', '--reasoning-effort', 'xhigh', 'stdio']);
    expect(buildGrokArgv({ command: ['/opt/grok'] })).toEqual(['/opt/grok', 'agent', '--always-approve', 'stdio']);
    const env = buildGrokEnv({
      base: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', TMUX: 'x', CODEX_THREAD_ID: 't', NODE_OPTIONS: '--inspect', DEBUG: '*', AGENT_CONSOLE_SESSION_ID: 'other', AGENT_COORD_RUNTIME: '/old', KEEP: 'yes' },
      configEnv: { GROK_HOME: '~/alt' }, optionsEnv: { AGENT_COORD_RUNTIME: '/new', TMUX: 'ignored' }, conversationId: 'c1', home: '/home/me',
    });
    expect(env).toEqual({ PATH: '/bin', KEEP: 'yes', GROK_HOME: '/home/me/alt', AGENT_COORD_RUNTIME: '/new', AGENT_CONSOLE_SESSION_ID: 'c1' });
    expect(buildMcpServers(undefined, 'c1')).toEqual([]);
    expect(hostIdFor('a b/c')).toBe('grok-a-b-c');
  });

  it('probes without a session: the models, the version and the login', async () => {
    const s = fresh();
    const probe = await s.instance.probe();
    expect(probe).toMatchObject({ installed: true, version: '1.0.70-fake', auth: 'ok' });
    expect(probe.models.map(model => model.id)).toEqual(['grok-4.7', 'grok-4.6']);
    expect(probe.models[0]!.efforts).toEqual(['xhigh', 'high', 'medium', 'low']);
    expect(s.received('session/new')).toHaveLength(0);
  });
});

describe('Grok plugin: turns', () => {
  it('maps an ACP turn to started, assistant and reasoning items, a tool item, context usage and exactly one terminal', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn(text('use a tool please'));
    const terminal = await events.waitForTerminal(turnId);
    expect(terminal).toMatchObject({ status: 'completed', sessionUsable: true, replay: false });
    expect(events.terminalsOf(turnId)).toHaveLength(1);
    expect(events.of('turn.started')[0]).toMatchObject({ turnId, origin: 'user', replay: false });
    const items = events.of('item.completed');
    expect(items.map(item => item.kind)).toEqual(['reasoning', 'command', 'assistant']);
    expect(items.every(item => item.turnId === turnId)).toBe(true);
    expect(items[1]).toMatchObject({ itemId: 'call-1', title: 'Execute `ls`' });
    expect(events.of('usage.updated')[0]).toMatchObject({ contextUsedTokens: 1234, contextMaxTokens: 256000 });
    // Order: started, then the items, then the usage and the terminal.
    expect(events.types().indexOf('turn.started')).toBeLessThan(events.types().indexOf('item.completed'));
    expect(events.types().indexOf('item.completed')).toBeLessThan(events.types().indexOf('turn.terminal'));
    expect(session.activeTurn).toBeUndefined();
    expect(s.received('session/prompt')[0]!.params).toMatchObject({ sessionId: session.nativeSessionId, prompt: [{ type: 'text', text: 'use a tool please' }] });
  });

  it('refuses a second turn while one runs, and runs another after the first ends', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const first = await session.sendTurn(text('slow one'));
    expect(session.activeTurn).toBe(first.turnId);
    await expect(session.sendTurn(text('another'))).rejects.toMatchObject({ code: 'previous_turn_active' });
    s.release();
    await events.waitForTerminal(first.turnId);
    const second = await session.sendTurn(text('plain'));
    expect((await events.waitForTerminal(second.turnId)).status).toBe('completed');
  });

  it('applies a different model and effort before the turn, and only when they differ from the session\'s own', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open({ model: 'grok-4.7', effort: 'high' })));
    const events = new EventLog(session);
    const same = await session.sendTurn(text('plain', { model: 'grok-4.7', effort: 'high' }));
    await events.waitForTerminal(same.turnId);
    expect(s.received('session/set_config_option')).toHaveLength(0);

    const switched = await session.sendTurn(text('plain', { model: 'grok-4.6', effort: 'low' }));
    await events.waitForTerminal(switched.turnId);
    const calls = s.received('session/set_config_option').map(entry => entry.params);
    expect(calls).toEqual([
      { sessionId: session.nativeSessionId, configId: 'model', value: 'grok-4.6' },
      { sessionId: session.nativeSessionId, configId: 'reasoning_effort', value: 'low' },
    ]);
    // The model change comes before the prompt that uses it.
    const methods = s.log().map(entry => entry.method);
    expect(methods.lastIndexOf('session/set_config_option')).toBeLessThan(methods.lastIndexOf('session/prompt'));

    const again = await session.sendTurn(text('plain', { model: 'grok-4.6', effort: 'low' }));
    await events.waitForTerminal(again.turnId);
    expect(s.received('session/set_config_option')).toHaveLength(2);
    // The context limit of the new model is what the next usage report uses.
    expect(events.of('usage.updated').at(-1)).toMatchObject({ contextMaxTokens: 200000 });
  });

  it('rejects a model Grok does not offer, without sending the prompt', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    new EventLog(session);
    await expect(session.sendTurn(text('plain', { model: 'grok-9' }))).rejects.toBeInstanceOf(SendRejectedError);
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

  it('does not let a late end-of-prompt signal of an earlier turn end the turn that follows it', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const first = await session.sendTurn(text('plain, late-duplicate'));
    await events.waitForTerminal(first.turnId);
    const second = await session.sendTurn(text('slow one'));
    await sleep(300); // the repeated signal for the first prompt arrives about now
    expect(session.activeTurn).toBe(second.turnId);
    expect(events.terminalsOf(second.turnId)).toHaveLength(0);
    s.release();
    expect((await events.waitForTerminal(second.turnId)).status).toBe('completed');
    expect(events.terminalsOf(first.turnId)).toHaveLength(1);
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
    // A turn can follow.
    const next = await session.sendTurn(text('plain'));
    expect((await events.waitForTerminal(next.turnId)).status).toBe('completed');
  });

  it('closes an interrupted turn itself when Grok never answers the cancel', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn(text('silent-cancel'));
    await session.interrupt(turnId);
    const terminal = await events.waitForTerminal(turnId, 3_000);
    expect(terminal.status).toBe('interrupted');
  });

  it('classifies a usage limit and a model error from the JSON-RPC error answer', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open()));
    const events = new EventLog(session);
    const limited = await session.sendTurn(text('hit the limit'));
    const limitTerminal = await events.waitForTerminal(limited.turnId);
    expect(limitTerminal).toMatchObject({ status: 'failed', failure: { class: 'usage_limit', retryable: false }, sessionUsable: true });
    const failed = await session.sendTurn(text('please fail'));
    const failTerminal = await events.waitForTerminal(failed.turnId);
    expect(failTerminal).toMatchObject({ status: 'failed', failure: { class: 'provider_error' } });
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

  it('keeps a background task in mind: hasBackgroundWork follows the task events', async () => {
    const s = fresh();
    const session = s.track(await s.instance.start(s.open())) as GrokSession;
    expect(session.hasBackgroundWork()).toBe(false);
    const internals = session as unknown as { onExtUpdate(params: unknown): void };
    internals.onExtUpdate({ update: { sessionUpdate: 'task_backgrounded', task_id: 't1' } });
    expect(session.hasBackgroundWork()).toBe(true);
    internals.onExtUpdate({ update: { sessionUpdate: 'task_completed', task_snapshot: { task_id: 't1' } } });
    expect(session.hasBackgroundWork()).toBe(false);
  });
});

describe('Grok plugin: resume', () => {
  it('starts a new process and runs session/load for a conversation with no live process, dropping the replayed history', async () => {
    const s = fresh();
    const first = s.track(await s.instance.start(s.open({ model: 'grok-4.7', effort: 'high' })));
    const firstEvents = new EventLog(first);
    const turn = await first.sendTurn(text('plain', { model: 'grok-4.6', effort: 'low' }));
    await firstEvents.waitForTerminal(turn.turnId);
    await first.close('shutdown');
    await firstEvents.done;

    const second = s.makeBackend();
    const resumed = s.track(await second.instance.resume(first.nativeSessionId, s.open({ model: 'grok-4.7', effort: 'high' })));
    const events = new EventLog(resumed);
    expect(resumed.nativeSessionId).toBe(first.nativeSessionId);
    const load = s.received('session/load')[0]!.params;
    expect(load).toMatchObject({ sessionId: first.nativeSessionId, cwd: s.cwd });
    // The history Grok streams back is not activity of this connection.
    await events.waitForType('session.state');
    await sleep(30); // let anything else the replay would have produced arrive
    expect(events.types()).toEqual(['session.native', 'session.state']);
    expect(resumed.activeTurn).toBeUndefined();
    // The saved conversation kept its model, so the next turn asks for the profile's model again.
    const next = await resumed.sendTurn(text('plain', { model: 'grok-4.7', effort: 'high' }));
    expect((await events.waitForTerminal(next.turnId)).status).toBe('completed');
    expect(s.received('session/set_config_option').map(entry => entry.params.value).slice(-2)).toEqual(['grok-4.7', 'high']);
  });

  it('refuses a session Grok no longer has, as a failed resume', async () => {
    const s = fresh();
    await expect(s.instance.resume('00000000-0000-7000-8000-000000000000', s.open())).rejects.toBeInstanceOf(ResumeFailedError);
  });

  it('adopts the process that outlived the backend behind its session host: idle, no turn, no new session', async () => {
    const s = fresh({ host: true });
    const first = s.track(await s.instance.start(s.open()));
    const firstEvents = new EventLog(first);
    const turn = await first.sendTurn(text('plain'));
    await firstEvents.waitForTerminal(turn.turnId);
    const pid = first.pid;
    await s.instance.dispose('shutdown'); // the connection closes; the host keeps the process

    const next = s.makeBackend(s.context);
    const adopted = await next.instance.reattach(first.nativeSessionId, s.open());
    expect(adopted).toBeDefined();
    s.track(adopted!);
    expect(adopted!.nativeSessionId).toBe(first.nativeSessionId);
    expect(adopted!.pid).toBe(pid);
    expect(adopted!.activeTurn).toBeUndefined();
    // It asked the roster instead of loading, and made no second session.
    expect(s.received('session/new')).toHaveLength(1);
    expect(s.received('session/load')).toHaveLength(0);
    expect(s.received('_x.ai/sessions/list')).toHaveLength(1);
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
    // The turn is the session's again, under the id the earlier backend gave it, and not new activity.
    expect(adopted.activeTurn).toBe(running.turnId);
    const events = new EventLog(adopted);
    await expect(adopted.sendTurn(text('plain'))).rejects.toMatchObject({ code: 'previous_turn_active' });
    s.release();
    const terminal = await events.waitForTerminal(running.turnId);
    expect(terminal.status).toBe('completed');
    expect(events.terminalsOf(running.turnId)).toHaveLength(1);
    expect(adopted.activeTurn).toBeUndefined();
    // The record of the running turn is gone with it.
    expect([...next.context.metaStore.keys()].filter(key => key.startsWith('grok-turn:'))).toEqual([]);
  });

  it('lets Stop reach an adopted turn by its empty id, and reports nothing to adopt when there is no launch record', async () => {
    const s = fresh({ host: true });
    const first = s.track(await s.instance.start(s.open()));
    await first.sendTurn(text('slow one'));
    await waitUntil(() => s.received('session/prompt').length === 1, 3_000, 'the prompt to arrive');
    await s.instance.dispose('shutdown');
    const next = s.makeBackend(s.context);
    const adopted = s.track((await next.instance.reattach(first.nativeSessionId, s.open()))!);
    const events = new EventLog(adopted);
    const turnId = adopted.activeTurn!;
    expect(turnId).toBeDefined();
    await adopted.interrupt('');
    expect((await events.waitForTerminal(turnId, 3_000)).status).toBe('interrupted');

    const stranger = s.makeBackend();
    expect(await stranger.instance.reattach('11111111-1111-7111-8111-111111111111', s.open({ conversationId: 'conversation-2' }))).toBeUndefined();
  });

  it('forgets the launch when the process is gone, so a later resume starts a new one with session/load', async () => {
    const s = fresh({ host: true });
    const first = s.track(await s.instance.start(s.open()));
    const firstEvents = new EventLog(first);
    const turn = await first.sendTurn(text('plain'));
    await firstEvents.waitForTerminal(turn.turnId);
    expect(s.context.metaStore.has('grok-launch:conversation-1')).toBe(true);
    await first.close('release');
    await firstEvents.done;
    expect(s.context.metaStore.has('grok-launch:conversation-1')).toBe(false);

    const next = s.makeBackend(s.context);
    expect(await next.instance.reattach(first.nativeSessionId, s.open())).toBeUndefined();
    const resumed = s.track(await next.instance.resume(first.nativeSessionId, s.open()));
    expect(resumed.pid).not.toBe(first.pid);
    expect(s.received('session/load')).toHaveLength(1);
    await sleep(10);
  });
});
