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
- Authentication/CSRF recovery: `npm run build -w @agent-console/shared`, then
  `NODE_ENV=test npm run test -w @agent-console/server -- auth` and
  `NODE_ENV=test npm run test -w @agent-console/web -- api`. Browser coverage:
  `NODE_ENV=test npm run test:e2e -- apps/web/e2e/csrf-*.spec.ts`. The auth
  cancellation case uses a private HTTP server and Chromium's real cookie jar
  to verify that an aborted older auth response cannot replace the renewed login.
- Server/session changes: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- session-lifecycle session-recency session-runtime session-screen-state`.
- Pending Codex first-turn or session keystroke changes: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- session-pending-first-turn session-keystrokes session-keystrokes-submit session-routes`.
- Durable queued chat submission: `NODE_ENV=test npm run test -w @agent-console/server -- session-input-queue session-routes session-interactive-input`. These fixtures use disposable SQLite databases and fake tmux transports to verify delayed repaint, database reopen, FIFO, matching drafts, cancellation before/during Enter, failed suspension, model-switch deferral, ownership and uncertain Enter. `NODE_ENV=test npm run test -w @agent-console/web -- ConversationPane` covers the queued Text Bypass handoff and sending-state controls. Browser coverage in `apps/web/e2e/input-rejection.spec.ts` verifies separate consecutive messages, pending-message display, refresh without resubmission, cancellation and preservation of genuine rejection behavior. Use isolated E2E ports; browser fixtures intercept provider input.
- Live output normalization: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- live-output`.
- Large event-log prompt restoration and cache races: `NODE_ENV=test npm run test -w @agent-console/server -- last-user-input session-output-restoration session-recency session-runtime`.
- Timeline merge, transcript catch-up, stale transcript cache, or duplicated bubble fixes: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- timeline-merge transcript-watcher conversation-routes provider-conversation-cache`.
- Raw screen, text-bypass, and conversation-pane transcript boundaries: `npm run test -w @agent-console/web -- ConversationPane`.
- Live session recovery and route handling: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- session-lifecycle session-routes tmux-health`.
- Pending Codex progress or stale bound timeline polling: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- providers && npm run test -w @agent-console/web -- useConversationData transcript-turns`.
- Conversation search or search-index backfill: `npm run build -w @agent-console/shared && npm run test -w @agent-console/server -- search`.
- Project/settings browser flow: `npm run test:e2e -- apps/web/e2e/settings.spec.ts` (builds the shared package first).
- Host-level Codex adoption: `npm run smoke:codex -- --project <project-slug> --password '<login-password>'` only when a backend is running and real Codex/tmux state is intentionally in scope.
- Visible live-console UX check: `npm run verify:live-console -- --base-url http://127.0.0.1:4317 --cdp-url http://127.0.0.1:9222 --password '<login-password>' --claude-url <conversation-route> --codex-url <conversation-route>` only when a backend and visible Chrome CDP endpoint are already running and the Claude/Codex live sessions are deliberately chosen. The verifier attaches to visible Chrome, sends `/model` plus model-selection input, and submits `Reply exactly ...` marker prompts through Text Bypass, so it changes real model, session, and transcript state. Omitted route defaults are Bryan-specific hard-coded pending sessions and should not be used unless that is the intended target.

- Worktree cleanup guards: `NODE_ENV=test npm run test -w @agent-console/server -- worktree-sweep`. These fixtures create private repositories and SQLite state; do not run the host sweep in apply mode as a test.
- Shared wiki storage/search and API: `NODE_ENV=test npm run test -w @agent-console/server -- wiki`. Fixtures use temporary Git repositories and SQLite files.

## Environment and Fixtures
- Install with `npm install`.
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
then verifies native recovery, granted restart, a Claude helper and relayed scope under one grant.
Use [the separate recovery proof](../../scripts/prove-session-recovery.mjs) for actual killed-process recovery.

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
message, and clear the retry notice. The script faults only its own transcripts
and process identities, releases its sessions, and retains `proof.json` under its
printed temporary evidence directory. `PROOF_PROVIDERS=codex` or `claude` narrows
the run. Native hooks and MCP must point to that private runtime. Do not use a
running production database or provider session as a fixture.

Owned helper close/archive (#82): `NODE_ENV=test npm run test -w @agent-console/server -- agent-session-launches session-owned-close agent-grants` and `NODE_ENV=test npm run test -w @agent-console/web -- GrantsPage`. These use disposable SQLite/native transcript fixtures and verify exact launcher ownership, current grant authority, history retention, low-memory cleanup, durable request deduplication, automatic finished/exited archival, no recovery after close, missing-history deferral and manual-pause protection.

After `npm run build`, opt into real-provider verification with
`node scripts/prove-session-close.mjs --run`. It uses a private project, SQLite
database, runtime and tmux socket. For each provider it closes an owned helper,
then finishes another helper's assignment and exits that disposable provider.
Both histories must remain intact, the Work bindings must end, and reconciliation
must not recover them. Pending helpers retry transcript adoption using their exact
registered native identity. Evidence remains under `/tmp/console-close-proof-*`.
`PROOF_PROVIDERS=codex` or `claude` limits the run; provider authentication and
tmux are required. The fixture releases only its own sessions during cleanup.

Waiting-agent peer wake (#84): after `npm run build`, run
`node scripts/prove-peer-message-wake.mjs --run`. This opt-in proof uses real Codex
and Claude in a private project, database, runtime socket and tmux server. A sender
in a separate project messages an idle `waiting_for_input` recipient; each must
acknowledge and reply without a second human input, keep its pending human
decision and continuation permission, and respect a subsequent manual Stop.
`PROOF_PROVIDERS=codex` or `claude` narrows the run. The fixtures are released and
private `proof.json` evidence remains in the printed temporary directory.

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
