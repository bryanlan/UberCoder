import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentBootId, processGroupId, processStartTicks } from '../src/providers/transport/codex/process-lifetime.js';
import {
  createLineTransportFactory,
  HostLineTransport,
  hostPaths,
  LineTransportSpawnError,
  readHostRecord,
  StdioLineTransport,
  terminateHost,
  terminateHostAt,
  transportStartedFresh,
  type LineTransportExit,
} from '../src/providers/transport/line-transport.js';
import {
  argvHash,
  hostEnvironment,
  LineSplitter,
  parseHostArgs,
  parseHostRecord,
  processGroupHasMembers,
  ReplayBuffer,
  resolveExecutable,
} from '../src/providers/transport/session-host.js';
import { LineTransportNotRunningError, NotSentError, TransportUnavailableError } from '../src/providers/transport/types.js';

// These tests run the real host program (`session-host.ts`, whose types Node strips) against a scripted child.
vi.setConfig({ testTimeout: 30_000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST_PROGRAM = path.join(here, '../src/providers/transport/session-host.ts');
const FAKE_CHILD = path.join(here, 'helpers/fake-host-child.mjs');
const hasSetpriv = resolveExecutable('setpriv', process.env.PATH, '/') !== undefined;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil<T>(probe: () => T | undefined | false, timeoutMs = 8_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(15);
  }
}

function running(pid: number): boolean {
  return processStartTicks(pid) !== undefined;
}

async function untilGone(pid: number, ms = 8_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Ends whatever a test left behind: the host named by a record, the child it started and anything in their groups. */
function reapRecord(recordPath: string): void {
  const record = readHostRecord(recordPath);
  if (!record) return;
  for (const [pid, group] of [[record.child.pid, true], [record.host.pid, false]] as const) {
    try { process.kill(group ? -pid : pid, 'SIGKILL'); } catch { /* gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

const line = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------------------------------------
describe('session host protocol pieces', () => {
  it('keeps the replay buffer within its byte and age bounds and reports what is missing', () => {
    const buffer = new ReplayBuffer(100, 1_000);
    expect(buffer.seq).toBe(0);
    expect(buffer.firstSeq).toBe(1);
    for (let index = 1; index <= 5; index += 1) buffer.push('x'.repeat(30), 0); // 5 lines of 30 bytes; 3 fit
    expect(buffer.seq).toBe(5);
    expect(buffer.firstSeq).toBe(3);
    expect(buffer.since(2, 0)).toMatchObject({ gap: false, entries: [{ seq: 3 }, { seq: 4 }, { seq: 5 }] });
    expect(buffer.since(4, 0)).toEqual({ gap: false, entries: [{ seq: 5, line: 'x'.repeat(30) }] });
    expect(buffer.since(5, 0)).toEqual({ gap: false, entries: [] });
    expect(buffer.since(1, 0)).toMatchObject({ gap: true, entries: [{ seq: 3 }, { seq: 4 }, { seq: 5 }] });
    expect(buffer.since(0, 0).gap).toBe(true);
    expect(buffer.since(99, 0)).toEqual({ gap: true, entries: [] }); // a cursor from another incarnation

    // Age: nothing older than the limit is replayed.
    expect(buffer.since(2, 2_000)).toEqual({ gap: true, entries: [] });
    expect(buffer.firstSeq).toBe(6);
  });

  it('drops the whole buffer for one line larger than it, so a replay never skips a line unannounced', () => {
    const buffer = new ReplayBuffer(100, 60_000);
    buffer.push('a', 0);
    buffer.push('b', 0);
    buffer.push('z'.repeat(500), 0); // seq 3 cannot be kept
    buffer.push('c', 0);
    expect(buffer.seq).toBe(4);
    expect(buffer.firstSeq).toBe(4);
    expect(buffer.since(2, 0)).toMatchObject({ gap: true, entries: [{ seq: 4, line: 'c' }] });
    expect(buffer.since(3, 0)).toMatchObject({ gap: false, entries: [{ seq: 4 }] });
  });

  it('splits lines with a cap and strips carriage returns', () => {
    const lines: string[] = [];
    const overflow: number[] = [];
    const splitter = new LineSplitter(10, (value) => lines.push(value), (bytes) => overflow.push(bytes));
    splitter.push(Buffer.from('ab\r\ncd'));
    splitter.push(Buffer.from('ef\n\ngh'));
    splitter.end();
    expect(lines).toEqual(['ab', 'cdef', '', 'gh']); // an empty line is a line; the JSON-RPC client ignores it
    splitter.push(Buffer.from('0123456789ABC'));
    expect(overflow).toEqual([13]);
    expect(splitter.overflowed).toBe(true);
  });

  it('hashes an argv, parses host arguments and rejects incomplete ones', () => {
    expect(argvHash(['a', 'b'])).toBe(argvHash(['a', 'b']));
    expect(argvHash(['a', 'b'])).not.toBe(argvHash(['a b']));
    expect(parseHostArgs(['--socket', '/s', '--record', '/r', '--cwd', '/c', '--env-file', '/e', '--linger-ms', '5', '--', 'codex', 'app-server', '--x']))
      .toEqual({ socketPath: '/s', recordPath: '/r', cwd: '/c', envFile: '/e', argv: ['codex', 'app-server', '--x'], lingerMs: 5 });
    expect(() => parseHostArgs(['--socket', '/s', '--record', '/r', '--cwd', '/c', '--env-file', '/e'])).toThrow(/command is missing/);
    expect(() => parseHostArgs(['--socket', '/s', '--', 'x'])).toThrow(/--record is required/);
    expect(() => parseHostArgs(['--socket'])).toThrow(/needs a value/);
  });

  it('gives the host process a search path and a locale, not the backend environment', () => {
    expect(hostEnvironment({
      PATH: '/usr/bin', HOME: '/home/u', LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC', TMPDIR: '/tmp',
      AGENT_CONSOLE_SESSION_ID: 's', CODEX_THREAD_ID: 't', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', TMUX: '/tmp/tmux', AGENT_COORD_RUNTIME: '/r', OPENAI_API_KEY: 'k',
    })).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC', TMPDIR: '/tmp' });
  });

  it('reads a record only when every identity in it is usable', () => {
    const good = {
      version: 1, host: { pid: 40, startTicks: '9', bootId: 'b' }, child: { pid: 41, startTicks: '10', bootId: 'b', processGroup: 41 },
      socketPath: '/s', argvHash: 'h', startedAt: 'now', parentDeathSignal: true,
    };
    expect(parseHostRecord(JSON.stringify(good))).toEqual(good);
    expect(parseHostRecord(JSON.stringify({ ...good, child: { ...good.child, processGroup: 7 } }))).toBeUndefined(); // only a group the child leads
    expect(parseHostRecord(JSON.stringify({ ...good, host: { pid: 1 } }))).toBeUndefined();
    expect(parseHostRecord(JSON.stringify({ ...good, version: 2 }))).toBeUndefined();
    expect(parseHostRecord('not json')).toBeUndefined();
  });

  it('puts a host under <runtime>/structured/hosts, shortens a long socket path and refuses odd ids', () => {
    const paths = hostPaths('/run/console', 'codex');
    expect(paths).toMatchObject({ dir: '/run/console/structured/hosts', record: '/run/console/structured/hosts/codex.json', socket: '/run/console/structured/hosts/codex.sock' });
    const long = hostPaths('/run/console', 'a'.repeat(100));
    expect(path.basename(long.socket)).toMatch(/^[0-9a-f]{16}\.sock$/);
    expect(path.basename(long.record)).toBe(`${'a'.repeat(100)}.json`);
    for (const bad of ['', '../x', 'a/b', '.hidden', 'a b']) expect(() => hostPaths('/run/console', bad)).toThrow(/not a valid session host id/);
    expect(() => hostPaths(`/${'d'.repeat(120)}`, 'codex')).toThrow(/too long for a Unix socket/);
  });
});

// ---------------------------------------------------------------------------------------------------------
interface HostRig {
  dir: string;
  socketPath: string;
  recordPath: string;
  childLog: string;
  proc: ChildProcess;
  hostPid: number;
}

/** Runs the real host program detached, as the backend does, with the fake child behind it. */
async function startHost(options: {
  childFlags?: string[];
  hostFlags?: string[];
  childEnv?: Record<string, string>;
  hostEnv?: NodeJS.ProcessEnv;
  childArgv?: string[];
  dir?: string;
} = {}): Promise<HostRig> {
  const dir = options.dir ?? scratch();
  const socketPath = path.join(dir, 'h.sock');
  const recordPath = path.join(dir, 'h.json');
  const envFile = path.join(dir, 'h.env');
  const childLog = path.join(dir, 'child.log');
  fs.writeFileSync(envFile, JSON.stringify(options.childEnv ?? { PATH: process.env.PATH ?? '', MARKER: 'child-env' }), { mode: 0o600 });
  const logFd = fs.openSync(path.join(dir, 'host.log'), 'a');
  const childArgv = options.childArgv ?? [process.execPath, FAKE_CHILD, childLog, ...(options.childFlags ?? [])];
  const proc = spawn(process.execPath, [HOST_PROGRAM, '--socket', socketPath, '--record', recordPath, '--cwd', dir, '--env-file', envFile, ...(options.hostFlags ?? []), '--', ...childArgv], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: options.hostEnv ?? { PATH: process.env.PATH },
  });
  fs.closeSync(logFd);
  proc.unref();
  cleanups.push(() => reapRecord(recordPath));
  cleanups.push(() => { try { process.kill(proc.pid!, 'SIGKILL'); } catch { /* gone */ } });
  await waitUntil(() => fs.existsSync(recordPath) && fs.existsSync(socketPath), 10_000, 'the host to serve');
  return { dir, socketPath, recordPath, childLog, proc, hostPid: proc.pid! };
}

function childEvents(rig: HostRig): Array<Record<string, unknown>> {
  if (!fs.existsSync(rig.childLog)) return [];
  return fs.readFileSync(rig.childLog, 'utf8').split('\n').filter(Boolean).map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

/** A transport plus the lines and exit it saw. */
async function connect(rig: HostRig, sinceSeq?: number, extra: { closeGraceMs?: number; termGraceMs?: number } = {}) {
  const transport = await HostLineTransport.connect({ socketPath: rig.socketPath, ...(sinceSeq !== undefined ? { sinceSeq } : {}), ...extra });
  const lines: string[] = [];
  const exits: LineTransportExit[] = [];
  transport.onLine((value) => lines.push(value));
  transport.onExit((info) => exits.push(info));
  cleanups.push(() => transport.close().catch(() => undefined));
  return { transport, lines, exits, parsed: () => lines.map((value) => JSON.parse(value) as Record<string, any>) };
}

/** A bare protocol client, for what the transport does not send itself. */
async function raw(socketPath: string) {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    connection.once('connect', () => resolve(connection));
    connection.once('error', reject);
  });
  socket.on('error', () => undefined);
  const messages: Array<Record<string, any>> = [];
  let buffered = '';
  let closed = false;
  socket.on('data', (chunk) => {
    buffered += chunk.toString();
    for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
      messages.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  socket.on('close', () => { closed = true; });
  cleanups.push(() => { socket.destroy(); });
  return {
    send: (value: unknown) => socket.write(`${JSON.stringify(value)}\n`),
    messages,
    isClosed: () => closed,
    waitFor: (predicate: (message: Record<string, any>) => boolean, label: string) => waitUntil(() => messages.find(predicate), 8_000, label),
    close: () => socket.destroy(),
  };
}

describe('the session host program', () => {
  it('writes its record, serves a 0600 socket and starts the child in its own group under the host', async () => {
    const rig = await startHost();
    const { transport } = await connect(rig);
    const record = parseHostRecord(fs.readFileSync(rig.recordPath, 'utf8'))!;
    expect(record).toBeDefined();

    expect(record.host).toEqual({ pid: rig.hostPid, startTicks: processStartTicks(rig.hostPid), bootId: currentBootId() });
    expect(record.child.pid).toBe(transport.pid);
    expect(record.child).toMatchObject({ startTicks: processStartTicks(record.child.pid), bootId: currentBootId(), processGroup: record.child.pid });
    expect(processGroupId(record.child.pid)).toBe(record.child.pid); // the child leads its own group
    expect(processGroupId(rig.hostPid)).toBe(rig.hostPid); // the host is detached: its own session and group
    expect(record.socketPath).toBe(rig.socketPath);
    expect(record.argvHash).toBe(argvHash([process.execPath, FAKE_CHILD, rig.childLog]));
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
    expect(record.parentDeathSignal).toBe(hasSetpriv);
    expect(fs.statSync(rig.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(rig.recordPath).mode & 0o777).toBe(0o600);
    expect(transport.info).toMatchObject({ hostPid: rig.hostPid, childPid: record.child.pid, alive: true, seq: 0, everWrote: false });
  });

  it('gives the child exactly the environment of the env file and removes the file', async () => {
    const childEnv = { PATH: process.env.PATH ?? '', ONLY_THIS: 'yes' };
    const rig = await startHost({ childEnv, hostEnv: { PATH: process.env.PATH, AGENT_CONSOLE_SESSION_ID: 'leaked', CODEX_THREAD_ID: 'leaked' } });
    expect(fs.existsSync(path.join(rig.dir, 'h.env'))).toBe(false); // read once, then deleted: it can hold tokens
    const { transport, parsed } = await connect(rig);
    await transport.write(line({ cmd: 'env' }));
    await waitUntil(() => parsed().find((entry) => entry.env), 8_000, 'the env answer');
    const answer = parsed().find((entry) => entry.env)!;
    expect(answer.env).toEqual(childEnv);
    expect(answer.cwd).toBe(fs.realpathSync(rig.dir));
    expect(answer.ppid).toBe(rig.hostPid);
  });

  it('relays lines both ways with increasing sequence numbers and counts what it wrote to the child', async () => {
    const rig = await startHost();
    const { transport, lines, parsed } = await connect(rig);
    expect(transportStartedFresh(transport)).toBe(true);
    await transport.write(line({ cmd: 'echo', text: 'one' }));
    await transport.write(line({ cmd: 'echo', text: 'two' }));
    await waitUntil(() => lines.length === 2, 8_000, 'two answers');
    expect(parsed()).toEqual([{ echo: 'one' }, { echo: 'two' }]);
    expect(transport.lastSeq).toBe(2);
    const status = await transport.status();
    expect(status).toMatchObject({ pid: transport.pid, hostPid: rig.hostPid, alive: true, seq: 2, firstSeq: 1, everWrote: true, clients: 1 });
    await expect(transport.write('has\nnewline')).rejects.toThrow(/newline/);
  });

  it('keeps the child running when the client disconnects and replays what the next client missed', async () => {
    const rig = await startHost();
    const first = await connect(rig);
    await first.transport.write(line({ cmd: 'echo', text: 'seen' }));
    await waitUntil(() => first.lines.length === 1, 8_000, 'the first answer');
    const cursor = first.transport.lastSeq;
    expect(cursor).toBe(1);
    await first.transport.close(); // disconnect only
    expect(first.exits).toEqual([expect.objectContaining({ reason: 'disconnected', code: null, signal: null })]);
    const childPid = first.transport.pid!;
    expect(running(childPid)).toBe(true);

    // Output while nobody is connected is kept...
    const sender = await connect(rig);
    await sender.transport.write(line({ cmd: 'burst', count: 3, bytes: 0 }));
    await waitUntil(() => sender.lines.length === 3, 8_000, 'the burst');
    await sender.transport.close();

    // ...and a client that says where it stopped gets exactly the rest, with no gap.
    const second = await connect(rig, cursor);
    expect(second.transport.gap).toBeUndefined();
    expect(second.transport.info).toMatchObject({ childPid, alive: true, seq: 4, everWrote: true });
    await waitUntil(() => second.lines.length === 3, 8_000, 'the replay');
    expect(second.parsed().map((entry) => entry.burst)).toEqual([0, 1, 2]);
    expect(second.transport.lastSeq).toBe(4);

    // A client that asks for live output only gets none of it again.
    await second.transport.close();
    const live = await connect(rig);
    await sleep(150);
    expect(live.lines).toEqual([]);
    expect(live.transport.lastSeq).toBe(4);
    expect(transportStartedFresh(live.transport)).toBe(false); // the child was used: no second handshake
    await live.transport.write(line({ cmd: 'echo', text: 'still here' }));
    await waitUntil(() => live.lines.length === 1, 8_000, 'a live answer');
    expect(live.transport.pid).toBe(childPid);
  });

  it('tells a client that asks for more than the buffer holds, and replays what it has', async () => {
    const rig = await startHost({ hostFlags: ['--replay-bytes', '400'] });
    const sender = await connect(rig);
    await sender.transport.write(line({ cmd: 'burst', count: 20, bytes: 60 })); // ~90 bytes each: only the last few fit
    await waitUntil(() => sender.lines.length === 20, 8_000, 'the burst');
    await sender.transport.close();

    const late = await connect(rig, 0);
    await waitUntil(() => late.lines.length > 0, 8_000, 'a partial replay');
    expect(late.transport.gap).toBeDefined();
    expect(late.transport.gap!.firstSeq).toBeGreaterThan(1);
    expect(late.transport.info.firstSeq).toBe(late.transport.gap!.firstSeq);
    expect(late.parsed()[0]!.burst).toBe(late.transport.gap!.firstSeq - 1); // seq n carries burst n-1: what follows the gap is contiguous
    expect(late.parsed().at(-1)!.burst).toBe(19);
    expect(late.lines.length).toBeLessThan(20);

    // A cursor from the future is not satisfiable either.
    const future = await connect(rig, 9_999);
    await sleep(100);
    expect(future.transport.gap).toBeDefined();
    expect(future.lines).toEqual([]);
  });

  it('drops lines older than the age limit from the replay', async () => {
    const rig = await startHost({ hostFlags: ['--replay-age-ms', '250'] });
    const sender = await connect(rig);
    await sender.transport.write(line({ cmd: 'echo', text: 'old' }));
    await waitUntil(() => sender.lines.length === 1, 8_000, 'the old line');
    await sleep(400);
    await sender.transport.write(line({ cmd: 'echo', text: 'new' }));
    await waitUntil(() => sender.lines.length === 2, 8_000, 'the new line');
    await sender.transport.close();

    const late = await connect(rig, 0);
    await waitUntil(() => late.lines.length > 0, 8_000, 'the replay');
    expect(late.parsed()).toEqual([{ echo: 'new' }]);
    expect(late.transport.gap).toBeDefined();
  });

  it('serves one client at a time: a new one replaces the old one, and a status request replaces nobody', async () => {
    const rig = await startHost();
    const first = await connect(rig);
    const probe = await raw(rig.socketPath);
    probe.send({ type: 'status' });
    const status = await probe.waitFor((message) => message.type === 'status', 'the status answer');
    expect(status).toMatchObject({ pid: first.transport.pid, alive: true, clients: 1 });
    await waitUntil(() => probe.isClosed(), 8_000, 'the status connection to close');
    // A control connection cannot write to the child.
    const impostor = await raw(rig.socketPath);
    impostor.send({ type: 'write', line: line({ cmd: 'echo', text: 'impostor' }) });
    await sleep(100);
    impostor.close();
    expect(first.lines).toEqual([]);

    const second = await connect(rig);
    await waitUntil(() => first.exits.length === 1, 8_000, 'the first client to be dropped');
    expect(first.exits[0]).toMatchObject({ reason: 'disconnected' });
    expect(first.exits[0]!.error?.message).toMatch(/took over/);
    await expect(first.transport.write(line({ cmd: 'echo', text: 'late' }))).rejects.toBeInstanceOf(NotSentError);
    await second.transport.write(line({ cmd: 'echo', text: 'mine' }));
    await waitUntil(() => second.lines.length === 1, 8_000, 'the new client to be served');
    expect(first.lines).toEqual([]); // output goes to the current client only
  });

  it('reports the child exit with its code and stderr, keeps answering for a while, then removes its files and exits', async () => {
    const rig = await startHost({ hostFlags: ['--linger-ms', '700'] });
    const { transport, exits } = await connect(rig);
    const childPid = transport.pid!;
    await transport.write(line({ cmd: 'stderr', text: 'boom: something broke\n' }));
    await transport.write(line({ cmd: 'exit', code: 7 }));
    await waitUntil(() => exits.length === 1, 8_000, 'the exit');
    expect(exits[0]).toMatchObject({ code: 7, signal: null, reason: 'exited' });
    expect(transport.stderrTail()).toContain('boom: something broke');
    expect(running(childPid)).toBe(false);

    // The host lingers so a backend that reconnects learns the outcome, and its record stays until it leaves.
    expect(running(rig.hostPid)).toBe(true);
    expect(fs.existsSync(rig.recordPath)).toBe(true);
    const late = await raw(rig.socketPath);
    late.send({ type: 'hello' });
    await late.waitFor((message) => message.type === 'welcome' && message.alive === false, 'a welcome that says the child ended');
    const exit = await late.waitFor((message) => message.type === 'exit', 'the exit message');
    expect(exit).toMatchObject({ code: 7, signal: null });
    expect(exit.stderrTail).toContain('boom');
    late.close();

    expect(await untilGone(rig.hostPid)).toBe(true);
    expect(fs.existsSync(rig.recordPath)).toBe(false);
    expect(fs.existsSync(rig.socketPath)).toBe(false);
  });

  it('reports a child killed by a signal', async () => {
    const rig = await startHost();
    const { transport, exits } = await connect(rig);
    await transport.write(line({ cmd: 'signal', name: 'SIGKILL' }));
    await waitUntil(() => exits.length === 1, 8_000, 'the exit');
    expect(exits[0]).toMatchObject({ code: null, signal: 'SIGKILL', reason: 'exited' });
  });

  describe('what the child leaves in its process group', () => {
    // An MCP server or a background shell the provider started shares its group and can outlive it.
    async function startWithGrandchild(): Promise<{ rig: HostRig; grandchild: number; childPid: number; transport: HostLineTransport; exits: LineTransportExit[] }> {
      const rig = await startHost({ childFlags: ['--grandchild'], hostFlags: ['--linger-ms', '3000'] });
      const grandchild = (await waitUntil(() => childEvents(rig).find((entry) => entry.event === 'grandchild'), 8_000, 'the grandchild'))!.pid as number;
      cleanups.push(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ } });
      const { transport, exits } = await connect(rig);
      expect(running(grandchild)).toBe(true);
      expect(processGroupId(grandchild)).toBe(transport.pid); // in the child's group
      return { rig, grandchild, childPid: transport.pid!, transport, exits };
    }

    it('are ended when the child exits on its own', async () => {
      const { grandchild, transport, exits } = await startWithGrandchild();
      await transport.write(line({ cmd: 'exit', code: 0 }));
      await waitUntil(() => exits.length === 1, 8_000, 'the exit');
      expect(await untilGone(grandchild, 5_000)).toBe(true);
    });

    it('are ended when the child is killed (a crash or an out-of-memory kill)', async () => {
      const { grandchild, transport, exits } = await startWithGrandchild();
      await transport.write(line({ cmd: 'signal', name: 'SIGKILL' }));
      await waitUntil(() => exits.length === 1, 8_000, 'the exit');
      expect(exits[0]).toMatchObject({ signal: 'SIGKILL' });
      expect(await untilGone(grandchild, 5_000)).toBe(true);
    });

    it('are gone for good by the time a late terminate arrives, which stops the lingering host at once', async () => {
      const { rig, grandchild, transport, exits } = await startWithGrandchild();
      await transport.write(line({ cmd: 'exit', code: 0 }));
      await waitUntil(() => exits.length === 1, 8_000, 'the exit');
      expect(await untilGone(grandchild, 5_000)).toBe(true);
      expect(running(rig.hostPid)).toBe(true); // lingering, as designed
      expect(await terminateHostAt(rig.socketPath, { closeGraceMs: 300, termGraceMs: 300 })).toBe(true);
      expect(await untilGone(rig.hostPid)).toBe(true);
    });

    it('leave a process outside the group alone', async () => {
      const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
      cleanups.push(() => { try { process.kill(bystander.pid!, 'SIGKILL'); } catch { /* gone */ } });
      await waitUntil(() => processStartTicks(bystander.pid!), 5_000, 'the bystander');
      const { grandchild, transport, exits } = await startWithGrandchild();
      await transport.write(line({ cmd: 'exit', code: 0 }));
      await waitUntil(() => exits.length === 1, 8_000, 'the exit');
      expect(await untilGone(grandchild, 5_000)).toBe(true);
      expect(running(bystander.pid!)).toBe(true);
    });

    it('are found by group membership: a live group has members, an empty or unknown one has none', async () => {
      const member = spawn('sleep', ['300'], { stdio: 'ignore', detached: true }); // leads its own group
      cleanups.push(() => { try { process.kill(-member.pid!, 'SIGKILL'); } catch { /* gone */ } });
      await waitUntil(() => processStartTicks(member.pid!), 5_000, 'the member');
      expect(processGroupHasMembers(member.pid!)).toBe(true);
      process.kill(member.pid!, 'SIGKILL');
      expect(await untilGone(member.pid!)).toBe(true);
      expect(processGroupHasMembers(member.pid!)).toBe(false);
      expect(processGroupHasMembers(2_147_483_000)).toBe(false);
    });
  });

  it('ends the child in order on terminate: stdin EOF, then SIGTERM, then SIGKILL to its whole group', async () => {
    const rig = await startHost({ childFlags: ['--ignore-eof', '--ignore-term'] });
    const { transport, exits } = await connect(rig, undefined, { closeGraceMs: 250, termGraceMs: 250 });
    const childPid = transport.pid!;
    await transport.write(line({ cmd: 'echo', text: 'ready' }));
    await sleep(100);
    await transport.close({ terminate: true });
    expect(exits).toEqual([expect.objectContaining({ reason: 'exited', signal: 'SIGKILL' })]);
    expect(childEvents(rig).filter((entry) => entry.event !== 'command').map((entry) => entry.event)).toEqual(['start', 'stdin-eof', 'sigterm']);
    expect(await untilGone(childPid)).toBe(true);
    expect(await untilGone(rig.hostPid)).toBe(true);
    expect(fs.existsSync(rig.recordPath)).toBe(false);
    expect(fs.existsSync(rig.socketPath)).toBe(false);
  });

  it('stops after stdin EOF when the child exits on its own, and ends the child over a control connection', async () => {
    const polite = await startHost();
    const attached = await connect(polite, undefined, { closeGraceMs: 2_000, termGraceMs: 2_000 });
    await attached.transport.close({ terminate: true });
    expect(childEvents(polite).filter((entry) => entry.event !== 'command').map((entry) => entry.event)).toEqual(['start', 'stdin-eof']);
    expect(attached.exits[0]).toMatchObject({ code: 0, reason: 'exited' });
    expect(await untilGone(polite.hostPid)).toBe(true);

    const other = await startHost();
    const childPid = readHostRecord(other.recordPath)!.child.pid;
    expect(await terminateHostAt(other.socketPath, { closeGraceMs: 2_000, termGraceMs: 2_000 })).toBe(true);
    expect(await untilGone(childPid)).toBe(true);
    expect(await untilGone(other.hostPid)).toBe(true);
  });

  it('ends a child that sends a line above the limit and says why', async () => {
    const rig = await startHost({ hostFlags: ['--max-line-bytes', '1000'] });
    const { transport, exits } = await connect(rig);
    await transport.write(line({ cmd: 'big', bytes: 5_000 }));
    await waitUntil(() => exits.length === 1, 8_000, 'the exit');
    expect(exits[0]).toMatchObject({ reason: 'exited', signal: 'SIGKILL' });
    expect(exits[0]!.error?.message).toMatch(/exceeded the limit/);
    expect(await untilGone(transport.pid!)).toBe(true);
  });

  it('reports a binary that cannot be started and leaves nothing behind', async () => {
    const dir = scratch();
    const rig = await (async () => {
      const socketPath = path.join(dir, 'h.sock');
      const recordPath = path.join(dir, 'h.json');
      const envFile = path.join(dir, 'h.env');
      fs.writeFileSync(envFile, JSON.stringify({ PATH: process.env.PATH }));
      const proc = spawn(process.execPath, [HOST_PROGRAM, '--socket', socketPath, '--record', recordPath, '--cwd', dir, '--env-file', envFile, '--', '/nonexistent/provider-binary'], { detached: true, stdio: 'ignore' });
      proc.unref();
      cleanups.push(() => { try { process.kill(proc.pid!, 'SIGKILL'); } catch { /* gone */ } });
      await waitUntil(() => fs.existsSync(socketPath), 10_000, 'the host socket');
      return { socketPath, recordPath, hostPid: proc.pid! };
    })();
    const transport = await HostLineTransport.connect({ socketPath: rig.socketPath });
    expect(transport.info).toMatchObject({ childPid: null, alive: false, spawnError: { code: 'ENOENT' } });
    expect(fs.existsSync(rig.recordPath)).toBe(false);
    await transport.close();
    expect(await untilGone(rig.hostPid, 10_000)).toBe(true);
  });

  it('refuses to start over a socket another host serves', async () => {
    const rig = await startHost();
    const envFile = path.join(rig.dir, 'second.env');
    fs.writeFileSync(envFile, JSON.stringify({ PATH: process.env.PATH }));
    const second = spawn(process.execPath, [HOST_PROGRAM, '--socket', rig.socketPath, '--record', path.join(rig.dir, 'second.json'), '--cwd', rig.dir, '--env-file', envFile, '--', process.execPath, FAKE_CHILD], { stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => second.once('exit', (value) => resolve(value)));
    expect(code).toBe(3);
    const { transport } = await connect(rig); // the first host is untouched
    expect(transport.info.hostPid).toBe(rig.hostPid);
  });

  it('survives the process that started it: kill the starter and the host still answers', async () => {
    const dir = scratch();
    const starter = path.join(dir, 'starter.mjs');
    const socketPath = path.join(dir, 'h.sock');
    const recordPath = path.join(dir, 'h.json');
    const envFile = path.join(dir, 'h.env');
    fs.writeFileSync(envFile, JSON.stringify({ PATH: process.env.PATH }));
    fs.writeFileSync(starter, `
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      const log = fs.openSync(${JSON.stringify(path.join(dir, 'host.log'))}, 'a');
      const host = spawn(process.execPath, ${JSON.stringify([HOST_PROGRAM, '--socket', socketPath, '--record', recordPath, '--cwd', dir, '--env-file', envFile, '--', process.execPath, FAKE_CHILD])}, { detached: true, stdio: ['ignore', log, log] });
      host.unref();
      process.stdout.write(String(host.pid));
      setInterval(() => {}, 1000);
    `);
    cleanups.push(() => reapRecord(recordPath));
    const wrapper = spawn(process.execPath, [starter], { stdio: ['ignore', 'pipe', 'ignore'] });
    const hostPid = Number(await new Promise<string>((resolve) => wrapper.stdout.once('data', (chunk) => resolve(String(chunk).trim()))));
    cleanups.push(() => { try { process.kill(hostPid, 'SIGKILL'); } catch { /* gone */ } });
    await waitUntil(() => fs.existsSync(recordPath), 10_000, 'the record');
    const record = readHostRecord(recordPath)!;

    expect(record.host.pid).toBe(hostPid);
    wrapper.kill('SIGKILL');
    await new Promise((resolve) => wrapper.once('exit', resolve));
    await sleep(300);

    expect(running(hostPid)).toBe(true);
    expect(running(record.child.pid)).toBe(true);
    const transport = await HostLineTransport.connect({ socketPath });
    expect(transport.info).toMatchObject({ hostPid, alive: true });
    const status = await transport.status();
    expect(status).toMatchObject({ pid: record.child.pid, alive: true });
    await transport.close({ terminate: true });
  });

  it.skipIf(!hasSetpriv)('ends the child when the host itself dies: the child is started with a parent death signal relative to the host', async () => {
    const rig = await startHost();
    const childPid = readHostRecord(rig.recordPath)!.child.pid;
    process.kill(rig.hostPid, 'SIGKILL');
    expect(await untilGone(rig.hostPid)).toBe(true);
    expect(await untilGone(childPid)).toBe(true); // SIGTERM from the kernel
  });

  it('starts the child plainly, and says so, when setpriv is not installed', async () => {
    const empty = scratch();
    const rig = await startHost({ hostEnv: { PATH: empty } });
    const record = readHostRecord(rig.recordPath)!;
    expect(record.parentDeathSignal).toBe(false);
    expect(fs.readFileSync(path.join(rig.dir, 'host.log'), 'utf8')).toMatch(/setpriv is not installed/);
    const { transport } = await connect(rig);
    expect(transport.pid).toBe(record.child.pid);
    await transport.write(line({ cmd: 'echo', text: 'plain' }));
    await waitUntil(() => transport.lastSeq === 1, 8_000, 'an answer from the plain child');
  });

  it('gives a client the disconnected reason, not an exit, when the host dies under it', async () => {
    const rig = await startHost({ childFlags: ['--ignore-eof', '--ignore-term'] });
    const { transport, exits } = await connect(rig);
    await transport.write(line({ cmd: 'echo', text: 'x' }));
    process.kill(rig.hostPid, 'SIGKILL');
    await waitUntil(() => exits.length === 1, 8_000, 'the disconnect');
    expect(exits[0]).toMatchObject({ reason: 'disconnected', code: null, signal: null });
    await expect(transport.write(line({ cmd: 'echo', text: 'y' }))).rejects.toBeInstanceOf(NotSentError);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('the line transport factory', () => {
  const logs: Array<[string, object, string]> = [];
  const log = {
    info: (fields: object, message: string) => void logs.push(['info', fields, message]),
    warn: (fields: object, message: string) => void logs.push(['warn', fields, message]),
  };

  function factoryRig() {
    const runtimeDir = scratch();
    const dir = scratch();
    const childLog = path.join(dir, 'child.log');
    const make = () => createLineTransportFactory({ runtimeDir, log, hostProgramPath: HOST_PROGRAM });
    const request = (extra: Record<string, unknown> = {}) => ({
      argv: [process.execPath, FAKE_CHILD, childLog],
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', MARKER: 'factory' },
      hostId: 'codex',
      closeGraceMs: 300,
      termGraceMs: 300,
      staleTermGraceMs: 300,
      ...extra,
    });
    cleanups.push(() => reapRecord(hostPaths(runtimeDir, 'codex').record));
    return { runtimeDir, dir, childLog, make, request, paths: hostPaths(runtimeDir, 'codex') };
  }

  async function open(factory: ReturnType<typeof factoryRig>['make'] extends () => infer F ? F : never, request: object) {
    const transport = await factory(request as never);
    const lines: string[] = [];
    transport.onLine((value) => lines.push(value));
    cleanups.push(() => transport.close().catch(() => undefined));
    return { transport: transport as HostLineTransport, lines };
  }

  it('runs a child directly over stdio when no host id is given', async () => {
    const rig = factoryRig();
    const transport = await rig.make()(rig.request({ hostId: undefined }));
    cleanups.push(() => transport.close());
    expect(transport).toBeInstanceOf(StdioLineTransport);
    expect(fs.existsSync(rig.paths.dir)).toBe(false); // no host, no files
  });

  it('starts a host the first time and reconnects to it after a backend restart without respawning the child', async () => {
    const rig = factoryRig();
    const first = await open(rig.make(), rig.request());
    expect(first.transport).toBeInstanceOf(HostLineTransport);
    expect(transportStartedFresh(first.transport)).toBe(true);
    const childPid = first.transport.pid!;
    const hostPid = first.transport.info.hostPid;
    await first.transport.write(line({ cmd: 'echo', text: 'before the restart' }));
    await waitUntil(() => first.lines.length === 1, 8_000, 'the first answer');
    await first.transport.close(); // the backend shuts down; the host and the child stay

    expect(running(hostPid)).toBe(true);
    expect(running(childPid)).toBe(true);
    const record = readHostRecord(rig.paths.record)!;
    expect(record).toMatchObject({ host: { pid: hostPid, startTicks: processStartTicks(hostPid) }, child: { pid: childPid, startTicks: processStartTicks(childPid) }, socketPath: rig.paths.socket });
    expect(fs.statSync(rig.paths.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(rig.paths.socket).mode & 0o777).toBe(0o600);

    // A restarted backend is a new factory with no memory of the host.
    const second = await open(rig.make(), rig.request());
    expect(second.transport.pid).toBe(childPid);
    expect(second.transport.info.hostPid).toBe(hostPid);
    expect(transportStartedFresh(second.transport)).toBe(false); // the child was used: no second initialize
    await second.transport.write(line({ cmd: 'echo', text: 'after the restart' }));
    await waitUntil(() => second.lines.length === 1, 8_000, 'the answer after the restart');
    expect(JSON.parse(second.lines[0]!)).toEqual({ echo: 'after the restart' });
    expect(childEvents({ childLog: rig.childLog } as HostRig).filter((entry) => entry.event === 'start')).toHaveLength(1); // one child ever started
    expect(logs.some(([, fields, message]) => /reconnected/.test(message) && (fields as { childPid?: number }).childPid === childPid)).toBe(true);

    await terminateHost(rig.runtimeDir, 'codex', log, { closeGraceMs: 300, termGraceMs: 300 });
    expect(await untilGone(childPid)).toBe(true);
    expect(await untilGone(hostPid)).toBe(true);
    expect(fs.existsSync(rig.paths.record)).toBe(false);
    expect(fs.existsSync(rig.paths.socket)).toBe(false);
  });

  it('leaves a running host alone when it only fails to answer in time, and finds it again once it does', async () => {
    const rig = factoryRig();
    const first = await open(rig.make(), rig.request());
    const hostPid = first.transport.info.hostPid;
    const childPid = first.transport.pid!;
    await first.transport.close(); // the backend goes away; host and child stay
    // A stalled machine: the host is alive (pid, start time and boot match its record) and answers nothing.
    process.kill(hostPid, 'SIGSTOP');
    cleanups.push(() => { try { process.kill(hostPid, 'SIGCONT'); } catch { /* gone */ } });
    const slow = createLineTransportFactory({ runtimeDir: rig.runtimeDir, log, hostProgramPath: HOST_PROGRAM, hostConnectTimeoutMs: 400, hostWelcomeTimeoutMs: 400 });
    const failure = await slow(rig.request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportUnavailableError);
    expect(logs.some(([level, , message]) => level === 'warn' && /leaving it alone/.test(message))).toBe(true);
    // Nothing was retired: the host and its provider still run, and the record and socket are still there.
    expect(running(hostPid)).toBe(true);
    expect(running(childPid)).toBe(true);
    expect(readHostRecord(rig.paths.record)?.host.pid).toBe(hostPid);
    expect(fs.existsSync(rig.paths.socket)).toBe(true);
    expect(childEvents({ childLog: rig.childLog } as HostRig).filter((entry) => entry.event === 'sigterm' || entry.event === 'stdin-eof')).toEqual([]);

    process.kill(hostPid, 'SIGCONT');
    await sleep(100);
    const again = await open(rig.make(), rig.request());
    expect(again.transport.info.hostPid).toBe(hostPid); // the same host, the same provider
    expect(again.transport.pid).toBe(childPid);
    expect(childEvents({ childLog: rig.childLog } as HostRig).filter((entry) => entry.event === 'start')).toHaveLength(1);
    await terminateHost(rig.runtimeDir, 'codex', log, { closeGraceMs: 300, termGraceMs: 300 });
  });

  it('still replaces a host that runs but has no socket to answer on: nothing could ever reach its provider', async () => {
    const rig = factoryRig();
    const first = await open(rig.make(), rig.request());
    const hostPid = first.transport.info.hostPid;
    const childPid = first.transport.pid!;
    await first.transport.close();
    fs.unlinkSync(rig.paths.socket); // alive, but unreachable for good: not slow, refused
    const second = await open(rig.make(), rig.request());
    expect(second.transport.info.hostPid).not.toBe(hostPid);
    expect(second.transport.pid).not.toBe(childPid);
    expect(await untilGone(hostPid)).toBe(true);
    expect(await untilGone(childPid)).toBe(true);
    await terminateHost(rig.runtimeDir, 'codex', log, { closeGraceMs: 300, termGraceMs: 300 });
  });

  it('tells an attach why nothing answered: no host, a provider that ended, a refused socket, or a host too slow to answer', async () => {
    const rig = factoryRig();
    const slow = () => createLineTransportFactory({ runtimeDir: rig.runtimeDir, log, hostProgramPath: HOST_PROGRAM, hostConnectTimeoutMs: 300, hostWelcomeTimeoutMs: 300 });
    const reason = async (factory = slow()) => ((await factory(rig.request({ attachOnly: true })).catch((error: unknown) => error)) as LineTransportNotRunningError).reason;

    expect(await reason()).toBe('absent'); // no record, no host

    const first = await open(rig.make(), rig.request());
    const hostPid = first.transport.info.hostPid;
    await first.transport.close();
    process.kill(hostPid, 'SIGSTOP');
    cleanups.push(() => { try { process.kill(hostPid, 'SIGCONT'); } catch { /* gone */ } });
    expect(await reason()).toBe('unreachable'); // alive, stalled: the provider may well run
    expect(running(hostPid)).toBe(true);
    process.kill(hostPid, 'SIGCONT');
    await sleep(100);

    const attached = await slow()(rig.request({ attachOnly: true })); // it answers now: an attach connects instead of failing
    await attached.close();
    fs.unlinkSync(rig.paths.socket);
    expect(await reason()).toBe('absent'); // alive, but nobody can reach it

    const other = factoryRig();
    const second = await open(other.make(), other.request());
    await second.transport.write(line({ cmd: 'exit', code: 0 }));
    await waitUntil(() => !running(second.transport.pid!), 8_000, 'the provider to end');
    // The host notices the exit a moment after the process is gone; on a loaded machine an attach can land in between and
    // still connect. Ask again until the host has seen it.
    let ended: unknown;
    for (const deadline = Date.now() + 8_000; Date.now() < deadline; await sleep(50)) {
      ended = await other.make()(other.request({ attachOnly: true })).catch((error: unknown) => error);
      if (ended instanceof LineTransportNotRunningError) break;
      await (ended as { close?: () => Promise<void> }).close?.();
    }
    expect((ended as LineTransportNotRunningError).reason).toBe('ended'); // the host lingers, the provider is gone
  });

  describe('replay', () => {
    // Claude asks for what its process printed before it connected (hook frames), with sinceSeq 0, on every launch.
    // That is right for a process this call started or one nobody has written to; it must never replay a used one.
    it('shows the startup output to the client of a host it started, and of one never written to, and nothing to a client of a used host', async () => {
      const rig = factoryRig();
      const request = (extra: Record<string, unknown> = {}) => rig.request({ argv: [process.execPath, FAKE_CHILD, rig.childLog, '--banner'], sinceSeq: 0, ...extra });
      const banners = (lines: string[]) => lines.filter((value) => value.includes('"banner"'));

      const first = await open(rig.make(), request());
      await waitUntil(() => banners(first.lines).length === 1, 8_000, 'the banner');
      await first.transport.close();

      const second = await open(rig.make(), request()); // the host exists, and nobody has written to it
      expect(transportStartedFresh(second.transport)).toBe(true);
      await waitUntil(() => banners(second.lines).length === 1, 8_000, 'the banner replayed to the second client');
      await second.transport.write(line({ cmd: 'echo', text: 'used now' }));
      await waitUntil(() => second.lines.some((value) => value.includes('used now')), 8_000, 'the echo');
      await second.transport.close();

      const third = await open(rig.make(), request()); // used: its past is not this client's
      expect(transportStartedFresh(third.transport)).toBe(false);
      await sleep(300);
      expect(third.lines).toEqual([]);
      await third.transport.write(line({ cmd: 'echo', text: 'live' }));
      await waitUntil(() => third.lines.length === 1, 8_000, 'a live line');
      expect(JSON.parse(third.lines[0]!)).toEqual({ echo: 'live' });
      await terminateHost(rig.runtimeDir, 'codex', log, { closeGraceMs: 300, termGraceMs: 300 });
    });
  });

  it('keeps the host out of the backend environment: no session identity reaches it', async () => {
    const rig = factoryRig();
    const polluted = { AGENT_CONSOLE_SESSION_ID: 's', CODEX_THREAD_ID: 't', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', TMUX: '/tmp/x,1,0', OPENAI_API_KEY: 'k' };
    Object.assign(process.env, polluted);
    cleanups.push(() => { for (const name of Object.keys(polluted)) delete process.env[name]; });
    const { transport } = await open(rig.make(), rig.request());
    const environ = fs.readFileSync(`/proc/${transport.info.hostPid}/environ`, 'utf8').split('\0').filter(Boolean).map((entry) => entry.split('=')[0]);
    for (const name of Object.keys(polluted)) expect(environ).not.toContain(name);
    expect(environ).toContain('PATH');
    expect(fs.existsSync(rig.paths.env)).toBe(false); // the child env file is gone
  });

  it('ends the earlier host and starts a new one when the command changed', async () => {
    const rig = factoryRig();
    const first = await open(rig.make(), rig.request());
    const oldChild = first.transport.pid!;
    const oldHost = first.transport.info.hostPid;

    const second = await open(rig.make(), rig.request({ argv: [process.execPath, FAKE_CHILD, rig.childLog, '--ignore-eof', '--ignore-term'] }));
    expect(second.transport.pid).not.toBe(oldChild);
    expect(second.transport.info.hostPid).not.toBe(oldHost);
    expect(transportStartedFresh(second.transport)).toBe(true);
    expect(await untilGone(oldChild)).toBe(true);
    expect(await untilGone(oldHost)).toBe(true);
    expect(readHostRecord(rig.paths.record)!.host.pid).toBe(second.transport.info.hostPid);
    expect(first.transport.pid).toBe(oldChild);
    await terminateHost(rig.runtimeDir, 'codex', log, { closeGraceMs: 300, termGraceMs: 300 });
  });

  it('starts a new host when the recorded provider had ended while nobody was connected', async () => {
    const rig = factoryRig();
    const first = await open(rig.make(), rig.request());
    const oldHost = first.transport.info.hostPid;
    const oldChild = first.transport.pid!;
    await first.transport.write(line({ cmd: 'exit', code: 1 }));
    await waitUntil(() => !running(oldChild), 8_000, 'the child to end');
    await first.transport.close();

    const second = await open(rig.make(), rig.request());
    expect(second.transport.info.alive).toBe(true);
    expect(second.transport.pid).not.toBe(oldChild);
    expect(transportStartedFresh(second.transport)).toBe(true);
    expect(await untilGone(oldHost)).toBe(true); // the lingering host was told to go
    await terminateHost(rig.runtimeDir, 'codex', log, { closeGraceMs: 300, termGraceMs: 300 });
  });

  it('ends a provider left running without its host, through the recorded process group', async () => {
    const rig = factoryRig();
    const first = await open(rig.make(), rig.request({ argv: [process.execPath, FAKE_CHILD, rig.childLog, '--ignore-eof', '--ignore-term'] }));
    const hostPid = first.transport.info.hostPid;
    const childPid = first.transport.pid!;
    await waitUntil(() => fs.existsSync(rig.childLog), 8_000, 'the child to start'); // its SIGTERM handler is in place once it logged
    await first.transport.close();
    process.kill(hostPid, 'SIGKILL'); // a host crash: the child ignores the parent death SIGTERM and stays
    expect(await untilGone(hostPid)).toBe(true);
    await sleep(200);
    expect(running(childPid)).toBe(true);
    expect(readHostRecord(rig.paths.record)).toBeDefined(); // the record is what finds it again

    const second = await open(rig.make(), rig.request({ argv: [process.execPath, FAKE_CHILD, rig.childLog, '--ignore-eof', '--ignore-term'] }));
    expect(await untilGone(childPid)).toBe(true);
    expect(second.transport.pid).not.toBe(childPid);
    expect(logs.some(([level, fields, message]) => level === 'warn' && /left running without its session host/.test(message) && (fields as { pid?: number }).pid === childPid)).toBe(true);
    await terminateHost(rig.runtimeDir, 'codex', log, { closeGraceMs: 300, termGraceMs: 300 });
  });

  it('never signals a pid from a record whose start time does not match', async () => {
    const rig = factoryRig();
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    cleanups.push(() => { try { bystander.kill('SIGKILL'); } catch { /* gone */ } });
    await waitUntil(() => processStartTicks(bystander.pid!), 5_000, 'the bystander');
    fs.mkdirSync(rig.paths.dir, { recursive: true });
    fs.writeFileSync(rig.paths.record, JSON.stringify({
      version: 1,
      host: { pid: bystander.pid, startTicks: 'not-its-start-time', bootId: currentBootId() },
      child: { pid: bystander.pid, startTicks: 'not-its-start-time', bootId: currentBootId(), processGroup: bystander.pid },
      socketPath: rig.paths.socket, argvHash: argvHash(rig.request().argv), startedAt: new Date().toISOString(), parentDeathSignal: true,
    }));
    const { transport } = await open(rig.make(), rig.request());
    expect(running(bystander.pid!)).toBe(true); // a reused pid is never taken for the host or the child
    expect(transport.info.hostPid).not.toBe(bystander.pid);
    await terminateHost(rig.runtimeDir, 'codex', log, { closeGraceMs: 300, termGraceMs: 300 });
  });

  it('reports a missing binary as a spawn error with its code, and leaves no host behind', async () => {
    const rig = factoryRig();
    const failure = await rig.make()(rig.request({ argv: ['/nonexistent/provider-binary', 'app-server'] })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LineTransportSpawnError);
    expect(failure).toMatchObject({ code: 'ENOENT', command: '/nonexistent/provider-binary' });
    await waitUntil(() => !fs.existsSync(rig.paths.socket), 8_000, 'the failed host to remove its socket');
    expect(fs.existsSync(rig.paths.record)).toBe(false);
    await expect(StdioLineTransport.spawn({ argv: ['/nonexistent/provider-binary'], cwd: os.tmpdir(), env: {} })).rejects.toMatchObject({ name: 'LineTransportSpawnError', code: 'ENOENT' });
  });
});
