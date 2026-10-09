import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { dispatchWiki, startCoordinationSocket } from '../src/coordination/transport.js';
import { WikiConflictError, WikiService } from '../src/wiki/service.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wiki-'));
  const checkout = path.join(root, 'repo');
  fs.mkdirSync(checkout);
  git(checkout, 'init', '-q');
  git(checkout, 'config', 'user.name', 'Wiki Test');
  git(checkout, 'config', 'user.email', 'wiki@example.invalid');
  fs.writeFileSync(path.join(checkout, 'README.md'), '# repo\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'initial');
  const linked = path.join(root, 'linked');
  git(checkout, 'worktree', 'add', '--detach', linked);
  const wikiPath = path.join(root, 'agent-wiki.sqlite');
  const wiki = new WikiService(wikiPath);
  const actor = { kind: 'agent' as const, id: randomUUID(), provider: 'codex' };
  cleanups.push(() => { if (wiki.sqlite.open) wiki.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, checkout, linked, wiki, wikiPath, actor };
}

describe('repository wiki', () => {
  it('finds reordered query words and favors an exact title over a body phrase', () => {
    const { checkout, wiki, actor } = fixture();
    wiki.write(checkout, { title: 'Worker deployment', body: 'Operational procedure.', baseRevision: null }, actor);
    wiki.write(checkout, { title: 'Other notes', body: 'Worker deployment is discussed here.', baseRevision: null }, actor);
    expect(wiki.search(checkout, 'worker deployment', actor).results.map((r) => r.title)).toEqual(['Worker deployment', 'Other notes']);
    const reordered = wiki.search(checkout, 'deployment worker', actor);
    expect(reordered.pageCount).toBe(2);
    expect(reordered.results).toHaveLength(2);
    expect(reordered.results[0]?.matchedTerms).toEqual(['deployment', 'worker']);
  });

  it('ranks focused evidence above widely scattered matches and excerpts the matching text', () => {
    const { checkout, wiki, actor } = fixture();
    wiki.write(checkout, { title: 'Focused evidence', body: `${'Unrelated introduction. '.repeat(100)}worker deployment verification passed.${' Trailing background.'.repeat(30)}`, baseRevision: null }, actor);
    wiki.write(checkout, { title: 'Broad notes', body: `worker ${'miscellaneous '.repeat(180)}deployment`, baseRevision: null }, actor);
    const result = wiki.search(checkout, 'deployment worker', actor);
    expect(result.results.map((r) => r.title)).toEqual(['Focused evidence', 'Broad notes']);
    expect(result.results[0]?.snippet).toContain('worker deployment verification passed');
    expect(result.results[0]?.snippet).toHaveLength(222);
    expect(result.results[0]?.snippet.startsWith('…')).toBe(true);
  });

  it('matches word starts and literal identifiers rather than interior substrings or regex patterns', () => {
    const { checkout, wiki, actor } = fixture();
    wiki.write(checkout, { title: 'Runtime', body: 'Deployment uses TLS and apps/server/dist with config.toml.', baseRevision: null }, actor);
    wiki.write(checkout, { title: 'Unrelated', body: 'configXtoml is a different identifier.', baseRevision: null }, actor);
    expect(wiki.search(checkout, 'deploy', actor).results.map((r) => r.title)).toEqual(['Runtime']);
    expect(wiki.search(checkout, 'ploy', actor).results).toEqual([]);
    expect(wiki.search(checkout, 'apps/server/dist TLS', actor).results[0]?.matchedTerms).toEqual(['apps/server/dist', 'tls']);
    expect(wiki.search(checkout, 'config.toml', actor).results.map((r) => r.title)).toEqual(['Runtime']);
  });

  it('requires meaningful coverage, bounds results, and distinguishes an empty wiki', () => {
    const { checkout, wiki, actor } = fixture();
    expect(wiki.search(checkout, 'missing subject', actor)).toEqual({ pageCount: 0, results: [] });
    for (let i = 0; i < 12; i++) wiki.write(checkout, { title: `Runtime ${i}`, body: 'worker deployment diagnostics', baseRevision: null }, actor);
    wiki.write(checkout, { title: 'Sparse match', body: 'worker alone', baseRevision: null }, actor);
    expect(wiki.search(checkout, 'worker deployment unknown unavailable', actor).results).toEqual([]);
    expect(wiki.search(checkout, 'worker deployment', actor).results).toHaveLength(8);
    expect(wiki.search(checkout, 'worker deployment', actor).results.some((r) => r.title === 'Sparse match')).toBe(false);
    expect(wiki.search(checkout, 'how the', actor)).toEqual({ pageCount: 13, results: [] });
    expect(wiki.search(checkout, 'missing subject', actor)).toEqual({ pageCount: 13, results: [] });
  });

  it('records the exact page revision a different agent read and the demand behind searches and misses', () => {
    const { checkout, linked, wiki, actor } = fixture();
    const reader = { kind: 'agent' as const, id: randomUUID(), provider: 'claude' };
    const first = wiki.write(checkout, { title: 'Home', body: 'Deployment evidence', baseRevision: null }, actor);
    wiki.read(linked, 'HOME', reader);
    const second = wiki.write(checkout, { title: 'Home', body: 'New deployment evidence', baseRevision: first.revision }, actor);
    wiki.read(linked, 'Home', reader, first.revision);
    wiki.read(linked, 'Home', reader);
    wiki.search(linked, '  deployment  ', reader);
    wiki.search(linked, 'missing subject', reader);
    wiki.read(linked, ' Missing page ', reader);
    wiki.history(linked, 'Missing page', reader);
    const reads = wiki.sqlite.prepare(`select a.page_title, a.revision, r.author from wiki_access a
      join wiki_revisions r on r.id=a.revision where a.action='read' and a.actor=? order by a.id`)
      .all(`claude:${reader.id}`);
    expect(reads).toEqual([
      { page_title: 'Home', revision: first.revision, author: `codex:${actor.id}` },
      { page_title: 'Home', revision: first.revision, author: `codex:${actor.id}` },
      { page_title: 'Home', revision: second.revision, author: `codex:${actor.id}` },
    ]);
    expect(wiki.sqlite.prepare(`select query, result_count from wiki_access where action='search' order by id`).all())
      .toEqual([{ query: 'deployment', result_count: 1 }, { query: 'missing subject', result_count: 0 }]);
    expect(wiki.sqlite.prepare(`select action, page_title, revision, result_count from wiki_access
      where page_title='Missing page' order by id`).all()).toEqual([
      { action: 'read', page_title: 'Missing page', revision: null, result_count: 0 },
      { action: 'history', page_title: 'Missing page', revision: null, result_count: 0 },
    ]);
  });

  it('upgrades the previous database without changing pages, revisions or historical access evidence', () => {
    const { checkout, wiki, wikiPath, actor } = fixture();
    const first = wiki.write(checkout, { title: 'Home', body: 'Keep the existing knowledge', baseRevision: null }, actor);
    wiki.read(checkout, 'Home', actor);
    // Reproduce the schema installed before page/query/revision access logging.
    wiki.sqlite.exec(`alter table wiki_access drop column page_title;
      alter table wiki_access drop column query;
      alter table wiki_access drop column revision;
      pragma user_version=1;`);
    const pages = wiki.sqlite.prepare('select * from wiki_pages').all();
    const revisions = wiki.sqlite.prepare('select * from wiki_revisions').all();
    const accesses = wiki.sqlite.prepare('select * from wiki_access').all();
    wiki.close();
    const upgraded = new WikiService(wikiPath);
    cleanups.push(() => { if (upgraded.sqlite.open) upgraded.close(); });
    expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(2);
    expect(upgraded.sqlite.prepare('select * from wiki_pages').all()).toEqual(pages);
    expect(upgraded.sqlite.prepare('select * from wiki_revisions').all()).toEqual(revisions);
    expect(upgraded.sqlite.prepare('select * from wiki_access').all()).toEqual(accesses.map((row) => ({
      ...(row as object), page_title: null, query: null, revision: null,
    })));
    expect(upgraded.read(checkout, 'Home', actor)?.revision).toBe(first.revision);
    upgraded.close();
    const reopened = new WikiService(wikiPath);
    cleanups.push(() => reopened.close());
    expect(reopened.read(checkout, 'Home', actor)?.body).toBe(first.body);
  });

  it('shares pages across worktrees, retains provenance and revisions, and rejects stale edits', () => {
    const { checkout, linked, wiki, actor } = fixture();
    const first = wiki.write(checkout, { title: 'Home', body: '# Home\nSee [[Design]].', baseRevision: null }, actor);
    expect(first.revision).toBeGreaterThan(0);
    expect(first.headCommit).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(first.links).toEqual(['Design']);
    expect(wiki.read(linked, 'home', actor)?.body).toBe('# Home\nSee [[Design]].');
    const secondActor = { kind: 'agent' as const, id: randomUUID(), provider: 'claude' };
    const second = wiki.write(linked, { title: 'Design', body: 'Long-lived architecture notes.', baseRevision: null }, secondActor);
    expect(second.branch).toBeNull();
    expect(wiki.read(checkout, 'Design', actor)?.author).toBe(`claude:${secondActor.id}`);
    expect(wiki.read(checkout, 'Design', actor)?.backlinks).toEqual(['Home']);
    const update = wiki.write(linked, { title: 'Home', body: '# Home\nSee [[Design]].\nMore context.', baseRevision: first.revision, summary: 'Expand' }, secondActor);
    expect(update.revision).not.toBe(first.revision);
    expect(() => wiki.write(checkout, { title: 'Home', body: 'Stale replacement', baseRevision: first.revision }, actor))
      .toThrow(WikiConflictError);
    expect(wiki.write(checkout, { title: 'Home', body: update.body, baseRevision: first.revision }, actor).revision).toBe(update.revision);
    expect(wiki.read(checkout, 'Home', actor, first.revision)?.body).toBe(first.body);
    expect(wiki.history(checkout, 'Home', actor).revisions.map((item) => item.revision)).toEqual([update.revision, first.revision]);
    expect(wiki.list(linked, actor).total).toBe(2);
    expect(wiki.search(checkout, 'architecture', actor).results.map((item) => item.title)).toEqual(['Design']);
    expect((wiki.sqlite.prepare("select count(*) as n from wiki_access where action='read'").get() as { n: number }).n).toBeGreaterThan(0);
  });

  it('isolates repositories and survives reopening its own database', () => {
    const { root, checkout, wiki, wikiPath, actor } = fixture();
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    git(other, 'init', '-q');
    wiki.write(checkout, { title: 'Home', body: 'Shared durable page', baseRevision: null }, actor);
    expect(wiki.read(other, 'Home', actor)).toBeNull();
    wiki.close();
    const reopened = new WikiService(wikiPath);
    cleanups.push(() => reopened.close());
    expect(reopened.read(checkout, 'Home', actor)?.body).toBe('Shared durable page');
  });

  it('creates a complete private SQLite snapshot for ordinary file backups', async () => {
    const { checkout, wiki, wikiPath, actor } = fixture();
    wiki.write(checkout, { title: 'Home', body: 'Backup witness', baseRevision: null }, actor);
    await wiki.backup();
    const snapshotPath = path.join(path.dirname(wikiPath), 'agent-wiki.backup.sqlite');
    expect(fs.statSync(snapshotPath).mode & 0o777).toBe(0o600);
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try { expect((snapshot.prepare('select body from wiki_revisions').get() as { body: string }).body).toBe('Backup witness'); }
    finally { snapshot.close(); }
  });

  it('authenticates agent writes and requires an explicit checkout and base revision', () => {
    const { root, checkout, wiki } = fixture();
    const db = new AppDatabase(path.join(root, 'console.sqlite'));
    cleanups.push(() => db.close());
    const coordination = new CoordinationService(db, { enabled: true, pilotPaths: [] });
    const token = randomUUID();
    const assignmentId = coordination.register({ provider: 'codex', nativeSessionId: randomUUID(), token, pid: process.pid, cwd: checkout }).assignmentId!;
    const input = { action: 'write', assignmentId, token, checkout, title: 'Home', body: 'From an agent', baseRevision: null };
    expect(dispatchWiki(coordination, wiki, input)).toMatchObject({ page: { body: 'From an agent' } });
    expect(() => dispatchWiki(coordination, wiki, { ...input, token: randomUUID(), body: 'Tampered' })).toThrow('credential');
    expect(() => dispatchWiki(coordination, wiki, { ...input, baseRevision: undefined, body: 'Changed' })).toThrow('baseRevision is required');
    expect(() => dispatchWiki(coordination, wiki, { ...input, checkout: undefined, body: 'Changed' })).toThrow();
    expect(wiki.read(checkout, 'Home', { kind: 'user', id: 'test' })?.body).toBe('From an agent');
  });

  it('accepts a full page through the authenticated private agent socket', async () => {
    const { root, checkout, linked, wiki } = fixture();
    const db = new AppDatabase(path.join(root, 'console.sqlite'));
    cleanups.push(() => db.close());
    const coordination = new CoordinationService(db, { enabled: true, pilotPaths: [] });
    const token = randomUUID();
    const assignmentId = coordination.register({ provider: 'codex', nativeSessionId: randomUUID(), token, pid: process.pid, cwd: checkout }).assignmentId!;
    const socket = await startCoordinationSocket(coordination, root, wiki);
    try {
      const response = await new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
        const request = http.request({ socketPath: path.join(root, 'coordination/agent.sock'), path: '/wiki', method: 'POST', headers: { 'content-type': 'application/json' } }, (reply) => {
          let text = '';
          reply.on('data', (chunk) => { text += chunk; });
          reply.on('end', () => resolve({ status: reply.statusCode, body: JSON.parse(text) }));
        });
        request.on('error', reject);
        request.end(JSON.stringify({ action: 'write', assignmentId, token, checkout, title: 'Large page', body: 'x'.repeat(40_000), baseRevision: null }));
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ page: { title: 'Large page' } });
      expect(wiki.read(linked, 'Large page', { kind: 'agent', id: assignmentId })?.body).toHaveLength(40_000);
    } finally { await socket.close(); }
  });
});
