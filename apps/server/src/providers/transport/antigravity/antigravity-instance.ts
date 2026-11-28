// The Antigravity plugin as a `TransportInstance`: one `agy acp` process per conversation, spoken to over ACP.
//
// `start` launches the configured command (default `agy acp --stdio --dangerously-skip-permissions`) and runs
// `initialize` and `session/new`. Model and thinking (`thought_level`) are ACP config options. `resume` adopts
// a surviving session host after a backend restart, or starts a new process and runs `session/load`.

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
import { antigravityTranscriptPath, antigravityTurnSettled } from '../../antigravity-store.js';
import {
  ANTIGRAVITY_QUOTA_COMMAND,
  ANTIGRAVITY_QUOTA_LIMITED_ARGS,
  DEFAULT_ANTIGRAVITY_COMMAND,
  antigravityLaunchKey,
  antigravityTurnKey,
  isGoogleApiKey,
  recordAntigravityQuota,
  type AntigravityTurnRecord,
} from './protocol.js';
import {
  ANTIGRAVITY_CAPABILITIES,
  AntigravitySession,
  DEFAULT_ANTIGRAVITY_TIMINGS,
  readAntigravitySettings,
  type AntigravityLogger,
  type AntigravityTimings,
} from './antigravity-session.js';

export const DEFAULT_ANTIGRAVITY_QUOTA_COMMAND = [ANTIGRAVITY_QUOTA_COMMAND, ...ANTIGRAVITY_QUOTA_LIMITED_ARGS];

export type AntigravityStructuredConfig = StructuredProviderConfig;

export interface AntigravityPluginOptions {
  timings?: Partial<AntigravityTimings>;
  baseEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
  lineTransport?: LineTransportFactory;
  now?: () => number;
  /** Command that records a rate limit. Defaults to `wo quota limited --subscription google_ai_pro`. */
  quotaCommand?: string[];
}

export const ANTIGRAVITY_UNRESPONSIVE_LIMIT_MS = UNRESPONSIVE_LIMIT_MS;

export type AntigravityUnresponsiveRuns = Map<string, number>;

const BUSY_MESSAGE = 'The running Antigravity process for this conversation did not answer in time. It was left alone; try again in a moment.';

/** The child's environment. Gemini/Google API keys are removed so billing stays on Bryan's Google AI Pro OAuth subscription. */
export function buildAntigravityEnv(input: {
  base: NodeJS.ProcessEnv;
  configEnv?: Record<string, string>;
  optionsEnv?: Record<string, string>;
  conversationId?: string;
  home?: string;
}): Record<string, string> {
  return buildChildEnv({ ...input, dropInherited: isGoogleApiKey, dropConfigured: isGoogleApiKey });
}

export function hostIdFor(conversationId: string): string {
  return acpHostId('antigravity', conversationId);
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
    const unavailable = new TransportUnavailableError(`Antigravity is not available: ${errorText(error)}`);
    unavailable.cause = error;
    return unavailable;
  }
  return error instanceof Error ? error : new Error(String(error));
}

interface Handshaken {
  session: AntigravitySession;
  client: JsonRpcClient;
}

class EarlyTraffic {
  readonly notes: JsonRpcNotification[] = [];
  readonly unmatched: Array<{ id: JsonRpcId; frame: Record<string, unknown> }> = [];
  private unsub?: () => void;

  attach(client: JsonRpcClient): void {
    this.unsub = client.onNotification(note => { this.notes.push(note); });
  }

  handoff(session: AntigravitySession): void {
    const notes = this.notes.splice(0);
    const late = this.unmatched.splice(0);
    this.unsub?.();
    this.unsub = undefined;
    session.subscribe();
    for (const note of notes) session.ingest(note);
    for (const item of late) session.handleUnmatchedResponse(item.id, item.frame);
  }
}

export class AntigravityInstance implements TransportInstance {
  readonly plugin = 'antigravity';
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  readonly log: AntigravityLogger;
  readonly timings: AntigravityTimings;

  private readonly config: AntigravityStructuredConfig;
  private readonly context: PluginContext;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly factory: LineTransportFactory;
  private readonly now: () => number;
  private readonly quotaCommand: string[];
  private readonly unresponsiveRuns: AntigravityUnresponsiveRuns;
  private readonly nextRequestId = createRequestIdClock();
  private readonly sessions = new Map<string, AntigravitySession>();
  private readonly opening = new Set<string>();
  private disposed = false;

  constructor(
    config: AntigravityStructuredConfig,
    context: PluginContext,
    options: AntigravityPluginOptions,
    unresponsiveRuns: AntigravityUnresponsiveRuns,
  ) {
    this.config = config;
    this.context = context;
    this.log = context.log;
    this.timings = { ...DEFAULT_ANTIGRAVITY_TIMINGS, ...options.timings };
    this.baseEnv = options.baseEnv ?? process.env;
    this.home = options.homeDir ?? os.homedir();
    this.factory = options.lineTransport ?? context.lineTransport ?? createStdioLineTransportFactory({ log: context.log });
    this.now = options.now ?? Date.now;
    this.quotaCommand = options.quotaCommand ?? [...DEFAULT_ANTIGRAVITY_QUOTA_COMMAND];
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

  /** A throwaway process answers `initialize`. It never opens a session or makes a model call. */
  async probe(): Promise<{ installed: boolean; version?: string; auth: 'ok' | 'missing' | 'unknown'; models: Array<{ id: string; label: string }> }> {
    const cwd = this.context.runtimeDir;
    fs.mkdirSync(cwd, { recursive: true });
    let transport: LineTransport;
    try {
      const request: LineTransportRequest = {
        argv: this.command(),
        cwd,
        env: buildAntigravityEnv({ base: this.baseEnv, configEnv: this.config.env, home: this.home }),
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
      const version = asString(info.version);
      return { installed: true, ...(version ? { version } : {}), auth: 'unknown', models: [] };
    } catch (error) {
      throw toTransportError(error);
    } finally {
      await client.close({ terminate: true }).catch(() => undefined);
    }
  }

  async start(options: OpenOptions): Promise<AntigravitySession> {
    return this.launch('new', undefined, options);
  }

  async resume(nativeSessionId: string, options: OpenOptions): Promise<AntigravitySession> {
    const loaded = this.sessions.get(nativeSessionId);
    if (loaded && !loaded.isEnded) throw new TransportUnavailableError(`Antigravity session ${nativeSessionId} is already running in this Console.`);
    const recorded = this.readLaunchRecord(options.conversationId, nativeSessionId);
    if (recorded) {
      if (this.disposed) throw new TransportUnavailableError('The Antigravity instance was shut down.');
      const survivor = await this.adoptSurvivor(nativeSessionId, options, recorded.argv, 'survivor');
      if (survivor) return survivor;
    }
    return this.launch('resume', nativeSessionId, options);
  }

  async reattach(nativeSessionId: string, options: OpenOptions): Promise<AntigravitySession | undefined> {
    if (this.disposed) return undefined;
    const recorded = this.readLaunchRecord(options.conversationId, nativeSessionId);
    if (!recorded) return undefined;
    const loaded = this.sessions.get(nativeSessionId);
    if (loaded && !loaded.isEnded) throw new TransportUnavailableError(`Antigravity session ${nativeSessionId} is already running in this Console.`);
    return this.adoptSurvivor(nativeSessionId, options, recorded.argv, 'reattach');
  }

  async dispose(reason: 'shutdown' | 'restart'): Promise<void> {
    this.disposed = true;
    this.log.info({ reason, sessions: this.sessions.size }, 'antigravity instance disposed');
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(session => session.detach()));
  }

  private command(): string[] {
    return this.config.command.length > 0 ? this.config.command : [...DEFAULT_ANTIGRAVITY_COMMAND];
  }

  private dataDir(env: Record<string, string>): string {
    if (env.ANTIGRAVITY_DATA_DIR) return expandHome(env.ANTIGRAVITY_DATA_DIR, this.home);
    return path.join(this.home, '.gemini', 'antigravity-cli');
  }

  private transcriptFor(env: Record<string, string>, sessionId: string): string {
    return antigravityTranscriptPath(this.dataDir(env), sessionId);
  }

  private readLaunchRecord(conversationId: string, sessionId: string): { argv: string[] } | undefined {
    const stored = this.context.meta.get(antigravityLaunchKey(conversationId));
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
    this.context.meta.delete(antigravityLaunchKey(conversationId));
    this.context.meta.delete(antigravityTurnKey(conversationId));
  }

  private readTurnRecord(conversationId: string, sessionId: string): AntigravityTurnRecord | undefined {
    const stored = this.context.meta.get(antigravityTurnKey(conversationId));
    if (!stored) return undefined;
    try {
      const record = JSON.parse(stored) as Partial<AntigravityTurnRecord> & { sessionId?: unknown };
      if (record.sessionId !== sessionId || typeof record.turnId !== 'string' || typeof record.requestId !== 'number') return undefined;
      return {
        turnId: record.turnId,
        requestId: record.requestId,
        startedAt: typeof record.startedAt === 'string' ? record.startedAt : new Date(0).toISOString(),
        ...(typeof record.lastStepIndex === 'number' ? { lastStepIndex: record.lastStepIndex } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private writeTurnRecord(conversationId: string, sessionId: string, record: AntigravityTurnRecord | undefined): void {
    if (record) this.context.meta.set(antigravityTurnKey(conversationId), JSON.stringify({ sessionId, ...record }));
    else this.context.meta.delete(antigravityTurnKey(conversationId));
  }

  private initializeParams(): Record<string, unknown> {
    return { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };
  }

  private async launch(mode: 'new' | 'resume', sessionId: string | undefined, options: OpenOptions): Promise<AntigravitySession> {
    if (this.disposed) throw new TransportUnavailableError('The Antigravity instance was shut down.');
    if (!fs.existsSync(options.cwd)) throw new TransportUnavailableError(`The working directory does not exist: ${options.cwd}`);
    if (this.opening.has(options.conversationId)) throw new TransportUnavailableError('This conversation is already being opened.');
    this.opening.add(options.conversationId);
    try {
      return await this.launchProcess(mode, sessionId, options);
    } finally {
      this.opening.delete(options.conversationId);
    }
  }

  private async launchProcess(mode: 'new' | 'resume', sessionId: string | undefined, options: OpenOptions): Promise<AntigravitySession> {
    const env = buildAntigravityEnv({ base: this.baseEnv, configEnv: this.config.env, optionsEnv: options.env, conversationId: options.conversationId, home: this.home });
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
      throw new TransportUnavailableError('An Antigravity process for this conversation is already running. Try again in a moment.');
    }
    const handshaken = await this.bringUp(transport, fresh, 'launch', mode, sessionId, options, argv, env);
    return handshaken ?? this.launchProcess(mode, sessionId, options);
  }

  private async adoptSurvivor(sessionId: string, options: OpenOptions, argv: string[], kind: 'reattach' | 'survivor'): Promise<AntigravitySession | undefined> {
    if (this.opening.has(options.conversationId)) throw new TransportUnavailableError('This conversation is already being opened.');
    this.opening.add(options.conversationId);
    try {
      return await this.attachSurvivor(sessionId, options, argv, kind);
    } finally {
      this.opening.delete(options.conversationId);
    }
  }

  private async attachSurvivor(sessionId: string, options: OpenOptions, argv: string[], kind: 'reattach' | 'survivor'): Promise<AntigravitySession | undefined> {
    const env = buildAntigravityEnv({ base: this.baseEnv, configEnv: this.config.env, optionsEnv: options.env, conversationId: options.conversationId, home: this.home });
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
          if (kind === 'survivor' && this.noteUnresponsive(options.conversationId) >= ANTIGRAVITY_UNRESPONSIVE_LIMIT_MS) {
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
    if (!endHost) throw new TransportUnavailableError(`The session host ${hostId} has not answered for longer than ${ANTIGRAVITY_UNRESPONSIVE_LIMIT_MS / 60_000} minutes and cannot be ended from here.`);
    this.log.warn({ hostId, limitMs: ANTIGRAVITY_UNRESPONSIVE_LIMIT_MS }, 'the antigravity session host has not answered for longer than the limit; ending it and its process and starting a new one');
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
  ): Promise<AntigravitySession | undefined> {
    const holder: { session?: AntigravitySession } = {};
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
      const decision = decideHandshakeFailure({ kind, fresh, timedOut, silentForMs, limitMs: ANTIGRAVITY_UNRESPONSIVE_LIMIT_MS });
      if (decision === 'replace') {
        this.log.warn({ pid: client.pid, silentForMs, limitMs: ANTIGRAVITY_UNRESPONSIVE_LIMIT_MS, error: errorText(error) }, 'the antigravity process has not answered for longer than the limit; ending it and starting a new one');
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
        this.log.warn({ pid: client.pid, error: errorText(error) }, 'a running antigravity process did not answer the handshake in time; it was left running');
        throw new TransportBusyError(BUSY_MESSAGE);
      }
      throw this.startupError(error, mode, resumeId, client);
    }
  }

  private async handshake(
    client: JsonRpcClient,
    holder: { session?: AntigravitySession },
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
    const makeSession = (sessionId: string, settings: ReturnType<typeof readAntigravitySettings>): AntigravitySession => {
      const transcriptPath = this.transcriptFor(env, sessionId);
      const session = new AntigravitySession({
        sessionId,
        client,
        log: this.log,
        timings: this.timings,
        transcriptPath,
        ...settings,
        onTurnRecord: record => this.writeTurnRecord(options.conversationId, sessionId, record),
        onRateLimited: () => recordAntigravityQuota(this.quotaCommand, this.log),
        onEnded: (ended, kind) => {
          if (this.sessions.get(ended.nativeSessionId) === ended) this.sessions.delete(ended.nativeSessionId);
          if (kind === 'exited') this.forgetLaunch(options.conversationId);
        },
      });
      this.sessions.set(sessionId, session);
      return session;
    };
    const reveal = (session: AntigravitySession): void => {
      holder.session = session;
      early.handoff(session);
    };

    if (mode === 'new') {
      const created = await client.request(ACP_METHODS.newSession, { cwd: options.cwd, mcpServers }, { timeoutMs: this.timings.requestTimeoutMs });
      const sessionId = isRecord(created) ? asString(created.sessionId) : undefined;
      if (!sessionId) throw new TransportUnavailableError('Antigravity did not return a session id.');
      const settings = readAntigravitySettings(created);
      const session = makeSession(sessionId, settings);
      reveal(session);
      this.context.meta.set(antigravityLaunchKey(options.conversationId), JSON.stringify({ sessionId, argv, startedAt: new Date().toISOString() }));
      await this.register(session, options, true);
      session.announce();
      this.log.info({ pid: session.pid, sessionId }, 'antigravity session started');
      return { session, client };
    }

    const sessionId = resumeId!;
    const session = makeSession(sessionId, { models: [], efforts: [] });
    if (!fresh) {
      const recorded = this.readTurnRecord(options.conversationId, sessionId);
      if (recorded) {
        session.adoptRunningTurn(recorded);
        if (recorded.lastStepIndex !== undefined) {
          const settled = antigravityTurnSettled(this.transcriptFor(env, sessionId), { lastStepIndex: recorded.lastStepIndex });
          if (settled === 'finished') session.completeFromStore();
        }
      }
      reveal(session);
      this.context.meta.set(antigravityLaunchKey(options.conversationId), JSON.stringify({ sessionId, argv, startedAt: new Date().toISOString() }));
      await this.register(session, options, false);
      session.announce();
      this.log.info({ pid: session.pid, sessionId, adopted: recorded !== undefined }, 'reattached to a running antigravity session');
      return { session, client };
    }

    const endReplay = session.beginReplay();
    try {
      const loaded = await client.request(ACP_METHODS.loadSession, { sessionId, cwd: options.cwd, mcpServers }, { timeoutMs: this.timings.requestTimeoutMs });
      const settings = readAntigravitySettings(loaded);
      session.noteSettings(settings);
      reveal(session);
    } catch (error) {
      this.sessions.delete(sessionId);
      if (error instanceof JsonRpcRequestError) throw new ResumeFailedError(`Antigravity could not resume session ${sessionId}: ${errorText(error)}`);
      throw error;
    } finally {
      endReplay();
    }
    this.writeTurnRecord(options.conversationId, sessionId, undefined);
    this.context.meta.set(antigravityLaunchKey(options.conversationId), JSON.stringify({ sessionId, argv, startedAt: new Date().toISOString() }));
    await this.register(session, options, false);
    session.announce();
    this.log.info({ pid: session.pid, sessionId }, 'antigravity session resumed');
    return { session, client };
  }

  private async register(session: AntigravitySession, options: OpenOptions, fresh: boolean): Promise<void> {
    const register = this.context.registerConversation;
    const pid = session.pid;
    if (!register || pid === undefined) return;
    try {
      const result = await register({
        provider: 'antigravity',
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
      this.log.warn({ error: errorText(error), sessionId: session.nativeSessionId }, 'antigravity coordination registration failed');
    }
  }

  private startupError(error: unknown, mode: 'new' | 'resume', sessionId: string | undefined, client: JsonRpcClient): Error {
    if (error instanceof ResumeFailedError || error instanceof TransportUnavailableError || error instanceof TransportBusyError) return error;
    if (error instanceof JsonRpcExitError) {
      const text = describeExit(error.exit);
      const failure = mode === 'resume'
        ? new ResumeFailedError(`Antigravity exited while resuming session ${sessionId}: ${text}`)
        : new TransportUnavailableError(`Antigravity exited while starting: ${text}`);
      failure.cause = error;
      return failure;
    }
    this.log.warn({ pid: client.pid, error: errorText(error), stderr: client.stderrTail() }, 'antigravity handshake failed');
    return toTransportError(error);
  }
}
