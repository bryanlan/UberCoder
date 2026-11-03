import type { ProviderId } from '@agent-console/shared';

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
  /** Apply effort to a running session. A request already captured by the provider may retain its previous settings. */
  setEffort?(effort: string, turnId?: string): Promise<void>;
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
   * subagent). Idle sleep and memory pressure leave such a process alone, since ending it would kill that work.
   * Optional: a plugin that cannot tell leaves it out and the host treats the session as having none.
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
   * (this Console's runtime directory, its helper script and the conversation's session id).
   */
  consoleIdentity?: { sessionId: string; runtimeDir: string; helperPath: string };
  /** The standing-authority text of a session a grant launched, appended to the provider's system prompt. */
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
   * tool calls reach this Console and not whichever one the provider's own config names.
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
