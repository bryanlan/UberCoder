# Provider plugin abstraction brief (research for Agent Console)

Status: read-only research. Nothing was built, run or edited. Evidence base is T3 Code v0.1.2 at
`/home/bryan/code/UberCoder/t3code-ref` (call it `T3/`; every `path:line` below is relative to it),
plus the ACP and Claude Agent SDK public docs fetched 2026-10-25.

What I did and did not check:
- Read in full: `packages/provider-core/src/server/ProviderAdapter.ts`, `driver.ts`, `adapterDriver.ts`,
  `ProviderHost.ts`, `ProviderContinuationRequests.ts`, `failure.ts`; the orchestration services listed in the
  assignment; contracts under `packages/contracts/src`.
- Skimmed with targeted reads (files are 7.5k, 10.5k and 8.5k lines): `CodexAdapterV2.ts`, `ClaudeAdapterV2.ts`,
  `packages/provider-acp/src/server/adapter.ts`. I read the adapter surface, open/resume/prompt/steer/interrupt,
  approvals/questions, terminal and failure mapping. I did not read the subagent, workflow, goal, wake-report
  or checkpoint paths line by line.
- Not verified: anything about Cursor, Pi, Muse, Antigravity internals. OpenCode and Grok are cited only where I read them.
- T3 never ran here. Its behavior is read from code and docs, not observed.

---------------------------------------------------------------------------------------------------

## 0. The one-paragraph answer

T3 keeps all provider protocol knowledge inside one object per provider instance, the
`ProviderAdapterV2` (`packages/provider-core/src/server/ProviderAdapter.ts:646-662`). It has three methods
(`getCapabilities`, `planSelectionTransition`, `openSession`). `openSession` returns a
`ProviderAdapterV2SessionRuntime` (`:550-644`), which is the real contract: ensure/resume thread, start/steer/
interrupt turn, respond to a pending request, read/rollback/fork, plus one `Stream` of events. The orchestrator never
checks the driver name. It reads a 12-group capability record (`packages/contracts/src/orchestrationV2.ts:329-347`)
and chooses a policy: steer, queue, or interrupt-and-restart (`apps/server/src/orchestration-v2/CommandPolicy.ts:150-200`).
Codex is treated as the richest protocol and the weaker ones (Claude, ACP) are adapted up to it with explicit flags
(`docs/orchestration-v2/README.md:7`). The price of that design is that adapters emit full state upserts
(whole messages, whole turn items, whole nodes) and own id derivation and ordinals. That is why the Codex adapter
is 7.5k lines and the Claude adapter 10.5k. For Console I would keep the capability-flag idea and the
"orchestrator never sees the driver" rule, but make the event union a small delta stream and move id/ordinal
bookkeeping into one shared normalizer.

---------------------------------------------------------------------------------------------------

## 1. T3's adapter contract

### 1.1 Layering (who owns what)

```
ProviderDriver<Config>            static: driverKind, configSchema, create(instance cfg)      provider-core/server/driver.ts:115-134
  -> ProviderInstance             one configured account/binary/home; snapshot (health, models, auth, usage),
                                  orchestrationAdapter, textGeneration, auth                  driver.ts:42-85
     -> ProviderAdapterV2         getCapabilities / planSelectionTransition / openSession      ProviderAdapter.ts:646-662
        -> SessionRuntime         the process-bound handle; event Stream; thread/turn ops      ProviderAdapter.ts:550-644
ProviderAdapterRegistryV2         instanceId -> adapter; wraps openSession with credential-change guards
                                  apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts:48-62, 69-160
ProviderSessionManagerV2          owns live SessionRuntimes: open/get/close/release/detach, idle timers, event pump
                                  apps/server/src/orchestration-v2/ProviderSessionManager.ts:145-183
```

"No shared mutable state between instances" is a stated rule (`driver.ts:111-114`). Routing is by instance id,
not driver kind (`docs/internals/providers.md:8-10`).

### 1.2 The interface every adapter implements

`ProviderAdapterV2` (service object, `ProviderAdapter.ts:646-662`)

| Member | Signature | Line |
|---|---|---|
| `instanceId`, `driver` | `ProviderInstanceId`, `ProviderDriverKind` | 649-650 |
| `getCapabilities()` | `Effect<OrchestrationV2ProviderCapabilities, AdapterError>` | 651-654 |
| `planSelectionTransition(input)` | `{current,target,sessionCapabilities} -> apply_on_next_turn \| restart_session \| create_with_handoff \| reject` (`selectionTransition.ts:3-13`) | 655-657 |
| `openSession(input)` | `Effect<SessionRuntime, AdapterError, Scope>`; the Scope owns the process (closing it kills the process) | 658-660 |

`openSession` input (`:405-413`): `threadId, providerSessionId, modelSelection, runtimePolicy,
resumeFromSession?, initialNativeThreadId?, initialProviderItemIdentityVersion?`.
`runtimePolicy` (`:48-56`): `runtimeMode, interactionMode ("default"|"plan"), cwd, approvalPolicy?, sandboxPolicy?, reasoningEffort?`.

`ProviderAdapterV2SessionRuntime` (`:550-644`)

| Member | Signature (input fields) | Line |
|---|---|---|
| `providerSession` | snapshot incl. `status`, `cwd`, `model`, `capabilities` (`OrchestrationV2ProviderSession`, contracts `:757-769`) | 554 |
| `events` | `Stream<ProviderAdapterV2Event, AdapterError>`; single consumer | 555 |
| `subscribeEvents?` | manager-owned fan-out for several threads | 561 |
| `hasPendingBackgroundWork?`, `hasPendingBackgroundWorkForThread?`, `backgroundTasksEndWithProcess?` | idle-release pin | 562-577 |
| `getModelContextWindow?`, `canReuseContextUsage?` | context meter | 578-582 |
| `ensureThread(input)` | create a native conversation: `threadId, title?, modelSelection, runtimePolicy, providerSessionId?, existingProviderThread?` -> `ProviderThread` | 583-585 |
| `resumeThread(input)` | reattach by `providerThread.nativeThreadRef`; may change model/policy | 586-591 |
| `injectHistory?(ctx)` | `boolean`; false = protocol cannot take history | 592-597 |
| `startTurn(input)` | `void`; results arrive as events. Input `:424-439`: `appThread, threadId, runId, runOrdinal, providerTurnOrdinal, attemptId, rootNodeId, providerThread, message{text,attachments,...}, modelSelection, runtimePolicy, appContext?` | 598-600 |
| `compactThread?(input)` | same input; Claude and ACP send the text `/compact` | 601-603 |
| `steerTurn(input)` | `void`; `{providerThread, providerTurnId, message}`; ACP fails with `ProviderAdapterSteerRunUnsupportedError` | 604-606 |
| `interruptTurn(input)` | `{providerThread, providerTurnId, requestRuntimeRestart?}` -> `void` | 611-613 |
| `stopTask?`, `stopSubagent?` | background work stop | 607-619 |
| `unloadThread?` | release a native thread inside a shared process (Codex `thread/unsubscribe`) | 620-622 |
| `respondToRuntimeRequest(input)` | `{requestId, decision?, answers?, response?}` | 623-625 |
| `readThreadSnapshot(input)` | `ThreadSnapshot{providerThread, providerTurns, messages, runtimeRequests, providerPayload?}` | 626-628 |
| `rollbackThread`, `forkThread` | rollback target is `thread_start` or `provider_turn` | 638-643 |
| `uploadFeedback?`, `mcpApps?` | only Codex implements them (grep of `Adapters/` and `packages/provider-*`) | 629-637 |

Error classes are one tagged error per operation (`:178-403`): Capabilities, OpenSession, CloseSession, ResumeThread,
EnsureThread, ReadThreadSnapshot, RollbackThread, ForkThread, TurnStart, SteerRunUnsupported, SteerRun, Interrupt,
RuntimeRequestResponse, EventStream, Protocol. `ProviderAdapterProtocolError.reason` is a closed enum
(`previous_turn_active`, `attachment_unreadable`, `:365-384`) because free-text causes can contain secrets.

Driver level extras (not per turn): `ProviderHost` gives adapters paths, settings stream, attachment path resolver and
credential storage (`provider-core/server/ProviderHost.ts:32-57`). `ProviderContinuationRequests` is a queue an
adapter offers to when the provider wakes itself up after the turn settled (background command or subagent finished)
(`ProviderContinuationRequests.ts:15-48`).

### 1.3 The normalized event union the adapter emits

`ProviderAdapterV2Event` (`ProviderAdapter.ts:79-176`). Every variant carries `driver`.

| `type` | Payload | Line |
|---|---|---|
| `app_thread.created` | `appThread`, `createOnly?` (subagent/child thread creation) | 80-85 |
| `provider_session.updated` | `providerSession` (status `starting/ready/running/waiting/stopped/error`) | 86-90 |
| `provider_thread.updated` | `providerThread`, `retainedNativeTurnIds?` (rollback) | 91-96 |
| `provider_turn.updated` | `threadId?`, `providerTurn` (status `pending/running/completed/interrupted/failed/cancelled`, `tokenUsage`, `turnTokenUsage`; contracts `:972-992`) | 97-102 |
| `node.updated` | `node` (execution graph node) | 103-107 |
| `subagent.updated` | `subagent` | 108-112 |
| `message.updated` | whole `ConversationMessage` | 113-117 |
| `turn_item.updated` | whole `TurnItem` (see below) | 118-122 |
| `command_output.delta` | `threadId, itemId, chunk`; never persisted, goes to an output hub | 128-134 |
| `runtime_request.updated` | `runtimeRequest` (approval or question; `kind`, `status`, `responseCapability`, `decision`, `answers`; contracts `:1012-1032`) | 135-140 |
| `plan.updated` | `PlanArtifact` = `proposed_plan{markdown}` or `todo_list{steps}` (contracts `:1159-1172`) | 141-145 |
| `turn.terminal` (ok) | `providerThreadId, providerTurnId, runOrdinal, status: completed\|interrupted\|cancelled, failure: null, threadDisposition: reusable\|broken` | 146-155 |
| `turn.terminal` (failed) | same plus `failureItemOrdinal, status:"failed", failure: ProviderFailure, retry?, retryStartedAt?, childTurnsContinue?` | 156-174 |

`TurnItem` union (contracts `orchestrationV2.ts:1339-1543`; common fields `:1287-1306`: `id, threadId, runId, nodeId,
providerThreadId, providerTurnId, nativeItemRef, parentItemId, ordinal, status, title, startedAt, completedAt, updatedAt`).
Variants: `notification`, `user_message` (`inputIntent: turn_start|queued_turn|steer|promoted_queued_to_steer`),
`assistant_message{text,streaming}`, `reasoning{text,streaming}`, `proposed_plan`, `todo_list`,
`user_input_request{requestId,questions[],responseMode?:"message"}`, `file_change`, `command_execution{input,output,exitCode}`,
`file_search`, `web_search`, `approval_request{requestId,requestKind,prompt,reason,options[]}`, `checkpoint`,
`run_interrupt_request`, `run_interrupt_result`, `system_notice`, `error{failure,retry?}`, `compaction`, `handoff`, `fork`,
`thread_created`, `secret_request`, `subagent`, `dynamic_tool{toolName,input,output}`.

Supporting types worth copying:
- `ProviderFailure` (contracts `:1240-1265`): `class: usage_limit|provider_error|transport_error|permission_error|validation_error|unknown`,
  `message` (max 4096, "Producers must redact credentials"), `code`, `retryable`, `resetAt?`.
- `ProviderRetry` (`:1267-1272`): `attempt, maxAttempts, retryDelayMs` (provider-side backoff the user can watch).
- `ProviderRef` (`:100-106`): `{driver, nativeId, strength: strong|weak|none, fingerprint?, ordinal?}`; native ids are refs, app ids are primary.
- `RuntimeMode` (`providerPolicy.ts:25-31`): `approval-required|auto-accept-edits|auto|full-access`. `ProviderRequestKind`
  (`:38-45`): `command|file-read|file-change|mcp-elicitation|permission`. `ProviderApprovalDecision` (`:50-57`):
  `accept|acceptForSession|acceptAlways|decline|cancel`. `ProviderApprovalOption{decision,label,warning?}` (`:64-69`).
- `UserInputQuestion` (contracts `:1131-1148`): `id, header, question, options[{label,description,value?,preview?}], multiSelect?, allowCustomAnswer?, required?`.
- `ModelSelection` (`modelSelection.ts:9-51`): `{instanceId, model, options?: [{id, value: string|boolean}]}`. Effort is just
  one option id (`reasoningEffort` for Codex, `effort` for Claude; `CodexAdapterV2.ts:742`, `ProviderEventIngestor.ts:106-109`).
- Option descriptors (`model.ts:7-44`): `select{options[],currentValue}` or `boolean`, attached to each model via
  `ModelCapabilities.optionDescriptors` (`:102-105`); `ServerProviderModel` (`server.ts:74-85`).
- Usage windows (`providerUsageLimits.ts:16-67`): `{id, kind: session|weekly|monthly|other, label, usedPercent, resetsAt, windowDurationMins}`;
  updates are sparse and merge by `id`.
- Token usage: `ProviderTurnTokenUsage` (`orchestrationV2.ts:167-179`) and a separate context snapshot `ThreadTokenUsageSnapshot` (`providerRuntime.ts:260`).

T3 also has an older, flatter canonical event union, `ProviderRuntimeEvent` (`packages/contracts/src/providerRuntime.ts:1109-1162`):
`session.started/configured/state.changed/exited`, `thread.started/state.changed/metadata.updated/token-usage.updated`,
`turn.started/completed/aborted/plan.updated/proposed.delta/proposed.completed/diff.updated`, `item.started/updated/completed`,
`content.delta`, `request.opened/resolved`, `user-input.requested/resolved`, `task.*`, `hook.*`, `tool.progress/summary`,
`auth.status`, `account.updated`, `account.rate-limits.updated`, `mcp.*`, `model.rerouted`, `config.warning`,
`deprecation.notice`, `files.persisted`, `tool.denied`, `runtime.warning`, `runtime.error`. The ACP package still builds some
events in this shape (`packages/provider-acp/src/server/coreRuntimeEvents.ts:68-255`). This older shape is the closer analogue
of what Console wants, because it is delta-based.

### 1.4 How the orchestrator consumes the events

| Concern | Service | What it does | Where |
|---|---|---|---|
| Event ingest | `ProviderSessionManager.startEventPump` | Drains `runtime.events`; routes `command_output.delta` to the output hub; marks session idle on `turn.terminal`, otherwise bumps activity; persists `provider_session.updated`; releases entry on stream failure with reason `runtime_error` | `ProviderSessionManager.ts:1929-2070` |
| Event to domain | `ProviderEventIngestor.normalize` | One-to-one upsert of each event type into a domain event; dedupes unchanged `node.updated`; a `failed` `turn.terminal` becomes an `error` turn item | `ProviderEventIngestor.ts:521-728` (terminal at `684-713`) |
| Turn completion | `RunExecutionService` | Only the root provider turn's `turn.terminal` finalizes a run (`:516-519`, `:1424-1428`). A clean stream end without a terminal is an error (`:1435-1452`). On an ingest failure it interrupts the turn and writes final run events (`:1455-1500`) | `RunExecutionService.ts` |
| Failure | `failure.ts` | `makeProviderFailure` redacts URLs, bearer tokens, `sk-...` keys, control chars; maps wrapper tags to curated messages | `provider-core/server/failure.ts:145-230` |
| Usage limits (turn) | adapter sets `failure.class="usage_limit"` + `resetAt`; the thread shell records `lastErrorClass` | `UsageLimitRecoveryWorker.ts:11-72` arms recovery, then dispatches "Continue where you left off." once the reset time passes (autoResume / snooze settings) | `UsageLimitRecoveryWorker.ts` |
| Usage limits (account) | adapter calls `onUsageLimits(update)` -> `ManagedServerProvider.applyUsageLimits` (sparse merge by window id) | Codex `account/rateLimits/updated` (`CodexAdapterV2.ts:4391-4419`), Claude `rate_limit_event` (`ClaudeAdapterV2.ts:7444-7457`), plus polled probes (`CodexProvider.ts:571`, `ClaudeProvider.ts:392`) | `provider-core/server/snapshot.ts:6-25` |
| Approvals / questions | adapter raises `node.updated` + `turn_item.updated` + `runtime_request.updated`, then parks a `Deferred` inside the native callback. UI answers via `respondToRuntimeRequest`, which completes the Deferred | `CodexAdapterV2.ts:5171-5241`, `ClaudeAdapterV2.ts:8807-8960`, ACP `adapter.ts:5990-6125` | |
| Question as message | Codex async questions arrive as notifications and are answered with a new user message; request has `responseCapability:{type:"message"}`; survives restart | `docs/internals/providers.md:106-118` | |
| Pending requests on stop | `dismissNativeUserInputs` on any terminal turn status | `ProviderEventIngestor.ts:585-593, 685` | |
| Delegation (provider native) | `subagent.updated` / `app_thread.created` / `node.updated`; child turns have their own terminals and never close the parent run | `RunExecutionService.ts:482-520`, `docs/orchestration-v2/README.md` invariant 3 | |
| Delegation (app owned) | MCP orchestrator server exposes delegate/task tools (`delegate_task`, `task_status` named in the continuation text); completion wakes the parent through `ProviderContinuationRequests` -> `ProviderContinuationService` | `ProviderContinuationService.ts:1-60`; `docs/orchestration-v2/orchestrator-mcp-server.md` (not read) | |
| Steer vs queue vs restart | `CommandPolicy.decideMessageDispatch` | Active run with running turn: `supportsActiveSteering` -> `steer_active`; else `supportsQueuedMessages` -> `queue_after_active`; else `supportsSteeringByInterruptRestart` -> `restart_active`; during preparing/starting or after the turn ended, always queue | `CommandPolicy.ts:150-200`, `:284-305` |
| Interrupt | `ProviderTurnControlService.interrupt` | Calls `interruptTurn({requestRuntimeRestart:true})`, then polls the projection up to 2 s for a non-running turn; no live session = treat as already stopped | `ProviderTurnControlService.ts:182-256` |
| Interrupt + restart | `interruptAndAwaitTerminal` | Interrupts and waits up to 1000 event-loop yields for turn and attempt to leave `running`, else error | `ProviderTurnControlService.ts:257-325` |
| Steer | `ProviderTurnControlService.steer` | Re-checks the turn is still `running` (else error with `turnCompleted`), loads persisted message, calls `steerTurn`; failure lets the orchestrator start a normal follow-up | `ProviderTurnControlService.ts:326-410` |
| Start / resume | `ProviderTurnStartService` | New thread: `ensureThread`; existing native ref: `resumeThread`; **on resume failure it falls back to a fresh native thread plus a `provider_resume_fallback` history handoff** | `ProviderTurnStartService.ts:724-800` |
| History injection | `deliverContextHandoffs` | If `session.injectHistory` exists use it, else prefix the prompt text with `context\n\nUser message:\n...`; budgeted by context window | `ProviderTurnStartService.ts:1162-1262` |
| Model / mode change | `decideProviderSessionTransition` | `reuse`, `switch_model_in_session`, `restart_and_resume`, `create_with_handoff`, `reject`; both Codex and Claude answer `apply_on_next_turn`, ACP rejects model change if the session lacks a model switch | `ProviderSessionTransitionPolicy.ts:34-96`, `selectionTransition.ts:15-32` |
| Start retry | durable effect outbox, `maxAttempts` default 5; `willRetry` makes start failures throw instead of settling the run until attempts are exhausted | `EffectWorker.ts:593, 736`; `ProviderTurnStartService.ts:608, 661, 676` |
| Restart recovery | `ProviderRuntimeRecoveryService` terminalizes non-terminal runs, stops sessions, closes requests; `RestartContinuation` queues "Continue where you left off." (chain max 3 within 5 min) | `ProviderRuntimeRecoveryService.ts:68-80, 171+`; `RestartContinuation.ts:31-34` |

### 1.5 Process lifecycle

Key rule: sharing is decided by one capability, `sessions.supportsMultipleProviderThreadsPerSession`.
`Orchestrator.providerSessionIdFor` (`Orchestrator.ts:962-980`):
- true (Codex, OpenCode 2.x): ONE derived provider session id per provider instance. One process serves every app thread.
- false (Claude, generic ACP, OpenCode 1.x): a fresh session id per app thread. One process (or process group) per thread.
`ProviderSessionManager.open` enforces it: attaching a second thread to a session that does not support multiple threads
throws (`ProviderSessionManager.ts:2122-2130`).

| Aspect | T3 behavior | Where |
|---|---|---|
| Spawn | Inside `openSession`; the Scope passed in owns the child process | Codex `CodexAdapterV2.ts:1445-1467`; ACP runtime `AcpSessionRuntime.ts:2689-2695` |
| Idle release | Timer per session, default 30 min (`DEFAULT_IDLE_TIMEOUT_MS`); skipped while `busyTurns` non-empty; if `hasPendingBackgroundWork` the session is pinned and rechecked each window up to 4 h (`DEFAULT_MAX_IDLE_PIN_MS`), then released anyway; provider activity restarts the pin budget | `ProviderSessionManager.ts:56-57, 1109-1187, 1204-1241` |
| Per-thread unload | In a shared process, an idle thread gets its own timer and `unloadThread` (Codex `thread/unsubscribe`, `CodexAdapterV2.ts:6866-6883`; timers `ProviderSessionManager.ts:1508-1660`) | |
| Release reasons | `idle_timeout | runtime_error | manual_shutdown | server_shutdown` | `ProviderSessionManager.ts:65-71` |
| Close | Releasing closes the session Scope (30 s time box `RELEASE_SCOPE_CLOSE_TIMEOUT_MS`). Shutdown releases all in parallel because the launcher kills the server 5 s after asking it to stop | `ProviderSessionManager.ts:58, 2073-2099` |
| Runtime death | Event stream ending without a stop is turned into `ProviderAdapterEventStreamError`, subscribers get a failure signal, entry released with `runtime_error` | `ProviderSessionManager.ts:2046-2067` |
| Recovery after server restart | No provider process survives the server. On startup runs are terminalized, native subagents closed, pending requests closed (not resumable unless `responseCapability` is `message`), then a continuation run resumes the native conversation by id | `ProviderRuntimeRecoveryService.ts` (comments around `:230-500`); capability `pendingRequestsSurviveRestart:false` for all three adapters |
| Resume after idle release | Not a capability: "an adapter must be able to start from a stored cursor or return a resume failure" (`docs/orchestration-v2/provider-capability-system.md:42`). Claude must use `resume:` once a turn exists, `sessionId:` only the first time (`ClaudeAdapterV2.ts:9272-9279, 1327-1329`) | |
| Health | Separate from sessions: `ManagedServerProvider` snapshot (installed, version, auth, models, usage, setup) refreshed on an interval and on settings change (`provider-core/server/managedProvider.ts:39-120`). Probes must not open a session that can start MCP servers, run hooks or launch a login (`docs/internals/adding-a-provider.md:44-45`). Claude probe feeds a prompt iterable that never yields, then calls `initializationResult()` (`ClaudeProvider.ts:343-431`). ACP probe uses `initialize` only (`AcpSessionRuntime.ts:1138-1145`) | |
| Version gating | Per-driver semver policy table gives `supported/graceful/unsupported/broken` + recommended version (`apps/server/src/provider/providerCompatibility.ts:57-136`) | |
| Process containment | ACP: detached process group, Linux cgroup-v2 lease, POSIX ownership ledger, and for `wait-for-prompt` agents a 15 s cancel timeout then kill (`AcpSessionRuntime.ts:95-115, 81, 2359-2367`). Claude: CLI spawned in its own process group via `/bin/sh` wrapper, SIGKILL on exit (`ClaudeAdapterV2.ts:330-352`). All launches go through `AgentScope.wrap` (`CodexAdapterV2.ts:1412`, `ClaudeAdapterV2.ts:930`) | |

### 1.6 Provider x capability table

Legend: "app" = T3 implements it above the adapter. Line refs are the code that decides the cell.

| | Codex (`codex app-server`) | Claude (Agent SDK) | Generic ACP agent | Grok (ACP flavor) | Mistral Vibe (ACP registry) | OpenCode 2.x |
|---|---|---|---|---|---|---|
| Transport | JSON-RPC 2.0 over child stdio | `query()` from `@anthropic-ai/claude-agent-sdk`; SDK spawns the Claude Code binary and talks over its stdio | ACP JSON-RPC over child stdio (NDJSON) | ACP, `grok agent stdio` (`provider-grok/src/server/acpSupport.ts:52-66`) | ACP via registry, extra `_session/retrying` ext (`provider-acp-registry/src/server/adapter.ts:85-130`) | HTTP + password to one local server (`provider-opencode/src/server/v2/OpenCode2Server.ts:1-5`) |
| Process model | shared: one app-server per provider instance, many threads (`CodexAdapterV2.ts:240`, spawn `:1445`) | per-session: one CLI process per live query, session id per app thread (`ClaudeAdapterV2.ts:356`); process opened lazily on first turn (`:9167-9330`) | per-session (`acp adapter.ts:473`) | per-session | per-session | shared per instance (`v2/adapter.ts:94`) |
| Start | `initialize` + `initialized` once per process (`:1803-1832`), then `thread/start` (`:6640-6651`) | client-allocated UUID `allocateSessionId` (`:10093`), first query uses `sessionId` option (`:1327-1329`) | `initialize`, optional `authenticate`, `session/new{cwd,mcpServers}` (`AcpSessionRuntime.ts:2210-2223`) | same + Grok-specific meta | same | not read |
| Resume | `thread/resume{threadId, excludeTurns:true}` (`:6676-6690`); archived thread -> `thread/unarchive` then retry (`:6694-6707`) | `resume: nativeId` option on a new query (`:1328`), refuses if transcript empty (`:10124-10131`) | `session/load` if `agentCapabilities.loadSession` (history replays as updates) else `session/resume` if `sessionCapabilities.resume` else error (`AcpSessionRuntime.ts:2179-2209`) | same | same | not read |
| Prompt | `turn/start{threadId,input[],model,effort,approvalPolicy,sandboxPolicy,collaborationMode,...}` returns the native turn id (`:6382`, params `:728-811`) | `query.offer(SDKUserMessage)` on the prompt async-iterable (`:9591`); one active turn at a time else `previous_turn_active` (`:9450-9456`) | `session/prompt{sessionId,prompt[]}`; the RPC response is the turn terminal with `stopReason` (`:2570-2629`, `adapter.ts:7540-7602`) | same | same | not read |
| Steer while running | native `turn/steer{expectedTurnId,input}` (`:6845`) | native-ish: `offer(msg{priority:"now"})`, which **cancels running tool calls** (`:9915, 9822-9825`); flag `activeSteeringInterruptsTools` (`:377`) | none: `steerTurn` always fails (`adapter.ts:7878-7884`); capability `supportsSteeringByInterruptRestart:true` (`:494`) | same | same | native + restart both on (`v2/adapter.ts:114-115`) |
| Queue | app-owned queue (flag true everywhere; `CommandPolicy.ts:273-282`) | app | app | app | app | app |
| Interrupt | `turn/interrupt` returns first, then `turn/completed` with status `interrupted` arrives (`:6885+`; README probes `docs/orchestration-v2/README.md:88`) | `query.interrupt()` then `query.close()`; waits 10 s for the process to close, else synthesizes the terminal (`:9777-9790`). Next turn reopens with `resume` | `session/cancel` notification; spec says the agent must answer the in-flight prompt with `stopReason:"cancelled"`. T3's default (`cancelBehavior:"interrupt"`) interrupts its own prompt fiber (which resolves locally as `cancelled`) and then writes the cancel notification; only Antigravity sets `wait-for-prompt`, which waits up to 15 s for the agent and then kills the process (`AcpSessionRuntime.ts:2328-2372, 2599-2603`; `apps/server/src/provider/acp/AntigravityAcpSupport.ts:59`) | Stop hard-kills the process group and respawns; non-Stop interrupts are soft (`provider-grok/.../adapter.ts:238-250`) | same as generic | not read |
| Approvals | server->client requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `mcpServer/elicitation/request`, legacy `execCommandApproval`, `applyPatchApproval` (`:5171-5528`); native policy enforcement (`runtimePolicy.enforcement:"native"` `:327`) | `canUseTool(toolName,input,{toolUseID,suggestions,...})` -> `{behavior:"allow"\|"deny"}` (`:8807-9045`); native enforcement via `permissionMode` (`:2036-2083`) | `session/request_permission` with agent-supplied `options[{optionId,name,kind}]`; client answers `selected{optionId}` or `cancelled` (`adapter.ts:5990-6125`, option pick `:978-989`); **enforcement is client-side**: capability `enforcement:"client-boundary"` (`:563-565`) and `clientPolicy.ts` decides allow/ask/deny | same | same | not read |
| Questions | `item/tool/requestUserInput` (blocking, `:5597-5656`) and message-mode notifications | `AskUserQuestion` tool through `canUseTool` (`:8865`); plan approval via `ExitPlanMode` (`:8931`) | ACP elicitation + flavor hook `extractPermissionQuestion` (`adapter.ts:5993`, `:249`) | same | same | not read |
| Model / effort | `model/list` (`CodexProvider.ts:355-371`), per-turn `model`+`effort`+`serviceTier` (`:792-809`); `apply_on_next_turn` | static bundled manifest + CLI `minVersion` gates (`docs/internals/model-manifest.md`), `effort`/`thinking` query options (`:1356-1380`); live `setModel` + `applyFlagSettings` when possible, else close and reopen the query (`:9199-9252`) | agent advertises `configOptions` / `models` after the session opens; set with `session/set_config_option` or `session/set_model` (`AcpSessionRuntime.ts:2048, 2662-2670`); T3 waits for the option to be advertised before writing (`adding-a-provider.md:75-79`) | resolves Grok ids (`resolveModelId`) | agent-defined | not read |
| Usage limits | `error` notification with `codexErrorInfo` classified by `codexUsageLimitError` (`:4573-4658`); `account/rateLimits/updated` (push) and `account/rateLimits/read` (poll) | `rate_limit_event` frames + result `api_error_status 429` (`:3171-3239`, `:7444-7500`); `usage_EXPERIMENTAL...()` poll in probe (`ClaudeProvider.ts:392`) | **no standard signal**. Agent-specific: Vibe error code -31001 and `_session/retrying` (`acp-registry adapter.ts:85-130`); Grok code -32003 (`provider-grok/src/server/xaiAcpExtension.ts:15`) | -32003 | -31001 | not read |
| History read | `thread/read{includeTurns:true}` but T3 stores only `providerPayload`, arrays empty (`:7347-7381`) | not implemented in adapter (`:10301-10308`); SDK offers `getSessionMessages` (`:1188`) and the CLI writes the normal jsonl transcript | `session/load` replays `session/update` notifications; adapter rebuilds messages (`adapter.ts:8259-8331`), `canReadThreadSnapshot = agentCapabilities.loadSession` (`:587`) | same | same | not read |
| Image input | `UserInput{type:"image", url:data:...base64}` (`:3203-3206`) | base64 `image` content block in `SDKUserMessage` (`:1832-1960`), streaming input only | image block only if `promptCapabilities.image` (`adapter.ts:6606, 7184-7210`); Grok lies (`image:false` but accepts, `provider-grok adapter.ts:249-251`) | accepts | per agent | not read |
| Fork / rollback | native `thread/fork`, `thread/rollback` | `forkSession` + `resumeSessionAt` | rollback = fresh session (no ACP truncation, `adapter.ts:550-553`); fork only if `sessionCapabilities.fork` (`:578`) | no fork | per agent | both true |

Other T3 numbers worth keeping: Codex flushes assistant deltas every 50 ms and plan deltas every 400 ms
(`CodexAdapterV2.ts:210-213`), ACP flushes text every 50 ms (`adapter.ts:143`).

---------------------------------------------------------------------------------------------------

## 2. What T3 isolates inside each adapter, and what is shared

### 2.1 Codex idiosyncrasies (all in `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`)

- One `initialize` + `initialized` per shared process, guarded by a semaphore; "Already initialized" (-32600) is swallowed
  because a caller interrupted after the request reached Codex leaves the flag unset (`:1803-1832`). Client capabilities opt out of
  `turn/diff/updated` and declare `experimentalApi` (`:232-236`).
- Async user questions are notifications answered with a new user message, not an RPC reply (`docs/internals/providers.md:106-118`);
  blocking questions use `item/tool/requestUserInput` (`:5597-5656`). Both map to one `user_input_request` item, differing in `responseMode`.
- `/goal`: Codex starts follow-up turns by itself, so the adapter holds the run open and one T3 run owns several native turns
  (`docs/internals/providers.md:120-126`; `CodexAdapterV2.ts:6268-6500`).
- Codex "accept for session" only covers the exact command, so the adapter keeps its own per-thread allowance sets
  (`:1891-1898, 5180-5186, 5234-5236`).
- Plan mode is `collaborationMode` + developer instructions on `turn/start`; `summary:"detailed"` and `approvalsReviewer` are always sent
  explicitly because Codex remembers the last value (`:777-809`).
- Context re-injection after compaction through `thread/inject_items` (`:1768-1802`); `thread/compact/start` for compaction (`:6747`).
- Archived thread on resume: regex on the error text, `thread/unarchive`, retry (`:6694-6707`).
- Shadow `CODEX_HOME` per instance so ChatGPT-managed auth can be shared or isolated (`:1628-1638`, `provider/Drivers/CodexHomeLayout.ts`, not read).
- Errors: `error` notification with `willRetry` becomes a visible retry item; usage-limit classification from `codexErrorInfo`
  (`:4573-4658`); a `completed` turn that the adapter itself interrupted is reported as `interrupted` (`:6160-6165`).
- Legacy approval requests (`execCommandApproval`, `applyPatchApproval`) still handled (`:5458, 5528`).
- Subagent child threads arrive as ordinary threads with their own turns (`:1878-1882`); background terminals have list/terminate RPCs (`:2344-2366`).

### 2.2 Claude idiosyncrasies (all in `ClaudeAdapterV2.ts`)

- Not in-process: the SDK launches the Claude Code binary. T3 wraps it in `/bin/sh` for a process group and SIGKILLs the group on exit
  (`:330-352`), passes MCP servers over the control channel so header secrets stay out of argv (`:917-921`), and uses
  `CLAUDE_CONFIG_DIR` instead of `HOME` because HOME breaks the macOS keychain lookup (`provider/Drivers/ClaudeHome.ts:35-44`).
- Session id is client-allocated; the first query passes `sessionId`, later ones `resume` (`:10093, 1327-1329, 9272-9279`).
- The live query is a cached process. Model/effort changes try `setModel` + `applyFlagSettings` on it; otherwise the process is closed
  and reopened; replacement is refused while background agents or shells run in that process (`:9199-9252`, error text `:535-542`).
- Every offered prompt needs a fresh UUID because Claude silently acks a prompt whose uuid is already in its transcript (`:9427-9443`).
- Steer = offer a second `SDKUserMessage` with `priority:"now"`; this cancels running tools, so the adapter first moves foreground
  subagents to the background (`:9822-9852, 9915, 9938`).
- Interrupt = `interrupt()` then `close()` of the whole query, 10 s wait for closure (`:9777-9790`).
- Permission modes are derived from T3 runtime mode + sandbox + interaction mode, e.g. plan -> `plan`, read-only -> `dontAsk`,
  full-access -> `bypassPermissions` (`:2036-2083`); denied `ExitPlanMode` leaves Claude in plan mode and must be restored (`:9222-9238`).
- Tool approval, `AskUserQuestion` and `ExitPlanMode` all arrive through the single `canUseTool` callback (`:8807-8990`); approvals that
  an allow rule or `acceptEdits` already resolved never reach the callback.
- Background tasks and "wake" reports: Claude can start a turn on its own after a background task ends. The adapter buffers those frames
  and replays them into a synthetic continuation turn (`:9594-9720`, `ProviderContinuationRequests`).
- Usage limits come from three places: `rate_limit_event` frames, `api_retry` system messages, and a result with `api_error_status 429`
  or a gateway 503 whose text embeds a 429 (regex, `:3171-3257`, `:7444-7500`, `:7903`).
- Goals are not an SDK event; the adapter reads them from transcript text (`:1555`, `docs/internals/providers.md:125-126`).
- Claude Code flushes transcript writes about every 100 ms, so workflow-member replies can land after the progress frame that settles them (`:309`).

### 2.3 ACP idiosyncrasies (`packages/provider-acp/src/server/`)

T3 has one generic ACP adapter (`adapter.ts`, 8.5k lines) and a `AcpAdapterV2Flavor` record of about 40 optional hooks
(`adapter.ts:226-380`) that real agents need: `promptFailure`, `normalizeSessionUpdate`, `resolveModelId`, `applyModelSelection`,
`sessionModeForPolicy`, `permissionDisposition`, `extractPermissionQuestion`, `approvalOptions`, `preferResumeSession`, `registerExtensions`,
`extractSubagent*`, `extractBackground*`, `deferFinalizeForBackgroundWork`, `enablePostSettleContinuation`, `interruptPromptOnCancel`,
`restartRuntimeAfterInterrupt`, `supportsImagePrompts`, `supportsCompaction`, `getModelContextWindow`. Examples of why:
- Grok: image prompts work although `initialize` says `image:false` (`provider-grok/src/server/adapter.ts:249-251`); Stop must kill the process
  group and respawn so background tasks die, but steering must not (`:238-250`); permission mode goes on argv (`acpSupport.ts:52-66`);
  rate limit is code -32003 and prompt completion arrives through an xAI extension (`xaiAcpExtension.ts:15-40`, 1.6k lines).
- Mistral Vibe: rate limit is application error -31001 and backoff is reported by the `_session/retrying` extension
  (`provider-acp-registry/src/server/adapter.ts:85-130`).
- Antigravity: eager authenticate, `wait-for-prompt` cancel (`AcpSessionRuntime.ts:122-126`, `apps/server/src/provider/acp/AntigravityAcpSupport.ts:59`).
- Generic: `session/load` replays history as updates and the agent signals the end only by returning; T3 gates replay with a 2 s idle gap and a
  90 s timeout (`AcpSessionRuntime.ts:79-80, 1936-2006`). Replay frames can carry `_meta.isReplay` (`runtimeModel.ts:1239-1242`).
- ACP only reports `stopReason`; T3 maps `cancelled` to interrupted/cancelled and everything else (`end_turn`, `max_tokens`,
  `max_turn_requests`, `refusal`) to `completed` (`adapter.ts:7574-7579`). That hides refusals and truncation; Console should map them.
- The client owns permission policy: T3 decides allow/ask/deny from runtime mode and sandbox (`clientPolicy.ts`), and picks the agent's
  `allow_once/allow_always/reject_once` option id (`adapter.ts:978-989`).
- Agents provide file/terminal tools through client methods (`fs/read_text_file`, `terminal/*`); T3 implements them only where it must
  (`clientTerminals.ts`, `clientFileSystem` flavor hook `adapter.ts:279-288`).

### 2.4 Shared code (and how shared it really is)

| Shared piece | Used by | Where |
|---|---|---|
| `ProviderAdapterV2` contract, error classes, event union | all | `provider-core/src/server/ProviderAdapter.ts` |
| Failure builder + redaction + curated messages (`makeProviderFailure`, `makeProviderFailureTurnItem`, `makeProviderRetryTurnItem`) | all | `provider-core/src/server/failure.ts:203-317` |
| Id derivation from native ids (`IdAllocator.derive.*`) | all | `provider-core/src/server/IdAllocator.ts:126-254` |
| Selection transition helpers | Codex, Claude (turn scoped), ACP | `selectionTransition.ts:15-32` |
| Usage-window merge, unavailable states | Codex, Claude, Grok, others | `provider-core/src/server/usageLimits.ts` |
| Continuation queue for self-started turns | Codex, Claude, ACP | `ProviderContinuationRequests.ts` |
| Subagent projection helpers | Codex, Claude, ACP flavors | `provider-core/src/server/subagentProjection.ts` (426 lines, not read) |
| Attachment-to-prompt text, handoff budget | all | `provider-core/src/server/attachmentPrompt.ts`, `handoffBudget.ts` |
| Text delta coalescer (50 ms flush, `append/complete/flushTurn`) | Codex and Claude only; **ACP has its own copy** (`adapter.ts:143`) | `apps/server/.../Adapters/ProviderTextDeltaCoalescer.ts:14-155` |
| Native protocol logging with 64 KiB payload budget and token-delta filter | all | `provider-core/src/server/nativeProtocolLogging.ts`, `docs/internals/providers.md:146-155` |
| Retry policy | No adapter-level backoff. Start failures retry through the effect outbox (5 attempts); provider-side retries are reported as `ProviderRetry` items. | `EffectWorker.ts:593`, `failure.ts:269-317` |
| Replay test harness (scripted fake agent, transcript fixtures per scenario) | all | `apps/server/src/orchestration-v2/testkit/`, `scripts/acp-replay-agent.ts`, `contracts orchestrationV2.ts:3623-3667`, `docs/internals/adding-a-provider.md:53-68` |

Takeaway: the cross-provider normalization work is not in shared helpers, it is repeated in each adapter. The three big adapters
(7.5k, 10.5k, 8.5k lines) do the same jobs: id derivation, item ordinals, delta coalescing, terminal-status synthesis,
approval Deferreds, background-work tracking. A plugin contract that makes those the host's job shrinks every plugin.

---------------------------------------------------------------------------------------------------

## 3. ACP essentials

Source: agentclientprotocol.com (overview, prompt-turn, session-setup, tool-calls), cross-checked against T3's client in
`packages/provider-acp` and `packages/effect-acp`. ACP is JSON-RPC 2.0; agents "typically run as subprocesses of the Client"
(overview). T3 speaks it over child stdio, NDJSON (`ACP_PROTOCOL = "acp.ndjson-jsonrpc"`, `adapter.ts:127`). One process per session.

Methods the client calls on the agent:
- `initialize` (versions, capabilities); `authenticate` (only if needed).
- `session/new{cwd, mcpServers}` -> `{sessionId, configOptions?, modes?, models?}` (T3: `AcpSessionRuntime.ts:2210-2223`).
- `session/load{sessionId, cwd, mcpServers}`: requires `agentCapabilities.loadSession`; agent must replay the full conversation as
  `session/update` notifications (`user_message_chunk`, `agent_message_chunk`, ...), then returns an empty result.
- `session/resume`: requires `sessionCapabilities.resume`; same params; agent must NOT replay history.
- `session/close`, `session/list`, `session/fork`, `session/delete`: optional session capabilities (T3 wraps them, `AcpSessionRuntime.ts:2436-2502`).
- `session/prompt{sessionId, prompt: ContentBlock[]}`: the response is the turn terminal and carries `stopReason`:
  `end_turn | max_tokens | max_turn_requests | refusal | cancelled`. Content types are limited to the negotiated `promptCapabilities`.
- `session/cancel{sessionId}`: a notification. Client SHOULD mark unfinished tool calls cancelled and MUST answer pending
  `session/request_permission` with outcome `cancelled`. Agent SHOULD stop LLM requests and tools, MAY still send updates, and MUST then
  answer the original prompt with `cancelled` (not an error).
- `session/set_mode`, `session/set_config_option`, `session/set_model` (T3: `AcpSessionRuntime.ts:2048, 2638-2670`).

Methods the agent calls on the client: `session/request_permission`; `fs/read_text_file`, `fs/write_text_file` (gated by client `fs` capabilities);
`terminal/create|output|wait_for_exit|kill|release` (gated by `terminal`); `elicitation/create`.

`session/update` notification kinds (`params.update.sessionUpdate`): `user_message_chunk`, `agent_message_chunk` (optional `messageId`;
same id = same message), `agent_thought_chunk`, `tool_call` (`toolCallId,title,kind,status`), `tool_call_update`, `plan` (`entries[{content,priority,status}]`),
`available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update{used,size,cost?}`, and (v2 preview) `notice`,
`compaction_update`, `compaction_summary_chunk`. Tool `kind`: `read|edit|delete|move|search|execute|think|fetch|switch_mode|other`; status
`pending|in_progress|completed|failed`; content `content|diff{path,oldText,newText}|terminal{terminalId}`.

`session/request_permission` params: `{sessionId, toolCall:{toolCallId,...}, options:[{optionId,name,kind}]}`, `kind` in
`allow_once|allow_always|reject_once|reject_always`. Result: `{outcome:{outcome:"selected",optionId}}` or `{outcome:{outcome:"cancelled"}}`.

How T3 maps it:
| ACP | T3 | Where |
|---|---|---|
| `session/update` -> parsed events `ModeChanged, AvailableCommandsUpdated, ConfigOptionsUpdated, AssistantItemStarted/Completed, PlanUpdated, ToolCallUpdated, ContentDelta, ThoughtDelta, UsageUpdated, SessionInfoUpdated, UnknownUpdate` | then to `message.updated` / `turn_item.updated` (assistant_message, reasoning, command_execution, file_change, ...) with a 50 ms text flush | `runtimeModel.ts:241-300, 1359-1615`; `adapter.ts:143` |
| `agent_message_chunk` | assistant text delta, segmented by `messageId` | `runtimeModel.ts:1503-1514` |
| `tool_call` / `tool_call_update` | tool item; kind decides command/file/search item; merged state with emission throttling | `runtimeModel.ts:798-807`, `AcpSessionRuntime.ts:2768-2780` |
| `plan` / `plan_update` / `plan_removed` | `plan.updated` todo list | `runtimeModel.ts:1399-1476` |
| `usage_update`, `state_update` idle with usage | thread token usage snapshot (+ cost) | `runtimeModel.ts:1566-1588` |
| `session_info_update` | thread native metadata (title, updatedAt) | `runtimeModel.ts:1589-1601` |
| prompt response `stopReason` | `turn.terminal` (see 2.3 for the lossy mapping) | `adapter.ts:7569-7602` |
| `request_permission` | `approval_request` item + `runtime_request.updated`; T3 first applies its own disposition (allow/ask/deny) from runtime mode, only "ask" reaches the user | `adapter.ts:5990-6125` |
| load replay | `readThreadSnapshot` rebuilds messages; live handlers are gated while replaying | `adapter.ts:8259-8331`, `AcpSessionRuntime.ts:1936-2006` |
| capabilities | negotiated from `initialize`: `loadSession` -> can read snapshot; `sessionCapabilities.fork` -> can fork; presence of a model config option -> can switch model | `adapter.ts:568-600` |

ACP gaps that matter for a Console plugin: no standard steer; no standard usage-limit or rate-limit signal; no standard subagent lineage
(`docs/user/providers-acp.md`: "ACP has no portable native subagent-lineage contract"); no conversation truncation (rollback = new session);
no standard background-task notion; options (model, effort, mode) are discovered at runtime after the session exists; permission policy is the
client's job; image support is advertised but not always truthful.

---------------------------------------------------------------------------------------------------

## 4. Claude Agent SDK essentials

Sources: code.claude.com docs (overview, streaming-vs-single-mode, sessions, permissions, typescript reference) and T3's runner.

Process model (correcting the assumption in the assignment). The docs call the SDK "A library that runs the Claude Code binary"
(overview). It is a TypeScript library in your process that spawns the Claude Code CLI as a child process and speaks a control protocol over its
stdio. T3 confirms it: `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess`, process-group wrapper, `query.close()` "terminates the underlying
process" (typescript reference). So Claude is a per-session process like ACP, with a nicer typed API.

`query()` (T3: `ClaudeAgentSdkQueryRunner.open`, `ClaudeAdapterV2.ts:896-1135`):
- `query({prompt, options})` returns `Query`, an `AsyncGenerator<SDKMessage>` plus control methods. In **streaming input mode** `prompt` is an
  `AsyncIterable<SDKUserMessage>`; this is required for images, queued messages, interrupts, `setPermissionMode`, `setModel`, `streamInput`
  (streaming-vs-single-mode, typescript reference notes). T3 backs the iterable with an unbounded queue and `offer()` pushes into it (`:910-916, 1023-1036`).
- `Query` methods: `interrupt()`, `setPermissionMode()`, `setModel()`, `applyFlagSettings()` (TS only), `initializationResult()`, `supportedModels()`,
  `supportedCommands()`, `accountInfo()`, `getContextUsage()`, `mcpServerStatus()`, `setMcpServers()`, `streamInput()`, `stopTask()`,
  `backgroundTasks()`, `rewindFiles()`, `close()`. `interrupt()` may return a receipt `still_queued|cancelled` on CLIs advertising `interrupt_receipt_v1`.
- Sessions: `sessionId` (choose the UUID up front) or `resume: <id>` (+ `forkSession`, `resumeSessionAt`, `continue`). The id is also on the init system
  message and every result message (sessions doc). `persistSession:false` disables transcript writes.
- Messages: `system` (init, status, task_*), `assistant`, `user`, `stream_event` (needs `includePartialMessages:true`), `result` (`subtype`, `is_error`,
  `session_id`, usage/cost, `terminal_reason`, `api_error_status`), `rate_limit_event`. T3 handles all of these in `handleSdkMessage` (`:8672`).
- Permissions: evaluated in this order: hooks -> deny rules -> ask rules -> permission mode -> allow rules -> `canUseTool` (permissions doc).
  Modes: `default | dontAsk | acceptEdits | bypassPermissions | plan | auto`. `canUseTool(toolName, input, {signal, suggestions, toolUseID, agentID,
  requestId, ...}) => Promise<PermissionResult|null>`, where the result is `{behavior:"allow", updatedInput?, updatedPermissions?}` or `{behavior:"deny", message}`.
  Auto-approved tools never reach the callback; `AskUserQuestion` always does. Hooks run before everything and a hook deny wins even under `bypassPermissions`.
- Not all docs facts were fetchable: the `SDKUserMessage.priority` field is not in the pages I got, but T3 relies on it (`priority:"now"`, `ClaudeAdapterV2.ts:1832, 9915`)
  with SDK `^0.3.276` (`apps/server/package.json:35`). Treat it as undocumented until checked against the installed SDK types.

T3's mapping (`ClaudeAdapterV2.ts`):
| Console/T3 concept | Claude SDK | Line |
|---|---|---|
| open | build `Options` (model, tools preset `claude_code`, permissionMode, `includePartialMessages`, `effort`, `thinking`, `sessionId`/`resume`, `canUseTool`, `onUserDialog`, `env`, binary path) and call `query()` lazily on first turn | `:1285-1400, 9167-9330` |
| prompt | `query.offer(SDKUserMessage)` | `:9591` |
| steer | `offer({priority:"now"})` | `:9915-9938` |
| interrupt | `query.interrupt()` + `query.close()` | `:9777-9778` |
| approval | `canUseTool` returns a Promise that T3 resolves from `respondToRuntimeRequest`; `allow` may include `updatedPermissions` for "for session" | `:8807-9045, 2898-2938` |
| question | `AskUserQuestion` tool input -> `user_input_request`; answers returned as updated input | `:8865-8930, 3693` |
| plan | `ExitPlanMode` -> `proposed_plan` | `:8931-8990` |
| model/effort | `setModel`, `applyFlagSettings` live, else new query | `:9199-9252` |
| permission mode | `setPermissionMode`; initial from `permissionModeForClaudeRuntimePolicy` | `:2036-2083, 9222-9238` |
| usage | `rate_limit_event`, result `api_error_status`, probe `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` | `:7444-7500`, `ClaudeProvider.ts:392` |
| list models/commands/account | `initializationResult()` with a never-yielding prompt, so no API call is made | `ClaudeProvider.ts:343-431` |
| history | SDK `getSessionMessages(sessionId,{dir})` and `getSubagentMessages` exist; T3 uses them for fork heads and workflow members only | `:1188, 1220` |

Transcripts: SDK sessions write the normal Claude Code transcript. Docs: "Claude Code stores sessions under
`~/.claude/projects/<encoded-cwd>/*.jsonl`. If you set the `CLAUDE_CONFIG_DIR` environment variable, look under `$CLAUDE_CONFIG_DIR/projects/` instead."
(sessions doc). Resume works from any directory on the same machine (Claude Code 2.1.223 and later; older CLIs scope the lookup to the project directory). Because the SDK runs the Claude Code binary, these are ordinary Claude Code sessions. So Console's existing Claude
transcript parser/indexer keeps working for SDK-driven conversations, subject to flush latency (T3 notes ~100 ms, `ClaudeAdapterV2.ts:309`) and to
not setting `persistSession:false`.

Terms and branding (quote, not interpretation). Overview page, verbatim:
> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."

Same page, branding: allowed names are "Claude Agent", "Claude" (inside a menu already labeled "Agents"), "{YourAgentName} Powered by Claude"; "Not permitted:
'Claude Code' or 'Claude Code Agent'"; and "Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product."
License: use "is governed by Anthropic's Commercial Terms of Service".
How T3 handles it: it uses the CLI's own login and says so (`docs/user/providers-claude.md:3-4`: "T3 Code uses Claude Code's login and configuration"), and offers
API-key/router setups through env vars. I did not find any T3 text interpreting the clause. Whether a single-user local tool that reuses the user's own
Claude Code login is "offering claude.ai login" is a judgment for Bryan; I am only flagging that the clause exists. Its wording covers "their products, including agents built on the Claude Agent SDK", so it is not limited to the SDK and
may equally bear on the CLI-in-tmux path Console uses today. Product label for the Claude plugin should be "Claude" or "Claude Agent", not "Claude Code".

---------------------------------------------------------------------------------------------------

## 5. Proposed minimal plugin interface for Console (sketch)

Design rules taken from T3's evidence:
1. Three levels, as in T3: plugin (static) -> instance (one account/binary/home, health) -> session (process-bound). Console's existing
   `ProviderAdapter` (`apps/server/src/providers/types.ts:76-93`) is a transcript reader + tmux launch-command builder. The transport plugin is a
   second, separate seam; it must not absorb transcript parsing (Console keeps raw screen, live events and provider transcripts as separate surfaces).
2. The host, not the plugin, decides process sharing from `processModel` (T3 `Orchestrator.ts:962-980`), and owns idle release, recovery, queueing,
   steer-vs-queue-vs-restart, redaction, id/ordinal bookkeeping and exactly-once terminal guarding. Plugins translate protocol to events.
3. Capabilities are flags the host reads; the host never branches on plugin id.
4. Native ids can be server-allocated (Codex, ACP) or client-allocated (Claude), and sessions can start a turn on their own (goals, wake reports,
   background task completion), so `turn.started` must be allowed without a `sendTurn`.
5. Effort, mode, service tier are model "options" described by descriptors, not fixed fields (T3 `model.ts:7-44`).

```ts
// apps/server/src/providers/transport/types.ts  (sketch; names are proposals)
export type TurnStatus = 'completed' | 'interrupted' | 'cancelled' | 'failed';
export interface ProviderFailure {            // T3 contracts orchestrationV2.ts:1240-1265
  class: 'usage_limit' | 'provider_error' | 'transport_error' | 'permission_error' | 'validation_error' | 'unknown';
  message: string; code?: string; retryable?: boolean; resetAt?: string;   // message redacted by the host
}
export interface OptionDescriptor { id: string; label: string; type: 'select' | 'boolean';
  choices?: { id: string; label: string; isDefault?: boolean }[]; }
export interface ModelInfo { id: string; label: string; isDefault?: boolean; options: OptionDescriptor[]; contextWindow?: number; }
export interface Selection { model: string; options: Record<string, string | boolean>; }   // effort lives in options
export interface UsageWindow { id: string; kind: 'session' | 'weekly' | 'monthly' | 'other'; usedPercent: number; resetsAt?: string; }

export interface TransportCapabilities {            // flags only; negotiated values are re-read from session.capabilities
  processModel: 'shared' | 'per-session';
  nativeIds: 'server-allocated' | 'client-allocated';
  resume: 'reattach' | 'replay' | 'none';           // Codex thread/resume, Claude resume:, ACP session/resume | session/load
  steer: 'native' | 'native-cancels-tools' | 'none';
  interrupt: 'terminal-follows' | 'ends-process';   // Codex/ACP vs Claude
  images: boolean;
  enforcement: 'native' | 'host';                   // ACP = host (T3 'client-boundary')
  approvals: ApprovalKind[]; questions: 'blocking' | 'message' | 'both' | 'none';
  modelSwitch: 'next-turn' | 'restart' | 'none';
  limits: 'push' | 'poll' | 'on-failure-only';
}
export type ApprovalKind = 'command' | 'file-read' | 'file-change' | 'mcp' | 'permission';

export interface PendingRequest {
  requestId: string; turnId?: string; response: 'live' | 'message';   // 'message' = answer is sent as a normal user message
  approval?: { kind: ApprovalKind; prompt?: string; options: { optionId: string; decision: Decision; label: string }[] };  // native option ids pass through
  questions?: { id: string; header: string; question: string; options: { label: string; description?: string }[]; multi?: boolean; custom?: boolean }[];
}
export type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export type TransportEvent =
  | { t: 'session.state'; state: 'starting' | 'ready' | 'running' | 'waiting' | 'stopped' | 'error'; failure?: ProviderFailure }
  | { t: 'session.native'; nativeSessionId: string; title?: string }                 // id learned or metadata changed
  | { t: 'turn.started'; turnId: string; origin: 'user' | 'provider'; nativeTurnId?: string }
  | { t: 'message.delta'; turnId: string; itemId: string; channel: 'assistant' | 'reasoning' | 'plan'; text: string }
  | { t: 'message.completed'; turnId: string; itemId: string; channel: 'assistant' | 'reasoning' | 'plan'; text?: string }
  | { t: 'tool.updated'; turnId: string; itemId: string; kind: 'command' | 'file_change' | 'file_read' | 'search' | 'web' | 'mcp' | 'other';
      status: 'running' | 'completed' | 'failed' | 'declined'; title?: string; input?: unknown; output?: string; exitCode?: number }
  | { t: 'plan.updated'; turnId: string; steps: { id: string; text: string; status: 'pending' | 'running' | 'completed' }[] }
  | { t: 'request.opened'; request: PendingRequest } | { t: 'request.closed'; requestId: string; outcome: 'resolved' | 'cancelled' | 'expired' }
  | { t: 'usage.context'; turnId?: string; usedTokens: number; maxTokens?: number; costUsd?: number }
  | { t: 'limits.updated'; windows: UsageWindow[] }                                  // sparse; host merges by window id
  | { t: 'retry'; turnId: string; failure: ProviderFailure; attempt: number; maxAttempts?: number }
  | { t: 'notice'; level: 'info' | 'warn'; text: string }
  | { t: 'turn.terminal'; turnId: string; status: TurnStatus; stopReason?: string; failure?: ProviderFailure; sessionUsable: boolean };

export interface TurnInput { text: string; images?: { mimeType: string; path: string }[]; selection: Selection; plan?: boolean; }
export interface OpenOptions { conversationId: string; cwd: string; selection: Selection;
  policy: { runtimeMode: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'; plan: boolean };
  mcpServers?: McpServerSpec[]; env?: Record<string, string>; }

export interface TransportSession {
  readonly nativeSessionId: string | undefined;          // Claude: known at once; Codex/ACP: after start
  readonly capabilities: TransportCapabilities;          // post-negotiation (ACP loadSession, image, fork)
  readonly events: AsyncIterable<TransportEvent>;        // single consumer; ends after session.state 'stopped'
  sendTurn(input: TurnInput): Promise<{ turnId: string }>;       // rejects previous_turn_active; host queues, not the plugin
  steer?(turnId: string, input: TurnInput): Promise<void>;       // present only if capabilities.steer !== 'none'
  interrupt(turnId: string): Promise<void>;                      // resolves after turn.terminal or forced teardown
  respond(requestId: string, r: { optionId?: string; decision?: Decision; answers?: Record<string, unknown> }): Promise<void>;
  setSelection?(s: Selection): Promise<'applied' | 'next-turn' | 'needs-restart'>;
  hasBackgroundWork?(): Promise<boolean>;                        // pins the session against idle release
  close(reason: 'idle' | 'shutdown' | 'error'): Promise<void>;
}
export interface TransportInstance {
  probe(): Promise<{ installed: boolean; version?: string; auth: 'ok' | 'missing' | 'unknown'; models: ModelInfo[]; limits?: UsageWindow[] }>; // never opens a session
  start(o: OpenOptions): Promise<TransportSession>;
  resume(nativeSessionId: string, o: OpenOptions): Promise<TransportSession>;  // may throw ResumeFailed; host falls back to start + history handoff
  readHistory?(nativeSessionId: string, o: { cwd: string }): Promise<HistoryItem[]>;  // optional; host prefers its transcript parsers
  dispose(): Promise<void>;
}
export interface TransportPlugin<Config> {
  id: string; configSchema: unknown; compat?: { range: string; status: 'supported' | 'unsupported' | 'broken' }[];
  create(cfg: Config, ctx: PluginContext): Promise<TransportInstance>;   // ctx.spawn() applies process-group/cgroup containment, env scrubbing, logging
}
```

Event notes: `message.delta` carries text deltas only; the host owns coalescing (50 ms) and final text assembly. `turn.terminal` must fire exactly once per turn
(host guards; T3 `RunExecutionService.ts:1435-1452` treats a missing terminal as an error). `sessionUsable:false` is T3's `threadDisposition:"broken"`
(`ProviderAdapter.ts:154,167`). `limits.updated` and `failure.class="usage_limit"` with `resetAt` feed the same auto-resume logic as T3's
`UsageLimitRecoveryWorker.ts:11-72`. `session.state` and `notice` events must never count as recency (Console AGENTS.md recency rule), unlike T3 where any event bumps the idle timer.

### 5.1 What each protocol satisfies natively, and what the host must emulate

| Plugin capability | Codex app-server | Claude Agent SDK | ACP (generic) | Host emulation / policy |
|---|---|---|---|---|
| start | `initialize` once per process, then `thread/start` | allocate UUID, first `query({sessionId})` lazily | `initialize`, `authenticate?`, `session/new` | none |
| resume | native `thread/resume` | native `resume: id` (fails if transcript empty) | `session/load` (replays history, must be suppressed) or `session/resume`, only if the agent advertises them | On `ResumeFailed`: start fresh + inject history (T3 `ProviderTurnStartService.ts:768-800`); Codex `inject_items` natively, others as prompt prefix (`:1204-1242`) |
| send turn | `turn/start` | `offer(SDKUserMessage)` | `session/prompt` (response = terminal) | host serializes: one live turn per session |
| steer | native `turn/steer` | `offer({priority:"now"})`, cancels running tools | **none** | `steer:'none'` -> host runs `interrupt` then `sendTurn` with the new text (T3 `restart_active`, `CommandPolicy.ts:196-199`). For `native-cancels-tools` show the user a warning |
| queue | none needed | SDK queues sequentially in streaming mode, but T3 does not rely on it | none | host-owned queue for all (T3 sets `supportsQueuedMessages:true` everywhere, `CommandPolicy.ts:273-282`) |
| interrupt | `turn/interrupt`, terminal arrives later as `interrupted` | `interrupt()` then `close()`: the process ends, next turn must `resume` | `session/cancel` notification, prompt returns `cancelled`; some agents need a process kill | plugin guarantees a `turn.terminal` or process death within a deadline (T3: Claude 10 s, ACP-waiting 15 s); host respawns lazily |
| approvals | server requests, native policy | `canUseTool` callback, native `permissionMode` | `session/request_permission`, **policy must be host-enforced** | `enforcement:'host'` -> host decides allow/ask/deny before raising `request.opened` (T3 `clientPolicy.ts`); always keep a decline option the provider honors |
| questions | blocking RPC or notification answered by message | `AskUserQuestion` via `canUseTool` | elicitation / agent specific / none | `response:'message'` requests survive restart; `live` ones expire (`not_resumable`) |
| model / effort | `model/list`; per-turn `model` + `effort` | bundled manifest (+ SDK `supportedModels()` exists, T3 did not use it for catalog); live `setModel` or reopen | discovered in `configOptions` after the session exists; set via `session/set_config_option` / `set_model` | `setSelection` returns `needs-restart` -> host restarts and resumes; do not write options before the agent advertises them (`adding-a-provider.md:75-79`); "default" is a sentinel, never sent |
| usage limits | push `account/rateLimits/updated` + poll; failure class from `codexErrorInfo` | push `rate_limit_event`; result `api_error_status 429`; probe (experimental API) | no standard; per-agent codes (Vibe -31001, Grok -32003) | agent hook `classifyFailure()`; without `resetAt` the host must not auto-resume |
| terminal quality | strong (`turn/completed`) | strong (`result`) but interrupt kills query | `stopReason` only. T3 maps every reason except `cancelled` to `completed` (lossy); Console should surface `refusal`, `max_tokens`, `max_turn_requests` | host maps `stopReason` |
| history | `thread/read` exists | disk transcript (`~/.claude/projects`) | `session/load` replay only | Console transcript parsers for Codex and Claude; ACP: persist live events as the transcript (providers differ on replay) |
| images | data URL | base64 block, streaming input only | only if `promptCapabilities.image` (Grok lies in both directions) | host falls back to file path in prompt text (T3 `attachmentPrompt.ts`) when unsupported |
| autonomous turns | goals, background terminals, subagents | wake reports after background tasks | agent specific (Grok post-settle) | plugin emits `turn.started{origin:'provider'}`; `hasBackgroundWork()` blocks idle release |
| health | spawn + `initialize` + `model/list` + `account/rateLimits/read` | `initializationResult()` on a never-yielding prompt | `initialize` only | probes must not start MCP servers, hooks or login |

### 5.2 Host services the plugin interface assumes (so plugins stay small)

1. `SessionPool`: per-instance process refcount for `shared`, one process per conversation for `per-session`; idle timer (T3 default 30 min), pin while
   `hasBackgroundWork()`, 4 h pin cap, restart recovery. Console's rule "one conversation = one hidden tmux session" becomes "one conversation = one native session id";
   the process owner changes, not the conversation identity.
2. `EventNormalizer`: id/ordinal derivation, 50 ms delta coalescing, exactly-once terminal, failure redaction (T3 `failure.ts:145-230`), request lifecycle
   cleanup on any terminal (`ProviderEventIngestor.ts:585-593`).
3. `DispatchPolicy`: steer / queue / interrupt-restart choice from capabilities (T3 `CommandPolicy.ts:150-200`).
4. `PolicyEngine`: maps Console runtime mode to each plugin's native policy or enforces it itself.
5. `SpawnService`: process-group/cgroup containment and kill on dispose. This host is memory-constrained and shared, so leaking agent processes is the main
   operational risk (T3 spends about 900 lines on ACP process ownership, `AcpSessionRuntime.ts:168-1085`).
6. `ReplayHarness`: scripted fake agent per protocol with recorded transcripts per scenario (`simple, multi_turn, queued_turn, turn_interrupt,
   message_steering, provider_thread_resume, tool_call_*`; `docs/internals/adding-a-provider.md:53-68`). Without this, the contract drifts toward whichever
   protocol was built first.

---------------------------------------------------------------------------------------------------

## 6. Pitfalls T3 hit more than once (from `docs/internals/adding-a-provider.md:70-102`) mapped to this contract

- Settings applied before the provider advertises them (ACP effort). Wait for the option, skip a stored option the live session does not offer.
- "Default" model is a sentinel, not a model; a default selection must switch the session back after a named model ran, even on resume.
- Stop sent before the turn started can be ignored or leave an unsaved session. Use the provider's own turn-started signal; test Stop right after send.
- Provider-started work (background commands, subagents, goals) can finish or start a turn after yours settled. Offer a continuation and report
  `hasBackgroundWork` so the session is not released.
- A failed or stopped turn leaves nothing open: settle tool calls, subagents, pending approvals and questions on every terminal path
  (completion, Stop, provider failure, process exit).
- Usage limits are not generic failures: class `usage_limit` + reset time so the conversation shows Limited and can resume.
- Paths and environment: test a symlinked workspace; scrub inherited credentials the instance did not configure; unknown sign-in is "unknown", not "signed in".
- Do not imitate a permission mode the provider lacks by answering approvals in the host. Offer only modes the provider enforces natively
  (`adding-a-provider.md:28-33`), except ACP where the client boundary is the only enforcement point and T3 labels it so (`runtimePolicy.enforcement`).

## 7. Open decisions for Bryan (not decided here)

1. Claude path. Options: keep the tmux CLI for Claude and use the transport plugin only for Codex/ACP; or add an SDK plugin. The SDK still spawns the CLI, writes the same
   transcripts, and gives typed interrupt/steer/approvals; but the overview page restricts third-party offering of claude.ai login (quoted in section 4) and forbids "Claude Code"
   branding. This needs your reading of the clause for a single-user local tool.
2. Event granularity. T3's adapters emit full-state upserts (hence 7-10k line adapters). The sketch above uses deltas plus a host normalizer. If Console wants
   to feed its existing event-log normalization path, the delta shape fits better; confirm before building Codex against it.
3. Whether the first plugin is validated against a second protocol before it ships. Cheapest check: run the Codex plugin and a scripted ACP fake agent through the same
   host tests (`ReplayHarness`) so no field in the contract exists only because Codex has it.
4. T3 is MIT. If any code is copied rather than re-derived, the license text and copyright notice must travel with it (`T3/LICENSE`).
5. ACP `stopReason` handling and usage-limit classification are per-agent; decide whether Console ships a generic ACP plugin plus a short per-agent flavor list (T3's choice) or one plugin per agent.

---------------------------------------------------------------------------------------------------

## 8. Ten-line summary

1. T3's contract is `ProviderAdapterV2.openSession -> SessionRuntime` (`provider-core/.../ProviderAdapter.ts:550-662`): ensure/resume thread, start/steer/interrupt turn, respond to request, snapshot/rollback/fork, one event Stream.
2. The orchestrator reads a 12-group capability record, never the driver name; steer vs queue vs restart is a pure function of three flags (`CommandPolicy.ts:150-200`).
3. Events are state upserts (message, turn item, node, request, plan) plus one `turn.terminal` (completed/interrupted/cancelled/failed with `ProviderFailure{class, resetAt}` and `threadDisposition`); only the root turn's terminal closes a run.
4. Process sharing is derived from `supportsMultipleProviderThreadsPerSession`: Codex and OpenCode 2.x share one process per instance, Claude and ACP use one per conversation; idle release is 30 min, pinned while background work runs, capped at 4 h.
5. After a server restart no provider process survives; runs are terminalized, live requests expire, and a "Continue where you left off." run resumes the native session; resume failure falls back to a fresh session plus a history handoff.
6. Codex: shared JSON-RPC process, native steer (`turn/steer`), approvals as server requests, push+poll rate limits. Claude: per-conversation CLI child behind `query()`, steer via `priority:"now"` (cancels tools), interrupt ends the process, `canUseTool` for approvals and questions, normal `~/.claude/projects` transcripts. ACP: per-session stdio, no steer, no usage-limit signal, client-enforced permissions, and about 40 per-agent flavor hooks.
7. The Claude Agent SDK is not in-process: it runs the Claude Code binary. Overview page, verbatim: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Branding bars "Claude Code".
8. Shared code is thinner than it looks: failure redaction, id derivation and usage-window merge are shared, but delta coalescing, ordinals, approval Deferreds and terminal synthesis are re-done per adapter (ACP even copies the coalescer).
9. Proposed Console seam (section 5): plugin -> instance (`probe/start/resume/readHistory`) -> session (`sendTurn/steer?/interrupt/respond/setSelection?/hasBackgroundWork?/close`, delta `TransportEvent` stream, capability flags) with a host that owns pooling, queueing, dispatch policy, normalization and spawn containment.
10. Emulate in the host: queue (all), steer for ACP (interrupt + new turn), host-side permission enforcement for ACP, history handoff on resume failure, stopReason/usage-limit mapping; Console's transcript parsers cover history for Codex and Claude.
