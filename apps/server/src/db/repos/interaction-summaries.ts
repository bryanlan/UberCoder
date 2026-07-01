import Database from 'better-sqlite3';
import type { SessionInteractionSummary } from '@agent-console/shared';
import { optionalString, type SqliteRow } from '../utils.js';

export type StoredSessionInteractionSummary = SessionInteractionSummary & {
  titleSuggestion?: string;
  titleSuggestedAt?: string;
  lastError?: string;
};

export class InteractionSummariesRepo {
  constructor(private readonly sqlite: Database.Database) {}

  upsert(input: StoredSessionInteractionSummary): void {
    this.sqlite.prepare(`
      insert into session_interaction_summaries (
        session_id, project_slug, provider, conversation_ref, status, chat_summary,
        recent_changes_summary, generated_at, window_start_at, window_end_at,
        last_interaction_at, failed_at, last_error, title_suggestion, title_suggested_at
      ) values (
        @session_id, @project_slug, @provider, @conversation_ref, @status, @chat_summary,
        @recent_changes_summary, @generated_at, @window_start_at, @window_end_at,
        @last_interaction_at, @failed_at, @last_error, @title_suggestion, @title_suggested_at
      )
      on conflict(session_id) do update set
        project_slug = excluded.project_slug,
        provider = excluded.provider,
        conversation_ref = excluded.conversation_ref,
        status = excluded.status,
        chat_summary = excluded.chat_summary,
        recent_changes_summary = excluded.recent_changes_summary,
        generated_at = excluded.generated_at,
        window_start_at = excluded.window_start_at,
        window_end_at = excluded.window_end_at,
        last_interaction_at = excluded.last_interaction_at,
        failed_at = excluded.failed_at,
        last_error = excluded.last_error,
        title_suggestion = coalesce(excluded.title_suggestion, session_interaction_summaries.title_suggestion),
        title_suggested_at = coalesce(excluded.title_suggested_at, session_interaction_summaries.title_suggested_at)
    `).run({
      session_id: input.sessionId,
      project_slug: input.projectSlug,
      provider: input.provider,
      conversation_ref: input.conversationRef,
      status: input.status,
      chat_summary: input.chatSummary ?? null,
      recent_changes_summary: input.recentChangesSummary ?? null,
      generated_at: input.generatedAt ?? null,
      window_start_at: input.windowStartAt ?? null,
      window_end_at: input.windowEndAt ?? null,
      last_interaction_at: input.lastInteractionAt ?? null,
      failed_at: input.failedAt ?? null,
      last_error: input.lastError ?? null,
      title_suggestion: input.titleSuggestion ?? null,
      title_suggested_at: input.titleSuggestedAt ?? null,
    });
  }

  get(sessionId: string): StoredSessionInteractionSummary | undefined {
    const row = this.sqlite.prepare(`
      select * from session_interaction_summaries
      where session_id = ?
      limit 1
    `).get(sessionId) as SqliteRow | undefined;
    return row ? mapSessionInteractionSummaryRow(row, true) : undefined;
  }

  listBySessionIds(sessionIds: string[]): Map<string, SessionInteractionSummary> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = this.sqlite.prepare(`
      select * from session_interaction_summaries
      where session_id in (${placeholders})
    `).all(...sessionIds) as SqliteRow[];
    return new Map(rows.map((row) => {
      const summary = mapSessionInteractionSummaryRow(row, false);
      return [summary.sessionId, summary];
    }));
  }
}

function mapSessionInteractionSummaryRow(row: SqliteRow, includeInternalFields: true): StoredSessionInteractionSummary;
function mapSessionInteractionSummaryRow(row: SqliteRow, includeInternalFields: false): SessionInteractionSummary;
function mapSessionInteractionSummaryRow(row: SqliteRow, includeInternalFields: boolean): StoredSessionInteractionSummary {
  const summary: StoredSessionInteractionSummary = {
    sessionId: String(row.session_id),
    projectSlug: String(row.project_slug),
    provider: String(row.provider) as SessionInteractionSummary['provider'],
    conversationRef: String(row.conversation_ref),
    status: row.status === 'ready' ? 'ready' : 'failed',
    generatedAt: optionalString(row.generated_at),
    windowStartAt: optionalString(row.window_start_at),
    windowEndAt: optionalString(row.window_end_at),
    lastInteractionAt: optionalString(row.last_interaction_at),
    chatSummary: optionalString(row.chat_summary),
    recentChangesSummary: optionalString(row.recent_changes_summary),
    failedAt: optionalString(row.failed_at),
  };

  if (includeInternalFields) {
    summary.lastError = optionalString(row.last_error);
    summary.titleSuggestion = optionalString(row.title_suggestion);
    summary.titleSuggestedAt = optionalString(row.title_suggested_at);
  }

  return summary;
}
