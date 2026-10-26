// Process identity and gated termination for the session host's record file (`../session-host.ts`).
//
// The backend runs with `KillMode=process` (tmux must survive restarts), so provider processes survive it too,
// and that is intended: each runs behind a session host that a restarted backend reconnects to. What this file
// does is identify a recorded process safely before anything is signalled. A pid is trusted only together with
// its start time (field 22 of `/proc/<pid>/stat`) and the kernel boot id, so a reused pid or a record from before
// a reboot is never taken for the process it once named. The host record names the host, the provider child and the
// child's process group; `terminateRecordedProcess` ends a recorded process (and, for a child that leads its own
// group, the group: the npm `codex` is a Node launcher whose native server shares it) after those checks.

import fs from 'node:fs';

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

/** The identity a record names for a process (the session host, or its provider child). */
export interface RecordedProcess {
  pid: number;
  startTicks?: string;
  bootId?: string;
  /** The process group the process leads (equal to `pid`). Absent for a record of a process that did not start its own group. */
  processGroup?: number;
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
