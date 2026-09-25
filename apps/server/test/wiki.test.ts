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
