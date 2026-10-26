# Codex `app-server` protocol brief and T3 Code reuse assessment

Date: 2026-10-25. Installed CLI: `codex-cli 0.164.0`. T3 reference: `/home/bryan/code/UberCoder/t3code-ref` at tag `v0.1.2` (commit 044f0725, MIT, "Copyright (c) 2026 T3 Tools Inc.").

## Evidence legend and paths

- **Live**: observed in my throwaway handshake against the installed 0.164.0 binary. Script `appserver/handshake.mjs`; output `appserver/handshake.out.txt` (final run) and `appserver/handshake.run1.out.txt` (first run, with the full unknown-method list). No `thread/start`, `turn/start` or `thread/resume` was sent. No model call was made.
- **Bindings**: `appserver/ts/**` and `appserver/schema/**`, generated for 0.164.0. **They were generated without `--experimental`.** They describe the 109 stable client methods. The live server accepts 178 methods. The 69-method difference is in `appserver/methods.live.txt` minus `appserver/methods.stable.txt`. Experimental fields such as `turn/start.collaborationMode`, `turn/start.additionalContext` and `thread/start.historyMode/dynamicTools/permissions` are also missing from these bindings. For implementation, regenerate with `codex app-server generate-ts --experimental --out ...`.
- **Docs**: `https://developers.openai.com/codex/app-server` returns a 308 redirect to `https://learn.chatgpt.com/docs/app-server`, which I could reach. I saved the Markdown copies as `docs-dl/app-server.md` and `docs-dl/hooks.md`, and I cite them by line. Where the docs and the bindings disagree, I state it. The bindings win.
- **Source**: Rust files fetched read-only from `github.com/openai/codex` (main) into `codex-src/`. They are the current main branch, which may be newer than 0.164.0.
- **T3**: paths are relative to `t3code-ref/`. "Fixture" means T3's recorded wire transcripts at `apps/server/src/orchestration-v2/testkit/fixtures/<scenario>/codex_transcript.ndjson`, recorded against **codex 0.156.1**. There are 29 Codex scenarios, which give real thread, turn and item traces without spending quota. `appserver/fx.py <fixture> [width]` prints one compactly.

Fixture "entry N" means the 0-based line number in the `.ndjson` file, as `fx.py` prints it. All relative paths above start at the scratchpad directory `docs/research/codex-app-server-2026-10-26/`.

---

## 1. Transport and handshake

### How to start the server
`codex app-server --help` shows the following.
- The server is started as `codex app-server [OPTIONS]`. The default transport is `--listen stdio://`, which uses newline-delimited JSON on stdin and stdout.
- Other `--listen` values:
  - `unix://` uses the default control socket at `~/.codex/app-server-control/app-server-control.sock`. `unix://PATH` uses a custom socket. Both are WebSocket over an HTTP Upgrade.
  - `ws://IP:PORT` is marked "experimental and unsupported". It also serves `GET /readyz` and `GET /healthz`. It has the auth flags `--ws-auth capability-token|signed-bearer-token`, `--ws-token-file`, `--ws-token-sha256`, `--ws-shared-secret-file`, `--ws-issuer`, `--ws-audience` and `--ws-max-clock-skew-seconds`.
  - `off`.
- Other options:
  - `-c key=value` overrides config (TOML value).
  - `--enable` and `--disable FEATURE`.
  - `--strict-config`.
  - `--print-startup-config` validates config and prints its requirements without starting.
  - `--startup-client-info JSON`.
  - `--code-mode-host URL`. By default the server starts a local `codex-code-mode-host` child, which all threads in the process share (docs lines 39-56).
  - `--analytics-default-enabled`. Analytics are off by default for app-server.
- Overload: in WebSocket mode the bounded ingress queue rejects requests with `-32001 "Server overloaded; retry later."`. Retry with exponential backoff and jitter (docs lines 100-104).

### `daemon` and `proxy`
- `codex app-server daemon {bootstrap|start|restart|update|enable-remote-control|disable-remote-control|stop|version}` manages one long-lived local app-server per user, behind the control socket.
  - `bootstrap` is "durable local app-server management for SSH-driven use".
  - `update` "may interrupt running work".
- `codex app-server proxy [--sock PATH]` pipes stdio bytes to that control socket.
- The TUI itself is an app-server client:
  - `codex --remote ws://|wss://|unix://[PATH]` attaches the TUI to an app-server.
  - Source `codex-rs/tui/src/startup_orchestration.rs` resolves a remote or daemon app-server target through `codex_app_server_client`.
  - Without `--remote` the TUI runs its own embedded server, and spawns its own `codex-code-mode-host`. I saw this in `ps` for every running TUI.
- **Recommendation**: run one child `codex app-server` per Console over stdio. This matches the docs' own Node example (docs lines 142-192) and T3. The daemon is a shared, per-user singleton aimed at SSH and remote control, and its `update` can interrupt work. No daemon was running during the probe (no `codex app-server` process in `ps`), although `~/.codex/app-server-control/app-server-control.sock` exists as a symlink into `/tmp/codex-daemon-1000/`, left over from an earlier daemon.
- Optional (experimental): `--listen unix:///path/console.sock` would let a person attach a TUI to a Console-owned thread with `codex --remote unix:///path/console.sock resume <id>` for debugging.

### Framing and IDs (Live, Docs lines 57-140)
- Framing:
  - One JSON object per line.
  - There is no `"jsonrpc":"2.0"` field in either direction.
  - Notifications have extra top-level metadata: `{"method":..,"params":..,"emittedAtMs":<ms>}`. See `ts/ServerNotificationEnvelope.ts`; current servers always send it.
- IDs: `RequestId = string | number` (`ts/RequestId.ts`).
  - Server-to-client requests use **their own counter, starting at 0**. In fixture `tool_call_read_only_on_request` (entry 46), the server sends `{"method":"item/commandExecution/requestApproval","id":0,...}`.
  - So route each incoming message by its shape:
    - `method` and `id`: a server request.
    - `method` and no `id`: a notification.
    - `id` and `result` or `error`, no `method`: a response to one of our requests.
- Error codes:
  - Everything I triggered returned `-32600`, with these messages: `Not initialized`, `Already initialized`, `thread not found: <id>`, `thread not loaded: <id>`, and `Invalid request: unknown variant \`no/such/method\`, expected one of ...` (this last one lists all 178 live methods).
  - The docs also name `-32602` (invalid params, `thread/items/list` anchors) and `-32001` (overload).
  - T3 treats `-32601` as "older server without this method" (`CodexAdapterV2.ts:6781-6792`).

### Live handshake (exact JSON, `appserver/handshake.out.txt`)
```
>> {"id":0,"method":"model/list","params":{}}
<< {"error":{"code":-32600,"message":"Not initialized"},"id":0}
>> {"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent_console_probe","title":"Agent Console probe","version":"0.0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
<< {"id":1,"result":{"userAgent":"agent_console_probe/0.164.0 (Ubuntu 24.4.0; x86_64) tmux-256color (agent_console_probe; 0.0.1)","codexHome":"/home/bryan/.codex","platformFamily":"unix","platformOs":"linux"}}
<< {"method":"configWarning","params":{"summary":"Codex is ignoring 1 unrecognized configuration setting. ...`features.skills` is ignored.","details":null},"emittedAtMs":1792994626927}
<< {"method":"remoteControl/status/changed","params":{"status":"disabled","serverName":"bryan-SER","installationId":"468f3e6b-...","environmentId":null},"emittedAtMs":...}
<< {"method":"account/updated","params":{"authMode":"chatgpt","planType":"pro"},"emittedAtMs":...}
>> {"id":2,"method":"initialize","params":{"clientInfo":{"name":"agent_console_probe","title":null,"version":"0.0.1"},"capabilities":null}}
<< {"error":{"code":-32600,"message":"Already initialized"},"id":2}
>> {"method":"initialized"}
... read-only calls: model/list, account/read, thread/list, thread/loaded/list, hooks/list, config/read, thread/read, thread/turns/list, thread/items/list, account/rateLimits/read: all OK
>> (stdin closed)
   EXIT {"code":0,"signal":null}   about 20-40 ms after EOF
```
Findings from the handshake:
- **`initialize` comes first.** Any request before it gets `Not initialized`. A second `initialize` gets `Already initialized`; the server parsed `capabilities: null` without error. T3 treats that error as success after an interrupted handshake (`CodexAdapterV2.ts:1803-1832`).
- **`initialized` is a required notification**: `ClientNotification = {"method":"initialized"}` (`ts/ClientNotification.ts`). The docs require it (lines 211-214), and both the docs and T3 send it.
- **Notifications arrive before you send `initialized`.** `configWarning`, `remoteControl/status/changed` and `account/updated` arrived immediately after the `initialize` response, so the reader must be running before `initialize` is written. Nothing arrived before the `initialize` request.
- **stdin EOF ends the process cleanly (exit 0).** I tested this with no threads loaded. With threads loaded or a turn running: **UNVERIFIED**.
- **stderr carries `tracing` logs with ANSI colour codes**, including `ERROR`-level lines for harmless config warnings. It is never JSON-RPC, so treat it as diagnostics only (keep a ring buffer). T3 drains and discards it (`packages/effect-codex-app-server/src/client.ts:273`).
- **I saw no update check and no non-JSON stdout** in the roughly 5 s run. The app-server does refresh the model catalogue online at startup and writes `~/.codex/models_cache.json` (T3 comment, `provider/CodexProvider.ts:404-409`).
- **`userAgent` echoes `clientInfo.name`.** T3 parses the CLI version from `userAgent` (`CodexProvider.ts:526-527`).
- **`clientInfo.name` matters.** The docs say it identifies the client in OpenAI compliance logs (lines 220-222). T3 also sets the env var `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` (`CodexProvider.ts:449-454`), and notes that the backend tailors the model catalogue to the originator (`CodexProvider.ts:404-409`).
- **Capabilities** (`ts/InitializeCapabilities.ts`): `experimentalApi: boolean`, `requestAttestation: boolean`, `optOutNotificationMethods?: string[]` (exact names), `mcpServerOpenaiFormElicitation?`, `explicitGatewayOauth?` and `extensions?`. T3 sends `{experimentalApi:true, optOutNotificationMethods:["turn/diff/updated"], extensions:{"io.modelcontextprotocol/ui":{...}}}` (`CodexAdapterV2.ts:232-236`). Experimental methods or fields sent without opt-in fail with `<descriptor> requires experimentalApi capability` (docs lines 266-292).

---

## 2. Method catalogue (client to server)

The names and fields below come from `ts/ClientRequest.ts` and the `ts/v2/*Params.ts` and `*Response.ts` files. "(exp)" means experimental: it is absent from the stable bindings and needs `experimentalApi:true`.

### `thread/start`: `ThreadStartParams` → `ThreadStartResponse`
```ts
{ model?: string|null; modelProvider?: string|null; serviceTier?: string|null;
  cwd?: string|null;
  approvalPolicy?: "untrusted"|"on-request"|"never"|{granular:{sandbox_approval,rules,skill_approval,request_permissions,mcp_elicitations:boolean}}|null;
  approvalsReviewer?: "user"|"auto_review"|"guardian_subagent"|null;
  sandbox?: "read-only"|"workspace-write"|"danger-full-access"|null;   // kebab-case SandboxMode
  config?: {[dottedKey: string]: JsonValue}|null;                         // same as -c, dotted keys OK
  serviceName?: string|null; baseInstructions?: string|null; developerInstructions?: string|null;
  personality?: "none"|"friendly"|"pragmatic"|null /*deprecated*/;
  ephemeral?: boolean|null; sessionStartSource?: "startup"|"clear"|null; threadSource?: string|null;
  // (exp) historyMode, dynamicTools, permissions (profile id, do not combine with sandbox)
}
→ { thread: Thread; model: string; modelProvider: string; serviceTier: string|null; disabledPluginIds: string[];
    cwd: string; instructionSources: string[]; approvalPolicy; approvalsReviewer; sandbox: SandboxPolicy;
    reasoningEffort: string|null }
```
- **There is no reasoning-effort field on `thread/start` in 0.164 stable.** Set it through `config: {"model_reasoning_effort":"xhigh"}`, or per turn through `turn/start.effort`.
- The docs example uses `"sandbox":"workspaceWrite"` (docs line 499), but the bindings and the schema say kebab-case `SandboxMode`. Use the bindings. Whether the camelCase spelling is also accepted is **UNVERIFIED**.
- The response is followed by a `thread/started` notification. In the fixtures, `thread/started` can arrive *after* the client has already sent its first `turn/start` (fixture `simple`, entries 8-9), so do not block on it.
- If an MCP server marked `required` fails to start, `thread/start` and `thread/resume` fail (docs line 558).

### `thread/resume`: `ThreadResumeParams` → `ThreadResumeResponse`
```ts
{ threadId: string; model?; modelProvider?; serviceTier?; cwd?; approvalPolicy?; approvalsReviewer?; sandbox?;
  config?; baseInstructions?; developerInstructions?; personality?; excludeTurns?: boolean }
→ { thread: Thread; model; modelProvider; serviceTier; disabledPluginIds; cwd; instructionSources; approvalPolicy;
    approvalsReviewer; sandbox: SandboxPolicy; reasoningEffort; collaborationMode: CollaborationMode|null;
    turnsBackwardsCursor: string|null; itemsBackwardsCursor: string|null }
```
- Resume is **by `threadId` only**. There is no rollout-path parameter in 0.164.
- Use `excludeTurns: true`; returning full history is deprecated for paginated threads and emits `deprecationNotice`. Then page the history with the cursors and `sortDirection:"desc"` (docs lines 539-556).
- In the fixture, resume emits no `thread/started`. It does emit `thread/status/changed` → `idle`, and `thread/goal/cleared` on the next turn (fixture `provider_thread_resume`, entries 37-45).
- Resuming does not change `updatedAt`.
- Resuming with a different model than the one recorded triggers a warning and a one-time model-switch instruction (docs line 562).
- T3 resumes with `{threadId, excludeTurns:true, cwd, model, config}` (`CodexAdapterV2.ts:6672-6738`).

### Reading threads without loading them
- `thread/read {threadId, includeTurns?: boolean}` → `{thread: Thread}`.
  - Live: this works on a stored, unloaded thread, and `thread/loaded/list` stayed `[]` afterwards. Live output also had an extra `readState` field (exp).
  - For a fake id it returns `-32600 "thread not loaded: <id>"`.
- `thread/turns/list {threadId, cursor?, limit?, sortDirection?: "asc"|"desc", itemsView?: "notLoaded"|"summary"|"full"}` → `{data: Turn[], nextCursor, backwardsCursor}`.
  - The default order is newest first.
  - Live: `itemsView:"summary"` returned only the `userMessage` and the final `agentMessage` of each turn.
- `thread/items/list {threadId, turnId?, cursor?: string|{type:"item",itemId}, limit?, sortDirection?}` → `{data: ThreadItemEntry[], nextCursor, backwardsCursor}`.
  - `ThreadItemEntry = {turnId, item: ThreadItem, startedAtMs|null, completedAtMs|null}`.
  - The default order is oldest first.
  - Live: it returned full `commandExecution` items, including `aggregatedOutput`.
  - **This is the call to use to rebuild a display transcript after resume.**
- `thread/list {cursor?, limit?, sortKey?: "created_at"|"updated_at"|"recency_at", sortDirection?, modelProviders?, sourceKinds?, archived?, sectionId?, cwd?: string|string[], useStateDbOnly?, searchTerm?, excludedThreadIds?, originators?}` → `{data: Thread[], nextCursor, backwardsCursor}`.
  - Live output also included an extra `readStates` field (exp).
  - `sourceKinds` defaults to the interactive sources, `cli` and `vscode`. A relative `cwd` resolves against the app-server process's own cwd.
- `thread/loaded/list {cursor?, limit?}` → `{data: string[], nextCursor}`.

The `Thread` shape (`ts/v2/Thread.ts`):
```ts
{ id; sessionId; forkedFromId|null; parentThreadId|null; preview; ephemeral; section|null; sectionEnteredAt|null; projectId|null;
  historyMode: "legacy"|"paginated"; modelProvider; model|null; reasoningEffort|null; createdAt; updatedAt; recencyAt|null;  // unix seconds
  status: {type:"notLoaded"}|{type:"idle"}|{type:"systemError"}|{type:"active", activeFlags:("waitingOnApproval"|"waitingOnUserInput")[]};
  path: string|null /* rollout JSONL */; cwd; cliVersion; originator|null; source: SessionSource; threadSource|null;
  agentNickname|null; agentRole|null; gitInfo|null; name|null; turns: Turn[] }
```

### Other thread methods
| Method | Params → result | Notes |
|---|---|---|
| `thread/archive` / `thread/unarchive` | `{threadId}` → `{}` / `{thread}` | Moves the rollout JSONL to and from the archived folder; emits `thread/archived` and `thread/unarchived`. Resuming an archived thread fails with an error matching `/session \S+ is archived|codex unarchive/`; T3 then unarchives and retries (`CodexAdapterV2.ts:6690-6708`). |
| `thread/delete` | `{threadId}` → `{}` | Permanent; also deletes spawned descendants. |
| `thread/unsubscribe` | `{threadId}` → `{status:"unsubscribed"\|"notSubscribed"\|"notLoaded"}` | Once the last subscriber leaves, the thread unloads after 30 min with no activity, followed by `thread/status/changed`→`notLoaded` and `thread/closed` (docs lines 812-835). |
| `thread/compact/start` | `{threadId}` → `{}` | Progress arrives as ordinary `turn/*` and `item/*` events with a `contextCompaction` item (docs lines 874-883). |
| `thread/fork` | `{threadId, lastTurnId?, excludeTurns?, ephemeral?}` → new thread (`forkedFromId`) | `ephemeral` creates an in-memory fork. |
| `thread/revert` | `{threadId, beforeTurnId}` → `{thread (turns empty), turnsBackwardsCursor, itemsBackwardsCursor}`; emits `thread/reverted` | Paginated threads only. The thread must be loaded (T3 resumes it first, `CodexAdapterV2.ts:7412-7426`). Does not undo file edits. `thread/rollback` has been removed. |
| `thread/name/set`, `thread/metadata/update`, `thread/goal/{set,get,clear}`, `thread/inject_items {threadId, items: ResponseItem[]}`, `thread/shellCommand {threadId, command, timeoutMs?}` | | `thread/shellCommand` runs **outside the sandbox**. |
| `thread/backgroundTerminals/{list,terminate,clean}` (exp) | `{threadId, processId}` → `{terminated}` | Needed to stop commands that are still running after an interrupt (see §8). |

### `turn/start`: `TurnStartParams` → `{turn: Turn}`
```ts
{ threadId: string; input: UserInput[]; clientUserMessageId?: string|null /* echoed as userMessage.clientId */;
  cwd?; approvalPolicy?; approvalsReviewer?; sandboxPolicy?: SandboxPolicy; model?; serviceTier?; serviceTierForTurn?;
  effort?: string|null; summary?: "auto"|"concise"|"detailed"|"none"|null; personality?; outputSchema?: JsonValue|null;
  toolOutput?: {name, namespace?, output}|null /* requires input: [] */; disabledPluginIds?; turnTrigger?; parentTurnId?; rootTurnId?;
  // (exp) collaborationMode {mode:"plan"|"default", settings:{model, reasoning_effort?, developer_instructions?}}, additionalContext {key:{kind:"application"|"untrusted", value}}
}
SandboxPolicy = {type:"dangerFullAccess"} | {type:"readOnly", networkAccess} | {type:"externalSandbox", networkAccess}
              | {type:"workspaceWrite", writableRoots, networkAccess, excludeTmpdirEnvVar, excludeSlashTmp}
UserInput = {type:"text", text, text_elements: TextElement[]} | {type:"image", url} | {type:"image", fileId} | {type:"localImage", path}
          | {type:"audio", url} | {type:"localAudio", path} | {type:"skill", name, path} | {type:"mention", name, path}   // image/localImage accept optional detail
Turn = { id; rootTurnId|null; items: ThreadItem[]; itemsView; status: "completed"|"interrupted"|"failed"|"inProgress";
         error: {message; codexErrorInfo|null; additionalDetails|null; misalignment|null}|null; startedAt|null; completedAt|null; durationMs|null }
```
- **Per-turn overrides persist.** Model, effort, cwd, sandbox, approval and summary all carry over to later turns. `outputSchema` applies to one turn only (docs lines 966-972).
- **Request reasoning summaries explicitly.** T3 always sends `summary:"detailed"`, because model catalogues can default summaries to `"none"` (`CodexAdapterV2.ts:798-800`). T3 also always sends `approvalsReviewer`, because leaving it out on resume keeps the previous reviewer (`CodexAdapterV2.ts:801-803`).
- **`text_elements` can be left out.** The bindings mark it required, but T3 sends `{type:"text", text}` and 0.156.1 accepted it (all fixtures).
- **Queued turns.** If the response has `turn.startedAt === null`, the turn is queued and cannot be interrupted until `turn/started` arrives (`CodexAdapterV2.ts:7118-7130`).
- **Starting a turn while one is active.** The field comments on `turnTrigger` and `parentTurnId` ("ignored when this request adds input to an active turn") suggest that `turn/start` on a busy thread joins the active turn. **UNVERIFIED.** T3 never does this; it queues on its own side and sends after `turn/completed` (fixture `queued_turn`).

### `turn/steer`: `{threadId, input: UserInput[], expectedTurnId: string, clientUserMessageId?}` → `{turnId}`
- `expectedTurnId` must match the active turn, otherwise the request fails. It also fails if no turn is active. Steering emits no new `turn/started`, and the request takes no `model`, `cwd`, `sandboxPolicy` or `outputSchema` (docs lines 1085-1101).
- Live: steering a nonexistent thread returns `-32600 "thread not found: <id>"`.
- Turns of kind review or compact cannot be steered: `codexErrorInfo` `{activeTurnNotSteerable:{turnKind:"review"|"compact"}}` (`ts/v2/CodexErrorInfo.ts`, `NonSteerableTurnKind.ts`).
- Fixture `message_steering`: the steered text shows up as a **second `userMessage` item inside the same turn**, after the current agent message completes. A second `agentMessage` and one `turn/completed` follow.

### `turn/interrupt`: `{threadId, turnId}` → `{}`
- The request returns `{}` first. The final state comes later as `turn/completed` with `status:"interrupted"` (docs lines 1118-1125; fixture `turn_interrupt_mid_tool`, entries 27-32).

### Models, account, config and usage
- `model/list {cursor?, limit?, includeHidden?}` → `{data: Model[], nextCursor}`.
  - Live `Model` fields: `id, model, displayName, description, hidden, isDefault, supportedReasoningEfforts:[{reasoningEffort, description}], defaultReasoningEffort, inputModalities:["text","image"], upgrade, upgradeInfo, availabilityNux, modelSpecialty, supportsPersonality, multiAgentVersion, additionalSpeedTiers, serviceTiers, defaultServiceTier, availableAccessPrograms`.
  - Live data: `gpt-6.1-sol` (default), `gpt-6-astra` and `gpt-6-sol`. Sol's efforts run `low` through `max`, plus `ultra`, described as "automatic task delegation", which means subagents (see §8).
  - The list is paginated, so loop until `nextCursor` is null (`CodexProvider.ts:355-371`).
- `account/read {refreshToken?}` → `{account: {type:"chatgpt", email, planType}|{type:"apiKey"}|null, requiresOpenaiAuth: boolean, ...}`. Live output also included `workspaceRouting`.
- `getAuthStatus` is a legacy v1 method.
- `config/read {includeLayers?, cwd?}` → `{config, origins, layers?}`. Live: about 54 KB.
- `account/rateLimits/read {excludeResetCreditDetails?, supportsLunaReserve?}` → `{rateLimits: RateLimitSnapshot, rateLimitsByLimitId, rateLimitResetCredits, accountId, ordinaryUsageAllowed, rateLimitUpsell}`.
  - Live: `primary:{usedPercent:33, windowDurationMins:10080, resetsAt:1793513440}`, `secondary:null`, `planType:"pro"`, `credits:{hasCredits, unlimited, balance}`.
- `account/usage/read` → lifetime and daily token buckets.
- `hooks/list {cwds?}` → hooks with `eventName`, `command`, `trustStatus`, `enabled`, `sourcePath` (see §6).
- `mcpServerStatus/list`, `config/mcpServer/reload` and `skills/list {cwds}` exist. **I did not call `mcpServerStatus/list`, so as not to start MCP servers.**
- Per-thread token usage has no read method. It arrives as the notification `thread/tokenUsage/updated` (§3).

---

## 3. Notification catalogue (server to client)

All names come from `ts/ServerNotification.ts`; there are 88. Every notification carries the envelope field `emittedAtMs`. Each line below gives the method, then its `params` shape.

**Thread level**
- `thread/started` → `{thread: Thread}`.
- `thread/status/changed` → `{threadId, status: ThreadStatus}`. The active flags are `waitingOnApproval` and `waitingOnUserInput`.
- `thread/closed` → `{threadId}`. The thread was unloaded, and **its terminals were killed without `item/completed`** (T3 `CodexAdapterV2.ts:4707-4735`).
- `thread/archived`, `thread/unarchived`, `thread/deleted` and `thread/reverted` → `{threadId}`.
- `thread/name/updated`, `thread/goal/updated` and `thread/goal/cleared`.
- `thread/settings/updated` → `{threadId, threadSettings:{cwd, approvalPolicy, approvalsReviewer, sandboxPolicy, model, modelProvider, effort, serviceTier, ...}}`. This is sent at turn start (fixtures).
- `thread/tokenUsage/updated` → `{threadId, turnId, tokenUsage:{total: B, last: B, modelContextWindow: number|null}}`, where `B = {totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}`.
  - `total` is the running total for the whole thread.
  - `last` is the newest model request. **Context fill is `last.totalTokens / modelContextWindow`** (T3 `CodexAdapterV2.ts:195-207`).
- `thread/compacted` → `{threadId, turnId}`. This is **deprecated**; use the `contextCompaction` item instead (docs line 1394).

**Turn level**
- `turn/started` → `{threadId, turn}`, with `status:"inProgress"`, empty items and `startedAt` in unix seconds.
- `turn/completed` → `{threadId, turn}`, with `turn.status` set to `completed`, `interrupted` or `failed`, and `turn.error`.
  - **`turn.items` is only a summary** (`itemsView:"summary"`, holding just the final `agentMessage`), or is empty for an interrupted turn. Do not rebuild a transcript from it.
- `turn/diff/updated` → `{threadId, turnId, diff}`, the whole aggregated unified diff each time. T3 opts out of it.
- `turn/plan/updated` → `{turnId, explanation?, plan:[{step, status:"pending"|"inProgress"|"completed"}]}`.
- `turn/moderationMetadata`, `model/rerouted {threadId, turnId, fromModel, toModel, reason}`, `model/verification` and `model/safetyBuffering/updated`.

**Item level**
- `item/started` → `{item: ThreadItem, threadId, turnId, startedAtMs}`. `item/completed` → `{item, threadId, turnId, completedAtMs}`, and **`item/completed` is the authoritative state of the item** (docs lines 1395-1399).
- `ThreadItem` (`ts/v2/ThreadItem.ts`) has these variants:
  - `userMessage{id, clientId, content: UserInput[]}`
  - `hookPrompt{id, fragments}`
  - `agentMessage{id, text, phase: "commentary"|"partial_answer"|"final_answer"|null, memoryCitation, delivery: "async"|null, questions}`
  - `functionCallOutput{id, name, namespace, output}`
  - `plan{id, text}`
  - `reasoning{id, summary: string[], content: string[]}`
  - `commandExecution{id, command, cwd, processId|null, source: "agent"|"userShell"|"unifiedExecStartup"|"unifiedExecInteraction", status: "inProgress"|"completed"|"failed"|"declined", commandActions, aggregatedOutput|null, exitCode|null, durationMs|null, pluginId, scriptPath}`
  - `fileChange{id, changes:[{path, kind:{type:"add"}|{type:"delete"}|{type:"update", move_path}, diff}], status}`
  - `mcpToolCall{id, server, tool, status: "inProgress"|"completed"|"failed", arguments, appContext, mcpAppUi, pluginId, readOnlyHint, result, error, durationMs}`
  - `dynamicToolCall{...}`
  - `collabAgentToolCall{id, tool, status, senderThreadId, receiverThreadIds, prompt, model, reasoningEffort, agentsStates}`
  - `subAgentActivity{id, kind, agentThreadId, agentPath, model, reasoningEffort}`
  - `webSearch{id, query, action?}`
  - `imageView{id, path}`, `sleep`, `imageGeneration`
  - `enteredReviewMode{id, review}`, `exitedReviewMode{id, review}`
  - `contextCompaction{id}`
- Delta notifications (all carry `threadId, turnId, itemId`). There is no sequence number:
  - `item/agentMessage/delta` → `{..., delta}`.
  - `item/reasoning/summaryTextDelta` → `{..., delta, summaryIndex}`. `item/reasoning/summaryPartAdded` → `{..., summaryIndex}`. `item/reasoning/textDelta` → `{..., delta, contentIndex}` (raw reasoning, when the model supports it).
  - `item/plan/delta` → `{..., delta}`. The final `plan` item may not equal the joined deltas.
  - `item/commandExecution/outputDelta` → `{..., delta}`, which can **continue after `turn/completed`** for background commands (T3 `CodexAdapterV2.ts:4310-4329`).
  - `item/commandExecution/terminalInteraction`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`.
  - `item/fileChange/outputDelta` is deprecated and no longer emitted.
- Other item notifications: `item/autoApprovalReview/{started,completed}` and `rawResponseItem/completed` (exp).
- `serverRequest/resolved` → `{threadId, requestId}`. This follows every answered server request, and is also sent when a pending request is cleared by turn start, completion or interrupt.
- `hook/started` and `hook/completed` → `{threadId, turnId|null, run: HookRunSummary}`. These are sent for synchronous hooks only. **`HookRunSummary` has i64 fields typed `bigint` in the TS bindings, which arrive as plain JSON numbers.**

**Errors, limits and warnings**
- `error` → `{error: TurnError, willRetry: boolean, threadId, turnId}`.
  - `willRetry:true` is a transient retry; the message often contains `N/M`, which T3 parses with `parseCodexRetryProgress`, `CodexAdapterV2.ts:1087-1100`.
  - `willRetry:false` precedes a `turn/completed` with status `failed`.
- `CodexErrorInfo` (`ts/v2/CodexErrorInfo.ts`; **camelCase on the wire**, although the docs show PascalCase) takes these values:
  - Plain strings: `contextWindowExceeded`, `sessionBudgetExceeded`, `usageLimitExceeded`, `rateLimitExceeded`, `flexUnavailable`, `serverOverloaded`, `cyberPolicy`, `misalignmentPolicyViolation`, `tooManyDenials`, `internalServerError`, `unauthorized`, `badRequest`, `threadRollbackFailed`, `sandboxError`, `other`.
  - Objects carrying `{httpStatusCode}`: `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected`, `responseTooManyFailedAttempts`.
  - Also `{activeTurnNotSteerable:{turnKind}}`, plus open-ended `string` or `object` values.
- `account/rateLimits/updated` → `{rateLimits: RateLimitSnapshot}`. **This is a partial update**: fields that are left out keep their earlier values (T3 `codexUsageLimits.ts:161-186`). A `limitId` other than `"codex"`, for example a model-specific bucket, must not overwrite the main limits.
  - `RateLimitSnapshot = {limitId, limitName, normalModelSlug, primary: {usedPercent, windowDurationMins|null, resetsAt|null}|null, secondary, credits, individualLimit, spendControlReached, planType, rateLimitReachedType}`.
- Account and auth: `account/updated {authMode, planType}`, `account/login/completed`, `modelProvider/authRecovery{Started,Completed}`.
- Warnings: `warning {threadId|null, message}`, `configWarning {summary, details?, path?, range?}`, `deprecationNotice`, `guardianWarning`.
- MCP: `mcpServer/startupStatus/updated {threadId, name, status:"starting"|"ready"|..., error, failureReason}` is **per thread**. Also `mcpServer/oauthLogin/completed`.
- Notifications for features Console does not use: `skills/changed`, `app/list/updated`, `fs/changed`, `remoteControl/status/changed`, `thread/realtime/*`, `fuzzyFileSearch/*`, `windows*`, `externalAgentConfig/*`, `process/*`, `command/exec/outputDelta`.

**Observed order for one simple turn** (fixture `simple`):
1. `turn/start` response, with `startedAt:null`.
2. `thread/status/changed` → active.
3. `turn/started`.
4. `item/started` and `item/completed` for the `userMessage`.
5. `item/started` for the `agentMessage` (`phase:"final_answer"`), then `item/agentMessage/delta` ×N, then `item/completed`.
6. `thread/tokenUsage/updated`.
7. `thread/status/changed` → idle, **then** `turn/completed`.

With approvals (fixture `tool_call_read_only_on_request`, entries 44-50): `thread/status/changed{waitingOnApproval}` arrives **before** `item/started(commandExecution)`, followed by the approval request, the client's response, `serverRequest/resolved` and `item/completed`.

---

## 4. Server-to-client requests the client must answer

These come from `ts/ServerRequest.ts`. **Every server request must get a result or a JSON-RPC error. A request left unanswered blocks the turn indefinitely**; T3 has no timeout and waits on a deferred value. Answer methods you do not recognise with an error. T3 replies `-32601` from its generic client (`packages/effect-codex-app-server/src/client.ts:193-195`).

| Method | Params (key fields) | Response |
|---|---|---|
| `item/commandExecution/requestApproval` | `kind, threadId, turnId, itemId, startedAtMs, approvalId?, environmentId, reason?, networkApprovalContext?, command?, cwd?, commandActions?, proposedExecpolicyAmendment?, proposedNetworkPolicyAmendments?` | `{decision: "accept"\|"acceptForSession"\|"decline"\|"cancel"\|{acceptWithExecpolicyAmendment:{execpolicy_amendment}}\|{applyNetworkPolicyAmendment:{network_policy_amendment}}}` |
| `item/fileChange/requestApproval` | `threadId, turnId, itemId, startedAtMs, reason?, grantRoot?` | `{decision: "accept"\|"acceptForSession"\|"decline"\|"cancel"}` |
| `item/permissions/requestApproval` | `threadId, turnId, itemId, environmentId, startedAtMs, cwd, reason, permissions` | `{permissions: <granted subset>, scope: "turn"\|"session", strictAutoReview?}` |
| `item/tool/requestUserInput` | `threadId, turnId, itemId, questions:[{id, header, question, isOther, isSecret, options:[{label, description}]\|null}], isBlocking, autoResolutionMs\|null` | `{answers: {[questionId]: {answers: string[]}}}` |
| `mcpServer/elicitation/request` | `threadId, turnId\|null, serverName` and one of `{mode:"form", message, requestedSchema, _meta}`, `{mode:"openai/form"\|"openaiForm", ...}` or `{mode:"url", message, url, elicitationId, _meta}` | `{action: "accept"\|"decline"\|"cancel", content: JsonValue\|null, _meta: JsonValue\|null}` |
| `item/tool/call` (dynamic tools, exp) | `DynamicToolCallParams` | `{contentItems, success}` |
| `account/chatgptAuthTokens/refresh` | `{reason, previousAccountId?}` | `{accessToken, chatgptAccountId, chatgptPlanType}`. Only sent in external-token auth mode (about a 10 s timeout). |
| `attestation/generate` | `{}` | `{token}`. Only sent when `requestAttestation:true`. |
| `execCommandApproval` / `applyPatchApproval` (legacy v1) | v1 params | `{decision: "approved"\|"approved_for_session"\|{denied:{rejection}}\|"abort"\|"timed_out"\|...}` (`ts/ReviewDecision.ts`). T3 still handles both (`CodexAdapterV2.ts:5458`, `5528`, and its mapping `556-571`). |

**Reproducing today's `--dangerously-bypass-approvals-and-sandbox`.**
- In the source, that flag sets `sandbox_mode = DangerFullAccess` and `approval_policy = Never` (`codex-src/tui_startup_orchestration.rs:52-56`; the same applies in `cli/src/main.rs`).
- Equivalent protocol on `thread/start` and `thread/resume`:
  ```json
  {"approvalPolicy":"never","sandbox":"danger-full-access","approvalsReviewer":"user"}
  ```
  On every `turn/start` (T3 also re-sends the policy each turn; overrides persist):
  ```json
  {"approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"},"approvalsReviewer":"user"}
  ```
  (T3 runtime mode "full-access", `CodexAdapterV2.ts:708-715`.)
- With that policy, **command, file-change and permissions approvals and the v1 approvals are not sent.** Evidence: none of the 24 fixtures recorded with `approvalPolicy:"never"` contains an approval request, including those run with `readOnly` or `workspaceWrite` sandboxes, where an escalation would otherwise prompt. Approval requests appear only in the `on-request`, `untrusted` and `granular` fixtures.
- **Requests that can still arrive:**
  - `item/tool/requestUserInput`. It appears in fixture `plan_questions` under `never`, in plan mode or whenever the `request_user_input` tool is listed.
  - `mcpServer/elicitation/request`, from MCP servers or ChatGPT connector apps. Bryan's config has the gmail, github and google-drive plugins. Under `never`, `AskForApproval.granular.mcp_elicitations` suggests elicitations are tied to the approval policy, but I have **no observation of whether `never` auto-declines them: UNVERIFIED**.
  - `item/tool/call`, only if `dynamicTools` are registered.
  - `account/chatgptAuthTokens/refresh`, only with external-token login. Not applicable to the CLI's managed ChatGPT login.
  - `attestation/generate`, only if opted in.
- Minimum handler set:
  - `requestUserInput`: show it to the user, or answer with empty answers.
  - Elicitation: answer `{action:"decline", content:null, _meta:null}` unless the user is shown the request.
  - Everything else: a JSON-RPC error.

---

## 5. Rollout correlation and persistence

- **Same store as the TUI.**
  - Live `thread/list` and `thread/read` against today's TUI threads returned `path: "/home/bryan/.codex/sessions/2026/10/25/rollout-2026-10-25T21-50-07-01a1768b-5c6b-79b1-92a5-bbbc79639520.jsonl"` for thread id `01a1768b-5c6b-79b1-92a5-bbbc79639520`. That thread has `originator:"codex-tui"`, `source:"cli"` and `historyMode:"paginated"`.
  - Its first line is `session_meta` with `payload.id == payload.session_id == <thread id>` (checked directly).
  - T3 fixture `simple` shows a thread created by app-server writing `path: "/home/replay-user/.codex/sessions/2026/09/24/rollout-2026-09-24T17-16-44-<threadId>.jsonl"`, with `source:"vscode"` and `originator:"t3code_desktop"`.
  - So for root threads: **thread id = rollout session id = the UUID in the filename = `session_meta.id`**.
  - For forks, `thread.sessionId` is the root's id. Use `thread.id` to resume and `thread.sessionId` to match hook `session_id` values.
- **Resume locates a thread by `threadId` only.** How the server finds the file internally (state database or session index) is not documented. There is no path parameter in 0.164.
- **Paginated history.**
  - Paginated rollouts still contain `response_item` records, plus `event_msg` `item_completed`, `token_count` and `task_started`/`task_complete` records. Counts for one TUI rollout: 69 `item_completed`, 23 `message`, 16 `custom_tool_call`, and so on.
  - So the Console's existing JSONL parser should keep working.
  - The server also maintains `~/.codex/thread_history_1.sqlite` (4.6 GB here) and `state_5.sqlite`.
- **`codex resume <id>` on a thread the app-server created: UNVERIFIED by direct test.** The evidence points to yes:
  - `codex resume [SESSION_ID]` accepts a UUID or a name.
  - The TUI is an app-server client over the same store.
  - App-server threads are recorded with `source:"vscode"`, which counts as interactive (it is in the default `sourceKinds`, and the TUI picker hides only non-interactive sources unless `--include-non-interactive` is given).
  - **Do not load one thread in two processes at once** (the Console's app-server and a TUI). I found no lock and no evidence either way. Treat it as unsafe.
- **Turning persistence off:** `thread/start {ephemeral:true}` (stable), or `thread/fork {ephemeral:true}`. Ephemeral threads keep history in memory, are left out of listings, and an ephemeral root cannot be deleted.

---

## 6. Hooks and MCP under app-server

**Hooks run in app-server threads exactly as in the TUI.**
- Hooks live in the shared `codex-rs/hooks` crate. Core runs pending `SessionStart` hooks from `core/src/session/turn.rs` → `hook_runtime.rs:run_pending_session_start_hooks` (`codex-src/hook_runtime.rs:128-175`). The TUI uses the same app-server and core path (see §1).
- Live: `hooks/list` on the app-server, for the Console cwd, returned Bryan's `~/.codex/hooks.json` hooks with `trustStatus:"trusted"` and `enabled:true`. That covers `preToolUse` (waltium-ops), and the `agent-coord.mjs hook codex` command for `postToolUse`, `sessionStart`, `sessionEnd`, `userPromptSubmit` and `stop` (`appserver/handshake.out.txt`, id 7).
- The docs define `hook/started` and `hook/completed` as app-server notifications (docs lines 1364-1366). The `SessionEnd` rules are written in app-server terms (hooks.md lines 684-720): it runs on archive, on delete, on a normal close, or "after a conversation has been idle and isn't open in any connected client for 30 minutes". `thread/unsubscribe` does not run it immediately.
- **`SessionStart` timing.** Start hooks are queued and run at the **start of the next turn**, not at `thread/start`. The Console therefore gets the thread id from the `thread/start` response before any hook fires, as long as it saves the mapping before sending `turn/start`. `source` is `startup`, `resume`, `clear`, `compact` or `fork`. After a compaction, `SessionStart(source:"compact")` runs again before the next model request.
- **What a hook receives on stdin** (hooks.md lines 467-492, 648-720, 1068-1120):
  - Common: `{session_id, transcript_path, cwd, hook_event_name, model, permission_mode}`.
  - Turn-scoped events also get `turn_id`. `Stop` also gets `stop_hook_active` and `last_assistant_message`. `SessionStart` gets `source`, and `SessionEnd` gets `reason:"other"`.
  - `session_id` = `sess.session_id()`, which is the root thread id; subagent hooks get the parent's id. The docs example uses `"session_id":"thr_123"`.
  - `permission_mode` is derived from the approval policy.
- **The env a hook receives** (`codex-src/registry.rs:83`, `command_runner.rs:440-497`):
  - It is a **snapshot of the codex (app-server) process's environment, taken when the thread's hook registry is created**, plus any per-handler `env` from the hook config, minus the vars in `NON_INHERITABLE_ENV_VARS`.
  - **Codex does not inject a per-thread `CODEX_THREAD_ID` into hook processes.** It injects `CODEX_THREAD_ID` and `CODEX_TOOL_CALL_ID` only into tool-call shells (`codex-rs/core/src/exec_env.rs`, `protocol/src/shell_environment.rs`).
  - The hook runs as a shell `-lc` child of the codex process, in a new process session.
- **Consequences for Console coordination. This needs a design decision.**
  - `scripts/agent-coord.mjs` finds its "owner" by walking the parent processes to the `codex` process (`owner()`, lines 42-51). It registers with `pid: processOwner.pid` and `consoleSessionId: process.env.AGENT_CONSOLE_SESSION_ID` (`registerSession`, lines 95-110), and writes one `owners/<pid>-<start>.json` locator per process (line 109).
  - With one shared app-server, **every thread's hooks report the same owner pid and the same env.** `AGENT_CONSOLE_SESSION_ID` cannot tell the threads apart, and the per-process locator is overwritten by whichever thread ran a hook last.
  - Thread identity has to come from the stdin `session_id`, matched to the Console's own record of thread id to Console session (the Console creates the thread, so it knows the id first).
  - The MCP path already copes: the MCP server reads `request.params._meta.threadId` (`agent-coord.mjs:393`), and `credential()` prefers it (lines 174-193).
  - Stop and SessionEnd check `state.ownerPid === processOwner.pid` (lines 205-212). That check still passes, because the pid is the same app-server, but it no longer means "this specific session's process".
- **MCP servers:**
  - Servers from `config.toml` (`mcp_servers.*`) start **per loaded thread**. `mcpServer/startupStatus/updated` carries a `threadId`. Fixture `simple` shows `xcodebuildmcp` and `codex_apps` starting for the thread. Fixture `subagent_v2` shows a second MCP startup for the child subagent thread.
  - So memory grows with the number of loaded threads, and each thread keeps its MCP children until it unloads.
  - A per-thread override through `thread/start.config` works for MCP: T3 sets `"mcp_servers.t3-code": {url, tool_timeout_sec, http_headers}` per thread (`CodexAdapterV2.ts:1349-1378`).
  - So a per-thread `mcp_servers.agent_console_coordination.env.AGENT_CONSOLE_SESSION_ID` override is a plausible way to give each thread's coordination MCP its own identity. **UNVERIFIED** for env specifically; T3 only shows it for `url` and `http_headers`.
  - Codex waits only about 1 s by default for optional MCP servers before the first model request. T3 sets `mcp_optional_startup_grace_ms: 10000` (`CodexAdapterV2.ts:1336-1343`).
  - MCP server processes inherit the codex process env; `rmcp-client` filters out the non-inheritable vars.

---

## 7. T3 reuse assessment

**Overall verdict.** Everything in T3 is written in Effect-TS (`Effect.gen`, `Ref`, `Deferred`, `Queue`, `Scope`, `Schema`), and the adapter emits T3's orchestration-v2 events (nodes, turn items, runs, provider turns). Almost nothing can be copied as is, except a few pure helpers. The real value is in three places:
1. Vendor behaviour T3 has found and coded for (listed in §8).
2. The **recorded wire fixtures** (29 Codex scenarios), usable as test data.
3. A handful of pure functions.

Keep the MIT notice ("Copyright (c) 2026 T3 Tools Inc." plus the permission text) in any copied file.

### Transport package: `packages/effect-codex-app-server/`
| File:lines | What it does | Coupling | Recommendation |
|---|---|---|---|
| `src/protocol.ts:1-498` | JSONL reader with a 128 MiB per-line cap and `\r` stripping; table of pending requests by id; on stdout end, fails every pending request with the exit error; routes messages by shape; caps concurrent server-request handlers at 32 (answers `-32001` beyond that); numeric ids starting at 1 | Heavy (Queue, Deferred, Stream, Scope) | **PORT** to about 150 lines of plain TS: a line splitter with a byte cap, `Map<id,{resolve,reject,method,timer}>`, failing everything pending on `exit`, and a router. Add per-request timeouts, which T3 lacks. |
| `src/client.ts:1-275` | Typed `request`, `notify`, `handleServerRequest` and `handleServerNotification` per method, decoding against generated schemas; **notification decode failures are silently ignored**; stderr discarded | Heavy | **PORT** the pattern, typed with the `generate-ts` bindings. Log decode failures and keep a stderr tail. |
| `src/errors.ts:268-420` | JSON-RPC error constructors (-32700, -32600, -32601, -32602, -32603, -32001) and the error taxonomy (spawn, exited, parse, transport, request) | Effect Schema | **PORT** the names and codes only. |
| `src/replay.ts:1-562` + `apps/server/src/orchestration-v2/testkit/fixtures/*/codex_transcript.ndjson` (29 Codex scenarios, codex 0.156.1) | A replay peer: `expect_outbound`, `emit_inbound` (`afterMs`) and `runtime_exit` entries | Effect | **COPY the fixtures** as test data (with MIT notice). **PORT** a small replay mock peer, about 80 lines. The most useful scenarios are `simple`, `multi_turn`, `message_steering`, `queued_turn`, `turn_interrupt`, `turn_interrupt_mid_tool`, `provider_thread_resume`, `command_output_streaming`, `plan_questions`, `tool_call_*`, `thread_rollback*` and `subagent_v2*`. |
| `scripts/generate.ts` | Builds the schema from GitHub at a pinned ref | T3 build | **SKIP**. Use `codex app-server generate-ts --experimental` from the installed CLI instead. |

### Provider support (`apps/server/src/provider/`)
| File:lines | What it does | Coupling | Recommendation |
|---|---|---|---|
| `CodexProvider.ts:469-517` `withCodexAppServerClient` | Spawns, initializes and sends `initialized`. Expands `~` in `CODEX_HOME`, because spawn with an env does not, and Codex would otherwise reject the path (lines 476-482). | Effect | **PORT** (a few lines). |
| `CodexProvider.ts:520-603` `probeCodexAppServerProvider` | A short-lived status-probe process: `account/read`, then `skills/list`, paginated `model/list`, `config/read` (`service_tier`) and `account/rateLimits/read` in parallel, under a 20 s deadline with a 3 s cap for each optional step | Effect + T3 contracts | **PORT** the sequence for the Console's provider-status and usage panel. |
| `CodexProvider.ts:166-168, 170-240` | `codexDefaultReasoningEffortOverride` (gpt-6-astra defaults to `medium`); mapping of model capabilities (effort options, service tiers) | T3 contracts | **PORT** only if the Console offers a model and effort picker. |
| `CodexProvider.ts:404-447` `requestCodexChatGptModels` | The models cache is shared by every client and tailored to the originator. App-server refreshes it at startup, so T3 waits for a write newer than its spawn time before listing models | Effect | **PORT** the rule if we list models just after spawning. |
| `CodexProvider.ts:449-466` | `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` env; `buildCodexInitializeParams` | trivial | **PORT**. |
| `CodexProvider.ts:659-689` `accountProbeStatus` | `account == null && requiresOpenaiAuth` means "not logged in" ("Run `codex login`") | T3 contracts | **PORT** (about 10 lines). |
| `codexLaunchArgs.ts:1-39` | `["app-server", ...tokenized launch args]`; a filter that passes only `-c`, `--enable`, `--disable` and `--strict-config` through to `exec` | pure, but uses a T3 `tokenizeCliArgs` | **SKIP**. The Console builds its own args. |
| `codexUsageLimits.ts:1-243` | Maps rate-limit snapshots to usage windows: falls back to 5 h / weekly, or monthly for the free and go plans, when `windowDurationMins` is missing; ignores `limitId !== "codex"`; `mergeCodexRateLimits` handles partial updates; formats reset times and builds messages from `rateLimitReachedType` (workspace credits versus spend limit) | Light: `DateTime`, `Option`, contract types | **COPY then de-Effect.** Functions: `kindForDuration`, `codexRateLimitsToWindows`, `codexResetCreditsToContract`, `codexRateLimitsToLimits`, `mergeCodexRateLimits`, `formatCodexUsageLimitWait`, `codexUsageLimitNextStep`, `codexUsageLimitMessage`, `codexUsageLimitResetAt`. Swap `DateTime` for `Date` and use local types. (Live Pro data showed `primary` = 10080-min weekly and `secondary` = null; the 5 h fallback applies only when the duration is missing.) |
| `CodexTurnTokenUsage.ts:1-177` | Per-turn token usage from thread-wide cumulative `total`: takes deltas, falls back to `last` when a counter goes down, and a late update for a finished turn only moves the baseline | pure TS (type imports only) | **COPY verbatim** with MIT notice: `codexTokenUsageBreakdown`, `makeCodexTurnTokenUsageState`, `getCodexTurnAccumulator`, `codexTurnTokenUsageDelta`, `accumulateCodexTurnTokenUsage`, `completeCodexTurnTokenUsage`. Also `codexProviderTurnTokenUsage` (`CodexAdapterV2.ts:195-207`) for context fill. |
| `CodexMcpElicitation.ts:1-220` | Turns MCP or connector elicitation forms into Approve, Decline, Cancel, "this session" and "always" options, reading app names from several `_meta` spellings, and builds the matching `content` or `_meta.persist` response | Effect `Schema.is` guards, T3 decision types | **PORT later**, only if the Console shows connector approvals. At first, decline. |
| `CodexThreadRevert.ts:1-41` | To revert N turns: page `thread/turns/list` (desc, summary) to find `beforeTurnId`, with a guard against repeated cursors, then call `thread/revert` | Effect, but small | **PORT** if the Console adds "undo last N turns". |
| `CodexToolPresentation.ts:1-236` | Icons and source names for browser-use, computer-use and connector MCP results (`result._meta["codex/toolSurface"]`) | Effect + T3 UI contracts | **SKIP**. Port only the output rule in `CodexAdapterV2.ts:459-477`: `structuredContent ?? content`, merged with `error.message`. |
| `CodexDeveloperInstructions.ts:1-227` | T3's text for plan and default modes, and packing of `additionalContext` | T3 prompts | **SKIP the code; keep the facts:** each `additionalContext` value is silently cut in the middle above about 4000 bytes (lines 10-15); entries are emitted in key order (lines 212-213); when the model catalogue ships its own text for a collaboration mode, Codex **drops the client's `developer_instructions`** (lines 202-206). |
| `CodexManagedRuntime.ts:1-113` | T3-managed install plus the ChatGPT "token sharing" model provider (`model_provider="openai_token_sharing"`, `ACCESS_TOKEN`, `features.multi_agent=false`) | T3 | **SKIP**. |
| `CodexManagedErrors.ts:1-92` | Classifies `subscription_sharing_*` and `chatpass_v2_*` errors from T3's token sharing | T3-specific | **SKIP**. Does not apply to a plain CLI login. |
| `CodexChatGptSessionLock.ts:1-44` | `proper-lockfile` around T3's credential store | T3 | **SKIP**. |
| `codexModelCatalog.ts:1-54` | T3 manifest overlay: models that need a newer CLI | T3 manifest | **SKIP**. Lesson: `model/list` lists only models this CLI build knows. |
| `Drivers/CodexDriver.ts:1-363` | Wiring into T3's provider registry; maintenance and updates; spending reset credits | T3 | **SKIP**. |
| `Drivers/CodexManagedProvider.ts:1-328` | Managed sign-in and setup | T3 | **SKIP**. |
| `Drivers/CodexHomeLayout.ts:1-423` | A "shadow" `CODEX_HOME` per extra account, built from symlinks; `auth.json` and `models_cache.json` stay private, the rest is shared | Effect FS | **SKIP** unless the Console needs several Codex accounts. |
| `orchestration-v2/ProviderSessionManager.ts` (56-58, 1100-1270, 1510-1660, 2104-2290) | One live entry per provider session id. Idle release (closes the scope, which kills the process) after **30 min** with no busy turns; deferred ("pinned") up to **4 h** while `hasPendingBackgroundWork` is true; per-thread idle unload through `thread/unsubscribe` when several threads share a session; a lock around opening; checks the workspace directory exists before opening | Heavy | **PORT the policy, not the code.** |
| `orchestration-v2/Orchestrator.ts:961-979` | `providerSessionIdFor`: for Codex (`supportsMultipleProviderThreadsPerSession`) the id is derived from **the provider instance only**, so there is **one app-server per instance for all T3 threads** | | Evidence for §8. |

### `orchestration-v2/Adapters/CodexAdapterV2.ts` (7560 lines) by region
| Lines | Region | Recommendation |
|---|---|---|
| 232-236 | Initialize capabilities (`experimentalApi`, opt-out of `turn/diff/updated`, MCP-app UI extension) | **PORT**. Use `experimentalApi:true` and opt out of `turn/diff/updated` and perhaps `item/reasoning/textDelta`. |
| 238-330 | Capability flags (multiple threads per session, model switching, pending requests not surviving restart) | Evidence only |
| 343-422 | Status mapping (`inProgress` maps to running, `declined` to cancelled) | **PORT** (trivial) |
| 428-449 | Text for a finished background command (command capped at 200 chars, output tail at 1000) | **PORT** (optional) |
| 459-495 | MCP and dynamic tool output (`structuredContent ?? content`; error merged) | **PORT** |
| 556-626 | Approval and answer mapping (legacy `ReviewDecision`, permissions scope, `toCodexUserInputAnswers`) | **PORT** `toCodexUserInputAnswers` only. The approval parts are unused under `never`. |
| 678-812 | Runtime mode to `approvalPolicy`, `approvalsReviewer` and `sandboxPolicy`; `buildCodexTurnStartParams` (always `summary:"detailed"`, always an explicit reviewer, `collaborationMode.settings`, `additionalContext` kinds) | **PORT** the full-access row and the "always explicit" rules |
| 1087-1150 | Error classification: `parseCodexRetryProgress`, `codexErrorInfoCode` (string, or the first key of an object), `codexExhaustionHttpStatus` (`responseTooManyFailedAttempts.httpStatusCode`), `codexUsageLimitError` (`usageLimitExceeded`, `rateLimitExceeded`, or exhaustion on 429) | **COPY** these four pure functions (MIT). Skip `withCodexManagedFailure`. |
| 1336-1378 | `CODEX_THREAD_CONFIG` (`mcp_optional_startup_grace_ms:10000`, `tools.update_plan.enabled:true`); per-thread `config` MCP override | **PORT** the values |
| 1402-1471, 1547-1604 | Spawn (`codex app-server`, env `CODEX_HOME`, originator override; T3's `AgentScope` wrapper); client factory | **PORT** (`child_process.spawn`) |
| 1473-1545 | Protocol logger: `redactCodexProtocolValue` and `isSensitiveCodexProtocolKey` (redact `Bearer` values and keys ending in authorization, apikey, token, password or secret; recurses into JSON inside strings) | **COPY** both functions (pure) |
| 1768-1801 | `restoreAdditionalContext`: Codex drops client developer messages during compaction and resends `additionalContext` only when it changes, so T3 re-injects through `thread/inject_items` after a `contextCompaction` item completes | **PORT** only if the Console injects context |
| 1803-1832 | `ensureInitialized` (one permit; treat "Already initialized" as success) | **PORT** |
| 2024-2116 | `registerRootTurn`, `pendingRootTurns` and `awaitActiveTurn`. Notifications can arrive before the `turn/start` response has registered the turn; T3 adopts an unknown `turn/started` using the pending turn for that thread, and polls with yields up to 1000 times | **PORT** the idea: buffer events by `turnId` until the turn is known |
| 2264-2340 | `terminalizeRunningCommandItems`: interrupted or failed turns leave `commandExecution` items without `item/completed`, so T3 synthesises a terminal state | **PORT** |
| 2341-2386 | `terminateBackgroundTerminal` (exp `thread/backgroundTerminals/terminate`, checked with `list`; tolerates `thread not found:`, process exit and end of input) | **PORT** |
| 3183-3240 | Attachments: images sent as `{type:"image", url:"data:<mime>;base64,..."}`, with attachment paths added to the text | **PORT** |
| 3322-3470 + `ProviderTextDeltaCoalescer.ts:1-156` | Delta coalescing (50 ms for text and reasoning, 400 ms for plans), keyed by (turnId, itemId); `complete(finalText)` replaces the accumulated text with the `item/completed` text; `flushTurn` at the end of a turn; **duplicate final-answer suppression** (streams only the first final-answer item; drops a completed final answer whose text repeats in the same turn) | **PORT** (about 60 lines of plain TS) |
| 4296-4470 | Handlers for agent-message, command-output, reasoning and plan deltas, `turn/plan/updated`, `account/rateLimits/updated` (merge, then refill `resetAt` on items already marked usage-limited) and `thread/tokenUsage/updated` | **PORT** the mapping into Console events |
| 4472-4558 | `turn/started` (adopting the pending turn; goal-turn holds) | **PORT** the adoption; **SKIP** goals |
| 4573-4655 | `error`: if `willRetry`, show a retry item with attempt and maximum and classify it (usage limit / transport for `http*` and `responseStream*` / provider); if not, store it as the turn's latest failure | **PORT** |
| 4709-4735 | `thread/closed`: terminalise running commands in settled turns | **PORT** |
| 4736-5170 | `item/started` and `item/completed` mapping; track `commandExecution.processId`; `agentMessage.delivery==="async"` with `questions` becomes a user-input request; `contextCompaction` triggers re-injection; subagent and collab items | **PORT** selectively (user, agent, reasoning, command, file change, MCP, web search, compaction) |
| 5171-5656 | Handlers for the server requests (command, file change, permissions, MCP elicitation, legacy exec and patch, `requestUserInput`). Note that Codex's own `acceptForSession` only skips the exact command it answered, so T3 keeps its own per-thread allowance (lines 1890-1898) | **PORT** a minimal version: answer `requestUserInput`, decline elicitations, return errors for the rest |
| 5658-5888 | Terminal-event builder: a turn-failed message is merged with the earlier `error` notification (the notification's richer message wins); usage-limit failures get `resetAt` from the rate-limit snapshot | **PORT** |
| 5889-6153 | `finalizeCodexTurn`: serialised under a permit; flushes coalesced deltas **before** the terminal event; a failed compaction can end the turn without `item/completed`; completes token usage | **PORT** |
| 6154-6181 | `turn/completed`: a `completed` status for a turn that is being interrupted is recorded as `interrupted` | **PORT** |
| 6352-6400 | `startNativeTurn` (`startedAt:null` → wait for native start before interrupting) | **PORT** |
| 6597-6638 | `hasPendingBackgroundWork` (running commands, dynamic tools, MCP-app captures, running subagents); used to pin idle release | **PORT** (commands only, at first) |
| 6640-6671 | `ensureThread` → `thread/start {cwd, model, config}` | **PORT** |
| 6672-6738 | `resumeThread` (`excludeTurns:true`; archived → `thread/unarchive` → retry) | **PORT** (including the archived-thread regex) |
| 6739-6770 | `compactThread` (`thread/compact/start`; registers a pending turn so the next `turn/started` is adopted) | **PORT** |
| 6771-6798 | `injectHistory` (`-32601` = older server; anything else is treated as ambiguous) | **SKIP** at first |
| 6826-6862 | `steerTurn` (only when a turn is active locally; `expectedTurnId` = native active turn) + `ProviderTurnControlService.ts:326-395` (a steer error is flagged `turnCompleted` so the caller can resend it as a new turn) | **PORT** |
| 6866-6884 | `unloadThread` → `thread/unsubscribe` (lets the shared server shut the thread and its MCP servers down) | **PORT** |
| 6885-7270 | `interruptTurn`: wait up to 10 s for native start; interrupt the turn and any child or subagent turns; terminate tracked background terminals at the same time; wait up to 10 s for `turn/completed`; if that times out, finalise as `interrupted` locally; then terminalise leftover command and tool items | **PORT** the core (one thread plus terminals); **SKIP** the lineage and goal parts unless multi-agent is used |
| 7271-7321 | `respondToRuntimeRequest` | **PORT** |
| 7347-7381 | `readThreadSnapshot` (`thread/read includeTurns:true`, which is deprecated for paginated threads) | **PORT using `thread/items/list` paging instead** |
| 7382-7459 | `rollbackThread` (paginated history only; resume first if not loaded) | **PORT** if needed |
| 7460-7560 | `forkThread` | **SKIP** at first |
| 895-1085, 6405-6520 | `/goal` integration, fork boundary and rollback counting | **SKIP** (T3 features) |

---

## 8. Gotchas the Console must also handle

1. **Duplicate or out-of-order deltas.**
   - Over stdio, messages arrive in emission order, and deltas carry no sequence numbers.
   - T3 does not deduplicate deltas. It treats them as provisional and replaces them with the `item/completed` text.
   - Separately, the same `final_answer` text can arrive as more than one `agentMessage` item in one turn (for example after a retry). T3 streams only the first final-answer item and drops a completed duplicate (`CodexAdapterV2.ts:3416-3435`, `5134-5162`).
   - `item/plan/delta` joined together may not equal the final `plan` item.
2. **A turn can finish before its final item.**
   - `thread/status/changed → idle` can arrive *before* `turn/completed` (T3 `docs/orchestration-v2/README.md:85-93`; fixture `simple`). **`turn/completed` is the authoritative end of a turn.**
   - Flush any buffered deltas before handling `turn/completed`.
   - Interrupted and failed turns, failed compactions and unloaded threads all leave items without `item/completed` (`CodexAdapterV2.ts:2264-2267`, `5949`, `4707`), so synthesise terminal states for them.
   - Background commands keep sending `outputDelta`, and can complete *after* `turn/completed` (`4312-4313`, `1927-1930`).
   - A local `item/completed` can arrive while the upstream stream is still retrying (`1986-1987`).
3. **The `turn/start` response versus `turn/started`.**
   - Events for a turn can arrive before the client has processed the `turn/start` response, so buffer them by `turnId`.
   - A response with `startedAt:null` means the turn is queued; an interrupt cannot be delivered until `turn/started` arrives (`7118-7130`).
4. **Races around interrupt.**
   - `turn/interrupt` returns `{}` before the interruption takes effect. If the turn completes normally while the interrupt is in flight, treat it as interrupted (`6160-6165`).
   - **Commands started by the turn can keep running after the interrupt** (fixture `turn_interrupt_mid_tool`: the `commandExecution` never completes, and T3 sends `thread/backgroundTerminals/terminate {threadId, processId}`, which needs `experimentalApi`).
   - If `turn/completed` has not arrived within 10 s, finalise the turn locally.
   - Subagent child turns must be interrupted too.
5. **Races around steer.**
   - Steer only with the current native `turnId` as `expectedTurnId`.
   - If the turn completed first, the steer fails; resend the input as a new `turn/start`.
   - Review and compact turns cannot be steered (`activeTurnNotSteerable`).
   - The steered input appears as a new `userMessage` item inside the same turn.
6. **Restarting the app-server and resuming threads.**
   - When the process exits, every pending request fails. Threads stay on disk.
   - On restart: spawn, send `initialize` and then `initialized`, and for each thread call `thread/resume {threadId, excludeTurns:true, cwd, model, config, approvalPolicy, sandbox}` before its next `turn/start`.
   - `thread/revert` needs the thread loaded.
   - Resuming an archived thread fails; unarchive it and retry.
   - Pending approvals and questions do not survive a restart (T3 capability `pendingRequestsSurviveRestart:false`).
   - The next turn after a restart fires `SessionStart(source:"resume")`.
   - T3 continues a turn cut off by a restart by sending `turn/start` with `input: []` and the previous configuration (`CodexAdapterV2.ts:6799-6812`). How Codex treats an empty-input turn is **UNVERIFIED**.
7. **Exit codes and stderr noise.**
   - Closing stdin gives exit 0. On an unexpected exit, record the code and signal.
   - stderr carries ANSI-coloured `tracing` lines, with `ERROR` used even for harmless config warnings. Never parse it; keep a tail for diagnostics.
   - Shut down by closing stdin first, and send SIGTERM only after a grace period. The docs say `SessionEnd` hooks run on a normal close; whether SIGTERM counts as one is **UNVERIFIED**, and SIGKILL cannot run them.
8. **Update checks.**
   - None were seen from `app-server` (no stdout noise, no prompt) in my probe, and T3 has no handling for one. It looks like a TUI-only feature; **UNVERIFIED** for long runs.
   - App-server does refresh the model catalogue online at startup, which writes `models_cache.json`.
   - Do not run `codex app-server daemon update` (the docs warn it can interrupt work).
9. **Notifications around `initialize`.**
   - None are sent before `initialize`.
   - In the probe, three were sent right after the `initialize` response, before `initialized`.
   - Start the reader before writing anything to stdin.
10. **Large tool outputs.**
    - `item/completed.commandExecution.aggregatedOutput` carries the whole output in one JSON line, and `turn/diff/updated` carries the whole aggregated diff every time.
    - Use a streaming line splitter with a byte cap (T3 uses 128 MiB, `protocol.ts:19-20`), avoid `readline` with unlimited buffers, opt out of `turn/diff/updated`, and never log whole frames.
11. **Image inputs.**
    - Send `{type:"image", url:"data:<mime>;base64,..."}`, as T3 does, or `{type:"localImage", path}`.
    - Check that `inputModalities` from `model/list` includes `"image"`.
12. **Per-thread cwd.**
    - Pass an absolute `cwd` on `thread/start` and `thread/resume`; a `turn/start.cwd` override persists to later turns.
    - `AGENTS.md`, project config and project `.codex/hooks.json` are resolved from the *thread* cwd (`instructionSources` in the response; `hooks/list {cwds}`).
    - Start the app-server with a fixed cwd of its own, because relative `cwd` filters on `thread/list` resolve against the process cwd.
13. **Many concurrent threads in one process.**
    - This is supported and is the normal way to run it. T3 runs **one app-server per provider instance for every T3 thread** (`Orchestrator.ts:961-979`; capability `CodexAdapterV2.ts:238-244`; comment `1804-1805` "Threads share this app-server").
    - The docs describe `thread/loaded/list` and a per-connection subscription to many threads, and say that "every thread in the same app-server process shares the selected Code Mode host connection".
    - In fixture `subagent_v2`, two threads stream on one connection at once.
    - Demultiplex everything by `threadId`. `account/*`, `configWarning` and `remoteControl/*` carry no thread id.
    - **Costs:** one crash takes down every running turn; MCP server children are started per loaded thread; the process's own memory under N active turns is **UNVERIFIED** (each TUI process on this host uses about 100-320 MB of RSS).
14. **One process per instance or per thread, and idle release (T3).**
    - T3 chooses one process per provider instance for Codex, because the capability flag `supportsMultipleProviderThreadsPerSession` is true. Providers without it get one per thread.
    - Idle release kills the process after 30 min with no busy turns (`ProviderSessionManager.ts:56`, `1208-1241`). It is deferred up to 4 h while background work is pending (`57`, `1126-1170`), and that window restarts with each provider event.
    - Idle threads are unloaded with `thread/unsubscribe`. The server then unloads a thread 30 min after its last subscriber leaves (docs). A T3 comment says "a minute after" (`CodexAdapterV2.ts:2352`), which conflicts with the docs: **UNVERIFIED**.
    - Unloading kills that thread's terminals and fires `SessionEnd`.
    - **Health checks:** T3 has no heartbeat on the long-lived process. It is "healthy" until stdout ends. Provider status comes from a *separate* short-lived probe process (`CodexProvider.ts:520-603`, about a 20 s deadline).
15. **Server request ids** have their own counter, starting at 0, separate from client ids. Answer every server request, including unknown ones; `serverRequest/resolved` tells you when the server has cleared a pending one.
16. **Turn and thread overrides persist.** They also apply to turns Codex starts on its own (goal continuations, `CodexAdapterV2.ts:6405-6408`). Re-send policy on every turn.
17. **Reasoning summaries may default to `"none"`.** Send `summary:"detailed"` (or `"auto"`).
18. **Subagents and multi-agent.** Subagents (spawned for example under the `ultra` effort, "automatic task delegation", on `multiAgentVersion:"v2"` models) run as child threads that send their own `turn/*` and `item/*` events on the same connection, without any client request. A child's `turn/completed` can arrive before its parent's. Do not drop these events, and do not merge them into the parent turn.
19. **Wire format differs from the docs in places.** `CodexErrorInfo` values are camelCase. `thread/start.sandbox` uses kebab-case `SandboxMode`, while `turn/start.sandboxPolicy` uses `{type:"dangerFullAccess"}`. Fields typed `bigint` in the bindings arrive as JSON numbers.
20. **Do not run the same thread in the Console's app-server and in a TUI at the same time.** No lock is known.
21. **Console coordination needs re-keying** for one shared app-server (see §6). Hook processes inherit one shared env and one owner pid. Use the stdin `session_id` together with the Console's own thread-to-session map. The MCP `_meta.threadId` path already works.
22. **Experimental surface.** `thread/backgroundTerminals/*`, `collaborationMode` and `additionalContext` on `turn/start`, and `historyMode` and `dynamicTools` on `thread/start` all need `experimentalApi:true`, and may change between CLI versions. Pin the CLI version and regenerate the bindings when it changes.
