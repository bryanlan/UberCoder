import type Database from 'better-sqlite3';
import type { WakeWarning } from './audit.js';
import { peerWakeAttemptKey, peerWakeFollowupKey, peerWakePauseDetailsKey, type AutomaticInputPause, type PeerWakeAttempt } from './wake.js';

export const SUPERVISOR_RESULT_ALERT_MS = 5 * 60_000;
const fixture = (...descriptions: string[]) => descriptions.some(description => /Disposable.*(?:fixture|verification)/i.test(description));

/** Read-only delivery conditions, independent of the audit reporting window. */
export function deliveryWarnings(db: Database.Database, now = Date.now()): WakeWarning[] {
  const meta = (key: string) => (db.prepare('select value from meta where key=?').get(key) as { value: string } | undefined)?.value;
  const pending = db.prepare(`select m.id,m.recipient_id,m.created_at,a.provider,a.description as recipient_description,
    b.description as sender_description from coordination_messages m join coordination_assignments a on a.id=m.recipient_id
    join coordination_assignments b on b.id=m.sender_id where m.acknowledged_at is null and a.status!='finished'
    and exists(select 1 from bound_sessions s where s.provider=a.provider and s.should_restore=1
      and (s.conversation_ref=a.native_session_id or s.resume_conversation_ref=a.native_session_id))`)
    .all() as Array<{ id: string; recipient_id: string; created_at: string; provider: string; recipient_description: string; sender_description: string }>;
  const warnings: WakeWarning[] = [];
  const observedAt = new Date(now).toISOString();
  for (const message of pending.filter(message => !fixture(message.sender_description, message.recipient_description))) {
    const attempts = [peerWakeAttemptKey(message.id), peerWakeFollowupKey(message.id)].flatMap(key => {
      const text = meta(key);
      if (!text) return [];
      const attempt = JSON.parse(text) as PeerWakeAttempt;
      if (!['submitting', 'submitted', 'failed', 'deferred'].includes(attempt.status) || !Number.isFinite(Date.parse(attempt.timestamp)))
        throw new Error('Invalid stored peer wake attempt.');
      return [attempt];
    });
    const ended = attempts.some(attempt => {
      if (attempt.status !== 'submitted' || now - Date.parse(attempt.timestamp) < 2 * 60_000) return false;
      const session = db.prepare('select last_completed_at from bound_sessions where id=?').get(attempt.sessionId) as { last_completed_at: string | null } | undefined;
      return Boolean(session?.last_completed_at && session.last_completed_at > attempt.timestamp);
    });
    const last = attempts.at(-1);
    if (ended) warnings.push({ key: `delivery:${message.id}`, kind: 'delivery', title: 'Peer response ended without acknowledging its message', observedAt,
      summary: `The ${message.provider} response turn ended but message ${message.id} remains unacknowledged. ${attempts.length > 1 ? `The follow-up is ${last!.status}; no further automatic attempts are permitted.` : 'One guarded follow-up is permitted.'} Inspect hook failures and draft/resource guards.` });
    else if (last && ['failed', 'submitting', 'deferred'].includes(last.status) && now - Date.parse(message.created_at) >= 2 * 60_000
      && (last.status !== 'submitting' || now - Date.parse(last.timestamp) >= 30_000)) warnings.push({
      key: `delivery:${message.id}`, kind: 'delivery', title: 'Peer wake is blocked', observedAt,
      summary: `Message ${message.id} to ${message.provider} assignment ${message.recipient_id} remains unacknowledged. Wake ${last.status}: ${last.reason ?? 'Submission was interrupted or has not been confirmed.'} ${last.status === 'deferred' ? 'No submission occurred; guards will be rechecked.' : 'Uncertain input will not be replayed.'}`,
    });
  }
  const handoffs = db.prepare(`select h.value from meta h
    join coordination_assignments a on a.id=json_extract(h.value,'$.recipientId')
    left join coordination_messages m on m.id=json_extract(h.value,'$.messageId')
    where h.key>='supervisor-handoff:' and h.key<'supervisor-handoff;' and a.status!='finished' and m.acknowledged_at is null`)
    .all() as Array<{ value: string }>;
  const parents = new Map<string, { count: number; oldest: number; reason: string }>();
  for (const row of handoffs) {
    const handoff = JSON.parse(row.value) as { messageId: string; recipientId: string; timestamp: string; blockedReason?: string };
    const timestamp = Date.parse(handoff.timestamp);
    if (!Number.isFinite(timestamp)) throw new Error('Invalid stored supervisor handoff.');
    if (now - timestamp < SUPERVISOR_RESULT_ALERT_MS) continue;
    const parent = db.prepare('select native_session_id,provider,status,description from coordination_assignments where id=?').get(handoff.recipientId) as
      { native_session_id: string; provider: string; status: string; description: string } | undefined;
    if (!parent || parent.status === 'finished' || fixture(parent.description)) continue;
    const message = db.prepare('select acknowledged_at from coordination_messages where id=?').get(handoff.messageId) as { acknowledged_at: string | null } | undefined;
    if (message?.acknowledged_at) continue;
    const session = db.prepare(`select is_working,manual_suspended_at,pressure_suspended_at from bound_sessions
      where provider=? and should_restore=1 and (conversation_ref=? or resume_conversation_ref=?) order by updated_at desc limit 1`)
      .get(parent.provider, parent.native_session_id, parent.native_session_id) as { is_working: number; manual_suspended_at: string | null; pressure_suspended_at: string | null } | undefined;
    const paused = meta(`peer-wake-paused:${handoff.recipientId}`) === 'true';
    if (!session || (session.is_working && !paused && !session.manual_suspended_at && !session.pressure_suspended_at)) continue;
    const details = meta(peerWakePauseDetailsKey(handoff.recipientId));
    const reason = handoff.blockedReason ?? (paused ? details ? (JSON.parse(details) as AutomaticInputPause).reason : 'Automatic input is paused; its original reason was not captured.'
      : session.manual_suspended_at ? 'The supervisor is manually suspended.' : session.pressure_suspended_at ? 'The supervisor is suspended for memory pressure.' : 'The supervisor is idle with unread worker results.');
    const prior = parents.get(handoff.recipientId);
    parents.set(handoff.recipientId, { count: (prior?.count ?? 0) + 1, oldest: Math.min(prior?.oldest ?? timestamp, timestamp), reason });
  }
  for (const [recipientId, parent] of parents) warnings.push({ key: `supervisor-results:${recipientId}`, kind: 'delivery',
    title: 'Supervisor has unread worker results', observedAt,
    summary: `Assignment ${recipientId} has ${parent.count} unacknowledged worker handoffs; the oldest is ${Math.floor((now - parent.oldest) / 60_000)} minutes old. ${parent.reason} Inspect this conversation; alerts do not override pauses or replay uncertain input.` });
  return warnings;
}
