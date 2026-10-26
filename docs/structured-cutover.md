# Structured cutover: Claude plugin, parity and tmux retirement

Date: 2026-10-26. Branch: `feature/structured-claude-cutover`, stacked on `feature/structured-provider-lane`
(the Codex app-server lane, see `docs/structured-providers.md`). Status: plan for Bryan's approval. Nothing
in this document changes the running Console until the cutover steps below are executed.

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

## Prerequisite

`main` moved to `c094656` ("Clear delayed Claude prompt restoration after Stop", a SessionManager change)
after the Codex lane was branched from `af009e3`. Both lane branches are rebased onto the new `main` before
implementation starts, and the full suite plus the Codex proof rerun on the rebased result.

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
`--continue`, only `--resume <id>` reaches them, so the `continueCommand` fallback goes away.

Environment per process: `AGENT_CONSOLE_SESSION_ID`, `AGENT_COORD_RUNTIME`, `AGENT_CONSOLE_CONFIG`, with
inherited `CLAUDECODE`, `CLAUDE_CODE_*`, `TMUX` and `AGENT_CONSOLE_*` scrubbed first. Hooks run in headless
exactly as in the TUI and inherit that environment, so the installed coordination hooks register unchanged;
`SessionStart` fires at process start, `StopFailure` (not `Stop`) after an API-error turn, `SessionEnd` on
exit. Headless shows no workspace-trust dialog.

Wire protocol:

- Input: `{"type":"user","session_id":"","message":{"role":"user","content":[image blocks..., {"type":"text","text":...}]},
  "parent_tool_use_id":null,"uuid":<fresh uuid>,"origin":{"kind":"human"}}`. The human origin stamp is
  required: without it the transcript records the turn as SDK-originated and Console's mid-turn parser does
  not show it. A second message while a turn runs is queued and folds into the running turn at the next
  tool boundary (steer; fold to prove); `"priority":"now"` preempts the turn at once and moves running
  shell commands and subagents to the background. Resending a uuid already in the transcript runs nothing
  and answers only a `completed` lifecycle frame, which the host treats as already handled (idempotent
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
  fill without a model call. The CLI sends `can_use_tool` for `AskUserQuestion`, explicit ask rules and the
  cross-session messaging safeguards even under bypass, and `elicitation` for MCP forms; every one must be
  answered or the turn waits forever. Plan mode keeps its blocks headless; whether `ExitPlanMode` reaches
  `can_use_tool` under bypass is to prove.
- Exit: end of input while idle exits 0 in about 150 ms (1 if the last result was an error); end of input
  mid-turn lets the turn finish, writes its `result`, runs `Stop`/`StopFailure` and `SessionEnd` hooks, then
  exits; SIGTERM exits 143 with no `result`, and a prompt that had not reached the model is not in the
  transcript, so Console's journal stays the record of sent text.
- Mapping to `TransportEvent`: `session.native` from `--session-id` (transcript path from the hook's
  `transcript_path` or the escaped cwd); `turn.started` from `command_lifecycle started` with our uuid
  (`origin: 'provider'` for a turn with no uuid of ours, such as a background-task wake); `item.completed`
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
  `--resume`. A session whose first prompt never reached the model has no transcript; resume it with
  `--session-id` again, not `--resume`.
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
  `--system-prompt-snapshot off` on that launch (to prove).

Host changes for `per-session` plugins in `StructuredSessionService`: one instance object per provider
that spawns a process per session (through the relay); idle sleep and pressure suspension end the process
(end of input, then group SIGTERM, then SIGKILL) and set the marker; restore resumes by native id; model
profile change applies live; `providerAlive` is "relay reports the child alive"; coordination liveness uses
the child pid as the tmux path does today; granted launches pass `transport`. Built in lane C2: see "Per-session
host support, default transport and migration (lane C2)" below.

## Session host relay

Built in lane C0: `apps/server/src/providers/transport/session-host.ts` (the host program),
`line-transport.ts` (the channels and the factory) and the Codex plugin on top of them. One host holds one
provider child: a single host (`hostId: 'codex'`) for the shared Codex app-server; the Claude plugin will use
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
  ends the child and is reported in `exit.error`.
- **Backend side** (`createLineTransportFactory({ runtimeDir, log, hostProgramPath })`, handed to plugins as
  `PluginContext.lineTransport`; `app.ts` creates it, tests that inject their own plugins get none). With a
  `hostId`: read the record; if the recorded host is alive and its `argvHash` matches, connect (a reconnect: the
  child keeps running and the next client takes over); a changed command, an unanswering host or a host whose
  child had ended is ended first (over the socket, else by gated signals), a child left running without its host
  is ended through its recorded group, and a new host is started. Without a `hostId` the child is run directly over
  stdio (`StdioLineTransport`: newline framing with the 128 MiB cap, `\r` stripped, 64 KiB stderr tail, close = stdin
  EOF, 5 s, group SIGTERM, 5 s, group SIGKILL). A plugin that finds no factory uses stdio too.
- **What survives.** The provider process, its loaded threads and its connection state. What does not: anything
  that was only in the backend. A backend that connects after a restart asks for live output only and re-resumes
  its threads through the provider (`thread/resume` for Codex), so output produced while no backend was connected
  is read from the provider's own record (the rollout), not from the relay. Replay is for a client that keeps a
  cursor (`HostLineTransport.lastSeq`, passed back as `sinceSeq`) and wants the lines it missed; the Claude plugin
  is the intended user.
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
  first request; unproven against the real CLI, see "Open items"). A shared process still never gets a conversation's identity.
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
- `GET /api/projects/tree` advertises each provider whose lane is enabled and has a registered plugin;
  the sidebar offers "Codex (app-server)" and "Claude (headless)" per advertised provider. `app.ts` registers
  `createClaudePlugin()` beside the Codex plugin.

**Migration of live tmux bindings** (decision 4)

`reconcileSessions` (first pass 5 s after start, then every 30 s) runs this for every restorable tmux row whose provider
has its lane on while `defaultTransport` is `structured`. It runs under the row's command lock, one row at a time,
and a failure on one row is logged and never stops the pass.

1. Classify the row. It moves only when `status` is `bound`, the conversation ref is a native id (not `pending:`), the row
   is not working, has no queued input, no model change in flight, and (Claude) its transcript file is indexed and
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

Working rows, rows with queued input or a model change, `pending:` rows and Claude rows with no transcript stay on
tmux and are retried on later passes (a missing transcript is logged once per row). Rows move one way: lowering
`defaultTransport` later does not move them back (release and rebind with an explicit `tmux` to do that).

`SessionManager.structuredMigrationReport()` is the dry run: for every restorable tmux row it returns the outcome the
next pass would reach, with counts. It reads the database and asks tmux whether each session exists; it kills, moves
and captures nothing. Outcomes: `dead` and `idle` move; `working`, `queuedInput`, `modelRequest`, `pending`,
`noTranscript`, `notBound`, `unverified`, `externalOwner` and `providerOff` wait. It is served at
`GET /api/sessions/structured-migration` (authenticated, no CSRF token, read-only) with `defaultTransport`, the
providers whose lane is on, `structuredRows` (rows already moved) and one entry per row.

**Flip procedure**

1. Deploy the Phase A build with the defaults off. An absent `structuredSessions` block means both lanes off and tmux
   the default, so nothing changes. Do not write the new keys into the live `config.json` before this build is the one
   running (Zod strips unknown keys when settings are saved).
2. Edit the live `config.json`: `structuredSessions.codex.enabled: true`, `structuredSessions.claude.enabled: true`,
   `structuredSessions.defaultTransport: "structured"`. Restart `agent-console.service` (configuration is read at start).
   Provider processes behind session hosts survive the restart.
3. Read `GET /api/sessions/structured-migration` before the first pass (it runs 5 s after start) or just after: the
   counts say how many rows move now (`dead`, `idle`) and what blocks the rest.
4. The migration runs inside reconcile. Watch the report fall to the rows that cannot move; each moved row shows the
   status line above. Working rows move when they go idle.
5. Rollback: set `defaultTransport` back to `tmux` and restart. New conversations return to tmux; rows already moved
   keep working on the structured transport, because the transport is stored on the row.

**Open items found while building C2**

- `--system-prompt-snapshot off` on a resume with authority text is unproven against the real CLI.

**Built in lane C5 (fixes for the C2 open items)**

- **Survivors after a backend restart.** The first `reconcileSessions` pass calls `reattachSurvivors` for every awake
  (bound, not suspended) row of a per-session plugin. The optional `TransportInstance.reattach(nativeSessionId, options)`
  returns the conversation's own process when one outlived the restart behind its host, and undefined when there is none;
  it never starts a process. The Claude plugin connects with the new `attachOnly` request flag (live host, exact recorded
  command line, nothing started or ended), requires the recorded launch to name this native id, refuses a session another
  live process holds in the CLI registry, and repeats `initialize`. A survivor is then loaded like any other (new epoch,
  "Reconnected to the running agent process"), so idle sleep, pressure suspension and release can end it. A row with no
  survivor stays unloaded and resumes on its next use. Unverified against the real CLI: that a repeated `initialize` on a
  running process behaves as the SDK types describe (answer with the open requests and a background-task snapshot), and
  that the process id in the CLI registry file equals the host's child pid (the one-writer check ignores only that pid).
- **Profile-less Claude rows.** A per-session Claude row with no cost profile and no model of its own from a granted
  launch runs on `medium` for the resume and every turn, and the service has the manager store it on the row.
- **Background work.** `TransportSession.hasBackgroundWork()` (the Claude session derives it from
  `system/background_tasks_changed`, `task_started`, `task_notification` and terminal `task_updated` frames) blocks idle
  sleep, pressure suspension and manual suspend with the reason `background_work`, like the tmux screen check. The flag
  is ignored after four hours without any event from the transport.

## Parity features

- **Question and approval card.** New `request.opened` events become a card in the conversation pane with
  the question text, options and a free-text answer; `POST /api/sessions/:id/requests/:requestId` answers
  it (Codex `item/tool/requestUserInput` answers, Claude `can_use_tool` for `AskUserQuestion` and
  `ExitPlanMode`); unanswered requests block the turn, so the card is also pushed through the existing
  grant push channel. Elicitations from MCP servers stay declined.
- **Images.** The existing attachment flow (image store) feeds Codex `localImage` items and Claude base64
  image blocks; the route stops refusing images for structured rows.
- **Granted launches** follow the default transport (built in C2): a bind that names no transport takes
  `structuredSessions.defaultTransport` for providers whose lane is on, so helpers launch structurally after the flip.
- **Default transport** config: `structuredSessions.defaultTransport: 'tmux' | 'structured'` plus the
  per-provider `enabled` flags; `/new/bind`, history binds and granted launches use the default when the body does not
  say (built in C2). The flip is a config change on the live server after the Phase A build is deployed.
- **Migration** (built in C2): runs inside `reconcileSessions` while the default is structured, not as a one-off command;
  converts tmux rows as described in decision 4, retries rows that were working on later passes, and
  `GET /api/sessions/structured-migration` reports what is left and why.

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

- Unit: the Claude plugin against a scripted fake `claude` (`structured-claude-plugin`), the relay and its factory
  (`structured-session-host`), per-session paths, questions, images, survivors, the default transport and the
  migration with the fake plugin (`structured-session-*`), Codex questions and images (`structured-codex-requests`). The
  commands and what each file covers are in `docs/agent_docs/running_tests.md`.
- Real proofs. Each is opt-in (`--run`, after `npm run build`), runs one isolated backend (temp database and runtime,
  scratch git project, private tmux socket, free port) that never touches the live Console, uses the host's Claude and Codex
  logins with short fixed prompts, and ends with no `claude`, `codex app-server`, session host or `agent-coord.mjs mcp` of its
  own left running and its temp root removed. They share `scripts/structured-proof-kit.mjs`; the Codex proof keeps its own copy of
  the helpers.
  - `scripts/prove-structured-claude.mjs` (12 steps): bind, first reply with transcript and human turn origin, coordination
    hook and MCP call, steer, Stop, an `AskUserQuestion` answered through the card route, an image turn, a live model and
    effort switch, manual sleep and restore, a graceful backend restart with the process alive, release.
  - `scripts/prove-structured-migration.mjs` (8 steps): one real tmux Codex chat and one real tmux Claude chat are moved by
    the reconcile pass after `defaultTransport` flips to `structured`, then answer on the structured path in the same native
    conversation.
  - `scripts/prove-structured-codex.mjs` (14 steps): the earlier 12 steps plus a question step and an image step.
- Full suites and typecheck; the three known timing failures on this host stay the baseline.

Decision log. The plan said the migration proof would run on a copy of the live database. It runs on fresh chats created in the
isolated backend instead. A copy of the live database names the live tmux sessions, transcripts, runtime and 38 real
conversations, so a mistake would kill or write to real work; fresh chats exercise the same code (`classify`, kill, confirm,
`setTransport`, resume) with nothing to lose. The cost is that a real-world row shape the proof does not create (a history-bound
Claude row without a profile, a working row, a row whose tmux session already died) is covered only by the unit tests and the
dry-run route.

## Verification evidence

Real-provider proofs, 2026-10-26, `claude` 2.1.310, `codex-cli` 0.164.0, built from `daa80d7` with a clean source tree.
Evidence JSON is copied to `docs/research/cutover-2026-10-26/` (steps, key values, findings, cleanup; no message bodies,
tokens or addresses). Each run also writes an untracked copy under `test-results/`.

**Claude proof**: `claude-proof-2026-10-26T17-18-56Z.json`, 12 of 12 passed in 77 s, no cleanup problems. Two earlier runs
failed on defects of the script itself (it filtered request records by the TUI's label, and it read the effort of the wrong turn);
a third passed 12 of 12 before lane C5's boot-time reattach landed, when step k recorded a finding instead of asserting it. No
run showed a defect in the product.

| Step | Result and key values |
|---|---|
| a. tree | `structuredProviders: ['claude']` |
| b. bind | `transport: structured`; `conversation_ref` is the session UUID the Console minted; sentinel name `structured:<id>`; no raw log; the per-session host record `claude-<id>.json` names the `claude` pid, its own process group and start times that match `/proc`, and the process is the host's child with a parent death signal; the process environment holds the isolated `AGENT_COORD_RUNTIME` and `AGENT_CONSOLE_CONFIG`, its own `AGENT_CONSOLE_SESSION_ID`, no `TMUX`, and `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`; the argv is stream-json without `-p`; one coordination MCP server child, with the isolated runtime |
| c. first message | profile switched to `low` before the turn with the same pid; queue record `submitted`, `deliveryMode: turn`; reply `PONG`, `lastResponseAt` set; transcript at `~/.claude/projects/<escaped cwd>/<id>.jsonl`, the prompt row has `turnOrigin: human`, `origin: {kind: human}`, `entrypoint: sdk-cli`, `promptSource: sdk`; the index points at it; the first request used `claude-sonnet-5` at effort `high` although the process was launched with `claude-opus-5-5` / `xhigh` |
| d. coordination | the SessionStart hook registered `native_session_id` = the Claude session id in the isolated runtime (the hook command is the live checkout's helper; the env redirects it); the agent called `mcp__agent_console_coordination__agent_coordination` (`status`), the call succeeded, reply `REGISTERED`; `last_seen_at` advanced; one `agent-coord.mjs mcp` process with the isolated runtime was seen |
| e. steer | message sent mid-turn: `deliveryMode: steer`, same `turnId`; reply `STEERED`; see finding 1 |
| f. Stop | idle 264 ms after Escape; same pid, still the host's child; the counting shell command gone 324 ms after Escape; transcript marker `[Request interrupted by user for tool use]` |
| g. question | `AskUserQuestion` became one pending request (`kind: question`, options Red/Blue, `multiSelect: false`, `allowCustom: true`) while the session read as working; the answer through `POST /api/sessions/:id/requests/:requestId` left the row, a second answer was refused (404), the tool result the model received held the answer, reply `blue` |
| h. image | a 64x64 solid green PNG through the image route and `/keys`: the user row holds one base64 `image` block; reply `Green` |
| i. model and effort | `medium` turn: request model `claude-opus-5-5`, effort `xhigh`; back to `low`: `claude-sonnet-5`, `high`; same pid and same command line; the timeline shows no `/model` rows |
| j. sleep and restore | the assignment was `waiting`, so the manual suspend was accepted (the proof checks the 409 refusal for an `active` assignment only when it applies); the process and its host exited, the screen route 404s while suspended; resume started a new process on `--resume <same id>` with the row's session identity in its environment and a new epoch; reply `RESTORED` |
| k. backend restart | the process and its host survived `app.close()`, the host record still matched `/proc`; the first reconcile pass (lane C5) adopted the process before any message (`reattachedAtBoot: true`, new epoch, screen `Claude (structured) idle`, same pid, one process under the host); reply `RESUMED` from the same pid; the CLI registry showed exactly one live holder of the session |
| l. release | row `ended`, `should_restore` 0, process and host gone, host record removed, no process with the proof's runtime or temp root, no `claude`, no `agent-coord.mjs mcp`; then backend shutdown with still nothing left |

**Migration proof**: `migration-proof-2026-10-26T17-26-34Z.json`, 8 of 8 passed in 37 s, no cleanup problems.

| Step | Result and key values |
|---|---|
| a. bind on tmux | two `transport: tmux` rows through `/new/bind`, real `ac-codex-…` and `ac-claude-…` sessions on the private socket |
| b. first replies | both answered `TMUX`, each row got a native id (Codex thread UUID, Claude session UUID) and an indexed transcript; the Codex first message relaunched Codex and bound a new Console session id (`restartPendingSessionWithInitialPrompt`), which the proof follows; 3 and 2 processes carried the session ids |
| c. flip | config rewritten to `defaultTransport: structured`, backend closed and rebuilt (both tmux sessions survived the backend); the dry run, 0.1 s after boot, listed `providers: [codex, claude]`, `structuredRows: 0`, `idle: 2` |
| d. reconcile | the first pass (about 6.7 s after boot) flipped both rows: `transport: structured`, `idle_suspended_at` set, `tmux_session_name` `structured:<id>`, `pid` and `raw_log_path` cleared, `conversation_ref` unchanged, `should_restore` 1; the report then showed `structuredRows: 2` and every outcome 0 |
| e. tmux gone | neither tmux session exists, the private tmux server is gone, none of the 5 processes of the tmux phase is alive, nothing carries the proof's runtime |
| f. Codex | `MIGRATED` on the structured path: app-server held by the `codex` session host, same thread id, the earlier `TMUX` reply still in the conversation, index unchanged, `idle_suspended_at` cleared |
| g. Claude | `MIGRATED`: a `claude` process on `--resume <same id>` with `--model claude-opus-5-5 --effort xhigh` (the row kept the profile it had on tmux), own session id in its environment, host record names its pid, the earlier `TMUX` reply still in the transcript |
| h. release | both rows `ended`; the Codex host ended with `terminateHost`, the Claude host with the release; nothing left |

**Codex proof**: `codex-proof-2026-10-26T17-30-16Z.json`, 14 of 14 passed in 119 s (the run where the model kept the question turn open). Steps a to l are as in
`docs/structured-providers.md`, "Verification evidence"; the new ones:

| Step | Result and key values |
|---|---|
| h2. question | `request_user_input_async` was called once (`{"accepted":true}`) and no pending request reached the Console; the model then polled with two `sleep` calls, the step stopped the turn after 60 s (finding 9). The step records that and passes; the card path for Codex stays covered by `structured-codex-requests` against the fake app-server |
| h3. image | a solid green PNG through the image route: the rollout holds an `<image …>` text item and an `input_image` item with the file's data URL; reply `Green` |

Targeted suites on `daa80d7`: `structured-session-host structured-claude-plugin structured-codex-requests structured-session-requests
structured-session-per-session structured-session-migration structured-session-default-transport structured-session-launches
structured-session-survivors` passed (274 tests, 3 skipped opt-in tests, 28 s with two workers).

**Findings from the real CLI and Codex** (what the research briefs left open or got wrong):

1. *Steer folds at the tool boundary and does not shorten a running command* (brief section 4, "fold is unverified"). A plain
   message sent while a turn runs is queued at once (`queue-operation enqueue`), then folded into the running turn after the
   current tool call returns and before the next model request: the transcript holds
   `attachment {type: queued_command, prompt: [{type: text}], source_uuid, delivery_id, origin: {kind: human}, humanTurn: true}`
   followed by `queue-operation remove`. There is one Stop hook for the whole exchange, so it is one turn. A 30 second shell
   command printed all 30 numbers before the fold; `STEERED` came 30 s after the steer. A person who wants a running command cut
   short must press Stop. The headless `queued_command` record has the fields the brief expected from the TUI (with the prompt as a list of content
   blocks).
2. *Interrupt during a tool* (brief section 5): idle in about 265 ms, the process survives (same pid), the foreground shell
   command is killed within about 325 ms, the Stop hook does not run. The transcript holds a tool result "The user doesn't want to
   proceed with this tool use. The tool use was rejected…" and a text row `[Request interrupted by user for tool use]` (the brief
   saw `[Request interrupted by user]` for an interrupt before the model call). `isNativeInterruption` accepts both.
3. *`AskUserQuestion` under bypass reaches the host* (brief sections 6 and 14): launched with `--dangerously-skip-permissions
   --permission-prompt-tool stdio` it arrives as `can_use_tool`, blocks the turn until answered, and the answer comes back as a
   tool result "Your questions have been answered: …". `ExitPlanMode` was not exercised and stays open.
4. *Hooks* (brief sections 7 and 14): `SessionStart` (at launch, before the first prompt), `UserPromptSubmit`, `PreToolUse`,
   `PostToolUse` and `Stop` all run in a headless process from the user's installed settings, including on a successful turn;
   `Stop` does not run for an interrupted turn. They register in the isolated runtime although their command is the live
   checkout's helper, because the plugin's per-process `AGENT_COORD_RUNTIME` and `AGENT_CONSOLE_CONFIG` redirect it.
5. *MCP name clash*: `~/.claude.json` defines a user-scope `agent_console_coordination` server that names the live runtime; the
   plugin's `--mcp-config` entry with the same name won. Exactly one coordination server ran, with the isolated runtime. If the
   CLI ever changed that precedence, a conversation would talk to the wrong Console, so the proof fails the MCP call before it is
   made when the server's runtime is not its own.
6. *Headless transcript shape*: `entrypoint: sdk-cli`, `promptSource: sdk`, `turnOrigin: human` (because `origin` is stamped),
   request records labelled `querySource: "sdk"` (the TUI uses `repl_main_thread`), `stop_hook_summary` rows and no
   `turn_duration` rows; the assistant rows carry `effort`. Console's parsers read none of these.
7. *Live model and effort switch works* (brief section 8): `set_model` and the effort follow the profile on the next request of
   the same process (`claude-sonnet-5`/`high`, `claude-opus-5-5`/`xhigh`), and each switch writes a `<command-name>/model`
   local-command row into the transcript. The parser already skips those rows; the proof checks that the timeline shows none.
8. *Images*: the base64 block reaches the model, and the CLI adds a `[Image: source: …]` meta row. The prompt text still carries
   the tmux envelope ("Inspect the attached local image files with Read"), so the model also opens the stored file: one redundant
   tool call, same answer. Stripping the envelope for structured sends would remove it.
9. *Codex questions outside plan mode*: on `codex-cli` 0.164.0 in the default collaboration mode the model's tool is
   `request_user_input_async`, which returns `{"accepted":true}` at once and raises no `item/tool/requestUserInput` server request.
   In one run the turn ended with the question as ordinary assistant text; in another the model kept the turn open with `sleep`
   calls waiting for an answer and wrote no text at all (two of four runs ended the turn and two kept it open; the step stops a
   turn that waits 60 s, and the last run took that branch). The question is then only in the tool call, so a person may not see it. A
   blocking question needs plan mode. Whether to render the async question in the timeline is a decision for Bryan.
10. *Reattach after a backend restart* (lane C5): the repeated `initialize` on a running process was accepted, the process kept
    its pid and its place in the CLI registry (exactly one live holder), and answered the next turn. This settles the two
    "unverified against the real CLI" points of lane C5.
11. *Timing on this host*: the first Claude turn (with the profile switch and the index lookup) took about 5 s; a manual
    sleep, the restore and a one-word turn together about 3.3 s. The Codex medium model (`gpt-6.1-sol`) was rate limited once during the migration proof (a turn waited minutes),
    then answered in about 5 s; the proofs use the low profile where a stall would hide a defect.
12. *Pending Codex first message on tmux* (not a defect of this work, but it shapes any caller): the first message of a new tmux
    Codex chat releases the session and binds a new Console session id. A caller must follow the `session.id` in the `/input`
    response; the migration proof does.

Not proven by any run: `ExitPlanMode` under bypass, `priority: "now"` during running tools, streamed deltas,
`--system-prompt-snapshot off` on a resume with authority text, TUI resume of a headless session and the reverse, a running
turn that spans a backend restart, a history-bound Claude row without a profile (C5 gives it `medium`; covered by unit tests),
and the idle-sleep timer itself (the proofs sleep manually).

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
