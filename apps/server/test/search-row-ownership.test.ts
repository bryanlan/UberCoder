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
it('migrates version 14 without replacing FTS rows or durable application state', async () => {
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
  expect((await db.searchIndex.search('evidence', 10))).toHaveLength(2);
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
it('keeps ownership and unrelated scopes intact through every search write path', async () => {
  const db = fixture();
  db.searchIndex.replace('demo', 'codex', [chunk('a'), chunk('b')]);
  db.searchIndex.replace('other', 'claude', [chunk('outside', 'other', 'claude')]);
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [chunk('a'), { ...chunk('a'), messageId: 'a2' }], { size: 2 });
  assertOwnership(db);
  db.searchIndex.updateTitle('demo', 'codex', 'a', 'renamed');
  db.searchIndex.updateProjectMetadata({ projectSlug: 'demo', displayName: 'new display', path: '/new', tags: ['tag'] });
  expect((await db.searchIndex.search('evidence', 10)).find((r) => r.conversationRef === 'a'))
    .toMatchObject({ conversationTitle: 'renamed', projectDisplayName: 'new display' });
  db.searchIndex.deleteConversation('demo', 'codex', 'a');
  assertOwnership(db);
  expect(db.searchIndex.getConversationStates('demo', 'codex').has('a')).toBe(false);
  db.searchIndex.replace('demo', 'codex', []);
  assertOwnership(db);
  expect(db.searchIndex.hasRowsFor('demo', 'codex')).toBe(false);
  expect(db.searchIndex.hasRowsFor('other', 'claude')).toBe(true);
  expect((await db.searchIndex.search('evidence', 10)).map((r) => r.conversationRef)).toEqual(['outside']);
});
it('rolls back FTS, mapping and file state together when an insert fails', () => {
  const db = fixture();
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [chunk('a')], { size: 1 });
  const before = db.sqlite.prepare('select rowid,* from conversation_search_fts').all();
  db.sqlite.exec(`create trigger reject_new_mapping before insert on conversation_search_rows
    begin select raise(abort,'fixture insert rejected'); end`);
  expect(() => db.searchIndex.replaceConversation('demo', 'codex', 'a', [{ ...chunk('a'), text: 'replacement content' }], { size: 2 })).toThrow('fixture insert rejected');
  expect(db.sqlite.prepare('select rowid,* from conversation_search_fts').all()).toEqual(before);
  expect(db.searchIndex.getConversationStates('demo', 'codex').get('a')?.size).toBe(1);
  assertOwnership(db);
});

it('preserves existing text rows on append and uses current metadata even for an old matching chunk', async () => {
  const db = fixture();
  const original = { ...chunk('a'), conversationUpdatedAt: '2020-01-01T00:00:00Z' };
  const anchor = { ...original, messageId: 'anchor', text: 'Unrelated anchor content' };
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [anchor, original], { size: 2 });
  const first = db.sqlite.prepare("select rowid from conversation_search_fts where message_id='a'").get();
  const current = { ...original, conversationTitle: 'Current title', conversationUpdatedAt: '2026-10-23T00:00:00Z' };
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [{ ...current, messageId: 'anchor', text: anchor.text }, current,
    { ...current, messageId: 'new', text: 'New unrelated message' }], { size: 3 });
  expect(db.sqlite.prepare("select rowid from conversation_search_fts where message_id='a'").get()).toEqual(first);
  const result = (await db.searchIndex.search('evidence', 10, { now: '2026-10-23T00:00:00Z' }))[0];
  expect(result).toMatchObject({ conversationTitle: 'Current title', conversationUpdatedAt: current.conversationUpdatedAt,
    recencyBucket: '0-5-days' });
  expect(db.searchIndex.getConversationStates('demo', 'codex').get('a')?.size).toBe(3);
  assertOwnership(db);
});

it('moves metadata ownership when the first chunk is removed and refreshes metadata for retained matches', async () => {
  const db = fixture();
  const original = { ...chunk('a'), conversationUpdatedAt: '2026-10-23T00:00:00Z' };
  const retained = { ...original, messageId: 'retained', text: 'retained needle' };
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [original, retained], { size: 2 });
  const row = db.sqlite.prepare("select rowid from conversation_search_fts where message_id='retained'").get();
  const current = { ...retained, conversationTitle: 'After truncation', conversationUpdatedAt: '2020-01-01T00:00:00Z' };
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [current], { size: 1 });
  expect(db.sqlite.prepare('select rowid from conversation_search_fts').get()).toEqual(row);
  expect((await db.searchIndex.search('needle', 10, { now: '2026-10-23T00:00:00Z' }))[0])
    .toMatchObject({ conversationTitle: 'After truncation', conversationUpdatedAt: current.conversationUpdatedAt,
      recencyBucket: '60-plus-days' });
  expect(await db.searchIndex.search('evidence', 10)).toEqual([]);
  assertOwnership(db);
});

it('retains duplicate content identities without leaking stale removed rows', () => {
  const db = fixture();
  const original = chunk('a');
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [original, original], { size: 2 });
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [original], { size: 1 });
  expect(db.sqlite.prepare('select count(*) n from conversation_search_fts').get()).toEqual({ n: 1 });
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [], { size: 0 });
  expect(db.sqlite.prepare('select count(*) n from conversation_search_fts').get()).toEqual({ n: 0 });
  assertOwnership(db);
});

it('rolls back retained metadata, new chunks and ownership when file-state publication fails', () => {
  const db = fixture();
  const original = chunk('a');
  db.searchIndex.replaceConversation('demo', 'codex', 'a', [original], { size: 1 });
  const before = db.sqlite.prepare('select rowid,* from conversation_search_fts').all();
  db.sqlite.exec(`create trigger reject_file_state before update on conversation_search_state
    begin select raise(abort,'fixture state rejected'); end`);
  const current = { ...original, conversationTitle: 'New title' };
  expect(() => db.searchIndex.replaceConversation('demo', 'codex', 'a',
    [current, { ...current, messageId: 'new', text: 'new evidence' }], { size: 2 })).toThrow('fixture state rejected');
  expect(db.sqlite.prepare('select rowid,* from conversation_search_fts').all()).toEqual(before);
  expect(db.searchIndex.getConversationStates('demo', 'codex').get('a')?.size).toBe(1);
  assertOwnership(db);
});
