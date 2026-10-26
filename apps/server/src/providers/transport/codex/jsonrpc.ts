// Plain-TypeScript JSON-RPC client over the stdio of a child process (newline-delimited JSON, no `jsonrpc`
// field), ported from the patterns in T3 Code's `packages/effect-codex-app-server/src/protocol.ts`
// (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md):
//   - a line splitter with a per-line byte cap and `\r` stripping;
//   - a table of pending requests keyed by numeric id starting at 1;
//   - routing of incoming frames by shape (method + id = server request, method only = notification,
//     id + result/error = response);
//   - every pending request fails when the process ends.
// Differences: per-request timeouts, a bounded stderr tail, an explicit staged `close()`, and server
// request handlers that always answer (an unknown method gets a `-32601` reply).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { redactedLogValue, redactFreeText } from './redact.js';

export const DEFAULT_MAX_LINE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_CLOSE_GRACE_MS = 5_000;
export const MAX_CONCURRENT_SERVER_REQUEST_HANDLERS = 32;
/** After `exit`, wait this long for the stdout pipe to drain before the exit is final. */
const EXIT_FLUSH_MS = 200;

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
  /** True when {@link JsonRpcClient.close} was called before the process ended. */
  expected: boolean;
  /** Last bytes of stderr (ANSI stripped). */
  stderrTail: string;
  /** Set when the client ended the connection itself (oversized line). */
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

export interface JsonRpcSpawnOptions {
  /** argv; `command[0]` is the executable. */
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log?: JsonRpcLogger;
  maxLineBytes?: number;
  stderrTailBytes?: number;
  defaultRequestTimeoutMs?: number;
  /** How long `close()` waits after ending stdin before SIGTERM. */
  closeGraceMs?: number;
  /** How long `close()` waits after SIGTERM before SIGKILL. */
  termGraceMs?: number;
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

/** The process ended (or its stdin was closed) while a request was pending or being sent. */
export class JsonRpcExitError extends Error {
  readonly exit: JsonRpcExit;
  constructor(exit: JsonRpcExit, message?: string) {
    super(message ?? describeExit(exit));
    this.name = 'JsonRpcExitError';
    this.exit = exit;
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

/** One-line description of how the process ended, with the last stderr lines (redacted) when there are any. */
export function describeExit(exit: JsonRpcExit): string {
  const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`;
  const tail = exit.stderrTail.replace(ANSI_PATTERN, '').trim().split('\n').slice(-3).join(' | ');
  return redactFreeText(`The process ended (${how})${tail ? `: ${tail}` : '.'}`, 600);
}

/** Splits a byte stream into lines. A line above `maxBytes` (delimiter excluded) is reported once and ends the splitter. */
export class LineSplitter {
  private parts: Buffer[] = [];
  private size = 0;
  private dead = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: (bytes: number) => void,
  ) {}

  get overflowed(): boolean {
    return this.dead;
  }

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length && !this.dead) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(start, end);
      this.size += segment.length;
      if (this.size > this.maxBytes) {
        this.dead = true;
        this.parts = [];
        this.onOverflow(this.size);
        return;
      }
      if (segment.length > 0) this.parts.push(segment);
      if (newline === -1) return;
      this.emitLine();
      start = newline + 1;
    }
  }

  /** Flushes a final line that had no trailing newline. */
  end(): void {
    if (this.dead || this.size === 0) return;
    this.emitLine();
  }

  private emitLine(): void {
    const buffer = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    let line = buffer.toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    this.onLine(line);
  }
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

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly log: JsonRpcLogger;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();
  private readonly exitHandlers = new Set<(exit: JsonRpcExit) => void>();
  private readonly requestHandlers = new Map<string, JsonRpcServerRequestHandler>();
  private readonly splitter: LineSplitter;
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private readonly stderrLimit: number;
  private readonly defaultTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly termGraceMs: number;
  private nextId = 1;
  private activeServerRequests = 0;
  private spawned = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private exitFlushTimer: NodeJS.Timeout | undefined;
  private rawExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private fatal: Error | undefined;
  private finished: JsonRpcExit | undefined;
  private finishedResolvers: Array<() => void> = [];
  private readonly ready: Promise<void>;
  private resolveReady: () => void = () => undefined;
  private rejectReady: (error: Error) => void = () => undefined;

  private constructor(child: ChildProcessWithoutNullStreams, options: JsonRpcSpawnOptions) {
    this.child = child;
    this.log = options.log ?? {};
    this.stderrLimit = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
    this.defaultTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.termGraceMs = options.termGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => undefined); // spawn() awaits it; avoid an unhandled rejection if nobody does
    this.splitter = new LineSplitter(
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      (line) => this.handleLine(line),
      (bytes) => this.failFatal(new JsonRpcProtocolError(`An incoming message exceeded the line limit (${bytes} bytes read).`)),
    );

    child.stdout.on('data', (chunk: Buffer) => this.splitter.push(chunk));
    child.stdout.on('end', () => this.splitter.end());
    child.stderr.on('data', (chunk: Buffer) => this.appendStderr(chunk));
    child.stdin.on('error', (error) => this.log.debug?.({ error: error.message }, 'codex app-server stdin error'));
    child.once('spawn', () => {
      this.spawned = true;
      this.resolveReady();
    });
    child.on('error', (error) => {
      if (this.spawned) {
        this.log.warn?.({ error: error.message }, 'codex app-server process error');
        return;
      }
      this.finish({ code: null, signal: null, error });
      this.rejectReady(new JsonRpcSpawnError(options.command[0] ?? '', error));
    });
    child.once('exit', (code, signal) => {
      this.rawExit = { code, signal };
      // The stdout pipe can outlive the process (an inherited descriptor); do not wait for it forever.
      this.exitFlushTimer = setTimeout(() => this.finish(), EXIT_FLUSH_MS);
      this.exitFlushTimer.unref();
    });
    child.once('close', (code, signal) => {
      this.rawExit ??= { code, signal };
      this.finish();
    });
  }

  /** Spawns the process and resolves once it exists. Rejects with {@link JsonRpcSpawnError} (for example ENOENT). */
  static async spawn(options: JsonRpcSpawnOptions): Promise<JsonRpcClient> {
    const [executable, ...args] = options.command;
    if (!executable) throw new JsonRpcSpawnError('', new Error('The command is empty.'));
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new JsonRpcClient(child, options);
    await client.ready;
    return client;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exited(): boolean {
    return this.finished !== undefined;
  }

  get exitInfo(): JsonRpcExit | undefined {
    return this.finished;
  }

  /** Last bytes of stderr with ANSI colour codes removed. Diagnostics only; never parse it. */
  stderrTail(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8').replace(ANSI_PATTERN, '');
  }

  request<T = unknown>(method: string, params?: unknown, options: JsonRpcRequestOptions<T> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.finished) {
        reject(this.exitError());
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
      try {
        this.writeFrame({ id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.finished) throw this.exitError();
    this.writeFrame({ method, ...(params !== undefined ? { params } : {}) });
  }

  /** Subscribes to server notifications. Returns the unsubscribe function. */
  onNotification(handler: (notification: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Subscribes to the process exit. Fires once. */
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
   * Ends stdin and waits up to `closeGraceMs` for the process to exit, then sends SIGTERM and waits up to
   * `termGraceMs`, then SIGKILL. Resolves once the process is gone (or after a final best-effort wait).
   */
  close(): Promise<void> {
    this.closePromise ??= this.closeStaged();
    return this.closePromise;
  }

  private async closeStaged(): Promise<void> {
    this.closing = true;
    if (this.finished) return;
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    if (await this.waitFinished(this.closeGraceMs)) return;
    this.log.warn?.({ pid: this.pid }, 'codex app-server ignored stdin EOF; sending SIGTERM');
    this.child.kill('SIGTERM');
    if (await this.waitFinished(this.termGraceMs)) return;
    this.log.warn?.({ pid: this.pid }, 'codex app-server ignored SIGTERM; sending SIGKILL');
    this.child.kill('SIGKILL');
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

  private appendStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk);
    this.stderrBytes += chunk.length;
    while (this.stderrBytes > this.stderrLimit && this.stderrChunks.length > 0) {
      const first = this.stderrChunks[0]!;
      const excess = this.stderrBytes - this.stderrLimit;
      if (first.length <= excess) {
        this.stderrChunks.shift();
        this.stderrBytes -= first.length;
      } else {
        this.stderrChunks[0] = first.subarray(excess);
        this.stderrBytes -= excess;
      }
    }
  }

  private writeFrame(frame: Record<string, unknown>): void {
    if (this.finished || this.child.stdin.destroyed || !this.child.stdin.writable) throw this.exitError();
    const line = `${JSON.stringify(frame)}\n`;
    this.log.debug?.(this.describeFrame('out', frame, line.length), 'codex protocol');
    this.child.stdin.write(line, (error) => {
      if (error) this.log.debug?.({ error: error.message }, 'codex app-server stdin write failed');
    });
  }

  private exitError(): JsonRpcExitError {
    const exit = this.finished ?? { code: null, signal: null, expected: this.closing, stderrTail: this.stderrTail() };
    return new JsonRpcExitError(exit, exit.error ? exit.error.message : undefined);
  }

  private failFatal(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;
    this.log.warn?.({ error: error.message, pid: this.pid }, 'codex app-server connection failed');
    try {
      this.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    this.finish({ code: null, signal: 'SIGKILL', error });
  }

  private finish(override?: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void {
    if (this.finished) return;
    if (this.exitFlushTimer) clearTimeout(this.exitFlushTimer);
    const raw = override ?? this.rawExit ?? { code: null, signal: null };
    const error = override?.error ?? this.fatal;
    const exit: JsonRpcExit = {
      code: raw.code,
      signal: raw.signal,
      expected: this.closing,
      stderrTail: this.stderrTail(),
      ...(error ? { error } : {}),
    };
    this.finished = exit;
    const failure = new JsonRpcExitError(exit, error ? error.message : undefined);
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
    try {
      this.writeFrame({ id, result });
    } catch {
      // The process is gone; nobody waits for the answer.
    }
  }

  private replyError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    try {
      this.writeFrame({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
    } catch {
      // The process is gone; nobody waits for the answer.
    }
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
