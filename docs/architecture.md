# Architecture
## System Overview
Waltium Control reads assignment, messaging, grant and wiki metadata through the
standalone [engineering summary](engineering-summary.md). It opens the existing
SQLite files read-only and never starts or migrates the live backend. Source
failures and unknown wiki provenance remain visible in its versioned JSON.

Standing grants let agents launch and restart real Console sessions under Bryan's recorded authority.
See [Agent grants](agent-grants.md) for creation, inheritance, the durable launch queue and native context.

`agent-console` is a local, server-first Codex/Claude/Grok/Mistral Vibe Agent Console. The backend owns project configuration, provider transcript discovery, session binding on the structured provider transport (Codex app-server, Claude headless stream-json, Grok ACP and Vibe ACP, each behind a session host), auth, proxying, SQLite state, and the session event logs. The React PWA is a thin client that renders backend-owned project/conversation/session state; it must not become a raw terminal controller.

First-class runtime surfaces:
- Fastify startup: `apps/server/src/index.ts` calls `buildApp` in `apps/server/src/app.ts`; root `package.json` coordinates the server, web and shared packages.
- Host coordination/MCP/hooks: `scripts/agent-coord.mjs` transports requests to the backend-owned coordination, grants and wiki services; it does not own their durable state.
- Worktree maintenance: `scripts/worktree-sweep.mjs` inventories checkouts and branches and performs guarded cleanup only in apply mode; it reads Console state through a read-only SQLite connection.
- Fastify conversation/timeline API: `apps/server/src/routes/conversations.ts`.
- Fastify conversation search API and index: `apps/server/src/routes/search.ts`,
  `apps/server/src/search/conversation-search.ts`,
  `apps/server/src/indexing/indexing-service.ts`, and the SQLite `conversation_search_fts` table in
  `apps/server/src/db/schema.ts`.
- Fastify session input API: `apps/server/src/routes/sessions.ts`.
- Session lifecycle: `apps/server/src/sessions/session-manager.ts`, `structured/structured-session-service.ts`, `session-runtime.ts`, `input-queue.ts`, `timeline-merge.ts`, `live-output/reader.ts`, `working-state.ts`, `transcript-watcher.ts`, `run-recovery.ts` and `tmux-row-conversion.ts` (the startup conversion of rows the removed tmux transport left).
- Provider transcript adapters, especially `apps/server/src/providers/transcripts/codex.ts` for Codex JSONL display filtering and duplicate handling.
- React app shell and conversation surface: `apps/web/src/App.tsx`, `apps/web/src/features/navigation/`, `apps/web/src/features/realtime/`, `apps/web/src/features/conversation/useConversationData.ts`, and `apps/web/src/components/ConversationPane.tsx`.
- npm scripts: `npm run auth:hash`, `npm run build`, `npm run dev`, `npm run test`, `npm run test:e2e`, `npm run typecheck`.

## Mobile conversation layout

On narrow screens, including touch screens below 1024 CSS pixels in landscape,
the app opens conversations in reading mode with a compact
project/chat header and persistent Chats, Reply and Controls actions. Chats fills
the screen and groups active conversations by project. Its default filter hides
history, manual/pressure/idle suspensions and projects with no remaining chats.
Show all and search provide access to hidden history; New chat includes active
configured projects with existing directories, including projects hidden by the
active-chat display filter. Show all offers a project selector and a 5, 20 or 50 chats
per project limit, defaulting to all projects and 20. Each project's limit applies
to its newest conversations across Codex, Claude, Grok and Vibe together. These selectors
are hidden during transcript search and new-chat selection; active-only browsing
ignores them. These are display filters and do not change session state.
Desktop navigation retains its existing Work/Browse filtering and sizing.

Reply and Controls share one optional panel. Reply starts at one line, grows to
at most 112 pixels or 22% of the visible viewport with a 44-pixel minimum, and
scrolls internally for longer drafts. A separate Send button submits; the phone Return key inserts a
newline. An accepted or queued reply closes the composer;
rejection retains it. Closing input and switching chats preserve per-chat drafts.
Controls exposes Stop, the model profile and the session status without focusing a text field;
none of them touches the unsent chat draft.

The mobile shell follows visualViewport height and offsetTop on resize and scroll
so the keyboard and browser panning cannot cover the footer. The transcript keeps
its own flexible scroll area. Its existing scroll controller follows new output
only at the bottom, preserves a reader's position above the bottom, and loads
earlier history through the server-owned pagination path.
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

Conversation refreshes retain text rows with the same message ID, role, timestamp and
content, removing only vanished rows and inserting only changed or new chunks. The
lowest owned FTS row holds the current shared conversation metadata. Search reads
title, project metadata and recency from that row even when another chunk matched;
appending a message therefore updates metadata once instead of rewriting all historical
text. Ownership, content and the file fingerprint commit atomically. Existing indexes
already have a valid metadata owner, so this change needs no schema migration. An older
binary needs a full search refresh after rollback to restore its duplicated metadata.

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
backend resolves those IDs within the selected project and provider and appends
the image envelope (local file references) to the message. The transport attaches
the stored files natively (Codex `localImage` items, Claude base64 image blocks,
see `docs/structured-cutover.md`, "Parity features") and drops the envelope's
instruction line from the text it sends. It does not use the host desktop clipboard
or create another provider process. Upload errors and rejected sends retain the draft.

The generated image envelope remains in event logs and provider history for
recovery and duplicate matching. At the public timeline,
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
  indexing, conversation search, session management on the structured provider transport,
  session event logs, restart handling, and localhost proxying.
- `apps/web/` - React/Vite PWA for project navigation, conversation timelines, live session
  display, settings, and auth flows.
- `packages/shared/` - shared TypeScript contracts for sessions, conversations, projects, and
  provider data.
- `config/` - example runtime configuration for projects, providers, proxy allowlists, and auth.
- `scripts/` - operator/development helpers such as auth hash generation, the coordination helper, the
  worktree sweep and the opt-in real-provider proofs.
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
parse during the active turn while a single background refresh runs; later polls pick up the refreshed
parse. The conversation route returns
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

Live timeline reads cache the rows of each session's event log. Append reads verify the file identity and previous EOF bytes;
partial records, truncation and replacement trigger reconstruction. Tail boundaries and
message offsets use UTF-8 byte positions. Parsing and reconstruction yield between
bounded batches. Completed live-read entries have a combined 64 MiB estimated-text
budget and a 64-entry limit, and concurrent reads of the same fingerprint share work.

`GET /api/sessions/:sessionId/screen` serves a status synthesized from the transport's state
(`StructuredSessionService.screen`): the provider and whether it is working, idle or asleep, the
model of the active cost profile and the share of context left. There is no terminal content. An
asleep or suspended conversation answers 404; a bound one that is not loaded is loaded first.
Timeline responses from `apps/server/src/routes/conversations.ts` return messages and bound-session
metadata; `apps/web/src/features/conversation/useConversationData.ts` polls the screen route
separately for the status panel.
Live rows come through `apps/server/src/sessions/live-output/reader.ts` and the event log attached
to the bound session: the person's messages (`user-input`, durable until the transcript carries
them) and the Console's status lines. An automatic opening prompt (`agent-input`, a granted launch)
and terminal output an earlier build logged (`raw-output`) are not shown; the transcript carries the
conversation. Codex transcript parsing prefers response-backed display messages over
near-duplicate event messages, removes internal memory-citation blocks before display comparison,
and hides environment, `AGENTS.md`, and instruction wrapper records from the visible transcript
while keeping the full parsed message set available for indexing. Codex commentary-phase assistant
records are treated as pending progress, and only the latest pending commentary tail is displayed
so an in-flight answer can show progress without flooding the durable transcript. A new chat starts
as a pending alias (`pending:<uuid>`); its bind learns the native id from the provider at once and the
native conversation adopts the alias (`sessions/pending-adoption.ts`), writing the conversation
summary and transcript path to the index in the same transaction, so reads of the alias and
transcript watchers share one identity. Until the transcript exists, the chat shows submitted input
and session status.

The console keeps three text channels separate. `/screen` exposes the synthesized session status,
event-log readers preserve submitted user input and session status, and provider transcript
adapters produce conversation history. The web conversation pane may show a sent message
optimistically, but only a recorded user input or the transcript makes it a durable row.

Claude `api-request-blob` records are saved copies of model context, not new conversation
turns. The adapter excludes them from parsed messages, active-branch selection and opening
prompt matching. They cannot supply prompt hashes, excerpts or conversation activity dates.
The parser version invalidates persisted transcript summaries and search entries after this
filter changes; provider transcript files remain unchanged.

Claude records human messages delivered during a running turn as `attachment`
records with `queued_command`, `commandMode: prompt`, `humanTurn: true` and
`origin.kind: human`. The adapter reads their prompt as a durable user message,
using the native timestamp and the selected parent-linked branch. The rendered
system-reminder wrapper stays out of the chat. Bare queue operations do not prove
delivery, and automated attachments do not become user messages. These delivered
questions remain visible after the assistant replies, when the temporary live
input copy is removed. Parser versioning refreshes existing summaries and search.

Claude compaction summaries are provider bookkeeping, not submitted prompts. The Claude
history parser follows `logicalParentUuid` at `compact_boundary` records to retain earlier
messages on the selected branch. It displays `isCompactSummary` records as durable
`compaction` status markers with the text `[Claude auto summarized]` for an `auto` trigger
and `[Claude summarized]` otherwise, retaining the original
summary only in internal record metadata. These markers do not replace real user prompt
hashes, advance conversation activity, enter conversation search, or start a working turn.
The ready indicator continues to use the last confirmed response and its age.

When debugging duplicated bubbles, missing assistant text or stale live rows, route the investigation by text source instead of by visual symptom. Durable history starts
in the provider transcript parser (`apps/server/src/providers/transcripts/codex.ts` or the Claude
adapter), live rows start in `apps/server/src/sessions/live-output/`, duplicate
suppression belongs in `apps/server/src/sessions/timeline-merge.ts`, and presentation rules belong in
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

`IndexingService` owns search-index refresh and repair. Normal indexing reconciles FTS rows with
provider conversations, retaining unchanged message chunks.
`backfillMissingSearchIndexRows()` fills missing FTS rows from the
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
provider activity during the preceding eight hours into Console sessions. Claude discovery is
intentionally different: an unbound Claude transcript remains outside Agent Console until the user
explicitly confirms that its original terminal session has stopped. This prevents refresh from
starting a second Claude process for the same provider conversation. Settings-driven tree refreshes
do not request auto-tracking. `autoTrackedAt` is persisted as display provenance: it makes a newly
discovered Codex binding green without changing genuine conversation activity or project-recency
ordering. The bind resumes the original conversation id; it does not fork a new provider id.

The web conversation data hook keeps metadata and paged messages on separate query keys. Active
bound sessions poll the message timeline; after a session completes, the message query keeps polling
briefly when the latest durable message is still the user's prompt or when session output/completion
timestamps are newer than the latest transcript message. This closes the gap where a turn has
finished but the provider transcript has not yet exposed the assistant's final answer.
Binding a session to a provider-readable conversation does not require that conversation to already
have a search-index row. The conversations route can load the provider transcript directly for a
known conversation id, then the indexing service backfills search rows later without blocking the
binding flow.

Session input has one path into the provider: the structured transport takes complete messages
and Stop. `POST /api/sessions/:id/input` sends a message directly. `POST /api/sessions/:id/keys`
takes `keys: ['Enter']` with `text`/`submittedText` (and optionally `submissionId` and `imageIds`)
to send a message, or `keys: ['Escape']` alone to stop the running turn; any other key, text without
Enter, or a field the route does not take is refused with 400 and nothing is sent. A message that is
only a slash command word is refused at admission (terminal controls do not exist on the structured
transport).

Complete chat drafts carry a UUID `submissionId` on `/keys`. The backend journals each request in
SQLite metadata (`sessions/input-queue.ts`) as `queued`, `submitting` (the request was handed to the
transport), then `submitted` with the turn it started or steered, and delivers messages in order
under the session command lock. While a turn runs, a provider that can steer takes the message into
the running turn; one that cannot keeps it queued until the turn ends. Automatic input still requires
an idle provider. The browser shows the queued message separately from the transcript and clears
the submitted local draft after the server accepts the request; refreshing or navigating does not
discard it, and retrying an uncertain HTTP request with the same submission ID returns the existing
receipt. A message the transport refused before writing anything waits and is retried (for at most
ten minutes of refusals); one it can never accept, or whose delivery is uncertain, becomes `failed`
with its reason and stays listed until the person dismisses it (`DELETE
/api/sessions/:id/queued-inputs/:requestId`). A message the backend was submitting when it restarted
becomes `failed` and is never replayed. Queue state is projected on the bound session and is excluded
from transcript and search content until submission. Pending human messages defer automatic peer
input, automatic session sleep and model switches.

Stop interrupts the running turn and cancels queued messages; a direct send or Stop moves the input
revision, so a queued send that a later Stop overtook before it reached the queue is cancelled and
never sent. The steers the provider drops with a stopped turn are marked `failed` ("cancelled by
Stop"). Explicit suspension and release cancel queued messages too. Once submission starts, a
message cannot be cancelled.

## External Integrations
- Codex (`codex app-server`), Claude (headless `claude` with stream-json input and output), Grok (`grok agent stdio` over ACP) and Mistral Vibe (`vibe-acp` over ACP) run locally behind per-process session hosts, driven by transport plugins (`apps/server/src/providers/transport/`); see "Structured provider lane" below.
- **One model list.** The Console holds no model names. The Ultra, High, Medium and Low models of each provider, and the Auto router, come from the workflow_optimizer catalog (`catalog.toml`) through its `wo` command. The server (`model-profiles/service.ts`) runs `wo profiles --json` with a timeout, caches a good answer for five minutes, and serves it to the web app at `GET /api/model-profiles` (authenticated; `503` with the reason when the catalog cannot be read). If a later read fails, the last good answer keeps being served and the failure is logged. If no read has ever worked, anything that needs a profile fails with `Model profiles unavailable: <reason>` and the profile control shows that message with its buttons disabled. There is no fallback table in this repository. The `wo` path is `modelRouting.woPath` in the config (default `/home/bryan/code/workflow_optimizer/.venv/bin/wo`); the environment variable `AGENT_CONSOLE_WO_PATH` overrides it for one process, which is how the tests point at a stand-in script.
- **Profiles.** The profiles are four levels, **U** (Ultra), **H** (High), **M** (Medium) and **L** (Low), plus **A** (Auto; shortcut Alt+A, to the left of U, H, M and L). Codex and Claude offer all four levels; Grok has only Medium and Low, so its U and H buttons are greyed out and a request for them is refused with `Grok has no Ultra model.` (or High). The catalog decides which models sit at each level (for example Ultra is Fable or Astra, Medium is Sonnet, Terra or Grok 4.7). A new chat started from the UI starts on Auto; a history bind and a launch that names its own model or profile (for example a standing-grant launch) keep their current behavior, and new launches that name no model start on Medium. Model-profile selections are durable server-owned requests on the bound session: the authenticated route persists the latest target immediately, and the backend applies it when no turn runs and no message waits in the input journal; the profile rides on the next turn, so no process restarts. Navigation, browser shutdown, and ordinary backend restart do not discard a queued selection. Explicit cancellation is request-ID guarded, selecting the active profile again cancels a queued change, and release clears it.
- **Thinking level.** Session controls let the person set effort independently of model and Auto. The server stores the selection in session metadata only after the provider accepts it and supplies it to every later turn and on restore, overriding the effort from a model profile or Auto decision. Reopening a released conversation carries its last selected level to the new session. The selected value stays until changed. For a running turn Codex uses the experimental `turn/settings/update` and enables `step_model_switching` on new and resumed threads; Claude uses `apply_flag_settings` with `get_settings` readback, and Grok uses `session/set_config_option` with option readback. A model call already underway keeps its setting. In a real Claude 2.1.317 probe on 2026-11-03, readback changed during a shell tool but the following model request in that same turn still used the old effort; the control states that Claude applies the choice on the next turn. Grok accepted and reported the setting during a real active turn; the effort of its next model request was not observed. An older Codex turn that began without the feature refuses the live change; after it finishes the person can suspend and resume the conversation to enable it. The server reports refusal and leaves its saved selection alone. Provider-supported efforts vary by model and a refusal remains visible in the control.
- **Auto (A).** Auto does not pick a model when it is selected. It picks one when the next message is sent. A session on Auto carries `routePending` (the next message must be routed) and the router's latest decision (`BoundSession.autoRoute`, stored in `bound_sessions.auto_route_json`). When a message arrives and `routePending` is set, the server runs `wo route --task <first 2,000 characters of the message> --launcher console --provider <openai|anthropic|xai> --json` (timeout 8 seconds, vendor fixed by the session's provider), then applies the returned model and effort through the same structured switch the U, H, M and L buttons use, before the turn is sent. The decision is stored on the session. The first message is a weak signal (often a greeting or a one-line ask), so the session's second prompt is always routed once more, and after that the choice is final unless it is provisional (see the next two bullets); a final choice keeps the model, which keeps the provider's prompt cache. Pressing A again keeps the current model, resets the count, and routes the next message afresh as the first. U, H, M and L are manual overrides and clear the Auto state. A message that steers a running turn is not routed (the running turn keeps its model); the next turn is. If `wo route` fails, times out or chooses no model, Medium is applied, the decision is recorded as a fallback with the visible warning `Auto unavailable: <reason>. Using Medium.`, and the message is sent anyway; that attempt counts as the routing for this selection of A. The web shows one line built from the router's typed fields (`A → Sonnet 5.5·low · implementer 91% · lighter · Claude on pace`) with the router's full reason on hover.
- **Second-prompt check and provisional choices.** `BoundSession.autoRoute` counts the prompts routed since A was selected (`routedPrompts`, the first included) and remembers the text the last routing saw (`previousPrompt`). After the first routing `routePending` stays set, so the session's next prompt is routed again whatever the first decision was (a router answer, or the Medium fallback of a failed routing). That second routing uses the new prompt, the start of the last assistant reply (read from the provider transcript, best effort) and the earlier prompt, newest first, at most 2,000 characters, and stays inside the session's own provider (`--provider` is passed). A changed model or effort goes through the same profile switch as any Auto routing; the same model only updates the row and adds no status line. A clear second answer (or a router failure that leaves the first choice standing) is final. When the classifier cannot tell what kind of task a message is, the router still returns a normal choice but marks it `provisional` (an older router that does not send the field means a clear answer): the decision records the flag, the web line reads `A (provisional) → Luna·low · role unclear · lighter`, and re-routing continues on the following prompts in the same way, until an answer is clear or three prompts have been routed in all, counting the first. At the third the last choice is kept and marked final, whatever it says. A router failure during a re-route keeps the earlier choice instead of dropping to Medium, and counts as a routed prompt. A message that has to wait (a turn is running, or a profile switch is pending) is routed when it is sent, not before. Pressing A again discards the count, so the next prompt is the first. The state lives in `autoRoute`, so it needs no schema change. While a check is still due the web line adds `re-checks at your next prompt`.
- **A level the message asks for.** Each routed prompt is passed to the router whole (`--latest-message <newest text>`), and the router's classifier also reads it for an explicit instruction about the model level or the thinking level ("use ultra", "use high, medium thinking", "use sol"). It does this by reading the message, not by word matching. When it finds one, the router answers with that level's best model by quota inside the session's provider, and the requested effort when a thinking level was named; the decision records `level`, `levelSource: classifier` and `requestedEffort`, and the web line reads `A → <model> · ultra asked`. An asked-for choice is final at once: no later prompt re-routes it. If the session's provider has no model at that level (Grok and Ultra), the router answers that the level is unavailable here and the Console treats it like any routing failure: on the first prompt Medium is applied with the warning `Auto unavailable: <reason>. Using Medium.`; on a later prompt the earlier choice stays.
- **Start (provider-neutral new chat).** `POST /api/conversations/:projectSlug/start` with `{ prompt, level? }` creates a structured chat without the person choosing a provider. The server (`sessions/start-conversation.ts`) runs `wo route --task <first 2,000 characters> --launcher console --json` with no `--provider`, maps the router's vendor to a Console provider (`openai` is Codex, `anthropic` is Claude, `xai` is Grok), creates the structured chat on it with the returned model and effort recorded as an Auto decision (the profile is `auto`; this counts as the first routed prompt, so the chat's second prompt is checked again inside that provider like any Auto session), and sends the prompt as the first turn without routing it a second time. Providers whose structured lane is off, or that the project has disabled, are skipped: the router's best alternative on an enabled provider is used. If routing fails, the chat is created on the default named by `modelRouting.startDefault` (default Codex, Medium; another enabled provider is used when that one is off), with a status line and a `warning` in the response that the web shows; the prompt is never lost. If even the default profile's model cannot be looked up, the chat starts on Auto with no model chosen and the provider runs its own default. **Start on a level.** The Start box offers A, U, H, M and L (A is the default). With a level picked (`level` in the body), the server runs `wo route --level <level> --launcher console --json` instead: the router picks the model at that level with the most quota room across the providers that hold it, and the chat starts on that fixed level profile (not Auto) with the router's reason as its first status line (`Ultra: Best ultra-level fit is Claude Fable 5.1 ...`). The prompt is not routed again. If the router fails, the chat starts on `startDefault`'s provider when it holds the level, otherwise on the first enabled provider that does, with a warning. If no enabled provider holds the level, the start is refused and nothing is created. The provider-specific new-chat entries stay.
- Working state follows the transport's own turn state (`turn.started` and the turn's terminal event); a conversation that is not loaded runs nothing. The separate `lastResponseAt` clock updates on a completed turn, while completion recency (`lastCompletedAt`) waits for the output idle window. Completion or interruption schedules the server-owned model queue immediately. A previous completion cannot acknowledge newly submitted input, and older status polls cannot override newer session updates in the browser.
- Opening or binding an unindexed provider conversation registers its native transcript path and notifies session watchers. Pending adoption registers the same path atomically with the native binding; turn monitoring must not depend on a later project-wide discovery refresh.
- The transport plugin is the session execution boundary; the backend journals input and status lines in the session event log.
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
- A provider conversation has one restorable database owner and one provider writer. Status reads
  stay outside the mutating session queue, but a restore is serialized with input and release
  operations, re-reads the current conversation owner before loading and commit, and reports success
  only after the transport loaded the conversation. A per-session plugin refuses a second open of a
  conversation that is already loaded.
- Session recency is not a generic "status changed" timestamp. Opening an old session, restoring it,
  viewing an old transcript, or the status merely leaving working must not make a conversation look
  fresh.
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
- The desktop Active only toggle beside Work mode remembers its setting locally. It filters the
  project chat list to bound, unsuspended sessions whose current dot is green, red, or yellow,
  using the same status rules as the dots. All suspension reasons are excluded even when the dot
  is green or yellow. The filter updates with response age, works with Work mode on or off, and
  retains configured projects and their new-conversation actions. Mobile filters are independent.
- Chats an agent launched under a standing grant are ordinary conversations. While the agent drives
  one alone, the chat list and chat search hide it until the Agent controlled filter is on. The first
  message the person sends in that chat ends this: the session record keeps a `humanRepliedAt` time
  in its launch record (`markHumanReplied`, called from `SessionManager.appendEvent` for every
  `user-input` event), and the chat then appears in the list and search like any other. The reply
  is permanent. The agent's own opening prompt (`agent-input`) and later agent messages do not count.
  A reply marks every agent launch of that chat, so a person who reopens a saved agent chat and
  replies in the new session also brings it into the list. The launcher's name stays on the chat's
  badge. A chat launched before the Console tracked replies is recovered at startup by
  `backfillHumanReplies`, which reads the first `user-input` line of the event log of each session on
  the chat once. The filter is remembered in the browser, is off by default, and
  is available on desktop and mobile. It does not stop the agent, unload its transcript, or free the
  provider process. That memory belongs to the running session, not to the list row. Opening a chat
  by its address still works, and the worker panel still lists workers. The tree marks agent-driven
  chats with `agentControlled`, including saved history after the session ends; a chat the person has
  replied in is no longer marked. A live session is also recognized from its launch record, through
  `agentDrivenBy` in the shared package. The web client applies a reply as soon as the
  `session.user-input` event arrives, so the chat appears without a reload. A project whose visible
  chats are all hidden this way says that agent-launched chats are hidden.
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
- Bound Work-mode dots use the provider response clock: red while the agent is working, green for a ready response under one hour old, yellow under 12 hours, amber under 48 hours, and purple from 48 to 216 hours. This gives a completed response seven full days in purple. Sessions with no confirmed response have a gray dot. Reconciliation releases nonworking sessions after 216 hours (nine days) without user or agent activity, removing them from Work mode. Finished assignments whose provider process has ended retain their restorable inbox and bypass this release check. Automatic release of history requires an indexed, readable native transcript so Browse retains the chat before the Console runtime log is removed. History without that transcript stays in Work mode. Automatically releasing a pending session also removes its pending record and Console log. Idle sleep (after each provider's `idleUnloadMinutes`) remains separate from Work-mode release; queued model-profile changes are not automatically released.
- Manual Suspend keeps an established conversation bound and visible in Work while ending its loaded provider session (a per-session process ends; a shared process unloads the thread). The server stores the suspension marker in SQLite, skips that session during reconciliation and automatic Work release, and resumes it only through the authenticated resume action when the conversation is selected. Peer-message wake preserves manual pauses. The suspend action rejects a running turn, background work the process reports, queued model changes and an active coordination assignment. Untyped Console messages are cancelled only after the session ended and the suspension is persisted; a rejected pause preserves them. Assignment records remain available for resume. Suspension preserves the normal response-age dot color; the separate Suspended badge and tooltip identify sessions that need resuming. Release still ends the Work binding.
- Completed assignments retain their restorable inbox after the provider exits. Reconciliation and polling leave the provider asleep; a pending message can request a guarded inbox-only restore. Completion and expired grants stay unchanged. Explicit close makes a binding ended and non-restorable, retaining queued messages until explicit resume. The authenticated agent `close` action still requires current `close_session` authority and exact stored launcher ownership, rechecks both under the session command lock, and uses the normal release path.
- Under low available memory, reconciliation can suspend one idle per-session conversation (its own process; a shared Codex app-server is left alone) idle for at least 60 minutes per pass, oldest first. The default trigger is less than 3072 MiB `MemAvailable` in two consecutive 30-second passes; both the threshold and idle window are configurable under `sessions`. Pressure suspension requires no running turn, no background work, no queued input or model change and no active coordination assignment, and rechecks available memory immediately before ending the process. Its separate SQLite marker keeps the session stopped when memory recovers or the backend restarts; selecting the conversation or a pending direct message restores it when sufficient memory is available. Pressure-suspended sessions remain eligible for the nine-day Work release. If `/proc/meminfo` cannot be read, pressure suspension does nothing.
- Ordinary idle sleep uses the transport's turn state and the idle window (`structuredSessions.<provider>.idleUnloadMinutes`) rather than the coordination assignment's active label: SessionStart can leave that label active without starting a turn. All suspension paths protect background work the process reports (`TransportSession.hasBackgroundWork`) and queued input. A failed peer-wake delivery restores the previous provisional submitted-turn marker while retaining its durable message-attempt record, so idle sleep remains available without replaying ambiguous input. Further automatic continuation remains blocked until the conversation is reviewed and unattended permission renewed.
- Claude transcripts can contain multiple parent-linked branches when the same provider session is
  resumed concurrently. The transcript adapter follows the last message leaf back through
  `parentUuid` and exposes that active branch instead of flattening sibling turns together.
  At compaction boundaries it also follows the logical parent and explicit preserved-segment
  UUIDs. Claude can move the logical tail beneath the summary, creating a cycle; the preserved
  records retain the earlier branch and its original turns. Visited UUIDs bound traversal.
- Claude's provider-supplied `aiTitle` is durable transcript metadata and is preferred for the
  conversation title over an initial continuation wrapper. Newly created provider transcript files
  trigger a debounced refresh of that Claude project only, so externally started chats appear in
  their configured project without a global transcript scan. The targeted refresh API likewise
  accepts a project/provider pair for recovery of a pre-existing external transcript.
- Desktop sidebar width is a browser-local preference managed by `useSidebarWidth`. Its right-edge
  separator supports pointer dragging, arrow keys, and double-click reset. Width defaults to 352px,
  stays between 280px and 640px, and leaves at least 480px for content on desktop. A smaller viewport
  clamps the displayed width without overwriting the saved preference; mobile uses the full-screen Chats view.
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
- `/keys` takes a complete message with Enter or Stop (Escape) alone. Review `apps/server/src/routes/sessions.ts`,
  `apps/server/src/sessions/session-manager.ts`, `apps/server/test/session-routes.test.ts` and
  `apps/server/test/session-input-queue.test.ts` before changing what the route accepts or how a queued message is sent.
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
- The synthesized session status belongs to status display, not durable transcript construction.
  Review `apps/web/src/components/ConversationPane.tsx`,
  `apps/web/src/components/ConversationPane.test.tsx`,
  `apps/web/src/lib/api.ts`, `apps/web/src/features/realtime/apply-session-event.ts`,
  `apps/server/src/routes/sessions.ts`, and the live-output tests before changing status panels
  or server-derived input display.
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

`apps/server/src/coordination/` owns assignment activity, per-checkout scope summaries, peer inboxes and a private Unix socket. The authenticated `/api/assignment-activity` route supplies `CoordinationPanel.tsx`. Lifecycle/post-tool hooks and MCP deliver peer data separately from human input. Peer-message wake is enabled by default and independent of unattended work permission. In the cooperative priority trial, sender-chosen P1 alone requests a guarded wake; P2 bodies wait for an existing turn, and default P3 provides a fifteen-minute mail notice with bodies fetched on demand. Supervisor task DONE/action-needed BLOCKED reports default to P2/week and a fifteen-minute digest inside existing turns; routine progress stays on a task board. Explicit supervisor dispatch activates an assigned unattended task once without changing message urgency, restarting the native session, renewing authority or resetting recovery. Supervisor instructions, worker reports and peer mail stay separate in injected context. Expired pending bodies are purged. A shared, scoped broadcast board has opt-in category notices and no direct-message fan-out. Routine activity stays available on demand without automatic context injection. Send-only services reject new messages before inbox insertion; receipts identify finished lanes and their supervisor. Explicit unattended permission allows guarded assignment continuation after idle periods or worker results; transcript adapters classify that notice separately. Durable per-message attempts prevent repeated or ambiguous submission across restart. Automatically sleeping conversations can resume when memory allows; manual pauses stay paused. Idle suspension and restore grace default to one hour, with native prompt, draft and ownership checks before suspension. `coordination.pilotPaths` selects repository views. Coordination is advisory: no editing claims, Git mutations or maintenance locks exist. Migration 7 preserves old ownership records as historical events. See [the operating contract](agent-coordination.md).

## Agent wiki

`apps/server/src/wiki/` owns durable pages and append-only revisions keyed by Git common directory, so worktrees share a wiki. It stores them in a private SQLite file separate from Console's main database and maintains a consistent local SQLite backup snapshot. Both databases contain records that must be preserved. Authenticated browser routes and the `agent_wiki` MCP/CLI surface provide explicit read, search, history and compare-and-set edit operations. The browser's Wiki view renders links between pages. Wiki text is peer data and never authorizes source edits or external actions. See [the wiki contract](agent-wiki.md).


## Structured provider lane

Every conversation runs through a provider protocol: Codex through `codex app-server`, Claude through its headless
stream-json CLI, Grok through `grok agent stdio` (ACP), and Mistral Vibe through `vibe-acp` (ACP). A provider can run conversations only while its lane is on
(`structuredSessions.<provider>.enabled`, default on); a bind for a provider whose lane is off answers 400. The tmux transport
that came before was removed in Phase B (see [the cutover plan](structured-cutover.md), "Phase B record"). The plan, contracts
and verification evidence are in
[the lane plan](structured-providers.md) (Codex) and [the cutover plan](structured-cutover.md) (relay, Claude, questions,
removal of tmux); this section is the summary.

- Rows: `bound_sessions` keeps two columns from the tmux transport until a later schema version drops them:
  `tmux_session_name` (not null) and `transport` (schema 19). New rows fill them with `structured:<sessionId>` and
  `structured`; the domain type has neither. The row keeps the provider process id in `pid` (a per-session process, or the
  shared app-server).
- Startup conversion: when the backend starts, before anything reads the rows, `SessionManager` converts every restorable
  row an earlier build left with `transport = 'tmux'`: it ends that row's hidden tmux session with a best-effort
  `tmux -L <AGENT_CONSOLE_TMUX_SOCKET or agent-console> kill-session -t <name>` (`sessions/tmux-row-conversion.ts`; every
  failure is ignored), tells the plugin that the conversation has history, fails a queued message whose delivery was
  in progress, and flips the row to structured and asleep (`BoundSessionsRepo.convertTmuxRow`: the placeholder name, no raw
  log, no pid, `idle_suspended_at` unless a manual or pressure marker already keeps it asleep). Identity, title and recency
  do not change; the next message resumes the same native conversation. A converted row that never learned its native id
  (`pending:`) ends on its next use. Each conversion is logged at info.
- Service: `sessions/structured/structured-session-service.ts` owns the loaded transport sessions, the
  active turn, the steer-versus-new-turn rule (human text steers a running turn, otherwise starts one),
  exactly-once turn terminals, interrupts and the provider process environment. It reports through
  callbacks; `SessionManager` keeps the journal, recency, run state, recovery and realtime events.
  `StructuredRunMonitor` feeds RunRecovery from turn events and attaches the Codex rollout monitor once
  the transcript path is indexed.
- Plugin: `providers/transport/types.ts` is the contract (capabilities, events, instance, session).
  `providers/transport/codex/` implements it with one shared `codex app-server` child per Console (stdio
  JSON-RPC) and one thread per conversation, routed by thread id. Plugin events carry no message bodies:
  durable history is still the Codex rollout, so transcript parsing, search and live-output
  normalization are unchanged, and replayed events never move recency.
- Session host relay: a provider process never belongs to the backend. `providers/transport/session-host.ts` is a small
  standalone Node program, started detached by `providers/transport/line-transport.ts`, that owns the provider child and
  its stdio and serves a Unix socket speaking the same newline JSON. A backend restart or crash therefore does not
  end a provider process mid-turn (the service keeps `KillMode=process`): the next backend reads the host's record
  file under `<runtime>/structured/hosts/`, reconnects when the recorded host and command line still match and takes
  over as the single client. Codex uses one host for its shared app-server (`codex`), Claude one host per conversation
  (`claude-<sessionId>`). The host starts the child in its own process group through `setpriv --pdeathsig TERM --`
  relative to the host, so group signals reach the native server behind the npm `codex` launcher and a dying host
  takes its child with it. A recorded child left without its host is ended through its recorded group before a new
  host starts; every signal is gated on pid, start ticks and boot id. A bounded output buffer lets a client that kept a
  cursor replay what it missed; a backend that connects fresh asks for live output only and reads the rest from the
  provider's own record. The host also ends what is left in the child's process group once the child exits, and a host that
  runs but answers slowly is left alone and not replaced. See `docs/structured-cutover.md`, "Session host relay".
- Claude plugin: `providers/transport/claude/` drives `claude --output-format stream-json --input-format stream-json`
  directly (no SDK package) and declares `processModel: 'per-session'`: one process per conversation, behind its own
  host, started lazily. The Console mints the session id (`--session-id`, later `--resume <id>`), so there is no
  pending adoption. Each launch passes the permission flags, the model and effort of the profile, and the
  conversation's coordination MCP config, and the process environment carries `AGENT_COORD_RUNTIME`,
  `AGENT_CONSOLE_CONFIG` and its own `AGENT_CONSOLE_SESSION_ID`, so the hooks already installed in the user's Claude
  settings register unchanged. A grant's authority text goes through the `initialize` request, which keeps it out of
  `ps`. Human text is sent with `origin: human`; a message sent mid-turn folds into the running turn at the next tool
  boundary (it does not shorten a running shell command); Stop is an `interrupt` control request and the process
  survives it; a profile change is applied live (`set_model`, effort) with no restart; images are base64 blocks in front of
  the text, fitted to the API limits first (see Images below). A launch that shows no `SessionStart` hook (the CLI came up in bare mode) or runs on an API key is refused.
  Durable history is the CLI's own transcript under `~/.claude/projects`, so transcript parsing, search and recency are
  unchanged. The one-writer rule (the CLI does not refuse two processes on one transcript) is enforced by the plugin
  through its table of open sessions, the host record and the CLI's live-process registry `~/.claude/sessions/<pid>.json`. Findings from the real-CLI proof
  are in `docs/structured-cutover.md`, "Verification evidence".
- Grok plugin: `providers/transport/grok/` drives `grok agent --always-approve [--model M] [--reasoning-effort E] stdio`
  over ACP (the Agent Client Protocol, JSON-RPC on stdio) and, like Claude, declares `processModel: 'per-session'`: one
  process per conversation behind its own session host (`grok-<conversationId>`), in the project directory. Grok allocates
  the session id at `session/new`; the Console stores it on the row like any native id. A turn is a `session/prompt` request
  that stays open until Grok answers with a stop reason; `session/update` notifications stream the reply, the reasoning and
  the tool calls, and Grok's own `turn_completed` event ends a turn Grok started by itself (a finished background task waking
  it). A profile change is `session/set_config_option` (model, then effort) sent before the next prompt, with no restart;
  Stop is `session/cancel`, and a turn Grok never answers after a cancel is closed locally after ten seconds. A message sent
  while a turn runs waits in the Console's queue (Grok would only queue it behind the turn, not fold it in). Images are ACP
  image blocks. A permission request from the agent (rare under `--always-approve`) is declined. A conversation's coordination
  MCP server rides on `session/new`. After a backend restart `resume` first looks for the conversation's process behind its
  host (attach-only, same argv), runs a repeated `initialize` and asks Grok's session roster (`_x.ai/sessions/list`) whether
  it is in the middle of a turn, which becomes an adopted turn the Console does not count as new activity; only when no
  process is left does it start a new one and run `session/load`, which streams the saved history back (dropped) and restores
  the saved model. The turn in flight is recorded in plugin meta (`grok-turn:<conversationId>`) so a survivor whose roster
  cannot be read is still taken for busy. Durable history is Grok's own session folder,
  `~/.grok/sessions/<URL-encoded directory>/<session id>/` (`summary.json` and `updates.jsonl`); `providers/grok-provider.ts`
  lists the conversations saved for a project from it (matching the directory in `summary.json`, so past Grok chats can be
  reopened) and `providers/transcripts/grok.ts` joins the streamed chunks into messages. The model profiles come from the
  catalog's `grok` section, and a Grok session's profile is stored in `bound_sessions.grok_profile` (schema 21).
  The ACP pieces Grok shares with Vibe live in `providers/transport/acp/`.
- Vibe plugin: `providers/transport/vibe/` drives `vibe-acp` (no flags) over the same ACP core and declares
  `processModel: 'per-session'`: one process per conversation behind its own session host (`vibe-<conversationId>`).
  Vibe allocates the session id at `session/new`. Model and thinking are `session/set_config_option` (`model`,
  `thinking`), applied on the next turn with no restart. Stop is `session/cancel`, closed locally after ten seconds
  when no answer comes. A reply mid-turn cancels the running turn and is sent as the next one. Images are ACP image
  blocks before the text. A permission request is declined. Mode is set to `auto-approve` on a new session and on a
  fresh `session/load`. An untrusted workspace (Vibe then skips that project's `AGENTS.md`) is trusted with
  `_trust/decision` `trust_cwd` and the model is set again so the instructions rebuild; an attach to a process that
  is already running does not do this. Mistral API-key variables are stripped from the child so billing stays on the
  OS keyring. After a backend restart the surviving process is adopted by the JSON-RPC id recorded in
  `vibe-turn:<conversationId>` when the prompt was written; the late answer to that id ends the turn. If the saved
  store shows that turn already finished (the `CURRENT` generation or snapshot sequence advanced and the new manifest
  is quiescent), the adopted turn is completed from the store. A store that cannot say is left adopted. When the
  process is gone, `resume` starts `vibe-acp` and runs `session/load`, and the replayed history is dropped. Durable
  history is `~/.vibe/logs/session/unified/<session id>/` (`VIBE_HOME` overrides `~/.vibe`); `providers/vibe-provider.ts`
  lists a project's sessions from `meta.json`, and `providers/transcripts/vibe.ts` joins the chunks. An unknown store
  format is skipped. The model profiles come from the catalog's optional `vibe` block (router vendor `mistral`), and a
  Vibe session's profile is stored in `bound_sessions.vibe_profile` (schema 24). Vibe has no session-start hook, so the
  Console registers the conversation itself (`coordination/console-registration.ts`) and prepends that context to the
  first prompt. A rate limit (`-31001`) ends the turn with a plain notice and records `wo quota limited --subscription mistral_vibe`.
- Approvals: threads start with approval policy `never` and a full-access sandbox.
  A server request that still arrives (command, file or permission approval, MCP form) is declined and
  recorded as a status event. There is no approval UI.
- Questions: a question the agent asks the person is kept instead of declined. The service stores it under the session's
  `structuredRequestsKey` meta record, the bound-sessions repository projects it onto the row as `pendingRequests`, the
  conversation pane shows it as a card (`PendingQuestionCard`) with the options and a typed answer, and
  `POST /api/sessions/:id/requests/:requestId` answers it exactly once (a second answer, or an answer to a question the
  provider withdrew, is a 404). A Claude `AskUserQuestion` and a Codex `item/tool/requestUserInput` are live: the provider
  waits for the answer, so a new question also goes out through the grant push channel. A Codex question the model asks in a
  message (`request_user_input_async`, the only form `codex-cli` 0.164.0 offers in the default mode) arrives as an
  `agentMessage` item with `delivery: 'async'` and `questions` of `{ title, options? }`, and the turn stays open while the model
  polls. It becomes a message-mode card: nothing waits on the answer, so the answer is sent as an ordinary message that steers
  the open turn. A question the Console cannot show raises a warning notice. The stored list is deleted at boot and comes back
  through re-adoption (held server-request questions only: a Codex message-mode card from an async question is not shown again
  after a restart, though its text stays in the conversation and a typed answer reaches the model).
  Approvals, `ExitPlanMode` and MCP elicitations are declined.
- Identity: the thread id is known at `thread/start`, so the binding is written with it at once and the
  pending alias is adopted immediately. A shared process cannot carry a per-session
  `AGENT_CONSOLE_SESSION_ID`; hooks and the coordination MCP identify the thread by its id and
  `CoordinationService.register` resolves the Console session from the structured binding. With
  coordination on, the Console gives the process `AGENT_COORD_RUNTIME` and `AGENT_CONSOLE_CONFIG`;
  `structuredSessions.<provider>.env` overrides them. The coordination MCP entry in
  `~/.codex/config.toml` names the live Console's runtime and helper, so with coordination on the plugin
  appends `-c mcp_servers.agent_console_coordination.*` overrides that point at this Console (with no session id) to
  the app-server argv; an isolated Console needs no extra configuration
  (`scripts/prove-structured-codex.mjs` checks it).
- Coordination liveness: an assignment is alive while a restorable bound row exists
  for its thread, not while the shared process runs. A backend restart or an app-server exit therefore does
  not disconnect the assignment or page its supervisor, because the thread loads on demand.
- Granted restart: on a structured row it refuses while a turn runs ("Restart is waiting for the current
  work to finish.") and never interrupts a human's turn. Otherwise it unloads the thread and starts the
  restart prompt on a fresh load epoch.
- Per-session plugins (Claude): `capabilities.processModel: 'per-session'` makes the service start one process per
  Console session. Idle sleep, manual suspend and memory pressure end that process and mark the row; the next message
  resumes the same native conversation. The conversation's process gets its own environment (`AGENT_CONSOLE_SESSION_ID`),
  coordination MCP identity and, for a granted launch, the grant authority text. Rows on a shared process are not
  suspended under memory pressure.
- Images: the existing attachment flow feeds both providers (Codex `localImage`, Claude base64 image blocks), and only files
  directly in the image store are accepted. Codex reads the file itself. For Claude, `claude/image-fit.ts` (sharp) sends an
  image that already fits unchanged and otherwise scales it to a 1568 px long edge and about 3.4 MB, because the API rejects an
  image above 5 MB (PNG stays PNG, everything else becomes JPEG). The route's "inspect the attached files" line is dropped from
  the text sent to a transport that attaches images natively, so the model does not open the stored file a second time; the
  image rows stay in the message.
- Limits: pressure suspension skips rows on a shared process (it cannot be suspended per thread);
  the recovery and launch memory floors still apply. Streamed assistant text is not shipped: display is driven by
  the provider transcript.
- Restart behavior: with the relay (the production path) provider processes outlive a backend restart or crash. A plain stdio
  child (tests, or a plugin given no factory) ends with the backend. A new backend finds a surviving process again and does not
  declare its turn lost. At the first reconcile pass the manager adopts every awake per-session row and every shared-process
  (Codex) row still marked working through the plugin's `reattach`, which never starts a process. The same lookup runs before loss
  handling on any path that loads a working row, so a status poll that comes before the first pass cannot write the loss line.
  Claude learns what the process is doing from the reply to a repeated `initialize` (`session_state`). Codex learns it from
  `thread/resume`, the thread's recent turns and the host's replay buffer, and a held question is answered by id over the same
  relayed stdin. An adopted turn keeps the row working without moving recency, Stop reaches it, and its terminal ends it once. A
  row with no survivor stays unloaded: it never reads as working, a scheduled recovery or half-restored row re-arms at boot, and
  the conversation resumes on its next use. A survivor whose host or process is running but did not answer in time is
  "busy": the row is left as it is and asked again on each load for up to 10 minutes, then its turn is settled as lost with
  "did not answer for 10 minutes"; Stop on such a row clears working and writes "Stop could not reach the agent process,
  which may still be running". A provider that keeps timing out on ordinary opens (its handshake, or a silent session host)
  is reported busy for 5 minutes, counted by the plugin across backend-side retries, then ended together with its session
  host and replaced in the same call (Codex starts a fresh app-server; Claude relaunches in the open's own mode, `--resume`
  when a transcript exists); an attach-only reattach never ends a busy process. Three request timeouts in a row on a live
  Codex connection close that connection without ending the app-server (the loaded rows see a connection loss and are
  picked up on their next load), so the next open runs the bounded check. The real-CLI
  proofs (step k2) restart the backend during a running turn for both providers. Codex adoption reads the thread's live background terminals (`thread/backgroundTerminals/list`, item id to
  process id), so Stop on an adopted turn also ends a command that started before the restart. On codex-cli 0.164.0 the item
  listing never shows a running command, so the terminals are the only source (see
  `docs/research/codex-app-server-2026-10-26/background-terminals-probe.md`).
- Orphan hosts: at the first pass the manager also ends the session host and launch record of every per-session conversation
  that has no restorable structured row. Release and idle sleep end the host of a conversation that is not loaded. A released or
  forgotten conversation therefore cannot leave a Claude process running.

## Provider run failures and bounded recovery

Live input rejection never automatically releases, restarts, rebinds, or replays input
to a provider session. The browser removes the provisional user bubble, shows the
error, and preserves the local draft and existing binding. The composer loads a saved
draft when it mounts and has a separate component identity per conversation, so
navigating away and back does not overwrite the draft with initial empty state.
Any restart requires an
explicit user action. A rejection names its reason (a running turn on a provider that cannot steer, a slash command, an image
the transport cannot take, a session that cannot be loaded) and says that nothing was sent.

The desktop input's saved height is capped at 60% of the window height. Its
44-pixel touch resize handle and visible Smaller button let the user reduce it;
Smaller resets the input to 96 pixels without changing its draft.

The Codex app-server is started with `check_for_update_on_startup=false`, so a host software-update menu never
interrupts a conversation; Codex updates remain a host maintenance action.

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
rechecks the latest provider turn, canonical binding, enabled project/provider, available memory and that the
conversation is loaded with no turn running (it reloads a conversation whose process ended). Manual and memory-pressure
pauses, a queued model change and queued human input stop recovery. It never starts a second writer. The
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

Recovery and automatic notices go through the transport as a new turn, only on a loaded conversation with no turn
running, after the cancellation and ownership checks. The transport reports whether anything was written: a refusal
before writing defers the attempt, a refusal that would fail again stops it with its reason, and an uncertain outcome is
never replayed. These guards also apply to assignment continuation. The backend owns explicit unattended permission, supervisor relationships and silence/result signals in SQLite metadata; see [the coordination contract](agent-coordination.md#explicit-unattended-work). Turn lifecycle status, continuation permission and peer-message wake remain independent. Human Stop, cancellation and manual pause disable peer wake until an accepted human conversation turn; agent waiting updates do not. After handling its inbox, an unattended assignment continues authorized work in that same turn unless recovery is blocked or stalled. A waiting assignment returns to waiting. Inbox turns preserve pending human decisions and neither spend nor reset the continuation budget. Worker facts never grant permission or reset a spent continuation budget.

A granted restart is an explicit one-turn action, independent of automatic recovery.
It resolves either a session ID or a target assignment ID to the original binding,
checks grant and pause guards, then resumes the native conversation with an opening
prompt. A finished assignment or waiting continuation does not block that turn.
It preserves continuation permission, pending human decisions and the existing
conversation. Released bindings and manual pauses remain protected.


An unexpected provider exit with unattended work remaining uses this same durable
backoff. Reconciliation and queued peer messages cannot bypass it. The backend
resumes the original conversation, preserves its assignment and inbox, and submits
the recovery notice once the conversation is loaded again. Three failed relaunches stop recovery.
Intentional automatic idle sleep has a persisted marker and a cleared PID. Passive
status polling does not restore it; intentional user and peer wake paths remain available;
manual suspension, finished assignments and resource limits stay respected.
Failure transitions advance the session revision timestamp so browser polls and
events accept the cleared status; they do not advance conversation recency.

### Durable ordinary idle sleep and pending identity

Ordinary idle sleep persists `idleSuspendedAt` on the bound session, independently of manual
and pressure suspension. All sleep reasons are visible in Work without changing the response-age
dot. Status polling and passive ensure calls leave an idle sleeper stopped, including calls from
older browser builds. Selection, human input, queued messages, model changes and eligible peer
messages may restore the same conversation. Successful restoration or release clears the idle
marker. Ordinary idle sleepers remain eligible for the existing nine-day Work release.
Finished assignments whose provider process has ended retain their inbox and bypass that release.

A bind learns the native identity of a new conversation from the provider at once, so a row is `pending:` only while its
bind runs; a row left `pending:` by a crash (or by the startup conversion of a tmux row) has no native conversation to
resume and ends on its next use. A coordination registration of a launched session still indexes its conversation and
applies the launcher's title (`SessionManager.adoptRegisteredSession`).

Wiki replacements are revisioned with `supersededBy` in wiki schema 3. Current matching pages rank ahead of superseded matches, and readers retain access to historical revisions and replacement links. New P1 messages and supervisor handoffs require an explicit sender-chosen `wakeReason`; validation adds no classifier or automatic urgency. Expired pending wake reasons are purged with message bodies.
