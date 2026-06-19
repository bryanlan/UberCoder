import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CONVERSATION_SEARCH_RECENCY_BUCKETS, type BoundSession, type ConversationSearchRecencyBucket, type ConversationSearchResult, type ConversationSummary, type ProviderId, type SessionInteractionSummary } from '@agent-console/shared';
import { treeVisibleBoundSessionSql } from '../lib/bound-session-state.js';
import { isConversationVisibleInDiscovery } from '../lib/conversation-visibility.js';

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

function boolAsInt(value: boolean): number {
  return value ? 1 : 0;
}

function conversationSearchRecencyBucketFromIndex(value: unknown): ConversationSearchRecencyBucket {
  const index = Number(value);
  if (Number.isInteger(index) && index >= 0 && index < CONVERSATION_SEARCH_RECENCY_BUCKETS.length) {
    return CONVERSATION_SEARCH_RECENCY_BUCKETS[index]!;
  }
  return '60-plus-days';
}

export function pickPreferredConversation(existing: ConversationSummary | undefined, candidate: ConversationSummary): ConversationSummary {
  if (!existing) return candidate;

  const existingTime = Date.parse(existing.updatedAt);
  const candidateTime = Date.parse(candidate.updatedAt);
  if (Number.isFinite(existingTime) && Number.isFinite(candidateTime) && existingTime !== candidateTime) {
    return candidateTime > existingTime ? candidate : existing;
  }

  if (existing.degraded !== candidate.degraded) {
    return existing.degraded ? candidate : existing;
  }

  if (!existing.transcriptPath && candidate.transcriptPath) {
    return candidate;
  }

  return existing;
}

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

export class AppDatabase {
  readonly sqlite: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.sqlite = new Database(databasePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      create table if not exists meta (
        key text primary key,
        value text not null
      );

      create table if not exists conversation_index (
        project_slug text not null,
        provider text not null,
        ref text not null,
        kind text not null,
        title text not null,
        excerpt text,
        created_at text,
        updated_at text not null,
        transcript_path text,
        provider_conversation_id text,
        branch text,
        degraded integer not null default 0,
        raw_metadata_json text,
        primary key (project_slug, provider, ref)
      );

      create table if not exists conversation_title_overrides (
        project_slug text not null,
        provider text not null,
        ref text not null,
        title text not null,
        updated_at text not null,
        primary key (project_slug, provider, ref)
      );

      create table if not exists bound_sessions (
        id text primary key,
        provider text not null,
        project_slug text not null,
        conversation_ref text not null,
        resume_conversation_ref text,
        tmux_session_name text not null,
        status text not null,
        should_restore integer not null default 0,
        title text,
        started_at text not null,
        updated_at text not null,
        last_activity_at text,
        last_output_at text,
        last_completed_at text,
        is_working integer not null default 0,
        pid integer,
        raw_log_path text,
        event_log_path text
      );

      create table if not exists auth_sessions (
        id text primary key,
        user_login text,
        display_name text,
        via text not null,
        csrf_token text not null,
        expires_at text not null,
        created_at text not null,
        last_seen_at text not null
      );

      create table if not exists pending_conversations (
        ref text primary key,
        project_slug text not null,
        provider text not null,
        title text not null,
        created_at text not null,
        updated_at text not null,
        bound_session_id text,
        transcript_path text,
        degraded integer not null default 0,
        raw_metadata_json text
      );

      create table if not exists ui_preferences (
        key text primary key,
        value text not null
      );

      create table if not exists session_interaction_summaries (
        session_id text primary key,
        project_slug text not null,
        provider text not null,
        conversation_ref text not null,
        status text not null,
        chat_summary text,
        recent_changes_summary text,
        generated_at text,
        window_start_at text,
        window_end_at text,
        last_interaction_at text,
        failed_at text,
        last_error text,
        title_suggestion text,
        title_suggested_at text
      );

      create virtual table if not exists conversation_search_fts using fts5(
        conversation_title unindexed,
        project_display_name unindexed,
        project_tags unindexed,
        text,
        project_slug unindexed,
        project_path unindexed,
        provider unindexed,
        conversation_ref unindexed,
        conversation_kind unindexed,
        conversation_updated_at unindexed,
        is_bound unindexed,
        message_id unindexed,
        role unindexed,
        timestamp unindexed,
        tokenize='unicode61'
      );
    `);

    const boundSessionColumns = this.sqlite.prepare(`pragma table_info(bound_sessions)`).all() as Array<{ name: string }>;
    if (!boundSessionColumns.some((column) => column.name === 'last_output_at')) {
      this.sqlite.exec(`alter table bound_sessions add column last_output_at text`);
    }
    if (!boundSessionColumns.some((column) => column.name === 'last_completed_at')) {
      this.sqlite.exec(`alter table bound_sessions add column last_completed_at text`);
    }
    if (!boundSessionColumns.some((column) => column.name === 'is_working')) {
      this.sqlite.exec(`alter table bound_sessions add column is_working integer not null default 0`);
    }
    if (!boundSessionColumns.some((column) => column.name === 'should_restore')) {
      this.sqlite.exec(`alter table bound_sessions add column should_restore integer not null default 0`);
      this.sqlite.exec(`
        update bound_sessions
        set should_restore = 1
        where status in ('starting', 'bound', 'releasing')
      `);
    }
    if (!boundSessionColumns.some((column) => column.name === 'resume_conversation_ref')) {
      this.sqlite.exec(`alter table bound_sessions add column resume_conversation_ref text`);
      this.sqlite.exec(`
        update bound_sessions
        set resume_conversation_ref = conversation_ref
        where resume_conversation_ref is null
          and conversation_ref not like 'pending:%'
      `);
    }
  }

  setMeta(key: string, value: string): void {
    this.sqlite.prepare(`insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`).run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.sqlite.prepare(`select value from meta where key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  }

  replaceConversationIndex(projectSlug: string, provider: string, items: ConversationSummary[]): void {
    const insert = this.sqlite.prepare(`
      insert into conversation_index (
        project_slug, provider, ref, kind, title, excerpt, created_at, updated_at,
        transcript_path, provider_conversation_id, branch, degraded, raw_metadata_json
      ) values (
        @project_slug, @provider, @ref, @kind, @title, @excerpt, @created_at, @updated_at,
        @transcript_path, @provider_conversation_id, @branch, @degraded, @raw_metadata_json
      )
    `);
    const clear = this.sqlite.prepare(`delete from conversation_index where project_slug = ? and provider = ?`);
    const deduped = new Map<string, ConversationSummary>();
    for (const item of items.filter(isConversationVisibleInDiscovery)) {
      deduped.set(item.ref, pickPreferredConversation(deduped.get(item.ref), item));
    }
    const tx = this.sqlite.transaction(() => {
      clear.run(projectSlug, provider);
      for (const item of deduped.values()) {
        insert.run({
          project_slug: item.projectSlug,
          provider: item.provider,
          ref: item.ref,
          kind: item.kind,
          title: item.title,
          excerpt: item.excerpt ?? null,
          created_at: item.createdAt ?? null,
          updated_at: item.updatedAt,
          transcript_path: item.transcriptPath ?? null,
          provider_conversation_id: item.providerConversationId ?? null,
          branch: item.branch ?? null,
          degraded: boolAsInt(item.degraded),
          raw_metadata_json: item.rawMetadata ? JSON.stringify(item.rawMetadata) : null,
        });
      }
    });
    tx();
  }

  listConversationIndex(): ConversationSummary[] {
    const rows = this.sqlite.prepare(`
      select ci.*, cto.title as override_title, bs.id as bound_session_id
      from conversation_index ci
      left join conversation_title_overrides cto
        on cto.project_slug = ci.project_slug and cto.provider = ci.provider and cto.ref = ci.ref
      left join bound_sessions bs
        on bs.project_slug = ci.project_slug and bs.provider = ci.provider and bs.conversation_ref = ci.ref and ${treeVisibleBoundSessionSql('bs')}
      order by coalesce(ci.created_at, ci.updated_at) desc, ci.ref asc
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ref: String(row.ref),
      kind: row.kind === 'pending' ? 'pending' : 'history',
      projectSlug: String(row.project_slug),
      provider: String(row.provider) as ConversationSummary['provider'],
      title: String(row.override_title ?? row.title),
      excerpt: row.excerpt ? String(row.excerpt) : undefined,
      createdAt: row.created_at ? String(row.created_at) : undefined,
      updatedAt: String(row.updated_at),
      transcriptPath: row.transcript_path ? String(row.transcript_path) : undefined,
      providerConversationId: row.provider_conversation_id ? String(row.provider_conversation_id) : undefined,
      branch: row.branch ? String(row.branch) : undefined,
      isBound: Boolean(row.bound_session_id),
      boundSessionId: row.bound_session_id ? String(row.bound_session_id) : undefined,
      degraded: Boolean(row.degraded),
      rawMetadata: parseJson<Record<string, unknown>>(row.raw_metadata_json ? String(row.raw_metadata_json) : null),
    }));
  }

  getConversationIndexEntry(projectSlug: string, provider: string, ref: string): ConversationSummary | undefined {
    const row = this.sqlite.prepare(`
      select ci.*, cto.title as override_title, bs.id as bound_session_id
      from conversation_index ci
      left join conversation_title_overrides cto
        on cto.project_slug = ci.project_slug and cto.provider = ci.provider and cto.ref = ci.ref
      left join bound_sessions bs
        on bs.project_slug = ci.project_slug and bs.provider = ci.provider and bs.conversation_ref = ci.ref and ${treeVisibleBoundSessionSql('bs')}
      where ci.project_slug = ? and ci.provider = ? and ci.ref = ?
      limit 1
    `).get(projectSlug, provider, ref) as Record<string, unknown> | undefined;
    return row ? {
      ref: String(row.ref),
      kind: row.kind === 'pending' ? 'pending' : 'history',
      projectSlug: String(row.project_slug),
      provider: String(row.provider) as ConversationSummary['provider'],
      title: String(row.override_title ?? row.title),
      excerpt: row.excerpt ? String(row.excerpt) : undefined,
      createdAt: row.created_at ? String(row.created_at) : undefined,
      updatedAt: String(row.updated_at),
      transcriptPath: row.transcript_path ? String(row.transcript_path) : undefined,
      providerConversationId: row.provider_conversation_id ? String(row.provider_conversation_id) : undefined,
      branch: row.branch ? String(row.branch) : undefined,
      isBound: Boolean(row.bound_session_id),
      boundSessionId: row.bound_session_id ? String(row.bound_session_id) : undefined,
      degraded: Boolean(row.degraded),
      rawMetadata: parseJson<Record<string, unknown>>(row.raw_metadata_json ? String(row.raw_metadata_json) : null),
    } : undefined;
  }

  hasConversationIndexRows(): boolean {
    const row = this.sqlite.prepare(`select 1 from conversation_index limit 1`).get() as { 1: number } | undefined;
    return Boolean(row);
  }

  hasConversationSearchIndexRows(): boolean {
    const row = this.sqlite.prepare(`select 1 from conversation_search_fts limit 1`).get() as { 1: number } | undefined;
    return Boolean(row);
  }

  hasConversationSearchIndexRowsFor(projectSlug: string, provider: ProviderId): boolean {
    const row = this.sqlite.prepare(`
      select 1
      from conversation_search_fts
      where project_slug = ? and provider = ?
      limit 1
    `).get(projectSlug, provider) as { 1: number } | undefined;
    return Boolean(row);
  }

  replaceConversationSearchIndex(projectSlug: string, provider: ProviderId, chunks: ConversationSearchIndexChunk[]): void {
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

  updateConversationSearchTitle(projectSlug: string, provider: ProviderId, conversationRef: string, title: string): void {
    this.sqlite.prepare(`
      update conversation_search_fts
      set conversation_title = ?
      where project_slug = ? and provider = ? and conversation_ref = ?
    `).run(title, projectSlug, provider, conversationRef);
  }

  updateConversationSearchProjectMetadata(input: {
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

  searchConversationIndex(ftsQuery: string, limit: number, options: { projectSlugs?: string[]; now?: string } = {}): ConversationSearchResult[] {
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
    ) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      projectSlug: String(row.project_slug),
      projectDisplayName: String(row.project_display_name),
      projectPath: row.project_path ? String(row.project_path) : undefined,
      provider: String(row.provider) as ProviderId,
      conversationRef: String(row.conversation_ref),
      conversationKind: row.conversation_kind === 'pending' ? 'pending' : 'history',
      conversationTitle: String(row.conversation_title),
      conversationUpdatedAt: String(row.conversation_updated_at),
      isBound: Boolean(row.bound_session_id) || Boolean(Number(row.is_bound)),
      role: row.role === 'user' ? 'user' : 'assistant',
      timestamp: String(row.timestamp),
      snippet: String(row.snippet ?? ''),
      score: -Number(row.rank ?? 0) * 1_000_000,
      recencyBucket: conversationSearchRecencyBucketFromIndex(row.recency_bucket),
    }));
  }

  setConversationTitleOverride(projectSlug: string, provider: string, ref: string, title: string, updatedAt: string): void {
    this.sqlite.prepare(`
      insert into conversation_title_overrides (project_slug, provider, ref, title, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(project_slug, provider, ref) do update set
        title = excluded.title,
        updated_at = excluded.updated_at
    `).run(projectSlug, provider, ref, title, updatedAt);
  }

  getConversationTitleOverride(projectSlug: string, provider: string, ref: string): { title: string; updatedAt: string } | undefined {
    const row = this.sqlite.prepare(`
      select title, updated_at
      from conversation_title_overrides
      where project_slug = ? and provider = ? and ref = ?
      limit 1
    `).get(projectSlug, provider, ref) as { title: string; updated_at: string } | undefined;
    if (!row) return undefined;
    return {
      title: row.title,
      updatedAt: row.updated_at,
    };
  }

  deleteConversationTitleOverride(projectSlug: string, provider: string, ref: string): void {
    this.sqlite.prepare(`
      delete from conversation_title_overrides
      where project_slug = ? and provider = ? and ref = ?
    `).run(projectSlug, provider, ref);
  }

  putPendingConversation(item: ConversationSummary): void {
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

  listPendingConversations(): ConversationSummary[] {
    const rows = this.sqlite.prepare(`
      select pc.*, cto.title as override_title, bs.id as bound_session_id
      from pending_conversations pc
      left join conversation_title_overrides cto
        on cto.project_slug = pc.project_slug and cto.provider = pc.provider and cto.ref = pc.ref
      left join bound_sessions bs on bs.id = pc.bound_session_id and bs.should_restore = 1
      order by coalesce(pc.created_at, pc.updated_at) desc, pc.ref asc
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ref: String(row.ref),
      kind: 'pending',
      projectSlug: String(row.project_slug),
      provider: String(row.provider) as ConversationSummary['provider'],
      title: String(row.override_title ?? row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      transcriptPath: row.transcript_path ? String(row.transcript_path) : undefined,
      excerpt: undefined,
      isBound: Boolean(row.bound_session_id),
      boundSessionId: row.bound_session_id ? String(row.bound_session_id) : undefined,
      degraded: Boolean(row.degraded),
      rawMetadata: parseJson<Record<string, unknown>>(row.raw_metadata_json ? String(row.raw_metadata_json) : null),
    }));
  }

  getPendingConversation(ref: string): ConversationSummary | undefined {
    const row = this.sqlite.prepare(`
      select pc.*, cto.title as override_title, bs.id as bound_session_id
      from pending_conversations pc
      left join conversation_title_overrides cto
        on cto.project_slug = pc.project_slug and cto.provider = pc.provider and cto.ref = pc.ref
      left join bound_sessions bs on bs.id = pc.bound_session_id and bs.should_restore = 1
      where pc.ref = ?
      limit 1
    `).get(ref) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      ref: String(row.ref),
      kind: 'pending',
      projectSlug: String(row.project_slug),
      provider: String(row.provider) as ConversationSummary['provider'],
      title: String(row.override_title ?? row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      transcriptPath: row.transcript_path ? String(row.transcript_path) : undefined,
      excerpt: undefined,
      isBound: Boolean(row.bound_session_id),
      boundSessionId: row.bound_session_id ? String(row.bound_session_id) : undefined,
      degraded: Boolean(row.degraded),
      rawMetadata: parseJson<Record<string, unknown>>(row.raw_metadata_json ? String(row.raw_metadata_json) : null),
    };
  }

  deletePendingConversation(ref: string): void {
    this.sqlite.prepare(`delete from pending_conversations where ref = ?`).run(ref);
  }

  upsertBoundSession(session: BoundSession): void {
    const shouldRestore = session.shouldRestore ?? ['starting', 'bound', 'releasing'].includes(session.status);
    const resumeConversationRef = session.resumeConversationRef
      ?? (!session.conversationRef.startsWith('pending:') ? session.conversationRef : undefined);
    this.sqlite.prepare(`
      insert into bound_sessions (
        id, provider, project_slug, conversation_ref, resume_conversation_ref, tmux_session_name, status, should_restore, title,
        started_at, updated_at, last_activity_at, last_output_at, last_completed_at, is_working, pid, raw_log_path, event_log_path
      ) values (
        @id, @provider, @project_slug, @conversation_ref, @resume_conversation_ref, @tmux_session_name, @status, @should_restore, @title,
        @started_at, @updated_at, @last_activity_at, @last_output_at, @last_completed_at, @is_working, @pid, @raw_log_path, @event_log_path
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
      is_working: boolAsInt(Boolean(session.isWorking)),
      pid: session.pid ?? null,
      raw_log_path: session.rawLogPath ?? null,
      event_log_path: session.eventLogPath ?? null,
    });
  }

  listBoundSessions(): BoundSession[] {
    const rows = this.sqlite.prepare(`select * from bound_sessions order by updated_at desc`).all() as Array<Record<string, unknown>>;
    return rows.map(this.mapBoundSessionRow);
  }

  getBoundSessionById(id: string): BoundSession | undefined {
    const row = this.sqlite.prepare(`select * from bound_sessions where id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapBoundSessionRow(row) : undefined;
  }

  getBoundSessionByConversation(projectSlug: string, provider: string, conversationRef: string): BoundSession | undefined {
    const row = this.sqlite.prepare(`
      select * from bound_sessions
      where project_slug = ? and provider = ? and conversation_ref = ? and should_restore = 1
      order by updated_at desc
      limit 1
    `).get(projectSlug, provider, conversationRef) as Record<string, unknown> | undefined;
    return row ? this.mapBoundSessionRow(row) : undefined;
  }

  getRestorableSessionByConversation(projectSlug: string, provider: string, conversationRef: string): BoundSession | undefined {
    const row = this.sqlite.prepare(`
      select * from bound_sessions
      where project_slug = ? and provider = ? and conversation_ref = ? and should_restore = 1
      order by updated_at desc
      limit 1
    `).get(projectSlug, provider, conversationRef) as Record<string, unknown> | undefined;
    return row ? this.mapBoundSessionRow(row) : undefined;
  }

  deleteBoundSession(id: string): void {
    this.sqlite.prepare(`delete from bound_sessions where id = ?`).run(id);
  }

  upsertAuthSession(input: {
    id: string;
    userLogin?: string;
    displayName?: string;
    via: 'password' | 'tailscale';
    csrfToken: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
  }): void {
    this.sqlite.prepare(`
      insert into auth_sessions (id, user_login, display_name, via, csrf_token, expires_at, created_at, last_seen_at)
      values (@id, @user_login, @display_name, @via, @csrf_token, @expires_at, @created_at, @last_seen_at)
      on conflict(id) do update set
        user_login = excluded.user_login,
        display_name = excluded.display_name,
        via = excluded.via,
        csrf_token = excluded.csrf_token,
        expires_at = excluded.expires_at,
        last_seen_at = excluded.last_seen_at
    `).run({
      id: input.id,
      user_login: input.userLogin ?? null,
      display_name: input.displayName ?? null,
      via: input.via,
      csrf_token: input.csrfToken,
      expires_at: input.expiresAt,
      created_at: input.createdAt,
      last_seen_at: input.lastSeenAt,
    });
  }

  getAuthSession(id: string): {
    id: string;
    userLogin?: string;
    displayName?: string;
    via: 'password' | 'tailscale';
    csrfToken: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
  } | undefined {
    const row = this.sqlite.prepare(`select * from auth_sessions where id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      userLogin: row.user_login ? String(row.user_login) : undefined,
      displayName: row.display_name ? String(row.display_name) : undefined,
      via: row.via === 'tailscale' ? 'tailscale' : 'password',
      csrfToken: String(row.csrf_token),
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      lastSeenAt: String(row.last_seen_at),
    };
  }

  deleteAuthSession(id: string): void {
    this.sqlite.prepare(`delete from auth_sessions where id = ?`).run(id);
  }

  deleteExpiredAuthSessions(nowIso: string): void {
    this.sqlite.prepare(`delete from auth_sessions where expires_at <= ?`).run(nowIso);
  }

  getUiPreference<T>(key: string): T | undefined {
    const row = this.sqlite.prepare(`select value from ui_preferences where key = ?`).get(key) as { value: string } | undefined;
    return row ? parseJson<T>(row.value) : undefined;
  }

  setUiPreference(key: string, value: unknown): void {
    this.sqlite.prepare(`
      insert into ui_preferences (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  upsertSessionInteractionSummary(input: SessionInteractionSummary & {
    titleSuggestion?: string;
    titleSuggestedAt?: string;
    lastError?: string;
  }): void {
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

  getSessionInteractionSummary(sessionId: string): (SessionInteractionSummary & {
    titleSuggestion?: string;
    titleSuggestedAt?: string;
    lastError?: string;
  }) | undefined {
    const row = this.sqlite.prepare(`
      select * from session_interaction_summaries
      where session_id = ?
      limit 1
    `).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapSessionInteractionSummaryRow(row, true) : undefined;
  }

  listSessionInteractionSummariesBySessionIds(sessionIds: string[]): Map<string, SessionInteractionSummary> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = this.sqlite.prepare(`
      select * from session_interaction_summaries
      where session_id in (${placeholders})
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => {
      const summary = this.mapSessionInteractionSummaryRow(row, false);
      return [summary.sessionId, summary];
    }));
  }

  private mapBoundSessionRow = (row: Record<string, unknown>): BoundSession => ({
    id: String(row.id),
    provider: String(row.provider) as BoundSession['provider'],
    projectSlug: String(row.project_slug),
    conversationRef: String(row.conversation_ref),
    resumeConversationRef: row.resume_conversation_ref ? String(row.resume_conversation_ref) : undefined,
    tmuxSessionName: String(row.tmux_session_name),
    status: String(row.status) as BoundSession['status'],
    shouldRestore: Boolean(row.should_restore),
    title: row.title ? String(row.title) : undefined,
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : undefined,
    lastOutputAt: row.last_output_at ? String(row.last_output_at) : undefined,
    lastCompletedAt: row.last_completed_at ? String(row.last_completed_at) : undefined,
    isWorking: Boolean(row.is_working),
    pid: typeof row.pid === 'number' ? row.pid : row.pid ? Number(row.pid) : undefined,
    rawLogPath: row.raw_log_path ? String(row.raw_log_path) : undefined,
    eventLogPath: row.event_log_path ? String(row.event_log_path) : undefined,
  });

  private mapSessionInteractionSummaryRow(
    row: Record<string, unknown>,
    includeInternalFields: true,
  ): SessionInteractionSummary & { titleSuggestion?: string; titleSuggestedAt?: string; lastError?: string };
  private mapSessionInteractionSummaryRow(
    row: Record<string, unknown>,
    includeInternalFields: false,
  ): SessionInteractionSummary;
  private mapSessionInteractionSummaryRow(
    row: Record<string, unknown>,
    includeInternalFields: boolean,
  ): SessionInteractionSummary & { titleSuggestion?: string; titleSuggestedAt?: string; lastError?: string } {
    const summary: SessionInteractionSummary & { titleSuggestion?: string; titleSuggestedAt?: string; lastError?: string } = {
      sessionId: String(row.session_id),
      projectSlug: String(row.project_slug),
      provider: String(row.provider) as SessionInteractionSummary['provider'],
      conversationRef: String(row.conversation_ref),
      status: row.status === 'ready' ? 'ready' : 'failed',
      generatedAt: row.generated_at ? String(row.generated_at) : undefined,
      windowStartAt: row.window_start_at ? String(row.window_start_at) : undefined,
      windowEndAt: row.window_end_at ? String(row.window_end_at) : undefined,
      lastInteractionAt: row.last_interaction_at ? String(row.last_interaction_at) : undefined,
      chatSummary: row.chat_summary ? String(row.chat_summary) : undefined,
      recentChangesSummary: row.recent_changes_summary ? String(row.recent_changes_summary) : undefined,
      failedAt: row.failed_at ? String(row.failed_at) : undefined,
    };

    if (includeInternalFields) {
      summary.lastError = row.last_error ? String(row.last_error) : undefined;
      summary.titleSuggestion = row.title_suggestion ? String(row.title_suggestion) : undefined;
      summary.titleSuggestedAt = row.title_suggested_at ? String(row.title_suggested_at) : undefined;
    }

    return summary;
  }
}
