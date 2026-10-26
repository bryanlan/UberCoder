// One Claude conversation as a `TransportSession`, over one `claude` process (stream-json on stdin and stdout).
//
// The instance (claude-instance.ts) starts the process, runs the handshake and hands over a ready session. Behaviours
// that follow T3 Code's ClaudeAdapterV2.ts (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md): fresh
// prompt uuid per send, one assistant message per content block deduped by uuid, the 10 s local finalize when no
// `result` follows an interrupt, the result and rate-limit classification (errors.ts, usage.ts). Written
// independently in plain TypeScript.
//
// Invariants kept in this file:
//   - `turn.terminal` fires exactly once per turn: `finalize` is the only emitter and checks the record;
//   - frames are matched to turns by uuid (`command_lifecycle.command_uuid`, `user_message_uuids`), not by order; a
//     frame whose uuids all belong to turns that already ended is late and dropped;
//   - the active-turn pointer is cleared before the terminal event is pushed, so a consumer that reacts by calling
//     `sendTurn` is not told that the previous turn is still running;
//   - every `can_use_tool` and `elicitation` request is answered: by `respond`, or by a deny/decline when the turn
//     ends, the session closes, or the process exits (the stream client also answers by default if no handler runs);
//   - this session is the only writer on its process's stdin.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  NotSentError,
  PreviousTurnActiveError,
  TurnNotActiveError,
  type ProviderFailure,
  type RequestResponse,
  type TransportCapabilities,
  type TransportEvent,
  type TransportSession,
  type TurnInput,
} from '../types.js';
import { redactFreeText } from '../codex/redact.js';
import { assistantRateLimitEvidence, classifyResult, failureFromApiRetry, newTurnEvidence, processExitFailure, type TurnEvidence } from './errors.js';
import { EventChannel } from './event-channel.js';
import {
  asString,
  asStringArray,
  isRecord,
  isUuid,
  messageUuidsOf,
  type AskUserQuestionInput,
  type AssistantFrame,
  type CanUseToolRequest,
  type CanUseToolResponse,
  type ClaudeFrame,
  type ClaudeResultFrame,
  type ClaudeUserContentBlock,
  type ClaudeUserMessageFrame,
  type CommandLifecycleFrame,
  type ContextUsageResponseBody,
  type ElicitationRequest,
  type InterruptResponseBody,
  type RateLimitEventFrame,
  type SystemApiRetryFrame,
  type SystemCompactBoundaryFrame,
  type SystemFrame,
  type SystemHookFrame,
  type SystemInformationalFrame,
  type SystemInitFrame,
  type SystemPermissionDeniedFrame,
  type SystemSessionStateChangedFrame,
  type SystemStatusFrame,
  type SystemTaskFrame,
  type UserFrame,
} from './protocol.js';
import { ClaudeExitError, describeExit, type OpenServerRequest, type StreamJsonClient, type StreamJsonExit } from './stream-json.js';
import { locateTranscripts } from './transcript.js';
import { contextFromUsageResponse, contextMaxFromModelUsage, contextUsedFromResultUsage, ClaudeRateLimitTracker } from './usage.js';

export const CLAUDE_CAPABILITIES: TransportCapabilities = {
  processModel: 'per-session',
  nativeIds: 'client-allocated',
  resume: 'reattach',
  steer: 'native',
  interrupt: 'terminal-follows',
  images: true,
  enforcement: 'native',
  modelSwitch: 'next-turn',
};

export interface ClaudeTimings {
  /** The `initialize` reply after spawn. */
  initializeTimeoutMs: number;
  /** `probe()` finishes within this deadline. */
  probeDeadlineMs: number;
  /** Control requests (`set_model`, `interrupt`, ...). */
  controlTimeoutMs: number;
  /** After `interrupt` is accepted, wait this long for the turn's `result` before closing the turn locally. */
  interruptGraceMs: number;
  /** Handed to the transport at spawn: after end of input the process gets this long before its group gets SIGTERM. */
  closeGraceMs: number;
  /** Handed to the transport at spawn: after SIGTERM the process gets this long before SIGKILL. */
  termGraceMs: number;
  /** A launch that requires a `SessionStart` hook waits this long after the `initialize` reply for its frame. */
  hookGraceMs: number;
  /** A send the CLI reports cancelled that never started and has no result is closed after this long. */
  cancelSettleMs: number;
  /** `session_state_changed idle` with a turn still open and no `result`: the turn is closed after this long. */
  idleResultGraceMs: number;
  contextUsageTimeoutMs: number;
}

export const DEFAULT_TIMINGS: ClaudeTimings = {
  initializeTimeoutMs: 30_000,
  probeDeadlineMs: 20_000,
  controlTimeoutMs: 15_000,
  interruptGraceMs: 10_000,
  closeGraceMs: 5_000,
  termGraceMs: 5_000,
  hookGraceMs: 1_500,
  cancelSettleMs: 1_500,
  idleResultGraceMs: 1_000,
  contextUsageTimeoutMs: 5_000,
};

export interface ClaudeLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  debug?(fields: object, message: string): void;
}

export interface ClaudeSessionInit {
  sessionId: string;
  cwd: string;
  client: StreamJsonClient;
  log: ClaudeLogger;
  timings: ClaudeTimings;
  configDir: string;
  /** The transcript path known at launch (found on disk for a resume, computed for a new session). */
  transcriptPath?: string;
  /** The model and effort the process was launched with. */
  model?: string;
  effort?: string;
  /** Fail a turn and end the process when `system/init` reports an API-key auth source. */
  requireSubscriptionLogin: boolean;
  /** The session ended: drop it from the instance. `detached` means the process was left running on purpose. */
  onEnded(session: ClaudeSession, kind: 'exited' | 'detached'): void;
}

type ItemKind = Extract<TransportEvent, { type: 'item.completed' }>['kind'];
type RequestKind = Extract<TransportEvent, { type: 'request.opened' }>['kind'];

// ---------------------------------------------------------------------------------------------------------
// Tool mapping

function shorten(text: string, max = 120): string {
  const clean = redactFreeText(text.replace(/\s+/g, ' ').trim(), max + 1);
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** What kind of item a tool call is, by tool name. */
export function toolKind(name: string): ItemKind {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
    case 'PowerShell':
      return 'command';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'file_change';
    case 'WebSearch':
    case 'WebFetch':
    case 'web_search':
    case 'web_fetch':
      return 'search';
    default:
      return 'other';
  }
}

/** Short label for a tool call. Message bodies are never part of the event stream; command text and paths are. */
export function toolTitle(name: string, input: Record<string, unknown> | undefined): string | undefined {
  const field = (key: string): string | undefined => (typeof input?.[key] === 'string' ? (input[key] as string) : undefined);
  if (name.startsWith('mcp__')) {
    const [, server, ...tool] = name.split('__');
    return server ? `${server}/${tool.join('__')}` : name;
  }
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      const command = field('command');
      return command ? shorten(command) : undefined;
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'Read': {
      const file = field('file_path');
      return file ? shorten(file) : undefined;
    }
    case 'NotebookEdit': {
      const file = field('notebook_path');
      return file ? shorten(file) : undefined;
    }
    case 'Glob':
    case 'Grep': {
      const pattern = field('pattern');
      return pattern ? shorten(pattern) : undefined;
    }
    case 'WebSearch': {
      const query = field('query');
      return query ? shorten(query) : undefined;
    }
    case 'WebFetch': {
      const url = field('url');
      return url ? shorten(url) : undefined;
    }
    default:
      return shorten(name, 60);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Turn bookkeeping

interface TurnRecord {
  id: string;
  origin: 'user' | 'provider';
  started: boolean;
  terminal: boolean;
  /** The user message has been written. A record that is not yet sent is dropped, not finalized, when the process ends. */
  sent: boolean;
  /** Set before `interrupt` is sent so a `result` that races it is reported as `interrupted`. */
  interrupt: { timer: NodeJS.Timeout | undefined } | null;
  cancelTimer: NodeJS.Timeout | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  evidence: TurnEvidence;
  /** Every uuid this record is registered under in `byUuid`, for pruning. */
  uuids: string[];
}

/** A send we wrote, by its uuid. `record` moves to a new turn when a steer ends up running as its own turn. */
interface SendEntry {
  uuid: string;
  kind: 'turn' | 'steer';
  record: TurnRecord;
  /** Sent with `priority: 'now'`. */
  preempts: boolean;
}

interface OpenTool {
  turnId: string;
  kind: ItemKind;
  title: string | undefined;
}

interface PendingRequest {
  subtype: 'can_use_tool' | 'elicitation';
  toolName?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  questions?: Array<{ id: string; text: string; multiSelect: boolean }>;
  turnId?: string;
}

const MAX_FINISHED_TURNS = 256;
const MAX_SEEN_ASSISTANT = 2_048;
const MAX_OPEN_TOOLS = 512;

export class ClaudeSession implements TransportSession {
  readonly nativeSessionId: string;
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly events: AsyncIterable<TransportEvent>;

  /** Frames and requests this session did not map to anything, by type. Diagnostics and tests. */
  readonly ignored = new Map<string, number>();

  private readonly channel = new EventChannel();
  private readonly client: StreamJsonClient;
  private readonly log: ClaudeLogger;
  private readonly timings: ClaudeTimings;
  private readonly cwd: string;
  private readonly configDir: string;
  private readonly requireSubscriptionLogin: boolean;
  private readonly onEnded: (session: ClaudeSession, kind: 'exited' | 'detached') => void;
  private readonly rateLimits = new ClaudeRateLimitTracker();
  private readonly byUuid = new Map<string, SendEntry>();
  private readonly finished: TurnRecord[] = [];
  private readonly requests = new Map<string, PendingRequest>();
  private readonly openTools = new Map<string, OpenTool>();
  private readonly seenAssistant = new Set<string>();
  /** Live background tasks the CLI reported, by task id, with the run id each was last seen under. */
  private readonly backgroundTasks = new Map<string, string | undefined>();
  private readonly exitWaiters = new Set<() => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private path: string | undefined;
  private model: string | undefined;
  private effort: string | undefined;
  private observedModel: string | undefined;
  private active: TurnRecord | undefined;
  private pending: TurnRecord | undefined;
  private sending = false;
  private closing = false;
  private ended = false;
  private refused = false;
  private initChecked = false;
  private sessionStartHook = false;
  private firstTerminalSeen = false;
  private contextUsageSupported = true;
  private lastUsage = '';
  private warnedSessionId = false;
  private readonly warnedMcp = new Set<string>();
  private pathRefresh: Promise<string | undefined> | undefined;

  constructor(init: ClaudeSessionInit) {
    this.nativeSessionId = init.sessionId;
    this.cwd = init.cwd;
    this.client = init.client;
    this.log = init.log;
    this.timings = init.timings;
    this.configDir = init.configDir;
    this.path = init.transcriptPath;
    this.model = init.model;
    this.effort = init.effort;
    this.requireSubscriptionLogin = init.requireSubscriptionLogin;
    this.onEnded = init.onEnded;
    this.events = this.channel.iterable();
    // Subscribed at construction: the SessionStart hook frames arrive before the `initialize` reply.
    this.unsubscribe.push(this.client.onFrame((frame) => this.handleFrame(frame)));
    this.client.setServerRequestHandler((open) => this.onServerRequest(open));
    this.unsubscribe.push(this.client.onServerRequestCancelled((requestId) => this.onServerRequestCancelled(requestId)));
    this.unsubscribe.push(this.client.onExit((exit) => this.handleExit(exit)));
  }

  get transcriptPath(): string | undefined {
    return this.path;
  }

  get pid(): number | undefined {
    return this.client.pid;
  }

  /** The id of the turn that has not reached its terminal event, if any. */
  get activeTurn(): string | undefined {
    return this.active?.id ?? this.pending?.id;
  }

  /** True after a `SessionStart` hook frame arrived: the Console's hooks ran in this process. */
  get sawSessionStartHook(): boolean {
    return this.sessionStartHook;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Called once by the instance after the handshake: announces the native id and readiness. */
  announce(): void {
    this.channel.push({ type: 'session.native', nativeSessionId: this.nativeSessionId, ...(this.path ? { transcriptPath: this.path } : {}) });
    this.channel.push({ type: 'session.state', state: 'ready' });
  }

  // -------------------------------------------------------------------------------------------------------
  // TransportSession

  async sendTurn(input: TurnInput): Promise<{ turnId: string }> {
    this.assertWritable();
    if (this.active || this.pending || this.sending) throw new PreviousTurnActiveError();
    // Claim the slot before the first await: a second call must see a turn being sent.
    this.sending = true;
    let record: TurnRecord | undefined;
    try {
      const uuid = this.newUuid(input.clientMessageId);
      await this.applySettings(input);
      const frame = await this.buildUserFrame(uuid, input);
      // Registered before the write: the CLI can answer before the write callback runs.
      record = this.newRecord(uuid, 'user');
      record.sent = false;
      this.pending = record;
      this.byUuid.set(uuid, { uuid, kind: 'turn', record, preempts: false });
      await this.write(frame);
      record.sent = true;
      return { turnId: uuid };
    } catch (error) {
      if (record) {
        if (this.pending === record && !record.started) this.pending = undefined;
        this.forget(record);
      }
      // The process ended before the message was written: nothing reached it.
      if (error instanceof ClaudeExitError) throw new NotSentError(error.message);
      throw error;
    } finally {
      this.sending = false;
    }
  }

  async steer(turnId: string, input: TurnInput): Promise<void> {
    await this.sendSteer(turnId, input, false);
  }

  /** "Send now": the message preempts the running turn, which ends `interrupted`; the message runs as its own turn. */
  async steerNow(turnId: string, input: TurnInput): Promise<void> {
    await this.sendSteer(turnId, input, true);
  }

  async interrupt(turnId: string): Promise<void> {
    const record = this.recordById(turnId);
    if (!record || record.terminal || record.interrupt) return;
    // Mark first: a `result` that races the request still means the person stopped it.
    record.interrupt = { timer: undefined };
    let cancelled: string[] = [];
    try {
      // Stop means stop everything: queued sends are dropped too, or they would start as soon as this turn ends.
      const reply = await this.client.sendControl({ subtype: 'interrupt', cancel_queued: true }, { timeoutMs: this.timings.controlTimeoutMs });
      cancelled = asStringArray((reply.response as InterruptResponseBody | undefined)?.cancelled);
    } catch (error) {
      if (record.terminal) return;
      record.interrupt = null;
      if (error instanceof ClaudeExitError) return; // the exit handler closes the turn
      throw error;
    }
    if (record.terminal) return;
    if (!record.started && cancelled.includes(record.id)) {
      // The CLI dropped it before it ran: no `result` will come.
      this.finalize(record, 'interrupted');
      return;
    }
    record.interrupt.timer = setTimeout(() => this.interruptTimedOut(record), this.timings.interruptGraceMs);
  }

  /**
   * Answers a request. The host closes the request itself once this resolves, so no `request.closed` is emitted for an
   * answer; one is emitted only when the CLI withdraws the request or the turn (or the session) ends first.
   */
  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const request = this.requests.get(requestId);
    if (!request) {
      this.log.debug?.({ requestId, decision: response.decision }, 'claude request is not open');
      return;
    }
    this.requests.delete(requestId);
    try {
      if (request.subtype === 'elicitation') {
        // Forms from MCP servers are not rendered: they are declined (or dismissed when the person cancelled).
        await this.client.respondElicitation(requestId, { action: response.decision === 'cancel' ? 'cancel' : 'decline' });
      } else {
        await this.client.respondCanUseTool(requestId, this.canUseToolAnswer(request, response));
      }
    } catch (error) {
      this.log.warn({ requestId, error: error instanceof Error ? error.message : String(error) }, 'claude request answer failed');
    }
  }

  /** Per-session: unload ends the process. Same staged end as `close`; an idle process exits within about 150 ms of end of input. */
  async unload(): Promise<void> {
    await this.endProcess();
  }

  /**
   * Ends the process: end of input, `closeGraceMs` for it to exit (a running turn finishes first), then SIGTERM to its
   * process group, `termGraceMs`, then SIGKILL. The transport runs these stages (a session host does it for a relayed
   * process); the graces were handed to it at spawn.
   */
  async close(reason: 'release' | 'shutdown' | 'error'): Promise<void> {
    if (!this.ended) this.log.debug?.({ reason, pid: this.pid }, 'claude session closing');
    await this.endProcess();
  }

  private async endProcess(): Promise<void> {
    if (this.ended) return;
    this.beginClosing();
    try {
      await this.client.close({ terminate: true });
    } catch (error) {
      this.log.warn({ pid: this.pid, error: error instanceof Error ? error.message : String(error) }, 'claude close failed');
    }
    if (await this.waitForExit(2_000)) return;
    this.log.warn({ pid: this.pid }, 'claude did not report an exit after it was ended; ending the session locally');
    this.handleExit({ code: null, signal: 'SIGKILL', reason: 'exited' });
  }

  /** Where the transcript is on disk now; announces a corrected path with `session.native`. */
  refreshTranscriptPath(): Promise<string | undefined> {
    this.pathRefresh ??= (async () => {
      const found = locateTranscripts(this.configDir, this.cwd, this.nativeSessionId);
      const next = found.find((file) => file === this.path) ?? found[0];
      if (next && next !== this.path && !this.ended) {
        this.path = next;
        this.channel.push({ type: 'session.native', nativeSessionId: this.nativeSessionId, transcriptPath: next });
      }
      return this.path;
    })().finally(() => {
      this.pathRefresh = undefined;
    });
    return this.pathRefresh;
  }

  /** Reads how full the context is (no model call) and announces it. Best effort. */
  async refreshContextUsage(): Promise<void> {
    if (!this.contextUsageSupported || this.ended || this.closing || this.client.exited) return;
    try {
      const reply = await this.client.sendControl({ subtype: 'get_context_usage', detail: 'summary' }, { timeoutMs: this.timings.contextUsageTimeoutMs });
      const fill = contextFromUsageResponse(reply.response as ContextUsageResponseBody | undefined);
      this.pushUsage(fill.used, fill.max);
    } catch (error) {
      if (!(error instanceof ClaudeExitError)) {
        this.contextUsageSupported = false; // an older CLI, or one that refuses; do not ask again
        this.log.debug?.({ error: error instanceof Error ? error.message : String(error) }, 'claude get_context_usage failed');
      }
    }
  }

  /**
   * The instance is going away (a backend shutdown). Stop listening and end the event stream, then let go of the
   * transport: a session host connection just disconnects and the process lives on for the next backend; a plain
   * stdio child is ended. Open requests are left unanswered on purpose so the next backend can still answer them
   * (the process reports them again when it is re-initialized).
   */
  async detach(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.requests.clear();
    this.disconnect();
    this.channel.push({ type: 'session.state', state: 'stopped' });
    this.wakeExitWaiters();
    this.onEnded(this, 'detached');
    await this.client.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------------------
  // Sending

  private assertWritable(): void {
    if (this.ended || this.closing || this.client.exited) throw new NotSentError('The Claude session has ended.');
  }

  private newUuid(clientMessageId: string | undefined): string {
    // A caller's id is used when it is a uuid, so an idempotent resend after an uncertain write reuses it and the CLI
    // answers "already handled". Anything else gets a fresh uuid: the CLI acks a prompt whose uuid its transcript
    // already holds without running a turn.
    return clientMessageId !== undefined && isUuid(clientMessageId) ? clientMessageId.toLowerCase() : randomUUID();
  }

  private newRecord(id: string, origin: 'user' | 'provider'): TurnRecord {
    return {
      id,
      origin,
      started: false,
      terminal: false,
      sent: true,
      interrupt: null,
      cancelTimer: undefined,
      idleTimer: undefined,
      evidence: newTurnEvidence(),
      uuids: [id],
    };
  }

  private recordById(turnId: string): TurnRecord | undefined {
    if (this.active?.id === turnId) return this.active;
    if (this.pending?.id === turnId) return this.pending;
    return undefined;
  }

  private async applySettings(input: TurnInput): Promise<void> {
    if (input.model && input.model !== this.model) {
      await this.client.sendControl({ subtype: 'set_model', model: input.model }, { timeoutMs: this.timings.controlTimeoutMs });
      this.model = input.model;
    }
    if (input.effort && input.effort !== this.effort) {
      await this.client.sendControl({ subtype: 'apply_flag_settings', settings: { effortLevel: input.effort } }, { timeoutMs: this.timings.controlTimeoutMs });
      this.effort = input.effort;
    }
  }

  /** Images first, then the text: slash-command text still expands that way. */
  private async buildUserFrame(uuid: string, input: TurnInput, priority?: 'now'): Promise<ClaudeUserMessageFrame> {
    const content: ClaudeUserContentBlock[] = [];
    for (const image of input.images ?? []) {
      const data = (await fs.promises.readFile(image.path)).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data } });
    }
    content.push({ type: 'text', text: input.text });
    return {
      type: 'user',
      session_id: '',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid,
      origin: { kind: 'human' },
      ...(priority ? { priority } : {}),
    };
  }

  /** A failed write means nothing was written (the channel was closed), so the caller may send it again. */
  private async write(frame: ClaudeUserMessageFrame): Promise<void> {
    try {
      await this.client.write(frame);
    } catch (error) {
      if (error instanceof ClaudeExitError) throw new NotSentError(error.message);
      throw error;
    }
  }

  private async sendSteer(turnId: string, input: TurnInput, now: boolean): Promise<void> {
    this.assertWritable();
    const record = this.recordById(turnId);
    if (!record || record.terminal) throw new TurnNotActiveError(turnId);
    const uuid = this.newUuid(input.clientMessageId);
    const frame = await this.buildUserFrame(uuid, input, now ? 'now' : undefined);
    // Registered before the write: the CLI can answer before the write callback runs.
    this.byUuid.set(uuid, { uuid, kind: 'steer', record, preempts: now });
    record.uuids.push(uuid);
    try {
      await this.write(frame);
    } catch (error) {
      this.byUuid.delete(uuid);
      record.uuids = record.uuids.filter((entry) => entry !== uuid);
      throw error;
    }
  }

  private forget(record: TurnRecord): void {
    for (const uuid of record.uuids) if (this.byUuid.get(uuid)?.record === record) this.byUuid.delete(uuid);
  }

  // -------------------------------------------------------------------------------------------------------
  // Inbound frames

  private handleFrame(frame: ClaudeFrame): void {
    if (this.ended) return;
    switch (frame.type) {
      case 'command_lifecycle':
        this.onLifecycle(frame as CommandLifecycleFrame);
        return;
      case 'system':
        this.onSystem(frame as SystemFrame);
        return;
      case 'assistant':
        this.onAssistant(frame as AssistantFrame);
        return;
      case 'user':
        this.onUserFrame(frame as UserFrame);
        return;
      case 'result':
        this.onResult(frame as ClaudeResultFrame);
        return;
      case 'rate_limit_event':
        this.onRateLimit(frame as RateLimitEventFrame);
        return;
      case 'stream_event': // partial messages are not enabled; typed and ignored
        return;
      default:
        this.noteIgnored(frame.type);
    }
  }

  private noteIgnored(key: string): void {
    const count = (this.ignored.get(key) ?? 0) + 1;
    this.ignored.set(key, count);
    if (count === 1) this.log.debug?.({ type: key }, 'claude frame not handled');
  }

  // ---- command lifecycle ----

  private onLifecycle(frame: CommandLifecycleFrame): void {
    const uuid = asString(frame.command_uuid);
    const entry = uuid ? this.byUuid.get(uuid) : undefined;
    switch (frame.state) {
      case 'started':
        this.onCommandStarted(uuid, entry);
        return;
      case 'completed':
        this.onCommandCompleted(entry);
        return;
      case 'cancelled':
        this.onCommandCancelled(entry);
        return;
      default: // queued: the send is tracked since it was written
    }
  }

  private onCommandStarted(uuid: string | undefined, entry: SendEntry | undefined): void {
    if (!entry || !uuid) {
      // A command that is not ours: the CLI started a turn on its own (a background task finished).
      this.ensureProviderTurn();
      return;
    }
    if (entry.kind === 'turn') {
      if (entry.record.terminal) return;
      this.supersedeActive(entry.record, false);
      this.markStarted(entry.record);
      return;
    }
    // A steer that runs as its own turn: it found no tool boundary to fold into, or it preempted the running turn.
    const record = this.newRecord(uuid, 'user');
    entry.record = record;
    entry.kind = 'turn';
    this.byUuid.set(uuid, entry);
    this.supersedeActive(record, entry.preempts);
    this.markStarted(record);
  }

  private onCommandCompleted(entry: SendEntry | undefined): void {
    if (!entry || entry.kind === 'steer') return; // a steer folded into the running turn; its result lists the uuid
    const record = entry.record;
    if (record.started || record.terminal) return; // the normal end of a turn, after its result
    if (this.active && !this.active.terminal) return; // folded into a turn that is running; that turn's result ends it
    // Completed with no `started`: the CLI already holds this uuid, so nothing ran. Report the send as handled.
    this.notice('info', 'Claude already had this message, so it was not run again.');
    this.finalize(record, 'completed');
  }

  private onCommandCancelled(entry: SendEntry | undefined): void {
    if (!entry || entry.kind !== 'turn') return;
    const record = entry.record;
    if (record.started || record.terminal || record.cancelTimer) return;
    // Cancelled before it started. A hard failure also reports this, and its `result` follows and ends the turn;
    // when nothing follows the turn would never end, so close it.
    record.cancelTimer = setTimeout(() => {
      record.cancelTimer = undefined;
      if (!record.started && !record.terminal && !this.ended) this.finalize(record, 'interrupted');
    }, this.timings.cancelSettleMs);
  }

  // ---- system frames ----

  private onSystem(frame: SystemFrame): void {
    switch (frame.subtype) {
      case 'init':
        this.onInit(frame as SystemInitFrame);
        return;
      case 'status':
        this.onStatus(frame as SystemStatusFrame);
        return;
      case 'api_retry':
        this.onApiRetry(frame as SystemApiRetryFrame);
        return;
      case 'compact_boundary': {
        const meta = (frame as SystemCompactBoundaryFrame).compact_metadata;
        this.notice('info', `Claude compacted the conversation${typeof meta?.pre_tokens === 'number' ? ` (${meta.pre_tokens} tokens before)` : ''}.`);
        return;
      }
      case 'permission_denied': {
        const denied = frame as SystemPermissionDeniedFrame;
        this.notice('warn', `Claude was not allowed to use ${denied.tool_name ?? 'a tool'}${denied.decision_reason ? `: ${denied.decision_reason}` : '.'}`);
        return;
      }
      case 'informational': {
        const info = frame as SystemInformationalFrame;
        if (info.content) this.notice(info.level === 'warning' || info.level === 'suggestion' ? 'warn' : 'info', info.content);
        return;
      }
      case 'session_state_changed':
        this.onSessionState(frame as SystemSessionStateChangedFrame);
        return;
      case 'hook_started':
      case 'hook_response':
      case 'hook_progress':
        this.onHook(frame as SystemHookFrame);
        return;
      case 'task_started':
      case 'task_updated':
      case 'task_notification':
      case 'background_tasks_changed':
        this.onBackgroundTask(frame as SystemTaskFrame);
        return;
      default: // task_progress and the rest: counted, not mapped
        this.noteIgnored(`system/${String(frame.subtype)}`);
    }
  }

  private onInit(frame: SystemInitFrame): void {
    if (typeof frame.model === 'string') this.observedModel = frame.model;
    if (typeof frame.session_id === 'string' && frame.session_id !== this.nativeSessionId && !this.warnedSessionId) {
      this.warnedSessionId = true;
      this.log.warn({ expected: this.nativeSessionId, reported: frame.session_id }, 'claude reports a different session id than the one launched');
    }
    for (const server of frame.mcp_servers ?? []) {
      if (server.status === 'failed' && typeof server.name === 'string' && !this.warnedMcp.has(server.name)) {
        this.warnedMcp.add(server.name);
        this.notice('warn', `MCP server "${server.name}" failed to start.`);
      }
    }
    if (!this.initChecked) {
      this.initChecked = true;
      const source = frame.apiKeySource;
      if (this.requireSubscriptionLogin && typeof source === 'string' && source !== 'none' && source !== 'oauth') {
        this.refuseApiKey(source);
        return;
      }
    }
    // `system/init` comes once per turn: it proves a turn is running even when no lifecycle frame announced it.
    this.attachTurnFrame(frame);
  }

  // ---- background work ----

  /**
   * True while the CLI reports background tasks of its own (a shell command or subagent left running) that no turn
   * covers. The host reads it before ending an idle process. The state is per process, so it starts empty for every
   * session object; a reattached process reports its current set right behind the repeated `initialize` reply.
   */
  hasBackgroundWork(): boolean {
    return !this.ended && this.backgroundTasks.size > 0;
  }

  /**
   * `background_tasks_changed` is the level signal: it carries every live task and replaces the set, so a missed edge
   * cannot leave a stale indicator behind. `task_started` and the end frames (`task_notification`, a terminal
   * `task_updated`) move one task between those snapshots. Ambient tasks (watchers, housekeeping) are not activity.
   */
  private onBackgroundTask(frame: SystemTaskFrame): void {
    const taskId = asString(frame.task_id);
    const runId = asString(frame.run_id);
    switch (frame.subtype) {
      case 'background_tasks_changed': {
        if (!Array.isArray(frame.tasks)) return;
        this.backgroundTasks.clear();
        for (const task of frame.tasks) {
          const id = isRecord(task) ? asString(task.task_id) : undefined;
          if (id && !task.ambient) this.backgroundTasks.set(id, asString(task.run_id));
        }
        return;
      }
      case 'task_started':
        // A foreground task blocks its own tool call inside the turn; it counts once it moves to the background.
        if (taskId && frame.is_backgrounded !== false && !frame.ambient && !frame.skip_transcript && !this.isLateTaskFrame(taskId, runId)) {
          this.backgroundTasks.set(taskId, runId ?? this.backgroundTasks.get(taskId));
        }
        return;
      case 'task_updated': {
        if (!taskId || this.isLateTaskFrame(taskId, runId)) return;
        const status = frame.patch?.status;
        if (status === 'completed' || status === 'failed' || status === 'killed') this.backgroundTasks.delete(taskId);
        else if (frame.patch?.is_backgrounded === true) this.backgroundTasks.set(taskId, runId ?? this.backgroundTasks.get(taskId));
        return;
      }
      default: // task_notification: the task ended (completed, failed or stopped)
        if (taskId && !this.isLateTaskFrame(taskId, runId)) this.backgroundTasks.delete(taskId);
    }
  }

  /** A frame of an earlier run of a task that has since been resumed under a newer run id (run ids sort in run order). */
  private isLateTaskFrame(taskId: string, runId: string | undefined): boolean {
    const shown = this.backgroundTasks.get(taskId);
    return runId !== undefined && shown !== undefined && runId < shown;
  }

  private onStatus(frame: SystemStatusFrame): void {
    if (frame.status === 'compacting') {
      this.notice('info', 'Claude is compacting the conversation.');
    } else if (frame.status === 'requesting') {
      this.attachTurnFrame(frame);
    }
    if (frame.compact_result === 'failed') this.notice('warn', `Claude could not compact the conversation${frame.compact_error ? `: ${frame.compact_error}` : '.'}`);
  }

  private onApiRetry(frame: SystemApiRetryFrame): void {
    const failure = failureFromApiRetry(frame);
    const record = this.currentRecord();
    if (record) record.evidence.lastRetry = failure;
    const attempt = typeof frame.attempt === 'number' && typeof frame.max_retries === 'number' ? ` (attempt ${frame.attempt} of ${frame.max_retries})` : '';
    this.notice('warn', `Claude is retrying${attempt}: ${failure.message}${typeof frame.error_status === 'number' ? ` HTTP ${frame.error_status}.` : ''}`);
  }

  private onSessionState(frame: SystemSessionStateChangedFrame): void {
    if (frame.state !== 'idle') return;
    const record = this.active;
    if (!record || record.terminal || record.idleTimer) return;
    // Idle is the CLI's authoritative "nothing is running". A turn still open without a `result` lost it.
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.terminal || this.ended) return;
      this.notice('warn', 'Claude went idle without reporting the result of the turn; the turn was closed locally.');
      this.finalize(record, 'failed', { class: 'transport_error', code: 'result_missing', message: 'Claude finished the turn without reporting a result.', retryable: false });
    }, this.timings.idleResultGraceMs);
  }

  private onHook(frame: SystemHookFrame): void {
    if (frame.hook_event !== 'SessionStart') return;
    this.sessionStartHook = true;
    // A hook that prints the transcript path in JSON confirms where the CLI writes.
    const text = asString(frame.output) ?? asString(frame.stdout);
    if (frame.subtype === 'hook_response' && text && text.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as { transcript_path?: unknown };
        if (typeof parsed.transcript_path === 'string' && path.isAbsolute(parsed.transcript_path) && parsed.transcript_path !== this.path) {
          this.path = parsed.transcript_path;
          this.channel.push({ type: 'session.native', nativeSessionId: this.nativeSessionId, transcriptPath: this.path });
        }
      } catch {
        // Not JSON, or not the shape: ignore.
      }
    }
  }

  private onRateLimit(frame: RateLimitEventFrame): void {
    const info = frame.rate_limit_info;
    if (!info) return;
    const update = this.rateLimits.apply(info);
    const record = this.currentRecord();
    if (record) {
      // Evidence for the turn's classification: which limits block the account right now.
      record.evidence.blockedLimits = this.rateLimits.blocked();
    }
    if (update.changed && update.windows.length > 0) {
      this.channel.push({ type: 'usage.updated', windows: update.windows.map((window) => ({ id: window.id, usedPercent: window.usedPercent, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) })) });
    }
    if (update.announce) this.notice('warn', update.announce);
  }

  // ---- assistant and user frames ----

  private onAssistant(frame: AssistantFrame): void {
    if (frame.parent_tool_use_id) return; // a subagent's output is not this conversation
    const uuid = asString(frame.uuid);
    if (uuid) {
      if (this.seenAssistant.has(uuid)) return;
      this.seenAssistant.add(uuid);
      if (this.seenAssistant.size > MAX_SEEN_ASSISTANT) {
        const oldest = this.seenAssistant.values().next().value;
        if (oldest !== undefined) this.seenAssistant.delete(oldest);
      }
    }
    const record = this.attachTurnFrame(frame);
    if (!record) return;
    if (frame.error || frame.is_api_error_message) {
      // The CLI's own message about an API failure (not signed in, rate limited): evidence for the terminal, never agent output.
      if (frame.error === 'authentication_failed') record.evidence.authenticationFailed = true;
      if (frame.error === 'rate_limit') {
        const info = frame.api_error_params?.rate_limit_info;
        if (info?.status === 'rejected') record.evidence.assistantRateLimit = assistantRateLimitEvidence(info);
      }
      return;
    }
    const blocks = Array.isArray(frame.message?.content) ? frame.message.content : [];
    blocks.forEach((block, index) => {
      if (!isRecord(block) || typeof block.type !== 'string') return;
      const baseId = uuid ?? asString(frame.message?.id) ?? randomUUID();
      const itemId = blocks.length > 1 ? `${baseId}:${index}` : baseId;
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.trim().length > 0) this.emitItem(record, itemId, 'assistant');
          return;
        case 'thinking':
          this.emitItem(record, itemId, 'reasoning');
          return;
        case 'tool_use':
        case 'mcp_tool_use': {
          const id = asString(block.id);
          const name = asString(block.name) ?? 'tool';
          if (!id) return;
          if (this.openTools.size >= MAX_OPEN_TOOLS) {
            const oldest = this.openTools.keys().next().value;
            if (oldest !== undefined) this.openTools.delete(oldest);
          }
          const input = isRecord(block.input) ? block.input : undefined;
          this.openTools.set(id, { turnId: record.id, kind: toolKind(name), title: toolTitle(name, input) });
          return;
        }
        case 'server_tool_use': {
          // Run by the API itself (web search): there is no `tool_result` frame to wait for.
          const name = asString(block.name) ?? 'tool';
          const input = isRecord(block.input) ? block.input : undefined;
          this.emitItem(record, asString(block.id) ?? itemId, toolKind(name), toolTitle(name, input));
          return;
        }
        default:
          return;
      }
    });
  }

  private onUserFrame(frame: UserFrame): void {
    if (frame.isReplay || frame.parent_tool_use_id) return;
    const content = frame.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const toolUseId = asString(block.tool_use_id);
      const tool = toolUseId ? this.openTools.get(toolUseId) : undefined;
      if (!toolUseId || !tool) continue;
      this.openTools.delete(toolUseId);
      const record = this.active;
      if (record && record.id === tool.turnId && !record.terminal) this.emitItem(record, toolUseId, tool.kind, tool.title);
    }
  }

  private emitItem(record: TurnRecord, itemId: string, kind: ItemKind, title?: string): void {
    this.channel.push({ type: 'item.completed', turnId: record.id, itemId, kind, replay: false, ...(title ? { title } : {}) });
  }

  // ---- results ----

  private onResult(frame: ClaudeResultFrame): void {
    const uuids = messageUuidsOf(frame);
    const matched = new Set<TurnRecord>();
    for (const uuid of uuids) {
      const entry = this.byUuid.get(uuid);
      if (entry) matched.add(entry.record);
    }
    const live = [...matched].filter((record) => !record.terminal);
    if (matched.size > 0 && live.length === 0) {
      // The result of a turn that was closed locally (interrupt timeout, preempted by "send now").
      this.log.debug?.({ resultIndex: frame.result_index }, 'claude result for a turn that already ended');
      return;
    }
    const targets = new Set<TurnRecord>();
    if (this.active && !this.active.terminal) targets.add(this.active);
    for (const record of live) targets.add(record);
    if (targets.size === 0 && matched.size === 0 && this.pending && !this.pending.terminal && this.pending.sent) targets.add(this.pending);
    if (targets.size === 0) {
      this.noteIgnored('result (no turn)');
      return;
    }
    const primary = this.active && targets.has(this.active) ? this.active : [...targets][0]!;
    const classified = classifyResult(frame, primary.evidence, {
      interruptRequested: [...targets].some((record) => record.interrupt !== null),
      nowMs: Date.now(),
    });
    this.afterResult(frame);
    // One result can end several sends (a message folded into a turn that a person did not start): each gets its terminal.
    for (const record of targets) this.finalize(record, classified.status, classified.failure);
  }

  private afterResult(frame: ClaudeResultFrame): void {
    this.pushUsage(contextUsedFromResultUsage(frame.usage), contextMaxFromModelUsage(frame.modelUsage, this.observedModel));
    void this.refreshContextUsage();
  }

  private pushUsage(used: number | undefined, max: number | undefined): void {
    if (used === undefined && max === undefined) return;
    const key = `${used ?? ''}/${max ?? ''}`;
    if (key === this.lastUsage) return;
    this.lastUsage = key;
    this.channel.push({ type: 'usage.updated', ...(used !== undefined ? { contextUsedTokens: used } : {}), ...(max !== undefined ? { contextMaxTokens: max } : {}) });
  }

  // ---- turn state ----

  private currentRecord(): TurnRecord | undefined {
    return this.active ?? this.pending;
  }

  /** The record a turn-scoped frame belongs to, started if it was not yet; undefined for a late frame of a turn that ended. */
  private attachTurnFrame(frame: { user_message_uuids?: unknown; user_message_uuid?: unknown }): TurnRecord | undefined {
    for (const uuid of messageUuidsOf(frame)) {
      const entry = this.byUuid.get(uuid);
      if (!entry) continue;
      if (entry.record.terminal) return undefined;
      this.markStarted(entry.record);
      return entry.record;
    }
    if (this.active && !this.active.terminal) return this.active;
    if (this.pending && !this.pending.terminal) {
      // No uuid names the turn (an older CLI): with a send in flight, this is its turn.
      this.markStarted(this.pending);
      return this.pending;
    }
    return this.ensureProviderTurn();
  }

  private ensureProviderTurn(): TurnRecord | undefined {
    if (this.active && !this.active.terminal) return this.active;
    const record = this.newRecord(randomUUID(), 'provider');
    this.byUuid.set(record.id, { uuid: record.id, kind: 'turn', record, preempts: false });
    this.markStarted(record);
    return record;
  }

  private markStarted(record: TurnRecord): void {
    if (record.started || record.terminal) return;
    record.started = true;
    if (record.cancelTimer) {
      clearTimeout(record.cancelTimer);
      record.cancelTimer = undefined;
    }
    if (this.pending === record) this.pending = undefined;
    this.active = record;
    record.evidence = newTurnEvidence(this.rateLimits.blocked());
    this.channel.push({ type: 'turn.started', turnId: record.id, origin: record.origin, replay: false });
  }

  /** A new turn starts while another is open without a result: the older one was preempted or lost its result. */
  private supersedeActive(next: TurnRecord, preempted: boolean): void {
    const previous = this.active;
    if (!previous || previous === next || previous.terminal) return;
    if (!preempted) this.log.warn({ turnId: previous.id }, 'claude started another turn before reporting the result of the running one');
    this.finalize(previous, 'interrupted');
  }

  /** The only place that emits `turn.terminal`. */
  private finalize(record: TurnRecord, status: 'completed' | 'interrupted' | 'failed', failure?: ProviderFailure): void {
    if (record.terminal) return;
    this.markStarted(record); // a terminal is always preceded by the turn's start
    record.terminal = true;
    for (const timer of [record.interrupt?.timer, record.cancelTimer, record.idleTimer]) if (timer) clearTimeout(timer);
    record.cancelTimer = undefined;
    record.idleTimer = undefined;
    if (this.active === record) this.active = undefined;
    if (this.pending === record) this.pending = undefined;
    for (const [toolUseId, tool] of this.openTools) if (tool.turnId === record.id) this.openTools.delete(toolUseId);
    for (const [requestId, request] of this.requests) {
      if (request.turnId === record.id) {
        // The turn is over: the CLI no longer waits for the answer.
        this.requests.delete(requestId);
        this.channel.push({ type: 'request.closed', requestId, outcome: 'cancelled' });
      }
    }
    this.finished.push(record);
    if (this.finished.length > MAX_FINISHED_TURNS) {
      const oldest = this.finished.shift();
      if (oldest) this.forget(oldest);
    }
    this.channel.push({
      type: 'turn.terminal',
      turnId: record.id,
      status,
      ...(failure ? { failure } : {}),
      sessionUsable: !this.ended && !this.refused && !this.client.exited,
      replay: false,
    });
    if (!this.firstTerminalSeen) {
      this.firstTerminalSeen = true;
      // The transcript exists once the first turn has run; confirm where.
      void this.refreshTranscriptPath().catch(() => undefined);
    }
  }

  private interruptTimedOut(record: TurnRecord): void {
    if (record.terminal || this.ended) return;
    this.notice('warn', `Claude did not report the interrupted turn within ${Math.round(this.timings.interruptGraceMs / 1000)} s; the turn was closed locally.`);
    this.finalize(record, 'interrupted');
  }

  private notice(level: 'info' | 'warn', text: string): void {
    this.channel.push({ type: 'notice', level, text: shorten(text, 400) });
  }

  // ---- startup refusal ----

  /** `system/init` says the process is on an API key, not the subscription login: end it and fail the turn. */
  private refuseApiKey(source: string): void {
    this.refused = true;
    const message = `Claude is using an API key (${source}) instead of the subscription login; the session was ended.`;
    this.log.warn({ apiKeySource: source }, 'claude came up on an API key');
    const record = this.currentRecord();
    if (record) this.finalize(record, 'failed', { class: 'permission_error', code: 'api_key_source', message, retryable: false });
    void this.close('error');
  }

  // -------------------------------------------------------------------------------------------------------
  // Requests from the CLI

  private onServerRequest(open: OpenServerRequest): void {
    const request = open.request;
    if (this.ended || this.closing) {
      void this.answerClosed(open);
      return;
    }
    // A request always belongs to a turn: the host drops a request that names none when any turn ends. One that arrives
    // before the turn's start was seen means the CLI is running a turn of its own.
    const turnId = (this.currentRecord() ?? this.ensureProviderTurn())?.id;
    if (request.subtype === 'elicitation') {
      const form = request as ElicitationRequest;
      this.requests.set(open.requestId, { subtype: 'elicitation', ...(turnId ? { turnId } : {}) });
      this.channel.push({
        type: 'request.opened',
        requestId: open.requestId,
        kind: 'mcp',
        summary: shorten(`${form.mcp_server_name || 'An MCP server'}: ${form.message || 'elicitation'}`),
        ...(turnId ? { turnId } : {}),
      });
      return;
    }
    const tool = request as CanUseToolRequest;
    if (tool.tool_name === 'AskUserQuestion') {
      const input = tool.input as AskUserQuestionInput;
      const items = Array.isArray(input.questions) ? input.questions : [];
      const questions = items.map((item, index) => ({
        id: `q${index}`,
        ...(item.header ? { header: item.header } : {}),
        question: item.question,
        options: (item.options ?? []).map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
        multiSelect: item.multiSelect === true,
        allowCustom: true, // the CLI always adds an "Other" answer
      }));
      this.requests.set(open.requestId, {
        subtype: 'can_use_tool',
        toolName: tool.tool_name,
        toolUseId: tool.tool_use_id,
        input: tool.input,
        questions: items.map((item, index) => ({ id: `q${index}`, text: item.question, multiSelect: item.multiSelect === true })),
        ...(turnId ? { turnId } : {}),
      });
      const first = items[0];
      this.channel.push({
        type: 'request.opened',
        requestId: open.requestId,
        kind: 'question',
        summary: shorten([first?.header, first?.question].filter(Boolean).join(': ') || 'Claude asked a question.'),
        ...(turnId ? { turnId } : {}),
        questions,
      });
      return;
    }
    // Under bypass only a few things still ask (explicit ask rules, plan approval, cross-session messaging).
    this.requests.set(open.requestId, { subtype: 'can_use_tool', toolName: tool.tool_name, toolUseId: tool.tool_use_id, input: tool.input, ...(turnId ? { turnId } : {}) });
    const kind: RequestKind = 'permission';
    const detail = typeof tool.input?.command === 'string' ? tool.input.command : (tool.description ?? tool.decision_reason ?? '');
    this.channel.push({
      type: 'request.opened',
      requestId: open.requestId,
      kind,
      summary: shorten(`${tool.display_name ?? tool.tool_name}${detail ? `: ${detail}` : ''}`),
      ...(turnId ? { turnId } : {}),
    });
  }

  private onServerRequestCancelled(requestId: string): void {
    if (!this.requests.delete(requestId)) return;
    this.channel.push({ type: 'request.closed', requestId, outcome: 'cancelled' });
  }

  private async answerClosed(open: OpenServerRequest): Promise<void> {
    if (open.request.subtype === 'elicitation') {
      await this.client.respondElicitation(open.requestId, { action: 'decline' });
    } else {
      await this.client.respondCanUseTool(open.requestId, this.denial('Agent Console is closing this session.', open.request as CanUseToolRequest));
    }
  }

  private denial(message: string, request: Pick<CanUseToolRequest, 'tool_use_id'> | PendingRequest): CanUseToolResponse {
    const toolUseId = 'tool_use_id' in request ? request.tool_use_id : request.toolUseId;
    return { behavior: 'deny', message, ...(toolUseId ? { toolUseID: toolUseId } : {}) };
  }

  private canUseToolAnswer(request: PendingRequest, response: RequestResponse): CanUseToolResponse {
    const toolUseID = request.toolUseId ? { toolUseID: request.toolUseId } : {};
    if (request.toolName === 'AskUserQuestion') {
      if (response.decision !== 'answer') {
        return this.denial(response.decision === 'cancel' ? 'The person cancelled the question.' : 'The person declined to answer. Continue without this answer, or ask again in your reply.', request);
      }
      const answers: Record<string, string> = {};
      for (const question of request.questions ?? []) {
        const values = response.answers[question.id] ?? response.answers[question.text];
        if (values && values.length > 0) answers[question.text] = values.join(', ');
      }
      return {
        behavior: 'allow',
        updatedInput: { ...(request.input ?? {}), answers, ...(response.text ? { response: response.text } : {}) },
        ...toolUseID,
      };
    }
    if (response.decision === 'answer') return { behavior: 'allow', updatedInput: request.input ?? {}, ...toolUseID };
    return this.denial('Agent Console did not approve this tool call.', request);
  }

  /** Answers every open request with a denial or decline and tells the consumer. The turn they block can then end. */
  private cancelAllRequests(): void {
    for (const [requestId, request] of [...this.requests]) {
      this.requests.delete(requestId);
      const answer = request.subtype === 'elicitation'
        ? this.client.respondElicitation(requestId, { action: 'decline' })
        : this.client.respondCanUseTool(requestId, this.denial('Agent Console is closing this session.', request));
      answer.catch(() => undefined);
      this.channel.push({ type: 'request.closed', requestId, outcome: 'cancelled' });
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Exit

  private beginClosing(): void {
    if (this.closing) return;
    this.closing = true;
    // A turn blocked on a question would never finish, and end of input waits for the turn.
    this.cancelAllRequests();
  }

  /** The process ended (the stream client reports it, or `close` gave up waiting). */
  private handleExit(exit: StreamJsonExit): void {
    if (this.ended) return;
    const expected = this.closing || this.refused;
    this.ended = true;
    this.clearTimers();
    this.cancelAllRequests();
    const failure = processExitFailure(describeExit(exit));
    if (exit.reason === 'exited') this.client.reapProcessGroup();
    // Whatever was running or queued will never finish: close each turn once.
    for (const record of [this.active, this.pending]) {
      if (record && !record.terminal && record.sent) {
        if (expected) this.finalize(record, 'interrupted');
        else this.finalize(record, 'failed', failure);
      }
    }
    if (!expected) {
      this.log.warn({ pid: this.pid, code: exit.code, signal: exit.signal }, 'claude process exited unexpectedly');
      this.channel.push({ type: 'session.state', state: 'error', failure });
    }
    this.channel.push({ type: 'session.state', state: 'stopped' });
    this.disconnect();
    this.wakeExitWaiters();
    // A lost connection to a session host leaves the process running: it can be found again.
    this.onEnded(this, exit.reason === 'disconnected' ? 'detached' : 'exited');
  }

  private disconnect(): void {
    for (const stop of this.unsubscribe.splice(0)) stop();
    this.client.setServerRequestHandler(undefined);
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.ended) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.exitWaiters.delete(wake);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.exitWaiters.delete(wake);
        resolve(false);
      }, ms);
      this.exitWaiters.add(wake);
    });
  }

  private wakeExitWaiters(): void {
    for (const wake of [...this.exitWaiters]) wake();
  }

  private clearTimers(): void {
    for (const record of [this.active, this.pending]) {
      if (!record) continue;
      for (const timer of [record.interrupt?.timer, record.cancelTimer, record.idleTimer]) if (timer) clearTimeout(timer);
    }
  }
}
