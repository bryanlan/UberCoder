import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AppDatabase } from '../src/db/database.js';

async function setup(): Promise<{ configPath: string; databasePath: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-conversations-'));
  const root = path.join(tempDir, 'projects');
  const databasePath = path.join(tempDir, 'agent-console.sqlite');
  await fs.mkdir(path.join(root, 'demo'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'codex-home'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'claude-home'), { recursive: true });

  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    server: {
      host: '127.0.0.1',
      port: 4317,
      webDistPath: '../web/dist',
    },
    projectsRoot: root,
    runtimeDir: path.join(tempDir, 'runtime'),
    databasePath,
    security: {
      passwordHash: 'scrypt:e63f79449b39327540c914ce72df7fd8:8b59c3daf10c16c5ea0c645aea6e47c7ede25beb73c167852b1cbbdf5d4bdad218bc4f25193ebfe2f29779e5d7cc995b890a6b46ea9c4c5096973b301087e4bc',
      sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      cookieSecure: false,
      sessionTtlHours: 24,
      loginRateLimitMax: 10,
      loginRateLimitWindowMs: 900000,
      trustTailscaleHeaders: false,
    },
    providers: {
      codex: {
        enabled: true,
        discoveryRoot: path.join(tempDir, 'codex-home'),
        commands: {
          newCommand: ['codex'],
          resumeCommand: ['codex', 'resume', '{{conversationId}}'],
          continueCommand: ['codex', 'resume', '--last'],
          env: {},
        },
      },
      claude: {
        enabled: true,
        discoveryRoot: path.join(tempDir, 'claude-home'),
        commands: {
          newCommand: ['claude'],
          resumeCommand: ['claude', '--resume', '{{conversationId}}'],
          continueCommand: ['claude', '--continue'],
          env: {},
        },
      },
    },
    projects: {
      demo: {
        active: true,
        displayName: 'Demo',
        allowedLocalhostPorts: [],
        tags: [],
      },
    },
  }, null, 2));

  return { configPath, databasePath };
}

describe('conversation rename routes', () => {
  it('renames indexed and pending conversations without mutating provider transcripts', async () => {
    const { configPath, databasePath } = await setup();
    const { app } = await buildApp({ configPath });
    await app.ready();

    const seedDb = new AppDatabase(databasePath);
    seedDb.replaceConversationIndex('demo', 'codex', [
      {
        ref: 'history-1',
        kind: 'history',
        projectSlug: 'demo',
        provider: 'codex',
        title: 'Original history title',
        updatedAt: '2026-03-10T00:00:00.000Z',
        isBound: false,
        degraded: false,
      },
    ]);
    seedDb.putPendingConversation({
      ref: 'pending:test',
      kind: 'pending',
      projectSlug: 'demo',
      provider: 'claude',
      title: 'New Claude conversation',
      createdAt: '2026-03-10T00:01:00.000Z',
      updatedAt: '2026-03-10T00:01:00.000Z',
      isBound: false,
      degraded: false,
      rawMetadata: {
        pending: true,
      },
    });
    seedDb.close();

    try {
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'agent-console-demo' },
      });
      expect(loginResponse.statusCode).toBe(200);

      const csrfToken = loginResponse.json().csrfToken as string;
      const cookie = loginResponse.headers['set-cookie'];

      const renameHistory = await app.inject({
        method: 'PUT',
        url: '/api/conversations/demo/codex/history-1/title',
        headers: {
          cookie,
          'x-csrf-token': csrfToken,
        },
        payload: {
          title: 'Renamed history title',
        },
      });
      expect(renameHistory.statusCode).toBe(200);
      expect(renameHistory.json().conversation).toMatchObject({
        ref: 'history-1',
        title: 'Renamed history title',
      });

      const renamePending = await app.inject({
        method: 'PUT',
        url: '/api/conversations/demo/claude/pending%3Atest/title',
        headers: {
          cookie,
          'x-csrf-token': csrfToken,
        },
        payload: {
          title: 'Renamed pending title',
        },
      });
      expect(renamePending.statusCode).toBe(200);
      expect(renamePending.json().conversation).toMatchObject({
        ref: 'pending:test',
        title: 'Renamed pending title',
      });

      const tree = await app.inject({
        method: 'GET',
        url: '/api/projects/tree',
        headers: { cookie },
      });
      expect(tree.statusCode).toBe(200);
      expect(tree.json().projects[0].providers.codex.conversations[0].title).toBe('Renamed history title');
      expect(tree.json().projects[0].providers.claude.conversations[0].title).toBe('Renamed pending title');

      const historyTimeline = await app.inject({
        method: 'GET',
        url: '/api/conversations/demo/codex/history-1/messages',
        headers: { cookie },
      });
      expect(historyTimeline.statusCode).toBe(200);
      expect(historyTimeline.json().conversation.title).toBe('Renamed history title');

      const pendingTimeline = await app.inject({
        method: 'GET',
        url: '/api/conversations/demo/claude/pending%3Atest/messages',
        headers: { cookie },
      });
      expect(pendingTimeline.statusCode).toBe(200);
      expect(pendingTimeline.json().conversation.title).toBe('Renamed pending title');
    } finally {
      await app.close();
    }
  });
});
