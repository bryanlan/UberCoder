import Database from 'better-sqlite3';
import type { ConversationSummary } from '@agent-console/shared';
import { boolAsInt, optionalString, parseJson, type SqliteRow } from '../utils.js';

export class PendingConversationsRepo {
  constructor(private readonly sqlite: Database.Database) {}

  put(item: ConversationSummary): void {
    this.sqlite.prepare(`
      insert into pending_conversations (
        ref, project_slug, provider, title, created_at, updated_at, bound_session_id, transcript_path, degraded, raw_metadata_json
      ) values (
        @ref, @project_slug, @provider, @title, @created_at, @updated_at, @bound_session_id, @transcript_path, @degraded, @raw_metadata_json
      )
      on conflict(ref) do update set
        title = excluded.title,
        updated_at = excluded.updated_at,
        bound_session_id = excluded.bound_session_id,
        transcript_path = excluded.transcript_path,
        degraded = excluded.degraded,
        raw_metadata_json = excluded.raw_metadata_json
    `).run({
      ref: item.ref,
      project_slug: item.projectSlug,
      provider: item.provider,
      title: item.title,
      created_at: item.createdAt ?? item.updatedAt,
      updated_at: item.updatedAt,
      bound_session_id: item.boundSessionId ?? null,
      transcript_path: item.transcriptPath ?? null,
      degraded: boolAsInt(item.degraded),
      raw_metadata_json: item.rawMetadata ? JSON.stringify(item.rawMetadata) : null,
    });
  }

  list(): ConversationSummary[] {
    const rows = this.sqlite.prepare(`
      select pc.*, cto.title as override_title, bs.id as bound_session_id
      from pending_conversations pc
      left join conversation_title_overrides cto
        on cto.project_slug = pc.project_slug and cto.provider = pc.provider and cto.ref = pc.ref
      left join bound_sessions bs on bs.id = pc.bound_session_id and bs.should_restore = 1
      order by coalesce(pc.created_at, pc.updated_at) desc, pc.ref asc
    `).all() as SqliteRow[];
    return rows.map(mapPendingConversationRow);
  }

  get(ref: string): ConversationSummary | undefined {
    const row = this.sqlite.prepare(`
      select pc.*, cto.title as override_title, bs.id as bound_session_id
      from pending_conversations pc
      left join conversation_title_overrides cto
        on cto.project_slug = pc.project_slug and cto.provider = pc.provider and cto.ref = pc.ref
      left join bound_sessions bs on bs.id = pc.bound_session_id and bs.should_restore = 1
      where pc.ref = ?
      limit 1
    `).get(ref) as SqliteRow | undefined;
    return row ? mapPendingConversationRow(row) : undefined;
  }

  delete(ref: string): void {
    this.sqlite.prepare(`delete from pending_conversations where ref = ?`).run(ref);
  }
}

function mapPendingConversationRow(row: SqliteRow): ConversationSummary {
  return {
    ref: String(row.ref),
    kind: 'pending',
    projectSlug: String(row.project_slug),
    provider: String(row.provider) as ConversationSummary['provider'],
    title: String(row.override_title ?? row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    transcriptPath: optionalString(row.transcript_path),
    excerpt: undefined,
    isBound: Boolean(row.bound_session_id),
    boundSessionId: optionalString(row.bound_session_id),
    degraded: Boolean(row.degraded),
    rawMetadata: parseJson<Record<string, unknown>>(optionalString(row.raw_metadata_json)),
  };
}
