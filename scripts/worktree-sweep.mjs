#!/usr/bin/env node
// Inventory and guarded cleanup of agent-created Git worktrees. Contract: docs/worktree-lifecycle.md.
// Reads Console state read-only; never deletes branches, uncommitted work or unknown local files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Console schema versions whose assignment, scope and binding semantics this script was reviewed against.
export const SUPPORTED_SCHEMA_VERSIONS = [17, 18];
export const DEFAULT_COOLDOWN_HOURS = 24;
const CACHEDIR_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';
const DISPOSABLE_DIR_NAMES = new Set(['__pycache__']);
const PROTECTED_DIR_NAMES = new Set(['.venv', 'venv', 'var', 'dist', 'build']);
const OPERATION_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer'];
// Entries Git keeps in every linked worktree's private directory. Anything else is unexplained state.
const ORDINARY_GITDIR_ENTRIES = new Set(['HEAD', 'ORIG_HEAD', 'logs', 'index', 'gitdir', 'commondir', 'COMMIT_EDITMSG', 'FETCH_HEAD', 'AUTO_MERGE', 'locked']);
// Session daemons that mark themselves non-dumpable, so /proc hides their cwd and files. They never
// work inside source trees. Any other uninspectable process of this user makes the run inventory-only.
const OPAQUE_DAEMONS = new Set(['systemd', '(sd-pam)', 'gpg-agent', 'ssh-agent', 'gvfsd-admin', 'gnome-keyring-d']);
const QUARANTINE = /^\.retiring-(.+)-(\d+)-(\d+)$/;
const REPORTS_KEPT = 72;
const HOUR = 3_600_000;

const expandHome = (value) => value.replace(/^~(?=\/|$)/, os.homedir());

function realpathOrSelf(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, ...options,
  });
}

function mtimeMs(target) {
  try { return fs.lstatSync(target).mtimeMs; } catch { return 0; }
}

const isWithin = (target, root) => target === root || target.startsWith(`${root}/`);

// A safety check declined to delete something. Reported as `refused`, not as a failed run.
class Refusal extends Error {}

export function processStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
  } catch { return ''; }
}

export function loadConsoleConfig(configPath) {
  const file = expandHome(configPath ?? process.env.AGENT_CONSOLE_CONFIG ?? '~/.config/agent-console/config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const projectPaths = Object.values(config.projects ?? {}).map((project) => project?.path).filter(Boolean);
  const repoPaths = [...new Set([...projectPaths, ...(config.coordination?.pilotPaths ?? [])].map(expandHome))];
  return {
    databasePath: expandHome(config.databasePath ?? '~/.local/share/agent-console/agent-console.sqlite'),
    repoPaths, projectPaths: projectPaths.map((value) => realpathOrSelf(expandHome(value))),
  };
}

function parseWorktreeList(text) {
  const entries = [];
  let current;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9) }; entries.push(current); continue; }
    if (!current || !line) continue;
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = value || true;
    else if (key === 'prunable') current.prunable = value || true;
  }
  return entries;
}

export function discoverRepositories(repoPaths) {
  const repositories = new Map();
  for (const candidate of repoPaths) {
    if (!fs.existsSync(candidate)) continue;
    let commonDir;
    try { commonDir = git(candidate, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(); } catch { continue; }
    if (repositories.has(commonDir)) continue;
    const entries = parseWorktreeList(git(candidate, ['worktree', 'list', '--porcelain']));
    const [main, ...linked] = entries;
    if (!main || main.bare) continue;
    repositories.set(commonDir, { main: main.path, linked: linked.map((entry) => ({ ...entry, path: realpathOrSelf(entry.path) })) });
  }
  return [...repositories.values()];
}

// One read transaction over the Console tables that define who may still use a checkout.
export function readConsoleSnapshot(databasePath) {
  let Database;
  try { Database = createRequire(import.meta.url)('better-sqlite3'); } catch (error) {
    return { ok: false, reason: `better-sqlite3 is unavailable: ${error.message}` };
  }
  let db;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    return db.transaction(() => {
      const version = db.prepare('select max(version) as version from schema_version').get()?.version;
      if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
        return { ok: false, reason: `Console schema version ${version} is not one this sweep was reviewed for (${SUPPORTED_SCHEMA_VERSIONS.join(', ')}).` };
      }
      return {
        ok: true, version,
        assignments: db.prepare('select id, provider, native_session_id as nativeSessionId, description, status, pid, process_start as processStart from coordination_assignments').all(),
        scopes: db.prepare('select assignment_id as assignmentId, checkout from coordination_scopes').all(),
        bindings: db.prepare(`select id, provider, conversation_ref as conversationRef, resume_conversation_ref as resumeConversationRef
          from bound_sessions where should_restore = 1 and status != 'ended'`).all(),
        pendingBindings: db.prepare(`select substr(key, length('console-session:') + 1) as assignmentId, value as bindingId
          from meta where key like 'console-session:%'`).all(),
      };
    }).deferred();
  } catch (error) {
    return { ok: false, reason: `Console database could not be read: ${error.message}` };
  } finally { db?.close(); }
}

// Lists each announced checkout with its assignment and why that assignment may still use it.
// `live` means its process runs now, or an open assignment recorded no process to check.
function consoleOwners(snapshot) {
  const restorable = new Set();
  for (const binding of snapshot.bindings) {
    for (const ref of [binding.conversationRef, binding.resumeConversationRef]) if (ref) restorable.add(`${binding.provider}:${ref}`);
  }
  const restorableIds = new Set(snapshot.bindings.map((binding) => binding.id));
  const pending = new Map(snapshot.pendingBindings.map((row) => [row.assignmentId, row.bindingId]));
  const assignments = new Map(snapshot.assignments.map((assignment) => {
    const why = [];
    const open = assignment.status === 'active' || assignment.status === 'waiting';
    const running = Boolean(assignment.processStart) && processStart(assignment.pid) === assignment.processStart;
    if (open) why.push(`assignment is ${assignment.status}`);
    if (running) why.push('assignment process is running');
    if (restorable.has(`${assignment.provider}:${assignment.nativeSessionId}`) || restorableIds.has(pending.get(assignment.id))) {
      why.push('Console can resume its session');
    }
    const live = running || (open && !assignment.processStart);
    return [assignment.id, { id: assignment.id, description: assignment.description, status: assignment.status, consumer: why, live }];
  }));
  return snapshot.scopes.map((scope) => ({ checkout: realpathOrSelf(scope.checkout), assignment: assignments.get(scope.assignmentId) }))
    .filter((row) => row.assignment);
}

// Reads one process's cwd, root, open files and absolute paths in its arguments.
// `denied` means the kernel refused access to a process this user owns.
function inspectProcess(pid, uid) {
  let ours = false;
  let name = '';
  try {
    // Zombie and dead tasks hold no working directory or open files.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2))) return undefined;
    ours = fs.statSync(`/proc/${pid}`).uid === uid; name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ESRCH' ? undefined : { name: '?', start: '', denied: true, paths: [] };
  }
  const paths = [];
  let denied = false;
  const read = (fn) => {
    try { return fn(); } catch (error) {
      if (ours && error.code !== 'ENOENT' && error.code !== 'ESRCH') denied = true;
      return undefined;
    }
  };
  for (const link of ['cwd', 'root', 'exe']) { const value = read(() => fs.readlinkSync(`/proc/${pid}/${link}`)); if (value) paths.push(value.replace(/ \(deleted\)$/, '')); }
  for (const fd of read(() => fs.readdirSync(`/proc/${pid}/fd`)) ?? []) {
    const target = read(() => fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
    if (target) paths.push(target.replace(/ \(deleted\)$/, ''));
  }
  const args = read(() => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')) ?? '';
  for (const match of args.matchAll(/\/[^\s\0'"`=,;:()<>|]+/g)) paths.push(match[0]);
  return { name, start: processStart(pid), denied: denied && !OPAQUE_DAEMONS.has(name), paths: paths.filter((value) => value.startsWith('/') && value !== '/') };
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Every path a live process holds. A process that stays unreadable through three retries makes
// visibility incomplete; processes mid-exec are briefly unreadable and settle within the retries.
export function scanProcesses(excludePid = process.pid) {
  const references = [];
  const uid = process.getuid();
  let init = '';
  try { init = fs.readFileSync('/proc/1/comm', 'utf8').trim(); } catch { /* unreadable */ }
  if (init !== 'systemd' && init !== 'init') return { references, complete: false, hidden: [`process 1 is ${init || 'unreadable'}, not the host init; this is an isolated process view`] };
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name) && Number(name) !== excludePid); } catch { return { references, complete: false, hidden: ['/proc'] }; }
  let pending = pids.map((pid) => ({ pid, first: inspectProcess(pid, uid) })).filter((item) => item.first);
  for (const item of pending) if (!item.first.denied) references.push(...item.first.paths.map((value) => ({ pid: Number(item.pid), path: value })));
  pending = pending.filter((item) => item.first.denied);
  for (let attempt = 0; attempt < 3 && pending.length; attempt += 1) {
    pause(200);
    pending = pending.filter((item) => {
      const again = inspectProcess(item.pid, uid);
      if (!again || again.start !== item.first.start) return false;
      if (again.denied) return true;
      references.push(...again.paths.map((value) => ({ pid: Number(item.pid), path: value })));
      return false;
    });
  }
  const hidden = pending.map((item) => {
    let parent = '';
    try { const stat = fs.readFileSync(`/proc/${item.pid}/stat`, 'utf8'); parent = ` (${stat.slice(stat.lastIndexOf(')') + 2).split(' ').slice(0, 2).join(', parent ')})`; } catch { /* exited */ }
    return `${item.pid} ${item.first.name}${parent}`;
  });
  return { references, complete: hidden.length === 0, hidden };
}

function mountPoints() {
  try {
    return fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean)
      .map((line) => line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8))));
  } catch { return undefined; }
}

function assertNoMountsWithin(root) {
  const mounts = mountPoints();
  if (!mounts) throw new Error('mount table is unreadable');
  const inside = mounts.find((mount) => isWithin(mount, root));
  if (inside) throw new Refusal(`mount point at ${inside}`);
}

function containingWorktree(target, worktrees) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    if (worktrees.has(current)) return current;
    if (current === path.dirname(current)) return undefined;
  }
}

function validCacheDirTag(directory) {
  try {
    const tag = path.join(directory, 'CACHEDIR.TAG');
    if (!fs.lstatSync(tag).isFile()) return false;
    const fd = fs.openSync(tag, 'r');
    try {
      const buffer = Buffer.alloc(CACHEDIR_SIGNATURE.length);
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.toString('latin1') === CACHEDIR_SIGNATURE;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

// Splits `git status -z` output into changed paths and ignored paths.
function parseStatus(text) {
  const tokens = text.split('\0');
  const changed = [];
  const ignored = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    const file = token.slice(3);
    if (code === '!!') ignored.push(file);
    else changed.push({ code, file });
    if (code[0] === 'R' || code[0] === 'C') index += 1;
  }
  return { changed, ignored };
}

// Finds the disposable root (tagged cache or named directory) that contains an ignored path, if any.
function disposableRoot(root, relative, tagCache) {
  const parts = relative.replace(/\/$/, '').split('/');
  for (let length = 1; length <= parts.length; length += 1) {
    const name = parts[length - 1];
    if (PROTECTED_DIR_NAMES.has(name) || name.startsWith('.env')) return undefined;
    const candidate = parts.slice(0, length).join('/');
    if (DISPOSABLE_DIR_NAMES.has(name)) return { path: candidate, tagged: false };
    if (!tagCache.has(candidate)) tagCache.set(candidate, validCacheDirTag(path.join(root, candidate)));
    if (tagCache.get(candidate)) return { path: candidate, tagged: true };
  }
  return undefined;
}

function safeDirectories(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => path.join(directory, item.name));
  } catch { return []; }
}

// Commits reachable only from this worktree's HEAD reflog or ORIG_HEAD.
function readIfPresent(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function reflogOnlyCommits(main, gitDir) {
  const commits = new Set();
  for (const line of readIfPresent(path.join(gitDir, 'logs/HEAD')).split('\n')) {
    const [previous, next] = line.split(' ');
    if (next) { commits.add(previous); commits.add(next); }
  }
  const orig = readIfPresent(path.join(gitDir, 'ORIG_HEAD')).trim();
  if (orig) commits.add(orig);
  commits.delete('0000000000000000000000000000000000000000');
  if (!commits.size) return false;
  return git(main, ['rev-list', '--stdin', '--max-count=1'], { input: `${[...commits].join('\n')}\n--not\n--all\n` }).trim() !== '';
}

export function inspectWorktree(repository, entry) {
  const worktree = entry.path;
  const facts = {
    path: worktree, main: repository.main, branch: entry.branch?.replace(/^refs\/heads\//, ''), head: entry.head,
    detached: Boolean(entry.detached), locked: Boolean(entry.locked), managed: path.basename(path.dirname(worktree)).endsWith('-wt'),
    missing: Boolean(entry.prunable) || !fs.existsSync(worktree),
  };
  if (facts.missing) return facts;
  const gitDir = git(worktree, ['rev-parse', '--absolute-git-dir']).trim();
  facts.operation = OPERATION_MARKERS.find((marker) => fs.existsSync(path.join(gitDir, marker)));
  facts.privateState = fs.readdirSync(gitDir).filter((name) => !ORDINARY_GITDIR_ENTRIES.has(name));
  facts.reflogOnly = reflogOnlyCommits(repository.main, gitDir);
  const status = parseStatus(git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']));
  facts.changed = status.changed.length;
  facts.hiddenIndex = git(worktree, ['ls-files', '-v']).split('\n').some((line) => /^[a-z]|^S /.test(line));
  const tagCache = new Map();
  const roots = new Map();
  facts.localFiles = [];
  for (const file of status.ignored) {
    const disposable = disposableRoot(worktree, file, tagCache);
    if (disposable) roots.set(disposable.path, disposable);
    else facts.localFiles.push(file);
  }
  for (const root of roots.keys()) {
    const holdsWork = status.changed.some((change) => change.file === root || change.file.startsWith(`${root}/`));
    if (holdsWork || git(worktree, ['ls-files', '-z', '--', root]).length) { roots.delete(root); facts.localFiles.push(`${root}/ (holds tracked or untracked files)`); }
  }
  facts.disposableRoots = [...roots.keys()];
  facts.cacheRoots = [...roots.values()].filter((root) => root.tagged).map((root) => root.path);
  // The worktree root's own mtime is not a signal: deleting a top-level cache changes it.
  let activity = Math.max(...['HEAD', 'index', 'logs/HEAD'].map((name) => mtimeMs(path.join(gitDir, name))));
  try { activity = Math.max(activity, Number(git(worktree, ['log', '-1', '--format=%ct', 'HEAD']).trim()) * 1000); } catch { /* unborn */ }
  for (const change of status.changed) activity = Math.max(activity, mtimeMs(path.join(worktree, change.file)));
  for (const cacheRoot of facts.cacheRoots) {
    const absolute = path.join(worktree, cacheRoot);
    activity = Math.max(activity, mtimeMs(absolute));
    for (const child of safeDirectories(absolute)) {
      activity = Math.max(activity, mtimeMs(child));
      for (const grandchild of safeDirectories(child)) activity = Math.max(activity, mtimeMs(grandchild));
    }
  }
  facts.activityMs = activity;
  facts.containedIn = [];
  if (!facts.detached && facts.head) {
    const refs = git(repository.main, ['for-each-ref', '--contains', facts.head, '--format=%(refname)', 'refs/heads/', 'refs/remotes/']).split('\n');
    facts.containedIn = refs.filter((ref) => ref && ref !== entry.branch && !ref.endsWith(`/${facts.branch}`) && !ref.endsWith('/HEAD'));
  }
  return facts;
}

// Pure decision for one worktree. Removal needs release evidence; cache reclamation needs only quiescence.
export function classify(facts, now, cooldownMs) {
  if (facts.missing) return { state: 'missing', action: 'none', reason: 'Directory is missing; Git metadata is left for a human prune.' };
  if (!facts.managed) return { state: 'unmanaged', action: 'none', reason: 'Not under an agent <repo>-wt directory.' };
  if (facts.locked) return { state: 'locked', action: 'none', reason: 'Parked with git worktree lock.' };
  if (QUARANTINE.test(path.basename(facts.path)) && !facts.ownQuarantine) return { state: 'quarantined', action: 'none', reason: 'Left by an interrupted sweep; the next applying sweep moves it back.' };
  if (facts.consumers.length) return { state: 'in-use', action: 'none', reason: facts.consumers.join('; ') };
  const idle = now - facts.activityMs >= cooldownMs;
  const reclaim = facts.cacheRoots.length ? 'reclaim-cache' : 'none';
  // A session Console could resume keeps its worktree; nothing runs there, so idle caches may go.
  if (facts.resumers.length) return { state: 'resumable', action: idle ? reclaim : 'none', reason: `${facts.resumers.join('; ')}; no process runs in it.` };
  if (!idle) return { state: 'recent', action: 'none', reason: `Active within the last ${cooldownMs / HOUR}h.` };
  if (facts.detached) return { state: 'detached', action: reclaim, reason: 'Detached HEAD; its commit may have no other reference.' };
  if (facts.operation) return { state: 'git-operation', action: reclaim, reason: `Git operation in progress (${facts.operation}).` };
  if (facts.privateState.length) return { state: 'private-git-state', action: reclaim, reason: `Worktree Git directory holds ${facts.privateState.join(', ')}.` };
  if (facts.reflogOnly) return { state: 'reflog-only-commits', action: reclaim, reason: 'Its HEAD history holds commits no ref contains.' };
  if (facts.hiddenIndex) return { state: 'hidden-index', action: reclaim, reason: 'Index has assume-unchanged or skip-worktree entries.' };
  if (facts.changed) return { state: 'dirty', action: reclaim, reason: `${facts.changed} uncommitted or untracked paths.` };
  if (facts.localFiles.length) return { state: 'local-files', action: reclaim, reason: `Ignored local files: ${facts.localFiles.slice(0, 5).join(', ')}${facts.localFiles.length > 5 ? ', …' : ''}` };
  if (facts.owner === 'released') return { state: 'removable', action: 'remove', reason: 'Owning assignments finished or ended and no session can resume.' };
  if (facts.containedIn.length) return { state: 'removable', action: 'remove', reason: `Branch tip is already in ${facts.containedIn[0].replace(/^refs\/(heads|remotes)\//, '')}.` };
  return { state: 'unreleased', action: reclaim, reason: 'No owner record and the branch has commits found nowhere else.' };
}

// Gathers the shared signals once: Console owners keyed by worktree, and host process references.
function gatherSignals(options, worktreePaths) {
  const snapshot = readConsoleSnapshot(options.databasePath);
  const scan = scanProcesses();
  const owners = snapshot.ok ? consoleOwners(snapshot).map((row) => ({ ...row, worktree: containingWorktree(row.checkout, worktreePaths) })) : [];
  const references = scan.references.map((ref) => ({ ...ref, worktree: containingWorktree(ref.path, worktreePaths) })).filter((ref) => ref.worktree);
  return { snapshot, scan, owners, references };
}

// `consolePath` is the path Console knows the worktree by; it differs from `entry.path` while quarantined.
function assess(options, repository, entry, signals, consolePath = entry.path) {
  let facts;
  try { facts = inspectWorktree(repository, entry); } catch (error) {
    return { path: entry.path, main: repository.main, branch: entry.branch, state: 'error', action: 'none', reason: String(error.stderr || error.message).trim().split('\n')[0] };
  }
  facts.consumers = [];
  facts.resumers = [];
  facts.ownQuarantine = consolePath !== entry.path;
  const announced = signals.owners.filter((row) => row.worktree === consolePath);
  for (const row of announced) {
    if (!row.assignment.consumer.length) continue;
    (row.assignment.live ? facts.consumers : facts.resumers)
      .push(`${row.assignment.consumer.join(', ')} (${row.assignment.id.slice(0, 8)} ${row.assignment.description.slice(0, 60)})`);
  }
  facts.owner = !announced.length ? 'none' : facts.consumers.length || facts.resumers.length ? 'consumer' : 'released';
  facts.owners = announced.map((row) => ({ id: row.assignment.id, status: row.assignment.status, description: row.assignment.description }));
  const pids = [...new Set(signals.references.filter((ref) => ref.worktree === entry.path || ref.worktree === consolePath).map((ref) => ref.pid))];
  if (pids.length) facts.consumers.push(`process ${pids.slice(0, 5).join(', ')} references it`);
  if (options.projectPaths.some((project) => isWithin(project, consolePath) || isWithin(project, entry.path))) facts.consumers.push('a Console project points inside it');
  if (!signals.snapshot.ok) facts.consumers.push(`Console state is unavailable: ${signals.snapshot.reason}`);
  if (!signals.scan.complete) facts.consumers.push(`process visibility is incomplete (${signals.scan.hidden.slice(0, 3).join(', ')})`);
  return { ...facts, ...classify(facts, options.now, options.cooldownMs) };
}

// Fresh signals for one worktree immediately before acting on it.
function reassess(options, repository, entry, consolePath = entry.path) {
  return assess(options, repository, entry, gatherSignals(options, new Set([entry.path, consolePath])), consolePath);
}

// Walks a disposable directory without following links; refuses Git data, secrets, environments
// and device or mount boundaries anywhere below it. Returns its size in bytes.
function verifyDisposable(directory, rootDevice) {
  assertNoMountsWithin(directory);
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.name === '.git' || item.name === '.venv' || item.name === 'venv' || item.name.startsWith('.env')) throw new Refusal(`protected entry at ${full}`);
      const stat = fs.lstatSync(full);
      if (stat.dev !== rootDevice) throw new Refusal(`device boundary at ${full}`);
      bytes += stat.blocks * 512;
      if (stat.isDirectory()) pending.push(full);
    }
  }
  return bytes;
}

function reclaimCache(worktree, relative) {
  const absolute = path.join(worktree, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Refusal(`${relative} is not a plain directory`);
  if (stat.dev !== fs.lstatSync(worktree).dev) throw new Refusal(`${relative} is on another device`);
  if (!validCacheDirTag(absolute)) throw new Refusal(`${relative} lost its CACHEDIR.TAG`);
  if (git(worktree, ['ls-files', '-z', '--', relative]).length) throw new Refusal(`${relative} contains tracked files`);
  if (git(worktree, ['ls-files', '-z', '--others', '--exclude-standard', '--', relative]).length) throw new Refusal(`${relative} contains untracked files`);
  const bytes = verifyDisposable(absolute, stat.dev);
  fs.rmSync(absolute, { recursive: true });
  return bytes;
}

// Moves the worktree out of its known path first, so no agent can adopt or write to it,
// then re-verifies it there before Git deletes it. Anything unexpected moves it back.
function removeWorktree(options, repository, entry) {
  const quarantine = path.join(path.dirname(entry.path), `.retiring-${path.basename(entry.path)}-${process.pid}-${processStart(process.pid)}`);
  if (fs.existsSync(quarantine)) throw new Error(`${quarantine} already exists`);
  assertNoMountsWithin(entry.path);
  git(repository.main, ['worktree', 'move', entry.path, quarantine]);
  options.onQuarantine?.(quarantine);
  const moved = { ...entry, path: quarantine };
  const check = reassess(options, repository, moved, entry.path);
  try {
    if (check.action !== 'remove') throw new Error(`now ${check.state} (${check.reason})`);
    const device = fs.lstatSync(quarantine).dev;
    for (const root of check.disposableRoots) verifyDisposable(path.join(quarantine, root), device);
    git(repository.main, ['worktree', 'remove', quarantine]);
    return 'removed';
  } catch (error) {
    if (fs.existsSync(quarantine)) git(repository.main, ['worktree', 'move', quarantine, entry.path]);
    return `skipped after quarantine: ${String(error.stderr || error.message).trim().split('\n')[0]}`;
  }
}

// Moves worktrees left in quarantine by an interrupted sweep back to their original path.
function restoreQuarantined(repositories) {
  const restored = [];
  for (const repository of repositories) {
    for (const entry of repository.linked) {
      const match = QUARANTINE.exec(path.basename(entry.path));
      if (!match || processStart(Number(match[2])) === match[3]) continue;
      const original = path.join(path.dirname(entry.path), match[1]);
      if (fs.existsSync(original)) { restored.push({ path: entry.path, outcome: `left in place: ${original} exists` }); continue; }
      try {
        git(repository.main, ['worktree', 'move', entry.path, original]);
        restored.push({ path: original, outcome: `restored from ${entry.path}` });
      } catch (error) {
        restored.push({ path: entry.path, outcome: `failed: ${String(error.stderr || error.message).trim().split('\n')[0]}` });
      }
    }
  }
  return restored;
}

function applyActions(options, repositories, results) {
  const entries = new Map(repositories.flatMap((repository) => repository.linked.map((entry) => [entry.path, { repository, entry }])));
  for (const result of results) {
    if (result.action === 'none') continue;
    const { repository, entry } = entries.get(result.path);
    try {
      const current = reassess(options, repository, entry);
      if (current.action !== result.action) {
        result.outcome = `skipped: now ${current.state} (${current.reason})`;
      } else if (result.action === 'remove') {
        result.outcome = removeWorktree(options, repository, entry);
        if (result.outcome === 'removed') result.recovery = `git -C ${repository.main} worktree add ${result.path} ${result.branch}`;
      } else {
        result.reclaimedBytes = 0;
        const done = [];
        for (const root of current.cacheRoots) {
          const again = reassess(options, repository, entry);
          if (again.action !== 'reclaim-cache' || !again.cacheRoots.includes(root)) break;
          result.reclaimedBytes += reclaimCache(result.path, root);
          done.push(root);
        }
        result.outcome = done.length === current.cacheRoots.length ? `reclaimed ${done.join(', ')}` : `skipped: changed after reclaiming ${done.join(', ') || 'nothing'}`;
      }
    } catch (error) {
      result.outcome = `${error instanceof Refusal ? 'refused' : 'failed'}: ${String(error.stderr || error.message).trim().split('\n')[0]}`;
    }
  }
}

function acquireLock(reportDir) {
  const lock = path.join(reportDir, 'sweep.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: processStart(process.pid) }), { flag: 'wx', mode: 0o600 });
      return () => fs.rmSync(lock, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = {};
      try { holder = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* torn write */ }
      if (holder.start && processStart(holder.pid) === holder.start) throw new Error(`Another sweep (pid ${holder.pid}) is running.`);
      fs.rmSync(lock, { force: true });
    }
  }
  throw new Error('Could not take the sweep lock.');
}

function writeReport(reportDir, report) {
  const name = `${report.startedAt.replace(/[:.]/g, '-')}.json`;
  const body = JSON.stringify(report, null, 1);
  fs.writeFileSync(path.join(reportDir, name), body, { mode: 0o600 });
  fs.writeFileSync(path.join(reportDir, 'latest.json.tmp'), body, { mode: 0o600 });
  fs.renameSync(path.join(reportDir, 'latest.json.tmp'), path.join(reportDir, 'latest.json'));
  const old = fs.readdirSync(reportDir).filter((file) => /^\d{4}-.*\.json$/.test(file)).sort().slice(0, -REPORTS_KEPT);
  for (const file of old) fs.rmSync(path.join(reportDir, file), { force: true });
  return path.join(reportDir, name);
}

// `onQuarantine` lets tests act inside the window between quarantine and the final check.
export function runSweep({ configPath, reportDir, apply = false, repoFilter = [], now = Date.now(), cooldownHours = DEFAULT_COOLDOWN_HOURS, onQuarantine } = {}) {
  const config = loadConsoleConfig(configPath);
  const directory = expandHome(reportDir ?? '~/.local/share/agent-console/worktree-sweep');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireLock(directory);
  try {
    const options = { ...config, now, cooldownMs: cooldownHours * HOUR, onQuarantine };
    const filters = repoFilter.map((value) => realpathOrSelf(expandHome(value)));
    const scope = () => discoverRepositories(config.repoPaths)
      .filter((repository) => !filters.length || filters.includes(realpathOrSelf(repository.main)));
    let repositories = scope();
    const restored = apply ? restoreQuarantined(repositories) : [];
    if (restored.length) repositories = scope();
    const signals = gatherSignals(options, new Set(repositories.flatMap((repository) => repository.linked.map((entry) => entry.path))));
    const results = repositories.flatMap((repository) => repository.linked.map((entry) => assess(options, repository, entry, signals)));
    const usable = signals.snapshot.ok && signals.scan.complete;
    if (apply && usable) applyActions(options, repositories, results);
    const report = {
      startedAt: new Date(now).toISOString(), apply, cooldownHours, usable,
      consoleState: signals.snapshot.ok ? `schema ${signals.snapshot.version}` : signals.snapshot.reason,
      processVisibility: signals.scan.complete ? 'complete' : `incomplete: ${signals.scan.hidden.slice(0, 5).join(', ')}`,
      restored, worktrees: results,
    };
    report.file = writeReport(directory, report);
    return report;
  } finally { release(); }
}

export function summarize(report) {
  const lines = [`Worktree sweep ${report.apply ? '(apply)' : '(dry run)'} at ${report.startedAt}; Console: ${report.consoleState}; processes: ${report.processVisibility}`];
  const counts = new Map();
  for (const item of report.worktrees) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  lines.push(`${report.worktrees.length} linked worktrees: ${[...counts].map(([state, count]) => `${state} ${count}`).join(', ')}`);
  const planned = report.worktrees.filter((item) => item.action !== 'none');
  lines.push(`Planned: remove ${planned.filter((item) => item.action === 'remove').length}, reclaim caches in ${planned.filter((item) => item.action === 'reclaim-cache').length}`);
  if (report.apply) {
    const bytes = report.worktrees.reduce((sum, item) => sum + (item.reclaimedBytes ?? 0), 0);
    const failed = report.worktrees.filter((item) => item.outcome?.startsWith('failed'));
    lines.push(`Done: removed ${report.worktrees.filter((item) => item.outcome === 'removed').length}, cache GB freed ${(bytes / 1e9).toFixed(1)}, skipped on recheck ${report.worktrees.filter((item) => item.outcome?.startsWith('skipped')).length}, failed ${failed.length}`);
    for (const item of failed) lines.push(`  FAILED ${item.path}: ${item.outcome}`);
    for (const item of report.worktrees.filter((entry) => entry.outcome?.startsWith('refused'))) lines.push(`  REFUSED ${item.path}: ${item.outcome}`);
    for (const item of report.restored) lines.push(`  QUARANTINE ${item.path}: ${item.outcome}`);
  }
  if (!report.usable) lines.push('No changes are allowed while Console state or process visibility is unavailable.');
  lines.push(`Report: ${report.file}`);
  return lines.join('\n');
}

// Scheduler summary: one JSON object for Waltium Control.
function writeSummary(file, report, startedAt) {
  const items = report.worktrees;
  const removed = items.filter((item) => item.outcome === 'removed').length;
  const gb = (items.reduce((sum, item) => sum + (item.reclaimedBytes ?? 0), 0) / 1e9).toFixed(1);
  const failed = [...items, ...report.restored].filter((item) => item.outcome?.startsWith('failed'));
  const refused = items.filter((item) => item.outcome?.startsWith('refused'));
  const kept = items.filter((item) => ['dirty', 'local-files', 'unreleased', 'detached', 'git-operation', 'private-git-state', 'reflog-only-commits', 'hidden-index'].includes(item.state)).length;
  const status = !report.usable || failed.length ? 'failed' : 'updated';
  const dashboard = report.usable
    ? `Removed ${removed} idle worktrees and freed ${gb} GB of build caches; ${kept} kept for unsaved or unique content${failed.length ? `; ${failed.length} failed` : ''}.`
    : `Changed nothing: ${report.consoleState.startsWith('schema') ? `process visibility ${report.processVisibility}` : report.consoleState}`;
  const summary = {
    job_key: process.env.WALTIUM_JOB_KEY ?? null, run_id: process.env.WALTIUM_RUN_ID ?? null,
    started_at: startedAt, finished_at: new Date().toISOString(), status, dashboard_summary: dashboard,
    plain_english_summary: `${dashboard} The sweep checked ${items.length} agent worktrees across Console repositories. It keeps every branch and never deletes uncommitted work, ignored local files or a worktree a session can still resume. ${refused.length ? `${refused.length} cache deletions were refused by a safety check and need a look. ` : ''}The full per-worktree report is ${report.file}.`,
    llm_usage: { provider: null, models: [], input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    targets: [...failed, ...refused].map((item) => ({ path: item.path, status: 'failed', plain_english_summary: item.outcome })),
    issues: failed.map((item) => `${item.path}: ${item.outcome}`), follow_up: refused.map((item) => `${item.path}: ${item.outcome}`),
    report_file: report.file,
  };
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 1)}\n`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!['status', 'sweep'].includes(command)) {
    process.stderr.write('Usage: worktree-sweep.mjs status|sweep [--apply] [--json] [--repo <path>]... [--config <file>] [--report-dir <dir>] [--summary-path <file>]\n');
    return 64;
  }
  const options = { repoFilter: [] };
  let json = false;
  let summaryPath;
  const startedAt = new Date().toISOString();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--apply' && command === 'sweep') options.apply = true;
    else if (flag === '--json') json = true;
    else if (flag === '--repo') options.repoFilter.push(rest[++index]);
    else if (flag === '--config') options.configPath = rest[++index];
    else if (flag === '--report-dir') options.reportDir = rest[++index];
    else if (flag === '--summary-path') summaryPath = rest[++index];
    else { process.stderr.write(`Unknown option ${flag}\n`); return 64; }
  }
  const report = runSweep(options);
  process.stdout.write(`${json ? JSON.stringify(report, null, 1) : summarize(report)}\n`);
  if (summaryPath) writeSummary(summaryPath, report, startedAt);
  if (!report.usable) return 2;
  return [...report.worktrees, ...report.restored].some((item) => item.outcome?.startsWith('failed')) ? 1 : 0;
}

if (process.argv[1] && realpathOrSelf(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
