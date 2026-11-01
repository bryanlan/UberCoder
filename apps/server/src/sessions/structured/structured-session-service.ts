import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  CLAUDE_COST_PROFILES,
  CODEX_COST_PROFILES,
  type AgentLaunchContext,
  type BoundSession,
  type ModelProfileKey,
  type PendingRequestSummary,
  type ProviderId,
  type SessionScreen,
} from '@agent-console/shared';
import { defaultStructuredProviderConfig, type StructuredProviderConfig } from '../../config/schema.js';
import { nowIso } from '../../lib/time.js';
import type { TransportPluginRegistry } from '../../providers/transport/registry.js';
import { hostIdFor as claudeHostId } from '../../providers/transport/claude/claude-instance.js';
import { hostPaths, terminateHost } from '../../providers/transport/line-transport.js';
import {
  NotSentError,
  PreviousTurnActiveError,
  RequestNotPendingError,
  SendRejectedError,
  TransportBusyError,
  TurnNotActiveError,
  type OpenOptions,
  type PluginContext,
  type ProviderFailure,
  type RequestResponse,
  type TransportEvent,
  type TransportCapabilities,
  type TransportInstance,
  type TransportSession,
  type TurnInput,
} from '../../providers/transport/types.js';
import type { QueuedInputRecord } from '../input-queue.js';
import { structuredRequestsKey } from './pending-requests.js';
import { withoutImageInstruction } from '../../images/prompt.js';

export type StructuredSessionsConfig = Partial<Record<string, StructuredProviderConfig>>;

export type StructuredTerminalStatus = 'completed' | 'interrupted' | 'failed';
export type StructuredSessionState = Extract<TransportEvent, { type: 'session.state' }>['state'];

/** The session manager's side of the contract. The service never touches rows, queues or recency itself. */
export interface StructuredCallbacks {
  /**
   * `adopted`: the turn was already running when the session attached (a backend restart left it running). It is not new
   * activity, so the owner marks the conversation working without moving recency.
   */
  onTurnStarted(sessionId: string, turnId: string, origin: 'user' | 'provider', replay?: boolean, adopted?: boolean): void;
  /** `replay` events come from resume backfill; the owner must not let them move recency. */
  onItemCompleted(sessionId: string, at: string, replay?: boolean): void;
  onTurnTerminal(sessionId: string, turnId: string, status: StructuredTerminalStatus, failure?: ProviderFailure, replay?: boolean): void;
  /**
   * A request the service declined at once (an approval, an elicitation, or a question the Console cannot show). The summary can
   * carry a command or question text: the owner keeps it out of the conversation's event log.
   */
  onRequest(sessionId: string, kind: Extract<TransportEvent, { type: 'request.opened' }>['kind'], summary: string): void;
  /**
   * A question is waiting for the person. It is already stored, so the session row projects it. `announced`: the person was told
   * about this request id before (an earlier backend did, and the question outlived it): the owner shows it again without
   * repeating the status line and the push.
   */
  onQuestion(sessionId: string, request: PendingRequestSummary, options: { announced: boolean }): void;
  /** The open questions changed: one was answered or withdrawn, or the session ended. The row projects the new list. */
  onRequestsChanged(sessionId: string): void;
  onSessionState(sessionId: string, state: StructuredSessionState, failure?: ProviderFailure): void;
  appendStatus(sessionId: string, text: string): void;
}

/** A row the host hands over at startup to look for a surviving provider process, with the directory it runs in. */
export interface SurvivorCandidate {
  session: BoundSession;
  cwd: string;
}

export interface StructuredSessionServiceOptions {
  registry: TransportPluginRegistry;
  config: StructuredSessionsConfig;
  createContext: (pluginId: string) => PluginContext;
  meta: PluginContext['meta'];
  callbacks: StructuredCallbacks;
  /**
   * Console-owned environment for every provider process (the coordination runtime and config path, so hooks and
   * MCP servers inside a thread reach this Console). The provider's configured `env` overrides it.
   */
  hostEnv?: Record<string, string>;
  /**
   * The standing-authority text for a session a grant launched (`launchContext` on its row). Passed to a plugin as
   * `OpenOptions.appendSystemPrompt`, which the provider appends to its system prompt.
   */
  authorityContext?: (context: AgentLaunchContext) => string | undefined;
  logger?: { warn(bindings: object, message: string): void };
  /**
   * The Console runtime directory the provider session hosts live in. With it the service can end a per-session provider
   * process whose conversation is not loaded (a survivor nobody adopted) and sweep hosts no conversation owns.
   */
  hosts?: { runtimeDir: string; log: { info(bindings: object, message: string): void; warn(bindings: object, message: string): void } };
}

/** A request that was never sent: the session cannot be reached. Safe to retry later. */
export class StructuredUnavailableError extends Error {
  readonly code = 'structured_unavailable';
  constructor(message: string) { super(message); this.name = 'StructuredUnavailableError'; }
}
/** A request that was never sent: a turn is running and the provider cannot take input mid-turn. */
export class StructuredBusyError extends Error {
  readonly code = 'structured_busy';
  constructor(message = 'A turn is running and this provider cannot take input until it ends.') { super(message); this.name = 'StructuredBusyError'; }
}
/** The request asks for something the structured transport cannot do (for example images). */
export class StructuredUnsupportedError extends Error {
  readonly code = 'structured_unsupported';
  constructor(message: string) { super(message); this.name = 'StructuredUnsupportedError'; }
}
/** The request is not waiting for an answer: it was answered, withdrawn, or its turn ended. */
export class StructuredRequestNotPendingError extends Error {
  readonly code = 'structured_request_not_pending';
  constructor(message = 'That request is no longer waiting for an answer.') { super(message); this.name = 'StructuredRequestNotPendingError'; }
}

/**
 * `deferred`: nothing was sent and a later try may work. `rejected`: nothing was sent and sending it again would fail the
 * same way (a refused model or effort, an attachment that is gone), so `reason` says why and the caller must not retry or
 * call the outcome uncertain. `failed`: the outcome is unknown, so it is never replayed.
 */
export interface AutomaticDelivery {
  status: 'submitted' | 'deferred' | 'rejected' | 'failed';
  reason?: string;
  turnId?: string;
}

const TERMINAL_MEMORY = 64;

/**
 * A provider that is not reporting anything is not trusted to still have background work: past this long without any
 * event from the transport, the flag no longer blocks idle sleep or memory-pressure suspension.
 */
export const BACKGROUND_WORK_STALE_MS = 4 * 3_600_000;

/**
 * What a per-session Claude conversation with no cost profile runs on: effort `medium` and no model of its own (the CLI picks
 * it). No profile is stored on the row.
 */
const UNPROFILED_CLAUDE_EFFORT = 'medium';

/**
 * Where a per-session provider keeps its session host, its launch record and its record of having completed a turn, by provider.
 * The service ends the host and the launch record whenever it ends a conversation's process (a sleep as well as a release); the
 * turn record outlives a sleep, so only the end of the conversation itself (`release`, or a host no row owns) removes it.
 */
const PER_SESSION_HOSTS: Partial<Record<ProviderId, { hostId(sessionId: string): string; launchKey(sessionId: string): string; turnsKey(sessionId: string): string; hostPrefix: string }>> = {
  claude: { hostId: claudeHostId, launchKey: sessionId => `claude-launch:${sessionId}`, turnsKey: sessionId => `claude-turns:${sessionId}`, hostPrefix: 'claude-' },
};

interface LoadedSession {
  readonly sessionId: string;
  readonly provider: ProviderId;
  readonly transport: TransportSession;
  readonly instance: TransportInstance;
  readonly epoch: string;
  pid?: number;
  loaded: boolean;
  /** Set when the host itself ends the session, so the closing event stream is not an unexpected exit. */
  closing: boolean;
  lostReported: boolean;
  /** When the transport last reported anything (or when the session was registered). Bounds the background-work flag. */
  lastEventAt: number;
  activeTurnId?: string;
  /** Turns that were already running when the session attached; their start is not new activity. */
  adoptedTurns: Set<string>;
  /**
   * True from registration until the transport's first burst of events was read: what the plugin queued while it opened or
   * reattached the session (an adopted turn, requests it re-adopted) describes what was already there, not what just happened.
   */
  initialBurst: boolean;
  pendingInterrupt?: { turnId: string; at: string };
  profile?: ModelProfileKey;
  fallbackModel?: { model?: string; effort?: string };
  /** Every request the transport has opened and not closed, answered at once or not. */
  pendingRequests: Set<string>;
  /** The questions held open for the person, stored under `structuredRequestsKey`. */
  questions: Map<string, PendingRequestSummary>;
  /** Questions whose answer is on its way to the transport, so a second answer cannot follow it. */
  answering: Set<string>;
  terminalSeen: string[];
  transcriptPath?: string;
  usage?: { used?: number; max?: number };
}

function profileTable(provider: ProviderId) {
  return provider === 'codex' ? CODEX_COST_PROFILES : CLAUDE_COST_PROFILES;
}

function sessionProfile(session: Pick<BoundSession, 'provider' | 'codexProfile' | 'claudeProfile'>): ModelProfileKey | undefined {
  return session.provider === 'codex' ? session.codexProfile : session.claudeProfile;
}

function providerLabel(provider: ProviderId): string {
  return provider === 'codex' ? 'Codex (app-server)' : 'Claude (structured)';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The message a person's answer to a question the provider asked in a message becomes: one line per question, naming the
 * question so the model can match it. Typed text joins the first question's answers.
 */
function answerMessage(question: PendingRequestSummary, response: Extract<RequestResponse, { decision: 'answer' }>): string {
  const text = response.text?.trim();
  return question.questions.map((item, index) => {
    const answers = (response.answers[item.id] ?? []).filter(answer => typeof answer === 'string' && answer.length > 0);
    if (index === 0 && text) answers.push(text);
    return `Answer to your question: ${item.question}: ${answers.join(', ')}`;
  }).join('\n');
}

const STATUS_REASON_MAX = 200;

/**
 * The reason a bind or restore failed, as one short line for a conversation status line: the first line of the
 * error message, at most 200 characters. The full error stays in the server log; the plugin keeps provider
 * process output (stderr) out of its messages in the first place.
 */
export function structuredStatusReason(error: unknown): string {
  const line = errorMessage(error).split('\n').map(part => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? 'Unknown error.';
  return line.length > STATUS_REASON_MAX ? `${line.slice(0, STATUS_REASON_MAX - 3)}...` : line;
}

/**
 * Drives structured (protocol-based) provider sessions on behalf of SessionManager. It owns the transport
 * instances and sessions, the active-turn bookkeeping, the steer-versus-new-turn policy and the
 * exactly-once turn terminals. SessionManager keeps the lifecycle, journal, recency and recovery decisions.
 */
export class StructuredSessionService {
  private readonly registry: TransportPluginRegistry;
  private readonly config: StructuredSessionsConfig;
  private readonly createContext: (pluginId: string) => PluginContext;
  private readonly meta: PluginContext['meta'];
  private readonly callbacks: StructuredCallbacks;
  private readonly hostEnv: Record<string, string>;
  private readonly authorityContext?: (context: AgentLaunchContext) => string | undefined;
  private readonly logger?: { warn(bindings: object, message: string): void };
  private readonly hosts?: StructuredSessionServiceOptions['hosts'];
  private readonly instances = new Map<string, TransportInstance>();
  /** The context each instance was created with: a per-session conversation reads the coordination identity from it. */
  private readonly contexts = new Map<string, PluginContext>();
  private readonly sessions = new Map<string, LoadedSession>();
  private readonly loading = new Map<string, Promise<'loaded' | 'unavailable'>>();
  /** Survivor lookups at startup, so a use of the conversation waits for the answer instead of racing it with a resume. */
  private readonly reattaching = new Map<string, Promise<unknown>>();
  /** Conversations whose last survivor lookup reached a provider process that did not answer in time (so it is not known to be gone). */
  private readonly busySurvivors = new Set<string>();
  private readonly failures = new Map<string, string>();

  constructor(options: StructuredSessionServiceOptions) {
    this.registry = options.registry;
    this.config = options.config;
    this.createContext = options.createContext;
    this.meta = options.meta;
    this.callbacks = options.callbacks;
    this.hostEnv = options.hostEnv ?? {};
    this.authorityContext = options.authorityContext;
    this.logger = options.logger;
    this.hosts = options.hosts;
  }

  /** Whether new structured sessions may be bound for this provider. Existing rows do not depend on it. */
  isEnabled(provider: ProviderId): boolean {
    return this.config[provider]?.enabled === true && this.registry.get(provider) !== undefined;
  }

  /** Whether sessions of this provider take image attachments. False when no transport plugin serves the provider. */
  supportsImages(provider: ProviderId): boolean {
    try {
      return this.instanceFor(provider).capabilities.images;
    } catch {
      return false;
    }
  }

  configFor(provider: ProviderId): StructuredProviderConfig {
    return this.config[provider] ?? defaultStructuredProviderConfig(provider);
  }

  /**
   * How the provider's processes are shared: one process for every conversation (`shared`) or one per conversation
   * (`per-session`). Undefined when no plugin serves the provider. Decisions about the process (can memory pressure end it,
   * does a release end it) follow this capability, never the plugin's name.
   */
  processModel(provider: ProviderId): TransportCapabilities['processModel'] | undefined {
    try {
      return this.instanceFor(provider).capabilities.processModel;
    } catch {
      return undefined;
    }
  }

  // ---- lifecycle -------------------------------------------------------------------------------------

  /** Create a new native conversation. The returned id is the provider's own session id. */
  async start(input: {
    sessionId: string;
    provider: ProviderId;
    cwd: string;
    profile?: ModelProfileKey;
    model?: string;
    effort?: string;
    launchContext?: AgentLaunchContext;
  }): Promise<{ nativeSessionId: string; transcriptPath?: string; pid?: number }> {
    const state = await this.open(input.sessionId, input.provider, input.cwd, undefined, input.profile, { model: input.model, effort: input.effort }, input.launchContext);
    return { nativeSessionId: state.transport.nativeSessionId, transcriptPath: this.transcriptPath(input.sessionId), pid: state.pid };
  }

  /** Reattach the native conversation of a bound row. Throws the transport's error (ResumeFailedError and others). */
  async resume(session: BoundSession, cwd: string): Promise<{ transcriptPath?: string; pid?: number }> {
    const existing = this.sessions.get(session.id);
    if (existing?.loaded) return { transcriptPath: this.transcriptPath(session.id), pid: existing.pid };
    const nativeSessionId = session.resumeConversationRef ?? session.conversationRef;
    if (nativeSessionId.startsWith('pending:')) throw new StructuredUnavailableError('The conversation has no provider session id yet.');
    const state = await this.open(session.id, session.provider, cwd, nativeSessionId, sessionProfile(session),
      { model: session.launchContext?.model, effort: session.launchContext?.effort }, session.launchContext);
    return { transcriptPath: this.transcriptPath(session.id), pid: state.pid };
  }

  /**
   * A provider process can outlive a backend restart behind its session host, and nothing owns it until its conversation is
   * used. For each candidate row this asks the plugin to adopt what survived: a per-session plugin its conversation's own
   * process, a shared plugin (Codex) the running app-server and the thread's turn in it. A survivor becomes a loaded session
   * (new epoch, "Reconnected" status line), so idle sleep, memory pressure and release can end it like any other, and a turn it
   * is running is the session's active turn. A row with no survivor stays unloaded and resumes on its next use; nothing is
   * started here. The caller passes the rows worth adopting: a shared process keeps every thread loaded in memory once it is
   * resumed, so only a thread that may be running a turn needs it. Returns the ids now loaded. A failure on one row is logged
   * and never stops the others.
   */
  async reattachSurvivors(candidates: SurvivorCandidate[]): Promise<string[]> {
    const adopted: string[] = [];
    for (const candidate of candidates) {
      // A lookup for this conversation is already running: a second resume of the same thread must never start beside it.
      const running = this.reattaching.get(candidate.session.id);
      if (running) {
        await running.catch(() => undefined);
        if (this.alive(candidate.session)) adopted.push(candidate.session.id);
        continue;
      }
      const lookup = this.reattachSurvivor(candidate).finally(() => { this.reattaching.delete(candidate.session.id); });
      this.reattaching.set(candidate.session.id, lookup);
      this.busySurvivors.delete(candidate.session.id);
      try {
        if (await lookup) adopted.push(candidate.session.id);
      } catch (error) {
        // A host or process that runs but did not answer in time is not a process that is gone: the caller must not take the
        // conversation's turn for lost (see `survivorBusy`). Any other failure (a refused handshake, a protocol error, an
        // exit) is reported as the loss it is.
        if (error instanceof TransportBusyError) this.busySurvivors.add(candidate.session.id);
        this.logger?.warn({ err: error, sessionId: candidate.session.id }, 'Reattaching a surviving provider process failed.');
      }
    }
    return adopted;
  }

  /**
   * The last `reattachSurvivors` for this conversation found its session host or process running but not answering in time
   * (`TransportBusyError`, the rule is stated there), and so did not adopt its process. The process may be running a turn; only a later lookup can tell.
   * False after any other outcome, a failed handshake included. The caller bounds how long it keeps asking.
   */
  survivorBusy(sessionId: string): boolean {
    return this.busySurvivors.has(sessionId);
  }

  private async reattachSurvivor({ session, cwd }: SurvivorCandidate): Promise<boolean> {
    if (this.alive(session) || this.loading.has(session.id)) return false; // a use of the conversation got there first
    const nativeSessionId = session.resumeConversationRef ?? session.conversationRef;
    if (nativeSessionId.startsWith('pending:')) return false;
    const instance = this.reattachingInstance(session.provider);
    if (!instance?.reattach) return false;
    const profile = sessionProfile(session);
    const fallback = this.fallbackModel(session.provider, instance, profile, { model: session.launchContext?.model, effort: session.launchContext?.effort });
    const options = this.openOptions(session.id, session.provider, instance, cwd, true, profile, fallback, session.launchContext);
    const transport = await instance.reattach(nativeSessionId, options);
    if (!transport) return false;
    const state = await this.register(session.id, session.provider, instance, transport, profile, fallback, true);
    this.safely(() => this.callbacks.appendStatus(session.id, 'Reconnected to the running agent process'), state);
    return true;
  }

  /** Load the session's thread when it is not loaded. Failures become `unavailable` with a recorded reason. */
  async ensureLoaded(session: BoundSession, cwd?: string): Promise<'loaded' | 'unavailable'> {
    if (this.alive(session)) return 'loaded';
    // A startup lookup for a surviving process may be answering right now; a resume beside it would meet its process.
    const lookup = this.reattaching.get(session.id);
    if (lookup) {
      await lookup.catch(() => undefined);
      if (this.alive(session)) return 'loaded';
    }
    const inflight = this.loading.get(session.id);
    if (inflight) return inflight;
    const run = (async (): Promise<'loaded' | 'unavailable'> => {
      try {
        if (!cwd) throw new StructuredUnavailableError('The project directory for this conversation is unknown.');
        await this.resume(session, cwd);
        this.failures.delete(session.id);
        return 'loaded';
      } catch (error) {
        this.failures.set(session.id, structuredStatusReason(error));
        this.logger?.warn({ err: error, sessionId: session.id }, 'Structured session could not be loaded.');
        return 'unavailable';
      }
    })().finally(() => { this.loading.delete(session.id); });
    this.loading.set(session.id, run);
    return run;
  }

  unavailableReason(sessionId: string): string | undefined {
    return this.failures.get(sessionId);
  }

  /** The session is loaded on a live connection. Synchronous and cheap: the screen poll calls it every second. */
  alive(session: Pick<BoundSession, 'id'>): boolean {
    return this.sessions.get(session.id)?.loaded === true;
  }

  turnActive(session: Pick<BoundSession, 'id'>): boolean {
    return this.sessions.get(session.id)?.activeTurnId !== undefined;
  }

  /** The loaded session's provider says a turn is running that the transport has not named yet (see `TransportSession.turnUnidentified`). */
  turnUnidentified(session: Pick<BoundSession, 'id'>): boolean {
    const state = this.sessions.get(session.id);
    return state?.loaded === true && state.transport.turnUnidentified === true;
  }

  /**
   * A turn is running, named or not. Every "is this row busy?" decision asks this: a turn the transport found running but could
   * not name yet is still running, and ending the session, restarting it or clearing "working" under it would lose that turn.
   */
  turnRunning(session: Pick<BoundSession, 'id'>): boolean {
    return this.turnActive(session) || this.turnUnidentified(session);
  }

  /**
   * The loaded session's process is running background work of its own (a shell command or subagent no turn covers), so idle
   * sleep and memory pressure must not end it. False for a session that is not loaded, for a plugin that cannot tell, and once
   * the transport has said nothing for `BACKGROUND_WORK_STALE_MS`.
   */
  hasBackgroundWork(session: Pick<BoundSession, 'id'>): boolean {
    const state = this.sessions.get(session.id);
    if (!state?.loaded || typeof state.transport.hasBackgroundWork !== 'function') return false;
    if (Date.now() - state.lastEventAt >= BACKGROUND_WORK_STALE_MS) return false;
    return state.transport.hasBackgroundWork() === true;
  }

  loadedPid(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.pid;
  }

  epoch(sessionId: string): string | undefined {
    return this.meta.get(`structured-epoch:${sessionId}`) || undefined;
  }

  transcriptPath(sessionId: string): string | undefined {
    const state = this.sessions.get(sessionId);
    return state?.transport.transcriptPath ?? state?.transcriptPath;
  }

  /** Ask the provider where the transcript is when it has not said yet (the path can lag the first turn). */
  async refreshTranscriptPath(sessionId: string): Promise<string | undefined> {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    const refresh = (state.transport as { refreshTranscriptPath?: () => Promise<string | undefined> }).refreshTranscriptPath;
    if (typeof refresh === 'function') {
      try {
        const refreshed = await refresh.call(state.transport);
        if (refreshed) state.transcriptPath = refreshed;
      } catch (error) {
        this.logger?.warn({ err: error, sessionId }, 'Refreshing the transcript path failed.');
      }
    }
    return this.transcriptPath(sessionId);
  }

  /** Drop the thread from memory (idle sleep, manual suspend). The row and the epoch stay. */
  async unload(session: Pick<BoundSession, 'id'> & Partial<Pick<BoundSession, 'provider'>>): Promise<void> {
    const state = this.sessions.get(session.id);
    if (!state) {
      // Not loaded here, but a per-session provider process may still run for it (a survivor nobody adopted): sleeping ends it too.
      await this.endConversation(session);
      return;
    }
    // The host asked for this end, so the stopped state that follows is not a lost connection. The thread leaves the provider, and
    // its questions with it.
    state.closing = true;
    this.clearAnnounced(session.id);
    this.forget(state);
    // Shared process: the thread leaves memory and the process keeps serving other threads. Per-session: the process is this
    // conversation's alone, so unloading ends it (the transport confirms the exit) and the next load resumes by native id.
    try { await state.transport.unload(); } catch (error) { this.logger?.warn({ err: error, sessionId: session.id }, 'Structured unload failed.'); }
    try { await state.transport.close('shutdown'); } catch (error) { this.logger?.warn({ err: error, sessionId: session.id }, 'Structured close failed.'); }
  }

  /** End the native session for good (release). */
  async release(session: Pick<BoundSession, 'id'> & Partial<Pick<BoundSession, 'provider'>>): Promise<void> {
    const state = this.sessions.get(session.id);
    this.failures.delete(session.id);
    this.meta.delete(`structured-epoch:${session.id}`);
    this.clearAnnounced(session.id);
    this.forgetTurnRecords(session);
    if (!state) {
      await this.endConversation(session);
      return;
    }
    state.closing = true;
    this.forget(state);
    // A per-session process ends with the release itself; a shared one drops the thread first and keeps running.
    if (state.transport.capabilities.processModel !== 'per-session') {
      try { await state.transport.unload(); } catch (error) { this.logger?.warn({ err: error, sessionId: session.id }, 'Structured unload failed.'); }
    }
    await state.transport.close('release');
  }

  /**
   * Tells a plugin that guards a conversation's history that this row already has some: a row the tmux transport ran before it
   * was removed (Phase B), or one whose turns completed before the plugin kept its own record. Without it a resume that finds the saved history deleted would start
   * the conversation again, empty, under the same id. Idempotent; a plugin without the guard ignores it.
   */
  noteConversationHistory(session: Pick<BoundSession, 'id' | 'provider' | 'conversationRef' | 'resumeConversationRef'>): void {
    const nativeSessionId = session.resumeConversationRef ?? session.conversationRef;
    if (nativeSessionId.startsWith('pending:')) return;
    this.instanceFor(session.provider).noteConversationHistory?.(session.id, nativeSessionId);
  }

  /** The conversation is over for good: the per-session providers' record of having completed a turn goes with it. */
  private forgetTurnRecords(session: Pick<BoundSession, 'id'> & Partial<Pick<BoundSession, 'provider'>>): void {
    for (const [provider, naming] of Object.entries(PER_SESSION_HOSTS) as Array<[ProviderId, NonNullable<(typeof PER_SESSION_HOSTS)[ProviderId]>]>) {
      if (session.provider && session.provider !== provider) continue;
      this.meta.delete(naming.turnsKey(session.id));
    }
  }

  /**
   * Ends whatever runs for this conversation without loading it: its provider process behind a session host, and the record of
   * the command line it was launched with. For a conversation that is not loaded here (released or put to sleep while its
   * process had not been adopted since a backend restart, or after an adoption that failed) nothing else would ever end it. A
   * provider with one shared process has nothing of its own to end. The `provider` is read from the row when the caller has it;
   * otherwise every per-session provider is tried (a host that does not exist is a no-op).
   */
  async endConversation(session: Pick<BoundSession, 'id'> & Partial<Pick<BoundSession, 'provider'>>): Promise<void> {
    if (!this.hosts) return;
    for (const [provider, naming] of Object.entries(PER_SESSION_HOSTS) as Array<[ProviderId, NonNullable<(typeof PER_SESSION_HOSTS)[ProviderId]>]>) {
      if (session.provider && session.provider !== provider) continue;
      const hostId = naming.hostId(session.id);
      try {
        await terminateHost(this.hosts.runtimeDir, hostId, this.hosts.log);
      } catch (error) {
        this.logger?.warn({ err: error, sessionId: session.id, hostId }, 'Ending the provider process of a conversation failed.');
      }
      this.meta.delete(naming.launchKey(session.id));
    }
  }

  /**
   * Startup: ends the session hosts of per-session providers whose conversation has no restorable row (a row that was released,
   * deleted or never committed). Each would otherwise run for ever with nothing to ever use or end it. `owned` says whether a
   * conversation id still has a restorable structured row. Hosts of conversations that have one are left to the adoption pass.
   * Returns the host ids it ended.
   */
  async sweepOrphanHosts(owned: (sessionId: string) => boolean): Promise<string[]> {
    if (!this.hosts) return [];
    let names: string[];
    try {
      names = fs.readdirSync(hostPaths(this.hosts.runtimeDir, 'sweep').dir).filter(name => name.endsWith('.json'));
    } catch {
      return []; // no hosts directory yet
    }
    const ended: string[] = [];
    for (const name of names) {
      const hostId = name.slice(0, -'.json'.length);
      for (const naming of Object.values(PER_SESSION_HOSTS)) {
        if (!naming || !hostId.startsWith(naming.hostPrefix)) continue;
        const sessionId = hostId.slice(naming.hostPrefix.length);
        // The id in the file name is the conversation id with unusual characters replaced; a row matches when it maps to this host.
        if (owned(sessionId) && naming.hostId(sessionId) === hostId) break;
        try {
          await terminateHost(this.hosts.runtimeDir, hostId, this.hosts.log);
          this.meta.delete(naming.launchKey(sessionId));
          this.meta.delete(naming.turnsKey(sessionId));
          ended.push(hostId);
        } catch (error) {
          this.logger?.warn({ err: error, hostId }, 'Ending a provider process that no conversation owns failed.');
        }
        break;
      }
    }
    return ended;
  }

  async shutdown(): Promise<void> {
    for (const state of this.sessions.values()) state.closing = true;
    this.sessions.clear();
    const instances = [...this.instances.values()];
    this.instances.clear();
    await Promise.allSettled(instances.map(instance => instance.dispose('shutdown')));
  }

  // ---- input -----------------------------------------------------------------------------------------

  /** Human text: a new turn when idle, a steer while a turn runs (falling back to a new turn if it just ended). */
  async submitHuman(
    session: Pick<BoundSession, 'id'>,
    record: Pick<QueuedInputRecord, 'requestId' | 'text'>,
    images?: TurnInput['images'],
  ): Promise<{ turnId: string; mode: 'turn' | 'steer' }> {
    const state = this.requireLoaded(session);
    if (images?.length && !state.transport.capabilities.images) {
      throw new StructuredUnsupportedError('This structured session cannot take image attachments.');
    }
    // The envelope in the stored message tells a terminal agent to open the files itself. A transport that attaches the images
    // natively would pay for each image twice, so the instruction is dropped from what it sends (the rows stay).
    const text = images?.length ? withoutImageInstruction(record.text) : record.text;
    const input: TurnInput = { text, images, clientMessageId: record.requestId, ...this.modelFor(state) };
    const activeTurnId = state.activeTurnId;
    if (activeTurnId) {
      const steer = state.transport.steer?.bind(state.transport);
      if (state.transport.capabilities.steer === 'none' || !steer) throw new StructuredBusyError();
      try {
        await steer(activeTurnId, input);
        return { turnId: activeTurnId, mode: 'steer' };
      } catch (error) {
        // Only the transport's own "that turn already ended" answer may become a new turn; any other failure
        // (a refusal, a timeout) leaves it unknown whether the text arrived, so it is never sent twice.
        if (!(error instanceof TurnNotActiveError)) throw error;
      }
    }
    return { turnId: await this.startTurn(state, input), mode: 'turn' };
  }

  /**
   * Stop. `cancelledSteerIds` are the steers that were queued behind the turn and that the provider dropped with it (the
   * `requestId` of the message that was sent as a steer): they were never delivered, and the owner marks them so.
   * `notLoaded`: the conversation has no loaded session (asleep, not adopted yet, or its host did not answer), so Stop reached
   * nobody and the provider may still be running a turn; the owner must not leave the row reading "working".
   */
  async interrupt(session: Pick<BoundSession, 'id'>): Promise<{ outcome: 'interrupted' | 'idle' | 'notLoaded'; cancelledSteerIds: string[] }> {
    const state = this.sessions.get(session.id);
    if (!state?.loaded) return { outcome: 'notLoaded', cancelledSteerIds: [] };
    // A turn the transport found running but could not name yet has no id here. Stop must still reach it, so the transport is
    // asked for "the unidentified turn" with an empty id. No interrupt is pending for it: it has no id to match a terminal to.
    const unidentified = state.activeTurnId === undefined && state.transport.turnUnidentified === true;
    // The transport may already know a turn whose `turn.started` has not come through the channel yet (an adoption from a
    // first event, or a send that just returned): Stop must reach that turn too, not report idle and drop.
    const turnId = unidentified ? '' : (state.activeTurnId ?? state.transport.activeTurn);
    if (turnId === undefined) return { outcome: 'idle', cancelledSteerIds: [] };
    if (!unidentified) state.pendingInterrupt = { turnId, at: nowIso() };
    let result: Awaited<ReturnType<TransportSession['interrupt']>>;
    try {
      result = await state.transport.interrupt(turnId);
    } catch (error) {
      if (!unidentified && state.pendingInterrupt?.turnId === turnId) state.pendingInterrupt = undefined;
      throw error;
    }
    const cancelled = result && typeof result === 'object' && Array.isArray(result.cancelledSteerIds) ? result.cancelledSteerIds : [];
    return { outcome: 'interrupted', cancelledSteerIds: cancelled.filter((id): id is string => typeof id === 'string') };
  }

  /** Coordination wake, recovery and restart prompts. Never steers a running turn; never replays. */
  async deliverAutomatic(session: BoundSession, prompt: string): Promise<AutomaticDelivery> {
    const state = this.sessions.get(session.id);
    if (!state?.loaded) return { status: 'deferred', reason: 'The structured session is not loaded.' };
    if (state.activeTurnId) return { status: 'deferred', reason: 'A turn is already running.' };
    if (state.pendingRequests.size) return { status: 'deferred', reason: 'The provider is waiting on a request.' };
    try {
      return { status: 'submitted', turnId: await this.startTurn(state, { text: prompt, ...this.modelFor(state) }) };
    } catch (error) {
      // Both refusals happened before anything was written, so the caller may try again later.
      if (error instanceof PreviousTurnActiveError || error instanceof NotSentError) return { status: 'deferred', reason: error.message };
      // Nothing was written either, but a second try fails the same way: a definite failure, not an uncertain one.
      if (error instanceof SendRejectedError) return { status: 'rejected', reason: structuredStatusReason(error) };
      return { status: 'failed', reason: errorMessage(error) };
    }
  }

  /**
   * Forwards the person's answer to a question held open, once. The question leaves the list as soon as the
   * transport has taken the answer, so a second attempt (a double click, another browser) finds nothing.
   */
  async respond(session: Pick<BoundSession, 'id'>, requestId: string, response: RequestResponse): Promise<{ message?: string }> {
    const state = this.sessions.get(session.id);
    const question = state?.questions.get(requestId);
    if (!state?.loaded || !question || state.answering.has(requestId)) throw new StructuredRequestNotPendingError();
    state.answering.add(requestId);
    // A question the provider asked in a message is not waiting on anything: the answer is a normal message from the person.
    if (question.responseMode === 'message') {
      try {
        if (response.decision !== 'answer') {
          this.closeRequest(state, requestId);
          return {};
        }
        const message = answerMessage(question, response);
        await this.submitHuman(session, { requestId: randomUUID(), text: message });
        this.closeRequest(state, requestId);
        return { message };
      } catch (error) {
        state.answering.delete(requestId);
        throw error;
      }
    }
    try {
      await state.transport.respond(requestId, response);
    } catch (error) {
      state.answering.delete(requestId);
      if (error instanceof RequestNotPendingError) {
        // The provider says it is not open (withdrawn, or its turn ended): it must not stay on the card either.
        this.closeRequest(state, requestId);
        throw new StructuredRequestNotPendingError(error.message);
      }
      throw error;
    }
    this.closeRequest(state, requestId);
    return {};
  }

  /** Switch the profile used by the next turn. A running turn keeps its model, so the switch is deferred. */
  async setProfile(session: BoundSession, profile: ModelProfileKey): Promise<'applied' | 'deferred'> {
    const state = this.sessions.get(session.id);
    if (state?.activeTurnId) return 'deferred';
    if (state) state.profile = profile;
    return 'applied';
  }

  // ---- projection ------------------------------------------------------------------------------------

  /** A synthesized screen: structured sessions have no terminal, but the web still polls /screen. */
  screen(session: BoundSession): SessionScreen {
    const state = this.sessions.get(session.id);
    const profile = state?.profile ?? sessionProfile(session);
    const selected = profile ? profileTable(session.provider)[profile] : undefined;
    const model = selected ? `${selected.model} ${selected.reasoningEffort}` : session.launchContext?.model;
    // `asleep`: the row is not loaded in the provider (manual or idle sleep, or not restored yet). Loading it again reads `idle`.
    const status = `${providerLabel(session.provider)} ${!state?.loaded ? 'asleep' : state.activeTurnId || state.transport.turnUnidentified ? 'working' : 'idle'}`;
    const used = state?.usage?.used, max = state?.usage?.max;
    return {
      content: '',
      inputText: '',
      inputActive: true,
      status,
      statusAnsi: status,
      capturedAt: nowIso(),
      ...(model ? { model } : {}),
      ...(used !== undefined && max ? { contextPercent: Math.max(0, Math.min(100, Math.round(100 - (used / max) * 100))) } : {}),
    };
  }

  // ---- internals -------------------------------------------------------------------------------------

  private requireLoaded(session: Pick<BoundSession, 'id'>): LoadedSession {
    const state = this.sessions.get(session.id);
    if (!state?.loaded) throw new StructuredUnavailableError(this.failures.get(session.id) ?? 'The structured session is not loaded.');
    return state;
  }

  private modelFor(state: LoadedSession): { model?: string; effort?: string } {
    const profile = state.profile;
    if (profile) {
      const selected = profileTable(state.provider)[profile];
      return { model: selected.model, effort: selected.reasoningEffort };
    }
    const fallback = state.fallbackModel;
    return { ...(fallback?.model ? { model: fallback.model } : {}), ...(fallback?.effort ? { effort: fallback.effort } : {}) };
  }

  private async startTurn(state: LoadedSession, input: TurnInput): Promise<string> {
    const { turnId } = await state.transport.sendTurn(input);
    // Events for the turn can be handled before sendTurn resolves; never resurrect a finished turn.
    if (!state.terminalSeen.includes(turnId) && state.loaded) state.activeTurnId = turnId;
    return turnId;
  }

  private instanceFor(provider: ProviderId): TransportInstance {
    const cached = this.instances.get(provider);
    if (cached) return cached;
    const plugin = this.registry.get(provider);
    if (!plugin) throw new StructuredUnavailableError(`No structured transport plugin is registered for ${provider}.`);
    const config = this.configFor(provider);
    const context = this.createContext(plugin.id);
    const instance = plugin.create({ ...config, env: { ...this.hostEnv, ...config.env } }, context);
    this.instances.set(provider, instance);
    this.contexts.set(provider, context);
    return instance;
  }

  private async open(
    sessionId: string,
    provider: ProviderId,
    cwd: string,
    nativeSessionId: string | undefined,
    profile: ModelProfileKey | undefined,
    fallbackModel: { model?: string; effort?: string },
    launchContext: AgentLaunchContext | undefined,
  ): Promise<LoadedSession> {
    const instance = this.instanceFor(provider);
    fallbackModel = this.fallbackModel(provider, instance, profile, fallbackModel);
    const options = this.openOptions(sessionId, provider, instance, cwd, nativeSessionId !== undefined, profile, fallbackModel, launchContext);
    // One process per conversation: a second open while the first is loaded would put two writers on one transcript.
    if (instance.capabilities.processModel === 'per-session' && this.sessions.get(sessionId)?.loaded) {
      throw new StructuredUnavailableError('This conversation already has a running provider process.');
    }
    let transport: TransportSession;
    try {
      transport = nativeSessionId ? await instance.resume(nativeSessionId, options) : await instance.start(options);
    } catch (error) {
      await this.dropInstanceIfDisconnected(provider, instance);
      throw error;
    }
    return await this.register(sessionId, provider, instance, transport, profile, fallbackModel, nativeSessionId !== undefined);
  }

  private openOptions(
    sessionId: string,
    provider: ProviderId,
    instance: TransportInstance,
    cwd: string,
    resuming: boolean,
    profile: ModelProfileKey | undefined,
    fallbackModel: { model?: string; effort?: string },
    launchContext: AgentLaunchContext | undefined,
  ): OpenOptions {
    const selected = profile ? profileTable(provider)[profile] : undefined;
    return {
      conversationId: sessionId,
      cwd,
      model: selected?.model ?? fallbackModel.model,
      effort: selected?.reasoningEffort ?? fallbackModel.effort,
      policy: { approvals: 'never', sandbox: 'full-access' },
      ...this.identityOptions(provider, instance, sessionId, resuming, launchContext),
    };
  }

  /**
   * The model and effort a conversation runs on when its row has no cost profile (a history bind, or a row converted from the
   * removed tmux transport) and no launch named its own: effort `medium` and no model, so a resumed headless Claude process
   * does not start on the CLI's own effort. Nothing is stored on the row. Codex has none: its shared process keeps the
   * model it was configured with.
   */
  private fallbackModel(
    provider: ProviderId,
    instance: TransportInstance,
    profile: ModelProfileKey | undefined,
    fallbackModel: { model?: string; effort?: string },
  ): { model?: string; effort?: string } {
    if (profile || provider !== 'claude' || instance.capabilities.processModel !== 'per-session' || fallbackModel.model || fallbackModel.effort) return fallbackModel;
    return { effort: UNPROFILED_CLAUDE_EFFORT };
  }

  /** The instance of a provider whose plugin can adopt a process that outlived the backend, or undefined (no plugin, or none that can). */
  private reattachingInstance(provider: ProviderId): TransportInstance | undefined {
    try {
      const instance = this.instanceFor(provider);
      return typeof instance.reattach === 'function' ? instance : undefined;
    } catch {
      return undefined;
    }
  }

  /** Makes a started, resumed or reattached transport the conversation's loaded session and starts reading its events. */
  private async register(
    sessionId: string,
    provider: ProviderId,
    instance: TransportInstance,
    transport: TransportSession,
    profile: ModelProfileKey | undefined,
    fallbackModel: { model?: string; effort?: string },
    attaching = false,
  ): Promise<LoadedSession> {
    const connection = await instance.alive().catch(() => ({ pid: undefined, connected: false }));
    const epoch = nowIso();
    const state: LoadedSession = {
      sessionId,
      provider,
      transport,
      instance,
      epoch,
      // A per-session transport knows its own process; a shared instance reports the one process every thread uses.
      pid: transport.pid ?? connection.pid,
      loaded: true,
      closing: false,
      lostReported: false,
      lastEventAt: Date.now(),
      profile,
      fallbackModel,
      adoptedTurns: new Set(),
      initialBurst: attaching,
      pendingRequests: new Set(),
      questions: new Map(),
      answering: new Set(),
      terminalSeen: [],
      transcriptPath: transport.transcriptPath,
    };
    const previous = this.sessions.get(sessionId);
    if (previous) { previous.closing = true; previous.loaded = false; }
    this.sessions.set(sessionId, state);
    this.meta.set(`structured-epoch:${sessionId}`, epoch);
    // A turn the plugin found running when it attached is the session's turn from the start; it is not new activity.
    if (attaching && transport.activeTurn) {
      state.activeTurnId = transport.activeTurn;
      state.adoptedTurns.add(transport.activeTurn);
      this.safely(() => this.callbacks.onTurnStarted(sessionId, transport.activeTurn!, 'provider', false, true), state);
    }
    // Questions of an earlier connection died with it.
    if (this.meta.get(structuredRequestsKey(sessionId))) this.publishRequests(state);
    // What the plugin queued while it attached is read within this turn of the event loop; whatever comes later is new.
    if (attaching) setImmediate(() => { state.initialBurst = false; });
    void this.consume(state);
    return state;
  }

  /**
   * What only a per-session process needs: it carries this conversation's identity in its environment and coordination MCP
   * config. A shared process serves many conversations and never gets one conversation's identity. The authority text and
   * the snapshot choice apply to any plugin that has a system prompt to append to.
   */
  private identityOptions(
    provider: ProviderId,
    instance: TransportInstance,
    sessionId: string,
    resuming: boolean,
    launchContext: AgentLaunchContext | undefined,
  ): Pick<OpenOptions, 'env' | 'consoleIdentity' | 'appendSystemPrompt' | 'systemPromptSnapshot'> {
    const authority = launchContext ? this.authorityContext?.(launchContext) : undefined;
    const options: Pick<OpenOptions, 'env' | 'consoleIdentity' | 'appendSystemPrompt' | 'systemPromptSnapshot'> = {
      ...(authority ? { appendSystemPrompt: authority } : {}),
      // The provider replays the system prompt recorded on a conversation's first request. A resumed granted session must
      // rebuild it, so the authority text names the grants that are active now: a revoked grant must not stay in the prompt,
      // also when nothing is left to append.
      ...(launchContext && resuming ? { systemPromptSnapshot: 'off' as const } : {}),
    };
    if (instance.capabilities.processModel !== 'per-session') return options;
    // The configured env wins over the Console's variables, as it does for the instance; the session id is never overridable.
    options.env = { ...this.hostEnv, ...this.configFor(provider).env, AGENT_CONSOLE_SESSION_ID: sessionId };
    const coordination = this.contexts.get(provider)?.coordination;
    if (coordination) options.consoleIdentity = { sessionId, runtimeDir: coordination.runtimeDir, helperPath: coordination.helperPath };
    return options;
  }

  private forget(state: LoadedSession): void {
    state.loaded = false;
    state.activeTurnId = undefined;
    state.pendingInterrupt = undefined;
    state.pendingRequests.clear();
    state.answering.clear();
    // The questions died with the connection: drop them from the row before the state leaves the table.
    const hadQuestions = state.questions.size > 0;
    state.questions.clear();
    if (this.sessions.get(state.sessionId) === state) {
      if (hadQuestions) this.publishRequests(state);
      this.sessions.delete(state.sessionId);
    }
  }

  /** Writes the open questions to the meta table (where the row projects them from) and tells the owner. */
  private publishRequests(state: LoadedSession): void {
    this.storeRequests(state);
    this.safely(() => this.callbacks.onRequestsChanged(state.sessionId), state);
  }

  private storeRequests(state: LoadedSession): void {
    const key = structuredRequestsKey(state.sessionId);
    if (state.questions.size > 0) this.meta.set(key, JSON.stringify([...state.questions.values()]));
    else this.meta.delete(key);
  }

  /** The transport closed the request, or the person's answer reached it. Idempotent. */
  private closeRequest(state: LoadedSession, requestId: string): void {
    state.pendingRequests.delete(requestId);
    state.answering.delete(requestId);
    if (state.questions.delete(requestId)) {
      this.forgetAnnounced(state, requestId);
      this.publishRequests(state);
    }
  }

  // The request ids the person was told about (status line and push), kept across a backend restart: a question that was still
  // open behind a surviving provider process is shown again by the next backend, without telling the person a second time.
  // They belong to one provider process: Codex numbers its requests from 0 in every app-server process, so ids written down for
  // an earlier process say nothing about the same ids from a new one.
  private announcedKey(sessionId: string): string {
    return `structured-announced:${sessionId}`;
  }

  private announcedIds(state: LoadedSession): string[] {
    try {
      const stored = JSON.parse(this.meta.get(this.announcedKey(state.sessionId)) ?? 'null') as { pid?: unknown; ids?: unknown } | null;
      if (!stored || (stored.pid ?? null) !== (state.pid ?? null) || !Array.isArray(stored.ids)) return [];
      return stored.ids.filter((id): id is string => typeof id === 'string');
    } catch {
      return [];
    }
  }

  private writeAnnounced(state: LoadedSession, ids: string[]): void {
    if (ids.length > 0) this.meta.set(this.announcedKey(state.sessionId), JSON.stringify({ pid: state.pid ?? null, ids: ids.slice(-64) }));
    else this.meta.delete(this.announcedKey(state.sessionId));
  }

  private noteAnnounced(state: LoadedSession, requestId: string): void {
    const ids = this.announcedIds(state);
    if (!ids.includes(requestId)) this.writeAnnounced(state, [...ids, requestId]);
  }

  private forgetAnnounced(state: LoadedSession, requestId: string): void {
    const ids = this.announcedIds(state);
    if (ids.includes(requestId)) this.writeAnnounced(state, ids.filter(id => id !== requestId));
  }

  private clearAnnounced(sessionId: string): void {
    this.meta.delete(this.announcedKey(sessionId));
  }

  /** Closes the questions `belongs` selects: ones a new turn or the end of their own turn made stale. */
  private dropRequests(state: LoadedSession, belongs: (question: PendingRequestSummary) => boolean): void {
    for (const question of [...state.questions.values()]) {
      // A question the provider asked in a message outlives its turn: the model moved on, and the answer is a new message.
      if (question.responseMode !== 'message' && belongs(question)) this.closeRequest(state, question.requestId);
    }
  }

  private openQuestion(state: LoadedSession, event: Extract<TransportEvent, { type: 'request.opened' }>): void {
    if (state.questions.has(event.requestId)) return; // the same request announced again
    const request: PendingRequestSummary = {
      requestId: event.requestId,
      kind: 'question',
      summary: event.summary,
      questions: event.questions ?? [],
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.responseMode === 'message' ? { responseMode: 'message' as const } : {}),
      openedAt: nowIso(),
    };
    state.questions.set(request.requestId, request);
    this.storeRequests(state);
    const announced = this.announcedIds(state).includes(request.requestId);
    if (!announced) this.noteAnnounced(state, request.requestId);
    this.safely(() => this.callbacks.onQuestion(state.sessionId, request, { announced }), state);
  }

  private async dropInstanceIfDisconnected(provider: ProviderId, instance: TransportInstance): Promise<void> {
    // A per-session instance holds no connection that the loss of one conversation could break: every conversation has its
    // own process, and the instance only starts them. Replacing it would strand a conversation that is opening right now.
    if (instance.capabilities.processModel === 'per-session') return;
    const connection = await instance.alive().catch(() => ({ connected: false }));
    if (connection.connected || this.instances.get(provider) !== instance) return;
    this.instances.delete(provider);
    await instance.dispose('restart').catch(() => undefined);
  }

  /** The connection is gone while the host did not ask for it: every turn on it is lost. */
  private async lose(state: LoadedSession, failure: ProviderFailure): Promise<void> {
    if (state.lostReported || state.closing) return;
    state.lostReported = true;
    this.forget(state);
    await this.dropInstanceIfDisconnected(state.provider, state.instance);
    this.safely(() => this.callbacks.onSessionState(state.sessionId, 'error', failure), state);
  }

  private async consume(state: LoadedSession): Promise<void> {
    try {
      for await (const event of state.transport.events) {
        if (state.closing && event.type !== 'session.state') continue;
        this.handle(state, event);
      }
    } catch (error) {
      this.logger?.warn({ err: error, sessionId: state.sessionId }, 'Structured event stream failed.');
    }
    // The stream ending without the host closing the session is an unexpected exit.
    await this.lose(state, { class: 'transport_error', code: 'process_exited', message: 'the event stream ended unexpectedly' });
  }

  private safely(action: () => void, state: LoadedSession): void {
    try { action(); } catch (error) { this.logger?.warn({ err: error, sessionId: state.sessionId }, 'Structured callback failed.'); }
  }

  private handle(state: LoadedSession, event: TransportEvent): void {
    const id = state.sessionId;
    state.lastEventAt = Date.now();
    switch (event.type) {
      case 'session.state':
        if (event.state === 'error' || event.state === 'stopped') {
          if (!state.closing) {
            void this.lose(state, event.failure ?? { class: 'transport_error', code: 'process_exited', message: 'the event stream ended unexpectedly' });
          }
          return;
        }
        this.safely(() => this.callbacks.onSessionState(id, event.state, event.failure), state);
        return;
      case 'session.native':
        if (event.transcriptPath) state.transcriptPath = event.transcriptPath;
        return;
      case 'turn.started':
        // Resume backfill describes history; it never owns the active turn.
        if (!event.replay) {
          state.activeTurnId = event.turnId;
          // A turn the transport reports as running again (it answered a new request with an id already closed
          // locally) must get its own terminal, so it leaves the exactly-once memory.
          const seen = state.terminalSeen.indexOf(event.turnId);
          if (seen >= 0) state.terminalSeen.splice(seen, 1);
          // A question belongs to the turn that raised it; one left over from an earlier turn is stale.
          this.dropRequests(state, question => question.turnId !== event.turnId);
        }
        if (event.adopted === true || (event.origin === 'provider' && state.initialBurst)) state.adoptedTurns.add(event.turnId);
        this.safely(() => this.callbacks.onTurnStarted(id, event.turnId, event.origin, event.replay, state.adoptedTurns.has(event.turnId)), state);
        return;
      case 'item.completed':
        this.safely(() => this.callbacks.onItemCompleted(id, nowIso(), event.replay), state);
        return;
      case 'request.opened': {
        state.pendingRequests.add(event.requestId);
        // A question the person can answer stays open until `respond()` or the transport closes it.
        if (event.kind === 'question' && event.questions?.length) {
          this.openQuestion(state, event);
          return;
        }
        // There is no approval UI: decline anything else, then record it. What it asked stays in the server log; the owner's
        // conversation log gets a fixed line for a question and a short line for the rest.
        void state.transport.respond(event.requestId, { decision: 'decline' }).catch((error: unknown) => {
          if (error instanceof RequestNotPendingError) return; // withdrawn before the decline reached it
          this.logger?.warn({ err: error, sessionId: id, requestId: event.requestId }, 'Declining a provider request failed.');
        });
        this.logger?.warn({ sessionId: id, requestId: event.requestId, kind: event.kind, summary: event.summary }, 'Declined a provider request.');
        this.safely(() => this.callbacks.onRequest(id, event.kind, event.summary), state);
        return;
      }
      case 'request.closed':
        this.closeRequest(state, event.requestId);
        return;
      case 'usage.updated':
        state.usage = { used: event.contextUsedTokens ?? state.usage?.used, max: event.contextMaxTokens ?? state.usage?.max };
        return;
      case 'notice':
        // Notices never count as activity; only warnings are worth a status line.
        if (event.level === 'warn') this.safely(() => this.callbacks.appendStatus(id, event.text), state);
        return;
      case 'turn.terminal':
        this.handleTerminal(state, event);
        return;
    }
  }

  private handleTerminal(state: LoadedSession, event: Extract<TransportEvent, { type: 'turn.terminal' }>): void {
    const id = state.sessionId;
    if (event.replay) {
      this.safely(() => this.callbacks.onTurnTerminal(id, event.turnId, event.status, event.failure, true), state);
      return;
    }
    // Exactly once per turn, whatever the transport sends.
    if (state.terminalSeen.includes(event.turnId)) return;
    state.terminalSeen.push(event.turnId);
    if (state.terminalSeen.length > TERMINAL_MEMORY) state.terminalSeen.shift();
    const interrupted = state.pendingInterrupt?.turnId === event.turnId;
    const status: StructuredTerminalStatus = interrupted && event.status === 'completed' ? 'interrupted' : event.status;
    if (state.activeTurnId === event.turnId) state.activeTurnId = undefined;
    if (interrupted) state.pendingInterrupt = undefined;
    this.dropRequests(state, question => question.turnId === undefined || question.turnId === event.turnId);
    this.safely(() => this.callbacks.onTurnTerminal(id, event.turnId, status, event.failure, false), state);
    if (!event.sessionUsable) {
      void state.transport.close('error').catch(() => undefined);
      void this.lose(state, event.failure ?? { class: 'transport_error', message: 'the session can no longer take turns' });
    }
  }
}
