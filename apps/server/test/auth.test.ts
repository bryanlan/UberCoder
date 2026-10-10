import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { INVALID_CSRF_TOKEN_CODE } from '@agent-console/shared';
import type { AppConfig } from '../src/config/schema.js';
import { AppDatabase } from '../src/db/database.js';
import { AuthService } from '../src/security/auth-service.js';

function buildConfig(overrides: Partial<AppConfig['security']> = {}): AppConfig {
  return {
    coordination: { enabled: false, pilotPaths: [] },
    server: {
      host: '127.0.0.1',
      port: 4317,
      webDistPath: '../web/dist',
    },
    projectsRoot: '/tmp/projects',
    runtimeDir: '/tmp/runtime',
    databasePath: '/tmp/agent-console.sqlite',
    sessions: {
      eagerRestoreHours: 48,
      restoreGraceHours: 24,
      pressureSuspendAvailableMiB: 3072,
      pressureSuspendIdleMinutes: 60,
    },
    security: {
      passwordHash: 'scrypt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      cookieSecure: false,
      sessionTtlHours: 24,
      loginRateLimitMax: 10,
      loginRateLimitWindowMs: 900000,
      trustTailscaleHeaders: true,
      tailscaleAllowedUserLogin: 'user@example.com',
      ...overrides,
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
    projects: {},
  };
}

describe('AuthService', () => {
  it('rejects stale CSRF before an action after a background poll renews an expired login', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-auth-renewal-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const auth = new AuthService(buildConfig(), db);
    const app = Fastify();
    let actions = 0;
    await app.register(cookie);
    app.get('/auth', (request, reply) => auth.getAuthState(request, reply));
    app.get('/poll', async (request, reply) => {
      await auth.ensureAuthenticated(request, reply);
      return { ok: true };
    });
    app.post('/action', async (request, reply) => {
      try {
        await auth.ensureAuthenticated(request, reply);
      } catch {
        return;
      }
      actions += 1;
      return { ok: true };
    });
    try {
      const identity = { 'tailscale-user-login': 'user@example.com' };
      const firstAuth = await app.inject({ url: '/auth', headers: identity });
      const originalCookie = String(firstAuth.headers['set-cookie']).split(';')[0];
      const oldToken = firstAuth.json().csrfToken;
      // This is the test's private SQLite file, not the live Console database.
      db.sqlite.prepare("update auth_sessions set expires_at = '2000-01-01T00:00:00.000Z'").run();
      const poll = await app.inject({ url: '/poll', headers: { ...identity, cookie: originalCookie } });
      expect(poll.statusCode).toBe(200);
      const renewedCookie = String(poll.headers['set-cookie']).split(';')[0];
      expect(renewedCookie).not.toBe(originalCookie);

      const stale = await app.inject({ method: 'POST', url: '/action', headers: { ...identity, cookie: renewedCookie, 'x-csrf-token': oldToken } });
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toEqual({ error: 'Invalid CSRF token.', code: INVALID_CSRF_TOKEN_CODE });
      expect(actions).toBe(0);
      const refreshed = await app.inject({ url: '/auth', headers: { ...identity, cookie: renewedCookie } });
      expect(refreshed.json().csrfToken).not.toBe(oldToken);
      const accepted = await app.inject({ method: 'POST', url: '/action', headers: { ...identity, cookie: renewedCookie, 'x-csrf-token': refreshed.json().csrfToken } });
      expect(accepted.statusCode).toBe(200);
      expect(actions).toBe(1);
    } finally {
      await app.close();
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('only trusts Tailscale identity headers from loopback clients', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-auth-'));
    const db = new AppDatabase(path.join(tempDir, 'agent-console.sqlite'));
    const auth = new AuthService(buildConfig(), db);

    expect(auth.authenticateRawHeaders({ 'tailscale-user-login': 'user@example.com' }, '127.0.0.1')).toBe(true);
    expect(auth.authenticateRawHeaders({ 'tailscale-user-login': 'user@example.com' }, '203.0.113.10')).toBe(false);
    expect(auth.authenticateRawHeaders({ 'tailscale-user-login': 'other@example.com' }, '127.0.0.1')).toBe(false);

    db.close();
  });
});
