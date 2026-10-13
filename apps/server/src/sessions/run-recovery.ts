import type { BoundSession, RunFailure } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import type { ProviderChildActivity, ProviderRunMonitor, ProviderRunState } from '../providers/types.js';

export const RUN_RETRY_DELAYS_MS = [15_000, 45_000, 120_000] as const;
const RECOVERY_MAX_AGE_MS = 10 * 60_000;
export const RECOVERY_PROMPT = 'Automatic recovery after a transient provider failure. Continue the existing user-authorized task in this same conversation. First inspect the latest conversation and current repository/external state to determine what completed before the interruption. Do not replay completed commands or repeat external side effects. Preserve all existing constraints and approvals; this recovery grants no additional authority.';
const cancellationKey = (id: string) => `run-recovery-cancelled:${id}`;
const budgetKey = (id: string) => `run-recovery-budget:${id}`;

interface RecoveryOptions {
  db: AppDatabase;
  runExclusive: (id: string, fn: () => Promise<void>) => Promise<void>;
  canRetry: (session: BoundSession) => Promise<string | undefined>;
  mayRecover: (session: BoundSession) => boolean;
  submit: (session: BoundSession, text: string, isCurrent: () => boolean) => Promise<void>;
  publish: (session: BoundSession) => void;
  onError: (error: unknown) => void;
  onRunState?: (sessionId: string, run: ProviderRunState) => void;
  onChildActivity?: (sessionId: string, events: ProviderChildActivity[]) => void;
  delaysMs?: readonly number[];
  now?: () => number;
}
interface Observation {
  monitor: ProviderRunMonitor;
  path: string;
  attachedAt: number;
  seen?: string;
  timer?: ReturnType<typeof setTimeout>;
  generation: number;
  lastTurnId?: string;
  lastStatus?: string;
  run?: ProviderRunState;
  processFailure?: ProviderRunState;
}

/** Owns only recovery state; lifecycle/transport ownership remains with SessionManager. */
export class RunRecovery {
  private readonly observations = new Map<string, Observation>();
  private readonly delays: readonly number[];
  private readonly now: () => number;
  constructor(private readonly options: RecoveryOptions) {
    this.delays = options.delaysMs ?? RUN_RETRY_DELAYS_MS;
    this.now = options.now ?? Date.now;
  }

  watch(sessionId: string, path: string, createMonitor: () => ProviderRunMonitor): void {
    const existing = this.observations.get(sessionId);
    if (existing?.path === path) return;
    if (existing?.processFailure) {
      existing.path = path;
      existing.monitor = createMonitor();
      this.changed(sessionId);
      return;
    }
    this.stopWatching(sessionId);
    const prior = this.budget(sessionId);
    this.observations.set(sessionId, { monitor: createMonitor(), path, attachedAt: this.now(), generation: 0,
      processFailure: prior?.code === 'process_exited' ? { turnId: prior.turnId, timestamp: prior.failedAt,
        startedAt: prior.failedAt, status: 'failed', error: { code: prior.code, message: prior.message } } : undefined });
    this.changed(sessionId);
  }

  changed(sessionId: string): void {
    if (!this.observations.has(sessionId)) return;
    void this.options.runExclusive(sessionId, () => this.refresh(sessionId)).catch(this.options.onError);
  }

  getRunState(sessionId: string): ProviderRunState | undefined {
    return this.observations.get(sessionId)?.run;
  }

  /** The lifecycle owner calls this under the same lock after confirming process exit. */
  async processExited(id: string): Promise<void> {
    const session = this.options.db.boundSessions.getById(id);
    if (!session || !this.options.mayRecover(session)) return;
    if (this.budget(id)?.status === 'stopped') return;
    let observation = this.observations.get(id);
    if (!observation) {
      observation = { monitor: { read: async () => undefined }, path: '', attachedAt: this.now(), generation: 0 };
      this.observations.set(id, observation);
    }
    if (!observation.processFailure) {
      const timestamp = new Date(this.now()).toISOString();
      observation.processFailure = { turnId: `process:${session.pid}:${session.startedAt}`, status: 'failed', timestamp,
        startedAt: timestamp, error: { code: 'process_exited', message: 'The provider process exited with unattended work remaining.' } };
    }
    await this.refresh(id);
  }

  private budget(id: string): RunFailure | undefined {
    const visible = this.options.db.boundSessions.getById(id)?.runFailure;
    const value = this.options.db.meta.get(budgetKey(id));
    return visible ?? (value ? JSON.parse(value) as RunFailure : undefined);
  }

  /** Completion must belong to the current run and be confirmed by the session lifecycle. */
  confirmCompletion(id: string, run: ProviderRunState): void {
    const observation = this.observations.get(id);
    const session = this.options.db.boundSessions.getById(id);
    if (run.status !== 'completed' || observation?.run?.turnId !== run.turnId || observation.run.timestamp !== run.timestamp
      || !session?.shouldRestore || session.status !== 'bound' || !session.lastResponseAt || session.lastResponseAt < run.timestamp) return;
    this.clearTimer(observation);
    if (this.budget(id)) this.save(id, undefined);
  }

  cancel(sessionId: string): void {
    const observation = this.observations.get(sessionId);
    if (observation) {
      observation.generation += 1;
      this.clearTimer(observation);
    }
    // Cancellation is a turn boundary, not an ephemeral backend timestamp.
    // Persist it even before the monitor has caught up with a submitted prompt.
    this.options.db.meta.set(cancellationKey(sessionId), JSON.stringify({
      turnId: observation?.run?.turnId, at: this.now(),
    }));
    const failure = this.budget(sessionId);
    if (failure && failure.status !== 'stopped') this.save(sessionId, {
      ...failure, status: 'stopped', nextRetryAt: undefined,
      stoppedReason: 'Automatic recovery cancelled by user input or Stop.',
    });
  }

  stopWatching(sessionId: string): void {
    const observation = this.observations.get(sessionId);
    if (observation) this.clearTimer(observation);
    this.observations.delete(sessionId);
  }
  stop(): void { for (const id of this.observations.keys()) this.stopWatching(id); }

  private clearTimer(observation: Observation): void {
    if (observation.timer) clearTimeout(observation.timer);
    observation.timer = undefined;
  }

  private save(id: string, failure: RunFailure | undefined): void {
    this.options.db.meta.set(budgetKey(id), failure ? JSON.stringify(failure) : '');
    this.options.db.boundSessions.setRunFailure(id, failure);
    const current = this.options.db.boundSessions.getById(id);
    if (!current) return;
    if (failure && failure.status !== 'retrying') {
      current.isWorking = false;
      this.options.db.boundSessions.upsert(current);
    }
    this.options.publish(current);
  }

  /** Caller must hold the session runtime lock, as changed() and retry() do. */
  async refresh(id: string): Promise<void> {
    const observation = this.observations.get(id);
    if (!observation) return;
    const generation = observation.generation;
    const nativeRun = await observation.monitor.read(observation.path);
    if (observation.processFailure && nativeRun && nativeRun.timestamp > observation.processFailure.timestamp) observation.processFailure = undefined;
    const run = observation.processFailure ?? nativeRun;
    if (this.observations.get(id) !== observation || observation.generation !== generation) return;
    const children = observation.monitor.takeChildActivity?.();
    if (children?.length) this.options.onChildActivity?.(id, children);
    if (!run) return;
    const key = `${run.turnId}:${run.status}:${run.timestamp}:${run.progressAt ?? ''}`;
    if (key === observation.seen) return;
    const initial = observation.seen === undefined;
    observation.seen = key;
    observation.lastTurnId = run.turnId;
    observation.lastStatus = run.status;
    observation.run = run;
    this.options.onRunState?.(id, run);
    const session = this.options.db.boundSessions.getById(id);
    if (!session || !session.shouldRestore || session.status !== 'bound') return;
    const prior = this.budget(id);
    this.clearTimer(observation);
    if (run.status !== 'failed') {
      if (run.status === 'running' && prior?.status === 'retrying' && run.turnId !== prior.turnId) {
        if (run.progressAt && run.progressAt >= (prior.retrySubmittedAt ?? prior.failedAt)) this.save(id, undefined);
        else if (session.runFailure) {
          // Acknowledgment clears the UI notice, while the consecutive-failure
          // budget stays durable until genuine output or confirmed completion.
          this.options.db.meta.set(budgetKey(id), JSON.stringify(prior));
          this.options.db.boundSessions.setRunFailure(id, undefined);
          this.options.publish(this.options.db.boundSessions.getById(id)!);
        }
        return;
      }
      // Claude's end_turn can precede a Stop-hook continuation. Keep the budget
      // until the existing ready-prompt lifecycle confirms a completed response.
      if (session.provider === 'claude' && run.status === 'completed'
        && (!session.lastResponseAt || session.lastResponseAt < run.timestamp)) return;
      if (prior) this.save(id, undefined);
      return;
    }
    if (prior?.turnId === run.turnId) {
      if (prior.status === 'scheduled') this.schedule(id, observation, prior);
      else if (initial && prior.status === 'retrying') this.save(id, {
        ...prior, status: 'stopped', stoppedReason: 'The retry submission outcome is uncertain. Review the conversation before continuing.',
      });
      return;
    }
    const progressed = run.progressAt && run.progressAt >= (prior?.retrySubmittedAt ?? run.timestamp);
    const attempts = prior?.status === 'retrying' && !progressed ? prior.attempts : 0;
    const fresh = Date.parse(run.timestamp) >= observation.attachedAt
      || (prior?.status === 'retrying' && Date.parse(run.timestamp) >= Date.parse(prior.retrySubmittedAt ?? '')
        && this.now() - Date.parse(run.timestamp) < RECOVERY_MAX_AGE_MS);
    const cancellation = this.options.db.meta.get(cancellationKey(id));
    const cancelledTurn = cancellation ? JSON.parse(cancellation) as { turnId?: string; at: number } : undefined;
    const cancelled = cancelledTurn !== undefined && (cancelledTurn.turnId === run.turnId
      || Date.parse(run.startedAt ?? run.timestamp) <= cancelledTurn.at);
    const retryable = run.error?.code === 'server_overloaded' || run.error?.code === 'server_unavailable' || run.error?.code === 'process_exited';
    const enabled = this.options.mayRecover(session);
    const allowed = enabled && fresh && !cancelled && retryable && attempts < this.delays.length;
    const failure: RunFailure = {
      turnId: run.turnId, failedAt: run.timestamp,
      code: run.error?.code ?? 'unknown', message: run.error?.message ?? 'The provider stopped.',
      attempts, maxAttempts: this.delays.length,
      status: allowed ? 'scheduled' : 'stopped',
      nextRetryAt: allowed ? new Date(this.now() + this.delays[attempts]!).toISOString() : undefined,
      stoppedReason: !enabled ? 'Unattended recovery is disabled for this session.'
        : cancelled ? 'Automatic recovery was cancelled for this turn.' : !fresh ? 'This run ended before recovery monitoring began. Continue manually when ready.'
        : !retryable ? 'This error requires your attention; it will not be retried automatically.'
          : !allowed ? 'The automatic retry limit was reached.' : undefined,
    };
    this.save(id, failure);
    if (allowed) this.schedule(id, observation, failure);
  }

  private schedule(id: string, observation: Observation, failure: RunFailure): void {
    this.clearTimer(observation);
    const age = this.now() - Date.parse(failure.failedAt);
    const next = Date.parse(failure.nextRetryAt ?? '');
    if (!Number.isFinite(age) || age > RECOVERY_MAX_AGE_MS || !Number.isFinite(next) || failure.attempts >= this.delays.length) {
      this.save(id, { ...failure, status: 'stopped', nextRetryAt: undefined, stoppedReason: 'The recovery window or retry limit expired.' });
      return;
    }
    observation.timer = setTimeout(() => {
      observation.timer = undefined;
      void this.options.runExclusive(id, () => this.retry(id, observation)).catch(this.options.onError);
    }, Math.max(0, next - this.now()));
    observation.timer.unref?.();
  }

  private async retry(id: string, observation: Observation): Promise<void> {
    if (this.observations.get(id) !== observation) return;
    const generation = observation.generation;
    // Reconcile provider state immediately before any submission, including a manual TUI continuation.
    await this.refresh(id);
    let session = this.options.db.boundSessions.getById(id);
    let failure = session?.runFailure;
    if (!session || !failure || failure.status !== 'scheduled' || generation !== observation.generation
      || Date.parse(failure.nextRetryAt ?? '') > this.now()) return;
    const blocked = await this.options.canRetry(session);
    session = this.options.db.boundSessions.getById(id);
    failure = session?.runFailure;
    if (this.observations.get(id) !== observation || generation !== observation.generation || !session || failure?.status !== 'scheduled') return;
    // Timers can fire late after host suspension or a busy session queue.
    // Recheck age after the asynchronous readiness checks, immediately before transport.
    const age = this.now() - Date.parse(failure.failedAt);
    if (blocked || !Number.isFinite(age) || age > RECOVERY_MAX_AGE_MS) {
      if (failure.code === 'process_exited' && blocked === 'The original provider conversation could not be restored.'
        && age <= RECOVERY_MAX_AGE_MS) {
        const attempts = failure.attempts + 1;
        if (attempts >= this.delays.length) {
          this.save(id, { ...failure, attempts, status: 'stopped', nextRetryAt: undefined,
            stoppedReason: 'The provider could not be relaunched after three attempts.' }); return;
        }
        const next = { ...failure, attempts, status: 'scheduled' as const,
          nextRetryAt: new Date(this.now() + this.delays[attempts]!).toISOString() };
        this.save(id, next); this.schedule(id, observation, next); return;
      }
      this.save(id, { ...failure, status: 'stopped', nextRetryAt: undefined, stoppedReason: blocked ?? 'The recovery window expired.' });
      return;
    }
    // Persist the attempt BEFORE transport. Ambiguous delivery is never automatically replayed.
    this.save(id, { ...failure, attempts: failure.attempts + 1, status: 'retrying', nextRetryAt: undefined, retrySubmittedAt: new Date(this.now()).toISOString() });
    try {
      const isCurrent = () => this.observations.get(id) === observation && observation.generation === generation
        && this.options.db.boundSessions.getById(id)?.runFailure?.status === 'retrying';
      await this.options.submit(session, `${RECOVERY_PROMPT} Recovery attempt ${failure.attempts + 1} of ${this.delays.length}.`, isCurrent);
      if (!isCurrent()) return;
      observation.timer = setTimeout(() => {
        observation.timer = undefined;
        void this.options.runExclusive(id, async () => {
          if (this.observations.get(id) !== observation) return;
          await this.refresh(id);
          const current = this.options.db.boundSessions.getById(id)?.runFailure;
          if (current?.status === 'retrying' && observation.lastTurnId === current.turnId && observation.lastStatus === 'failed') {
            this.save(id, { ...current, status: 'stopped', stoppedReason: 'The provider did not acknowledge the retry. Review the conversation before continuing.' });
          }
        }).catch(this.options.onError);
      }, 30_000);
      observation.timer.unref?.();
    } catch (error) {
      const current = this.options.db.boundSessions.getById(id)?.runFailure;
      if (current && current.status !== 'stopped') this.save(id, { ...current, status: 'stopped', stoppedReason: 'Retry submission failed or its outcome is uncertain. Review the conversation before continuing.' });
      this.options.onError(error);
    }
  }
}
