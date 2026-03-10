import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shellEscape } from '../lib/shell.js';

async function runTmux(args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('tmux', args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `tmux exited with code ${code}`));
    });
  });
}

export interface TmuxClient {
  newDetachedSession(sessionName: string, cwd: string, shellCommand: string): Promise<void>;
  pipePaneToFile(sessionName: string, filePath: string): Promise<void>;
  sendLiteralText(sessionName: string, text: string): Promise<void>;
  sendKeys(sessionName: string, keys: string[]): Promise<void>;
  sendLiteralInput(sessionName: string, text: string): Promise<void>;
  capturePane(sessionName: string, startLine?: number): Promise<string>;
  interrupt(sessionName: string): Promise<void>;
  killSession(sessionName: string): Promise<void>;
  hasSession(sessionName: string): Promise<boolean>;
  getPanePid(sessionName: string): Promise<number | undefined>;
  setUserOption(sessionName: string, name: string, value: string): Promise<void>;
}

export class ShellTmuxClient implements TmuxClient {
  async newDetachedSession(sessionName: string, cwd: string, shellCommand: string): Promise<void> {
    await runTmux(['new-session', '-d', '-s', sessionName, '-c', cwd, shellCommand]);
  }

  async pipePaneToFile(sessionName: string, filePath: string): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await runTmux(['pipe-pane', '-o', '-t', sessionName, `cat >> ${shellEscape(filePath)}`]);
  }

  async sendLiteralText(sessionName: string, text: string): Promise<void> {
    if (!text.length) {
      return;
    }
    await runTmux(['send-keys', '-t', sessionName, '-l', '--', text]);
  }

  async sendKeys(sessionName: string, keys: string[]): Promise<void> {
    if (!keys.length) {
      return;
    }
    await runTmux(['send-keys', '-t', sessionName, ...keys]);
  }

  async sendLiteralInput(sessionName: string, text: string): Promise<void> {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.length > 0) {
        await this.sendLiteralText(sessionName, line);
      }
      await this.sendKeys(sessionName, ['Enter']);
    }
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
    } catch {
      return false;
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

  async setUserOption(sessionName: string, name: string, value: string): Promise<void> {
    await runTmux(['set-option', '-t', sessionName, '-q', name, value]);
  }
}
