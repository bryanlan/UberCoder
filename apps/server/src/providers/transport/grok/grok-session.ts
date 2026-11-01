// One Grok conversation as a `TransportSession`: a `grok agent stdio` process that speaks ACP, one conversation per process
// (`processModel: 'per-session'`). The instance (`grok-instance.ts`) starts or finds the process, runs the handshake and hands
// over a ready session; this class turns ACP traffic into the Console's transport events and the Console's calls into ACP requests.
//
// What a turn looks like on the wire (grok 1.0.70):
//   client  session/prompt {sessionId, prompt:[{type:'text',...}]}         the request stays open for the whole turn
//   agent   session/update {agent_thought_chunk | agent_message_chunk | tool_call | tool_call_update | ...}   notifications
//   agent   _x.ai/session_notification {turn_completed, stop_reason, usage}   Grok's own end-of-turn event
//   agent   response to session/prompt {stopReason}                          end_turn | cancelled | refusal | max_*
// A turn the person started ends with the response; a turn Grok starts itself (a background task finished and woke it) has
// no request, so its end is `turn_completed`. Either one ends the turn, whichever comes first, exactly once.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  NotSentError,
  PreviousTurnActiveError,
  RequestNotPendingError,
  SendRejectedError,
  type ProviderFailure,
  type RequestResponse,
  type TransportCapabilities,
  type TransportEvent,
  type TransportSession,
  type TurnInput,
} from '../types.js';
import { EventChannel } from '../claude/event-channel.js';
import {
  JsonRpcExitError,
  JsonRpcRequestError,
  describeExit,
  type JsonRpcClient,
  type JsonRpcExit,
  type JsonRpcNotification,
} from '../codex/jsonrpc.js';
import { redactFreeText } from '../codex/redact.js';
import {
  ACP,
  asNumber,
  asString,
  classifyGrokFailure,
  isRecord,
  itemKindForTool,
  readConfigValue,
  readModels,
  stopReasonStatus,
  type GrokModel,
} from './protocol.js';

export const GROK_CAPABILITIES: TransportCapabilities = {
  processModel: 'per-session',
  nativeIds: 'server-allocated',
  resume: 'reattach',
  // A second prompt sent mid-turn would queue inside Grok behind the running one, not fold into it, so the Console queues it
  // itself and sends it when the turn ends.
  steer: 'none',
  interrupt: 'terminal-follows',
  images: true,
  enforcement: 'host',
  modelSwitch: 'next-turn',
};

export interface GrokTimings {
  initializeTimeoutMs: number;
  /** Requests other than the turn itself (`session/new`, `session/load`, `session/set_config_option`, the roster). */
  requestTimeoutMs: number;
  /** After `session/cancel`, wait this long for the turn to end before closing it locally. */
  interruptGraceMs: number;
  closeGraceMs: number;
  termGraceMs: number;
}

export const DEFAULT_GROK_TIMINGS: GrokTimings = {
  initializeTimeoutMs: 30_000,
  requestTimeoutMs: 30_000,
  interruptGraceMs: 10_000,
  closeGraceMs: 5_000,
  termGraceMs: 5_000,
};

export interface GrokLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  debug?(fields: object, message: string): void;
}

/** The turn in flight, kept by the instance in plugin meta so a new backend learns that a surviving process was running one. */
export interface GrokTurnRecord {
  turnId: string;
  startedAt: string;
}

export interface GrokSessionInit {
  sessionId: string;
  cwd: string;
  client: JsonRpcClient;
  log: GrokLogger;
  timings: GrokTimings;
  /** Where Grok keeps this conversation (`updates.jsonl`), when known. */
  transcriptPath?: string;
  models: GrokModel[];
  model?: string;
  effort?: string;
  /** The current turn changed (started, or ended). The instance stores it. */
  onTurnRecord(record: GrokTurnRecord | undefined): void;
  onTurnCompleted(): void;
  onEnded(session: GrokSession, kind: 'exited' | 'detached'): void;
}

type ItemKind = Extract<TransportEvent, { type: 'item.completed' }>['kind'];

interface TurnState {
  id: string;
  /** Grok's own id for the prompt, once an update names it. Events that name a different prompt belong to another turn. */
  promptId?: string;
  origin: 'user' | 'provider';
  adopted: boolean;
  terminal: boolean;
  /** The kind of message block that is still being streamed (closed into one `item.completed` when it changes). */
  openBlock?: 'assistant' | 'reasoning';
  blockCount: number;
  tools: Set<string>;
  interruptTimer?: NodeJS.Timeout;
  /** Largest context size reported during the turn. */
  contextTokens?: number;
}

interface OpenPermission {
  requestId: string;
  turnId?: string;
  resolve(outcome: unknown): void;
}

const MAX_PENDING_PERMISSIONS = 32;
const MAX_FINISHED_PROMPTS = 64;

function isTransientFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EMFILE' || code === 'ENFILE' || code === 'EAGAIN' || code === 'EBUSY' || code === 'EIO' || code === 'ENOMEM';
}

export class GrokSession implements TransportSession {
  readonly nativeSessionId: string;
  readonly capabilities = GROK_CAPABILITIES;
  readonly events: AsyncIterable<TransportEvent>;

  /** Notifications this session did not map to anything, by type. Diagnostics and tests. */
  readonly ignored = new Map<string, number>();

  private readonly channel = new EventChannel();
  private readonly client: JsonRpcClient;
  private readonly log: GrokLogger;
  private readonly timings: GrokTimings;
  private readonly cwd: string;
  private readonly path: string | undefined;
  private readonly onTurnRecord: GrokSessionInit['onTurnRecord'];
  private readonly onTurnCompleted: GrokSessionInit['onTurnCompleted'];
  private readonly onEnded: GrokSessionInit['onEnded'];
  private readonly unsubscribe: Array<() => void> = [];
  private readonly permissions = new Map<string, OpenPermission>();
  private readonly backgroundTasks = new Set<string>();
  private models: GrokModel[];
  private model: string | undefined;
  private effort: string | undefined;
  private active: TurnState | undefined;
  private sending = false;
  private ended = false;
  private closing = false;
  /** True while `session/load` streams the saved history back: those updates describe the past and are dropped. */
  private loading = false;
  private exitWaiters: Array<() => void> = [];
  /** Grok prompt ids whose turn already ended: Grok sends several end-of-prompt signals, and a late one must not end the next turn. */
  private readonly finishedPrompts: string[] = [];

  constructor(init: GrokSessionInit) {
    this.nativeSessionId = init.sessionId;
    this.cwd = init.cwd;
    this.client = init.client;
    this.log = init.log;
    this.timings = init.timings;
    this.path = init.transcriptPath;
    this.models = init.models;
    this.model = init.model;
    this.effort = init.effort;
    this.onTurnRecord = init.onTurnRecord;
    this.onTurnCompleted = init.onTurnCompleted;
    this.onEnded = init.onEnded;
    this.events = this.channel.iterable();
    this.unsubscribe.push(this.client.onNotification(notification => this.handleNotification(notification)));
    this.unsubscribe.push(this.client.onExit(exit => this.handleExit(exit)));
    this.client.handleRequest(ACP.requestPermission, params => this.onPermissionRequest(params));
  }

  get transcriptPath(): string | undefined {
    return this.path;
  }

  get pid(): number | undefined {
    return this.client.pid;
  }

  /** The id of the turn that has not reached its terminal event, if any. */
  get activeTurn(): string | undefined {
    return this.active && !this.active.terminal ? this.active.id : undefined;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Marks the replay of saved history (`session/load`): updates until `done()` is called are dropped. */
  beginReplay(): () => void {
    this.loading = true;
    return () => { this.loading = false; };
  }

  /** What the handshake read: the models, and the model and effort the session runs on right now. */
  noteSettings(input: { models?: GrokModel[]; model?: string; effort?: string }): void {
    if (input.models?.length) this.models = input.models;
    if (input.model) this.model = input.model;
    if (input.effort) this.effort = input.effort;
  }

  /** Called once by the instance after the handshake: announces the native id and readiness. */
  announce(): void {
    this.channel.push({ type: 'session.native', nativeSessionId: this.nativeSessionId, ...(this.path ? { transcriptPath: this.path } : {}) });
    this.channel.push({ type: 'session.state', state: 'ready' });
  }

  /**
   * The process was found in the middle of a turn that this object did not see begin (a backend restart left it running). The
   * turn is the session's from here on: Stop reaches it, a suspend is refused as a running turn, and its end is reported once.
   */
  adoptRunningTurn(turnId: string = randomUUID()): string | undefined {
    if (this.ended || this.closing) return undefined;
    if (this.active && !this.active.terminal) return this.active.id;
    return this.beginTurn('provider', turnId, true).id;
  }

  // -------------------------------------------------------------------------------------------------------
  // TransportSession

  async sendTurn(input: TurnInput): Promise<{ turnId: string }> {
    this.assertWritable();
    if ((this.active && !this.active.terminal) || this.sending) throw new PreviousTurnActiveError();
    // Claim the slot before the first await: a second call must see a turn being sent.
    this.sending = true;
    try {
      const prompt = await this.buildPrompt(input);
      await this.applySettings(input);
      this.assertWritable();
      const turnId = randomUUID();
      const { written, result } = this.client.startRequest('session/prompt', { sessionId: this.nativeSessionId, prompt }, { timeoutMs: 0 });
      try {
        await written;
      } catch (error) {
        // The channel certainly wrote nothing: the caller may queue the message and try again.
        if (error instanceof JsonRpcExitError && !error.sent) throw new NotSentError(`The message was not sent: ${this.describeError(error)}`);
        throw error;
      }
      const turn = this.beginTurn('user', turnId, false);
      result.then(
        (response) => this.onPromptResponse(turn, response),
        (error: unknown) => this.onPromptError(turn, error),
      );
      return { turnId };
    } finally {
      this.sending = false;
    }
  }

  async interrupt(turnId: string): Promise<void> {
    const turn = this.active;
    if (!turn || turn.terminal) return;
    // An empty id means "the turn that is running, whose id the host does not know" (an adopted turn).
    if (turnId !== '' && turn.id !== turnId) return;
    if (this.ended || this.closing || this.client.exited) return;
    await this.client.notify(ACP.cancel, { sessionId: this.nativeSessionId });
    // The response normally follows within a moment. A process that stays silent must not leave the turn open for ever.
    clearTimeout(turn.interruptTimer);
    turn.interruptTimer = setTimeout(() => this.finalize(turn, 'interrupted'), this.timings.interruptGraceMs);
  }

  async respond(requestId: string, _response: RequestResponse): Promise<void> {
    const open = this.permissions.get(requestId);
    if (!open) throw new RequestNotPendingError(requestId);
    this.permissions.delete(requestId);
    // The Console has no approval screen and Grok runs with --always-approve, so a request that does reach here is declined.
    open.resolve({ outcome: { outcome: 'cancelled' } });
    this.channel.push({ type: 'request.closed', requestId, outcome: 'declined' });
  }

  /** Per-session: unload ends the process, as `close` does. The next load resumes by native id. */
  async unload(): Promise<void> {
    await this.endProcess();
  }

  async close(reason: 'release' | 'shutdown' | 'error'): Promise<void> {
    if (!this.ended) this.log.debug?.({ reason, pid: this.pid }, 'grok session closing');
    await this.endProcess();
  }

  hasBackgroundWork(): boolean {
    return this.backgroundTasks.size > 0;
  }

  /**
   * The instance is going away (a backend shutdown). Stop listening and end the event stream, then let go of the transport: a
   * session host connection disconnects and the process lives on for the next backend; a plain stdio child is ended.
   */
  async detach(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.unsubscribeAll();
    for (const open of this.permissions.values()) open.resolve({ outcome: { outcome: 'cancelled' } });
    this.permissions.clear();
    this.channel.push({ type: 'session.state', state: 'stopped' });
    this.wakeExitWaiters();
    this.onEnded(this, 'detached');
    await this.client.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------------------
  // Sending

  private assertWritable(): void {
    if (this.ended || this.closing || this.client.exited) throw new NotSentError('The Grok session has ended.');
  }

  private describeError(error: unknown): string {
    return redactFreeText(error instanceof Error ? error.message : String(error), 300);
  }

  /** The prompt blocks: the text, then any images (base64, as ACP's `image` content block). */
  private async buildPrompt(input: TurnInput): Promise<Array<Record<string, unknown>>> {
    const blocks: Array<Record<string, unknown>> = [];
    for (const image of input.images ?? []) {
      let data: Buffer;
      try {
        data = await fs.promises.readFile(image.path);
      } catch (error) {
        if (isTransientFileError(error)) throw new NotSentError(`The message was not sent: an attachment could not be read (${this.describeError(error)}).`);
        throw new SendRejectedError('An attached image is missing or cannot be read, so the message was not sent.');
      }
      blocks.push({ type: 'image', data: data.toString('base64'), mimeType: image.mimeType });
    }
    blocks.push({ type: 'text', text: input.text });
    return blocks;
  }

  /**
   * Switches the session to the turn's model and effort when they differ from what it runs on (`session/set_config_option`, which
   * Grok applies at once and keeps for the saved conversation). Nothing has reached the model when this fails: a refused model or
   * effort cannot work on a retry ({@link SendRejectedError}); a lost connection or a timeout may ({@link NotSentError}).
   */
  private async applySettings(input: TurnInput): Promise<void> {
    const wantModel = input.model && input.model !== this.model ? input.model : undefined;
    const wantEffort = input.effort && input.effort !== this.effort ? input.effort : undefined;
    if (!wantModel && !wantEffort) return;
    if (wantModel && this.models.length > 0 && !this.models.some(model => model.id === wantModel)) {
      throw new SendRejectedError(`Grok does not offer the model ${wantModel}.`);
    }
    try {
      // Model first: the efforts a model accepts depend on it.
      if (wantModel) this.readOptions(await this.setOption('model', wantModel));
      if (wantEffort) this.readOptions(await this.setOption('reasoning_effort', wantEffort));
    } catch (error) {
      if (error instanceof JsonRpcRequestError) {
        throw new SendRejectedError(`Grok refused the model setting: ${this.describeError(error)}`);
      }
      const notSent = new NotSentError(`The message was not sent: ${this.describeError(error)}`);
      notSent.cause = error;
      throw notSent;
    }
  }

  private setOption(configId: 'model' | 'reasoning_effort', value: string): Promise<unknown> {
    return this.client.request(ACP.setConfigOption, { sessionId: this.nativeSessionId, configId, value }, { timeoutMs: this.timings.requestTimeoutMs });
  }

  private readOptions(result: unknown): void {
    const options = isRecord(result) ? result.configOptions : undefined;
    this.model = readConfigValue(options, 'model') ?? this.model;
    this.effort = readConfigValue(options, 'reasoning_effort') ?? this.effort;
  }

  // -------------------------------------------------------------------------------------------------------
  // Turns

  private beginTurn(origin: 'user' | 'provider', id: string, adopted: boolean): TurnState {
    const turn: TurnState = { id, origin, adopted, terminal: false, blockCount: 0, tools: new Set() };
    this.active = turn;
    this.channel.push({ type: 'turn.started', turnId: id, origin, replay: false, ...(adopted ? { adopted: true } : {}) });
    // A turn Grok started by itself has no request of ours; it is still a turn a restarted backend must find.
    this.onTurnRecord({ turnId: id, startedAt: new Date().toISOString() });
    return turn;
  }

  /** Content for a turn nobody asked for (Grok woke itself after a background task): it becomes a provider turn. */
  private ensureProviderTurn(): TurnState | undefined {
    if (this.ended || this.closing || this.loading) return undefined;
    if (this.active && !this.active.terminal) return this.active;
    if (this.sending) return undefined; // our own prompt is being written; its turn is created when the write is done
    return this.beginTurn('provider', randomUUID(), false);
  }

  private onPromptResponse(turn: TurnState, response: unknown): void {
    const record = isRecord(response) ? response : {};
    const { status, notice } = stopReasonStatus(record.stopReason);
    const meta = isRecord(record._meta) ? record._meta : {};
    const total = asNumber(meta.totalTokens);
    if (total !== undefined) turn.contextTokens = total;
    if (notice) this.notice('info', notice);
    this.finalize(turn, status, status === 'failed' ? { class: 'provider_error', code: String(record.stopReason), message: 'Grok declined to answer.', retryable: false } : undefined, true, asString(meta.promptId));
  }

  private onPromptError(turn: TurnState, error: unknown): void {
    if (turn.terminal) return;
    if (error instanceof JsonRpcExitError) {
      // The process ended under the turn; `handleExit` reports it.
      return;
    }
    if (error instanceof JsonRpcRequestError) {
      const failure = classifyGrokFailure(error.code, this.describeError(error), error.data);
      this.finalize(turn, 'failed', { ...failure, message: redactFreeText(failure.message, 300) });
      return;
    }
    this.finalize(turn, 'failed', { class: 'transport_error', message: this.describeError(error) });
  }

  /** False for an end-of-prompt signal that names a prompt other than the turn's (an earlier turn's signal arriving late). */
  private signalIsForTurn(turn: TurnState, promptId: string | undefined): boolean {
    if (!promptId) return true;
    if (this.finishedPrompts.includes(promptId)) return false;
    return !turn.promptId || turn.promptId === promptId;
  }

  private noteFinishedPrompt(...ids: Array<string | undefined>): void {
    for (const id of ids) {
      if (!id || this.finishedPrompts.includes(id)) continue;
      this.finishedPrompts.push(id);
      if (this.finishedPrompts.length > MAX_FINISHED_PROMPTS) this.finishedPrompts.shift();
    }
  }

  private finalize(turn: TurnState, status: 'completed' | 'interrupted' | 'failed', failure?: ProviderFailure, sessionUsable = true, promptId?: string): void {
    if (turn.terminal) return;
    turn.terminal = true;
    this.noteFinishedPrompt(turn.promptId, promptId);
    clearTimeout(turn.interruptTimer);
    this.closeBlock(turn);
    if (this.active === turn) this.active = undefined;
    this.onTurnRecord(undefined);
    // Context fill is known at the end of a turn only (the prompt response and `turn_completed` carry it).
    const max = this.models.find(model => model.id === this.model)?.contextTokens;
    if (turn.contextTokens !== undefined) {
      this.channel.push({ type: 'usage.updated', contextUsedTokens: turn.contextTokens, ...(max !== undefined ? { contextMaxTokens: max } : {}) });
    }
    this.channel.push({ type: 'turn.terminal', turnId: turn.id, status, ...(failure ? { failure } : {}), sessionUsable, replay: false });
    if (status === 'completed') this.onTurnCompleted();
  }

  // -------------------------------------------------------------------------------------------------------
  // Notifications

  private handleNotification(notification: JsonRpcNotification): void {
    if (this.ended) return;
    const params = isRecord(notification.params) ? notification.params : {};
    if (asString(params.sessionId) && params.sessionId !== this.nativeSessionId) return; // another conversation's traffic
    switch (notification.method) {
      case ACP.update:
        this.onSessionUpdate(params);
        return;
      case ACP.extUpdate:
        this.onExtUpdate(params);
        return;
      case ACP.extPromptComplete:
        this.onPromptComplete(params);
        return;
      default:
        this.noteIgnored(notification.method);
    }
  }

  private noteIgnored(key: string): void {
    this.ignored.set(key, (this.ignored.get(key) ?? 0) + 1);
  }

  private onSessionUpdate(params: Record<string, unknown>): void {
    const update = isRecord(params.update) ? params.update : {};
    const type = asString(update.sessionUpdate);
    const meta = isRecord(params._meta) ? params._meta : {};
    // Settings changes show up whatever else is going on, including during a load.
    if (type === 'config_option_update') {
      this.readOptions(update);
      return;
    }
    if (this.loading) return; // saved history streamed back by session/load
    const total = asNumber(meta.totalTokens);
    const promptId = asString(meta.promptId);
    switch (type) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const turn = this.ensureProviderTurn();
        if (!turn) return;
        if (promptId && !turn.promptId) turn.promptId = promptId;
        if (total !== undefined) turn.contextTokens = total;
        this.openBlock(turn, type === 'agent_message_chunk' ? 'assistant' : 'reasoning');
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const turn = this.ensureProviderTurn();
        if (!turn) return;
        if (promptId && !turn.promptId) turn.promptId = promptId;
        if (total !== undefined) turn.contextTokens = total;
        this.onToolCall(turn, update, type === 'tool_call_update');
        return;
      }
      case 'user_message_chunk':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'plan':
      case 'session_info_update':
        return; // not activity of the agent
      default:
        if (type) this.noteIgnored(`${ACP.update}:${type}`);
    }
  }

  /** One `item.completed` per block of streamed text: it is emitted when the block ends, not for every chunk. */
  private openBlock(turn: TurnState, kind: 'assistant' | 'reasoning'): void {
    if (turn.openBlock === kind) return;
    this.closeBlock(turn);
    turn.openBlock = kind;
  }

  private closeBlock(turn: TurnState): void {
    const kind = turn.openBlock;
    if (!kind) return;
    turn.openBlock = undefined;
    turn.blockCount += 1;
    this.channel.push({ type: 'item.completed', turnId: turn.id, itemId: `${turn.id}:${kind}:${turn.blockCount}`, kind, replay: false });
  }

  private onToolCall(turn: TurnState, update: Record<string, unknown>, isUpdate: boolean): void {
    this.closeBlock(turn);
    const toolCallId = asString(update.toolCallId);
    if (!toolCallId) return;
    const status = asString(update.status);
    if (isUpdate && (status === 'completed' || status === 'failed') && !turn.tools.has(toolCallId)) {
      turn.tools.add(toolCallId);
      const title = asString(update.title);
      this.channel.push({
        type: 'item.completed',
        turnId: turn.id,
        itemId: toolCallId,
        kind: itemKindForTool(update.kind, title) satisfies ItemKind,
        replay: false,
        ...(title ? { title: redactFreeText(title, 200) } : {}),
      });
    }
  }

  private onExtUpdate(params: Record<string, unknown>): void {
    const update = isRecord(params.update) ? params.update : {};
    switch (asString(update.sessionUpdate)) {
      case 'turn_completed': {
        const turn = this.active;
        const promptId = asString(update.prompt_id);
        if (!turn || turn.terminal || this.loading || !this.signalIsForTurn(turn, promptId)) return;
        const usage = isRecord(update.usage) ? update.usage : {};
        const total = asNumber(usage.totalTokens);
        if (total !== undefined && turn.contextTokens === undefined) turn.contextTokens = total;
        const { status, notice } = stopReasonStatus(update.stop_reason);
        if (notice) this.notice('info', notice);
        this.finalize(turn, status, undefined, true, promptId);
        return;
      }
      case 'task_backgrounded': {
        const id = asString(update.task_id);
        if (id) this.backgroundTasks.add(id);
        return;
      }
      case 'task_completed': {
        const snapshot = isRecord(update.task_snapshot) ? update.task_snapshot : {};
        const id = asString(snapshot.task_id) ?? asString(update.task_id);
        if (id) this.backgroundTasks.delete(id);
        return;
      }
      case 'background_tasks': {
        const tasks = Array.isArray(update.tasks) ? update.tasks : [];
        this.backgroundTasks.clear();
        for (const task of tasks) {
          const id = isRecord(task) ? (asString(task.task_id) ?? asString(task.id)) : undefined;
          if (id) this.backgroundTasks.add(id);
        }
        return;
      }
      case 'retry_state': {
        if (update.type === 'retrying') {
          this.notice('warn', `Grok is retrying a failed model call (attempt ${asNumber(update.attempt) ?? '?'}).`);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Grok's own end-of-prompt event. The response to `session/prompt` is the canonical end; this covers an adopted turn. */
  private onPromptComplete(params: Record<string, unknown>): void {
    const turn = this.active;
    const promptId = asString(params.promptId);
    if (!turn || turn.terminal || this.loading || !this.signalIsForTurn(turn, promptId)) return;
    const { status } = stopReasonStatus(params.stopReason);
    this.finalize(turn, status, undefined, true, promptId);
  }

  /**
   * The answer to a `session/prompt` that an earlier backend sent, arriving on this connection after a restart. It ends the
   * adopted turn. Anything that is not a prompt answer is ignored.
   */
  handleUnmatchedResponse(frame: Record<string, unknown>): void {
    const turn = this.active;
    const result = isRecord(frame.result) ? frame.result : undefined;
    if (!turn || turn.terminal || !result || typeof result.stopReason !== 'string') return;
    const meta = isRecord(result._meta) ? result._meta : {};
    if (!this.signalIsForTurn(turn, asString(meta.promptId))) return;
    this.onPromptResponse(turn, result);
  }

  // -------------------------------------------------------------------------------------------------------
  // Requests from the agent

  private onPermissionRequest(params: unknown): Promise<unknown> {
    const record = isRecord(params) ? params : {};
    if (this.permissions.size >= MAX_PENDING_PERMISSIONS) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const toolCall = isRecord(record.toolCall) ? record.toolCall : {};
    const requestId = asString(toolCall.toolCallId) ?? randomUUID();
    const summary = redactFreeText(asString(toolCall.title) ?? 'Grok asked for permission', 200);
    return new Promise<unknown>((resolve) => {
      const turnId = this.activeTurn;
      this.permissions.set(requestId, { requestId, ...(turnId ? { turnId } : {}), resolve });
      this.channel.push({ type: 'request.opened', requestId, kind: 'permission', summary, ...(turnId ? { turnId } : {}) });
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Ending

  private notice(level: 'info' | 'warn', text: string): void {
    this.channel.push({ type: 'notice', level, text });
  }

  private handleExit(exit: JsonRpcExit): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.unsubscribeAll();
    const failure: ProviderFailure = {
      class: 'transport_error',
      code: 'process_exited',
      message: redactFreeText(describeExit(exit), 300),
    };
    const turn = this.active;
    if (turn && !turn.terminal) this.finalize(turn, 'failed', failure, false);
    for (const open of this.permissions.values()) open.resolve({ outcome: { outcome: 'cancelled' } });
    this.permissions.clear();
    this.channel.push({ type: 'session.state', state: 'stopped', ...(this.closing || exit.expected ? {} : { failure }) });
    this.wakeExitWaiters();
    // A detached connection leaves the process running; anything else means nothing is left to reattach to.
    this.onEnded(this, exit.reason === 'disconnected' ? 'detached' : 'exited');
  }

  private async endProcess(): Promise<void> {
    if (this.ended) return;
    this.closing = true;
    const turn = this.active;
    if (turn && !turn.terminal) clearTimeout(turn.interruptTimer);
    try {
      await this.client.close({ terminate: true });
    } catch (error) {
      this.log.warn({ pid: this.pid, error: this.describeError(error) }, 'grok close failed');
    }
    if (await this.waitForExit(2_000)) return;
    this.log.warn({ pid: this.pid }, 'grok did not report an exit after it was ended; ending the session locally');
    this.handleExit({ code: null, signal: 'SIGKILL', reason: 'exited', expected: true, stderrTail: '' });
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.ended) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private wakeExitWaiters(): void {
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const wake of waiters) wake();
  }

  private clearTimers(): void {
    if (this.active) clearTimeout(this.active.interruptTimer);
  }

  private unsubscribeAll(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }
}

/** The model list and current model a `session/new` or `session/load` answer carries. */
export function readSessionSettings(result: unknown): { models: GrokModel[]; model?: string; effort?: string } {
  const record = isRecord(result) ? result : {};
  const { current, models } = readModels(record.models);
  const model = readConfigValue(record.configOptions, 'model') ?? current;
  const effort = readConfigValue(record.configOptions, 'reasoning_effort');
  return { models, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
