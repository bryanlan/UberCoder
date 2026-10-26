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
  RequestNotPendingError,
  TransportUnavailableError,
  TurnNotActiveError,
  type OpenOptions,
  type PendingQuestion,
  type ProviderFailure,
  type TransportCapabilities,
  type TransportEvent,
  type TransportSession,
  type TurnInput,
  type RequestResponse,
} from '../types.js';
import { classifyCodexFailure, interruptTurnGone, mergeTurnErrors, parseCodexRetryProgress, steerLostRace } from './errors.js';
import { JsonRpcExitError, JsonRpcRequestError, JsonRpcSpawnError, type JsonRpcClient, type JsonRpcId } from './jsonrpc.js';
import {
  callCodex,
  type CodexApprovalPolicy,
  type CodexNotificationMap,
  type CodexSandboxMode,
  type CodexSandboxPolicy,
  type CodexServerRequestMap,
  type CodexThreadItem,
  type CodexThreadStatus,
  type CodexTurn,
  type CodexTurnError,
  type CodexTurnStatus,
  type CodexUserInput,
  type ThreadBackgroundTerminalsListResponse,
  type TurnStartParams,
} from './protocol.js';
import { redactFreeText } from './redact.js';
import type { HeldQuestionRecord } from './restart-state.js';
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
  images: true,
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
  /** How often the position in the session host's output is written down while it moves (it is also written at every turn boundary). */
  cursorSaveMs: number;
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
  cursorSaveMs: 5_000,
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
  /**
   * The thread started or stopped running a turn. The instance writes it down so a later backend can find a turn that
   * outlives this one (and report one that ended while nobody listened). Also a point at which the host's replay cursor is saved.
   */
  noteTurn(threadId: string, turnId: string | undefined): void;
  /** Questions held open for the person survive a backend restart: the instance keeps them in the Console database. */
  readonly questions: {
    save(record: HeldQuestionRecord): void;
    remove(requestId: string): void;
  };
}

export interface CodexSessionInit {
  threadId: string;
  transcriptPath: string | null;
  cwd: string;
  policy: OpenOptions['policy'];
  host: CodexSessionHost;
  /** What `thread/start` or `thread/resume` said the thread is doing. Absent means idle. */
  status?: CodexThreadStatus;
}

/** What an instance hands a session it just resumed, so the session can pick up where the previous backend left off. */
export interface CodexAdoption {
  /** The turn the previous backend was following on this thread when it went away, if it had not ended. */
  trackedTurnId?: string;
  /** The questions the previous backend held open on this thread. */
  held: HeldQuestionRecord[];
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

/**
 * One `localImage` item per attached file (Codex reads the file; its type comes from the bytes), then the text.
 * Images come first so the prompt's trailing image envelope stays the end of the text a transcript shows.
 */
function textInput(input: TurnInput): CodexUserInput[] {
  return [
    ...(input.images ?? []).map((image): CodexUserInput => ({ type: 'localImage', path: image.path })),
    { type: 'text', text: input.text },
  ];
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
 * Approvals and elicitations have no UI: every such server request that still arrives under the `never` policy
 * is declined at once. A `requestUserInput` question is declined here only when it cannot be shown (see
 * `pendingQuestions`); otherwise the session holds it open until `respond()`. Each method has its own answer
 * shape (the permissions request has no `decision`).
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

/**
 * The questions of an `item/tool/requestUserInput` request as the host shows them. Undefined when the request
 * cannot be shown and must be declined: no questions, a malformed question, or a secret one (a password typed
 * into the browser would travel and be stored as plain text).
 */
export function pendingQuestions(params: unknown): PendingQuestion[] | undefined {
  const request = (isRecord(params) ? params : {}) as Record<string, unknown>;
  if (!Array.isArray(request.questions) || request.questions.length === 0) return undefined;
  const questions: PendingQuestion[] = [];
  for (const raw of request.questions) {
    if (!isRecord(raw)) return undefined;
    const { id, header, question, isOther, isSecret, options } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !id || typeof question !== 'string' || isSecret === true) return undefined;
    const choices = Array.isArray(options)
      ? options.flatMap((option): Array<{ label: string; description?: string }> => {
          if (!isRecord(option) || typeof option.label !== 'string' || !option.label) return [];
          const description = asString(option.description);
          return [{ label: option.label, ...(description ? { description } : {}) }];
        })
      : [];
    const title = asString(header);
    // A question with no options can only be answered in words.
    questions.push({ id, ...(title ? { header: title } : {}), question, options: choices, allowCustom: isOther === true || choices.length === 0 });
  }
  return questions;
}

/** A question held open for the person: the id list shapes the answer, `settle` sends the JSON-RPC reply. */
interface OpenQuestion {
  turnId: string | undefined;
  questionIds: string[];
  settle: (result: unknown) => void;
  /**
   * Set for a question adopted from an earlier backend: no handler of this client holds it, so the answer is a reply frame
   * written by id. A question this client's handler holds is answered through `settle`.
   */
  rawId?: JsonRpcId;
}

/** The most questions held open on one thread. A server that asks more is declined, so a loop cannot fill the database. */
const MAX_OPEN_QUESTIONS = 64;

/** What Codex gets for a question nobody answered: no answers. */
const NO_ANSWERS = { answers: {} };

/** `{answers: {[questionId]: {answers: string[]}}}`; typed text joins the first question's answers. */
function questionAnswerResult(questionIds: string[], response: RequestResponse): unknown {
  if (response.decision !== 'answer') return NO_ANSWERS;
  const answers: Record<string, { answers: string[] }> = {};
  for (const id of questionIds) answers[id] = { answers: (response.answers[id] ?? []).filter((answer) => typeof answer === 'string') };
  const text = response.text?.trim();
  if (text && questionIds[0] !== undefined) answers[questionIds[0]]!.answers.push(text);
  return { answers };
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
  /** The turn was already running (or had just ended) when this session attached: a backend restart left it behind. */
  adopted: boolean;
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
/** How many of a thread's newest turns an adopting session reads to find the running one and the one it was following. */
const ADOPTION_TURN_WINDOW = 8;
const MAX_MESSAGE_QUESTIONS = 256;
/** Notifications kept while a resumed session works out which turn its thread is running. */
const MAX_ADOPTION_FRAMES = 4096;
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
  /** `requestUserInput` questions held open for the person, by JSON-RPC id. */
  private readonly openQuestions = new Map<string, OpenQuestion>();
  private threadStatus: string = 'idle';
  private firstTerminalSeen = false;
  private pathRefresh: Promise<string | undefined> | undefined;
  /** While the session adopts what the previous backend left running, thread notifications wait here so they are applied in order afterwards. */
  private adopting = false;
  private readonly heldFrames: Array<{ method: string; params: unknown }> = [];
  private activeFlags: string[];
  /** The thread was running a turn when this session attached and no listing named it: the first event of an unknown turn is that turn. */
  private adoptUnknownTurn = false;
  /** Questions the model asked in a message (`request_user_input_async`), already announced. Bounded. */
  private readonly messageQuestions = new Set<string>();

  constructor(init: CodexSessionInit) {
    this.nativeSessionId = init.threadId;
    this.path = init.transcriptPath;
    this.cwd = init.cwd;
    this.policy = init.policy;
    this.host = init.host;
    this.threadStatus = init.status?.type ?? 'idle';
    this.activeFlags = init.status?.type === 'active' ? [...(init.status.activeFlags ?? [])] : [];
    this.events = this.channel.iterable();
  }

  get transcriptPath(): string | undefined {
    return this.path ?? undefined;
  }

  /** The id of the turn that has not reached its terminal event, if any. */
  get activeTurn(): string | undefined {
    return this.activeTurnId ?? undefined;
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

  /**
   * Answers a question held open for the person. The first answer settles it and removes it, so a second
   * `respond` (or one that loses to a withdrawal or the end of the turn) finds nothing and has no effect.
   * Every other server request was answered when it arrived.
   */
  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const open = this.openQuestions.get(requestId);
    if (!open) {
      // Withdrawn, answered or ended with its turn: the answer would reach nobody, so the caller must not report it as delivered.
      this.host.log.debug?.({ requestId, decision: response.decision, threadId: this.nativeSessionId }, 'codex request is not open');
      throw new RequestNotPendingError(requestId);
    }
    const result = questionAnswerResult(open.questionIds, response);
    // A question adopted from an earlier backend is answered by id over the connection. The reply is written first: a channel
    // that is gone leaves the question open and the caller sees the failure.
    if (open.rawId !== undefined) {
      try {
        await this.host.client().replyToServerRequest(open.rawId, result);
      } catch (error) {
        throw toTransportError(error);
      }
      if (this.openQuestions.get(requestId) !== open) return; // closed while the reply was being written
    }
    this.closeQuestion(requestId, open, result, response.decision === 'answer' ? 'resolved' : response.decision === 'decline' ? 'declined' : 'cancelled');
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
    if (this.adopting) {
      // The turn this thread is running is not known yet: apply the notification once it is, in the order it arrived.
      if (this.heldFrames.length < MAX_ADOPTION_FRAMES) this.heldFrames.push({ method, params });
      return;
    }
    this.dispatchNotification(method, params);
  }

  private dispatchNotification(method: string, params: unknown): void {
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
      case 'serverRequest/resolved':
        this.onServerRequestResolved(params as CodexNotificationMap['serverRequest/resolved']);
        return;
      case 'item/agentMessage/delta': // assistant text arrives through the rollout transcript
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

  /**
   * Answers a server request for this thread. A question the person can see is held open (the reply is a promise
   * that `respond()` settles); everything else is declined at once, because there is no approval UI.
   */
  handleServerRequest(method: string, params: unknown, rpcId: string | number, hold?: () => void): unknown {
    const requestId = String(rpcId);
    if (method === 'item/tool/requestUserInput' && !this.ended) {
      const questions = pendingQuestions(params);
      if (questions && this.openQuestions.size < MAX_OPEN_QUESTIONS) {
        // The reply waits for a person: it must not count against the client's limit on requests being handled.
        hold?.();
        return this.openQuestion(rpcId, params, questions);
      }
    }
    const answer = declinedServerRequest(method, params);
    this.channel.push({ type: 'request.opened', requestId, kind: answer.kind, summary: answer.summary });
    this.channel.push({ type: 'request.closed', requestId, outcome: 'declined' });
    return answer.result;
  }

  private openQuestion(rpcId: JsonRpcId, params: unknown, questions: PendingQuestion[]): Promise<unknown> {
    const requestId = String(rpcId);
    const turnId = asString((params as { turnId?: unknown }).turnId);
    const summary = declinedServerRequest('item/tool/requestUserInput', params).summary;
    const reply = new Promise<unknown>((settle) => {
      this.openQuestions.set(requestId, { turnId, questionIds: questions.map((question) => question.id), settle });
    });
    // Written down so a backend that replaces this one can show the question and answer it by id: the server keeps waiting.
    this.host.questions.save({ id: rpcId, threadId: this.nativeSessionId, ...(turnId ? { turnId } : {}), params });
    this.channel.push({ type: 'request.opened', requestId, kind: 'question', summary, ...(turnId ? { turnId } : {}), questions });
    return reply;
  }

  /**
   * A question an earlier backend held open and the server is still waiting on. No handler of this client holds it, so it is
   * answered by id (`respond`); it ends like any other: answered, withdrawn by the server, or with its turn.
   */
  private adoptQuestion(record: HeldQuestionRecord, questions: PendingQuestion[]): void {
    const requestId = String(record.id);
    if (this.openQuestions.has(requestId)) return;
    const turnId = record.turnId ?? asString((record.params as { turnId?: unknown } | undefined)?.turnId);
    const summary = declinedServerRequest('item/tool/requestUserInput', record.params).summary;
    this.openQuestions.set(requestId, { turnId, questionIds: questions.map((question) => question.id), settle: () => undefined, rawId: record.id });
    this.channel.push({ type: 'request.opened', requestId, kind: 'question', summary, ...(turnId ? { turnId } : {}), questions, replay: true });
  }

  /** Removes the question, sends its reply and tells the consumer. The only way a held question ends. */
  private closeQuestion(requestId: string, open: OpenQuestion, result: unknown, outcome: 'resolved' | 'declined' | 'cancelled'): void {
    this.openQuestions.delete(requestId);
    this.host.questions.remove(requestId);
    open.settle(result);
    this.channel.push({ type: 'request.closed', requestId, outcome });
  }

  /** The turn ended, the thread closed or the process went away: no answer can matter any more. */
  private cancelQuestions(turnId?: string): void {
    for (const [requestId, open] of [...this.openQuestions]) {
      if (turnId === undefined || open.turnId === undefined || open.turnId === turnId) this.closeQuestion(requestId, open, NO_ANSWERS, 'cancelled');
    }
  }

  /**
   * The connection to the server is going away while the server keeps running (a backend restart or a lost session host
   * connection). A question stays held: the server still waits for its answer, the instance has it written down, and the next
   * backend answers it by id. Answering it with nothing here would end the turn's wait for the wrong reason, and the reply
   * could not be sent anyway once the socket closes.
   */
  private leaveQuestionsHeld(): void {
    this.openQuestions.clear();
  }

  /** The server withdrew a request (a timeout, or another client answered it): it must not keep waiting here. */
  private onServerRequestResolved(params: CodexNotificationMap['serverRequest/resolved']): void {
    if (params?.requestId === undefined || params.requestId === null) return;
    const requestId = String(params.requestId);
    const open = this.openQuestions.get(requestId);
    if (open) this.closeQuestion(requestId, open, NO_ANSWERS, 'cancelled');
  }

  /** Account-level limits changed: tell this session's consumer. */
  handleRateLimits(snapshot: CodexRateLimitSnapshot): void {
    if (this.ended) return;
    const windows = usageEventWindows(rateLimitsToWindows(snapshot));
    if (windows.length > 0) this.channel.push({ type: 'usage.updated', windows });
  }

  /** The process ended. The consumer sees `error` then `stopped`; what to do about a running turn is its call. */
  handleProcessExit(failure: ProviderFailure, options: { keepQuestions?: boolean } = {}): void {
    if (this.ended) return;
    this.ended = true;
    if (options.keepQuestions) this.leaveQuestionsHeld();
    else this.cancelQuestions();
    this.clearTimers();
    this.channel.push({ type: 'session.state', state: 'error', failure });
    this.channel.push({ type: 'session.state', state: 'stopped' });
    this.host.release(this);
  }

  /** The instance is going away or the session was unloaded: end the event stream. */
  endLocal(options: { keepQuestions?: boolean } = {}): void {
    if (this.ended) return;
    this.ended = true;
    if (options.keepQuestions) this.leaveQuestionsHeld();
    else this.cancelQuestions();
    this.clearTimers();
    this.channel.push({ type: 'session.state', state: 'stopped' });
    this.host.release(this);
  }

  // -------------------------------------------------------------------------------------------------------
  // Adopting what a previous backend left

  /**
   * Called by the instance once, right after `thread/resume` registered this session and before the session is handed out.
   * A backend restart does not stop the shared app-server (it runs behind its session host), so the thread may be running a
   * turn this session never saw start, may have finished one while no backend listened, and may be waiting for an answer to a
   * question an earlier backend showed. This reads the thread's own state (its status, its newest turns) and the records the
   * instance kept, and turns what it finds into the events a session that had been there all along would have produced:
   * a running turn becomes an adopted provider turn (events and its terminal are then accepted), a turn that ended meanwhile
   * is reported once, and a question that is still pending is held open again.
   */
  async adopt(adoption: CodexAdoption): Promise<void> {
    this.adopting = true;
    try {
      await this.adoptTurns(adoption.trackedTurnId);
      this.adoptHeldQuestions(adoption.held);
    } catch (error) {
      this.host.log.warn({ threadId: this.nativeSessionId, error: error instanceof Error ? error.message : String(error) }, 'codex could not adopt what the previous backend left on the thread');
    } finally {
      this.adopting = false;
      for (const frame of this.heldFrames.splice(0)) this.dispatchNotification(frame.method, frame.params);
    }
  }

  private async adoptTurns(trackedTurnId: string | undefined): Promise<void> {
    const active = this.threadStatus === 'active';
    if (!active && !trackedTurnId) return;
    const turns = await this.listRecentTurns();
    const tracked = trackedTurnId ? turns.find((turn) => turn.id === trackedTurnId) : undefined;
    // The turn the previous backend followed ended while nobody listened: its terminal has not been reported.
    if (tracked && tracked.status !== 'inProgress') this.adoptEndedTurn(tracked);
    const running = turns.find((turn) => turn.status === 'inProgress' && !this.turns.has(turn.id) && !this.finishedTurnIds.has(turn.id));
    if (running) this.adoptRunningTurn(running);
    else if (active && this.activeTurnId === null) this.adoptUnknownTurn = true;
    // A marker that names a turn the server no longer lists, or one that is not running: nothing is left to follow.
    if (trackedTurnId && this.activeTurnId === null) this.host.noteTurn(this.nativeSessionId, undefined);
  }

  /** The newest turns of the thread, newest first. A server that cannot list them (or an error) gives none. */
  private async listRecentTurns(): Promise<CodexTurn[]> {
    try {
      const response = await callCodex(
        this.host.client(),
        'thread/turns/list',
        { threadId: this.nativeSessionId, limit: ADOPTION_TURN_WINDOW, sortDirection: 'desc', itemsView: 'notLoaded' },
        { timeoutMs: this.host.timings.requestTimeoutMs },
      );
      return Array.isArray(response?.data) ? response.data.filter((turn) => typeof turn?.id === 'string') : [];
    } catch (error) {
      this.host.log.debug?.({ threadId: this.nativeSessionId, error: error instanceof Error ? error.message : String(error) }, 'codex thread/turns/list failed');
      return [];
    }
  }

  private adoptRunningTurn(turn: CodexTurn): void {
    const record = this.newTurn(turn.id, 'provider', true);
    this.markStarted(record);
  }

  private adoptEndedTurn(turn: CodexTurn): void {
    if (this.finishedTurnIds.has(turn.id) || this.turns.has(turn.id)) return;
    const record = this.newTurn(turn.id, 'provider', true);
    this.markStarted(record);
    const status = this.terminalStatus(turn.status, record) ?? 'completed';
    const failure = status === 'failed' ? classifyCodexFailure(mergeTurnErrors(turn.error, null), this.host.rateLimits()) : undefined;
    this.finalizeTurn(record, status, failure);
  }

  /**
   * Questions the previous backend held open. The thread's own status says whether the server still waits for an answer
   * (`waitingOnUserInput`): a question is held again only then, and one that is not waiting any more is forgotten. A wait that
   * no record explains (the question arrived while no backend listened and the replay no longer has it) cannot be answered; the
   * person is told, and Stop ends it.
   */
  private adoptHeldQuestions(held: HeldQuestionRecord[]): void {
    const waiting = this.threadStatus === 'active' && this.activeFlags.includes('waitingOnUserInput');
    let adopted = 0;
    let expired = 0;
    for (const record of held) {
      const questions = waiting ? pendingQuestions(record.params) : undefined;
      if (!questions) {
        this.host.questions.remove(String(record.id));
        expired += 1;
        continue;
      }
      this.adoptQuestion(record, questions);
      adopted += 1;
    }
    if (expired > 0) this.notice('warn', 'A question the agent asked can no longer be answered; it ended while the Console was restarting.');
    else if (waiting && adopted === 0) this.notice('warn', 'The agent is waiting for an answer the Console could not recover after the restart. Stop the turn to continue.');
  }

  // -------------------------------------------------------------------------------------------------------
  // Thread-level notifications

  private onThreadStarted(params: CodexNotificationMap['thread/started']): void {
    this.adoptPath(params?.thread?.path);
  }

  private onThreadStatus(params: CodexNotificationMap['thread/status/changed']): void {
    // Informational: `turn/completed` is the authoritative end of a turn and can arrive after `idle`.
    this.threadStatus = params?.status?.type ?? this.threadStatus;
    const status = params?.status;
    this.activeFlags = status?.type === 'active' ? [...(status.activeFlags ?? [])] : [];
    if (this.threadStatus !== 'active') this.adoptUnknownTurn = false;
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

  private newTurn(id: string, origin: 'user' | 'provider', adopted = false): TurnRecord {
    const record: TurnRecord = {
      id,
      origin,
      adopted,
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
    this.host.noteTurn(this.nativeSessionId, record.id);
    this.channel.push({ type: 'turn.started', turnId: record.id, origin: record.origin, replay: false, ...(record.adopted ? { adopted: true } : {}) });
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
    if (this.activeTurnId === null) this.host.noteTurn(this.nativeSessionId, undefined);
    this.finishedTurnIds.add(record.id);
    if (this.finishedTurnIds.size > MAX_FINISHED_TURNS) {
      const oldest = this.finishedTurnIds.values().next().value;
      if (oldest !== undefined) this.finishedTurnIds.delete(oldest);
    }
    // A question of this turn can no longer be answered; release it before the terminal is announced.
    this.cancelQuestions(record.id);
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
    if (this.adoptUnknownTurn && this.pendingStart === null && this.activeTurnId === null && !this.finishedTurnIds.has(turnId)) {
      // The thread was running a turn when this session attached, no listing named it, and this is the first thing it did.
      this.adoptUnknownTurn = false;
      const adopted = this.newTurn(turnId, 'provider', true);
      this.markStarted(adopted);
      return adopted;
    }
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
    if (item.type === 'agentMessage' && item.delivery === 'async' && Array.isArray(item.questions)) this.openMessageQuestion(turnId, item.id, item.questions);
  }

  /**
   * On codex-cli 0.164 the model asks through `request_user_input_async`: the tool answers `{accepted: true}` at once, no server
   * request is raised, and the question arrives as an assistant message item (`delivery: 'async'`, `questions`). Nothing waits
   * for it, so there is nothing to hold; the person's answer goes back as a normal message (`responseMode: 'message'`).
   */
  private openMessageQuestion(turnId: string, itemId: string, raw: unknown[]): void {
    const requestId = `item:${itemId}`;
    if (this.messageQuestions.has(requestId)) return;
    // A question without an id of its own gets its position, so the answer can name it.
    const questions = pendingQuestions({ questions: raw.map((question, index) => (isRecord(question) && typeof question.id !== 'string' ? { ...question, id: `q${index + 1}` } : question)) });
    if (!questions) return;
    if (this.messageQuestions.size >= MAX_MESSAGE_QUESTIONS) this.messageQuestions.delete(this.messageQuestions.values().next().value as string);
    this.messageQuestions.add(requestId);
    const summary = declinedServerRequest('item/tool/requestUserInput', { questions: raw }).summary;
    this.channel.push({ type: 'request.opened', requestId, kind: 'question', summary, turnId, questions, responseMode: 'message' });
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
