import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CoordinationAssignment, CoordinationClaim, CoordinationEvent, CoordinationMessage, CoordinationScope, CoordinationSnapshot } from '@agent-console/shared';
import type { AppDatabase } from '../db/database.js';
import { checkoutIdentity, claimPath, commitFingerprint, dirty, git, overlaps, preparedTree } from './git.js';

const execFileAsync = promisify(execFile);
const assignmentColumns = `id, provider, native_session_id as nativeSessionId, description, status, started_at as startedAt, last_seen_at as lastSeenAt`;
const scopeColumns = `assignment_id as assignmentId, checkout, repository, summary`;
const claimColumns = `assignment_id as assignmentId, checkout, path, acquired_at as acquiredAt`;
const eventColumns = `seq, assignment_id as assignmentId, checkout, kind, text, timestamp`;
const messageColumns = `id, sender_id as senderId, recipient_id as recipientId, text, created_at as createdAt, supplied_at as suppliedAt, acknowledged_at as acknowledgedAt`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function processStart(pid: number): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
  } catch { return ''; }
}

export interface CoordinationSettings { enabled: boolean; pilotPaths: string[] }

export class CoordinationService {
  private readonly activeGit = new Set<string>();
  constructor(private readonly db: AppDatabase, readonly settings: CoordinationSettings) {}

  private event(id: string, checkout: string | null, kind: string, text: string): void {
    this.db.sqlite.prepare('insert into coordination_events(assignment_id, checkout, kind, text, timestamp) values(?,?,?,?,?)')
      .run(id, checkout, kind, text, new Date().toISOString());
  }

  private assignment(id: string): CoordinationAssignment {
    const row = this.db.sqlite.prepare(`select ${assignmentColumns} from coordination_assignments where id=?`).get(id) as CoordinationAssignment | undefined;
    if (!row) throw new Error('Unknown assignment.');
    return row;
  }

  private identity(directory: string) {
    if (!this.settings.enabled) throw new Error('Coordination is disabled.');
    const identity = checkoutIdentity(directory);
    const enabled = this.settings.pilotPaths.some((candidate) => checkoutIdentity(candidate).repository === identity.repository);
    if (!enabled) throw new Error('This repository is outside the coordination pilot.');
    return identity;
  }

  eligible(directory: string): boolean {
    try { this.identity(directory); return true; } catch { return false; }
  }

  register(input: { provider: string; nativeSessionId: string; token: string; pid: number; cwd: string }): { enabled: boolean; assignmentId?: string } {
    // Assignment identity is independent of its launch directory. Scope and
    // editing claims, rather than registration, enforce the pilot boundary.
    if (!this.settings.enabled) return { enabled: false };
    const start = processStart(input.pid);
    if (!start) throw new Error('Registration requires a live local process.');
    const tokenHash = digest(input.token);
    return this.db.sqlite.transaction(() => {
      const existing = this.db.sqlite.prepare('select id, token_hash from coordination_assignments where provider=? and native_session_id=?')
        .get(input.provider, input.nativeSessionId) as { id: string; token_hash: string } | undefined;
      const id = existing?.id ?? randomUUID();
      const now = new Date().toISOString();
      if (existing) {
        const previous = this.db.sqlite.prepare('select pid, process_start from coordination_assignments where id=?').get(id) as { pid: number; process_start: string };
        if (previous.pid !== input.pid && processStart(previous.pid) === previous.process_start) throw new Error('That provider session already has a live coordination owner.');
        if (existing.token_hash !== tokenHash) {
          // An interrupted client write may have lost the credential. Only the
          // original, still-running host process may repair that registration.
          if (previous.pid !== input.pid || previous.process_start !== start) throw new Error('Credential recovery requires the original live provider process.');
          this.db.sqlite.prepare('update coordination_assignments set token_hash=? where id=?').run(tokenHash, id);
          this.event(id, null, 'credential-recovered', 'Repaired the credential for the same live provider process; assignment and claims preserved.');
        }
        this.db.sqlite.prepare("update coordination_assignments set pid=?, process_start=?, status='active', last_seen_at=? where id=?").run(input.pid, start, now, id);
      } else {
        this.db.sqlite.prepare('insert into coordination_assignments values(?,?,?,?,?,?,?,?,?,?)')
          .run(id, input.provider, input.nativeSessionId, tokenHash, 'Assignment not yet described', 'active', input.pid, start, now, now);
      }
      this.event(id, null, existing ? 'resumed' : 'started', existing ? 'Resumed; refresh current scope and unfinished changes.' : 'Session registered; awaiting assignment scope.');
      return { enabled: true, assignmentId: id };
    }).immediate();
  }

  authenticate(id: string, token: string): void {
    const row = this.db.sqlite.prepare('select token_hash from coordination_assignments where id=?').get(id) as { token_hash: string } | undefined;
    if (!row || row.token_hash !== digest(token)) throw new Error('Invalid coordination credential.');
  }

  reconcileProcesses(): void {
    const rows = this.db.sqlite.prepare("select id, pid, process_start from coordination_assignments where status in ('active','waiting')")
      .all() as { id: string; pid: number; process_start: string }[];
    this.db.sqlite.transaction(() => {
      for (const row of rows) {
        if (processStart(row.pid) === row.process_start) continue;
        this.db.sqlite.prepare("update coordination_assignments set status='disconnected' where id=?").run(row.id);
        this.event(row.id, null, 'disconnected', 'Process ended. Editing claims and unfinished changes remain for reconciliation.');
      }
    })();
  }

  update(id: string, input: { description?: string; checkout?: string; summary?: string; status?: 'active' | 'waiting' }) {
    const identity = input.checkout ? this.identity(input.checkout) : undefined;
    return this.db.sqlite.transaction(() => {
      const current = this.assignment(id);
      if (current.status === 'finished' || current.status === 'disconnected') throw new Error('Resume this assignment before updating it.');
      this.db.sqlite.prepare('update coordination_assignments set description=?, status=?, last_seen_at=? where id=?')
        .run(input.description ?? current.description, input.status ?? current.status, new Date().toISOString(), id);
      if (identity) this.db.sqlite.prepare(`insert into coordination_scopes values(?,?,?,?) on conflict(assignment_id,checkout) do update set summary=excluded.summary`)
        .run(id, identity.checkout, identity.repository, input.summary ?? 'Scope added');
      this.event(id, identity?.checkout ?? null, 'update', input.summary ?? input.description ?? `Status: ${input.status}`);
      return this.poll(id, 0, false);
    }).immediate();
  }

  claim(id: string, directory: string, values: string[]) {
    const { checkout, repository } = this.identity(directory);
    const paths = [...new Set(values.map((value) => claimPath(checkout, value)))];
    return this.db.sqlite.transaction(() => {
      if (this.assignment(id).status !== 'active') throw new Error('Only an active assignment can acquire editing claims.');
      if (!this.db.sqlite.prepare('select 1 from coordination_scopes where assignment_id=? and checkout=?').get(id, checkout)) throw new Error('Announce this checkout and intended changes before claiming files.');
      if (this.db.sqlite.prepare('select 1 from coordination_git_operations where repository=?').get(repository)) throw new Error('A coordinated Git operation is in progress or needs reconciliation.');
      const claims = this.db.sqlite.prepare(`select ${claimColumns} from coordination_claims where checkout=?`).all(checkout) as CoordinationClaim[];
      const conflicts = claims.filter((claim) => claim.assignmentId !== id && paths.some((p) => overlaps(p, claim.path)));
      if (conflicts.length) return { acquired: false, conflicts };
      const newPaths = paths.filter((p) => !claims.some((claim) => claim.assignmentId === id && (claim.path === '.' || p === claim.path || p.startsWith(`${claim.path}/`))));
      if (newPaths.length && dirty(checkout, newPaths)) throw new Error('Unowned changes already exist in these paths. Ask their owner to hand them off; do not claim or overwrite them.');
      for (const p of newPaths) this.db.sqlite.prepare('insert into coordination_claims values(?,?,?,?)').run(checkout, p, id, new Date().toISOString());
      this.event(id, checkout, 'claimed', paths.join(', '));
      return { acquired: true, conflicts: [] };
    }).immediate();
  }

  release(id: string, directory: string, values: string[]) {
    const { checkout } = this.identity(directory);
    const paths = values.map((p) => claimPath(checkout, p));
    if (dirty(checkout, paths)) throw new Error('These claims contain unfinished changes. Commit them through the helper or hand them off.');
    this.db.sqlite.transaction(() => {
      for (const p of paths) this.db.sqlite.prepare('delete from coordination_claims where checkout=? and path=? and assignment_id=?').run(checkout, p, id);
      this.event(id, checkout, 'released', paths.join(', '));
    }).immediate();
    return { released: true };
  }

  check(id: string, directory: string, values: string[]) {
    const { checkout, repository } = this.identity(directory);
    if (this.db.sqlite.prepare('select 1 from coordination_git_operations where repository=?').get(repository)) throw new Error('Coordinated Git operation in progress; retry after it completes.');
    const owned = this.db.sqlite.prepare('select path from coordination_claims where assignment_id=? and checkout=?').all(id, checkout) as { path: string }[];
    for (const value of values) {
      const p = claimPath(checkout, value);
      if (!owned.some((claim) => claim.path === '.' || p === claim.path || p.startsWith(`${claim.path}/`))) throw new Error(`Acquire an editing claim before changing ${p}.`);
    }
    return { allowed: true };
  }

  review(directory: string, values: string[]) {
    const identity = this.identity(directory);
    const paths = [...new Set(values.map((p) => claimPath(identity.checkout, p)))];
    const untracked = git(identity.checkout, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...paths]).split('\0').filter(Boolean).map((file) => {
      const absolute = path.join(identity.checkout, file);
      // A directory review includes links even though direct link claims are
      // refused. Return the link target, never dereference its contents.
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return { path: file, bytes: stat.size, content: null, symlinkTarget: fs.readlinkSync(absolute) };
      claimPath(identity.checkout, file);
      const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let content: Buffer;
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) throw new Error('Only regular files can be reviewed as untracked content.');
        if (opened.size > 64 * 1024) return { path: file, bytes: opened.size, content: null };
        const buffer = Buffer.alloc(64 * 1024 + 1);
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        content = buffer.subarray(0, bytes);
      } finally { fs.closeSync(fd); }
      return { path: file, bytes: content.length, content: content.length <= 64 * 1024 && !content.includes(0) ? content.toString('utf8') : null };
    });
    return { ...identity, paths, fingerprint: commitFingerprint(identity.checkout, paths), diff: git(identity.checkout, ['diff', '--binary', 'HEAD', '--', ...paths]), untracked, status: git(identity.checkout, ['status', '--short', '--', ...paths]) };
  }

  adopt(id: string, directory: string, values: string[], fingerprint: string, reason: string) {
    const { checkout, repository, paths } = this.review(directory, values);
    this.reconcileProcesses();
    if (this.assignment(id).status !== 'active') throw new Error('Only an active assignment can reconcile claims.');
    if (!this.db.sqlite.prepare('select 1 from coordination_scopes where assignment_id=? and checkout=?').get(id, checkout)) throw new Error('Announce this checkout before reconciliation.');
    return this.db.sqlite.transaction(() => {
      if (this.db.sqlite.prepare('select 1 from coordination_git_operations where repository=?').get(repository)) throw new Error('Reconcile the unfinished Git operation before adopting claims.');
      if (commitFingerprint(checkout, paths) !== fingerprint) throw new Error('Changes differ from the reviewed reconciliation fingerprint.');
      const claims = this.db.sqlite.prepare(`select ${claimColumns} from coordination_claims where checkout=?`).all(checkout) as CoordinationClaim[];
      for (const claim of claims.filter((c) => paths.some((p) => overlaps(p, c.path)))) {
        if (claim.assignmentId === id) continue;
        const previous = this.assignment(claim.assignmentId);
        if (previous.status === 'active' || previous.status === 'waiting') throw new Error('A live owner must explicitly hand off its changes.');
        if (!paths.includes(claim.path)) throw new Error('Reconcile complete existing claims; do not split or widen another assignment\'s scope.');
      }
      for (const p of paths) this.db.sqlite.prepare('insert into coordination_claims values(?,?,?,?) on conflict(checkout,path) do update set assignment_id=excluded.assignment_id, acquired_at=excluded.acquired_at')
        .run(checkout, p, id, new Date().toISOString());
      this.event(id, checkout, 'reconciled', `${reason}; paths ${paths.join(', ')}; reviewed fingerprint ${fingerprint}`);
      return { adopted: true };
    }).immediate();
  }

  maintenanceEnter(id: string, directory: string) {
    const { checkout, repository } = this.identity(directory);
    if (this.assignment(id).provider !== 'maintenance') throw new Error('Maintenance entry requires a maintenance identity.');
    this.reconcileProcesses();
    return this.db.sqlite.transaction(() => {
      const owners = this.db.sqlite.prepare(`select distinct a.id from coordination_assignments a join coordination_scopes s on s.assignment_id=a.id
        where s.checkout=? and a.id!=? and (a.status in ('active','waiting') or exists(select 1 from coordination_claims c where c.assignment_id=a.id and c.checkout=?))`).all(checkout, id, checkout);
      if (owners.length || this.db.sqlite.prepare('select 1 from coordination_claims where checkout=? and assignment_id!=?').get(checkout, id)
        || this.db.sqlite.prepare('select 1 from coordination_git_operations where repository=?').get(repository)) throw new Error('Source checkout has active assignments or unresolved claims; maintenance deferred.');
      this.db.sqlite.prepare('insert into coordination_scopes values(?,?,?,?) on conflict(assignment_id,checkout) do update set summary=excluded.summary').run(id, checkout, repository, 'Scheduled source-checkout synchronization');
      this.db.sqlite.prepare('insert into coordination_claims values(?,?,?,?)').run(checkout, '.', id, new Date().toISOString());
      const owner = this.db.sqlite.prepare('select pid, process_start from coordination_assignments where id=?').get(id) as { pid: number; process_start: string };
      this.db.sqlite.prepare('insert into coordination_git_operations values(?,?,?,?,?,?)').run(repository, checkout, id, new Date().toISOString(), owner.pid, owner.process_start);
      this.event(id, checkout, 'maintenance-entered', 'Exclusive source-write claim acquired; existing dirty contents remain governed by maintenance snapshot verification.');
      return { acquired: true };
    }).immediate();
  }

  maintenanceExit(id: string, directory: string) {
    const { checkout } = this.identity(directory);
    if (this.assignment(id).provider !== 'maintenance') throw new Error('Maintenance exit requires a maintenance identity.');
    this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare('delete from coordination_claims where assignment_id=? and checkout=?').run(id, checkout);
      this.db.sqlite.prepare('delete from coordination_git_operations where assignment_id=? and checkout=?').run(id, checkout);
      this.db.sqlite.prepare("update coordination_assignments set status='finished' where id=?").run(id);
      this.event(id, checkout, 'maintenance-exited', 'Source synchronization ended; released exclusive claim without altering remaining worktree changes.');
    }).immediate();
    return { released: true };
  }

  handoff(id: string, recipient: string, directory: string, values: string[], fingerprint: string) {
    const { checkout } = this.identity(directory);
    const paths = values.map((p) => claimPath(checkout, p));
    if (this.assignment(recipient).status !== 'active') throw new Error('Handoff recipient must be active.');
    if (!this.db.sqlite.prepare('select 1 from coordination_scopes where assignment_id=? and checkout=?').get(recipient, checkout)) throw new Error('Recipient must announce this checkout before accepting a handoff.');
    if (commitFingerprint(checkout, paths) !== fingerprint) throw new Error('Changes differ from the reviewed handoff fingerprint.');
    this.db.sqlite.transaction(() => {
      for (const p of paths) {
        const result = this.db.sqlite.prepare('update coordination_claims set assignment_id=? where checkout=? and path=? and assignment_id=?').run(recipient, checkout, p, id);
        if (!result.changes) throw new Error('Handoff requires ownership of every exact claim.');
      }
      this.event(id, checkout, 'handoff', `Transferred ${paths.join(', ')} to ${recipient}; fingerprint ${fingerprint}`);
    }).immediate();
    return { transferred: true };
  }

  send(id: string, input: { id: string; recipientId: string; text: string }) {
    this.assignment(input.recipientId);
    if (this.assignment(input.recipientId).status === 'finished') throw new Error('Recipient assignment is finished.');
    const existing = this.db.sqlite.prepare('select sender_id, recipient_id, text from coordination_messages where id=?').get(input.id) as { sender_id: string; recipient_id: string; text: string } | undefined;
    if (existing) {
      if (existing.sender_id !== id || existing.recipient_id !== input.recipientId || existing.text !== input.text) throw new Error('Message ID already used for different content.');
      return { id: input.id };
    }
    const count = this.db.sqlite.prepare('select count(*) as n from coordination_messages where recipient_id=? and acknowledged_at is null').get(input.recipientId) as { n: number };
    if (count.n >= 100) throw new Error('Recipient inbox is full; wait for acknowledgements.');
    this.db.sqlite.prepare('insert into coordination_messages values(?,?,?,?,?,null,null)').run(input.id, id, input.recipientId, input.text, new Date().toISOString());
    return { id: input.id };
  }

  acknowledge(id: string, messages: string[]) {
    this.db.sqlite.transaction(() => {
      for (const message of messages) {
        const result = this.db.sqlite.prepare('update coordination_messages set acknowledged_at=coalesce(acknowledged_at,?) where id=? and recipient_id=? and supplied_at is not null')
          .run(new Date().toISOString(), message, id);
        if (!result.changes) throw new Error('Only the recipient can acknowledge a supplied message.');
      }
    })();
    return { acknowledged: messages };
  }

  poll(id: string, after: number, supply = true) {
    return this.db.sqlite.transaction(() => {
      const current = this.assignment(id);
      this.db.sqlite.prepare('update coordination_assignments set last_seen_at=? where id=?').run(new Date().toISOString(), id);
      const candidates = this.db.sqlite.prepare(`select ${eventColumns} from coordination_events e where seq>? and assignment_id!=? and (
      exists(select 1 from coordination_scopes mine join coordination_scopes theirs on mine.repository=theirs.repository where mine.assignment_id=? and theirs.assignment_id=e.assignment_id)
      ) order by seq limit 25`).all(after, id, id) as CoordinationEvent[];
      const messages = this.db.sqlite.prepare(`select ${messageColumns} from coordination_messages where recipient_id=? and acknowledged_at is null
        and (supplied_at is null or supplied_at<?) order by created_at limit 3`).all(id, new Date(Date.now() - 60_000).toISOString()) as CoordinationMessage[];
      let remaining = 8000 - JSON.stringify(messages).length;
      const events: CoordinationEvent[] = [];
      for (const candidate of candidates) {
        // Old events can be arbitrarily large (for example a directory's claim
        // list). Bound only their delivery representation; retain the full log.
        let delivered = candidate;
        if (JSON.stringify(delivered).length > 4000) {
          delivered = { ...candidate, text: '[Event abbreviated; use status for full activity.]' };
          while (JSON.stringify(delivered).length > 4000 && delivered.checkout) delivered.checkout = delivered.checkout.slice(0, -256);
          let prefix = '';
          for (const character of candidate.text) {
            const next = { ...delivered, text: `${prefix}${character}… [abbreviated; use status for full activity]` };
            if (JSON.stringify(next).length > 4000) break;
            prefix += character;
            delivered = next;
          }
        }
        const size = JSON.stringify(delivered).length;
        if (size > remaining) break;
        events.push(delivered); remaining -= size;
      }
      if (supply) for (const message of messages) this.db.sqlite.prepare('update coordination_messages set supplied_at=? where id=?').run(new Date().toISOString(), message.id);
      const maximum = this.db.sqlite.prepare('select coalesce(max(seq),0) as seq from coordination_events').get() as { seq: number };
      const incomplete = events.length < candidates.length || candidates.length === 25;
      return { assignment: current, events, messages, cursor: incomplete ? (events.at(-1)?.seq ?? after) : maximum.seq };
    }).immediate();
  }

  finish(id: string, summary: string) {
    return this.db.sqlite.transaction(() => {
      if (this.db.sqlite.prepare('select 1 from coordination_git_operations where assignment_id=?').get(id)) throw new Error('Finish or reconcile this assignment\'s Git operation before closing it.');
      const claims = this.db.sqlite.prepare(`select ${claimColumns} from coordination_claims where assignment_id=?`).all(id) as CoordinationClaim[];
      for (const claim of claims) if (!dirty(claim.checkout, [claim.path])) this.db.sqlite.prepare('delete from coordination_claims where checkout=? and path=?').run(claim.checkout, claim.path);
      this.db.sqlite.prepare("update coordination_assignments set status='finished' where id=?").run(id);
      this.event(id, null, 'finished', summary);
      return { finished: true, retainedClaims: this.db.sqlite.prepare(`select ${claimColumns} from coordination_claims where assignment_id=?`).all(id) };
    }).immediate();
  }

  disconnect(id: string) {
    if (this.assignment(id).status !== 'finished') {
      this.db.sqlite.prepare("update coordination_assignments set status='disconnected' where id=?").run(id);
      this.event(id, null, 'disconnected', 'Session ended; unfinished claims retained.');
    }
    return { disconnected: true };
  }

  preview(id: string, directory: string, values: string[]) {
    const identity = this.identity(directory);
    const paths = [...new Set(values.map((p) => claimPath(identity.checkout, p)))];
    const claims = this.db.sqlite.prepare(`select ${claimColumns} from coordination_claims where checkout=? and assignment_id=?`).all(identity.checkout, id) as CoordinationClaim[];
    if (!paths.every((p) => claims.some((claim) => claim.path === '.' || p === claim.path || p.startsWith(`${claim.path}/`)))) throw new Error('Claim every selected path before preparing a commit or handoff.');
    return this.review(identity.checkout, paths);
  }

  async commit(id: string, directory: string, paths: string[], fingerprint: string, message: string) {
    const preview = this.preview(id, directory, paths);
    if (preview.fingerprint !== fingerprint) throw new Error('Changes differ from the reviewed commit fingerprint. Prepare and review again.');
    if (git(preview.checkout, ['diff', '--cached', '--name-only'])) throw new Error('The shared index contains staged changes. Reconcile them before a coordinated commit.');
    if (!dirty(preview.checkout, preview.paths)) throw new Error('No changes to commit.');
    this.db.sqlite.prepare('insert into coordination_git_operations values(?,?,?,?,?,?)')
      .run(preview.repository, preview.checkout, id, new Date().toISOString(), process.pid, processStart(process.pid));
    this.activeGit.add(preview.repository);
    const originalHead = git(preview.checkout, ['rev-parse', 'HEAD']);
    try {
      const expectedTree = preparedTree(preview.checkout, preview.paths);
      if (commitFingerprint(preview.checkout, preview.paths) !== fingerprint) throw new Error('Files changed while preparing the commit; review again.');
      git(preview.checkout, ['add', '--intent-to-add', '--', ...preview.paths]);
      // --only leaves unrelated worktree paths out. Claims remain held until the
      // command exits. Raw shell writers are outside the cooperative guarantee.
      await execFileAsync('git', ['--literal-pathspecs', '-C', preview.checkout, 'commit', '--only', '-m', message, '--', ...preview.paths], {
        timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      const head = git(preview.checkout, ['rev-parse', 'HEAD']);
      if (git(preview.checkout, ['rev-parse', 'HEAD^{tree}']) !== expectedTree) throw new Error('Committed tree differs from the reviewed changes, possibly due to a Git hook. Reconcile the retained Git lock before proceeding.');
      const changed = git(preview.checkout, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', originalHead, head]).split('\0').filter(Boolean);
      if (changed.some((p) => !preview.paths.some((scope) => scope === '.' || p === scope || p.startsWith(`${scope}/`)))) throw new Error('Commit changed paths outside the reviewed scope; retain Git lock for reconciliation.');
      this.event(id, preview.checkout, 'committed', `${head}: ${message}`);
      this.db.sqlite.prepare('delete from coordination_git_operations where repository=?').run(preview.repository);
      return { commit: head };
    } catch (error) {
      if (git(preview.checkout, ['rev-parse', 'HEAD']) === originalHead && !fs.existsSync(path.join(git(preview.checkout, ['rev-parse', '--absolute-git-dir']), 'index.lock'))) {
        git(preview.checkout, ['reset', '-q', 'HEAD', '--', ...preview.paths]);
        this.db.sqlite.prepare('delete from coordination_git_operations where repository=?').run(preview.repository);
      }
      this.event(id, preview.checkout, 'commit-failed', 'Commit failed. Inspect HEAD, index and claims before retrying.');
      throw error;
    } finally {
      this.activeGit.delete(preview.repository);
    }
  }

  recoverGit(id: string, directory: string, fingerprint: string, reason: string) {
    const review = this.review(directory, ['.']);
    const operation = this.db.sqlite.prepare('select checkout, server_pid, process_start from coordination_git_operations where repository=?').get(review.repository) as { checkout: string; server_pid: number; process_start: string } | undefined;
    if (!operation) throw new Error('No unfinished Git operation exists for this repository.');
    if (operation.checkout !== review.checkout) throw new Error(`Review the failed operation's checkout before recovery: ${operation.checkout}`);
    if (this.activeGit.has(review.repository) || (operation.server_pid !== process.pid && processStart(operation.server_pid) === operation.process_start)) throw new Error('The Git operation owner is still running.');
    if (review.fingerprint !== fingerprint) throw new Error('Reconciliation fingerprint changed; review the checkout again.');
    const gitDir = git(review.checkout, ['rev-parse', '--absolute-git-dir']);
    if (fs.existsSync(path.join(gitDir, 'index.lock'))) throw new Error('Git still has an index lock; inspect the owning process before reconciliation.');
    this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare('delete from coordination_git_operations where repository=?').run(review.repository);
      this.event(id, review.checkout, 'git-reconciled', `${reason}; reviewed fingerprint ${fingerprint}. File claims retained.`);
    }).immediate();
    return { recovered: true };
  }

  snapshot(directory?: string): CoordinationSnapshot {
    if (!this.settings.enabled || (directory && !this.eligible(directory))) return { enabled: false, assignments: [], scopes: [], claims: [], events: [], messages: [] };
    this.reconcileProcesses();
    const repository = directory ? checkoutIdentity(directory).repository : undefined;
    const scopes = this.db.sqlite.prepare(`select ${scopeColumns} from coordination_scopes`).all() as CoordinationScope[];
    const claims = this.db.sqlite.prepare(`select ${claimColumns} from coordination_claims`).all() as CoordinationClaim[];
    const assignments = (this.db.sqlite.prepare(`select ${assignmentColumns} from coordination_assignments order by started_at desc`).all() as CoordinationAssignment[])
      .filter((assignment) => !repository || scopes.some((scope) => scope.assignmentId === assignment.id && scope.repository === repository));
    const ids = new Set(assignments.map((a) => a.id));
    return {
      enabled: this.settings.enabled, assignments,
      scopes: scopes.filter((s) => ids.has(s.assignmentId)), claims: claims.filter((c) => ids.has(c.assignmentId)),
      events: (this.db.sqlite.prepare(`select ${eventColumns} from coordination_events order by seq desc limit 200`).all() as CoordinationEvent[]).filter((e) => ids.has(e.assignmentId)).slice(0, 50),
      messages: (this.db.sqlite.prepare(`select ${messageColumns} from coordination_messages order by created_at desc limit 200`).all() as CoordinationMessage[]).filter((m) => ids.has(m.senderId) || ids.has(m.recipientId)).slice(0, 50),
    };
  }
}
