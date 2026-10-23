import { createHash } from 'node:crypto';
import type { CoordinationMessage, MessageOptions, MessagePriority } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';

export const MAIL_NOTICE_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_VALID_FOR = 3600;
export const DURABLE_VALID_FOR = 7 * 24 * 3600;
export const sendOnlyKey = (id: string) => `inbox-send-only:${id}`;
export const expiryKey = (id: string, expiresAt: string) => `inbox-expiry:${expiresAt}:${id}`;
export const messagePolicyKey = (id: string) => `inbox-message:${id}`;
export const acceptsMessages = (db: AppDatabase, id: string) => db.meta.get(sendOnlyKey(id)) !== 'true';
/** Awareness mail cannot consume the storage reserved for critical delivery. Both pools remain bounded. */
export function hasInboxSpace(db: AppDatabase, recipientId: string, priority: MessagePriority = 'P3'): boolean {
  const row=db.sqlite.prepare(`select count(*) n from coordination_messages m
    join meta p on p.key='inbox-message:'||m.id where m.recipient_id=? and m.acknowledged_at is null
    and (json_extract(p.value,'$.priority')='P1')=?`).get(recipientId,priority==='P1'?1:0) as {n:number};
  return row.n<100;
}
export const messageHash = (senderId: string, recipientId: string, text: string) =>
  createHash('sha256').update(JSON.stringify([senderId, recipientId, text])).digest('hex');

export interface MessagePolicy { senderId: string; recipientId: string; createdAt: string; origin: 'direct'|'handoff'|'overdue'|'migrated'; priority: MessagePriority; expiresAt: string; hash: string; suppliedAt?:string; acknowledgedAt?:string; expired?: boolean }
export function messagePolicy(db: AppDatabase, id: string): MessagePolicy {
  const value = db.meta.get(messagePolicyKey(id));
  if (!value) throw new Error(`Missing message policy for ${id}.`);
  return JSON.parse(value) as MessagePolicy;
}
export function setMessagePolicy(db: AppDatabase, id: string, sender: string, recipient: string, text: string,
  options: MessageOptions & {origin?: MessagePolicy['origin']; createdAt?:string} = {}, now = Date.now(), pending = true): MessagePolicy {
  if (options.priority && !['P1','P2','P3'].includes(options.priority)) throw new Error('Invalid message priority.');
  if (options.validFor !== undefined && (!Number.isInteger(options.validFor) || options.validFor < 1 || options.validFor > DURABLE_VALID_FOR)) throw new Error('validFor must be seconds from1 to604800.');
  const policy = { senderId:sender, recipientId:recipient, createdAt:options.createdAt ?? new Date(now).toISOString(), origin:options.origin ?? 'direct', priority: options.priority ?? 'P3', expiresAt: new Date(now + (options.validFor ?? DEFAULT_VALID_FOR) * 1000).toISOString(),
    hash: messageHash(sender, recipient, text) };
  db.meta.set(messagePolicyKey(id), JSON.stringify(policy));
  if (pending) db.meta.set(expiryKey(id, policy.expiresAt), id);
  return policy;
}
export function withMessagePolicy(db: AppDatabase, message: Omit<CoordinationMessage, 'priority' | 'expiresAt'>): CoordinationMessage {
  const { priority, expiresAt } = messagePolicy(db, message.id);
  return { ...message, priority, expiresAt };
}

/** One-time migration. Existing mail gets P3 and one hour from trial adoption to be read. */
export function migrateMessagePolicies(db: AppDatabase): void {
  if (db.meta.get('priority-trial-migrated')) return;
  db.sqlite.transaction(() => {
    const messages = db.sqlite.prepare('select id,sender_id sender,recipient_id recipient,text,created_at createdAt,acknowledged_at acknowledgedAt from coordination_messages')
      .all() as Array<{ id: string; sender: string; recipient: string; text: string; createdAt:string; acknowledgedAt: string | null }>;
    for (const m of messages) if (!db.meta.get(messagePolicyKey(m.id))) setMessagePolicy(db, m.id, m.sender, m.recipient, m.text, {origin:'migrated',createdAt:m.createdAt}, Date.now(), !m.acknowledgedAt);
    const held = db.sqlite.prepare("select value from meta where key>='supervisor-handoff:' and key<'supervisor-handoff;' and json_extract(value,'$.blockedReason') is not null").all() as Array<{ value: string }>;
    for (const row of held) {
      const h = JSON.parse(row.value);
      if (!db.meta.get(messagePolicyKey(h.messageId))) setMessagePolicy(db, h.messageId, h.workerId, h.recipientId, h.text);
    }
    db.sqlite.prepare("delete from meta where key glob 'inbox-urgent:*' or key glob 'inbox-last-wake:*'").run();
    db.meta.set('priority-trial-migrated', new Date().toISOString());
  })();
}

/** Purge message bodies; retain only idempotency/expiry receipts. Never acknowledge expired content. */
export function expireMessages(db: AppDatabase, now = Date.now()): void {
  // The meta primary key is a time-ordered expiry index. Do not scan all historical messages on every hook.
  const expired = db.sqlite.prepare(`select key,value from meta where key>='inbox-expiry:' and key<=?`)
    .all(`inbox-expiry:${new Date(now).toISOString()}:\uffff`) as Array<{ key: string; value: string }>;
  if (!expired.length) return;
  const ids = new Set<string>();
  db.sqlite.transaction(() => {
    for (const row of expired) {
      const id = row.value, policy = messagePolicy(db,id);
      const ack = db.sqlite.prepare('select acknowledged_at acknowledgedAt from coordination_messages where id=?').get(id) as {acknowledgedAt:string|null}|undefined;
      if (!ack?.acknowledgedAt) {
        db.sqlite.prepare('delete from coordination_messages where id=?').run(id);
        db.meta.set(messagePolicyKey(id), JSON.stringify({ ...policy, expired: true }));
        ids.add(id);
      }
      db.sqlite.prepare('delete from meta where key=?').run(row.key);
    }
    const held = db.sqlite.prepare("select key,value from meta where key>='supervisor-handoff:' and key<'supervisor-handoff;'").all() as Array<{ key: string; value: string }>;
    for (const row of held) {
      const h = JSON.parse(row.value);
      if (ids.has(h.messageId)) { delete h.text; delete h.blockedReason; h.expired = true; db.meta.set(row.key, JSON.stringify(h)); }
    }
  })();
}
