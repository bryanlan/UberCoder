import Fastify from 'fastify';
import cookiePlugin from '@fastify/cookie';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { AuthService } from '../src/security/auth-service.js';
import { appConfigSchema } from '../src/config/schema.js';
import { registerWorkerRoutes } from '../src/workers/routes.js';

it('requires login and CSRF before any summary request, validates cadence, and serves snapshots without generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-routes-'));
  const db = new AppDatabase(path.join(root, 'console.sqlite'));
  const config = appConfigSchema.parse({ projectsRoot: root, providers: {}, security: { passwordHash: 'fixture', sessionSecret: 'x'.repeat(64),
    trustTailscaleHeaders: true, tailscaleAllowedUserLogin: 'fixture@example.invalid' } });
  const auth = new AuthService(config, db); const app = Fastify(); await app.register(cookiePlugin);
  app.get('/auth', (request, reply) => auth.getAuthState(request, reply));
  const snapshot = vi.fn(async () => ({ workers: [], workingCount: 0 }));
  const refresh = vi.fn(async () => ({ workers: [], workingCount: 0 }));
  const setTracking = vi.fn(async () => ({ trackingEnabled: false, workers: [], workingCount: 0 }));
  const openingMessage = vi.fn(async (id: string) => id === 'one' ? { text: 'The complete original opening message.', error: null } : null);
  registerWorkerRoutes(app, auth, { snapshot, refresh, setTracking, openingMessage } as never);
  try {
    expect((await app.inject('/api/workers')).statusCode).toBe(401);
    expect((await app.inject('/api/workers/one/opening-message')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/workers/tracking', payload: { enabled: false } })).statusCode).toBe(401);
    const login = await app.inject({ url: '/auth', headers: { 'tailscale-user-login': 'fixture@example.invalid' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const headers = { cookie, 'x-csrf-token': login.json().csrfToken };
    const opening = await app.inject({ url: '/api/workers/one/opening-message', headers: { cookie } });
    expect(opening.statusCode).toBe(200); expect(opening.json().text).toBe('The complete original opening message.');
    expect((await app.inject({ url: '/api/workers/unknown/opening-message', headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/workers', headers: { cookie } })).statusCode).toBe(200);
    expect(snapshot).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/workers/refresh', headers: { cookie }, payload: { intervalMinutes: 1 } })).statusCode).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
    for (const intervalMinutes of [0, 6, 1.5]) {
      expect((await app.inject({ method: 'POST', url: '/api/workers/refresh', headers, payload: { intervalMinutes } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/workers/refresh', headers, payload: { intervalMinutes: 5 } })).statusCode).toBe(200);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(5);
    expect((await app.inject({ method: 'POST', url: '/api/workers/tracking', headers: { cookie }, payload: { enabled: false } })).statusCode).toBe(403);
    expect(setTracking).not.toHaveBeenCalled();
    for (const payload of [{ enabled: 'false' }, { enabled: false, extra: true }, {}]) {
      expect((await app.inject({ method: 'POST', url: '/api/workers/tracking', headers, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/workers/tracking', headers, payload: { enabled: false } })).statusCode).toBe(200);
    expect(setTracking).toHaveBeenCalledExactlyOnceWith(false);
  } finally { await app.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); }
});
