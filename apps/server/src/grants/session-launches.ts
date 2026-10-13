import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentGrant, AgentGrantAction, AgentLaunchContext, BoundSession, ConversationSummary, ProviderId } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import type { ProjectService } from '../projects/project-service.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RealtimeEventBus } from '../realtime/event-bus.js';
import { SessionInputRejectedError, type SessionManager } from '../sessions/session-manager.js';
import type { GrantService } from './service.js';
import { AGENT_LAUNCH_PREFIX } from './authority.js';
const SESSION_MEMORY_BYTES = 250 * 1024 * 1024;
interface LaunchInput {
  projectSlug?: string; provider?: ProviderId; model?: string; effort?: string; flags?: string[];
  prompt?: string; title?: string; supervisorId?: string; grantId?: string; sessionId?: string; requestId?: string;
  previousPid?: number;
}
interface RequestRow { id: string; assignment_id: string; grant_id: string; action: AgentGrantAction;
  status: 'queued' | 'starting' | 'completed' | 'failed' | 'cancelled'; session_id: string;
  input_json: string; reason: string | null; created_at: string; updated_at: string }

/** One durable launch queue, using the same project/provider/session pipeline as the UI. */
export class AgentSessionLaunches {
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  constructor(private readonly db: AppDatabase, private readonly grants: GrantService, private readonly sessions: SessionManager,
    private readonly projects: Pick<ProjectService, 'getProjectBySlug' | 'getMergedProviderSettings'>,
    private readonly providers: Pick<ProviderRegistry, 'get'>, events: RealtimeEventBus,
    private readonly memoryFloorBytes = 3072 * 1024 * 1024,
    private readonly readMemory = () => fs.readFileSync('/proc/meminfo', 'utf8')) {
    this.unsubscribe = events.subscribe(event => { if ((event.type === 'grants.updated' && event.change === 'grant') || event.type === 'session.released') this.wake(); });
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), 5000); this.timer.unref(); this.wake();
  }
  private wake(): void { if (!this.stopped) void this.drain(); }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.unsubscribe(); await this.running; }

  private row(id: string): RequestRow | undefined { return this.db.sqlite.prepare('select * from agent_session_requests where id=?').get(id) as RequestRow | undefined; }
  status(assignmentId: string, id?: string) {
    const rows = id ? [this.row(id)].filter((row): row is RequestRow => !!row)
      : this.db.sqlite.prepare('select * from agent_session_requests where assignment_id=? order by created_at desc limit 100').all(assignmentId) as RequestRow[];
    if (rows.some(row => row.assignment_id !== assignmentId)) throw new Error('That request belongs to another assignment.');
    return { requests: rows.map(row => {
      const session = this.db.boundSessions.getById(row.session_id);
      const native = session && this.db.sqlite.prepare('select id from coordination_assignments where provider=? and native_session_id=?')
        .get(session.provider, session.resumeConversationRef ?? session.conversationRef) as { id: string } | undefined;
      return { id: row.id, status: row.status, reason: row.reason, grantId: row.grant_id, action: row.action,
        sessionId: row.session_id, session, agentAssignmentId: native?.id, updatedAt: row.updated_at };
    }) };
  }

  async request(assignmentId: string, action: AgentGrantAction, raw: LaunchInput) {
    const input: LaunchInput = { projectSlug: raw.projectSlug, provider: raw.provider, model: raw.model, effort: raw.effort,
      flags: raw.flags ?? [], prompt: raw.prompt, title: raw.title, supervisorId: raw.supervisorId,
      grantId: raw.grantId, sessionId: raw.sessionId, requestId: raw.requestId };
    const id = input.requestId ?? randomUUID();
    const prior = this.row(id);
    if (prior) {
      if (prior.assignment_id !== assignmentId || prior.action !== action) throw new Error('Request ID is already used by a different action.');
      return this.status(assignmentId, id);
    }
    const actor = this.db.sqlite.prepare('select status from coordination_assignments where id=?').get(assignmentId) as { status: string } | undefined;
    if (!actor || actor.status === 'finished') throw new Error('A finished assignment cannot launch work.');
    if (input.supervisorId) {
      const supervisor = this.db.sqlite.prepare('select status from coordination_assignments where id=?').get(input.supervisorId) as { status: string } | undefined;
      if (!supervisor || supervisor.status === 'finished') throw new Error('Choose an unfinished supervising assignment.');
    }
    let target: BoundSession | undefined;
    if (action === 'restart_session') {
      if (!input.sessionId) throw new Error('sessionId is required.');
      target = this.db.boundSessions.getById(input.sessionId);
      if (!target?.shouldRestore || target.status === 'ended') throw new Error('This session is released or finished.');
      input.projectSlug = target.projectSlug; input.provider = target.provider;
      input.previousPid = target.pid ?? undefined;
    }
    if (!input.projectSlug || !input.provider || (action === 'launch_session' && !input.prompt)) throw new Error('projectSlug, provider and an opening prompt are required for launch.');
    const project = await this.projects.getProjectBySlug(input.projectSlug);
    if (!project) throw new Error('Choose a configured active project.');
    const settings = this.projects.getMergedProviderSettings(project, input.provider);
    if (!settings.enabled) throw new Error('This provider is disabled for the project.');
    const profile = target?.provider === 'codex' ? { codexProfile: target.codexProfile } : { claudeProfile: target?.claudeProfile };
    const command = this.providers.get(input.provider).getLaunchCommand(project, target?.resumeConversationRef ?? null, settings,
      target ? { ...profile, model: !target.codexProfile && !target.claudeProfile ? target.launchContext?.model : undefined,
        effort: !target.codexProfile && !target.claudeProfile ? target.launchContext?.effort : undefined, flags: target.launchContext?.flags }
        : { model: input.model, effort: input.effort, flags: input.flags });
    let model: string | undefined;
    for (let i = 1; i < command.argv.length; i++) {
      const value = command.argv[i]!;
      if (value === '--model' || value === '-m') model = command.argv[++i];
      else if (value.startsWith('--model=')) model = value.slice(8);
    }
    const grant = this.grants.grantsFor(assignmentId).find(candidate => (!input.grantId || input.grantId === candidate.id)
      && candidate.actions.includes(action) && (!candidate.projectSlugs.length || candidate.projectSlugs.includes(project.slug))
      && (!candidate.limits.models.length || (model && candidate.limits.models.includes(model))));
    if (!grant) return { requiresGrant: true, action, projectSlug: project.slug, model,
      reason: 'No active grant covers this action, project and model. Request one broad grant with the required actions and scope.' };
    const now = new Date().toISOString(), sessionId = target?.id ?? randomUUID();
    this.db.sqlite.prepare('insert into agent_session_requests values(?,?,?,?,?,?,?,?,?,?)').run(id, assignmentId, grant.id, action,
      'queued', sessionId, JSON.stringify(input), null, now, now);
    this.grants.logUse({ id, grantId: grant.id, assignmentId, action, sessionId,
      detail: { status: 'queued', description: `${action === 'launch_session' ? 'Launch' : 'Restart'} requested: ${input.title ?? project.displayName}`, requestId: id } });
    this.wake(); return this.status(assignmentId, id);
  }

  async drain(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        const rows = this.db.sqlite.prepare("select * from agent_session_requests where status in ('queued','starting') order by created_at,id").all() as RequestRow[];
        for (const row of rows) {
          if (this.stopped) return;
          try { await this.process(row); }
          catch (error) { this.update(row, 'failed', error instanceof Error ? error.message : 'Session request failed.'); }
        }
      } while (this.again && !this.stopped);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  private update(row: RequestRow, status: RequestRow['status'], reason?: string): void {
    this.db.sqlite.prepare('update agent_session_requests set status=?,reason=?,updated_at=? where id=?').run(status, reason ?? null, new Date().toISOString(), row.id);
    if (status !== 'queued') this.grants.logUse({ id: row.id, grantId: row.grant_id, assignmentId: row.assignment_id,
      action: row.action, sessionId: row.session_id, detail: { status, description: status === 'completed' ? 'Console session ready' : status === 'starting' ? 'Starting Console session' : reason ?? status, requestId: row.id } });
  }
  private async process(row: RequestRow): Promise<void> {
    const input = JSON.parse(row.input_json) as LaunchInput;
    if (row.status === 'starting') {
      const prior = this.db.boundSessions.getById(row.session_id);
      if (prior?.shouldRestore && prior.status === 'bound'
        && (row.action === 'launch_session' || (prior.pid && prior.pid !== input.previousPid))) {
        this.update(row, 'completed'); return;
      }
      if (prior?.status === 'starting') {
        this.update(row, 'starting', 'Waiting for Console session reconciliation.'); return;
      }
      if (prior && (!prior.shouldRestore || prior.status === 'error' || prior.status === 'ended')) {
        this.update(row, 'failed', 'The provider did not start.'); return;
      }
      // No launch row means shutdown preceded bind. An unchanged restart PID
      // means shutdown preceded replacement. Continue the original reservation.
      this.update(row, 'queued');
    }
    const actor = this.db.sqlite.prepare('select status from coordination_assignments where id=?').get(row.assignment_id) as { status: string } | undefined;
    if (!actor || actor.status === 'finished') { this.update(row, 'cancelled', 'The requesting assignment has finished.'); return; }
    const grant = this.grants.grantsFor(row.assignment_id).find(candidate => candidate.id === row.grant_id);
    if (!grant) { this.update(row, 'cancelled', 'The grant was revoked, expired or no longer belongs to this agent.'); return; }
    const project = await this.projects.getProjectBySlug(input.projectSlug!);
    if (!project) { this.update(row, 'failed', 'The configured project is no longer active.'); return; }
    const settings = this.projects.getMergedProviderSettings(project, input.provider!);
    if (!settings.enabled) { this.update(row, 'cancelled', 'The provider is disabled.'); return; }
    if (!grant.actions.includes(row.action) || (grant.projectSlugs.length && !grant.projectSlugs.includes(project.slug))) {
      this.update(row, 'cancelled', 'The grant no longer covers this action or project.'); return;
    }
    if (grant.limits.models.length) {
      const target = row.action === 'restart_session' ? this.db.boundSessions.getById(row.session_id) : undefined;
      const command = this.providers.get(input.provider!).getLaunchCommand(project, target?.resumeConversationRef ?? null, settings,
        target ? { codexProfile: target.codexProfile, claudeProfile: target.claudeProfile,
          model: !target.codexProfile && !target.claudeProfile ? target.launchContext?.model : undefined,
          effort: !target.codexProfile && !target.claudeProfile ? target.launchContext?.effort : undefined, flags: target.launchContext?.flags }
          : { model: input.model, effort: input.effort, flags: input.flags });
      let model: string | undefined;
      for (let i = 1; i < command.argv.length; i++) {
        const value = command.argv[i]!;
        if (value === '--model' || value === '-m') model = command.argv[++i];
        else if (value.startsWith('--model=')) model = value.slice(8);
      }
      if (!model || !grant.limits.models.includes(model)) { this.update(row, 'cancelled', 'The current model is outside the grant.'); return; }
    }
    let available: number | undefined;
    try { const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(this.readMemory()); if (match) available = Number(match[1]) * 1024; } catch {}
    const concurrent = this.db.boundSessions.list().filter(session => session.shouldRestore && session.pid
      && session.launchContext?.grantIds.includes(grant.id)).length;
    if (available === undefined || available < this.memoryFloorBytes + SESSION_MEMORY_BYTES
      || (row.action === 'launch_session' && grant.limits.maxConcurrentSessions !== null && concurrent >= grant.limits.maxConcurrentSessions)) {
      const reason = available === undefined ? 'Waiting for a memory reading.' : available < this.memoryFloorBytes + SESSION_MEMORY_BYTES ? 'Waiting for available memory.' : 'Waiting for a granted session slot.';
      this.update(row, 'queued', reason); return;
    }
    this.update(row, 'starting');
    try {
      if (!this.grants.grantsFor(row.assignment_id).some(candidate => candidate.id === grant.id)) {
        this.update(row, 'cancelled', 'The grant was revoked or expired before launch.'); return;
      }
      if (row.action === 'restart_session') await this.sessions.restartGrantedSession(row.session_id);
      else {
        const actor = this.db.sqlite.prepare('select description from coordination_assignments where id=?').get(row.assignment_id) as { description: string };
        const inherited = this.grants.grantsFor(row.assignment_id);
        const context: AgentLaunchContext = { launchedBy: row.assignment_id, launcherName: actor.description,
          grantIds: inherited.map(candidate => candidate.id), requestId: row.id,
          model: input.model, effort: input.effort, flags: input.flags ?? [], supervisorId: input.supervisorId ?? row.assignment_id };
        const prompt = `${AGENT_LAUNCH_PREFIX} Started by ${actor.description} (${row.assignment_id}) under Bryan's grant ${grant.id}.\nAuthorized work scope: ${JSON.stringify(grant.scope)}\nThe Console supplies this authority. You inherit the launcher's active grants; read agent_grants list and honor their scopes and limits. This session may continue unattended under those grants. Your assignment is the opening task below.\nOpening task from the launcher:\n${input.prompt}`;
        const pendingRef = `pending:${row.id}`, now = new Date().toISOString();
        const pending: ConversationSummary = { ref: pendingRef, kind: 'pending', projectSlug: project.slug, provider: input.provider!, title: input.title ?? `${input.provider} helper`,
          createdAt: now, updatedAt: now, isBound: true, boundSessionId: row.session_id, degraded: false, rawMetadata: { pending: true } };
        this.db.pendingConversations.put(pending);
        await this.sessions.bindConversation({ project, provider: this.providers.get(input.provider!), providerSettings: this.projects.getMergedProviderSettings(project, input.provider!),
          conversationRef: pendingRef, kind: 'pending', title: pending.title, initialPrompt: prompt, initialPromptIsHuman: false,
          launchContext: context, sessionId: row.session_id });
      }
      this.update(row, 'completed');
    } catch (error) {
      if (error instanceof SessionInputRejectedError) this.update(row, 'queued', error.message);
      else this.update(row, 'failed', error instanceof Error ? error.message : 'Provider launch failed.');
    }
  }
}
