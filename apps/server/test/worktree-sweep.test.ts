import Database from 'better-sqlite3';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from '../src/db/schema.js';
import { processStart, runSweep, SUPPORTED_SCHEMA_VERSIONS, type SweepReport, type WorktreeResult } from '../../../scripts/worktree-sweep.mjs';

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
      expect(report.get(name)?.recovery).toBe(`git -C ${repo} worktree add ${wt(name)} ${name}`);
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
    try {
      const report = runSweep({ configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), apply: true, now: NOW, repoFilter: [repo], scratchRoots: [scratch] });
      const outcomes = Object.fromEntries(report.scratch.map((item) => [path.relative(scratch, item.path), `${item.state}/${item.outcome ?? '-'}`]));
      expect(outcomes).toEqual({
        'busy/target': 'in-use/-', 'checkout/target': expect.stringMatching(/^idle\/refused: holds tracked or untracked files/),
        'fresh-target': 'recent/-', 'idle-target': 'idle/reclaimed', 'secret-target': expect.stringMatching(/^idle\/refused: protected entry at .*\.env$/),
      });
      expect(fs.existsSync(path.join(scratch, 'idle-target'))).toBe(false);
      for (const kept of ['fresh-target/debug/big.bin', 'busy/target/debug/big.bin', 'secret-target/debug/.env', 'checkout/target/debug/big.bin', 'plain/keep.txt', 'a/b/c/d/deep-target/debug/big.bin']) {
        expect(fs.existsSync(path.join(scratch, kept)), kept).toBe(true);
      }
      expect(fs.existsSync(path.join(root, 'elsewhere-cache', 'target', 'debug', 'big.bin'))).toBe(true);
    } finally { busy.kill(); }
  });

  it('removes only old anonymous Docker volumes no container uses, and prunes old build cache', () => {
    const created = { 'anon-old': NOW - 48 * HOUR, 'anon-new': NOW - HOUR, 'named-old': NOW - 48 * HOUR, 'anon-raced': NOW - 48 * HOUR };
    const calls: string[][] = [];
    let listed = 0;
    const docker = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'version') return '27.0\n';
      if (args[0] === 'volume' && args[1] === 'ls') return (listed++ === 0 ? Object.keys(created) : ['anon-old', 'anon-new', 'named-old']).join('\n');
      if (args[0] === 'volume' && args[1] === 'inspect') {
        const name = args[2] as keyof typeof created;
        return JSON.stringify([{ Name: name, CreatedAt: new Date(created[name]).toISOString(), Labels: name.startsWith('anon') ? { 'com.docker.volume.anonymous': '' } : { project: 'x' } }]);
      }
      if (args[0] === 'volume' && args[1] === 'rm') return `${args[2]}\n`;
      if (args[0] === 'builder') return 'ID\tRECLAIMABLE\nabc\ttrue\nTotal:\t1.5GB\n';
      throw new Error(`unexpected docker ${args.join(' ')}`);
    };
    const options = { configPath: path.join(root, 'config.json'), reportDir: path.join(root, 'reports'), now: NOW, repoFilter: [repo], docker };

    const dry = runSweep(options).docker;
    expect(dry.volumes.map((item) => `${item.name}:${item.action}`)).toEqual(['anon-new:none', 'anon-old:remove', 'anon-raced:remove', 'named-old:none']);
    expect(calls.some((args) => args[1] === 'rm' || args[0] === 'builder')).toBe(false);

    calls.length = 0; listed = 0;
    const applied = runSweep({ ...options, apply: true }).docker;
    expect(Object.fromEntries(applied.volumes.map((item) => [item.name, item.outcome ?? '-']))).toEqual({
      'anon-new': '-', 'anon-old': 'removed', 'anon-raced': 'skipped: now in use', 'named-old': '-',
    });
    expect(calls.filter((args) => args[1] === 'rm')).toEqual([['volume', 'rm', 'anon-old']]);
    expect(calls.find((args) => args[0] === 'builder')).toEqual(['builder', 'prune', '--force', '--filter', 'until=168h']);
    expect(applied.buildCache?.outcome).toBe('pruned 1.5GB');

    const unavailable = runSweep({ ...options, apply: true, docker: () => { throw new Error('Cannot connect to the Docker daemon'); } }).docker;
    expect(unavailable).toEqual({ available: false, reason: 'Cannot connect to the Docker daemon', volumes: [] });
  });
});
