import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AppDatabase, type ConversationSearchIndexChunk } from '../src/db/database.js';
import { migrateDatabase } from '../src/db/schema.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-rows-'));
  const db = new AppDatabase(path.join(root, 'fixture.sqlite'));
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return db;
}
function chunk(ref: string, projectSlug = 'demo', provider: 'codex' | 'claude' = 'codex'): ConversationSearchIndexChunk {
  return { projectSlug, provider, projectDisplayName: projectSlug, projectTags: [], conversationRef: ref,
    conversationKind: 'history', conversationTitle: ref, conversationUpdatedAt: new Date().toISOString(),
    isBound: false, messageId: ref, role: 'assistant', timestamp: new Date().toISOString(), text: 'preserved searchable evidence' };
}
function assertOwnership(db: AppDatabase) {
  expect(db.sqlite.prepare(`select rowid,project_slug,provider,conversation_ref from conversation_search_fts order by rowid`).all())
    .toEqual(db.sqlite.prepare(`select fts_rowid as rowid,project_slug,provider,conversation_ref from conversation_search_rows order by fts_rowid`).all());
}
it('migrates version 14 without replacing FTS rows or durable application state', () => {
  const db = fixture();
  db.searchIndex.replace('demo', 'codex', [chunk('a'), chunk('b')]);
  db.meta.set('peer-wake-attempt:message', '{"status":"submitted"}');
  db.sqlite.prepare('insert into coordination_assignments values(?,?,?,?,?,?,?,?,?,?)')
    .run('agent', 'codex', 'native', 'credential-hash', 'unfinished', 'waiting', 1, 'start', 'before', 'before');
  db.sqlite.prepare('insert into coordination_messages values(?,?,?,?,?,?,?)')
    .run('message', 'agent', 'agent', 'private peer data', 'before', null, null);
  const before = db.sqlite.prepare('select rowid,* from conversation_search_fts order by rowid').all();
  const messages = db.sqlite.prepare('select * from coordination_messages').all();
  db.sqlite.exec('drop table conversation_search_rows; delete from schema_version where version=15');
  migrateDatabase(db.sqlite);
  migrateDatabase(db.sqlite);
  expect(db.sqlite.prepare('select rowid,* from conversation_search_fts order by rowid').all()).toEqual(before);
  expect(db.sqlite.prepare('select * from coordination_messages').all()).toEqual(messages);
  expect(db.meta.get('peer-wake-attempt:message')).toBe('{"status":"submitted"}');
  expect(db.searchIndex.search('evidence', 10)).toHaveLength(2);
  assertOwnership(db);
});
it('uses indexed identity and FTS rowid lookups instead of scanning FTS metadata', () => {
  const db = fixture();
  const plan = db.sqlite.prepare(`explain query plan select rowid from conversation_search_fts where rowid in
    (select fts_rowid from conversation_search_rows where project_slug=? and provider=? and conversation_ref=?)`)
    .all('demo', 'codex', 'a') as { detail: string }[];
  expect(plan.map((r) => r.detail).join('\n')).toContain('conversation_search_rows_identity');
  expect(plan.find((r) => r.detail.includes('VIRTUAL TABLE'))?.detail).toContain('INDEX 0:=');
});
it('keeps ownership and unrelated scopes intact through every search write path', () => {
  const db = fixture();
  db.searchIndex.replace('demo', 'codex', [chunk('a'), chunk('b')]);
  db.searchIndex.replace('other', 'claude', [chunk('outside', 'other', 'claude')]);
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [chunk('a'), { ...chunk('a'), messageId: 'a2' }], { size: 2 });
  assertOwnership(db);
  db.searchIndex.updateTitle('demo', 'codex', 'a', 'renamed');
  db.searchIndex.updateProjectMetadata({ projectSlug: 'demo', displayName: 'new display', path: '/new', tags: ['tag'] });
  expect(db.searchIndex.search('evidence', 10).find((r) => r.conversationRef === 'a'))
    .toMatchObject({ conversationTitle: 'renamed', projectDisplayName: 'new display' });
  db.searchIndex.deleteConversation('demo', 'codex', 'a');
  assertOwnership(db);
  expect(db.searchIndex.getConversationStates('demo', 'codex').has('a')).toBe(false);
  db.searchIndex.replace('demo', 'codex', []);
  assertOwnership(db);
  expect(db.searchIndex.hasRowsFor('demo', 'codex')).toBe(false);
  expect(db.searchIndex.hasRowsFor('other', 'claude')).toBe(true);
  expect(db.searchIndex.search('evidence', 10).map((r) => r.conversationRef)).toEqual(['outside']);
});
it('rolls back FTS, mapping and file state together when an insert fails', () => {
  const db = fixture();
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [chunk('a')], { size: 1 });
  const before = db.sqlite.prepare('select rowid,* from conversation_search_fts').all();
  db.sqlite.exec(`create trigger reject_new_mapping before insert on conversation_search_rows
    begin select raise(abort,'fixture insert rejected'); end`);
  expect(() => db.searchIndex.replaceConversation('demo', 'codex', 'a', [chunk('a')], { size: 2 })).toThrow('fixture insert rejected');
  expect(db.sqlite.prepare('select rowid,* from conversation_search_fts').all()).toEqual(before);
  expect(db.searchIndex.getConversationStates('demo', 'codex').get('a')?.size).toBe(1);
  assertOwnership(db);
});
