import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { AppDatabase } from '../src/db/database.js';

describe('search index compaction (2026-11-01)', () => {
  it('runs a bounded FTS5 merge after a batch of writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-fts-merge-'));
    const db = new AppDatabase(path.join(dir, 'agent-console.sqlite'));
    const statements: string[] = [];
    const prepare = db.sqlite.prepare.bind(db.sqlite);
    (db.sqlite as unknown as { prepare: (sql: string) => Database.Statement }).prepare = (sql: string) => {
      statements.push(sql); return prepare(sql);
    };
    for (let index = 0; index < 50; index += 1) db.searchIndex.deleteConversation('p', 'codex', `ref-${index}`);
    expect(statements.filter((sql) => sql.includes("values('merge'")).length).toBe(1);
    db.close();
  });
});
