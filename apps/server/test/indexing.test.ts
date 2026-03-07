import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../src/providers/types.js';
import { AppDatabase } from '../src/db/database.js';
import { IndexingService } from '../src/indexing/indexing-service.js';
import { RealtimeEventBus } from '../src/realtime/event-bus.js';
import type { ActiveProject } from '../src/projects/project-service.js';

const project: ActiveProject = {
  slug: 'demo',
  directoryName: 'demo',
  displayName: 'Demo',
  path: '/tmp/demo-project',
  allowedLocalhostPorts: [],
  tags: [],
  config: { active: true, displayName: 'Demo', allowedLocalhostPorts: [], tags: [], providers: {} },
};

const conversation = {
  ref: 'real-session',
  kind: 'history' as const,
  projectSlug: 'demo',
  provider: 'codex' as const,
  title: 'Real session',
  createdAt: '2026-03-07T00:01:00.000Z',
  updatedAt: '2026-03-07T00:01:00.000Z',
  isBound: false,
  degraded: false,
};

const provider: ProviderAdapter = {
  id: 'codex',
  async discoverLocalState() { return {}; },
  async listConversations() { return [conversation]; },
  async getConversation() { return null; },
  getLaunchCommand() {
    return { cwd: project.path, argv: ['codex'], env: {} };
  },
};

describe('IndexingService', () => {
  it('adopts pending refs into already indexed vendor conversations on a later refresh', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-indexing-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    db.replaceConversationIndex('demo', 'codex', [conversation]);
    db.putPendingConversation({
      ref: 'pending:test',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'codex',
      title: 'Pending session',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
      isBound: true,
      boundSessionId: 'session-1',
      degraded: false,
    });
    db.upsertBoundSession({
      id: 'session-1',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'pending:test',
      tmuxSessionName: 'tmux-demo',
      status: 'bound',
      title: 'Pending session',
      startedAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
    });

    const indexing = new IndexingService(
      { getProjectsRoot: () => tempDir } as never,
      {
        listActiveProjects: async () => [project],
        getMergedProviderSettings: (_project: ActiveProject, providerId: 'codex' | 'claude') => ({
          enabled: providerId === 'codex',
          discoveryRoot: tempDir,
          commands: { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], continueCommand: ['codex', 'resume', '--last'], env: {} },
        }),
      } as never,
      { get: () => provider } as never,
      db,
      new RealtimeEventBus(),
    );

    await indexing.refreshAll();

    expect(db.getPendingConversation('pending:test')?.rawMetadata?.adoptedConversationRef).toBe('real-session');
    expect(db.getPendingConversation('pending:test')?.isBound).toBe(false);
    expect(db.getBoundSessionById('session-1')?.conversationRef).toBe('real-session');
    db.close();
  });
});
