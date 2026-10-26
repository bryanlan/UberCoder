// One Codex thread as a `TransportSession`. The turn bookkeeping (adopting a `turn/started` before the
// `turn/start` response, interrupt and steer races) follows patterns in T3 Code's CodexAdapterV2.ts
// (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md). The instance (app-server-instance.ts) owns the process and the
// connection, routes every thread-scoped notification and server request here by `threadId`, and creates
// sessions from `thread/start` and `thread/resume`.
//
// Invariants kept in this file:
//   - `turn.terminal` fires exactly once per turn (`finalizeTurn` is the only emitter and checks the record);
//   - the active-turn pointer is cleared before the terminal event is pushed, so a consumer that reacts by
//     calling `sendTurn` is not told that the previous turn is still running;
//   - events that arrive for a turn before the `turn/start` response is processed are adopted (turn/started)
//     or buffered by turn id (everything else);
//   - every server request gets an answer.

import { randomUUID } from 'node:crypto';
import {
  NotSentError,
  PreviousTurnActiveError,
  TransportUnavailableError,
  TurnNotActiveError,
  type OpenOptions,
  type ProviderFailure,
  type TransportCapabilities,
  type TransportEvent,
  type TransportSession,
  type TurnInput,
  type RequestResponse,
} from '../types.js';
import { classifyCodexFailure, interruptTurnGone, mergeTurnErrors, parseCodexRetryProgress, steerLostRace } from './errors.js';
import { JsonRpcExitError, JsonRpcRequestError, JsonRpcSpawnError, type JsonRpcClient } from './jsonrpc.js';
import {
  callCodex,
  type CodexApprovalPolicy,
  type CodexNotificationMap,
  type CodexSandboxMode,
  type CodexSandboxPolicy,
  type CodexServerRequestMap,
  type CodexThreadItem,
  type CodexTurn,
  type CodexTurnError,
  type CodexTurnStatus,
  type CodexUserInput,
  type ThreadBackgroundTerminalsListResponse,
  type TurnStartParams,
} from './protocol.js';
import { redactFreeText } from './redact.js';
import {
  accumulateTurnTokenUsage,
  completeTurnTokenUsage,
  contextFill,
  makeTurnTokenUsageState,
  rateLimitsToWindows,
  usageEventWindows,
  type CodexRateLimitSnapshot,
} from './usage.js';

export const CODEX_CAPABILITIES: TransportCapabilities = {
  processModel: 'shared',
  nativeIds: 'server-allocated',
  resume: 'reattach',
  steer: 'native',
  interrupt: 'terminal-follows',
  images: false,
  enforcement: 'native',
  modelSwitch: 'next-turn',
};

export interface CodexTimings {
  /** Default for requests that have no more specific limit. */
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  /** `probe()` finishes within this deadline. */
  probeDeadlineMs: number;
  /** After `turn/interrupt` is accepted, wait this long for `turn/completed` before closing the turn locally. */
  interruptGraceMs: number;
  /** An interrupt or steer for a queued turn waits this long for `turn/started` first. */
  queuedStartWaitMs: number;
  closeGraceMs: number;
  termGraceMs: number;
  /** Before the first spawn, a process left by a crashed backend gets SIGTERM and this long to end before SIGKILL. */
  staleTermGraceMs: number;
}

export const DEFAULT_TIMINGS: CodexTimings = {
  requestTimeoutMs: 60_000,
  initializeTimeoutMs: 30_000,
  probeDeadlineMs: 20_000,
  interruptGraceMs: 10_000,
  queuedStartWaitMs: 10_000,
  closeGraceMs: 5_000,
  termGraceMs: 5_000,
  staleTermGraceMs: 5_000,
};

export interface CodexLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  debug?(fields: object, message: string): void;
}

/** What a session needs from the instance that owns its process. */
export interface CodexSessionHost {
  readonly log: CodexLogger;
  readonly timings: CodexTimings;
  /** The live connection. Throws {@link TransportUnavailableError} when the process is gone. */
  client(): JsonRpcClient;
  rateLimits(): CodexRateLimitSnapshot | undefined;
  /** The session ended: drop it from the routing table. */
  release(session: CodexAppServerSession): void;
}

export interface CodexSessionInit {
  threadId: string;
  transcriptPath: string | null;
  cwd: string;
  policy: OpenOptions['policy'];
  host: CodexSessionHost;
}

// ---------------------------------------------------------------------------------------------------------
// Policy mapping

export function approvalPolicyFor(policy: OpenOptions['policy']): CodexApprovalPolicy {
  return policy.approvals === 'never' ? 'never' : 'on-request';
}

/** `thread/start` and `thread/resume` take the kebab-case sandbox mode. */
export function sandboxModeFor(policy: OpenOptions['policy']): CodexSandboxMode {
  return policy.sandbox === 'full-access' ? 'danger-full-access' : policy.sandbox;
}

/** `turn/start` takes the tagged sandbox policy. */
export function sandboxPolicyFor(policy: OpenOptions['policy'], cwd: string): CodexSandboxPolicy {
  switch (policy.sandbox) {
    case 'full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
}

/**
 * Overrides persist on the thread, so the policy is sent again with every turn. `summary: 'detailed'` is
 * always sent because model catalogues can default summaries to `none`; the reviewer is always explicit
 * because leaving it out on a resumed thread keeps the previous one.
 */
export function buildTurnStartParams(threadId: string, input: TurnInput, policy: OpenOptions['policy'], cwd: string, clientMessageId: string): TurnStartParams {
  return {
    threadId,
    input: textInput(input),
    clientUserMessageId: clientMessageId,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    summary: 'detailed',
    approvalPolicy: approvalPolicyFor(policy),
    approvalsReviewer: 'user',
    sandboxPolicy: sandboxPolicyFor(policy, cwd),
  };
}

function textInput(input: TurnInput): CodexUserInput[] {
  if (input.images && input.images.length > 0) {
    throw new Error('Codex app-server sessions do not accept image input yet.');
  }
  return [{ type: 'text', text: input.text }];
}

// ---------------------------------------------------------------------------------------------------------
// Item mapping

type ItemKind = Extract<TransportEvent, { type: 'item.completed' }>['kind'];

export function itemKind(item: CodexThreadItem): ItemKind {
  switch (item.type) {
    case 'agentMessage':
      return 'assistant';
    case 'reasoning':
      return 'reasoning';
    case 'commandExecution':
      return 'command';
    case 'fileChange':
      return 'file_change';
    case 'mcpToolCall':
      return 'mcp';
    case 'webSearch':
      return 'search';
    default:
      return 'other';
  }
}

function shorten(text: string, max = 120): string {
  const clean = redactFreeText(text.replace(/\s+/g, ' ').trim(), max + 1);
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** Short label for the item. Message bodies are never part of the event stream, so assistant text has none. */
export function itemTitle(item: CodexThreadItem): string | undefined {
  switch (item.type) {
    case 'agentMessage':
    case 'reasoning':
      return undefined;
    case 'commandExecution':
      return typeof item.command === 'string' ? shorten(item.command) : undefined;
    case 'mcpToolCall':
      return `${String(item.server)}/${String(item.tool)}`;
    case 'webSearch':
      return typeof item.query === 'string' ? shorten(item.query) : undefined;
    case 'fileChange':
      return Array.isArray(item.changes) ? shorten(item.changes.map((change) => change.path).join(', ')) : undefined;
    default:
      // plan, contextCompaction, subagent and review items.
      return item.type;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Server requests

type RequestKind = Extract<TransportEvent, { type: 'request.opened' }>['kind'];

/**
 * Slice 1 has no approval UI: every server request that still arrives under the `never` policy is declined.
 * Each method has its own answer shape (the permissions request has no `decision`).
 */
export function declinedServerRequest(method: string, params: unknown): { kind: RequestKind; summary: string; result: unknown } {
  const request = (isRecord(params) ? params : {}) as Record<string, unknown>;
  switch (method as keyof CodexServerRequestMap) {
    case 'item/tool/requestUserInput': {
      const first = Array.isArray(request.questions) ? (request.questions[0] as { header?: unknown; question?: unknown } | undefined) : undefined;
      const text = [asString(first?.header), asString(first?.question)].filter(Boolean).join(': ');
      return { kind: 'question', summary: shorten(text || 'Codex asked a question.'), result: { answers: {} } };
    }
    case 'mcpServer/elicitation/request':
      return {
        kind: 'mcp',
        summary: shorten(`${asString(request.serverName) ?? 'An MCP server'}: ${asString(request.message) ?? asString(request.mode) ?? 'elicitation'}`),
        result: { action: 'decline', content: null, _meta: null },
      };
    case 'item/commandExecution/requestApproval':
      return { kind: 'command', summary: shorten(asString(request.command) ?? asString(request.reason) ?? 'Command approval'), result: { decision: 'decline' } };
    case 'item/fileChange/requestApproval':
      return { kind: 'file_change', summary: shorten(asString(request.reason) ?? asString(request.grantRoot) ?? 'File change approval'), result: { decision: 'decline' } };
    case 'item/permissions/requestApproval':
      // An empty grant approves nothing.
      return { kind: 'permission', summary: shorten(asString(request.reason) ?? 'Permission approval'), result: { permissions: {}, scope: 'turn' } };
    default:
      throw new Error(`No answer is defined for server request ${method}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Event channel

/** Single-consumer async queue. Buffers until read; ends after the first `stopped` state. */
class EventChannel {
  private readonly queue: TransportEvent[] = [];
  private waiter: ((result: IteratorResult<TransportEvent>) => void) | undefined;
  private ended = false;
  private abandoned = false;
  private claimed = false;

  push(event: TransportEvent): void {
    if (this.ended || this.abandoned) return;
    if (event.type === 'session.state' && event.state === 'stopped') this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  iterable(): AsyncIterable<TransportEvent> {
    return { [Symbol.asyncIterator]: () => this.claim() };
  }

  private claim(): AsyncIterator<TransportEvent> {
    if (this.claimed) throw new Error('TransportSession.events has a single consumer.');
    this.claimed = true;
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.ended || this.abandoned) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<TransportEvent>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.abandoned = true;
        this.queue.length = 0;
        const resolve = this.waiter;
        this.waiter = undefined;
        resolve?.({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Turn bookkeeping

interface TurnRecord {
  id: string;
  origin: 'user' | 'provider';
  /** `turn.started` has been emitted. */
  started: boolean;
  /** The `turn/start` response said the turn is queued (`startedAt === null`). */
  queued: boolean;
  terminal: boolean;
  /** Set before `turn/interrupt` is sent so a `completed` that races it is reported as `interrupted`. */
  interrupt: { timer: NodeJS.Timeout | undefined } | null;
  /** The last `error { willRetry: false }` notification, merged into a failed terminal. */
  lastError: CodexTurnError | null;
  /** Running commands of this turn (item id -> process id), for terminating them after an interrupt. */
  commands: Map<string, string>;
  startedWaiters: Array<() => void>;
}

const MAX_FINISHED_TURNS = 256;
const MAX_EARLY_EVENTS_PER_TURN = 512;
const MAX_EARLY_TURNS = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Process or transport problems become `TransportUnavailableError`; an answer from the server stays as it is. */
export function toTransportError(error: unknown): Error {
  if (error instanceof JsonRpcExitError || error instanceof JsonRpcSpawnError) {
    const unavailable = new TransportUnavailableError(`The Codex app-server is not available: ${error.message}`);
    unavailable.cause = error;
    return unavailable;
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class CodexAppServerSession implements TransportSession {
  readonly nativeSessionId: string;
  readonly capabilities = CODEX_CAPABILITIES;
  readonly events: AsyncIterable<TransportEvent>;

  /** Turn-scoped notifications for turns this session never saw start (late events, subagent noise). */
  droppedTurnEvents = 0;

  private readonly channel = new EventChannel();
  private readonly host: CodexSessionHost;
  private readonly cwd: string;
  private readonly policy: OpenOptions['policy'];
  private path: string | null;
  private ended = false;
  private pendingStart: { adoptedTurnId: string | null } | null = null;
  private activeTurnId: string | null = null;
  private readonly turns = new Map<string, TurnRecord>();
  private readonly finishedTurnIds = new Set<string>();
  private readonly early = new Map<string, Array<{ method: string; params: unknown }>>();
  private readonly tokenUsage = makeTurnTokenUsageState();
  private readonly cleanupJobs = new Set<Promise<void>>();
  private threadStatus: string = 'idle';
  private firstTerminalSeen = false;
  private pathRefresh: Promise<string | undefined> | undefined;

  constructor(init: CodexSessionInit) {
    this.nativeSessionId = init.threadId;
    this.path = init.transcriptPath;
    this.cwd = init.cwd;
    this.policy = init.policy;
    this.host = init.host;
    this.events = this.channel.iterable();
  }

  get transcriptPath(): string | undefined {
    return this.path ?? undefined;
  }

  /** The id of the turn that has not reached its terminal event, if any. */
  get activeTurn(): string | null {
    return this.activeTurnId;
  }

  /** Called once by the instance after it registers the session: announces the native id and readiness. */
  announce(): void {
    this.channel.push({ type: 'session.native', nativeSessionId: this.nativeSessionId, ...(this.path ? { transcriptPath: this.path } : {}) });
    this.channel.push({ type: 'session.state', state: 'ready' });
  }

  // -------------------------------------------------------------------------------------------------------
  // TransportSession

  async sendTurn(input: TurnInput): Promise<{ turnId: string }> {
    if (this.ended) throw new NotSentError('The Codex session has ended.');
    if (this.activeTurnId !== null || this.pendingStart !== null) throw new PreviousTurnActiveError();
    const clientMessageId = input.clientMessageId ?? randomUUID();
    const params = buildTurnStartParams(this.nativeSessionId, input, this.policy, this.cwd, clientMessageId);
    let client: JsonRpcClient;
    try {
      client = this.host.client();
    } catch (error) {
      // The connection is gone before anything was written: the caller may queue the turn and try again.
      throw new NotSentError(error instanceof Error ? error.message : 'The Codex app-server is not running.');
    }
    this.pendingStart = { adoptedTurnId: null };
    try {
      // The response is applied synchronously, before the notifications queued right behind it.
      const response = await callCodex(client, 'turn/start', params, {
        timeoutMs: this.host.timings.requestTimeoutMs,
        onResult: (result) => this.onTurnStartResponse(result.turn),
      });
      return { turnId: response.turn.id };
    } catch (error) {
      this.pendingStart = null;
      this.early.clear();
      // A refusal before the frame was written is certain; anything after the write is uncertain.
      if (error instanceof JsonRpcExitError && !error.sent) throw new NotSentError(error.message);
      throw toTransportError(error);
    }
  }

  async steer(turnId: string, input: TurnInput): Promise<void> {
    // Failures before the frame is written are certain, as for `sendTurn`: the caller may queue the text and try again.
    if (this.ended) throw new NotSentError('The Codex session has ended.');
    const record = this.turns.get(turnId);
    if (!record || record.terminal) throw new TurnNotActiveError(turnId);
    const params = {
      threadId: this.nativeSessionId,
      input: textInput(input),
      expectedTurnId: turnId,
      ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
    };
    await this.awaitStarted(record, this.host.timings.queuedStartWaitMs);
    if (record.terminal) throw new TurnNotActiveError(turnId);
    if (this.ended) throw new NotSentError('The Codex session ended while the steer waited for its turn to start.');
    let client: JsonRpcClient;
    try {
      client = this.host.client();
    } catch (error) {
      throw new NotSentError(error instanceof Error ? error.message : 'The Codex app-server is not running.');
    }
    try {
      await callCodex(client, 'turn/steer', params, { timeoutMs: this.host.timings.requestTimeoutMs });
    } catch (error) {
      if (error instanceof JsonRpcExitError && !error.sent) throw new NotSentError(error.message);
      if (error instanceof JsonRpcRequestError && (record.terminal || steerLostRace(error))) {
        throw new TurnNotActiveError(turnId);
      }
      throw toTransportError(error);
    }
  }

  async interrupt(turnId: string): Promise<void> {
    const record = this.turns.get(turnId);
    if (!record || record.terminal || record.interrupt) return;
    // An interrupt cannot be delivered to a queued turn before it starts.
    await this.awaitStarted(record, this.host.timings.queuedStartWaitMs);
    if (record.terminal || record.interrupt) return;
    // Mark first: a `completed` that races the request still means the user stopped it.
    record.interrupt = { timer: undefined };
    try {
      await callCodex(this.host.client(), 'turn/interrupt', { threadId: this.nativeSessionId, turnId }, { timeoutMs: this.host.timings.requestTimeoutMs });
    } catch (error) {
      if (record.terminal) {
        // The turn ended while the request was in flight, but commands it started can still be running.
        this.terminateBackgroundCommands(record);
        return;
      }
      record.interrupt = null;
      if (error instanceof JsonRpcRequestError && interruptTurnGone(error)) {
        // The server holds no such turn (it ended without a `turn/completed` this session saw, or the thread was
        // unloaded), so no terminal will follow. Close it here, once, or Stop could never clear the turn.
        this.host.log.warn({ threadId: this.nativeSessionId, turnId, error: error.message }, 'codex turn/interrupt refused for a turn that is not running; closing it locally');
        this.notice('warn', 'Codex reports that this turn is no longer running; the turn was closed locally.');
        this.terminateBackgroundCommands(record);
        this.ensureStarted(record);
        this.finalizeTurn(record, 'interrupted');
        return;
      }
      throw toTransportError(error);
    }
    // Whether `turn/completed` or this response arrived first, the user asked to stop: a command the turn
    // started never ends on its own (fixture `turn_interrupt_mid_tool`), so end the tracked ones either way.
    this.terminateBackgroundCommands(record);
    if (record.terminal || !record.interrupt) return;
    record.interrupt.timer = setTimeout(() => this.interruptTimedOut(record), this.host.timings.interruptGraceMs);
  }

  /** Every server request is answered the moment it arrives (slice 1 has no approval UI), so nothing stays open. */
  async respond(requestId: string, response: RequestResponse): Promise<void> {
    this.host.log.debug?.({ requestId, decision: response.decision, threadId: this.nativeSessionId }, 'codex request already answered');
  }

  async unload(): Promise<void> {
    if (this.ended) return;
    await this.unsubscribe();
    this.endLocal();
  }

  async close(reason: 'release' | 'shutdown' | 'error'): Promise<void> {
    if (!this.ended) {
      if (reason === 'release') await this.unsubscribe();
      this.endLocal();
    }
    await Promise.allSettled([...this.cleanupJobs]);
  }

  /**
   * Fills the rollout path from `thread/read` when `thread/start` reported none (it can be null until the
   * first turn). Emits `session.native` with the path once known.
   */
  refreshTranscriptPath(): Promise<string | undefined> {
    if (this.path !== null || this.ended) return Promise.resolve(this.transcriptPath);
    this.pathRefresh ??= this.readTranscriptPath().finally(() => {
      this.pathRefresh = undefined;
    });
    return this.pathRefresh;
  }

  private async readTranscriptPath(): Promise<string | undefined> {
    const response = await callCodex(this.host.client(), 'thread/read', { threadId: this.nativeSessionId, includeTurns: false }, { timeoutMs: this.host.timings.requestTimeoutMs });
    this.adoptPath(response.thread.path);
    return this.transcriptPath;
  }

  private adoptPath(path: string | null | undefined): void {
    if (this.path !== null || !path || this.ended) return;
    this.path = path;
    this.channel.push({ type: 'session.native', nativeSessionId: this.nativeSessionId, transcriptPath: path });
  }

  private async unsubscribe(): Promise<void> {
    try {
      await callCodex(this.host.client(), 'thread/unsubscribe', { threadId: this.nativeSessionId }, { timeoutMs: this.host.timings.requestTimeoutMs });
    } catch (error) {
      // The process may already be gone, or the server may have unloaded the thread; either way it is not loaded.
      this.host.log.debug?.({ threadId: this.nativeSessionId, error: error instanceof Error ? error.message : String(error) }, 'codex thread/unsubscribe failed');
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Called by the instance

  handleNotification(method: string, params: unknown): void {
    if (this.ended) return;
    switch (method) {
      case 'thread/started':
        this.onThreadStarted(params as CodexNotificationMap['thread/started']);
        return;
      case 'thread/status/changed':
        this.onThreadStatus(params as CodexNotificationMap['thread/status/changed']);
        return;
      case 'thread/closed':
        this.onThreadClosed();
        return;
      case 'turn/started':
        this.onTurnStarted(params as CodexNotificationMap['turn/started']);
        return;
      case 'turn/completed':
        this.onTurnCompleted(params as CodexNotificationMap['turn/completed']);
        return;
      case 'item/started':
        this.onItemStarted(params as CodexNotificationMap['item/started']);
        return;
      case 'item/completed':
        this.onItemCompleted(params as CodexNotificationMap['item/completed']);
        return;
      case 'thread/tokenUsage/updated':
        this.onTokenUsage(params as CodexNotificationMap['thread/tokenUsage/updated']);
        return;
      case 'error':
        this.onError(params as CodexNotificationMap['error']);
        return;
      case 'warning': {
        const message = asString((params as CodexNotificationMap['warning'] | undefined)?.message);
        if (message) this.notice('warn', message);
        return;
      }
      case 'mcpServer/startupStatus/updated':
        this.onMcpStatus(params as CodexNotificationMap['mcpServer/startupStatus/updated']);
        return;
      case 'item/agentMessage/delta': // assistant text arrives through the rollout transcript
      case 'serverRequest/resolved': // every request was answered when it arrived
      case 'hook/started':
      case 'hook/completed':
        return;
      default:
        // Streaming deltas and progress ticks are far too frequent to log one by one.
        if (!/(?:[dD]elta|PartAdded|\/progress)$/.test(method)) {
          this.host.log.debug?.({ method, threadId: this.nativeSessionId }, 'codex notification not handled');
        }
    }
  }

  /** Answers a server request for this thread. Everything is declined; no approval UI exists in slice 1. */
  handleServerRequest(method: string, params: unknown, rpcId: string | number): unknown {
    const requestId = String(rpcId);
    const answer = declinedServerRequest(method, params);
    this.channel.push({ type: 'request.opened', requestId, kind: answer.kind, summary: answer.summary });
    this.channel.push({ type: 'request.closed', requestId, outcome: 'declined' });
    return answer.result;
  }

  /** Account-level limits changed: tell this session's consumer. */
  handleRateLimits(snapshot: CodexRateLimitSnapshot): void {
    if (this.ended) return;
    const windows = usageEventWindows(rateLimitsToWindows(snapshot));
    if (windows.length > 0) this.channel.push({ type: 'usage.updated', windows });
  }

  /** The process ended. The consumer sees `error` then `stopped`; what to do about a running turn is its call. */
  handleProcessExit(failure: ProviderFailure): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.channel.push({ type: 'session.state', state: 'error', failure });
    this.channel.push({ type: 'session.state', state: 'stopped' });
    this.host.release(this);
  }

  /** The instance is going away or the session was unloaded: end the event stream. */
  endLocal(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.channel.push({ type: 'session.state', state: 'stopped' });
    this.host.release(this);
  }

  // -------------------------------------------------------------------------------------------------------
  // Thread-level notifications

  private onThreadStarted(params: CodexNotificationMap['thread/started']): void {
    this.adoptPath(params?.thread?.path);
  }

  private onThreadStatus(params: CodexNotificationMap['thread/status/changed']): void {
    // Informational: `turn/completed` is the authoritative end of a turn and can arrive after `idle`.
    this.threadStatus = params?.status?.type ?? this.threadStatus;
  }

  private onThreadClosed(): void {
    // The server unloaded the thread (its terminals died with it). A turn still open can never finish.
    const active = this.activeTurnId ? this.turns.get(this.activeTurnId) : undefined;
    if (active && !active.terminal) {
      this.ensureStarted(active);
      this.finalizeTurn(active, 'failed', {
        class: 'transport_error',
        code: 'thread_closed',
        message: 'Codex closed the thread while a turn was running.',
        retryable: true,
      });
    }
    this.endLocal();
  }

  private onMcpStatus(params: CodexNotificationMap['mcpServer/startupStatus/updated']): void {
    if (params?.status !== 'failed') return;
    this.notice('warn', `MCP server "${String(params.name)}" failed to start${params.error ? `: ${params.error}` : '.'}`);
  }

  private notice(level: 'info' | 'warn', text: string): void {
    this.channel.push({ type: 'notice', level, text: redactFreeText(text) });
  }

  // -------------------------------------------------------------------------------------------------------
  // Turn lifecycle

  private newTurn(id: string, origin: 'user' | 'provider'): TurnRecord {
    const record: TurnRecord = {
      id,
      origin,
      started: false,
      queued: false,
      terminal: false,
      interrupt: null,
      lastError: null,
      commands: new Map(),
      startedWaiters: [],
    };
    this.turns.set(id, record);
    this.activeTurnId = id;
    return record;
  }

  private markStarted(record: TurnRecord): void {
    if (record.started) return;
    record.started = true;
    record.queued = false;
    this.tokenUsage.activeTurnId = record.id;
    this.channel.push({ type: 'turn.started', turnId: record.id, origin: record.origin, replay: false });
    for (const wake of record.startedWaiters.splice(0)) wake();
  }

  /** An item or terminal for a turn whose `turn/started` was not seen means the turn is running. */
  private ensureStarted(record: TurnRecord): void {
    if (!record.started) this.markStarted(record);
  }

  /** `turn/started`: adopt it as the pending `turn/start` turn, or record it as a turn Codex started itself. */
  private onTurnStarted(params: CodexNotificationMap['turn/started']): void {
    const turnId = asString(params?.turn?.id);
    if (!turnId) return;
    if (this.finishedTurnIds.has(turnId)) return;
    let record = this.turns.get(turnId);
    if (!record) {
      const adopt = this.pendingStart !== null && this.pendingStart.adoptedTurnId === null;
      record = this.newTurn(turnId, adopt ? 'user' : 'provider');
      if (adopt && this.pendingStart) this.pendingStart.adoptedTurnId = turnId;
    }
    this.markStarted(record);
    this.flushEarly(turnId);
  }

  /** The `turn/start` response. A queued turn (`startedAt === null`) is not started until `turn/started`. */
  private onTurnStartResponse(turn: CodexTurn): void {
    const pending = this.pendingStart;
    this.pendingStart = null;
    if (pending?.adoptedTurnId && pending.adoptedTurnId !== turn.id) {
      // A `turn/started` was adopted for this request, but the server answered with another turn.
      this.host.log.warn({ threadId: this.nativeSessionId, adopted: pending.adoptedTurnId, responded: turn.id }, 'codex turn/start answered with a different turn than the one adopted');
    }
    if (this.finishedTurnIds.has(turn.id)) {
      // A turn this request adopted can end before its response is read, and a response that reports an ended
      // turn needs no tracking either.
      if (pending?.adoptedTurnId === turn.id || turn.status !== 'inProgress') return;
      // Otherwise this session closed the turn earlier (a local interrupt finalize) yet the server answers
      // `turn/start` with it as running: Codex still considers it active. Track it again, or the turn would run
      // unobserved and its real `turn/completed` would be dropped as a finished turn.
      this.host.log.warn({ threadId: this.nativeSessionId, turnId: turn.id }, 'codex turn/start answered with a turn this session already finished; tracking it as active again');
      this.finishedTurnIds.delete(turn.id);
    }
    let record = this.turns.get(turn.id);
    if (!record) {
      record = this.newTurn(turn.id, 'user');
      if (turn.startedAt !== null) this.markStarted(record);
      else record.queued = true;
    }
    this.flushEarly(turn.id);
    this.early.clear();
    if (turn.status !== 'inProgress' && !record.terminal) {
      // The turn had already ended when the response was written.
      this.onTurnCompleted({ threadId: this.nativeSessionId, turn });
    }
  }

  private onTurnCompleted(params: CodexNotificationMap['turn/completed']): void {
    const turn = params?.turn;
    const turnId = asString(turn?.id);
    if (!turn || !turnId) return;
    const record = this.recordFor(turnId, 'turn/completed', params);
    if (!record || record.terminal) return;
    const status = this.terminalStatus(turn.status, record);
    if (!status) return;
    this.ensureStarted(record);
    const failure = status === 'failed' ? classifyCodexFailure(mergeTurnErrors(turn.error, record.lastError), this.host.rateLimits()) : undefined;
    this.finalizeTurn(record, status, failure);
  }

  private terminalStatus(status: CodexTurnStatus, record: TurnRecord): 'completed' | 'interrupted' | 'failed' | undefined {
    switch (status) {
      case 'completed':
        // A turn that finishes while an interrupt is in flight still means the user stopped it.
        return record.interrupt ? 'interrupted' : 'completed';
      case 'interrupted':
        return 'interrupted';
      case 'failed':
        return 'failed';
      default:
        return undefined;
    }
  }

  /** The only place that emits `turn.terminal`. */
  private finalizeTurn(record: TurnRecord, status: 'completed' | 'interrupted' | 'failed', failure?: ProviderFailure): void {
    if (record.terminal) return;
    record.terminal = true;
    if (record.interrupt?.timer) clearTimeout(record.interrupt.timer);
    for (const wake of record.startedWaiters.splice(0)) wake();
    if (this.activeTurnId === record.id) this.activeTurnId = null;
    this.turns.delete(record.id);
    this.finishedTurnIds.add(record.id);
    if (this.finishedTurnIds.size > MAX_FINISHED_TURNS) {
      const oldest = this.finishedTurnIds.values().next().value;
      if (oldest !== undefined) this.finishedTurnIds.delete(oldest);
    }
    const usage = completeTurnTokenUsage(this.tokenUsage, record.id, status === 'completed');
    this.host.log.debug?.({ threadId: this.nativeSessionId, turnId: record.id, status, usage }, 'codex turn finished');
    this.channel.push({
      type: 'turn.terminal',
      turnId: record.id,
      status,
      ...(failure ? { failure } : {}),
      sessionUsable: this.threadStatus !== 'systemError',
      replay: false,
    });
    if (!this.firstTerminalSeen) {
      this.firstTerminalSeen = true;
      if (this.path === null) {
        this.refreshTranscriptPath().catch((error: unknown) => {
          this.host.log.debug?.({ threadId: this.nativeSessionId, error: error instanceof Error ? error.message : String(error) }, 'codex thread/read for the transcript path failed');
        });
      }
    }
  }

  private interruptTimedOut(record: TurnRecord): void {
    if (record.terminal || this.ended) return;
    this.notice('warn', `Codex did not report the interrupted turn within ${Math.round(this.host.timings.interruptGraceMs / 1000)} s; the turn was closed locally.`);
    this.ensureStarted(record);
    this.finalizeTurn(record, 'interrupted');
  }

  private awaitStarted(record: TurnRecord, ms: number): Promise<void> {
    if (record.started || record.terminal || this.ended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      record.startedWaiters.push(done);
    });
  }

  /**
   * A command started by the turn can keep running after `turn/interrupt`. List the thread's background
   * terminals and terminate the tracked ones. Failures are tolerated: the thread may already be closed or the
   * process finished on its own. When the list is unavailable every tracked process is tried anyway.
   */
  private terminateBackgroundCommands(record: TurnRecord): void {
    const tracked = [...record.commands.values()];
    if (tracked.length === 0) return;
    const threadId = this.nativeSessionId;
    const log = this.host.log;
    const job = (async () => {
      let targets = tracked;
      try {
        const live = new Set<string>();
        let cursor: string | null = null;
        for (let page = 0; page < 20; page += 1) {
          const response: ThreadBackgroundTerminalsListResponse = await callCodex(
            this.host.client(),
            'thread/backgroundTerminals/list',
            { threadId, ...(cursor ? { cursor } : {}) },
            { timeoutMs: this.host.timings.requestTimeoutMs },
          );
          for (const terminal of response.data) live.add(terminal.processId);
          cursor = response.nextCursor;
          if (!cursor) break;
        }
        targets = tracked.filter((processId) => live.has(processId));
      } catch (error) {
        log.debug?.({ threadId, error: error instanceof Error ? error.message : String(error) }, 'codex thread/backgroundTerminals/list failed; terminating tracked commands anyway');
      }
      for (const processId of targets) {
        try {
          await callCodex(this.host.client(), 'thread/backgroundTerminals/terminate', { threadId, processId }, { timeoutMs: this.host.timings.requestTimeoutMs });
        } catch (error) {
          log.debug?.({ threadId, processId, error: error instanceof Error ? error.message : String(error) }, 'codex thread/backgroundTerminals/terminate failed');
        }
      }
    })();
    this.cleanupJobs.add(job);
    void job.finally(() => this.cleanupJobs.delete(job));
  }

  // -------------------------------------------------------------------------------------------------------
  // Items, usage and errors

  /**
   * The record for a turn-scoped notification. A turn that is not known yet is waiting for its `turn/start`
   * response or `turn/started`: buffer the event by turn id. A turn that already finished (late output of a
   * background command) or was never seen is dropped.
   */
  private recordFor(turnId: string, method: string, params: unknown): TurnRecord | undefined {
    const record = this.turns.get(turnId);
    if (record) return record;
    if (this.pendingStart !== null && !this.finishedTurnIds.has(turnId)) {
      this.bufferEarly(turnId, method, params);
    } else {
      this.droppedTurnEvents += 1;
      this.host.log.debug?.({ threadId: this.nativeSessionId, turnId, method }, 'codex event for a turn this session does not track');
    }
    return undefined;
  }

  private bufferEarly(turnId: string, method: string, params: unknown): void {
    let list = this.early.get(turnId);
    if (!list) {
      if (this.early.size >= MAX_EARLY_TURNS) {
        const oldest = this.early.keys().next().value;
        if (oldest !== undefined) this.early.delete(oldest);
      }
      list = [];
      this.early.set(turnId, list);
    }
    if (list.length < MAX_EARLY_EVENTS_PER_TURN) list.push({ method, params });
  }

  private flushEarly(turnId: string): void {
    const list = this.early.get(turnId);
    if (!list) return;
    this.early.delete(turnId);
    for (const event of list) this.handleNotification(event.method, event.params);
  }

  private onItemStarted(params: CodexNotificationMap['item/started']): void {
    const turnId = asString(params?.turnId);
    const item = params?.item;
    if (!turnId || !isRecord(item)) return;
    const record = this.recordFor(turnId, 'item/started', params);
    if (!record) return;
    this.ensureStarted(record);
    if (item.type === 'commandExecution' && typeof item.processId === 'string' && typeof item.id === 'string') {
      record.commands.set(item.id, item.processId);
    }
  }

  private onItemCompleted(params: CodexNotificationMap['item/completed']): void {
    const turnId = asString(params?.turnId);
    const item = params?.item;
    if (!turnId || !isRecord(item) || typeof item.id !== 'string' || typeof item.type !== 'string') return;
    const record = this.recordFor(turnId, 'item/completed', params);
    if (!record) return;
    this.ensureStarted(record);
    record.commands.delete(item.id);
    // The user's own message (and an injected hook prompt) is echoed back as an item; it is not agent output.
    if (item.type === 'userMessage' || item.type === 'hookPrompt') return;
    const title = itemTitle(item as CodexThreadItem);
    this.channel.push({
      type: 'item.completed',
      turnId,
      itemId: item.id,
      kind: itemKind(item as CodexThreadItem),
      replay: false,
      ...(title ? { title } : {}),
    });
  }

  private onTokenUsage(params: CodexNotificationMap['thread/tokenUsage/updated']): void {
    const usage = params?.tokenUsage;
    if (!usage?.last || !usage.total) return;
    if (this.turns.has(params.turnId)) accumulateTurnTokenUsage(this.tokenUsage, params.turnId, usage);
    const fill = contextFill(usage);
    this.channel.push({
      type: 'usage.updated',
      contextUsedTokens: fill.usedTokens,
      ...(fill.maxTokens !== null ? { contextMaxTokens: fill.maxTokens } : {}),
    });
  }

  private onError(params: CodexNotificationMap['error']): void {
    const error = params?.error;
    if (!error) return;
    if (params.willRetry) {
      const progress = parseCodexRetryProgress(error.message ?? '');
      const attempt = progress ? ` (${progress.attempt}/${progress.maxAttempts})` : '';
      this.notice('warn', `Codex is retrying${attempt}: ${error.additionalDetails?.trim() || error.message}`);
      return;
    }
    // A failed turn follows; remember the richer message for its terminal.
    const record = typeof params.turnId === 'string' ? this.recordFor(params.turnId, 'error', params) : undefined;
    if (record) record.lastError = error;
  }

  private clearTimers(): void {
    for (const record of this.turns.values()) {
      if (record.interrupt?.timer) clearTimeout(record.interrupt.timer);
      for (const wake of record.startedWaiters.splice(0)) wake();
    }
  }
}
