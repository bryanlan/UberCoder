import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudePlugin, type ClaudeOpenOptions, type ClaudePluginOptions } from '../../src/providers/transport/claude/index.js';
import { createLineTransportFactory, terminateHost } from '../../src/providers/transport/line-transport.js';
import type { ClaudeInstance } from '../../src/providers/transport/claude/claude-instance.js';
import type { ClaudeTimings } from '../../src/providers/transport/claude/claude-session.js';
import { escapeProjectDir } from '../../src/providers/transport/claude/transcript.js';
import type { PluginContext, TransportEvent, TransportSession } from '../../src/providers/transport/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(here, 'fake-claude.mjs');
const HOST_PROGRAM = path.join(here, '../../src/providers/transport/session-host.ts');

export const FAST_TIMINGS: Partial<ClaudeTimings> = {
  initializeTimeoutMs: 5_000,
  probeDeadlineMs: 5_000,
  controlTimeoutMs: 3_000,
  interruptGraceMs: 300,
  closeGraceMs: 400,
  termGraceMs: 400,
  hookGraceMs: 300,
  cancelSettleMs: 300,
  idleResultGraceMs: 300,
  contextUsageTimeoutMs: 2_000,
  backgroundSnapshotGraceMs: 300,
};

export interface LogLine {
  dir: 'start' | 'in' | 'out' | 'event';
  frame?: Record<string, any>;
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  pid?: number;
  event?: string;
  [key: string]: unknown;
}

export interface TestContext extends PluginContext {
  logs: { info: Array<[object, string]>; warn: Array<[object, string]>; debug: Array<[object, string]> };
  metaStore: Map<string, string>;
}

export function makeContext(runtimeDir: string, extra: Partial<Pick<PluginContext, 'coordination' | 'lineTransport' | 'registerConversation'>> = {}): TestContext {
  const logs = { info: [] as Array<[object, string]>, warn: [] as Array<[object, string]>, debug: [] as Array<[object, string]> };
  const metaStore = new Map<string, string>();
  return {
    runtimeDir,
    logs,
    metaStore,
    log: {
      info: (fields: object, message: string) => void logs.info.push([fields, message]),
      warn: (fields: object, message: string) => void logs.warn.push([fields, message]),
      debug: (fields: object, message: string) => void logs.debug.push([fields, message]),
    } as PluginContext['log'],
    meta: {
      get: (key) => metaStore.get(key),
      set: (key, value) => void metaStore.set(key, value),
      delete: (key) => void metaStore.delete(key),
    },
    ...extra,
  };
}

export function makeTempDir(prefix = 'claude-plugin-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Scenario {
  [key: string]: unknown;
}

export interface FakeSetup {
  dir: string;
  /** The working directory handed to `start` / `resume`. */
  cwd: string;
  home: string;
  /** `<home>/.claude`: where the plugin looks for transcripts and the session registry. */
  configDir: string;
  scenarioPath: string;
  logFile: string;
  context: TestContext;
  instance: ClaudeInstance;
  command: string[];
  open(overrides?: Partial<ClaudeOpenOptions>): ClaudeOpenOptions;
  /** Sessions and instances started through the setup; `cleanup` ends them. */
  track<T extends TransportSession>(session: T): T;
  cleanup(): Promise<void>;
  /** Replaces the scenario file; the next process the plugin starts reads it. */
  rewriteScenario(scenario: Scenario): void;
  /** The Console runtime directory the session host files live under. */
  hostRuntimeDir: string;
  /** A new backend over the same host: new instance and line transport factory, same meta and runtime. */
  restartBackend(): { instance: ClaudeInstance; context: TestContext };
}

export interface SetupOptions {
  timings?: Partial<ClaudeTimings>;
  baseEnv?: NodeJS.ProcessEnv;
  config?: { env?: Record<string, string>; command?: string[] };
  plugin?: Partial<ClaudePluginOptions>;
  context?: Partial<Pick<PluginContext, 'coordination' | 'lineTransport'>>;
  /** Run the process behind a real session host (it outlives the instance), as in production. Default: directly over stdio. */
  host?: boolean;
}

const live = new Set<FakeSetup>();

export function setupFake(scenario: Scenario = {}, options: SetupOptions = {}): FakeSetup {
  const dir = makeTempDir();
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const configDir = path.join(home, '.claude');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const logFile = path.join(dir, 'fake.log');
  const scenarioPath = path.join(dir, 'scenario.json');
  const writeScenario = (value: Scenario): void => {
    // `sessionsDir: 'auto'` makes the fake register itself where the plugin looks for live holders.
    const resolved = value.sessionsDir === 'auto' ? { ...value, sessionsDir: path.join(configDir, 'sessions') } : value;
    fs.writeFileSync(scenarioPath, JSON.stringify({ logFile, ...resolved }));
  };
  writeScenario(scenario);
  const command = options.config?.command ?? [process.execPath, FAKE_CLAUDE, scenarioPath];
  const hostRuntimeDir = path.join(dir, 'runtime');
  const runtimeDir = path.join(hostRuntimeDir, 'structured', 'claude');
  const context = makeContext(runtimeDir, options.context);
  if (options.host) context.lineTransport = createLineTransportFactory({ runtimeDir: hostRuntimeDir, log: context.log, hostProgramPath: HOST_PROGRAM });
  const makeInstance = (ctx: TestContext): ClaudeInstance => {
    const plugin = createClaudePlugin({
      timings: { ...FAST_TIMINGS, ...options.timings },
      baseEnv: { PATH: process.env.PATH, ...options.baseEnv },
      homeDir: home,
      ...options.plugin,
    });
    return plugin.create({ enabled: true, command, idleUnloadMinutes: 60, env: options.config?.env ?? {} }, ctx) as ClaudeInstance;
  };
  const instance = makeInstance(context);
  const sessions: TransportSession[] = [];
  const instances: ClaudeInstance[] = [instance];
  const setup: FakeSetup = {
    dir,
    cwd,
    home,
    configDir,
    scenarioPath,
    logFile,
    context,
    instance,
    command,
    hostRuntimeDir,
    open: (overrides = {}) => ({ conversationId: 'conversation-1', cwd, policy: { approvals: 'never', sandbox: 'full-access' }, ...overrides }),
    track: (session) => {
      sessions.push(session);
      return session;
    },
    rewriteScenario: writeScenario,
    restartBackend: () => {
      const next = makeContext(runtimeDir, options.context);
      for (const [key, value] of context.metaStore) next.metaStore.set(key, value);
      if (options.host) next.lineTransport = createLineTransportFactory({ runtimeDir: hostRuntimeDir, log: next.log, hostProgramPath: HOST_PROGRAM });
      const restarted = makeInstance(next);
      instances.push(restarted);
      return { instance: restarted, context: next };
    },
    cleanup: async () => {
      live.delete(setup);
      await Promise.allSettled(sessions.map((session) => session.close('release')));
      await Promise.allSettled(instances.map((each) => each.dispose('shutdown')));
      if (options.host) {
        for (const conversationId of ['conversation-1', 'conversation-2']) {
          await terminateHost(hostRuntimeDir, `claude-${conversationId}`, context.log, { closeGraceMs: 300, termGraceMs: 300, staleTermGraceMs: 300 }).catch(() => undefined);
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  live.add(setup);
  return setup;
}

export async function cleanupAll(): Promise<void> {
  await Promise.allSettled([...live].map((setup) => setup.cleanup()));
}

export function readLog(file: string): LogLine[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogLine);
}

/** Frames the fake received, in order. */
export function receivedFrames(file: string): Array<Record<string, any>> {
  return readLog(file)
    .filter((entry) => entry.dir === 'in' && entry.frame)
    .map((entry) => entry.frame!);
}

export function sentFrames(file: string): Array<Record<string, any>> {
  return readLog(file)
    .filter((entry) => entry.dir === 'out' && entry.frame)
    .map((entry) => entry.frame!);
}

export function receivedControls(file: string, subtype?: string): Array<Record<string, any>> {
  return receivedFrames(file).filter((frame) => frame.type === 'control_request' && (subtype === undefined || frame.request?.subtype === subtype));
}

export function receivedUserFrames(file: string): Array<Record<string, any>> {
  return receivedFrames(file).filter((frame) => frame.type === 'user');
}

/** The `control_response` frames the fake received (answers to its own server requests). */
export function receivedResponses(file: string): Array<Record<string, any>> {
  return receivedFrames(file).filter((frame) => frame.type === 'control_response');
}

export function startEntries(file: string): LogLine[] {
  return readLog(file).filter((entry) => entry.dir === 'start');
}

export async function waitUntil<T>(probe: () => T | undefined | false, timeoutMs = 5_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Consumes a session's event stream into an array and lets a test wait for events. */
export class EventLog {
  readonly events: TransportEvent[] = [];
  readonly done: Promise<void>;
  private ended = false;

  constructor(session: TransportSession) {
    this.done = (async () => {
      for await (const event of session.events) this.events.push(event);
      this.ended = true;
    })();
  }

  get isDone(): boolean {
    return this.ended;
  }

  of<T extends TransportEvent['type']>(type: T): Array<Extract<TransportEvent, { type: T }>> {
    return this.events.filter((event): event is Extract<TransportEvent, { type: T }> => event.type === type);
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }

  /** Terminal events for one turn (must never be more than one). */
  terminalsOf(turnId: string): Array<Extract<TransportEvent, { type: 'turn.terminal' }>> {
    return this.of('turn.terminal').filter((event) => event.turnId === turnId);
  }

  indexOf(predicate: (event: TransportEvent) => boolean): number {
    return this.events.findIndex(predicate);
  }

  waitFor<T extends TransportEvent>(predicate: (event: TransportEvent) => event is T, timeoutMs?: number): Promise<T>;
  waitFor(predicate: (event: TransportEvent) => boolean, timeoutMs?: number): Promise<TransportEvent>;
  async waitFor(predicate: (event: TransportEvent) => boolean, timeoutMs = 5_000): Promise<TransportEvent> {
    return waitUntil(() => this.events.find(predicate), timeoutMs, 'a transport event');
  }

  waitForType<T extends TransportEvent['type']>(type: T, timeoutMs?: number): Promise<Extract<TransportEvent, { type: T }>> {
    return this.waitFor((event): event is Extract<TransportEvent, { type: T }> => event.type === type, timeoutMs);
  }

  waitForTerminal(turnId: string, timeoutMs?: number): Promise<Extract<TransportEvent, { type: 'turn.terminal' }>> {
    return this.waitFor((event): event is Extract<TransportEvent, { type: 'turn.terminal' }> => event.type === 'turn.terminal' && event.turnId === turnId, timeoutMs);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Transcript and registry fixtures

export function transcriptPathFor(configDir: string, cwd: string, sessionId: string): string {
  return path.join(configDir, 'projects', escapeProjectDir(cwd)!, `${sessionId}.jsonl`);
}

/** Writes a transcript with a conversation (or, with `conversation: false`, only preamble lines). */
export function writeTranscript(configDir: string, cwd: string, sessionId: string, conversation = true): string {
  const file = transcriptPathFor(configDir, cwd, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [{ type: 'file-history-snapshot', messageId: 'm1' }, { type: 'summary', summary: 'x' }];
  if (conversation) lines.push({ type: 'user', message: { role: 'user', content: 'hello' } } as never, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } as never);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

export function writeRegistryFile(configDir: string, entry: { pid: number; sessionId: string; procStart?: string; cwd?: string }): string {
  const directory = path.join(configDir, 'sessions');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${entry.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ kind: 'interactive', entrypoint: 'sdk-cli', status: 'idle', ...entry }));
  return file;
}

// ---------------------------------------------------------------------------------------------------------
// Scenario builders

export const QUESTION_INPUT = {
  questions: [
    { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'embedded' }], multiSelect: false },
    { question: 'Which extras?', header: 'Extras', options: [{ label: 'Cache', description: 'redis' }, { label: 'Queue', description: 'jobs' }], multiSelect: true },
  ],
};

export function canUseTool(toolName: string, input: Record<string, unknown>, toolUseId = 'tool-1', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: toolUseId, ...extra };
}

export function rateLimitEvent(info: Record<string, unknown>): Record<string, unknown> {
  return { emit: { type: 'rate_limit_event', rate_limit_info: info, uuid: 'ffffffff-0000-4000-8000-000000000001', session_id: '{{sessionId}}' } };
}

export const assistantText = (text: string): Record<string, unknown> => ({ assistant: { text } });

export function userText(frame: Record<string, any>): string | undefined {
  const content = frame.message?.content;
  return Array.isArray(content) ? content.find((block: any) => block.type === 'text')?.text : undefined;
}
