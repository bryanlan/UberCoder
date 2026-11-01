# Structured provider lane

Date: 2026-10-26. Branch: `feature/structured-provider-lane`. Status: slice 1 implemented; see
Verification evidence. The lane ships behind a config flag that defaults off. Nothing in this document
changes the running Console until the flag is turned on for a provider. The text below was corrected to the
implementation on 2026-10-26; where it still differs from the code, the code governs. The cutover work that
followed (relay, Claude plugin, questions, images, re-adoption across restarts, migration) is in
`docs/structured-cutover.md`; this document keeps the slice 1 record and the plugin contract.

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
                                | one app-server child on   |  JSON-RPC over a LineTransport:
                                | stdio, N threads          |  a session host holds the child
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

### Schema version 20

- `bound_sessions.auto_route_json TEXT`: the Auto profile's state for a row (`routePending` and the router's latest
  decision). It is independently owned state like `launch_context_json`: ordinary row upserts do not write it; only
  `setAutoRoute` and the completion of a model-profile request do.
- `scripts/worktree-sweep.mjs` `SUPPORTED_SCHEMA_VERSIONS` gains 20 in the same change. The new column touches none of the
  assignment, scope or binding meanings the sweep reads.
- Meta keys owned by the structured lane: `structured-instance:<provider>` =
  `{ pid, startTicks, bootId, startedAt, version }`, the backend's note of the provider process it is connected
  to. `pid` is the process the session host started, which on an npm install is the `codex` Node launcher; the
  native app-server is its child. `startTicks` is the process start time (field 22 of `/proc/<pid>/stat`) and
  `bootId` is the kernel boot id; both are left out when `/proc` cannot be read. `version` is left out when
  Codex reported none; a backend that reconnects to a running app-server reads it from here, because it does not
  handshake again. The key is deleted when the process exits (or, for a process run directly over stdio, when the
  instance closes) and kept when only the connection ends. Which process is adopted or ended is decided by the
  session host's record file (`docs/structured-cutover.md`, "Session host relay"), not by this key. `structured-epoch:<sessionId>` = ISO time the thread was last loaded
  on the current connection (recency and run-epoch guard).

### Schema version 21

- `bound_sessions.grok_profile TEXT`: the model profile (`auto`, `high`, `medium`, `low`) of a Grok session, beside `codex_profile` and
  `claude_profile`. It is written and kept like them (a stale upsert cannot overwrite a newer profile; the completion of a
  model-profile request writes the column of the row's provider). Old rows read as having none.
- `scripts/worktree-sweep.mjs` `SUPPORTED_SCHEMA_VERSIONS` gains 21 in the same change.
- The second-prompt check, provisional Auto routing and the provider-neutral Start add no column: they live in the existing `auto_route_json`.

### Shared contracts (`packages/shared/src/index.ts`)

```ts
export const SESSION_TRANSPORTS = ['tmux', 'structured'] as const;
export type SessionTransport = (typeof SESSION_TRANSPORTS)[number];
// BoundSession gains:  transport: SessionTransport;
// TreeResponse gains:  structuredProviders?: ProviderId[];   // providers whose structured flag is on
// POST /new/bind body: { transport?: SessionTransport }       // omitted: structuredSessions.defaultTransport (default 'tmux')
```

### Config (`apps/server/src/config/schema.ts`)

```json
"structuredSessions": {
  "defaultTransport": "tmux",
  "codex": {
    "enabled": false,
    "command": ["codex", "app-server"],
    "idleUnloadMinutes": 60,
    "env": {}
  },
  "claude": {
    "enabled": false,
    "command": ["claude"],
    "idleUnloadMinutes": 60,
    "env": {}
  },
  "grok": {
    "enabled": false,
    "command": ["grok"],
    "idleUnloadMinutes": 60,
    "env": {}
  }
}
```

`defaultTransport` (`tmux` or `structured`, default `tmux`) is the transport of a bind that names none and the switch for
moving existing tmux conversations over; it only takes effect for a provider whose lane is enabled. The Claude block has
the same shape as the Codex one; `command` is the `claude` executable and any leading arguments. So does the Grok block
(`command` is the `grok` executable); Grok has no terminal transport, so with its lane off Grok is not offered at all and
a bind that names it fails with the structured-disabled message. See
`docs/structured-cutover.md`, "Per-session host support, default transport and migration (lane C2)".

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
// Plugin contract for structured (protocol-driven) provider sessions. See docs/structured-providers.md.
// Three levels: plugin (static) -> instance (one binary and home; a shared process when
// processModel is 'shared') -> session (one native conversation).

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
  code?: string; // provider code, e.g. codex 'serverOverloaded'
  message: string; // redacted by the plugin before emit
  retryable?: boolean;
  resetAt?: string;
}

/** One question an agent asks the person (Claude AskUserQuestion, Codex requestUserInput). */
export interface PendingQuestion {
  id: string;
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  allowCustom?: boolean;
}

/** The host's answer to a request.opened event. */
export type RequestResponse =
  | { decision: 'decline' | 'cancel' }
  | { decision: 'answer'; answers: Record<string, string[]>; text?: string };

export type TransportEvent =
  | { type: 'session.state'; state: 'starting' | 'ready' | 'running' | 'stopped' | 'error'; failure?: ProviderFailure }
  | { type: 'session.native'; nativeSessionId: string; transcriptPath?: string; title?: string }
  /**
   * `adopted`: the turn was already running when this session attached (a backend restart left it running behind its
   * session host). It is not new activity: the host marks the conversation working but does not move recency.
   */
  | { type: 'turn.started'; turnId: string; origin: 'user' | 'provider'; replay: boolean; adopted?: boolean }
  | { type: 'item.completed'; turnId: string; itemId: string; kind: 'assistant' | 'reasoning' | 'command' | 'file_change' | 'mcp' | 'search' | 'other'; replay: boolean; title?: string }
  /**
   * `replay`: the request was already open before this session attached (adopted after a reattach or reconnect, or read back
   * from the host's replay). The host does not move recency for it and does not announce it again when it announced the id before.
   * `responseMode`: `live` (default) is answered through `respond()` while the provider waits; `message` is a question the provider
   * already moved on from (it asked in a message), so the answer is sent to it as a normal user message and then closed.
   */
  | { type: 'request.opened'; requestId: string; kind: 'command' | 'file_change' | 'permission' | 'mcp' | 'question'; summary: string; turnId?: string; questions?: PendingQuestion[]; replay?: boolean; responseMode?: 'live' | 'message' }
  | { type: 'request.closed'; requestId: string; outcome: 'resolved' | 'declined' | 'cancelled' }
  | { type: 'usage.updated'; contextUsedTokens?: number; contextMaxTokens?: number; windows?: Array<{ id: string; usedPercent: number; resetsAt?: string }> }
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
  | { type: 'turn.terminal'; turnId: string; status: 'completed' | 'interrupted' | 'failed'; failure?: ProviderFailure; sessionUsable: boolean; replay: boolean };

export interface TurnInput {
  text: string;
  images?: Array<{ path: string; mimeType: string }>;
  model?: string;
  effort?: string;
  clientMessageId?: string;
}

export interface TransportSession {
  readonly nativeSessionId: string;
  readonly capabilities: TransportCapabilities;
  readonly events: AsyncIterable<TransportEvent>; // single consumer; ends after session.state 'stopped'
  readonly transcriptPath?: string; // when the provider reports it
  /** Per-session plugins: the pid of this conversation's own process. Shared plugins leave it out (the instance reports the shared pid). */
  readonly pid?: number;
  /**
   * The turn the provider is running right now, when the transport knows one. A plugin that attaches to a process that was
   * already running (`reattach`, or a `resume` that finds its thread mid-turn) sets it before the call resolves, so the host
   * can mark the conversation working without waiting for the first event, and does not count the turn as new activity.
   * Omitted by plugins that do not say.
   */
  readonly activeTurn?: string;
  /**
   * True while the provider says the conversation is running a turn that the transport cannot name yet (a reattach found the
   * thread active and could not list its turns; the turn is adopted from the first event that names it). The host keeps the
   * conversation marked working and does not take the missing turn for a lost one. Omitted by plugins that never need it.
   */
  readonly turnUnidentified?: boolean;
  sendTurn(input: TurnInput): Promise<{ turnId: string }>; // rejects with PreviousTurnActiveError while a turn runs, NotSentError when nothing was written but a retry may work, SendRejectedError when nothing was written and a retry cannot work
  steer?(turnId: string, input: TurnInput): Promise<void>; // only when capabilities.steer !== 'none'; rejects with TurnNotActiveError when the turn already ended
  /**
   * Resolves when the request is accepted; the terminal follows as an event. A plugin whose stop also drops sends that were
   * queued behind the turn reports the steers among them (`cancelledSteerIds`: the `clientMessageId` the host passed to
   * `steer`, or the message uuid when it passed none), so the host can show them as not delivered or send them again.
   */
  interrupt(turnId: string): Promise<void | { cancelledSteerIds?: string[] }>; // while `turnUnidentified`, an id the session does not know (the host passes '') means that unnamed turn
  /** Answers a pending request. Rejects with {@link RequestNotPendingError} when the id is not open (never seen, withdrawn, or its turn ended). */
  respond(requestId: string, response: RequestResponse): Promise<void>;
  /**
   * Idle sleep and manual suspend. Shared process: drop the thread from memory (the process keeps serving other threads).
   * Per-session: end this conversation's own process; the conversation stays resumable by its native id.
   */
  unload(): Promise<void>;
  /**
   * True while the provider process is running work of its own that no turn covers (a background shell command or
   * subagent). Idle sleep and memory pressure leave such a process alone, as they leave a tmux screen that shows
   * background work. Optional: a plugin that cannot tell leaves it out and the host treats the session as having none.
   */
  hasBackgroundWork?(): boolean;
  /**
   * The host is finished with the session. Per-session plugins end the process whatever the reason; `release` also means the
   * conversation is over. A shared process keeps running for its other threads.
   */
  close(reason: 'release' | 'shutdown' | 'error'): Promise<void>;
}

/**
 * A line-oriented duplex channel to a provider process: a stdio child, or a session host relay that outlives
 * the Console backend. Plugins speak their protocol over it and never spawn directly in production.
 */
export interface LineTransport {
  readonly pid?: number;
  write(line: string): Promise<void>; // rejects when the channel is closed; nothing is written then
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (info: { code: number | null; signal: string | null; reason: 'exited' | 'disconnected' }) => void): () => void;
  close(options?: { terminate?: boolean }): Promise<void>; // terminate: end the provider process, not only the channel
}

export interface LineTransportSpawn {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** Stable identity for reconnecting to a host relay after a backend restart. */
  hostId?: string;
  /**
   * Connect to the live process behind `hostId` and do nothing else. No process is started, and nothing is ended: not a
   * stale host, not a host that runs another command line. Rejects with {@link LineTransportNotRunningError} when no live
   * process answers for exactly this `hostId` and `argv`. A factory that runs children directly over stdio (no hosts)
   * rejects the same way, because a stdio child cannot outlive its parent.
   */
  attachOnly?: boolean;
}

export type LineTransportFactory = (spawn: LineTransportSpawn) => Promise<LineTransport>;

export interface OpenOptions {
  conversationId: string; // Console bound-session id
  cwd: string;
  model?: string;
  effort?: string;
  policy: { approvals: 'never' | 'on-request'; sandbox: 'full-access' | 'workspace-write' | 'read-only' };
  /**
   * Per-session plugins only: the environment for this conversation's process (the Console's coordination variables, the
   * provider's configured `env`, and `AGENT_CONSOLE_SESSION_ID`). A shared process never gets one conversation's identity.
   */
  env?: Record<string, string>;
  /**
   * Per-session plugins only, and only when coordination is enabled: what a conversation's own coordination MCP config needs
   * (the same runtime directory, helper script and session id the tmux launch pins).
   */
  consoleIdentity?: { sessionId: string; runtimeDir: string; helperPath: string };
  /** The standing-authority text of a session a grant launched; the same text the tmux launch appends to the system prompt. */
  appendSystemPrompt?: string;
  /**
   * `'off'`: the provider rebuilds its system prompt on this launch instead of replaying the one recorded on the first
   * request, so changed `appendSystemPrompt` text reaches a resumed conversation. Omitted or `'on'`: the provider's default.
   */
  systemPromptSnapshot?: 'on' | 'off';
}

export interface TransportInstance {
  readonly plugin: string;
  readonly capabilities: TransportCapabilities;
  probe(): Promise<{ installed: boolean; version?: string; auth: 'ok' | 'missing' | 'unknown'; models: Array<{ id: string; label: string; efforts?: string[] }> }>;
  start(options: OpenOptions): Promise<TransportSession>;
  resume(nativeSessionId: string, options: OpenOptions): Promise<TransportSession>; // throws ResumeFailedError
  /**
   * Per-session plugins only. Adopts the conversation's own process when one outlived a backend restart behind its session
   * host, and resolves undefined when there is none. It never starts a process, never ends one it does not adopt, and
   * refuses (throws) a process that does not belong to this conversation. The host calls it once at startup so that idle
   * sleep, memory pressure and release can end survivors that nobody has used since the restart.
   *
   * It throws {@link TransportBusyError} for a host or process that runs but did not answer in time (no hello, or a timed-out
   * handshake), and for no other failure. It is attach-only, so it never ends the process it is waiting for, however long that
   * stays silent: the caller bounds its own wait (the session manager: up to 10 minutes). An ordinary `start`/`resume` is the call that ends
   * and replaces a process that keeps timing out (the rule is stated on {@link TransportBusyError}). Every other failure is an
   * ordinary error: the host treats the process as lost and reports the reason.
   */
  reattach?(nativeSessionId: string, options: OpenOptions): Promise<TransportSession | undefined>;
  /**
   * Per-session plugins that refuse to start a conversation over once its saved history is gone: records that the
   * conversation already has history in the provider (a row moved over from the terminal transport, or one whose turns
   * completed before the plugin kept this record), so a later `resume` that finds the history missing throws
   * {@link ResumeFailedError} instead of launching it again, empty, under the same id. Idempotent. A plugin without such a
   * guard leaves it out.
   */
  noteConversationHistory?(conversationId: string, nativeSessionId: string): void;
  alive(): Promise<{ pid?: number; connected: boolean }>;
  dispose(reason: 'shutdown' | 'restart'): Promise<void>; // shared: disconnect; never kills a process that other Consoles own
}

export interface TransportPlugin<Config = unknown> {
  readonly id: ProviderId | string;
  create(config: Config, context: PluginContext): TransportInstance;
}

export interface PluginContext {
  runtimeDir: string; // <runtimeDir>/structured/<plugin>/
  /**
   * Present when Console coordination is enabled: this Console's runtime directory and the MCP helper script that
   * serves its coordination tools. A plugin points the provider's coordination MCP server at them so the agent's
   * tool calls reach this Console and not whichever one the provider's own config names (the tmux launch does the same).
   */
  coordination?: { runtimeDir: string; helperPath: string };
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  meta: { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void };
  /**
   * Opens line channels to provider processes. Present when the host runs provider processes behind session hosts that
   * outlive the backend; a plugin that finds none runs its child directly over stdio (tests and embedding).
   */
  lineTransport?: LineTransportFactory;
  /**
   * Present with `lineTransport`. Ends the session host with this id and the provider process group behind it from the host's own
   * record, without connecting as a client: through its socket when it answers, otherwise by signal, each gated by the recorded pid,
   * start time and boot. For a host that runs but no longer sends a welcome, which no connection can end the process through.
   */
  endHost?(hostId: string, graces?: { closeGraceMs?: number; termGraceMs?: number; staleTermGraceMs?: number }): Promise<void>;
}

/** `sendTurn` was called while the previous turn on the same session is still running. */
export class PreviousTurnActiveError extends Error {
  readonly code = 'previous_turn_active';
  constructor(message = 'A turn is already running on this session.') {
    super(message);
    this.name = 'PreviousTurnActiveError';
  }
}

/**
 * The request certainly never reached the provider (the session had ended or the connection was gone before
 * anything was written, or a control request timed out), so the caller can queue it and try again. A failure after the write is not this
 * error: its outcome is uncertain and must not be replayed.
 */
export class NotSentError extends Error {
  readonly code = 'not_sent';
  constructor(message = 'The request was not sent.') {
    super(message);
    this.name = 'NotSentError';
  }
}

/**
 * The message could not be prepared or was refused before anything was written, and sending it again cannot change that: the
 * provider refused a setting the message carries (a model or effort), or an attachment is missing or unreadable. Unlike
 * {@link NotSentError} the caller must not retry: it shows `message` to the person, who decides what to do with the message.
 */
export class SendRejectedError extends Error {
  readonly code = 'send_rejected';
  constructor(message = 'The message could not be sent.') {
    super(message);
    this.name = 'SendRejectedError';
  }
}

/** `steer` named a turn that is not the active one any more (it ended first). The caller may send the text as a new turn. */
export class TurnNotActiveError extends Error {
  readonly code = 'turn_not_active';
  readonly turnId?: string;
  constructor(turnId?: string, message = 'The turn finished before the steer reached it.') {
    super(message);
    this.name = 'TurnNotActiveError';
    this.turnId = turnId;
  }
}

/** `resume` could not reattach the native session (unknown id, missing rollout, protocol refusal). */
export class ResumeFailedError extends Error {
  readonly code = 'resume_failed';
  constructor(message = 'The native session could not be resumed.') {
    super(message);
    this.name = 'ResumeFailedError';
  }
}

/**
 * `respond` named a request that is not open: the CLI withdrew it, its turn ended, or it was answered already. The answer
 * reached nobody, so the caller must not report it as delivered.
 */
export class RequestNotPendingError extends Error {
  readonly code = 'request_not_pending';
  readonly requestId?: string;
  constructor(requestId?: string, message = 'That request is no longer waiting for an answer.') {
    super(message);
    this.name = 'RequestNotPendingError';
    this.requestId = requestId;
  }
}

/**
 * Why `attachOnly` found nothing: no host record, no running host, or one that serves nobody because it refuses connections
 * (`absent`); a host whose provider ended (`ended`); a host that runs another command line (`other_command`); or a running host
 * that did not answer in time (`unreachable`, possibly only stalled, so its provider may well run).
 */
export type LineTransportNotRunningReason = 'absent' | 'ended' | 'other_command' | 'unreachable';

/** `attachOnly` found no live process for the host id and command line. Nothing was started or ended. */
export class LineTransportNotRunningError extends Error {
  readonly code = 'transport_not_running';
  /** `absent` and `ended` mean no provider process is reachable for this host id, so a launch record that names it is stale. The others say nothing about that. */
  readonly reason?: LineTransportNotRunningReason;
  constructor(message = 'No live provider process answers for this session host.', reason?: LineTransportNotRunningReason) {
    super(message);
    this.name = 'LineTransportNotRunningError';
    this.reason = reason;
  }
}

/** The provider binary or its process is unavailable (not installed, not connected, exited). */
export class TransportUnavailableError extends Error {
  readonly code = 'transport_unavailable';
  constructor(message = 'The provider transport is unavailable.') {
    super(message);
    this.name = 'TransportUnavailableError';
  }
}

/**
 * The conversation's session host, or the provider process behind it, is running but did not answer in time, so a turn may well
 * be running in it. One rule, followed by both plugins:
 * - busy (this error), thrown by `reattach` and by an ordinary `start`/`resume`:
 *   - no hello: the session host accepted no connection or sent no welcome in time. `reattach` throws it; so do Claude's `resume`,
 *     whose lookup for the process it recorded is an attach-only connect, and Codex's ordinary `start`/`resume` when it reconnects
 *     to a recorded app-server. Only an ordinary open with no recorded process makes a plain connect, which fails with an ordinary
 *     {@link TransportUnavailableError} that says the session host did not answer.
 *   - a timed-out handshake on a process this call did not start (Codex `account/read` or `initialize`, Claude's repeated `initialize`).
 *   A fresh process that this call started and that times out is a failed launch, not busy.
 * - no process (`reattach` resolves undefined): the connection was refused, or the session host or its process is gone.
 * - plain failure with its reason: an exit or a protocol error during the handshake. A refusal of the repeated `initialize` is not
 *   one: the plugin handles it (Claude adopts the process with an unknown turn state; Codex treats "already initialized" as success).
 *
 * What the caller does with busy:
 * - `reattach` (attach-only) never ends a process it found busy: it lets go of it and reports busy. The session manager leaves a
 *   busy survivor alone for up to 10 minutes (`SURVIVOR_BUSY_LIMIT_MS`) and then takes its turn for lost. (A Claude survivor that
 *   never ran a turn and fails its launch checks on reattach is ended as a failed launch; that is not the busy case.)
 * - An ordinary `start`/`resume` reports busy while the process keeps timing out, and once the first timeout of the run is 5 minutes
 *   old (`APP_SERVER_UNRESPONSIVE_LIMIT_MS`, `CLAUDE_UNRESPONSIVE_LIMIT_MS`) the next timeout ends the process and its session host and
 *   replaces it in the same call (Codex starts a fresh app-server; Claude relaunches in the open's own mode, `--resume` when a
 *   transcript exists). Both plugins count the no-hello case of an ordinary open in the same run: past the limit they end the silent
 *   session host and its process group through `PluginContext.endHost`, because no connection can end them. Codex also counts
 *   request timeouts on a live connection: three in a row (`LIVE_CLIENT_TIMEOUT_LIMIT`), or one past the limit, close that
 *   connection without ending the process (the loaded rows see a connection loss and are picked up again on their next load), so
 *   the next use goes through the handshake check. A successful handshake, any frame on a live connection (an answer, a late one
 *   too, or a notification), or a failure that is not a timeout, ends the run; a late answer to a timed-out handshake is never
 *   seen, because that connection is closed. The run is in memory, so a backend restart starts it again. The run and the JSON-RPC
 *   request-id counter are kept by the plugin, not the instance, because the service drops an
 *   instance that never connected after every failed open.
 */
export class TransportBusyError extends TransportUnavailableError {
  constructor(message = 'The provider process is running but did not answer in time.') {
    super(message);
    this.name = 'TransportBusyError';
  }
}
```

The block is a verbatim copy of `types.ts`; if the two ever differ, the file is right. The context carries no
spawn helper. A plugin opens its provider process through `context.lineTransport`, a `LineTransportFactory`
(`providers/transport/line-transport.ts`) that returns a `LineTransport`: a line channel to a provider process held
by a session host that outlives the backend, or to a child run directly over stdio. The host (`app.ts`) provides
the factory; a plugin that finds none runs its child over stdio (tests, embedding).

Contract errors (`types.ts`):

- `PreviousTurnActiveError` (`previous_turn_active`): `sendTurn` while a turn runs.
- `NotSentError` (`not_sent`): the request certainly never reached the provider. The session had ended, or the
  connection was gone, before anything was written. The host queues the message and tries again, for at most ten
  minutes of not-sent attempts, then fails it with the last error. A failure after the write is not this error: its
  outcome is uncertain and the request is never replayed.
- `SendRejectedError` (`send_rejected`): nothing was sent and sending it again would fail the same way (a model or effort the CLI
  refuses, an image file gone from the store). The host fails the message at once with the reason; in automatic
  delivery it is a definite failure, not an uncertain outcome.
- `TransportBusyError` (a `TransportUnavailableError`): `reattach` found the host, or the provider behind it, running
  but it did not answer in time (the connect or the hello timed out, or the handshake after connecting timed out). A
  refused connect is "no process" (the row is absent); a refusal, a protocol error or an exit during the handshake is a
  plain failure with its reason. The host leaves a busy row alone and asks again on each load, for up to 10 minutes, then
  settles the turn as lost.
- `TurnNotActiveError` (`turn_not_active`, carries `turnId`): `steer` named a turn that already ended. The host sends
  the text as a new turn for this error only.
- `RequestNotPendingError` (`request_not_pending`, carries `requestId`): `respond` named a request that is not open
  (never seen, withdrawn, answered already, or its turn ended). The answer reached nobody. The service maps it to
  `StructuredRequestNotPendingError` and the route answers 404.
- `ResumeFailedError` (`resume_failed`) and `TransportUnavailableError` (`transport_unavailable`).
- `LineTransportNotRunningError` (`transport_not_running`, with an optional `reason`): a `LineTransportFactory` request
  with `attachOnly` found no live process for the host id and command line. `attachOnly` connects to a running host and
  nothing else: it never starts a process and never ends one (not a stale host, not a host that runs another command
  line). `absent` and `ended` mean no provider process is reachable, so a launch record that names it is stale;
  `other_command` says nothing about this conversation's process; `unreachable` is a running host that did not answer
  in time, which may only be stalled. A stdio factory answers `absent`, because a stdio child does not outlive its
  parent. `reattach` is built on it.

`TurnAlreadyCompletedError` no longer exists; `TurnNotActiveError` replaced it.

Event rules:

- `replay: true` marks events reconstructed from `thread/resume` or reconnect backfill. On `request.opened` it marks a
  request that was already open when the session attached. The host never lets replay events touch `lastActivityAt`,
  `lastOutputAt` or `lastResponseAt` (AGENTS.md recency rule) and never journals them. A question whose request id
  the person was told about before (kept per provider process) is shown again without a second status line or push.
- `turn.started` with `adopted: true` is a turn that was already running when the session attached: a backend restart
  left it behind its session host. The host marks the conversation working and does not move recency. A plugin that
  attaches mid-turn also sets `TransportSession.activeTurn` before the call resolves.
- `turn.terminal` fires exactly once per turn. If the connection drops, the plugin emits `session.state: 'error'`
  and the host decides (RunRecovery `process_exited`).
- `session.state` and `notice` never count as activity.
- `request.opened` with `kind: 'question'` and a non-empty `questions` list is held for the person and answered through
  `respond()` (`responseMode` `live`, the default). With `responseMode: 'message'` the provider has already moved on
  (it asked in a message), nothing waits, and the answer is sent as a normal user message and the card is closed.
  Every other request, and a question with no `questions`, is declined by the host with `respond(..., { decision:
  'decline' })`.
- Message bodies are not part of the event stream in slice 1. Assistant text arrives through the rollout
  transcript and `session.transcript-updated`.

Fake for tests: `apps/server/test/helpers/structured-fixtures.ts` provides `FakeTransportPlugin` whose
sessions record calls (`sendTurn`, `steer`, `interrupt`, `respond`, `unload`, `close`) and let tests push events.
The fake instance also takes `survivors` (native ids whose process outlived the previous backend, adopted once by
`reattach`).
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
- `--listen unix://PATH` exists (WebSocket over a Unix socket) and would let the process outlive a Console
  backend restart. The plugin does not use it. The app-server runs behind a session host (below) that speaks the
  same newline JSON over stdio to it, which keeps the documented and T3-proven transport and gives both providers
  one mechanism. Console never uses the per-user daemon (`codex app-server daemon`).
- Process lifetime: the service runs with `KillMode=process` (tmux must survive a restart), so a backend restart
  or crash leaves what it started running. For the app-server that is the intent, and the plugin is built around
  it. The plugin asks the line transport for the host `codex`
  (`transport/line-transport.ts`, `transport/session-host.ts`; protocol, record file and buffers in
  `docs/structured-cutover.md`, "Session host relay"). The host is a detached Node process that starts the
  app-server in its own process group through `setpriv --pdeathsig TERM --` relative to the host (the kernel ends
  the app-server if the host dies; without `setpriv` the host warns and starts it plainly). On the first use after
  a backend restart the factory finds the host's record, checks that the recorded host process is the one running
  (pid, start ticks and boot id) and that its command line hash is the same, and connects. Then there is one
  writer, the same process and the same loaded threads. The instance skips the handshake when the host says the
  app-server has already received lines (`everWrote`) and takes the CLI version from the instance meta. A
  command change, a host that does not answer, or a host whose app-server had ended is replaced; a recorded
  app-server left running without its host (a host crash, `setpriv` missing) is ended through its recorded
  process group, after the same identity checks, SIGTERM then SIGKILL after `staleTermGraceMs` (5 s); a record
  with a reused pid or another boot is never acted on. `dispose('shutdown')` and `dispose('restart')` only
  disconnect from a host; the host and the app-server keep running. Ending them is explicit
  (`terminateHost`, or `{"type":"terminate"}` on the socket). The threads that were loaded when the backend
  stopped are loaded again by the service with `thread/resume`; that is safe because the process never died. A row
  that is still marked working is resumed at boot (see "Restart adoption" below), any other thread on first use. The
  transcript of what the app-server did while no backend was connected is read from the rollout, as after any restart. If the connection drops while the process keeps
  running (another client took the host over), the instance behaves as for a process exit: pending requests fail
  (a request already written is `sent: true`, an uncertain outcome that is never replayed, and
  `exit.reason` is `disconnected`), every open session ends with `process_exited` ("Another client took over
  this session host." or "the connection to the session host was lost"), and the next use connects again to the
  same process. Known limit: the identity of a group whose leader is already dead cannot be checked, so a native
  child that outlived its dead launcher is left alone.
- Instance = one app-server process per provider instance (CODEX_HOME), started with the configured
  `command`, then `-c check_for_update_on_startup=false`, then (when coordination is enabled) the coordination
  MCP overrides below, cwd fixed to the runtime directory. Its environment is the Console's own, plus the host
  and configured `env` above, minus `AGENT_CONSOLE_SESSION_ID` and `CODEX_THREAD_ID` (a shared process carries no
  session identity), with `CODEX_HOME` expanded; the host hands the child exactly this environment, and its own
  environment holds no session identity. Meta `structured-instance:codex` records
  `{ pid, startTicks, bootId, startedAt, version }` (see Schema version 19).
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
  `turn/completed`, else finalizes locally as `interrupted`. `unload` = `thread/unsubscribe`. The app-server keeps an unsubscribed thread, and that thread's MCP servers (one coordination helper per thread, about 40 MB), in memory; only `thread/archive` unloads it, and archiving moves the rollout (probe of 2026-10-30). So the instance ends the shared app-server and its session host once no thread has been loaded on it for `idleUnloadMinutes` (a loaded thread cancels that, a start in flight postpones it); the next open starts a fresh process and threads resume from their rollouts. `thread/closed`
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
  command/file/permission approvals are not sent. `item/tool/requestUserInput` with questions the Console can show is
  held open: the plugin emits `request.opened` (`kind: question`, `questions`), the handler's reply is a promise that
  `respond()` settles, and the held request stops counting against the client's limit of concurrent server-request
  handlers (`hold()`), so open questions cannot make the client refuse approvals that must be declined. A question the
  Console cannot show is answered with empty answers and logged as a fixed line ("Declined a question the Console cannot
  show"; the details stay in the server log). `mcpServer/elicitation/request` is answered
  `{ action: 'decline', content: null, _meta: null }`; anything else gets a JSON-RPC `-32601` error.
- Questions asked in a message. On `codex-cli` 0.164.0 in the default collaboration mode the model's tool is
  `request_user_input_async`, which answers `{accepted: true}` at once and raises no server request. Codex instead emits an
  `agentMessage` item (`item/started`, then `item/completed`) with `delivery: 'async'`, `phase: 'final_answer'` and
  `questions: [{ title, options?: string[] }]`. The item has no `id` or `question` fields, and its id is the tool call id. The
  turn stays open while the model polls with `sleep`. The plugin maps the item to a `request.opened` with `kind: 'question'`,
  `responseMode: 'message'`, request id `item:<itemId>` and questions `{ id: 'q1', …, question: title, options: [{ label }],
  allowCustom: true }`. The host shows a card. Nothing waits on the answer, so the service sends it as an ordinary message (a
  `turn/steer` into the open turn, which ends the same turn; a new turn if the turn is gone). A question the Console cannot show
  as a card raises a `warn` notice, which becomes a status line, and does not fail silently. The frames were captured from the
  real app-server; `structured-codex-requests` and `structured-codex-restart` cover the mapping against the fake.
- Restart adoption. The app-server and its running turns outlive a backend restart. The instance writes down what the
  next backend needs, in the Console database through `PluginContext.meta` (`CodexRestartState`, `codex/restart-state.ts`):
  the questions it holds open (JSON-RPC id, thread, params), the turn each thread runs, and a cursor into the host's replay
  buffer (saved every 5 s while it moves and at each turn boundary; it belongs to one host process). A backend that
  expects a running host attaches with `attachOnly` and `sinceSeq: 0` (and opens the usual way only when there is nothing
  to attach to), reads the buffered lines before any thread is resumed (a question that arrived while nobody listened is recorded; an approval or elicitation that arrived is declined
  by id), and starts the client on the lines after them. `reattach(threadId)` then connects to a running host only and
  `thread/resume`s the thread; the session `adopt`s what it finds: `thread.status` and the newest turns
  (`thread/turns/list`) give the running turn, which becomes an adopted provider turn (events and its terminal are
  accepted; if no listing names it, the first event of an unknown turn on an active thread is taken as that turn), a turn
  that ended while nobody listened is reported once, and a recorded question is held again only while the thread says it
  waits on user input (`waitingOnUserInput`). It is answered by id over the same relayed stdin (`replyToServerRequest`),
  because the app-server keeps waiting for the reply to that JSON-RPC id. A wait that no record explains cannot be
  answered; a notice tells the person to Stop. `dispose('shutdown')` leaves held questions held (answering them with
  nothing would race the socket closing). An adopted turn starts with the commands the thread is running: adoption reads
  `thread/backgroundTerminals/list` (item id to process id) and tracks on the adopted turn every live terminal that the
  plugin's ownership record (`structured-codex-commands`, written from `item/started`) does not assign to another turn, so
  Stop ends them as it ends the commands it saw start and leaves an earlier turn's terminal alone (Codex does not end a
  turn's command on `turn/interrupt` by itself).
  `thread/items/list` is only a secondary source, because codex-cli 0.164.0 never lists a running command there
  (`docs/research/codex-app-server-2026-10-26/background-terminals-probe.md`; the proof run of 2026-10-27 02:53 UTC on
  `59fde29` failed k2 for that reason before this fix). While adoption waits for the turn listing the session keeps at most
  4096 thread notifications but always keeps the turn, thread-status and server-request frames. A turn the listing does
  not name is marked unidentified: the manager keeps the row working, a send is refused as a turn in progress, and Stop
  re-lists the turns and interrupts the one running. A host that is unreachable at adoption is reported busy
  (`TransportBusyError`) and the row is left alone for up to 10 minutes; a reattach whose handshake check times out
  disconnects instead of terminating the shared app-server.
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

## Grok plugin (`apps/server/src/providers/transport/grok/`)

Added 2026-11-01, branch `feature/grok-and-start`. Grok Build (`grok` 1.0.70, signed in with the grok.com subscription) is
the third provider and the first ACP agent in the lane. It runs on the structured transport only. What the plugin relies on was
checked against the real CLI on 2026-11-01 with scratch sessions; the stand-in used by the tests (`test/helpers/fake-grok.mjs`)
reproduces those shapes.

**Process.** `grok agent --always-approve [--model M] [--reasoning-effort E] stdio`, started through the session host relay
with host id `grok-<conversationId>` in the project directory. One process per conversation (`processModel: 'per-session'`).
The command line a conversation was launched with is recorded in plugin meta (`grok-launch:<conversationId>`) because the host
is keyed by it; the model on the command line is only the starting model. The environment drops everything that names the
starting session (`CLAUDECODE`, `CLAUDE_CODE_*`, `TMUX`, `CODEX_THREAD_ID`, `AGENT_CONSOLE_*`, `AGENT_COORD_*`, `NODE_OPTIONS`,
`DEBUG`) and adds the conversation's own `AGENT_CONSOLE_SESSION_ID`; Grok loads the Claude hooks, so the coordination hook
registers the process as `grok` as before.

**Protocol (ACP, JSON-RPC 2.0 on stdio, newline framing).**

| Console action | ACP | Notes |
| --- | --- | --- |
| start | `initialize`, `session/new {cwd, mcpServers, _meta: {yoloMode: true, rules?}}` | Grok returns the session id; the models and the current model and effort are in the reply. `mcpServers` carries this conversation's coordination MCP server (ACP's list of `{name, command, args, env: [{name, value}]}`); `_meta.rules` carries a grant's authority text. |
| resume, no process left | `initialize`, `_x.ai/sessions/list`, `session/load {sessionId, cwd, mcpServers}` | `session/load` streams the saved history back as `session/update` notifications before it answers; the plugin drops them. The saved model and effort are restored. An unknown id answers `-32603` with `FS_NOT_FOUND`, which becomes `ResumeFailedError`. |
| resume, process survived | attach-only connect, `initialize` again, `_x.ai/sessions/list` | The roster says whether the session is resident and whether its `activity` is `working`. A working session becomes an adopted turn. See below. |
| send | `session/prompt {sessionId, prompt: [image blocks..., text]}` | Stays open for the whole turn. Streamed `session/update`: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`; Grok's `_x.ai/session_notification` carries `turn_completed {stop_reason, usage}`. The answer is `{stopReason}`: `end_turn`, `cancelled`, `refusal`, `max_tokens`, `max_turn_requests`. |
| switch model or effort | `session/set_config_option {sessionId, configId: 'model' \| 'reasoning_effort', value}` | `value` is a plain string (an object is rejected). Applied at once and kept in the saved session. Sent before the prompt, model first, only when it differs from what the session runs on; an unknown model is a definite refusal (`SendRejectedError`). |
| Stop | `session/cancel` (notification) | Grok ends the turn with `stopReason: 'cancelled'` and the session takes the next prompt. If no answer comes within 10 seconds the turn is closed locally as interrupted. |

**Events.** `session.native` (the session id, and the `updates.jsonl` path), `session.state ready`, `turn.started`
(`origin: 'user'` for a prompt the Console sent; `origin: 'provider'` for content Grok produces by itself, a background task
waking it), `item.completed` (one per block of streamed text, closed when the kind of block changes, and one per finished tool
call; chunks are not reported one by one), `usage.updated` (context fill from Grok's token total and the model's context
window), `turn.terminal` exactly once per turn (whichever of the prompt answer and `turn_completed` comes first), `notice`
(output limit, model-call retries). `request.opened` is raised for an ACP `session/request_permission`; the host has no approval
UI and declines it, which the plugin answers as `cancelled`. `hasBackgroundWork()` follows `task_backgrounded`, `task_completed`
and `background_tasks`.

**Capabilities.** `processModel: 'per-session'`, `nativeIds: 'server-allocated'`, `steer: 'none'` (a second prompt sent mid-turn
would queue inside Grok behind the running one, so the Console keeps it in its own queue and sends it when the turn ends),
`interrupt: 'terminal-follows'`, `images: true`, `modelSwitch: 'next-turn'`.

**After a backend restart.** The process keeps running behind its session host, so the new backend does not start another:
`reattach` (startup) and `resume` (first use) connect attach-only with the recorded argv, send a repeated `initialize`
(Grok accepts it) and read the roster. A session that is `working` becomes the adopted turn (`TransportSession.activeTurn`),
under the turn id the earlier backend recorded in `grok-turn:<conversationId>`; its end arrives as `turn_completed` on the new
connection, or as the JSON-RPC answer to the old `session/prompt`, which no request of the new client is waiting for and which
`JsonRpcClient` hands to `onUnmatchedResponse`. A request id that is larger than any used before (the clock) keeps that late
answer from ever matching a new request. A survivor whose roster cannot be read is taken for busy when a turn record exists. A
host that runs but does not answer is left alone (`TransportBusyError`); after five minutes of consecutive silence an ordinary
open ends it and starts a new process, as the other plugins do. When the process is gone, `resume` starts a new one and runs
`session/load`.

**Past conversations.** Grok saves each conversation under `<grok home>/sessions/<URL-encoded working directory>/<session id>/`
(`summary.json` with the directory, title and model; `updates.jsonl`, the ACP update stream). `GrokProvider` lists the ones
saved for a project's paths (the directory in `summary.json` decides, so a past Grok chat can be opened and bound like a past
Codex chat; `session/load` resumes it), and `parseGrokConversationFile` joins the chunks into messages. This works without a
running Grok. The index watches the sessions folder for new conversations.

**Limits and open points.** The turn that was running while the backend was down is found from the roster only when Grok still
holds the session in memory; a turn that ended while no backend was connected leaves no trace except the saved history. Grok
under `--always-approve` raised no permission request in any run; the decline path is covered by the stand-in only. Whether Grok
accepts a second `initialize` on every future version is unverified beyond 1.0.70 (a refusal would be treated as a failed
handshake). Grok's weekly usage is read by workflow_optimizer (`wo quota`) from the CLI's own `_x.ai/billing` call; the Console
does not read it.

**Verification (2026-11-01).** `test/structured-grok-plugin.test.ts` (20 tests: launch, event mapping, profile switch, images,
cancel, errors, permission, process death, `session/load`, adoption of an idle and a running survivor behind a real session
host), `grok-provider.test.ts`, `start-conversation.test.ts`, `model-profiles.test.ts` and the Auto tests. One manual run
against the real CLI: see the report of the work for the transcript.

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
| `verifyNativeProcessEpoch` (969), `providerTurnIsWorking` (988) | Epoch = `structured-epoch:<sessionId>`. A transcript run older than the epoch is never recorded as a response. `turn.started`/`turn.terminal` events drive `isWorking` directly through `syncSessionWorkingState`. For a structured row `providerTurnIsWorking` is `turnRunning(session)` (a named or a still unnamed turn on a loaded thread; a thread that is not loaded runs nothing), so the transcript run state is never consulted. Without this, a rollout whose last record is an unfinished turn would read as working after a restart or an idle sleep, and would block peer and continuation wakes. |
| `reconcileSessions`, `refreshStructuredSessionState` | A structured thread loads on first use, not at boot, except survivors: the first pass ends session hosts no conversation owns, then `reattachSurvivors` adopts every awake per-session row and every shared-process (Codex) row still marked working (see below). The same lookup runs before loss handling on every path that loads a working row (screen poll, queued message, wake), so a poll that comes before the first pass cannot declare a surviving turn lost. Only a row the provider has no turn for loses it with the connection (status line, `isWorking=false`, and RunRecovery `process_exited` for unattended work). A row in status `error` or `starting` is restored, as on tmux (`starting` is a restore that a crash cut off). When the thread is not loaded and the row has a run failure or unfinished unattended work, the refresh branch calls `watchSessionOutput`, which attaches the run monitor, so RunRecovery re-arms a scheduled retry from the persisted budget and the rollout. |
| `suspendIdleSession` (1343), `suspendPressureIdleSession` (1261), `suspensionBlockReason` (3371), `suspendSession`/`resumeSession` (3421) | Idle: `unload` and set `idleSuspendedAt`; the row's run monitor is kept. Pressure: skipped for rows on a `shared` process (it cannot be suspended per thread); for a `per-session` plugin it ends the idle conversation's process and sets `pressureSuspendedAt` (lane C2). Manual suspend: `unload` and set `manualSuspendedAt`; resume: `ensureLoaded`. Block reasons: `turn_running`, `background_work`, `queued_input`. |
| `reconcileSessions`, `defaultTransportFor`, `migrateTmuxRowToStructured` (lane C2) | While `structuredSessions.defaultTransport` is `structured`, each restorable tmux row of a provider whose lane is on is classified and, when idle or dead, flipped to a sleeping structured row (`BoundSessionsRepo.setTransport`); a live tmux session moves only once idle sleep would stop it (idle window and restore grace), and is stopped like idle sleep and confirmed dead first. `structuredMigrationReport()` is the dry run, served at `GET /api/sessions/structured-migration`. A bind that names no transport takes `defaultTransportFor(provider)`. See `docs/structured-cutover.md`. |
| `releaseSessionInternal` (3481) | `interrupt` if a turn is active, then `unload`, then `ended`; delete the runtime dir as today. |
| `drainModelProfileRequestInternal` (3078), `applyModelProfileRequest` (3226) | No restart. Store the profile and complete the request immediately when idle; when a turn is running (or one starts during the switch) put the request back to `queued` with `turn_running`, and the next `turn.terminal` re-runs it. The next `sendTurn` carries `model`/`effort`, which the session manager resolves from the model catalog (`wo profiles --json`) for High, Medium and Low, or from the Auto decision stored on the row. **Auto:** `routeAutoBeforeTurn` runs before a person's message (typed, queued or the opening prompt) starts a turn on a row whose profile is `auto` and whose `autoRoute.routePending` is set: it asks `wo route`, then writes an `applying` request that carries the chosen target and the decision and completes it through the same `completeStructuredModelProfile`, so a restart between the steps applies the same choice. A running turn is never switched, so a steered message is not routed. |
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
start(input: { sessionId; provider; cwd; target?; model?; effort? }): Promise<{ nativeSessionId; transcriptPath?; pid? }>   // target = { model, effort } resolved from the row's profile
resume(session, cwd): Promise<{ transcriptPath?; pid? }>
ensureLoaded(session, cwd?): Promise<'loaded' | 'unavailable'>
submitHuman(session, record: { requestId; text }, images?): Promise<{ turnId; mode: 'turn' | 'steer' }>
interrupt(session): Promise<{ outcome: 'interrupted' | 'idle'; cancelledSteerIds: string[] }>
deliverAutomatic(session, prompt): Promise<{ status: 'submitted' | 'deferred' | 'failed'; reason?; turnId? }>
respond(session, requestId, response: RequestResponse): Promise<{ message?: string }>   // one answer per question; throws StructuredRequestNotPendingError
setTarget(session, target?: { model; effort }): Promise<'applied' | 'deferred'>   // the model and effort the next turns carry; undefined keeps the current one
unload(session): Promise<void>
release(session): Promise<void>
endConversation(session): Promise<void>                                       // end the conversation's session host and launch record without loading it
sweepOrphanHosts(owned: (sessionId: string) => boolean): Promise<string[]>   // startup: end per-session hosts no restorable row owns
alive(session): boolean
screen(session): SessionScreen
reattachSurvivors(candidates: Array<{ session; cwd }>): Promise<string[]>   // startup, per-session plugins only
hasBackgroundWork(session): boolean
```

Per-session behavior of the service (lane C5 and the round 1 fixes, on top of lane C2):

- **Survivors.** A provider process can outlive a backend restart behind its session host, and the service loads rows on
  first use, so nothing would own it: idle sleep, pressure suspension and release see an unloaded row. The first
  `reconcileSessions` pass therefore ends the orphan hosts (below) and hands the candidate rows to `reattachSurvivors`,
  which calls the plugin's `reattach`. Candidates: every awake (bound, not suspended) row of a per-session plugin, and
  the rows of a shared plugin (Codex) that are still marked working, because resuming a thread loads it into the shared
  process and only a thread that may be running a turn needs that. A process found becomes a loaded session (new epoch,
  status line "Reconnected to the running agent process") and is reaped like any other. A turn it reports through
  `activeTurn` (or an `adopted` `turn.started`) is the session's active turn: the row stays working, recency does not
  move, Stop reaches the provider, and the terminal ends it. A row with no survivor stays unloaded and resumes on next use;
  `reattach` never starts a process. A use of the conversation waits for its own lookup (`ensureLoaded`). Claude's
  `reattach` connects with `attachOnly`, requires the recorded launch to name this native id and the host to run exactly
  that command line, refuses a session another live process holds in the CLI's registry (only the host's own child may),
  then repeats `initialize`: the reply carries the requests still open and `session_state`, and a `session_state` other
  than `idle` makes the session adopt a running turn. A process the earlier backend started but never spoke to is handshaken
  as a new launch, with the host replaying its SessionStart hook frames. A host that runs but does not answer in time is
  left alone and reported as unavailable; the next use tries again. A shared row that is working but whose thread runs no
  turn loses the turn the way a dead connection does.
- **Orphan hosts.** `sweepOrphanHosts` runs once at the first pass, before adoption, and ends the per-session hosts whose
  conversation has no restorable structured row (with their launch records); the shared Codex host is never swept.
  `endConversation` does the same for one conversation when `release` or `unload` finds it not loaded (a survivor nobody
  adopted), so idle sleep ends the process and not only the row marker.
- **Default model for profile-less Claude rows.** A per-session Claude row with no cost profile (a migrated tmux row, a
  history bind) and no model of its own from a granted launch resumes with effort `medium` and no model, what the tmux
  resume template gives it, on the resume and on every turn. Nothing is stored on the row. Codex keeps the model its
  shared process was configured with.
- **Background work.** `hasBackgroundWork(session)` reads the transport's flag, bounded: it is ignored once the transport
  has sent no event for four hours (`BACKGROUND_WORK_STALE_MS`). `suspensionBlockReason` returns `background_work` for
  idle sleep, pressure suspension and manual suspend, as the tmux path refuses while its screen shows background work.
  The Claude session derives the flag from `system/background_tasks_changed` (the full live set, replaced on every
  frame) plus `task_started`, `task_notification` and terminal `task_updated` frames; ambient tasks and foreground tasks
  do not count, and a late frame of an earlier run of a resumed task is ignored. After a reattach the plugin waits up to
  1 s for the snapshot the CLI sends behind the reply to the repeated `initialize`, so the idle decision that follows never
  reads an empty set.
- **Stop and queued steers.** `interrupt` returns the steers the provider dropped with the turn (`cancelledSteerIds`). The
  manager marks each queued message `failed` with "cancelled by Stop", and adds one status line when a dropped message had
  no journal entry.
- **Questions.** `respond` lets exactly one answer through per question. A question stays on the row until it is answered
  or the provider withdraws it; an answer for a withdrawn or unknown request is `StructuredRequestNotPendingError` and the
  route answers 404. A `message`-mode question stays open after its turn ends and is answered with a normal message that
  names the question (a steer while the turn still runs, a new turn otherwise). Questions of an earlier backend process are
  deleted at boot and come back only through the plugin's re-adoption (`replay`), without a second status line or push.
  A question the Console cannot show gets the fixed log line "Declined a question the Console cannot show".

`start` takes no opening prompt: `SessionManager` journals the prompt and sends it as the first turn after
`start` returns, and rolls the bind back if that send fails.

The service subscribes to each session's event stream and calls SM-provided callbacks:
`onTurnStarted` (`adopted`: a turn already running when the session attached marks the row working without moving
recency), `onItemCompleted` (live only: `lastOutputAt = lastActivityAt = now`),
`onTurnTerminal` (completed: `lastResponseAt`; failed: RunRecovery `changed`), `onRequest` (a request declined at
once: a `status` event, with a fixed line for a question), `onQuestion` (a question is waiting; `announced` suppresses
the repeat status line and push), `onRequestsChanged`, `onSessionState` (error: RunRecovery `processExited`) and
`appendStatus`.

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
  In slice 1 a granted launch always created a tmux session; since lane C2 a bind that names no transport takes
  `structuredSessions.defaultTransport`, except a launch that carries command-line flags, which stays on tmux (see
  `docs/structured-cutover.md`). The memory gate stays as is. Concurrency counting keeps using `pid` (the app-server pid is set on structured rows).
- `scripts/worktree-sweep.mjs`: unchanged; a structured row's checkout looks "process running" while the
  shared process lives, which is the conservative outcome.

## Routes and web

- `POST /api/conversations/:projectSlug/:provider/new/bind` accepts `{ transport?: 'tmux' |
  'structured' }`. Omitted, it takes `structuredSessions.defaultTransport` for a provider whose lane is on, else
  tmux. An explicit structured request is refused with 400 unless `structuredSessions.<provider>.enabled`.
- `POST .../:conversationRef/bind` (history resume) accepts the same field; an explicit structured resume of a
  conversation that another live binding owns is refused like today (one restorable owner). A request that names no
  transport and finds a tmux binding returns that binding.
- `GET /api/sessions/structured-migration` is the read-only dry run of moving tmux conversations to the structured
  transport (authenticated).
- `GET /api/projects` tree response gains `structuredProviders`.
- `GET /api/sessions/:id/screen` returns the synthesized screen for structured rows.
  `GET /api/sessions/:id/raw-output` returns 404 for structured rows.
- Web: New Chat shows a second action per advertised provider, "Codex (app-server)" and "Claude (headless)".
  `ConversationPane.tsx` for `boundSession.transport === 'structured'`: hide Text Bypass, the
  arrow/Backspace/Tab keys, the native-selection affordances and the terminal panel; keep Send, Esc/Stop,
  model profile controls, `QueuedInputNotice`, `RunFailureNotice`, suspend and close. A small
  "app-server" badge next to the status. A row with pending questions shows a `PendingQuestionCard` (options, a typed
  answer) that posts to `POST /api/sessions/:id/requests/:requestId`. `useConversationData.ts` keeps polling `/screen` (cheap
  synthesized response) so older code paths stay valid.

## Not in slice 1

- Streaming assistant deltas into the pane (needs a new event-log record type and a merge rule).
- Approval or question UI (requests are declined and logged). Questions were built in the cutover (cards, answer
  route); approvals are still declined.
- Image attachments on structured sessions (route refuses with a clear error). Built in the cutover for both providers.
- Claude Agent SDK plugin and ACP plugin. The contract above is written for them; a contract test
  suite runs the fake plugin through the same host paths so nothing in the host is Codex-shaped. The Claude plugin was
  built in the cutover on the CLI's stream-json protocol, not the SDK package.
- Pressure suspension of rows on a shared process (per-session plugins are suspended since lane C2) and restart of an
  idle shared process under memory pressure.
- Granted launches of structured sessions: not in slice 1; built in lane C2 (a granted launch takes the default transport).
- Per-thread MCP environment injection.

## Verification

- Unit tests (Vitest, `apps/server/test/structured-*.test.ts`): plugin contract with the fake plugin;
  Codex JSON-RPC client against a scripted fake app-server (`test/helpers/fake-app-server.mjs`) over
  stdio; SM seams with the fake plugin (bind, resume, submit, steer, interrupt, wake delivery,
  recovery submit, model profile, idle sleep and restore, release, synthesized screen, 409 paths);
  routes; config; schema migration; coordination register resolution. The review fixes added
  `structured-session-host` (the real host program against a scripted child: record, protocol, replay and gap, terminate order, detached survival, the factory's reconnect and reap), `structured-codex-process-lifetime` (start-ticks identity, host launch, ending a recorded app-server left without its host, launcher process groups),
  `structured-session-restart` (a turn cut by a backend restart, scheduled recovery re-armed, a half-restored
  row, not-sent delivery, a turn id that runs again), `tmux-client-structured-guard` and
  `structured-session-env`, and extended the plugin, input, recovery, coordination and wake suites. The round-2
  fixes added launcher-shaped process-group tests (`test/helpers/fake-launcher.mjs`), the MCP argv and context
  tests, not-sent steer and recovery tests, the refused-interrupt tests, the one-line status reason tests (the
  fake app-server gained `exitAtStart`), the asleep screen test and fake-plugin error-type tests.
  The cutover and its review round added `structured-codex-restart` (the Codex plugin across a backend restart: adopted
  turns, held questions, host replay, the handler limit, message-mode questions), `structured-session-codex-restart`
  (the same through the real manager, the real plugin and the real session host) and `structured-session-adoption`
  (the manager side of adoption, Stop and queued steers, withdrawn questions, repeated questions, message-mode
  questions), among others; the full list is in `docs/agent_docs/running_tests.md`.
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
  session identity, its argv carries the coordination MCP overrides that the product adds, and the session host
  record `<runtime>/structured/hosts/codex.json` names the same pid, its process group and start times that match
  `/proc`, with the app-server a child of the host); c. model profile `low` before the first turn, with no restart;
  d. first message and reply; e. rollout file, index transcript path and the first turn's `turn_context`
  carrying the low model; f. hook registration with the thread id and an MCP `status` call from inside a turn,
  with an `agent-coord.mjs mcp` process of the isolated runtime seen during that turn (the MCP server is this
  Console's, not the live one's); g. a message sent mid-turn is delivered as a steer; h. Escape interrupts a
  running turn (`turn_aborted`), and the counting shell command, found by a unique marker in its command line, is
  running before Stop and gone after it; i. manual sleep (refused while the assignment is `active`, allowed
  after a completed turn): the screen is `idle` while loaded, `asleep` on the event stream after the unload
  (the poll then has no screen), and `idle` again with a new `structured-epoch` after the restore, then a reply
  on the same app-server pid; j. profile `medium` reaches the provider on the next turn, then back to `low`;
  k. graceful backend restart: the host and the app-server (every process of its group) survive the shutdown,
  the new backend reconnects, and the next turn on the same conversation completes on the same app-server pid,
  with the host record unchanged and still matching `/proc` and the host holding exactly one provider process;
  l. release, then the host and app-server still run after backend shutdown (by design), and once the proof ends
  the host (`terminateHost`) no process of the proof remains: nothing whose command line holds the temp root and
  nothing whose environment carries the isolated `AGENT_COORD_RUNTIME` (app-server, native child, hooks, MCP
  servers, model commands). The profile
  switch runs before the first turn
  because the medium profile's model is rate limited on this host at times: Codex then waits out a 429
  backoff of minutes and the turn only looks hung (the evidence lists such retries from Codex's own log).
  Step j therefore waits for the medium turn to start, not to answer.

## Verification evidence

This section is the slice 1 record (12 steps). The proof has since grown to 16 steps (a question h2, an image h3, a
restart during a running turn k2, a screenshot-sized image l, release m); the run on the cutover build is in
`docs/structured-cutover.md`, "Verification evidence".

Real Codex proof, 2026-10-26, `codex-cli 0.164.0`. `node scripts/prove-structured-codex.mjs --run` passed
12 of 12 steps on the round-2 fixes (the working tree on top of `4f62494`, 78 seconds; evidence copied to
`docs/research/codex-app-server-2026-10-26/proof-run-2026-10-26T08-56-32Z.json`), on the round-1 fixed build
(`ca41634`, 75 seconds; `proof-run-2026-10-26T08-22-18Z.json`) and, before the fixes, on `be43958` plus the env
plumbing in two consecutive runs (57 and 64 seconds; one copied to `proof-run-2026-10-26T07-51-45Z.json`). Each run
also writes an untracked copy under `test-results/structured-codex-proof/`. The table shows the round-2 run; the
earlier runs reported the same values for steps that did not change, with other ids and pids. After the run no
`codex app-server` process was left. This host's Codex is the npm launcher: the recorded pid led a process group
of two (launcher and native server).

Automated suites on the final commit `73521dd` (`env -u NODE_ENV`): server `vitest run` 1958 passed, 2 skipped
(the opt-in real-Codex handshake tests), 3 failed; the three failures are the same timing-sensitive Claude
tmux tests that fail on untouched `main` on this host (`claude-ready-lifecycle` twice, `claude-run-state`
once). Web `vitest run` 198 passed. `npm run typecheck` and `npm run build` clean. The same three failures
and no others appeared in the full runs on `be43958` and `ca41634`. The round-2 proof run
(`proof-run-2026-10-26T08-56-32Z.json`) passed 12 of 12 on the final code.

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

After this run the session host relay (lane C0) changed steps b, k and l: b reads the host record instead of the
instance meta, k asserts that the app-server pid, its start time and the host are the same after the backend
restart and that the host holds exactly one provider process, and l ends the host explicitly before it checks that
nothing of the proof remains. The run on the relay code (2026-10-26, working tree on top of `8fb1510`, evidence
`test-results/structured-codex-proof/2026-10-26T15-59-04-296Z.json`, untracked) passed 12 of 12 with the same
app-server pid before and after the restart.

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
- The app-server runs behind a session host (started with a parent death signal relative to the host); a restarted backend reconnects to the running app-server instead of starting a second one, and a recorded app-server without its host is ended before a new host starts.
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

- Granted launches always create tmux sessions. `launch_session` has no `transport` field. (Closed in lane C2: a bind that
  names no transport takes the default transport.)
- RunRecovery ignores the `retryable` flag on the `thread_closed` failure. It retries only `server_overloaded`,
  `server_unavailable` and `process_exited`.
- A steer the server refused for a reason other than losing the race shows "Submission could not be confirmed".
- Whether `codex app-server` exits on stdin EOF while a turn runs is unverified (the host ends it with EOF, then
  SIGTERM, then SIGKILL to its group, so the order does not depend on the answer). A backend crash, as opposed to a
  graceful restart, is shown by a unit test that kills the process that started a host and finds the host and its
  child running; the proof script restarts gracefully only. A proof step that runs the backend as a child process,
  SIGKILLs it during the counting command and asserts that the turn completes on the same app-server is a follow-up.
- When the launcher itself is already dead and its native child still runs (for example the launcher was killed
  with SIGKILL), the stale reap cannot check the group's identity and leaves that child alone.
- The shared app-server stays alive after the last thread is released, and after backend shutdown: it ends only when
  its host is told to terminate (`terminateHost`) or the command line it was started with changes.

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
4. ACP plugin: Grok is done (see "Grok plugin"). Mistral Vibe and other ACP agents could reuse the same JSON-RPC client and
   the roster-free parts of the plugin; each needs its own failure classification.
5. Retire the tmux path per provider once the structured path has carried real work for a while; then
   supersede `design/extension-agent-lane`.
