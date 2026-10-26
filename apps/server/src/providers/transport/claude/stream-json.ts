// A client for the Claude Code CLI's stream-json protocol over a `LineTransport`.
//
// What it owns:
//   - writing frames (one JSON object per line) and routing inbound frames by `type`;
//   - control requests the client sends, matched to their `control_response` by `request_id`, each with a timeout;
//   - the registry of control requests the CLI sends (`can_use_tool`, `elicitation`): every one is answered, by the
//     session that registered a handler or, failing that, by a safe default, because an unanswered request blocks
//     the turn forever. A control subtype it does not know gets a `control_response` error at once;
//   - exit propagation: a pending control request fails with {@link ClaudeExitError} when the channel ends.
// It never logs a whole frame (frames carry prompts, tool inputs and command output): only type, subtype, uuid,
// request id and size. It knows nothing about turns; the session interprets the frames.

import type { LineTransport } from '../types.js';
import { transportOutlivesClose, transportStderrTail } from '../line-transport.js';
import { redactedLogValue, redactFreeText } from '../codex/redact.js';
import {
  asString,
  isRecord,
  type CanUseToolResponse,
  type ClaudeFrame,
  type ControlResponseFrame,
  type ControlSuccessResponse,
  type ElicitationResponse,
  type InboundServerRequest,
  type OutboundControlRequest,
} from './protocol.js';

export const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;

export interface StreamJsonLogger {
  debug?(fields: object, message: string): void;
  warn?(fields: object, message: string): void;
}

export interface StreamJsonExit {
  code: number | null;
  signal: string | null;
  reason: 'exited' | 'disconnected';
  /** Set when the transport ended the channel itself (an oversized line) or lost it to another client. */
  error?: Error;
}

/** The channel ended while a request was pending or being sent. */
export class ClaudeExitError extends Error {
  readonly exit: StreamJsonExit;
  /** False when the request was refused before any byte was written. */
  readonly sent: boolean;
  constructor(exit: StreamJsonExit, sent = true) {
    super(`The Claude process ended (${describeExit(exit)}).`);
    this.name = 'ClaudeExitError';
    this.exit = exit;
    this.sent = sent;
  }
}

/** The CLI answered a control request with `subtype: 'error'`. */
export class ClaudeControlError extends Error {
  readonly requestSubtype: string;
  constructor(requestSubtype: string, message: string) {
    super(redactFreeText(`${requestSubtype}: ${message}`, 500));
    this.name = 'ClaudeControlError';
    this.requestSubtype = requestSubtype;
  }
}

export class ClaudeControlTimeoutError extends Error {
  readonly requestSubtype: string;
  readonly timeoutMs: number;
  constructor(requestSubtype: string, timeoutMs: number) {
    super(`${requestSubtype} did not answer within ${timeoutMs} ms.`);
    this.name = 'ClaudeControlTimeoutError';
    this.requestSubtype = requestSubtype;
    this.timeoutMs = timeoutMs;
  }
}

export function describeExit(exit: StreamJsonExit): string {
  if (exit.error) return exit.error.message;
  if (exit.reason === 'disconnected') return 'connection lost';
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? 'unknown'}`;
}

/** A request the CLI sent that the client has not answered yet. */
export interface OpenServerRequest {
  requestId: string;
  request: InboundServerRequest;
}

export type ServerRequestHandler = (open: OpenServerRequest) => void;

interface PendingControl {
  subtype: string;
  resolve(value: ControlSuccessResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | undefined;
}

export interface StreamJsonClientOptions {
  transport: LineTransport;
  log?: StreamJsonLogger;
  /** Used in log messages. */
  label?: string;
  controlTimeoutMs?: number;
}

export class StreamJsonClient {
  /** Counters for diagnostics and tests. */
  readonly stats = { frames: 0, keepAlives: 0, parseFailures: 0, controlResponses: 0, unmatchedControlResponses: 0, serverRequests: 0, unsupportedRequests: 0 };

  private readonly transport: LineTransport;
  private readonly log: StreamJsonLogger;
  private readonly label: string;
  private readonly controlTimeoutMs: number;
  private readonly pending = new Map<string, PendingControl>();
  private readonly open = new Map<string, OpenServerRequest>();
  private readonly frameListeners = new Set<(frame: ClaudeFrame) => void>();
  private readonly cancelListeners = new Set<(requestId: string) => void>();
  private readonly exitListeners = new Set<(exit: StreamJsonExit) => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private serverRequestHandler: ServerRequestHandler | undefined;
  private nextId = 1;
  private finished: StreamJsonExit | undefined;

  constructor(options: StreamJsonClientOptions) {
    this.transport = options.transport;
    this.log = options.log ?? {};
    this.label = options.label ?? 'claude';
    this.controlTimeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    // Exit first: a transport that already ended reports it from `onExit` at once.
    this.unsubscribe.push(this.transport.onLine((line) => this.handleLine(line)));
    this.unsubscribe.push(this.transport.onExit((info) => this.handleExit(info)));
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  get exited(): boolean {
    return this.finished !== undefined;
  }

  get exitInfo(): StreamJsonExit | undefined {
    return this.finished;
  }

  /** Requests the CLI sent that are still waiting for an answer. */
  openServerRequests(): OpenServerRequest[] {
    return [...this.open.values()];
  }

  // -------------------------------------------------------------------------------------------------------
  // Subscriptions

  /** Frames that are not control frames, in arrival order. A throwing listener is logged and skipped. */
  onFrame(listener: (frame: ClaudeFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** The CLI withdrew a request it sent (`control_cancel_request`); no answer is due any more. */
  onServerRequestCancelled(listener: (requestId: string) => void): () => void {
    this.cancelListeners.add(listener);
    return () => this.cancelListeners.delete(listener);
  }

  /** Fires once when the channel ends. Called at once when it already has. */
  onExit(listener: (exit: StreamJsonExit) => void): () => void {
    if (this.finished) {
      listener(this.finished);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Installs the one handler for `can_use_tool` and `elicitation`. It runs synchronously when the request arrives
   * and answers now or later with {@link respondCanUseTool} / {@link respondElicitation}. Without a handler, or if it
   * throws, the client denies or declines the request itself.
   */
  setServerRequestHandler(handler: ServerRequestHandler | undefined): void {
    this.serverRequestHandler = handler;
  }

  // -------------------------------------------------------------------------------------------------------
  // Outbound

  /** Writes one frame. Rejects (nothing written) when the channel is closed. */
  async write(frame: object): Promise<void> {
    if (this.finished) throw new ClaudeExitError(this.finished, false);
    const line = JSON.stringify(frame);
    this.log.debug?.(this.describe('out', frame as Record<string, unknown>, line.length), `${this.label} protocol`);
    try {
      await this.transport.write(line);
    } catch (error) {
      if (this.finished) throw new ClaudeExitError(this.finished, false);
      throw error;
    }
  }

  /**
   * Sends a control request and resolves with its success reply. Rejects with {@link ClaudeControlError} (error
   * reply), {@link ClaudeControlTimeoutError}, or {@link ClaudeExitError}. A timed-out request is withdrawn.
   */
  async sendControl(request: OutboundControlRequest, options: { timeoutMs?: number } = {}): Promise<ControlSuccessResponse> {
    if (this.finished) throw new ClaudeExitError(this.finished, false);
    const requestId = `console-${this.nextId}`;
    this.nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.controlTimeoutMs;
    const reply = new Promise<ControlSuccessResponse>((resolve, reject) => {
      const entry: PendingControl = { subtype: request.subtype, resolve, reject, timer: undefined };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new ClaudeControlTimeoutError(request.subtype, timeoutMs));
          this.write({ type: 'control_cancel_request', request_id: requestId }).catch(() => undefined);
        }, timeoutMs);
      }
      this.pending.set(requestId, entry);
    });
    reply.catch(() => undefined); // the caller awaits it below; a write failure must not leave it unhandled
    try {
      await this.write({ type: 'control_request', request_id: requestId, request });
    } catch (error) {
      const entry = this.pending.get(requestId);
      this.pending.delete(requestId);
      if (entry?.timer) clearTimeout(entry.timer);
      throw error;
    }
    return reply;
  }

  /** Answers a `can_use_tool` request. Returns false when it is not open (already answered, withdrawn or never seen). */
  async respondCanUseTool(requestId: string, body: CanUseToolResponse): Promise<boolean> {
    return this.respondSuccess(requestId, body as unknown as Record<string, unknown>);
  }

  /** Answers an `elicitation` request. Returns false when it is not open. */
  async respondElicitation(requestId: string, body: ElicitationResponse): Promise<boolean> {
    return this.respondSuccess(requestId, body as unknown as Record<string, unknown>);
  }

  /** Answers any open request with a `control_response` error. Returns false when it is not open. */
  async respondError(requestId: string, message: string): Promise<boolean> {
    return this.answer(requestId, { subtype: 'error', request_id: requestId, error: message });
  }

  /**
   * Closes the transport. A stdio transport ends the child (end of input, then SIGTERM, then SIGKILL to its group, with
   * the graces given at spawn); a session host transport only disconnects, leaving the child running, unless
   * `terminate` is set, which makes the host end the child the same way. Call it once: a transport keeps the answer to
   * its first call.
   */
  close(options: { terminate?: boolean } = {}): Promise<void> {
    return this.transport.close(options);
  }

  /**
   * After the CLI exited, signals what is left of its process group. MCP servers and shell commands the CLI started
   * can outlive it (T3 Code found the same), and a stdio child leads its own group. A session host reaps its own
   * group, so a transport that outlives `close()` is left alone.
   */
  reapProcessGroup(): void {
    const pid = this.transport.pid;
    if (pid === undefined || pid <= 1 || transportOutlivesClose(this.transport)) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Nothing left in the group.
    }
  }

  /** Last bytes of the child's stderr (redacted), for logs. Empty when the transport keeps none. */
  stderrTail(): string {
    return redactFreeText(transportStderrTail(this.transport), 600);
  }

  /**
   * Registers requests that were already open when this client attached (the `pending_permission_requests` of a
   * repeated `initialize`) and runs them through the handler like fresh ones.
   */
  adoptServerRequests(frames: unknown): void {
    if (!Array.isArray(frames)) return;
    for (const frame of frames) {
      if (isRecord(frame) && frame.type === 'control_request') this.handleControlRequest(frame);
    }
  }

  /** Stops listening. The transport is left as it is: a relay keeps the child alive for the next backend. */
  detach(): void {
    for (const stop of this.unsubscribe.splice(0)) stop();
    this.frameListeners.clear();
    this.cancelListeners.clear();
    this.serverRequestHandler = undefined;
  }

  // -------------------------------------------------------------------------------------------------------
  // Inbound

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.stats.parseFailures += 1;
      this.log.warn?.({ bytes: line.length }, `${this.label} wrote a line that is not JSON`);
      return;
    }
    if (!isRecord(frame) || typeof frame.type !== 'string') {
      this.stats.parseFailures += 1;
      return;
    }
    this.stats.frames += 1;
    this.log.debug?.(this.describe('in', frame, line.length), `${this.label} protocol`);
    switch (frame.type) {
      case 'control_response':
        this.handleControlResponse(frame as unknown as ControlResponseFrame);
        return;
      case 'control_request':
        this.handleControlRequest(frame);
        return;
      case 'control_cancel_request':
        this.handleControlCancel(asString(frame.request_id));
        return;
      case 'keep_alive':
        this.stats.keepAlives += 1;
        return;
      default:
        for (const listener of [...this.frameListeners]) {
          try {
            listener(frame as ClaudeFrame);
          } catch (error) {
            this.log.warn?.({ type: frame.type, error: error instanceof Error ? error.message : String(error) }, `${this.label} frame listener threw`);
          }
        }
    }
  }

  private handleControlResponse(frame: ControlResponseFrame): void {
    this.stats.controlResponses += 1;
    const response = (isRecord(frame.response) ? frame.response : undefined) as Record<string, unknown> | undefined;
    const requestId = asString(response?.request_id);
    const entry = requestId ? this.pending.get(requestId) : undefined;
    if (!entry || !requestId || !response) {
      this.stats.unmatchedControlResponses += 1;
      this.log.debug?.({ requestId }, `${this.label} answered a control request nobody waits for`);
      return;
    }
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (response.subtype === 'error') {
      entry.reject(new ClaudeControlError(entry.subtype, typeof response.error === 'string' ? response.error : 'the request failed'));
      return;
    }
    entry.resolve(response as ControlSuccessResponse);
  }

  private handleControlRequest(frame: Record<string, unknown>): void {
    const requestId = asString(frame.request_id);
    const request = isRecord(frame.request) ? frame.request : undefined;
    const subtype = asString(request?.subtype);
    if (!requestId || !request || !subtype) {
      this.log.warn?.({ requestId }, `${this.label} sent a malformed control request`);
      return;
    }
    if (subtype !== 'can_use_tool' && subtype !== 'elicitation') {
      this.stats.unsupportedRequests += 1;
      this.log.debug?.({ requestId, subtype }, `${this.label} sent an unsupported control request`);
      this.rawAnswer({ subtype: 'error', request_id: requestId, error: `Unsupported control request: ${subtype}` });
      return;
    }
    this.stats.serverRequests += 1;
    const open: OpenServerRequest = { requestId, request: request as unknown as InboundServerRequest };
    this.open.set(requestId, open);
    const handler = this.serverRequestHandler;
    if (!handler) {
      this.answerByDefault(open, 'no handler is installed');
      return;
    }
    try {
      handler(open);
    } catch (error) {
      this.log.warn?.({ requestId, subtype, error: error instanceof Error ? error.message : String(error) }, `${this.label} server request handler threw`);
      this.answerByDefault(open, 'the handler failed');
    }
  }

  private handleControlCancel(requestId: string | undefined): void {
    if (!requestId || !this.open.delete(requestId)) return;
    for (const listener of [...this.cancelListeners]) {
      try {
        listener(requestId);
      } catch (error) {
        this.log.warn?.({ requestId, error: error instanceof Error ? error.message : String(error) }, `${this.label} cancel listener threw`);
      }
    }
  }

  private handleExit(info: StreamJsonExit): void {
    if (this.finished) return;
    this.finished = info;
    const failure = new ClaudeExitError(info);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(failure);
    }
    this.open.clear();
    for (const listener of [...this.exitListeners]) {
      try {
        listener(info);
      } catch (error) {
        this.log.warn?.({ error: error instanceof Error ? error.message : String(error) }, `${this.label} exit listener threw`);
      }
    }
    this.exitListeners.clear();
  }

  // -------------------------------------------------------------------------------------------------------
  // Answers

  private async respondSuccess(requestId: string, body: Record<string, unknown>): Promise<boolean> {
    return this.answer(requestId, { subtype: 'success', request_id: requestId, response: body });
  }

  private async answer(requestId: string, response: ControlResponseFrame['response']): Promise<boolean> {
    if (!this.open.delete(requestId)) return false;
    try {
      await this.write({ type: 'control_response', response });
    } catch (error) {
      // The channel is gone; nobody waits for the answer.
      this.log.debug?.({ requestId, error: error instanceof Error ? error.message : String(error) }, `${this.label} could not answer a server request`);
    }
    return true;
  }

  /** Synchronous, in order with the frames around it: used where no session is there to decide. */
  private rawAnswer(response: ControlResponseFrame['response']): void {
    this.write({ type: 'control_response', response }).catch(() => undefined);
  }

  private answerByDefault(open: OpenServerRequest, why: string): void {
    this.log.warn?.({ requestId: open.requestId, subtype: open.request.subtype, why }, `${this.label} answered a server request by default`);
    this.open.delete(open.requestId);
    if (open.request.subtype === 'elicitation') {
      this.rawAnswer({ subtype: 'success', request_id: open.requestId, response: { action: 'decline' } });
      return;
    }
    const toolUseId = asString((open.request as { tool_use_id?: unknown }).tool_use_id);
    const body: CanUseToolResponse = { behavior: 'deny', message: 'Agent Console cannot answer this request right now.', ...(toolUseId ? { toolUseID: toolUseId } : {}) };
    this.rawAnswer({ subtype: 'success', request_id: open.requestId, response: body as unknown as Record<string, unknown> });
  }

  /** Type, subtype, uuid, request id and size only. Frames can carry whole prompts, diffs and command output. */
  private describe(direction: 'in' | 'out', frame: Record<string, unknown>, bytes: number): object {
    const request = isRecord(frame.request) ? frame.request : undefined;
    const response = isRecord(frame.response) ? frame.response : undefined;
    return {
      direction,
      bytes,
      type: frame.type,
      ...(typeof frame.subtype === 'string' ? { subtype: frame.subtype } : {}),
      ...(typeof request?.subtype === 'string' ? { requestSubtype: request.subtype } : {}),
      ...(typeof frame.uuid === 'string' ? { uuid: frame.uuid } : {}),
      ...(typeof frame.command_uuid === 'string' ? { commandUuid: frame.command_uuid } : {}),
      ...(typeof frame.state === 'string' ? { state: frame.state } : {}),
      ...(typeof frame.request_id === 'string' ? { requestId: frame.request_id } : {}),
      ...(typeof response?.request_id === 'string' ? { requestId: response.request_id, responseSubtype: response.subtype } : {}),
      ...(response?.subtype === 'error' ? { error: redactedLogValue(response.error) } : {}),
    };
  }
}
