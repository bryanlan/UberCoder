// Plain-TypeScript JSON-RPC client over a `LineTransport` (newline-delimited JSON, no `jsonrpc` field), ported from
// the patterns in T3 Code's `packages/effect-codex-app-server/src/protocol.ts`
// (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md):
//   - a table of pending requests keyed by numeric id starting at 1;
//   - routing of incoming frames by shape (method + id = server request, method only = notification,
//     id + result/error = response);
//   - every pending request fails when the channel ends.
// Differences: per-request timeouts, and server request handlers that always answer (an unknown method gets a
// `-32601` reply). Starting the process, line splitting, the stderr tail and the staged close belong to the
// transport (`../line-transport.ts`): a stdio child, or a session host that outlives the Console backend.

import { transportStderrTail, type LineTransportExit } from '../line-transport.js';
import { NotSentError, type LineTransport } from '../types.js';
import { redactedLogValue, redactFreeText } from './redact.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_CONCURRENT_SERVER_REQUEST_HANDLERS = 32;

export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const JSON_RPC_OVERLOADED = -32001;

export type JsonRpcId = string | number;

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
  emittedAtMs?: number;
}

export interface JsonRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** `exited`: the process ended. `disconnected`: the channel to a session host dropped; the process may still be running. */
  reason: 'exited' | 'disconnected';
  /** True when {@link JsonRpcClient.close} was called before the channel ended. */
  expected: boolean;
  /** Last bytes of stderr (ANSI stripped). */
  stderrTail: string;
  /** Set when the connection was ended by the channel itself (oversized line, another client took over the host). */
  error?: Error;
}

export interface JsonRpcRequestOptions<T = unknown> {
  /** Defaults to the client's `defaultRequestTimeoutMs`. `0` disables the timeout. */
  timeoutMs?: number;
  /**
   * Runs synchronously when the response frame is routed, before any later frame of the same read is
   * processed and before the returned promise settles. Use it to register state that notifications arriving
   * right behind the response depend on. An exception is logged and does not fail the request.
   */
  onResult?: (result: T) => void;
}

export interface JsonRpcServerRequestContext {
  id: JsonRpcId;
  method: string;
}

/** Handlers answer by returning a value (the `result`) or throwing {@link JsonRpcReplyError} / any error. */
export type JsonRpcServerRequestHandler = (params: unknown, context: JsonRpcServerRequestContext) => unknown | Promise<unknown>;

export interface JsonRpcLogger {
  debug?(fields: object, message: string): void;
  warn?(fields: object, message: string): void;
}

export interface JsonRpcClientOptions {
  log?: JsonRpcLogger;
  defaultRequestTimeoutMs?: number;
}

/** The server answered a request with a JSON-RPC error. */
export class JsonRpcRequestError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcRequestError';
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

/** The channel ended (the process exited or the connection to its session host dropped) while a request was pending or being sent. */
export class JsonRpcExitError extends Error {
  readonly exit: JsonRpcExit;
  /** False when the request was refused before any byte was written, so it certainly did not reach the process. A request already written when a session host connection dropped is `true`: the host may have passed it on. */
  readonly sent: boolean;
  constructor(exit: JsonRpcExit, message?: string, sent = true) {
    // The message can become a conversation status line, so it names only how the process ended; the redacted
    // stderr tail stays on `exit.stderrTail` and in `describeExit` for the server log.
    super(message ?? (exit.reason === 'disconnected' ? `The connection ended (${exitReason(exit)}).` : `The process ended (${exitReason(exit)}).`));
    this.name = 'JsonRpcExitError';
    this.exit = exit;
    this.sent = sent;
  }
}

export class JsonRpcTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`${method} did not answer within ${timeoutMs} ms.`);
    this.name = 'JsonRpcTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class JsonRpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonRpcProtocolError';
  }
}

export class JsonRpcSpawnError extends Error {
  constructor(command: string, cause: unknown) {
    super(`Could not start "${command}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'JsonRpcSpawnError';
    this.cause = cause;
  }
}

/** Thrown by a server-request handler to answer with a specific JSON-RPC error. */
export class JsonRpcReplyError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcReplyError';
    this.code = code;
    this.data = data;
  }
}

/** How the process ended, in one short phrase and without any process output: "exit code 1", "signal SIGKILL", "the connection to the session host was lost". */
export function exitReason(exit: JsonRpcExit): string {
  if (exit.error) return exit.error.message;
  if (exit.reason === 'disconnected') return 'the connection to the session host was lost';
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? 'unknown'}`;
}

/** One-line description of how the process ended, with the last stderr lines (redacted) when there are any. For logs and errors, not for conversation lines. */
export function describeExit(exit: JsonRpcExit): string {
  const how = exit.error ? exit.error.message : exit.reason === 'disconnected' ? 'the connection to the session host was lost' : exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`;
  const tail = exit.stderrTail.replace(ANSI_PATTERN, '').trim().split('\n').slice(-3).join(' | ');
  return redactFreeText(`The ${exit.reason === 'disconnected' ? 'connection' : 'process'} ended (${how})${tail ? `: ${tail}` : '.'}`, 600);
}

interface PendingRequest {
  method: string;
  onResult: ((result: never) => void) | undefined;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

export class JsonRpcClient {
  /** Counters for diagnostics and tests. */
  readonly stats = { notifications: 0, serverRequests: 0, unroutableFrames: 0, parseFailures: 0 };

  private readonly transport: LineTransport;
  private readonly log: JsonRpcLogger;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();
  private readonly exitHandlers = new Set<(exit: JsonRpcExit) => void>();
  private readonly requestHandlers = new Map<string, JsonRpcServerRequestHandler>();
  private readonly defaultTimeoutMs: number;
  private nextId = 1;
  private activeServerRequests = 0;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private finished: JsonRpcExit | undefined;
  private finishedResolvers: Array<() => void> = [];

  /** Takes over the transport: from here on this client is its only reader and writer. */
  constructor(transport: LineTransport, options: JsonRpcClientOptions = {}) {
    this.transport = transport;
    this.log = options.log ?? {};
    this.defaultTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    transport.onLine((line) => this.handleLine(line));
    transport.onExit((info) => this.finish(info));
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  get exited(): boolean {
    return this.finished !== undefined;
  }

  get exitInfo(): JsonRpcExit | undefined {
    return this.finished;
  }

  /** Last bytes of stderr with ANSI colour codes removed. Diagnostics only; never parse it. */
  stderrTail(): string {
    return transportStderrTail(this.transport);
  }

  request<T = unknown>(method: string, params?: unknown, options: JsonRpcRequestOptions<T> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.finished) {
        reject(this.exitError(false));
        return;
      }
      const id = this.nextId;
      this.nextId += 1;
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      const entry: PendingRequest = {
        method,
        onResult: options.onResult as ((result: never) => void) | undefined,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: undefined,
      };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new JsonRpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.writeFrame({ id, method, ...(params !== undefined ? { params } : {}) }).catch((error: unknown) => {
        // Only a channel that certainly wrote nothing makes the request "not sent". Any other write failure leaves the
        // outcome unknown: the request stays pending and the channel's exit fails it as sent.
        if (!(error instanceof NotSentError) || this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(this.exitError(false));
      });
    });
  }

  /** Sends a notification. Rejects with {@link JsonRpcExitError} (`sent: false`) when the channel has ended. */
  notify(method: string, params?: unknown): Promise<void> {
    if (this.finished) return Promise.reject(this.exitError(false));
    return this.writeFrame({ method, ...(params !== undefined ? { params } : {}) }).catch((error: unknown) => {
      throw error instanceof NotSentError ? this.exitError(false) : error;
    });
  }

  /** Subscribes to server notifications. Returns the unsubscribe function. */
  onNotification(handler: (notification: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Subscribes to the end of the channel. Fires once. */
  onExit(handler: (exit: JsonRpcExit) => void): () => void {
    if (this.finished) {
      handler(this.finished);
      return () => undefined;
    }
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** Registers the answer for one server-request method. Methods without a handler get `-32601`. */
  handleRequest(method: string, handler: JsonRpcServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Closes the channel and resolves once it is gone. What that does to the process is the transport's: a stdio child
   * is ended (stdin EOF, SIGTERM, SIGKILL, each after a grace period); a session host connection only disconnects, the
   * process keeps running, unless `terminate` asks the host to end it.
   */
  close(options: { terminate?: boolean } = {}): Promise<void> {
    this.closePromise ??= this.closeNow(options);
    return this.closePromise;
  }

  private async closeNow(options: { terminate?: boolean }): Promise<void> {
    this.closing = true;
    if (this.finished) return;
    try {
      await this.transport.close(options);
    } catch (error) {
      this.log.warn?.({ error: error instanceof Error ? error.message : String(error) }, 'closing the codex app-server connection failed');
    }
    await this.waitFinished(2_000);
  }

  private waitFinished(ms: number): Promise<boolean> {
    if (this.finished) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.finishedResolvers.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private writeFrame(frame: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(frame);
    this.log.debug?.(this.describeFrame('out', frame, line.length + 1), 'codex protocol');
    return this.transport.write(line);
  }

  private exitError(sent = true): JsonRpcExitError {
    const exit = this.finished ?? { code: null, signal: null, reason: 'exited' as const, expected: this.closing, stderrTail: this.stderrTail() };
    return new JsonRpcExitError(exit, exit.error ? exit.error.message : undefined, sent);
  }

  private finish(info: LineTransportExit): void {
    if (this.finished) return;
    const exit: JsonRpcExit = {
      code: info.code,
      signal: info.signal as NodeJS.Signals | null,
      reason: info.reason,
      expected: this.closing,
      stderrTail: this.stderrTail(),
      ...(info.error ? { error: info.error } : {}),
    };
    this.finished = exit;
    const failure = new JsonRpcExitError(exit, info.error ? info.error.message : undefined);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(failure);
    }
    for (const handler of [...this.exitHandlers]) {
      try {
        handler(exit);
      } catch (handlerError) {
        this.log.warn?.({ error: String(handlerError) }, 'codex exit handler threw');
      }
    }
    this.exitHandlers.clear();
    this.notificationHandlers.clear();
    for (const resolve of this.finishedResolvers) resolve();
    this.finishedResolvers = [];
  }

  private handleLine(line: string): void {
    if (this.finished || line.trim().length === 0) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.stats.parseFailures += 1;
      this.log.warn?.({ bytes: line.length }, 'codex app-server wrote a line that is not JSON');
      return;
    }
    if (!isRecord(frame)) {
      this.stats.unroutableFrames += 1;
      return;
    }
    this.log.debug?.(this.describeFrame('in', frame, line.length), 'codex protocol');
    const method = frame.method;
    if (typeof method === 'string') {
      if (isJsonRpcId(frame.id)) {
        this.stats.serverRequests += 1;
        this.handleServerRequest(frame.id, method, frame.params);
      } else if (!('id' in frame)) {
        this.stats.notifications += 1;
        this.dispatchNotification({
          method,
          ...('params' in frame ? { params: frame.params } : {}),
          ...(typeof frame.emittedAtMs === 'number' ? { emittedAtMs: frame.emittedAtMs } : {}),
        });
      } else {
        this.stats.unroutableFrames += 1;
      }
      return;
    }
    if (isJsonRpcId(frame.id) && ('result' in frame || 'error' in frame)) {
      this.handleResponse(frame.id, frame);
      return;
    }
    this.stats.unroutableFrames += 1;
    this.log.debug?.(this.describeFrame('in', frame, line.length), 'codex protocol: unroutable frame');
  }

  private handleResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!entry || typeof id !== 'number') {
      this.log.debug?.({ id }, 'codex app-server answered a request nobody waits for');
      return;
    }
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (isRecord(frame.error)) {
      const code = typeof frame.error.code === 'number' ? frame.error.code : JSON_RPC_INTERNAL_ERROR;
      const message = typeof frame.error.message === 'string' ? frame.error.message : 'JSON-RPC error';
      entry.reject(new JsonRpcRequestError(entry.method, code, message, frame.error.data));
      return;
    }
    try {
      (entry.onResult as ((result: unknown) => void) | undefined)?.(frame.result);
    } catch (error) {
      this.log.warn?.({ method: entry.method, error: error instanceof Error ? error.message : String(error) }, 'codex response hook threw');
    }
    entry.resolve(frame.result);
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    for (const handler of [...this.notificationHandlers]) {
      try {
        handler(notification);
      } catch (error) {
        this.log.warn?.({ method: notification.method, error: error instanceof Error ? error.message : String(error) }, 'codex notification handler threw');
      }
    }
  }

  /**
   * Every server request gets an answer, or the turn that raised it blocks forever. A synchronous handler is
   * answered in order with the frames around it; an async one when its promise settles.
   */
  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.replyError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
    }
    if (this.activeServerRequests >= MAX_CONCURRENT_SERVER_REQUEST_HANDLERS) {
      this.replyError(id, JSON_RPC_OVERLOADED, 'Too many server requests are being handled.');
      return;
    }
    const settle = (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void => {
      this.activeServerRequests -= 1;
      if (outcome.ok) {
        this.reply(id, outcome.value ?? null);
      } else if (outcome.error instanceof JsonRpcReplyError) {
        this.replyError(id, outcome.error.code, outcome.error.message, outcome.error.data);
      } else {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        this.log.warn?.({ method, error: message }, 'codex server request handler threw');
        this.replyError(id, JSON_RPC_INTERNAL_ERROR, `Internal error: ${message}`);
      }
    };
    this.activeServerRequests += 1;
    let result: unknown;
    try {
      result = handler(params, { id, method });
    } catch (error) {
      settle({ ok: false, error });
      return;
    }
    if (isThenable(result)) {
      result.then(
        (value) => settle({ ok: true, value }),
        (error: unknown) => settle({ ok: false, error }),
      );
    } else {
      settle({ ok: true, value: result });
    }
  }

  private reply(id: JsonRpcId, result: unknown): void {
    this.writeFrame({ id, result }).catch(() => undefined); // the channel is gone; nobody waits for the answer
  }

  private replyError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.writeFrame({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } }).catch(() => undefined);
  }

  /** Method, id and size only. Frames can carry whole command outputs and diffs, so they are never logged. */
  private describeFrame(direction: 'in' | 'out', frame: Record<string, unknown>, bytes: number): object {
    return {
      direction,
      bytes,
      ...(typeof frame.method === 'string' ? { method: frame.method } : {}),
      ...(frame.id !== undefined ? { id: frame.id } : {}),
      ...(isRecord(frame.error) ? { error: redactedLogValue({ code: frame.error.code, message: frame.error.message }) } : {}),
    };
  }
}
