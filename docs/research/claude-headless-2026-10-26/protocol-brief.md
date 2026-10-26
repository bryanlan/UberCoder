# Driving Claude Code structurally from Node: headless CLI vs Agent SDK

Date: 2026-10-26. Host: `claude` 2.1.310 (`/home/bryan/.local/bin/claude` -> `~/.local/share/claude/versions/2.1.310`).
SDK inspected: `@anthropic-ai/claude-agent-sdk` 0.3.310 (latest and `next` on npm, published 2026-10-23). Its
`package.json` pins `"claudeCodeVersion": "2.1.310"`, the same build as the installed CLI. Prior brief read first:
`docs/research/codex-app-server-2026-10-26/provider-plugin-abstraction.md` section 4. This brief corrects that
section in three places (see 0.2).

Evidence tags:
- `[OBS rN]`: a throwaway run on this host. The raw frames are in `scratchpad/obs/rN-*.jsonl`. The probe driver is
  `scratchpad/scripts/probe.mjs`.
- `[SDK d.ts:L]`: `scratchpad/sdk/x/package/sdk.d.ts` line L.
- `[SDK mjs:L]`: `sdk.mjs` line L. The file is minified, so the tag gives the line and the code nearby.
- `[BIN]`: documentation strings embedded in the 2.1.310 binary. Many are marked `@internal`.
- `[DOC]`: a code.claude.com page.
- `[T3 f:L]`: `/home/bryan/code/UberCoder/t3code-ref/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` unless named.

How the observations were made without spending quota or touching live state:
- Every run used `CLAUDE_CONFIG_DIR=<scratch>/obs/cfg`, an empty config with no credentials. A turn therefore reaches
  the API step and fails with `Not logged in` (`apiKeySource: none`). No model call was made.
- The cwd was an empty scratch directory.
- The parent session's `CLAUDE*`, `ANTHROPIC_*` and `AGENT_*` variables were stripped from the child environment.
- No MCP servers were started. Hooks came only from a scratch `--settings` file whose hook records its input.
- Processes ran one at a time. Peak RSS was about 257 MB.

---------------------------------------------------------------------------------------------------

## 0. The answer

### 0.1 Summary

Both paths run the same program. The Agent SDK is a TypeScript wrapper that spawns this exact CLI binary with
`--output-format stream-json --verbose --input-format stream-json` and speaks NDJSON over its stdin and stdout
`[SDK mjs:157]`. It does not pass `-p`, and print mode is implied anyway `[OBS r9a]`. On 2.1.310 the CLI speaks the
same control protocol to any process on its pipes, not only to the SDK. I drove it directly through:
- `initialize`, `interrupt`, `set_model`, `apply_flag_settings` (effort), `set_permission_mode`, `mcp_status`,
  `get_settings` `[OBS r2]`;
- many turns on one stdin stream `[OBS r4a, r4c]`;
- mid-turn queueing and `priority:"now"` preemption `[OBS r4a, r4b]`;
- an interrupt after which the process lives on `[OBS r4c]`;
- resume, fork, image input and hooks `[OBS r5a-c, r9c, r4a]`.

Recommendation: **Path A**. Console would own a small stream-json client, the same way it owns the JSON-RPC client
for Codex. It would use the SDK's `sdk.d.ts` as the protocol reference and keep `@anthropic-ai/claude-agent-sdk`
only as an optional type-check dev dependency. Path B is a sound alternative, but T3 shows what it costs: T3 still
had to override the SDK's process spawn (`spawnClaudeCodeProcess`), its MCP passing and its close semantics. See
section 1.4. This is an architecture choice for Bryan.

### 0.2 Corrections to the prior brief

1. Steering. Its `steer: 'native-cancels-tools'` reading came from T3 comments written against SDK 0.3.276. Since
   0.3.286 a person's `priority:"now"` message moves running shell commands, agents and MCP calls to the
   background instead of cancelling them (SDK changelog). A message with no priority queues and, per the SDK types,
   folds into the running turn at the next tool boundary (fold UNVERIFIED by observation). So the best fit on 2.1.310 is
   `steer: 'native'`; see section 4.
2. Interrupt. It is not `ends-process`. The process survives an interrupt and runs the next turn `[OBS r4c]`. T3's
   "interrupt then close" is T3's own policy.
3. `priority`. The field exists on `SDKUserMessage` as `'now' | 'next' | 'later'` `[SDK d.ts:6545]`. It has no
   public description; its behaviour is documented only in `@internal` binary strings and the changelog.

### 0.3 Proposed Claude plugin capabilities

| Capability | Value | Basis |
|---|---|---|
| `processModel` | `'per-session'` | One CLI process per conversation. |
| `nativeIds` | `'client-allocated'` | `--session-id <uuid>` `[OBS r3]`. |
| `resume` | `'reattach'` | A new process with `--resume <id>` loads the transcript and does not re-emit history `[OBS r5a]`. |
| `steer` | `'native'` | A plain message folds at the next tool boundary (documented, UNVERIFIED); `priority:"now"` preempts `[OBS r4b]`. |
| `interrupt` | `'terminal-follows'` | `[OBS r4c]`. |
| `images` | `true` | `[OBS r9c]`. |
| `enforcement` | `'native'` | bypassPermissions, but the host must still answer `can_use_tool`. |
| `modelSwitch` | `'next-turn'` | `set_model`, and `apply_flag_settings` for effort, with no restart `[OBS r2]`. |

---------------------------------------------------------------------------------------------------

## 1. Path A (CLI stream-json) vs Path B (Agent SDK): what the SDK actually does

### 1.1 The argv the SDK spawns

From `ProcessTransport.initialize()` `[SDK mjs:157, the block starting let W=["--output-format","stream-json","--verbose","--input-format","stream-json"]]`.
Arguments always present:

```
<executable> [executableArgs...] --output-format stream-json --verbose --input-format stream-json
```

Each option adds an argument, in this order:

| SDK option | argv it adds |
|---|---|
| `thinking` | `--thinking=adaptive`, `--thinking=disabled` or `--max-thinking-tokens=N`; plus `--thinking-display=` |
| `effort` | `--effort=<level>` |
| `maxTurns` | `--max-turns=N` |
| `maxBudgetUsd` | `--max-budget-usd=N` |
| `taskBudget` | `--task-budget=N` |
| `model` | `--model=<m>` |
| `agent` | `--agent=` |
| `betas` | `--betas=` |
| `jsonSchema` | `--json-schema=` |
| `debugFile` / `debug` | `--debug-file=` or `--debug` |
| `canUseTool` | `--permission-prompt-tool=stdio`. It may not be combined with `permissionPromptToolName`, which gives `--permission-prompt-tool=<name>` |
| `permissionPrompts` | `--permission-prompts=` |
| `continue` | `--continue` |
| `resume` | `--resume=<id>` |
| `channels` | `--channels=` |
| `allowedTools` | `--allowedTools=a,b` |
| `disallowedTools` | `--disallowedTools=` |
| `tools` | `--tools=`, or `--tools=default` |
| `mcpServers` | `--mcp-config {"mcpServers":{...}}` (inline JSON in argv) |
| `settingSources` | `--setting-sources=` |
| `strictMcpConfig` | `--strict-mcp-config` |
| `permissionMode` | `--permission-mode=` |
| `allowDangerouslySkipPermissions` | `--allow-dangerously-skip-permissions` |
| `fallbackModel` | `--fallback-model=` |
| `includeHookEvents` | `--include-hook-events` |
| `includePartialMessages` | `--include-partial-messages` |
| `sessionMirror` | `--session-mirror` |
| `projectConfigRoot` | `--project-config-root=` |
| `additionalDirectories` | `--add-dir=` |
| `pluginDelivery: 'initialize'` | `--await-initialize`; otherwise `plugins` gives `--plugin-dir=` / `--plugin-dir-no-mcp=` |
| `forkSession` | `--fork-session` |
| `resumeSessionAt` | `--resume-session-at=` |
| `resumeDropsTurn` | `--resume-drops-turn=` |
| `sessionId` | `--session-id=` |
| `persistSession:false` | `--no-session-persistence` |
| `managedSettings` | `--managed-settings` |
| `settings` / `sandbox` and `extraArgs` | `--settings=<json or path>`, plus any `extraArgs` as `--key=value` |

What the SDK does not put in argv:
- the system prompt;
- `appendSystemPrompt`, agents and hooks;
- SDK-hosted MCP servers.

These travel in the `initialize` control request `[SDK mjs:159, buildInitializeRequest]`.

Environment the SDK gives its child `[SDK mjs:163, the block that builds the env with pt.CLAUDE_CODE_ENTRYPOINT="sdk-ts"; also mjs:157]`:
- `CLAUDE_CODE_ENTRYPOINT=sdk-ts` (unless already set);
- `CLAUDE_AGENT_SDK_VERSION=0.3.310`;
- `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`, which turns on `system/session_state_changed` frames. Verified on
  path A `[OBS r10]`.
- `NODE_OPTIONS` and `DEBUG` deleted.

Default executable: the per-platform optional package `@anthropic-ai/claude-agent-sdk-linux-x64`, a native binary of
about 290 MB (`manifest.json`). Override it with `pathToClaudeCodeExecutable`.

Close sequence `[SDK mjs:157, ProcessTransport.close()]`:
1. End stdin.
2. After 2000 ms, if the process is still alive, send `SIGTERM`.
3. After 5000 ms more, send `SIGKILL`.

It signals only the pid, not a process group. A process-wide exit hook sends `SIGTERM` to every child the SDK tracks.

### 1.2 Wire envelope (both directions, one JSON object per line)

- Client to CLI user message: `{"type":"user","session_id":"","message":{"role":"user","content":[...]},"parent_tool_use_id":null}`
  `[SDK mjs:163, function vv]`. Optional fields: `uuid`, `priority`, `origin`, `shouldQuery`, `client_composed`,
  `pasted_content`, `requeue_if_interrupted_within_ms` (@internal) `[SDK d.ts:6533-6628; BIN]`. String `content`
  also works `[OBS r11]`.
- Control request, either direction: `{"type":"control_request","request_id":"<sender-unique>","request":{"subtype":...}}`
  `[SDK d.ts:5223]`.
- Control response: `{"type":"control_response","response":{"subtype":"success","request_id":...,"response":{...}}}`
  or `{"subtype":"error","request_id":...,"error":"text"}` `[SDK d.ts:397-440]`.
- Withdrawal: `{"type":"control_cancel_request","request_id":...}`. Either side may withdraw its own pending
  request. There is no reply `[SDK d.ts:3984]`.
- The SDK reader also routes these stdout types `[SDK mjs:157, readMessages]`:
  - `keep_alive`, which it ignores;
  - `transcript_mirror`;
  - `active_goal` and `autocompact_state`;
  - `system/{post_turn_summary,task_summary,session_metadata}`.

  Everything else is an `SDKMessage`.

### 1.3 Control subtypes

Client to CLI (`SDKControlRequestInner` `[SDK d.ts:5234]`; all of the `subtype:"..."` literals in `sdk.mjs`):
- Core: `initialize`, `interrupt` (`cancel_queued?`), `set_permission_mode {mode}`, `set_model {model}`,
  `set_max_thinking_tokens`, `apply_flag_settings {settings}` (for example `{effortLevel}`),
  `update_settings`, `get_settings`, `get_context_usage {detail}`, `get_usage`, `list_models`, `mcp_status`.
- MCP: `mcp_set_servers`, `mcp_reconnect`, `mcp_toggle`, `mcp_call`, `mcp_read_resource`.
- Background tasks: `stop_task {task_id}`, `background_tasks {tool_use_id?}`, `get_task_output`.
- Queue and session: `cancel_async_message {message_uuid}`, `rewind_files`, `seed_read_state`, `read_file`,
  `rename_session`, `reload_plugins`, `reload_skills`, `reload_output_styles`, `list_permission_rules`,
  `get_hooks_listing`.
- Others not needed by Console: `side_question`, `generate_session_title`, `export_conversation`,
  `remote_control`, `claim_session`, the OAuth, Chrome and feedback subtypes, `set_cwd`, `channel_enable`.

CLI to client (handled in `Query.processControlRequest` `[SDK mjs:159]`):
- `can_use_tool`: the permission request; see section 6.
- `hook_callback {callback_id, input, tool_use_id}`: only for hooks the client registered in `initialize`.
- `mcp_message {server_name, message}`: only for SDK-hosted MCP servers.
- `elicitation`: the SDK answers `{action:"decline"}` when no handler is set.
- `request_user_dialog`: sent only for kinds the client declared in `initialize.supportedDialogKinds`.
- `oauth_token_refresh` and `host_auth_token_refresh`: only when the host advertised refresh support.
- `remote_control_work_secret`.
- `remote_tool_call`, `remote_plumbing_call`, `remote_tools_probe`, `remote_tools_reannounce`: the SDK leaves
  these four deliberately unanswered (constant `G9`).

The `initialize` request `[SDK d.ts:4667; mjs:159]` can carry:
- `hooks` (callback ids per matcher) and `sdkMcpServers`;
- `systemPrompt`, `appendSystemPrompt` and `systemPromptSnapshot`;
- `agents`, `title` and `skills`;
- `promptSuggestions` and `forwardSubagentText`;
- `supportedDialogKinds` and `perTaskStopAffordance`;
- the undocumented `rapidFollowupPreempt`;
- the undocumented `workspaceTrust {accepted, directory}`;
- `plugins`.

The response carries `commands`, `agents`, `models[]` (with `supportedEffortLevels`), `account`, `pid`,
`claude_code_version`, `current_permission_mode`, `hooks_applied`, `session_state` and `capabilities`, plus
`pending_permission_requests[]` on the envelope `[OBS r2]`. It needs no model call. T3 uses it as its probe
(prior brief, `ClaudeProvider.ts:343-431`). `initialize` is optional on path A: a user message with no
`initialize` runs normally `[OBS r11]`.

`priority:"now"`: it exists, and it acts. See section 4.

### 1.4 Path comparison

| | A: own stream-json client | B: Agent SDK `query()` |
|---|---|---|
| Binary | User's `claude` (auto-updates) | Bundled 290 MB optional package, or `pathToClaudeCodeExecutable` |
| New dependencies | None | SDK plus peer deps `zod@^4`, `@anthropic-ai/sdk>=0.93`, `@modelcontextprotocol/sdk@^1.29` |
| Spawn control | Console owns it: `setpriv --pdeathsig`, own process group, env scrub, pid/start-ticks meta (as the Codex plugin does) | SDK `spawnLocalProcess` signals pid only; T3 had to inject `spawnClaudeCodeProcess` to get a group and a watcher `[T3 :317-352, :945]` |
| MCP config | Console chooses argv or `mcp_set_servers` | SDK puts `mcpServers` in argv; T3 strips them and sends over control `[T3 :917-921]` |
| Close | Console chooses: EOF, then group SIGTERM, then SIGKILL | EOF, 2 s, SIGTERM, 5 s, SIGKILL on the pid |
| Protocol drift | Console tracks it: feature-detect `system/init.capabilities`, record fixtures | The vendor absorbs it (run-end ceilings, re-delivered pending prompts, `reinitialize`) |
| Docs status | The CLI page documents stream-json in and out. The control protocol is documented only as SDK types, and several fields are `@internal` | Documented API |
| Version coupling | Any CLI; gate on capabilities | SDK 0.3.N is built against CLI 2.1.N. With the user's binary, versions drift |
| Fit with Console | Mirrors `transport/codex/` (hand-written JSON-RPC client, plugin-owned process) | Adds a second process-lifecycle owner inside the plugin |

Why A:
- The subset Console needs is small. Clients write `user`, `initialize`, `interrupt`, `set_model`,
  `apply_flag_settings`, `get_context_usage` and `control_response` (for `can_use_tool` and `elicitation`).
- The process-lifecycle work (parent death, group kill, stale-process reap) is already built and reviewed for Codex.
- Each request and frame type Console needs was observed working on this exact version, except those listed in
  section 14.

Risks of A:
- Console must follow protocol changes itself.
- Anthropic's docs steer programmatic users toward the SDK.

Mitigations:
- Gate features on `capabilities` (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`,
  `interrupt_requeue_taken_v1`, `msg_lifecycle_v1`, ... `[OBS r3]`).
- Pin a tested CLI version range in `probe()`.
- Keep the SDK `.d.ts` as a dev-only type reference.
- Keep recorded wire fixtures.

Licence: the SDK package is "SEE LICENSE IN README.md" (Anthropic Commercial Terms), not MIT. Use it as a
reference; do not copy its code. T3's code is MIT and may be copied with its notice.

---------------------------------------------------------------------------------------------------

## 2. Wire shapes on 2.1.310 (path A)

Launch used in the probes (Console would add `--model`, `--effort`, `--mcp-config`, `--append-system-prompt`):

```
claude --output-format stream-json --verbose --input-format stream-json \
  [--include-partial-messages] [--replay-user-messages] \
  (--session-id <uuid> | --resume <id> [--fork-session [--session-id <new>]]) \
  --permission-mode bypassPermissions --allow-dangerously-skip-permissions   # or --dangerously-skip-permissions
  [--permission-prompt-tool stdio]
```

- `-p` is optional. Without `--verbose` the CLI refuses: `Error: When using --print, --output-format=stream-json requires --verbose` `[OBS r9a]`.
- `-p` plus the same flags behaves the same `[OBS r9b]`.

### 2.1 Input

- Text:
  ```json
  {"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"..."}]},
   "parent_tool_use_id":null,"uuid":"<fresh uuid>","origin":{"kind":"human"}}
  ```
- Image, accepted `[OBS r9c]`. Put images before the text; T3 orders them that way so slash-command text still expands `[T3 :1929-1945]`:
  ```json
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}
  ```
  The transcript stores the base64 inline. The CLI also writes the image to
  `/tmp/claude-<uid>/<escaped-cwd>/<session>/images/1.png` and adds an `isMeta` user record naming that path `[OBS r9c]`.
- Always send `origin:{kind:"human"}` for a person's input:
  - The SDK says "A host wrapping keyboard input must stamp {kind:'human'} explicitly — absent origin is treated as
    unattributed and fails closed at strict isHuman() trust gates" `[SDK d.ts:5582]`.
  - With the stamp the transcript records `turnOrigin:"human"`; without it, `"sdk"` `[OBS r3 vs r4a]`.
  - Console's mid-turn transcript parser requires `origin.kind === 'human'` (`apps/server/src/providers/transcripts/claude.ts:61-62`).
  - Peer messages could use `origin:{kind:"peer", from, ...}` `[SDK d.ts:5590]`.

### 2.2 Output sequence for one turn

Observed `[OBS r3, r4a, r10]`. Times are ms from spawn, with no MCP:
1. `system/hook_started` and `system/hook_response` for `SessionStart`, at about 346 ms. These arrive before the `initialize` reply and are always emitted.
2. The `initialize` `control_response` (if sent), at about 360-440 ms.
3. Optional: `system/session_state_changed {state:"running", sdk_host_only:true}`, only with `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` `[OBS r10]`.
4. `command_lifecycle {command_uuid:<our uuid>, state:"queued"}`, then `{state:"started"}`.
5. `system/init`. It is sent per turn, after `UserPromptSubmit` hooks.
6. `system/status {status:"requesting", user_message_uuids}`.
7. With `--replay-user-messages`: our user message echoed back with `isReplay:true`.
8. With `--include-partial-messages`: `stream_event {event: <Messages API stream event>, parent_tool_use_id}` `[SDK d.ts:5739]`. Not observed (it needs the model).
9. `assistant`. A model error such as an API failure gives a synthetic message (`model:"<synthetic>"`, `error:"authentication_failed"`, `is_api_error_message:true`).
10. `user` messages carrying `tool_result` blocks, with `tool_use_result` structured output `[SDK d.ts:6544]`.
11. `result`, exactly one per turn.
12. `command_lifecycle` terminal state: `completed` or `cancelled`.
13. Optional: `system/session_state_changed {state:"idle"}`. The CLI calls it the "authoritative turn-over signal" (it fires after held-back results and background agents) `[BIN]`.

Notes on step 9 and the init frame:
- With real model output, assistant messages arrive one per completed content block, and several share
  `message.id` `[T3 :7651]`.
- Observed `system/init` keys `[OBS r3]`: `cwd`, `session_id`, `tools[]`, `mcp_servers[{name,status,source?}]`,
  `model`, `permissionMode`, `slash_commands`, `terminal_slash_commands`, `apiKeySource`, `claude_code_version`,
  `output_style`, `agents`, `skills`, `plugins`, `capabilities`, `analytics_disabled`, `product_feedback_disabled`,
  `uuid`, `memory_paths`, `original_cwd`, `additional_directories`, `messaging_socket_path`, `fast_mode_state`,
  `fast_mode_disabled_reason`, `per_turn_effort_active`, `view_mode`, `user_message_uuids`.
- `effort` is absent on headless init frames. It appears only on Remote Control bridge inits `[SDK d.ts:6254]`.

### 2.3 Result

Observed keys `[OBS r3]`: `type`, `subtype`, `is_error`, `duration_ms`, `duration_api_ms`, `num_turns`, `result`,
`stop_reason`, `session_id`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `terminal_reason`,
`api_error_status`, `user_message_uuid`, `user_message_uuids`, `queued_turn_count`, `result_index`,
`model_usage_since_last_result`, `subagent_stats`, `safety_stops`, `fast_mode_*`, `uuid`.

- `subtype` is `success` or `error_during_execution | error_max_turns | error_max_budget_usd | error_max_structured_output_retries` `[SDK d.ts:5933-6095]`.
- An API failure is `subtype:"success"` with `is_error:true` and `terminal_reason:"api_error"` `[OBS r3]`. T3 relies on the same rule `[T3 :3027-3060]`.
- An interrupt gives `error_during_execution`, `terminal_reason:"aborted_streaming"` (or `aborted_tools`), and `errors[]` `[OBS r4c]`.
- `TerminalReason` values `[SDK d.ts:10048]`: `blocking_limit`, `rapid_refill_breaker`, `prompt_too_long`,
  `image_error`, `model_error`, `api_error`, `malformed_tool_use_exhausted`, `aborted_streaming`, `aborted_tools`,
  `stop_hook_prevented`, `hook_stopped`, `tool_deferred`, `max_turns`, `background_requested`, `completed`,
  `budget_exhausted`, `structured_output_retry_exhausted`, `tool_deferred_unavailable`, `turn_setup_failed`.
- `total_cost_usd` and `modelUsage` are cumulative across turns in one process; read the latest result. `usage` is per turn and covers the main loop only `[SDK d.ts:5945-5953]`.

### 2.4 Other frames to map

All from `[SDK d.ts:5579]` and `[DOC headless]`:
- `system/api_retry {attempt, max_retries, retry_delay_ms, error_status, error}`: map to a notice; a 429 is a usage limit.
- `rate_limit_event {rate_limit_info:{status allowed|allowed_warning|rejected, resetsAt (epoch s), rateLimitType, utilization, overage*}}` `[SDK d.ts:5893]`.
- `system/compact_boundary` and `system/status {status:"compacting"}`.
- `system/task_started | task_progress | task_updated | task_notification` and `system/background_tasks_changed`.
- `system/permission_denied`, `system/informational` (warnings since 0.3.283), and `system/hook_*`.
- `prompt_suggestion`, only when enabled.

### 2.5 Exit behaviour

| Situation | Exit | Evidence |
|---|---|---|
| EOF while idle | Exit code 0 about 150 ms later, if the last result was not an error or no turn ran | `[OBS r1, r2, r7b]` |
| EOF while idle, last result an error | Exit code 1 | `[OBS r3]` |
| EOF during a turn | The turn finishes and its `result` is written; `StopFailure` (or `Stop`) and then `SessionEnd` hooks run; then exit | `[OBS r4d]` |
| SIGTERM during a turn | Exit code 143, no `result`. `SessionEnd` runs. A prompt not yet sent to the model is not written to the transcript, and the session `66666666` had no transcript file at all | `[OBS r4e]` |
| Startup or argv errors | Exit code 1; the message goes to stderr with ANSI colours, and no JSON is written. Examples: `Session ID ... is already in use.`, `--session-id can only be used with --continue or --resume if --fork-session is also specified.` | `[OBS r5d, r7a]` |
| Resume of an unknown id | A JSON `result` `error_during_execution` with `errors:["No conversation found with session ID: ..."]`, the same text on stderr, exit 1 | `[OBS r5b]` |

The docs agree about SIGTERM: "Claude Code exits with code 143. Claude Code leaves the turn that was in progress
unfinished and records no result for it." On SIGTERM the CLI "terminates the process tree of any Bash command that
is still running", then runs `SessionEnd` hooks `[DOC headless]`.

---------------------------------------------------------------------------------------------------

## 3. Session semantics

- New session:
  - `--session-id <uuid>`. `system/init.session_id` equals it, and the transcript is written to
    `$CLAUDE_CONFIG_DIR/projects/<escaped-cwd>/<uuid>.jsonl` `[OBS r3]`.
  - The cwd is escaped by replacing non-alphanumeric characters with `-`. A name over 200 characters is truncated and
    a hash is appended `[DOC sessions]`.
  - Reusing an id that already has a transcript fails: `Error: Session ID ... is already in use.` `[OBS r7a]`. T3
    notes the same `[T3 :9273-9279]`.
- Resume: `--resume <id>` keeps the same session id and appends to the same file `[OBS r5a]`. It also accepts a
  transcript path, and it searches all projects on the machine `[DOC cli-reference]`.
- Fork: `--resume X --fork-session` gives a new id. Add `--session-id <new>` to choose it. The original file is
  untouched `[OBS r5c]`. `--session-id` with `--resume` but no fork is rejected `[OBS r5d]`.
- `--continue` picks the most recent session in the cwd. Note that the TUI's `--continue` and picker skip `-p` and
  SDK sessions: "Claude Code leaves sessions created with claude -p or the Agent SDK out of the session picker and
  out of claude --continue. You can still resume one by passing its session ID to claude --resume <session-id>."
  `[DOC sessions]`. Any Console fallback that uses `--continue` must switch to `--resume <id>`.
- Many turns per process: yes, on one stdin stream. Observed 2-3 turns per process `[OBS r4a, r4c]`. No restart per
  turn is needed.
- Same transcript format as the TUI. The record families match: `user`, `assistant`, `attachment`,
  `queue-operation`, `api-request(-blob/-shape)`, `last-prompt`, `cost-state`, and others. Differences are
  `entrypoint` (`sdk-cli` on path A, `sdk-ts` under the SDK, `cli` in the TUI), `promptSource` (`sdk` vs `typed`)
  and `turnOrigin` (`human` only when `origin` is stamped) `[OBS r3, r4a; TUI transcript of this session]`.
  Console's parser reads none of these three fields.
- Cross-resume:
  - TUI to headless and headless to TUI both work by id per the docs, since resume finds any session by id
    `[DOC sessions]`. UNVERIFIED by running a TUI resume here.
  - The format is the internal one: "The entry format is internal to Claude Code and changes between versions,
    so scripts that parse these files directly can break on any release" `[DOC sessions]`.
- One writer: Console must enforce it. Two processes resumed the same session at once with no refusal, and both
  wrote to one file `[OBS r6a/r6b]`. The docs agree: "If you resume the same session in two terminals without
  forking, messages from both interleave into one transcript." `[DOC sessions]`. The CLI refuses only a session held
  by a `--bg` background session (`session_held_by_background` `[SDK d.ts:6171]`).
  - Useful signal: each live process registers `~/.claude/sessions/<pid>.json` with `{pid, sessionId, cwd, kind,
    entrypoint, status: idle|busy|waiting, messagingSocketPath, tmux?, ...}`. Headless processes do too, recorded
    with `kind:"interactive"` and `entrypoint:"sdk-cli"` `[OBS r6a]`. Console can check it before a resume, alongside
    its own pid, start-ticks and boot-id meta.
- Empty sessions: a session whose first prompt never reached the model has no transcript file. `--resume` then fails
  with "No conversation found", while `--session-id` still works because the id is unused. T3's rule: resume only
  if a provider turn persisted, and refuse resume when the transcript is empty `[T3 :9272-9279, :10004, :10120-10131]`.
- Flags that are not restored on resume and must be passed again: `--mcp-config`, `--settings`, `--plugin-dir`,
  `--fallback-model`, `--add-dir` `[DOC sessions]`. Permission mode on `-p --resume` restarts from the `-p`
  default (Manual), so pass `--dangerously-skip-permissions` on every launch `[DOC sessions]`.
- System prompt snapshot (`--system-prompt-snapshot`, on by default): "the prompt is rendered on the conversation's
  first request — a --system-prompt or --append-system-prompt included — sent, and recorded; every later request and
  resume sends the record as-is, even when a later launch passes different text, until the conversation is
  compacted" (`claude --help`). Changed authority text in `--append-system-prompt` therefore does not reach a resumed
  conversation unless the run passes `--system-prompt-snapshot off`. This applies to the tmux path too. UNVERIFIED
  end to end.

---------------------------------------------------------------------------------------------------

## 4. Mid-turn input

Observed with a 3-second `UserPromptSubmit` hook, which holds the turn open before any model call:

- Default (no priority) `[OBS r4a]`:
  - A second message is queued at once (`command_lifecycle queued`).
  - Here it ran as the next turn after the first ended. The first result had `queued_turn_count:1`; the second
    result came with `result_index:1`.
  - With real tool rounds the docs say queued messages fold into the running turn: `user_message_uuids` lists
    "every user message whose prompt this turn consumed ... then any queued user message folded into the running
    turn between tool rounds" `[SDK d.ts:5972]`. The `command_lifecycle` notes say a folded command emits
    `completed` before the turn's `result` `[BIN]`. Fold behaviour is UNVERIFIED by observation: it needs model
    tool calls.
- `priority:"now"` `[OBS r4b]`:
  - The urgent message started at once. The running first prompt (still before its model call) went back into the
    queue and ran again afterwards. Its `UserPromptSubmit` hook ran twice.
  - The preempted attempt produced no `result`. The two results were for "now" and then the re-run first prompt.
  - Behaviour during tool calls, from the changelog and binary docs, UNVERIFIED by observation: since 0.3.286
    "Changed a person's priority `now` message to move running shell commands, agents and MCP calls to the
    background" (SDK CHANGELOG; WebFetch summary). Binary `@internal` text: the CLI stops the running turn "exactly
    as a priority 'now' message would have (running shell commands are backgrounded, not killed)", and an MCP server
    can opt out of backgrounding, in which case a `now` message "interrupts the turn and so ends the call" `[BIN]`.
    The stopped turn's result carries `terminal_reason` `aborted_streaming` or `aborted_tools` `[BIN]`.
  - The rule applies to "a person's" message, so stamp `origin:{kind:"human"}`.
- `priority:"later"`: queued behind running work so a running turn cannot reorder it (`[BIN]` describes `/effort`
  then prompt sends "at priority 'later' so a running turn cannot reorder them"). `next` is the field's other value.
  Neither is publicly documented.
- Implications for the Console host:
  - steer = send a plain user message while the turn runs. It folds at the next tool boundary, like Codex
    `turn/steer`.
  - "Send now" = `priority:"now"`. This replaces T3's need to move foreground subagents to the background first
    `[T3 :9821-9881]` on 2.1.286 and later.
  - Correlate by uuid. Every `result` and `assistant` carries `user_message_uuids`, so the host maps one turn
    terminal onto every send it consumed.
- Duplicate uuid: resending a uuid already in the transcript (here across a `--resume`) gives the replay echo, then
  `command_lifecycle completed` with no `started`, no turn and no `result` `[OBS r7b]`. Changelog 0.3.290 says
  "Fixed a user message sent again under the same uuid being replayed", yet 2.1.310 still echoed it across a
  resume. Do not rely on whether the echo appears. T3 always mints a fresh uuid for that reason `[T3 :9427-9443]`.
  Console can use this for idempotent resend: re-sending the same uuid after an uncertain write cannot double-run.
  The host must accept a `completed` lifecycle without a `result` as "already handled".
- `queued_command` transcript records:
  - In this session's TUI transcript, human mid-turn input looks like
    `attachment {type:"queued_command", prompt, source_uuid, delivery_id, commandMode:"prompt", humanTurn:true,
    origin:{kind:"human"}, timestamp}`. Peers use `origin.kind:"peer"` with `isMeta`.
  - None of the 30 recent transcripts on this host holds a headless one. The headless shape is UNVERIFIED and is
    expected to be the same when `origin` is stamped.
  - Caveat from the docs: an interrupt can leave a folded message's `queued_command` attachment in the aborted
    turn's transcript although it never runs `[SDK d.ts:4822]`.

---------------------------------------------------------------------------------------------------

## 5. Interrupt and stop

- Request: `{"type":"control_request","request_id":"int1","request":{"subtype":"interrupt"}}`.
- Response, received in about 5 ms: `{"type":"control_response","response":{"subtype":"success","request_id":"int1","response":{"still_queued":["<uuid>"]}}}` `[OBS r4c]`.
- `cancel_queued:true` also drops queued sends and lists them under `cancelled` `[OBS r4c; SDK d.ts:4818-4850]`.
- Then the interrupted turn's `result`: `subtype:"error_during_execution"`, `terminal_reason:"aborted_streaming"`,
  `errors:["prompt_check: the turn was stopped before its prompt was checked"]`, `num_turns:0` `[OBS r4c]`.
- The process survives. Queued messages run next unless `cancel_queued` was set. A new message after the interrupt
  ran normally `[OBS r4c]`.
- The transcript records a `user` row `[Request interrupted by user]`. When the interrupt lands before the model
  call, the prompt itself is not recorded `[OBS r4c]`. Console's run monitor already treats that row as a native
  interruption (`apps/server/src/providers/transcripts/claude-run-state.ts:22-31`).
- No `Stop` or `StopFailure` hook fires for an interrupted turn `[OBS r4c]`.
- Background tasks: unless `initialize` declares `perTaskStopAffordance:true`, "the interrupt kills background
  tasks" `[SDK d.ts:1826-1845]`. To keep background agents alive across Stop, declare it and stop tasks one at a
  time with `stop_task`.
- T3's policy is `interrupt()` then `close()`, with up to 10 s for the process to exit; the next turn reopens with
  `--resume` `[T3 :9777-9790]`. It is a choice, not a requirement. Console can keep the process (cheaper) and use
  close only as a fallback when no `result` follows within a timeout.
- For a real Stop that also drops queued sends: `interrupt {cancel_queued:true}` (capability `interrupt_cancel_queued_v1`).

---------------------------------------------------------------------------------------------------

## 6. Permissions and questions

- Modes: `default` (shown as Manual; the CLI accepts `manual` as an alias), `acceptEdits`, `plan`, `auto`,
  `dontAsk`, `bypassPermissions`. `--dangerously-skip-permissions` is "Equivalent to `--permission-mode
  bypassPermissions`" `[DOC cli-reference]`. `claude --help` lists `manual` in place of `default`.
- `-p` default: "In Claude Code v2.1.302 or later, claude -p and Agent SDK runs with no permission mode set start
  in Manual mode ... Calls needing approval are denied unless you approve them with an allow rule, hook, canUseTool
  callback, or --permission-prompt-tool." `[DOC permission-modes]`. The SDK's own doc comment says omitted means
  settings `defaultMode`, else `auto` where available `[SDK d.ts:2018-2031]`. Either way, always pass the mode
  explicitly.
- No prompt host (no `--permission-prompt-tool`): a call that needs approval is denied `[DOC headless]`.
  `--permission-prompts none` also removes `AskUserQuestion` from the tool list. Denials appear as
  `system/permission_denied` and in `result.permission_denials` `[DOC headless]`.
- Under bypassPermissions, the following still prompt. The doc's wording: "Claude Code doesn't auto-approve the
  following in any mode, including bypassPermissions":
  - explicit ask rules;
  - organisation `ask` connectors;
  - "the built-in AskUserQuestion tool and MCP tools marked requiresUserInteraction";
  - critical-path `rm` and `rmdir`;
  - "the cross-session messaging safeguards";
  - reads outside the working directories when `blockReadsOutsideWorkingDirectories` is on.

  `[DOC permission-modes]`.

  With `--permission-prompt-tool stdio` these arrive as `can_use_tool` control requests. Without it they are
  denied. Bryan's own settings may contain ask rules, which would prompt even under bypass.
- `ExitPlanMode` matters only when a session is in plan mode. "Plan mode keeps its blocks wherever Claude Code runs
  without an interactive terminal, including non-interactive runs with -p, Agent SDK sessions" `[DOC permission-modes]`.
  Changelog 0.3.269: plan mode routes writes through `canUseTool` even with `allowDangerouslySkipPermissions`.
  Whether `ExitPlanMode` itself reaches `can_use_tool` under bypass is UNVERIFIED. T3 handles it in `canUseTool`
  `[T3 :8931-8990]`.
- `can_use_tool` request (CLI to host) `[SDK d.ts:5014-5072]`:
  ```json
  {"type":"control_request","request_id":"...","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion",
   "input":{...},"tool_use_id":"...","permission_suggestions":[...],"decision_reason":"...","decision_reason_type":"...",
   "title":"...","display_name":"...","description":"...","agent_id":"...","requires_user_interaction":true,...}}
  ```
- Response (host to CLI), shape from `[SDK mjs:159]` and `PermissionResult` `[SDK d.ts:2571]`:
  ```json
  {"type":"control_response","response":{"subtype":"success","request_id":"<same>","response":
    {"behavior":"allow","updatedInput":{...},"updatedPermissions":[...],"toolUseID":"<tool_use_id>"}}}
  ```
  For deny: `{"behavior":"deny","message":"...","interrupt":false,"toolUseID":"..."}`.
  - Answers to `AskUserQuestion` go in `updatedInput: {questions: <as received>, answers: {"<question text>": "<label>" | ["a","b"]}, response?: "<free text>"}` `[DOC agent-sdk/user-input]`.
  - Before v2.1.207, an allow without `updatedInput` was rejected; now the original input is used.
- An unanswered request blocks the turn: "The callback can stay pending indefinitely. Execution remains paused until
  your callback returns." `[DOC agent-sdk/user-input]`. The CLI may withdraw it with `control_cancel_request`, for
  example after an interrupt.
- Slice-1 policy equivalent to Codex: launch with `--dangerously-skip-permissions --permission-prompt-tool stdio`.
  1. Answer every `can_use_tool` at once with `deny`, with a message such as "Ask in plain text in your reply
     instead", and record a `status` event.
  2. Answer `elicitation` with `{action:"decline"}`.
  3. Declare no `supportedDialogKinds`, so `request_user_dialog` never arrives.

  The alternative `--permission-prompts none` removes `AskUserQuestion` and needs no answers, but Claude then
  cannot ask at all.

---------------------------------------------------------------------------------------------------

## 7. Hooks and MCP in headless

- Settings hooks run in headless:
  - With hooks from a `--settings` file I observed `SessionStart` (`source:"startup"`), `UserPromptSubmit`,
    `StopFailure` (an API-error turn fires `StopFailure`, not `Stop`) and `SessionEnd` (`reason:"other"`) `[OBS r4a]`.
  - User and project hooks load the same way: "Without --bare, claude -p discovers and loads them as an interactive
    session would, including anything configured in the working directory or ~/.claude" `[DOC headless]`.
  - `Stop` on success and `PostToolUse` need the model. UNVERIFIED here; documented.
- `SessionStart` runs at process start, before the first prompt, and before the `initialize` reply. A new session's
  id is therefore known (`--session-id`) when the hook fires.
- Hook stdin `[OBS r4a]`:
  - All events: `session_id`, `transcript_path`, `cwd`, `hook_event_name`.
  - `SessionStart`: `source`.
  - `UserPromptSubmit`: `prompt_id`, `permission_mode`, `prompt`.
  - `StopFailure`: `prompt_id`, `effort:{level}`, `error`, `last_assistant_message`.
  - `SessionEnd`: `reason`.
- Hook environment `[OBS r4a]`:
  - It inherits the CLI process environment, so a per-process `AGENT_CONSOLE_SESSION_ID` reaches every hook.
  - Also set: `CLAUDE_CODE_SESSION_ID=<session id>`, `CLAUDE_PROJECT_DIR=<cwd>`, `CLAUDE_CODE_ENTRYPOINT=sdk-cli`,
    `CLAUDECODE=1`.
  - Unlike Codex's shared app-server, one process per session means the TUI-path identity rule keeps working
    unchanged.
- Hook events in the stream: only `SessionStart` and `Setup` by default. `--include-hook-events` adds the rest
  (some never emit `hook_started`) `[DOC cli-reference]`.
- `--mcp-config <json|file>`: "When you pass this flag with -p, Claude Code waits for still-pending servers to
  connect before running the first turn, up to the MCP_TIMEOUT startup timeout, 30 seconds by default"
  `[DOC cli-reference]`.
  - `--strict-mcp-config` ignores every other MCP configuration.
  - Invalid entries are skipped and listed in `system/init.mcp_server_errors` `[DOC headless]`.
  - Not run here, because starting MCP servers was out of bounds. `mcp_status` with no servers returned
    `{"mcpServers":[]}` `[OBS r2]`.
  - Console's current per-session `--mcp-config` JSON, which carries `AGENT_CONSOLE_SESSION_ID`, carries over
    as is. The `mcp_set_servers` control request is the argv-free alternative T3 uses for secrets `[T3 :917-921]`.
- `--settings <json|file>` works for injecting hooks `[OBS r4a]`. Flag settings sit above user, project and local,
  and below managed settings `[SDK d.ts:2994]`.
- `--append-system-prompt` works in headless: the text appears in the transcript's `prompt_snapshot`
  `[OBS r8b]`. If `initialize.appendSystemPrompt` is also sent, it replaces the argv value; only the `initialize`
  text was present `[OBS r8a]`. Sending it through `initialize` keeps the authority text out of `ps` output (today
  the full grant JSON is visible in `ps`).

---------------------------------------------------------------------------------------------------

## 8. Model, effort and limits

- `--model <alias|full>`. Mid-session `set_model {model}` replies `{"model":"claude-sonnet-5-5"}`, the resolved id
  `[OBS r2]`. Changelog 0.3.268: a model id the CLI does not know is confirmed with the API the first time.
- `--effort` takes `low|medium|high|xhigh|max` (`claude --help`). The docs add `ultracode` (xhigh with ultracode)
  `[DOC cli-reference]`. Per-model levels are in `initialize.models[].supportedEffortLevels` `[OBS r2]`.
- Mid-session effort: `apply_flag_settings {settings:{effortLevel:"low"}}` returns success, and `get_settings`
  then shows `applied.effort:"low"` `[OBS r2]`. No restart. `max` is session-only `[SDK d.ts:2994-3022]`.
  `/effort <level>` as a prompt also works in `-p` `[DOC headless]`.
- Permission mode mid-session: `set_permission_mode {mode:"plan"}` replies `{"mode":"plan"}` and emits
  `system/status {permissionMode:"plan"}` `[OBS r2]`. Entering `bypassPermissions` needs it enabled at launch
  `[DOC permission-modes]`.
- `--max-turns N` and `--max-budget-usd X` are print mode only `[DOC cli-reference]`. With stream-json input, a
  message still queued when `--max-turns` ends a turn starts a new turn with its own limit.
- `--include-partial-messages` emits `stream_event` frames carrying Messages API stream events. T3 uses
  `message_start`/`message_delta` usage for live context fill and the thinking deltas `[T3 :7588-7650]`.
- Context fill without the model: `get_context_usage {detail:"summary"}` returns `total_tokens`, `raw_max_tokens`
  and `percentage`. The `full` detail makes token-count API calls `[SDK d.ts:3105, 3876-3942]`.
- `--verbose` is required with stream-json output `[OBS r9a]`.

---------------------------------------------------------------------------------------------------

## 9. Folder trust

- Headless shows no trust dialog and does not require one. `claude --help` on `-p`: "The workspace trust dialog is
  skipped when Claude is run in non-interactive mode (via -p, or when stdout is not a TTY, e.g. piped or
  redirected output). Only use this in directories you trust. Settings files that fail validation are silently
  ignored in this mode (no error dialog is shown)."
- The headless page adds: "Without --bare, a -p session runs the hooks in a project's .claude/settings.json and
  connects the servers in its .mcp.json, even in a folder you've never trusted. A -p session shows no workspace
  trust dialog and no per-server approval prompt." `[DOC headless]`.
- My runs in a never-trusted scratch cwd ran normally `[OBS all]`. No flag is needed. The SDK has an undocumented
  `initialize.workspaceTrust {accepted:true, directory:<abs>}` `[SDK mjs:163, function D6]`, not needed for `-p`.
- `--dangerously-skip-permissions`: "In non-interactive mode no dialog is shown." `[DOC permission-modes]`. It is
  refused as root or under sudo outside a recognised sandbox.

---------------------------------------------------------------------------------------------------

## 10. Licensing and terms (quotes only)

`https://code.claude.com/docs/en/agent-sdk/overview`, verbatim:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the [Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart.md) instead.

> For partners integrating the Claude Agent SDK, use of Claude branding is optional. When referencing Claude in your product:
> **Allowed:** "Claude Agent", preferred for dropdown menus; "Claude", when within a menu already labeled "Agents"; "{YourAgentName} Powered by Claude", if you have an existing agent name
> **Not permitted:** "Claude Code" or "Claude Code Agent"; Claude Code-branded ASCII art or visual elements that mimic Claude Code
> Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product.

> Use of the Claude Agent SDK is governed by [Anthropic's Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), including when you use it to power products and services that you make available to your own customers and end users, except to the extent a specific component or dependency is covered by a different license as indicated in that component's LICENSE file.

The same page on the relationship to the CLI: "A library that runs the Claude Code binary", and "To drive the same
agent loop from a language other than Python or TypeScript, [run the CLI as a subprocess](https://code.claude.com/docs/en/headless.md)
with the `-p` flag and `--output-format json`."

`https://code.claude.com/docs/en/headless`:
- Title line: "Use the Agent SDK to run Claude Code programmatically from the CLI, Python, or TypeScript."
- "The Agent SDK ... It's available as a CLI for scripts and CI/CD, or as Python and TypeScript packages".
  The headless CLI is presented as a form of the Agent SDK.
- On subscription login: "Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your
  subscription login".
- "In bare mode, Claude Code never reads OAuth credentials or the system keychain."
- "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release."

`https://code.claude.com/docs/en/cli-reference`: `claude setup-token`: "Generate a long-lived OAuth token for CI and
scripts. Prints the token to the terminal without saving it. Requires a Claude subscription." I found no sentence
on that page or the headless page about third-party developers or rate limits.

---------------------------------------------------------------------------------------------------

## 11. T3 reuse (ClaudeAdapterV2.ts; SDK `^0.3.276` per `apps/server/package.json:35`)

| Idiosyncrasy | Where | Verdict |
|---|---|---|
| Process group with a watcher: `/bin/sh` wrapper reads fd 3 and kills the group at EOF (server death), then SIGKILLs the group after the CLI exits. It exists because MCP grandchildren survive the CLI (T3 #3089, #23370) | `:317-352` | Port the idea. Console already has `setpriv --pdeathsig` and a detached group for Codex; add the after-exit group SIGKILL for MCP grandchildren. |
| MCP servers over the control channel (`mcp_set_servers`), not argv | `:917-921` | Optional. Console's coordination config holds no secrets, but the argv is world-readable. |
| Result mapping: `terminal_reason` aborted wins over `subtype:"success"`; `success` with 429, 529 or a known terminal error is failed; error subtypes are classified by text ("interrupt", "cancel") | `:3027-3060` | Copy (pure function, MIT). |
| Usage limits: result `api_error_status` 429 is `usage_limit`; 529 is overloaded and retryable; a gateway 503 that embeds a 429 is parsed by regex for the reset time; `api_retry` with `error_status` 429 is `usage_limit` and null is `transport_error`; `api_error_params.rate_limit_info` on blocked assistant frames | `:3149-3257` | Copy into `ProviderFailure` classes. |
| `rate_limit_event`: `rejected` without overage means blocked, tracked per `rateLimitType` with `resetsAt*1000`; `allowed` clears it; announce once per (type, reset); buffered when no turn is active | `:7444-7500` | Port to `usage.updated` windows and a `resetAt` on the failed terminal. |
| `stream_event` handling: `message_start`/`message_delta` usage for context fill; thinking block deltas keyed by message id and index | `:7588-7650` | Port the usage part. Live text streaming is out of scope in slice 1, as for Codex. |
| One assistant message per content block, sharing `message.id`; dedupe snapshots by `uuid` | `:7651-7660` | Port into `item.completed` mapping. |
| Fresh uuid per offer, because a duplicate uuid is acked with no turn (confirmed: `[OBS r7b]`) | `:9427-9443` | Port, and also use the dedupe for idempotent resend. |
| Interrupt then close, with a 10 s wait for exit, then finalise locally | `:9777-9800` | Port the 10 s fallback only; keep the process on a normal interrupt. |
| Steer with `priority:"now"` after moving foreground subagents to the background (`background_tasks {tool_use_id}`, 5 s deadline) | `:9821-9935`, `:315` | Skip the pre-move on 2.1.286 and later (the CLI does it). Use a plain message for steer and `now` for "send now". |
| Resume vs `sessionId`: resume when the session has a persisted turn; refuse to resume an empty transcript | `:9272-9279`, `:10004`, `:10120-10131` | Port. |
| Background tasks and wake: Claude can start a turn on its own after a background task or subagent ends. Frames are buffered when no turn is active and replayed into a synthetic continuation turn; registries survive turn settle | `:4107-4177`, `:7074-7250`, `:8043-8230` | Port a reduced form. Console needs `turn.started {origin:'provider'}` for self-started turns. `session_state_changed idle` (with `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`) gives the authoritative end. |
| `queued_command` attachments | Console already parses them (`transcripts/claude.ts:61`) | Keep Console's own parser. |
| Transcript flush latency (about 100 ms; 500 ms margin) | `:309-312` | Note only. Console reads the transcript after `result`. |
| Model or setting change refused while background agents or shells run in the process | `:535-542`, `:9199-9252` | Port if Console ever restarts a process for a model change. With `set_model` and `apply_flag_settings` it rarely needs to. |
| `CLAUDE_CONFIG_DIR` instead of `HOME` for isolated homes | `provider/Drivers/ClaudeHome.ts:35-44` | Note only. |
| Recorded wire fixtures: 41 `claude_transcript.ndjson` fixtures (simple, multi_turn, queued_turn, message_steering, turn_interrupt_mid_tool, background_* ...). They are SDK-level (`query.open`/`offer` outbound plus `SDKMessage` inbound), recorded on SDK 0.2.111 | `testkit/fixtures/*/claude_transcript.ndjson` | Copy the inbound frames as parser test data. Re-record on 2.1.310 for `command_lifecycle` and the newer fields. |

---------------------------------------------------------------------------------------------------

## 12. Gotchas

1. Inherited Claude environment. A Console backend started from a Claude shell would pass on `CLAUDECODE`,
   `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`, `CLAUDE_CODE_ENTRYPOINT`, `TMUX`,
   `AGENT_CONSOLE_*`. My first probes inherited `TMUX`, and the child recorded the parent's tmux pane in
   `~/.claude/sessions/<pid>.json` `[OBS r6a]`. Scrub these and set `AGENT_CONSOLE_SESSION_ID` per process. The
   systemd service is clean, but dev and proof Consoles may not be.
2. Headless sessions are visible to other Claude sessions. Each process opens a cross-session messaging socket
   (`system/init.messaging_socket_path`) and registers in `~/.claude/sessions/`. Peer Claude sessions can therefore
   list it and `SendMessage` to it. "The cross-session messaging safeguards" still prompt under bypass. I found no
   environment switch for the socket; a receive-side `crossSessionInbound` setting is mentioned `[BIN]`. UNVERIFIED.
3. `--bare` may become the default for `-p` "in a future release" `[DOC headless]`. Bare mode skips settings hooks,
   plugins, `CLAUDE.md` and OAuth, which would break coordination hooks and subscription login. Detect it from
   `system/init` (`apiKeySource`, `plugins`, the `hook_started` for `SessionStart`) and fail fast. It is unknown
   whether the no-`-p` SDK-style launch will be affected.
4. Ordering:
   - `SessionStart` hook frames come before the `initialize` reply.
   - `system/init` comes once per turn, after `UserPromptSubmit` hooks, and after `command_lifecycle started`.
   - A `result` may be followed by `command_lifecycle` and `session_state_changed idle`.
   - A folded message's `completed` comes before its turn's result; a fresh turn's comes after.
   - A preempted `now` turn has no `result` at all.

   Use uuids, not order. `result_index` gaps mean a lost result `[SDK d.ts:5982]`.
5. Exactly-once terminals:
   - one `result` per turn, but one turn can consume several sends (`user_message_uuids`);
   - a duplicate uuid gets no turn (`completed` without `started`);
   - API errors are `subtype:"success"`;
   - lifecycle `cancelled` also means "consumed by a turn that died on a hard failure" `[BIN]`. Do not resend on
     `cancelled` blindly.
6. Exit codes: 0 means clean (or no turn); 1 means the last result was an error or startup failed; 143 means
   SIGTERM. stderr was empty in every successful run; argv errors print ANSI-coloured text. Keep a stderr tail for
   logs and never parse it.
7. Prompts can be lost. A prompt interrupted or SIGTERM'd before the model call is not in the transcript
   `[OBS r4c, r4e]`. Console's journal must stay the record of sent user text.
8. One writer per session is not enforced by the CLI `[OBS r6]`. Use the per-session lock plus the pid,
   start-ticks and boot-id meta plus a `~/.claude/sessions` check before `--resume`.
9. Large tool outputs and images. The transcript stores images inline as base64 and the CLI keeps a copy under
   `/tmp/claude-<uid>/.../images/` `[OBS r9c]`. Even one failed "hello" produced an 82 KB transcript (prompt
   snapshot plus api-request blobs) `[OBS r3]`. `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` can cap `-p`/SDK transcript
   size; check it is not set in Console's environment `[DOC sessions]`. Transcripts age out after 30 days
   (`cleanupPeriodDays`).
10. cwd: the transcript directory is derived from the cwd (non-alphanumeric characters become `-`; over 200
    characters, truncated plus a hash). A deleted cwd keeps the session running but shell commands fail; the CLI
    emits a `system/informational` warning `[DOC headless]`. Spawn with an explicit cwd.
11. Concurrency and memory: one process per session.
    - Headless idle RSS was 176-257 MB in the probes (no MCP, no model).
    - Running TUI `claude` processes on this host measured 236-388 MB RSS (n=7, `ps -C claude`).
    - Each coordination MCP child (`agent-coord.mjs mcp`) measured about 34 MB (n=12).
    - Budget about 300-400 MB per live structured Claude session. Idle-release (EOF, then the process exits in
      about 150 ms) and `--resume` on next use is cheap; startup to the `initialize` reply took 0.35-0.45 s
      without MCP.
12. MCP startup delay: with `--mcp-config`, the first turn waits up to `MCP_TIMEOUT` (30 s) for pending servers.
13. System prompt snapshot freezes appended authority text across resumes (section 3).
14. Permissions defaults moved twice in 0.3.286 and 0.3.302. Always pass the mode. `-p --resume` does not restore
    bypass.
15. Changelog entries (0.3.257-0.3.310) that touch stream-json or control behaviour, via a WebFetch summary of the
    SDK `CHANGELOG.md`:
    - 0.3.283: warnings become `system/informational`.
    - 0.3.287 and 0.3.290: missing or late `message_stop` in partial streams fixed.
    - 0.3.268: `result_index`, `local_command`, `resume_reason`; `initialize` always lists
      `pending_permission_requests`.
    - 0.3.259: `user_message_uuids`.
    - 0.3.274: `startup_failure_reason`.
    - 0.3.296: `initialize` returns `claude_code_version`.
    - 0.3.286: priority `now` backgrounds work.
    - 0.3.290: same-uuid resend no longer replayed. On 2.1.310 it was still echoed across a resume `[OBS r7b]`.
    - 0.3.260 and 0.3.280: `rate_limit_event` re-emits during an exceeded window and at a usage-limit wait.
    - 0.3.302: an omitted `permissionMode` starts in `default` on third-party providers.
16. `initialize` is optional, but sending it gives the model list and account (the probe), `pending_permission_requests`
    after a reconnect, and the place for `appendSystemPrompt` and `perTaskStopAffordance`.

---------------------------------------------------------------------------------------------------

## 13. Event mapping sketch for the Console contract

| TransportEvent | Source on path A |
|---|---|
| `session.native` | `--session-id` (known before spawn) or `system/init.session_id`. `transcriptPath` from hook stdin `transcript_path`, or computed from `CLAUDE_CONFIG_DIR` and the escaped cwd |
| `session.state` | `ready` after the `initialize` reply (or spawn); `error` with `process_exited` on unexpected exit; `stopped` after a requested close |
| `turn.started` | `command_lifecycle {state:"started", command_uuid:<our uuid>}`, with `origin:'user'`. A turn with no lifecycle of ours (background wake, `system/init` plus `assistant` with no client uuid) gets `origin:'provider'` |
| `item.completed` | `assistant` content blocks (`text` maps to assistant, `thinking` to reasoning, `tool_use` by tool name to command, file_change, mcp or search); `user` `tool_result` closes the item |
| `request.opened`/`.closed` | `can_use_tool` and `elicitation` control requests; closed by our `control_response` or by the CLI's `control_cancel_request` |
| `usage.updated` | `rate_limit_event`; `result.modelUsage[*].contextWindow` plus `usage`; `get_context_usage {detail:"summary"}` |
| `notice` | `system/api_retry`, `system/informational`, `system/status compacting`, `system/permission_denied` |
| `turn.terminal` | `result`, mapped as in section 11 rows 3-4. Fan out to every uuid in `user_message_uuids`. `sessionUsable:true` unless the process exited |

---------------------------------------------------------------------------------------------------

## 14. Not verified here

- Fold of a plain mid-turn message between tool rounds, and the headless `queued_command` attachment shape.
- `priority:"now"` during running tools (backgrounding).
- `stream_event` frames.
- `can_use_tool` for `AskUserQuestion`, and for `ExitPlanMode` under bypass.
- `Stop` and `PostToolUse` hooks on a successful turn.
- `--mcp-config` connect timing.
- TUI resume of a headless session and the reverse.
- `--system-prompt-snapshot` freezing on resume.
- Disabling the messaging socket.

All of these need a real model turn, or an MCP server or TUI run that was outside this assignment. One authorised
proof run in an isolated `CLAUDE_CONFIG_DIR` with an API key or Bryan's login would settle them.

Evidence files: `scratchpad/obs/r1-eof-nop.jsonl` through `r11-noinit.jsonl`, `scratchpad/obs/hooks/` (the last
run's hook inputs), `scratchpad/obs/cfg/projects/.../*.jsonl` (transcripts written by the probes), and the SDK
tarball at `scratchpad/sdk/anthropic-ai-claude-agent-sdk-0.3.310.tgz`, extracted to `scratchpad/sdk/x/package/`.
Here `scratchpad` is `/tmp/claude-1000/-home-bryan-code-UberCoder-agent-console-mvp-agent-console/ee5840a9-2645-4c71-82dc-6628af8faa2e/scratchpad`.
