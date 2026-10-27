# Structured cutover: Claude plugin, parity and tmux retirement

Date: 2026-10-26. Branch: `feature/structured-claude-cutover`, stacked on `feature/structured-provider-lane`
(the Codex app-server lane, see `docs/structured-providers.md`). Status: Phase A is built and was proven against the
real Claude and Codex CLIs after each of six review rounds (the runs on `b2e6e5e`, `dd3c615` and `52ee445` passed all three
proofs, see "Verification evidence"). Deploying it and flipping the default are Bryan's live steps.
Nothing in this document changes the running Console until those steps are executed.

## Goal

Run every Console conversation through a structured provider transport, retire the tmux path end to end,
and keep the properties the tmux path gave us: one conversation per native session, provider processes
that survive a Console backend deploy, coordination hooks and MCP identity, grants, recovery and recency.

## What the tmux path does today that the structured lane does not yet

Measured on `main` `af009e3` plus the Codex lane at `77ec933`; live service state on 2026-10-26: 38
restorable bound sessions (13 Claude, 25 Codex), service unit `agent-console.service` with
`KillMode=process`, so a backend restart keeps provider processes alive and Console re-attaches to them.

| Property | tmux path | Codex structured lane (slice 1) | Needed for cutover |
|---|---|---|---|
| Claude conversations | yes | no | Claude plugin |
| Provider process survives a backend deploy | yes (tmux server) | no (stdio child dies with the backend) | session host relay |
| Mid-turn human message | yes (paste into composer) | yes (`turn/steer`) | Claude: stream-json input while running |
| Stop | Escape key | `turn/interrupt` | Claude: interrupt control request |
| Questions from the agent (Claude `AskUserQuestion`, Codex `requestUserInput`) | answered through terminal keys | declined with a status line | question card in the pane plus an answer route |
| Plan mode approval (Claude `ExitPlanMode`) | terminal keys | n/a | verify under bypass; card if needed |
| Image attachments | yes (path instruction) | refused | Codex `localImage`, Claude image blocks |
| Live partial assistant text | Claude: terminal text as pending rows; Codex: none | none (rollout only) | optional: stream deltas (decision 5) |
| Model and effort switch | kill and relaunch with flags | per-turn overrides | Claude: restart the process with new flags (per-session) |
| Idle sleep and memory pressure | kill the process | Codex: unsubscribe thread; pressure skipped | Claude: kill the process (per-session), pressure works |
| Hook and MCP identity | per-process env | server-side by thread id (shared process) | Claude: per-process env as today |
| Granted launches and restarts | tmux | restart yes, launch always tmux | `transport` on granted launches |
| First-turn pending adoption, paste confirmation, screen parsing | required | not needed (ids known up front) | delete |

This table is the state before the cutover work. Built since: the Claude plugin, the session host relay, question cards and
answers, images, per-session idle and pressure handling, granted launches on the default transport, and the migration.
Not built: streamed partial text (decision 5). Open: plan mode approval (`ExitPlanMode` under bypass is unproven).

## Prerequisite

`main` moved to `c094656` ("Clear delayed Claude prompt restoration after Stop", a SessionManager change)
after the Codex lane was branched from `af009e3`. The lane branches were rebased onto the new `main` before
implementation started, so `c094656` is an ancestor of this branch and the Codex lane's earlier head `77ec933` is not. The
full suite and the proofs ran on the rebased result (see "Verification evidence").

## Decisions for Bryan

1. **Claude transport: Claude Code headless CLI directly (recommended) or the Agent SDK package.** Both
   run the same `claude` binary with Bryan's login and write the normal transcripts under
   `~/.claude/projects`. The SDK is a thin wrapper that spawns `claude -p --output-format stream-json
   --input-format stream-json` and speaks the same control protocol; using the CLI directly keeps the plugin
   the same shape as the Codex one (a child process and newline JSON), avoids a dependency that changes
   weekly, and keeps the product on the Claude Code binary it already uses. The Agent SDK overview says,
   verbatim: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
   login or rate limits for their products, including agents built on the Claude Agent SDK." Console is a
   single-user local tool that reuses Bryan's own login, which is also what the tmux path does today; the
   plugin is labelled "Claude", never "Claude Code". Bryan reads that clause and decides. Note that the
   headless docs say `--bare` (no hooks, no subscription login) "will become the default for `-p` in a future
   release"; the plugin launches without `-p` and fails fast if a launch comes up without hooks or on an API
   key, so a CLI update cannot silently change the lane's behavior.
2. **Session host relay so provider processes survive backend deploys (recommended; built in C0, see "Session
   host relay": started detached, without `systemd-run`).** A small Node
   process per structured provider instance owns the provider
   child and its stdio and serves a Unix socket speaking the same newline JSON. Console connects, and on a
   backend restart reconnects, and a client that keeps a cursor replays the bounded output it missed. One mechanism for both providers
   (Codex could also use its own `--listen unix://`, which is WebSocket and would need a `ws` dependency;
   the relay keeps one code path). Without the relay, every deploy ends every running turn, which the tmux
   path never did. Alternative: accept interrupted turns on deploys and add a "wait for idle" deploy guard.
3. **Cutover staging.** Phase A ships the Claude plugin, parity features, the relay, the migration of
   existing tmux bindings and the default flip, with the tmux code still present behind the old transport
   as the fallback for one or two weeks of real use. Phase B then removes the tmux path end to end
   (SessionManager screen and keystroke code, tmux client, screen parser, paste confirmation, pending
   adoption, raw-log tailing, Text Bypass and key buttons in the web, the tmux proof scripts, and their
   tests). Alternative: remove tmux in the same change as the flip, which is faster but leaves no fallback.
4. **Migration of the 38 live tmux bindings.** At the flip, Console converts idle tmux rows by stopping the
   tmux session the way idle sleep does and marking the row `transport: structured, idleSuspendedAt`, so the
   next use resumes the same native conversation structurally. Working rows convert when they go idle. No
   conversation changes identity. Alternative: leave existing rows on tmux until they are released.
5. **Live partial output.** Keep rollout and transcript driven display (what Codex has today, and Claude's
   transcript flushes each message within about 100 ms), or add streamed deltas as pending rows through a
   new event-log record. Recommended: ship the cutover on transcript-driven display and add deltas as a
   follow-up slice; the Codex lane already proved the rendering loop is fast enough.
6. **Extension-agent lane.** With Claude on the structured path and ACP as the home for Grok and others, mark
   `design/extension-agent-lane` superseded now and delete the branch after Bryan's review, rather than
   waiting for Grok.

## Claude plugin design

Facts below were verified on this host against `claude` 2.1.310 with a throwaway config directory holding
no credentials (every probe stopped at "Not logged in", no model call); evidence and the full brief are in
`docs/research/claude-headless-2026-10-26/`. Items marked "to prove" need a real turn and are settled by
the proof script.

The Agent SDK (0.3.310, built for CLI 2.1.310) is a wrapper that spawns this same binary with
`--output-format stream-json --verbose --input-format stream-json` and speaks newline JSON plus control
requests over its pipes. The CLI speaks that protocol to any client, so Console drives it directly, the way
it drives Codex, and keeps the SDK's type definitions only as a reference (its package is under Anthropic's
commercial terms, not MIT, so nothing is copied from it). T3's MIT code is ported where marked.

Process model `per-session`: one `claude` process per conversation, started lazily on the first turn and
kept alive while stdin stays open; many turns flow through one process. An interrupt ends the active turn
and the process survives. Idle release is end-of-input: the process exits in about 150 ms, and the next
turn resumes by session id in a fresh process (0.35 to 0.45 s to ready without MCP). Budget 300 to 400 MB
of memory per live Claude session (measured TUI processes on this host: 236 to 388 MB) plus about 34 MB per
coordination MCP child, which is what the tmux path costs today.

Launch:

```
claude --output-format stream-json --verbose --input-format stream-json
  --dangerously-skip-permissions --permission-prompt-tool stdio
  --model <profile.model> --effort <profile.effort>
  --session-id <uuid>            new conversation: Console mints the id, so there is no pending adoption
  --resume <session-id>          existing conversation: same id, same transcript file
  --mcp-config <json>            per-session coordination MCP with AGENT_CONSOLE_SESSION_ID, as today
  [--include-partial-messages]   only when streamed deltas ship
```

followed by an `initialize` control request carrying `appendSystemPrompt` (the grant authority text, which
keeps it out of `ps` where the tmux path shows it today) and no `supportedDialogKinds`. Its reply lists
models with supported effort levels and the account without a model call, which is the probe. Passed on
every launch because resume does not restore them: the permission flags, `--mcp-config`, `--model`,
`--effort`. `--continue` is never used: headless sessions are hidden from the picker and from
`--continue`, only `--resume <id>` reaches them, so the `continueCommand` fallback goes away. A conversation whose
first prompt never reached the model has no conversation in the transcript, so `--resume` cannot find it. A resume of
such a chat starts the process again with `--session-id <same id>` and adds a notice that the model starts without history.
The same path catches any chat whose transcript holds no conversation (for example a transcript the CLI cleaned up). Review
round 2 (N7) asks whether it should be limited to rows that never completed a turn, and notes that the real CLI has not been
shown to accept `--session-id` beside a transcript that holds only preamble.

Environment per process: `AGENT_CONSOLE_SESSION_ID`, `AGENT_COORD_RUNTIME`, `AGENT_CONSOLE_CONFIG`, with
inherited `CLAUDECODE`, `CLAUDE_CODE_*`, `TMUX`, `CODEX_THREAD_ID`, `AGENT_CONSOLE_*`, `AGENT_COORD_*`, `NODE_OPTIONS` and
`DEBUG` scrubbed first. A `CLAUDE_CODE_*` key set in `structuredSessions.claude.env` is kept, because it was typed on
purpose. `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` is set last, so the CLI reports the authoritative turn end. Hooks run in headless
exactly as in the TUI and inherit that environment, so the installed coordination hooks register unchanged;
`SessionStart` fires at process start, `StopFailure` (not `Stop`) after an API-error turn, `SessionEnd` on
exit. Headless shows no workspace-trust dialog.

Wire protocol:

- Input: `{"type":"user","session_id":"","message":{"role":"user","content":[image blocks..., {"type":"text","text":...}]},
  "parent_tool_use_id":null,"uuid":<fresh uuid>,"origin":{"kind":"human"}}`. The human origin stamp is
  required: without it the transcript records the turn as SDK-originated and Console's mid-turn parser does
  not show it. A second message while a turn runs is queued and folds into the running turn at the next
  tool boundary (steer; verified on the real CLI: the transcript records it as a `queued_command` attachment, see finding 1);
  `"priority":"now"` preempts the turn at once and moves running shell commands and subagents to the background (not
  exercised against a tool in flight). Images go first as base64 blocks, fitted to the API limits (see "Parity
  features"). Resending a uuid already in the transcript runs nothing and answers only a `completed` lifecycle frame, which the host treats as already handled (idempotent
  resend after an uncertain write).
- Output per turn: `command_lifecycle {command_uuid, state: queued | started | completed | cancelled}`,
  `system/init` (per turn: `session_id`, `model`, `permissionMode`, `tools`, `mcp_servers`, `capabilities`),
  `assistant` messages (one per content block, sharing `message.id`), `user` tool-result messages, exactly
  one `result` per turn (`subtype` success or `error_*`, `is_error`, `terminal_reason`, `api_error_status`,
  `user_message_uuids`, usage, cost), then optionally `system/session_state_changed idle` when
  `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` (the authoritative turn end). An API failure is `subtype:
  "success"` with `is_error: true` and `terminal_reason: "api_error"`. `rate_limit_event`,
  `system/api_retry`, `system/compact_boundary`, `system/task_*` and `system/informational` are the other
  frames to map.
- Control: `interrupt {cancel_queued?}` returns `{still_queued, cancelled}` in about 5 ms and the turn's
  `result` follows with `error_during_execution` and `terminal_reason` `aborted_streaming` or
  `aborted_tools`; `set_model {model}` and `apply_flag_settings {settings: {effortLevel}}` change model and
  effort live, so a profile switch needs no restart; `get_context_usage {detail: "summary"}` gives context
  fill without a model call. Console always sends `cancel_queued: true`, so Stop also drops sends queued behind the turn;
  the steers among them come back in `cancelled` and are reported to the host. The CLI sends `can_use_tool` for
  `AskUserQuestion`, explicit ask rules and the cross-session messaging safeguards even under bypass (`AskUserQuestion`
  verified on the real CLI), and `elicitation` for MCP forms; every one must be answered or the turn waits forever. Plan
  mode keeps its blocks headless; whether `ExitPlanMode` reaches `can_use_tool` under bypass is still to prove. A repeated
  `initialize` on a running process is accepted. Its reply carries `session_state` (`idle`, or not idle while a turn runs),
  and the requests still open (`pending_permission_requests`). The SDK types describe a snapshot of the background tasks
  sent right behind the reply, which the plugin waits up to 1 s for. This is how a new backend learns what a surviving
  process is doing.
- Exit: end of input while idle exits 0 in about 150 ms (1 if the last result was an error); end of input
  mid-turn lets the turn finish, writes its `result`, runs `Stop`/`StopFailure` and `SessionEnd` hooks, then
  exits; SIGTERM exits 143 with no `result`, and a prompt that had not reached the model is not in the
  transcript, so Console's journal stays the record of sent text.
- Mapping to `TransportEvent`: `session.native` from `--session-id` (transcript path from the hook's
  `transcript_path` or the escaped cwd); `turn.started` from `command_lifecycle started` with our uuid
  (`origin: 'provider'` for a turn with no uuid of ours, such as a background-task wake). A frame or `result` that names
  only uuids this session never sent is a turn the CLI runs on its own, or one that began before the session attached, so
  it becomes a provider turn and never belongs to the send in flight; only a frame with no uuid at all (an older CLI) is
  credited to the pending send. A process found mid-turn gets an adopted provider turn at once (`turn.started` with
  `adopted: true`); `item.completed`
  from each `assistant` block (`text` assistant, `thinking` reasoning, `tool_use` by tool name) closed by its
  `tool_result`; `request.opened`/`closed` from `can_use_tool` and `elicitation`; `usage.updated` from
  `rate_limit_event` and `result.modelUsage`; `turn.terminal` from `result`, fanned out to every uuid in
  `user_message_uuids`, with `ProviderFailure` ported from T3 (`terminal_reason` aborted wins over
  `success`; 429 to `usage_limit` with `resetsAt`; 529 and 5xx to `provider_error` `server_overloaded` or
  `server_unavailable`, which RunRecovery retries; auth to `permission_error`); process exit mid-turn to a
  failed `transport_error` terminal and `session.state: stopped`.
- Capabilities: `processModel: 'per-session'`, `nativeIds: 'client-allocated'`, `resume: 'reattach'`,
  `steer: 'native'`, `interrupt: 'terminal-follows'`, `images: true` (base64 blocks before the text),
  `enforcement: 'native'`, `modelSwitch: 'next-turn'`.
- One writer: the CLI does not refuse two processes on one session (both append to one file). Console
  enforces it with the per-session lock, the pid/start-ticks/boot-id meta, and a check of
  `~/.claude/sessions/<pid>.json` (which every live Claude process registers with its session id) before any
  `--resume`. `resume` never starts a process beside a holder. With a recorded launch it first connects to that
  process with `attachOnly` (nothing is started or ended) and adopts it. A stale record (no host, or an ended one) is
  dropped. A host that runs but did not answer in time is left alone and the call fails with
  `TransportUnavailableError`. A holder that is not our process fails with `ClaudeSessionHeldError`. A session whose
  first prompt never reached the model has no transcript; `resume` starts it again with `--session-id` and the same
  id, not `--resume`.
- T3 behaviors ported (MIT): result and usage-limit classification, `rate_limit_event` tracking per limit
  type, one-assistant-message-per-block dedupe by uuid, fresh uuid per send, 10 s local finalize when no
  `result` follows an interrupt, resume-only-with-a-persisted-turn, a group SIGKILL after exit for MCP
  grandchildren, and a reduced form of background-task and subagent completion wakes (`turn.started
  {origin: 'provider'}`).
- Risks to watch: `--bare` is announced as the future default for `-p` (it skips hooks, plugins and
  subscription login), so the plugin launches without `-p` and fails fast if `system/init` shows no
  `SessionStart` hook or an API-key auth source; each headless process opens a cross-session messaging
  socket that other Claude sessions can see; the system-prompt snapshot freezes appended authority text
  across resumes until compaction (true for the tmux path as well), so a changed grant needs
  `--system-prompt-snapshot off` on that launch (still to prove). The other open points are listed under "Not proven by
  any run" in "Verification evidence".

Host changes for `per-session` plugins in `StructuredSessionService`: one instance object per provider
that spawns a process per session (through the relay); idle sleep and pressure suspension end the process
(end of input, then group SIGTERM, then SIGKILL) and set the marker; restore resumes by native id; model
profile change applies live; `providerAlive` is "relay reports the child alive"; coordination liveness uses
the child pid as the tmux path does today; granted launches pass `transport`. Built in lane C2: see "Per-session
host support, default transport and migration (lane C2)" below.

## Session host relay

Built in lane C0: `apps/server/src/providers/transport/session-host.ts` (the host program),
`line-transport.ts` (the channels and the factory) and the Codex plugin on top of them. One host holds one
provider child: a single host (`hostId: 'codex'`) for the shared Codex app-server; the Claude plugin uses
one host per conversation.

Changed from the first plan: the host is started detached (`detached: true`, so its own session and process
group, `stdio` to `<runtimeDir>/structured/hosts/<hostId>.log`), not under `systemd-run --user --scope`. The
service runs with `KillMode=process`, so a detached child of the backend survives a restart without a scope,
and a scope would add a systemd dependency to every test and proof run. The host is plain Node that imports only
`node:` modules, so it runs alone from `dist/providers/transport/session-host.js` (and from the `.ts` file under
Node 22.18 or later, which the tests and `tsx` development use).

- **Start.** `node session-host.js --socket <path> --record <path> --cwd <dir> --env-file <path> -- <argv...>`.
  The factory writes the child's exact environment to the env file (mode 0600); the host reads it once and
  deletes it. The host's own environment is a short allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`,
  `LANGUAGE`, `LC_*`, `TZ`, `TMPDIR`), so `AGENT_CONSOLE_SESSION_ID`, `CODEX_THREAD_ID`, `CLAUDECODE`,
  `CLAUDE_CODE_*` and `TMUX` never reach it. The child gets the env file and nothing else.
- **Child.** Started in its own process group through `setpriv --pdeathsig TERM --`, relative to the host: if the
  host dies, the kernel ends the child. Without `setpriv` the host logs a warning and starts the child plainly
  (the record then says `parentDeathSignal: false`); a binary it cannot find is also started plainly so the
  failure is the usual `ENOENT`, which the client receives in the welcome message.
- **Files** in `<runtimeDir>/structured/hosts/` (directory 0700): `<hostId>.sock` (0600; a path above 100 bytes is
  replaced by a hash of the id), `<hostId>.json` (0600, written once the socket listens and the child runs),
  `<hostId>.log`. The record:
  `{ version: 1, host: { pid, startTicks, bootId }, child: { pid, startTicks, bootId, processGroup }, socketPath,
  argvHash, startedAt, parentDeathSignal }`. `startTicks` is field 22 of `/proc/<pid>/stat`; `processGroup`
  equals the child's pid (a record that says otherwise is not read). Nothing is ever signalled unless pid, start
  ticks and boot id all match.
- **Protocol** (newline JSON, a connection is identified by its first message). Client to host:
  `{"type":"hello","sinceSeq":N}` (become the client; `sinceSeq` optional), `{"type":"write","line":"..."}` (one
  line for the child's stdin), `{"type":"status"}`, `{"type":"terminate"}`. Host to client:
  `{"type":"welcome",hostPid,childPid,alive,seq,firstSeq,everWrote,startedAt[,spawnError]}`,
  `{"seq":N,"line":"..."}` for each stdout line of the child, `{"type":"gap","firstSeq":M}`,
  `{"type":"exit","code":..,"signal":..,"stderrTail":"..."[,"error":{...}]}`, `{"type":"replaced"}`,
  `{"type":"status",pid,hostPid,alive,seq,firstSeq,everWrote,clients,startedAt}`. Writes are explicit messages
  (not raw lines) because a provider line can itself be an object with a `type` field.
- **One client at a time.** A `hello` makes that connection the client and replaces the previous one, which
  receives `replaced` and is closed (it does not reconnect by itself, so two backends cannot take turns forever).
  `status` and `terminate` work from any connection, including one that never says hello; a connection that
  starts with them never becomes the client, and only the client can write.
- **Replay.** The host keeps the child's stdout lines in a bounded buffer: at most 4 MiB and nothing older than 10
  minutes (a single line larger than the buffer empties it, so a replay never skips a line without saying so).
  `hello` without `sinceSeq` delivers live output only. With `sinceSeq: N` the host first sends `welcome`, then
  `{"type":"gap","firstSeq":M}` when lines after N are no longer held (or N is newer than anything the host has
  seen), then every buffered line after N, then live output. `everWrote` in the welcome and in `status` says
  whether any client line has ever reached the child's stdin; a fresh child needs its handshake, a used one does not.
- **Ending.** `terminate` (and SIGTERM to the host): stdin EOF, 5 s, SIGTERM to the child's group, 5 s, SIGKILL to
  the group, then a final group SIGKILL for leftovers of a launcher; the sender receives `exit`, then the host
  removes its record and socket and exits. When the child ends on its own, the host sends `exit`, keeps answering
  for 60 s (a reconnecting backend learns the outcome), removes its record and exits. A child line above 128 MiB
  ends the child and is reported in `exit.error`. However the child went, the host then ends what is left in its process
  group with SIGKILL (MCP servers, background shells, a launcher's own child): after the output flush wait, and only while
  the group still has live members, so a recycled pid is never signalled.
- **Backend side** (`createLineTransportFactory({ runtimeDir, log, hostProgramPath })`, handed to plugins as
  `PluginContext.lineTransport`; `app.ts` creates it, tests that inject their own plugins get none). With a
  `hostId`: read the record; if the recorded host is alive and its `argvHash` matches, connect (a reconnect: the child
  keeps running and the next client takes over, with live output only, unless the host was never written to and the
  request asks for its startup output with `sinceSeq: 0`). A changed command, a host that refuses connections or a host
  whose child had ended is ended first (over the socket, else by gated signals). A host that is running with the right
  command line but accepted no connection within 3 s, or sent no welcome within 5 s, is left alone and the open fails with
  `TransportUnavailableError`: retiring it would end its provider and any turn it runs, and the next use retries. A child
  left running without its host is ended through its recorded group, and a new host is started. With `attachOnly` the
  factory only connects: it starts nothing, ends nothing and answers `LineTransportNotRunningError` with a reason
  (`absent`, `ended`, `other_command`, `unreachable`). Without a `hostId` the child is run directly over
  stdio (`StdioLineTransport`: newline framing with the 128 MiB cap, `\r` stripped, 64 KiB stderr tail, close = stdin
  EOF, 5 s, group SIGTERM, 5 s, group SIGKILL). A plugin that finds no factory uses stdio too.
- **What survives.** The provider process, its loaded threads, its connection state, its running turn and the requests it
  waits on. What does not: anything that was only in the backend. An ordinary connect asks for live output only, so the
  record of what happened while no backend was connected is read from the provider's own files (the Codex rollout, the
  Claude transcript). What a new backend needs to carry on a running turn it learns from the provider: Claude from the
  repeated `initialize` reply, Codex from `thread/resume`, `thread/turns/list` and the host's replay buffer. The Codex plugin
  keeps a cursor (`HostLineTransport.lastSeq`) in the Console database and attaches with `sinceSeq: 0` to read the requests
  that arrived while nobody listened (see "Restart adoption" in `docs/structured-providers.md`). The Claude plugin asks for
  the replay only from a host that was never written to, to read the SessionStart hook frames of a process nobody has used.
- **Limits.** One backend per runtime directory. The command line is compared (`argvHash`), the environment is
  not: a changed `env` setting applies when the host next starts. A launcher that is already dead while its
  native child lives on cannot be found again from the record (the group leader is gone); the parent death signal
  prevents that case unless the child ignores SIGTERM.
- Idle: a Claude host exits when its child exits; a Codex host lives as long as the app-server.

## Per-session host support, default transport and migration (lane C2)

Built in lane C2 on top of the relay (C0) and the Claude plugin (C1). Everything keys on the plugin's declared
`capabilities.processModel`, never on the plugin id, so a later ACP plugin gets the same treatment.

**Per-session processes in `StructuredSessionService` and `SessionManager`**

- One instance object per provider; for `processModel: 'per-session'` it starts one process per Console session
  (the plugin names the relay host after the session, `claude-<sessionId>`; C0 rejects a colon in a host id).
  The service refuses a second open for a conversation that is loaded, and a lost conversation never replaces the
  instance (a per-session instance holds no shared connection that one conversation could break).
- `OpenOptions` gains four optional fields, handed to per-session plugins only where noted: `env` (per-session
  only: the Console's coordination variables, the provider's configured `env` over them, and
  `AGENT_CONSOLE_SESSION_ID`, which the configured `env` can never override); `consoleIdentity`
  (per-session only, only with coordination on: `{ sessionId, runtimeDir, helperPath }`, the values the tmux launch
  pins, for the conversation's own coordination MCP config); `appendSystemPrompt` (any plugin: the grant authority
  text `launchAuthorityContext` builds for a session a grant launched, the same text the tmux launch passes to
  `--append-system-prompt`); `systemPromptSnapshot: 'off'` (on every resume of a session a grant launched, also when no
  authority text is left to append, so the resumed prompt names the grants active now and not the ones recorded on the
  first request; unproven against the real CLI, see "Not proven by any run"). A shared process still never gets a conversation's identity.
- `TransportSession.pid` (optional): a per-session transport reports its own process, and the service stores it as the
  row `pid`; a shared instance keeps reporting the one shared pid.
- Idle sleep is `unload()`: the process ends, the row gets `idleSuspendedAt`, the next message `resume`s by native id.
  `close('release')` ends the process too and is what release uses (a per-session release skips the unload).
  The `stopped` state that follows an unload is a normal end: the service marks the session `closing` before it ends
  it, so only an exit the host did not ask for becomes a lost connection (status line, `isWorking=false`, RunRecovery
  `process_exited` for unattended work).
- Memory pressure suspends an idle per-session conversation (process ended, `pressureSuspendedAt`, restored by selecting
  it) with the same guards as tmux rows: no turn running, no queued input, no model change, no active coordination
  assignment, the two-sample confirmation and the idle window. Shared-process rows are still skipped.
- Model and effort go on the next `sendTurn`, as for Codex; the Claude plugin applies them live.
- Coordination liveness is unchanged: an assignment stays alive while a restorable bound structured row exists, so an
  ended per-session process does not disconnect it.

**Config** (`config/schema.ts`, `config/agent-console.example.json`)

```json
"structuredSessions": {
  "defaultTransport": "tmux",
  "codex":  { "enabled": false, "command": ["codex", "app-server"], "idleUnloadMinutes": 60, "env": {} },
  "claude": { "enabled": false, "command": ["claude"],             "idleUnloadMinutes": 60, "env": {} }
}
```

`defaultTransport` is `tmux` or `structured` and defaults to `tmux`. It is the transport of every bind that does not
name one (new chats, history binds, auto-tracked conversations and granted launches) and the switch for the migration
below. It only takes effect for a provider whose lane is enabled; for a provider whose lane is off the bind falls back to
tmux and logs one warning per provider. An explicit `transport` in a request always wins (explicit `structured` for a
provider whose lane is off is still a 400).

**Default transport**

- `SessionManager.defaultTransportFor(provider)` resolves it; the routes use the same pure function
  (`sessions/structured/default-transport.ts`) because they hold the advertised-provider list. `bindConversation`
  with no `transport` takes the default, so granted launches (`grants/session-launches.ts`) and auto-tracked conversations
  follow it without a code path of their own.
- A bind that names no transport and finds the conversation already bound on tmux returns that tmux session (it has
  not been moved yet); only an explicit `structured` request is refused with the existing 409.
- The structured transport sends no command-line flags. A granted launch that carries `launchContext.flags` (for example
  `--add-dir` or `--permission-mode`) therefore keeps tmux. Under the default it starts on tmux, logs a warning and
  adds the status line "Started on tmux: the structured transport does not apply the launch flags this session was given."
  An explicit `transport: 'structured'` with flags is refused and nothing starts.
- `GET /api/projects/tree` advertises each provider whose lane is enabled and has a registered plugin;
  the sidebar offers "Codex (app-server)" and "Claude (headless)" per advertised provider. `app.ts` registers
  `createClaudePlugin()` beside the Codex plugin.

**Migration of live tmux bindings** (decision 4)

`reconcileSessions` (first pass 5 s after start, then every 30 s) runs this for every restorable tmux row whose provider
has its lane on while `defaultTransport` is `structured`. It runs under the row's command lock, one row at a time,
and a failure on one row is logged and never stops the pass.

1. Classify the row. It moves only when `status` is `bound`, the conversation ref is a native id (not `pending:`), the row
   is not working, has no queued input, no model change in flight, no scheduled or running unattended recovery (moving
   the row would cancel it and blame the person), no launch flags, and (Claude) its transcript file is indexed and
   readable. A tmux session that is gone while the provider process still runs outside the binding is left alone.
2. A live tmux session passes the idle-sleep guard (owner option, screen readable and idle, no unsent draft, no native
   selection, no unsent peer notice), is killed, and must be confirmed dead. If any step fails the row is untouched and
   the next pass tries again. A dead session moves without a kill, screen read or key press (only the liveness check).
3. `BoundSessionsRepo.setTransport` flips the row in one transaction: `transport='structured'`,
   `tmux_session_name='structured:<id>'`, `raw_log_path` and `pid` cleared, `idle_suspended_at` set to now (an existing
   idle marker keeps its time; a manual or pressure suspension keeps its own marker and gets no idle one). Identity,
   native conversation, title and recency do not change. A status line "Moved to the structured transport; the next
   message resumes this conversation." is appended and `session.updated` is emitted.
4. The row is now asleep. Its next message restores it through the plugin (`resume` by native id). Nothing is loaded at
   move time, so a flip does not start 38 provider processes.

Working rows, rows with queued input or a model change, rows with a scheduled or running recovery, `pending:` rows and
Claude rows with no transcript stay on tmux and are retried on later passes (a missing transcript is logged once per row).
A recovering row moves after its recovery has resolved. A row with launch flags stays on tmux until it is released. Rows
move one way: lowering `defaultTransport` later does not move them back (release and rebind with an explicit `tmux` to do
that).

`SessionManager.structuredMigrationReport()` is the dry run: for every restorable tmux row it returns the outcome the
next pass would reach, with counts. It reads the database and asks tmux whether each session exists; it kills, moves
and captures nothing. Outcomes: `dead` and `idle` move; `working`, `queuedInput`, `modelRequest`, `pending`,
`noTranscript`, `recovering`, `launchFlags`, `notBound`, `unverified`, `externalOwner` and `providerOff` do not
move on that pass. It is served at
`GET /api/sessions/structured-migration` (authenticated, no CSRF token, read-only) with `defaultTransport`, the
providers whose lane is on, `structuredRows` (rows already moved) and one entry per row.

**Flip procedure**

The flip is a live configuration change that Bryan makes after he has deployed the Phase A build. It needs no code change.
The migration then converts idle rows on the next reconcile pass (the first pass runs 5 s after start, then every 30 s).

1. Deploy the Phase A build with the defaults off. An absent `structuredSessions` block means both lanes off and tmux
   the default, so nothing changes. Do not write the new keys into the live `config.json` before this build is the one
   running (Zod strips unknown keys when settings are saved).
2. Edit the live `config.json`: `structuredSessions.codex.enabled: true`, `structuredSessions.claude.enabled: true`,
   `structuredSessions.defaultTransport: "structured"`. Restart `agent-console.service` (configuration is read at start).
   Provider processes behind session hosts survive the restart.
3. Read `GET /api/sessions/structured-migration` before the first pass (it runs 5 s after start) or just after: the
   counts say how many rows move now (`dead`, `idle`) and what blocks the rest.
4. The migration runs inside reconcile. Watch the report fall to the rows that cannot move; each moved row shows the
   status line above. Working rows move when they go idle, recovering rows when their recovery has resolved. Rows with
   launch flags stay on tmux.
5. Rollback: set `defaultTransport` back to `tmux` and restart. New conversations return to tmux; rows already moved
   keep working on the structured transport, because the transport is stored on the row.

**Re-adoption across restarts and the other fixes (lane C5 and the round 1 fix commit `e7e0a2a`)**

- **Survivors after a backend restart.** A provider process behind a session host outlives the backend, and so does the turn it
  is running. The first `reconcileSessions` pass does three things before it decides which idle conversations sleep. It ends
  the session hosts that no conversation owns (below). It hands the candidate rows to `reattachSurvivors`: every awake
  (bound, not suspended) row of a per-session plugin, and every row of a shared plugin (Codex) that is still marked working.
  Then it lets the event loop read the frames an adopted process sends right behind its handshake. The optional
  `TransportInstance.reattach(nativeSessionId, options)` returns the conversation's own process or thread when one survived,
  and undefined when there is none. It never starts a process. A survivor is loaded like any other (new epoch, "Reconnected
  to the running agent process"), so idle sleep, pressure suspension and release can end it. A row with no survivor stays
  unloaded and resumes on its next use. The same lookup runs before loss handling on every path that loads a working row
  (the screen poll, a queued message, a wake). Without it, a poll that arrives before the first pass would write the loss
  line and start recovery for a turn that is still running. A use of the conversation waits for its own lookup, so a resume
  never starts a second process beside the survivor.
- **A running turn is adopted.** A turn the survivor reports (`TransportSession.activeTurn`, or an `adopted` `turn.started`)
  becomes the row's turn. The row stays working, recency does not move, Stop reaches the provider, a suspend is refused as a
  running turn, and the terminal ends it once. Requests the provider still has open are announced again as `replay`: no new
  status line, no push and no recency.
  - Claude. `reattach` connects with the `attachOnly` request flag (live host, exact recorded command line, nothing started or
    ended), requires the recorded launch to name this native id, refuses a session another live process holds in the CLI
    registry, and repeats `initialize`. A `session_state` that is not `idle` starts an adopted provider turn before anything
    else is adopted. A CLI that refuses the repeated `initialize` is taken as running. When the `result` went to the earlier
    backend, an idle state change ends the turn. Verified on the real CLI (proof step k2): a 25 s count that was running
    across a backend restart was re-adopted within about 0.5 s of boot, by the screen poll an open page makes and not by the
    reconcile pass (5 s after start). The first poll read working and wrote no loss line. Stop interrupted the count (idle after 0.26 s, command gone after
    0.33 s). The next message completed on the same pid. No recovery or wake text reached the conversation, and the CLI
    registry showed one holder, the host's child.
  - Codex. `reattach` connects to the running host (`attachOnly`) and `thread/resume`s the thread. The session reads the
    thread's status and newest turns, adopts a running turn, reports a turn that ended while nobody listened once, and holds
    a question again only while the thread waits on user input. A held question is answered by id over the same relayed
    stdin. The details are in `docs/structured-providers.md`, "Restart adoption". Verified on the real app-server (proof
    step k2): the thread was attached again about 0.5 s after boot on the same app-server (new epoch), the first poll read
    working and wrote no loss line, Stop interrupted the turn (idle after 19 ms, rollout `turn_aborted: interrupted`), and the
    next message completed on the same pid with no recovery or wake text. One gap at the time (fixed in round 3): the counting command was gone only 19.9 s
    after Stop, when its 25 s count ran out (finding 11).
  - A shared row that is working but whose thread runs no turn loses it the way a dead connection does: status line,
    `isWorking=false`, and RunRecovery `process_exited` for unattended work.
- **Orphan hosts.** At the first pass the manager ends the session host, and the launch record, of every per-session
  conversation that has no restorable structured row. A released or deleted conversation therefore cannot leave a 300 to
  400 MB process running for ever. `release` and `unload` do the same for a conversation that is not loaded (a survivor
  nobody adopted, or an adoption that failed), so idle sleep ends the process and not only the row marker. The shared Codex
  host is never swept.
- **Slow hosts and dead groups.** Busy (`TransportBusyError`) means the host, or the provider behind it, is running but
  did not answer in time: the connect or the hello timed out, or the handshake after connecting (Claude's repeated
  `initialize`, Codex's `account/read`) timed out. A refused connect means the host is gone and the row is reported absent;
  an exit or a protocol error during the handshake is a plain failure with its reason, and the row's turn is settled as
  lost with the generic loss line (the reason goes to the log); a refusal of the repeated `initialize` is handled by the
  plugin (Claude adopts the process with an unknown turn state, Codex treats "already initialized" as success). The manager
  leaves a busy survivor alone and asks again on each load for up to 10 minutes (`SURVIVOR_BUSY_LIMIT_MS`), then settles
  the turn as lost with "did not answer for 10 minutes". Stop on a busy row clears working and says the process could not
  be reached and may still be running (round 2, N4; round 3, M3; round 4, R4-3 and R4-4). An ordinary open is bounded the
  same way in both plugins: consecutive handshake timeouts and silent hosts, and for Codex three request timeouts in a row
  on a live connection (`LIVE_CLIENT_TIMEOUT_LIMIT`), count toward one run kept by the plugin (per Console for Codex, per
  conversation for Claude) that outlives a dropped instance; while the run is younger than 5 minutes
  (`APP_SERVER_UNRESPONSIVE_LIMIT_MS`, `CLAUDE_UNRESPONSIVE_LIMIT_MS`) the open reports busy, and the first timeout past it
  ends the process and its session host (`PluginContext.endHost`) and replaces it in the same call (Codex starts a fresh
  app-server, Claude relaunches in the open's own mode, `--resume` when a transcript exists); any frame on a live connection
  ends the run (a late answer to a timed-out handshake is never seen, and a backend restart starts the run again); an
  attach-only reattach never counts and never ends a busy process (round 4, R4-1; round 5, R5-1 and R5-5; round 6). The host ends the
  rest of the child's process group after the child exits (see "Ending").
- **Plugin fixes.** Frames that name only unknown uuids become a provider turn. An empty headless chat restarts under the
  same id. `resume` never starts a process beside a holder. A configured `CLAUDE_CODE_*` key passes through. See "Claude
  plugin design".
- **Stop and queued steers.** Stop sends `cancel_queued: true`. The steers the CLI drops come back in the interrupt result
  (`cancelledSteerIds`). The plugin adds a notice, and the manager marks each queued message `failed` with "cancelled by Stop"
  (and adds one status line when a dropped message had no journal entry).
- **Failures before the write.** A failure a retry may fix (the process exited, or the connection was gone, before anything
  was written) throws `NotSentError`: the message is queued and tried again for at most ten minutes of not-sent attempts
  (the clock resets when the drain defers for another reason), then fails with the last error and "nothing was sent". A
  failure no retry can fix (a model or effort the CLI refuses, an image file gone from the store) throws `SendRejectedError`:
  the message fails at once with the reason, a direct send answers "Nothing was sent", and an automatic wake or recovery
  prompt records a definite failure with that reason instead of an uncertain outcome (round 2, N3; round 3, L3 and L4).
- **Questions.** An answer for a request that is not open (the CLI withdrew it, or its turn ended) throws
  `RequestNotPendingError`. The service closes the card and the route answers 404. A question that outlived a backend
  restart is shown again without a second status line or push and without moving recency. A held Codex question does not
  count against the JSON-RPC client's limit of 32 concurrent server-request handlers, so open questions can never make it
  refuse approvals it must decline. A question the Console cannot show gets the fixed log line "Declined a question the
  Console cannot show"; the details stay in the server log.
- **Profile-less Claude rows.** A per-session Claude row with no cost profile and no model of its own (a migrated tmux row, a
  history bind) resumes with effort `medium` and no model, which is what the tmux resume template gives it. This applies on
  the resume and on every turn. Nothing is stored on the row. (The first version stored the `medium` profile, which is
  `claude-opus-5-5` at `xhigh`.)
- **Background work.** `TransportSession.hasBackgroundWork()` (the Claude session derives it from
  `system/background_tasks_changed`, `task_started`, `task_notification` and terminal `task_updated` frames) blocks idle sleep,
  pressure suspension and manual suspend with the reason `background_work`, like the tmux screen check. The flag is ignored
  after four hours without any event from the transport. After a reattach the plugin waits up to 1 s for the snapshot the CLI
  is expected to send behind the reply to the repeated `initialize` (the fake `claude` models it), so the decision that
  follows does not read an empty set that only looks empty. It sends no separate `background_tasks` request. The proofs do
  not record whether the real CLI sent that snapshot.

## Parity features

- **Question card** (built in C3, adjusted in round 1). A `request.opened` event of `kind: question` becomes a card in the
  conversation pane with the question text, options and a free-text answer. `POST /api/sessions/:id/requests/:requestId`
  answers it exactly once. Claude `AskUserQuestion` (`can_use_tool`) and Codex `item/tool/requestUserInput` are live: the
  provider waits, the answer is the tool result, and the turn goes on. A Codex question the model asks in a
  message (`request_user_input_async`, the only form `codex-cli` 0.164.0 offers in the default mode) is message mode. The tool
  answers `{accepted: true}` at once and Codex raises no server request. Instead it emits an `agentMessage` item (`item/started`,
  then `item/completed`) with `delivery: 'async'`, `phase: 'final_answer'` and `questions: [{ title, options?: string[] }]`; the
  item id is the tool call id. The turn stays open while the model polls with `sleep`. The plugin maps the item to a
  `request.opened` with `responseMode: 'message'` and questions `{ id: 'q1', …, question: title, options: [{ label }],
  allowCustom: true }` (request id `item:<itemId>`). Nothing waits on the answer, so the service sends the person's answer as an
  ordinary message, a steer while the turn is open, which ends the same turn. A question the Console cannot show as a card raises
  a warning notice (a status line) and does not fail silently. The frames were captured from the real app-server.
  A live question blocks the turn, so it is also pushed through the existing grant push channel. Approvals, `ExitPlanMode`
  (unproven under bypass) and elicitations from MCP servers are declined and logged.
- **Images.** The existing attachment flow (image store) feeds Codex `localImage` items and Claude base64 image blocks; the
  route stops refusing images for structured rows. Only files directly in the image store are accepted as attachments.
  - Claude. The API rejects an image above 5 MB. The plugin does not rely on the CLI to resize a block it is handed (unverified
    either way: round 2 notes that the 133 KB block in the transcript may mean the CLI re-encodes it, which would make the fit
    a second line of defence). An oversized block would end the turn with an image error and could stay in the transcript.
    `claude/image-fit.ts` (sharp) sends an image
    unchanged when its long edge is at most 1568 px and its base64 text is at most 4.5 MiB. Otherwise it scales the image
    down and re-encodes it (PNG stays PNG, everything else becomes JPEG), in steps, until it fits. In the proof a 6.8 MB
    2560x1440 PNG became a 133 KB block in the transcript.
  - Codex reads the file itself. For the same large PNG it sent about 4.0 MB to the model.
  - The tmux envelope tells a terminal agent to open the files ("Inspect the attached local image files with Read"). A
    transport that attaches images natively would pay for each image twice, so that line is dropped from the text it sends.
    The image rows stay, so the stored message, the event log and the provider transcript still match. Proof step h shows
    no `Read` call.
- **Granted launches** follow the default transport (built in C2): a bind that names no transport takes
  `structuredSessions.defaultTransport` for providers whose lane is on, so helpers launch structurally after the flip. A
  launch that carries command-line flags keeps tmux.
- **Default transport** config: `structuredSessions.defaultTransport: 'tmux' | 'structured'` plus the
  per-provider `enabled` flags; `/new/bind`, history binds and granted launches use the default when the body does not
  say (built in C2). The flip is a config change on the live server after the Phase A build is deployed.
- **Migration** (built in C2): runs inside `reconcileSessions` while the default is structured, not as a one-off command;
  converts tmux rows as described in decision 4, retries rows that were working or recovering on later passes, leaves rows
  with launch flags on tmux, and `GET /api/sessions/structured-migration` reports what is left and why.

## tmux retirement (Phase B)

Delete, with their tests and docs: `sessions/tmux-client.ts`, `tmux-health.ts`, `session-screen.ts`,
`screen-heuristics.ts`, `keystroke-transport.ts`, `output-watcher.ts`, `last-user-input.ts`,
`pending-adoption.ts`, the Claude terminal normalizer in `live-output/filters.ts`, the tmux branches of
`session-manager.ts` (about 3,500 of its 5,355 lines), the paste-confirmation and `needs_review` states of
the input queue, `routes/sessions.ts` `/keys` literal keys and Text Bypass, `/raw-output`, the terminal
`/screen` (replaced by the synthesized status), the web `LiveSessionInputBridge`, Text Bypass, key buttons,
terminal panel and screen polling, `providers.*.commands` config (replaced by `structuredSessions`),
`scripts/prove-active-input.mjs`, `prove-session-recovery.mjs`, `prove-peer-message-wake.mjs`,
`prove-session-close.mjs`, `prove-granted-launches.mjs`, `prove-agent-grants.mjs` (rewritten against the
structured path), `smoke-codex-adoption.mjs`, and the FakeTmux fixtures (28 test files rewritten against
the fake plugin). `bound_sessions.tmux_session_name` becomes nullable in a later schema version. The
`design/extension-agent-lane` branch is deleted.

## Verification

- Unit: the Claude plugin against a scripted fake `claude` (`structured-claude-plugin`, and `structured-claude-reattach`
  for a process found again mid-turn), the relay and its factory (`structured-session-host`), per-session paths,
  questions, images, survivors, adoption, orphan hosts, the default transport and the migration with the fake plugin
  (`structured-session-*`), Codex questions, images and restarts (`structured-codex-requests`,
  `structured-codex-restart`, and `structured-session-codex-restart` through the real manager, plugin and session host).
  The commands and what each file covers are in `docs/agent_docs/running_tests.md`.
- Real proofs. Each is opt-in (`--run`, after `npm run build`), runs one isolated backend (temp database and runtime,
  scratch git project, private tmux socket, free port) that never touches the live Console, uses the host's Claude and Codex
  logins with short fixed prompts, and ends with no `claude`, `codex app-server`, session host or `agent-coord.mjs mcp` of its
  own left running and its temp root removed. Every proof ends with a scan for those four kinds of process that name its temp
  root; anything the scan has to end is recorded under `cleanup` and fails the run, and a failure during setup or before the
  proof's own cleanup still removes the temp root. They share `scripts/structured-proof-kit.mjs`; the Codex proof keeps its
  own harness and imports only the PNG builders, the event-log reader, the control-text list and the process scan from it.
  - `scripts/prove-structured-claude.mjs` (14 steps): bind, first reply with transcript and human turn origin, coordination
    hook and MCP call, steer, Stop, an `AskUserQuestion` answered through the card route, an image turn, a live model and
    effort switch, manual sleep and restore, k1, k2, l and release (m).
    - k1: graceful backend restart while idle; the first reconcile pass adopts the process and the same pid answers.
    - k2: graceful backend restart during a running 25 s count; no "connection ended" line, re-adopted before any message,
      `isWorking` stays true, Stop interrupts it, the next message completes on the same pid with no recovery or wake text.
    - l: a 2560x1440 PNG above 5 MB completes without an image error and the reply names its dominant colour (step h keeps
      the 64x64 case).
  - `scripts/prove-structured-migration.mjs` (9 steps): one real tmux Codex chat and one real tmux Claude chat are moved by
    the reconcile pass after `defaultTransport` flips to `structured`, then answer on the structured path in the same native
    conversation. The tmux Claude runs without `--strict-mcp-config`, as in production.
    - b2: records which coordination MCP server the tmux Claude started and asserts only the SessionStart registration in the
      proof's own runtime.
  - `scripts/prove-structured-codex.mjs` (16 steps): the earlier 12 steps (release is now m) plus a question step (h2), an
    image step (h3), k2 and l.
    - k2: the restart during a running count as for Claude; the row reads working on the same app-server, Stop interrupts it,
      the next message completes on the same app-server pid, no "connection ended" line and no recovery or wake text.
    - l: the same large PNG; the turn completes and the reply names the colour.
- Full suites and typecheck; the three known timing failures on this host stay the baseline.

Decision log. The plan said the migration proof would run on a copy of the live database. It runs on fresh chats created in the
isolated backend instead. A copy of the live database names the live tmux sessions, transcripts, runtime and 38 real
conversations, so a mistake would kill or write to real work; fresh chats exercise the same code (`classify`, kill, confirm,
`setTransport`, resume) with nothing to lose. The cost is that a real-world row shape the proof does not create (a history-bound
Claude row without a profile, a working row, a row whose tmux session already died) is covered only by the unit tests and the
dry-run route. The tmux Claude command of that proof first carried `--strict-mcp-config`, to keep the user-scope MCP entry (which
names the live runtime) out of the proof. Production never passes it, so the proof now runs the installed command and records which
coordination MCP server the CLI started; the cost is that the proof starts the user-scope MCP servers of `~/.claude.json` as a real
tmux chat does, and calls none of their tools.

## Verification evidence

**Round 5 run (current).** On `52ee445` (the review round 5 fixes), 2026-10-27 04:43 to 04:55 UTC, the same sequence: the
server suite (106 files, 2473 tests; the only failures are the three `main` failures), the web suite (19 files, 215 tests),
`npm run build`, then the three proofs with the Stop poll starting at Stop, no process left behind:

- `claude-proof-2026-10-27T04-49-43Z.json`: 14 of 14. Step f: the command gone 163 ms after Stop. Step k2: adopted 505 ms
  after boot; the count gone 171 ms after Stop; one interrupted turn-end after Stop; the steer unanswered 2.07 s into the
  count and answered after it.
- `codex-proof-2026-10-27T04-51-49Z.json`: 16 of 16. Step h: the command gone 158 ms after Stop. Step k2: attached 689 ms
  after boot; the count gone 175 ms after Stop; one aborted turn-end after Stop; the steer unanswered 2.14 s into the
  count and answered after it.
- `migration-proof-2026-10-27T04-54-08Z.json`: 9 of 9.

**Round 4 run.** On `dd3c615` (the review round 4 fixes), 2026-10-27 04:02 to 04:13 UTC, the same sequence as the
round 3 run: the server suite (105 files, 2448 tests; the three `main` failures plus one `claude-run-state` test, "protects
paused sessions, input waits, native drafts, ownership and memory limits", that failed under load and passed alone right
after), the web suite (19 files, 215 tests), `npm run build`, then the three proofs, no process left behind:

- `claude-proof-2026-10-27T04-08-36Z.json`: 14 of 14. Step f: the command gone 334 ms after Stop. Step k2: adopted 532 ms
  after boot; Stop ended the count 329 ms after Escape; one interrupted turn-end after Stop, one completed after the next
  message; the steer during the re-adopted turn was unanswered 2.09 s into the count and answered after it.
- `codex-proof-2026-10-27T04-10-43Z.json`: 16 of 16. Step h: the command gone 330 ms after Stop. Step k2: attached 557 ms
  after boot; Stop ended the count 186 ms after Escape; one aborted turn-end after Stop, one completed after the next
  message; the steer was unanswered 2.11 s into the count and answered after it.
- `migration-proof-2026-10-27T04-13-04Z.json`: 9 of 9.

**Round 3 run.** On `b2e6e5e` (the review round 3 fixes), 2026-10-27 03:24 to 03:35 UTC, `claude` 2.1.310,
`codex-cli` 0.164.0: the full server suite (105 files, 2430 tests; the only failures are the three `claude-ready-lifecycle`
and `claude-run-state` tests that fail on `main` too), the web suite (19 files, 215 tests), `npm run build`, then the three
proofs one at a time with the tightened assertions, no process left behind:

- `claude-proof-2026-10-27T03-30-52Z.json`: 14 of 14. Step f: idle 262 ms and the command gone 324 ms after Stop. Step k2:
  the turn adopted 485 ms after boot; Stop ended the count 327 ms after Escape; one interrupted and no completed turn-end
  record after Stop, one completed after the next message; a message sent during the re-adopted turn was delivered as a
  steer, was still unanswered 2.36 s into the count, and was answered after it; the steered turn ended exactly once.
- `codex-proof-2026-10-27T03-33-03Z.json`: 16 of 16. Step h: the command gone 327 ms after Stop. Step k2: adopted 457 ms
  after boot; Stop ended the count 327 ms after Escape (the round 2 build left it running: the adopted turn now takes its
  commands from `thread/backgroundTerminals/list`); one aborted turn after Stop, one completed after the next message; the
  steer during the re-adopted turn was unanswered 2.36 s into the count and answered after it. Step h2 showed the
  message-mode card and delivered the answer as a steer.
- `migration-proof-2026-10-27T03-35-02Z.json`: 9 of 9.

The run before it, on `59fde29` (2026-10-27 02:44 to 02:55 UTC), is kept as `*-proof-2026-10-27T02-5*.json`: Claude 14 of
14, migration 9 of 9, Codex 15 of 16 with k2 failing the new 5 s Stop rule, which is what led to the probe and the round 3
fix.

**Round 1 and 2 runs.** Real-provider proofs, 2026-10-26, `claude` 2.1.310, `codex-cli` 0.164.0, run on `e7e0a2a` (the review round 1 fixes) with a
clean source tree. The evidence JSON is in `docs/research/cutover-2026-10-26/` (steps, key values, findings, cleanup; no message
bodies, tokens or addresses):

- `claude-proof-2026-10-26T18-36-00Z.json`: 14 of 14 passed in 91 s.
- `codex-proof-2026-10-26T18-37-31Z.json`: 16 of 16 passed in 152 s.
- `migration-proof-2026-10-26T18-40-03Z.json`: 9 of 9 passed in 34 s.

Each run also writes an untracked copy under `test-results/`. All three ended with no cleanup problems: no `claude`, `codex
app-server`, session host or `agent-coord.mjs mcp` of the proof was left, and the temp roots were removed. The earlier runs of
the same day, on `daa80d7` (12 of 12, 14 of 14 and 8 of 8, before the round 1 fixes), stay beside them.

**Claude proof** (14 steps)

| Step | Result and key values |
|---|---|
| a. tree | `structuredProviders: ['claude']` |
| b. bind | `transport: structured`; `conversation_ref` is the session UUID the Console minted; sentinel name `structured:<id>`; no raw log; the per-session host record `claude-<id>.json` names the `claude` pid, its own process group and start times that match `/proc`, and the process is the host's child with a parent death signal; the process environment holds the isolated `AGENT_COORD_RUNTIME` and `AGENT_CONSOLE_CONFIG`, its own `AGENT_CONSOLE_SESSION_ID`, no `TMUX`, and `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`; the argv is stream-json without `-p`; one coordination MCP server child, with the isolated runtime |
| c. first message | profile switched to `low` before the turn with the same pid; queue record `submitted`, `deliveryMode: turn`; reply `PONG`, `lastResponseAt` set; transcript at `~/.claude/projects/<escaped cwd>/<id>.jsonl`, the prompt row has `turnOrigin: human`, `origin: {kind: human}`, `entrypoint: sdk-cli`, `promptSource: sdk`; the index points at it; the first request used `claude-sonnet-5` at effort `high` although the process was launched with `claude-opus-5-5` / `xhigh` |
| d. coordination | the SessionStart hook registered `native_session_id` = the Claude session id in the isolated runtime (the hook command is the live checkout's helper; the env redirects it); the agent called `mcp__agent_console_coordination__agent_coordination` (`status`), the call succeeded, reply `REGISTERED`; `last_seen_at` advanced; one `agent-coord.mjs mcp` process with the isolated runtime was seen |
| e. steer | message sent mid-turn: `deliveryMode: steer`, same `turnId`; recorded as `attachment:queued_command` (origin human, `humanTurn: true`) followed by a `queue-operation remove`; the 30 s command printed all 30 numbers first; reply `STEERED` 30 s after the steer; one Stop hook for the exchange |
| f. Stop | idle 264 ms after Escape; same pid, still the host's child; the counting shell command gone 326 ms after Escape; transcript marker `[Request interrupted by user for tool use]` |
| g. question | `AskUserQuestion` became one pending request (`kind: question`, options Red/Blue, `multiSelect: false`, `allowCustom: true`) while the session read as working; the answer through `POST /api/sessions/:id/requests/:requestId` left the row, a second answer was refused (404), the tool result the model received held the answer, reply `blue` |
| h. image | a 64x64 solid green PNG through the image route and `/keys`: the user row holds one base64 `image` block and the model made no `Read` call; reply `Green` |
| i. model and effort | `medium` turn: request model `claude-opus-5-5`, effort `xhigh`; back to `low`: `claude-sonnet-5`, `high`; same pid and same command line; one `/model` row per switch in the transcript, none in the timeline |
| j. sleep and restore | the assignment was `waiting`, so the manual suspend was accepted (the proof checks the 409 refusal for an `active` assignment only when it applies); the process and its host exited, the screen route 404s while suspended; resume started a new process (pid 976 to 3223) on `--resume <same id>` with the row's session identity in its environment and a new epoch; reply `RESTORED` |
| k1. restart while idle | the process and its host survived `app.close()`, the host record still matched `/proc`; the first reconcile pass adopted the process before any message (new epoch, screen `Claude (structured) idle`, one process under the host); reply `RESUMED` from the same pid (3223); the CLI registry showed exactly one live holder of the session |
| k2. restart during a running turn | a 25 s count was running (one command process) when the backend closed. The first screen poll after boot returned HTTP 200 and `Claude (structured) working`, with no loss line. The turn was adopted 478 ms after boot, before any message. The row read working in all 6 polls while the count was seen running (3.7 s). Stop: idle after 263 ms, count gone after 325 ms, marker `[Request interrupted by user for tool use]`. The next message completed on the same pid (3223) and host (3215), one live holder, no recovery or wake text in the conversation |
| l. large image | a 6,786,652 byte 2560x1440 PNG: the stored file is unchanged, the block recorded in the transcript was 133,065 bytes (base64 `image/png`), the turn completed with no image error, the reply names the dominant colour, no `Read` call |
| m. release | row `ended`, `should_restore` 0, process and host gone, no process with the proof's runtime or temp root, no `claude`, no `agent-coord.mjs mcp`; then backend shutdown with still nothing left |

**Codex proof** (16 steps)

| Step | Result and key values |
|---|---|
| a. tree | `structuredProviders: ['codex']` |
| b. bind | `transport: structured`; `conversation_ref` is the thread UUID; `structured:<id>` name; no tmux server; `pid` is the app-server (4083) held by the `codex` session host (4075); the child environment has the isolated `AGENT_COORD_RUNTIME` and `AGENT_CONSOLE_CONFIG` and no session identity; the argv holds the coordination MCP overrides; the process group has 2 members |
| c. profile | `low` applied before the first turn with the same pid; screen shows `gpt-6-luna xhigh` |
| d. first message | queue record `submitted`, `deliveryMode: turn`; `lastResponseAt` set |
| e. rollout | file under `~/.codex/sessions` (19 records), the index points at it, the first turn ran on `gpt-6-luna` at `xhigh` |
| f. coordination | the SessionStart hook registered the thread id in the isolated runtime; the agent called the coordination MCP tool (4 call records); one `agent-coord.mjs mcp` process with the isolated runtime |
| g. steer | message sent mid-turn: `deliveryMode: steer`, same `turnId` |
| h. Stop | idle after 275 ms, rollout `turn_aborted` with reason `interrupted`, counting command gone after 335 ms |
| h2. question | Run on `e7e0a2a`. `request_user_input_async` was called twice: the first call was rejected for its arguments ("unknown field `question`, expected `title`"), the second returned `{"accepted":true}`. No card appeared, because that build looked for `questions` with `id` and `question` fields, which the real item does not carry. The model polled with one `sleep` call and the step stopped the turn after 60 s, recorded a finding and passed. The real frames were then captured and the mapping corrected (finding 9). Step h2 now fails when Codex accepted the question and no card appears; this committed evidence predates that change |
| h3. image | a solid green PNG through the image route; the rollout holds the image as a `message` item; reply `Green` |
| i. sleep and restore | manual suspend accepted (assignment `waiting`); screen `asleep > idle > working > idle`; new epoch on restore; the manual marker cleared |
| j. medium round trip | `medium` reached the provider (`gpt-6.1-sol`), the turn was stopped, back to `low`; same pid |
| k. restart while idle | the app-server (4083) and the host (4075) survived the shutdown; the next turn completed on the same pid; the host record still matched `/proc` |
| k2. restart during a running turn | a 25 s count was running when the backend closed; the app-server, host and count survived. The first screen poll after boot returned HTTP 200 and `Codex (app-server) working`, with no loss line. The thread was attached again 481 ms after boot (new epoch) on the same app-server, with no second app-server. The row read working in all 6 polls while the count was seen running (3.7 s). Stop: idle after 19 ms, rollout `turn_aborted: interrupted`, but the counting command was gone only 19.9 s after Stop (finding 11). The next message completed on the same pid and host record; no recovery or wake text in the conversation |
| l. large image | a 6,786,789 byte 2560x1440 PNG: the turn completed with no run failure, error record or image status line, and the reply names the dominant colour; Codex sent about 4.0 MB (4,007,430 bytes) for it |
| m. release | row `ended`; the shared host and app-server keep running after release and after backend shutdown, by design (5 processes of the proof, one a coordination MCP server); after the host is ended with `terminateHost` no process of the proof remains |

**Migration proof** (9 steps)

| Step | Result and key values |
|---|---|
| a. bind on tmux | two `transport: tmux` rows through `/new/bind`, real `ac-codex-…` and `ac-claude-…` sessions on the private socket |
| b. first replies | both answered `TMUX`, each row got a native id (Codex thread UUID, Claude session UUID) and an indexed transcript; the Codex first message relaunched Codex and bound a new Console session id (`restartPendingSessionWithInitialPrompt`), which the proof follows; 3 and 2 processes carried the session ids |
| b2. Claude coordination | the tmux Claude, run without `--strict-mcp-config` as in production, started 1 coordination MCP server with the isolated runtime (the per-session `--mcp-config` won over the user-scope entry); its SessionStart hook registered it in the proof's runtime (assignment `waiting`) |
| c. flip | config rewritten to `defaultTransport: structured`, backend closed and rebuilt (both tmux sessions survived the backend); the dry run, 0.1 s after boot, listed `providers: [codex, claude]`, `structuredRows: 0`, `idle: 2` and 0 for every other outcome, including `recovering` and `launchFlags` |
| d. reconcile | the first pass flipped both rows: `transport: structured`, `idle_suspended_at` set, `tmux_session_name` `structured:<id>`, `pid` and `raw_log_path` cleared, `conversation_ref` unchanged, `should_restore` 1; the report then showed `structuredRows: 2` and every outcome 0 |
| e. tmux gone | neither tmux session exists, the private tmux server is gone, none of the 5 processes of the tmux phase is alive, nothing carries the proof's runtime |
| f. Codex | `MIGRATED` on the structured path: app-server held by the `codex` session host, same thread id, the earlier `TMUX` reply still in the conversation, index unchanged, `idle_suspended_at` cleared |
| g. Claude | `MIGRATED`: a `claude` process on `--resume <same id>` with `--model claude-opus-5-5 --effort xhigh` (the row kept the profile it had on tmux), own session id in its environment, host record names its pid, the earlier `TMUX` reply still in the transcript |
| h. release | both rows `ended`; the Codex host ended with `terminateHost`, the Claude host with the release; nothing left |

Automated suites on `e7e0a2a` (`env -u NODE_ENV`): server `vitest run` 2369 passed, 5 skipped (the opt-in real `claude` and
`codex` tests), 3 failed. The three failures are the same timing-sensitive Claude tmux tests that fail on untouched `main` on
this host. Web `vitest run` 215 passed. `npm run typecheck` and `npm run build` clean.

**Findings from the proofs** (what the research briefs left open or got wrong):

1. *Steer folds at the tool boundary and does not shorten a running command.* A plain message sent while a turn runs is queued
   at once (`queue-operation enqueue`), then folded into the running turn after the current tool call returns and before the next
   model request. The transcript holds `attachment {type: queued_command, prompt: [{type: text}], source_uuid, delivery_id,
   origin: {kind: human}, humanTurn: true}` followed by `queue-operation remove`. There is one Stop hook for the exchange, so it
   is one turn. A 30 second shell command printed all 30 numbers before the fold, and `STEERED` came 30 s after the steer. A
   person who wants a running command cut short must press Stop.
2. *Interrupt during a tool.* Idle in about 265 ms, same pid, the foreground shell command killed within about 325 ms, no Stop
   hook. The transcript holds a tool result "The user doesn't want to proceed with this tool use. The tool use was rejected…"
   and a text row `[Request interrupted by user for tool use]` (the brief saw `[Request interrupted by user]` for an interrupt
   before the model call). `isNativeInterruption` accepts both.
3. *`AskUserQuestion` under bypass reaches the host.* Launched with `--dangerously-skip-permissions --permission-prompt-tool
   stdio` it arrives as `can_use_tool`, blocks the turn until answered, and the answer comes back as a tool result "Your
   questions have been answered: …". `ExitPlanMode` was not exercised.
4. *Hooks register per process.* `SessionStart` (at launch, before the first prompt), `UserPromptSubmit`, `PreToolUse`,
   `PostToolUse` and `Stop` run in a headless process from the user's installed settings. `Stop` does not run for an interrupted
   turn. They register in the isolated runtime although their command is the live checkout's helper, because the plugin's
   per-process `AGENT_COORD_RUNTIME` and `AGENT_CONSOLE_CONFIG` redirect it.
5. *MCP name clash.* `~/.claude.json` defines a user-scope `agent_console_coordination` server that names the live runtime. The
   per-session `--mcp-config` entry with the same name won, for the structured Claude and for the tmux Claude of the migration
   proof: exactly one coordination server ran, with the isolated runtime. If the CLI ever changed that precedence, a conversation
   would talk to the wrong Console, so the Claude proof fails the MCP call before it is made when the server's runtime is not its own.
6. *Headless transcript shape.* `entrypoint: sdk-cli`, `promptSource: sdk`, `turnOrigin: human` (because `origin` is stamped),
   request records labelled `querySource: "sdk"`, `stop_hook_summary` rows and no `turn_duration` rows. Console's parsers read none
   of these.
7. *Live model and effort switch works.* `set_model` and the effort follow the profile on the next request of the same process,
   and each switch writes a `<command-name>/model` local-command row into the transcript. The parser skips those rows, and the
   proof checks that the timeline shows none.
8. *Images.* The CLI adds a `[Image: source: …]` meta row. Console fits the image before it sends it (a 6.8 MB PNG became a 133 KB
   block in the transcript; whether the CLI also re-encodes blocks is not known) and drops the duplicate read instruction from the
   text (no `Read` call in steps h and l). Codex reads the file itself and sent about 4.0 MB for the same large PNG.
9. *Codex questions outside plan mode.* On `codex-cli` 0.164.0 in the default collaboration mode the model uses
   `request_user_input_async`. The tool returns `{"accepted":true}` at once and Codex raises no blocking request. The real frames were
   captured (`docs/research/cutover-2026-10-26/codex-async-question/run1.jsonl` and `run2.jsonl`, with the capture script): Codex emits an `agentMessage` item (`item/started`, then `item/completed`) with `delivery: 'async'`,
   `phase: 'final_answer'` and `questions: [{ title, options?: string[] }]`, with no `id` or `question` fields; the item id is the
   tool call id. The turn stays open while the model polls with `sleep`, and a plain user turn or a `turn/steer` ends it. The
   mapping at `e7e0a2a` expected another shape, so the proof run recorded here showed no card (round 2, N2). The plugin now maps
   the real shape to a message-mode card, and the proof run of 2026-10-27 02:53 UTC on `59fde29` showed the card 5.5 s after
   the call, answered it through the card route, and saw the answer reach the model as a steer (step h2). A blocking
   `item/tool/requestUserInput` needs plan mode. In earlier runs the turn sometimes ended with the question as ordinary
   assistant text.
10. *Reattach after a backend restart.* A repeated `initialize` on a running process is accepted. The process keeps its pid and its
    place in the CLI registry (exactly one live holder, the host's child), and the reply's `session_state` tells the new backend
    whether it is mid-turn. A turn running across the restart was re-adopted within about 0.5 s (k2). This settles the two
    "unverified against the real CLI" points of lane C5 and the mid-turn restart.
11. *Codex Stop after a restart did not end the command.* In k2 the turn was interrupted at once (idle after 19 ms,
    `turn_aborted: interrupted`), but the counting command was gone only 19.9 s later, when its 25 s count ran out. Without a
    restart it is gone within 0.34 s (step h). The plugin terminates a command (`thread/backgroundTerminals/terminate`) only when
    it saw that command's `item/started`, and this command started before the restart. Round 2 traced it in the code: an
    adopted turn is created with an empty list of commands, so Stop has nothing to terminate, and Codex does not end a turn's
    command on `turn/interrupt` by itself. Step k2 passed only because its 20 s wait outlasted the rest of the 25 s count.
    The round 2 fix read the turn's items (`thread/items/list`) for in-progress commands; the proof run of 2026-10-27 02:53 UTC
    on `59fde29`, with k2 now requiring the command gone within 5 s, failed that step. A direct probe of codex-cli 0.164.0
    (`docs/research/codex-app-server-2026-10-26/background-terminals-probe.md`) showed why: the item listing never contains a
    running command, while `thread/backgroundTerminals/list` lists it (item id and process id, also for a foreground command)
    and `thread/backgroundTerminals/terminate` ends it. Adoption now tracks every live terminal of the thread on the adopted
    turn (round 3).
12. *Timing on this host.* The first Claude turn (with the profile switch and the index lookup) took 7.5 s; a manual sleep, the
    restore and a one-word turn together about 3.3 s. In an earlier run the Codex medium model (`gpt-6.1-sol`) was rate limited
    once during the migration proof (a turn waited minutes); the proofs use the low profile where a stall would hide a defect.
13. *Pending Codex first message on tmux* (not a defect of this work, but it shapes any caller): the first message of a new tmux
    Codex chat releases the session and binds a new Console session id. A caller must follow the `session.id` in the `/input`
    response; the migration proof does.

Not proven by any run: `ExitPlanMode` under bypass, `priority: "now"` during running tools, streamed deltas,
`--system-prompt-snapshot off` on a resume with authority text, TUI resume of a headless session and the reverse, a backend crash
(as opposed to a graceful restart) with a running turn, the entry shape of `pending_permission_requests` (empty in every probe),
whether the real CLI sends the background-task snapshot behind a repeated `initialize` (the plugin waits 1 s and goes on), a
held Codex `requestUserInput` across a real restart and the replay of requests that arrived while no backend listened (0.164
offers only the async tool in the default mode, so only the fake covers them), re-adopting a held `AskUserQuestion` across a real
restart, `--session-id` beside a transcript that holds only preamble, slow-host behaviour at adoption, a history-bound Claude row
without a profile (covered by unit tests) and the idle-sleep timer itself (the proofs sleep manually). The corrected Codex
message-mode card (h2) and a message sent during an adopted Claude turn (Claude k2, phase 2) were proven by the runs of
2026-10-27 on `59fde29`.

## Review and fixes

**Round 1** was an independent Opus read of `6a3fcd9..daa80d7` with scratch tests that drove the real manager and plugins
(`docs/research/cutover-2026-10-26/review-round-1.md`). It found 21 problems, two of them high:

- A running turn did not survive a backend restart in Console's eyes, for either provider. A Codex turn left in the relayed
  app-server was declared lost, recovery was sent into it, Stop did nothing, and an open question wedged it. A reattached
  Claude process was adopted without its running turn, so Stop did nothing and a suspend ended the process mid-turn.
- Both are fixed in `e7e0a2a` (see "Re-adoption across restarts and the other fixes") and proven on the real CLIs by step k2 of
  the Claude and Codex proofs. For Codex one part stayed open until round 3: Stop on a re-adopted turn did not end a command
  that started before the restart (round 2, N1; fixed and proven on `b2e6e5e`).

The other round 1 findings were fixed in `e7e0a2a`; round 2 confirmed each one except where it says otherwise below.

- Medium: frames of a turn the session did not send were credited to the send in flight; an empty headless chat could not be
  restored; `resume` could start a second `claude` beside a holder; the migration cancelled a row's scheduled recovery; granted
  launches lost their command-line flags; Claude images went to the API unscaled and the prompt told the model to open them
  again; unadopted survivors and orphan hosts were never ended.
- Low: a slow host was treated as dead; nobody swept the process group after a child exited; Stop dropped queued steers without
  telling the host; failures before the write were recorded as uncertain; an answer to a withdrawn request reported success;
  re-adopted questions moved recency and repeated the status line and push; declined questions reached the event log; image
  paths were not checked against the store; the background-work guard depended on an unsolicited frame; configured
  `CLAUDE_CODE_*` keys were dropped; the default Claude profile changed model and effort for migrated rows; held Codex
  questions used up handler slots.
- Two findings were decisions for Bryan, and the fix chose for him. Finding 7 (launch flags): an explicit structured launch with
  flags is refused, and under the default such a launch keeps tmux. Finding 20 (the default Claude profile): a row with no
  profile resumes with effort `medium` and no model, as the tmux template does, and does not take the `medium` profile.
- The proof scripts gained the mid-turn restart (k2), the large image (l), a record of which MCP server the tmux Claude starts
  (b2) and stricter cleanup. The three proofs above ran on the fixed build.

**Round 2** was a second independent Opus read of `3df649d..e7e0a2a` (`docs/research/cutover-2026-10-26/review-round-2.md`). It ran
the restart, adoption, migration, launch, orphan and host test files (all passed) and checked the proofs against their evidence
JSON. It found round 1 findings 2, 3, 5 to 12 and 14 to 21 fixed correctly (18 and 20 follow the recorded decisions), and three
not fully fixed:

- Finding 1 (a Codex turn across a restart) is partial. Adoption, the working state, the terminal, held questions and replay
  work. Stop does not end the command (N1), a slow host still gets the turn declared lost (N4), and the fallback for an
  unlisted turn never applies at the manager level (N5).
- Finding 13 is fixed with a regression (N3).
- The Codex async-question mapping did not produce a card on the real CLI (N2). The real frames have since been captured and the
  mapping corrected (finding 9).

Its verdict on `e7e0a2a`: not yet ready for Bryan's integration review. Fix N1 (with a stricter k2) and N3, and either make N2
work or withdraw its claim (N2 has since been made to work). N4 to N10 can go to Bryan as listed open items.

**Round 3** was a third independent Opus read, of `8a5a785..59fde29` (`docs/research/cutover-2026-10-26/review-round-3.md`),
beside the first full run on `59fde29` (2026-10-27 02:44 to 02:55 UTC: the server suite with only the three failures main
already has, the web suite, the build, the Claude proof 14 of 14, the migration proof 9 of 9, and the Codex proof 15 of 16,
k2 failing its new 5 s Stop rule). The review found N6, N9 and N10 fixed, N3 fixed with low residuals, N1, N2, N4, N5, N7 and
N8 partial, and four medium problems: the docs still described the round 2 bugs as current (M1); the deleted-transcript guard
missed every migrated row (M2); "busy" covered any transport failure and had no limit, so a row could read working for ever
with Stop a no-op (M3); and the N1 fix had no fallback and was unproven (M4). The proof run proved M4 at the same time, and a
direct probe of codex-cli 0.164.0 showed why (`docs/research/codex-app-server-2026-10-26/background-terminals-probe.md`):
`thread/items/list` never lists a running command, `thread/backgroundTerminals/list` does, and terminate by that process id
ends it. The round 2 proof evidence on `59fde29` is kept as `*-proof-2026-10-27T02-5*.json`.

Round 3 fixes:

- N1 and M4. Adoption tracks every live background terminal of the thread on the adopted turn (item id to process id); the
  item listing is a secondary source. Tracked and empty listings are logged at info, a failed terminal listing at warn. The
  scripted app-server in the tests now models the real CLI (no in-progress items, the command in the terminal list).
- L1. A reattach whose handshake check times out disconnects and reports busy instead of terminating the shared app-server.
- L2. While a turn is unidentified, a send is refused as a turn in progress (the manager queues it) and Stop re-lists the
  turns and interrupts the one running; the service passes an empty id for that case.
- Found by the lane: an attach-only connection with no saved instance record took the host's replay as live lines, so a
  stale response could answer a new request. Fixed and tested.
- M3. Busy is `TransportBusyError`, raised by both plugins when the host or the provider did not answer in time (see "Slow
  hosts and dead groups"; round 4 aligned the two plugins). A busy run is bounded by 10 minutes, after which the row is
  settled as lost. Stop on a busy or unloaded working row clears working with a status line.
- M2. The migration writes the conversation-history record before a Claude row flips, and the first reconcile pass writes
  it for every structured row with `lastResponseAt` (`TransportInstance.noteConversationHistory`, optional).
- L4. A `SendRejectedError` in automatic delivery is `rejected`: wakes and continuations record a definite failure with the
  reason, and recovery stops with that reason (`RecoverySubmitRejectedError`) instead of "outcome uncertain".
- L3. The ten-minute not-sent failure names the last error and says nothing was sent; the clock resets when the drain
  defers for another reason.
- L5 and L6. The docs now say Codex message-mode cards do not come back after a restart (held server-request questions
  do), and the captured frames are in `docs/research/cutover-2026-10-26/codex-async-question/`.
- N8. Claude f and k2 and Codex h require the command gone within 5 s of Stop; each k2 counts the provider's turn-end
  records (exactly one per turn) and checks the steered message is still unanswered 2 s into the count.
- M1. The passages above and in `docs/structured-providers.md` and `docs/architecture.md` describe the current behaviour.

**Round 4** was a fourth read, of `59fde29..b2e6e5e` (`docs/research/cutover-2026-10-26/review-round-4.md`), beside the
round 3 run. It found M2, M4/N1, L1's replay change, L4 and L6 fixed, M3 fixed for Claude, no tmux regression, no proof
assertion that could fail on a correct system, and no high finding. Two medium items and four low ones are fixed on this
branch:

- R4-1. The L1 fix had removed the only path that replaced a hung shared app-server, so every Codex conversation would fail
  busy for ever. An ordinary start now keeps reporting busy for consecutive handshake timeouts up to 5 minutes
  (`APP_SERVER_UNRESPONSIVE_LIMIT_MS`), then ends the app-server and starts a fresh one; attach-only never ends it. Round 5
  found the run reset with every dropped instance and moved it to plugin-level state (see Round 5).
- R4-2. After a restart, Stop ended every live background terminal of the thread, including a process an earlier turn left
  running on purpose (Codex gives terminals no turn id). The plugin now records which turn started each command (meta
  `structured-codex-commands`, one record per thread with item id to process id and turn id, written on `item/started`,
  pruned on `item/completed`, dropped on release and kept across an unload and a backend shutdown) and at adoption leaves the
  terminals recorded under another turn alone; an unrecorded terminal counts as the adopted turn's. That holds while a
  backend was attached when each earlier terminal started; it fails for a terminal started while no backend listened by a
  turn that then ended before the next backend attached, and on the first deploy of this build, when no records exist yet
  (round 5, R4-2 residuals). The second probe (`docs/research/codex-app-server-2026-10-26/background-terminals-probe.md`)
  showed that Codex kills the process group of a completed command, so an earlier turn can leave a process behind only as a
  background terminal that is still in progress, and that such a terminal carries no turn id.
- R4-3 and R4-4. One busy rule for both plugins (above); the contract text in `types.ts` says the same, and the Claude
  handshake timeout at reattach is busy instead of lost. The Codex tests assert the busy class, not only the base class.
- R4-5. JSON-RPC request ids no longer restart at 1 per connection: one counter per plugin and Console (moved off the
  instance in round 5, so a dropped instance does not reset it; ids restart only with a new backend), so a late reply to an
  abandoned connection cannot resolve the next connection's request.
- R4-6 and the L2 and N8 leftovers. The working expiry treats an unidentified turn as working; a Stop whose re-listing
  succeeds and finds no turn clears the unidentified flag (sends are accepted again) and the warn notice is raised once per
  period; the 5 s Stop window in the proofs starts at Stop, not at idle; the `run-recovery` doc comments sit on their own
  classes; the round 3 and 4 reports are in `docs/research/cutover-2026-10-26/`.

**Round 5** was a fifth read, of `f54460f..dd3c615` (`docs/research/cutover-2026-10-26/review-round-5.md`), beside the
round 4 run. It found R4-2's main path, R4-3/R4-4, the L2 call sites, the Stop fallback and the N8 window correct, no tmux
regression, no high finding, and one medium one: the R4-1 replacement never fired in the running service, because the
service drops an instance that never connected after every failed open and the run lived on the instance, and a hang that
starts on a live connection never reached the handshake check. Fixed on this branch:

- R5-1 and R5-2. The unresponsive run and the request-id counter live on the plugin (one per Console, keyed by runtime
  dir) and are handed to every instance; three consecutive request timeouts on a live connection, or one past the limit,
  close that connection without ending the process so the next use runs the bounded check; a late reply counts as an
  answer. A silent session host on an ordinary open counts toward the same run and is retired past the limit. Proven by
  tests that go through the real service, plugin, session host and scripted app-server
  (`test/structured-session-codex-hang.test.ts`).
- R5-3. The command ownership record survives an unload and idle sleep (Codex keeps the thread and its terminals for about
  30 minutes); it is dropped on release, on `thread/closed` (handled by the instance, since the session is gone by then)
  and on a process reset.
- R5-4. The 60 s working expiry re-arms while a re-adopted turn is still unnamed, so an unidentified period that ends
  without the turn's terminal clears working within a minute.
- R5-5. Claude has the same 5-minute bound for a hung CLI (`CLAUDE_UNRESPONSIVE_LIMIT_MS`, per conversation, on the plugin):
  handshake timeouts and silent hosts on ordinary resumes count toward one run; past the limit the process and its host
  are ended (`PluginContext.endHost`, a new optional seam the manager fills with the host terminate call) and the chat is
  relaunched with `--resume` in the same call. The contract text on `TransportBusyError` states the whole rule once.
- R5-6. The proofs poll "command gone" from the moment Stop is sent, in parallel with the idle wait, so a slow idle cannot
  fail the 5 s rule on a correct system.
- R5-7. The doc contradictions listed in the report are corrected, the round 4 list is out of the open follow-ups, and the
  second probe is recorded in `background-terminals-probe.md`.

Open follow-ups after rounds 3 to 5:

- An ordinary open with no recorded process (Codex: no app-server record; Claude: no launch record) makes a plain connect, so
  a silent host in that state fails as a plain error instead of busy, with no bound; a failed plain connect writes no record.
- A dropped live Codex connection (three request timeouts in a row) gives every loaded Codex row a connection-loss line;
  their turns keep running and are picked up on the next load. In the short window while that socket closes, a new open
  on the same instance reconnects while the service is dropping the instance, so one conversation can see a failed open.
- The line transport has no "retire a silent host" request; the Codex plugin ends such a host through the host record
  itself. A `retireUnresponsive` option on `LineTransportRequest` would be the cleaner shape.
- The command ownership record cannot cover a terminal started while no backend listened by a turn that ended before the
  next backend attached, nor the first deploy of this build (no records yet); such a terminal is treated as the adopted
  turn's and Stop after a restart ends it.

- In the unknown-turn background path, a Stop that arrives before the background listing returns finds no commands.
- The exactly-once turn-end counters in the proofs read the provider's records; a Console that handled one turn end twice
  (two completion lines, a second recency move) would still pass them.
- A message whose not-sent refusals alternate with "waiting for the session" deferrals never reaches the ten-minute cap; it
  waits, and nothing is sent twice (round 4, L3 residual, by design).
- After Stop or the 10-minute settle, the next screen poll restores the row and can meet the same silent host, so the person
  may see an error row ("did not answer in time; try again in a moment") until the reconcile pass adopts the process again.

- Codex message-mode cards (async questions) are not shown again after a backend restart; the question text stays in the
  conversation and a typed answer reaches the model.
- `run-recovery` tests do not cover the recovery-path status line for a rejected prompt (the service and wake paths are
  tested).
- From earlier rounds: Claude `ExitPlanMode` under bypass, `priority: "now"` during tools, and `--system-prompt-snapshot off` on a
  resume; the real CLI's background-task snapshot behind a repeated `initialize` and the shape of `pending_permission_requests`
  entries; a backend crash with a running turn (every proof restarts the backend gracefully); and the migration's tmux check,
  which looks only at whether the tmux session died, so for Codex a TUI that ignores SIGHUP would not be caught (the Claude resume
  has its own holder check).

## Work breakdown

| Lane | Scope |
|---|---|
| C0 | Session host relay plus Codex plugin reconnect through it; backend boot reconnect; meta and liveness |
| C1 | Claude plugin (CLI stream-json), fake `claude`, port of T3 behaviors, tests |
| C2 | Host per-session support, Claude seams (sleep, pressure, profile restart, liveness), granted launch transport, default transport, migration. Built; see "Per-session host support, default transport and migration (lane C2)" |
| C3 | Question card and answer route, images, web changes, push for pending questions |
| C4 | Proof scripts, docs, Opus review rounds and fix loops, live deploy of Phase A behind the flag, then the flip |
| Phase B | tmux retirement after the agreed real-use window |

C0 and C1 run in parallel; C2 after C0; C3 in parallel with C2; C4 last. Each lane has exclusive file
ownership as in the Codex lane.

State: C0 to C3 are built. C4 has the proofs, the docs and review rounds 1 to 3 done, with the round 3 fixes in; the items
still open are listed under "Review and fixes". The live deploy and the flip are Bryan's steps, and Phase B waits for the
real-use window.
