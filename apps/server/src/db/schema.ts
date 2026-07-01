import Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  name: string;
  up: (sqlite: Database.Database) => void;
}

function tableColumns(sqlite: Database.Database, tableName: string): Set<string> {
  const rows = sqlite.prepare(`pragma table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumnIfMissing(sqlite: Database.Database, tableName: string, columnName: string, ddl: string): void {
  if (!tableColumns(sqlite, tableName).has(columnName)) {
    sqlite.exec(`alter table ${tableName} add column ${ddl}`);
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-agent-console-schema',
    up(sqlite) {
      sqlite.exec(`
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

      addColumnIfMissing(sqlite, 'bound_sessions', 'last_output_at', 'last_output_at text');
      addColumnIfMissing(sqlite, 'bound_sessions', 'last_completed_at', 'last_completed_at text');
      addColumnIfMissing(sqlite, 'bound_sessions', 'is_working', 'is_working integer not null default 0');
      if (!tableColumns(sqlite, 'bound_sessions').has('should_restore')) {
        sqlite.exec(`alter table bound_sessions add column should_restore integer not null default 0`);
        sqlite.exec(`
          update bound_sessions
          set should_restore = 1
          where status in ('starting', 'bound', 'releasing')
        `);
      }
      if (!tableColumns(sqlite, 'bound_sessions').has('resume_conversation_ref')) {
        sqlite.exec(`alter table bound_sessions add column resume_conversation_ref text`);
        sqlite.exec(`
          update bound_sessions
          set resume_conversation_ref = conversation_ref
          where resume_conversation_ref is null
            and conversation_ref not like 'pending:%'
        `);
      }
    },
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists schema_version (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
  `);

  const appliedVersions = new Set((sqlite.prepare(`select version from schema_version`).all() as Array<{ version: number }>)
    .map((row) => row.version));
  const highestApplied = Math.max(0, ...appliedVersions);
  if (highestApplied > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database schema version ${highestApplied} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`);
  }

  const insertVersion = sqlite.prepare(`
    insert into schema_version (version, name, applied_at)
    values (?, ?, ?)
  `);
  const apply = sqlite.transaction((migrations: Migration[]) => {
    for (const migration of migrations) {
      migration.up(sqlite);
      insertVersion.run(migration.version, migration.name, new Date().toISOString());
    }
  });
  apply(MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version)));
}
