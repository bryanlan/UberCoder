import webpush, { type PushSubscription } from 'web-push';
import type { AgentGrant } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';

/** Standard browser push; keys are private runtime state, never repo config. */
export class GrantPushService {
  private readonly keys: { publicKey: string; privateKey: string };
  constructor(private readonly db: AppDatabase, private readonly publicBaseUrl: string,
    private readonly send = webpush.sendNotification) {
    const saved = db.meta.get('grant-push-vapid');
    this.keys = saved ? JSON.parse(saved) : webpush.generateVAPIDKeys();
    if (!saved) db.meta.set('grant-push-vapid', JSON.stringify(this.keys));
  }
  publicKey(): string { return this.keys.publicKey; }
  subscribe(subscription: PushSubscription): void {
    this.db.sqlite.prepare('insert into agent_push_subscriptions values(?,?,?) on conflict(endpoint) do update set subscription_json=excluded.subscription_json')
      .run(subscription.endpoint, JSON.stringify(subscription), new Date().toISOString());
  }
  unsubscribe(endpoint: string): void { this.db.sqlite.prepare('delete from agent_push_subscriptions where endpoint=?').run(endpoint); }
  async request(grant: AgentGrant): Promise<void> {
    const payload = JSON.stringify({ title: 'Agent permission request', body: grant.scope.slice(0, 1200),
      grantId: grant.id, url: `/grants?request=${encodeURIComponent(grant.id)}` });
    const rows = this.db.sqlite.prepare('select endpoint,subscription_json from agent_push_subscriptions').all() as Array<{ endpoint: string; subscription_json: string }>;
    let accepted = 0, failed = 0;
    this.db.meta.set(`grant-push-delivery:${grant.id}`, JSON.stringify({ timestamp: new Date().toISOString(), subscriptions: rows.length, status: 'sending' }));
    await Promise.allSettled(rows.map(async row => {
      try {
        await this.send(JSON.parse(row.subscription_json) as PushSubscription, payload, {
          vapidDetails: { subject: this.publicBaseUrl, ...this.keys }, TTL: 86400, timeout: 10_000,
        });
        accepted += 1;
      } catch (error) {
        failed += 1;
        if ([404, 410].includes(Number((error as { statusCode?: number }).statusCode))) this.unsubscribe(row.endpoint);
        else this.db.meta.set(`grant-push-error:${grant.id}`, JSON.stringify({ timestamp: new Date().toISOString(), message: 'Push delivery failed; the request remains on the grants page.' }));
      }
    }));
    this.db.meta.set(`grant-push-delivery:${grant.id}`, JSON.stringify({ timestamp: new Date().toISOString(), subscriptions: rows.length, accepted, failed }));
  }
}
