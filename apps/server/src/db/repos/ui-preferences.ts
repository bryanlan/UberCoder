import Database from 'better-sqlite3';
import { parseJson } from '../utils.js';

export class UiPreferencesRepo {
  constructor(private readonly sqlite: Database.Database) {}

  get<T>(key: string): T | undefined {
    const row = this.sqlite.prepare(`select value from ui_preferences where key = ?`).get(key) as { value: string } | undefined;
    return row ? parseJson<T>(row.value) : undefined;
  }

  set(key: string, value: unknown): void {
    this.sqlite.prepare(`
      insert into ui_preferences (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value
    `).run(key, JSON.stringify(value));
  }
}
