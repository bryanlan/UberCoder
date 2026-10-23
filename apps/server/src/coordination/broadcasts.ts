import type { BroadcastCategory, CoordinationBroadcast } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import { DEFAULT_VALID_FOR, MAIL_NOTICE_INTERVAL_MS, messageHash, messagePolicy } from './inbox-policy.js';

const prefix = 'coordination-broadcast:';
const subscriptionKey = (id: string) => `broadcast-subscriptions:${id}`;
const noticeKey = (id: string) => `inbox-mail-notice:${id}`;
type Post = Omit<CoordinationBroadcast, 'text'> & { text?: string; hash: string; expired?: boolean };
type Subscription = { categories: BroadcastCategory[]; repository: string | null };

/** A single retained post, never a fan-out of direct messages. Reading grants no authority. */
export class BroadcastBoard {
  constructor(private readonly db: AppDatabase) {}

  private active(): CoordinationBroadcast[] {
    const rows = this.db.sqlite.prepare("select key,value from meta where key>=? and key<?").all(prefix, 'coordination-broadcast;') as Array<{ key: string; value: string }>;
    const posts: CoordinationBroadcast[] = [];
    for (const row of rows) {
      const post = JSON.parse(row.value) as Post;
      if (!post.expired && Date.parse(post.expiresAt) <= Date.now()) {
        delete post.text; post.expired = true; this.db.meta.set(row.key, JSON.stringify(post));
      }
      if (!post.expired && post.text !== undefined) posts.push(post as CoordinationBroadcast);
    }
    return posts.sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  publish(senderId: string, input: { id: string; text: string; category: BroadcastCategory; repository: string | null; validFor?: number }) {
    this.active();
    const key = prefix + input.id, hash = messageHash(senderId, JSON.stringify([input.category,input.repository]), input.text);
    const existing = this.db.meta.get(key);
    if (existing) {
      const post = JSON.parse(existing) as Post;
      if (post.hash !== hash) throw new Error('Broadcast ID already used for different content.');
      return { id: post.id, expiresAt: post.expiresAt, expired: Boolean(post.expired) };
    }
    const post: Post = { id: input.id, senderId, text: input.text, category: input.category, repository: input.repository,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (input.validFor ?? DEFAULT_VALID_FOR) * 1000).toISOString(), hash };
    this.db.meta.set(key, JSON.stringify(post));
    return { id: post.id, expiresAt: post.expiresAt, expired: false };
  }

  subscribe(id: string, categories: BroadcastCategory[], repository: string | null) {
    const subscription = { categories: [...new Set(categories)], repository };
    this.db.meta.set(subscriptionKey(id), JSON.stringify(subscription));
    return { subscription };
  }

  list(input: { category?: BroadcastCategory; repository?: string; offset?: number } = {}, readerId?: string) {
    const all = this.active().filter(p => (!input.category || p.category === input.category) && (!input.repository || !p.repository || p.repository === input.repository));
    const offset = input.offset ?? 0, posts = all.slice(offset, offset + 20).map(({ id,senderId,category,repository,text,createdAt,expiresAt }) => ({ id,senderId,category,repository,text,createdAt,expiresAt }));
    if (readerId) this.markSeen(readerId, posts.map(p => `broadcast:${p.id}`));
    return { posts, total: all.length, nextOffset: offset + posts.length < all.length ? offset + posts.length : null };
  }

  private markSeen(id: string, keys: string[]) {
    const prior = JSON.parse(this.db.meta.get(noticeKey(id)) ?? '{"seen":[]}') as { lastAt?: number; seen: string[] };
    const liveKeys = new Set(this.active().map(post => `broadcast:${post.id}`));
    for (const m of this.db.sqlite.prepare('select id from coordination_messages where recipient_id=? and acknowledged_at is null').all(id) as Array<{id:string}>) liveKeys.add(`message:${m.id}`);
    this.db.meta.set(noticeKey(id), JSON.stringify({ ...prior, seen: [...new Set([...prior.seen.filter(key=>liveKeys.has(key)), ...keys])] }));
  }

  mailNotice(id: string, supply: boolean) {
    const subscription = JSON.parse(this.db.meta.get(subscriptionKey(id)) ?? '{"categories":[],"repository":null}') as Subscription;
    const messages = (this.db.sqlite.prepare('select id,created_at createdAt from coordination_messages where recipient_id=? and acknowledged_at is null and supplied_at is null')
      .all(id) as Array<{ id: string; createdAt: string }>).filter(m => messagePolicy(this.db, m.id).priority === 'P3');
    const posts = this.active().filter(p => p.senderId !== id && subscription.categories.includes(p.category)
      && (!subscription.repository || !p.repository || p.repository === subscription.repository));
    const entries = [...messages.map(m => ({ key: `message:${m.id}`, createdAt: m.createdAt, category: 'mail' })),
      ...posts.map(p => ({ key: `broadcast:${p.id}`, createdAt: p.createdAt, category: p.category }))];
    if (!entries.length) return null;
    const prior = JSON.parse(this.db.meta.get(noticeKey(id)) ?? '{"seen":[]}') as { lastAt?: number; seen: string[] };
    const seen = new Set(prior.seen), fresh = entries.filter(e => !seen.has(e.key));
    if (!fresh.length) return null;
    const last = prior.lastAt ?? Math.min(...fresh.map(e => Date.parse(e.createdAt)));
    if (Date.now() < last + MAIL_NOTICE_INTERVAL_MS) return null;
    const counts: Record<string, number> = {};
    for (const e of fresh) counts[e.category] = (counts[e.category] ?? 0) + 1;
    if (supply) this.db.meta.set(noticeKey(id), JSON.stringify({ lastAt: Date.now(), seen: entries.filter(e => seen.has(e.key) || fresh.includes(e)).map(e => e.key) }));
    return { counts, note: "You've got mail. Read P3 bodies with action:mail or category posts with action:broadcasts when useful. No acknowledgement-only reply is needed." };
  }
}
