// Line channels to provider processes (see docs/structured-cutover.md, "Session host relay").
//
// Plugins speak their protocol over a `LineTransport` and never spawn a provider themselves:
//   - `StdioLineTransport` runs the child directly. The channel is the process: closing it ends the child.
//   - `HostLineTransport` connects to a session host (`session-host.ts`) over a Unix socket. The host owns the child,
//     so the child survives a Console backend restart or crash and the next backend reconnects instead of respawning.
//   - `createLineTransportFactory` picks: a `hostId` means "the host with this identity" (reconnect to the live one,
//     or start it); no `hostId` means stdio.
// Lines are queued until the first `onLine` listener is attached, so output that arrives right after a reconnect
// (a replay) is never lost to a listener that registers a moment later.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { isRecordedProcessRunning, terminateRecordedProcess } from './codex/process-lifetime.js';
import {
  argvHash,
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_TERM_GRACE_MS,
  hostEnvironment,
  LineSplitter,
  MAX_LINE_BYTES,
  parseHostRecord,
  STDERR_TAIL_BYTES,
  type HostProcessIdentity,
  type HostRecord,
} from './session-host.js';
import { LineTransportNotRunningError, NotSentError, TransportUnavailableError } from './types.js';
import type { LineTransport, LineTransportFactory, LineTransportSpawn } from './types.js';

/** After the child's `exit`, wait this long for its stdout pipe to drain before the exit is final. */
const EXIT_FLUSH_MS = 200;
const HOST_CONNECT_TIMEOUT_MS = 3_000;
const HOST_WELCOME_TIMEOUT_MS = 5_000;
const HOST_START_TIMEOUT_MS = 15_000;
const HOST_STALE_TERM_GRACE_MS = 5_000;
const SOCKET_PATH_LIMIT = 100;
const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface LineTransportExit {
  code: number | null;
  signal: string | null;
  reason: 'exited' | 'disconnected';
  /** Set when the channel ended the connection itself (an oversized line) or lost it to another client. */
  error?: Error;
}

/**
 * What the two transports offer beyond the plugin contract. Every member is optional for a reader: plugins use the
 * `transport*` helpers below and work with any `LineTransport`.
 */
export interface ManagedLineTransport extends LineTransport {
  /** True when the provider process keeps running after `close()` without `terminate` (a session host holds it). */
  readonly outlivesClose: boolean;
  /** Last bytes of the provider's stderr with ANSI colour codes removed. Diagnostics only; never parse it. */
  stderrTail(): string;
  onExit(listener: (info: LineTransportExit) => void): () => void;
}

/** A spawn request with the optional knobs the transports understand. A plain `LineTransportSpawn` works too. */
export interface LineTransportRequest extends LineTransportSpawn {
  /** How long `close()` waits after ending stdin before SIGTERM. Default 5 s. */
  closeGraceMs?: number;
  /** How long `close()` waits after SIGTERM before SIGKILL. Default 5 s. */
  termGraceMs?: number;
  /** How long ending a host or provider process left behind by an earlier backend waits after SIGTERM. Default 5 s. */
  staleTermGraceMs?: number;
  /** Host only: replay buffered output after this sequence number. Omitted means live output only. */
  sinceSeq?: number;
}

/** The process could not be started (for example `ENOENT` for a missing binary). */
export class LineTransportSpawnError extends Error {
  readonly command: string;
  readonly code: string | undefined;
  constructor(command: string, cause: unknown) {
    super(`Could not start "${command}": ${cause instanceof Error ? cause.message : String(cause)}`);
    const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
    this.name = 'LineTransportSpawnError';
    this.command = command;
    this.code = typeof code === 'string' ? code : undefined;
    this.cause = cause;
  }
}

export function transportStderrTail(transport: LineTransport): string {
  return (transport as Partial<ManagedLineTransport>).stderrTail?.() ?? '';
}

export function transportOutlivesClose(transport: LineTransport): boolean {
  return (transport as Partial<ManagedLineTransport>).outlivesClose === true;
}

/** False when the provider process already received lines from an earlier client (a reconnect to a host that has been used). */
export function transportStartedFresh(transport: LineTransport): boolean {
  return transport instanceof HostLineTransport ? !transport.info.everWrote : true;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------------------
// Shared listener handling

/** A line listener. `seq` is the session host's sequence number of the line; a stdio channel has none. */
type LineListener = (line: string, seq?: number) => void;

abstract class LineChannel {
  private readonly lineListeners = new Set<LineListener>();
  private readonly exitListeners = new Set<(info: LineTransportExit) => void>();
  private queued: Array<{ line: string; seq: number | undefined }> = [];
  private finishedResolvers: Array<() => void> = [];
  protected finished: LineTransportExit | undefined;

  onLine(listener: LineListener): () => void {
    this.lineListeners.add(listener);
    if (this.queued.length > 0) {
      const queued = this.queued;
      this.queued = [];
      for (const { line, seq } of queued) this.callLine(listener, line, seq);
    }
    return () => this.lineListeners.delete(listener);
  }

  /** Fires once. A listener added after the exit is called at once. */
  onExit(listener: (info: LineTransportExit) => void): () => void {
    if (this.finished) {
      listener(this.finished);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  protected deliverLine(line: string, seq?: number): void {
    if (this.lineListeners.size === 0) {
      this.queued.push({ line, seq });
      return;
    }
    for (const listener of [...this.lineListeners]) this.callLine(listener, line, seq);
  }

  protected finishWith(info: LineTransportExit): void {
    if (this.finished) return;
    this.finished = info;
    for (const listener of [...this.exitListeners]) {
      try {
        listener(info);
      } catch {
        // A listener must not keep the others from learning of the exit.
      }
    }
    this.exitListeners.clear();
    this.lineListeners.clear();
    for (const resolve of this.finishedResolvers) resolve();
    this.finishedResolvers = [];
  }

  protected waitFinished(ms: number): Promise<boolean> {
    if (this.finished) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.finishedResolvers.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private callLine(listener: LineListener, line: string, seq: number | undefined): void {
    try {
      listener(line, seq);
    } catch {
      // The listener owns its own errors; one line never stops the stream.
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Stdio

export interface StdioLineTransportOptions {
  maxLineBytes?: number;
  stderrTailBytes?: number;
  log?: { warn?(fields: object, message: string): void; debug?(fields: object, message: string): void };
}

export class StdioLineTransport extends LineChannel implements ManagedLineTransport {
  readonly outlivesClose = false;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly log: NonNullable<StdioLineTransportOptions['log']>;
  private readonly splitter: LineSplitter;
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private readonly stderrLimit: number;
  private readonly closeGraceMs: number;
  private readonly termGraceMs: number;
  private closePromise: Promise<void> | undefined;
  private exitFlushTimer: NodeJS.Timeout | undefined;
  private rawExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private fatal: Error | undefined;

  private constructor(child: ChildProcessWithoutNullStreams, request: Pick<LineTransportRequest, 'closeGraceMs' | 'termGraceMs'>, options: StdioLineTransportOptions) {
    super();
    this.child = child;
    this.log = options.log ?? {};
    this.stderrLimit = options.stderrTailBytes ?? STDERR_TAIL_BYTES;
    this.closeGraceMs = request.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.termGraceMs = request.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    this.splitter = new LineSplitter(
      options.maxLineBytes ?? MAX_LINE_BYTES,
      (line) => this.deliverLine(line),
      (bytes) => this.failFatal(new Error(`An incoming message exceeded the line limit (${bytes} bytes read).`)),
    );
    child.stdout.on('data', (chunk: Buffer) => this.splitter.push(chunk));
    child.stdout.on('end', () => this.splitter.end());
    child.stderr.on('data', (chunk: Buffer) => this.appendStderr(chunk));
    child.stdin.on('error', (error) => this.log.debug?.({ error: error.message }, 'provider stdin error'));
    child.on('error', (error) => {
      if (child.pid !== undefined) this.log.warn?.({ error: error.message }, 'provider process error');
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

  /**
   * Starts the process as the leader of its own process group (a launcher such as the npm `codex` runs the real
   * server as its child; a group signal reaches both) and resolves once it exists. Rejects with
   * {@link LineTransportSpawnError}, for example `ENOENT` for a missing binary.
   */
  static async spawn(request: Pick<LineTransportRequest, 'argv' | 'cwd' | 'env' | 'closeGraceMs' | 'termGraceMs' | 'attachOnly'>, options: StdioLineTransportOptions = {}): Promise<StdioLineTransport> {
    // A child of this process is gone with it: there is never a running one to attach to.
    if (request.attachOnly) throw new LineTransportNotRunningError('A stdio provider process does not outlive its parent, so there is none to attach to.', 'absent');
    const [executable, ...args] = request.argv;
    if (!executable) throw new LineTransportSpawnError('', new Error('The command is empty.'));
    const child = spawn(executable, args, { cwd: request.cwd, env: request.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const transport = new StdioLineTransport(child, request, options);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        if (child.pid !== undefined) return; // after the start: logged by the constructor's listener
        transport.finishWith({ code: null, signal: null, reason: 'exited', error });
        reject(new LineTransportSpawnError(executable, error));
      });
    });
    return transport;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  stderrTail(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8').replace(ANSI_PATTERN, '');
  }

  write(line: string): Promise<void> {
    if (line.includes('\n')) return Promise.reject(new Error('A line must not contain a newline.'));
    if (this.finished || this.child.stdin.destroyed || !this.child.stdin.writable) return Promise.reject(new NotSentError('The provider process is not running.'));
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  /** Ends stdin and waits `closeGraceMs` for the process to exit, then SIGTERM and `termGraceMs`, then SIGKILL, each to the whole group. `terminate` makes no difference here: the channel is the process. */
  close(): Promise<void> {
    this.closePromise ??= this.closeStaged();
    return this.closePromise;
  }

  private async closeStaged(): Promise<void> {
    if (this.finished) return;
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    if (await this.waitFinished(this.closeGraceMs)) return;
    this.log.warn?.({ pid: this.pid }, 'provider ignored stdin EOF; sending SIGTERM');
    this.signalGroup('SIGTERM');
    if (await this.waitFinished(this.termGraceMs)) return;
    this.log.warn?.({ pid: this.pid }, 'provider ignored SIGTERM; sending SIGKILL');
    this.signalGroup('SIGKILL');
    await this.waitFinished(2_000);
  }

  /**
   * Signals the process group the child leads. The group is signalled only while the leader has not been reaped,
   * because its pid is then still ours; if the group signal fails the process alone is signalled.
   */
  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid !== undefined && this.rawExit === undefined) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // No such group, or not permitted: fall back to the process itself.
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      // Already gone.
    }
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

  private failFatal(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;
    this.log.warn?.({ error: error.message, pid: this.pid }, 'provider connection failed');
    this.signalGroup('SIGKILL');
    this.rawExit ??= { code: null, signal: 'SIGKILL' };
    this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    if (this.exitFlushTimer) clearTimeout(this.exitFlushTimer);
    const raw = this.rawExit ?? { code: null, signal: null };
    this.finishWith({ code: raw.code, signal: raw.signal, reason: 'exited', ...(this.fatal ? { error: this.fatal } : {}) });
  }
}

/** A factory that runs every child directly over stdio, ignoring `hostId`. For tests and embedding without a session host. */
export function createStdioLineTransportFactory(options: StdioLineTransportOptions = {}): LineTransportFactory {
  return (spawnRequest) => StdioLineTransport.spawn(spawnRequest as LineTransportRequest, options);
}

// ---------------------------------------------------------------------------------------------------------
// Host

export interface HostWelcome {
  hostPid: number;
  childPid: number | null;
  /** False when the child already ended (a host lingers for a minute after that). */
  alive: boolean;
  /** Sequence number of the newest line the host has seen. */
  seq: number;
  /** Oldest sequence number still in the replay buffer. */
  firstSeq: number;
  /** True once any client line was written to the child: it has been used, so a handshake would repeat. */
  everWrote: boolean;
  startedAt: string;
  spawnError?: { code?: string; message: string };
}

export interface HostStatus extends Omit<HostWelcome, 'childPid'> {
  pid: number | null;
  clients: number;
}

export interface HostConnectOptions {
  socketPath: string;
  /** Replay lines after this sequence number. Omitted: live output only. */
  sinceSeq?: number;
  maxLineBytes?: number;
  closeGraceMs?: number;
  termGraceMs?: number;
  connectTimeoutMs?: number;
  welcomeTimeoutMs?: number;
  log?: { warn?(fields: object, message: string): void; debug?(fields: object, message: string): void };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A session host accepted no connection, or sent no welcome, within the time allowed. The host may be alive and only
 * slow (a stalled machine, heavy swap), so this is not evidence that it is gone. A refused or missing socket is.
 */
export class HostUnresponsiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostUnresponsiveError';
  }
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new HostUnresponsiveError(`Connecting to ${socketPath} timed out.`));
    }, timeoutMs);
    socket.on('error', () => undefined); // later errors surface as the socket's close
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export class HostLineTransport extends LineChannel implements ManagedLineTransport {
  readonly outlivesClose = true;
  /** Set when the host could no longer replay everything after `sinceSeq`: the newest line it still held was this one. */
  gap: { firstSeq: number } | undefined;

  private readonly socket: net.Socket;
  private readonly socketPath: string;
  private readonly log: NonNullable<HostConnectOptions['log']>;
  private readonly replayRequested: boolean;
  private welcome: HostWelcome | undefined;
  private readonly closeGraceMs: number;
  private readonly termGraceMs: number;
  private lastSeqSeen: number;
  private stderr = '';
  private replaced = false;
  private closePromise: Promise<void> | undefined;
  private statusWaiters: Array<(status: HostStatus) => void> = [];
  private resolveWelcome: (welcome: HostWelcome) => void = () => undefined;
  private rejectWelcome: (error: Error) => void = () => undefined;
  private readonly welcomed: Promise<HostWelcome>;

  private constructor(socket: net.Socket, options: HostConnectOptions) {
    super();
    this.socket = socket;
    this.socketPath = options.socketPath;
    this.log = options.log ?? {};
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    this.replayRequested = options.sinceSeq !== undefined;
    this.lastSeqSeen = options.sinceSeq ?? 0;
    this.welcomed = new Promise<HostWelcome>((resolve, reject) => {
      this.resolveWelcome = resolve;
      this.rejectWelcome = reject;
    });
    this.welcomed.catch(() => undefined);
    const splitter = new LineSplitter(
      (options.maxLineBytes ?? MAX_LINE_BYTES) * 2 + 4096, // a framed line is the JSON-escaped child line plus its envelope
      (line) => this.onMessage(line),
      (bytes) => {
        this.log.warn?.({ bytes }, 'session host message exceeded the line limit');
        socket.destroy();
      },
    );
    socket.on('data', (chunk: Buffer) => splitter.push(chunk));
    socket.on('error', (error) => this.log.debug?.({ error: error.message }, 'session host socket error'));
    socket.on('close', () => {
      this.rejectWelcome(new Error('The session host closed the connection before it answered.'));
      this.finishWith({
        code: null,
        signal: null,
        reason: 'disconnected',
        ...(this.replaced ? { error: new Error('Another client took over this session host.') } : {}),
      });
    });
  }

  /**
   * Connects, says hello and waits for the host's welcome. With `sinceSeq` the host replays what it still has after
   * that sequence number (see {@link HostLineTransport.gap}); without it only new output arrives.
   */
  static async connect(options: HostConnectOptions): Promise<HostLineTransport> {
    const socket = await connectSocket(options.socketPath, options.connectTimeoutMs ?? HOST_CONNECT_TIMEOUT_MS);
    const transport = new HostLineTransport(socket, options);
    socket.write(`${JSON.stringify({ type: 'hello', ...(options.sinceSeq !== undefined ? { sinceSeq: options.sinceSeq } : {}) })}\n`);
    const timer = setTimeout(() => transport.rejectWelcome(new HostUnresponsiveError('The session host did not answer hello.')), options.welcomeTimeoutMs ?? HOST_WELCOME_TIMEOUT_MS);
    try {
      await transport.welcomed;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return transport;
  }

  /** The host's answer to our hello. */
  get info(): HostWelcome {
    return this.welcome!;
  }

  get pid(): number | undefined {
    return this.welcome?.childPid ?? undefined;
  }

  /** The sequence number of the newest line delivered to listeners (or the host's newest at connect time for a live-only client). Persist it to replay from there next time. */
  get lastSeq(): number {
    return this.lastSeqSeen;
  }

  stderrTail(): string {
    return this.stderr.replace(ANSI_PATTERN, '');
  }

  write(line: string): Promise<void> {
    if (line.includes('\n')) return Promise.reject(new Error('A line must not contain a newline.'));
    if (this.finished || this.socket.destroyed || !this.socket.writable) return Promise.reject(new NotSentError('The connection to the session host is closed.'));
    return new Promise<void>((resolve, reject) => {
      this.socket.write(`${JSON.stringify({ type: 'write', line })}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  /** The host's own view: child pid, whether it is alive, the newest sequence number, whether any line was ever written. */
  status(timeoutMs = 3_000): Promise<HostStatus> {
    return new Promise<HostStatus>((resolve, reject) => {
      if (this.finished) {
        reject(new Error('The connection to the session host is closed.'));
        return;
      }
      const timer = setTimeout(() => reject(new Error('The session host did not answer status.')), timeoutMs);
      this.statusWaiters.push((status) => {
        clearTimeout(timer);
        resolve(status);
      });
      this.socket.write(`${JSON.stringify({ type: 'status' })}\n`);
    });
  }

  /**
   * Without `terminate` the connection ends and the provider process keeps running in its host. With it the host ends
   * the provider (stdin EOF, grace, SIGTERM to its group, grace, SIGKILL) and exits; this resolves once it reports that.
   */
  close(options: { terminate?: boolean } = {}): Promise<void> {
    this.closePromise ??= options.terminate ? this.terminateHost() : this.disconnect();
    return this.closePromise;
  }

  private async disconnect(): Promise<void> {
    if (this.finished) return;
    this.socket.end();
    if (!(await this.waitFinished(2_000))) this.socket.destroy();
    await this.waitFinished(1_000);
  }

  private async terminateHost(): Promise<void> {
    if (this.finished) {
      // The connection is already gone; the host may not be. Ask it over a new connection.
      if (this.finished.reason === 'disconnected') await terminateHostAt(this.socketPath, { closeGraceMs: this.closeGraceMs, termGraceMs: this.termGraceMs });
      return;
    }
    this.socket.write(`${JSON.stringify({ type: 'terminate', closeGraceMs: this.closeGraceMs, termGraceMs: this.termGraceMs })}\n`);
    if (!(await this.waitFinished(this.closeGraceMs + this.termGraceMs + 4_000))) this.socket.destroy();
    this.socket.end();
    await this.waitFinished(1_000);
  }

  private onMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.log.warn?.({ bytes: line.length }, 'session host sent a message that is not JSON');
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.seq === 'number' && typeof message.line === 'string') {
      this.lastSeqSeen = message.seq;
      this.deliverLine(message.line, message.seq);
      return;
    }
    switch (message.type) {
      case 'welcome': {
        const welcome: HostWelcome = {
          hostPid: Number(message.hostPid),
          childPid: typeof message.childPid === 'number' ? message.childPid : null,
          alive: message.alive === true,
          seq: Number(message.seq),
          firstSeq: Number(message.firstSeq),
          everWrote: message.everWrote === true,
          startedAt: String(message.startedAt ?? ''),
          ...(isRecord(message.spawnError) ? { spawnError: { ...(typeof message.spawnError.code === 'string' ? { code: message.spawnError.code } : {}), message: String(message.spawnError.message ?? '') } } : {}),
        };
        this.welcome = welcome;
        if (!this.replayRequested) this.lastSeqSeen = welcome.seq; // live output only: the cursor starts at the host's newest line
        this.resolveWelcome(welcome);
        return;
      }
      case 'gap':
        this.gap = { firstSeq: Number(message.firstSeq) };
        return;
      case 'exit': {
        const error = isRecord(message.error) ? Object.assign(new Error(String(message.error.message ?? 'The provider process failed.')), typeof message.error.code === 'string' ? { code: message.error.code } : {}) : undefined;
        this.stderr = typeof message.stderrTail === 'string' ? message.stderrTail : '';
        this.finishWith({
          code: typeof message.code === 'number' ? message.code : null,
          signal: typeof message.signal === 'string' ? message.signal : null,
          reason: 'exited',
          ...(error ? { error } : {}),
        });
        return;
      }
      case 'replaced':
        this.replaced = true;
        return;
      case 'status': {
        const status: HostStatus = {
          hostPid: Number(message.hostPid),
          pid: typeof message.pid === 'number' ? message.pid : null,
          alive: message.alive === true,
          seq: Number(message.seq),
          firstSeq: Number(message.firstSeq),
          everWrote: message.everWrote === true,
          startedAt: String(message.startedAt ?? ''),
          clients: Number(message.clients),
        };
        for (const resolve of this.statusWaiters.splice(0)) resolve(status);
        return;
      }
      case 'error':
        this.log.warn?.({ message: String(message.message ?? '') }, 'session host reported an error');
        return;
      default:
        this.log.debug?.({ type: String(message.type) }, 'session host sent an unknown message');
    }
  }
}

/** Asks the host behind `socketPath` to end its provider and exit, without becoming its client. True once the host closed the connection. */
export async function terminateHostAt(socketPath: string, graces: { closeGraceMs?: number; termGraceMs?: number } = {}): Promise<boolean> {
  const closeGraceMs = graces.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const termGraceMs = graces.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  let socket: net.Socket;
  try {
    socket = await connectSocket(socketPath, HOST_CONNECT_TIMEOUT_MS);
  } catch {
    return false;
  }
  socket.on('error', () => undefined);
  socket.resume(); // an unread socket never sees the host's end and never closes
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, closeGraceMs + termGraceMs + 4_000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.write(`${JSON.stringify({ type: 'terminate', closeGraceMs, termGraceMs })}\n`);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Host records and the factory

export interface HostPaths {
  dir: string;
  record: string;
  log: string;
  env: string;
  socket: string;
}

/** `<runtimeDir>/structured/hosts/<hostId>.{json,log,sock}`. A socket path above the Unix limit is shortened to a hash of the id. */
export function hostPaths(runtimeDir: string, hostId: string): HostPaths {
  if (!HOST_ID_PATTERN.test(hostId)) throw new Error(`"${hostId}" is not a valid session host id.`);
  const dir = path.join(runtimeDir, 'structured', 'hosts');
  let socket = path.join(dir, `${hostId}.sock`);
  if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
    socket = path.join(dir, `${createHash('sha256').update(hostId).digest('hex').slice(0, 16)}.sock`);
    if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
      throw new Error(`The runtime directory path is too long for a Unix socket: ${socket}`);
    }
  }
  return { dir, record: path.join(dir, `${hostId}.json`), log: path.join(dir, `${hostId}.log`), env: path.join(dir, `${hostId}.env`), socket };
}

export function readHostRecord(recordPath: string): HostRecord | undefined {
  try {
    return parseHostRecord(fs.readFileSync(recordPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function identityRunning(identity: HostProcessIdentity): boolean {
  return isRecordedProcessRunning({ pid: identity.pid, ...(identity.startTicks ? { startTicks: identity.startTicks } : {}), ...(identity.bootId ? { bootId: identity.bootId } : {}) });
}

export interface LineTransportFactoryOptions {
  /** The Console runtime directory; hosts live under `<runtimeDir>/structured/hosts`. */
  runtimeDir: string;
  log: { info(fields: object, message: string): void; warn(fields: object, message: string): void };
  /** `session-host.js` next to this module in a build. Running from source (`tsx`) there is no `.js`; the `.ts` file next to it is run instead (Node strips its types). */
  hostProgramPath: string;
  hostStartTimeoutMs?: number;
  /** How long a connection to a running host may take, and how long its welcome may take. Defaults 3 s and 5 s. For tests. */
  hostConnectTimeoutMs?: number;
  hostWelcomeTimeoutMs?: number;
}

export interface HostGraces {
  closeGraceMs?: number;
  termGraceMs?: number;
  staleTermGraceMs?: number;
}

/**
 * Ends the host recorded under `hostId` and its provider: through the socket when the host answers, otherwise by
 * signal. Every signal is gated by the recorded pid, start time and boot, so a reused pid is never touched. A provider
 * that outlived its host (no `setpriv`, or it ignored SIGTERM) is ended through its recorded process group.
 */
export async function terminateHost(
  runtimeDir: string,
  hostId: string,
  log: LineTransportFactoryOptions['log'],
  graces: HostGraces = {},
): Promise<void> {
  const paths = hostPaths(runtimeDir, hostId);
  const record = readHostRecord(paths.record);
  await retireHost(record, paths, log, graces);
}

async function retireHost(record: HostRecord | undefined, paths: HostPaths, log: LineTransportFactoryOptions['log'], graces: HostGraces): Promise<void> {
  const staleTermGraceMs = graces.staleTermGraceMs ?? HOST_STALE_TERM_GRACE_MS;
  const socketPath = paths.socket; // the record's own path is never trusted: it is this one for the same id
  if (!record || identityRunning(record.host)) {
    // Through the socket first: the host ends its own child in order. A socket nobody answers is a leftover file.
    const answered = await terminateHostAt(socketPath, graces);
    if (record) {
      const deadline = Date.now() + 2_000;
      while (identityRunning(record.host) && Date.now() < deadline) await wait(25);
      if (identityRunning(record.host)) {
        if (answered) log.warn({ pid: record.host.pid }, 'session host did not exit after terminate; signalling it');
        const gone = await terminateRecordedProcess(
          { pid: record.host.pid, ...(record.host.startTicks ? { startTicks: record.host.startTicks } : {}), ...(record.host.bootId ? { bootId: record.host.bootId } : {}) },
          staleTermGraceMs,
        );
        if (!gone) log.warn({ pid: record.host.pid }, 'the session host did not end');
      }
    }
  }
  if (record && identityRunning(record.child)) {
    log.warn({ pid: record.child.pid }, 'provider process left running without its session host; ending it');
    const gone = await terminateRecordedProcess(
      { pid: record.child.pid, ...(record.child.startTicks ? { startTicks: record.child.startTicks } : {}), ...(record.child.bootId ? { bootId: record.child.bootId } : {}), processGroup: record.child.processGroup },
      staleTermGraceMs,
    );
    if (!gone) log.warn({ pid: record.child.pid }, 'the provider process did not end');
  }
  for (const file of [paths.record, paths.socket]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
}

function hostLogTail(logPath: string): string {
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    return text.split('\n').filter(Boolean).slice(-3).join(' | ').slice(-600);
  } catch {
    return '';
  }
}

/**
 * The factory plugins receive as `PluginContext.lineTransport`. With a `hostId` it returns a channel to the session
 * host of that identity: the live one when its recorded process identity and argv hash match (the provider keeps
 * running across the backend restart and its state is intact), otherwise a freshly started one. Without a `hostId` it
 * runs the child directly over stdio.
 */
export function createLineTransportFactory(options: LineTransportFactoryOptions): LineTransportFactory {
  const chains = new Map<string, Promise<unknown>>();
  const { log } = options;

  async function startHost(request: LineTransportRequest, hash: string, paths: HostPaths): Promise<LineTransport> {
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(paths.dir, 0o700);
    fs.rmSync(paths.env, { force: true });
    // The child's exact environment; the host reads it once and deletes it. It can hold tokens, hence 0600.
    fs.writeFileSync(paths.env, JSON.stringify(request.env), { mode: 0o600, flag: 'wx' });
    const logFd = fs.openSync(paths.log, 'a', 0o600);
    let hostExit: { code: number | null; signal: string | null } | undefined;
    const program = !fs.existsSync(options.hostProgramPath) && options.hostProgramPath.endsWith('.js') && fs.existsSync(`${options.hostProgramPath.slice(0, -3)}.ts`)
      ? `${options.hostProgramPath.slice(0, -3)}.ts`
      : options.hostProgramPath;
    const host = spawn(process.execPath, [program, '--socket', paths.socket, '--record', paths.record, '--cwd', request.cwd, '--env-file', paths.env, '--', ...request.argv], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: hostEnvironment(process.env),
      cwd: paths.dir,
    });
    fs.closeSync(logFd);
    host.once('exit', (code, signal) => {
      hostExit = { code, signal };
    });
    let hostError: Error | undefined;
    host.once('error', (error) => {
      hostError = error;
    });
    try {
      const deadline = Date.now() + (options.hostStartTimeoutMs ?? HOST_START_TIMEOUT_MS);
      for (;;) {
        if (hostError) throw new LineTransportSpawnError(program, hostError);
        if (hostExit) throw new Error(`The session host exited before it served (code ${hostExit.code ?? 'none'}, signal ${hostExit.signal ?? 'none'}): ${hostLogTail(paths.log)}`);
        if (fs.existsSync(paths.socket)) {
          try {
            const transport = await HostLineTransport.connect(hostConnectOptions(request, paths.socket));
            if (transport.info.spawnError) {
              const { spawnError } = transport.info;
              await transport.close().catch(() => undefined);
              throw new LineTransportSpawnError(request.argv[0] ?? '', Object.assign(new Error(spawnError.message), spawnError.code ? { code: spawnError.code } : {}));
            }
            log.info({ hostId: request.hostId, hostPid: transport.info.hostPid, childPid: transport.info.childPid }, 'session host started');
            host.removeAllListeners('exit');
            host.unref();
            return transport;
          } catch (error) {
            if (error instanceof LineTransportSpawnError) throw error;
            // The socket file exists before the host accepts on it; try again.
          }
        }
        if (Date.now() > deadline) throw new Error(`The session host did not start within ${options.hostStartTimeoutMs ?? HOST_START_TIMEOUT_MS} ms: ${hostLogTail(paths.log)}`);
        await wait(20);
      }
    } catch (error) {
      if (host.pid !== undefined && !hostExit) {
        try {
          host.kill('SIGTERM'); // we started it a moment ago; the host ends its own child on SIGTERM
        } catch {
          // Already gone.
        }
      }
      fs.rmSync(paths.env, { force: true });
      throw error;
    }
  }

  function hostConnectOptions(request: LineTransportRequest, socketPath: string): HostConnectOptions {
    return {
      socketPath,
      ...(request.sinceSeq !== undefined ? { sinceSeq: request.sinceSeq } : {}),
      ...(request.closeGraceMs !== undefined ? { closeGraceMs: request.closeGraceMs } : {}),
      ...(request.termGraceMs !== undefined ? { termGraceMs: request.termGraceMs } : {}),
      ...(options.hostConnectTimeoutMs !== undefined ? { connectTimeoutMs: options.hostConnectTimeoutMs } : {}),
      ...(options.hostWelcomeTimeoutMs !== undefined ? { welcomeTimeoutMs: options.hostWelcomeTimeoutMs } : {}),
      log: { warn: (fields, message) => log.warn(fields, message) },
    };
  }

  /** `attachOnly`: connect to the live host that runs exactly this command line, or say there is none. Starts and ends nothing. */
  async function attachHost(request: LineTransportRequest, hostId: string): Promise<LineTransport> {
    const paths = hostPaths(options.runtimeDir, hostId);
    const record = readHostRecord(paths.record);
    if (!record || !identityRunning(record.host)) throw new LineTransportNotRunningError(`No session host is running for ${hostId}.`, 'absent');
    // The host is keyed by its command line; another one is not this conversation's process and is left alone.
    if (record.argvHash !== argvHash(request.argv)) throw new LineTransportNotRunningError(`The session host for ${hostId} runs another command line.`, 'other_command');
    let transport: HostLineTransport;
    try {
      transport = await HostLineTransport.connect(hostConnectOptions(request, paths.socket));
    } catch (error) {
      // Slow is not gone: a host that accepted no connection or sent no welcome in time may be stalled and still run its
      // provider. One that refuses connections or closes at once serves nobody, whatever its pid says.
      throw new LineTransportNotRunningError(
        `The session host for ${hostId} did not answer: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof HostUnresponsiveError ? 'unreachable' : 'absent',
      );
    }
    if (!transport.info.alive) {
      await transport.close().catch(() => undefined); // disconnect only; the lingering host is not ours to end here
      throw new LineTransportNotRunningError(`The provider process of the session host for ${hostId} has ended.`, 'ended');
    }
    log.info({ hostId, hostPid: transport.info.hostPid, childPid: transport.info.childPid, seq: transport.info.seq, fresh: transportStartedFresh(transport) }, 'attached to a running session host');
    return transport;
  }

  async function openHost(request: LineTransportRequest, hostId: string): Promise<LineTransport> {
    if (request.attachOnly) return attachHost(request, hostId);
    const paths = hostPaths(options.runtimeDir, hostId);
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const hash = argvHash(request.argv);
    const record = readHostRecord(paths.record);
    const graces: HostGraces = { closeGraceMs: request.closeGraceMs, termGraceMs: request.termGraceMs, staleTermGraceMs: request.staleTermGraceMs };
    if (record && identityRunning(record.host)) {
      if (record.argvHash === hash) {
        try {
          // Live output only: whatever a used host printed before now belongs to the client that was there.
          const { sinceSeq: _replay, ...liveOnly } = request;
          let transport = await HostLineTransport.connect(hostConnectOptions(liveOnly, paths.socket));
          if (transport.info.alive && request.sinceSeq !== undefined && !transport.info.everWrote) {
            // Never written to: everything it printed is startup output (hook frames) that nobody has seen. Ask for it.
            await transport.close().catch(() => undefined);
            transport = await HostLineTransport.connect(hostConnectOptions(request, paths.socket));
          }
          if (transport.info.alive) {
            log.info({ hostId, hostPid: transport.info.hostPid, childPid: transport.info.childPid, seq: transport.info.seq, fresh: transportStartedFresh(transport) }, 'reconnected to a running session host');
            return transport;
          }
          log.info({ hostId, hostPid: transport.info.hostPid }, 'the provider process of the recorded session host had ended; starting a new host');
          await transport.close().catch(() => undefined);
        } catch (error) {
          if (error instanceof HostUnresponsiveError) {
            // The host runs (its recorded pid, start time and boot match) and has the right command line; it only did not
            // answer in time. Retiring it would end its provider, and with it any turn that is running, so leave it alone
            // and let the next use try again.
            log.warn({ hostId, hostPid: record.host.pid, error: error.message }, 'the recorded session host is running but did not answer in time; leaving it alone');
            throw new TransportUnavailableError(`The session host for ${hostId} is running but did not answer in time. Try again in a moment.`);
          }
          log.warn({ hostId, error: error instanceof Error ? error.message : String(error) }, 'the recorded session host did not answer; replacing it');
        }
      } else {
        log.info({ hostId, hostPid: record.host.pid }, 'the provider command changed; ending the earlier session host');
      }
    }
    // A record whose host is gone may still name a provider left running; a socket without a record may be a lingering host.
    await retireHost(record, paths, log, graces);
    return startHost(request, hash, paths);
  }

  return (spawnRequest) => {
    const request = spawnRequest as LineTransportRequest;
    if (!request.hostId) return StdioLineTransport.spawn(request, { log: { warn: (fields, message) => log.warn(fields, message) } });
    const hostId = request.hostId;
    // One open at a time per host: a second client would replace the first.
    const run = (chains.get(hostId) ?? Promise.resolve()).catch(() => undefined).then(() => openHost(request, hostId));
    chains.set(hostId, run.catch(() => undefined));
    return run;
  };
}
