import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROVIDERS, type ProviderId } from '@agent-console/shared';
import { appConfigSchema, type AppConfig, type ProjectConfig, type ProviderSettings } from './schema.js';
import { expandHome, normalizeFsPath } from '../lib/path-utils.js';

export interface MergedProviderSettings extends Omit<ProviderSettings, 'discoveryRoot'> {
  id: ProviderId;
  discoveryRoot: string;
}

export class ConfigService {
  private readonly configPath: string;
  private readonly config: AppConfig;

  constructor(configPath?: string) {
    this.configPath = normalizeFsPath(configPath ?? process.env.AGENT_CONSOLE_CONFIG ?? '~/.config/agent-console/config.json');
    const raw = JSON.parse(readFileSync(this.configPath, 'utf8'));
    this.config = appConfigSchema.parse(raw);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getConfig(): AppConfig {
    return {
      ...this.config,
      projectsRoot: normalizeFsPath(this.config.projectsRoot),
      runtimeDir: normalizeFsPath(this.config.runtimeDir),
      databasePath: normalizeFsPath(this.config.databasePath),
      server: {
        ...this.config.server,
        webDistPath: path.resolve(path.dirname(this.configPath), this.config.server.webDistPath),
      },
      providers: {
        codex: {
          ...this.config.providers.codex,
          discoveryRoot: normalizeFsPath(this.config.providers.codex.discoveryRoot ?? '~/.codex'),
          commands: {
            ...this.config.providers.codex.commands,
            env: Object.fromEntries(Object.entries(this.config.providers.codex.commands.env).map(([key, value]) => [key, expandHome(value)])),
          },
        },
        claude: {
          ...this.config.providers.claude,
          discoveryRoot: normalizeFsPath(this.config.providers.claude.discoveryRoot ?? '~/.claude'),
          commands: {
            ...this.config.providers.claude.commands,
            env: Object.fromEntries(Object.entries(this.config.providers.claude.commands.env).map(([key, value]) => [key, expandHome(value)])),
          },
        },
      },
    };
  }

  getProjectsRoot(): string {
    return normalizeFsPath(this.config.projectsRoot);
  }

  getRuntimeDir(): string {
    return normalizeFsPath(this.config.runtimeDir);
  }

  getDatabasePath(): string {
    return normalizeFsPath(this.config.databasePath);
  }

  getProjectConfig(directoryName: string): ProjectConfig | undefined {
    return this.config.projects[directoryName];
  }

  getMergedProviderSettings(directoryName: string, providerId: ProviderId): MergedProviderSettings {
    const globalProvider = this.config.providers[providerId];
    const projectOverride = directoryName === '__global__' ? undefined : this.config.projects[directoryName]?.providers[providerId];
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
    return Object.entries(this.config.projects)
      .filter(([, value]) => value.active)
      .map(([key]) => key);
  }

  getProviderIds(): ProviderId[] {
    return [...PROVIDERS];
  }
}
