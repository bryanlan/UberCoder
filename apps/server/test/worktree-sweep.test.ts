import Database from 'better-sqlite3';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from '../src/db/schema.js';
import { processStart, runSweep, summarize, SNAPSHOT_EXPIRY_DAYS, SUPPORTED_SCHEMA_VERSIONS, type SweepReport, type WorktreeResult } from '../../../scripts/worktree-sweep.mjs';

const HOUR = 3_600_000;
const NOW = Date.now() + 48 * HOUR;
const TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# test cache\n';
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv });

let root: string;
let repo: string;
let wt: (name: string) => string;
let gitDir: (name: string) => string;
let db: Database.Database;
let sleeper: ChildProcess | undefined;
let exeSleeper: ChildProcess | undefined;

function write(file: string, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function addWorktree(name: string, options: { commit?: boolean; detached?: boolean; parent?: string } = {}) {
  const target = path.join(options.parent ?? path.join(root, 'repo-wt'), name);
  if (options.detached) git(repo, 'worktree', 'add', '-q', '--detach', target, 'main');
  else git(repo, 'worktree', 'add', '-q', target, '-b', name, 'main');
  if (options.commit) { write(path.join(target, `${name}.txt`)); git(target, 'add', '.'); git(target, 'commit', '-qm', name); }
  return target;
}

function cache(worktree: string, dir = 'target', tag = TAG) {
  write(path.join(worktree, dir, 'CACHEDIR.TAG'), tag);
  write(path.join(worktree, dir, 'debug', 'big.bin'), 'b'.repeat(4096));
}

function announce(name: string, assignment: string, status: string, nativeSessionId = `native-${assignment}`, pid = 0, start = '') {
  db.prepare('insert or ignore into coordination_assignments values(?,?,?,?,?,?,?,?,?,?)')
    .run(assignment, 'codex', nativeSessionId, 'hash', `Lane ${name}`, status, pid, start, 'start', 'seen');
  db.prepare('insert into coordination_scopes values(?,?,?,?)').run(assignment, wt(name), path.join(repo, '.git'), 'work');
}

function binding(id: string, conversationRef: string, resumeRef: string | null, status = 'bound') {
  db.prepare(`insert into bound_sessions (id, provider, project_slug, conversation_ref, resume_conversation_ref, tmux_session_name, status, should_restore, started_at, updated_at)
    values (?, 'codex', 'repo', ?, ?, ?, ?, 1, 'start', 'now')`).run(id, conversationRef, resumeRef, `tmux-${id}`, status);
}

function sweep(apply: boolean, extra: { configPath?: string } = {}): SweepReport {
  return runSweep({ configPath: extra.configPath ?? path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), apply, now: NOW });
}

const byName = (report: SweepReport) => new Map(report.worktrees.map((item: WorktreeResult) => [path.basename(item.path), item]));

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-sweep-')));
  repo = path.join(root, 'repo');
  wt = (name) => path.join(root, 'repo-wt', name);
  gitDir = (name) => git(wt(name), 'rev-parse', '--absolute-git-dir').trim();
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, '.gitignore'), 'target/\nvar/\n__pycache__/\n');
  write(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');

  db = new Database(path.join(root, 'console.sqlite'));
  migrateDatabase(db);
  write(path.join(root, 'config.json'), JSON.stringify({
    databasePath: path.join(root, 'console.sqlite'), projects: { repo: { path: repo } }, coordination: { pilotPaths: [] },
  }));

  for (const name of ['released', 'recent', 'locked', 'process', 'operation', 'private', 'hidden']) {
    addWorktree(name, { commit: true }); announce(name, `a-${name}`, 'finished');
  }
  cache(wt('released'));
  write(path.join(wt('released'), 'pkg', '__pycache__', 'm.pyc'));
  fs.utimesSync(path.join(gitDir('recent'), 'index'), new Date(NOW - HOUR), new Date(NOW - HOUR));
  git(repo, 'worktree', 'lock', wt('locked'));
  sleeper = spawn('sleep', ['120'], { cwd: wt('process'), stdio: 'ignore' });
  write(path.join(gitDir('operation'), 'MERGE_HEAD'), `${git(repo, 'rev-parse', 'main').trim()}\n`);
  write(path.join(gitDir('private'), 'config.worktree'), '[core]\n');
  git(wt('hidden'), 'update-index', '--skip-worktree', 'a.txt');

  addWorktree('resumable', { commit: true }); announce('resumable', 'a-resumable', 'disconnected'); binding('b-resumable', 'old-ref', 'native-a-resumable');
  cache(wt('resumable'));
  addWorktree('pending', { commit: true }); announce('pending', 'a-pending', 'disconnected', 'native-unknown');
  binding('b-pending', 'pending:b-pending', null, 'starting');
  db.prepare('insert into meta values(?,?)').run('console-session:a-pending', 'b-pending');
  cache(wt('pending'));
  fs.utimesSync(path.join(gitDir('pending'), 'index'), new Date(NOW - HOUR), new Date(NOW - HOUR));
  // A running lane works from elsewhere; an open lane with no recorded process cannot be checked.
  addWorktree('live-lane', { commit: true }); cache(wt('live-lane'));
  const lanePid = sleeper!.pid!;
  announce('live-lane', 'a-live-lane', 'active', 'native-a-live-lane', lanePid, processStart(lanePid));
  binding('b-live-lane', 'native-a-live-lane', null);
  addWorktree('open-unchecked', { commit: true }); cache(wt('open-unchecked'));
  announce('open-unchecked', 'a-open-unchecked', 'waiting');
  binding('b-open-unchecked', 'native-a-open-unchecked', null);

  addWorktree('dirty', { commit: true }); announce('dirty', 'a-dirty', 'finished');
  write(path.join(wt('dirty'), 'unsaved.rs'), 'fn main() {}');
  cache(wt('dirty'));
  const outside = path.join(root, 'outside');
  write(path.join(outside, 'keep.txt'), 'outside');
  fs.symlinkSync(outside, path.join(wt('dirty'), 'target', 'debug', 'link'));

  addWorktree('evidence', { commit: true }); announce('evidence', 'a-evidence', 'finished');
  write(path.join(wt('evidence'), 'var', 'review.txt'), 'evidence');
  cache(wt('evidence'));

  addWorktree('badtag', { commit: true }); announce('badtag', 'a-badtag', 'finished');
  cache(wt('badtag'), 'target', 'Signature: not-a-cache\n');

  addWorktree('tracked-cache', { commit: true }); announce('tracked-cache', 'a-tracked', 'finished');
  cache(wt('tracked-cache'));
  write(path.join(wt('tracked-cache'), 'target', 'keep.txt'), 'tracked');
  git(wt('tracked-cache'), 'add', '-f', 'target/keep.txt');
  git(wt('tracked-cache'), 'commit', '-qm', 'tracked file under cache');
  write(path.join(wt('tracked-cache'), 'unsaved.txt'));

  addWorktree('reflog', { commit: true }); announce('reflog', 'a-reflog', 'finished');
  git(wt('reflog'), 'reset', '-q', '--hard', 'main');

  addWorktree('cache-note', { commit: true }); announce('cache-note', 'a-cache-note', 'finished');
  write(path.join(wt('cache-note'), '.gitignore'), 'target/*\n!target/notes.txt\nvar/\n__pycache__/\n');
  git(wt('cache-note'), 'commit', '-qam', 'ignore exception');
  cache(wt('cache-note'));
  write(path.join(wt('cache-note'), 'target', 'notes.txt'), 'notes');

  addWorktree('exe', { commit: true }); announce('exe', 'a-exe', 'finished');
  cache(wt('exe'));
  fs.copyFileSync('/bin/sleep', path.join(wt('exe'), 'target', 'debug', 'sleeper'));
  fs.chmodSync(path.join(wt('exe'), 'target', 'debug', 'sleeper'), 0o755);
  exeSleeper = spawn(path.join(wt('exe'), 'target', 'debug', 'sleeper'), ['120'], { cwd: root, argv0: 'sleeper', stdio: 'ignore' });

  addWorktree('unannounced-unique', { commit: true });
  addWorktree('unannounced-merged');
  addWorktree('detached', { detached: true });
  addWorktree('elsewhere', { commit: true, parent: path.join(root, 'scratch') }); announce('elsewhere', 'a-elsewhere', 'finished');
  db.close();
});

afterAll(() => {
  sleeper?.kill();
  exeSleeper?.kill();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('worktree sweep', () => {
  it('reviews the current Console schema', () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(CURRENT_SCHEMA_VERSION);
  });

  it('classifies without changing anything on a dry run', () => {
    const report = sweep(false);
    expect(report.usable).toBe(true);
    const states = Object.fromEntries([...byName(report)].map(([name, item]) => [name, `${item.state}/${item.action}`]));
    expect(states).toEqual({
      released: 'removable/remove', recent: 'recent/none', locked: 'locked/none', process: 'in-use/none',
      operation: 'git-operation/none', private: 'private-git-state/none', hidden: 'hidden-index/none',
      resumable: 'resumable/reclaim-cache', pending: 'resumable/none', 'live-lane': 'in-use/none', 'open-unchecked': 'in-use/none',
      dirty: 'dirty/reclaim-cache', evidence: 'local-files/reclaim-cache',
      badtag: 'local-files/none', 'tracked-cache': 'dirty/none', reflog: 'reflog-only-commits/none',
      'unannounced-unique': 'unreleased/none', 'unannounced-merged': 'removable/remove', detached: 'detached/none',
      elsewhere: 'unmanaged/none', 'cache-note': 'dirty/none', exe: 'in-use/none',
    });
    expect(fs.existsSync(wt('released'))).toBe(true);
    expect(fs.existsSync(path.join(wt('dirty'), 'target'))).toBe(true);
  });

  it('removes released worktrees, keeps branches and reclaims only verified caches', () => {
    const report = byName(sweep(true));
    for (const name of ['released', 'unannounced-merged']) {
      expect(report.get(name)?.outcome).toBe('removed');
      expect(fs.existsSync(wt(name))).toBe(false);
      expect(git(repo, 'branch', '--list', name).trim()).toContain(name);
      expect(report.get(name)?.recovery).toBe(`git -C ${repo} worktree add -- ${wt(name)} ${name}`);
    }
    expect(fs.readdirSync(path.join(root, 'repo-wt')).filter((name) => name.startsWith('.retiring-'))).toEqual([]);

    expect(report.get('dirty')?.outcome).toBe('reclaimed target');
    expect(fs.existsSync(path.join(wt('dirty'), 'target'))).toBe(false);
    expect(fs.readFileSync(path.join(wt('dirty'), 'unsaved.rs'), 'utf8')).toBe('fn main() {}');
    expect(fs.readFileSync(path.join(root, 'outside', 'keep.txt'), 'utf8')).toBe('outside');

    expect(report.get('evidence')?.outcome).toBe('reclaimed target');
    expect(fs.readFileSync(path.join(wt('evidence'), 'var', 'review.txt'), 'utf8')).toBe('evidence');

    expect(report.get('resumable')?.outcome).toBe('reclaimed target');
    expect(fs.existsSync(path.join(wt('resumable'), 'target'))).toBe(false);
    expect(fs.existsSync(path.join(wt('resumable'), 'resumable.txt'))).toBe(true);
    for (const name of ['pending', 'live-lane', 'open-unchecked']) expect(fs.existsSync(path.join(wt(name), 'target', 'debug', 'big.bin')), name).toBe(true);

    expect(report.get('tracked-cache')?.outcome).toBeUndefined();
    expect(fs.readFileSync(path.join(wt('tracked-cache'), 'target', 'keep.txt'), 'utf8')).toBe('tracked');
    expect(fs.existsSync(path.join(wt('badtag'), 'target', 'debug', 'big.bin'))).toBe(true);
    expect(fs.readFileSync(path.join(wt('cache-note'), 'target', 'notes.txt'), 'utf8')).toBe('notes');
    expect(fs.existsSync(path.join(wt('exe'), 'target', 'debug', 'sleeper'))).toBe(true);

    for (const name of ['recent', 'locked', 'process', 'operation', 'private', 'hidden', 'pending', 'live-lane', 'open-unchecked', 'reflog', 'unannounced-unique', 'detached']) {
      expect(fs.existsSync(wt(name)), name).toBe(true);
      expect(report.get(name)?.outcome, name).toBeUndefined();
    }
    expect(fs.existsSync(path.join(root, 'scratch', 'elsewhere'))).toBe(true);
  });

  it('moves a worktree back when it changes while quarantined', () => {
    const target = addWorktree('late-write');
    const report = runSweep({
      configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), apply: true, now: NOW,
      repoFilter: [repo], onQuarantine: (quarantine) => write(path.join(quarantine, 'late.rs'), 'saved late'),
    });
    expect(byName(report).get('late-write')?.outcome).toMatch(/^skipped after quarantine: now dirty/);
    expect(fs.readdirSync(path.join(root, 'repo-wt')).filter((name) => name.startsWith('.retiring-'))).toEqual([]);
    expect(fs.readFileSync(path.join(target, 'late.rs'), 'utf8')).toBe('saved late');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${target}\n`);
  });

  it('refuses protected entries inside disposable directories and restores the worktree', () => {
    const cacheHolder = addWorktree('secret-in-cache', { commit: true });
    write(path.join(cacheHolder, 'unsaved.txt'));
    cache(cacheHolder);
    write(path.join(cacheHolder, 'target', 'debug', '.env.local'), 'TOKEN=1');
    const removable = addWorktree('secret-in-pycache');
    const report = byName(runSweep({
      configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), apply: true, now: NOW, repoFilter: [repo],
      onQuarantine: (quarantine) => write(path.join(quarantine, 'pkg', '__pycache__', '.env'), 'TOKEN=2'),
    }));
    expect(report.get('secret-in-cache')?.outcome).toMatch(/^refused: protected entry at .*\.env\.local$/);
    expect(fs.readFileSync(path.join(cacheHolder, 'target', 'debug', '.env.local'), 'utf8')).toBe('TOKEN=1');
    expect(report.get('secret-in-pycache')?.outcome).toMatch(/^skipped after quarantine: protected entry at/);
    expect(fs.readFileSync(path.join(removable, 'pkg', '__pycache__', '.env'), 'utf8')).toBe('TOKEN=2');
  });

  it('keeps a worktree whose only reference to a commit is an old reflog entry', () => {
    const target = addWorktree('old-reflog', { commit: true });
    const unique = git(target, 'rev-parse', 'HEAD').trim();
    git(target, 'reset', '-q', '--hard', 'main');
    const reflog = path.join(git(target, 'rev-parse', '--absolute-git-dir').trim(), 'logs', 'HEAD');
    const lines = fs.readFileSync(reflog, 'utf8').trim().split('\n');
    fs.writeFileSync(reflog, `${lines.at(-1)}\n`);
    expect(fs.readFileSync(reflog, 'utf8').split(' ')[0]).toBe(unique);
    expect(byName(sweep(false)).get('old-reflog')?.state).toBe('reflog-only-commits');
  });

  it('reclaims every cache in a worktree at the real clock, ignoring its own deletions', () => {
    const target = addWorktree('two-caches');
    const old = new Date(Date.now() - 72 * HOUR);
    write(path.join(target, '.gitignore'), 'target/\nvar/\n__pycache__/\n.tool-cache/\n');
    execFileSync('git', ['-C', target, 'commit', '-qam', 'ignore tool cache'], { env: { ...gitEnv, GIT_COMMITTER_DATE: old.toISOString(), GIT_AUTHOR_DATE: old.toISOString() } });
    write(path.join(target, 'unsaved.txt'));
    cache(target, '.tool-cache');
    cache(target);
    const backdate = (entry: string) => {
      const stat = fs.lstatSync(entry);
      if (stat.isDirectory() && path.basename(entry) !== '.git') for (const child of fs.readdirSync(entry)) backdate(path.join(entry, child));
      if (!stat.isSymbolicLink()) fs.utimesSync(entry, old, old);
    };
    backdate(target);
    const gitDirectory = git(target, 'rev-parse', '--absolute-git-dir').trim();
    for (const name of ['HEAD', 'index', 'logs/HEAD']) fs.utimesSync(path.join(gitDirectory, name), old, old);
    const report = byName(runSweep({ configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), apply: true, repoFilter: [repo] }));
    expect(report.get('two-caches')?.outcome).toMatch(/^reclaimed (\.tool-cache, target|target, \.tool-cache)$/);
    expect(fs.existsSync(path.join(target, 'unsaved.txt'))).toBe(true);
  });

  it('moves a worktree stranded in quarantine by an interrupted sweep back to its path', () => {
    const target = addWorktree('stranded', { commit: true });
    // A live process now holds the recorded PID, but its start time differs: still stranded.
    const stranded = path.join(root, 'repo-wt', `.retiring-stranded-${process.pid}-1`);
    git(repo, 'worktree', 'move', target, stranded);
    expect(byName(sweep(false)).get(path.basename(stranded))?.state).toBe('quarantined');
    const report = runSweep({ configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), apply: true, now: NOW, repoFilter: [repo] });
    expect(report.restored).toEqual([{ path: target, outcome: `restored from ${stranded}` }]);
    expect(fs.existsSync(path.join(target, 'stranded.txt'))).toBe(true);
    expect(fs.existsSync(stranded)).toBe(false);
  });

  it('changes nothing when the Console schema is not one it was reviewed for', () => {
    const target = addWorktree('schema-check');
    const copy = path.join(root, 'future.sqlite');
    fs.copyFileSync(path.join(root, 'console.sqlite'), copy);
    const future = new Database(copy);
    future.prepare('insert into schema_version values(?,?,?)').run(999, 'future', 'now');
    future.close();
    write(path.join(root, 'future.json'), JSON.stringify({ databasePath: copy, projects: { repo: { path: repo } } }));
    const report = sweep(true, { configPath: path.join(root, 'future.json') });
    expect(report.usable).toBe(false);
    expect(report.consoleState).toMatch(/schema version 999/);
    expect(byName(report).get('schema-check')?.state).toBe('in-use');
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('branch retirement', () => {
  let branches: string;
  let config: string;
  const at = (date: Date) => ({ ...gitEnv, GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() });
  const commitOn = (branch: string, file: string, env = gitEnv) => {
    git(branches, 'switch', '-q', branch);
    write(path.join(branches, file), file);
    git(branches, 'add', '.');
    execFileSync('git', ['-C', branches, 'commit', '-qm', file], { env });
    git(branches, 'switch', '-q', 'main');
  };
  const run = (apply: boolean, extra: { now?: number; onQuarantine?: (quarantine: string) => void; onBranchDelete?: (branch: { branch: string | null }, stage: 'checks' | 'transaction') => void } = {}) =>
    runSweep({ configPath: config, reportDir: path.join(root, 'branch-reports'), apply, now: NOW, ...extra });
  const states = (report: SweepReport) => Object.fromEntries(report.branches.map((item) => [item.branch, `${item.state}/${item.action}`]));

  beforeAll(() => {
    branches = path.join(root, 'branches');
    const origin = path.join(root, 'branches-origin.git');
    fs.mkdirSync(branches);
    git(branches, 'init', '-q', '-b', 'main');
    write(path.join(branches, 'base.txt'));
    git(branches, 'add', '.');
    git(branches, 'commit', '-qm', 'base');
    git(root, 'init', '-q', '--bare', origin);
    git(branches, 'remote', 'add', 'origin', origin);
    for (const name of ['landed-main', 'pushed-only', 'in-integration', 'integration', 'same-changes', 'merge-commit', 'side', 'unique', 'checked', 'tracked-base', 'tracker', 'tagged', 'gc-rewritten', 'late-checkout', 'reset-lane', 'rebasing', 'renamed-push', 'landed-$dollar', 'held-base', 'stacked']) {
      git(branches, 'branch', name, 'main');
    }
    commitOn('landed-main', 'landed-main.txt');
    git(branches, 'merge', '-q', '--ff-only', 'landed-main');
    for (const name of ['pushed-only', 'in-integration', 'unique', 'checked', 'tagged', 'gc-rewritten', 'late-checkout', 'tracked-base']) commitOn(name, `${name}.txt`);
    git(branches, 'switch', '-q', 'integration');
    git(branches, 'merge', '-q', '--no-edit', 'in-integration');
    git(branches, 'switch', '-q', 'main');
    git(branches, 'push', '-q', 'origin', 'main', 'pushed-only', 'integration');
    git(branches, 'branch', '-D', '-q', 'integration');
    commitOn('same-changes', 'same-changes.txt');
    commitOn('side', 'side.txt');
    git(branches, 'switch', '-q', 'merge-commit');
    git(branches, 'merge', '-q', '--no-ff', '--no-edit', 'side');
    git(branches, 'switch', '-q', 'main');
    git(branches, 'cherry-pick', 'same-changes', 'side');
    git(branches, 'tag', 'v1', 'tagged');
    // A lane reset back to main keeps its old tip only in the branch reflog.
    commitOn('reset-lane', 'reset-lane.txt');
    git(branches, 'branch', '-f', 'reset-lane', 'main');
    git(branches, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/landed-main');
    // A configured upstream deleted on the remote leaves only branch configuration behind.
    git(branches, 'branch', 'gone-upstream', 'main');
    commitOn('gone-upstream', 'gone-upstream.txt');
    git(branches, 'push', '-q', 'origin', 'gone-upstream:gone-remote');
    git(branches, 'branch', '-q', '--set-upstream-to=origin/gone-remote', 'gone-upstream');
    git(branches, 'push', '-q', 'origin', '--delete', 'gone-remote');
    git(branches, 'branch', '--set-upstream-to=tracked-base', 'tracker');
    git(branches, 'worktree', 'add', '-q', path.join(root, 'branches-wt', 'checked'), 'checked');
    for (const name of ['rebasing', 'renamed-push', 'landed-$dollar', 'held-base', 'stacked']) commitOn(name, `${name.replace('$', '')}.txt`);
    // Pushed under another name and tracked only by this branch: its own copy, not a landing.
    git(branches, 'push', '-q', 'origin', 'renamed-push:published');
    git(branches, 'branch', '-q', '--set-upstream-to=origin/published', 'renamed-push');
    git(branches, 'merge', '-q', '--no-edit', 'checked', 'gc-rewritten', 'late-checkout', 'rebasing', 'landed-$dollar', 'stacked');
    // A paused rebase detaches its worktree's HEAD but still owns the branch.
    const rebasing = path.join(root, 'branches-wt', 'rebasing');
    git(branches, 'worktree', 'add', '-q', rebasing, 'rebasing');
    execFileSync('git', ['-C', rebasing, 'rebase', '-q', '-i', 'HEAD~1'], { env: { ...gitEnv, GIT_SEQUENCE_EDITOR: "sed -i '1i break'" } });
    // `rebase --update-refs` also reserves the stack branches it will move.
    const stacked = git(branches, 'rev-parse', 'stacked').trim();
    write(path.join(git(rebasing, 'rev-parse', '--absolute-git-dir').trim(), 'rebase-merge', 'update-refs'), `refs/heads/stacked\n${stacked}\n${stacked}\n`);
    // A checked-out snapshot holds an ordinary branch's commits but is no kept ref: it expires.
    git(branches, 'branch', 'snapshot/held', 'held-base');
    commitOn('snapshot/held', 'held-remainder.txt');
    git(branches, 'worktree', 'add', '-q', path.join(root, 'branches-wt', 'snapshot-held'), 'snapshot/held');
    // `git gc` rewrites every reflog file; only the entries' own times show activity.
    const reflog = path.join(branches, '.git', 'logs', 'refs', 'heads', 'gc-rewritten');
    fs.utimesSync(reflog, new Date(NOW - HOUR), new Date(NOW - HOUR));

    const old = new Date(NOW - (SNAPSHOT_EXPIRY_DAYS + 1) * 24 * HOUR);
    for (const [name, base, env] of [['snapshot/base-merged', 'landed-main', gitEnv], ['worktree-snapshot/young', 'unique', gitEnv], ['snapshot/old', 'unique', at(old)], ['snapshot/tagged-old', 'in-integration', at(old)]] as const) {
      git(branches, 'branch', name, base);
      commitOn(name, `${name.replace('/', '-')}-remainder.txt`, env);
    }
    for (const name of ['old', 'tagged-old']) {
      const reflogOld = path.join(branches, '.git', 'logs', 'refs', 'heads', 'snapshot', name);
      fs.writeFileSync(reflogOld, fs.readFileSync(reflogOld, 'utf8').replace(/ (\d{10}) ([+-]\d{4})\t/g, ` ${Math.floor(old.getTime() / 1000)} $2\t`));
    }
    git(branches, 'tag', 'keep-old', 'snapshot/tagged-old');

    git(branches, 'worktree', 'add', '-q', path.join(root, 'branches-wt', 'released'), '-b', 'released-lane', 'main');
    config = path.join(root, 'branches-config.json');
    write(config, JSON.stringify({ databasePath: path.join(root, 'console.sqlite'), projects: { branches: { path: branches } }, coordination: { pilotPaths: [] } }));
  });

  it('deletes only branches whose commits a kept ref holds, and expired snapshots', () => {
    const report = run(false);
    expect(states(report)).toEqual({
      main: 'checked-out/none', 'landed-main': 'protected/none', 'pushed-only': 'unlanded/none', 'in-integration': 'landed/delete',
      'same-changes': 'unlanded/none', side: 'unlanded/none', 'merge-commit': 'unlanded/none', unique: 'unlanded/none',
      checked: 'checked-out/none', 'tracked-base': 'protected/none', tracker: 'landed/delete', tagged: 'landed/delete',
      'gc-rewritten': 'landed/delete', 'late-checkout': 'landed/delete', 'released-lane': 'checked-out/none',
      'snapshot/base-merged': 'snapshot-expired/delete', 'worktree-snapshot/young': 'snapshot/none', 'snapshot/old': 'snapshot-expired/delete',
      'gone-upstream': 'unlanded/none', 'reset-lane': 'reflog-only-commits/none', alias: 'protected/none',
      rebasing: 'checked-out/none', 'renamed-push': 'unlanded/none', 'landed-$dollar': 'landed/delete',
      stacked: 'checked-out/none', 'held-base': 'unlanded/none', 'snapshot/held': 'checked-out/none', 'snapshot/tagged-old': 'landed/delete',
    });
    const reasons = Object.fromEntries(report.branches.map((item) => [item.branch, item.reason]));
    expect(reasons['in-integration']).toBe('Its commits are already in origin/integration.');
    expect(reasons['pushed-only']).toBe('Only its own remote copy origin/pushed-only holds its commits; pushing is not landing.');
    expect(reasons.unique).toBe('Has commits no kept branch holds.');
    expect(reasons.alias).toBe('Symbolic ref to landed-main.');
    expect(reasons['renamed-push']).toBe('Only its own remote copy origin/published holds its commits; pushing is not landing.');
    expect(reasons['landed-main']).toBe('A symbolic ref points to it.');
    expect(reasons.tagged).toBe('Its commits are already in tag v1.');
    expect(reasons['snapshot/base-merged']).toBe('Snapshot whose base is now in main.');
    expect(reasons['snapshot/old']).toBe(`Snapshot older than ${SNAPSHOT_EXPIRY_DAYS} days.`);
    expect(summarize(report)).toContain('28 local branches: delete 7 landed and 2 expired snapshots; keep 8 unlanded and 1 snapshots');
    expect(git(branches, 'branch', '--list', 'landed-main').trim()).toContain('landed-main');
  });

  it('keeps branches updated within the cooldown', () => {
    const report = run(false, { now: Date.now() });
    expect(report.branches.find((item) => item.branch === 'tracker')?.state).toBe('recent');
    // Only the backdated snapshot is idle at the real clock.
    expect(report.branches.filter((item) => item.action === 'delete').map((item) => item.branch)).toEqual(['snapshot/tagged-old']);
  });

  it('applies deletions after a fresh check, skipping a branch that changed or lost its kept ref', () => {
    const lateCheckout = path.join(root, 'branches-wt', 'late');
    // An unwritable refs directory makes one deletion fail for a reason other than a concurrent change.
    const heads = path.join(branches, '.git', 'refs', 'heads');
    const moved = () => git(branches, 'commit-tree', `${git(branches, 'rev-parse', 'tagged').trim()}^{tree}`, '-p', 'tagged', '-m', 'moved').trim();
    let movedTo = '';
    const trackerSha = git(branches, 'rev-parse', 'tracker').trim();
    const report = run(true, {
      onQuarantine: () => {
        if (!fs.existsSync(lateCheckout)) git(branches, 'worktree', 'add', '-q', lateCheckout, 'late-checkout');
        // The tag that first justified deleting this snapshot goes; its age alone now decides.
        if (git(branches, 'tag', '--list', 'keep-old').trim()) git(branches, 'tag', '-d', 'keep-old');
      },
      // Races in the instant before deletion: a branch moves, and a fetch prunes the only kept ref holding another.
      onBranchDelete: ({ branch }, stage) => {
        if (stage === 'checks') {
          // A commit and a reset back to the assessed tip leave the SHA equal but add reflog history.
          if (branch === 'tracker') { git(branches, 'update-ref', 'refs/heads/tracker', moved()); git(branches, 'update-ref', 'refs/heads/tracker', trackerSha); }
          return;
        }
        fs.chmodSync(heads, branch === 'gc-rewritten' ? 0o555 : 0o755);
        // A move that leaves no reflog entry reaches the transaction, whose old-value check refuses it.
        if (branch === 'tagged') { movedTo = moved(); fs.writeFileSync(path.join(heads, 'tagged'), `${movedTo}\n`); }
        if (branch === 'in-integration') git(branches, 'update-ref', '-d', 'refs/remotes/origin/integration');
      },
    });
    fs.chmodSync(heads, 0o755);
    expect(report.worktrees.find((item) => item.branch === 'released-lane')?.outcome).toBe('removed');
    const outcomes = Object.fromEntries(report.branches.filter((item) => item.action === 'delete').map((item) => [item.branch, item.outcome]));
    expect(outcomes['late-checkout']).toBe('skipped: now checked-out (Checked out in a worktree, or held by a rebase or bisect in progress.)');
    expect(outcomes.tagged).toMatch(/^skipped: changed during deletion: /);
    expect(outcomes['in-integration']).toMatch(/^skipped: changed during deletion: /);
    expect(outcomes['gc-rewritten']).toMatch(/^failed: .*Permission denied/);
    expect(outcomes.tracker).toBe('skipped: reflog changed since assessment');
    expect(git(branches, 'rev-parse', 'tagged').trim()).toBe(movedTo);
    expect(report.branches.find((item) => item.branch === 'in-integration')?.witness?.ref).toBe('refs/remotes/origin/integration');
    const deleted = Object.keys(outcomes).filter((name) => outcomes[name] === 'deleted').sort();
    expect(deleted).toEqual(['landed-$dollar', 'snapshot/base-merged', 'snapshot/old', 'snapshot/tagged-old']);
    expect(report.branches.find((item) => item.branch === 'snapshot/tagged-old')).toMatchObject({ state: 'snapshot-expired', reason: `Snapshot older than ${SNAPSHOT_EXPIRY_DAYS} days.`, witness: null });
    const remaining = git(branches, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').trim().split('\n').sort();
    expect(remaining).toEqual(['alias', 'checked', 'gc-rewritten', 'gone-upstream', 'held-base', 'in-integration', 'landed-main', 'late-checkout', 'main', 'merge-commit', 'pushed-only', 'rebasing', 'released-lane', 'renamed-push', 'reset-lane', 'same-changes', 'side', 'snapshot/held', 'stacked', 'tagged', 'tracked-base', 'tracker', 'unique', 'worktree-snapshot/young']);
    // Deletion also removes the branch's reflog and configuration, as `git branch -D` would.
    expect(fs.existsSync(path.join(branches, '.git', 'logs', 'refs', 'heads', 'snapshot', 'old'))).toBe(false);
    // The recorded command is quoted: `$` in a branch name must not expand.
    const landed = report.branches.find((item) => item.branch === 'landed-$dollar')!;
    expect(landed.recovery).toBe(`git -C ${branches} branch -- 'landed-$dollar' ${landed.sha}`);
    execFileSync('sh', ['-c', landed.recovery!], { env: gitEnv });
    expect(git(branches, 'rev-parse', 'landed-$dollar').trim()).toBe(landed.sha);
  });
});

describe('branch assessment failures', () => {
  it('reports a repository whose branches cannot be read as a failure', () => {
    const broken = path.join(root, 'broken-refs');
    fs.mkdirSync(broken);
    git(broken, 'init', '-q', '-b', 'main');
    git(broken, 'commit', '-q', '--allow-empty', '-m', 'base');
    write(path.join(broken, '.git', 'refs', 'heads', 'missing-object'), `${'1'.repeat(40)}\n`);
    const config = path.join(root, 'broken-config.json');
    write(config, JSON.stringify({ databasePath: path.join(root, 'console.sqlite'), projects: { broken: { path: broken } }, coordination: { pilotPaths: [] } }));
    const report = runSweep({ configPath: config, reportDir: path.join(root, 'broken-reports'), apply: false, now: NOW });
    expect(report.branches).toEqual([expect.objectContaining({ main: broken, branch: null, state: 'error', outcome: expect.stringMatching(/^failed: .*missing object/) })]);
  });

  it('fails a repository whose linked worktree records cannot be listed', () => {
    const hidden = path.join(root, 'hidden-worktrees');
    fs.mkdirSync(hidden);
    git(hidden, 'init', '-q', '-b', 'main');
    git(hidden, 'commit', '-q', '--allow-empty', '-m', 'base');
    git(hidden, 'worktree', 'add', '-q', '-b', 'held-elsewhere', path.join(root, 'hidden-worktrees-wt', 'lane'), 'main');
    const records = path.join(hidden, '.git', 'worktrees');
    const config = path.join(root, 'hidden-config.json');
    write(config, JSON.stringify({ databasePath: path.join(root, 'console.sqlite'), projects: { hidden: { path: hidden } }, coordination: { pilotPaths: [] } }));
    fs.chmodSync(records, 0o000);
    try {
      const report = runSweep({ configPath: config, reportDir: path.join(root, 'hidden-reports'), apply: true, now: NOW });
      expect(report.branches).toEqual([expect.objectContaining({ main: hidden, branch: null, state: 'error', outcome: expect.stringMatching(/^failed: .*EACCES/) })]);
    } finally { fs.chmodSync(records, 0o755); }
    expect(git(hidden, 'branch', '--list', 'held-elsewhere').trim()).toContain('held-elsewhere');
  });
});

describe('scratch and Docker sweep', () => {
  it('reclaims only idle, unused, verified build caches in scratch space', () => {
    const scratch = path.join(root, 'scratch-tmp');
    cache(scratch, 'idle-target');
    cache(scratch, 'fresh-target');
    fs.utimesSync(path.join(scratch, 'fresh-target', 'debug'), new Date(NOW - HOUR), new Date(NOW - HOUR));
    cache(scratch, 'busy/target');
    const busy = spawn('sleep', ['120'], { cwd: path.join(scratch, 'busy', 'target'), stdio: 'ignore' });
    cache(scratch, 'secret-target');
    write(path.join(scratch, 'secret-target', 'debug', '.env'), 'TOKEN=1');
    const checkout = path.join(scratch, 'checkout');
    fs.mkdirSync(checkout, { recursive: true });
    git(checkout, 'init', '-q');
    cache(checkout, 'target');
    cache(path.join(root, 'elsewhere-cache'), 'target');
    fs.symlinkSync(path.join(root, 'elsewhere-cache', 'target'), path.join(scratch, 'link-target'));
    write(path.join(scratch, 'plain', 'keep.txt'), 'not a cache');
    cache(scratch, 'a/b/c/d/deep-target');
    // Rewriting an existing file deep inside changes no directory time; the final walk still sees it.
    cache(scratch, 'rewritten-target');
    write(path.join(scratch, 'rewritten-target', 'debug', '.fingerprint', 'pkg-1', 'out'), 'fresh');
    fs.utimesSync(path.join(scratch, 'rewritten-target', 'debug', '.fingerprint', 'pkg-1', 'out'), new Date(NOW - HOUR), new Date(NOW - HOUR));
    try {
      const report = runSweep({ configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), apply: true, now: NOW, repoFilter: [repo], scratchRoots: [scratch] });
      const outcomes = Object.fromEntries(report.scratch.map((item) => [path.relative(scratch, item.path), `${item.state}/${item.outcome ?? '-'}`]));
      expect(outcomes).toEqual({
        'busy/target': 'in-use/-', 'checkout/target': expect.stringMatching(/^idle\/refused: holds tracked or untracked files/),
        'fresh-target': 'recent/-', 'idle-target': 'idle/reclaimed', 'secret-target': expect.stringMatching(/^idle\/refused: protected entry at .*\.env$/),
        'rewritten-target': expect.stringMatching(/^idle\/skipped: written within the cooldown at .*\/out$/),
      });
      expect(fs.existsSync(path.join(scratch, 'idle-target'))).toBe(false);
      for (const kept of ['rewritten-target/debug/.fingerprint/pkg-1/out', 'fresh-target/debug/big.bin', 'busy/target/debug/big.bin', 'secret-target/debug/.env', 'checkout/target/debug/big.bin', 'plain/keep.txt', 'a/b/c/d/deep-target/debug/big.bin']) {
        expect(fs.existsSync(path.join(scratch, kept)), kept).toBe(true);
      }
      expect(fs.existsSync(path.join(root, 'elsewhere-cache', 'target', 'debug', 'big.bin'))).toBe(true);
    } finally { busy.kill(); }
  });

  it('checks the repository around a scratch root, such as TMPDIR inside a checkout', () => {
    const holder = path.join(root, 'tmpdir-repo');
    fs.mkdirSync(holder);
    git(holder, 'init', '-q');
    cache(path.join(holder, 'tmp'), 'build-target');
    git(holder, 'add', '-f', 'tmp/build-target/debug/big.bin');
    git(holder, 'commit', '-qm', 'tracked under the scratch root');
    const report = runSweep({ configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), apply: true, now: NOW, repoFilter: [repo], scratchRoots: [path.join(holder, 'tmp')] });
    expect(report.scratch.map((item) => item.outcome)).toEqual([expect.stringMatching(/^refused: holds tracked or untracked files of .*tmpdir-repo$/)]);
    expect(fs.existsSync(path.join(holder, 'tmp', 'build-target', 'debug', 'big.bin'))).toBe(true);
  });

  it('leaves virtual environments and files an outer repository tracks', () => {
    const scratch = path.join(root, 'scratch-venv');
    cache(scratch, 'job/.venv');
    write(path.join(scratch, 'job', '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    cache(scratch, 'uv-env');
    write(path.join(scratch, 'uv-env', 'pyvenv.cfg'), 'home = /usr/bin\n');
    cache(scratch, 'job/target');
    write(path.join(scratch, 'job', 'target', 'test-env', 'pyvenv.cfg'), 'home = /usr/bin\n');
    const outer = path.join(scratch, 'outer');
    write(path.join(outer, 'component', 'target', 'valuable.txt'), 'tracked by the outer repository');
    git(scratch, 'init', '-q', outer);
    git(outer, 'add', 'component/target/valuable.txt');
    git(outer, 'commit', '-qm', 'outer tracks a file under target');
    git(outer, 'init', '-q', 'component');
    write(path.join(outer, 'component', '.gitignore'), 'target/\n');
    cache(path.join(outer, 'component'));
    const report = runSweep({ configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), apply: true, now: NOW, repoFilter: [repo], scratchRoots: [scratch] });
    expect(Object.fromEntries(report.scratch.map((item) => [path.relative(scratch, item.path), item.outcome]))).toEqual({
      'outer/component/target': expect.stringMatching(/^refused: holds tracked or untracked files of .*\/outer$/),
      'job/target': expect.stringMatching(/^refused: protected entry at .*test-env\/pyvenv\.cfg$/),
      'uv-env': expect.stringMatching(/^refused: virtual environment at .*uv-env$/),
    });
    for (const kept of ['job/.venv/pyvenv.cfg', 'job/target/test-env/pyvenv.cfg', 'uv-env/debug/big.bin', 'outer/component/target/valuable.txt']) expect(fs.existsSync(path.join(scratch, kept)), kept).toBe(true);
  });

  it('removes only old anonymous Docker volumes no container uses, and prunes old build cache', () => {
    const created = { 'anon-old': NOW - 48 * HOUR, 'anon-new': NOW - HOUR, 'named-old': NOW - 48 * HOUR, 'anon-raced': NOW - 48 * HOUR, 'anon-gone': NOW - 48 * HOUR };
    const calls: string[][] = [];
    let listed = 0;
    const docker = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'version') return '27.0\n';
      if (args[0] === 'volume' && args[1] === 'ls') return (listed++ === 0 ? Object.keys(created) : ['anon-old', 'anon-new', 'named-old']).join('\n');
      if (args[0] === 'volume' && args[1] === 'inspect') {
        if (args[2] === 'anon-gone') throw new Error('Error: No such volume: anon-gone');
        const name = args[2] as keyof typeof created;
        return JSON.stringify([{ Name: name, CreatedAt: new Date(created[name]).toISOString(), Labels: name.startsWith('anon') ? { 'com.docker.volume.anonymous': '' } : { project: 'x' } }]);
      }
      if (args[0] === 'volume' && args[1] === 'rm') return `${args[2]}\n`;
      if (args[0] === 'builder') return 'ID\tRECLAIMABLE\nabc\ttrue\nTotal:\t1.5GB\n';
      throw new Error(`unexpected docker ${args.join(' ')}`);
    };
    const options = { configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), now: NOW, repoFilter: [repo], docker };

    const dry = runSweep(options).docker;
    expect(dry.volumes.map((item) => `${item.name}:${item.action}`)).toEqual(['anon-gone:none', 'anon-new:none', 'anon-old:remove', 'anon-raced:remove', 'named-old:none']);
    expect(dry.volumes[0]?.reason).toBe('Could not be inspected: Error: No such volume: anon-gone');
    expect(calls.some((args) => args[1] === 'rm' || args[0] === 'builder')).toBe(false);

    calls.length = 0; listed = 0;
    const applied = runSweep({ ...options, apply: true }).docker;
    expect(Object.fromEntries(applied.volumes.map((item) => [item.name, item.outcome ?? '-']))).toEqual({
      'anon-gone': '-', 'anon-new': '-', 'anon-old': 'removed', 'anon-raced': 'skipped: now in use', 'named-old': '-',
    });
    expect(calls.filter((args) => args[1] === 'rm')).toEqual([['volume', 'rm', 'anon-old']]);
    expect(calls.find((args) => args[0] === 'builder')).toEqual(['builder', 'prune', '--force', '--filter', 'until=168h']);
    expect(applied.buildCache?.outcome).toBe('pruned 1.5GB');

    const unavailable = runSweep({ ...options, apply: true, docker: () => { throw new Error('Cannot connect to the Docker daemon'); } }).docker;
    expect(unavailable).toEqual({ available: false, reason: 'Cannot connect to the Docker daemon', volumes: [] });

    const listingFails = runSweep({ ...options, apply: true, docker: (args: string[]) => { if (args[0] === 'version') return '27.0'; throw new Error('daemon restarting'); } });
    expect(listingFails.docker).toEqual({ available: false, reason: 'volume listing failed: daemon restarting', volumes: [] });
    expect(fs.existsSync(listingFails.file)).toBe(true);
  });
});
