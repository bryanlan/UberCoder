# Structured provider lane

Date: 2026-10-26. Branch: `feature/structured-provider-lane`. Status: slice 1 implementation plan and
contract. The lane ships behind a config flag that defaults off. Nothing in this document changes the
running Console until the flag is turned on for a provider.

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
                                | one app-server process on |  JSON-RPC over a Unix socket,
                                | a Unix socket, N threads  |  launched in a systemd scope
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
- `tmux_session_name` stays NOT NULL. Structured rows store the sentinel `structured:<sessionId>`.
  tmux refuses session names with a colon, so an accidental tmux call fails loudly instead of touching
  a real session.
- `raw_log_path` is NULL for structured rows; `event_log_path` is set (the event log is shared).
- `pid` holds the app-server process id for structured rows (readers that use `pid` as "a live
  helper exists" keep working: worker roster, grant concurrency).
- `scripts/worktree-sweep.mjs` `SUPPORTED_SCHEMA_VERSIONS` gains 19 in the same change.
- Meta keys owned by the structured lane: `structured-instance:<provider>` =
  `{ pid, startedAt, socketPath, version }` for the shared process; `structured-epoch:<sessionId>` =
  ISO time the thread was last loaded on the current connection (recency and run-epoch guard).

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
    "idleUnloadMinutes": 60
  }
}
```

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
  sendTurn(input: TurnInput): Promise<{ turnId: string }>;  // rejects with PreviousTurnActiveError while a turn runs
  steer?(turnId: string, input: TurnInput): Promise<void>;  // only when capabilities.steer !== 'none'
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
  runtimeDir: string;                                       // <runtimeDir>/structured/<plugin>/
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  spawnScoped(argv: string[], options: { cwd: string; env: Record<string, string>; unit: string }): Promise<{ pid: number }>;
  meta: { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void };
}
```

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
- Instance = one app-server process per provider instance (CODEX_HOME), started with the configured
  `command` plus `-c check_for_update_on_startup=false`, cwd fixed to the runtime directory, env
  `CODEX_HOME` expanded. Meta `structured-instance:codex` records `{ pid, startedAt, version }`.
- Thread = Console conversation. `start` = `thread/start { cwd, model, approvalPolicy: 'never',
  sandbox: 'danger-full-access', approvalsReviewer: 'user', config: { model_reasoning_effort },
  ephemeral: false }`; the response carries `thread.id` (UUID, equals the rollout session id and the
  hook `session_id`) and `thread.path` (rollout JSONL, may be null until the first turn). `resume` =
  `thread/resume { threadId, excludeTurns: true, cwd, model, approvalPolicy, sandbox, config }`;
  an archived thread is unarchived and retried; history is not replayed (Console reads the rollout).
- `sendTurn` = `turn/start { threadId, input: [{ type: 'text', text }], clientUserMessageId,
  model, effort, summary: 'detailed', approvalPolicy: 'never', approvalsReviewer: 'user',
  sandboxPolicy: { type: 'dangerFullAccess' } }` (overrides persist, so the policy is re-sent every
  turn). A response with `turn.startedAt === null` is a queued turn: wait for `turn/started` before an
  interrupt. `steer` = `turn/steer { threadId, expectedTurnId, input }`; if it fails because the turn
  just completed, the host resends the text as a new turn. `interrupt` = `turn/interrupt { threadId,
  turnId }`, then terminate tracked background terminals (`thread/backgroundTerminals/terminate`,
  experimental), wait up to 10 s for `turn/completed`, else finalize locally as `interrupted`.
  `unload` = `thread/unsubscribe`.
- Notifications map to `TransportEvent`: `turn/started` to `turn.started` (events for a turn can
  arrive before the `turn/start` response, so buffer by `turnId`); `item/completed` to
  `item.completed` (authoritative item state; `turn/completed.turn.items` is only a summary);
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
idle threads are unsubscribed. The prove script verifies hook registration and an MCP coordination call
from inside a structured turn.

## SessionManager seams (slice 1)

Each is an early `if (session.transport === 'structured')` that delegates to
`StructuredSessionService` (`apps/server/src/sessions/structured/structured-session-service.ts`).
Line numbers are from `main` at `af009e3`.

| Entry point (SM) | Structured behavior |
|---|---|
| `bindConversationInternal` (2015) | `transport` from the bind input. Start (new) or resume (history) through the plugin; write the row `bound` with `transport`, sentinel tmux name, app-server `pid`, event log path; for a new chat run `adoptPendingConversation` immediately with the thread id so `conversation_ref = resume_conversation_ref = threadId`; keep the `pending:` row as URL alias and title carrier; journal `user-input` for an initial prompt and send it as the first turn; emit `session.updated`. No `verifyStartupSurvived`, no tmux. |
| `restoreSession` (1632), `refreshSessionState` (3654), `ensureSession` (3585) | `ensureLoaded(session)`: connect/launch the instance, `resume` the thread if not loaded, set the epoch, clear idle/pressure markers on explicit restore. Never `stopWatching` because of a dead tmux. |
| `getSessionScreen` (3594) | Return a synthesized `SessionScreen`: `inputActive: true`, empty content, `status` from the thread state, `model` from the profile. No tmux. |
| `drainQueuedInputInternal` (2357), `sendInputInternal` (2151), `sendKeystrokesInternal` (2582) | Human text plus Enter: if no turn is running, `sendTurn`; if a turn is running and the plugin can steer, `steer`; journal `queued -> submitting -> submitted` with `turnId`. Escape: `interrupt` the active turn. Other keys, Text Bypass text-only and literal selection tokens: 409 with a clear message. `allowsLiteralSelectionKeystroke` (3568) returns false. |
| `drainAssignments` (648-846) | Replace the tmux liveness/owner/screen/submit block with `deliverAutomatic(session, prompt)` returning `submitted | deferred | failed`; keep attempt records, follow-ups, continuation bookkeeping and `status` events in SM. Guard order unchanged: working, queued input, manual pause, run failure. |
| RunRecovery `canRetry` (330) and `submit` (363) | `canRetry`: thread loaded on a live connection, no active turn, enabled project/provider, memory above the floor. `submit`: `sendTurn` with the recovery prompt. The rollout-based `CodexRunMonitor` stays attached once the index has the transcript path. |
| `verifyNativeProcessEpoch` (969), `providerTurnIsWorking` (988) | Epoch = `structured-epoch:<sessionId>`. Runs older than the epoch cannot own working state. `turn.started`/`turn.terminal` events also drive `isWorking` directly through `syncSessionWorkingState`. |
| `suspendIdleSession` (1343), `suspendPressureIdleSession` (1261), `suspensionBlockReason` (3371), `suspendSession`/`resumeSession` (3421) | Idle: `unload` and set `idleSuspendedAt`. Pressure: skip structured rows in slice 1 (a shared process cannot be suspended per thread). Manual suspend: `unload` and set `manualSuspendedAt`; resume: `ensureLoaded`. Block reasons: `turn_running`, `queued_input`. |
| `releaseSessionInternal` (3481) | `interrupt` if a turn is active, then `unload`, then `ended`; delete the runtime dir as today. |
| `drainModelProfileRequestInternal` (3078), `applyModelProfileRequest` (3226) | No restart. Store the profile and complete the request immediately when idle; when a turn is running defer with `turn_running` and complete at the next terminal. The next `sendTurn` carries `model`/`effort`. |
| `restartGrantedSession` (1830), `closeGrantedSession` (1869) | Restart: `interrupt` if active, `ensureLoaded`, `sendTurn(prompt)`. Close: same as release. Completion of a crash-resumed restart compares `structured-epoch` instead of `pid`. |
| `retainFinishedInbox` (485), `isWorkReleaseDue` path (1170) | Use `providerAlive(session)`: tmux liveness for tmux rows, "thread loaded on a live connection" for structured rows. |
| `ensureSessionLogPaths` (1517), `watchSessionOutput` | Do not create or tail `raw.log` for structured rows. |
| `handleRealtimeLifecycleEvent` (1050) | `conversation.index-updated` still attaches the transcript watcher and run monitor once the rollout path is indexed. After each `turn.terminal`, if the index row has no transcript path, call `fillTranscriptPath(session)` (plugin `transcriptPath` or `thread/read`), update `conversation_index`, and emit `conversation.index-updated`. |

`StructuredSessionService` API used by SM (all run under `runtimes.run(sessionId, label)` by SM):

```ts
start(input: { sessionId; project; provider; cwd; profile?; initialPrompt? }): Promise<{ nativeSessionId; transcriptPath?; pid }>
resume(session): Promise<{ transcriptPath?; pid }>
ensureLoaded(session): Promise<'loaded' | 'unavailable'>
submitHuman(session, record: QueuedInputRecord, images): Promise<{ turnId; mode: 'turn' | 'steer' }>
interrupt(session): Promise<'interrupted' | 'idle'>
deliverAutomatic(session, prompt): Promise<'submitted' | 'deferred' | 'failed'>
setProfile(session, profile): Promise<'applied' | 'deferred'>
unload(session): Promise<void>
release(session): Promise<void>
alive(session): boolean
screen(session): SessionScreen
```

The service subscribes to each session's event stream and calls SM-provided callbacks:
`onTurnStarted`, `onItemCompleted` (live only: `lastOutputAt = lastActivityAt = now`),
`onTurnTerminal` (completed: `lastResponseAt`; failed: RunRecovery `changed`), `onRequest` (decline and
`status` event), `onSessionState` (error: RunRecovery `processExited`), `appendStatus`.

## Coordination, grants and other readers

- `CoordinationService.register`: when `consoleSessionId` is absent or does not match, resolve it from
  `bound_sessions` where `transport='structured' and provider=? and (conversation_ref=? or
  resume_conversation_ref=?) and should_restore=1`. This restores `bindAssignment` for structured
  threads (assignment project, automatic `unattended` for granted helpers, grant session naming).
- `sendReceipt` and `reconcileProcesses`: for assignments whose binding is structured, liveness is
  "the Console session is bound and loaded" (SM predicate exposed through a small callback passed to
  `CoordinationService`), not the shared process id. A structured thread whose Console row is released
  is `stopped`.
- `coordination/wake.ts` `queueCodexNotice` is not used for structured rows; `deliverAutomatic` sends
  the same fixed notice text through `sendTurn`. `PeerWakeAttempt` records keep their format so audit,
  delivery warnings and grant push keep working.
- `grants/session-launches.ts`: launch and restart go through the same `bindConversation` and
  `restartGrantedSession` entry points; the memory gate stays as is. Concurrency counting keeps using
  `pid` (the app-server pid is set on structured rows).
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
- Per-thread MCP environment injection.

## Verification

- Unit tests (Vitest, `apps/server/test/structured-*.test.ts`): plugin contract with the fake plugin;
  Codex JSON-RPC client against a scripted fake app-server (`test/helpers/fake-app-server.mjs`) over a
  Unix socket; SM seams with the fake plugin (bind, resume, submit, steer, interrupt, wake delivery,
  recovery submit, model profile, idle sleep and restore, release, synthesized screen, 409 paths);
  routes; config; schema migration; coordination register resolution.
- Web tests: New Chat option, hidden controls, badge.
- `npm run typecheck && npm run build` and the full `npm test` (baseline on `main`: one timing-sensitive
  pre-existing failure, `claude-run-state > never sends Enter when Stop arrives during automatic text
  entry`).
- Real Codex proof: `scripts/prove-structured-codex.mjs` (opt-in, needs a host Codex login). It builds
  the server, starts an isolated backend on a free port with a temp config (`structuredSessions.codex.
  enabled: true`, coordination enabled, a scratch git project), then: creates a structured chat; sends a
  prompt; waits for `turn.terminal`; checks the rollout file and the index transcript path; checks the
  coordination assignment registered by the hook with the thread id and that the agent could call the
  coordination MCP; steers a running turn; interrupts a turn with Escape; switches the model profile and
  checks the next turn's model; sleeps and restores the thread; restarts the backend process and sends
  another turn on the same conversation (the app-server survives); releases the session; disposes the
  instance. Evidence JSON goes to `test-results/structured-codex-proof/<timestamp>.json`.

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
