import Database from 'better-sqlite3';
import type { BoundSession, ModelProfileKey, ModelProfileRequest } from '@agent-console/shared';
import { boolAsInt, numberOrUndefined, optionalString, type SqliteRow } from '../utils.js';

const treeVisibleBoundSessionSql = (alias: string) => `${alias}.should_restore = 1 and ${alias}.status in ('starting', 'bound', 'releasing')`;

function nextUpdatedAt(current: string, candidate: string): string {
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(currentMs) || !Number.isFinite(candidateMs) || candidateMs > currentMs) {
    return candidate;
  }
  return new Date(currentMs + 1).toISOString();
}

export class BoundSessionsRepo {
  constructor(private readonly sqlite: Database.Database) {}

  upsert(session: BoundSession): void {
    const shouldRestore = session.shouldRestore ?? ['starting', 'bound', 'releasing'].includes(session.status);
    const resumeConversationRef = session.resumeConversationRef
      ?? (!session.conversationRef.startsWith('pending:') ? session.conversationRef : undefined);
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        insert into bound_sessions (
          id, provider, codex_profile, claude_profile, project_slug, conversation_ref, resume_conversation_ref, tmux_session_name, status, should_restore, title,
          started_at, updated_at, last_activity_at, last_output_at, last_completed_at, auto_tracked_at, is_working, pid, raw_log_path, event_log_path
        ) values (
          @id, @provider, @codex_profile, @claude_profile, @project_slug, @conversation_ref, @resume_conversation_ref, @tmux_session_name, @status, @should_restore, @title,
          @started_at, @updated_at, @last_activity_at, @last_output_at, @last_completed_at, @auto_tracked_at, @is_working, @pid, @raw_log_path, @event_log_path
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
          resume_conversation_ref = excluded.resume_conversation_ref,
          tmux_session_name = excluded.tmux_session_name,
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
          auto_tracked_at = excluded.auto_tracked_at,
          is_working = excluded.is_working,
          pid = excluded.pid,
          raw_log_path = excluded.raw_log_path,
          event_log_path = excluded.event_log_path
      `).run({
        id: session.id,
        provider: session.provider,
        codex_profile: session.codexProfile ?? null,
        claude_profile: session.claudeProfile ?? null,
        project_slug: session.projectSlug,
        conversation_ref: session.conversationRef,
        resume_conversation_ref: resumeConversationRef ?? null,
        tmux_session_name: session.tmuxSessionName,
        status: session.status,
        should_restore: boolAsInt(shouldRestore),
        title: session.title ?? null,
        started_at: session.startedAt,
        updated_at: session.updatedAt,
        last_activity_at: session.lastActivityAt ?? null,
        last_output_at: session.lastOutputAt ?? null,
        last_completed_at: session.lastCompletedAt ?? null,
        auto_tracked_at: session.autoTrackedAt ?? null,
        is_working: boolAsInt(Boolean(session.isWorking)),
        pid: session.pid ?? null,
        raw_log_path: session.rawLogPath ?? null,
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

  // Independently owned state: ordinary screen/status upserts must not overwrite it.
  setRunFailure(id: string, failure: BoundSession['runFailure']): void {
    this.sqlite.prepare('update bound_sessions set run_failure_json = ? where id = ?')
      .run(failure ? JSON.stringify(failure) : null, id);
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
        set ${current.provider === 'codex' ? 'codex_profile' : 'claude_profile'} = ?, model_profile_request_json = null, updated_at = ?
        where id = ?
      `).run(input.profile, nextUpdatedAt(current.updatedAt, input.updatedAt), input.id);
      return this.getById(input.id);
    })();
  }

  list(): BoundSession[] {
    const rows = this.sqlite.prepare(`select * from bound_sessions order by updated_at desc`).all() as SqliteRow[];
    return rows.map(mapBoundSessionRow);
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
    return rows.map(mapBoundSessionRow);
  }

  getById(id: string): BoundSession | undefined {
    const row = this.sqlite.prepare(`select * from bound_sessions where id = ?`).get(id) as SqliteRow | undefined;
    return row ? mapBoundSessionRow(row) : undefined;
  }

  getRestorableByConversation(projectSlug: string, provider: string, conversationRef: string): BoundSession | undefined {
    const row = this.sqlite.prepare(`
      select * from bound_sessions
      where project_slug = ? and provider = ? and conversation_ref = ? and should_restore = 1
      order by updated_at desc
      limit 1
    `).get(projectSlug, provider, conversationRef) as SqliteRow | undefined;
    return row ? mapBoundSessionRow(row) : undefined;
  }

  delete(id: string): void {
    this.sqlite.prepare(`delete from bound_sessions where id = ?`).run(id);
  }
}

export function mapBoundSessionRow(row: SqliteRow): BoundSession {
  return {
    runFailure: row.run_failure_json ? JSON.parse(String(row.run_failure_json)) as BoundSession['runFailure'] : undefined,
    id: String(row.id),
    provider: String(row.provider) as BoundSession['provider'],
    codexProfile: optionalString(row.codex_profile) as BoundSession['codexProfile'],
    claudeProfile: optionalString(row.claude_profile) as BoundSession['claudeProfile'],
    modelProfileRequest: row.model_profile_request_json
      ? JSON.parse(String(row.model_profile_request_json)) as BoundSession['modelProfileRequest']
      : undefined,
    projectSlug: String(row.project_slug),
    conversationRef: String(row.conversation_ref),
    resumeConversationRef: optionalString(row.resume_conversation_ref),
    tmuxSessionName: String(row.tmux_session_name),
    status: String(row.status) as BoundSession['status'],
    shouldRestore: Boolean(row.should_restore),
    title: optionalString(row.title),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    lastActivityAt: optionalString(row.last_activity_at),
    lastOutputAt: optionalString(row.last_output_at),
    lastCompletedAt: optionalString(row.last_completed_at),
    autoTrackedAt: optionalString(row.auto_tracked_at),
    isWorking: Boolean(row.is_working),
    pid: numberOrUndefined(row.pid),
    rawLogPath: optionalString(row.raw_log_path),
    eventLogPath: optionalString(row.event_log_path),
  };
}
