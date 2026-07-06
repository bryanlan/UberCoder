import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { shellEscape } from '../lib/shell.js';

const DEFAULT_TMUX_SOCKET_NAME = 'agent-console';

export class TmuxError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number | undefined,
    readonly stderr: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'TmuxError';
  }
}

export function isTmuxSessionMissingError(error: unknown): boolean {
  if (!(error instanceof TmuxError) || error.exitCode !== 1) {
    return false;
  }
  return /(?:can't find session|can't find pane|no server running|error connecting to .*No such file or directory)/i.test(error.stderr);
}

function tmuxSocketArgs(): string[] {
  const socketName = process.env.AGENT_CONSOLE_TMUX_SOCKET ?? DEFAULT_TMUX_SOCKET_NAME;
  return socketName ? ['-L', socketName] : [];
}

function scopedTmuxUnitName(sessionName: string): string {
  const safeSessionName = sessionName.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 50);
  return `agent-console-tmux-${safeSessionName}-${randomUUID().slice(0, 8)}`;
}

async function runCommand(command: string, args: string[], errorArgs = args): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new TmuxError(
        error instanceof Error ? error.message : `Failed to run ${command}.`,
        errorArgs,
        undefined,
        stderr.trim(),
        { cause: error },
      ));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const trimmedStderr = stderr.trim();
      reject(new TmuxError(
        trimmedStderr || `${command} exited with code ${code ?? 'unknown'}`,
        errorArgs,
        code ?? undefined,
        trimmedStderr,
      ));
    });
  });
}

async function runTmux(args: string[]): Promise<string> {
  const tmuxArgs = [...tmuxSocketArgs(), ...args];
  return await runCommand('tmux', tmuxArgs, tmuxArgs);
}

async function runScopedTmux(sessionName: string, args: string[]): Promise<string> {
  const tmuxArgs = [...tmuxSocketArgs(), ...args];
  const systemdRunArgs = [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '--unit',
    scopedTmuxUnitName(sessionName),
    'tmux',
    ...tmuxArgs,
  ];
  return await runCommand('systemd-run', systemdRunArgs, tmuxArgs);
}

export interface TmuxClient {
  newDetachedSession(sessionName: string, cwd: string, shellCommand: string): Promise<void>;
  pipePaneToFile(sessionName: string, filePath: string): Promise<void>;
  closePanePipe(sessionName: string): Promise<void>;
  sendLiteralText(sessionName: string, text: string): Promise<void>;
  pasteText(sessionName: string, text: string): Promise<void>;
  sendKeys(sessionName: string, keys: string[]): Promise<void>;
  capturePane(sessionName: string, startLine?: number): Promise<string>;
  interrupt(sessionName: string): Promise<void>;
  killSession(sessionName: string): Promise<void>;
  hasSession(sessionName: string): Promise<boolean>;
  getPanePid(sessionName: string): Promise<number | undefined>;
  setOption(sessionName: string, name: string, value: string): Promise<void>;
}

export class ShellTmuxClient implements TmuxClient {
  async newDetachedSession(sessionName: string, cwd: string, shellCommand: string): Promise<void> {
    const args = ['new-session', '-d', '-s', sessionName, '-c', cwd, shellCommand];
    try {
      await runScopedTmux(sessionName, args);
    } catch {
      await runTmux(args);
    }
  }

  async pipePaneToFile(sessionName: string, filePath: string): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await runTmux(['pipe-pane', '-o', '-t', sessionName, `cat >> ${shellEscape(filePath)}`]);
  }

  async closePanePipe(sessionName: string): Promise<void> {
    await runTmux(['pipe-pane', '-t', sessionName]);
  }

  async sendLiteralText(sessionName: string, text: string): Promise<void> {
    if (!text.length) {
      return;
    }
    await runTmux(['send-keys', '-t', sessionName, '-l', '--', text]);
  }

  async pasteText(sessionName: string, text: string): Promise<void> {
    if (!text.length) {
      return;
    }

    const bufferName = `agent-console-paste-${randomUUID()}`;
    const bufferPath = path.join(os.tmpdir(), `${bufferName}.txt`);

    try {
      await fsPromises.writeFile(bufferPath, text, 'utf8');
      await runTmux(['load-buffer', '-b', bufferName, bufferPath]);
      await runTmux(['paste-buffer', '-d', '-p', '-r', '-b', bufferName, '-t', sessionName]);
    } catch (error) {
      try {
        await runTmux(['delete-buffer', '-b', bufferName]);
      } catch (cleanupError) {
        void cleanupError;
      }
      throw error;
    } finally {
      await fsPromises.rm(bufferPath, { force: true }).catch(() => undefined);
    }
  }

  async sendKeys(sessionName: string, keys: string[]): Promise<void> {
    if (!keys.length) {
      return;
    }
    await runTmux(['send-keys', '-t', sessionName, ...keys]);
  }

  async capturePane(sessionName: string, startLine = -240): Promise<string> {
    const args = ['capture-pane', '-e', '-p', '-J', '-t', sessionName];
    if (Number.isFinite(startLine)) {
      args.push('-S', String(startLine));
    }
    return await runTmux(args);
  }

  async interrupt(sessionName: string): Promise<void> {
    await runTmux(['send-keys', '-t', sessionName, 'C-c']);
  }

  async killSession(sessionName: string): Promise<void> {
    await runTmux(['kill-session', '-t', sessionName]);
  }

  async hasSession(sessionName: string): Promise<boolean> {
    try {
      await runTmux(['has-session', '-t', sessionName]);
      return true;
    } catch (error) {
      if (isTmuxSessionMissingError(error)) {
        return false;
      }
      throw error;
    }
  }

  async getPanePid(sessionName: string): Promise<number | undefined> {
    try {
      const output = await runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_pid}']);
      const pid = Number(output.split(/\s+/)[0]);
      return Number.isFinite(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  async setOption(sessionName: string, name: string, value: string): Promise<void> {
    await runTmux(['set-option', '-t', sessionName, '-q', name, value]);
  }
}
