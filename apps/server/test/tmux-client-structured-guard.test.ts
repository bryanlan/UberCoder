import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTmuxSessionName, ShellTmuxClient, STRUCTURED_SESSION_NAME_PREFIX, TmuxError } from '../src/sessions/tmux-client.js';

// No tmux process may start in this file: a structured name must be refused before anything is spawned.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('tmux was spawned for a structured session name');
  }),
}));

const NAME = `${STRUCTURED_SESSION_NAME_PREFIX}6f1c2d3e-0000-4000-8000-000000000000`;

describe('tmux client and structured rows', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });

  it('names the sentinel prefix a structured row carries instead of a tmux session', () => {
    expect(STRUCTURED_SESSION_NAME_PREFIX).toBe('structured:');
  });

  it('refuses a structured name and lets every other name through', () => {
    expect(() => assertTmuxSessionName(NAME)).toThrow(TmuxError);
    expect(() => assertTmuxSessionName(NAME)).toThrow(/structured session/);
    for (const fine of ['agent-console-6f1c2d3e', 'codex_1234', 'not-structured:1', 'Structured:1']) {
      expect(() => assertTmuxSessionName(fine)).not.toThrow();
    }
  });

  // tmux accepts `new-session -s structured:<id>` and creates `structured_<id>` (and `has-session -t` then cannot
  // find it), so the client is the only place a stray call on a structured row can be stopped.
  const client = new ShellTmuxClient();
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['newDetachedSession', () => client.newDetachedSession(NAME, '/tmp', 'codex')],
    ['pipePaneToFile', () => client.pipePaneToFile(NAME, '/tmp/structured-guard-never-created/raw.log')],
    ['closePanePipe', () => client.closePanePipe(NAME)],
    ['sendLiteralText', () => client.sendLiteralText(NAME, 'text')],
    ['pasteText', () => client.pasteText(NAME, 'text')],
    ['sendKeys', () => client.sendKeys(NAME, ['Enter'])],
    ['capturePane', () => client.capturePane(NAME)],
    ['interrupt', () => client.interrupt(NAME)],
    ['killSession', () => client.killSession(NAME)],
    ['hasSession', () => client.hasSession(NAME)],
    ['getPanePid', () => client.getPanePid(NAME)],
    ['ensureMinimumWindowSize', () => client.ensureMinimumWindowSize(NAME, 80, 50)],
    ['getSessionCreatedAt', () => client.getSessionCreatedAt(NAME)],
    ['getOption', () => client.getOption(NAME, '@agent_console_session_id')],
    ['setOption', () => client.setOption(NAME, '@agent_console_session_id', 'x')],
  ];

  it.each(calls)('%s throws for a structured session name without running tmux', async (_name, call) => {
    await expect(call()).rejects.toThrow(/structured session/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('covers every method of the client that takes a session name', () => {
    const methods = Object.getOwnPropertyNames(ShellTmuxClient.prototype).filter(name => name !== 'constructor');
    expect(calls.map(([name]) => name).sort()).toEqual(methods.sort());
  });
});
