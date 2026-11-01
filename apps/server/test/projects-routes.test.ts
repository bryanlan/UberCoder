import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { registerProjectRoutes } from '../src/routes/projects.js';

describe('project routes', () => {
  it('serves the project tree immediately while coalescing background session observation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T12:00:00.000Z'));

    let observed = false;
    let resolveObservation: (() => void) | undefined;
    const observationGate = new Promise<void>((resolve) => {
      resolveObservation = () => {
        observed = true;
        resolve();
      };
    });
    const observeSessions = vi.fn(async () => {
      await observationGate;
    });

    const app = fastify();
    await registerProjectRoutes(
      app,
      {
        ensureAuthenticated: async () => undefined,
      } as never,
      {
        getTree: () => ({
          projects: [],
          boundSessions: [],
          lastIndexedAt: observed ? 'fresh' : 'stale',
        }),
        refreshAll: async () => undefined,
      } as never,
      {
        observeSessions,
      } as never,
      [],
    );
    await app.ready();

    try {
      const firstTree = app.inject({ method: 'GET', url: '/api/projects/tree' });
      await Promise.resolve();
      const secondTree = app.inject({ method: 'GET', url: '/api/projects/tree' });
      await Promise.resolve();

      vi.setSystemTime(new Date('2026-03-14T12:00:06.000Z'));
      const thirdTree = app.inject({ method: 'GET', url: '/api/projects/tree' });
      await Promise.resolve();

      expect(observeSessions).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(observeSessions).toHaveBeenCalledTimes(1);

      resolveObservation?.();

      const [firstResponse, secondResponse, thirdResponse] = await Promise.all([firstTree, secondTree, thirdTree]);

      expect(firstResponse.statusCode).toBe(200);
      expect(secondResponse.statusCode).toBe(200);
      expect(thirdResponse.statusCode).toBe(200);
      expect(firstResponse.json().lastIndexedAt).toBe('stale');
      expect(secondResponse.json().lastIndexedAt).toBe('stale');
      expect(thirdResponse.json().lastIndexedAt).toBe('stale');
      expect(observeSessions).toHaveBeenCalledTimes(1);

      await Promise.resolve();
      const freshResponse = await app.inject({ method: 'GET', url: '/api/projects/tree' });
      expect(freshResponse.statusCode).toBe(200);
      expect(freshResponse.json().lastIndexedAt).toBe('fresh');
      expect(observeSessions).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });

  it('auto-tracks only recent unbound Codex conversations', async () => {
    const nowMs = Date.now();
    const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
    const refreshAll = vi.fn(async () => undefined);
    const observeSessions = vi.fn(async () => undefined);
    const autoTrackConversations = vi.fn(async (conversations: unknown[], _autoTrackedAt?: string) => ({
      attempted: conversations.length,
      tracked: [],
      failed: [],
    }));
    const conversation = (input: {
      ref: string;
      provider: 'codex' | 'claude';
      updatedAt: string;
      isBound?: boolean;
      degraded?: boolean;
    }) => ({
      ref: input.ref,
      kind: 'history' as const,
      projectSlug: 'demo',
      provider: input.provider,
      title: input.ref,
      updatedAt: input.updatedAt,
      isBound: input.isBound ?? false,
      degraded: input.degraded ?? false,
    });
    const tree = {
      projects: [{
        slug: 'demo',
        directoryName: 'demo',
        displayName: 'Demo',
        path: '/srv/demo',
        tags: [],
        allowedLocalhostPorts: [],
        providers: {
          codex: {
            id: 'codex' as const,
            label: 'Codex',
            conversations: [
              conversation({ ref: 'recent-codex', provider: 'codex', updatedAt: iso(-5 * 60 * 60 * 1000) }),
              conversation({ ref: 'already-bound', provider: 'codex', updatedAt: iso(-60 * 60 * 1000), isBound: true }),
              conversation({ ref: 'degraded', provider: 'codex', updatedAt: iso(-60 * 60 * 1000), degraded: true }),
            ],
          },
          claude: {
            id: 'claude' as const,
            label: 'Claude',
            conversations: [
              conversation({ ref: 'within-eight-hours', provider: 'claude', updatedAt: iso(-(8 * 60 * 60 * 1000) + 60_000) }),
              conversation({ ref: 'too-old', provider: 'claude', updatedAt: iso(-(8 * 60 * 60 * 1000) - 1) }),
              conversation({ ref: 'future-clock', provider: 'claude', updatedAt: iso(60_000) }),
            ],
          },
        },
      }],
      boundSessions: [],
      lastIndexedAt: iso(0),
    };

    const app = fastify();
    await registerProjectRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      { getTree: () => tree, refreshAll } as never,
      { observeSessions, autoTrackConversations } as never,
      [],
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects/refresh',
        payload: { autoTrackRecent: true },
      });

      expect(response.statusCode).toBe(200);
      expect(observeSessions).not.toHaveBeenCalled();
      expect(refreshAll).toHaveBeenCalledOnce();
      expect(autoTrackConversations).toHaveBeenCalledOnce();
      expect(autoTrackConversations.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ ref: 'recent-codex', provider: 'codex' }),
      ]);
      expect(Date.parse(autoTrackConversations.mock.calls[0]?.[1] ?? '')).toBeGreaterThanOrEqual(nowMs);
    } finally {
      await app.close();
    }
  });

  it('refreshes without auto-tracking when the caller does not request it', async () => {
    const autoTrackConversations = vi.fn();
    const app = fastify();
    await registerProjectRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      {
        getTree: () => ({ projects: [], boundSessions: [], lastIndexedAt: new Date().toISOString() }),
        refreshAll: async () => undefined,
      } as never,
      { observeSessions: async () => undefined, autoTrackConversations } as never,
      [],
    );
    await app.ready();

    try {
      const response = await app.inject({ method: 'POST', url: '/api/projects/refresh', payload: {} });

      expect(response.statusCode).toBe(200);
      expect(autoTrackConversations).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('refreshes one provider without triggering a global scan', async () => {
    const refreshAll = vi.fn(async () => undefined);
    const refreshProjectProvider = vi.fn(async () => undefined);
    const app = fastify();
    await registerProjectRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      {
        getTree: () => ({ projects: [], boundSessions: [], lastIndexedAt: new Date().toISOString() }),
        refreshAll,
        refreshProjectProvider,
      } as never,
      { observeSessions: async () => undefined, autoTrackConversations: vi.fn() } as never,
      [],
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects/refresh',
        payload: { projectSlug: 'waltium', providerId: 'claude' },
      });

      expect(response.statusCode).toBe(200);
      expect(refreshProjectProvider).toHaveBeenCalledWith('waltium', 'claude');
      expect(refreshAll).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('advertises the providers whose structured lane is enabled on the tree and refresh responses', async () => {
    const app = fastify();
    await registerProjectRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      {
        getTree: () => ({ projects: [], boundSessions: [], lastIndexedAt: 'now' }),
        refreshAll: async () => undefined,
      } as never,
      { observeSessions: async () => undefined, autoTrackConversations: vi.fn() } as never,
      ['codex'],
    );
    await app.ready();

    try {
      const tree = await app.inject({ method: 'GET', url: '/api/projects/tree' });
      expect(tree.statusCode).toBe(200);
      expect(tree.json()).toMatchObject({ lastIndexedAt: 'now', structuredProviders: ['codex'] });

      const refreshed = await app.inject({ method: 'POST', url: '/api/projects/refresh', payload: {} });
      expect(refreshed.json().structuredProviders).toEqual(['codex']);
    } finally {
      await app.close();
    }
  });
});

describe('structured provider configuration wiring', () => {
  async function buildConfiguredApp(structuredSessions?: { codex?: { enabled: boolean }; claude?: { enabled: boolean }; grok?: { enabled: boolean } }) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-structured-wiring-'));
    const root = path.join(tempDir, 'projects');
    await fs.mkdir(path.join(root, 'demo'), { recursive: true });
    await fs.writeFile(path.join(root, 'demo', 'AGENTS.md'), '# Demo');
    await fs.mkdir(path.join(tempDir, 'codex-home'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'claude-home'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'grok-home'), { recursive: true });
    const provider = (discoveryRoot: string) => ({ enabled: true, discoveryRoot });
    const configPath = path.join(tempDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      server: { host: '127.0.0.1', port: 4317, webDistPath: '../web/dist' },
      projectsRoot: root,
      runtimeDir: path.join(tempDir, 'runtime'),
      databasePath: path.join(tempDir, 'agent-console.sqlite'),
      ...(structuredSessions ? { structuredSessions } : {}),
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
        codex: provider(path.join(tempDir, 'codex-home')),
        claude: provider(path.join(tempDir, 'claude-home')),
        grok: provider(path.join(tempDir, 'grok-home')),
      },
      projects: { demo: { active: true, path: path.join(root, 'demo'), displayName: 'Demo', allowedLocalhostPorts: [], tags: [] } },
    }, null, 2));
    const { app } = await buildApp({ configPath });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'agent-console-demo' } });
    expect(login.statusCode).toBe(200);
    return {
      app,
      tempDir,
      headers: { cookie: login.headers['set-cookie'] as string, 'x-csrf-token': login.json().csrfToken as string },
    };
  }

  it('advertises codex and refuses claude when only the Codex lane is on', async () => {
    const { app, headers, tempDir } = await buildConfiguredApp({ codex: { enabled: true }, claude: { enabled: false }, grok: { enabled: false } });
    try {
      const tree = await app.inject({ method: 'GET', url: '/api/projects/tree', headers });
      expect(tree.json().structuredProviders).toEqual(['codex']);

      const claude = await app.inject({
        method: 'POST', url: '/api/conversations/demo/claude/new/bind', headers, payload: {},
      });
      expect(claude.statusCode).toBe(400);
      expect(claude.json()).toEqual({ error: 'Conversations are not enabled for claude: structuredSessions.claude.enabled is off.' });
    } finally {
      await app.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('advertises nothing and refuses binds when the config switches every lane off', async () => {
    const { app, headers, tempDir } = await buildConfiguredApp({ codex: { enabled: false }, claude: { enabled: false }, grok: { enabled: false } });
    try {
      const tree = await app.inject({ method: 'GET', url: '/api/projects/tree', headers });
      expect(tree.json().structuredProviders).toEqual([]);

      const codex = await app.inject({
        method: 'POST', url: '/api/conversations/demo/codex/new/bind', headers, payload: {},
      });
      expect(codex.statusCode).toBe(400);
      expect(codex.json()).toEqual({ error: 'Conversations are not enabled for codex: structuredSessions.codex.enabled is off.' });
    } finally {
      await app.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('advertises claude when its lane is on, beside codex when both are, grok when only it is, and every provider when the config says nothing', async () => {
    const claudeOnly = await buildConfiguredApp({ codex: { enabled: false }, claude: { enabled: true }, grok: { enabled: false } });
    try {
      const tree = await claudeOnly.app.inject({ method: 'GET', url: '/api/projects/tree', headers: claudeOnly.headers });
      expect(tree.json().structuredProviders).toEqual(['claude']);
    } finally {
      await claudeOnly.app.close();
      await fs.rm(claudeOnly.tempDir, { recursive: true, force: true });
    }

    const grokOnly = await buildConfiguredApp({ codex: { enabled: false }, claude: { enabled: false }, grok: { enabled: true } });
    try {
      const tree = await grokOnly.app.inject({ method: 'GET', url: '/api/projects/tree', headers: grokOnly.headers });
      expect(tree.json().structuredProviders).toEqual(['grok']);
    } finally {
      await grokOnly.app.close();
      await fs.rm(grokOnly.tempDir, { recursive: true, force: true });
    }

    const both = await buildConfiguredApp({ codex: { enabled: true }, claude: { enabled: true }, grok: { enabled: false } });
    try {
      const tree = await both.app.inject({ method: 'GET', url: '/api/projects/tree', headers: both.headers });
      expect(tree.json().structuredProviders).toEqual(['codex', 'claude']);
    } finally {
      await both.app.close();
      await fs.rm(both.tempDir, { recursive: true, force: true });
    }

    const unconfigured = await buildConfiguredApp();
    try {
      const tree = await unconfigured.app.inject({ method: 'GET', url: '/api/projects/tree', headers: unconfigured.headers });
      expect(tree.json().structuredProviders).toEqual(['codex', 'claude', 'grok']);
    } finally {
      await unconfigured.app.close();
      await fs.rm(unconfigured.tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a bind that still names a transport, saying which field', async () => {
    const { app, headers, tempDir } = await buildConfiguredApp({ codex: { enabled: true } });
    try {
      for (const url of ['/api/conversations/demo/codex/new/bind', '/api/conversations/demo/codex/history-ref/bind']) {
        const response = await app.inject({ method: 'POST', url, headers, payload: { transport: 'structured' } });
        expect(response.statusCode).toBe(400);
        expect(JSON.stringify(response.json())).toContain('transport');
      }
      expect((await app.inject({ method: 'GET', url: '/api/sessions/structured-migration', headers })).statusCode).toBe(404);
    } finally {
      await app.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
