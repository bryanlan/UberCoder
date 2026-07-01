import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionKeystrokeRejectedError, SessionManager } from '../src/sessions/session-manager.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { FakeTmux, claudeProvider, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

describe('SessionManager keystrokes', () => {
  it('sends raw keystrokes directly to the tmux session without synthesizing chat input', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Select model',
      'Enter to confirm · Esc to exit',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-keys',
      title: 'Conversation',
      kind: 'history',
    });

    await manager.sendKeystrokes(session.id, { text: '3', keys: ['Enter'] });

    expect(tmux.sent).toEqual(['3']);
    expect(tmux.sentKeys).toEqual([['Enter']]);
    db.close();
  });

  it('does not record pending first input for literal selection keystrokes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:selection-keystroke',
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
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Select Model and Effort',
      '› 1. gpt-5.5 (current)',
      '  2. gpt-5.4',
      '  3. gpt-5.4-mini',
      'Press enter to confirm or esc to go back',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:selection-keystroke',
      title: 'New conversation',
      kind: 'pending',
    });

    expect(await manager.allowsLiteralSelectionKeystroke(session.id, '1')).toBe(true);
    expect(await manager.allowsLiteralSelectionKeystroke(session.id, '3')).toBe(true);
    expect(await manager.allowsLiteralSelectionKeystroke(session.id, 'help')).toBe(false);

    await manager.sendKeystrokes(session.id, { text: '1', keys: ['Enter'] });

    const pending = db.getPendingConversation('pending:selection-keystroke');
    expect(tmux.sent).toEqual(['1']);
    expect(tmux.sentKeys).toEqual([['Enter']]);
    expect(pending?.rawMetadata?.lastUserInputHash).toBeUndefined();
    expect(pending?.rawMetadata?.lastUserInputPreview).toBeUndefined();
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');
    db.close();
  });

  it('does not record pending first input for Claude model picker keystrokes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:claude-model-selection',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'claude',
      title: 'New conversation',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: false,
      degraded: false,
      rawMetadata: { pending: true },
    });
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Select model',
      '  3. Sonnet',
      '  4. Haiku',
      'Enter to set as default · s to use this session only · Esc to cancel',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'pending:claude-model-selection',
      title: 'New conversation',
      kind: 'pending',
    });

    expect(await manager.allowsLiteralSelectionKeystroke(session.id, '4')).toBe(true);

    await manager.sendKeystrokes(session.id, { text: '4', keys: ['Enter'] });

    const pending = db.getPendingConversation('pending:claude-model-selection');
    expect(tmux.sent).toEqual(['4']);
    expect(tmux.sentKeys).toEqual([['Enter']]);
    expect(pending?.rawMetadata?.lastUserInputHash).toBeUndefined();
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');
    db.close();
  });

  it('does not record pending first input for text-only literal selection chunks', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
      ref: 'pending:text-only-selection',
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
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Select model',
      'Enter to confirm · Esc to exit',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:text-only-selection',
      title: 'New conversation',
      kind: 'pending',
    });

    await manager.sendKeystrokes(session.id, { text: '1', deferScreenUpdate: true });
    await manager.sendKeystrokes(session.id, { keys: ['Enter'] });

    const pending = db.getPendingConversation('pending:text-only-selection');
    expect(tmux.sent).toEqual(['1']);
    expect(tmux.sentKeys).toEqual([['Enter']]);
    expect(pending?.rawMetadata?.lastUserInputHash).toBeUndefined();
    expect(pending?.rawMetadata?.lastUserInputPreview).toBeUndefined();
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');
    db.close();
  });

  it('records numeric user replies when previous output contains numbered choices', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Choose the next step:',
      '1. Run the targeted tests',
      '2. Inspect the debug logs',
      'gpt-5.4 xhigh · 65% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-short-reply',
      title: 'Conversation',
      kind: 'history',
    });

    expect(await manager.allowsLiteralSelectionKeystroke(session.id, '2')).toBe(false);

    await manager.sendKeystrokes(session.id, { text: '2', keys: ['Enter'] });

    expect(tmux.sent).toEqual(['2']);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    expect(eventLog).toContain('"type":"user-input"');
    expect(eventLog).toContain('"text":"2"');
    db.close();
  });

  it('avoids extra pane captures for text-only keystroke sends', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Prompt body',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings,
      conversationRef: 'session-text-only-fast-path',
      title: 'Conversation',
      kind: 'history',
    });

    tmux.captureStartLines.length = 0;
    await manager.sendKeystrokes(session.id, { text: '5' });

    expect(tmux.sent).toEqual(['5']);
    expect(tmux.sentKeys).toEqual([]);
    expect(tmux.captureStartLines).toHaveLength(1);
    db.close();
  });

  it('defers screen captures while streaming buffered text bypass chunks', async () => {
    class DeferredTypingTmux extends FakeTmux {
      draft = '';

      renderDraft(text: string): string {
        return [
          'OpenAI Codex',
          '',
          'Ready when you are.',
          '',
          `❯ ${text}`,
          'gpt-5.4 xhigh · 88% left · ~/demo',
        ].join('\n');
      }

      override async sendLiteralText(sessionName: string, text: string): Promise<void> {
        await super.sendLiteralText(sessionName, text);
        this.draft += text;
        this.paneText = this.renderDraft(this.draft);
      }

      override async sendKeys(sessionName: string, keys: string[]): Promise<void> {
        await super.sendKeys(sessionName, keys);
        if (keys.includes('Enter')) {
          const staleTypedScreen = this.renderDraft(this.draft);
          this.draft = '';
          this.captureSequence.push(staleTypedScreen, this.renderDraft(''));
        }
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new DeferredTypingTmux();
    tmux.paneText = tmux.renderDraft('');
    const eventBus = new RealtimeEventBus();
    let screenUpdates = 0;
    let userInputEvents = 0;
    const screenUpdateInputTexts: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screenUpdates += 1;
        screenUpdateInputTexts.push(event.screen.inputText);
      }
      if (event.type === 'session.user-input') {
        userInputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-deferred-text-bypass',
      title: 'Conversation',
      kind: 'history',
    });

    screenUpdates = 0;
    tmux.captureStartLines.length = 0;
    await manager.sendKeystrokes(session.id, { text: 'a', deferScreenUpdate: true });
    await manager.sendKeystrokes(session.id, { text: 'b', deferScreenUpdate: true });

    expect(tmux.sent).toEqual(['a', 'b']);
    expect(tmux.captureStartLines).toHaveLength(1);
    expect(screenUpdates).toBe(0);
    expect(userInputEvents).toBe(0);
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');

    await manager.sendKeystrokes(session.id, { keys: ['Enter'] });
    const capturesAfterEnter = tmux.captureStartLines.length;
    expect(screenUpdateInputTexts).not.toContain('ab');
    expect(screenUpdateInputTexts.at(-1)).toBe('');

    await manager.sendKeystrokes(session.id, { text: 'c', deferScreenUpdate: true });
    expect(tmux.sent).toEqual(['a', 'b', 'c']);
    expect(tmux.captureStartLines).toHaveLength(capturesAfterEnter + 1);
    expect(userInputEvents).toBe(0);
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');

    unsubscribe();
    db.close();
  });

});
