import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAppServerPlugin, type CodexStructuredConfig } from '../src/providers/transport/codex/index.js';
import { JsonRpcClient } from '../src/providers/transport/codex/jsonrpc.js';
import type { CodexAppServerInstance } from '../src/providers/transport/codex/app-server-instance.js';
import type { CodexTimings } from '../src/providers/transport/codex/app-server-session.js';
import {
  currentBootId,
  isRecordedProcessRunning,
  processGroupId,
  processStartTicks,
  terminateRecordedProcess,
} from '../src/providers/transport/codex/process-lifetime.js';
import { hostPaths, readHostRecord, StdioLineTransport } from '../src/providers/transport/line-transport.js';
import { argvHash } from '../src/providers/transport/session-host.js';
import {
  FAKE_APP_SERVER, FAST_TIMINGS, OPEN_OPTIONS, baseHandlers, hostTransportFactory, makeContext, makeTempDir, readLog, sleep, waitUntil, writeScenario,
} from './helpers/codex-harness.js';

vi.setConfig({ testTimeout: 20_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const INSTANCE_KEY = 'structured-instance:codex';
const FAKE_LAUNCHER = path.join(path.dirname(FAKE_APP_SERVER), 'fake-launcher.mjs');

function scratchDir(): string {
  const dir = makeTempDir('codex-lifetime-');
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A long-lived stand-in for an app-server a crashed backend left behind. */
function strandedProcess(options: { ignoreSigterm?: boolean } = {}): ChildProcess {
  const script = options.ignoreSigterm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    : 'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  cleanups.push(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  });
  return child;
}

async function untilGone(pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (processStartTicks(pid) !== undefined) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function untilRunning(pid: number): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const ticks = processStartTicks(pid);
    if (ticks) return ticks;
    if (Date.now() > deadline) throw new Error('The stranded process did not start.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The shape of the npm `codex` install: a Node launcher whose child is the server. Both ignore stdin EOF and SIGTERM
 * (the launcher only forwards the signal), so only SIGKILL ends them. `pid` is the launcher, `nativePid` its child.
 */
async function stubbornLauncher(options: { detached: boolean }): Promise<{ pid: number; nativePid: number; launcher: ChildProcess }> {
  const dir = scratchDir();
  const { scenarioPath, logFile } = writeScenario(dir, { ignoreStdinEof: true, ignoreSigterm: true, handlers: baseHandlers('thread-1') });
  const launcher = spawn(process.execPath, [FAKE_LAUNCHER, FAKE_APP_SERVER, scenarioPath], { stdio: ['pipe', 'ignore', 'ignore'], detached: options.detached });
  const pid = launcher.pid!;
  const nativePid = await waitUntil(() => readLog(logFile).find((entry) => entry.event === 'start')?.pid as number | undefined, 5_000, 'the native server to start');
  cleanups.push(() => {
    for (const target of [pid, nativePid]) {
      try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
  await sleep(200); // the server installs its SIGTERM handler right after it logs its start
  return { pid, nativePid, launcher };
}

interface Rig {
  dir: string;
  runtimeDir: string;
  context: ReturnType<typeof makeContext>;
  instance: CodexAppServerInstance;
  logFile: string;
  command: string[];
  /** The session host record of the app-server this rig starts. */
  recordPath: string;
  stop(): Promise<void>;
}

function rig(options: { host?: boolean; command?: string[]; timings?: Partial<CodexTimings>; PATH?: string } = {}): Rig {
  const dir = scratchDir();
  const { scenarioPath, logFile } = writeScenario(dir, { handlers: baseHandlers('thread-1') });
  const command = options.command ?? [process.execPath, FAKE_APP_SERVER, scenarioPath];
  const runtimeDir = path.join(dir, 'runtime');
  const context = makeContext(path.join(runtimeDir, 'structured', 'codex'));
  if (options.host) context.lineTransport = hostTransportFactory(runtimeDir, context);
  const plugin = createCodexAppServerPlugin({
    timings: { ...FAST_TIMINGS, staleTermGraceMs: 300, ...options.timings },
    baseEnv: { PATH: options.PATH ?? process.env.PATH },
    clientVersion: '9.9.9',
  });
  const config: CodexStructuredConfig = { enabled: true, command, idleUnloadMinutes: 60, env: {} };
  const instance = plugin.create(config, context) as CodexAppServerInstance;
  const recordPath = hostPaths(runtimeDir, 'codex').record;
  // A host outlives its instance; end it, and anything its record still names, however the test went.
  const stop = async (): Promise<void> => {
    const record = readHostRecord(recordPath);
    if (record) {
      for (const pid of [record.host.pid, record.child.pid]) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader or gone */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  };
  cleanups.push(async () => { await instance.dispose('shutdown'); await stop(); });
  return { dir, runtimeDir, context, instance, logFile, command, recordPath, stop };
}

/** The pid of a process that has ended, for a record that names a host that is gone. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

/** A record as a host that crashed would have left it: the host is gone, the child it started may not be. */
async function writeStrandedRecord(r: Rig, child: { pid: number; startTicks?: string; bootId?: string; processGroup: number }, extra: Record<string, unknown> = {}): Promise<void> {
  fs.mkdirSync(path.dirname(r.recordPath), { recursive: true });
  fs.writeFileSync(r.recordPath, JSON.stringify({
    version: 1,
    host: { pid: await deadPid(), startTicks: '1', bootId: currentBootId() },
    child,
    socketPath: hostPaths(r.runtimeDir, 'codex').socket,
    argvHash: 'from-an-earlier-backend',
    startedAt: new Date().toISOString(),
    parentDeathSignal: true,
    ...extra,
  }));
}

function parentOf(pid: number): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
}

describe('process identity helpers', () => {
  it('reads the start time of a live process and nothing for a missing one', () => {
    expect(processStartTicks(process.pid)).toMatch(/^\d+$/);
    expect(processStartTicks(2_147_483_646)).toBeUndefined();
    expect(currentBootId()).toMatch(/[0-9a-f-]{8,}/);
  });

  it('reads the process group of a live process: its own pid for a group leader, the parent group otherwise', async () => {
    const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore', detached: true });
    const follower = strandedProcess();
    cleanups.push(() => { try { process.kill(leader.pid!, 'SIGKILL'); } catch { /* already gone */ } });
    await untilRunning(leader.pid!);
    await untilRunning(follower.pid!);
    expect(processGroupId(leader.pid!)).toBe(leader.pid);
    expect(processGroupId(follower.pid!)).not.toBe(follower.pid);
    expect(processGroupId(follower.pid!)).toBe(processGroupId(process.pid));
    expect(processGroupId(2_147_483_646)).toBeUndefined();
  });

  it('only recognises a recorded process whose pid, start time and boot all match', () => {
    const ticks = processStartTicks(process.pid)!;
    expect(isRecordedProcessRunning({ pid: process.pid, startTicks: ticks, bootId: currentBootId() })).toBe(true);
    expect(isRecordedProcessRunning({ pid: process.pid, startTicks: `${ticks}0` })).toBe(false); // a reused pid
    expect(isRecordedProcessRunning({ pid: process.pid, startTicks: ticks, bootId: 'another-boot' })).toBe(false);
    expect(isRecordedProcessRunning({ pid: process.pid })).toBe(false); // no identity to compare: never acted on
  });

  it('terminateRecordedProcess reports a process that is already gone as ended and never signals a reused pid', async () => {
    expect(await terminateRecordedProcess({ pid: 2_147_483_646, startTicks: '1' }, 50)).toBe(true);
    expect(await terminateRecordedProcess({ pid: process.pid, startTicks: `${processStartTicks(process.pid)}0` }, 50)).toBe(true);
    expect(processStartTicks(process.pid)).toBeDefined(); // this test process is still here
  });
});

describe('codex app-server launch behind a session host', () => {
  it('starts the app-server as a child of its session host, in its own process group, and records both', async () => {
    const r = rig({ host: true });
    await r.instance.start(OPEN_OPTIONS);
    const { pid } = await r.instance.alive();
    const record = readHostRecord(r.recordPath)!;
    expect(record.child).toMatchObject({ pid, startTicks: processStartTicks(pid!), bootId: currentBootId(), processGroup: pid });
    expect(processGroupId(pid!)).toBe(pid); // the host execs the command, so the launcher leads the group
    expect(parentOf(pid!)).toBe(record.host.pid);
    expect(record.parentDeathSignal).toBe(true); // setpriv --pdeathsig TERM relative to the host, not the backend
    expect(processGroupId(record.host.pid)).toBe(record.host.pid); // the host is detached from the backend's group
    expect(record.argvHash).toBe(argvHash(readCommand(pid!)));
    // The backend keeps its own note of the process it is connected to.
    expect(JSON.parse(r.context.metaStore.get('structured-instance:codex')!)).toMatchObject({ pid, startTicks: processStartTicks(pid!), bootId: currentBootId() });
  });

  it('reports a missing codex binary the plain way, without leaving a host behind', async () => {
    const r = rig({ host: true, command: ['definitely-not-a-codex-binary-xyz', 'app-server'] });
    await expect(r.instance.probe()).resolves.toMatchObject({ installed: false });
    await waitUntil(() => !fs.existsSync(hostPaths(r.runtimeDir, 'codex').socket), 8_000, 'the failed host to go');
    expect(readHostRecord(r.recordPath)).toBeUndefined();
  });

  it('records the start time and boot of the process it started when it runs over stdio', async () => {
    const r = rig();
    await r.instance.start(OPEN_OPTIONS);
    const { pid } = await r.instance.alive();
    const recorded = JSON.parse(r.context.metaStore.get('structured-instance:codex')!) as { pid: number; startTicks: string; bootId?: string };
    expect(recorded).toMatchObject({ pid, startTicks: processStartTicks(pid!) });
    expect(recorded.bootId).toBe(currentBootId());
    expect(processGroupId(pid!)).toBe(pid); // the stdio transport also starts the child as its own group leader
  });
});

function readCommand(pid: number): string[] {
  return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
}

describe('an app-server left running without its session host (a host crash)', () => {
  it('is ended before the host is started again when its recorded pid and start time still match', async () => {
    const stranded = strandedProcess();
    const ticks = await untilRunning(stranded.pid!);
    const r = rig({ host: true });
    await writeStrandedRecord(r, { pid: stranded.pid!, startTicks: ticks, bootId: currentBootId(), processGroup: stranded.pid! });

    await r.instance.start(OPEN_OPTIONS);

    expect(await untilGone(stranded.pid!)).toBe(true);
    expect(r.context.logs.warn.some(([fields, message]) => /left running without its session host/.test(message) && (fields as { pid?: number }).pid === stranded.pid)).toBe(true);
    // The record now describes the new process.
    expect(readHostRecord(r.recordPath)!.child.pid).toBe((await r.instance.alive()).pid);
    expect(readHostRecord(r.recordPath)!.child.pid).not.toBe(stranded.pid);
  });

  it('gets SIGKILL when it ignores SIGTERM past the grace period', async () => {
    const stranded = strandedProcess({ ignoreSigterm: true });
    const ticks = await untilRunning(stranded.pid!);
    const r = rig({ host: true, timings: { staleTermGraceMs: 200 } });
    await writeStrandedRecord(r, { pid: stranded.pid!, startTicks: ticks, processGroup: stranded.pid! });
    await sleep(300); // give node time to install the SIGTERM handler before the signal arrives

    await r.instance.start(OPEN_OPTIONS);

    expect(await untilGone(stranded.pid!)).toBe(true);
  });

  it('is left alone when the pid now belongs to another process (start time differs)', async () => {
    const stranded = strandedProcess();
    const ticks = await untilRunning(stranded.pid!);
    const r = rig({ host: true });
    await writeStrandedRecord(r, { pid: stranded.pid!, startTicks: `${ticks}1`, processGroup: stranded.pid! });

    await r.instance.start(OPEN_OPTIONS);

    expect(processStartTicks(stranded.pid!)).toBe(ticks);
    expect(r.context.logs.warn.some(([, message]) => /left running without its session host/.test(message))).toBe(false);
  });

  it('is left alone when the record has no start time to compare', async () => {
    const stranded = strandedProcess();
    const ticks = await untilRunning(stranded.pid!);
    const r = rig({ host: true });
    await writeStrandedRecord(r, { pid: stranded.pid!, processGroup: stranded.pid! });

    await r.instance.start(OPEN_OPTIONS);

    expect(processStartTicks(stranded.pid!)).toBe(ticks);
  });

  it('acts on nothing when the record does not name the child as the leader of its own group', async () => {
    const stranded = strandedProcess();
    const ticks = await untilRunning(stranded.pid!);
    const r = rig({ host: true });
    await writeStrandedRecord(r, { pid: stranded.pid!, startTicks: ticks, bootId: currentBootId(), processGroup: process.pid }); // would signal this very process group

    await r.instance.start(OPEN_OPTIONS);

    expect(processStartTicks(stranded.pid!)).toBe(ticks);
    expect(processStartTicks(process.pid)).toBeDefined();
    expect(readHostRecord(r.recordPath)!.child.pid).toBe((await r.instance.alive()).pid); // the unreadable record was replaced
  });

  it('never ends a running host with the same command: it is reconnected to, so there is no second writer', async () => {
    const r = rig({ host: true });
    await r.instance.start(OPEN_OPTIONS);
    const first = readHostRecord(r.recordPath)!;
    await r.instance.dispose('shutdown'); // the backend goes away; host and app-server stay

    // A new backend over the same runtime and the same command.
    const plugin = createCodexAppServerPlugin({ timings: { ...FAST_TIMINGS, staleTermGraceMs: 300 }, baseEnv: { PATH: process.env.PATH }, clientVersion: '9.9.9' });
    const context = makeContext(path.join(r.runtimeDir, 'structured', 'codex'));
    context.lineTransport = hostTransportFactory(r.runtimeDir, context);
    const restarted = plugin.create({ enabled: true, command: r.command, idleUnloadMinutes: 60, env: {} }, context) as CodexAppServerInstance;
    cleanups.push(() => restarted.dispose('shutdown'));
    await restarted.start(OPEN_OPTIONS);

    expect((await restarted.alive()).pid).toBe(first.child.pid);
    expect(readHostRecord(r.recordPath)!.host.pid).toBe(first.host.pid);
    expect(readLog(r.logFile).filter((entry) => entry.event === 'start')).toHaveLength(1);
    expect(context.logs.warn.some(([, message]) => /left running|ending the earlier|did not answer/.test(message))).toBe(false);
  });
});

describe('the app-server and its launcher are ended together', () => {
  it('ends the launcher and its native child when the stale reap finds a recorded process group', async () => {
    const { pid, nativePid } = await stubbornLauncher({ detached: true });
    const r = rig({ host: true, timings: { staleTermGraceMs: 300 } });
    await writeStrandedRecord(r, { pid, startTicks: processStartTicks(pid), bootId: currentBootId(), processGroup: pid });

    await r.instance.start(OPEN_OPTIONS);

    // The native child ignores SIGTERM, which the launcher only forwards; the group SIGKILL reaches both.
    expect(await untilGone(nativePid)).toBe(true);
    expect(await untilGone(pid)).toBe(true);
    expect(r.context.logs.warn.some(([fields, message]) => /left running without its session host/.test(message) && (fields as { pid?: number }).pid === pid)).toBe(true);
  });

  it('signals nothing when the pid or start time no longer match, group or not', async () => {
    const { pid, nativePid } = await stubbornLauncher({ detached: true });
    const ticks = processStartTicks(pid)!;
    const r = rig({ host: true, timings: { staleTermGraceMs: 200 } });
    await writeStrandedRecord(r, { pid, startTicks: `${ticks}1`, bootId: currentBootId(), processGroup: pid }); // the pid was reused

    await r.instance.start(OPEN_OPTIONS);

    expect(processStartTicks(pid)).toBe(ticks);
    expect(processStartTicks(nativePid)).toBeDefined();
    expect(processGroupId(pid)).toBe(pid);
    expect(r.context.logs.warn.some(([, message]) => /left running without its session host/.test(message))).toBe(false);

    // The same start time from another boot is just as foreign.
    const other = rig({ host: true, timings: { staleTermGraceMs: 200 } });
    await writeStrandedRecord(other, { pid, startTicks: ticks, bootId: 'another-boot', processGroup: pid });
    await other.instance.start(OPEN_OPTIONS);
    expect(processStartTicks(pid)).toBe(ticks);
    expect(processStartTicks(nativePid)).toBeDefined();
    expect(other.context.logs.warn.some(([, message]) => /left running without its session host/.test(message))).toBe(false);
  });

  it('does not signal a group the recorded process does not lead', async () => {
    const stranded = strandedProcess(); // shares the group of this test process, as a wrong record would describe
    const ticks = await untilRunning(stranded.pid!);
    const r = rig({ host: true, timings: { staleTermGraceMs: 300 } });
    await writeStrandedRecord(r, { pid: stranded.pid!, startTicks: ticks, bootId: currentBootId(), processGroup: stranded.pid! });

    await r.instance.start(OPEN_OPTIONS);

    expect(await untilGone(stranded.pid!)).toBe(true); // the pid-only fallback ended it
    expect(processStartTicks(process.pid)).toBeDefined(); // and this process, in the group the record did not lead, was never signalled
  });

  it('close() escalates to SIGKILL for the whole group', async () => {
    const dir = scratchDir();
    const { scenarioPath, logFile } = writeScenario(dir, { ignoreStdinEof: true, ignoreSigterm: true, handlers: baseHandlers('thread-1') });
    const transport = await StdioLineTransport.spawn({
      argv: [process.execPath, FAKE_LAUNCHER, FAKE_APP_SERVER, scenarioPath], cwd: dir, env: { PATH: process.env.PATH ?? '' },
      closeGraceMs: 200, termGraceMs: 200,
    });
    const client = new JsonRpcClient(transport);
    const nativePid = await waitUntil(() => readLog(logFile).find((entry) => entry.event === 'start')?.pid as number | undefined, 5_000, 'the native server to start');
    cleanups.push(() => { try { process.kill(nativePid, 'SIGKILL'); } catch { /* already gone */ } });
    await sleep(200);
    expect(processGroupId(client.pid!)).toBe(client.pid);

    await client.close();

    expect(client.exitInfo).toMatchObject({ signal: 'SIGKILL', expected: true });
    expect(await untilGone(nativePid)).toBe(true);
  });

  it('ends the native child of the launcher when a directly run instance is disposed', async () => {
    const dir = scratchDir();
    const { scenarioPath, logFile } = writeScenario(dir, { ignoreStdinEof: true, ignoreSigterm: true, handlers: baseHandlers('thread-1') });
    const r = rig({ command: [process.execPath, FAKE_LAUNCHER, FAKE_APP_SERVER, scenarioPath] });
    await r.instance.start(OPEN_OPTIONS);
    const { pid } = await r.instance.alive();
    const nativePid = readLog(logFile).find((entry) => entry.event === 'start')!.pid as number;
    cleanups.push(() => { try { process.kill(nativePid, 'SIGKILL'); } catch { /* already gone */ } });
    expect(nativePid).not.toBe(pid);
    await sleep(200);

    await r.instance.dispose('shutdown');

    expect(await untilGone(pid!)).toBe(true);
    expect(await untilGone(nativePid)).toBe(true);
  });

  it('ends the launcher and its native child together when the host is told to terminate', async () => {
    const dir = scratchDir();
    const { scenarioPath, logFile } = writeScenario(dir, { ignoreStdinEof: true, ignoreSigterm: true, handlers: baseHandlers('thread-1') });
    const r = rig({ host: true, command: [process.execPath, FAKE_LAUNCHER, FAKE_APP_SERVER, scenarioPath], timings: { closeGraceMs: 200, termGraceMs: 200 } });
    await r.instance.start(OPEN_OPTIONS);
    const { pid } = await r.instance.alive();
    const nativePid = readLog(logFile).find((entry) => entry.event === 'start')!.pid as number;
    cleanups.push(() => { try { process.kill(nativePid, 'SIGKILL'); } catch { /* already gone */ } });
    expect(nativePid).not.toBe(pid);
    await sleep(200);
    const hostPid = readHostRecord(r.recordPath)!.host.pid;

    // The backend going away does not touch them...
    await r.instance.dispose('shutdown');
    expect(processStartTicks(pid!)).toBeDefined();
    expect(processStartTicks(nativePid)).toBeDefined();
    // ...an explicit terminate ends both, with the launcher's native child reached through the group.
    const { terminateHost } = await import('../src/providers/transport/line-transport.js');
    await terminateHost(r.runtimeDir, 'codex', r.context.log, { closeGraceMs: 200, termGraceMs: 200, staleTermGraceMs: 300 });
    expect(await untilGone(pid!)).toBe(true);
    expect(await untilGone(nativePid)).toBe(true);
    expect(await untilGone(hostPid)).toBe(true);
    expect(readHostRecord(r.recordPath)).toBeUndefined();
  });
});
