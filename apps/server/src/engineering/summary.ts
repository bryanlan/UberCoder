import fs from 'node:fs';
import path from 'node:path';
import { normalizeFsPath } from '../lib/path-utils.js';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { readSummaryConfig } from './config.js';
import { sanitizeExport } from './export-redaction.js';

type Status = 'ok' | 'partial' | 'error';
interface Issue { source: string; code: string; message: string }
interface Source { path: string; status: Status; observed_at: string; issues: Issue[] }
interface Scope { checkout: string; repository: string; summary: string; updated_at: string | null }
interface AssignmentRow {
  id: string; provider: string; description: string; status: string; native_session_id: string;
  pid: number; process_start: string; started_at: string; last_seen_at: string;
}
interface SessionRow {
  id: string; provider: string; project_slug: string; status: string; pid: number | null;
  conversation_ref: string; resume_conversation_ref: string | null;
}
export interface ProcessIdentity { start: string; name: string; cwd: string | null; unattributed?: boolean }
export interface SummaryOptions {
  database: string; wikiDatabase: string; config?: string; now?: number;
  processIdentity?: (pid: number) => ProcessIdentity | null;
  git?: (repository: string, args: string[]) => string;
}

const DAY = 86_400_000;
const READ_ERROR_CODES = new Set(['SQLITE_ERROR', 'SQLITE_CANTOPEN', 'SQLITE_BUSY', 'SQLITE_LOCKED',
  'SQLITE_NOTADB', 'SQLITE_CORRUPT', 'SQLITE_READONLY', 'ENOENT', 'EACCES', 'PROCESS_CHECKOUT_UNAVAILABLE', 'INVALID_ITEM']);
const iso = (n: number) => new Date(n).toISOString();
const count = (db: Database.Database, sql: string, ...args: string[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

type ReportInvalid = (stage: string, count: number) => void;
const text = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => text(value) && value.trim().length > 0;
const nullableText = (value: unknown) => value === null || text(value);
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum;
function validRows<T>(rows: T[], valid: (row: T) => boolean, report: ReportInvalid, stage: string): T[] {
  const retained = rows.filter(valid);
  if (retained.length !== rows.length) report(stage, rows.length - retained.length);
  return retained;
}

export function readProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (tail[0] === 'Z' || !tail[19]) return null;
    let cwd: string | null = null;
    let unattributed = false;
    try {
      const processDirectory = fs.readlinkSync(`/proc/${pid}/cwd`);
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
      for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE']) delete env[name];
      cwd = fs.realpathSync(execFileSync('git', ['-C', processDirectory, 'rev-parse', '--show-toplevel'], {
        env, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim());
    } catch (error) {
      const fault = error as { status?: number; stderr?: Buffer | string };
      // A readable non-Git working directory is normal for cross-repo sessions.
      // Permission failures, timeouts and unavailable Git remain unknown evidence.
      unattributed = fault.status === 128 && String(fault.stderr ?? '').includes('not a git repository');
    }
    return { start: tail[19], name: raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')), cwd, unattributed };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ESRCH'].includes(String(error.code))) return null;
    throw new Error('Process ownership could not be read.');
  }
}

function readAssignments(db: Database.Database, options: SummaryOptions, now: number, report: ReportInvalid) {
  const processIdentity = options.processIdentity ?? readProcessIdentity;
  const identities = new Map<number, ProcessIdentity | null>();
  const identity = (pid: number) => {
    if (!identities.has(pid)) {
      let value: ProcessIdentity | null = null;
      try {
        const candidate = processIdentity(pid);
        if (candidate !== null && (!nonempty(candidate?.start) || !nonempty(candidate?.name)
          || !(candidate.cwd === null || nonempty(candidate.cwd))
          || !(candidate.unattributed === undefined || typeof candidate.unattributed === 'boolean'))) {
          report('ownership', 1);
        } else value = candidate;
      } catch { report('ownership', 1); }
      identities.set(pid, value);
    }
    return identities.get(pid) ?? null;
  };
  const rows = validRows(db.prepare(`select id,provider,description,status,native_session_id,pid,process_start,started_at,last_seen_at
    from coordination_assignments order by started_at desc,id`).all() as AssignmentRow[], row => nonempty(row.id)
      && nonempty(row.provider) && text(row.description) && ['active', 'waiting', 'finished', 'disconnected'].includes(row.status)
      && nonempty(row.native_session_id) && integer(row.pid, 1) && nonempty(row.process_start)
      && timestamp(row.started_at) && timestamp(row.last_seen_at), report, 'assignments');
  const scopeRows = validRows(db.prepare(`select s.assignment_id,s.checkout,s.repository,s.summary,
      (select max(e.timestamp) from coordination_events e where e.assignment_id=s.assignment_id and e.checkout=s.checkout
        and e.kind='update') as updated_at from coordination_scopes s order by s.checkout`).all() as Array<Scope & { assignment_id: string }>, row => nonempty(row.assignment_id) && nonempty(row.checkout)
      && nonempty(row.repository) && text(row.summary) && (row.updated_at === null || timestamp(row.updated_at)), report, 'scopes');
  const sessionRows = validRows(db.prepare(`select id,provider,project_slug,status,pid,conversation_ref,resume_conversation_ref
    from bound_sessions where status='bound' order by id`).all() as SessionRow[], row => nonempty(row.id)
      && nonempty(row.provider) && nonempty(row.project_slug) && row.status === 'bound' && (row.pid === null || integer(row.pid, 1))
      && nonempty(row.conversation_ref) && nullableText(row.resume_conversation_ref), report, 'sessions');
  const scopes = new Map<string, Scope[]>();
  for (const row of scopeRows) scopes.set(row.assignment_id, [...scopes.get(row.assignment_id) ?? [], {
    checkout: row.checkout, repository: row.repository, summary: row.summary, updated_at: row.updated_at }]);
  const sessionProcessKeys = new Map<string, string>();
  const sessions = sessionRows.map(s => {
    const owner = rows.find(a => a.provider === s.provider
      && (a.native_session_id === s.conversation_ref || a.native_session_id === s.resume_conversation_ref));
    const p = s.pid ? identity(s.pid) : null;
    // A stale bound row and a recycled unrelated PID are not proof of a live session.
    const live = Boolean(p && p.name === s.provider && (!owner || (owner.pid === s.pid && owner.process_start === p.start)));
    if (live) sessionProcessKeys.set(s.id, `${s.provider}:${s.pid}:${p!.start}`);
    return { id: s.id, provider: s.provider, project: s.project_slug, status: s.status,
      live, checkout: live ? p!.cwd : null, unattributed: Boolean(live && p!.unattributed), assignment_id: owner?.id ?? null };
  });
  const counts = { total: rows.length, active: 0, waiting: 0, idle: 0, finished: 0, started_never_finished: 0 };
  const assignments = rows.map(row => {
    const p = identity(row.pid);
    const live = Boolean(p && p.start === row.process_start && p.name === row.provider);
    const sessionIds = sessions.filter(s => s.assignment_id === row.id && s.live).map(s => s.id);
    const state = row.status === 'finished' ? 'finished' : live && row.status === 'active' ? 'active'
      : live && row.status === 'waiting' ? 'waiting' : 'idle';
    counts[state]++;
    const neverFinished = row.status !== 'finished' && !live && !sessionIds.length && now - Date.parse(row.started_at) > DAY;
    if (neverFinished) counts.started_never_finished++;
    const assignmentScopes = scopes.get(row.id) ?? [];
    const latestScope = assignmentScopes.filter(s => s.updated_at !== null)
      .sort((a, b) => b.updated_at!.localeCompare(a.updated_at!))[0]
      ?? (assignmentScopes.length === 1 ? assignmentScopes[0] : undefined);
    return { id: row.id, provider: row.provider, description: row.description,
      status: state, recorded_status: row.status, started_at: row.started_at, last_seen_at: row.last_seen_at,
      live_process: live, process_checkout: live ? p!.cwd : null, process_unattributed: Boolean(live && p!.unattributed),
      live_session: live || sessionIds.length > 0, session_ids: sessionIds, started_never_finished: neverFinished,
      activity_summary: latestScope?.summary ?? '', scopes: assignmentScopes };
  });
  const unattributed = new Map<string, { provider: string; assignment_id: string | null; session_id: string | null; description: string }>();
  const assignmentRows = new Map(rows.map(row => [row.id, row]));
  // Assignments are newest first; multiple historical assignments can share a process.
  for (const assignment of assignments.filter(a => a.live_process && a.process_unattributed)) {
    const row = assignmentRows.get(assignment.id)!;
    const key = `${row.provider}:${row.pid}:${row.process_start}`;
    if (!unattributed.has(key)) unattributed.set(key, { provider: assignment.provider, assignment_id: assignment.id,
      session_id: null, description: assignment.description });
  }
  for (const session of sessions.filter(s => s.live && s.unattributed)) {
    const key = sessionProcessKeys.get(session.id)!;
    const existing = unattributed.get(key);
    if (existing) { if (!existing.session_id) existing.session_id = session.id; }
    else unattributed.set(key, { provider: session.provider, assignment_id: session.assignment_id, session_id: session.id,
      description: 'Live provider session without an assignment' });
  }
  return { counts, assignments, sessions, unattributed_sessions: [...unattributed.values()] };
}

function readConfiguredProjects(configPath: string): string[] {
  const config = readSummaryConfig(configPath);
  const paths = Object.entries(config.projects).map(([name, project]) =>
    normalizeFsPath(project.path ?? path.join(normalizeFsPath(config.projectsRoot), name)));
  return [...new Set(paths)].sort();
}

function readYesterdayActivity(db: Database.Database, now: number, report: ReportInvalid) {
  const end = Date.parse(iso(now).slice(0, 10)), start = end - DAY;
  const total = count(db, "select count(*) as n from coordination_events where kind='update' and timestamp>=? and timestamp<?", iso(start), iso(end));
  const items = validRows(db.prepare(`select e.seq as id,e.assignment_id,e.checkout,e.timestamp as at,
      coalesce(a.description,'Assignment metadata unavailable') as description,e.text as summary
    from coordination_events e left join coordination_assignments a on a.id=e.assignment_id
    where e.kind='update' and e.timestamp>=? and e.timestamp<? order by e.timestamp,e.seq limit 1000`)
    .all(iso(start), iso(end)) as Array<{ id: number; assignment_id: string; checkout: string | null; at: string; description: string; summary: string }>, row => integer(row.id, 1) && nonempty(row.assignment_id) && nullableText(row.checkout)
      && timestamp(row.at) && text(row.description) && text(row.summary), report, 'activity');
  return { date: iso(start).slice(0, 10), timezone: 'UTC' as const, total, sampled: total > items.length, items };
}

function readMessages(db: Database.Database, now: number) {
  const start = Date.parse(iso(now).slice(0, 10)) - 13 * DAY;
  const rows = db.prepare(`select substr(created_at,1,10) as date,count(*) as count from coordination_messages
    where created_at>=? and created_at<=? group by substr(created_at,1,10)`).all(iso(start), iso(now)) as Array<{ date: string; count: number }>;
  return {
    total: count(db, 'select count(*) as n from coordination_messages'),
    unsupplied: count(db, 'select count(*) as n from coordination_messages where supplied_at is null'),
    unacknowledged: count(db, 'select count(*) as n from coordination_messages where acknowledged_at is null'),
    pending_to_unfinished: count(db, `select count(*) as n from coordination_messages m join coordination_assignments a
      on a.id=m.recipient_id where m.acknowledged_at is null and a.status!='finished'`),
    daily: Array.from({ length: 14 }, (_, i) => {
      const date = iso(start + i * DAY).slice(0, 10);
      return { date, count: rows.find(r => r.date === date)?.count ?? 0 };
    }),
  };
}

function readWakes(db: Database.Database, now: number, report: ReportInvalid) {
  const json = "case when json_valid(value) then value else '{}' end";
  const invalid = count(db, `select count(*) as n from meta where
    (key like 'peer-wake-attempt:%' or key like 'peer-wake-followup:%' or key like 'assignment-continuation:%')
    and (coalesce(json_valid(value),0)=0 or json_type(${json})!='object')`);
  if (invalid) report('wakes', invalid);
  const rows = validRows(db.prepare(`select json_extract(${json},'$.sessionId') as session_id,json_extract(${json},'$.timestamp') as timestamp,
      json_extract(${json},'$.status') as status,json_extract(${json},'$.block.code') as block_code,count(*) as message_count
    from meta where (key like 'peer-wake-attempt:%' or key like 'peer-wake-followup:%')
      and json_extract(${json},'$.timestamp')>=? and json_extract(${json},'$.timestamp')<=?
    group by 1,2,3,4 order by timestamp desc,session_id`).all(iso(now - 14 * DAY), iso(now)) as Array<{ session_id: string; timestamp: string; status: string; block_code: string | null; message_count: number }>, row => nonempty(row.session_id) && timestamp(row.timestamp)
      && ['submitting', 'submitted', 'failed', 'deferred'].includes(row.status) && nullableText(row.block_code) && integer(row.message_count), report, 'wakes');
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const continuation = validRows(db.prepare(`select json_extract(${json},'$.recovery.status') as status,count(*) as count from meta
    where key like 'assignment-continuation:%' and json_extract(${json},'$.recovery.status') is not null group by 1`).all() as Array<{ status: string; count: number }>, row => ['scheduled', 'submitting', 'submitted', 'blocked', 'stalled'].includes(row.status) && integer(row.count), report, 'continuations');
  return { window_days: 14, counts_by_status: counts, failed: counts.failed ?? 0,
    blocked: rows.filter(r => r.block_code !== null || r.status === 'deferred').length,
    continuation_counts_by_status: Object.fromEntries(continuation.map(r => [r.status, r.count])), recent: rows.slice(0, 100) };
}

function readGrants(db: Database.Database, now: number, report: ReportInvalid) {
  const json = "case when json_valid(g.definition_json) then g.definition_json else '{}' end";
  // Scope, provenance, launch prompts and use details are deliberately not selected.
  const items = db.prepare(`select g.id,
    case when g.status='active' and json_extract(${json},'$.expiry.kind')='assignment_finished'
      and (a.id is null or a.status='finished') then 'expired' else g.status end as status,
    g.created_at,json_extract(${json},'$.grantee.kind') as grantee_kind,
    json_extract(${json},'$.grantee.id') as grantee_id,json_extract(${json},'$.actions') as actions,
    json_extract(${json},'$.projectSlugs') as projects,max(u.timestamp) as last_used_at,count(u.id) as use_count
    from agent_grants g left join coordination_assignments a
      on a.id=coalesce(json_extract(${json},'$.expiry.assignmentId'),g.created_by_assignment_id)
    left join agent_grant_uses u on u.grant_id=g.id group by g.id order by g.created_at desc,g.id`).all() as Array<{ id: string; status: string; created_at: string; grantee_kind: string; grantee_id: string;
      actions: string; projects: string; last_used_at: string | null; use_count: number }>;
  const parsed = items.flatMap(row => {
    try {
      const actions: unknown = JSON.parse(row.actions), projects: unknown = JSON.parse(row.projects);
      if (!nonempty(row.id) || !['pending', 'active', 'denied', 'expired', 'revoked'].includes(row.status) || !timestamp(row.created_at)
        || !nonempty(row.grantee_kind) || !nonempty(row.grantee_id) || !integer(row.use_count)
        || !(row.last_used_at === null || timestamp(row.last_used_at))
        || !Array.isArray(actions) || !actions.every(nonempty) || !Array.isArray(projects) || !projects.every(nonempty)) return [];
      return [{ ...row, actions: actions as string[], projects: projects as string[] }];
    } catch { return []; }
  });
  if (parsed.length !== items.length) report('grants', items.length - parsed.length);
  const countByStatus: Record<string, number> = {};
  for (const row of parsed) countByStatus[row.status] = (countByStatus[row.status] ?? 0) + 1;
  return { active_count: countByStatus.active ?? 0,
    in_use_count: parsed.filter(r => r.status === 'active' && r.last_used_at !== null
      && r.last_used_at >= iso(now - 14 * DAY) && r.last_used_at <= iso(now)).length,
    uses_14d: count(db, 'select count(*) as n from agent_grant_uses where timestamp>=? and timestamp<=?', iso(now - 14 * DAY), iso(now)),
    count_by_status: countByStatus, items: parsed };
}

interface WikiPage {
  repository: string; title: string; revision: number; author: string | null; updated_at: string;
  source_checkout: string | null; source_branch: string | null; source_commit: string | null;
}
function readWiki(db: Database.Database, options: SummaryOptions, report: ReportInvalid) {
  const git = options.git ?? ((repository, args) => execFileSync('git', ['--git-dir', repository, ...args],
    { encoding: 'utf8', timeout: 1500, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  const rows = validRows(db.prepare(`select p.repository,p.title,p.current_revision as revision,r.id as source_revision,r.author,p.updated_at,
      r.checkout as source_checkout,r.branch as source_branch,r.head_commit as source_commit
    from wiki_pages p left join wiki_revisions r on r.id=p.current_revision order by p.repository,p.title_key`).all() as Array<WikiPage & { source_revision: number | null }>, row => row.source_revision === row.revision && nonempty(row.repository) && text(row.title) && integer(row.revision, 1)
      && nullableText(row.author) && timestamp(row.updated_at) && nullableText(row.source_checkout)
      && nullableText(row.source_branch) && nullableText(row.source_commit), report, 'wiki_pages').map(({ source_revision: _sourceRevision, ...row }) => row);
  const readCounts = db.prepare(`select x.repository,count(*) as other_author_reads,count(distinct x.actor) as other_reader_assignments
    from wiki_access x join wiki_revisions r on r.id=x.revision and r.repository=x.repository
    where x.action='read' and x.result_count>0 and x.actor!=r.author and (x.actor like 'codex:%' or x.actor like 'claude:%')
    group by x.repository`).all() as Array<{ repository: string; other_author_reads: number; other_reader_assignments: number }>;
  const contributions = db.prepare(`select r.repository,count(*) as external_contributions from wiki_revisions r
    join (select repository,title_key,min(id) as first_id from wiki_revisions group by repository,title_key) f
      on f.repository=r.repository and f.title_key=r.title_key join wiki_revisions first on first.id=f.first_id
    where r.author!=first.author and (r.author like 'codex:%' or r.author like 'claude:%') group by r.repository`).all() as Array<{ repository: string; external_contributions: number }>;
  const repos = validRows(db.prepare(`select p.repository,count(*) as pages,
    (select count(*) from wiki_revisions r where r.repository=p.repository) as revisions
    from wiki_pages p group by p.repository order by p.repository`).all() as Array<{ repository: string; pages: number; revisions: number }>, row => nonempty(row.repository) && integer(row.pages) && integer(row.revisions), report, 'wiki_repositories');
  const repositories = repos.map(r => ({ ...r,
    other_author_reads: readCounts.find(c => c.repository === r.repository)?.other_author_reads ?? 0,
    other_reader_assignments: readCounts.find(c => c.repository === r.repository)?.other_reader_assignments ?? 0,
    external_contributions: contributions.find(c => c.repository === r.repository)?.external_contributions ?? 0 }));
  const heads = new Map<string, string | null>();
  const distances = new Map<string, { commits_behind: number | null; source_status: string }>();
  const pages = rows.map(row => {
    if (!heads.has(row.repository)) {
      try { heads.set(row.repository, git(row.repository, ['rev-parse', '--verify', 'HEAD'])); }
      catch { heads.set(row.repository, null); }
    }
    const head = heads.get(row.repository) ?? null;
    const key = `${row.repository}:${row.source_commit}`;
    if (!distances.has(key)) {
      let distance: { commits_behind: number | null; source_status: string };
      if (!row.source_commit) distance = { commits_behind: null, source_status: 'missing_source' };
      else if (!head) distance = { commits_behind: null, source_status: 'unavailable' };
      else {
        try {
          const numbers = git(row.repository, ['rev-list', '--left-right', '--count', '--end-of-options', `${row.source_commit}...${head}`]).split(/\s+/).map(Number);
          if (numbers.length !== 2 || numbers.some(n => !Number.isInteger(n) || n < 0)) throw new Error('Invalid Git distance.');
          distance = numbers[0]! > 0 ? { commits_behind: null, source_status: 'diverged' }
            : { commits_behind: numbers[1]!, source_status: numbers[1]! > 0 ? 'behind' : 'current' };
        } catch { distance = { commits_behind: null, source_status: 'unavailable' }; }
      }
      distances.set(key, distance);
    }
    const distance = distances.get(key)!;
    return { ...row, head_commit: head, ...distance, stale: distance.commits_behind === null ? null : distance.commits_behind >= 20 };
  });
  const totals = {
    pages: rows.length, revisions: count(db, 'select count(*) as n from wiki_revisions'),
    accesses: count(db, 'select count(*) as n from wiki_access'),
    other_author_reads: readCounts.reduce((n, r) => n + r.other_author_reads, 0),
    other_reader_assignments: count(db, `select count(distinct x.actor) as n from wiki_access x join wiki_revisions r
      on r.id=x.revision and r.repository=x.repository where x.action='read' and x.result_count>0 and x.actor!=r.author
      and (x.actor like 'codex:%' or x.actor like 'claude:%')`),
    external_contributions: contributions.reduce((n, r) => n + r.external_contributions, 0),
    reads_without_revision: count(db, "select count(*) as n from wiki_access where action='read' and result_count>0 and revision is null"),
  };
  const misses = validRows(db.prepare(`select min(id) as id,repository,query,count(*) as count,max(created_at) as last_at from wiki_access
    where action='search' and result_count=0 and query is not null group by repository,query order by last_at desc,repository,query`).all() as Array<{ id: number; repository: string; query: string; count: number; last_at: string }>, row => integer(row.id, 1) && nonempty(row.repository) && text(row.query) && integer(row.count, 1) && timestamp(row.last_at), report, 'wiki_searches');
  return { totals, repositories, no_result_searches: misses, pages,
    stale_after_commits: 20,
    adoption: { reassess_at: '2026-10-15', targets: { other_author_reads: 5, other_reader_assignments: 3, external_contributions: 1 },
      observed: { other_author_reads: totals.other_author_reads, other_reader_assignments: totals.other_reader_assignments,
        external_contributions: totals.external_contributions },
      usefulness: 'requires_manual_review', corrections: 'requires_manual_review', accuracy: 'requires_manual_sample' } };
}

/** No application services are instantiated: constructors migrate or write live state. */
export function engineeringSummary(options: SummaryOptions) {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Invalid summary time.');
  const issues: Issue[] = [];
  const sources: Record<'console' | 'wiki' | 'projects' | 'activity', Source> = {
    console: { path: '[database path omitted]', status: 'ok', observed_at: iso(now), issues: [] },
    wiki: { path: '[database path omitted]', status: 'ok', observed_at: iso(now), issues: [] },
    activity: { path: '[database path omitted]', status: 'ok', observed_at: iso(now), issues: [] },
    projects: { path: '[config path omitted]', status: 'ok', observed_at: iso(now), issues: [] },
  };
  const failed = (source: keyof typeof sources, stage: string, error: unknown) => {
    const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'READ_FAILED';
    // Do not echo driver errors: malformed config/SQL can carry private values.
    const issue = { source, code: `${stage}:${READ_ERROR_CODES.has(rawCode) ? rawCode : 'READ_FAILED'}`,
      message: rawCode === 'INVALID_ITEM' ? `${Number((error as { count: number }).count)} malformed ${stage} records were omitted; valid records remain visible${source === 'console' ? ' and ownership evidence is incomplete' : ''}.`
        : stage === 'ownership' ? 'A verified live provider process has no readable checkout; ownership evidence is incomplete.'
        : `${stage} could not be read. Check the source path, permissions and schema; this section is unavailable.` };
    issues.push(issue); sources[source].issues.push(issue);
  };
  const report = (source: keyof typeof sources): ReportInvalid => (stage, omitted) => failed(source, stage, { code: 'INVALID_ITEM', count: omitted });
  let configuredProjects: string[] = [];
  try { configuredProjects = readConfiguredProjects(options.config ?? process.env.AGENT_CONSOLE_CONFIG ?? '~/.config/agent-console/config.json'); }
  catch (error) { failed('projects', 'projects', error); sources.projects.status = 'error'; }
  let activity: ReturnType<typeof readYesterdayActivity> | null = null;
  let agents: ReturnType<typeof readAssignments> | null = null;
  let messages: ReturnType<typeof readMessages> | null = null;
  let wakes: ReturnType<typeof readWakes> | null = null;
  let grants: ReturnType<typeof readGrants> | null = null;
  let wiki: ReturnType<typeof readWiki> | null = null;
  for (const source of ['console', 'wiki'] as const) {
    let db: Database.Database | undefined;
    let successes = 0;
    try {
      db = new Database(source === 'console' ? options.database : options.wikiDatabase, { readonly: true, fileMustExist: true, timeout: 2000 });
      db.pragma('query_only = ON');
      db.exec('BEGIN');
      if (source === 'console') {
        for (const stage of ['assignments', 'messages', 'wakes', 'grants']) {
          try {
            if (stage === 'assignments') {
              agents = readAssignments(db, options, now, report('console'));
              if (agents.assignments.some(a => a.live_process && !a.process_checkout && !a.process_unattributed)
                || agents.sessions.some(s => s.live && !s.checkout && !s.unattributed)) {
                failed(source, 'ownership', { code: 'PROCESS_CHECKOUT_UNAVAILABLE' });
              }
            }
            if (stage === 'messages') messages = readMessages(db, now);
            if (stage === 'wakes') wakes = readWakes(db, now, report('console'));
            if (stage === 'grants') grants = readGrants(db, now, report('console'));
            successes++;
          } catch (error) { failed(source, stage, error); }
        }
        try { activity = readYesterdayActivity(db, now, report('activity')); }
        catch (error) { failed('activity', 'activity', error); sources.activity.status = 'error'; }
      } else { wiki = readWiki(db, options, report('wiki')); successes++; }
    } catch (error) {
      failed(source, source === 'console' ? 'open' : 'wiki', error);
      if (source === 'console') { failed('activity', 'open', error); sources.activity.status = 'error'; }
    }
    finally {
      if (db) { try { db.exec('ROLLBACK'); } finally { db.close(); } }
      sources[source].status = sources[source].issues.length ? (successes ? 'partial' : 'error') : 'ok';
    }
  }
  if (activity && sources.activity.issues.length) sources.activity.status = 'partial';
  const status: Status = [sources.console, sources.wiki, sources.activity].every(s => s.status === 'error') ? 'error' : issues.length ? 'partial' : 'ok';
  const result = sanitizeExport({ schema_version: 1, generated_at: iso(now), status, sources, issues, configured_projects: configuredProjects,
    agents: { counts: agents?.counts ?? null, assignments: agents?.assignments ?? null, sessions: agents?.sessions ?? null, unattributed_sessions: agents?.unattributed_sessions ?? null,
      messages, wakes, grants, activity_yesterday: activity }, wiki });
  // Analyze complete values and typed identifiers before applying narrower display limits.
  const bounded = (value: string, limit: number) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
  for (const assignment of result.agents.assignments ?? []) {
    assignment.description = bounded(assignment.description, 1000);
    assignment.activity_summary = bounded(assignment.activity_summary, 2000);
    for (const scope of assignment.scopes) scope.summary = bounded(scope.summary, 2000);
  }
  for (const session of result.agents.unattributed_sessions ?? []) session.description = bounded(session.description, 1000);
  for (const event of result.agents.activity_yesterday?.items ?? []) {
    event.description = bounded(event.description, 1000); event.summary = bounded(event.summary, 2000);
  }
  for (const query of result.wiki?.no_result_searches ?? []) query.query = bounded(query.query, 160);
  return result;
}
