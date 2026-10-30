import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAppServerPlugin } from '../../src/providers/transport/codex/index.js';
import type { CodexAppServerInstance } from '../../src/providers/transport/codex/app-server-instance.js';
import type { CodexTimings } from '../../src/providers/transport/codex/app-server-session.js';
import { createLineTransportFactory, terminateHost } from '../../src/providers/transport/line-transport.js';
import type { OpenOptions, PluginContext, TransportEvent, TransportSession } from '../../src/providers/transport/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_APP_SERVER = path.join(here, 'fake-app-server.mjs');
export const REPLAY_APP_SERVER = path.join(here, 'replay-app-server.mjs');
export const FIXTURES = path.join(here, 'codex-fixtures');
/** The session host program, run from source (Node strips the types). Plugin tests use it only where they set `host: true`. */
export const HOST_PROGRAM = path.join(here, '../../src/providers/transport/session-host.ts');

export const FAST_TIMINGS: Partial<CodexTimings> = {
  requestTimeoutMs: 5_000,
  initializeTimeoutMs: 5_000,
  interruptGraceMs: 300,
  queuedStartWaitMs: 1_000,
  closeGraceMs: 300,
  termGraceMs: 300,
};

export const OPEN_OPTIONS: OpenOptions = {
  conversationId: 'conversation-1',
  cwd: '/work/project',
  policy: { approvals: 'never', sandbox: 'full-access' },
};

export interface LogLine {
  dir: 'in' | 'out' | 'event';
  frame?: Record<string, any>;
  response?: Record<string, any>;
  event?: string;
  [key: string]: unknown;
}

export interface TestContext extends PluginContext {
  logs: { info: Array<[object, string]>; warn: Array<[object, string]>; debug: Array<[object, string]> };
  metaStore: Map<string, string>;
}

export function makeContext(runtimeDir: string): TestContext {
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
  };
}

export function makeTempDir(prefix = 'codex-plugin-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Scenario {
  [key: string]: unknown;
  handlers?: Record<string, unknown>;
}

export interface FakeSetup {
  dir: string;
  scenarioPath: string;
  logFile: string;
  context: TestContext;
  instance: CodexAppServerInstance;
  command: string[];
  /** The Console runtime directory the session host files live under (`<runtime>/structured/hosts`). */
  hostRuntimeDir: string;
  /** Ends the session host and its app-server, if this setup started one. Stdio setups have nothing to end. */
  stopHost(): Promise<void>;
}

export interface SetupOptions {
  /** Run the app-server behind a real session host, so it outlives the instance. Default: directly over stdio. */
  host?: boolean;
  /** The idle window of the instance (`structuredSessions.codex.idleUnloadMinutes`). Default: 60. */
  idleUnloadMinutes?: number;
}

export function writeScenario(dir: string, scenario: Scenario): { scenarioPath: string; logFile: string } {
  const logFile = path.join(dir, 'fake.log');
  const scenarioPath = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ logFile, ...scenario }));
  return { scenarioPath, logFile };
}

/** A line transport factory that puts the app-server behind a session host under `runtimeDir`. */
export function hostTransportFactory(runtimeDir: string, context: Pick<PluginContext, 'log'>) {
  return createLineTransportFactory({ runtimeDir, log: context.log, hostProgramPath: HOST_PROGRAM });
}

export function setupFake(scenario: Scenario, timings: Partial<CodexTimings> = FAST_TIMINGS, baseEnv: NodeJS.ProcessEnv = {}, options: SetupOptions = {}): FakeSetup {
  const dir = makeTempDir();
  const { scenarioPath, logFile } = writeScenario(dir, scenario);
  const command = [process.execPath, FAKE_APP_SERVER, scenarioPath];
  const hostRuntimeDir = path.join(dir, 'runtime');
  const context = makeContext(path.join(hostRuntimeDir, 'structured', 'codex'));
  if (options.host) context.lineTransport = hostTransportFactory(hostRuntimeDir, context);
  const plugin = createCodexAppServerPlugin({ timings, baseEnv: { PATH: process.env.PATH, ...baseEnv }, clientVersion: '9.9.9' });
  const instance = plugin.create({ enabled: true, command, idleUnloadMinutes: options.idleUnloadMinutes ?? 60, env: {} }, context) as CodexAppServerInstance;
  const stopHost = async (): Promise<void> => {
    if (options.host) await terminateHost(hostRuntimeDir, 'codex', context.log, { closeGraceMs: 300, termGraceMs: 300, staleTermGraceMs: 300 });
  };
  return { dir, scenarioPath, logFile, context, instance, command, hostRuntimeDir, stopHost };
}

/**
 * A new backend over the same host: a new plugin instance and a new line transport factory with no memory of the
 * old ones, the same database (meta) and runtime. The old instance is not disposed here; the test decides how it ended.
 */
export function restartBackend(setup: FakeSetup, timings: Partial<CodexTimings> = FAST_TIMINGS): { instance: CodexAppServerInstance; context: TestContext } {
  const context = makeContext(setup.context.runtimeDir);
  for (const [key, value] of setup.context.metaStore) context.metaStore.set(key, value);
  context.lineTransport = hostTransportFactory(setup.hostRuntimeDir, context);
  const plugin = createCodexAppServerPlugin({ timings, baseEnv: { PATH: process.env.PATH }, clientVersion: '9.9.9' });
  const instance = plugin.create({ enabled: true, command: setup.command, idleUnloadMinutes: 60, env: {} }, context) as CodexAppServerInstance;
  return { instance, context };
}

export function setupReplay(fixture: string, extraEnv: NodeJS.ProcessEnv = {}): FakeSetup & { replayLog: string } {
  const dir = makeTempDir('codex-replay-');
  const replayLog = path.join(dir, 'replay.log');
  const stateFile = path.join(dir, 'replay-state.json');
  const transcript = path.join(FIXTURES, fixture, 'codex_transcript.ndjson');
  const command = [process.execPath, REPLAY_APP_SERVER, transcript, stateFile];
  const hostRuntimeDir = path.join(dir, 'runtime');
  const context = makeContext(path.join(hostRuntimeDir, 'structured', 'codex'));
  const plugin = createCodexAppServerPlugin({
    timings: FAST_TIMINGS,
    baseEnv: { PATH: process.env.PATH, REPLAY_LOG: replayLog, REPLAY_OPTIONAL_METHODS: 'account/rateLimits/read,thread/backgroundTerminals/list', ...extraEnv },
    clientVersion: '9.9.9',
  });
  const instance = plugin.create({ enabled: true, command, idleUnloadMinutes: 60, env: {} }, context) as CodexAppServerInstance;
  return { dir, scenarioPath: transcript, logFile: replayLog, replayLog, context, instance, command, hostRuntimeDir, stopHost: async () => undefined };
}

export function readLog(file: string): LogLine[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogLine);
}

/** Frames the server received, in order. */
export function receivedFrames(file: string): Array<Record<string, any>> {
  return readLog(file)
    .filter((entry) => entry.dir === 'in' && entry.frame)
    .map((entry) => entry.frame!);
}

export function receivedRequests(file: string, method: string): Array<Record<string, any>> {
  return receivedFrames(file).filter((frame) => frame.method === method);
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

  /** The event types, without the account-level usage windows that arrive whenever the snapshot refreshes. */
  types(): string[] {
    return this.events.filter((event) => !(event.type === 'usage.updated' && event.windows)).map((event) => event.type);
  }

  waitFor<T extends TransportEvent>(predicate: (event: TransportEvent) => event is T, timeoutMs?: number): Promise<T>;
  waitFor(predicate: (event: TransportEvent) => boolean, timeoutMs?: number): Promise<TransportEvent>;
  async waitFor(predicate: (event: TransportEvent) => boolean, timeoutMs = 5_000): Promise<TransportEvent> {
    return waitUntil(() => this.events.find(predicate), timeoutMs, 'a transport event');
  }

  waitForType<T extends TransportEvent['type']>(type: T, timeoutMs?: number): Promise<Extract<TransportEvent, { type: T }>> {
    return this.waitFor((event): event is Extract<TransportEvent, { type: T }> => event.type === type, timeoutMs);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Wire builders

export function threadResult(id = 'thread-1', transcriptPath: string | null = '/rollout/thread-1.jsonl'): Record<string, unknown> {
  return {
    thread: {
      id,
      sessionId: id,
      forkedFromId: null,
      parentThreadId: null,
      preview: '',
      ephemeral: false,
      historyMode: 'paginated',
      modelProvider: 'openai',
      model: 'gpt-test',
      reasoningEffort: null,
      createdAt: 1790000000,
      updatedAt: 1790000000,
      recencyAt: 1790000000,
      status: { type: 'idle' },
      path: transcriptPath,
      cwd: '/work/project',
      cliVersion: '0.164.0',
      originator: 'agent_console',
      source: 'vscode',
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: 'gpt-test',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/work/project',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: null,
  };
}

export function turnObject(id: string, status = 'inProgress', startedAt: number | null = 1790000001, error: unknown = null): Record<string, unknown> {
  return { id, rootTurnId: id, items: [], itemsView: 'notLoaded', status, error, startedAt, completedAt: null, durationMs: null };
}

export function notification(method: string, params: unknown, delayMs?: number): Record<string, unknown> {
  return { ...(delayMs ? { delayMs } : {}), frame: { method, params, emittedAtMs: 1790000000000 } };
}

export function serverRequest(method: string, params: unknown): Record<string, unknown> {
  return { frame: { id: 'auto', method, params } };
}

export const turnStarted = (threadId: string, turnId: string, delayMs?: number) =>
  notification('turn/started', { threadId, turn: turnObject(turnId, 'inProgress', 1790000001) }, delayMs);

export const turnCompleted = (threadId: string, turnId: string, status: 'completed' | 'interrupted' | 'failed' = 'completed', error: unknown = null, delayMs?: number) =>
  notification('turn/completed', { threadId, turn: turnObject(turnId, status, 1790000001, error) }, delayMs);

export const userMessageItem = (id: string, text: string) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text, text_elements: [] }] });
export const agentMessageItem = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null });
export const commandItem = (id: string, processId: string | null, status = 'inProgress', command = 'sleep 30') => ({
  type: 'commandExecution',
  id,
  pluginId: null,
  scriptPath: null,
  command,
  cwd: '/work/project',
  processId,
  source: 'agent',
  status,
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
});

export const itemStarted = (threadId: string, turnId: string, item: Record<string, unknown>, delayMs?: number) =>
  notification('item/started', { item, threadId, turnId, startedAtMs: 1 }, delayMs);
export const itemCompleted = (threadId: string, turnId: string, item: Record<string, unknown>, delayMs?: number) =>
  notification('item/completed', { item, threadId, turnId, completedAtMs: 2 }, delayMs);

export function tokenUsage(threadId: string, turnId: string, lastTotal: number, window: number | null = 258_400): Record<string, unknown> {
  const breakdown = (total: number) => ({ totalTokens: total, inputTokens: total - 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 });
  return notification('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: breakdown(lastTotal * 2), last: breakdown(lastTotal), modelContextWindow: window } });
}

export function rateLimitSnapshot(partial: Record<string, unknown>): Record<string, unknown> {
  return { limitId: 'codex', limitName: null, normalModelSlug: null, primary: null, secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: 'pro', rateLimitReachedType: null, ...partial };
}

export const rateLimitsRead = (snapshot: Record<string, unknown>) => ({ result: { ordinaryUsageAllowed: true, rateLimits: snapshot, rateLimitsByLimitId: null } });

/** Minimal scenario: a thread that answers `turn/start` with a started turn. Tests spread over it. */
export function baseHandlers(threadId = 'thread-1', transcriptPath: string | null = '/rollout/thread-1.jsonl'): Record<string, unknown> {
  return {
    'account/rateLimits/read': rateLimitsRead(rateLimitSnapshot({ primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1900000000 } })),
    'thread/start': { result: threadResult(threadId, transcriptPath) },
    'thread/resume': { result: { ...threadResult(threadId, transcriptPath), turnsBackwardsCursor: null, itemsBackwardsCursor: null } },
    'thread/unsubscribe': { result: { status: 'unsubscribed' } },
  };
}
