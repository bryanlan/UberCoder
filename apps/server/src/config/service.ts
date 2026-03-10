import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROVIDERS, type ProviderId } from '@agent-console/shared';
import { appConfigSchema, projectConfigSchema, type AppConfig, type ProjectConfig, type ProviderSettings } from './schema.js';
import { expandHome, normalizeFsPath } from '../lib/path-utils.js';

export interface MergedProviderSettings extends Omit<ProviderSettings, 'discoveryRoot'> {
  id: ProviderId;
  discoveryRoot: string;
}

export class ConfigService {
  private readonly configPath: string;
  private runtimeConfig: AppConfig;
  private storedConfig: AppConfig;

  constructor(configPath?: string) {
    this.configPath = normalizeFsPath(configPath ?? process.env.AGENT_CONSOLE_CONFIG ?? '~/.config/agent-console/config.json');
    const raw = JSON.parse(readFileSync(this.configPath, 'utf8'));
    const parsed = appConfigSchema.parse(raw);
    this.runtimeConfig = parsed;
    this.storedConfig = parsed;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getConfig(): AppConfig {
    return this.normalizeConfig(this.runtimeConfig);
  }

  getStoredConfig(): AppConfig {
    return this.normalizeConfig(this.storedConfig);
  }

  private normalizeConfig(config: AppConfig): AppConfig {
    return {
      ...config,
      projectsRoot: normalizeFsPath(config.projectsRoot),
      runtimeDir: normalizeFsPath(config.runtimeDir),
      databasePath: normalizeFsPath(config.databasePath),
      server: {
        ...config.server,
        webDistPath: path.resolve(path.dirname(this.configPath), config.server.webDistPath),
      },
      providers: {
        codex: {
          ...config.providers.codex,
          discoveryRoot: normalizeFsPath(config.providers.codex.discoveryRoot ?? '~/.codex'),
          commands: {
            ...config.providers.codex.commands,
            env: Object.fromEntries(Object.entries(config.providers.codex.commands.env).map(([key, value]) => [key, expandHome(value)])),
          },
        },
        claude: {
          ...config.providers.claude,
          discoveryRoot: normalizeFsPath(config.providers.claude.discoveryRoot ?? '~/.claude'),
          commands: {
            ...config.providers.claude.commands,
            env: Object.fromEntries(Object.entries(config.providers.claude.commands.env).map(([key, value]) => [key, expandHome(value)])),
          },
        },
      },
    };
  }

  getProjectsRoot(): string {
    return normalizeFsPath(this.runtimeConfig.projectsRoot);
  }

  getRuntimeDir(): string {
    return normalizeFsPath(this.runtimeConfig.runtimeDir);
  }

  getDatabasePath(): string {
    return normalizeFsPath(this.runtimeConfig.databasePath);
  }

  getProjectConfig(directoryName: string): ProjectConfig | undefined {
    return this.runtimeConfig.projects[directoryName];
  }

  getMergedProviderSettings(directoryName: string, providerId: ProviderId): MergedProviderSettings {
    const globalProvider = this.runtimeConfig.providers[providerId];
    const projectOverride = directoryName === '__global__' ? undefined : this.runtimeConfig.projects[directoryName]?.providers[providerId];
    return {
      id: providerId,
      enabled: projectOverride?.enabled ?? globalProvider.enabled,
      discoveryRoot: normalizeFsPath(projectOverride?.discoveryRoot ?? globalProvider.discoveryRoot ?? (providerId === 'codex' ? '~/.codex' : '~/.claude')),
      commands: {
        newCommand: projectOverride?.commands?.newCommand ?? globalProvider.commands.newCommand,
        resumeCommand: projectOverride?.commands?.resumeCommand ?? globalProvider.commands.resumeCommand,
        continueCommand: projectOverride?.commands?.continueCommand ?? globalProvider.commands.continueCommand,
        env: Object.fromEntries(
          Object.entries({
            ...globalProvider.commands.env,
            ...(projectOverride?.commands?.env ?? {}),
          }).map(([key, value]) => [key, expandHome(value)]),
        ),
      },
    };
  }

  getResolvedProviderEnv(directoryName: string, providerId: ProviderId): Record<string, string> {
    const settings = this.getMergedProviderSettings(directoryName, providerId);
    return Object.fromEntries(Object.entries(settings.commands.env).map(([key, value]) => [key, expandHome(value)]));
  }

  getActiveProjectDirectoryNames(): string[] {
    return Object.entries(this.runtimeConfig.projects)
      .filter(([, value]) => value.active)
      .map(([key]) => key);
  }

  getConfiguredProjectDirectoryNames(): string[] {
    return Object.keys(this.storedConfig.projects);
  }

  updateProjectConfig(
    directoryName: string,
    input: Pick<ProjectConfig, 'active' | 'allowedLocalhostPorts' | 'tags'> & Partial<Pick<ProjectConfig, 'displayName' | 'notes'>>,
  ): ProjectConfig {
    const currentStored = this.storedConfig.projects[directoryName];
    const nextProject = projectConfigSchema.parse({
      ...currentStored,
      active: input.active,
      displayName: input.displayName,
      allowedLocalhostPorts: input.allowedLocalhostPorts,
      tags: input.tags,
      notes: input.notes,
      providers: currentStored?.providers ?? {},
    });
    this.storedConfig = {
      ...this.storedConfig,
      projects: {
        ...this.storedConfig.projects,
        [directoryName]: nextProject,
      },
    };
    this.runtimeConfig = {
      ...this.runtimeConfig,
      projects: {
        ...this.runtimeConfig.projects,
        [directoryName]: nextProject,
      },
    };
    this.persist();
    return nextProject;
  }

  updateGlobalSettings(input: {
    projectsRoot: string;
    serverHost: string;
    serverPort: number;
    sessionTtlHours: number;
    cookieSecure: boolean;
    trustTailscaleHeaders: boolean;
  }): AppConfig {
    this.storedConfig = appConfigSchema.parse({
      ...this.storedConfig,
      projectsRoot: input.projectsRoot,
      server: {
        ...this.storedConfig.server,
        host: input.serverHost,
        port: input.serverPort,
      },
      security: {
        ...this.storedConfig.security,
        sessionTtlHours: input.sessionTtlHours,
        cookieSecure: input.cookieSecure,
        trustTailscaleHeaders: input.trustTailscaleHeaders,
      },
    });
    this.persist();
    return this.getStoredConfig();
  }

  getProviderIds(): ProviderId[] {
    return [...PROVIDERS];
  }

  private persist(): void {
    writeFileSync(this.configPath, `${JSON.stringify(this.storedConfig, null, 2)}\n`, 'utf8');
  }
}
