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
});
