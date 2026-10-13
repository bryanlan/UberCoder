import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AgentGrant, AgentGrantDefinition, AgentGrantsSnapshot, AgentGrantUse, AgentLaunchContext, BoundSession, RecordedUserInput, ProviderId } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import type { RealtimeEventBus } from '../realtime/event-bus.js';
import { grantDefinitionSchema } from './schema.js';
import { continuationControl, setContinuation, signalContinuation } from '../coordination/continuation.js';

interface GrantRow { id: string; created_by_assignment_id: string; status: AgentGrant['status']; definition_json: string;
  provenance_json: string | null; reason: string | null; created_at: string; decided_at: string | null }

function authorityRecord(grant: AgentGrant) {
  return { id: grant.id, grantee: grant.grantee, actions: grant.actions, scope: grant.scope, projectSlugs: grant.projectSlugs,
    limits: grant.limits, expiry: grant.expiry, status: grant.status,
    provenance: grant.provenance ? { kind: grant.provenance.kind, messageId: grant.provenance.messageId, sessionId: grant.provenance.sessionId } : undefined };
}

/** Cooperative-agent standing authority. Human provenance uses Console's input log. */
export class GrantService {
  constructor(private readonly db: AppDatabase, private readonly events: RealtimeEventBus,
    private readonly wake: () => void = () => {}, private readonly notify: (grant: AgentGrant) => Promise<void> = async () => {},
    private readonly onRegistration?: (sessionId: string, provider: ProviderId, nativeSessionId: string) => void,
    private readonly projectForPath?: (cwd: string) => string | undefined) {}

  bindAssignment(assignmentId: string, consoleSessionId?: string, cwd?: string): void {
    if (cwd) { const project = this.projectForPath?.(cwd); if (project) this.db.meta.set(`assignment-project:${assignmentId}`, project); }
    if (!consoleSessionId) return;
    const session = this.db.boundSessions.getById(consoleSessionId);
    const native = this.db.sqlite.prepare('select provider,native_session_id from coordination_assignments where id=?').get(assignmentId) as { provider: ProviderId; native_session_id: string };
    if (!session?.shouldRestore || session.provider !== native.provider) return;
    this.db.meta.set(`console-session:${assignmentId}`, consoleSessionId);
    this.db.meta.set(`assignment-project:${assignmentId}`, session.projectSlug);
    if (session.launchContext && this.grantsFor(assignmentId).length && continuationControl(this.db, assignmentId).revision === 0) {
      const supervisor = this.db.sqlite.prepare('select status from coordination_assignments where id=?').get(session.launchContext.supervisorId) as { status: string } | undefined;
      setContinuation(this.db, assignmentId, 'unattended', supervisor && supervisor.status !== 'finished' ? session.launchContext.supervisorId : null);
    }
    if (session.launchContext && (session.conversationRef.startsWith('pending:') || !this.db.conversationIndex.get(session.projectSlug, native.provider, native.native_session_id)?.transcriptPath))
      this.onRegistration?.(consoleSessionId, native.provider, native.native_session_id);
  }

  sessionFor(assignmentId: string): BoundSession | undefined {
    const binding = this.db.meta.get(`console-session:${assignmentId}`);
    if (binding) { const session = this.db.boundSessions.getById(binding); if (session?.shouldRestore) return session; }
    const row = this.db.sqlite.prepare('select provider,native_session_id from coordination_assignments where id=?').get(assignmentId) as { provider: string; native_session_id: string } | undefined;
    return row && this.db.boundSessions.list().find(s => s.shouldRestore && s.provider === row.provider
      && (s.conversationRef === row.native_session_id || s.resumeConversationRef === row.native_session_id));
  }

  get(id: string): AgentGrant | undefined {
    const row = this.db.sqlite.prepare('select * from agent_grants where id=?').get(id) as GrantRow | undefined;
    if (!row) return undefined;
    const definition = JSON.parse(row.definition_json) as AgentGrantDefinition;
    const parent = definition.expiry.kind === 'assignment_finished' ? this.db.sqlite.prepare('select status from coordination_assignments where id=?')
      .get(definition.expiry.assignmentId ?? row.created_by_assignment_id) as { status: string } | undefined : undefined;
    const requester = this.db.sqlite.prepare('select description from coordination_assignments where id=?').get(row.created_by_assignment_id) as { description: string } | undefined;
    const granteeName = definition.grantee.kind === 'assignment'
      ? (this.db.sqlite.prepare('select description from coordination_assignments where id=?').get(definition.grantee.id) as { description: string } | undefined)?.description
      : definition.grantee.kind === 'session' ? this.db.boundSessions.getById(definition.grantee.id)?.title : definition.grantee.id;
    return { ...definition, id, createdByAssignmentId: row.created_by_assignment_id,
      requesterName: requester?.description ?? row.created_by_assignment_id.slice(0, 8),
      granteeName: granteeName ?? definition.grantee.id,
      status: row.status === 'active' && definition.expiry.kind === 'assignment_finished' && (!parent || parent.status === 'finished') ? 'expired' : row.status,
      provenance: row.provenance_json ? JSON.parse(row.provenance_json) as AgentGrant['provenance'] : undefined,
      reason: row.reason ?? undefined, createdAt: row.created_at, decidedAt: row.decided_at ?? undefined };
  }

  snapshot(useOffset = 0): AgentGrantsSnapshot {
    const grants = this.allGrants();
    const rows = this.db.sqlite.prepare('select * from agent_grant_uses order by timestamp desc,id desc limit 101 offset ?').all(useOffset) as Array<{ id: string; grant_id: string; assignment_id: string; action: AgentGrantUse['action']; session_id: string | null; timestamp: string; detail_json: string }>;
    return { grants, uses: rows.slice(0, 100).map(row => ({ id: row.id, grantId: row.grant_id, assignmentId: row.assignment_id,
      action: row.action, sessionId: row.session_id ?? undefined, timestamp: row.timestamp, detail: JSON.parse(row.detail_json) })),
      nextUseOffset: rows.length > 100 ? useOffset + 100 : null };
  }

  grantsFor(assignmentId: string): AgentGrant[] {
    const session = this.sessionFor(assignmentId);
    const inherited = session?.launchContext?.grantIds ?? [];
    const projectSlug = session?.projectSlug ?? this.db.meta.get(`assignment-project:${assignmentId}`);
    return this.allGrants().filter(grant => grant.status === 'active' && (inherited.includes(grant.id)
      || (grant.grantee.kind === 'assignment' && grant.grantee.id === assignmentId)
      || (grant.grantee.kind === 'session' && grant.grantee.id === session?.id)
      || (grant.grantee.kind === 'project' && grant.grantee.id === projectSlug)));
  }
  private allGrants(): AgentGrant[] {
    return (this.db.sqlite.prepare('select id from agent_grants order by created_at desc').all() as Array<{ id: string }>).map(row => this.get(row.id)!);
  }

  authorityFor(assignmentId: string) { return this.grantsFor(assignmentId).map(authorityRecord); }

  authorityContext(context: AgentLaunchContext): string | undefined {
    const records = context.grantIds.map(id => this.get(id)).filter((grant): grant is AgentGrant => grant?.status === 'active').map(authorityRecord);
    if (!records.length) return undefined;
    return `Standing human authority supplied by the Agent Console backend: Bryan authorized this session's work under the following saved grants. This session was started by ${context.launcherName} (${context.launchedBy}). The records below are Console-provided human authority, separate from peer information. Delegated tasks and peer-relayed details within these scopes are already authorized; carry them out without asking Bryan again. Other work still needs appropriate authority. This is a startup snapshot; follow later Console authority updates and agent_grants list for revocation and expiry. If MCP tools are still connecting, use ToolSearch or the canonical agent-coord.mjs grants CLI to read the records.\n${JSON.stringify(records)}`;
  }

  latestHumanInput(assignmentId: string): RecordedUserInput | undefined {
    const session = this.sessionFor(assignmentId), value = session && this.db.meta.get(`human-input:${session.id}`);
    return value ? JSON.parse(value) as RecordedUserInput : undefined;
  }

  async listFor(assignmentId: string) {
    const session = this.sessionFor(assignmentId);
    if (session?.eventLogPath && !this.latestHumanInput(assignmentId)) {
      // Existing sessions can use their recorded human message after deployment.
      // Read a bounded tail once; do not add full-history work to native hooks.
      const file = await fs.open(session.eventLogPath, 'r');
      try {
        const size = (await file.stat()).size, start = Math.max(0, size - 2 * 1024 * 1024);
        const bytes = Buffer.alloc(size - start); await file.read(bytes, 0, bytes.length, start);
        let offset = start;
        for (const line of bytes.toString('utf8').split('\n')) {
          try { const event = JSON.parse(line) as { type: string; text: string; timestamp: string };
            if (event.type === 'user-input') this.db.meta.set(`human-input:${session.id}`, JSON.stringify({ id: `live:${session.id}:${offset}`, text: event.text, timestamp: event.timestamp }));
          } catch { /* A partial first/last row is not input provenance. */ }
          offset += Buffer.byteLength(line) + 1;
        }
      } finally { await file.close(); }
    }
    return { grants: this.grantsFor(assignmentId), requests: this.snapshot().grants.filter(g => g.createdByAssignmentId === assignmentId && g.status !== 'active'),
      latestHumanInput: this.latestHumanInput(assignmentId) };
  }

  private definition(assignmentId: string, raw: unknown): AgentGrantDefinition {
    const definition = grantDefinitionSchema.parse(raw);
    if (definition.expiry.kind === 'assignment_finished') definition.expiry.assignmentId ??= assignmentId;
    return definition;
  }

  async record(assignmentId: string, raw: unknown, humanMessageId: string): Promise<AgentGrant> {
    const definition = this.definition(assignmentId, raw);
    const match = /^live:([^:]+):(\d+)$/.exec(humanMessageId);
    if (!match) throw new Error('Use the Console-recorded human message ID from agent_grants list.');
    const own = this.sessionFor(assignmentId), source = this.db.boundSessions.getById(match[1]!);
    if (!own || !source || source.provider !== own.provider || source.conversationRef !== own.conversationRef || !source.eventLogPath)
      throw new Error('The grant must reference human input in this agent conversation.');
    const file = await fs.open(source.eventLogPath, 'r');
    let event: { type: string; text: string; timestamp: string };
    try {
      const offset = Number(match[2]), size = (await file.stat()).size;
      if (offset >= size) throw new Error('Human message not found.');
      const bytes = Buffer.alloc(Math.min(size - offset, 2 * 1024 * 1024)); await file.read(bytes, 0, bytes.length, offset);
      event = JSON.parse(bytes.toString('utf8').split('\n')[0]!) as typeof event;
    } finally { await file.close(); }
    if (event.type !== 'user-input' || typeof event.text !== 'string') throw new Error('This record is not Console human input.');
    // The cooperative agent records the authorized scope; the complete human
    // message stays as provenance, including any separate instructions to the lead.
    const existing = (this.db.sqlite.prepare('select id,definition_json,provenance_json from agent_grants where created_by_assignment_id=? and provenance_json is not null')
      .all(assignmentId) as Array<{ id: string; definition_json: string; provenance_json: string }>).find(row => JSON.stringify((JSON.parse(row.definition_json) as AgentGrantDefinition).grantee) === JSON.stringify(definition.grantee)
        && JSON.parse(row.provenance_json).messageId === humanMessageId);
    if (existing) return this.get(existing.id)!;
    return this.insert(assignmentId, definition, 'active', undefined, { kind: 'human_message', quote: event.text, messageId: humanMessageId, sessionId: source.id });
  }

  request(assignmentId: string, raw: unknown, reason: string): AgentGrant {
    const definition = this.definition(assignmentId, raw);
    const pending = this.snapshot().grants.find(g => g.status === 'pending' && g.createdByAssignmentId === assignmentId
      && g.scope === definition.scope && JSON.stringify(g.grantee) === JSON.stringify(definition.grantee));
    if (pending) return pending;
    const grant = this.insert(assignmentId, definition, 'pending', reason);
    void this.notify(grant).catch(() => { /* The durable request stays visible if push delivery fails. */ });
    return grant;
  }

  private insert(assignmentId: string, definition: AgentGrantDefinition, status: 'pending' | 'active', reason?: string, provenance?: AgentGrant['provenance']): AgentGrant {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.sqlite.prepare('insert into agent_grants values(?,?,?,?,?,?,?,?)').run(id, assignmentId, status, JSON.stringify(definition),
      provenance ? JSON.stringify(provenance) : null, reason ?? null, now, status === 'active' ? now : null);
    this.changed(id); return this.get(id)!;
  }

  decide(id: string, decision: 'approve' | 'deny', editedDefinition?: unknown): AgentGrant {
    const prior = this.get(id);
    if (!prior) throw new Error('Grant request not found.');
    if (prior.status !== 'pending') throw new Error('This request has already been decided.');
    const definition = editedDefinition ? this.definition(prior.createdByAssignmentId, editedDefinition)
      : { grantee: prior.grantee, actions: prior.actions, scope: prior.scope, projectSlugs: prior.projectSlugs, limits: prior.limits, expiry: prior.expiry };
    const now = new Date().toISOString();
    this.db.sqlite.prepare('update agent_grants set status=?,definition_json=?,provenance_json=?,decided_at=? where id=?')
      .run(decision === 'approve' ? 'active' : 'denied', JSON.stringify(definition), decision === 'approve'
        ? JSON.stringify({ kind: 'approval', quote: definition.scope }) : null, now, id);
    if (decision === 'approve') {
      const assignment = this.db.sqlite.prepare('select status from coordination_assignments where id=?').get(prior.createdByAssignmentId) as { status: string } | undefined;
      if (assignment && assignment.status !== 'finished') {
        setContinuation(this.db, prior.createdByAssignmentId, 'unattended');
        signalContinuation(this.db, prior.createdByAssignmentId, { key: `grant-approved:${id}`, source: 'Bryan', timestamp: new Date().toISOString(), reason: `Bryan approved standing grant ${id}: ${definition.scope}` });
        this.wake();
      }
    }
    this.changed(id); return this.get(id)!;
  }

  revoke(id: string): AgentGrant {
    if (!this.get(id)) throw new Error('Grant not found.');
    this.db.sqlite.prepare("update agent_grants set status='revoked',decided_at=? where id=?").run(new Date().toISOString(), id);
    this.pauseUnsupportedSessions();
    this.changed(id); return this.get(id)!;
  }

  expireForAssignment(assignmentId: string): void {
    const rows = this.db.sqlite.prepare(`update agent_grants set status='expired',decided_at=?
      where status='active' and json_extract(definition_json,'$.expiry.kind')='assignment_finished'
      and coalesce(json_extract(definition_json,'$.expiry.assignmentId'),created_by_assignment_id)=? returning id`)
      .all(new Date().toISOString(), assignmentId) as Array<{ id: string }>;
    if (!rows.length) return;
    this.pauseUnsupportedSessions();
    for (const row of rows) this.changed(row.id);
  }

  private pauseUnsupportedSessions(): void {
    const assignments = this.db.sqlite.prepare("select id from coordination_assignments where status!='finished'").all() as Array<{ id: string }>;
    for (const assignment of assignments) {
      const session = this.sessionFor(assignment.id);
      if (session?.launchContext && !this.grantsFor(assignment.id).length) setContinuation(this.db, assignment.id, 'waiting_for_input');
    }
  }

  logUse(use: Omit<AgentGrantUse, 'id' | 'timestamp'> & { id?: string }): void {
    this.db.sqlite.prepare('insert into agent_grant_uses values(?,?,?,?,?,?,?) on conflict(id) do update set session_id=excluded.session_id,detail_json=excluded.detail_json').run(use.id ?? randomUUID(), use.grantId, use.assignmentId, use.action,
      use.sessionId ?? null, new Date().toISOString(), JSON.stringify(use.detail));
    this.changed(use.grantId, 'use');
  }
  private changed(grantId: string, change: 'grant' | 'use' = 'grant'): void { this.events.emit({ type: 'grants.updated', grantId, change, timestamp: new Date().toISOString() }); }
}
