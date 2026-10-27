# Review round 6: `d0c07ee` and `52ee445` "Fix cutover review round 5" (`9378b10..52ee445`)

This was a read-only review in `/home/bryan/code/agent-console-wt/structured-providers-20261026`, on branch
`feature/structured-claude-cutover`. I ran no tests, builds, proofs or providers. Every claim about behaviour comes from reading
the code.

HEAD moved to `fb0dbac` "Record the proof runs on the round 5 build" during the review. That commit changes no code. It adds:
- proof evidence with `revision: "52ee445"`: Claude 14/14, Codex 16/16, migration 9/9;
- a "Round 5 run (current)" paragraph in `structured-cutover.md`.

The proofs exercise Stop and restart. They do not exercise the hang paths: those rest on the fake-backed tests, which I did not
run.

Code line numbers are the same at `52ee445` and `fb0dbac`. Doc line numbers are at `fb0dbac`.

Short names:
- `instance` = `apps/server/src/providers/transport/codex/app-server-instance.ts`
- `session` = `.../codex/app-server-session.ts`
- `jsonrpc` = `.../codex/jsonrpc.ts`
- `claude` = `.../claude/claude-instance.ts`
- `service` = `apps/server/src/sessions/structured/structured-session-service.ts`
- `manager` = `apps/server/src/sessions/session-manager.ts`
- `lt` = `apps/server/src/providers/transport/line-transport.ts`

---

## R5-1 / R5-2. A hung shared app-server is bounded through the service, and ids survive a dropped instance: FIXED, with low residuals

**The run and the id counter outlive a dropped instance.**
- `createCodexAppServerPlugin` keeps one `AppServerContinuity` per `context.runtimeDir` (`codex/index.ts:13-23`). The plugin is
  registered once per backend (`app.ts:80`), and `createContext` gives the stable `<runtimeDir>/structured/codex`
  (`manager:479-482`).
- `service.open` still drops a never-connected instance (`service:813`, `:1046-1054`). The next `instanceFor` (`:780-791`) gets
  the same continuity.
- Every read and write of the run goes through `this.continuity`:
  - `noteUnresponsive` (`instance:920-924`);
  - the resets at `instance:690`, `:694`, `:698`, `:887` and `:934`.
- Every client gets `continuity.nextRequestId` (`instance:651`). The hang test asserts the ids `[1, 2, 3]` across three
  instances (`structured-session-codex-hang.test.ts:117`).

**Live connection.**
- `jsonrpc:270-275` counts each timeout. `jsonrpc:441-446` resets the run on any response, including a late one to a request
  nobody waits for. `jsonrpc:351-357` keeps a throwing callback from escaping.
- `noteLiveTimeouts` (`instance:931-943`):
  - it ignores a client that is not `clientRef`;
  - a count of 0 resets the run;
  - at 3 in a row, or once the run is past the limit, it calls `void client.close()` once (`releasedClient` guard).
- The close has no `terminate`, so it is `HostLineTransport.disconnect` (`lt:553-563`) and the process keeps running.
- **No deadlock.** The `ensureClient` wait (`instance:584-591`) is bounded:
  - `disconnect` ends the socket, destroys it after 2 s, then waits 1 s;
  - `JsonRpcClient.closeNow` then waits up to 2 s (`jsonrpc:328-337`);
  - a client that has still not exited throws at `:589` instead of spinning.
- **A send made while the connection closes is retried.**
  - `client()` refuses a client whose close was requested (`instance:376`).
  - `sendTurn` and `steer` turn that into `NotSentError` (`session:565-571`, `:600-604`).
  - The service defers the send (`service:677`), so the send is retried and not reported lost.
- **The next open runs the check.**
  - `onExit` keeps the instance record on a disconnect (`instance:971-976`), so the next start attaches with replay.
  - It then runs `confirmInitialized`, a non-fresh `account/read` (`instance:909-917`).
  - A timeout there counts in the same run (`:682-691`).

**Silent session host** (`instance:855-888`).
- **When it applies.** Only an ordinary start with a recorded app-server (`replayWanted`) attaches first. Only the reason
  `unreachable` reaches `settleSilentHost` (`:864`).
- **Inside the window:** busy.
- **Past the limit:** `context.endHost` is called, then the plain `openTransport` starts fresh, and `restart.reset()` runs at
  `:705`.
- **Without `endHost`:** a plain `TransportUnavailableError`.
- **Refused, absent, ended or another command line:** these fall through to the plain open as before (`:867`).
- **The manager's `endHost`** is `terminateHost` on the same Console runtime directory that the factory uses (`manager:491`,
  `app.ts:84-85`).

**Attach-only.**
- It never reaches `settleSilentHost`: it rethrows at `:861`.
- `reattach` maps `unreachable` to busy (`:495`).
- Its handshake timeout never notes the run (`:682`).

**A fresh start this call made still terminates on failure** (`:677`, `:693`).

**No double replacement within an instance.**
- Every open shares `this.starting` (`:592-601`).
- The replacement `startClient(false)` (`:691`) runs inside the first caller's promise.
- The factory serialises opens per host id (`lt:947-948`).

**Residuals.** See R6-2, R6-3 and R6-4:
- the live bound reads only responses as signs of life;
- a caller that waited for a released connection reconnects on a dropped instance;
- a late answer to a handshake never counts;
- the run starts again at zero after every backend restart.

## R5-3. Command ownership record lifetime: PARTIAL, and a regression on release

**Correct.**
- `unload` keeps the record (`session:714-718`). The grant restart and idle sleep reach it through `service.unload`
  (`service:485-501`).
- `thread/closed` drops the record for any thread at the instance (`instance:1022-1026`). The session no longer drops it there
  (`session:1153-1155`).
- A process reset drops it:
  - a fresh start (`instance:705`);
  - an `exited` exit (`:973`);
  - a stdio dispose (`:565`).
- No other code calls `drop`, `forget`, `dropThreadCommands` or `reset`.

**Not correct: release no longer drops it.**
- `service.release` calls `transport.unload()` (`service:518`) before `close('release')` (`:520`).
- `unload` ends with `endLocal`, which sets `ended` (`session:929-931`).
- `close('release')` skips the drop when `ended` (`session:720-727`).
- An unloaded row's release goes to `endConversation`, which does nothing for the shared process (`service:542-560`).
- So no production release path drops the record. Before `52ee445`, `unload` dropped it, so release did.
- The test calls `session.close('release')` directly, without `unload` (`structured-codex-restart.test.ts:1039`).

**Bounded only by a reset.**
- After an unload or a release the thread has no session.
- An `item/completed` for it is counted as an unknown-thread frame and dropped (`instance:1038-1041`), so `forget`
  (`session:1439`) never runs.
- Only `thread/closed` or a process reset clears the record. Nothing in the tree shows that Codex sends `thread/closed` to a
  connection that has unsubscribed:
  - `protocol-brief.md:165` describes the unload, not who is told;
  - the test fake sends it unconditionally (`structured-codex-restart.test.ts:1052`).
- So "every `item/started` is matched by an `item/completed` or a reset" does not hold.

**Stop is unaffected.** Records are read only for listed terminals (`session:1026-1034`). See R6-1.

## R5-4. Expiry re-arms while the turn is unnamed: FIXED

- `working-state.ts:106-107` reschedules at `now` while `turnIsWorking` and `turnUnidentified` are both true.
- `manager:5429` passes `turnUnidentified && !turnActive`.
- **No busy loop.** `scheduleWorkingExpiry` arms `max(0, heartbeat + 60 s - now) + 100 ms`, about 60.1 s (`manager:5412`).
- **After the flag drops.**
  1. `turnIsWorking` is false.
  2. The expected heartbeat (the earlier `now`) differs from `lastOutputAt`, so the expiry reschedules to `lastOutputAt`, about
     100 ms later.
  3. That expiry writes `isWorking: false` (`working-state.ts:110-140`).
  4. With no `lastOutputAt`, it writes `isWorking: false` at once.
  5. Either way, working clears within about 60 s.
- Survivor adoption arms it (`manager:4281-4287`).
- **Tmux is unchanged.** `structured.turnUnidentified` is false for a row the service does not hold (`service:430-433`), so tmux
  rows pass `false`. The `runFailure` check moved ahead of `turnIsWorking` with the same result.

## R5-5. Claude bound for a hung CLI: FIXED

**Where the run lives.** It is a per-conversation map on the plugin (`claude/index.ts:23`, `:26`; `noteUnresponsive` at
`claude:818-823`).

**Ordinary resume with a launch record** (kind `survivor`, `claude:381`).
- **A silent host** counts only for `survivor` (`:638`, short-circuit). Past the limit, `endUnresponsiveHost`
  (`:676-684`):
  - calls `context.endHost`;
  - forgets the launch record;
  - clears the run.

  `resume` then continues to the holder check and to `launch('resume', ..., { transcriptPath })` (`:386-410`), so the CLI
  restarts with `--resume`.
- **A handshake timeout** is busy (`:742`). Past the limit it ends the process through `session.close('error')`, a terminate
  through the host (`claude-session.ts:546-557`). `bringUp` then resolves undefined (`:745-754`) and the same launch path
  follows.

**Ordinary launch that reconnects** (kind `launch`, not fresh).
- Same rule. The relaunch keeps the open's mode and transcript (`:599`).
- A fresh launch that times out is not busy (`:742`). It is closed and fails. There is no loop, because the run was deleted at
  `:752`.

**Reattach** (kind `reattach`, `:443`).
- `none()` and `bringUp` never note the run for it (`:638`, `:745`).
- A silence or a timeout never ends the process. See R6-5 for the one case that does end it.

**One run for both signals.** The same key is used for silences and timeouts. A success (`:769`), another failure (`:744`) or
an end (`:683`, `:752`) clears it.

**Host per conversation.**
- `hostIdFor(conversationId)` (`claude:879-881`, used at `:610` and `:677`).
- `terminateHost` reads only that host's record (`lt:733-742`).
- Row ids are UUIDs (`manager:2067`), so the sanitising and the 128-character cut cannot collide in practice.

## R5-6. Proof "command gone" window: FIXED

- `pollWithinWindow` (`structured-proof-kit.mjs:31-37`):
  - starts polling at the call;
  - takes its deadline from `since`;
  - attaches `.catch` to the returned promise, so there is no unhandled rejection;
  - surfaces the timeout where the promise is awaited.
- **The four call sites** start polling right after `stopped = Date.now()` and before the Escape call:
  - Claude `:419` and `:671`;
  - Codex `:546` and `:826`.
- They await after the idle wait and the asserts: Claude `:426` and `:677`, Codex `:550` and `:831`.
- `commandGoneAfterMs` is the first true read minus `stopped`.
- The `fb0dbac` runs record 163 ms and 171 ms (Claude), 158 ms and 175 ms (Codex).
- An assert that fails before the await leaves the poll running for up to 5 s in the background. This is harmless.

## Contract text and docs (R5-7): PARTIAL

**Fixed:**
- `structured-providers.md:733-737` matches the ownership rule.
- The unload comments match the code (`session:136-142`, `restart-state.ts:151-154`).
- The stale comments are corrected (`instance:637-640`, `session:1023-1025`).
- The round 4 list is no longer inside the open follow-ups.
- The second probe is recorded (`background-terminals-probe.md:32-55`).

**Still contradicting the code:** see R6-5.

---

## New findings

### R6-1. LOW (regression). The Codex command record is never dropped on release

**Where.**
- `service:504-521`: `unload()` at `:518`, then `close('release')` at `:520`.
- `session:714-718` and `:929-931`: `unload` ends the session.
- `session:720-727`: the drop is skipped once the session has ended.
- `service:542-560`: the unloaded-row path does nothing for Codex.
- `instance:1038-1041`: completions for a thread with no session are dropped.

**What breaks.**
- The record of a released thread stays until `thread/closed` reaches the backend (unverified after unsubscribe) or the shared
  app-server restarts. That can be days or weeks.
- The meta value `structured-codex-commands` grows with every release or sleep that had a command in progress. It is parsed and
  rewritten on every `item/started` and `item/completed` of every Codex thread (`restart-state.ts:134-177`).
- Stop is not affected.
- The R5-3 docs claim the record is dropped on release.

**Failing scenario.**
1. Turn 1 starts a dev server and ends. The record is `{cmd-1: turn-1}`.
2. The person releases the conversation: `service.release`, then `unload` (unsubscribe, `ended = true`), then
   `close('release')`, which does nothing.
3. The record stays.
4. When the dev server exits or the thread closes, nothing removes it.

**Why the test passes.** It calls `close('release')` directly.

**Possible fix.**
- Drop the record in the release path: let `close('release')` drop it even when the session has ended, or pass a release flag
  to `unload`.
- Test it through `service.release`.

### R6-2. LOW. The live-connection bound reads only responses as life, so a slow app-server can be let go with a loss line on every loaded Codex row

**Where.**
- `jsonrpc:441-446`: only `handleResponse` resets the run. Notifications (`:421-427`) and server requests (`:418-420`) do not.
- `instance:931-943`.
- `manager:4700-4710`.

**What breaks.** Three timeouts with no response between them let go of the shared connection, even while the process streams
notifications for running turns. Then:
- every loaded Codex row gets "The provider connection ended (the connection to the session host was lost). The session
  reconnects on next use.";
- the reason is misleading: it is the generic disconnect text (`jsonrpc:161`), although the Console let go on purpose;
- `isWorking` is cleared under turns that keep running;
- unattended rows enter run recovery (`manager:4709`).

Nothing is lost: the process is kept, and the turns are adopted again on the next load. The rows churn.

This answers the brief's question about a closed connection reaching the person as a loss line: the person sees this generic
loss line on every loaded row. Sends during the close are retried (see R5-1).

**Failing scenario.**
1. The host is under memory pressure. Three rows open at once, for example screen polls after a reconnect.
2. Their `thread/resume` requests share the live client. Each takes more than `requestTimeoutMs` (60 s, `session:93`) while two
   other rows stream turn events.
3. The three time out with no response between them, and the connection is let go.
4. The two working rows show the loss line and "not working" until they are loaded again.
5. If resumes stay slow, the next three repeat the cycle.

I did not verify whether codex-cli handles one connection's requests in sequence. If it does, this case is more likely.

**Possible fix.** Count any inbound frame on the live client as an answer for the run.

### R6-3. LOW. A caller that waited for a released connection reconnects on an instance the service is dropping

**Where.**
- `instance:584-591`: the caller waits, then `continue` starts a client on the same instance.
- `service:1057-1063` and `:1046-1054`: the lost sessions drop and dispose that instance.
- `instance:552-570`: `dispose('restart')` does not set `disposed`, so the dropped instance still starts connections.
- `instance:693-694`: a handshake that ends with an exit error resets the run.
- `lt:947-948`: a later connect replaces an earlier client.

**Failing scenario.**
1. Connection L on instance A is let go.
2. In the few milliseconds L takes to close, a new conversation starts. `service.start` calls `A.start`, which waits in
   `ensureClient`.
3. L exits. Its sessions are lost, and the service drops and disposes A. Nothing is starting yet, so `dispose` does nothing.
4. The waiter goes on and connects A again. Its conversation is registered on A, which the service no longer caches.
5. The next open of any other row builds instance B. B's connect replaces A's connection ("Another client took over this
   session host.").
6. The new conversation gets the loss line.
7. If A was still in its handshake:
   - the exit error resets the run at `:694` (it is not an answer);
   - the open fails with "The Codex app-server is not available: ...".

The window is the socket's close latency, so it is narrow.

**Possible fix.** After the wait, throw a retryable error (`NotSentError` or `TransportUnavailableError`) instead of
reconnecting. Alternatively, make a dropped instance refuse new starts.

### R6-4. LOW. Gaps in the run that are not documented

**A late answer to a timed-out handshake never counts.**
- The handshake client is closed at once: Codex at `instance:684`, Claude by detaching at `claude:760`.
- So "an answer (a late one too) ... ends the run" (`types.ts:351`, `structured-cutover.md:482`) is false for that path.
- An app-server whose `account/read` stays slower than `initializeTimeoutMs` (30 s, `session:94`) for 5 minutes is replaced,
  and every turn is killed, although it answers. This is pre-existing in the R4-1 design; the new text says otherwise.

**The run lives in memory** (`codex/index.ts:13`, `claude/index.ts:23`).
- A backend restart starts it again at zero, and the attach-only lookups at startup do not count.
- A person who restarts the Console because Codex rows keep saying "try again in a moment" resets the 5 minutes.

**A silent Claude host with no launch record is unbounded.**
- An ordinary Claude open with no launch record takes the factory's plain connect (`lt:922-930`).
- A silent host there fails plainly, with no run. This is the Claude twin of the first Codex open follow-up, which is listed;
  this one is not.

### R6-5. LOW. Doc and contract sentences that contradict the code

- **`structured-cutover.md:946`.** It says "(the next open, with the record written, is bounded)". A failed plain connect
  writes no record: `INSTANCE_META_KEY` is set only after a successful `startClient` (`instance:724-733`). So every later open
  in that state fails the same way, with no bound.
- **`structured-cutover.md:929-931`** (R5-3, "dropped on release") is false, see R6-1. **`:901`** (the R4-2 bullet) still says
  "dropped on release or unload".
- **`types.ts:343`** ("`reattach` ... never ends the process") and **`structured-cutover.md:483`** ("never counts and never
  ends anything"):
  - A Claude reattach of a survivor that the earlier backend never spoke to (`fresh`) ends it when its handshake fails other
    than by a timeout (`claude:756-757` with kind `reattach`).
  - Examples are the hooks or API-key launch checks (`:800-806`).
  - The behaviour is pre-existing; the absolute wording is new.
- **`types.ts:348`** ("or the host runtime record"). There is no second path. Both plugins use `PluginContext.endHost` and fail
  plainly without it (`instance:883-884`, `claude:678-679`).
- **`architecture.md:688-691`.**
  - It puts the Codex live-connection case under "reported busy for 5 minutes ... then ended ... and replaced in the same
    call".
  - The live case is not busy. Its requests fail with their own timeouts, the connection is let go (`instance:938-942`), and
    loaded rows get the generic loss line. The replacement happens in a later open.
- **`structured-cutover.md:482` and `architecture.md:690-691`** say Claude relaunches "with `--resume`". It relaunches in the
  open's own mode (`claude:599`).
- **`structured-cutover.md:917`.**
  - It cites `docs/research/cutover-2026-10-26/review-round-5.md`, which is not in the tree: `git ls-files` lists rounds 1 to 4.
  - The "Round 5" paragraph follows the R4-6 bullet (`:913-916`) with no blank line, so it renders as part of that bullet.
- **`structured-cutover.md:4-6`.** The status still reads "after each of four review rounds ... the round 4 fixes were run
  again". The round 5 run is recorded at `:617-627`.

---

## Overall verdict

The round 5 medium item, R5-1, is fixed in the code as read:
- the run and the request-id counter outlive the instance the service drops;
- a hang on a live connection is let go of after three timeouts, and the next open meets the bounded check;
- a silent session host on an ordinary start is bounded through `endHost`;
- attach-only never counts or ends anything for a silence or a timeout;
- a fresh start still terminates on failure;
- I found no deadlock in the close wait and no double replacement within an instance.

R5-2, R5-4, R5-5 and R5-6 are fixed. R5-3 is partial: `unload` and `thread/closed` are handled correctly, but no release path
drops the record any more (R6-1, a low regression). I found no high or medium finding and no tmux change. The `fb0dbac` real-CLI
runs on `52ee445` pass 14/14, 16/16 and 9/9. They do not exercise the hang paths, which rest on tests I did not run.

The branch is ready for the owner's integration review. Two things should go in the same pass or be listed as open follow-ups:
- R6-1: a small fix in the release path, plus a test through `service.release`;
- the R6-5 doc corrections, chiefly `structured-cutover.md:946`, `:929-931`, `:901` and `types.ts:343`/`:351`.

R6-2 to R6-4 can be listed as open follow-ups.
