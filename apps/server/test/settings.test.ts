import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

async function setup(): Promise<{ configPath: string; root: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-settings-'));
  const root = path.join(tempDir, 'projects');
  await fs.mkdir(path.join(root, 'demo', 'app'), { recursive: true });
  await fs.mkdir(path.join(root, 'alpha', 'service'), { recursive: true });
  await fs.writeFile(path.join(root, 'demo', 'app', 'AGENTS.md'), '# demo');
  await fs.writeFile(path.join(root, 'alpha', 'service', 'claude.md'), '# alpha');
  await fs.writeFile(path.join(root, 'README.txt'), 'not a directory');
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    server: {
      host: '127.0.0.1',
      port: 4317,
      webDistPath: '../web/dist',
    },
    projectsRoot: root,
    runtimeDir: path.join(tempDir, 'runtime'),
    databasePath: path.join(tempDir, 'agent-console.sqlite'),
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
        discoveryRoot: '~/.codex',
        commands: {
          newCommand: ['codex'],
          resumeCommand: ['codex', 'resume', '{{conversationId}}'],
          continueCommand: ['codex', 'resume', '--last'],
          env: {},
        },
      },
      claude: {
        enabled: true,
        discoveryRoot: '~/.claude',
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
        path: path.join(root, 'demo', 'app'),
        displayName: 'Demo',
        allowedLocalhostPorts: [3000],
        tags: ['primary'],
        notes: 'old notes',
      },
    },
  }, null, 2));
  return { configPath, root };
}

describe('settings routes', () => {
  it('returns, creates, updates, and deletes explicit project settings', async () => {
    const expectedAgentConsolePath = path.resolve(process.cwd(), '../..');
    const { configPath, root } = await setup();
    const { app } = await buildApp({ configPath });
    await app.ready();

    try {
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'agent-console-demo' },
      });
      expect(loginResponse.statusCode).toBe(200);

      const csrfToken = loginResponse.json().csrfToken as string;
      const cookie = loginResponse.headers['set-cookie'];
      expect(csrfToken).toBeTruthy();
      expect(cookie).toBeTruthy();

      const before = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { cookie },
      });
      expect(before.statusCode).toBe(200);
      expect(before.json().agentConsolePath).toBe(expectedAgentConsolePath);
      expect(before.json().projects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          directoryName: 'demo',
          active: true,
          allowedLocalhostPorts: [3000],
          path: path.join(root, 'demo', 'app'),
        }),
      ]));

      const directories = await app.inject({
        method: 'GET',
        url: `/api/settings/directories?path=${encodeURIComponent(root)}`,
        headers: { cookie },
      });
      expect(directories.statusCode).toBe(200);
      expect(directories.json()).toMatchObject({
        currentPath: root,
        directories: [
          { name: 'alpha', path: path.join(root, 'alpha'), isSymlink: false },
          { name: 'demo', path: path.join(root, 'demo'), isSymlink: false },
        ],
      });

      const create = await app.inject({
        method: 'POST',
        url: '/api/settings/projects',
        headers: {
          cookie,
          'x-csrf-token': csrfToken,
        },
        payload: {
          path: path.join(root, 'alpha', 'service'),
        },
      });
      expect(create.statusCode).toBe(200);
      expect(create.json().project).toMatchObject({
        directoryName: 'alpha--service',
        active: true,
        path: path.join(root, 'alpha', 'service'),
      });

      const update = await app.inject({
        method: 'PUT',
        url: '/api/settings/projects/demo',
        headers: {
          cookie,
          'x-csrf-token': csrfToken,
        },
        payload: {
          active: false,
          displayName: 'Demo Updated',
          allowedLocalhostPorts: [5173, 3000, 5173],
          tags: ['secondary', 'secondary'],
          notes: '',
        },
      });
      expect(update.statusCode).toBe(200);

      expect(update.json().project).toMatchObject({
        directoryName: 'demo',
        active: false,
        displayName: 'Demo Updated',
        allowedLocalhostPorts: [3000, 5173],
        tags: ['secondary'],
        path: path.join(root, 'demo', 'app'),
      });

      const after = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { cookie },
      });
      expect(after.statusCode).toBe(200);
      expect(after.json().projects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          directoryName: 'demo',
          active: false,
          displayName: 'Demo Updated',
          allowedLocalhostPorts: [3000, 5173],
          tags: ['secondary'],
          path: path.join(root, 'demo', 'app'),
        }),
        expect.objectContaining({
          directoryName: 'alpha--service',
          path: path.join(root, 'alpha', 'service'),
        }),
      ]));

      const remove = await app.inject({
        method: 'DELETE',
        url: '/api/settings/projects/alpha--service',
        headers: {
          cookie,
          'x-csrf-token': csrfToken,
        },
      });
      expect(remove.statusCode).toBe(204);

      const globalUpdate = await app.inject({
        method: 'PUT',
        url: '/api/settings/global',
        headers: {
          cookie,
          'x-csrf-token': csrfToken,
        },
        payload: {
          projectsRoot: '/srv/projects',
          serverHost: '0.0.0.0',
          serverPort: 9999,
          sessionTtlHours: 48,
          cookieSecure: true,
          trustTailscaleHeaders: true,
        },
      });
      expect(globalUpdate.statusCode).toBe(200);
      expect(globalUpdate.json()).toMatchObject({
        restartRequired: true,
        settings: {
          agentConsolePath: expectedAgentConsolePath,
          projectsRoot: '/srv/projects',
          serverHost: '0.0.0.0',
          serverPort: 9999,
          security: {
            cookieSecure: true,
            trustTailscaleHeaders: true,
            sessionTtlHours: 48,
          },
        },
      });
    } finally {
      await app.close();
    }
  });
});
