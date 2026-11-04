// The Grok plugin as a `TransportInstance`: one `grok agent stdio` process per conversation (`processModel: 'per-session'`),
// spoken to over ACP (the Agent Client Protocol, JSON-RPC on stdio).
//
// `start` launches `grok agent --always-approve --model M --reasoning-effort E stdio` in the project directory and runs
// `initialize` and `session/new`; Grok allocates the session id. `resume` finds the conversation's process again when a backend
// restart left it running behind its session host (and asks it, through Grok's session roster, whether it is in the middle of a
// turn), or starts a new process and runs `session/load`, which streams the saved history back (dropped) and restores the model.
// Both spawn through the host's `LineTransportFactory` (a session host relay in production, so the process outlives a backend
// restart; `hostId` is `grok-<conversationId>`) and fall back to a plain stdio child when the host gives none.
//
// The host is keyed by the exact command line, so the argv a conversation was launched with is recorded in plugin meta and a
// restart presents that same argv to find the process (the model on the command line is only the starting model; every turn
// states its own model and effort). Nothing here makes a model call: `probe` and the handshake only read what Grok answers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LineTransportNotRunningError,
  ResumeFailedError,
  TransportBusyError,
  TransportUnavailableError,
  type LineTransport,
  type LineTransportFactory,
  type OpenOptions,
  type PluginContext,
  type TransportInstance,
} from '../types.js';
import { createStdioLineTransportFactory, transportStartedFresh, type LineTransportRequest } from '../line-transport.js';
import { redactFreeText } from '../codex/redact.js';
import {
  JsonRpcClient,
  JsonRpcExitError,
  JsonRpcRequestError,
  JsonRpcTimeoutError,
  describeExit,
} from '../codex/jsonrpc.js';
import type { StructuredProviderConfig } from '../../../config/schema.js';
import { buildChildEnv, buildMcpServers, createRequestIdClock, decideHandshakeFailure, expandHome, hostIdFor as acpHostId, UNRESPONSIVE_LIMIT_MS } from '../acp/index.js';
import { ACP, asString, isRecord, readModels } from './protocol.js';
import {
  DEFAULT_GROK_TIMINGS,
  GROK_CAPABILITIES,
  GrokSession,
  readSessionSettings,
  type GrokLogger,
  type GrokTimings,
  type GrokTurnRecord,
} from './grok-session.js';

export const DEFAULT_GROK_COMMAND = ['grok'];

/** `structuredSessions.grok` in the Console config: the same shape as the other providers' blocks. */
export type GrokStructuredConfig = StructuredProviderConfig;

/** Test and embedding hooks. Production code passes none of them. */
export interface GrokPluginOptions {
  timings?: Partial<GrokTimings>;
  /** The environment the child inherits. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** The home directory used for `~` and `~/.grok`. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Spawns the process. Defaults to the factory on the plugin context, then to a plain stdio child. */
  lineTransport?: LineTransportFactory;
  /** The clock for {@link GROK_UNRESPONSIVE_LIMIT_MS}, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * How long a running Grok process may keep failing the handshake of ordinary opens before the next ordinary open ends and
 * replaces it. Until then a timeout only lets go of the connection and reports busy: the process may just be slow, and ending it
 * ends the turn and the commands it runs. A reattach (attach-only) never ends a process. The same bound as the other plugins'.
 */
export const GROK_UNRESPONSIVE_LIMIT_MS = UNRESPONSIVE_LIMIT_MS;

/** Per conversation: when the first of a run of consecutive handshake timeouts on ordinary opens happened. Held by the plugin, not an instance. */
export type GrokUnresponsiveRuns = Map<string, number>;

const BUSY_MESSAGE = 'The running Grok process for this conversation did not answer in time. It was left alone; try again in a moment.';

/**
 * The child's environment. The inherited environment loses everything that names another session (`CLAUDECODE`, `CLAUDE_CODE_*`,
 * `TMUX`, `CODEX_THREAD_ID`, `AGENT_CONSOLE_*`, `AGENT_COORD_*`), plus `NODE_OPTIONS` and `DEBUG`. The configured and per-session
 * values go on top with `~` expanded; then this session's identity is set (Grok loads the Claude hooks, which read it).
 */
export function buildGrokEnv(input: {
  base: NodeJS.ProcessEnv;
  configEnv?: Record<string, string>;
  optionsEnv?: Record<string, string>;
  conversationId?: string;
  home?: string;
}): Record<string, string> {
  return buildChildEnv(input);
}

/** The argv for a conversation process. Model and effort are the starting values; each turn states its own. */
export function buildGrokArgv(input: { command: string[]; model?: string; effort?: string }): string[] {
  return [
    ...input.command,
    'agent',
    '--always-approve',
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--reasoning-effort', input.effort] : []),
    'stdio',
  ];
}

export { buildMcpServers };

/** A session host id: letters, digits, `.`, `_` and `-` only. */
export function hostIdFor(conversationId: string): string {
  return acpHostId('grok', conversationId);
}

/** Where plugin meta keeps what the host needs to find a conversation's process and its running turn again. */
export function grokLaunchKey(conversationId: string): string {
  return `grok-launch:${conversationId}`;
}

export function grokTurnKey(conversationId: string): string {
  return `grok-turn:${conversationId}`;
}

/** Where Grok keeps a conversation: `<home>/sessions/<URL-encoded cwd>/<session id>/updates.jsonl`. */
export function grokTranscriptPath(grokHome: string, cwd: string, sessionId: string): string {
  return path.join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl');
}

function isMissingBinary(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ((error as { cause?: NodeJS.ErrnoException } | undefined)?.cause?.code);
  return code === 'ENOENT';
}

function errorText(error: unknown): string {
  return redactFreeText(error instanceof Error ? error.message : String(error), 500);
}

/** Process and transport problems become `TransportUnavailableError`; refusals the caller must see stay as they are. */
export function toTransportError(error: unknown): Error {
  if (error instanceof ResumeFailedError || error instanceof TransportUnavailableError) return error;
  if (error instanceof JsonRpcExitError || error instanceof JsonRpcTimeoutError || error instanceof JsonRpcRequestError || isMissingBinary(error)) {
    const unavailable = new TransportUnavailableError(`Grok is not available: ${errorText(error)}`);
    unavailable.cause = error;
    return unavailable;
  }
  return error instanceof Error ? error : new Error(String(error));
}

interface Handshaken {
  session: GrokSession;
  client: JsonRpcClient;
}

export class GrokInstance implements TransportInstance {
  readonly plugin = 'grok';
  readonly capabilities = GROK_CAPABILITIES;
  readonly log: GrokLogger;
  readonly timings: GrokTimings;

  private readonly config: GrokStructuredConfig;
  private readonly context: PluginContext;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly factory: LineTransportFactory;
  private readonly now: () => number;
  private readonly unresponsiveRuns: GrokUnresponsiveRuns;
  private readonly nextRequestId = createRequestIdClock();
  private readonly sessions = new Map<string, GrokSession>();
  /** Conversations being opened right now: a second open of the same one would put two processes on one session. */
  private readonly opening = new Set<string>();
  private disposed = false;

  constructor(config: GrokStructuredConfig, context: PluginContext, options: GrokPluginOptions, unresponsiveRuns: GrokUnresponsiveRuns) {
    this.config = config;
    this.context = context;
    this.log = context.log;
    this.timings = { ...DEFAULT_GROK_TIMINGS, ...options.timings };
    this.baseEnv = options.baseEnv ?? process.env;
    this.home = options.homeDir ?? os.homedir();
    this.factory = options.lineTransport ?? context.lineTransport ?? createStdioLineTransportFactory({ log: context.log });
    this.now = options.now ?? Date.now;
    this.unresponsiveRuns = unresponsiveRuns;
  }

  /** Sessions with a live process, by native id. */
  get openSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  // -------------------------------------------------------------------------------------------------------
  // TransportInstance

  async alive(): Promise<{ pid?: number; connected: boolean }> {
    const live = [...this.sessions.values()].filter(session => !session.isEnded);
    const pid = live.find(session => session.pid !== undefined)?.pid;
    return { ...(pid !== undefined ? { pid } : {}), connected: live.length > 0 };
  }

  /** A throwaway process answers `initialize` and the login check. It never gets a session, so no model call is made. */
  async probe(): Promise<{ installed: boolean; version?: string; auth: 'ok' | 'missing' | 'unknown'; models: Array<{ id: string; label: string; efforts?: string[] }> }> {
    const cwd = this.context.runtimeDir;
    fs.mkdirSync(cwd, { recursive: true });
    let transport: LineTransport;
    try {
      const request: LineTransportRequest = {
        argv: [...this.command(), 'agent', 'stdio'],
        cwd,
        env: buildGrokEnv({ base: this.baseEnv, configEnv: this.config.env, home: this.home }),
        closeGraceMs: Math.min(2_000, this.timings.closeGraceMs),
        termGraceMs: this.timings.termGraceMs,
      };
      transport = await this.factory(request);
    } catch (error) {
      if (isMissingBinary(error)) return { installed: false, auth: 'unknown', models: [] };
      throw toTransportError(error);
    }
    const client = new JsonRpcClient(transport, { log: this.log, jsonrpc: '2.0', nextRequestId: this.nextRequestId });
    try {
      const init = await client.request('initialize', this.initializeParams(), { timeoutMs: this.timings.initializeTimeoutMs });
      const meta = isRecord(init) && isRecord(init._meta) ? init._meta : {};
      const models = readModels(meta.modelState).models.map(model => ({ id: model.id, label: model.label, efforts: model.efforts }));
      let auth: 'ok' | 'missing' | 'unknown' = 'unknown';
      try {
        const check = await client.request(ACP.extCheckSubscription, {}, { timeoutMs: this.timings.requestTimeoutMs });
        if (isRecord(check) && typeof check.authenticated === 'boolean') auth = check.authenticated ? 'ok' : 'missing';
      } catch {
        // The login check is optional; initialize already worked.
      }
      return { installed: true, ...(asString(meta.agentVersion) ? { version: asString(meta.agentVersion)! } : {}), auth, models };
    } catch (error) {
      throw toTransportError(error);
    } finally {
      await client.close({ terminate: true }).catch(() => undefined);
    }
  }

  async start(options: OpenOptions): Promise<GrokSession> {
    return this.launch('new', undefined, options);
  }

  async resume(nativeSessionId: string, options: OpenOptions): Promise<GrokSession> {
    const loaded = this.sessions.get(nativeSessionId);
    if (loaded && !loaded.isEnded) throw new TransportUnavailableError(`Grok session ${nativeSessionId} is already running in this Console.`);
    const recorded = this.readLaunchRecord(options.conversationId, nativeSessionId);
    if (recorded) {
      // After a backend restart the process is usually still running behind its session host. It is ours when this plugin
      // recorded how it was launched and the host answers for exactly that command line. Only a connection that starts
      // nothing is made here: a process started beside it would be a second writer of the conversation.
      if (this.disposed) throw new TransportUnavailableError('The Grok instance was shut down.');
      const survivor = await this.adoptSurvivor(nativeSessionId, options, recorded.argv, 'survivor');
      if (survivor) return survivor;
    }
    return this.launch('resume', nativeSessionId, options);
  }

  /**
   * Adopts this conversation's process when one outlived a backend restart behind its session host, and resolves undefined when
   * there is none. Unlike `resume` it never starts a process: the connection is made with `attachOnly`. A repeated `initialize`
   * (which Grok accepts) proves the process answers, and Grok's session roster says whether it is in the middle of a turn, which
   * the session then tracks as an adopted provider turn. A host that runs but does not answer in time is left alone and reported as
   * {@link TransportBusyError}. This call never ends a process, however long it stays silent: its caller bounds its own wait.
   */
  async reattach(nativeSessionId: string, options: OpenOptions): Promise<GrokSession | undefined> {
    if (this.disposed) return undefined;
    const recorded = this.readLaunchRecord(options.conversationId, nativeSessionId);
    if (!recorded) return undefined;
    const loaded = this.sessions.get(nativeSessionId);
    if (loaded && !loaded.isEnded) throw new TransportUnavailableError(`Grok session ${nativeSessionId} is already running in this Console.`);
    return this.adoptSurvivor(nativeSessionId, options, recorded.argv, 'reattach');
  }

  /**
   * The backend is going away or the instance is being replaced. Behind a session host the processes keep running for the next
   * backend (the connection just closes); a plain stdio child is ended.
   */
  async dispose(reason: 'shutdown' | 'restart'): Promise<void> {
    this.disposed = true;
    this.log.info({ reason, sessions: this.sessions.size }, 'grok instance disposed');
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(session => session.detach()));
  }

  // -------------------------------------------------------------------------------------------------------
  // Launch records

  private command(): string[] {
    return this.config.command.length > 0 ? this.config.command : DEFAULT_GROK_COMMAND;
  }

  private grokHome(env: Record<string, string>): string {
    return env.GROK_HOME ? expandHome(env.GROK_HOME, this.home) : path.join(this.home, '.grok');
  }

  private readLaunchRecord(conversationId: string, sessionId: string): { argv: string[] } | undefined {
    const stored = this.context.meta.get(grokLaunchKey(conversationId));
    if (!stored) return undefined;
    try {
      const record = JSON.parse(stored) as { sessionId?: unknown; argv?: unknown };
      if (record.sessionId !== sessionId || !Array.isArray(record.argv) || !record.argv.every(entry => typeof entry === 'string')) return undefined;
      return { argv: record.argv as string[] };
    } catch {
      return undefined;
    }
  }

  private forgetLaunch(conversationId: string): void {
    this.context.meta.delete(grokLaunchKey(conversationId));
    this.context.meta.delete(grokTurnKey(conversationId));
  }

  private readTurnRecord(conversationId: string, sessionId: string): GrokTurnRecord | undefined {
    const stored = this.context.meta.get(grokTurnKey(conversationId));
    if (!stored) return undefined;
    try {
      const record = JSON.parse(stored) as { sessionId?: unknown; turnId?: unknown; startedAt?: unknown };
      if (record.sessionId !== sessionId || typeof record.turnId !== 'string') return undefined;
      return { turnId: record.turnId, startedAt: typeof record.startedAt === 'string' ? record.startedAt : new Date(0).toISOString() };
    } catch {
      return undefined;
    }
  }

  private writeTurnRecord(conversationId: string, sessionId: string, record: GrokTurnRecord | undefined): void {
    if (record) this.context.meta.set(grokTurnKey(conversationId), JSON.stringify({ sessionId, ...record }));
    else this.context.meta.delete(grokTurnKey(conversationId));
  }

  // -------------------------------------------------------------------------------------------------------
  // Launch

  private initializeParams(): Record<string, unknown> {
    // No file-system or terminal capabilities: Grok does its own file and shell work, so it never asks the Console for either.
    return { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };
  }

  private async launch(mode: 'new' | 'resume', sessionId: string | undefined, options: OpenOptions): Promise<GrokSession> {
    if (this.disposed) throw new TransportUnavailableError('The Grok instance was shut down.');
    if (!fs.existsSync(options.cwd)) throw new TransportUnavailableError(`The working directory does not exist: ${options.cwd}`);
    if (this.opening.has(options.conversationId)) throw new TransportUnavailableError('This conversation is already being opened.');
    this.opening.add(options.conversationId);
    try {
      return await this.launchProcess(mode, sessionId, options);
    } finally {
      this.opening.delete(options.conversationId);
    }
  }

  private async launchProcess(mode: 'new' | 'resume', sessionId: string | undefined, options: OpenOptions): Promise<GrokSession> {
    const env = buildGrokEnv({ base: this.baseEnv, configEnv: this.config.env, optionsEnv: options.env, conversationId: options.conversationId, home: this.home });
    const argv = buildGrokArgv({ command: this.command(), ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) });
    const request: LineTransportRequest = {
      argv,
      cwd: options.cwd,
      env,
      hostId: hostIdFor(options.conversationId),
      closeGraceMs: this.timings.closeGraceMs,
      termGraceMs: this.timings.termGraceMs,
    };
    let transport: LineTransport;
    try {
      transport = await this.factory(request);
    } catch (error) {
      throw toTransportError(error);
    }
    const fresh = transportStartedFresh(transport);
    if (mode === 'new' && !fresh) {
      // A process for this conversation already ran: a second session in it would put two conversations in one process.
      await transport.close().catch(() => undefined);
      throw new TransportUnavailableError('A Grok process for this conversation is already running. Try again in a moment.');
    }
    const handshaken = await this.bringUp(transport, fresh, 'launch', mode, sessionId, options, argv, env);
    // A hung process was ended (see `bringUp`): this call starts the one that replaces it.
    return handshaken ?? this.launchProcess(mode, sessionId, options);
  }

  private async adoptSurvivor(sessionId: string, options: OpenOptions, argv: string[], kind: 'reattach' | 'survivor'): Promise<GrokSession | undefined> {
    if (this.opening.has(options.conversationId)) throw new TransportUnavailableError('This conversation is already being opened.');
    this.opening.add(options.conversationId);
    try {
      return await this.attachSurvivor(sessionId, options, argv, kind);
    } finally {
      this.opening.delete(options.conversationId);
    }
  }

  /** `reattach`, with the instance's `opening` guard held: connect to the survivor, run the handshake. */
  private async attachSurvivor(sessionId: string, options: OpenOptions, argv: string[], kind: 'reattach' | 'survivor'): Promise<GrokSession | undefined> {
    const env = buildGrokEnv({ base: this.baseEnv, configEnv: this.config.env, optionsEnv: options.env, conversationId: options.conversationId, home: this.home });
    const request: LineTransportRequest = {
      argv,
      cwd: options.cwd,
      env,
      hostId: hostIdFor(options.conversationId),
      attachOnly: true,
      closeGraceMs: this.timings.closeGraceMs,
      termGraceMs: this.timings.termGraceMs,
    };
    let transport: LineTransport;
    try {
      transport = await this.factory(request);
    } catch (error) {
      if (error instanceof LineTransportNotRunningError) {
        // Nothing was started. `absent` and `ended` say that no provider process is reachable for this host id; a host that
        // runs another command line says nothing about this conversation's process; a host that did not answer in time may be
        // stalled with the process running.
        if (error.reason === 'unreachable') {
          if (kind === 'survivor' && this.noteUnresponsive(options.conversationId) >= GROK_UNRESPONSIVE_LIMIT_MS) {
            await this.endUnresponsiveHost(options.conversationId);
            return undefined;
          }
          throw new TransportBusyError(BUSY_MESSAGE);
        }
        if (error.reason === 'absent' || error.reason === 'ended') this.forgetLaunch(options.conversationId);
        return undefined;
      }
      throw toTransportError(error);
    }
    const fresh = transportStartedFresh(transport);
    const handshaken = await this.bringUp(transport, fresh, kind, 'resume', sessionId, options, argv, env);
    return handshaken;
  }

  /** An ordinary open found the session host running but silent for longer than {@link GROK_UNRESPONSIVE_LIMIT_MS}: end it from its own record. */
  private async endUnresponsiveHost(conversationId: string): Promise<void> {
    const hostId = hostIdFor(conversationId);
    const endHost = this.context.endHost;
    if (!endHost) throw new TransportUnavailableError(`The session host ${hostId} has not answered for longer than ${GROK_UNRESPONSIVE_LIMIT_MS / 60_000} minutes and cannot be ended from here.`);
    this.log.warn({ hostId, limitMs: GROK_UNRESPONSIVE_LIMIT_MS }, 'the grok session host has not answered for longer than the limit; ending it and its process and starting a new one');
    await endHost(hostId, { closeGraceMs: this.timings.closeGraceMs, termGraceMs: this.timings.termGraceMs });
    this.forgetLaunch(conversationId);
    this.unresponsiveRuns.delete(conversationId);
  }

  private noteUnresponsive(conversationId: string): number {
    const now = this.now();
    const since = this.unresponsiveRuns.get(conversationId) ?? now;
    this.unresponsiveRuns.set(conversationId, since);
    return now - since;
  }

  /**
   * Wraps a connected channel in a client and runs the handshake. `kind`: `reattach` (never ends a process), `survivor` (an
   * ordinary `resume` that found its recorded process) or `launch` (an ordinary start or resume that spawned or reconnected).
   * Resolves undefined only when an ordinary open ended a hung process, so the caller starts its replacement.
   */
  private async bringUp(
    transport: LineTransport,
    fresh: boolean,
    kind: 'reattach' | 'survivor' | 'launch',
    mode: 'new' | 'resume',
    resumeId: string | undefined,
    options: OpenOptions,
    argv: string[],
    env: Record<string, string>,
  ): Promise<GrokSession | undefined> {
    const holder: { session?: GrokSession } = {};
    const client = new JsonRpcClient(transport, {
      log: this.log,
      jsonrpc: '2.0',
      nextRequestId: this.nextRequestId,
      defaultRequestTimeoutMs: this.timings.requestTimeoutMs,
      onUnmatchedResponse: (_id, frame) => holder.session?.handleUnmatchedResponse(frame),
    });
    let opened: Handshaken | undefined;
    try {
      opened = await this.handshake(client, holder, mode, resumeId, options, argv, env, fresh);
    } catch (error) {
      // A process this call did not start that is slow to answer is not broken, and may be running a turn: it is busy. A process
      // this call did start that does not answer is a failed launch.
      const timedOut = error instanceof JsonRpcTimeoutError;
      const busy = timedOut && (kind !== 'launch' || !fresh);
      if (!busy) this.unresponsiveRuns.delete(options.conversationId);
      const silentForMs = busy && kind !== 'reattach' ? this.noteUnresponsive(options.conversationId) : 0;
      const decision = decideHandshakeFailure({ kind, fresh, timedOut, silentForMs, limitMs: GROK_UNRESPONSIVE_LIMIT_MS });
      if (decision === 'replace') {
        this.log.warn({ pid: client.pid, silentForMs, limitMs: GROK_UNRESPONSIVE_LIMIT_MS, error: errorText(error) }, 'the grok process has not answered for longer than the limit; ending it and starting a new one');
        await client.close({ terminate: true }).catch(() => undefined); // ends the process and its host, like a release
        this.forgetLaunch(options.conversationId);
        this.unresponsiveRuns.delete(options.conversationId);
        return undefined;
      }
      if (decision === 'fail-fresh') {
        await client.close({ terminate: true }).catch(() => undefined);
        this.forgetLaunch(options.conversationId);
      } else {
        // Do not end a process that may be running a turn for the person; let go of it.
        await client.close().catch(() => undefined);
      }
      if (decision === 'busy-leave') {
        this.log.warn({ pid: client.pid, error: errorText(error) }, 'a running grok process did not answer the handshake in time; it was left running');
        throw new TransportBusyError(BUSY_MESSAGE);
      }
      throw this.startupError(error, mode, resumeId, client);
    }
    this.unresponsiveRuns.delete(options.conversationId); // it answered
    return opened.session;
  }

  /**
   * `initialize`, then either `session/new` (a new conversation) or: ask the roster whether this process already holds the
   * session (a survivor does; a fresh process does not) and `session/load` it when it does not.
   */
  private async handshake(
    client: JsonRpcClient,
    holder: { session?: GrokSession },
    mode: 'new' | 'resume',
    resumeId: string | undefined,
    options: OpenOptions,
    argv: string[],
    env: Record<string, string>,
    fresh: boolean,
  ): Promise<Handshaken> {
    const initialized = await client.request('initialize', this.initializeParams(), { timeoutMs: this.timings.initializeTimeoutMs });
    const initMeta = isRecord(initialized) && isRecord(initialized._meta) ? initialized._meta : {};
    const startModels = readModels(initMeta.modelState);
    const grokHome = this.grokHome(env);
    const rules = options.appendSystemPrompt ? { rules: options.appendSystemPrompt } : {};
    const sessionMeta = { yoloMode: true, ...rules };
    const mcpServers = buildMcpServers(this.context.coordination, options.conversationId);

    const makeSession = (sessionId: string, settings: { models: ReturnType<typeof readModels>['models']; model?: string; effort?: string }): GrokSession => {
      const session = new GrokSession({
        sessionId,
        cwd: options.cwd,
        client,
        log: this.log,
        timings: this.timings,
        transcriptPath: grokTranscriptPath(grokHome, options.cwd, sessionId),
        models: settings.models.length > 0 ? settings.models : startModels.models,
        ...(settings.model ?? options.model ? { model: settings.model ?? options.model } : {}),
        ...(settings.effort ?? options.effort ? { effort: settings.effort ?? options.effort } : {}),
        onTurnRecord: record => this.writeTurnRecord(options.conversationId, sessionId, record),
        onTurnCompleted: () => undefined,
        onEnded: (ended, kind) => {
          if (this.sessions.get(ended.nativeSessionId) === ended) this.sessions.delete(ended.nativeSessionId);
          // The process is gone: nothing is left to reattach to. A detached session leaves its process running.
          if (kind === 'exited') this.forgetLaunch(options.conversationId);
        },
      });
      holder.session = session;
      this.sessions.set(sessionId, session);
      return session;
    };

    if (mode === 'new') {
      const created = await client.request('session/new', { cwd: options.cwd, mcpServers, _meta: sessionMeta }, { timeoutMs: this.timings.requestTimeoutMs });
      const sessionId = isRecord(created) ? asString(created.sessionId) : undefined;
      if (!sessionId) throw new TransportUnavailableError('Grok did not return a session id.');
      const session = makeSession(sessionId, readSessionSettings(created));
      // Recorded as soon as the id exists: a backend that dies right after still finds the process again.
      this.context.meta.set(grokLaunchKey(options.conversationId), JSON.stringify({ sessionId, argv, startedAt: new Date().toISOString() }));
      session.announce();
      this.log.info({ pid: session.pid, sessionId }, 'grok session started');
      return { session, client };
    }

    const sessionId = resumeId!;
    const session = makeSession(sessionId, { models: startModels.models });
    const entry = await this.readRoster(client, sessionId);
    if (entry?.resident !== true) {
      // A new process, or one that does not hold this conversation: Grok reads it back from disk.
      const endReplay = session.beginReplay();
      try {
        const loaded = await client.request('session/load', { sessionId, cwd: options.cwd, mcpServers, _meta: sessionMeta }, { timeoutMs: this.timings.requestTimeoutMs });
        session.noteSettings(readSessionSettings(loaded));
      } catch (error) {
        this.sessions.delete(sessionId);
        if (error instanceof JsonRpcRequestError) {
          throw new ResumeFailedError(`Grok could not resume session ${sessionId}: ${errorText(error)}`);
        }
        throw error;
      } finally {
        endReplay();
      }
    } else {
      session.noteSettings({ ...(entry.model ? { model: entry.model } : {}), ...(entry.effort ? { effort: entry.effort } : {}) });
    }
    this.context.meta.set(grokLaunchKey(options.conversationId), JSON.stringify({ sessionId, argv, startedAt: new Date().toISOString() }));
    session.announce();
    // A process found again may be in the middle of a turn that an earlier backend started; the roster says so, and the turn
    // is the session's from here on. Without a roster the recorded turn decides.
    const recorded = this.readTurnRecord(options.conversationId, sessionId);
    const working = entry?.activity === 'working' || (entry === undefined && !fresh && recorded !== undefined);
    if (working) session.adoptRunningTurn(recorded?.turnId);
    else if (recorded) this.writeTurnRecord(options.conversationId, sessionId, undefined);
    this.log.info({ pid: session.pid, sessionId, reattached: !fresh, working }, fresh ? 'grok session resumed' : 'reattached to a running grok session');
    return { session, client };
  }

  /** What Grok's roster says about one session of this process. Undefined when the roster cannot be read. */
  private async readRoster(client: JsonRpcClient, sessionId: string): Promise<{ resident: boolean; activity?: string; model?: string; effort?: string } | undefined> {
    let reply: unknown;
    try {
      reply = await client.request(ACP.extSessionsList, {}, { timeoutMs: this.timings.requestTimeoutMs });
    } catch (error) {
      if (error instanceof JsonRpcTimeoutError || error instanceof JsonRpcExitError) throw error;
      return undefined; // an older Grok without the roster: load the session
    }
    const body = isRecord(reply) && isRecord(reply.result) ? reply.result : reply;
    const sessions = isRecord(body) && Array.isArray(body.sessions) ? body.sessions : [];
    for (const item of sessions) {
      if (!isRecord(item) || item.sessionId !== sessionId) continue;
      return {
        resident: item.resident === true,
        ...(asString(item.activity) ? { activity: asString(item.activity)! } : {}),
        ...(asString(item.modelId) ? { model: asString(item.modelId)! } : {}),
        ...(asString(item.reasoningEffort) ? { effort: asString(item.reasoningEffort)! } : {}),
      };
    }
    return { resident: false };
  }

  private startupError(error: unknown, mode: 'new' | 'resume', sessionId: string | undefined, client: JsonRpcClient): Error {
    if (error instanceof ResumeFailedError || error instanceof TransportUnavailableError) return error;
    if (error instanceof JsonRpcExitError) {
      const text = describeExit(error.exit);
      const failure = mode === 'resume'
        ? new ResumeFailedError(`Grok exited while resuming session ${sessionId}: ${text}`)
        : new TransportUnavailableError(`Grok exited while starting: ${text}`);
      failure.cause = error;
      return failure;
    }
    this.log.warn({ pid: client.pid, error: errorText(error), stderr: client.stderrTail() }, 'grok handshake failed');
    return toTransportError(error);
  }
}
