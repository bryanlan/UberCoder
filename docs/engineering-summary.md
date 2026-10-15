# Read-only engineering summary

Waltium Control consumes Console metadata through a standalone JSON command. Run it
from an assignment worktree against the existing Console databases. It opens both
SQLite files with `readonly: true`, `fileMustExist: true` and `query_only`, and uses
a read transaction per database. It does not construct the application database or
wiki services, apply migrations, contact the server, start providers, or record wiki
access. No backend restart or deployment is required.

```bash
node_modules/.bin/tsx apps/server/src/engineering/summary-cli.ts
# Or after npm run build:
node apps/server/dist/engineering/summary-cli.js
```

The default configuration path is `AGENT_CONSOLE_CONFIG`, or
`~/.config/agent-console/config.json`. Only its `databasePath` is used. Explicit
paths avoid needing a config file:

```bash
node_modules/.bin/tsx apps/server/src/engineering/summary-cli.ts \
  --database /absolute/path/agent-console.sqlite \
  --wiki-database /absolute/path/wiki/agent-wiki.sqlite
```

The wiki defaults to `wiki/agent-wiki.sqlite` beside the main database, matching the
Console storage contract. Missing files are errors; the command never creates
replacement databases. Exit status is 0 for complete database reads, 2 for partial
or unavailable sources, and 1 for invalid arguments or configuration. JSON still
prints on stdout on failure. Error messages are fixed text to prevent private
driver/configuration values appearing in output. Consumers must inspect `status`
and `sources`, even when useful sections are present.

## Version 1 contract

The root contains `schema_version`, `generated_at`, `status`, `sources`, `issues`,
`agents` and `wiki`. Each source has a withheld path marker, observation time,
status and issues. Database locations stay private, including failed or malformed
URL-like inputs.
An unavailable section is `null`. Console sections are independent: a schema
failure reading assignments does not hide working message, grant or wake counts.
When the invocation itself cannot be parsed, `sources` is empty and `agents` and
`wiki` are null.

`agents` contains:

- `counts`, `assignments` and `sessions`: all retained assignment descriptions and
  announced checkout/repository paths, plus current bound-session metadata. The
  scopes include their permitted stored activity `summary` and `updated_at` from
  the latest matching checkout update event (null when no event remains).
  `activity_summary` is the latest scope summary, or empty when none is available.
  Activity text is capped at 2,000 characters and common credentials are redacted.
  Event text is not selected. The states active/waiting require the assignment's
  PID and recorded Linux process
  start to match. Disconnected assignments and stale active rows are idle.
  `started_never_finished` is a subset, not another disjoint state: unfinished,
  started more than 24 hours ago, and with no proven live process or session.
  Every assignment exports `live_process` and its actual `process_checkout`,
  including finished assignments. A finished assignment retains proven process or
  session ownership until that provider exits. Assignment completion alone does
  not release a checkout. A live process with unreadable cwd or failed Git lookup
  makes the Console source partial while retaining available metadata. A readable
  directory outside Git is explicitly unattributed and does not fault the source.
  `process_unattributed` and session `unattributed` distinguish these cases.
  `unattributed_sessions` lists their provider, assignment/session IDs and description,
  counting a bound session and its assignment once. Real process and session paths
  resolve `/proc/<pid>/cwd` to the Git worktree root with read-only Git commands.
  Failed lookups retain live process identity with unknown checkout; a
  stale bound row or unrelated reused PID is insufficient.
- `messages`: retained total, unsupplied, unacknowledged, pending to unfinished
  recipients, and a zero-filled 14 UTC calendar-day series including today so far.
  Unsupplied means never offered to the recipient; unacknowledged includes both
  never offered and offered without acknowledgement. These are metadata counts,
  not proof that a person read a message.
- `wakes`: the last 14 rolling days of retained initial/follow-up peer-wake records,
  grouped by session, timestamp, status and block code so one batched wake does not
  count once per message. `recent` holds at most 100 groups. Blocked includes
  deferred attempts or explicit blocks. Continuation recovery state counts are
  separate and describe current persisted state. Attempt records are last state
  per durable key, not an exhaustive event history.
- `grants`: effective state counts, safe grantee/action/project metadata and use
  counts. Assignment-bound expiry is computed without writing the expired state.
  `in_use_count` means currently active grants with a recorded use in the last 14
  days; it does not assert that a child is currently running. No grant scope,
  provenance, launch input or use-detail payload is selected.

`wiki` contains page/revision/access totals, repository counts, cross-author reads,
no-result search topics, page source provenance, and adoption targets from
[the wiki pilot](agent-wiki.md). Read comparisons join the exact returned revision
to its author. Historical reads without revision remain an explicit unknown.
Reader counts include Codex/Claude assignments, and global distinct reader counts
are deduplicated across repositories. `external_contributions` counts revisions
by an assignment other than the page's original author. These counts identify
reuse and contribution candidates. Useful reads, substantive outside corrections
and sampled accuracy require manual assessment; the command does not claim the
pilot's qualitative targets were met.

Source commits are compared to each repository common directory's current `HEAD`.
`source_status` is current, behind, diverged, missing_source or unavailable. A
divergent or missing commit has a null distance. `stale` means at least 20 commits
behind, a triage heuristic exposed as `stale_after_commits`; it does not prove the
page is wrong. Missing repositories and inaccessible commits stay visible on each
page. The command never checks out a branch, fetches, or modifies Git state.

Queries name their selected columns. Message bodies, provider prompts, auth state,
wiki bodies/revision summaries and arbitrary JSON payloads are excluded.
Descriptions are capped at 1,000 characters, and search topics at 160;
the shared `export_redaction.v1.json` rules redact credentials, database URLs and
database paths and high-entropy credential candidates across exported values.
Structural keys and validated identifier-map keys remain unchanged. Typed metadata
identifiers are collected before scrubbing to preserve commit and session identity. Output
remains internal operational metadata.

## Verification

`NODE_ENV=test npm run test -w @agent-console/server -- engineering-summary` uses
private temporary SQLite files. It verifies credential/body exclusion, zero-filled
daily counts, wake batching, effective grant expiry, PID reuse, exact-revision wiki
reads, real Git distances, missing sources and partial schema failures. It also
compares both database files byte-for-byte before and after the projection.
`npm run typecheck`, `npm test` and `npm run build` cover the integrated worktree.
No real provider or live backend is required.
