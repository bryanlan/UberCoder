# Review: structured provider lane (`main..be43958`)

Reviewer: independent Opus pass, 2026-10-26. Scope: committed diff only (`git diff main..HEAD`). The working
tree has uncommitted W4 edits (structured `env`, docs, proof script); none of them touch the findings below.
Line numbers are HEAD (`be43958`) unless marked otherwise.

Evidence scripts (outside the repo, run with
`cd apps/server && env -u NODE_ENV npx vitest run --globals --dir <scratch>/vt <name>`):
- `(reviewer scratch tests, reproduced as repo tests in round 2) f2-stuck-working.test.ts`
- `(reviewer scratch tests, reproduced as repo tests in round 2) f-orphan-retry.test.ts`

Both use the committed fixtures (`FakeTransportPlugin`, `createRecoveryManager`) through the real SessionManager.

---

## Findings, ranked

### 1. HIGH. CONFIRMED (scratch test). An unloaded structured row turns "working" again from stale transcript state, and stays that way while asleep

- `apps/server/src/sessions/session-manager.ts:1107-1125` (`providerTurnIsWorking`). Line 1109 uses the
  transport state only while the thread is loaded. When it is not loaded, the function falls through to
  the RunRecovery run state. That run state comes from `StructuredRunMonitor.read()`
  (`sessions/structured/structured-run-monitor.ts:49-55`), which returns the rollout history once its
  protocol state was `reset()`.
- Scenario (reproduced in `f2-stuck-working.test.ts`):
  1. A human (not unattended) structured turn is running. The rollout's last record is `task_started`.
  2. The backend restarts, or the app-server dies.
  3. `reconcileSessions` calls `settleLostStructuredTurn`, and `handleStructuredConnectionLoss` sets
     `isWorking=false` and emits `session.updated`.
  4. `handleRealtimeLifecycleEvent` calls `watchSessionOutput`. That creates a new observation and attaches
     the CodexRunMonitor.
  5. `refresh` sees history `running` and calls `onRunState`, then `syncSessionWorkingState`.
     `providerTurnIsWorking` takes the not-loaded path. `nativeProcess` is undefined (fresh boot or
     `clearEphemeral`), so it returns `true`. Result: `isWorking=true`.
  6. Measured result: true for every sample after the first reconcile. The next reconcile writes a
     duplicate "provider connection ended" status line and clears the flag again.
  7. If the row is then idle-slept (`suspendStructuredIdleSession` calls `stopWatching`, emits
     `session.updated`, the session is watched again and its history read again), it ends **idle-suspended
     with `isWorking=true` across every later reconcile** (measured). Reconcile skips idle-suspended rows
     (`:1313`).
  8. `drainAssignments` returns early on `current.isWorking` (`:706`), so **peer and continuation wakes are
     never delivered**. The sidebar shows the row as working until a human opens it. When the human opens
     it, the loss handler runs once more and writes a misleading "connection ended while a turn was running"
     line.
- Fix: for `transport==='structured'` rows, return `alive ? turnActive : false` from
  `providerTurnIsWorking` and never consult the transcript run state, since a thread that is not loaded
  cannot run anything. Add a host test for "turn cut by restart, then idle sleep".

### 2. HIGH. CONFIRMED (scratch test). Scheduled recovery and half-restored rows are orphaned across a backend restart

- `session-manager.ts:1336-1338` (reconcile passes `restoreMissing:false` for structured rows unless
  `status==='error'`) and `:4080-4091` (the not-loaded branch of `refreshStructuredSessionState` returns
  without `watchSessionOutput`).
- Scenario A (reproduced in `f-orphan-retry.test.ts`):
  1. An unattended structured turn fails with `server_overloaded`. `runFailure` becomes
     `{status:'scheduled', nextRetryAt:+15s}`.
  2. The backend restarts and `reconcileSessions` runs.
  3. After 130 s of fake time there are 0 plugin instances, 0 recovery turns, and `runFailure` is still
     `scheduled`, with a `nextRetryAt` in the past.
  4. Nothing ever watches the row again until a human opens it. The UI shows a stale "recovery scheduled".
  5. On tmux the same restart re-attaches the watcher during reconcile, and the retry re-arms.
- Scenario B (same root cause):
  1. A backend crash during `restoreStructuredSession` (for example an unattended retry's `canRetry`, or a
     slow `thread/resume` while MCP servers start) leaves the row `status:'starting', isWorking:false`
     (`:4036`).
  2. At boot, reconcile neither restores it (it is not `error`) nor counts it as lost work (it is not
     working).
  3. `canRetry` then refuses with "no longer owns the conversation" (`:413`), because the row is not
     `bound`. Queued input waits at `status!=='bound'` (`:2558`).
- Fix:
  - In the not-loaded branch, call `watchSessionOutput(current)` (safe once finding 1 is fixed) whenever
    the row has a `runFailure` or unattended work, so RunRecovery re-arms from the persisted budget and the
    rollout.
  - Treat `status==='starting'` like `'error'` for structured `restoreMissing` in reconcile.

### 3. HIGH if true. PLAUSIBLE. After a backend crash, the app-server can outlive the backend, and recovery then starts a second writer on the same thread

- `providers/transport/codex/jsonrpc.ts:310` spawns a plain child (no pdeathsig, no scope).
  `app-server-instance.ts:356-402` never checks for a previous instance.
- The live unit `~/.config/systemd/user/agent-console.service` has `KillMode=process`, kept so tmux
  survives restarts. A graceful stop is fine (`index.ts` SIGTERM, then `app.close()`, then
  `sessions.stop()`, then `dispose()`, which closes stdin, then SIGTERM, then SIGKILL).
- Crash scenario (OOM kill or an uncaught exception, which is realistic on this memory-constrained host):
  1. The child is re-parented with only a stdin EOF. Whether `codex app-server` exits on EOF **while a turn
     runs** is UNVERIFIED in the brief (§1, §8.7).
  2. If it keeps running, the restarted backend runs `settleLostStructuredTurn` (unattended) and then
     `processExited`.
  3. About 15 s later `canRetry` runs, then `restoreSession`. That spawns a new app-server and sends
     `thread/resume` plus `RECOVERY_PROMPT` while the orphan still executes the old turn on the same
     thread, writing the same rollout. That is two writers.
  4. The stale `structured-instance:codex` meta (`pid` only; `startedAt` is backend wall time, not
     `/proc` start ticks) also makes `structuredInstanceAlive` (`coordination/service.ts:128-135`) report
     the orphan, or a reused pid, as alive.
- Fix:
  - Launch through `setpriv --pdeathsig TERM -- codex app-server ...` (present on this host), or an
    equivalent wrapper.
  - Store `/proc` start ticks in the instance meta, and terminate a matching stale process before the first
    spawn.
  - Add an EOF-with-running-turn check to the proof script.

### 4. MEDIUM. CONFIRMED (tmux 3.4 on this host). The `structured:<id>` sentinel does not make tmux fail; it creates a real session

- `session-manager.ts:4345` (comment and sentinel); the same claim is in `docs/structured-providers.md`
  "Schema version 19".
- Isolated-socket test:
  - `tmux new-session -d -s 'structured:abc123'` exits 0 and creates `structured_abc123`.
  - `has-session -t 'structured:abc123'` reports "can't find window".
- Any future unguarded `newDetachedSession` (restore, profile relaunch or bind) would therefore launch
  `codex resume <thread>`, a second writer, which liveness then reports as dead.
- I enumerated all 36 tmux-touching SessionManager methods. No structured row reaches one today (see
  Verified OK), so this is a missing safety net, not a live bug.
- Fix: refuse at the tmux client boundary (throw when a target starts with `structured:`) and correct the
  comment and the doc.

### 5. MEDIUM-LOW. CONFIRMED (code and an existing test asserts it). Coordination marks every structured worker "disconnected" after a backend restart and notifies supervisors

- `coordination/service.ts:126-139` and `:189-203`. Structured liveness is "binding exists AND the meta pid
  of the shared instance is alive". The plan said "Console session bound and loaded" through an
  SessionManager predicate.
- The instance starts lazily and its meta is deleted on dispose. After any restart, every active or waiting
  structured assignment whose hook pid (the old app-server) is dead becomes `disconnected`, and
  `notifySupervisor('An unattended supervised worker disconnected.')` fires for those with unfinished work.
  This happens even though the thread can be restored on demand and the wake path will load it.
- Agent `update` calls throw "Resume this assignment" until the next turn's SessionStart re-registers the
  assignment. Receipts also report idle-unloaded threads as alive as long as some other thread keeps the
  process up.
- Fix: for structured bindings, use "restorable and bound" (or an SessionManager predicate) instead of the
  instance pid, and do not notify supervisors for rows that can be restored.

### 6. MEDIUM (design decision). A granted restart interrupts a running turn on structured rows; tmux refuses

- `session-manager.ts:1986-1997`. The tmux branch refuses with "Restart is waiting for the current work…
  to finish" (`:2009`). The structured branch calls `interrupt`, then `waitForIdle`, then `unload`, so
  an agent holding a restart grant can stop a **human's** running turn in that session. This follows the
  plan table, but it changes the authority semantics compared with tmux.
- Separately, `STRUCTURED_INTERRUPT_WAIT_MS` (10 s) equals the plugin's `interruptGraceMs` (10 s), so the
  host can give up at the same moment the plugin finalizes locally.
- Fix: decide explicitly. Either match tmux (refuse while `turnActive`), or keep the interrupt and make the
  host wait at least `interruptGraceMs` plus a margin.

### 7. LOW-MEDIUM. CONFIRMED (code). "Certainly not sent" transport errors are recorded as uncertain delivery

- `structured-session-service.ts:323-334`. `deliverAutomatic` maps every error except
  `PreviousTurnActiveError` to `failed`. The plugin reports both "session ended or client gone before
  write" and "process died after write" as `TransportUnavailableError` (`app-server-session.ts:394, 401`,
  `toTransportError`).
- The wake path (`session-manager.ts:888-897`) then saves `failed` and blocks the continuation with
  "delivery is uncertain…enable unattended work again". RunRecovery `submit` also ends as `stopped` (an
  uncertain outcome). The same applies to human input in `drainStructuredQueuedInput`.
- The window is small (the exit races the guard), but the result is sticky: unattended work stays blocked.
- Fix: throw a distinct `NotSentError` (or set a `sent:false` flag) for failures before `writeFrame`, and
  map it to `deferred` / requeue.

### 8. LOW. PLAUSIBLE. Steer error handling is regex-driven and can misclassify

- `structured-session-service.ts:77, 284-295, 384-390` and `session-manager.ts:4008-4016`.
  - A steer the server *refused* (for example `activeTurnNotSteerable`, or "thread not found") is
    rethrown, and the queue then marks it "Submission could not be confirmed", although nothing was
    delivered.
  - Conversely, `turnIsGone` returns true whenever `activeTurnId` changed during the await, even for an
    uncertain error such as a 60 s timeout. The text is then sent again as a new turn, which is a duplicate
    if the steer did land.
- Fix: add a contract error (for example `TurnNotActiveError`) in `types.ts` that the Codex plugin and the
  fake both throw, drop `TURN_GONE_PATTERN`, and treat only that error as "send as a new turn".

### 9. LOW. PLAUSIBLE. Background commands survive when `turn/completed` beats the interrupt response

- `app-server-session.ts:449-451`. `terminateBackgroundCommands` runs only if the turn is still open when
  the `turn/interrupt` response arrives. If `turn/completed(interrupted)` is processed first, tracked
  `commandExecution` processes are left running. Fixture `turn_interrupt_mid_tool` shows that such commands
  never complete on their own.
- Fix: terminate the tracked commands whenever an interrupt was requested, whatever arrives first.

### 10. LOW. PLAUSIBLE. A new turn after a local interrupt finalize can make the host lose track of a running turn

- `app-server-session.ts:688`.
  1. After the 10 s local finalize, Codex may still consider the turn active.
  2. `turn/start` on a busy thread "joins the active turn" (UNVERIFIED, brief §2). If its response carries
     the finished turn id, `onTurnStartResponse` returns early, no record is created, and the host's
     `startTurn` sees `terminalSeen` and stays idle while Codex works.
  3. The eventual `turn/completed` is dropped as a finished turn.
- Fix: if the response id is already finished, treat the turn as a fresh active record (or log and refuse),
  and cover it in the proof.

### 11. LOW. CONFIRMED (code). The user's own message echo counts as agent output

- `app-server-session.ts:876-893` emits `item.completed` for `userMessage` and `hookPrompt` items (kind
  `other`). `handleStructuredItemCompleted` (`session-manager.ts:4218-4230`) then sets
  `lastOutputAt=lastActivityAt=now`. A turn that fails right after the echo therefore records "output".
- Fix: skip `userMessage` and `hookPrompt` items in the plugin, or carry the kind into the callback and
  ignore user items for `lastOutputAt`.

### 12. LOW. CONFIRMED. Smaller gaps

- `grants/session-launches.ts:272`: `launch_session` never passes `transport`, so granted helpers are always
  tmux. This contradicts the plan's "launch … through the same bindConversation".
- `thread_closed` failures are marked `retryable:true` by the plugin (`app-server-session.ts:614`), but
  RunRecovery retries only three codes, so the flag is ignored.
- `STRUCTURED_SLASH_COMMAND` (`session-manager.ts:122`) rejects ordinary messages such as "/tmp is full".
- `handleStructuredConnectionLoss` puts the stderr tail, through `describeExit`, into conversation status
  lines. It is redacted, but noisy.

### Simplicity

- `spawnDetached` and `PluginContext.spawnScoped` (`session-manager.ts:181-195, 394`; `types.ts:85`) are dead
  code, and their `detached:true` would orphan children outside the cgroup if anyone used them. Remove
  them, or make them the pdeathsig launcher for finding 3.
- The structured config shape is defined three times (zod schema, `StructuredProviderConfig`,
  `CodexStructuredConfig`), plus `DEFAULT_PROVIDER_CONFIG`.
- `structuredMonitors.delete(...)` in suspend, idle sleep and restart is immediately undone, because
  `session.updated` re-watches the row with a new monitor. This churn is also the mechanism behind
  finding 1.
- Contract members the host never uses: `probe()`, `respond()` (a no-op), the `replay` plumbing (Codex
  never emits replay), and most capability flags. That is acceptable for future plugins, but none is
  exercised by a non-fake plugin.
- Doc drift (the W4 agent may already be fixing it): the plan diagram says "JSON-RPC over a Unix socket,
  launched in a systemd scope" and meta `socketPath`; the code is a stdio child with no scope.

### Test quality

These tests are good. The host seams are driven through the real SessionManager with a fake plugin, and
`structured-session-codex.test.ts` runs the real plugin against a scripted app-server. The plugin suite
covers the brief's gotchas: early `turn/started` adoption, queued turns, steer races, the interrupt grace,
background terminals, archived resume, subagent demultiplexing, process exit and replay fixtures.

Untested branches:
- findings 1, 2 and 3;
- `thread/closed` mid-turn through the host (failed terminal followed by a loss line);
- a non-race steer refusal through the queue;
- `deliverAutomatic` returning deferred inside a RunRecovery `submit`;
- restart of a running human turn.

`FakeTmux` cannot detect finding 4, because tmux's renaming happens only in the real binary. The fake's
`unload()` keeps the event stream open, unlike the real plugin, so host code that relies on `unload` ending
the stream would pass the tests and fail live.

---

## Verified OK (no need to re-check)

- **tmux guards.** All 36 SessionManager methods that call tmux or `queueCodexNotice` were checked. Each is
  unreachable for structured rows, through an early branch (`restoreSession :1798`, bind `:2198`, input
  `:2329/:2489/:2564/:2765`, profile `:3226/:3310`, suspend `:3566/:3654`, release `:3715`, screen `:3829`,
  refresh `:4471`, capture `:4956`), through structured-aware liveness (wake `:748/:779/:883`, recovery
  `:424/:463`, finished inbox `:588`, reconcile `:1279/:1291`, `isPressureSuspendable`), or because the
  helper is tmux-only (`closeRawLogPipes` filters on `rawLogPath`). Nothing outside SessionManager touches
  tmux.
- **tmux-row regressions, none found:**
  - `upsert` `coalesce(@transport, …)` keeps an existing row's transport, and new tmux rows default to
    `tmux`;
  - the schema 19 migration and row mapping;
  - the new `input-queue` fields are additive;
  - coordination `register`, `sendReceipt` and `reconcileProcesses` give identical results for tmux rows,
    because `structuredAssignmentAlive` returns undefined;
  - restart completion in `session-launches` is unchanged for tmux;
  - route pending reuse is unchanged, because structured pending aliases are never `isBound`;
  - the reconcile `restoreMissing` value for tmux is unchanged.
- **Pending-alias adoption ordering.** The route writes the pending row unbound, then
  `bindStructuredConversation` calls `adoptPendingConversation` (which rebinds the row to the thread id and
  sets the alias `isBound:false, adoptedConversationRef`). The route then skips its overwrite. A retried
  bind returns the owner, and title generation finds the alias through `getByAdoptedRef`.
- **Exactly-once terminal.** `finalizeTurn` is the only emitter and records `finishedTurnIds`; the host
  keeps a `terminalSeen` guard; `startTurn` never revives a finished turn; process exit produces
  error/stopped and the host clears the working state.
- **Server requests are always answered.** Five thread methods are declined with the right shapes
  (permissions `{permissions:{},scope:'turn'}`, elicitation decline, empty answers). Unknown methods get
  `-32601`, handler failures `-32603`, overload `-32001`, and subagent requests are declined.
- **Protocol mechanics match the brief:**
  - the reader starts before `initialize`, then `initialized` is sent, and "Already initialized" counts as
    success;
  - request ids count from 1 and are routed by frame shape;
  - `turn/start` parameters match the brief, and the policy is re-sent each turn;
  - `thread/resume` uses `excludeTurns`, with an unarchive-and-retry fallback;
  - a queued turn waits for `turn/started`;
  - the steer race maps to `TurnAlreadyCompletedError`;
  - interrupt applies the 10 s local finalize and terminates background terminals;
  - `thread/closed` is handled;
  - the line cap is 128 MiB, the stderr tail is 64 KiB with ANSI stripped, and frames are logged as
    method, id and size only.
- **Error and usage mapping.** camelCase `codexErrorInfo` maps to `server_overloaded`/`server_unavailable`;
  usage-limit merges are keyed by `limitId`.
- **Turn ids.** The rollout `turn_id` equals the app-server `turn.id`. Checked on host data: thread
  `01a175e0-757d…`, turn `01a175e0-7658-7eb1-9475-0f3f5e053a13`, found in both `thread/turns/list` and the
  rollout. `StructuredRunMonitor.read()` therefore prefers live state for the same turn.
- **RunRecovery.**
  - `processExited` is called only when the row was working and the work is unattended, so an idle
    connection loss never triggers recovery;
  - the retry codes are unchanged;
  - `canRetry` restores a structured row on demand and refuses while a turn runs;
  - the budget survives a reload.
- **Recency.** Replay events are ignored. Only provider-origin `turn.started` moves `lastActivityAt`. Only a
  completed terminal sets `lastResponseAt`. Restore, resume and loss handling set only `updatedAt`.
  `session.state` and notices never count as activity.
- **Model profiles.** The profile is applied when idle, deferred with `turn_running` and re-drained at the
  terminal. A sleeping row keeps the choice and the next load reads it.
- **Idle sleep and release.** Idle sleep is blocked by `turn_running` or `queued_input`. Pressure
  suspension skips structured rows. Release interrupts, then unsubscribes, and events received while
  `releasing` are ignored. A failed release keeps the binding.
- **Security.**
  - The spawn uses argv only and no shell, and the command is an argv array in config.
  - The app-server env strips `AGENT_CONSOLE_SESSION_ID` and `CODEX_THREAD_ID`.
  - A structured bind is refused with 400 when the lane is off, at both the route and SessionManager.
  - Images are refused at the route, SessionManager and plugin.
  - No new routes were added; only request bodies were extended.
- **Web.** Structured sessions hide Text Bypass, navigation keys, the terminal panel and image paste. Raw
  output is disabled, and Send, Stop and profile controls stay.

---

## Summary

1. The lane is well built. No structured row reaches tmux today. Terminal, steer and interrupt bookkeeping
   is correct, and the plugin follows the brief closely.
2. Two CONFIRMED high findings involve unloaded threads (both reproduced with scratch tests through the
   real SessionManager).
3. Finding 1: a cut turn makes an unloaded row look "working" from stale rollout state, and after idle sleep
   it stays that way, which blocks peer wakes.
4. Finding 2: a scheduled recovery, or a half-restored `starting` row, is orphaned by a backend restart,
   because reconcile never watches or restores rows whose thread is not loaded.
5. Finding 3 (PLAUSIBLE, high if true): under `KillMode=process`, a backend crash can leave the app-server
   running a turn, and recovery then resumes the same thread in a second process.
6. Finding 4 (CONFIRMED): the documented `structured:` tmux safety net does not exist on tmux 3.4.
7. Finding 5 (CONFIRMED): coordination marks structured workers disconnected after every restart and pages
   supervisors.
8. Finding 6 is a design call: a restart grant can interrupt a human's turn on structured rows, which tmux
   refuses.
9. The rest are low: uncertain-versus-not-sent classification, regex steer fallback, background-command
   cleanup ordering, the user echo counted as output, and missing launch support.
10. Suggested order: findings 1 and 2 (small changes in SessionManager), 3 (pdeathsig wrapper and proof
    check), 4 (tmux-client guard), then 5 and 6 after a decision.
