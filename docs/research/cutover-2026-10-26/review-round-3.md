# Review round 3: `59fde29` "Fix cutover review round 2" (`8a5a785..59fde29`)

Read-only review in `/home/bryan/code/agent-console-wt/structured-providers-20261026` (branch `feature/structured-claude-cutover`,
HEAD `59fde29`, clean tree). I ran no tests, builds, proofs or providers; every claim below comes from reading the code at
`59fde29`. No proof evidence produced on `59fde29` is committed: the newest evidence (`codex-proof-2026-10-26T18-37-31Z.json`,
`claude-proof-2026-10-26T18-36-00Z.json`) is from `e7e0a2a`. So nothing in this commit is proven against the real CLIs.

Line numbers are `59fde29`. `session` = `apps/server/src/providers/transport/codex/app-server-session.ts`, `instance` =
`.../codex/app-server-instance.ts`, `manager` = `apps/server/src/sessions/session-manager.ts`, `service` =
`apps/server/src/sessions/structured/structured-session-service.ts`.

---

## N1. Codex Stop after a restart leaves the command running: PARTIAL (fixed in code, unproven on the real CLI, no fallback)

- **The fix.** `adoptRunningTurn` now awaits `trackRunningCommands` (session `:940-962`). It reads the turn's items with
  `thread/items/list {threadId, turnId, limit: 100, sortDirection: 'desc'}` (up to 10 pages, 10 s per call, `:965-990`) and the
  thread's background terminals (`:993-1000`). Each `commandExecution` item with `status: 'inProgress'` goes into
  `record.commands` (item id to process id), with the process id from the item or, if the item has none, from the terminal
  that has the same `itemId`. The unknown-turn path starts the same lookup in the background (`:1304-1306`).
- **Item shape.** It matches `protocol.ts`: `ThreadItemEntry {turnId, item, startedAtMs, completedAtMs}` (`protocol.ts:279-284`),
  `commandExecution.processId: string | null` and `status` (`:164-177`), and `CodexBackgroundTerminal.itemId/processId`
  (`:319-327`). It also matches `docs/research/codex-app-server-2026-10-26/protocol-brief.md:141-144`.
- **Into the interrupt.** `interrupt` calls `terminateBackgroundCommands(record)` (`:1262-1288`), which sends
  `thread/backgroundTerminals/terminate {threadId, processId}` for each tracked process id that is still in the live list. That
  is the right call and the right shape. Frames are held while `adopt` runs, so an `item/completed` that arrives during the
  listing is applied afterwards and removes the command again (covered by the test "does not end a command that finished while
  the turn was being adopted").
- **When the listing finds nothing in progress.** Nothing is tracked. Stop ends the turn and the command keeps running, which
  is the round-2 behaviour. Nothing tells the person, and the log line is written only when `items.length > 0` (`:961`). The
  live terminal list is already fetched (`terminals`), but it is used only to fill a missing process id. It is never used as
  the fallback round 2 proposed ("for an adopted record, terminate every live background terminal of the thread").
- **Unverified.** Whether `thread/items/list` on codex-cli 0.164 returns a running command as an `inProgress` item while its turn
  runs. The brief only records completed items ("it returned full `commandExecution` items, including `aggregatedOutput`").
  Every test uses the scripted app-server (`structured-codex-restart.test.ts:248-329`,
  `structured-session-codex-restart.test.ts:177-200`). The stricter k2 (`prove-structured-codex.mjs:792`, 5 s) would catch it,
  but it has not been run on this build.
- **Smaller races, acknowledged in comments.** In the background path, a Stop before the listing returns finds no commands, and
  commands added after `terminateBackgroundCommands` ran are never ended. A stale listing can add a command again after its
  `item/completed`. That is harmless, because terminate is filtered against the live list.

## N2. Codex async questions make no card: PARTIAL (mapping fixed and tested on a fixture, not shown on the real CLI)

- **The fix.** `asyncQuestions` (session `:322-332`) maps `[{title, options?}]` to `{id: 'q<n>', question: title, options:
  [{label}], allowCustom: true}`. `onItemCompleted` calls `openMessageQuestion` for an `agentMessage` with `delivery: 'async'`
  and non-null `questions` (`:1369`, `:1380-1394`).
- **Missing or empty options.** `null`, `undefined` and `[]` give an empty option list with a typed answer (tested). An option
  that is not a non-empty string rejects the whole item and raises one warn notice per item id. An empty `questions` array is
  ignored. A `questions` value that is not an array raises the notice.
- **Duplicates.** `item/started` is not mapped. A repeated `item/completed` is deduplicated by `item:<itemId>` in the
  session's set. Across a restart there is no duplicate, because `ReplayGate` never hands replayed frames to a session. The
  reverse is a gap (see new finding L5): the card does not come back.
- **The answer.** It is sent as an ordinary message (service `:657-670`, `answerMessage` at `:205-212`), steered into the open
  turn when there is one. In the test, the steer reaches `turn/steer` as `input: [{type: 'text', text: 'Answer to your question:
  …'}]` with `expectedTurnId` (`structured-codex-requests.test.ts:337-341`). Nothing is owed to Codex as a JSON-RPC reply, and
  no answer is sent through `respond`.
- **Evidence.** The code comment (session `:1377-1378`) and the docs say the frames were "recorded in
  docs/research/cutover-2026-10-26/". No such recording is in the tree: that directory holds only proof JSON (with no
  `agentMessage`/`delivery` frames) and the reviews. The fixture in `structured-codex-requests.test.ts:282-305` is the only copy.
  Step h2 is now strict (`prove-structured-codex.mjs:557`: it fails when Codex accepted the call and no card appeared), but it
  has not been run on this build. `structured-cutover.md:789` marks N2 "closed". Its own line 733 lists the corrected card as
  not proven by any run.

## N3. Pre-write failures retried for ever: FIXED (with low residuals, see L3 and L4)

- **Claude.** `beforeWrite` (`claude-session.ts:652-667`) keeps `NotSentError` for `ClaudeExitError`,
  `ClaudeControlTimeoutError` and transient errno values (`:274-277`). Everything else becomes `SendRejectedError`
  (`types.ts:238-244`): a `ClaudeControlError` refusal, ENOENT or EACCES, and `ImageFitError`. Steer goes through the same
  function.
- **Manager.**
  - The drain marks `SendRejectedError` `failed` with its reason (manager `:4496-4499`).
  - The direct send maps it to `SessionInputRejectedError` "... Nothing was sent." (`:4382-4386`).
  - The answer route uses the same mapping.
  - `NotSentError` and `StructuredUnavailableError` are retried while `notSentSince` is younger than 10 minutes (`:4484-4494`).
    A busy turn resets the clock (`:4478-4482`), and so does a successful submit (`:4475`).
- **Can the cap drop a message that was sent?** No. The cap fires only inside the `NotSentError`/`StructuredUnavailableError`
  branch. Every throw site of those two errors is before a write:
  - Codex: `:542`, `:551`, `:565` (`!error.sent`), `:572-593`.
  - Claude: `:442`, `:612`, `:659`, `:704`.
  - Service: `requireLoaded`, `instanceFor`.
  An uncertain write still ends as "Submission could not be confirmed".
- **Where the reason goes.** It reaches the row, as the queue record's `reason`, projected as `needs_review`. It is not written
  to the transcript or the event log. For the 10-minute failure, the reason is generic and drops the underlying error.

## N4. A slow host at adoption gets its turn declared lost: PARTIAL

- **Fixed for a slow session host.**
  - Codex `reattach` turns `unreachable` into `TransportUnavailableError` (instance `:437-446`).
  - The service records `busySurvivors` (service `:341-363`).
  - `adoptStructuredSurvivor` returns `'busy'` (manager `:4219-4240`).
  - The refresh path returns before `settleLostStructuredTurn` (`:4573-4576`).
  - A status line is written once, after 3 consecutive busy lookups (`:4235`).
  - The tests cover both process models (`structured-session-adoption.test.ts:173-238`).
- **Not covered: a slow app-server.**
  - On reattach, `startClient` calls `confirmInitialized` (`account/read`, 30 s).
  - If that times out, `client.close({ terminate: true })` (instance `:610`) ends the host and the shared app-server, so every
    running Codex turn and command is killed.
  - The `JsonRpcTimeoutError` is then not a `TransportUnavailableError`, so the row is reported absent and the turn lost.
  - This code predates the commit (`8a5a785` `:579`), but it is the slow-host-under-swap scenario that N4 is about (see L1).
- **Too broad for Claude.** "Busy" means any `TransportUnavailableError` with no cap. For Claude that includes handshake
  failures, not only `unreachable` (see M3).

## N5. The unlisted-turn fallback does not apply at the manager, and the buffer drops the turn's end: PARTIAL

- **The buffer: fixed.** Past 4096 held frames, `turn/started`, `turn/completed`, `thread/status/changed`, `thread/closed` and
  `serverRequest/resolved` are still kept (session `:442`, `:717`). There is a test with 4300 deltas.
- **The manager fallback: fixed at adoption only.** `turnUnidentified` (session `:528-530`, `types.ts:89`) makes the manager
  schedule the working expiry instead of `settleLost` (manager `:4245`), and makes the screen read "working" (service `:704`).
  Nothing else reads it (see L2):
  - the 60 s working expiry clears `isWorking`;
  - Stop is a no-op;
  - a message or a wake is sent as `turn/start` into the active thread.
- **Residual.** `item/completed` is not an essential frame, so a flood can still drop an async question's item during
  adoption.

## N6. Replay past a timed-out `status` reaches the client as live output: FIXED

- `HostLineTransport` now passes the host `seq` with every line, and queued lines keep it (`line-transport.ts:112-183`,
  `:588`).
- `separateReplay` sorts lines by `seq <= newestSeq` (instance `:664-679`), and `ReplayGate` drops any later line at or below
  the boundary (`:256-259`). `absorbReplay` uses the real `seq` instead of `firstSeq + index` (`:699-700`).
- **The boundary is inclusive and correct.** In the host, `ReplayBuffer.seq` is the last line pushed: the counter starts at 0,
  so the first line is 1. The welcome sends that value, then the replay (every entry at or below it), then live lines, which
  are strictly greater (`session-host.ts:280-328`, `:776-796`).
- **Empty buffer.** `newestSeq = lastSeq`. No line is replay, and the first live line is `lastSeq + 1`, which passes. For a fresh
  host, `newestSeq = 0` and the first line is seq 1. There is no off-by-one.

## N7. `resume` restarts any Claude chat whose transcript holds no conversation: PARTIAL

- **The fix.** A meta record `claude-turns:<conversationId>` is written when a session's first turn completes
  (`claude-session.ts:1269-1276`, `claude-instance.ts:645`, `:459-476`). With that record, `resume` throws `ResumeFailedError`
  "... is gone ... Start a new conversation." (`claude-instance.ts:370-372`).
- **Lifetime.** The record survives a sleep. It is removed on release (service `:493`, `:508-513`) and by the orphan sweep
  (`:561`).
- **Rows that are not protected** (see M2):
  - every row migrated from tmux (the migration flips the row in place and does not seed the record; manager `:4141-4150`);
  - every structured row whose turns completed before this build.
- **The resulting row.** `restoreStructuredSession` records a restore failure. The row becomes `status: 'error'` with the
  reason as a status line, and the line is not repeated (manager `:1686-1705`). It can be recovered: the person can release it
  or start a new conversation. A message typed into it waits in the queue ("Waiting for the original session to be available")
  rather than failing. That is how error rows already behave.
- **Unverified.** `--session-id` beside a transcript that holds only preamble.

## N8. Gaps in the k2 assertions: PARTIAL

**Fixed:**
- Codex k2 needs the command gone within 5 s of Stop (`prove-structured-codex.mjs:792`).
- Both k2 steps now have the agent mark its assignment unattended before the restart, so "no recovery" means something.
- Both proofs send a mid-turn message during an adopted turn and require `deliveryMode: 'steer'` (phase 2).

**Still open:**
- Claude k2 (`prove-structured-claude.mjs:640`) and Codex step h (`prove-structured-codex.mjs:512`) still wait 20 s for the
  command to end. That is the margin round 2 objected to.
- The exactly-once terminal is still not counted.
- The phase-2 check "the steered message must not be answered while the count still runs" runs right after the send, so it
  cannot fail.
- `docs/agent_docs/running_tests.md` describes k2 without the steer phase or the 5 s rule.
- None of these proofs has been run on this build.

## N9. Unused `started` flags: FIXED

`ManagedLineTransport.started`, `StdioLineTransport.started`, `HostLineTransport.started` and its assignment,
`transportWasStarted` and `ReplayGate.started` are removed (`line-transport.ts` diff; instance `:229-238`), along with their test
assertions (`structured-session-host.test.ts`). No reference remains in `apps/server/src` or `apps/server/test`. The two
remaining `record.started` sites are the turn record, which is unrelated.

## N10. Attach-only and ordinary starts share one start promise: FIXED

- `starting` now carries `attachOnly` (instance `:299`, `:529-550`).
- An ordinary caller that finds a failed attach-only attempt (`LineTransportNotRunningError`) loops and starts its own. The
  `done` handler is registered before the caller awaits, so `starting` is cleared first and the loop cannot spin.
- An attach-only caller that waits on an ordinary attempt uses that attempt's connection. That connection may have started an
  app-server, so the outcome is correct but not "starts nothing", as the comment admits.
- **Reattach is attach-only end to end.** `reattach` uses `resumeThread(..., attachOnly=true)` (instance `:437-446`, `:452-455`).
  The only caller of `instance.reattach` is `service.reattachSurvivor` (service `:374`). `ensureLoaded` uses `resume`, which
  is ordinary. Nothing else relied on `reattach` starting an app-server or creating a thread.

---

## New findings

### M1. MEDIUM. The docs added in this commit describe the round-2 bugs as current behaviour

The commit adds or keeps prose that the code at `59fde29` contradicts:

- `docs/architecture.md:685`: "Known gap: Codex Stop on an adopted turn does not end a command that started before the
  restart."
- `docs/structured-cutover.md:469-470`: "the manager has no 'busy' result, so a slow host still gets its running turn declared
  lost".
- `docs/structured-cutover.md:478-481`: refusals throw `NotSentError` and are "retried every second for ever".
- `docs/structured-cutover.md:785-806`: the open follow-ups list N1 and N3 to N10 as open. N6, N9 and N10 are fixed, and N1, N3,
  N4 and N7 are changed.
- `docs/structured-providers.md:484-488`: `NotSentError` is used for refusals and retried for ever. The same file documents
  `SendRejectedError` at `:256` and `:404`, so it contradicts itself.
- `docs/structured-providers.md:670-677`: N1, N4 and N5 are described as current limits.

**What breaks.** Bryan's integration review reads these docs and will see N1 and N3 as unfixed, and the shipped contract
(`SendRejectedError`, `turnUnidentified`, the busy result, the 10-minute cap) is not described where the docs describe
behaviour.

**Fix.** Rewrite these passages to the `59fde29` behaviour, and mark N1 and N2 as unproven on the real CLI until k2 and h2 run.

### M2. MEDIUM. The N7 guard does not cover migrated rows, which are the main population at cutover

**Where.**
- `claude-instance.ts:370` relies on `claude-turns:<id>`.
- That record is written only by `onTurnCompleted` of a structured `ClaudeSession` (`claude-instance.ts:645`).
- `migrateToStructured` flips the row in place (manager `:4141-4150`) and does not write the record, although the migration
  only moves Claude rows that have a transcript.

**Failing scenario.**
1. A tmux Claude conversation whose transcript is 25 days old is migrated at the flip.
2. It sleeps without running a structured turn.
3. More than 5 days later, any `claude` start deletes transcripts older than `cleanupPeriodDays` (30 by default).
4. The next message resumes the row. `transcriptHasConversation` is false and `conversationRan` is false, so the CLI is
   relaunched with `--session-id <same id>` and the history is dropped. The person gets only an info notice.

This is exactly the case N7 described. Rows that completed turns on an earlier structured build are equally unprotected.

**Fix.**
- Write the record in the migration (and for any structured row that has `lastResponseAt`).
- Or decide from host-side evidence, as round 2 proposed: `lastResponseAt`, or user input in the event log.

### M3. MEDIUM. "Busy" is any `TransportUnavailableError` and has no limit, so a working row can be wedged with Stop a no-op

**Where.**
- `service:350` marks busy on any `TransportUnavailableError`.
- For Claude, `toTransportError` (`claude-instance.ts:206-214`) turns `ClaudeExitError`, `ClaudeControlTimeoutError` and
  `ClaudeControlError` from the reattach handshake (`bringUp`) into `TransportUnavailableError`, not only the `unreachable`
  case at `:586`.
- While a row is busy, `refreshStructuredSessionState` returns undefined (manager `:4575`). The row is never settled and never
  restored.
- `service.interrupt` finds no loaded state and returns `idle` (service `:616-619`), so Stop changes nothing and `isWorking`
  stays true.
- Every screen poll (once a second per open page) reconnects to the host and runs the handshake again.

**Failing scenario.** A Claude survivor whose repeated `initialize` keeps timing out or being refused, or a hung host (stopped,
or deadlocked after accept). The row reads "working" for ever, Stop does nothing, wakes are deferred, and only release clears
it. Before this commit the same row was declared lost, then failed its restore with a reason.

**Fix.**
- Mark busy only for `unreachable`, using a dedicated error class or reason.
- Bound the busy run, for example after N lookups or M minutes. Then settle the row as lost or unavailable with the reason, and
  let Stop clear `isWorking` on an unloaded row.

### M4. MEDIUM. The N1 fix has no fallback, and nothing shows it works on 0.164 (see N1)

If `thread/items/list` does not list a running command as `inProgress`, Stop after a restart again leaves the command running,
with no notice and no info log (session `:954-962`). The live terminal list it has already fetched is ignored as a fallback.

**Fix.**
- Run k2 on this build.
- If the items come back empty, fall back to the thread's live background terminals for an adopted record (or ask Bryan
  whether that is acceptable), and log at info.

### L1. LOW (pre-existing, N4 scope). A reattach to a slow app-server terminates it

`confirmInitialized` times out after 30 s (instance `:801-809`). `startClient` then calls `client.close({terminate: true})`
(`:610`), which tells the host to end itself and the shared app-server (`line-transport.ts:550-571`). Every running Codex turn
and command ends. The turn is then reported lost, because a `JsonRpcTimeoutError` is not busy. The same code is in `8a5a785` at
`:579`.

**Fix.** For a connection to a host that is not fresh, disconnect instead of terminate, and report busy.

### L2. LOW. `turnUnidentified` is honoured only at adoption

- `providerTurnIsWorking` reads `turnActive` (manager `:1210`). So a turn that is silent for 60 s (a quiet build) has
  `isWorking` cleared while the screen still says "working" (service `:704`).
- Stop is a no-op until the first event names the turn: `service.interrupt` needs `activeTurnId`.
- A message or a wake in that window reaches `sendTurn`, which checks only `activeTurnId` and `pendingStart` (session
  `:542-543`), and is sent as `turn/start` into a thread that is running a turn.

The trigger needs `thread/turns/list` to fail or to omit the turn.

### L3. LOW. The 10-minute clock counts deferrals and downtime

- `notSentSince` is kept in meta. `defer` keeps it (manager `:2678-2683`) and only `submitted`, a busy turn or a reject clears
  it.
- **Scenario.** The first attempt gets `NotSentError` (the process exited during preparation). Then 10 minutes pass with the
  session not loadable (a memory floor, or a deploy). The first transient `NotSentError` after that fails the message at once.
- The final reason ("Check the conversation before sending it again") drops the cause, and suggests a doubt about delivery
  where none exists.

No sent message can be dropped (see N3).

### L4. LOW. A `SendRejectedError` in automatic delivery is reported as an uncertain delivery

`deliverAutomatic` (service `:633-644`) defers only `PreviousTurnActiveError` and `NotSentError`. A refused model in a wake or
recovery prompt now gives `failed`, so recovery stops as "outcome uncertain" and continuation is blocked, although nothing was
sent. Before this commit the same case was `NotSentError` and was deferred.

**Fix.** Map it to a definite failure that names its reason.

### L5. LOW. Codex message-mode cards do not survive a backend restart, and the docs say they do

- At register, the stored list is overwritten with the new, empty state (service `:874`, `:930-934`). Only held
  server-request questions are adopted again (session `:1035-1051`).
- An async question whose `item/completed` arrived while no backend listened is never shown: `absorbReplay` reads only
  `THREAD_SERVER_REQUESTS`.
- `architecture.md` ("The stored list is deleted at boot and comes back through re-adoption") is true only for held questions.

The model keeps polling and the person sees no card. The question text is still in the conversation as an assistant item.

### L6. LOW. The evidence path the code cites does not exist

`app-server-session.ts:1377-1378`, `structured-cutover.md:504-515` and `:705-707` say the async-question frames were captured
from the real app-server and recorded in `docs/research/cutover-2026-10-26/`. Nothing there holds them.

**Fix.** Commit the capture, or point to the test fixture and say it was transcribed.

---

## Overall verdict

Fixed: N6, N9 and N10, with correct boundaries and no regressions found in the line-transport, replay or start-promise
changes. Fixed with low residuals: N3. The cap cannot drop a sent message, and the reason reaches the queue row.

Partial: N1, N2, N4, N5, N7 and N8. The N1 and N2 fixes are coded against shapes taken from the protocol brief and an
uncommitted capture. Only scripted fakes test them, and no proof has been run on `59fde29`. N1 also has no fallback when the
item listing finds nothing.

New problems introduced by the commit:
- the new busy state can wedge a working row with no limit (M3);
- the N7 guard misses every migrated row (M2);
- the docs it adds still describe N1, N3, N4 and the others as unfixed, and contradict the new contract (M1).

The tmux path is unaffected: every change is on the structured path or the session-host line plumbing.

Not ready for Bryan's integration review until:
- k2 and h2 are run on this build and their evidence committed;
- M1 to M3 are fixed;
- N1 gets a fallback, or Bryan accepts the risk.
