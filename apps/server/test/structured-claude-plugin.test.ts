import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeArgv, buildClaudeEnv, CLAUDE_UNRESPONSIVE_LIMIT_MS, ClaudeLaunchRefusedError, ClaudeSessionHeldError, createClaudePlugin, type ClaudeOpenOptions, type ClaudePluginOptions } from '../src/providers/transport/claude/index.js';
import { ClaudeSession, DEFAULT_TIMINGS as DEFAULT_CLAUDE_TIMINGS } from '../src/providers/transport/claude/claude-session.js';
import { hostIdFor, type ClaudeInstance } from '../src/providers/transport/claude/claude-instance.js';
import { assistantRateLimitEvidence, classifyResult, failureFromApiRetry, newTurnEvidence } from '../src/providers/transport/claude/errors.js';
import type { ClaudeResultFrame } from '../src/providers/transport/claude/protocol.js';
import { StreamJsonClient, ClaudeControlError, ClaudeControlTimeoutError, ClaudeExitError } from '../src/providers/transport/claude/stream-json.js';
import { ClaudeRateLimitTracker, contextFromUsageResponse, contextMaxFromModelUsage, contextUsedFromResultUsage } from '../src/providers/transport/claude/usage.js';
import { escapeProjectDir, findSessionHolder } from '../src/providers/transport/claude/transcript.js';
import { processStartTicks } from '../src/providers/transport/codex/process-lifetime.js';
import { createStdioLineTransportFactory, terminateHost, transportStartedFresh } from '../src/providers/transport/line-transport.js';
import {
  LineTransportNotRunningError,
  NotSentError,
  SendRejectedError,
  PreviousTurnActiveError,
  RequestNotPendingError,
  ResumeFailedError,
  TransportBusyError,
  TransportUnavailableError,
  TurnNotActiveError,
  type LineTransport,
  type LineTransportFactory,
  type LineTransportSpawn,
  type TransportEvent,
} from '../src/providers/transport/types.js';
import {
  assistantText,
  canUseTool,
  cleanupAll,
  EventLog,
  FAKE_CLAUDE,
  FAST_TIMINGS,
  makeContext,
  QUESTION_INPUT,
  rateLimitEvent,
  readLog,
  receivedControls,
  receivedFrames,
  receivedResponses,
  receivedUserFrames,
  sentFrames,
  setupFake,
  sleep,
  startEntries,
  transcriptPathFor,
  userText,
  waitUntil,
  writeRegistryFile,
  writeTranscript,
  type FakeSetup,
  type Scenario,
  type SetupOptions,
} from './helpers/claude-harness.js';

afterEach(async () => {
  await cleanupAll();
});

async function startSession(scenario: Scenario = {}, options: SetupOptions = {}, open: Partial<ClaudeOpenOptions> = {}): Promise<{ setup: FakeSetup; session: ClaudeSession; events: EventLog }> {
  const setup = setupFake(scenario, options);
  const session = setup.track(await setup.instance.start(setup.open(open)));
  return { setup, session, events: new EventLog(session) };
}

const COORDINATION = { runtimeDir: '/runtime/console', helperPath: '/opt/console/agent-coord.mjs' };

/** An image of random pixels: the worst case for every encoder, so a few megapixels are already megabytes. */
async function noiseImage(width: number, height: number, format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> {
  const pixels = randomBytes(width * height * 3);
  const image = sharp(pixels, { raw: { width, height, channels: 3 } });
  if (format === 'png') return image.png({ compressionLevel: 1 }).toBuffer();
  if (format === 'jpeg') return image.jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
  return image.webp({ quality: 100 }).toBuffer();
}

/** An in-memory line transport: the test plays the CLI. */
function memoryTransport(): { transport: LineTransport; fromCli(frame: object): void; written: Array<Record<string, any>>; exit(code?: number | 'disconnected'): void; closed: Array<unknown> } {
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(info: { code: number | null; signal: string | null; reason: 'exited' | 'disconnected' }) => void>();
  const written: Array<Record<string, any>> = [];
  const closed: unknown[] = [];
  let ended = false;
  const transport: LineTransport = {
    pid: 4242,
    write: async (line) => {
      if (ended) throw new NotSentError('closed');
      written.push(JSON.parse(line));
    },
    onLine: (listener) => {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    close: async (options) => {
      closed.push(options ?? {});
    },
  };
  return {
    transport,
    written,
    closed,
    fromCli: (frame) => {
      for (const listener of [...lineListeners]) listener(JSON.stringify(frame));
    },
    exit: (code = 0) => {
      ended = true;
      const info = code === 'disconnected' ? { code: null, signal: null, reason: 'disconnected' as const } : { code, signal: null, reason: 'exited' as const };
      for (const listener of [...exitListeners]) listener(info);
    },
  };
}


// ---------------------------------------------------------------------------------------------------------

describe('launch', () => {
  it('starts claude with the planned argv, the coordination MCP server and no -p', async () => {
    const { setup, session } = await startSession({}, { context: { coordination: COORDINATION }, plugin: { requireHooks: false } }, { model: 'sonnet', effort: 'low' });
    const [start] = startEntries(setup.logFile);
    expect(start!.argv).toEqual([
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--permission-prompt-tool', 'stdio',
      '--model', 'sonnet',
      '--effort', 'low',
      '--session-id', session.nativeSessionId,
      '--mcp-config', expect.any(String),
    ]);
    expect(start!.argv).not.toContain('-p');
    expect(session.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const mcp = JSON.parse(start!.argv![start!.argv!.indexOf('--mcp-config') + 1]!);
    expect(mcp).toEqual({
      mcpServers: {
        agent_console_coordination: {
          command: 'node',
          args: ['/opt/console/agent-coord.mjs', 'mcp'],
          env: { AGENT_COORD_RUNTIME: '/runtime/console', AGENT_CONSOLE_SESSION_ID: 'conversation-1' },
        },
      },
    });
    expect(start!.cwd).toBe(setup.cwd);
  });

  it('omits flags it has no value for, and passes --system-prompt-snapshot off when told', async () => {
    const setup = setupFake({});
    const argv = buildClaudeArgv({ command: ['claude'], mode: 'resume', sessionId: 'abc', snapshotOff: true });
    expect(argv).toEqual(['claude', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio', '--resume', 'abc', '--system-prompt-snapshot', 'off']);
    const session = setup.track(await setup.instance.start(setup.open()));
    const [start] = startEntries(setup.logFile);
    expect(start!.argv).not.toContain('--model');
    expect(start!.argv).not.toContain('--effort');
    expect(start!.argv).not.toContain('--mcp-config');
    expect(session.capabilities).toEqual({ processModel: 'per-session', nativeIds: 'client-allocated', resume: 'reattach', steer: 'native', interrupt: 'terminal-follows', images: true, enforcement: 'native', modelSwitch: 'next-turn' });
  });

  it('scrubs the inherited Claude, tmux and Console identity and sets this session identity', async () => {
    const { setup } = await startSession(
      {},
      {
        baseEnv: {
          CLAUDECODE: '1',
          CLAUDE_CODE_SESSION_ID: 'parent-session',
          CLAUDE_CODE_ENTRYPOINT: 'cli',
          CLAUDE_CODE_MESSAGING_SOCKET: '/run/x.sock',
          TMUX: '/tmp/tmux-1000/default,1,0',
          TMUX_PANE: '%3',
          CODEX_THREAD_ID: 'thread-9',
          AGENT_CONSOLE_SESSION_ID: 'stale',
          AGENT_COORD_RUNTIME: '/stale',
          NODE_OPTIONS: '--require=./loader.cjs',
          DEBUG: '*',
          KEEP_ME: 'yes',
        },
        config: { env: { AGENT_COORD_RUNTIME: '/runtime/console', AGENT_CONSOLE_CONFIG: '/etc/console.json', CLAUDE_CONFIG_DIR: '~/alt-claude', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', CLAUDECODE: 'from-config' } },
        plugin: { requireHooks: false },
      },
      { env: { EXTRA: 'from-open', TMUX: 'sneaky' } },
    );
    const env = startEntries(setup.logFile)[0]!.env!;
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'TMUX', 'TMUX_PANE', 'CODEX_THREAD_ID', 'NODE_OPTIONS', 'DEBUG']) {
      expect(env, key).not.toHaveProperty(key);
    }
    // A CLAUDE_CODE_* key the Console config sets on purpose reaches the process; only the inherited ones are scrubbed.
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('64000');
    expect(env.AGENT_CONSOLE_SESSION_ID).toBe('conversation-1');
    expect(env.AGENT_COORD_RUNTIME).toBe('/runtime/console');
    expect(env.AGENT_CONSOLE_CONFIG).toBe('/etc/console.json');
    expect(env.CLAUDE_CODE_SDK_READS_SESSION_STATE).toBe('1');
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(setup.home, 'alt-claude'));
    expect(env.KEEP_ME).toBe('yes');
    expect(env.EXTRA).toBe('from-open');
  });

  it('buildClaudeEnv leaves no identity variable and builds the same value for the probe', () => {
    const env = buildClaudeEnv({ base: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_X: '1', TMUX: 't', AGENT_CONSOLE_FOO: 'x' }, home: '/home/test' });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' });
  });

  it('keeps CLAUDE_CODE_* keys the config or the open options set, scrubs identity keys from every layer, and never lets them turn session-state reporting off', () => {
    const env = buildClaudeEnv({
      base: { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_MAX_OUTPUT_TOKENS: 'inherited' },
      configEnv: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', CLAUDE_CODE_SDK_READS_SESSION_STATE: '0', TMUX_PANE: '%1', CODEX_THREAD_ID: 't' },
      optionsEnv: { CLAUDE_CODE_EXTRA_BODY: '{}', CLAUDECODE: '1' },
      home: '/home/test',
    });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', CLAUDE_CODE_EXTRA_BODY: '{}', CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' });
  });

  it('sends initialize with the appended system prompt and no dialog kinds, keeping the text out of argv', async () => {
    const { setup, events } = await startSession({}, { plugin: { requireHooks: false } }, { appendSystemPrompt: 'GRANT AUTHORITY TEXT' });
    const initialize = receivedControls(setup.logFile, 'initialize');
    expect(initialize).toHaveLength(1);
    expect(initialize[0]).toEqual({ type: 'control_request', request_id: 'console-1', request: { subtype: 'initialize', appendSystemPrompt: 'GRANT AUTHORITY TEXT' } });
    expect(JSON.stringify(startEntries(setup.logFile)[0]!.argv)).not.toContain('GRANT AUTHORITY TEXT');
    await waitUntil(() => events.events.length >= 2);
    expect(events.events[0]).toMatchObject({ type: 'session.native', transcriptPath: expect.stringContaining(`${escapeProjectDir(setup.cwd)}`) });
    expect(events.events[1]).toEqual({ type: 'session.state', state: 'ready' });
  });

  it('sends a bare initialize when there is no text to append', async () => {
    const { setup } = await startSession();
    expect(receivedControls(setup.logFile, 'initialize')[0]!.request).toEqual({ subtype: 'initialize' });
  });

  it('refuses to start in a working directory that does not exist', async () => {
    const setup = setupFake();
    await expect(setup.instance.start(setup.open({ cwd: path.join(setup.dir, 'missing') }))).rejects.toBeInstanceOf(TransportUnavailableError);
    expect(startEntries(setup.logFile)).toHaveLength(0);
  });

  it('reports a missing binary as unavailable', async () => {
    const setup = setupFake({}, { config: { command: ['/nonexistent/claude-binary'] } });
    await expect(setup.instance.start(setup.open())).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it('uses the session id the caller gives for a conversation that has no transcript yet, and refuses one that has', async () => {
    const setup = setupFake();
    const id = '11111111-2222-4333-8444-555555555555';
    const session = setup.track(await setup.instance.start(setup.open({ sessionId: id })));
    expect(session.nativeSessionId).toBe(id);
    expect(startEntries(setup.logFile)[0]!.argv).toContain(id);
    await session.close('release');
    writeTranscript(setup.configDir, setup.cwd, id);
    await expect(setup.instance.start(setup.open({ sessionId: id }))).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it('derives a valid session host id from the conversation id', () => {
    expect(hostIdFor('0a1b2c3d-1111-2222-3333-444455556666')).toBe('claude-0a1b2c3d-1111-2222-3333-444455556666');
    expect(hostIdFor('a:b/c d')).toBe('claude-a-b-c-d');
    expect(hostIdFor('x'.repeat(300))).toHaveLength(128);
  });

  it('passes the host id and the close graces to the line transport factory', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const setup = setupFake(
      {},
      {
        plugin: { requireHooks: false },
        context: {
          lineTransport: async (request) => {
            requests.push(request as unknown as Record<string, unknown>);
            const { createStdioLineTransportFactory } = await import('../src/providers/transport/line-transport.js');
            return createStdioLineTransportFactory()(request);
          },
        },
      },
    );
    setup.track(await setup.instance.start(setup.open({ conversationId: 'conv-42' })));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ hostId: 'claude-conv-42', closeGraceMs: 400, termGraceMs: 400, cwd: setup.cwd });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('probe', () => {
  it('reads models, account and version with a throwaway process that never receives a message', async () => {
    const setup = setupFake({ account: { tokenSource: 'none', apiProvider: 'firstParty' } });
    const result = await setup.instance.probe();
    expect(result).toEqual({
      installed: true,
      version: '2.1.310',
      auth: 'missing',
      models: [
        { id: 'default', label: 'Default (recommended)', efforts: ['low', 'medium', 'high'] },
        { id: 'haiku', label: 'Haiku' },
      ],
    });
    const [start] = startEntries(setup.logFile);
    expect(start!.argv).toEqual([
      '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
      '--session-id', expect.stringMatching(/^[0-9a-f-]{36}$/),
      '--no-session-persistence',
      '--settings', '{"disableAllHooks":true}',
    ]);
    expect(receivedUserFrames(setup.logFile)).toHaveLength(0);
    await waitUntil(() => readLog(setup.logFile).some((entry) => entry.event === 'stdin-eof'), 3000, 'end of input');
    expect(await setup.instance.alive()).toEqual({ connected: false });
  });

  it('reports a signed-in subscription account as ok', async () => {
    const setup = setupFake({ account: { email: 'a@example.com', subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' }, version: '2.1.400' });
    expect(await setup.instance.probe()).toMatchObject({ installed: true, version: '2.1.400', auth: 'ok' });
  });

  it('reports a binary that is not installed', async () => {
    const setup = setupFake({}, { config: { command: ['/nonexistent/claude-binary'] } });
    expect(await setup.instance.probe()).toEqual({ installed: false, auth: 'unknown', models: [] });
  });

  it('fails when the process dies before it answers', async () => {
    const setup = setupFake({ exitAtStart: 2 });
    await expect(setup.instance.probe()).rejects.toBeInstanceOf(TransportUnavailableError);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('turns', () => {
  it('maps a turn to started, item, usage and terminal events in order, matched by uuid', async () => {
    const { setup, session, events } = await startSession({
      turns: [
        {
          steps: [
            assistantText('Looking.'),
            { toolUse: { id: 'tool-bash', name: 'Bash', input: { command: 'echo hi' } } },
            { toolResult: { id: 'tool-bash' } },
            { toolUse: { id: 'tool-edit', name: 'Edit', input: { file_path: '/work/a.ts' } } },
            { toolResult: { id: 'tool-edit' } },
            { toolUse: { id: 'tool-read', name: 'Read', input: { file_path: '/work/b.ts' } } },
            { toolResult: { id: 'tool-read' } },
            { toolUse: { id: 'tool-web', name: 'WebSearch', input: { query: 'vitest docs' } } },
            { toolResult: { id: 'tool-web' } },
            { toolUse: { id: 'tool-mcp', name: 'mcp__agent_console_coordination__send', input: {} } },
            { toolResult: { id: 'tool-mcp' } },
            { assistant: { blocks: [{ type: 'thinking', thinking: 'hmm' }] } },
            assistantText('Done.'),
          ],
        },
      ],
    });
    const { turnId } = await session.sendTurn({ text: 'SECRET-PROMPT-TEXT please' });
    const terminal = await events.waitForTerminal(turnId);
    expect(terminal).toEqual({ type: 'turn.terminal', turnId, status: 'completed', sessionUsable: true, replay: false });
    const items = events.of('item.completed');
    expect(items.map((item) => [item.kind, item.title])).toEqual([
      ['assistant', undefined],
      ['command', 'echo hi'],
      ['file_change', '/work/a.ts'],
      ['other', '/work/b.ts'],
      ['search', 'vitest docs'],
      ['mcp', 'agent_console_coordination/send'],
      ['reasoning', undefined],
      ['assistant', undefined],
    ]);
    expect(items.every((item) => item.turnId === turnId && !item.replay)).toBe(true);
    expect(new Set(items.map((item) => item.itemId)).size).toBe(items.length);
    const started = events.indexOf((event) => event.type === 'turn.started');
    expect(events.events[started]).toEqual({ type: 'turn.started', turnId, origin: 'user', replay: false });
    expect(started).toBeLessThan(events.indexOf((event) => event.type === 'item.completed'));
    expect(events.indexOf((event) => event.type === 'item.completed')).toBeLessThan(events.indexOf((event) => event.type === 'turn.terminal'));
    expect(events.of('turn.started')).toHaveLength(1);
    expect(events.terminalsOf(turnId)).toHaveLength(1);

    // The user message carries our uuid, the human origin, an empty session id and no priority.
    const [user] = receivedUserFrames(setup.logFile);
    expect(user).toEqual({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: 'SECRET-PROMPT-TEXT please' }] },
      parent_tool_use_id: null,
      uuid: turnId,
      origin: { kind: 'human' },
    });

    // Frames are never logged whole: the prompt text stays out of the log.
    expect(JSON.stringify(setup.context.logs)).not.toContain('SECRET-PROMPT-TEXT');
  });

  it('reports context fill from the result and from get_context_usage', async () => {
    const { setup, session, events } = await startSession({ contextUsage: { totalTokens: 4321, rawMaxTokens: 1000000 } });
    const { turnId } = await session.sendTurn({ text: 'hi' });
    await events.waitForTerminal(turnId);
    await events.waitFor((event) => event.type === 'usage.updated' && event.contextUsedTokens === 4321);
    const usage = events.of('usage.updated').filter((event) => event.contextUsedTokens !== undefined || event.contextMaxTokens !== undefined);
    // From the result: the last iteration (10 + 100 + 5) and the model window.
    expect(usage[0]).toEqual({ type: 'usage.updated', contextUsedTokens: 115, contextMaxTokens: 200000 });
    expect(usage.at(-1)).toEqual({ type: 'usage.updated', contextUsedTokens: 4321, contextMaxTokens: 1000000 });
    expect(receivedControls(setup.logFile, 'get_context_usage')[0]!.request).toEqual({ subtype: 'get_context_usage', detail: 'summary' });
  });

  it('stops asking for context usage after the CLI refuses it once', async () => {
    const { setup, session, events } = await startSession({ contextUsage: 'error' });
    for (let i = 0; i < 2; i += 1) {
      const { turnId } = await session.sendTurn({ text: `turn ${i}` });
      await events.waitForTerminal(turnId);
      await sleep(80);
    }
    expect(receivedControls(setup.logFile, 'get_context_usage')).toHaveLength(1);
  });

  it('rejects a second turn while one runs and a steer after it ended', async () => {
    const { session, events } = await startSession({ turns: [{ steps: [{ hold: true }] }] });
    const { turnId } = await session.sendTurn({ text: 'first' });
    await expect(session.sendTurn({ text: 'second' })).rejects.toBeInstanceOf(PreviousTurnActiveError);
    await events.waitForType('turn.started');
    await session.interrupt(turnId);
    await events.waitForTerminal(turnId);
    await expect(session.steer(turnId, { text: 'late' })).rejects.toBeInstanceOf(TurnNotActiveError);
    const next = await session.sendTurn({ text: 'again' });
    await events.waitForTerminal(next.turnId);
  });

  it('claims the turn slot at once so two sends in a row cannot both go through', async () => {
    const { session } = await startSession({ turns: [{ steps: [{ hold: true }] }] });
    const results = await Promise.allSettled([session.sendTurn({ text: 'a' }), session.sendTurn({ text: 'b' })]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(PreviousTurnActiveError);
  });

  it('applies a model and effort change before the message and only when it changes', async () => {
    const { setup, session, events } = await startSession({}, {}, { model: 'sonnet', effort: 'low' });
    const first = await session.sendTurn({ text: 'one', model: 'opus', effort: 'high' });
    await events.waitForTerminal(first.turnId);
    const second = await session.sendTurn({ text: 'two', model: 'opus', effort: 'high' });
    await events.waitForTerminal(second.turnId);
    const sequence = receivedFrames(setup.logFile)
      .filter((frame) => frame.type === 'user' || (frame.type === 'control_request' && ['set_model', 'apply_flag_settings'].includes(frame.request.subtype)))
      .map((frame) => (frame.type === 'user' ? `user:${userText(frame)}` : frame.request.subtype === 'set_model' ? `set_model:${frame.request.model}` : `effort:${frame.request.settings.effortLevel}`));
    expect(sequence).toEqual(['set_model:opus', 'effort:high', 'user:one', 'user:two']);
  });

  it('changes and reads back effort while a turn is running', async () => {
    const { setup, session, events } = await startSession({ turns: [{ steps: [{ hold: true }] }] });
    await session.sendTurn({ text: 'working' });
    await events.waitForType('turn.started');
    await session.setEffort('high');
    expect(receivedControls(setup.logFile).filter(frame => ['apply_flag_settings', 'get_settings'].includes(frame.request.subtype)).map(frame => frame.request.subtype)).toEqual(['apply_flag_settings', 'get_settings']);
  });

  it('sends an image that already fits as it is: a base64 block before the text', async () => {
    const { setup, session, events } = await startSession();
    const image = path.join(setup.dir, 'shot.png');
    const bytes = await noiseImage(64, 48, 'png');
    fs.writeFileSync(image, bytes);
    const { turnId } = await session.sendTurn({ text: 'look', images: [{ path: image, mimeType: 'image/png' }] });
    await events.waitForTerminal(turnId);
    const [user] = receivedUserFrames(setup.logFile);
    expect(user!.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } },
      { type: 'text', text: 'look' },
    ]);
  });

  describe('large images', () => {
    // The API refuses an image above 5 MB and the CLI does not resize a block it is handed, so the plugin fits it first.
    async function sentImage(format: 'png' | 'jpeg' | 'webp', width: number, height: number, claimed: string): Promise<{ block: { source: { media_type: string; data: string } }; original: Buffer; decoded: Buffer }> {
      const { setup, session, events } = await startSession();
      const original = await noiseImage(width, height, format);
      const image = path.join(setup.dir, `big.${format}`);
      fs.writeFileSync(image, original);
      const { turnId } = await session.sendTurn({ text: 'look', images: [{ path: image, mimeType: claimed }] });
      await events.waitForTerminal(turnId);
      const block = receivedUserFrames(setup.logFile)[0]!.message.content[0];
      return { block, original, decoded: Buffer.from(block.source.data, 'base64') };
    }
    const LIMIT = 4.5 * 1024 * 1024;

    it('scales a large PNG down and keeps it a PNG within the size and edge limits', async () => {
      const { block, original, decoded } = await sentImage('png', 2000, 1500, 'image/png');
      expect(original.length).toBeGreaterThan(5 * 1024 * 1024); // a raw paste the API would refuse
      expect(block.source.media_type).toBe('image/png');
      expect(block.source.data.length).toBeLessThanOrEqual(LIMIT);
      const meta = await sharp(decoded).metadata();
      expect(meta.format).toBe('png');
      expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
      expect(meta.width! / meta.height!).toBeCloseTo(2000 / 1500, 1); // the shape is kept
    }, 30_000);

    it('shrinks an image that is small in pixels but large in bytes, and turns a large JPEG or WebP into a JPEG', async () => {
      const heavy = await sentImage('png', 1500, 1200, 'image/png'); // inside the edge limit, far above the byte limit
      expect(heavy.original.length).toBeGreaterThan(LIMIT);
      expect(heavy.block.source.data.length).toBeLessThanOrEqual(LIMIT);
      expect((await sharp(heavy.decoded).metadata()).format).toBe('png');

      const jpeg = await sentImage('jpeg', 2400, 1800, 'image/jpeg');
      expect(jpeg.block.source.media_type).toBe('image/jpeg');
      expect(jpeg.block.source.data.length).toBeLessThanOrEqual(LIMIT);
      const jpegMeta = await sharp(jpeg.decoded).metadata();
      expect(jpegMeta.format).toBe('jpeg');
      expect(Math.max(jpegMeta.width!, jpegMeta.height!)).toBeLessThanOrEqual(1568);

      const webp = await sentImage('webp', 2200, 1600, 'image/webp');
      expect(webp.block.source.media_type).toBe('image/jpeg'); // not PNG, so JPEG
      expect((await sharp(webp.decoded).metadata()).format).toBe('jpeg');
      expect(webp.block.source.data.length).toBeLessThanOrEqual(LIMIT);
    }, 60_000);

    it('fails a send whose image is not an image, before anything is written', async () => {
      const { setup, session } = await startSession();
      const image = path.join(setup.dir, 'not-an-image.png');
      fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
      // Sending it again would fail the same way: the message is rejected with the reason, not left to be retried.
      const error = await session.sendTurn({ text: 'look', images: [{ path: image, mimeType: 'image/png' }] }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SendRejectedError);
      expect(error).not.toBeInstanceOf(NotSentError);
      expect((error as Error).message).toMatch(/image could not be read/);
      expect(receivedUserFrames(setup.logFile)).toHaveLength(0);
    });
  });

  it('rejects a send whose image cannot be read, before anything is written, with the reason', async () => {
    const { setup, session } = await startSession();
    const error = await session.sendTurn({ text: 'look', images: [{ path: path.join(setup.dir, 'missing.png'), mimeType: 'image/png' }] }).catch((caught: unknown) => caught);
    // A missing file stays missing: this is not NotSentError, which the host retries.
    expect(error).toBeInstanceOf(SendRejectedError);
    expect(error).not.toBeInstanceOf(NotSentError);
    expect((error as Error).message).toMatch(/ENOENT|no such file/i);
    expect(receivedUserFrames(setup.logFile)).toHaveLength(0);
    // The slot is free again.
    const { turnId } = await session.sendTurn({ text: 'ok' });
    expect(turnId).toBeTruthy();
  });

  it('rejects a steer whose image cannot be read, and registers nothing for it', async () => {
    const { setup, session } = await startSession({ steps: [{ sleep: 400 }, assistantText('done')] });
    const { turnId } = await session.sendTurn({ text: 'work' });
    const error = await session.steer(turnId, { text: 'look', images: [{ path: path.join(setup.dir, 'missing.png'), mimeType: 'image/png' }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SendRejectedError);
    expect(receivedUserFrames(setup.logFile)).toHaveLength(1); // only the turn itself
  });

  it('keeps NotSentError for a model change that timed out and rejects one the CLI refused, writing nothing either way', async () => {
    const { setup, session } = await startSession();
    const client = (session as unknown as { client: StreamJsonClient }).client;
    const real = client.sendControl.bind(client);
    const requests: string[] = [];
    (client as unknown as { sendControl: unknown }).sendControl = async (request: { subtype: string }, options?: { timeoutMs?: number }) => {
      requests.push(request.subtype);
      if (request.subtype === 'set_model' && requests.filter((subtype) => subtype === 'set_model').length === 1) throw new ClaudeControlTimeoutError('set_model', 150);
      if (request.subtype === 'set_model') throw new ClaudeControlError('set_model', 'Model opus-9 is not available');
      if (request.subtype === 'apply_flag_settings') throw new ClaudeControlError('apply_flag_settings', 'refused');
      return real(request as never, options);
    };
    // A timeout may go through next time; a refusal never will.
    await expect(session.sendTurn({ text: 'x', model: 'opus' })).rejects.toBeInstanceOf(NotSentError);
    const refusedModel = await session.sendTurn({ text: 'x', model: 'opus' }).catch((caught: unknown) => caught);
    expect(refusedModel).toBeInstanceOf(SendRejectedError);
    expect((refusedModel as Error).message).toMatch(/opus-9 is not available/);
    const refusedEffort = await session.sendTurn({ text: 'x', effort: 'high' }).catch((caught: unknown) => caught);
    expect(refusedEffort).toBeInstanceOf(SendRejectedError);
    expect((refusedEffort as Error).message).toMatch(/refused/);
    expect(receivedUserFrames(setup.logFile)).toHaveLength(0);
    expect(session.activeTurn).toBeUndefined(); // the slot is free again
  });

  it('keeps NotSentError for a connection that was lost while the message was prepared', async () => {
    const { setup, session } = await startSession();
    const client = (session as unknown as { client: StreamJsonClient }).client;
    (client as unknown as { sendControl: unknown }).sendControl = async () => {
      throw new ClaudeExitError({ code: null, signal: null, reason: 'disconnected' }, false);
    };
    await expect(session.sendTurn({ text: 'x', model: 'opus' })).rejects.toBeInstanceOf(NotSentError);
    expect(receivedUserFrames(setup.logFile)).toHaveLength(0);
  });

  it('uses a caller uuid as the message uuid and a fresh one otherwise', async () => {
    const { setup, session, events } = await startSession();
    const given = 'aaaaaaaa-1111-4222-8333-444444444444';
    const a = await session.sendTurn({ text: 'a', clientMessageId: given });
    expect(a.turnId).toBe(given);
    await events.waitForTerminal(a.turnId);
    const b = await session.sendTurn({ text: 'b', clientMessageId: 'not-a-uuid' });
    expect(b.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.turnId).not.toBe('not-a-uuid');
    await events.waitForTerminal(b.turnId);
    expect(receivedUserFrames(setup.logFile).map((frame) => frame.uuid)).toEqual([given, b.turnId]);
  });

  it('treats a repeated uuid as already handled: no turn runs and the send still ends once', async () => {
    const { setup, session, events } = await startSession();
    const uuid = 'bbbbbbbb-1111-4222-8333-444444444444';
    const first = await session.sendTurn({ text: 'once', clientMessageId: uuid });
    await events.waitForTerminal(first.turnId);
    const again = await session.sendTurn({ text: 'once', clientMessageId: uuid });
    expect(again.turnId).toBe(uuid);
    await waitUntil(() => events.of('turn.terminal').length === 2);
    expect(events.of('turn.started')).toHaveLength(2);
    expect(events.of('turn.terminal').map((event) => event.status)).toEqual(['completed', 'completed']);
    expect(events.of('notice').some((event) => /already had this message/.test(event.text))).toBe(true);
    // The fake answered the repeat with a bare `completed`: no `started`, no init, no result.
    const lifecycle = sentFrames(setup.logFile).filter((frame) => frame.type === 'command_lifecycle' && frame.command_uuid === uuid).map((frame) => frame.state);
    expect(lifecycle).toEqual(['queued', 'started', 'completed', 'completed']);
    expect(sentFrames(setup.logFile).filter((frame) => frame.type === 'result')).toHaveLength(1);
    await sleep(100);
    expect(events.of('turn.terminal')).toHaveLength(2);
  });

  it('starts a provider-origin turn when the CLI begins one on its own and ends it with its result', async () => {
    const { setup, session, events } = await startSession();
    expect(session.activeTurn).toBeUndefined();
    // A background task finished: the CLI starts a turn nobody sent. The fake can only do that from a script, so
    // run a turn whose steps emit a second, uuid-less turn's frames after the first result.
    setup.rewriteScenario({
      turns: [
        {
          steps: [
            { result: {} },
            { emit: { type: 'system', subtype: 'init', session_id: '{{sessionId}}', model: 'claude-test', apiKeySource: 'none', uuid: 'cccccccc-0000-4000-8000-000000000001' } },
            { emit: { type: 'assistant', message: { id: 'm-bg', model: 'claude-test', role: 'assistant', content: [{ type: 'text', text: 'The build finished.' }] }, parent_tool_use_id: null, session_id: '{{sessionId}}', uuid: 'cccccccc-0000-4000-8000-000000000002' } },
            { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', terminal_reason: 'completed', session_id: '{{sessionId}}', uuid: 'cccccccc-0000-4000-8000-000000000003', usage: {}, modelUsage: {} } },
          ],
        },
      ],
    });
    // The running fake already read its scenario; start a new session for the rewritten one.
    await session.close('release');
    const second = setup.track(await setup.instance.start(setup.open({ conversationId: 'conversation-2' })));
    const log = new EventLog(second);
    const { turnId } = await second.sendTurn({ text: 'go' });
    await waitUntil(() => log.of('turn.terminal').length === 2, 5000, 'two terminals');
    const [own, provider] = log.of('turn.started');
    expect(own).toMatchObject({ turnId, origin: 'user' });
    expect(provider).toMatchObject({ origin: 'provider' });
    expect(provider!.adopted).toBeUndefined(); // a turn that began while this session was watching is new activity, not an adopted one
    expect(provider!.turnId).not.toBe(turnId);
    expect(log.of('turn.terminal').map((event) => [event.turnId, event.status])).toEqual([[turnId, 'completed'], [provider!.turnId, 'completed']]);
    expect(log.of('item.completed').filter((item) => item.turnId === provider!.turnId)).toHaveLength(1);
  });

  it('does not treat a late frame of a finished turn as a new turn', async () => {
    const { session, events } = await startSession({
      turns: [
        {
          steps: [
            { result: {} },
            // After its result the same turn emits another assistant frame (matching uuids): it is late, not a new turn.
            { emit: { type: 'assistant', message: { id: 'm-late', model: 'claude-test', role: 'assistant', content: [{ type: 'text', text: 'late' }] }, parent_tool_use_id: null, session_id: '{{sessionId}}', uuid: 'dddddddd-0000-4000-8000-000000000001', user_message_uuids: ['{{uuid}}'] } },
          ],
        },
      ],
    });
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForTerminal(turnId);
    await sleep(150);
    expect(events.of('turn.started')).toHaveLength(1);
    expect(events.of('item.completed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('steering', () => {
  it('writes a plain user message while the turn runs and folds into it: one turn, one terminal', async () => {
    const { setup, session, events } = await startSession({ turns: [{ steps: [{ sleep: 400 }, { fold: true }, assistantText('done')] }] });
    const { turnId } = await session.sendTurn({ text: 'first' });
    await events.waitForType('turn.started');
    await session.steer(turnId, { text: 'also this' });
    await events.waitForTerminal(turnId);
    const frames = receivedUserFrames(setup.logFile);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'also this' }] } });
    expect(frames[1]).not.toHaveProperty('priority');
    expect(frames[1]!.uuid).not.toBe(turnId);
    const result = sentFrames(setup.logFile).find((frame) => frame.type === 'result')!;
    expect(result.user_message_uuids).toEqual([turnId, frames[1]!.uuid]);
    await sleep(100);
    expect(events.of('turn.started')).toHaveLength(1);
    expect(events.of('turn.terminal')).toHaveLength(1);
  });

  it('reports a steer that found no tool boundary as the next turn it became', async () => {
    const { setup, session, events } = await startSession({ turns: [{ steps: [{ sleep: 150 }] }] });
    const { turnId } = await session.sendTurn({ text: 'first' });
    await events.waitForType('turn.started');
    await session.steer(turnId, { text: 'afterthought' });
    const steerUuid = (await waitUntil(() => receivedUserFrames(setup.logFile)[1]))!.uuid;
    await events.waitForTerminal(steerUuid);
    expect(events.of('turn.started').map((event) => [event.turnId, event.origin])).toEqual([[turnId, 'user'], [steerUuid, 'user']]);
    expect(events.of('turn.terminal').map((event) => [event.turnId, event.status])).toEqual([[turnId, 'completed'], [steerUuid, 'completed']]);
  });

  it('sends "now" messages with priority now: the running turn ends interrupted and the message runs as its own turn', async () => {
    const { setup, session, events } = await startSession({ turns: [{ steps: [{ hold: true }] }] });
    const { turnId } = await session.sendTurn({ text: 'long job' });
    await events.waitForType('turn.started');
    await session.steerNow(turnId, { text: 'stop that, do this' });
    const urgent = await waitUntil(() => receivedUserFrames(setup.logFile)[1]);
    expect(urgent).toMatchObject({ priority: 'now', origin: { kind: 'human' } });
    await events.waitForTerminal(urgent.uuid);
    expect(events.of('turn.terminal').map((event) => [event.turnId, event.status])).toEqual([[turnId, 'interrupted'], [urgent.uuid, 'completed']]);
    expect(events.of('turn.started')).toHaveLength(2);
  });

  it('refuses to steer when the session ended', async () => {
    const { session, events } = await startSession();
    await session.close('release');
    await events.done;
    await expect(session.steer('x', { text: 'late' })).rejects.toBeInstanceOf(NotSentError);
    await expect(session.sendTurn({ text: 'late' })).rejects.toBeInstanceOf(NotSentError);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('interrupt', () => {
  it('sends interrupt with cancel_queued and ends the turn interrupted when the aborted result follows', async () => {
    const { setup, session, events } = await startSession({ turns: [{ steps: [{ hold: true }] }] });
    const { turnId } = await session.sendTurn({ text: 'long job' });
    await events.waitForType('turn.started');
    await session.interrupt(turnId);
    const terminal = await events.waitForTerminal(turnId);
    expect(terminal).toMatchObject({ status: 'interrupted', sessionUsable: true });
    expect(terminal.failure).toBeUndefined();
    expect(receivedControls(setup.logFile, 'interrupt')[0]!.request).toEqual({ subtype: 'interrupt', cancel_queued: true });
    expect(events.terminalsOf(turnId)).toHaveLength(1);
    // The process survives: the next turn runs in it.
    const next = await session.sendTurn({ text: 'again' });
    expect((await events.waitForTerminal(next.turnId)).status).toBe('completed');
    expect(startEntries(setup.logFile)).toHaveLength(1);
  });

  it('closes the turn locally once when no result follows, and ignores the late result', async () => {
    const { session, events } = await startSession({ turns: [{ steps: [{ hold: true }] }], interrupt: { ignore: true, lateResultMs: 700 } });
    const { turnId } = await session.sendTurn({ text: 'long job' });
    await events.waitForType('turn.started');
    await session.interrupt(turnId);
    const terminal = await events.waitForTerminal(turnId, 2000);
    expect(terminal.status).toBe('interrupted');
    expect(events.of('notice').some((event) => event.level === 'warn' && /closed locally/.test(event.text))).toBe(true);
    await sleep(900); // the late aborted result arrives
    expect(events.terminalsOf(turnId)).toHaveLength(1);
    expect(events.of('turn.started')).toHaveLength(1);
  });

  it('drops a queued send the CLI cancelled, with no result to wait for', async () => {
    const { setup, session, events } = await startSession({ turns: [{ steps: [{ hold: true }] }] });
    const first = await session.sendTurn({ text: 'running' });
    await events.waitForType('turn.started');
    // A steer queued behind the running turn is cancelled with it.
    await session.steer(first.turnId, { text: 'queued steer' });
    await waitUntil(() => receivedUserFrames(setup.logFile)[1]);
    await session.interrupt(first.turnId);
    await events.waitForTerminal(first.turnId);
    await sleep(100);
    const lifecycle = sentFrames(setup.logFile).filter((frame) => frame.type === 'command_lifecycle').map((frame) => `${frame.command_uuid}:${frame.state}`);
    const steerUuid = receivedUserFrames(setup.logFile)[1]!.uuid;
    expect(lifecycle).toContain(`${steerUuid}:cancelled`);
    expect(events.of('turn.started')).toHaveLength(1);
    expect(events.of('turn.terminal')).toHaveLength(1);
  });

  it('ends a send that is interrupted before the CLI started it, from the cancelled list of the reply', async () => {
    const { setup, session, events } = await startSession({ startDelayMs: 400 });
    const { turnId } = await session.sendTurn({ text: 'queued' });
    await session.interrupt(turnId);
    const terminal = await events.waitForTerminal(turnId, 1000);
    expect(terminal.status).toBe('interrupted');
    expect(events.indexOf((event) => event.type === 'turn.started')).toBeLessThan(events.indexOf((event) => event.type === 'turn.terminal'));
    await sleep(500);
    // The CLI dropped it: no turn ran and no second terminal came.
    expect(sentFrames(setup.logFile).filter((frame) => frame.type === 'result')).toHaveLength(0);
    expect(events.terminalsOf(turnId)).toHaveLength(1);
  });

  it('closes a send the CLI cancelled before it started once nothing follows', async () => {
    const { session, events } = await startSession({ cancelQueuedAfterMs: 30 });
    const { turnId } = await session.sendTurn({ text: 'queued' });
    const terminal = await events.waitForTerminal(turnId, 2000);
    expect(terminal.status).toBe('interrupted');
    // The slot is free again.
    expect(session.activeTurn).toBeUndefined();
  });

  it('closes a turn that the CLI reports idle without ever sending its result', async () => {
    const { session, events } = await startSession({
      turns: [{ steps: [{ emit: { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'abababab-0000-4000-8000-000000000001', session_id: '{{sessionId}}' } }, { hold: true }] }],
    });
    const { turnId } = await session.sendTurn({ text: 'go' });
    const terminal = await events.waitForTerminal(turnId, 2000);
    expect(terminal).toMatchObject({ status: 'failed', failure: { class: 'transport_error', code: 'result_missing' }, sessionUsable: true });
    expect(events.of('notice').some((event) => /went idle without reporting/.test(event.text))).toBe(true);
  });

  it('is a no-op for a turn that is not running', async () => {
    const { setup, session } = await startSession();
    await session.interrupt('no-such-turn');
    expect(receivedControls(setup.logFile, 'interrupt')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('requests', () => {
  const questionTurn = (extra: Array<Record<string, unknown>> = []): Scenario => ({
    turns: [{ steps: [{ request: { request_id: 'req-q', request: canUseTool('AskUserQuestion', QUESTION_INPUT, 'tool-q') } }, assistantText('thanks'), ...extra] }],
  });

  it('opens a question with mapped questions and the turn id, and answers it with the exact allow shape', async () => {
    const { setup, session, events } = await startSession(questionTurn());
    const { turnId } = await session.sendTurn({ text: 'ask me' });
    const opened = await events.waitForType('request.opened');
    expect(opened).toEqual({
      type: 'request.opened',
      requestId: 'req-q',
      kind: 'question',
      summary: 'Database: Which database?',
      turnId,
      questions: [
        { id: 'q0', header: 'Database', question: 'Which database?', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'embedded' }], multiSelect: false, allowCustom: true },
        { id: 'q1', header: 'Extras', question: 'Which extras?', options: [{ label: 'Cache', description: 'redis' }, { label: 'Queue', description: 'jobs' }], multiSelect: true, allowCustom: true },
      ],
    });
    await session.respond('req-q', { decision: 'answer', answers: { q0: ['SQLite'], q1: ['Cache', 'Queue'] }, text: 'free words' });
    await events.waitForTerminal(turnId);
    const [answer] = receivedResponses(setup.logFile);
    expect(answer).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-q',
        response: {
          behavior: 'allow',
          updatedInput: { ...QUESTION_INPUT, answers: { 'Which database?': 'SQLite', 'Which extras?': 'Cache, Queue' }, response: 'free words' },
          toolUseID: 'tool-q',
        },
      },
    });
    // The host closes an answered request itself: the plugin emits no request.closed for it.
    expect(events.of('request.closed')).toHaveLength(0);
  });

  it('answers a declined or cancelled question with a deny', async () => {
    for (const decision of ['decline', 'cancel'] as const) {
      const { setup, session, events } = await startSession(questionTurn());
      const { turnId } = await session.sendTurn({ text: 'ask me' });
      await events.waitForType('request.opened');
      await session.respond('req-q', { decision });
      await events.waitForTerminal(turnId);
      const body = receivedResponses(setup.logFile)[0]!.response.response;
      expect(body).toMatchObject({ behavior: 'deny', toolUseID: 'tool-q' });
      expect(body.message).toEqual(expect.any(String));
      await setup.cleanup();
    }
  });

  it('rejects a response for a request that is not open, and answers each request once', async () => {
    const { setup, session, events } = await startSession(questionTurn());
    const { turnId } = await session.sendTurn({ text: 'ask me' });
    await events.waitForType('request.opened');
    // The answer would reach nobody, so it must not look delivered.
    await expect(session.respond('unknown', { decision: 'decline' })).rejects.toBeInstanceOf(RequestNotPendingError);
    await expect(session.respond('unknown', { decision: 'decline' })).rejects.toMatchObject({ code: 'request_not_pending', requestId: 'unknown' });
    await session.respond('req-q', { decision: 'decline' });
    await expect(session.respond('req-q', { decision: 'answer', answers: { q0: ['Postgres'] } })).rejects.toBeInstanceOf(RequestNotPendingError);
    await events.waitForTerminal(turnId);
    expect(receivedResponses(setup.logFile)).toHaveLength(1);
  });

  it('opens a permission request for any other tool and answers allow or deny', async () => {
    for (const [decision, behavior] of [['answer', 'allow'], ['decline', 'deny']] as const) {
      const input = { command: 'rm -rf build/' };
      const { setup, session, events } = await startSession({ turns: [{ steps: [{ request: { request_id: 'req-b', request: canUseTool('Bash', input, 'tool-b', { display_name: 'Run shell command', description: 'remove build' }) } }, assistantText('ok')] }] });
      const { turnId } = await session.sendTurn({ text: 'go' });
      const opened = await events.waitForType('request.opened');
      expect(opened).toMatchObject({ requestId: 'req-b', kind: 'permission', summary: 'Run shell command: rm -rf build/', turnId });
      expect(opened.questions).toBeUndefined();
      await session.respond('req-b', decision === 'answer' ? { decision: 'answer', answers: {} } : { decision: 'decline' });
      await events.waitForTerminal(turnId);
      const body = receivedResponses(setup.logFile)[0]!.response.response;
      expect(body.behavior).toBe(behavior);
      if (behavior === 'allow') expect(body).toEqual({ behavior: 'allow', updatedInput: input, toolUseID: 'tool-b' });
      await setup.cleanup();
    }
  });

  it('opens an MCP elicitation as an mcp request and declines or cancels it', async () => {
    const elicitation = { subtype: 'elicitation', mcp_server_name: 'forms', message: 'Fill in the form', mode: 'form', requested_schema: { type: 'object', properties: {} } };
    for (const [decision, action] of [['decline', 'decline'], ['cancel', 'cancel'], ['answer', 'decline']] as const) {
      const { setup, session, events } = await startSession({ turns: [{ steps: [{ request: { request_id: 'req-e', request: elicitation } }, assistantText('ok')] }] });
      const { turnId } = await session.sendTurn({ text: 'go' });
      const opened = await events.waitForType('request.opened');
      expect(opened).toMatchObject({ requestId: 'req-e', kind: 'mcp', summary: 'forms: Fill in the form', turnId });
      await session.respond('req-e', decision === 'answer' ? { decision: 'answer', answers: {} } : { decision });
      await events.waitForTerminal(turnId);
      expect(receivedResponses(setup.logFile)[0]).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'req-e', response: { action } } });
      await setup.cleanup();
    }
  });

  it('closes a request as cancelled when the CLI withdraws it', async () => {
    const { session, events } = await startSession({
      turns: [
        {
          steps: [
            { emit: { type: 'control_request', request_id: 'req-w', request: canUseTool('AskUserQuestion', QUESTION_INPUT, 'tool-w') } },
            { sleep: 60 },
            { emit: { type: 'control_cancel_request', request_id: 'req-w' } },
            { sleep: 60 },
            assistantText('moved on'),
          ],
        },
      ],
    });
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForTerminal(turnId);
    expect(events.of('request.closed')).toEqual([{ type: 'request.closed', requestId: 'req-w', outcome: 'cancelled' }]);
    // A response after the withdrawal reaches nobody, and says so.
    await expect(session.respond('req-w', { decision: 'decline' })).rejects.toBeInstanceOf(RequestNotPendingError);
  });

  it('closes a request as cancelled when its turn ends first', async () => {
    const { session, events } = await startSession(questionTurn());
    const { turnId } = await session.sendTurn({ text: 'ask me' });
    await events.waitForType('request.opened');
    await session.interrupt(turnId);
    await events.waitForTerminal(turnId);
    const closedAt = events.indexOf((event) => event.type === 'request.closed');
    expect(events.events[closedAt]).toEqual({ type: 'request.closed', requestId: 'req-q', outcome: 'cancelled' });
    expect(closedAt).toBeLessThan(events.indexOf((event) => event.type === 'turn.terminal'));
  });

  it('denies open requests when the session closes, so the blocked turn can end', async () => {
    const { setup, session, events } = await startSession(questionTurn());
    await session.sendTurn({ text: 'ask me' });
    await events.waitForType('request.opened');
    await session.close('release');
    await events.done;
    expect(receivedResponses(setup.logFile)[0]!.response.response).toMatchObject({ behavior: 'deny', toolUseID: 'tool-q' });
    expect(events.of('request.closed')).toEqual([{ type: 'request.closed', requestId: 'req-q', outcome: 'cancelled' }]);
  });

  it('answers an unknown control subtype from the CLI with an error response', async () => {
    const { setup, session, events } = await startSession({
      turns: [{ steps: [{ emit: { type: 'control_request', request_id: 'req-u', request: { subtype: 'hook_callback', callback_id: 'x' } } }, { sleep: 80 }, assistantText('ok')] }],
    });
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForTerminal(turnId);
    expect(receivedResponses(setup.logFile)).toEqual([{ type: 'control_response', response: { subtype: 'error', request_id: 'req-u', error: 'Unsupported control request: hook_callback' } }]);
    expect(events.of('request.opened')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('failures', () => {
  const resetsAt = 1_900_000_000;
  const failingTurn = (steps: Array<Record<string, unknown>>): Scenario => ({ turns: [{ steps }] });

  async function terminalOf(scenario: Scenario): Promise<Extract<TransportEvent, { type: 'turn.terminal' }>> {
    const { session, events } = await startSession(scenario);
    const { turnId } = await session.sendTurn({ text: 'go' });
    return events.waitForTerminal(turnId);
  }

  it('maps a 429 with a rejected rate limit to usage_limit with the reset time', async () => {
    const terminal = await terminalOf(
      failingTurn([
        rateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt, utilization: 1 }),
        { assistant: { text: 'You have hit your limit', error: 'rate_limit', apiErrorParams: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } } } },
        { result: { is_error: true, terminal_reason: 'api_error', api_error_status: 429, result: 'API Error: 429 rate limit' } },
      ]),
    );
    expect(terminal.status).toBe('failed');
    expect(terminal.failure).toMatchObject({ class: 'usage_limit', code: 'api_error_429', retryable: false, resetAt: new Date(resetsAt * 1000).toISOString() });
    expect(terminal.sessionUsable).toBe(true);
  });

  it('maps a 429 without any rate-limit evidence to usage_limit without a reset time', async () => {
    const terminal = await terminalOf(failingTurn([{ result: { is_error: true, terminal_reason: 'api_error', api_error_status: 429, result: 'API Error: 429' } }]));
    expect(terminal.failure?.class).toBe('usage_limit');
    expect(terminal.failure).not.toHaveProperty('resetAt');
  });

  it('maps 529 to server_overloaded and 5xx to server_unavailable, both retryable provider errors', async () => {
    const overloaded = await terminalOf(failingTurn([{ result: { is_error: true, terminal_reason: 'api_error', api_error_status: 529, result: 'overloaded_error' } }]));
    expect(overloaded.failure).toMatchObject({ class: 'provider_error', code: 'server_overloaded', retryable: true });
    for (const status of [500, 502, 503, 504]) {
      const terminal = await terminalOf(failingTurn([{ result: { is_error: true, terminal_reason: 'api_error', api_error_status: status, result: `API Error: ${status}` } }]));
      expect(terminal.failure, String(status)).toMatchObject({ class: 'provider_error', code: 'server_unavailable', retryable: true });
    }
  });

  it('maps an authentication failure to permission_error', async () => {
    const terminal = await terminalOf(
      failingTurn([{ assistant: { text: 'Not logged in', error: 'authentication_failed' } }, { result: { is_error: true, terminal_reason: 'api_error', api_error_status: null, result: 'Not logged in · Please run /login' } }]),
    );
    expect(terminal.failure).toMatchObject({ class: 'permission_error', code: 'authentication_failed', retryable: false, message: expect.stringContaining('Not logged in') });
    // The CLI's own error message is evidence, never agent output.
  });

  it('maps max-turns and budget results to validation_error', async () => {
    const turns = await terminalOf(failingTurn([{ result: { subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', errors: ['Reached the maximum number of turns (3)'] } }]));
    expect(turns.failure).toMatchObject({ class: 'validation_error', code: 'error_max_turns' });
    const budget = await terminalOf(failingTurn([{ result: { subtype: 'error_max_budget_usd', is_error: true, errors: ['Budget exceeded'] } }]));
    expect(budget.failure).toMatchObject({ class: 'validation_error', code: 'error_max_budget_usd' });
  });

  it('keeps the session usable after a failed turn and runs the next one', async () => {
    const { session, events } = await startSession({ turns: [{ steps: [{ result: { is_error: true, terminal_reason: 'api_error', api_error_status: 529, result: 'overloaded' } }] }] });
    const first = await session.sendTurn({ text: 'one' });
    expect((await events.waitForTerminal(first.turnId)).status).toBe('failed');
    const second = await session.sendTurn({ text: 'two' });
    expect((await events.waitForTerminal(second.turnId)).status).toBe('completed');
  });

  it('reports api_retry as a warning notice', async () => {
    const { session, events } = await startSession(
      failingTurn([
        { emit: { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 1000, error_status: 529, error: 'server_error', uuid: 'eeeeeeee-0000-4000-8000-000000000001', session_id: '{{sessionId}}' } },
        { result: { is_error: true, terminal_reason: 'api_error', api_error_status: null, result: 'connection reset' } },
      ]),
    );
    const { turnId } = await session.sendTurn({ text: 'go' });
    const terminal = await events.waitForTerminal(turnId);
    expect(events.of('notice').find((event) => /retrying \(attempt 2 of 10\)/.test(event.text))?.level).toBe('warn');
    // No HTTP status on the result and a retry before it: a transport error, which RunRecovery treats as retryable.
    expect(terminal.failure?.class).toBe('provider_error');
  });

  it('treats a result with no status after retries without a status as a transport error', async () => {
    const { session, events } = await startSession(
      failingTurn([
        { emit: { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown', uuid: 'eeeeeeee-0000-4000-8000-000000000002', session_id: '{{sessionId}}' } },
        { result: { is_error: true, terminal_reason: 'api_error', api_error_status: null, result: 'fetch failed' } },
      ]),
    );
    const { turnId } = await session.sendTurn({ text: 'go' });
    const terminal = await events.waitForTerminal(turnId);
    expect(terminal.failure).toMatchObject({ class: 'transport_error', retryable: true });
  });

  it('maps compaction, permission-denied and informational frames to notices', async () => {
    const frame = (subtype: string, extra: Record<string, unknown>): Record<string, unknown> => ({ emit: { type: 'system', subtype, uuid: `eeeeeeee-0000-4000-8000-0000000000${subtype.length}`, session_id: '{{sessionId}}', ...extra } });
    const { session, events } = await startSession(
      failingTurn([
        frame('status', { status: 'compacting' }),
        frame('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 150000 } }),
        frame('permission_denied', { tool_name: 'Bash', tool_use_id: 't1', decision_reason: 'blocked by rule' }),
        frame('informational', { content: 'Working directory was deleted', level: 'warning' }),
        assistantText('ok'),
      ]),
    );
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForTerminal(turnId);
    const notices = events.of('notice').map((event) => [event.level, event.text]);
    expect(notices).toEqual([
      ['info', 'Claude is compacting the conversation.'],
      ['info', 'Claude compacted the conversation (150000 tokens before).'],
      ['warn', 'Claude was not allowed to use Bash: blocked by rule'],
      ['warn', 'Working directory was deleted'],
    ]);
  });

  it('reports an MCP server that failed to start', async () => {
    const { session, events } = await startSession({ mcpServers: [{ name: 'broken', status: 'failed' }, { name: 'fine', status: 'connected' }] });
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForTerminal(turnId);
    expect(events.of('notice').map((event) => event.text)).toEqual(['MCP server "broken" failed to start.']);
  });
});

describe('classifyResult', () => {
  const base: ClaudeResultFrame = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'ok' };
  const classify = (overrides: Partial<ClaudeResultFrame>, evidence = newTurnEvidence(), interruptRequested = false) =>
    classifyResult({ ...base, ...overrides }, evidence, { interruptRequested, nowMs: Date.parse('2026-10-26T12:00:00Z') });

  it('completes a clean result', () => {
    expect(classify({})).toEqual({ status: 'completed' });
  });

  it('lets an aborted terminal reason win over a success subtype', () => {
    expect(classify({ terminal_reason: 'aborted_streaming' }).status).toBe('interrupted');
    expect(classify({ terminal_reason: 'aborted_tools', is_error: true }).status).toBe('interrupted');
    expect(classify({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming', is_error: true }).status).toBe('interrupted');
  });

  it('treats a requested interrupt as an interrupt even when the turn finished', () => {
    expect(classify({}, newTurnEvidence(), true)).toEqual({ status: 'interrupted' });
  });

  it('classifies error subtypes by their text when they name an interrupt or cancel', () => {
    expect(classify({ subtype: 'error_during_execution', is_error: true, errors: ['Request interrupted by user'] }).status).toBe('interrupted');
    expect(classify({ subtype: 'error_during_execution', is_error: true, errors: ['cancelled'] }).status).toBe('interrupted');
    expect(classify({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] })).toMatchObject({ status: 'failed', failure: { class: 'provider_error', code: 'error_during_execution' } });
  });

  it('maps usage limits with the latest reset among blocked limits, or none when one is unknown', () => {
    const evidence = newTurnEvidence(new Map([['five_hour', '2026-10-26T15:00:00.000Z'], ['seven_day', '2026-10-30T00:00:00.000Z']]));
    expect(classify({ is_error: true, terminal_reason: 'api_error', api_error_status: 429 }, evidence).failure).toMatchObject({ class: 'usage_limit', resetAt: '2026-10-30T00:00:00.000Z' });
    const unknown = newTurnEvidence(new Map([['five_hour', '2026-10-26T15:00:00.000Z'], ['seven_day', null]]));
    expect(classify({ is_error: true, terminal_reason: 'api_error', api_error_status: 429 }, unknown).failure).not.toHaveProperty('resetAt');
  });

  it('treats a blocked limit with no HTTP status as a usage limit, but not when authentication failed', () => {
    const blocked = newTurnEvidence(new Map([['five_hour', '2026-10-26T15:00:00.000Z']]));
    expect(classify({ is_error: true, terminal_reason: 'api_error', api_error_status: null }, blocked).failure?.class).toBe('usage_limit');
    blocked.authenticationFailed = true;
    expect(classify({ is_error: true, terminal_reason: 'api_error', api_error_status: null }, blocked).failure?.class).toBe('permission_error');
  });

  it('uses the reset time of a blocked assistant frame', () => {
    const evidence = newTurnEvidence();
    evidence.assistantRateLimit = assistantRateLimitEvidence({ rateLimitType: 'seven_day', resetsAt: 1_900_000_000 });
    expect(classify({ is_error: true, terminal_reason: 'api_error', api_error_status: 429 }, evidence).failure).toMatchObject({ class: 'usage_limit', resetAt: new Date(1_900_000_000_000).toISOString() });
  });

  it('reads the reset time from a gateway 503 that embeds a 429', () => {
    const result = 'API Error: 503 [gw-1] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}} (reset after 1h 2m 3s)';
    const classified = classify({ is_error: true, terminal_reason: 'api_error', api_error_status: 503, result });
    expect(classified.failure).toMatchObject({ class: 'usage_limit', resetAt: new Date(Date.parse('2026-10-26T12:00:00Z') + (3600 + 120 + 3) * 1000).toISOString() });
  });

  it('maps overloaded text with no status to server_overloaded and 403 to a permission error', () => {
    expect(classify({ is_error: true, terminal_reason: 'api_error', result: 'The server is overloaded' }).failure).toMatchObject({ code: 'server_overloaded', retryable: true });
    expect(classify({ is_error: true, terminal_reason: 'api_error', api_error_status: 403, result: 'forbidden' }).failure).toMatchObject({ class: 'permission_error', code: 'api_error_403' });
    expect(classify({ is_error: true, terminal_reason: 'api_error', api_error_status: 401, result: 'unauthorized' }).failure).toMatchObject({ class: 'permission_error' });
  });

  it('maps context and budget terminal reasons to validation errors', () => {
    for (const reason of ['prompt_too_long', 'image_error', 'budget_exhausted']) {
      expect(classify({ is_error: true, terminal_reason: reason }).failure, reason).toMatchObject({ class: 'validation_error', code: reason });
    }
    expect(classify({ is_error: true, terminal_reason: 'model_error' }).failure?.class).toBe('provider_error');
  });

  it('redacts credentials from failure messages', () => {
    const failure = classify({ is_error: true, terminal_reason: 'api_error', api_error_status: 500, result: 'failed with Bearer abcdefghijklmnop12345 token' }).failure!;
    expect(failure.message).not.toContain('abcdefghijklmnop12345');
  });

  it('classifies api_retry frames', () => {
    expect(failureFromApiRetry({ error_status: 429, error: 'rate_limit' })).toMatchObject({ class: 'usage_limit', code: 'api_error_429', retryable: true });
    expect(failureFromApiRetry({ error_status: null, error: 'unknown' })).toMatchObject({ class: 'transport_error', retryable: true });
    expect(failureFromApiRetry({ error_status: 529, error: 'server_error' })).toMatchObject({ class: 'provider_error', code: 'api_error_529' });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('rate limits and usage', () => {
  it('turns rate_limit_event frames into usage windows per limit type, once per change', async () => {
    const reset = 1_900_000_000;
    const { session, events } = await startSession({
      turns: [
        {
          steps: [
            rateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: reset }),
            rateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: reset }),
            rateLimitEvent({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: reset + 86400 }),
            rateLimitEvent({ status: 'allowed', rateLimitType: 'overage', utilization: 0.1 }),
            assistantText('ok'),
          ],
        },
      ],
    });
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForTerminal(turnId);
    const windows = events.of('usage.updated').filter((event) => event.windows);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.windows).toEqual([{ id: 'five_hour', usedPercent: 42, resetsAt: new Date(reset * 1000).toISOString() }]);
    expect(windows[1]!.windows).toEqual([
      { id: 'five_hour', usedPercent: 42, resetsAt: new Date(reset * 1000).toISOString() },
      { id: 'seven_day', usedPercent: 90, resetsAt: new Date((reset + 86400) * 1000).toISOString() },
    ]);
  });

  it('marks a blocked limit exhausted, announces it once per reset time, and clears it when allowed again', () => {
    const tracker = new ClaudeRateLimitTracker();
    const reset = 1_900_000_000;
    const first = tracker.apply({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset });
    expect(first.windows).toEqual([{ id: 'five_hour', usedPercent: 100, resetsAt: new Date(reset * 1000).toISOString() }]);
    expect(first.announce).toContain('5-hour usage limit reached');
    const again = tracker.apply({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset });
    expect(again.announce).toBeUndefined();
    expect(again.changed).toBe(false);
    expect([...tracker.blocked()]).toEqual([['five_hour', new Date(reset * 1000).toISOString()]]);
    const overage = tracker.apply({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset + 5, overageStatus: 'allowed' });
    expect(overage.announce).toBeUndefined();
    expect(tracker.blocked().size).toBe(0);
    const cleared = tracker.apply({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.05, resetsAt: reset + 18000 });
    expect(cleared.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 5 });
  });

  it('warns once when the account is blocked', async () => {
    const reset = 1_900_000_000;
    const { session, events } = await startSession({ turns: [{ steps: [rateLimitEvent({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: reset }), rateLimitEvent({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: reset }), assistantText('x')] }] });
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForTerminal(turnId);
    expect(events.of('notice').filter((event) => /weekly usage limit reached/.test(event.text))).toHaveLength(1);
  });

  it('computes context numbers from results and usage replies', () => {
    expect(contextMaxFromModelUsage({ 'claude-a': { contextWindow: 200000 }, 'claude-b': { contextWindow: 1000000 } })).toBe(1000000);
    expect(contextMaxFromModelUsage({ 'claude-a': { contextWindow: 200000 }, 'claude-b': { contextWindow: 1000000 } }, 'claude-a')).toBe(200000);
    expect(contextMaxFromModelUsage({}, 'x')).toBeUndefined();
    expect(contextUsedFromResultUsage({ iterations: [{ input_tokens: 1, output_tokens: 1 }, { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 }] })).toBe(112);
    expect(contextUsedFromResultUsage({ input_tokens: 999 })).toBeUndefined();
    expect(contextFromUsageResponse({ totalTokens: 5, maxTokens: 150, rawMaxTokens: 200 })).toEqual({ used: 5, max: 200 });
    expect(contextFromUsageResponse(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('process lifetime', () => {
  it('ends the turn as a transport error and the session as error then stopped when the process exits mid-turn', async () => {
    const { session, events } = await startSession({ turns: [{ steps: [assistantText('working'), { sleep: 30 }, { exit: 3 }] }] });
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.done;
    const types = events.types();
    expect(types.slice(-4)).toEqual(['item.completed', 'turn.terminal', 'session.state', 'session.state']);
    const terminal = events.terminalsOf(turnId);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ status: 'failed', sessionUsable: false, failure: { class: 'transport_error', code: 'process_exited', retryable: true, message: 'exit code 3' } });
    expect(events.of('session.state').slice(-2)).toEqual([
      { type: 'session.state', state: 'error', failure: { class: 'transport_error', code: 'process_exited', message: 'exit code 3', retryable: true } },
      { type: 'session.state', state: 'stopped' },
    ]);
    await expect(session.sendTurn({ text: 'again' })).rejects.toBeInstanceOf(NotSentError);
    expect(await session.interrupt(turnId)).toBeUndefined();
  });

  it('kills what the CLI left behind in its process group once it has exited', async () => {
    const { setup, session, events } = await startSession({ grandchild: true, turns: [{ steps: [{ exit: 3 }] }] });
    const grandchild = (await waitUntil(() => readLog(setup.logFile).find((entry) => entry.event === 'grandchild')))!.pid as number;
    expect(processStartTicks(grandchild)).toBeDefined();
    await session.sendTurn({ text: 'go' });
    await events.done;
    await waitUntil(() => processStartTicks(grandchild) === undefined, 3000, 'the grandchild to be killed');
  });

  it('reports an idle process that dies as error then stopped, with no terminal', async () => {
    const { session, events, setup } = await startSession();
    process.kill(session.pid!, 'SIGKILL');
    await events.done;
    expect(events.of('turn.terminal')).toHaveLength(0);
    expect(events.of('session.state').slice(-2).map((event) => event.state)).toEqual(['error', 'stopped']);
    expect(await setup.instance.alive()).toEqual({ connected: false });
  });

  it('unload ends the process cleanly: stopped without an error', async () => {
    const { setup, session, events } = await startSession();
    await session.unload();
    await events.done;
    expect(events.of('session.state').map((event) => event.state)).toEqual(['ready', 'stopped']);
    expect(readLog(setup.logFile).some((entry) => entry.event === 'stdin-eof')).toBe(true);
    await session.close('release'); // idempotent
    expect(await setup.instance.alive()).toEqual({ connected: false });
  });

  it('close lets a running turn finish on end of input, then ends the session', async () => {
    const { session, events } = await startSession({ turns: [{ steps: [{ sleep: 120 }, assistantText('finished')] }] });
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForType('turn.started');
    await session.close('release');
    await events.done;
    expect(events.terminalsOf(turnId)).toEqual([{ type: 'turn.terminal', turnId, status: 'completed', sessionUsable: true, replay: false }]);
    expect(events.of('session.state').some((event) => event.state === 'error')).toBe(false);
  });

  it('escalates to SIGTERM when the process ignores end of input and ends the running turn interrupted', async () => {
    const { setup, session, events } = await startSession({ ignoreStdinEof: true, turns: [{ steps: [{ hold: true }] }] });
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForType('turn.started');
    await session.close('release');
    await events.done;
    expect(readLog(setup.logFile).some((entry) => entry.event === 'sigterm')).toBe(true);
    expect(events.terminalsOf(turnId)).toEqual([{ type: 'turn.terminal', turnId, status: 'interrupted', sessionUsable: false, replay: false }]);
    expect(events.of('session.state').some((event) => event.state === 'error')).toBe(false);
  });

  it('kills a process that ignores both end of input and SIGTERM', async () => {
    const { session, events } = await startSession({ ignoreStdinEof: true, ignoreSigterm: true });
    const pid = session.pid!;
    await session.close('release');
    await events.done;
    await waitUntil(() => processStartTicks(pid) === undefined, 3000, 'the process to be gone');
  });

  it('close with reason error does not hang and leaves nothing running', async () => {
    const { session, events } = await startSession();
    const pid = session.pid!;
    await session.close('error');
    await events.done;
    expect(processStartTicks(pid)).toBeUndefined();
  });

  it('dispose detaches every session and ends their event streams', async () => {
    const setup = setupFake({});
    const a = setup.track(await setup.instance.start(setup.open({ conversationId: 'a' })));
    const b = setup.track(await setup.instance.start(setup.open({ conversationId: 'b' })));
    const logs = [new EventLog(a), new EventLog(b)];
    expect(setup.instance.openSessionIds).toHaveLength(2);
    await setup.instance.dispose('shutdown');
    await Promise.all(logs.map((log) => log.done));
    expect(logs.map((log) => log.events.at(-1))).toEqual([{ type: 'session.state', state: 'stopped' }, { type: 'session.state', state: 'stopped' }]);
    await expect(setup.instance.start(setup.open())).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it('reports a live process through alive()', async () => {
    const { setup, session } = await startSession();
    expect(await setup.instance.alive()).toEqual({ pid: session.pid, connected: true });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('resume', () => {
  const sessionId = '12345678-1234-4234-8234-123456789abc';

  it('resumes by id when the transcript holds a conversation, and reports its path', async () => {
    const setup = setupFake({ sessionStartHook: false });
    const transcript = writeTranscript(setup.configDir, setup.cwd, sessionId);
    const session = setup.track(await setup.instance.resume(sessionId, setup.open({ model: 'sonnet' })));
    const events = new EventLog(session);
    expect(session.nativeSessionId).toBe(sessionId);
    const argv = startEntries(setup.logFile)[0]!.argv!;
    expect(argv).toEqual(expect.arrayContaining(['--resume', sessionId]));
    expect(argv).not.toContain('--session-id');
    await waitUntil(() => events.events.length >= 1);
    expect(events.events[0]).toEqual({ type: 'session.native', nativeSessionId: sessionId, transcriptPath: transcript });
    expect(session.transcriptPath).toBe(transcript);
  });

  it('starts the id again when it has no transcript (the first prompt never reached the model): a new launch under the same id, and a notice that it has no history', async () => {
    const setup = setupFake({ sessionStartHook: false });
    const session = setup.track(await setup.instance.resume(sessionId, setup.open()));
    const events = new EventLog(session);
    const [entry] = startEntries(setup.logFile);
    expect(entry!.argv).toEqual(expect.arrayContaining(['--session-id', sessionId]));
    expect(entry!.argv).not.toContain('--resume');
    expect(session.nativeSessionId).toBe(sessionId);
    expect((await events.waitForType('notice')).text).toMatch(/no saved conversation/);
    // It is a working conversation, and a restart finds its process the usual way.
    const { turnId } = await session.sendTurn({ text: 'first words' });
    expect((await events.waitForTerminal(turnId)).status).toBe('completed');
    expect(JSON.parse(setup.context.metaStore.get('claude-launch:conversation-1')!).argv).toEqual(expect.arrayContaining(['--session-id', sessionId]));
  });

  it('starts the id again when the transcript holds no conversation either', async () => {
    const setup = setupFake({ sessionStartHook: false });
    writeTranscript(setup.configDir, setup.cwd, sessionId, false);
    const session = setup.track(await setup.instance.resume(sessionId, setup.open()));
    expect(startEntries(setup.logFile)[0]!.argv).toEqual(expect.arrayContaining(['--session-id', sessionId]));
    expect(session.nativeSessionId).toBe(sessionId);
  });

  it('does not start a conversation over that completed a turn and has lost its transcript: it fails with a clear reason and starts nothing', async () => {
    const setup = setupFake({ sessionStartHook: false });
    const session = setup.track(await setup.instance.resume(sessionId, setup.open())); // never ran a turn: started under its own id
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'first words' });
    expect((await events.waitForTerminal(turnId)).status).toBe('completed');
    expect(JSON.parse(setup.context.metaStore.get('claude-turns:conversation-1')!)).toMatchObject({ sessionId });

    // Idle sleep: the process ends and its launch record goes with it. The record of the completed turn stays.
    await session.unload();
    await waitUntil(() => session.isEnded);
    expect(setup.context.metaStore.has('claude-launch:conversation-1')).toBe(false);
    expect(setup.context.metaStore.has('claude-turns:conversation-1')).toBe(true);

    // The CLI removed the transcript (the fake never wrote one): starting over would drop the history without a word.
    const starts = startEntries(setup.logFile).length;
    const error = await setup.instance.resume(sessionId, setup.open()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResumeFailedError);
    expect((error as Error).message).toMatch(/is gone/);
    expect(startEntries(setup.logFile)).toHaveLength(starts);
  });

  it('does not start a conversation over that was recorded as having history without a turn completing here (a row moved over from tmux): once its transcript is gone it fails, and starts nothing', async () => {
    const setup = setupFake({ sessionStartHook: false });
    const transcript = writeTranscript(setup.configDir, setup.cwd, sessionId);
    // The host knows the conversation has history because it moved the row over; no turn ever completed in this plugin.
    expect(setup.context.metaStore.has('claude-turns:conversation-1')).toBe(false);
    setup.instance.noteConversationHistory('conversation-1', sessionId);
    expect(JSON.parse(setup.context.metaStore.get('claude-turns:conversation-1')!)).toMatchObject({ sessionId });

    const session = setup.track(await setup.instance.resume(sessionId, setup.open()));
    expect(startEntries(setup.logFile)[0]!.argv).toEqual(expect.arrayContaining(['--resume', sessionId]));
    await session.unload();
    await waitUntil(() => session.isEnded);

    // The CLI deletes transcripts older than its retention: without the record this chat would be launched empty under its id.
    fs.rmSync(transcript);
    const starts = startEntries(setup.logFile).length;
    const error = await setup.instance.resume(sessionId, setup.open()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResumeFailedError);
    expect((error as Error).message).toMatch(/is gone/);
    expect(startEntries(setup.logFile)).toHaveLength(starts);
  });

  it('records the history once: a second call, at every boot, keeps the first record', async () => {
    const setup = setupFake({ sessionStartHook: false });
    setup.instance.noteConversationHistory('conversation-1', sessionId);
    const first = setup.context.metaStore.get('claude-turns:conversation-1');
    await sleep(5);
    setup.instance.noteConversationHistory('conversation-1', sessionId);
    expect(setup.context.metaStore.get('claude-turns:conversation-1')).toBe(first);
    // A record that names another native id is replaced: the conversation was restarted under a new one.
    setup.instance.noteConversationHistory('conversation-1', 'another-session');
    expect(JSON.parse(setup.context.metaStore.get('claude-turns:conversation-1')!)).toMatchObject({ sessionId: 'another-session' });
  });

  it('starts over a conversation whose record of completed turns names another session', async () => {
    const setup = setupFake({ sessionStartHook: false });
    // A record for a different native id (the conversation was restarted under a new one) says nothing about this id.
    setup.context.metaStore.set('claude-turns:conversation-1', JSON.stringify({ sessionId: 'another-session' }));
    const session = setup.track(await setup.instance.resume(sessionId, setup.open()));
    expect(startEntries(setup.logFile)[0]!.argv).toEqual(expect.arrayContaining(['--session-id', sessionId]));
    expect(session.nativeSessionId).toBe(sessionId);
  });

  it('does not start a missing conversation over a process that holds the id', async () => {
    const setup = setupFake({ sessionStartHook: false });
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'claude-holder'], { stdio: 'ignore' });
    try {
      await waitUntil(() => holder.pid !== undefined && processStartTicks(holder.pid) !== undefined);
      writeRegistryFile(setup.configDir, { pid: holder.pid!, sessionId, procStart: processStartTicks(holder.pid!) });
      await expect(setup.instance.resume(sessionId, setup.open())).rejects.toBeInstanceOf(ClaudeSessionHeldError);
      expect(startEntries(setup.logFile)).toHaveLength(0);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('finds a transcript under any project directory, as the CLI does', async () => {
    const setup = setupFake();
    const other = path.join(setup.dir, 'elsewhere');
    fs.mkdirSync(other);
    const transcript = writeTranscript(setup.configDir, other, sessionId);
    const session = setup.track(await setup.instance.resume(sessionId, setup.open()));
    expect(session.transcriptPath).toBe(transcript);
  });

  describe('one writer', () => {
    let holder: ChildProcess | undefined;
    afterEach(() => {
      holder?.kill('SIGKILL');
      holder = undefined;
    });

    // A long-lived process whose command line names claude, standing in for another Claude process.
    async function startHolder(): Promise<number> {
      holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'claude-holder'], { stdio: 'ignore' });
      await waitUntil(() => holder!.pid !== undefined && processStartTicks(holder!.pid) !== undefined);
      return holder.pid!;
    }

    it('refuses to resume a session another live process holds, naming the pid', async () => {
      const setup = setupFake();
      writeTranscript(setup.configDir, setup.cwd, sessionId);
      const pid = await startHolder();
      writeRegistryFile(setup.configDir, { pid, sessionId, procStart: processStartTicks(pid) });
      const error = await setup.instance.resume(sessionId, setup.open()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ClaudeSessionHeldError);
      expect(error).toBeInstanceOf(ResumeFailedError);
      expect((error as ClaudeSessionHeldError).heldByPid).toBe(pid);
      expect((error as ClaudeSessionHeldError).message).toContain(String(pid));
      expect(startEntries(setup.logFile)).toHaveLength(0);
    });

    it('refuses a start that reuses the id of a held session', async () => {
      const setup = setupFake();
      const pid = await startHolder();
      writeRegistryFile(setup.configDir, { pid, sessionId });
      await expect(setup.instance.start(setup.open({ sessionId }))).rejects.toBeInstanceOf(ClaudeSessionHeldError);
    });

    it('ignores a registry file whose pid now belongs to another process or no longer exists', async () => {
      const setup = setupFake({ sessionStartHook: false });
      writeTranscript(setup.configDir, setup.cwd, sessionId);
      const pid = await startHolder();
      // Same pid, different start time: the process that wrote the file is gone.
      writeRegistryFile(setup.configDir, { pid, sessionId, procStart: String(Number(processStartTicks(pid)) + 1) });
      expect(findSessionHolder(setup.configDir, sessionId)).toBeUndefined();
      holder!.kill('SIGKILL');
      await waitUntil(() => processStartTicks(pid) === undefined, 3000, 'the holder to exit');
      writeRegistryFile(setup.configDir, { pid, sessionId });
      expect(findSessionHolder(setup.configDir, sessionId)).toBeUndefined();
      setup.track(await setup.instance.resume(sessionId, setup.open()));
    });

    it('without a procStart, a registry pid counts only when the process looks like claude', async () => {
      const setup = setupFake();
      writeRegistryFile(setup.configDir, { pid: process.pid, sessionId });
      expect(findSessionHolder(setup.configDir, sessionId)).toBeUndefined(); // this test process is not claude
      const pid = await startHolder();
      writeRegistryFile(setup.configDir, { pid, sessionId });
      expect(findSessionHolder(setup.configDir, sessionId)).toMatchObject({ pid });
    });

    it('refuses a second launch of a session while the first is still starting', async () => {
      const setup = setupFake({ sessionStartHook: false, initializeDelayMs: 200 });
      writeTranscript(setup.configDir, setup.cwd, sessionId);
      const first = setup.instance.resume(sessionId, setup.open());
      await waitUntil(() => startEntries(setup.logFile).length === 1);
      await expect(setup.instance.resume(sessionId, setup.open())).rejects.toBeInstanceOf(ClaudeSessionHeldError);
      setup.track(await first);
    });

    it('refuses to open the same session twice in one instance', async () => {
      const setup = setupFake({ sessionStartHook: false });
      writeTranscript(setup.configDir, setup.cwd, sessionId);
      const first = setup.track(await setup.instance.resume(sessionId, setup.open()));
      await expect(setup.instance.resume(sessionId, setup.open())).rejects.toBeInstanceOf(ClaudeSessionHeldError);
      await first.close('release');
      await waitUntil(() => setup.instance.openSessionIds.length === 0);
      setup.track(await setup.instance.resume(sessionId, setup.open()));
    });

    it('never starts a process beside a live holder: with no launch on record it is refused; with one, only an attach is tried, and a stale record is dropped', async () => {
      const setup = setupFake({ sessionStartHook: false });
      writeTranscript(setup.configDir, setup.cwd, sessionId);
      const pid = await startHolder();
      writeRegistryFile(setup.configDir, { pid, sessionId, procStart: processStartTicks(pid) });
      const unknownError = await setup.instance.resume(sessionId, setup.open()).catch((caught: unknown) => caught);
      expect(unknownError).toBeInstanceOf(ClaudeSessionHeldError);
      expect(startEntries(setup.logFile)).toHaveLength(0);

      // A launch on record names a process that no longer runs anywhere (a reboot, or it ended while no backend looked),
      // and a plain stdio factory has nothing to attach to. The holder is somebody else's process: the answer is "held",
      // and no process is started beside it, not even a throwaway one.
      setup.context.metaStore.set('claude-launch:conversation-1', JSON.stringify({ sessionId, argv: [process.execPath, FAKE_CLAUDE, setup.scenarioPath, '--session-id', sessionId] }));
      const error = await setup.instance.resume(sessionId, setup.open()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ClaudeSessionHeldError);
      expect((error as ClaudeSessionHeldError).heldByPid).toBe(pid);
      expect(startEntries(setup.logFile)).toHaveLength(0);
      expect(setup.context.metaStore.has('claude-launch:conversation-1')).toBe(false); // the launch it named is gone: nothing runs for it
    });
  });

  it('reports the CLI own refusal when the resume fails at startup', async () => {
    const setup = setupFake({ startupFailure: { errors: [`No conversation found with session ID: ${sessionId}`], exitCode: 1 } });
    writeTranscript(setup.configDir, setup.cwd, sessionId);
    const error = await setup.instance.resume(sessionId, setup.open()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResumeFailedError);
    expect((error as Error).message).toContain('No conversation found');
  });

  it('reports a failed startup of a new session as unavailable, with the CLI reason', async () => {
    const setup = setupFake({ startupFailure: { errors: ['Running as root is not allowed'], reason: 'bypass_root', exitCode: 1 } });
    const error = await setup.instance.start(setup.open()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportUnavailableError);
    expect((error as Error).message).toMatch(/bypass_root.*Running as root/);
  });

  it('records the launch command line so a later backend can find the process again, and forgets it when the process ends', async () => {
    const setup = setupFake({ sessionStartHook: false });
    const session = setup.track(await setup.instance.start(setup.open()));
    const stored = JSON.parse(setup.context.metaStore.get('claude-launch:conversation-1')!);
    expect(stored.sessionId).toBe(session.nativeSessionId);
    expect(stored.argv).toEqual(expect.arrayContaining(['--session-id', session.nativeSessionId]));
    await session.close('release');
    expect(setup.context.metaStore.has('claude-launch:conversation-1')).toBe(false);
  });

  it('keeps the launch record when the instance is disposed, because the process lives on behind its host', async () => {
    const setup = setupFake({ sessionStartHook: false });
    setup.track(await setup.instance.start(setup.open()));
    await setup.instance.dispose('shutdown');
    expect(setup.context.metaStore.has('claude-launch:conversation-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('bare mode and login checks', () => {
  it('fails fast when no SessionStart hook ran and the Console expects its hooks', async () => {
    const setup = setupFake({ sessionStartHook: false }, { context: { coordination: COORDINATION } });
    const pidBefore = startEntries(setup.logFile).length;
    const error = await setup.instance.start(setup.open()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeLaunchRefusedError);
    expect((error as ClaudeLaunchRefusedError).reason).toBe('no_hooks');
    const entries = startEntries(setup.logFile);
    expect(pidBefore).toBe(0);
    await waitUntil(() => processStartTicks(entries[0]!.pid!) === undefined, 3000, 'the refused process to end');
    expect(setup.instance.openSessionIds).toEqual([]);
  });

  it('accepts a launch whose SessionStart hook ran', async () => {
    const setup = setupFake({ sessionStartHook: true }, { context: { coordination: COORDINATION } });
    const session = setup.track(await setup.instance.start(setup.open()));
    expect(session.sawSessionStartHook).toBe(true);
  });

  it('does not require hooks without coordination, or when told not to', async () => {
    const withoutCoordination = setupFake({ sessionStartHook: false });
    withoutCoordination.track(await withoutCoordination.instance.start(withoutCoordination.open()));
    const told = setupFake({ sessionStartHook: false }, { context: { coordination: COORDINATION }, plugin: { requireHooks: false } });
    told.track(await told.instance.start(told.open()));
  });

  it('fails fast when initialize reports an API key instead of the subscription login', async () => {
    const setup = setupFake({ account: { tokenSource: 'ANTHROPIC_API_KEY', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' } });
    const error = await setup.instance.start(setup.open()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeLaunchRefusedError);
    expect((error as ClaudeLaunchRefusedError).reason).toBe('api_key');
    const allowed = setupFake({ account: { apiKeySource: 'ANTHROPIC_API_KEY' } }, { plugin: { requireSubscriptionLogin: false } });
    allowed.track(await allowed.instance.start(allowed.open()));
    const oauth = setupFake({ account: { apiKeySource: 'oauth' } });
    oauth.track(await oauth.instance.start(oauth.open()));
  });

  it('ends the turn and the process when system/init reveals an API key source', async () => {
    const { session, events } = await startSession({ initApiKeySource: 'user', turns: [{ steps: [{ hold: true }] }] });
    const { turnId } = await session.sendTurn({ text: 'go' });
    const terminal = await events.waitForTerminal(turnId);
    expect(terminal).toMatchObject({ status: 'failed', sessionUsable: false, failure: { class: 'permission_error', code: 'api_key_source' } });
    await events.done;
    expect(events.of('turn.terminal')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('transcript path', () => {
  it('computes the path from the config dir and the escaped cwd', async () => {
    const { setup, session } = await startSession();
    expect(session.transcriptPath).toBe(path.join(setup.configDir, 'projects', escapeProjectDir(setup.cwd)!, `${session.nativeSessionId}.jsonl`));
    expect(escapeProjectDir('/home/bryan/my project.v2')).toBe('-home-bryan-my-project-v2');
    expect(escapeProjectDir(`/${'a'.repeat(250)}`)).toBeUndefined();
  });

  it('honors CLAUDE_CONFIG_DIR from the configured environment', async () => {
    const setup = setupFake({}, { config: { env: { CLAUDE_CONFIG_DIR: '~/custom-claude' } } });
    const session = setup.track(await setup.instance.start(setup.open()));
    expect(session.transcriptPath).toBe(path.join(setup.home, 'custom-claude', 'projects', escapeProjectDir(setup.cwd)!, `${session.nativeSessionId}.jsonl`));
  });

  it('takes the path a SessionStart hook prints, and corrects the path once the file is found elsewhere', async () => {
    const hookPath = '/elsewhere/projects/hooked/abc.jsonl';
    const { setup, session, events } = await startSession({ sessionStartHook: true, hookStdout: JSON.stringify({ transcript_path: hookPath }) }, { plugin: { requireHooks: true } });
    expect(session.transcriptPath).toBe(hookPath);
    const natives = (): number => events.of('session.native').length;
    await waitUntil(() => natives() >= 2);
    expect(events.of('session.native')[1]).toMatchObject({ transcriptPath: hookPath });

    // After the first turn the real file is found by scanning the project directories.
    const realFile = path.join(setup.configDir, 'projects', 'some-other-project', `${session.nativeSessionId}.jsonl`);
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    fs.writeFileSync(realFile, `${JSON.stringify({ type: 'user', message: {} })}\n`);
    const { turnId } = await session.sendTurn({ text: 'go' });
    await events.waitForTerminal(turnId);
    await waitUntil(() => session.transcriptPath === realFile, 3000, 'the corrected transcript path');
    expect(events.of('session.native').at(-1)).toEqual({ type: 'session.native', nativeSessionId: session.nativeSessionId, transcriptPath: realFile });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('session over a lost connection', () => {
  it('ends the turn as a transport error and leaves the process, and its launch record, for the next backend', async () => {
    const memory = memoryTransport();
    const client = new StreamJsonClient({ transport: memory.transport });
    const kinds: string[] = [];
    const session = new ClaudeSession({
      sessionId: 's-1',
      cwd: '/work',
      client,
      log: { info: () => undefined, warn: () => undefined },
      timings: DEFAULT_CLAUDE_TIMINGS,
      configDir: '/nonexistent',
      requireSubscriptionLogin: false,
      onEnded: (_ended, kind) => void kinds.push(kind),
    });
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'go' });
    memory.fromCli({ type: 'command_lifecycle', command_uuid: turnId, state: 'started' });
    memory.exit('disconnected');
    await events.done;
    expect(events.terminalsOf(turnId)).toEqual([
      { type: 'turn.terminal', turnId, status: 'failed', failure: { class: 'transport_error', code: 'process_exited', message: 'connection lost', retryable: true }, sessionUsable: false, replay: false },
    ]);
    expect(kinds).toEqual(['detached']);
    expect(memory.closed).toEqual([]);
  });
});

describe('background work', () => {
  // The CLI reports the background tasks of its own process: edge frames (task_started, task_notification, task_updated)
  // and the level frame background_tasks_changed, which carries every live task and replaces what the reader holds.
  function background() {
    const memory = memoryTransport();
    const session = new ClaudeSession({
      sessionId: 's-bg',
      cwd: '/work',
      client: new StreamJsonClient({ transport: memory.transport }),
      log: { info: () => undefined, warn: () => undefined },
      timings: DEFAULT_CLAUDE_TIMINGS,
      configDir: '/nonexistent',
      requireSubscriptionLogin: false,
      onEnded: () => undefined,
    });
    const send = (frame: Record<string, unknown>) => memory.fromCli({ type: 'system', uuid: 'u', session_id: 's-bg', ...frame });
    return { memory, session, send };
  }
  const task = (id: string, extra: Record<string, unknown> = {}) => ({ task_id: id, task_type: 'local_bash', description: id, ...extra });

  it('reports none for a session that has seen no task', () => {
    expect(background().session.hasBackgroundWork()).toBe(false);
  });

  it('is true from a started background task until its notification', () => {
    const { session, send } = background();
    send({ subtype: 'task_started', task_id: 't1', description: 'build', is_backgrounded: true });
    expect(session.hasBackgroundWork()).toBe(true);
    send({ subtype: 'task_started', task_id: 't2', description: 'watch logs' });
    send({ subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done', output_file: '/tmp/o' });
    expect(session.hasBackgroundWork()).toBe(true); // t2 still runs
    send({ subtype: 'task_notification', task_id: 't2', status: 'stopped', summary: 'stopped', output_file: '/tmp/o2' });
    expect(session.hasBackgroundWork()).toBe(false);
  });

  it('counts a foreground task only once it moves to the background, and not at all when it simply ends', () => {
    const { session, send } = background();
    send({ subtype: 'task_started', task_id: 'fg', description: 'tests', is_backgrounded: false });
    expect(session.hasBackgroundWork()).toBe(false);
    send({ subtype: 'task_updated', task_id: 'fg', patch: { is_backgrounded: true } });
    expect(session.hasBackgroundWork()).toBe(true);
    send({ subtype: 'task_updated', task_id: 'fg', patch: { status: 'completed' } });
    expect(session.hasBackgroundWork()).toBe(false);
    send({ subtype: 'task_started', task_id: 'fg2', description: 'tests', is_backgrounded: false });
    send({ subtype: 'task_notification', task_id: 'fg2', status: 'completed', summary: '', output_file: '' });
    expect(session.hasBackgroundWork()).toBe(false);
  });

  it('takes background_tasks_changed as the whole truth: it replaces the set, so a missed end cannot wedge the flag', () => {
    const { session, send } = background();
    send({ subtype: 'task_started', task_id: 'lost', description: 'its notification never arrives' });
    expect(session.hasBackgroundWork()).toBe(true);
    send({ subtype: 'background_tasks_changed', tasks: [task('a'), task('b')] });
    expect(session.hasBackgroundWork()).toBe(true);
    send({ subtype: 'task_notification', task_id: 'a', status: 'completed', summary: '', output_file: '' });
    expect(session.hasBackgroundWork()).toBe(true); // b
    send({ subtype: 'background_tasks_changed', tasks: [] });
    expect(session.hasBackgroundWork()).toBe(false);
  });

  it('ignores ambient tasks (watchers and housekeeping are not activity)', () => {
    const { session, send } = background();
    send({ subtype: 'background_tasks_changed', tasks: [task('watch', { ambient: true })] });
    expect(session.hasBackgroundWork()).toBe(false);
    send({ subtype: 'task_started', task_id: 'tidy', description: 'housekeeping', ambient: true });
    send({ subtype: 'task_started', task_id: 'quiet', description: 'hidden', skip_transcript: true });
    expect(session.hasBackgroundWork()).toBe(false);
    send({ subtype: 'background_tasks_changed', tasks: [task('watch', { ambient: true }), task('real')] });
    expect(session.hasBackgroundWork()).toBe(true);
  });

  it('does not let a late frame of an earlier run end a resumed task', () => {
    const { session, send } = background();
    send({ subtype: 'task_started', task_id: 'agent', description: 'subagent', run_id: 'run-02' });
    send({ subtype: 'task_notification', task_id: 'agent', run_id: 'run-01', status: 'completed', summary: '', output_file: '' }); // the first run's end, delivered late
    expect(session.hasBackgroundWork()).toBe(true);
    send({ subtype: 'task_notification', task_id: 'agent', run_id: 'run-02', status: 'completed', summary: '', output_file: '' });
    expect(session.hasBackgroundWork()).toBe(false);
  });

  it('is false once the process has ended, and keeps no task frame as an unhandled one', async () => {
    const { session, send, memory } = background();
    send({ subtype: 'task_started', task_id: 't1', description: 'build' });
    send({ subtype: 'task_progress', task_id: 't1', description: 'build', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } });
    expect(session.hasBackgroundWork()).toBe(true);
    expect(session.ignored.has('system/task_started')).toBe(false);
    expect(session.ignored.get('system/task_progress')).toBe(1);
    memory.exit(0);
    await waitUntil(() => session.isEnded);
    expect(session.hasBackgroundWork()).toBe(false);
  });

  it('knows the work of a process found again from the snapshot the CLI sends behind the repeated initialize', async () => {
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false, backgroundTasksOnReinitialize: [{ task_id: 'bg-1', task_type: 'local_bash', description: 'build' }] }, { host: true });
    const first = setup.track(await setup.instance.start(setup.open()));
    expect(first.hasBackgroundWork()).toBe(false); // nothing is emitted at startup
    await setup.instance.dispose('shutdown');
    const { instance } = setup.restartBackend();
    const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
    await waitUntil(() => second.hasBackgroundWork(), 5000, 'the snapshot');
    expect(second.hasBackgroundWork()).toBe(true);
  }, 30_000);
});

describe('stream-json client', () => {
  it('matches control responses by request id and fails pending requests when the channel ends', async () => {
    const memory = memoryTransport();
    const client = new StreamJsonClient({ transport: memory.transport, controlTimeoutMs: 1000 });
    const first = client.sendControl({ subtype: 'set_model', model: 'opus' });
    const second = client.sendControl({ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } });
    await waitUntil(() => memory.written.length === 2);
    memory.fromCli({ type: 'control_response', response: { subtype: 'success', request_id: memory.written[0]!.request_id, response: { model: 'claude-opus' } } });
    expect((await first).response).toEqual({ model: 'claude-opus' });
    second.catch(() => undefined);
    memory.exit(1);
    await expect(second).rejects.toBeInstanceOf(ClaudeExitError);
    await expect(client.sendControl({ subtype: 'interrupt' })).rejects.toBeInstanceOf(ClaudeExitError);
    await expect(client.write({ type: 'user' })).rejects.toBeInstanceOf(ClaudeExitError);
  });

  it('times out a control request and withdraws it', async () => {
    const memory = memoryTransport();
    const client = new StreamJsonClient({ transport: memory.transport, controlTimeoutMs: 40 });
    await expect(client.sendControl({ subtype: 'interrupt' })).rejects.toBeInstanceOf(ClaudeControlTimeoutError);
    await waitUntil(() => memory.written.some((frame) => frame.type === 'control_cancel_request'));
    expect(memory.written.at(-1)).toEqual({ type: 'control_cancel_request', request_id: memory.written[0]!.request_id });
  });

  it('answers every server request even with no handler, a throwing handler, or an unknown subtype', async () => {
    const memory = memoryTransport();
    const client = new StreamJsonClient({ transport: memory.transport });
    memory.fromCli({ type: 'control_request', request_id: 'a', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 'tu-a' } });
    memory.fromCli({ type: 'control_request', request_id: 'b', request: { subtype: 'elicitation', mcp_server_name: 's', message: 'm' } });
    memory.fromCli({ type: 'control_request', request_id: 'c', request: { subtype: 'mcp_message' } });
    client.setServerRequestHandler(() => {
      throw new Error('boom');
    });
    memory.fromCli({ type: 'control_request', request_id: 'd', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {}, tool_use_id: 'tu-d' } });
    await waitUntil(() => memory.written.length === 4);
    const byId = Object.fromEntries(memory.written.map((frame) => [frame.response.request_id, frame.response]));
    expect(byId.a.response).toMatchObject({ behavior: 'deny', toolUseID: 'tu-a' });
    expect(byId.b.response).toEqual({ action: 'decline' });
    expect(byId.c).toEqual({ subtype: 'error', request_id: 'c', error: 'Unsupported control request: mcp_message' });
    expect(byId.d.response).toMatchObject({ behavior: 'deny', toolUseID: 'tu-d' });
    expect(client.openServerRequests()).toEqual([]);
  });

  it('keeps a request open for a later answer, answers it once, and drops it on withdrawal', async () => {
    const memory = memoryTransport();
    const client = new StreamJsonClient({ transport: memory.transport });
    const seen: string[] = [];
    const cancelled: string[] = [];
    client.setServerRequestHandler((open) => void seen.push(open.requestId));
    client.onServerRequestCancelled((requestId) => void cancelled.push(requestId));
    memory.fromCli({ type: 'control_request', request_id: 'x', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 'tu' } });
    memory.fromCli({ type: 'control_request', request_id: 'y', request: { subtype: 'elicitation', mcp_server_name: 's', message: 'm' } });
    expect(client.openServerRequests().map((open) => open.requestId)).toEqual(['x', 'y']);
    expect(await client.respondCanUseTool('x', { behavior: 'allow', updatedInput: { a: 1 } })).toBe(true);
    expect(await client.respondCanUseTool('x', { behavior: 'allow', updatedInput: {} })).toBe(false);
    memory.fromCli({ type: 'control_cancel_request', request_id: 'y' });
    expect(cancelled).toEqual(['y']);
    expect(await client.respondElicitation('y', { action: 'decline' })).toBe(false);
    expect(memory.written).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'x', response: { behavior: 'allow', updatedInput: { a: 1 } } } }]);
  });

  it('routes frames to listeners, skips keep-alives and unparseable lines, and never logs a whole frame', async () => {
    const memory = memoryTransport();
    const debug: Array<[object, string]> = [];
    const warn: Array<[object, string]> = [];
    const client = new StreamJsonClient({ transport: memory.transport, log: { debug: (fields, message) => void debug.push([fields, message]), warn: (fields, message) => void warn.push([fields, message]) } });
    const frames: string[] = [];
    client.onFrame((frame) => void frames.push(`${frame.type}/${(frame as { subtype?: string }).subtype ?? ''}`));
    memory.fromCli({ type: 'keep_alive' });
    memory.fromCli({ type: 'assistant', message: { content: [{ type: 'text', text: 'TOP-SECRET-OUTPUT' }] }, uuid: 'u1' });
    memory.fromCli({ type: 'system', subtype: 'init', uuid: 'u2' });
    expect(frames).toEqual(['assistant/', 'system/init']);
    expect(client.stats.keepAlives).toBe(1);
    await client.write({ type: 'user', message: { content: [{ type: 'text', text: 'TOP-SECRET-PROMPT' }] }, uuid: 'u3' });
    const logged = JSON.stringify([debug, warn]);
    expect(logged).not.toContain('TOP-SECRET');
    expect(debug.find(([fields]) => (fields as { uuid?: string }).uuid === 'u1')?.[0]).toMatchObject({ direction: 'in', type: 'assistant', uuid: 'u1', bytes: expect.any(Number) });
  });

  it('closes through the transport and keeps a throwing frame listener from stopping the others', async () => {
    const memory = memoryTransport();
    const client = new StreamJsonClient({ transport: memory.transport });
    const seen: string[] = [];
    client.onFrame(() => {
      throw new Error('listener failed');
    });
    client.onFrame((frame) => void seen.push(frame.type));
    memory.fromCli({ type: 'result' });
    expect(seen).toEqual(['result']);
    await client.close({ terminate: true });
    await client.close();
    expect(memory.closed).toEqual([{ terminate: true }, {}]);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('session host', () => {
  it('finds the running process again after a backend restart: same pid, no second process, the turn and the open question picked up', async () => {
    const setup = setupFake(
      {
        sessionsDir: 'auto',
        sessionStartHook: true,
        turns: [{ steps: [{ request: { request_id: 'req-q', request: canUseTool('AskUserQuestion', QUESTION_INPUT, 'tool-q') } }, assistantText('thanks for the answer')] }],
      },
      { host: true, context: { coordination: COORDINATION } },
    );
    const first = setup.track(await setup.instance.start(setup.open({ appendSystemPrompt: 'AUTHORITY TEXT' })));
    const firstEvents = new EventLog(first);
    await first.sendTurn({ text: 'ask me' });
    await firstEvents.waitForType('request.opened');
    const pid = first.pid!;

    // The backend goes away without ending anything.
    await setup.instance.dispose('shutdown');
    await firstEvents.done;
    expect(processStartTicks(pid)).toBeDefined();
    expect(setup.context.metaStore.has('claude-launch:conversation-1')).toBe(true);

    const { instance, context } = setup.restartBackend();
    const second = setup.track(await instance.resume(first.nativeSessionId, setup.open()));
    const events = new EventLog(second);
    expect(second.pid).toBe(pid);
    expect(startEntries(setup.logFile)).toHaveLength(1);
    expect(receivedControls(setup.logFile, 'initialize').map((frame) => frame.request)).toEqual([
      { subtype: 'initialize', appendSystemPrompt: 'AUTHORITY TEXT' },
      { subtype: 'initialize' }, // the repeat only reads what the process still has open
    ]);

    // The question the old backend never answered is reported again, on a turn the CLI started itself as far as this backend knows.
    const opened = await events.waitForType('request.opened');
    expect(opened).toMatchObject({ requestId: 'req-q', kind: 'question' });
    expect(opened.turnId).toBeTruthy();
    await second.respond('req-q', { decision: 'answer', answers: { q0: ['Postgres'] } });
    const terminal = await events.waitFor((event) => event.type === 'turn.terminal');
    expect(terminal).toMatchObject({ status: 'completed', turnId: opened.turnId });
    expect(events.of('turn.started')[0]).toMatchObject({ origin: 'provider', turnId: opened.turnId });
    expect(receivedResponses(setup.logFile).map((frame) => frame.response.request_id)).toEqual(['req-q']);

    // The reattached session works like any other, and ending it ends the process behind the host.
    const next = await second.sendTurn({ text: 'again' });
    expect((await events.waitForTerminal(next.turnId)).status).toBe('completed');
    await second.close('release');
    await events.done;
    await waitUntil(() => processStartTicks(pid) === undefined, 5000, 'the process to end');
    expect(context.metaStore.has('claude-launch:conversation-1')).toBe(false);
  }, 30_000);

  it('refuses a resume when another process holds the session and no launch was recorded', async () => {
    const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
    const first = setup.track(await setup.instance.start(setup.open()));
    await setup.instance.dispose('shutdown');
    const { instance, context } = setup.restartBackend();
    context.metaStore.delete('claude-launch:conversation-1');
    await expect(instance.resume(first.nativeSessionId, setup.open())).rejects.toBeInstanceOf(ClaudeSessionHeldError);
    expect(startEntries(setup.logFile)).toHaveLength(1);
  }, 30_000);

  describe('reattach', () => {
    it('adopts the running process without starting one: same pid, the repeated initialize, the open question and the turn picked up', async () => {
      const setup = setupFake(
        {
          sessionsDir: 'auto',
          sessionStartHook: true,
          turns: [{ steps: [{ request: { request_id: 'req-q', request: canUseTool('AskUserQuestion', QUESTION_INPUT, 'tool-q') } }, assistantText('thanks for the answer')] }],
        },
        { host: true, context: { coordination: COORDINATION } },
      );
      const first = setup.track(await setup.instance.start(setup.open({ appendSystemPrompt: 'AUTHORITY TEXT' })));
      const firstEvents = new EventLog(first);
      await first.sendTurn({ text: 'ask me' });
      await firstEvents.waitForType('request.opened');
      const pid = first.pid!;
      await setup.instance.dispose('shutdown');
      await firstEvents.done;

      const { instance, context } = setup.restartBackend();
      const second = setup.track((await instance.reattach(first.nativeSessionId, setup.open({ appendSystemPrompt: 'IGNORED, THE PROCESS HAS ITS PROMPT' })))!);
      const events = new EventLog(second);
      expect(second).toBeDefined();
      expect(second.pid).toBe(pid);
      expect(startEntries(setup.logFile)).toHaveLength(1); // no second process, ever
      expect(receivedControls(setup.logFile, 'initialize').map((frame) => frame.request)).toEqual([
        { subtype: 'initialize', appendSystemPrompt: 'AUTHORITY TEXT' },
        { subtype: 'initialize' }, // the repeat only reads what the process still has open
      ]);
      expect(instance.openSessionIds).toEqual([first.nativeSessionId]);

      const opened = await events.waitForType('request.opened');
      expect(opened).toMatchObject({ requestId: 'req-q', kind: 'question', replay: true }); // it was open before this backend attached
      expect(events.of('turn.started')[0]).toMatchObject({ origin: 'provider', adopted: true, turnId: opened.turnId });
      await second.respond('req-q', { decision: 'answer', answers: { q0: ['Postgres'] } });
      expect((await events.waitFor((event) => event.type === 'turn.terminal')).type).toBe('turn.terminal');

      // Ending it ends the process behind the host, like any session this backend owns.
      await second.close('release');
      await events.done;
      await waitUntil(() => processStartTicks(pid) === undefined, 5000, 'the process to end');
      expect(context.metaStore.has('claude-launch:conversation-1')).toBe(false);
    }, 30_000);

    it('reports a session host that runs but did not answer as busy, and nothing else: it starts nothing and keeps the launch record', async () => {
      const ref: { real?: LineTransportFactory; unreachable: boolean } = { unreachable: false };
      const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, {
        host: true,
        plugin: {
          lineTransport: (request) => (ref.unreachable && (request as { attachOnly?: boolean }).attachOnly
            ? Promise.reject(new LineTransportNotRunningError('did not answer', 'unreachable'))
            : ref.real!(request)),
        },
      });
      ref.real = setup.context.lineTransport!;
      const first = setup.track(await setup.instance.start(setup.open()));
      await setup.instance.dispose('shutdown');
      const { instance, context } = setup.restartBackend();
      ref.unreachable = true;
      const error = await instance.reattach(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TransportBusyError);
      expect(error).toBeInstanceOf(TransportUnavailableError); // callers that only know "unavailable" still read it so
      expect(context.metaStore.has('claude-launch:conversation-1')).toBe(true);
      expect(startEntries(setup.logFile)).toHaveLength(1);
      expect(processStartTicks(first.pid!)).toBeDefined();

      // A host that is not there, or whose process ended, is "no survivor" and not busy.
      ref.unreachable = false;
      await terminateHost(setup.hostRuntimeDir, hostIdFor('conversation-1'), setup.context.log, { closeGraceMs: 300, termGraceMs: 300, staleTermGraceMs: 300 });
      await waitUntil(() => processStartTicks(first.pid!) === undefined, 5000, 'the process to end');
      expect(await instance.reattach(first.nativeSessionId, setup.open())).toBeUndefined();
    }, 30_000);

    /** Wraps a factory so that a process reached again (one an earlier client already wrote to) never sees the repeated `initialize`: it is swallowed while `silent()` is true. */
    function silenceRepeatedInitialize(real: LineTransportFactory, silent: () => boolean): LineTransportFactory {
      return async (request) => {
        const transport = await real(request);
        if (!silent() || transportStartedFresh(transport)) return transport;
        return new Proxy(transport, {
          get(target, property) {
            if (property === 'write') {
              return async (line: string) => {
                if ((JSON.parse(line) as { request?: { subtype?: string } }).request?.subtype === 'initialize') return;
                return target.write(line);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
    }

    /**
     * A restarted backend whose repeated `initialize` goes unanswered (`silence`): the earlier backend's was answered, this one's is
     * swallowed. Or whose session host sends no welcome to an attach-only connect (`noHello`), which is how the plugin finds a survivor.
     */
    function setupSilentRepeat(plugin: Partial<ClaudePluginOptions> = {}, scenario: Scenario = { sessionsDir: 'auto', sessionStartHook: false }): { setup: FakeSetup; silence: (on: boolean) => void; noHello: (on: boolean) => void } {
      const ref: { real?: LineTransportFactory; silent: boolean; noHello: boolean } = { silent: false, noHello: false };
      const withoutHello: LineTransportFactory = (request) => ref.noHello && (request as { attachOnly?: boolean }).attachOnly
        ? Promise.reject(new LineTransportNotRunningError('did not answer', 'unreachable'))
        : ref.real!(request);
      const silenced = silenceRepeatedInitialize(withoutHello, () => ref.silent);
      const setup = setupFake(scenario, { host: true, timings: { initializeTimeoutMs: 400 }, plugin: { ...plugin, lineTransport: silenced } });
      ref.real = setup.context.lineTransport!;
      return { setup, silence: (on) => { ref.silent = on; }, noHello: (on) => { ref.noHello = on; } };
    }

    it('reports a handshake that timed out after the connection was made as busy: the process is left running, and the next attempt adopts it', async () => {
      const { setup, silence } = setupSilentRepeat();
      const first = setup.track(await setup.instance.start(setup.open()));
      await setup.instance.dispose('shutdown');
      const { instance, context } = setup.restartBackend();
      silence(true);
      const error = await instance.reattach(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TransportBusyError);
      expect(error).toBeInstanceOf(TransportUnavailableError); // callers that only know "unavailable" still read it so
      // The process was reached and is left running; nothing was started, and the record that finds it again stays.
      expect(instance.openSessionIds).toEqual([]);
      expect(startEntries(setup.logFile)).toHaveLength(1);
      expect(processStartTicks(first.pid!)).toBeDefined();
      expect(context.metaStore.has('claude-launch:conversation-1')).toBe(true);
      silence(false);
      const again = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
      expect(again.pid).toBe(first.pid);
    }, 30_000);

    it('does not report a process that exited during the handshake as busy: it is an ordinary failure with its reason', async () => {
      const { setup, silence } = setupSilentRepeat();
      const first = setup.track(await setup.instance.start(setup.open()));
      const pid = first.pid!;
      await setup.instance.dispose('shutdown');
      const { instance } = setup.restartBackend();
      silence(true);
      const attempt = instance.reattach(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught);
      await sleep(100); // inside the 400 ms the repeated `initialize` is given
      process.kill(pid, 'SIGKILL');
      const error = await attempt;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TransportBusyError);
      expect((error as Error).message).toMatch(/exited while resuming/);
      expect(instance.openSessionIds).toEqual([]);
    }, 30_000);

    describe('a process that keeps timing out', () => {
      const LIMIT = CLAUDE_UNRESPONSIVE_LIMIT_MS;

      /** A conversation that ran, has a transcript, and whose process outlived its backend: the restarted backend's `resume` finds it. */
      async function survivorOf(clock: { t: number }) {
        const silent = setupSilentRepeat({ now: () => clock.t });
        const first = silent.setup.track(await silent.setup.instance.start(silent.setup.open()));
        writeTranscript(silent.setup.configDir, silent.setup.cwd, first.nativeSessionId);
        const pid = first.pid!;
        await silent.setup.instance.dispose('shutdown');
        const { instance, context } = silent.setup.restartBackend();
        // What the Console gives a plugin to end a host that no connection can reach.
        const ended: string[] = [];
        context.endHost = async (hostId, graces) => {
          ended.push(hostId);
          await terminateHost(silent.setup.hostRuntimeDir, hostId, context.log, graces);
        };
        return { ...silent, first, pid, instance, context, ended };
      }

      const replaced = (context: { logs: { warn: Array<[object, string]> } }): boolean => context.logs.warn.some(([, message]) => /longer than the limit/.test(message));

      it('keeps reporting busy to an ordinary resume while the run is younger than the limit, then ends the process and starts a replacement in the same call', async () => {
        const clock = { t: 1_000_000 };
        const { setup, silence, first, pid, instance, context } = await survivorOf(clock);
        silence(true);

        const open = (): Promise<unknown> => instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught);
        expect(await open()).toBeInstanceOf(TransportBusyError); // the first timeout starts the run
        clock.t += LIMIT - 1_000;
        expect(await open()).toBeInstanceOf(TransportBusyError); // the run is 1 s short of the limit
        // Each time the process was let go of, not ended: no second start, the record that finds it again stays.
        expect(startEntries(setup.logFile)).toHaveLength(1);
        expect(processStartTicks(pid)).toBeDefined();
        expect(context.metaStore.has('claude-launch:conversation-1')).toBe(true);
        expect(replaced(context)).toBe(false);

        clock.t += 2_000; // the next timeout is past the limit
        const second = setup.track((await instance.resume(first.nativeSessionId, setup.open())) as ClaudeSession);
        const events = new EventLog(second);
        expect(replaced(context)).toBe(true);
        expect(second.pid).not.toBe(pid);
        await waitUntil(() => processStartTicks(pid) === undefined, 5000, 'the hung process to end');
        const starts = startEntries(setup.logFile);
        expect(starts).toHaveLength(2);
        expect(starts[1]!.argv).toEqual(expect.arrayContaining(['--resume', first.nativeSessionId]));
        // The replacement is a working conversation, recorded for the next restart.
        const { turnId } = await second.sendTurn({ text: 'hello again' });
        expect((await events.waitForTerminal(turnId)).status).toBe('completed');
        expect(JSON.parse(context.metaStore.get('claude-launch:conversation-1')!).argv).toEqual(expect.arrayContaining(['--resume', first.nativeSessionId]));
      }, 30_000);

      it('never ends the process for an attach-only reattach, however long it stays silent, and does not count it toward the run', async () => {
        const clock = { t: 1_000_000 };
        const { setup, silence, first, pid, instance, context } = await survivorOf(clock);
        silence(true);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          clock.t += LIMIT + 60_000;
          expect(await instance.reattach(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        }
        expect(startEntries(setup.logFile)).toHaveLength(1);
        expect(processStartTicks(pid)).toBeDefined();
        expect(context.metaStore.has('claude-launch:conversation-1')).toBe(true);
        expect(replaced(context)).toBe(false);

        // Those timeouts started no run: the first ordinary resume is busy, however late it comes.
        expect(await instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        expect(processStartTicks(pid)).toBeDefined();
        expect(replaced(context)).toBe(false);
      }, 30_000);

      it('ends the run at a successful handshake: a later timeout starts a new one', async () => {
        const clock = { t: 1_000_000 };
        const { setup, silence, first, pid, instance, context } = await survivorOf(clock);
        silence(true);
        expect(await instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        clock.t += 60_000;
        silence(false);
        const adopted = await instance.resume(first.nativeSessionId, setup.open());
        expect(adopted.pid).toBe(pid); // the process answered: it is the survivor, adopted
        await (adopted as ClaudeSession).detach(); // let go, still running
        clock.t += LIMIT; // the first timeout is now older than the limit, but the run it began ended with the answer
        silence(true);
        expect(await instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        expect(processStartTicks(pid)).toBeDefined();
        expect(startEntries(setup.logFile)).toHaveLength(1);
        expect(replaced(context)).toBe(false);
      }, 30_000);

      it('keeps the run in the plugin: a new instance continues it', async () => {
        const clock = { t: 1_000_000 };
        const ref: { silent: boolean } = { silent: false };
        const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
        const real = setup.context.lineTransport!;
        const plugin = createClaudePlugin({
          timings: { ...FAST_TIMINGS, initializeTimeoutMs: 400 },
          baseEnv: { PATH: process.env.PATH },
          homeDir: setup.home,
          lineTransport: silenceRepeatedInitialize(real, () => ref.silent),
          now: () => clock.t,
        });
        const create = (): ClaudeInstance => plugin.create({ enabled: true, command: setup.command, idleUnloadMinutes: 60, env: {} }, setup.context) as ClaudeInstance;
        const first = setup.track(await setup.instance.start(setup.open()));
        writeTranscript(setup.configDir, setup.cwd, first.nativeSessionId);
        const pid = first.pid!;
        await setup.instance.dispose('shutdown');

        ref.silent = true;
        const before = create();
        expect(await before.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        await before.dispose('restart'); // the service drops an instance that never connected
        expect(processStartTicks(pid)).toBeDefined();

        clock.t += LIMIT + 1_000;
        const after = create();
        const second = setup.track(await after.resume(first.nativeSessionId, setup.open()));
        expect(second.pid).not.toBe(pid);
        await waitUntil(() => processStartTicks(pid) === undefined, 5000, 'the hung process to end');
        expect(startEntries(setup.logFile)).toHaveLength(2);
        await after.dispose('shutdown');
      }, 30_000);

      it('counts a session host that sends no welcome toward the run: busy within the window, then the host and its process are ended and a replacement starts in the same call', async () => {
        const clock = { t: 1_000_000 };
        const { setup, noHello, first, pid, instance, context, ended } = await survivorOf(clock);
        noHello(true);

        const open = (): Promise<unknown> => instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught);
        expect(await open()).toBeInstanceOf(TransportBusyError); // the first silence starts the run
        clock.t += LIMIT - 1_000;
        expect(await open()).toBeInstanceOf(TransportBusyError); // 1 s short of the limit
        expect(ended).toEqual([]);
        expect(startEntries(setup.logFile)).toHaveLength(1);
        expect(processStartTicks(pid)).toBeDefined();
        expect(context.metaStore.has('claude-launch:conversation-1')).toBe(true);

        clock.t += 2_000;
        const second = setup.track((await instance.resume(first.nativeSessionId, setup.open())) as ClaudeSession);
        const events = new EventLog(second);
        expect(ended).toEqual([hostIdFor('conversation-1')]);
        expect(context.logs.warn.some(([, message]) => /session host has not answered for longer than the limit/.test(message))).toBe(true);
        expect(second.pid).not.toBe(pid);
        await waitUntil(() => processStartTicks(pid) === undefined, 5000, 'the silent host\'s process to end');
        const starts = startEntries(setup.logFile);
        expect(starts).toHaveLength(2);
        expect(starts[1]!.argv).toEqual(expect.arrayContaining(['--resume', first.nativeSessionId]));
        const { turnId } = await second.sendTurn({ text: 'hello again' });
        expect((await events.waitForTerminal(turnId)).status).toBe('completed');
        expect(JSON.parse(context.metaStore.get('claude-launch:conversation-1')!).argv).toEqual(expect.arrayContaining(['--resume', first.nativeSessionId]));
      }, 30_000);

      it.each([
        ['a handshake timeout, then a silent host', 'handshake', 'hello'],
        ['a silent host, then a handshake timeout', 'hello', 'handshake'],
      ] as const)('shares one run between both kinds of silence: %s', async (_label, firstKind, secondKind) => {
        const clock = { t: 1_000_000 };
        const { setup, silence, noHello, first, pid, instance, context, ended } = await survivorOf(clock);
        const only = (kind: 'handshake' | 'hello'): void => { silence(kind === 'handshake'); noHello(kind === 'hello'); };

        only(firstKind);
        expect(await instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        clock.t += LIMIT + 1_000;
        only(secondKind); // the other kind of silence, past the limit measured from the first
        const second = setup.track((await instance.resume(first.nativeSessionId, setup.open())) as ClaudeSession);
        expect(second.pid).not.toBe(pid);
        await waitUntil(() => processStartTicks(pid) === undefined, 5000, 'the silent process to end');
        expect(startEntries(setup.logFile)).toHaveLength(2);
        expect(ended).toEqual(secondKind === 'hello' ? [hostIdFor('conversation-1')] : []); // a handshake timeout ends it through its own connection
        expect(context.logs.warn.some(([, message]) => /longer than the limit/.test(message))).toBe(true);
      }, 30_000);

      it('never ends a silent host for an attach-only reattach, and does not count it toward the run', async () => {
        const clock = { t: 1_000_000 };
        const { setup, noHello, first, pid, instance, context, ended } = await survivorOf(clock);
        noHello(true);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          clock.t += LIMIT + 60_000;
          expect(await instance.reattach(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        }
        expect(ended).toEqual([]);
        expect(processStartTicks(pid)).toBeDefined();
        expect(context.metaStore.has('claude-launch:conversation-1')).toBe(true);
        // Those silences started no run: the first ordinary resume is busy, however late it comes.
        expect(await instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        expect(ended).toEqual([]);
        expect(startEntries(setup.logFile)).toHaveLength(1);
      }, 30_000);

      it('ends the run when the host answers again: a later silence starts a new one', async () => {
        const clock = { t: 1_000_000 };
        const { setup, noHello, first, pid, instance, ended } = await survivorOf(clock);
        noHello(true);
        expect(await instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        clock.t += 60_000;
        noHello(false);
        const adopted = await instance.resume(first.nativeSessionId, setup.open());
        expect(adopted.pid).toBe(pid);
        await (adopted as ClaudeSession).detach();
        clock.t += LIMIT;
        noHello(true);
        expect(await instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        expect(ended).toEqual([]);
        expect(processStartTicks(pid)).toBeDefined();
      }, 30_000);

      it('fails plainly, and leaves the host alone, when it is past the limit and the Console gave the plugin no way to end a host', async () => {
        const clock = { t: 1_000_000 };
        const { setup, noHello, first, pid, instance, context } = await survivorOf(clock);
        delete context.endHost;
        noHello(true);
        expect(await instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        clock.t += LIMIT + 1_000;
        const error = await instance.resume(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(TransportUnavailableError);
        expect(error).not.toBeInstanceOf(TransportBusyError);
        expect((error as Error).message).toMatch(/cannot be ended from here/);
        expect(processStartTicks(pid)).toBeDefined();
        expect(startEntries(setup.logFile)).toHaveLength(1);
      }, 30_000);

      it('also bounds an ordinary launch that reconnects to a running host without a launch record', async () => {
        const clock = { t: 1_000_000 };
        const sessionId = '12345678-1234-4234-8234-123456789abd';
        // No session registry here: the CLI's own registry would name the running process as a holder and stop the launch first.
        const { setup, silence } = setupSilentRepeat({ now: () => clock.t }, { sessionStartHook: false });
        writeTranscript(setup.configDir, setup.cwd, sessionId);
        const first = setup.track(await setup.instance.resume(sessionId, setup.open())); // launched with --resume, as the replacement will be
        const pid = first.pid!;
        await setup.instance.dispose('shutdown');
        const { instance, context } = setup.restartBackend();
        context.metaStore.delete('claude-launch:conversation-1');
        silence(true);

        expect(await instance.resume(sessionId, setup.open()).catch((caught: unknown) => caught)).toBeInstanceOf(TransportBusyError);
        expect(processStartTicks(pid)).toBeDefined();
        expect(startEntries(setup.logFile)).toHaveLength(1);

        clock.t += LIMIT + 1_000;
        const second = setup.track(await instance.resume(sessionId, setup.open()));
        expect(second.pid).not.toBe(pid);
        await waitUntil(() => processStartTicks(pid) === undefined, 5000, 'the hung process to end');
        expect(startEntries(setup.logFile)).toHaveLength(2);
        expect(startEntries(setup.logFile)[1]!.argv).toEqual(expect.arrayContaining(['--resume', sessionId]));
        expect(replaced(context)).toBe(true);
      }, 30_000);
    });

    it('answers undefined, and starts nothing, when no process survived', async () => {
      const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
      const first = setup.track(await setup.instance.start(setup.open()));
      await setup.instance.dispose('shutdown');
      // The process dies while no backend is looking, but its launch record is still in the plugin's meta.
      await terminateHost(setup.hostRuntimeDir, hostIdFor('conversation-1'), setup.context.log, { closeGraceMs: 300, termGraceMs: 300, staleTermGraceMs: 300 });
      await waitUntil(() => processStartTicks(first.pid!) === undefined, 5000, 'the process to end');
      expect(setup.context.metaStore.has('claude-launch:conversation-1')).toBe(true);

      const { instance } = setup.restartBackend();
      expect(await instance.reattach(first.nativeSessionId, setup.open())).toBeUndefined();
      expect(startEntries(setup.logFile)).toHaveLength(1);
      expect(instance.openSessionIds).toEqual([]);
    }, 30_000);

    it('answers undefined with no launch on record, a record for another session, or a record that does not name the session', async () => {
      const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
      const first = setup.track(await setup.instance.start(setup.open()));
      const stored = JSON.parse(setup.context.metaStore.get('claude-launch:conversation-1')!) as { sessionId: string; argv: string[] };
      await setup.instance.dispose('shutdown');
      const { instance, context } = setup.restartBackend();

      context.metaStore.delete('claude-launch:conversation-1');
      expect(await instance.reattach(first.nativeSessionId, setup.open())).toBeUndefined();
      context.metaStore.set('claude-launch:conversation-1', JSON.stringify({ ...stored, sessionId: 'someone-else' }));
      expect(await instance.reattach(first.nativeSessionId, setup.open())).toBeUndefined();
      context.metaStore.set('claude-launch:conversation-1', JSON.stringify({ sessionId: first.nativeSessionId, argv: [...stored.argv.slice(0, stored.argv.indexOf('--session-id')), '--session-id', 'someone-else'] }));
      expect(await instance.reattach(first.nativeSessionId, setup.open())).toBeUndefined();
      // Nothing was started, and the process is still there for a record that is right.
      expect(startEntries(setup.logFile)).toHaveLength(1);
      expect(processStartTicks(first.pid!)).toBeDefined();
      context.metaStore.set('claude-launch:conversation-1', JSON.stringify(stored));
      setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
      expect(startEntries(setup.logFile)).toHaveLength(1);
    }, 30_000);

    it('leaves a host that runs another command line alone: no new process, and the old one is not ended', async () => {
      const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
      const first = setup.track(await setup.instance.start(setup.open({ model: 'sonnet' })));
      const stored = JSON.parse(setup.context.metaStore.get('claude-launch:conversation-1')!) as { sessionId: string; argv: string[] };
      await setup.instance.dispose('shutdown');
      const { instance, context } = setup.restartBackend();
      // The record says the launch used another model: the host (keyed by its command line) is not that process.
      context.metaStore.set('claude-launch:conversation-1', JSON.stringify({ ...stored, argv: [...stored.argv, '--effort', 'low'] }));
      expect(await instance.reattach(first.nativeSessionId, setup.open())).toBeUndefined();
      expect(startEntries(setup.logFile)).toHaveLength(1);
      expect(processStartTicks(first.pid!)).toBeDefined();
      // Where `resume` would have replaced it, reattach did not touch it: the right record still finds it.
      context.metaStore.set('claude-launch:conversation-1', JSON.stringify(stored));
      const again = setup.track((await instance.reattach(first.nativeSessionId, setup.open()))!);
      expect(again.pid).toBe(first.pid);
    }, 30_000);

    it('never starts a process under a plain stdio factory, where nothing can survive a restart', async () => {
      const setup = setupFake({ sessionStartHook: false });
      const first = setup.track(await setup.instance.start(setup.open()));
      await setup.instance.dispose('shutdown'); // the stdio child ends with its parent
      await waitUntil(() => processStartTicks(first.pid!) === undefined, 5000, 'the child to end');
      const { instance } = setup.restartBackend();
      expect(await instance.reattach(first.nativeSessionId, setup.open())).toBeUndefined();
      expect(startEntries(setup.logFile)).toHaveLength(1);
      // The factory itself refuses rather than starts.
      await expect(createStdioLineTransportFactory()({ argv: setup.command, cwd: setup.cwd, env: {}, hostId: 'x', attachOnly: true })).rejects.toBeInstanceOf(LineTransportNotRunningError);
    }, 30_000);

    it('refuses a survivor while another live process holds the session, and lets go of it without ending it', async () => {
      const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
      const first = setup.track(await setup.instance.start(setup.open()));
      await setup.instance.dispose('shutdown');
      const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'claude-holder'], { stdio: 'ignore' });
      try {
        await waitUntil(() => holder.pid !== undefined && processStartTicks(holder.pid) !== undefined);
        writeRegistryFile(setup.configDir, { pid: holder.pid!, sessionId: first.nativeSessionId, procStart: processStartTicks(holder.pid!) });
        const { instance } = setup.restartBackend();
        const error = await instance.reattach(first.nativeSessionId, setup.open()).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ClaudeSessionHeldError);
        expect((error as ClaudeSessionHeldError).heldByPid).toBe(holder.pid);
        expect(startEntries(setup.logFile)).toHaveLength(1);
        expect(processStartTicks(first.pid!)).toBeDefined(); // disconnected, not ended
        expect(instance.openSessionIds).toEqual([]);
      } finally {
        holder.kill('SIGKILL');
      }
    }, 30_000);

    it('refuses a conversation this instance has loaded or is loading, so there is never a second connection', async () => {
      const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: false }, { host: true });
      const first = setup.track(await setup.instance.start(setup.open()));
      await expect(setup.instance.reattach(first.nativeSessionId, setup.open())).rejects.toBeInstanceOf(ClaudeSessionHeldError);
      expect(startEntries(setup.logFile)).toHaveLength(1);
      expect(first.isEnded).toBe(false);
    }, 30_000);

    it('adopts a process the earlier backend started and never spoke to: a full handshake, with its hook frames replayed', async () => {
      const setup = setupFake({ sessionsDir: 'auto', sessionStartHook: true }, { host: true, context: { coordination: COORDINATION } });
      const sessionId = '11111111-2222-4333-8444-555555555555';
      const argv = buildClaudeArgv({ command: setup.command, mode: 'new', sessionId });
      // The earlier backend got as far as starting the host, then went away before it wrote `initialize`.
      const started = await setup.context.lineTransport!({ argv, cwd: setup.cwd, env: buildClaudeEnv({ base: { PATH: process.env.PATH }, conversationId: 'conversation-1', home: setup.home }), hostId: hostIdFor('conversation-1'), sinceSeq: 0 } as LineTransportSpawn);
      const childPid = started.pid!;
      // The hook frames are out before any client attaches again; only a replay can show them to the new backend.
      await waitUntil(() => sentFrames(setup.logFile).some((frame) => frame.subtype === 'hook_response'), 5000, 'the SessionStart hook frames');
      await started.close();
      setup.context.metaStore.set('claude-launch:conversation-1', JSON.stringify({ sessionId, argv }));

      const session = setup.track((await setup.instance.reattach(sessionId, setup.open({ appendSystemPrompt: 'AUTHORITY TEXT' })))!);
      expect(session.pid).toBe(childPid);
      expect(session.sawSessionStartHook).toBe(true); // replayed from the host's buffer
      expect(startEntries(setup.logFile)).toHaveLength(1);
      expect(receivedControls(setup.logFile, 'initialize').map((frame) => frame.request)).toEqual([{ subtype: 'initialize', appendSystemPrompt: 'AUTHORITY TEXT' }]);
      const events = new EventLog(session);
      const { turnId } = await session.sendTurn({ text: 'hello' });
      expect((await events.waitForTerminal(turnId)).status).toBe('completed');
    }, 30_000);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Real CLI. Opt in with AGENT_CONSOLE_REAL_CLAUDE=1. Everything runs against a throwaway CLAUDE_CONFIG_DIR that
// holds no credentials, so no model call can happen: initialize answers locally and a turn stops at "Not logged in".

describe.skipIf(process.env.AGENT_CONSOLE_REAL_CLAUDE !== '1')('real claude (no credentials, no model call)', () => {
  const realCommand = (process.env.AGENT_CONSOLE_REAL_CLAUDE_BIN ?? 'claude').split(' ');

  const configDirs: string[] = [];
  afterEach(() => {
    for (const dir of configDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A throwaway config directory with no credentials, so the CLI can never reach the model.
  function realSetup(): FakeSetup {
    const configDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'claude-real-cfg-'));
    configDirs.push(configDir);
    return setupFake({}, { baseEnv: { HOME: process.env.HOME }, config: { command: realCommand, env: { CLAUDE_CONFIG_DIR: configDir } } });
  }

  it('probes the installed binary: version, models and the missing login', async () => {
    const setup = realSetup();
    const result = await setup.instance.probe();
    expect(result.installed).toBe(true);
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.auth).toBe('missing');
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models[0]).toMatchObject({ id: expect.any(String), label: expect.any(String) });
    // eslint-disable-next-line no-console
    console.log(`real claude probe: ${JSON.stringify({ version: result.version, auth: result.auth, models: result.models.map((model) => model.id) })}`);
  }, 30_000);

  it('starts a session with the planned argv, runs one turn to "Not logged in", and classifies it', async () => {
    const setup = realSetup();
    const session = setup.track(await setup.instance.start(setup.open({ model: 'sonnet', effort: 'low', appendSystemPrompt: 'Test authority text.' })));
    const events = new EventLog(session);
    const { turnId } = await session.sendTurn({ text: 'hello' });
    const terminal = await events.waitForTerminal(turnId, 20_000);
    expect(terminal.status).toBe('failed');
    expect(terminal.failure).toMatchObject({ class: 'permission_error', code: 'authentication_failed' });
    expect(events.of('turn.started')[0]).toMatchObject({ turnId, origin: 'user' });
    await session.refreshContextUsage();
    await session.close('release');
    await events.done;
  }, 60_000);

  it('refuses to resume a session that does not exist, before starting a process', async () => {
    const setup = realSetup();
    await expect(setup.instance.resume('99999999-2222-4333-8444-555555555555', setup.open())).rejects.toBeInstanceOf(ResumeFailedError);
  }, 20_000);
});

// Silence unused-import lint for helpers kept for readability.
void createClaudePlugin;
void makeContext;
void transcriptPathFor;
void receivedFrames;
