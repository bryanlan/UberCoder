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
  sent: string[] = [];
  alive = new Set<string>();
  failPipePane = false;
  failKill = false;

  async newDetachedSession(sessionName: string): Promise<void> {
    this.created.push(sessionName);
    this.alive.add(sessionName);
  }
  async pipePaneToFile(): Promise<void> {
    if (this.failPipePane) {
      throw new Error('pipe-pane failed');
    }
  }
  async sendLiteralInput(_sessionName: string, text: string): Promise<void> { this.sent.push(text); }
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
  getLaunchCommand() {
    return { cwd: '/srv/demo', argv: ['codex'], env: {} };
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
});
