# Review round 2: structured provider lane (`be43958..ca41634`)

Reviewer: independent Opus pass, 2026-10-26. Read-only. Scope: `git diff be43958..ca41634`, with `git show 6001dad`
(proof script, config `env`, docs) and `git show ca41634` for context. Checklist: `review-round-1.md`.
Line numbers are `ca41634` (the worktree's `apps/` and `scripts/` are unchanged since that commit).

## What I ran

- Repo tests, one file at a time (`env -u NODE_ENV npx vitest run <file>` in `apps/server`). All passed:
  - `structured-session-restart` 7/7
  - `structured-session-recovery` 12/12
  - `structured-session-coordination` 10/10
  - `structured-codex-process-lifetime` 14/14
  - `tmux-client-structured-guard` 18/18
  - `structured-codex-plugin` 85 passed, 2 skipped (the real-Codex tests)
  - `structured-session-input` 24/24
  - `structured-session-wake` 10/10
  - additionally `structured-session-codex` 5/5 and `structured-session-env` 4/4
- Scratch test `scratchpad/vt/r2-recovery-notsent.test.ts`. It drives the real SessionManager and the fake plugin.
  Result: a `NotSentError` at recovery submit ends the recovery as `stopped`, "outcome uncertain" (new finding 3).
- Shell experiment `scratchpad/pdeath/`. A parent spawns `setpriv --pdeathsig TERM -- node wrapper.mjs`. The
  wrapper copies the signal forwarding of `@openai/codex/bin/codex.js` and spawns a child with inherited stdio.
  The parent is then killed with SIGKILL (new finding 2). Results:
  - The child honours SIGTERM: launcher and child both exit.
  - The child ignores SIGTERM: both survive the parent's death. The reaper's SIGTERM and SIGKILL of the
    recorded pid then end only the launcher. The child is re-parented to a subreaper and keeps running.
  - I confirmed on this host that `codex` on `PATH` is the Node launcher. The native binary is its child
    (`ps`: pid 2445553, the musl binary, has parent 2445541, `node .../bin/codex`).
- `setpriv --pdeathsig TERM -- <cmd>`: util-linux 2.39.3 accepts the argv form. A missing binary gives exit 127
  with "failed to execute".

Not run: the full suite, any build, and any `codex` process.

---

## Round-1 findings: verdicts

| # | Round-1 finding | Verdict | Where (ca41634) | Covering test |
|---|---|---|---|---|
| 1 | An unloaded row reads "working" from a stale rollout, and stays so through idle sleep | **Fixed, correct and complete** | `session-manager.ts:1094-1097`: a structured row that is not loaded returns `false`. Idle sleep keeps its monitor (`:4132-4145`, the `delete` is removed) | `structured-session-restart` "never reads as working again…through an idle sleep", "keeps the run monitor across an idle sleep" |
| 2A | A scheduled recovery is orphaned across a restart | **Fixed** | `session-manager.ts:4072-4075` watches a not-loaded row that has `runFailure` or unattended work | restart "re-arms from the persisted budget and the rollout…", "does not watch a thread that has no recovery to run" |
| 2B | A half-restored `starting` row is stuck | **Fixed** | `session-manager.ts:1322-1325`: `restoreMissing` is true for `starting` | restart "is retried at boot instead of leaving the row half restored" |
| 3 | The app-server outlives a crashed backend, then a second writer | **Partially correct** | `process-lifetime.ts` (whole file); `app-server-instance.ts:374-466` (setpriv wrap `:438-448`, reap `:455-466`, start ticks and boot id `:416-428`) | `structured-codex-process-lifetime` (14). The safety of the identity checks is well covered. The gap is new finding 2: the recorded pid is the npm launcher, so SIGKILL reaches only the launcher. There is no real-Codex crash proof. |
| 4 | The `structured:` sentinel does not stop tmux | **Fixed, complete** | `tmux-client.ts:38-49`, applied in all 15 `ShellTmuxClient` methods; `FakeTmux` guards every method (`test/helpers/session-fixtures.ts`) | `tmux-client-structured-guard`, including "covers every method of the client". Docs corrected. |
| 5 | Coordination marks structured workers disconnected after a restart and pages supervisors | **Fixed** | `coordination/service.ts:120-134` (a restorable binding in `starting`/`bound` is alive), `:191` | coordination "keeps a structured assignment connected after a backend restart and does not page its supervisor", "reports stopped for a suspended row and for a released row", "disconnects…once its row was released" |
| 6 | A granted restart interrupts a human's turn | **Fixed (now matches tmux)** | `session-manager.ts:1973-1978` refuses while `turnActive`; `waitForIdle` and `STRUCTURED_INTERRUPT_WAIT_MS` are removed | recovery "refuses to restart while a turn is running, as on tmux…", "reloads an idle thread for a fresh epoch…" |
| 7 | Certainly-not-sent errors are recorded as uncertain | **Partially correct** | `types.ts:97-108` (`NotSentError`); `jsonrpc.ts:99-109,345,455` (`sent` flag); plugin `sendTurn` `app-server-session.ts:399,403-409,422`; service `:327` (deferred); human queue requeue `session-manager.ts:3990-3995`; direct input `:3919` | input "queues a message the transport reports as never sent…"; wake "defers when the transport reports nothing was sent…"; restart "A transport that reports nothing was sent" (calls the service directly). **Still open:** the RunRecovery submit path (new finding 3) and the steer path (new finding 4) |
| 8 | Steer error handling relies on a regex and can misclassify | **Fixed for the duplicate risk.** The refusal half is left open on purpose and documented. | `TURN_GONE_PATTERN` and `turnIsGone` removed; service `:292-298` accepts only `TurnNotActiveError`; plugin `:429,437,442`; the fake throws it (`structured-fixtures.ts`) | input "falls back on a lost steer race…TurnNotActiveError", "never sends a refused steer again…", "does not resend a steer of unknown outcome…" |
| 9 | Background commands survive when `turn/completed` beats the interrupt response | **Fixed** | `app-server-session.ts:458-471` terminates in both orders and on refusal after the turn ended | plugin "terminates tracked background commands even when turn/completed arrives before…", "…when the interrupt is refused after the turn already ended" |
| 10 | A new turn after a local finalize loses track of a running turn | **Fixed** (the premise is still UNVERIFIED against Codex) | plugin `:708-717` tracks the turn again only when it is not adopted and is `inProgress`; host `structured-session-service.ts:506-512` removes the id from `terminalSeen` on a non-replay `turn.started` | plugin "tracks a turn again when turn/start answers with an id this session already closed", "does not track a finished turn again when its own response arrives after the turn ended"; restart "A turn the transport reports as running again" |
| 11 | The user's own message echo counts as agent output | **Fixed** | `app-server-session.ts:913-914` (`userMessage`, `hookPrompt`) | plugin "reports neither the user message echo nor a hook prompt…"; codex "does not count the echo of the user's own message as agent output" |
| 12a | `launch_session` has no `transport` | Not changed. Documented as open (`structured-providers.md` "Left open on purpose") | — | — |
| 12b | The `thread_closed` `retryable` flag is ignored | Not changed. Documented as open | — | — |
| 12c | The slash-command regex rejects "/tmp is full" | **Fixed** | `session-manager.ts:120-121` (whole-message command only) | input "rejects a message that is only a slash command", "accepts ordinary messages that merely start with a slash" |
| 12d | The stderr tail appears in conversation status lines | **Fixed for the connection-loss line; partial overall** | `jsonrpc.ts:151` `exitReason`; instance `:503-504` | codex "notices the app-server exiting…none of its stderr". Bind and restore failures can still carry the tail (new finding 6) |
| S1 | `spawnDetached` and `spawnScoped` are dead code | **Fixed** (removed from host, contract and fixtures) | `types.ts:82-86`, `session-manager.ts` | compiles; fixtures updated |
| S2 | The config shape is defined three times | **Fixed** | `config/schema.ts:75-78` (`StructuredProviderConfig` from zod); service and plugin import it | config tests |
| S3 | `structuredMonitors.delete` churn | **Fixed where it churned** (idle sleep, restart). Manual suspend, release and failed bind still delete. Those rows are not watched again, so there is no churn. | `:1978`, `:4132-4145` | restart "keeps the run monitor across an idle sleep" |
| S4 | Contract members are unused | Kept (acceptable for future plugins) | — | — |
| S5 | Doc drift (socket, scope) | **Fixed**, but one new inaccurate sentence (new finding 2) | `structured-providers.md:276-287`, `architecture.md:587-611` | — |

---

## Regression checks requested

- **(a) `providerTurnIsWorking` and tmux rows. No change.**
  - The new `getById` moved above `if (!run)` and only adds a structured early return.
  - Every tmux path reaches the same expressions in the same order, with the same `session` value.
  - Reviewed call sites: `:792, 1320, 1388, 1988, 2448, 2606, 3350, 3588, 4798, 4874, 5216`.
- **(b) Restoring `starting` rows at reconcile. No resume loop, and user pauses are respected.**
  - Manual suspension (`:1246`), pressure suspension (`:1299`) and idle suspension without pending work
    (`:1300`) are skipped before the restore.
  - Released rows are not listed (`shouldRestore=0`), and `releasing` returns early (`:4066`).
  - A pending-ref row is ended, not restored (`:4057-4063`, as before).
  - A failed restore becomes `error`. That is the existing retry cadence for `error`, and later attempts are
    silent (`shouldEmitRestoreAttempt`).
  - Bind and restore run under the same per-session queue as reconcile, so they do not race.
  - Residual (not a regression): an idle-suspended row cut off half way stays `starting` until it is used,
    then restores on demand.
- **(c) `watchSessionOutput` in the not-loaded branch. No churn and no duplicate lines.**
  - `runRecovery.watch` is idempotent for the stable `structured:<id>` key. It only swaps the placeholder
    monitor left by `processExited` and keeps `processFailure`.
  - `transcriptWatchers.watch` is idempotent for the same path.
  - `attachTranscript` returns false when the path is unchanged.
  - The loss line is written only when `isWorking` is true, and that can no longer flip back on (test asserts
    exactly one loss line).
  - At boot, a stale `task_started` read in the history does not overwrite a newer `processFailure`
    (`run-recovery.ts:155`).
- **(d) `setpriv` spawn: correct. Reap identity: safe. Termination: incomplete.**
  - The argv is `[setpriv,'--pdeathsig','TERM','--',...cmd]`. The fallback warns once.
  - A missing `codex` is resolved first, so it is spawned plainly and gives ENOENT, then `installed:false`.
  - The reap acts only when:
    - the pid is greater than 1 and is not the backend's own;
    - the start ticks match (field 22, parsed after the last `)`);
    - the boot id matches when one was recorded.
  - The identity is checked again before SIGKILL. Zombies are excluded. Old records without ticks are never
    acted on.
  - It cannot kill an unrelated process. The only other target it could hit is the live app-server of a second
    backend on the same database, which is an unsupported setup.
  - The gap is new finding 2: it signals only the launcher.
- **(e) tmux guard.** It matches only the exact prefix `structured:`. `buildTmuxSessionName` produces
  `ac-…[a-zA-Z0-9_-]`, so it never contains a colon. A guard throw makes `checkTmuxLiveness` return `unknown`,
  which is safer than the old `dead`. The fake applies the guard on every method.
- **(f) Coordination. tmux results are unchanged** (`transport='structured'` is in the binding query, and tmux
  falls through to the pid).
  - A receipt for an unloaded, bound row is `idle` with `resumableInConsole:true`; it is `stopped` only when the
    row is manually or pressure suspended, or released.
  - `reconcileProcesses` skips bound structured rows, so it sends no supervisor page.
  - Parity note: an `error`-status structured row still falls back to the hook pid, as tmux error rows do.
- **(g) `NotSentError` and `TurnNotActiveError` plumbing.**
  - Codex plugin: `sendTurn` correct; `steer` incomplete (new finding 4).
  - Fake plugin: `steer` correct; a closed fake session still throws `TransportUnavailableError` (new finding 8).
  - Service: `deliverAutomatic` returns deferred; `submitHuman` lets only the typed error become a new turn.
  - SessionManager: the human queue requeues; direct input is rejected with "Nothing was sent"; the wake path
    defers; RunRecovery stops (new finding 3).
- **(h) Exactly-once terminals.**
  - The plugin emits `turn.started` once per record.
  - `onTurnStarted` drops ids it has already finished.
  - A record is tracked again only from a non-adopted `inProgress` response.
  - The host clears `terminalSeen` only for a non-replay `turn.started`.
  - `startTurn` and the event can run in either order and still end with the turn active.
  - Result: exactly one terminal per start, which is what the fix intends.
- **(i) Env merge: matches the requested order.**
  - Order: process env, then `hostEnv` (coordination only, `app.ts:90`), then configured `env`, which wins
    (`service:393`).
  - `~` is expanded in the merged values.
  - `AGENT_CONSOLE_SESSION_ID` and `CODEX_THREAD_ID` are deleted after the merge (`app-server-instance.ts:109-120`).
  - Covered by `structured-session-env` (4 tests).

---

## New findings, ranked

### 1. MEDIUM-LOW. CONFIRMED (code, `~/.codex/config.toml`, proof script). The coordination MCP server of a structured thread is not pinned to this Console

- `app.ts:90` gives the app-server `AGENT_COORD_RUNTIME` and `AGENT_CONSOLE_CONFIG`. Hooks inherit them.
- The coordination MCP server does not. Codex launches it from the global `[mcp_servers.agent_console_coordination]`
  entry, whose explicit `env.AGENT_COORD_RUNTIME` is the live runtime (`/home/bryan/.local/share/agent-console/runtime`)
  and whose `args` point at the live checkout's helper.
- tmux Codex launches override all three (`codex-provider.ts:361-364`). The structured command adds none.
- Scenario: a Console with a different `runtimeDir` enables structured sessions, for example a worktree dev
  Console or the proof.
  1. The hooks register the thread with that Console.
  2. The agent's `agent_coordination` tool calls go to Bryan's live Console.
  3. The result is split-brain coordination, and a stray assignment or activity in the live database.
- The proof hides this. It adds the overrides to its own `command` (`prove-structured-codex.mjs:84-89`), so step
  f passes on a configuration the product never produces.
- Production works only because the live runtime and the global entry happen to name the same paths. If either
  changes, structured threads break silently.
- Fix:
  - When coordination is enabled, have the host give the plugin the same overrides it gives tmux:
    `-c mcp_servers.agent_console_coordination.command="node"`, `.args=[helperPath,"mcp"]` and
    `.env.AGENT_COORD_RUNTIME=<runtimeDir>`. They can be appended to the command next to `hostEnv`.
  - Leave out `AGENT_CONSOLE_SESSION_ID`, since the process is shared.
  - Remove the hand-written override from the proof, so step f exercises the product path.

### 2. LOW-MEDIUM. PLAUSIBLE (mechanism CONFIRMED with a launcher-shaped scratch experiment). The crash protection reaches only the npm launcher, not the app-server

- `app-server-instance.ts:416-428` records `client.pid`. With an npm install, that pid is
  `node …/@openai/codex/bin/codex.js`. The native app-server is its child, which it spawns with
  `stdio:'inherit'` and SIGTERM forwarding.
- pdeathsig therefore depends on the launcher forwarding TERM and on the native app-server exiting on TERM in
  the middle of a turn. The second is UNVERIFIED.
- `terminateRecordedProcess` (`process-lifetime.ts:82-97`) and `JsonRpcClient` `closeStaged` send SIGKILL to
  the launcher only. A native child that ignores or delays TERM survives as an orphan and keeps writing the
  rollout. The scratch experiment reproduced this with a stand-in child.
- The new backend then resumes the same thread, which is the second-writer case that finding 3 was meant to
  close.
- `docs/structured-providers.md:279-280` says "setpriv execs the command, so the recorded pid is the Codex
  process". That is wrong for this host's install.
- `:586-587` says pdeathsig "covers a crashed backend, so the proof script has no step for it". That is unproven.
- Fix:
  - Spawn the child as its own process group: `detached:true` sets a new session, and pdeathsig is unaffected.
  - After checking the leader's identity, signal the group (`process.kill(-pid, …)`) in both `closeStaged`
    and the reap.
  - Alternatively, record the launcher's children (pid and start ticks) and verify and signal them too.
  - Add one proof step. Run the backend as a child process instead of in-process, start the 30-second count,
    SIGKILL the backend, and assert that the launcher and the native binary both exit, with no rollout writes
    after that point.
  - Correct the doc sentence.

### 3. LOW. CONFIRMED (scratch test). A recovery prompt that was certainly not sent stops unattended recovery as "uncertain"

- `session-manager.ts:447-449`: the structured branch of `submit` throws on any non-`submitted` delivery.
  `RunRecovery.retry` then stores `status:'stopped'`, "Retry submission failed or its outcome is uncertain.
  Review the conversation before continuing.", with the attempt already spent (`run-recovery.ts:286-293`, the catch at `:291-293`).
- Measured: with `failNextSend = new NotSentError(...)`, the runFailure became
  `{status:'stopped', attempts:1, stoppedReason:'Retry submission failed or its outcome is uncertain…'}`.
- A `deferred` delivery produces the same sticky stop, including when a human turn starts in the gap after
  `canRetry`. Unattended work then waits for a human, although nothing was sent.
- Fix: have the structured `submit` throw a typed not-submitted error on `deferred`. In `retry`, catch it and put
  the failure back to `scheduled` (attempt not consumed, or a short re-arm) instead of `stopped`.

### 4. LOW. CONFIRMED (code). A steer that fails before anything was written is reported as "Submission could not be confirmed"

- `app-server-session.ts:427-446`.
  - `steer` does not check `this.ended`.
  - `this.host.client()` throwing `TransportUnavailableError`, and a `JsonRpcExitError` with `sent:false`, both
    go through `toTransportError`.
  - `drainStructuredQueuedInput` (`session-manager.ts:3997-3998`) then marks the message failed and uncertain.
- The window is the race between the process exiting and the host's `lose()`.
- Fix: mirror `sendTurn`. Throw `NotSentError` when the session has ended, when `client()` throws, or on
  `JsonRpcExitError` with `!sent`. `submitHuman` already rethrows it, and the queue requeues it.

### 5. LOW. PLAUSIBLE. Stop cannot clear a turn that the server says is not active

- `app-server-session.ts:448-466` (the catch at `:459-466`). If `turn/interrupt` is refused (for example "no active turn") while the
  plugin's record is not terminal:
  - it sets `record.interrupt = null` and throws;
  - no local finalize timer is armed;
  - the host shows "Stop could not be delivered" and the row stays working. That blocks wakes and recovery
    until the thread is unloaded.
- This needs the plugin and the server to disagree. The re-track in finding 10 adds one such way, if its
  UNVERIFIED premise ("turn/start joins the active turn") is wrong for some Codex version.
- Fix: treat a refusal that matches `steerLostRace` / "no active turn" as the end of the turn. Finalize the
  record locally as `interrupted`, with a warning notice.

### 6. LOW. CONFIRMED (code). The stderr tail can still reach conversation status lines

- `app-server-instance.ts:413` uses `describeExit`, and the default `JsonRpcExitError` message (`jsonrpc.ts:105`)
  does too. Both flow into "Failed to bind session: …" and "Failed to restore session: …" status lines through
  `toTransportError` and `ensureLoaded`'s reason.
- The tail is redacted, so this is noise rather than a leak.
- Fix: use `exitReason` for error messages that can become status lines, and keep `describeExit` for logs.

### 7. LOW. CONFIRMED. Some proof assertions prove less than the step names claim

- **i. "manual sleep unloads the thread and restore reloads it".** Only the database flags and an unchanged pid
  are checked. Nothing shows that an unload or resume happened. Assert that the meta `structured-epoch:<id>`
  changes, or that "Restored bound session." is in the event log.
- **k. "backend restart".** This is a graceful in-process `app.close()`. It does not test a crash, pdeathsig or
  the reap (see new finding 2).
- **h. Stop.** Nothing checks that the counting shell command was terminated, which is the real-world side of
  round-1 finding 9. For example, check `pgrep -f 'seq 1 30'` after Stop.
- **l. `listProcesses()`.** It matches `pgrep -f <tempRoot>`. That finds the launcher and the native process,
  whose `-c` arguments contain the root, but not their MCP or hook children. Match on `/proc/*/environ`
  `AGENT_COORD_RUNTIME=<runtimeDir>` instead.
- **g.** `values.commandRunning` is recorded, not asserted. That is acceptable for a mid-turn steer, but the
  step does not prove a steer during a command.
- The temp root is created at `:49`, well before the `try` at `:265`. A failure before `try` leaves it behind. No secret is
  written by then.

### 8. LOW. Test-fidelity gap in the fake plugin

- A closed `FakeTransportSession.sendTurn` throws `TransportUnavailableError`, while the real plugin throws
  `NotSentError`.
- The fake's `unload()` still leaves the event stream open (noted in round 1).
- Host behaviour proved with the fake can therefore differ from what happens live on those two paths.
- Fix: throw `NotSentError` from `assertOpen` in `sendTurn`, and end the stream on `unload`.

---

## Proof script (`scripts/prove-structured-codex.mjs`): other checks

- **Isolation: OK.**
  - The proof creates its own temp root, database, runtime, config (mode 0600) and git project.
  - tmux uses a private `-L` socket. Steps b and l assert that no tmux server ever started.
  - The coordination MCP is overridden to the temp runtime (see new finding 1 for why it has to be).
  - Hooks reach the temp backend through the app-server environment. Step b asserts the child's environment.
- **Bryan's live config: read only.** The proof reads `~/.config/agent-console/config.json` to copy
  `providers.codex` into the temp config. It writes nothing there.
- **`~/.codex`.** It reads `logs_*.sqlite` (read-only, best effort). Its only writes are normal Codex session
  side effects: a new rollout under `sessions/`, index and state entries. Global hooks and MCP servers start as
  they do for any Codex session.
- **Cleanup (`finally`).**
  - Release the session if it is still restorable, then shut down the backend.
  - SIGTERM, then SIGKILL, every process matching the temp root, excluding itself.
  - Run `tmux -L kill-server` and remove the temp root. Each action is recorded in `evidence.cleanup`.
  - A SIGINT to the script skips the `finally`. pdeathsig now ends the app-server in that case, but the temp
    root stays.
- **Evidence JSON: no secrets.** It holds no password, cookie or CSRF token. It does hold paths, pids, thread,
  session and turn ids, and model names. It goes to the gitignored `test-results/`. The committed copy under
  `docs/research/` is from `be43958`, before the fix. A rerun is pending.

---

## Verified OK (no need to re-check)

- tmux rows:
  - `providerTurnIsWorking` results are unchanged;
  - coordination register, receipt and reconcile results are unchanged;
  - reconcile `restoreMissing` for tmux is unchanged;
  - the guard cannot reject an `ac-…` name.
- Exactly-once terminals hold per start in the plugin and the host. `startTurn` never revives a finished turn
  unless the transport reports it started again.
- Restore, bind, drain and reconcile all run under the per-session queue (`session-runtime.ts:66-90`). No new
  interleaving.
- Recency:
  - re-tracked turns use `origin:'user'` and do not move recency;
  - user and hook echoes no longer set `lastOutputAt`;
  - a not-loaded watch at boot only reads history;
  - keeping the monitor across idle sleep stops a spurious `lastResponseAt` rewrite (protocol and history
    timestamps match).
- RunRecovery at boot:
  - a `processFailure` beats an older stale `running` history;
  - a scheduled budget with a matching rollout `failed` record re-arms;
  - expired failures (over 10 minutes) are stopped, as on tmux.
- Granted restart:
  - it now refuses exactly while a turn is loaded and running;
  - an unloaded thread is reloaded for a new epoch;
  - `reset()` on the kept monitor clears only the protocol state.
- Process identity helpers: the field 22 parse, the zombie and dead exclusion, the boot-id check, the re-check
  before SIGKILL, and never acting on records without start ticks. The tests cover reused pids, missing ticks,
  a SIGTERM-ignoring process and respawns that skip the reap.
- `JsonRpcClient` sets `sent:false` only for refusals before `writeFrame`. In-flight losses stay `sent:true`
  (test "marks a request refused after the process ended as not sent…").
- The interrupt fix terminates tracked commands once per interrupt in all three orders, and never on a
  refused interrupt for a turn that is still open.
- Config: `DEFAULT_STRUCTURED_PROVIDER_CONFIG` comes from the schema, and the zod defaults produce new objects.
  The example config gains `env: {}`.
- No leftover references to the removed `TurnAlreadyCompletedError`, `TURN_GONE_PATTERN`, `waitForIdle`,
  `spawnScoped` or `structuredInstanceAlive`.

---

## Summary

1. Round-1 findings 1, 2, 4, 5, 6, 8 (the duplicate risk), 9, 10 and 11 are fixed correctly, with repo tests
   that reproduce the round-1 scenarios through the real SessionManager.
2. The requested regression checks found no regression in tmux rows, coordination for tmux, the restore of
   `starting` rows, monitor churn, exactly-once terminals or the env merge order.
3. Finding 3 is partially closed. `setpriv --pdeathsig` and the start-tick reap are correct and cannot hit an
   unrelated process. But on this host the recorded pid is the npm `codex.js` launcher, so SIGKILL never reaches
   the native app-server, and the crash path is unproven against real Codex.
4. Finding 7 is partially closed. Wake and human input handle `NotSentError`. RunRecovery still stops a
   certainly-unsent recovery as "uncertain" (confirmed by a scratch test). Steers still map pre-write failures
   to "could not be confirmed".
5. New, MEDIUM-LOW: the coordination MCP server of a structured thread follows `~/.codex/config.toml`, not this
   Console. The proof hand-adds the override that the product lacks.
6. New, LOW: Stop cannot clear a turn the server refuses to interrupt; the stderr tail still reaches bind and
   restore failure lines; some proof steps prove less than their names; the fake's closed-session error type
   differs from the real plugin's.
7. All ten targeted test files pass. The full suite and the post-fix real-Codex proof were not run by me; the
   committed evidence is from before the fix.
8. Nothing found reaches tmux, and none of the open items creates a second writer, a stuck row or lost input
   on the normal production paths.
9. **The branch is ready for Bryan to review for integration (not deployment).**
10. Still open:
    - new finding 1 (pin the MCP overrides, then drop the proof's workaround);
    - new finding 2 (signal the process group or the launcher's children, add a crash proof step, fix the doc
      sentence);
    - new findings 3 and 4 (not-sent handling for recovery and steer);
    - the documented open items 12a and 12b;
    - the post-fix proof rerun result.
