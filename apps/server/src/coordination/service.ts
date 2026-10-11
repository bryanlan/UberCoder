import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { CoordinationAssignment, CoordinationEvent, CoordinationMessage, CoordinationScope, CoordinationSnapshot, CoordinationSendReceipt } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import { checkoutIdentity } from './git.js';
import { peerWakeAttemptKey, type PeerWakeAttempt } from './wake.js';

const assignmentColumns = `id, provider, native_session_id as nativeSessionId, description, status, started_at as startedAt, last_seen_at as lastSeenAt`;
const scopeColumns = `assignment_id as assignmentId, checkout, repository, summary`;
const eventColumns = `seq, assignment_id as assignmentId, checkout, kind, text, timestamp`;
const messageColumns = `id, sender_id as senderId, recipient_id as recipientId, text, created_at as createdAt, supplied_at as suppliedAt, acknowledged_at as acknowledgedAt`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const compact = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

export function processStart(pid: number): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
  } catch { return ''; }
}

export interface CoordinationSettings { enabled: boolean; pilotPaths: string[] }

export const OUTSIDE_PILOT_NOTE = 'This repository is outside the coordination pilot, so it has no activity view. '
  + 'Your assignment and direct messages still work: call status without checkout to find peers, then send to their id.';

export class CoordinationService {
  constructor(private readonly db: AppDatabase, readonly settings: CoordinationSettings,
    private readonly requestWake?: () => void) {}

  private event(id: string, checkout: string | null, kind: string, text: string): void {
    this.db.sqlite.prepare('insert into coordination_events(assignment_id, checkout, kind, text, timestamp) values(?,?,?,?,?)')
      .run(id, checkout, kind, text, new Date().toISOString());
  }

  private assignment(id: string): CoordinationAssignment {
    const row = this.db.sqlite.prepare(`select ${assignmentColumns} from coordination_assignments where id=?`).get(id) as CoordinationAssignment | undefined;
    if (!row) throw new Error('Unknown assignment.');
    return row;
  }

  private pilotCache: { key: string; repositories: Set<string> } | null = null;

  // Pilot repository identities change only with configuration, so resolve them once per
  // pilotPaths value instead of running Git for every configured path on every check. A
  // missing or non-Git pilot path is skipped rather than making later pilot paths ineligible.
  private pilotRepositories(): Set<string> {
    const key = JSON.stringify(this.settings.pilotPaths);
    if (this.pilotCache?.key !== key) {
      const repositories = new Set<string>();
      for (const candidate of this.settings.pilotPaths) {
        try { repositories.add(checkoutIdentity(candidate).repository); } catch { /* not a usable repository */ }
      }
      this.pilotCache = { key, repositories };
    }
    return this.pilotCache.repositories;
  }

  private identity(directory: string) {
    if (!this.settings.enabled) throw new Error('Coordination is disabled.');
    const identity = checkoutIdentity(directory);
    if (!this.pilotRepositories().has(identity.repository)) throw new Error('This repository is outside the coordination pilot.');
    return identity;
  }

  eligible(directory: string): boolean {
    try { this.identity(directory); return true; } catch { return false; }
  }

  register(input: { provider: string; nativeSessionId: string; token: string; pid: number; cwd: string }): { enabled: boolean; assignmentId?: string } {
    // Assignment identity is independent of its launch directory. Announced scope
    // determines the repository activity views; it never grants editing permission.
    if (!this.settings.enabled) return { enabled: false };
    const start = processStart(input.pid);
    if (!start) throw new Error('Registration requires a live local process.');
    const tokenHash = digest(input.token);
    return this.db.sqlite.transaction(() => {
      const existing = this.db.sqlite.prepare('select id, token_hash from coordination_assignments where provider=? and native_session_id=?')
        .get(input.provider, input.nativeSessionId) as { id: string; token_hash: string } | undefined;
      const id = existing?.id ?? randomUUID();
      const now = new Date().toISOString();
      if (existing) {
        const previous = this.db.sqlite.prepare('select pid, process_start from coordination_assignments where id=?').get(id) as { pid: number; process_start: string };
        if (previous.pid !== input.pid && processStart(previous.pid) === previous.process_start) throw new Error('That provider session already has a live coordination owner.');
        if (existing.token_hash !== tokenHash) {
          // An interrupted client write may have lost the credential. Only the
          // original, still-running host process may repair that registration.
          if (previous.pid !== input.pid || previous.process_start !== start) throw new Error('Credential recovery requires the original live provider process.');
          this.db.sqlite.prepare('update coordination_assignments set token_hash=? where id=?').run(tokenHash, id);
          this.event(id, null, 'credential-recovered', 'Repaired the credential for the same live provider process; assignment and messages preserved.');
        }
        this.db.sqlite.prepare("update coordination_assignments set pid=?, process_start=?, status='active', last_seen_at=? where id=?").run(input.pid, start, now, id);
      } else {
        this.db.sqlite.prepare('insert into coordination_assignments values(?,?,?,?,?,?,?,?,?,?)')
          .run(id, input.provider, input.nativeSessionId, tokenHash, 'Assignment not yet described', 'active', input.pid, start, now, now);
      }
      this.event(id, null, existing ? 'resumed' : 'started', existing ? 'Resumed; refresh current scope and unfinished changes.' : 'Session registered; awaiting assignment scope.');
      return { enabled: true, assignmentId: id };
    }).immediate();
  }

  authenticate(id: string, token: string): void {
    const row = this.db.sqlite.prepare('select token_hash from coordination_assignments where id=?').get(id) as { token_hash: string } | undefined;
    if (!row || row.token_hash !== digest(token)) throw new Error('Invalid coordination credential.');
  }

  agentIdentity(id: string): { kind: 'agent'; id: string; provider: string } {
    const assignment = this.assignment(id);
    return { kind: 'agent', id, provider: assignment.provider };
  }

  reconcileProcesses(): void {
    const rows = this.db.sqlite.prepare("select id, pid, process_start from coordination_assignments where status in ('active','waiting')")
      .all() as { id: string; pid: number; process_start: string }[];
    this.db.sqlite.transaction(() => {
      for (const row of rows) {
        if (processStart(row.pid) === row.process_start) continue;
        this.db.sqlite.prepare("update coordination_assignments set status='disconnected' where id=?").run(row.id);
        this.event(row.id, null, 'disconnected', 'Process ended. Activity history remains available; inspect unfinished files before continuing work.');
      }
    })();
  }

  update(id: string, input: { description?: string; checkout?: string; summary?: string; status?: 'active' | 'waiting' }) {
    const identity = input.checkout ? this.identity(input.checkout) : undefined;
    return this.db.sqlite.transaction(() => {
      const current = this.assignment(id);
      if (current.status === 'finished' || current.status === 'disconnected') throw new Error('Resume this assignment before updating it.');
      this.db.sqlite.prepare('update coordination_assignments set description=?, status=?, last_seen_at=? where id=?')
        .run(input.description ?? current.description, input.status ?? current.status, new Date().toISOString(), id);
      if (identity) this.db.sqlite.prepare(`insert into coordination_scopes values(?,?,?,?) on conflict(assignment_id,checkout) do update set summary=excluded.summary`)
        .run(id, identity.checkout, identity.repository, input.summary ?? 'Scope added');
      // Turn-start and turn-end status changes are state, not peer announcements.
      if (identity || input.summary !== undefined || input.description !== undefined) {
        this.event(id, identity?.checkout ?? null, 'update', input.summary ?? input.description ?? 'Scope added');
      }
      return { assignment: this.assignment(id) };
    }).immediate();
  }

  agentStatus(id: string, directory?: string, offset = 0) {
    if (!this.settings.enabled) {
      return { enabled: false, assignment: null, peers: [], unscoped: false, totalPeerScopes: 0, nextOffset: null, pendingMessageCount: 0 };
    }
    this.reconcileProcesses();
    const current = this.assignment(id);
    const pendingMessageCount = (this.db.sqlite.prepare('select count(*) as n from coordination_messages where recipient_id=? and acknowledged_at is null').get(id) as { n: number }).n;
    const assignment = { id: current.id, provider: current.provider, status: current.status, description: compact(current.description, 160) };
    // A checkout outside the pilot has no activity view, but the assignment and direct messages
    // still work. Say so explicitly; an empty "disabled" reply reads as "messaging is unavailable".
    if (directory && !this.eligible(directory)) {
      return { enabled: true, assignment, checkoutInPilot: false, note: OUTSIDE_PILOT_NOTE, peers: [], unscoped: false,
        totalPeerScopes: 0, nextOffset: null, pendingMessageCount };
    }
    const repositories = directory
      ? [checkoutIdentity(directory).repository]
      : (this.db.sqlite.prepare('select distinct repository from coordination_scopes where assignment_id=?').all(id) as Array<{ repository: string }>).map((row) => row.repository);
    // Before the first scope announcement, show live pilot work rather than an empty view.
    const repositoryFilter = repositories.length > 0 ? `and s.repository in (${repositories.map(() => '?').join(',')})` : '';
    const rows = this.db.sqlite.prepare(`select a.id, a.provider, a.status, a.description, a.last_seen_at as lastSeenAt,
      s.checkout, s.summary from coordination_assignments a join coordination_scopes s on s.assignment_id=a.id
      where a.id!=? and a.status in ('active','waiting') ${repositoryFilter}
      order by case a.status when 'active' then 0 else 1 end, a.last_seen_at desc, a.id, s.checkout`)
      .all(id, ...repositories) as Array<{ id: string; provider: string; status: string; description: string; lastSeenAt: string; checkout: string; summary: string }>;
    const peers: Array<{ id: string; provider: string; status: string; description: string; lastSeenAt: string; checkout: string; summary: string }> = [];
    for (const row of rows.slice(offset)) {
      const peer = { ...row, description: compact(row.description, 120), checkout: compact(row.checkout, 220), summary: compact(row.summary, 220) };
      if (JSON.stringify({ assignment, peers: [...peers, peer], totalPeerScopes: rows.length, pendingMessageCount }).length > 3400) break;
      peers.push(peer);
    }
    return { enabled: true, assignment, peers, unscoped: !directory && repositories.length === 0, totalPeerScopes: rows.length,
      nextOffset: offset + peers.length < rows.length ? offset + peers.length : null, pendingMessageCount };
  }

  private sendReceipt(message: Pick<CoordinationMessage, 'id' | 'recipientId' | 'suppliedAt' | 'acknowledgedAt'>): CoordinationSendReceipt {
    const assignment = this.assignment(message.recipientId);
    const owner = this.db.sqlite.prepare('select pid, process_start from coordination_assignments where id=?')
      .get(message.recipientId) as { pid: number; process_start: string };
    const alive = Boolean(owner.process_start) && processStart(owner.pid) === owner.process_start;
    // Native conversation IDs are the providers' authoritative Console refs.
    // A pending Console row can already carry its resumable native ref.
    const sessions = this.db.sqlite.prepare(`select is_working, manual_suspended_at, pressure_suspended_at from bound_sessions
      where provider=? and should_restore=1 and status in ('starting','bound')
      and (conversation_ref=? or resume_conversation_ref=?) limit 2`)
      .all(assignment.provider, assignment.nativeSessionId, assignment.nativeSessionId) as Array<{
        is_working: number; manual_suspended_at: string | null; pressure_suspended_at: string | null;
      }>;
    const session = sessions.length === 1 ? sessions[0] : undefined;
    const stopped = !alive || Boolean(session?.manual_suspended_at || session?.pressure_suspended_at);
    const status = stopped ? 'stopped' : (session ? Boolean(session.is_working) : assignment.status === 'active') ? 'working' : 'idle';
    const recipient: CoordinationSendReceipt['recipient'] = { status, provider: assignment.provider, lastSeenAt: assignment.lastSeenAt,
      resumableInConsole: Boolean(session) };
    if (message.acknowledgedAt) return { id: message.id, queued: false, recipient, delivery: 'acknowledged', note: 'Recipient acknowledged receipt; this does not prove agreement or completed work.' };
    if (message.suppliedAt) return { id: message.id, queued: true, recipient, delivery: 'offered', note: 'Offered to the recipient runtime; not yet acknowledged. Unacknowledged messages may be offered again.' };
    const attemptText = this.db.meta.get(peerWakeAttemptKey(message.id));
    if (attemptText) {
      const attempt = JSON.parse(attemptText) as PeerWakeAttempt;
      return { id: message.id, queued: true, recipient,
        delivery: attempt.status === 'submitted' ? 'wake_started' : 'wake_blocked',
        note: attempt.status === 'submitted' ? 'A coordination response turn was started; receipt still requires acknowledgement.'
          : `Automatic wake was not confirmed and will not be replayed: ${attempt.reason ?? 'submission was interrupted'}. The message remains in the inbox.` };
    }
    if (this.requestWake && session && status !== 'working') {
      return { id: message.id, queued: true, recipient, delivery: session.manual_suspended_at ? 'on_resume' : 'wake_pending',
        note: session.manual_suspended_at ? 'Queued, not received. The recipient is manually suspended; automatic wake respects that pause.'
          : session.pressure_suspended_at ? 'Queued, not received. Console can wake the original conversation when sufficient memory is available.'
            : 'Queued, not received. Console will wake the original conversation for a peer-inbox response when the provider is ready. Drafts are preserved and interactive prompts defer wake.' };
    }
    const delivery = status === 'stopped' ? 'on_resume' : status === 'idle' ? 'next_turn' : 'next_step';
    const note = status === 'stopped'
      ? `Queued, not received. The recipient process is stopped or suspended. ${session ? 'A resumable Console binding exists; reopening it may deliver the message.' : 'No unique resumable Console binding exists.'} No process was started.`
      : status === 'idle' ? 'Queued, not received. The live recipient is idle; delivery waits for its next turn. No turn was started.'
        : 'Queued, not received. Expected at the next supported tool or session hook; a long-running tool can delay delivery.';
    return { id: message.id, queued: true, recipient, delivery, note };
  }

  send(id: string, input: { id: string; recipientId: string; text: string }): CoordinationSendReceipt {
    this.assignment(input.recipientId);
    if (this.assignment(input.recipientId).status === 'finished') throw new Error('Recipient assignment is finished.');
    const existing = this.db.sqlite.prepare(`select sender_id, recipient_id, text, ${messageColumns} from coordination_messages where id=?`)
      .get(input.id) as CoordinationMessage & { sender_id: string; recipient_id: string } | undefined;
    if (existing) {
      if (existing.sender_id !== id || existing.recipient_id !== input.recipientId || existing.text !== input.text) throw new Error('Message ID already used for different content.');
      this.requestWake?.();
      return this.sendReceipt(existing);
    }
    const count = this.db.sqlite.prepare('select count(*) as n from coordination_messages where recipient_id=? and acknowledged_at is null').get(input.recipientId) as { n: number };
    if (count.n >= 100) throw new Error('Recipient inbox is full; wait for acknowledgements.');
    this.db.sqlite.prepare('insert into coordination_messages values(?,?,?,?,?,null,null)').run(input.id, id, input.recipientId, input.text, new Date().toISOString());
    this.requestWake?.();
    return this.sendReceipt({ id: input.id, recipientId: input.recipientId, suppliedAt: null, acknowledgedAt: null });
  }

  acknowledge(id: string, messages: string[]) {
    this.db.sqlite.transaction(() => {
      for (const message of messages) {
        const result = this.db.sqlite.prepare('update coordination_messages set acknowledged_at=coalesce(acknowledged_at,?) where id=? and recipient_id=? and supplied_at is not null')
          .run(new Date().toISOString(), message, id);
        if (!result.changes) throw new Error('Only the recipient can acknowledge a supplied message.');
      }
    })();
    return { acknowledged: messages };
  }

  poll(id: string, after: number, supply = true) {
    return this.db.sqlite.transaction(() => {
      const current = this.assignment(id);
      this.db.sqlite.prepare('update coordination_assignments set last_seen_at=? where id=?').run(new Date().toISOString(), id);
      const maximum = this.db.sqlite.prepare('select coalesce(max(seq),0) as seq from coordination_events').get() as { seq: number };
      // Automatic activity is a current summary, not a replay of every old update.
      // Keep the original log intact for the browser, and include only updates in
      // shared repositories (plus explicit assignment closeouts).
      const candidates = this.db.sqlite.prepare(`with relevant as (
        select e.* from coordination_events e where seq>? and seq<=? and assignment_id!=?
        and kind in ('update','finished')
        and not (kind='update' and checkout is null and text in ('Status: active','Status: waiting'))
        and exists(select 1 from coordination_scopes mine join coordination_scopes theirs on mine.repository=theirs.repository
          where mine.assignment_id=? and theirs.assignment_id=e.assignment_id
          and (e.checkout is null or theirs.checkout=e.checkout))
      ), latest as (
        select assignment_id, max(seq) as seq, count(*) as updates from relevant group by assignment_id
      ) select e.seq, e.assignment_id as assignmentId, e.checkout, e.kind, e.text, e.timestamp, a.status as assignmentStatus,
        count(*) over () as peerCount, sum(latest.updates) over () as updateCount
        from coordination_events e join latest on latest.seq=e.seq
        join coordination_assignments a on a.id=e.assignment_id
        order by e.seq desc limit 3`).all(after, maximum.seq, id, id) as Array<CoordinationEvent & {
          assignmentStatus: string; peerCount: number; updateCount: number;
        }>;
      const messages = this.db.sqlite.prepare(`select ${messageColumns} from coordination_messages where recipient_id=? and acknowledged_at is null
        and (supplied_at is null or supplied_at<?) order by created_at limit 3`).all(id, new Date(Date.now() - 60_000).toISOString()) as CoordinationMessage[];
      const events: CoordinationEvent[] = candidates.map(({ assignmentStatus, peerCount, updateCount, ...event }) => ({
        ...event,
        // Never turn an abbreviated checkout into a path an agent might use.
        checkout: event.checkout && event.checkout.length <= 200 ? event.checkout : null,
        text: compact(`${assignmentStatus === 'disconnected' ? '[Session disconnected] ' : ''}${event.text.replace(/\s+/g, ' ')}`, 240),
      }));
      const latest = candidates[0];
      const activitySummary = latest
        ? `${latest.updateCount} activity updates from ${latest.peerCount} ${latest.peerCount === 1 ? 'assignment' : 'assignments'} summarized; showing ${events.length} latest. Use status for current scopes or history with checkout and offset for full activity.`
        : null;
      if (supply) for (const message of messages) this.db.sqlite.prepare('update coordination_messages set supplied_at=? where id=?').run(new Date().toISOString(), message.id);
      return { assignment: current, activitySummary, events, messages, cursor: Math.max(after, maximum.seq) };
    }).immediate();
  }

  history(id: string, directory: string, offset = 0) {
    this.assignment(id);
    const identity = this.identity(directory);
    const filter = `exists(select 1 from coordination_scopes s where s.repository=? and s.assignment_id=e.assignment_id
      and (e.checkout is null or s.checkout=e.checkout))`;
    const totalEvents = (this.db.sqlite.prepare(`select count(*) as n from coordination_events e where ${filter}`)
      .get(identity.repository) as { n: number }).n;
    const events = this.db.sqlite.prepare(`select ${eventColumns} from coordination_events e where ${filter}
      order by seq desc limit 10 offset ?`).all(identity.repository, offset) as CoordinationEvent[];
    return { repository: identity.repository, events, totalEvents,
      nextOffset: offset + events.length < totalEvents ? offset + events.length : null };
  }

  finish(id: string, summary: string) {
    return this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare("update coordination_assignments set status='finished' where id=?").run(id);
      this.event(id, null, 'finished', summary);
      return { finished: true };
    }).immediate();
  }

  disconnect(id: string) {
    if (this.assignment(id).status !== 'finished') {
      this.db.sqlite.prepare("update coordination_assignments set status='disconnected' where id=?").run(id);
      this.event(id, null, 'disconnected', 'Session ended; activity history retained.');
    }
    return { disconnected: true };
  }

  snapshot(directory?: string): CoordinationSnapshot {
    if (!this.settings.enabled || (directory && !this.eligible(directory))) return { enabled: false, assignments: [], scopes: [], events: [], messages: [], pendingMessageCount: 0 };
    this.reconcileProcesses();
    const repository = directory ? checkoutIdentity(directory).repository : undefined;
    const scopes = this.db.sqlite.prepare(`select ${scopeColumns} from coordination_scopes`).all() as CoordinationScope[];
    const assignments = (this.db.sqlite.prepare(`select ${assignmentColumns} from coordination_assignments order by started_at desc`).all() as CoordinationAssignment[])
      .filter((assignment) => !repository || scopes.some((scope) => scope.assignmentId === assignment.id && scope.repository === repository));
    const ids = new Set(assignments.map((a) => a.id));
    const repositoryFilter = repository ?? null;
    const messageFilter = `(? is null or exists(select 1 from coordination_scopes s
      where s.repository=? and s.assignment_id in (m.sender_id, m.recipient_id)))`;
    const pending = this.db.sqlite.prepare(`select count(*) as count from coordination_messages m
      where acknowledged_at is null and ${messageFilter}`).get(repositoryFilter, repositoryFilter) as { count: number };
    return {
      enabled: this.settings.enabled, assignments,
      scopes: scopes.filter((s) => ids.has(s.assignmentId)),
      events: this.db.sqlite.prepare(`select ${eventColumns} from coordination_events e where
        (? is null or exists(select 1 from coordination_scopes s where s.repository=? and s.assignment_id=e.assignment_id))
        order by seq desc limit 50`).all(repositoryFilter, repositoryFilter) as CoordinationEvent[],
      messages: this.db.sqlite.prepare(`select ${messageColumns} from coordination_messages m where ${messageFilter}
        order by (acknowledged_at is null) desc, created_at desc, rowid desc limit 50`).all(repositoryFilter, repositoryFilter) as CoordinationMessage[],
      pendingMessageCount: pending.count,
    };
  }
}
