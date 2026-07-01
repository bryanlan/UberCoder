import Database from 'better-sqlite3';
import { optionalString, type SqliteRow } from '../utils.js';

export interface AuthSessionRecord {
  id: string;
  userLogin?: string;
  displayName?: string;
  via: 'password' | 'tailscale';
  csrfToken: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
}

export class AuthSessionsRepo {
  constructor(private readonly sqlite: Database.Database) {}

  upsert(input: AuthSessionRecord): void {
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

  get(id: string): AuthSessionRecord | undefined {
    const row = this.sqlite.prepare(`select * from auth_sessions where id = ?`).get(id) as SqliteRow | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      userLogin: optionalString(row.user_login),
      displayName: optionalString(row.display_name),
      via: row.via === 'tailscale' ? 'tailscale' : 'password',
      csrfToken: String(row.csrf_token),
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      lastSeenAt: String(row.last_seen_at),
    };
  }

  delete(id: string): void {
    this.sqlite.prepare(`delete from auth_sessions where id = ?`).run(id);
  }

  deleteExpired(nowIso: string): void {
    this.sqlite.prepare(`delete from auth_sessions where expires_at <= ?`).run(nowIso);
  }
}
