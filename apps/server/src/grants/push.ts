import webpush, { type PushSubscription } from 'web-push';
import type { AgentGrant } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import type { WakeWarning } from '../coordination/audit.js';

export interface PushDelivery { subscriptions: number; accepted: number; failed: number; acceptedEndpoints: string[] }

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
    await this.deliver(payload, `grant-push-delivery:${grant.id}`, `grant-push-error:${grant.id}`);
  }
  async wakeWarning(warning: WakeWarning, deliveredEndpoints: readonly string[]): Promise<PushDelivery> {
    const session = warning.key.startsWith('supervisor-results:')
      ? this.db.sqlite.prepare(`select s.project_slug,s.provider,s.conversation_ref from coordination_assignments a
          join bound_sessions s on s.provider=a.provider and (s.conversation_ref=a.native_session_id or s.resume_conversation_ref=a.native_session_id)
          where a.id=? and s.should_restore=1 order by s.updated_at desc limit 1`).get(warning.key.slice('supervisor-results:'.length))
      : this.db.sqlite.prepare(`select s.project_slug,s.provider,s.conversation_ref from coordination_messages m
          join coordination_assignments a on a.id=m.recipient_id join bound_sessions s on s.provider=a.provider
          and (s.conversation_ref=a.native_session_id or s.resume_conversation_ref=a.native_session_id)
          where m.id=? and s.should_restore=1 order by s.updated_at desc limit 1`).get(warning.key.slice('delivery:'.length));
    const target = session as { project_slug: string; provider: string; conversation_ref: string } | undefined;
    const url = target ? `/projects/${encodeURIComponent(target.project_slug)}/${target.provider}/${encodeURIComponent(target.conversation_ref)}` : '/';
    return this.deliver(JSON.stringify({ title: warning.title, body: warning.summary, warningKey: warning.key, url }),
      `wake-push-delivery:${warning.key}`, `wake-push-error:${warning.key}`, deliveredEndpoints);
  }
  private async deliver(payload: string, deliveryKey: string, errorKey: string, deliveredEndpoints: readonly string[] = []): Promise<PushDelivery> {
    const delivered = new Set(deliveredEndpoints);
    const rows = (this.db.sqlite.prepare('select endpoint,subscription_json from agent_push_subscriptions').all() as Array<{ endpoint: string; subscription_json: string }>)
      .filter(row => !delivered.has(row.endpoint));
    let accepted = 0, failed = 0;
    const acceptedEndpoints: string[] = [];
    this.db.meta.set(deliveryKey, JSON.stringify({ timestamp: new Date().toISOString(), subscriptions: rows.length, status: 'sending' }));
    await Promise.allSettled(rows.map(async row => {
      try {
        await this.send(JSON.parse(row.subscription_json) as PushSubscription, payload, {
          vapidDetails: { subject: this.publicBaseUrl, ...this.keys }, TTL: 86400, timeout: 10_000,
        });
        accepted += 1;
        acceptedEndpoints.push(row.endpoint);
      } catch (error) {
        failed += 1;
        if ([404, 410].includes(Number((error as { statusCode?: number }).statusCode))) this.unsubscribe(row.endpoint);
        else this.db.meta.set(errorKey, JSON.stringify({ timestamp: new Date().toISOString(), message: 'Push delivery failed; the notification condition remains in Console or its wake audit.' }));
      }
    }));
    const result = { subscriptions: rows.length, accepted, failed, acceptedEndpoints };
    this.db.meta.set(deliveryKey, JSON.stringify({ timestamp: new Date().toISOString(), ...result }));
    return result;
  }
}
