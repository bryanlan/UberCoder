import Database from 'better-sqlite3';
import {
  CONVERSATION_SEARCH_RECENCY_BUCKETS,
  type ConversationSearchRecencyBucket,
  type ConversationSearchResult,
  type ConversationSummary,
  type ProviderId,
} from '@agent-console/shared';
import { treeVisibleBoundSessionSql } from '../../lib/bound-session-state.js';
import { boolAsInt, optionalString, type SqliteRow } from '../utils.js';

export interface ConversationSearchIndexChunk {
  projectSlug: string;
  projectDisplayName: string;
  projectPath?: string;
  projectTags: string[];
  provider: ProviderId;
  conversationRef: string;
  conversationKind: ConversationSummary['kind'];
  conversationTitle: string;
  conversationUpdatedAt: string;
  isBound: boolean;
  messageId: string;
  role: 'user' | 'assistant';
  timestamp: string;
  text: string;
}

function conversationSearchRecencyBucketFromIndex(value: unknown): ConversationSearchRecencyBucket {
  const index = Number(value);
  if (Number.isInteger(index) && index >= 0 && index < CONVERSATION_SEARCH_RECENCY_BUCKETS.length) {
    return CONVERSATION_SEARCH_RECENCY_BUCKETS[index]!;
  }
  return '60-plus-days';
}

export class SearchIndexRepo {
  constructor(private readonly sqlite: Database.Database) {}

  hasRows(): boolean {
    const row = this.sqlite.prepare(`select 1 from conversation_search_fts limit 1`).get() as { 1: number } | undefined;
    return Boolean(row);
  }

  hasRowsFor(projectSlug: string, provider: ProviderId): boolean {
    const row = this.sqlite.prepare(`
      select 1
      from conversation_search_fts
      where project_slug = ? and provider = ?
      limit 1
    `).get(projectSlug, provider) as { 1: number } | undefined;
    return Boolean(row);
  }

  replace(projectSlug: string, provider: ProviderId, chunks: ConversationSearchIndexChunk[]): void {
    const clear = this.sqlite.prepare(`delete from conversation_search_fts where project_slug = ? and provider = ?`);
    const insert = this.sqlite.prepare(`
      insert into conversation_search_fts (
        conversation_title, project_display_name, project_tags, text, project_slug, project_path,
        provider, conversation_ref, conversation_kind, conversation_updated_at, is_bound,
        message_id, role, timestamp
      ) values (
        @conversation_title, @project_display_name, @project_tags, @text, @project_slug, @project_path,
        @provider, @conversation_ref, @conversation_kind, @conversation_updated_at, @is_bound,
        @message_id, @role, @timestamp
      )
    `);
    const tx = this.sqlite.transaction(() => {
      clear.run(projectSlug, provider);
      for (const chunk of chunks) {
        insert.run({
          conversation_title: chunk.conversationTitle,
          project_display_name: chunk.projectDisplayName,
          project_tags: chunk.projectTags.join(' '),
          text: chunk.text,
          project_slug: chunk.projectSlug,
          project_path: chunk.projectPath ?? null,
          provider: chunk.provider,
          conversation_ref: chunk.conversationRef,
          conversation_kind: chunk.conversationKind,
          conversation_updated_at: chunk.conversationUpdatedAt,
          is_bound: boolAsInt(chunk.isBound),
          message_id: chunk.messageId,
          role: chunk.role,
          timestamp: chunk.timestamp,
        });
      }
    });
    tx();
  }

  updateTitle(projectSlug: string, provider: ProviderId, conversationRef: string, title: string): void {
    this.sqlite.prepare(`
      update conversation_search_fts
      set conversation_title = ?
      where project_slug = ? and provider = ? and conversation_ref = ?
    `).run(title, projectSlug, provider, conversationRef);
  }

  updateProjectMetadata(input: {
    projectSlug: string;
    displayName: string;
    path: string;
    tags: string[];
  }): void {
    this.sqlite.prepare(`
      update conversation_search_fts
      set project_display_name = ?, project_path = ?, project_tags = ?
      where project_slug = ?
    `).run(input.displayName, input.path, input.tags.join(' '), input.projectSlug);
  }

  search(ftsQuery: string, limit: number, options: { projectSlugs?: string[]; now?: string } = {}): ConversationSearchResult[] {
    const projectSlugs = options.projectSlugs;
    if (projectSlugs && projectSlugs.length === 0) {
      return [];
    }
    const projectFilter = projectSlugs
      ? `and conversation_search_fts.project_slug in (${projectSlugs.map(() => '?').join(', ')})`
      : '';
    const rows = this.sqlite.prepare(`
      with matched_chunks as (
        select
          conversation_search_fts.rowid as fts_rowid,
          conversation_search_fts.project_slug,
          conversation_search_fts.project_display_name,
          conversation_search_fts.project_path,
          conversation_search_fts.provider,
          conversation_search_fts.conversation_ref,
          conversation_search_fts.conversation_kind,
          conversation_search_fts.conversation_title,
          conversation_search_fts.conversation_updated_at,
          conversation_search_fts.is_bound,
          conversation_search_fts.role,
          conversation_search_fts.timestamp,
          case
            when julianday(?) - julianday(conversation_search_fts.conversation_updated_at) < 5 then 0
            when julianday(?) - julianday(conversation_search_fts.conversation_updated_at) < 15 then 1
            when julianday(?) - julianday(conversation_search_fts.conversation_updated_at) < 30 then 2
            when julianday(?) - julianday(conversation_search_fts.conversation_updated_at) < 60 then 3
            else 4
          end as recency_bucket,
          bm25(conversation_search_fts, 3.0, 2.0, 1.5, 1.0) as rank
        from conversation_search_fts
        where conversation_search_fts match ?
        ${projectFilter}
      ),
      ranked_matches as (
        select
          matched_chunks.*,
          row_number() over (
            partition by matched_chunks.project_slug, matched_chunks.provider, matched_chunks.conversation_ref
            order by matched_chunks.recency_bucket asc, matched_chunks.rank asc, matched_chunks.timestamp desc
          ) as conversation_rank
        from matched_chunks
      )
      select
        ranked_matches.project_slug,
        ranked_matches.project_display_name,
        ranked_matches.project_path,
        ranked_matches.provider,
        ranked_matches.conversation_ref,
        ranked_matches.conversation_kind,
        coalesce(cto.title, ranked_matches.conversation_title) as conversation_title,
        ranked_matches.conversation_updated_at,
        ranked_matches.is_bound,
        ranked_matches.role,
        ranked_matches.timestamp,
        ranked_matches.recency_bucket,
        snippet(conversation_search_fts, 3, '', '', ' ... ', 40) as snippet,
        ranked_matches.rank,
        bs.id as bound_session_id
      from ranked_matches
      join conversation_search_fts on conversation_search_fts.rowid = ranked_matches.fts_rowid
      left join conversation_title_overrides cto
        on cto.project_slug = ranked_matches.project_slug
        and cto.provider = ranked_matches.provider
        and cto.ref = ranked_matches.conversation_ref
      left join bound_sessions bs
        on bs.project_slug = ranked_matches.project_slug
        and bs.provider = ranked_matches.provider
        and bs.conversation_ref = ranked_matches.conversation_ref
        and ${treeVisibleBoundSessionSql('bs')}
      where ranked_matches.conversation_rank = 1
      order by ranked_matches.recency_bucket asc, ranked_matches.rank asc, ranked_matches.conversation_updated_at desc
      limit ?
    `).all(
      options.now ?? new Date().toISOString(),
      options.now ?? new Date().toISOString(),
      options.now ?? new Date().toISOString(),
      options.now ?? new Date().toISOString(),
      ftsQuery,
      ...(projectSlugs ?? []),
      limit,
    ) as SqliteRow[];

    return rows.map((row) => ({
      projectSlug: String(row.project_slug),
      projectDisplayName: String(row.project_display_name),
      projectPath: optionalString(row.project_path),
      provider: String(row.provider) as ProviderId,
      conversationRef: String(row.conversation_ref),
      conversationKind: row.conversation_kind === 'pending' ? 'pending' : 'history',
      conversationTitle: String(row.conversation_title),
      conversationUpdatedAt: String(row.conversation_updated_at),
      isBound: Boolean(row.bound_session_id),
      role: row.role === 'user' ? 'user' : 'assistant',
      timestamp: String(row.timestamp),
      snippet: String(row.snippet ?? ''),
      score: -Number(row.rank ?? 0) * 1_000_000,
      recencyBucket: conversationSearchRecencyBucketFromIndex(row.recency_bucket),
    }));
  }
}
