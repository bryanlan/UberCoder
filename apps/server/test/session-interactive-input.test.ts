import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { parseSessionScreenSnapshot } from '../src/sessions/session-screen.js';
import { FakeTmux, claudeProvider, project, provider, providerSettings } from './helpers/session-fixtures.js';

const approvalScreen = [
  'Claude Code',
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
  'This shell -c script runs rm and could not be checked',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No',
  '',
  'Esc to cancel · Tab to amend',
].join('\n');
const modelPicker = [
  'Select Model and Effort',
  '› 1. Default',
  '  2. GPT-6-Sol',
  'enter select · esc back',
].join('\n');
const interactiveCases = [
  { adapter: claudeProvider, screen: approvalScreen },
  { adapter: provider, screen: modelPicker },
];

describe('interactive live input', () => {
  it.each(interactiveCases.flatMap((test) => [
    'still going', 'continue', 'ok', '/model',
  ].map((text) => ({ ...test, text }))))(
    'reports the $adapter.id selection for $text', async ({ adapter, screen, text }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-interactive-input-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = screen;
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
    try {
      const session = await manager.bindConversation({
        project, provider: adapter, providerSettings: { ...providerSettings, id: adapter.id },
        conversationRef: `interactive-${adapter.id}`, title: 'Interactive check', kind: 'history',
      });
      expect(parseSessionScreenSnapshot(screen).inputActive).toBe(false);
      await expect(manager.sendKeystrokes(session.id, {
        text, keys: ['Enter'], submittedText: text,
      })).rejects.toThrow('is waiting for an approval or menu selection');
      expect(tmux.sent).toEqual([]);
      expect(tmux.pasted).toEqual([]);
      expect(tmux.sentKeys).toEqual([]);
      expect(tmux.paneText).toBe(screen);
      expect(tmux.alive.has(session.tmuxSessionName)).toBe(true);
      expect(tmux.created).toHaveLength(1);
      expect(db.boundSessions.getById(session.id)?.status).toBe('bound');
      expect(await fs.readFile(session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');
    } finally {
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves direct terminal answers to a Claude free-text question', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-free-text-question-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const tmux = new FakeTmux();
    const answer = 'Use the second approach';
    tmux.paneText = [
      'Which approach should we use?', '  1. First', '  2. Second',
      '❯ 3. Type something.', `     ${answer}`,
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
    try {
      const session = await manager.bindConversation({
        project, provider: claudeProvider, providerSettings: { ...providerSettings, id: 'claude' },
        conversationRef: 'free-text-question', title: 'Question check', kind: 'history',
      });
      expect(parseSessionScreenSnapshot(tmux.paneText).inputActive).toBe(false);
      await manager.sendKeystrokes(session.id, { keys: ['Enter'], submittedText: answer });
      expect(tmux.sent).toEqual([]);
      expect(tmux.sentKeys).toEqual([['Enter']]);
      expect(db.boundSessions.getById(session.id)?.status).toBe('bound');
    } finally {
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([claudeProvider, provider])('allows a ready $id composer when output quotes menu instructions', async (adapter) => {
    const divider = '────────────────────────────────────────';
    const render = (text: string) => [
      'The menu has these controls:',
      adapter.id === 'claude' ? 'Esc to cancel · Tab to amend' : 'enter select · esc back',
      ...(adapter.id === 'claude' ? [divider] : []),
      `${adapter.id === 'claude' ? '❯' : '›'} ${text}`,
      ...(adapter.id === 'claude' ? [divider, 'bypass permissions on'] : ['gpt-6-sol xhigh · 65% left · ~/demo']),
    ].join('\n');
    class ReadyTmux extends FakeTmux {
      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.paneText = render(text);
      }
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-quoted-menu-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const tmux = new ReadyTmux();
    tmux.paneText = render('');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
    try {
      expect(parseSessionScreenSnapshot(tmux.paneText).inputActive).toBe(true);
      const session = await manager.bindConversation({
        project, provider: adapter, providerSettings: { ...providerSettings, id: adapter.id },
        conversationRef: `quoted-menu-${adapter.id}`, title: 'Quoted menu', kind: 'history',
      });
      const result = await manager.sendKeystrokes(session.id, { text: 'still going', keys: ['Enter'], submittedText: 'still going' });
      expect(tmux.sent).toEqual(['still going']);
      expect(tmux.sentKeys).toEqual([['Enter']]);
      expect(result.recordedUserInput?.text).toBe('still going');
    } finally {
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([claudeProvider, provider])('keeps explicit $id choice controls available', async (adapter) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-interactive-choice-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = adapter.id === 'claude' ? approvalScreen : modelPicker;
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
    try {
      const session = await manager.bindConversation({
        project, provider: adapter, providerSettings: { ...providerSettings, id: adapter.id },
        conversationRef: `interactive-choice-${adapter.id}`, title: 'Choice check', kind: 'history',
      });
      const result = await manager.sendKeystrokes(session.id, { text: '2', keys: ['Enter'], submittedText: '2' });
      expect(tmux.sent).toEqual(['2']);
      expect(tmux.sentKeys).toEqual([['Enter']]);
      expect(result.recordedUserInput).toBeUndefined();
      const enterOnly = await manager.sendKeystrokes(session.id, { keys: ['Down', 'Enter'] });
      expect(tmux.sentKeys).toEqual([['Enter'], ['Down', 'Enter']]);
      expect(enterOnly.recordedUserInput).toBeUndefined();
      expect(db.boundSessions.getById(session.id)?.status).toBe('bound');
    } finally {
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
