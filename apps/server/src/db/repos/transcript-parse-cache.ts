import Database from 'better-sqlite3';
import type { ConversationSummary } from '@agent-console/shared';
import { nowIso } from '../../lib/time.js';
import { TRANSCRIPT_PARSER_VERSION, type TranscriptParseCache, type TranscriptParseCacheEntry } from '../../providers/types.js';
import { optionalString, parseJson, type SqliteRow } from '../utils.js';

export class TranscriptParseCacheRepo implements TranscriptParseCache {
  private readonly getStatement: Database.Statement;
  private readonly putStatement: Database.Statement;
  private readonly retainStatement: Database.Statement;

  constructor(sqlite: Database.Database) {
    this.getStatement = sqlite.prepare(`
      select scope, summary_json, project_paths_json, authoritative_project_paths_json
      from transcript_parse_cache
      where path = ? and size = ? and mtime_ms = ? and parser_version = ?
    `);
    this.putStatement = sqlite.prepare(`
      insert into transcript_parse_cache (
        path, size, mtime_ms, parser_version, scope, summary_json,
        project_paths_json, authoritative_project_paths_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(path) do update set
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        parser_version = excluded.parser_version,
        scope = excluded.scope,
        summary_json = excluded.summary_json,
        project_paths_json = excluded.project_paths_json,
        authoritative_project_paths_json = excluded.authoritative_project_paths_json,
        updated_at = excluded.updated_at
    `);
    this.retainStatement = sqlite.prepare(`
      delete from transcript_parse_cache
      where path like ? escape '\\' and path not in (select value from json_each(?))
    `);
  }

  get(path: string, size: number, mtimeMs: number): TranscriptParseCacheEntry | undefined {
    const row = this.getStatement.get(path, size, mtimeMs, TRANSCRIPT_PARSER_VERSION) as SqliteRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      scope: row.scope === 'full' ? 'full' : 'head',
      summary: parseJson<ConversationSummary>(optionalString(row.summary_json)),
      projectPaths: parseJson<string[]>(optionalString(row.project_paths_json)) ?? [],
      authoritativeProjectPaths: parseJson<string[]>(optionalString(row.authoritative_project_paths_json)) ?? [],
    };
  }

  put(path: string, size: number, mtimeMs: number, entry: TranscriptParseCacheEntry): void {
    this.putStatement.run(
      path,
      size,
      mtimeMs,
      TRANSCRIPT_PARSER_VERSION,
      entry.scope,
      entry.summary ? JSON.stringify(entry.summary) : null,
      JSON.stringify(entry.projectPaths),
      JSON.stringify(entry.authoritativeProjectPaths),
      nowIso(),
    );
  }

  retainUnderPrefix(directoryPrefix: string, keepPaths: Iterable<string>): void {
    const likePattern = `${directoryPrefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    this.retainStatement.run(likePattern, JSON.stringify([...keepPaths]));
  }
}
