# Running Tests

Search-read and live-output performance regressions use temporary file-backed SQLite
databases and event logs. Run `npm run test -w @agent-console/server --
test/read-query-worker.test.ts test/live-output-incremental.test.ts
test/provider-conversation-cache.test.ts test/live-output.test.ts test/search.test.ts`.
The worker suite verifies that a costly SQLite query leaves the owning event loop free;
it does not query the live Console database.
## Primary Commands
- `npm test` - builds the shared package and runs the server Vitest suite.
- `npm run typecheck` - builds the shared package, then typechecks the server and web packages.
- `npm run build` - builds the shared package, server package, and web/PWA bundle.
- `npm run test:e2e` - builds the shared package and runs Playwright browser coverage on isolated
  backend/web servers.
- `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- search` -
  focused conversation search, live-session search, result ranking, hidden-conversation filtering,
  and cached-index backfill coverage.

## Targeted Test Patterns
- Automatic conversation titles: `npm run build -w @agent-console/shared && NODE_ENV=test npm run test -w @agent-console/server -- conversation-titles workers`.
  Private SQLite fixtures and fake model runners cover first-message generation, pending adoption,
  rename precedence, failure state and title response validation without provider calls.
- Engineering metadata export: `npm run build -w @agent-console/shared && NODE_ENV=test npm run test -w @agent-console/server -- engineering-summary export-redaction`.
  Private SQLite, Git and process fixtures cover source failures, provenance, configured project
  paths and credential redaction, including the source CLI, without opening live databases.
- Mobile layout: `NODE_ENV=test npm run test -w @agent-console/web -- ConversationPane sidebar-projects Sidebar`;
  browser checks: `NODE_ENV=test npm run test:e2e -- apps/web/e2e/mobile-conversation.spec.ts apps/web/e2e/input-rejection.spec.ts apps/web/e2e/sidebar.spec.ts`.
  Use free E2E ports. These fixtures mock provider input and simulate a visualViewport-only
  keyboard resize/pan without changing the layout viewport. They verify reading space,
  scroll position, per-chat drafts, key-only controls, filtering and accepted/queued/rejected
  sends. They do not establish physical iOS or Android keyboard behavior.
- Authentication/CSRF recovery: `npm run build -w @agent-console/shared`, then
  `NODE_ENV=test npm run test -w @agent-console/server -- auth` and
  `NODE_ENV=test npm run test -w @agent-console/web -- api`. Browser coverage:
  `NODE_ENV=test npm run test:e2e -- apps/web/e2e/csrf-*.spec.ts`. The auth
  cancellation case uses a private HTTP server and Chromium's real cookie jar
  to verify that an aborted older auth response cannot replace the renewed login.
- Grok and Start: `npm run build -w @agent-console/shared && NODE_ENV=test npm run test -w @agent-console/server -- structured-grok-plugin grok-provider start-conversation conversation-routes`. The plugin tests run the real plugin against `apps/server/test/helpers/fake-grok.mjs` (an ACP agent stand-in; some tests put it behind a real session host). No test starts the real `grok`; the one real-CLI run is a manual smoke test (a throwaway script that spawns `grok agent --always-approve stdio` in a scratch directory under `~/.cache`).
- Model profiles and Auto (including the second-prompt check and provisional re-routing): `npm run build -w @agent-console/shared && NODE_ENV=test npm run test -w @agent-console/server -- model-profiles model-profile-routes auto-model-profile model-profile-lifecycle` and `NODE_ENV=test npm run test -w @agent-console/web -- ConversationPane api`. Server tests run against `apps/server/test/helpers/fake-wo.mjs` (set through `apps/server/vitest.config.ts` as `AGENT_CONSOLE_WO_PATH`), never the real `wo`, so the Jev classifier is not called. Unit tests that need to steer the router pass a stub `WoRunner` to `ModelProfileService`.
- Server/session changes: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- session-lifecycle session-recency session-runtime session-screen-state`.
- Pending Codex first-turn or session keystroke changes: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- session-pending-first-turn session-keystrokes session-keystrokes-submit session-routes`.
- Durable queued chat submission: `NODE_ENV=test npm run test -w @agent-console/server -- session-input-queue session-routes session-interactive-input`. These fixtures use disposable SQLite databases and fake tmux transports to verify delayed repaint, database reopen, FIFO, matching drafts, cancellation before/during Enter, failed suspension, model-switch deferral, ownership and uncertain Enter. `NODE_ENV=test npm run test -w @agent-console/web -- ConversationPane` covers the queued Text Bypass handoff and sending-state controls. Browser coverage in `apps/web/e2e/input-rejection.spec.ts` verifies separate consecutive messages, pending-message display, refresh without resubmission, cancellation and preservation of genuine rejection behavior. Use isolated E2E ports; browser fixtures intercept provider input.
- Real active-turn delivery: after `npm run build`, run `node scripts/prove-active-input.mjs --run`.
  This opt-in proof uses installed Codex/Claude terminals and model calls in a private project,
  database, runtime and tmux server. It sends a human follow-up through authenticated `/keys`
  longer than 1,000 characters, including Unicode, while a real foreground tool runs. It
  checks the provider transcript for delivery within
  the original turn, exactly once, with the same native process and uninterrupted tool completion.
  Claude's native `absorbed_mid_turn` record is checked explicitly. It releases its own sessions
  and retains receipts, transcript copies and captures under the printed private directory in
  `~/.local/state/agent-console-diagnostics/`. `PROOF_PROVIDERS=claude` or `codex` selects one provider.
- Live output normalization: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- live-output`.
- Large event-log prompt restoration and cache races: `NODE_ENV=test npm run test -w @agent-console/server -- last-user-input session-output-restoration session-recency session-runtime`.
- Timeline merge, transcript catch-up, stale transcript cache, or duplicated bubble fixes: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- timeline-merge transcript-watcher conversation-routes provider-conversation-cache`.
- Raw screen, text-bypass, and conversation-pane transcript boundaries: `npm run test -w @agent-console/web -- ConversationPane`.
- Live session recovery and route handling: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- session-lifecycle session-routes tmux-health`.
- Pending Codex progress or stale bound timeline polling: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- providers && npm run test -w @agent-console/web -- useConversationData transcript-turns`.
- Conversation search or search-index backfill: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- search`.
  `search-row-ownership` also verifies unchanged row retention, current metadata when
  old chunks match, metadata-owner removal, duplicate chunks and transactional rollback.
  Benchmark append updates on a consistent private SQLite copy and compare complete
  search results with a full rewrite before activating search-write optimizations.
- Project/settings browser flow: `npm run test:e2e -- apps/web/e2e/settings.spec.ts` (builds the shared package first).
- Host-level Codex adoption: `npm run smoke:codex -- --project <project-slug> --password '<login-password>'` only when a backend is running and real Codex/tmux state is intentionally in scope.
- Visible live-console UX check: `npm run verify:live-console -- --base-url http://127.0.0.1:4317 --cdp-url http://127.0.0.1:9222 --password '<login-password>' --claude-url <conversation-route> --codex-url <conversation-route>` only when a backend and visible Chrome CDP endpoint are already running and the Claude/Codex live sessions are deliberately chosen. The verifier attaches to visible Chrome, sends `/model` plus model-selection input, and submits `Reply exactly ...` marker prompts through Text Bypass, so it changes real model, session, and transcript state. Omitted route defaults are Bryan-specific hard-coded pending sessions and should not be used unless that is the intended target.

- Worktree cleanup guards: `npm run build -w @agent-console/shared && NODE_ENV=test npm run test -w @agent-console/server -- worktree-sweep`. These fixtures create private repositories and SQLite state; do not run the host sweep in apply mode as a test.
- Shared wiki storage/search and API: `npm run build -w @agent-console/shared && NODE_ENV=test npm run test -w @agent-console/server -- wiki`. Fixtures use temporary Git repositories and SQLite files.

## Environment and Fixtures
- Install with `npm install`. If the shell sets `NODE_ENV=production`, npm skips the dev dependencies the build and tests need: install with `NODE_ENV=development npm install --include=dev`.
- Host runtime needs Node 22+, npm 10+, tmux 3.4+, Codex CLI, Claude Code, git, build-essential, and python3.
- Codex and Claude Code read the shared `AGENTS.md` directly.
- `node_modules/@agent-console/*` workspace links point back to local `apps/*` and `packages/*`; do not replace them with copied package directories.
- `playwright.config.ts` starts isolated local backend/web servers and does not reuse existing servers.

## Edge Cases
- Treat deploy, restore, migration, promotion, scheduler, and production data commands as operational workflows, not tests.
- Do not treat Playwright `test-results/` as source; it is regenerated by failing browser runs.
- The Codex smoke test mutates real host session/transcript state and should stay opt-in.
- Localhost proxy and auth tests are security-sensitive; avoid broadening allowlists as a test shortcut.

## Known Gaps
- Host-level Codex and Claude live smokes still require real tmux/provider CLIs and remain opt-in.

## Standing grants

Run server coverage with `NODE_ENV=test npm run test -w @agent-console/server --
agent-grants agent-grant-push agent-session-launches providers`.
Run browser components with `NODE_ENV=test npm run test -w @agent-console/web -- GrantsPage`.
These tests use private SQLite files and verify provenance, decisions, expiry, inheritance,
memory queues, restart persistence, custom launch settings and notification actions.

After `npm run build`, run `node scripts/prove-agent-grants.mjs --run` and
`node scripts/prove-granted-launches.mjs --run` sequentially.
They require real Codex/Claude authentication, tmux and an existing visible Chrome CDP endpoint on port 9222.
Each proof uses a private project, database, runtime and tmux socket, plus its own browser context.
The fixtures occupy port 14381 and close their own sessions and browser context afterwards.
They preserve the shared browser. Evidence remains under `/tmp/console-grants-proof-*`
or `/tmp/console-launch-proof-*`.
The launch proof injects a capacity failure envelope into its disposable provider transcript,
then attempts to verify native recovery, granted restart, a Claude helper and relayed scope under one grant.
Its peer requests omit priority and default to P3, whose bodies automatic polling excludes.
It can therefore stall while awaiting requested actions and does not currently establish those checks.
Use [the separate recovery proof](../../scripts/prove-session-recovery.mjs) for actual killed-process recovery,
subject to the peer-delivery limitation below.

## Assignment coordination

Audit and usage attribution: `NODE_ENV=test npm run test -w @agent-console/server -- peer-wake-audit peer-wake-usage peer-message-wake`.
These use disposable SQLite and transcript fixtures. They verify batching, rolling warnings,
fixture/backlog labels, missing usage, streamed-request deduplication and restoration markers.
The audit CLI can read live records without opening a writer or starting a provider.

Transport deadlines, abandoned versus finished offers, telemetry bounds, migration preservation
and indexed search writes: `NODE_ENV=test npm run test -w @agent-console/server -- coordination search-row-ownership peer-wake-audit --maxWorkers=2 --fileParallelism=false`. Follow-up wake
tests cover completed-turn/cooldown guards and the two-attempt ceiling across backend restart.
Performance verification uses a consistent private SQLite copy, checks durable-table and FTS
preservation, then runs reporter/largest-conversation writes alongside private HTTP probes.
Never instantiate `AppDatabase` on live state for a read-only measurement.

Peer wake and one-hour sleep: `NODE_ENV=test npm run test -w @agent-console/server -- peer-message-wake peer-wake-transport coordination session-lifecycle providers screen-heuristics`. This verifies cross-provider wake, authenticated peer delivery, per-message deduplication, restart ambiguity, rejected-input recovery, active-but-idle assignments, background-task indicators, drafts/approvals, original-conversation restore, pressure/manual suspension and history classification. Full-session Claude resume choices cover ownership changes, ambiguous confirmation across restart, pre-input shutdown/transient-read deferral at both ownership checks, idle expiry and historical-menu rejection. Queue transport tests use a rejecting fake PATH executable and a configured private executable to verify merged environment and project directory without contacting a provider. Restart tests verify that sessions retained by sleep guards reattach output monitoring. Verify repeated pipe attachment with real output markers on a private tmux server: each pass must retain the same native pipe writer and append all in-flight stream markers; explicitly closing a pipe must allow the next attachment to reopen it; a fake client's call count cannot verify native toggle semantics. Real-provider proofs must use disposable conversations and a private tmux server/runtime. Verify background indicators with actual native captures, and verify both sleep-to-restore delivery and already-running delivery.

Run `NODE_ENV=test npm run test -w @agent-console/server -- coordination`, `NODE_ENV=test npm run test -w @agent-console/web -- CoordinationPanel`, and `npm run typecheck`. React tests require `NODE_ENV=test` when invoked from the production Console environment. Coordination tests use temporary Git repositories and private sockets. The live cross-provider delivery proof is opt-in and must use disposable sessions, never existing user conversations. See `docs/agent-coordination.md`.


Unattended continuation: run `NODE_ENV=test npm run test -w @agent-console/server -- assignment-continuation peer-message-wake codex-run-state claude-run-state run-recovery claude-ready-lifecycle coordination` and the web `CoordinationPanel` tests. These cover permission defaults, waiting-for-human stops, supervisor graphs and handoffs, native child envelopes, silent lead recovery, bounded backoff across new facts and restart, lost-wake redrain, cancellation during text entry and exact native composer verification. Native task notifications must not become new human prompts or replace the parent turn. Provider-failure tests retain Claude retry counts through provisional completion and confirm genuine completion separately. All SQLite fixtures are disposable; no live provider is contacted. Real activation remains a separate authorized workflow and requires native behavior readback.


Real recovery proof (opt-in): after `npm run build`, run
`node scripts/prove-session-recovery.mjs --run`. It launches disposable real Codex
and Claude conversations through a private Console runtime, with its own SQLite
file, project and tmux server. Each provider receives a simulated native capacity
failure envelope and a real SIGKILL in separate conversations. The normal backend
must recover without another human input, deliver and acknowledge a queued peer
message, and clear the retry notice. The queued peer message omits priority and defaults to P3.
Automatic polling excludes its body, so the script can stall awaiting the response and acknowledgement.
It does not currently establish automatic peer delivery. The script faults only its own transcripts
and process identities, releases its sessions, and retains `proof.json` under its
printed temporary evidence directory. `PROOF_PROVIDERS=codex` or `claude` narrows
the run. Native hooks and MCP must point to that private runtime. Do not use a
running production database or provider session as a fixture.

Owned helper close and completed inbox retention (#82): `NODE_ENV=test npm run test -w @agent-console/server -- agent-session-launches session-owned-close agent-grants` and `NODE_ENV=test npm run test -w @agent-console/web -- GrantsPage`. These use disposable SQLite/native transcript fixtures and verify exact launcher ownership, current grant authority, history retention, low-memory cleanup, durable request deduplication, finished inbox retention across process exit, no eager restore or recovery after close, missing-history preservation and manual-pause protection.

After `npm run build`, opt into real-provider verification with
`node scripts/prove-session-close.mjs --run`. It uses a private project, SQLite
database, runtime and tmux socket. For each provider it explicitly closes an owned
helper. Native history must remain intact, its Work binding must end, and
reconciliation must not recover it. Finished inbox retention is covered separately
by the proof below. Pending helpers retry transcript adoption using their exact
registered native identity. Evidence remains under `/tmp/console-close-proof-*`.
`PROOF_PROVIDERS=codex` or `claude` limits the run; provider authentication and
tmux are required. The fixture releases only its own sessions during cleanup.

Finished-agent inboxes: after building, run
`PROOF_FINISHED_INBOX=1 node scripts/prove-peer-message-wake.mjs --run`.
The private Codex/Claude fixtures complete their marker action, finish their
assignment, resolve its inert drag reference and simulate automatic sleep in their
private bindings. A new inbox question must resume the native conversation and be
acknowledged while the assignment stays finished and the marker action stays
completed. The proof preserves waiting permission and a later manual Stop.
Candidate hooks are isolated from installed coordination hooks for both providers.
Run each provider separately with
`PROOF_PROVIDERS=codex` or `claude` on a memory-constrained host. This variant is
separate from `PROOF_UNATTENDED=1`.

Waiting-agent peer wake (#84): after `npm run build`, run
`node scripts/prove-peer-message-wake.mjs --run`. This opt-in proof uses real Codex
and Claude in a private project, database, runtime socket and tmux server. A sender
in a separate project messages an idle `waiting_for_input` recipient; each must
acknowledge and reply without a second human input, keep its pending human
decision and continuation permission, and respect a subsequent manual Stop.
`PROOF_PROVIDERS=codex` or `claude` narrows the run. The fixtures are released and
private `proof.json` evidence remains in the printed temporary directory.

Unattended peer wake and explicit restart (#89): the `peer-message-wake`,
`agent-session-launches` and `providers` suites cover same-turn unattended work
instructions for warm and idle-suspended Codex/Claude sessions, continuation
budget preservation, assignment-addressed restarts, finished/waiting assignments,
resume prompts and Stop/grant changes during restart. Existing wake fixtures
continue to cover drafts, approvals, memory pressure and uncertain input.
After building, `PROOF_UNATTENDED=1 node scripts/prove-peer-message-wake.mjs --run`
uses disposable real conversations to verify an assigned file write and result
handoff in the peer-wake turn, without a restart or second human input. It then
finishes that private assignment and verifies a granted restart addressed by
assignment ID starts another native turn in the same conversation. A message
reports facts only; the pending task comes from the original test prompt. Each
provider must also respect a later Stop. Evidence is retained under
`~/.local/state/agent-console-diagnostics/peer-wake-*`.

Wake refusal and supervisor alerts (#86): run `NODE_ENV=test npm run test -w
@agent-console/server -- peer-message-wake peer-wake-audit assignment-continuation
agent-session-launches agent-grant-push`. Disposable fixtures cover granted worker launches,
ordinary lead turn completion, result acknowledgement, full-inbox retention, memory pressure
between paste and Enter, same-owner staged submission across restart, work-permission changes,
human text appended during ownership checks, Stop/shutdown during the final screen capture,
uncertain Enter, and the two-response ceiling through a deferred follow-up. Unsent work
notices retain their original permission revision and attempt count when later results arrive.
Browser-push transport is mocked; tests verify payloads, deep links, no approval actions,
per-device retry after partial success, expired subscriptions, and deduplication across restart and message batches.
These tests do not establish production adoption or delivery to Bryan's browser.

Combined queued-input handoff: `NODE_ENV=test npm run test -w @agent-console/server --
peer-message-wake session-input-queue`. A queued human request supersedes an exact owned
unsent peer/work notice without submitting that notice. Fixtures cover mixed human text,
missing proof, changed binding, uncertain Enter, native typing/cancellation during final
checks, and an uncertain native clear across restart. Native editing is simulated; real
provider acceptance remains an opt-in operational check.


Coordination delivery under load: `NODE_ENV=test npm run test -w @agent-console/server -- coordination peer-message-wake transcript-responsiveness`. These cover partial composer repaints, Stop during a slow inbox poll, deferred duplicate polls without false outage/acknowledgement, mixed human/control input and CPU-heavy transcript discovery. For the private real-provider proof, `PROOF_METADATA_LOAD=/absolute/path/to/a/large/claude.jsonl` runs read-only metadata load alongside inbox traffic; the proof requires zero native hook failures. `PROOF_CLAUDE_EXECUTABLE=/absolute/path/to/installed/version` tests an older native binary using a private executable copy named claude and private hook settings, preserving production processes and configuration.

Cooperative priority trial: `NODE_ENV=test npm run test -w @agent-console/server -- message-priority coordination peer-message-wake assignment-continuation peer-wake-audit --maxWorkers=1 --fileParallelism=false`. Fixtures cover P1-only wake, P2/P3 no-wake, batched bodies, mailbox notice clock, explicit fetch, expiry/idempotency, category subscriptions, held handoffs and preserved authority/budgets. After building, `PROOF_INBOX_BATCH=1 PROOF_PROVIDERS=codex node scripts/prove-peer-message-wake.mjs --run` (then Claude separately) proves native P2 retention without wake followed by P1 batched delivery and Stop preservation.

Supervisor workflow trial: run `NODE_ENV=test npm run test -w @agent-console/server -- assignment-continuation message-priority peer-message-wake peer-wake-audit agent-session-launches coordination wiki --maxWorkers=1 --no-file-parallelism`, then `NODE_ENV=test npm run test -w @agent-console/web -- CoordinationPanel --maxWorkers=1 --no-file-parallelism`. Disposable fixtures cover digest cadence and overflow, P3 isolation, state-transition deduplication, expired-unread acknowledgement, dispatch ownership/revision/idempotency, preserved budgets, native drafts, Stop and last-moment permission changes. These fixtures do not measure live token savings.

Wiki freshness and P1 reason: `NODE_ENV=test npm run test -w @agent-console/server -- wiki message-priority assignment-continuation coordination peer-message-wake peer-wake-audit agent-session-launches --maxWorkers=1 --no-file-parallelism`, then `NODE_ENV=test npm run test -w @agent-console/web -- WikiPage CoordinationPanel --maxWorkers=1 --no-file-parallelism`. Fixtures cover schema 1/2 migration, replacement cycles/history/search, reason validation, immutable retries, expiry and guarded wake/reusable task behavior. Peer-wake fixtures simulate native Ctrl-C composer clearing used by the deployed Escape contract.

## Structured provider lane

Server coverage: `NODE_ENV=test npm run test -w @agent-console/server -- structured config database conversation-routes session-routes projects-routes`,
then `NODE_ENV=test npm run test -w @agent-console/web -- ConversationPane Sidebar api`. The structured tests use
private SQLite files, the fake transport plugin, and a scripted fake `codex app-server` plus recorded wire
transcripts (`test/helpers/fake-app-server.mjs`, `replay-app-server.mjs`, `codex-fixtures/`). They never start
Codex or tmux, and the session tests assert that no tmux call is made for a structured row. The fake tmux
client applies the same `structured:` name guard as the real one, so a stray call fails the test.

Review-fix suites: `NODE_ENV=test npm run test -w @agent-console/server -- structured-codex-process-lifetime structured-session-restart structured-session-env tmux-client-structured-guard`.
`structured-codex-process-lifetime` reads `/proc` (Linux only). It runs a shell script as a fake `setpriv`
and starts small node processes as stand-ins for a stranded app-server, and kills them when it ends. Its
launcher tests use `test/helpers/fake-launcher.mjs`, a stand-in for the npm `codex` launcher that runs the fake
app-server as a child and only forwards signals; they check that the stale reap and `close()` signal the whole
process group, and that a record without a group, or a pid that no longer matches, is never given a group signal.
`structured-session-restart` covers a turn cut by a backend restart (never working while unloaded, also after an
idle sleep), scheduled recovery re-armed at boot, a half-restored `starting` row, not-sent delivery and a turn
id that runs again. `tmux-client-structured-guard` checks every client method that takes a session name.
`structured-session-env` checks the coordination variables and configured `env` that reach the provider process,
and the coordination identity (`runtimeDir`, `helperPath`) the plugin pins into the app-server argv.

Lane C2 suites (run with `--testTimeout 10000 --maxWorkers=2`; each tmux bind in the migration and launch suites costs
about half a second, so `structured-session-migration` takes about 25 s): `structured-session-per-session` (a fake
plugin with `processModel: 'per-session'`: environment and coordination identity, authority text, own pid, idle sleep
that is not a lost connection, pressure suspension, release, an unexpected exit), `structured-session-migration`
(tmux conversations moved to the structured transport against a fake tmux and fake plugins, plus the dry run and its
route), `structured-session-default-transport` and `structured-session-launches` (a bind or granted launch that names
no transport takes `structuredSessions.defaultTransport`). The `config`, `conversation-routes` and `projects-routes`
suites cover the config keys, the route default and the advertised providers.

Lane C0-C3 suites (the session host, the Claude plugin, questions and images; run them together with
`NODE_ENV=test npm run test -w @agent-console/server -- structured-session-host structured-claude-plugin structured-codex-requests structured-session-requests`):
`structured-session-host` starts the real `session-host.ts` program as a child process against a scripted child
(`test/helpers/fake-host-child.mjs`): the record and socket files, the newline-JSON protocol, one client at a time,
the bounded replay buffer and its gaps, the stdin-EOF/SIGTERM/SIGKILL order, survival of the host's parent, and the
line transport factory (reconnect, a changed command line, reaping a stranded child, the stdio fallback). It reads
`/proc` and starts real node processes, so it is Linux only. `structured-claude-plugin` runs the Claude plugin against
`test/helpers/fake-claude.mjs`, a scripted stand-in for `claude` in stream-json mode (command queue and lifecycle
frames, folding, `priority: 'now'`, interrupt, `can_use_tool` and elicitation requests, duplicate uuids, end of input,
SIGTERM, the registry file under `sessions/`), driven through `test/helpers/claude-harness.ts`: launch argv and
environment, probe, turns, steer, interrupt, requests, failures and result classification, rate limits, process
lifetime, resume and the one-writer check, bare-mode and API-key refusals, transcript path, a lost connection, large images
(random-pixel PNG and JPEG inputs above the API limits are scaled until they fit, small ones go unchanged), and the
session host path. `image-input` covers the prompt helpers: only files directly in the image store become attachments, and an
envelope without its instruction line is still read. `structured-codex-requests` covers Codex questions (`pendingQuestions`, answer and decline) and
`localImage` items against the fake app-server. `structured-session-requests` covers the service and manager side of a
question: it stays on the session row until answered or withdrawn, a second answer is refused, every other request is
declined, and a non-structured row has nothing to answer. `structured-session-survivors` (lane C5) drives the real manager
with the fake plugin: the first reconcile pass adopts a per-session process that outlived a backend restart. None of them calls a real
`claude`, `codex` or tmux. These plus the lane C2 suites (nine files) pass in about 30 s with `--maxWorkers=2`.

Restart and adoption suites (cutover review round 1; run them with
`NODE_ENV=test npm run test -w @agent-console/server -- structured-claude-reattach structured-codex-restart structured-session-adoption structured-session-codex-restart structured-session-orphans structured-session-survivors`):
`structured-claude-reattach` restarts the "backend" (a new plugin instance over the same session host) while the fake `claude`
sits in a silent tool call, then checks what the new session knows: the running turn from `session_state`, Stop, a message sent
meanwhile, the wait for the background-task snapshot, an adopted turn closed by an idle state change, frames of a turn the
session did not send, an empty headless chat restarted under its id, resume beside a holder or a stale launch record, and a Stop
that drops queued steers. `structured-codex-restart` does the same for the Codex plugin against the fake app-server: an adopted
running turn, a turn that ended meanwhile, held questions answered by id, requests read from the host replay (a question held,
an approval declined by id), a replay that does not reach back far enough, a cursor from another process, held questions and
the handler limit, and a question asked in a message. `structured-session-codex-restart` drives the real manager, the real Codex
plugin and the real `session-host.ts` against a scripted app-server: no loss line, no recovery sent into the running turn, and
Stop and a held question reach the app-server. `structured-session-adoption` is the manager side with the fake plugin: adoption
by the first reconcile pass, by a screen poll and by a message that come before it, no new activity from an adopted turn, a turn
that did not survive, cancelled steers, withdrawn and repeated questions, message-mode questions. `structured-session-orphans`
runs the real host against a scripted child: release, sleep and idle sleep of a conversation nobody adopted end its host and
launch record, and the startup sweep leaves the hosts of owned conversations alone. `structured-session-survivors` is the
survivors suite with the fake plugin (a per-session process is adopted at the first pass; a shared process is not looked for
unless its row is working). The reattach, Codex restart and orphan suites start the real session host or read `/proc`, so they
are Linux only.

Opt-in installed-binary check: `AGENT_CONSOLE_REAL_CODEX=1 NODE_ENV=test npm run test -w @agent-console/server -- structured-codex-plugin`
also runs a handshake against the host `codex app-server` (initialize, model list, account read). It opens no
thread and spends no quota.

Opt-in real Codex proof: after `npm run build`, run
`env -u NODE_ENV node scripts/prove-structured-codex.mjs --run > /tmp/proof-backend.log`.
It starts an isolated backend (temp database, runtime and scratch git project, private tmux socket, free port
in 14390-14399) with `structuredSessions.codex.enabled`, and drives one real structured Codex conversation
through the HTTP API in 16 steps. It needs the host Codex login, runs about fourteen short real turns (about 150 seconds when the
provider is not rate limited), and removes its temp root and any app-server it started. Each step id and what it proves:

- a. The project tree advertises `codex` as the structured provider.
- b. The bind returns a thread UUID with the `structured:` name, no tmux session and no raw log. The app-server's environment names the proof's runtime and config (and no session id), its argv pins the coordination MCP server to this Console, it leads its own process group, and it is a child of its session host, whose record matches `/proc`.
- c. The low model profile applies before the first turn, with no restart. The proof switches first because the medium profile's model is sometimes rate limited (HTTP 429, and Codex backs off for minutes); the evidence lists any such retries from Codex's own log.
- d. The first message completes: `deliveryMode: turn`, a turn id, `lastResponseAt` set.
- e. The rollout file exists under `~/.codex/sessions`, the index points at it, and the first turn ran on the low model.
- f. The SessionStart hook registered the thread, an `agent-coord.mjs mcp` process of the proof's runtime ran during the turn, and the agent called the `agent_coordination` MCP tool.
- g. A message sent mid-turn is delivered as a steer into the running turn (same turn id).
- h. Stop (Escape): the row is idle within 15 s, the rollout records `turn_aborted` with reason `interrupted`, and the counting shell command is gone within 5 s of the Stop.
- h2. Question: the card for a `request_user_input` question appears, the card route answers it, and the answer reaches the model (details below).
- h3. An attached PNG reaches the model as a local image item.
- i. Manual sleep unloads the thread (the screen reads `asleep`, a suspended row has no screen to poll, and a manual sleep is refused while the assignment is active); restore reloads it with a new epoch on the same app-server.
- j. The medium profile reaches the provider on the next turn, then the low profile again, with no restart.
- k. Graceful backend restart while idle: the app-server survives in its session host, the host record still matches `/proc`, and the same app-server serves the next turn.
- k2. Graceful backend restart during a running 25 s count. The agent first marks its assignment unattended, so a recovery prompt the Console wrongly sent would really be sent. The first screen poll after boot reads working and writes no loss line, the thread is attached again to the surviving app-server within the first reconcile pass, and the row reads working while the count runs. Stop ends the adopted turn (idle within 15 s, rollout `turn_aborted`) and its shell command within 5 s, and the next message completes on the same app-server. A second restart during another count: a message sent then is delivered as a steer, is not answered while the count has been seen running for 2 s after the steer was accepted, and is answered after the count. Every turn started once and ended exactly once: the rollout holds `task_started` and one `task_complete` or `turn_aborted` per turn id, counted after Stop, after the next message and after the steered turn. No recovery or wake text reached the conversation and no loss line was written.
- l. A 2560x1440 PNG above 5 MB completes without an image error, and the reply names its dominant colour.
- m. Release ends the session; after the session host is ended no process carrying the proof's runtime or temp root remains, and no tmux server was started.

Stop rule: wherever a proof stops a turn that is running the counting shell command (Codex h and k2, Claude f and k2), the command
must be gone within 5 s of the Stop, polled every 100 ms. The counts run 25 to 30 s, so a longer wait would let a command that Stop never reached
finish on its own and pass. In the recorded runs the command ends in about 0.3 s.

The question step (h2) asks Codex for a question through its `request_user_input`
tool. On this Codex (0.164.0) the default collaboration mode offers the model the asynchronous tool: it returns
`{accepted: true}`, raises no blocking request, and Codex emits an `agentMessage` item (`delivery: 'async'`, `questions` of
`{ title, options? }`) while the turn stays open. The step waits for the message-mode card, checks its options, answers it
through the card route (a second answer must be refused), and checks that the answer reaches the model as a user message
and that the reply names the chosen colour. It fails when Codex accepted the question and no card appears. It records a
finding and passes only when the model never made a call that Codex accepted. The image step (h3) sends a solid green PNG
through the image route.
The coordination MCP entry in `~/.codex/config.toml` pins the live runtime; the product overrides it in the
app-server argv, and the proof relies on that (it adds no override of its own). Step results print to stderr as
`PROOF` lines; the Fastify request log goes to stdout. Evidence JSON (step name, result, timing, thread id,
model, pids; no message bodies) is written after every step to `test-results/structured-codex-proof/<timestamp>.json`.
The rollout files it creates stay under `~/.codex/sessions`. Idle sleep after `idleUnloadMinutes` is covered by
unit tests only; the proof sleeps the thread manually.

Opt-in real Claude proof: after `npm run build`, run
`env -u NODE_ENV node scripts/prove-structured-claude.mjs --run > /tmp/proof-claude-backend.log`.
It starts an isolated backend like the Codex proof (`structuredSessions.claude.enabled`, `defaultTransport: 'tmux'`, coordination
enabled for the scratch project; the bind names `transport: 'structured'`) and drives one real structured Claude conversation
with the host's subscription login and the hooks already installed in `~/.claude/settings.json` (their helper path is the live
checkout's `agent-coord.mjs`; the per-process `AGENT_COORD_RUNTIME` and `AGENT_CONSOLE_CONFIG` redirect it to the proof's
runtime). It runs about fifteen short turns (about 90 seconds when the provider is not slow). Fourteen steps, each id and what it proves:

- a. The project tree advertises `claude` as the structured provider.
- b. The bind returns a UUID native id and the `structured:` name. The host record `<runtime>/structured/hosts/claude-<sessionId>.json` matches `/proc`, and the process environment holds the isolated runtime, config and its own `AGENT_CONSOLE_SESSION_ID`. A coordination MCP server carries the isolated runtime: the user-scope MCP entry in `~/.claude.json` names the live one, and the proof stops before any tool call if the plugin's entry did not win.
- c. The first message completes. The transcript exists under `~/.claude/projects/<escaped cwd>/<id>.jsonl` with `turnOrigin: human`, the index points at it, and the first turn ran on the low profile's model and effort after a switch from the launch model.
- d. The SessionStart hook registered the session in the isolated runtime, and the agent called the `agent_coordination` MCP tool.
- e. A message sent mid-turn is delivered as a steer into the running turn (same turn id); the finding records how it lands in the transcript (a `queued_command` attachment, one Stop hook summary for the exchange).
- f. Stop (Escape): the row is idle within 15 s, the pid is unchanged and alive, the transcript holds the interruption marker, and the counting shell command is gone within 5 s of the Stop.
- g. An `AskUserQuestion` becomes a pending request that the card route answers and whose answer reaches the model (a finding when the tool is not offered).
- h. An attached PNG arrives as an image block; a `Read` call by the model is recorded as a finding.
- i. The medium and then the low profile reach the running process on the next turn, with the model and effort in the API request records, no restart, and no `/model` rows in the conversation timeline.
- j. Manual sleep ends the process (and is refused while the assignment is active); restore resumes the same session id (`--resume`) in a new process with a new epoch.
- k1. Graceful backend restart while idle: the first reconcile pass adopts the surviving process before any message, and the same process answers the next turn.
- k2. Graceful backend restart during a running 25 s count. The agent first marks its assignment unattended, so a recovery prompt the Console wrongly sent would really be sent. The first screen poll after boot reads working and writes no loss line, the first reconcile pass adopts the surviving process (a new epoch), and the row reads working while the count runs. Stop ends the adopted turn (idle within 15 s, interruption marker in the transcript) and its shell command within 5 s, and the next message completes on the same process. A second restart during another count: a message sent then is delivered as a steer, is not answered while the count has been seen running for 2 s after the steer was accepted, and is answered after the count. Every turn ended exactly once: the transcript holds one Stop hook summary per completed turn and one interruption row for the stopped turn (a headless transcript has no `turn_duration` rows), counted after Stop, after the next message and after the steered turn. No recovery or wake text reached the conversation and no loss line was written.
- l. A 2560x1440 PNG above 5 MB completes without an image error, and the reply names its dominant colour.
- m. Release ends the session and the process; no `claude`, session host or `agent-coord.mjs mcp` of the proof remains, and no tmux server was started.

The Stop rule above applies to f and k2. Evidence JSON (steps,
findings, models, pids; no message bodies) goes to `test-results/structured-claude-proof/<timestamp>.json`. The transcript
directory the CLI creates for the scratch project is removed after a passing run and kept, with its path in the evidence, after
a failed one.

Opt-in real migration proof: after `npm run build`, run
`env -u NODE_ENV node scripts/prove-structured-migration.mjs --run > /tmp/proof-migration-backend.log`.
It starts an isolated backend with the installed tmux provider commands (pinned to the proof's runtime, as
`prove-granted-launches.mjs` does), both structured lanes enabled and `defaultTransport: 'tmux'`, and creates one real tmux Codex
chat and one real tmux Claude chat on a private tmux socket. It then rewrites the config to `defaultTransport: 'structured'`, closes and
rebuilds the app, and watches the first reconcile pass (5 s after start) move the rows. Nine steps, four short turns, about 35 seconds;
no step stops a running turn, so the Stop rule does not apply. Each id and what it proves:

- a. Both lanes are advertised while the default is tmux; a Codex chat and a Claude chat bind on tmux through the normal routes, and their tmux sessions exist on the private socket.
- b. Each chat answers "TMUX", is bound to a native conversation, has an indexed transcript, and has processes carrying its session id.
- b2. The Claude conversation registered in the proof's own runtime (SessionStart hook); it records which coordination MCP server the CLI started (the command is the installed one, without `--strict-mcp-config`).
- c. Flip: the tmux sessions survive the backend closing, the config is rewritten, the app is rebuilt, and the dry run (`GET /api/sessions/structured-migration`) lists both rows as idle (a finding when the first pass had already moved them).
- d. The first reconcile pass moves both rows to `transport: structured`, asleep (`idle_suspended_at`), with the sentinel name, no pid and raw log, and the same native conversation.
- e. The tmux sessions are gone and no provider process of the tmux phase survives.
- f. Codex answers "MIGRATED" on the structured path in the same thread, with history kept and the index still pointing at the same transcript.
- g. Claude answers "MIGRATED" on the structured path in the same session (resumed by id), with history kept and the same transcript.
- h. Release ends both structured conversations, and no process of this proof remains.

Evidence goes to `test-results/structured-migration-proof/<timestamp>.json`. Both proofs share `scripts/structured-proof-kit.mjs`.
