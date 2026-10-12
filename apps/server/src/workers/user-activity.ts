import type { MetaRepo } from '../db/repos/meta.js';
import type { RealtimeEventBus } from '../realtime/event-bus.js';

export const WORKER_IDLE_MS = 10 * 60_000;
const KEY = 'worker-tracking:human-activity-at';

/** Only accepted human submissions and an explicit On action renew the watch window. */
export class WorkerUserActivity {
  private lastAt: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private changed: () => void = () => {};
  private readonly unsubscribe: () => void;
  error: string | null = null;
  constructor(private readonly meta: Pick<MetaRepo, 'get' | 'set'>, events: RealtimeEventBus,
    private readonly clock: () => number = Date.now) {
    try {
      const stored = this.meta.get(KEY);
      const value = stored === undefined ? NaN : Number(stored);
      if (Number.isFinite(value) && value >= 0 && value <= this.clock()) this.lastAt = value;
    } catch { this.error = 'Worker inactivity timing could not be restored.'; }
    this.unsubscribe = events.subscribe((event) => {
      if (event.type === 'session.user-input' && (event.text.trim() || event.images?.length)) this.renew();
    });
  }

  recent(): boolean {
    return this.lastAt !== null && this.clock() >= this.lastAt && this.clock() - this.lastAt < WORKER_IDLE_MS;
  }

  onChange(callback: () => void): void { this.changed = callback; this.arm(); }

  renew(): void {
    this.lastAt = this.clock();
    // Timing failures must never reject an already accepted human message.
    try { this.meta.set(KEY, String(this.lastAt)); this.error = null; }
    catch { this.error = 'Worker inactivity timing could not be saved; tracking may pause after a restart.'; }
    this.arm(); this.changed();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const remaining = this.lastAt === null ? 0 : this.lastAt + WORKER_IDLE_MS - this.clock();
    if (remaining <= 0) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.changed(); this.arm(); }, remaining);
    this.timer.unref();
  }

  stop(): void { this.unsubscribe(); if (this.timer) clearTimeout(this.timer); }
}
