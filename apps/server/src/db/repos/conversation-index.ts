import Database from 'better-sqlite3';
import type { ConversationSummary } from '@agent-console/shared';
import { treeVisibleBoundSessionSql } from '../../lib/bound-session-state.js';
import { isConversationVisibleInDiscovery } from '../../lib/conversation-visibility.js';
import { boolAsInt, optionalString, parseJson, type SqliteRow } from '../utils.js';

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

export class ConversationIndexRepo {
  constructor(private readonly sqlite: Database.Database) {}

  replace(projectSlug: string, provider: string, items: ConversationSummary[]): void {
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

  list(): ConversationSummary[] {
    const rows = this.sqlite.prepare(`
      select ci.*, cto.title as override_title, bs.id as bound_session_id
      from conversation_index ci
      left join conversation_title_overrides cto
        on cto.project_slug = ci.project_slug and cto.provider = ci.provider and cto.ref = ci.ref
      left join bound_sessions bs
        on bs.project_slug = ci.project_slug
        and bs.provider = ci.provider
        and bs.conversation_ref = ci.ref
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
      order by coalesce(ci.created_at, ci.updated_at) desc, ci.ref asc
    `).all() as SqliteRow[];
    return rows.map(mapConversationIndexRow);
  }

  get(projectSlug: string, provider: string, ref: string): ConversationSummary | undefined {
    const row = this.sqlite.prepare(`
      select ci.*, cto.title as override_title, bs.id as bound_session_id
      from conversation_index ci
      left join conversation_title_overrides cto
        on cto.project_slug = ci.project_slug and cto.provider = ci.provider and cto.ref = ci.ref
      left join bound_sessions bs
        on bs.project_slug = ci.project_slug
        and bs.provider = ci.provider
        and bs.conversation_ref = ci.ref
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
      where ci.project_slug = ? and ci.provider = ? and ci.ref = ?
      limit 1
    `).get(projectSlug, provider, ref) as SqliteRow | undefined;
    return row ? mapConversationIndexRow(row) : undefined;
  }

  hasRows(): boolean {
    const row = this.sqlite.prepare(`select 1 from conversation_index limit 1`).get() as { 1: number } | undefined;
    return Boolean(row);
  }
}

function mapConversationIndexRow(row: SqliteRow): ConversationSummary {
  return {
    ref: String(row.ref),
    kind: row.kind === 'pending' ? 'pending' : 'history',
    projectSlug: String(row.project_slug),
    provider: String(row.provider) as ConversationSummary['provider'],
    title: String(row.override_title ?? row.title),
    excerpt: optionalString(row.excerpt),
    createdAt: optionalString(row.created_at),
    updatedAt: String(row.updated_at),
    transcriptPath: optionalString(row.transcript_path),
    providerConversationId: optionalString(row.provider_conversation_id),
    branch: optionalString(row.branch),
    isBound: Boolean(row.bound_session_id),
    boundSessionId: optionalString(row.bound_session_id),
    degraded: Boolean(row.degraded),
    rawMetadata: parseJson<Record<string, unknown>>(optionalString(row.raw_metadata_json)),
  };
}
