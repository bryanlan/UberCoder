import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionKeystrokeRejectedError, SessionManager } from '../src/sessions/session-manager.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { FakeTmux, claudeProvider, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

describe('SessionManager keystroke submit', () => {
  it('records submitted bypass text only when Enter carries the submitted draft', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
      ref: 'pending:bypass-submit',
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
    const eventBus = new RealtimeEventBus();
    let userInputEvents = 0;
    const userInputMessageIds: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.user-input') {
        userInputEvents += 1;
        userInputMessageIds.push(event.messageId);
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:bypass-submit',
      title: 'New conversation',
      kind: 'pending',
    });

    await manager.sendKeystrokes(session.id, { text: 'hello', deferScreenUpdate: true });
    expect(userInputEvents).toBe(0);
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');

    await manager.sendKeystrokes(session.id, { text: 'hello' });
    expect(userInputEvents).toBe(0);
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');

    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Ready.',
      '❯ hello',
      'gpt-5.4 xhigh · 65% left · ~/demo',
    ].join('\n');
    const result = await manager.sendKeystrokes(session.id, { keys: ['Enter'], submittedText: 'hello' });

    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    const userInputOffset = eventLog.indexOf('{"type":"user-input"');
    const pending = db.pendingConversations.get('pending:bypass-submit');
    expect(userInputEvents).toBe(1);
    expect(result.recordedUserInput).toEqual({
      id: `live:${session.id}:${userInputOffset}`,
      text: 'hello',
      timestamp: result.recordedUserInput?.timestamp,
    });
    expect(userInputMessageIds).toEqual([result.recordedUserInput?.id]);
    expect(eventLog).toContain('"type":"user-input"');
    expect(eventLog).toContain('"text":"hello"');
    expect(pending?.rawMetadata?.lastUserInputPreview).toBe('hello');

    unsubscribe();
    db.close();
  });

  it('records Enter-only submitted text on restored history sessions when the screen repaint is stale', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'We left the usage-tracking work implemented and committed.',
      'Ran git status --short && git log -3 --oneline --decorate',
      '❯ ',
      'gpt-5.4 xhigh · 65% left · ~/demo',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    let userInputEvents = 0;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.user-input') {
        userInputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-stale-bypass-submit',
      title: 'Existing conversation',
      kind: 'history',
    });

    await manager.sendKeystrokes(session.id, { keys: ['Enter'], submittedText: 'recap where we left things' });

    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    expect(tmux.sentKeys).toEqual([['Enter']]);
    expect(userInputEvents).toBe(1);
    expect(eventLog).toContain('"type":"user-input"');
    expect(eventLog).toContain('"text":"recap where we left things"');
    unsubscribe();
    db.close();
  });

  it('does not record bypass slash commands as conversation user input', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
      ref: 'pending:bypass-command',
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
      'Ready.',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    let userInputEvents = 0;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.user-input') {
        userInputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings,
      conversationRef: 'pending:bypass-command',
      title: 'New conversation',
      kind: 'pending',
    });

    await manager.sendKeystrokes(session.id, { text: '/model', deferScreenUpdate: true });
    await manager.sendKeystrokes(session.id, { keys: ['Enter'], submittedText: '/model' });

    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    const pending = db.pendingConversations.get('pending:bypass-command');
    expect(userInputEvents).toBe(0);
    expect(eventLog).not.toContain('"type":"user-input"');
    expect(pending?.rawMetadata?.lastUserInputPreview).toBeUndefined();

    unsubscribe();
    db.close();
  });

  it('does not record draft slash commands as conversation user input', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
      ref: 'pending:draft-command',
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
      'Ready.',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    let userInputEvents = 0;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.user-input') {
        userInputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings,
      conversationRef: 'pending:draft-command',
      title: 'New conversation',
      kind: 'pending',
    });

    await manager.sendKeystrokes(session.id, { text: '/model', keys: ['Enter'], submittedText: '/model' });

    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    const pending = db.pendingConversations.get('pending:draft-command');
    expect(tmux.sent).toEqual(['/model']);
    expect(tmux.sentKeys).toEqual([['Enter']]);
    expect(userInputEvents).toBe(0);
    expect(eventLog).not.toContain('"type":"user-input"');
    expect(pending?.rawMetadata?.lastUserInputPreview).toBeUndefined();

    unsubscribe();
    db.close();
  });

  it('does not record bypass model-menu numeric selections as conversation user input', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
      ref: 'pending:bypass-selection',
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
      '1. Default',
      '2. Opus',
      '3. Sonnet',
      '4. Haiku',
      'Enter to set as default · s to use this session only · Esc to cancel',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    let userInputEvents = 0;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.user-input') {
        userInputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings,
      conversationRef: 'pending:bypass-selection',
      title: 'New conversation',
      kind: 'pending',
    });

    await manager.sendKeystrokes(session.id, { text: '4', deferScreenUpdate: true });
    tmux.paneText = [
      'Claude Code',
      '',
      'Select model',
      '1. Default',
      '2. Opus',
      '3. Sonnet',
      '4. Haiku',
      'Enter to set as default · s to use this session only · Esc to cancel',
    ].join('\n');
    await manager.sendKeystrokes(session.id, { keys: ['Enter'], submittedText: '4' });

    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    const pending = db.pendingConversations.get('pending:bypass-selection');
    expect(userInputEvents).toBe(0);
    expect(eventLog).not.toContain('"type":"user-input"');
    expect(pending?.rawMetadata?.lastUserInputPreview).toBeUndefined();

    unsubscribe();
    db.close();
  });

  it('does not record deferred model-menu selections after the picker closes before Enter', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.pendingConversations.put({
      ref: 'pending:bypass-selection-closed',
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
      '1. Default',
      '2. Opus',
      '3. Sonnet',
      '4. Haiku',
      'Enter to set as default · s to use this session only · Esc to cancel',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    let userInputEvents = 0;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.user-input') {
        userInputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings,
      conversationRef: 'pending:bypass-selection-closed',
      title: 'New conversation',
      kind: 'pending',
    });

    await manager.sendKeystrokes(session.id, { text: '4', deferScreenUpdate: true });
    tmux.paneText = [
      'Claude Code',
      '',
      'Set model to Haiku 4.5 and saved as your default for new sessions',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    await manager.sendKeystrokes(session.id, { keys: ['Enter'], submittedText: '4' });

    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    const pending = db.pendingConversations.get('pending:bypass-selection-closed');
    expect(userInputEvents).toBe(0);
    expect(eventLog).not.toContain('"type":"user-input"');
    expect(pending?.rawMetadata?.lastUserInputPreview).toBeUndefined();

    unsubscribe();
    db.close();
  });

  it('selects Claude resume-from-summary before submitting normal text on an old-session prompt', async () => {
    class ClaudeResumeChoiceTmux extends FakeTmux {
      private resumeChoice = '';
      private draft = '';
      private onResumeChoice = true;

      constructor() {
        super();
        this.paneText = this.renderResumeChoice();
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        if (this.onResumeChoice) {
          this.resumeChoice += text;
          return;
        }
        this.draft += text;
        this.paneText = this.renderComposer(this.draft);
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        if (this.onResumeChoice && this.resumeChoice.trim() === '1') {
          this.onResumeChoice = false;
          this.paneText = this.renderComposer('');
          return;
        }
        if (this.draft) {
          this.draft = '';
          this.paneText = [
            'Claude Code',
            '',
            'Working through the request.',
            '',
            '❯ ',
            '⏵⏵ bypass permissions on (shift+tab to cycle)',
          ].join('\n');
        }
      }

      private renderResumeChoice(): string {
        return [
          'Claude Code',
          '',
          'This session is 22h 53m old and 423.3k tokens.',
          '',
          'Resuming the full session will consume a substantial portion of your usage limits.',
          'We recommend resuming from a summary.',
          '',
          '❯ 1. Resume from summary (recommended)',
          '  2. Resume full session as-is',
          "  3. Don't ask me again",
          '',
          'Enter to confirm · Esc to cancel',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      private renderComposer(input: string): string {
        return [
          'Claude Code',
          '',
          `❯ ${input}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new ClaudeResumeChoiceTmux();
    const eventBus = new RealtimeEventBus();
    let userInputEvents = 0;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.user-input') {
        userInputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings,
      conversationRef: 'session-claude-old-resume-choice',
      title: 'Existing Claude conversation',
      kind: 'history',
    });

    await manager.sendKeystrokes(session.id, {
      text: '2',
      keys: ['Enter'],
      submittedText: '2',
    });

    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    expect(tmux.sent).toEqual(['1', '2']);
    expect(tmux.sentKeys).toEqual([['Enter'], ['Enter']]);
    expect(userInputEvents).toBe(1);
    expect(eventLog).toContain('"type":"user-input"');
    expect(eventLog).toContain('"text":"2"');
    expect(eventLog).not.toContain('"text":"1"');
    unsubscribe();
    db.close();
  });

  it('selects Claude resume-from-summary before sending deferred live-bridge text', async () => {
    const resumeChoice = [
      'Claude Code',
      '',
      'This session is 22h 53m old and 423.3k tokens.',
      '',
      'Resuming the full session will consume a substantial portion of your usage limits.',
      'We recommend resuming from a summary.',
      '',
      '❯ 1. Resume from summary (recommended)',
      '  2. Resume full session as-is',
      "  3. Don't ask me again",
      '',
      'Enter to confirm · Esc to cancel',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const composer = [
      'Claude Code',
      '',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = resumeChoice;
    tmux.captureSequence = [resumeChoice, resumeChoice, composer];
    const eventBus = new RealtimeEventBus();
    let userInputEvents = 0;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.user-input') {
        userInputEvents += 1;
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings,
      conversationRef: 'session-claude-old-resume-live-bridge',
      title: 'Existing Claude conversation',
      kind: 'history',
    });

    await manager.sendKeystrokes(session.id, { text: '2', deferScreenUpdate: true });
    await manager.sendKeystrokes(session.id, { keys: ['Enter'], submittedText: '2' });

    const eventLog = await fs.readFile(session.eventLogPath!, 'utf8');
    expect(tmux.sent).toEqual(['1', '2']);
    expect(tmux.sentKeys).toEqual([['Enter'], ['Enter']]);
    expect(userInputEvents).toBe(1);
    expect(eventLog).toContain('"type":"user-input"');
    expect(eventLog).toContain('"text":"2"');
    expect(eventLog).not.toContain('"text":"1"');
    unsubscribe();
    db.close();
  });

  it('waits for pasted text to settle before sending Enter on combined submit keystrokes', async () => {
    class PasteAwareTmux extends FakeTmux {
      private pasteVisible = false;
      private submitted = false;
      private capturesSincePaste = 0;
      private readonly promptPrefix = [
        'Claude Code',
        '',
        'How is Claude doing this session? (optional)',
        '1: Bad    2: Fine   3: Good   0: Dismiss',
        '',
      ];

      constructor() {
        super();
        this.paneText = this.renderComposer('did yo');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.pasteVisible = false;
        this.capturesSincePaste = 0;
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        if (this.pasteVisible) {
          this.submitted = true;
          this.paneText = [
            ...this.promptPrefix,
            'Working through the request…',
            '• Working (1s • esc to interrupt)',
            '',
            '❯ ',
            '⏵⏵ bypass permissions on (shift+tab to cycle)',
          ].join('\n');
        }
      }

      override async capturePane(): Promise<string> {
        if (!this.submitted && this.sent.length > 0 && !this.pasteVisible) {
          this.capturesSincePaste += 1;
          if (this.capturesSincePaste >= 2) {
            this.pasteVisible = true;
            this.paneText = this.renderComposer('did yo[Pasted text #1 +58 lines]');
          }
        }
        return this.paneText;
      }

      private renderComposer(input: string): string {
        return [
          ...this.promptPrefix,
          `❯ ${input}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new PasteAwareTmux();
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ inputText: string; content: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ inputText: event.screen.inputText, content: event.screen.content });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-paste-submit',
      title: 'Conversation',
      kind: 'history',
    });

    screens.length = 0;
    await manager.sendKeystrokes(session.id, {
      text: 'run this review request',
      keys: ['Enter'],
    });

    expect(tmux.sent).toEqual(['run this review request']);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    expect(screens.some((screen) => screen.inputText === 'did yo[Pasted text #1 +58 lines]')).toBe(true);
    expect(screens.at(-1)?.inputText).toBe('');
    expect(`${screens.at(-1)?.content ?? ''}`).toContain('Working through the request…');
    unsubscribe();
    db.close();
  });

  it('accepts Claude pasted-text placeholders rendered on companion lines before submitting', async () => {
    class ClaudeCompanionPasteTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = this.renderComposer();
      }

      override async pasteText(_sessionName: string, text: string): Promise<void> {
        this.pasted.push(text);
        this.sent.push(text);
        this.paneText = this.renderComposer('⎿ [Pasted text #1 +58 lines]');
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        this.paneText = [
          'Claude Code',
          '',
          'Running the pasted request…',
          '• Working (1s • esc to interrupt)',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      private renderComposer(pastedPlaceholder?: string): string {
        return [
          'Claude Code',
          '',
          'Ready for input.',
          '',
          '❯ ',
          ...(pastedPlaceholder ? [pastedPlaceholder] : []),
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new ClaudeCompanionPasteTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'session-claude-companion-paste',
      title: 'Conversation',
      kind: 'history',
    });

    await manager.sendKeystrokes(session.id, {
      text: 'line one\nline two',
      keys: ['Enter'],
    });

    expect(tmux.pasted).toEqual(['line one\nline two']);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    db.close();
  });

  it('uses bracketed paste for long submitted input', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-long-input',
      title: 'Conversation',
      kind: 'history',
    });

    const longText = 'A'.repeat(1300);
    await manager.sendInput(session.id, longText);

    expect(tmux.pasted).toEqual([longText]);
    expect(tmux.sentKeys).toEqual([['Enter']]);
    db.close();
  });

  it('uses bracketed paste for long bridge text before the submit key', async () => {
    class LongComposerTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          '❯ draft',
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
          `❯ ${this.sent.join('')}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      override async pasteText(_sessionName: string, text: string): Promise<void> {
        this.pasted.push(text);
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
          '• Working (1s • esc to interrupt)',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new LongComposerTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-long-keystrokes',
      title: 'Conversation',
      kind: 'history',
    });

    const longText = 'follow-up '.repeat(180);
    await manager.sendKeystrokes(session.id, { text: longText, keys: ['Enter'] });

    expect(tmux.pasted).toEqual([longText]);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    db.close();
  });

  it('opens the Codex composer before applying a large text-only paste', async () => {
    class QueueMessagePasteTmux extends FakeTmux {
      private stage: 'queue' | 'composer' | 'pasted' = 'queue';

      constructor() {
        super();
        this.paneText = this.renderQueue();
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Tab')) {
          return;
        }
        this.stage = 'composer';
        this.paneText = this.renderComposer('');
      }

      override async pasteText(_sessionName: string, text: string): Promise<void> {
        this.pasted.push(text);
        this.stage = 'pasted';
        this.paneText = this.renderComposer(text);
      }

      private renderQueue(): string {
        return [
          'OpenAI Codex',
          '',
          'Ready when you are.',
          'Tab to queue message',
          'gpt-5.4 xhigh · 88% left · ~/demo',
        ].join('\n');
      }

      private renderComposer(input: string): string {
        return [
          'OpenAI Codex',
          '',
          'Ready when you are.',
          '',
          `❯ ${input}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new QueueMessagePasteTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-queue-paste',
      title: 'Conversation',
      kind: 'history',
    });

    const longText = `${'deep context '.repeat(80)}\n${'follow-up '.repeat(40)}`;
    await manager.sendKeystrokes(session.id, { text: longText });

    expect(tmux.sentKeys).toContainEqual(['Tab']);
    expect(tmux.pasted).toEqual([longText]);
    db.close();
  });

  it('submits very large bridge text directly through bracketed paste', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    class LargeInputTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = this.renderComposer('');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.paneText = this.renderComposer(text);
      }

      override async pasteText(_sessionName: string, text: string): Promise<void> {
        this.pasted.push(text);
        this.sent.push(text);
        this.paneText = this.renderComposer(text);
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        this.paneText = [
          'OpenAI Codex',
          '',
          'Working through the submitted prompt…',
          '• Working (1s • esc to interrupt)',
          '',
          '❯ ',
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }

      private renderComposer(input: string): string {
        return [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          `❯ ${input}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tmux = new LargeInputTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-file-backed-live-input',
      title: 'Conversation',
      kind: 'history',
    });

    const veryLongText = 'long prompt content '.repeat(220);
    await manager.sendKeystrokes(session.id, { text: veryLongText, keys: ['Enter'] });

    expect(tmux.pasted).toEqual([veryLongText]);
    expect(tmux.sent).toEqual([veryLongText]);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    db.close();
  });

  it('waits long enough for slower pasted text repaints before sending Enter', async () => {
    class SlowPasteAwareTmux extends FakeTmux {
      private pasteVisible = false;
      private submitted = false;
      private capturesSincePaste = 0;
      private readonly promptPrefix = [
        'Claude Code',
        '',
        'How is Claude doing this session? (optional)',
        '1: Bad    2: Fine   3: Good   0: Dismiss',
        '',
      ];

      constructor() {
        super();
        this.paneText = this.renderComposer('draft');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.pasteVisible = false;
        this.capturesSincePaste = 0;
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (!keys.includes('Enter')) {
          return;
        }
        if (this.pasteVisible) {
          this.submitted = true;
          this.paneText = [
            ...this.promptPrefix,
            'Running the slower paste submit…',
            '• Working (1s • esc to interrupt)',
            '',
            '❯ ',
            '⏵⏵ bypass permissions on (shift+tab to cycle)',
          ].join('\n');
        }
      }

      override async capturePane(): Promise<string> {
        if (!this.submitted && this.sent.length > 0 && !this.pasteVisible) {
          this.capturesSincePaste += 1;
          if (this.capturesSincePaste >= 19) {
            this.pasteVisible = true;
            this.paneText = this.renderComposer('draft[Pasted text #1 +58 lines]');
          }
        }
        return this.paneText;
      }

      private renderComposer(input: string): string {
        return [
          ...this.promptPrefix,
          `❯ ${input}`,
          '⏵⏵ bypass permissions on (shift+tab to cycle)',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new SlowPasteAwareTmux();
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ inputText: string; content: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ inputText: event.screen.inputText, content: event.screen.content });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-slow-paste-submit',
      title: 'Conversation',
      kind: 'history',
    });

    screens.length = 0;
    await manager.sendKeystrokes(session.id, {
      text: 'large pasted request content that takes longer than the initial repaint budget to appear in the composer',
      keys: ['Enter'],
    });

    expect(tmux.sentKeys).toContainEqual(['Enter']);
    expect(screens.some((screen) => screen.inputText === 'draft[Pasted text #1 +58 lines]')).toBe(true);
    expect(screens.at(-1)?.inputText).toBe('');
    expect(`${screens.at(-1)?.content ?? ''}`).toContain('Running the slower paste submit…');
    unsubscribe();
    db.close();
  });

  it('waits for Codex queue-message mode and opens the composer before typing into a fresh session', async () => {
    class QueueMessageCodexTmux extends FakeTmux {
      private captureCount = 0;
      private stage: 'starting' | 'queue' | 'composer' | 'typed' | 'submitted' = 'starting';

      constructor() {
        super();
        this.paneText = this.renderStarting();
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        expect(this.stage).toBe('composer');
        this.stage = 'typed';
        this.paneText = this.renderComposer(text);
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (keys.includes('Tab')) {
          expect(this.stage).toBe('queue');
          this.stage = 'composer';
          this.paneText = this.renderComposer('');
          return;
        }
        if (keys.includes('Enter')) {
          expect(this.stage).toBe('typed');
          this.stage = 'submitted';
          this.paneText = [
            'OpenAI Codex',
            '',
            'Working through the queued follow-up…',
            '• Working (1s • esc to interrupt)',
            'gpt-5.4 xhigh · 37% left · ~/demo',
          ].join('\n');
        }
      }

      override async capturePane(): Promise<string> {
        this.captureCount += 1;
        if (this.stage === 'starting' && this.captureCount >= 3) {
          this.stage = 'queue';
          this.paneText = this.renderQueue();
        }
        return this.paneText;
      }

      private renderStarting(): string {
        return [
          'OpenAI Codex',
          '',
          'Starting MCP servers (0/3): chrome-devtools, codex_apps, playwright',
        ].join('\n');
      }

      private renderQueue(): string {
        return [
          'OpenAI Codex',
          '',
          'Resumed conversation.',
          '',
          'tab to queue message                                        37% context left',
        ].join('\n');
      }

      private renderComposer(input: string): string {
        return [
          'OpenAI Codex',
          '',
          'Resumed conversation.',
          '',
          `› ${input}`,
          'gpt-5.4 xhigh · 37% left · ~/demo',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new QueueMessageCodexTmux();
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ inputText: string; status: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ inputText: event.screen.inputText, status: event.screen.status });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-queue-message',
      title: 'Conversation',
      kind: 'history',
    });

    screens.length = 0;
    await manager.sendKeystrokes(session.id, {
      text: 'follow up on the failed Vite restart',
      keys: ['Enter'],
    });

    expect(tmux.sent).toEqual(['follow up on the failed Vite restart']);
    expect(tmux.sentKeys).toContainEqual(['Tab']);
    expect(tmux.sentKeys).toContainEqual(['Enter']);
    expect(screens.some((screen) => screen.inputText === 'follow up on the failed Vite restart')).toBe(true);
    expect(screens.at(-1)?.status).toContain('37% left');
    unsubscribe();
    db.close();
  });

  it('rejects combined submit keystrokes when typed text never lands in the live input buffer', async () => {
    class InputRejectingTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = [
          'OpenAI Codex',
          '',
          '1. review the issue',
          '2. patch the behavior',
          '3. rerun the targeted tests',
          '',
          'Message: fix live session reliability and sidebar state',
          '',
          'I left the unrelated local edits in localhost-proxy.ts and vite.config.ts',
          'unstaged and out of this commit.',
          '',
          '› Run /review on my current changes',
          '',
          '  Message: fix live session reliability and sidebar state',
          '',
          '  I left the unrelated local edits in localhost-proxy.ts and vite.config.ts',
          '  unstaged and out of this commit.',
          'gpt-5.4 xhigh · 65% left · ~/demo',
        ].join('\n');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
        this.paneText = [
          'OpenAI Codex',
          '',
          'Message: fix live session reliability and sidebar state',
          '',
          'I left the unrelated local edits in localhost-proxy.ts and vite.config.ts',
          'unstaged and out of this commit.',
          '',
          text,
          'gpt-5.4 xhigh · 65% left · ~/demo',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new InputRejectingTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-input-rejected',
      title: 'Conversation',
      kind: 'history',
    });

    await expect(manager.sendKeystrokes(session.id, {
      text: 'this should stay local until the session accepts input',
      keys: ['Enter'],
    })).rejects.toThrow(SessionKeystrokeRejectedError);
    expect(tmux.sentKeys).toEqual([]);
    db.close();
  });

  it('rejects explicit submitted text when the terminal never accepts the typed input', async () => {
    const submittedText = 'this should not submit if screen capture never shows it';

    class StaleRepaintTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          '› ',
          'gpt-5.4 xhigh · 65% left · ~/demo',
        ].join('\n');
      }

      override async sendLiteralText(_sessionName: string, text: string): Promise<void> {
        this.sent.push(text);
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new StaleRepaintTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-input-stale-repaint-submit',
      title: 'Conversation',
      kind: 'history',
    });

    await expect(manager.sendKeystrokes(session.id, {
      text: submittedText,
      keys: ['Enter'],
      submittedText,
    })).rejects.toThrow(SessionKeystrokeRejectedError);

    expect(tmux.sent).toEqual([submittedText]);
    expect(tmux.sentKeys).toEqual([]);
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).not.toContain('"type":"user-input"');
    db.close();
  });

  it('submits an already-visible live draft without retyping it first', async () => {
    const draft = 'Live session did not accept the typed text into its input buffer. The draft was not submitted';

    class VisibleDraftTmux extends FakeTmux {
      constructor() {
        super();
        this.paneText = this.renderComposer(draft);
      }

      override async sendKeys(_sessionName: string, keys: string[]): Promise<void> {
        this.sentKeys.push(keys);
        if (keys.includes('Enter')) {
          this.paneText = [
            'OpenAI Codex',
            '',
            'Working',
            '',
            '❯ ',
            'gpt-5.4 xhigh · 65% left · ~/demo',
          ].join('\n');
        }
      }

      private renderComposer(text: string): string {
        return [
          'OpenAI Codex',
          '',
          'Ready for input.',
          '',
          `❯ ${text}`,
          'gpt-5.4 xhigh · 65% left · ~/demo',
        ].join('\n');
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new VisibleDraftTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-visible-draft-submit',
      title: 'Conversation',
      kind: 'history',
    });

    await manager.sendKeystrokes(session.id, {
      text: draft,
      keys: ['Enter'],
    });

    expect(tmux.sent).toEqual([]);
    expect(tmux.pasted).toEqual([]);
    expect(tmux.sentKeys).toEqual([['Enter']]);
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain(draft);
    db.close();
  });

  it('waits for a visible screen change after special-key input before emitting the update', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      '  1. Default',
      '❯ 2. Sonnet',
      'Enter to confirm · Esc to exit',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ content: string; status: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ content: event.screen.content, status: event.screen.status });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-key-change',
      title: 'Conversation',
      kind: 'history',
    });

    tmux.captureSequence = [
      tmux.paneText,
      [
        'Claude Code',
        '',
        '  1. Default',
        '  2. Sonnet',
        '❯ 3. Haiku',
        'Enter to confirm · Esc to exit',
      ].join('\n'),
    ];

    await manager.sendKeystrokes(session.id, { keys: ['Down'] });

    expect(tmux.sentKeys).toContainEqual(['Down']);
    expect(`${screens.at(-1)?.content ?? ''}\n${screens.at(-1)?.status ?? ''}`).toContain('❯ 3. Haiku');
    unsubscribe();
    db.close();
  });

  it('publishes the settled post-keystroke screen even when the immediate wait window misses the repaint', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const initialScreen = [
      'Claude Code',
      '',
      'Draft prompt still in composer',
      '› summarize the timing bug',
      'Enter to confirm · Esc to exit',
    ].join('\n');
    const settledScreen = [
      'Claude Code',
      '',
      'Working through the timing bug…',
      '• Working (2s • esc to interrupt)',
      'Enter to confirm · Esc to exit',
    ].join('\n');
    tmux.paneText = initialScreen;
    const eventBus = new RealtimeEventBus();
    const screens: Array<{ inputText: string; content: string }> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push({ inputText: event.screen.inputText, content: event.screen.content });
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-key-settled-screen',
      title: 'Conversation',
      kind: 'history',
    });

    screens.length = 0;
    tmux.captureSequence = [
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      initialScreen,
      settledScreen,
    ];

    await manager.sendKeystrokes(session.id, { keys: ['Enter'] });

    expect(screens.at(-1)?.inputText).toBe('');
    expect(`${screens.at(-1)?.content ?? ''}`).toContain('Working through the timing bug…');
    unsubscribe();
    db.close();
  });

});
