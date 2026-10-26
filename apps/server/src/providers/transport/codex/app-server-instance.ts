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
// one is gone).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StructuredProviderConfig } from '../../../config/schema.js';
import {
  ResumeFailedError,
  TransportUnavailableError,
  type LineTransport,
  type LineTransportFactory,
  type OpenOptions,
  type PluginContext,
  type ProviderFailure,
  type TransportInstance,
} from '../types.js';
import { createStdioLineTransportFactory, LineTransportSpawnError, transportOutlivesClose, transportStartedFresh, type LineTransportRequest } from '../line-transport.js';
import { isArchivedThreadError } from './errors.js';
import { describeExit, exitReason, JsonRpcClient, JsonRpcExitError, JsonRpcRequestError, JsonRpcSpawnError, JsonRpcTimeoutError, type JsonRpcExit, type JsonRpcNotification } from './jsonrpc.js';
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
  sandboxModeFor,
  toTransportError,
  type CodexLogger,
  type CodexSessionHost,
  type CodexTimings,
} from './app-server-session.js';
import { currentBootId, processStartTicks } from './process-lifetime.js';
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
}

/** What the backend knows of the app-server it is connected to: `{ pid, startTicks, bootId, startedAt, version }`. The session host's record file, not this, decides which process is adopted or ended. */
export const INSTANCE_META_KEY = 'structured-instance:codex';
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
 * in them is expanded, as for the tmux provider commands; `CODEX_HOME` is always expanded because spawn does
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
  return { mcp_optional_startup_grace_ms: 10_000, ...(options.effort ? { model_reasoning_effort: options.effort } : {}) };
}

/**
 * The app-server argv: the configured command, then the update check off, then (when coordination is on) this
 * Console's coordination MCP server. Codex starts that server from `~/.codex/config.toml`, whose entry names one
 * fixed runtime and checkout; the overrides point the agent's `agent_coordination` calls at this Console, as the
 * tmux launch does. Unlike tmux there is no `AGENT_CONSOLE_SESSION_ID`: the process serves every thread.
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
  private readonly openTransport: LineTransportFactory;
  private readonly sessions = new Map<string, CodexAppServerSession>();
  private clientRef: JsonRpcClient | undefined;
  private starting: Promise<JsonRpcClient> | undefined;
  private rateLimitSnapshot: CodexRateLimitSnapshot | undefined;
  private cliVersion: string | undefined;
  private disposed = false;
  private respawnNeeded = false;
  private warnedSessionEnv = false;
  /** True while the connected transport leaves the process running when it closes (a session host holds it). */
  private processOutlivesClose = false;

  constructor(config: CodexStructuredConfig, context: PluginContext, options: CodexPluginOptions = {}) {
    this.config = config;
    this.context = context;
    this.log = context.log;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.baseEnv = options.baseEnv ?? process.env;
    this.clientVersion = options.clientVersion ?? packageVersion();
    this.openTransport = context.lineTransport ?? createStdioLineTransportFactory({ log: { warn: (fields, message) => context.log.warn(fields, message) } });
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
    if (!this.clientRef || this.clientRef.exited) throw new TransportUnavailableError('The Codex app-server is not running.');
    return this.clientRef;
  }

  rateLimits(): CodexRateLimitSnapshot | undefined {
    return this.rateLimitSnapshot;
  }

  release(session: CodexAppServerSession): void {
    if (this.sessions.get(session.nativeSessionId) === session) this.sessions.delete(session.nativeSessionId);
  }

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

  async resume(nativeSessionId: string, options: OpenOptions): Promise<CodexAppServerSession> {
    const client = await this.ensureClient();
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
    return session;
  }

  async dispose(reason: 'shutdown' | 'restart'): Promise<void> {
    if (reason === 'shutdown') this.disposed = true;
    if (this.starting) await this.starting.catch(() => undefined);
    const client = this.clientRef;
    this.clientRef = undefined;
    for (const session of [...this.sessions.values()]) session.endLocal();
    this.sessions.clear();
    // A stdio child dies with its channel. A process held by a session host keeps running, and so does its record.
    if (client) {
      await client.close();
      if (!this.processOutlivesClose) this.context.meta.delete(INSTANCE_META_KEY);
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Process

  private async ensureClient(): Promise<JsonRpcClient> {
    if (this.disposed) throw new TransportUnavailableError('The Codex app-server instance was shut down.');
    if (this.clientRef && !this.clientRef.exited) return this.clientRef;
    this.starting ??= this.startClient().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startClient(): Promise<JsonRpcClient> {
    const cwd = this.context.runtimeDir;
    fs.mkdirSync(cwd, { recursive: true });
    const env = buildAppServerEnv(this.baseEnv, os.homedir(), this.config.env);
    const argv = buildAppServerCommand(this.config.command, this.context.coordination);
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
      transport = await this.openTransport(request);
    } catch (error) {
      throw toTransportError(error instanceof LineTransportSpawnError ? new JsonRpcSpawnError(argv[0] ?? '', error) : error);
    }
    const client = new JsonRpcClient(transport, { log: this.log, defaultRequestTimeoutMs: this.timings.requestTimeoutMs });
    const fresh = transportStartedFresh(transport);
    client.onNotification((notification) => this.onNotification(client, notification));
    for (const method of THREAD_SERVER_REQUESTS) {
      client.handleRequest(method, (params, request) => {
        const threadId = threadIdOf(method, params);
        const session = threadId ? this.sessions.get(threadId) : undefined;
        if (session) return session.handleServerRequest(method, params, request.id);
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
      await client.close({ terminate: true }).catch(() => undefined); // the next start gets a clean process
      this.logStartFailure(client, error);
      throw toTransportError(error);
    }
    if (client.exited) {
      this.logStartFailure(client, undefined);
      throw new TransportUnavailableError(`The Codex app-server ended while starting (${exitReason(client.exitInfo!)}).`);
    }
    this.clientRef = client;
    this.respawnNeeded = false;
    this.processOutlivesClose = transportOutlivesClose(transport);
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
    if (exit.reason === 'exited') this.context.meta.delete(INSTANCE_META_KEY);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.respawnNeeded = true;
    // The failure message reaches the conversation as a status line, so it names only how the process ended; the
    // stderr tail (redacted) goes to the server log.
    const failure: ProviderFailure = { class: 'transport_error', code: 'process_exited', message: exitReason(exit), retryable: true };
    this.log.warn({ code: exit.code, signal: exit.signal, reason: exit.reason, sessions: sessions.length, detail: describeExit(exit) }, exit.reason === 'exited' ? 'codex app-server exited unexpectedly' : 'lost the connection to the codex session host');
    for (const session of sessions) session.handleProcessExit(failure);
  }

  // -------------------------------------------------------------------------------------------------------
  // Routing

  private register(response: ThreadStartResponse, options: OpenOptions): CodexAppServerSession {
    const thread = response.thread;
    const previous = this.sessions.get(thread.id);
    if (previous) previous.endLocal(); // the same thread resumed again: the old session object is stale
    const session = new CodexAppServerSession({
      threadId: thread.id,
      transcriptPath: thread.path,
      cwd: options.cwd,
      policy: options.policy,
      host: this,
    });
    this.sessions.set(thread.id, session);
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
