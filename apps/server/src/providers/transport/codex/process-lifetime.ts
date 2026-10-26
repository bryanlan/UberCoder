// Keeps the shared `codex app-server` from outliving the backend that owns it.
//
// The backend runs with `KillMode=process` (tmux must survive restarts), so a crashed backend leaves its
// app-server running, possibly in the middle of a turn. Two layers deal with that:
//   - the child is started through `setpriv --pdeathsig TERM`, so the kernel ends it when the backend dies;
//   - the instance records the child's pid and start time, and the next backend ends a recorded process that
//     is still running before it spawns a new one, so two writers never share a thread.
// The recorded pid is the process `setpriv` execs into. With an npm install that is the `codex` Node launcher, and
// the native app-server is its child. The child therefore starts as the leader of its own process group, and the
// stale reap signals that group (identity checks still gate it), so the native child is ended with its launcher.

import fs from 'node:fs';
import path from 'node:path';

const POLL_MS = 50;
const KILL_WAIT_MS = 2_000;

/**
 * The start time of a process in clock ticks since boot (field 22 of `/proc/<pid>/stat`). A reused pid has a
 * different value. Undefined when the process does not exist or is already dead (a zombie holds no work).
 */
export function processStartTicks(pid: number, procRoot = '/proc'): string | undefined {
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    return fields[19] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The process group id of a live process (field 5 of `/proc/<pid>/stat`). Undefined when the process does not
 * exist or is already dead.
 */
export function processGroupId(pid: number, procRoot = '/proc'): number | undefined {
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    const group = Number(fields[2]);
    return Number.isInteger(group) && group > 0 ? group : undefined;
  } catch {
    return undefined;
  }
}

/** Identifies this boot, so a start time from before a reboot is never taken for a process of this one. */
export function currentBootId(procRoot = '/proc'): string | undefined {
  try {
    return fs.readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** What the instance records about the child it started. */
export interface RecordedProcess {
  pid: number;
  startTicks?: string;
  bootId?: string;
  /** The process group the process leads (equal to `pid`). Absent for a record of a process that did not start its own group. */
  processGroup?: number;
}

/** Reads the stored instance record. Anything unusable gives undefined. */
export function parseRecordedProcess(stored: string): RecordedProcess | undefined {
  try {
    const value = JSON.parse(stored) as { pid?: unknown; startTicks?: unknown; bootId?: unknown; processGroup?: unknown };
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 1) return undefined;
    return {
      pid: value.pid,
      ...(typeof value.startTicks === 'string' ? { startTicks: value.startTicks } : {}),
      ...(typeof value.bootId === 'string' ? { bootId: value.bootId } : {}),
      // Only the group the process itself leads is ever signalled; any other value is dropped.
      ...(value.processGroup === value.pid ? { processGroup: value.pid } : {}),
    };
  } catch {
    return undefined;
  }
}

/** True when the recorded process is still running: same pid, same start time, same boot. */
export function isRecordedProcessRunning(record: RecordedProcess, procRoot = '/proc'): boolean {
  if (!record.startTicks) return false; // an identity that cannot be checked is never acted on
  if (record.bootId && record.bootId !== currentBootId(procRoot)) return false;
  return processStartTicks(record.pid, procRoot) === record.startTicks;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilGone(record: RecordedProcess, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isRecordedProcessRunning(record)) {
    if (Date.now() >= deadline) return false;
    await wait(POLL_MS);
  }
  return true;
}

/**
 * Signals a recorded process whose identity was just checked. When the record says it leads its own process group
 * and `/proc` agrees, the whole group is signalled, so the launcher's native child gets the signal too; if that
 * fails, or the process leads no group, only the pid is signalled. Returns whether a signal was delivered.
 */
function signalRecordedProcess(record: RecordedProcess, signal: NodeJS.Signals): boolean {
  if (record.processGroup === record.pid && processGroupId(record.pid) === record.pid) {
    try {
      process.kill(-record.pid, signal);
      return true;
    } catch {
      // No such group, or not permitted: signal the process alone.
    }
  }
  try {
    process.kill(record.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM, wait `termGraceMs`, then SIGKILL, each to the process group when it leads one. Returns whether the process is gone. */
export async function terminateRecordedProcess(record: RecordedProcess, termGraceMs: number): Promise<boolean> {
  if (!isRecordedProcessRunning(record)) return true;
  if (!signalRecordedProcess(record, 'SIGTERM')) return !isRecordedProcessRunning(record);
  if (await waitUntilGone(record, termGraceMs)) return true;
  // Re-check the identity right before the kill: the process may have ended and its pid been reused meanwhile.
  if (!isRecordedProcessRunning(record)) return true;
  signalRecordedProcess(record, 'SIGKILL'); // a failure means it is already gone or not ours; the wait below reports which
  return await waitUntilGone(record, KILL_WAIT_MS);
}

/** The file of `name` on `pathEnv` (or `name` itself when it contains a slash) that can be executed. */
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

/** `argv` run under `setpriv`, which asks the kernel to send SIGTERM when this process dies, then execs `argv`. */
export function withParentDeathSignal(setpriv: string, argv: string[]): string[] {
  return [setpriv, '--pdeathsig', 'TERM', '--', ...argv];
}
