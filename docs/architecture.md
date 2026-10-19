# Architecture
## System Overview
Standing grants let agents launch and restart real Console sessions under Bryan's recorded authority.
See [Agent grants](agent-grants.md) for creation, inheritance, the durable launch queue and native context.

`agent-console` is a local, server-first Codex/Claude Agent Console. The backend owns project configuration, provider transcript discovery, hidden tmux session binding, auth, proxying, SQLite state, and event-log normalization. The React PWA is a thin client that renders backend-owned project/conversation/session state; it must not become a raw terminal controller.

First-class runtime surfaces:
- Fastify startup: `apps/server/src/index.ts` calls `buildApp` in `apps/server/src/app.ts`; root `package.json` coordinates the server, web and shared packages.
- Host coordination/MCP/hooks: `scripts/agent-coord.mjs` transports requests to the backend-owned coordination, grants and wiki services; it does not own their durable state.
- Worktree maintenance: `scripts/worktree-sweep.mjs` inventories checkouts and branches and performs guarded cleanup only in apply mode; it reads Console state through a read-only SQLite connection.
- Fastify conversation/timeline API: `apps/server/src/routes/conversations.ts`.
- Fastify conversation search API and index: `apps/server/src/routes/search.ts`,
  `apps/server/src/search/conversation-search.ts`,
  `apps/server/src/indexing/indexing-service.ts`, and the SQLite `conversation_search_fts` table in
  `apps/server/src/db/database.ts`.
- Fastify session input API: `apps/server/src/routes/sessions.ts`.
- Session lifecycle and tmux boundary: `apps/server/src/sessions/session-manager.ts`, `session-runtime.ts`, `timeline-merge.ts`, `session-screen.ts`, `live-output/reader.ts`, `screen-heuristics.ts`, `working-state.ts`, `transcript-watcher.ts`, `tmux-health.ts`, and `tmux-client.ts`.
- Provider transcript adapters, especially `apps/server/src/providers/transcripts/codex.ts` for Codex JSONL display filtering and duplicate handling.
- React app shell and conversation surface: `apps/web/src/App.tsx`, `apps/web/src/features/navigation/`, `apps/web/src/features/realtime/`, `apps/web/src/features/conversation/useConversationData.ts`, and `apps/web/src/components/ConversationPane.tsx`.
- npm scripts: `npm run auth:hash`, `npm run build`, `npm run dev`, `npm run smoke:codex`, `npm run test`, `npm run test:e2e`, `npm run typecheck`, `npm run verify:live-console`.

## Mobile conversation layout

On narrow screens, including touch screens below 1024 CSS pixels in landscape,
the app opens conversations in reading mode with a compact
project/chat header and persistent Chats, Reply and Controls actions. Chats fills
the screen and groups active conversations by project. Its default filter hides
history, manual/pressure/idle suspensions and projects with no remaining chats.
Show all and search provide access to hidden history; New chat includes every
configured project. These are display filters and do not change session state.
Desktop navigation retains its existing Work/Browse filtering and sizing.

Reply and Controls share one optional panel. Reply starts at one line, grows to
at most 112 pixels or 22% of the visible viewport with a 44-pixel minimum, and
scrolls internally for longer drafts. A separate Send button submits; the phone Return key inserts a
newline in ordinary draft mode. An accepted or queued reply closes the composer;
rejection retains it. Closing input and switching chats preserve per-chat drafts.
Controls exposes terminal keys and model settings without focusing a text field;
key-only actions keep a separate unsent chat draft local. Interactive provider
choices retain their parsed screen and offer a direct Open controls action.

The mobile shell follows visualViewport height and offsetTop on resize and scroll
so the keyboard and browser panning cannot cover the footer. The transcript keeps
its own flexible scroll area. Its existing scroll controller follows new output
only at the bottom, preserves a reader's position above the bottom, and loads
earlier history through the server-owned pagination path. Routine terminal
details stay out of the mobile transcript when saved conversation text exists.
Session details, workers and other occasional tools are available under More.

## Search index updates

Search updates use `conversation_search_rows`, an ordinary indexed ownership table mapping
project/provider/conversation identities to FTS rowids. Migration 15 populates it without
replacing FTS rows or changing durable session, auth or coordination records. Every search
insert/delete maintains both tables in one transaction. Identity-based deletes, scope clears
and metadata updates address FTS by rowid; UNINDEXED FTS identity columns must never drive a
whole-table update scan. Refreshes commit and yield between conversations. Search remains
derived state in the existing database; private-copy performance evidence gates activation.
Keep a consistent SQLite backup before migration: older binaries reject schema 15.

FTS searches use one lazy, read-only SQLite worker connection, so cold queries cannot
block the server's coordination and session event loop. The owning connection still
performs all writes. Each connection has a 64 MiB page-cache budget; the read worker
accepts at most 16 outstanding requests with a 10-second deadline and is closed during
server shutdown. No schema migration is needed for these read-path optimizations.

## Clipboard Images

The live composer accepts pasted PNG, JPEG and WebP images, with previews, removal
and retry. Images upload as binary bodies to authenticated, CSRF-protected
`POST /api/sessions/:sessionId/images`; authenticated `GET /api/images/:imageId`
serves the original bytes with private, no-store caching. Uploads are limited to
10 MiB and 20 million pixels per image, and four images per submitted prompt.
The server decodes pixels before storing a file and rejects corrupt, animated
or mismatched image formats. Files and metadata live in `images/` beside the
configured Console database, outside the session runtime cleanup tree.

Enter submissions carry image IDs through the existing session keys route. The
backend resolves those IDs within the selected project and provider, then appends
local file references and an instruction to inspect them with Codex `view_image`
or Claude `Read`. This uses the existing tmux writer and provider credentials;
it does not use the host desktop clipboard or create another provider process.
Text Bypass appends the image references to the already-typed caption rather than
typing the caption twice. Pending Codex first-turn launches receive the complete
caption and image references. Upload errors and rejected sends retain the draft.
Screen parsing finds the active composer across the captured pane, including
long wrapped image references, while retaining output and picker exclusion checks.

The generated image envelope remains in event logs and provider history for
pending adoption, recovery and duplicate matching. At the public timeline,
recorded-input and user-input event boundaries, it becomes caption text plus
typed image metadata. The web renders authenticated thumbnails, and search
indexes the caption rather than transport instructions or local image paths.
Image files remain available after session cleanup and server restart. Unsent
composer attachments persist across navigation in the current browser tab;
they are not persisted across a browser reload.
The Claude transcript adapter removes Claude's native paste wrappers before
hashing user turns so a pasted prompt can be adopted and matched to live input.

## Main Components

- `apps/server/` - Fastify backend, project/config/auth routes, provider adapters, SQLite state,
  indexing, conversation search, tmux session management, live-output normalization, restart
  handling, and localhost proxying.
- `apps/web/` - React/Vite PWA for project navigation, conversation timelines, live session
  display, settings, and auth flows.
- `packages/shared/` - shared TypeScript contracts for sessions, conversations, projects, and
  provider data.
- `config/` - example runtime configuration for projects, providers, proxy allowlists, and auth.
- `scripts/` - operator/development helpers such as auth hash generation and host smoke checks.
- `docs/` - repository navigation, architecture, and test guidance.
- `test-results/` - Playwright failure artifacts; current contents can be stale and are regenerated by e2e runs.

Representative source anchors include `README.md`, `AGENTS.md`, `package.json`, `requirements.txt`, `package-lock.json`, `playwright.config.ts`, `apps/server/src/routes/auth.ts`, `apps/server/src/routes/conversations.ts`, `apps/server/src/routes/events.ts`.

## Data Flow
The server is authoritative for project configuration, conversation indexes, bound sessions,
provider transcript loading, proxy access, and auth. The web app requests server APIs and renders
the resulting conversation/session model; it should not become a raw terminal controller.

Conversation timelines merge provider transcripts with live session event logs at the server
boundary. `apps/server/src/routes/conversations.ts` owns pagination through `limit` and `before`,
supports metadata-only polling with `limit=0`, and keeps bound live-session metadata available
without forcing the web app to carry the full history payload on every refresh.
`apps/server/src/lib/provider-conversation-cache.ts` re-parses small changing transcripts even while
a bound session is working so provider-written mid-turn messages appear promptly. Transcripts at or
above `LARGE_TRANSCRIPT_STALE_THRESHOLD_BYTES` in `packages/shared/src/index.ts` may serve a stale
parse during the active turn to avoid expensive poll-time reparsing; the conversation route returns
`transcriptSizeBytes`, and `ConversationPane.tsx` shows a dismissible large-chat warning for that
case.
Concurrent requests for the same transcript fingerprint share one parse. File identity,
size and modification time distinguish reads. Completed parses warm stale reads while
newer work runs; parse generations prevent an older result replacing a newer completed
result in the cache.
`apps/server/src/sessions/timeline-merge.ts` owns the duplicate-suppression contract between
durable transcript messages and event-log live messages: it compares role, timestamp buckets, exact
short-window matches, and longer containment matches so the same assistant output does not reappear
after the provider transcript catches up. `apps/server/src/sessions/transcript-watcher.ts` detects
provider transcript file updates and should be considered part of the same timeline freshness
contract.

Live-output echo detection restores the last recorded user prompt through a streamed asynchronous
event-log read once per session. The session runtime caches that derived value, updates it after
each durable user-input append, and protects newer input from an older in-flight restoration.
Output waiting on restoration remains in arrival order, retains its arrival-time activity
decision, and yields between batches. Stopping a watcher invalidates its delayed batches,
including across suspension and resume.
Output updates must not synchronously load or scan the whole event history.

Live timeline reads cache per-session normalized events and use a set for assistant-line
duplicate detection. Append reads verify the file identity and previous EOF bytes;
partial records, truncation and replacement trigger reconstruction. Tail boundaries and
message offsets use UTF-8 byte positions. Parsing and reconstruction yield between
bounded batches. Completed live-read entries have a combined 64 MiB estimated-text
budget and a 64-entry limit, and concurrent reads of the same fingerprint share work.

Raw tmux screen captures are parsed by `apps/server/src/sessions/session-screen.ts` for session
state and exposed through `/api/sessions/:sessionId/screen`. Timeline responses from
`apps/server/src/routes/conversations.ts` intentionally return messages and bound-session metadata,
not raw screen content; `apps/web/src/features/conversation/useConversationData.ts` polls the
screen route separately for the live terminal/status panel.
That panel shows current output while the backend marks the bound session as working,
and keeps interactive menus visible while idle only when the screen has no active composer.
Quoted menu controls at a ready composer stay in the normal transcript.
Idle terminal scrollback and permission
footers do not count as active work; completed replies remain in the normal transcript.
Codex's unboxed composer is bounded by its left-edge prompt, indented continuation rows and
indented native model footer. Paragraph breaks, quoted prompts and bullets inside that region
remain input. Earlier prompts followed by assistant output remain screen content. Recognizing the
whole draft lets the normal submission path confirm a multiline paste and reuse an already-visible
draft without pasting it again. Native Codex input retains its rendered row boundaries;
the retained-draft comparison allows whitespace at those boundaries because wrapping can
split a word. Characters and spaces within each row still have to match.
The screen parser preserves the full Claude OAuth URL from terminal hyperlink metadata when the
login screen wraps its visible label. This correction applies only to the interactive screen.
User-visible incremental conversation output comes through `apps/server/src/sessions/live-output/reader.ts`
and the event log attached to the bound session. Codex transcript parsing prefers response-backed display messages over
near-duplicate event messages, removes internal memory-citation blocks before display comparison,
and hides environment, `AGENTS.md`, and instruction wrapper records from the visible transcript
while keeping the full parsed message set available for indexing. Codex commentary-phase assistant
records are treated as pending progress, and only the latest pending commentary tail is displayed
so an in-flight answer can show progress without flooding the durable transcript. Codex pending
conversations attempt transcript linking during the active first turn. Linking atomically writes
the native conversation summary and transcript path to the index alongside the binding and pending
reference, so subsequent reads and transcript watchers share the same identity without waiting for
full discovery. Until a matching transcript exists, the chat shows submitted input and session
status. Polling continues while the latest message is pending, even if terminal activity reports
completion within the usual timestamp grace window.

Pending adoption matches the first/last user prompt hashes and timestamps from the
provider-filtered visible messages. Injected instructions, midnight environment updates, and
other hidden records remain available in the full parse but cannot displace the submitted
prompts in matching metadata. Parser version changes invalidate persisted summaries so an
existing pending URL can recover its completed transcript without relaunching the agent.

The console intentionally keeps four text channels separate. `/screen` exposes parsed tmux screen
state for interactive pickers and status, `/raw-output` exposes debug tails for inspection only,
event-log readers preserve submitted user input and session status, and provider transcript adapters
produce conversation history. Codex raw-output events never become assistant messages, including
before its first transcript is linked; the remaining terminal-prose normalizer serves Claude.
Claude's boxed bug-report notifications are removed before terminal chrome is stripped, keeping
their header, body and review/send/dismiss controls out of conversation messages and output activity.
The original notification remains available through the terminal screen and debug output.
The web conversation pane may mirror local text-bypass typing
optimistically, but server-derived terminal input or ordinary screen scrollback must not become a
pending user transcript row.

Claude `api-request-blob` records are saved copies of model context, not new conversation
turns. The adapter excludes them from parsed messages, active-branch selection and opening
prompt matching. They cannot supply prompt hashes, excerpts or conversation activity dates.
The parser version invalidates persisted transcript summaries and search entries after this
filter changes; provider transcript files remain unchanged.

Claude compaction summaries are provider bookkeeping, not submitted prompts. The Claude
history parser follows `logicalParentUuid` at `compact_boundary` records to retain earlier
messages on the selected branch. It displays `isCompactSummary` records as durable
`compaction` status markers with the text `[Claude auto summarized]` for an `auto` trigger
and `[Claude summarized]` otherwise, retaining the original
summary only in internal record metadata. These markers do not replace real user prompt
hashes, advance conversation activity, enter conversation search, or start a working turn.
The ready indicator continues to use the last confirmed response and its age.

When debugging duplicated bubbles, missing assistant text, terminal repaint noise, or stale live
output, route the investigation by text source instead of by visual symptom. Durable history starts
in the provider transcript parser (`apps/server/src/providers/transcripts/codex.ts` or the Claude
adapter), live pending output starts in `apps/server/src/sessions/live-output/`, duplicate
suppression belongs in `apps/server/src/sessions/timeline-merge.ts`, raw screen inspection belongs
in `apps/server/src/sessions/session-screen.ts`, and presentation rules belong in
`apps/web/src/features/conversation/transcript-turns.tsx` and
`apps/web/src/components/ConversationPane.tsx`. Repeated bubble corruption is usually a boundary
failure between these sources; do not fix it by teaching the renderer to guess which server text is
real conversation content.

Conversation search is a server-owned API at `/api/search/conversations`. The search service builds
FTS rows from sanitized user/assistant prose, excludes hidden system-invocation conversations, and
deduplicates chunks down to one best result per conversation after applying recency-bucket and score
ordering. Persisted search rows live in SQLite `conversation_search_fts`; live pending sessions are
searched from the recent event-log tail so new conversations can appear before a provider transcript
exists. For Codex that tail contributes submitted user input only, never terminal-derived assistant
text. Transcript-backed live sessions intentionally ignore assistant `live-output` fragments for
search, because the durable transcript is the source for those conversations.

`IndexingService` owns search-index refresh and repair. Normal indexing replaces FTS rows from
provider conversations, while `backfillMissingSearchIndexRows()` fills missing FTS rows from the
cached conversation index on startup or when cached projects become active without re-listing the
provider tree. The existing metadata store records the transcript parser version for each
project/provider search index after its refresh completes. A missing or outdated version
rebuilds search content even when transcript sizes and modification times have not changed;
startup backfill also checks that version. Interrupted refreshes do not advance it.
Search updates commit one conversation at a time and pause between writes so a
full refresh does not hold the live database writer lock for an entire project. A failed individual
transcript load should not break the conversation tree.

The top-left refresh action explicitly requests recent Codex auto-tracking. The server first
re-indexes every configured active project, then may resume unbound Codex history with real
provider activity during the preceding eight hours into hidden tmux sessions. Claude discovery is
intentionally different: an unbound Claude transcript remains outside Agent Console until the user
explicitly confirms that its original terminal session has stopped. This prevents refresh from
starting a second Claude process for the same provider conversation. Settings-driven tree refreshes
do not request auto-tracking. `autoTrackedAt` is persisted as display provenance: it makes a newly
discovered Codex binding green without changing genuine conversation activity or project-recency
ordering. The provider launch path resumes the original conversation id; it does not fork a new
provider id.

The web conversation data hook keeps metadata and paged messages on separate query keys. Active
bound sessions poll the message timeline; after a session completes, the message query keeps polling
briefly when the latest durable message is still the user's prompt or when session output/completion
timestamps are newer than the latest transcript message. This closes the gap where a hidden tmux
session has finished but the provider transcript has not yet exposed the assistant's final answer.
Binding a session to a provider-readable conversation does not require that conversation to already
have a search-index row. The conversations route can load the provider transcript directly for a
known conversation id, then the indexing service backfills search rows later without blocking the
binding flow.

Session text entry has two paths. Normal `/input` submissions send the text to the bound tmux
session, but the first user prompt for a pending Codex conversation restarts the placeholder
session with that prompt as the provider's initial command and records the input hash/preview on
the pending conversation. `/keys` handles literal bridge input; when text plus Enter arrives for a
first-turn pending Codex session, `sessions.ts` asks `SessionManager.allowsLiteralSelectionKeystroke`
whether the current screen is an interactive selection UI. Selection tokens stay on the live tmux
bridge, while non-selection prompt text restarts the pending Codex session instead of typing into a
stuck composer.

Complete chat drafts carry a UUID `submissionId` on `/keys`. The backend journals
each request in SQLite metadata and delivers messages in order under the existing
session command lock. An active native composer accepts human messages even while
the provider is working: normal text plus Enter lets Codex steer the running turn
and Claude deliver the message after its running tool calls. Console does not wait
for the whole turn to finish or interrupt it. Startup, approvals, menus and unrelated
native drafts defer delivery. Automatic input still requires an idle provider.
The browser shows the queued message separately from the
transcript and clears the submitted local draft after the server accepts the request.
Acceptance of a queued Text Bypass message returns the composer to local drafting,
so later typing cannot append to the queued native text. Text Bypass stays disabled
while a queued message owns the native input, including after a browser refresh.
Refreshing or navigating does not discard it. Retrying an uncertain HTTP request
uses the same submission ID within the open browser and returns the existing receipt.

Before typing and before Enter, delivery verifies the current binding, tmux owner,
pane PID and native composer. A fresh composer capture follows the final ownership
reads, with synchronous input-revision and queue-state checks before Enter.
It reuses matching text; after a paste, it waits for
the full message or its newly rendered native paste placeholder without pasting
again. A journal transition precedes each transport action. Collapsed Text Bypass
drafts are recognized using their persisted text and pane PID. Codex displays large
pastes as `[Pasted Content N chars]`, with a Unicode scalar count and an optional
`#N` suffix. Claude uses `[Pasted text #N +N lines]`. One shared matcher checks the
owned prefix and, for Codex, the expected pasted character count. Queue delivery,
persisted Text Bypass drafts and idle cancellation cleanup use that same matcher.
Cancellation remnants retain the input revision, so later human typing removes
Console's permission to clear them. An unconfirmed paste becomes `needs_review`
after 30 seconds on a ready composer if a fresh capture still cannot confirm it;
a changed native PID also requires review. Confirmed text remains eligible after
a restart or an approval wait. Neither case replays
the paste or Enter. The browser shows the existing Check delivery action.
Raw typing or controls invalidate the previous native input revision before entering
the session command queue, so a later paste cannot acknowledge an older message.
Restart may resume observation of typed text, but an interrupted or uncertain Enter requires reviewing
the conversation and never causes automatic replay. Queue state is projected on
the bound session and is excluded from transcript/search content until submission.
Pending human messages defer automatic peer input and automatic session sleep.
A confirmed unsent Console notice may yield to a queued human message only with
matching staged proof, binding, ownership and exact composer text. On an idle
Claude prompt, its native clear-input control removes the entire notice; line
editing may leave earlier wrapped rows behind. Delivery requires a verified empty
composer afterward, and an uncertain clear stays reviewable without replay.
Model switches defer while a queued message owns typed or unconfirmed native input.
Stop, successful explicit suspension, release, or cancelling a queued send prevents further
automatic submission. Cancellation also owns an unchanged Text Bypass draft when its saved
text matches the cancelled message, its original prefix is empty, and its native PID matches.
This cleanup ownership stays separate from the queued message's delivery fields. The idle
cleanup clears it once, immediately or before the next queued message; it verifies the live
pane owner, PID and input revision and preserves mixed or edited drafts.
Rejected suspension leaves the queue intact. Once Enter starts, the message is
shown as sending and cannot be cancelled; uncertain delivery remains reviewable.
Native choices, slash commands and raw terminal typing retain their explicit control
path. Pending Codex first prompts retain the initial-command launch path above.

After Codex creates the durable provider transcript, pending adoption locates candidates by hashing
decoded user-message text from JSONL records. Raw serialized prompt previews are not an identity
boundary because JSON escaping can change quotes, newlines, and backslashes without changing the
user's actual prompt.

## External Integrations
- Codex CLI and Claude Code are launched/resumed locally through provider adapter commands and hidden detached tmux sessions.
- Codex sessions expose High (GPT-6 Astra/xhigh), Medium (GPT-6.1 Sol/xhigh), and Low (GPT-6 Luna/xhigh). Claude sessions expose High (Fable 5.1/xhigh), Medium (Opus 5.5/xhigh), and Low (Sonnet 5/high). New sessions use Medium unless a project supplies explicit model flags. Model-profile selections are durable server-owned requests on the bound session: the authenticated route persists the latest target immediately, and the backend applies it after verifying the provider is idle and the terminal has no draft or interactive selection. A Codex profile chosen before the first turn is used by the established first-prompt restart; a Claude profile chosen before the first turn restarts the empty provider process immediately. Navigation, browser shutdown, and ordinary backend restart do not discard a queued selection. Explicit cancellation is request-ID guarded, and release/supersession clears obsolete requests.
- A Claude command with only `--effort` still receives the canonical Medium model and effort on a
  new session, and the session stores that Medium profile for later recovery. Only an explicit
  `--model` command flag bypasses the new-session default; selected profiles override both flags.
- Codex working state follows provider `task_started`, `task_complete`, and `turn_aborted` events, not the output-recency cooldown. Claude working state follows its provider transcript's submitted user prompts and assistant `end_turn` records; a completed record only marks the response ready after the raw terminal snapshot shows the real input prompt. The server verifies the current tmux writer's owner, PID and creation time. Lifecycle records older than that writer cannot keep a resumed conversation busy or establish a new response; a backend restart reads the same writer's original creation time. Readiness requires the parsed active composer, even when notifications displace the permissions footer; the footer alone and display-decorated status are not proof of readiness. The separate `lastResponseAt` clock updates on confirmed completion, while completion recency still waits for the output idle window. Completion/interruption schedules the server-owned model queue immediately. Model switching rereads provider lifecycle under the session command lock, verifies tmux ownership, and defers on drafts, provider-queued messages, or interactive terminal state. The confirmed active profile is updated only after verified startup. A durable applying marker prevents a backend restart from blindly repeating an ambiguous process restart. A previous completion cannot acknowledge newly submitted input, and older screen polls cannot override newer session updates in the browser.
- Opening or binding an unindexed provider conversation registers its native transcript path and notifies session watchers. Pending adoption registers the same path atomically with the native binding; turn monitoring must not depend on a later project-wide discovery refresh.
- tmux is the session execution boundary; the backend captures pane state and logs normalized events.
- The main SQLite database via `better-sqlite3` stores config-derived indexes alongside durable bound session, authentication, pending-conversation, agent-coordination, and UI-preference records. The database as a whole must not be treated as a rebuildable cache.
- Tailscale identity headers can bootstrap a cookie session when explicitly trusted and allowlisted.
- Login sessions have a fixed configured lifetime. A background read can bootstrap a new
  Tailscale cookie session after expiry while an open page still has the previous CSRF token.
  The authentication guard returns HTTP 403 with `code: "invalid_csrf_token"` before an
  action executes. Only this rejection permits the shared browser API client to refresh
  `/api/auth/me`, update the same authentication query cache used by React, and retry the
  original request once. Concurrent rejections share the refresh; delayed rejections can
  use an already recovered token. Auth queries forward React Query's abort signal to
  fetch so recovery cancels older HTTP responses before their cookies can replace the
  renewed login. Network errors, other HTTP failures, and a second CSRF
  rejection never trigger replay. Failed recovery leaves the draft intact; an unauthenticated
  refresh shows sign-in. The server and browser error-code contract must deploy together.
- The localhost proxy exposes only authenticated project-local ports listed in config; it is not a generic localhost gateway.

## Key Decisions
- Prefer current ownership modules over stale facade or compatibility paths when changing behavior.
- Do not add compatibility layers, fallback mappings, or legacy response fields unless the caller contract explicitly requires them.
- A provider conversation has one restorable database owner and one hidden tmux writer. Live screen
  reads stay outside the mutating session queue, but a missing-session restore is serialized with
  input and release operations, re-reads the current conversation owner before launch and commit,
  and reports success only after the provider process survives startup. Tmux owner metadata guards
  failed-launch cleanup from terminating a replacement writer.
- Session recency is not a generic "screen changed" timestamp. Opening an old session, restoring a
  tmux binding, viewing an old transcript, raw restore output, or the screen merely leaving
  `Working` must not make a conversation look fresh.
  Synthetic tree rows and live search use the newest valid activity, output, completion, or native
  transcript timestamp. Binding creation and normalized live-event dates are fallbacks when no
  activity/transcript timestamp is known; maintenance updates never advance conversation recency.
- Explicit recent-conversation auto-tracking uses `autoTrackedAt` only for provenance in the sidebar.
  It must not write `lastActivityAt`, `lastCompletedAt`, or `lastResponseAt`, reorder projects as if user or
  agent work occurred, or run during Settings' ordinary project-tree refresh.
- Work mode filters conversation children to bound sessions while retaining every configured active
  project from the server tree. Projects remain navigable with new-conversation actions when their
  last child is released or evicted, and show "No active conversations." when empty. Projects with
  bound conversations sort above empty projects in Work mode; each group follows the selected recent
  activity or manual order, so a newly bound conversation returns its project to that order.
- Each project chat menu offers Close for a bound session. Close uses the authenticated release
  action to stop the provider process, clear runtime state and end the restorable binding. The chat
  disappears from Work mode and its saved history remains visible when Work mode is off. Closing
  the selected chat returns to its project; closing a different chat preserves the current view.
  Selection uses decoded route identity, including equivalent encodings and trailing slashes.
  Unbound history has Close disabled because there is no loaded session to unload. An unconfirmed
  shutdown retains the binding, so the chat remains available for another Close attempt.
  Retained ended bindings supply `lastClosedAt` on indexed conversation summaries and timelines.
  An unbound chat with this history is Closed and offers Resume directly, including Claude chats.
  Claude history without a recorded Console close still requires the existing handoff confirmation;
  that confirmation does not assert that a terminal process is currently running.
- Bound Work-mode dots use the provider response clock: red while the agent is working, green for a ready response under one hour old, yellow under 12 hours, amber under 48 hours, and purple from 48 to 216 hours. This gives a completed response seven full days in purple. Sessions with no confirmed response have a gray dot. Reconciliation releases nonworking sessions after 216 hours (nine days) without user or agent activity, removing them from Work mode. Automatic release of history requires an indexed, readable native transcript so Browse retains the chat before the Console runtime log is removed. History without that transcript stays in Work mode. Automatically releasing a pending session also removes its pending record and Console log. The one-hour tmux suspension remains separate from Work-mode release; queued model-profile changes are not automatically released.
- Manual Suspend keeps an established conversation bound and visible in Work while stopping its tmux session. The server stores the suspension marker in SQLite, skips that session during reconciliation and automatic Work release, and resumes it only through the authenticated resume action when the conversation is selected. Peer-message wake preserves manual pauses. The suspend action verifies tmux ownership and a readable screen, and rejects running work, native drafts, provider-queued input and queued model changes. Untyped Console messages are cancelled only after tmux stops and the suspension is persisted; a rejected pause preserves them. An empty composer does not need a recognized model footer. A native completed turn can be paused while its restored screen is still repainting. A recognized native selection can be paused without answering it, including a turn whose working/assignment labels remain active while awaiting the selection. Outside that input wait, active coordination assignments still block manual suspension. The browser submits the request even when the cached working label is set; the server owns the decision. Assignment records remain available for resume. Suspension preserves the normal response-age dot color; the separate Suspended badge and tooltip identify sessions that need resuming. Release still ends the Work binding.
- Agent-launched helpers with a finished coordination assignment and an exited native process are archived once their indexed native history is readable. Their bindings become ended and non-restorable, so Work drops them and Browse retains their transcripts. A missing transcript defers archival while still preventing automatic restoration of the finished helper. This rule excludes human-created conversations and manual pauses; explicit human resume of a manually suspended conversation remains available. The authenticated agent `close` action requires `close_session` authority and exact stored launcher ownership, rechecks both under the session command lock, and uses the normal release path. It retains a durable request/result, bypasses launch resource gates, and never enables recovery of a closed session.
- Under low available memory, reconciliation can suspend one finished session idle for at least 60 minutes per pass, oldest first. The default trigger is less than 3072 MiB `MemAvailable` in two consecutive 30-second passes; both the threshold and idle window are configurable under `sessions`. A finished session whose tmux process is already gone is not relaunched after the first low reading; it is marked suspended after the second. Live-session pressure suspension requires an idle provider with a ready prompt, no draft, interactive selection, background work or queued input, verified tmux ownership and no active coordination assignment. It then rechecks available memory immediately before stopping tmux. Its separate SQLite marker keeps the session stopped when memory recovers or the backend restarts; selecting the conversation or a pending direct message restores it when sufficient memory is available. A restored session gets at least another pressure idle window because eligibility also checks its latest state update. Pressure-suspended sessions remain eligible for the nine-day Work release. The ordinary idle suspension and restore grace both default to one hour. If `/proc/meminfo` cannot be read, pressure suspension does nothing.
- Ordinary hour-based sleep uses native readiness and run state rather than the coordination assignment's active label: SessionStart can leave that label active without starting a turn. All suspension paths protect visible native background terminals, running-shell/task counters, child-agent rosters and drafts. Automatic suspension also protects approval prompts; a manual request can pause a recognized selection without answering it. The exact native Claude summary/full-session resume menu is sleepable; a pending peer message selects the full original session using ownership/PID checks and a durable confirmation attempt. Pre-input shutdown/read failures only defer delivery. Retained live sessions still attach their output monitoring after restart; append-only pipe reattachment leaves an existing pipe connected and opens a new one only when needed. The hour sleep resumes once work indicators clear and the existing activity window has elapsed. A failed peer-wake transport restores the previous provisional submitted-turn marker while retaining its durable message-attempt record, so idle sleep remains available without replaying ambiguous input. Further automatic continuation remains blocked until the conversation is reviewed and unattended permission renewed.
- Claude transcripts can contain multiple parent-linked branches when the same provider session is
  resumed concurrently. The transcript adapter follows the last message leaf back through
  `parentUuid` and exposes that active branch instead of flattening sibling turns together.
- Claude's provider-supplied `aiTitle` is durable transcript metadata and is preferred for the
  conversation title over an initial continuation wrapper. Newly created provider transcript files
  trigger a debounced refresh of that Claude project only, so externally started chats appear in
  their configured project without a global transcript scan. The targeted refresh API likewise
  accepts a project/provider pair for recovery of a pre-existing external transcript.
- Desktop sidebar width is a browser-local preference managed by `useSidebarWidth`. Its right-edge
  separator supports pointer dragging, arrow keys, and double-click reset. Width defaults to 352px,
  stays between 280px and 640px, and leaves at least 480px for content on desktop. A smaller viewport
  clamps the displayed width without overwriting the saved preference; mobile keeps its existing drawer.
- Conversation rename opens a focused, empty field. Saving a nonempty name uses the existing
  server-owned title override; cancelling leaves the current title intact.
- A chat created with New Codex/Claude conversation starts with `titleGeneration: awaiting_message`
  on its pending record. Its first human message (not a slash command, picker number or
  coordination wake) asks the shared `agent-consult` runtime for a GPT-6 Luna title of at most five
  words, through the worker panel's data-only, account-OAuth path. The title becomes the title
  override only if none exists, so a rename wins. The state then becomes `ready`, `failed` or
  `skipped`; a failed or interrupted call is not retried, and its usage is not in the worker-panel
  footer. Agent-launched sessions keep their launcher's title. `conversationTitles` configures it.
- Native registration can adopt a new chat before its first message. The index row shows the
  session's placeholder title only until the transcript has a first user message; afterwards
  registration, including on resume, keeps the transcript title.
- Transcript-derived conversation titles retain up to 288 characters. Sidebar and search titles use a
  wrapped, viewport-constrained hover tooltip after 167 ms; it renders outside the scrolling
  sidebar so the expanded text is not clipped. Escape, scrolling, navigation, and pointer exit
  dismiss the tooltip. Parser-version invalidation regenerates older 72-character titles on
  discovery refresh; explicit title overrides remain authoritative.
- First-turn pending Codex input must keep prompt submission separate from literal selection
  keystrokes. Review `apps/server/src/routes/sessions.ts`,
  `apps/server/src/sessions/session-manager.ts`, `apps/server/test/session-routes.test.ts`, and
  `apps/server/test/session-pending-first-turn.test.ts`,
  `apps/server/test/session-keystrokes-submit.test.ts`, and `apps/server/test/session-routes.test.ts`
  before changing pending conversation restart,
  selection detection, or text+Enter passthrough behavior.
- Completion recency moves after new trackable output has idled past the completion window. Review
  `apps/server/src/sessions/session-manager.ts`, `apps/server/test/session-recency.test.ts`, and
  `apps/server/test/session-lifecycle.test.ts`
  before changing `lastActivityAt`, `lastOutputAt`, `lastCompletedAt`, `isWorking`, restore, or
  recovery behavior.
- Live-output latency and correctness belong in the server timeline boundary, not only the web
  renderer. Review `apps/server/src/routes/conversations.ts`,
  `apps/server/src/sessions/timeline-merge.ts`, `apps/server/src/sessions/live-output/`,
  `apps/server/src/sessions/transcript-watcher.ts`, `apps/server/test/conversation-routes.test.ts`,
  `apps/server/test/timeline-merge.test.ts`, `apps/server/test/transcript-watcher.test.ts`,
  `apps/server/test/live-output.test.ts`, and
  `apps/web/src/features/conversation/useConversationData.ts`, `apps/web/src/features/realtime/`,
  and `apps/web/src/features/conversation/transcript-turns.tsx` before changing timeline
  merge, pagination, duplicate filtering, live-screen polling, or refresh behavior.
- Raw screen rendering belongs to interactive/status display, not durable transcript construction.
  Review `apps/web/src/components/ConversationPane.tsx`,
  `apps/web/src/components/ConversationPane.test.tsx`,
  `apps/web/src/lib/api.ts`, `apps/web/src/features/realtime/apply-session-event.ts`,
  `apps/server/src/routes/sessions.ts`, and the live-output tests before changing text-bypass
  preview, screen panels, raw-output panels, or server-derived input display.
- Pending Codex transcript progress is a server/parser plus web-rendering contract. Review
  `apps/server/src/providers/transcripts/codex.ts`,
  `apps/server/test/providers.test.ts`,
  `apps/web/src/features/conversation/transcript-turns.tsx`,
  `apps/web/src/features/conversation/useConversationData.ts`, and their adjacent tests before
  changing commentary lifecycle, pending assistant display, or completed-tail polling behavior.
- Conversation search belongs in the server search/index boundary. Review
  `apps/server/src/routes/search.ts`, `apps/server/src/search/conversation-search.ts`,
  `apps/server/src/indexing/indexing-service.ts`, `apps/server/src/db/database.ts`, and
  `apps/server/test/search.test.ts` before changing FTS query construction, result ranking,
  live-session search, hidden-conversation filtering, or cached-index backfill.
- Provider-readable unindexed conversation binding should keep
  `apps/server/src/routes/conversations.ts`, `apps/server/src/indexing/indexing-service.ts`,
  provider transcript adapters, `apps/server/src/sessions/pending-adoption.ts`, and
  conversation/indexing tests aligned.
- The web app keeps paged history separately from metadata and screen polling. `limit=0` refreshes
  conversation and bound-session metadata only; live screen state is fetched separately through
  `/api/sessions/:sessionId/screen`, while the infinite history query loads durable messages in
  pages and retains prior pages during transient refreshes.
- Playwright e2e uses isolated backend/web servers by default (`4517`/`5178`) and does not reuse existing
  local servers. This prevents settings tests from accidentally attaching to Bryan's real
  `~/.config/agent-console/config.json`.

## Operational Notes
Use `docs/agent_docs/running_tests.md` for safe verification commands. Do not infer deploy, restore, migration, promotion, scheduler, or production-mutating workflows from test documentation.

## Assignment coordination

The global right-hand worker panel joins loaded Console sessions to assignment activity and
peer receipts. Working state remains backend-owned; an isolated shared-runtime Luna/low call
produces only three short descriptions. Refreshes share one server batch and durable private
token accounting, skip idle/unchanged workers and never wake a provider conversation.
See [the worker panel contract](worker-panel.md) for evidence bounds, refresh/visibility gates,
configuration, failures and accounting.

Peer-wake audit is an owner-owned, read-only CLI over durable SQLite attempts and native
provider turn usage. Waltium owns periodic warning checks, daily rollups and deduplicated
operator visibility. Audit thresholds do not affect message delivery or session lifecycle.
See [the audit contract](peer-wake-audit.md).

`apps/server/src/coordination/` owns assignment activity, per-checkout scope summaries, peer inboxes and a private Unix socket. The authenticated `/api/assignment-activity` route supplies `CoordinationPanel.tsx`. Lifecycle/post-tool hooks and MCP deliver peer data separately from human input. Peer-message wake is enabled by default, including while waiting for a human decision, and is independent of unattended work permission. Explicit unattended permission allows guarded assignment continuation after idle periods or worker results; transcript adapters classify that notice separately. Durable per-message attempts prevent repeated or ambiguous submission across restart. Automatically sleeping conversations can resume when memory allows; manual pauses stay paused. Idle suspension and restore grace default to one hour, with native prompt, draft and ownership checks before suspension. `coordination.pilotPaths` selects repository views. Coordination is advisory: no editing claims, Git mutations or maintenance locks exist. Migration 7 preserves old ownership records as historical events. See [the operating contract](agent-coordination.md).

## Agent wiki

`apps/server/src/wiki/` owns durable pages and append-only revisions keyed by Git common directory, so worktrees share a wiki. It stores them in a private SQLite file separate from Console's main database and maintains a consistent local SQLite backup snapshot. Both databases contain records that must be preserved. Authenticated browser routes and the `agent_wiki` MCP/CLI surface provide explicit read, search, history and compare-and-set edit operations. The browser's Wiki view renders links between pages. Wiki text is peer data and never authorizes source edits or external actions. See [the wiki contract](agent-wiki.md).


## Provider run failures and bounded recovery

Live input rejection never automatically releases, restarts, rebinds, or replays input
to a provider session. The browser removes the provisional user bubble, shows the
error, and preserves the local draft and existing binding. The composer loads a saved
draft when it mounts and has a separate component identity per conversation, so
navigating away and back does not overwrite the draft with initial empty state.
Any restart requires an
explicit user action. Rejected text entry leaves the before/after screen trace in
the session's private `debug.log`; the server also logs session identity, input
lengths, screen hashes, and wait duration without prompt or screen contents. These
metadata remain in the server journal if the session is later explicitly released.

The screen parser records whether it found an active composer, even when empty.
All configured Agent Console project folders are trusted for Claude. When a bound
Claude session displays its workspace-trust menu, Console queues acceptance under
the existing session command lock. It verifies tmux ownership and the provider PID,
selects `Yes, I trust this folder`, verifies the highlighted choice, and confirms it.
The same preparation runs before chat submission if the menu appears late. Startup
acceptance waits for a ready composer or the next interactive control, records a
status receipt, and creates no user turn or activity timestamp. It also handles an
existing trust prompt after backend restart. Unnumbered trust-menu choices are
interactive controls; quoted controls inside a bounded composer remain draft text.
Dimmed Claude prompt suggestions are empty-composer placeholders, including
truncated startup previews and suggested follow-ups. Typed input with later dim
annotations and collapsed-paste placeholders remains draft text.
Quoted menu instructions above an open composer do not block ordinary chat. When
an interactive approval or menu replaces the composer, a combined text-and-key
send rejects nonnumeric chat text before typing or confirming anything and
identifies the pending selection in the error. Explicit numeric choices and
key-only controls remain available. Direct terminal typing, including Enter to
submit a free-text answer to a provider question, remains the existing control
surface. The
existing rejection path retains the local draft and binding.

When a native menu replaces the active composer, the live bridge's explicit
key buttons keep a held chat draft separate and send only the selected key.
An explicit numeric choice is sent before Enter and consumed on success.
Text Bypass completes its buffered text delivery before control keys, clears
consumed selection previews and restores them on rejected submission. Menu
selections retain image attachments; the backend classifies selection tokens
separately from conversation input.
Controls remain visible when mobile controls are otherwise hidden. Enter in a
chat draft retains the normal guarded submission behavior; quoted menu text
above an active composer does not change how its buttons submit chat.

The input's saved height is capped at 30% of the visible viewport on mobile,
including viewport changes when the keyboard opens, and 60% on desktop. Its
44-pixel touch resize handle and visible Smaller button let the user reduce it;
Smaller resets the input to 96 pixels without changing its draft.

Console-managed Codex launches set `check_for_update_on_startup=false` so new and
restored conversations reach their composer without a host software-update menu.
Codex updates remain a host maintenance action. Existing update menus with
`enter continue · esc skip` are recognized as selection controls: combined chat
sends reject before typing, while explicit choices and key-only controls remain
available. Ordinary chat text never confirms an update.

Input confirmation uses the provider's parsed composer, including Claude's horizontal
input-box boundaries. Blank paragraphs, quoted prompts, and bullets inside that box
belong to the draft. Claude's trailing agent roster is status metadata whether it
appears before or after the permissions footer. Neither the roster nor a paragraph
break proves that text was rejected. Submitted prompts followed by assistant output
and interactive choices still remain outside the composer. A draft already visible
in the input box is submitted without pasting it a second time.
Text beginning with `?` uses bracketed paste for queued, combined and Text Bypass
entry, so the native shortcut-help key cannot consume the message's first character.

Codex `task_complete.error` records and Claude main-session assistant records marked
`isApiErrorMessage` are authoritative failed-turn outcomes. The
provider adapters preserve their messages as durable status rows, and each
incremental lifecycle monitor observes append-only transcript updates independently
of the large-conversation display cache. SessionManager attaches this monitor to
managed transcript bindings even when no conversation page is open.

The backend persists the visible failure in `bound_sessions.run_failure_json`
(schema version 8) and the consecutive-failure budget in SQLite metadata. Ordinary screen/status writes cannot overwrite that state.
The conversation notice and sidebar badge distinguish stopped, retry scheduled and
retrying. Recovery progress uses a passive status notice; exhausting the three-attempt budget raises an alert. Failed turns do not remain working because of terminal-output cooldown.

The typed Codex `server_overloaded` error and Claude native HTTP 500, 502, 503, 504
and 529 server-error envelopes automatically continue the same
unattended conversation: at most three consecutive attempts without useful provider output, delayed 15, 45 and 120 seconds. A Claude
`server_error` label alone is insufficient because OAuth failures use it too. Permission,
policy, authentication, quota and unknown failures stay stopped. Each attempt
rechecks the latest provider turn, canonical binding, live tmux ownership, enabled
project/provider, available memory and idle composer. Manual and memory-pressure
pauses, a queued model change, drafts and interactive prompts stop recovery.
Readiness requires a real input prompt; context-percentage metadata is not a
readiness signal, and Claude does not require a Codex footer. It never launches a second writer. The
continuation tells the agent to reconcile existing work and external effects before
continuing under the original authorization. It does not resend the original user
command or grant additional authority.

User input, keystrokes and release cancel pending recovery. Cancellation records
the observed turn identity and timestamp in SQLite metadata and survives a backend
restart. The Codex monitor retains the precise turn-start timestamp rather than
the whole-second start time on a completion envelope. The budget survives
server restart; historical failures without an existing recovery record remain
visible but are not automatically resumed. A scheduled attempt older than ten
minutes stops, with age checked again after asynchronous readiness checks before
starting submission. The attempt is persisted before submission: uncertain transport or
restart outcomes are stopped for manual inspection, and lack of provider
acknowledgment within 30 seconds also stops recovery. A new running turn clears
the active retry notice immediately; the separate budget survives acknowledgment
and backend restart. Actual assistant output or a tool call renews the budget,
so hours of productive work do not consume a lifetime three-retry allowance.
Confirmed completion also clears it. Claude provisional `end_turn` records without
useful output retain the budget; stale completion callbacks do not clear newer failures.
Recovery state transitions and their stop reasons are also appended to the session event
log, so clearing the active notice does not erase the decision evidence.

Codex recovery uses its native queue, preserving the composer and avoiding lost
text-plus-Enter submissions. Claude recovery verifies the exact entered composer
before sending Enter. Automatic text entry checks cancellation and tmux ownership again before Enter.
A Stop received while entering text leaves that text unsent and retains the
cancellation reason. An Enter already handed to tmux cannot be recalled. These
guards also apply to assignment continuation. The backend owns explicit unattended permission, supervisor relationships and silence/result signals in SQLite metadata; see [the coordination contract](agent-coordination.md#explicit-unattended-work). Turn lifecycle status, continuation permission and peer-message wake remain independent. Human Stop, cancellation and manual pause disable peer wake until an accepted human conversation turn; agent waiting updates do not. After handling its inbox, an unattended assignment continues authorized work in that same turn unless recovery is blocked or stalled. A waiting assignment returns to waiting. Inbox turns preserve pending human decisions and neither spend nor reset the continuation budget. Worker facts never grant permission or reset a spent continuation budget.

A granted restart is an explicit one-turn action, independent of automatic recovery.
It resolves either a session ID or a target assignment ID to the original binding,
checks grant and pause guards, then resumes the native conversation with an opening
prompt. A finished assignment or waiting continuation does not block that turn.
It preserves continuation permission, pending human decisions and the existing
conversation. Released bindings and manual pauses remain protected.


An unexpected provider exit with unattended work remaining uses this same durable
backoff. Reconciliation and queued peer messages cannot bypass it. The backend
resumes the original conversation, preserves its assignment and inbox, and submits
the recovery notice after native readiness. Three failed relaunches stop recovery.
Intentional automatic idle sleep has a persisted marker and a cleared PID. Passive
screen polling does not restore it; intentional user and peer wake paths remain available;
manual suspension, finished assignments and resource limits stay respected.
Failure transitions advance the session revision timestamp so browser polls and
events accept the cleared status; they do not advance conversation recency.

### Durable ordinary idle sleep and pending identity

Ordinary idle sleep persists `idleSuspendedAt` on the bound session, independently of manual
and pressure suspension. All sleep reasons are visible in Work without changing the response-age
dot. Screen polling and passive ensure calls leave an idle sleeper stopped, including calls from
older browser builds. Selection, human input, queued messages, model changes and eligible peer
messages may restore the same conversation. Successful restoration or release clears the idle
marker. Ordinary idle sleepers remain eligible for the existing nine-day Work release.

Reconciliation resolves recorded pending conversations before applying idle rules. Exact registered
identity is preferred for both human-created and agent-created sessions. An idle pending Codex session
without a registration uses the existing bounded provider candidate search. Claude retains its
normal transcript-discovery adoption path; reconciliation does not add full history scans.
Human-created registrations are polled for adoption after recorded input exists. Forked Codex histories,
ambiguous fingerprints and native identities already owned by another retained binding are refused.
The pending guard stays in place until the resumable native identity is known. This does not change
general transcript discovery cadence or permit stopping unresolved sessions.

Automatic Claude notices record their binding and intended notice kind before paste (`pasting`),
then confirmation (`staged`) and Enter invocation (`submitting`). An exact owned never-submitted
notice may be discarded by successful sleep or retired by the existing guarded human-input path.
Partial, clipped, mixed or unowned drafts, uncertain Enter and interrupted retirement remain
protected. The ordinary ready-prompt, working-turn, background-task and ownership guards still apply.
