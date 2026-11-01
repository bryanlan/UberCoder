import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../src/config/service.js';
import { appConfigSchema, defaultStructuredProviderConfig } from '../src/config/schema.js';

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
        },
        claude: {
          enabled: true,
          discoveryRoot: '~/.claude',
        },
      },
      projects: {
        demo: {
          active: true,
          path: demoProjectPath,
          displayName: 'Demo Project',
          allowedLocalhostPorts: [3000, 5173],
          providers: {
            codex: { discoveryRoot: '/srv/codex-home' },
            claude: { enabled: false },
          },
        },
      },
    });

    const service = new ConfigService(configPath);
    const merged = service.getMergedProviderSettings('demo', 'codex');
    const globalMerged = service.getMergedProviderSettings('__global__', 'codex');

    expect(service.getConfig().projectsRoot).toBe(projectsRoot);
    expect(merged).toEqual({ id: 'codex', enabled: true, discoveryRoot: '/srv/codex-home' });
    expect(globalMerged).toEqual({ id: 'codex', enabled: true, discoveryRoot: path.join(os.homedir(), '.codex') });
    expect(service.getMergedProviderSettings('demo', 'claude')).toEqual({ id: 'claude', enabled: false, discoveryRoot: path.join(os.homedir(), '.claude') });
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
        },
        claude: {
          enabled: true,
          discoveryRoot: '~/.claude',
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
        },
        claude: {
          enabled: true,
          discoveryRoot: '~/.claude',
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
        },
        claude: {
          enabled: true,
          discoveryRoot: '~/.claude',
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
        },
        claude: {
          enabled: true,
          discoveryRoot: '~/.claude',
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
        },
        claude: {
          enabled: true,
          discoveryRoot: '~/.claude',
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
        },
        claude: {
          enabled: true,
          discoveryRoot: '~/.claude',
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
        },
        claude: {
          enabled: true,
          discoveryRoot: '~/.claude',
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
    const codexDefaults = { enabled: true, command: ['codex', 'app-server'], idleUnloadMinutes: 60, env: {} };
    const claudeDefaults = { enabled: true, command: ['claude'], idleUnloadMinutes: 60, env: {} };
    const grokDefaults = { enabled: true, command: ['grok'], idleUnloadMinutes: 60, env: {} };
    const defaults = { codex: codexDefaults, claude: claudeDefaults, grok: grokDefaults };

    it('defaults to enabled when the block is absent or partial', async () => {
      const absent = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security });
      const emptyCodex = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { codex: {} } });
      const emptyClaude = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { claude: {} } });
      const emptyBlock = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: {} });
      try {
        for (const configPath of [absent, emptyCodex, emptyClaude, emptyBlock]) {
          expect(new ConfigService(configPath).getConfig().structuredSessions).toEqual(defaults);
        }
      } finally {
        for (const configPath of [absent, emptyCodex, emptyClaude, emptyBlock]) await fs.rm(path.dirname(configPath), { recursive: true, force: true });
      }
    });

    it('gives every parse its own default objects, so one config never shares state with another', async () => {
      const first = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security });
      const second = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security });
      try {
        const a = new ConfigService(first).getConfig().structuredSessions;
        const b = new ConfigService(second).getConfig().structuredSessions;
        expect(a.codex).not.toBe(b.codex);
        expect(a.claude.command).not.toBe(b.claude.command);
        expect(a.codex.env).not.toBe(b.codex.env);
        expect(defaultStructuredProviderConfig('claude')).toEqual(claudeDefaults);
        expect(defaultStructuredProviderConfig('codex')).toEqual(codexDefaults);
        expect(defaultStructuredProviderConfig('grok')).toEqual(grokDefaults);
      } finally {
        for (const configPath of [first, second]) await fs.rm(path.dirname(configPath), { recursive: true, force: true });
      }
    });

    it('lets a lane be switched off and leaves the other on', async () => {
      const codexOff = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { codex: { enabled: false } } });
      const claudeOff = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { claude: { enabled: false } } });
      try {
        expect(new ConfigService(codexOff).getConfig().structuredSessions).toEqual({ codex: { ...codexDefaults, enabled: false }, claude: claudeDefaults, grok: grokDefaults });
        expect(new ConfigService(claudeOff).getConfig().structuredSessions).toEqual({ codex: codexDefaults, claude: { ...claudeDefaults, enabled: false }, grok: grokDefaults });
      } finally {
        for (const configPath of [codexOff, claudeOff]) await fs.rm(path.dirname(configPath), { recursive: true, force: true });
      }
    });

    it('parses an enabled block and fills the fields it omits', async () => {
      const full = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security,
        structuredSessions: { codex: { enabled: true, command: ['/opt/codex/bin/codex', 'app-server', '--verbose'], idleUnloadMinutes: 15, env: { CODEX_HOME: '~/alt' } },
          claude: { enabled: true, command: ['/opt/claude/bin/claude', '--debug'], idleUnloadMinutes: 20, env: { CLAUDE_CONFIG_DIR: '~/alt-claude' } } } });
      const enabledOnly = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { codex: { enabled: true }, claude: { enabled: true } } });
      const invalid = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { codex: { command: [] } } });
      const invalidClaude = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { claude: { command: [] } } });
      const invalidIdle = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { claude: { idleUnloadMinutes: 0 } } });
      const invalidEnv = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { claude: { env: { PORT: 1 } } } });
      try {
        expect(new ConfigService(full).getConfig().structuredSessions).toEqual({
          codex: { enabled: true, command: ['/opt/codex/bin/codex', 'app-server', '--verbose'], idleUnloadMinutes: 15, env: { CODEX_HOME: '~/alt' } },
          claude: { enabled: true, command: ['/opt/claude/bin/claude', '--debug'], idleUnloadMinutes: 20, env: { CLAUDE_CONFIG_DIR: '~/alt-claude' } },
          grok: grokDefaults,
        });
        expect(new ConfigService(enabledOnly).getConfig().structuredSessions).toEqual({
          codex: { ...codexDefaults, enabled: true },
          claude: { ...claudeDefaults, enabled: true },
          grok: grokDefaults,
        });
        for (const configPath of [invalid, invalidClaude, invalidIdle, invalidEnv]) expect(() => new ConfigService(configPath)).toThrow();
      } finally {
        for (const configPath of [full, enabledOnly, invalid, invalidClaude, invalidIdle, invalidEnv]) await fs.rm(path.dirname(configPath), { recursive: true, force: true });
      }
    });

    it('survives every persist path without loss', async () => {
      const block = {
        codex: { enabled: true, command: ['codex', 'app-server', '-c', 'log=debug'], idleUnloadMinutes: 5, env: { EXTRA: '1' } },
        claude: { enabled: true, command: ['claude', '--debug'], idleUnloadMinutes: 7, env: { OTHER: '2' } },
        grok: { enabled: true, command: ['grok'], idleUnloadMinutes: 9, env: { GROK_HOME: '~/.grok-alt' } },
      };
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

    it('writes the defaults when an older config without the block is persisted', async () => {
      const configPath = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security });
      try {
        new ConfigService(configPath).setWorkerTracking(true);
        expect(JSON.parse(await fs.readFile(configPath, 'utf8')).structuredSessions).toEqual(defaults);
      } finally { await fs.rm(path.dirname(configPath), { recursive: true, force: true }); }
    });

    it('names the provider and profile a provider-neutral Start falls back to: Codex Medium unless config says otherwise', async () => {
      const absent = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security });
      const named = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, modelRouting: { startDefault: { provider: 'grok', profile: 'low' } } });
      const partial = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, modelRouting: { startDefault: { provider: 'claude' } } });
      const badProvider = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, modelRouting: { startDefault: { provider: 'gemini' } } });
      const badProfile = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, modelRouting: { startDefault: { profile: 'auto' } } });
      try {
        expect(new ConfigService(absent).getConfig().modelRouting.startDefault).toEqual({ provider: 'codex', profile: 'medium' });
        expect(new ConfigService(named).getConfig().modelRouting.startDefault).toEqual({ provider: 'grok', profile: 'low' });
        expect(new ConfigService(partial).getConfig().modelRouting.startDefault).toEqual({ provider: 'claude', profile: 'medium' });
        expect(() => new ConfigService(badProvider)).toThrow();
        expect(() => new ConfigService(badProfile)).toThrow();
      } finally {
        for (const configPath of [absent, named, partial, badProvider, badProfile]) await fs.rm(path.dirname(configPath), { recursive: true, force: true });
      }
    });

    it('gives Grok its own provider settings, rooted at ~/.grok, and offers Grok only while its structured lane is on', async () => {
      const off = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security, structuredSessions: { grok: { enabled: false }, claude: { enabled: false } } });
      const on = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security });
      const projectOff = await writeTempConfig({ projectsRoot: '/tmp/projects', providers: {}, security,
        projects: { demo: { active: true, path: '/tmp/projects/demo', explicit: true, providers: { grok: { enabled: false } } } } });
      try {
        expect(new ConfigService(off).getMergedProviderSettings('__global__', 'grok')).toMatchObject({ id: 'grok', enabled: false, discoveryRoot: path.join(os.homedir(), '.grok') });
        expect(new ConfigService(on).getMergedProviderSettings('__global__', 'grok')).toMatchObject({ id: 'grok', enabled: true, discoveryRoot: path.join(os.homedir(), '.grok') });
        // Only Grok follows its lane flag: the history of Claude stays readable with its lane off.
        expect(new ConfigService(off).getMergedProviderSettings('__global__', 'claude').enabled).toBe(true);
        // A project can still switch Grok off by itself.
        expect(new ConfigService(projectOff).getMergedProviderSettings('demo', 'grok').enabled).toBe(false);
      } finally {
        for (const configPath of [off, on, projectOff]) await fs.rm(path.dirname(configPath), { recursive: true, force: true });
      }
    });

    it('ships every lane on in the example config, which parses', async () => {
      const example = JSON.parse(await fs.readFile(new URL('../../../config/agent-console.example.json', import.meta.url), 'utf8'));
      expect(example.structuredSessions).toEqual(defaults);
      expect(() => appConfigSchema.parse(example)).not.toThrow();
    });
  });

  // The tmux transport was removed (Phase B). A config that still carries one of its settings fails at startup with the key's
  // path, instead of having a setting nothing reads any more look as if it worked.
  describe('removed tmux settings', () => {
    const security = { passwordHash: 'fixture', sessionSecret: 'x'.repeat(64) };
    const commands = { newCommand: ['codex'], resumeCommand: ['codex', 'resume', '{{conversationId}}'], env: {} };

    it.each([
      ['providers.codex.commands', { providers: { codex: { commands } } }],
      ['projects.demo.providers.claude.commands', { providers: {}, projects: { demo: { path: '/tmp/demo', providers: { claude: { commands: { env: {} } } } } } }],
      ['structuredSessions.defaultTransport', { providers: {}, structuredSessions: { defaultTransport: 'structured' } }],
      ['sessions.eagerRestoreHours', { providers: {}, sessions: { eagerRestoreHours: 1 } }],
    ])('fails at startup on %s, naming it', async (key, extra) => {
      const configPath = await writeTempConfig({ projectsRoot: '/tmp/projects', security, ...extra });
      try {
        let error: unknown;
        try { new ConfigService(configPath); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error);
        const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? [];
        expect(issues.map(issue => issue.path.join('.'))).toContain(key);
        expect(issues.find(issue => issue.path.join('.') === key)?.message).toMatch(/removed|Delete this key/);
      } finally { await fs.rm(path.dirname(configPath), { recursive: true, force: true }); }
    });
  });
});
