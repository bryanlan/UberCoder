// One shared `codex app-server` process (stdio JSON-RPC) serving many threads, as a `TransportInstance`.
//
// The process runs behind a session host (`../session-host.ts`, reached through the `LineTransport` the Console
// context provides), so it outlives a Console backend restart: the first use after a restart reconnects to the
// running process instead of spawning a second one, and skips the handshake when the process has already been used.
// Without a context transport (tests, embedding) the child is run directly over stdio and dies with the instance.
// All thread-scoped notifications and server requests are routed to the owning session by `threadId`; frames for a
// thread no session owns (subagent children, late events) are counted and logged at debug level and never merged
// into another session. When the process ends or the connection to its host drops, every open session sees
// `session.state: 'error'` and then `'stopped'`, and the next use connects again (a new process only when the old
// one is gone, or has stayed silent for APP_SERVER_UNRESPONSIVE_LIMIT_MS: failed the handshake check, or left requests on
// the live connection unanswered, which lets go of that connection so the next use runs the check).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StructuredProviderConfig } from '../../../config/schema.js';
import {
  LineTransportNotRunningError,
  ResumeFailedError,
  TransportBusyError,
  TransportUnavailableError,
  type LineTransport,
  type LineTransportFactory,
  type OpenOptions,
  type PluginContext,
  type ProviderFailure,
  type TransportInstance,
} from '../types.js';
import {
  createStdioLineTransportFactory,
  HostLineTransport,
  LineTransportSpawnError,
  transportOutlivesClose,
  transportStartedFresh,
  type LineTransportExit,
  type LineTransportRequest,
  type ManagedLineTransport,
} from '../line-transport.js';
import { isArchivedThreadError } from './errors.js';
import { describeExit, exitReason, JsonRpcClient, JsonRpcExitError, JsonRpcRequestError, JsonRpcSpawnError, JsonRpcTimeoutError, requestIdCounter, type JsonRpcExit, type JsonRpcId, type JsonRpcNotification } from './jsonrpc.js';
import {
  callCodex,
  INITIALIZED_NOTIFICATION,
  type CodexNotificationMap,
  type CodexServerRequestMethod,
  type InitializeParams,
  type ModelListResponse,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadStartResponse,
} from './protocol.js';
import {
  approvalPolicyFor,
  CodexAppServerSession,
  CODEX_CAPABILITIES,
  DEFAULT_TIMINGS,
  declinedServerRequest,
  pendingQuestions,
  sandboxModeFor,
  toTransportError,
  type CodexLogger,
  type CodexSessionHost,
  type CodexTimings,
} from './app-server-session.js';
import { currentBootId, processStartTicks } from './process-lifetime.js';
import { CodexRestartState, type CommandRecord } from './restart-state.js';
import { mergeRateLimits, type CodexRateLimitSnapshot } from './usage.js';

/**
 * `structuredSessions.codex` in the Console config. The plugin uses `command` and `env` (the host merges the
 * Console's coordination variables into `env` first); `enabled` and `idleUnloadMinutes` are the host's.
 */
export type CodexStructuredConfig = StructuredProviderConfig;

/** Test and embedding hooks. Production code passes none of them. */
export interface CodexPluginOptions {
  timings?: Partial<CodexTimings>;
  /** The environment the child inherits. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Reported to Codex as the client version. Defaults to the server package version. */
  clientVersion?: string;
  /** The clock for {@link APP_SERVER_UNRESPONSIVE_LIMIT_MS}, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/** What the backend knows of the app-server it is connected to: `{ pid, startTicks, bootId, startedAt, version }`. The session host's record file, not this, decides which process is adopted or ended. */
export const INSTANCE_META_KEY = 'structured-instance:codex';
/**
 * How long a running app-server may fail the handshake check before the next ordinary start replaces it. Until then a timeout
 * only lets go of the connection and reports busy: the process may just be slow, and ending it ends every turn and command it runs.
 * A process that stays silent for this long is taken for hung.
 */
export const APP_SERVER_UNRESPONSIVE_LIMIT_MS = 5 * 60_000;
/**
 * How many requests in a row may time out on the live connection (with no answer between) before the connection is let go of.
 * A hung app-server keeps its connection open, and a live connection is never checked again, so without this bound nothing would
 * ever notice: the next use would reconnect through `startClient`, whose check is bounded by {@link APP_SERVER_UNRESPONSIVE_LIMIT_MS}.
 */
export const LIVE_CLIENT_TIMEOUT_LIMIT = 3;

/**
 * What must outlive one instance. The service disposes an instance that never connected after every failed open, and the plugin
 * builds a new one for the next open, so neither can live on the instance: the run of timeouts would start again at zero each
 * time and never reach {@link APP_SERVER_UNRESPONSIVE_LIMIT_MS}, and request ids would start at 1 again while a late answer to an
 * abandoned connection is still on its way. The plugin keeps one per Console and hands it to every instance it creates.
 */
export interface AppServerContinuity {
  /** The id of the next JSON-RPC request, for every connection of this Console's app-server. */
  readonly nextRequestId: () => number;
  /**
   * When the first of the current run of timeouts happened: handshake checks on ordinary starts, then requests on the live
   * connection. An answer from the process ends the run.
   */
  unresponsiveSince: number | undefined;
}

export function createAppServerContinuity(): AppServerContinuity {
  return { nextRequestId: requestIdCounter(), unresponsiveSince: undefined };
}
/** Identity of the session host that holds the shared app-server. */
const HOST_ID = 'codex';
const CLIENT_NAME = 'agent_console';
const ORIGINATOR = 'agent_console';

/** Requests whose params carry a `threadId` and that must be answered. */
const THREAD_SERVER_REQUESTS: CodexServerRequestMethod[] = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
];

/** Account-level notifications with no thread. Anything else without a thread id is also treated as global. */
const GLOBAL_NOTIFICATIONS = new Set(['account/updated', 'account/login/completed', 'remoteControl/status/changed', 'skills/changed', 'app/list/updated']);

function packageVersion(): string {
  try {
    const file = new URL('../../../../package.json', import.meta.url);
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function expandHome(value: string, home: string = os.homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

/**
 * The shared process serves every thread, so it must not carry the identity of one session: a stale
 * `AGENT_CONSOLE_SESSION_ID` or `CODEX_THREAD_ID` in the Console's own environment (or the configured `env`)
 * would be inherited by every hook process. Configured values win over the inherited environment, and `~`
 * in them is expanded; `CODEX_HOME` is always expanded because spawn does
 * not expand `~` and Codex would reject it.
 */
export function buildAppServerEnv(base: NodeJS.ProcessEnv, home: string = os.homedir(), extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, expandHome(value, home)])),
  };
  delete env.AGENT_CONSOLE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  if (env.CODEX_HOME) env.CODEX_HOME = expandHome(env.CODEX_HOME, home);
  env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = ORIGINATOR;
  return env;
}

/**
 * Per-thread config overrides. Codex waits only about one second for optional MCP servers before the first
 * model request; the grace period lets the coordination MCP server from the user's config.toml finish
 * starting first (the value T3 Code uses).
 */
export function threadConfig(options: Pick<OpenOptions, 'effort'>): NonNullable<ThreadStartParams['config']> {
  return { mcp_optional_startup_grace_ms: 10_000, features: { step_model_switching: true }, ...(options.effort ? { model_reasoning_effort: options.effort } : {}) };
}

/**
 * The app-server argv: the configured command, then the update check off, then (when coordination is on) this
 * Console's coordination MCP server. Codex starts that server from `~/.codex/config.toml`, whose entry names one
 * fixed runtime and checkout; the overrides point the agent's `agent_coordination` calls at this Console. There is no
 * `AGENT_CONSOLE_SESSION_ID`: the process serves every thread.
 */
export function buildAppServerCommand(command: string[], coordination?: PluginContext['coordination']): string[] {
  return [
    ...command,
    '-c', 'check_for_update_on_startup=false',
    ...(coordination ? [
      '-c', 'mcp_servers.agent_console_coordination.command="node"',
      '-c', `mcp_servers.agent_console_coordination.args=${JSON.stringify([coordination.helperPath, 'mcp'])}`,
      '-c', `mcp_servers.agent_console_coordination.env.AGENT_COORD_RUNTIME=${JSON.stringify(coordination.runtimeDir)}`,
    ] : []),
  ];
}

function threadIdOf(method: string, params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const record = params as Record<string, unknown>;
  if (typeof record.threadId === 'string') return record.threadId;
  if (method === 'thread/started') {
    const thread = record.thread as { id?: unknown } | undefined;
    if (typeof thread?.id === 'string') return thread.id;
  }
  return undefined;
}

function cliVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  // "<clientName>/<cli version> (<os>...) ..."
  return userAgent?.match(/^[^/\s]+\/(\S+)/)?.[1];
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JsonRpcTimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function recordedVersion(stored: string | undefined): string | undefined {
  if (!stored) return undefined;
  try {
    const version = (JSON.parse(stored) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

function isMissingBinary(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  if (error instanceof JsonRpcSpawnError || cause instanceof JsonRpcSpawnError) {
    const spawn = error instanceof JsonRpcSpawnError ? error : (cause as JsonRpcSpawnError);
    return (spawn.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  }
  return false;
}

/** The lines a session host replayed on connect, oldest first, each with the host's sequence number. */
interface ReplayedLines {
  firstSeq: number;
  /** The newest sequence number the host had when the connection was made: everything up to it is replay, everything after it is live. */
  newestSeq: number;
  lines: Array<{ seq: number; line: string }>;
}

/**
 * A host connection whose replayed lines were taken off already: the lines that came behind them are delivered first, then live
 * output. A line is replay when its sequence number is at or below the host's newest at connect time (`replayBoundary`). A replayed
 * line that arrives late (the host answered `status` slowly, or not at all) is dropped here, never handed to the client as live.
 */
class ReplayGate implements ManagedLineTransport {
  readonly outlivesClose: boolean;
  private pending: string[];

  constructor(private readonly inner: HostLineTransport, pending: string[], private readonly replayBoundary: number) {
    this.outlivesClose = inner.outlivesClose;
    this.pending = pending;
  }

  get pid(): number | undefined {
    return this.inner.pid;
  }

  write(line: string): Promise<void> {
    return this.inner.write(line);
  }

  onLine(listener: (line: string) => void): () => void {
    const pending = this.pending;
    this.pending = [];
    for (const line of pending) {
      try {
        listener(line);
      } catch {
        // The listener owns its own errors; one line never stops the stream.
      }
    }
    return this.inner.onLine((line, seq) => {
      if (seq !== undefined && seq <= this.replayBoundary) return; // replay that came after the gate was built
      listener(line);
    });
  }

  onExit(listener: (info: LineTransportExit) => void): () => void {
    return this.inner.onExit(listener);
  }

  stderrTail(): string {
    return this.inner.stderrTail();
  }

  close(options?: { terminate?: boolean }): Promise<void> {
    return this.inner.close(options);
  }
}

export class CodexAppServerInstance implements TransportInstance, CodexSessionHost {
  readonly plugin = 'codex';
  readonly capabilities = CODEX_CAPABILITIES;
  readonly log: CodexLogger;
  readonly timings: CodexTimings;

  /** Frames for thread ids no session owns, by method. Subagent children show up here. */
  readonly unknownThreadFrames = { notifications: 0, serverRequests: 0, byMethod: new Map<string, number>() };

  private readonly config: CodexStructuredConfig;
  private readonly context: PluginContext;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly clientVersion: string;
  private readonly now: () => number;
  private readonly openTransport: LineTransportFactory;
  private readonly sessions = new Map<string, CodexAppServerSession>();
  /** What the next backend needs to pick up the app-server's work (questions, running turns, replay cursor), kept in the database. */
  private readonly restart: CodexRestartState;
  /** The session host connection the client reads, for its replay cursor. Absent over stdio. */
  private hostTransport: HostLineTransport | undefined;
  private hostStartTicks: string | undefined;
  private cursorTimer: NodeJS.Timeout | undefined;
  /** Ends an app-server that has had no thread loaded for the idle window; see {@link armIdleRecycle}. */
  private idleRecycleTimer: NodeJS.Timeout | undefined;
  /** The recycle in flight: an open waits for the old process to end before it starts a new one. */
  private recycling: Promise<void> | undefined;
  private lastSavedSeq = -1;
  private clientRef: JsonRpcClient | undefined;
  /** The request ids and the run of timeouts, shared with the instances this Console's plugin created before and will create after this one. */
  private readonly continuity: AppServerContinuity;
  /** The live connection that was let go of after repeated timeouts and is closing (see {@link LIVE_CLIENT_TIMEOUT_LIMIT}). */
  private releasedClient: JsonRpcClient | undefined;
  /** The start of the connection in flight, and whether it may only attach to a running host. */
  private starting: { promise: Promise<JsonRpcClient>; attachOnly: boolean } | undefined;
  private rateLimitSnapshot: CodexRateLimitSnapshot | undefined;
  private cliVersion: string | undefined;
  private disposed = false;
  private respawnNeeded = false;
  private warnedSessionEnv = false;
  /** True while the connected transport leaves the process running when it closes (a session host holds it). */
  private processOutlivesClose = false;

  constructor(config: CodexStructuredConfig, context: PluginContext, options: CodexPluginOptions, continuity: AppServerContinuity) {
    this.config = config;
    this.continuity = continuity;
    this.context = context;
    this.log = context.log;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.baseEnv = options.baseEnv ?? process.env;
    this.clientVersion = options.clientVersion ?? packageVersion();
    this.now = options.now ?? Date.now;
    this.restart = new CodexRestartState(context.meta);
    this.openTransport = context.lineTransport ?? createStdioLineTransportFactory({ log: { warn: (fields, message) => context.log.warn(fields, message) } });
    this.armIdleRecycle(); // a survivor nobody loads within the window is ended too
  }

  /** True after the process ended or the connection to it dropped: the next use connects again. */
  get needsRespawn(): boolean {
    return this.respawnNeeded;
  }

  /** Threads currently routed to a session. */
  get openThreadIds(): string[] {
    return [...this.sessions.keys()];
  }

  // -------------------------------------------------------------------------------------------------------
  // CodexSessionHost

  client(): JsonRpcClient {
    if (!this.clientRef || this.clientRef.exited || this.clientRef.closeRequested) throw new TransportUnavailableError('The Codex app-server is not running.');
    return this.clientRef;
  }

  rateLimits(): CodexRateLimitSnapshot | undefined {
    return this.rateLimitSnapshot;
  }

  release(session: CodexAppServerSession): void {
    if (this.sessions.get(session.nativeSessionId) === session) this.sessions.delete(session.nativeSessionId);
    if (this.sessions.size === 0) this.armIdleRecycle();
  }

  /**
   * The app-server keeps every thread it ever loaded in memory after `thread/unsubscribe`, together with that thread's MCP
   * servers (one coordination helper per thread, about 40 MB each); only `thread/archive` unloads a thread, and archiving moves
   * its rollout (probe of 2026-10-30, codex-cli 0.164.0). So once no conversation has had a thread loaded here for the idle
   * window (`idleUnloadMinutes`, the window after which an idle thread is unloaded) the app-server and its session host are
   * ended, and the next open starts a fresh one that resumes threads from their rollouts. Ending it also ends the background
   * terminals of idle threads, which is what idle sleep is for. A loaded thread cancels the recycle; a start in flight
   * postpones it; a disposed instance never recycles (the next backend's instance arms its own timer).
   */
  private armIdleRecycle(): void {
    this.clearIdleRecycle();
    const afterMs = this.config.idleUnloadMinutes * 60_000;
    if (this.disposed || this.sessions.size > 0 || !(afterMs > 0)) return;
    this.idleRecycleTimer = setTimeout(() => {
      this.idleRecycleTimer = undefined;
      void this.recycleIdleAppServer().catch((error: unknown) => {
        this.log.warn({ error: error instanceof Error ? error.message : String(error) }, 'ending the idle codex app-server failed');
      });
    }, afterMs);
    this.idleRecycleTimer.unref();
  }

  private clearIdleRecycle(): void {
    if (this.idleRecycleTimer) clearTimeout(this.idleRecycleTimer);
    this.idleRecycleTimer = undefined;
  }

  private async recycleIdleAppServer(): Promise<void> {
    if (this.disposed || this.sessions.size > 0) return;
    if (this.starting || this.recycling) {
      this.armIdleRecycle();
      return;
    }
    const client = this.clientRef;
    const run = async (): Promise<void> => {
      if (client && !client.exited && !client.closeRequested) {
        // A planned end, like `dispose`: forget the client first so its exit is not taken for a lost process.
        this.clientRef = undefined;
        this.stopCursorTimer();
        this.hostTransport = undefined;
        this.restart.reset();
        this.context.meta.delete(INSTANCE_META_KEY);
        this.respawnNeeded = true;
        this.log.info({ idleMinutes: this.config.idleUnloadMinutes }, 'ending the codex app-server: no thread has been loaded on it for the idle window, and the threads it still holds keep their MCP servers running');
        await client.close({ terminate: true });
        return;
      }
      // Not connected (or a connection already being let go of): a running host nobody adopted is ended from its record;
      // without a record there is nothing to end. The process is gone afterwards, and so are the questions and turns it held.
      const endHost = this.context.endHost;
      if (!endHost) return;
      await endHost(HOST_ID, { closeGraceMs: this.timings.closeGraceMs, termGraceMs: this.timings.termGraceMs, staleTermGraceMs: this.timings.staleTermGraceMs });
      this.restart.reset();
      this.context.meta.delete(INSTANCE_META_KEY);
      this.respawnNeeded = true;
    };
    this.recycling = run();
    try {
      await this.recycling;
    } finally {
      this.recycling = undefined;
    }
  }

  noteTurn(threadId: string, turnId: string | undefined): void {
    this.restart.noteTurn(threadId, turnId);
    this.saveCursor(); // a turn boundary: the next backend must not see this one's lines again
  }

  readonly questions = {
    save: (record: Parameters<CodexRestartState['saveQuestion']>[0]): void => this.restart.saveQuestion(record),
    remove: (requestId: string): void => this.restart.removeQuestion(requestId),
  };

  readonly commands = {
    recorded: (threadId: string): ReturnType<CodexRestartState['commands']> => this.restart.commands(threadId),
    note: (threadId: string, itemId: string, record: CommandRecord): void => this.restart.noteCommand(threadId, itemId, record),
    forget: (threadId: string, itemId: string): void => this.restart.forgetCommand(threadId, itemId),
    drop: (threadId: string): void => this.restart.dropThreadCommands(threadId),
  };

  // -------------------------------------------------------------------------------------------------------
  // TransportInstance

  async alive(): Promise<{ pid?: number; connected: boolean }> {
    const client = this.clientRef;
    return { ...(client?.pid !== undefined ? { pid: client.pid } : {}), connected: client !== undefined && !client.exited };
  }

  async probe(): Promise<{ installed: boolean; version?: string; auth: 'ok' | 'missing' | 'unknown'; models: Array<{ id: string; label: string; efforts?: string[] }> }> {
    const deadline = Date.now() + this.timings.probeDeadlineMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    let client: JsonRpcClient;
    try {
      client = await withDeadline(this.ensureClient(), left(), 'codex app-server start');
    } catch (error) {
      if (isMissingBinary(error)) return { installed: false, auth: 'unknown', models: [] };
      throw error;
    }
    let auth: 'ok' | 'missing' | 'unknown' = 'unknown';
    try {
      const account = await callCodex(client, 'account/read', {}, { timeoutMs: left() });
      auth = account.account === null && account.requiresOpenaiAuth ? 'missing' : 'ok';
    } catch (error) {
      this.log.warn({ error: error instanceof Error ? error.message : String(error) }, 'codex account/read failed during probe');
    }
    const models: Array<{ id: string; label: string; efforts?: string[] }> = [];
    try {
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const response: ModelListResponse = await callCodex(client, 'model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, { timeoutMs: left() });
        for (const model of response.data) {
          if (model.hidden) continue;
          models.push({
            id: model.model,
            label: model.displayName || model.model,
            efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
          });
        }
        cursor = response.nextCursor;
        if (!cursor) break;
      }
    } catch (error) {
      this.log.warn({ error: error instanceof Error ? error.message : String(error) }, 'codex model/list failed during probe');
    }
    return { installed: true, ...(this.cliVersion ? { version: this.cliVersion } : {}), auth, models };
  }

  async start(options: OpenOptions): Promise<CodexAppServerSession> {
    const client = await this.ensureClient();
    this.noteSessionEnv(options);
    const params: ThreadStartParams = {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      approvalPolicy: approvalPolicyFor(options.policy),
      sandbox: sandboxModeFor(options.policy),
      approvalsReviewer: 'user',
      config: threadConfig(options),
      ephemeral: false,
    };
    let session: CodexAppServerSession | undefined;
    try {
      // Registered inside the response hook so notifications queued right behind the response find the session.
      await callCodex(client, 'thread/start', params, {
        timeoutMs: this.timings.requestTimeoutMs,
        onResult: (result) => {
          session = this.register(result, options);
        },
      });
    } catch (error) {
      throw toTransportError(error);
    }
    if (!session) throw new TransportUnavailableError('thread/start returned no thread.');
    return session;
  }

  /**
   * After a backend restart: picks the thread up again when the app-server it ran in is still running behind its session host,
   * and resolves undefined when no host answers. It connects to a running host only (nothing is started, here or in the resume
   * that follows), then resumes the thread, which adopts a turn the thread is still running (see
   * {@link CodexAppServerSession.adopt}). A host that runs but does not answer in time, or whose app-server is slow to answer the
   * handshake check, is left alone and reported as {@link TransportBusyError}: it is not "no survivor", because the turn may well
   * be running in it. The rule is stated on {@link TransportBusyError} in `../types.ts`. This call never ends the process, however long
   * it stays silent; an ordinary start does after {@link APP_SERVER_UNRESPONSIVE_LIMIT_MS}.
   */
  async reattach(nativeSessionId: string, options: OpenOptions): Promise<CodexAppServerSession | undefined> {
    try {
      await this.ensureClient(true);
      return await this.resumeThread(nativeSessionId, options, true);
    } catch (error) {
      if (!(error instanceof LineTransportNotRunningError)) throw error;
      if (error.reason === 'unreachable') throw new TransportBusyError('The running Codex app-server did not answer in time. It was left alone; try again in a moment.');
      return undefined;
    }
  }

  async resume(nativeSessionId: string, options: OpenOptions): Promise<CodexAppServerSession> {
    return this.resumeThread(nativeSessionId, options, false);
  }

  /** `attachOnly`: the connection is made to a running host or not at all (see {@link reattach}). */
  private async resumeThread(nativeSessionId: string, options: OpenOptions, attachOnly: boolean): Promise<CodexAppServerSession> {
    const client = await this.ensureClient(attachOnly);
    this.noteSessionEnv(options);
    const params: ThreadResumeParams = {
      threadId: nativeSessionId,
      excludeTurns: true,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      approvalPolicy: approvalPolicyFor(options.policy),
      approvalsReviewer: 'user',
      sandbox: sandboxModeFor(options.policy),
      config: threadConfig(options),
    };
    let session: CodexAppServerSession | undefined;
    const attempt = (): Promise<unknown> =>
      callCodex(client, 'thread/resume', params, {
        timeoutMs: this.timings.requestTimeoutMs,
        onResult: (result) => {
          session = this.register(result, options);
        },
      });
    try {
      try {
        await attempt();
      } catch (error) {
        if (!isArchivedThreadError(error)) throw error;
        // An archived thread cannot be resumed; unarchive it and try once more.
        await callCodex(client, 'thread/unarchive', { threadId: nativeSessionId }, { timeoutMs: this.timings.requestTimeoutMs });
        await attempt();
      }
    } catch (error) {
      if (error instanceof JsonRpcRequestError) {
        const failure = new ResumeFailedError(`Codex could not resume thread ${nativeSessionId}: ${error.message}`);
        failure.cause = error;
        throw failure;
      }
      throw toTransportError(error);
    }
    if (!session) throw new ResumeFailedError(`Codex returned no thread for ${nativeSessionId}.`);
    // What an earlier backend left on the thread: a turn that is still running, one that ended meanwhile, a pending question.
    await (session as CodexAppServerSession).adopt({
      trackedTurnId: this.restart.trackedTurn(nativeSessionId),
      held: this.restart.questionsForThread(nativeSessionId),
    });
    return session;
  }

  async dispose(reason: 'shutdown' | 'restart'): Promise<void> {
    if (reason === 'shutdown') this.disposed = true;
    this.clearIdleRecycle();
    if (this.recycling) await this.recycling.catch(() => undefined);
    if (this.starting) await this.starting.promise.catch(() => undefined);
    const client = this.clientRef;
    this.clientRef = undefined;
    // A process held by a session host keeps running and keeps waiting for the answers to its questions: they stay held for the
    // next backend. Answering them with nothing here would race the socket closing, and the app-server would wait for ever.
    for (const session of [...this.sessions.values()]) session.endLocal({ keepQuestions: this.processOutlivesClose });
    this.sessions.clear();
    this.stopCursorTimer();
    // A stdio child dies with its channel. A process held by a session host keeps running, and so does its record.
    if (client) {
      if (this.processOutlivesClose) this.saveCursor();
      else this.restart.reset();
      await client.close();
      if (!this.processOutlivesClose) this.context.meta.delete(INSTANCE_META_KEY);
    }
    this.hostTransport = undefined;
  }

  // -------------------------------------------------------------------------------------------------------
  // Process

  /**
   * `attachOnly`: connect to a running host and start nothing; rejects with {@link LineTransportNotRunningError} when there is none.
   * An attach-only caller and an ordinary one never share a failed attempt: an ordinary caller that finds an attach-only start
   * ended without a host starts one itself, and an attach-only caller that finds an ordinary start in flight waits for it and
   * uses the connection it made (it started nothing).
   */
  private async ensureClient(attachOnly = false): Promise<JsonRpcClient> {
    for (;;) {
      if (this.disposed) throw new TransportUnavailableError('The Codex app-server instance was shut down.');
      if (this.recycling) await this.recycling.catch(() => undefined); // the old process ends before a new one starts
      const live = this.clientRef;
      if (live && !live.exited) {
        if (!live.closeRequested) return live;
        // Being let go of after repeated timeouts. Wait until it has ended, so its sessions are told before a new connection replaces it.
        await live.close();
        if (this.clientRef === live && !live.exited) throw new TransportUnavailableError('The connection to the Codex app-server did not close in time.');
        continue;
      }
      let attempt = this.starting;
      if (!attempt) {
        const promise = this.startClient(attachOnly);
        attempt = { promise, attachOnly };
        this.starting = attempt;
        const done = (): void => {
          if (this.starting === attempt) this.starting = undefined;
        };
        promise.then(done, done);
      }
      try {
        return await attempt.promise;
      } catch (error) {
        if (attempt.attachOnly && !attachOnly && error instanceof LineTransportNotRunningError) continue;
        throw error;
      }
    }
  }

  private async startClient(attachOnly = false): Promise<JsonRpcClient> {
    const cwd = this.context.runtimeDir;
    fs.mkdirSync(cwd, { recursive: true });
    const env = buildAppServerEnv(this.baseEnv, os.homedir(), this.config.env);
    const argv = buildAppServerCommand(this.config.command, this.context.coordination);
    // An earlier backend connected to a process that may still run. Ask the host for everything it still has buffered, so the
    // requests that arrived while no backend listened can be read (see `absorbReplay`).
    const replayWanted = this.context.meta.get(INSTANCE_META_KEY) !== undefined;
    const request: LineTransportRequest = {
      argv,
      cwd,
      env: stringEnv(env),
      hostId: HOST_ID,
      closeGraceMs: this.timings.closeGraceMs,
      termGraceMs: this.timings.termGraceMs,
      staleTermGraceMs: this.timings.staleTermGraceMs,
    };
    let transport: LineTransport;
    try {
      // Reconnects to the running host when there is one (same command), otherwise starts it. The npm launcher runs the
      // native app-server as its child; the host signals the whole process group, so both end together.
      transport = await this.openHostTransport(request, attachOnly, replayWanted);
    } catch (error) {
      throw toTransportError(error instanceof LineTransportSpawnError ? new JsonRpcSpawnError(argv[0] ?? '', error) : error);
    }
    const fresh = transportStartedFresh(transport);
    // The lines the host replays are history: the client must see only what happens from now on. An attach-only start asks for the
    // replay whether or not a record of the instance was saved (see `openHostTransport`), so it separates it as well: the replay
    // holds an earlier backend's answers, and ids start at 1 again in a new backend (within one backend they never repeat), so a
    // replayed response would otherwise answer a request of the new connection.
    let clientTransport: LineTransport = transport;
    let replay: ReplayedLines | undefined;
    if (transport instanceof HostLineTransport && (replayWanted || attachOnly)) {
      const separated = await this.separateReplay(transport);
      clientTransport = separated.transport;
      replay = separated.replay;
    }
    const client: JsonRpcClient = new JsonRpcClient(clientTransport, {
      log: this.log,
      defaultRequestTimeoutMs: this.timings.requestTimeoutMs,
      nextRequestId: this.continuity.nextRequestId,
      onTimeoutRun: (consecutive, method) => this.noteLiveTimeouts(client, consecutive, method),
    });
    client.onNotification((notification) => this.onNotification(client, notification));
    for (const method of THREAD_SERVER_REQUESTS) {
      client.handleRequest(method, (params, request) => {
        const threadId = threadIdOf(method, params);
        const session = threadId ? this.sessions.get(threadId) : undefined;
        if (session) return session.handleServerRequest(method, params, request.id, request.hold);
        // A subagent thread asked. It is not a Console conversation, but the request must still be answered.
        this.countUnknown(method, threadId, 'serverRequests');
        return declinedServerRequest(method, params).result;
      });
    }
    client.handleRequest('currentTime/read', () => ({ currentTimeAt: Math.floor(Date.now() / 1000) }));
    client.onExit((exit) => this.onExit(client, exit));

    try {
      if (fresh) {
        await this.initialize(client);
      } else {
        // The handshake was done by an earlier backend.
        this.cliVersion ??= recordedVersion(this.context.meta.get(INSTANCE_META_KEY));
        await this.confirmInitialized(client);
      }
    } catch (error) {
      if ((attachOnly || !fresh) && error instanceof JsonRpcTimeoutError) {
        // A running app-server this call did not start (maybe busy, maybe swapped out) that is slow to answer is not broken: ending
        // it would kill every turn and command it runs. Let go of the connection and report it busy; the next attempt reconnects.
        // An attach-only start never ends it (the caller bounds its own wait). An ordinary start does once the process has stayed
        // silent for the limit, or every Codex conversation would fail busy for as long as a hung process lives.
        const silentForMs = attachOnly ? undefined : this.noteUnresponsive();
        if (silentForMs === undefined || silentForMs < APP_SERVER_UNRESPONSIVE_LIMIT_MS) {
          await client.close().catch(() => undefined);
          this.log.warn({ error: error.message }, 'a running codex app-server did not answer in time; it was left running');
          throw new TransportBusyError('The running Codex app-server did not answer in time. It was left alone; try again in a moment.');
        }
        this.log.warn({ silentForMs, limitMs: APP_SERVER_UNRESPONSIVE_LIMIT_MS, error: error.message }, 'the codex app-server has not answered for longer than the limit; ending it and starting a new one');
        await client.close({ terminate: true }).catch(() => undefined);
        this.continuity.unresponsiveSince = undefined;
        return this.startClient(false); // this call started the process, so a timeout in it ends it and fails (it is not another busy run)
      }
      await client.close({ terminate: true }).catch(() => undefined); // the next start gets a clean process
      this.continuity.unresponsiveSince = undefined;
      this.logStartFailure(client, error);
      throw toTransportError(error);
    }
    this.continuity.unresponsiveSince = undefined;
    this.processOutlivesClose = transportOutlivesClose(transport);
    this.hostTransport = transport instanceof HostLineTransport ? transport : undefined;
    this.hostStartTicks = this.hostTransport?.pid !== undefined ? processStartTicks(this.hostTransport.pid) : undefined;
    // Nothing recorded about an earlier process is true of a new one (its question ids, its turns, its line numbers). What the
    // host replayed is read before any thread can be resumed, or a question that arrived meanwhile would be missed.
    if (fresh) {
      this.restart.reset();
    } else if (replay) {
      try {
        await this.absorbReplay(client, replay);
      } catch (error) {
        // Reading the replay is a help, not a condition: the connection works without it.
        this.log.warn({ error: error instanceof Error ? error.message : String(error) }, 'reading the codex session host replay failed');
      }
    }
    if (client.exited) {
      this.hostTransport = undefined;
      this.logStartFailure(client, undefined);
      throw new TransportUnavailableError(`The Codex app-server ended while starting (${exitReason(client.exitInfo!)}).`);
    }
    this.clientRef = client;
    this.respawnNeeded = false;
    this.startCursorTimer();
    const startTicks = client.pid !== undefined ? processStartTicks(client.pid) : undefined;
    const bootId = currentBootId();
    this.context.meta.set(
      INSTANCE_META_KEY,
      JSON.stringify({
        pid: client.pid,
        ...(startTicks ? { startTicks } : {}),
        ...(bootId ? { bootId } : {}),
        startedAt: new Date().toISOString(),
        ...(this.cliVersion ? { version: this.cliVersion } : {}),
      }),
    );
    this.log.info({ pid: client.pid, version: this.cliVersion, host: this.processOutlivesClose, reconnected: !fresh }, fresh ? 'codex app-server started' : 'reconnected to a running codex app-server');
    this.seedRateLimits(client);
    return client;
  }

  // -------------------------------------------------------------------------------------------------------
  // Reconnecting to a host that kept running

  /**
   * The host replays what it still has buffered, ahead of live output. The lines are history (their notifications were
   * handled, or are outdated), so they are taken off the stream and read once by `absorbReplay`; the client sees only lines
   * that arrive after them. A line is replay or live by its sequence number, against the host's newest at connect time. `status`
   * is answered after the replay, so it marks when to stop collecting; when it is slow or never comes, the lines still to come
   * are told apart by the same number (see {@link ReplayGate}), so none of them reaches the client as live output.
   */
  private async separateReplay(transport: HostLineTransport): Promise<{ transport: LineTransport; replay: ReplayedLines }> {
    const { seq: newestSeq, firstSeq } = transport.info;
    const collected: Array<{ seq: number | undefined; line: string }> = [];
    const stop = transport.onLine((line, seq) => void collected.push({ seq, line }));
    try {
      await transport.status(this.timings.initializeTimeoutMs);
    } catch {
      // The connection is lost or the host is slow: the client reports it when it starts.
    }
    stop();
    const isReplay = (entry: { seq: number | undefined }): entry is { seq: number; line: string } => entry.seq !== undefined && entry.seq <= newestSeq;
    return {
      transport: new ReplayGate(transport, collected.filter((entry) => !isReplay(entry)).map((entry) => entry.line), newestSeq),
      replay: { firstSeq, newestSeq, lines: collected.filter(isReplay) },
    };
  }

  /**
   * Reads what the host buffered while no backend was connected and settles the server requests in it. A request that is not
   * resolved later in the replay is still open in the app-server: a question is written down so its thread can hold it (when the
   * thread is resumed) and an approval or elicitation is declined now, as it would have been had a backend been listening. A
   * request that was resolved is forgotten. Turn lifecycle is not read from here: the thread's own state is (see
   * {@link CodexAppServerSession.adopt}), which also covers a replay that no longer reaches back far enough.
   */
  private async absorbReplay(client: JsonRpcClient, replay: ReplayedLines): Promise<void> {
    const transport = this.hostTransport;
    const cursor = this.restart.cursor();
    // A cursor is a position in one process's output: one from another process, or ahead of anything this host has, is no position here.
    const sameProcess = cursor !== undefined && transport?.pid !== undefined && cursor.pid === transport.pid
      && (cursor.startTicks === undefined || cursor.startTicks === this.hostStartTicks) && cursor.seq <= replay.newestSeq;
    const seen = sameProcess ? cursor.seq : 0;
    const gap = replay.newestSeq > seen && replay.firstSeq > seen + 1;
    if (gap) this.log.info({ seen, firstSeq: replay.firstSeq, newestSeq: replay.newestSeq }, 'the codex session host no longer holds every line since the last backend; pending questions are checked against the thread status instead');
    const requests: Array<{ id: JsonRpcId; method: string; params: unknown }> = [];
    const resolved = new Set<string>();
    for (const { seq, line } of replay.lines) {
      if (seq <= seen) continue; // handled by the backend that saved the cursor
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof frame !== 'object' || frame === null) continue;
      const { method, id, params } = frame as { method?: unknown; id?: unknown; params?: unknown };
      if (typeof method !== 'string') continue;
      if (method === 'serverRequest/resolved') {
        const requestId = (params as { requestId?: unknown } | undefined)?.requestId;
        if (typeof requestId === 'string' || typeof requestId === 'number') resolved.add(String(requestId));
      } else if ((typeof id === 'string' || typeof id === 'number') && (THREAD_SERVER_REQUESTS as string[]).includes(method)) {
        requests.push({ id, method, params });
      }
    }
    for (const key of resolved) this.restart.removeQuestion(key);
    for (const { id, method, params } of requests) {
      const key = String(id);
      if (resolved.has(key)) continue;
      const threadId = threadIdOf(method, params);
      if (method === 'item/tool/requestUserInput' && threadId && pendingQuestions(params)) {
        if (!this.restart.hasQuestion(key)) {
          const turnId = (params as { turnId?: unknown }).turnId;
          this.restart.saveQuestion({ id, threadId, ...(typeof turnId === 'string' ? { turnId } : {}), params });
        }
        continue;
      }
      try {
        await client.replyToServerRequest(id, declinedServerRequest(method, params).result);
      } catch (error) {
        this.log.warn({ method, error: error instanceof Error ? error.message : String(error) }, 'declining a request that arrived while no backend was connected failed');
      }
    }
  }

  /** Writes how far into the host's output this backend has read, so the next one replays only what it has not seen. */
  private saveCursor(): void {
    const transport = this.hostTransport;
    if (!transport) return;
    this.lastSavedSeq = transport.lastSeq;
    this.restart.saveCursor({
      seq: transport.lastSeq,
      ...(transport.pid !== undefined ? { pid: transport.pid } : {}),
      ...(this.hostStartTicks ? { startTicks: this.hostStartTicks } : {}),
    });
  }

  private startCursorTimer(): void {
    this.stopCursorTimer();
    if (!this.hostTransport) return;
    this.saveCursor();
    this.cursorTimer = setInterval(() => {
      if (this.hostTransport && this.hostTransport.lastSeq !== this.lastSavedSeq) this.saveCursor();
    }, this.timings.cursorSaveMs);
    this.cursorTimer.unref();
  }

  private stopCursorTimer(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    this.cursorTimer = undefined;
  }

  /**
   * A host that has been used replays nothing to an ordinary open (what it printed belongs to the client that was there), but an
   * attach asks for it: the requests that arrived while no backend was connected are in there. So a backend that expects a
   * running process attaches first, with the whole buffer, and opens the usual way (reconnect, replace or start) only when
   * there is nothing to attach to. `attachOnly` stops after the attach.
   */
  private async openHostTransport(request: LineTransportRequest, attachOnly: boolean, replayWanted: boolean): Promise<LineTransport> {
    if (attachOnly || replayWanted) {
      try {
        const attach: LineTransportRequest = { ...request, attachOnly: true, sinceSeq: 0 };
        return await this.openTransport(attach);
      } catch (error) {
        if (!(error instanceof LineTransportNotRunningError) || attachOnly) throw error;
        // A host that connects but says nothing is not "no process": the plain connect below would fail the same way, as an
        // ordinary error. Any other reason (refused, ended, another command line) leaves the usual fresh start.
        if (error.reason === 'unreachable') await this.settleSilentHost(error);
      }
    }
    return this.openTransport(request);
  }

  /**
   * An ordinary start found the session host running but silent (no connection, or no welcome, in time). The same rule as a
   * timed-out handshake: busy and left alone while the run of silences is younger than {@link APP_SERVER_UNRESPONSIVE_LIMIT_MS},
   * and past it the host and the app-server behind it are ended from the host's record (no connection can end them), so the
   * caller's start makes a new one. Without `PluginContext.endHost` the host is left alone and the start fails plainly. An
   * attach-only start never gets here: it reports the silence and never ends anything (see {@link reattach}).
   */
  private async settleSilentHost(error: LineTransportNotRunningError): Promise<void> {
    const silentForMs = this.noteUnresponsive();
    if (silentForMs < APP_SERVER_UNRESPONSIVE_LIMIT_MS) {
      this.log.warn({ error: error.message }, 'the codex session host is running but did not answer in time; it was left running');
      throw new TransportBusyError('The Codex session host did not answer in time. It was left alone; try again in a moment.');
    }
    const endHost = this.context.endHost;
    if (!endHost) throw new TransportUnavailableError(`The Codex session host has not answered for longer than ${APP_SERVER_UNRESPONSIVE_LIMIT_MS / 60_000} minutes and cannot be ended from here.`);
    this.log.warn({ silentForMs, limitMs: APP_SERVER_UNRESPONSIVE_LIMIT_MS, error: error.message }, 'the codex session host has not answered for longer than the limit; ending it and starting a new one');
    await endHost(HOST_ID, { closeGraceMs: this.timings.closeGraceMs, termGraceMs: this.timings.termGraceMs, staleTermGraceMs: this.timings.staleTermGraceMs });
    this.continuity.unresponsiveSince = undefined; // the start that follows is of a process this call makes: a timeout in it ends it and fails
  }

  private async initialize(client: JsonRpcClient): Promise<void> {
    const params: InitializeParams = {
      clientInfo: { name: CLIENT_NAME, title: 'Agent Console', version: this.clientVersion },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['turn/diff/updated'] },
    };
    try {
      const response = await callCodex(client, 'initialize', params, { timeoutMs: this.timings.initializeTimeoutMs });
      this.cliVersion = cliVersionFromUserAgent(response.userAgent) ?? this.cliVersion;
    } catch (error) {
      // An interrupted earlier handshake leaves the server initialized.
      if (!(error instanceof JsonRpcRequestError) || !/already initialized/i.test(error.message)) throw error;
    }
    await client.notify(INITIALIZED_NOTIFICATION);
  }

  /**
   * A backend that died between `initialize` and `initialized` leaves a server that refuses every request with "Not
   * initialized". One read-only request tells; only then is the handshake repeated.
   */
  private async confirmInitialized(client: JsonRpcClient): Promise<void> {
    try {
      await callCodex(client, 'account/read', {}, { timeoutMs: this.timings.initializeTimeoutMs });
    } catch (error) {
      if (!(error instanceof JsonRpcRequestError)) throw error; // the connection itself failed: the caller reports it
      if (/not initialized/i.test(error.message)) await this.initialize(client);
      // Any other refusal (a server without account support) still proves the server is initialized.
    }
  }

  /** Records a handshake timeout on an ordinary start and returns how long the process has been silent: the age of the first timeout of the run. */
  private noteUnresponsive(): number {
    const now = this.now();
    this.continuity.unresponsiveSince ??= now;
    return now - this.continuity.unresponsiveSince;
  }

  /**
   * Requests that time out on the live connection (see {@link LIVE_CLIENT_TIMEOUT_LIMIT}). They count toward the same run as the
   * handshake timeouts, and an answer ends it. Past the bound the connection is closed without ending the process: its sessions
   * see the loss, and the next use connects through `startClient`, whose check replaces a process that stays silent for the limit.
   */
  private noteLiveTimeouts(client: JsonRpcClient, consecutive: number, method: string | undefined): void {
    if (client !== this.clientRef) return; // a start still checking its connection has its own bound (see `startClient`)
    if (consecutive === 0) {
      this.continuity.unresponsiveSince = undefined;
      return;
    }
    const silentForMs = this.noteUnresponsive();
    if (consecutive < LIVE_CLIENT_TIMEOUT_LIMIT && silentForMs < APP_SERVER_UNRESPONSIVE_LIMIT_MS) return;
    if (this.releasedClient === client) return;
    this.releasedClient = client;
    this.log.warn({ method, consecutive, silentForMs, limitMs: APP_SERVER_UNRESPONSIVE_LIMIT_MS }, 'requests to the codex app-server keep timing out on the live connection; letting go of it so the next use checks the process');
    void client.close().catch(() => undefined);
  }

  /** A process that ended while starting: the error that reaches the conversation names only how it ended; the redacted stderr tail goes to the log. */
  private logStartFailure(client: JsonRpcClient, error: unknown): void {
    const exit = client.exitInfo ?? (error instanceof JsonRpcExitError ? error.exit : undefined);
    if (!exit) return;
    this.log.warn({ pid: client.pid, detail: describeExit(exit) }, 'codex app-server ended while starting');
  }

  /** Reads the account's limits once so a usage-limit failure can name the reset time. Best effort. */
  private seedRateLimits(client: JsonRpcClient): void {
    callCodex(client, 'account/rateLimits/read', { excludeResetCreditDetails: true }, { timeoutMs: this.timings.requestTimeoutMs })
      .then((response) => this.applyRateLimits(response.rateLimitsByLimitId?.codex ?? response.rateLimits))
      .catch((error: unknown) => {
        // Best effort: a shutdown while the read is in flight, or an account without limits, is not a problem.
        this.log.debug?.({ error: error instanceof Error ? error.message : String(error) }, 'codex account/rateLimits/read failed');
      });
  }

  /**
   * The process ended on its own, or the connection to its session host dropped (the process may still run; the next
   * use reconnects). A planned close (`dispose`) forgets the client first, so it never gets here.
   */
  private onExit(client: JsonRpcClient, exit: JsonRpcExit): void {
    if (client !== this.clientRef) return; // a failed start, or a client already replaced
    this.clientRef = undefined;
    if (this.releasedClient === client) this.releasedClient = undefined;
    this.stopCursorTimer();
    if (exit.reason === 'exited') {
      this.context.meta.delete(INSTANCE_META_KEY);
      this.restart.reset(); // the process is gone, and with it the questions it held and the turns it ran
    } else {
      this.saveCursor(); // only the connection dropped: the process and its questions live on for the next connection
    }
    this.hostTransport = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.respawnNeeded = true;
    // The failure message reaches the conversation as a status line, so it names only how the process ended; the
    // stderr tail (redacted) goes to the server log.
    const failure: ProviderFailure = { class: 'transport_error', code: 'process_exited', message: exitReason(exit), retryable: true };
    this.log.warn({ code: exit.code, signal: exit.signal, reason: exit.reason, sessions: sessions.length, detail: describeExit(exit) }, exit.reason === 'exited' ? 'codex app-server exited unexpectedly' : 'lost the connection to the codex session host');
    for (const session of sessions) session.handleProcessExit(failure, { keepQuestions: exit.reason === 'disconnected' });
  }

  // -------------------------------------------------------------------------------------------------------
  // Routing

  private register(response: ThreadStartResponse, options: OpenOptions): CodexAppServerSession {
    const thread = response.thread;
    const previous = this.sessions.get(thread.id);
    // The same thread resumed again: the old session object is stale. Its questions stay held for the session that replaces it.
    if (previous) previous.endLocal({ keepQuestions: true });
    const session = new CodexAppServerSession({
      threadId: thread.id,
      transcriptPath: thread.path,
      cwd: options.cwd,
      policy: options.policy,
      host: this,
      status: thread.status,
    });
    this.sessions.set(thread.id, session);
    this.clearIdleRecycle();
    session.announce();
    return session;
  }

  private onNotification(client: JsonRpcClient, notification: JsonRpcNotification): void {
    if (this.clientRef !== undefined && client !== this.clientRef) return;
    const { method, params } = notification;
    if (method === 'account/rateLimits/updated') {
      const snapshot = (params as CodexNotificationMap['account/rateLimits/updated'] | undefined)?.rateLimits;
      if (snapshot) this.applyRateLimits(snapshot);
      return;
    }
    if (method === 'serverRequest/resolved') {
      // A question written down for the next backend is settled (answered, withdrawn, or its turn ended).
      const requestId = (params as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') this.restart.removeQuestion(String(requestId));
    }
    if (method === 'thread/closed') {
      // The server unloaded the thread, for a thread no session holds as well (one unloaded earlier): its terminals ended with it.
      const closed = threadIdOf(method, params);
      if (closed) this.restart.dropThreadCommands(closed);
    }
    if (method === 'configWarning') {
      const warning = params as CodexNotificationMap['configWarning'] | undefined;
      this.log.info({ summary: warning?.summary }, 'codex configWarning');
      return;
    }
    if (GLOBAL_NOTIFICATIONS.has(method)) return;
    const threadId = threadIdOf(method, params);
    if (!threadId) {
      this.log.debug?.({ method }, 'codex notification without a thread id');
      return;
    }
    const session = this.sessions.get(threadId);
    if (!session) {
      this.countUnknown(method, threadId, 'notifications');
      return;
    }
    session.handleNotification(method, params);
  }

  private applyRateLimits(update: CodexRateLimitSnapshot): void {
    const merged = mergeRateLimits(this.rateLimitSnapshot, update);
    if (!merged || merged === this.rateLimitSnapshot) return;
    this.rateLimitSnapshot = merged;
    for (const session of this.sessions.values()) session.handleRateLimits(merged);
  }

  private countUnknown(method: string, threadId: string | undefined, kind: 'notifications' | 'serverRequests'): void {
    this.unknownThreadFrames[kind] += 1;
    this.unknownThreadFrames.byMethod.set(method, (this.unknownThreadFrames.byMethod.get(method) ?? 0) + 1);
    this.log.debug?.({ method, threadId, kind }, 'codex frame for a thread no session owns');
  }

  private noteSessionEnv(options: OpenOptions): void {
    if (this.warnedSessionEnv || !options.env || Object.keys(options.env).length === 0) return;
    this.warnedSessionEnv = true;
    this.log.warn({}, 'codex app-server sessions share one process; per-session env is not applied');
  }
}
