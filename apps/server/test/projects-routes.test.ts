import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerProjectRoutes } from '../src/routes/projects.js';

describe('project routes', () => {
  it('waits for an in-flight tree observation instead of serving stale state or starting a duplicate observation', async () => {
    let nowMs = Date.parse('2026-03-14T12:00:00.000Z');
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

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
      await new Promise((resolve) => setImmediate(resolve));
      const secondTree = app.inject({ method: 'GET', url: '/api/projects/tree' });
      await new Promise((resolve) => setImmediate(resolve));

      nowMs = Date.parse('2026-03-14T12:00:06.000Z');
      const thirdTree = app.inject({ method: 'GET', url: '/api/projects/tree' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(observeSessions).toHaveBeenCalledTimes(1);

      resolveObservation?.();

      const [firstResponse, secondResponse, thirdResponse] = await Promise.all([firstTree, secondTree, thirdTree]);

      expect(firstResponse.statusCode).toBe(200);
      expect(secondResponse.statusCode).toBe(200);
      expect(thirdResponse.statusCode).toBe(200);
      expect(firstResponse.json().lastIndexedAt).toBe('fresh');
      expect(secondResponse.json().lastIndexedAt).toBe('fresh');
      expect(thirdResponse.json().lastIndexedAt).toBe('fresh');
      expect(observeSessions).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      dateNowSpy.mockRestore();
    }
  });
});
