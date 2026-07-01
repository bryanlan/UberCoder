import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionKeystrokeRejectedError, SessionManager } from '../src/sessions/session-manager.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { FakeTmux, claudeProvider, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

describe('SessionManager pending first turn', () => {
  it('launches pending sessions with an initial prompt argument when requested', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
      ref: 'pending:launch-arg',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'New conversation',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: false,
      degraded: false,
      rawMetadata: { pending: true },
    });
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:launch-arg',
      title: 'New conversation',
      kind: 'pending',
      initialPrompt: 'Reply with exactly: smoke-token',
    });

    expect(tmux.createdCommands[0]).toContain('Reply with exactly: smoke-token');
    expect(db.pendingConversations.get('pending:launch-arg')?.rawMetadata?.lastUserInputHash).toBeTruthy();
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain('"type":"user-input"');
    db.close();
  });

  it('records pending-session first input when the live bridge submits text through keystrokes', async () => {
    class PendingComposerTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.paneText = [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          `❯ ${text}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        this.paneText = [
          'OpenAI Codex',
          '',
          'Working through the request…',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
      ref: 'pending:keystroke-first-turn',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'codex',
      title: 'New conversation',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: false,
      degraded: false,
      rawMetadata: { pending: true },
    });
    const tmux = new PendingComposerTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:keystroke-first-turn',
      title: 'New conversation',
      kind: 'pending',
    });

    await manager.sendKeystrokes(session.id, { text: 'yes i trust it', keys: ['Enter'] });

    expect(tmux.sent).toEqual(['yes i trust it']);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    expect(db.pendingConversations.get('pending:keystroke-first-turn')?.rawMetadata?.lastUserInputHash).toBeTruthy();
    expect(db.pendingConversations.get('pending:keystroke-first-turn')?.rawMetadata?.lastUserInputPreview).toBe('yes i trust it');
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain('"type":"user-input"');
    db.close();
  });

  it('forces color output for tmux-launched provider sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'conv-color',
      title: 'Color session',
      kind: 'history',
    });

    expect(tmux.createdCommands[0]).toContain('unset CLAUDECODE NO_COLOR');
    expect(tmux.createdCommands[0]).toContain("export FORCE_COLOR='1'");
    expect(tmux.createdCommands[0]).toContain("export CLICOLOR_FORCE='1'");
    db.close();
  });
});
