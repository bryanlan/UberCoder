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
  it('persists the tracking switch across restart without adopting other pending settings', async () => {
    const configPath = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security: {
      passwordHash: 'fixture', sessionSecret: 'x'.repeat(64) } });
    try {
      const service = new ConfigService(configPath);
      service.updateGlobalSettings({ projectsRoot: '/srv/pending-root', serverHost: '127.0.0.1', serverPort: 9999,
        sessionTtlHours: 72, cookieSecure: true, trustTailscaleHeaders: false });
      service.setWorkerTracking(false);
      expect(service.getConfig().workerSummaries.enabled).toBe(false);
      expect(service.getConfig().projectsRoot).toBe('/tmp/projects');
      expect(new ConfigService(configPath).getConfig()).toMatchObject({ projectsRoot: '/srv/pending-root', workerSummaries: { enabled: false } });
      service.setWorkerTracking(true);
      expect(new ConfigService(configPath).getConfig().workerSummaries.enabled).toBe(true);
    } finally { await fs.rm(path.dirname(configPath), { recursive: true, force: true }); }
  });
  it('parses config and merges project provider overrides predictably', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-config-project-'));
    const projectsRoot = path.join(tempDir, 'projects');
    const demoProjectPath = path.join(projectsRoot, 'demo');
    await fs.mkdir(demoProjectPath, { recursive: true });
    await fs.writeFile(path.join(demoProjectPath, 'AGENTS.md'), '# Demo');
    const configPath = await writeTempConfig({
      projectsRoot,
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
          path: demoProjectPath,
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

    expect(service.getConfig().projectsRoot).toBe(projectsRoot);
    expect(merged.commands.resumeCommand).toEqual(['codex', 'resume', '--last']);
    expect(merged.commands.env).toEqual({ CODEX_HOME: '/srv/codex-home' });
    expect(globalMerged.commands.env).toEqual({ CODEX_HOME: path.join(os.homedir(), '.codex') });
    expect(service.getProjectConfig('demo')?.allowedLocalhostPorts).toEqual([3000, 5173]);
  });

  it('persists updated project settings while preserving provider overrides', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-config-project-'));
    const projectsRoot = path.join(tempDir, 'projects');
    const demoProjectPath = path.join(projectsRoot, 'demo');
    await fs.mkdir(demoProjectPath, { recursive: true });
    await fs.writeFile(path.join(demoProjectPath, 'AGENTS.md'), '# Demo');
    const configPath = await writeTempConfig({
      projectsRoot,
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
          path: demoProjectPath,
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

  it('creates and deletes explicit project path entries', async () => {
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
      projects: {},
    });

    const service = new ConfigService(configPath);
    const created = service.createProjectConfig({
      path: '/tmp/projects/UberCoder/agent-console-mvp/agent-console',
    });

    expect(created.directoryName).toBe('UberCoder--agent-console-mvp--agent-console');
    expect(service.getProjectConfig(created.directoryName)?.path).toBe('/tmp/projects/UberCoder/agent-console-mvp/agent-console');
    expect(service.findProjectDirectoryNameByPath('/tmp/projects/UberCoder/agent-console-mvp/agent-console')).toBe(created.directoryName);

    expect(service.deleteProjectConfig(created.directoryName)).toBe(true);
    expect(service.getProjectConfig(created.directoryName)).toBeUndefined();
  });

  it('drops legacy saved top-level project entries so only explicit added projects remain', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-legacy-project-'));
    const projectsRoot = path.join(tempDir, 'projects');
    const nestedProjectPath = path.join(projectsRoot, 'UberCoder', 'agent-console-mvp', 'agent-console');
    await fs.mkdir(nestedProjectPath, { recursive: true });
    await fs.writeFile(path.join(nestedProjectPath, 'AGENTS.md'), '# project');
    const configPath = await writeTempConfig({
      projectsRoot,
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
        UberCoder: {
          active: true,
          path: path.join(projectsRoot, 'UberCoder'),
          allowedLocalhostPorts: [],
          tags: [],
        },
      },
    });

    const service = new ConfigService(configPath);
    const reloaded = new ConfigService(configPath);

    expect(service.getProjectConfig('UberCoder')).toBeUndefined();
    expect(service.getConfiguredProjectDirectoryNames()).toEqual([]);
    expect(reloaded.getProjectConfig('UberCoder')).toBeUndefined();
    expect(reloaded.getConfiguredProjectDirectoryNames()).toEqual([]);
  });

  it('drops legacy saved top-level project entries even when the folder only contains files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-legacy-files-only-'));
    const projectsRoot = path.join(tempDir, 'projects');
    const legacyProjectPath = path.join(projectsRoot, 'notes-app');
    await fs.mkdir(legacyProjectPath, { recursive: true });
    await fs.writeFile(path.join(legacyProjectPath, 'README.txt'), 'legacy top-level project without marker files');
    const configPath = await writeTempConfig({
      projectsRoot,
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
        'notes-app': {
          active: true,
          path: legacyProjectPath,
          allowedLocalhostPorts: [],
          tags: [],
        },
      },
    });

    const service = new ConfigService(configPath);
    const reloaded = new ConfigService(configPath);

    expect(service.getProjectConfig('notes-app')).toBeUndefined();
    expect(service.getConfiguredProjectDirectoryNames()).toEqual([]);
    expect(reloaded.getProjectConfig('notes-app')).toBeUndefined();
    expect(reloaded.getConfiguredProjectDirectoryNames()).toEqual([]);
  });

  it('generates project keys from the stored root after a global root change pending restart', async () => {
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
    service.updateGlobalSettings({
      projectsRoot: '/srv/new-projects',
      serverHost: '0.0.0.0',
      serverPort: 9001,
      sessionTtlHours: 72,
      cookieSecure: true,
      trustTailscaleHeaders: true,
    });

    const created = service.createProjectConfig({
      path: '/srv/new-projects/UberCoder/agent-console-mvp/agent-console',
    });

    expect(created.directoryName).toBe('UberCoder--agent-console-mvp--agent-console');
  });

  it('preserves explicitly added top-level folders without marker files across reloads', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-explicit-project-'));
    const projectsRoot = path.join(tempDir, 'projects');
    const explicitProjectPath = path.join(projectsRoot, 'workspace');
    await fs.mkdir(explicitProjectPath, { recursive: true });

    const configPath = await writeTempConfig({
      projectsRoot,
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
    const created = service.createProjectConfig({
      path: explicitProjectPath,
    });
    const reloaded = new ConfigService(configPath);

    expect(created.directoryName).toBe('workspace');
    expect(service.getProjectConfig('workspace')?.explicit).toBe(true);
    expect(reloaded.getProjectConfig('workspace')).toMatchObject({
      path: explicitProjectPath,
      explicit: true,
    });
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

  describe('structuredSessions', () => {
    const security = { passwordHash: 'fixture', sessionSecret: 'x'.repeat(64) };
    const defaults = { codex: { enabled: false, command: ['codex', 'app-server'], idleUnloadMinutes: 60 } };

    it('defaults to disabled when the block is absent or partial', async () => {
      const absent = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security });
      const emptyCodex = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { codex: {} } });
      const emptyBlock = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: {} });
      try {
        for (const configPath of [absent, emptyCodex, emptyBlock]) {
          expect(new ConfigService(configPath).getConfig().structuredSessions).toEqual(defaults);
        }
      } finally {
        for (const configPath of [absent, emptyCodex, emptyBlock]) await fs.rm(path.dirname(configPath), { recursive: true, force: true });
      }
    });

    it('parses an enabled block and fills the fields it omits', async () => {
      const full = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security,
        structuredSessions: { codex: { enabled: true, command: ['/opt/codex/bin/codex', 'app-server', '--verbose'], idleUnloadMinutes: 15 } } });
      const enabledOnly = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { codex: { enabled: true } } });
      const invalid = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { codex: { command: [] } } });
      const invalidIdle = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { codex: { idleUnloadMinutes: 0 } } });
      try {
        expect(new ConfigService(full).getConfig().structuredSessions)
          .toEqual({ codex: { enabled: true, command: ['/opt/codex/bin/codex', 'app-server', '--verbose'], idleUnloadMinutes: 15 } });
        expect(new ConfigService(enabledOnly).getConfig().structuredSessions)
          .toEqual({ codex: { enabled: true, command: ['codex', 'app-server'], idleUnloadMinutes: 60 } });
        expect(() => new ConfigService(invalid)).toThrow();
        expect(() => new ConfigService(invalidIdle)).toThrow();
      } finally {
        for (const configPath of [full, enabledOnly, invalid, invalidIdle]) await fs.rm(path.dirname(configPath), { recursive: true, force: true });
      }
    });

    it('survives every persist path without loss', async () => {
      const block = { codex: { enabled: true, command: ['codex', 'app-server', '-c', 'log=debug'], idleUnloadMinutes: 5 } };
      const configPath = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: block });
      try {
        const service = new ConfigService(configPath);
        service.setWorkerTracking(false);
        service.updateGlobalSettings({ projectsRoot: '/tmp/projects', serverHost: '127.0.0.1', serverPort: 4317,
          sessionTtlHours: 24, cookieSecure: false, trustTailscaleHeaders: false });
        service.createProjectConfig({ path: '/tmp/projects/demo' });
        expect(JSON.parse(await fs.readFile(configPath, 'utf8')).structuredSessions).toEqual(block);
        expect(new ConfigService(configPath).getConfig().structuredSessions).toEqual(block);
        expect(service.getStoredConfig().structuredSessions).toEqual(block);
      } finally { await fs.rm(path.dirname(configPath), { recursive: true, force: true }); }
    });

    it('writes the disabled defaults when an older config without the block is persisted', async () => {
      const configPath = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security });
      try {
        new ConfigService(configPath).setWorkerTracking(true);
        expect(JSON.parse(await fs.readFile(configPath, 'utf8')).structuredSessions).toEqual(defaults);
      } finally { await fs.rm(path.dirname(configPath), { recursive: true, force: true }); }
    });

    it('ships the disabled lane in the example config', async () => {
      const example = JSON.parse(await fs.readFile(new URL('../../../config/agent-console.example.json', import.meta.url), 'utf8'));
      expect(example.structuredSessions).toEqual(defaults);
    });
  });
});
