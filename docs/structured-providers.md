# Structured provider lane

Date: 2026-10-26. Branch: `feature/structured-provider-lane`. Status: slice 1 implemented; see
Verification evidence. The lane ships behind a config flag that defaults off. Nothing in this document
changes the running Console until the flag is turned on for a provider. The text below was corrected to the
implementation on 2026-10-26; where it still differs from the code, the code governs.

## Decision

Console keeps its coordination, wiki, grants, priorities, history and recency rules, and replaces the
way it drives a provider. Today a conversation is one hidden tmux session: Console pastes text into a
terminal, presses Enter, and infers everything from the screen. The structured lane drives a provider
through a protocol with explicit requests and events. Codex comes first, through `codex app-server`
(JSON-RPC). Claude (Agent SDK) and ACP agents (Mistral Vibe, Grok if it speaks ACP) come later through
the same plugin contract.

Settled with Bryan on 2026-10-26:

- One shared `codex app-server` process per provider instance serves many conversations as threads.
  The plugin contract also allows one process per conversation for providers that need it (ACP).
- Slice 1 is the full Codex loop behind a flag: new chat, resume, send, steer mid-turn, Stop, output in
  the normal conversation pane, working/idle/failed state feeding recency, recovery and peer-message
  delivery, model/effort profiles, hooks and MCP coordination, memory gate, idle sleep and restore.
- Real Codex app-server turns are allowed for verification from an isolated dev server.
- `design/extension-agent-lane` (tmux-based extension agents such as Grok) stays untouched for now.
  It is to be superseded by this lane once Claude and Grok run on structured plugins. That branch
  claims database schema version 19; this lane takes 19 on `main`, so that branch must move to 20 if
  it is ever revived.

Why this shape and not T3 Code: see the Codex evaluation of 2026-10-25. T3 is MIT and its adapters are
used here as reference and, where marked, as copied code with its license notice. Reference clone:
`/home/bryan/code/UberCoder/t3code-ref` (v0.1.2).

## Architecture

```
                 +---------------------------+
   web / routes  |  SessionManager (SM)      |  lifecycle owner for BOTH transports:
  ------------>  |  per-session lock, queue  |  journal, recency, realtime events,
                 |  journal, recency, wake,  |  reconciliation, RunRecovery, grants
                 |  recovery, idle sleep     |
                 +------+-------------+------+
                        |             |
             transport  |             |  transport
             'tmux'     |             |  'structured'
                        v             v
                 +-----------+  +---------------------------+
                 | tmux path |  | StructuredSessionService  |  sessions/structured/
                 | unchanged |  | start/resume/submit/steer |  maps plugin events to SM
                 +-----------+  | interrupt/release/sleep   |  callbacks and the event log
                                +------------+--------------+
                                             |
                                             v  TransportPlugin contract (providers/transport/types.ts)
                                +---------------------------+
                                | CodexAppServerPlugin      |  providers/transport/codex/
                                | one app-server child on   |  JSON-RPC over the child's stdio,
                                | stdio, N threads          |  spawned by the plugin
                                +---------------------------+
```

Rules:

1. `bound_sessions` stays the single binding table. A new column `transport` (`'tmux'` default,
   `'structured'`) tells every reader which path owns the row. One conversation is still one native
   session id; only the process owner changes.
2. SM stays the lifecycle owner. It dispatches by `session.transport` at the entry points listed below.
   The tmux code is not moved or refactored in slice 1; the structured branch is an early `if` that
   delegates to `StructuredSessionService`. A structured row must never reach a tmux call.
3. Plugins translate protocol to a small delta event stream. The host (StructuredSessionService) owns
   queueing, steer-versus-queue policy, exactly-once turn terminals, recency decisions, journal records
   and process pooling. The host never branches on plugin id; it reads capability flags.
4. Durable history keeps coming from the provider transcript (Codex rollout JSONL). App-server threads
   write the same rollout files as the TUI, so the Codex transcript parser, search, pending-adoption
   hashing and the rollout-based run monitor keep working. Live assistant streaming is not in slice 1;
   the Codex tmux path also shows assistant text only from the rollout file today.
5. Approvals: slice 1 starts threads with the app-server equivalent of
   `--dangerously-bypass-approvals-and-sandbox` (approval policy `never`, full-access sandbox), which
   is what the tmux path uses. Any server-to-client request that still arrives (approval, elicitation,
   user-input question) is declined and recorded as a `status` event. No approval UI in slice 1.
6. Identity for coordination is the native thread id, known at `thread/start`. The pending-adoption
   transcript matching is bypassed: the binding is written immediately with the thread id.

## Data model and config

### Schema version 19

- `bound_sessions.transport TEXT NOT NULL DEFAULT 'tmux'`.
- `tmux_session_name` stays NOT NULL. Structured rows store the sentinel `structured:<sessionId>`. tmux 3.4
  does not reject the colon (it rewrites it to `_` and creates a session), so tmux gives no protection. The
  tmux client does. `assertTmuxSessionName` in `sessions/tmux-client.ts` throws a `TmuxError` for any name
  that starts with `structured:`, before a tmux command runs, in every `ShellTmuxClient` method. The test
  fake (`FakeTmux`) applies the same check. The dispatch rule still holds: a structured row never reaches a
  tmux call, and the structured session tests check it by counting calls on the fake client. The guard turns
  a stray call into an error instead of a second provider process on the thread.
- `raw_log_path` is NULL for structured rows; `event_log_path` is set (the event log is shared).
- `pid` holds the app-server process id for structured rows (readers that use `pid` as "a live
  helper exists" keep working: worker roster, grant concurrency).
- `scripts/worktree-sweep.mjs` `SUPPORTED_SCHEMA_VERSIONS` gains 19 in the same change.
- Meta keys owned by the structured lane: `structured-instance:<provider>` =
  `{ pid, startTicks, bootId, processGroup, startedAt, version }` for the shared process. `pid` is the process
  `setpriv` execs into, which on an npm install is the `codex` Node launcher; the native app-server is its child.
  `startTicks` is the process start time (field 22 of `/proc/<pid>/stat`) and `bootId` is the kernel boot id; both
  are left out when `/proc` cannot be read. `processGroup` equals `pid` (the process leads its own process group,
  which holds the native child) and is left out in records written before the group start. `version` is left out
  when Codex reported none. The plugin deletes the key when the
  instance closes or the process exits. `structured-epoch:<sessionId>` = ISO time the thread was last loaded
  on the current connection (recency and run-epoch guard).

### Shared contracts (`packages/shared/src/index.ts`)

```ts
export const SESSION_TRANSPORTS = ['tmux', 'structured'] as const;
export type SessionTransport = (typeof SESSION_TRANSPORTS)[number];
// BoundSession gains:  transport: SessionTransport;
// TreeResponse gains:  structuredProviders?: ProviderId[];   // providers whose structured flag is on
// POST /new/bind body: { transport?: SessionTransport }       // default 'tmux'
```

### Config (`apps/server/src/config/schema.ts`)

```json
"structuredSessions": {
  "codex": {
    "enabled": false,
    "command": ["codex", "app-server"],
    "idleUnloadMinutes": 60,
    "env": {}
  }
}
```

`env` is extra environment for the provider process. The Console first sets `AGENT_COORD_RUNTIME` (its
runtime directory) and `AGENT_CONSOLE_CONFIG` (its config path) when coordination is enabled, mirroring what
the tmux path gets from `providers.codex.commands.env`; `env` overrides them. Hooks inside a thread read
`AGENT_COORD_RUNTIME` to find the Console. The coordination MCP entry in `~/.codex/config.toml` pins its own
`AGENT_COORD_RUNTIME` and helper path (the live Console's), so the plugin overrides the entry in the app-server
argv whenever coordination is enabled (see "Codex app-server plugin"); no configuration is needed, and an
isolated Console (the proof script) gets its own runtime this way.

- Absent block or `enabled: false` means the lane is off: no New Chat option, `/new/bind` with
  `transport: 'structured'` returns 400, and no app-server process is ever started.
- Zod strips unknown keys on settings save, so the key must not be written into the live
  `config.json` until the server that understands it is the one that stays. The example config carries
  it with `enabled: false`.
- The transport is chosen at bind time and persisted on the row. Turning the flag off later does not
  change existing structured rows; they keep working until released.

## Plugin contract (`apps/server/src/providers/transport/types.ts`)

Three levels, as in T3: plugin (static) to instance (one binary and home, shared process if
`processModel: 'shared'`) to session (one native conversation).

```ts
export interface TransportCapabilities {
  processModel: 'shared' | 'per-session';
  nativeIds: 'server-allocated' | 'client-allocated';
  resume: 'reattach' | 'replay' | 'none';
  steer: 'native' | 'native-cancels-tools' | 'none';
  interrupt: 'terminal-follows' | 'ends-process';
  images: boolean;
  enforcement: 'native' | 'host';
  modelSwitch: 'next-turn' | 'restart' | 'none';
}

export interface ProviderFailure {
  class: 'usage_limit' | 'provider_error' | 'transport_error' | 'permission_error' | 'validation_error' | 'unknown';
  code?: string;          // provider code, e.g. codex 'serverOverloaded'
  message: string;        // redacted by the plugin before emit
  retryable?: boolean;
  resetAt?: string;
}

export type TransportEvent =
  | { type: 'session.state'; state: 'starting' | 'ready' | 'running' | 'stopped' | 'error'; failure?: ProviderFailure }
  | { type: 'session.native'; nativeSessionId: string; transcriptPath?: string; title?: string }
  | { type: 'turn.started'; turnId: string; origin: 'user' | 'provider'; replay: boolean }
  | { type: 'item.completed'; turnId: string; itemId: string; kind: 'assistant' | 'reasoning' | 'command' | 'file_change' | 'mcp' | 'search' | 'other'; replay: boolean; title?: string }
  | { type: 'request.opened'; requestId: string; kind: 'command' | 'file_change' | 'permission' | 'mcp' | 'question'; summary: string }
  | { type: 'request.closed'; requestId: string; outcome: 'resolved' | 'declined' | 'cancelled' }
  | { type: 'usage.updated'; contextUsedTokens?: number; contextMaxTokens?: number; windows?: Array<{ id: string; usedPercent: number; resetsAt?: string }> }
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
  | { type: 'turn.terminal'; turnId: string; status: 'completed' | 'interrupted' | 'failed'; failure?: ProviderFailure; sessionUsable: boolean; replay: boolean };

export interface TurnInput { text: string; images?: Array<{ path: string; mimeType: string }>; model?: string; effort?: string; clientMessageId?: string }

export interface TransportSession {
  readonly nativeSessionId: string;
  readonly capabilities: TransportCapabilities;
  readonly events: AsyncIterable<TransportEvent>;          // single consumer; ends after session.state 'stopped'
  readonly transcriptPath?: string;                         // when the provider reports it
  sendTurn(input: TurnInput): Promise<{ turnId: string }>;  // rejects with PreviousTurnActiveError while a turn runs, NotSentError when nothing was written
  steer?(turnId: string, input: TurnInput): Promise<void>;  // only when capabilities.steer !== 'none'; rejects with TurnNotActiveError when the turn already ended
  interrupt(turnId: string): Promise<void>;                 // resolves when the request is accepted; terminal follows as an event
  respond(requestId: string, decision: 'decline' | 'cancel'): Promise<void>;
  unload(): Promise<void>;                                  // shared process: drop the thread from memory; per-session: no-op
  close(reason: 'release' | 'shutdown' | 'error'): Promise<void>;
}

export interface OpenOptions {
  conversationId: string;                                   // Console bound-session id
  cwd: string;
  model?: string; effort?: string;
  policy: { approvals: 'never' | 'on-request'; sandbox: 'full-access' | 'workspace-write' | 'read-only' };
  env?: Record<string, string>;
}

export interface TransportInstance {
  readonly plugin: string;
  readonly capabilities: TransportCapabilities;
  probe(): Promise<{ installed: boolean; version?: string; auth: 'ok' | 'missing' | 'unknown'; models: Array<{ id: string; label: string; efforts?: string[] }> }>;
  start(options: OpenOptions): Promise<TransportSession>;
  resume(nativeSessionId: string, options: OpenOptions): Promise<TransportSession>; // throws ResumeFailedError
  alive(): Promise<{ pid?: number; connected: boolean }>;
  dispose(reason: 'shutdown' | 'restart'): Promise<void>;   // shared: disconnect; never kills a process that other Consoles own
}

export interface TransportPlugin<Config = unknown> {
  readonly id: ProviderId | string;
  create(config: Config, context: PluginContext): TransportInstance;
}

export interface PluginContext {
  runtimeDir: string; // <runtimeDir>/structured/<plugin>/
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  meta: { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void };
}
```

The context has no spawn helper. A plugin starts its own provider process (the Codex plugin does, see
below), and the host does not start or scope it.

Contract errors (`types.ts`):

- `PreviousTurnActiveError` (`previous_turn_active`): `sendTurn` while a turn runs.
- `NotSentError` (`not_sent`): the request certainly never reached the provider. The session had ended, or
  the connection was gone, before anything was written. The caller may queue the request and try again. A
  failure after the write is not this error: its outcome is uncertain and the request is never replayed.
- `TurnNotActiveError` (`turn_not_active`): `steer` named a turn that already ended. The host sends the text
  as a new turn for this error only.
- `ResumeFailedError` (`resume_failed`) and `TransportUnavailableError` (`transport_unavailable`).

`TurnAlreadyCompletedError` no longer exists; `TurnNotActiveError` replaced it.

Event rules:

- `replay: true` marks events reconstructed from `thread/resume` or reconnect backfill. The host never
  lets replay events touch `lastActivityAt`, `lastOutputAt` or `lastResponseAt` (AGENTS.md recency
  rule) and never journals them.
- `turn.terminal` fires exactly once per turn. If the connection drops, the plugin emits
  `session.state: 'error'` and the host decides (RunRecovery `process_exited`).
- `session.state` and `notice` never count as activity.
- Message bodies are not part of the event stream in slice 1. Assistant text arrives through the rollout
  transcript and `session.transcript-updated`.

Fake for tests: `apps/server/test/helpers/structured-fixtures.ts` provides `FakeTransportPlugin` whose
sessions record calls (`sendTurn`, `steer`, `interrupt`, `unload`, `close`) and let tests push events.
It is injected through `SessionManagerOptions.transportPlugins`.

## Codex app-server plugin (`apps/server/src/providers/transport/codex/`)

Verified on this host (2026-10-26, `codex-cli 0.164.0`, live handshake and the generated bindings;
full detail with evidence in `docs/research/codex-app-server-2026-10-26/protocol-brief.md`, which is
the source of truth for field names):

- Transport: `codex app-server` child process over stdio, one JSON object per line, no `jsonrpc`
  field. Requests carry `id` (client counter from 1); server-to-client requests carry their own `id`
  counter from 0 and `method`; notifications carry `method`, `params` and `emittedAtMs`. Route by
  shape. stderr is coloured tracing output: keep a tail, never parse it. Closing stdin ends the process
  with exit 0.
- Handshake: start the reader first, send `initialize { clientInfo: { name: 'agent_console', title:
  'Agent Console', version }, capabilities: { experimentalApi: true, optOutNotificationMethods:
  ['turn/diff/updated'] } }`, then the `initialized` notification. Notifications can arrive between the
  `initialize` response and `initialized`. "Already initialized" counts as success.
- `--listen unix://PATH` exists (WebSocket over a Unix socket) and would let the process outlive a
  Console backend restart. Slice 1 uses stdio, which is the documented and T3-proven path; a backend
  restart therefore ends running structured turns, which RunRecovery reports as `process_exited`. The
  socket mode is a follow-up and the plugin's connection layer is written so it can be added without
  touching the protocol code. Console never uses the per-user daemon (`codex app-server daemon`).
- Process lifetime: the service runs with `KillMode=process` (tmux must survive a restart), so a crashed
  backend would leave its app-server running, possibly in the middle of a turn. The restarted backend would
  then start a second writer on the same thread. Three things prevent this. First, the plugin starts the child
  through `setpriv --pdeathsig TERM --` (`transport/codex/process-lifetime.ts`, `withParentDeathSignal`), so
  the kernel sends SIGTERM to the app-server when the backend dies. `setpriv` execs the command, so the
  recorded pid is the process `setpriv` became. On an npm install of Codex that is the `codex` Node launcher,
  not the native app-server: the launcher runs the native binary as its child and only forwards SIGINT, SIGTERM
  and SIGHUP to it. The pdeathsig therefore reaches the native server only through that forwarding. The plugin
  looks for `setpriv` on `PATH` at its first spawn. If it is missing, the plugin logs one warning and spawns the
  command directly. It also spawns directly when the configured binary cannot be found, so a missing `codex`
  fails in the usual way. Second, the child starts as the leader of its own process group (`detached: true`,
  stdio pipes kept; pdeathsig is unaffected). `JsonRpcClient.close()` sends its SIGTERM and SIGKILL to the whole
  group (`process.kill(-pid, signal)`), so a native child that ignores the forwarded SIGTERM dies with its
  launcher. The group is signalled only while the launcher has not been reaped, and if the group signal fails
  the pid alone is signalled. Third, before the first spawn of an instance, the plugin ends a recorded process
  that is still running. The pid, the start ticks and the boot id must all match the instance meta. It sends
  SIGTERM and then SIGKILL after `staleTermGraceMs` (5 s), to the group when the record names one (`processGroup`
  equals the pid and `/proc` shows the pid still leads that group) and to the pid alone otherwise. A record
  without start ticks, or a reused pid, is left alone, so no unrelated process or group is signalled. If the
  process does not end, the plugin logs a warning and starts the new one anyway. Known limit: when the
  launcher itself is already dead (for example killed with SIGKILL) while its native child still runs, the
  identity of the group cannot be checked and the reap leaves that orphan alone. The plugin spawns the child
  itself; there is no systemd scope.
- Instance = one app-server process per provider instance (CODEX_HOME), started with the configured
  `command`, then `-c check_for_update_on_startup=false`, then (when coordination is enabled) the coordination
  MCP overrides below, cwd fixed to the runtime directory. Its environment is the Console's own, plus the host
  and configured `env` above, minus `AGENT_CONSOLE_SESSION_ID` and `CODEX_THREAD_ID` (a shared process carries no
  session identity), with `CODEX_HOME` expanded. Meta `structured-instance:codex` records
  `{ pid, startTicks, bootId, processGroup, startedAt, version }` (see Schema version 19).
- Coordination MCP pinning: Codex starts `agent_console_coordination` from the `[mcp_servers]` table in
  `~/.codex/config.toml`, whose entry names one runtime and one checkout (the live Console's). A Console with
  another runtime (a worktree dev Console, the proof) would otherwise get hooks that register with itself and
  an `agent_coordination` tool that talks to the live Console. When coordination is enabled the host puts
  `coordination: { runtimeDir, helperPath }` on the `PluginContext` (the same runtime and `scripts/agent-coord.mjs`
  the tmux launch pins, taken from `SessionManager`) and the plugin appends
  `-c mcp_servers.agent_console_coordination.command="node"`, `.args=["<helperPath>","mcp"]` and
  `.env.AGENT_COORD_RUNTIME="<runtimeDir>"`. These make the entry complete on their own, so they also work when
  the global entry is missing. No `AGENT_CONSOLE_SESSION_ID` is pinned: the process serves every thread, and
  the coordination server identifies a thread by `_meta.threadId`. With coordination off the plugin adds nothing.
- Thread = Console conversation. `start` = `thread/start { cwd, model, approvalPolicy: 'never',
  sandbox: 'danger-full-access', approvalsReviewer: 'user', config: { mcp_optional_startup_grace_ms: 10000, model_reasoning_effort },
  ephemeral: false }`; the response carries `thread.id` (UUID, equals the rollout session id and the
  hook `session_id`) and `thread.path` (rollout JSONL, may be null until the first turn). `resume` =
  `thread/resume { threadId, excludeTurns: true, cwd, model, approvalPolicy, sandbox, config }`;
  an archived thread is unarchived and retried; history is not replayed (Console reads the rollout).
- `sendTurn` = `turn/start { threadId, input: [{ type: 'text', text }], clientUserMessageId,
  model, effort, summary: 'detailed', approvalPolicy: 'never', approvalsReviewer: 'user',
  sandboxPolicy: { type: 'dangerFullAccess' } }` (overrides persist, so the policy is re-sent every
  turn). A response with `turn.startedAt === null` is a queued turn: wait for `turn/started` before an
  interrupt. If the response names a turn this session already finalized locally and reports it still
  `inProgress`, Codex still runs it, so the plugin tracks it as active again; otherwise its real
  `turn/completed` would be dropped. `sendTurn` throws `NotSentError` when the session has ended or the
  app-server is not connected before anything is written. A failure after the write is a
  `TransportUnavailableError` and counts as uncertain. `steer` = `turn/steer { threadId, expectedTurnId,
  input }`. `steer` throws `NotSentError`, like `sendTurn`, when the session has ended or the connection is gone
  before the frame is written; the host then queues the text for human input like any other not-sent message.
  The plugin throws `TurnNotActiveError` when the turn already ended locally, or when the server
  answers that it has no matching active turn. The host then sends the text as a new turn. Any other steer
  failure, such as a refusal or a timeout, is rethrown and never sent again. `interrupt` = `turn/interrupt
  { threadId, turnId }`. When the server refuses it because it holds no such running turn ("no active turn",
  "expected active turn id", `thread not found`, `thread not loaded`) while the plugin still tracks the turn,
  no `turn/completed` can follow: the plugin ends the turn locally as `interrupted` with a warning notice, once
  (the terminal is emitted from one place that checks the record), and Stop returns normally. Any other
  refusal leaves the turn running and is surfaced to the caller. It terminates the tracked background commands
  (`thread/backgroundTerminals/terminate`, experimental) whichever of `turn/completed` and the interrupt
  response arrives first, because a command the turn started never ends on its own. Then it waits up to 10 s for
  `turn/completed`, else finalizes locally as `interrupted`. `unload` = `thread/unsubscribe`. `thread/closed`
  (the server unloaded the thread) finalizes a running turn as `failed` with the retryable code
  `thread_closed` and ends the session locally.
- Notifications map to `TransportEvent`: `turn/started` to `turn.started` (events for a turn can
  arrive before the `turn/start` response, so buffer by `turnId`); `item/completed` to
  `item.completed` (authoritative item state; `turn/completed.turn.items` is only a summary; `userMessage`
  and `hookPrompt` items, the echo of the user's own text, are not forwarded, so they never count as output);
  `turn/completed` to `turn.terminal` (authoritative end; `thread/status/changed: idle` can arrive
  first). `error { willRetry: true }` becomes a `notice`; `willRetry: false` precedes a failed
  terminal. `codexErrorInfo` is camelCase on the wire: `serverOverloaded` and `internalServerError`
  map to `provider_error` with code `server_overloaded` / `server_unavailable` (what RunRecovery
  retries); `usageLimitExceeded`, `rateLimitExceeded` and `responseTooManyFailedAttempts` with
  HTTP 429 map to `usage_limit` with `resetAt` from the rate-limit snapshot; `unauthorized`,
  `cyberPolicy`, `misalignmentPolicyViolation`, `tooManyDenials` map to `permission_error`;
  `contextWindowExceeded`, `badRequest` to `validation_error`; `http*`/`responseStream*` to
  `transport_error`. `thread/tokenUsage/updated` (`last.totalTokens / modelContextWindow` is the
  context fill) and `account/rateLimits/updated` (partial merge by `limitId === 'codex'`) map to
  `usage.updated`. Subagent child threads stream on the same connection: demultiplex by `threadId`
  and never merge a child's events into the parent conversation.
- Server-to-client requests must always be answered or the turn blocks forever. Under `never`,
  command/file/permission approvals are not sent. `item/tool/requestUserInput` is answered with empty
  answers and recorded as a `status` event; `mcpServer/elicitation/request` is answered
  `{ action: 'decline', content: null, _meta: null }`; anything else gets a JSON-RPC `-32601` error.
- Connection loss: when the process ends on its own, every open session gets `session.state: 'error'` with
  the code `process_exited` and a message that names only how it ended (`exit code 1`, `signal SIGKILL`).
  The host writes the conversation status line "The provider connection ended (exit code 1). The session
  reconnects on next use." The redacted stderr tail goes to the server log only, never into the conversation.
  The same holds for a process that ends while starting: `JsonRpcExitError` and the start error name only how
  it ended ("The process ended (exit code 1)."), and the tail is logged. The bind and restore failure lines
  ("Failed to bind session: ...", "Failed to restore session: ...") carry the first line of the reason, at most
  200 characters (`structuredStatusReason`); the full error stays in the server log.
- Reused from T3 (MIT; copied files carry the T3 copyright and license header and the repo gains
  `THIRD_PARTY_NOTICES.md`): the pure error-classification helpers (`parseCodexRetryProgress`,
  `codexErrorInfoCode`, `codexExhaustionHttpStatus`, `codexUsageLimitError`), protocol redaction
  (`redactCodexProtocolValue`, `isSensitiveCodexProtocolKey`), usage-limit window parsing and
  partial-merge (`codexUsageLimits.ts`), per-turn token usage (`CodexTurnTokenUsage.ts`), and nine
  recorded wire transcripts (`testkit/fixtures/<scenario>/codex_transcript.ndjson`: `simple`,
  `multi_turn`, `message_steering`, `queued_turn`, `turn_interrupt`, `turn_interrupt_mid_tool`,
  `provider_thread_resume`, `command_output_streaming`, `plan_questions`) as replay test data. The
  JSON-RPC client, turn bookkeeping and interrupt/steer handling are ported to plain TypeScript from
  the patterns in `CodexAdapterV2.ts` and `packages/effect-codex-app-server/`.

Hooks and MCP: `~/.codex/hooks.json` and `~/.codex/config.toml` `mcp_servers` are loaded by codex core,
which is the same under app-server (`hooks/list` on this host shows the coordination hooks as trusted).
`SessionStart` runs at the start of the first turn, after Console already knows the thread id. Hook
stdin carries `session_id` = thread id; tool-call shells get `CODEX_THREAD_ID`; the coordination MCP
reads `_meta.threadId`. Hook processes inherit the shared app-server environment, so
`AGENT_CONSOLE_SESSION_ID` cannot identify a thread; the server resolves the Console session from the
structured binding instead (see Coordination). MCP servers from config start per loaded thread, so
idle threads are unsubscribed. Codex waits only about one second for optional MCP servers before the first
model request, so every thread starts with `mcp_optional_startup_grace_ms: 10000` (the value T3 Code uses).
The prove script verifies hook registration and an MCP coordination call from inside a structured turn, and that the
MCP server it ran is this Console's (pinned by the app-server argv, see "Coordination MCP pinning").

## SessionManager seams (slice 1)

Each is an early `if (session.transport === 'structured')` that delegates to
`StructuredSessionService` (`apps/server/src/sessions/structured/structured-session-service.ts`).
Line numbers are from `main` at `af009e3`.

| Entry point (SM) | Structured behavior |
|---|---|
| `bindConversationInternal` (2015) | `transport` from the bind input. Start (new) or resume (history) through the plugin; write the row `bound` with `transport`, sentinel tmux name, app-server `pid`, event log path; for a new chat run `adoptPendingConversation` immediately with the thread id so `conversation_ref = resume_conversation_ref = threadId`; keep the `pending:` row as URL alias and title carrier; journal `user-input` for an initial prompt and send it as the first turn; emit `session.updated`. No `verifyStartupSurvived`, no tmux. |
| `restoreSession` (1632), `refreshSessionState` (3654), `ensureSession` (3585) | `ensureLoaded(session)`: connect/launch the instance, `resume` the thread if not loaded, set the epoch, clear idle/pressure markers on explicit restore. Never `stopWatching` because of a dead tmux. |
| `getSessionScreen` (3594) | Return a synthesized `SessionScreen`: `inputActive: true`, empty content, `status` from the thread state (`Codex (app-server) working`, `idle`, or `asleep` while the thread is not loaded), `model` from the profile. No tmux. A manual or idle sleep publishes the screen after the unload, so the event stream shows `asleep` (the poll has no screen for a suspended row), and the restore publishes `idle` again. |
| `drainQueuedInputInternal` (2357), `sendInputInternal` (2151), `sendKeystrokesInternal` (2582) | Human text plus Enter: if no turn is running, `sendTurn`; if a turn is running and the plugin can steer, `steer`; journal `queued -> submitting -> submitted` with `turnId`. Escape: `interrupt` the active turn. Other keys, Text Bypass text-only and literal selection tokens: 409 with a clear message. `allowsLiteralSelectionKeystroke` (3568) returns false. See Input and delivery rules below. |
| `drainAssignments` (648-846) | Replace the tmux liveness/owner/screen/submit block with `deliverAutomatic(session, prompt)` returning `submitted | deferred | failed`; keep attempt records, follow-ups, continuation bookkeeping and `status` events in SM. Guard order unchanged: working, queued input, manual pause, run failure. `deferred` means nothing was sent; `failed` means the outcome is uncertain (see Input and delivery rules). |
| RunRecovery `canRetry` (330) and `submit` (363) | `canRetry`: thread loaded on a live connection, no active turn, enabled project/provider, memory above the floor. `submit`: `sendTurn` with the recovery prompt. A `deferred` delivery (nothing was sent: the transport's `NotSentError`, a turn that started first, an unloaded thread) throws `RecoverySubmitDeferredError`; RunRecovery then gives the attempt back and schedules the retry one backoff step later, inside the same 10-minute recovery window, instead of stopping as "outcome uncertain". Only a `failed` delivery or another error stops recovery as uncertain. A `StructuredRunMonitor` (one per session, a stable key for RunRecovery) takes run state from the turn events, which are authoritative for turns the host observed, and attaches the rollout-based `CodexRunMonitor` once the index has the transcript path; the newer of the two states wins. |
| `verifyNativeProcessEpoch` (969), `providerTurnIsWorking` (988) | Epoch = `structured-epoch:<sessionId>`. A transcript run older than the epoch is never recorded as a response. `turn.started`/`turn.terminal` events drive `isWorking` directly through `syncSessionWorkingState`. For a structured row `providerTurnIsWorking` is `alive ? turnActive : false`: a thread that is not loaded runs nothing, so the transcript run state is never consulted. Without this, a rollout whose last record is an unfinished turn would read as working after a restart or an idle sleep, and would block peer and continuation wakes. |
| `reconcileSessions`, `refreshStructuredSessionState` | A structured thread loads on first use, not at boot. Boot settles lost work only: a row still marked working loses its turn with the connection (status line, `isWorking=false`, and RunRecovery `process_exited` for unattended work). A row in status `error` or `starting` is restored, as on tmux (`starting` is a restore that a crash cut off). When the thread is not loaded and the row has a run failure or unfinished unattended work, the refresh branch calls `watchSessionOutput`, which attaches the run monitor, so RunRecovery re-arms a scheduled retry from the persisted budget and the rollout. |
| `suspendIdleSession` (1343), `suspendPressureIdleSession` (1261), `suspensionBlockReason` (3371), `suspendSession`/`resumeSession` (3421) | Idle: `unload` and set `idleSuspendedAt`; the row's run monitor is kept. Pressure: skip structured rows in slice 1 (a shared process cannot be suspended per thread). Manual suspend: `unload` and set `manualSuspendedAt`; resume: `ensureLoaded`. Block reasons: `turn_running`, `queued_input`. |
| `releaseSessionInternal` (3481) | `interrupt` if a turn is active, then `unload`, then `ended`; delete the runtime dir as today. |
| `drainModelProfileRequestInternal` (3078), `applyModelProfileRequest` (3226) | No restart. Store the profile and complete the request immediately when idle; when a turn is running (or one starts during the switch) put the request back to `queued` with `turn_running`, and the next `turn.terminal` re-runs it. The next `sendTurn` carries `model`/`effort`. |
| `restartGrantedSession` (1830), `closeGrantedSession` (1869) | Restart: refuse with "Restart is waiting for the current work to finish." while a turn is active. A grant never stops a human's running turn; tmux refuses in the same situation. Otherwise `unload`, reset the run monitor, `ensureLoaded`, `sendTurn(prompt)`. Close: same as release. Completion of a crash-resumed restart compares `structured-epoch` instead of `pid`. |
| `retainFinishedInbox` (485), `isWorkReleaseDue` path (1170) | Use `providerAlive(session)`: tmux liveness for tmux rows, "thread loaded on a live connection" for structured rows. |
| `ensureSessionLogPaths` (1517), `watchSessionOutput` | Do not create or tail `raw.log` for structured rows. |
| `handleRealtimeLifecycleEvent` (1050) | `conversation.index-updated` still attaches the transcript watcher and run monitor once the rollout path is indexed. After each `turn.terminal`, if the index row has no transcript path, call `fillTranscriptPath(session)` (plugin `transcriptPath` or `thread/read`), update `conversation_index`, and emit `conversation.index-updated`. |

Input and delivery rules:

- Slash commands are terminal controls. A message that is only a command word (`/model`, `/compact`) is
  refused with 409 on every submit path. A message with more text after the word (`/model gpt-6`) or one that
  starts with a path (`/tmp is full`) is an ordinary message. The check is `STRUCTURED_SLASH_COMMAND`
  (`/^\/[A-Za-z][\w:-]*$/`) on the trimmed text.
- Human input. `NotSentError`, `PreviousTurnActiveError` and a busy or unavailable session put a queued
  message back to waiting. A direct send is rejected with "Nothing was sent." Any other failure ends the
  queued record as `failed` with "Submission could not be confirmed. Check the conversation before sending
  again." That covers a steer the server refused, a timeout and a failure after the write. A request the
  session cannot take at all, such as an image, fails with its own message. The host sends a steer as a new
  turn only for `TurnNotActiveError`.
- Automatic delivery (`deliverAutomatic`: wake, recovery and restart prompts). A thread that is not loaded
  or is busy, a pending request, `PreviousTurnActiveError` and `NotSentError` give `deferred`: nothing was
  sent, so a later attempt is allowed and a continuation is recorded as scheduled. Any other error gives `failed`: delivery is uncertain, the prompt is
  not replayed, and a continuation is blocked until unattended work is enabled again. RunRecovery `submit`
  throws for anything but `submitted`.

`StructuredSessionService` API used by SM (all run under `runtimes.run(sessionId, label)` by SM):

```ts
start(input: { sessionId; provider; cwd; profile?; model?; effort? }): Promise<{ nativeSessionId; transcriptPath?; pid? }>
resume(session, cwd): Promise<{ transcriptPath?; pid? }>
ensureLoaded(session, cwd?): Promise<'loaded' | 'unavailable'>
submitHuman(session, record: { requestId; text }, images?): Promise<{ turnId; mode: 'turn' | 'steer' }>
interrupt(session): Promise<'interrupted' | 'idle'>
deliverAutomatic(session, prompt): Promise<{ status: 'submitted' | 'deferred' | 'failed'; reason?; turnId? }>
setProfile(session, profile): Promise<'applied' | 'deferred'>
unload(session): Promise<void>
release(session): Promise<void>
alive(session): boolean
screen(session): SessionScreen
```

`start` takes no opening prompt: `SessionManager` journals the prompt and sends it as the first turn after
`start` returns, and rolls the bind back if that send fails.

The service subscribes to each session's event stream and calls SM-provided callbacks:
`onTurnStarted`, `onItemCompleted` (live only: `lastOutputAt = lastActivityAt = now`),
`onTurnTerminal` (completed: `lastResponseAt`; failed: RunRecovery `changed`), `onRequest` (decline and
`status` event), `onSessionState` (error: RunRecovery `processExited`), `appendStatus`.

## Coordination, grants and other readers

- `CoordinationService.register`: when `consoleSessionId` is absent or does not match, resolve it from
  `bound_sessions` where `transport='structured' and provider=? and (conversation_ref=? or
  resume_conversation_ref=?) and should_restore=1`. This restores `bindAssignment` for structured
  threads (assignment project, automatic `unattended` for granted helpers, grant session naming).
- `sendReceipt` and `reconcileProcesses`: for an assignment with a structured binding, liveness is "a
  restorable bound structured row exists" (`transport='structured'`, `should_restore=1`, status `starting`
  or `bound`, and one row for the thread). `CoordinationService` reads this from `bound_sessions` itself and
  needs no callback into `SessionManager`. It is not the shared process id and not the pid of the last hook,
  because the thread loads on demand (wake, recovery, selection). So `reconcileProcesses` does not
  disconnect such an assignment and does not page its supervisor after a backend restart or an app-server
  exit. A receipt for a thread with a restorable row reports `stopped` only while the row is manually or
  pressure suspended. A thread whose only row is released is `stopped`. A thread with no structured row
  falls back to the hook pid, as for tmux.
- `coordination/wake.ts` `queueCodexNotice` is not used for structured rows; `deliverAutomatic` sends
  the same fixed notice text through `sendTurn`. `PeerWakeAttempt` records keep their format so audit,
  delivery warnings and grant push keep working.
- `grants/session-launches.ts`: restart goes through `restartGrantedSession`, which handles structured rows.
  A granted launch always creates a tmux session: `launch_session` has no `transport` field. The memory gate
  stays as is. Concurrency counting keeps using `pid` (the app-server pid is set on structured rows).
- `scripts/worktree-sweep.mjs`: unchanged; a structured row's checkout looks "process running" while the
  shared process lives, which is the conservative outcome.

## Routes and web

- `POST /api/conversations/:projectSlug/:provider/new/bind` accepts `{ transport?: 'tmux' |
  'structured' }`. Structured is refused with 400 unless `structuredSessions.<provider>.enabled`.
- `POST .../:conversationRef/bind` (history resume) accepts the same field; a structured resume of a
  conversation that another live binding owns is refused like today (one restorable owner).
- `GET /api/projects` tree response gains `structuredProviders`.
- `GET /api/sessions/:id/screen` returns the synthesized screen for structured rows.
  `GET /api/sessions/:id/raw-output` returns 404 for structured rows.
- Web: New Chat shows a second action, "Codex (app-server)", when the tree advertises the provider.
  `ConversationPane.tsx` for `boundSession.transport === 'structured'`: hide Text Bypass, the
  arrow/Backspace/Tab keys, the native-selection affordances and the terminal panel; keep Send, Esc/Stop,
  model profile controls, `QueuedInputNotice`, `RunFailureNotice`, suspend and close. A small
  "app-server" badge next to the status. `useConversationData.ts` keeps polling `/screen` (cheap
  synthesized response) so older code paths stay valid.

## Not in slice 1

- Streaming assistant deltas into the pane (needs a new event-log record type and a merge rule).
- Approval or question UI (requests are declined and logged).
- Image attachments on structured sessions (route refuses with a clear error).
- Claude Agent SDK plugin and ACP plugin. The contract above is written for them; a contract test
  suite runs the fake plugin through the same host paths so nothing in the host is Codex-shaped.
- Pressure suspension of structured rows and restart of an idle shared process under memory pressure.
- Granted launches of structured sessions (`launch_session` has no `transport`).
- Per-thread MCP environment injection.

## Verification

- Unit tests (Vitest, `apps/server/test/structured-*.test.ts`): plugin contract with the fake plugin;
  Codex JSON-RPC client against a scripted fake app-server (`test/helpers/fake-app-server.mjs`) over
  stdio; SM seams with the fake plugin (bind, resume, submit, steer, interrupt, wake delivery,
  recovery submit, model profile, idle sleep and restore, release, synthesized screen, 409 paths);
  routes; config; schema migration; coordination register resolution. The review fixes added
  `structured-codex-process-lifetime` (the `setpriv` launch, start-ticks identity, stale process reaping),
  `structured-session-restart` (a turn cut by a backend restart, scheduled recovery re-armed, a half-restored
  row, not-sent delivery, a turn id that runs again), `tmux-client-structured-guard` and
  `structured-session-env`, and extended the plugin, input, recovery, coordination and wake suites. The round-2
  fixes added launcher-shaped process-group tests (`test/helpers/fake-launcher.mjs`), the MCP argv and context
  tests, not-sent steer and recovery tests, the refused-interrupt tests, the one-line status reason tests (the
  fake app-server gained `exitAtStart`), the asleep screen test and fake-plugin error-type tests.
- Web tests: New Chat option, hidden controls, badge.
- `npm run typecheck && npm run build` and the full `npm test`. The full server runs on `be43958` and on
  `ca41634` each had the same three failures, identical on untouched `main` on this host
  (`claude-ready-lifecycle` twice, `claude-run-state > never sends Enter when Stop arrives during automatic
  text entry`); see Verification evidence for the counts.
- Real Codex proof: `scripts/prove-structured-codex.mjs` (opt-in with `--run`, needs `npm run build` and a
  host Codex login). It starts an isolated backend (temp database and runtime, scratch git project, private
  tmux socket, `structuredSessions.codex.enabled`, coordination enabled) and drives one structured chat
  through the HTTP API, recording each step into `test-results/structured-codex-proof/<timestamp>.json`:
  a. the tree advertises the provider; b. structured bind (thread-id `conversation_ref`, `structured:`
  sentinel name, app-server `pid`, no tmux server, the child has the isolated `AGENT_COORD_RUNTIME` and no
  session identity, its argv carries the coordination MCP overrides that the product adds, and the pid leads a
  process group that the instance record names); c. model profile `low` before the first turn, with no restart;
  d. first message and reply; e. rollout file, index transcript path and the first turn's `turn_context`
  carrying the low model; f. hook registration with the thread id and an MCP `status` call from inside a turn,
  with an `agent-coord.mjs mcp` process of the isolated runtime seen during that turn (the MCP server is this
  Console's, not the live one's); g. a message sent mid-turn is delivered as a steer; h. Escape interrupts a
  running turn (`turn_aborted`), and the counting shell command, found by a unique marker in its command line, is
  running before Stop and gone after it; i. manual sleep (refused while the assignment is `active`, allowed
  after a completed turn): the screen is `idle` while loaded, `asleep` on the event stream after the unload
  (the poll then has no screen), and `idle` again with a new `structured-epoch` after the restore, then a reply
  on the same app-server pid; j. profile `medium` reaches the provider on the next turn, then back to `low`;
  k. graceful backend restart (the stdio app-server and every process of its group die with the backend) and a
  reply from a new app-server on the same conversation; l. release, then no process of the proof remains after
  backend shutdown: nothing whose command line holds the temp root and nothing whose environment carries the
  isolated `AGENT_COORD_RUNTIME` (app-server, native child, hooks, MCP servers, model commands). The profile
  switch runs before the first turn
  because the medium profile's model is rate limited on this host at times: Codex then waits out a 429
  backoff of minutes and the turn only looks hung (the evidence lists such retries from Codex's own log).
  Step j therefore waits for the medium turn to start, not to answer.

## Verification evidence

Real Codex proof, 2026-10-26, `codex-cli 0.164.0`. `node scripts/prove-structured-codex.mjs --run` passed
12 of 12 steps on the round-2 fixes (the working tree on top of `4f62494`, 78 seconds; evidence copied to
`docs/research/codex-app-server-2026-10-26/proof-run-2026-10-26T08-56-32Z.json`), on the round-1 fixed build
(`ca41634`, 75 seconds; `proof-run-2026-10-26T08-22-18Z.json`) and, before the fixes, on `be43958` plus the env
plumbing in two consecutive runs (57 and 64 seconds; one copied to `proof-run-2026-10-26T07-51-45Z.json`). Each run
also writes an untracked copy under `test-results/structured-codex-proof/`. The table shows the round-2 run; the
earlier runs reported the same values for steps that did not change, with other ids and pids. After the run no
`codex app-server` process was left. This host's Codex is the npm launcher: the recorded pid led a process group
of two (launcher and native server).

Automated suites on the round-2 working tree (`env -u NODE_ENV`, targeted files only, `--testTimeout 10000
--maxWorkers=2`; the full suite was not rerun for round 2): the 12 structured files (`structured-*.test.ts` and
`tmux-client-structured-guard`) 259 passed, 2 skipped (the opt-in real-Codex handshake tests); the tmux suites
`session-lifecycle`, `run-recovery`, `peer-message-wake`, `coordination` and `agent-session-launches` 322 passed.
`npm run typecheck` and `npm run build` clean. The last full-suite run was on `ca41634` (`env -u NODE_ENV`): server
`vitest run` 1931 passed, 2 skipped, 3 failed; the three failures are the same timing-sensitive Claude tmux tests
that fail on untouched `main` on this host (`claude-ready-lifecycle` twice, `claude-run-state` once). Web
`vitest run` 198 passed.

| Step | Result and key values |
|---|---|
| a. tree | `structuredProviders: ['codex']` |
| b. bind | `transport: structured`; `conversation_ref` is the thread UUID; `tmux_session_name` `structured:<id>`; `raw_log_path` null; `pid` is the app-server (the launcher); no tmux server on the private socket; child environment has the isolated `AGENT_COORD_RUNTIME` and `AGENT_CONSOLE_CONFIG`, no `AGENT_CONSOLE_SESSION_ID`; its argv holds the three `mcp_servers.agent_console_coordination` overrides after the update-check override and no session id; the instance record names `processGroup` = pid and the group has 2 members |
| c. profile before first turn | `low` applied with the same pid, request cleared, screen shows `gpt-6-luna xhigh` |
| d. first message | queue record `submitted`, `deliveryMode: turn`, reply `PONG`, `lastResponseAt` set |
| e. rollout | file under `~/.codex/sessions`, session id matches, index `transcript_path` set, first `turn_context.model` is `gpt-6-luna` |
| f. coordination | the SessionStart hook registered `native_session_id` = thread id in the isolated runtime; the agent called the `agent_coordination` MCP tool (rollout shows the call) and replied `REGISTERED`; `last_seen_at` advanced; one `agent-coord.mjs mcp` process with the isolated runtime in its environment ran during the turn |
| g. steer | message sent mid-turn: `deliveryMode: steer`, same `turnId`; reply `STEERED` |
| h. Stop | Escape: idle within 0.3 s, rollout `turn_aborted` with reason `interrupted`; the counting command (one process, found by its marker) was running before Stop and gone 0.3 s after |
| i. sleep | manual suspend refused (HTTP 409) while the assignment was `active` after the interrupted turn; allowed after a completed turn; `manualSuspendedAt` set then cleared; the event stream showed the screen `working > idle > asleep > idle > working > idle`, the screen poll answered 404 while suspended, `structured-epoch` changed on restore; `RESTORED` reply on the same app-server pid |
| j. medium round trip | `medium` applied; the next turn's `turn_context.model` is `gpt-6.1-sol`; turn stopped; back to `low`; same pid |
| k. graceful backend restart | old app-server and both members of its process group gone after shutdown; row still restorable; `RESUMED` reply from a new app-server pid |
| l. release | row `ended`; no tmux server; 3 processes of the proof alive after release (launcher, native server and 1 coordination MCP server), 0 after backend shutdown, found by command line and by `AGENT_COORD_RUNTIME` in the environment |

What shaped the proof (earlier runs on the same code, same day):

- `gpt-6.1-sol` (the medium profile's model) returned HTTP 429 on some turns, and Codex waited out a server-chosen
  backoff of 25 to 519 seconds, so turns looked hung with no model output. Codex records this in its own log
  database (`~/.codex/logs_*.sqlite`, target `codex_core::responses_retry`), not in the rollout. The proof
  therefore switches to the low profile before the first turn and lists retries in its evidence
  (`providerRetries`). A plugin-level probe of the same model, three turns, answered in 2 to 5 s, so the stalls
  were provider-side, not Console-side.
- An interrupted turn runs no Stop hook, so the assignment stays `active` and manual sleep is refused until a
  turn completes. This is the existing rule for tmux sessions, applied to structured rows.

Not covered by the proof: automatic idle sleep after `idleUnloadMinutes` (unit tests only; the proof sleeps
manually), pressure suspension (skipped for structured rows by design), RunRecovery and peer-wake delivery
against real Codex (fake-plugin tests only), a backend crash with a running turn (the proof restarts
gracefully; the process-group crash protection is covered by unit tests with a launcher-shaped stand-in), the image, approval and streaming paths (not in slice 1).

## Review and fixes

An independent review of the first implementation (`main..be43958`) is in
`docs/research/codex-app-server-2026-10-26/review-round-1.md`. Commit `ca41634` fixed its findings (round 1):

- An unloaded structured row never reads as working from a stale rollout. Boot settles a lost turn.
- Scheduled recovery and half-restored `starting` rows re-arm after a backend restart.
- The app-server starts under `setpriv --pdeathsig TERM`, and a stale instance is ended before the first spawn.
- The tmux client refuses `structured:` names.
- Coordination liveness for structured bindings is the restorable row, not the shared pid.
- A granted restart refuses while a turn runs.
- `NotSentError` and `TurnNotActiveError` are contract errors. Not-sent automatic delivery is `deferred` and
  not-sent human input is requeued. Only `turn_not_active` turns a steer into a new turn.
- An interrupt always terminates tracked background commands. A turn that Codex still runs after a local
  finalize is tracked again. `userMessage` and `hookPrompt` items no longer count as output.
- A slash command is refused only when it is the whole message. Conversation status lines no longer carry
  the stderr tail.
- `PluginContext.spawnScoped` and the host's `spawnDetached` were removed. The structured config type is
  defined once, from the zod schema (`StructuredProviderConfig`).

A second review (`be43958..ca41634`, `docs/research/codex-app-server-2026-10-26/review-round-2.md`) found no
regression in tmux rows, coordination for tmux, restored `starting` rows, monitor churn, exactly-once terminals or
the env merge order, and eight new problems. The round-2 fixes:

- The coordination MCP server of a structured thread is pinned to this Console. The host puts
  `coordination: { runtimeDir, helperPath }` on the `PluginContext` and the plugin appends the
  `mcp_servers.agent_console_coordination` overrides to the app-server argv (see "Coordination MCP pinning").
  Before, the agent's `agent_coordination` calls followed `~/.codex/config.toml` and reached the live Console
  whenever the runtime differed. The proof script lost its own hand-added override and now checks the argv and
  that an MCP process with the isolated runtime ran.
- The crash protection reaches the native server. On an npm install the recorded pid is the `codex` Node
  launcher; the native app-server is its child, and SIGKILL to the launcher left that child running. The child
  now leads its own process group; `close()` escalation and the stale reap signal the group (the reap only when
  pid, start ticks and boot id match and the record names the group). The doc sentence "the recorded pid is the
  Codex process" was wrong and is corrected.
- A recovery prompt that was certainly not sent (`deferred` delivery, including the transport's `NotSentError`)
  no longer stops unattended recovery as "outcome uncertain" and no longer spends the attempt: RunRecovery gets
  `RecoverySubmitDeferredError` and schedules the retry one backoff step later, inside the 10-minute window.
- `steer()` throws `NotSentError` for failures before the frame is written (ended session, no connection, request
  refused before the write), like `sendTurn`, so the human message is queued and sent again.
- A refused `turn/interrupt` for a turn the server does not hold ("no active turn", `thread not found/loaded`)
  closes the turn locally as `interrupted`, once, so Stop clears the row.
- Bind and restore failure lines carry a one-line reason (first line, 200 characters). `JsonRpcExitError`
  and the start error name only how the process ended; the redacted stderr tail goes to the server log.
- The synthesized screen reads `asleep` while the thread is not loaded; the manual and idle sleep publish it.
- The fake transport session throws `NotSentError` for `sendTurn` and `steer` on a closed session, and
  `TransportUnavailableError` for `interrupt`; `unload()` ends its stream as the real plugin does.
- Proof script: the sleep step shows the unload and reload (asleep screen on the event stream, new epoch), Stop
  shows the counting command gone (unique marker), the leftover check also sees processes that only carry the
  runtime in their environment (MCP servers, hooks, model commands), the group of the app-server dies with the
  backend, and the restart step is named "graceful backend restart".

Left open on purpose:

- Granted launches always create tmux sessions. `launch_session` has no `transport` field.
- RunRecovery ignores the `retryable` flag on the `thread_closed` failure. It retries only `server_overloaded`,
  `server_unavailable` and `process_exited`.
- A steer the server refused for a reason other than losing the race shows "Submission could not be confirmed".
- Whether `codex app-server` exits on stdin EOF while a turn runs is unverified. A crashed backend is covered
  by `--pdeathsig` and the group-wide stale reap, which unit tests show with a launcher-shaped stand-in
  (`structured-codex-process-lifetime`), but the proof script still only restarts gracefully. A proof step that
  runs the backend as a child process, SIGKILLs it during the counting command and asserts that the launcher and
  the native binary both exit with no later rollout writes is a follow-up.
- When the launcher itself is already dead and its native child still runs (for example the launcher was killed
  with SIGKILL), the stale reap cannot check the group's identity and leaves that child alone.
- The shared app-server stays alive after the last thread is released, until backend shutdown.

## Work breakdown (slice 1)

| Lane | Owner | Files | Done when |
|---|---|---|---|
| W0 foundation | one agent, first | shared types, schema 19 + repo mapping, sweep allowlist, config schema + example, `providers/transport/types.ts` + `registry.ts`, `test/helpers/structured-fixtures.ts` | typecheck passes; config, database and schema tests pass |
| W1 Codex plugin | one agent | `providers/transport/codex/*`, `test/helpers/fake-app-server.mjs`, `test/structured-codex-plugin.test.ts`, `THIRD_PARTY_NOTICES.md` | plugin tests pass against the fake app-server; a manual handshake against the real binary works |
| W2 host + SM seams | one agent | `sessions/structured/*`, `session-manager.ts` seams, `coordination/service.ts` register/receipt changes, `grants/session-launches.ts` epoch, `test/structured-session-*.test.ts` | seam tests pass with the fake plugin; existing suites unchanged |
| W3 routes + web | one agent | `routes/conversations.ts`, `routes/sessions.ts`, `routes/projects.ts`, web New Chat, `ConversationPane.tsx`, web tests, `config/agent-console.example.json` | route and web tests pass |
| W4 proof + docs | one agent after W1-W3 | `scripts/prove-structured-codex.mjs`, `docs/architecture.md`, `docs/fileindex.md`, `docs/agent_docs/running_tests.md`, AGENTS.md one-liner | proof script passes on this host |

W1, W2 and W3 run in parallel after W0. File ownership is exclusive per lane; shared files
(`packages/shared/src/index.ts`, `config/schema.ts`, `db/schema.ts`) are W0-only. Review (Opus) runs
after W4, then a fix loop, then the full test run and the proof script again.

## Future slices

1. Streaming deltas: `assistant-output` event-log record, reader mapping to `role: 'assistant',
   lifecycle: 'pending'`, merge rule keyed by item id.
2. Approvals and questions UI with push notifications; thread policy `on-request`.
3. Claude plugin (Agent SDK, one process per conversation; steer cancels running tools; interrupt ends
   the process and the next turn resumes). Resolve the Anthropic third-party login clause first.
4. ACP plugin (Mistral Vibe, Grok): one process per session, host-enforced permissions, steer as
   interrupt plus new turn, per-agent failure classification.
5. Retire the tmux path per provider once the structured path has carried real work for a while; then
   supersede `design/extension-agent-lane`.
