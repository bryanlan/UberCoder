# File Index
## Top-Level Layout
- `apps/` - JavaScript/TypeScript source for the Fastify server and React PWA.
- `config/` - configuration files.
- `docs/` - repository navigation, architecture, and test guidance.
- `packages/` - JavaScript/TypeScript source.
- `scripts/` - operator or development scripts.
- `test-results/` - ignored/generated Playwright evidence; rerun e2e before treating contents as
  current failures.

## Key Directories
- `apps/server/src/sessions/` - tmux session manager, screen parsing, and event-log live-output
  normalization.
- `apps/server/src/routes/` - Fastify API routes for auth, conversations, sessions, projects,
  settings, and live events.
- `apps/server/src/providers/` - Codex/Claude adapters and transcript normalization.
- `apps/server/test/` - Vitest coverage for server routes, providers, sessions, live output, and
  indexing behavior.
- `apps/web/src/features/conversation/` - client-side conversation data fetching, scroll control,
  transcript grouping/rendering, markdown rendering, and explorer panes.
- `apps/web/src/features/navigation/` - route selection and sidebar project derivation.
- `apps/web/src/features/realtime/` - EventSource connection and cache reducers for live session events.
- `apps/web/src/components/` - sidebar, conversation pane shell, and app-level UI components.
- `apps/web/e2e/` - Playwright browser coverage for settings and explicit project workflows.
- `config/` - runtime config templates and project/proxy/auth settings shape.
- `packages/` - shared TypeScript contracts.
- `scripts/` - operator or development scripts.
- `test-results/` - ignored/generated Playwright failure artifacts, not source architecture.

## Key Files

- `apps/server/src/engineering/summary.ts` and `summary-cli.ts` — read-only Console
  and wiki engineering metadata projection and standalone JSON CLI.
- `apps/server/src/engineering/export-redaction.ts` and `export_redaction.v1.json` -
  versioned credential-redaction rules for exported engineering metadata.
- `apps/server/test/engineering-summary.test.ts` — private SQLite, privacy,
  ownership, partial-source and real Git provenance checks.
- `docs/engineering-summary.md` — invocation, version 1 output and metric limits.

- `apps/server/src/grants/` — standing grants, human-message provenance, browser push,
  authenticated transport and durable launch/restart/owned-close actions.
- `apps/web/src/pages/GrantsPage.tsx` and `apps/web/public/grant-push-sw.js` — grants,
  decisions, uses, revoke and notification actions.
- `docs/agent-grants.md` — approved grant behavior and operational contract.
- `scripts/prove-agent-grants.mjs` and `scripts/prove-granted-launches.mjs` — opt-in
  real sessions for both creation flows, launch, recovery and inherited delegation.

- `README.md` - key tracked file or entrypoint for this repo.
- `AGENTS.md` - key tracked file or entrypoint for this repo.
- `package.json` - key tracked file or entrypoint for this repo.
- `requirements.txt` - key tracked file or entrypoint for this repo.
- `package-lock.json` - key tracked file or entrypoint for this repo.
- `playwright.config.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/routes/auth.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/routes/events.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/routes/projects.ts` - project tree reads and explicit refresh orchestration,
  including the opt-in eight-hour scan for recent unbound Codex conversations.
- `apps/server/src/routes/sessions.ts` - session input/screen/raw-output and durable Codex/Claude model-profile request/cancel routes, including
  first-turn pending Codex restart behavior and text+Enter selection-keystroke passthrough.
- `apps/server/src/model-profiles/service.ts` - the Console's only source of model choices: runs `wo profiles --json` and `wo route --task ... --json`, caches and validates the answers, builds Auto decisions (with the `provisional` flag and the labels the classifier returned) and the Medium fallback, routes with or without a provider (`route(undefined, ...)` is the provider-neutral Start), composes the text of a provisional re-route (`composeRerouteTask`), and turns a session row into its model and effort. `apps/server/src/routes/model-profiles.ts` serves `GET /api/model-profiles`.
- `apps/server/src/sessions/start-conversation.ts` - the provider-neutral Start (`POST /api/conversations/:projectSlug/start`): routes the first prompt with no provider named, creates the structured chat on the provider the router picked (or on `modelRouting.startDefault` with a warning when routing fails), and sends the prompt as the first turn. `apps/server/test/start-conversation.test.ts` covers it and Grok profile switching.
  `apps/server/test/model-profiles.test.ts`, `model-profile-routes.test.ts` and `auto-model-profile.test.ts` cover them; `apps/server/test/helpers/fake-wo.mjs` stands in for `wo`, and `apps/server/vitest.config.ts` points every server test at it.
- `apps/server/src/routes/settings.ts` - key tracked file or entrypoint for this repo.
- `apps/server/src/app.ts` - Fastify app composition, route registration, static serving, indexing startup, and session observation.
- `apps/server/src/config/schema.ts` and `service.ts` - config schema, merge behavior, runtime paths, provider/project settings, and security knobs.
- `apps/server/src/db/database.ts` - SQLite persistence boundary.
- `apps/server/src/indexing/indexing-service.ts` - provider/project conversation indexing and tree refresh.
- `apps/server/src/lib/conversation-summary.ts` - synthetic bound-conversation summaries and shared
  activity-date selection for tree placeholders and live search, excluding maintenance timestamps.
- `apps/server/src/lib/conversation-title.ts` - one write path for chosen titles (renames and generated
  titles): title override, search title, bound-session title and tree refresh event.
- `apps/server/src/titles/service.ts` - first-message GPT-6 Luna titles for chats created in the Console,
  with their durable `titleGeneration` state on the pending record.
- `apps/server/src/projects/project-service.ts` - explicit project config and project tree behavior.
- `apps/server/src/providers/codex-provider.ts`, `claude-provider.ts`, `grok-provider.ts` and `registry.ts` - vendor
  transcript discovery and launch command adapters (Grok has no launch command: it only runs structured); Codex pending adoption prefilters decoded JSONL
  user messages by their recorded text hash.
- `apps/server/src/providers/transcripts/claude.ts` - Claude JSONL parsing and active-branch
  selection for parent-linked sibling resume histories.
- `apps/server/src/providers/transcripts/grok.ts` - Grok session parsing: reads `summary.json` (directory, title, model) and joins the chunked `updates.jsonl` stream into messages. `apps/server/test/grok-provider.test.ts` covers listing and parsing.
- `apps/server/src/providers/transcripts/claude-run-state.ts` - incremental Claude turn lifecycle reading for Work-mode readiness.
- `apps/server/src/proxy/localhost-proxy.ts` - authenticated allowlisted localhost proxy.
- `apps/server/src/lib/provider-conversation-cache.ts` - transcript parse cache; small changing
  transcripts re-parse during active turns, while transcripts above the shared large-transcript
  threshold may serve a stale parse until the turn completes.
- `apps/server/src/security/auth-service.ts` and `password.ts` - cookie auth, Tailscale identity bootstrap, and password verification.
- `apps/server/src/routes/conversations.ts` - provider/live timeline merge, message pagination,
  metadata-only refreshes, transcript-backed live-message duplicate filtering, and bound-session
  metadata for the separate live-screen fetch path.
- `apps/server/src/routes/search.ts` - authenticated `/api/search/conversations` route and query
  validation.
- `apps/server/src/search/conversation-search.ts` - FTS query construction, sanitized message
  chunking, persisted/live result merge, recency buckets, ranking, hidden conversation filtering,
  live pending-session search, and transcript-backed live-output exclusions.
- `apps/server/src/indexing/indexing-service.ts` - provider conversation indexing plus missing
  search-index row backfill from cached conversation summaries on startup or metadata priming.
- `apps/server/src/sessions/pending-adoption.ts` - pending session adoption helper that can bind a
  live session to provider-readable conversations even before search indexing has caught up.
- `apps/server/src/providers/transcripts/base.ts` - shared transcript summaries; pending-match
  hashes and timestamps use provider-filtered visible user prompts, excluding injected context.
- `apps/server/test/pending-codex-context.test.ts` - original-URL recovery of completed Codex
  transcripts after midnight context injection, including invalidation of older cached summaries.
- `apps/server/src/db/schema.ts` and `apps/server/src/db/repos/` - SQLite schema and persistence
  methods for `conversation_search_fts`, conversation index rows, bound sessions, and search result mapping.
- `apps/server/src/providers/transcripts/codex.ts` - Codex JSONL parsing, visible transcript
  filtering for instruction/environment wrapper and internal memory-citation records, and
  event/response duplicate preference.
- `apps/server/src/sessions/session-manager.ts` - bound-session lifecycle, serialized restore, durable queued Codex/Claude model-profile execution, per-message Auto routing (`routeAutoBeforeTurn`),
  canonical conversation ownership, startup verification, recovery,
  bounded recent-conversation auto-tracking, working state, confirmed response timestamps, nine-day Work-mode release, event-log observation, text entry,
  literal selection-keystroke detection, and recency timestamps.
- `apps/server/src/sessions/input-queue.ts` - durable human-message delivery journals,
  Text Bypass draft provenance and request summaries projected on bound sessions.
- `apps/web/src/components/QueuedInputNotice.tsx` - queued-message display and cancellation;
  pending requests stay separate from submitted transcript turns.
- `apps/server/src/sessions/live-output/reader.ts` and `event-log-reader.ts` - event-log
  normalization for user-visible live output.
- `apps/server/src/sessions/last-user-input.ts` - asynchronous prompt restoration and session-local
  echo-detection cache, superseded by durable input appends.
- `apps/server/src/sessions/timeline-merge.ts` - server-owned merge and duplicate-suppression
  rules between durable provider transcript messages and temporary live event-log messages.
- `apps/server/src/sessions/transcript-watcher.ts` - transcript-file change detection that refreshes
  selected timelines when provider history catches up.
- `apps/server/src/sessions/session-screen.ts` - raw tmux screen parsing for session status/content,
  including complete Claude login URLs recovered from wrapped terminal hyperlinks.
- `apps/server/src/sessions/screen-heuristics.ts` - native readiness, input-selection and background-work indicators used by lifecycle guards.
- `apps/server/src/sessions/tmux-client.ts` - tmux command boundary, literal input/paste helpers,
  default pane capture, interrupts, session kill, and readable/writable session ownership options.
- `apps/web/src/features/conversation/useConversationData.ts` - conversation metadata query,
  paged timeline-message query, separate session-screen polling, live refresh behavior, and
  completed-tail polling while durable transcripts catch up after a bound session finishes.
- `apps/web/src/features/conversation/markdown.tsx`, `transcript-turns.tsx`, and
  `ExplorerPane.tsx` - extracted conversation rendering helpers, including pending Codex
  commentary-progress display.
- `apps/web/src/lib/model-profiles.ts` - the state of the server's model list in the web app (loading, error, ready) and the model a session's active profile means; the list is fetched in `App.tsx` from `/api/model-profiles`.
- `apps/web/src/components/ConversationPane.tsx` and `apps/web/src/components/ConversationPane.test.tsx` - live input, draft-preserving Alt+A/Alt+H/Alt+M/Alt+L Codex/Claude profile controls (A only on structured sessions), the Auto route line and fallback warning, the model-list error state, and
  conversation shell behavior for text bypass, raw-output/debug panels, live-screen panel gating,
  and the rule that server-derived terminal input is not promoted into transcript rows.
- `apps/web/src/features/navigation/route-selection.ts` and `sidebar-projects.ts` - route params,
  404 selection, sidebar ordering, Work-mode filtering of conversation children while retaining
  configured active projects, and separation of provider response status
  from genuine activity ordering.
- `apps/web/src/features/navigation/useSidebarWidth.ts` - browser-local desktop sidebar sizing,
  pointer and keyboard resizing, viewport bounds, and saved width restoration.
- `apps/web/src/features/navigation/useMobileViewport.ts` and `apps/web/src/lib/useMediaQuery.ts` -
  shared mobile layout selection and visual viewport height/panning while the keyboard is open.
- `apps/web/e2e/mobile-conversation.spec.ts` - mobile reading, chat switching, per-chat drafts,
  separate key controls and keyboard viewport/scroll checks with mocked provider input.
- `apps/web/e2e/sidebar.spec.ts` - browser coverage for sidebar resizing, width persistence,
  full-screen mobile navigation, and the empty conversation rename field.
- `apps/web/src/features/realtime/connection.ts`, `apply-session-event.ts`, and `reducers.ts` -
  frontend realtime connection and query-cache updates.
- `apps/web/src/components/Sidebar.tsx` and `ConversationPane.tsx` - main conversation navigation
  and display shell surfaces. `ConversationPane.tsx` also renders the dismissible warning when a
  conversation transcript is large enough that active-turn updates may lag behind provider writes.
- `packages/shared/src/index.ts` - shared API contracts, including
  `LARGE_TRANSCRIPT_STALE_THRESHOLD_BYTES`, which must stay aligned between the server cache,
  conversation route response, and web warning.
- `apps/web/src/pages/SettingsPage.tsx` - explicit project/config management UI.
- `apps/web/src/lib/api.ts` - web API client boundary and bounded CSRF recovery.
- `apps/web/src/lib/query-client.ts` - authentication cache shared by the API client and React.
- `apps/web/e2e/settings.spec.ts` - browser coverage for settings, explicit project additions, and legacy project migration behavior.
- `scripts/generate-password-hash.mjs` - operator helper for auth password hashes.
- `scripts/smoke-codex-adoption.mjs` - opt-in host smoke check for real Codex/tmux session adoption.
- `scripts/worktree-sweep.mjs` - inventory and guarded cleanup of agent-created Git worktrees and landed or expired snapshot branches across Console repositories; reads Console SQLite read-only. Contract: `docs/worktree-lifecycle.md`; fixtures in `apps/server/test/worktree-sweep.test.ts`.
- `scripts/verify-live-console.mjs` - opt-in visible-browser check for live Agent Console UX
  against a running backend and Chrome CDP endpoint.
- `apps/server/test/auth.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/command-and-proxy.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/config.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/conversation-routes.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/conversations.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/database.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/e2e/server.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/fixtures/claude/history.jsonl` - key tracked file or entrypoint for this repo.
- `apps/server/test/fixtures/claude/projects/-tmp-demo-project-/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl` - key tracked file or entrypoint for this repo.
- `apps/server/test/fixtures/codex/sessions/2026/02/14/rollout-11111111-2222-4333-8444-555555555555.jsonl` - key tracked file or entrypoint for this repo.
- `apps/server/test/indexing-service.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/indexing.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/live-output.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/projects-routes.test.ts` - key tracked file or entrypoint for this repo.
- `apps/server/test/projects.test.ts` - key tracked file or entrypoint for this repo.

Test and verification anchors:
- `apps/server/test/auth.test.ts` - representative test or verification file.
- `apps/server/test/command-and-proxy.test.ts` - representative test or verification file.
- `apps/server/test/config.test.ts` - representative test or verification file.
- `apps/server/test/conversation-routes.test.ts` - representative test or verification file.
- `apps/server/test/conversations.test.ts` - representative test or verification file.
- `apps/server/test/database.test.ts` - representative test or verification file.
- `apps/server/test/indexing-service.test.ts` - representative test or verification file.
- `apps/server/test/indexing.test.ts` - representative test or verification file.
- `apps/server/test/live-output.test.ts` - representative test or verification file.
- `apps/server/test/search.test.ts` - conversation search, live-session search, recency/ranking,
  hidden-conversation filtering, and cached-index backfill coverage.
- `apps/server/test/projects-routes.test.ts` - representative test or verification file.
- `apps/server/test/projects.test.ts` - representative test or verification file.
- `apps/server/test/providers.test.ts` - representative test or verification file.
- `apps/server/test/session-lifecycle.test.ts`, `session-recency.test.ts`,
  `session-keystrokes.test.ts`, and `session-keystrokes-submit.test.ts` - split session-manager
  behavior coverage.
- `apps/server/test/session-routes.test.ts` - representative test or verification file.
- `apps/server/test/session-screen.test.ts` - representative test or verification file.
- `apps/server/test/settings.test.ts` - representative test or verification file.

## Change Hotspots
- Clipboard image input spans `apps/server/src/images/{store,prompt,routes}.ts`,
  the session keys route, session screen parsing, public timeline and user-input
  event normalization, `apps/web/src/features/conversation/useClipboardImages.ts`,
  `ConversationPane.tsx`, transcript thumbnail rendering and shared image contracts.
  Coverage lives in `apps/server/test/image-input.test.ts`, the composer tests and
  `apps/web/e2e/clipboard-images.spec.ts`.
- Runtime entrypoint changes should be reviewed with adjacent service, route, CLI, or frontend modules and the tests that exercise them.
- Manifest or dependency changes should be reviewed with setup docs and `docs/agent_docs/running_tests.md`.
- Documentation-only changes should stay scoped to managed docs unless source-of-truth operator docs are stale.
- Session recency, restore, recovery, or idle-completion changes should review
  `apps/server/src/sessions/session-manager.ts`, `apps/server/test/session-recency.test.ts`,
  `apps/server/test/session-lifecycle.test.ts`,
  `apps/web/src/components/Sidebar.tsx`, and any API response shape consumed by the sidebar.
- Top-left refresh auto-tracking changes should review `apps/server/src/routes/projects.ts`,
  `apps/server/src/sessions/session-manager.ts`, both provider transcript adapters,
  `apps/web/src/App.tsx`, `apps/web/src/features/navigation/sidebar-projects.ts`, and their focused
  route, lifecycle, provider, database, and sidebar tests together.
- Pending Codex first-turn input or live keystroke changes should review
  `apps/server/src/routes/sessions.ts`, `apps/server/src/sessions/session-manager.ts`,
  `apps/server/test/session-routes.test.ts`, `apps/server/test/session-pending-first-turn.test.ts`,
  and `apps/server/test/session-keystrokes-submit.test.ts`
  together so prompt restarts and literal selection passthrough stay distinct.
- Live output, history pagination, duplicate filtering, or text latency changes should review
  `apps/server/src/routes/conversations.ts`, `apps/server/src/sessions/timeline-merge.ts`,
  `apps/server/src/sessions/live-output/`, `apps/server/src/sessions/transcript-watcher.ts`,
  `apps/server/src/lib/provider-conversation-cache.ts`, `packages/shared/src/index.ts`,
  `apps/server/src/providers/transcripts/codex.ts`,
  `apps/server/test/timeline-merge.test.ts`, `apps/server/test/transcript-watcher.test.ts`,
  `apps/server/test/live-output.test.ts`,
  `apps/server/test/conversation-routes.test.ts`,
  `apps/server/test/provider-conversation-cache.test.ts`,
  `apps/web/src/features/conversation/useConversationData.ts`,
  `apps/web/src/features/realtime/reducers.ts`, `apps/web/src/features/conversation/transcript-turns.tsx`,
  and `apps/web/src/components/ConversationPane.tsx`.
- For repeated or duplicated transcript bubbles, inspect source ownership in this order:
  provider transcript parser, live-output reader, server timeline merge, realtime cache reducer, then
  web transcript rendering. Avoid starting in `ConversationPane.tsx` unless the server timeline
  payload is already correct.
- Raw terminal/screen rendering changes should review `apps/server/src/routes/sessions.ts`,
  `apps/server/src/sessions/session-screen.ts`, `apps/server/src/sessions/live-output/reader.ts`,
  `apps/web/src/components/ConversationPane.tsx`,
  `apps/web/src/features/realtime/apply-session-event.ts`, `apps/web/src/lib/api.ts`, and
  `apps/web/src/components/ConversationPane.test.tsx`. Raw screen and debug tails are inspection
  surfaces; event-log/provided transcript messages are the conversation surface.
- Pending Codex progress and stale-bound-timeline polling changes should review
  `apps/server/src/providers/transcripts/codex.ts`, `apps/server/test/providers.test.ts`,
  `apps/web/src/features/conversation/useConversationData.ts`,
  `apps/web/src/features/conversation/transcript-turns.tsx`, and their focused tests together.
- Conversation search, FTS indexing, live-session search, hidden-conversation filtering, or cached
  search backfill changes should review `apps/server/src/routes/search.ts`,
  `apps/server/src/search/conversation-search.ts`, `apps/server/src/indexing/indexing-service.ts`,
  `apps/server/src/db/database.ts`, and `apps/server/test/search.test.ts`.
- Provider-readable unindexed conversation binding changes should review
  `apps/server/src/routes/conversations.ts`, `apps/server/src/indexing/indexing-service.ts`,
  provider transcript adapters, `apps/server/src/sessions/pending-adoption.ts`, and
  `apps/server/test/conversation-routes.test.ts`.
- Settings/project-discovery changes should review `apps/server/src/config/service.ts`,
  `apps/server/src/projects/project-service.ts`, `apps/server/src/routes/settings.ts`,
  `apps/web/src/pages/SettingsPage.tsx`, and the Playwright settings e2e tests together.
- When recent commits rename, split, or demote modules, verify whether the old file still owns behavior or only delegates to newer modules.

## Deferred or Unclear Areas
- Playwright e2e artifacts under `test-results/` are generated evidence, not source architecture.
- Host-level Codex smoke validation requires a running backend plus real Codex/tmux access and is intentionally opt-in.

## Assignment coordination

- `apps/server/src/workers/` — loaded-worker roster/evidence, shared-runtime summaries, private usage accounting and authenticated routes.
- `apps/web/src/components/WorkerPanel.tsx` — global right panel, exact conversation links, three summary rows and visibility/cadence controls.
- `packages/shared/src/workers.ts` — worker-panel and native usage contracts.
- `docs/worker-panel.md` — operating and verification contract.

- `apps/server/src/coordination/{schema,service,git,transport}.ts` — assignment activity, peer inboxes, read-only repository discovery, private agent RPC and authenticated browser views; migration 7 retires enforcement.
- `apps/server/src/coordination/inbox-policy.ts` and `broadcasts.ts` — sender priority, validity, indexed expiry and idempotency receipts; shared opt-in category board and fifteen-minute new-mail notices.
- `apps/server/src/coordination/continuation.ts` — explicit continuation permission, supervisor links, durable result signals and bounded idle recovery in SQLite metadata.
- `apps/server/src/coordination/tasks.ts` - supervised task records, revisioned state transitions
  and dispatch eligibility checks.
- `apps/server/src/coordination/wake.ts` — independent peer-inbox and unattended notices, stable control-envelope classification, durable human pause, configured native queue transport and message attempt contract; SessionManager owns wake/resume/sleep under its per-session command queue.
- `apps/server/src/coordination/{audit,audit-cli}.ts` — read-only grouped wake measurements, warning conditions and deterministic command for Waltium reporting.
- `apps/server/src/coordination/delivery-warnings.ts` — read-only failed-wake and overdue-supervisor-result conditions shared by audit and browser alerts.
- `apps/server/src/coordination/wake-alerts.ts` — durable browser-alert deduplication and bounded push retry through the existing subscription transport.
- `apps/server/src/coordination/telemetry.ts` and `scripts/coordination-telemetry.{mjs,d.mts}` — bounded private measurements, backend-independent failure recording and read-only audit summaries.
- `apps/server/src/db/repos/search-index.ts` and migration 15 in `db/schema.ts` — atomic FTS row ownership and indexed identity updates.
- `apps/server/src/db/read-query-worker.ts` — bounded read-only SQLite search worker;
  `apps/server/test/read-query-worker.test.ts` verifies responsiveness, lifecycle and queue bounds.
- `apps/server/test/live-output-incremental.test.ts` — append/tail parity, UTF-8 offsets,
  partial records, truncation, replacement and per-turn duplicate resets.
- `apps/server/src/providers/transcripts/peer-wake-usage.ts` — exact native coordination-turn usage and outcomes; streamed requests are counted once.
- `docs/peer-wake-audit.md` — measurement, warning, usage coverage and scheduler ownership contracts.
- `packages/shared/src/coordination.ts` — browser/server coordination contracts.
- `scripts/agent-coord.mjs` — provider lifecycle hooks, host MCP server and local operator client.
- `scripts/install-coordination.mjs` — reviewed pilot installation with private configuration backups.
- `apps/web/src/components/CoordinationPanel.tsx` — peer work and delivery status outside the user conversation.
- `docs/agent-coordination.md` — operating and deployment contract.

## Agent wiki

- `apps/server/src/wiki/{service,routes}.ts` — per-repository wiki storage, revisions, source provenance, access counts and authenticated browser routes.
- `apps/web/src/pages/WikiPage.tsx` — project wiki reader, search, history and editor.
- `scripts/agent-coord.mjs` — `agent_wiki` MCP tool and `wiki` CLI action, alongside coordination.
- `docs/agent-wiki.md` — page semantics, storage and pilot review.


Run recovery ownership (requires explicit unattended permission):
- `apps/server/src/providers/transcripts/codex-run-state.ts` — typed Codex lifecycle
  decoding and incremental bounded-memory observation.
- `apps/server/src/providers/transcripts/claude-run-state.ts` — Claude main-turn
  lifecycle and native API failure classification, shared with transcript display.
- `apps/server/src/sessions/run-recovery.ts` — persisted retry budget, turn cancellation, delays,
  reconciliation and uncertain-delivery stop rules.
- `apps/server/src/db/repos/bound-sessions.ts` and `db/schema.ts` — separately owned
  recovery state and schema version 8.
- `apps/web/src/components/RunFailureNotice.tsx`, `Sidebar.tsx` — visible stopped and
  recovery states, with an explicit Stop action.
- `apps/server/test/codex-run-state.test.ts`, `claude-run-state.test.ts`, `run-recovery.test.ts`, and
  `apps/web/e2e/run-recovery.spec.ts` — provider/transport/controller and desktop/mobile
  consumer regressions; browser fixtures never submit to a real provider.

## Structured provider lane

- `docs/structured-providers.md`: plan, plugin contract (a verbatim copy of `types.ts`), slice 1 boundaries and evidence;
  `docs/research/codex-app-server-2026-10-26/` holds the protocol brief and seam maps it was built from.
- `docs/structured-cutover.md`: the cutover plan and record (session host relay, Claude plugin, per-session processes, default
  transport and migration, re-adoption across restarts, questions and images, the flip procedure, proof evidence, review rounds).
  `docs/research/claude-headless-2026-10-26/` holds the Claude protocol brief and probe transcripts;
  `docs/research/cutover-2026-10-26/` holds the proof evidence JSON (the final runs are `claude-proof-2026-10-26T18-36-00Z`,
  `codex-proof-2026-10-26T18-37-31Z` and `migration-proof-2026-10-26T18-40-03Z`), `review-round-1.md` and `review-round-2.md`.
- `apps/server/src/providers/transport/{types,registry}.ts` — transport plugin contract (capabilities,
  events, instance, session) and the plugin registry.
- `apps/server/src/providers/transport/line-transport.ts` — line channels to provider processes:
  `StdioLineTransport` (a directly run child), `HostLineTransport` (a session host over a Unix socket) and
  `createLineTransportFactory` (reconnect to the recorded host or start one; ends a changed or orphaned one);
  `session-host.ts` — the standalone host program and the protocol pieces it shares (record, replay buffer,
  line splitter). Both are documented in `docs/structured-cutover.md`, "Session host relay".
- `apps/server/src/providers/transport/codex/` — the `codex app-server` plugin: `jsonrpc.ts` (JSON-RPC client
  over a `LineTransport`), `protocol.ts` (wire shapes), `app-server-instance.ts` (shared child process behind a
  session host, thread routing, environment, reconnect), `app-server-session.ts` (thread and turn
  lifecycle, event mapping, steer and interrupt, adoption of a turn or question a restart left running),
  `restart-state.ts` (what one backend writes down for the next: held questions with their JSON-RPC ids, the turn each
  thread runs, the cursor into the session host's replay buffer), `process-lifetime.ts` (process start-ticks identity and
  gated termination of a recorded process or group), `errors.ts`, `usage.ts`
  and `redact.ts` (ported from T3 Code; see `THIRD_PARTY_NOTICES.md`).
- `apps/server/src/providers/transport/claude/` — the headless Claude plugin (`claude --output-format stream-json`, one
  process per conversation behind its own session host): `claude-instance.ts` (argv, environment, per-session MCP config,
  launch and reattach, `probe`, the one-writer check), `claude-session.ts` (turns, steer and "send now", interrupt, requests,
  event mapping, unload and detach), `stream-json.ts` (frame client: control requests matched by id, server requests that must
  be answered), `protocol.ts` (wire types), `errors.ts` and `usage.ts` (result and rate-limit classification, ported from T3
  Code), `transcript.ts` (where the CLI keeps transcripts and live-process registry files), `image-fit.ts` (sharp: scales
  and re-encodes an image to what the API accepts before it becomes a base64 block), `event-channel.ts`, `index.ts`.
  `apps/server/src/images/prompt.ts` holds the matching prompt helpers (`withoutImageInstruction`, `imagePromptFiles`, which
  accepts only files directly in the image store).
- `apps/server/src/providers/transport/grok/` — the Grok plugin (`grok agent --always-approve stdio` over ACP, one process per
  conversation behind its own session host `grok-<conversationId>`): `grok-instance.ts` (argv, environment, per-session MCP list,
  launch, attach-only reattach, the session roster check, `session/load`, `probe`), `grok-session.ts` (turns, model switch with
  `session/set_config_option`, cancel, permission requests, background tasks, event mapping, detach), `protocol.ts` (small readers
  over the ACP JSON and the failure classifier), `index.ts`. It reuses the JSON-RPC client in `codex/jsonrpc.ts` (with the
  `"jsonrpc":"2.0"` field and `startRequest`/`onUnmatchedResponse` that ACP needs) and the event channel in `claude/`.
  `apps/server/test/structured-grok-plugin.test.ts` runs it against `apps/server/test/helpers/fake-grok.mjs`, an ACP agent stand-in
  (also behind a real session host for the restart cases).
- `apps/server/src/sessions/structured/pending-requests.ts` — the meta key and projection of the questions a structured
  session is waiting on (`pendingRequests` on the row; the service owns the list).
- `apps/web/src/components/PendingQuestionCard.tsx` — the question card in the conversation pane; its answer goes to
  `POST /api/sessions/:id/requests/:requestId`.
- `apps/server/src/sessions/tmux-client.ts`: also holds `assertTmuxSessionName`, which makes every
  `ShellTmuxClient` method refuse a `structured:` session name.
- `apps/server/src/sessions/structured/structured-session-service.ts` — loaded sessions, active turn,
  steer-versus-turn policy, exactly-once terminals, process environment, survivor adoption (`reattachSurvivors`), ending
  orphan hosts (`sweepOrphanHosts`, `endConversation`) and the question list; `structured-run-monitor.ts`
  — run state for RunRecovery from turn events plus the rollout monitor.
- `apps/server/src/sessions/structured/default-transport.ts` — the pure rule for the transport of a bind that names
  none (`structuredSessions.defaultTransport` for a provider whose lane is on); routes and `SessionManager` share it.
- `apps/server/src/sessions/session-manager.ts` — owns the structured seams (`session.transport`
  dispatch at bind, restore, input, wake, recovery, sleep, model profile, release) and the move of tmux
  conversations to the structured transport (`migrateTmuxRowToStructured`, `structuredMigrationReport`).
- `apps/server/test/structured-*.test.ts` — plugin (scripted fake and recorded wire transcripts), fake
  plugin contract, and session-manager seams (bind, input, lifecycle, recovery, wake, coordination,
  Codex end to end against a fake app-server, process environment). Helpers: `test/helpers/structured-fixtures.ts`,
  `structured-session-fixture.ts`, `codex-harness.ts`, `fake-app-server.mjs`, `replay-app-server.mjs`
  and `codex-fixtures/`.
- `apps/server/test/structured-session-host.test.ts`: the real host program against a scripted child
  (`test/helpers/fake-host-child.mjs`): record and socket, protocol, replay and gap, terminate order, detached
  survival, parent death, and the factory's reconnect, replacement and reaping.
- `apps/server/test/structured-claude-plugin.test.ts`: the Claude plugin against a scripted fake `claude`
  (`test/helpers/fake-claude.mjs`, `claude-harness.ts`): launch, turns, steer, interrupt, requests, failures, resume, the
  one-writer check, bare-mode and login refusals, image fitting for large images, the session host path.
  `apps/server/test/image-input.test.ts` also covers the prompt helpers (`imagePromptFiles` accepts only files directly in the
  image store and reads an envelope without its instruction line).
  `structured-codex-requests.test.ts`: Codex questions and images. `structured-session-requests.test.ts`: questions on the
  session row and the answer guard.
- `apps/server/test/structured-codex-process-lifetime.test.ts`: `/proc` start-ticks identity, the host launch,
  ending an app-server a host crash left behind (small node processes stand in for it), and the process-group
  signals for a launcher with a native child (`test/helpers/fake-launcher.mjs`).
- `apps/server/test/structured-session-restart.test.ts`: a turn cut by a backend restart, scheduled recovery
  and half-restored rows re-armed at boot, not-sent delivery, a turn id that runs again.
- `apps/server/test/structured-session-env.test.ts`: the provider process environment (coordination
  variables, configured `env`).
- `apps/server/test/structured-claude-reattach.test.ts`: the Claude plugin finding a process again in the middle of a turn (the
  turn is known at once, Stop reaches it, a message sent meanwhile gets its own turn), the background-task snapshot wait,
  frames of a turn the session did not send, an empty headless chat restarted under its id, resume beside a holder, and Stop
  dropping queued steers.
- `apps/server/test/structured-codex-restart.test.ts`: the Codex plugin across a backend restart (adopted and ended turns, held
  questions answered by id, requests read from the host replay, a replay that does not reach back far enough, the handler
  limit, questions asked in a message). `structured-session-codex-restart.test.ts`: the same through the real manager, the real
  Codex plugin and the real session host, against a scripted app-server.
- `apps/server/test/structured-session-survivors.test.ts`: the first reconcile pass adopting a per-session process that outlived
  a restart (fake plugin). `structured-session-adoption.test.ts`: the manager side of adopting a running turn on every load path,
  a turn that did not survive, Stop and queued steers, withdrawn and repeated questions, message-mode questions.
  `structured-session-orphans.test.ts`: ending a session host nobody adopted (release, sleep, the startup sweep).
- `apps/server/test/structured-session-per-session.test.ts`: per-session processes (environment, coordination
  identity, authority text, own pid, idle sleep, manual suspend, pressure, release, unexpected exit).
  `structured-session-migration.test.ts`: moving tmux conversations over and the dry run.
  `structured-session-default-transport.test.ts` and `structured-session-launches.test.ts`: the default transport for
  binds and granted launches.
- `apps/server/test/tmux-client-structured-guard.test.ts`: the tmux client refuses the `structured:` name in
  every method.
- `scripts/prove-structured-codex.mjs`: opt-in real-Codex proof of the whole lane through the HTTP API (16 steps, including
  a question, an image, a backend restart during a running turn and a large image); evidence JSON under
  `test-results/structured-codex-proof/`.
  `scripts/prove-structured-claude.mjs`: the same for a real structured Claude chat (14 steps: coordination hooks and MCP,
  steer, Stop, a question, an image, a live model switch, sleep and restore, backend restart while idle and during a running
  turn, a large image, release); evidence under `test-results/structured-claude-proof/`.
  `scripts/prove-structured-migration.mjs`: real tmux Codex and Claude chats moved to the structured transport by the
  reconcile pass (9 steps); evidence under `test-results/structured-migration-proof/`.
  `scripts/structured-proof-kit.mjs`: their shared harness (isolated backend, evidence, process scan and cleanup, PNG
  builders, event-log reader).
- Change hotspot: transport, service, plugin, session-manager seams, `coordination/service.ts` register and
  structured liveness, `sessions/tmux-client.ts`,
  `routes/{conversations,sessions,projects}.ts` and the web New Chat and `ConversationPane.tsx` controls
  move together; review them with `docs/structured-providers.md` and the structured tests.
