import type { AppDatabase } from '../db/database.js';
import type { WakeWarning } from './audit.js';
import { deliveryWarnings } from './delivery-warnings.js';
import type { PushDelivery } from '../grants/push.js';

interface AlertState { active: boolean; deliveredEndpoints: string[]; lastAttemptAt?: number }

/** One notification per device and persistent condition; failed devices retry. */
export class WakeAlerts {
  private running?: Promise<void>;
  constructor(private readonly db: AppDatabase,
    private readonly notify: (warning: WakeWarning, deliveredEndpoints: readonly string[]) => Promise<PushDelivery>) {}
  check(now = Date.now()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain(now).finally(() => { this.running = undefined; });
    return this.running;
  }
  async stop(): Promise<void> { await this.running; }
  private async drain(now: number): Promise<void> {
    const grouped = new Map<string, { warning: WakeWarning; count: number }>();
    for (const warning of deliveryWarnings(this.db.sqlite, now)) {
      const recipient = warning.key.startsWith('delivery:') ? this.db.sqlite.prepare('select recipient_id from coordination_messages where id=?')
        .get(warning.key.slice('delivery:'.length)) as { recipient_id: string } | undefined : undefined;
      const key = `wake-alert:${recipient ? `delivery-recipient:${recipient.recipient_id}` : warning.key}`;
      const prior = grouped.get(key);
      grouped.set(key, { warning: prior?.warning ?? warning, count: (prior?.count ?? 0) + 1 });
    }
    const keys = new Set(grouped.keys());
    for (const row of this.db.sqlite.prepare("select key,value from meta where key>='wake-alert:' and key<'wake-alert;'").all() as Array<{ key: string; value: string }>) {
      const state = JSON.parse(row.value) as AlertState;
      if (state.active && !keys.has(row.key)) this.db.meta.set(row.key, JSON.stringify({ active: false, deliveredEndpoints: [] } satisfies AlertState));
    }
    for (const [key, group] of grouped) {
      const warning = group.count > 1 ? { ...group.warning, summary: `${group.count} unread messages need delivery review. ${group.warning.summary}` } : group.warning;
      const text = this.db.meta.get(key);
      const prior = text ? JSON.parse(text) as AlertState : undefined;
      if (prior?.active && prior.lastAttemptAt !== undefined && now - prior.lastAttemptAt < 5 * 60_000) continue;
      const deliveredEndpoints = prior?.active ? prior.deliveredEndpoints : [];
      this.db.meta.set(key, JSON.stringify({ active: true, deliveredEndpoints, lastAttemptAt: now } satisfies AlertState));
      const delivery = await this.notify(warning, deliveredEndpoints);
      this.db.meta.set(key, JSON.stringify({ active: true, deliveredEndpoints: [...new Set([...deliveredEndpoints, ...delivery.acceptedEndpoints])], lastAttemptAt: now } satisfies AlertState));
    }
  }
}
