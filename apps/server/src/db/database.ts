import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BoundSession, ConversationSummary } from '@agent-console/shared';

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

function boolAsInt(value: boolean): number {
  return value ? 1 : 0;
}

function pickPreferredConversation(existing: ConversationSummary | undefined, candidate: ConversationSummary): ConversationSummary {
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
    if (!boundSessionColumns.some((column) => column.name === 'current_model')) {
      this.sqlite.exec(`alter table bound_sessions add column current_model text`);
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
    for (const item of items) {
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
        on bs.project_slug = ci.project_slug and bs.provider = ci.provider and bs.conversation_ref = ci.ref and bs.should_restore = 1
      order by ci.updated_at desc
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
        on bs.project_slug = ci.project_slug and bs.provider = ci.provider and bs.conversation_ref = ci.ref and bs.should_restore = 1
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
      order by pc.updated_at desc
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
        started_at, updated_at, last_activity_at, last_output_at, last_completed_at, is_working, pid, raw_log_path, event_log_path, current_model
      ) values (
        @id, @provider, @project_slug, @conversation_ref, @resume_conversation_ref, @tmux_session_name, @status, @should_restore, @title,
        @started_at, @updated_at, @last_activity_at, @last_output_at, @last_completed_at, @is_working, @pid, @raw_log_path, @event_log_path, @current_model
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
        event_log_path = excluded.event_log_path,
        current_model = coalesce(excluded.current_model, bound_sessions.current_model)
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
      current_model: session.currentModel ?? null,
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
    currentModel: row.current_model ? String(row.current_model) : undefined,
    pid: typeof row.pid === 'number' ? row.pid : row.pid ? Number(row.pid) : undefined,
    rawLogPath: row.raw_log_path ? String(row.raw_log_path) : undefined,
    eventLogPath: row.event_log_path ? String(row.event_log_path) : undefined,
  });
}
