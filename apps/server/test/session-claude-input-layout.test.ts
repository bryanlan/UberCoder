import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { FakeTmux, claudeProvider, project, providerSettings } from './helpers/session-fixtures.js';

const divider = '────────────────────────────────────────────────────────────────────────────────';
const paragraphText = 'Check this again\n\nHere is the second paragraph.\nIt wraps onto another row.';

class ClaudeInputBoxTmux extends FakeTmux {
  constructor(private readonly layout: 'paragraphs' | 'roster-before-footer' | 'roster-after-footer', visibleDraft = '') {
    super();
    this.paneText = this.renderComposer(visibleDraft);
  }

  override async pasteText(_sessionName: string, text: string): Promise<void> {
    this.pasted.push(text);
    this.paneText = this.renderComposer(text);
  }

  override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
    this.sentKeys.push(keys);
    if (keys.includes('Enter')) this.paneText = this.renderComposer('');
  }

  private renderComposer(text: string): string {
    const footer = '⏵⏵ bypass permissions on (shift+tab to cycle)';
    const roster = ['', '  ● main', '  ◯ general-purpose  Reviewing the result 25m 31s'];
    const draft = text && this.layout !== 'paragraphs' ? '[Pasted text #2]\npaste again to expand' : text;
    const [first = '', ...rest] = draft.split('\n');
    return [
      'Claude Code', 'Answer already delivered.', divider,
      `❯ ${first}`, ...rest.map(line => line ? `  ${line}` : ''), divider,
      ...(this.layout === 'roster-before-footer' ? [...roster, footer] : [footer, ...roster]),
    ].join('\n');
  }
}

describe('Claude input box submission', () => {
  it.each(['paragraphs', 'roster-before-footer', 'roster-after-footer'] as const)(
    'submits accepted text once with the %s layout and retains the binding', async (layout) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-input-layout-'));
      const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
      const tmux = new ClaudeInputBoxTmux(layout);
      const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
      try {
        const session = await manager.bindConversation({
          project, provider: claudeProvider, providerSettings: { ...providerSettings, id: 'claude' },
          conversationRef: `claude-input-layout-${layout}`, title: 'Layout check', kind: 'history',
        });
        const text = layout === 'paragraphs' ? paragraphText : 'A long request. '.repeat(70);
        const result = await manager.sendKeystrokes(session.id, { text, submittedText: text, keys: ['Enter'] });
        expect(tmux.pasted).toEqual([text]);
        expect(tmux.sentKeys).toEqual([['Enter']]);
        expect(result.recordedUserInput?.text).toBe(text.trim());
        expect(result.session.id).toBe(session.id);
        expect(result.session.status).toBe('bound');
      } finally {
        db.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('submits a draft already present in the multiline input box without pasting it twice', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-input-layout-'));
    const db = new AppDatabase(path.join(tempDir, 'console.sqlite'));
    const tmux = new ClaudeInputBoxTmux('paragraphs', paragraphText);
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());
    try {
      const session = await manager.bindConversation({
        project, provider: claudeProvider, providerSettings: { ...providerSettings, id: 'claude' },
        conversationRef: 'claude-input-layout-retry', title: 'Layout retry', kind: 'history',
      });
      const result = await manager.sendKeystrokes(session.id, {
        text: paragraphText, submittedText: paragraphText, keys: ['Enter'],
      });
      expect(tmux.pasted).toEqual([]);
      expect(tmux.sentKeys).toEqual([['Enter']]);
      expect(result.recordedUserInput?.text).toBe(paragraphText);
      expect(result.session.id).toBe(session.id);
    } finally {
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
