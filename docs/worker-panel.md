# Worker panel

The collapsible right panel shows loaded, visible Console workers across configured projects.
It uses the same project and conversation labels as the left sidebar; the title is shortened
to 30 characters, with the full label on hover and a link to the exact conversation.
Working/idle state comes from bound sessions, independently of an assignment's active label.
Suspended, unbound and internal `codex exec` conversations are excluded. Idle cards retain their
last summary; they never cause model calls. Native child agents without their own Console
binding are not separate cards.

On desktop the panel defaults to960px (three times its original320px), fits beside navigation
while reserving320px for the conversation, and has a draggable left edge. Arrow keys resize
the focused edge; double-click resets to960px. The chosen320–1600px width is remembered in
this browser. Smaller screens retain the320px drawer within90% of the viewport.

The three overview rows describe the overall task, latest observed action and recent peer coordination.
They show complete short sentences and wrap to use the panel width, without ellipses. Clicking
a card fills the panel's content area with that worker's full stored text, full conversation
title and assigned work in larger, wrapped type. Click the expanded card again or press Escape
to return to all workers. Open conversation remains a separate link. Expanding does not collect
evidence or call a model. Saved summaries remain readable while tracking is Off.
The default summary interval is two minutes; the selector accepts one through five minutes
and is stored in this browser. Live roster reads run every five seconds while the panel is visible.
Opening the panel requests the first eligible summary. Closing it or hiding the browser stops
new requests; a batch already started can finish. No background scheduler job is installed.

The On/Off switch at the top is server-owned and persists in the Console config. Off applies
across all tabs and survives browser/backend restarts. It stops roster/evidence collection for
this panel, blocks summary requests, and requests cancellation of an in-flight model batch.
The latest worker cards and summaries remain visible as a saved snapshot, including its timestamp.
Their labels read Was working/Was idle while paused; they do not claim the workers are still in that state.
The snapshot survives browser reloads and backend restarts. Turning On resumes current roster reads.
The cheap state/usage endpoint remains available so other tabs see the setting. The switch does
not stop agents or their ordinary coordination. Tokens already consumed by a cancelled call
remain counted when the runtime reports them; missing cancellation usage stays explicitly unknown.
Cancellation before process launch records known zero usage.
Switching On allows the next eligible refresh; it cannot revive a cancelled batch.
Tracking also pauses automatically after10minutes without an accepted human message anywhere
in Console, and resumes on the next accepted message when the manual switch is enabled.
Agent output, peer wake notices, polling and draft typing do not renew the window. Explicit On
starts a fresh10-minute watch window; manual Off stays Off through further messages. The last
window timestamp persists in existing Console metadata, so restart does not renew it. Only the
timestamp is stored, never the message body. An in-flight summary is cancelled at the deadline;
saved information remains visible. The panel distinguishes automatic inactivity from manual Off.

The server shares one in-flight batch across tabs, with the requesting browser's selected
interval measured from request admission and a one-second allowance for timer/network jitter.
A batch contains at most 16 changed working agents. Workers never summarized or summarized
longest ago go first. Unchanged successful evidence is skipped; failed attempts may retry at a later eligible
refresh. The latest snapshot and summary fingerprints (at most 128 cached summaries) are saved
atomically under `runtimeDir/workers/latest.json`, with 0700 directory/0600 file permissions.
Only displayed worker information and cache metadata are stored; raw evidence and prompts are excluded.
The file is bounded to 2 MiB and retains one latest snapshot. Unchanged snapshots do not rewrite it.
Restarting while Off restores this snapshot without reading agents or starting a model. The
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
itself. The prompt asks for one complete short sentence of at most14words per field. The parent
validates exact worker IDs and three single-line strings of at most90characters ending with
punctuation, matching the closed JSON schema. Word counts and sentence segmentation remain
writing guidance so ordinary abbreviations cannot discard a batch. Existing saved
summaries stay readable; a policy fingerprint refreshes working workers at the next eligible
generation without requiring their evidence to change. No alternate provider or model
is selected after a failure.

Install the shared runtime from its owning checkout as documented in
`/home/bryan/code/ai-skills/codex/agent-consult/references/runtime.md`.
`workerSummaries.runtimeCommand` defaults to `~/.local/bin/agent-consult`; set it explicitly for
another installation path. `workerSummaries.enabled` is also controlled immediately by the panel's
persisted On/Off switch. No OpenAI API key is used.

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

All worker API routes require authentication. `POST /api/workers/refresh` and
`POST /api/workers/tracking` also require CSRF and strictly validated interval/boolean bodies;
`GET /api/workers` never starts model work. HTTP responses do not wait for
the provider. A failed generation preserves the previous summary and visibly reports its age/error.

## Verification

Use `npm test`, `NODE_ENV=test npm run test -w @agent-console/web`, `npm run typecheck` and
`npm run build`. Focused backend cases are `workers`, `worker-evidence` and `worker-routes`;
web cases are `WorkerPanel`; isolated browser coverage is `worker-panel.spec.ts`.
These tests use synthetic evidence and disposable SQLite. A live model check must use synthetic
workers through the shared data-only runtime, never real provider input or a live database writer.
