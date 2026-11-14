// One Mistral Vibe conversation as a `TransportSession`. The instance starts or finds `vibe-acp`, runs the handshake and
// hands over a ready session. This class turns ACP traffic into Console events.
//
// A turn is one `session/prompt` request. It ends when that request is answered (`stopReason`), exactly once. There is
// no roster: a turn that was already running when this connection attached is the one whose JSON-RPC id was recorded,
// and it ends when the answer to that id arrives, or when Vibe's saved store shows the turn finished.

import { randomUUID } from 'node:crypto';
import {
  NotSentError,
  PreviousTurnActiveError,
  RequestNotPendingError,
  SendRejectedError,
  type ProviderFailure,
  type RequestResponse,
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
  type JsonRpcId,
  type JsonRpcNotification,
} from '../codex/jsonrpc.js';
import { redactFreeText } from '../codex/redact.js';
import {
  ACP_METHODS,
  DECLINED_PERMISSION,
  INTERRUPT_GRACE_MS,
  asString,
  buildPromptBlocks,
  classifyStandardUpdate,
  completedToolCall,
  isRecord,
  readConfigValue,
  stopReasonStatus,
} from '../acp/index.js';
import { readVibePointer } from '../../vibe-store.js';
import { VIBE_CAPABILITIES, VIBE_RATE_LIMIT_CODE, VIBE_RATE_LIMIT_NOTICE, type VibeTurnRecord } from './protocol.js';

export { VIBE_CAPABILITIES };

export interface VibeTimings {
  initializeTimeoutMs: number;
  requestTimeoutMs: number;
  interruptGraceMs: number;
  closeGraceMs: number;
  termGraceMs: number;
}

export const DEFAULT_VIBE_TIMINGS: VibeTimings = {
  initializeTimeoutMs: 30_000,
  requestTimeoutMs: 30_000,
  interruptGraceMs: INTERRUPT_GRACE_MS,
  closeGraceMs: 5_000,
  termGraceMs: 5_000,
};

export interface VibeLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  debug?(fields: object, message: string): void;
}

export interface VibeSessionInit {
  sessionId: string;
  client: JsonRpcClient;
  log: VibeLogger;
  timings: VibeTimings;
  /** `<vibe home>/logs/session/unified/<session id>`, when the home is known. The store is read, never written, by the plugin. */
  storeDir?: string;
  transcriptPath?: string;
  model?: string;
  thinking?: string;
  /** Models and thinking levels Vibe offered, when the handshake listed them. Empty: a refused setting is Vibe's answer. */
  models?: string[];
  efforts?: string[];
  onTurnRecord(record: VibeTurnRecord | undefined): void;
  onRateLimited(): void;
  onEnded(session: VibeSession, kind: 'exited' | 'detached'): void;
}

type ItemKind = Extract<TransportEvent, { type: 'item.completed' }>['kind'];

interface TurnState {
  id: string;
  origin: 'user' | 'provider';
  adopted: boolean;
  terminal: boolean;
  openBlock?: 'assistant' | 'reasoning';
  blockCount: number;
  hasAssistantText: boolean;
  sawAssistantChunk: boolean;
  tools: Set<string>;
  interruptTimer?: ReturnType<typeof setTimeout>;
}

interface OpenPermission {
  requestId: string;
  turnId?: string;
  resolve(outcome: unknown): void;
}

const MAX_PENDING_PERMISSIONS = 32;

export class VibeSession implements TransportSession {
  readonly nativeSessionId: string;
  readonly capabilities = VIBE_CAPABILITIES;
  readonly events: AsyncIterable<TransportEvent>;
  readonly ignored = new Map<string, number>();

  private readonly channel = new EventChannel();
  private readonly client: JsonRpcClient;
  private readonly log: VibeLogger;
  private readonly timings: VibeTimings;
  private readonly storeDir: string | undefined;
  private readonly path: string | undefined;
  private readonly onTurnRecord: VibeSessionInit['onTurnRecord'];
  private readonly onRateLimited: VibeSessionInit['onRateLimited'];
  private readonly onEnded: VibeSessionInit['onEnded'];
  private readonly unsubscribe: Array<() => void> = [];
  private readonly permissions = new Map<string, OpenPermission>();
  private models: string[];
  private efforts: string[];
  private model: string | undefined;
  private thinking: string | undefined;
  private active: TurnState | undefined;
  private sending = false;
  private ended = false;
  private closing = false;
  /** True while `session/load` replays saved history. Those updates are dropped. */
  private loading = false;
  private subscribed = false;
  private exitWaiters: Array<() => void> = [];
  /** JSON-RPC id of the prompt an earlier backend sent, when this connection adopted that turn. */
  private adoptedRequestId: number | undefined;
  /** Session-start context for the first prompt of a new conversation. Cleared once that prompt is written. */
  private startupContext: string | undefined;

  constructor(init: VibeSessionInit) {
    this.nativeSessionId = init.sessionId;
    this.client = init.client;
    this.log = init.log;
    this.timings = init.timings;
    this.storeDir = init.storeDir;
    this.path = init.transcriptPath;
    this.models = init.models ?? [];
    this.efforts = init.efforts ?? [];
    this.model = init.model;
    this.thinking = init.thinking;
    this.onTurnRecord = init.onTurnRecord;
    this.onRateLimited = init.onRateLimited;
    this.onEnded = init.onEnded;
    this.events = this.channel.iterable();
    // Exit is subscribed now so a process that dies during the handshake is seen. Notifications wait for `subscribe`,
    // so the instance can hand over the ones that arrived before this object existed without delivering them twice.
    this.unsubscribe.push(this.client.onExit(exit => this.handleExit(exit)));
    this.client.handleRequest(ACP_METHODS.requestPermission, params => this.onPermissionRequest(params));
  }

  get transcriptPath(): string | undefined {
    return this.path;
  }

  get pid(): number | undefined {
    return this.client.pid;
  }

  get activeTurn(): string | undefined {
    return this.active && !this.active.terminal ? this.active.id : undefined;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Starts delivering `session/update`. Call once, with no await between it and replaying anything buffered before it. */
  subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.unsubscribe.push(this.client.onNotification(notification => this.ingest(notification)));
  }

  /** One notification that arrived before `subscribe`, or one the instance replayed from that gap. */
  ingest(notification: JsonRpcNotification): void {
    this.handleNotification(notification);
  }

  beginReplay(): () => void {
    this.loading = true;
    return () => { this.loading = false; };
  }

  noteSettings(input: { model?: string; thinking?: string; models?: string[]; efforts?: string[] }): void {
    if (input.model) this.model = input.model;
    if (input.thinking) this.thinking = input.thinking;
    if (input.models?.length) this.models = input.models;
    if (input.efforts?.length) this.efforts = input.efforts;
  }

  /** The coordination block prepended to the first prompt of a new conversation. */
  setStartupContext(text: string): void {
    this.startupContext = text;
  }

  announce(): void {
    this.channel.push({ type: 'session.native', nativeSessionId: this.nativeSessionId, ...(this.path ? { transcriptPath: this.path } : {}) });
    this.channel.push({ type: 'session.state', state: 'ready' });
  }

  /**
   * The process was found with the recorded turn still the one it owes an answer for. Stop reaches it. Its end is the
   * answer to `record.requestId`, or `completeFromStore` when the saved store already shows the turn finished.
   */
  adoptRunningTurn(record: VibeTurnRecord): string | undefined {
    if (this.ended || this.closing) return undefined;
    this.adoptedRequestId = record.requestId;
    if (this.active && !this.active.terminal) return this.active.id;
    this.beginTurn('provider', record.turnId, true);
    this.onTurnRecord(record);
    return record.turnId;
  }

  /** The saved store shows the adopted turn finished while no backend was connected. Ends it once, as completed. */
  completeFromStore(): void {
    const turn = this.active;
    if (!turn || turn.terminal) return;
    this.finalize(turn, 'completed');
  }

  async sendTurn(input: TurnInput): Promise<{ turnId: string }> {
    this.assertWritable();
    if ((this.active && !this.active.terminal) || this.sending) throw new PreviousTurnActiveError();
    this.sending = true;
    try {
      const prefix = this.startupContext;
      const text = prefix ? `${prefix}\n\n${input.text}` : input.text;
      const prompt = await this.buildPrompt({ ...input, text });
      await this.applySettings(input);
      this.assertWritable();
      const baseline = this.readBaseline();
      const turnId = randomUUID();
      const { id, written, result } = this.client.startRequest(ACP_METHODS.prompt, { sessionId: this.nativeSessionId, prompt }, { timeoutMs: 0 });
      try {
        await written;
      } catch (error) {
        if (error instanceof JsonRpcExitError && !error.sent) throw new NotSentError(`The message was not sent: ${this.describeError(error)}`);
        throw error;
      }
      if (id === undefined) throw new NotSentError('The message was not sent: the request was not queued.');
      this.startupContext = undefined;
      const record: VibeTurnRecord = { turnId, requestId: id, startedAt: new Date().toISOString(), ...baseline };
      this.beginTurn('user', turnId, false);
      this.onTurnRecord(record);
      result.then(
        (response) => this.onPromptResponse(turnId, response),
        (error: unknown) => this.onPromptError(turnId, error),
      );
      return { turnId };
    } finally {
      this.sending = false;
    }
  }

  async interrupt(turnId: string): Promise<void> {
    const turn = this.active;
    if (!turn || turn.terminal) return;
    if (turnId !== '' && turn.id !== turnId) return;
    if (this.ended || this.closing || this.client.exited) return;
    await this.client.notify(ACP_METHODS.cancel, { sessionId: this.nativeSessionId });
    clearTimeout(turn.interruptTimer);
    turn.interruptTimer = setTimeout(() => this.finalize(turn, 'interrupted'), this.timings.interruptGraceMs);
  }

  async respond(requestId: string, _response: RequestResponse): Promise<void> {
    const open = this.permissions.get(requestId);
    if (!open) throw new RequestNotPendingError(requestId);
    this.permissions.delete(requestId);
    open.resolve(DECLINED_PERMISSION);
    this.channel.push({ type: 'request.closed', requestId, outcome: 'declined' });
  }

  async unload(): Promise<void> {
    await this.endProcess();
  }

  async close(reason: 'release' | 'shutdown' | 'error'): Promise<void> {
    if (!this.ended) this.log.debug?.({ reason, pid: this.pid }, 'vibe session closing');
    await this.endProcess();
  }

  async detach(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.unsubscribeAll();
    for (const open of this.permissions.values()) open.resolve(DECLINED_PERMISSION);
    this.permissions.clear();
    this.channel.push({ type: 'session.state', state: 'stopped' });
    this.wakeExitWaiters();
    this.onEnded(this, 'detached');
    await this.client.close().catch(() => undefined);
  }

  async setEffort(effort: string): Promise<void> {
    await this.configure('thinking', effort);
    if (this.thinking !== effort) throw new Error('Mistral Vibe did not confirm the requested thinking level.');
  }

  /** Applies one config option and keeps the session's model and thinking in step with Vibe's answer. */
  async configure(configId: 'model' | 'thinking' | 'mode', value: string): Promise<void> {
    this.readOptions(await this.setOption(configId, value));
  }

  /** An extension request (`_trust/status`, `_trust/decision`). Not a turn. */
  requestExtension(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.client.request(method, params, { timeoutMs: this.timings.requestTimeoutMs });
  }

  /**
   * The answer to a `session/prompt` an earlier backend sent. Matched by JSON-RPC id. Any other unmatched frame is ignored,
   * so a late answer cannot close a different turn.
   */
  handleUnmatchedResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const numeric = typeof id === 'number' ? id : undefined;
    if (numeric === undefined || numeric !== this.adoptedRequestId) return;
    const turn = this.active;
    if (!turn || turn.terminal) return;
    if (isRecord(frame.error)) {
      const code = typeof frame.error.code === 'number' ? frame.error.code : -1;
      const message = typeof frame.error.message === 'string' ? frame.error.message : 'JSON-RPC error';
      this.onPromptError(turn.id, new JsonRpcRequestError(ACP_METHODS.prompt, code, message, frame.error.data));
      return;
    }
    if (!isRecord(frame.result) || typeof frame.result.stopReason !== 'string') return;
    this.onPromptResponse(turn.id, frame.result);
  }

  private assertWritable(): void {
    if (this.ended || this.closing || this.client.exited) throw new NotSentError('The Mistral Vibe session has ended.');
  }

  private describeError(error: unknown): string {
    return redactFreeText(error instanceof Error ? error.message : String(error), 300);
  }

  private async buildPrompt(input: TurnInput): Promise<Array<Record<string, unknown>>> {
    return buildPromptBlocks(input, {
      onTransient: (error) => new NotSentError(`The message was not sent: an attachment could not be read (${this.describeError(error)}).`),
      onMissing: () => new SendRejectedError('An attached image is missing or cannot be read, so the message was not sent.'),
    });
  }

  private readBaseline(): { generation?: string; snapshotSequence?: number } {
    if (!this.storeDir) return {};
    const current = readVibePointer(this.storeDir);
    if (!current.ok) return {};
    return { generation: current.pointer.generation, snapshotSequence: current.pointer.snapshotSequence };
  }

  private async applySettings(input: TurnInput): Promise<void> {
    const wantModel = input.model && input.model !== this.model ? input.model : undefined;
    const wantThinking = input.effort && input.effort !== this.thinking ? input.effort : undefined;
    if (!wantModel && !wantThinking) return;
    if (wantModel && this.models.length > 0 && !this.models.includes(wantModel)) {
      throw new SendRejectedError(`Mistral Vibe does not offer the model ${wantModel}.`);
    }
    if (wantThinking && this.efforts.length > 0 && !this.efforts.includes(wantThinking)) {
      throw new SendRejectedError(`Mistral Vibe does not offer the thinking level ${wantThinking}.`);
    }
    try {
      if (wantModel) this.readOptions(await this.setOption('model', wantModel));
      if (input.effort && input.effort !== this.thinking) this.readOptions(await this.setOption('thinking', input.effort));
    } catch (error) {
      if (error instanceof SendRejectedError) throw error;
      if (error instanceof JsonRpcRequestError) throw new SendRejectedError(`Mistral Vibe refused the model setting: ${this.describeError(error)}`);
      const notSent = new NotSentError(`The message was not sent: ${this.describeError(error)}`);
      notSent.cause = error;
      throw notSent;
    }
  }

  private setOption(configId: 'model' | 'thinking' | 'mode', value: string): Promise<unknown> {
    return this.client.request(ACP_METHODS.setConfigOption, { sessionId: this.nativeSessionId, configId, value }, { timeoutMs: this.timings.requestTimeoutMs });
  }

  private readOptions(result: unknown): void {
    const options = isRecord(result) ? result.configOptions : undefined;
    this.model = readConfigValue(options, 'model') ?? this.model;
    this.thinking = readConfigValue(options, 'thinking') ?? this.thinking;
    const models = selectValues(options, 'model');
    const efforts = selectValues(options, 'thinking');
    if (models.length > 0) this.models = models;
    if (efforts.length > 0) this.efforts = efforts;
  }

  private beginTurn(origin: 'user' | 'provider', id: string, adopted: boolean): TurnState {
    const turn: TurnState = { id, origin, adopted, terminal: false, blockCount: 0, hasAssistantText: false, sawAssistantChunk: false, tools: new Set() };
    this.active = turn;
    this.channel.push({ type: 'turn.started', turnId: id, origin, replay: false, ...(adopted ? { adopted: true } : {}) });
    return turn;
  }

  private turnById(turnId: string): TurnState | undefined {
    return this.active?.id === turnId ? this.active : undefined;
  }

  private onPromptResponse(turnId: string, response: unknown): void {
    const turn = this.turnById(turnId);
    if (!turn || turn.terminal) return;
    const record = isRecord(response) ? response : {};
    const { status, notice } = stopReasonStatus(record.stopReason, 'Mistral Vibe');
    if (notice) this.notice('info', notice);
    if (status === 'completed' && !turn.adopted && turn.sawAssistantChunk && !turn.hasAssistantText) {
      this.notice('warn', 'Mistral Vibe finished with an empty response. Check the agent’s work before retrying.');
    }
    const failure = status === 'failed'
      ? { class: 'provider_error' as const, code: String(record.stopReason), message: 'Mistral Vibe declined to answer.', retryable: false }
      : undefined;
    this.finalize(turn, status, failure);
  }

  private onPromptError(turnId: string, error: unknown): void {
    const turn = this.turnById(turnId);
    if (!turn || turn.terminal) return;
    if (error instanceof JsonRpcExitError) return;
    if (error instanceof JsonRpcRequestError && error.code === VIBE_RATE_LIMIT_CODE) {
      this.notice('warn', VIBE_RATE_LIMIT_NOTICE);
      this.onRateLimited();
      this.finalize(turn, 'failed', { class: 'provider_error', code: 'rate_limited', message: VIBE_RATE_LIMIT_NOTICE, retryable: true });
      return;
    }
    if (error instanceof JsonRpcRequestError) {
      this.finalize(turn, 'failed', { class: 'provider_error', code: String(error.code), message: this.describeError(error), retryable: false });
      return;
    }
    this.finalize(turn, 'failed', { class: 'transport_error', message: this.describeError(error) });
  }

  private finalize(turn: TurnState, status: 'completed' | 'interrupted' | 'failed', failure?: ProviderFailure, sessionUsable = true): void {
    if (turn.terminal) return;
    turn.terminal = true;
    clearTimeout(turn.interruptTimer);
    this.closeBlock(turn);
    if (this.active === turn) this.active = undefined;
    this.adoptedRequestId = undefined;
    this.onTurnRecord(undefined);
    this.channel.push({ type: 'turn.terminal', turnId: turn.id, status, ...(failure ? { failure } : {}), sessionUsable, replay: false });
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (this.ended) return;
    const params = isRecord(notification.params) ? notification.params : {};
    if (asString(params.sessionId) && params.sessionId !== this.nativeSessionId) return;
    if (notification.method !== ACP_METHODS.update) {
      this.noteIgnored(notification.method);
      return;
    }
    this.onSessionUpdate(params);
  }

  private noteIgnored(key: string): void {
    this.ignored.set(key, (this.ignored.get(key) ?? 0) + 1);
  }

  private onSessionUpdate(params: Record<string, unknown>): void {
    const update = isRecord(params.update) ? params.update : {};
    const classified = classifyStandardUpdate(update);
    if (classified.action === 'config') {
      this.readOptions(update);
      return;
    }
    if (this.loading) return;
    if (classified.action === 'usage') {
      this.channel.push({
        type: 'usage.updated',
        ...(classified.used !== undefined ? { contextUsedTokens: classified.used } : {}),
        ...(classified.size !== undefined ? { contextMaxTokens: classified.size } : {}),
      });
      return;
    }
    // Only agent content is activity: a notice such as available_commands_update, which Vibe sends after session/new,
    // must not open a provider turn that nothing would ever end.
    switch (classified.action) {
      case 'message':
      case 'thought': {
        const turn = this.ensureTurn();
        if (turn && classified.action === 'message') {
          const content = isRecord(update.content) ? update.content : {};
          if (content.type === 'text' && typeof content.text === 'string') {
            turn.sawAssistantChunk = true;
            if (content.text.trim()) turn.hasAssistantText = true;
          }
        }
        if (turn) this.openBlock(turn, classified.action === 'message' ? 'assistant' : 'reasoning');
        return;
      }
      case 'tool':
      case 'tool-update': {
        const turn = this.ensureTurn();
        if (turn && classified.action === 'tool') {
          turn.hasAssistantText = false;
          turn.sawAssistantChunk = false;
        }
        if (turn) this.onToolCall(turn, update, classified.action === 'tool-update');
        return;
      }
      case 'ignore':
        return;
      default:
        if (classified.type) this.noteIgnored(`${ACP_METHODS.update}:${classified.type}`);
    }
  }

  /** Content that arrives with no turn of ours (a provider-started update) becomes a provider turn. */
  private ensureTurn(): TurnState | undefined {
    if (this.ended || this.closing || this.loading) return undefined;
    if (this.active && !this.active.terminal) return this.active;
    if (this.sending) return undefined;
    return this.beginTurn('provider', randomUUID(), false);
  }

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
    const tool = completedToolCall(update, isUpdate, turn.tools);
    if (!tool) return;
    this.channel.push({
      type: 'item.completed',
      turnId: turn.id,
      itemId: tool.id,
      kind: tool.kind satisfies ItemKind,
      replay: false,
      ...(tool.title ? { title: redactFreeText(tool.title, 200) } : {}),
    });
  }

  private onPermissionRequest(params: unknown): Promise<unknown> {
    const record = isRecord(params) ? params : {};
    if (this.permissions.size >= MAX_PENDING_PERMISSIONS) return Promise.resolve(DECLINED_PERMISSION);
    const toolCall = isRecord(record.toolCall) ? record.toolCall : {};
    const requestId = asString(toolCall.toolCallId) ?? randomUUID();
    const summary = redactFreeText(asString(toolCall.title) ?? 'Mistral Vibe asked for permission', 200);
    return new Promise<unknown>((resolve) => {
      const turnId = this.activeTurn;
      this.permissions.set(requestId, { requestId, ...(turnId ? { turnId } : {}), resolve });
      this.channel.push({ type: 'request.opened', requestId, kind: 'permission', summary, ...(turnId ? { turnId } : {}) });
    });
  }

  private notice(level: 'info' | 'warn', text: string): void {
    this.channel.push({ type: 'notice', level, text });
  }

  private handleExit(exit: JsonRpcExit): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.unsubscribeAll();
    const failure: ProviderFailure = { class: 'transport_error', code: 'process_exited', message: redactFreeText(describeExit(exit), 300) };
    const turn = this.active;
    if (turn && !turn.terminal) this.finalize(turn, 'failed', failure, false);
    for (const open of this.permissions.values()) open.resolve(DECLINED_PERMISSION);
    this.permissions.clear();
    this.channel.push({ type: 'session.state', state: 'stopped', ...(this.closing || exit.expected ? {} : { failure }) });
    this.wakeExitWaiters();
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
      this.log.warn({ pid: this.pid, error: this.describeError(error) }, 'vibe close failed');
    }
    if (await this.waitForExit(2_000)) return;
    this.log.warn({ pid: this.pid }, 'vibe did not report an exit after it was ended; ending the session locally');
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
    if (this.active?.interruptTimer) clearTimeout(this.active.interruptTimer);
  }

  private unsubscribeAll(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }
}

/** Model and thinking as `session/new` or `session/load` reported them. */
export function readVibeSettings(result: unknown): { model?: string; thinking?: string; models: string[]; efforts: string[] } {
  const options = isRecord(result) ? result.configOptions : undefined;
  const model = readConfigValue(options, 'model');
  const thinking = readConfigValue(options, 'thinking');
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    models: selectValues(options, 'model'),
    efforts: selectValues(options, 'thinking'),
  };
}

function selectValues(options: unknown, id: string): string[] {
  if (!Array.isArray(options)) return [];
  for (const option of options) {
    if (!isRecord(option) || option.id !== id || !Array.isArray(option.options)) continue;
    return option.options.flatMap(item => (isRecord(item) && asString(item.value) ? [asString(item.value)!] : []));
  }
  return [];
}
