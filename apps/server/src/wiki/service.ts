import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { WikiHistoryEntry, WikiPage, WikiPageSummary, WikiSearchResponse } from '@agent-console/shared';
import { checkoutIdentity } from '../coordination/git.js';

export type WikiActor = { kind: 'agent' | 'user'; id: string; provider?: string };

type PageRow = { repository: string; title_key: string; title: string; current_revision: number; updated_at: string };
type RevisionRow = {
  id: number; title: string; body: string; summary: string; author: string;
  checkout: string; branch: string | null; head_commit: string | null; created_at: string;
};

function titleParts(input: string): { title: string; key: string } {
  const title = input.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 160 || /[\u0000-\u001f\u007f\[\]]/.test(title)) throw new Error('Wiki title must be 1–160 characters without brackets or control characters.');
  return { title, key: title.toLowerCase() };
}

export function wikiLinks(body: string): string[] {
  const links = new Map<string, string>();
  for (const match of body.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    try {
      const { title, key } = titleParts((match[1] ?? '').split('|', 1)[0] ?? '');
      links.set(key, title);
    } catch { /* Invalid bracket text remains ordinary page content. */ }
  }
  return [...links.values()];
}

function provenance(checkout: string): { branch: string | null; headCommit: string | null } {
  const git = (args: string[]) => execFileSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() || null;
  try { return { branch: git(['branch', '--show-current']), headCommit: git(['rev-parse', 'HEAD']) }; }
  catch { return { branch: null, headCommit: null }; }
}

function rejectSymlink(file: string, label: string): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function wikiIdentity(checkout: string) {
  if (!path.isAbsolute(checkout)) throw new Error('Wiki checkout must be an absolute path inside a Git repository.');
  return checkoutIdentity(checkout);
}

export class WikiConflictError extends Error {
  readonly statusCode = 409;
  constructor(readonly currentRevision: number | null) {
    super(`Wiki page changed. Current revision: ${currentRevision ?? 'none'}. Read it again and merge your edit.`);
  }
}

export class WikiService {
  readonly sqlite: Database.Database;
  private readonly backupPath: string;
  private backupTail: Promise<void> = Promise.resolve();

  constructor(databasePath: string) {
    const directory = path.dirname(databasePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    rejectSymlink(directory, 'Wiki storage directory');
    fs.chmodSync(directory, 0o700);
    rejectSymlink(databasePath, 'Wiki database');
    this.sqlite = new Database(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.backupPath = path.join(directory, 'agent-wiki.backup.sqlite');
    this.sqlite.pragma('journal_mode = WAL');
    const version = this.sqlite.pragma('user_version', { simple: true }) as number;
    if (version > 2) { this.sqlite.close(); throw new Error(`Wiki schema version ${version} is newer than this Console supports.`); }
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        create table if not exists wiki_pages (
          repository text not null, title_key text not null, title text not null,
          current_revision integer not null, updated_at text not null,
          primary key(repository, title_key)
        );
        create table if not exists wiki_revisions (
          id integer primary key autoincrement, repository text not null, title_key text not null,
          title text not null, body text not null, summary text not null, author text not null,
          checkout text not null, branch text, head_commit text, created_at text not null
        );
        create index if not exists wiki_revisions_page on wiki_revisions(repository, title_key, id desc);
        create table if not exists wiki_access (
          id integer primary key autoincrement, repository text not null, actor text not null,
          action text not null, result_count integer not null, created_at text not null
        );
        create index if not exists wiki_access_repo_time on wiki_access(repository, created_at);
      `);
      if (version < 2) {
        // Preserve existing access history; unknown details stay null.
        this.sqlite.exec(`
          alter table wiki_access add column page_title text;
          alter table wiki_access add column query text;
          alter table wiki_access add column revision integer;
        `);
        this.sqlite.pragma('user_version = 2');
      }
    }).immediate();
  }

  close(): void { this.sqlite.close(); }

  backup(): Promise<void> {
    const next = this.backupTail.catch(() => {}).then(async () => {
      const temporary = `${this.backupPath}.${randomUUID()}.tmp`;
      try {
        await this.sqlite.backup(temporary);
        fs.chmodSync(temporary, 0o600);
        rejectSymlink(this.backupPath, 'Wiki backup path');
        fs.renameSync(temporary, this.backupPath);
      } finally {
        if (fs.existsSync(temporary) && !fs.lstatSync(temporary).isSymbolicLink()) fs.unlinkSync(temporary);
      }
    });
    this.backupTail = next;
    return next;
  }

  private actorName(actor: WikiActor): string {
    return actor.kind === 'agent' ? `${actor.provider ?? 'agent'}:${actor.id}` : `user:${actor.id}`;
  }

  private access(repository: string, actor: WikiActor, action: string, resultCount: number,
    detail: { title?: string; query?: string; revision?: number } = {}): void {
    this.sqlite.prepare(`insert into wiki_access(repository,actor,action,result_count,created_at,page_title,query,revision)
      values(?,?,?,?,?,?,?,?)`).run(repository, this.actorName(actor), action, resultCount,
      new Date().toISOString(), detail.title ?? null, detail.query ?? null, detail.revision ?? null);
  }

  private page(repository: string, key: string): PageRow | undefined {
    return this.sqlite.prepare('select * from wiki_pages where repository=? and title_key=?').get(repository, key) as PageRow | undefined;
  }

  private revision(id: number): RevisionRow | undefined {
    return this.sqlite.prepare('select * from wiki_revisions where id=?').get(id) as RevisionRow | undefined;
  }

  private result(repository: string, page: PageRow, row: RevisionRow): WikiPage {
    const links = wikiLinks(row.body);
    const candidates = this.sqlite.prepare(`select p.title, r.body from wiki_pages p
      join wiki_revisions r on r.id=p.current_revision where p.repository=? and p.title_key!=?`)
      .all(repository, page.title_key) as Array<{ title: string; body: string }>;
    const backlinks = candidates.filter((candidate) => wikiLinks(candidate.body).some((link) => titleParts(link).key === page.title_key))
      .map((candidate) => candidate.title).slice(0, 30);
    return { revision: row.id, title: page.title, body: row.body, summary: row.summary,
      author: row.author, checkout: row.checkout, branch: row.branch, headCommit: row.head_commit,
      createdAt: row.created_at, links, backlinks };
  }

  read(checkout: string, titleInput: string, actor: WikiActor, revision?: number): WikiPage | null {
    const { repository } = wikiIdentity(checkout);
    const { title, key } = titleParts(titleInput);
    const page = this.page(repository, key);
    const row = page && (revision === undefined
      ? this.revision(page.current_revision)
      : this.sqlite.prepare('select * from wiki_revisions where id=? and repository=? and title_key=?').get(revision, repository, key) as RevisionRow | undefined);
    this.access(repository, actor, 'read', row ? 1 : 0, { title: page?.title ?? title, revision: row?.id });
    return page && row ? this.result(repository, page, row) : null;
  }

  list(checkout: string, actor: WikiActor, offset = 0) {
    const { repository } = wikiIdentity(checkout);
    const pages = this.sqlite.prepare(`select p.title, p.current_revision as revision, p.updated_at as updatedAt,
      substr(r.author,1,80) as author, substr(r.summary,1,100) as summary
      from wiki_pages p join wiki_revisions r on r.id=p.current_revision
      where p.repository=? order by p.updated_at desc, p.title_key limit 8 offset ?`)
      .all(repository, offset) as WikiPageSummary[];
    const total = (this.sqlite.prepare('select count(*) as n from wiki_pages where repository=?').get(repository) as { n: number }).n;
    this.access(repository, actor, 'list', pages.length);
    return { pages, total, nextOffset: offset + pages.length < total ? offset + pages.length : null };
  }

  search(checkout: string, queryInput: string, actor: WikiActor) {
    const { repository } = wikiIdentity(checkout);
    const query = queryInput.trim();
    if (!query || query.length > 160) throw new Error('Wiki search query must be 1–160 characters.');
    const rows = this.sqlite.prepare(`select p.title, p.current_revision as revision, p.updated_at as updatedAt,
      substr(replace(r.body, char(10), ' '), 1, 180) as snippet from wiki_pages p
      join wiki_revisions r on r.id=p.current_revision where p.repository=?
      and (instr(lower(p.title),lower(?))>0 or instr(lower(r.body),lower(?))>0)
      order by case when instr(lower(p.title),lower(?))>0 then 0 else 1 end, p.updated_at desc limit 8`)
      .all(repository, query, query, query) as WikiSearchResponse['results'];
    this.access(repository, actor, 'search', rows.length, { query });
    return { results: rows };
  }

  history(checkout: string, titleInput: string, actor: WikiActor, offset = 0) {
    const { repository } = wikiIdentity(checkout);
    const { title, key } = titleParts(titleInput);
    const page = this.page(repository, key);
    if (!page) {
      this.access(repository, actor, 'history', 0, { title });
      return { revisions: [], total: 0, nextOffset: null };
    }
    const revisions = this.sqlite.prepare(`select id as revision, summary, author, checkout, branch,
      head_commit as headCommit, created_at as createdAt from wiki_revisions
      where repository=? and title_key=? order by id desc limit 10 offset ?`)
      .all(repository, key, offset) as WikiHistoryEntry[];
    const total = (this.sqlite.prepare('select count(*) as n from wiki_revisions where repository=? and title_key=?')
      .get(repository, key) as { n: number }).n;
    this.access(repository, actor, 'history', revisions.length, { title: page.title });
    return { revisions, total, nextOffset: offset + revisions.length < total ? offset + revisions.length : null };
  }

  write(checkout: string, input: { title: string; body: string; baseRevision: number | null; summary?: string }, actor: WikiActor): WikiPage {
    const { checkout: canonical, repository } = wikiIdentity(checkout);
    const { title, key } = titleParts(input.title);
    if (input.body.length > 65_536) throw new Error('Wiki page exceeds 64 KiB. Split it into linked pages.');
    const summary = input.summary?.trim() ?? '';
    if (summary.length > 200) throw new Error('Wiki edit summary exceeds 200 characters.');
    const source = provenance(canonical);
    const result = this.sqlite.transaction(() => {
      const page = this.page(repository, key);
      const current = page && this.revision(page.current_revision);
      if (page && current?.body === input.body) return this.result(repository, page, current);
      if ((page?.current_revision ?? null) !== input.baseRevision) throw new WikiConflictError(page?.current_revision ?? null);
      const now = new Date().toISOString();
      const inserted = this.sqlite.prepare(`insert into wiki_revisions
        (repository,title_key,title,body,summary,author,checkout,branch,head_commit,created_at)
        values(?,?,?,?,?,?,?,?,?,?)`)
        .run(repository, key, title, input.body, summary, this.actorName(actor), canonical, source.branch, source.headCommit, now);
      const revision = Number(inserted.lastInsertRowid);
      this.sqlite.prepare(`insert into wiki_pages(repository,title_key,title,current_revision,updated_at)
        values(?,?,?,?,?) on conflict(repository,title_key) do update set
        current_revision=excluded.current_revision, updated_at=excluded.updated_at`)
        .run(repository, key, page?.title ?? title, revision, now);
      return this.result(repository, this.page(repository, key)!, this.revision(revision)!);
    }).immediate();
    this.access(repository, actor, 'write', 1, { title: result.title, revision: result.revision });
    return result;
  }
}
