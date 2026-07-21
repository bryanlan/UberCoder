import Database from 'better-sqlite3';
import type { BoundSession } from '@agent-console/shared';
import { boolAsInt, numberOrUndefined, optionalString, type SqliteRow } from '../utils.js';

const treeVisibleBoundSessionSql = (alias: string) => `${alias}.should_restore = 1 and ${alias}.status in ('starting', 'bound', 'releasing')`;

export class BoundSessionsRepo {
  constructor(private readonly sqlite: Database.Database) {}

  upsert(session: BoundSession): void {
    const shouldRestore = session.shouldRestore ?? ['starting', 'bound', 'releasing'].includes(session.status);
    const resumeConversationRef = session.resumeConversationRef
      ?? (!session.conversationRef.startsWith('pending:') ? session.conversationRef : undefined);
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        insert into bound_sessions (
          id, provider, project_slug, conversation_ref, resume_conversation_ref, tmux_session_name, status, should_restore, title,
          started_at, updated_at, last_activity_at, last_output_at, last_completed_at, auto_tracked_at, is_working, pid, raw_log_path, event_log_path
        ) values (
          @id, @provider, @project_slug, @conversation_ref, @resume_conversation_ref, @tmux_session_name, @status, @should_restore, @title,
          @started_at, @updated_at, @last_activity_at, @last_output_at, @last_completed_at, @auto_tracked_at, @is_working, @pid, @raw_log_path, @event_log_path
        )
        on conflict(id) do update set
          conversation_ref = excluded.conversation_ref,
          resume_conversation_ref = excluded.resume_conversation_ref,
          tmux_session_name = excluded.tmux_session_name,
          status = excluded.status,
          should_restore = excluded.should_restore,
          title = excluded.title,
          updated_at = excluded.updated_at,
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
    id: String(row.id),
    provider: String(row.provider) as BoundSession['provider'],
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
