// The Vibe plugin as a `TransportInstance`: one `vibe-acp` process per conversation, spoken to over ACP.
//
// `start` launches the configured command (default `vibe-acp`, no flags) and runs `initialize` and `session/new`.
// Model and thinking are config options, not command-line flags. `resume` adopts the process when a backend restart
// left it running behind its session host, or starts a new process and runs `session/load`. Vibe's `session/list` is a
// saved-session catalog with no activity flag, so it is not a roster: a surviving process keeps the turn recorded in
// plugin meta, and that turn ends on the late answer to the recorded JSON-RPC id, or on the saved store when the turn
// finished while no backend was connected.
//
// A new workspace is untrusted, and Vibe then skips the project's AGENTS.md. The Console opens only directories the
// person configured, so after `session/new` and `session/load` (not after an attach-only adopt) an untrusted workspace
// is trusted with `_trust/decision` `trust_cwd` and the current model is set again so Vibe rebuilds its instructions.
// Mode is set to `auto-approve` on those same opens. The Console has no approval screen.

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
  type JsonRpcId,
  type JsonRpcNotification,
} from '../codex/jsonrpc.js';
import type { StructuredProviderConfig } from '../../../config/schema.js';
import {
  ACP_METHODS,
  buildChildEnv,
  buildMcpServers,
  createRequestIdClock,
  decideHandshakeFailure,
  expandHome,
  hostIdFor as acpHostId,
  UNRESPONSIVE_LIMIT_MS,
  asString,
  isRecord,
} from '../acp/index.js';
import { vibeTurnSettled } from '../../vibe-store.js';
import {
  DEFAULT_VIBE_COMMAND,
  VIBE_QUOTA_COMMAND,
  VIBE_QUOTA_LIMITED_ARGS,
  isMistralApiKey,
  recordVibeQuota,
  vibeLaunchKey,
  vibeTurnKey,
  type VibeTurnRecord,
} from './protocol.js';
import {
  DEFAULT_VIBE_TIMINGS,
  VIBE_CAPABILITIES,
  VibeSession,
  readVibeSettings,
  type VibeLogger,
  type VibeTimings,
} from './vibe-session.js';

export const DEFAULT_VIBE_QUOTA_COMMAND = [VIBE_QUOTA_COMMAND, ...VIBE_QUOTA_LIMITED_ARGS];

export type VibeStructuredConfig = StructuredProviderConfig;

export interface VibePluginOptions {
  timings?: Partial<VibeTimings>;
  baseEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
  lineTransport?: LineTransportFactory;
  now?: () => number;
  /** Command that records a rate limit. Defaults to `wo quota limited --subscription mistral_vibe`. */
  quotaCommand?: string[];
}

export const VIBE_UNRESPONSIVE_LIMIT_MS = UNRESPONSIVE_LIMIT_MS;

export type VibeUnresponsiveRuns = Map<string, number>;

const BUSY_MESSAGE = 'The running Mistral Vibe process for this conversation did not answer in time. It was left alone; try again in a moment.';

/** The child's environment. Mistral API keys are removed from every layer so billing stays on the OS keyring. */
export function buildVibeEnv(input: {
  base: NodeJS.ProcessEnv;
  configEnv?: Record<string, string>;
  optionsEnv?: Record<string, string>;
  conversationId?: string;
  home?: string;
}): Record<string, string> {
  return buildChildEnv({ ...input, dropInherited: isMistralApiKey, dropConfigured: isMistralApiKey });
}

export function hostIdFor(conversationId: string): string {
  return acpHostId('vibe', conversationId);
}

export { buildMcpServers };

function isMissingBinary(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ((error as { cause?: NodeJS.ErrnoException } | undefined)?.cause?.code);
  return code === 'ENOENT';
}

function errorText(error: unknown): string {
  return redactFreeText(error instanceof Error ? error.message : String(error), 500);
}

export function toTransportError(error: unknown): Error {
  if (error instanceof ResumeFailedError || error instanceof TransportUnavailableError || error instanceof TransportBusyError) return error;
  if (error instanceof JsonRpcExitError || error instanceof JsonRpcTimeoutError || error instanceof JsonRpcRequestError || isMissingBinary(error)) {
    const unavailable = new TransportUnavailableError(`Mistral Vibe is not available: ${errorText(error)}`);
    unavailable.cause = error;
    return unavailable;
  }
  return error instanceof Error ? error : new Error(String(error));
}

interface Handshaken {
  session: VibeSession;
  client: JsonRpcClient;
}

/** Notifications and unmatched answers that arrive before the session object exists. */
class EarlyTraffic {
  readonly notes: JsonRpcNotification[] = [];
  readonly unmatched: Array<{ id: JsonRpcId; frame: Record<string, unknown> }> = [];
  private unsub?: () => void;

  attach(client: JsonRpcClient): void {
    this.unsub = client.onNotification(note => { this.notes.push(note); });
  }

  /** Hands the buffer to the session. No await: nothing can land in the gap. */
  handoff(session: VibeSession): void {
    const notes = this.notes.splice(0);
    const late = this.unmatched.splice(0);
    this.unsub?.();
    this.unsub = undefined;
    session.subscribe();
    for (const note of notes) session.ingest(note);
    for (const item of late) session.handleUnmatchedResponse(item.id, item.frame);
  }
}

export class VibeInstance implements TransportInstance {
  readonly plugin = 'vibe';
  readonly capabilities = VIBE_CAPABILITIES;
  readonly log: VibeLogger;
  readonly timings: VibeTimings;

  private readonly config: VibeStructuredConfig;
  private readonly context: PluginContext;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly factory: LineTransportFactory;
  private readonly now: () => number;
  private readonly quotaCommand: string[];
  private readonly unresponsiveRuns: VibeUnresponsiveRuns;
  private readonly nextRequestId = createRequestIdClock();
  private readonly sessions = new Map<string, VibeSession>();
  private readonly opening = new Set<string>();
  private disposed = false;

  constructor(config: VibeStructuredConfig, context: PluginContext, options: VibePluginOptions, unresponsiveRuns: VibeUnresponsiveRuns) {
    this.config = config;
    this.context = context;
    this.log = context.log;
    this.timings = { ...DEFAULT_VIBE_TIMINGS, ...options.timings };
    this.baseEnv = options.baseEnv ?? process.env;
    this.home = options.homeDir ?? os.homedir();
    this.factory = options.lineTransport ?? context.lineTransport ?? createStdioLineTransportFactory({ log: context.log });
    this.now = options.now ?? Date.now;
    this.quotaCommand = options.quotaCommand ?? [...DEFAULT_VIBE_QUOTA_COMMAND];
    this.unresponsiveRuns = unresponsiveRuns;
  }

  get openSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  async alive(): Promise<{ pid?: number; connected: boolean }> {
    const live = [...this.sessions.values()].filter(session => !session.isEnded);
    const pid = live.find(session => session.pid !== undefined)?.pid;
    return { ...(pid !== undefined ? { pid } : {}), connected: live.length > 0 };
  }

  /** A throwaway process answers `initialize`. It never gets a session, so no model call is made. */
  async probe(): Promise<{ installed: boolean; version?: string; auth: 'ok' | 'missing' | 'unknown'; models: Array<{ id: string; label: string }> }> {
    const cwd = this.context.runtimeDir;
    fs.mkdirSync(cwd, { recursive: true });
    let transport: LineTransport;
    try {
      const request: LineTransportRequest = {
        argv: this.command(),
        cwd,
        env: buildVibeEnv({ base: this.baseEnv, configEnv: this.config.env, home: this.home }),
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
      const init = await client.request(ACP_METHODS.initialize, this.initializeParams(), { timeoutMs: this.timings.initializeTimeoutMs });
      const info = isRecord(init) && isRecord(init.agentInfo) ? init.agentInfo : {};
      const meta = isRecord(init) && isRecord(init._meta) ? init._meta : {};
      let auth: 'ok' | 'missing' | 'unknown' = 'unknown';
      try {
        const check = await client.request('_auth/status', {}, { timeoutMs: this.timings.requestTimeoutMs });
        if (isRecord(check) && typeof check.authenticated === 'boolean') auth = check.authenticated ? 'ok' : 'missing';
      } catch (error) {
        if (error instanceof JsonRpcRequestError && /missing api key/i.test(error.message)) auth = 'missing';
      }
      const version = asString(info.version) ?? asString(meta.agentVersion);
      return { installed: true, ...(version ? { version } : {}), auth, models: [] };
    } catch (error) {
      throw toTransportError(error);
    } finally {
      await client.close({ terminate: true }).catch(() => undefined);
    }
  }

  async start(options: OpenOptions): Promise<VibeSession> {
    return this.launch('new', undefined, options);
  }

  async resume(nativeSessionId: string, options: OpenOptions): Promise<VibeSession> {
    const loaded = this.sessions.get(nativeSessionId);
    if (loaded && !loaded.isEnded) throw new TransportUnavailableError(`Mistral Vibe session ${nativeSessionId} is already running in this Console.`);
    const recorded = this.readLaunchRecord(options.conversationId, nativeSessionId);
    if (recorded) {
      if (this.disposed) throw new TransportUnavailableError('The Mistral Vibe instance was shut down.');
      const survivor = await this.adoptSurvivor(nativeSessionId, options, recorded.argv, 'survivor');
      if (survivor) return survivor;
    }
    return this.launch('resume', nativeSessionId, options);
  }

  async reattach(nativeSessionId: string, options: OpenOptions): Promise<VibeSession | undefined> {
    if (this.disposed) return undefined;
    const recorded = this.readLaunchRecord(options.conversationId, nativeSessionId);
    if (!recorded) return undefined;
    const loaded = this.sessions.get(nativeSessionId);
    if (loaded && !loaded.isEnded) throw new TransportUnavailableError(`Mistral Vibe session ${nativeSessionId} is already running in this Console.`);
    return this.adoptSurvivor(nativeSessionId, options, recorded.argv, 'reattach');
  }

  async dispose(reason: 'shutdown' | 'restart'): Promise<void> {
    this.disposed = true;
    this.log.info({ reason, sessions: this.sessions.size }, 'vibe instance disposed');
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(session => session.detach()));
  }

  private command(): string[] {
    return this.config.command.length > 0 ? this.config.command : [...DEFAULT_VIBE_COMMAND];
  }

  private vibeHome(env: Record<string, string>): string {
    return env.VIBE_HOME ? expandHome(env.VIBE_HOME, this.home) : path.join(this.home, '.vibe');
  }

  private sessionDir(env: Record<string, string>, sessionId: string): string {
    return path.join(this.vibeHome(env), 'logs', 'session', 'unified', sessionId);
  }

  private readLaunchRecord(conversationId: string, sessionId: string): { argv: string[] } | undefined {
    const stored = this.context.meta.get(vibeLaunchKey(conversationId));
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
    this.context.meta.delete(vibeLaunchKey(conversationId));
    this.context.meta.delete(vibeTurnKey(conversationId));
  }

  private readTurnRecord(conversationId: string, sessionId: string): VibeTurnRecord | undefined {
    const stored = this.context.meta.get(vibeTurnKey(conversationId));
    if (!stored) return undefined;
    try {
      const record = JSON.parse(stored) as Partial<VibeTurnRecord> & { sessionId?: unknown };
      if (record.sessionId !== sessionId || typeof record.turnId !== 'string' || typeof record.requestId !== 'number') return undefined;
      return {
        turnId: record.turnId,
        requestId: record.requestId,
        startedAt: typeof record.startedAt === 'string' ? record.startedAt : new Date(0).toISOString(),
        ...(typeof record.generation === 'string' ? { generation: record.generation } : {}),
        ...(typeof record.snapshotSequence === 'number' ? { snapshotSequence: record.snapshotSequence } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private writeTurnRecord(conversationId: string, sessionId: string, record: VibeTurnRecord | undefined): void {
    if (record) this.context.meta.set(vibeTurnKey(conversationId), JSON.stringify({ sessionId, ...record }));
    else this.context.meta.delete(vibeTurnKey(conversationId));
  }

  private initializeParams(): Record<string, unknown> {
    return { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };
  }

  private async launch(mode: 'new' | 'resume', sessionId: string | undefined, options: OpenOptions): Promise<VibeSession> {
    if (this.disposed) throw new TransportUnavailableError('The Mistral Vibe instance was shut down.');
    if (!fs.existsSync(options.cwd)) throw new TransportUnavailableError(`The working directory does not exist: ${options.cwd}`);
    if (this.opening.has(options.conversationId)) throw new TransportUnavailableError('This conversation is already being opened.');
    this.opening.add(options.conversationId);
    try {
      return await this.launchProcess(mode, sessionId, options);
    } finally {
      this.opening.delete(options.conversationId);
    }
  }

  private async launchProcess(mode: 'new' | 'resume', sessionId: string | undefined, options: OpenOptions): Promise<VibeSession> {
    const env = buildVibeEnv({ base: this.baseEnv, configEnv: this.config.env, optionsEnv: options.env, conversationId: options.conversationId, home: this.home });
    const argv = this.command();
    const request: LineTransportRequest = {
      argv, cwd: options.cwd, env, hostId: hostIdFor(options.conversationId),
      closeGraceMs: this.timings.closeGraceMs, termGraceMs: this.timings.termGraceMs,
    };
    let transport: LineTransport;
    try {
      transport = await this.factory(request);
    } catch (error) {
      throw toTransportError(error);
    }
    const fresh = transportStartedFresh(transport);
    if (mode === 'new' && !fresh) {
      await transport.close().catch(() => undefined);
      throw new TransportUnavailableError('A Mistral Vibe process for this conversation is already running. Try again in a moment.');
    }
    const handshaken = await this.bringUp(transport, fresh, 'launch', mode, sessionId, options, argv, env);
    return handshaken ?? this.launchProcess(mode, sessionId, options);
  }

  private async adoptSurvivor(sessionId: string, options: OpenOptions, argv: string[], kind: 'reattach' | 'survivor'): Promise<VibeSession | undefined> {
    if (this.opening.has(options.conversationId)) throw new TransportUnavailableError('This conversation is already being opened.');
    this.opening.add(options.conversationId);
    try {
      return await this.attachSurvivor(sessionId, options, argv, kind);
    } finally {
      this.opening.delete(options.conversationId);
    }
  }

  private async attachSurvivor(sessionId: string, options: OpenOptions, argv: string[], kind: 'reattach' | 'survivor'): Promise<VibeSession | undefined> {
    const env = buildVibeEnv({ base: this.baseEnv, configEnv: this.config.env, optionsEnv: options.env, conversationId: options.conversationId, home: this.home });
    const request: LineTransportRequest = {
      argv, cwd: options.cwd, env, hostId: hostIdFor(options.conversationId), attachOnly: true,
      closeGraceMs: this.timings.closeGraceMs, termGraceMs: this.timings.termGraceMs,
    };
    let transport: LineTransport;
    try {
      transport = await this.factory(request);
    } catch (error) {
      if (error instanceof LineTransportNotRunningError) {
        if (error.reason === 'unreachable') {
          if (kind === 'survivor' && this.noteUnresponsive(options.conversationId) >= VIBE_UNRESPONSIVE_LIMIT_MS) {
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
    return this.bringUp(transport, fresh, kind, 'resume', sessionId, options, argv, env);
  }

  private async endUnresponsiveHost(conversationId: string): Promise<void> {
    const hostId = hostIdFor(conversationId);
    const endHost = this.context.endHost;
    if (!endHost) throw new TransportUnavailableError(`The session host ${hostId} has not answered for longer than ${VIBE_UNRESPONSIVE_LIMIT_MS / 60_000} minutes and cannot be ended from here.`);
    this.log.warn({ hostId, limitMs: VIBE_UNRESPONSIVE_LIMIT_MS }, 'the vibe session host has not answered for longer than the limit; ending it and its process and starting a new one');
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

  private async bringUp(
    transport: LineTransport,
    fresh: boolean,
    kind: 'reattach' | 'survivor' | 'launch',
    mode: 'new' | 'resume',
    resumeId: string | undefined,
    options: OpenOptions,
    argv: string[],
    env: Record<string, string>,
  ): Promise<VibeSession | undefined> {
    const holder: { session?: VibeSession } = {};
    const early = new EarlyTraffic();
    const client = new JsonRpcClient(transport, {
      log: this.log,
      jsonrpc: '2.0',
      nextRequestId: this.nextRequestId,
      defaultRequestTimeoutMs: this.timings.requestTimeoutMs,
      onUnmatchedResponse: (id, frame) => {
        if (holder.session) holder.session.handleUnmatchedResponse(id, frame);
        else early.unmatched.push({ id, frame });
      },
    });
    early.attach(client);
    try {
      const opened = await this.handshake(client, holder, early, mode, resumeId, options, argv, env, fresh);
      this.unresponsiveRuns.delete(options.conversationId);
      return opened.session;
    } catch (error) {
      const timedOut = error instanceof JsonRpcTimeoutError;
      const busy = timedOut && (kind !== 'launch' || !fresh);
      if (!busy) this.unresponsiveRuns.delete(options.conversationId);
      const silentForMs = busy && kind !== 'reattach' ? this.noteUnresponsive(options.conversationId) : 0;
      const decision = decideHandshakeFailure({ kind, fresh, timedOut, silentForMs, limitMs: VIBE_UNRESPONSIVE_LIMIT_MS });
      if (decision === 'replace') {
        this.log.warn({ pid: client.pid, silentForMs, limitMs: VIBE_UNRESPONSIVE_LIMIT_MS, error: errorText(error) }, 'the vibe process has not answered for longer than the limit; ending it and starting a new one');
        await client.close({ terminate: true }).catch(() => undefined);
        this.forgetLaunch(options.conversationId);
        this.unresponsiveRuns.delete(options.conversationId);
        return undefined;
      }
      if (decision === 'fail-fresh') {
        await client.close({ terminate: true }).catch(() => undefined);
        this.forgetLaunch(options.conversationId);
      } else {
        await client.close().catch(() => undefined);
      }
      if (decision === 'busy-leave') {
        this.log.warn({ pid: client.pid, error: errorText(error) }, 'a running vibe process did not answer the handshake in time; it was left running');
        throw new TransportBusyError(BUSY_MESSAGE);
      }
      throw this.startupError(error, mode, resumeId, client);
    }
  }

  private async handshake(
    client: JsonRpcClient,
    holder: { session?: VibeSession },
    early: EarlyTraffic,
    mode: 'new' | 'resume',
    resumeId: string | undefined,
    options: OpenOptions,
    argv: string[],
    env: Record<string, string>,
    fresh: boolean,
  ): Promise<Handshaken> {
    await client.request(ACP_METHODS.initialize, this.initializeParams(), { timeoutMs: this.timings.initializeTimeoutMs });
    const mcpServers = buildMcpServers(this.context.coordination, options.conversationId);
    const makeSession = (sessionId: string, settings: ReturnType<typeof readVibeSettings>): VibeSession => {
      const storeDir = this.sessionDir(env, sessionId);
      const session = new VibeSession({
        sessionId,
        client,
        log: this.log,
        timings: this.timings,
        storeDir,
        transcriptPath: path.join(storeDir, 'CURRENT'),
        ...settings,
        onTurnRecord: record => this.writeTurnRecord(options.conversationId, sessionId, record),
        onRateLimited: () => recordVibeQuota(this.quotaCommand, this.log),
        onEnded: (ended, kind) => {
          if (this.sessions.get(ended.nativeSessionId) === ended) this.sessions.delete(ended.nativeSessionId);
          if (kind === 'exited') this.forgetLaunch(options.conversationId);
        },
      });
      this.sessions.set(sessionId, session);
      return session;
    };
    const reveal = (session: VibeSession): void => {
      holder.session = session;
      early.handoff(session);
    };

    if (mode === 'new') {
      const created = await client.request(ACP_METHODS.newSession, { cwd: options.cwd, mcpServers }, { timeoutMs: this.timings.requestTimeoutMs });
      const sessionId = isRecord(created) ? asString(created.sessionId) : undefined;
      if (!sessionId) throw new TransportUnavailableError('Mistral Vibe did not return a session id.');
      const settings = readVibeSettings(created);
      const session = makeSession(sessionId, settings);
      reveal(session);
      this.context.meta.set(vibeLaunchKey(options.conversationId), JSON.stringify({ sessionId, argv, startedAt: new Date().toISOString() }));
      await this.applyLaunchPolicy(session, created, settings.model ?? options.model);
      await this.register(session, options, true);
      session.announce();
      this.log.info({ pid: session.pid, sessionId }, 'vibe session started');
      return { session, client };
    }

    const sessionId = resumeId!;
    const session = makeSession(sessionId, { models: [], efforts: [] });
    if (!fresh) {
      // The process is the one that was already running the turn. Do not session/load, and do not trust or change mode:
      // both would be new requests against a process that may be mid-turn.
      const recorded = this.readTurnRecord(options.conversationId, sessionId);
      if (recorded) {
        session.adoptRunningTurn(recorded);
        if (recorded.generation !== undefined && recorded.snapshotSequence !== undefined) {
          const settled = vibeTurnSettled(this.sessionDir(env, sessionId), { generation: recorded.generation, snapshotSequence: recorded.snapshotSequence });
          if (settled === 'finished') session.completeFromStore();
        }
      }
      reveal(session);
      this.context.meta.set(vibeLaunchKey(options.conversationId), JSON.stringify({ sessionId, argv, startedAt: new Date().toISOString() }));
      await this.register(session, options, false);
      session.announce();
      this.log.info({ pid: session.pid, sessionId, adopted: recorded !== undefined }, 'reattached to a running vibe session');
      return { session, client };
    }

    // A new process is not running the old turn. Load the saved session and drop the replayed history.
    const endReplay = session.beginReplay();
    let loaded: unknown;
    try {
      loaded = await client.request(ACP_METHODS.loadSession, { sessionId, cwd: options.cwd, mcpServers }, { timeoutMs: this.timings.requestTimeoutMs });
      const settings = readVibeSettings(loaded);
      session.noteSettings(settings);
      reveal(session);
    } catch (error) {
      this.sessions.delete(sessionId);
      if (error instanceof JsonRpcRequestError) throw new ResumeFailedError(`Mistral Vibe could not resume session ${sessionId}: ${errorText(error)}`);
      throw error;
    } finally {
      endReplay();
    }
    this.writeTurnRecord(options.conversationId, sessionId, undefined);
    this.context.meta.set(vibeLaunchKey(options.conversationId), JSON.stringify({ sessionId, argv, startedAt: new Date().toISOString() }));
    await this.applyLaunchPolicy(session, loaded, sessionModel(loaded, options.model));
    await this.register(session, options, false);
    session.announce();
    this.log.info({ pid: session.pid, sessionId }, 'vibe session resumed');
    return { session, client };
  }

  /**
   * Trusts a configured project directory so its AGENTS.md loads, then sets auto-approve. A failure is logged.
   * Not used when attaching to a process that is already in a turn.
   */
  private async applyLaunchPolicy(session: VibeSession, result: unknown, model: string | undefined): Promise<void> {
    let status = workspaceTrustStatus(result);
    if (!status) {
      try {
        const reply = await sessionConfigureTrust(session, '_trust/status');
        status = asString(isRecord(reply) ? reply.trust_status : undefined) ?? workspaceTrustStatus(reply);
      } catch (error) {
        this.log.warn({ error: errorText(error), sessionId: session.nativeSessionId }, 'vibe workspace trust status could not be read');
      }
    }
    if (status === 'untrusted' || !status) {
      try {
        await sessionConfigureTrust(session, '_trust/decision', { decision: 'trust_cwd' });
        if (model) await session.configure('model', model);
      } catch (error) {
        this.log.warn({ error: errorText(error), sessionId: session.nativeSessionId }, 'vibe workspace trust was not applied');
      }
    }
    try {
      await session.configure('mode', 'auto-approve');
    } catch (error) {
      this.log.warn({ error: errorText(error), sessionId: session.nativeSessionId }, 'vibe auto-approve mode was not set');
    }
  }

  private async register(session: VibeSession, options: OpenOptions, fresh: boolean): Promise<void> {
    const register = this.context.registerConversation;
    const pid = session.pid;
    if (!register || pid === undefined) return;
    try {
      const result = await register({
        provider: 'vibe',
        nativeSessionId: session.nativeSessionId,
        conversationId: options.conversationId,
        cwd: options.cwd,
        pid,
        fresh,
      });
      if (fresh && result && typeof result.startupContext === 'string' && result.startupContext) {
        session.setStartupContext(result.startupContext);
      }
    } catch (error) {
      this.log.warn({ error: errorText(error), sessionId: session.nativeSessionId }, 'vibe coordination registration failed');
    }
  }

  private startupError(error: unknown, mode: 'new' | 'resume', sessionId: string | undefined, client: JsonRpcClient): Error {
    if (error instanceof ResumeFailedError || error instanceof TransportUnavailableError || error instanceof TransportBusyError) return error;
    if (error instanceof JsonRpcExitError) {
      const text = describeExit(error.exit);
      const failure = mode === 'resume'
        ? new ResumeFailedError(`Mistral Vibe exited while resuming session ${sessionId}: ${text}`)
        : new TransportUnavailableError(`Mistral Vibe exited while starting: ${text}`);
      failure.cause = error;
      return failure;
    }
    this.log.warn({ pid: client.pid, error: errorText(error), stderr: client.stderrTail() }, 'vibe handshake failed');
    return toTransportError(error);
  }
}

function workspaceTrustStatus(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const meta = isRecord(result._meta) ? result._meta : isRecord(result.meta) ? result.meta : undefined;
  const trust = meta && isRecord(meta.workspace_trust) ? meta.workspace_trust : undefined;
  return asString(trust?.status);
}

function sessionModel(result: unknown, fallback: string | undefined): string | undefined {
  return readVibeSettings(result).model ?? fallback;
}

/** Trust calls go through the session's client by way of configure's request path. Status and decision are not config options. */
async function sessionConfigureTrust(session: VibeSession, method: '_trust/status' | '_trust/decision', extra: Record<string, unknown> = {}): Promise<unknown> {
  return session.requestExtension(method, { sessionId: session.nativeSessionId, ...extra });
}
