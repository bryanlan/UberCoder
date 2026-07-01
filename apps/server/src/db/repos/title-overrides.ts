import Database from 'better-sqlite3';

export interface ConversationTitleOverride {
  title: string;
  updatedAt: string;
}

export class TitleOverridesRepo {
  constructor(private readonly sqlite: Database.Database) {}

  set(projectSlug: string, provider: string, ref: string, title: string, updatedAt: string): void {
    this.sqlite.prepare(`
      insert into conversation_title_overrides (project_slug, provider, ref, title, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(project_slug, provider, ref) do update set
        title = excluded.title,
        updated_at = excluded.updated_at
    `).run(projectSlug, provider, ref, title, updatedAt);
  }

  get(projectSlug: string, provider: string, ref: string): ConversationTitleOverride | undefined {
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

  delete(projectSlug: string, provider: string, ref: string): void {
    this.sqlite.prepare(`
      delete from conversation_title_overrides
      where project_slug = ? and provider = ? and ref = ?
    `).run(projectSlug, provider, ref);
  }
}
