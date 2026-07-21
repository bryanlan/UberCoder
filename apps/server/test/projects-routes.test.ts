import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
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

  it('auto-tracks only unbound provider conversations with activity in the last eight hours', async () => {
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
        expect.objectContaining({ ref: 'within-eight-hours', provider: 'claude' }),
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
});
