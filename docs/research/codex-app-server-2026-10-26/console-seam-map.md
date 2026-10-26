# Agent Console: tmux/screen seam map for a "structured" session transport

Date: 2026-10-25. Repo: `/home/bryan/code/UberCoder/agent-console-mvp/agent-console` at `main` `af009e3` (clean). Read-only research; nothing in the repo was edited, built or run. Line numbers refer to that commit. "SM" = `apps/server/src/sessions/session-manager.ts` (4,540 lines, 112 `tmuxClient`/`checkTmuxLiveness` call sites, 51 screen-capture/wait call sites, 41 `provider === 'codex'|'claude'` branches).

Codex protocol facts below were checked against the installed `codex-cli 0.164.0` by generating its app-server JSON schema into the scratchpad (`codex app-server generate-json-schema --out .../scratchpad/codex-schema`). Anything not checked that way is marked **(verify)**.

---

## 0. Bottom line

- **Every live-session behavior today assumes "conversation = one hidden tmux pane whose screen we parse."** Liveness is `tmux has-session`, ownership is the tmux option `@agent_console_session_id`, the provider PID is the pane PID, readiness is a parsed composer, delivery is paste plus Enter, Stop is an Escape key, a model switch is kill plus relaunch, sleep is `kill-session`, and restore is `codex resume` in a new pane.
- **Durable history, recency, the queue journal, run recovery and coordination state are already mostly transport-neutral.** They live in SQLite (`bound_sessions`, `meta`), the per-session `events.jsonl`, and the provider transcript, which Codex app-server still writes as a rollout file (`Thread.path`, marked "[UNSTABLE]").
- **Recommended seam:** keep `bound_sessions` as the one binding table and keep SessionManager as the lifecycle owner: per-session lock, journal, recency fields, realtime events, reconciliation scheduler, RunRecovery and the input queue journal. Add a `transport` column (`'tmux'` default, `'structured'`). SessionManager should hand the transport-specific operations to a sibling module (for example `sessions/structured/`), choosing by `session.transport`, through a small interface. In slice 1 do **not** move the tmux code behind that interface. Add an early `if (session.transport === 'structured')` dispatch at about 20 entry points, so the tmux path stays byte-for-byte unchanged.
- **Do not use a separate table or service (unlike `design/extension-agent-lane`).** That design isolated Grok on purpose: it had to be *invisible* to `bound_sessions` readers. The structured lane must be *visible* to the same readers: the conversation route, tree, search, coordination wake, grants, worker panel, receipts, audit and worktree sweep. The price of sharing the table is that every reader below that infers "alive / ready / owned" from tmux or the pane PID needs an explicit transport branch. Without it, a structured row looks like a dead tmux session, and several paths would then **launch a tmux TUI for the same thread**, creating a second writer (see "Riskiest coupling points").

---

## 1. Session creation and launch

### What exists
- **New Chat route:** `routes/conversations.ts:360-431` `POST /api/conversations/:projectSlug/:provider/new/bind`.
  - It reuses an existing bound pending chat for the project/provider (382-401).
  - Otherwise it mints `pending:<uuid>` (402) and a `ConversationSummary` with `rawMetadata: { pending: true, titleGeneration: 'awaiting_message' }` (403-415).
  - It calls `sessions.bindConversation({ kind: 'pending', ... })` (417-424).
  - It then `db.pendingConversations.put({...pending, boundSessionId, isBound: true})` (425) and returns `{ session, conversationRef: pendingRef }` (426).
- **History bind:** `conversations.ts:433-530` `POST .../:conversationRef/bind`. Body: `force`, `initialPrompt`, `confirmExternalHandoff`. A Claude handoff needs confirmation (502-513). It calls `bindConversation({ kind: 'history', initialPrompt, codexProfile })` (519-528).
- **SM bind:**
  - `bindConversation` (SM:1756-1791) de-dupes per `project:provider:ref` and runs under `runtimes.run(sessionId,'bind')`.
  - `bindConversationInternal` (SM:2015-2149):
    1. If a restorable owner already exists: `refreshSessionState` (2030-2037).
    2. Builds the tmux name (2039), creates `runtimeDir/<sessionId>/{raw.log,events.jsonl}` (2040-2045) and the launch argv via `provider.getLaunchCommand` (2047-2054).
    3. Upserts the row with `status:'starting'`, `shouldRestore:true` (2057-2085), and sets `env.AGENT_CONSOLE_SESSION_ID` (2087).
    4. Runs `tmux newDetachedSession`, `pipePaneToFile(rawLogPath)`, `configureTmuxSessionOptions` and `getPanePid` (2091-2099), then `verifyStartupSurvived` (2101 → 4458: waits for raw-log output to settle, then checks liveness and the native process epoch).
    5. Upserts `status:'bound'` with `pid` (2103-2109).
    6. For a pending chat with an initial prompt: `recordPendingUserInput` plus a `user-input`/`agent-input` event (2111-2123).
    7. Writes a `status` event, emits `session.updated`, starts watchers and emits a screen update (2124-2127).
  - On failure: kills the created tmux session and writes the row as `status:'error'`, `shouldRestore:false` (2129-2147).
- **Restore/relaunch:** `restoreSession` (SM:1632-1754).
  - Sets a grace window (1643) and resolves the pending native ref (1663).
  - `buildRecoveryLaunchCommand` (1536-1558) needs `resumeConversationRef`. With none, a pending chat that has no recorded input expires (1669-1689).
  - Then `starting`, `newDetachedSession`, pipe, options, PID, `verifyStartupSurvived`, then `bound`, and clears the manual/pressure/idle markers (1695-1743).
- **Launch adapter:** `providers/types.ts:5-14` `ProviderLaunchOptions { initialPrompt, codexProfile, claudeProfile, model, effort, flags, consoleIdentity?: { sessionId, runtimeDir, helperPath }, authorityContext }`. `getLaunchCommand(project, conversationRef|null, settings, options): { cwd, argv, env }` (types.ts:87-92).
  - **Codex** (`codex-provider.ts:318-374`): new or resume template, forced `--dangerously-bypass-approvals-and-sandbox`, profile `--model` plus `-c model_reasoning_effort=`, `-c check_for_update_on_startup=false`, initial prompt as the last argv. `authorityContext` is ignored for Codex.
  - **Claude** (`claude-provider.ts:164-213`): `--dangerously-skip-permissions`, `--model/--effort`, `--append-system-prompt <authorityContext>`, `--mcp-config <json>`, then `-- <initialPrompt>`.
- **`consoleIdentity`** (SM:1560-1563): only when `coordinationEnabled`. Fields are `{ sessionId, runtimeDir, helperPath: scripts/agent-coord.mjs }`.
  - Providers inject a per-session MCP server `agent_console_coordination` = `node agent-coord.mjs mcp`, with env `AGENT_COORD_RUNTIME=<runtimeDir>` and `AGENT_CONSOLE_SESSION_ID=<sessionId>`. Codex gets it via `-c mcp_servers...` (codex-provider.ts:360-365); Claude via `--mcp-config` (claude-provider.ts:203-206).
  - SM also puts `AGENT_CONSOLE_SESSION_ID` in the process env (SM:1691, 2087, 3259, 3299), so lifecycle hooks spawned by the provider inherit it.
  - Purpose: before the native id is known, registration can link the native session to this exact Console binding (`console-session:<assignmentId>` meta; see §6), and grant calls can name their Console session.
- **tmux naming and options:**
  - `buildTmuxSessionName` (SM:3632-3635) = `ac-<provider>-<projectSlug>` sanitized and capped at 40 chars, plus `-<sha1(project:provider:ref)[0:10]>`.
  - Options (SM:3637-3644): `@agent_console_session_id`, `@agent_console_conversation_ref`, `@agent_console_provider`. A model switch adds `@agent_console_{codex|claude}_profile` and `@agent_console_model_profile_request_id` (SM:76-80, 3268, 3271).
  - Socket `-L agent-console` (env `AGENT_CONSOLE_TMUX_SOCKET`), pane 80x50, launched under `systemd-run --user --scope` (`tmux-client.ts:9-17, 100-113, 136-144`).
- **`bound_sessions` columns** (`db/schema.ts:64-85` plus migrations): `id, provider, codex_profile(v9), claude_profile(v11), project_slug, conversation_ref, resume_conversation_ref, tmux_session_name NOT NULL, status, should_restore, title, started_at, updated_at, last_activity_at, last_output_at, last_completed_at, last_response_at(v12), auto_tracked_at(v5), is_working, pid, raw_log_path, event_log_path, run_failure_json(v8), model_profile_request_json(v10), manual_suspended_at(v13), pressure_suspended_at(v14), launch_context_json(v17), idle_suspended_at(v18)`. `CURRENT_SCHEMA_VERSION = 18` (schema.ts:4).
  - Repo: `db/repos/bound-sessions.ts`. `upsert` (26-116) also **ends any other tree-visible row for the same (project, provider, conversation_ref)** (91-113).
  - Independently owned setters that ordinary upserts cannot overwrite: `setRunFailure`, `setManual/Idle/PressureSuspendedAt` (which also null `pid` and `is_working`), `replace/compareAndSet/completeModelProfileRequest`, and `setLaunchContext` (118-238).
  - `getRestorableByConversation` (272-280) is the canonical "who owns this conversation" read.
- **`should_restore`:** 1 = this row is the restorable owner. `treeVisible` = `should_restore=1 AND status IN ('starting','bound','releasing')` (`lib/bound-session-state.ts`). `listRestorableSessions` = `shouldRestore && status !== 'ended'` (SM:459-461), so it includes `error` rows. Statuses are `['starting','bound','releasing','ended','error']` (`packages/shared/src/index.ts:78`).
- **Pending records:** table `pending_conversations` (schema.ts:98-109). Repo `pending-conversations.ts`: `put`, `get`, `list`, `getByAdoptedRef` (61-73, used by title generation), `setTitleGeneration`.
  - `rawMetadata` carries `lastUserInputHash/Preview/At` (`pending-adoption.ts:14-41`) and, after adoption, `adoptedConversationRef/adoptedTranscriptPath/adoptedAt` (176-188).
- **Pending adoption (why it exists):** the TUI picks its native id internally. Console only learns it in one of two ways:
  - (a) **Transcript match.** `findPendingAdoptionMatch` (pending-adoption.ts:96-123) compares the hash of the recorded first/last prompt against transcript `firstUserTextHash`/`lastUserTextHash`, within ±30 min (line 8), requiring a unique candidate and excluding forks and subagents. `adoptPendingConversation` (125-192) then, in one transaction: upserts `conversation_index` with the native ref and transcript path, moves the title override, rebinds `bound_sessions.conversation_ref = resume_conversation_ref = nativeRef`, and marks the pending record adopted.
  - (b) **Native registration.** `adoptRegisteredSession` (SM:1794-1827), driven by coordination registration with `consoleSessionId` (§6).
  - Callers: the read path `resolvePendingAdoptionForRead` (conversations.ts:158-211), `tryResolvePendingResumeSession` (SM:1565-1601), and reconciliation of idle pending Codex chats (SM:1139-1156).
  - The pending state shapes many guards: no restore without a native ref (SM:1669-1688); `/input` and `/keys` restart a first-turn pending Codex chat with the prompt as argv (`routes/sessions.ts:95-132, 228-242, 412-440`; SM:2840-2885); model switches defer `awaiting_native_conversation` (SM:3120-3124); idle and pressure suspension skip `pending:` (SM:1251, 1332); wake skips `pending:` (SM:609).

### tmux-specific assumptions
The writer is a pane. Startup success means raw-log output settles and `has-session` is still true. The PID is the pane PID. Ownership is a tmux option. The native id comes later from the transcript or a hook.

### Structured binding write (thread id known at `thread/start`)
- `thread/start` returns `{ thread: { id (UUIDv7), path ("[UNSTABLE]", nullable), status, ... }, model, reasoningEffort, ... }`. Params include `cwd, model, approvalPolicy ('never' | ...), sandbox, config (free-form overrides), developerInstructions, ephemeral` (must stay false so a rollout persists).
- Use **immediate adoption** instead of transcript matching. In one transaction:
  1. Keep the `pending:<uuid>` row as the URL alias and title-generation carrier: `titles/service.ts:55-58` finds it via `getByAdoptedRef`.
  2. Call the existing `adoptPendingConversation` with a synthesized summary `{ ref: thread.id, kind: 'history', provider: 'codex', projectSlug, title: placeholder, transcriptPath: thread.path ?? undefined }`. That writes `conversation_index`, sets `bound_sessions.conversation_ref = resume_conversation_ref = thread.id`, and stamps `adoptedConversationRef`.
- Write the `bound_sessions` row directly as `status:'bound'` (no `starting` wait on pane output) with `transport:'structured'`, `raw_log_path NULL`, and `event_log_path` set.
- What `tmux_session_name` holds is a decision. The column is NOT NULL, so either store a sentinel like `acs-<id>` that is never created, or relax it in the migration. Either way, no tmux call may run for this row.
- `/new/bind` may then return either the alias or `thread.id`; the web just navigates to whatever comes back (`App.tsx:500-511`).
- The first-turn pending-Codex restart (`routes/sessions.ts:95-132`) is bypassed automatically, because `session.conversationRef` is no longer `pending:`.
- **Caveat:** `conversationIndex.replace(project, provider, items)` (`db/repos/conversation-index.ts:71-72`) wipes and rewrites a project's provider rows on every refresh. An index row inserted before the rollout exists can disappear until discovery sees the file. The tree still shows the bound chat via `buildSyntheticConversationFromSession` (`lib/conversation-summary.ts:22-38`), but `watchSessionTranscript` (SM:3878-3902) stops until `conversation.index-updated` brings the path back. **(verify)** whether `thread.path` is non-null at `thread/start` or only after the first turn.

### Seam recommendation
Sibling module, called from SM by transport: `structured.start(input)` from `bindConversationInternal` (before line 2039), and `structured.ensureLoaded(session)` from `restoreSession` and `refreshSessionState`. Keep the pending-alias plus `adoptPendingConversation` write in SM so the binding invariants (`upsert` supersession, title move) stay in one place.

---

## 2. Input

### What exists
- **Routes** (`routes/sessions.ts`):
  - `POST /api/sessions/:id/input` (208-252) takes `{text}`. It may restart a pending first Codex turn, then calls `sessions.sendInput`.
  - `POST /api/sessions/:id/keys` (376-449) body schema (31-46): `submissionId? (uuid)`, `text?`, `keys?: Enter|Escape|Up|Down|Left|Right|BSpace|Tab|C-c`, `deferScreenUpdate`, `submittedText`, `clientOptimisticMessageId`, `imageIds`.
    - A submission requires `submittedText` plus exactly `['Enter']`.
    - The input revision is captured before preflight (397). Images resolve to a path suffix plus a `view_image`/`Read` instruction (398-411).
    - Literal selection tokens and `/commands` drop `submissionId` (416-420, using `sessions.allowsLiteralSelectionKeystroke`, SM:3568-3583, which captures the tmux pane).
  - `DELETE /api/sessions/:id/queued-inputs/:requestId` (451-464) calls `cancelQueuedInput` (SM:2258-2274).
- **Return contract:** `SessionInputResponse { session, recordedUserInput?: {id,text,images?,timestamp}, queuedInput?: SessionQueuedInput }` (shared index.ts:274-293). `SessionQueuedInput.state` is `'queued'|'waiting_for_input'|'submitting'|'needs_review'`. Errors use `SessionInputRejectedError` (HTTP 409).
  - Web (`App.tsx:741-765`): every complete chat Enter carries a `submissionId` (UUID, reused on retry). If the response has `queuedInput`, the optimistic bubble is dropped and `QueuedInputNotice` is shown. If it has `recordedUserInput`, the optimistic bubble is replaced.
- **Journal:** `sessions/input-queue.ts`. `QueuedInputRecord` (5-17) has states `queued → awaiting_input → submitting → submitted | failed | cancelled`, plus `baselineInput, typedAt, panePid, nativeRevision, recordedUserInput`.
  - It lives entirely in `meta`: `session-input:<sid>:<requestId>`, `session-input-pending:<sid>`, `session-input-revision:<sid>`, `session-draft:<sid>` (Text Bypass staging), `session-input-remnant:<sid>`.
  - `put` refuses to revive a cancelled record (103-104). The summary maps `failed` to `needs_review` (118-127). Rows are projected onto `BoundSession.queuedInputs` by `BoundSessionsRepo.mapRow` (bound-sessions.ts:20-24).
- **Command lock:** `SessionRuntimeRegistry.run(sessionId, label, fn)` (`session-runtime.ts:66-91`) serializes per-session work on a promise tail and warns after 20 s. `clearEphemeral` (93-104) resets the screen hash, the model cache, `submittedTurnAt` and `nativeProcess`.
- **Delivery flow:**
  - `sendKeystrokes` (SM:2205-2229) runs these outside the lock: interrupt/human input invalidates the native revision, pauses automatic input (`human_stop`/`human_keys`), cancels recovery, and on Escape cancels queued inputs.
  - With `submissionId` it goes to `queueInputInternal` (2310-2335): creates the record, then `drainQueuedInputInternal` (2357-2567); otherwise to `sendKeystrokesInternal` (2582-2807).
  - The drain:
    - wakes an idle sleeper (2376-2380) and verifies ownership via tmux liveness, `@agent_console_session_id` and pane PID (`stillOwned`, 2387-2412);
    - requires `screenAcceptsHumanPrompt` (2417; `screen-heuristics.ts:199-212`: an active composer, **even while working**) and handles a Claude notice/remnant retirement (2422-2473);
    - journals `awaiting_input` before paste (2485-2487), pastes (2490-2492), waits for the composer to match (2499-2502), and times out to `needs_review` after 30 s (2503-2509);
    - journals `submitting` (2516-2518), re-captures and checks synchronously (2528-2537), sets `submittedTurnAt` (2540), sends Enter (2541), and confirms an empty composer (2544-2552);
    - then updates `lastActivityAt`, records pending input, `appendEvent(user-input)` and marks the record `submitted` (2553-2561).
  - A scheduler retries every 1 s (2337-2355). On boot, records left in `submitting` become `failed` (SM:450-456).
- **Steer vs queue:** a human message during a running turn is pasted into the native composer and submitted with Enter. Codex steers the running turn; Claude absorbs it after running tool calls (architecture.md "Session text entry"). Console never waits for the turn to end. Automatic input (wake, recovery) still requires idle.
- **Stop/Escape:** `sendKeystrokesInternal` clears `submittedTurnAt` on Escape (2588). Escape alone also runs `clearStoppedNativeDraft` (2760-2763 → 2810-2838: verify ownership and composer, send `C-c` once, confirm cleared). The web sends `{keys:['Escape']}` from the Esc button, the Escape key and RunFailureNotice Stop (`ConversationPane.tsx:187, 856-871, 1830-1831`).

### tmux-specific assumptions
Readiness, confirmation and "accepted" are all screen-derived. The PID is the pane PID. Ambiguity comes from paste/Enter, which is why `needs_review` exists.

### Structured mapping (Codex 0.164 schema)
- Human submit: `turn/start { threadId, input: [{type:'text', text}, {type:'localImage', path}...], clientUserMessageId: submissionId }` when idle.
- During an active turn: `turn/steer { threadId, expectedTurnId, input, clientUserMessageId }`. It fails if `expectedTurnId` is not the active turn.
- **(verify)** `TurnStartParams.turnTrigger` says it is "ignored when this request steers an already-active turn". So `turn/start` on an active thread may steer.
- Stop: `turn/interrupt { threadId, turnId }`.
- Reuse the InputQueue journal unchanged as the durable receipt: `queued → submitting` (request sent) `→ submitted` (response with `turnId`) / `failed`.
- `awaiting_input`, `baselineInput`, `panePid`, remnants and `session-draft` do not apply. A lost connection after send is the only `needs_review` case, and `clientUserMessageId` plus `thread/read` can resolve it **(verify idempotency semantics)**.

### Seam recommendation
Branch at the top of `drainQueuedInputInternal`, `sendInputInternal` and `sendKeystrokesInternal` to `structured.submitHuman(session, record)` / `structured.interrupt(session)`, while keeping lock acquisition, revision, pause and recovery cancellation, `appendEvent(user-input)` and the record transitions in SM. Reject non-Enter/non-Escape keys and Text-Bypass-only text for structured sessions with a clear 409. `allowsLiteralSelectionKeystroke` must return false without touching tmux.

---

## 3. Working/idle state and recency

### What exists
- **Shared:** `BoundSession` (shared index.ts:226-260) has `isWorking, lastActivityAt, lastOutputAt, lastCompletedAt, lastResponseAt (provider-confirmed), autoTrackedAt (provenance only), manual/pressure/idleSuspendedAt, queuedInputs, runFailure, modelProfileRequest, pid, rawLogPath, eventLogPath, tmuxSessionName`. `isBoundSessionSuspended` is at 262.
- **Pure working-state functions** (`sessions/working-state.ts`): `nextScreenWorkingState(session, {screenShowsWorking, turnIsWorking?, capturedAt, idleMs})` (34-81) and `nextIdleExpiryDecision` (88-130). `turnIsWorking` (provider lifecycle) wins over the output cooldown. Completion sets `lastCompletedAt = lastOutputAt` after the 60 s idle window (`SESSION_COMPLETION_IDLE_MS`, SM:67). **These are transport-neutral and reusable.**
- **SM wiring:**
  - `syncSessionWorkingState` (SM:4405-4428).
  - `providerTurnIsWorking` (988-1005) comes from the RunRecovery monitor state. A completion older than `submittedTurnAt` cannot acknowledge a new turn, and runs older than the verified native process epoch are ignored (`verifyNativeProcessEpoch` 969-981 reads tmux owner, pane PID and session creation time; `runPredatesNativeProcess` 983-986).
  - `recordProviderResponse` (1007-1025) sets `lastResponseAt` on confirmed completion. Claude also needs a ready-prompt screen (`confirmClaudeResponse*` 1027-1040).
- **Output-driven recency (tmux):**
  - `OutputWatcherRegistry` tails `raw.log` (`output-watcher.ts`) → `flushPendingChunk/flushChunkInOrder` (SM:4013-4085). Meaningful normalized output sets `lastActivityAt = lastOutputAt = now` and `isWorking`, schedules the idle expiry, and appends `raw-output` (4067-4080).
  - It only counts while working or after new user activity (`shouldTrackRawOutputForRecency` 4087-4104).
- **What moves recency (AGENTS.md):** only new user/agent activity, and completed output after the idle window. Restores, old transcripts, repaint and idle status do not.
  - Concretely: `lastActivityAt` is set on submitted input (2175-2178, 2554, 2650-2653, 2766-2769), wake/recovery submission (402, 844) and meaningful output (4067-4073).
  - The tree/search activity date is `getBoundSessionConversationUpdatedAt` = max(lastCompleted, lastOutput, lastActivity, transcript) (`lib/conversation-summary.ts:3-20`). `updatedAt` is a revision clock, not recency: the repo's `nextUpdatedAt` (bound-sessions.ts:8-15) bumps it monotonically for the independently owned setters.
- **Realtime** (`realtime/event-bus.ts` EventEmitter; SSE at `routes/events.ts:7-33`, 20 s heartbeat). `SessionEvent` (shared index.ts:409-470). Web handlers (`apps/web/src/features/realtime/apply-session-event.ts`):
  - `session.updated {session}` (155-177): replaces the tree and timeline `boundSession` and invalidates the selected messages query.
  - `session.screen-updated` (72-84): invalidates the `['session-screen', id]` query and conversation meta.
  - `session.raw-output` (85-107): the web **optimistically sets `lastActivityAt/lastOutputAt/updatedAt` to the event time** (`reducers.ts:114-135, 182-199`) and schedules a message refresh.
  - `session.transcript-updated` (108-126): same optimistic activity bump plus a message refresh.
  - `session.user-input` (128-153): same bump plus appending a live user bubble.
  - `session.released` (179-185): invalidates the tree and timeline.
  - `conversation.index-updated`: invalidates the tree and timeline if selected.
  - Server side, SM itself subscribes (`handleRealtimeLifecycleEvent` SM:1050-1087): `session.updated` → `watchSessionOutput` or `stopWatching`; `conversation.index-updated` → re-watch.
- **Sidebar dot:** `apps/web/src/features/navigation/work-status.ts:3-21` uses `isWorking`, `runFailure` and `lastResponseAt` age only.

### tmux-specific assumptions
"Working" falls back to screen spinners plus the output cooldown when there is no lifecycle record. `lastOutputAt` comes from raw pane bytes. The epoch comes from tmux session creation time.

### Structured mapping
- `turn/started` → `isWorking=true`.
- `item/completed` for agent message, tool or command items → `lastOutputAt = lastActivityAt = event time` (only for live notifications, **never** for `thread/resume` replays or reconnect backfill).
- `turn/completed {turn.status: completed|interrupted|failed, error.codexErrorInfo}` → `lastResponseAt` (completed), `isWorking=false`; let `nextIdleExpiryDecision` set `lastCompletedAt`.
- The native epoch = the time `thread/resume`/`thread/start` completed on the current connection: set `runtimeState.nativeProcess = { pid: appServerPid, startedAt: loadedAt }`.

### Seam recommendation
Keep all recency writes and event emission in SM, fed by a structured event sink, for example `sm.onStructuredEvent(sessionId, evt)` run under `runtimes.run`. Do not emit `session.raw-output` for structured sessions: its meaning is a raw terminal chunk, and the web treats it as activity. Use `session.updated` and `session.transcript-updated`.

---

## 4. Live output

### What exists
- **Event log:** `<runtimeDir>/<sessionId>/events.jsonl`, created at bind (SM:2040-2045) or by `ensureSessionLogPaths` (SM:1517-1534, which **also always creates `raw.log`**).
  - Record: `{"type": "user-input"|"agent-input"|"raw-output"|"status", "text": string, "timestamp": ISO}` (SM:126).
  - The single writer is `appendEvent` (SM:3770-3804). The message id is `live:<sessionId>:<byteOffset>`.
  - Side effects of `user-input`: clears the peer-wake pause for the assignment, clears `peer-wake-composer:<sid>`, sets meta `human-input:<sid>` (read by grants as the "latest human message"), updates the echo cache, and emits `session.user-input`. `raw-output` emits `session.raw-output`.
- **Reader:** `live-output/event-log-reader.ts` handles parsing, tail reads and append-only reuse with an EOF anchor. Its `SessionEventLine` type (3-7) lists only `user-input|raw-output|status`; `agent-input` falls through to the raw-output normalizer path.
- `live-output/reader.ts` `LiveOutputReader.readLiveMessages(session, {maxBytesFromEnd})` (92-120) → `reconstruct` (122-254):
  - `user-input` → `{role:'user', lifecycle:'durable', source:'user-input'}`, unless it looks like a provider control (`/cmd` or a numeric picker reply, 46-60, 143-168).
  - **Codex `raw-output` is always skipped** (171-175). Claude `raw-output` after a user turn is normalized (`filters.ts`) into `role: classifyChunk(...)`, `lifecycle:'pending'`, `source:'live-output'`.
  - `status` → `{role:'status', lifecycle:'status', source:'synthetic-status'}`, truncated to 240 characters (184-185, 222-245).
  - Cache limits: 64 MiB and 64 entries.
- **Conversation route merge:** `conversations.ts:223-358` loads the provider conversation (cache `lib/provider-conversation-cache.ts`; stale-while-changing for transcripts ≥8 MiB, shared `LARGE_TRANSCRIPT_STALE_THRESHOLD_BYTES` index.ts:180). Live messages use a 2 MiB tail (322-327), then `mergeTimelineMessages` (`timeline-merge.ts:255-281`):
  - With no live messages: dedupe only.
  - **Once the provider transcript has any user/assistant/tool message, only live `user-input` rows newer than the newest transcript message survive** (270-277, `filterPendingLiveUserMessagesAfterTranscript` 243-253), after removing ones that match the transcript (role, ±10 min bucket, exact match within 30 s or containment ≥80 characters; 119-182).
  - Before any transcript exists, all user-visible live rows render.
- **Transcript watcher:** `transcript-watcher.ts` (fs.watch plus poll) → `emitTranscriptUpdated` (SM:3904-3919) → `runRecovery.changed` plus `session.transcript-updated`. It is attached by `watchSessionTranscript` (SM:3878-3902) only for non-pending refs whose `conversation_index.transcript_path` is set.

### Records a structured transport must write so the existing reader and merge render it
1. **`user-input`** at acceptance, through `appendEvent`, so its pause-clearing, human-input meta, `session.user-input` and echo cache all still happen. This alone gives the pending first-turn display and duplicate suppression once the rollout catches up.
2. **`status`** for lifecycle notes (bound, resumed, interrupted, recovery and wake transitions). These render only before a transcript exists, and remain evidence afterwards.
3. **`agent-input`** for automatic opening prompts (grant launches; SM:2121) if kept. Note that the reader does not type it.
4. **Assistant text: there is no suitable record type today.** `raw-output` is dropped for Codex and terminal-normalized for Claude, and the merge drops all non-user live rows once a transcript exists.
   - For Codex slice 1, rely on the rollout file: commentary-phase progress already shows via the Codex transcript parser, and `session.transcript-updated` gives refresh.
   - Streaming `item/agentMessage/delta` would need a new record type (for example `{"type":"assistant-output","itemId","text"}`), a reader mapping to `role:'assistant', lifecycle:'pending'`, and a merge rule keeping such rows until the transcript contains that item. This is a design decision, not needed for a minimal seam.
   - ACP agents without a durable transcript would need this path to be durable, not pending.

### Seam recommendation
No change to the reader or merge for the minimal seam. Expose `appendEvent` to the structured module through a narrow journal callback, or keep it in SM and have the module emit typed events that SM records.

---

## 5. Run monitoring and recovery

### What exists
- **Contract** (`providers/types.ts:59-74`):
  - `ProviderRunState { turnId, timestamp, startedAt?, progressAt?, status: 'running'|'completed'|'failed'|'cancelled', error?: {code,message} }`
  - `ProviderRunMonitor { read(transcriptPath): Promise<ProviderRunState|undefined>; takeChildActivity?() }`
  - `ProviderAdapter.createRunMonitor?()`
- **Codex** `CodexRunMonitor` (`transcripts/codex-run-state.ts:23-95`): incremental and bounded. It decodes `event_msg` `task_started|task_complete|turn_aborted` (`codexRunState` 4-20; `error.codex_error_info` → code), sets `progressAt` on assistant/function-call `response_item`s, and records `SubAgentActivity` child completions.
- **Claude** `ClaudeRunMonitor` (`transcripts/claude-run-state.ts`): submitted prompts, `end_turn`, `isApiErrorMessage` mapped to `server_overloaded|server_unavailable` for HTTP 500/502/503/504/529 (5-19).
- **Controller** `RunRecovery` (`sessions/run-recovery.ts`): "Owns only recovery state; lifecycle/transport ownership remains with SessionManager".
  - Options (11-23): `runExclusive, canRetry, mayRecover, submit, publish, onRunState, onChildActivity, delaysMs, now`.
  - `watch(sessionId, path, createMonitor)` (47-62), `changed(id)` (64-67), `getRunState` (69-71), `processExited` (74-89, synthetic `process_exited` failure), `confirmCompletion` (98-105), `cancel` (107-123, persists `run-recovery-cancelled:<id>`), `refresh` (150-224).
  - Retryable codes: `server_overloaded`, `server_unavailable`, `process_exited` (208). Delays are 15/45/120 s (5), max age 10 min (6); the attempt is persisted before submit and the provider must acknowledge within 30 s (241-296).
  - State: visible `bound_sessions.run_failure_json` (`RunFailure` shared index.ts:213-224) plus the budget in meta `run-recovery-budget:<id>` (8-9).
  - SM wiring (SM:326-448): `canRetry` checks tmux liveness, PID owner, tmux owner option and screen readiness (330-362); `submit` uses Codex `queueCodexNotice` or a Claude paste plus Enter (363-405); `onRunState` handles native cancellation pause, supervisor signal, response recording, model drain and wake (414-438). `watch` is called from `watchSessionTranscript` (SM:3895). The fixed recovery text is `RECOVERY_PROMPT` (run-recovery.ts:7).

### Structured feed
**Option A, recommended for Codex slice 1:** keep `CodexRunMonitor` on the rollout path, which app-server persists. Nothing changes except `canRetry`/`submit`.

**Option B:** a protocol-fed monitor.
- `runRecovery.watch(sessionId, 'structured:<threadId>', () => ({ read: async () => latestStateFromProtocol }))`, then call `runRecovery.changed(id)` on each `turn/started|turn/completed`. `run-recovery.test.ts` already uses exactly this fake-monitor shape.
- Map `turn/completed.turn.status` `completed|interrupted|failed` → `completed|cancelled|failed`.
- Map the camelCase `codexErrorInfo` (`serverOverloaded`, `internalServerError`, `httpConnectionFailed{...}`, ...) to the snake_case codes RunRecovery recognizes. **The names differ:** the protocol says `serverOverloaded`, RunRecovery expects `server_overloaded`.
- `progressAt` comes from `item/completed`.
- Caveat: `watchSessionTranscript` only calls `runRecovery.watch` when an index transcript path exists (SM:3884-3895). A protocol monitor must be attached elsewhere.

### Seam recommendation
Keep RunRecovery as is. Branch its `canRetry` and `submit` callbacks by transport. For structured: canRetry = thread loaded on the live connection, not active, no pending approval, enabled, memory OK; submit = `turn/start` with the recovery prompt.

---

## 6. Coordination delivery

### What exists
- **Wake loop:** `SessionManager.wakePendingAssignments`/`drainAssignments` (SM:524-865), triggered by `requestAssignmentWake` (518-521), the 15 s coordination timer (`app.ts:191-194`) and run-state changes.
  - Recipients are unfinished assignments, or any with unacknowledged messages (540-544). Each is matched to exactly one restorable session by `provider` plus `conversation_ref|resume_conversation_ref == native_session_id` (549-551).
  - Under `runtimes.run(session.id,'assignmentWake')`:
    - eligibility: P1 or dispatch-eligible messages; attempt and follow-up records in meta (554-588);
    - guards on working/model/queue/manual/pending/runFailure (607-610);
    - **tmux liveness** (648); if dead, the **recipient PID must be dead** (652), then `processExited` or `restoreSession` (654-678);
    - **tmux owner option** (679), **screen capture and readiness** (681-714);
    - durable attempt `submitting` (761-766);
    - transport: **Codex `queueCodexNotice`** (`coordination/wake.ts:61-69` = `codex queue --thread <id> --message <prompt>`, SM:788-791) or a **Claude paste/stage/Enter** with the `PeerWakeComposer` journal (792-834);
    - then `submitted`, `isWorking`, `lastActivityAt` and a `status` event (835-846). On failure: `deferred` versus `failed` (847-862).
- The prompts are fixed notices (`scripts/coordination-notices.mjs`: `PEER_WAKE_PROMPT`, `UNATTENDED_CONTINUATION_PROMPT`, `GRANTED_RESTART_PROMPT`). **Message bodies are not typed.** Provider hooks (`UserPromptSubmit`/`PostToolUse`) poll and inject them as `additionalContext` (`scripts/agent-coord.mjs:202-257`).
- Meta keys (`coordination/wake.ts:10-48`): `peer-wake-attempt:<msg>`, `peer-wake-followup:<msg>`, `peer-wake-restore:<sid>`, `peer-wake-composer:<sid>`, `peer-wake-paused:<assignment>`, `peer-wake-pause-details:<assignment>`, `peer-resume-attempt:<sid>:<pid>:<startedAt>`. `AutomaticInputPause.code` covers human_input/keys/stop, native_cancellation, manual_suspend, release and owned_close (15-20).
- Continuation (`coordination/continuation.ts`), inbox policy (`inbox-policy.ts`) and tasks are DB-only.
- **Receipts:** `CoordinationService.sendReceipt` (`coordination/service.ts:256-300`). `alive = processStart(owner.pid) === owner.process_start` (260-262); the session lookup reads `bound_sessions` by native ref (265-273); status is `stopped|working|idle`.
- **Registration and identity:**
  - **Server:** `register({provider, nativeSessionId, token, pid, cwd, consoleSessionId?})` (service.ts:108-140) requires a live `/proc/<pid>/stat` start time. It keys one row per `(provider, native_session_id)`, refuses a different live PID ("already has a live coordination owner", 122), and calls `grants.bindAssignment(id, consoleSessionId, cwd)`.
  - `grants/service.ts:25-39` sets meta `console-session:<assignmentId>` = Console session id, sets `assignment-project:<id>`, and for **launched helpers sets continuation `unattended`** plus `onRegistration` → `adoptRegisteredSession`.
  - `reconcileProcesses` (152-164) marks assignments `disconnected` when their PID dies.
  - **Client** (`scripts/agent-coord.mjs`):
    - Hooks run `agent-coord.mjs hook <provider>`, installed in `~/.codex/hooks.json` and Claude settings by `scripts/install-coordination.mjs:15-79`. Stdin carries `session_id`.
    - `owner()` (42-51) walks `/proc` ancestry from `ppid` to a process named `codex|claude|grok`, or to a registered owner locator `owners/<pid>-<start>.json`.
    - `registerSession` (95-111) writes `clients/<sha256(provider:nativeId)>.json` with the token and passes `consoleSessionId: process.env.AGENT_CONSOLE_SESSION_ID` (103). It then writes the **per-process** owner locator (109).
    - MCP `tools/call` uses `request.params._meta.threadId` (Codex) → `credential(threadId)` (174-196). That locates the client state by thread id, then requires `state.ownerPid === ancestry owner pid` if an owner was found.
    - Shell CLI calls use `CODEX_THREAD_ID` env when the owner is `codex`, else the owner locator. Grant calls add `consoleSessionId` from env (396).
    - There is no use of `@agent_console_*` tmux options in the script. Those options are only read by SM.
- **Binding link:** `assignmentForSession` (SM:467-479). For a pending ref it uses `meta console-session:<assignmentId> = session.id` (unique); otherwise `coordination_assignments.native_session_id = resumeConversationRef ?? conversationRef`. The same pattern appears in `conversationReference` (service.ts:80-106), `grants.sessionFor` (grants/service.ts:41-47), `session-launches.describe` (69-70) and the worker evidence (`workers/evidence.ts:61-63`).

### Does identification by native thread id alone already work?
- **Mostly yes, server side.** `coordination_assignments` and every binding lookup key on `(provider, native id)`. A structured binding has `conversation_ref = thread.id` from the start, so no `console-session:` link is needed.
- **Client side, MCP tool calls work by `_meta.threadId`, and shell CLI calls by `CODEX_THREAD_ID`,** provided each thread was registered with the shared app-server PID. Hooks do run under app-server: the schema has `hook/started|completed` with event names `sessionStart`, `userPromptSubmit`, `postToolUse`, `stop`, and a `hooks/list` method. **(verify)** that `~/.codex/hooks.json` trust applies under app-server.

### What breaks with one shared process (no per-conversation PID or env)
1. `owner()` finds the app-server for every thread, and `owners/<pid>-<start>.json` is overwritten by each thread's registration. Any caller without a thread id (CLI without `CODEX_THREAD_ID`) gets the **last-registered thread's credential**.
2. `AGENT_CONSOLE_SESSION_ID` in the **process** env cannot be per thread, so registration loses `consoleSessionId` and `bindAssignment` does nothing. That drops `assignment-project`, the **automatic `unattended` continuation for granted helpers** (grants/service.ts:33-36) and grant-call session naming.
   - Fixes: (a) per-thread `config` overrides on `thread/start`/`thread/resume` (`ThreadStartParams.config`, free-form; **(verify)** that MCP servers are per thread and honor per-thread env); or (b) server-side, in `register`, resolve `consoleSessionId` from a structured `bound_sessions` row matching the native id.
3. **PID-as-liveness**, which is wrong for every thread in a shared process:
   - `drainAssignments` treats a "dead" tmux plus a live recipient PID as "provider alive elsewhere, never add a second writer" and returns (SM:648-653). **Structured sessions would never receive wakes.**
   - The same pattern appears in RunRecovery `canRetry` (SM:343-348), `restartGrantedSession` (1845-1848) and `retainFinishedInbox` (488-490, never retains while the app-server lives).
   - `sendReceipt` status (service.ts:260-275) and `reconcileProcesses` (152-164): a thread is never `disconnected` while the app-server lives, and all are disconnected together when it restarts.
   - `scripts/worktree-sweep.mjs:150-162`: every thread's checkouts look "process running".
4. A Codex wake via `codex queue --thread` (wake.ts:61-69) targets the thread's live owner. For structured, replace it with `turn/start` on Console's own connection.
5. Message bodies still arrive only via hooks. If app-server hooks are untrusted or not firing, Console would have to put the batch in the `turn/start` input.

### Seam recommendation
Replace the transport block inside `drainAssignments` (SM:648-846: liveness → owner → screen guards → submit) with a dispatch to `structured.deliverAutomatic(session, prompt, guard)` that returns `submitted | deferred | failed`. Keep all durable attempt, continuation and event bookkeeping in SM. Introduce a per-session "provider alive" predicate (`transport === 'tmux'` → existing tmux+PID checks; `'structured'` → thread loaded on a live connection) and use it in the six PID checks listed above.

---

## 7. Grants and launches

### What exists
- **`AgentSessionLaunches`** (`grants/session-launches.ts`): a durable queue in `agent_session_requests` (schema.ts:296-300) with statuses `queued|starting|completed|failed|cancelled`. The drain runs on a 5 s timer, on grant updates and on `session.released` (33-39, 156-170).
- **Memory gate:** launch/restart requires `MemAvailable ≥ memoryFloorBytes + SESSION_MEMORY_BYTES`, i.e. `sessions.pressureSuspendAvailableMiB` (default 3072 MiB, `app.ts:98-99`) + 250 MiB (11, 239-247). A missing reading waits.
- **Concurrency:** counts `boundSessions` with `shouldRestore && pid && launchContext.grantIds ∋ grant` (241-242).
- **Model limit:** parsed from `getLaunchCommand(...).argv` `--model`/`-m` (129-141, 226-237). The argv is used only to read the model.
- **Launch:** creates `pending:<requestId>` and `pendingConversations.put`, then `sessions.bindConversation({ kind:'pending', initialPrompt: <AGENT_LAUNCH_PREFIX...>, initialPromptIsHuman:false, launchContext, sessionId: row.session_id })` (257-269).
- **Restart:** `sessions.restartGrantedSession(sessionId, prompt, authorized)` (253-255 → SM:1830-1867). It checks the tmux liveness/owner/screen and kills the pane, then `restoreSession(..., explicitResume=true, prompt)`.
- **Owned close:** `sessions.closeGrantedSession(sessionId, launchedBy, authorized)` (190 → SM:1869-1903). It requires a readable indexed transcript and tmux owner, pauses automatic input, then `releaseSessionInternal`.
- **Crash-resume** of a `starting` row decides "completed" by `prior.status==='bound'`, and for a restart by **`prior.pid !== input.previousPid`** (197-212).

### tmux assumptions
`pid` presence means a live session (concurrency, worker roster). A PID change proves a restart happened. The model comes from argv.

### Seam recommendation
No change to the queue or grant logic. For structured:
- set `pid` to the app-server PID (or adjust the concurrency filter to "bound and loaded");
- make restart completion compare a per-thread epoch (`startedAt`) instead of PID;
- route `restartGrantedSession`/`closeGrantedSession` through the transport dispatch (`turn/interrupt` + `thread/resume` + `turn/start(prompt)`).

The memory gate is less meaningful when threads share one process; keep it as is for slice 1.

---

## 8. Idle sleep, suspension, restore, startup reconciliation, nine-day release, memory pressure

### What exists (all in SM)
- **Reconciliation:** `startSessionReconciliation` (1392-1422; first run at 5 s, then every 30 s; called from `app.ts:200`) → `reconcileSessions` (1128-1214). It runs over `listRestorableSessions()`, oldest-idle first under pressure.
  1. Skip manual suspensions.
  2. Pending: adopt a registered session or resolve an idle pending Codex chat (1139-1156).
  3. Finished assignment: tmux liveness → `retainFinishedInbox` (1157-1163).
  4. **Nine-day release:** `isWorkReleaseDue` (1312-1316; `WORK_SESSION_RELEASE_MS = (48+168) h`, 105). It requires a readable indexed transcript, tmux liveness and an idle screen, then `releaseSessionInternal(id, removePending=true)` (1164-1186).
  5. Skip pressure sleepers and idle sleepers without queued work (1189-1190).
  6. Model drain (1191-1197).
  7. **Idle sleep:** `isIdleSuspendable` (1331-1341; `eagerRestoreWindowMs`, default 1 h, plus a post-restore grace) → `suspendIdleSession` (1343-1390): `suspensionBlockReason('idle')`, then `killSession`, confirm dead, then `setIdleSuspendedAt`.
  8. **Pressure:** `observeLowAvailableMemory` (1237-1247; two consecutive samples below `pressureSuspendAvailableBytes`) → one `suspendPressureIdleSession` per pass (1261-1310; idle ≥ `pressureSuspendIdleMs`, rechecks memory, kills tmux, `setPressureSuspendedAt`).
  9. Otherwise `refreshSessionState(restoreMissing:true, resumeIdle:true)` (1212).
- **`suspensionBlockReason`** (3371-3419) is pure screen and tmux logic. `suspendSession`/`resumeSession` (3421-3479) are the manual pair (routes `sessions.ts:268-304`).
- **Restore entry points:** `refreshSessionState` (3654-3768). It calls `checkTmuxLiveness`. If dead: finished → retain inbox; unattended → `runRecovery.processExited`; then **`stopWatching` + `clearEphemeral` (3689-3690)**, then pending handling, then `restoreSession` if `restoreMissing`. If alive: adopt an owned writer after idle, `ensureSessionLogPaths`, re-pipe, size the pane, the native epoch, watchers and a screen.
  - Callers: `ensureSession` (3585), `getSessionScreen` (3594-3630; **the web polls this every 1 s and it restores dead, non-suspended sessions**), `observeSessions` (1089-1093; from tree refresh, `routes/projects.ts:61`), input paths, wake and recovery.
- **Startup:** there is no separate boot reconciler.
  - The constructor fails `submitting` queue records and schedules drains (SM:450-456).
  - `cleanupEndedSessionRuntimeDirs` (1106-1126) runs from app.ts:201.
  - The first `reconcileSessions` runs at 5 s.
  - Live tmux sessions survive a backend restart and are reattached (pipe/watchers) by `refreshSessionState`.
- **Release:** `releaseSession` (3345-3350) → `releaseSessionInternal` (3481-3558): `releasing`, tmux interrupt, kill, confirm dead, `ended`, clear markers, pending record, emit `session.released` + `session.updated`, delete the runtime dir.
- **Memory reading:** `/proc/meminfo` `MemAvailable` (SM:1228-1235; injectable via `options.readMemInfo`).

### tmux-specific assumptions
Sleeping frees memory by killing one process per conversation. "Dead" means `has-session=false`. Restore means a new pane plus `codex resume`. A backend restart does not stop provider work.

### Structured mapping
- Sleep becomes `thread/unsubscribe` (status `notLoaded|notSubscribed|unsubscribed`) **(verify that it actually unloads memory)** or a no-op. Restore becomes `thread/resume`. Release becomes `turn/interrupt` (if active) + `thread/unsubscribe`.
- Pressure suspension cannot free per-conversation memory in a shared process. Either skip structured rows or restart the whole app-server when every structured thread is idle.
- **A backend restart kills a Console-spawned stdio app-server and every running structured turn.** This is a real behavior regression versus tmux. Codex 0.164 offers `codex app-server --listen unix://PATH` and a managed `codex app-server daemon` (control socket `~/.codex/app-server-control/app-server-control.sock`, `proxy`). Running a Console-owned instance on its own Unix socket under `systemd-run --user --scope` (as `runScopedTmux` does) would let turns survive backend restarts. On boot, Console reconnects and calls `thread/resume` for each restorable structured row. Avoid the shared user daemon, which Bryan's own `codex agents`/TUI sessions use.

### Seam recommendation
Transport dispatch inside `refreshSessionState`, `restoreSession`, `suspendIdleSession`, `suspendPressureIdleSession`, `suspensionBlockReason`, the release-due liveness check, `releaseSessionInternal` and `getSessionScreen`. Keep the reconcile loop, markers and timing in SM.

---

## 9. Model/effort profiles

### What exists
- `CODEX_COST_PROFILES` `{high: gpt-6-astra/xhigh, medium: gpt-6.1-sol/xhigh, low: gpt-6-luna/xhigh}`, `CLAUDE_COST_PROFILES`, `CodexCostProfileKey`, `ModelProfileKey`, `visibleModelMatchesProfile` (screen footer parse) (shared index.ts:6-36).
- `ModelProfileRequest` states `queued|applying|failed` (53-68). `ModelProfileDeferredReason` (38-45) values are all screen- or tmux-derived: `turn_running, unsent_input, interactive_input, provider_message_queued, starting, awaiting_native_conversation, cannot_verify_idle`.
- Routes: `POST /api/sessions/:id/model-profile {profile}` and `DELETE .../model-profile/requests/:requestId` (`routes/sessions.ts:143-206`).
- SM:
  - `requestModelProfile` (2887-2942) persists `model_profile_request_json` and is a no-op if the screen already shows the profile.
  - `drainModelProfileRequestInternal` (3078-3224): pending Codex completes immediately and the first-prompt restart uses it (3120-3149). Otherwise it checks tmux liveness/owner, then screen guards, then `applying`.
  - `applyModelProfileRequest` (3226-3343): **closes the pipe, kills the tmux session, relaunches `codex resume <id> --model X -c model_reasoning_effort=Y`** (or Claude `--model/--effort`), verifies startup, completes the request. On error it rolls back to the previous profile.
  - `reconcileApplyingModelProfileRequest` (3038-3076) handles restart-safety.
  - **No slash command is typed.** The profile lives in `bound_sessions.codex_profile/claude_profile` plus tmux options.
- Web: Alt+H/M/L and controls in `ConversationPane.tsx`; `activeModelProfile` and `visibleModel={liveScreen?.model}` (2071-2073).

### Structured mapping
`TurnStartParams.model` and `.effort` are documented as "Override ... for this turn and subsequent turns". A switch needs no process restart: mark the request complete and send the overrides on the next `turn/start`, or immediately if idle. **(verify)** whether a no-input override call is possible. Most deferral reasons do not apply; keep `turn_running` only if the switch must not affect the active turn.

### Seam recommendation
Branch in `drainModelProfileRequestInternal` before the tmux liveness check (3151). Keep the request journal and columns.

---

## 10. Web

### What exists
- **New Chat:** `App.tsx:500-511` `bindNewMutation` → `api.bindNewConversation` (`lib/api.ts:205`) → navigate to the returned `conversationRef`. History bind: `api.bindConversation` (187-204). Nothing is transport-aware.
- **Screen polling:** `features/conversation/useConversationData.ts:273-278` polls `GET /api/sessions/:id/screen?lines=120` **every 1 s** while bound and not suspended. `liveMode = Boolean(boundSession && liveScreen)` (357-358). The raw-output debug query (360-365) is only active when the debug panel is open.
- **ConversationPane** (`components/ConversationPane.tsx`):
  - `LiveSessionInputBridge` (rendered at 2047-2078; shown whenever `boundSession` exists and is not suspended; **not gated on `liveScreen`**).
  - Key buttons Enter/Esc/arrows/Backspace/Tab (184-193) and Text Bypass (state 289; toggle 755-786; literal per-keystroke typing via `/keys` text-only).
  - `nativeSelectionActive` comes from `liveScreen.inputActive === false` plus control text (2075-2076). `liveScreenPanel` is the parsed terminal (1749-1758). `LiveSessionStatus` shows model/context from the screen footer (2105-2113).
  - `QueuedInputNotice` and `RunFailureNotice` (1829-1831) are transport-neutral, as is the debug raw-output panel (2115-2123).
- **Realtime:** see §3. The sidebar dot is `features/navigation/work-status.ts`. The web never reads `tmuxSessionName` or `pid`.

### What needs a structured variant or should be hidden (requires `BoundSession.transport` in shared)
- **Skip `/screen` polling,** or have the server return a synthesized `SessionScreen`: `inputActive: true`, empty `content`/`inputText`, `status` from the thread status, `model`/`contextPercent` from `thread/tokenUsage/updated`.
- **Hide** Text Bypass, the arrow/Backspace/Tab keys, the native-selection affordances and the terminal `liveScreenPanel`.
- **Keep** Send (queued submission), Esc/Stop (→ interrupt), model profile controls, QueuedInputNotice, RunFailureNotice and suspend/close.
- Replace the raw-output panel with a JSON-RPC event tail if wanted.
- Approvals and `item/tool/requestUserInput` would need a new UI if ever allowed. Slice 1 should launch with `approvalPolicy:'never'` plus full-access sandbox, matching the tmux `--dangerously-bypass-approvals-and-sandbox`, and fail closed on any server request.

---

## 11. Config

### What exists
- `config/schema.ts` (zod):
  - `providers.codex|claude = { enabled, discoveryRoot, commands: { newCommand[], resumeCommand[], continueCommand[]?, env{} } }` (5-16, defaults 94-115).
  - Per-project overrides `projects[slug].providers.{codex,claude}` (18-27, 37-40).
  - `sessions = { eagerRestoreHours=1, restoreGraceHours=1, pressureSuspendAvailableMiB=3072, pressureSuspendIdleMinutes=60 }` (54-64).
- **Feature flags** are nested `{ enabled: boolean }` objects with defaults: `coordination.enabled` (default false, 80-83), `workerSummaries.enabled`, `conversationTitles.enabled` (72-79). They are read once in `app.ts` (e.g. 68-75, 97, 106, 136, 188-194). There is no hot reload.
- `config/service.ts`: `appConfigSchema.parse(raw)` (22). **Zod's default object strips unknown keys** (no `.passthrough()` anywhere in config).
  - Writes: `persist()` writes the parsed `storedConfig` (287-289) on project create/update/delete, global settings (`updateGlobalSettings` re-parses, 248-273) and legacy cleanup at startup (26-28). `setWorkerTracking` writes `storedConfig` (279-285).
  - **Any key an older running server does not know is dropped from `config.json` on the next settings save.** (The extension-lane doc reaches the same conclusion.)
  - The per-session launch path uses `getMergedProviderSettings` (106-125).

### Recommendation
Add, for example, `providers.codex.transport: z.enum(['tmux','structured']).default('tmux')` with optional per-project override, or `structuredSessions: { enabled: false, codex: { command: ['codex','app-server','--listen','unix://...'] } }`. Do not write it into the live config until the server that understands it is the one that stays. Choose the transport at bind time and persist it on the row; later config changes must not flip an existing binding.

---

## 12. Tests and fixtures

- **Fake tmux:** `apps/server/test/helpers/session-fixtures.ts`.
  - `FakeTmux implements TmuxClient` (11-100): records `created/createdCommands/sent/pasted/sentKeys/options`; scriptable `paneText`, `captureSequence`, `hasSessionResults`, fail flags; fixed `getPanePid` → 4242.
  - Also `project`, `provider`/`claudeProvider` stubs, `providerSettings`, `createRecoveryManager(db, tmux, runtimeDir, eventBus, provider, settings, options)` (140-158) building SM with injected deps, and `enableUnattendedRecovery` (160-164) registering with `pid: process.pid`.
  - The `TmuxClient` interface is `tmux-client.ts:115-133`.
- **Other injection points:** `SessionManagerOptions` (SM:113-124: `readLastUserInput`, `eagerRestoreWindowMs`, `restoreGraceMs`, `pressureSuspend*`, `readMemInfo`, `queueCodexNotice`, `hasActiveLaunchAuthority`, `launchAuthorityContext`); `RunRecovery` (`delaysMs`, `now`); `AgentSessionLaunches` (`readMemory`). There is no injected clock in SM: 8 test files use `vi.useFakeTimers`/`setSystemTime`. 26 test files use `FakeTmux`/`createRecoveryManager`.
- A fake structured transport should mirror this: a `StructuredTransport` interface injected via a new `SessionManagerOptions` field, with a `FakeStructured` recording requests and letting tests push notifications (`turn/started`, `item/completed`, `turn/completed`). `run-recovery.test.ts` already drives a fake monitor `{ read: async () => run }`.
- **Coverage by concern:**
  - Launch/bind/pending: `session-lifecycle`, `session-pending-first-turn`, `codex-first-turn`, `pending-adoption`, `pending-codex-context`, `conversation-routes`, `conversations`, `tmux-pane-size`, `session-routes`, `conversation-titles`.
  - Input: `session-input-queue`, `session-keystrokes`, `session-keystrokes-submit`, `session-interactive-input`, `session-claude-input-layout`, `keystroke-planner`, `image-input`, `session-runtime`.
  - Working/recency: `working-state`, `session-recency`, `session-idle-state`, `session-screen-state`, `claude-ready-lifecycle`, `screen-heuristics`, `session-screen`, `realtime-event-bus`.
  - Live output: `live-output`, `live-output-incremental`, `last-user-input`, `session-output-restoration`, `timeline-merge`, `transcript-watcher`, `provider-conversation-cache`, `output-watcher`, `transcript-responsiveness`.
  - Recovery: `run-recovery`, `codex-run-state`, `claude-run-state`.
  - Coordination: `peer-message-wake`, `peer-wake-transport` (queueCodexNotice argv/env), `peer-wake-audit`, `peer-wake-usage`, `assignment-continuation`, `coordination`, `message-priority`, `agent-reference`, `coordination-migration`.
  - Grants: `agent-grants`, `agent-session-launches`, `agent-grant-push`, `session-owned-close`.
  - Model: `model-profile-lifecycle`.
  - Config: `config`, `settings`.
  - Readers: `workers`, `worker-evidence`, `worktree-sweep`, `engineering-summary`, `database`, `search`.
  - Web: `ConversationPane.test.tsx`, `useConversationData.test.ts`, `features/realtime/*.test.ts`, `work-status.test.ts`.
- **E2E:** `apps/server/test/e2e/server.ts` writes a temp config/DB/runtime plus fixture transcripts and calls `buildApp({ configPath })` (142). `playwright.config.ts:20-30` starts it with `AGENT_CONSOLE_E2E_SERVER_PORT` and `reuseExistingServer: false`, plus a Vite web server.
  - `buildApp` hard-codes `new ShellTmuxClient()` (`app.ts:71`), so e2e cannot inject a fake transport today. A structured e2e would need an `AppOptions` seam, for example an injectable transport factory, or a fake `codex app-server` executable in config.

---

## Riskiest coupling points

1. **A structured row looks like a dead tmux session to every existing path, and several paths then launch a TUI for the same thread (two writers).** `refreshSessionState` → `restoreSession` → `tmux newDetachedSession(codex resume <threadId>)` (SM:3700-3701, 1710). It is reachable from the 1 s `/screen` poll (`getSessionScreen` 3606-3615), `ensureSession`, `bindConversationInternal` (2032), the input paths (2161, 2584), reconciliation (1212), wake (658), recovery `canRetry` (350) and `resumeSession`. Every tmux-liveness call site needs a transport guard **before** slice 1 ships, not after.
2. **Backend restart kills structured turns** if the app-server is a stdio child of Fastify. The tmux design explicitly survives restarts. Use a scoped, socket-listening app-server and reconnect plus `thread/resume` on boot (§8).
3. **PID/process-start as "provider alive"** in coordination, recovery, grants and the sweep (§6 item 3). A shared PID blocks wake delivery entirely (SM:652) and keeps every thread "alive" or "active" for receipts, `reconcileProcesses` and `worktree-sweep`.
4. **Identity without per-process env:** owner-locator overwrite and loss of `AGENT_CONSOLE_SESSION_ID` → no `bindAssignment` → granted helpers lose automatic `unattended` (grants/service.ts:33-36) (§6 item 2).
5. **Recency pollution on reconnect:** `thread/resume` returns past turns and items. Only live notifications after the resume epoch may touch `lastActivityAt/lastOutputAt/lastResponseAt` (AGENTS.md rule; SM uses `runPredatesNativeProcess` for the same purpose).
6. **Live assistant text has no event-log record type,** and the merge drops all non-user live rows once a transcript exists (timeline-merge.ts:270-277). Streaming needs a reader and merge change; the minimal seam relies on the rollout file.
7. **Schema version collision:** `design/extension-agent-lane` claims schema 19 for `extension_sessions`. A `bound_sessions.transport` column also needs a version, and `scripts/worktree-sweep.mjs:13` `SUPPORTED_SCHEMA_VERSIONS = [17, 18]` must be updated in the same change. Older binaries refuse a newer DB (schema.ts:319-321).
8. **Config key stripping** by an older running server on settings save (§11).
9. **Error-code vocabulary:** protocol `codexErrorInfo` is camelCase (`serverOverloaded`); RunRecovery retries only `server_overloaded|server_unavailable|process_exited` (run-recovery.ts:208). This matters only for a protocol-fed monitor.
10. **One writer per thread across transports:** nothing stops Bryan's own `codex agents`/TUI (shared daemon or `codex resume`) or a tmux binding from loading the same thread a structured binding owns. The "one restorable owner, one writer" invariant (architecture.md Key Decisions) is enforced today only by tmux owner options and PID checks.

## `bound_sessions` readers that misbehave if a row has no tmux session

**Inside SM**, all via `checkTmuxLiveness` returning `'dead'` or the tmux owner option being `undefined`:
- `refreshSessionState` (3654-3768): stops watchers and the run monitor on every call (3689-3690, including from `observeSessions` tree refreshes), then restores via tmux or returns `undefined`. Input then rejects with "Session is no longer running".
- `getSessionScreen` (3594-3630): restores via tmux on every 1 s poll.
- `restoreSession` (1632-1754): creates a TUI.
- `drainQueuedInputInternal` `stillOwned` (2387-2412): defers forever.
- `sendKeystrokesInternal` and `sendInputInternal`: `refreshSessionState` → restore.
- `drainAssignments` (648-653): returns forever because the shared PID is alive.
- RunRecovery `canRetry` (343-352): blocked, or restores via tmux.
- `suspendIdleSession` (1355-1389): `'dead'` → marks `idleSuspendedAt` without stopping the thread; a later wake then restores via tmux.
- `suspendPressureIdleSession` (1266-1309): same.
- `suspensionBlockReason` (3375-3378): `'ownership'`, so manual Suspend fails.
- `isWorkReleaseDue` path (1170-1178): OK when dead, but it requires an indexed readable transcript.
- `releaseSessionInternal` (3504-3534): marks `ended` but **never stops the thread in the app-server**.
- `drainModelProfileRequestInternal` (3151-3160): marks the session `error` and fails the request.
- `restartGrantedSession` (1845-1858): rejects (live owner outside binding).
- `closeGrantedSession` (1890-1894): proceeds; same release gap.
- `retainFinishedInbox` (485-496): never retains while the app-server lives.
- `verifyNativeProcessEpoch` (969-981): never set, so `runPredatesNativeProcess` is disabled and stale runs can keep the session "working".
- `allowsLiteralSelectionKeystroke` (3568-3583): harmless false.
- `ensureSessionLogPaths` (1517-1534): creates an unused `raw.log`. `watchSessionOutput` then tails it (harmless).

**Outside SM:**
- `workers/evidence.ts:51`: the roster requires `session.pid`.
- `grants/session-launches.ts:199-201, 241-242`: restart completion by PID change; concurrency counts rows with a PID.
- `coordination/service.ts:256-300` `sendReceipt`: PID-alive status.
- `coordination/service.ts:152-164` `reconcileProcesses`.
- `scripts/worktree-sweep.mjs:131-162`: liveness by PID; schema allowlist.
- `routes/sessions.ts:336-374` `/raw-output`: 404 when `rawLogPath` is null (acceptable).

**DB-only, transport-neutral readers that work as is:** `conversation-index.ts`, `search-index.ts`, `pending-conversations.ts` joins; `search/conversation-search.ts:294`; `indexing-service.ts:245` `getTree`; `lib/conversation-title.ts`; `coordination/audit.ts`, `delivery-warnings.ts`, `grants/push.ts` (they read wake-attempt meta, so the structured lane must keep writing `PeerWakeAttempt` records in the same format); `engineering/summary.ts:105-108` (reads `pid`, nullable OK).
