import Database from 'better-sqlite3';
import { PROVIDERS, type AutoRoute, type BoundSession, type ModelProfileKey, type ModelProfileRequest, type ProviderId } from '@agent-console/shared';
import type { AgentLaunchMark } from '../../lib/agent-controlled.js';
import { boolAsInt, numberOrUndefined, optionalString, type SqliteRow } from '../utils.js';
import { InputQueue } from '../../sessions/input-queue.js';
import { parsePendingRequests, structuredRequestsKey } from '../../sessions/structured/pending-requests.js';

const treeVisibleBoundSessionSql = (alias: string) => `${alias}.should_restore = 1 and ${alias}.status in ('starting', 'bound', 'releasing')`;

function nextUpdatedAt(current: string, candidate: string): string {
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(currentMs) || !Number.isFinite(candidateMs) || candidateMs > currentMs) {
    return candidate;
  }
  return new Date(currentMs + 1).toISOString();
}

/**
 * The table keeps two columns from the tmux transport (schema 19) until a later schema version drops them: `tmux_session_name`
 * (not null) and `transport`. New rows fill them with this placeholder and 'structured'; only the startup conversion of rows an
 * earlier build left on tmux reads them (`listTmuxRows`).
 */
const TMUX_SESSION_NAME_PLACEHOLDER = 'structured:';

export class BoundSessionsRepo {
  constructor(private readonly sqlite: Database.Database) {}

  private mapRow(row: SqliteRow): BoundSession {
    const session = mapBoundSessionRow(row);
    const queuedInputs = new InputQueue(this.sqlite).summaries(session.id);
    const pendingRequests = parsePendingRequests((this.sqlite.prepare('select value from meta where key = ?').get(structuredRequestsKey(session.id)) as { value: string } | undefined)?.value);
    const thinkingEffort = (this.sqlite.prepare('select value from meta where key = ?').get(`session-thinking:${session.id}`) as { value: string } | undefined)?.value;
    return { ...session, ...(queuedInputs.length ? { queuedInputs } : {}), ...(pendingRequests.length ? { pendingRequests } : {}), ...(thinkingEffort ? { thinkingEffort } : {}) };
  }

  upsert(session: BoundSession): void {
    const shouldRestore = session.shouldRestore ?? ['starting', 'bound', 'releasing'].includes(session.status);
    const resumeConversationRef = session.resumeConversationRef
      ?? (!session.conversationRef.startsWith('pending:') ? session.conversationRef : undefined);
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        insert into bound_sessions (
          id, provider, codex_profile, claude_profile, grok_profile, vibe_profile, project_slug, conversation_ref, resume_conversation_ref, tmux_session_name, transport, status, should_restore, title,
          started_at, updated_at, last_activity_at, last_output_at, last_completed_at, last_response_at, auto_tracked_at, is_working, pid, raw_log_path, event_log_path
        ) values (
          @id, @provider, @codex_profile, @claude_profile, @grok_profile, @vibe_profile, @project_slug, @conversation_ref, @resume_conversation_ref, @tmux_session_name, 'structured', @status, @should_restore, @title,
          @started_at, @updated_at, @last_activity_at, @last_output_at, @last_completed_at, @last_response_at, @auto_tracked_at, @is_working, @pid, null, @event_log_path
        )
        on conflict(id) do update set
          conversation_ref = excluded.conversation_ref,
          codex_profile = case
            when excluded.updated_at >= bound_sessions.updated_at then excluded.codex_profile
            else bound_sessions.codex_profile
          end,
          claude_profile = case
            when excluded.updated_at >= bound_sessions.updated_at then excluded.claude_profile
            else bound_sessions.claude_profile
          end,
          grok_profile = case
            when excluded.updated_at >= bound_sessions.updated_at then excluded.grok_profile
            else bound_sessions.grok_profile
          end,
          vibe_profile = case
            when excluded.updated_at >= bound_sessions.updated_at then excluded.vibe_profile
            else bound_sessions.vibe_profile
          end,
          resume_conversation_ref = excluded.resume_conversation_ref,
          status = excluded.status,
          should_restore = excluded.should_restore,
          title = excluded.title,
          updated_at = case
            when excluded.updated_at > bound_sessions.updated_at then excluded.updated_at
            else bound_sessions.updated_at
          end,
          last_activity_at = excluded.last_activity_at,
          last_output_at = excluded.last_output_at,
          last_completed_at = excluded.last_completed_at,
          last_response_at = excluded.last_response_at,
          auto_tracked_at = excluded.auto_tracked_at,
          is_working = excluded.is_working,
          pid = excluded.pid,
          event_log_path = excluded.event_log_path
      `).run({
        id: session.id,
        provider: session.provider,
        codex_profile: session.codexProfile ?? null,
        claude_profile: session.claudeProfile ?? null,
        grok_profile: session.grokProfile ?? null,
        vibe_profile: session.vibeProfile ?? null,
        project_slug: session.projectSlug,
        conversation_ref: session.conversationRef,
        resume_conversation_ref: resumeConversationRef ?? null,
        tmux_session_name: `${TMUX_SESSION_NAME_PLACEHOLDER}${session.id}`,
        status: session.status,
        should_restore: boolAsInt(shouldRestore),
        title: session.title ?? null,
        started_at: session.startedAt,
        updated_at: session.updatedAt,
        last_activity_at: session.lastActivityAt ?? null,
        last_output_at: session.lastOutputAt ?? null,
        last_completed_at: session.lastCompletedAt ?? null,
        last_response_at: session.lastResponseAt ?? null,
        auto_tracked_at: session.autoTrackedAt ?? null,
        is_working: boolAsInt(Boolean(session.isWorking)),
        pid: session.pid ?? null,
        event_log_path: session.eventLogPath ?? null,
      });
      if (shouldRestore && ['starting', 'bound', 'releasing'].includes(session.status)) {
        this.sqlite.prepare(`
          update bound_sessions
          set status = 'ended',
              should_restore = 0,
              is_working = 0,
              model_profile_request_json = null,
              updated_at = ?
          where id <> ?
            and project_slug = ?
            and provider = ?
            and conversation_ref = ?
            and ${treeVisibleBoundSessionSql('bound_sessions')}
            and updated_at <= ?
        `).run(
          session.updatedAt,
          session.id,
          session.projectSlug,
          session.provider,
          session.conversationRef,
          session.updatedAt,
        );
      }
    });
    tx();
  }

  /**
   * Every retained session on the same chat as this one, itself included: same project and provider, sharing a
   * conversation ref or the ref it resumed from. A chat the person resumes from history is a new row on the old chat.
   */
  sessionsOfConversation(id: string): BoundSession[] {
    const own = this.sqlite.prepare('select project_slug, provider, conversation_ref, resume_conversation_ref from bound_sessions where id = ?').get(id) as SqliteRow | undefined;
    if (!own) return [];
    const rows = this.sqlite.prepare(`
      select * from bound_sessions
      where project_slug = ? and provider = ? and (conversation_ref in (?, ?) or resume_conversation_ref in (?, ?))
    `).all(own.project_slug, own.provider, own.conversation_ref, own.resume_conversation_ref ?? null, own.conversation_ref, own.resume_conversation_ref ?? null) as SqliteRow[];
    return rows.map(row => this.mapRow(row));
  }

  /**
   * Records that the person sent a message in a chat. Every agent launch of that chat that had no reply yet is marked,
   * including an ended one, so the chat leaves the agent-controlled group however the person got back into it.
   * Returns the ids of the launch records it marked; a chat the person started themselves marks nothing.
   */
  markHumanReplied(id: string, at: string): string[] {
    const marked: string[] = [];
    for (const session of this.sessionsOfConversation(id)) {
      if (!session.launchContext || session.launchContext.humanRepliedAt) continue;
      this.setLaunchContext(session.id, { ...session.launchContext, humanRepliedAt: at });
      marked.push(session.id);
    }
    return marked;
  }

  // Independently owned state: ordinary screen/status upserts must not overwrite it.
  setLaunchContext(id: string, context: BoundSession['launchContext']): void {
    this.sqlite.prepare('update bound_sessions set launch_context_json=? where id=?').run(context ? JSON.stringify(context) : null, id);
  }

  // Independently owned state: ordinary screen/status upserts must not overwrite it.
  setAutoRoute(id: string, route: AutoRoute | undefined, updatedAt: string): BoundSession | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    this.sqlite.prepare('update bound_sessions set auto_route_json = ?, updated_at = ? where id = ?')
      .run(route ? JSON.stringify(route) : null, nextUpdatedAt(current.updatedAt, updatedAt), id);
    return this.getById(id);
  }

  // Independently owned state: ordinary screen/status upserts must not overwrite it.
  setRunFailure(id: string, failure: BoundSession['runFailure']): void {
    const current = this.getById(id);
    if (!current) return;
    this.sqlite.prepare('update bound_sessions set run_failure_json = ?, updated_at = ? where id = ?')
      .run(failure ? JSON.stringify(failure) : null, nextUpdatedAt(current.updatedAt, new Date().toISOString()), id);
  }

  // Suspension is independently owned: status and screen refreshes must not clear it.
  setManualSuspendedAt(id: string, suspendedAt: string | undefined): BoundSession | undefined {
    return this.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return undefined;
      this.sqlite.prepare(`
        update bound_sessions
        set manual_suspended_at = ?,
            pid = case when ? is null then pid else null end,
            is_working = case when ? is null then is_working else 0 end,
            updated_at = ?
        where id = ?
      `).run(suspendedAt ?? null, suspendedAt ?? null, suspendedAt ?? null, nextUpdatedAt(current.updatedAt, new Date().toISOString()), id);
      return this.getById(id);
    })();
  }

  // Idle sleep is durable and does not change activity or response recency.
  setIdleSuspendedAt(id: string, suspendedAt: string | undefined): BoundSession | undefined {
    return this.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return undefined;
      this.sqlite.prepare(`
        update bound_sessions
        set idle_suspended_at = ?,
            pid = case when ? is null then pid else null end,
            is_working = case when ? is null then is_working else 0 end,
            updated_at = ?
        where id = ?
      `).run(suspendedAt ?? null, suspendedAt ?? null, suspendedAt ?? null, nextUpdatedAt(current.updatedAt, new Date().toISOString()), id);
      return this.getById(id);
    })();
  }

  // Pressure suspension is independently owned so ordinary status updates cannot restore it.
  setPressureSuspendedAt(id: string, suspendedAt: string | undefined): BoundSession | undefined {
    return this.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return undefined;
      this.sqlite.prepare(`
        update bound_sessions
        set pressure_suspended_at = ?,
            pid = case when ? is null then pid else null end,
            is_working = case when ? is null then is_working else 0 end,
            updated_at = ?
        where id = ?
      `).run(suspendedAt ?? null, suspendedAt ?? null, suspendedAt ?? null, nextUpdatedAt(current.updatedAt, new Date().toISOString()), id);
      return this.getById(id);
    })();
  }

  /** Restorable rows an earlier build left on the tmux transport, with the hidden tmux session each one ran in. */
  listTmuxRows(): Array<{ session: BoundSession; tmuxSessionName: string }> {
    const rows = this.sqlite.prepare(`
      select * from bound_sessions
      where transport = 'tmux' and should_restore = 1 and status <> 'ended'
      order by updated_at desc
    `).all() as SqliteRow[];
    return rows.map(row => ({ session: this.mapRow(row), tmuxSessionName: String(row.tmux_session_name) }));
  }

  /**
   * Moves a tmux row to the structured transport in one step: the row stops naming a tmux session, raw log or process, and
   * starts asleep, so the next input resumes the same native conversation through the provider's transport. Compare-and-set on
   * the transport: undefined when the row is gone or is not a tmux row. An existing sleep marker keeps its time.
   */
  convertTmuxRow(id: string, change: { idleSuspendedAt?: string; updatedAt: string }): BoundSession | undefined {
    return this.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return undefined;
      const changed = this.sqlite.prepare(`
        update bound_sessions
        set transport = 'structured',
            tmux_session_name = ?,
            raw_log_path = null,
            pid = null,
            is_working = 0,
            idle_suspended_at = coalesce(idle_suspended_at, ?),
            updated_at = ?
        where id = ? and transport = 'tmux'
      `).run(`${TMUX_SESSION_NAME_PLACEHOLDER}${id}`, change.idleSuspendedAt ?? null, nextUpdatedAt(current.updatedAt, change.updatedAt), id).changes;
      return changed ? this.getById(id) : undefined;
    })();
  }

  // Independently owned state: ordinary screen/status upserts must not overwrite it.
  replaceModelProfileRequest(id: string, request: ModelProfileRequest | undefined, updatedAt: string): BoundSession | undefined {
    return this.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return undefined;
      this.sqlite.prepare(`
        update bound_sessions
        set model_profile_request_json = ?, updated_at = ?
        where id = ?
      `).run(request ? JSON.stringify(request) : null, nextUpdatedAt(current.updatedAt, updatedAt), id);
      return this.getById(id);
    })();
  }

  compareAndSetModelProfileRequest(input: {
    id: string;
    requestId: string;
    expectedState: ModelProfileRequest['state'];
    next: ModelProfileRequest | undefined;
    updatedAt: string;
  }): BoundSession | undefined {
    return this.sqlite.transaction(() => {
      const current = this.getById(input.id);
      if (current?.modelProfileRequest?.requestId !== input.requestId
        || current.modelProfileRequest.state !== input.expectedState) {
        return undefined;
      }
      this.sqlite.prepare(`
        update bound_sessions
        set model_profile_request_json = ?, updated_at = ?
        where id = ?
      `).run(input.next ? JSON.stringify(input.next) : null, nextUpdatedAt(current.updatedAt, input.updatedAt), input.id);
      return this.getById(input.id);
    })();
  }

  completeModelProfileRequest(input: {
    id: string;
    requestId: string;
    profile: ModelProfileKey;
    updatedAt: string;
  }): BoundSession | undefined {
    return this.sqlite.transaction(() => {
      const current = this.getById(input.id);
      if (current?.modelProfileRequest?.requestId !== input.requestId
        || current.modelProfileRequest.state !== 'applying'
        || current.modelProfileRequest.profile !== input.profile) {
        return undefined;
      }
      this.sqlite.prepare(`
        update bound_sessions
        set ${profileColumn(current.provider)} = ?, auto_route_json = ?, model_profile_request_json = null, updated_at = ?
        where id = ?
      `).run(
        input.profile,
        // Ultra, High, Medium and Low carry no Auto state; a switch to Auto commits the state its request carries.
        input.profile === 'auto' && current.modelProfileRequest.autoRoute ? JSON.stringify(current.modelProfileRequest.autoRoute) : null,
        nextUpdatedAt(current.updatedAt, input.updatedAt),
        input.id,
      );
      return this.getById(input.id);
    })();
  }

  list(): BoundSession[] {
    const rows = this.sqlite.prepare(`select * from bound_sessions order by updated_at desc`).all() as SqliteRow[];
    return rows.map(row => this.mapRow(row));
  }

  /** Every retained agent launch the person has not replied in, including sessions that have ended and left the chat tree. */
  listAgentLaunchMarks(): AgentLaunchMark[] {
    const rows = this.sqlite.prepare(`
      select project_slug, provider, conversation_ref, resume_conversation_ref, launch_context_json, updated_at
      from bound_sessions
      where launch_context_json is not null and length(launch_context_json) > 0
    `).all() as SqliteRow[];
    const marks: AgentLaunchMark[] = [];
    for (const row of rows) {
      const provider = String(row.provider);
      if (!(PROVIDERS as readonly string[]).includes(provider)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(row.launch_context_json));
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      // The person has answered in this chat, so it is theirs as well as the agent's: the list shows it.
      if ('humanRepliedAt' in parsed && parsed.humanRepliedAt) continue;
      const launcherName = 'launcherName' in parsed && typeof parsed.launcherName === 'string' ? parsed.launcherName : '';
      marks.push({
        projectSlug: String(row.project_slug),
        provider: provider as ProviderId,
        conversationRef: String(row.conversation_ref),
        resumeConversationRef: optionalString(row.resume_conversation_ref),
        launcherName,
        updatedAt: String(row.updated_at),
      });
    }
    return marks;
  }

  listTreeVisible(): BoundSession[] {
    const rows = this.sqlite.prepare(`
      select *
      from bound_sessions bs
      where ${treeVisibleBoundSessionSql('bs')}
        and not exists (
          select 1
          from bound_sessions newer
          where newer.project_slug = bs.project_slug
            and newer.provider = bs.provider
            and newer.conversation_ref = bs.conversation_ref
            and ${treeVisibleBoundSessionSql('newer')}
            and (
              newer.updated_at > bs.updated_at
              or (newer.updated_at = bs.updated_at and newer.id > bs.id)
            )
        )
      order by updated_at desc
    `).all() as SqliteRow[];
    return rows.map(row => this.mapRow(row));
  }

  getById(id: string): BoundSession | undefined {
    const row = this.sqlite.prepare(`select * from bound_sessions where id = ?`).get(id) as SqliteRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getRestorableByConversation(projectSlug: string, provider: string, conversationRef: string): BoundSession | undefined {
    const row = this.sqlite.prepare(`
      select * from bound_sessions
      where project_slug = ? and provider = ? and conversation_ref = ? and should_restore = 1
      order by updated_at desc
      limit 1
    `).get(projectSlug, provider, conversationRef) as SqliteRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getLastThinkingEffort(projectSlug: string, provider: string, conversationRef: string): string | undefined {
    const row = this.sqlite.prepare(`
      select m.value from bound_sessions bs
      join meta m on m.key = 'session-thinking:' || bs.id
      where bs.project_slug = ? and bs.provider = ? and bs.conversation_ref = ?
      order by bs.started_at desc, bs.rowid desc limit 1
    `).get(projectSlug, provider, conversationRef) as { value: string } | undefined;
    return row?.value;
  }

  delete(id: string): void {
    this.sqlite.prepare(`delete from bound_sessions where id = ?`).run(id);
  }
}

/** The column a provider's model profile is stored in. */
function profileColumn(provider: BoundSession['provider']): 'codex_profile' | 'claude_profile' | 'grok_profile' | 'vibe_profile' {
  if (provider === 'codex') return 'codex_profile';
  if (provider === 'grok') return 'grok_profile';
  if (provider === 'vibe') return 'vibe_profile';
  return 'claude_profile';
}

export function mapBoundSessionRow(row: SqliteRow): BoundSession {
  return {
    runFailure: row.run_failure_json ? JSON.parse(String(row.run_failure_json)) as BoundSession['runFailure'] : undefined,
    id: String(row.id),
    provider: String(row.provider) as BoundSession['provider'],
    codexProfile: optionalString(row.codex_profile) as BoundSession['codexProfile'],
    claudeProfile: optionalString(row.claude_profile) as BoundSession['claudeProfile'],
    grokProfile: optionalString(row.grok_profile) as BoundSession['grokProfile'],
    vibeProfile: optionalString(row.vibe_profile) as BoundSession['vibeProfile'],
    autoRoute: typeof row.auto_route_json === 'string' ? JSON.parse(row.auto_route_json) as AutoRoute : undefined,
    modelProfileRequest: row.model_profile_request_json
      ? JSON.parse(String(row.model_profile_request_json)) as BoundSession['modelProfileRequest']
      : undefined,
    projectSlug: String(row.project_slug),
    conversationRef: String(row.conversation_ref),
    resumeConversationRef: optionalString(row.resume_conversation_ref),
    status: String(row.status) as BoundSession['status'],
    shouldRestore: Boolean(row.should_restore),
    title: optionalString(row.title),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    lastActivityAt: optionalString(row.last_activity_at),
    lastOutputAt: optionalString(row.last_output_at),
    lastCompletedAt: optionalString(row.last_completed_at),
    lastResponseAt: optionalString(row.last_response_at),
    autoTrackedAt: optionalString(row.auto_tracked_at),
    manualSuspendedAt: optionalString(row.manual_suspended_at),
    pressureSuspendedAt: optionalString(row.pressure_suspended_at),
    idleSuspendedAt: optionalString(row.idle_suspended_at),
    isWorking: Boolean(row.is_working),
    pid: numberOrUndefined(row.pid),
    eventLogPath: optionalString(row.event_log_path),
    launchContext: typeof row.launch_context_json === 'string' ? JSON.parse(row.launch_context_json) as BoundSession['launchContext'] : undefined,
  };
}
