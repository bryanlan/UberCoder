# Review round 5: `dd3c615` "Fix cutover review round 4" (`f54460f..dd3c615`)

This was a read-only review in `/home/bryan/code/agent-console-wt/structured-providers-20261026`, on branch
`feature/structured-claude-cutover`. I ran no tests, builds, proofs or providers. Every claim about behaviour comes from reading
the code.

HEAD moved to `9378b10` "Record the proof runs on the round 4 build" during the review. That commit changes no code. It adds:
- proof evidence with `revision: "dd3c615"`: Claude 14/14, Codex 16/16, migration 9/9;
- a "Round 4 run (current)" paragraph in `structured-cutover.md`.

Code line numbers are the same at `dd3c615` and `9378b10`. Doc line numbers are at `9378b10`.

Short names:
- `instance` = `apps/server/src/providers/transport/codex/app-server-instance.ts`
- `session` = `.../codex/app-server-session.ts`
- `claude` = `.../claude/claude-instance.ts`
- `service` = `apps/server/src/sessions/structured/structured-session-service.ts`
- `manager` = `apps/server/src/sessions/session-manager.ts`

---

## R4-1. A hung shared app-server is replaced after 5 minutes: NOT FIXED in the running service (the instance logic is correct)

**The instance logic, read alone, is correct.**
- `noteUnresponsive` (`instance:859-863`) keeps the age of the first timeout of the run (`??=`).
- `startClient` (`instance:639-654`) behaves as follows:
  - an ordinary start whose handshake times out on a process it did not start reports busy while the run is younger than
    `APP_SERVER_UNRESPONSIVE_LIMIT_MS` (`:93`);
  - after that it calls `close({terminate: true})`, clears the run and calls `startClient(false)` once.
- An attach-only start never notes the run and never terminates on a timeout (`:644`).
- Every successful handshake clears the run (`:660`), attach-only ones included. A non-timeout failure also clears it
  (`:656`).
- **No recursion loop.** The run is cleared before the recursive call (`:652`). In the inner call, a timeout on a not-fresh
  connection therefore notes age 0 and reports busy. A timeout on a fresh process takes the terminate path at `:655`, so it
  ends that process and fails.
- **No double terminate.** Each client is terminated at most once. The earlier busy clients were only disconnected (`:646`).
- **The replay gate forwards `terminate`** to the host (`instance:280-282`).
- **The test runs on the instance only.** `structured-codex-restart.test.ts:765-844` calls `resume`/`reattach` repeatedly on one
  `CodexAppServerInstance` (`backendWith`, `:678-693`).

**Production never reaches the limit. There are two independent reasons.**

1. **The service throws the instance away after every failed open.**
   - `service.open` (`:793-817`) catches every error from `instance.resume`/`instance.start` and calls
     `dropInstanceIfDisconnected` (`:813`).
   - That function (`:1046-1054`) deletes the cached instance and disposes it when `alive().connected` is false.
   - After a busy failure `clientRef` was never set, so `alive()` reports it as not connected (`instance:383-386`).
   - The next `ensureLoaded`/`start` gets a new `CodexAppServerInstance` from `instanceFor` (`service:780-791`; the plugin
     builds a new one on each `create`, `codex/index.ts:13`).
   - The new instance has `unresponsiveSince === undefined`.
   - So every ordinary start that times out is the first of its run: it returns age 0 and reports busy, and the replacement at
     `instance:650-653` is never reached.
   - The attach-only path (`service:373-387`) does not drop the instance, but it never counts toward the run either.
2. **A hang that starts while the backend is connected never reaches the handshake check.**
   - `ensureClient` returns the live `clientRef` without calling `startClient` (`instance:559`).
   - A request timeout rejects that one request and leaves the connection open (`jsonrpc.ts:255-258`).
   - Nothing closes a client after repeated timeouts. `alive()` checks only `exited`.

**Docs.** These passages say the replacement happens, and in the running service it does not:
- `architecture.md:688-689`;
- `structured-cutover.md:475-477` and `:886-888`.

See R5-1.

## R4-2. Stop after a restart ends the terminals that earlier turns left running: FIXED for the main path, with low residuals

**Fixed.**
- **Written at start.** The record is written on `item/started` through `trackCommand` (`session:1040-1043`, `:1420-1428`).
- **Removed at completion.** `item/completed` removes it before the turn is looked up, so it is removed even after the turn's
  record is gone (`session:1430-1436`).
- **Dropped or kept by how the session ends.**
  - Dropped on `unload` (`session:711-716`), on `close('release')` (`:718-726`) and on `thread/closed` (`:1149-1151`).
  - Kept on `close('shutdown'|'error')` and on `dispose` when the host keeps the process (`instance:530-546`).
  - Reset with the process: a fresh start (`instance:666-667`), an `exited` exit (`:890-892`), or a stdio `dispose`.
- **Adoption.** `trackRunningCommands` (`session:1016-1037`) treats each listed terminal by its record:
  - recorded under another turn: left alone (`:1024-1028`);
  - recorded under the adopted turn, or not recorded: tracked and recorded (`:1029`);
  - in-progress items of the adopted turn: always tracked (`:1031-1033`).
- **Stop without a restart is unchanged.** `record.commands` is filled and used exactly as before.
- **On the real CLI.** The `dd3c615` Codex k2 run ended the adopted turn's command 186 ms after Stop
  (`codex-proof-2026-10-27T04-10-43Z.json:224-225`).

I found no terminal of the adopted turn that is wrongly left alone. Its owner record always carries the `turnId` of the frame
that started it, and the adopted record uses the id from the turn listing.

**Residuals.**
- **`unload` drops the record while the thread can still be loaded.** It removes the records of a thread whose background
  terminals may still run.
  - `protocol-brief.md:165` says the app-server unloads a thread about 30 minutes after its last subscriber leaves.
  - The grant restart path unloads and reloads at once (`manager:2133-2136`). Idle sleep unloads after 60 minutes (`manager:4733`).
  - In both cases a dev server that an earlier turn left running loses its owner record. After the next mid-turn restart,
    Stop ends it again: the round 4 R4-2 scenario. See R5-3.
- **The stated assumption is narrower than the code.** "A backend was attached for every earlier turn" fails in more cases than
  "several turns ran while no backend was attached" (`structured-cutover.md:894`):
  1. The turn running at a restart starts a background command after the backend died.
  2. That turn ends before the next backend attaches.
  3. `adoptTurns` then finds no running turn and records nothing (`session:962-979`).
  4. On the restart after that, a later adopted turn tracks and ends that terminal.
- **Records of commands that completed out of sight can be left behind.**
  - Completions that arrive while no backend listens are not read from the replay: `absorbReplay` reads only server requests.
  - `item/completed` is not an essential adoption frame (`session:454`).
  - In the unknown-turn background path, a stale listing re-adds a command that has just completed, and `trackCommand` now
    persists it too.
  - The comment at `session:1021` ("a command it removed is not added again here") still holds only on the adopt path. This
    was an R4-6 item, and it is not fixed.
  - The entries are only for processes that are no longer listed, so Stop never acts on them. They are cleared at
    unload/release/reset.

## R4-3 / R4-4. One busy rule for both plugins: FIXED, with contract wording issues

**Codex.** A timeout of the handshake (`account/read` or `initialize`) is busy when the start is attach-only or the connection is
not fresh (`instance:639`).

**Claude.** `busy = !startupResult && error instanceof ClaudeControlTimeoutError && (attachOnly || !fresh)` (`claude:679`).
- `ClaudeControlTimeoutError` is not a `ClaudeControlError` (`stream-json.ts:57`, `:66`), so a timeout reaches this check and is
  not adopted as a refusal (`claude:714-719`).
- An exit and a refusal stay plain (`claude:690`).
- A fresh, non-attach-only start that times out still ends the process: `close('error')` at `claude:680-681`.
- The reattach entry passes `attachOnly = true` (`claude:624`). The ordinary launch passes `false` (`claude:564`).

**Tests.** The Codex tests now assert `TransportBusyError` (`structured-codex-restart.test.ts:735`, `:755`).

**Wording issues** (see R5-5 and R5-7):
- The contract (`types.ts:317-327`) frames busy as a `reattach` outcome and says the caller "never starts a replacement".
  - Both plugins also throw busy from ordinary `resume`/`start` (Codex `instance:648`, Claude through `launchProcess` with a
    not-fresh reconnect).
  - The Codex ordinary start is meant to replace the process after the limit.
- The contract's "plain failure: a refused handshake" does not hold for Claude: a refused repeated `initialize` is adopted with
  `running: 'unknown'` (`claude:714-719`).

## R4-5. Request ids are shared across the connections of one instance: PARTIAL

**Fixed within one instance.**
- `requestIdCounter` (`jsonrpc.ts:186-189`) is created once per instance (`instance:312`) and passed to every client
  (`instance:615`).
- The default per-client counter is unchanged (`jsonrpc.ts:217`).
- No other code constructs a `JsonRpcClient`.

**Not fixed where a connection is most often abandoned after a timeout.**
- An ordinary open that timed out makes the service drop the instance (`service:813`, `:1046-1054`), so the next connection
  counts from 1 again.
- The round 4 R4-5 scenario therefore still applies whenever connection A was an ordinary open: a late reply to A's
  `initialize` (id 2) can settle B's `thread/resume` (id 2).
- When A was an attach-only reattach, the instance is kept and the fix applies.

Ids also restart after a backend restart, which is expected but not mentioned. The claim at `structured-cutover.md:898-899` is
broader than the code. The comment at `instance:607` ("whose ids start at 1 again") is now stale. See R5-2.

## R4-6. Smaller residuals and doc hygiene: MOSTLY FIXED

**Fixed.**
- `run-recovery.ts:11-24`: each doc comment is on its own class.
- `review-round-3.md` and `review-round-4.md` are committed.
- N1 is no longer in the present tense (`structured-cutover.md:459`, `:786-787`).
- **Status line** (`structured-cutover.md:4-6`). At `dd3c615` it claimed the round 4 fixes "were run again" with no evidence in
  the tree. `9378b10` now adds that evidence (`:611-622`), so the claim is backed.

**Not fixed.** The comment at `session:1021` (see R4-2).

## L2. `turnUnidentified` is honoured at every "is the row busy" decision: FIXED, with a low residual

**The new predicate.**
- `service.turnRunning` (`:439-441`) is `turnActive || turnUnidentified`.
- `providerTurnIsWorking` uses it for a loaded row (`manager:1230`), so the 60 s expiry returns `clear` while the turn is unnamed
  (`working-state.ts:97-99`).

**The call sites.** I checked the nine swapped sites, and each is a "do not act on a running turn" guard where an unnamed turn
must count:
- recovery `canRetry` (`manager:525`);
- the wake gate (`:918`);
- the Work release (`:1433`);
- the grant restart (`:2133`);
- the suspension block (`:3740`);
- release-time interrupt (`:3891`);
- pressure suspension (`:4756`);
- the model profile (`:4773`);
- `isWorking` on item completed (`:4836`).

The one site that must tell the two cases apart, survivor adoption (`manager:4278-4279`), still reads `turnActive` and
`turnUnidentified` separately. I found no site where counting an unnamed turn as working is wrong. All edits sit in structured
branches, so the tmux path is untouched.

**The `interrupt` fallback** (`service:651`).
- `state.activeTurnId ?? state.transport.activeTurn`.
- Codex `activeTurn` is `activeTurnId` (`session:534-536`), and `finalizeTurn` clears it before pushing the terminal
  (`session:1287-1302`). Claude's is the active or pending record (`claude-session.ts:363-365`).
- So the fallback cannot name a turn that already ended. The pending Claude send it can name is one that Stop should cancel.

**The session side.**
- `listRecentTurns` returns `undefined` on failure (`session:981-994`).
- `interruptUnidentifiedTurn` (`session:659-684`) clears `adoptUnknownTurn` only when the listing worked.
  `unlistedTurnNoticed` limits the notice to one per period.

**Residual.** When the unidentified period ends without the turn's terminal, the row stays "working" with no expiry left.
See R5-4.

A small UX gap: after a first notice from a failed listing, a later Stop whose listing works and clears the flag tells the
person nothing.

## N8. Proof window and counters: FIXED, with a low residual

`windowLeft` (`structured-proof-kit.mjs:30-34`) gives the time left of a 5 s window that starts at `stopped`, before the Escape
call. It is used at:
- `prove-structured-claude.mjs:425-426` and `:677-678`;
- `prove-structured-codex.mjs:549-550` and `:830-831`.

`wait` checks the predicate once before it looks at the deadline (`structured-proof-kit.mjs:333-342`, `prove-structured-codex.mjs:174-183`).

**Residual.** The command check still runs only after the idle wait (up to 15 s), so the step now also requires idle within
5 s. See R5-6.

In the `dd3c615` run, idle came after 22 to 271 ms (`claude-proof-...04-08-36Z.json:122`, `:225`;
`codex-proof-...04-10-43Z.json:130`, `:224`).

## Docs after this commit

**Contradict the code or the research docs:**
- `architecture.md:688-689`, `structured-cutover.md:475-477` and `:886-888` say a hung app-server is replaced after 5 minutes.
  In the running service it is not (R5-1).
- `structured-providers.md:706` still says adoption "tracks every live terminal on the adopted turn". Since R4-2, terminals
  recorded under another turn are left alone.
- **The busy contract** (`types.ts:317-327`, copied in `structured-providers.md:486-492`):
  - it says the caller "never starts a replacement";
  - it says a refused handshake is a plain failure;
  - Claude adopts on a refused repeated `initialize`, and the Codex ordinary start is meant to replace the process.
- `structured-cutover.md:894` states the unrecorded-terminal assumption too narrowly (see R4-2). It also cites "a second
  probe" with no evidence path in the tree: `background-terminals-probe.md` was not changed.
- The session comment "the thread was released: its terminals ended with it" (`session:136-139`) and the restart-state
  comment (`restart-state.ts:151`) contradict `protocol-brief.md:165` for `unload`.
- `structured-cutover.md:898-899` overstates R4-5 (see R4-5).

**Structure.** The "Round 4" paragraph and its fix list (`structured-cutover.md:881-902`) were inserted inside the "Open
follow-ups after round 3" list (`:871-879`). Three open items now come after the round 4 "fixed on this branch" bullets, so
they read as fixed (`:903-911`):
- Codex message-mode cards after a restart;
- the `run-recovery` test gap;
- "From earlier rounds".

The residuals in this report are not listed as open follow-ups:
- the R4-1 production gap;
- the `session:1021` comment.

---

## New findings

### R5-1. MEDIUM. The R4-1 replacement never fires in the running service: a hung shared app-server still fails every Codex conversation with no limit

**Where.**
- `service:813` and `:1046-1054`: the instance is dropped and disposed after every failed open.
- `service:780-791` and `codex/index.ts:13`: the next open gets a new instance.
- `instance:314`: the run state belongs to the instance (`unresponsiveSince`).
- `instance:559` and `jsonrpc.ts:255-258`: a live connection is never re-checked.

**Failing scenario 1: the hang is found after a backend restart.**
1. The app-server stops answering JSON-RPC. Its host stays healthy.
2. The backend restarts.
3. Each ordinary use (a queued message, the 30 s reconcile retry of the error row, a new conversation) runs `service.open`,
   then `instance.resume`, then `startClient`.
4. `account/read` times out after 30 s, `noteUnresponsive` returns 0, and the call throws busy.
5. `open` drops the instance. The next use builds a new instance whose run starts again at 0.
6. The age never reaches 5 minutes, the app-server is never ended, and every Codex row stays at "did not answer in time; try
   again in a moment".

**Failing scenario 2: the hang starts while the backend is connected.**
1. The app-server hangs while the backend has a live client.
2. Every `turn/start`, `turn/interrupt` and `thread/resume` times out on that client.
3. `ensureClient` keeps returning it, so `startClient` and its check never run.
4. This lasts until the backend restarts, and then scenario 1 applies.

**Why the tests pass.** They drive one instance directly (`structured-codex-restart.test.ts:765-844`), so neither path above is
covered.

**Docs.** The docs and the round 4 paragraph call this fixed.

**Possible fix.**
- Keep the run where it outlives the instance: the plugin closure or `PluginContext.meta`. Alternatively, do not drop an
  instance that never connected.
- Count consecutive request timeouts on a live client, and past a bound close the connection without terminate, so the next
  use goes through the handshake check.
- Add a service-level test that loads the row repeatedly through `ensureLoaded`.

### R5-2. LOW. R4-5 does not hold after an ordinary open that timed out

**Where.**
- `service:813` resets the id counter together with the instance.
- `instance:312` holds the counter per instance.

**Failing scenario.** This is the round 4 R4-5 sequence, with connection A an ordinary resume:
1. A's `initialize` (id 2) times out.
2. The service drops the instance.
3. Connection B from the new instance sends `account/read` (id 1), then `thread/resume` (id 2).
4. A's late reply settles B's `thread/resume`.
5. `resumeThread` throws "Codex returned no thread".

The fix applies only when A was attach-only.

### R5-3. LOW. Terminal ownership is dropped at `unload` while the thread and its terminals can stay loaded

**Where.**
- `session:711-716`: `unload` drops the thread's records.
- `manager:2133-2136`: the grant restart unloads and reloads at once.
- `manager:4728-4740`: idle sleep unloads.
- `protocol-brief.md:165`: the thread unloads about 30 minutes after its last subscriber leaves.

**Failing scenario.**
1. Turn 1 starts a dev server and ends. The dev server is recorded under turn 1.
2. A grant restart (or an idle sleep followed by use within the unload delay) runs `unload`. The record is dropped, and the dev
   server keeps running.
3. Turn 2 runs a build, and the backend restarts mid-turn.
4. Adoption finds the dev server unrecorded and tracks it.
5. Stop ends the dev server as well as the build. This is the scenario R4-2 was meant to remove.

**Related residuals.** The same outcome follows:
- from the downtime case in the R4-2 section above;
- on the first deploy of this commit, when no records exist yet.

### R5-4. LOW. An unidentified period that ends without a terminal leaves the row "working" with no expiry

**Where.**
- `working-state.ts:97-99` returns `clear` while `turnRunning` is true, and `manager:5427-5431` then reschedules nothing.
- The unidentified flag clears in two ways, and neither tells the manager:
  - on `thread/status/changed` to a status that is not active (`session:1141-1147`);
  - on a Stop whose listing worked and shows no running turn (`session:669-670`).
- After that, the turn's `turn/completed` is dropped, because `recordFor` adopts only while `adoptUnknownTurn` is true
  (`session:1377-1392`).
- Stop on a loaded row changes only `updatedAt`/`lastActivityAt` (`manager:4473-4476`).

**Failing scenario.**
1. After a restart, the turn listing fails, and the row is adopted as unidentified.
2. The turn is quiet for more than 60 s, so the expiry fires and clears itself.
3. The status turns idle before any turn-scoped frame, or Stop's listing races the end of the turn and shows none.
4. `isWorking` stays true. Wakes (`manager:914`), idle sleep (`manager:1601`) and unattended continuation stay blocked until the
   person sends a message.

Before this commit the expiry cleared it after 60 s. The window is narrow, because a turn's first turn-scoped frame normally
names it.

### R5-5. LOW. Claude has no bound for a hung CLI, and the contract's refusal rule does not match Claude

**No bound.**
- An ordinary Claude resume that reconnects to its running CLI is not fresh, so an `initialize` timeout is now busy
  (`claude:679`).
- Nothing ends that CLI: `claude:684` detaches it, and there is no equivalent of `APP_SERVER_UNRESPONSIVE_LIMIT_MS`.
- The row stays `error` with "try again in a moment" on every retry (`manager:1476`).
- Idle and pressure sleep cannot end it, because they require `status === 'bound'` (`manager:3737`). Only a release or a
  manual kill ends it.
- This is pre-existing in substance: before, the error was plain and the process was also detached. The message now promises
  that a retry will help.

**Refusal rule.** The contract (`types.ts:326`) says a refused handshake is a plain failure. Claude adopts a process that refuses
the repeated `initialize` (`claude:714-719`). The same contradiction is in `structured-cutover.md:471` and
`structured-providers.md:492`.

### R5-6. LOW. N8: the 5 s rule now also requires idle within 5 s

**Where.**
- The predicate runs only after the idle wait: Claude `:419-426`, `:671-678`; Codex `:546-550`, `:827-831`.
- `windowLeft` throws when idle used up the window (`structured-proof-kit.mjs:31-32`).

**Failing scenario.**
1. Under swap, the interrupted terminal arrives after 6 s, or the 10 s interrupt grace fires (`claude-session.ts:113`,
   `session:96`).
2. The command was killed 300 ms after Stop.
3. The step still fails with "the 5000 ms window had run out".

**Possible fix.** Poll the command-gone predicate from Stop, alongside the idle wait.

### R5-7. LOW. Doc contradictions and structure

These are the items under "Docs after this commit":
- `structured-providers.md:706`;
- the busy contract wording (`types.ts:317-327`, `structured-providers.md:486-492`);
- `structured-cutover.md:894`, with the probe that has no evidence path;
- the `unload` comments (`session:136-139`, `restart-state.ts:151`);
- `structured-cutover.md:898-899`;
- the round 4 list inserted into the open follow-ups (`structured-cutover.md:871-911`);
- the stale code comments `instance:607` and `session:1021`.

---

## Overall verdict

The code for these items is correct:
- R4-2's main path, R4-3/R4-4, and the L2 call-site swaps;
- the `interrupt` fallback;
- N8's window.

The `dd3c615` real-CLI runs recorded in `9378b10` pass 14/14, 16/16 and 9/9, and Codex k2 ended the adopted command 186 ms
after Stop. I found no regression on the tmux path.

The branch is not ready for the owner's integration review as it stands:
- The R4-1 fix, the one medium item in round 4 that was meant to be closed, does not take effect in the running service. The
  service throws away the instance, and the run state with it, after every failed open, and a hang that starts while connected
  never reaches the check.
- The docs and the round 4 paragraph say R4-1 is fixed.
- The same instance drop leaves R4-5 open on the ordinary path.

It is ready once R5-1 is either fixed with a service-level test, or put to Bryan as an explicit open item with the docs
corrected. The remaining items are low:
- R5-3 (unload drops terminal ownership);
- R5-4 (stuck "working" after an unidentified period);
- R5-5 (Claude unbounded busy);
- R5-6 (proof window);
- the doc corrections.

They can be fixed in the same pass or listed as open follow-ups.
