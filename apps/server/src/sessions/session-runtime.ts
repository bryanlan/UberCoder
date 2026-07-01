export interface DeferredSelectionInput {
  text: string;
  expiresAt: number;
}

export interface SessionRuntimeState {
  lastScreenHash?: string;
  deferredTextReadyUntil?: number;
  deferredSelectionInput?: DeferredSelectionInput;
  workingIdleTimer?: NodeJS.Timeout;
  rawOutputScreenUpdateTimer?: NodeJS.Timeout;
  liveSessionModel?: string;
}

interface SessionRuntime {
  tail: Promise<unknown>;
  state: SessionRuntimeState;
}

export interface SlowSessionCommandEvent {
  sessionId: string;
  label: string;
  elapsedMs: number;
}

interface SessionRuntimeRegistryOptions {
  slowCommandMs?: number;
  onSlowCommand?: (event: SlowSessionCommandEvent) => void;
}

const DEFAULT_SLOW_COMMAND_MS = 20_000;

export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly slowCommandMs: number;
  private readonly onSlowCommand?: (event: SlowSessionCommandEvent) => void;

  constructor(options: SessionRuntimeRegistryOptions = {}) {
    this.slowCommandMs = options.slowCommandMs ?? DEFAULT_SLOW_COMMAND_MS;
    this.onSlowCommand = options.onSlowCommand;
  }

  state(sessionId: string): SessionRuntimeState {
    return this.ensure(sessionId).state;
  }

  has(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  keys(): IterableIterator<string> {
    return this.runtimes.keys();
  }

  run<T>(sessionId: string, label: string, fn: () => Promise<T> | T): Promise<T> {
    const runtime = this.ensure(sessionId);
    const run = runtime.tail
      .catch(() => undefined)
      .then(async () => {
        const startedAt = Date.now();
        const slowCommandTimer = this.onSlowCommand && this.slowCommandMs > 0
          ? setTimeout(() => {
            this.onSlowCommand?.({
              sessionId,
              label,
              elapsedMs: Date.now() - startedAt,
            });
          }, this.slowCommandMs)
          : undefined;
        try {
          return await fn();
        } finally {
          if (slowCommandTimer) {
            clearTimeout(slowCommandTimer);
          }
        }
      });
    runtime.tail = run.catch(() => undefined);
    return run;
  }

  clearEphemeral(sessionId: string): void {
    const state = this.state(sessionId);
    state.lastScreenHash = undefined;
    state.deferredTextReadyUntil = undefined;
    state.deferredSelectionInput = undefined;
    state.liveSessionModel = undefined;
  }

  delete(sessionId: string): void {
    this.runtimes.delete(sessionId);
  }

  clear(): void {
    this.runtimes.clear();
  }

  private ensure(sessionId: string): SessionRuntime {
    let runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      runtime = {
        tail: Promise.resolve(),
        state: {},
      };
      this.runtimes.set(sessionId, runtime);
    }
    return runtime;
  }
}
