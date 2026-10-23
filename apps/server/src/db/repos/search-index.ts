import Database from 'better-sqlite3';
import {
  CONVERSATION_SEARCH_RECENCY_BUCKETS,
  type ConversationSearchRecencyBucket,
  type ConversationSearchResult,
  type ConversationSummary,
  type ProviderId,
} from '@agent-console/shared';
import { treeVisibleBoundSessionSql } from '../../lib/bound-session-state.js';
import { boolAsInt, numberOrUndefined, optionalString, type SqliteRow } from '../utils.js';
import { ReadQueryWorker } from '../read-query-worker.js';

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

function normalizedHaystack(text: string): string {
  return text.toLocaleLowerCase();
}

function countMatches(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const found = text.indexOf(term, index);
    if (found === -1) break;
    count += 1;
    index = found + Math.max(1, term.length);
  }
  return count;
}

function scorePersistedResult(input: {
  title: string;
  projectDisplayName: string;
  text: string;
  terms: string[];
}): number {
  const text = normalizedHaystack(input.text);
  const title = normalizedHaystack(input.title);
  const project = normalizedHaystack(input.projectDisplayName);
  const textScore = input.terms.reduce((score, term) => score + countMatches(text, term), 0);
  const titleScore = input.terms.reduce((score, term) => score + (title.includes(term) ? 3 : 0), 0);
  const projectScore = input.terms.reduce((score, term) => score + (project.includes(term) ? 2 : 0), 0);
  return textScore + titleScore + projectScore;
}

export interface ConversationSearchStateRow {
  transcriptPath?: string;
  size?: number;
  mtimeMs?: number;
}

export class SearchIndexRepo {
  private readonly reader: ReadQueryWorker;
  private readonly insertChunkStatement: Database.Statement;
  private readonly insertRowStatement: Database.Statement;
  private readonly deleteConversationChunksStatement: Database.Statement;
  private readonly deleteConversationRowsStatement: Database.Statement;
  private readonly deleteConversationStateStatement: Database.Statement;
  private readonly upsertConversationStateStatement: Database.Statement;
  private readonly conversationChunksStatement: Database.Statement;
  private readonly deleteChunkStatement: Database.Statement;
  private readonly deleteRowStatement: Database.Statement;
  private readonly updateConversationMetadataStatement: Database.Statement;

  constructor(private readonly sqlite: Database.Database) {
    this.reader = new ReadQueryWorker(sqlite.name);
    this.insertChunkStatement = sqlite.prepare(`
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
    this.deleteConversationChunksStatement = sqlite.prepare(`
      delete from conversation_search_fts
      where rowid in (select fts_rowid from conversation_search_rows
        where project_slug = ? and provider = ? and conversation_ref = ?)
    `);
    this.insertRowStatement = sqlite.prepare(`insert into conversation_search_rows
      (fts_rowid, project_slug, provider, conversation_ref) values (?, ?, ?, ?)`);
    this.deleteConversationRowsStatement = sqlite.prepare(`delete from conversation_search_rows
      where project_slug = ? and provider = ? and conversation_ref = ?`);
    this.deleteConversationStateStatement = sqlite.prepare(`
      delete from conversation_search_state
      where project_slug = ? and provider = ? and ref = ?
    `);
    this.upsertConversationStateStatement = sqlite.prepare(`
      insert into conversation_search_state (project_slug, provider, ref, transcript_path, size, mtime_ms)
      values (?, ?, ?, ?, ?, ?)
      on conflict(project_slug, provider, ref) do update set
        transcript_path = excluded.transcript_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms
    `);
    this.conversationChunksStatement = sqlite.prepare(`select rowid,message_id,role,timestamp,text
      from conversation_search_fts where rowid in (select fts_rowid from conversation_search_rows
        where project_slug=? and provider=? and conversation_ref=?)`);
    this.deleteChunkStatement = sqlite.prepare('delete from conversation_search_fts where rowid=?');
    this.deleteRowStatement = sqlite.prepare('delete from conversation_search_rows where fts_rowid=?');
    // Conversation metadata belongs to the lowest owned row. Other rows carry
    // message content, so an appended message need not reindex the whole history.
    this.updateConversationMetadataStatement = sqlite.prepare(`update conversation_search_fts set
      conversation_title=@conversation_title,project_display_name=@project_display_name,
      project_tags=@project_tags,project_path=@project_path,conversation_kind=@conversation_kind,
      conversation_updated_at=@conversation_updated_at,is_bound=@is_bound
      where rowid=(select min(fts_rowid) from conversation_search_rows
        where project_slug=@project_slug and provider=@provider and conversation_ref=@conversation_ref)`);
  }

  hasRows(): boolean {
    const row = this.sqlite.prepare(`select 1 from conversation_search_fts limit 1`).get() as { 1: number } | undefined;
    return Boolean(row);
  }

  hasRowsFor(projectSlug: string, provider: ProviderId): boolean {
    const row = this.sqlite.prepare(`
      select 1
      from conversation_search_rows
      where project_slug = ? and provider = ?
      limit 1
    `).get(projectSlug, provider) as { 1: number } | undefined;
    return Boolean(row);
  }

  replace(projectSlug: string, provider: ProviderId, chunks: ConversationSearchIndexChunk[]): void {
    const clear = this.sqlite.prepare(`delete from conversation_search_fts where rowid in
      (select fts_rowid from conversation_search_rows where project_slug = ? and provider = ?)`);
    const clearRows = this.sqlite.prepare(`delete from conversation_search_rows where project_slug = ? and provider = ?`);
    const clearState = this.sqlite.prepare(`delete from conversation_search_state where project_slug = ? and provider = ?`);
    const tx = this.sqlite.transaction(() => {
      clear.run(projectSlug, provider);
      clearRows.run(projectSlug, provider);
      clearState.run(projectSlug, provider);
      for (const chunk of chunks) {
        this.insertChunk(chunk);
      }
    });
    tx();
  }

  private insertChunk(chunk: ConversationSearchIndexChunk): void {
    const inserted = this.insertChunkStatement.run({
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
    this.insertRowStatement.run(inserted.lastInsertRowid, chunk.projectSlug, chunk.provider, chunk.conversationRef);
  }

  getConversationStates(projectSlug: string, provider: ProviderId): Map<string, ConversationSearchStateRow> {
    const rows = this.sqlite.prepare(`
      select ref, transcript_path, size, mtime_ms
      from conversation_search_state
      where project_slug = ? and provider = ?
    `).all(projectSlug, provider) as SqliteRow[];
    return new Map(rows.map((row) => [String(row.ref), {
      transcriptPath: optionalString(row.transcript_path),
      size: numberOrUndefined(row.size),
      mtimeMs: numberOrUndefined(row.mtime_ms),
    }]));
  }

  replaceConversation(
    projectSlug: string,
    provider: ProviderId,
    conversationRef: string,
    chunks: ConversationSearchIndexChunk[],
    state: ConversationSearchStateRow,
  ): void {
    const tx = this.sqlite.transaction(() => {
      const remaining = new Map<string, number[]>();
      const identity = (messageId: unknown, role: unknown, timestamp: unknown, text: unknown) =>
        JSON.stringify([messageId, role, timestamp, text]);
      for (const row of this.conversationChunksStatement.all(projectSlug, provider, conversationRef) as SqliteRow[]) {
        const key = identity(row.message_id, row.role, row.timestamp, row.text);
        const matches = remaining.get(key) ?? [];
        matches.push(Number(row.rowid)); remaining.set(key, matches);
      }
      for (const chunk of chunks) {
        const matches = remaining.get(identity(chunk.messageId, chunk.role, chunk.timestamp, chunk.text));
        if (matches?.length) matches.pop();
        else this.insertChunk(chunk);
      }
      for (const matches of remaining.values()) for (const rowid of matches) {
        this.deleteChunkStatement.run(rowid); this.deleteRowStatement.run(rowid);
      }
      const metadata = chunks[0];
      if (metadata) this.updateConversationMetadataStatement.run({
        project_slug: projectSlug, provider, conversation_ref: conversationRef,
        conversation_title: metadata.conversationTitle, project_display_name: metadata.projectDisplayName,
        project_tags: metadata.projectTags.join(' '), project_path: metadata.projectPath ?? null,
        conversation_kind: metadata.conversationKind, conversation_updated_at: metadata.conversationUpdatedAt,
        is_bound: boolAsInt(metadata.isBound),
      });
      this.upsertConversationStateStatement.run(
        projectSlug,
        provider,
        conversationRef,
        state.transcriptPath ?? null,
        state.size ?? null,
        state.mtimeMs ?? null,
      );
    });
    tx();
  }

  deleteConversation(projectSlug: string, provider: ProviderId, conversationRef: string): void {
    const tx = this.sqlite.transaction(() => {
      this.deleteConversationChunksStatement.run(projectSlug, provider, conversationRef);
      this.deleteConversationRowsStatement.run(projectSlug, provider, conversationRef);
      this.deleteConversationStateStatement.run(projectSlug, provider, conversationRef);
    });
    tx();
  }

  updateTitle(projectSlug: string, provider: ProviderId, conversationRef: string, title: string): void {
    this.sqlite.prepare(`
      update conversation_search_fts
      set conversation_title = ?
      where rowid = (select min(fts_rowid) from conversation_search_rows
        where project_slug = ? and provider = ? and conversation_ref = ?)
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
      where rowid in (select min(fts_rowid) from conversation_search_rows where project_slug = ?
        group by provider,conversation_ref)
    `).run(input.displayName, input.path, input.tags.join(' '), input.projectSlug);
  }

  close(): Promise<void> {
    return this.reader.close();
  }

  async search(ftsQuery: string, limit: number, options: { projectSlugs?: string[]; now?: string; terms?: string[] } = {}): Promise<ConversationSearchResult[]> {
    const projectSlugs = options.projectSlugs;
    if (projectSlugs && projectSlugs.length === 0) {
      return [];
    }
    const projectFilter = projectSlugs
      ? `and conversation_search_fts.project_slug in (${projectSlugs.map(() => '?').join(', ')})`
      : '';
    const rows = await this.reader.query(`
      with matched_chunks as (
        select
          conversation_search_fts.rowid as fts_rowid,
          conversation_search_fts.project_slug,
          metadata.project_display_name,
          metadata.project_path,
          conversation_search_fts.provider,
          conversation_search_fts.conversation_ref,
          metadata.conversation_kind,
          metadata.conversation_title,
          metadata.conversation_updated_at,
          metadata.is_bound,
          conversation_search_fts.role,
          conversation_search_fts.timestamp,
          case
            when julianday(?) - julianday(metadata.conversation_updated_at) < 5 then 0
            when julianday(?) - julianday(metadata.conversation_updated_at) < 15 then 1
            when julianday(?) - julianday(metadata.conversation_updated_at) < 30 then 2
            when julianday(?) - julianday(metadata.conversation_updated_at) < 60 then 3
            else 4
          end as recency_bucket,
          bm25(conversation_search_fts.conversation_search_fts, 3.0, 2.0, 1.5, 1.0) as rank
        from conversation_search_fts
        join conversation_search_fts metadata on metadata.rowid=(select min(fts_rowid)
          from conversation_search_rows where project_slug=conversation_search_fts.project_slug
            and provider=conversation_search_fts.provider and conversation_ref=conversation_search_fts.conversation_ref)
        where conversation_search_fts.conversation_search_fts match ?
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
        conversation_search_fts.text as matched_text,
        snippet(conversation_search_fts.conversation_search_fts, 3, '', '', ' ... ', 40) as snippet,
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
      where ranked_matches.conversation_rank = 1
      order by ranked_matches.recency_bucket asc, ranked_matches.rank asc, ranked_matches.conversation_updated_at desc
      limit ?
    `, [
      options.now ?? new Date().toISOString(),
      options.now ?? new Date().toISOString(),
      options.now ?? new Date().toISOString(),
      options.now ?? new Date().toISOString(),
      ftsQuery,
      ...(projectSlugs ?? []),
      limit,
    ]);

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
      score: options.terms?.length
        ? scorePersistedResult({
          title: String(row.conversation_title),
          projectDisplayName: String(row.project_display_name),
          text: String(row.matched_text ?? ''),
          terms: options.terms,
        })
        : 0,
      recencyBucket: conversationSearchRecencyBucketFromIndex(row.recency_bucket),
    }));
  }
}
