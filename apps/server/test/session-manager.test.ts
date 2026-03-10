import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import type { TmuxClient } from '../src/sessions/tmux-client.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import type { ActiveProject } from '../src/projects/project-service.js';
import type { MergedProviderSettings } from '../src/config/service.js';

class FakeTmux implements TmuxClient {
  created: string[] = [];
  createdCommands: string[] = [];
  sent: string[] = [];
  sentKeys: string[][] = [];
  alive = new Set<string>();
  failPipePane = false;
  failKill = false;
  paneText = '';
  captureSequence: string[] = [];

  async newDetachedSession(sessionName: string, _cwd: string, shellCommand: string): Promise<void> {
    this.created.push(sessionName);
    this.createdCommands.push(shellCommand);
    this.alive.add(sessionName);
  }
  async pipePaneToFile(): Promise<void> {
    if (this.failPipePane) {
      throw new Error('pipe-pane failed');
    }
  }
  async sendLiteralText(_sessionName: string, text: string): Promise<void> { this.sent.push(text); }
  async sendKeys(_sessionName: string, keys: string[]): Promise<void> { this.sentKeys.push(keys); }
  async sendLiteralInput(_sessionName: string, text: string): Promise<void> { this.sent.push(text); }
  async capturePane(): Promise<string> {
    if (this.captureSequence.length > 0) {
      const next = this.captureSequence.shift();
      if (next !== undefined) {
        this.paneText = next;
      }
    }
    return this.paneText;
  }
  async interrupt(): Promise<void> {}
  async killSession(sessionName: string): Promise<void> {
    if (this.failKill) {
      throw new Error('kill failed');
    }
    this.alive.delete(sessionName);
  }
  async hasSession(sessionName: string): Promise<boolean> { return this.alive.has(sessionName); }
  async getPanePid(): Promise<number | undefined> { return 4242; }
  async setUserOption(): Promise<void> {}
}

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  path: '/srv/demo',
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

const provider: ProviderAdapter = {
  id: 'codex',
  async discoverLocalState() { return {}; },
  async listConversations() { return []; },
  async getConversation() { return null; },
  getLaunchCommand(_project, _conversationRef, _settings, options) {
    return {
      cwd: '/srv/demo',
      argv: ['codex', ...(options?.initialPrompt ? [options.initialPrompt] : [])],
      env: {},
    };
  },
};

const providerSettings = {
  id: 'codex',
  enabled: true,
  discoveryRoot: '/home/user/.codex',
  commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
} satisfies MergedProviderSettings;

describe('SessionManager', () => {
  it('tracks bind → input → release transitions through the database', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'pending:test',
      title: 'New conversation',
      kind: 'pending',
    });

    expect(session.status).toBe('bound');
    await manager.sendInput(session.id, 'Hello agent');
    expect(tmux.sent).toEqual(['Hello agent']);
    expect(tmux.sentKeys).toEqual([]);

    await manager.releaseSession(session.id);
    const ended = db.getBoundSessionById(session.id);
    expect(ended?.status).toBe('ended');
    db.close();
  });

  it('marks failed bind attempts as error and cleans up tmux state', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    tmux.failPipePane = true;
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    await expect(manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-fail',
      title: 'Broken conversation',
      kind: 'history',
    })).rejects.toThrow(/pipe-pane failed/);

    expect(db.listBoundSessions()).toHaveLength(1);
    expect(db.listBoundSessions()[0]?.status).toBe('error');
    expect(tmux.alive.size).toBe(0);
    db.close();
  });

  it('rebinds by creating a new session when the stored tmux session is gone', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const first = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-rebind',
      title: 'Conversation',
      kind: 'history',
    });
    tmux.alive.clear();

    const second = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-rebind',
      title: 'Conversation',
      kind: 'history',
    });

    expect(second.id).not.toBe(first.id);
    expect(tmux.created).toHaveLength(2);
    db.close();
  });

  it('surfaces release failures instead of reporting ended sessions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const tmux = new FakeTmux();
    const manager = new SessionManager(db, tmux, path.join(tempDir, 'runtime'), new RealtimeEventBus());

    const session = await manager.bindConversation({
      project,
      provider,
      providerSettings,
      conversationRef: 'session-release-fail',
      title: 'Conversation',
      kind: 'history',
    });

    tmux.failKill = true;
    await expect(manager.releaseSession(session.id)).rejects.toThrow(/Failed to release/);
    expect(db.getBoundSessionById(session.id)?.status).toBe('error');
    db.close();
  });

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
    const screens: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === 'session.screen-updated') {
        screens.push(event.screen.content);
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
    expect(screens.at(-1)).toContain('❯ 3. Haiku');
    unsubscribe();
    db.close();
  });

  it('launches pending sessions with an initial prompt argument when requested', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.putPendingConversation({
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
    expect(db.getPendingConversation('pending:launch-arg')?.rawMetadata?.lastUserInputHash).toBeTruthy();
    expect(await fs.readFile(session.eventLogPath!, 'utf8')).toContain('"type":"user-input"');
    db.close();
  });
});
