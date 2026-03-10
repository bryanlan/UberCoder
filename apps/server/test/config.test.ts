import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../src/config/service.js';

async function writeTempConfig(body: object): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-config-'));
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(body, null, 2));
  return configPath;
}

describe('ConfigService', () => {
  it('parses config and merges project provider overrides predictably', async () => {
    const configPath = await writeTempConfig({
      projectsRoot: '/tmp/projects',
      security: {
        passwordHash: 'scrypt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      providers: {
        codex: {
          enabled: true,
          discoveryRoot: '~/.codex',
          commands: {
            newCommand: ['codex'],
            resumeCommand: ['codex', 'resume', '{{conversationId}}'],
            continueCommand: ['codex', 'resume', '--last'],
            env: { CODEX_HOME: '~/.codex' },
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
          displayName: 'Demo Project',
          allowedLocalhostPorts: [3000, 5173],
          providers: {
            codex: {
              commands: {
                resumeCommand: ['codex', 'resume', '--last'],
                env: { CODEX_HOME: '/srv/codex-home' },
              },
            },
          },
        },
      },
    });

    const service = new ConfigService(configPath);
    const merged = service.getMergedProviderSettings('demo', 'codex');
    const globalMerged = service.getMergedProviderSettings('__global__', 'codex');

    expect(service.getConfig().projectsRoot).toBe('/tmp/projects');
    expect(merged.commands.resumeCommand).toEqual(['codex', 'resume', '--last']);
    expect(merged.commands.env).toEqual({ CODEX_HOME: '/srv/codex-home' });
    expect(globalMerged.commands.env).toEqual({ CODEX_HOME: path.join(os.homedir(), '.codex') });
    expect(service.getProjectConfig('demo')?.allowedLocalhostPorts).toEqual([3000, 5173]);
  });

  it('persists updated project settings while preserving provider overrides', async () => {
    const configPath = await writeTempConfig({
      projectsRoot: '/tmp/projects',
      security: {
        passwordHash: 'scrypt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
          active: false,
          displayName: 'Old Name',
          allowedLocalhostPorts: [3000],
          tags: ['legacy'],
          notes: 'old',
          providers: {
            codex: {
              enabled: false,
            },
          },
        },
      },
    });

    const service = new ConfigService(configPath);
    const updated = service.updateProjectConfig('demo', {
      active: true,
      displayName: 'New Name',
      allowedLocalhostPorts: [5173, 3000],
      tags: ['primary', 'frontend'],
      notes: undefined,
    });
    const reloaded = new ConfigService(configPath);

    expect(updated.active).toBe(true);
    expect(updated.displayName).toBe('New Name');
    expect(updated.allowedLocalhostPorts).toEqual([5173, 3000]);
    expect(updated.providers.codex?.enabled).toBe(false);
    expect(reloaded.getProjectConfig('demo')).toMatchObject({
      active: true,
      displayName: 'New Name',
      allowedLocalhostPorts: [5173, 3000],
      tags: ['primary', 'frontend'],
    });
    expect(reloaded.getProjectConfig('demo')?.providers.codex?.enabled).toBe(false);
  });

  it('stores global settings for restart without changing the current runtime snapshot', async () => {
    const configPath = await writeTempConfig({
      projectsRoot: '/tmp/projects',
      server: {
        host: '127.0.0.1',
        port: 4317,
        webDistPath: '../web/dist',
      },
      security: {
        passwordHash: 'scrypt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
    });

    const service = new ConfigService(configPath);
    const updated = service.updateGlobalSettings({
      projectsRoot: '/srv/new-projects',
      serverHost: '0.0.0.0',
      serverPort: 9001,
      sessionTtlHours: 72,
      cookieSecure: true,
      trustTailscaleHeaders: true,
    });
    const reloaded = new ConfigService(configPath);

    expect(service.getConfig().projectsRoot).toBe('/tmp/projects');
    expect(service.getConfig().server.port).toBe(4317);
    expect(updated.projectsRoot).toBe('/srv/new-projects');
    expect(updated.server.host).toBe('0.0.0.0');
    expect(updated.server.port).toBe(9001);
    expect(updated.security.sessionTtlHours).toBe(72);
    expect(reloaded.getConfig().projectsRoot).toBe('/srv/new-projects');
    expect(reloaded.getConfig().server.port).toBe(9001);
  });
});
