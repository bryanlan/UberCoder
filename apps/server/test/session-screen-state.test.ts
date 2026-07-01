import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionKeystrokeRejectedError, SessionManager } from '../src/sessions/session-manager.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { FakeTmux, claudeProvider, createRecoveryManager, project, provider, providerSettings } from './helpers/session-fixtures.js';

describe('SessionManager screen state', () => {
  it('captures a live screen snapshot for bound sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Reviewing repository state…',
      'Applying patch…',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-screen',
      title: 'Conversation',
      kind: 'history',
    });

    const liveScreen = await manager.getSessionScreen(session.id);
    expect(liveScreen?.screen.content).toContain('Reviewing repository state…');
    expect(liveScreen?.screen.status).toContain('98% left');
    db.close();
  });

  it('captures deeper live screen scrollback when a start line is requested', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Earlier output line',
      'Most recent output line',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-screen-scrollback',
      title: 'Conversation',
      kind: 'history',
    });

    const liveScreen = await manager.getSessionScreen(session.id, { startLine: -800 });
    expect(tmux.captureStartLines.at(-1)).toBe(-800);
    expect(liveScreen?.screen.content).toContain('Earlier output line');
    db.close();
  });

  it('adds the Claude bypass-permissions badge to live status', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      'Reviewing repository state…',
      '96% left · ~/demo',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'claude-screen',
      title: 'Conversation',
      kind: 'history',
    });

    const liveScreen = await manager.getSessionScreen(session.id);
    expect(liveScreen?.screen.status).toContain('bypass permissions on');
    expect(liveScreen?.screen.status).toContain('96% left');
    db.close();
  });

  it('recovers the Claude model from session logs when the visible screen header has scrolled away', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'Claude Code',
      '',
      '● CLAUDE_FINAL_CLEAN_OK',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────────────',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n');
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider: claudeProvider,
      providerSettings: { ...providerSettings, id: 'claude' },
      conversationRef: 'pending:claude-model-from-log',
      title: 'Conversation',
      kind: 'pending',
    });
    db.pendingConversations.put({
      ref: 'pending:claude-model-from-log',
      kind: 'pending',
      projectSlug: project.slug,
      provider: 'claude',
      title: 'Conversation',
      createdAt: '2026-07-01T03:45:00.000Z',
      updatedAt: '2026-07-01T03:45:00.000Z',
      isBound: true,
      boundSessionId: session.id,
      degraded: false,
      rawMetadata: {},
    });
    await fs.writeFile(session.rawLogPath!, '  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions\n');

    const liveScreen = await manager.getSessionScreen(session.id);
    expect(liveScreen?.screen.model).toBe('Haiku 4.5');
    expect(liveScreen?.screen.status).toContain('bypass permissions on');
    expect(db.pendingConversations.get('pending:claude-model-from-log')?.rawMetadata?.lastLiveModel).toBe('Haiku 4.5');

    await fs.writeFile(session.rawLogPath!, '');
    const restoredFromMetadata = await manager.getSessionScreen(session.id);
    expect(restoredFromMetadata?.screen.model).toBe('Haiku 4.5');
    db.close();
  });

  it('emits visible screen updates when bound session output changes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Thinking about the repository…',
      'gpt-5.4 medium · 98% left · ~/demo',
    ].join('\n');
    const eventBus = new RealtimeEventBus();
    const events: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        events.push(event.screen.content);
      }
    });
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), eventBus);

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-screen-events',
      title: 'Conversation',
      kind: 'history',
    });

    tmux.paneText = [
      'OpenAI Codex',
      '',
      'Thinking about the repository…',
      'Applying patch now…',
      'gpt-5.4 medium · 97% left · ~/demo',
    ].join('\n');
    await manager.sendInput(session.id, 'continue');

    expect(events.at(-1)).toContain('Applying patch now…');
    unsubscribe();
    db.close();
  });

});
