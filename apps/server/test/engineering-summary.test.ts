import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { engineeringSummary, readProcessIdentity, safeText } from '../src/engineering/summary.js';

const roots: string[] = [];
const now = Date.parse('2026-10-15T06:00:00Z');
const stamp = '2026-10-15T05:00:00.000Z';
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-summary-')); roots.push(root);
  const database = path.join(root, 'console.sqlite'), wikiDatabase = path.join(root, 'wiki.sqlite');
  const db = new Database(database), wiki = new Database(wikiDatabase);
  db.exec(`
    create table coordination_assignments(id,provider,native_session_id,description,status,pid,process_start,started_at,last_seen_at,token_hash);
    create table coordination_scopes(assignment_id,checkout,repository,summary);
    create table coordination_events(assignment_id,checkout,kind,text,timestamp);
    create table coordination_messages(id,sender_id,recipient_id,text,created_at,supplied_at,acknowledged_at);
    create table bound_sessions(id,provider,project_slug,status,pid,conversation_ref,resume_conversation_ref,raw_log_path);
    create table meta(key,value);
    create table agent_grants(id,created_by_assignment_id,status,definition_json,provenance_json,reason,created_at);
    create table agent_grant_uses(id,grant_id,assignment_id,action,session_id,timestamp,detail_json);
  `);
  wiki.exec(`
    create table wiki_pages(repository,title_key,title,current_revision,updated_at);
    create table wiki_revisions(id,repository,title_key,title,body,summary,author,checkout,branch,head_commit,created_at);
    create table wiki_access(id,repository,actor,action,result_count,created_at,page_title,query,revision);
  `);
  const addAssignment = (id: string, status: string, pid: number, start: string, began = stamp) =>
    db.prepare('insert into coordination_assignments values(?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'codex', `native-${id}`, `Assignment ${id}`, status, pid, start, began, stamp, 'PRIVATE_TOKEN');
  addAssignment('live', 'active', 101, 'native-start');
  addAssignment('wait', 'waiting', 102, 'wait-start');
  addAssignment('old', 'active', 103, 'old-start', '2026-10-11T00:00:00.000Z');
  addAssignment('ended', 'finished', 104, 'ended-start', '2026-10-10T00:00:00.000Z');
  db.prepare('insert into coordination_scopes values(?,?,?,?)').run('live', '/repo/wt', '/repo/.git', 'Current work token=SECRETVALUE');
  db.prepare('insert into coordination_scopes values(?,?,?,?)').run('old', '/repo/old', '/repo/.git', 'Older work');
  db.prepare('insert into coordination_events values(?,?,?,?,?)').run('live', '/repo/wt', 'update', 'PRIVATE_EVENT_TEXT', stamp);
  db.prepare('insert into bound_sessions values(?,?,?,?,?,?,?,?)').run('session-live', 'codex', 'project', 'bound', 101, 'native-live', null, 'PRIVATE_LOG_PATH');
  db.prepare('insert into bound_sessions values(?,?,?,?,?,?,?,?)').run('session-stale', 'codex', 'project', 'bound', 103, 'native-old', null, 'PRIVATE_LOG_PATH');
  for (const [id, sent, supplied, ack] of [['m1', stamp, null, null], ['m2', stamp, stamp, null], ['m3', '2026-09-01T00:00:00Z', stamp, stamp]]) {
    db.prepare('insert into coordination_messages values(?,?,?,?,?,?,?)').run(id, 'live', 'old', 'PRIVATE_MESSAGE_BODY', sent, supplied, ack);
  }
  for (const id of ['m1', 'm2']) db.prepare('insert into meta values(?,?)').run(`peer-wake-attempt:${id}`,
    JSON.stringify({ sessionId: 'session-stale', timestamp: stamp, status: 'failed', reason: 'PRIVATE_WAKE_REASON' }));
  db.prepare('insert into meta values(?,?)').run('peer-wake-followup:m1', JSON.stringify({ sessionId: 'session-stale',
    timestamp: '2026-10-15T05:30:00.000Z', status: 'deferred', block: { code: 'memory_pressure', reason: 'PRIVATE_BLOCK_REASON' } }));
  const definition = { grantee: { kind: 'assignment', id: 'live' }, actions: ['launch_session'], projectSlugs: ['project'],
    scope: 'PRIVATE_GRANT_SCOPE', expiry: { kind: 'assignment_finished', assignmentId: 'live' } };
  db.prepare('insert into agent_grants values(?,?,?,?,?,?,?)').run('grant', 'live', 'active', JSON.stringify(definition), 'PRIVATE_PROVENANCE', 'PRIVATE_REASON', stamp);
  db.prepare('insert into agent_grants values(?,?,?,?,?,?,?)').run('expired', 'ended', 'active',
    JSON.stringify({ ...definition, expiry: { kind: 'assignment_finished', assignmentId: 'ended' } }), null, null, stamp);
  db.prepare('insert into agent_grant_uses values(?,?,?,?,?,?,?)').run('use', 'grant', 'live', 'launch_session', 'session-live', stamp, 'PRIVATE_USE_DETAILS');
  wiki.prepare('insert into wiki_pages values(?,?,?,?,?)').run('/repo/.git', 'page', 'Page', 2, stamp);
  for (const [id, author] of [[1, 'codex:first'], [2, 'claude:second']]) wiki.prepare('insert into wiki_revisions values(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, '/repo/.git', 'page', 'Page', 'PRIVATE_WIKI_BODY', 'PRIVATE_WIKI_SUMMARY', author, '/repo/wt', 'work/topic', 'source', stamp);
  for (const [id, actor, revision, action, results, query] of [
    [1, 'codex:first', 1, 'read', 1, null], [2, 'codex:reader', 1, 'read', 1, null],
    [3, 'claude:reader2', 2, 'read', 1, null], [4, 'codex:unknown', null, 'read', 1, null],
    [5, 'codex:searcher', null, 'search', 0, 'token=SECRETVALUE missing docs'],
  ]) wiki.prepare('insert into wiki_access values(?,?,?,?,?,?,?,?,?)').run(id, '/repo/.git', actor, action, results, stamp, 'Page', query, revision);
  db.close(); wiki.close();
  return { database, wikiDatabase, now,
    processIdentity: (pid: number) => pid === 101 ? { start: 'native-start', name: 'codex', cwd: '/repo/wt' }
      : pid === 102 ? { start: 'wait-start', name: 'codex', cwd: '/repo/wait' }
        : pid === 103 ? { start: 'reused-pid', name: 'codex', cwd: '/unrelated' } : null,
    git: (_repo: string, args: string[]) => args[0] === 'rev-parse' ? 'head' : '0\t25' };
}

it('exports complete metadata while excluding private payload columns and scrubbing topics', () => {
  const options = fixture();
  const before = [options.database, options.wikiDatabase].map(p => fs.readFileSync(p));
  const result = engineeringSummary(options);
  expect(result.status).toBe('ok');
  expect(result.issues).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(JSON.stringify(result)).not.toContain('SECRETVALUE');
  expect(result.agents.counts).toEqual({ total: 4, active: 1, waiting: 1, idle: 1, finished: 1, started_never_finished: 1 });
  expect(result.agents.assignments?.find(a => a.id === 'old')).toMatchObject({ live_session: false, recorded_status: 'active' });
  expect(result.agents.assignments?.find(a => a.id === 'live')).toMatchObject({ activity_summary: '[credential-bearing line omitted]',
    scopes: [{ checkout: '/repo/wt', repository: '/repo/.git', summary: '[credential-bearing line omitted]', updated_at: stamp }] });
  expect(result.agents.sessions?.find(s => s.id === 'session-stale')).toMatchObject({ live: false, checkout: null });
  expect(result.agents.sessions?.find(s => s.id === 'session-live')).toMatchObject({ live: true, checkout: '/repo/wt' });
  expect(result.agents.messages).toMatchObject({ total: 3, unsupplied: 1, unacknowledged: 2, pending_to_unfinished: 2 });
  expect(result.agents.messages?.daily).toHaveLength(14);
  expect(result.agents.messages?.daily.reduce((n, d) => n + d.count, 0)).toBe(2);
  expect(result.agents.wakes).toMatchObject({ failed: 1, blocked: 1, counts_by_status: { failed: 1, deferred: 1 } });
  expect(result.agents.wakes?.recent.find(r => r.status === 'failed')?.message_count).toBe(2);
  expect(result.agents.grants).toMatchObject({ active_count: 1, in_use_count: 1, uses_14d: 1, count_by_status: { active: 1, expired: 1 } });
  expect(result.wiki?.totals).toMatchObject({ pages: 1, revisions: 2, other_author_reads: 2, other_reader_assignments: 2,
    external_contributions: 1, reads_without_revision: 1 });
  expect(result.wiki?.adoption).toMatchObject({ usefulness: 'requires_manual_review', corrections: 'requires_manual_review' });
  expect(result.wiki?.pages[0]).toMatchObject({ source_commit: 'source', head_commit: 'head', commits_behind: 25, stale: true });
  for (const [i, p] of [options.database, options.wikiDatabase].entries()) expect(fs.readFileSync(p)).toEqual(before[i]);
});

it('shows independent source failures without creating missing databases or an all-clear', () => {
  const options = fixture();
  const missing = path.join(path.dirname(options.database), 'missing.sqlite');
  const partial = engineeringSummary({ ...options, wikiDatabase: missing });
  expect(partial.status).toBe('partial');
  expect(partial.sources.wiki.status).toBe('error');
  expect(partial.wiki).toBeNull();
  expect(partial.agents.counts?.total).toBe(4);
  expect(fs.existsSync(missing)).toBe(false);
  const failed = engineeringSummary({ ...options, database: missing, wikiDatabase: missing });
  expect(failed.status).toBe('error');
  expect(failed.agents.counts).toBeNull();
  expect(failed.agents.messages).toBeNull();
  expect(failed.issues).toHaveLength(2);
});

it('keeps unaffected Console measurements visible when one schema is unsupported', () => {
  const options = fixture();
  const db = new Database(options.database); db.exec('drop table bound_sessions'); db.close();
  const result = engineeringSummary(options);
  expect(result.status).toBe('partial');
  expect(result.sources.console.status).toBe('partial');
  expect(result.agents.counts).toBeNull();
  expect(result.agents.messages?.total).toBe(3);
  expect(result.issues[0]?.code).toMatch(/^assignments:/);
});

it('preserves unknown or divergent wiki source provenance without claiming freshness', () => {
  const options = fixture();
  expect(engineeringSummary({ ...options, git: () => { throw new Error('private path error'); } }).wiki?.pages[0])
    .toMatchObject({ source_status: 'unavailable', commits_behind: null, stale: null });
  expect(engineeringSummary({ ...options, git: (_repo, args) => args[0] === 'rev-parse' ? 'head' : '2 15' }).wiki?.pages[0])
    .toMatchObject({ source_status: 'diverged', commits_behind: null, stale: null });
});

it('compares wiki provenance against the actual repository HEAD using read-only Git', () => {
  const options = fixture(), repo = path.join(path.dirname(options.database), 'repo'); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'source');
  const source = git('rev-parse', 'HEAD');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'next');
  const db = new Database(options.wikiDatabase);
  db.prepare('update wiki_pages set repository=?').run(path.join(repo, '.git'));
  db.prepare('update wiki_revisions set repository=?,head_commit=?').run(path.join(repo, '.git'), source); db.close();
  const result = engineeringSummary({ ...options, git: undefined });
  expect(result.wiki?.pages[0]).toMatchObject({ source_status: 'behind', commits_behind: 1, stale: false });
});

it('scrubs common credential forms without removing useful topic words', () => {
  expect(safeText('postgresql://user:pass@host/db token=hidden missing docs')).toBe('[credential-bearing line omitted]');
  expect(safeText('Bearer abcdefghijklmnopqrst ghp_abcdefghijklmnopqrst')).not.toContain('abcdefghijkl');
  expect(safeText('x'.repeat(200))).toHaveLength(160);
});

it('runs the source CLI without a backend and returns structured failures for operators', () => {
  const options = fixture();
  const cli = fileURLToPath(new URL('../src/engineering/summary-cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8' });
  const help = run('--help');
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('--wiki-database');
  const result = run('--database', options.database, '--wiki-database', options.wikiDatabase);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: 1, status: 'ok' });
  const missing = path.join(path.dirname(options.database), 'absent.sqlite');
  const partial = run('--database', options.database, '--wiki-database', missing);
  expect(partial.status).toBe(2);
  expect(JSON.parse(partial.stdout)).toMatchObject({ status: 'partial', wiki: null });
  expect(fs.existsSync(missing)).toBe(false);
  const badConfig = path.join(path.dirname(options.database), 'secret-config.json');
  fs.writeFileSync(badConfig, 'PRIVATE_SECRET_CONFIG');
  const invalid = run('--config', badConfig);
  expect(invalid.status).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ status: 'error' });
  expect(invalid.stdout + invalid.stderr).not.toContain('PRIVATE_SECRET_CONFIG');
});


it('keeps a finished assignment live while its verified bound session is running', () => {
  const options = fixture();
  const db = new Database(options.database);
  db.prepare("update coordination_assignments set status='finished' where id='live'").run();
  db.close();
  const result = engineeringSummary(options);
  expect(result.agents.assignments?.find(a => a.id === 'live')).toMatchObject({
    status: 'finished', live_session: true, session_ids: ['session-live'],
  });
  expect(result.agents.sessions?.find(s => s.id === 'session-live')).toMatchObject({ live: true, checkout: '/repo/wt' });
});

it('sanitizes wiki titles, descriptions, activity, map keys and failed database paths', () => {
  const options = fixture();
  const marker = 'SYNTHETIC_EXPORT_CREDENTIAL';
  const secret = `RESEND_API_KEY="${marker}"`;
  const db = new Database(options.database);
  db.prepare('update coordination_assignments set description=?').run(secret);
  db.prepare('update coordination_scopes set summary=?').run(secret);
  db.close();
  const wiki = new Database(options.wikiDatabase);
  wiki.prepare('update wiki_pages set title=?').run(secret);
  wiki.close();
  expect(JSON.stringify(engineeringSummary(options))).not.toContain(marker);
  const failed = engineeringSummary({ ...options, database: `postgresql://host/${marker}`,
    wikiDatabase: `/private/${marker}/wiki.sqlite` });
  const output = JSON.stringify(failed);
  expect(failed.status).toBe('error');
  expect(output).not.toContain(marker);
  expect(output).not.toContain('/private/');
});


it('withholds database paths in the CLI even after URL-like inputs are normalized', () => {
  const cli = fileURLToPath(new URL('../src/engineering/summary-cli.ts', import.meta.url));
  const marker = 'SYNTHETIC_CLI_PRIVATE_PATH';
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, '--database', `postgresql://user:${marker}@host/data`,
    '--wiki-database', `/private/${marker}/source`], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  const output = result.stdout + result.stderr;
  expect(output).not.toContain(marker);
  expect(output).not.toContain('/private/');
  expect(JSON.parse(result.stdout).sources.console.path).toBe('[database path omitted]');
});


it('exports actual process checkout ownership without scope or bound-session rows', () => {
  const options = fixture();
  const db = new Database(options.database);
  db.prepare("delete from coordination_scopes where assignment_id='live'").run();
  db.prepare("delete from bound_sessions where id='session-live'").run();
  db.close();
  expect(engineeringSummary(options).agents.assignments?.find(a => a.id === 'live')).toMatchObject({
    live_session: true, live_process: true, process_checkout: '/repo/wt', scopes: [], session_ids: [],
  });
});

it('retains finished process ownership without a bound session and exposes unknown cwd', () => {
  const options = fixture();
  const db = new Database(options.database);
  db.prepare("update coordination_assignments set status='finished' where id='live'").run();
  db.prepare("delete from bound_sessions where id='session-live'").run();
  db.close();
  const processIdentity = (pid: number) => pid === 101 ? { start: 'native-start', name: 'codex', cwd: null } : null;
  const result = engineeringSummary({ ...options, processIdentity });
  expect(result.agents.assignments?.find(a => a.id === 'live')).toMatchObject({
    status: 'finished', live_session: true, live_process: true, process_checkout: null,
  });
  expect(result.status).toBe('partial');
  expect(result.sources.console.status).toBe('partial');
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'ownership:PROCESS_CHECKOUT_UNAVAILABLE' }));
});


it('resolves real live process subdirectories to their Git worktree root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-process-root-')); roots.push(root);
  const repo = path.join(root, 'repo'), subdir = path.join(repo, 'apps', 'server');
  fs.mkdirSync(subdir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [cwd, expected] of [[subdir, repo], [root, null]] as const) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
    try {
      await once(child, 'spawn');
      expect(readProcessIdentity(child.pid!)?.cwd).toBe(expected);
    } finally { child.kill(); await once(child, 'exit'); }
  }
});
