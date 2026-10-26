# Review round 2: structured cutover (`3df649d..e7e0a2a`)

Reviewer: independent Opus pass, 2026-10-26. Read-only (no edits, commits, builds or provider processes). Line numbers are
`e7e0a2a`. Checklist: `docs/research/cutover-2026-10-26/review-round-1.md` plus the lane decisions in the brief.
The branch has one later commit, `671543c`, which adds only the three proof evidence files. I read those files; they
were produced on `e7e0a2a` with a clean `apps/` and `packages/` tree (`revision: e7e0a2a`, `workingTree: []`).

## What I ran

Each file was run alone with `env -u NODE_ENV npx vitest run <file> --testTimeout 10000 --maxWorkers=1` from
`apps/server`. Every file passed:

| File | Result |
|---|---|
| `structured-codex-restart` | 15/15 |
| `structured-session-codex-restart` | 3/3 (real session host, real Codex plugin, scripted app-server) |
| `structured-session-adoption` | 24/24 (fake plugin, both process models) |
| `structured-claude-reattach` | 24/24 (real Claude plugin, real session host, fake `claude`) |
| `structured-session-orphans` | 7/7 |
| `structured-session-migration` | 21/21 |
| `structured-session-launches` | 9/9 |
| `structured-session-host` | 43/43 (extra, for findings 10 and 11) |

Not run by me: the full suite, the typecheck and the proofs. The lane's coordination status reports server 2369 passed
(3 known failures), web 215 passed, a clean build, and proofs Claude 14/14, Codex 16/16 and migration 9/9. I checked the
proof results against the committed evidence JSON. I did not rerun them.

---

## 1. Verdict on the round-1 findings

| # | Verdict | Where (e7e0a2a) | Covering test |
|---|---|---|---|
| 1 Codex turn across a restart | **PARTIAL.** Adoption, working state, terminal, held questions and replay work. Stop after the restart does not end a command the turn started before it (new finding 1). A slow host still gets the turn declared lost (new finding 4). The fallback for an unlisted turn never applies (new finding 5). | manager `:4196-4236`, `:4529-4541`. instance `:429-437`, `:481-484`, `:495`, `:631-735`. session `:862-946`. `restart-state.ts` | `structured-codex-restart`, `structured-session-codex-restart`, `structured-session-adoption`. Proof k2 |
| 2 Claude reattach mid-turn | **CORRECT.** `session_state` that is not idle starts an adopted provider turn before `reattach` resolves. Every load path tries adoption before declaring a loss. The real CLI confirms it: Stop ended the command 325 ms after the restart. | instance `:647-648`, `:684-688`. session `:376-380`. service `:833-837`. manager `:4529-4541` | `structured-claude-reattach` (6 tests), `structured-session-adoption`. Proof k2. A manager-level test with the real Claude plugin is still missing (fake plugin only) |
| 3 Send credited with another turn | **CORRECT.** The pending send is used as a fallback only when the frame or result names no uuid, and the record is returned. | session `:1124`, `:1175-1180` | `structured-claude-reattach` "frames of a turn this session did not send" (3) |
| 4 Empty headless chat after its process ended | **CORRECT** for the case without a transcript. It is broader than needed, and one sub-case is unverified (new finding 7). | instance `:357-371` | `structured-claude-plugin` (2), `structured-claude-reattach` "a conversation that never ran a turn" |
| 5 `resume` beside a holder | **CORRECT.** An attach-only adoption runs first, then the holder check. It never spawns. A stale launch record is dropped when its host is absent or ended. A host that was used gets live output only. The `started` flag was added but nothing reads it (new finding 9). | instance `:343-355`, `:556-565`. line-transport `:921-929` | `structured-claude-reattach` "resume beside a process…" (5), `structured-session-host` replay |
| 6 Migration cancels recovery | **CORRECT.** Rows with recovery `scheduled` or `retrying` get the outcome `recovering`. No cancel. The wait is bounded by RunRecovery (see Verified OK). | manager `:4054`, `:4131-4132` | `structured-session-migration` "Moving a row whose failed run is being recovered" |
| 7 Granted-launch flags dropped | **CORRECT** (decision). A launch with flags stays on tmux and gets a status line. An explicit structured request is refused. The migration leaves such a row alone (`launchFlags`). | manager `:2313-2324`, `:2375-2377`, `:4056` | `structured-session-launches` |
| 8 Raw images, duplicate Read instruction | **CORRECT.** Images are fitted to 1568 px and about 3.4 MiB. The instruction line is dropped only when images are attached. Proof l completed for both providers, and Claude made 0 `Read` calls. | `image-fit.ts`, session `:664`, service `:559`, `prompt.ts:42-50` | `structured-claude-plugin` "large images" (3), `structured-session-input`, `image-input` |
| 9 Unadopted survivors never ended | **CORRECT.** Release and unload end the host of a row that is not loaded, and the boot sweep ends hosts that no row owns. Pressure still skips rows that are not loaded. That is acceptable now that every awake per-session row is adopted at boot. | service `:446-449`, `:468-471`, `:488-535`. manager `:4255-4262`, `:4617-4620` | `structured-session-orphans` |
| 10 Slow host terminated | **CORRECT** at the factory: a slow host gives `TransportUnavailableError` and is not retired. **PARTIAL** end to end (new finding 4). | line-transport `:937-943`. claude-instance `:556-561` | `structured-session-host` (3 new tests) |
| 11 Group not swept | **CORRECT.** The group is swept after the child ends, and again on terminate. It is signalled only while it has live members. | session-host `:196-215`, `:609`, `:654`, `:675` | `structured-session-host` (5 group tests) |
| 12 Stop drops queued steers silently | **CORRECT.** The plugin names the cancelled steers, and the manager marks them `failed: cancelled by Stop`. | claude-session `:446-493`. manager `:4409-4420` | `structured-claude-reattach` "a Stop that drops queued steers", `structured-session-adoption` |
| 13 Failures before the write reported as uncertain | **FIXED, WITH A REGRESSION.** Every failure before the write is now `NotSentError`, and the drain retries it every second for ever (new finding 3). | claude-session `:637-649` | `structured-claude-plugin` "reports a refused or timed-out model change as not sent" |
| 14 Answer to a withdrawn request reports success | **CORRECT.** Both plugins throw `RequestNotPendingError`. The service closes the card and the route answers 404. | claude-session `:504`, app-server-session `:610-613`, service `:638-646` | `structured-session-adoption` "Answering a question the provider just withdrew", plugin respond tests |
| 15 Re-adopted questions repeat the status line and push | **CORRECT.** Announced ids are stored per provider pid (at most 64) and cleared on unload and release. An adopted turn does not move recency. | service `:919-940`, manager `:4292-4296` | `structured-session-adoption` "A question that outlives a backend restart" (4) |
| 16 Question text in the event log | **CORRECT** for questions: a fixed line in the event log, details in the server log. The command text of declined permission requests still goes to the event log, as before. | manager `:488-490`, service `:1056` | `structured-session-adoption` "declines a question the Console cannot show…" |
| 17 Image path outside the store | **CORRECT.** The file must sit directly in the store directory, and the admission check refuses a message whose images are not in the store. | `prompt.ts:81`, manager `:204`, `:4342` | `image-input`, `structured-session-input` |
| 18 Background guard after a reattach | **CHANGED BY DECISION.** The plugin waits up to 1 s for the snapshot that the CLI sends unprompted, and does not send `background_tasks`. The code is correct. The snapshot is still UNVERIFIED against the real CLI (section 4). | claude-instance `:684`, claude-session `:897` | `structured-claude-reattach` "the background snapshot…" (4) |
| 19 `CLAUDE_CODE_*` config keys dropped | **CORRECT.** Only inherited keys are scrubbed, and session-state reporting cannot be switched off. | claude-instance `:99-116` | `structured-claude-plugin` env tests |
| 20 Default profile for a row with none | **CORRECT** (decision). Effort medium, no model, nothing stored on the row. | service `:772-782` | `structured-session-per-session` (3 tests) |
| 21 Held questions use handler slots | **CORRECT.** `hold()` releases the slot. | jsonrpc `:63`, `:451-471`. app-server-session `:749` | `structured-codex-restart` "Held Codex questions and the connection limit" |
| Codex async questions | **NOT WORKING ON THE REAL CLI.** The mapping follows the schema. In the real proof no card appeared, and step h2 passes through its fallback branch (new finding 2). | app-server-session `:1267`, `:1275-1288`. service `:622-635` | Fake only: `structured-codex-restart` (2), `structured-session-adoption` (4) |
| P1 mid-turn restart proof | **PARTIAL.** k2 exists for both providers. Codex k2 cannot tell a Stop that ends the command from a command that ends on its own. Neither proof sends a message during the adopted turn. | see section 3 | |
| P2 large image | Done (l, both providers). | | |
| P3 tmux command in the migration proof | Done. The Claude command is the one production runs; the Codex additions are recorded in the evidence. | | |
| P4 cleanup during setup | Done (`createProofKit` catch plus an exit backstop installed right after `mkdtemp`). | | |

---

## 2. New findings, ranked

### N1. MEDIUM. CONFIRMED (code plus proof evidence). After a restart, Stop ends the Codex turn but leaves its shell command running

- **What happens.** The adopted turn is created with an empty `commands` map:
  - `adoptRunningTurn` (`app-server-session.ts:905-908`) calls `newTurn`, which sets `commands: new Map()`.
  - The command's `item/started` (with `processId`) went to the earlier backend.
  - `interrupt` (`:597`) calls `terminateBackgroundCommands` (`:1152-1154`), which returns at once because nothing is tracked.
  - Codex does not end a turn's command on `turn/interrupt`. The plugin's own comment says so, as does fixture
    `turn_interrupt_mid_tool`.
- **Evidence** (`codex-proof-2026-10-26T18-37-31Z.json`):
  - Step h, without a restart: idle after 275 ms, command gone after 335 ms.
  - Step k2, after a restart: idle after 19 ms, command gone after **19 854 ms**. That is the natural end of the 25 s count:
    the count was seen running for 3.7 s before Stop.
  - k2 passed only because its 20 s wait (`prove-structured-codex.mjs:748`) outlasted the rest of the count, by 146 ms.
- **Effect.** After a deploy, Stop shows the row idle while the agent's command (a build, a test run, a destructive
  command) keeps running unseen. The next turn can collide with it.
- **Fix.**
  1. When a turn is adopted (in `adoptRunningTurn`, and when the first event adopts an unknown turn), read
     `thread/backgroundTerminals/list` and add the live `processId`s to the record's `commands`. Simpler alternative: for
     an `adopted` record, `terminateBackgroundCommands` terminates every live background terminal of the thread.
  2. Add a plugin test: restart during a command, Stop, expect `thread/backgroundTerminals/terminate`.
  3. Make k2 (and h) require the command to be gone within about 5 s, or use a count longer than the wait.

### N2. MEDIUM-LOW. CONFIRMED (proof evidence). The Codex async-question mapping produced no card on codex-cli 0.164, and step h2 still passes

- **Evidence.** h2 values: `outcome: stalled`, `requestUserInputOffered: "no question reached the Console"`,
  `toolNames: request_user_input_async`, two calls.
  - The first call failed with `unknown field 'question', expected 'title'…`.
  - The second call returned `{"accepted":true}`.
  - The step stopped the turn after 60 s.
- **Cause.** Unknown. Either 0.164 does not emit the `agentMessage` item with `delivery: 'async'` and `questions` that
  `app-server-session.ts:1267` waits for, or it emits it in another shape or on another event. The only coverage is the
  fake app-server.
- **Gap in the proof.** h2 treats a missing question as a finding and passes (`prove-structured-codex.mjs:527-555`).
- **Effect.** The commit message claims "Codex async questions become message-mode cards". That is not true against the
  real CLI. The person still does not see a Codex question, and the turn stalls while the model polls.
- **Fix.**
  1. Record the real notification stream of an h2 turn (method, `item.type`, the item's keys), map what is actually sent,
     and add a fixture taken from it.
  2. Make h2 fail when the async tool was accepted but no card appeared.
  3. Until then, take the claim out of the commit message and the docs.

### N3. LOW-MEDIUM. CONFIRMED (code). A permanent failure before the write now repeats every second for ever and blocks the queue (a regression from the fix for 13)

- **Where.**
  - `beforeWrite` (`claude-session.ts:637-649`) turns every error into `NotSentError`: a refused `set_model` or
    `apply_flag_settings` (`ClaudeControlError`), a missing or unreadable image, and `ImageFitError`.
  - `drainStructuredQueuedInput` (`session-manager.ts:4455-4459`) puts `NotSentError` back in the queue with "Waiting
    for the session to accept the message.".
  - The drain runs again every second (`:2641-2656`), with no limit on attempts.
- **Scenario.** A granted launch names a model the CLI refuses, or an effort the model refuses, or the image file is gone
  from the store. Then:
  - the message at the head of the queue is retried every second for ever;
  - each retry sends `set_model` to the CLI again;
  - every later message waits behind it;
  - the person sees "waiting", not an error.
  - Before `e7e0a2a`, the same case ended as `failed`, with the wrong reason but in a final state.
- **Fix.**
  - Keep `NotSentError` for timeouts and transport loss.
  - Map a control refusal, `ENOENT`/`EACCES` and `ImageFitError` to a permanent not-sent error. That error leaves nothing
    uncertain, and the drain marks it `failed` with its reason (for example `StructuredUnsupportedError`, or `NotSentError`
    with `permanent: true`).
  - Optionally cap the drain retries.
  - Add a drain test with a refused `set_model`.

### N4. LOW-MEDIUM. PLAUSIBLE (code trace). A host that runs but answers slowly at adoption still has its running turn declared lost

- **Where.**
  - Claude: `attachSurvivor` throws `TransportUnavailableError` on `unreachable` (`claude-instance.ts:560`).
    `reattachSurvivors` catches it and logs it (`structured-session-service.ts:337-341`), so `adoptStructuredSurvivor`
    returns false.
  - `refreshStructuredSessionState` then calls `settleLostStructuredTurn` (`session-manager.ts:4534-4541`).
  - Codex: `reattach` maps every `LineTransportNotRunningError`, including `unreachable`, to "no survivor"
    (`app-server-instance.ts:434`).
- **Scenario.** A deploy under swap, where the host needs more than 3 s to accept or 5 s to welcome. The first screen poll
  then:
  - writes the loss line;
  - clears `isWorking` while the turn runs;
  - starts RunRecovery for unattended work, and wakes can be delivered.

  The next successful load adopts the turn again, so the damage is temporary. The decision "a slow host is left alone" is
  met for the process but not for the row.
- **Fix.** Give `reattachSurvivors` a distinct "busy" result (or let `TransportUnavailableError` through). For that result,
  leave the row working, skip `settleLostStructuredTurn` and retry on the next pass. Codex `reattach` should treat
  `unreachable` as busy.

### N5. LOW. CONFIRMED (code). The Codex fallback "the first event names the unknown turn" cannot save the row, and the adoption buffer can drop the turn's end

- **The fallback never applies.**
  - When `thread/turns/list` fails, the error is swallowed at debug level and the listing returns `[]`
    (`app-server-session.ts:890-903`). The session then only sets `adoptUnknownTurn` (`:884`).
  - `adoptStructuredSurvivor` waits one `setImmediate` (`session-manager.ts:4221`). For a shared row with `isWorking` and
    no active turn it then calls `settleLostStructuredTurn` (`:4230`).
  - So when the listing fails or is slow, the row gets the loss line and recovery even though the thread reported
    `active`. The first item event then adopts the turn again.
  - k2 passing therefore shows that `thread/turns/list` named the in-progress turn. The fallback was never needed.
- **The buffer can drop the end of the turn.** While `adopt` waits for the listing (up to the 60 s request timeout),
  thread notifications go to `heldFrames`. Past 4096 they are dropped silently (`:682`). That can drop `turn/completed`
  of a turn that streams a lot of output, and the row then stays working until Stop.
- **Fix.**
  - Report "thread active, turn not known yet" to the host (for example a provisional `activeTurn`, or a `threadActive`
    flag), and skip `settleLost` while it holds.
  - Never drop `turn/completed`, `thread/status/changed` or `serverRequest/resolved` from the buffer; drop deltas first.

### N6. LOW. PLAUSIBLE (code). When the host's `status` reply times out, the rest of the replay reaches the new JSON-RPC client as live output

- **Where.** `separateReplay` (`app-server-instance.ts:631-646`) splits off the replay by count and uses the `status`
  reply as the end marker. If `status` times out (30 s), the lines collected so far are fewer than `replayCount`. The
  gate is then built with no pending lines, and the remaining replay lines arrive through `inner.onLine` to the client.
- **Effect.**
  - Old JSON-RPC responses can carry ids that the new client reuses.
  - An old held `requestUserInput` reaches the instance-level fallback before any session is registered, and is answered
    `{answers: {}}`.
- **Trigger.** A host that is extremely slow (the same conditions as N4). Rare.
- **Fix.** Drop replayed lines by host sequence number (at or below the welcome `seq`), not by count, or fail the connect
  when `status` times out.

### N7. LOW (decision). CONFIRMED (code). `resume` now restarts under the same id any Claude conversation whose transcript holds no conversation

- **Where.** `claude-instance.ts:357-371`. The intended case is a chat that never ran a turn. The same path also catches:
  - a conversation whose transcript was deleted (Claude Code removes transcripts older than `cleanupPeriodDays`, 30 days
    by default, at startup), so a long-asleep row comes back empty;
  - a transcript under another config directory.

  The person gets an info notice. Before, the restore stopped with an error.
- **UNVERIFIED.** Whether the real CLI accepts `--session-id <id>` while a preamble-only file with that id exists. Only
  the fake covers the second plugin test.
- **Fix.** Relaunch under the same id only when the host knows that the row never completed a turn (no `lastResponseAt`
  and no user input in its event log). Otherwise keep `ResumeFailedError`.

### N8. LOW. CONFIRMED (proof design). Gaps in the k2 assertions

- **Codex Stop.** "The command ends after Stop" passes even when the command ends on its own (N1).
- **"No recovery prompt".** RunRecovery acts only for unattended assignments, and the proof rows have none, so this check
  proves nothing about recovery. The loss-line check is the check that matters, and it passed.
- **No mid-turn send.** Neither proof sends a message during the adopted turn (round-1 P1). That case is covered only
  against the fake `claude`.
- **Terminals not counted.** The exactly-once terminal is not counted in either proof.

### N9. LOW. CONFIRMED (code). Code that nothing uses

`ManagedLineTransport.started`, `HostLineTransport.started` and its assignment, `StdioLineTransport.started`,
`transportWasStarted` and `ReplayGate.started` are set and tested, but no product code reads them.

- `line-transport.ts:58-63`, `:108-111`, `:205`, `:443`, `:851`.
- `app-server-instance.ts:227`, `:232`.

Remove them, or use them.

### N10. LOW. PLAUSIBLE (code). The Codex instance shares one start promise between attach-only starts and ordinary starts

`ensureClient` (`app-server-instance.ts:515`) reuses `this.starting` whatever `attachOnly` the first caller passed. Two
cases follow:

- An ordinary load of an idle Codex row that coincides with a boot reattach gets `LineTransportNotRunningError` when no
  host runs. The row records it as a failure and works on its next use.
- A reattach that coincides with an ordinary start may itself start an app-server. The outcome is correct (no turn, so
  the turn is lost), but it does not match the "reattach starts nothing" rule.

Fix: keep separate promises, or let an attach-only waiter retry as an ordinary start.

---

## 3. Verified OK (regression hunt and proof scripts)

- **No double adoption.**
  - The screen poll (`restoreSessionForScreen`) and the first reconcile (`reattachSurvivor`) both run under the row lock
    (`runtimes.run`).
  - The service skips a row that is `alive`, `loading` or `reattaching`, and `ensureLoaded` waits for a reattach that is
    in flight.
  - A second `adoptStructuredSurvivor` finds the row alive and does nothing.
  - `structured-session-codex-restart` asserts one `thread/resume` across a poll and a reconcile, and the adoption test
    asserts one `reattach`.
- **No second writer (Claude).** `adoptSurvivor` holds `opening` for both `reattach` and `resume`. `resume` connects
  attach-only, checks the holder after that, and never spawns beside a holder. The reattach tests assert one process
  start in every case.
- **One `thread/resume` per thread.** The guards are in the service. `register` ends a stale session object with its
  questions kept.
- **Exactly-once terminals with replay.**
  - Turn lifecycle is read from the thread, not from the replay.
  - The tracked-turn marker is cleared at finalize, so a turn that ended while no backend listened is reported once and not
    again after a further restart (tested).
  - The replay never reaches sessions, except in N6's timeout case.
  - A double `onTurnStarted` (from `register` and from the queued event) is harmless: the monitor overwrites the state,
    and the adopted flag stops recency from moving.
- **Cursor from another process.** It counts only when pid and start ticks match and its `seq` is at or below the newest
  line; otherwise the whole buffer is read (tested).
- **Orphan sweep and a bind in flight.**
  - The row is inserted as `starting` before the process starts (`session-manager.ts:4851` before `:4858`).
  - `owned` counts any status except `ended` and is evaluated per host, against the database as it is then.
  - Codex hosts never match the `claude-` prefix (tested).
- **`endConversation` never ends the shared Codex host.** `PER_SESSION_HOSTS` holds only `claude`, filtered by provider
  (tested).
- **The `recovering` and `launchFlags` outcomes do not block for ever by accident.**
  - `scheduled` expires at `RECOVERY_MAX_AGE_MS` (`run-recovery.ts:239-244`).
  - `retrying` becomes `stopped` on the first observation after a restart (`:206-208`).
  - `launchFlags` is permanent by decision.
- **Image fit.** An image within 1568 px and about 3.4 MiB is sent byte for byte with its own media type
  (`image-fit.ts:55`). PNG stays PNG; other formats become JPEG only when they must be re-encoded.
- **`withoutImageInstruction`.** It applies only when images are attached and only to the first line of the envelope.
  Text without an envelope, or with no instruction line, comes back unchanged. Display and duplicate matching read both
  forms, and the event log keeps the full text (tested).
- **Announced ids.** At most 64 per session, keyed by provider pid, deleted on unload and release. The other new meta is
  bounded too: held Codex questions at 64 per thread, message questions at 256, one turn marker per thread.
- **`RequestNotPendingError`.** It never surfaces as a 500. The two call sites of `transport.respond` are the answer
  route (404 through `StructuredRequestNotFoundError`) and the automatic decline (ignored).
- **Cancelled steers.** Only `sendStructuredKeystrokes` on the structured path reaches the marking; tmux rows never do.
- **tmux path.** Unchanged while `defaultTransport` stays `tmux`:
  - the flags gate applies only when the resolved transport is structured;
  - `recovering`, `launchFlags` and the removed cancel are migration-only;
  - the new branch for unloaded rows is inside `suspendStructuredIdleSession`;
  - the group sweep is session-host-only.
- **Group sweep safety.** Only `-pid` is signalled, and only while `/proc` shows live members in that group. Linux does
  not reuse a pid while it still names a group that has members.
- **Held Codex questions.** Kept on shutdown and on a disconnect, never answered on the way out, answered by id with
  `replyToServerRequest` from the next backend, kept only while the thread reports `waitingOnUserInput` (tested end to
  end through the real host).
- **Proof process scan.**
  - `assertProofRoot` requires an `mkdtemp` directory directly under `os.tmpdir()` with a name of at least 16 characters.
  - `scanProofProcesses` matches the four lane kinds only when their command line or environment names that random root.
  - `listProcesses` adds `pgrep -f <root>` and the exact `AGENT_COORD_RUNTIME=<proof runtime>` entry.
  - None of these can match the live Console or Bryan's own sessions.
  - The migration proof's tmux Claude, if the user-scope MCP entry had won, would start a coordination MCP server with the
    live runtime but the proof's working directory in its environment. That server is the proof's own and is caught by
    the scan. The evidence shows the per-session entry won.
- **Proof cleanup on failure.**
  - `createProofKit` catches errors during setup and ends whatever it started.
  - The exit backstop is installed straight after `mkdtemp`, in the kit and in the Codex proof.
  - SIGINT and SIGTERM stop at the next poll; a second signal exits through the backstop.
  - `finish` and the Codex `finally` end recorded hosts, run SIGTERM then SIGKILL, run a final lane scan and remove the
    temp root.
  - All three committed runs report every cleanup item `ok`, with 0 leftover processes.
- **Proof assertions for the mid-turn restart (k2).**
  - Claude k2 proves the claim:
    - adoption 478 ms after boot, through the first poll and before any message or reconcile;
    - every poll `isWorking: true`;
    - Stop gives idle in 263 ms and the command gone in 325 ms, with `[Request interrupted by user for tool use]` in the
      transcript;
    - same pid, a single holder, no loss line.
  - Codex k2 proves adoption (481 ms), working state, `turn_aborted: interrupted`, the same app-server and no loss line.
    It does not prove that Stop ends the command (N1).

---

## 4. Still unverified against the real CLIs

**Settled by the proofs on `e7e0a2a`** (evidence in `671543c`):

- Claude answers a repeated `initialize` mid-turn with a `session_state` that is not idle. Without it, Stop could not have
  interrupted the turn in k2.
- The first screen poll adopts before the first reconcile pass and writes no loss line (both providers).
- Codex: `thread/resume` on a running thread reports `active`, and `thread/turns/list` names the in-progress turn. Otherwise
  N5 would have declared the turn lost.
- Large image: both providers complete the turn. Claude made no `Read` call. Codex re-encoded the image itself (4.0 MB sent).
- The Claude transcript block is 133 KB, well below what the fit should produce for this image. This suggests the CLI
  re-encodes blocks itself, so the fit is defence in depth. That reading is UNVERIFIED.
- Migration with the production Claude command: the per-session `--mcp-config` entry wins over the user-scope entry.

**Still open:**

- The `background_tasks_changed` snapshot behind a repeated `initialize`. Nothing records whether it arrived, and the
  guard gives up silently after 1 s.
- The entry shape of `pending_permission_requests`, and re-adopting a held `AskUserQuestion` across a real restart. Neither
  occurs under bypass in the proofs.
- A held Codex `requestUserInput` across a real restart, and the replay absorption of requests that arrived while no backend
  listened. 0.164 offers only the async tool in default mode, so only the fake covers these.
- The Codex async-question shape (N2): the proof showed no card. h2 settles nothing until it fails on that.
- A message sent during an adopted Claude turn (fake only).
- `--session-id` relaunch beside a preamble-only transcript (N7).
- Slow-host behaviour (N4, N6).
- From round 1, not touched by these proofs: `--system-prompt-snapshot off` on resume, and `ExitPlanMode` under bypass.

---

## 5. Summary

1. Round-1 findings 2, 3, 5-12 and 14-21 are fixed correctly, with tests through the real plugins where it mattered.
   18 and 20 follow the recorded decisions.
2. The core promise now holds against the real CLIs: a turn running across a deploy is adopted by the first screen poll, the
   row stays working, and no loss line or recovery text appears (k2, both providers).
3. Finding 1 is partial. After the restart, Codex Stop ends the turn but not its shell command. The proof passed only
   because the 25 s count ran out 146 ms inside the 20 s wait (N1, MEDIUM, CONFIRMED).
4. The Codex async-question mapping did not produce a card on the real CLI, and h2 passes anyway. The commit's claim is
   unproven (N2).
5. The fix for 13 sends permanent failures before the write (a refused model, a missing image) into a one-second retry
   loop that blocks the queue (N3).
6. A slow but live host still gets its running turn declared lost on the first poll. The Codex fallback for an unlisted
   turn never applies at the manager level (N4, N5).
7. The tmux path, the session-host identity rules, the orphan sweep, the shared Codex host and the proof process scan are
   safe. No double adoption or second writer was found.
8. Smaller items: the edge case where the replay goes past a timed-out `status` (N6), the broadened empty-chat relaunch
   (N7, decision), weak k2 assertions (N8), the unused `started` flag (N9), and the shared start promise (N10).
9. All 8 targeted test files pass. The full suite, the typecheck and the proofs were reported by the lane; I checked the
   proofs against their evidence JSON but did not rerun them.
10. Verdict: not yet ready for Bryan's integration review. Fix N1 (with a stricter k2) and N3, and either make N2 work or
    withdraw its claim. After that it is ready; N4-N10 can go to Bryan as listed open items.
