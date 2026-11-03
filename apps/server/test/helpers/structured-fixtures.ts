import {
  NotSentError,
  PreviousTurnActiveError,
  RequestNotPendingError,
  ResumeFailedError,
  TransportBusyError,
  TransportUnavailableError,
  TurnNotActiveError,
  type OpenOptions,
  type PluginContext,
  type TransportCapabilities,
  type TransportEvent,
  type TransportInstance,
  type TransportPlugin,
  type TransportSession,
  type TurnInput,
  type RequestResponse,
} from '../../src/providers/transport/types.js';

/** Capability shape of the Codex app-server plugin. */
export const CODEX_LIKE_CAPABILITIES: TransportCapabilities = {
  processModel: 'shared',
  steer: 'native',
  interrupt: 'terminal-follows',
  modelSwitch: 'next-turn',
  enforcement: 'native',
  images: false,
  resume: 'reattach',
  nativeIds: 'server-allocated',
};

export interface FakeCall {
  method: string;
  args: unknown[];
}

/** Single-consumer async queue: buffers events until read and ends after the first `stopped` state. */
class EventChannel {
  private readonly queue: TransportEvent[] = [];
  private waiter: ((result: IteratorResult<TransportEvent>) => void) | undefined;
  private ended = false;
  private abandoned = false;
  private claimed = false;

  get isEnded(): boolean { return this.ended || this.abandoned; }

  push(event: TransportEvent): void {
    if (this.abandoned) return; // the consumer stopped reading (for-await break); nobody can see the event
    if (this.ended) throw new Error(`Cannot push ${event.type} after session.state "stopped".`);
    if (event.type === 'session.state' && event.state === 'stopped') this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  iterable(): AsyncIterable<TransportEvent> {
    return { [Symbol.asyncIterator]: () => this.claim() };
  }

  private claim(): AsyncIterator<TransportEvent> {
    if (this.claimed) throw new Error('TransportSession.events has a single consumer.');
    this.claimed = true;
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.isEnded) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<TransportEvent>>((resolve) => { this.waiter = resolve; });
      },
      return: () => {
        this.abandoned = true;
        this.queue.length = 0;
        const resolve = this.waiter;
        this.waiter = undefined;
        resolve?.({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class FakeTransportSession implements TransportSession {
  readonly calls: FakeCall[] = [];
  async setEffort(effort: string, turnId?: string): Promise<void> {
    this.calls.push({ method: 'setEffort', args: [effort, turnId] });
  }
  readonly events: AsyncIterable<TransportEvent>;
  transcriptPath: string | undefined;
  activeTurnId: string | undefined;
  /** A per-session fake gets its own pid, as the real plugin reports its conversation's process. */
  pid: number | undefined;
  closed = false;
  /** Set when the session was adopted from a process that outlived the previous backend (`reattach`), not started or resumed. */
  reattached = false;
  /** What `hasBackgroundWork()` reports: background shell commands or subagents the process is still running. */
  backgroundWork = false;
  /** The next `sendTurn` rejects with this error (once), after being recorded as a call. */
  failNextSend: Error | undefined;
  /** What the next `interrupt` reports (once): the steers the provider dropped with the turn. */
  nextInterruptResult: { cancelledSteerIds: string[] } | undefined;
  /** Request ids `respond` refuses with `RequestNotPendingError`, as a plugin does for a request the provider withdrew. */
  readonly withdrawn = new Set<string>();
  /** The turn the plugin found running when it adopted the process (`TransportSession.activeTurn`). */
  adoptedTurn: string | undefined;
  /** The provider says a turn is running that the plugin cannot name yet (`TransportSession.turnUnidentified`). */
  turnUnidentified = false;
  private turnCounter = 0;
  private readonly channel = new EventChannel();

  constructor(
    private readonly instance: FakeTransportInstance,
    readonly nativeSessionId: string,
    readonly options: OpenOptions,
    readonly resumed: boolean,
  ) {
    this.events = this.channel.iterable();
  }

  get capabilities(): TransportCapabilities { return this.instance.capabilities; }

  get activeTurn(): string | undefined { return this.adoptedTurn; }

  /** Feed an event to the consumer. A terminal for the active turn frees the session for the next turn. */
  push(event: TransportEvent): void {
    if (event.type === 'turn.started' && !event.replay) this.activeTurnId = event.turnId;
    if (event.type === 'turn.terminal' && !event.replay && event.turnId === this.activeTurnId) this.activeTurnId = undefined;
    this.channel.push(event);
  }

  /** Push the terminal event for the active turn (or the given turn). */
  completeTurn(status: 'completed' | 'interrupted' | 'failed' = 'completed', turnId = this.activeTurnId): void {
    if (!turnId) throw new Error('No active turn to complete.');
    this.push({ type: 'turn.terminal', turnId, status, sessionUsable: true, replay: false });
  }

  async sendTurn(input: TurnInput): Promise<{ turnId: string }> {
    this.calls.push({ method: 'sendTurn', args: [input] });
    this.assertOpenBeforeWrite();
    if (this.activeTurnId) throw new PreviousTurnActiveError();
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = undefined;
      throw error;
    }
    const turnId = `turn-${++this.turnCounter}`;
    this.activeTurnId = turnId;
    if (!this.instance.manualTurns) this.push({ type: 'turn.started', turnId, origin: 'user', replay: false });
    return { turnId };
  }

  async steer(turnId: string, input: TurnInput): Promise<void> {
    this.calls.push({ method: 'steer', args: [turnId, input] });
    this.assertOpenBeforeWrite();
    if (this.capabilities.steer === 'none') throw new Error('This fake session does not support steer.');
    if (turnId !== this.activeTurnId) throw new TurnNotActiveError(turnId, `Cannot steer turn ${turnId}: it is not the active turn.`);
  }

  async interrupt(turnId: string): Promise<void | { cancelledSteerIds?: string[] }> {
    this.calls.push({ method: 'interrupt', args: [turnId] });
    this.assertOpen();
    const result = this.nextInterruptResult;
    this.nextInterruptResult = undefined;
    return result;
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    this.calls.push({ method: 'respond', args: [requestId, response] });
    if (this.withdrawn.has(requestId)) throw new RequestNotPendingError(requestId);
  }

  hasBackgroundWork(): boolean {
    return !this.closed && this.backgroundWork;
  }

  /** As the real plugin: the thread leaves memory, so the session ends and its event stream with it. */
  async unload(): Promise<void> {
    this.calls.push({ method: 'unload', args: [] });
    this.stop();
  }

  async close(reason: 'release' | 'shutdown' | 'error'): Promise<void> {
    this.calls.push({ method: 'close', args: [reason] });
    this.stop();
  }

  /** Mark the session stopped and end its event stream. Safe to call more than once. */
  stop(): void {
    this.closed = true;
    this.activeTurnId = undefined;
    if (!this.channel.isEnded) this.channel.push({ type: 'session.state', state: 'stopped' });
  }

  /**
   * What the real plugin throws for a request on an ended session: nothing was written, so the caller may queue the
   * request and try again (`NotSentError`). A request that was already written when the connection ended fails with
   * `TransportUnavailableError` instead; tests produce that with `failNextSend`.
   */
  private assertOpenBeforeWrite(): void {
    if (this.closed) throw new NotSentError('The fake session is closed.');
  }

  /** Requests that need the connection after the session ended: the transport is unavailable. */
  private assertOpen(): void {
    if (this.closed) throw new TransportUnavailableError('The fake session is closed.');
  }
}

export class FakeTransportInstance implements TransportInstance {
  readonly sessions: FakeTransportSession[] = [];
  readonly calls: FakeCall[] = [];
  /** When set, `resume` throws ResumeFailedError. */
  failResume = false;
  /** When true, `sendTurn` does not auto-push `turn.started`; tests push it themselves. */
  manualTurns = false;
  /** Used once as the next `start()` native session id instead of `fake-thread-<n>`. */
  nextNativeSessionId: string | undefined;
  pid: number | undefined = process.pid;
  disposed = false;
  /**
   * Native ids whose provider process outlived the previous backend, with the pid it keeps. `reattach` adopts one of them
   * (once); any other id has no survivor. Shared with the plugin, so a test marks survivors before the instance exists.
   */
  survivors = new Map<string, number>();
  /**
   * Native ids whose surviving process is running a turn (native id -> turn id). The adopted session reports it as `activeTurn`
   * and, as the Claude plugin does, starts a provider-origin turn for it without marking it as adopted.
   */
  survivorTurns = new Map<string, string>();
  /** Native ids whose surviving process runs a turn the plugin cannot name: the adopted session says `turnUnidentified` and reports no turn. */
  survivorUnidentified = new Set<string>();
  /** The next this-many `reattach` calls fail as a provider process that runs but did not answer (`TransportBusyError`), keeping the survivor. */
  reattachBusy = 0;
  private threadCounter = 0;
  private pidCounter = 0;

  constructor(
    readonly plugin: string,
    readonly capabilities: TransportCapabilities,
    readonly config: unknown,
    readonly context: PluginContext,
  ) {}

  async probe(): ReturnType<TransportInstance['probe']> {
    this.calls.push({ method: 'probe', args: [] });
    return { installed: true, version: 'fake-1.0.0', auth: 'ok', models: [{ id: 'fake-model', label: 'Fake model', efforts: ['low', 'medium', 'high'] }] };
  }

  async start(options: OpenOptions): Promise<FakeTransportSession> {
    this.calls.push({ method: 'start', args: [options] });
    this.assertOpen();
    const nativeSessionId = this.nextNativeSessionId ?? `fake-thread-${++this.threadCounter}`;
    this.nextNativeSessionId = undefined;
    return this.open(nativeSessionId, options, false);
  }

  async resume(nativeSessionId: string, options: OpenOptions): Promise<FakeTransportSession> {
    this.calls.push({ method: 'resume', args: [nativeSessionId, options] });
    this.assertOpen();
    if (this.failResume) throw new ResumeFailedError(`Fake resume of ${nativeSessionId} failed.`);
    return this.open(nativeSessionId, options, true);
  }

  /** As the real plugin: adopts a surviving process, never starts one. */
  async reattach(nativeSessionId: string, options: OpenOptions): Promise<FakeTransportSession | undefined> {
    this.calls.push({ method: 'reattach', args: [nativeSessionId, options] });
    this.assertOpen();
    if (this.reattachBusy > 0) {
      this.reattachBusy -= 1;
      throw new TransportBusyError('The running provider process did not answer in time. It was left alone.');
    }
    const pid = this.survivors.get(nativeSessionId);
    if (pid === undefined) return undefined;
    this.survivors.delete(nativeSessionId);
    const session = this.open(nativeSessionId, options, true);
    session.pid = pid;
    session.reattached = true;
    if (this.survivorUnidentified.has(nativeSessionId)) session.turnUnidentified = true;
    const running = this.survivorTurns.get(nativeSessionId);
    if (running) {
      session.adoptedTurn = running;
      session.push({ type: 'turn.started', turnId: running, origin: 'provider', replay: false });
    }
    return session;
  }

  async alive(): Promise<{ pid?: number; connected: boolean }> {
    // A per-session instance is "connected" while it has a running process, as the real plugin reports it.
    const connected = this.capabilities.processModel === 'per-session' ? !this.disposed && this.sessions.some(session => !session.closed) : !this.disposed;
    return { pid: this.pid, connected };
  }

  async dispose(reason: 'shutdown' | 'restart'): Promise<void> {
    this.calls.push({ method: 'dispose', args: [reason] });
    this.disposed = true;
    for (const session of this.sessions) session.stop();
  }

  private open(nativeSessionId: string, options: OpenOptions, resumed: boolean): FakeTransportSession {
    const session = new FakeTransportSession(this, nativeSessionId, options, resumed);
    if (this.capabilities.processModel === 'per-session') session.pid = 40_000 + ++this.pidCounter;
    this.sessions.push(session);
    return session;
  }

  private assertOpen(): void {
    if (this.disposed) throw new TransportUnavailableError('The fake instance is disposed.');
  }
}

export interface FakeTransportPluginOptions {
  id?: string;
  capabilities?: Partial<TransportCapabilities>;
  failResume?: boolean;
  manualTurns?: boolean;
  /** Native id -> pid of a provider process that outlived the previous backend (see `FakeTransportInstance.survivors`). */
  survivors?: Record<string, number>;
  /** Native id -> the turn that surviving process is running (see `FakeTransportInstance.survivorTurns`). */
  survivorTurns?: Record<string, string>;
  /** Native ids whose surviving process runs a turn the plugin cannot name (see `FakeTransportInstance.survivorUnidentified`). */
  survivorUnidentified?: string[];
  /** How many `reattach` calls fail as a process that does not answer in time (see `FakeTransportInstance.reattachBusy`). */
  reattachBusy?: number;
}

export class FakeTransportPlugin implements TransportPlugin {
  readonly id: string;
  readonly instances: FakeTransportInstance[] = [];
  private readonly capabilities: TransportCapabilities;

  constructor(private readonly options: FakeTransportPluginOptions = {}) {
    this.id = options.id ?? 'codex';
    this.capabilities = { ...CODEX_LIKE_CAPABILITIES, ...options.capabilities };
  }

  /** The most recently created instance. */
  get instance(): FakeTransportInstance | undefined { return this.instances.at(-1); }

  create(config: unknown, context: PluginContext): FakeTransportInstance {
    const instance = new FakeTransportInstance(this.id, { ...this.capabilities }, config, context);
    instance.failResume = this.options.failResume ?? false;
    instance.manualTurns = this.options.manualTurns ?? false;
    instance.survivors = new Map(Object.entries(this.options.survivors ?? {}));
    instance.survivorTurns = new Map(Object.entries(this.options.survivorTurns ?? {}));
    instance.survivorUnidentified = new Set(this.options.survivorUnidentified ?? []);
    instance.reattachBusy = this.options.reattachBusy ?? 0;
    this.instances.push(instance);
    return instance;
  }
}

/** A PluginContext whose logging is silent and whose meta is an in-memory map. */
export function fakePluginContext(runtimeDir = '/tmp/agent-console-fake-runtime'): PluginContext & { metaValues: Map<string, string> } {
  const metaValues = new Map<string, string>();
  return {
    runtimeDir,
    log: { info() {}, warn() {} },
    meta: {
      get: (key) => metaValues.get(key),
      set: (key, value) => { metaValues.set(key, value); },
      delete: (key) => { metaValues.delete(key); },
    },
    metaValues,
  };
}

/** For tests that build a `StructuredSessionService` on its own: no profile names a model. */
export const noModelTargets = { resolve: async () => undefined, peek: () => undefined };
