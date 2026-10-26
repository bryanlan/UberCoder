# Review round 1: structured cutover (`77ec933..daa80d7`)

Reviewer: independent Opus pass, 2026-10-26. Read-only. Line numbers are `daa80d7`. The worktree's `apps/` and `packages/`
equal `daa80d7` (checked with `git diff daa80d7 -- apps packages`); only `docs/` and `scripts/` are dirty (the proof lane).

Scope note: `77ec933` is not an ancestor of `daa80d7`. The lane was rebased onto `main` `c094656`, so `git diff
77ec933..daa80d7` also contains `c094656` ("Clear delayed Claude prompt restoration after Stop": the
`clearStoppedNativeDraft` hunk in `session-manager.ts` and its test). `git diff 77ec933 6a3fcd9` is exactly that commit.
I reviewed the cutover as `6a3fcd9..daa80d7` and did not review `c094656`.

## What I ran

- Repo tests, one file at a time, `env -u NODE_ENV npx vitest run <file> --testTimeout 10000` in `apps/server`. All pass:
  - `structured-session-survivors` 11/11
  - `structured-session-migration` 19/19
  - `structured-session-requests` 22/22
  - `structured-session-default-transport` 7/7
  - `structured-session-per-session` 27/27
  - `structured-session-host` 33/33
  - `structured-claude-plugin` 131 passed, 3 skipped (the real-`claude` tests)
- Four scratch tests, outside the repo, in
  `(reviewer scratch) vt-c1/`.
  Run from `apps/server` with `env -u NODE_ENV npx vitest run --globals --dir <that dir> <name>`. Each drives real code
  (the real `SessionManager`, the real Claude or Codex plugin, the real session host where named) against the repo's
  fake `claude` or fake app-server, all inside a temp directory, and leaves no process behind (checked with `pgrep`).
  - `c1-empty-resume.test.ts`: finding 4.
  - `c1-reattach-midturn.test.ts`: finding 2.
  - `c1-claude-misattribution.test.ts`: finding 3.
  - `c1-codex-restart-midturn.test.ts`: finding 1.
- Not run: the full suite, any build, any real `codex`, `claude` or proof script.

Process check at the end: one session host from the proof lane is running
(`/tmp/console-structured-proof-nMOomj/runtime/structured/hosts/codex.sock`, pid 4030169). It is not mine and I did not
touch it. The proof lane should confirm that its cleanup ends it.

---

## Findings, ranked

### 1. HIGH. CONFIRMED (scratch test plus code trace). A Codex turn that survives a backend restart in the relayed app-server is declared lost. Recovery is then sent into it while it still runs, Stop does nothing, and an open question wedges the turn

The relay (C0) keeps the shared app-server and its running turn alive across a deploy. The host and the plugin still
behave as if the restart ended the turn, which was true before C0.

- `structured-session-service.ts:295-300` and `session-manager.ts:4180`: survivors are looked for only for
  `per-session` plugins. Shared Codex threads are resumed lazily, on first use.
- `session-manager.ts:4422-4423` and `:4457-4471`: the first reconcile, or any earlier load such as the screen poll,
  calls `settleLostStructuredTurn` for an unloaded row with `isWorking`. That writes "The provider connection ended (the
  previous connection ended while a turn was running)", clears `isWorking` and calls `runRecovery.processExited` for
  unattended work.
- `app-server-session.ts:993-1003` (`recordFor`): after the reconnect and `thread/resume`, the new session object knows
  no turn. Every event of the turn that is still running is dropped as "a turn this session does not track", including
  its `turn/completed`.
  - Scratch test `c1-codex-restart-midturn`: after `dispose('shutdown')`, a new instance and `resume`, the session reports
    `activeTurnId: null`. When the app-server finishes the turn, the session emits no `item.completed` and no
    `turn.terminal`; `droppedTurnEvents` is 2.
- Effects:
  - Unattended work: after its backoff, RunRecovery restores the thread and `deliverAutomatic` sends `RECOVERY_PROMPT`
    (`activeTurnId` is undefined) while the original turn still runs.
  - Stop: `structured.interrupt` returns `'idle'` (`structured-session-service.ts:458-461`), so nothing reaches Codex.
  - Coordination wakes: they see no running turn and are delivered into the running turn.
  - The pane is driven by the rollout, so it shows new output while the row says it is idle.
- Held questions (C3): `app-server-instance.ts:382-394` calls `endLocal` on every session (`cancelQuestions` then
  `settle(NO_ANSWERS)`, `app-server-session.ts:703-741`), then `client.close()`. `client.close()` reaches
  `HostLineTransport.disconnect`, which calls `socket.end()` synchronously. The reply is written one microtask later
  (`jsonrpc.ts:463-466`), finds `!socket.writable`, and is dropped (`jsonrpc.ts:474-476`).
  - Codex keeps waiting for an answer to that JSON-RPC id. The new backend has deleted `structured-requests:*`
    (`session-manager.ts:437`) and has no way to learn the id, so the turn waits for ever.
- Fix:
  1. On the first reconcile, when the `codex` host record is alive, connect and `thread/resume` every awake structured
     Codex row, before any loss handling.
  2. Have the Codex session adopt a running turn on resume: read `thread.status` from the resume response, or start a
     provider-origin record for the first `item/*` or `turn/completed` that names an unknown turn while the thread is
     `active`.
  3. Skip `settleLostStructuredTurn` for a row whose provider host survived until that resume has answered.
  4. Persist held `requestUserInput` ids and params in meta, and let the next client answer them by id over the same
     relayed stdin.
  5. Add a plugin test for a restart during a turn, and a proof step for it.

### 2. HIGH. CONFIRMED (scratch test). A reattached Claude process is adopted without its running turn. Stop does nothing, a suspend ends the process mid-turn, and a load before the first reconcile declares the turn lost

- `claude-instance.ts:594-609` (`handshake`): the repeated `initialize` reply carries `session_state` (observed in
  `r2-control-noauth.jsonl` as `"session_state":"idle"`; `protocol.ts:113` types it). The code never reads it. The new
  `ClaudeSession` learns of a running turn only from the next frame. A long Bash or MCP call produces no frame until it
  ends.
- Scratch test `c1-reattach-midturn`: real `SessionManager`, real plugin, real session host, and a fake turn of 6 s of
  silence. The backend restarts mid-turn and `reconcileSessions` adopts the process (same pid). Measured:
  - `alive=true`, `turnActive=false`, `isWorking=true`;
  - Escape returns OK but writes no `interrupt` frame;
  - `suspendSession` succeeds, and the CLI receives stdin EOF and then SIGTERM before its `result`.
- With production graces (5 s, then SIGTERM), the same suspend kills the tool call.
- `session-manager.ts:4194` schedules the working-state expiry. `providerTurnIsWorking` returns `turnActive`, which is
  false, so `isWorking` clears after 60 s. The row then counts as idle for wakes, and as eligible for idle sleep and
  pressure suspension once the usual windows pass.
- Race at boot: `reattachStructuredSurvivors` runs only in the first `reconcileSessions`, 5 s after start. The web polls
  `/screen` every second. `getStructuredSessionScreen` (`session-manager.ts:4478-4483`) reaches
  `refreshStructuredSessionState` and then `settleLostStructuredTurn` first. For the conversation Bryan has open during a
  deploy, that writes the loss line and starts unattended recovery for a turn that is still running. The restore that
  follows adopts the process through `resume`, and finding 3 then mis-credits the recovery prompt.
  - Queued-input drains and wakes reach the same path.
- Fix:
  1. In `handshake`, when `!fresh` and `body.session_state` is not `idle`, start a provider-origin turn right after
     `announce()` (`ensureProviderTurn()`). The `result` that follows then ends it.
  2. In `refreshStructuredSessionState`, when the provider is `per-session`, try the survivor lookup before
     `settleLostStructuredTurn`, rather than only once in the first reconcile.
  3. Extend `structured-session-survivors` with the real plugin: Stop and suspend after a reattach during a quiet tool
     call.

### 3. MEDIUM-HIGH. CONFIRMED (scratch test). A message sent while the CLI runs a turn this session does not know about is credited with that turn's frames and `result`, and its own run is then dropped

- `claude-session.ts:1052-1056` (`attachTurnFrame`) and `:1008` (`onResult`): both fall back to the pending send when no
  uuid matches. The comment says "No uuid names the turn (an older CLI)", but neither checks that the frame carried no
  uuids. A frame or `result` whose `user_message_uuids` name an unknown turn is attributed to the pending send.
- Scratch test `c1-claude-misattribution`: reattach during the quiet tool call (finding 2), then `sendTurn('new message')`.
  - The CLI wrote two results, for `[OLD]` and then `[NEW]`.
  - The session emitted `turn.started NEW` on OLD's assistant frame and `turn.terminal NEW completed` on OLD's `result`.
    NEW's real run then emitted nothing: no item and no second terminal.
- Effects:
  - The Console reports the message completed (and sets `lastResponseAt`) before it has run.
  - It shows the row idle while the CLI runs it.
  - A RunRecovery or wake prompt sent in that window is "completed" by the old turn.
- Second defect in the same lines: `markStarted(this.pending)` clears `this.pending` (`:1075`), so `return this.pending`
  returns undefined and the frame is dropped. That is why the scratch run shows no item for either turn.
- Fix:
  - Use the pending fallback only when `messageUuidsOf(frame)` is empty. A frame or result that names only unknown uuids
    goes to `ensureProviderTurn()`.
  - Return the record, not `this.pending`.
  - Finding 2's `session_state` fix removes the most common trigger, but this fallback is still wrong.

### 4. MEDIUM. CONFIRMED (scratch test). A new headless Claude chat that never ran a turn cannot be restored once its process has ended, and the row stays in error

- `claude-instance.ts:327-337`: `resume` throws `ResumeFailedError` when there is no transcript, or when the transcript
  holds no conversation. The CLI writes neither until a prompt reaches the model.
- The plugin supports `start({ sessionId })` for exactly this case (`:300-311`; the plan says "resume it with
  `--session-id` again"). Nothing in the host ever passes `sessionId`: `openOptions` (`structured-session-service.ts:601-620`)
  has no such field, and the restore path always calls `resume`.
- Scratch test `c1-empty-resume`: bind a new headless chat, send nothing, backdate 61 minutes, reconcile (idle sleep ends
  the process), then send. Result:
  - the send is rejected "Session is no longer running";
  - the row is `status: error`;
  - the status line reads "Failed to restore session: Claude has no transcript for session …, so it cannot be resumed."
- Every later reconcile retries the restore and fails the same way.
- Other ways in: a process that dies, is SIGTERMed or is released before its first prompt reached the model (for
  example, MCP startup waits up to 30 s).
- Fix: when the transcript has no conversation and no holder exists, `ClaudeInstance.resume` launches `mode: 'new'` with
  the same id. It is already guarded by `locateTranscripts` and `assertNotHeld`. Add a host test with the real plugin.

### 5. MEDIUM. CONFIRMED (existing test asserts it). `resume()` with a live holder and a recorded launch can start a second `claude` beside the holder

- `claude-instance.ts:319-326` hands the recorded argv to `launch(... { reattach })`. `launchProcess`
  (`:459-470`, `:480-484`) then calls the factory without `attachOnly`.
  - When no live host runs that argv, `openHost` (`line-transport.ts:876-903`) retires whatever is recorded and starts a
    new host and a new `claude`. Only then does the plugin see `fresh`, terminate it and throw `ClaudeSessionHeldError`.
  - A plain stdio factory always does this.
- `structured-claude-plugin.test.ts:1292-1304` asserts the extra process: `startEntries … toHaveLength(1) // the
  throwaway process`.
- When it happens:
  - Launch records are deleted only when this backend sees the exit (`:562-566`). A reboot, or a process that ends while
    no backend is connected, leaves a stale record.
  - Bryan later runs `claude --resume <id>` in a terminal, so his TUI is the holder.
  - He then uses the conversation in Console.
- Damage:
  - The throwaway process runs the global hooks. `SessionStart` re-registers the coordination owner, then `SessionEnd`
    sends `disconnect` for the assignment (`scripts/agent-coord.mjs:206-221`). That is the assignment of Bryan's own
    session.
  - The throwaway process holds the transcript until it exits.
  - It has a sibling defect: a reconnect to a host whose child the earlier backend never wrote to is also `fresh`. The
    plugin then terminates the real survivor and throws "held" with the survivor's pid (self-healing on the next try,
    with a misleading status line).
  - With `sinceSeq: 0` (`:469`), a non-reattach launch that reconnects to a used host replays that host's old output
    into the new session.
- Fix:
  - In the holder branch, call `attachSurvivor` (it uses `attachOnly`). When it returns undefined, throw
    `ClaudeSessionHeldError` without starting anything.
  - Delete launch records whose host record is absent or dead at startup.
  - Request `sinceSeq: 0` only from a transport the factory actually started. That needs a `started` flag on the
    factory result, not `everWrote`.

### 6. MEDIUM. CONFIRMED (code). The migration silently stops a tmux row's scheduled or running unattended recovery

- `classifyForStructuredMigration` (`session-manager.ts:4017-4032`) never looks at `runFailure`.
  `migrateTmuxRowToStructured` calls `this.runRecovery.cancel(session.id)` (`:4094`). That stores `status: 'stopped'`,
  "Automatic recovery cancelled by user input or Stop." (`run-recovery.ts:119-134`).
- Typical case at the flip:
  1. A tmux row's unattended turn failed `server_overloaded`, or its process exited, and a retry is scheduled. The row is
     not working, so it classifies as `idle` or `dead`.
  2. It moves, and its recovery is cancelled with a reason that blames the person.
- Idle sleep has the same cancel, but only after the idle window; the migration acts at once.
- Fix: classify rows with `runFailure.status` `scheduled` or `retrying` as a waiting outcome (for example
  `recovering`), or carry the budget over by watching the converted row under its structured key instead of cancelling.
  Add a migration test.

### 7. MEDIUM. CONFIRMED (code). Granted launches lose their `flags` on the structured path, and the default flip sends every granted launch there

- The tmux launch passes `launchContext.flags` (`session-manager.ts:2310`; `claude-provider.ts:201`).
- `bindStructuredConversation` (`:4736-4744`) and the service `openOptions` (`structured-session-service.ts:601-620`)
  never read them, and no plugin does.
- `grants/session-launches.ts:81,135` accepts agent-supplied `flags`.
- With `defaultTransport: structured`, a helper launched with, for example, `--add-dir` or `--permission-mode` runs
  without them and nobody is told. Migrated granted rows lose theirs on resume.
- Fix (decision for Bryan): fail fast, either by refusing a structured launch with non-empty flags or by keeping such
  launches on tmux, or map an explicit allowlist into the Claude argv. Do not drop them silently.

### 8. MEDIUM. PLAUSIBLE. Claude image attachments go to the API raw, up to 10 MiB, and the prompt also tells the model to open the files again

- `claude-session.ts:573-578` base64-encodes the stored file unchanged. `ImageStore.save` accepts up to 10 MiB and 20 MP
  without re-encoding (`images/store.ts:19-41`).
- The Messages API rejects images above 5 MB, and a large screenshot is easily above that.
  - The tmux path never hit this: Claude read the file with `Read`, which downsizes.
  - UNVERIFIED: whether the CLI downsizes base64 blocks itself. If it does not, the turn ends `image_error`, and the
    image now in the transcript may fail every later turn.
- Both providers also keep the envelope text "Inspect the attached local image files with Read / view_image…" in the
  turn text (`session-manager.ts:4341`, `drainStructuredQueuedInput` passes `record.text`). The model is told to open
  the files a second time, so each image is charged twice.
- Fix:
  - Downscale and re-encode to the API limits with `sharp` before the block is built, or refuse oversized images at
    admission.
  - Strip the instruction line from the text sent to transports that attach images natively, keeping the envelope rows
    for display.
  - Add a proof step with a screenshot-sized PNG.

### 9. MEDIUM-LOW. CONFIRMED (code). Release, idle sleep, pressure and work-release end only loaded sessions, so an unadopted survivor runs until its conversation is used again

- `structured-session-service.ts:407-411` (`release`: `if (!state) return`) and `:394-396` (`unload`) leave a surviving
  host alone when the row is not loaded. `session-manager.ts:3828-3835` and `:4495` rely on them.
  `terminateHost(runtimeDir, 'claude-<id>')` is never called from the host, and nothing sweeps
  `structured/hosts/claude-*.json` for rows that are released or gone.
- When a survivor is not adopted:
  - the reattach failed (finding 5's held error, an `initialize` timeout, which leaves it running by design through
    `detach`);
  - the row was not "awake" (`starting` or `error`);
  - the project lookup failed at boot.
- Effects: a release leaves 300 to 400 MB running for ever, plus the launch record. Idle sleep marks the row asleep while
  the process keeps running.
- Fix:
  - Give the service a per-session "end whatever is running for this conversation" call: `terminateHost` for the
    conversation's host id, plus dropping the launch record. Call it from `release` and `unload` when the row is not
    loaded.
  - At boot, end hosts whose conversation has no restorable row.

### 10. LOW-MEDIUM. PLAUSIBLE. A live but slow host is treated as dead and terminated

- `line-transport.ts:883-901`: when the recorded host is alive and its argv matches, but `connect` (3 s) or the welcome
  (5 s) times out, `openHost` logs "did not answer; replacing it" and calls `retireHost`. That signals the host, which
  ends its child.
- For Codex, that ends every thread's running turn. On this memory-constrained host, a 5 s stall under heavy swap is
  realistic.
- Fix: when the identity check says the host runs, fail the open with `TransportUnavailableError` and let the next use
  retry. Retire only a host whose identity is gone, or whose argv differs.

### 11. LOW. CONFIRMED (code). Nobody sweeps the process group after a relayed child ends on its own

- `session-host.ts:574-589` (`onChildEnded`) never signals the group. `terminateChild` skips the sweep when the child had
  already exited (`:623-626`).
- `StreamJsonClient.reapProcessGroup` deliberately skips host transports (`stream-json.ts:263-271`), and its comment
  says "A session host reaps its own group". That holds only for `terminate`.
- After a crash or OOM kill of `claude` or `codex`, MCP servers and background shells in its group outlive it.
- Fix: `sweepGroup()` in `onChildEnded` (after the 200 ms flush), and in `terminate` when the child is already gone.

### 12. LOW. CONFIRMED (code). Stop drops queued steers without telling the host

- `claude-session.ts:409-421`: `interrupt` sends `cancel_queued: true` and checks the `cancelled` list only for the turn's
  own id.
- A steer the person typed mid-turn, still queued when they press Stop, is discarded by the CLI. The journal still shows
  it `submitted` (`mode: 'steer'`).
- Fix: for each cancelled uuid that belongs to a steer, emit a notice. Better, report it to the host so the queue item
  can become "not delivered" or be requeued.

### 13. LOW. CONFIRMED (code). Errors that certainly sent nothing are recorded as "could not be confirmed"

- In `sendTurn` (`claude-session.ts:361-390`), these happen before the user frame is written and are rethrown as plain
  errors:
  - an unreadable image (`fs.promises.readFile` in `buildUserFrame`; `structured-claude-plugin.test.ts:429` asserts
    nothing was written);
  - a `set_model` or `apply_flag_settings` refusal or timeout (`applySettings`).
- `drainStructuredQueuedInput` (`session-manager.ts:4356-4357`) then marks the message failed and uncertain.
- Fix: throw `NotSentError` (or `StructuredUnsupportedError` for an unreadable image) for anything that fails before
  the frame write.

### 14. LOW. CONFIRMED (code). An answer to a request the CLI just withdrew reports success

- `ClaudeSession.respond` (`:430-435`) and `CodexAppServerSession.respond` (`:556-561`) return silently for an unknown id.
- When the withdrawal or the turn's end is still in the event queue, `StructuredSessionService.respond` sees the question,
  forwards the answer, closes it, and the route answers 200. The answer reached nobody.
- Fix: throw a not-pending error from the plugins when the id is not open. The service already maps that to 404.

### 15. LOW. CONFIRMED (code). Re-adopted questions after a reattach move recency and repeat the status line and the push

- `client.adoptServerRequests(pending)` (`claude-instance.ts:588`) runs `onServerRequest`, which calls
  `ensureProviderTurn()` (`claude-session.ts:1160`).
- The resulting provider-origin `turn.started` sets `lastActivityAt` (`session-manager.ts:4582`). This is restore
  activity, which AGENTS.md excludes from recency.
- `handleStructuredQuestion` appends "The agent asked a question" and pushes again.
- Fix: mark adopted requests as replay. Do not move recency for a provider turn that a reattach created. Skip the line
  and the push when the request id was already announced.

### 16. LOW. CONFIRMED (code). Question and command text of declined requests reaches the event log

- `session-manager.ts:470` writes `Declined a provider request: ${summary}`.
- For a Codex `requestUserInput` that cannot be shown (a secret or malformed question), the summary is the question's
  header and text (`app-server-session.ts:239-241`).
- For a Claude permission request, the summary is the command (`claude-session.ts:1207-1212`).
- The assignment's rule is that question text stays out of the event log.
- Fix: for `kind: 'question'`, log a fixed line ("Declined a question the Console cannot show"). Keep the details in
  the server log.

### 17. LOW. CONFIRMED (code). `imagePromptFiles` accepts any absolute `<uuid>.<ext>` path, not only the image store

- `images/prompt.ts:57` checks `path.isAbsolute` and the basename only. The prompt text is authored by the signed-in
  person, so this is defence in depth.
- Fix: pass the store directory in and require `path.dirname(image.path) === storeDir`.

### 18. LOW. PLAUSIBLE. The background-work guard after a reattach depends on an unsolicited frame and one event-loop turn

- The code relies on an unsolicited `background_tasks_changed` snapshot "right behind the reply to the repeated
  initialize". It is modelled in `fake-claude.mjs:374-377`; UNVERIFIED against the real CLI.
- `session-manager.ts:4206` waits a single `setImmediate` for it. The idle decision of the same pass can run before the
  frame arrives from the host socket.
- Fix: request `background_tasks` explicitly (a documented control subtype) during the reattach handshake and await the
  reply.

### 19. LOW. CONFIRMED (code). `CLAUDE_CODE_*` keys in `structuredSessions.claude.env` are dropped silently

- `claude-instance.ts:129-133` applies `isScrubbedKey` to the configured layer too. A setting such as
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is ignored without a word.
- Fix: scrub only the inherited environment. Or reject such keys when the config is parsed, with an error that names
  them.

### 20. LOW (decision). CONFIRMED (code). The default Claude profile changes model and effort for history-bound and migrated rows

- `DEFAULT_PROFILES = { claude: 'medium' }` (`structured-session-service.ts:123`) is `claude-opus-5-5` at `xhigh`.
  - The tmux template resumed those rows at `--effort medium`, with no model.
  - Rows whose tmux `newCommand` pins `--model` were deliberately given no profile (`session-manager.ts:2323-2324`); on
    the structured path they get `medium` stored on the row.
- Fix: Bryan chooses. Either keep `medium` and accept the higher cost of `xhigh`, or map a row with no profile to the
  provider command's flags.

### 21. LOW. CONFIRMED (code). Held Codex questions occupy JSON-RPC handler slots on the shared process

- Each held `requestUserInput` counts against `MAX_CONCURRENT_SERVER_REQUEST_HANDLERS = 32` (`jsonrpc.ts:440-456`) until
  it is answered. At 32 open questions, every further server request, including approvals that must be declined, gets
  `-32001`.
- Fix: exclude held questions from the cap.

---

## In progress (working tree, not committed): proof scripts and docs

- **P1.** `prove-structured-claude.mjs` step k proves a restart while the session is idle only. The plan asks for "a
  backend restart with a running turn that survives through the relay". Findings 1 to 3 live exactly there.
  - Add: a restart during a 60 s `sleep` Bash call.
  - Assert that Stop interrupts it after the restart, and that the turn's terminal is reported once.
  - Assert that a message sent during the call is not credited with the old result.
  - Run the same once with a screen poll before the first reconcile.
  - The Codex proof needs the same step.
- **P2.** The image steps (`prove-structured-claude.mjs:421`, Codex `h3`) use a tiny solid PNG. Add a 5 to 10 MiB
  screenshot-sized PNG (finding 8).
- **P3.** `prove-structured-migration.mjs:51-58` appends `--strict-mcp-config` (Claude) and the coordination `-c`
  overrides (Codex) to the tmux commands. The product does not do this. It is needed for isolation, but the tmux phase
  then runs a configuration production never runs. Record that in the evidence.
- **P4.** Cleanup: `createProofKit` (`structured-proof-kit.mjs:45-49`) creates the temp root and runs `git init` before
  any caller is inside its `try`/`finally`, so a failure there leaves the temp root. Nothing secret is in it yet.
  Otherwise, cleanup runs on every path:
  - release, backend shutdown, `terminateHost` per host id;
  - SIGTERM, then SIGKILL, only to processes whose command line holds the temp root or whose environment holds the temp
    runtime;
  - the private tmux server, then the temp root.
  - SIGINT and SIGTERM now let cleanup run.
- **P5.** Live safety: OK.
  - Only `app.inject` is used: no listening port, no call to the live Console.
  - Database, runtime and tmux socket are temporary.
  - `~/.config/agent-console/config.json` and `~/.claude.json` are only read.
  - Claude transcripts are removed only under `~/.claude/projects/<escaped temp path>`, plus the `session-env` and
    `file-history` folders of the proof's own session id.
  - Codex rollouts stay in `~/.codex/sessions`, as accepted in round 2.
  - Real turns run on Bryan's login and his global hooks. The hooks are pinned to the temp runtime through the
    environment; the Claude MCP name clash is recorded as the proof's `mcp-precedence` finding.
- **Docs.** At `daa80d7`, `docs/structured-cutover.md` still lists survivor reattach and the default profile under "Open
  items found while building C2", although `daa80d7` implements both. The working-tree edits may already fix that.

---

## Verified OK

- **Session host identity and signals.** Nothing is signalled unless pid, start ticks (field 22, parsed after the last
  `)`) and boot id all match. The identity is checked again before SIGKILL. The socket path is never taken from the
  record. A group is signalled only when `/proc` says the pid leads it. `processGroup` must equal the child pid, or the
  record is dropped. `removeRecord` never deletes a successor's record.
- **One client at a time.** `hello` replaces the earlier client, which gets `replaced` and does not reconnect.
  `write` is accepted only from the current client. `status` and `terminate` work from any connection, and those
  connections never become the client. The factory serialises opens per host id (`chains`).
- **Socket.** The socket is created under `umask 0177`, then `chmod 0600`; the directory is 0700 with an explicit
  `chmod`. The client limit is 100 bytes, and longer paths are hashed. The host refuses over 107 bytes. The production
  Claude socket (`…/runtime/structured/hosts/claude-<uuid>.sock`, 112 bytes) is hashed to 85 bytes. The env file is 0600,
  created with `wx`, and deleted by the host on read. The host environment is an allowlist, and the identity variables
  are scrubbed again inside the host.
- **Replay buffer.** Bounded at 4 MiB and 10 minutes. A line larger than the buffer clears it, so a replay never skips
  silently. A cursor newer than the host's newest line reports a gap. `gap` is never read by a plugin; it is unused API,
  harmless.
- **`terminate`.** stdin EOF, grace, group SIGTERM, grace, group SIGKILL, then a group sweep. An unkillable child is
  reported and the host stops anyway.
- **pdeathsig.** The child is spawned through `setpriv` from the host's main thread (libuv forks on the calling thread),
  so pdeathsig is tied to the host. A missing binary is started plainly, so the error is ENOENT.
- **`reattach` (Claude).** It never spawns (`attachOnly` in `attachHost`). It refuses records for another session id or
  an argv that does not name the native id. It runs the `~/.claude/sessions` holder check with the host's child ignored,
  disconnects without ending the process on refusal, and never attaches to another conversation's host, because the host
  id comes from the Console session id. It refuses while the conversation is loaded or opening.
- **Holder check.** `findSessionHolder` ignores files whose `procStart` mismatches. Without `procStart`, a pid counts
  only when it looks like `claude`.
- **`requireHooks`.** The fail-fast check runs on fresh launches only (`resume` launches included) and checks the
  API-key auth source at `initialize` and at the first `system/init`.
- **Environment.** The configured layer cannot set `CLAUDECODE`, `TMUX` or `CLAUDE_CODE_*`. `AGENT_CONSOLE_SESSION_ID` is
  always the conversation id. The coordination MCP is pinned per conversation (`buildMcpConfig`), which closes the
  round-2 split-brain finding for Claude.
- **Exactly one terminal.** `finalize` is the only emitter. Late results of locally closed turns are dropped. Fan-out
  over `user_message_uuids` works. A repeated uuid is "already handled" and ends the send once. The interrupt grace,
  interrupt-before-start (from the `cancelled` list) and cancel-settle all work. The idle-without-result guard is 1 s.
- **Server requests.** Every `can_use_tool` and `elicitation` is answered: by the handler, by a default when there is
  none or it throws, by a deny on close or exit, or by `control_response` error for unknown subtypes. Requests are left
  open only on `detach` or disconnect, on purpose, and are re-adopted through `pending_permission_requests`. That field
  sits on the response envelope, which matches the real CLI frame in `r2-control-noauth.jsonl`. Its entry shape is
  UNVERIFIED (empty in every probe). `control_cancel_request` closes requests in both directions.
- **Idle sleep, pressure, manual suspend, release (loaded per-session rows).**
  - Idle sleep sets `closing` before `unload`, so the stop is not a lost connection and starts no recovery.
  - Pressure keeps the tmux guards: no turn, no queued input, no model change, no active assignment, two samples, the
    idle window, one per pass. Shared-process rows are still skipped.
  - Release ends the process without unloading it first.
  - The background-work guard has a 4 h cap with no events, measured on any transport event. Covered by
    `structured-session-per-session`.
- **Pending requests.** One answer gets through: the `answering` set plus the session lock. Requests are dropped at
  their turn's terminal and at the next turn's start. Stale `structured-requests:*` keys are deleted at boot and when a
  new connection registers. The route is authenticated with a CSRF token, and its body is bounded. The question text is
  kept out of the event log for questions that are shown. The push body is the summary: at most 120 characters,
  redacted.
- **Default transport.**
  - `resolveDefaultTransport` is shared by the routes and the manager.
  - An explicit `structured` still gets 400 when the lane is off, and 409 against a tmux binding.
  - A bind with no transport returns an existing tmux binding.
  - Granted launches and auto-tracked binds follow the default, apart from the `flags` loss in finding 7.
  - The tree advertises a provider only when its lane is on and a plugin is registered.
- **Migration.**
  - It runs only when the default is `structured` and the lane is on, one row at a time under the row lock. A failure
    never stops the pass.
  - It skips `pending:`, not-bound, working, queued-input and model-change rows, Claude rows without a readable indexed
    transcript, and rows whose provider process runs outside the binding.
  - A live tmux session passes the idle-sleep guard, the owner check, the kill, and a confirmation that the session is
    dead.
  - `setTransport` is a compare-and-set in one transaction and keeps the existing sleep markers.
  - The dry run is read-only.
  - For Claude, the later `--resume` holder check also catches a TUI process that outlived its tmux session. For Codex
    only the tmux session's death is checked, which is a residual risk: a Codex TUI that ignores SIGHUP is not caught.
- **tmux rows.** No behavior change while `defaultTransport` stays `tmux`:
  - the reconcile pressure branch is guarded by `transport !== 'structured'`;
  - `isPressureSuspendable` changes only structured rows;
  - the route's 409 condition is equivalent when the default is tmux;
  - `pendingRequests` are projected only for structured rows;
  - the migration is off.
- **Codex shared rows.**
  - The handshake repeat after a half-finished handshake is correct (`account/read`, then "Not initialized", then
    `initialize`).
  - `dispose` leaves the process and its meta record in place on purpose.
  - `NotSentError` semantics survive the transport refactor (`jsonrpc.ts` `request` and `notify`).
  - Images map to `localImage`.
  - The config schema change in `60057ee` (factory schemas, fresh default arrays, `defaultTransport`, the `claude`
    block) changes nothing for an existing Codex block.
- **Coordination liveness.** Still "a restorable bound structured row". The only change in `coordination/service.ts` is a
  comment.

---

## Test quality

- **Real plugin vs fake plugin.**
  - The real Claude plugin is exercised only at plugin level (`structured-claude-plugin`), against the fake `claude`,
    with and without a real session host.
  - Every `SessionManager` test of per-session behavior uses `FakeTransportPlugin`: per-session, survivors, migration,
    requests, default transport.
  - The fake's survivors report a running turn when the test pushes `turn.started` (`structured-session-survivors.test.ts:124-145`).
    The real plugin does not do that, so the host tests pass where the real stack fails (findings 2 and 3).
  - The test at `:146-169` codifies clearing the working flag of a survivor that is still silent.
- **Codified as intended.** `structured-claude-plugin.test.ts:1292` asserts the throwaway process of finding 5.
- **Untested branches.**
  - Codex restart with a running turn, or with a held question (finding 1).
  - Claude reattach during a quiet tool call, and a send in that window (findings 2 and 3).
  - Restore of a structured Claude row that never ran a turn (finding 4).
  - Migration of a row with a scheduled recovery (finding 6).
  - A structured granted launch with flags (finding 7).
  - Release or idle sleep of an unloaded row whose host survives (finding 9).
  - A slow host on `openHost` (finding 10).
  - The group after a relayed child crashes (finding 11).
  - Stop with a queued steer (finding 12).
  - An answer that loses the race to a withdrawal (finding 14).
  - The screen poll before the first reconcile (finding 2).
- **Unverified against the real CLI**, and modelled only in the fake: the background-task snapshot after a repeated
  `initialize`, the entry shape of `pending_permission_requests`, and whether `initialize` is answered mid-turn.
- **Good coverage.** The protocol mechanics, result classification, host lifecycle, identity gating, migration guards and
  request plumbing have direct tests.

---

## Summary

1. The relay, identity gating, socket handling and replay are sound. No path signals an unrelated pid or attaches to
   another conversation's host.
2. The cutover's core promise is not met yet. A turn running across a deploy survives in the provider process, but
   Console loses track of it.
3. Codex: the turn is declared lost, recovery is injected into it, Stop does nothing, and a held question wedges it
   (finding 1, CONFIRMED).
4. Claude: the adopted process has no running turn, so Stop and suspend misbehave. A screen poll before the first
   reconcile declares the turn lost, and sends in that window are credited with the old turn (findings 2 and 3,
   CONFIRMED).
5. A new headless Claude chat that never ran a turn breaks for good after idle sleep (finding 4, CONFIRMED). The fix is
   small.
6. `resume` with a holder can start a throwaway `claude` with hook side effects (finding 5).
7. The migration cancels unattended recovery (finding 6). Granted-launch flags are dropped (finding 7).
8. Images up to 10 MiB go to the API raw, against its 5 MB limit (finding 8, PLAUSIBLE).
9. The tmux path is unchanged while the default stays `tmux`. The Codex shared lane changes only through the relay
   behavior in finding 1.
10. Not ready for Bryan's integration review. Fix findings 1 to 4 first, with tests through the real `SessionManager` and
    the real plugins, and a mid-turn restart proof step (P1). Findings 5 to 9 need a fix or Bryan's explicit acceptance
    before the flip. 10 to 21 can follow. Still unproven against the real CLI: `--system-prompt-snapshot off` on resume,
    `ExitPlanMode` under bypass, and the snapshot and pending-request shapes after a repeated `initialize`.
