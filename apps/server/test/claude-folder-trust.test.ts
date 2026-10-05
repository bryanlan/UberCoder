import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { claudeFolderTrustSelection } from '../src/sessions/screen-heuristics.js';
import { parseSessionScreenSnapshot } from '../src/sessions/session-screen.js';
import { FakeTmux, claudeProvider, project, provider, providerSettings } from './helpers/session-fixtures.js';

function trustScreen(selection: 'accept' | 'exit' = 'exit') {
  return [
    'Accessing workspace:', '', ' /demo/project', '',
    'Quick safety check: Is this a project you created or one you trust?',
    'Security guide', '',
    `${selection === 'exit' ? ' ❯' : '  '} No, exit`,
    `${selection === 'accept' ? ' ❯' : '  '} Yes, I trust this folder`,
    '', ' Enter to confirm · Esc to cancel',
  ].join('\n');
}
const readyScreen = (text = '') => [
  'Claude Code', '────────────────────────────────────────', `❯ ${text}`,
  '────────────────────────────────────────', 'bypass permissions on',
].join('\n');

class TrustTmux extends FakeTmux {
  pid = 4242;
  confirmDown = true;
  afterTrustScreen = readyScreen();
  override async getPanePid() { return this.pid; }
  override async sendKeys(sessionName: string, keys: string[]) {
    await super.sendKeys(sessionName, keys);
    const selection = claudeFolderTrustSelection(parseSessionScreenSnapshot(this.paneText));
    if (keys[0] === 'Down' && selection === 'exit' && this.confirmDown) this.paneText = trustScreen('accept');
    if (keys[0] === 'Enter' && selection === 'accept') this.paneText = this.afterTrustScreen;
  }
  override async sendLiteralText(sessionName: string, text: string) {
    await super.sendLiteralText(sessionName, text);
    this.paneText = readyScreen(text);
  }
}

async function fixture(initialScreen: string, adapter = claudeProvider) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-folder-trust-'));
  const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
  const tmux = new TrustTmux();
  tmux.paneText = initialScreen;
  const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
  const session = await manager.bindConversation({
    project, provider: adapter, providerSettings: { ...providerSettings, id: adapter.id },
    conversationRef: 'folder-trust', title: 'Folder trust', kind: 'history',
  });
  return {
    db, tmux, manager, session, tempDir,
    events: async () => (await fs.readFile(session.eventLogPath!, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    close: async () => { await manager.stop(); db.close(); await fs.rm(tempDir, { recursive: true, force: true }); },
  };
}

describe('Claude Console folder trust', () => {
  it.each(['accept', 'exit'] as const)('automatically accepts startup with %s selected without a user turn', async (selection) => {
    const f = await fixture(trustScreen(selection));
    try {
      await f.manager.ensureSession(f.session.id);
      expect(f.tmux.sentKeys).toEqual(selection === 'exit' ? [['Down'], ['Enter']] : [['Enter']]);
      expect(f.tmux.sent).toEqual([]);
      expect(f.tmux.created).toHaveLength(1);
      expect(parseSessionScreenSnapshot(f.tmux.paneText).inputActive).toBe(true);
      const current = f.db.boundSessions.getById(f.session.id)!;
      expect(current.pid).toBe(f.session.pid);
      expect(current.isWorking).toBe(false);
      expect(current.lastActivityAt).toBeUndefined();
      expect((await f.events()).filter((event) => event.type === 'user-input')).toEqual([]);
      expect((await f.events()).filter((event) => event.text?.startsWith('Accepted Claude folder trust'))).toHaveLength(1);
      await f.manager.getSessionScreen(f.session.id);
      expect(f.tmux.sentKeys).toHaveLength(selection === 'exit' ? 2 : 1);
    } finally { await f.close(); }
  });

  it.each([
    { method: 'keystrokes', text: 'Please inspect this repository' },
    { method: 'keystrokes', text: '2' },
    { method: 'input', text: 'Please inspect this repository' },
  ])('accepts a late trust screen before $method message $text exactly once', async ({ method, text }) => {
    const f = await fixture(readyScreen());
    try {
      f.tmux.paneText = trustScreen();
      const result = method === 'keystrokes'
        ? await f.manager.sendKeystrokes(f.session.id, { text, keys: ['Enter'], submittedText: text })
        : await f.manager.sendInput(f.session.id, text);
      expect(f.tmux.sentKeys).toEqual([['Down'], ['Enter'], ['Enter']]);
      expect(f.tmux.sent).toEqual([text]);
      expect(result.recordedUserInput?.text).toBe(text);
      expect((await f.events()).filter((event) => event.type === 'user-input').map((event) => event.text)).toEqual([text]);
      expect(f.tmux.created).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(['keystrokes', 'input'] as const)('stops at another startup control before sending a %s message', async (method) => {
    const f = await fixture(readyScreen());
    try {
      f.tmux.paneText = trustScreen();
      f.tmux.afterTrustScreen = [
        'A different approval is required', '❯ 1. Yes', '  2. No', 'Esc to cancel · Tab to amend',
      ].join('\n');
      const text = 'Please inspect this repository';
      const send = method === 'keystrokes'
        ? f.manager.sendKeystrokes(f.session.id, { text, keys: ['Enter'], submittedText: text })
        : f.manager.sendInput(f.session.id, text);
      await expect(send).rejects.toThrow('waiting for');
      expect(f.tmux.sentKeys).toEqual([['Down'], ['Enter']]);
      expect(f.tmux.sent).toEqual([]);
      expect((await f.events()).filter((event) => event.type === 'user-input')).toEqual([]);
    } finally { await f.close(); }
  });

  it('accepts an existing startup prompt after a manager restart', async () => {
    const f = await fixture(readyScreen());
    let restarted: SessionManager | undefined;
    try {
      await f.manager.stop();
      f.tmux.paneText = trustScreen();
      restarted = new SessionManager(f.db, f.tmux, path.join(f.tempDir, 'runtime'), new RealtimeEventBus());
      await restarted.ensureSession(f.session.id);
      await restarted.ensureSession(f.session.id);
      expect(f.tmux.sentKeys).toEqual([['Down'], ['Enter']]);
      expect(f.tmux.created).toHaveLength(1);
      expect(f.db.boundSessions.getById(f.session.id)?.pid).toBe(f.session.pid);
    } finally { await restarted?.stop(); await f.close(); }
  });

  it.each(['owner', 'pid'] as const)('does not write to a session whose %s changed', async (change) => {
    const f = await fixture(readyScreen());
    try {
      f.tmux.paneText = trustScreen();
      if (change === 'owner') await f.tmux.setOption(f.session.tmuxSessionName, '@agent_console_session_id', 'another-session');
      else f.tmux.pid += 1;
      await expect(f.manager.sendKeystrokes(f.session.id, { text: 'continue', keys: ['Enter'] })).rejects.toThrow('ownership changed');
      expect(f.tmux.sentKeys).toEqual([]);
      expect(f.tmux.sent).toEqual([]);
      expect(f.db.boundSessions.getById(f.session.id)?.status).toBe('bound');
    } finally { await f.close(); }
  });

  it('does not confirm when the selected trust option cannot be verified', async () => {
    const f = await fixture(readyScreen());
    try {
      f.tmux.paneText = trustScreen();
      f.tmux.confirmDown = false;
      await expect(f.manager.sendKeystrokes(f.session.id, { text: 'continue', keys: ['Enter'] })).rejects.toThrow('could not be selected');
      expect(f.tmux.sentKeys).toEqual([['Down']]);
      expect(f.tmux.sent).toEqual([]);
    } finally { await f.close(); }
  });

  it('does not accept this screen in a Codex session', async () => {
    const f = await fixture(trustScreen(), provider);
    try {
      await f.manager.ensureSession(f.session.id);
      expect(f.tmux.sentKeys).toEqual([]);
    } finally { await f.close(); }
  });

  it('does not accept a quoted trust menu inside a real composer', () => {
    const quote = parseSessionScreenSnapshot(readyScreen(`Explain this prompt:\n${trustScreen()}`));
    expect(quote.inputActive).toBe(true);
    expect(claudeFolderTrustSelection(quote)).toBeUndefined();
  });
});
