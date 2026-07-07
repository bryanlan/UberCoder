import Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 4;

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
  {
    version: 2,
    name: 'transcript-parse-cache-and-search-index-state',
    up(sqlite) {
      sqlite.exec(`
        create table if not exists transcript_parse_cache (
          path text primary key,
          size integer not null,
          mtime_ms real not null,
          scope text not null,
          summary_json text,
          project_paths_json text not null,
          authoritative_project_paths_json text not null,
          updated_at text not null
        );

        create table if not exists conversation_search_state (
          project_slug text not null,
          provider text not null,
          ref text not null,
          transcript_path text,
          size integer,
          mtime_ms real,
          primary key (project_slug, provider, ref)
        );
      `);
    },
  },
  {
    version: 3,
    name: 'parse-cache-parser-version-and-search-state-reconciliation',
    up(sqlite) {
      // Default matches the current TRANSCRIPT_PARSER_VERSION so rows written by
      // the same parser stay valid; future parser changes bump the constant and
      // naturally miss these rows.
      addColumnIfMissing(sqlite, 'transcript_parse_cache', 'parser_version', 'parser_version integer not null default 1');
      // Incremental search indexing purges vanished conversations via
      // conversation_search_state; FTS rows indexed before that table existed
      // have no state row and would otherwise never be reconciled.
      sqlite.exec(`
        delete from conversation_search_fts
        where not exists (
          select 1
          from conversation_search_state s
          where s.project_slug = conversation_search_fts.project_slug
            and s.provider = conversation_search_fts.provider
            and s.ref = conversation_search_fts.conversation_ref
        );
      `);
    },
  },
  {
    version: 4,
    name: 'drop-session-interaction-summaries',
    up(sqlite) {
      sqlite.exec(`drop table if exists session_interaction_summaries;`);
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
