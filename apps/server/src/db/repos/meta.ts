import Database from 'better-sqlite3';

export class MetaRepo {
  constructor(private readonly sqlite: Database.Database) {}

  set(key: string, value: string): void {
    this.sqlite.prepare(`
      insert into meta (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value
    `).run(key, value);
  }

  get(key: string): string | undefined {
    const row = this.sqlite.prepare(`select value from meta where key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  }
}
