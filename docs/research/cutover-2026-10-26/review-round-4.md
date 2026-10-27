# Review round 4: `4c79237` "Fix cutover review round 3" and `b2e6e5e` docs (`59fde29..b2e6e5e`)

This was a read-only review in `/home/bryan/code/agent-console-wt/structured-providers-20261026`, on branch
`feature/structured-claude-cutover`. I ran no tests, builds, proofs or providers. Every claim about behaviour comes from reading
the code.

Two reads went outside the diff:
- the docs and evidence committed on the branch;
- one real Codex rollout under `~/.codex/sessions` (codex-cli 0.163.0), read for the shape of its `task_*` and
  `turn_aborted` records only.

During the review, HEAD moved to `f54460f` "Record the proof runs on the round 3 build". That commit changes no code. It adds:
- proof evidence with `revision: "b2e6e5e"`;
- a "Round 3 run" paragraph in `structured-cutover.md`.

| Proof | Result |
|---|---|
| `claude-proof-2026-10-27T03-30-52Z.json` | 14 of 14 |
| `codex-proof-2026-10-27T03-33-03Z.json` | 16 of 16 |
| `migration-proof-2026-10-27T03-35-02Z.json` | 9 of 9 |

I read that evidence and use it below.

Line numbers:
- Code lines are the same at `b2e6e5e` and `f54460f`.
- Doc lines are at `f54460f`. In `structured-cutover.md`, every line after 604 is 20 higher than at `b2e6e5e`.

Short names used below:
- `session` = `apps/server/src/providers/transport/codex/app-server-session.ts`
- `instance` = `.../codex/app-server-instance.ts`
- `claude` = `.../claude/claude-instance.ts`
- `manager` = `apps/server/src/sessions/session-manager.ts`
- `service` = `apps/server/src/sessions/structured/structured-session-service.ts`

---

## M1. The docs describe the round 2 bugs as current behaviour: PARTIAL

**Fixed.** Every passage that round 3 listed was rewritten:
- `architecture.md:686-689`;
- `structured-cutover.md:468-486` and `:829-867`;
- `structured-providers.md:507-518` and `:698-711`.

`running_tests.md:307,313,349,355` now describes the 5 s rule, the steer phase and the exactly-once counts. With `f54460f`, the
claim that N1 is fixed (`architecture.md:686-687`) is backed by a real-CLI run.

**Still contradicts the code:**
- **"The connect was refused."** `structured-cutover.md:468` and `structured-providers.md:517` describe busy as "the connect was
  refused or no hello came back". In the code, a refused connect is `absent`, not `unreachable` (`line-transport.ts:886-889`).
  Only a connect timeout or a hello timeout is `HostUnresponsiveError` (`line-transport.ts:417`, `:495`).
- **"Reported absent with its reason."** `structured-cutover.md:471-472` says "A handshake that fails after the connection was
  made is a plain failure, and the row is reported absent with its reason". Both halves are wrong:
  - for Codex, a timed-out handshake check is busy (`instance:614-619`);
  - the loss line uses the generic default reason (`manager:4692`), and the reattach error goes only to the log (`service:358`).
- **"Only when the host is unreachable."** `structured-cutover.md:839` says busy is "raised by both plugins only when the host
  is unreachable". Codex also raises it after a timeout of `initialize` or `account/read` on an attach-only or not-fresh
  connection, on ordinary starts too (`instance:614-619`). See R4-3.
- **"Never."** The plugin contract says a timeout after the connection was made is "never" busy:
  - `types.ts:184-186` and `:321-325`;
  - their verbatim copies in `structured-providers.md:350-352` and `:487-491`.
  The Codex plugin breaks this rule (`instance:614-619`).
- **"Until the 10-minute limit."** `structured-cutover.md:856-857` says an ordinary start against a hung app-server "reports
  busy until the 10-minute limit". No limit applies to that path. See R4-1.

**Stale or missing:**
- **Present tense.** `structured-cutover.md:459` ("One gap: the counting command was gone only 19.9 s after Stop") and `:782`
  ("For Codex one part is not fixed") still describe N1 in the present tense, in the behaviour and history sections.
- **Status line.** `structured-cutover.md:4-6` still says "proven … after review rounds 1 and 2". It does not mention the round
  3 run that `f54460f` records at `:607-625`.
- **A missing file.** `structured-cutover.md:818` cites `docs/research/cutover-2026-10-26/review-round-3.md`. That file is not
  in the tree: only `review-round-1.md` and `review-round-2.md` are.
- **Undocumented behaviour.** `architecture.md` says nothing about two behaviours the person sees:
  - the busy wait and its 10-minute settle;
  - the status line "Stop could not reach the agent process…".

## M2. The deleted-transcript guard misses migrated rows: FIXED

- **Migration.** `manager:4165` calls `structured.noteConversationHistory(session)` before `setTransport` (`manager:4167`).
  - A throw propagates out of `migrateTmuxRowToStructured`.
  - The caller catches it and returns `'busy'` (`manager:1384-1387`), so the row stays on tmux. Its tmux session was already
    ended for an `idle` row, so the next pass classifies it `dead` and tries again.
  - The record is also written when `setTransport` then returns nothing. That is harmless, because only a structured resume
    reads it.
- **First reconcile pass.** `noteStructuredConversationHistory(restorable)` runs once per boot (`manager:4309`, behind
  `survivorsReattached`). It covers each structured row with `lastResponseAt`, each in its own try/catch
  (`manager:4337-4349`).
- **Service.** `service:520-524` skips `pending:` ids. It calls the optional plugin method with
  `resumeConversationRef ?? conversationRef`, the same id `resume` uses (`service:321`).
- **Idempotent.** `claude:466-478` goes through `noteConversationRan`, which returns early when a record with the same session
  id exists.
- **Codex.** `CodexAppServerInstance` has no `noteConversationHistory`, so the optional call does nothing.
- **Tests.**
  - The Claude plugin: `structured-claude-plugin.test.ts:1378-1403`.
  - The service: `structured-session-survivors.test.ts:403-438`.
  - The manager (migration, boot pass, a plugin without the guard): the new `describe` in
    `structured-session-adoption.test.ts`.
- **On the real CLI.** The migration proof on `b2e6e5e` passed 9 of 9.

## M3. "Busy" covered any failure and had no limit: FIXED for Claude; Codex has a second busy source (R4-1, R4-3)

**Claude.**
- `TransportBusyError` is raised only from `none()`, and only when a connect attempt returned `unreachable` (`claude:588`,
  `:597`).
- A failure after the connection was made detaches a survivor that is not fresh (`claude:669-679`). It then throws the ordinary
  error from `startupError` (`claude:733-758`).

**Codex.**
- `reattach` raises it for `unreachable` (`instance:445`).
- `startClient` also raises it when a `JsonRpcTimeoutError` hits the handshake on an attach-only or not-fresh connection
  (`instance:614-619`). That is the L1 fix, and it also applies to ordinary `resume` and `start` connections.
- So "only for an unreachable host" is false for Codex.

**Service.** It marks a row busy only for `TransportBusyError` (`service:357`).

**The 10-minute budget.**
- A run starts at the first busy lookup with `since = Date.now()` and is kept across lookups (`manager:4258-4260`).
- It is deleted in these cases only:
  - a lookup that is not busy (`:4255`);
  - an adoption (`:4271`);
  - Stop (`:4491`);
  - release (`:3932`);
  - shutdown (`:1120`);
  - the refresh after `unanswered` (`:4649`).
- `unanswered` keeps the run, so the startup sweep cannot restart it (`:4262-4265`).
- No lookup restarts the clock. The only reset is a lookup that is not busy, and in refresh that settles the row as lost
  anyway.

**Settled once.**
- `unanswered` calls `settleLostStructuredTurn(session, lostReason)` and then `handleStructuredConnectionLoss`
  (`manager:4658`, `:4696-4706`), which clears `isWorking`.
- Later refreshes skip the lookup branch, which needs `isWorking` (`manager:4639`).
- The row gets one loss line. Recovery is scheduled when the assignment is unattended (`:4706`).

**Stop.**
- `service:639` returns `notLoaded` for any state that is not loaded.
- `manager:4470` then calls `settleUnreachableStop` (`:4486-4496`), which returns at once for a row that is not working. A
  repeated Stop therefore writes no second line (tested: "does it once").
- No recovery is started.

**tmux untouched.**
- Stop reaches the new code only through `sendStructuredKeystrokes`, after the transport branch (`manager:2919-2921`).
- The rejected-wake and `defer` changes only change behaviour when `rejection` or `notSentSince` is set. Both are set on the
  structured path only (`manager:1075`, `:2700`).

**Residual 1: an error row in between.**
1. After Stop or `unanswered`, the next screen poll restores the row (`refreshStructuredSessionState` with `restoreMissing`,
   `manager:4659-4672`).
2. The resume meets the same silent host.
3. The row becomes `status: 'error'` with "Failed to restore session: … did not answer in time; try again in a moment"
   (`manager:4600-4622`, `:1705-1724`).
4. The reconcile pass retries error rows (`manager:1476`), and the process is adopted again once it answers.

This matches the status line ("picks the process up again"), but the person sees an error row in between.

**Residual 2.** A slow Claude CLI handshake is now declared lost, while Codex in the same position is busy. See R4-4.

## M4 / N1. Codex Stop after a restart leaves the command running: FIXED, and proven on the real CLI by the `b2e6e5e` run

**Every terminal is tracked.**
- `trackRunningCommands` (`session:983-997`) adds every terminal from `thread/backgroundTerminals/list` that has a string
  `itemId` and `processId`, unless `record.commands` already has that item.
- In-progress items are a second source, and only when the item carries a `processId`.
- Outcomes are logged at info. A failed terminal listing is logged at warn (`:1026-1034`), and "could not list" is kept apart
  from an empty list.

**The unknown-turn background path** calls the same function (`session:1332-1342`).

**A held `item/completed`.**
- In the adopt path, frames are held while `adopting` (`session:741-745`) and dispatched after `trackRunningCommands` returns
  (`:932`). `onItemCompleted` then deletes the command (`:1391`), so it is removed. This is tested ("does not end a command
  that finished while the turn was being adopted").
- The background path holds no frames, so a stale listing can add back a command that already finished. The comment at `:987`
  claims otherwise. It is harmless, because terminate is filtered against the live list (`:1304-1306`).

**Termination.** `terminateBackgroundCommands` (`session:1296-1319`) sends `thread/backgroundTerminals/terminate {threadId,
processId}` for every tracked id that is still listed. When the listing fails, it sends it for every tracked id. It is called
from each exit of `interrupt` (`:621`, `:630`, `:639`).

**The fake.** It models the probe:
- `completedOnly()` lists only `userMessage` and `agentMessage` items;
- `terminalsList()` lists the command only in the terminal list, with `osPid: null`, and still lists it after
  `turn/interrupt`.

Both helpers are in `structured-codex-restart.test.ts`. `structured-session-codex-restart.test.ts:178-187` does the same.

**On the real CLI.** The `b2e6e5e` run passed Codex k2 (`codex-proof-2026-10-27T03-33-03Z.json:206-250`):
- the command was gone 327 ms after Stop (`commandGoneAfterMs: 327`);
- one aborted turn after Stop;
- one completed turn after the next message;
- the message sent during the adopted turn was delivered as a steer, unanswered 2.36 s into the count, and answered after it;
- no recovery or wake text.

**Cost.** On 0.164 the item listing never names a running command. It still makes up to 10 requests of 100 items per adoption
(`session:999-1022`), with frames held for that time.

**A decision for Bryan.** Stop now ends every live terminal of the thread, not only the commands of the turn. See R4-2.

## L1. A reattach to a slow app-server terminates it: FIXED, with a regression (R4-1)

**Disconnect, not terminate.** `instance:614-619`: for an attach-only or not-fresh connection, a `JsonRpcTimeoutError` from
`initialize` or `account/read` (both inside the try at `:606-612`) now:
- closes the client without `terminate`;
- logs a warning;
- throws `TransportBusyError`.

The terminating path at `:621` remains for every other error and for a fresh start.

**Replay separation.**
- `instance:586` separates the replay when `replayWanted || attachOnly`.
- `openHostTransport` (`:781-791`) asks for the full buffer in both of those cases, so the condition now matches the request.
- An ordinary start (`attachOnly` false) is unchanged, so no ordinary fresh start is newly treated as replay.

**A stale response can still match a new request.**
- The busy path leaves the app-server running, so the answer to the abandoned connection's timed-out request can arrive after
  the next connection's welcome.
- Its `seq` is above `newestSeq`, so `ReplayGate` passes it as live (`instance:256-259`).
- It can resolve the new client's request with the same id, because ids restart at 1 (`jsonrpc.ts:194`, `:404-424`).

See R4-5.

## L2. `turnUnidentified` is honoured only at adoption: PARTIAL

**Fixed.**
- **Sends.**
  - `sendTurn` refuses while the turn is unidentified (`session:545`).
  - The drain treats `PreviousTurnActiveError` as a wait that resets the not-sent clock (`manager:4548-4552`).
  - `deliverAutomatic` defers (`service:667`).
- **Stop.**
  - The service passes `''` when `activeTurnId` is undefined and the transport is unidentified (`service:642-645`).
  - The session routes an unknown id to `interruptUnidentifiedTurn` (`session:609`, `:645-661`). It lists the turns again and
    checks the two races: the first event named the turn (`:648`), or the thread went idle (`:650`). It then adopts the running
    turn and interrupts it.
- **Tests.** All three cases are in the new `describe` "while the running turn is unidentified".

**Not fixed: the working expiry.** The 60 s working expiry still clears `isWorking` while the turn is unidentified:
- `providerTurnIsWorking` reads only `turnActive` (`manager:1225-1229`);
- the expiry is scheduled at `manager:4283`;
- the screen still reads "working" (`service:731`).

**New residuals.**
- **A Stop that is dropped.**
  - The transport adopts the turn from its first event, but the service has not yet read the `turn.started` from the channel.
  - At that moment `state.activeTurnId` is undefined and `transport.turnUnidentified` is false, so `service.interrupt` returns
    `idle` (`service:642-644`).
  - The Stop is dropped with no message. The window is only as long as the channel lag.
- **A listing that succeeds does not clear the flag.**
  - A Stop whose listing succeeds but shows no running turn leaves `adoptUnknownTurn` true (`session:651-656`). Sends stay
    refused until a `thread/status/changed` arrives.
  - `listRecentTurns` also returns `[]` on error (`:959-962`), so the code cannot tell a failed listing from no running turn.
- **Repeated notices.** Each Stop that finds nothing adds another warn notice.

## L3. The 10-minute clock counts deferrals and downtime: FIXED as designed, residual low

- The failure reason now names the last error and says "Nothing was sent." (`manager:4560`).
- `defer` clears `notSentSince` when it saves a deferral (`manager:2698-2703`), so a wait for the session no longer counts.

**Residual.** A run where not-sent refusals alternate with session-unavailable deferrals never reaches the cap. Example:
1. A Claude process exits during preparation (`NotSentError`).
2. Its relaunch fails some of the time, which makes the row `error`.
3. The next drain then defers with "Waiting for the original session to be available" (`manager:2714`), which resets the clock.

The message waits indefinitely, and nothing is sent twice. That matches the stated design ("a wait for the session itself is
not a run of refusals"), so it is noted, not counted as a defect.

## L4. A `SendRejectedError` in automatic delivery is reported as uncertain: FIXED

- **Service.** `service:669` returns `{status: 'rejected', reason}`.
- **Recovery.**
  - The manager appends a status line and throws `RecoverySubmitRejectedError` (`manager:566-570`).
  - `run-recovery.ts:324-328` saves `stopped` with that reason, clears `nextRetryAt` and does not call `onError`.
- **Wake and continuation.**
  - `rejection` is set and `submissionInvoked` is reset (`manager:1005-1009`).
  - `deferred` is false (`:1075`), so the attempt is saved as `failed` and never replayed.
  - The status line reads "was not sent, and sending it again would fail the same way" (`:1077-1079`).
  - The continuation is `blocked` with "Continuation was not sent and cannot be: …" (`:1082-1085`).
- **Restore.** The opening prompt of a restore still treats anything other than `submitted` as a restore failure with the
  reason (`manager:4611-4612`).
- **Cosmetic.** `RecoverySubmitRejectedError` was inserted between the doc comment of `RecoverySubmitDeferredError` and its class
  (`run-recovery.ts:11-24`). The Deferred class lost its doc comment, and the Rejected class now carries two.
- **Test gap.** No test covers the recovery path (acknowledged at `structured-cutover.md:861-862`).

## L5. Codex message-mode cards do not survive a restart, and the docs say they do: DOCS FIXED, behaviour unchanged

- `architecture.md:634-636` now says that only held server-request questions come back.
- The behaviour itself is an open follow-up (`structured-cutover.md:859-860`).

## L6. The evidence path the code cites does not exist: FIXED

- `docs/research/cutover-2026-10-26/codex-async-question/` now holds `capture.mjs`, `run1.jsonl` and `run2.jsonl`.
  - Each run holds two `delivery: "async"` items with `questions: [{title, options}]`.
- The cutover doc cites it at `structured-cutover.md:731` and `:849`.

## N8. Gaps in the k2 assertions: PARTIAL

**The 5 s Stop rule.** It is in:
- Claude f (`prove-structured-claude.mjs:425`) and Claude k2 (`:676`);
- Codex h (`prove-structured-codex.mjs:549`) and Codex k2 (`:829`).

The window is looser than the label says:
- Each wait starts after "the session to become idle after Stop" (up to 15 s), not at Stop, so the rule is really "within 5 s
  of idle".
- `commandGoneAfterMs` is measured from Stop but not asserted.
- This cannot fail a correct system. It could pass a Stop that did not work only if idle took about 10 s or more.
- In the `b2e6e5e` run, idle came after 262 to 270 ms and the command was gone after 324 to 327 ms.

**The exactly-once counters.**
- **Claude** (`:156-190`). It counts `stop_hook_summary` rows and interruption rows from the first prompt in the window.
  - The summary row exists only where a Stop hook is installed. Step e already requires the Stop hook to run (`:406`), so a host
    without one fails at e first.
  - An interrupted turn runs no Stop hook.
- **Codex** (`:290-322`). It counts `event_msg` `task_started`, `task_complete` and `turn_aborted` records by `turn_id`.
  - A real rollout carries a top-level `turn_id` on `task_started` and `turn_aborted`, and the product parser relies on it
    (`codex-run-state.ts:7-8`).
- **Windows.** Each window starts early enough: at the start of k2, before the resumed send, and before the second restart. An
  earlier turn's end that lands late is excluded: Claude counts from the first prompt, and Codex counts only turns that started
  in the window.
- **Results on `b2e6e5e`.** Both proofs passed with the expected counts (Claude `:228-242`, Codex `:227-243`). I found no false
  failure.

**What the counters cannot see.** They count the provider's records, not the Console's. A Console that handled one terminal
twice would still pass, for example with two completion lines, a second recency move or a second recovery decision. The
Console side of exactly-once is still not counted.

**The steer check** now watches the count run for 2 s after the steer is accepted before it looks for a reply
(`prove-structured-claude.mjs:703-710`, `prove-structured-codex.mjs:865-873`). It can now fail.

---

## New findings

### R4-1. MEDIUM. A hung Codex app-server is never replaced; every Codex conversation fails "busy", with no limit

**Where.**
- `instance:614-619`, with the try at `:606-612`. Any not-fresh connection whose `account/read` or `initialize` times out now
  disconnects and throws busy. That includes ordinary starts.
- The only terminate in the plugin is at `:621`, and these timeouts now skip it.
- The line transport retires a host only in two cases (`line-transport.ts:917-939`):
  - the host itself does not answer the connect or the hello;
  - the command line changed.
- The 10-minute limit (`manager:4261`) covers only the survivor lookup of a row still marked working. It settles that row; it
  never replaces the process.

**Failing scenario.**
1. The Codex app-server child stops answering JSON-RPC (a deadlock, or a stall), while its session host is healthy.
2. The next use of any Codex conversation follows `ensureLoaded`, `resume`, `startClient`, attach, then `account/read`. That
   covers a queued message, a screen poll, the 30 s reconcile retry and a new conversation (`start`).
3. After the 30 s `initializeTimeoutMs`, the connection is closed and the call throws `TransportBusyError`.
4. Nothing ever ends the app-server.
5. Every Codex row ends in `error` with "did not answer in time … try again in a moment", until someone kills the process by
   hand.

Before `4c79237`, the first ordinary start terminated and replaced it.

**Docs.** `structured-cutover.md:856-857` lists this as "reports busy until the 10-minute limit". No limit applies to this
path.

**Fix (Bryan decides).** Bound the patience for the shared process, so that both the slow case (L1) and the hung case are
covered. For example: after N consecutive handshake timeouts over M minutes with no answer, terminate and start a fresh
app-server, and report it on the affected rows.

### R4-2. MEDIUM (decision). After a restart, Stop ends every live background terminal of the thread, including processes earlier turns left running on purpose

**Where.**
- `session:989-991` tracks every listed terminal on the adopted turn. The comment calls a leftover of an earlier turn "exactly
  what Stop should end".
- `terminateBackgroundCommands` then ends all of them (`:1296-1319`).

**Without a restart.** Stop ends only the commands whose `item/started` the turn saw (`session:1379-1380`). A background
terminal from an earlier turn is untouched.

**Failing scenario.**
1. Turn 1 starts a dev server in a Codex background terminal and ends, leaving it running.
2. Turn 2 runs a build.
3. The backend restarts (a deploy), and turn 2 is adopted.
4. The person presses Stop: both the build and the dev server end.

The same Stop without a restart leaves the dev server running.

**No alternative on 0.164.** The CLI offers no way to tie a running terminal to a turn:
- the item listing omits running commands;
- in the probe, `thread/turns/list` showed only the `userMessage`.

So this is a trade-off, not a bug.

**Not decided.** Round 3 asked for Bryan's acceptance. The docs do not record it, and they do not say that terminals from
earlier turns are ended too.

### R4-3. LOW. The busy contract contradicts the Codex plugin and the line transport

- **The contract.**
  - `types.ts:184-186` and `:321-325`, copied into `structured-providers.md`, say a timeout after the connection was made is
    "never" `TransportBusyError`. Codex throws it for exactly that (`instance:614-619`).
  - The Codex `reattach` JSDoc still says such a host is "reported as `TransportUnavailableError`" (`instance:435-437`).
- **The docs.** They say a refused connect is busy (`structured-cutover.md:468`, `structured-providers.md:517`). The transport
  reports it as `absent` (`line-transport.ts:886-889`).
- **The tests.** The two new Codex tests assert only `rejects.toBeInstanceOf(TransportUnavailableError)`:
  - "leaves an app-server alone that is slow to answer…";
  - "does not let a response from the host replay answer…".

  Both are in `structured-codex-restart.test.ts`. They would pass even if the plugin stopped classifying the timeout as busy.

### R4-4. LOW. Claude and Codex now treat a slow handshake at adoption in opposite ways

**What the code does.**
- **Claude.** The host answers but the CLI does not answer the repeated `initialize` in time. The plugin detaches the process
  and throws a plain `TransportUnavailableError` (`claude:669-679`, `:757`).
  - The row's turn is declared lost at once (`manager:4658`).
  - Recovery is scheduled for an unattended assignment (`manager:4706`).
  - The process may still be running the turn.
- **Codex.** The same situation is reported busy (`instance:614-619`).

**Failing scenario.**
1. Under swap, a Claude CLI with a running turn takes longer than `initializeTimeoutMs` to answer.
2. The loss line is written and recovery is armed.
3. The next restore adopts the same process mid-turn, and the row reads working again.

This is the N4 scenario, for Claude. The change follows round 3's M3 recommendation, but the two plugins now apply opposite
rules to the same condition.

### R4-5. LOW. A late answer to an abandoned connection can resolve the next connection's request

**Where.**
- `instance:614-619` leaves the app-server running after a timeout.
- The late reply arrives at the host after the next connection's welcome, so `ReplayGate` passes it as live
  (`instance:256-259`).
- `JsonRpcClient` matches replies by numeric id, and ids restart at 1 (`jsonrpc.ts:194`, `:404-424`).

**Usually harmless.** Every connection's first request is `account/read`, so a collision on id 1 pairs the same method.

**Failing scenario.**
1. Connection A gets "Not initialized" for `account/read` (id 1), sends `initialize` (id 2), and that times out.
2. Connection B sends `account/read` (id 1), then `thread/resume` (id 2).
3. The app-server answers out of order, and A's `initialize` reply resolves B's `thread/resume`.
4. B's `register` hook throws. The client logs the throw and resolves anyway (`jsonrpc.ts:418-423`).
5. `resumeThread` throws "Codex returned no thread" (`instance:493`).
6. For a reattach, that is an ordinary error, so the row's turn is declared lost.

The next attempt repairs it. The existing replay test covers only lines inside the replay itself, not this case.

### R4-6. LOW. Smaller residuals and doc hygiene

- **L2 residuals.** See L2 above:
  - the working expiry still clears the row;
  - a Stop can be lost in the channel lag;
  - `adoptUnknownTurn` survives a listing that succeeded.
- **N1, background path.**
  - Commands the listing adds after a Stop has already run are never ended (acknowledged).
  - The comment at `session:987` holds only for the adopt path.
- **N8.**
  - The 5 s windows start after the idle wait.
  - The exactly-once counters cannot see the Console's own handling of a turn end.
- **Docs.**
  - `structured-cutover.md:818` cites a `review-round-3.md` that is not committed.
  - `structured-cutover.md:459` and `:782` keep N1 in the present tense.
  - `structured-cutover.md:4-6` does not mention the round 3 run.
- **Code.** In `run-recovery.ts`, the doc comment of `RecoverySubmitDeferredError` now sits on `RecoverySubmitRejectedError`.

---

## Overall verdict

**Reading the code:**
- M2, M3 (for Claude), L4 and L6 are fixed correctly.
- L1's replay change is correct.
- I found no regression on the tmux path.

**On the real CLIs.** N1/M4 uses exactly the calls the probe verified. The `b2e6e5e` runs recorded in `f54460f` prove it on the
real CLIs:
- Codex k2: the command was gone 327 ms after Stop, the exactly-once counts were right, the steer was delivered, and no recovery
  text appeared;
- Claude 14 of 14;
- migration 9 of 9.

**What remains before the owner's integration review:**
- **Two medium items need Bryan's decision.**
  - **R4-1.** The L1 fix removed the only path that replaces a hung shared Codex app-server. All Codex conversations then fail
    "busy" with no limit, and the docs wrongly call that bounded.
  - **R4-2.** Stop after a restart now ends background terminals that earlier turns left running.
- **Low items.**
  - The doc and contract sentences under M1 and R4-3 contradict the code and should be corrected.
  - L2 is partial: the working expiry still clears the row while the turn is unidentified.

The branch is ready for that review once R4-1 and R4-2 are put to Bryan as explicit open decisions, or fixed, and the doc
contradictions are corrected.
