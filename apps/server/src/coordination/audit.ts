import type Database from 'better-sqlite3';
import { readNativeWakeTurns, type NativeWakeTurn, type WakeTokens } from '../providers/transcripts/peer-wake-usage.js';
import type { ProviderId } from '@agent-console/shared';
import { peerWakeAttemptKey, peerWakeFollowupKey, type PeerWakeAttempt } from './wake.js';
import { readCoordinationTelemetry, summarizeCoordinationTelemetry } from './telemetry.js';

const MINUTE = 60_000;
export const WAKE_AUDIT_POLICY = { wakesInTenMinutes: 5, wakesInHour: 20, pairAlternationsInTenMinutes: 6,
  backlogAgeMinutes: 60, calibrationDays: 7, mode: 'warnings_only' } as const;
interface Message {
  id: string; senderId: string; recipientId: string; createdAt: string; acknowledgedAt: string | null;
  fixture: boolean;
  attempt: number;
}
export interface AuditedWake {
  sessionId: string; timestamp: string; provider: ProviderId; project: string; nativeSessionId: string;
  status: PeerWakeAttempt['status']; restoration: PeerWakeAttempt['restoration'] | 'unknown';
  category: 'normal' | 'fixture' | 'backlog'; messages: Message[]; reason: string | null;
  nativeTurn: NativeWakeTurn | null; durationMs: number | null; usageReason: string | null;
}
export interface WakeWarning { key: string; kind: 'frequency' | 'possible_loop' | 'transport' | 'delivery'; title: string; summary: string; observedAt: string; }
interface AttemptRow {
  key: string; value: string; provider: ProviderId; project_slug: string | null; conversation_ref: string;
  transcript_path: string | null; id: string; sender_id: string; recipient_id: string;
  created_at: string; acknowledged_at: string | null; sender_description: string; recipient_description: string;
  attempt: number;
}
function fixture(...descriptions: string[]): boolean {
  return descriptions.some((s) => /Disposable.*(?:fixture|verification)/i.test(s));
}
const iso = (ms: number) => new Date(ms).toISOString();
function percentile(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * percentile) - 1]!;
}
function warningsAt(wakes: AuditedWake[], now: number): WakeWarning[] {
  const normal = wakes.filter((w) => w.status === 'submitted' && w.category === 'normal' && Date.parse(w.timestamp) <= now);
  const agents = new Map<string, AuditedWake[]>();
  for (const w of normal) {
    const id = w.messages[0]!.recipientId;
    agents.set(id, [...agents.get(id) ?? [], w]);
  }
  const warnings: WakeWarning[] = [];
  for (const [id, rows] of agents) {
    const ten = rows.filter((w) => now - Date.parse(w.timestamp) < 10 * MINUTE).length;
    const hour = rows.filter((w) => now - Date.parse(w.timestamp) < 60 * MINUTE).length;
    if (ten >= WAKE_AUDIT_POLICY.wakesInTenMinutes || hour >= WAKE_AUDIT_POLICY.wakesInHour) warnings.push({
      key: `frequency:${id}`, kind: 'frequency', title: 'Review frequent automatic peer responses', observedAt: iso(now),
      summary: `${rows[0]!.provider} in ${rows[0]!.project}: ${ten} wake submissions in 10 minutes and ${hour} in one hour at ${iso(now)}. Review the peer exchanges; delivery remains enabled.`,
    });
  }
  const pairs = new Map<string, Array<{ timestamp: string; direction: string }>>();
  for (const w of normal.filter((v) => now - Date.parse(v.timestamp) < 10 * MINUTE)) {
    const seen = new Set<string>();
    for (const m of w.messages) {
      const pair = [m.senderId, m.recipientId].sort().join(':');
      if (seen.has(pair) || m.senderId === m.recipientId) continue;
      seen.add(pair); pairs.set(pair, [...pairs.get(pair) ?? [], { timestamp: w.timestamp, direction: m.senderId }]);
    }
  }
  for (const [pair, events] of pairs) {
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let alternating = 0, prior: string | undefined;
    for (const e of events) { if (e.direction !== prior) alternating++; prior = e.direction; }
    if (alternating >= WAKE_AUDIT_POLICY.pairAlternationsInTenMinutes) warnings.push({
      key: `possible-loop:${pair}`, kind: 'possible_loop', title: 'Review repeated agent back-and-forth', observedAt: iso(now),
      summary: `${alternating} alternating wake submissions between assignments ${pair} in 10 minutes at ${iso(now)}. This is a possible conversation loop, not proof of wasted work.`,
    });
  }
  return warnings;
}

/** Evaluate event-ending windows, so a burst between scheduler checks cannot disappear. */
function observedWarnings(wakes: AuditedWake[], from: number, until: number): WakeWarning[] {
  const endpoints = [...new Set(wakes.filter((w) => w.status === 'submitted' && w.category === 'normal'
    && Date.parse(w.timestamp) >= from && Date.parse(w.timestamp) <= until).map((w) => Date.parse(w.timestamp)))].sort((a, b) => a - b);
  const latest = new Map<string, WakeWarning>();
  for (const at of endpoints) for (const warning of warningsAt(wakes, at)) latest.set(warning.key, warning);
  return [...latest.values()];
}
export function wakeWarnings(wakes: AuditedWake[], now: number): WakeWarning[] {
  const recent = new Map(observedWarnings(wakes, now - 10 * MINUTE, now).map((w) => [w.key, w]));
  for (const warning of warningsAt(wakes, now)) recent.set(warning.key, warning);
  return [...recent.values()];
}

/** Read-only snapshot: opening/migrating the application database is deliberately outside this module. */
export async function auditPeerWakes(db: Database.Database, options: { now?: number; hours?: number; includeUsage?: boolean; runtimeDir?: string } = {}) {
  const now = options.now ?? Date.now(), hours = options.hours ?? 24;
  if (!Number.isFinite(now) || !Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error('Audit hours must be between 1 and 168.');
  const from = now - hours * 60 * MINUTE;
  // Read only selected measurement fields. Never export message text or credentials.
  const rows = db.prepare(`with attempts as materialized (
    select key,value,substr(key,length('peer-wake-attempt:')+1) as message_id,1 as attempt from meta where key like 'peer-wake-attempt:%'
    union all
    select key,value,substr(key,length('peer-wake-followup:')+1),2 from meta where key like 'peer-wake-followup:%')
    select x.key,x.value,b.provider,s.project_slug,b.native_session_id as conversation_ref,i.transcript_path,
    m.id,m.sender_id,m.recipient_id,m.created_at,m.acknowledged_at,x.attempt,
    a.description as sender_description,b.description as recipient_description
    from attempts x join coordination_messages m on m.id=x.message_id
    left join bound_sessions s on s.id=json_extract(x.value,'$.sessionId')
    join coordination_assignments a on a.id=m.sender_id join coordination_assignments b on b.id=m.recipient_id
    left join conversation_index i on i.project_slug=s.project_slug and i.provider=s.provider and i.ref=s.conversation_ref
    where json_extract(x.value,'$.timestamp')>=?
    order by json_extract(x.value,'$.timestamp'),m.id`).all(iso(from - 60 * MINUTE)) as AttemptRow[];
  const groups = new Map<string, AuditedWake>();
  const paths = new Map<string, string>();
  for (const r of rows) {
    const a = JSON.parse(r.value) as PeerWakeAttempt;
    if (!['submitting', 'submitted', 'failed'].includes(a.status) || !Number.isFinite(Date.parse(a.timestamp))) throw new Error('Invalid stored peer wake attempt.');
    if (Date.parse(a.timestamp) > now) continue;
    const key = `${a.sessionId}:${a.timestamp}:${a.status}`;
    let w = groups.get(key);
    if (!w) {
      w = { sessionId: a.sessionId, timestamp: a.timestamp, provider: r.provider, project: r.project_slug ?? '(unknown project)',
        nativeSessionId: r.conversation_ref, status: a.status, restoration: a.restoration ?? 'unknown',
        category: 'normal', messages: [], reason: a.reason ?? null, nativeTurn: null, durationMs: null,
        usageReason: options.includeUsage ? 'No unambiguous native control-prompt turn was found.' : 'Usage is collected by the daily audit.' };
      groups.set(key, w);
      if (r.transcript_path) paths.set(a.sessionId, r.transcript_path);
    }
    w.messages.push({ id: r.id, senderId: r.sender_id, recipientId: r.recipient_id, createdAt: r.created_at,
      acknowledgedAt: r.acknowledged_at, fixture: fixture(r.sender_description, r.recipient_description), attempt: r.attempt });
  }
  const allWakes = [...groups.values()];
  for (const w of allWakes) w.category = w.messages.some((m) => m.fixture) ? 'fixture'
    : w.messages.every((m) => Date.parse(w.timestamp) - Date.parse(m.createdAt) >= WAKE_AUDIT_POLICY.backlogAgeMinutes * MINUTE) ? 'backlog' : 'normal';
  const wakes = allWakes.filter((w) => Date.parse(w.timestamp) >= from);
  if (options.includeUsage) {
    for (const [sessionId, file] of paths) {
      const submitted = wakes.filter((w) => w.sessionId === sessionId && w.status === 'submitted');
      if (!submitted.length) continue;
      let native: NativeWakeTurn[];
      try { native = await readNativeWakeTurns(submitted[0]?.provider ?? wakes.find((w) => w.sessionId === sessionId)!.provider, file, now); }
      catch { for (const w of submitted) w.usageReason = 'The native transcript could not be read.'; continue; }
      for (let i = 0; i < submitted.length; i++) {
        const w = submitted[i]!;
        const after = Date.parse(w.timestamp), before = Math.min(after + 60 * MINUTE, Date.parse(submitted[i + 1]?.timestamp ?? iso(now + 1)));
        const matches = native.filter((t) => Date.parse(t.promptAt) >= after && Date.parse(t.promptAt) < before);
        if (matches.length === 1) {
          w.nativeTurn = matches[0]!;
          w.durationMs = w.nativeTurn.completedAt ? Date.parse(w.nativeTurn.completedAt) - Date.parse(w.nativeTurn.promptAt) : null;
          w.usageReason = w.nativeTurn.usage ? null : 'Native turn usage is unavailable.';
        }
      }
    }
  }
  const messages = wakes.flatMap((w) => w.messages);
  const uniqueMessages = [...new Map(messages.map((m) => [m.id, m])).values()];
  const delays = uniqueMessages.filter((m) => m.acknowledgedAt).map((m) => Date.parse(m.acknowledgedAt!) - Date.parse(m.createdAt)).filter((v) => v >= 0);
  const pending = db.prepare(`select m.id,m.created_at,m.recipient_id,a.provider,a.description as recipient_description,
    b.description as sender_description from coordination_messages m join coordination_assignments a on a.id=m.recipient_id
    join coordination_assignments b on b.id=m.sender_id where m.acknowledged_at is null and a.status!='finished'
    and exists(select 1 from bound_sessions s where s.provider=a.provider and s.should_restore=1
    and (s.conversation_ref=a.native_session_id or s.resume_conversation_ref=a.native_session_id))`).all() as Array<{
      id: string; created_at: string; recipient_id: string; provider: string; sender_description: string; recipient_description: string;
    }>;
  const submitted = wakes.filter((w) => w.status === 'submitted');
  const pairGroups = new Map<string, AuditedWake[]>();
  for (const w of submitted) for (const pair of new Set(w.messages.map((m) => [m.senderId, m.recipientId].sort().join(':'))))
    pairGroups.set(pair, [...pairGroups.get(pair) ?? [], w]);
  const rollup = (key: (w: AuditedWake) => string) => [...new Set(submitted.map(key))].map((id) => {
    const entries = submitted.filter((w) => key(w) === id);
    return { key: id, providers: [...new Set(entries.map((w) => w.provider))], projects: [...new Set(entries.map((w) => w.project))],
      wakes: entries.length, normalWakes: entries.filter((w) => w.category === 'normal').length,
      fixtureWakes: entries.filter((w) => w.category === 'fixture').length, backlogWakes: entries.filter((w) => w.category === 'backlog').length };
  }).sort((a, b) => b.wakes - a.wakes || a.key.localeCompare(b.key));
  const usage = (['normal', 'fixture', 'backlog'] as const).map((category) => {
    const entries = submitted.filter((w) => w.category === category);
    const measured = entries.flatMap((w) => w.nativeTurn?.usage ? [w.nativeTurn.usage] : []);
    const totals = measured.length ? Object.fromEntries(Object.keys(measured[0]!).map((key) =>
      [key, measured.reduce((n, t) => n + t[key as keyof WakeTokens], 0)])) : null;
    return { category, scope: 'parent_response_turns_only', delegatedUsage: 'unknown',
      wakes: entries.length, measuredWakes: measured.length, unknownWakes: entries.length - measured.length,
      measuredTokens: totals, estimatedCostUsd: null, costReason: 'No pricing assumptions configured; subscription billing is not per-turn usage.' };
  });
  const telemetry = options.runtimeDir ? await readCoordinationTelemetry(options.runtimeDir, from, now) : null;
  const transportMetrics = telemetry?.summary ?? summarizeCoordinationTelemetry([]);
  const transportWarnings = (start: number): WakeWarning[] => {
    const metrics = start === from ? transportMetrics : telemetry?.recentSummary ?? summarizeCoordinationTelemetry([]);
    const warnings: WakeWarning[] = [];
    if (metrics.clientTimeouts || metrics.hookFailures || metrics.abandonedRequests || (metrics.eventLoop.maxMs ?? 0) >= 1000) warnings.push({
      key: 'transport:delivery', kind: 'transport', title: 'Agent message transport stalled', observedAt: iso(now),
      summary: `${metrics.clientTimeouts} client timeouts, ${metrics.hookFailures} hook failures and ${metrics.abandonedRequests} abandoned requests; maximum event-loop delay ${Math.round(metrics.eventLoop.maxMs ?? 0)}ms. Messages remain queued; inspect the transport audit.`,
    });
    if (telemetry && (!telemetry.available || telemetry.issues.length)) warnings.push({ key: 'transport:coverage', kind: 'transport',
      title: 'Agent transport measurements are incomplete', observedAt: iso(now),
      summary: telemetry.issues.join(' ') || 'No measurements exist in the requested audit window.' });
    return warnings;
  };
  const deliveryWarnings: WakeWarning[] = [];
  for (const m of pending.filter((m) => !fixture(m.sender_description, m.recipient_description))) {
    // Pending conditions persist until receipt or assignment closeout. Do not
    // age their wake evidence out with the frequency/usage reporting window.
    const attempts = [peerWakeAttemptKey(m.id), peerWakeFollowupKey(m.id)].flatMap((key) => {
      const stored = db.prepare('select value from meta where key=?').get(key) as { value: string } | undefined;
      if (!stored) return [];
      const attempt = JSON.parse(stored.value) as PeerWakeAttempt;
      if (!['submitting', 'submitted', 'failed'].includes(attempt.status) || !Number.isFinite(Date.parse(attempt.timestamp))) throw new Error('Invalid stored peer wake attempt.');
      return [attempt];
    });
    const ended = attempts.some((attempt) => {
      if (attempt.status !== 'submitted' || now - Date.parse(attempt.timestamp) < 2 * MINUTE) return false;
      const session = db.prepare('select last_completed_at from bound_sessions where id=?').get(attempt.sessionId) as { last_completed_at: string | null } | undefined;
      return Boolean(session?.last_completed_at && session.last_completed_at > attempt.timestamp);
    });
    if (ended) deliveryWarnings.push({
      key: `delivery:${m.id}`, kind: 'delivery', title: 'Peer response ended without acknowledging its message', observedAt: iso(now),
      summary: `The ${m.provider} response turn ended but message ${m.id} remains unacknowledged. ${attempts.length > 1 ? `The follow-up is ${attempts[1]!.status}; no further automatic attempts are permitted.` : 'One guarded follow-up is permitted.'} Inspect hook failures and draft/resource guards.`,
    });
  }
  const offers = new Map<string, { firstAttempt: number; firstFinished: number | null; abandoned: number }>();
  for (const r of (telemetry?.offers ?? []).filter((r) => r.messageId && Number.isFinite(r.offeredAt))) {
    const prior = offers.get(r.messageId!) ?? { firstAttempt: r.offeredAt!, firstFinished: null, abandoned: 0 };
    prior.firstAttempt = Math.min(prior.firstAttempt, r.offeredAt!);
    if (r.outcome === 'finished') prior.firstFinished = Math.min(prior.firstFinished ?? Infinity, r.offeredAt!);
    if (r.outcome === 'abandoned') prior.abandoned++;
    offers.set(r.messageId!, prior);
  }
  const deliveryMessages = db.prepare(`select id,created_at as createdAt,acknowledged_at as acknowledgedAt
    from coordination_messages where created_at>=? or supplied_at>=? or acknowledged_at>=?`)
    .all(iso(from), iso(from), iso(from)) as Array<{ id: string; createdAt: string; acknowledgedAt: string | null }>;
  const finishedDelays = deliveryMessages.flatMap((m) => {
    const first = offers.get(m.id)?.firstFinished;
    return first == null ? [] : [first - Date.parse(m.createdAt)];
  }).filter((ms) => ms >= 0);
  const offerAckDelays = deliveryMessages.flatMap((m) => {
    const first = offers.get(m.id)?.firstFinished;
    return first == null || !m.acknowledgedAt ? [] : [Date.parse(m.acknowledgedAt) - first];
  }).filter((ms) => ms >= 0);
  return { schemaVersion: 1, from: iso(from), until: iso(now), policy: WAKE_AUDIT_POLICY,
    counts: { submittedWakes: submitted.length, attemptedMessages: messages.length,
      clientTimeouts: transportMetrics.clientTimeouts,
      hookFailures: transportMetrics.hookFailures,
      abandonedRequests: transportMetrics.abandonedRequests,
      acknowledgedMessages: uniqueMessages.filter((m) => m.acknowledgedAt).length,
      followupWakes: submitted.filter((w) => w.messages.some((m) => m.attempt === 2)).length,
      failedMessages: wakes.filter((w) => w.status === 'failed').reduce((n, w) => n + w.messages.length, 0),
      unconfirmedMessages: wakes.filter((w) => w.status === 'submitting').reduce((n, w) => n + w.messages.length, 0),
      restoredWakes: submitted.filter((w) => w.restoration === 'restored').length,
      alreadyLoadedWakes: submitted.filter((w) => w.restoration === 'already_loaded').length,
      unknownRestorationWakes: submitted.filter((w) => w.restoration === 'unknown').length,
      managedPendingMessages: pending.filter((m) => !fixture(m.sender_description, m.recipient_description)).length },
    acknowledgementDelayMs: { median: percentile(delays, .5), p95: percentile(delays, .95) },
    transport: { available: telemetry?.available ?? false, issues: telemetry?.issues ?? [],
      firstRecordedAt: telemetry?.firstRecordedAt == null ? null : iso(telemetry.firstRecordedAt),
      lastRecordedAt: telemetry?.lastRecordedAt == null ? null : iso(telemetry.lastRecordedAt),
      ...transportMetrics,
      firstFinishedOfferDelayMs: { samples: finishedDelays.length, median: percentile(finishedDelays, .5), p95: percentile(finishedDelays, .95) },
      finishedOfferToAcknowledgementMs: { samples: offerAckDelays.length, median: percentile(offerAckDelays, .5), p95: percentile(offerAckDelays, .95) },
      offers: [...offers].map(([messageId, r]) => ({ messageId, firstAttemptAt: iso(r.firstAttempt),
        firstFinishedAt: r.firstFinished === null ? null : iso(r.firstFinished), abandonedResponses: r.abandoned })) },
    durationMs: { median: percentile(submitted.flatMap((w) => w.durationMs === null ? [] : [w.durationMs]), .5),
      p95: percentile(submitted.flatMap((w) => w.durationMs === null ? [] : [w.durationMs]), .95) },
    agents: rollup((w) => w.messages[0]!.recipientId), projects: rollup((w) => w.project), providers: rollup((w) => w.provider),
    pairs: [...pairGroups].map(([key, entries]) => ({ key, wakes: entries.length,
      normalWakes: entries.filter((w) => w.category === 'normal').length })).sort((a, b) => b.wakes - a.wakes),
    pending: pending.filter((m) => !fixture(m.sender_description, m.recipient_description)).map((m) => ({
      messageId: m.id, recipientId: m.recipient_id, provider: m.provider, ageMinutes: Math.max(0, (now - Date.parse(m.created_at)) / MINUTE) })),
    usage, warnings: [...wakeWarnings(allWakes, now), ...transportWarnings(now - 10 * MINUTE), ...deliveryWarnings],
    observedWarnings: [...observedWarnings(allWakes, from, now), ...transportWarnings(from), ...deliveryWarnings], wakes };
}
