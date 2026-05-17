import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BoundSession } from '@agent-console/shared';
import { AppDatabase } from '../src/db/database.js';
import { registerSessionRoutes } from '../src/routes/sessions.js';

describe('session routes', () => {
  it('accepts live input bridge paste payloads larger than the old route limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session: BoundSession = {
      id: 'session-large',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-large',
      tmuxSessionName: 'ac-codex-demo-large',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    const sendKeystrokes = vi.fn(async () => session);
    const app = fastify({ bodyLimit: 1024 });
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const largeText = 'x'.repeat((12 * 1024 * 1024) + 1024);
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-large/keys',
        payload: { text: largeText },
      });

      expect(response.statusCode).toBe(200);
      expect(sendKeystrokes).toHaveBeenCalledWith('session-large', { text: largeText });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('rejects live input bridge payloads above the expanded session route limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-session-route-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const session: BoundSession = {
      id: 'session-too-large',
      provider: 'codex',
      projectSlug: 'demo',
      conversationRef: 'history-too-large',
      tmuxSessionName: 'ac-codex-demo-too-large',
      status: 'bound',
      startedAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    };
    const sendKeystrokes = vi.fn(async () => session);
    const app = fastify({ bodyLimit: 1024 });
    await registerSessionRoutes(
      app,
      { ensureAuthenticated: async () => undefined } as never,
      db,
      {} as never,
      {} as never,
      {
        getSessionById: vi.fn(() => session),
        sendKeystrokes,
      } as never,
    );
    await app.ready();

    try {
      const tooLargeText = 'x'.repeat((64 * 1024 * 1024) + 1024);
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-too-large/keys',
        payload: { text: tooLargeText },
      });

      expect(response.statusCode).toBe(413);
      expect(sendKeystrokes).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });
});
