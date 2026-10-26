// Where Claude keeps a session on disk, and who is using it.
//
//   <config dir>/projects/<escaped cwd>/<session id>.jsonl   the transcript
//   <config dir>/sessions/<pid>.json                          one file per live CLI process: {pid, sessionId, cwd,
//                                                             procStart (the pid's start time in clock ticks), ...}
//
// `<config dir>` is `$CLAUDE_CONFIG_DIR`, else `~/.claude`. The escaped cwd replaces every character that is not a
// letter or digit with `-`; a name over 200 characters is shortened and gets a hash, which this module does not
// reproduce, so such a transcript is found by scanning the project directories instead.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { processStartTicks } from '../codex/process-lifetime.js';

const MAX_PROJECT_DIR_CHARS = 200;
/** A transcript that has this many bytes of preamble and no conversation line is called empty. */
const EMPTY_SCAN_LINES = 5_000;

export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string = os.homedir()): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) return path.join(home, '.claude');
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return path.join(home, configured.slice(2));
  return path.resolve(configured);
}

/** The project directory name for a working directory, or undefined when it is too long to compute here. */
export function escapeProjectDir(cwd: string): string | undefined {
  const escaped = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return escaped.length > MAX_PROJECT_DIR_CHARS ? undefined : escaped;
}

/** The transcript path the CLI will use for a session started in `cwd` (the real path of `cwd` when it differs). */
export function expectedTranscriptPaths(configDir: string, cwd: string, sessionId: string): string[] {
  const candidates = new Set<string>();
  const add = (directory: string): void => {
    const escaped = escapeProjectDir(directory);
    if (escaped) candidates.add(path.join(configDir, 'projects', escaped, `${sessionId}.jsonl`));
  };
  add(cwd);
  try {
    add(fs.realpathSync(cwd));
  } catch {
    // The directory does not exist (yet); the plain path stands.
  }
  return [...candidates];
}

function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Every transcript file for the id: the expected path first, then any project directory (resume searches them all). */
export function locateTranscripts(configDir: string, cwd: string, sessionId: string): string[] {
  const found: string[] = [];
  for (const candidate of expectedTranscriptPaths(configDir, cwd, sessionId)) if (fileExists(candidate)) found.push(candidate);
  const projects = path.join(configDir, 'projects');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(projects);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const candidate = path.join(projects, entry, `${sessionId}.jsonl`);
    if (!found.includes(candidate) && fileExists(candidate)) found.push(candidate);
  }
  return found;
}

/** True when the file holds at least one user or assistant line. The CLI cannot resume a transcript without one. */
export async function transcriptHasConversation(file: string): Promise<boolean> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let seen = 0;
    for await (const line of lines) {
      seen += 1;
      if (line.includes('"type":"user"') || line.includes('"type":"assistant"') || line.includes('"type": "user"') || line.includes('"type": "assistant"')) {
        try {
          const entry = JSON.parse(line) as { type?: unknown };
          if (entry.type === 'user' || entry.type === 'assistant') return true;
        } catch {
          // A torn last line.
        }
      }
      if (seen >= EMPTY_SCAN_LINES) return true; // a very long preamble: leave the verdict to the CLI
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when the process looks like a Claude CLI: a recycled pid left in a stale registry file must not hold a session. */
export function looksLikeClaudeProcess(pid: number, procRoot = '/proc'): boolean {
  try {
    const comm = fs.readFileSync(`${procRoot}/${pid}/comm`, 'utf8');
    const cmdline = fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
    return /claude/i.test(comm) || /claude/i.test(cmdline);
  } catch {
    return false;
  }
}

/**
 * A live process that has the session open, from the registry files the CLI writes. The CLI itself does not refuse
 * two processes on one transcript, so the plugin does. A file left by a process that died without cleaning up must not
 * hold the session: the file records the process's start time (`procStart`, clock ticks), and a pid that now has a
 * different start time is another process. A file without `procStart` falls back to "the process looks like Claude".
 * `ignorePids` are processes this plugin started for the same session (they are not "another" holder).
 */
export function findSessionHolder(
  configDir: string,
  sessionId: string,
  options: { ignorePids?: number[]; isClaudeProcess?: (pid: number) => boolean } = {},
): { pid: number; cwd?: string } | undefined {
  const directory = path.join(configDir, 'sessions');
  let names: string[] = [];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return undefined;
  }
  const isClaude = options.isClaudeProcess ?? ((pid: number) => looksLikeClaudeProcess(pid));
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let entry: { pid?: unknown; sessionId?: unknown; cwd?: unknown; procStart?: unknown };
    try {
      entry = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as typeof entry;
    } catch {
      continue;
    }
    if (entry.sessionId !== sessionId || typeof entry.pid !== 'number' || !Number.isInteger(entry.pid) || entry.pid <= 1) continue;
    if (options.ignorePids?.includes(entry.pid)) continue;
    if (!pidIsAlive(entry.pid)) continue;
    const startTicks = processStartTicks(entry.pid);
    if (startTicks === undefined) continue; // gone, or a zombie that holds no work
    if (typeof entry.procStart === 'string' || typeof entry.procStart === 'number') {
      if (String(entry.procStart) !== startTicks) continue;
    } else if (!isClaude(entry.pid)) {
      continue;
    }
    return { pid: entry.pid, ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}) };
  }
  return undefined;
}
