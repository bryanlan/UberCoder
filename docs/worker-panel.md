# Worker panel

The collapsible right panel shows loaded, visible Console workers across configured projects.
It uses the same project and conversation labels as the left sidebar; the title is shortened
to 30 characters, with the full label on hover and a link to the exact conversation.
Working/idle state comes from bound sessions, independently of an assignment's active label.
Suspended, unbound and internal `codex exec` conversations are excluded. Idle cards retain their
last summary; they never cause model calls. Native child agents without their own Console
binding are not separate cards.

The three lines describe the overall task, latest observed action and recent peer coordination.
The default summary interval is two minutes; the selector accepts one through five minutes
and is stored in this browser. Live roster reads run every five seconds while the panel is visible.
Opening the panel requests the first eligible summary. Closing it or hiding the browser stops
new requests; a batch already started can finish. No background scheduler job is installed.

The server shares one in-flight batch across tabs, with the requesting browser's selected
interval measured from request admission and a one-second allowance for timer/network jitter.
A batch contains at most 16 changed working agents. Workers never summarized or summarized
longest ago go first. Unchanged successful evidence is skipped; failed attempts may retry at a later eligible
refresh. Summaries are held
in memory (at most 128 entries), so restarting the backend regenerates them on demand. The
persisted audit retains the latest invocation time to prevent an immediate same-day retry.

Frequent roster reads query loaded sessions and individual conversation metadata, never the
full conversation index. Model input uses at most 128 KiB of each worker's existing normalized
live event log, up to five short activity lines and four peer messages. Per-worker queries inspect
only the newest 5,000 coordination events/messages, then filter for that worker; one busy
worker cannot consume a shared 50-row result window. Peer messages include timestamps: acknowledged
messages older than an hour are omitted, while older unacknowledged messages are labelled pending.
Unknown latest actions and unobserved
coordination must stay explicit. Receipt acknowledgement does not establish a reply, agreement,
approval or successful work. A changed task or failed replacement marks an existing summary
out of date. The displayed summary timestamp is its generation time, not proof of current progress.

## Model runtime and accounting

The canonical `agent-consult --application` runtime owns native CLI execution, subscription
authentication, model/effort validation, data-only isolation, deadlines and cancellation.
The panel requests exactly `gpt-6-luna`, low effort, account OAuth and `data_only` access.
The summarizer gets supplied evidence only; it cannot inspect repos, invoke tools, communicate
with agents or change runtime state. It does not create a Console binding and cannot trigger
itself. The parent validates exact worker IDs and three single-line strings of at most 180
characters. Native output also receives a closed JSON schema. No alternate provider or model
is selected after a failure.

Install the shared runtime from its owning checkout as documented in
`/home/bryan/code/ai-skills/codex/agent-consult/references/runtime.md`.
`workerSummaries.runtimeCommand` defaults to `~/.local/bin/agent-consult`; set it explicitly for
another installation path. `workerSummaries.enabled=false` disables summaries while preserving
the roster. These are config-file settings. No OpenAI API key is used.

Each attempted model call writes a start and final record under
`runtimeDir/workers/usage-YYYY-MM-DD.jsonl`. Records share one request ID, so usage rollups count
each request once. They contain timestamps, model/effort, worker IDs, duration, outcome and
native token usage; no prompts, summaries or message bodies. Directory permissions are 0700
and files are 0600. A missing/ambiguous usage measurement remains unknown, including interrupted
start records. Uncached input, cached reads, cache writes and output are disjoint categories;
their sum is total tokens. Failed calls with known usage remain counted. The footer uses UTC
invocation days and identifies missing or pending measurements. Counts are subscription usage,
not dollar billing. Existing peer-wake accounting is unchanged.

The audit is capped at 8 MiB per day. Corrupt, symlinked, unwritable or capped audit storage
pauses new model calls until storage is repaired and the backend is restarted; status and existing summaries remain available. Raw model requests and
runtime artifacts live in an owned private run directory and are removed after the call. An
interrupted run can leave private files; UUID run directories with this component's ownership marker older than 24 hours are pruned
before the next generation, while recent runs and unrelated paths are left alone. The token
audit remains append-only. Shutdown requests cancellation through the shared runtime.

Both API routes require authentication. `POST /api/workers/refresh` also requires CSRF and a
validated interval; `GET /api/workers` never starts model work. HTTP responses do not wait for
the provider. A failed generation preserves the previous summary and visibly reports its age/error.

## Verification

Use `npm test`, `NODE_ENV=test npm run test -w @agent-console/web`, `npm run typecheck` and
`npm run build`. Focused backend cases are `workers`, `worker-evidence` and `worker-routes`;
web cases are `WorkerPanel`; isolated browser coverage is `worker-panel.spec.ts`.
These tests use synthetic evidence and disposable SQLite. A live model check must use synthetic
workers through the shared data-only runtime, never real provider input or a live database writer.
