import fs from 'node:fs';
import path from 'node:path';

export const TELEMETRY_MAX_BYTES = 64 * 1024 * 1024;
export const TELEMETRY_FAILURE_MAX_BYTES = 16 * 1024 * 1024;
export const TELEMETRY_RETENTION_DAYS = 8;
const fields = ['kind', 'action', 'outcome', 'error', 'durationMs', 'event', 'messageId', 'offeredAt',
  'maxMs', 'p99Ms', 'samples', 'operation', 'project', 'provider', 'ref', 'rows'];
const lastPruned = new Map();

/** Independent of the RPC/database: a blocked backend cannot erase client failures.
 * No payloads, credentials, paths, or peer text are accepted. Append failures never
 * change delivery. The audit reports missing/capped telemetry as incomplete.
 */
export function recordCoordinationTelemetry(runtimeDir, input) {
  let fd;
  try {
    const parent = path.join(runtimeDir, 'coordination');
    if (fs.lstatSync(parent).isSymbolicLink()) return false;
    const directory = path.join(parent, 'telemetry');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) return false;
    const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
    if (lastPruned.get(directory) !== day) {
      const cutoff = new Date(now - TELEMETRY_RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
      for (const name of fs.readdirSync(directory)) {
        if (!/^\d{4}-\d{2}-\d{2}(?:\.failures)?\.(jsonl|full)$/.test(name) || name.slice(0, 10) >= cutoff) continue;
        const file = path.join(directory, name);
        try { if (fs.lstatSync(file).isFile()) fs.unlinkSync(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; } // Another appender already pruned it.
      }
      lastPruned.set(directory, day);
    }
    // Reserve a separate budget for delivery evidence. Routine HTTP traffic
    // cannot exhaust the space used by later failures or inbox offers.
    const critical = (['rpc_client', 'rpc_server', 'hook'].includes(input.kind)
      && ['error', 'abandoned'].includes(input.outcome)) || input.kind === 'offer'
      || (input.kind === 'event_loop' && input.maxMs >= 1000);
    const stem = `${day}${critical ? '.failures' : ''}`;
    const limit = critical ? TELEMETRY_FAILURE_MAX_BYTES : TELEMETRY_MAX_BYTES;
    const file = path.join(directory, `${stem}.jsonl`);
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    const record = { timestamp: now };
    for (const key of fields) {
      const value = input[key];
      if ((typeof value === 'string' && value.length <= 180) || (typeof value === 'number' && Number.isFinite(value))) record[key] = value;
    }
    const line = `${JSON.stringify(record)}\n`;
    if (fs.fstatSync(fd).size + Buffer.byteLength(line) > limit) {
      try { fs.writeFileSync(path.join(directory, `${stem}.full`), 'Telemetry capped; counts are incomplete.\n', { flag: 'wx', mode: 0o600 }); } catch { /* Already marked, or unavailable. */ }
      return false;
    }
    fs.writeSync(fd, line);
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Best-effort telemetry. */ } } }
}
