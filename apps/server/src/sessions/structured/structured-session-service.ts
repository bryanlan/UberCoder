import {
  CLAUDE_COST_PROFILES,
  CODEX_COST_PROFILES,
  type BoundSession,
  type ModelProfileKey,
  type ProviderId,
  type SessionScreen,
} from '@agent-console/shared';
import { DEFAULT_STRUCTURED_PROVIDER_CONFIG, type StructuredProviderConfig } from '../../config/schema.js';
import { nowIso } from '../../lib/time.js';
import type { TransportPluginRegistry } from '../../providers/transport/registry.js';
import {
  NotSentError,
  PreviousTurnActiveError,
  TurnNotActiveError,
  type OpenOptions,
  type PluginContext,
  type ProviderFailure,
  type TransportEvent,
  type TransportInstance,
  type TransportSession,
  type TurnInput,
} from '../../providers/transport/types.js';
import type { QueuedInputRecord } from '../input-queue.js';

export type StructuredSessionsConfig = Partial<Record<string, StructuredProviderConfig>>;

export type StructuredTerminalStatus = 'completed' | 'interrupted' | 'failed';
export type StructuredSessionState = Extract<TransportEvent, { type: 'session.state' }>['state'];

/** The session manager's side of the contract. The service never touches rows, queues or recency itself. */
export interface StructuredCallbacks {
  onTurnStarted(sessionId: string, turnId: string, origin: 'user' | 'provider', replay?: boolean): void;
  /** `replay` events come from resume backfill; the owner must not let them move recency. */
  onItemCompleted(sessionId: string, at: string, replay?: boolean): void;
  onTurnTerminal(sessionId: string, turnId: string, status: StructuredTerminalStatus, failure?: ProviderFailure, replay?: boolean): void;
  onRequest(sessionId: string, summary: string): void;
  onSessionState(sessionId: string, state: StructuredSessionState, failure?: ProviderFailure): void;
  appendStatus(sessionId: string, text: string): void;
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
  logger?: { warn(bindings: object, message: string): void };
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

export interface AutomaticDelivery {
  status: 'submitted' | 'deferred' | 'failed';
  reason?: string;
  turnId?: string;
}

const TERMINAL_MEMORY = 64;

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
  activeTurnId?: string;
  pendingInterrupt?: { turnId: string; at: string };
  profile?: ModelProfileKey;
  fallbackModel?: { model?: string; effort?: string };
  pendingRequests: Set<string>;
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
  private readonly logger?: { warn(bindings: object, message: string): void };
  private readonly instances = new Map<string, TransportInstance>();
  private readonly sessions = new Map<string, LoadedSession>();
  private readonly loading = new Map<string, Promise<'loaded' | 'unavailable'>>();
  private readonly failures = new Map<string, string>();

  constructor(options: StructuredSessionServiceOptions) {
    this.registry = options.registry;
    this.config = options.config;
    this.createContext = options.createContext;
    this.meta = options.meta;
    this.callbacks = options.callbacks;
    this.hostEnv = options.hostEnv ?? {};
    this.logger = options.logger;
  }

  /** Whether new structured sessions may be bound for this provider. Existing rows do not depend on it. */
  isEnabled(provider: ProviderId): boolean {
    return this.config[provider]?.enabled === true && this.registry.get(provider) !== undefined;
  }

  configFor(provider: ProviderId): StructuredProviderConfig {
    return this.config[provider] ?? DEFAULT_STRUCTURED_PROVIDER_CONFIG;
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
  }): Promise<{ nativeSessionId: string; transcriptPath?: string; pid?: number }> {
    const state = await this.open(input.sessionId, input.provider, input.cwd, undefined, input.profile, { model: input.model, effort: input.effort });
    return { nativeSessionId: state.transport.nativeSessionId, transcriptPath: this.transcriptPath(input.sessionId), pid: state.pid };
  }

  /** Reattach the native conversation of a bound row. Throws the transport's error (ResumeFailedError and others). */
  async resume(session: BoundSession, cwd: string): Promise<{ transcriptPath?: string; pid?: number }> {
    const existing = this.sessions.get(session.id);
    if (existing?.loaded) return { transcriptPath: this.transcriptPath(session.id), pid: existing.pid };
    const nativeSessionId = session.resumeConversationRef ?? session.conversationRef;
    if (nativeSessionId.startsWith('pending:')) throw new StructuredUnavailableError('The conversation has no provider session id yet.');
    const state = await this.open(session.id, session.provider, cwd, nativeSessionId, sessionProfile(session),
      { model: session.launchContext?.model, effort: session.launchContext?.effort });
    return { transcriptPath: this.transcriptPath(session.id), pid: state.pid };
  }

  /** Load the session's thread when it is not loaded. Failures become `unavailable` with a recorded reason. */
  async ensureLoaded(session: BoundSession, cwd?: string): Promise<'loaded' | 'unavailable'> {
    if (this.alive(session)) return 'loaded';
    const inflight = this.loading.get(session.id);
    if (inflight) return inflight;
    const run = (async (): Promise<'loaded' | 'unavailable'> => {
      try {
        if (!cwd) throw new StructuredUnavailableError('The project directory for this conversation is unknown.');
        await this.resume(session, cwd);
        this.failures.delete(session.id);
        return 'loaded';
      } catch (error) {
        this.failures.set(session.id, errorMessage(error));
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
  async unload(session: Pick<BoundSession, 'id'>): Promise<void> {
    const state = this.sessions.get(session.id);
    if (!state) return;
    state.closing = true;
    this.forget(state);
    try { await state.transport.unload(); } catch (error) { this.logger?.warn({ err: error, sessionId: session.id }, 'Structured unload failed.'); }
    // A per-session process only ends when closed; a shared process keeps serving other threads.
    try { await state.transport.close('shutdown'); } catch (error) { this.logger?.warn({ err: error, sessionId: session.id }, 'Structured close failed.'); }
  }

  /** End the native session for good (release). */
  async release(session: Pick<BoundSession, 'id'>): Promise<void> {
    const state = this.sessions.get(session.id);
    this.failures.delete(session.id);
    this.meta.delete(`structured-epoch:${session.id}`);
    if (!state) return;
    state.closing = true;
    this.forget(state);
    try { await state.transport.unload(); } catch (error) { this.logger?.warn({ err: error, sessionId: session.id }, 'Structured unload failed.'); }
    await state.transport.close('release');
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
    session: BoundSession,
    record: Pick<QueuedInputRecord, 'requestId' | 'text'>,
    images?: TurnInput['images'],
  ): Promise<{ turnId: string; mode: 'turn' | 'steer' }> {
    const state = this.requireLoaded(session);
    if (images?.length && !state.transport.capabilities.images) {
      throw new StructuredUnsupportedError('This structured session cannot take image attachments.');
    }
    const input: TurnInput = { text: record.text, images, clientMessageId: record.requestId, ...this.modelFor(state) };
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

  async interrupt(session: Pick<BoundSession, 'id'>): Promise<'interrupted' | 'idle'> {
    const state = this.sessions.get(session.id);
    const turnId = state?.activeTurnId;
    if (!state || !turnId) return 'idle';
    state.pendingInterrupt = { turnId, at: nowIso() };
    try {
      await state.transport.interrupt(turnId);
    } catch (error) {
      if (state.pendingInterrupt?.turnId === turnId) state.pendingInterrupt = undefined;
      throw error;
    }
    return 'interrupted';
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
      return { status: 'failed', reason: errorMessage(error) };
    }
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
    const status = `${providerLabel(session.provider)} ${state?.activeTurnId ? 'working' : 'idle'}`;
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
    const instance = plugin.create({ ...config, env: { ...this.hostEnv, ...config.env } }, this.createContext(plugin.id));
    this.instances.set(provider, instance);
    return instance;
  }

  private async open(
    sessionId: string,
    provider: ProviderId,
    cwd: string,
    nativeSessionId: string | undefined,
    profile: ModelProfileKey | undefined,
    fallbackModel: { model?: string; effort?: string },
  ): Promise<LoadedSession> {
    const instance = this.instanceFor(provider);
    const selected = profile ? profileTable(provider)[profile] : undefined;
    const options: OpenOptions = {
      conversationId: sessionId,
      cwd,
      model: selected?.model ?? fallbackModel.model,
      effort: selected?.reasoningEffort ?? fallbackModel.effort,
      policy: { approvals: 'never', sandbox: 'full-access' },
    };
    let transport: TransportSession;
    try {
      transport = nativeSessionId ? await instance.resume(nativeSessionId, options) : await instance.start(options);
    } catch (error) {
      await this.dropInstanceIfDisconnected(provider, instance);
      throw error;
    }
    const connection = await instance.alive().catch(() => ({ pid: undefined, connected: false }));
    const epoch = nowIso();
    const state: LoadedSession = {
      sessionId,
      provider,
      transport,
      instance,
      epoch,
      pid: connection.pid,
      loaded: true,
      closing: false,
      lostReported: false,
      profile,
      fallbackModel,
      pendingRequests: new Set(),
      terminalSeen: [],
      transcriptPath: transport.transcriptPath,
    };
    const previous = this.sessions.get(sessionId);
    if (previous) { previous.closing = true; previous.loaded = false; }
    this.sessions.set(sessionId, state);
    this.meta.set(`structured-epoch:${sessionId}`, epoch);
    void this.consume(state);
    return state;
  }

  private forget(state: LoadedSession): void {
    state.loaded = false;
    state.activeTurnId = undefined;
    state.pendingInterrupt = undefined;
    state.pendingRequests.clear();
    if (this.sessions.get(state.sessionId) === state) this.sessions.delete(state.sessionId);
  }

  private async dropInstanceIfDisconnected(provider: ProviderId, instance: TransportInstance): Promise<void> {
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
        }
        this.safely(() => this.callbacks.onTurnStarted(id, event.turnId, event.origin, event.replay), state);
        return;
      case 'item.completed':
        this.safely(() => this.callbacks.onItemCompleted(id, nowIso(), event.replay), state);
        return;
      case 'request.opened': {
        state.pendingRequests.add(event.requestId);
        // Slice 1 has no approval or question UI: decline, then record it.
        void state.transport.respond(event.requestId, 'decline').catch((error: unknown) => {
          this.logger?.warn({ err: error, sessionId: id, requestId: event.requestId }, 'Declining a provider request failed.');
        });
        this.safely(() => this.callbacks.onRequest(id, event.summary), state);
        return;
      }
      case 'request.closed':
        state.pendingRequests.delete(event.requestId);
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
    this.safely(() => this.callbacks.onTurnTerminal(id, event.turnId, status, event.failure, false), state);
    if (!event.sessionUsable) {
      void state.transport.close('error').catch(() => undefined);
      void this.lose(state, event.failure ?? { class: 'transport_error', message: 'the session can no longer take turns' });
    }
  }
}
