import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { CoordinationAssignment, CoordinationEvent, CoordinationMessage, CoordinationScope, CoordinationSnapshot } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import { checkoutIdentity } from './git.js';

const assignmentColumns = `id, provider, native_session_id as nativeSessionId, description, status, started_at as startedAt, last_seen_at as lastSeenAt`;
const scopeColumns = `assignment_id as assignmentId, checkout, repository, summary`;
const eventColumns = `seq, assignment_id as assignmentId, checkout, kind, text, timestamp`;
const messageColumns = `id, sender_id as senderId, recipient_id as recipientId, text, created_at as createdAt, supplied_at as suppliedAt, acknowledged_at as acknowledgedAt`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function processStart(pid: number): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
  } catch { return ''; }
}

export interface CoordinationSettings { enabled: boolean; pilotPaths: string[] }

export class CoordinationService {
  constructor(private readonly db: AppDatabase, readonly settings: CoordinationSettings) {}

  private event(id: string, checkout: string | null, kind: string, text: string): void {
    this.db.sqlite.prepare('insert into coordination_events(assignment_id, checkout, kind, text, timestamp) values(?,?,?,?,?)')
      .run(id, checkout, kind, text, new Date().toISOString());
  }

  private assignment(id: string): CoordinationAssignment {
    const row = this.db.sqlite.prepare(`select ${assignmentColumns} from coordination_assignments where id=?`).get(id) as CoordinationAssignment | undefined;
    if (!row) throw new Error('Unknown assignment.');
    return row;
  }

  private identity(directory: string) {
    if (!this.settings.enabled) throw new Error('Coordination is disabled.');
    const identity = checkoutIdentity(directory);
    const enabled = this.settings.pilotPaths.some((candidate) => checkoutIdentity(candidate).repository === identity.repository);
    if (!enabled) throw new Error('This repository is outside the coordination pilot.');
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
      this.event(id, identity?.checkout ?? null, 'update', input.summary ?? input.description ?? `Status: ${input.status}`);
      return this.poll(id, 0, false);
    }).immediate();
  }

  send(id: string, input: { id: string; recipientId: string; text: string }) {
    this.assignment(input.recipientId);
    if (this.assignment(input.recipientId).status === 'finished') throw new Error('Recipient assignment is finished.');
    const existing = this.db.sqlite.prepare('select sender_id, recipient_id, text from coordination_messages where id=?').get(input.id) as { sender_id: string; recipient_id: string; text: string } | undefined;
    if (existing) {
      if (existing.sender_id !== id || existing.recipient_id !== input.recipientId || existing.text !== input.text) throw new Error('Message ID already used for different content.');
      return { id: input.id };
    }
    const count = this.db.sqlite.prepare('select count(*) as n from coordination_messages where recipient_id=? and acknowledged_at is null').get(input.recipientId) as { n: number };
    if (count.n >= 100) throw new Error('Recipient inbox is full; wait for acknowledgements.');
    this.db.sqlite.prepare('insert into coordination_messages values(?,?,?,?,?,null,null)').run(input.id, id, input.recipientId, input.text, new Date().toISOString());
    return { id: input.id };
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
      const candidates = this.db.sqlite.prepare(`select ${eventColumns} from coordination_events e where seq>? and assignment_id!=? and (
      exists(select 1 from coordination_scopes mine join coordination_scopes theirs on mine.repository=theirs.repository where mine.assignment_id=? and theirs.assignment_id=e.assignment_id)
      ) order by seq limit 25`).all(after, id, id) as CoordinationEvent[];
      const messages = this.db.sqlite.prepare(`select ${messageColumns} from coordination_messages where recipient_id=? and acknowledged_at is null
        and (supplied_at is null or supplied_at<?) order by created_at limit 3`).all(id, new Date(Date.now() - 60_000).toISOString()) as CoordinationMessage[];
      let remaining = 8000 - JSON.stringify(messages).length;
      const events: CoordinationEvent[] = [];
      for (const candidate of candidates) {
        // Old events can be arbitrarily large (for example a directory's claim
        // list). Bound only their delivery representation; retain the full log.
        let delivered = candidate;
        if (JSON.stringify(delivered).length > 4000) {
          delivered = { ...candidate, text: '[Event abbreviated; use status for full activity.]' };
          while (JSON.stringify(delivered).length > 4000 && delivered.checkout) delivered.checkout = delivered.checkout.slice(0, -256);
          let prefix = '';
          for (const character of candidate.text) {
            const next = { ...delivered, text: `${prefix}${character}… [abbreviated; use status for full activity]` };
            if (JSON.stringify(next).length > 4000) break;
            prefix += character;
            delivered = next;
          }
        }
        const size = JSON.stringify(delivered).length;
        if (size > remaining) break;
        events.push(delivered); remaining -= size;
      }
      if (supply) for (const message of messages) this.db.sqlite.prepare('update coordination_messages set supplied_at=? where id=?').run(new Date().toISOString(), message.id);
      const maximum = this.db.sqlite.prepare('select coalesce(max(seq),0) as seq from coordination_events').get() as { seq: number };
      const incomplete = events.length < candidates.length || candidates.length === 25;
      return { assignment: current, events, messages, cursor: incomplete ? (events.at(-1)?.seq ?? after) : maximum.seq };
    }).immediate();
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
