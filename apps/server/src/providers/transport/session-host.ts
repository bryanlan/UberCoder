// Session host: a small standalone program that owns one provider child and outlives the Console backend.
//
//   node session-host.js --socket <path> --record <path> --cwd <dir> --env-file <path> -- <argv...>
//
// The backend starts it detached (its own session, no controlling terminal), so a backend restart or crash leaves
// it running. It starts the provider child in its own process group through `setpriv --pdeathsig TERM --` relative to
// THIS process (so the kernel ends the child if the host itself dies), keeps the child's stdio, and serves a Unix
// socket (mode 0600) that the backend connects to, disconnects from and reconnects to. It imports only `node:`
// modules so it runs alone from the compiled output; `line-transport.ts` imports the protocol pieces exported here.
//
// Wire protocol, newline-delimited JSON in both directions. A connection is identified by its first message.
//
//   client -> host
//     {"type":"hello","sinceSeq":N}   become THE client (a previous client is replaced); `sinceSeq` is optional:
//                                      omitted = live output only, a number = replay buffered lines after it
//     {"type":"write","line":"..."}   one line for the child's stdin (the host adds the newline)
//     {"type":"status"}               answered with a `status` message; a connection that starts with it never becomes the client
//     {"type":"terminate"[,"closeGraceMs":n,"termGraceMs":n]}
//                                      end the child (stdin EOF, grace, group SIGTERM, grace, group SIGKILL), then the host exits;
//                                      the sender receives the `exit` message
//   host -> client
//     {"type":"welcome",...}          after `hello`: hostPid, childPid, alive, seq, firstSeq, everWrote, startedAt[, spawnError]
//     {"type":"gap","firstSeq":M}     `sinceSeq` is older than the replay buffer (or newer than the host's own counter)
//     {"seq":N,"line":"..."}          one line the child wrote to stdout, live or replayed
//     {"type":"exit","code":..,"signal":..,"stderrTail":"..."[,"error":{...}]}   the child ended
//     {"type":"replaced"}             another client took over; this connection is closed next
//     {"type":"status",...}           answer to `status`: pid (the child), hostPid, alive, seq, firstSeq, everWrote, clients, startedAt
//
// The replay buffer keeps the child's most recent stdout lines: at most 4 MiB, none older than 10 minutes.
// When the child ends on its own the host sends `exit`, keeps answering for 60 seconds so a reconnecting backend
// learns the outcome, removes its record file and exits. Written with erasable TypeScript only, so `node` can also
// run the source file directly.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_PROTOCOL_VERSION = 1;
export const REPLAY_MAX_BYTES = 4 * 1024 * 1024;
export const REPLAY_MAX_AGE_MS = 10 * 60 * 1000;
export const LINGER_MS = 60_000;
export const MAX_LINE_BYTES = 128 * 1024 * 1024;
export const STDERR_TAIL_BYTES = 64 * 1024;
export const DEFAULT_CLOSE_GRACE_MS = 5_000;
export const DEFAULT_TERM_GRACE_MS = 5_000;
/** A client that lets this much output pile up unread is dropped; it reconnects and replays (or sees a gap). */
const MAX_CLIENT_BACKLOG_BYTES = 64 * 1024 * 1024;
/** After the child's `exit`, wait this long for its stdout pipe to drain before the exit is final. */
const EXIT_FLUSH_MS = 200;
const UNIDENTIFIED_CONNECTION_MS = 10_000;
const FAILED_SPAWN_LINGER_MS = 5_000;
const MAX_GRACE_MS = 60_000;
/** `sun_path` holds 108 bytes including the terminating NUL; a longer path is cut off silently. */
const SOCKET_PATH_LIMIT = 107;

// ---------------------------------------------------------------------------------------------------------
// Pieces the backend side shares

/** Identifies one argv, so a host started for another command line is never adopted for this one. */
export function argvHash(argv: string[]): string {
  return createHash('sha256').update(JSON.stringify(argv)).digest('hex');
}

export interface HostProcessIdentity {
  pid: number;
  startTicks?: string;
  bootId?: string;
}

/** What the host writes to its record file once it listens. `pid` plus `startTicks` plus `bootId` identify a process safely. */
export interface HostRecord {
  version: 1;
  host: HostProcessIdentity;
  child: HostProcessIdentity & { processGroup: number };
  socketPath: string;
  argvHash: string;
  startedAt: string;
  /** False when `setpriv` was missing: the child then outlives a crashed host and is found again through this record. */
  parentDeathSignal: boolean;
}

function parseIdentity(value: unknown): HostProcessIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 1) return undefined;
  return {
    pid: record.pid,
    ...(typeof record.startTicks === 'string' ? { startTicks: record.startTicks } : {}),
    ...(typeof record.bootId === 'string' ? { bootId: record.bootId } : {}),
  };
}

/** Reads a record file's text. Anything unusable gives undefined, so it is never acted on. */
export function parseHostRecord(text: string): HostRecord | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.version !== 1 || typeof value.socketPath !== 'string' || typeof value.argvHash !== 'string') return undefined;
    const host = parseIdentity(value.host);
    const child = parseIdentity(value.child);
    if (!host || !child) return undefined;
    // Only the group the child itself leads is ever signalled; any other value is dropped with the record.
    if ((value.child as Record<string, unknown>).processGroup !== child.pid) return undefined;
    return {
      version: 1,
      host,
      child: { ...child, processGroup: child.pid },
      socketPath: value.socketPath,
      argvHash: value.argvHash,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
      parentDeathSignal: value.parentDeathSignal === true,
    };
  } catch {
    return undefined;
  }
}

/** Splits a byte stream into lines. A line above `maxBytes` (delimiter excluded) is reported once and ends the splitter. `\r` before the newline is dropped. */
export class LineSplitter {
  private parts: Buffer[] = [];
  private size = 0;
  private dead = false;
  private readonly maxBytes: number;
  private readonly onLine: (line: string) => void;
  private readonly onOverflow: (bytes: number) => void;

  constructor(maxBytes: number, onLine: (line: string) => void, onOverflow: (bytes: number) => void) {
    this.maxBytes = maxBytes;
    this.onLine = onLine;
    this.onOverflow = onOverflow;
  }

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

// ---------------------------------------------------------------------------------------------------------
// Process identity (a copy of the helpers in codex/process-lifetime.ts: this file must run alone)

/** Start time of a live process in clock ticks since boot (field 22 of `/proc/<pid>/stat`). Undefined for a missing or dead process. */
export function processStartTicks(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    return fields[19] || undefined;
  } catch {
    return undefined;
  }
}

export function currentBootId(): string | undefined {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The file of `name` on `pathEnv` (or `name` itself, resolved against `cwd`, when it contains a slash) that can be executed. */
export function resolveExecutable(name: string, pathEnv: string | undefined, cwd: string): string | undefined {
  const candidates = name.includes('/')
    ? [path.resolve(cwd, name)]
    : (pathEnv ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Not here.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Environment

const SCRUBBED_ENV_NAMES = ['AGENT_CONSOLE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDECODE', 'TMUX'];
const SCRUBBED_ENV_PREFIXES = ['CLAUDE_CODE_'];
const HOST_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR'];

function isScrubbedEnv(name: string): boolean {
  return SCRUBBED_ENV_NAMES.includes(name) || SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The environment of the host process itself. It lives for days and needs only a search path and a locale, so it takes
 * those from the backend instead of everything: the backend's own session identity, provider tokens and
 * coordination variables never reach it. The child's environment is separate and exact (the env file).
 */
export function hostEnvironment(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isScrubbedEnv(name)) continue;
    if (HOST_ENV_NAMES.includes(name) || name.startsWith('LC_')) env[name] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------------------------------------
// Replay buffer

interface BufferedLine {
  seq: number;
  line: string;
  bytes: number;
  at: number;
}

/** The child's most recent stdout lines, bounded by total bytes and by age. */
export class ReplayBuffer {
  private entries: BufferedLine[] = [];
  private bytes = 0;
  private lastSeq = 0;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;

  constructor(maxBytes: number = REPLAY_MAX_BYTES, maxAgeMs: number = REPLAY_MAX_AGE_MS) {
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
  }

  get seq(): number {
    return this.lastSeq;
  }

  /** Sequence number of the oldest buffered line, or the next one when the buffer is empty. */
  get firstSeq(): number {
    return this.entries[0]?.seq ?? this.lastSeq + 1;
  }

  push(line: string, now: number): number {
    this.lastSeq += 1;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > this.maxBytes) {
      // A hole in the buffer would replay later lines as if nothing was missing, so everything older goes too.
      this.entries = [];
      this.bytes = 0;
      return this.lastSeq;
    }
    this.entries.push({ seq: this.lastSeq, line, bytes, at: now });
    this.bytes += bytes;
    this.trim(now);
    return this.lastSeq;
  }

  trim(now: number): void {
    while (this.entries.length > 0 && (this.bytes > this.maxBytes || now - this.entries[0]!.at > this.maxAgeMs)) {
      this.bytes -= this.entries.shift()!.bytes;
    }
  }

  /** Lines after `sinceSeq`. `gap` is true when some of them are no longer here, or the cursor is from another incarnation. */
  since(sinceSeq: number, now: number): { gap: boolean; entries: Array<{ seq: number; line: string }> } {
    this.trim(now);
    if (sinceSeq > this.lastSeq) return { gap: true, entries: [] };
    if (sinceSeq === this.lastSeq) return { gap: false, entries: [] };
    const gap = sinceSeq + 1 < this.firstSeq;
    return { gap, entries: this.entries.filter((entry) => entry.seq > sinceSeq).map(({ seq, line }) => ({ seq, line })) };
  }
}

// ---------------------------------------------------------------------------------------------------------
// The host

export interface SessionHostOptions {
  socketPath: string;
  recordPath: string;
  cwd: string;
  /** The child's exact environment. */
  env: Record<string, string>;
  argv: string[];
  replayMaxBytes?: number;
  replayMaxAgeMs?: number;
  lingerMs?: number;
  closeGraceMs?: number;
  termGraceMs?: number;
  /** A child line above this ends the child. Default 128 MiB. */
  maxLineBytes?: number;
  log?: (level: 'info' | 'warn', message: string, fields?: object) => void;
}

interface ChildExit {
  code: number | null;
  signal: string | null;
  stderrTail: string;
  error?: { code?: string; message: string };
}

interface Connection {
  identified: boolean;
  attached: boolean;
  timer: NodeJS.Timeout | undefined;
}

function clampGrace(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(0, Math.floor(value)), MAX_GRACE_MS) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SessionHost {
  /** Resolves with the process exit code once the host has stopped serving and cleaned up. */
  readonly done: Promise<number>;

  private readonly options: SessionHostOptions;
  private readonly buffer: ReplayBuffer;
  private readonly log: NonNullable<SessionHostOptions['log']>;
  private readonly startedAt = new Date().toISOString();
  private readonly closeGraceMs: number;
  private readonly termGraceMs: number;
  private readonly lingerMs: number;
  private readonly connections = new Map<net.Socket, Connection>();
  private readonly exitWatchers = new Set<net.Socket>();
  private readonly exitWaiters: Array<() => void> = [];
  private server: net.Server | undefined;
  private client: net.Socket | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private childPid: number | undefined;
  private childExit: ChildExit | undefined;
  private rawExit: { code: number | null; signal: string | null } | undefined;
  private exitFlushTimer: NodeJS.Timeout | undefined;
  private fatalError: { message: string } | undefined;
  private spawnError: { code?: string; message: string } | undefined;
  private parentDeathSignal = false;
  private stdinEnded = false;
  private linesWritten = 0;
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private lingerTimer: NodeJS.Timeout | undefined;
  private terminating: Promise<void> | undefined;
  private stopped = false;
  private resolveDone: (code: number) => void = () => undefined;

  constructor(options: SessionHostOptions) {
    this.options = options;
    this.buffer = new ReplayBuffer(options.replayMaxBytes, options.replayMaxAgeMs);
    this.log = options.log ?? (() => undefined);
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    this.lingerMs = options.lingerMs ?? LINGER_MS;
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Starts the child and begins serving. Rejects when another host already serves the socket. */
  async start(): Promise<void> {
    await this.claimSocket();
    await this.spawnChild();
    await this.listen();
    if (this.child && this.childPid !== undefined && !this.spawnError) this.writeRecord(this.childPid);
    this.log('info', 'session host serving', { socket: this.options.socketPath, childPid: this.childPid ?? null, parentDeathSignal: this.parentDeathSignal });
    if (this.spawnError) this.scheduleStop(FAILED_SPAWN_LINGER_MS);
  }

  /** Ends the child (stdin EOF, grace, group SIGTERM, grace, group SIGKILL); the host stops once the child is gone. */
  terminate(closeGraceMs: number = this.closeGraceMs, termGraceMs: number = this.termGraceMs): Promise<void> {
    this.terminating ??= this.terminateChild(closeGraceMs, termGraceMs);
    return this.terminating;
  }

  /** Last resort for a crashing host: SIGKILL the child's group and stop. */
  abort(): void {
    this.signalGroup('SIGKILL');
    this.stop(1);
  }

  // -------------------------------------------------------------------------------------------------------
  // Start

  /** A socket path that still answers belongs to a live host; one that does not is a leftover and is removed. */
  private async claimSocket(): Promise<void> {
    if (Buffer.byteLength(this.options.socketPath) > SOCKET_PATH_LIMIT) throw new Error(`The socket path is too long for a Unix socket: ${this.options.socketPath}`);
    fs.mkdirSync(path.dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.options.socketPath)) return;
    const live = await new Promise<boolean>((resolve) => {
      const probe = net.connect(this.options.socketPath);
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(true); // a socket that neither answers nor refuses is not ours to remove
      }, 1_000);
      probe.once('connect', () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (live) throw new Error(`Another session host already serves ${this.options.socketPath}.`);
    fs.unlinkSync(this.options.socketPath);
  }

  private async spawnChild(): Promise<void> {
    const { argv, cwd, env } = this.options;
    const setpriv = resolveExecutable('setpriv', process.env.PATH, cwd);
    let command = argv;
    if (setpriv === undefined) {
      this.log('warn', 'setpriv is not installed; the provider child outlives a crashed session host and is ended through the record file instead');
    } else if (resolveExecutable(argv[0] ?? '', env.PATH, cwd) !== undefined) {
      command = [setpriv, '--pdeathsig', 'TERM', '--', ...argv];
      this.parentDeathSignal = true;
    } // else: a missing binary is started plainly so that the failure is the usual ENOENT, not a setpriv exit code.
    const child = spawn(command[0] ?? '', command.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child = child;
    const splitter = new LineSplitter(
      this.options.maxLineBytes ?? MAX_LINE_BYTES,
      (line) => this.onChildLine(line),
      (bytes) => this.failChild(`A provider line exceeded the limit (${bytes} bytes read).`),
    );
    child.stdout.on('data', (chunk: Buffer) => splitter.push(chunk));
    child.stdout.on('end', () => splitter.end());
    child.stderr.on('data', (chunk: Buffer) => this.appendStderr(chunk));
    child.stdin.on('error', (error) => this.log('warn', 'provider stdin error', { error: error.message }));
    child.once('exit', (code, signal) => {
      this.rawExit = { code, signal };
      // The stdout pipe can outlive the process (an inherited descriptor); do not wait for it forever.
      this.exitFlushTimer = setTimeout(() => this.onChildEnded(), EXIT_FLUSH_MS);
      this.exitFlushTimer.unref();
    });
    child.once('close', (code, signal) => {
      this.rawExit ??= { code, signal };
      this.onChildEnded();
    });
    await new Promise<void>((resolve) => {
      child.once('spawn', () => {
        this.childPid = child.pid;
        resolve();
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (this.childPid !== undefined) {
          this.log('warn', 'provider process error', { error: error.message });
          return;
        }
        this.spawnError = { ...(error.code ? { code: error.code } : {}), message: error.message };
        this.childExit = { code: null, signal: null, stderrTail: '', error: this.spawnError };
        resolve();
      });
    });
  }

  private listen(): Promise<void> {
    const previousUmask = process.umask(0o177); // the socket is created 0600: no window in which others could connect
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      this.server = server;
      server.once('error', reject);
      server.listen(this.options.socketPath, () => {
        process.umask(previousUmask);
        try {
          fs.chmodSync(this.options.socketPath, 0o600);
        } catch (error) {
          reject(error);
          return;
        }
        server.off('error', reject);
        server.on('error', (error) => this.log('warn', 'socket server error', { error: error.message }));
        resolve();
      });
    }).finally(() => {
      process.umask(previousUmask);
    });
  }

  private writeRecord(childPid: number): void {
    const record: HostRecord = {
      version: 1,
      host: { pid: process.pid, ...optional('startTicks', processStartTicks(process.pid)), ...optional('bootId', currentBootId()) },
      child: { pid: childPid, ...optional('startTicks', processStartTicks(childPid)), ...optional('bootId', currentBootId()), processGroup: childPid },
      socketPath: this.options.socketPath,
      argvHash: argvHash(this.options.argv),
      startedAt: this.startedAt,
      parentDeathSignal: this.parentDeathSignal,
    };
    const temporary = `${this.options.recordPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.options.recordPath);
  }

  private removeRecord(): void {
    try {
      const current = parseHostRecord(fs.readFileSync(this.options.recordPath, 'utf8'));
      if (current && current.host.pid !== process.pid) return; // a successor's record
      fs.unlinkSync(this.options.recordPath);
    } catch {
      // Already gone.
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // The child

  private onChildLine(line: string): void {
    const seq = this.buffer.push(line, Date.now());
    if (this.client) this.send(this.client, { seq, line });
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk);
    this.stderrBytes += chunk.length;
    while (this.stderrBytes > STDERR_TAIL_BYTES && this.stderrChunks.length > 0) {
      const first = this.stderrChunks[0]!;
      const excess = this.stderrBytes - STDERR_TAIL_BYTES;
      if (first.length <= excess) {
        this.stderrChunks.shift();
        this.stderrBytes -= first.length;
      } else {
        this.stderrChunks[0] = first.subarray(excess);
        this.stderrBytes -= excess;
      }
    }
  }

  private stderrTail(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8');
  }

  private failChild(message: string): void {
    if (this.fatalError || this.childExit) return;
    this.fatalError = { message };
    this.log('warn', 'ending the provider child', { reason: message });
    this.signalGroup('SIGKILL');
    this.rawExit ??= { code: null, signal: 'SIGKILL' };
    this.onChildEnded();
  }

  private onChildEnded(): void {
    if (this.childExit) return;
    if (this.exitFlushTimer) clearTimeout(this.exitFlushTimer);
    const raw = this.rawExit ?? { code: null, signal: null };
    this.childExit = { code: raw.code, signal: raw.signal, stderrTail: this.stderrTail(), ...(this.fatalError ? { error: this.fatalError } : {}) };
    this.log('info', 'provider child ended', { code: raw.code, signal: raw.signal, error: this.fatalError?.message ?? null });
    for (const wake of this.exitWaiters.splice(0)) wake();
    if (this.client) this.send(this.client, this.exitMessage());
    for (const watcher of this.exitWatchers) {
      this.send(watcher, this.exitMessage());
      watcher.end();
    }
    this.exitWatchers.clear();
    if (this.terminating) this.scheduleStop(0);
    else this.scheduleStop(this.lingerMs);
  }

  private exitMessage(): object {
    const exit = this.childExit!;
    return { type: 'exit', code: exit.code, signal: exit.signal, stderrTail: exit.stderrTail, ...(exit.error ? { error: exit.error } : {}) };
  }

  private waitChildExit(ms: number): Promise<boolean> {
    if (this.childExit) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Signals the child's whole process group (the child leads it; a launcher's own child shares it). */
  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.childPid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }

  private async terminateChild(closeGraceMs: number, termGraceMs: number): Promise<void> {
    if (this.childExit || !this.child) {
      this.scheduleStop(0);
      return;
    }
    this.endStdin();
    if (await this.waitChildExit(closeGraceMs)) return this.sweepGroup();
    this.log('warn', 'provider ignored stdin EOF; sending SIGTERM to its group');
    this.signalGroup('SIGTERM');
    if (await this.waitChildExit(termGraceMs)) return this.sweepGroup();
    this.log('warn', 'provider ignored SIGTERM; sending SIGKILL to its group');
    this.signalGroup('SIGKILL');
    await this.waitChildExit(2_000);
    if (!this.childExit) this.onChildEnded(); // unkillable (uninterruptible sleep): report and stop anyway
  }

  /** A launcher can leave its own child behind in the group; an ended terminate leaves nothing running. */
  private sweepGroup(): void {
    this.signalGroup('SIGKILL');
  }

  private endStdin(): void {
    if (this.stdinEnded || !this.child) return;
    this.stdinEnded = true;
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
  }

  private writeToChild(line: string): void {
    if (this.childExit || this.stdinEnded || !this.child || this.child.stdin.destroyed || !this.child.stdin.writable) return;
    this.linesWritten += 1;
    this.child.stdin.write(`${line}\n`);
  }

  // -------------------------------------------------------------------------------------------------------
  // Clients

  private onConnection(socket: net.Socket): void {
    const connection: Connection = { identified: false, attached: false, timer: undefined };
    this.connections.set(socket, connection);
    connection.timer = setTimeout(() => {
      if (!connection.identified) socket.destroy();
    }, UNIDENTIFIED_CONNECTION_MS);
    connection.timer.unref();
    const splitter = new LineSplitter(MAX_LINE_BYTES * 2 + 4096, (line) => this.onMessage(socket, connection, line), () => socket.destroy());
    socket.on('data', (chunk: Buffer) => splitter.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (connection.timer) clearTimeout(connection.timer);
      this.connections.delete(socket);
      this.exitWatchers.delete(socket);
      if (this.client === socket) this.client = undefined;
      if (this.spawnError && connection.attached) this.scheduleStop(0); // the failure has been delivered; nothing else to serve
    });
  }

  private onMessage(socket: net.Socket, connection: Connection, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.send(socket, { type: 'error', message: 'The message is not JSON.' });
      return;
    }
    if (!isRecord(message) || typeof message.type !== 'string') {
      this.send(socket, { type: 'error', message: 'The message has no type.' });
      return;
    }
    connection.identified = true;
    switch (message.type) {
      case 'hello':
        this.attach(socket, connection, message);
        return;
      case 'write':
        if (connection.attached && this.client === socket && typeof message.line === 'string' && !message.line.includes('\n')) this.writeToChild(message.line);
        else this.log('warn', 'ignored a write', { attached: connection.attached, current: this.client === socket });
        return;
      case 'status':
        this.send(socket, this.statusMessage());
        if (!connection.attached) socket.end();
        return;
      case 'terminate':
        if (this.childExit) {
          this.send(socket, this.exitMessage());
          socket.end();
        } else if (this.client !== socket) {
          this.exitWatchers.add(socket); // the client itself gets the exit message anyway
        }
        void this.terminate(clampGrace(message.closeGraceMs, this.closeGraceMs), clampGrace(message.termGraceMs, this.termGraceMs));
        return;
      default:
        this.send(socket, { type: 'error', message: `Unknown message type "${message.type}".` });
    }
  }

  private attach(socket: net.Socket, connection: Connection, hello: Record<string, unknown>): void {
    connection.attached = true;
    const previous = this.client;
    this.client = socket;
    if (previous && previous !== socket) {
      this.send(previous, { type: 'replaced' });
      previous.end();
      this.log('info', 'a new client replaced the previous one');
    }
    const now = Date.now();
    this.buffer.trim(now);
    this.send(socket, {
      type: 'welcome',
      version: HOST_PROTOCOL_VERSION,
      hostPid: process.pid,
      childPid: this.childPid ?? null,
      alive: this.childExit === undefined,
      seq: this.buffer.seq,
      firstSeq: this.buffer.firstSeq,
      everWrote: this.linesWritten > 0,
      startedAt: this.startedAt,
      ...(this.spawnError ? { spawnError: this.spawnError } : {}),
    });
    const since = hello.sinceSeq;
    if (typeof since === 'number' && Number.isInteger(since) && since >= 0) {
      const replay = this.buffer.since(since, now);
      if (replay.gap) this.send(socket, { type: 'gap', firstSeq: this.buffer.firstSeq });
      for (const entry of replay.entries) this.send(socket, entry);
    }
    if (this.childExit) this.send(socket, this.exitMessage());
  }

  private statusMessage(): object {
    this.buffer.trim(Date.now());
    return {
      type: 'status',
      pid: this.childPid ?? null,
      hostPid: process.pid,
      alive: this.childExit === undefined,
      seq: this.buffer.seq,
      firstSeq: this.buffer.firstSeq,
      everWrote: this.linesWritten > 0,
      clients: this.client ? 1 : 0,
      startedAt: this.startedAt,
    };
  }

  private send(socket: net.Socket, message: object): void {
    if (socket.destroyed || !socket.writable) return;
    if (socket.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
      this.log('warn', 'dropping a client that does not read its output');
      socket.destroy();
      return;
    }
    socket.write(`${JSON.stringify(message)}\n`);
  }

  // -------------------------------------------------------------------------------------------------------
  // Stop

  private scheduleStop(afterMs: number): void {
    if (this.stopped) return;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    if (afterMs <= 0) {
      this.stop(0);
      return;
    }
    this.lingerTimer = setTimeout(() => this.stop(0), afterMs);
  }

  private stop(code: number): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.removeRecord(); // first: nobody may adopt a host that is going away
    const finish = (): void => {
      try {
        fs.unlinkSync(this.options.socketPath);
      } catch {
        // Already gone.
      }
      this.resolveDone(code);
    };
    const sockets = [...this.connections.keys()];
    for (const socket of sockets) socket.end();
    const close = new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    // Connections that do not finish ending are destroyed so the host never hangs on a peer.
    const force = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 500);
    force.unref();
    void close.then(finish);
    setTimeout(finish, 1_500).unref();
  }
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

// ---------------------------------------------------------------------------------------------------------
// Program

export interface ParsedHostArgs {
  socketPath: string;
  recordPath: string;
  cwd: string;
  envFile: string;
  argv: string[];
  replayMaxBytes?: number;
  replayMaxAgeMs?: number;
  lingerMs?: number;
  maxLineBytes?: number;
}

/** `--socket <path> --record <path> --cwd <dir> --env-file <path> [--replay-bytes n --replay-age-ms n --linger-ms n --max-line-bytes n] -- <argv...>` */
export function parseHostArgs(args: string[]): ParsedHostArgs {
  const values = new Map<string, string>();
  let argv: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') {
      argv = args.slice(index + 1);
      break;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}".`);
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${arg} needs a value.`);
    values.set(arg, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  if (argv.length === 0) throw new Error('The provider command is missing after "--".');
  const number = (name: string): number | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number.`);
    return parsed;
  };
  const replayMaxBytes = number('--replay-bytes');
  const replayMaxAgeMs = number('--replay-age-ms');
  const lingerMs = number('--linger-ms');
  const maxLineBytes = number('--max-line-bytes');
  return {
    socketPath: required('--socket'),
    recordPath: required('--record'),
    cwd: required('--cwd'),
    envFile: required('--env-file'),
    argv,
    ...(replayMaxBytes !== undefined ? { replayMaxBytes } : {}),
    ...(replayMaxAgeMs !== undefined ? { replayMaxAgeMs } : {}),
    ...(lingerMs !== undefined ? { lingerMs } : {}),
    ...(maxLineBytes !== undefined ? { maxLineBytes } : {}),
  };
}

/** The child's environment from its env file: a JSON object of strings. The file is removed once read; it can hold tokens. */
export function readEnvFile(file: string): Record<string, string> {
  const text = fs.readFileSync(file, 'utf8');
  try {
    fs.unlinkSync(file);
  } catch {
    // Not removable: it is still only readable by this user.
  }
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) throw new Error('The env file must hold a JSON object.');
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') env[name] = entry;
  }
  return env;
}

function writeLog(level: 'info' | 'warn', message: string, fields?: object): void {
  process.stderr.write(`${new Date().toISOString()} ${level} ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}\n`);
}

async function main(): Promise<void> {
  // Defense in depth: a hand-started host must not pass the starter's session identity along either.
  for (const name of Object.keys(process.env)) {
    if (isScrubbedEnv(name)) delete process.env[name];
  }
  let host: SessionHost;
  try {
    const args = parseHostArgs(process.argv.slice(2));
    host = new SessionHost({
      socketPath: args.socketPath,
      recordPath: args.recordPath,
      cwd: args.cwd,
      env: readEnvFile(args.envFile),
      argv: args.argv,
      ...(args.replayMaxBytes !== undefined ? { replayMaxBytes: args.replayMaxBytes } : {}),
      ...(args.replayMaxAgeMs !== undefined ? { replayMaxAgeMs: args.replayMaxAgeMs } : {}),
      ...(args.lingerMs !== undefined ? { lingerMs: args.lingerMs } : {}),
      ...(args.maxLineBytes !== undefined ? { maxLineBytes: args.maxLineBytes } : {}),
      log: writeLog,
    });
    await host.start();
  } catch (error) {
    writeLog('warn', 'session host could not start', { error: error instanceof Error ? error.message : String(error) });
    process.exit(/already serves/.test(String(error instanceof Error ? error.message : error)) ? 3 : 2);
  }
  process.on('SIGTERM', () => void host.terminate());
  process.on('SIGINT', () => void host.terminate());
  process.on('SIGHUP', () => undefined);
  process.on('uncaughtException', (error) => {
    writeLog('warn', 'session host crashed', { error: error.message });
    host.abort();
  });
  const code = await host.done;
  process.exit(code);
}

function realpath(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

// Run only when started as the program; importing this module (for its protocol pieces) starts nothing.
const entry = process.argv[1] ? realpath(process.argv[1]) : undefined;
if (entry !== undefined && entry === realpath(fileURLToPath(import.meta.url))) void main();
