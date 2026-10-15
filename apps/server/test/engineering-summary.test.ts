import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { engineeringSummary, readProcessIdentity } from '../src/engineering/summary.js';
import { redactText } from '../src/engineering/export-redaction.js';
import redactionContract from '../src/engineering/export_redaction.v1.json' with { type: 'json' };

const roots: string[] = [];
const now = Date.parse('2026-10-15T06:00:00Z');
const stamp = '2026-10-15T05:00:00.000Z';
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-summary-')); roots.push(root);
  const database = path.join(root, 'console.sqlite'), wikiDatabase = path.join(root, 'wiki.sqlite');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ projectsRoot: '/repo', projects: {} }));
  const db = new Database(database), wiki = new Database(wikiDatabase);
  db.exec(`
    create table coordination_assignments(id,provider,native_session_id,description,status,pid,process_start,started_at,last_seen_at,token_hash);
    create table coordination_scopes(assignment_id,checkout,repository,summary);
    create table coordination_events(seq integer primary key autoincrement,assignment_id,checkout,kind,text,timestamp);
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
  db.prepare('insert into coordination_events(assignment_id,checkout,kind,text,timestamp) values(?,?,?,?,?)').run('live', '/repo/wt', 'update', 'PRIVATE_EVENT_TEXT', stamp);
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
  return { database, wikiDatabase, config, now,
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
  expect(failed.issues).toHaveLength(3);
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

it('disables configured Git monitoring and optional writes for process and Wiki reads', async () => {
  const options = fixture(), root = path.dirname(options.database), repo = path.join(root, 'repo');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const git = (...args: string[]) => execFileSync(realGit, ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(repo); execFileSync(realGit, ['init', '-q', repo]);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\n'); git('add', '.'); git('commit', '-qm', 'initial');
  const marker = path.join(root, 'hook-invoked'), hook = path.join(root, 'monitor.cjs');
  fs.writeFileSync(hook, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n');process.stdout.write('guard-token\\0/\\0');\n`, { mode: 0o755 });
  git('config', 'core.fsmonitor', hook); git('config', 'core.untrackedCache', 'true');
  git('status', '--porcelain'); expect(fs.existsSync(marker)).toBe(true); fs.unlinkSync(marker);
  const index = path.join(repo, '.git', 'index'), before = fs.readFileSync(index);
  const wiki = new Database(options.wikiDatabase);
  for (const table of ['wiki_pages', 'wiki_revisions', 'wiki_access']) wiki.prepare(`update ${table} set repository=?`).run(path.join(repo, '.git'));
  wiki.prepare('update wiki_revisions set head_commit=?').run(git('rev-parse', 'HEAD')); wiki.close();
  const bin = path.join(root, 'bin'), audit = path.join(root, 'git-audit.jsonl'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2),command=args.findIndex(v=>v==='rev-parse'||v==='rev-list'),globals=args.slice(0,command);
const get=key=>spawnSync(${JSON.stringify(realGit)},[...globals,'config','--get',key],{encoding:'utf8'}).stdout.trim();
fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({monitor:get('core.fsmonitor'),cache:get('core.untrackedCache'),locks:process.env.GIT_OPTIONAL_LOCKS})+'\\n');
const result=spawnSync(${JSON.stringify(realGit)},args,{encoding:'utf8'});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);\n`, { mode: 0o755 });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: repo, stdio: 'ignore' });
  try {
    await once(child, 'spawn'); vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    expect(readProcessIdentity(child.pid!)?.cwd).toBe(repo);
    expect(engineeringSummary({ ...options, git: undefined }).wiki?.pages[0]?.source_status).toBe('current');
    const calls = fs.readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(Array(3).fill({ monitor: 'false', cache: 'false', locks: '0' }));
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(index)).toEqual(before);
  } finally { child.kill(); await once(child, 'exit'); }
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
  expect(redactText('postgresql://user:pass@host/db token=hidden missing docs')).toBe('[credential-bearing line omitted]');
  expect(redactText('Bearer abcdefghijklmnopqrst ghp_abcdefghijklmnopqrst')).not.toContain('abcdefghijkl');
});

it('runs the source CLI without a backend and returns structured failures for operators', () => {
  const options = fixture();
  const cli = fileURLToPath(new URL('../src/engineering/summary-cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8' });
  const help = run('--help');
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('--wiki-database');
  fs.writeFileSync(options.config, JSON.stringify({ projectsRoot: '/repo', projects: { configured: {} }, password: 'PRIVATE_CONFIG_SECRET' }));
  const result = run('--config', options.config, '--database', options.database, '--wiki-database', options.wikiDatabase);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: 1, status: 'ok', configured_projects: ['/repo/configured'], sources: { projects: { status: 'ok' } } });
  expect(result.stdout).not.toContain('PRIVATE_CONFIG_SECRET');
  const missing = path.join(path.dirname(options.database), 'absent.sqlite');
  const partial = run('--database', options.database, '--wiki-database', missing);
  expect(partial.status).toBe(2);
  expect(JSON.parse(partial.stdout)).toMatchObject({ status: 'partial', wiki: null });
  expect(fs.existsSync(missing)).toBe(false);
  const badConfig = path.join(path.dirname(options.database), 'secret-config.json');
  fs.writeFileSync(badConfig, 'PRIVATE_SECRET_CONFIG');
  const invalid = run('--config', badConfig);
  expect(invalid.status).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ status: 'error', configured_projects: [], sources: { projects: { status: 'error' } } });
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

it('sanitizes wiki titles, descriptions, activity and failed database paths', () => {
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

it('redacts credential-key spelling, quoting, separators and line breaks through every permitted summary field', () => {
  const options = fixture();
  const db = new Database(options.database), wiki = new Database(options.wikiDatabase);
  const keys = redactionContract.property_keys;
  const marker = 'synthetic_matrix_private_value';
  let checked = 0;
  try {
    for (const key of keys) for (const quote of ['', "'", '"']) for (const separator of [':', '=']) for (const gap of [' ', '\n  ']) {
      const text = `${quote}${key}${quote}${separator}${gap}"${marker}"`;
      db.prepare('update coordination_assignments set description=?').run(text);
      db.prepare('update coordination_scopes set summary=?').run(text);
      wiki.prepare('update wiki_pages set title=?').run(text);
      expect(JSON.stringify(engineeringSummary(options)), `${key}/${quote}/${separator}/${gap.includes('\n') ? 'next' : 'same'}`)
        .not.toContain(marker);
      checked++;
    }
    expect(checked).toBe(keys.length * 3 * 2 * 2);
  } finally { db.close(); wiki.close(); }
}, 30_000);

it('publishes a real readable non-Git process as one unattributed session without a source fault', async () => {
  const options = fixture(), cwd = path.dirname(options.database);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    const identity = readProcessIdentity(child.pid!);
    const db = new Database(options.database);
    db.prepare("update coordination_assignments set provider='node',pid=?,process_start=? where id='live'").run(child.pid, identity!.start);
    db.prepare("update bound_sessions set provider='node',pid=? where id='session-live'").run(child.pid);
    db.close();
    const result = engineeringSummary({ ...options, processIdentity: undefined });
    expect(identity).toMatchObject({ cwd: null, unattributed: true });
    expect(result.status).toBe('ok');
    expect(result.agents.assignments?.find(a => a.id === 'live')).toMatchObject({ live_process: true, process_unattributed: true });
    expect(result.agents.sessions?.find(s => s.id === 'session-live')).toMatchObject({ live: true, unattributed: true });
    expect(result.agents.unattributed_sessions).toEqual([{ provider: 'node', assignment_id: 'live', session_id: 'session-live', description: 'Assignment live' }]);
  } finally { child.kill(); await once(child, 'exit'); }
});

it('deduplicates unattributed history assignments sharing one verified provider process', () => {
  const options = fixture();
  const db = new Database(options.database);
  db.prepare('insert into coordination_assignments values(?,?,?,?,?,?,?,?,?,?)')
    .run('earlier', 'codex', 'earlier-native', 'Earlier assignment', 'finished', 101, 'native-start', '2026-10-01T00:00:00Z', stamp, 'PRIVATE_TOKEN');
  db.close();
  const processIdentity = (pid: number) => pid === 101 ? { start: 'native-start', name: 'codex', cwd: null, unattributed: true } : null;
  const result = engineeringSummary({ ...options, processIdentity });
  expect(result.agents.unattributed_sessions).toEqual([{ provider: 'codex', assignment_id: 'live', session_id: 'session-live', description: 'Assignment live' }]);
});


it('exports only configured project paths and faults independently on missing or malformed configuration', () => {
  const options = fixture();
  const configuration = { projectsRoot: '/repo', projects: {
    fallback: { active: false, notes: 'PRIVATE_PROJECT_NOTES' },
    explicit: { path: '/elsewhere/checkout', providers: { token: 'PRIVATE_PROVIDER' } },
    duplicate: { path: '/elsewhere/checkout' },
  }, auth: { password: 'PRIVATE_CONFIG_AUTH' }, profiles: ['PRIVATE_PROFILE'] };
  fs.writeFileSync(options.config, JSON.stringify(configuration));
  const before = fs.readFileSync(options.config);
  const result = engineeringSummary(options);
  expect(result.configured_projects).toEqual(['/elsewhere/checkout', '/repo/fallback']);
  expect(result.sources.projects.status).toBe('ok');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(fs.readFileSync(options.config)).toEqual(before);
  for (const value of ['{', JSON.stringify({ projects: [] }), JSON.stringify({ projects: { bad: { path: 7 } } })]) {
    fs.writeFileSync(options.config, value);
    const failed = engineeringSummary(options);
    expect(failed.configured_projects).toEqual([]);
    expect(failed.sources.projects.status).toBe('error');
    expect(failed.sources.console.status).toBe('ok');
    expect(failed.status).toBe('partial');
  }
  fs.unlinkSync(options.config);
  expect(engineeringSummary(options).sources.projects.status).toBe('error');
  expect(fs.existsSync(options.config)).toBe(false);
});

it('exports retained yesterday update history in stable UTC order without substituting current summaries', () => {
  const options = fixture(), db = new Database(options.database);
  const insert = db.prepare('insert into coordination_events(assignment_id,checkout,kind,text,timestamp) values(?,?,?,?,?)');
  insert.run('live', '/repo/wt', 'update', 'Earlier retained result', '2026-10-14T00:00:00.000Z');
  insert.run('live', '/repo/wt', 'update', 'PASSWORD="synthetic_history_secret"', '2026-10-14T23:59:59.999Z');
  insert.run('live', '/repo/wt', 'message', 'PRIVATE_MESSAGE', '2026-10-14T12:00:00.000Z');
  insert.run('live', '/repo/wt', 'update', 'PRIVATE_PREVIOUS_DAY', '2026-10-13T23:59:59.999Z');
  db.close();
  const before = fs.readFileSync(options.database), result = engineeringSummary(options);
  expect(result.agents.activity_yesterday).toMatchObject({ date: '2026-10-14', timezone: 'UTC', total: 2, sampled: false });
  expect(result.agents.activity_yesterday?.items).toEqual([
    { id: 2, assignment_id: 'live', checkout: '/repo/wt', at: '2026-10-14T00:00:00.000Z', description: 'Assignment live', summary: 'Earlier retained result' },
    { id: 3, assignment_id: 'live', checkout: '/repo/wt', at: '2026-10-14T23:59:59.999Z', description: 'Assignment live', summary: '[credential-bearing line omitted]' },
  ]);
  expect(result.sources.activity.status).toBe('ok');
  expect(JSON.stringify(result)).not.toContain('synthetic_history_secret');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_PREVIOUS_DAY');
  expect(fs.readFileSync(options.database)).toEqual(before);
});

it('exports completion-only yesterday activity emitted by the real coordination service', () => {
  const options = fixture();
  options.database = path.join(path.dirname(options.database), 'completion.sqlite');
  const db = new AppDatabase(options.database);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const service = new CoordinationService(db, { enabled: true, pilotPaths: [] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    const { assignmentId } = service.register({ provider: 'codex', token: 'private-test-token',
      nativeSessionId: 'completion-only', pid: process.pid, cwd: path.dirname(options.database) });
    vi.setSystemTime(new Date('2026-10-14T18:00:00Z'));
    service.finish(assignmentId!, 'Completed the review. PASSWORD=shortpass');
    expect(db.sqlite.prepare("select kind from coordination_events where assignment_id=? order by seq").all(assignmentId)).toEqual([{ kind: 'started' }, { kind: 'finished' }]);
  } finally { db.close(); vi.useRealTimers(); }
  const before = fs.readFileSync(options.database), result = engineeringSummary(options);
  expect(result.sources.activity.status).toBe('ok');
  expect(result.agents.activity_yesterday).toMatchObject({ date: '2026-10-14', timezone: 'UTC', total: 1, sampled: false });
  expect(result.agents.activity_yesterday?.items).toHaveLength(1);
  expect(result.agents.activity_yesterday?.items[0]).toMatchObject({ checkout: null,
    at: '2026-10-14T18:00:00.000Z', summary: '[credential-bearing line omitted]' });
  expect(JSON.stringify(result)).not.toContain('shortpass');
  expect(fs.readFileSync(options.database)).toEqual(before);
});

it('bounds yesterday history and keeps history failures separate from ownership', () => {
  const options = fixture(), db = new Database(options.database);
  const insert = db.prepare('insert into coordination_events(assignment_id,checkout,kind,text,timestamp) values(?,?,?,?,?)');
  db.transaction(() => { for (let i = 0; i < 1001; i++) insert.run('live', '/repo/wt', 'update', `Update ${i}`, '2026-10-14T12:00:00.000Z'); })();
  const result = engineeringSummary(options);
  expect(result.agents.activity_yesterday).toMatchObject({ total: 1001, sampled: true });
  expect(result.agents.activity_yesterday?.items).toHaveLength(1000);
  expect(result.agents.activity_yesterday?.items[0]?.summary).toBe('Update 0');
  db.exec('alter table coordination_events rename column text to unavailable'); db.close();
  const failed = engineeringSummary(options);
  expect(failed.agents.activity_yesterday).toBeNull();
  expect(failed.sources.activity.status).toBe('error');
  expect(failed.sources.console.status).toBe('ok');
  expect(failed.agents.assignments?.find(a => a.id === 'live')?.live_process).toBe(true);
  expect(failed.status).toBe('partial');
});


it('redacts a bare Google API key containing both URL-safe punctuation characters through the full exporter', () => {
  const options = fixture(), db = new Database(options.database), wiki = new Database(options.wikiDatabase);
  const key = 'AIza' + 'AbCdEfGhIjKlMnOpQ' + '_' + 'rStUvWxYz0123456' + '-';
  expect(key).toHaveLength(39);
  db.prepare('update coordination_assignments set description=?').run(`Review ${key} diagnostics`);
  db.prepare('update coordination_scopes set summary=?').run(`Review ${key} diagnostics`);
  db.prepare('insert into coordination_events(assignment_id,checkout,kind,text,timestamp) values(?,?,?,?,?)')
    .run('live', '/repo/wt', 'update', `Review ${key} diagnostics`, '2026-10-14T12:00:00.000Z');
  wiki.prepare('update wiki_pages set title=?').run(`Review ${key} diagnostics`);
  db.close(); wiki.close();
  const result = JSON.stringify(engineeringSummary(options));
  expect(result).not.toContain(key);
  expect(result).not.toContain('AbCdEfGhIjKlMnOpQ');
  expect(result).not.toContain('rStUvWxYz0123456');
});


it('retains source IDs when distinct wiki queries and titles redact to identical labels', () => {
  const options = fixture(), wiki = new Database(options.wikiDatabase);
  for (const [id, secret] of [[6, 'synthetic_wiki_first'], [7, 'synthetic_wiki_second']] as const) {
    const title = `TOKEN="${secret}"`;
    wiki.prepare('insert into wiki_access values(?,?,?,?,?,?,?,?,?)').run(id, '/repo/.git', 'codex:searcher', 'search', 0, stamp, null, title, null);
    wiki.prepare('insert into wiki_pages values(?,?,?,?,?)').run('/repo/.git', `page-${id}`, title, id, stamp);
    wiki.prepare('insert into wiki_revisions values(?,?,?,?,?,?,?,?,?,?,?)').run(id, '/repo/.git', `page-${id}`, title, 'PRIVATE_BODY', 'PRIVATE_SUMMARY', 'codex:author', '/repo/wt', 'main', 'source', stamp);
  }
  wiki.prepare('insert into wiki_access values(?,?,?,?,?,?,?,?,?)').run(8, '/repo/.git', 'codex:searcher', 'search', 0, stamp, null, 'TOKEN="synthetic_wiki_first"', null);
  wiki.close();
  const result = engineeringSummary(options), searches = result.wiki!.no_result_searches;
  expect(searches.filter(s => [6, 7].includes(s.id)).map(s => s.id).sort()).toEqual([6, 7]);
  expect(searches.find(s => s.id === 6)?.count).toBe(2);
  expect(searches.find(s => s.id === 7)?.count).toBe(1);
  expect(new Set(searches.map(s => s.id)).size).toBe(searches.length);
  expect(new Set(result.wiki!.pages.map(p => p.revision)).size).toBe(3);
  expect(result.wiki!.pages.filter(p => [6,7].includes(p.revision)).map(p => p.title)).toEqual(['[credential-bearing line omitted]', '[credential-bearing line omitted]']);
  expect(JSON.stringify(result)).not.toContain('synthetic_wiki_');
});


it('uses pure backend defaults for omitted projects and databasePath without initializing services', () => {
  const options = fixture(), home = path.join(path.dirname(options.database), 'home');
  const config = { projectsRoot: '/repo', security: { passwordHash: 'PRIVATE_CONFIG_HASH', sessionSecret: 'PRIVATE_CONFIG_SESSION_SECRET_VALUE' }, providers: {} };
  expect(appConfigSchema.parse(config).projects).toEqual({});
  expect(appConfigSchema.parse(config).databasePath).toBe('~/.local/share/agent-console/agent-console.sqlite');
  fs.writeFileSync(options.config, JSON.stringify(config));
  const direct = engineeringSummary(options);
  expect(direct.sources.projects.status).toBe('ok');
  expect(direct.configured_projects).toEqual([]);
  const defaultDatabase = path.join(home, '.local/share/agent-console/agent-console.sqlite');
  const defaultWiki = path.join(path.dirname(defaultDatabase), 'wiki/agent-wiki.sqlite');
  fs.mkdirSync(path.dirname(defaultWiki), { recursive: true });
  fs.copyFileSync(options.database, defaultDatabase); fs.copyFileSync(options.wikiDatabase, defaultWiki);
  const before = [options.config, defaultDatabase, defaultWiki].map(p => fs.readFileSync(p));
  const cli = fileURLToPath(new URL('../src/engineering/summary-cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, '--config', options.config], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ok', configured_projects: [], sources: { projects: { status: 'ok' }, console: { status: 'ok' } } });
  expect(result.stdout + result.stderr).not.toContain('PRIVATE_CONFIG_');
  [options.config, defaultDatabase, defaultWiki].forEach((p, i) => expect(fs.readFileSync(p)).toEqual(before[i]));
});


it('isolates malformed wiki pages and search topics while retaining valid source rows', () => {
  const options = fixture(), wiki = new Database(options.wikiDatabase);
  wiki.prepare('update wiki_pages set title=?').run(Buffer.from('PRIVATE_BAD_PAGE'));
  wiki.prepare('insert into wiki_pages values(?,?,?,?,?)').run('/repo/.git', 'orphan', 'Missing source revision', 99, stamp);
  wiki.prepare('insert into wiki_pages values(?,?,?,?,?)').run('/repo/.git', 'valid', 'Valid retained page', 9, stamp);
  wiki.prepare('insert into wiki_revisions values(?,?,?,?,?,?,?,?,?,?,?)').run(9, '/repo/.git', 'valid', 'Valid retained page', 'PRIVATE_BODY', 'PRIVATE_SUMMARY', 'codex:author', '/repo/wt', 'main', 'source', stamp);
  wiki.prepare('insert into wiki_access values(?,?,?,?,?,?,?,?,?)').run(10, '/repo/.git', 'codex:searcher', 'search', 0, stamp, null, Buffer.from('PRIVATE_BAD_QUERY'), null);
  wiki.close();
  const result = engineeringSummary(options);
  expect(result.sources.wiki.status).toBe('partial');
  expect(result.wiki?.pages.map(p => p.title)).toEqual(['Valid retained page']);
  expect(result.issues.find(i => i.code === 'wiki_pages:INVALID_ITEM')?.message).toContain('2 malformed wiki_pages');
  expect(result.wiki?.no_result_searches.map(q => q.id)).toEqual([5]);
  expect(result.sources.console.status).toBe('ok');
  expect(result.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'wiki', code: 'wiki_pages:INVALID_ITEM' }),
    expect.objectContaining({ source: 'wiki', code: 'wiki_searches:INVALID_ITEM' }),
  ]));
  expect(JSON.stringify(result)).not.toContain('PRIVATE_BAD_');
});

it.each(['assignment', 'session', 'scope'] as const)('retains valid positive ownership and reports a malformed %s row', (kind) => {
  const options = fixture(), db = new Database(options.database);
  if (kind === 'assignment') db.prepare("update coordination_assignments set description=? where id='old'").run(Buffer.from('PRIVATE_BAD_DESCRIPTION'));
  if (kind === 'session') db.prepare("update bound_sessions set project_slug=? where id='session-stale'").run(Buffer.from('PRIVATE_BAD_PROJECT'));
  if (kind === 'scope') db.prepare("update coordination_scopes set summary=? where assignment_id='old'").run(Buffer.from('PRIVATE_BAD_SCOPE'));
  db.close();
  const result = engineeringSummary(options);
  expect(result.sources.console.status).toBe('partial');
  expect(result.agents.assignments?.find(a => a.id === 'live')).toMatchObject({ live_process: true, process_checkout: '/repo/wt' });
  expect(result.agents.sessions?.find(s => s.id === 'session-live')).toMatchObject({ live: true, checkout: '/repo/wt' });
  expect(result.sources.wiki.status).toBe('ok');
  expect(result.issues.some(i => i.code.endsWith(':INVALID_ITEM'))).toBe(true);
});

it('isolates a process lookup failure while retaining other verified live owners', () => {
  const options = fixture(), lookup = options.processIdentity;
  const result = engineeringSummary({ ...options, processIdentity: pid => { if (pid === 101) throw new Error('PRIVATE_PROCESS_ERROR'); return lookup(pid); } });
  expect(result.sources.console.status).toBe('partial');
  expect(result.agents.assignments?.find(a => a.id === 'wait')).toMatchObject({ live_process: true, process_checkout: '/repo/wait' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_PROCESS_ERROR');
});

it('isolates malformed wake and grant records without discarding valid measurements', () => {
  const options = fixture(), db = new Database(options.database);
  db.prepare('insert into meta values(?,?)').run('peer-wake-attempt:bad', 'PRIVATE_BAD_WAKE_JSON');
  db.prepare("update agent_grants set definition_json=? where id='expired'").run('PRIVATE_BAD_GRANT_JSON');
  db.close();
  const result = engineeringSummary(options);
  expect(result.agents.wakes?.failed).toBe(1);
  expect(result.agents.grants?.items.map(g => g.id)).toEqual(['grant']);
  expect(result.sources.console.status).toBe('partial');
  expect(result.sources.console.issues.filter(i => /^(wakes|grants):/.test(i.code))).toHaveLength(2);
  expect(result.sources.console.issues.every(i => !i.message.includes('ownership evidence is incomplete'))).toBe(true);
  expect(result.agents.assignments?.find(a => a.id === 'live')).toMatchObject({ live_process: true, process_checkout: '/repo/wt' });
  expect(result.agents.sessions?.find(s => s.id === 'session-live')).toMatchObject({ live: true, checkout: '/repo/wt' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_BAD_');
});

it('isolates malformed historical activity while keeping its source independent of live ownership', () => {
  const options = fixture(), db = new Database(options.database);
  const insert = db.prepare('insert into coordination_events(assignment_id,checkout,kind,text,timestamp) values(?,?,?,?,?)');
  insert.run('live', '/repo/wt', 'update', 'Valid yesterday update', '2026-10-14T12:00:00.000Z');
  insert.run('live', '/repo/wt', 'update', Buffer.from('PRIVATE_BAD_HISTORY'), '2026-10-14T12:30:00.000Z');
  db.close();
  const result = engineeringSummary(options);
  expect(result.sources.activity.status).toBe('partial');
  expect(result.sources.console.status).toBe('ok');
  expect(result.agents.activity_yesterday?.items.map(i => i.summary)).toEqual(['Valid yesterday update']);
});


it('redacts every pinned provider vector through all permitted exporter text fields', () => {
  const options = fixture(), db = new Database(options.database), wiki = new Database(options.wikiDatabase);
  db.prepare('insert into coordination_events(assignment_id,checkout,kind,text,timestamp) values(?,?,?,?,?)').run('live', '/repo/wt', 'update', 'Initial', '2026-10-14T12:00:00.000Z');
  try {
    for (const vector of redactionContract.provider_cases) {
      db.prepare('update coordination_assignments set description=?').run(vector.input);
      db.prepare('update coordination_scopes set summary=?').run(vector.input);
      db.prepare("update coordination_events set text=? where timestamp='2026-10-14T12:00:00.000Z'").run(vector.input);
      wiki.prepare('update wiki_pages set title=?').run(vector.input);
      wiki.prepare("update wiki_access set query=? where action='search'").run(vector.input);
      const result = engineeringSummary(options);
      expect(JSON.stringify(result), vector.rule_id).not.toContain(vector.matched);
      expect(result.agents.counts?.total, vector.rule_id).toBe(4);
      expect(result.wiki?.pages, vector.rule_id).toHaveLength(1);
    }
  } finally { db.close(); wiki.close(); }
}, 120_000);

it('redacts CLI, environment and HTTP credentials through the complete source CLI output', () => {
  const options = fixture(), db = new Database(options.database), wiki = new Database(options.wikiDatabase);
  const cases = redactionContract.cases.filter(vector => vector.input.includes('shortpass') || vector.input.startsWith('glpat-') || ('matched' in vector && typeof vector.matched === 'string'));
  expect(cases.some(vector => vector.input.startsWith('redis-cli -a'))).toBe(true);
  expect(cases.some(vector => vector.input.startsWith('mysql -p'))).toBe(true);
  expect(cases.some(vector => vector.input.startsWith('machine '))).toBe(true);
  expect(cases.some(vector => vector.input.startsWith('db.example:5432:'))).toBe(true);
  const cli = fileURLToPath(new URL('../src/engineering/summary-cli.ts', import.meta.url));
  try {
    for (const vector of cases) {
      db.prepare('update coordination_assignments set description=?').run(vector.input);
      wiki.prepare('update wiki_pages set title=?').run(vector.input);
      const result = spawnSync(process.execPath, ['--import', 'tsx', cli, '--config', options.config, '--database', options.database, '--wiki-database', options.wikiDatabase], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.agents.assignments.map((a: { description: string }) => a.description)).toEqual(Array(4).fill(vector.expected));
      expect(output.wiki.pages[0].title).toBe(vector.expected);
      expect(result.stdout + result.stderr).not.toContain(vector.input);
    }
  } finally { db.close(); wiki.close(); }
}, 120_000);
