import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import { AppDatabase } from '../src/db/database.js';
import { AuthService } from '../src/security/auth-service.js';

function buildConfig(overrides: Partial<AppConfig['security']> = {}): AppConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 4317,
      webDistPath: '../web/dist',
    },
    projectsRoot: '/tmp/projects',
    runtimeDir: '/tmp/runtime',
    databasePath: '/tmp/agent-console.sqlite',
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
