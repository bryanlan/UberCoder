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
  parseRecordedProcess,
  processGroupId,
  processStartTicks,
  resolveExecutable,
  terminateRecordedProcess,
  withParentDeathSignal,
} from '../src/providers/transport/codex/process-lifetime.js';
import { FAKE_APP_SERVER, FAST_TIMINGS, OPEN_OPTIONS, baseHandlers, makeContext, makeTempDir, readLog, sleep, waitUntil, writeScenario } from './helpers/codex-harness.js';

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
  context: ReturnType<typeof makeContext>;
  instance: CodexAppServerInstance;
  logFile: string;
}

function rig(options: { PATH?: string; command?: string[]; timings?: Partial<CodexTimings> } = {}): Rig {
  const dir = scratchDir();
  const { scenarioPath, logFile } = writeScenario(dir, { handlers: baseHandlers('thread-1') });
  const command = options.command ?? [process.execPath, FAKE_APP_SERVER, scenarioPath];
  const context = makeContext(path.join(dir, 'runtime', 'structured', 'codex'));
  const plugin = createCodexAppServerPlugin({
    timings: { ...FAST_TIMINGS, staleTermGraceMs: 300, ...options.timings },
    baseEnv: { PATH: options.PATH ?? process.env.PATH },
    clientVersion: '9.9.9',
  });
  const config: CodexStructuredConfig = { enabled: true, command, idleUnloadMinutes: 60, env: {} };
  const instance = plugin.create(config, context) as CodexAppServerInstance;
  cleanups.push(async () => { await instance.dispose('shutdown'); });
  return { dir, context, instance, logFile };
}

/** A `setpriv` that records its argv and then runs the command after `--`, as the real one does. */
function fakeSetprivDir(): { bin: string; argvLog: string } {
  const bin = scratchDir();
  const argvLog = path.join(bin, 'setpriv-argv.json');
  const script = path.join(bin, 'setpriv');
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
  fs.chmodSync(script, 0o755);
  return { bin, argvLog };
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

  it('parses the stored instance record and refuses pids that must never be signalled', () => {
    expect(parseRecordedProcess(JSON.stringify({ pid: 4242, startTicks: '99', bootId: 'b', startedAt: 'x' }))).toEqual({ pid: 4242, startTicks: '99', bootId: 'b' });
    expect(parseRecordedProcess(JSON.stringify({ pid: 4242 }))).toEqual({ pid: 4242 });
    // Only a group the process leads itself is kept; any other group id is dropped, so it can never be signalled.
    expect(parseRecordedProcess(JSON.stringify({ pid: 4242, startTicks: '99', processGroup: 4242 }))).toEqual({ pid: 4242, startTicks: '99', processGroup: 4242 });
    expect(parseRecordedProcess(JSON.stringify({ pid: 4242, startTicks: '99', processGroup: 17 }))).toEqual({ pid: 4242, startTicks: '99' });
    expect(parseRecordedProcess(JSON.stringify({ pid: 4242, startTicks: '99', processGroup: true }))).toEqual({ pid: 4242, startTicks: '99' });
    for (const bad of ['not json', '{}', JSON.stringify({ pid: 1 }), JSON.stringify({ pid: 0 }), JSON.stringify({ pid: -5 }), JSON.stringify({ pid: '12' }), JSON.stringify({ pid: 1.5 })]) {
      expect(parseRecordedProcess(bad)).toBeUndefined();
    }
  });

  it('wraps a command in setpriv and resolves executables on PATH or by path', () => {
    expect(withParentDeathSignal('/usr/bin/setpriv', ['codex', 'app-server'])).toEqual(['/usr/bin/setpriv', '--pdeathsig', 'TERM', '--', 'codex', 'app-server']);
    const bin = scratchDir();
    fs.writeFileSync(path.join(bin, 'tool'), '#!/bin/sh\n');
    expect(resolveExecutable('tool', bin, '/')).toBeUndefined(); // not executable yet
    fs.chmodSync(path.join(bin, 'tool'), 0o755);
    expect(resolveExecutable('tool', `/nonexistent:${bin}`, '/')).toBe(path.join(bin, 'tool'));
    expect(resolveExecutable('./tool', undefined, bin)).toBe(path.join(bin, 'tool'));
    expect(resolveExecutable('missing-tool', bin, '/')).toBeUndefined();
  });
});

describe('codex app-server launch', () => {
  it('starts the app-server under setpriv --pdeathsig TERM when setpriv is installed', async () => {
    const { bin, argvLog } = fakeSetprivDir();
    const r = rig({ PATH: `${bin}:${process.env.PATH}` });
    const session = await r.instance.start(OPEN_OPTIONS);
    expect(session.nativeSessionId).toBe('thread-1');
    const argv = fs.readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(argv).toHaveLength(1);
    expect(argv[0]).toMatch(new RegExp(`^--pdeathsig TERM -- ${process.execPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} .*fake-app-server\\.mjs .* -c check_for_update_on_startup=false$`));
    expect(r.context.logs.warn.some(([, message]) => /setpriv/.test(message))).toBe(false);
  });

  it('starts it plainly, and says so once, when setpriv is not installed', async () => {
    const empty = scratchDir();
    const r = rig({ PATH: empty });
    await r.instance.start(OPEN_OPTIONS);
    await r.instance.dispose('restart');
    await r.instance.start(OPEN_OPTIONS); // a second spawn does not warn again
    expect(r.context.logs.warn.filter(([, message]) => /setpriv is not installed/.test(message))).toHaveLength(1);
    expect(readLog(r.logFile).filter((entry) => entry.event === 'start')).toHaveLength(2);
  });

  it('reports a missing codex binary the plain way, without going through setpriv', async () => {
    const { bin, argvLog } = fakeSetprivDir();
    const r = rig({ PATH: `${bin}:${process.env.PATH}`, command: ['definitely-not-a-codex-binary-xyz', 'app-server'] });
    await expect(r.instance.probe()).resolves.toMatchObject({ installed: false });
    expect(fs.existsSync(argvLog)).toBe(false);
  });

  it('records the start time and boot of the process it started', async () => {
    const r = rig();
    await r.instance.start(OPEN_OPTIONS);
    const { pid } = await r.instance.alive();
    const recorded = JSON.parse(r.context.metaStore.get(INSTANCE_KEY)!) as { pid: number; startTicks: string; bootId?: string };
    expect(recorded).toMatchObject({ pid, startTicks: processStartTicks(pid!) });
    expect(recorded.bootId).toBe(currentBootId());
  });

  it('starts the process as the leader of its own process group and records that', async () => {
    const r = rig();
    await r.instance.start(OPEN_OPTIONS);
    const { pid } = await r.instance.alive();
    expect(processGroupId(pid!)).toBe(pid); // setpriv execs into the command, so the launcher leads the group
    expect(JSON.parse(r.context.metaStore.get(INSTANCE_KEY)!)).toMatchObject({ pid, processGroup: pid });
  });
});

describe('an app-server left running by an earlier backend', () => {
  it('is ended before the first spawn when its recorded pid and start time still match', async () => {
    const stranded = strandedProcess();
    const ticks = await untilRunning(stranded.pid!);
    const r = rig();
    r.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid: stranded.pid, startTicks: ticks, bootId: currentBootId(), startedAt: new Date().toISOString() }));

    await r.instance.start(OPEN_OPTIONS);

    expect(await untilGone(stranded.pid!)).toBe(true);
    expect(r.context.logs.warn.some(([fields, message]) => /earlier backend/.test(message) && (fields as { pid?: number }).pid === stranded.pid)).toBe(true);
    // The record now describes the new process.
    const recorded = JSON.parse(r.context.metaStore.get(INSTANCE_KEY)!) as { pid: number };
    expect(recorded.pid).toBe((await r.instance.alive()).pid);
    expect(recorded.pid).not.toBe(stranded.pid);
  });

  it('gets SIGKILL when it ignores SIGTERM past the grace period', async () => {
    const stranded = strandedProcess({ ignoreSigterm: true });
    const ticks = await untilRunning(stranded.pid!);
    const r = rig({ timings: { staleTermGraceMs: 200 } });
    r.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid: stranded.pid, startTicks: ticks }));
    // Give node time to install the SIGTERM handler before the signal arrives.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await r.instance.start(OPEN_OPTIONS);

    expect(await untilGone(stranded.pid!)).toBe(true);
  });

  it('is left alone when the pid now belongs to another process (start time differs)', async () => {
    const stranded = strandedProcess();
    const ticks = await untilRunning(stranded.pid!);
    const r = rig();
    r.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid: stranded.pid, startTicks: `${ticks}1` }));

    await r.instance.start(OPEN_OPTIONS);

    expect(processStartTicks(stranded.pid!)).toBe(ticks);
    expect(r.context.logs.warn.some(([, message]) => /earlier backend/.test(message))).toBe(false);
  });

  it('is left alone when the record has no start time to compare', async () => {
    const stranded = strandedProcess();
    const ticks = await untilRunning(stranded.pid!);
    const r = rig();
    r.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid: stranded.pid, startedAt: new Date().toISOString() }));

    await r.instance.start(OPEN_OPTIONS);

    expect(processStartTicks(stranded.pid!)).toBe(ticks);
  });

  it('is only looked for before the first spawn, not when this instance respawns its own process', async () => {
    const r = rig();
    await r.instance.start(OPEN_OPTIONS);
    await r.instance.dispose('restart');
    const stranded = strandedProcess();
    const ticks = await untilRunning(stranded.pid!);
    r.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid: stranded.pid, startTicks: ticks }));

    await r.instance.start(OPEN_OPTIONS);

    expect(processStartTicks(stranded.pid!)).toBe(ticks);
  });

  it('terminateRecordedProcess reports a process that is already gone as ended and never signals a reused pid', async () => {
    expect(await terminateRecordedProcess({ pid: 2_147_483_646, startTicks: '1' }, 50)).toBe(true);
    expect(await terminateRecordedProcess({ pid: process.pid, startTicks: `${processStartTicks(process.pid)}0` }, 50)).toBe(true);
    expect(processStartTicks(process.pid)).toBeDefined(); // this test process is still here
  });
});

describe('the app-server and its launcher are ended together', () => {
  it('ends the launcher and its native child when the stale reap finds a recorded process group', async () => {
    const { pid, nativePid } = await stubbornLauncher({ detached: true });
    const r = rig({ timings: { staleTermGraceMs: 300 } });
    r.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid, startTicks: processStartTicks(pid), bootId: currentBootId(), processGroup: pid }));

    await r.instance.start(OPEN_OPTIONS);

    // The native child ignores SIGTERM, which the launcher only forwards; the group SIGKILL reaches both.
    expect(await untilGone(nativePid)).toBe(true);
    expect(await untilGone(pid)).toBe(true);
    expect(r.context.logs.warn.some(([fields, message]) => /earlier backend/.test(message) && (fields as { pid?: number }).pid === pid)).toBe(true);
  });

  it('signals only the pid when the record names no group, so a stubborn native child outlives its launcher', async () => {
    const { pid, nativePid } = await stubbornLauncher({ detached: true });
    const r = rig({ timings: { staleTermGraceMs: 300 } });
    r.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid, startTicks: processStartTicks(pid), bootId: currentBootId() })); // a record from before the group start

    await r.instance.start(OPEN_OPTIONS);

    expect(await untilGone(pid)).toBe(true);
    expect(processStartTicks(nativePid)).toBeDefined(); // the orphan the group signal exists to prevent
  });

  it('signals nothing when the pid or start time no longer match, group or not', async () => {
    const { pid, nativePid } = await stubbornLauncher({ detached: true });
    const ticks = processStartTicks(pid)!;
    const r = rig({ timings: { staleTermGraceMs: 200 } });
    r.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid, startTicks: `${ticks}1`, bootId: currentBootId(), processGroup: pid })); // the pid was reused

    await r.instance.start(OPEN_OPTIONS);

    expect(processStartTicks(pid)).toBe(ticks);
    expect(processStartTicks(nativePid)).toBeDefined();
    expect(processGroupId(pid)).toBe(pid);
    expect(r.context.logs.warn.some(([, message]) => /earlier backend/.test(message))).toBe(false);

    // The same start time from another boot is just as foreign.
    const other = rig({ timings: { staleTermGraceMs: 200 } });
    other.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid, startTicks: ticks, bootId: 'another-boot', processGroup: pid }));
    await other.instance.start(OPEN_OPTIONS);
    expect(processStartTicks(pid)).toBe(ticks);
    expect(processStartTicks(nativePid)).toBeDefined();
    expect(other.context.logs.warn.some(([, message]) => /earlier backend/.test(message))).toBe(false);
  });

  it('does not signal a group the recorded process does not lead', async () => {
    const stranded = strandedProcess(); // shares the group of this test process, as an older record would describe
    const ticks = await untilRunning(stranded.pid!);
    const r = rig({ timings: { staleTermGraceMs: 300 } });
    r.context.metaStore.set(INSTANCE_KEY, JSON.stringify({ pid: stranded.pid, startTicks: ticks, bootId: currentBootId(), processGroup: stranded.pid }));

    await r.instance.start(OPEN_OPTIONS);

    expect(await untilGone(stranded.pid!)).toBe(true); // the pid-only fallback ended it
    expect(processStartTicks(process.pid)).toBeDefined(); // and this process, in the group the record did not lead, was never signalled
  });

  it('close() escalates to SIGKILL for the whole group', async () => {
    const dir = scratchDir();
    const { scenarioPath, logFile } = writeScenario(dir, { ignoreStdinEof: true, ignoreSigterm: true, handlers: baseHandlers('thread-1') });
    const client = await JsonRpcClient.spawn({
      command: [process.execPath, FAKE_LAUNCHER, FAKE_APP_SERVER, scenarioPath], cwd: dir, env: { PATH: process.env.PATH },
      closeGraceMs: 200, termGraceMs: 200, ownProcessGroup: true,
    });
    const nativePid = await waitUntil(() => readLog(logFile).find((entry) => entry.event === 'start')?.pid as number | undefined, 5_000, 'the native server to start');
    cleanups.push(() => { try { process.kill(nativePid, 'SIGKILL'); } catch { /* already gone */ } });
    await sleep(200);
    expect(client.processGroup).toBe(client.pid);

    await client.close();

    expect(client.exitInfo).toMatchObject({ signal: 'SIGKILL', expected: true });
    expect(await untilGone(nativePid)).toBe(true);
  });

  it('close() without a process group reaches only the launcher, which is why the app-server gets one', async () => {
    const dir = scratchDir();
    const { scenarioPath, logFile } = writeScenario(dir, { ignoreStdinEof: true, ignoreSigterm: true, handlers: baseHandlers('thread-1') });
    const client = await JsonRpcClient.spawn({
      command: [process.execPath, FAKE_LAUNCHER, FAKE_APP_SERVER, scenarioPath], cwd: dir, env: { PATH: process.env.PATH },
      closeGraceMs: 200, termGraceMs: 200,
    });
    const nativePid = await waitUntil(() => readLog(logFile).find((entry) => entry.event === 'start')?.pid as number | undefined, 5_000, 'the native server to start');
    cleanups.push(() => { try { process.kill(nativePid, 'SIGKILL'); } catch { /* already gone */ } });
    await sleep(200);
    expect(client.processGroup).toBeUndefined();

    await client.close();

    expect(client.exitInfo).toMatchObject({ signal: 'SIGKILL' });
    expect(processStartTicks(nativePid)).toBeDefined();
  });

  it('ends the native child of the launcher when the instance is disposed', async () => {
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
});
